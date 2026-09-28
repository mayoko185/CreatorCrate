import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { createAppMetaRepository } from '../src/data/app-meta-repository.js';
import {
  createReleaseNotificationSettingsService,
  defaultReleaseNotificationPreferences,
  RELEASE_NOTIFICATION_SETTINGS_KEY,
  ReleaseNotificationSettingsValidationError,
  validateReleaseNotificationPreferences,
} from '../src/services/release-notification-settings-service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function prefs(overrides = {}) {
  return { ...defaultReleaseNotificationPreferences(), ...overrides };
}

function validationErrors(input) {
  try {
    validateReleaseNotificationPreferences(input);
  } catch (err) {
    expect(err).toBeInstanceOf(ReleaseNotificationSettingsValidationError);
    return err.errors;
  }
  throw new Error('Expected validation to fail.');
}

describe('release notification settings validation', () => {
  it('canonicalizes channel order and rejects unknown or duplicate channels', () => {
    expect(validateReleaseNotificationPreferences(prefs({ enabledChannels: ['webhook', 'email'] })).enabledChannels)
      .toEqual(['email', 'webhook']);
    expect(validationErrors(prefs({ enabledChannels: ['email', 'webpush'] }))).toHaveProperty('enabledChannels');
    expect(validationErrors(prefs({ enabledChannels: ['ntfy', 'ntfy'] }))).toHaveProperty('enabledChannels');
  });

  it('saves channel-less preferences while disabled but requires a channel when enabled', () => {
    expect(validateReleaseNotificationPreferences(prefs({ enabled: false, enabledChannels: [] })).enabled).toBe(false);
    expect(validationErrors(prefs({ enabled: true, enabledChannels: [] }))).toHaveProperty('enabledChannels');
  });

  it('enforces timing ranges and dependencies', () => {
    expect(validationErrors(prefs({ advance: { enabled: true, leadMinutes: 0 } }))).toHaveProperty('advance.leadMinutes');
    expect(validationErrors(prefs({ advance: { enabled: true, leadMinutes: 30 * 1440 + 1 } }))).toHaveProperty('advance.leadMinutes');
    expect(validationErrors(prefs({ overdueRepeat: { enabled: true, intervalMinutes: 59 } })))
      .toHaveProperty('overdueRepeat.intervalMinutes');
    expect(validationErrors(prefs({
      overdue: { enabled: false, graceMinutes: 60 },
      overdueRepeat: { enabled: true, intervalMinutes: 60 },
    }))).toHaveProperty('overdueRepeat.enabled');
    expect(validationErrors(prefs({ dateOnlyTime: '9:00' }))).toHaveProperty('dateOnlyTime');
    expect(validationErrors(prefs({ dateOnlyTime: '24:00' }))).toHaveProperty('dateOnlyTime');
  });

  it('rejects zero-grace overdue alongside the scheduled notice but allows it alone', () => {
    expect(validationErrors(prefs({ overdue: { enabled: true, graceMinutes: 0 } }))).toHaveProperty('overdue.graceMinutes');
    expect(validateReleaseNotificationPreferences(prefs({
      scheduled: { enabled: false },
      overdue: { enabled: true, graceMinutes: 0 },
    })).overdue.graceMinutes).toBe(0);
  });
});

describe('release notification settings activation metadata', () => {
  let db;
  let appMeta;
  let service;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    appMeta = createAppMetaRepository(db);
    service = createReleaseNotificationSettingsService({ appMetaRepository: appMeta });
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('establishes the global baseline once and activates channels independently', () => {
    const t1 = new Date('2026-06-01T08:00:00.000Z');
    const t2 = new Date('2026-06-02T08:00:00.000Z');
    service.saveSettings(prefs({ enabled: true, enabledChannels: ['email'] }), { now: t1 });
    const { settings, changes } = service.saveSettings(
      prefs({ enabled: true, enabledChannels: ['email', 'ntfy'] }),
      { now: t2 },
    );

    expect(changes.activatedChannels).toEqual(['ntfy']);
    expect(settings.activation.activatedAt).toBe(t1.toISOString());
    expect(settings.activation.channels.email).toEqual({ generation: 1, activatedAt: t1.toISOString() });
    expect(settings.activation.channels.ntfy).toEqual({ generation: 1, activatedAt: t2.toISOString() });
    expect(service.getSettings()).toEqual(settings);
  });

  it('falls back to disabled defaults when the stored document is unusable', () => {
    appMeta.setValue(RELEASE_NOTIFICATION_SETTINGS_KEY, '{"version":1,"enabled":true}');
    expect(service.getSettings().enabled).toBe(false);
  });

  function storeWithActivation({ global, email }) {
    service.saveSettings(prefs({ enabled: true, enabledChannels: ['email'] }), {
      now: new Date('2026-06-01T08:00:00.000Z'),
    });
    const stored = JSON.parse(appMeta.getValue(RELEASE_NOTIFICATION_SETTINGS_KEY));
    if (global !== undefined) stored.activation.activatedAt = global;
    if (email !== undefined) stored.activation.channels.email.activatedAt = email;
    appMeta.setValue(RELEASE_NOTIFICATION_SETTINGS_KEY, JSON.stringify(stored));
  }

  it.each([
    '2026-09-27T10:00:00.000Z',
    '2026-09-27T10:00:00Z',
    '2028-02-29T10:00:00.000Z',
  ])('accepts the calendar-valid stored activation timestamp %s', (timestamp) => {
    storeWithActivation({ global: timestamp, email: timestamp });
    const settings = service.getSettings();
    expect(settings.enabled).toBe(true);
    expect(settings.activation.activatedAt).toBe(timestamp);
    expect(settings.activation.channels.email).toEqual({ generation: 1, activatedAt: timestamp });
  });

  const invalidTimestamps = [
    '2026-02-29T10:00:00.000Z',
    '2026-02-30T10:00:00.000Z',
    '2026-04-31T10:00:00.000Z',
    '2026-13-01T10:00:00.000Z',
    '2026-09-27T24:00:00.000Z',
    '2026-09-27T10:60:00.000Z',
    '2026-09-27T10:00:60.000Z',
    '2026-09-27T10:00Z',
    '2026-09-27 10:00:00Z',
    '2026-09-27T10:00:00.000+01:00',
    'not a timestamp',
  ];

  it.each(invalidTimestamps)('falls back to disabled defaults for a stored global activation of %s', (timestamp) => {
    storeWithActivation({ global: timestamp });
    const settings = service.getSettings();
    expect(settings.enabled).toBe(false);
    expect(settings.enabledChannels).toEqual([]);
    expect(settings.activation.activatedAt).toBeNull();
    expect(settings.activation.channels.email).toEqual({ generation: 0, activatedAt: null });
  });

  it.each(invalidTimestamps)('falls back to disabled defaults for a stored channel activation of %s', (timestamp) => {
    storeWithActivation({ email: timestamp });
    const settings = service.getSettings();
    expect(settings.enabled).toBe(false);
    expect(settings.enabledChannels).toEqual([]);
    expect(settings.activation.channels.email).toEqual({ generation: 0, activatedAt: null });
  });
});
