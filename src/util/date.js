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
