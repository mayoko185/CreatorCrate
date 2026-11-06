/**
 * Phase 1: configurable asset categories — validation and orchestration.
 *
 * Database-only in this chunk: no filesystem operations are performed here.
 * The repository is injected explicitly; this service never constructs one
 * itself or reaches for hidden database state.
 */

import {
  AssetCategoryValidationError,
  validateCategoryInput,
  assertPlainObject,
  assertPositiveIntegerId,
  assertStrictBoolean,
} from './asset-category-validation.js';
import { AssetCategoryError } from '../data/asset-category-repository.js';

export { AssetCategoryValidationError };

export class AssetCategoryNotFoundError extends Error {
  constructor(id) {
    super(`Asset category ${id} not found`);
    this.name = 'AssetCategoryNotFoundError';
    this.status = 404;
  }
}

// WP11C-F7: the category no longer holds the saved details a details save was
// based on (another page saved newer details first). Nothing was written.
// `current` is the row as it is now.
export class AssetCategoryStaleError extends Error {
  constructor(id, current) {
    super(`Asset category ${id} changed since its details were reviewed`);
    this.name = 'AssetCategoryStaleError';
    this.code = 'CATEGORY_DETAILS_STALE';
    this.status = 409;
    this.current = current;
  }
}

function assertExpectedDetails(expected) {
  if (expected === null || typeof expected !== 'object' || Array.isArray(expected)
    || typeof expected.displayName !== 'string' || typeof expected.directorySlug !== 'string') {
    throw new AssetCategoryValidationError({ expected: 'The reviewed saved details must be a display name and a directory slug.' });
  }
  return { displayName: expected.displayName, directorySlug: expected.directorySlug };
}

const REORDER_VALIDATION_CODES = new Set([
  'INVALID_INPUT',
  'INVALID_SEQUENCE_LENGTH',
  'DUPLICATE_ID',
  'UNKNOWN_ID',
  'INVALID_ID',
]);

function invalidReorder(message = 'Global category order must contain every current global category exactly once.') {
  throw new AssetCategoryValidationError({ orderedCategoryIds: message });
}

function assertCompleteGlobalReorderSet(orderedIds, categories) {
  if (!Array.isArray(orderedIds) || orderedIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    invalidReorder('Global category IDs must be safe positive integers.');
  }

  if (new Set(orderedIds).size !== orderedIds.length) {
    invalidReorder('Global category order must not contain duplicate IDs.');
  }

  if (orderedIds.length !== categories.length) {
    invalidReorder();
  }

  const currentIds = new Set(categories.map((category) => category.id));
  if (orderedIds.some((id) => !currentIds.has(id))) {
    invalidReorder();
  }
}

function isReorderValidationError(err) {
  return err instanceof AssetCategoryError && REORDER_VALIDATION_CODES.has(err.code);
}

export function createAssetCategoryService(repository) {
  function requireDefault(id) {
    assertPositiveIntegerId(id, 'id');
    const found = repository.findDefaultById(id);
    if (!found) {
      throw new AssetCategoryNotFoundError(id);
    }
    return found;
  }

  return {
    listDefaults() {
      return repository.listDefaults();
    },

    addDefault(input) {
      assertPlainObject(input, 'input');
      const { displayName, directorySlug } = validateCategoryInput(input);
      let enabled = true;
      if (input.enabled !== undefined) {
        assertStrictBoolean(input.enabled, 'enabled');
        enabled = input.enabled;
      }
      const defaults = repository.listDefaults();
      // Append after the highest existing position rather than using the
      // row count: deletions can leave display_order non-contiguous, and
      // count-based positions would then collide with a surviving row.
      const displayOrder = defaults.length === 0
        ? 0
        : Math.max(...defaults.map((d) => d.display_order)) + 1;
      return repository.addDefault({ displayName, directorySlug, displayOrder, enabled });
    },

    // WP11C-F7: `input.expected` ({ displayName, directorySlug }) is the
    // saved details the request was based on. With it, the write happens only
    // while the row still holds them, in one conditional statement; otherwise
    // AssetCategoryStaleError (row changed) or AssetCategoryNotFoundError (row
    // gone) and nothing is written. The Settings HTTP route always supplies
    // it; without it (internal callers) the write is unconditional as before.
    editDefault(id, input) {
      assertPositiveIntegerId(id, 'id');
      assertPlainObject(input, 'input');
      const { displayName, directorySlug } = validateCategoryInput(input);
      if (input.expected === undefined) {
        requireDefault(id);
        return repository.updateDefaultNameSlug(id, { displayName, directorySlug });
      }
      const expected = assertExpectedDetails(input.expected);
      const updated = repository.updateDefaultNameSlugIfUnchanged(id, { displayName, directorySlug }, expected);
      if (updated) return updated;
      const current = repository.findDefaultById(id);
      if (!current) throw new AssetCategoryNotFoundError(id);
      throw new AssetCategoryStaleError(id, current);
    },

    setDefaultEnabled(id, enabled) {
      assertPositiveIntegerId(id, 'id');
      assertStrictBoolean(enabled, 'enabled');
      requireDefault(id);
      return repository.setDefaultEnabled(id, enabled);
    },

    reorderDefaults(orderedIds) {
      const categories = repository.listDefaults();
      assertCompleteGlobalReorderSet(orderedIds, categories);

      try {
        return repository.reorderDefaults(orderedIds);
      } catch (err) {
        if (isReorderValidationError(err)) {
          invalidReorder();
        }
        throw err;
      }
    },

    deleteDefault(id) {
      requireDefault(id);
      return repository.deleteDefault(id);
    },

    listProjectCategories(projectId) {
      assertPositiveIntegerId(projectId, 'projectId');
      return repository.listProjectCategories(projectId);
    },

    copyDefaultsForProject(projectId) {
      assertPositiveIntegerId(projectId, 'projectId');
      return repository.copyEnabledDefaultsForProject(projectId);
    },
  };
}
