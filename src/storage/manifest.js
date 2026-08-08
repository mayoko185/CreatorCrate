import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { StorageError } from './path-manager.js';

export const MANIFEST_FILENAME = 'project.json';

export const MANIFEST_SCHEMA_VERSION = 3;

const DISPLAY_NAME_MIN = 1;
const DISPLAY_NAME_MAX = 100;

// Portable single-segment slug: lowercase alphanumeric, hyphen-separated.
// Case-only and control/space/dot variants of "project.json" and Windows
// reserved device names all fail this pattern already; the reserved-name
// set below catches names that are otherwise pattern-valid.
const DIRECTORY_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const RESERVED_DEVICE_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/**
 * Validate a manifest category's directorySlug against the portable
 * single-segment slug policy. Returns an error message, or null if valid.
 */
function validateManifestSlug(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return 'must be a non-empty string';
  }
  if (!DIRECTORY_SLUG_PATTERN.test(value)) {
    return 'must be lowercase alphanumeric segments separated by single hyphens';
  }
  if (RESERVED_DEVICE_NAMES.has(value.toUpperCase())) {
    return 'must not be a reserved device name';
  }
  return null;
}

const CATEGORY_REQUIRED_KEYS = ['displayName', 'directorySlug', 'displayOrder', 'enabled'];

/**
 * Validate a manifest's `assetCategories` array in full: shape, exact
 * per-category field set, slug policy, boolean enabled, and display orders
 * forming a contiguous, duplicate-free 0..n-1 sequence. Duplicate directory
 * slugs (case-insensitive) are also rejected.
 *
 * @param {*} categories - The manifest's assetCategories value
 * @throws {StorageError} on any structural violation
 */
function validateAssetCategoriesArray(categories) {
  if (!Array.isArray(categories)) {
    throw new StorageError('Manifest "assetCategories" must be an array.');
  }

  const seenSlugs = new Set();
  const orders = [];

  categories.forEach((category, index) => {
    if (category == null || typeof category !== 'object' || Array.isArray(category)) {
      throw new StorageError(`Manifest asset category at index ${index} is malformed.`);
    }

    const keys = Object.keys(category).sort();
    const expectedKeys = [...CATEGORY_REQUIRED_KEYS].sort();
    const hasExactKeys = keys.length === expectedKeys.length &&
      keys.every((key, i) => key === expectedKeys[i]);
    if (!hasExactKeys) {
      throw new StorageError(
        `Manifest asset category at index ${index} must contain exactly ` +
        `${CATEGORY_REQUIRED_KEYS.join(', ')}.`
      );
    }

    const { displayName, directorySlug, displayOrder, enabled } = category;

    const trimmedName = typeof displayName === 'string' ? displayName.trim() : '';
    if (trimmedName.length < DISPLAY_NAME_MIN || trimmedName.length > DISPLAY_NAME_MAX ||
      typeof displayName !== 'string') {
      throw new StorageError(
        `Manifest asset category at index ${index} has an invalid display name.`
      );
    }

    const slugError = validateManifestSlug(directorySlug);
    if (slugError) {
      throw new StorageError(
        `Manifest asset category at index ${index} has an invalid directory slug: ${slugError}.`
      );
    }

    if (typeof enabled !== 'boolean') {
      throw new StorageError(
        `Manifest asset category at index ${index} has a non-boolean "enabled" value.`
      );
    }

    if (!Number.isInteger(displayOrder) || displayOrder < 0) {
      throw new StorageError(
        `Manifest asset category at index ${index} has an invalid display order.`
      );
    }

    const slugKey = directorySlug.toLowerCase();
    if (seenSlugs.has(slugKey)) {
      throw new StorageError(
        `Manifest contains a duplicate directory slug "${directorySlug}".`
      );
    }
    seenSlugs.add(slugKey);
    orders.push(displayOrder);
  });

  const sortedOrders = [...orders].sort((a, b) => a - b);
  for (let i = 0; i < sortedOrders.length; i++) {
    if (sortedOrders[i] !== i) {
      throw new StorageError(
        'Manifest asset category display orders must form a contiguous 0..n-1 sequence with no duplicates.'
      );
    }
  }
}

