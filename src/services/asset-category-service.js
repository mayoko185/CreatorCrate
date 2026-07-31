/**
 * Phase 1: configurable asset categories — validation and orchestration.
 *
 * Database-only in this chunk: no filesystem operations are performed here.
 * The repository is injected explicitly; this service never constructs one
 * itself or reaches for hidden database state.
 */

export class AssetCategoryValidationError extends Error {
  constructor(errors) {
    super('Asset category validation failed');
    this.name = 'AssetCategoryValidationError';
    this.errors = errors;
  }
}

export class AssetCategoryNotFoundError extends Error {
  constructor(id) {
    super(`Asset category ${id} not found`);
    this.name = 'AssetCategoryNotFoundError';
    this.status = 404;
  }
}

const DISPLAY_NAME_MIN = 1;
const DISPLAY_NAME_MAX = 100;

const DIRECTORY_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const RESERVED_DEVICE_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/**
 * Validate a directory slug: must match the portable single-segment slug
 * pattern and must not be usable to escape or collide with a reserved or
 * unsafe filesystem name. Returns an error message string, or null if valid.
 */
function validateDirectorySlug(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return 'Directory slug is required.';
  }
  if (value.includes('\0')) {
    return 'Directory slug must not contain NUL characters.';
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(value)) {
    return 'Directory slug must not contain control characters.';
  }
  if (value.includes('/') || value.includes('\\')) {
    return 'Directory slug must not contain path separators.';
  }
  if (value === '.' || value === '..') {
    return 'Directory slug must not be "." or "..".';
  }
  if (isAbsoluteLikePath(value)) {
    return 'Directory slug must not be an absolute path.';
  }
  if (value !== value.trim()) {
    return 'Directory slug must not have leading or trailing spaces.';
  }
  if (value.endsWith('.')) {
    return 'Directory slug must not end with a dot.';
  }
  if (value.toLowerCase() === 'project.json') {
    return 'Directory slug must not be "project.json".';
  }
  if (RESERVED_DEVICE_NAMES.has(value.toUpperCase())) {
    return 'Directory slug must not be a reserved device name.';
  }
  if (!DIRECTORY_SLUG_PATTERN.test(value)) {
    return 'Directory slug must be lowercase alphanumeric segments separated by single hyphens.';
  }
  return null;
}

// Windows absolute paths (e.g. "C:\", "C:/") are not caught by a bare
// path.isAbsolute check on POSIX; a leading drive letter plus colon is
// enough to flag as absolute-like for this portability check.
function isAbsoluteLikePath(value) {
  if (value.startsWith('/') || value.startsWith('\\')) return true;
  if (/^[a-zA-Z]:[\\/]/.test(value)) return true;
  return false;
}

function validateDisplayName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (name.length < DISPLAY_NAME_MIN) {
    return { name, error: 'Display name is required.' };
  }
  if (name.length > DISPLAY_NAME_MAX) {
    return { name, error: `Display name must be ${DISPLAY_NAME_MAX} characters or fewer.` };
  }
  return { name, error: null };
}

/**
 * Assert that `value` is a plain, non-array, non-null object suitable for
 * use as a category input payload.
 */
function assertPlainObject(value, fieldLabel) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AssetCategoryValidationError({ [fieldLabel]: 'Input must be an object.' });
  }
}

/**
 * Assert that `value` is a positive (non-zero, non-negative, non-fractional,
 * finite) integer ID. Rejects strings, NaN, and Infinity — callers never
 * coerce; the caller passing a string ID is itself the bug.
 */
function assertPositiveIntegerId(value, fieldLabel) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new AssetCategoryValidationError({ [fieldLabel]: `${fieldLabel} must be a positive integer.` });
  }
}

/**
 * Assert that `value` is an actual boolean — never coerced from a truthy/
 * falsy value, so `"false"`, `0`, `1`, and `null` are all rejected rather
 * than silently reinterpreted.
 */
function assertStrictBoolean(value, fieldLabel) {
  if (typeof value !== 'boolean') {
    throw new AssetCategoryValidationError({ [fieldLabel]: `${fieldLabel} must be a boolean.` });
  }
}

function validateCategoryInput(input) {
  const errors = {};

  const { name: displayName, error: nameError } = validateDisplayName(input.displayName);
  if (nameError) {
    errors.displayName = nameError;
  }

  const directorySlug = typeof input.directorySlug === 'string' ? input.directorySlug : '';
  const slugError = validateDirectorySlug(directorySlug);
  if (slugError) {
    errors.directorySlug = slugError;
  }

  if (Object.keys(errors).length > 0) {
    throw new AssetCategoryValidationError(errors);
  }

  return { displayName, directorySlug };
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

    editDefault(id, input) {
      assertPositiveIntegerId(id, 'id');
      assertPlainObject(input, 'input');
      const { displayName, directorySlug } = validateCategoryInput(input);
      requireDefault(id);
      return repository.updateDefaultNameSlug(id, { displayName, directorySlug });
    },

    setDefaultEnabled(id, enabled) {
      assertPositiveIntegerId(id, 'id');
      assertStrictBoolean(enabled, 'enabled');
      requireDefault(id);
      return repository.setDefaultEnabled(id, enabled);
    },

    reorderDefaults(orderedIds) {
      if (!Array.isArray(orderedIds) || orderedIds.some((id) => !Number.isInteger(id) || id <= 0)) {
        throw new AssetCategoryValidationError({ order: 'Reorder input must be an array of positive integer IDs.' });
      }
      return repository.reorderDefaults(orderedIds);
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
