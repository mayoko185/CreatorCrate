import { RETRY_AFTER_MAX_MS } from '../release-notification-service.js';
import { accepted, hasControlCharacters, permanentFailure, transientFailure } from './shared.js';

/** Overall deadline for one HTTP delivery attempt, enforced by aborting the request. */
export const HTTP_REQUEST_TIMEOUT_MS = 15 * 1000;

/**
 * Validate a configured HTTP(S) endpoint. Plain HTTP is allowed for
 * self-hosted services on trusted networks. Userinfo and fragments are
 * rejected; query strings only where the caller allows them. Returns
 * { url } or { reason } where reason is 'missing' or 'invalid'. The URL is
 * never echoed in the reason.
 */
export function parseEndpointUrl(value, { allowQuery = true } = {}) {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    return { reason: 'missing' };
  }
  if (typeof value !== 'string') return { reason: 'invalid' };
  const trimmed = value.trim();
  if (/\s/.test(trimmed) || hasControlCharacters(trimmed) || trimmed.includes('#')) return { reason: 'invalid' };
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return { reason: 'invalid' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { reason: 'invalid' };
  if (!url.hostname || url.username !== '' || url.password !== '') return { reason: 'invalid' };
  if (!allowQuery && url.search !== '') return { reason: 'invalid' };
  return { url };
}

/** Readiness code for a failed parseEndpointUrl(), e.g. missing_server / invalid_server_url. */
export function endpointReason(result, field) {
  return result.reason === 'missing' ? `missing_${field}` : `invalid_${field}_url`;
}

const IMF_FIXDATE = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Epoch ms for a strict IMF-fixdate (the preferred HTTP-date form), or null.
 * Built with Date.UTC and checked field-by-field so impossible dates such as
 * 30 Feb are rejected instead of normalized; the weekday must also agree.
 * The obsolete RFC 850 and asctime forms are not supported.
 */
function parseImfFixdate(value) {
  const match = IMF_FIXDATE.exec(value);
  if (!match) return null;
  const [, weekday, dayText, monthText, yearText, hourText, minuteText, secondText] = match;
  const [day, year, hour, minute, second] = [dayText, yearText, hourText, minuteText, secondText].map(Number);
  const month = MONTHS.indexOf(monthText);
  if (hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(Date.UTC(year, month, day, hour, minute, second));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day
    || WEEKDAYS[date.getUTCDay()] !== weekday) {
    return null;
  }
  return date.getTime();
}

const RETRY_AFTER_MAX_SECONDS_DIGITS = String(Math.ceil(RETRY_AFTER_MAX_MS / 1000)).length;

/**
 * Bounded Retry-After hint in milliseconds, or null. Accepts delta-seconds
 * or a valid IMF-fixdate; values beyond WP1's Retry-After ceiling are clamped.
 * Delta-seconds with more significant digits than the ceiling are capped
 * before any numeric conversion, so arbitrarily long values cannot overflow.
 */
export function parseRetryAfterMs(headerValue, nowMs = Date.now()) {
  if (typeof headerValue !== 'string') return null;
  const value = headerValue.trim();
  let ms;
  if (/^\d+$/.test(value)) {
    const digits = value.replace(/^0+/, '');
    if (digits.length > RETRY_AFTER_MAX_SECONDS_DIGITS) return RETRY_AFTER_MAX_MS;
    ms = Number(digits) * 1000;
  } else {
    const at = parseImfFixdate(value);
    if (at === null) return null;
    ms = at - nowMs;
  }
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.min(Math.ceil(ms), RETRY_AFTER_MAX_MS);
}

/** Map an HTTP status to a normalized outcome (unless the provider needs more). */
export function classifyHttpStatus(status, retryAfterHeader, nowMs = Date.now()) {
  if (status >= 200 && status < 300) return accepted();
  if (status >= 300 && status < 400) return permanentFailure('redirect_refused');
  if (status === 408) return transientFailure('timeout');
  if (status === 429) return transientFailure('rate_limited', parseRetryAfterMs(retryAfterHeader, nowMs));
  if (status >= 500 && status < 600) {
    return transientFailure('provider_unavailable', parseRetryAfterMs(retryAfterHeader, nowMs));
  }
  if (status === 401 || status === 403) return permanentFailure('authentication_failed');
  return permanentFailure('rejected');
}

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.name === 'TimeoutError';
}

/**
 * POST a JSON body once. Redirects are never followed (credentials must not
 * reach another destination), the request is aborted at the deadline, and
 * the response body is discarded unread so no upstream content is returned
 * or buffered. Thrown errors are reduced to safe codes; their messages are
 * never surfaced because they may quote the request URL.
 */
export async function postJson({
  url,
  body,
  headers = {},
  fetchImpl = globalThis.fetch,
  timeoutMs = HTTP_REQUEST_TIMEOUT_MS,
  now = () => Date.now(),
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'manual',
      signal: controller.signal,
    });
    const outcome = classifyHttpStatus(response.status, response.headers?.get?.('retry-after') ?? null, now());
    try {
      await response.body?.cancel();
    } catch {
      // The outcome is already known; a failed discard changes nothing.
    }
    return outcome;
  } catch (error) {
    if (controller.signal.aborted || isAbortError(error)) return transientFailure('timeout');
    return transientFailure('network_error');
  } finally {
    clearTimeout(timer);
  }
}
