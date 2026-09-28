import { RELEASE_NOTIFICATION_CHANNELS } from './release-notification-settings-service.js';

export const RELEASE_NOTIFICATION_RECENT_RESULTS_KEY = 'release_notifications.recent_results';
export const RELEASE_NOTIFICATION_RECENT_RESULTS_VERSION = 1;
export const RECENT_RESULT_KINDS = Object.freeze(['test', 'release']);
export const RECENT_RESULT_STATES = Object.freeze(['accepted', 'retry_scheduled', 'failed', 'cancelled']);
/** Stored in place of any code outside RECENT_RESULT_CODES. */
export const UNSPECIFIED_RESULT_CODE = 'unspecified';
/**
 * Every code a recent result may persist: the fixed WP2 transport outcome
 * codes plus the WP1 cancellation/lease codes Settings explains. Anything
 * else, however harmless its characters, is stored as UNSPECIFIED_RESULT_CODE.
 */
export const RECENT_RESULT_CODES = Object.freeze([
  'authentication_failed',
  'rejected',
  'tls_failed',
  'provider_unavailable',
  'smtp_temporary_failure',
  'rate_limited',
  'timeout',
  'dns_error',
  'network_error',
  'protocol_error',
  'redirect_refused',
  'invalid_configuration',
  'invalid_payload',
  'notifications_disabled',
  'channel_disabled',
  'notification_type_disabled',
  'lease_expired',
  'unexpected_error',
]);
const ISO_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/;

export class ReleaseNotificationRecentResultError extends Error {
  constructor(field) {
    super(`Invalid release notification recent result: ${field}.`);
    this.name = 'ReleaseNotificationRecentResultError';
    this.field = field;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Accept a Date or a UTC ISO-8601 string whose parsed UTC fields round-trip,
 * so an impossible date such as 30 Feb is rejected rather than stored or
 * shown as the normalized neighbouring day.
 */
function toIsoTimestamp(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  if (typeof value !== 'string') return undefined;
  const match = ISO_UTC.exec(value);
  if (!match) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const roundTrips = date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day
    && date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second;
  return roundTrips ? value : undefined;
}

function emptyResults() {
  return Object.fromEntries(RELEASE_NOTIFICATION_CHANNELS.map((channel) => [channel, null]));
}

/**
 * Rebuild one entry from the fixed field set only. Anything else a caller or
 * a stored document carries (provider responses, messages, credentials) is
 * dropped rather than persisted or rendered.
 */
function sanitizeEntry(entry) {
  if (!isPlainObject(entry)) return null;
  const at = toIsoTimestamp(entry.at);
  if (!at || !RECENT_RESULT_KINDS.includes(entry.kind) || !RECENT_RESULT_STATES.includes(entry.state)) return null;
  const code = entry.state === 'accepted' ? null : (RECENT_RESULT_CODES.includes(entry.code)
    ? entry.code
    : UNSPECIFIED_RESULT_CODE);
  const nextRetryAt = entry.state === 'retry_scheduled' ? (toIsoTimestamp(entry.nextRetryAt) ?? null) : null;
  return { at, kind: entry.kind, state: entry.state, code, nextRetryAt };
}

function readDocument(value) {
  let document;
  try {
    document = typeof value === 'string' ? JSON.parse(value) : undefined;
  } catch {
    document = undefined;
  }
  const results = emptyResults();
  if (!isPlainObject(document) || document.version !== RELEASE_NOTIFICATION_RECENT_RESULTS_VERSION
    || !isPlainObject(document.channels)) {
    return results;
  }
  for (const channel of RELEASE_NOTIFICATION_CHANNELS) {
    results[channel] = sanitizeEntry(document.channels[channel]);
  }
  return results;
}

/**
 * Map a normalized transport outcome ({ outcome, failureCode }) to a recent
 * result state. A transient failure is only "retry scheduled" when the caller
 * knows the retry instant; a one-off test attempt is simply failed.
 */
export function recentResultFromOutcome(result, { kind, at, nextRetryAt = null } = {}) {
  const outcome = result?.outcome;
  if (outcome === 'accepted') return { kind, at, state: 'accepted' };
  if (outcome === 'transient_failure' && toIsoTimestamp(nextRetryAt)) {
    return { kind, at, state: 'retry_scheduled', code: result.failureCode, nextRetryAt };
  }
  if (outcome === 'transient_failure' || outcome === 'permanent_failure') {
    return { kind, at, state: 'failed', code: result.failureCode };
  }
  return { kind, at, state: 'failed', code: 'unexpected_error' };
}

/**
 * The single most recent attempt per channel, for Settings display only.
 * This is not a history: each record replaces that channel's previous entry
 * and never touches another channel's. Scheduled deliveries and test sends
 * share the same store so the page always shows the latest attempt.
 */
export function createReleaseNotificationRecentResultService({ appMetaRepository } = {}) {
  if (!appMetaRepository || typeof appMetaRepository.getValue !== 'function'
    || typeof appMetaRepository.setValue !== 'function') {
    throw new Error('createReleaseNotificationRecentResultService requires an appMetaRepository dependency.');
  }

  function getRecentResults() {
    return readDocument(appMetaRepository.getValue(RELEASE_NOTIFICATION_RECENT_RESULTS_KEY));
  }

  /**
   * Replace one channel's recent result. The read-modify-write is synchronous
   * against SQLite, so no other request can interleave between the read and
   * the write.
   */
  function recordResult(channel, entry) {
    if (!RELEASE_NOTIFICATION_CHANNELS.includes(channel)) throw new ReleaseNotificationRecentResultError('channel');
    const sanitized = sanitizeEntry(entry);
    if (!sanitized) throw new ReleaseNotificationRecentResultError('entry');
    const channels = { ...getRecentResults(), [channel]: sanitized };
    appMetaRepository.setValue(RELEASE_NOTIFICATION_RECENT_RESULTS_KEY, JSON.stringify({
      version: RELEASE_NOTIFICATION_RECENT_RESULTS_VERSION,
      channels,
    }));
    return sanitized;
  }

  return { getRecentResults, recordResult };
}
