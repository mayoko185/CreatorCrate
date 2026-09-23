/**
 * Application timezone policy — single source of truth for "today".
 *
 * The dashboard and other workflow consumers must classify releases against
 * the local calendar date, not UTC. `Date.prototype.toISOString()` always
 * serialises in UTC, so a release planned for "today" near local midnight
 * can be misclassified as overdue (or upcoming) when the local date and the
 * UTC date disagree. This helper formats a Date using its LOCAL year/month/
 * day so the dashboard sees a stable, application-local date boundary.
 *
 * If a real timezone policy is ever introduced (e.g. a server-side setting
 * or per-user preference), this is the one place that needs to change.
 */

/**
 * Format a Date as a YYYY-MM-DD string using the date's local year, month,
 * and day. Pure function of its input — useful for tests that need to pin
 * down a specific moment.
 *
 * @param {Date} date
 * @returns {string} ISO-style date (YYYY-MM-DD) in local time
 */
export function formatLocalDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * The application's current local calendar date as a YYYY-MM-DD string.
 * Callers that need to thread a single `today` value through several
 * date-sensitive operations should call this once and pass the result to
 * every consumer — repository methods do not compute today themselves.
 *
 * @returns {string} today's date in YYYY-MM-DD (local time)
 */
export function getLocalTodayIso() {
  return formatLocalDate(new Date());
}

/**
 * Format an ISO timestamp as a short relative-time label ("2h ago") for
 * compact display contexts (e.g. the Settings overview stat strip) where a
 * full timestamp would wrap awkwardly. Falls back to a plain local date once
 * the gap exceeds 30 days, since "47d ago" stops being more readable than a
 * date. Pure function of its inputs — `now` is injectable for tests.
 *
 * @param {string} isoString
 * @param {Date} [now]
 * @returns {string}
 */
export function formatRelativeTime(isoString, now = new Date()) {
  const then = new Date(isoString);
  const diffMs = now.getTime() - then.getTime();
  if (Number.isNaN(diffMs)) return isoString;
  if (diffMs < 0) return formatLocalDate(then);

  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diffMs < minute) return 'just now';
  if (diffMs < hour) return `${Math.floor(diffMs / minute)}m ago`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)}h ago`;
  if (diffMs < 30 * day) return `${Math.floor(diffMs / day)}d ago`;
  return formatLocalDate(then);
}

function formatHoursMinutes(hours, minutes, clockFormat) {
  if (clockFormat !== '12h' && clockFormat !== '24h') {
    throw new RangeError('Clock format must be 12h or 24h.');
  }

  const minute = String(minutes).padStart(2, '0');
  if (clockFormat === '24h') {
    return `${String(hours).padStart(2, '0')}:${minute}`;
  }

  const hour = hours % 12 || 12;
  return `${hour}:${minute} ${hours < 12 ? 'AM' : 'PM'}`;
}

/**
 * Format a Date using its local hours and minutes. Callers pass the resolved
 * request clock format; omitting it retains the existing 24-hour output.
 *
 * @param {Date} date
 * @param {'12h'|'24h'} [clockFormat]
 * @returns {string}
 */
export function formatLocalTime(date, clockFormat = '24h') {
  return formatHoursMinutes(date.getHours(), date.getMinutes(), clockFormat);
}

/**
 * Format a stored HH:mm clock value without assigning it a timezone. Invalid
 * values are returned unchanged, as with formatRelativeTime's input fallback.
 *
 * @param {string} value
 * @param {'12h'|'24h'} [clockFormat]
 * @returns {string}
 */
export function formatStoredTime(value, clockFormat = '24h') {
  if (clockFormat !== '12h' && clockFormat !== '24h') {
    throw new RangeError('Clock format must be 12h or 24h.');
  }

  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    return value;
  }

  return formatHoursMinutes(Number(value.slice(0, 2)), Number(value.slice(3, 5)), clockFormat);
}

/** Format SQLite datetime('now') text without converting its UTC clock to local time. */
export function formatSqliteTimestamp(value, clockFormat = '24h') {
  if (clockFormat !== '12h' && clockFormat !== '24h') {
    throw new RangeError('Clock format must be 12h or 24h.');
  }

  const match = typeof value === 'string'
    ? value.match(/^(\d{4}-\d{2}-\d{2}) ((?:[01]\d|2[0-3]):[0-5]\d):([0-5]\d)$/)
    : null;
  if (!match || clockFormat === '24h') return value;

  const clock = formatStoredTime(match[2], clockFormat)
    .replace(/ (AM|PM)$/, `:${match[3]} $1`);
  return `${match[1]} ${clock}`;
}

/** Preserve an ISO UTC timestamp's date, seconds, and UTC meaning in display text. */
export function formatIsoTimestamp(value, clockFormat = '24h') {
  if (clockFormat !== '12h' && clockFormat !== '24h') {
    throw new RangeError('Clock format must be 12h or 24h.');
  }
  const match = typeof value === 'string'
    ? value.match(/^(\d{4}-\d{2}-\d{2})T((?:[01]\d|2[0-3]):[0-5]\d):([0-5]\d)(\.\d+)?Z$/)
    : null;
  if (!match || clockFormat === '24h') return value;
  const clock = formatStoredTime(match[2], clockFormat)
    .replace(/ (AM|PM)$/, `:${match[3]}${match[4] || ''} $1`);
  return `${match[1]}T${clock} Z`;
}
