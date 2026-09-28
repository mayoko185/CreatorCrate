import crypto from 'node:crypto';
import {
  computeDestinationIdentity,
  MATERIALIZATION_CANDIDATE_LIMIT,
  TIME_CRITICAL_CANDIDATE_LIMIT,
} from './release-notification-service.js';
import { RELEASE_NOTIFICATION_CHANNELS } from './release-notification-settings-service.js';
import { recentResultFromOutcome } from './release-notification-recent-result-service.js';
import { createReleaseNotificationLane, ReleaseNotificationLanePausedError } from './release-notification-lane.js';
import { createSmtpSender, normalizeSmtpConfig, SMTP_DEFAULT_PORTS } from './release-notification-transports/smtp.js';
import { createNtfySender } from './release-notification-transports/ntfy.js';
import { createGotifySender } from './release-notification-transports/gotify.js';
import { createWebhookSender } from './release-notification-transports/webhook.js';
import { createTestNotificationPayload } from './release-notification-transports/shared.js';

/**
 * Claims per channel per scheduler cycle (one claim wave). A channel is only
 * claimed for when its lane is idle, so this also bounds each lane's backlog.
 * Five sends at the transports' worst-case timeouts stay well inside WP1's
 * 5-minute lease. It also bounds the candidate page a wave is claimed from;
 * a full page that claimed or cleared rows may have more due work behind it,
 * so the runtime asks the scheduler for a prompt continuation (after that
 * lane drains) instead of leaving the work until the next minute.
 */
export const CLAIM_LIMIT_PER_CHANNEL = 5;

/**
 * Time-critical pages one cycle may run while each full page reports that
 * unhandled priority work remains. With the WP1 page size this bounds one
 * cycle to TIME_CRITICAL_PAGES_PER_CYCLE x TIME_CRITICAL_CANDIDATE_LIMIT
 * priority materializations; backlog beyond it is reported so the scheduler
 * runs a short-delay continuation instead of waiting a full minute.
 */
export const TIME_CRITICAL_PAGES_PER_CYCLE = 5;

const DEFAULT_SENDER_FACTORIES = Object.freeze({
  email: createSmtpSender,
  ntfy: createNtfySender,
  gotify: createGotifySender,
  webhook: createWebhookSender,
});

/** Returned to Settings when a test cannot be admitted (shutdown or restore underway). */
const PAUSED_TEST_RESULT = Object.freeze({ outcome: 'transient_failure', failureCode: 'unexpected_error' });
const UNEXPECTED_SEND_RESULT = Object.freeze({ outcome: 'transient_failure', failureCode: 'unexpected_error' });

/**
 * Release link for a release id from the configured external base URL, or a
 * builder that always yields null. Request headers are never consulted.
 */
export function createReleaseUrlBuilder(baseUrl) {
  if (typeof baseUrl !== 'string' || baseUrl === '') return () => null;
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return (releaseId) => (Number.isSafeInteger(releaseId) && releaseId > 0
    ? new URL(`releases/${releaseId}`, base).href
    : null);
}

/** The process-local timezone WP1 schedules releases in. */
export function effectiveTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
}