/**
 * The single authoritative manifest validator. Every direct manifest-read
 * acceptance path (deserialization, ownership checks, update preflight)
 * must call this instead of inspecting manifest fields ad hoc.
 *
 * Validates schema version, required project identity fields (id, slug),
 * and the complete assetCategories contract. Does not compare identity
 * fields against a specific expected project — callers do that afterward.
 *
 * @param {*} manifest - Parsed manifest object
 * @returns {object} The same manifest object, once fully validated
 * @throws {StorageError} on any structural violation
 */
export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new StorageError('Manifest is not a valid object.');
  }
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new StorageError(
      `Unsupported manifest schema version: ${manifest.schemaVersion}.`
    );
  }
  if (!Number.isInteger(manifest.id) || manifest.id <= 0) {
    throw new StorageError('Manifest is missing a valid project id.');
  }
  if (typeof manifest.slug !== 'string' || manifest.slug.length === 0) {
    throw new StorageError('Manifest is missing a valid project slug.');
  }
  if (Object.prototype.hasOwnProperty.call(manifest, 'categories')) {
    throw new StorageError('Manifest must not contain the obsolete "categories" property.');
  }
  if (Object.prototype.hasOwnProperty.call(manifest, 'status')) {
    throw new StorageError('Manifest must not contain the obsolete "status" property.');
  }
  if (!Object.prototype.hasOwnProperty.call(manifest, 'assetCategories')) {
    throw new StorageError('Manifest is missing the required "assetCategories" property.');
  }
  validateAssetCategoriesArray(manifest.assetCategories);

  return manifest;
}

// ─── Internal helpers ────────────────────────────────────────────────────

/**
 * Format a date value to ISO 8601 with milliseconds and UTC suffix.
 *
 * Handles two input formats from the database:
 *   - SQLite datetime:  "YYYY-MM-DD HH:MM:SS"  →  "YYYY-MM-DDTHH:MM:SS.000Z"
 *   - Date-only:        "YYYY-MM-DD"            →  "YYYY-MM-DDT00:00:00.000Z"
 *
 * @param {string|null} value
 * @returns {string|null}
 */
function formatDate(value) {
  if (value == null) return null;
  const str = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return str + 'T00:00:00.000Z';
  }
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(str)) {
    return str.replace(' ', 'T') + '.000Z';
  }
  return str;
}

/**
 * Generate a hex string for temporary file naming.
 * @returns {string}
 */
function randomHex() {
  return crypto.randomBytes(6).toString('hex');
}

/**
 * Build a temporary filename that does not look like a valid manifest.
 * Format: .{hex}.project.json.tmp
 * @returns {string}
 */
function tempFilename() {
  return `.${randomHex()}.project.json.tmp`;
}

/**
 * Map project-owned or default asset-category rows (snake_case DB shape)
 * into the portable manifest shape. Deliberately excludes database IDs,
 * project-category IDs, default/source relationships, and timestamps.
 *
 * @param {Array<object>} categories - Rows with display_name, directory_slug,
 *   display_order, enabled (0/1 or boolean)
 * @returns {Array<{displayName: string, directorySlug: string, displayOrder: number, enabled: boolean}>}
 */
function serializeCategories(categories) {
  return categories.map((category) => ({
    displayName: category.display_name,
    directorySlug: category.directory_slug,
    displayOrder: category.display_order,
    enabled: category.enabled === true || category.enabled === 1,
  }));
}

// ─── Date conversion (reverse) ───────────────────────────────────────────

/**
 * Convert an ISO 8601 date string back to SQLite-compatible format.
 *
 *   "YYYY-MM-DDTHH:MM:SS.000Z"     → "YYYY-MM-DD HH:MM:SS"
 *   "YYYY-MM-DDT00:00:00.000Z"     → "YYYY-MM-DD"           (date-only round-trip)
 *   null                            → null
 *
 * The date-only round-trip ensures that planned_date / published_date
 * (stored as "YYYY-MM-DD" in the database) survive serialize→deserialize.
 *
 * @param {string|null} value
 * @returns {string|null}
 */
