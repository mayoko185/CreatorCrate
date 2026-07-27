import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { StorageError } from './path-manager.js';

export const MANIFEST_FILENAME = 'project.json';

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
 * Serialize a ProjectRecord (from repository) into a manifest object.
 *
 * The manifest uses camelCase JSON fields per the CreatorCrate schema.
 * Tags is always an empty array; thumbnail is always null for now.
 *
 * @param {object} project - ProjectRecord with snake_case database fields
 * @returns {object} Manifest object (camelCase fields)
 */
export function serializeManifest(project) {
  return {
    schemaVersion: 1,
    id: project.id,
    title: project.title,
    slug: project.slug,
    status: project.status,
    priority: project.priority,
    description: project.description ?? '',
    notes: project.notes ?? '',
    tags: [],
    createdAt: formatDate(project.created_at),
    updatedAt: formatDate(project.updated_at),
    plannedDate: formatDate(project.planned_date),
    publishedDate: formatDate(project.published_date),
    patreonUrl: project.patreon_url ?? null,
    thumbnail: null,
  };
}

/**
 * Deserialize a manifest object back into a plain data object
 * with snake_case keys matching the ProjectRecord shape.
 *
 * @param {object} manifest - Parsed manifest object (camelCase fields)
 * @returns {object} Data object with snake_case keys
 */
export function deserializeManifest(manifest) {
  return {
    id: manifest.id,
    title: manifest.title,
    slug: manifest.slug,
    status: manifest.status,
    priority: manifest.priority,
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
 * 1. Serialize the project to a manifest object.
 * 2. Write to a temporary file in the same project directory.
 * 3. Flush (fsync) and close the temporary file.
 * 4. Rename the temporary file to project.json (atomic on same filesystem).
 * 5. If any step fails, clean up the temporary file.
 *
 * @param {string} projectDir - Resolved absolute path to the project directory
 * @param {object} project - ProjectRecord from the repository
 * @param {string} projectsRoot - Absolute path to PROJECTS_ROOT (for safe error messages)
 * @throws {StorageError} if the directory is invalid or writing fails
 */
export function writeManifestSync(projectDir, project, projectsRoot) {
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
  const manifest = serializeManifest(project);
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