function safeOrigin(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

/** Keep only the normalized outcome fields; provider detail never leaves the runtime. */
function normalizeOutcome(result) {
  const outcome = result?.outcome;
  if (outcome === 'accepted') return { outcome };
  if (outcome === 'transient_failure' || outcome === 'permanent_failure') {
    const normalized = { outcome, failureCode: typeof result.failureCode === 'string' ? result.failureCode : 'unexpected_error' };
    if (outcome === 'transient_failure' && Number.isSafeInteger(result.retryAfterMs) && result.retryAfterMs > 0) {
      normalized.retryAfterMs = result.retryAfterMs;
    }
    return normalized;
  }
  return { ...UNEXPECTED_SEND_RESULT };
}

/**
 * Process-wide release-notification runtime: turns deployment transport
 * configuration into WP2 senders, sanitized Settings status, and WP1
 * destination identities; owns the four fixed per-channel lanes; runs
 * scheduled delivery cycles and Send Test through those lanes; and takes part
 * in shutdown and live-restore pauses.
 *
 * Database-bound collaborators (the WP1 core and the recent-result service)
 * are never cached: `getServices()` resolves them from the currently active
 * application graph at the start of each unit of work, and restore drains
 * every started unit before that graph is replaced.
 */
export function createReleaseNotificationRuntime({
  transportConfig = {},
  getServices,
  applicationLogger = null,
  now = () => new Date(),
  generateId = crypto.randomUUID,
  senderFactories = DEFAULT_SENDER_FACTORIES,
  claimLimitPerChannel = CLAIM_LIMIT_PER_CHANNEL,
  materializationLimit = MATERIALIZATION_CANDIDATE_LIMIT,
  timeCriticalLimit = TIME_CRITICAL_CANDIDATE_LIMIT,
  timeCriticalPagesPerCycle = TIME_CRITICAL_PAGES_PER_CYCLE,
} = {}) {
  if (typeof getServices !== 'function') {
    throw new Error('createReleaseNotificationRuntime requires a getServices dependency.');
  }
  if (!Number.isSafeInteger(timeCriticalPagesPerCycle) || timeCriticalPagesPerCycle < 1) {
    throw new Error('Release notification time-critical page budget must be a positive safe integer.');
  }
  const config = {
    smtp: transportConfig?.smtp ?? {},
    ntfy: transportConfig?.ntfy ?? {},
    gotify: transportConfig?.gotify ?? {},
    webhook: transportConfig?.webhook ?? {},
  };
  const lanes = Object.fromEntries(RELEASE_NOTIFICATION_CHANNELS.map((channel) => [
    channel, createReleaseNotificationLane(),
  ]));
  // Endpoint/token senders depend on deployment configuration only.
  const fixedSenders = {
    ntfy: senderFactories.ntfy({ server: config.ntfy.server, topic: config.ntfy.topic, token: config.ntfy.token }),
    gotify: senderFactories.gotify({ server: config.gotify.server, token: config.gotify.token }),
    webhook: senderFactories.webhook({ url: config.webhook.url, token: config.webhook.token }),
  };
  // The SMTP recipient is a stored preference, so the email sender is derived
  // from the current recipient and rebuilt only when that recipient changes.
  let emailSender = null;
  let emailSenderRecipient;
  let pauseCount = 0;
  let stopped = false;
  // Process-local continuation of the bounded materialization sweep: the last
  // release id inspected, or 0 to start (again) from the first release. It is
  // only a position, so a restart or restore that resets or outdates it merely
  // restarts or shortens one sweep. It advances only after its batch was
  // fully processed, so a failed cycle retries the same batch. Short-lived
  // phases never wait for it: each cycle first runs the time-critical pass.
  let materializationCursor = 0;

  function smtpConfigFor(recipient) {
    return { ...config.smtp, to: recipient ?? null };
  }

  function senderFor(channel, settings) {
    if (channel !== 'email') return fixedSenders[channel];
    const recipient = settings?.emailRecipient ?? null;
    if (!emailSender || emailSenderRecipient !== recipient) {
      emailSender = senderFactories.email(smtpConfigFor(recipient));
      emailSenderRecipient = recipient;
    }
    return emailSender;
  }

  function readiness(channel, settings) {
    try {
      return senderFor(channel, settings).getReadiness();
    } catch {
      return { ready: false, reason: 'not_configured', authConfigured: false };
    }
  }

  function destinationInput(channel, settings) {
    switch (channel) {
      case 'email': {
        // WP2's normalization supplies the effective port (465/587 defaults),
        // exactly what the sender itself will connect to.
        const normalized = normalizeSmtpConfig(smtpConfigFor(settings?.emailRecipient));
        return normalized.reason ? null : {
          host: normalized.host, port: normalized.port, from: normalized.from, to: normalized.to,
        };
      }
      case 'ntfy': return { server: config.ntfy.server, topic: config.ntfy.topic };
      case 'gotify': return { server: config.gotify.server, token: config.gotify.token };
      case 'webhook': return { url: config.webhook.url };
      default: return null;
    }
  }

  /**
   * channel -> opaque WP1 identity for every channel whose configuration is
   * ready now. Unready channels are absent, which WP1 treats as a temporary
   * pause of an established destination rather than a change.
   */
  function resolveDestinations(settings) {
    const destinations = {};
    for (const channel of RELEASE_NOTIFICATION_CHANNELS) {
      if (!readiness(channel, settings).ready) continue;
      const input = destinationInput(channel, settings);
      if (!input) continue;
      try {
        destinations[channel] = computeDestinationIdentity(channel, input);
      } catch {
        // Readiness and identity disagree only on malformed input; treat as unready.
      }
    }
    return destinations;
  }

  function summaryFor(channel) {
    switch (channel) {
      case 'email': {
        const { smtp } = config;
        const port = smtp.port ?? SMTP_DEFAULT_PORTS[smtp.security] ?? null;
        return {
          host: smtp.host ?? null,
          port: Number.isSafeInteger(port) ? port : null,
          security: smtp.security ?? null,
          sender: smtp.from ?? null,
          credentialsConfigured: Boolean(smtp.username && smtp.password),
        };
      }
      case 'ntfy':
        return {
          origin: safeOrigin(config.ntfy.server),
          topicConfigured: Boolean(config.ntfy.topic),
          tokenConfigured: Boolean(config.ntfy.token),
        };
      case 'gotify':
        return { origin: safeOrigin(config.gotify.server), tokenConfigured: Boolean(config.gotify.token) };
      case 'webhook':
        return {
          origin: safeOrigin(config.webhook.url),
          endpointConfigured: Boolean(config.webhook.url),
          tokenConfigured: Boolean(config.webhook.token),
        };
      default:
        return {};
    }
  }

  function isAdmitting() {
    return !stopped && pauseCount === 0;
  }

  function log(level, event, message, context = {}) {
    try {
      applicationLogger?.[level]?.({
        kind: 'diagnostic', subsystem: 'release_notifications', event, message, context,
      });
    } catch {
      // Diagnostics never alter delivery behavior.
    }
  }

  function readServices() {
    const services = getServices();
    const core = services?.releaseNotificationService;
    if (!core || typeof core.getSettings !== 'function') return null;
    return { core, recentResults: services.recentResultService ?? null };
  }

  function recordRecentResult(recentResults, channel, entry) {
    try {
      recentResults?.recordResult(channel, entry);
    } catch {
      log('warn', 'release_notifications.recent_result.failed', 'Recording a release notification result failed.', { channel });
    }
  }

  /**
   * One claimed delivery on its channel lane: final WP1 revalidation, then
   * the WP2 send, then WP1 completion and the channel's recent result. There
   * is no path to the sender that skips a successful revalidateClaim.
   * Resolves to 'relinquished' when the claim was given back unsent because
   * its established destination was unavailable or its lease had expired.
   */
  async function deliverClaim(claim) {
    const services = readServices();
    if (!services) return;
    const { core, recentResults } = services;
    const settings = core.getSettings();
    const destinations = resolveDestinations(settings);
    const check = core.revalidateClaim({ deliveryId: claim.deliveryId, claimToken: claim.claimToken, destinations });
    if (!check.valid) {
      // Nothing was sent: either the established destination is only
      // temporarily unready, or the lease expired before final authorization.
      // Give the claim back instead of spending an attempt, so the retry
      // budget counts only real sends. The relinquish is token guarded, so a
      // newer claim taken after expiry is left untouched. (A lease that
      // expires after this point, with the send under way, stays a real
      // attempt; so does an abandoned claim recovered by the claim path.)
      if (check.code === 'destination_unavailable' || check.code === 'claim_expired') {
        core.relinquishClaim({ deliveryId: claim.deliveryId, claimToken: claim.claimToken });
        return 'relinquished';
      }
      return;
    }

    let result;
    try {
      result = normalizeOutcome(await senderFor(claim.channel, settings).send(claim.payload, { deliveryId: claim.deliveryId }));
    } catch {
      result = { ...UNEXPECTED_SEND_RESULT };
    }
    const completion = core.completeDelivery({
      deliveryId: claim.deliveryId,
      claimToken: claim.claimToken,
      outcome: result.outcome,
      failureCode: result.failureCode ?? null,
      retryAfterMs: result.retryAfterMs ?? null,
    });
    // The retry instant shown in Settings is WP1's persisted next attempt,
    // never the transport's raw Retry-After hint.
    const delivery = completion?.applied ? completion.delivery : null;
    recordRecentResult(recentResults, claim.channel, recentResultFromOutcome(result, {
      kind: 'release',
      at: now().toISOString(),
      nextRetryAt: delivery?.state === 'pending' ? delivery.next_attempt_at : null,
    }));
  }

  /**
   * Establish the current destination identities with WP1 so stale unsent
   * work for a changed destination is cancelled before delivery begins.
   * Unready channels are omitted, preserving WP1's pause semantics.
   */
  function reconcile() {
    try {
      const services = readServices();
      if (!services) return null;
      return services.core.reconcileDestinations({ destinations: resolveDestinations(services.core.getSettings()) });
    } catch (error) {
      log('error', 'release_notifications.reconcile.failed', 'Release notification destination reconciliation failed.', {
        errorName: error?.name ?? 'Error',
      });
      return null;
    }
  }

  /**
   * Runs synchronously when a paused lane drops a claim before it started, so
   * the claim is returned to the same database graph it was taken from before
   * the pause's drain completes.
   */
  function relinquishDropped(claim) {
    try {
      readServices()?.core.relinquishClaim({ deliveryId: claim.deliveryId, claimToken: claim.claimToken });
    } catch (error) {
      // The lease still bounds recovery if the claim cannot be returned now.
      log('warn', 'release_notifications.relinquish.failed', 'Returning an unsent release notification claim failed.', {
        channel: claim.channel, errorName: error?.name ?? 'Error',
      });
    }
  }

  function enqueueClaim(claim, wave) {
    const task = async () => {
      if (await deliverClaim(claim) === 'relinquished') wave.relinquished += 1;
    };
    lanes[claim.channel].run(task, { onDrop: () => relinquishDropped(claim) }).catch((error) => {
      // Dropped unstarted work was already relinquished by its onDrop hook.
      if (error instanceof ReleaseNotificationLanePausedError) return;
      log('error', 'release_notifications.delivery.failed', 'A release notification delivery failed unexpectedly.', {
        channel: claim.channel, errorName: error?.name ?? 'Error',
      });
    });
  }

  /**
   * After a claim wave from a full candidate page, wait for that channel's
   * lane to drain (its queued claims run normally first), then request one
   * scheduler continuation so the next bounded wave is claimed promptly. No
   * request is made while admission is paused or stopped (the normal cadence
   * rediscovers the due rows afterwards), nor when every claim in the wave
   * was given back unsent and the page cleared no stale rows: that wave made
   * no progress, so reclaiming it at once could only spin.
   */
  function continueAfterFullWave(channel, wave, requestContinuation) {
    lanes[channel].waitForIdle().then(() => {
      if (!isAdmitting() || (wave.relinquished >= wave.size && wave.cleared === 0)) return;
      try {
        requestContinuation();
      } catch {
        // The normal cadence still claims the rest.
      }
    });
  }

  return {
    lanes,

    getEffectiveTimeZone: effectiveTimeZone,

    /** Sanitized per-channel status; configuration only, no network I/O. */
    getChannelStatus({ emailRecipient = null } = {}) {
      const settings = { emailRecipient };
      return Object.fromEntries(RELEASE_NOTIFICATION_CHANNELS.map((channel) => [channel, {
        readiness: readiness(channel, settings),
        summary: summaryFor(channel),
      }]));
    },

    resolveDestinations,

    isAdmitting,

    /**
     * Send a fresh, unpersisted test notification through the channel's
     * normal lane. No WP1 occurrence or delivery is created; the Settings
     * route records the returned sanitized outcome itself.
     */
    async sendTest(channel) {
      if (!RELEASE_NOTIFICATION_CHANNELS.includes(channel)) {
        throw new TypeError('Unknown release notification channel.');
      }
      if (!isAdmitting()) return { ...PAUSED_TEST_RESULT };
      const services = readServices();
      if (!services) return { ...PAUSED_TEST_RESULT };
      const sender = senderFor(channel, services.core.getSettings());
      if (!sender.getReadiness().ready) return { outcome: 'permanent_failure', failureCode: 'invalid_configuration' };
      const deliveryId = generateId();
      const payload = createTestNotificationPayload({ eventId: generateId(), createdAt: now().toISOString() });
      try {
        const result = await lanes[channel].run(() => sender.send(payload, { deliveryId }));
        const normalized = normalizeOutcome(result);
        return normalized.outcome === 'accepted'
          ? { outcome: 'accepted' }
          : { outcome: normalized.outcome, failureCode: normalized.failureCode };
      } catch (error) {
        if (error instanceof ReleaseNotificationLanePausedError) return { ...PAUSED_TEST_RESULT };
        return { ...UNEXPECTED_SEND_RESULT };
      }
    },

    reconcile,

    /** Prompt stale-work cancellation after a release/project mutation. Never throws. */
    invalidateStale(releaseNotificationService, releaseId = null) {
      try {
        const destinations = resolveDestinations(releaseNotificationService.getSettings());
        return releaseNotificationService.invalidateStaleDeliveries({ destinations, releaseId });
      } catch (error) {
        log('warn', 'release_notifications.invalidate.failed', 'Release notification stale-work invalidation failed.', {
          errorName: error?.name ?? 'Error',
        });
        return null;
      }
    },

    /**
     * One scheduled cycle, synchronous up to lane admission: materialize due
     * occurrences for the bounded time-critical pass (releases whose current
     * phase can be superseded soon), repeating it while a full page reports
     * more unhandled priority work, up to timeCriticalPagesPerCycle pages;
     * then the next bounded background batch of releases (continuing the
     * sweep from the previous cycle) for every ready or established
     * destination; then claim a bounded batch only for channels whose lane is
     * idle, and queue each claim on its own channel lane. Sends run after
     * this returns.
     *
     * `priorityBacklog` reports that the page budget ran out with priority
     * work remaining. A `continuation` cycle (the scheduler's prompt
     * follow-up to such a backlog, or to a drained full claim wave) skips the
     * background batch, which is never time-critical, so the sweep keeps its
     * once-per-cycle pace.
     *
     * `requestContinuation` (supplied by the scheduler) is called once per
     * full candidate page that claimed or cleared rows: after that channel's
     * lane has drained its claims, or at once when the page only cleared
     * stale rows. An underfull page, or a full one that made no progress,
     * requests nothing.
     */
    runCycle({ continuation = false, requestContinuation = null } = {}) {
      if (!isAdmitting()) return { skipped: true, reason: 'paused' };
      const services = readServices();
      if (!services) return { skipped: true, reason: 'unavailable' };
      const { core } = services;
      const settings = core.getSettings();
      if (!settings.enabled) return { skipped: true, reason: 'disabled' };
      const destinations = resolveDestinations(settings);
      let materialized = 0;
      let priorityBacklog = false;
      for (let page = 0; page < timeCriticalPagesPerCycle; page += 1) {
        const pass = core.materializeTimeCriticalOccurrences({ destinations, limit: timeCriticalLimit });
        materialized += pass.results.length;
        priorityBacklog = pass.hasMore === true;
        if (!priorityBacklog) break;
      }
      if (!continuation) {
        const batch = core.materializeDueOccurrenceBatch({
          destinations, afterReleaseId: materializationCursor, limit: materializationLimit,
        });
        materializationCursor = batch.nextAfterReleaseId;
        materialized += batch.results.length;
      }
      let claimed = 0;
      for (const [channel, identity] of Object.entries(destinations)) {
        if (!lanes[channel].isIdle()) continue;
        const page = core.claimDueDeliveryPage({ destinations: { [channel]: identity }, limit: claimLimitPerChannel });
        const { claims } = page;
        const wave = { size: claims.length, relinquished: 0, cleared: page.cleared };
        for (const claim of claims) enqueueClaim(claim, wave);
        claimed += claims.length;
        // A full candidate page only signals that more may remain, and only
        // one that claimed or cleared rows can expose different rows next.
        if (!page.hasMore || !page.madeProgress || typeof requestContinuation !== 'function') continue;
        if (claims.length > 0) {
          continueAfterFullWave(channel, wave, requestContinuation);
        } else {
          // Only stale rows were cleared: no lane work to wait for, and the
          // scheduler defers this request until the cycle settles.
          requestContinuation();
        }
      }
      return { skipped: false, materialized, claimed, priorityBacklog };
    },

    /**
     * Close admission for scheduled cycles, Send Test, and lane work; drop
     * unstarted lane tasks. The returned handle waits for started work and
     * reopens admission (after reconciling against the then-current graph).
     */
    pauseForMaintenance() {
      pauseCount += 1;
      for (const lane of Object.values(lanes)) lane.pause();
      let released = false;
      return {
        waitForIdle: () => Promise.all(Object.values(lanes).map((lane) => lane.waitForIdle())).then(() => undefined),
        release: () => {
          if (released) return;
          released = true;
          pauseCount -= 1;
          if (!isAdmitting()) return;
          for (const lane of Object.values(lanes)) lane.resume();
          reconcile();
        },
      };
    },

    /** Permanent stop for shutdown; started sends are left to drain. */
    stop() {
      stopped = true;
      for (const lane of Object.values(lanes)) lane.pause();
    },

    waitForIdle() {
      return Promise.all(Object.values(lanes).map((lane) => lane.waitForIdle())).then(() => undefined);
    },
  };
}
