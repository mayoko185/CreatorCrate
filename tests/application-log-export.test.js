import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { createApplicationLogRepository } from '../src/data/application-log-repository.js';
import {
  APPLICATION_LOG_EXPORT_MAX_BYTES,
  ApplicationLogExportError,
  buildApplicationLogExport,
} from '../src/services/application-log-export.js';
import { createLogTimestampFormatter, formatLogRecord } from '../src/services/application-log-presentation.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
const HOUR_MS = 60 * 60 * 1000;

describe('application log TXT export', () => {
  let db;
  let repository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    repository = createApplicationLogRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
    db = undefined;
  });

  function log(overrides = {}) {
    return repository.insert({
      occurredAtMs: NOW - HOUR_MS,
      level: 'error',
      kind: 'diagnostic',
      subsystem: 'processing',
      event: 'processing.recovery.failed',
      message: 'Processing recovery failed.',
      context: {},
      ...overrides,
    });
  }

  function exportText(options = {}) {
    const result = buildApplicationLogExport({ applicationLogRepository: repository, now: NOW, ...options });
    return { ...result, text: result.content.toString('utf8') };
  }

  it('writes readable metadata, privacy warning, and newest-first entries', () => {
    log({ occurredAtMs: NOW - 3 * HOUR_MS, event: 'older.event', message: 'Older entry.' });
    log({
      occurredAtMs: NOW - HOUR_MS,
      correlationId: 'job-42',
      context: { code: 'ENOENT', attempts: 3 },
    });

    const { text, entryCount, generatedAt, byteLength } = exportText();

    expect(entryCount).toBe(2);
    expect(generatedAt).toBe('2026-10-08T12:00:00.000Z');
    expect(byteLength).toBe(Buffer.byteLength(text, 'utf8'));
    expect(text.startsWith('CreatorCrate Logs Export\n')).toBe(true);
    expect(text).toContain('Generated (UTC): 2026-10-08T12:00:00.000Z');
    expect(text).toContain('  Level: Any level (not filtered)');
    expect(text).toContain('  Time range: Any time (not filtered)');
    expect(text).toContain('Entries exported: 2');
    expect(text).toContain('Timestamp range (UTC): 2026-10-08T09:00:00.000Z to 2026-10-08T11:00:00.000Z');
    expect(text).toContain('Review this file before sharing it.');
    expect(text).toContain([
      '#1  2026-10-08T11:00:00.000Z  ERROR',
      'Kind: diagnostic',
      'Subsystem: processing',
      'Event: processing.recovery.failed',
      'Message: Processing recovery failed.',
    ].join('\n'));
    expect(text).toMatch(/Entry ID: \d+\nCorrelation ID: job-42\nContext:\n {2}code: ENOENT\n {2}attempts: 3\n/);
    expect(text.indexOf('#1 ')).toBeLessThan(text.indexOf('#2  2026-10-08T09:00:00.000Z'));
    expect(text.endsWith('End of export.\n')).toBe(true);
  });

  it('applies combined filters with one fixed UTC cutoff', () => {
    log({ occurredAtMs: NOW - 2 * HOUR_MS, event: 'outside.cutoff' });
    log({ occurredAtMs: NOW - HOUR_MS, event: 'at.cutoff' });
    log({ occurredAtMs: NOW - 10 * 60 * 1000, event: 'inside.match' });
    log({ occurredAtMs: NOW - 10 * 60 * 1000, level: 'warn', event: 'wrong.level' });
    log({ occurredAtMs: NOW - 10 * 60 * 1000, subsystem: 'http', event: 'wrong.subsystem' });
    const visit = vi.spyOn(repository, 'forEachExportRecord');
    const dateNow = vi.spyOn(Date, 'now');

    const { text, entryCount } = exportText({
      filters: { level: 'error', kind: 'diagnostic', subsystem: 'processing', time: 'hour' },
    });

    expect(visit).toHaveBeenCalledWith(
      { level: 'error', kind: 'diagnostic', subsystem: 'processing', sinceMs: NOW - HOUR_MS },
      expect.any(Function)
    );
    expect(dateNow).not.toHaveBeenCalled();
    expect(entryCount).toBe(2);
    expect(text).toContain([
      '  Level: error',
      '  Kind: diagnostic',
      '  Subsystem: processing',
      '  Time range: Last hour (entries at or after 2026-10-08T11:00:00.000Z)',
    ].join('\n'));
    expect(text).toContain('Event: inside.match');
    expect(text).toContain('Event: at.cutoff');
    expect(text).not.toMatch(/outside\.cutoff|wrong\.level|wrong\.subsystem/);
  });

  it('produces a complete export when no entries match', () => {
    log({ level: 'info' });

    const { text, entryCount } = exportText({ filters: { level: 'fatal', time: '7d' } });

    expect(entryCount).toBe(0);
    expect(text).toContain('Entries exported: 0');
    expect(text).toContain('Timestamp range (UTC): no entries');
    expect(text).toContain('  Time range: Last 7 days (entries at or after 2026-10-01T12:00:00.000Z)');
    expect(text).toContain('Review this file before sharing it.');
    expect(text).toContain('No log entries matched the selected filters.');
    expect(text).not.toContain('#1');
  });

  it('keeps Unicode intact and reports the actual UTF-8 byte length', () => {
    log({ message: 'Rendu terminé ✓ 漢字 🎨', context: { label: 'Ünïcødé' } });

    const { text, content, byteLength } = exportText();

    expect(text).toContain('Message: Rendu terminé ✓ 漢字 🎨');
    expect(text).toContain('  label: Ünïcødé');
    expect(byteLength).toBe(content.length);
    expect(byteLength).toBeGreaterThan(text.length);
  });

  it('never exposes malformed legacy context', () => {
    db.prepare(`
      INSERT INTO application_logs (
        occurred_at_ms, level, kind, subsystem, event, message, project_id, correlation_id, context_json
      ) VALUES (?, 'warn', 'diagnostic', 'legacy', 'legacy.event', 'Legacy entry.', NULL, NULL, ?)
    `).run(NOW - HOUR_MS, '{"password":"hunter2", broken');

    const { text, entryCount } = exportText();

    expect(entryCount).toBe(1);
    expect(text).toContain('Event: legacy.event');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('Context:');
  });

  it('redacts recognizable credentials and credential-bearing URL variants', () => {
    log({ message: 'Upload to https://bob:hunter2@cdn.example.com/a?X-Amz-Signature=abc123&page=2 failed.' });
    log({ message: 'Provider rejected key sk-abcdefghijklmnop1234 and ghp_abcdefghijklmnopqrstuvwxyz0123.' });
    log({ message: 'Callback http://example.com/cb?code=oauth-code&state=ok returned 401.' });
    log({ message: 'Authorization: Bearer abc.def.ghi' });
    log({ context: { apiToken: 'plain-token', webhook: 'https://u:p@hooks.example.com/x?sig=t0k' } });

    const { text } = exportText();

    expect(text).toContain('https://[redacted credentials]@cdn.example.com/a?X-Amz-Signature=[redacted]&page=2 failed.');
    expect(text).toContain('Provider rejected key [redacted credential] and [redacted credential].');
    expect(text).toContain('http://example.com/cb?code=[redacted]&state=ok returned 401.');
    expect(text).toContain('Message: [redacted secret]');
    expect(text).toContain('  apiToken: [redacted]');
    expect(text).toContain('  webhook: https://[redacted credentials]@hooks.example.com/x?sig=[redacted]');
    expect(text).not.toMatch(/hunter2|abc123|oauth-code|sk-abcdef|ghp_abc|plain-token|t0k/);
  });

  it('redacts email addresses, sensitive fields, and filesystem locations', () => {
    log({
      message: 'Shared with alice.smith+art@example.co.uk from projects/Commission/sketch.png and ~/art/x.psd',
      context: {
        filePath: 'art/a.png',
        sourceFileName: 'portrait.psd',
        outputDir: 'renders',
        userEmail: 'carol@example.com',
        absolute: 'C:\\Users\\carol\\Art\\a.png',
        fileUrl: 'file:///home/carol/a.png',
        stack: 'at render (worker.js:1:1)',
        mimeType: 'image/png',
      },
    });
    log({ message: 'Error: boom\n    at render (/srv/app/worker.js:1:1)' });

    const { text } = exportText();

    expect(text).toContain('Shared with [redacted email] from [redacted path] and [redacted path]');
    for (const field of ['filePath', 'sourceFileName', 'outputDir', 'userEmail', 'stack']) {
      expect(text).toContain(`  ${field}: [redacted]`);
    }
    expect(text).toContain('  absolute: [redacted path]');
    expect(text).toContain('  fileUrl: [redacted path]');
    expect(text).toContain('  mimeType: image/png');
    expect(text).toContain('Message: [redacted stack trace]');
    expect(text).not.toMatch(/alice|carol|Commission|sketch|portrait|renders|worker\.js/);
  });

  it('redacts API-key context fields while keeping diagnostic IDs', () => {
    log({
      context: {
        apiKey: 'DEMO_API_KEY_1',
        api_key: 'DEMO_API_KEY_2',
        'x-api-key': 'DEMO_API_KEY_3',
        provider: { accessKey: 'DEMO_API_KEY_4', privateKey: 'DEMO_API_KEY_5' },
        apiKeyId: 'key-7',
        requestId: 'req-9',
      },
    });

    const { text } = exportText();

    for (const field of ['apiKey', 'api_key', 'x-api-key', 'provider.accessKey', 'provider.privateKey']) {
      expect(text).toContain(`  ${field}: [redacted]`);
    }
    expect(text).toContain('  apiKeyId: key-7');
    expect(text).toContain('  requestId: req-9');
    expect(text).not.toContain('DEMO_API_KEY');
  });

  it('redacts descendants of object- and array-valued API-key context fields', () => {
    log({
      correlationId: 'corr-5',
      context: {
        provider: {
          apiKey: { value: 'DEMO_NESTED_APIKEY' },
          api_key: { primary: { secret_value: 'DEMO_NESTED_2' } },
          'x-api-key': { value: 'DEMO_NESTED_3' },
          requestId: 'req-11',
        },
        apiKeys: [{ value: 'DEMO_NESTED_4' }, 'DEMO_NESTED_5'],
        keys: [{ api_key: { value: 'DEMO_NESTED_6' }, status: 'revoked' }],
        apiKey: 'DEMO_SCALAR_7',
        apiKeyId: 'key-8',
        recoveryStatus: 'retrying',
        errorCode: 'PROVIDER_401',
      },
    });

    const { text } = exportText();

    for (const field of [
      'provider.apiKey.value',
      'provider.api_key.primary.secret_value',
      'provider.x-api-key.value',
      'apiKeys[0].value',
      'apiKeys[1]',
      'keys[0].api_key.value',
      'apiKey',
    ]) {
      expect(text).toContain(`  ${field}: [redacted]`);
    }
    expect(text).toContain('Correlation ID: corr-5');
    expect(text).toContain('  provider.requestId: req-11');
    expect(text).toContain('  keys[0].status: revoked');
    expect(text).toContain('  apiKeyId: key-8');
    expect(text).toContain('  recoveryStatus: retrying');
    expect(text).toContain('  errorCode: PROVIDER_401');
    expect(text).not.toMatch(/DEMO_(NESTED|SCALAR)/);
  });

  it('redacts quoted JSON-like credential assignments in messages', () => {
    log({ message: 'Provider response {"password":"DEMO_PRIVATE_12345"}' });
    log({ message: `Provider response { "api_key" : "DEMO PRIVATE 2", "client_secret":'DEMO_PRIVATE_3', "token"=DEMO_PRIVATE_4, "status": 401, "tokenCount": 4 }` });

    const { text } = exportText();

    expect(text).toContain('Message: Provider response {"password":[redacted]}');
    expect(text).toContain('Message: Provider response { "api_key" : [redacted], "client_secret":[redacted], "token"=[redacted], "status": 401, "tokenCount": 4 }');
    expect(text).not.toContain('DEMO');
  });

  it('redacts whole paths containing spaces while keeping error details', () => {
    log({ message: 'Failed to read projects/Secret Art/cover.png: ENOENT' });
    log({ message: String.raw`Failed to read projects\Secret Art\My Cover Photo.png (EACCES)` });
    log({ message: 'Copied ./projects/Secret Art/cover.png to cache; retry 2 of 3.' });
    log({ message: 'Opened ~/Secret Art/cover.png: ENOENT' });
    log({ message: String.raw`Missing C:\Users\carol\Secret Art\cover.png` });
    log({ message: String.raw`Missing \\nas\share\Secret Art\cover.png` });
    log({ message: 'Missing /home/carol/Secret Art/cover.png' });
    log({ context: { reason: 'Could not open uploads/Secret Art/sketch 2.psd (EPERM)' } });

    const { text } = exportText();

    expect(text).toContain('Message: Failed to read [redacted path]: ENOENT');
    expect(text).toContain('Message: Failed to read [redacted path] (EACCES)');
    expect(text).toContain('Message: Copied [redacted path] to cache; retry 2 of 3.');
    expect(text).toContain('Message: Opened [redacted path]: ENOENT');
    expect(text.match(/Message: \[redacted path\]\n/g)).toHaveLength(3);
    expect(text).toContain('  reason: Could not open [redacted path] (EPERM)');
    expect(text).not.toMatch(/Secret|\bArt\b|\bcover\b|Photo|sketch|carol|\bnas\b/);
  });

  it('formats timestamps identically with a reused formatter', () => {
    const timestamps = [Date.UTC(2024, 0, 1, 0, 5, 9), Date.UTC(2024, 5, 1, 12, 0, 0), Date.UTC(2024, 5, 1, 23, 59, 59)];
    const cases = [
      ['UTC', '24h', ['2024-01-01 00:05:09 UTC', '2024-06-01 12:00:00 UTC', '2024-06-01 23:59:59 UTC']],
      ['UTC', '12h', ['2024-01-01 12:05:09 AM UTC', '2024-06-01 12:00:00 PM UTC', '2024-06-01 11:59:59 PM UTC']],
      ['local', '24h', ['2024-01-01 00:05:09 UTC', '2024-06-01 12:00:00 UTC', '2024-06-01 23:59:59 UTC']],
      ['America/New_York', '24h', ['2023-12-31 19:05:09 EST', '2024-06-01 08:00:00 EDT', '2024-06-01 19:59:59 EDT']],
      ['America/New_York', '12h', ['2023-12-31 7:05:09 PM EST', '2024-06-01 8:00:00 AM EDT', '2024-06-01 7:59:59 PM EDT']],
    ];
    for (const [timezone, clockFormat, expected] of cases) {
      const formatTimestamp = createLogTimestampFormatter(timezone, clockFormat);
      const rows = timestamps.map((ms) => ({ id: 1, occurred_at_ms: ms, context_json: '{}' }));
      expect(rows.map((row) => formatLogRecord(row, timezone, clockFormat).timestamp)).toEqual(expected);
      expect(rows.map((row) => formatLogRecord(row, timezone, clockFormat, formatTimestamp).timestamp)).toEqual(expected);
    }
  });

  it('preserves useful recovery diagnostics', () => {
    log({
      event: 'processing.recovery.check_completed',
      message: 'Recovery check found 2 stale jobs (ENOENT on source); requeued.',
      correlationId: 'recovery-7f3a9c',
      projectId: null,
      context: {
        recoveryCheck: 'stale-processing-lock',
        status: 'requeued',
        errorCode: 'ENOENT',
        jobId: 'job-123',
        attempts: 2,
        retryable: true,
        failureReason: 'Source asset missing during processing.',
        profile: 'web',
      },
    });

    const { text } = exportText();

    expect(text).toContain('Event: processing.recovery.check_completed');
    expect(text).toContain('Message: Recovery check found 2 stale jobs (ENOENT on source); requeued.');
    expect(text).toContain('Correlation ID: recovery-7f3a9c');
    expect(text).toContain([
      '  recoveryCheck: stale-processing-lock',
      '  status: requeued',
      '  errorCode: ENOENT',
      '  jobId: job-123',
      '  attempts: 2',
      '  retryable: true',
      '  failureReason: Source asset missing during processing.',
      '  profile: web',
    ].join('\n'));
  });

  it('fails without a partial result when the UTF-8 output exceeds the byte limit', () => {
    for (let index = 0; index < 20; index += 1) log({ message: `Entry ${index} ✓` });
    const visited = [];
    const forEach = repository.forEachExportRecord.bind(repository);
    vi.spyOn(repository, 'forEachExportRecord').mockImplementation((filters, visit) => (
      forEach(filters, (row, index) => {
        visited.push(index);
        visit(row, index);
      })
    ));
    const fullBytes = exportText().byteLength;
    visited.length = 0;

    let error;
    try {
      exportText({ maxBytes: 2_000 });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ApplicationLogExportError);
    expect(error.code).toBe('EXPORT_TOO_LARGE');
    expect(visited.length).toBeLessThan(20);

    expect(() => exportText({ maxBytes: fullBytes - 1 })).toThrow(expect.objectContaining({ code: 'EXPORT_TOO_LARGE' }));
    expect(exportText({ maxBytes: fullBytes }).byteLength).toBe(fullBytes);
    expect(APPLICATION_LOG_EXPORT_MAX_BYTES).toBe(20 * 1024 * 1024);
  });
});
