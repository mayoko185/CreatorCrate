import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const LEGACY_MIGRATION_FILENAMES = [
  '001_initial.sql',
  '002_add_completed_status.sql',
  '003_remove_project_priority.sql',
  '004_add_primary_image_provenance.sql',
  '005_add_notes_table.sql',
  '006_add_note_associations.sql',
];

function createLegacyMigrationsDir(parentDir) {
  const legacyDir = path.join(parentDir, 'legacy-migrations');
  fs.mkdirSync(legacyDir);
  for (const filename of LEGACY_MIGRATION_FILENAMES) {
    fs.copyFileSync(path.join(MIGRATIONS_DIR, filename), path.join(legacyDir, filename));
  }
  return legacyDir;
}

describe('asset picker order-index migration', () => {
  let tmpDir;
  let db;

  afterEach(() => {
    closeDatabase(db);
    db = undefined;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('adds the index to an existing schema without changing existing asset data', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-asset-picker-migration-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, createLegacyMigrationsDir(tmpDir));

    const projectId = Number(db.prepare(`
      INSERT INTO projects (title, slug, status) VALUES ('Legacy Project', 'legacy-project', 'tbd')
    `).run().lastInsertRowid);
    const assetId = Number(db.prepare(`
      INSERT INTO assets (project_id, relative_path, filename, is_present)
      VALUES (?, 'history/missing.png', 'missing.png', 0)
    `).run(projectId).lastInsertRowid);
    const before = db.prepare(`
      SELECT id, project_id, relative_path, filename, is_present FROM assets WHERE id = ?
    `).get(assetId);

    runMigrations(db, MIGRATIONS_DIR);
    runMigrations(db, MIGRATIONS_DIR);

    expect(db.pragma("index_list('assets')")).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'idx_assets_picker_project_filename' }),
    ]));
    expect(db.prepare(`
      SELECT id, project_id, relative_path, filename, is_present FROM assets WHERE id = ?
    `).get(assetId)).toEqual(before);
    expect(db.prepare('SELECT filename FROM schema_migrations ORDER BY rowid').pluck().all())
      .toContain('007_add_asset_picker_order_index.sql');
  });
});
