import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('social preparation migration', () => {
  let db;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  function createProjectAndRelease() {
    const projectId = Number(db.prepare(`
      INSERT INTO projects (title, slug, description, notes, status, planned_date, published_date, patreon_url)
      VALUES ('Project', 'project', '', '', 'tbd', NULL, NULL, NULL)
    `).run().lastInsertRowid);
    const releaseId = Number(db.prepare(`
      INSERT INTO releases (project_id, title) VALUES (?, 'Release')
    `).run(projectId).lastInsertRowid);
    return { projectId, releaseId };
  }

  function insertSession(releaseId, id, state = 'issued') {
    db.prepare(`
      INSERT INTO social_prep_sessions (id, release_id, kind, state, expires_at)
      VALUES (?, ?, 'initial', ?, '2030-01-01 00:00:00')
    `).run(id, releaseId, state);
  }

  it('creates the approved tables, state checks, indexes, and foreign keys', () => {
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'social_prep_%' ORDER BY name").pluck().all())
      .toEqual(['social_prep_session_assets', 'social_prep_sessions']);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'release_social_platforms'").pluck().get())
      .toBe('release_social_platforms');

    const sessionSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'social_prep_sessions'").pluck().get();
    expect(sessionSql).toMatch(/'initial', 'retry', 'reprepare'/);
    expect(sessionSql).toMatch(/'issued', 'redeemed', 'finished', 'expired', 'superseded'/);
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_social_prep_sessions_one_live_release'").pluck().get())
      .toMatch(/WHERE state IN \('issued', 'redeemed'\)/);

    const platformSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'release_social_platforms'").pluck().get();
    expect(platformSql).toMatch(/'pending', 'starting', 'preparing', 'uploading', 'auth_required', 'prepared', 'failed', 'cancelled'/);
    expect(platformSql).toMatch(/attempts.*>= 0/i);
    expect(platformSql).toMatch(/prepared_at TEXT/i);
    expect(db.prepare("SELECT \"on_delete\" FROM pragma_foreign_key_list('release_social_platforms') WHERE \"from\" = 'session_id'").pluck().get())
      .toBe('SET NULL');

    const snapshotSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'social_prep_session_assets'").pluck().get();
    for (const column of ['asset_id', 'project_id', 'role', 'sort_order', 'relative_path', 'nested_path', 'filename', 'extension', 'mime_type', 'size_bytes', 'is_present']) {
      expect(snapshotSql).toContain(column);
    }
    expect(db.prepare("SELECT \"on_delete\" FROM pragma_foreign_key_list('social_prep_session_assets') WHERE \"from\" = 'session_id'").pluck().get())
      .toBe('CASCADE');
    expect(db.prepare("SELECT COUNT(*) FROM pragma_foreign_key_list('social_prep_session_assets') WHERE \"from\" IN ('asset_id', 'project_id')").pluck().get())
      .toBe(0);
    expect(snapshotSql).toMatch(/CHECK\s*\(role IN \('primary', 'preview', 'attachment'\)\)/i);
  });

  it('accepts only the final release roles in session snapshots', () => {
    const { projectId, releaseId } = createProjectAndRelease();
    insertSession(releaseId, 'role-session');
    const insertSnapshot = db.prepare(`
      INSERT INTO social_prep_session_assets
        (session_id, asset_id, project_id, role, sort_order, relative_path, filename, mime_type, size_bytes, is_present)
      VALUES ('role-session', ?, ?, ?, ?, 'snapshot.png', 'snapshot.png', 'image/png', 1, 1)
    `);

    for (const [assetId, role] of [[1, 'primary'], [2, 'preview'], [3, 'attachment']]) {
      insertSnapshot.run(assetId, projectId, role, assetId);
    }
    expect(() => insertSnapshot.run(4, projectId, 'source', 4)).toThrow(/CHECK constraint failed/);
  });

  it('allows only one issued or redeemed session per release, while terminal sessions permit another', () => {
    const { releaseId } = createProjectAndRelease();
    insertSession(releaseId, 'first');
    expect(() => insertSession(releaseId, 'second')).toThrow(/UNIQUE constraint failed/);

    db.prepare("UPDATE social_prep_sessions SET state = 'expired' WHERE id = 'first'").run();
    insertSession(releaseId, 'second');
    expect(db.prepare('SELECT state FROM social_prep_sessions WHERE id = ?').pluck().get('second')).toBe('issued');
  });

  it('cascades session snapshots, clears platform ownership, and preserves snapshots after source-asset deletion', () => {
    const { projectId, releaseId } = createProjectAndRelease();
    const assetId = Number(db.prepare(`
      INSERT INTO assets (project_id, relative_path, filename, mime_type, size_bytes)
      VALUES (?, 'source/a.png', 'a.png', 'image/png', 5)
    `).run(projectId).lastInsertRowid);
    insertSession(releaseId, 'asset-session');
    db.prepare(`
      INSERT INTO release_social_platforms (release_id, platform, session_id)
      VALUES (?, 'bluesky', 'asset-session')
    `).run(releaseId);
    db.prepare(`
      INSERT INTO social_prep_session_assets
        (session_id, asset_id, project_id, role, sort_order, relative_path, filename, mime_type, size_bytes, is_present)
      VALUES ('asset-session', ?, ?, 'primary', 0, 'source/a.png', 'a.png', 'image/png', 5, 0)
    `).run(assetId, projectId);

    db.prepare('DELETE FROM assets WHERE id = ?').run(assetId);
    expect(db.prepare('SELECT asset_id, is_present FROM social_prep_session_assets WHERE session_id = ?').get('asset-session'))
      .toEqual({ asset_id: assetId, is_present: 0 });

    db.prepare('DELETE FROM social_prep_sessions WHERE id = ?').run('asset-session');
    expect(db.prepare('SELECT session_id FROM release_social_platforms WHERE release_id = ?').pluck().get(releaseId)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) FROM social_prep_session_assets').pluck().get()).toBe(0);
  });

  it('retains the assets AUTOINCREMENT non-reuse invariant used by snapshots', () => {
    const { projectId } = createProjectAndRelease();
    const insertAsset = (filename) => Number(db.prepare(`
      INSERT INTO assets (project_id, relative_path, filename, mime_type, size_bytes)
      VALUES (?, ?, ?, 'image/png', 1)
    `).run(projectId, `source/${filename}`, filename).lastInsertRowid);

    const first = insertAsset('first.png');
    db.prepare('DELETE FROM assets WHERE id = ?').run(first);
    const second = insertAsset('second.png');
    expect(second).toBeGreaterThan(first);
  });
});
