import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { buildAssetRevisionToken } from '../src/services/preview-service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const MIGRATION = '040_add_asset_source_generation.sql';

function createPreMigrationsDir(parentDir) {
  const legacyDir = path.join(parentDir, 'pre-040-migrations');
  fs.mkdirSync(legacyDir);
  for (const filename of fs.readdirSync(MIGRATIONS_DIR)) {
    if (filename < MIGRATION) {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, filename), path.join(legacyDir, filename));
    }
  }
  return legacyDir;
}

describe('asset source generation migration', () => {
  let db;
  let tmpDir;

  afterEach(() => {
    closeDatabase(db);
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('starts existing and new assets at generation 0 without changing their revisions', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-source-generation-'));
    db = openDatabase(path.join(tmpDir, 'legacy.sqlite'));
    runMigrations(db, createPreMigrationsDir(tmpDir));

    const projectId = Number(db.prepare(`
      INSERT INTO projects (title, slug, description, notes, status, project_type)
      VALUES ('Migration project', 'migration-project', '', '', 'tbd', 'images')
    `).run().lastInsertRowid);
    const insertAsset = db.prepare(`
      INSERT INTO assets (project_id, relative_path, filename, extension, mime_type, size_bytes, modified_at)
      VALUES (?, ?, ?, 'png', 'image/png', 4096, '2026-07-28T12:00:00.000Z')
    `);
    const assetId = Number(insertAsset.run(projectId, 'art.png', 'art.png').lastInsertRowid);
    const legacyRow = db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId);
    expect(legacyRow).not.toHaveProperty('source_generation');
    const legacyRevision = buildAssetRevisionToken(legacyRow, '0123456789abcdef');

    runMigrations(db, MIGRATIONS_DIR);
    runMigrations(db, MIGRATIONS_DIR);

    const migrated = db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId);
    expect(migrated.source_generation).toBe(0);
    expect(buildAssetRevisionToken(migrated, '0123456789abcdef')).toBe(legacyRevision);

    const newId = Number(insertAsset.run(projectId, 'new.png', 'new.png').lastInsertRowid);
    expect(db.prepare('SELECT source_generation FROM assets WHERE id = ?').pluck().get(newId)).toBe(0);
    expect(() => db.prepare('UPDATE assets SET source_generation = -1 WHERE id = ?').run(newId))
      .toThrow(/CHECK constraint failed/i);
    expect(db.prepare('SELECT filename FROM schema_migrations WHERE filename = ?').pluck().get(MIGRATION))
      .toBe(MIGRATION);
  });
});
