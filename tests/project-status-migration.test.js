import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

// The projects.status CHECK as it shipped BEFORE 002_add_completed_status.sql.
// Used only to reconstruct the pre-migration database for the upgrade test.
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
    CONSTRAINT projects_status CHECK (status IN ('tbd', 'planned', 'in-progress', 'ready', 'archived')),
    CONSTRAINT projects_priority CHECK (priority IN ('low', 'normal', 'high')),
    CONSTRAINT projects_planned_date_format CHECK (planned_date IS NULL OR planned_date LIKE '____-__-__'),
    CONSTRAINT projects_published_date_format CHECK (published_date IS NULL OR published_date LIKE '____-__-__')
  );
`;

// Minimal child tables with the two FK on-delete behaviors that matter for the
// rebuild: releases (ON DELETE RESTRICT) and assets (ON DELETE CASCADE). The
// CASCADE case is the dangerous one — a rebuild with foreign_keys ON would
// silently delete these rows.
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

function tableDdl(db, table) {
  return db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .pluck()
    .get(table);
}

function projectsStatusCheckValues(db) {
  const ddl = tableDdl(db, 'projects') || '';
  const match = ddl.match(/projects_status CHECK \(status IN \(([^)]+)\)/i);
  if (!match) return null;
  return match[1].replaceAll(/\s+/g, ' ').trim();
}

describe('projects status migration (002_add_completed_status)', () => {
  let tmpDir;
  let db;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-project-status-'));
    db = undefined;
  });

  afterEach(() => {
    closeDatabase(db);
    db = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fresh install applies both migrations and includes completed in the CHECK', () => {
    db = openDatabase(path.join(tmpDir, 'fresh.db'));
    runMigrations(db, MIGRATIONS_DIR);

    expect(db.prepare('SELECT filename FROM schema_migrations ORDER BY rowid').pluck().all())
      .toEqual(['001_initial.sql', '002_add_completed_status.sql']);

    const checkValues = projectsStatusCheckValues(db);
    expect(checkValues).toContain("'completed'");

    // The new status is writable on a fresh install.
    db.prepare(
      "INSERT INTO projects (title, slug, status, priority) VALUES (?, ?, 'completed', 'normal')"
    ).run('Fresh', 'fresh');
    expect(
      db.prepare('SELECT status FROM projects WHERE slug = ?').pluck().get('fresh')
    ).toBe('completed');

    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('upgrades an existing database without losing projects, releases, or assets', () => {
    db = openDatabase(path.join(tmpDir, 'upgrade.db'));
    // Reconstruct a pre-002 database: old projects schema + children, with 001
    // already recorded as applied so the runner skips it and only applies 002.
    db.exec(`
      CREATE TABLE schema_migrations (filename TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations (filename, applied_at) VALUES ('001_initial.sql', datetime('now'));
      ${OLD_PROJECTS_DDL}
      ${CHILD_DDL}
    `);
    db.prepare(
      "INSERT INTO projects (id, title, slug, status, priority) VALUES (?, ?, ?, 'ready', 'normal')"
    ).run(1, 'Existing', 'existing');
    db.prepare('INSERT INTO releases (id, project_id, title) VALUES (?, ?, ?)').run(1, 1, 'Rel');
    db.prepare('INSERT INTO assets (id, project_id, relative_path) VALUES (?, ?, ?)').run(1, 1, 'a.png');

    // Sanity: the old CHECK rejects 'completed' before the upgrade.
    expect(() =>
      db.prepare("INSERT INTO projects (title, slug, status, priority) VALUES (?, ?, 'completed', 'normal')")
        .run('Nope', 'nope')
    ).toThrow();

    // Run pending migrations — only 002 should apply.
    runMigrations(db, MIGRATIONS_DIR);

    expect(db.prepare('SELECT filename FROM schema_migrations ORDER BY rowid').pluck().all())
      .toEqual(['001_initial.sql', '002_add_completed_status.sql']);

    // The rebuild must preserve every parent and child row (id-stable).
    expect(db.prepare('SELECT id, title, status FROM projects').get()).toEqual({
      id: 1,
      title: 'Existing',
      status: 'ready',
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM releases').get().n).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM assets').get().n).toBe(1);

    // AUTOINCREMENT continues past the largest copied id.
    const next = db.prepare(
      "INSERT INTO projects (title, slug, status, priority) VALUES (?, ?, 'completed', 'normal')"
    ).run('Newly Completed', 'newly-completed');
    expect(next.lastInsertRowid).toBe(2);

    // FK relationships still resolve cleanly after the rebuild.
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('is idempotent across repeated migration runs', () => {
    db = openDatabase(path.join(tmpDir, 'repeat.db'));
    runMigrations(db, MIGRATIONS_DIR);
    const checkValuesAfterFirst = projectsStatusCheckValues(db);
    const appliedAfterFirst = db
      .prepare('SELECT filename FROM schema_migrations ORDER BY rowid')
      .pluck()
      .all();

    runMigrations(db, MIGRATIONS_DIR);

    expect(db.prepare('SELECT filename FROM schema_migrations ORDER BY rowid').pluck().all())
      .toEqual(appliedAfterFirst);
    expect(projectsStatusCheckValues(db)).toBe(checkValuesAfterFirst);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});
