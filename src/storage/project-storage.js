import fs from 'node:fs';
import path from 'node:path';
import { StorageError, STATUS_DIR_MAP } from './path-manager.js';

export { STATUS_DIR_MAP };

// ─── Directory name formatting ───────────────────────────────────────────

/**
 * Format a project directory name with zero-padded ID and validated slug.
 * Minimum width is 6 digits; IDs longer than 6 digits are not truncated.
 *
 * @param {number} id - Numeric project ID (from database)
 * @param {string} slug - Validated project slug
 * @returns {string} e.g. "000042-my-project"
 */
export function formatProjectDirName(id, slug) {
  const padded = String(id).padStart(6, '0');
  return `${padded}-${slug}`;
}

// ─── Status-to-directory mapping ─────────────────────────────────────────

/**
 * Build a relative path from project status and formatted directory name.
 *
 * @param {string} status - One of the known project status values
 * @param {string} dirName - Formatted directory name from {@link formatProjectDirName}
 * @returns {string} e.g. "active/000042-my-project"
 * @throws {StorageError} if status is unknown
 */
export function buildProjectRelPath(status, dirName) {
  const statusDir = STATUS_DIR_MAP[status];
  if (!statusDir) {
    throw new StorageError(`Unknown status "${status}".`);
  }
  return path.join(statusDir, dirName);
}

// ─── Safe path resolution ────────────────────────────────────────────────

/**
 * Resolve a relative project path under PROJECTS_ROOT with safety checks:
 *
 * - Rejects absolute `relPath` inputs.
 * - Refuses traversal outside PROJECTS_ROOT.
 * - Uses `lstat` on every existing path component and refuses any component
 *   that is a symbolic link (prevents symlink-escape attacks).
 * - Refuses the target path itself if it is a symbolic link.
 *
 * @param {string} projectsRoot - Absolute path to PROJECTS_ROOT (must exist)
 * @param {string} relPath - Relative path under a status directory
 * @returns {string} Resolved, verified absolute path
 * @throws {StorageError} if any safety check fails
 */
export function resolveProjectDir(projectsRoot, relPath) {
  if (!relPath) {
    throw new StorageError('Project directory path must be a non-empty relative path.');
  }
  if (path.isAbsolute(relPath)) {
    throw new StorageError('Project directory path must be relative to PROJECTS_ROOT.');
  }

  const normalizedRoot = path.resolve(projectsRoot);
  const resolved = path.resolve(normalizedRoot, relPath);

  if (resolved === normalizedRoot) {
    throw new StorageError('Project directory path must be a subdirectory of PROJECTS_ROOT.');
  }
  if (!isContained(normalizedRoot, resolved)) {
    throw new StorageError('Project directory path escapes PROJECTS_ROOT.');
  }

  checkSymlinks(normalizedRoot, resolved);

  return resolved;
}

/**
 * @param {string} root - Normalized absolute root path (with trailing separator semantics)
 * @param {string} target - Normalized absolute target path
 * @returns {boolean}
 */
