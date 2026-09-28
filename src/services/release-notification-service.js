import crypto from 'node:crypto';
import { createAppMetaRepository } from '../data/app-meta-repository.js';
import { ARCHIVED_PROJECT_STATUS } from '../data/project-repository.js';
import { createReleaseNotificationRepository } from '../data/release-notification-repository.js';
import {
  createReleaseNotificationSettingsService,
  isChannelActive,
  isReasonEnabled,
  RELEASE_NOTIFICATION_CHANNELS,
} from './release-notification-settings-service.js';

export const RELEASE_NOTIFICATION_REASONS = Object.freeze([
  'release.advance',
  'release.scheduled',
  'release.overdue',
  'release.overdue_repeat',
]);
export const RELEASE_NOTIFICATION_PAYLOAD_VERSION = 1;
export const MAX_DELIVERY_ATTEMPTS = 5;
const MINUTE_MS = 60 * 1000;
/** Delay after the Nth failed attempt (index N - 1). */
export const RETRY_DELAYS_MS = Object.freeze([1, 5, 15, 60].map((minutes) => minutes * MINUTE_MS));
/** A provider Retry-After may lengthen a retry delay, but never beyond this bound. */
export const RETRY_AFTER_MAX_MS = 60 * MINUTE_MS;
export const DEFAULT_CLAIM_LEASE_MS = 5 * MINUTE_MS;
/**
 * Candidate releases inspected per materialization batch. Libraries up to
 * this size are fully swept every scheduler cycle; larger ones are swept in
 * id order across consecutive cycles, keeping each cycle's synchronous work
 * bounded.
 */
export const MATERIALIZATION_CANDIDATE_LIMIT = 500;
/**
 * Releases materialized per cycle by the time-critical pass, which runs every
 * cycle independently of the background sweep. It covers only releases inside
 * a notification phase that a later phase can supersede (advance, a scheduled
 * notice followed by overdue, an initial overdue followed by repeats), so it
 * is sized for how many releases can share such a window at once, not for the
 * library.
 */
export const TIME_CRITICAL_CANDIDATE_LIMIT = 100;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const DELIVERY_OUTCOMES = ['accepted', 'transient_failure', 'permanent_failure'];
const PLANNED_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const HH_MM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DESTINATION_IDENTITY = /^[0-9a-f]{64}$/;
const SAFE_FAILURE_CODE = /^[a-z][a-z0-9_.]{0,63}$/;

export class ReleaseNotificationDestinationError extends Error {
  constructor(channel, field) {
    // Only the channel and field name are reported; destination values may
    // embed secrets (webhook URLs, Gotify tokens).
    super(`Invalid ${channel} notification destination: ${field}.`);
    this.name = 'ReleaseNotificationDestinationError';
    this.channel = channel;
    this.field = field;
  }
}

function sha256Hex(parts) {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function requireText(channel, field, value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ReleaseNotificationDestinationError(channel, field);
  }
  return value.trim();
}

function parseHttpUrl(channel, field, value) {
  let url;
  try {
    url = new URL(requireText(channel, field, value));
  } catch {
    throw new ReleaseNotificationDestinationError(channel, field);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ReleaseNotificationDestinationError(channel, field);
  }
  return url;
}

/** Server routing identity without embedded credentials, query, or trailing slash. */
function serverIdentity(channel, field, value) {
  const url = parseHttpUrl(channel, field, value);
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * Opaque, deterministic routing identity for one channel destination. Only
 * the fields that decide *where* a message goes participate, so rotating an
 * SMTP password, ntfy access token, or webhook auth header keeps pending
 * retries valid. A Gotify application token names the destination
 * application, so a new token is a new destination. The digest is persisted;
 * the inputs never are.
 */
export function computeDestinationIdentity(channel, config) {
  if (!RELEASE_NOTIFICATION_CHANNELS.includes(channel)) {
    throw new ReleaseNotificationDestinationError('unknown', 'channel');
  }
  const source = config ?? {};
  let fields;
  switch (channel) {
    case 'email': {
      const port = source.port;
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
        throw new ReleaseNotificationDestinationError(channel, 'port');
      }
      fields = [
        requireText(channel, 'host', source.host).toLowerCase(),
        port,
        requireText(channel, 'from', source.from).toLowerCase(),
        requireText(channel, 'to', source.to).toLowerCase(),
      ];
      break;
    }
    case 'ntfy':
      fields = [serverIdentity(channel, 'server', source.server), requireText(channel, 'topic', source.topic)];
      break;
    case 'gotify':
      fields = [serverIdentity(channel, 'server', source.server), requireText(channel, 'token', source.token)];
      break;
    case 'webhook':
      fields = [parseHttpUrl(channel, 'url', source.url).href];
      break;
    default:
      throw new ReleaseNotificationDestinationError(channel, 'channel');
  }
  return sha256Hex(['creatorcrate.release-notification.destination.v1', channel, ...fields]);
}

function effectiveTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
}

/** The server-local instant of a wall-clock minute, as the Date constructor resolves it. */
function resolveLocalWallClock(year, month, day, hours, minutes) {
  return new Date(year, month - 1, day, hours, minutes, 0, 0);
}

/**
 * The instant of a wall-clock minute when it resolves on its own local
 * calendar date, or null. A time inside an ordinary DST gap moves forward on
 * the same date and is kept; a time the zone skipped past midnight (a whole
 * skipped date, or a gap that crosses midnight) lands on a later date and is
 * rejected.
 */
