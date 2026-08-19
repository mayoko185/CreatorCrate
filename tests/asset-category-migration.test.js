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
  'category_id', 'created_at', 'extension', 'filename', 'generated_by',
  'generated_mode', 'generated_output_sha256', 'generated_source_asset_id', 'generated_watermark_id',
  'generated_source_relative_path', 'generated_variant', 'id', 'is_present',
  'last_seen_at', 'mime_type', 'missing_since', 'modified_at', 'nested_path',
  'project_id', 'relative_path', 'size_bytes', 'updated_at',
].sort();

const PRE_011_MIGRATION_FILENAMES = [
  '001_initial.sql',
  '002_add_completed_status.sql',
  '003_remove_project_priority.sql',
  '004_add_primary_image_provenance.sql',
  '005_add_notes_table.sql',
  '006_add_note_associations.sql',
  '007_add_asset_picker_order_index.sql',
  '008_add_note_hierarchy.sql',
  '009_add_note_book_id.sql',
  '010_add_book_contents.sql',
];

function createPre011MigrationsDir(parentDir) {
  const legacyDir = path.join(parentDir, 'pre-011-migrations');
  fs.mkdirSync(legacyDir);
  for (const filename of PRE_011_MIGRATION_FILENAMES) {
    fs.copyFileSync(path.join(MIGRATIONS_DIR, filename), path.join(legacyDir, filename));
  }
  return legacyDir;
}

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
    it('records the complete migration sequence', () => {
      db = openDatabase(dbPath);
      runMigrations(db, MIGRATIONS_DIR);

      const applied = db.prepare('SELECT filename FROM schema_migrations ORDER BY rowid').pluck().all();
      expect(applied).toEqual([
        '001_initial.sql',
        '002_add_completed_status.sql',
        '003_remove_project_priority.sql',
        '004_add_primary_image_provenance.sql',
        '005_add_notes_table.sql',
        '006_add_note_associations.sql',
        '007_add_asset_picker_order_index.sql',
        '008_add_note_hierarchy.sql',
        '009_add_note_book_id.sql',
        '010_add_book_contents.sql',
      '011_add_watermark_asset_provenance.sql',
      '012_add_watermark_generated_variant.sql',
      '013_add_generated_artifacts.sql',
       '014_add_managed_watermarks.sql',
       '015_add_watermark_scale_maps.sql',
       '016_add_processing_presets.sql',
       '017_add_project_watermarks.sql',
       '018_add_project_watermark_asset_provenance.sql',
        '019_add_global_watermark_sources.sql',
        '020_retire_project_watermarks.sql',
        '021_clear_processing_preset_scale_map_bindings.sql',
        '022_add_project_type.sql',
        '023_drop_generated_watermark_asset_id.sql',
        ]);
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

  it('upgrades pre-011 assets with NULL generated content identity', () => {
    db = openDatabase(dbPath);
    runMigrations(db, createPre011MigrationsDir(tmpDir));
    const projectRepo = createProjectRepository(db);
    const project = createProject(projectRepo, 'Pre-011 Provenance');
    const assetId = Number(db.prepare(`
      INSERT INTO assets (project_id, relative_path, filename)
      VALUES (?, 'Final/legacy.png', 'legacy.png')
    `).run(project.id).lastInsertRowid);

    runMigrations(db, MIGRATIONS_DIR);

    expect(db.prepare(`
      SELECT generated_by, generated_source_asset_id, generated_source_relative_path,
             generated_mode, generated_output_sha256
      FROM assets WHERE id = ?
    `).get(assetId)).toEqual({
      generated_by: null,
      generated_source_asset_id: null,
      generated_source_relative_path: null,
      generated_mode: null,
      generated_output_sha256: null,
    });
  });

  it('upgrades a 017 database without changing legacy Watermark provenance', () => {
    const legacyMigrationsDir = path.join(tmpDir, 'migrations-through-017');
    fs.mkdirSync(legacyMigrationsDir);
    for (const filename of fs.readdirSync(MIGRATIONS_DIR)
      .filter((name) => name <= '017_add_project_watermarks.sql')) {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, filename), path.join(legacyMigrationsDir, filename));
    }

    db = openDatabase(dbPath);
    runMigrations(db, legacyMigrationsDir);
    const projectRepo = createProjectRepository(db);
    const project = createProject(projectRepo, 'Watermark Provenance Upgrade');
    const watermarkId = Number(db.prepare(`
      INSERT INTO watermarks (display_name, storage_key, sha256, width, height)
      VALUES ('Legacy', 'wm-legacy.png', ?, 1, 1)
    `).run('b'.repeat(64)).lastInsertRowid);
    const assetId = Number(db.prepare(`
      INSERT INTO assets (project_id, relative_path, filename, generated_watermark_id)
      VALUES (?, 'output.png', 'output.png', ?)
    `).run(project.id, watermarkId).lastInsertRowid);
    const artifactId = Number(db.prepare(`
      INSERT INTO generated_artifacts
        (project_id, relative_path, kind, generated_by, sha256, size_bytes, generated_watermark_id)
      VALUES (?, 'archive.zip', 'zip', 'watermark', ?, 1, ?)
    `).run(project.id, 'c'.repeat(64), watermarkId).lastInsertRowid);

    runMigrations(db, MIGRATIONS_DIR);

    expect(db.prepare(`
      SELECT generated_watermark_id
      FROM assets WHERE id = ?
    `).get(assetId)).toEqual({ generated_watermark_id: watermarkId });
    expect(db.prepare(`
      SELECT generated_watermark_id
      FROM generated_artifacts WHERE id = ?
    `).get(artifactId)).toEqual({ generated_watermark_id: watermarkId });
  });

  it('retires the default without mutating existing project Watermarks categories or files', () => {
    const legacyMigrationsDir = path.join(tmpDir, 'migrations-through-019');
    fs.mkdirSync(legacyMigrationsDir);
    for (const filename of fs.readdirSync(MIGRATIONS_DIR).filter((name) => name <= '019_add_global_watermark_sources.sql')) {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, filename), path.join(legacyMigrationsDir, filename));
    }

    db = openDatabase(dbPath);
    runMigrations(db, legacyMigrationsDir);
    const project = createProject(createProjectRepository(db), 'Preserved Watermarks Category');
    const category = db.prepare(`
      INSERT INTO project_asset_categories (project_id, display_name, directory_slug, display_order, enabled)
      VALUES (?, 'Watermarks', 'watermarks', 5, 1)
      RETURNING *
    `).get(project.id);
    const assetId = Number(db.prepare(`
      INSERT INTO assets (project_id, category_id, relative_path, filename)
      VALUES (?, ?, 'watermarks/legacy.png', 'legacy.png')
    `).run(project.id, category.id).lastInsertRowid);
    const projectWatermarksDir = path.join(tmpDir, 'project-watermarks');
    const projectFile = path.join(projectWatermarksDir, 'legacy.png');
    const globalWatermarksDir = path.join(tmpDir, 'global-watermarks');
    const globalFile = path.join(globalWatermarksDir, 'global.png');
    fs.mkdirSync(projectWatermarksDir, { recursive: true });
    fs.mkdirSync(globalWatermarksDir, { recursive: true });
    fs.writeFileSync(projectFile, 'project-local');
    fs.writeFileSync(globalFile, 'global');

    runMigrations(db, MIGRATIONS_DIR);

    expect(db.prepare("SELECT * FROM asset_category_defaults WHERE directory_slug = 'watermarks'").get()).toBeUndefined();
    expect(db.prepare('SELECT * FROM project_asset_categories WHERE id = ?').get(category.id)).toMatchObject(category);
    expect(db.prepare('SELECT category_id FROM assets WHERE id = ?').get(assetId)).toEqual({ category_id: category.id });
    expect(fs.readFileSync(projectFile, 'utf8')).toBe('project-local');
    expect(fs.readFileSync(globalFile, 'utf8')).toBe('global');
    expect(db.prepare("SELECT value FROM app_meta WHERE key = 'project_watermarks.provisioning'").get()).toBeUndefined();
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});
