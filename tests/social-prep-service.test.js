import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createSocialPrepRepository } from '../src/data/social-prep-repository.js';
import { createReleaseService } from '../src/services/release-service.js';
import { createSocialPrepService, SocialPrepServiceError } from '../src/services/social-prep-service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('social preparation lifecycle service', () => {
  let db;
  let releaseService;
  let repository;
  let service;
  let projectId;
  let releaseId;
  let clock;
  let socialPrepEnabled;
  let configuredPlatforms;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    clock = new Date('2030-01-01T00:00:00Z');
    projectId = Number(db.prepare(`INSERT INTO projects (title, slug, description, notes, status, project_type)
      VALUES ('Project', 'project', '', '', 'ready', 'images')`).run().lastInsertRowid);
    releaseId = Number(db.prepare(`INSERT INTO releases (project_id, title, description, published_date)
      VALUES (?, 'Release', '', '2030-01-01')`).run(projectId).lastInsertRowid);
    const asset = createAssetRepository(db).upsert(projectId, 'image.png', {
      projectId, relativePath: 'image.png', filename: 'image.png', extension: 'png',
      mimeType: 'image/png', sizeBytes: 3, modifiedAt: '2030-01-01T00:00:00Z',
    });
    db.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, 0)')
      .run(releaseId, asset.id, 'primary');
    releaseService = createReleaseService({ db });
    repository = createSocialPrepRepository(db);
    socialPrepEnabled = true;
    configuredPlatforms = ['patreon', 'x', 'bluesky'];
    service = createSocialPrepService({
      db, socialPrepRepository: repository, releaseService,
      socialPrepSettingsService: { isEnabled: () => socialPrepEnabled, getPlatforms: () => configuredPlatforms },
      now: () => clock,
    });
    service.initializePlatformState(releaseId, ['x', 'bluesky']);
  });

  afterEach(() => closeDatabase(db));

  function activate(overrides = {}) {
    return service.activate({ releaseId, intentHash: 'intent-hash', expiresAt: new Date('2030-01-01T00:15:00Z'), ...overrides });
  }

  it('selects the release companion action from authoritative lifecycle state', () => {
    expect(service.getCompanionAction(releaseId)).toEqual({ mode: 'activate' });

    const issued = activate({ platforms: ['x'] });
    expect(service.getCompanionAction(releaseId)).toEqual({ mode: 'reissue', sessionId: issued.session.id });

    service.redeem({ sessionId: issued.session.id, intentHash: 'intent-hash', mediaTokenHash: 'media-hash' });
    service.recordPlatformStatus({ releaseId, platform: 'x', sessionId: issued.session.id, status: 'staging' });
    expect(service.getCompanionAction(releaseId)).toBeNull();

    clock = new Date('2030-01-01T00:16:00Z');
    expect(service.getCompanionAction(releaseId)).toEqual({ mode: 'activate' });
  });

  it('excludes deselected retained rows from actions and direct activation', () => {
    db.prepare("UPDATE release_social_platforms SET status = 'failed', attempts = 2 WHERE release_id = ? AND platform = 'x'").run(releaseId);
    const historical = repository.listPlatformsByReleaseId(releaseId).find((row) => row.platform === 'x');
    repository.replaceSelectedPlatforms(releaseId, ['bluesky']);
    expect(service.computeRetryablePlatforms(repository.listPlatformsByReleaseId(releaseId)))
      .toEqual(['bluesky']);
    expect(service.getCompanionAction(releaseId)).toEqual({ mode: 'activate' });
    expect(() => activate({ platforms: ['x'] }))
      .toThrowError(expect.objectContaining({ code: 'nothing_retryable' }));
    expect(activate().platforms).toEqual(['bluesky']);
    expect(repository.listPlatformsByReleaseId(releaseId).find((row) => row.platform === 'x'))
      .toMatchObject({ is_selected: 0, status: historical.status, attempts: historical.attempts });
  });

  it('does not reopen a deselected completed platform', () => {
    db.prepare("UPDATE release_social_platforms SET status = 'ready', attempts = 1 WHERE release_id = ? AND platform = 'x'").run(releaseId);
    repository.replaceSelectedPlatforms(releaseId, []);
    expect(service.getCompanionAction(releaseId)).toBeNull();
    expect(() => activate({ platforms: ['x'], reprepare: true }))
      .toThrowError(expect.objectContaining({ code: 'platform_not_prepared' }));
    expect(repository.listPlatformsByReleaseId(releaseId).find((row) => row.platform === 'x'))
      .toMatchObject({ is_selected: 0, status: 'ready', attempts: 1 });
  });

  it('rejects reissue if an issued target is no longer selected', () => {
    const issued = activate({ platforms: ['x'] });
    db.prepare("UPDATE release_social_platforms SET is_selected = 0 WHERE release_id = ? AND platform = 'x'").run(releaseId);
    expect(service.getCompanionAction(releaseId)).toBeNull();
    expect(() => service.reissue({ releaseId, sessionId: issued.session.id, intentHash: 'new-intent',
      expiresAt: new Date('2030-01-01T00:30:00Z') }))
      .toThrowError(expect.objectContaining({ code: 'attempt_not_reissuable' }));
    expect(repository.listPlatformsByReleaseId(releaseId).find((row) => row.platform === 'x'))
      .toMatchObject({ is_selected: 0, session_id: issued.session.id, status: 'pending' });
  });

  it('sets distinct preparation and 24-hour confirmation deadlines at redemption', () => {
    const issued = activate({ platforms: ['x'] });
    const redeemed = service.redeem({
      sessionId: issued.session.id, intentHash: 'intent-hash', mediaTokenHash: 'media-hash',
    });
    expect(redeemed).toMatchObject({
      attempt_deadline_at: '2030-01-01 00:30:00',
      manual_confirmation_expires_at: '2030-01-02 00:00:00',
    });
  });

  it.each([
    ['one ready target', [['x', 'ready']]],
    ['two ready targets', [['x', 'ready'], ['bluesky', 'ready']]],
    ['two legacy prepared targets', [['x', 'prepared'], ['bluesky', 'prepared']]],
    ['mixed completed targets', [['x', 'prepared'], ['bluesky', 'ready']]],
    ['three completed targets', [['patreon', 'ready'], ['x', 'prepared'], ['bluesky', 'ready']]],
  ])('selects one release-level reprepare action for %s', (_name, completedTargets) => {
    db.prepare('DELETE FROM release_social_platforms WHERE release_id = ?').run(releaseId);
    service.initializePlatformState(releaseId, completedTargets.map(([platform]) => platform));
    const update = db.prepare('UPDATE release_social_platforms SET status = ?, attempts = 1 WHERE release_id = ? AND platform = ?');
    for (const [platform, status] of completedTargets) update.run(status, releaseId, platform);
    expect(service.getCompanionAction(releaseId)).toEqual({ mode: 'reprepare' });
  });

  it('selects normal activation for failed and cancelled retry eligibility', () => {
    db.prepare(`UPDATE release_social_platforms SET status = 'failed', attempts = 1 WHERE release_id = ? AND platform = 'x'`).run(releaseId);
    db.prepare(`UPDATE release_social_platforms SET status = 'cancelled', attempts = 1 WHERE release_id = ? AND platform = 'bluesky'`).run(releaseId);
    expect(service.getCompanionAction(releaseId)).toEqual({ mode: 'activate' });
  });

  it('keeps retryable work authoritative over a completed target', () => {
    db.prepare("UPDATE release_social_platforms SET status = 'failed', attempts = 1 WHERE release_id = ? AND platform = 'x'").run(releaseId);
    db.prepare("UPDATE release_social_platforms SET status = 'ready', attempts = 1 WHERE release_id = ? AND platform = 'bluesky'").run(releaseId);
    expect(service.getCompanionAction(releaseId)).toEqual({ mode: 'activate' });
  });

  it('keeps exact-session reissue authoritative over a completed target', () => {
    db.prepare("UPDATE release_social_platforms SET status = 'ready', attempts = 1 WHERE release_id = ? AND platform = 'bluesky'").run(releaseId);
    const issued = activate({ platforms: ['x'] });
    expect(service.getCompanionAction(releaseId)).toEqual({ mode: 'reissue', sessionId: issued.session.id });
  });

  it('suppresses reopen while a redeemed preparation is active beside a completed target', () => {
    db.prepare("UPDATE release_social_platforms SET status = 'ready', attempts = 1 WHERE release_id = ? AND platform = 'bluesky'").run(releaseId);
    const issued = activate({ platforms: ['x'] });
    service.redeem({ sessionId: issued.session.id, intentHash: 'intent-hash', mediaTokenHash: 'media-hash' });
    expect(service.getCompanionAction(releaseId)).toBeNull();
    service.recordPlatformStatus({ releaseId, platform: 'x', sessionId: issued.session.id, status: 'staging' });
    expect(service.getCompanionAction(releaseId)).toBeNull();
  });

  it('does not offer an action for an issued session that is no longer reissuable', () => {
    const issued = activate({ platforms: ['x'] });
    db.prepare("UPDATE release_social_platforms SET status = 'starting' WHERE release_id = ? AND platform = 'x'").run(releaseId);
    expect(repository.findSessionById(issued.session.id).state).toBe('issued');
    expect(service.getCompanionAction(releaseId)).toBeNull();
  });

  it('creates an initial session, snapshots selected assets, and does not treat body_empty as blocking', () => {
    const result = activate({ platforms: ['x'] });
    expect(result.session.kind).toBe('initial');
    expect(result.snapshotCount).toBe(1);
    expect(result.issues).toEqual([{ code: 'body_empty', severity: 'warning' }]);
    expect(repository.listPlatformsByReleaseId(releaseId).find((row) => row.platform === 'x')).toMatchObject({ attempts: 1, status: 'pending' });
  });

  it('snapshots every ordered release asset regardless of role', () => {
    const assets = createAssetRepository(db);
    const attachment = assets.upsert(projectId, 'attachment.png', {
      projectId, relativePath: 'attachment.png', filename: 'attachment.png', extension: 'png',
      mimeType: 'image/png', sizeBytes: 3, modifiedAt: '2030-01-01T00:00:00Z',
    });
    const preview = assets.upsert(projectId, 'preview.png', {
      projectId, relativePath: 'preview.png', filename: 'preview.png', extension: 'png',
      mimeType: 'image/png', sizeBytes: 3, modifiedAt: '2030-01-01T00:00:00Z',
    });
    const insertReleaseAsset = db.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)');
    insertReleaseAsset.run(releaseId, attachment.id, 'attachment', 1);
    insertReleaseAsset.run(releaseId, preview.id, 'preview', 2);

    const result = activate({ platforms: ['x'] });

    expect(result.snapshotCount).toBe(3);
    expect(repository.listSessionAssets(result.session.id).map(({ role, sort_order: sortOrder }) => ({ role, sortOrder })))
      .toEqual([
        { role: 'primary', sortOrder: 0 },
        { role: 'attachment', sortOrder: 1 },
        { role: 'preview', sortOrder: 2 },
      ]);
  });

  it('expires an issued session and makes its replacement a retry', () => {
    const first = activate({ platforms: ['x'] });
    clock = new Date('2030-01-01T00:15:00Z');
    const second = activate({ platforms: ['x'], expiresAt: new Date('2030-01-01T00:30:00Z') });
    expect(repository.findSessionById(first.session.id).state).toBe('expired');
    expect(second.session.kind).toBe('retry');
  });

  it('reissues only the matching unredeemed session with fresh persisted authority', () => {
    const first = activate({ platforms: ['x'] });
    const replacement = service.reissue({
      releaseId,
      sessionId: first.session.id,
      intentHash: 'replacement-intent',
      expiresAt: new Date('2030-01-01T00:15:00Z'),
    });

    expect(repository.findSessionById(first.session.id).state).toBe('expired');
    expect(replacement.session).toMatchObject({ kind: 'retry', state: 'issued', intent_hash: 'replacement-intent' });
    expect(replacement.session.id).not.toBe(first.session.id);
    expect(repository.listPlatformsByReleaseId(releaseId).find((row) => row.platform === 'x'))
      .toMatchObject({ session_id: replacement.session.id, status: 'pending', attempts: 2 });
    expect(service.redeem({ sessionId: first.session.id, intentHash: 'intent-hash', mediaTokenHash: 'old-media' })).toBeUndefined();
  });

  it('refuses to reissue a redeemed attempt and preserves its authority', () => {
    const first = activate({ platforms: ['x'] });
    service.redeem({ sessionId: first.session.id, intentHash: 'intent-hash', mediaTokenHash: 'media-hash' });

    expect(() => service.reissue({
      releaseId,
      sessionId: first.session.id,
      intentHash: 'replacement-intent',
      expiresAt: new Date('2030-01-01T00:15:00Z'),
    })).toThrowError(expect.objectContaining({ code: 'attempt_not_reissuable' }));
    expect(repository.findSessionById(first.session.id)).toMatchObject({ state: 'redeemed', media_token_hash: 'media-hash' });
  });

  it('retries the stuck platform immediately after its redeemed session reaches the hard deadline', () => {
    const first = activate({ platforms: ['x'] });
    service.redeem({ sessionId: first.session.id, intentHash: 'intent-hash', mediaTokenHash: 'media-hash' });
    clock = new Date('2030-01-01T00:29:00Z');
    service.recordPlatformStatus({ releaseId, platform: 'x', sessionId: first.session.id, status: 'starting' });
    service.recordPlatformStatus({ releaseId, platform: 'x', sessionId: first.session.id, status: 'preparing' });

    clock = new Date('2030-01-01T00:31:00Z');
    const second = activate({ platforms: ['x'], expiresAt: new Date('2030-01-01T00:45:00Z') });

    expect(repository.findSessionById(first.session.id).state).toBe('superseded');
    expect(second.session).toMatchObject({ kind: 'retry', state: 'issued' });
    expect(second.platforms).toEqual(['x']);
  });

  it('includes a recently updated stale-session platform in an un-narrowed retry', () => {
    const first = activate({ platforms: ['x', 'bluesky'] });
    service.redeem({ sessionId: first.session.id, intentHash: 'intent-hash', mediaTokenHash: 'media-hash' });
    clock = new Date('2030-01-01T00:29:00Z');
    service.recordPlatformStatus({ releaseId, platform: 'x', sessionId: first.session.id, status: 'starting' });
    service.recordPlatformStatus({ releaseId, platform: 'x', sessionId: first.session.id, status: 'preparing' });

    clock = new Date('2030-01-01T00:31:00Z');
    const second = activate({ expiresAt: new Date('2030-01-01T00:45:00Z') });

    expect(repository.findSessionById(first.session.id).state).toBe('superseded');
    expect(second.session).toMatchObject({ kind: 'retry', state: 'issued' });
    expect(second.platforms).toHaveLength(2);
    expect(second.platforms).toEqual(expect.arrayContaining(['x', 'bluesky']));
  });

  it('keeps genuinely live fresh non-terminal X work in progress', () => {
    const first = activate({ platforms: ['x', 'bluesky'] });
    service.redeem({ sessionId: first.session.id, intentHash: 'intent-hash', mediaTokenHash: 'media-hash' });
    clock = new Date('2030-01-01T00:01:00Z');
    service.recordPlatformStatus({ releaseId, platform: 'x', sessionId: first.session.id, status: 'starting' });
    service.recordPlatformStatus({ releaseId, platform: 'x', sessionId: first.session.id, status: 'preparing' });

    expect(() => activate({ platforms: ['bluesky'] }))
      .toThrowError(expect.objectContaining({ code: 'attempt_in_progress' }));
  });

  it('keeps a fresh manual staging attempt active and recovers it through the established stale timeout', () => {
    const first = activate({ platforms: ['x'] });
    service.redeem({ sessionId: first.session.id, intentHash: 'intent-hash', mediaTokenHash: 'media-hash' });
    clock = new Date('2030-01-01T00:01:00Z');
    service.recordPlatformStatus({ releaseId, platform: 'x', sessionId: first.session.id, status: 'staging' });

    clock = new Date('2030-01-01T00:15:59Z');
    expect(() => activate({ platforms: ['x'] }))
      .toThrowError(expect.objectContaining({ code: 'attempt_in_progress' }));

    clock = new Date('2030-01-01T00:16:00Z');
    const second = activate({ platforms: ['x'], intentHash: 'replacement-intent', expiresAt: new Date('2030-01-01T00:31:00Z') });
    expect(repository.findSessionById(first.session.id).state).toBe('superseded');
    expect(second.session).toMatchObject({ kind: 'retry', state: 'issued' });
    expect(second.platforms).toEqual(['x']);
  });

  it('rejects activation while disabled and never revives a platform absent from current settings', () => {
    socialPrepEnabled = false;

    expect(() => activate({ platforms: ['x'] }))
      .toThrowError(expect.objectContaining({ code: 'social_prep_disabled' }));
    expect(db.prepare('SELECT COUNT(*) AS count FROM social_prep_sessions').get().count).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM social_prep_session_assets').get().count).toBe(0);
    expect(repository.listPlatformsByReleaseId(releaseId).every((row) => row.attempts === 0)).toBe(true);

    socialPrepEnabled = true;
    configuredPlatforms = ['x'];
    expect(() => activate({ platforms: ['bluesky'] }))
      .toThrowError(expect.objectContaining({ code: 'unknown_platform' }));
    expect(db.prepare('SELECT COUNT(*) AS count FROM social_prep_sessions').get().count).toBe(0);
    expect(repository.listPlatformsByReleaseId(releaseId).every((row) => row.attempts === 0)).toBe(true);
  });

  it('does not alter state when the release is unpublished', () => {
    db.prepare('UPDATE releases SET published_date = NULL WHERE id = ?').run(releaseId);
    expect(() => activate()).toThrow(SocialPrepServiceError);
    try { activate(); } catch (error) { expect(error).toMatchObject({ code: 'validation_failed', issues: [{ code: 'release_not_published', severity: 'blocking' }] }); }
    expect(db.prepare('SELECT COUNT(*) AS count FROM social_prep_sessions').get().count).toBe(0);
    expect(repository.listPlatformsByReleaseId(releaseId).every((row) => row.attempts === 0)).toBe(true);
  });

  it.each(['prepared', 'ready'])('reopens completed %s preparation through a fresh explicit reprepare session', (completedStatus) => {
    const first = activate({ platforms: ['x'] });
    service.redeem({ sessionId: first.session.id, intentHash: 'intent-hash', mediaTokenHash: 'media-hash' });
    clock = new Date('2030-01-01T00:01:00Z');
    if (completedStatus === 'prepared') {
      service.recordPlatformStatus({ releaseId, platform: 'x', sessionId: first.session.id, status: 'starting' });
    } else {
      service.recordPlatformStatus({ releaseId, platform: 'x', sessionId: first.session.id, status: 'staging' });
    }
    service.recordPlatformStatus({ releaseId, platform: 'x', sessionId: first.session.id, status: completedStatus });
    const preparedAt = repository.listPlatformsByReleaseId(releaseId).find((row) => row.platform === 'x').prepared_at;
    expect(() => activate({ platforms: ['x'] })).toThrowError(expect.objectContaining({ code: 'reprepare_required' }));
    const releaseBefore = releaseService.findRelease(releaseId);
    const next = activate({ reprepare: true, intentHash: 'fresh-intent', expiresAt: new Date('2030-01-01T00:30:00Z') });
    expect(next.session).toMatchObject({ kind: 'reprepare', state: 'issued', media_token_hash: null });
    expect(next.session.id).not.toBe(first.session.id);
    expect(repository.findSessionById(first.session.id)).toMatchObject({ state: 'finished', media_token_hash: 'media-hash' });
    expect(repository.listPlatformsByReleaseId(releaseId).find((row) => row.platform === 'x').prepared_at).toBe(preparedAt);
    expect(releaseService.findRelease(releaseId)).toEqual(releaseBefore);
  });

  it('reprepares only the explicitly requested completed target', () => {
    service.initializePlatformState(releaseId, ['patreon']);
    const first = activate({ platforms: ['patreon', 'x', 'bluesky'] });
    service.redeem({ sessionId: first.session.id, intentHash: 'intent-hash', mediaTokenHash: 'media-hash' });
    clock = new Date('2030-01-01T00:01:00Z');
    service.recordPlatformStatus({ releaseId, platform: 'bluesky', sessionId: first.session.id, status: 'staging' });
    service.recordPlatformStatus({ releaseId, platform: 'bluesky', sessionId: first.session.id, status: 'ready' });
    service.recordPlatformStatus({ releaseId, platform: 'patreon', sessionId: first.session.id, status: 'staging' });
    service.recordPlatformStatus({ releaseId, platform: 'patreon', sessionId: first.session.id, status: 'ready' });
    service.recordPlatformStatus({ releaseId, platform: 'x', sessionId: first.session.id, status: 'starting' });
    service.recordPlatformStatus({ releaseId, platform: 'x', sessionId: first.session.id, status: 'prepared' });
    const historicalPreparedAt = repository.listPlatformsByReleaseId(releaseId)
      .find((row) => row.platform === 'x').prepared_at;
    const releaseBefore = releaseService.findRelease(releaseId);

    const next = activate({ platforms: ['x'], reprepare: true, intentHash: 'fresh-intent', expiresAt: new Date('2030-01-01T00:30:00Z') });

    expect(next.platforms).toEqual(['x']);
    expect(next.session).toMatchObject({ kind: 'reprepare', state: 'issued', media_token_hash: null });
    expect(next.session.id).not.toBe(first.session.id);
    expect(db.prepare('SELECT COUNT(*) AS count FROM social_prep_sessions WHERE release_id = ?').get(releaseId).count).toBe(2);
    expect(repository.listPlatformsByReleaseId(releaseId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ platform: 'bluesky', session_id: first.session.id, status: 'ready', attempts: 1, prepared_at: null }),
      expect.objectContaining({ platform: 'patreon', session_id: first.session.id, status: 'ready', attempts: 1, prepared_at: null }),
      expect.objectContaining({ platform: 'x', session_id: next.session.id, status: 'pending', attempts: 2, prepared_at: historicalPreparedAt }),
    ]));
    expect(repository.findSessionById(first.session.id)).toMatchObject({ state: 'finished', media_token_hash: 'media-hash' });
    expect(service.redeem({ sessionId: first.session.id, intentHash: 'intent-hash', mediaTokenHash: 'old-media' })).toBeUndefined();
    expect(releaseService.findRelease(releaseId)).toEqual(releaseBefore);
  });

  it('finishes a redeemed session when its final owned platform becomes terminal without incrementing attempts', () => {
    const first = activate({ platforms: ['x'] });
    service.redeem({ sessionId: first.session.id, intentHash: 'intent-hash', mediaTokenHash: 'media-hash' });
    clock = new Date('2030-01-01T00:01:00Z');
    service.recordPlatformStatus({ releaseId, platform: 'x', sessionId: first.session.id, status: 'starting' });
    service.recordPlatformStatus({ releaseId, platform: 'x', sessionId: first.session.id, status: 'prepared' });
    expect(repository.findSessionById(first.session.id).state).toBe('finished');
    expect(repository.listPlatformsByReleaseId(releaseId).find((row) => row.platform === 'x')).toMatchObject({ attempts: 1, prepared_at: '2030-01-01 00:01:00' });
  });

  it('keeps staging non-terminal and treats ready as terminal without assigning legacy prepared_at', () => {
    const attempt = activate({ platforms: ['x'] });
    service.redeem({ sessionId: attempt.session.id, intentHash: 'intent-hash', mediaTokenHash: 'media-hash' });
    clock = new Date('2030-01-01T00:01:00Z');

    const staging = service.recordPlatformStatus({
      releaseId, platform: 'x', sessionId: attempt.session.id, status: 'staging',
    });
    expect(staging).toMatchObject({ status: 'staging', prepared_at: null });
    expect(repository.findSessionById(attempt.session.id).state).toBe('redeemed');

    clock = new Date('2030-01-01T00:02:00Z');
    const ready = service.recordPlatformStatus({
      releaseId, platform: 'x', sessionId: attempt.session.id, status: 'ready',
    });
    expect(ready).toMatchObject({ status: 'ready', prepared_at: null, updated_at: '2030-01-01 00:02:00' });
    expect(repository.findSessionById(attempt.session.id).state).toBe('finished');
  });

  it('keeps posted outside the ordinary preparation status vocabulary', () => {
    expect(() => service.recordPlatformStatus({
      releaseId, platform: 'x', sessionId: 'session', status: 'posted',
    })).toThrowError('Unsupported Social Preparation platform status.');
  });

  it('prevents ordinary preparation updates from overwriting posted evidence', () => {
    const attempt = activate({ platforms: ['x'] });
    service.redeem({ sessionId: attempt.session.id, intentHash: 'intent-hash', mediaTokenHash: 'media-hash' });
    db.prepare(`UPDATE release_social_platforms
      SET status = 'posted', posted_at = '2030-01-01 00:05:00'
      WHERE release_id = ? AND platform = 'x'`).run(releaseId);

    expect(() => service.recordPlatformStatus({
      releaseId, platform: 'x', sessionId: attempt.session.id, status: 'ready',
    })).toThrowError(expect.objectContaining({ code: 'invalid_status_transition' }));
    expect(repository.listPlatformsByReleaseId(releaseId).find((row) => row.platform === 'x'))
      .toMatchObject({ status: 'posted', posted_at: '2030-01-01 00:05:00' });
  });

  it('rejects out-of-order and terminal-state transitions without mutating the platform', () => {
    const attempt = activate({ platforms: ['x', 'bluesky'] });
    service.redeem({ sessionId: attempt.session.id, intentHash: 'intent-hash', mediaTokenHash: 'media-hash' });

    expect(() => service.recordPlatformStatus({
      releaseId, platform: 'x', sessionId: attempt.session.id, status: 'ready',
    })).toThrowError(expect.objectContaining({ code: 'invalid_status_transition' }));
    expect(repository.listPlatformsByReleaseId(releaseId).find((row) => row.platform === 'x').status).toBe('pending');

    service.recordPlatformStatus({ releaseId, platform: 'x', sessionId: attempt.session.id, status: 'staging' });
    service.recordPlatformStatus({ releaseId, platform: 'x', sessionId: attempt.session.id, status: 'ready' });
    expect(() => service.recordPlatformStatus({
      releaseId, platform: 'x', sessionId: attempt.session.id, status: 'staging',
    })).toThrowError(expect.objectContaining({ code: 'invalid_status_transition' }));
    expect(repository.listPlatformsByReleaseId(releaseId).find((row) => row.platform === 'x').status).toBe('ready');
  });

  it.each(['failed', 'cancelled'])('preserves retry eligibility after %s', (status) => {
    const first = activate({ platforms: ['x'] });
    service.redeem({ sessionId: first.session.id, intentHash: 'intent-hash', mediaTokenHash: 'media-hash' });
    service.recordPlatformStatus({ releaseId, platform: 'x', sessionId: first.session.id, status });

    const retry = activate({ platforms: ['x'], intentHash: `retry-${status}`, expiresAt: new Date('2030-01-01T00:30:00Z') });
    expect(retry.session).toMatchObject({ kind: 'retry', state: 'issued' });
    expect(repository.listPlatformsByReleaseId(releaseId).find((row) => row.platform === 'x'))
      .toMatchObject({ status: 'pending', attempts: 2, session_id: retry.session.id });
  });

  it('computes posting completion from selected rows, including after selection changes', () => {
    db.prepare("UPDATE release_social_platforms SET status = 'posted', posted_at = '2030-01-01 01:00:00' WHERE release_id = ? AND platform = 'x'").run(releaseId);
    expect(service.getPostingCompletion(releaseId)).toEqual({ postedCount: 1, totalCount: 2, isComplete: false });

    repository.replaceSelectedPlatforms(releaseId, ['x']);
    expect(service.getPostingCompletion(releaseId)).toEqual({ postedCount: 1, totalCount: 1, isComplete: true });

    db.prepare("UPDATE release_social_platforms SET status = 'posted', posted_at = '2030-01-01 01:00:00' WHERE release_id = ? AND platform = 'bluesky'").run(releaseId);
    expect(service.getPostingCompletion(releaseId)).toEqual({ postedCount: 1, totalCount: 1, isComplete: true });

    db.prepare("UPDATE release_social_platforms SET status = 'pending', posted_at = NULL WHERE release_id = ? AND platform = 'x'").run(releaseId);
    expect(service.getPostingCompletion(releaseId)).toEqual({ postedCount: 0, totalCount: 1, isComplete: false });
    db.prepare("UPDATE release_social_platforms SET status = 'posted', posted_at = '2030-01-01 01:00:00' WHERE release_id = ? AND platform = 'x'").run(releaseId);

    repository.replaceSelectedPlatforms(releaseId, ['x', 'bluesky']);
    expect(service.getPostingCompletion(releaseId)).toEqual({ postedCount: 2, totalCount: 2, isComplete: true });

    configuredPlatforms = ['patreon'];
    expect(service.getPostingCompletion(releaseId)).toEqual({ postedCount: 2, totalCount: 2, isComplete: true });

    repository.replaceSelectedPlatforms(releaseId, []);
    expect(service.getPostingCompletion(releaseId)).toEqual({ postedCount: 0, totalCount: 0, isComplete: false });
  });

  it.each(['pending', 'staging', 'starting', 'preparing', 'uploading', 'failed', 'cancelled', 'prepared', 'auth_required'])
  ('rejects explicit posting confirmation from %s', (status) => {
    const sessionId = `invalid-${status}`;
    repository.insertSession({
      id: sessionId, releaseId, kind: 'initial', state: 'finished', intentHash: `intent-${status}`,
      expiresAt: new Date('2030-01-02T00:00:00Z'), now: clock,
    });
    repository.reassignPlatformsToSession(sessionId, ['x'], { now: clock });
    db.prepare('UPDATE release_social_platforms SET status = ? WHERE release_id = ? AND platform = ?')
      .run(status, releaseId, 'x');
    expect(() => service.confirmPlatformPosted({
      sessionId, platform: 'x', authenticate: () => repository.findSessionById(sessionId),
    })).toThrowError(expect.objectContaining({ code: 'platform_not_ready' }));
  });

  it('reprepares only explicitly selected posted targets and invalidates old ownership', () => {
    service.initializePlatformState(releaseId, ['patreon']);
    const first = activate({ platforms: ['patreon', 'x', 'bluesky'] });
    service.redeem({ sessionId: first.session.id, intentHash: 'intent-hash', mediaTokenHash: 'media-hash' });
    for (const platform of ['patreon', 'x', 'bluesky']) {
      service.recordPlatformStatus({ releaseId, platform, sessionId: first.session.id, status: 'staging' });
      service.recordPlatformStatus({ releaseId, platform, sessionId: first.session.id, status: 'ready' });
    }
    clock = new Date('2030-01-01T00:05:00Z');
    for (const platform of ['patreon', 'x']) {
      service.confirmPlatformPosted({
        sessionId: first.session.id, platform, authenticate: () => repository.findSessionById(first.session.id),
      });
    }
    const patreonPostedAt = repository.listPlatformsByReleaseId(releaseId).find((row) => row.platform === 'patreon').posted_at;

    const next = activate({ platforms: ['x'], reprepare: true, intentHash: 'next-intent', expiresAt: new Date('2030-01-01T00:30:00Z') });
    expect(next.platforms).toEqual(['x']);
    expect(repository.listPlatformsByReleaseId(releaseId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ platform: 'patreon', status: 'posted', posted_at: patreonPostedAt, session_id: first.session.id }),
      expect.objectContaining({ platform: 'x', status: 'pending', posted_at: null, session_id: next.session.id, attempts: 2 }),
      expect.objectContaining({ platform: 'bluesky', status: 'ready', posted_at: null, session_id: first.session.id }),
    ]));
    expect(() => service.confirmPlatformPosted({
      sessionId: first.session.id, platform: 'x', authenticate: () => repository.findSessionById(first.session.id),
    })).toThrowError(expect.objectContaining({ code: 'confirmation_target_not_owned' }));
  });

  it('reprepares multiple explicitly selected posted targets without resetting an unselected target', () => {
    service.initializePlatformState(releaseId, ['patreon']);
    db.prepare(`UPDATE release_social_platforms
      SET status = 'posted', posted_at = '2030-01-01 00:05:00', attempts = 1
      WHERE release_id = ?`).run(releaseId);

    const next = activate({
      platforms: ['patreon', 'bluesky'], reprepare: true,
      intentHash: 'selected-intent', expiresAt: new Date('2030-01-01T00:30:00Z'),
    });
    expect(next.platforms).toEqual(['bluesky', 'patreon']);
    expect(repository.listPlatformsByReleaseId(releaseId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ platform: 'patreon', status: 'pending', posted_at: null, session_id: next.session.id }),
      expect.objectContaining({ platform: 'bluesky', status: 'pending', posted_at: null, session_id: next.session.id }),
      expect.objectContaining({ platform: 'x', status: 'posted', posted_at: '2030-01-01 00:05:00' }),
    ]));
  });
});
