import { describe, expect, it } from 'vitest';
import { buildReleaseSocialPrepPresentation as present } from '../src/services/release-social-prep-presenter.js';

const row = (overrides = {}) => ({
  platform: 'patreon', status: 'pending', attempts: 0, is_selected: 1,
  updated_at: '2030-01-01 00:00:00', prepared_at: null,
  ...overrides,
});

describe('release Social Preparation presentation', () => {
  it.each([
    ['pending', 'Pending'], ['starting', 'Starting'], ['preparing', 'Preparing'],
    ['uploading', 'Uploading'], ['auth_required', 'Authentication required'],
    ['prepared', 'Composer ready'],
    ['staging', 'Preparing content and files'],
    ['ready', 'Not Posted - Ready'],
    ['posted', 'Posted — confirmed'],
    ['failed', 'Preparation failed'], ['cancelled', 'Preparation cancelled'],
  ])('presents recorded %s without claiming publication', (status, statusLabel) => {
    const model = present([row({
      status, attempts: 2, posted_at: status === 'posted' ? '2030-01-01 01:00:00' : null,
    })]);
    expect(model.targets[0]).toMatchObject({ status, statusLabel, preparationRequestCount: 2 });
    expect(JSON.stringify(model)).not.toMatch(/posted successfully|published(?: successfully| to)/i);
    expect(model).not.toHaveProperty('status');
  });

  it('keeps ready distinct from social publication and legacy prepared unchanged', () => {
    const model = present([
      row({ platform: 'x', status: 'ready', attempts: 1 }),
      row({ platform: 'bluesky', status: 'prepared', attempts: 1, prepared_at: '2029-12-01 01:02:03' }),
    ]);
    expect(model.targets.find((target) => target.status === 'ready')).toMatchObject({
      statusLabel: 'Not Posted - Ready', firstPreparedAt: null,
    });
    expect(model.targets.find((target) => target.status === 'prepared')).toMatchObject({
      statusLabel: 'Composer ready', firstPreparedAt: '2029-12-01 01:02:03',
    });
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
          firstPreparedAt: null, postedAt: null, absentFromCurrentConfiguration: true },
        { platform: 'x', platformName: 'X', status: 'prepared', statusLabel: 'Composer ready',
          preparationRequestCount: 1, noPreparationRequested: false, lastUpdatedAt: '2030-01-01 00:00:00',
          firstPreparedAt: '2030-01-01 00:00:00', postedAt: null, absentFromCurrentConfiguration: false },
        { platform: 'bluesky', platformName: 'Bluesky', status: 'failed', statusLabel: 'Preparation failed',
          preparationRequestCount: 3, noPreparationRequested: false, lastUpdatedAt: '2030-01-01 00:00:00',
          firstPreparedAt: '2029-12-01 01:02:03', postedAt: null, absentFromCurrentConfiguration: true },
      ],
      postingCompletion: { postedCount: 0, totalCount: 3, isComplete: false },
    });
  });

  it('does not backfill an empty release from global defaults', () => {
    expect(present([], { enabled: true, platforms: ['bluesky', 'patreon', 'x'] })).toEqual({
      globallyEnabled: true, configuredPlatforms: ['patreon', 'x', 'bluesky'], targets: [],
      postingCompletion: { postedCount: 0, totalCount: 0, isComplete: false },
    });
    expect(present([])).toEqual({
      globallyEnabled: false, configuredPlatforms: [], targets: [],
      postingCompletion: { postedCount: 0, totalCount: 0, isComplete: false },
    });
  });

  it('allowlists output rather than exposing private persisted fields', () => {
    const model = present([row({ message: 'PRIVATE_MESSAGE', detail_code: 'PRIVATE_CODE',
      session_id: 'PRIVATE_SESSION', token: 'PRIVATE_TOKEN', helperUri: 'PRIVATE_URI',
      creatorVanity: 'PRIVATE_CREATOR', diagnostics: { path: 'PRIVATE_PATH' } })]);
    expect(JSON.stringify(model)).not.toMatch(/PRIVATE|message|detail_code|session|token|helper|diagnostics|creator/i);
  });

  it.each([
    { platform: 'mastodon' }, { platform: '__proto__' },
    { status: '__proto__' }, { attempts: -1 }, { attempts: '1' },
    { updated_at: 'private/path' }, { prepared_at: 'private/path' },
    { status: 'posted', posted_at: null }, { status: 'ready', posted_at: '2030-01-01 00:00:00' },
  ])('fails closed for corrupt persisted values: %j', (overrides) => {
    expect(() => present([row(overrides)])).toThrow(TypeError);
  });

  it('distinguishes posted confirmation and computes completion across selected platforms', () => {
    const model = present([
      row({ platform: 'patreon', status: 'posted', attempts: 1, posted_at: '2030-01-01 01:00:00' }),
      row({ platform: 'x', status: 'posted', attempts: 1, posted_at: '2030-01-01 02:00:00' }),
      row({ platform: 'bluesky', is_selected: 0, status: 'ready', attempts: 1 }),
    ], { enabled: true, platforms: ['patreon', 'x'] });
    expect(model.targets.find((target) => target.platform === 'patreon')).toMatchObject({
      status: 'posted', statusLabel: 'Posted — confirmed', postedAt: '2030-01-01 01:00:00',
      prepareAnotherPostAction: {
        mode: 'reprepare', label: 'Prepare another post', accessibleLabel: 'Prepare another Patreon post',
        description: 'Starts a new manual post attempt for Patreon.', platform: 'patreon', reprepare: true,
      },
    });
    expect(model.postingCompletion).toEqual({ postedCount: 2, totalCount: 2, isComplete: true });
  });

  it.each([
    ['patreon', 'Patreon'], ['x', 'X'], ['bluesky', 'Bluesky'],
  ])('exposes canonical targeted reprepare metadata for posted %s', (platform, platformName) => {
    const model = present([
      row({ platform, status: 'posted', attempts: 1, posted_at: '2030-01-01 01:00:00' }),
    ], { enabled: true, platforms: [platform] });

    expect(model.targets[0].prepareAnotherPostAction).toEqual({
      mode: 'reprepare',
      label: 'Prepare another post',
      accessibleLabel: `Prepare another ${platformName} post`,
      description: `Starts a new manual post attempt for ${platformName}.`,
      platform,
      reprepare: true,
    });
  });

  it.each(['pending', 'starting', 'preparing', 'uploading', 'auth_required', 'prepared', 'staging', 'ready', 'failed', 'cancelled'])
  ('does not expose Prepare another post for %s', (status) => {
    const model = present([row({ platform: 'x', status, attempts: 1 })], { enabled: true, platforms: ['x'] });
    expect(model.targets[0]).not.toHaveProperty('prepareAnotherPostAction');
  });

  it('does not expose the action for a disabled historical posted target or when actions are suppressed', () => {
    const posted = row({ platform: 'x', status: 'posted', attempts: 1, posted_at: '2030-01-01 01:00:00' });
    expect(present([posted], { enabled: true, platforms: ['bluesky'] }).targets[0])
      .not.toHaveProperty('prepareAnotherPostAction');
    expect(present([posted], { enabled: true, platforms: ['x'] }, { allowActions: false }).targets[0])
      .not.toHaveProperty('prepareAnotherPostAction');
  });

  it('retains a deselected posted target without offering another preparation', () => {
    const model = present([row({ platform: 'x', is_selected: 0, status: 'posted', attempts: 1,
      posted_at: '2030-01-01 01:00:00' })], { enabled: true, platforms: ['x'] });
    expect(model.targets[0]).toMatchObject({ platform: 'x', status: 'posted', preparationRequestCount: 1 });
    expect(model.targets[0]).not.toHaveProperty('prepareAnotherPostAction');
    expect(model.postingCompletion).toEqual({ postedCount: 0, totalCount: 0, isComplete: false });
  });

  it('counts selected posted targets while excluding configured and historical unselected targets', () => {
    const posted = { status: 'posted', attempts: 1, posted_at: '2030-01-01 01:00:00' };
    const settings = { enabled: true, platforms: ['patreon', 'x', 'bluesky'] };
    const selectedX = row({ platform: 'x', ...posted });
    expect(present([selectedX], settings).postingCompletion)
      .toEqual({ postedCount: 1, totalCount: 1, isComplete: true });

    const historicalPatreon = row({ platform: 'patreon', is_selected: 0, ...posted });
    expect(present([selectedX, historicalPatreon], settings).postingCompletion)
      .toEqual({ postedCount: 1, totalCount: 1, isComplete: true });
    expect(present([row({ platform: 'x' }), historicalPatreon], settings).postingCompletion)
      .toEqual({ postedCount: 0, totalCount: 1, isComplete: false });

    const selectedPatreon = row();
    expect(present([selectedX, selectedPatreon], settings).postingCompletion)
      .toEqual({ postedCount: 1, totalCount: 2, isComplete: false });
  });
});
