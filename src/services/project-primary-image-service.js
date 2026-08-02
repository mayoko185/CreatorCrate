import { createProjectRepository } from '../data/project-repository.js';
import { createAssetRepository } from '../data/asset-repository.js';
import { createProjectPrimaryImageRepository } from '../data/project-primary-image-repository.js';
import { classifyPreviewable } from './preview-service.js';

export const PRIMARY_IMAGE_ERROR_CODES = Object.freeze({
  INVALID_ID: 'INVALID_ID',
  PROJECT_NOT_FOUND: 'PROJECT_NOT_FOUND',
  PROJECT_ARCHIVED: 'PROJECT_ARCHIVED',
  ASSET_NOT_FOUND: 'ASSET_NOT_FOUND',
  ASSET_MISSING: 'ASSET_MISSING',
  ASSET_UNSUPPORTED: 'ASSET_UNSUPPORTED',
  STALE_CLEAR: 'STALE_CLEAR',
  DATABASE_ERROR: 'DATABASE_ERROR',
});

const ERROR_STATUS = Object.freeze({
  INVALID_ID: 422,
  PROJECT_NOT_FOUND: 404,
  PROJECT_ARCHIVED: 409,
  ASSET_NOT_FOUND: 404,
  ASSET_MISSING: 422,
  ASSET_UNSUPPORTED: 422,
  STALE_CLEAR: 409,
  DATABASE_ERROR: 500,
});

export class ProjectPrimaryImageError extends Error {
  constructor(message, { code, status, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ProjectPrimaryImageError';
    this.code = code;
    this.status = status ?? ERROR_STATUS[code];
  }
}

function assertCanonicalPositiveId(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new ProjectPrimaryImageError(
      `${label} must be a positive integer.`,
      { code: PRIMARY_IMAGE_ERROR_CODES.INVALID_ID }
    );
  }
}

function isArchived(project) {
  return Boolean(project.archived_at) || project.status === 'archived';
}

/**
 * Project primary-image domain service.
 *
 * Database mutations use the injected database handle's transaction boundary;
 * no filesystem or manifest operation is part of this service.
 *
 * @param {object} deps
 * @param {import('better-sqlite3').Database} deps.db
 * @param {ReturnType<typeof createProjectRepository>} [deps.projectRepository]
 * @param {ReturnType<typeof createAssetRepository>} [deps.assetRepository]
 * @param {ReturnType<typeof createProjectPrimaryImageRepository>} [deps.projectPrimaryImageRepository]
 */
