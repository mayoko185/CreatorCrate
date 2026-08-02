import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createProjectPrimaryImageRepository } from '../src/data/project-primary-image-repository.js';
import {
  createProjectPrimaryImageService,
  PRIMARY_IMAGE_ERROR_CODES,
  ProjectPrimaryImageError,
} from '../src/services/project-primary-image-service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('project primary-image service', () => {
  let tmpDir;
  let db;
  let projectRepository;
  let assetRepository;
  let primaryImageRepository;
  let service;
  let project;
  let otherProject;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-primary-image-service-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    projectRepository = createProjectRepository(db);
    assetRepository = createAssetRepository(db);
    primaryImageRepository = createProjectPrimaryImageRepository(db);
    service = createProjectPrimaryImageService({
      db,
      projectRepository,
      assetRepository,
      projectPrimaryImageRepository: primaryImageRepository,
    });
    project = createProject('Service Project');
    otherProject = createProject('Other Service Project');
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

  function createAsset(projectId, relativePath, extension = 'png', mimeType = 'image/png') {
    return assetRepository.upsert(projectId, relativePath, {
      filename: path.basename(relativePath),
      extension,
      mimeType,
      sizeBytes: 100,
      modifiedAt: '2026-08-02T12:00:00.000Z',
    });
  }

  function expectCode(callback, code) {
    try {
      callback();
      throw new Error(`Expected ${code} error.`);
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectPrimaryImageError);
      expect(err.code).toBe(code);
      return err;
    }
  }

  it('accepts an eligible present PNG and returns it as the selected asset', () => {
    const asset = createAsset(project.id, 'cover.png');

    expect(service.setPrimaryImage(project.id, asset.id)).toEqual({
      project_id: project.id,
      asset_id: asset.id,
    });
    expect(service.getPrimaryImage(project.id)).toMatchObject({
      id: asset.id,
      project_id: project.id,
      is_present: 1,
    });
  });

  it.each([
    ['JPEG', 'jpg', 'image/jpeg'],
    ['JPEG with jpeg extension', 'jpeg', 'image/jpeg'],
    ['WebP', 'webp', 'image/webp'],
    ['GIF', 'gif', 'image/gif'],
  ])('accepts %s according to the shared preview classifier', (_label, extension, mimeType) => {
    const asset = createAsset(project.id, `cover.${extension}`, extension, mimeType);

    expect(() => service.setPrimaryImage(project.id, asset.id)).not.toThrow();
    expect(service.getPrimaryImage(project.id).id).toBe(asset.id);
  });

  it.each([
    ['unsupported extension', 'kra', 'application/x-krita'],
    ['unsupported MIME', 'bin', 'image/png'],
    ['extension/MIME mismatch', 'png', 'image/jpeg'],
  ])('rejects an asset with %s', (_label, extension, mimeType) => {
    const asset = createAsset(project.id, `cover.${extension}`, extension, mimeType);

    expectCode(
      () => service.setPrimaryImage(project.id, asset.id),
      PRIMARY_IMAGE_ERROR_CODES.ASSET_UNSUPPORTED,
    );
    expect(primaryImageRepository.findByProjectId(project.id)).toBeUndefined();
  });

  it('rejects a missing asset as a new selection', () => {
    const asset = createAsset(project.id, 'missing.png');
    assetRepository.markAllMissing(project.id);

    expectCode(
      () => service.setPrimaryImage(project.id, asset.id),
      PRIMARY_IMAGE_ERROR_CODES.ASSET_MISSING,
    );
    expect(primaryImageRepository.findByProjectId(project.id)).toBeUndefined();
  });

  it('rejects an asset owned by another project', () => {
    const asset = createAsset(otherProject.id, 'other.png');

    expectCode(
      () => service.setPrimaryImage(project.id, asset.id),
      PRIMARY_IMAGE_ERROR_CODES.ASSET_NOT_FOUND,
    );
    expect(primaryImageRepository.findByProjectId(project.id)).toBeUndefined();
  });

  it('distinguishes unknown projects and unknown assets', () => {
    const asset = createAsset(project.id, 'cover.png');

    expectCode(
      () => service.setPrimaryImage(999999, asset.id),
      PRIMARY_IMAGE_ERROR_CODES.PROJECT_NOT_FOUND,
    );
    expectCode(
      () => service.setPrimaryImage(project.id, 999999),
      PRIMARY_IMAGE_ERROR_CODES.ASSET_NOT_FOUND,
    );
  });

  it('rejects non-canonical or non-positive IDs', () => {
    const asset = createAsset(project.id, 'cover.png');

    for (const [projectId, assetId] of [
      ['1', asset.id],
      [0, asset.id],
      [1.5, asset.id],
      [project.id, '1'],
      [project.id, 0],
      [project.id, Number.MAX_SAFE_INTEGER + 1],
    ]) {
      expectCode(
        () => service.setPrimaryImage(projectId, assetId),
        PRIMARY_IMAGE_ERROR_CODES.INVALID_ID,
      );
    }
  });

  it('rejects archived projects', () => {
    const asset = createAsset(project.id, 'cover.png');
    db.prepare(
      "UPDATE projects SET status = 'archived', archived_at = datetime('now') WHERE id = ?"
    ).run(project.id);

    expectCode(
      () => service.setPrimaryImage(project.id, asset.id),
      PRIMARY_IMAGE_ERROR_CODES.PROJECT_ARCHIVED,
    );
  });

  it('replaces an existing selection atomically', () => {
    const first = createAsset(project.id, 'first.png');
    const second = createAsset(project.id, 'second.png');
    service.setPrimaryImage(project.id, first.id);

    service.setPrimaryImage(project.id, second.id);

    expect(service.getPrimaryImage(project.id).id).toBe(second.id);
    expect(db.prepare(
      'SELECT COUNT(*) FROM project_primary_images WHERE project_id = ?'
    ).pluck().get(project.id)).toBe(1);
  });

  it('clears the current selection and rejects a stale clear without mutation', () => {
    const first = createAsset(project.id, 'first.png');
    const second = createAsset(project.id, 'second.png');
    service.setPrimaryImage(project.id, first.id);

    expect(service.clearPrimaryImage(project.id, first.id)).toBe(true);
    expect(service.getPrimaryImage(project.id)).toBeUndefined();

    service.setPrimaryImage(project.id, first.id);
    service.setPrimaryImage(project.id, second.id);
    expectCode(
      () => service.clearPrimaryImage(project.id, first.id),
      PRIMARY_IMAGE_ERROR_CODES.STALE_CLEAR,
    );
    expect(service.getPrimaryImage(project.id).id).toBe(second.id);
  });

  it('retains a selected reference through missing and same-ID restoration', () => {
    const asset = createAsset(project.id, 'cover.png');
    service.setPrimaryImage(project.id, asset.id);
    const selectionBefore = primaryImageRepository.findByProjectId(project.id);

    assetRepository.markAllMissing(project.id);
    expect(service.getPrimaryImage(project.id)).toMatchObject({
      id: asset.id,
      is_present: 0,
    });
    expect(primaryImageRepository.findByProjectId(project.id)).toEqual(selectionBefore);

    assetRepository.restorePresent(project.id, ['cover.png']);
    expect(service.getPrimaryImage(project.id)).toMatchObject({
      id: asset.id,
      is_present: 1,
    });
    expect(primaryImageRepository.findByProjectId(project.id)).toEqual(selectionBefore);
  });

  it('rolls back a failed set repository operation and hides the raw failure', () => {
    const asset = createAsset(project.id, 'cover.png');
    const failingRepository = {
      ...primaryImageRepository,
      setPrimaryImage(...args) {
        primaryImageRepository.setPrimaryImage(...args);
        throw new Error('forced repository failure');
      },
    };
    const failingService = createProjectPrimaryImageService({
      db,
      projectRepository,
      assetRepository,
      projectPrimaryImageRepository: failingRepository,
    });

    const error = expectCode(
      () => failingService.setPrimaryImage(project.id, asset.id),
      PRIMARY_IMAGE_ERROR_CODES.DATABASE_ERROR,
    );
    expect(error.message).toBe('Primary image operation failed due to a database error.');
    expect(primaryImageRepository.findByProjectId(project.id)).toBeUndefined();
  });

  it('rolls back a failed clear repository operation', () => {
    const asset = createAsset(project.id, 'cover.png');
    service.setPrimaryImage(project.id, asset.id);
    const failingRepository = {
      ...primaryImageRepository,
      clearPrimaryImageIfMatches(...args) {
        primaryImageRepository.clearPrimaryImageIfMatches(...args);
        throw new Error('forced repository failure');
      },
    };
    const failingService = createProjectPrimaryImageService({
      db,
      projectRepository,
      assetRepository,
      projectPrimaryImageRepository: failingRepository,
    });

    expectCode(
      () => failingService.clearPrimaryImage(project.id, asset.id),
      PRIMARY_IMAGE_ERROR_CODES.DATABASE_ERROR,
    );
    expect(primaryImageRepository.findByProjectId(project.id)).toEqual({
      project_id: project.id,
      asset_id: asset.id,
    });
  });

  it('does not write a manifest file', () => {
    const asset = createAsset(project.id, 'cover.png');
    service.setPrimaryImage(project.id, asset.id);
    service.clearPrimaryImage(project.id, asset.id);

    expect(fs.existsSync(path.join(tmpDir, 'project.json'))).toBe(false);
    expect(fs.readdirSync(tmpDir).some((name) => name === 'project.json')).toBe(false);
  });
});
