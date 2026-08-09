import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createProjectRepository } from '../src/data/project-repository.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const LEGACY_MIGRATION_FILENAMES = [
  '001_initial.sql',
  '002_add_completed_status.sql',
  '003_remove_project_priority.sql',
];

function createLegacyMigrationsDir(parentDir) {
  const legacyDir = path.join(parentDir, 'legacy-migrations');
  fs.mkdirSync(legacyDir);
  for (const filename of LEGACY_MIGRATION_FILENAMES) {
    fs.copyFileSync(path.join(MIGRATIONS_DIR, filename), path.join(legacyDir, filename));
  }
  return legacyDir;
}

function createProject(projectRepository, title) {
  return projectRepository.create({
    title,
    slug: title.toLowerCase().replaceAll(' ', '-'),
    description: '',
    notes: '',
    status: 'tbd',
    priority: 'normal',
    plannedDate: null,
    publishedDate: null,
    patreonUrl: null,
  });
}

function insertAsset(db, projectId, relativePath) {
  const filename = path.basename(relativePath);
  return Number(db.prepare(`
    INSERT INTO assets (
      project_id, relative_path, filename, extension, mime_type,
      size_bytes, modified_at, is_present, last_seen_at, missing_since
    ) VALUES (?, ?, ?, 'png', 'image/png', 10, NULL, 1, datetime('now'), NULL)
  `).run(projectId, relativePath, filename).lastInsertRowid);
}

describe('project primary-image baseline schema', () => {
  let tmpDir;
  let db;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-primary-image-migration-'));
  });

  afterEach(() => {
    closeDatabase(db);
    db = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('preserves an existing selection and asset relationship while backfilling manual provenance', () => {
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, createLegacyMigrationsDir(tmpDir));
    const projectRepository = createProjectRepository(db);
    const project = createProject(projectRepository, 'Legacy Primary Project');
    const assetId = insertAsset(db, project.id, 'legacy.png');
    db.prepare(
      'INSERT INTO project_primary_images (project_id, asset_id) VALUES (?, ?)'
    ).run(project.id, assetId);

    runMigrations(db, MIGRATIONS_DIR);

    expect(db.prepare(
      'SELECT project_id, asset_id, provenance FROM project_primary_images WHERE project_id = ?'
    ).get(project.id)).toEqual({
      project_id: project.id,
      asset_id: assetId,
      provenance: 'manual',
    });
    expect(db.prepare('SELECT id FROM assets WHERE id = ?').pluck().get(assetId)).toBe(assetId);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('defaults fresh rows to manual and rejects unsupported provenance values', () => {
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    const projectRepository = createProjectRepository(db);
    const project = createProject(projectRepository, 'Provenance Constraint Project');
    const assetId = insertAsset(db, project.id, 'constraint.png');

    db.prepare(
      'INSERT INTO project_primary_images (project_id, asset_id) VALUES (?, ?)'
    ).run(project.id, assetId);

    const column = db.pragma("table_info('project_primary_images')")
      .find(({ name }) => name === 'provenance');
    expect(column).toMatchObject({
      type: 'TEXT',
      notnull: 1,
      dflt_value: "'manual'",
    });
    expect(db.prepare(
      'SELECT provenance FROM project_primary_images WHERE project_id = ?'
    ).pluck().get(project.id)).toBe('manual');
    expect(() => db.prepare(`
      INSERT INTO project_primary_images (project_id, asset_id, provenance)
      VALUES (?, ?, 'scanner')
    `).run(project.id, assetId)).toThrow(/CHECK constraint failed/i);
  });

  it('enforces one selection per project and rejects cross-project references', () => {
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    const projectRepository = createProjectRepository(db);
    const firstProject = createProject(projectRepository, 'First Project');
    const secondProject = createProject(projectRepository, 'Second Project');
    const firstAssetId = insertAsset(db, firstProject.id, 'first.png');
    const secondAssetId = insertAsset(db, secondProject.id, 'second.png');
    const insertSelection = db.prepare(
      'INSERT INTO project_primary_images (project_id, asset_id) VALUES (?, ?)'
    );

    insertSelection.run(firstProject.id, firstAssetId);
    expect(() => insertSelection.run(firstProject.id, secondAssetId)).toThrow();
    expect(() => insertSelection.run(secondProject.id, firstAssetId)).toThrow(/FOREIGN KEY/i);
    expect(db.prepare('SELECT COUNT(*) FROM project_primary_images').pluck().get()).toBe(1);
  });

  it('cascades project and hard-asset deletion', () => {
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    const projectRepository = createProjectRepository(db);
    const projectForCascade = createProject(projectRepository, 'Project Cascade');
    const projectAssetId = insertAsset(db, projectForCascade.id, 'project.png');
    const assetForCascade = createProject(projectRepository, 'Asset Cascade');
    const assetId = insertAsset(db, assetForCascade.id, 'asset.png');
    const insertSelection = db.prepare(
      'INSERT INTO project_primary_images (project_id, asset_id) VALUES (?, ?)'
    );

    insertSelection.run(projectForCascade.id, projectAssetId);
    insertSelection.run(assetForCascade.id, assetId);

    db.prepare('DELETE FROM projects WHERE id = ?').run(projectForCascade.id);
    expect(db.prepare(
      'SELECT COUNT(*) FROM project_primary_images WHERE project_id = ?'
    ).pluck().get(projectForCascade.id)).toBe(0);

    db.prepare('DELETE FROM assets WHERE id = ?').run(assetId);
    expect(db.prepare(
      'SELECT COUNT(*) FROM project_primary_images WHERE project_id = ?'
    ).pluck().get(assetForCascade.id)).toBe(0);
    expect(db.prepare('SELECT id FROM projects WHERE id = ?').pluck().get(assetForCascade.id)).toBe(assetForCascade.id);
  });

  it('creates the composite parent and child-side indexes', () => {
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);

    const assetsIndexes = db.pragma("index_list('assets')");
    const primaryImageIndexes = db.pragma("index_list('project_primary_images')");

    expect(assetsIndexes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'idx_assets_project_id_id', unique: 1 }),
    ]));
    expect(primaryImageIndexes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'idx_project_primary_images_asset_id' }),
    ]));
  });
});
