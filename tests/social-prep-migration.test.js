import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const MANUAL_STATES_MIGRATION = '036_add_manual_social_preparation_states.sql';
const POSTED_MIGRATION = '037_add_manual_social_post_confirmation.sql';

describe('social preparation migration', () => {
  let db;
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-social-prep-migration-'));
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createProjectAndRelease() {
    const projectId = Number(db.prepare(`
      INSERT INTO projects (title, slug, description, notes, status, project_type, patreon_url)
      VALUES ('Project', 'project', '', '', 'tbd', 'images', NULL)
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
    expect(sessionSql).toMatch(/manual_confirmation_expires_at TEXT/i);
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_social_prep_sessions_one_live_release'").pluck().get())
      .toMatch(/WHERE state IN \('issued', 'redeemed'\)/);

    const platformSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'release_social_platforms'").pluck().get();
    expect(platformSql).toMatch(/'pending', 'starting', 'preparing', 'uploading', 'auth_required', 'prepared', 'staging', 'ready', 'posted', 'failed', 'cancelled'/);
    expect(platformSql).toMatch(/attempts.*>= 0/i);
    expect(platformSql).toMatch(/prepared_at TEXT/i);
    expect(platformSql).toMatch(/posted_at TEXT/i);
    expect(platformSql).toMatch(/status = 'posted' AND posted_at IS NOT NULL/i);
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

  it('upgrades the current schema without changing legacy social history or SQLite sequences', () => {
    closeDatabase(db);
    const preManualStatesDir = path.join(tmpDir, 'migrations-through-035');
    fs.mkdirSync(preManualStatesDir);
    for (const filename of fs.readdirSync(MIGRATIONS_DIR).filter((name) => name < MANUAL_STATES_MIGRATION)) {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, filename), path.join(preManualStatesDir, filename));
    }
    db = openDatabase(path.join(tmpDir, 'upgrade.db'));
    runMigrations(db, preManualStatesDir);

    const projectId = Number(db.prepare(`
      INSERT INTO projects (title, slug, description, notes, status, project_type)
      VALUES ('Legacy project', 'legacy-project', '', '', 'tbd', 'images')
    `).run().lastInsertRowid);
    const releaseId = Number(db.prepare(`
      INSERT INTO releases (project_id, title, description, published_date, created_at, updated_at)
      VALUES (?, 'Legacy release', 'Preserve me', '2029-12-01', '2029-01-01 01:02:03', '2029-02-02 02:03:04')
    `).run(projectId).lastInsertRowid);
    const assetId = Number(db.prepare(`
      INSERT INTO assets (project_id, relative_path, filename, extension, mime_type, size_bytes)
      VALUES (?, 'legacy/image.png', 'image.png', '.png', 'image/png', 321)
    `).run(projectId).lastInsertRowid);
    db.prepare(`
      INSERT INTO social_prep_sessions (
        id, release_id, kind, state, intent_hash, media_token_hash, redeemed_at,
        attempt_deadline_at, expires_at, created_at, updated_at
      ) VALUES (
        'legacy-session', ?, 'retry', 'finished', 'intent-hash', 'media-hash',
        '2029-03-03 03:04:05', '2029-03-03 03:34:05', '2029-03-03 03:19:05',
        '2029-03-03 03:00:00', '2029-03-03 03:05:00'
      )
    `).run(releaseId);
    db.prepare(`
      INSERT INTO release_social_platforms (
        release_id, platform, session_id, status, detail_code, message, attempts,
        prepared_at, created_at, updated_at
      ) VALUES (
        ?, 'x', 'legacy-session', 'prepared', 'legacy-detail', 'Legacy message', 7,
        '2029-03-03 03:06:00', '2029-03-03 03:00:00', '2029-03-03 03:07:00'
      )
    `).run(releaseId);
    db.prepare(`
      INSERT INTO social_prep_session_assets (
        session_id, asset_id, project_id, role, sort_order, relative_path,
        nested_path, filename, extension, mime_type, size_bytes, is_present
      ) VALUES (
        'legacy-session', ?, ?, 'primary', 4, 'legacy/image.png', 'legacy',
        'image.png', '.png', 'image/png', 321, 1
      )
    `).run(assetId, projectId);

    const sessionBefore = db.prepare("SELECT * FROM social_prep_sessions WHERE id = 'legacy-session'").get();
    const platformBefore = db.prepare('SELECT * FROM release_social_platforms WHERE release_id = ?').get(releaseId);
    const snapshotBefore = db.prepare("SELECT * FROM social_prep_session_assets WHERE session_id = 'legacy-session'").get();
    const sequencesBefore = db.prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name').all();

    fs.copyFileSync(path.join(MIGRATIONS_DIR, MANUAL_STATES_MIGRATION), path.join(preManualStatesDir, MANUAL_STATES_MIGRATION));
    runMigrations(db, preManualStatesDir);

    expect(db.prepare("SELECT * FROM social_prep_sessions WHERE id = 'legacy-session'").get()).toEqual(sessionBefore);
    expect(db.prepare('SELECT * FROM release_social_platforms WHERE release_id = ?').get(releaseId)).toEqual(platformBefore);
    expect(db.prepare("SELECT * FROM social_prep_session_assets WHERE session_id = 'legacy-session'").get()).toEqual(snapshotBefore);
    expect(db.prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name').all()).toEqual(sequencesBefore);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_release_social_platforms_session_status'").pluck().get())
      .toBe('idx_release_social_platforms_session_status');
    expect(db.prepare("SELECT filename FROM schema_migrations WHERE filename = ?").pluck().get(MANUAL_STATES_MIGRATION))
      .toBe(MANUAL_STATES_MIGRATION);
  });

  it('accepts posted, manual preparation states, and every legacy status while still rejecting unknown values', () => {
    const { releaseId } = createProjectAndRelease();
    const insert = db.prepare('INSERT INTO release_social_platforms (release_id, platform, status) VALUES (?, ?, ?)');
    const statuses = ['pending', 'starting', 'preparing', 'uploading', 'auth_required', 'prepared', 'staging', 'ready', 'posted', 'failed', 'cancelled'];
    statuses.forEach((status, index) => {
      if (status === 'posted') {
        db.prepare("INSERT INTO release_social_platforms (release_id, platform, status, posted_at) VALUES (?, ?, 'posted', '2030-01-01 00:00:00')")
          .run(releaseId, `platform-${index}`);
      } else insert.run(releaseId, `platform-${index}`, status);
    });
    expect(db.prepare('SELECT status FROM release_social_platforms WHERE release_id = ? ORDER BY platform').pluck().all(releaseId))
      .toHaveLength(statuses.length);
    expect(() => insert.run(releaseId, 'invalid', 'unknown')).toThrow(/CHECK constraint failed/);
    expect(() => insert.run(releaseId, 'posted-without-time', 'posted')).toThrow(/CHECK constraint failed/);
    expect(() => db.prepare("INSERT INTO release_social_platforms (release_id, platform, status, posted_at) VALUES (?, 'ready-with-time', 'ready', '2030-01-01 00:00:00')").run(releaseId))
      .toThrow(/CHECK constraint failed/);
  });

  it('upgrades every pre-posted state without inferring confirmation or losing metadata', () => {
    closeDatabase(db);
    const prePostedDir = path.join(tmpDir, 'migrations-through-036');
    fs.mkdirSync(prePostedDir);
    for (const filename of fs.readdirSync(MIGRATIONS_DIR).filter((name) => name < POSTED_MIGRATION)) {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, filename), path.join(prePostedDir, filename));
    }
    db = openDatabase(path.join(tmpDir, 'posted-upgrade.db'));
    runMigrations(db, prePostedDir);
    const { releaseId } = createProjectAndRelease();
    insertSession(releaseId, 'migration-session', 'finished');
    const statuses = ['pending', 'starting', 'preparing', 'uploading', 'auth_required', 'prepared', 'staging', 'ready', 'failed', 'cancelled'];
    const insert = db.prepare(`INSERT INTO release_social_platforms
      (release_id, platform, session_id, status, detail_code, message, attempts, prepared_at, created_at, updated_at)
      VALUES (?, ?, 'migration-session', ?, ?, ?, ?, ?, '2029-01-01 00:00:00', '2029-02-01 00:00:00')`);
    statuses.forEach((status, index) => insert.run(
      releaseId, `platform-${index}`, status, `detail-${index}`, `message-${index}`, index,
      status === 'prepared' ? '2029-01-15 00:00:00' : null,
    ));
    const rowsBefore = db.prepare('SELECT * FROM release_social_platforms ORDER BY platform').all();
    const sessionBefore = db.prepare("SELECT * FROM social_prep_sessions WHERE id = 'migration-session'").get();
    const sequencesBefore = db.prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name').all();

    fs.copyFileSync(path.join(MIGRATIONS_DIR, POSTED_MIGRATION), path.join(prePostedDir, POSTED_MIGRATION));
    runMigrations(db, prePostedDir);

    expect(db.prepare('SELECT release_id, platform, session_id, status, detail_code, message, attempts, prepared_at, created_at, updated_at FROM release_social_platforms ORDER BY platform').all())
      .toEqual(rowsBefore);
    expect(db.prepare('SELECT posted_at FROM release_social_platforms').pluck().all()).toEqual(statuses.map(() => null));
    expect(db.prepare("SELECT id, release_id, kind, state, intent_hash, media_token_hash, redeemed_at, attempt_deadline_at, expires_at, created_at, updated_at FROM social_prep_sessions WHERE id = 'migration-session'").get())
      .toEqual(sessionBefore);
    expect(db.prepare("SELECT manual_confirmation_expires_at FROM social_prep_sessions WHERE id = 'migration-session'").pluck().get()).toBeNull();
    expect(db.prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name').all()).toEqual(sequencesBefore);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_release_social_platforms_session_status'").pluck().get())
      .toBe('idx_release_social_platforms_session_status');
  });
});
