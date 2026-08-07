import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createProjectRepository } from '../src/data/project-repository.js';

const GLOBAL_DEFAULT_KEY = 'asset_browser.default_category';
const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

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

describe('asset-browser preferences in the baseline schema', () => {
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

  it('records the single consolidated migration', () => {
    db = openDatabase(dbPath);

    expect(() => runMigrations(db, MIGRATIONS_DIR)).not.toThrow();

    const applied = db.prepare('SELECT filename FROM schema_migrations ORDER BY rowid').pluck().all();
    expect(applied).toEqual(['001_initial.sql']);
  });

  it('creates the preference table with timestamps, project cascade, and no category foreign key', () => {
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);

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

  it('does not overwrite an existing global metadata value on repeated runs', () => {
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    db.prepare('UPDATE app_meta SET value = ? WHERE key = ?').run('exports', GLOBAL_DEFAULT_KEY);

    runMigrations(db, MIGRATIONS_DIR);

    expect(db.prepare('SELECT value FROM app_meta WHERE key = ?').pluck().get(GLOBAL_DEFAULT_KEY)).toBe('exports');
  });

  it('cascades preference deletion when a project is deleted', () => {
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
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
      runMigrations(db, MIGRATIONS_DIR);
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

});