function parseDate(value) {
  if (value == null) return null;
  const str = String(value).replace('T', ' ');
  const trimmed = str.replace(/\.\d+Z$/, '');
  // If the time component is midnight, return date-only to satisfy
  // database CHECK constraints (planned_date LIKE '____-__-__').
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)) {
    const time = trimmed.slice(11);
    if (time === '00:00:00') return trimmed.slice(0, 10);
  }
  return trimmed;
}

// ─── Serialization ───────────────────────────────────────────────────────

/**
 * Serialize a ProjectRecord (from repository) into a schema-version-3
 * manifest object.
 *
 * The manifest uses camelCase JSON fields per the CreatorCrate schema.
 * Tags is always an empty array; thumbnail is always null for now.
 *
 * Project workflow status is deliberately excluded: it exists only as
 * application/UI/database metadata and must never be serialized into the
 * manifest.
 *
 * @param {object} project - ProjectRecord with snake_case database fields
 * @param {Array<object>} [categories] - Project-owned asset-category rows
 *   (snake_case DB shape), in deterministic project-category order
 * @returns {object} Manifest object (camelCase fields)
 */
export function serializeManifest(project, categories = []) {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    id: project.id,
    title: project.title,
    slug: project.slug,
    description: project.description ?? '',
    notes: project.notes ?? '',
    tags: [],
    createdAt: formatDate(project.created_at),
    updatedAt: formatDate(project.updated_at),
    plannedDate: formatDate(project.planned_date),
    publishedDate: formatDate(project.published_date),
    patreonUrl: project.patreon_url ?? null,
    thumbnail: null,
    assetCategories: serializeCategories(categories),
  };
}

/**
 * Deserialize a schema-version-3 manifest object back into a plain data
 * object with snake_case keys matching the ProjectRecord shape.
 *
 * Rejects any manifest whose schemaVersion is not exactly 3 — there is no
 * schema-version-1 or -2 compatibility or conversion.
 *
 * Project workflow status is deliberately absent from the result: it is
 * application/database metadata and is never restored from the filesystem
 * manifest.
 *
 * @param {object} manifest - Parsed manifest object (camelCase fields)
 * @returns {object} Data object with snake_case keys
 * @throws {StorageError} if the manifest schema version is not supported
 */
export function deserializeManifest(manifest) {
  validateManifest(manifest);
  return {
    id: manifest.id,
    title: manifest.title,
    slug: manifest.slug,
    description: manifest.description ?? '',
    notes: manifest.notes ?? '',
    tags: manifest.tags ?? [],
    created_at: parseDate(manifest.createdAt),
    updated_at: parseDate(manifest.updatedAt),
    planned_date: parseDate(manifest.plannedDate),
    published_date: parseDate(manifest.publishedDate),
    patreon_url: manifest.patreonUrl ?? null,
    thumbnail: manifest.thumbnail ?? null,
  };
}

/**
 * Format a manifest object as a JSON string with 2-space indentation
 * and a trailing newline.
 *
 * @param {object} manifest - Manifest object
 * @returns {string} Formatted JSON string
 */
export function formatManifestJson(manifest) {
  return JSON.stringify(manifest, null, 2) + '\n';
}

// ─── Atomic write ────────────────────────────────────────────────────────

/**
 * Atomically write a manifest file for a project.
 *
 * Strategy:
 * 1. Serialize the project (and its current categories) to a manifest object.
 * 2. Write to a temporary file in the same project directory.
 * 3. Flush (fsync) and close the temporary file.
 * 4. Rename the temporary file to project.json (atomic on same filesystem).
 * 5. If any step fails, clean up the temporary file.
 *
 * @param {string} projectDir - Resolved absolute path to the project directory
 * @param {object} project - ProjectRecord from the repository
 * @param {string} projectsRoot - Absolute path to PROJECTS_ROOT (for safe error messages)
 * @param {Array<object>} [categories] - Project-owned asset-category rows,
 *   in deterministic project-category order
 * @throws {StorageError} if the directory is invalid or writing fails
 */
