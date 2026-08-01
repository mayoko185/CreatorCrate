/**
 * Shared category validation contract — reused by the global-default asset
 * category service (Phase 1) and the project-scoped category service
 * (Phase 2 chunk 2) so display-name/slug rules never diverge between them.
 */

export class AssetCategoryValidationError extends Error {
  constructor(errors) {
    super('Asset category validation failed');
    this.name = 'AssetCategoryValidationError';
    this.errors = errors;
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

// Windows absolute paths (e.g. "C:\", "C:/") are not caught by a bare
// path.isAbsolute check on POSIX; a leading drive letter plus colon is
// enough to flag as absolute-like for this portability check.
function isAbsoluteLikePath(value) {
  if (value.startsWith('/') || value.startsWith('\\')) return true;
  if (/^[a-zA-Z]:[\\/]/.test(value)) return true;
  return false;
}

/**
 * Validate a directory slug: must match the portable single-segment slug
 * pattern and must not be usable to escape or collide with a reserved or
 * unsafe filesystem name. Returns an error message string, or null if valid.
 */
export function validateDirectorySlug(value) {
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

export function validateDisplayName(value) {
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
export function assertPlainObject(value, fieldLabel) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AssetCategoryValidationError({ [fieldLabel]: 'Input must be an object.' });
  }
}

/**
 * Assert that `value` is a positive (non-zero, non-negative, non-fractional,
 * finite) integer ID. Rejects strings, NaN, and Infinity — callers never
 * coerce; the caller passing a string ID is itself the bug.
 */
export function assertPositiveIntegerId(value, fieldLabel) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new AssetCategoryValidationError({ [fieldLabel]: `${fieldLabel} must be a positive integer.` });
  }
}

/**
 * Assert that `value` is an actual boolean — never coerced from a truthy/
 * falsy value, so `"false"`, `0`, `1`, and `null` are all rejected rather
 * than silently reinterpreted.
 */
export function assertStrictBoolean(value, fieldLabel) {
  if (typeof value !== 'boolean') {
    throw new AssetCategoryValidationError({ [fieldLabel]: `${fieldLabel} must be a boolean.` });
  }
}

/**
 * Parse the deliberately small set of HTML form representations used by
 * enabled-state controls. A checked switch submits the hidden `0` sentinel
 * and the checkbox's `1` value, which `qs` exposes as an array.
 *
 * @param {unknown} value
 * @param {{defaultValue?: boolean, fieldLabel?: string}} [options]
 * @returns {boolean}
 * @throws {AssetCategoryValidationError}
 */
export function parseEnabledField(value, { defaultValue, fieldLabel = 'enabled' } = {}) {
  if (value === undefined) {
    if (defaultValue === true || defaultValue === false) return defaultValue;
    throw new AssetCategoryValidationError({ [fieldLabel]: 'Enabled value is required.' });
  }

  const values = Array.isArray(value) ? value : [value];
  const isHiddenAndChecked = values.length === 2
    && values.every((item) => typeof item === 'string')
    && new Set(values).size === 2
    && values.includes('0')
    && values.includes('1');
  if (isHiddenAndChecked) return true;

  if (values.length === 1 && typeof values[0] === 'string') {
    if (values[0] === '1' || values[0] === 'on' || values[0] === 'true') return true;
    if (values[0] === '0' || values[0] === 'off' || values[0] === 'false') return false;
  }

  throw new AssetCategoryValidationError({
    [fieldLabel]: 'Enabled value must be 0, 1, on, off, true, or false.',
  });
}

/**
 * Validate a combined { displayName, directorySlug } category input payload.
 * @returns {{ displayName: string, directorySlug: string }}
 * @throws {AssetCategoryValidationError}
 */
export function validateCategoryInput(input) {
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
