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
    projectId = Number(db.prepare(`INSERT INTO projects (title, slug, description, notes, status)
      VALUES ('Project', 'project', '', '', 'ready')`).run().lastInsertRowid);
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

  it('retries the stuck platform immediately after its redeemed session reaches the hard deadline', () => {
    const first = activate({ platforms: ['x'] });
    service.redeem({ sessionId: first.session.id, intentHash: 'intent-hash', mediaTokenHash: 'media-hash' });
    clock = new Date('2030-01-01T00:29:00Z');
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
    service.recordPlatformStatus({ releaseId, platform: 'x', sessionId: first.session.id, status: 'preparing' });

    expect(() => activate({ platforms: ['bluesky'] }))
      .toThrowError(expect.objectContaining({ code: 'attempt_in_progress' }));
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

  it('requires explicit reprepare for a prepared platform and preserves prepared_at', () => {
    const first = activate({ platforms: ['x'] });
    service.redeem({ sessionId: first.session.id, intentHash: 'intent-hash', mediaTokenHash: 'media-hash' });
    clock = new Date('2030-01-01T00:01:00Z');
    service.recordPlatformStatus({ releaseId, platform: 'x', sessionId: first.session.id, status: 'prepared' });
    const preparedAt = repository.listPlatformsByReleaseId(releaseId).find((row) => row.platform === 'x').prepared_at;
    expect(() => activate({ platforms: ['x'] })).toThrowError(expect.objectContaining({ code: 'reprepare_required' }));
    const next = activate({ platforms: ['x'], reprepare: true, expiresAt: new Date('2030-01-01T00:30:00Z') });
    expect(next.session.kind).toBe('reprepare');
    expect(repository.listPlatformsByReleaseId(releaseId).find((row) => row.platform === 'x').prepared_at).toBe(preparedAt);
  });

  it('rejects duplicate explicit reprepare platforms without changing persisted state', () => {
    const first = activate({ platforms: ['x'] });
    service.redeem({ sessionId: first.session.id, intentHash: 'intent-hash', mediaTokenHash: 'media-hash' });
    clock = new Date('2030-01-01T00:01:00Z');
    service.recordPlatformStatus({ releaseId, platform: 'x', sessionId: first.session.id, status: 'prepared' });
    const sessionsBefore = db.prepare('SELECT * FROM social_prep_sessions ORDER BY id').all();
    const snapshotsBefore = db.prepare('SELECT * FROM social_prep_session_assets ORDER BY session_id, asset_id').all();
    const platformBefore = repository.listPlatformsByReleaseId(releaseId).find((row) => row.platform === 'x');

    expect(() => activate({ platforms: ['x', 'x'], reprepare: true }))
      .toThrowError(expect.objectContaining({ code: 'reprepare_requires_single_platform' }));

    expect(db.prepare('SELECT * FROM social_prep_sessions ORDER BY id').all()).toEqual(sessionsBefore);
    expect(db.prepare('SELECT * FROM social_prep_session_assets ORDER BY session_id, asset_id').all()).toEqual(snapshotsBefore);
    expect(repository.listPlatformsByReleaseId(releaseId).find((row) => row.platform === 'x')).toEqual(platformBefore);
  });

  it('finishes a redeemed session when its final owned platform becomes terminal without incrementing attempts', () => {
    const first = activate({ platforms: ['x'] });
    service.redeem({ sessionId: first.session.id, intentHash: 'intent-hash', mediaTokenHash: 'media-hash' });
    clock = new Date('2030-01-01T00:01:00Z');
    service.recordPlatformStatus({ releaseId, platform: 'x', sessionId: first.session.id, status: 'prepared' });
    expect(repository.findSessionById(first.session.id).state).toBe('finished');
    expect(repository.listPlatformsByReleaseId(releaseId).find((row) => row.platform === 'x')).toMatchObject({ attempts: 1, prepared_at: '2030-01-01 00:01:00' });
  });
});
