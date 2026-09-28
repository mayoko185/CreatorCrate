import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { createConfig } from '../src/config.js';
import { createAppMetaRepository } from '../src/data/app-meta-repository.js';
import { defaultReleaseNotificationPreferences } from '../src/services/release-notification-settings-service.js';
import {
  computeDestinationIdentity,
  createReleaseNotificationService,
} from '../src/services/release-notification-service.js';
import { createReleaseNotificationRecentResultService } from '../src/services/release-notification-recent-result-service.js';
import {
  CLAIM_LIMIT_PER_CHANNEL,
  createReleaseNotificationRuntime,
  createReleaseUrlBuilder,
  effectiveTimeZone,
  TIME_CRITICAL_PAGES_PER_CYCLE,
} from '../src/services/release-notification-runtime.js';
import {
  createReleaseNotificationScheduler,
  RELEASE_NOTIFICATION_CONTINUATION_DELAY_MS,
} from '../src/services/release-notification-scheduler.js';
import { createReleaseNotificationLane, ReleaseNotificationLanePausedError } from '../src/services/release-notification-lane.js';
import { createSmtpSender } from '../src/services/release-notification-transports/smtp.js';
import { createNtfySender } from '../src/services/release-notification-transports/ntfy.js';
import { createGotifySender } from '../src/services/release-notification-transports/gotify.js';
import { createWebhookSender } from '../src/services/release-notification-transports/webhook.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const CHANNELS = ['email', 'ntfy', 'gotify', 'webhook'];
const MINUTE = 60 * 1000;

const SECRETS = {
  smtpPassword: 'smtp-pass-7f3a91',
  smtpUsername: 'smtp-user-4410',
  ntfyToken: 'tk_ntfytoken0192',
  ntfyTopic: 'privatetopic8812',
  gotifyToken: 'AgotifyApp.9921',
  webhookPath: '/hooks/in/secretpath-5521',
  webhookQuery: 'sig=querysecret-6630',
  webhookToken: 'bearer-webhook-3381',
};

const FULL_ENV = {
  RELEASE_NOTIFICATIONS_SMTP_HOST: 'smtp.example.test',
  RELEASE_NOTIFICATIONS_SMTP_SECURITY: 'starttls',
  RELEASE_NOTIFICATIONS_SMTP_USERNAME: SECRETS.smtpUsername,
  RELEASE_NOTIFICATIONS_SMTP_PASSWORD: SECRETS.smtpPassword,
  RELEASE_NOTIFICATIONS_SMTP_FROM: 'cc@example.test',
  RELEASE_NOTIFICATIONS_NTFY_URL: 'https://ntfy.example.test',
  RELEASE_NOTIFICATIONS_NTFY_TOPIC: SECRETS.ntfyTopic,
  RELEASE_NOTIFICATIONS_NTFY_TOKEN: SECRETS.ntfyToken,
  RELEASE_NOTIFICATIONS_GOTIFY_URL: 'https://gotify.example.test',
  RELEASE_NOTIFICATIONS_GOTIFY_TOKEN: SECRETS.gotifyToken,
  RELEASE_NOTIFICATIONS_WEBHOOK_URL: `https://hooks.example.test${SECRETS.webhookPath}?${SECRETS.webhookQuery}`,
  RELEASE_NOTIFICATIONS_WEBHOOK_TOKEN: SECRETS.webhookToken,
};

const REAL_FACTORIES = {
  email: createSmtpSender, ntfy: createNtfySender, gotify: createGotifySender, webhook: createWebhookSender,
};

const local = (month, day, hours = 0, minutes = 0) => new Date(2026, month - 1, day, hours, minutes);

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

