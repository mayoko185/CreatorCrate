import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import slugify from '@sindresorhus/slugify';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createProjectRepository } from '../src/data/project-repository.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

const EXPECTED_ASSET_COLUMNS = [
  'category_id', 'created_at', 'extension', 'filename', 'id', 'is_present',
  'last_seen_at', 'mime_type', 'missing_since', 'modified_at', 'nested_path',
  'project_id', 'relative_path', 'size_bytes', 'updated_at',
].sort();

describe('asset category assignment baseline schema', () => {
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
    it('records the single consolidated migration', () => {
      db = openDatabase(dbPath);
      runMigrations(db, MIGRATIONS_DIR);

      const applied = db.prepare('SELECT filename FROM schema_migrations ORDER BY rowid').pluck().all();
      expect(applied).toEqual(['001_initial.sql']);
    });

    it('creates category_id and nested_path without natural-sort columns', () => {
      db = openDatabase(dbPath);
      runMigrations(db, MIGRATIONS_DIR);

      const columns = db.pragma('table_info(assets)').map((c) => c.name).sort();
      expect(columns).toEqual(EXPECTED_ASSET_COLUMNS);
      expect(columns.some((c) => /sort/i.test(c))).toBe(false);
    });

    it('passes PRAGMA foreign_key_check on a freshly migrated database', () => {
      db = openDatabase(dbPath);
      runMigrations(db, MIGRATIONS_DIR);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    });
  });

  describe('category ownership constraints (post-migration)', () => {
    let projectRepo;
    let projectId;
    let categoryId;

    beforeEach(() => {
      db = openDatabase(dbPath);
      runMigrations(db, MIGRATIONS_DIR);
      projectRepo = createProjectRepository(db);
      const project = createProject(projectRepo, 'Category Owner');
      projectId = project.id;
      categoryId = db.prepare(`
        INSERT INTO project_asset_categories (project_id, display_name, directory_slug)
        VALUES (?, 'Final', 'final')
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
      // releases.project_id is ON DELETE RESTRICT, so a hard project delete is
      // only ever possible with no releases attached. The composite category
      // foreign key is deferred until the category-owning asset is removed.
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
