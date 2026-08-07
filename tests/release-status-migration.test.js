import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const MIGRATION_FILENAMES = [
  '001_initial.sql',
  '002_unify_release_statuses.sql',
  '003_drop_release_status.sql',
];

const EXPECTED_RELEASE_COLUMNS = [
  { name: 'id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1 },
  { name: 'project_id', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
  { name: 'title', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
  { name: 'description', type: 'TEXT', notnull: 1, dflt_value: "''", pk: 0 },
  { name: 'notes', type: 'TEXT', notnull: 1, dflt_value: "''", pk: 0 },
  { name: 'planned_date', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
  { name: 'planned_time', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
  { name: 'published_date', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
  { name: 'patreon_url', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
  { name: 'created_at', type: 'TEXT', notnull: 1, dflt_value: "datetime('now')", pk: 0 },
  { name: 'updated_at', type: 'TEXT', notnull: 1, dflt_value: "datetime('now')", pk: 0 },
  { name: 'archived_at', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
];

function tableInfo(db, table) {
  return db.pragma(`table_info(${table})`).map(({ name, type, notnull, dflt_value, pk }) => ({
    name,
    type,
    notnull,
    dflt_value,
    pk,
  }));
}

function tableDdl(db, table) {
  return db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .pluck()
    .get(table);
}

function tableIndexes(db, table) {
  return db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? ORDER BY name")
    .all(table);
}

function normalizeSql(sql) {
  return sql.replaceAll(/\s+/g, ' ').trim();
}

function releaseSchemaSignature(db) {
  return {
    releases: {
      columns: tableInfo(db, 'releases'),
      ddl: normalizeSql(tableDdl(db, 'releases')),
      indexes: tableIndexes(db, 'releases').map(({ name, sql }) => ({ name, sql: sql && normalizeSql(sql) })),
    },
    releaseAssets: {
      columns: tableInfo(db, 'release_assets'),
      ddl: normalizeSql(tableDdl(db, 'release_assets')),
      indexes: tableIndexes(db, 'release_assets').map(({ name, sql }) => ({ name, sql: sql && normalizeSql(sql) })),
    },
  };
}

function createProject(db, id, title = `Project ${id}`) {
  db.prepare(`
    INSERT INTO projects (id, title, slug, description, notes, status, priority)
    VALUES (?, ?, ?, '', '', 'tbd', 'normal')
  `).run(id, title, title.toLowerCase().replaceAll(' ', '-'));
  return id;
}

function createAsset(db, id, projectId, relativePath = `asset-${id}.txt`) {
  db.prepare(`
    INSERT INTO assets (id, project_id, relative_path, filename)
    VALUES (?, ?, ?, ?)
  `).run(id, projectId, relativePath, path.basename(relativePath));
  return id;
}

function insertStatusRelease(db, values) {
  return Number(db.prepare(`
    INSERT INTO releases (
      id, project_id, title, description, notes, status,
      planned_date, planned_time, published_date, patreon_url,
      created_at, updated_at, archived_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    values.id,
    values.projectId,
    values.title,
    values.description,
    values.notes,
    values.status,
    values.plannedDate,
    values.plannedTime,
    values.publishedDate,
    values.patreonUrl,
    values.createdAt,
    values.updatedAt,
    values.archivedAt,
  ).lastInsertRowid);
}

function insertStatusReleaseLegacy(db, values) {
  return Number(db.prepare(`
    INSERT INTO releases (
      id, project_id, title, description, notes, status,
      planned_date, planned_time, published_date, patreon_url,
      created_at, updated_at, archived_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    values.id,
    values.projectId,
    values.title,
    values.description,
    values.notes,
    values.status,
    values.plannedDate,
    values.plannedTime,
    values.publishedDate,
    values.patreonUrl,
    values.createdAt,
    values.updatedAt,
    values.archivedAt,
  ).lastInsertRowid);
}

function runMigrationsThrough(db, tmpDir, filenames) {
  const stagedDir = fs.mkdtempSync(path.join(tmpDir, 'migrations-'));
  try {
    for (const filename of filenames) {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, filename), path.join(stagedDir, filename));
    }
    runMigrations(db, stagedDir);
  } finally {
    fs.rmSync(stagedDir, { recursive: true, force: true });
  }
}

describe('release status removal migration', () => {
  let tmpDir;
  let db;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-release-status-migration-'));
    db = undefined;
  });

  afterEach(() => {
    closeDatabase(db);
    db = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('freshly applies all migrations to the final status-free schema', () => {
    db = openDatabase(path.join(tmpDir, 'fresh.db'));
    runMigrations(db, MIGRATIONS_DIR);

    expect(db.prepare('SELECT filename FROM schema_migrations ORDER BY rowid').pluck().all())
      .toEqual(MIGRATION_FILENAMES);
    expect(tableInfo(db, 'releases')).toEqual(EXPECTED_RELEASE_COLUMNS);
    expect(tableInfo(db, 'releases').map((column) => column.name)).not.toContain('status');

    const releaseIndexes = tableIndexes(db, 'releases');
    expect(releaseIndexes.map((index) => index.name)).toEqual(expect.arrayContaining([
      'idx_releases_project_id',
      'idx_releases_planned_date',
      'idx_releases_overdue',
      'idx_releases_archived',
    ]));
    expect(releaseIndexes.map((index) => index.name)).not.toContain('idx_releases_status');
    expect(releaseIndexes.find((index) => index.name === 'idx_releases_planned_date').sql)
      .toMatch(/WHERE\s+archived_at\s+IS\s+NULL\s+AND\s+published_date\s+IS\s+NULL/i);
    expect(releaseIndexes.find((index) => index.name === 'idx_releases_overdue').sql)
      .toMatch(/WHERE\s+archived_at\s+IS\s+NULL\s+AND\s+published_date\s+IS\s+NULL\s+AND\s+planned_date\s+IS\s+NOT\s+NULL/i);

    const releasesDdl = tableDdl(db, 'releases');
    expect(releasesDdl).toMatch(/FOREIGN KEY\s*\(project_id\)\s*REFERENCES\s*projects\(id\)\s*ON DELETE RESTRICT/i);
    expect(releasesDdl).not.toMatch(/\bstatus\b/i);

    const releaseAssetsDdl = tableDdl(db, 'release_assets');
    expect(releaseAssetsDdl).toMatch(/PRIMARY KEY\s*\(release_id, asset_id\)/i);
    expect(releaseAssetsDdl).toMatch(/FOREIGN KEY\s*\(release_id\)\s*REFERENCES\s*releases\(id\)\s*ON DELETE CASCADE/i);
    expect(releaseAssetsDdl).toMatch(/FOREIGN KEY\s*\(asset_id\)\s*REFERENCES\s*assets\(id\)\s*ON DELETE CASCADE/i);
    expect(tableIndexes(db, 'release_assets').map((index) => index.name)).toEqual(expect.arrayContaining([
      'idx_release_assets_asset_id',
      'idx_release_assets_release_sort',
    ]));
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('upgrades a database already at 002 without losing release metadata or associations', () => {
    db = openDatabase(path.join(tmpDir, 'at-002.db'));
    runMigrationsThrough(db, tmpDir, MIGRATION_FILENAMES.slice(0, 2));
    expect(db.prepare('SELECT filename FROM schema_migrations ORDER BY rowid').pluck().all())
      .toEqual(MIGRATION_FILENAMES.slice(0, 2));

    const projectId = createProject(db, 7, 'Upgrade Project');
    const firstAssetId = createAsset(db, 301, projectId, 'source/first.txt');
    const secondAssetId = createAsset(db, 302, projectId, 'source/second.txt');
    const sourceReleases = [
      {
        id: 41,
        projectId,
        title: 'Published with fallback',
        description: 'Published description',
        notes: 'Published notes must survive',
        status: 'published',
        plannedDate: '2025-04-05',
        plannedTime: '09:30',
        publishedDate: null,
        patreonUrl: 'https://patreon.example/published',
        createdAt: '2025-04-01 00:00:00',
        updatedAt: '2025-04-06 11:12:13',
        archivedAt: null,
      },
      {
        id: 42,
        projectId,
        title: 'Cancelled with archive fallback',
        description: 'Cancelled description',
        notes: 'Cancelled notes must survive',
        status: 'cancelled',
        plannedDate: '2025-04-07',
        plannedTime: '10:30',
        publishedDate: null,
        patreonUrl: null,
        createdAt: '2025-04-02 00:00:00',
        updatedAt: '2025-04-08 14:15:16',
        archivedAt: null,
      },
      {
        id: 43,
        projectId,
        title: 'Published with existing date',
        description: 'Existing publication description',
        notes: 'Existing publication notes',
        status: 'published',
        plannedDate: null,
        plannedTime: null,
        publishedDate: '2025-01-02',
        patreonUrl: null,
        createdAt: '2025-04-03 00:00:00',
        updatedAt: '2025-04-04 00:00:00',
        archivedAt: null,
      },
      {
        id: 44,
        projectId,
        title: 'Cancelled with existing archive',
        description: 'Existing archive description',
        notes: 'Existing archive notes',
        status: 'cancelled',
        plannedDate: null,
        plannedTime: null,
        publishedDate: null,
        patreonUrl: null,
        createdAt: '2025-04-05 00:00:00',
        updatedAt: '2025-04-06 00:00:00',
        archivedAt: '2025-04-07 00:00:00',
      },
      {
        id: 90,
        projectId,
        title: 'Active release',
        description: 'Active description',
        notes: 'Active notes',
        status: 'ready',
        plannedDate: '2025-05-01',
        plannedTime: '12:00',
        publishedDate: null,
        patreonUrl: 'https://patreon.example/active',
        createdAt: '2025-04-08 00:00:00',
        updatedAt: '2025-04-09 00:00:00',
        archivedAt: null,
      },
    ];
    for (const release of sourceReleases) insertStatusRelease(db, release);

    db.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)')
      .run(41, firstAssetId, 'primary', 4);
    db.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)')
      .run(41, secondAssetId, 'preview', 1);
    db.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)')
      .run(42, firstAssetId, 'source', 2);

    const releaseRowsBefore = db.prepare(`
      SELECT id, project_id, title, description, notes, status,
        planned_date, planned_time, published_date, patreon_url,
        created_at, updated_at, archived_at
      FROM releases ORDER BY id
    `).all();
    const releaseAssetsBefore = db.prepare(`
      SELECT release_id, asset_id, role, sort_order, created_at
      FROM release_assets ORDER BY release_id, sort_order, asset_id
    `).all();
    const previousMaximumReleaseId = Math.max(...releaseRowsBefore.map((row) => row.id));

    runMigrations(db, MIGRATIONS_DIR);

    expect(db.prepare('SELECT filename FROM schema_migrations ORDER BY rowid').pluck().all())
      .toEqual(MIGRATION_FILENAMES);
    expect(tableInfo(db, 'releases').map((column) => column.name)).not.toContain('status');

    const expectedReleaseRows = releaseRowsBefore.map(({ status, ...row }) => ({
      ...row,
      published_date: status === 'published' && row.published_date === null
        ? '2025-04-06'
        : row.published_date,
      archived_at: status === 'cancelled' && row.archived_at === null
        ? row.updated_at
        : row.archived_at,
    }));
    const releaseRowsAfter = db.prepare(`
      SELECT id, project_id, title, description, notes,
        planned_date, planned_time, published_date, patreon_url,
        created_at, updated_at, archived_at
      FROM releases ORDER BY id
    `).all();
    expect(releaseRowsAfter).toEqual(expectedReleaseRows);
    expect(releaseRowsAfter.find((row) => row.id === 41).published_date).toBe('2025-04-06');
    expect(releaseRowsAfter.find((row) => row.id === 42).archived_at).toBe('2025-04-08 14:15:16');

    expect(db.prepare(`
      SELECT release_id, asset_id, role, sort_order, created_at
      FROM release_assets ORDER BY release_id, sort_order, asset_id
    `).all()).toEqual(releaseAssetsBefore);
    expect(db.pragma('foreign_key_check')).toEqual([]);

    expect(() => db.prepare('DELETE FROM projects WHERE id = ?').run(projectId))
      .toThrow(/FOREIGN KEY constraint failed/i);

    const newReleaseId = Number(db.prepare(
      'INSERT INTO releases (project_id, title, notes) VALUES (?, ?, ?)'
    ).run(projectId, 'Post-migration release', 'Post-migration notes').lastInsertRowid);
    expect(newReleaseId).toBeGreaterThan(previousMaximumReleaseId);

    const cascadeAssetId = createAsset(db, 999, projectId, 'cascade.txt');
    db.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)')
      .run(newReleaseId, cascadeAssetId, 'attachment', 0);
    db.prepare('DELETE FROM releases WHERE id = ?').run(newReleaseId);
    expect(db.prepare('SELECT COUNT(*) AS count FROM release_assets WHERE release_id = ?').get(newReleaseId).count)
      .toBe(0);

    const assetCascadeReleaseId = Number(db.prepare(
      'INSERT INTO releases (project_id, title) VALUES (?, ?)'
    ).run(projectId, 'Asset cascade release').lastInsertRowid);
    db.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)')
      .run(assetCascadeReleaseId, cascadeAssetId, 'attachment', 0);
    db.prepare('DELETE FROM assets WHERE id = ?').run(cascadeAssetId);
    expect(db.prepare('SELECT COUNT(*) AS count FROM release_assets WHERE asset_id = ?').get(cascadeAssetId).count)
      .toBe(0);
  });

  it('converges a legacy database through 002 and 003 to the same target schema', () => {
    db = openDatabase(path.join(tmpDir, 'legacy.db'));
    db.exec(`
      CREATE TABLE schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations (filename, applied_at)
      VALUES ('001_initial.sql', datetime('now'));

      CREATE TABLE projects (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL
      );
      CREATE TABLE assets (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL,
        relative_path TEXT NOT NULL,
        filename TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
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
      INSERT INTO assets (id, project_id, relative_path, filename)
      VALUES (10, 1, 'legacy.txt', 'legacy.txt');
    `);

    insertStatusReleaseLegacy(db, {
      id: 11,
      projectId: 1,
      title: 'Legacy idea',
      description: 'Legacy description',
      notes: 'Legacy notes',
      status: 'idea',
      plannedDate: '2025-06-01',
      plannedTime: '14:30',
      publishedDate: null,
      patreonUrl: null,
      createdAt: '2025-05-01 00:00:00',
      updatedAt: '2025-05-02 00:00:00',
      archivedAt: null,
    });
    insertStatusReleaseLegacy(db, {
      id: 12,
      projectId: 1,
      title: 'Legacy drafting',
      description: 'Draft description',
      notes: 'Draft notes',
      status: 'drafting',
      plannedDate: null,
      plannedTime: null,
      publishedDate: null,
      patreonUrl: null,
      createdAt: '2025-05-03 00:00:00',
      updatedAt: '2025-05-04 00:00:00',
      archivedAt: null,
    });
    insertStatusReleaseLegacy(db, {
      id: 13,
      projectId: 1,
      title: 'Legacy published',
      description: 'Published description',
      notes: 'Published notes',
      status: 'published',
      plannedDate: null,
      plannedTime: null,
      publishedDate: null,
      patreonUrl: 'https://patreon.example/legacy',
      createdAt: '2025-05-05 00:00:00',
      updatedAt: '2025-05-06 07:08:09',
      archivedAt: null,
    });
    insertStatusReleaseLegacy(db, {
      id: 14,
      projectId: 1,
      title: 'Legacy cancelled',
      description: 'Cancelled description',
      notes: 'Cancelled notes',
      status: 'cancelled',
      plannedDate: null,
      plannedTime: null,
      publishedDate: null,
      patreonUrl: null,
      createdAt: '2025-05-07 00:00:00',
      updatedAt: '2025-05-08 09:10:11',
      archivedAt: null,
    });
    db.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)')
      .run(12, 10, 'attachment', 3);
    const releaseAssetsBefore = db.prepare(
      'SELECT release_id, asset_id, role, sort_order, created_at FROM release_assets'
    ).all();

    runMigrations(db, MIGRATIONS_DIR);

    expect(db.prepare('SELECT filename FROM schema_migrations ORDER BY rowid').pluck().all())
      .toEqual(MIGRATION_FILENAMES);
    expect(tableInfo(db, 'releases').map((column) => column.name)).not.toContain('status');
    expect(db.prepare('SELECT id, title, notes, published_date, archived_at FROM releases ORDER BY id').all())
      .toEqual([
        { id: 11, title: 'Legacy idea', notes: 'Legacy notes', published_date: null, archived_at: null },
        { id: 12, title: 'Legacy drafting', notes: 'Draft notes', published_date: null, archived_at: null },
        { id: 13, title: 'Legacy published', notes: 'Published notes', published_date: '2025-05-06', archived_at: null },
        { id: 14, title: 'Legacy cancelled', notes: 'Cancelled notes', published_date: null, archived_at: '2025-05-08 09:10:11' },
      ]);
    // Regression guard: planned_time must survive the 001 → 002 → 003 upgrade
    // path. Migration 002 rebuilds the releases table; dropping planned_time
    // from its INSERT/SELECT column lists silently nulls any seeded value.
    expect(db.prepare('SELECT id, planned_time FROM releases WHERE id = 11').get())
      .toEqual({ id: 11, planned_time: '14:30' });
    expect(db.prepare(
      'SELECT release_id, asset_id, role, sort_order, created_at FROM release_assets'
    ).all()).toEqual(releaseAssetsBefore);
    expect(db.pragma('foreign_key_check')).toEqual([]);

    const freshPath = path.join(tmpDir, 'fresh-target.db');
    const freshDb = openDatabase(freshPath);
    try {
      runMigrations(freshDb, MIGRATIONS_DIR);
      expect(releaseSchemaSignature(db)).toEqual(releaseSchemaSignature(freshDb));
    } finally {
      closeDatabase(freshDb);
    }
  });
});
