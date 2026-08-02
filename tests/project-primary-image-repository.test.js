import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createProjectPrimaryImageRepository } from '../src/data/project-primary-image-repository.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('project primary-image repository', () => {
  let tmpDir;
  let db;
  let projectRepository;
  let assetRepository;
  let repository;
  let project;
  let otherProject;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-primary-image-repository-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    projectRepository = createProjectRepository(db);
    assetRepository = createAssetRepository(db);
    repository = createProjectPrimaryImageRepository(db);
    project = createProject('Repository Project');
    otherProject = createProject('Other Repository Project');
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createProject(title) {
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

  function createAsset(projectId, relativePath, overrides = {}) {
    return assetRepository.upsert(projectId, relativePath, {
      filename: path.basename(relativePath),
      extension: 'png',
      mimeType: 'image/png',
      sizeBytes: 100,
      modifiedAt: '2026-08-02T12:00:00.000Z',
      ...overrides,
    });
  }

  it('has no initial selection and returns an empty batch for no IDs', () => {
    expect(repository.findByProjectId(project.id)).toBeUndefined();
    expect(repository.findByProjectIds([])).toEqual([]);
    expect(repository.findByProjectIds([project.id])).toEqual([]);
  });

  it('sets and reads a selected reference', () => {
    const asset = createAsset(project.id, 'cover.png');

    expect(repository.setPrimaryImage(project.id, asset.id)).toEqual({
      project_id: project.id,
      asset_id: asset.id,
    });
    expect(repository.findByProjectId(project.id)).toEqual({
      project_id: project.id,
      asset_id: asset.id,
    });
  });

  it('replaces a selection while keeping exactly one row', () => {
    const first = createAsset(project.id, 'first.png');
    const second = createAsset(project.id, 'second.png');

    repository.setPrimaryImage(project.id, first.id);
    repository.setPrimaryImage(project.id, second.id);

    expect(repository.findByProjectId(project.id)).toEqual({
      project_id: project.id,
      asset_id: second.id,
    });
    expect(db.prepare(
      'SELECT COUNT(*) FROM project_primary_images WHERE project_id = ?'
    ).pluck().get(project.id)).toBe(1);
  });

  it('clears a matching selection and reports whether a row was removed', () => {
    const asset = createAsset(project.id, 'cover.png');
    repository.setPrimaryImage(project.id, asset.id);

    expect(repository.clearPrimaryImageIfMatches(project.id, asset.id)).toBe(true);
    expect(repository.findByProjectId(project.id)).toBeUndefined();
    expect(repository.clearPrimaryImageIfMatches(project.id, asset.id)).toBe(false);
  });

  it('leaves a newer selection intact when clearing a stale expected asset', () => {
    const first = createAsset(project.id, 'first.png');
    const second = createAsset(project.id, 'second.png');
    repository.setPrimaryImage(project.id, first.id);
    repository.setPrimaryImage(project.id, second.id);

    expect(repository.clearPrimaryImageIfMatches(project.id, first.id)).toBe(false);
    expect(repository.findByProjectId(project.id)).toEqual({
      project_id: project.id,
      asset_id: second.id,
    });
  });

  it('finds selections for multiple projects in one batch lookup', () => {
    const firstAsset = createAsset(project.id, 'first.png');
    const secondAsset = createAsset(otherProject.id, 'second.png');
    repository.setPrimaryImage(project.id, firstAsset.id);
    repository.setPrimaryImage(otherProject.id, secondAsset.id);

    expect(repository.findByProjectIds([otherProject.id, project.id, otherProject.id])).toEqual([
      { project_id: project.id, asset_id: firstAsset.id },
      { project_id: otherProject.id, asset_id: secondAsset.id },
    ]);
  });

  it('retains the selection while the asset is missing and after same-ID restoration', () => {
    const asset = createAsset(project.id, 'cover.png');
    const selection = repository.setPrimaryImage(project.id, asset.id);

    expect(assetRepository.markAllMissing(project.id)).toBe(1);
    expect(repository.findByProjectId(project.id)).toEqual(selection);
    expect(assetRepository.findById(asset.id).is_present).toBe(0);

    expect(assetRepository.restorePresent(project.id, ['cover.png'])).toBe(1);
    expect(repository.findByProjectId(project.id)).toEqual(selection);
    expect(assetRepository.findById(asset.id).is_present).toBe(1);
  });

  it('does not modify asset metadata while changing the selection reference', () => {
    const asset = createAsset(project.id, 'cover.png', {
      extension: 'webp',
      mimeType: 'image/webp',
      sizeBytes: 2048,
    });
    const before = assetRepository.findById(asset.id);

    repository.setPrimaryImage(project.id, asset.id);

    expect(assetRepository.findById(asset.id)).toEqual(before);
    expect(repository.findByProjectId(project.id)).toEqual({
      project_id: project.id,
      asset_id: asset.id,
    });
  });
});