function isContained(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Walk each existing path component from root to target; refuse any symlink.
 * Stops at the first non-existent component (ENOENT) — only existing segments
 * can be symlink-escape vectors.
 *
 * @param {string} root - Normalized absolute root path
 * @param {string} target - Normalized absolute target path
 * @throws {StorageError} if any existing component is a symbolic link
 */
function checkSymlinks(root, target) {
  const relative = path.relative(root, target);
  if (relative === '') return;

  const parts = relative.split(path.sep);
  let current = root;

  for (const part of parts) {
    current = path.join(current, part);
    try {
      const stats = fs.lstatSync(current);
      if (stats.isSymbolicLink()) {
        throw new StorageError(
          `Project directory path contains a symbolic link at "${path.basename(current)}".`
        );
      }
    } catch (err) {
      if (err instanceof StorageError) throw err;
      if (err.code === 'ENOENT') return; // Non-existent segment → further can't be vectors
      throw new StorageError(
        `Cannot access path component "${path.basename(current)}".`
      );
    }
  }
}

// ─── Destination conflict detection ──────────────────────────────────────

/**
 * Ensure a resolved path does not already exist.
 * Never silently overwrites.
 *
 * @param {string} dirPath - Resolved absolute path to check
 * @throws {StorageError} if the path already exists or is inaccessible
 */
export function ensureNoConflict(dirPath) {
  try {
    fs.statSync(dirPath);
    throw new StorageError(
      `Destination "${path.basename(dirPath)}" already exists.`
    );
  } catch (err) {
    if (err instanceof StorageError) throw err;
    if (err.code === 'ENOENT') return;
    throw new StorageError(
      `Cannot access "${path.basename(dirPath)}".`
    );
  }
}

// ─── Category-driven subdirectory creation ───────────────────────────────

const RESERVED_DEVICE_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

// Portable single-segment slug: lowercase alphanumeric, hyphen-separated.
// Enforced independently of any upstream (service-layer) validation —
// uppercase, spaces, underscores, and dotted names like "project.json" all
// fail this pattern regardless of what already ran before this boundary.
const DIRECTORY_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Defensively validate a category directory slug at the storage boundary.
 * Independent of (and not imported from) the asset-category service layer —
 * storage must not trust an upstream validator and must reject unsafe
 * values itself before ever touching the filesystem.
 *
 * @param {string} slug
 * @throws {StorageError} if the slug is not a single safe direct-child name
 */
function assertSafeCategorySlug(slug) {
  if (typeof slug !== 'string' || slug.length === 0) {
    throw new StorageError('Category directory slug must be a non-empty string.');
  }
  // eslint-disable-next-line no-control-regex
  if (slug.includes('\0') || /[\x00-\x1f]/.test(slug)) {
    throw new StorageError(`Category directory slug "${slug}" contains control characters.`);
  }
  if (slug.includes('/') || slug.includes('\\')) {
    throw new StorageError(`Category directory slug "${slug}" must not contain path separators.`);
  }
  if (slug === '.' || slug === '..') {
    throw new StorageError('Category directory slug must not be "." or "..".');
  }
  if (path.isAbsolute(slug) || /^[a-zA-Z]:[\\/]/.test(slug)) {
    throw new StorageError(`Category directory slug "${slug}" must not be an absolute path.`);
  }
  if (slug !== slug.trim()) {
    throw new StorageError(`Category directory slug "${slug}" must not have leading or trailing spaces.`);
  }
  if (slug.endsWith('.')) {
    throw new StorageError(`Category directory slug "${slug}" must not end with a dot.`);
  }
  if (slug.toLowerCase() === 'project.json') {
    throw new StorageError(`Category directory slug "${slug}" must not be "project.json".`);
  }
  if (RESERVED_DEVICE_NAMES.has(slug.toUpperCase())) {
    throw new StorageError(`Category directory slug "${slug}" must not be a reserved device name.`);
  }
  if (!DIRECTORY_SLUG_PATTERN.test(slug)) {
    throw new StorageError(
      `Category directory slug "${slug}" must be lowercase alphanumeric segments separated by single hyphens.`
    );
  }
}

/**
 * Accept only the "enabled" shapes storage tolerates: real booleans (the
 * service-layer shape) and SQLite's raw 0/1 integers (the repository-row
 * shape). Anything else — a string, null, a float — is rejected outright
 * rather than silently coerced.
 *
 * @param {*} value
 * @returns {boolean}
 */
function isValidEnabledField(value) {
  return value === true || value === false || value === 1 || value === 0;
}

/**
 * Create one direct-child directory per enabled category inside a project
 * directory. The project directory itself must already exist and must not
 * be a symlink. Disabled categories are skipped. Does NOT create placeholder
 * files — only empty directories.
 *
 * @param {string} projectDir - Resolved absolute path to project directory
 * @param {Array<{directory_slug?: string, directorySlug?: string, enabled?: boolean|number}>} categories -
 *   Ordered project-owned category records (or an explicitly mapped
 *   storage-safe shape with the same field names)
 * @throws {StorageError} if the path is invalid, is a symlink, a slug is
 *   unsafe, or a directory cannot be created
 */
export function createProjectCategoryDirs(projectDir, categories) {
  let stats;
  try {
    stats = fs.lstatSync(projectDir);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new StorageError('Project directory does not exist.');
    }
    throw new StorageError(`Cannot access project directory "${path.basename(projectDir)}".`);
  }

  if (!stats.isDirectory()) {
    throw new StorageError('Project directory is not a directory.');
  }
  if (stats.isSymbolicLink()) {
    throw new StorageError(
      'Project directory is a symbolic link. Refusing to create subdirectories.'
    );
  }

  if (!Array.isArray(categories)) {
    throw new StorageError('Category collection must be an array.');
  }

  // Preflight the COMPLETE category set — including disabled entries — as a
  // single invariant, before creating anything. A disabled category with an
  // unsafe slug, or a duplicate slug shared by any combination of enabled
  // and disabled entries, must reject the whole set; otherwise the
  // filesystem and the manifest (which independently rejects duplicates)
  // could disagree about whether the category set is even valid.
  const seenSlugs = new Set();
  for (const category of categories) {
    const slug = category.directory_slug ?? category.directorySlug;
    assertSafeCategorySlug(slug);

    if (!isValidEnabledField(category.enabled)) {
      throw new StorageError('Category "enabled" field must be a boolean.');
    }

    const slugKey = slug.toLowerCase();
    if (seenSlugs.has(slugKey)) {
      throw new StorageError(`Duplicate category directory slug "${slug}".`);
    }
    seenSlugs.add(slugKey);
  }

  const enabledCategories = categories.filter(
    (category) => category.enabled === true || category.enabled === 1
  );

  for (const category of enabledCategories) {
    const slug = category.directory_slug ?? category.directorySlug;
    const subPath = path.join(projectDir, slug);
    // Belt-and-suspenders: the slug checks above already rule out
    // separators/traversal, but confirm the resolved path really is a
    // single direct child of projectDir before creating anything.
    if (path.dirname(subPath) !== projectDir) {
      throw new StorageError(`Category directory slug "${slug}" is not a safe direct child.`);
    }

    try {
      fs.mkdirSync(subPath, { recursive: true });
    } catch (err) {
      throw new StorageError(
        `Failed to create project category directory "${slug}".`
      );
    }
  }
}

