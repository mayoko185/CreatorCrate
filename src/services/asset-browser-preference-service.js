import {
  AssetCategoryValidationError,
  assertPositiveIntegerId,
  validateDirectorySlug,
} from './asset-category-validation.js';
import { ProjectNotFoundError } from './project-service.js';

export { AssetCategoryValidationError, ProjectNotFoundError };

export const PROJECT_PREFERENCE_MODES = Object.freeze(['inherit', 'all', 'category']);

export const PREFERENCE_FALLBACK_REASONS = Object.freeze({
  PROJECT_PREFERENCE_MALFORMED: 'project-preference-malformed',
  PROJECT_CATEGORY_DISABLED: 'project-category-disabled',
  PROJECT_CATEGORY_MISSING: 'project-category-missing',
  GLOBAL_PREFERENCE_MALFORMED: 'global-preference-malformed',
  GLOBAL_CATEGORY_MISSING: 'global-category-missing',
  GLOBAL_CATEGORY_DISABLED: 'global-category-disabled',
  GLOBAL_CATEGORY_NOT_IN_PROJECT: 'global-category-not-in-project',
  GLOBAL_PROJECT_CATEGORY_DISABLED: 'global-project-category-disabled',
});

export const AUTO_RENAME_UNAVAILABLE_REASONS = Object.freeze({
  ALL: 'all',
  UNCATEGORIZED: 'uncategorized',
  MISSING: 'missing',
  DISABLED: 'disabled',
  CROSS_PROJECT: 'cross-project',
  INVALID: 'invalid',
  NO_CONCRETE_DEFAULT: 'no-concrete-default',
  EMPTY: 'empty',
});

function isEnabled(row) {
  return row?.enabled === 1 || row?.enabled === true;
}

function normalizeProjectPreference(row) {
  const mode = row?.default_category_mode ?? 'inherit';
  const categoryId = mode === 'category' ? (row?.default_category_id ?? null) : null;
  return { mode, categoryId };
}

function invalid(errors) {
  throw new AssetCategoryValidationError(errors);
}

function parseProjectPreferenceValue(value) {
  if (value === 'inherit') return { mode: 'inherit', categoryId: null };
  if (value === 'all') return { mode: 'all', categoryId: null };

  if (typeof value === 'string' && value.startsWith('category:')) {
    const rawId = value.slice('category:'.length);
    if (!/^[1-9]\d*$/.test(rawId)) {
      invalid({ categoryId: 'Category ID must be a positive integer.' });
    }
    const categoryId = Number(rawId);
    if (!Number.isSafeInteger(categoryId) || categoryId <= 0) {
      invalid({ categoryId: 'Category ID must be a positive integer.' });
    }
    return { mode: 'category', categoryId };
  }

  invalid({ value: 'Preference must be inherit, all, or category:<positive integer>.' });
}

function isMalformedGlobalValue(value) {
  return typeof value !== 'string' || value.length === 0 || validateDirectorySlug(value) !== null;
}

function defaultAutoRenameUnavailableReason(fallbackReason) {
  if (!fallbackReason) return AUTO_RENAME_UNAVAILABLE_REASONS.ALL;
  if (
    fallbackReason === PREFERENCE_FALLBACK_REASONS.PROJECT_CATEGORY_DISABLED
    || fallbackReason === PREFERENCE_FALLBACK_REASONS.GLOBAL_CATEGORY_DISABLED
    || fallbackReason === PREFERENCE_FALLBACK_REASONS.GLOBAL_PROJECT_CATEGORY_DISABLED
  ) return AUTO_RENAME_UNAVAILABLE_REASONS.DISABLED;
  if (
    fallbackReason === PREFERENCE_FALLBACK_REASONS.PROJECT_CATEGORY_MISSING
    || fallbackReason === PREFERENCE_FALLBACK_REASONS.GLOBAL_CATEGORY_MISSING
    || fallbackReason === PREFERENCE_FALLBACK_REASONS.GLOBAL_CATEGORY_NOT_IN_PROJECT
  ) return AUTO_RENAME_UNAVAILABLE_REASONS.MISSING;
  if (
    fallbackReason === PREFERENCE_FALLBACK_REASONS.PROJECT_PREFERENCE_MALFORMED
    || fallbackReason === PREFERENCE_FALLBACK_REASONS.GLOBAL_PREFERENCE_MALFORMED
  ) return AUTO_RENAME_UNAVAILABLE_REASONS.INVALID;
  return AUTO_RENAME_UNAVAILABLE_REASONS.NO_CONCRETE_DEFAULT;
}

function makeResolution(
  projectId,
  preference,
  effectiveCategory,
  fallback,
  fallbackReason,
  autoRenameUnavailableReason = null,
) {
  const autoRenameAvailable = Boolean(effectiveCategory);
  return {
    projectId,
    storedMode: preference.mode,
    storedCategoryId: preference.categoryId,
    effective: effectiveCategory
      ? { kind: 'category', category: effectiveCategory }
      : { kind: 'all', category: null },
    fallback,
    fallbackReason,
    autoRenameAvailable,
    autoRenameUnavailableReason: autoRenameAvailable
      ? null
      : (autoRenameUnavailableReason || defaultAutoRenameUnavailableReason(fallbackReason)),
  };
}

