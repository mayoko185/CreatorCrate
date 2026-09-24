import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { createSocialPrepRepository, formatSocialPrepTimestamp } from '../src/data/social-prep-repository.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('social preparation repository', () => {
  let db;
  let repository;
  let projectId;
  let releaseId;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    repository = createSocialPrepRepository(db);
    projectId = Number(db.prepare(`
      INSERT INTO projects (title, slug, description, notes, status, project_type, patreon_url)
      VALUES ('Project', 'project', '', '', 'tbd', 'images', NULL)
    `).run().lastInsertRowid);
    releaseId = Number(db.prepare("INSERT INTO releases (project_id, title) VALUES (?, 'Release')").run(projectId).lastInsertRowid);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  function insertSession(overrides = {}) {
    return repository.insertSession({
      id: 'session-1',
      releaseId,
      kind: 'initial',
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      now: new Date('2029-12-31T23:59:58.900Z'),
      ...overrides,
    });
  }

  it('batches deduplicated release IDs with canonical platform order independently of Settings', () => {
    const otherId = Number(db.prepare("INSERT INTO releases (project_id, title) VALUES (?, 'Other')").run(projectId).lastInsertRowid);
    repository.ensurePlatforms(releaseId, ['bluesky', 'x', 'patreon']);
    repository.ensurePlatforms(otherId, ['x']);
    db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)').run('social_prep.enabled', '0');
    db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)').run('social_prep.platforms', 'x');
    const before = db.prepare('SELECT total_changes() AS count').get().count;
    const prepare = vi.spyOn(db, 'prepare');
    const rows = repository.listPlatformsByReleaseIds([otherId, releaseId, releaseId]);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0][0]).toContain('IN (?, ?)');
    expect(rows.map((row) => [row.release_id, row.platform])).toEqual([
      [releaseId, 'patreon'], [releaseId, 'x'], [releaseId, 'bluesky'], [otherId, 'x'],
    ]);
    prepare.mockRestore();
    expect(db.prepare('SELECT total_changes() AS count').get().count).toBe(before);
    expect(repository.listPlatformsByReleaseIds([999999])).toEqual([]);
  });

  it('does not prepare or execute a query for an empty batch and validates IDs', () => {
    const prepare = vi.spyOn(db, 'prepare');
    expect(repository.listPlatformsByReleaseIds([])).toEqual([]);
    expect(prepare).not.toHaveBeenCalled();
    for (const ids of [null, [0], ['1'], [-1], [1.5]]) {
      expect(() => repository.listPlatformsByReleaseIds(ids)).toThrow();
    }
    expect(prepare).not.toHaveBeenCalled();
    prepare.mockRestore();
  });

  it('writes sortable repository-native UTC timestamps and exposes session transitions', () => {
    const inserted = insertSession();
    expect(inserted).toMatchObject({
      state: 'issued',
      created_at: '2029-12-31 23:59:58',
      updated_at: '2029-12-31 23:59:58',
      expires_at: '2030-01-01 00:00:00',
    });
    expect(formatSocialPrepTimestamp(new Date('2029-12-31T23:59:59.999Z'))).toBe('2029-12-31 23:59:59');
    expect(repository.redeemSession('session-1', { now: new Date('2030-01-01T00:00:01Z') }).state).toBe('redeemed');
    expect(repository.finishSession('session-1', { now: new Date('2030-01-01T00:00:02Z') }).state).toBe('finished');
    expect(repository.findLiveSessionByReleaseId(releaseId)).toBeUndefined();
    expect(repository.findSessionById('session-1').updated_at).toBe('2030-01-01 00:00:02');
  });

  it('expires and supersedes only live sessions', () => {
    insertSession();
    expect(repository.expireSession('session-1', { now: new Date('2030-01-01T00:00:00Z') }).state).toBe('expired');
    expect(repository.expireSession('session-1')).toBeUndefined();
    insertSession({ id: 'session-2', kind: 'retry' });
    expect(repository.supersedeSession('session-2').state).toBe('superseded');
  });

  it('ensures and lists platforms deterministically, and reassignment resets attempt state without clearing prepared_at', () => {
    insertSession();
    repository.ensurePlatforms(releaseId, ['mastodon', 'bluesky', 'bluesky'], { now: new Date('2030-01-01T00:00:00Z') });
    expect(repository.listPlatformsByReleaseId(releaseId).map((row) => row.platform)).toEqual(['bluesky', 'mastodon']);

    repository.reassignPlatformsToSession('session-1', ['bluesky'], { now: new Date('2030-01-01T00:00:01Z') });
    repository.updatePlatformIfOwned({
      releaseId,
      platform: 'bluesky',
      sessionId: 'session-1',
      status: 'prepared',
      detailCode: 'ready',
      message: 'ready',
      preparedAt: new Date('2030-01-01T00:00:02Z'),
      now: new Date('2030-01-01T00:00:02Z'),
    });

    expect(repository.reassignPlatformsToSession('session-1', ['bluesky'], { now: new Date('2030-01-01T00:00:03Z') })).toBe(1);
    expect(repository.listPlatformsByReleaseId(releaseId).find((row) => row.platform === 'bluesky')).toMatchObject({
      session_id: 'session-1', status: 'pending', detail_code: null, message: null, attempts: 2,
      prepared_at: '2030-01-01 00:00:02', updated_at: '2030-01-01 00:00:03',
    });
  });

  it('replaces the selected set while retaining platform history and reselecting existing rows', () => {
    const first = new Date('2030-01-01T00:00:00Z');
    repository.replaceSelectedPlatforms(releaseId, ['x', 'bluesky', 'x'], { now: first });
    db.prepare(`UPDATE release_social_platforms
      SET status = 'posted', posted_at = '2030-01-02 00:00:00', attempts = 2,
          prepared_at = '2030-01-01 01:00:00', detail_code = 'done', message = 'History'
      WHERE release_id = ? AND platform = 'x'`).run(releaseId);
    const original = repository.listPlatformsByReleaseId(releaseId).find((row) => row.platform === 'x');

    expect(repository.replaceSelectedPlatforms(releaseId, ['bluesky', 'patreon']).map((row) => row.platform))
      .toEqual(['bluesky', 'patreon']);
    const deselected = repository.listPlatformsByReleaseId(releaseId).find((row) => row.platform === 'x');
    expect(deselected).toMatchObject({ ...original, is_selected: 0, updated_at: expect.any(String) });
    expect(repository.replaceSelectedPlatforms(releaseId, [])).toEqual([]);
    expect(repository.listPlatformsByReleaseId(releaseId).every((row) => row.is_selected === 0)).toBe(true);

    repository.ensurePlatforms(releaseId, ['x']);
    expect(repository.listPlatformsByReleaseId(releaseId).find((row) => row.platform === 'x').is_selected).toBe(0);
    expect(repository.replaceSelectedPlatforms(releaseId, ['x'])).toMatchObject([{
      platform: 'x', is_selected: 1, status: 'posted', attempts: 2,
      posted_at: '2030-01-02 00:00:00', prepared_at: '2030-01-01 01:00:00',
      detail_code: 'done', message: 'History',
    }]);
    expect(repository.listPlatformsByReleaseId(releaseId).filter((row) => row.is_selected).map((row) => row.platform)).toEqual(['x']);
  });

  it('guards the final posting write against deselection after eligibility was read', () => {
    insertSession();
    repository.replaceSelectedPlatforms(releaseId, ['x']);
    repository.reassignPlatformsToSession('session-1', ['x']);
    db.prepare("UPDATE release_social_platforms SET status = 'ready' WHERE release_id = ? AND platform = 'x'").run(releaseId);
    repository.redeemSession('session-1');
    repository.finishSession('session-1');
    const args = { releaseId, platform: 'x', sessionId: 'session-1', now: new Date('2030-01-01T00:01:00Z') };
    expect(repository.listPlatformsByReleaseId(releaseId).find((row) => row.platform === 'x'))
      .toMatchObject({ is_selected: 1, status: 'ready' });

    repository.replaceSelectedPlatforms(releaseId, []);
    const historical = repository.listPlatformsByReleaseId(releaseId).find((row) => row.platform === 'x');
    expect(repository.markPlatformPostedIfReady(args)).toBeUndefined();
    expect(repository.listPlatformsByReleaseId(releaseId).find((row) => row.platform === 'x'))
      .toEqual(historical);

    repository.replaceSelectedPlatforms(releaseId, ['x']);
    expect(repository.markPlatformPostedIfReady(args)).toMatchObject({ is_selected: 1, status: 'posted' });
  });

  it('rejects deselection of a live-session target atomically until the session is terminal', () => {
    repository.ensurePlatforms(releaseId, ['x', 'bluesky']);
    insertSession();
    repository.reassignPlatformsToSession('session-1', ['x']);
    const before = repository.listPlatformsByReleaseId(releaseId);
    expect(() => repository.replaceSelectedPlatforms(releaseId, ['bluesky', 'patreon']))
      .toThrow(expect.objectContaining({ code: 'PLATFORM_SELECTION_IN_PROGRESS' }));
    expect(repository.listPlatformsByReleaseId(releaseId)).toEqual(before);
    repository.redeemSession('session-1');
    expect(() => repository.replaceSelectedPlatforms(releaseId, ['bluesky', 'patreon']))
      .toThrow(expect.objectContaining({ code: 'PLATFORM_SELECTION_IN_PROGRESS' }));
    expect(repository.listPlatformsByReleaseId(releaseId)).toEqual(before);
    repository.finishSession('session-1');
    expect(repository.replaceSelectedPlatforms(releaseId, ['bluesky', 'patreon']).map((row) => row.platform))
      .toEqual(['bluesky', 'patreon']);
    expect(repository.listPlatformsByReleaseId(releaseId).find((row) => row.platform === 'x'))
      .toMatchObject({ is_selected: 0, session_id: 'session-1', attempts: 1 });
  });

  it('updates a platform only when the named session owns its release row and counts non-terminal session work', () => {
    insertSession();
    repository.ensurePlatforms(releaseId, ['bluesky', 'mastodon', 'x']);
    repository.reassignPlatformsToSession('session-1', ['bluesky', 'mastodon', 'x']);
    expect(repository.updatePlatformIfOwned({
      releaseId, platform: 'bluesky', sessionId: 'other-session', status: 'prepared',
    })).toBeUndefined();
    repository.updatePlatformIfOwned({ releaseId, platform: 'mastodon', sessionId: 'session-1', status: 'prepared' });
    repository.updatePlatformIfOwned({ releaseId, platform: 'x', sessionId: 'session-1', status: 'failed' });
    expect(repository.countSessionNonTerminalPlatforms('session-1')).toBe(1);
    repository.updatePlatformIfOwned({ releaseId, platform: 'bluesky', sessionId: 'session-1', status: 'staging' });
    expect(repository.countSessionNonTerminalPlatforms('session-1')).toBe(1);
    repository.updatePlatformIfOwned({ releaseId, platform: 'bluesky', sessionId: 'session-1', status: 'ready' });
    expect(repository.countSessionNonTerminalPlatforms('session-1')).toBe(0);
  });

  it('calculates last activity across the session and session-owned platforms in timestamp order', () => {
    insertSession({ now: new Date('2030-01-01T00:00:00Z') });
    repository.ensurePlatforms(releaseId, ['bluesky'], { now: new Date('2030-01-01T00:00:01Z') });
    repository.reassignPlatformsToSession('session-1', ['bluesky'], { now: new Date('2030-01-01T00:00:02Z') });
    expect(repository.findSessionLastActivityAt('session-1')).toBe('2030-01-01 00:00:02');
    expect(repository.findSessionLastActivityAt('missing')).toBeNull();
  });

  it('inserts, finds, counts, and orders immutable session asset snapshots', () => {
    insertSession();
    const snapshot = (assetId, sortOrder, filename) => repository.insertSessionAsset({
      sessionId: 'session-1', assetId, projectId, role: 'attachment', sortOrder,
      relativePath: `media/${filename}`, nestedPath: 'media', filename, extension: '.png',
      mimeType: 'image/png', sizeBytes: assetId, isPresent: assetId !== 2,
    });
    snapshot(3, 1, 'third.png');
    snapshot(2, 0, 'second.png');
    snapshot(1, 0, 'first.png');

    expect(repository.listSessionAssets('session-1').map((row) => row.asset_id)).toEqual([1, 2, 3]);
    expect(repository.findSessionAsset('session-1', 2)).toMatchObject({ filename: 'second.png', is_present: 0 });
    expect(repository.countSessionAssets('session-1')).toBe(3);
  });
});