function resolveLocalWallClockOnDate(year, month, day, hours, minutes) {
  const resolved = resolveLocalWallClock(year, month, day, hours, minutes);
  return resolved.getFullYear() === year && resolved.getMonth() === month - 1 && resolved.getDate() === day
    ? resolved
    : null;
}

/**
 * Resolve a release's notification schedule in the server's local timezone,
 * the same policy src/util/date.js applies to "today". Date-only releases use
 * the configured default time. Local wall-clock times inside a DST gap or
 * overlap resolve however the JavaScript Date constructor resolves them,
 * which is deterministic for a given zone. Returns null when the release has
 * no usable planned date/time.
 */
export function resolveReleaseSchedule(release, settings) {
  const dateMatch = typeof release?.planned_date === 'string' ? release.planned_date.match(PLANNED_DATE) : null;
  if (!dateMatch) return null;
  const plannedTime = release.planned_time === '' ? null : (release.planned_time ?? null);
  if (plannedTime !== null && !HH_MM.test(plannedTime)) return null;

  const usedDefaultTime = plannedTime === null;
  const effectiveTime = usedDefaultTime ? settings.dateOnlyTime : plannedTime;
  const [year, month, day] = dateMatch.slice(1).map(Number);
  const [hours, minutes] = effectiveTime.split(':').map(Number);
  const scheduledAt = resolveLocalWallClockOnDate(year, month, day, hours, minutes);
  if (!scheduledAt) return null;

  const timeZone = effectiveTimeZone();
  return {
    plannedDate: release.planned_date,
    plannedTime,
    effectiveTime,
    usedDefaultTime,
    timeZone,
    scheduledAt,
    // Identity of the effective schedule. Title, notes, and updated_at are
    // intentionally absent so unrelated edits never mint new occurrences.
    fingerprint: sha256Hex(['schedule.v1', release.planned_date, plannedTime, effectiveTime, timeZone]),
  };
}

/**
 * The single occurrence a release should have materialized at `now`, or
 * null. Only the latest due phase is returned: after downtime, one current
 * notice is sent instead of replaying every missed phase or repeat. Advance
 * notices expire once the scheduled instant passes. Anything nominally due
 * before the global activation baseline is suppressed.
 */
export function resolveDueOccurrence(schedule, settings, now) {
  if (!schedule || !settings.enabled || !settings.activation.activatedAt) return null;
  const latest = resolveLatestPhase(schedule, settings, now);
  if (!latest || latest.dueMs < Date.parse(settings.activation.activatedAt)) return null;
  const dueAt = new Date(latest.dueMs).toISOString();
  return {
    reason: latest.reason,
    dueAt,
    repeatDueAt: latest.reason === 'release.overdue_repeat' ? dueAt : null,
  };
}

/** The latest enabled phase whose configured nominal due time has arrived, or null. */
function resolveLatestPhase(schedule, settings, now) {
  const nowMs = now.getTime();
  const scheduledMs = schedule.scheduledAt.getTime();
  const candidates = [];

  if (settings.advance.enabled) {
    const dueMs = scheduledMs - settings.advance.leadMinutes * MINUTE_MS;
    if (dueMs <= nowMs && nowMs < scheduledMs) candidates.push({ reason: 'release.advance', dueMs });
  }
  if (settings.scheduled.enabled && scheduledMs <= nowMs) {
    candidates.push({ reason: 'release.scheduled', dueMs: scheduledMs });
  }
  if (settings.overdue.enabled) {
    const overdueMs = scheduledMs + settings.overdue.graceMinutes * MINUTE_MS;
    if (overdueMs <= nowMs) {
      candidates.push({ reason: 'release.overdue', dueMs: overdueMs });
      if (settings.overdueRepeat.enabled) {
        const intervalMs = settings.overdueRepeat.intervalMinutes * MINUTE_MS;
        const latestRepeat = Math.floor((nowMs - overdueMs) / intervalMs);
        if (latestRepeat >= 1) {
          candidates.push({ reason: 'release.overdue_repeat', dueMs: overdueMs + latestRepeat * intervalMs });
        }
      }
    }
  }
  if (candidates.length === 0) return null;
  return candidates.reduce((best, candidate) => (candidate.dueMs > best.dueMs ? candidate : best));
}

/**
 * Nominal due instant the current timing settings give an occurrence of
 * `reason`, or null when a stored repeat instant no longer lies on the
 * configured repeat grid.
 */
function configuredDueMs(schedule, settings, reason, repeatDueAt) {
  const scheduledMs = schedule.scheduledAt.getTime();
  const overdueMs = scheduledMs + settings.overdue.graceMinutes * MINUTE_MS;
  switch (reason) {
    case 'release.advance': return scheduledMs - settings.advance.leadMinutes * MINUTE_MS;
    case 'release.scheduled': return scheduledMs;
    case 'release.overdue': return overdueMs;
    case 'release.overdue_repeat': {
      const repeatMs = Date.parse(repeatDueAt);
      const intervalMs = settings.overdueRepeat.intervalMinutes * MINUTE_MS;
      const steps = (repeatMs - overdueMs) / intervalMs;
      return Number.isInteger(steps) && steps >= 1 ? repeatMs : null;
    }
    default: return null;
  }
}

/**
 * Why an unsent occurrence may no longer dispatch under the current timing
 * settings at `now`, or null. 'timing_changed' means the configured lead,
 * grace, or repeat interval moved its nominal due time; 'superseded' means a
 * later phase (or a later repeat) is now the single current notice, or an
 * advance notice reached its scheduled instant.
 */
