import { describe, it, expect, beforeEach } from 'vitest';
import {
  createReleaseNotificationRecentResultService,
  RECENT_RESULT_CODES,
  recentResultFromOutcome,
  RELEASE_NOTIFICATION_RECENT_RESULTS_KEY,
} from '../src/services/release-notification-recent-result-service.js';
import { failureMessage } from '../src/services/release-notification-settings-presenter.js';

function memoryAppMeta() {
  const values = new Map();
  return {
    values,
    getValue: (key) => values.get(key),
    setValue: (key, value) => { values.set(key, value); return value; },
  };
}

describe('release notification recent results', () => {
  let appMeta;
  let service;

  beforeEach(() => {
    appMeta = memoryAppMeta();
    service = createReleaseNotificationRecentResultService({ appMetaRepository: appMeta });
  });

  it('starts empty for every channel', () => {
    expect(service.getRecentResults()).toEqual({ email: null, ntfy: null, gotify: null, webhook: null });
  });

  it('replaces only the recorded channel and keeps one result per channel', () => {
    service.recordResult('ntfy', { kind: 'release', at: '2026-09-27T10:00:00.000Z', state: 'accepted' });
    service.recordResult('email', { kind: 'test', at: '2026-09-27T10:01:00.000Z', state: 'failed', code: 'timeout' });
    service.recordResult('email', { kind: 'test', at: '2026-09-27T10:02:00.000Z', state: 'accepted' });

    expect(service.getRecentResults()).toEqual({
      email: { kind: 'test', at: '2026-09-27T10:02:00.000Z', state: 'accepted', code: null, nextRetryAt: null },
      ntfy: { kind: 'release', at: '2026-09-27T10:00:00.000Z', state: 'accepted', code: null, nextRetryAt: null },
      gotify: null,
      webhook: null,
    });
  });

  it('persists only the fixed sanitized fields', () => {
    service.recordResult('webhook', {
      kind: 'release',
      at: new Date('2026-09-27T10:00:00.000Z'),
      state: 'retry_scheduled',
      code: 'provider_unavailable',
      nextRetryAt: '2026-09-27T10:05:00.000Z',
      message: 'upstream said Bearer super-secret-token',
      response: { body: 'raw provider body' },
      url: 'https://hooks.example.test/in/secret-path?token=abc',
    });
    service.recordResult('gotify', { kind: 'test', at: '2026-09-27T10:00:00.000Z', state: 'failed', code: 'Raw Error: 535 password' });

    const stored = JSON.parse(appMeta.values.get(RELEASE_NOTIFICATION_RECENT_RESULTS_KEY));
    expect(Object.keys(stored)).toEqual(['version', 'channels']);
    expect(Object.keys(stored.channels.webhook).sort()).toEqual(['at', 'code', 'kind', 'nextRetryAt', 'state']);
    expect(stored.channels.gotify.code).toBe('unspecified');
    const raw = appMeta.values.get(RELEASE_NOTIFICATION_RECENT_RESULTS_KEY);
    for (const secret of ['super-secret-token', 'raw provider body', 'secret-path', '535 password']) {
      expect(raw).not.toContain(secret);
    }
  });

  it.each(['timeout', 'rate_limited', 'provider_unavailable', 'authentication_failed', 'smtp_temporary_failure',
    'redirect_refused', 'invalid_configuration', 'lease_expired', 'unexpected_error'])('keeps known code %s', (code) => {
    expect(service.recordResult('ntfy', { kind: 'test', at: '2026-09-27T10:00:00.000Z', state: 'failed', code }).code)
      .toBe(code);
    expect(service.getRecentResults().ntfy.code).toBe(code);
  });

  it.each([
    ['unknown alphanumeric', 'totallyMadeUpProviderFailure123'],
    ['unknown safe snake_case', 'http_503'],
    ['malicious characters', '<script>alert(1)</script>'],
    ['provider text', 'Error: 550 mailbox user@example.test unavailable'],
    ['prototype key', 'constructor'],
    ['non-string', 42],
  ])('maps %s codes to unspecified', (_label, code) => {
    service.recordResult('gotify', { kind: 'release', at: '2026-09-27T10:00:00.000Z', state: 'cancelled', code });
    expect(service.getRecentResults().gotify.code).toBe('unspecified');
    expect(appMeta.values.get(RELEASE_NOTIFICATION_RECENT_RESULTS_KEY)).not.toContain(String(code));
  });

  it('re-sanitizes unknown codes in a stored document without touching other channels', () => {
    service.recordResult('email', { kind: 'test', at: '2026-09-27T10:00:00.000Z', state: 'failed', code: 'timeout' });
    const stored = JSON.parse(appMeta.values.get(RELEASE_NOTIFICATION_RECENT_RESULTS_KEY));
    stored.channels.webhook = { kind: 'release', at: '2026-09-27T10:01:00.000Z', state: 'failed', code: 'madeUpCode' };
    appMeta.values.set(RELEASE_NOTIFICATION_RECENT_RESULTS_KEY, JSON.stringify(stored));

    const results = service.getRecentResults();
    expect(results.webhook.code).toBe('unspecified');
    expect(results.email.code).toBe('timeout');
    service.recordResult('ntfy', { kind: 'test', at: '2026-09-27T10:02:00.000Z', state: 'failed', code: 'bogus' });
    expect(service.getRecentResults().email.code).toBe('timeout');
  });

  it.each(['2026-09-27T10:00:00.000Z', '2026-09-27T10:00:00Z', '2028-02-29T10:00:00.000Z'])(
    'accepts the calendar-valid timestamp %s for the attempt and retry instants',
    (timestamp) => {
      const entry = { kind: 'release', at: timestamp, state: 'retry_scheduled', code: 'timeout', nextRetryAt: timestamp };
      expect(service.recordResult('email', entry)).toEqual(entry);
      expect(service.getRecentResults().email).toEqual(entry);
    },
  );

  const impossibleTimestamps = [
    '2026-02-29T10:00:00.000Z',
    '2026-02-30T10:00:00.000Z',
    '2026-04-31T10:00:00.000Z',
    '2026-13-01T10:00:00.000Z',
    '2026-09-27T24:00:00.000Z',
    '2026-09-27T10:60:00.000Z',
    '2026-09-27T10:00:60.000Z',
    '2026-09-27T10:00Z',
  ];

  it.each(impossibleTimestamps)('rejects the impossible attempt timestamp %s', (timestamp) => {
    expect(() => service.recordResult('email', { kind: 'test', at: timestamp, state: 'accepted' })).toThrow(/entry/);
    expect(service.getRecentResults().email).toBeNull();
    expect(appMeta.values.has(RELEASE_NOTIFICATION_RECENT_RESULTS_KEY)).toBe(false);
  });

  it.each(impossibleTimestamps)('drops the impossible retry instant %s instead of normalizing it', (timestamp) => {
    const recorded = service.recordResult('email', {
      kind: 'release', at: '2026-09-27T10:00:00.000Z', state: 'retry_scheduled', code: 'timeout', nextRetryAt: timestamp,
    });
    expect(recorded.nextRetryAt).toBeNull();
    const stored = JSON.parse(appMeta.values.get(RELEASE_NOTIFICATION_RECENT_RESULTS_KEY));
    expect(stored.channels.email.nextRetryAt).toBeNull();
    expect(appMeta.values.get(RELEASE_NOTIFICATION_RECENT_RESULTS_KEY)).not.toContain(timestamp);
    expect(recentResultFromOutcome(
      { outcome: 'transient_failure', failureCode: 'timeout' },
      { kind: 'release', at: '2026-09-27T10:00:00.000Z', nextRetryAt: timestamp },
    )).toMatchObject({ state: 'failed', code: 'timeout' });
  });

  it('cleans impossible stored timestamps without touching other channels', () => {
    const valid = { kind: 'test', at: '2026-09-27T10:00:00.000Z', state: 'failed', code: 'rate_limited', nextRetryAt: null };
    service.recordResult('ntfy', valid);
    const stored = JSON.parse(appMeta.values.get(RELEASE_NOTIFICATION_RECENT_RESULTS_KEY));
    stored.channels.email = { kind: 'test', at: '2026-02-30T10:00:00.000Z', state: 'accepted' };
    stored.channels.webhook = {
      kind: 'release', at: '2026-09-27T10:01:00.000Z', state: 'retry_scheduled', code: 'madeUpCode',
      nextRetryAt: '2026-02-30T10:00:00.000Z',
    };
    appMeta.values.set(RELEASE_NOTIFICATION_RECENT_RESULTS_KEY, JSON.stringify(stored));

    const results = service.getRecentResults();
    expect(results.email).toBeNull();
    expect(results.webhook).toEqual({
      kind: 'release', at: '2026-09-27T10:01:00.000Z', state: 'retry_scheduled', code: 'unspecified', nextRetryAt: null,
    });
    expect(results.ntfy).toEqual(valid);

    service.recordResult('gotify', { kind: 'test', at: '2026-09-27T10:02:00.000Z', state: 'accepted' });
    const rewritten = appMeta.values.get(RELEASE_NOTIFICATION_RECENT_RESULTS_KEY);
    expect(rewritten).not.toContain('2026-02-30');
    expect(rewritten).not.toContain('2026-03-02');
    expect(service.getRecentResults().ntfy).toEqual(valid);
  });

  it('allows only codes the Settings page can explain', () => {
    for (const code of RECENT_RESULT_CODES) {
      expect(failureMessage(code)).not.toBe(failureMessage('unspecified'));
    }
  });

  it('rejects unknown channels and malformed entries', () => {
    expect(() => service.recordResult('sms', { kind: 'test', at: '2026-09-27T10:00:00.000Z', state: 'accepted' }))
      .toThrow(/channel/);
    expect(() => service.recordResult('email', { kind: 'test', at: 'yesterday', state: 'accepted' }))
      .toThrow(/entry/);
    expect(service.getRecentResults().email).toBeNull();
  });

  it('ignores a malformed stored document', () => {
    appMeta.values.set(RELEASE_NOTIFICATION_RECENT_RESULTS_KEY, '{"version":1,"channels":{"email":{"state":"accepted"}}}');
    expect(service.getRecentResults().email).toBeNull();
  });

  it('maps transport outcomes to display states', () => {
    const at = '2026-09-27T10:00:00.000Z';
    expect(recentResultFromOutcome({ outcome: 'accepted' }, { kind: 'test', at }).state).toBe('accepted');
    expect(recentResultFromOutcome({ outcome: 'transient_failure', failureCode: 'timeout' }, { kind: 'test', at }))
      .toMatchObject({ state: 'failed', code: 'timeout' });
    expect(recentResultFromOutcome(
      { outcome: 'transient_failure', failureCode: 'timeout' },
      { kind: 'release', at, nextRetryAt: '2026-09-27T10:05:00.000Z' },
    )).toMatchObject({ state: 'retry_scheduled', nextRetryAt: '2026-09-27T10:05:00.000Z' });
    expect(recentResultFromOutcome(undefined, { kind: 'test', at })).toMatchObject({ state: 'failed', code: 'unexpected_error' });
  });
});
