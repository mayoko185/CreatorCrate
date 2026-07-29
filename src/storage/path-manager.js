import fs from 'node:fs';
import path from 'node:path';

export class StorageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StorageError';
  }
}

/**
 * Canonical directory names created beneath PROJECTS_ROOT.
 */
export const CANONICAL_DIRS = [
  'tbd',
  'planned',
  'active',
  'ready',
  'published',
  'archived',
  'inbox',
];

/**
 * Maps project status values to canonical directory names.
 */
export const STATUS_DIR_MAP = {
  tbd: 'tbd',
  planned: 'planned',
  'in-progress': 'active',
  ready: 'ready',
  published: 'published',
  archived: 'archived',
};

/**
 * Resolve the absolute path to a project's directory.
 * @param {string} projectsRoot
 * @param {string} status
 * @param {string} slug
 * @returns {string}
 */
export function getProjectDir(projectsRoot, status, slug) {
  const dirName = STATUS_DIR_MAP[status];
  if (!dirName) {
    throw new StorageError(`Unknown status "${status}" for project directory.`);
  }
  return path.join(projectsRoot, dirName, slug);
}

/**
 * Resolve the absolute path to a status directory.
 * @param {string} projectsRoot
 * @param {string} status
 * @returns {string}
 */
export function getStatusDir(projectsRoot, status) {
  const dirName = STATUS_DIR_MAP[status];
  if (!dirName) {
    throw new StorageError(`Unknown status "${status}" for status directory.`);
  }
  return path.join(projectsRoot, dirName);
}

/**
 * Ensure a single canonical directory exists.
 * Uses only the directory basename in error messages to avoid leaking
 * absolute paths to users.
 * @param {string} dirPath - Absolute path to the directory.
 * @throws {StorageError} if the path exists but is not a directory,
 *   or if it cannot be created.
 */
function ensureSingleDir(dirPath) {
  try {
    const stats = fs.statSync(dirPath);
    if (!stats.isDirectory()) {
      throw new StorageError(
        `"${path.basename(dirPath)}" exists but is not a directory.`
      );
    }
  } catch (err) {
    if (err instanceof StorageError) throw err;
    if (err.code === 'ENOENT') {
      fs.mkdirSync(dirPath, { recursive: true });
      return;
    }
    throw new StorageError(
      `Cannot access or create "${path.basename(dirPath)}".`
    );
  }
}

/**
 * Create all canonical project directories under PROJECTS_ROOT.
 *
 * Requirements:
 * - Runs only after PROJECTS_ROOT mount validation succeeds.
 * - Never creates PROJECTS_ROOT itself (caller must ensure it exists).
 * - Creates only the known CreatorCrate directories.
 * - Idempotent — accepts existing valid directories.
 * - Rejects a required child path if it exists but is not a directory.
 * - Preserves unknown directories.
 * - Fails with an actionable error if a required directory cannot be created
 *   or accessed.
 * - Error messages do NOT expose absolute paths.
 *
 * @param {string} projectsRoot - Absolute path to PROJECTS_ROOT (must exist).
 * @throws {StorageError} if a required directory cannot be created or accessed.
 */
export function ensureCanonicalDirs(projectsRoot) {
  let rootStats;
  try {
    rootStats = fs.statSync(projectsRoot);
  } catch (err) {
    throw new StorageError(
      'PROJECTS_ROOT does not exist or cannot be accessed.'
    );
  }
  if (!rootStats.isDirectory()) {
    throw new StorageError('PROJECTS_ROOT exists but is not a directory.');
  }

  const errors = [];

  for (const dirName of CANONICAL_DIRS) {
    const dirPath = path.join(projectsRoot, dirName);
    try {
      ensureSingleDir(dirPath);
    } catch (err) {
      errors.push(err.message);
    }
  }

  if (errors.length > 0) {
    throw new StorageError(
      `Failed to initialize project directories: ${errors.join('; ')}`
    );
  }
}

/**
 * Alias for ensureCanonicalDirs.
 * Used by server.js startup.
 * @param {string} projectsRoot
 * @throws {StorageError}
 */
export const ensureStatusDirs = ensureCanonicalDirs;

/**
 * Ensure the preview root directory exists and is a directory.
 *
 * Phase 10.1A: derived as APP_DATA_ROOT/previews. Idempotent — accepts an
 * existing valid directory. The parent must already exist (created by
 * validateMounts); this only ensures the previews child. Never creates the
 * preview root if a non-directory file occupies the path.
 *
 * Error messages do not leak absolute paths.
 *
 * @param {string} previewRoot - Absolute path to the preview root.
 * @throws {StorageError} if the path exists but is not a directory,
 *   or if it cannot be created or accessed.
 */
export function ensurePreviewRoot(previewRoot) {
  try {
    const stats = fs.statSync(previewRoot);
    if (!stats.isDirectory()) {
      throw new StorageError(
        `"${path.basename(previewRoot)}" exists but is not a directory.`
      );
    }
    return;
  } catch (err) {
    if (err instanceof StorageError) throw err;
    if (err.code === 'ENOENT') {
      try {
        fs.mkdirSync(previewRoot, { recursive: true });
      } catch (mkdirErr) {
        throw new StorageError(
          `Cannot create preview root "${path.basename(previewRoot)}".`
        );
      }
      return;
    }
    throw new StorageError(
      `Cannot access preview root "${path.basename(previewRoot)}".`
    );
  }
}

/**
 * Rename a project directory synchronously.
 * @param {string} oldPath
 * @param {string} newPath
 * @throws {StorageError} on failure.
 */
export function renameProjectDir(oldPath, newPath) {
  try {
    fs.renameSync(oldPath, newPath);
  } catch (err) {
    throw new StorageError(
      `Failed to move directory "${path.basename(oldPath)}" to "${path.basename(path.dirname(newPath))}/${path.basename(newPath)}".`
    );
  }
}

/**
 * Remove an empty project directory synchronously.
 * No-op if the directory does not exist.
 * @param {string} projectDir
 * @throws {StorageError} if the path exists but is not a directory,
 *   or is a non-empty directory, or cannot be removed.
 */
export function removeEmptyProjectDir(projectDir) {
  try {
    fs.rmSync(projectDir, { recursive: false, force: true });
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw new StorageError(
      `Failed to remove directory "${path.basename(projectDir)}".`
    );
  }
}
