import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const MIGRATION_FILENAME = '032_remove_project_scheduling.sql';
const RETAINED_PROJECT_COLUMNS = [
  'id',
  'title',
  'slug',
  'description',
  'notes',
  'status',
  'project_type',
  'patreon_url',
  'created_at',
  'updated_at',
  'archived_at',
  'project_dir',
];
const PROJECT_INDEXES = [
  'idx_projects_archived_updated',
  'idx_projects_status_archived',
  'idx_projects_title',
  'idx_projects_description',
  'idx_projects_notes',
  'idx_projects_project_dir',
];
const PROJECT_INDEX_SQL = {
  idx_projects_archived_updated: /\(archived_at,\s*updated_at DESC\)/i,
  idx_projects_status_archived: /\(status,\s*archived_at\)/i,
  idx_projects_title: /\(title COLLATE NOCASE\)/i,
  idx_projects_description: /\(description COLLATE NOCASE\)/i,
  idx_projects_notes: /\(notes COLLATE NOCASE\)/i,
  idx_projects_project_dir: /\(project_dir\)/i,
};

function copyPre032Migrations(parentDir) {
  const target = path.join(parentDir, 'pre-032');
  fs.mkdirSync(target);
  for (const filename of fs.readdirSync(MIGRATIONS_DIR)) {
    if (filename.endsWith('.sql') && filename.localeCompare(MIGRATION_FILENAME) < 0) {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, filename), path.join(target, filename));
    }
  }
  return target;
}

function addMigration(target, sql = fs.readFileSync(path.join(MIGRATIONS_DIR, MIGRATION_FILENAME), 'utf8')) {
  fs.writeFileSync(path.join(target, MIGRATION_FILENAME), sql);
}

function projectColumns(db) {
  return db.pragma("table_info('projects')").map(({ name }) => name);
}

function projectTableSql(db) {
  return db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'projects'")
    .pluck()
    .get();
}

function projectSequence(db) {
  return db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'projects'").pluck().get();
}

