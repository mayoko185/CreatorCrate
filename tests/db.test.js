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

  it('creates the project_dir column in the baseline schema', () => {
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

  it('records all migrations and is idempotent across repeated runs', () => {
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    runMigrations(db, MIGRATIONS_DIR);
    const applied = db.prepare('SELECT filename FROM schema_migrations ORDER BY rowid').pluck().all();
    expect(applied).toEqual(['001_initial.sql', '002_unify_release_statuses.sql']);
  });

  it('creates the complete fresh-install table set with foreign keys enabled', () => {
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);

    const tables = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).pluck().all();

    expect(tables).toEqual([
      'app_meta',
      'asset_category_defaults',
      'asset_tags',
      'assets',
      'project_asset_browser_preferences',
      'project_asset_categories',
      'project_primary_images',
      'project_tags',
      'projects',
      'release_assets',
      'releases',
      'schema_migrations',
      'sessions',
      'tags',
    ]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('rejects published as a project status', () => {
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);

    expect(() => db.prepare(`
      INSERT INTO projects (title, slug, status, priority)
      VALUES ('Published Project', 'published-project', 'published', 'normal')
    `).run()).toThrow(/CHECK constraint failed/i);
  });

  it('closes cleanly', () => {
    db = openDatabase(dbPath);
    expect(() => closeDatabase(db)).not.toThrow();
  });

  // ─── Phase 4: asset migration tests ──────────────────────────────

  it('creates the assets table from the baseline schema', () => {
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

  it('creates the releases table from the baseline schema', () => {
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
    expect(columns).toContain('planned_time');
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

  it('uses the unified release status vocabulary in fresh databases', () => {
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);

    const projectId = db.prepare(`
      INSERT INTO projects (title, slug, status, priority)
      VALUES ('Status Project', 'status-project', 'tbd', 'normal')
    `).run().lastInsertRowid;

    const release = db.prepare(`
      INSERT INTO releases (project_id, title)
      VALUES (?, 'Default Status Release')
    `).run(projectId);

    expect(db.prepare('SELECT status FROM releases WHERE id = ?').pluck().get(release.lastInsertRowid)).toBe('tbd');
    for (const legacyStatus of ['idea', 'drafting']) {
      expect(() => db.prepare(`
        INSERT INTO releases (project_id, title, status)
        VALUES (?, ?, ?)
      `).run(projectId, `Legacy ${legacyStatus}`, legacyStatus)).toThrow(/CHECK constraint failed/i);
    }
  });

  it('migrates legacy release statuses and preserves release assets', () => {
    db = openDatabase(dbPath);
    db.exec(`
      CREATE TABLE schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations (filename, applied_at) VALUES ('001_initial.sql', datetime('now'));

      CREATE TABLE projects (id INTEGER PRIMARY KEY, title TEXT NOT NULL);
      CREATE TABLE assets (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL);
      CREATE TABLE releases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'idea'
          CHECK (status IN ('idea', 'planned', 'drafting', 'ready', 'published', 'cancelled')),
        planned_date TEXT,
        planned_time TEXT,
        published_date TEXT,
        patreon_url TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        archived_at TEXT,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT
      );
      CREATE INDEX idx_releases_project_id ON releases(project_id);
      CREATE INDEX idx_releases_status ON releases(status);
      CREATE INDEX idx_releases_planned_date ON releases(planned_date DESC)
        WHERE status IN ('idea', 'planned', 'drafting', 'ready');
      CREATE INDEX idx_releases_overdue ON releases(planned_date)
        WHERE status IN ('idea', 'planned', 'drafting', 'ready') AND planned_date IS NOT NULL;
      CREATE INDEX idx_releases_archived ON releases(archived_at)
        WHERE archived_at IS NOT NULL;
      CREATE TABLE release_assets (
        release_id INTEGER NOT NULL,
        asset_id INTEGER NOT NULL,
        role TEXT NOT NULL DEFAULT 'attachment'
          CHECK (role IN ('primary', 'preview', 'attachment', 'source')),
        sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (release_id, asset_id),
        FOREIGN KEY (release_id) REFERENCES releases(id) ON DELETE CASCADE,
        FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_release_assets_asset_id ON release_assets(asset_id);
      CREATE INDEX idx_release_assets_release_sort ON release_assets(release_id, sort_order);

      INSERT INTO projects (id, title) VALUES (1, 'Legacy Project');
      INSERT INTO assets (id, project_id) VALUES (10, 1);
      INSERT INTO releases (id, project_id, title, status)
      VALUES (11, 1, 'Legacy TBD', 'idea'), (12, 1, 'Legacy In Progress', 'drafting');
      INSERT INTO release_assets (release_id, asset_id, role, sort_order)
      VALUES (12, 10, 'attachment', 3);
    `);

    runMigrations(db, MIGRATIONS_DIR);

    expect(db.prepare('SELECT id, status FROM releases ORDER BY id').all()).toEqual([
      { id: 11, status: 'tbd' },
      { id: 12, status: 'in-progress' },
    ]);
    expect(db.prepare('SELECT release_id, asset_id, role, sort_order FROM release_assets').all()).toEqual([
      { release_id: 12, asset_id: 10, role: 'attachment', sort_order: 3 },
    ]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'releases_legacy'").get()).toBeUndefined();
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(() => db.prepare(`
      INSERT INTO releases (project_id, title, status) VALUES (1, 'Rejected Legacy', 'idea')
    `).run()).toThrow(/CHECK constraint failed/i);
  });

  // ─── Phase 5C: release_assets migration tests ──────────────────────────

  it('creates the release_assets table from the baseline schema', () => {
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
    `).run(projectId, 'R1', '', '', 'tbd', null, null).lastInsertRowid;

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
    `).run(projectId, 'R1', '', '', 'tbd', null, null).lastInsertRowid;

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

  // ─── Phase 1: asset category migration tests ────────────────────────

  it('creates the asset category tables from the baseline schema', () => {
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)")
      .all('asset_category_defaults', 'project_asset_categories')
      .map((row) => row.name);
    expect(tables).toContain('asset_category_defaults');
    expect(tables).toContain('project_asset_categories');
  });

  it('seeds the five required defaults, enabled, in exact order', () => {
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    const rows = db
      .prepare('SELECT display_name, directory_slug, display_order, enabled FROM asset_category_defaults ORDER BY display_order ASC, id ASC')
      .all();

    expect(rows).toEqual([
      { display_name: 'Source', directory_slug: 'source', display_order: 0, enabled: 1 },
      { display_name: 'Exports', directory_slug: 'exports', display_order: 1, enabled: 1 },
      { display_name: 'Extras', directory_slug: 'extras', display_order: 2, enabled: 1 },
      { display_name: 'References', directory_slug: 'references', display_order: 3, enabled: 1 },
      { display_name: 'Thumbnails', directory_slug: 'thumbnails', display_order: 4, enabled: 1 },
    ]);
  });

  it('does not seed obsolete defaults or nested export paths', () => {
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    const slugs = db
      .prepare('SELECT directory_slug FROM asset_category_defaults')
      .pluck()
      .all();

    for (const obsolete of ['raw', 'wip', 'promo', 'final', 'exports/full', 'exports/web']) {
      expect(slugs).not.toContain(obsolete);
    }
    expect(slugs).toHaveLength(5);
  });

  it('project_asset_categories references the owning project correctly', () => {
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);

    const ddl = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'project_asset_categories'")
      .pluck()
      .get();
    expect(ddl).toMatch(/FOREIGN KEY\s*\(project_id\)\s*REFERENCES\s*projects\(id\)/i);

    const projectId = db.prepare(`
      INSERT INTO projects (title, slug, description, notes, status, priority, planned_date, published_date, patreon_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('Test Project', 'test-project', '', '', 'tbd', 'normal', null, null, null).lastInsertRowid;

    const categoryId = db.prepare(`
      INSERT INTO project_asset_categories (project_id, display_name, directory_slug, display_order, enabled)
      VALUES (?, ?, ?, ?, ?)
    `).run(projectId, 'Source', 'source', 0, 1).lastInsertRowid;

    const row = db.prepare('SELECT project_id FROM project_asset_categories WHERE id = ?').get(categoryId);
    expect(row.project_id).toBe(projectId);
  });

  it('project_asset_categories has no live relationship to asset_category_defaults', () => {
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    const columns = db
      .prepare("SELECT name FROM pragma_table_info('project_asset_categories')")
      .pluck()
      .all();
    expect(columns).not.toContain('default_category_id');
  });

  it('produces the expected final assets table schema in the baseline', () => {
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);

    const columns = db
      .prepare("SELECT name, type, \"notnull\", dflt_value, pk FROM pragma_table_info('assets')")
      .all();

    expect(columns).toEqual([
      { name: 'id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1 },
      { name: 'project_id', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'category_id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 },
      { name: 'relative_path', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'nested_path', type: 'TEXT', notnull: 1, dflt_value: "''", pk: 0 },
      { name: 'filename', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'extension', type: 'TEXT', notnull: 1, dflt_value: "''", pk: 0 },
      { name: 'mime_type', type: 'TEXT', notnull: 1, dflt_value: "'application/octet-stream'", pk: 0 },
      { name: 'size_bytes', type: 'INTEGER', notnull: 1, dflt_value: '0', pk: 0 },
      { name: 'modified_at', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      { name: 'created_at', type: 'TEXT', notnull: 1, dflt_value: "datetime('now')", pk: 0 },
      { name: 'updated_at', type: 'TEXT', notnull: 1, dflt_value: "datetime('now')", pk: 0 },
      { name: 'is_present', type: 'INTEGER', notnull: 1, dflt_value: '1', pk: 0 },
      { name: 'last_seen_at', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      { name: 'missing_since', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    ]);
  });
});
