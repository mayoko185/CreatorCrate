import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('database and migrations', () => {
  let tmpDir;
  let dbPath;
  let db;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-db-'));
    dbPath = path.join(tmpDir, 'test.db');
    db = null;
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('opens a database at the configured path', () => {
    db = openDatabase(dbPath);
    expect(db).toBeInstanceOf(Database);
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it('creates the migration bookkeeping table', () => {
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    const row = db
      .prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?')
      .get('table', 'schema_migrations');
    expect(row).toBeTruthy();
  });

  it('applies migrations successfully', () => {
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    const row = db
      .prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?')
      .get('table', 'app_meta');
    expect(row).toBeTruthy();
  });

  it('creates intended project indexes without a duplicate slug index', () => {
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'projects'")
      .pluck()
      .all();

    expect(indexes).toContain('idx_projects_archived_updated');
    expect(indexes).toContain('idx_projects_status_archived');
    expect(indexes).toContain('idx_projects_title');
    expect(indexes).toContain('idx_projects_description');
    expect(indexes).toContain('idx_projects_notes');
    expect(indexes).not.toContain('idx_projects_slug');
    expect(indexes.some((name) => name.startsWith('sqlite_autoindex_projects_'))).toBe(true);
  });

  it('adds project_dir column from migration 003', () => {
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    const columns = db
      .prepare("SELECT name FROM pragma_table_info('projects')")
      .pluck()
      .all();
    expect(columns).toContain('project_dir');
  });

  it('adds idx_projects_project_dir index', () => {
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'projects'")
      .pluck()
      .all();
    expect(indexes).toContain('idx_projects_project_dir');
  });

  it('is idempotent across repeated migration runs', () => {
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    runMigrations(db, MIGRATIONS_DIR);
    const count = db
      .prepare('SELECT COUNT(*) AS c FROM schema_migrations WHERE filename = ?')
      .pluck()
      .get('001_initial.sql');
    expect(count).toBe(1);
  });

  it('closes cleanly', () => {
    db = openDatabase(dbPath);
    expect(() => closeDatabase(db)).not.toThrow();
  });
});
