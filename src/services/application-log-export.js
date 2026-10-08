import {
  LOG_TIME_OPTIONS,
  createLogTimestampFormatter,
  formatLogRecord,
  resolveLogSinceMs,
  safeLogViewerText,
} from './application-log-presentation.js';

export const APPLICATION_LOG_EXPORT_MAX_BYTES = 20 * 1024 * 1024;

export class ApplicationLogExportError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = 'ApplicationLogExportError';
    this.code = code;
  }
}

const ENTRY_SEPARATOR = '-'.repeat(72);
const FILTER_FIELDS = Object.freeze([
  Object.freeze({ field: 'level', label: 'Level', any: 'Any level' }),
  Object.freeze({ field: 'kind', label: 'Kind', any: 'Any kind' }),
  Object.freeze({ field: 'subsystem', label: 'Subsystem', any: 'Any subsystem' }),
]);
const PRIVACY_NOTICE = [
  'PRIVACY NOTICE',
  'Credentials, tokens, API keys, credential-bearing URLs, email addresses, file paths,',
  'stack traces, and known sensitive fields were redacted on a best-effort basis.',
  'Automatic redaction cannot recognize every sensitive value.',
  'Review this file before sharing it.',
];

// Export-only redaction layered on top of the viewer's formatLogRecord output.
// The viewer already replaces whole values that look like secrets, absolute
// paths, or stack traces; these rules additionally mask recognizable values
// inside text the viewer keeps, so error codes and identifiers survive.
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi;
const URL_QUERY_PARAM = /([?&#])([^=&#\s]+)=([^&#\s]+)/g;
const URL_SENSITIVE_PARAM_NAME = /(?:^code$|^sig$|key$|token$|signature$|secret$|pass(?:word|wd)?$|auth$|credential$|session(?:[_-]?id)?$)/i;
const FILE_URL = /\bfile:\/\/\S*/gi;
// Path segments may contain single spaces ("Secret Art"). The first segment of
// a relative path may not, so a match cannot swallow the preceding words, and a
// spaced file name is limited to a few words so trailing prose survives.
const PATH_WORD = String.raw`[^\s\\/"'<>|:*?,;]+`;
const PATH_SEGMENT = String.raw`${PATH_WORD}(?: ${PATH_WORD})*`;
const PATH_FILE_NAME = String.raw`${PATH_WORD}(?: ${PATH_WORD}){0,4}\.[A-Za-z0-9]{1,10}(?![\w.\\/-])`;
const HOME_PATH = new RegExp(String.raw`(?<![\w~])~[\\/](?:${PATH_SEGMENT}[\\/])*(?:${PATH_FILE_NAME}|\S*)`, 'g');
const RELATIVE_FILE_PATH = new RegExp(
  String.raw`(?<![\w:/\\.%~-])(?:\.{1,2}[\\/])?${PATH_WORD}[\\/](?:${PATH_SEGMENT}[\\/])*${PATH_FILE_NAME}`,
  'g'
);
// Quoted credential assignments the viewer keeps, such as JSON fragments in
// provider responses: {"password": "x"}, 'api_key':'x', "token"=x.
const QUOTED_CREDENTIAL = /(["'])([\w.-]*?(?:pass(?:word|wd|phrase)|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?|authorization|cookie|session[_-]?id))\1(\s*[:=]\s*)(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;}\]]+)/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const KNOWN_TOKEN = /\b(?:(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|eyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,})/g;
const SENSITIVE_CONTEXT_WORDS = new Set([
  'path', 'paths', 'filepath', 'dir', 'dirs', 'directory', 'directories', 'folder', 'folders',
  'file', 'files', 'filename', 'filenames', 'location', 'cwd', 'home',
  'email', 'emails', 'username', 'env', 'environment', 'config', 'configuration', 'stack', 'stacktrace',
  'apikey', 'apikeys', 'passwd', 'pwd', 'passphrase',
]);
const SENSITIVE_CONTEXT_PAIRS = new Set([
  'file_name', 'file_names', 'user_name', 'e_mail', 'stack_trace',
  'api_key', 'api_keys', 'access_key', 'access_keys', 'secret_key', 'private_key', 'signing_key',
  'client_key', 'auth_key', 'encryption_key', 'pass_phrase',
]);

function redactExportText(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(URL_CREDENTIALS, '$1[redacted credentials]@')
    .replace(URL_QUERY_PARAM, (match, prefix, name) => (
      URL_SENSITIVE_PARAM_NAME.test(name) ? `${prefix}${name}=[redacted]` : match
    ))
    .replace(QUOTED_CREDENTIAL, '$1$2$1$3[redacted]')
    .replace(FILE_URL, '[redacted path]')
    .replace(KNOWN_TOKEN, '[redacted credential]')
    .replace(EMAIL, '[redacted email]')
    .replace(HOME_PATH, '[redacted path]')
    .replace(RELATIVE_FILE_PATH, '[redacted path]');
}

function isSensitiveContextKey(key) {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[_\s-]+/).filter(Boolean);
  return SENSITIVE_CONTEXT_WORDS.has(words.at(-1)) || SENSITIVE_CONTEXT_PAIRS.has(words.slice(-2).join('_'));
}

// Flattened labels such as "provider.apiKey.value" or "keys[0].api_key" are
// sensitive when any ancestor key is, so object- and array-valued credentials
// cannot leak through innocuous descendant names.
function isSensitiveContextLabel(label) {
  return label.split(/[.\[\]]/).some((segment) => segment && !/^\d+$/.test(segment) && isSensitiveContextKey(segment));
}

function exportText(value) {
  return redactExportText(safeLogViewerText(value));
}

function formatFilterLines(filters, sinceMs) {
  const lines = FILTER_FIELDS.map(({ field, label, any }) => {
    const value = typeof filters[field] === 'string' && filters[field] ? exportText(filters[field]) : null;
    return `  ${label}: ${value ?? `${any} (not filtered)`}`;
  });
  const timeOption = LOG_TIME_OPTIONS.find(({ value }) => value && value === filters.time);
  lines.push(sinceMs === undefined
    ? '  Time range: Any time (not filtered)'
    : `  Time range: ${timeOption.label} (entries at or after ${new Date(sinceMs).toISOString()})`);
  return lines;
}

function formatEntry(row, position, formatTimestamp) {
  const record = formatLogRecord(row, 'UTC', '24h', formatTimestamp);
  const lines = [
    ENTRY_SEPARATOR,
    `#${position}  ${record.timestampIso ?? 'Unknown time'}  ${redactExportText(record.level).toUpperCase()}`,
    `Kind: ${redactExportText(record.kind)}`,
    `Subsystem: ${redactExportText(record.subsystem)}`,
    `Event: ${redactExportText(record.event)}`,
    `Message: ${redactExportText(record.message)}`,
    `Entry ID: ${Number.isSafeInteger(record.id) ? record.id : 'unavailable'}`,
  ];
  if (record.correlationId) lines.push(`Correlation ID: ${redactExportText(record.correlationId)}`);
  if (record.projectId) lines.push(`Project ID: ${record.projectId}`);
  if (record.contextEntries.length > 0) {
    lines.push('Context:');
    for (const { label, value } of record.contextEntries) {
      const safeValue = isSensitiveContextLabel(label) ? '[redacted]' : redactExportText(value);
      lines.push(`  ${redactExportText(label)}: ${safeValue === '' ? '(empty)' : safeValue}`);
    }
  }
  return { text: lines.join('\n') + '\n', timestampMs: record.timestampMs };
}

function tooLarge(maxBytes) {
  return new ApplicationLogExportError(
    `The logs export would exceed ${maxBytes} bytes. Narrow the filters and try again.`,
    { code: 'EXPORT_TOO_LARGE' }
  );
}

/**
 * Build the complete UTF-8 TXT logs export for already-validated Settings →
 * Logs filters. Nothing is returned unless the whole export fits: it throws
 * ApplicationLogExportError code EXPORT_TOO_LARGE above `maxBytes`, and the
 * repository's ApplicationLogRepositoryError code EXPORT_LIMIT_EXCEEDED when
 * too many records match.
 *
 * @param {{
 *   applicationLogRepository: {forEachExportRecord: Function},
 *   filters?: {level?: string, kind?: string, subsystem?: string, time?: string},
 *   now?: number,
 *   maxBytes?: number,
 * }} options `maxBytes` exists for tests; callers use the default.
 * @returns {{content: Buffer, byteLength: number, entryCount: number, generatedAt: string}}
 */
export function buildApplicationLogExport({
  applicationLogRepository,
  filters = {},
  now = Date.now(),
  maxBytes = APPLICATION_LOG_EXPORT_MAX_BYTES,
}) {
  const generatedAt = new Date(now).toISOString();
  const sinceMs = resolveLogSinceMs(filters.time, now);
  const repositoryFilters = {};
  for (const { field } of FILTER_FIELDS) {
    if (typeof filters[field] === 'string' && filters[field]) repositoryFilters[field] = filters[field];
  }
  if (sinceMs !== undefined) repositoryFilters.sinceMs = sinceMs;

  const formatTimestamp = createLogTimestampFormatter('UTC', '24h');
  const entries = [];
  let entryBytes = 0;
  let newestMs = null;
  let oldestMs = null;
  const { count } = applicationLogRepository.forEachExportRecord(repositoryFilters, (row, index) => {
    const entry = formatEntry(row, index + 1, formatTimestamp);
    entryBytes += Buffer.byteLength(entry.text, 'utf8');
    if (entryBytes > maxBytes) throw tooLarge(maxBytes);
    entries.push(entry.text);
    if (entry.timestampMs !== null) {
      newestMs = newestMs === null ? entry.timestampMs : Math.max(newestMs, entry.timestampMs);
      oldestMs = oldestMs === null ? entry.timestampMs : Math.min(oldestMs, entry.timestampMs);
    }
  });

  const header = [
    'CreatorCrate Logs Export',
    '='.repeat(24),
    '',
    `Generated (UTC): ${generatedAt}`,
    'Filters:',
    ...formatFilterLines(filters, sinceMs),
    `Entries exported: ${count}`,
    newestMs === null
      ? 'Timestamp range (UTC): no entries'
      : `Timestamp range (UTC): ${new Date(oldestMs).toISOString()} to ${new Date(newestMs).toISOString()}`,
    'Order: newest first',
    '',
    ...PRIVACY_NOTICE,
    '',
    count === 0 ? 'No log entries matched the selected filters.\n' : '',
  ].join('\n');
  const text = header + entries.join('\n') + (count > 0 ? `\n${ENTRY_SEPARATOR}\nEnd of export.\n` : '');
  const byteLength = Buffer.byteLength(text, 'utf8');
  if (byteLength > maxBytes) throw tooLarge(maxBytes);

  return { content: Buffer.from(text, 'utf8'), byteLength, entryCount: count, generatedAt };
}
