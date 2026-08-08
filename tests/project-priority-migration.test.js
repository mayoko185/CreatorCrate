import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

const OLD_PROJECTS_DDL = `
  CREATE TABLE projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'tbd',
    priority TEXT NOT NULL DEFAULT 'normal',
    planned_date TEXT,
    published_date TEXT,
    patreon_url TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    archived_at TEXT,
    project_dir TEXT,
    CONSTRAINT projects_status CHECK (status IN ('tbd', 'planned', 'in-progress', 'ready', 'completed', 'archived')),
    CONSTRAINT projects_priority CHECK (priority IN ('low', 'normal', 'high')),
    CONSTRAINT projects_planned_date_format CHECK (planned_date IS NULL OR planned_date LIKE '____-__-__'),
    CONSTRAINT projects_published_date_format CHECK (published_date IS NULL OR published_date LIKE '____-__-__')
  );
`;

const CHILD_DDL = `
  CREATE TABLE releases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT
  );
  CREATE TABLE assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    relative_path TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );
`;

const PROJECT_COLUMNS = [
  'id',
  'title',
  'slug',
  'description',
  'notes',
  'status',
  'planned_date',
  'published_date',
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

function projectColumns(db) {
  return db.pragma('table_info(projects)').map((column) => column.name);
}

function projectIndexes(db) {
  return db.pragma('index_list(projects)').map((index) => index.name);
}

function projectTableDdl(db) {
  return db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'projects'")
    .pluck()
    .get();
}

describe('projects priority migration (003_remove_project_priority)', () => {
  let tmpDir;
  let db;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-project-priority-'));
    db = undefined;
  });

  afterEach(() => {
    closeDatabase(db);
    db = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('removes priority from fresh-install projects while retaining ready and project indexes', () => {
    db = openDatabase(path.join(tmpDir, 'fresh.db'));
    runMigrations(db, MIGRATIONS_DIR);

    expect(db.prepare('SELECT filename FROM schema_migrations ORDER BY rowid').pluck().all())
      .toEqual([
        '001_initial.sql',
        '002_add_completed_status.sql',
        '003_remove_project_priority.sql',
      ]);
    expect(projectColumns(db)).toEqual(PROJECT_COLUMNS);
    expect(projectIndexes(db)).toEqual(expect.arrayContaining(PROJECT_INDEXES));

    const ddl = projectTableDdl(db);
    expect(ddl).not.toMatch(/priority/i);
    expect(ddl).toMatch(/projects_status CHECK.*ready/i);
    expect(() => db.prepare(
      "INSERT INTO projects (title, slug, status) VALUES ('Ready', 'ready', 'ready')"
    ).run()).not.toThrow();
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('rebuilds an existing projects table without losing retained data, IDs, children, or the autoincrement sequence', () => {
    db = openDatabase(path.join(tmpDir, 'upgrade.db'));
    db.exec(`
      CREATE TABLE schema_migrations (filename TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations (filename, applied_at) VALUES
        ('001_initial.sql', datetime('now')),
        ('002_add_completed_status.sql', datetime('now'));
      ${OLD_PROJECTS_DDL}
      ${CHILD_DDL}
      CREATE INDEX idx_projects_archived_updated ON projects(archived_at, updated_at DESC);
      CREATE INDEX idx_projects_status_archived ON projects(status, archived_at);
      CREATE INDEX idx_projects_title ON projects(title COLLATE NOCASE);
      CREATE INDEX idx_projects_description ON projects(description COLLATE NOCASE);
      CREATE INDEX idx_projects_notes ON projects(notes COLLATE NOCASE);
      CREATE INDEX idx_projects_project_dir ON projects(project_dir);
    `);

    const insertProject = db.prepare(`
      INSERT INTO projects (
        id, title, slug, description, notes, status, priority,
        planned_date, published_date, patreon_url,
        created_at, updated_at, archived_at, project_dir
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertProject.run(
      7,
      'Existing Project',
      'existing-project',
      'Description',
      'Notes',
      'ready',
      'high',
      '2026-01-02',
      '2026-02-03',
      'https://example.test/patreon',
      '2026-01-01 10:00:00',
      '2026-01-01 11:00:00',
      null,
      '000007-existing-project'
    );
    insertProject.run(
      11,
      'Archived Project',
      'archived-project',
      '',
      '',
      'archived',
      'low',
      null,
      null,
      null,
      '2026-01-03 10:00:00',
      '2026-01-03 11:00:00',
      '2026-01-03 12:00:00',
      '000011-archived-project'
    );
    db.prepare('INSERT INTO releases (id, project_id, title) VALUES (?, ?, ?)')
      .run(3, 7, 'Release');
    db.prepare('INSERT INTO assets (id, project_id, relative_path) VALUES (?, ?, ?)')
      .run(5, 7, 'cover.png');

    runMigrations(db, MIGRATIONS_DIR);

    expect(projectColumns(db)).toEqual(PROJECT_COLUMNS);
    expect(db.prepare(`
      SELECT ${PROJECT_COLUMNS.join(', ')} FROM projects ORDER BY id
    `).all()).toEqual([
      {
        id: 7,
        title: 'Existing Project',
        slug: 'existing-project',
        description: 'Description',
        notes: 'Notes',
        status: 'ready',
        planned_date: '2026-01-02',
        published_date: '2026-02-03',
        patreon_url: 'https://example.test/patreon',
        created_at: '2026-01-01 10:00:00',
        updated_at: '2026-01-01 11:00:00',
        archived_at: null,
        project_dir: '000007-existing-project',
      },
      {
        id: 11,
        title: 'Archived Project',
        slug: 'archived-project',
        description: '',
        notes: '',
        status: 'archived',
        planned_date: null,
        published_date: null,
        patreon_url: null,
        created_at: '2026-01-03 10:00:00',
        updated_at: '2026-01-03 11:00:00',
        archived_at: '2026-01-03 12:00:00',
        project_dir: '000011-archived-project',
      },
    ]);
    expect(db.prepare('SELECT id, project_id, title FROM releases').all())
      .toEqual([{ id: 3, project_id: 7, title: 'Release' }]);
    expect(db.prepare('SELECT id, project_id, relative_path FROM assets').all())
      .toEqual([{ id: 5, project_id: 7, relative_path: 'cover.png' }]);
    expect(projectIndexes(db)).toEqual(expect.arrayContaining(PROJECT_INDEXES));
    expect(projectTableDdl(db)).not.toMatch(/priority/i);
    expect(db.pragma('foreign_key_check')).toEqual([]);

    const next = db.prepare(
      "INSERT INTO projects (title, slug, status) VALUES ('Next Project', 'next-project', 'ready')"
    ).run();
    expect(next.lastInsertRowid).toBe(12);
  });

  it('does not reapply the forward migration on repeated runs', () => {
    db = openDatabase(path.join(tmpDir, 'repeat.db'));
    runMigrations(db, MIGRATIONS_DIR);
    const firstDdl = projectTableDdl(db);
    const firstColumns = projectColumns(db);
    const firstIndexes = projectIndexes(db);

    runMigrations(db, MIGRATIONS_DIR);

    expect(projectTableDdl(db)).toBe(firstDdl);
    expect(projectColumns(db)).toEqual(firstColumns);
    expect(projectIndexes(db)).toEqual(firstIndexes);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});