async function flush(times = 10) {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function transportConfig(env = FULL_ENV) {
  return createConfig(env).releaseNotifications;
}

/**
 * Real WP2 readiness with a controllable send: every send is recorded and
 * returns a promise the test settles, so no real network or sleeps are used.
 */
function createFakeTransports({ autoResult = null } = {}) {
  const sends = [];
  // Channels whose readiness the test has temporarily withdrawn.
  const unready = new Set();
  const configs = { email: [], ntfy: [], gotify: [], webhook: [] };
  const factories = Object.fromEntries(CHANNELS.map((channel) => [channel, (config) => {
    configs[channel].push(config);
    const real = REAL_FACTORIES[channel](config);
    return {
      channel,
      getReadiness: () => (unready.has(channel) ? { ready: false, reason: 'missing_server', authConfigured: false } : real.getReadiness()),
      send(payload, context) {
        const pending = deferred();
        sends.push({ channel, payload, context, resolve: pending.resolve });
        // A function autoResult returning undefined leaves that send for the test to settle.
        const result = typeof autoResult === 'function' ? autoResult(channel, payload) : autoResult;
        if (result) pending.resolve(result);
        return pending.promise;
      },
    };
  }]));
  return {
    factories,
    configs,
    sends,
    unready,
    sendsFor: (channel) => sends.filter((send) => send.channel === channel),
  };
}

describe('release notification configuration', () => {
  it('parses an environment with no notification variables without failing', () => {
    const config = createConfig({});
    expect(config.releaseNotifications).toEqual({
      baseUrl: null,
      baseUrlInvalid: false,
      smtp: { host: null, port: null, security: 'starttls', username: null, password: null, from: null },
      ntfy: { server: null, topic: null, token: null },
      gotify: { server: null, token: null },
      webhook: { url: null, token: null },
    });
  });

  it('parses SMTP values, keeping a malformed port as a not-ready value instead of failing startup', () => {
    expect(createConfig({ RELEASE_NOTIFICATIONS_SMTP_PORT: '2525' }).releaseNotifications.smtp.port).toBe(2525);
    expect(createConfig({ RELEASE_NOTIFICATIONS_SMTP_PORT: 'abc' }).releaseNotifications.smtp.port).toBeNaN();
    expect(createConfig({ RELEASE_NOTIFICATIONS_SMTP_SECURITY: ' TLS ' }).releaseNotifications.smtp.security).toBe('tls');
    // Passwords are not trimmed.
    expect(createConfig({ RELEASE_NOTIFICATIONS_SMTP_PASSWORD: ' p w ' }).releaseNotifications.smtp.password).toBe(' p w ');
  });

  it('accepts an http(s) base URL (path prefixes kept) and rejects unsafe forms without echoing them', () => {
    expect(createConfig({ RELEASE_NOTIFICATIONS_BASE_URL: 'https://cc.example.test/app/' }).releaseNotifications)
      .toMatchObject({ baseUrl: 'https://cc.example.test/app', baseUrlInvalid: false });
    for (const value of [
      'ftp://cc.example.test', 'https://user:pw@cc.example.test', 'https://cc.example.test/?token=x',
      'https://cc.example.test/#x', 'not a url',
    ]) {
      expect(createConfig({ RELEASE_NOTIFICATIONS_BASE_URL: value }).releaseNotifications)
        .toMatchObject({ baseUrl: null, baseUrlInvalid: true });
    }
  });

  it('builds release links only from the configured base URL', () => {
    expect(createReleaseUrlBuilder('https://cc.example.test/app')(42)).toBe('https://cc.example.test/app/releases/42');
    expect(createReleaseUrlBuilder('https://cc.example.test')(7)).toBe('https://cc.example.test/releases/7');
    expect(createReleaseUrlBuilder(null)(7)).toBeNull();
  });
});

describe('release notification runtime', () => {
  let db;
  let clock;
  let core;
  let recentResults;
  let transports;
  let runtime;
  let ids;

  function buildRuntime({ env = FULL_ENV, autoResult = null, services = null } = {}) {
    transports = createFakeTransports({ autoResult });
    ids = 0;
    runtime = createReleaseNotificationRuntime({
      transportConfig: transportConfig(env),
      getServices: () => services ?? { releaseNotificationService: core, recentResultService: recentResults },
      now: () => new Date(clock),
      generateId: () => `generated-${++ids}`,
      senderFactories: transports.factories,
    });
    return runtime;
  }

  function createProject(title = 'Project') {
    return Number(db.prepare(`
      INSERT INTO projects (title, slug, description, notes, status, project_type, patreon_url)
      VALUES (?, lower(?) || '-' || abs(random()), '', '', 'tbd', 'images', NULL)
    `).run(title, title).lastInsertRowid);
  }

  function createRelease({ plannedDate = '2026-06-10', plannedTime = '14:00' } = {}) {
    return Number(db.prepare(`
      INSERT INTO releases (project_id, title, notes, planned_date, planned_time) VALUES (?, 'Release', '', ?, ?)
    `).run(createProject(), plannedDate, plannedTime).lastInsertRowid);
  }

  function enable(channels = CHANNELS, overrides = {}) {
    core.updateSettings({
      ...defaultReleaseNotificationPreferences(),
      enabled: true,
      enabledChannels: channels,
      emailRecipient: 'me@example.test',
      ...overrides,
    });
  }

  function deliveryRows() {
    return db.prepare('SELECT * FROM release_notification_deliveries ORDER BY channel').all();
  }

  function deliveryFor(channel) {
    return deliveryRows().find((row) => row.channel === channel);
  }

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    clock = local(6, 1, 8);
    core = createReleaseNotificationService({ db, now: () => new Date(clock) });
    recentResults = createReleaseNotificationRecentResultService({ appMetaRepository: createAppMetaRepository(db) });
  });

  afterEach(() => {
    closeDatabase(db);
  });

  describe('channel status and destinations', () => {
    it('reports readiness and sanitized summaries without any secret', () => {
      buildRuntime();
      const status = runtime.getChannelStatus({ emailRecipient: 'me@example.test' });

      expect(status.email).toEqual({
        readiness: { ready: true, reason: null, authConfigured: true },
        summary: {
          host: 'smtp.example.test', port: 587, security: 'starttls', sender: 'cc@example.test', credentialsConfigured: true,
        },
      });
      expect(status.ntfy.summary).toEqual({ origin: 'https://ntfy.example.test', topicConfigured: true, tokenConfigured: true });
      expect(status.gotify.summary).toEqual({ origin: 'https://gotify.example.test', tokenConfigured: true });
      expect(status.webhook.summary).toEqual({ origin: 'https://hooks.example.test', endpointConfigured: true, tokenConfigured: true });
      for (const channel of CHANNELS) expect(status[channel].readiness.ready).toBe(true);

      const serialized = JSON.stringify(status);
      for (const secret of Object.values(SECRETS)) expect(serialized).not.toContain(secret);
    });

    it('reports email as not ready until a recipient is chosen', () => {
      buildRuntime();
      expect(runtime.getChannelStatus({ emailRecipient: null }).email.readiness)
        .toEqual({ ready: false, reason: 'missing_recipient', authConfigured: true });
    });

    it('reports every channel not ready when nothing is configured', () => {
      buildRuntime({ env: {} });
      const status = runtime.getChannelStatus({ emailRecipient: 'me@example.test' });
      expect(Object.fromEntries(CHANNELS.map((channel) => [channel, status[channel].readiness.reason]))).toEqual({
        email: 'missing_host', ntfy: 'missing_server', gotify: 'missing_server', webhook: 'missing_endpoint',
      });
      expect(runtime.resolveDestinations({ emailRecipient: 'me@example.test' })).toEqual({});
    });

    it('turns malformed values into not-ready channels without leaking them', () => {
      buildRuntime({
        env: {
          ...FULL_ENV,
          RELEASE_NOTIFICATIONS_SMTP_PORT: 'not-a-port',
          RELEASE_NOTIFICATIONS_NTFY_URL: `ftp://${SECRETS.ntfyToken}.example.test`,
          RELEASE_NOTIFICATIONS_WEBHOOK_URL: `https://u:${SECRETS.webhookToken}@hooks.example.test${SECRETS.webhookPath}`,
        },
      });
      const status = runtime.getChannelStatus({ emailRecipient: 'me@example.test' });
      expect(status.email.readiness.reason).toBe('invalid_port');
      expect(status.email.summary.port).toBeNull();
      expect(status.ntfy.readiness.reason).toBe('invalid_server_url');
      expect(status.webhook.readiness.reason).toBe('invalid_endpoint_url');
      const serialized = JSON.stringify(status);
      for (const secret of Object.values(SECRETS)) expect(serialized).not.toContain(secret);
    });

    it('uses the WP2 normalized SMTP port (TLS default 465) for the email destination identity', () => {
      buildRuntime({ env: { ...FULL_ENV, RELEASE_NOTIFICATIONS_SMTP_SECURITY: 'tls' } });
      const settings = { emailRecipient: 'me@example.test' };
      expect(runtime.getChannelStatus(settings).email.summary.port).toBe(465);
      expect(runtime.resolveDestinations(settings).email).toBe(computeDestinationIdentity('email', {
        host: 'smtp.example.test', port: 465, from: 'cc@example.test', to: 'me@example.test',
      }));
    });

    it('keeps ntfy identity across token rotation but changes it for a new Gotify token', () => {
      const settings = { emailRecipient: 'me@example.test' };
      const before = buildRuntime().resolveDestinations(settings);
      const after = buildRuntime({
        env: { ...FULL_ENV, RELEASE_NOTIFICATIONS_NTFY_TOKEN: 'tk_rotated', RELEASE_NOTIFICATIONS_GOTIFY_TOKEN: 'Anew.token' },
      }).resolveDestinations(settings);
      expect(after.ntfy).toBe(before.ntfy);
      expect(after.gotify).not.toBe(before.gotify);
      expect(after.webhook).toBe(before.webhook);
      expect(after.email).toBe(before.email);
    });

    it('rebuilds the SMTP sender with the current recipient preference', () => {
      buildRuntime();
      runtime.getChannelStatus({ emailRecipient: 'a@example.test' });
      runtime.getChannelStatus({ emailRecipient: 'a@example.test' });
      runtime.getChannelStatus({ emailRecipient: 'b@example.test' });
      expect(transports.configs.email.map((config) => config.to)).toEqual(['a@example.test', 'b@example.test']);
    });

    it('reports the process-local timezone WP1 schedules in', () => {
      buildRuntime();
      expect(runtime.getEffectiveTimeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
      expect(runtime.getEffectiveTimeZone()).toBe(effectiveTimeZone());
    });
  });

  describe('startup reconciliation', () => {
    it('cancels unsent work for a changed destination but keeps it across credential rotation', () => {
      buildRuntime();
      enable(['ntfy', 'gotify']);
      createRelease();
      clock = local(6, 10, 14);
      core.materializeDueOccurrences({ destinations: runtime.resolveDestinations(core.getSettings()) });
      expect(deliveryRows().map((row) => row.state)).toEqual(['pending', 'pending']);

      // New process: ntfy token rotated (same destination), Gotify app token changed.
      buildRuntime({
        env: { ...FULL_ENV, RELEASE_NOTIFICATIONS_NTFY_TOKEN: 'tk_rotated', RELEASE_NOTIFICATIONS_GOTIFY_TOKEN: 'Anew.token' },
      });
      runtime.reconcile();
      expect(deliveryFor('ntfy').state).toBe('pending');
      expect(deliveryFor('gotify')).toMatchObject({ state: 'cancelled', failure_code: 'destination_changed' });
    });

    it('leaves established work paused, not cancelled, when a channel is temporarily unconfigured', () => {
      buildRuntime();
      enable(['ntfy']);
      createRelease();
      clock = local(6, 10, 14);
      core.materializeDueOccurrences({ destinations: runtime.resolveDestinations(core.getSettings()) });

      buildRuntime({ env: { ...FULL_ENV, RELEASE_NOTIFICATIONS_NTFY_URL: '' } });
      runtime.reconcile();
      runtime.runCycle();
      expect(deliveryFor('ntfy').state).toBe('pending');
      expect(core.getSettings().enabledChannels).toEqual(['ntfy']);
      expect(transports.sends).toHaveLength(0);
    });
  });

  describe('lanes', () => {
    it('serializes work within a lane', async () => {
      const lane = createReleaseNotificationLane();
      const first = deferred();
      const started = [];
      const one = lane.run(() => { started.push(1); return first.promise; });
      const two = lane.run(() => { started.push(2); return 'two'; });
      await flush();
      expect(started).toEqual([1]);
      first.resolve('one');
      await expect(one).resolves.toBe('one');
      await expect(two).resolves.toBe('two');
      expect(started).toEqual([1, 2]);
    });

    it('pausing rejects new and unstarted work while waitForIdle waits for the running task', async () => {
      const lane = createReleaseNotificationLane();
      const first = deferred();
      const running = lane.run(() => first.promise);
      await flush();
      const queued = lane.run(() => 'never');
      lane.pause();
      await expect(queued).rejects.toBeInstanceOf(ReleaseNotificationLanePausedError);
      await expect(lane.run(() => 'late')).rejects.toBeInstanceOf(ReleaseNotificationLanePausedError);

      let idle = false;
      const waiting = lane.waitForIdle().then(() => { idle = true; });
      await flush();
      expect(idle).toBe(false);
      first.resolve('done');
      await waiting;
      await expect(running).resolves.toBe('done');
      lane.resume();
      await expect(lane.run(() => 'again')).resolves.toBe('again');
    });

    it('calls onDrop instead of starting a task that is still queued when the lane pauses', async () => {
      const lane = createReleaseNotificationLane();
      const first = deferred();
      const events = [];
      const running = lane.run(() => first.promise);
      await flush();
      const queued = lane.run(() => { events.push('started'); }, { onDrop: () => events.push('dropped') });
      // The running task finishes, but the queued one has not been handed off yet.
      first.resolve('done');
      lane.pause();
      expect(events).toEqual(['dropped']);
      await expect(queued).rejects.toBeInstanceOf(ReleaseNotificationLanePausedError);
      await expect(running).resolves.toBe('done');
      await lane.waitForIdle();
      expect(events).toEqual(['dropped']);
    });

    it('never drops a task that has already started', async () => {
      const lane = createReleaseNotificationLane();
      const first = deferred();
      const second = deferred();
      const events = [];
      lane.run(() => first.promise);
      const started = lane.run(() => { events.push('started'); return second.promise; }, { onDrop: () => events.push('dropped') });
      await flush();
      first.resolve();
      await flush();
      expect(events).toEqual(['started']);
      lane.pause();
      second.resolve('ran');
      await expect(started).resolves.toBe('ran');
      expect(events).toEqual(['started']);
    });

    it('calls onDrop synchronously for work refused while paused', async () => {
      const lane = createReleaseNotificationLane();
      lane.pause();
      const events = [];
      const refused = lane.run(() => events.push('started'), { onDrop: () => events.push('dropped') });
      expect(events).toEqual(['dropped']);
      await expect(refused).rejects.toBeInstanceOf(ReleaseNotificationLanePausedError);
    });
  });

  describe('Send Test gateway', () => {
    it('sends a fresh test payload through only that channel lane and creates no ledger rows', async () => {
      buildRuntime();
      enable(['ntfy']);
      const pending = runtime.sendTest('webhook');
      await flush();
      expect(transports.sends).toHaveLength(1);
      const [send] = transports.sends;
      expect(send.channel).toBe('webhook');
      expect(send.context).toEqual({ deliveryId: 'generated-1' });
      expect(send.payload).toEqual({
        schemaVersion: 1, eventId: 'generated-2', type: 'notification.test', createdAt: clock.toISOString(),
        dueAt: null, release: null, project: null, schedule: null,
      });
      send.resolve({ outcome: 'accepted' });
      await expect(pending).resolves.toEqual({ outcome: 'accepted' });
      expect(db.prepare('SELECT COUNT(*) AS c FROM release_notification_occurrences').get().c).toBe(0);
      expect(deliveryRows()).toEqual([]);
    });

    it('returns only the normalized outcome fields', async () => {
      buildRuntime({
        autoResult: {
          outcome: 'transient_failure', failureCode: 'rate_limited', retryAfterMs: 9000,
          detail: `provider said ${SECRETS.gotifyToken}`,
        },
      });
      const result = await runtime.sendTest('gotify');
      expect(result).toEqual({ outcome: 'transient_failure', failureCode: 'rate_limited' });
    });

    it('does not call the sender when the channel is not ready', async () => {
      buildRuntime({ env: { ...FULL_ENV, RELEASE_NOTIFICATIONS_GOTIFY_TOKEN: '' } });
      await expect(runtime.sendTest('gotify')).resolves.toEqual({ outcome: 'permanent_failure', failureCode: 'invalid_configuration' });
      // Email readiness uses the stored recipient, which is unset here.
      await expect(runtime.sendTest('email')).resolves.toEqual({ outcome: 'permanent_failure', failureCode: 'invalid_configuration' });
      expect(transports.sends).toHaveLength(0);
    });

    it('rejects unknown channels', async () => {
      buildRuntime();
      await expect(runtime.sendTest('sms')).rejects.toThrow(TypeError);
    });

    it('shares the channel lane with scheduled work', async () => {
      buildRuntime();
      enable(['email']);
      createRelease();
      clock = local(6, 10, 14);
      runtime.runCycle();
      await flush();
      expect(transports.sendsFor('email')).toHaveLength(1);

      const test = runtime.sendTest('email');
      await flush();
      expect(transports.sendsFor('email')).toHaveLength(1);
      transports.sendsFor('email')[0].resolve({ outcome: 'accepted' });
      await flush();
      expect(transports.sendsFor('email')).toHaveLength(2);
      expect(transports.sendsFor('email')[1].payload.type).toBe('notification.test');
      transports.sendsFor('email')[1].resolve({ outcome: 'accepted' });
      await expect(test).resolves.toEqual({ outcome: 'accepted' });
    });

    it('fails safely without dispatch while admission is paused or stopped', async () => {
      buildRuntime();
      const pause = runtime.pauseForMaintenance();
      await expect(runtime.sendTest('ntfy')).resolves.toEqual({ outcome: 'transient_failure', failureCode: 'unexpected_error' });
      pause.release();
      runtime.stop();
      await expect(runtime.sendTest('ntfy')).resolves.toEqual({ outcome: 'transient_failure', failureCode: 'unexpected_error' });
      expect(transports.sends).toHaveLength(0);
    });
  });

  describe('scheduled delivery cycle', () => {
    it('does nothing while notifications are disabled', async () => {
      buildRuntime();
      createRelease();
      clock = local(6, 10, 14);
      expect(runtime.runCycle()).toEqual({ skipped: true, reason: 'disabled' });
      await flush();
      expect(transports.sends).toHaveLength(0);
    });

    it('materializes, claims, revalidates, sends, and completes an accepted delivery', async () => {
      const calls = [];
      const traced = {
        ...core,
        revalidateClaim: (input) => { calls.push('revalidate'); return core.revalidateClaim(input); },
        completeDelivery: (input) => { calls.push(`complete:${input.outcome}`); return core.completeDelivery(input); },
      };
      buildRuntime({ services: { releaseNotificationService: traced, recentResultService: recentResults } });
      enable(['ntfy']);
      const releaseId = createRelease();
      clock = local(6, 10, 14);

      expect(runtime.runCycle()).toEqual({ skipped: false, materialized: 1, claimed: 1, priorityBacklog: false });
      await flush();
      expect(calls).toEqual(['revalidate']);
      const [send] = transports.sendsFor('ntfy');
      expect(send.payload).toMatchObject({ type: 'release.scheduled', release: { id: releaseId } });
      send.resolve({ outcome: 'accepted' });
      await flush();

      expect(calls).toEqual(['revalidate', 'complete:accepted']);
      expect(deliveryFor('ntfy').state).toBe('accepted');
      expect(recentResults.getRecentResults().ntfy).toEqual({
        at: clock.toISOString(), kind: 'release', state: 'accepted', code: null, nextRetryAt: null,
      });
    });

    it('never sends a claim whose lease expired before the lane reached it, and returns its attempt', async () => {
      buildRuntime();
      enable(['ntfy']);
      createRelease();
      clock = local(6, 10, 14);
      expect(runtime.runCycle().claimed).toBe(1);
      clock = new Date(clock.getTime() + 6 * MINUTE); // past WP1's 5-minute lease
      await flush();
      expect(transports.sends).toHaveLength(0);
      // Known unsent: relinquished rather than left for lease recovery.
      expect(deliveryFor('ntfy')).toMatchObject({
        state: 'pending', attempt_count: 0, claim_token: null, claim_expires_at: null,
        last_attempt_at: null, failure_code: null, next_attempt_at: clock.toISOString(),
      });
      expect(recentResults.getRecentResults().ntfy ?? null).toBeNull();
    });

    it('still ends after five real transient provider failures on the 1, 5, 15, 60 minute schedule', async () => {
      buildRuntime({ autoResult: { outcome: 'transient_failure', failureCode: 'provider_unavailable' } });
      enable(['gotify'], { overdue: { enabled: false, graceMinutes: 60 } });
      createRelease();
      clock = local(6, 10, 14);
      const delays = [];
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        expect(runtime.runCycle().claimed).toBe(1);
        await flush();
        const row = deliveryFor('gotify');
        expect(row).toMatchObject({ attempt_count: attempt, last_attempt_at: clock.toISOString() });
        if (attempt < 5) {
          expect(row.state).toBe('pending');
          delays.push((Date.parse(row.next_attempt_at) - clock.getTime()) / MINUTE);
          clock = new Date(row.next_attempt_at);
        }
      }
      expect(delays).toEqual([1, 5, 15, 60]);
      expect(deliveryFor('gotify')).toMatchObject({ state: 'failed', attempt_count: 5, failure_code: 'provider_unavailable' });
      expect(recentResults.getRecentResults().gotify).toMatchObject({ kind: 'release', state: 'failed' });
      expect(transports.sends).toHaveLength(5);
      clock = new Date(clock.getTime() + 24 * 60 * MINUTE);
      expect(runtime.runCycle().claimed).toBe(0);
    });

    it('never sends stale work that final revalidation cancels', async () => {
      buildRuntime();
      enable(['ntfy']);
      const releaseId = createRelease();
      clock = local(6, 10, 14);
      runtime.runCycle();
      db.prepare("UPDATE releases SET published_date = '2026-06-10' WHERE id = ?").run(releaseId);
      await flush();
      expect(transports.sends).toHaveLength(0);
      expect(deliveryFor('ntfy')).toMatchObject({ state: 'cancelled', failure_code: 'release_published' });
    });

    it('schedules a transient failure retry through WP1 and shows WP1\'s persisted retry time', async () => {
      buildRuntime({ autoResult: { outcome: 'transient_failure', failureCode: 'provider_unavailable', retryAfterMs: 1000 } });
      enable(['gotify']);
      createRelease();
      clock = local(6, 10, 14);
      runtime.runCycle();
      await flush();
      const row = deliveryFor('gotify');
      expect(row).toMatchObject({ state: 'pending', attempt_count: 1, failure_code: 'provider_unavailable' });
      // WP1 policy (1 minute) outranks the shorter provider hint.
      expect(row.next_attempt_at).toBe(new Date(clock.getTime() + MINUTE).toISOString());
      expect(recentResults.getRecentResults().gotify).toEqual({
        at: clock.toISOString(), kind: 'release', state: 'retry_scheduled', code: 'provider_unavailable',
        nextRetryAt: row.next_attempt_at,
      });
    });

    it('records a permanent failure as terminal', async () => {
      buildRuntime({ autoResult: { outcome: 'permanent_failure', failureCode: 'rejected' } });
      enable(['webhook']);
      createRelease();
      clock = local(6, 10, 14);
      runtime.runCycle();
      await flush();
      expect(deliveryFor('webhook')).toMatchObject({ state: 'failed', failure_code: 'rejected' });
      expect(recentResults.getRecentResults().webhook).toMatchObject({ kind: 'release', state: 'failed', code: 'rejected' });
    });

    it('retries only the failed channel after a partial success, preserving sibling recent results', async () => {
      buildRuntime({
        autoResult: (channel) => (channel === 'ntfy'
          ? { outcome: 'transient_failure', failureCode: 'provider_unavailable' }
          : { outcome: 'accepted' }),
      });
      recentResults.recordResult('gotify', { at: '2026-05-01T00:00:00.000Z', kind: 'test', state: 'accepted' });
      enable(['email', 'ntfy', 'webhook']);
      createRelease();
      clock = local(6, 10, 14);
      runtime.runCycle();
      await flush();
      expect(Object.fromEntries(deliveryRows().map((row) => [row.channel, row.state])))
        .toEqual({ email: 'accepted', ntfy: 'pending', webhook: 'accepted' });

      clock = new Date(clock.getTime() + 2 * MINUTE);
      runtime.runCycle();
      await flush();
      expect(transports.sends.map((send) => send.channel).sort()).toEqual(['email', 'ntfy', 'ntfy', 'webhook']);
      expect(deliveryFor('ntfy').attempt_count).toBe(2);

      const recent = recentResults.getRecentResults();
      expect(recent.gotify).toMatchObject({ kind: 'test', state: 'accepted' });
      expect(recent.email).toMatchObject({ kind: 'release', state: 'accepted' });
      expect(recent.ntfy).toMatchObject({ kind: 'release', state: 'retry_scheduled' });
    });

    it('lets other channels progress while a slow SMTP send occupies the email lane', async () => {
      buildRuntime();
      enable(['email', 'ntfy']);
      createRelease();
      createRelease({ plannedTime: '14:00' });
      clock = local(6, 10, 14);
      runtime.runCycle();
      await flush();
      expect(transports.sendsFor('email')).toHaveLength(1);
      expect(transports.sendsFor('ntfy')).toHaveLength(1);

      transports.sendsFor('ntfy')[0].resolve({ outcome: 'accepted' });
      await flush();
      expect(transports.sendsFor('ntfy')).toHaveLength(2);
      transports.sendsFor('ntfy')[1].resolve({ outcome: 'accepted' });
      await flush();
      expect(db.prepare("SELECT COUNT(*) AS c FROM release_notification_deliveries WHERE channel = 'ntfy' AND state = 'accepted'").get().c).toBe(2);

      // The busy email lane is not claimed for again, so it never accumulates a backlog.
      clock = new Date(clock.getTime() + MINUTE);
      runtime.runCycle();
      await flush();
      expect(transports.sendsFor('email')).toHaveLength(1);
      transports.sendsFor('email')[0].resolve({ outcome: 'accepted' });
      await flush();
      expect(transports.sendsFor('email')).toHaveLength(2);
    });

    it('claims a bounded batch per channel per cycle', async () => {
      buildRuntime({ autoResult: { outcome: 'accepted' } });
      enable(['ntfy']);
      for (let i = 0; i < CLAIM_LIMIT_PER_CHANNEL + 3; i += 1) createRelease();
      clock = local(6, 10, 14);
      expect(runtime.runCycle()).toMatchObject({ materialized: CLAIM_LIMIT_PER_CHANNEL + 3, claimed: CLAIM_LIMIT_PER_CHANNEL });
      await flush();
      expect(transports.sends).toHaveLength(CLAIM_LIMIT_PER_CHANNEL);
      expect(runtime.runCycle().claimed).toBe(3);
    });

    it('does not claim channels whose configuration is not ready', async () => {
      buildRuntime({ env: { ...FULL_ENV, RELEASE_NOTIFICATIONS_WEBHOOK_URL: '' }, autoResult: { outcome: 'accepted' } });
      enable(['ntfy', 'webhook']);
      createRelease();
      clock = local(6, 10, 14);
      runtime.runCycle();
      await flush();
      expect(transports.sends.map((send) => send.channel)).toEqual(['ntfy']);
    });

    it('reports a sender exception as an unexpected transient failure, not a crash', async () => {
      buildRuntime();
      enable(['ntfy']);
      createRelease();
      clock = local(6, 10, 14);
      runtime.runCycle();
      await flush();
      transports.sendsFor('ntfy')[0].resolve(Promise.reject(new Error(SECRETS.ntfyToken)));
      await flush();
      expect(deliveryFor('ntfy')).toMatchObject({ state: 'pending', failure_code: 'unexpected_error' });
      expect(JSON.stringify(recentResults.getRecentResults())).not.toContain(SECRETS.ntfyToken);
    });
  });

  describe('unsent claim relinquish', () => {
    function traceServices() {
      const calls = [];
      const recorded = [];
      const traced = {
        ...core,
        completeDelivery: (input) => { calls.push(`complete:${input.outcome}`); return core.completeDelivery(input); },
        relinquishClaim: (input) => { calls.push('relinquish'); return core.relinquishClaim(input); },
      };
      const tracedResults = {
        ...recentResults,
        recordResult: (channel, entry) => { recorded.push(channel); return recentResults.recordResult(channel, entry); },
      };
      return { calls, recorded, services: { releaseNotificationService: traced, recentResultService: tracedResults } };
    }

    it('relinquishes queued claims a maintenance pause drops while running sends drain normally', async () => {
      const { calls, recorded, services } = traceServices();
      buildRuntime({ services });
      enable(['ntfy', 'gotify']);
      createRelease();
      createRelease();
      clock = local(6, 10, 14);
      expect(runtime.runCycle()).toMatchObject({ materialized: 2, claimed: 4 });
      await flush();
      // Each lane runs its first claim; the second is claimed but still queued.
      expect(transports.sendsFor('ntfy')).toHaveLength(1);
      expect(transports.sendsFor('gotify')).toHaveLength(1);
      const [ntfyRunning] = transports.sendsFor('ntfy');
      const [gotifyRunning] = transports.sendsFor('gotify');
      const queuedIds = db.prepare(`
        SELECT delivery_id FROM release_notification_deliveries WHERE delivery_id NOT IN (?, ?)
      `).pluck().all(ntfyRunning.context.deliveryId, gotifyRunning.context.deliveryId);
      expect(queuedIds).toHaveLength(2);

      const pause = runtime.pauseForMaintenance();
      // Relinquished synchronously, before the drain completes: no lease left behind.
      expect(calls.filter((call) => call === 'relinquish')).toHaveLength(2);
      for (const id of queuedIds) {
        expect(core.repository.findDelivery(id)).toMatchObject({
          state: 'pending', attempt_count: 0, claim_token: null, claim_expires_at: null,
          next_attempt_at: clock.toISOString(), last_attempt_at: null, failure_code: null,
        });
      }

      let drained = false;
      const draining = pause.waitForIdle().then(() => { drained = true; });
      await flush();
      expect(drained).toBe(false);
      // Each running channel completes independently of the other.
      gotifyRunning.resolve({ outcome: 'transient_failure', failureCode: 'provider_unavailable' });
      await flush();
      expect(drained).toBe(false);
      ntfyRunning.resolve({ outcome: 'accepted' });
      await draining;
      expect(core.repository.findDelivery(ntfyRunning.context.deliveryId).state).toBe('accepted');
      expect(core.repository.findDelivery(gotifyRunning.context.deliveryId))
        .toMatchObject({ state: 'pending', attempt_count: 1, failure_code: 'provider_unavailable' });
      expect(transports.sends).toHaveLength(2);
      expect(recorded.sort()).toEqual(['gotify', 'ntfy']);

      pause.release();
      expect(runtime.runCycle().claimed).toBe(2);
      await flush();
      const resumed = transports.sends.slice(2).map((send) => send.context.deliveryId).sort();
      expect(resumed).toEqual([...queuedIds].sort());
      for (const id of queuedIds) expect(core.repository.findDelivery(id)).toMatchObject({ state: 'sending', attempt_count: 1 });
      expect(calls.filter((call) => call.startsWith('complete:'))).toEqual(['complete:transient_failure', 'complete:accepted']);
    });

    it('relinquishes queued claims when shutdown stops the runtime', async () => {
      buildRuntime();
      enable(['ntfy']);
      createRelease();
      createRelease();
      clock = local(6, 10, 14);
      runtime.runCycle();
      await flush();
      const [running] = transports.sends;
      runtime.stop();
      const queued = deliveryRows().find((row) => row.delivery_id !== running.context.deliveryId);
      expect(queued).toMatchObject({ state: 'pending', attempt_count: 0, claim_token: null });
      running.resolve({ outcome: 'accepted' });
      await runtime.waitForIdle();
      expect(transports.sends).toHaveLength(1);
    });

    it('relinquishes instead of failing when the established destination is unavailable at final revalidation', async () => {
      const { calls, recorded, services } = traceServices();
      buildRuntime({ services });
      enable(['ntfy']);
      createRelease();
      clock = local(6, 10, 14);

      // Claimed while ready, then the destination drops out before the lane runs.
      for (let cycle = 0; cycle < 7; cycle += 1) {
        expect(runtime.runCycle().claimed).toBe(1);
        transports.unready.add('ntfy');
        await flush();
        expect(deliveryFor('ntfy')).toMatchObject({
          state: 'pending', attempt_count: 0, claim_token: null, failure_code: null, last_attempt_at: null,
          next_attempt_at: clock.toISOString(),
        });
        transports.unready.delete('ntfy');
        clock = new Date(clock.getTime() + MINUTE);
      }
      expect(transports.sends).toHaveLength(0);
      expect(recorded).toEqual([]);
      expect(recentResults.getRecentResults().ntfy ?? null).toBeNull();
      expect(calls).toEqual(Array(7).fill('relinquish'));

      // The same destination returns: the delivery sends normally as attempt 1.
      expect(runtime.runCycle().claimed).toBe(1);
      await flush();
      expect(transports.sends).toHaveLength(1);
      transports.sends[0].resolve({ outcome: 'accepted' });
      await flush();
      expect(deliveryFor('ntfy')).toMatchObject({ state: 'accepted', attempt_count: 1, last_attempt_at: clock.toISOString() });
      expect(recentResults.getRecentResults().ntfy).toMatchObject({ kind: 'release', state: 'accepted' });
    });

    it('relinquishes repeated pre-send lease expiries so they never exhaust the real attempt budget', async () => {
      const { calls, recorded, services } = traceServices();
      buildRuntime({ services });
      enable(['ntfy'], { overdue: { enabled: false, graceMinutes: 60 } });
      createRelease();
      clock = local(6, 10, 14);

      for (let cycle = 0; cycle < 7; cycle += 1) {
        expect(runtime.runCycle().claimed).toBe(1);
        // Every reclaim is attempt 1 again, never attempt 2..5 or a terminal failure.
        expect(deliveryFor('ntfy')).toMatchObject({ state: 'sending', attempt_count: 1 });
        // The lane reaches the claim only after WP1's 5-minute lease expired.
        clock = new Date(clock.getTime() + 6 * MINUTE);
        await flush();
        expect(deliveryFor('ntfy')).toMatchObject({
          state: 'pending', attempt_count: 0, claim_token: null, claim_expires_at: null,
          last_attempt_at: null, failure_code: null, next_attempt_at: clock.toISOString(),
        });
      }
      expect(transports.sends).toHaveLength(0);
      expect(recorded).toEqual([]);
      expect(recentResults.getRecentResults().ntfy ?? null).toBeNull();
      expect(calls).toEqual(Array(7).fill('relinquish'));

      // A claim that passes final revalidation in time is the first real attempt.
      expect(runtime.runCycle().claimed).toBe(1);
      await flush();
      expect(transports.sends).toHaveLength(1);
      transports.sends[0].resolve({ outcome: 'accepted' });
      await flush();
      expect(deliveryFor('ntfy')).toMatchObject({ state: 'accepted', attempt_count: 1, last_attempt_at: clock.toISOString() });
      expect(recentResults.getRecentResults().ntfy).toMatchObject({ kind: 'release', state: 'accepted' });
    });

    it('leaves a newer claim intact when an expired pre-send claim was reclaimed before it could be relinquished', async () => {
      const calls = [];
      let newer = null;
      const traced = {
        ...core,
        revalidateClaim: (input) => {
          const check = core.revalidateClaim(input);
          if (check.code === 'claim_expired') {
            // Another worker recovers the expired lease in the gap before relinquish.
            [newer] = core.claimDueDeliveries({ destinations: runtime.resolveDestinations(core.getSettings()), limit: 5 });
          }
          return check;
        },
        relinquishClaim: (input) => {
          const result = core.relinquishClaim(input);
          calls.push(result.applied);
          return result;
        },
      };
      buildRuntime({ services: { releaseNotificationService: traced, recentResultService: recentResults } });
      enable(['ntfy'], { overdue: { enabled: false, graceMinutes: 60 } });
      createRelease();
      clock = local(6, 10, 14);
      expect(runtime.runCycle().claimed).toBe(1);
      clock = new Date(clock.getTime() + 6 * MINUTE);
      await flush();

      // The old token's relinquish was refused; the newer claim keeps its attempt.
      expect(calls).toEqual([false]);
      expect(newer).not.toBeNull();
      expect(deliveryFor('ntfy')).toMatchObject({
        state: 'sending', claim_token: newer.claimToken, attempt_count: newer.attempt,
      });
      expect(newer.attempt).toBe(2);
      expect(transports.sends).toHaveLength(0);
      expect(recentResults.getRecentResults().ntfy ?? null).toBeNull();
    });
  });

  describe('bounded materialization sweep', () => {
    it('advances a wrapping cursor across cycles, surviving a pause', async () => {
      const batches = [];
      const traced = {
        ...core,
        materializeDueOccurrenceBatch: (input) => {
          const result = core.materializeDueOccurrenceBatch(input);
          batches.push({ after: input.afterReleaseId, limit: input.limit, scanned: result.scanned });
          return result;
        },
      };
      transports = createFakeTransports({ autoResult: { outcome: 'accepted' } });
      runtime = createReleaseNotificationRuntime({
        transportConfig: transportConfig(),
        getServices: () => ({ releaseNotificationService: traced, recentResultService: recentResults }),
        now: () => new Date(clock),
        senderFactories: transports.factories,
        materializationLimit: 2,
      });
      // A scheduled notice with no later phase stays current: background sweep work only.
      enable(['ntfy'], { overdue: { enabled: false, graceMinutes: 60 } });
      const ids = Array.from({ length: 5 }, () => createRelease());
      clock = local(6, 10, 14);

      expect(runtime.runCycle()).toMatchObject({ materialized: 2 });
      await flush();
      const pause = runtime.pauseForMaintenance();
      expect(runtime.runCycle()).toEqual({ skipped: true, reason: 'paused' });
      await pause.waitForIdle();
      pause.release();
      expect(runtime.runCycle()).toMatchObject({ materialized: 2 });
      await flush();
      expect(runtime.runCycle()).toMatchObject({ materialized: 1 });
      await flush();
      expect(runtime.runCycle()).toMatchObject({ materialized: 0 });

      expect(batches).toEqual([
        { after: 0, limit: 2, scanned: 2 },
        { after: ids[1], limit: 2, scanned: 2 },
        { after: ids[3], limit: 2, scanned: 1 },
        { after: 0, limit: 2, scanned: 2 },
      ]);
      await flush();
      expect(deliveryRows().map((row) => row.state)).toEqual(Array(5).fill('accepted'));
    });
  });

  describe('time-critical materialization', () => {
    function buildTracedRuntime() {
      const trace = { batches: [], failNext: false };
      const traced = {
        ...core,
        materializeDueOccurrenceBatch: (input) => {
          trace.batches.push(input.afterReleaseId);
          if (trace.failNext) {
            trace.failNext = false;
            throw new Error('materialization failed');
          }
          return core.materializeDueOccurrenceBatch(input);
        },
      };
      transports = createFakeTransports({ autoResult: { outcome: 'accepted' } });
      runtime = createReleaseNotificationRuntime({
        transportConfig: transportConfig(),
        getServices: () => ({ releaseNotificationService: traced, recentResultService: recentResults }),
        now: () => new Date(clock),
        senderFactories: transports.factories,
        materializationLimit: 2,
        timeCriticalLimit: 2,
      });
      return trace;
    }

    const occurrenceRows = () => db
      .prepare('SELECT release_id, reason FROM release_notification_occurrences ORDER BY release_id')
      .all();

    it('delivers a one-minute advance notice while the sweep is on another page', async () => {
      const trace = buildTracedRuntime();
      enable(['ntfy'], {
        advance: { enabled: true, leadMinutes: 1 },
        scheduled: { enabled: false },
        overdue: { enabled: false, graceMinutes: 60 },
      });
      const target = createRelease();
      const others = Array.from({ length: 5 }, () => createRelease({ plannedDate: '2026-07-01' }));

      clock = local(6, 10, 13, 58);
      expect(runtime.runCycle()).toMatchObject({ materialized: 0 });
      clock = local(6, 10, 13, 59);
      expect(runtime.runCycle()).toMatchObject({ materialized: 1, claimed: 1 });
      await flush();
      clock = local(6, 10, 14);
      expect(runtime.runCycle()).toMatchObject({ materialized: 0 });

      // The sweep saw the target only at 13:58, before its window opened.
      expect(trace.batches).toEqual([0, others[0], others[2]]);
      expect(occurrenceRows()).toEqual([{ release_id: target, reason: 'release.advance' }]);
      expect(deliveryFor('ntfy')).toMatchObject({ state: 'accepted' });
    });

    it('starts the next sweep immediately after an exactly full final page', () => {
      const trace = buildTracedRuntime();
      enable(['ntfy'], { overdue: { enabled: false, graceMinutes: 60 } });
      createRelease({ plannedDate: '2026-07-01' });
      createRelease({ plannedDate: '2026-07-01' });
      clock = local(6, 10, 13, 58);
      runtime.runCycle();
      runtime.runCycle();
      expect(trace.batches).toEqual([0, 0]);
    });

    it('considers a scheduled notice in its window while the sweep is on another page', async () => {
      const trace = buildTracedRuntime();
      enable(['ntfy']);
      Array.from({ length: 4 }, () => createRelease({ plannedDate: '2026-07-01' }));
      const target = createRelease();

      clock = local(6, 10, 14);
      expect(runtime.runCycle()).toMatchObject({ materialized: 1, claimed: 1 });
      await flush();
      expect(trace.batches).toEqual([0]);
      expect(occurrenceRows()).toEqual([{ release_id: target, reason: 'release.scheduled' }]);
    });

    it('keeps the sweep position when a cycle fails', () => {
      const trace = buildTracedRuntime();
      enable(['ntfy'], { overdue: { enabled: false, graceMinutes: 60 } });
      const ids = Array.from({ length: 3 }, () => createRelease({ plannedDate: '2026-07-01' }));
      clock = local(6, 10, 14);
      runtime.runCycle();
      trace.failNext = true;
      expect(() => runtime.runCycle()).toThrow('materialization failed');
      runtime.runCycle();
      expect(trace.batches).toEqual([0, ids[1], ids[1]]);
    });
  });

  describe('priority backlog continuation', () => {
    const ONE_MINUTE_ADVANCE = { advance: { enabled: true, leadMinutes: 1 } };

    function buildPriorityRuntime({ pages = TIME_CRITICAL_PAGES_PER_CYCLE } = {}) {
      const trace = { passes: [], batches: [], pageSizes: [] };
      const listTimeCriticalReleases = core.repository.listTimeCriticalReleases;
      core.repository.listTimeCriticalReleases = (input) => {
        const rows = listTimeCriticalReleases(input);
        trace.pageSizes.push({ limit: input.limit, rows: rows.length });
        return rows;
      };
      const traced = {
        ...core,
        materializeTimeCriticalOccurrences: (input) => {
          const result = core.materializeTimeCriticalOccurrences(input);
          trace.passes.push({ created: result.results.length, hasMore: result.hasMore });
          return result;
        },
        materializeDueOccurrenceBatch: (input) => {
          trace.batches.push(input.afterReleaseId);
          return core.materializeDueOccurrenceBatch(input);
        },
      };
      transports = createFakeTransports({ autoResult: { outcome: 'accepted' } });
      runtime = createReleaseNotificationRuntime({
        transportConfig: transportConfig(),
        getServices: () => ({ releaseNotificationService: traced, recentResultService: recentResults }),
        now: () => new Date(clock),
        senderFactories: transports.factories,
        materializationLimit: 2,
        timeCriticalLimit: 2,
        timeCriticalPagesPerCycle: pages,
      });
      return trace;
    }

    function fakeTimers() {
      const timeouts = [];
      const intervals = [];
      return {
        timeouts,
        intervals,
        setTimeoutFn: (fn, ms) => { const handle = { fn, ms, cleared: false }; timeouts.push(handle); return handle; },
        clearTimeoutFn: (handle) => { handle.cleared = true; },
        setIntervalFn: (fn, ms) => { const handle = { fn, ms, cleared: false }; intervals.push(handle); return handle; },
        clearIntervalFn: (handle) => { handle.cleared = true; },
      };
    }

    function startScheduler() {
      const timers = fakeTimers();
      const scheduler = createReleaseNotificationScheduler({ runCycle: (options) => runtime.runCycle(options), ...timers });
      scheduler.start();
      return { timers, scheduler };
    }

    /** Unrelated releases first, so the background sweep's first page never holds the due ones. */
    function seed(dueCount) {
      Array.from({ length: 4 }, () => createRelease({ plannedDate: '2026-07-01' }));
      return Array.from({ length: dueCount }, () => createRelease());
    }

    const advanceIds = () => db
      .prepare("SELECT release_id FROM release_notification_occurrences WHERE reason = 'release.advance' ORDER BY release_id")
      .pluck().all();

    it('drains a one-minute advance window larger than one page before the phase expires', async () => {
      const trace = buildPriorityRuntime();
      enable(['ntfy'], ONE_MINUTE_ADVANCE);
      const due = seed(3);

      clock = local(6, 10, 13, 59);
      expect(runtime.runCycle()).toMatchObject({ skipped: false, materialized: 3, priorityBacklog: false });
      expect(trace.passes).toEqual([{ created: 2, hasMore: true }, { created: 1, hasMore: false }]);
      expect(trace.batches).toEqual([0]);
      expect(advanceIds()).toEqual(due);
      await flush();

      // Scheduled becomes current a minute later; every release already had its advance notice.
      clock = local(6, 10, 14);
      runtime.runCycle();
      expect(advanceIds()).toEqual(due);
      expect(db.prepare("SELECT COUNT(*) FROM release_notification_occurrences WHERE reason = 'release.scheduled'")
        .pluck().get()).toBe(3);
      expect(trace.pageSizes.every(({ limit, rows }) => limit === 2 && rows <= 2)).toBe(true);
    });

    it('runs several bounded pages in one cycle without duplicate occurrences', () => {
      const trace = buildPriorityRuntime();
      enable(['ntfy'], ONE_MINUTE_ADVANCE);
      const due = seed(7);

      clock = local(6, 10, 13, 59);
      expect(runtime.runCycle()).toMatchObject({ materialized: 7, priorityBacklog: false });
      expect(trace.passes.map((pass) => pass.created)).toEqual([2, 2, 2, 1]);
      expect(trace.pageSizes.every(({ limit, rows }) => limit === 2 && rows <= 2)).toBe(true);
      expect(advanceIds()).toEqual(due);

      expect(runtime.runCycle()).toMatchObject({ materialized: 0, priorityBacklog: false });
      expect(advanceIds()).toEqual(due);
    });

    it('stops at its page budget and resumes the rest in a prompt continuation', async () => {
      const trace = buildPriorityRuntime({ pages: 2 });
      enable(['ntfy'], ONE_MINUTE_ADVANCE);
      const due = seed(7);
      clock = local(6, 10, 13, 59);
      const { timers, scheduler } = startScheduler();

      timers.timeouts[0].fn();
      await scheduler.waitForIdle();
      // Exactly the budget: two pages, then backlog is reported and a short continuation is pending.
      expect(trace.passes).toEqual([{ created: 2, hasMore: true }, { created: 2, hasMore: true }]);
      expect(advanceIds()).toEqual(due.slice(0, 4));
      expect(scheduler.hasPendingContinuation()).toBe(true);
      expect(timers.timeouts).toHaveLength(2);
      expect(timers.timeouts[1].ms).toBe(RELEASE_NOTIFICATION_CONTINUATION_DELAY_MS);
      expect(RELEASE_NOTIFICATION_CONTINUATION_DELAY_MS).toBeLessThan(MINUTE);

      // Still 13:59: the continuation finishes the window, without another background batch.
      timers.timeouts[1].fn();
      await scheduler.waitForIdle();
      expect(trace.passes.slice(2)).toEqual([{ created: 2, hasMore: true }, { created: 1, hasMore: false }]);
      expect(advanceIds()).toEqual(due);
      expect(trace.batches).toEqual([0]);
      expect(trace.pageSizes.every(({ limit, rows }) => limit === 2 && rows <= 2)).toBe(true);
      expect(scheduler.hasPendingContinuation()).toBe(false);
      expect(timers.timeouts).toHaveLength(2);
      expect(timers.intervals).toHaveLength(1);
      scheduler.stop();
    });

    it('never runs a pending continuation after the scheduler stops', async () => {
      const trace = buildPriorityRuntime({ pages: 1 });
      enable(['ntfy'], ONE_MINUTE_ADVANCE);
      seed(3);
      clock = local(6, 10, 13, 59);
      const { timers, scheduler } = startScheduler();
      timers.timeouts[0].fn();
      await scheduler.waitForIdle();
      expect(scheduler.hasPendingContinuation()).toBe(true);

      scheduler.stop();
      expect(timers.timeouts[1].cleared).toBe(true);
      expect(scheduler.hasPendingContinuation()).toBe(false);
      timers.timeouts[1].fn();
      await scheduler.waitForIdle();
      expect(trace.passes).toHaveLength(1);
      expect(advanceIds()).toHaveLength(2);
    });

    it('does no notification work in a continuation during a maintenance pause and resumes after it', async () => {
      const trace = buildPriorityRuntime({ pages: 1 });
      enable(['ntfy'], ONE_MINUTE_ADVANCE);
      const due = seed(3);
      clock = local(6, 10, 13, 59);
      const { timers, scheduler } = startScheduler();
      timers.timeouts[0].fn();
      await scheduler.waitForIdle();
      expect(scheduler.hasPendingContinuation()).toBe(true);

      const pause = runtime.pauseForMaintenance();
      timers.timeouts[1].fn();
      await scheduler.waitForIdle();
      expect(trace.passes).toHaveLength(1);
      // A paused cycle reports no backlog, so no further continuation spins.
      expect(scheduler.hasPendingContinuation()).toBe(false);
      expect(timers.timeouts).toHaveLength(2);
      await pause.waitForIdle();
      pause.release();

      // The normal cadence resumes and drains the remainder.
      timers.intervals[0].fn();
      await scheduler.waitForIdle();
      expect(advanceIds()).toEqual(due);
      expect(trace.passes.slice(1).map((pass) => pass.created)).toEqual([1]);
      expect(scheduler.hasPendingContinuation()).toBe(false);
      scheduler.stop();
    });
  });

  describe('claim wave continuation', () => {
    const ONE_MINUTE_ADVANCE = { advance: { enabled: true, leadMinutes: 1 } };

    function fakeTimers() {
      const timeouts = [];
      const intervals = [];
      return {
        timeouts,
        intervals,
        setTimeoutFn: (fn, ms) => { const handle = { fn, ms, cleared: false }; timeouts.push(handle); return handle; },
        clearTimeoutFn: (handle) => { handle.cleared = true; },
        setIntervalFn: (fn, ms) => { const handle = { fn, ms, cleared: false }; intervals.push(handle); return handle; },
        clearIntervalFn: (handle) => { handle.cleared = true; },
      };
    }

    /**
     * Real WP1 core and runtime under a fake-timer scheduler, tracing claim
     * waves, final revalidations, per-lane concurrency, and recent results.
     */
    function buildWaveRuntime({
      autoResult = { outcome: 'accepted' }, runtimeOptions = {}, holdCycle = null, beforeCycle = null,
    } = {}) {
      const trace = {
        waves: [], pages: [], validated: new Set(), sendOrder: [], recorded: 0, inFlight: {}, maxInFlight: 0, cycles: [],
      };
      const traced = {
        ...core,
        claimDueDeliveryPage: (input) => {
          const page = core.claimDueDeliveryPage(input);
          const channel = Object.keys(input.destinations)[0];
          // Ready but disabled channels are claimed for too; they never have work.
          if (core.getSettings().enabledChannels.includes(channel)) {
            trace.waves.push({ channel, size: page.claims.length });
            trace.pages.push({
              channel, claims: page.claims.length, cleared: page.cleared, hasMore: page.hasMore, madeProgress: page.madeProgress,
            });
          }
          return page;
        },
        revalidateClaim: (input) => {
          const check = core.revalidateClaim(input);
          if (check.valid) trace.validated.add(input.deliveryId);
          return check;
        },
        completeDelivery: (input) => {
          const row = core.repository.findDelivery(input.deliveryId);
          trace.inFlight[row.channel] -= 1;
          return core.completeDelivery(input);
        },
      };
      const tracedResults = {
        ...recentResults,
        recordResult: (channel, entry) => { trace.recorded += 1; return recentResults.recordResult(channel, entry); },
      };
      transports = createFakeTransports({ autoResult });
      const factories = Object.fromEntries(CHANNELS.map((channel) => [channel, (config) => {
        const sender = transports.factories[channel](config);
        return {
          ...sender,
          send(payload, context) {
            // Every send follows its own successful final revalidation.
            expect(trace.validated.has(context.deliveryId)).toBe(true);
            trace.sendOrder.push(context.deliveryId);
            trace.inFlight[channel] = (trace.inFlight[channel] ?? 0) + 1;
            trace.maxInFlight = Math.max(trace.maxInFlight, trace.inFlight[channel]);
            return sender.send(payload, context);
          },
        };
      }]));
      runtime = createReleaseNotificationRuntime({
        transportConfig: transportConfig(),
        getServices: () => ({ releaseNotificationService: traced, recentResultService: tracedResults }),
        now: () => new Date(clock),
        senderFactories: factories,
        ...runtimeOptions,
      });
      const timers = fakeTimers();
      const scheduler = createReleaseNotificationScheduler({
        runCycle: (options) => {
          trace.cycles.push(options.continuation === true ? 'continuation' : 'normal');
          beforeCycle?.();
          const summary = runtime.runCycle(options);
          return holdCycle ? holdCycle(summary) : summary;
        },
        ...timers,
      });
      return { trace, timers, scheduler };
    }

    async function fire(handle, scheduler) {
      handle.fn();
      await scheduler.waitForIdle();
      await flush();
    }

    /** Timeouts that are neither fired nor cancelled: the pending continuation, if any. */
    const pending = (timers, fired) => timers.timeouts.filter((handle) => !handle.cleared && !fired.has(handle));

    /** Start, run the startup cycle, then fire each continuation as it becomes pending. */
    async function runChain(timers, scheduler) {
      const fired = new Set();
      scheduler.start();
      while (pending(timers, fired).length > 0) {
        const open = pending(timers, fired);
        // Never more than one short continuation pending globally.
        expect(open.filter((handle) => handle.ms === RELEASE_NOTIFICATION_CONTINUATION_DELAY_MS).length).toBeLessThanOrEqual(1);
        fired.add(open[0]);
        await fire(open[0], scheduler);
      }
      return fired;
    }

    const acceptedCount = (reason, channel = 'email') => db.prepare(`
      SELECT COUNT(*) FROM release_notification_deliveries d
      JOIN release_notification_occurrences o ON o.event_id = d.event_id
      WHERE o.reason = ? AND d.channel = ? AND d.state = 'accepted'
    `).pluck().get(reason, channel);

    it('delivers 20 one-minute advance notices in bounded waves inside the advance window', async () => {
      const { trace, timers, scheduler } = buildWaveRuntime();
      enable(['email'], ONE_MINUTE_ADVANCE);
      Array.from({ length: 20 }, () => createRelease());
      clock = local(6, 10, 13, 59);
      const windowStart = clock.getTime();

      await runChain(timers, scheduler);
      // The fake clock never left 13:59: only short continuations, no minute tick.
      expect(clock.getTime()).toBe(windowStart);
      expect(timers.intervals[0].cleared).toBe(false);
      expect(trace.cycles).toEqual(['normal', 'continuation', 'continuation', 'continuation', 'continuation']);
      // 5+5+5+5, then one bounded zero-row wave after the exactly full final wave.
      expect(trace.waves.map((wave) => wave.size)).toEqual([5, 5, 5, 5, 0]);
      expect(timers.timeouts.slice(1).every((handle) => handle.ms === RELEASE_NOTIFICATION_CONTINUATION_DELAY_MS)).toBe(true);
      expect(scheduler.hasPendingContinuation()).toBe(false);
      expect(trace.sendOrder).toHaveLength(20);
      expect(new Set(trace.sendOrder).size).toBe(20);
      expect(trace.maxInFlight).toBe(1);
      expect(trace.recorded).toBe(20);
      expect(acceptedCount('release.advance')).toBe(20);

      // At 14:00 the advance phase is superseded; nothing was lost to the claim cap.
      clock = local(6, 10, 14);
      await fire(timers.intervals[0], scheduler);
      expect(db.prepare("SELECT COUNT(*) FROM release_notification_deliveries WHERE state = 'cancelled'").pluck().get()).toBe(0);
      expect(acceptedCount('release.advance')).toBe(20);
      scheduler.stop();
    });

    it('never loses a lane-drain request that lands while the scheduler cycle is settling', async () => {
      // Each scheduler cycle stays active for `hops` microtasks after the
      // runtime's synchronous work while the auto-accepting Email lane drains
      // its full wave concurrently, so across the sweep the lane-idle request
      // lands before, inside, and after the cycle's settlement. (Against a
      // scheduler that read the request before going idle, one hop count left
      // 15 advances idle with no continuation pending.)
      const outcomes = [];
      for (let hops = 0; hops <= 40; hops += 1) {
        closeDatabase(db);
        db = openDatabase(':memory:');
        runMigrations(db, MIGRATIONS_DIR);
        core = createReleaseNotificationService({ db, now: () => new Date(clock) });
        recentResults = createReleaseNotificationRecentResultService({ appMetaRepository: createAppMetaRepository(db) });
        const { trace, timers, scheduler } = buildWaveRuntime({
          holdCycle: async (summary) => {
            for (let i = 0; i < hops; i += 1) await Promise.resolve();
            return summary;
          },
        });
        clock = local(6, 1, 8);
        enable(['email'], ONE_MINUTE_ADVANCE);
        Array.from({ length: 20 }, () => createRelease());
        clock = local(6, 10, 13, 59);

        await runChain(timers, scheduler);
        outcomes.push({ hops, accepted: acceptedCount('release.advance'), cycles: trace.cycles.length });
        // Still 13:59: every wave followed by a prompt continuation, never the minute tick.
        expect(timers.intervals[0].cleared).toBe(false);
        expect(trace.waves.map((wave) => wave.size)).toEqual([5, 5, 5, 5, 0]);
        expect(trace.cycles).toEqual(['normal', 'continuation', 'continuation', 'continuation', 'continuation']);
        expect(scheduler.hasPendingContinuation()).toBe(false);
        expect(trace.maxInFlight).toBe(1);
        expect(acceptedCount('release.advance')).toBe(20);
        scheduler.stop();
      }
      expect(outcomes.every((outcome) => outcome.accepted === 20)).toBe(true);
    }, 30000);

    it('stops after an underfull wave', async () => {
      const { trace, timers, scheduler } = buildWaveRuntime();
      enable(['email']);
      Array.from({ length: 6 }, () => createRelease());
      clock = local(6, 10, 14);
      await runChain(timers, scheduler);
      expect(trace.waves.map((wave) => wave.size)).toEqual([5, 1]);
      expect(timers.timeouts).toHaveLength(2);
      expect(scheduler.hasPendingContinuation()).toBe(false);
      expect(acceptedCount('release.scheduled')).toBe(6);
      scheduler.stop();
    });

    it('claims 5 + 5 + 2 for twelve due deliveries with one send per lane at a time', async () => {
      const { trace, timers, scheduler } = buildWaveRuntime();
      enable(['email']);
      Array.from({ length: 12 }, () => createRelease());
      clock = local(6, 10, 14);
      await runChain(timers, scheduler);
      expect(trace.waves.map((wave) => wave.size)).toEqual([5, 5, 2]);
      expect(trace.waves.every((wave) => wave.size <= CLAIM_LIMIT_PER_CHANNEL)).toBe(true);
      expect(trace.maxInFlight).toBe(1);
      expect(trace.sendOrder.every((id) => trace.validated.has(id))).toBe(true);
      expect(acceptedCount('release.scheduled')).toBe(12);
      scheduler.stop();
    });

    it('requests the next wave only once a slow lane has drained, without polling', async () => {
      const { trace, timers, scheduler } = buildWaveRuntime({ autoResult: null });
      enable(['email']);
      Array.from({ length: 7 }, () => createRelease());
      clock = local(6, 10, 14);
      scheduler.start();
      await fire(timers.timeouts[0], scheduler);
      expect(trace.waves.map((wave) => wave.size)).toEqual([5]);

      // Each blocked send leaves the lane busy: no continuation is scheduled in the meantime.
      for (let i = 0; i < 5; i += 1) {
        expect(transports.sends).toHaveLength(i + 1);
        await flush();
        expect(timers.timeouts).toHaveLength(1);
        expect(scheduler.hasPendingContinuation()).toBe(false);
        transports.sends[i].resolve({ outcome: 'accepted' });
        await flush();
      }
      // Drained: exactly one short continuation, which claims the rest.
      expect(timers.timeouts).toHaveLength(2);
      expect(timers.timeouts[1].ms).toBe(RELEASE_NOTIFICATION_CONTINUATION_DELAY_MS);
      await fire(timers.timeouts[1], scheduler);
      expect(trace.waves.map((wave) => wave.size)).toEqual([5, 2]);
      expect(trace.cycles).toEqual(['normal', 'continuation']);
      scheduler.stop();
    });

    it('lets each channel continue when its own lane drains, with one global continuation', async () => {
      const { trace, timers, scheduler } = buildWaveRuntime({
        autoResult: (channel) => (channel === 'ntfy' ? { outcome: 'accepted' } : undefined),
      });
      enable(['email', 'ntfy']);
      Array.from({ length: 7 }, () => createRelease());
      clock = local(6, 10, 14);
      scheduler.start();
      await fire(timers.timeouts[0], scheduler);
      expect(trace.waves).toEqual([{ channel: 'email', size: 5 }, { channel: 'ntfy', size: 5 }]);

      // ntfy drained while email is still busy: ntfy's next wave does not wait for email.
      expect(timers.timeouts).toHaveLength(2);
      await fire(timers.timeouts[1], scheduler);
      expect(trace.waves.slice(2)).toEqual([{ channel: 'ntfy', size: 2 }]);
      expect(timers.timeouts).toHaveLength(2);

      for (let i = 0; i < 5; i += 1) {
        transports.sendsFor('email')[i].resolve({ outcome: 'accepted' });
        await flush();
      }
      expect(timers.timeouts).toHaveLength(3);
      await fire(timers.timeouts[2], scheduler);
      // The same continuation also looks at the idle ntfy lane, which is drained.
      expect(trace.waves.slice(3)).toEqual([{ channel: 'email', size: 2 }, { channel: 'ntfy', size: 0 }]);
      for (let i = 5; i < 7; i += 1) {
        transports.sendsFor('email')[i].resolve({ outcome: 'accepted' });
        await flush();
      }
      expect(timers.timeouts).toHaveLength(3);
      expect(trace.maxInFlight).toBe(1);
      expect(acceptedCount('release.scheduled', 'email')).toBe(7);
      expect(acceptedCount('release.scheduled', 'ntfy')).toBe(7);
      scheduler.stop();
    });

    it('coalesces lanes that drain together into one continuation that serves both', async () => {
      const { trace, timers, scheduler } = buildWaveRuntime();
      enable(['email', 'ntfy']);
      Array.from({ length: 6 }, () => createRelease());
      clock = local(6, 10, 14);
      scheduler.start();
      await fire(timers.timeouts[0], scheduler);
      expect(trace.waves.map((wave) => wave.size)).toEqual([5, 5]);
      expect(timers.timeouts).toHaveLength(2);
      await fire(timers.timeouts[1], scheduler);
      expect(trace.waves.slice(2).map((wave) => wave.size)).toEqual([1, 1]);
      expect(timers.timeouts).toHaveLength(2);
      scheduler.stop();
    });

    it('serves priority materialization backlog and full claim waves with one continuation chain', async () => {
      const { trace, timers, scheduler } = buildWaveRuntime({
        runtimeOptions: { timeCriticalLimit: 2, timeCriticalPagesPerCycle: 1, claimLimitPerChannel: 2 },
      });
      enable(['email'], ONE_MINUTE_ADVANCE);
      Array.from({ length: 7 }, () => createRelease());
      clock = local(6, 10, 13, 59);
      await runChain(timers, scheduler);
      // Each cycle materialized one bounded page and claimed one bounded wave;
      // both reasons shared the single pending continuation.
      expect(trace.waves.map((wave) => wave.size)).toEqual([2, 2, 2, 1]);
      expect(trace.cycles).toEqual(['normal', 'continuation', 'continuation', 'continuation']);
      expect(acceptedCount('release.advance')).toBe(7);
      expect(scheduler.hasPendingContinuation()).toBe(false);
      scheduler.stop();
    });

    it('claims no further wave after the scheduler stops', async () => {
      const { trace, timers, scheduler } = buildWaveRuntime({ autoResult: null });
      enable(['email']);
      Array.from({ length: 12 }, () => createRelease());
      clock = local(6, 10, 14);
      scheduler.start();
      await fire(timers.timeouts[0], scheduler);
      // Waiting on lane idle when the scheduler stops.
      scheduler.stop();
      for (let i = 0; i < 5; i += 1) {
        transports.sends[i].resolve({ outcome: 'accepted' });
        await flush();
      }
      expect(timers.timeouts).toHaveLength(1);
      expect(trace.waves.map((wave) => wave.size)).toEqual([5]);
    });

    it('never runs a pending claim continuation after stop', async () => {
      const { trace, timers, scheduler } = buildWaveRuntime();
      enable(['email']);
      Array.from({ length: 12 }, () => createRelease());
      clock = local(6, 10, 14);
      scheduler.start();
      await fire(timers.timeouts[0], scheduler);
      expect(scheduler.hasPendingContinuation()).toBe(true);
      scheduler.stop();
      expect(timers.timeouts[1].cleared).toBe(true);
      await fire(timers.timeouts[1], scheduler);
      expect(trace.waves.map((wave) => wave.size)).toEqual([5]);
    });

    it('does not restart delivery when a lane drains during maintenance, and resumes on the normal cadence', async () => {
      const { trace, timers, scheduler } = buildWaveRuntime({ autoResult: null });
      enable(['email']);
      Array.from({ length: 7 }, () => createRelease());
      clock = local(6, 10, 14);
      scheduler.start();
      await fire(timers.timeouts[0], scheduler);
      const pause = runtime.pauseForMaintenance();
      // The four queued claims were relinquished; the running send drains.
      transports.sends[0].resolve({ outcome: 'accepted' });
      await pause.waitForIdle();
      await flush();
      expect(timers.timeouts).toHaveLength(1);
      expect(trace.waves.map((wave) => wave.size)).toEqual([5]);
      expect(transports.sends).toHaveLength(1);
      pause.release();
      await flush();
      expect(timers.timeouts).toHaveLength(1);

      clock = new Date(clock.getTime() + MINUTE);
      await fire(timers.intervals[0], scheduler);
      expect(trace.waves.map((wave) => wave.size)).toEqual([5, 5]);
      expect(transports.sends).toHaveLength(2);
      scheduler.stop();
    });

    it('does not spin on a full wave that was relinquished because its destination became unavailable', async () => {
      const { trace, timers, scheduler } = buildWaveRuntime();
      enable(['ntfy']);
      Array.from({ length: 6 }, () => createRelease());
      clock = local(6, 10, 14);
      scheduler.start();
      timers.timeouts[0].fn();
      transports.unready.add('ntfy');
      await scheduler.waitForIdle();
      await flush();
      expect(trace.waves.map((wave) => wave.size)).toEqual([5]);
      expect(transports.sends).toHaveLength(0);
      expect(timers.timeouts).toHaveLength(1);
      expect(trace.recorded).toBe(0);
      expect(db.prepare("SELECT COUNT(*) FROM release_notification_deliveries WHERE state = 'pending' AND attempt_count = 0")
        .pluck().get()).toBe(6);
      scheduler.stop();
    });

    describe('full candidate pages with stale rows', () => {
      const ADVANCE_ONLY = {
        advance: { enabled: true, leadMinutes: 1 },
        scheduled: { enabled: false },
        overdue: { enabled: false, graceMinutes: 60 },
      };

      /**
       * Materialization already complete: `staleCount` advance deliveries
       * made at 13:58 for 13:59 releases, whose advance phase has expired by
       * 13:59, sort ahead of `validCount` advance deliveries made at 13:59
       * for 14:00 releases, which stay current until 14:00.
       */
      function seedStaleAdvance(staleCount, validCount, channel = 'email') {
        enable([channel], ADVANCE_ONLY);
        const stale = Array.from({ length: staleCount }, () => createRelease({ plannedTime: '13:59' }));
        const valid = Array.from({ length: validCount }, () => createRelease({ plannedTime: '14:00' }));
        const destinations = runtime.resolveDestinations(core.getSettings());
        clock = local(6, 10, 13, 58);
        core.materializeDueOccurrences({ destinations });
        clock = local(6, 10, 13, 59);
        core.materializeDueOccurrences({ destinations });
        return { stale, valid };
      }

      const deliveriesForReleases = (releaseIds) => db.prepare(`
        SELECT d.*, o.reason FROM release_notification_deliveries d
        JOIN release_notification_occurrences o ON o.event_id = d.event_id
        WHERE o.release_id IN (SELECT value FROM json_each(?))
        ORDER BY o.release_id
      `).all(JSON.stringify(releaseIds));

      it.each([
        ['a two-row page', 2],
        ['the production page size', CLAIM_LIMIT_PER_CHANNEL],
      ])('claims a current advance notice behind a full page of expired ones (%s)', async (_label, limit) => {
        const { trace, timers, scheduler } = buildWaveRuntime({ runtimeOptions: { claimLimitPerChannel: limit } });
        const { stale, valid } = seedStaleAdvance(limit, 1);
        expect(deliveriesForReleases([...stale, ...valid]).map((row) => [row.reason, row.state]))
          .toEqual(Array(limit + 1).fill(['release.advance', 'pending']));

        scheduler.start();
        await fire(timers.timeouts[0], scheduler);
        // The whole bounded page was expired: cancelled unsent, never claimed.
        expect(trace.pages).toEqual([{ channel: 'email', claims: 0, cleared: limit, hasMore: true, madeProgress: true }]);
        expect(transports.sends).toHaveLength(0);
        expect(deliveriesForReleases(stale).every((row) => row.state === 'cancelled' && row.failure_code === 'superseded'))
          .toBe(true);
        expect(scheduler.hasPendingContinuation()).toBe(true);
        expect(timers.timeouts).toHaveLength(2);
        expect(timers.timeouts[1].ms).toBe(RELEASE_NOTIFICATION_CONTINUATION_DELAY_MS);

        // The short continuation, still inside the valid row's advance window.
        await fire(timers.timeouts[1], scheduler);
        expect(clock).toEqual(local(6, 10, 13, 59));
        expect(trace.cycles).toEqual(['normal', 'continuation']);
        expect(trace.pages[1]).toEqual({ channel: 'email', claims: 1, cleared: 0, hasMore: false, madeProgress: true });
        const [validRow] = deliveriesForReleases(valid);
        // The send wrapper also asserts it followed a successful final revalidation.
        expect(trace.sendOrder).toEqual([validRow.delivery_id]);
        expect(transports.sends[0].payload).toMatchObject({ type: 'release.advance', release: { id: valid[0] } });
        expect(validRow).toMatchObject({ state: 'accepted', attempt_count: 1 });
        // Only the real send produced a recent result.
        expect(trace.recorded).toBe(1);
        expect(scheduler.hasPendingContinuation()).toBe(false);
        expect(timers.timeouts).toHaveLength(2);
        scheduler.stop();
      });

      it('continues after a lane drains a full page of mixed stale and valid rows that claimed fewer than the limit', async () => {
        const { trace, timers, scheduler } = buildWaveRuntime({ autoResult: null });
        const { stale, valid } = seedStaleAdvance(3, 4);

        scheduler.start();
        await fire(timers.timeouts[0], scheduler);
        expect(trace.pages).toEqual([{ channel: 'email', claims: 2, cleared: 3, hasMore: true, madeProgress: true }]);
        expect(trace.waves[0].size).toBeLessThan(CLAIM_LIMIT_PER_CHANNEL);
        expect(deliveriesForReleases(stale).every((row) => row.state === 'cancelled')).toBe(true);

        // Queued claims exist, so nothing is requested while the lane is busy.
        for (let i = 0; i < 2; i += 1) {
          expect(transports.sends).toHaveLength(i + 1);
          expect(timers.timeouts).toHaveLength(1);
          expect(scheduler.hasPendingContinuation()).toBe(false);
          transports.sends[i].resolve({ outcome: 'accepted' });
          await flush();
        }
        // Drained: one short continuation claims the later valid rows.
        expect(timers.timeouts).toHaveLength(2);
        expect(timers.timeouts[1].ms).toBe(RELEASE_NOTIFICATION_CONTINUATION_DELAY_MS);
        await fire(timers.timeouts[1], scheduler);
        expect(trace.pages[1]).toEqual({ channel: 'email', claims: 2, cleared: 0, hasMore: false, madeProgress: true });
        for (let i = 2; i < 4; i += 1) {
          transports.sends[i].resolve({ outcome: 'accepted' });
          await flush();
        }
        expect(timers.timeouts).toHaveLength(2);
        expect(trace.cycles).toEqual(['normal', 'continuation']);
        expect(clock).toEqual(local(6, 10, 13, 59));
        expect(deliveriesForReleases(valid).map((row) => row.state)).toEqual(Array(4).fill('accepted'));
        expect(trace.maxInFlight).toBe(1);
        expect(trace.recorded).toBe(4);
        scheduler.stop();
      });

      it('stops the chain once a full page only reclaims rows it cannot send', async () => {
        // The established ntfy destination is ready when each cycle claims and
        // unavailable by the time its lane revalidates, so every claim is
        // relinquished unsent. Clearing stale rows is progress; a page of
        // relinquished claims alone is not.
        let unavailableAfterClaim = true;
        const { trace, timers, scheduler } = buildWaveRuntime({
          runtimeOptions: { claimLimitPerChannel: 2 },
          beforeCycle: () => transports.unready.delete('ntfy'),
          holdCycle: (summary) => {
            if (unavailableAfterClaim) transports.unready.add('ntfy');
            return summary;
          },
        });
        const { stale, valid } = seedStaleAdvance(3, 3, 'ntfy');

        await runChain(timers, scheduler);
        expect(trace.pages).toEqual([
          { channel: 'ntfy', claims: 0, cleared: 2, hasMore: true, madeProgress: true },
          { channel: 'ntfy', claims: 1, cleared: 1, hasMore: true, madeProgress: true },
          { channel: 'ntfy', claims: 2, cleared: 0, hasMore: true, madeProgress: true },
        ]);
        expect(trace.cycles).toEqual(['normal', 'continuation', 'continuation']);
        expect(scheduler.hasPendingContinuation()).toBe(false);
        expect(timers.timeouts).toHaveLength(3);
        expect(transports.sends).toHaveLength(0);
        expect(trace.recorded).toBe(0);
        expect(deliveriesForReleases(stale).every((row) => row.state === 'cancelled')).toBe(true);
        expect(deliveriesForReleases(valid).map((row) => [row.state, row.attempt_count]))
          .toEqual(Array(3).fill(['pending', 0]));

        // Nothing further happens on its own; the normal cadence resumes once ready.
        await flush();
        expect(timers.timeouts).toHaveLength(3);
        unavailableAfterClaim = false;
        await fire(timers.intervals[0], scheduler);
        expect(trace.pages[3]).toMatchObject({ claims: 2, hasMore: true });
        scheduler.stop();
      });
    });
  });

  describe('maintenance pause', () => {
    it('stops cycles and test admission, drains started sends, and reconciles on release', async () => {
      buildRuntime();
      enable(['ntfy']);
      createRelease();
      clock = local(6, 10, 14);
      runtime.runCycle();
      await flush();
      const [inFlight] = transports.sends;

      const pause = runtime.pauseForMaintenance();
      expect(runtime.runCycle()).toEqual({ skipped: true, reason: 'paused' });
      let drained = false;
      const draining = pause.waitForIdle().then(() => { drained = true; });
      await flush();
      expect(drained).toBe(false);
      inFlight.resolve({ outcome: 'accepted' });
      await draining;
      expect(deliveryFor('ntfy').state).toBe('accepted');

      let reconciled = 0;
      const reconcileDestinations = core.reconcileDestinations;
      core.reconcileDestinations = (input) => { reconciled += 1; return reconcileDestinations(input); };
      pause.release();
      expect(reconciled).toBe(1);
      expect(runtime.isAdmitting()).toBe(true);
    });

    it('stays paused until every overlapping pause is released', () => {
      buildRuntime();
      const first = runtime.pauseForMaintenance();
      const second = runtime.pauseForMaintenance();
      first.release();
      expect(runtime.isAdmitting()).toBe(false);
      second.release();
      expect(runtime.isAdmitting()).toBe(true);
    });
  });
});
