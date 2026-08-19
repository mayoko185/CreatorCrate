import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const MIGRATION_FILENAME = '022_add_project_type.sql';

function createPreProjectTypeMigrationsDir(parentDir) {
  const legacyDir = path.join(parentDir, 'pre-project-type-migrations');
  fs.mkdirSync(legacyDir);
  for (const filename of fs.readdirSync(MIGRATIONS_DIR)) {
    if (filename.endsWith('.sql') && filename.localeCompare(MIGRATION_FILENAME) < 0) {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, filename), path.join(legacyDir, filename));
    }
  }
  return legacyDir;
}

describe('project type migration', () => {
  let tmpDir;
  let db;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-project-type-'));
  });

  afterEach(() => {
    closeDatabase(db);
    db = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('adds the non-null project_type column and migrates existing projects to images', () => {
    db = openDatabase(path.join(tmpDir, 'upgrade.db'));
    runMigrations(db, createPreProjectTypeMigrationsDir(tmpDir));
    const existingId = Number(db.prepare(`
      INSERT INTO projects (title, slug, status) VALUES ('Existing', 'existing', 'ready')
    `).run().lastInsertRowid);

    runMigrations(db, MIGRATIONS_DIR);

    expect(db.pragma('table_info(projects)')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'project_type', type: 'TEXT', notnull: 1, dflt_value: "'images'",
      }),
    ]));
    expect(db.prepare('SELECT project_type FROM projects WHERE id = ?').pluck().get(existingId))
      .toBe('images');
  });

  it('defaults new rows, accepts every allowed type, and rejects invalid database values', () => {
    db = openDatabase(path.join(tmpDir, 'fresh.db'));
    runMigrations(db, MIGRATIONS_DIR);

    const insert = db.prepare('INSERT INTO projects (title, slug, project_type) VALUES (?, ?, ?)');
    for (const projectType of ['images', 'comic', 'animation', 'wallpaper']) {
      insert.run(projectType, `project-${projectType}`, projectType);
    }
    db.prepare("INSERT INTO projects (title, slug) VALUES ('Default', 'default')").run();

    expect(db.prepare('SELECT project_type FROM projects ORDER BY id').pluck().all())
      .toEqual(['images', 'comic', 'animation', 'wallpaper', 'images']);
    expect(() => insert.run('Invalid', 'invalid', 'video')).toThrow(/CHECK constraint failed/i);
  });
});
