import { AssetNotFoundError } from './release-service.js';
import { TagNotFoundError } from './tag-service.js';

export { AssetNotFoundError, TagNotFoundError };

export class AssetTagValidationError extends Error {
  constructor(errors) {
    super('Asset tag validation failed');
    this.name = 'AssetTagValidationError';
    this.errors = errors;
  }
}

function assertPositiveIntegerId(value, fieldLabel) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new AssetTagValidationError({
      [fieldLabel]: `${fieldLabel} must be a positive integer.`,
    });
  }
}

function assertTagIdArray(tagIds) {
  if (!Array.isArray(tagIds)) {
    throw new AssetTagValidationError({ tagIds: 'tagIds must be an array.' });
  }

  for (const tagId of tagIds) {
    assertPositiveIntegerId(tagId, 'tagId');
  }
}

/**
 * @param {object} deps
 * @param {ReturnType<import('../data/tag-repository.js').createTagRepository>} deps.tagRepository
 * @param {ReturnType<import('../data/asset-repository.js').createAssetRepository>} deps.assetRepository
 */
export function createAssetTagService({ tagRepository, assetRepository, applicationLogger = null } = {}) {
  if (!tagRepository) {
    throw new Error('createAssetTagService requires a tagRepository dependency.');
  }
  if (!assetRepository) {
    throw new Error('createAssetTagService requires an assetRepository dependency.');
  }

  function requireAsset(assetId) {
    const asset = assetRepository.findById(assetId);
    if (!asset) {
      throw new AssetNotFoundError(assetId);
    }
    return asset;
  }

  function requireTag(tagId) {
    const tag = tagRepository.findById(tagId);
    if (!tag) {
      throw new TagNotFoundError(tagId);
    }
    return tag;
  }

  function logActivity(event, asset, tagId, assignmentCount) {
    try {
      applicationLogger?.info?.({
        event,
        kind: 'activity',
        subsystem: 'tags',
        message: 'Asset tag activity completed.',
        projectId: asset.project_id,
        context: { tagId, assetCount: 1, assignmentCount },
      });
    } catch {
      // Activity logging must never alter a completed asset-tag mutation.
    }
  }

  return {
    listAssetTags(assetId) {
      assertPositiveIntegerId(assetId, 'assetId');
      requireAsset(assetId);
      return tagRepository.listForAsset(assetId);
    },

    assignTagToAsset(assetId, tagId) {
      assertPositiveIntegerId(assetId, 'assetId');
      assertPositiveIntegerId(tagId, 'tagId');
      const asset = requireAsset(assetId);
      requireTag(tagId);
      const assigned = tagRepository.assignToAsset(assetId, tagId);
      if (assigned) logActivity('asset.tags.assigned', asset, tagId, 1);
      return assigned;
    },

    removeTagFromAsset(assetId, tagId) {
      assertPositiveIntegerId(assetId, 'assetId');
      assertPositiveIntegerId(tagId, 'tagId');
      const asset = requireAsset(assetId);
      requireTag(tagId);
      const removed = tagRepository.removeFromAsset(assetId, tagId);
      if (removed) logActivity('asset.tags.removed', asset, tagId, 1);
      return removed;
    },

    replaceAssetTags(assetId, tagIds) {
      assertPositiveIntegerId(assetId, 'assetId');
      assertTagIdArray(tagIds);

      const uniqueTagIds = [...new Set(tagIds)];
      const asset = requireAsset(assetId);
      for (const tagId of uniqueTagIds) {
        requireTag(tagId);
      }

      const currentTagIds = tagRepository.listForAsset(assetId).map((tag) => tag.id);
      const currentTagIdSet = new Set(currentTagIds);
      const desiredTagIdSet = new Set(uniqueTagIds);
      const assignedCount = uniqueTagIds.filter((tagId) => !currentTagIdSet.has(tagId)).length;
      const removedCount = currentTagIds.filter((tagId) => !desiredTagIdSet.has(tagId)).length;
      const resultingTags = tagRepository.replaceForAsset(assetId, uniqueTagIds);
      if (assignedCount > 0) logActivity('asset.tags.assigned', asset, null, assignedCount);
      if (removedCount > 0) logActivity('asset.tags.removed', asset, null, removedCount);
      return resultingTags;
    },
  };
}