describe('Project scheduling migration (032)', () => {
  let tmpDir;
  let db;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-project-scheduling-'));
  });

  afterEach(() => {
    closeDatabase(db);
    db = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('removes only Project dates while preserving retained values, Releases, children, and indexes', () => {
    db = openDatabase(path.join(tmpDir, 'populated.db'));
    const migrations = copyPre032Migrations(tmpDir);
    runMigrations(db, migrations);

    db.prepare(`
      INSERT INTO projects (
        id, title, slug, description, notes, status, planned_date, published_date,
        patreon_url, created_at, updated_at, archived_at, project_dir, project_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      7,
      'Retained Project',
      'retained-project',
      'Description',
      'Notes',
      'in-progress',
      '2026-09-15',
      '2026-09-20',
      'https://example.test/patreon',
      '2026-09-01 10:00:00',
      '2026-09-02 11:00:00',
      null,
      '000007-retained-project',
      'comic'
    );
    db.prepare(`
      INSERT INTO releases (
        id, project_id, title, description, notes, planned_date, planned_time,
        published_date, patreon_url, created_at, updated_at, archived_at
      ) VALUES (3, 7, 'Release', 'Release description', 'Release notes',
        '2026-10-01', '14:30', '2026-10-02', 'https://example.test/release',
        '2026-09-03 12:00:00', '2026-09-04 13:00:00', NULL)
    `).run();
    const categoryId = Number(db.prepare(`
      INSERT INTO project_asset_categories (project_id, display_name, directory_slug)
      VALUES (7, 'Final', 'final-retained')
    `).run().lastInsertRowid);
    const assetId = Number(db.prepare(`
      INSERT INTO assets (
        project_id, category_id, relative_path, filename, extension, mime_type,
        size_bytes, is_present, last_seen_at
      ) VALUES (7, ?, 'final-retained/cover.png', 'cover.png', 'png', 'image/png', 10, 1, datetime('now'))
    `).run(categoryId).lastInsertRowid);
    db.prepare('INSERT INTO project_primary_images (project_id, asset_id) VALUES (7, ?)').run(assetId);

    const releaseBefore = db.prepare(`
      SELECT id, project_id, title, description, notes, planned_date, planned_time,
        published_date, patreon_url, created_at, updated_at, archived_at
      FROM releases WHERE id = 3
    `).get();

    addMigration(migrations);
    runMigrations(db, migrations);

    expect(projectColumns(db)).toEqual(RETAINED_PROJECT_COLUMNS);
    expect(projectTableSql(db)).not.toMatch(/planned_date|published_date|projects_planned_date_format|projects_published_date_format/i);
    expect(db.prepare(`SELECT ${RETAINED_PROJECT_COLUMNS.join(', ')} FROM projects WHERE id = 7`).get())
      .toEqual({
        id: 7,
        title: 'Retained Project',
        slug: 'retained-project',
        description: 'Description',
        notes: 'Notes',
        status: 'in-progress',
        project_type: 'comic',
        patreon_url: 'https://example.test/patreon',
        created_at: '2026-09-01 10:00:00',
        updated_at: '2026-09-02 11:00:00',
        archived_at: null,
        project_dir: '000007-retained-project',
      });
    expect(db.prepare(`
      SELECT id, project_id, title, description, notes, planned_date, planned_time,
        published_date, patreon_url, created_at, updated_at, archived_at
      FROM releases WHERE id = 3
    `).get()).toEqual(releaseBefore);
    expect(db.prepare('SELECT project_id, category_id FROM assets WHERE id = ?').get(assetId))
      .toEqual({ project_id: 7, category_id: categoryId });
    expect(db.prepare('SELECT project_id, asset_id FROM project_primary_images WHERE project_id = 7').get())
      .toEqual({ project_id: 7, asset_id: assetId });
    expect(db.pragma("index_list('projects')").map(({ name }) => name))
      .toEqual(expect.arrayContaining(PROJECT_INDEXES));
    for (const [name, pattern] of Object.entries(PROJECT_INDEX_SQL)) {
      expect(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
        .pluck()
        .get(name)).toMatch(pattern);
    }
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('preserves a deleted highest Project ID in sqlite_sequence', () => {
    db = openDatabase(path.join(tmpDir, 'deleted-high-water.db'));
    const migrations = copyPre032Migrations(tmpDir);
    runMigrations(db, migrations);
    db.prepare("INSERT INTO projects (id, title, slug) VALUES (7, 'Retained', 'retained')").run();
    db.prepare("INSERT INTO projects (id, title, slug) VALUES (99, 'Deleted', 'deleted')").run();
    db.prepare('DELETE FROM projects WHERE id = 99').run();
    expect(projectSequence(db)).toBe(99);

    addMigration(migrations);
    runMigrations(db, migrations);

    expect(projectSequence(db)).toBe(99);
    expect(db.prepare("INSERT INTO projects (title, slug) VALUES ('Next', 'next')").run().lastInsertRowid)
      .toBe(100);
  });

  it('preserves an empty Project table historical sequence', () => {
    db = openDatabase(path.join(tmpDir, 'empty-high-water.db'));
    const migrations = copyPre032Migrations(tmpDir);
    runMigrations(db, migrations);
    db.prepare("INSERT INTO projects (id, title, slug) VALUES (42, 'Deleted', 'deleted')").run();
    db.prepare('DELETE FROM projects').run();

    addMigration(migrations);
    runMigrations(db, migrations);

    expect(db.prepare('SELECT COUNT(*) FROM projects').pluck().get()).toBe(0);
    expect(projectSequence(db)).toBe(42);
    expect(db.prepare("INSERT INTO projects (title, slug) VALUES ('Next', 'next')").run().lastInsertRowid)
      .toBe(43);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('rolls back the schema, data, sequence, and migration record when execution fails', () => {
    db = openDatabase(path.join(tmpDir, 'rollback.db'));
    const migrations = copyPre032Migrations(tmpDir);
    runMigrations(db, migrations);
    db.prepare(`
      INSERT INTO projects (id, title, slug, planned_date, published_date)
      VALUES (17, 'Original', 'original', '2026-11-01', '2026-11-02')
    `).run();
    db.prepare("INSERT INTO releases (project_id, title) VALUES (17, 'Child')").run();
    const originalSql = projectTableSql(db);
    const originalSequence = projectSequence(db);
    addMigration(migrations, `${fs.readFileSync(path.join(MIGRATIONS_DIR, MIGRATION_FILENAME), 'utf8')}\nSELECT * FROM migration_failure;\n`);

    expect(() => runMigrations(db, migrations)).toThrow(`Migration "${MIGRATION_FILENAME}" failed.`);

    expect(projectTableSql(db)).toBe(originalSql);
    expect(projectColumns(db)).toContain('planned_date');
    expect(projectColumns(db)).toContain('published_date');
    expect(db.prepare('SELECT id, planned_date, published_date FROM projects').get())
      .toEqual({ id: 17, planned_date: '2026-11-01', published_date: '2026-11-02' });
    expect(db.prepare('SELECT project_id, title FROM releases').get())
      .toEqual({ project_id: 17, title: 'Child' });
    expect(projectSequence(db)).toBe(originalSequence);
    expect(db.prepare('SELECT 1 FROM schema_migrations WHERE filename = ?').get(MIGRATION_FILENAME))
      .toBeUndefined();
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projects_new'").get())
      .toBeUndefined();
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('is safe on a current database and is not reapplied by repeated migration runs', () => {
    db = openDatabase(path.join(tmpDir, 'current.db'));
    runMigrations(db, MIGRATIONS_DIR);
    const tableSql = projectTableSql(db);
    const columns = Object.fromEntries(
      db.pragma("table_info('projects')").map((column) => [column.name, column])
    );
    const appliedAt = db.prepare('SELECT applied_at FROM schema_migrations WHERE filename = ?')
      .pluck()
      .get(MIGRATION_FILENAME);

    expect(columns.description).toMatchObject({ notnull: 1, dflt_value: "''" });
    expect(columns.notes).toMatchObject({ notnull: 1, dflt_value: "''" });
    expect(columns.status).toMatchObject({ notnull: 1, dflt_value: "'tbd'" });
    expect(columns.project_type).toMatchObject({ notnull: 1, dflt_value: "'images'" });
    expect(columns.created_at).toMatchObject({ notnull: 1, dflt_value: "datetime('now')" });
    expect(columns.updated_at).toMatchObject({ notnull: 1, dflt_value: "datetime('now')" });
    expect(tableSql).toMatch(/projects_status CHECK \(status IN \('tbd', 'planned', 'in-progress', 'ready', 'completed', 'archived'\)\)/i);
    expect(tableSql).toMatch(/CHECK \(project_type IN \('images', 'comic', 'animation', 'wallpaper'\)\)/i);
    db.prepare("INSERT INTO projects (title, slug) VALUES ('Defaults', 'defaults')").run();
    expect(db.prepare("SELECT description, notes, status, project_type FROM projects WHERE slug = 'defaults'").get())
      .toEqual({ description: '', notes: '', status: 'tbd', project_type: 'images' });
    expect(() => db.prepare("INSERT INTO projects (title, slug) VALUES ('Duplicate', 'defaults')").run())
      .toThrow(/UNIQUE constraint failed/i);
    expect(() => db.prepare("INSERT INTO projects (title, slug, status) VALUES ('Invalid', 'invalid-status', 'published')").run())
      .toThrow(/CHECK constraint failed/i);
    expect(() => db.prepare("INSERT INTO projects (title, slug, project_type) VALUES ('Invalid', 'invalid-type', 'video')").run())
      .toThrow(/CHECK constraint failed/i);

    runMigrations(db, MIGRATIONS_DIR);

    expect(projectTableSql(db)).toBe(tableSql);
    expect(db.prepare('SELECT applied_at FROM schema_migrations WHERE filename = ?').pluck().get(MIGRATION_FILENAME))
      .toBe(appliedAt);
    expect(db.prepare('SELECT filename FROM schema_migrations WHERE filename = ?').pluck().all(MIGRATION_FILENAME))
      .toEqual([MIGRATION_FILENAME]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});