// ─── Ownership verification ──────────────────────────────────────────────

/**
 * Verify that a directory name matches the expected project ID.
 *
 * The directory name must start with `<zero-padded-id>-`, where the ID is
 * zero-padded to at least 6 digits. This matches {@link formatProjectDirName}.
 *
 * @param {string} projectDir - Resolved absolute path to project directory
 * @param {number} expectedId - Expected project ID
 * @returns {boolean}
 */
export function verifyProjectDirOwnership(projectDir, expectedId) {
  const dirName = path.basename(projectDir);
  const expectedPrefix = String(expectedId).padStart(6, '0');
  return dirName.startsWith(expectedPrefix + '-');
}

// ─── Safe cleanup ────────────────────────────────────────────────────────

/**
 * Safely remove an empty project directory after verifying:
 *
 * 1. Path is contained within PROJECTS_ROOT.
 * 2. Directory name matches the expected project ID.
 * 3. Target exists, is a directory, and is NOT a symbolic link.
 * 4. Directory is empty (`rmSync` with `recursive: false`).
 *
 * No-op if the directory does not exist (ENOENT).
 *
 * @param {string} projectDir - Resolved absolute path to project directory
 * @param {number} expectedId - Expected project ID for ownership verification
 * @param {string} projectsRoot - Absolute path to PROJECTS_ROOT
 * @throws {StorageError} if any safety check fails or removal fails
 */
export function removeProjectDir(projectDir, expectedId, projectsRoot) {
  const normalizedRoot = path.resolve(projectsRoot);
  const resolved = path.resolve(projectDir);

  if (!isContained(normalizedRoot, resolved)) {
    throw new StorageError('Cannot remove a directory outside PROJECTS_ROOT.');
  }

  if (!verifyProjectDirOwnership(resolved, expectedId)) {
    throw new StorageError(
      `Project directory "${path.basename(resolved)}" does not match expected ID ${expectedId}.`
    );
  }

  let stats;
  try {
    stats = fs.lstatSync(resolved);
  } catch (err) {
    if (err.code === 'ENOENT') return; // Nothing to clean up
    throw new StorageError(
      `Cannot access "${path.basename(resolved)}".`
    );
  }

  if (!stats.isDirectory()) {
    throw new StorageError(
      `"${path.basename(resolved)}" is not a directory.`
    );
  }
  if (stats.isSymbolicLink()) {
    throw new StorageError(
      `"${path.basename(resolved)}" is a symbolic link. Refusing to remove.`
    );
  }

  // Check emptiness explicitly: fs.rmSync with recursive: false may reject
  // directories altogether depending on the platform/Node.js version.
  const contents = fs.readdirSync(resolved);
  if (contents.length > 0) {
    throw new StorageError(
      `Project directory "${path.basename(resolved)}" is not empty. Refusing to remove.`
    );
  }

  try {
    fs.rmSync(resolved, { recursive: true, force: true });
  } catch (err) {
    throw new StorageError(
      `Failed to remove project directory "${path.basename(resolved)}".`
    );
  }
}

// ─── Same-filesystem rename ──────────────────────────────────────────────

/**
 * Rename or move a project directory within the same filesystem.
 *
 * - Uses `fs.renameSync` (atomic on the same filesystem).
 * - If the rename would cross filesystem boundaries (EXDEV), fails safely
 *   with a clear error. Does NOT implement recursive copy-and-delete.
 *
 * @param {string} oldPath - Current absolute path
 * @param {string} newPath - Target absolute path
 * @throws {StorageError} if the rename fails or crosses filesystems
 */
export function renameProjectDirSync(oldPath, newPath) {
  try {
    fs.renameSync(oldPath, newPath);
  } catch (err) {
    if (err.code === 'EXDEV') {
      throw new StorageError(
        'Cannot move project directory across filesystems. Use a rename within the same filesystem.'
      );
    }
    throw new StorageError(
      `Failed to move directory "${path.basename(oldPath)}" to "${path.basename(newPath)}".`
    );
  }
}
