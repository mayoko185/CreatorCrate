import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createProjectRepository } from '../src/data/project-repository.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

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