function findTimingStaleReason(delivery, schedule, settings, now) {
  const dueMs = configuredDueMs(schedule, settings, delivery.reason, delivery.repeat_due_at);
  if (dueMs === null || dueMs !== Date.parse(delivery.due_at)) return 'timing_changed';
  const latest = resolveLatestPhase(schedule, settings, now);
  if (!latest || latest.reason !== delivery.reason || latest.dueMs !== dueMs) return 'superseded';
  return null;
}

/**
 * The phases current settings let a later phase supersede, expressed
 * relative to a release's scheduled instant: the phase is due at
 * `scheduled + dueOffsetMs` and superseded at `scheduled + expiresOffsetMs`
 * (the same boundaries resolveLatestPhase applies). Phases not listed stay
 * current indefinitely (scheduled or overdue with no later phase enabled) or
 * recur on an interval of at least an hour (repeats), so the background
 * sweep reaches them in time.
 */
function expiringPhases(settings) {
  const leadMs = settings.advance.leadMinutes * MINUTE_MS;
  const graceMs = settings.overdue.graceMinutes * MINUTE_MS;
  const intervalMs = settings.overdueRepeat.intervalMinutes * MINUTE_MS;
  const phases = [];
  if (settings.advance.enabled) {
    phases.push({ reason: 'release.advance', dueOffsetMs: -leadMs, expiresOffsetMs: 0 });
  }
  if (settings.scheduled.enabled && settings.overdue.enabled) {
    phases.push({ reason: 'release.scheduled', dueOffsetMs: 0, expiresOffsetMs: graceMs });
  }
  if (settings.overdue.enabled && settings.overdueRepeat.enabled) {
    phases.push({ reason: 'release.overdue', dueOffsetMs: graceMs, expiresOffsetMs: graceMs + intervalMs });
  }
  return phases;
}

/**
 * Wall-clock minutes are handled as "wall ms": the UTC epoch of the same
 * calendar fields. A wall minute's offset is its wall ms minus the instant
 * resolveLocalWallClock gives it; within a run of constant offset the
 * resolved instant is strictly increasing in wall-clock order.
 */
function wallClockFields(wallMs) {
  const wall = new Date(wallMs);
  return [wall.getUTCFullYear(), wall.getUTCMonth() + 1, wall.getUTCDate(), wall.getUTCHours(), wall.getUTCMinutes()];
}

function wallClockOffsetMs(wallMs) {
  return wallMs - resolveLocalWallClock(...wallClockFields(wallMs)).getTime();
}

/** Whether resolveReleaseSchedule keeps this wall-clock minute on its own local date. */
function wallClockKeepsLocalDate(wallMs) {
  return resolveLocalWallClockOnDate(...wallClockFields(wallMs)) !== null;
}

const floorMinute = (ms) => Math.floor(ms / MINUTE_MS) * MINUTE_MS;
const formatWallClock = (wallMs) => new Date(wallMs).toISOString().slice(0, 16).replace('T', ' ');

/**
 * Split wall-clock minutes in [fromWallMs, throughWallMs] into runs of
 * constant offset. Offsets are probed hourly and each change is located to
 * the minute by bisection, which assumes the zone changes offset at most once
 * per hour of wall-clock time (true of every real DST rule).
 */
function wallClockOffsetRuns(fromWallMs, throughWallMs) {
  const runs = [];
  let runStart = fromWallMs;
  let offsetMs = wallClockOffsetMs(fromWallMs);
  let probe = fromWallMs;
  while (probe < throughWallMs) {
    const next = Math.min(probe + HOUR_MS, throughWallMs);
    if (wallClockOffsetMs(next) === offsetMs) {
      probe = next;
      continue;
    }
    let low = probe;
    let high = next;
    while (high - low > MINUTE_MS) {
      const middle = low + floorMinute((high - low) / 2);
      if (wallClockOffsetMs(middle) === offsetMs) low = middle;
      else high = middle;
    }
    runs.push({ fromWallMs: runStart, throughWallMs: low, offsetMs });
    runStart = high;
    offsetMs = wallClockOffsetMs(high);
    probe = high;
  }
  runs.push({ fromWallMs: runStart, throughWallMs, offsetMs });
  return runs;
}

/**
 * Append the walls of [fromWallMs, throughWallMs] (all in one offset run)
 * that resolveReleaseSchedule keeps on their own local date, merging
 * contiguous kept walls into one range. Within one wall-clock day of a run the
 * resolved instant only increases and a wall can only be pushed forward, so
 * the walls pushed past that day's end form a suffix of the day, located by
 * bisection with the shared resolver. Work is a few resolutions per day
 * spanned, independent of how many releases exist.
 */
function appendDateKeepingRanges(ranges, fromWallMs, throughWallMs, offsetMs) {
  let sliceStart = fromWallMs;
  while (sliceStart <= throughWallMs) {
    const sliceEnd = Math.min(Math.floor(sliceStart / DAY_MS) * DAY_MS + DAY_MS - MINUTE_MS, throughWallMs);
    let keptThrough = sliceEnd;
    if (!wallClockKeepsLocalDate(sliceEnd)) {
      let low = sliceStart - MINUTE_MS;
      let high = sliceEnd;
      while (high - low > MINUTE_MS) {
        const middle = low + floorMinute((high - low) / 2);
        if (wallClockKeepsLocalDate(middle)) low = middle;
        else high = middle;
      }
      keptThrough = low;
    }
    if (keptThrough >= sliceStart) {
      const previous = ranges[ranges.length - 1];
      if (previous && previous.offsetMs === offsetMs && previous.throughWallMs + MINUTE_MS === sliceStart) {
        previous.throughWallMs = keptThrough;
      } else {
        ranges.push({ fromWallMs: sliceStart, throughWallMs: keptThrough, offsetMs });
      }
    }
    sliceStart = sliceEnd + MINUTE_MS;
  }
}

