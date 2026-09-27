/**
 * Legacy `project.json` manifest support.
 *
 * SQLite is the sole runtime authority for project and category metadata.
 * CreatorCrate no longer creates, requires, reads, or rewrites project.json
 * during normal operation. What remains here is the legacy format's
 * definition — parsing, validation, and deterministic serialization — kept
 * for the legacy manifest cleanup lifecycle (PM-2), which removes only
 * manifests proven redundant (see `describeLegacyManifestDivergence`).
 * Nothing in this module is called on a normal request path. The other
 * runtime reader, `readLegacyManifestEvidence`, serves only one-time project
 * ownership adoption (PM-1C1) and reports nothing but the manifest's ID.
 */
import fs from 'node:fs';
import path from 'node:path';
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
 * The single authoritative legacy-manifest validator. Every direct
 * manifest-read acceptance path (deserialization, legacy manifest cleanup)
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
 * @param {string|null} value
 * @returns {string|null}
 */
function parseDate(value) {
  if (value == null) return null;
  const str = String(value).replace('T', ' ');
  const trimmed = str.replace(/\.\d+Z$/, '');
  // Preserve the established reverse conversion for supported v3 timestamp
  // fields when a manifest carries an ISO midnight value.
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

// ─── One-time upgrade evidence (PM-1C1) ─────────────────────────────────

/** Larger manifests are rejected as malformed without being read. */
export const LEGACY_MANIFEST_EVIDENCE_MAX_BYTES = 1024 * 1024;

const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

/**
 * Inspect a legacy `project.json` solely as upgrade evidence of which project
 * a directory was historically associated with. Used only by project
 * ownership adoption; nothing here is imported into SQLite, and the file is
 * never written, renamed, or removed.
 *
 * Result classes:
 * - `{ status: 'valid', projectId }` — a regular non-symlink file that parses
 *   and passes {@link validateManifest}; only its ID is reported, because
 *   every other (possibly stale) field is irrelevant to ownership.
 * - `{ status: 'missing' }` — no manifest entry exists.
 * - `{ status: 'unsafe' }` — a symlink, directory, or other non-regular
 *   entry, or an entry that changed while being read.
 * - `{ status: 'unsupported' }` — valid JSON object with an unsupported
 *   `schemaVersion`.
 * - `{ status: 'malformed' }` — oversized, unparsable, or failing validation.
 * - `{ status: 'unreadable', code }` — an I/O or permission failure (for
 *   example an unavailable share). Uncertainty, never evidence.
 *
 * Never throws for filesystem conditions.
 *
 * @param {string} projectDir - Absolute, already safety-checked project directory
 */
export function readLegacyManifestEvidence(projectDir) {
  const manifestPath = path.join(projectDir, MANIFEST_FILENAME);
  let before;
  try {
    before = fs.lstatSync(manifestPath, { bigint: true });
  } catch (err) {
    if (err.code === 'ENOENT') return { status: 'missing' };
    return { status: 'unreadable', code: err.code ?? null };
  }
  if (before.isSymbolicLink() || !before.isFile()) return { status: 'unsafe' };
  if (before.size > BigInt(LEGACY_MANIFEST_EVIDENCE_MAX_BYTES)) return { status: 'malformed' };

  let content;
  let fd;
  try {
    try {
      fd = fs.openSync(manifestPath, fs.constants.O_RDONLY | O_NOFOLLOW);
    } catch (err) {
      if (err.code === 'ENOENT') return { status: 'missing' };
      if (err.code === 'ELOOP') return { status: 'unsafe' };
      return { status: 'unreadable', code: err.code ?? null };
    }
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      return { status: 'unsafe' };
    }
    const buffer = Buffer.alloc(LEGACY_MANIFEST_EVIDENCE_MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = fs.readSync(fd, buffer, length, buffer.length - length, length);
      if (read === 0) break;
      length += read;
    }
    if (length > LEGACY_MANIFEST_EVIDENCE_MAX_BYTES) return { status: 'malformed' };
    content = buffer.subarray(0, length).toString('utf8');
  } catch (err) {
    return { status: 'unreadable', code: err.code ?? null };
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* read already complete or failed */ }
    }
  }

  const parsed = parseLegacyManifestContent(content);
  return parsed.status === 'valid' ? { status: 'valid', projectId: parsed.manifest.id } : parsed;
}

