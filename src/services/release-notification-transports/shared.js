/**
 * Small release-notification-specific helpers shared by the four fixed
 * transport senders: normalized outcomes, test payloads, and the human
 * wording used by email, ntfy, and Gotify. Webhook JSON is built separately
 * from structured payload fields, never from this wording.
 */

export const TEST_NOTIFICATION_TYPE = 'notification.test';

const RELEASE_NOTIFICATION_TYPES = Object.freeze([
  'release.advance',
  'release.scheduled',
  'release.overdue',
  'release.overdue_repeat',
]);

const REASON_LABELS = Object.freeze({
  'release.advance': 'Upcoming',
  'release.scheduled': 'Scheduled',
  'release.overdue': 'Overdue',
  'release.overdue_repeat': 'Still overdue',
  [TEST_NOTIFICATION_TYPE]: 'Test notification',
});

const REASON_SENTENCES = Object.freeze({
  'release.advance': 'This release is coming up soon.',
  'release.scheduled': 'This release has reached its scheduled time.',
  'release.overdue': 'This release is past its scheduled time and has not been published.',
  'release.overdue_repeat': 'Reminder: this release is still overdue and has not been published.',
});

const TEST_MESSAGE = 'This is a test notification from CreatorCrate. '
  + 'If you can read this, CreatorCrate can deliver release notifications to this channel.';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const CONTROL_CHARACTER_RUNS = /[\u0000-\u001f\u007f]+/g;
const MAX_TITLE_TEXT = 200;
const ISO_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/;

// ---------------------------------------------------------------------------
// Normalized outcomes. Property names match WP1's completeDelivery() input.

export function accepted() {
  return Object.freeze({ outcome: 'accepted' });
}

export function transientFailure(failureCode, retryAfterMs = null) {
  return Number.isSafeInteger(retryAfterMs) && retryAfterMs > 0
    ? Object.freeze({ outcome: 'transient_failure', failureCode, retryAfterMs })
    : Object.freeze({ outcome: 'transient_failure', failureCode });
}

export function permanentFailure(failureCode) {
  return Object.freeze({ outcome: 'permanent_failure', failureCode });
}

export function ready({ authConfigured = false } = {}) {
  return Object.freeze({ ready: true, reason: null, authConfigured });
}

export function notReady(reason, { authConfigured = false } = {}) {
  return Object.freeze({ ready: false, reason, authConfigured });
}

// ---------------------------------------------------------------------------
// Config value helpers.

export function hasControlCharacters(value) {
  return CONTROL_CHARACTERS.test(value);
}

/** Trimmed non-empty string, or null when absent/blank. */
export function optionalText(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Bearer/application tokens: printable, no whitespace, header-safe. */
export function isValidToken(value) {
  return typeof value === 'string' && /^[\x21-\x7e]{1,4096}$/.test(value);
}

// ---------------------------------------------------------------------------
// Payloads.

/**
 * A clearly marked test notification that needs no persisted occurrence.
 * The caller supplies stable identifiers; the matching delivery context
 * must carry its own deliveryId. createdAt is fixed here, once, so any retry
 * of this same payload renders the same body.
 */
export function createTestNotificationPayload({ eventId, createdAt = new Date().toISOString() }) {
  if (typeof eventId !== 'string' || eventId.trim() === '') {
    throw new Error('A test notification requires an eventId.');
  }
  if (!isIsoTimestamp(createdAt)) throw new Error('A test notification requires a valid createdAt.');
  return Object.freeze({
    schemaVersion: 1,
    eventId,
    type: TEST_NOTIFICATION_TYPE,
    createdAt,
    dueAt: null,
    release: null,
    project: null,
    schedule: null,
  });
}

/**
 * A UTC ISO-8601 instant as produced by Date#toISOString(). The parsed UTC
 * fields must match the supplied ones, so impossible dates such as 30 Feb or
 * 24:00 are rejected instead of being normalized into a different instant.
 */
export function isIsoTimestamp(value) {
  if (typeof value !== 'string') return false;
  const match = ISO_UTC.exec(value);
  if (!match) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day
    && date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second;
}

export function isTestPayload(payload) {
  return payload?.type === TEST_NOTIFICATION_TYPE;
}

/** Minimal structural check before any wording or request body is built. */
export function isSupportedPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (typeof payload.eventId !== 'string' || payload.eventId === '') return false;
  if (isTestPayload(payload)) return true;
  return RELEASE_NOTIFICATION_TYPES.includes(payload.type)
    && payload.release && typeof payload.release === 'object'
    && payload.project && typeof payload.project === 'object'
    && payload.schedule && typeof payload.schedule === 'object';
}

export function readDeliveryId(context) {
  const deliveryId = context?.deliveryId;
  return typeof deliveryId === 'string' && /^[\x21-\x7e]{1,200}$/.test(deliveryId) ? deliveryId : null;
}

// ---------------------------------------------------------------------------
// Human wording.

function singleLine(value, maxLength = MAX_TITLE_TEXT) {
  const text = String(value ?? '').replace(CONTROL_CHARACTER_RUNS, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

export function reasonLabel(type) {
  return REASON_LABELS[type] ?? 'Notification';
}

/** Short title, e.g. "Overdue: Release title" or "Test notification". */
export function formatTitle(payload) {
  if (isTestPayload(payload)) return reasonLabel(payload.type);
  return `${reasonLabel(payload.type)}: ${singleLine(payload.release.title) || 'Untitled release'}`;
}

function formatPlanned(schedule) {
  return schedule.usedDefaultTime
    ? `${schedule.plannedDate} (no time set; using ${schedule.effectiveTime})`
    : `${schedule.plannedDate} ${schedule.effectiveTime}`;
}

/** Concise body for push-style channels (ntfy, Gotify). */
export function formatShortMessage(payload) {
  if (isTestPayload(payload)) return TEST_MESSAGE;
  const { project, release, schedule } = payload;
  return [
    REASON_SENTENCES[payload.type],
    `Release: ${singleLine(release.title)}`,
    `Project: ${singleLine(project.title)}`,
    `Scheduled: ${formatPlanned(schedule)} (${schedule.timeZone})`,
  ].join('\n');
}

/** Full plain-text body for email. */
export function formatPlainTextMessage(payload) {
  if (isTestPayload(payload)) {
    return [
      'CreatorCrate test notification',
      '',
      TEST_MESSAGE,
      '',
      'No release is associated with this message.',
      '',
    ].join('\n');
  }
  const { project, release, schedule } = payload;
  const lines = [
    'CreatorCrate release notification',
    '',
    `Reason: ${reasonLabel(payload.type)}`,
    REASON_SENTENCES[payload.type],
    '',
    `Project: ${singleLine(project.title)} (ID ${project.id})`,
    `Release: ${singleLine(release.title)} (ID ${release.id})`,
    `Planned: ${formatPlanned(schedule)}`,
    `Time zone: ${schedule.timeZone}`,
    `Scheduled instant: ${schedule.scheduledAt}`,
  ];
  if (typeof release.url === 'string' && release.url !== '') lines.push(`Link: ${release.url}`);
  lines.push('');
  return lines.join('\n');
}

/** Release link from a payload, or null. */
export function releaseUrl(payload) {
  const url = payload?.release?.url;
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
}