/**
 * Exactly the local wall-clock minutes ('YYYY-MM-DD HH:MM') that
 * resolveReleaseSchedule resolves to an instant in (afterMs, throughMs], as
 * ascending, disjoint inclusive ranges, each with the offset (seconds) that
 * maps its walls to instants. Around a DST gap or overlap this is not one
 * contiguous wall-clock range: walls in a gap resolve past the gap, and
 * repeated walls resolve to their earlier instant. Walls the resolver pushes
 * onto a later local date (a skipped calendar date) are rejected by
 * resolveReleaseSchedule, so they are left out here too and can never take a
 * place on a bounded page. No UTC offset reaches a day, so every such wall
 * lies within a day of the instant range.
 */
function scheduledWallClockRanges(afterMs, throughMs) {
  const ranges = [];
  const runs = wallClockOffsetRuns(floorMinute(afterMs - DAY_MS), floorMinute(throughMs + DAY_MS));
  for (const run of runs) {
    // A wall W resolves to W - offset; keep afterMs < W - offset <= throughMs.
    const fromWallMs = Math.max(run.fromWallMs, floorMinute(afterMs + run.offsetMs) + MINUTE_MS);
    const throughWallMs = Math.min(run.throughWallMs, floorMinute(throughMs + run.offsetMs));
    if (fromWallMs > throughWallMs) continue;
    appendDateKeepingRanges(ranges, fromWallMs, throughWallMs, run.offsetMs);
  }
  return ranges.map((range) => [
    formatWallClock(range.fromWallMs), formatWallClock(range.throughWallMs), range.offsetMs / 1000,
  ]);
}

/**
 * The nominal due instant is part of the identity so a timing change can
 * materialize a correctly timed occurrence, while returning to an earlier
 * timing reuses (and never replays) that earlier occurrence.
 */
export function buildOccurrenceKey(releaseId, schedule, occurrence) {
  return [`release:${releaseId}`, occurrence.reason, schedule.fingerprint, occurrence.dueAt].join('|');
}

/**
 * Delay before the next attempt after `attemptCount` attempts have failed,
 * or null when attempts are exhausted.
 */