/**
 * Parse and validate legacy manifest text with the established legacy rules.
 *
 * @param {string} content
 * @returns {{ status: 'valid', manifest: object } | { status: 'unsupported' } | { status: 'malformed' }}
 */
export function parseLegacyManifestContent(content) {
  let manifest;
  try {
    manifest = JSON.parse(content);
  } catch {
    return { status: 'malformed' };
  }
  if (manifest && typeof manifest === 'object' && !Array.isArray(manifest)
    && manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    return { status: 'unsupported' };
  }
  try {
    validateManifest(manifest);
  } catch {
    return { status: 'malformed' };
  }
  return { status: 'valid', manifest };
}

// ─── Redundancy comparison (PM-2) ───────────────────────────────────────

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Whether `value` is a real instant in exactly the legacy serializer's
 * `YYYY-MM-DDTHH:mm:ss.SSSZ` form. The shape alone is not enough: an
 * impossible month/day/time (`2025-99-99T99:99:99.000Z`, `2025-02-30…`)
 * would still sort as "older". It must parse and serialize back to the
 * identical string, so nothing JavaScript normalizes to another date passes.
 * @returns {boolean}
 */
function isCanonicalLegacyTimestamp(value) {
  if (typeof value !== 'string' || !ISO_TIMESTAMP_RE.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

/**
 * Decide whether a validated legacy manifest is exactly the snapshot the
 * legacy serializer ({@link serializeManifest}) would produce for the current
 * SQLite project row and its project-owned categories — i.e. whether it
 * holds nothing SQLite does not.
 *
 * The comparison follows the old writer's real semantics:
 * - the manifest must carry exactly the serializer's key set (an unexpected
 *   extra or missing field is a divergence);
 * - `id`, `title`, `slug`, `description`, `notes`, `patreonUrl`, `createdAt`
 *   and every `assetCategories` entry (name, slug, order, enabled, in
 *   order) must equal the serializer's output;
 * - `tags` must be the serializer's `[]` placeholder and `thumbnail` its
 *   `null` placeholder — they never represented modern tags or primary
 *   images, so any other value is unexpected and divergent;
 * - `updatedAt` must equal the serializer's value, or be an older timestamp
 *   of the same exact format. The legacy writer did not rewrite the
 *   manifest for status/type/archive changes that still bumped the row's
 *   `updated_at`, and the manifest's `updatedAt` was never read back as
 *   authority, so a lagging mirror carries no business data. Both values
 *   must be canonical real timestamps ({@link isCanonicalLegacyTimestamp});
 *   a newer, impossible, non-canonical or differently formatted value is
 *   divergent.
 *
 * Returns only a field name, never a value, so callers can log it safely.
 *
 * @param {object} manifest - Already validated by {@link validateManifest}
 * @param {object} project - Current ProjectRecord (snake_case)
 * @param {Array<object>} categories - Current project-owned category rows
 * @returns {string|null} the first divergent field, or null when equivalent
 */
export function describeLegacyManifestDivergence(manifest, project, categories) {
  const expected = serializeManifest(project, categories);
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(manifest).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, i) => key !== expectedKeys[i])) {
    return 'fields';
  }
  for (const key of ['schemaVersion', 'id', 'title', 'slug', 'description', 'notes', 'createdAt', 'patreonUrl', 'thumbnail']) {
    if (manifest[key] !== expected[key]) return key;
  }
  if (!Array.isArray(manifest.tags) || manifest.tags.length !== 0) return 'tags';
  if (manifest.updatedAt !== expected.updatedAt) {
    const older = isCanonicalLegacyTimestamp(manifest.updatedAt)
      && isCanonicalLegacyTimestamp(expected.updatedAt)
      && Date.parse(manifest.updatedAt) < Date.parse(expected.updatedAt);
    if (!older) return 'updatedAt';
  }
  const actualCategories = manifest.assetCategories;
  const expectedCategories = expected.assetCategories;
  if (actualCategories.length !== expectedCategories.length) return 'assetCategories';
  for (let i = 0; i < expectedCategories.length; i++) {
    const a = actualCategories[i];
    const e = expectedCategories[i];
    if (a.displayName !== e.displayName || a.directorySlug !== e.directorySlug
      || a.displayOrder !== e.displayOrder || a.enabled !== e.enabled) {
      return 'assetCategories';
    }
  }
  return null;
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
