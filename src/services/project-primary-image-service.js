import { createProjectRepository } from '../data/project-repository.js';
import { createAssetRepository } from '../data/asset-repository.js';
import {
  createProjectPrimaryImageRepository,
  PRIMARY_IMAGE_PROVENANCE,
} from '../data/project-primary-image-repository.js';
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
  previewProbe,
  applicationLogger = null,
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

  function unsupportedAsset(assetId, cause) {
    return new ProjectPrimaryImageError(
      `Asset ${assetId} is not supported as a primary image.`,
      { code: PRIMARY_IMAGE_ERROR_CODES.ASSET_UNSUPPORTED, cause }
    );
  }

  function requireEligiblePresentAsset(projectId, assetId, { kritaQuality = null } = {}) {
    const asset = requireOwnedAsset(projectId, assetId);
    if (asset.is_present !== 1 && asset.is_present !== true) {
      throw new ProjectPrimaryImageError(
        `Asset ${assetId} is marked missing and cannot be selected.`,
        { code: PRIMARY_IMAGE_ERROR_CODES.ASSET_MISSING }
      );
    }

    const classification = classifyPreviewable(asset);
    if (!classification.supported) {
      throw unsupportedAsset(assetId);
    }
    if (classification.kind === 'image') {
      return asset;
    }
    if (
      classification.kind === 'krita'
      && classification.extension === 'kra'
      && kritaQuality === 'merged'
    ) {
      return asset;
    }
    throw unsupportedAsset(assetId);
  }

  function databaseFailure(err) {
    if (err instanceof ProjectPrimaryImageError) return err;
    return new ProjectPrimaryImageError(
      'Primary image operation failed due to a database error.',
      { code: PRIMARY_IMAGE_ERROR_CODES.DATABASE_ERROR, cause: err }
    );
  }

  const setPrimaryImageTx = db.transaction((projectId, assetId, kritaQuality = null) => {
    requireMutableProject(projectId);
    const asset = requireEligiblePresentAsset(projectId, assetId, { kritaQuality });
    const previous = primaryImages.findByProjectId(projectId);
    const stored = primaryImages.setPrimaryImage(
      projectId,
      asset.id,
      PRIMARY_IMAGE_PROVENANCE.MANUAL,
    );
    if (
      !stored
      || stored.project_id !== projectId
      || stored.asset_id !== assetId
      || stored.provenance !== PRIMARY_IMAGE_PROVENANCE.MANUAL
    ) {
      throw new Error('Primary image repository returned an invalid selection.');
    }
    return {
      stored,
      changed: previous?.asset_id !== assetId || previous?.provenance !== PRIMARY_IMAGE_PROVENANCE.MANUAL,
    };
  });

  function logActivity(event, projectId, context = {}) {
    try {
      applicationLogger?.info?.({
        event,
        kind: 'activity',
        subsystem: 'assets',
        message: 'Primary image activity completed.',
        projectId,
        context,
      });
    } catch {
      // Activity logging must never alter a completed primary-image mutation.
    }
  }

  function completeSet(projectId, result) {
    if (result.changed) logActivity('asset.primary_image.changed', projectId, { primaryImageSet: true });
    return result.stored;
  }

  function setPrimaryImage(projectId, assetId) {
    assertCanonicalPositiveId(projectId, 'projectId');
    assertCanonicalPositiveId(assetId, 'assetId');

    const project = requireMutableProject(projectId);
    const asset = requireOwnedAsset(projectId, assetId);
    if (asset.is_present !== 1 && asset.is_present !== true) {
      // Preserve the domain-specific missing-asset error and avoid probing a
      // path that the authoritative asset record already says is absent.
      return completeSet(projectId, setPrimaryImageTx(projectId, assetId));
    }
    const classification = classifyPreviewable(asset);
    const isMergedKraCandidate = classification.supported
      && classification.kind === 'krita'
      && classification.extension === 'kra';

    if (!isMergedKraCandidate) {
      return completeSet(projectId, setPrimaryImageTx(projectId, assetId));
    }

    if (typeof previewProbe !== 'function') {
      throw unsupportedAsset(assetId);
    }

    const acceptMerged = (result) => {
      if (result?.quality !== 'merged') {
        throw unsupportedAsset(assetId);
      }
      try {
        return completeSet(projectId, setPrimaryImageTx(projectId, assetId, 'merged'));
      } catch (err) {
        throw databaseFailure(err);
      }
    };

    const mapProbeFailure = (err) => {
      if (err instanceof ProjectPrimaryImageError) throw err;
      throw unsupportedAsset(assetId, err);
    };

    try {
      const result = previewProbe(project, asset);
      if (result && typeof result.then === 'function') {
        // Keep probe failures distinct from the commit transaction: an
        // unexpected extractor error is unsupported, while a database error
        // remains the existing database error after the probe succeeds.
        return Promise.resolve(result).then(acceptMerged, mapProbeFailure);
      }
      return acceptMerged(result);
    } catch (err) {
      throw err instanceof ProjectPrimaryImageError ? err : unsupportedAsset(assetId, err);
    }
  }

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
    return {
      ...asset,
      provenance: selection.provenance ?? PRIMARY_IMAGE_PROVENANCE.MANUAL,
    };
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
      try {
        return setPrimaryImage(projectId, assetId);
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
        const cleared = clearPrimaryImageTx(projectId, expectedAssetId);
        logActivity('asset.primary_image.cleared', projectId, { primaryImageSet: false });
        return cleared;
      } catch (err) {
        throw databaseFailure(err);
      }
    },
  };
}
