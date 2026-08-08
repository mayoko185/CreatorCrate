import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('tags schema in the baseline migration', () => {
  let tmpDir;
  let dbPath;
  let db;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-tags-migration-'));
    dbPath = path.join(tmpDir, 'test.db');
    db = undefined;
  });

  afterEach(() => {
    closeDatabase(db);
    db = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function migrate() {
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
  }

  function createProject(title) {
    return Number(db.prepare(`
      INSERT INTO projects (
        title, slug, description, notes, status, priority,
        planned_date, published_date, patreon_url
      ) VALUES (?, ?, '', '', 'tbd', 'normal', NULL, NULL, NULL)
    `).run(title, title.toLowerCase().replaceAll(' ', '-')).lastInsertRowid);
  }

  function createAsset(projectId, relativePath) {
    const filename = relativePath.split('/').pop();
    return Number(db.prepare(`
      INSERT INTO assets (project_id, relative_path, filename)
      VALUES (?, ?, ?)
    `).run(projectId, relativePath, filename).lastInsertRowid);
  }

  function createTag(displayName, normalizedName) {
    return Number(db.prepare(`
      INSERT INTO tags (display_name, normalized_name)
      VALUES (?, ?)
    `).run(displayName, normalizedName).lastInsertRowid);
  }

  function assignProject(projectId, tagId) {
    db.prepare('INSERT INTO project_tags (project_id, tag_id) VALUES (?, ?)').run(projectId, tagId);
  }

  function assignAsset(assetId, tagId) {
    db.prepare('INSERT INTO asset_tags (asset_id, tag_id) VALUES (?, ?)').run(assetId, tagId);
  }

  function countRows(table, column, value) {
    return db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`).get(value).count;
  }

  function tableColumns(table) {
    return db.pragma(`table_info(${table})`).map((column) => column.name);
  }

  function tableDdl(table) {
    return db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .pluck()
      .get(table);
  }

  function tableIndexes(table) {
    return db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?")
      .pluck()
      .all(table);
  }

  it('applies on a fresh database, records the single migration, and is idempotent', () => {
    migrate();

    expect(() => runMigrations(db, MIGRATIONS_DIR)).not.toThrow();

    const applied = db.prepare('SELECT filename FROM schema_migrations ORDER BY rowid').pluck().all();
    expect(applied).toEqual(['001_initial.sql', '002_add_completed_status.sql']);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('creates tag and assignment tables with the required constraints and indexes', () => {
    migrate();

    expect(tableColumns('tags')).toEqual([
      'id',
      'display_name',
      'normalized_name',
      'created_at',
      'updated_at',
    ]);
    expect(tableColumns('project_tags')).toEqual(['project_id', 'tag_id', 'created_at']);
    expect(tableColumns('asset_tags')).toEqual(['asset_id', 'tag_id', 'created_at']);

    const tagsIndexSql = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_tags_normalized_name'")
      .pluck()
      .get();
    expect(tagsIndexSql).toMatch(/CREATE UNIQUE INDEX/i);
    expect(tableIndexes('project_tags')).toContain('idx_project_tags_tag_id');
    expect(tableIndexes('asset_tags')).toContain('idx_asset_tags_tag_id');

    const projectTagsDdl = tableDdl('project_tags');
    expect(projectTagsDdl).toMatch(/PRIMARY KEY\s*\(\s*project_id\s*,\s*tag_id\s*\)/i);
    expect(projectTagsDdl).toMatch(/FOREIGN KEY\s*\(\s*project_id\s*\)\s*REFERENCES\s*projects\s*\(\s*id\s*\)\s*ON\s+DELETE\s+CASCADE/i);
    expect(projectTagsDdl).toMatch(/FOREIGN KEY\s*\(\s*tag_id\s*\)\s*REFERENCES\s*tags\s*\(\s*id\s*\)\s*ON\s+DELETE\s+CASCADE/i);

    const assetTagsDdl = tableDdl('asset_tags');
    expect(assetTagsDdl).toMatch(/PRIMARY KEY\s*\(\s*asset_id\s*,\s*tag_id\s*\)/i);
    expect(assetTagsDdl).toMatch(/FOREIGN KEY\s*\(\s*asset_id\s*\)\s*REFERENCES\s*assets\s*\(\s*id\s*\)\s*ON\s+DELETE\s+CASCADE/i);
    expect(assetTagsDdl).toMatch(/FOREIGN KEY\s*\(\s*tag_id\s*\)\s*REFERENCES\s*tags\s*\(\s*id\s*\)\s*ON\s+DELETE\s+CASCADE/i);
  });

  it('stores display and normalized names while rejecting duplicate normalized names', () => {
    migrate();

    const tagId = createTag('Character Art', 'character art');
    expect(db.prepare('SELECT display_name, normalized_name, created_at, updated_at FROM tags WHERE id = ?').get(tagId))
      .toMatchObject({
        display_name: 'Character Art',
        normalized_name: 'character art',
      });

    expect(() => createTag('CHARACTER ART', 'character art')).toThrow(/UNIQUE constraint failed/i);
  });

  it('supports multiple tags per project and asset, and multiple projects and assets per tag', () => {
    migrate();

    const projectOneId = createProject('Project One');
    const projectTwoId = createProject('Project Two');
    const assetOneId = createAsset(projectOneId, 'one.png');
    const assetTwoId = createAsset(projectTwoId, 'two.png');
    const tagOneId = createTag('Character Art', 'character art');
    const tagTwoId = createTag('Published', 'published');

    assignProject(projectOneId, tagOneId);
    assignProject(projectOneId, tagTwoId);
    assignProject(projectTwoId, tagOneId);
    assignAsset(assetOneId, tagOneId);
    assignAsset(assetOneId, tagTwoId);
    assignAsset(assetTwoId, tagOneId);

    expect(countRows('project_tags', 'project_id', projectOneId)).toBe(2);
    expect(countRows('asset_tags', 'asset_id', assetOneId)).toBe(2);
    expect(countRows('project_tags', 'tag_id', tagOneId)).toBe(2);
    expect(countRows('asset_tags', 'tag_id', tagOneId)).toBe(2);

    expect(() => assignProject(projectOneId, tagOneId)).toThrow(/UNIQUE constraint failed/i);
    expect(() => assignAsset(assetOneId, tagOneId)).toThrow(/UNIQUE constraint failed/i);
  });

  it('deletes tag assignments without deleting projects or assets, and cascades owner deletions only to assignments', () => {
    migrate();

    const projectOneId = createProject('Project One');
    const projectTwoId = createProject('Project Two');
    const assetOneId = createAsset(projectOneId, 'one.png');
    const assetTwoId = createAsset(projectTwoId, 'two.png');
    const deletedTagId = createTag('Temporary', 'temporary');
    const retainedTagId = createTag('Retained', 'retained');

    assignProject(projectOneId, deletedTagId);
    assignProject(projectOneId, retainedTagId);
    assignProject(projectTwoId, deletedTagId);
    assignProject(projectTwoId, retainedTagId);
    assignAsset(assetOneId, deletedTagId);
    assignAsset(assetOneId, retainedTagId);
    assignAsset(assetTwoId, deletedTagId);
    assignAsset(assetTwoId, retainedTagId);

    db.prepare('DELETE FROM tags WHERE id = ?').run(deletedTagId);

    expect(db.prepare('SELECT COUNT(*) AS count FROM projects').get().count).toBe(2);
    expect(db.prepare('SELECT COUNT(*) AS count FROM assets').get().count).toBe(2);
    expect(countRows('project_tags', 'tag_id', deletedTagId)).toBe(0);
    expect(countRows('asset_tags', 'tag_id', deletedTagId)).toBe(0);
    expect(countRows('project_tags', 'tag_id', retainedTagId)).toBe(2);
    expect(countRows('asset_tags', 'tag_id', retainedTagId)).toBe(2);

    db.prepare('DELETE FROM projects WHERE id = ?').run(projectOneId);

    expect(db.prepare('SELECT COUNT(*) AS count FROM projects WHERE id = ?').get(projectOneId).count).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM assets WHERE id = ?').get(assetOneId).count).toBe(0);
    expect(countRows('project_tags', 'project_id', projectOneId)).toBe(0);
    expect(countRows('asset_tags', 'asset_id', assetOneId)).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM tags WHERE id = ?').get(retainedTagId).count).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS count FROM projects WHERE id = ?').get(projectTwoId).count).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS count FROM assets WHERE id = ?').get(assetTwoId).count).toBe(1);

    db.prepare('DELETE FROM assets WHERE id = ?').run(assetTwoId);

    expect(db.prepare('SELECT COUNT(*) AS count FROM assets WHERE id = ?').get(assetTwoId).count).toBe(0);
    expect(countRows('asset_tags', 'asset_id', assetTwoId)).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM tags WHERE id = ?').get(retainedTagId).count).toBe(1);
  });

  it('rejects project and asset assignments with missing foreign-key parents', () => {
    migrate();

    const projectId = createProject('Valid Project');
    const assetId = createAsset(projectId, 'valid.png');
    const tagId = createTag('Valid Tag', 'valid tag');

    expect(() => db.prepare('INSERT INTO project_tags (project_id, tag_id) VALUES (?, ?)').run(999999, tagId))
      .toThrow(/FOREIGN KEY constraint failed/i);
    expect(() => db.prepare('INSERT INTO project_tags (project_id, tag_id) VALUES (?, ?)').run(projectId, 999999))
      .toThrow(/FOREIGN KEY constraint failed/i);
    expect(() => db.prepare('INSERT INTO asset_tags (asset_id, tag_id) VALUES (?, ?)').run(999999, tagId))
      .toThrow(/FOREIGN KEY constraint failed/i);
    expect(() => db.prepare('INSERT INTO asset_tags (asset_id, tag_id) VALUES (?, ?)').run(assetId, 999999))
      .toThrow(/FOREIGN KEY constraint failed/i);
  });
});
