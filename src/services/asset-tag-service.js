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
export function createAssetTagService({ tagRepository, assetRepository } = {}) {
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

  return {
    listAssetTags(assetId) {
      assertPositiveIntegerId(assetId, 'assetId');
      requireAsset(assetId);
      return tagRepository.listForAsset(assetId);
    },

    assignTagToAsset(assetId, tagId) {
      assertPositiveIntegerId(assetId, 'assetId');
      assertPositiveIntegerId(tagId, 'tagId');
      requireAsset(assetId);
      requireTag(tagId);
      return tagRepository.assignToAsset(assetId, tagId);
    },

    removeTagFromAsset(assetId, tagId) {
      assertPositiveIntegerId(assetId, 'assetId');
      assertPositiveIntegerId(tagId, 'tagId');
      requireAsset(assetId);
      requireTag(tagId);
      return tagRepository.removeFromAsset(assetId, tagId);
    },

    replaceAssetTags(assetId, tagIds) {
      assertPositiveIntegerId(assetId, 'assetId');
      assertTagIdArray(tagIds);

      const uniqueTagIds = [...new Set(tagIds)];
      requireAsset(assetId);
      for (const tagId of uniqueTagIds) {
        requireTag(tagId);
      }

      return tagRepository.replaceForAsset(assetId, uniqueTagIds);
    },
  };
}
