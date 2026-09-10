import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import {
  isProjectOptionCatalogueV1DocumentValid,
} from '../src/services/project-option-catalogue-v1.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const MIGRATION_FILENAME = '034_make_project_options_deletable.sql';
const STATUS_DEFAULT_KEY = 'page_defaults.new_project.status';
const TYPE_DEFAULT_KEY = 'page_defaults.new_project.project_type';
const STATUS_CATALOGUE_KEY = 'project_options.status_catalogue';
const TYPE_CATALOGUE_KEY = 'project_options.project_type_catalogue';
const PROJECT_COLUMNS = [
  'id', 'title', 'slug', 'description', 'notes', 'status', 'project_type',
  'patreon_url', 'created_at', 'updated_at', 'archived_at', 'project_dir',
];
const PROJECT_INDEXES = [
  'idx_projects_archived_updated',
  'idx_projects_status_archived',
  'idx_projects_title',
  'idx_projects_description',
  'idx_projects_notes',
  'idx_projects_project_dir',
];

function copyPre034Migrations(parentDir) {
  const target = path.join(parentDir, 'pre-034');
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

function metaValue(db, key) {
  return db.prepare('SELECT value FROM app_meta WHERE key = ?').pluck().get(key);
}

function setMetaValue(db, key, value) {
  db.prepare(`
    INSERT INTO app_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

function projectTableSql(db) {
  return db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'projects'")
    .pluck()
    .get();
}

function projectSequence(db) {
  return db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'projects'").pluck().get();
}

describe('Project option deletable foundation migration (034)', () => {
  let tmpDir;
  let db;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-project-options-034-'));
  });

  afterEach(() => {
    closeDatabase(db);
    db = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('materializes missing scalar New Project defaults on upgrade and fresh install', () => {
    db = openDatabase(path.join(tmpDir, 'upgrade.db'));
    const migrations = copyPre034Migrations(tmpDir);
    runMigrations(db, migrations);

    expect(metaValue(db, STATUS_DEFAULT_KEY)).toBeUndefined();
    expect(metaValue(db, TYPE_DEFAULT_KEY)).toBeUndefined();
    addMigration(migrations);
    runMigrations(db, migrations);

    expect(metaValue(db, STATUS_DEFAULT_KEY)).toBe('tbd');
    expect(metaValue(db, TYPE_DEFAULT_KEY)).toBe('images');
    closeDatabase(db);

    db = openDatabase(path.join(tmpDir, 'fresh.db'));
    runMigrations(db, MIGRATIONS_DIR);
    expect(metaValue(db, STATUS_DEFAULT_KEY)).toBe('tbd');
    expect(metaValue(db, TYPE_DEFAULT_KEY)).toBe('images');
  });

  it.each(['client-review', 'tbd'])(
    'preserves an existing %s Status default while adding Type and retaining unrelated settings',
    (statusDefault) => {
      db = openDatabase(path.join(tmpDir, `${statusDefault}.db`));
      const migrations = copyPre034Migrations(tmpDir);
      runMigrations(db, migrations);
      setMetaValue(db, STATUS_DEFAULT_KEY, statusDefault);
      setMetaValue(db, 'page_defaults.new_project.unrelated', 'keep-me');

      addMigration(migrations);
      runMigrations(db, migrations);

      expect(metaValue(db, STATUS_DEFAULT_KEY)).toBe(statusDefault);
      expect(metaValue(db, TYPE_DEFAULT_KEY)).toBe('images');
      expect(metaValue(db, 'page_defaults.new_project.unrelated')).toBe('keep-me');
    },
  );

  it('removes only archived from the ordered Status catalogue and preserves Project data and schema contracts', () => {
    db = openDatabase(path.join(tmpDir, 'preservation.db'));
    const migrations = copyPre034Migrations(tmpDir);
    runMigrations(db, migrations);

    const statusCatalogue = {
      version: 1,
      entries: [
        { value: 'ready', label: 'État prêt', color: '#123456' },
        { value: 'custom', label: 'Custom', color: '#ABCDEF' },
        { value: 'archived', label: 'Stored Away', color: '#654321' },
        { value: 'tbd', label: 'Later', color: '#FEDCBA' },
      ],
      unrelated: { retained: true },
    };
    const typeCatalogue = {
      version: 1,
      entries: [{ value: 'custom-type', label: 'Custom Type', color: '#102030' }],
    };
    setMetaValue(db, STATUS_CATALOGUE_KEY, JSON.stringify(statusCatalogue));
    setMetaValue(db, TYPE_CATALOGUE_KEY, JSON.stringify(typeCatalogue));

    const insertProject = db.prepare(`
      INSERT INTO projects (
        id, title, slug, description, notes, status, project_type, patreon_url,
        created_at, updated_at, archived_at, project_dir
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertProject.run(
      17, 'Archived', 'archived', 'Description', 'Notes', 'archived', 'images',
      'https://example.test/archived', '2026-09-01 10:00:00', '2026-09-02 11:00:00',
      '2026-09-03 12:00:00', '000017-archived',
    );
    insertProject.run(
      23, 'Custom', 'custom', '', '', 'client-review', 'interactive', null,
      '2026-09-04 10:00:00', '2026-09-05 11:00:00', null, null,
    );
    db.prepare("INSERT INTO releases (id, project_id, title) VALUES (7, 17, 'Child')").run();
    db.prepare("UPDATE sqlite_sequence SET seq = 99 WHERE name = 'projects'").run();
    const rowsBefore = db.prepare(`SELECT ${PROJECT_COLUMNS.join(', ')} FROM projects ORDER BY id`).all();
    const columnsBefore = Object.fromEntries(
      db.pragma("table_info('projects')").map((column) => [column.name, column]),
    );
    expect(columnsBefore.status.dflt_value).toBe("'tbd'");
    expect(columnsBefore.project_type.dflt_value).toBe("'images'");

    addMigration(migrations);
    runMigrations(db, migrations);

    expect(JSON.parse(metaValue(db, STATUS_CATALOGUE_KEY))).toEqual({
      ...statusCatalogue,
      entries: statusCatalogue.entries.filter(({ value }) => value !== 'archived'),
    });
    expect(metaValue(db, TYPE_CATALOGUE_KEY)).toBe(JSON.stringify(typeCatalogue));
    expect(db.prepare(`SELECT ${PROJECT_COLUMNS.join(', ')} FROM projects ORDER BY id`).all())
      .toEqual(rowsBefore);
    expect(db.prepare('SELECT status, archived_at FROM projects WHERE id = 17').get()).toEqual({
      status: 'archived',
      archived_at: '2026-09-03 12:00:00',
    });
    expect(db.prepare('SELECT id, project_id, title FROM releases').get())
      .toEqual({ id: 7, project_id: 17, title: 'Child' });

    const columns = Object.fromEntries(
      db.pragma("table_info('projects')").map((column) => [column.name, column]),
    );
    expect(columns.status).toMatchObject({ type: 'TEXT', notnull: 1, dflt_value: null });
    expect(columns.project_type).toMatchObject({ type: 'TEXT', notnull: 1, dflt_value: null });
    expect(db.pragma("table_info('projects')").map(({ name }) => name)).toEqual(PROJECT_COLUMNS);
    expect(projectTableSql(db)).not.toMatch(/status\s+IN\s*\(|project_type\s+IN\s*\(/i);
    expect(db.pragma("index_list('projects')").map(({ name }) => name))
      .toEqual(expect.arrayContaining(PROJECT_INDEXES));
    expect(projectSequence(db)).toBe(99);
    expect(() => db.prepare(`
      INSERT INTO projects (title, slug, project_type) VALUES ('No Status', 'no-status', 'images')
    `).run()).toThrow(/NOT NULL constraint failed: projects\.status/i);
    expect(() => db.prepare(`
      INSERT INTO projects (title, slug, status) VALUES ('No Type', 'no-type', 'tbd')
    `).run()).toThrow(/NOT NULL constraint failed: projects\.project_type/i);
    expect(db.prepare(`
      INSERT INTO projects (title, slug, status, project_type)
      VALUES ('Next', 'next', 'another-status', 'another-type')
    `).run().lastInsertRowid).toBe(100);
    expect(() => db.prepare(`
      INSERT INTO projects (title, slug, status, project_type)
      VALUES ('Duplicate', 'next', 'tbd', 'images')
    `).run()).toThrow(/UNIQUE constraint failed/i);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('rolls back the table, defaults, catalogue, sequence, and migration record on failure', () => {
    db = openDatabase(path.join(tmpDir, 'rollback.db'));
    const migrations = copyPre034Migrations(tmpDir);
    runMigrations(db, migrations);
    db.prepare(`
      INSERT INTO projects (id, title, slug, status, project_type)
      VALUES (41, 'Original', 'original', 'archived', 'comic')
    `).run();
    db.prepare("INSERT INTO releases (project_id, title) VALUES (41, 'Child')").run();
    const originalSql = projectTableSql(db);
    const originalSequence = projectSequence(db);
    const originalCatalogue = metaValue(db, STATUS_CATALOGUE_KEY);
    addMigration(migrations, `${fs.readFileSync(
      path.join(MIGRATIONS_DIR, MIGRATION_FILENAME), 'utf8',
    )}\nSELECT * FROM migration_failure;\n`);

    expect(() => runMigrations(db, migrations)).toThrow(`Migration "${MIGRATION_FILENAME}" failed.`);

    expect(projectTableSql(db)).toBe(originalSql);
    expect(db.prepare('SELECT id, status, project_type FROM projects').get())
      .toEqual({ id: 41, status: 'archived', project_type: 'comic' });
    expect(db.prepare('SELECT project_id, title FROM releases').get())
      .toEqual({ project_id: 41, title: 'Child' });
    expect(metaValue(db, STATUS_DEFAULT_KEY)).toBeUndefined();
    expect(metaValue(db, TYPE_DEFAULT_KEY)).toBeUndefined();
    expect(metaValue(db, STATUS_CATALOGUE_KEY)).toBe(originalCatalogue);
    expect(projectSequence(db)).toBe(originalSequence);
    expect(db.prepare('SELECT 1 FROM schema_migrations WHERE filename = ?').get(MIGRATION_FILENAME))
      .toBeUndefined();
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projects_new'").get())
      .toBeUndefined();
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('rejects a malformed Status catalogue without repairing or partially migrating it', () => {
    db = openDatabase(path.join(tmpDir, 'malformed.db'));
    const migrations = copyPre034Migrations(tmpDir);
    runMigrations(db, migrations);
    setMetaValue(db, STATUS_CATALOGUE_KEY, '{not-json');
    const originalSql = projectTableSql(db);
    addMigration(migrations);

    expect(() => runMigrations(db, migrations)).toThrow(`Migration "${MIGRATION_FILENAME}" failed.`);

    expect(metaValue(db, STATUS_CATALOGUE_KEY)).toBe('{not-json');
    expect(metaValue(db, STATUS_DEFAULT_KEY)).toBeUndefined();
    expect(metaValue(db, TYPE_DEFAULT_KEY)).toBeUndefined();
    expect(projectTableSql(db)).toBe(originalSql);
    expect(db.prepare('SELECT 1 FROM schema_migrations WHERE filename = ?').get(MIGRATION_FILENAME))
      .toBeUndefined();
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it.each([
    [
      'an unsupported version',
      {
        version: 2,
        entries: [{ value: 'ready', label: 'Ready', color: '#34D399' }],
      },
    ],
    [
      'an invalid color',
      {
        version: 1,
        entries: [{ value: 'ready', label: 'Ready', color: 'not-a-color' }],
      },
    ],
    [
      'duplicate values',
      {
        version: 1,
        entries: [
          { value: 'ready', label: 'Ready', color: '#34D399' },
          { value: 'ready', label: 'Also Ready', color: '#123456' },
        ],
      },
    ],
    [
      'duplicate case-insensitive labels',
      {
        version: 1,
        entries: [
          { value: 'ready', label: 'Ready', color: '#34D399' },
          { value: 'also-ready', label: 'ready', color: '#123456' },
        ],
      },
    ],
    [
      'duplicate Unicode case-insensitive labels',
      {
        version: 1,
        entries: [
          { value: 'state', label: 'État', color: '#34D399' },
          { value: 'other-state', label: 'état', color: '#123456' },
        ],
      },
    ],
    [
      'a label exceeding 100 UTF-16 code units',
      {
        version: 1,
        entries: [{ value: 'emoji', label: '😀'.repeat(60), color: '#34D399' }],
      },
    ],
    [
      'a malformed entry',
      {
        version: 1,
        entries: [{ value: 'ready', color: '#34D399' }],
      },
    ],
  ])('rejects %s and rolls back every migration change', (_description, invalidCatalogue) => {
    db = openDatabase(path.join(tmpDir, 'semantic-invalid.db'));
    const migrations = copyPre034Migrations(tmpDir);
    runMigrations(db, migrations);
    db.prepare(`
      INSERT INTO projects (id, title, slug, status, project_type)
      VALUES (61, 'Existing', 'existing', 'ready', 'graded-comic')
    `).run();
    db.prepare("INSERT INTO releases (project_id, title) VALUES (61, 'Child')").run();
    const originalSql = projectTableSql(db);
    const originalSequence = projectSequence(db);
    const rowsBefore = db.prepare(
      `SELECT ${PROJECT_COLUMNS.join(', ')} FROM projects ORDER BY id`,
    ).all();
    const typeCatalogueBefore = metaValue(db, TYPE_CATALOGUE_KEY);
    const serializedInvalidCatalogue = JSON.stringify(invalidCatalogue);
    setMetaValue(db, STATUS_CATALOGUE_KEY, serializedInvalidCatalogue);
    addMigration(migrations);

    expect(() => runMigrations(db, migrations)).toThrow(`Migration "${MIGRATION_FILENAME}" failed.`);

    expect(metaValue(db, STATUS_CATALOGUE_KEY)).toBe(serializedInvalidCatalogue);
    expect(metaValue(db, TYPE_CATALOGUE_KEY)).toBe(typeCatalogueBefore);
    expect(metaValue(db, STATUS_DEFAULT_KEY)).toBeUndefined();
    expect(metaValue(db, TYPE_DEFAULT_KEY)).toBeUndefined();
    expect(projectTableSql(db)).toBe(originalSql);
    expect(db.prepare(
      `SELECT ${PROJECT_COLUMNS.join(', ')} FROM projects ORDER BY id`,
    ).all()).toEqual(rowsBefore);
    expect(db.prepare('SELECT project_id, title FROM releases').get())
      .toEqual({ project_id: 61, title: 'Child' });
    expect(projectSequence(db)).toBe(originalSequence);
    expect(db.prepare('SELECT 1 FROM schema_migrations WHERE filename = ?').get(MIGRATION_FILENAME))
      .toBeUndefined();
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projects_new'").get())
      .toBeUndefined();
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it.each([
    ['ordinary ASCII valid', {
      version: 1,
      entries: [{ value: 'ready', label: 'Ready', color: '#34D399' }],
    }],
    ['Unicode valid', {
      version: 1,
      entries: [{ value: 'ready', label: 'État prêt', color: '#34D399' }],
    }],
    ['Unicode case duplicate', {
      version: 1,
      entries: [
        { value: 'state', label: 'État', color: '#34D399' },
        { value: 'other-state', label: 'état', color: '#123456' },
      ],
    }],
    ['emoji length boundary', {
      version: 1,
      entries: [{ value: 'emoji', label: '😀'.repeat(60), color: '#34D399' }],
    }],
    ['invalid color', {
      version: 1,
      entries: [{ value: 'ready', label: 'Ready', color: '#34d399' }],
    }],
    ['duplicate value', {
      version: 1,
      entries: [
        { value: 'ready', label: 'Ready', color: '#34D399' },
        { value: 'ready', label: 'Prepared', color: '#123456' },
      ],
    }],
  ])('keeps runtime and migration v1 validation aligned for %s', (_description, document) => {
    db = openDatabase(path.join(tmpDir, 'parity.db'));
    const migrations = copyPre034Migrations(tmpDir);
    runMigrations(db, migrations);

    const migrationResult = db.prepare(
      'SELECT is_project_option_catalogue_v1_valid(?) AS valid',
    ).pluck().get(JSON.stringify(document));

    expect(Boolean(migrationResult)).toBe(isProjectOptionCatalogueV1DocumentValid(document));
  });

  it('rejects a missing Status catalogue and rolls back every migration change', () => {
    db = openDatabase(path.join(tmpDir, 'missing-catalogue.db'));
    const migrations = copyPre034Migrations(tmpDir);
    runMigrations(db, migrations);
    db.prepare(`
      INSERT INTO projects (id, title, slug, status, project_type)
      VALUES (52, 'Existing', 'existing', 'ready', 'comic')
    `).run();
    db.prepare('DELETE FROM app_meta WHERE key = ?').run(STATUS_CATALOGUE_KEY);
    const originalSql = projectTableSql(db);
    const rowsBefore = db.prepare(`SELECT ${PROJECT_COLUMNS.join(', ')} FROM projects ORDER BY id`).all();
    addMigration(migrations);

    expect(() => runMigrations(db, migrations)).toThrow(`Migration "${MIGRATION_FILENAME}" failed.`);

    expect(metaValue(db, STATUS_CATALOGUE_KEY)).toBeUndefined();
    expect(metaValue(db, STATUS_DEFAULT_KEY)).toBeUndefined();
    expect(metaValue(db, TYPE_DEFAULT_KEY)).toBeUndefined();
    expect(projectTableSql(db)).toBe(originalSql);
    expect(db.prepare(`SELECT ${PROJECT_COLUMNS.join(', ')} FROM projects ORDER BY id`).all())
      .toEqual(rowsBefore);
    expect(db.prepare('SELECT 1 FROM schema_migrations WHERE filename = ?').get(MIGRATION_FILENAME))
      .toBeUndefined();
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});
