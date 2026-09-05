import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function createPre028MigrationsDir(parentDir) {
  const legacyDir = path.join(parentDir, 'pre-028-migrations');
  fs.mkdirSync(legacyDir);
  for (const filename of fs.readdirSync(MIGRATIONS_DIR)) {
    if (filename < '028_remove_release_asset_source_role.sql') {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, filename), path.join(legacyDir, filename));
    }
  }
  return legacyDir;
}

describe('release asset source-role migration', () => {
  let db;
  let tmpDir;

  afterEach(() => {
    closeDatabase(db);
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('converts source to attachment without losing rows, identity, order, or foreign keys', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-release-assets-'));
    db = openDatabase(path.join(tmpDir, 'legacy.sqlite'));
    runMigrations(db, createPre028MigrationsDir(tmpDir));

    const projectId = Number(db.prepare(`
      INSERT INTO projects (title, slug, description, notes, status)
      VALUES ('Migration project', 'migration-project', '', '', 'tbd')
    `).run().lastInsertRowid);
    const releaseId = Number(db.prepare(`
      INSERT INTO releases (project_id, title) VALUES (?, 'Migration release')
    `).run(projectId).lastInsertRowid);
    const insertAsset = (filename) => Number(db.prepare(`
      INSERT INTO assets (project_id, relative_path, filename, mime_type, size_bytes)
      VALUES (?, ?, ?, 'text/plain', 1)
    `).run(projectId, `files/${filename}`, filename).lastInsertRowid);
    const sourceAssetId = insertAsset('source.txt');
    const primaryAssetId = insertAsset('primary.txt');
    const previewAssetId = insertAsset('preview.txt');
    const attachmentAssetId = insertAsset('attachment.txt');

    db.prepare(`
      INSERT INTO release_assets (release_id, asset_id, role, sort_order, created_at)
      VALUES
        (?, ?, 'source', 8, '2026-08-29 10:00:00'),
        (?, ?, 'primary', 1, '2026-08-29 10:01:00'),
        (?, ?, 'preview', 3, '2026-08-29 10:02:00'),
        (?, ?, 'attachment', 5, '2026-08-29 10:03:00')
    `).run(
      releaseId, sourceAssetId,
      releaseId, primaryAssetId,
      releaseId, previewAssetId,
      releaseId, attachmentAssetId,
    );

    runMigrations(db, MIGRATIONS_DIR);

    expect(db.prepare(`
      SELECT release_id, asset_id, role, sort_order, created_at
      FROM release_assets
      WHERE release_id = ?
      ORDER BY sort_order, asset_id
    `).all(releaseId)).toEqual([
      { release_id: releaseId, asset_id: primaryAssetId, role: 'primary', sort_order: 1, created_at: '2026-08-29 10:01:00' },
      { release_id: releaseId, asset_id: previewAssetId, role: 'preview', sort_order: 3, created_at: '2026-08-29 10:02:00' },
      { release_id: releaseId, asset_id: attachmentAssetId, role: 'attachment', sort_order: 5, created_at: '2026-08-29 10:03:00' },
      { release_id: releaseId, asset_id: sourceAssetId, role: 'attachment', sort_order: 8, created_at: '2026-08-29 10:00:00' },
    ]);
    expect(db.prepare('SELECT COUNT(*) FROM release_assets WHERE release_id = ?').pluck().get(releaseId)).toBe(4);

    const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'release_assets'").pluck().get();
    expect(ddl).toMatch(/CHECK\s*\(role IN \('primary', 'preview', 'attachment'\)\)/i);
    expect(ddl).toContain("DEFAULT 'attachment'");
    expect(ddl).toContain("DEFAULT (datetime('now'))");
    expect(ddl).not.toContain("'source'");
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'release_assets' AND name LIKE 'idx_release_assets_%' ORDER BY name").pluck().all())
      .toEqual(['idx_release_assets_asset_id', 'idx_release_assets_release_sort']);
    expect(() => db.prepare(`
      INSERT INTO release_assets (release_id, asset_id, role, sort_order)
      VALUES (?, ?, 'source', 9)
    `).run(releaseId, insertAsset('rejected-insert.txt'))).toThrow(/CHECK constraint failed/);
    expect(() => db.prepare(`
      UPDATE release_assets SET role = 'source' WHERE release_id = ? AND asset_id = ?
    `).run(releaseId, primaryAssetId)).toThrow(/CHECK constraint failed/);

    const insertRole = db.prepare(`
      INSERT INTO release_assets (release_id, asset_id, role, sort_order)
      VALUES (?, ?, ?, ?)
    `);
    for (const [role, filename, sortOrder] of [
      ['primary', 'accepted-primary.txt', 9],
      ['preview', 'accepted-preview.txt', 10],
      ['attachment', 'accepted-attachment.txt', 11],
    ]) {
      insertRole.run(releaseId, insertAsset(filename), role, sortOrder);
    }
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(() => db.prepare(`
      INSERT INTO release_assets (release_id, asset_id, role, sort_order)
      VALUES (?, ?, 'attachment', 12)
    `).run(999999, sourceAssetId)).toThrow(/FOREIGN KEY constraint failed/);
    db.prepare('DELETE FROM assets WHERE id = ?').run(sourceAssetId);
    expect(db.prepare('SELECT COUNT(*) FROM release_assets WHERE release_id = ? AND asset_id = ?').pluck().get(releaseId, sourceAssetId)).toBe(0);
  });
});
