/**
 * Portable filename validation for asset rename/move (Phase: asset actions
 * chunk 1). Validates a single filename/basename in isolation — it does not
 * know about the asset's current name, so it cannot reject an unchanged or
 * case-only rename; that requires source-path context and belongs in the
 * action service that will call this in a later chunk.
 */

export class AssetFilenameValidationError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = 'AssetFilenameValidationError';
    this.code = code;
  }
}

// Conservative cross-platform limit: 255 bytes is the ceiling on ext4, NTFS,
// APFS, and HFS+ alike (NTFS/APFS count UTF-16/UTF-8 units respectively, but
// 255 UTF-8 bytes is always within their per-component limit too).
export const PORTABLE_FILENAME_MAX_BYTES = 255;

const RESERVED_DEVICE_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

// Windows absolute paths (e.g. "C:\", "C:/") are not caught by a bare
// path separator check — a leading drive letter plus colon is enough to
// flag as absolute-like for this portability check.
function isAbsoluteLikePath(value) {
  if (value.startsWith('/') || value.startsWith('\\')) return true;
  if (/^[a-zA-Z]:[\\/]/.test(value)) return true;
  return false;
}

// Windows reserved device names are reserved for the base name only — the
// portion before the first dot — so "CON.txt" is reserved just like "CON".
function reservedDeviceBaseName(value) {
  const dotIndex = value.indexOf('.');
  return (dotIndex === -1 ? value : value.slice(0, dotIndex)).toUpperCase();
}

/**
 * Validate a single filename/basename for portability across the
 * filesystems CreatorCrate targets. Rejects unsafe input outright rather
 * than normalizing it into a different accepted name.
 *
 * @param {unknown} value
 * @returns {string|null} an error message, or null if `value` is valid
 */
export function validateAssetFilename(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return 'Filename is required.';
  }
  if (value.includes('\0')) {
    return 'Filename must not contain NUL characters.';
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(value)) {
    return 'Filename must not contain control characters.';
  }
  if (value.includes('/') || value.includes('\\')) {
    return 'Filename must not contain path separators.';
  }
  if (/[<>:"|?*]/.test(value)) {
    return 'Filename must not contain characters that are forbidden on Windows: < > : " | ? *';
  }
  if (value === '.' || value === '..') {
    return 'Filename must not be "." or "..".';
  }
  if (isAbsoluteLikePath(value)) {
    return 'Filename must not be an absolute or drive-prefixed path.';
  }
  if (value.endsWith('.')) {
    return 'Filename must not end with a dot.';
  }
  if (value.endsWith(' ')) {
    return 'Filename must not end with a space.';
  }
  if (RESERVED_DEVICE_NAMES.has(reservedDeviceBaseName(value))) {
    return 'Filename must not be a reserved device name.';
  }
  if (Buffer.byteLength(value, 'utf8') > PORTABLE_FILENAME_MAX_BYTES) {
    return `Filename must not exceed ${PORTABLE_FILENAME_MAX_BYTES} bytes.`;
  }
  return null;
}

/**
 * Assert that `value` is a valid asset filename.
 * @param {unknown} value
 * @returns {string} `value`, unchanged
 * @throws {AssetFilenameValidationError}
 */
export function assertValidAssetFilename(value) {
  const error = validateAssetFilename(value);
  if (error) {
    throw new AssetFilenameValidationError(error, { code: 'INVALID_FILENAME' });
  }
  return value;
}
