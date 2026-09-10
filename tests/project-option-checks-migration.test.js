import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const MIGRATION_FILENAME = '033_remove_project_option_checks.sql';
const PROJECT_COLUMNS = [
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
const STATUS_CATALOGUE_KEY = 'project_options.status_catalogue';
const TYPE_CATALOGUE_KEY = 'project_options.project_type_catalogue';

function copyPre033Migrations(parentDir) {
  const target = path.join(parentDir, 'pre-033');
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

function projectTableSql(db) {
  return db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'projects'")
    .pluck()
    .get();
}

function projectSequence(db) {
  return db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'projects'").pluck().get();
}

describe('Project option CHECK removal migration (033)', () => {
  let tmpDir;
  let db;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-project-options-'));
  });

  afterEach(() => {
    closeDatabase(db);
    db = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('preserves every built-in value, unrelated fields, children, indexes, and defaults', () => {
    db = openDatabase(path.join(tmpDir, 'populated.db'));
    const migrations = copyPre033Migrations(tmpDir);
    runMigrations(db, migrations);

    const statuses = ['tbd', 'planned', 'in-progress', 'ready', 'completed', 'archived'];
    const projectTypes = ['images', 'comic', 'animation', 'wallpaper', 'images', 'comic'];
    const insertProject = db.prepare(`
      INSERT INTO projects (
        id, title, slug, description, notes, status, project_type, patreon_url,
        created_at, updated_at, archived_at, project_dir
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    statuses.forEach((status, index) => {
      const id = index + 1;
      insertProject.run(
        id,
        `Project ${id}`,
        `project-${id}`,
        `Description ${id}`,
        `Notes ${id}`,
        status,
        projectTypes[index],
        `https://example.test/project-${id}`,
        `2026-09-0${id} 10:00:00`,
        `2026-09-0${id} 11:00:00`,
        status === 'archived' ? `2026-09-0${id} 12:00:00` : null,
        `00000${id}-project-${id}`
      );
    });
    db.prepare("INSERT INTO releases (id, project_id, title) VALUES (3, 3, 'Release')").run();
    const categoryId = Number(db.prepare(`
      INSERT INTO project_asset_categories (project_id, display_name, directory_slug)
      VALUES (3, 'Final', 'final-retained')
    `).run().lastInsertRowid);
    const assetId = Number(db.prepare(`
      INSERT INTO assets (
        project_id, category_id, relative_path, filename, extension, mime_type,
        size_bytes, is_present, last_seen_at
      ) VALUES (3, ?, 'final-retained/cover.png', 'cover.png', 'png', 'image/png', 10, 1, datetime('now'))
    `).run(categoryId).lastInsertRowid);
    db.prepare('INSERT INTO project_primary_images (project_id, asset_id) VALUES (3, ?)').run(assetId);
    const rowsBefore = db.prepare(`SELECT ${PROJECT_COLUMNS.join(', ')} FROM projects ORDER BY id`).all();

    addMigration(migrations);
    runMigrations(db, migrations);

    expect(db.pragma("table_info('projects')").map(({ name }) => name)).toEqual(PROJECT_COLUMNS);
    expect(db.prepare(`SELECT ${PROJECT_COLUMNS.join(', ')} FROM projects ORDER BY id`).all()).toEqual(rowsBefore);
    expect(db.prepare('SELECT id, project_id, title FROM releases WHERE id = 3').get())
      .toEqual({ id: 3, project_id: 3, title: 'Release' });
    expect(db.prepare('SELECT project_id, category_id FROM assets WHERE id = ?').get(assetId))
      .toEqual({ project_id: 3, category_id: categoryId });
    expect(db.prepare('SELECT project_id, asset_id FROM project_primary_images WHERE project_id = 3').get())
      .toEqual({ project_id: 3, asset_id: assetId });
    expect(db.pragma("index_list('projects')").map(({ name }) => name))
      .toEqual(expect.arrayContaining(PROJECT_INDEXES));
    for (const [name, pattern] of Object.entries(PROJECT_INDEX_SQL)) {
      expect(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
        .pluck()
        .get(name)).toMatch(pattern);
    }
    const columns = Object.fromEntries(
      db.pragma("table_info('projects')").map((column) => [column.name, column])
    );
    expect(columns.status).toMatchObject({ type: 'TEXT', notnull: 1, dflt_value: "'tbd'" });
    expect(columns.project_type).toMatchObject({ type: 'TEXT', notnull: 1, dflt_value: "'images'" });
    expect(JSON.parse(db.prepare('SELECT value FROM app_meta WHERE key = ?').pluck()
      .get(STATUS_CATALOGUE_KEY))).toEqual({
      version: 1,
      entries: [
        { value: 'tbd', label: 'Tbd', color: '#AAAAAA' },
        { value: 'planned', label: 'Planned', color: '#AAAAAA' },
        { value: 'in-progress', label: 'In Progress', color: '#22D3EE' },
        { value: 'ready', label: 'Ready', color: '#34D399' },
        { value: 'completed', label: 'Completed', color: '#A78BFA' },
        { value: 'archived', label: 'Archived', color: '#9CA3AF' },
      ],
    });
    expect(JSON.parse(db.prepare('SELECT value FROM app_meta WHERE key = ?').pluck()
      .get(TYPE_CATALOGUE_KEY))).toEqual({
      version: 1,
      entries: [
        { value: 'images', label: 'Images', color: '#22D3EE' },
        { value: 'comic', label: 'Comic', color: '#A78BFA' },
        { value: 'animation', label: 'Animation', color: '#34D399' },
        { value: 'wallpaper', label: 'Wallpaper', color: '#FF8A94' },
      ],
    });
    for (const key of [STATUS_CATALOGUE_KEY, TYPE_CATALOGUE_KEY]) {
      const { entries } = JSON.parse(db.prepare('SELECT value FROM app_meta WHERE key = ?').pluck().get(key));
      expect(entries.every(({ color }) => /^#[0-9A-F]{6}$/.test(color))).toBe(true);
    }
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('removes only the fixed option checks and keeps database defaults', () => {
    db = openDatabase(path.join(tmpDir, 'current.db'));
    const migrations = copyPre033Migrations(tmpDir);
    addMigration(migrations);
    runMigrations(db, migrations);

    const tableSql = projectTableSql(db);
    expect(tableSql).not.toMatch(/projects_status|status\s+IN\s*\(/i);
    expect(tableSql).not.toMatch(/project_type\s+IN\s*\(/i);
    db.prepare("INSERT INTO projects (title, slug) VALUES ('Defaults', 'defaults')").run();
    db.prepare(`
      INSERT INTO projects (title, slug, status, project_type)
      VALUES ('Custom', 'custom', 'awaiting-review', 'interactive')
    `).run();
    expect(db.prepare('SELECT status, project_type FROM projects ORDER BY id').all()).toEqual([
      { status: 'tbd', project_type: 'images' },
      { status: 'awaiting-review', project_type: 'interactive' },
    ]);
    expect(() => db.prepare("INSERT INTO projects (title, slug) VALUES ('Duplicate', 'defaults')").run())
      .toThrow(/UNIQUE constraint failed/i);
    expect(() => db.prepare("INSERT INTO projects (title, slug, status) VALUES ('Null', 'null-status', NULL)").run())
      .toThrow(/NOT NULL constraint failed/i);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('preserves deleted and empty-table AUTOINCREMENT high-water marks', () => {
    db = openDatabase(path.join(tmpDir, 'sequence.db'));
    const migrations = copyPre033Migrations(tmpDir);
    runMigrations(db, migrations);
    db.prepare("INSERT INTO projects (id, title, slug) VALUES (99, 'Deleted', 'deleted')").run();
    db.prepare('DELETE FROM projects').run();
    expect(projectSequence(db)).toBe(99);

    addMigration(migrations);
    runMigrations(db, migrations);

    expect(projectSequence(db)).toBe(99);
    expect(db.prepare("INSERT INTO projects (title, slug) VALUES ('Next', 'next')").run().lastInsertRowid)
      .toBe(100);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('rolls back schema, data, sequence, children, and migration record on failure', () => {
    db = openDatabase(path.join(tmpDir, 'rollback.db'));
    const migrations = copyPre033Migrations(tmpDir);
    runMigrations(db, migrations);
    db.prepare("INSERT INTO projects (id, title, slug, status, project_type) VALUES (17, 'Original', 'original', 'ready', 'comic')").run();
    db.prepare("INSERT INTO releases (project_id, title) VALUES (17, 'Child')").run();
    const originalSql = projectTableSql(db);
    const originalSequence = projectSequence(db);
    addMigration(migrations, `${fs.readFileSync(path.join(MIGRATIONS_DIR, MIGRATION_FILENAME), 'utf8')}\nSELECT * FROM migration_failure;\n`);

    expect(() => runMigrations(db, migrations)).toThrow(`Migration "${MIGRATION_FILENAME}" failed.`);

    expect(projectTableSql(db)).toBe(originalSql);
    expect(db.prepare('SELECT id, status, project_type FROM projects').get())
      .toEqual({ id: 17, status: 'ready', project_type: 'comic' });
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

  it('is recorded once and not reapplied by repeated migration runs', () => {
    db = openDatabase(path.join(tmpDir, 'repeat.db'));
    runMigrations(db, MIGRATIONS_DIR);
    const tableSql = projectTableSql(db);
    const appliedAt = db.prepare('SELECT applied_at FROM schema_migrations WHERE filename = ?')
      .pluck()
      .get(MIGRATION_FILENAME);

    runMigrations(db, MIGRATIONS_DIR);

    expect(projectTableSql(db)).toBe(tableSql);
    expect(db.prepare('SELECT applied_at FROM schema_migrations WHERE filename = ?').pluck().get(MIGRATION_FILENAME))
      .toBe(appliedAt);
    expect(db.prepare('SELECT filename FROM schema_migrations WHERE filename = ?').pluck().all(MIGRATION_FILENAME))
      .toEqual([MIGRATION_FILENAME]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});
