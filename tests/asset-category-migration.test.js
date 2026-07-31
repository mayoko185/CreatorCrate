import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import slugify from '@sindresorhus/slugify';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createProjectRepository } from '../src/data/project-repository.js';

const REAL_MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const MIGRATION_010 = '010_asset_categories.sql';

/** Copy every migration file up to (and including) `lastFilename` into `destDir`. */
function copyMigrationsUpTo(destDir, lastFilename) {
  const files = fs.readdirSync(REAL_MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (lastFilename && f > lastFilename) continue;
    fs.copyFileSync(path.join(REAL_MIGRATIONS_DIR, f), path.join(destDir, f));
  }
}

const EXPECTED_ASSET_COLUMNS = [
  'category_id', 'created_at', 'extension', 'filename', 'id', 'is_present',
  'last_seen_at', 'mime_type', 'missing_since', 'modified_at', 'nested_path',
  'project_id', 'relative_path', 'size_bytes', 'updated_at',
].sort();

describe('asset category assignment migration (011)', () => {
  let tmpDir;
  let dbPath;
  let db;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-asset-category-migration-'));
    dbPath = path.join(tmpDir, 'test.db');
  });

  afterEach(() => {
    if (db) closeDatabase(db);
    db = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createProject(repo, title) {
    return repo.create({
      title,
      slug: slugify(title, { lowercase: true }),
      description: '',
      notes: '',
      status: 'tbd',
      priority: 'normal',
      plannedDate: null,
      publishedDate: null,
      patreonUrl: null,
    });
  }

  describe('applying from scratch', () => {
    it('applies after migration 010 and records both filenames', () => {
      db = openDatabase(dbPath);
      runMigrations(db, REAL_MIGRATIONS_DIR);

      const applied = db.prepare('SELECT filename FROM schema_migrations ORDER BY rowid').pluck().all();
      expect(applied).toContain('010_asset_categories.sql');
      expect(applied).toContain('011_asset_category_assignments.sql');
      expect(applied.indexOf('011_asset_category_assignments.sql')).toBeGreaterThan(
        applied.indexOf('010_asset_categories.sql')
      );
    });

    it('adds category_id and nested_path, and no natural-sort columns', () => {
      db = openDatabase(dbPath);
      runMigrations(db, REAL_MIGRATIONS_DIR);

      const columns = db.pragma('table_info(assets)').map((c) => c.name).sort();
      expect(columns).toEqual(EXPECTED_ASSET_COLUMNS);
      expect(columns.some((c) => /sort/i.test(c))).toBe(false);
    });

    it('passes PRAGMA foreign_key_check on a freshly migrated database', () => {
      db = openDatabase(dbPath);
      runMigrations(db, REAL_MIGRATIONS_DIR);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    });
  });

  describe('rebuilding existing data', () => {
    let projectId;
    let otherProjectId;
    let rootAssetId;
    let sourceAssetId;
    let deepAssetId;
    let gapAssetId;
    let releaseId;

    beforeEach(() => {
      copyMigrationsUpTo(tmpDir, MIGRATION_010);
      db = openDatabase(dbPath);
      runMigrations(db, tmpDir);

      const projectRepo = createProjectRepository(db);
      const project = createProject(projectRepo, 'Legacy Project');
      const otherProject = createProject(projectRepo, 'Other Project');
      projectId = project.id;
      otherProjectId = otherProject.id;

      const insertAsset = db.prepare(`
        INSERT INTO assets (project_id, relative_path, filename, extension, mime_type, size_bytes, modified_at, is_present, last_seen_at, missing_since)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      rootAssetId = insertAsset.run(
        projectId, 'cover.png', 'cover.png', 'png', 'image/png', 1024,
        '2026-01-01T00:00:00.000Z', 1, '2026-01-01T00:00:01.000Z', null
      ).lastInsertRowid;

      sourceAssetId = insertAsset.run(
        projectId, 'source/file.kra', 'file.kra', 'kra', 'application/x-krita', 2048,
        '2026-01-02T00:00:00.000Z', 1, '2026-01-02T00:00:01.000Z', null
      ).lastInsertRowid;

      deepAssetId = insertAsset.run(
        projectId, 'unknown/deep/file.txt', 'file.txt', 'txt', 'application/octet-stream', 10,
        null, 0, '2026-01-03T00:00:01.000Z', '2026-01-04T00:00:00.000Z'
      ).lastInsertRowid;

      // Explicit large-gap ID: proves the rebuild bases the next AUTOINCREMENT
      // value on the real max id, not on row count.
      db.prepare(`
        INSERT INTO assets (id, project_id, relative_path, filename, extension, mime_type, size_bytes, modified_at, is_present, last_seen_at, missing_since)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(500, otherProjectId, 'gap.png', 'gap.png', 'png', 'image/png', 5, null, 1, null, null);
      gapAssetId = 500;

      db.prepare(`
        INSERT INTO releases (id, project_id, title, description, notes, status)
        VALUES (1, ?, 'Legacy Release', '', '', 'idea')
      `).run(projectId);
      releaseId = 1;

      db.prepare(`
        INSERT INTO release_assets (release_id, asset_id, role, sort_order)
        VALUES (?, ?, 'source', 3)
      `).run(releaseId, sourceAssetId);

      runMigrations(db, REAL_MIGRATIONS_DIR);
    });

    it('preserves asset IDs across the rebuild', () => {
      const ids = db.prepare('SELECT id FROM assets ORDER BY id').pluck().all();
      expect(ids).toEqual([rootAssetId, sourceAssetId, deepAssetId, gapAssetId].sort((a, b) => a - b));
    });

    it('assigns the next inserted ID above the preserved maximum', () => {
      const maxId = db.prepare('SELECT MAX(id) AS m FROM assets').get().m;
      expect(maxId).toBe(gapAssetId);

      const newId = db.prepare(`
        INSERT INTO assets (project_id, relative_path, filename)
        VALUES (?, 'new.png', 'new.png')
      `).run(projectId).lastInsertRowid;

      expect(newId).toBeGreaterThan(maxId);
    });

    it('preserves existing metadata, timestamps, and presence state', () => {
      const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(deepAssetId);
      expect(row.project_id).toBe(projectId);
      expect(row.relative_path).toBe('unknown/deep/file.txt');
      expect(row.filename).toBe('file.txt');
      expect(row.extension).toBe('txt');
      expect(row.mime_type).toBe('application/octet-stream');
      expect(row.size_bytes).toBe(10);
      expect(row.modified_at).toBeNull();
      expect(row.is_present).toBe(0);
      expect(row.last_seen_at).toBe('2026-01-03T00:00:01.000Z');
      expect(row.missing_since).toBe('2026-01-04T00:00:00.000Z');
    });

    it('preserves existing referencing-table (release_assets) associations', () => {
      const row = db.prepare('SELECT * FROM release_assets WHERE release_id = ? AND asset_id = ?').get(releaseId, sourceAssetId);
      expect(row).toBeTruthy();
      expect(row.role).toBe('source');
      expect(row.sort_order).toBe(3);
    });

    it('assigns category_id = NULL to every existing asset', () => {
      const categoryIds = db.prepare('SELECT category_id FROM assets').pluck().all();
      expect(categoryIds.every((c) => c === null)).toBe(true);
    });

    it.each([
      ['cover.png', 'cover.png', ''],
      ['source/file.kra', 'file.kra', 'source'],
      ['unknown/deep/file.txt', 'file.txt', 'unknown/deep'],
    ])('derives nested_path for %s as %s', (relativePath, _filename, expectedNestedPath) => {
      const row = db.prepare('SELECT nested_path FROM assets WHERE relative_path = ?').get(relativePath);
      expect(row.nested_path).toBe(expectedNestedPath);
    });

    it('passes PRAGMA foreign_key_check after the rebuild', () => {
      expect(db.pragma('foreign_key_check')).toEqual([]);
    });
  });

  describe('category ownership constraints (post-migration)', () => {
    let projectRepo;
    let projectId;
    let categoryId;

    beforeEach(() => {
      db = openDatabase(dbPath);
      runMigrations(db, REAL_MIGRATIONS_DIR);
      projectRepo = createProjectRepository(db);
      const project = createProject(projectRepo, 'Category Owner');
      projectId = project.id;
      categoryId = db.prepare(`
        INSERT INTO project_asset_categories (project_id, display_name, directory_slug)
        VALUES (?, 'Source', 'source')
        RETURNING id
      `).get(projectId).id;
    });

    it('allows same-project category assignment', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO assets (project_id, category_id, relative_path, filename)
          VALUES (?, ?, 'source/file.kra', 'file.kra')
        `).run(projectId, categoryId);
      }).not.toThrow();
    });

    it('allows NULL category_id', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO assets (project_id, category_id, relative_path, filename)
          VALUES (?, NULL, 'cover.png', 'cover.png')
        `).run(projectId);
      }).not.toThrow();
    });

    it('rejects cross-project category assignment', () => {
      const other = createProject(projectRepo, 'Other Owner');
      expect(() => {
        db.prepare(`
          INSERT INTO assets (project_id, category_id, relative_path, filename)
          VALUES (?, ?, 'source/file.kra', 'file.kra')
        `).run(other.id, categoryId);
      }).toThrow(/FOREIGN KEY constraint failed/);
    });

    it('rejects deleting a category still referenced by an asset', () => {
      db.prepare(`
        INSERT INTO assets (project_id, category_id, relative_path, filename)
        VALUES (?, ?, 'source/file.kra', 'file.kra')
      `).run(projectId, categoryId);

      expect(() => {
        db.prepare('DELETE FROM project_asset_categories WHERE id = ?').run(categoryId);
      }).toThrow(/FOREIGN KEY constraint failed/);
    });

    it('preserves the existing project-deletion cascade contract', () => {
      // releases.project_id is ON DELETE RESTRICT (pre-existing, unrelated to
      // this migration), so a hard project delete is only ever possible with
      // no releases attached. What this migration must preserve is that
      // project_id CASCADE still reaches assets, and that a category-owning
      // asset does not block it (its category is deleted by the same
      // cascade, and the deferred composite FK is only checked at commit —
      // after the referencing asset row is already gone too).
      db.prepare(`
        INSERT INTO assets (project_id, category_id, relative_path, filename)
        VALUES (?, ?, 'source/file.kra', 'file.kra')
      `).run(projectId, categoryId);

      expect(() => {
        db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
      }).not.toThrow();

      expect(db.prepare('SELECT COUNT(*) AS c FROM assets WHERE project_id = ?').get(projectId).c).toBe(0);
      expect(db.prepare('SELECT COUNT(*) AS c FROM project_asset_categories WHERE project_id = ?').get(projectId).c).toBe(0);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    });
  });
});
