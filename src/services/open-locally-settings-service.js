/**
 * Open locally settings service.
 *
 * Owns the configured Windows projects root used to build v2 "Open locally"
 * URIs. The value is stored in app_meta under `open_locally.windows_projects_path`
 * and is validated for shape only — the app runs in Docker/Linux, so the
 * service can never verify that the Windows path actually exists.
 */

export const OPEN_LOCALLY_WINDOWS_PROJECTS_PATH_KEY = 'open_locally.windows_projects_path';

const DRIVE_LETTER_PATTERN = /^[A-Za-z]:[\\/]/;
const DEVICE_PREFIX_PATTERN = /^[\\/][.?][\\/]/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const TRAILING_SEPARATOR_PATTERN = /[\\/]+$/;

export class OpenLocallySettingsValidationError extends Error {
  constructor(errors) {
    super('Open locally settings validation failed');
    this.name = 'OpenLocallySettingsValidationError';
    this.errors = errors;
  }
}

function invalid(errors) {
  throw new OpenLocallySettingsValidationError(errors);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function hasTraversalSegment(value) {
  return value.split(/[\\/]/).some((segment) => segment === '.' || segment === '..');
}

function hasControlCharacters(value) {
  return CONTROL_CHARACTER_PATTERN.test(value);
}

function hasAlternateDataStreamSyntax(value) {
  const segments = value.split(/[\\/]/);
  // The leading drive segment ("C:") is the drive root, not an alternate
  // data stream; every other segment must not contain a colon.
  return segments.slice(1).some((segment) => segment.includes(':'));
}

/**
 * Validate the shape of a Windows projects root path. Returns the normalized
 * value (trailing separators removed) or throws
 * OpenLocallySettingsValidationError. Never touches the filesystem.
 */
export function validateWindowsProjectsPath(value) {
  if (!isNonEmptyString(value)) {
    invalid({ windowsProjectsPath: 'Windows projects path is required.' });
  }

  if (value.includes('\0')) {
    invalid({ windowsProjectsPath: 'Windows projects path must not contain a null byte.' });
  }

  if (hasControlCharacters(value)) {
    invalid({ windowsProjectsPath: 'Windows projects path must not contain control characters.' });
  }

  if (DEVICE_PREFIX_PATTERN.test(value)) {
    invalid({ windowsProjectsPath: 'Windows projects path must not use a device prefix.' });
  }

  if (value.startsWith('\\\\') || value.startsWith('//')) {
    invalid({ windowsProjectsPath: 'Windows projects path must not be a UNC path.' });
  }

  if (!DRIVE_LETTER_PATTERN.test(value)) {
    invalid({ windowsProjectsPath: 'Windows projects path must be an absolute Windows drive path.' });
  }

  if (hasTraversalSegment(value)) {
    invalid({ windowsProjectsPath: 'Windows projects path must not contain traversal segments.' });
  }

  if (hasAlternateDataStreamSyntax(value)) {
    invalid({ windowsProjectsPath: 'Windows projects path must not contain alternate data stream syntax.' });
  }

  // Normalize to backslashes and strip trailing separators so the stored
  // value is a canonical Windows path.
  const normalized = value.replace(TRAILING_SEPARATOR_PATTERN, '').replace(/\//g, '\\');

  // A bare drive root ("C:\") normalizes to "C:", which is no longer an
  // absolute Windows path and can never be composed into a valid "Open
  // locally" URI; the Windows helper also refuses the drive root.
  if (/^[A-Za-z]:$/.test(normalized)) {
    invalid({ windowsProjectsPath: 'Windows projects path must not be the drive root.' });
  }

  return normalized;
}

/**
 * @param {object} deps
 * @param {ReturnType<import('../data/app-meta-repository.js').createAppMetaRepository>} deps.appMetaRepository
 */
export function createOpenLocallySettingsService({ appMetaRepository } = {}) {
  if (!appMetaRepository || typeof appMetaRepository.getValue !== 'function'
    || typeof appMetaRepository.setValue !== 'function') {
    throw new Error('createOpenLocallySettingsService requires an appMetaRepository dependency.');
  }

  return {
    /**
     * The configured Windows projects root, or null when not configured.
     */
    getWindowsProjectsPath() {
      const stored = appMetaRepository.getValue(OPEN_LOCALLY_WINDOWS_PROJECTS_PATH_KEY);
      // An empty string is the cleared sentinel written by clearWindowsProjectsPath.
      if (stored === undefined || stored === null || stored === '') return null;
      try {
        return validateWindowsProjectsPath(stored);
      } catch {
        // Malformed stored values are observable but never silently rewritten;
        // the caller decides how to present them.
        return stored;
      }
    },

    /**
     * Validate and persist the Windows projects root. Returns the normalized
     * stored value.
     */
    setWindowsProjectsPath(value) {
      const normalized = validateWindowsProjectsPath(value);
      return appMetaRepository.setValue(OPEN_LOCALLY_WINDOWS_PROJECTS_PATH_KEY, normalized);
    },

    setWindowsProjectsPathWithOutcome(value) {
      const normalized = validateWindowsProjectsPath(value);
      return appMetaRepository.setValueWithOutcome(
        OPEN_LOCALLY_WINDOWS_PROJECTS_PATH_KEY,
        normalized,
      );
    },

    /**
     * Remove the configured Windows projects root. Returns true when a value
     * was present, false when nothing was stored.
     */
    clearWindowsProjectsPath() {
      const stored = appMetaRepository.getValue(OPEN_LOCALLY_WINDOWS_PROJECTS_PATH_KEY);
      const hadValue = stored !== undefined && stored !== null && stored !== '';
      if (hadValue) {
        appMetaRepository.setValue(OPEN_LOCALLY_WINDOWS_PROJECTS_PATH_KEY, '');
      }
      return hadValue;
    },

    clearWindowsProjectsPathWithOutcome() {
      const previousValue = appMetaRepository.getValue(OPEN_LOCALLY_WINDOWS_PROJECTS_PATH_KEY);
      if (!previousValue) {
        return { value: '', changed: false };
      }

      appMetaRepository.setValue(OPEN_LOCALLY_WINDOWS_PROJECTS_PATH_KEY, '');
      return { value: '', changed: true };
    },
  };
}
