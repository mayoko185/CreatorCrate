import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createProjectRepository } from '../src/data/project-repository.js';

const REAL_MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const MIGRATION_011 = '011_asset_category_assignments.sql';
const MIGRATION_012 = '012_asset_browser_preferences.sql';
const GLOBAL_DEFAULT_KEY = 'asset_browser.default_category';

function copyMigrationsUpTo(destDir, lastFilename) {
  const files = fs.readdirSync(REAL_MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort();
  for (const filename of files) {
    if (lastFilename && filename > lastFilename) continue;
    fs.copyFileSync(path.join(REAL_MIGRATIONS_DIR, filename), path.join(destDir, filename));
  }
}

function createProject(repository, title) {
  return repository.create({
    title,
    slug: title.toLowerCase().replaceAll(' ', '-'),
    description: '',
    notes: '',
    status: 'tbd',
    priority: 'normal',
    plannedDate: null,
    publishedDate: null,
    patreonUrl: null,
  });
}

describe('asset-browser preference migration (012)', () => {
  let tmpDir;
  let dbPath;
  let db;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-asset-browser-preferences-'));
    dbPath = path.join(tmpDir, 'test.db');
  });

  afterEach(() => {
    closeDatabase(db);
    db = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('applies after migration 011 and records migration 012 in order', () => {
    db = openDatabase(dbPath);

    expect(() => runMigrations(db, REAL_MIGRATIONS_DIR)).not.toThrow();

    const applied = db.prepare('SELECT filename FROM schema_migrations ORDER BY rowid').pluck().all();
    expect(applied).toContain(MIGRATION_011);
    expect(applied).toContain(MIGRATION_012);
    expect(applied.indexOf(MIGRATION_012)).toBeGreaterThan(applied.indexOf(MIGRATION_011));
  });

  it('creates the preference table with timestamps, project cascade, and no category foreign key', () => {
    db = openDatabase(dbPath);
    runMigrations(db, REAL_MIGRATIONS_DIR);

    const columns = db.pragma('table_info(project_asset_browser_preferences)').map((column) => column.name);
    expect(columns).toEqual([
      'project_id',
      'default_category_mode',
      'default_category_id',
      'created_at',
      'updated_at',
    ]);

    const ddl = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'project_asset_browser_preferences'")
      .pluck()
      .get();
    expect(ddl).toMatch(/FOREIGN KEY\s*\(project_id\)\s*REFERENCES\s*projects\(id\)\s*ON\s+DELETE\s+CASCADE/i);
    expect(ddl).not.toMatch(/FOREIGN KEY\s*\(default_category_id\)/i);
  });

  it('backfills existing projects as inherit and defaults missing global metadata to all', () => {
    copyMigrationsUpTo(tmpDir, MIGRATION_011);
    db = openDatabase(dbPath);
    runMigrations(db, tmpDir);

    const projectRepository = createProjectRepository(db);
    const first = createProject(projectRepository, 'Existing One');
    const second = createProject(projectRepository, 'Existing Two');

    runMigrations(db, REAL_MIGRATIONS_DIR);

    const preferences = db.prepare(`
      SELECT project_id, default_category_mode, default_category_id
      FROM project_asset_browser_preferences
      ORDER BY project_id
    `).all();
    expect(preferences).toEqual([
      { project_id: first.id, default_category_mode: 'inherit', default_category_id: null },
      { project_id: second.id, default_category_mode: 'inherit', default_category_id: null },
    ]);
    expect(db.prepare('SELECT value FROM app_meta WHERE key = ?').pluck().get(GLOBAL_DEFAULT_KEY)).toBe('all');
  });

  it('does not overwrite an existing global metadata value', () => {
    copyMigrationsUpTo(tmpDir, MIGRATION_011);
    db = openDatabase(dbPath);
    runMigrations(db, tmpDir);
    db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)').run(GLOBAL_DEFAULT_KEY, 'exports');

    runMigrations(db, REAL_MIGRATIONS_DIR);

    expect(db.prepare('SELECT value FROM app_meta WHERE key = ?').pluck().get(GLOBAL_DEFAULT_KEY)).toBe('exports');
  });

  it('cascades preference deletion when a project is deleted', () => {
    db = openDatabase(dbPath);
    runMigrations(db, REAL_MIGRATIONS_DIR);
    const projectRepository = createProjectRepository(db);
    const project = createProject(projectRepository, 'Cascade Project');

    db.prepare(`
      UPDATE project_asset_browser_preferences
      SET default_category_mode = 'all'
      WHERE project_id = ?
    `).run(project.id);
    db.prepare('DELETE FROM projects WHERE id = ?').run(project.id);

    expect(db.prepare('SELECT COUNT(*) AS count FROM project_asset_browser_preferences WHERE project_id = ?').get(project.id).count)
      .toBe(0);
  });

  describe('mode and shape constraints', () => {
    let projectId;

    beforeEach(() => {
      db = openDatabase(dbPath);
      runMigrations(db, REAL_MIGRATIONS_DIR);
      projectId = createProject(createProjectRepository(db), 'Constraint Project').id;
    });

    it('rejects an unknown mode', () => {
      expect(() => db.prepare(`
        INSERT INTO project_asset_browser_preferences (project_id, default_category_mode, default_category_id)
        VALUES (?, 'unknown', NULL)
      `).run(projectId)).toThrow(/CHECK constraint failed/i);
    });

    it('rejects category mode with a null category ID', () => {
      expect(() => db.prepare(`
        INSERT INTO project_asset_browser_preferences (project_id, default_category_mode, default_category_id)
        VALUES (?, 'category', NULL)
      `).run(projectId)).toThrow(/CHECK constraint failed/i);
    });

    it('rejects inherit mode with a non-null category ID', () => {
      expect(() => db.prepare(`
        INSERT INTO project_asset_browser_preferences (project_id, default_category_mode, default_category_id)
        VALUES (?, 'inherit', 1)
      `).run(projectId)).toThrow(/CHECK constraint failed/i);
    });

    it('rejects all mode with a non-null category ID', () => {
      expect(() => db.prepare(`
        INSERT INTO project_asset_browser_preferences (project_id, default_category_mode, default_category_id)
        VALUES (?, 'all', 1)
      `).run(projectId)).toThrow(/CHECK constraint failed/i);
    });
  });

  it('applies cleanly to a pre-Phase-B database', () => {
    copyMigrationsUpTo(tmpDir, MIGRATION_011);
    db = openDatabase(dbPath);
    runMigrations(db, tmpDir);

    expect(() => runMigrations(db, REAL_MIGRATIONS_DIR)).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS count FROM project_asset_browser_preferences').get().count).toBe(0);
    expect(db.prepare('SELECT value FROM app_meta WHERE key = ?').pluck().get(GLOBAL_DEFAULT_KEY)).toBe('all');
  });
});
