import { validateDirectorySlug } from './asset-category-validation.js';

export const PREVIEW_CATEGORY_KEY = 'preview.default_category';
// This value is deliberately not a valid directory slug, so it cannot be
// confused with a global category default.
export const PREVIEW_CATEGORY_DISABLED_VALUE = '__disabled__';

export class PreviewCategoryValidationError extends Error {
  constructor(errors) {
    super('Preview category validation failed');
    this.name = 'PreviewCategoryValidationError';
    this.errors = errors;
  }
}

function invalid(message) {
  throw new PreviewCategoryValidationError({ value: message });
}

function isEnabled(category) {
  return category?.enabled === 1 || category?.enabled === true;
}

function categorySlug(category) {
  return category?.directory_slug ?? category?.directorySlug;
}

/**
 * Settings service for the global category used by the preview workflow.
 *
 * This setting is intentionally separate from the asset-browser default. It
 * only owns validation and app-meta persistence; scan and preview selection
 * behavior is outside this service.
 */
export function createPreviewCategorySettingsService({ appMetaRepository, assetCategoryService } = {}) {
  if (!appMetaRepository || typeof appMetaRepository.getValue !== 'function'
    || typeof appMetaRepository.setValue !== 'function') {
    throw new Error('createPreviewCategorySettingsService requires an appMetaRepository dependency.');
  }
  if (!assetCategoryService || typeof assetCategoryService.listDefaults !== 'function') {
    throw new Error('createPreviewCategorySettingsService requires an assetCategoryService dependency.');
  }

  return {
    /**
     * Return the stored stable slug or the explicit Disabled sentinel. A
     * missing key is the default disabled state for fresh and existing installs.
     */
    getPreviewCategory() {
      return appMetaRepository.getValue(PREVIEW_CATEGORY_KEY) ?? PREVIEW_CATEGORY_DISABLED_VALUE;
    },

    /**
     * Validate and persist Disabled or the stable slug of an enabled global
     * category default.
     */
    setPreviewCategory(value) {
      if (value === PREVIEW_CATEGORY_DISABLED_VALUE) {
        return appMetaRepository.setValue(PREVIEW_CATEGORY_KEY, PREVIEW_CATEGORY_DISABLED_VALUE);
      }

      if (typeof value !== 'string' || value.length === 0 || validateDirectorySlug(value) !== null) {
        invalid('Preview category must be Disabled or an enabled global category slug.');
      }

      const category = assetCategoryService.listDefaults().find((candidate) => categorySlug(candidate) === value);
      if (!category) {
        invalid('Preview category must be Disabled or an enabled global category slug.');
      }
      if (!isEnabled(category)) {
        invalid('The selected preview category is disabled.');
      }

      return appMetaRepository.setValue(PREVIEW_CATEGORY_KEY, value);
    },

    setPreviewCategoryWithOutcome(value) {
      if (value === PREVIEW_CATEGORY_DISABLED_VALUE) {
        return appMetaRepository.setValueWithOutcome(
          PREVIEW_CATEGORY_KEY,
          PREVIEW_CATEGORY_DISABLED_VALUE,
          { fallbackValue: PREVIEW_CATEGORY_DISABLED_VALUE },
        );
      }

      if (typeof value !== 'string' || value.length === 0 || validateDirectorySlug(value) !== null) {
        invalid('Preview category must be Disabled or an enabled global category slug.');
      }

      const category = assetCategoryService.listDefaults().find((candidate) => categorySlug(candidate) === value);
      if (!category) {
        invalid('Preview category must be Disabled or an enabled global category slug.');
      }
      if (!isEnabled(category)) {
        invalid('The selected preview category is disabled.');
      }

      return appMetaRepository.setValueWithOutcome(PREVIEW_CATEGORY_KEY, value, {
        fallbackValue: PREVIEW_CATEGORY_DISABLED_VALUE,
      });
    },
  };
}
