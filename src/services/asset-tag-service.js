import crypto from 'node:crypto';
import { AssetNotFoundError } from './release-service.js';
import { TagNotFoundError } from './tag-service.js';

export { AssetNotFoundError, TagNotFoundError };

/**
 * Reviewed-state witness for a complete-set tag replacement (WP10A1-F3).
 *
 * A tag form renders this token for the tag set it shows as saved; the save
 * carries it back next to the desired selection. replaceAssetTags (with
 * `expectedReview`) recomputes it from the assignments it reads inside the
 * replacement's own transaction and refuses the save before anything changes
 * when they differ: a replacement reviewed against one saved set can never
 * overwrite a different, newer set — however late it reaches the service, and
 * from whichever document it was sent.
 *
 * The token is a domain-separated SHA-256 digest of the project ID, the asset
 * ID and the canonical saved set (unique tag IDs, ascending, comma-joined; the
 * empty set is the empty list). It is independent of the desired selection,
 * binds the Project and Asset, and is only ever compared, never parsed. A
 * forged, tampered or foreign token is simply a mismatch.
 *
 * Known limit (no tag revision exists in the schema): a set changed and then
 * changed back to exactly the reviewed set produces the same token. That set
 * is then the one the user reviewed, so replacing it is what was asked for.
 */
const TAG_REVIEW_DOMAIN = 'creatorcrate.asset-tag-review.v1';
const TAG_REVIEW_PREFIX = 't1.';
const TAG_REVIEW_PATTERN = /^t1\.[A-Za-z0-9_-]{43}$/;

function canonicalTagSet(tagIds) {
  return [...new Set(tagIds.map(Number))].sort((left, right) => left - right).join(',');
}

/**
 * @param {{ projectId: number, assetId: number, tagIds: Array<number|string> }} saved
 * @returns {string|null} null when the state cannot be witnessed
 */
export function assetTagReviewToken({ projectId, assetId, tagIds } = {}) {
  const project = Number(projectId);
  const asset = Number(assetId);
  if (!Number.isSafeInteger(project) || project < 1 || !Number.isSafeInteger(asset) || asset < 1
    || !Array.isArray(tagIds) || tagIds.some((id) => !Number.isSafeInteger(Number(id)) || Number(id) < 1)) {
    return null;
  }
  const digest = crypto.createHash('sha256')
    .update([TAG_REVIEW_DOMAIN, String(project), String(asset), canonicalTagSet(tagIds)].join('\0'), 'utf8')
    .digest('base64url');
  return `${TAG_REVIEW_PREFIX}${digest}`;
}

/** True when `value` has the exact shape of a token (one string, nothing else). */
export function isAssetTagReviewToken(value) {
  return typeof value === 'string' && TAG_REVIEW_PATTERN.test(value);
}

function assetTagReviewMatches(saved, submitted) {
  const expected = assetTagReviewToken(saved);
  if (!expected || !isAssetTagReviewToken(submitted)) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(submitted));
}

/** The reviewed-state witness was missing or not a well-formed token. */
export class AssetTagReviewInvalidError extends Error {
  constructor() {
    super('Asset tag review is missing or malformed');
    this.name = 'AssetTagReviewInvalidError';
  }
}

/** The stored tag set is not the one the save was reviewed against. Nothing changed. */
export class AssetTagSetStaleError extends Error {
  constructor(assetId) {
    super('Asset tag set changed since it was reviewed');
    this.name = 'AssetTagSetStaleError';
    this.assetId = assetId;
  }
}

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

    /**
     * Replace the asset's complete tag set (an empty array removes every tag).
     *
     * `options.expectedReview` (an assetTagReviewToken) makes the replacement
     * conditional: the stored set is read and compared inside the replacement
     * transaction, and a mismatch throws AssetTagSetStaleError before any
     * assignment changes. When the key is present its value must be a token
     * (AssetTagReviewInvalidError otherwise). Callers that pass no options keep
     * the unconditional replacement.
     */
    replaceAssetTags(assetId, tagIds, options = {}) {
      assertPositiveIntegerId(assetId, 'assetId');
      assertTagIdArray(tagIds);
      const reviewed = Boolean(options) && Object.hasOwn(options, 'expectedReview');
      if (reviewed && !isAssetTagReviewToken(options.expectedReview)) {
        throw new AssetTagReviewInvalidError();
      }

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
      const precondition = reviewed
        ? (storedTagIds) => {
          if (!assetTagReviewMatches(
            { projectId: asset.project_id, assetId, tagIds: storedTagIds },
            options.expectedReview,
          )) {
            throw new AssetTagSetStaleError(assetId);
          }
        }
        : undefined;
      const resultingTags = tagRepository.replaceForAsset(assetId, uniqueTagIds, { precondition });
      if (assignedCount > 0) logActivity('asset.tags.assigned', asset, null, assignedCount);
      if (removedCount > 0) logActivity('asset.tags.removed', asset, null, removedCount);
      return resultingTags;
    },
  };
}
