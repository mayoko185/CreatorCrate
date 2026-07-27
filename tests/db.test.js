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

  // ─── Phase 4: asset migration tests ──────────────────────────────

  it('creates the assets table from migration 004', () => {
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = ? AND name = ?")
      .get('table', 'assets');
    expect(row).toBeTruthy();
  });

  it('assets table has foreign key to projects', () => {
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    // Verify foreign key exists by checking table DDL
    const ddl = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'assets'")
      .pluck()
      .get();
    expect(ddl).toMatch(/FOREIGN KEY\s*\(project_id\)\s*REFERENCES\s*projects\(id\)/i);
  });

  it('assets table has expected indexes', () => {
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'assets'")
      .pluck()
      .all();

    expect(indexes).toContain('idx_assets_project_id');
    expect(indexes).toContain('idx_assets_extension');
    expect(indexes).toContain('idx_assets_filename');
    expect(indexes).toContain('idx_assets_modified_at');
    expect(indexes).toContain('idx_assets_project_path');
  });

  it('assets table has expected columns', () => {
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    const columns = db
      .prepare("SELECT name FROM pragma_table_info('assets')")
      .pluck()
      .all();

    expect(columns).toContain('id');
    expect(columns).toContain('project_id');
    expect(columns).toContain('relative_path');
    expect(columns).toContain('filename');
    expect(columns).toContain('extension');
    expect(columns).toContain('mime_type');
    expect(columns).toContain('size_bytes');
    expect(columns).toContain('modified_at');
    expect(columns).toContain('created_at');
    expect(columns).toContain('updated_at');
  });

  // ─── Phase 5B: release migration tests ──────────────────────────────

  it('creates the releases table from migration 006', () => {
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = ? AND name = ?")
      .get('table', 'releases');
    expect(row).toBeTruthy();
  });

  it('releases table has foreign key to projects', () => {
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    const ddl = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'releases'")
      .pluck()
      .get();
    expect(ddl).toMatch(/FOREIGN KEY\s*\(project_id\)\s*REFERENCES\s*projects\(id\)/i);
  });

  it('releases table has expected indexes', () => {
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'releases'")
      .pluck()
      .all();

    expect(indexes).toContain('idx_releases_project_id');
    expect(indexes).toContain('idx_releases_status');
    expect(indexes).toContain('idx_releases_planned_date');
    expect(indexes).toContain('idx_releases_overdue');
    expect(indexes).toContain('idx_releases_archived');
  });

  it('releases table has expected columns', () => {
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    const columns = db
      .prepare("SELECT name FROM pragma_table_info('releases')")
      .pluck()
      .all();

    expect(columns).toContain('id');
    expect(columns).toContain('project_id');
    expect(columns).toContain('title');
    expect(columns).toContain('description');
    expect(columns).toContain('notes');
    expect(columns).toContain('status');
    expect(columns).toContain('planned_date');
    expect(columns).toContain('published_date');
    expect(columns).toContain('patreon_url');
    expect(columns).toContain('created_at');
    expect(columns).toContain('updated_at');
    expect(columns).toContain('archived_at');
  });

  it('releases table has status check constraint', () => {
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    const ddl = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'releases'")
      .pluck()
      .get();
    expect(ddl).toMatch(/CHECK\s*\(status\s+IN\s*\(/i);
  });

  // ─── Phase 5C: release_assets migration tests ──────────────────────────

  it('creates the release_assets table from migration 007', () => {
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = ? AND name = ?")
      .get('table', 'release_assets');
    expect(row).toBeTruthy();
  });

  it('release_assets has composite primary key on (release_id, asset_id)', () => {
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    const pk = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'release_assets'")
      .pluck()
      .get();
    expect(pk).toMatch(/PRIMARY\s+KEY\s*\(\s*release_id\s*,\s*asset_id\s*\)/i);
  });

  it('release_assets has foreign key to releases with cascade delete', () => {
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    const ddl = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'release_assets'")
      .pluck()
      .get();
    expect(ddl).toMatch(/FOREIGN\s+KEY\s*\(\s*release_id\s*\)\s*REFERENCES\s+releases\s*\(\s*id\s*\)\s+ON\s+DELETE\s+CASCADE/i);
  });

  it('release_assets has foreign key to assets with cascade delete', () => {
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    const ddl = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'release_assets'")
      .pluck()
      .get();
    expect(ddl).toMatch(/FOREIGN\s+KEY\s*\(\s*asset_id\s*\)\s*REFERENCES\s+assets\s*\(\s*id\s*\)\s+ON\s+DELETE\s+CASCADE/i);
  });

  it('release_assets has role check constraint', () => {
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    const ddl = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'release_assets'")
      .pluck()
      .get();
    expect(ddl).toMatch(/CHECK\s*\(\s*role\s+IN\s*\(\s*'primary'\s*,\s*'preview'\s*,\s*'attachment'\s*,\s*'source'\s*\)\s*\)/i);
  });

  it('release_assets has sort_order check constraint (non-negative)', () => {
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    const ddl = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'release_assets'")
      .pluck()
      .get();
    expect(ddl).toMatch(/CHECK\s*\(\s*sort_order\s*>=\s*0\s*\)/i);
  });

  it('release_assets has expected indexes', () => {
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'release_assets'")
      .pluck()
      .all();

    expect(indexes).toContain('idx_release_assets_asset_id');
    expect(indexes).toContain('idx_release_assets_release_sort');
  });

  it('release_assets has expected columns', () => {
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    const columns = db
      .prepare("SELECT name FROM pragma_table_info('release_assets')")
      .pluck()
      .all();

    expect(columns).toContain('release_id');
    expect(columns).toContain('asset_id');
    expect(columns).toContain('role');
    expect(columns).toContain('sort_order');
    expect(columns).toContain('created_at');
  });

  it('release_assets cascades delete when release is deleted', () => {
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);

    // Create project
    const projectId = db.prepare(`
      INSERT INTO projects (title, slug, description, notes, status, priority, planned_date, published_date, patreon_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('Test Project', 'test-project', '', '', 'tbd', 'normal', null, null, null).lastInsertRowid;

    // Create release
    const releaseId = db.prepare(`
      INSERT INTO releases (project_id, title, description, notes, status, planned_date, patreon_url)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(projectId, 'R1', '', '', 'idea', null, null).lastInsertRowid;

    // Create asset
    const assetId = db.prepare(`
      INSERT INTO assets (project_id, relative_path, filename, extension, mime_type, size_bytes, modified_at, is_present, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
    `).run(projectId, 'file.txt', 'file.txt', 'txt', 'text/plain', 100, '2025-01-01').lastInsertRowid;

    // Insert release asset
    db.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)')
      .run(releaseId, assetId, 'attachment', 0);

    expect(db.prepare('SELECT COUNT(*) AS c FROM release_assets WHERE release_id = ?').get(releaseId).c).toBe(1);

    // Delete release and verify cascade
    db.prepare('DELETE FROM releases WHERE id = ?').run(releaseId);
    expect(db.prepare('SELECT COUNT(*) AS c FROM release_assets WHERE release_id = ?').get(releaseId).c).toBe(0);
  });

  it('release_assets cascades delete when asset is deleted', () => {
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);

    const projectId = db.prepare(`
      INSERT INTO projects (title, slug, description, notes, status, priority, planned_date, published_date, patreon_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('Test Project', 'test-project', '', '', 'tbd', 'normal', null, null, null).lastInsertRowid;

    const releaseId = db.prepare(`
      INSERT INTO releases (project_id, title, description, notes, status, planned_date, patreon_url)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(projectId, 'R1', '', '', 'idea', null, null).lastInsertRowid;

    const assetId = db.prepare(`
      INSERT INTO assets (project_id, relative_path, filename, extension, mime_type, size_bytes, modified_at, is_present, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
    `).run(projectId, 'file.txt', 'file.txt', 'txt', 'text/plain', 100, '2025-01-01').lastInsertRowid;

    db.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)')
      .run(releaseId, assetId, 'attachment', 0);

    expect(db.prepare('SELECT COUNT(*) AS c FROM release_assets WHERE asset_id = ?').get(assetId).c).toBe(1);

    // Delete asset and verify cascade
    db.prepare('DELETE FROM assets WHERE id = ?').run(assetId);
    expect(db.prepare('SELECT COUNT(*) AS c FROM release_assets WHERE asset_id = ?').get(assetId).c).toBe(0);
  });
});