export function computeRetryDelayMs(attemptCount, retryAfterMs = null) {
  if (attemptCount >= MAX_DELIVERY_ATTEMPTS) return null;
  const policyDelay = RETRY_DELAYS_MS[Math.min(Math.max(attemptCount, 1), RETRY_DELAYS_MS.length) - 1];
  if (!Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return policyDelay;
  return Math.max(policyDelay, Math.min(retryAfterMs, RETRY_AFTER_MAX_MS));
}

function safeFailureCode(code) {
  return typeof code === 'string' && SAFE_FAILURE_CODE.test(code) ? code : 'unspecified';
}

function channelThresholdMs(settings, channel) {
  const channelActivation = settings.activation.channels[channel];
  if (!channelActivation?.activatedAt || !settings.activation.activatedAt) return null;
  return Math.max(Date.parse(channelActivation.activatedAt), Date.parse(settings.activation.activatedAt));
}

function normalizeDestinations(destinations) {
  const normalized = {};
  for (const [channel, identity] of Object.entries(destinations ?? {})) {
    if (!RELEASE_NOTIFICATION_CHANNELS.includes(channel)) {
      throw new ReleaseNotificationDestinationError('unknown', 'channel');
    }
    if (identity === null || identity === undefined) continue;
    if (typeof identity !== 'string' || !DESTINATION_IDENTITY.test(identity)) {
      throw new ReleaseNotificationDestinationError(channel, 'identity');
    }
    normalized[channel] = identity;
  }
  return normalized;
}

function isProjectArchived(release) {
  return release.project_archived_at !== null || release.project_status === ARCHIVED_PROJECT_STATUS;
}

/**
 * Why a queued delivery must no longer be sent, or null when it is still
 * current. A missing runtime destination is not staleness: the channel may be
 * temporarily unconfigured, so the row is left alone rather than cancelled.
 * `delivery` carries its occurrence's reason, schedule fingerprint, and due
 * instants; `now` decides which phase is currently applicable.
 */
export function findStaleDeliveryReason({ delivery, release, settings, destinations, now }) {
  if (!release) return 'release_missing';
  if (release.published_date !== null) return 'release_published';
  if (release.archived_at !== null) return 'release_archived';
  if (isProjectArchived(release)) return 'project_archived';
  const schedule = resolveReleaseSchedule(release, settings);
  if (!schedule || schedule.fingerprint !== delivery.schedule_fingerprint) return 'schedule_changed';
  if (!settings.enabled) return 'notifications_disabled';
  if (!isReasonEnabled(settings, delivery.reason)) return 'notification_type_disabled';
  if (!settings.enabledChannels.includes(delivery.channel)) return 'channel_disabled';
  if (settings.activation.channels[delivery.channel].generation !== delivery.activation_generation) {
    return 'channel_generation_changed';
  }
  const timingCode = findTimingStaleReason(delivery, schedule, settings, now);
  if (timingCode) return timingCode;
  const destination = destinations[delivery.channel];
  if (destination !== undefined && destination !== delivery.destination_identity) return 'destination_changed';
  return null;
}

function toClaimedDelivery(row) {
  return {
    deliveryId: row.delivery_id,
    claimToken: row.claim_token,
    channel: row.channel,
    attempt: row.attempt_count,
    payload: JSON.parse(row.payload_json),
  };
}

/**
 * Transport-independent release-notification core: occurrence
 * materialization, per-channel fan-out, durable claims, retry state, and
 * stale-work invalidation. It performs no network I/O and owns no timers;
 * a runtime worker drives it and reports normalized transport outcomes.
 *
 * `destinations` arguments map channel -> opaque identity from
 * computeDestinationIdentity for channels whose runtime configuration is
 * ready. Channels absent from the map are never claimed; they are fanned out
 * only to the channel's established (previously ready, same activation
 * generation) identity, so a temporary outage pauses rather than loses work.
 */
export function createReleaseNotificationService({
  db,
  now = () => new Date(),
  releaseUrlForId = null,
  generateId = crypto.randomUUID,
} = {}) {
  if (!db) throw new Error('createReleaseNotificationService requires a db dependency.');
  const repository = createReleaseNotificationRepository(db);
  const settingsService = createReleaseNotificationSettingsService({
    appMetaRepository: createAppMetaRepository(db),
  });

  /**
   * `createdAt` is the occurrence's materialization instant, frozen here so
   * every attempt of every delivery renders the same body (never send time).
   */
  function buildPayload({ eventId, release, schedule, occurrence, createdAt }) {
    return {
      schemaVersion: RELEASE_NOTIFICATION_PAYLOAD_VERSION,
      eventId,
      type: occurrence.reason,
      createdAt,
      dueAt: occurrence.dueAt,
      release: {
        id: release.id,
        title: release.title,
        url: typeof releaseUrlForId === 'function' ? (releaseUrlForId(release.id) ?? null) : null,
      },
      project: { id: release.project_id, title: release.project_title },
      schedule: {
        plannedDate: schedule.plannedDate,
        plannedTime: schedule.plannedTime,
        effectiveTime: schedule.effectiveTime,
        usedDefaultTime: schedule.usedDefaultTime,
        timeZone: schedule.timeZone,
        scheduledAt: schedule.scheduledAt.toISOString(),
      },
    };
  }

  /**
   * Record the ready runtime identity of each active channel as its
   * established destination. When it differs from the recorded one the
   * destination genuinely changed, so unsent work for the old identity is
   * cancelled; the new destination only receives later occurrences.
   */
  function observeDestinations({ settings, destinations, nowIso }) {
    for (const [channel, destinationIdentity] of Object.entries(destinations)) {
      if (!isChannelActive(settings, channel)) continue;
      const established = repository.findChannelDestination(channel);
      if (established && established.destination_identity !== destinationIdentity) {
        repository.cancelUnsentForOtherDestinations({
          channel, destinationIdentity, code: 'destination_changed', now: nowIso,
        });
      }
      repository.upsertChannelDestination({
        channel,
        destinationIdentity,
        activationGeneration: settings.activation.channels[channel].generation,
        now: nowIso,
      });
    }
  }

  /**
   * Destination for a new child delivery: the ready runtime identity, or the
   * established identity of the current activation generation when runtime
   * configuration is only temporarily unavailable. Such a child stays
   * unclaimable until that same identity is ready again. A channel that never
   * had a destination in this generation gets no child (no backfill later).
   */
  function fanOutDestination(settings, destinations, channel) {
    if (destinations[channel]) return destinations[channel];
    const established = repository.findChannelDestination(channel);
    return established?.activation_generation === settings.activation.channels[channel].generation
      ? established.destination_identity
      : null;
  }

  /**
   * Insert-or-retrieve one logical occurrence. Children are created only when
   * the parent is created, so a channel enabled later is never backfilled
   * into an existing occurrence. A channel that already accepted this notice
   * under earlier timing settings is not sent it again.
   */
  function ensureOccurrence({ release, schedule, occurrence, settings, destinations, nowDate }) {
    return repository.transaction(() => {
      const occurrenceKey = buildOccurrenceKey(release.id, schedule, occurrence);
      const existing = repository.findOccurrenceByKey(occurrenceKey);
      if (existing) {
        return { created: false, occurrence: existing, deliveries: [], skippedChannels: [] };
      }

      const eventId = generateId();
      const nowIso = nowDate.toISOString();
      const inserted = repository.insertOccurrence({
        eventId,
        releaseId: release.id,
        occurrenceKey,
        reason: occurrence.reason,
        scheduleFingerprint: schedule.fingerprint,
        repeatDueAt: occurrence.repeatDueAt,
        dueAt: occurrence.dueAt,
        payloadJson: JSON.stringify(buildPayload({ eventId, release, schedule, occurrence, createdAt: nowIso })),
        createdAt: nowIso,
      });

      const deliveries = [];
      const skippedChannels = [];
      const dueMs = Date.parse(occurrence.dueAt);
      // Repeats are distinct notices per repeat instant; the one-shot phases
      // are one notice per schedule regardless of lead/grace timing.
      const alreadyAccepted = occurrence.reason === 'release.overdue_repeat'
        ? []
        : repository.listAcceptedChannelsForNotice({
          releaseId: release.id, reason: occurrence.reason, scheduleFingerprint: schedule.fingerprint,
        });
      for (const channel of RELEASE_NOTIFICATION_CHANNELS) {
        if (!isChannelActive(settings, channel)) continue;
        // Compare the nominal due time, never the materialization time, so a
        // late materialization cannot hand a pre-activation event to a new channel.
        const thresholdMs = channelThresholdMs(settings, channel);
        if (thresholdMs === null || dueMs < thresholdMs) continue;
        if (alreadyAccepted.includes(channel)) {
          skippedChannels.push({ channel, reason: 'already_accepted' });
          continue;
        }
        const destinationIdentity = fanOutDestination(settings, destinations, channel);
        if (!destinationIdentity) {
          skippedChannels.push({ channel, reason: 'destination_not_established' });
          continue;
        }
        deliveries.push(repository.insertDelivery({
          deliveryId: generateId(),
          eventId,
          channel,
          destinationIdentity,
          activationGeneration: settings.activation.channels[channel].generation,
          nextAttemptAt: nowIso,
          now: nowIso,
        }));
      }
      return { created: true, occurrence: inserted, deliveries, skippedChannels };
    });
  }

  function cancelStaleInTransaction({ destinations, releaseId, nowDate }) {
    const nowIso = nowDate.toISOString();
    const settings = settingsService.getSettings();
    const releases = new Map();
    const cancelled = [];
    for (const row of repository.listUnsentWithOccurrence({ releaseId })) {
      if (!releases.has(row.release_id)) releases.set(row.release_id, repository.findReleaseState(row.release_id));
      const code = findStaleDeliveryReason({
        delivery: row, release: releases.get(row.release_id), settings, destinations, now: nowDate,
      });
      if (code && repository.cancelDelivery({ deliveryId: row.delivery_id, code, now: nowIso })) {
        cancelled.push({ deliveryId: row.delivery_id, channel: row.channel, code });
      }
    }
    return cancelled;
  }

  function requireLimit(limit) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError('Release notification materialization limit must be a positive integer.');
    }
  }

  /**
   * Materialize releases whose current phase a later phase can supersede,
   * independently of the background sweep's position, so a short-lived
   * window cannot pass while the sweep is elsewhere. Per expiring phase the
   * repository returns at most `limit` releases whose schedule resolves, as
   * resolveReleaseSchedule would, inside that phase's current window, so rows
   * outside the phase never take a place on the page; the regular phase
   * resolution still makes the final decision. Releases without the exact
   * current occurrence (same schedule identity, reason, and due instant) go
   * first, then the soonest to expire, then by id, so an overfull window
   * keeps making progress and settled releases cannot crowd out new ones.
   *
   * `hasMore` is true when this pass created occurrences and unhandled
   * candidates may remain beyond it: some phase's page was full of unhandled
   * rows, or unhandled candidates were cut by the final `limit`. Materialized
   * releases rank as handled on the next pass, so an immediate repeat selects
   * the remaining ones. Requiring progress keeps a row that can never be
   * materialized from signalling backlog forever.
   */
  function materializeTimeCriticalOccurrences({ destinations, limit = TIME_CRITICAL_CANDIDATE_LIMIT } = {}) {
    requireLimit(limit);
    const nowDate = now();
    const normalizedDestinations = normalizeDestinations(destinations);
    const settings = settingsService.getSettings();
    if (!settings.enabled || !settings.activation.activatedAt) return { results: [], scanned: 0, hasMore: false };
    const nowMs = nowDate.getTime();
    const activatedMs = Date.parse(settings.activation.activatedAt);
    const candidates = new Map();
    let fullUnhandledPage = false;
    for (const phase of expiringPhases(settings)) {
      // Current for scheduled instants in (now - expires, now - due], as
      // resolveLatestPhase decides; an instant due before activation is
      // suppressed, so the range starts at the first due at or after it.
      const afterMs = Math.max(nowMs - phase.expiresOffsetMs, activatedMs - phase.dueOffsetMs - 1);
      const throughMs = nowMs - phase.dueOffsetMs;
      if (afterMs >= throughMs) continue;
      const wallClockRanges = scheduledWallClockRanges(afterMs, throughMs);
      if (wallClockRanges.length === 0) continue;
      const rows = repository.listTimeCriticalReleases({
        reason: phase.reason,
        dateOnlyTime: settings.dateOnlyTime,
        timeZone: effectiveTimeZone(),
        wallClockRanges,
        dueOffsetMs: phase.dueOffsetMs,
        limit,
      });
      // Unhandled rows sort first, so a full page ending unhandled may hide more.
      if (rows.length >= limit && rows[rows.length - 1].handled === false) fullUnhandledPage = true;
      for (const release of rows) {
        if (candidates.has(release.id)) continue;
        const schedule = resolveReleaseSchedule(release, settings);
        const occurrence = resolveDueOccurrence(schedule, settings, nowDate);
        if (occurrence?.reason !== phase.reason) continue;
        candidates.set(release.id, {
          release, schedule, occurrence, handled: release.handled,
          expiresMs: schedule.scheduledAt.getTime() + phase.expiresOffsetMs,
        });
      }
    }
    const ranked = [...candidates.values()]
      .sort((a, b) => (a.handled - b.handled) || (a.expiresMs - b.expiresMs) || (a.release.id - b.release.id));
    const selected = ranked.slice(0, limit);
    const cutUnhandled = ranked.length > limit && ranked[limit].handled === false;
    const results = [];
    if (selected.length === 0) return { results, scanned: 0, hasMore: false };
    repository.transaction(() => observeDestinations({
      settings, destinations: normalizedDestinations, nowIso: nowDate.toISOString(),
    }));
    for (const { release, schedule, occurrence } of selected) {
      const result = ensureOccurrence({
        release, schedule, occurrence, settings, destinations: normalizedDestinations, nowDate,
      });
      if (result.created) results.push(result);
    }
    return {
      results,
      scanned: selected.length,
      hasMore: results.length > 0 && (fullUnhandledPage || cutUnhandled),
    };
  }

  /**
   * Materialize the currently due occurrence (if any) for one bounded,
   * id-ordered batch of eligible releases after `afterReleaseId`.
   * `nextAfterReleaseId` continues the sweep on the next call; it is 0 when
   * this batch ended the sweep (known by look-ahead, so an exactly full final
   * batch still wraps immediately rather than after an empty batch).
   */
  function materializeDueOccurrenceBatch({
    destinations, afterReleaseId = 0, limit = MATERIALIZATION_CANDIDATE_LIMIT,
  } = {}) {
    requireLimit(limit);
    const nowDate = now();
    const normalizedDestinations = normalizeDestinations(destinations);
    const settings = settingsService.getSettings();
    if (!settings.enabled) return { results: [], scanned: 0, nextAfterReleaseId: 0 };
    repository.transaction(() => observeDestinations({
      settings, destinations: normalizedDestinations, nowIso: nowDate.toISOString(),
    }));
    const { releases: candidates, hasMore } = repository.listCandidateReleases({ afterReleaseId, limit });
    const results = [];
    for (const release of candidates) {
      const schedule = resolveReleaseSchedule(release, settings);
      const occurrence = resolveDueOccurrence(schedule, settings, nowDate);
      if (!occurrence) continue;
      const result = ensureOccurrence({
        release, schedule, occurrence, settings, destinations: normalizedDestinations, nowDate,
      });
      if (result.created) results.push(result);
    }
    return {
      results,
      scanned: candidates.length,
      nextAfterReleaseId: hasMore ? candidates[candidates.length - 1].id : 0,
    };
  }

  /**
   * Claim due deliveries (including rows whose lease expired) for channels
   * with a ready destination from one bounded candidate page of at most
   * `limit` rows. Each candidate is revalidated first; stale rows are
   * cancelled rather than claimed, and an expired lease that already used
   * the final attempt becomes terminal failed.
   *
   * `hasMore` is true when the candidate page was full, so more due rows may
   * lie behind it. `cleared` counts candidates that left the due set without
   * a claim (cancelled or terminal failed), so they can no longer block later
   * rows. `madeProgress` is true when the page claimed or cleared anything;
   * a full page that did neither gives no reason to look again at once.
   */
  function claimDueDeliveryPage({ destinations, limit = 10, leaseMs = DEFAULT_CLAIM_LEASE_MS } = {}) {
    const normalizedDestinations = normalizeDestinations(destinations);
    const channels = Object.keys(normalizedDestinations);
    if (channels.length === 0) return { claims: [], hasMore: false, madeProgress: false, cleared: 0 };
    const nowDate = now();
    const nowIso = nowDate.toISOString();
    const claimExpiresAt = new Date(nowDate.getTime() + leaseMs).toISOString();

    return repository.transaction(() => {
      const settings = settingsService.getSettings();
      observeDestinations({ settings, destinations: normalizedDestinations, nowIso });
      const releases = new Map();
      const claims = [];
      let cleared = 0;
      const candidates = repository.listClaimCandidates({ now: nowIso, channels, limit });
      for (const row of candidates) {
        if (row.state === 'sending' && row.attempt_count >= MAX_DELIVERY_ATTEMPTS) {
          const failed = repository.completeClaim({
            deliveryId: row.delivery_id, claimToken: row.claim_token, state: 'failed',
            failureCode: 'lease_expired', now: nowIso,
          });
          if (failed) cleared += 1;
          continue;
        }
        if (!releases.has(row.release_id)) releases.set(row.release_id, repository.findReleaseState(row.release_id));
        const code = findStaleDeliveryReason({
          delivery: row,
          release: releases.get(row.release_id),
          settings,
          destinations: normalizedDestinations,
          now: nowDate,
        });
        if (code) {
          if (repository.cancelDelivery({ deliveryId: row.delivery_id, code, now: nowIso })) cleared += 1;
          continue;
        }
        const updated = repository.claimDelivery({
          deliveryId: row.delivery_id,
          expectedState: row.state,
          expectedToken: row.claim_token,
          claimToken: generateId(),
          claimExpiresAt,
          now: nowIso,
        });
        if (updated) claims.push(toClaimedDelivery({ ...updated, payload_json: row.payload_json }));
      }
      return {
        claims,
        hasMore: candidates.length >= limit,
        madeProgress: claims.length > 0 || cleared > 0,
        cleared,
      };
    });
  }

  return {
    repository,
    settingsService,

    getSettings() {
      return settingsService.getSettings();
    },

    /**
     * Save preferences and, in the same transaction, cancel unsent work for
     * channels that stopped participating and reasons that were disabled.
     * Accepted and other terminal deliveries are never touched.
     */
    updateSettings(input) {
      const nowDate = now();
      const nowIso = nowDate.toISOString();
      return repository.transaction(() => {
        const result = settingsService.saveSettings(input, { now: nowDate });
        const code = result.changes.globallyDeactivated ? 'notifications_disabled' : 'channel_disabled';
        for (const channel of result.changes.deactivatedChannels) {
          repository.cancelUnsentByChannel({ channel, code, now: nowIso });
        }
        if (result.changes.disabledReasons.length > 0) {
          repository.cancelUnsentByReasons({
            reasons: result.changes.disabledReasons, code: 'notification_type_disabled', now: nowIso,
          });
        }
        return result;
      });
    },

    materializeDueOccurrenceBatch,
    materializeTimeCriticalOccurrences,

    /** Created occurrences for one materialization batch starting at the first release. */
    materializeDueOccurrences(options = {}) {
      return materializeDueOccurrenceBatch(options).results;
    },

    claimDueDeliveryPage,

    /** The claims from one bounded claim page (see claimDueDeliveryPage). */
    claimDueDeliveries(options = {}) {
      return claimDueDeliveryPage(options).claims;
    },

    /**
     * Final pre-send check for a claimed delivery. Stale work is cancelled.
     * An expired lease is refused without touching the row: another worker
     * may already be entitled to reclaim it, and recovery belongs to the
     * normal claim path. An unavailable destination is reported without
     * cancelling so the caller can relinquish the unsent claim. A valid result
     * records the dispatch instant, since the caller now contacts the provider.
     */
    revalidateClaim({ deliveryId, claimToken, destinations }) {
      const normalizedDestinations = normalizeDestinations(destinations);
      const nowDate = now();
      const nowIso = nowDate.toISOString();
      return repository.transaction(() => {
        const row = repository.findDeliveryWithOccurrence(deliveryId);
        if (!row || row.state !== 'sending' || row.claim_token !== claimToken) {
          return { valid: false, code: 'stale_claim', cancelled: false };
        }
        if (row.claim_expires_at <= nowIso) {
          return { valid: false, code: 'claim_expired', cancelled: false };
        }
        const code = findStaleDeliveryReason({
          delivery: row,
          release: repository.findReleaseState(row.release_id),
          settings: settingsService.getSettings(),
          destinations: normalizedDestinations,
          now: nowDate,
        });
        if (code) {
          repository.cancelDelivery({ deliveryId, code, now: nowIso });
          return { valid: false, code, cancelled: true };
        }
        if (!normalizedDestinations[row.channel]) {
          return { valid: false, code: 'destination_unavailable', cancelled: false };
        }
        repository.markClaimDispatched({ deliveryId, claimToken, now: nowIso });
        return { valid: true, code: null, cancelled: false };
      });
    },

    /**
     * Give back a claim whose send never began (dropped from a paused lane, or
     * final revalidation found its established destination temporarily
     * unavailable or its lease already expired). The delivery becomes pending and immediately claimable,
     * the attempt that claim consumed is returned, and no failure is
     * recorded. Only the current claim holder can relinquish; completed,
     * cancelled, or reclaimed rows are left untouched. Callers must never
     * relinquish after revalidateClaim authorized a send.
     */
    relinquishClaim({ deliveryId, claimToken }) {
      const nowIso = now().toISOString();
      return repository.transaction(() => {
        const delivery = repository.relinquishClaim({ deliveryId, claimToken, now: nowIso });
        return delivery
          ? { applied: true, code: null, delivery }
          : { applied: false, code: 'stale_claim', delivery: repository.findDelivery(deliveryId) ?? null };
      });
    },

    /**
     * Record a normalized transport outcome for a claimed delivery. Only the
     * holder of the current claim token can complete it; siblings are never
     * touched. Transient failures retry until MAX_DELIVERY_ATTEMPTS, then
     * become terminal failed.
     */
    completeDelivery({ deliveryId, claimToken, outcome, failureCode = null, retryAfterMs = null }) {
      if (!DELIVERY_OUTCOMES.includes(outcome)) {
        throw new Error(`Unknown release notification delivery outcome: ${outcome}.`);
      }
      const nowDate = now();
      const nowIso = nowDate.toISOString();
      return repository.transaction(() => {
        const row = repository.findDelivery(deliveryId);
        if (!row || row.state !== 'sending' || row.claim_token !== claimToken) {
          return { applied: false, code: 'stale_claim', delivery: row ?? null };
        }
        let update;
        if (outcome === 'accepted') {
          update = { state: 'accepted', acceptedAt: nowIso };
        } else {
          const code = safeFailureCode(failureCode);
          const delayMs = outcome === 'transient_failure'
            ? computeRetryDelayMs(row.attempt_count, retryAfterMs)
            : null;
          update = delayMs === null
            ? { state: 'failed', failureCode: code }
            : { state: 'pending', failureCode: code, nextAttemptAt: new Date(nowDate.getTime() + delayMs).toISOString() };
        }
        const delivery = repository.completeClaim({ deliveryId, claimToken, now: nowIso, ...update });
        return delivery
          ? { applied: true, code: null, delivery }
          : { applied: false, code: 'stale_claim', delivery: repository.findDelivery(deliveryId) ?? null };
      });
    },

    /**
     * Cancel unsent deliveries whose destination no longer matches the
     * runtime identity for their channel. Channels absent from the map are
     * left untouched; accepted and terminal rows are never replayed.
     */
    reconcileDestinations({ destinations } = {}) {
      const normalizedDestinations = normalizeDestinations(destinations);
      const nowIso = now().toISOString();
      return repository.transaction(() => {
        const cancelled = Object.fromEntries(
          Object.entries(normalizedDestinations).map(([channel, destinationIdentity]) => [
            channel,
            repository.cancelUnsentForOtherDestinations({
              channel, destinationIdentity, code: 'destination_changed', now: nowIso,
            }),
          ]),
        );
        observeDestinations({ settings: settingsService.getSettings(), destinations: normalizedDestinations, nowIso });
        return cancelled;
      });
    },

    /**
     * Revalidate every unsent delivery (optionally for one release) against
     * current release, project, settings, and destination state, cancelling
     * stale work. Intended after release publish/archive/schedule edits.
     */
    invalidateStaleDeliveries({ destinations, releaseId = null } = {}) {
      const normalizedDestinations = normalizeDestinations(destinations);
      const nowDate = now();
      return repository.transaction(() => cancelStaleInTransaction({
        destinations: normalizedDestinations, releaseId, nowDate,
      }));
    },
  };
}
