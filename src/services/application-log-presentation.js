// Shared Settings → Logs presentation helpers. The viewer and the TXT export
// both read records through formatLogRecord so they apply the same defensive
// sanitization to persisted log text and context.

const LOG_CONTEXT_SENSITIVE_KEY = /(?:authorization|cookie|credential|csrf|password|secret|session|token|watermark|(?:^|[_-])(?:request|body|headers?|options?)(?:[_-]|$)|(?:request|body|headers?|options?)(?:body|payload|data|headers?|options?)$)/i;
const LOG_SENSITIVE_TEXT = /(?:\b(?:proxy-)?authorization\s*:\s*(?:bearer|basic|digest)\s+\S+|\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{4,}|\b(?:api[ _-]?key|access[ _-]?token|refresh[ _-]?token|session(?:[ _-]?id)?|password|secret|credential)\b(?:\s*[:=]\s*|\s+[\"'(\[<]\s*)\S+|\b(?:cookie|set-cookie)\s*:\s*[^;\r\n]+)/i;
const LOG_GENERIC_SECRET_TEXT = /\b(?:token|csrf|auth(?:orization)?)\b\s*[:=]\s*\S+/i;
const LOG_ABSOLUTE_PATH = /(?:^|[\s"'`([{<=,:;])(?:[A-Za-z]:[\\/]|\\\\|\/(?!\/)(?!(?:div|script)>))/i;
const LOG_STACK_TRACE = /^[^\S\r\n]*(?:[A-Za-z_$][\w$]*(?:Error|Exception)|Error|Exception)\b[^\r\n]*(?:\r?\n[^\S\r\n]*at\s+[^\r\n]+)+/i;
const LOG_CONTEXT_MAX_ENTRIES = 100;
const LOG_CONTEXT_MAX_DEPTH = 4;

export function safeLogViewerText(value, fallback = '—') {
  if (typeof value !== 'string') return fallback;
  const normalized = value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return fallback;
  if (LOG_STACK_TRACE.test(value)) return '[redacted stack trace]';
  if (LOG_SENSITIVE_TEXT.test(normalized) || LOG_GENERIC_SECRET_TEXT.test(normalized)) return '[redacted secret]';
  if (LOG_ABSOLUTE_PATH.test(normalized)) return '[redacted path]';
  return normalized.slice(0, 2_000);
}

function isSafeWatermarkIdLogContextEntry(label, value) {
  return label.split(/[.\[\]]/).at(-1) === 'watermarkId'
    && typeof value === 'number'
    && Number.isSafeInteger(value)
    && value > 0;
}

function safeLogContextEntries(contextJson) {
  let context;
  try {
    context = JSON.parse(contextJson);
  } catch {
    return [];
  }
  if (!context || typeof context !== 'object' || Array.isArray(context)) return [];

  const entries = [];
  const visit = (value, label, depth) => {
    if (entries.length >= LOG_CONTEXT_MAX_ENTRIES) return;
    const safeLabel = LOG_ABSOLUTE_PATH.test(label) ? '[redacted key]' : safeLogViewerText(label, '[unavailable key]');
    if (LOG_CONTEXT_SENSITIVE_KEY.test(label.split(/[.\[\]]/).at(-1)) && !isSafeWatermarkIdLogContextEntry(label, value)) {
      entries.push({ label: safeLabel, value: '[redacted]' });
      return;
    }
    if (value === null || typeof value === 'boolean') {
      entries.push({ label: safeLabel, value: String(value) });
      return;
    }
    if (typeof value === 'number') {
      entries.push({ label: safeLabel, value: Number.isFinite(value) ? String(value) : '[invalid number]' });
      return;
    }
    if (typeof value === 'string') {
      entries.push({ label: safeLabel, value: safeLogViewerText(value, '') });
      return;
    }
    if (depth >= LOG_CONTEXT_MAX_DEPTH || !value || typeof value !== 'object') {
      entries.push({ label: safeLabel, value: '[truncated]' });
      return;
    }
    const children = Array.isArray(value) ? value.entries() : Object.entries(value);
    for (const [key, child] of children) {
      visit(child, Array.isArray(value) ? `${label}[${key}]` : `${label}.${key}`, depth + 1);
      if (entries.length >= LOG_CONTEXT_MAX_ENTRIES) return;
    }
  };

  for (const [key, value] of Object.entries(context)) {
    visit(value, key, 0);
    if (entries.length >= LOG_CONTEXT_MAX_ENTRIES) break;
  }
  return entries;
}

export const LOG_TIME_PRESETS = Object.freeze({
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
});
export const LOG_TIME_OPTIONS = Object.freeze([
  Object.freeze({ value: '', label: 'Any time' }),
  Object.freeze({ value: 'hour', label: 'Last hour' }),
  Object.freeze({ value: 'day', label: 'Last 24 hours' }),
  Object.freeze({ value: '7d', label: 'Last 7 days' }),
  Object.freeze({ value: '30d', label: 'Last 30 days' }),
]);

/**
 * One reusable timestamp formatter for a timezone and clock format. Building
 * Intl.DateTimeFormat is expensive, so callers formatting many records (the
 * TXT export) create one and pass it to formatLogRecord.
 */
export function createLogTimestampFormatter(timezone, clockFormat) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: clockFormat === '12h' ? 'numeric' : '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: clockFormat === '12h' ? 'h12' : 'h23',
    timeZone: timezone === 'local' ? 'UTC' : timezone,
    timeZoneName: 'short',
  });
  return (timestamp) => {
    const values = Object.fromEntries(formatter.formatToParts(timestamp)
      .filter(({ type }) => type !== 'literal')
      .map(({ type, value }) => [type, value]));
    const meridiem = clockFormat === '12h' ? ` ${/^a/i.test(values.dayPeriod) ? 'AM' : 'PM'}` : '';
    return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}${meridiem} ${values.timeZoneName}`;
  };
}

export function formatLogRecord(
  record,
  timezone,
  clockFormat,
  formatTimestamp = createLogTimestampFormatter(timezone, clockFormat)
) {
  const timestamp = new Date(record.occurred_at_ms);
  const timestampValid = !Number.isNaN(timestamp.getTime());
  return {
    id: record.id,
    timestampMs: timestampValid ? record.occurred_at_ms : null,
    timestampIso: timestampValid ? timestamp.toISOString() : null,
    timestamp: timestampValid ? formatTimestamp(timestamp) : 'Unknown time',
    level: safeLogViewerText(record.level),
    kind: safeLogViewerText(record.kind),
    subsystem: safeLogViewerText(record.subsystem),
    event: safeLogViewerText(record.event),
    message: safeLogViewerText(record.message),
    projectId: Number.isSafeInteger(record.project_id) && record.project_id > 0 ? record.project_id : null,
    correlationId: safeLogViewerText(record.correlation_id, null),
    contextEntries: safeLogContextEntries(record.context_json),
  };
}

/** One fixed lower bound for a relative time preset, or undefined for any time. */
export function resolveLogSinceMs(time, nowMs) {
  return time && Object.hasOwn(LOG_TIME_PRESETS, time) ? Math.max(0, nowMs - LOG_TIME_PRESETS[time]) : undefined;
}