export function createProjectPrimaryImageService({
  db,
  projectRepository,
  assetRepository,
  projectPrimaryImageRepository,
} = {}) {
  if (!db || typeof db.transaction !== 'function') {
    throw new Error('createProjectPrimaryImageService requires a db dependency.');
  }

  const projects = projectRepository ?? createProjectRepository(db);
  const assets = assetRepository ?? createAssetRepository(db);
  const primaryImages = projectPrimaryImageRepository ?? createProjectPrimaryImageRepository(db);

  function requireProject(projectId) {
    const project = projects.findById(projectId);
    if (!project) {
      throw new ProjectPrimaryImageError(
        `Project ${projectId} not found.`,
        { code: PRIMARY_IMAGE_ERROR_CODES.PROJECT_NOT_FOUND }
      );
    }
    return project;
  }

  function requireMutableProject(projectId) {
    const project = requireProject(projectId);
    if (isArchived(project)) {
      throw new ProjectPrimaryImageError(
        `Project ${projectId} is archived and cannot be modified.`,
        { code: PRIMARY_IMAGE_ERROR_CODES.PROJECT_ARCHIVED }
      );
    }
    return project;
  }

  function requireOwnedAsset(projectId, assetId) {
    const asset = assets.findById(assetId);
    if (!asset || asset.project_id !== projectId) {
      throw new ProjectPrimaryImageError(
        `Asset ${assetId} not found.`,
        { code: PRIMARY_IMAGE_ERROR_CODES.ASSET_NOT_FOUND }
      );
    }
    return asset;
  }

  function requireEligiblePresentAsset(projectId, assetId) {
    const asset = requireOwnedAsset(projectId, assetId);
    if (asset.is_present !== 1 && asset.is_present !== true) {
      throw new ProjectPrimaryImageError(
        `Asset ${assetId} is marked missing and cannot be selected.`,
        { code: PRIMARY_IMAGE_ERROR_CODES.ASSET_MISSING }
      );
    }

    if (!classifyPreviewable(asset).supported) {
      throw new ProjectPrimaryImageError(
        `Asset ${assetId} is not supported as a primary image.`,
        { code: PRIMARY_IMAGE_ERROR_CODES.ASSET_UNSUPPORTED }
      );
    }
    return asset;
  }

  function databaseFailure(err) {
    if (err instanceof ProjectPrimaryImageError) return err;
    return new ProjectPrimaryImageError(
      'Primary image operation failed due to a database error.',
      { code: PRIMARY_IMAGE_ERROR_CODES.DATABASE_ERROR, cause: err }
    );
  }

  const setPrimaryImageTx = db.transaction((projectId, assetId) => {
    requireMutableProject(projectId);
    const asset = requireEligiblePresentAsset(projectId, assetId);
    const stored = primaryImages.setPrimaryImage(projectId, asset.id);
    if (!stored || stored.project_id !== projectId || stored.asset_id !== assetId) {
      throw new Error('Primary image repository returned an invalid selection.');
    }
    return stored;
  });

  const clearPrimaryImageTx = db.transaction((projectId, expectedAssetId) => {
    requireMutableProject(projectId);
    const removed = primaryImages.clearPrimaryImageIfMatches(projectId, expectedAssetId);
    if (!removed) {
      throw new ProjectPrimaryImageError(
        `Primary image selection for project ${projectId} no longer matches asset ${expectedAssetId}.`,
        { code: PRIMARY_IMAGE_ERROR_CODES.STALE_CLEAR }
      );
    }
    return true;
  });

  const getPrimaryImageTx = db.transaction((projectId) => {
    requireProject(projectId);
    const selection = primaryImages.findByProjectId(projectId);
    if (!selection) return undefined;

    const asset = assets.findById(selection.asset_id);
    if (!asset || asset.project_id !== projectId) {
      throw new Error('Primary image selection references an unavailable asset.');
    }
    return asset;
  });

  return {
    /**
     * Return the retained selected asset, including when it is marked missing.
     * @param {number} projectId
     * @returns {object|undefined}
     */
    getPrimaryImage(projectId) {
      assertCanonicalPositiveId(projectId, 'projectId');
      try {
        return getPrimaryImageTx(projectId);
      } catch (err) {
        throw databaseFailure(err);
      }
    },

    /**
     * Validate and atomically set or replace a project's primary image.
     * @param {number} projectId
     * @param {number} assetId
     * @returns {{project_id: number, asset_id: number}}
     */
    setPrimaryImage(projectId, assetId) {
      assertCanonicalPositiveId(projectId, 'projectId');
      assertCanonicalPositiveId(assetId, 'assetId');
      try {
        return setPrimaryImageTx(projectId, assetId);
      } catch (err) {
        throw databaseFailure(err);
      }
    },

    /**
     * Atomically clear only the still-current expected selection.
     * @param {number} projectId
     * @param {number} expectedAssetId
     * @returns {boolean}
     */
    clearPrimaryImage(projectId, expectedAssetId) {
      assertCanonicalPositiveId(projectId, 'projectId');
      assertCanonicalPositiveId(expectedAssetId, 'expectedAssetId');
      try {
        return clearPrimaryImageTx(projectId, expectedAssetId);
      } catch (err) {
        throw databaseFailure(err);
      }
    },
  };
}