function parseExplicitCategoryId(value) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function extractExplicitCategory(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of ['explicitCategory', 'explicitCategoryId', 'categoryId', 'category']) {
      if (Object.prototype.hasOwnProperty.call(value, key)) return value[key];
    }
  }
  return value;
}

/**
 * Domain service for persisted asset-browser category defaults.
 *
 * Category ownership and enabled-state checks are deliberately performed here
 * rather than by a foreign key: disabled references remain retainable, while
 * deleted references are reset by an explicit deletion integration later.
 */
export function createAssetBrowserPreferenceService({
  preferenceRepository,
  assetBrowserPreferenceRepository,
  projectRepository,
  assetCategoryRepository,
} = {}) {
  const repository = assetBrowserPreferenceRepository ?? preferenceRepository;

  if (!repository) {
    throw new Error('createAssetBrowserPreferenceService requires a preferenceRepository dependency.');
  }
  if (!projectRepository) {
    throw new Error('createAssetBrowserPreferenceService requires a projectRepository dependency.');
  }
  if (!assetCategoryRepository) {
    throw new Error('createAssetBrowserPreferenceService requires an assetCategoryRepository dependency.');
  }

  function requireProject(projectId) {
    assertPositiveIntegerId(projectId, 'projectId');
    const project = projectRepository.findById(projectId);
    if (!project) throw new ProjectNotFoundError(projectId);
    return project;
  }

  function readProjectPreference(projectId) {
    requireProject(projectId);
    return normalizeProjectPreference(repository.findProjectPreference(projectId));
  }

  function findGlobalCategory(slug) {
    return assetCategoryRepository.listDefaults().find((category) => category.directory_slug === slug);
  }

  return {
    /**
     * Read a project's stored preference without creating a row for a missing
     * preference. Existing and newly-created projects both safely read as
     * inherit until an explicit value is stored.
     */
    getProjectPreference(projectId) {
      return readProjectPreference(projectId);
    },

    /**
     * Validate and persist inherit, all, or a project-owned enabled category.
     */
    setProjectPreference(projectId, value) {
      assertPositiveIntegerId(projectId, 'projectId');
      const parsed = parseProjectPreferenceValue(value);
      requireProject(projectId);

      if (parsed.mode === 'category') {
        const category = assetCategoryRepository.findProjectCategoryById(projectId, parsed.categoryId);
        if (!category) {
          invalid({ categoryId: 'Category must exist and belong to this project.' });
        }
        if (!isEnabled(category)) {
          invalid({ categoryId: 'Disabled categories cannot be selected directly.' });
        }
      }

      const stored = repository.upsertProjectPreference(
        projectId,
        parsed.mode,
        parsed.categoryId,
      );
      return normalizeProjectPreference(stored);
    },

    /**
     * Return the raw global metadata value. Validation is deferred to
     * effective resolution so malformed/stale rows remain observable and are
     * never silently rewritten.
     */
    getGlobalPreference() {
      return repository.getGlobalDefault();
    },

    /**
     * Persist `all` or the stable slug of an enabled global category.
     */
    setGlobalPreference(value) {
      if (value === 'all') {
        return repository.setGlobalDefault(value);
      }

      if (isMalformedGlobalValue(value)) {
        invalid({ value: 'Global preference must be all or an enabled global category slug.' });
      }

      const category = findGlobalCategory(value);
      if (!category) {
        invalid({ value: 'Global preference must be all or an enabled global category slug.' });
      }
      if (!isEnabled(category)) {
        invalid({ value: 'The selected global category is disabled.' });
      }

      return repository.setGlobalDefault(value);
    },

    /**
     * Resolve a project's effective browser category without mutating either
     * preference store. All results carry the stored state and an explicit
     * fallback reason when a requested category cannot be used.
     */
    resolveEffectiveCategory(projectId, explicitCategoryInput) {
      if (arguments.length < 2) return resolveProjectEffectiveCategory(projectId);
      return resolveExplicitCategory(projectId, extractExplicitCategory(explicitCategoryInput));
    },

    /**
     * Read the stored project preference and its effective result for page
     * presentation without routing through the bare-visit resolver method.
     * This keeps non-bare browser requests from being mistaken for default
     * activation while retaining one domain implementation of resolution.
     */
    getProjectPreferenceState(projectId) {
      const preference = readProjectPreference(projectId);
      return {
        preference,
        resolution: resolveProjectEffectiveCategory(projectId),
      };
    },

    /**
     * Resolve the effective category without mutating either preference store.
     * Kept private to the service so page presentation and bare visits share
     * exactly the same fallback rules.
     */
    resetPreferenceForDeletedCategory(projectId, categoryId) {
      assertPositiveIntegerId(projectId, 'projectId');
      assertPositiveIntegerId(categoryId, 'categoryId');
      requireProject(projectId);
      return repository.resetProjectPreferenceIfCategory(projectId, categoryId);
    },
  };

  function resolveExplicitCategory(projectId, rawCategory) {
    const preference = readProjectPreference(projectId);

    if (rawCategory === 'all') {
      return makeResolution(
        projectId,
        preference,
        null,
        true,
        null,
        AUTO_RENAME_UNAVAILABLE_REASONS.ALL,
      );
    }
    if (rawCategory === 'uncategorized') {
      return makeResolution(
        projectId,
        preference,
        null,
        true,
        null,
        AUTO_RENAME_UNAVAILABLE_REASONS.UNCATEGORIZED,
      );
    }

    const categoryId = parseExplicitCategoryId(rawCategory);
    if (categoryId === null) {
      return makeResolution(
        projectId,
        preference,
        null,
        true,
        null,
        AUTO_RENAME_UNAVAILABLE_REASONS.INVALID,
      );
    }

    const category = assetCategoryRepository.findProjectCategoryById(projectId, categoryId);
    if (!category) {
      const foreignCategory = typeof assetCategoryRepository.findProjectCategoryByIdAnyProject === 'function'
        ? assetCategoryRepository.findProjectCategoryByIdAnyProject(categoryId)
        : null;
      return makeResolution(
        projectId,
        preference,
        null,
        true,
        null,
        foreignCategory && foreignCategory.project_id !== projectId
          ? AUTO_RENAME_UNAVAILABLE_REASONS.CROSS_PROJECT
          : AUTO_RENAME_UNAVAILABLE_REASONS.MISSING,
      );
    }
    if (!isEnabled(category)) {
      return makeResolution(
        projectId,
        preference,
        null,
        true,
        null,
        AUTO_RENAME_UNAVAILABLE_REASONS.DISABLED,
      );
    }

    return makeResolution(projectId, preference, category, false, null);
  }

  function resolveProjectEffectiveCategory(projectId) {
    const preference = readProjectPreference(projectId);

      if (!PROJECT_PREFERENCE_MODES.includes(preference.mode)) {
        return makeResolution(
          projectId,
          preference,
          null,
          true,
          PREFERENCE_FALLBACK_REASONS.PROJECT_PREFERENCE_MALFORMED,
        );
      }

      if (preference.mode === 'all') {
        return makeResolution(projectId, preference, null, false, null);
      }

      if (preference.mode === 'category') {
        if (!Number.isSafeInteger(preference.categoryId) || preference.categoryId <= 0) {
          return makeResolution(
            projectId,
            preference,
            null,
            true,
            PREFERENCE_FALLBACK_REASONS.PROJECT_PREFERENCE_MALFORMED,
          );
        }

        const category = assetCategoryRepository.findProjectCategoryById(
          projectId,
          preference.categoryId,
        );
        if (!category) {
          return makeResolution(
            projectId,
            preference,
            null,
            true,
            PREFERENCE_FALLBACK_REASONS.PROJECT_CATEGORY_MISSING,
          );
        }
        if (!isEnabled(category)) {
          return makeResolution(
            projectId,
            preference,
            null,
            true,
            PREFERENCE_FALLBACK_REASONS.PROJECT_CATEGORY_DISABLED,
          );
        }
        return makeResolution(projectId, preference, category, false, null);
      }

      const globalValue = repository.getGlobalDefault();
      if (globalValue === 'all') {
        return makeResolution(projectId, preference, null, false, null);
      }
      if (isMalformedGlobalValue(globalValue)) {
        return makeResolution(
          projectId,
          preference,
          null,
          true,
          PREFERENCE_FALLBACK_REASONS.GLOBAL_PREFERENCE_MALFORMED,
        );
      }

      const globalCategory = findGlobalCategory(globalValue);
      if (!globalCategory) {
        return makeResolution(
          projectId,
          preference,
          null,
          true,
          PREFERENCE_FALLBACK_REASONS.GLOBAL_CATEGORY_MISSING,
        );
      }
      if (!isEnabled(globalCategory)) {
        return makeResolution(
          projectId,
          preference,
          null,
          true,
          PREFERENCE_FALLBACK_REASONS.GLOBAL_CATEGORY_DISABLED,
        );
      }

      const projectCategory = assetCategoryRepository
        .listProjectCategories(projectId)
        .find((category) => category.directory_slug === globalValue);
      if (!projectCategory) {
        return makeResolution(
          projectId,
          preference,
          null,
          true,
          PREFERENCE_FALLBACK_REASONS.GLOBAL_CATEGORY_NOT_IN_PROJECT,
        );
      }
      if (!isEnabled(projectCategory)) {
        return makeResolution(
          projectId,
          preference,
          null,
          true,
          PREFERENCE_FALLBACK_REASONS.GLOBAL_PROJECT_CATEGORY_DISABLED,
        );
      }

      return makeResolution(projectId, preference, projectCategory, false, null);
  }
}