export function writeManifestSync(projectDir, project, projectsRoot, categories = []) {
  // ── Pre-check: verify projectDir is a real, non-symlink directory ──
  let stats;
  try {
    stats = fs.lstatSync(projectDir);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new StorageError(
        `Cannot write manifest: "${path.basename(projectDir)}" does not exist.`
      );
    }
    throw new StorageError(
      `Cannot access "${path.basename(projectDir)}".`
    );
  }

  if (!stats.isDirectory()) {
    throw new StorageError(
      `Cannot write manifest: "${path.basename(projectDir)}" is not a directory.`
    );
  }

  if (stats.isSymbolicLink()) {
    throw new StorageError(
      `Cannot write manifest: "${path.basename(projectDir)}" is a symbolic link.`
    );
  }

  // ── Serialize ──
  const manifest = serializeManifest(project, categories);
  const content = formatManifestJson(manifest);
  const manifestPath = path.join(projectDir, MANIFEST_FILENAME);
  const tempName = tempFilename();
  const tempPath = path.join(projectDir, tempName);

  // ── Safe relative path for error messages ──
  const safeRelPath = buildSafeRelPath(projectsRoot, projectDir);

  // ── Atomic write: temp → fsync → rename ──
  let fd;
  try {
    fd = fs.openSync(tempPath, 'w');
    fs.writeSync(fd, content, 0, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    fs.renameSync(tempPath, manifestPath);
  } catch (err) {
    // Clean up temp file if it exists
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    try { fs.rmSync(tempPath, { force: true }); } catch { /* ignore */ }

    if (err instanceof StorageError) throw err;
    throw new StorageError(
      `Failed to write manifest for project ${project.id} (${safeRelPath}).`
    );
  }
}

/**
 * Build a safe relative path for error messages, falling back
 * to the directory basename if the path escapes projectsRoot.
 *
 * @param {string} projectsRoot
 * @param {string} projectDir
 * @returns {string}
 */
function buildSafeRelPath(projectsRoot, projectDir) {
  try {
    const rel = path.relative(projectsRoot, projectDir);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      return rel;
    }
  } catch { /* fall through */ }
  return path.basename(projectDir);
}

// ─── Read / Remove ──────────────────────────────────────────────────────

/**
 * Read and parse the manifest file from a project directory.
 * Returns null if the file does not exist.
 *
 * @param {string} projectDir - Resolved absolute path to the project directory
 * @returns {object|null} The parsed manifest object (camelCase fields), or null
 * @throws {StorageError} if the file exists but is unreadable or invalid
 */
export function readManifestSync(projectDir) {
  const manifestPath = path.join(projectDir, MANIFEST_FILENAME);

  let content;
  try {
    content = fs.readFileSync(manifestPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new StorageError(
      `Failed to read manifest from "${path.basename(projectDir)}".`
    );
  }

  try {
    return JSON.parse(content);
  } catch (err) {
    throw new StorageError(
      `Invalid manifest in "${path.basename(projectDir)}".`
    );
  }
}

/**
 * Remove the manifest file from a project directory.
 * No-op if the file does not exist.
 *
 * @param {string} projectDir - Resolved absolute path to the project directory
 * @throws {StorageError} if the file exists and cannot be removed
 */
export function removeManifestSync(projectDir) {
  const manifestPath = path.join(projectDir, MANIFEST_FILENAME);
  try {
    fs.rmSync(manifestPath, { force: true });
  } catch (err) {
    throw new StorageError(
      `Failed to remove manifest from "${path.basename(projectDir)}".`
    );
  }
}

// ─── Temp-file identification ────────────────────────────────────────────

const TEMP_FILE_RE = /^\.[a-f0-9]{12}\.project\.json\.tmp$/;

/**
 * Check whether a filename looks like a manifest temporary file.
 * Useful for future reconciliation to ignore temp files.
 *
 * @param {string} name - Filename (basename only, not a path)
 * @returns {boolean}
 */
export function isManifestTempFile(name) {
  return TEMP_FILE_RE.test(name);
}
