import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

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

describe('release schema in the consolidated baseline migration', () => {
  let tmpDir;
  let db;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-release-schema-'));
    db = undefined;
  });

  afterEach(() => {
    closeDatabase(db);
    db = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('freshly applies the single migration to the final status-free release schema', () => {
    db = openDatabase(path.join(tmpDir, 'fresh.db'));
    runMigrations(db, MIGRATIONS_DIR);

    expect(db.prepare('SELECT filename FROM schema_migrations ORDER BY rowid').pluck().all())
      .toEqual(['001_initial.sql', '002_add_completed_status.sql', '003_remove_project_priority.sql']);
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

  it('is idempotent and preserves the exact release schema signature across repeated runs', () => {
    db = openDatabase(path.join(tmpDir, 'repeat.db'));
    runMigrations(db, MIGRATIONS_DIR);
    const firstSignature = releaseSchemaSignature(db);

    runMigrations(db, MIGRATIONS_DIR);

    expect(db.prepare('SELECT filename FROM schema_migrations ORDER BY rowid').pluck().all())
      .toEqual(['001_initial.sql', '002_add_completed_status.sql', '003_remove_project_priority.sql']);
    expect(releaseSchemaSignature(db)).toEqual(firstSignature);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});
