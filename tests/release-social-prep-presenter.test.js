import { describe, expect, it } from 'vitest';
import { buildReleaseSocialPrepPresentation as present } from '../src/services/release-social-prep-presenter.js';

const row = (overrides = {}) => ({
  platform: 'patreon', status: 'pending', attempts: 0,
  updated_at: '2030-01-01 00:00:00', prepared_at: null,
  ...overrides,
});

describe('release Social Preparation presentation', () => {
  it.each([
    ['pending', 'Pending'], ['starting', 'Starting'], ['preparing', 'Preparing'],
    ['uploading', 'Uploading'], ['auth_required', 'Authentication required'],
    ['prepared', 'Composer prepared for human submission'],
    ['failed', 'Preparation failed'], ['cancelled', 'Preparation cancelled'],
  ])('presents recorded %s without claiming publication', (status, statusLabel) => {
    const model = present([row({ status, attempts: 2 })]);
    expect(model.targets[0]).toMatchObject({ status, statusLabel, preparationRequestCount: 2 });
    expect(JSON.stringify(model)).not.toMatch(/posted|published/i);
    expect(model).not.toHaveProperty('status');
  });

  it('distinguishes no request from a pending assigned request', () => {
    expect(present([row()]).targets[0]).toMatchObject({
      status: 'pending', preparationRequestCount: 0, noPreparationRequested: true,
    });
    expect(present([row({ attempts: 1 })]).targets[0]).toMatchObject({
      status: 'pending', preparationRequestCount: 1, noPreparationRequested: false,
    });
  });

  it('retains mixed saved states in canonical order independently of current configuration', () => {
    const rows = Object.freeze([
      Object.freeze(row({ platform: 'bluesky', status: 'failed', attempts: 3,
        prepared_at: '2029-12-01 01:02:03' })),
      Object.freeze(row({ platform: 'x', status: 'prepared', attempts: 1,
        prepared_at: '2030-01-01 00:00:00' })),
      Object.freeze(row()),
    ]);
    const model = present(rows, { enabled: false, platforms: ['x'] });
    expect(model).toEqual({
      globallyEnabled: false,
      configuredPlatforms: ['x'],
      targets: [
        { platform: 'patreon', platformName: 'Patreon', status: 'pending', statusLabel: 'Pending',
          preparationRequestCount: 0, noPreparationRequested: true, lastUpdatedAt: '2030-01-01 00:00:00',
          firstPreparedAt: null, absentFromCurrentConfiguration: true },
        { platform: 'x', platformName: 'X', status: 'prepared', statusLabel: 'Composer prepared for human submission',
          preparationRequestCount: 1, noPreparationRequested: false, lastUpdatedAt: '2030-01-01 00:00:00',
          firstPreparedAt: '2030-01-01 00:00:00', absentFromCurrentConfiguration: false },
        { platform: 'bluesky', platformName: 'Bluesky', status: 'failed', statusLabel: 'Preparation failed',
          preparationRequestCount: 3, noPreparationRequested: false, lastUpdatedAt: '2030-01-01 00:00:00',
          firstPreparedAt: '2029-12-01 01:02:03', absentFromCurrentConfiguration: true },
      ],
    });
  });

  it('does not backfill an empty release from global defaults', () => {
    expect(present([], { enabled: true, platforms: ['bluesky', 'patreon', 'x'] })).toEqual({
      globallyEnabled: true, configuredPlatforms: ['patreon', 'x', 'bluesky'], targets: [],
    });
    expect(present([])).toEqual({ globallyEnabled: false, configuredPlatforms: [], targets: [] });
  });

  it('allowlists output rather than exposing private persisted fields', () => {
    const model = present([row({ message: 'PRIVATE_MESSAGE', detail_code: 'PRIVATE_CODE',
      session_id: 'PRIVATE_SESSION', token: 'PRIVATE_TOKEN', helperUri: 'PRIVATE_URI',
      creatorVanity: 'PRIVATE_CREATOR', diagnostics: { path: 'PRIVATE_PATH' } })]);
    expect(JSON.stringify(model)).not.toMatch(/PRIVATE|message|detail_code|session|token|helper|diagnostics|creator/i);
  });

  it.each([
    { platform: 'mastodon' }, { platform: '__proto__' }, { status: 'posted' },
    { status: '__proto__' }, { attempts: -1 }, { attempts: '1' },
    { updated_at: 'private/path' }, { prepared_at: 'private/path' },
  ])('fails closed for corrupt persisted values: %j', (overrides) => {
    expect(() => present([row(overrides)])).toThrow(TypeError);
  });
});
