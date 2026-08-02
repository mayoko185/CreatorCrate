import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ─── Cache-infrastructure error ───────────────────────────────────────────
//
// Raised by rebuildable-cache operations (directory creation, atomic
// derivative/meta/pointer writes, publication rename). These are
// infrastructure failures of the DERIVED cache, NOT of the source asset: the
// source may be perfectly readable while the cache cannot be written
// (read-only preview root, full disk, cache-directory creation failure).
//
// The media service maps this to a controlled 503 so callers retry later,
// keeping it distinct from source `StorageError` (missing/unsafe/unreadable
// source), which maps to 404. Using a typed class at the storage boundary
// avoids guessing from message text.
export class PreviewCacheError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PreviewCacheError';
  }
}

// ─── Cache layout ────────────────────────────────────────────────────────
//
// APP_DATA_ROOT/previews/projects/<project-id>/<asset-id>/ is the per-asset
// cache root (a rebuildable derived cache; no database persistence). It holds:
//
//   current.json                     — atomically replaced pointer to the
//                                      currently published revision directory.
//   r-<revision>-<rand>/             — one immutable, COMPLETE published cache
//                                      (thumbnail.webp, preview.webp, meta.json).
//   tmp-<rand>/                      — transient staging directory for the next
//                                      complete set; removed on failure.
//
// Readers resolve a cache entry by reading current.json and descending into
// the referenced revision directory. Publication swaps current.json
// atomically (temp + fsync + rename) AFTER the revision directory is fully
// written and validated, so readers observe either the complete prior cache
// or the complete new cache — never a mixed set. Stale revision directories
// accumulate as harmless derived cache; cleanup is deferred.
//
// No absolute host paths are ever stored in meta.json or current.json.

export const META_FILENAME = 'meta.json';
export const THUMBNAIL_FILENAME = 'thumbnail.webp';
export const PREVIEW_FILENAME = 'preview.webp';
export const CURRENT_POINTER_FILENAME = 'current.json';

/**
 * Schema/cache-format version of meta.json. Bumped only when the on-disk
 * metadata shape changes in a way that should invalidate every prior entry.
 */
export const CACHE_SCHEMA_VERSION = 1;

/**
 * Derivative configuration version. Bumped when the resize/quality/orient
 * pipeline changes so that all existing derivatives are regenerated.
 */
export const DERIVATIVE_CONFIG_VERSION = 1;

/**
 * Schema version of current.json. Bumped only when the pointer file shape
 * changes in a way that should invalidate every prior pointer.
 */
export const POINTER_SCHEMA_VERSION = 1;

/**
 * Result of probing a single derivative file on disk.
 *
 * @typedef {Object} DerivativeFileInfo
 * @property {boolean} exists
 * @property {number} bytes      - File size in bytes (0 if missing).
 * @property {string|null} sha   - sha256 of file bytes (null if missing/unreadable).
 */

// ─── Path resolution ─────────────────────────────────────────────────────

/**
 * Resolve the cache directory for a project/asset pair.
 *
 * @param {string} previewRoot - Absolute path to APP_DATA_ROOT/previews.
 * @param {number} projectId
 * @param {number} assetId
 * @returns {string} Absolute cache directory path.
 */
export function getCacheDir(previewRoot, projectId, assetId) {
  return path.join(previewRoot, 'projects', String(projectId), String(assetId));
}

/**
 * Resolve the meta.json path for a project/asset pair.
 */
export function getMetaPath(previewRoot, projectId, assetId) {
  return path.join(getCacheDir(previewRoot, projectId, assetId), META_FILENAME);
}

/**
 * Resolve a derivative path by filename ("thumbnail.webp" or "preview.webp").
 */
export function getDerivativePath(previewRoot, projectId, assetId, filename) {
  return path.join(getCacheDir(previewRoot, projectId, assetId), filename);
}
/**
 * Inspect every existing component beneath a trusted cache root without
 * following symbolic links. Missing components are reported separately so
 * callers that create cache paths can still distinguish absence from unsafe
 * storage.
 *
 * @param {string} root
 * @param {string} target
 * @param {'directory'|'file'} expectedType
 * @returns {{ ok: boolean, reason?: 'missing'|'symlink'|'not-directory'|'not-file'|'unreadable'|'containment' }}
 */
function inspectCachePath(root, target, expectedType) {
  const rootAbs = path.resolve(root);
  const targetAbs = path.resolve(target);
  const relative = path.relative(rootAbs, targetAbs);
  if (
    relative === '..' ||
    relative.startsWith('..' + path.sep) ||
    path.isAbsolute(relative)
  ) {
    return { ok: false, reason: 'containment' };
  }

  let current = rootAbs;
  const components = relative === '' ? [] : relative.split(path.sep);
  const paths = [current];
  for (const component of components) {
    current = path.join(current, component);
    paths.push(current);
  }

  for (let index = 0; index < paths.length; index++) {
    const currentPath = paths[index];
    let stats;
    try {
      stats = fs.lstatSync(currentPath);
    } catch (err) {
      if (err.code === 'ENOENT') return { ok: false, reason: 'missing' };
      return { ok: false, reason: 'unreadable' };
    }

    if (stats.isSymbolicLink()) return { ok: false, reason: 'symlink' };
    if (index < paths.length - 1 && !stats.isDirectory()) {
      return { ok: false, reason: 'not-directory' };
    }
    if (index === paths.length - 1) {
      if (expectedType === 'directory' && !stats.isDirectory()) {
        return { ok: false, reason: 'not-directory' };
      }
      if (expectedType === 'file' && !stats.isFile()) {
        return { ok: false, reason: 'not-file' };
      }
    }
  }

  return { ok: true };
}

function inspectDirectory(dir) {
  const absolute = path.resolve(dir);
  return inspectCachePath(path.parse(absolute).root, absolute, 'directory');
}

function inspectRegularFile(filePath) {
  const absolute = path.resolve(filePath);
  return inspectCachePath(path.parse(absolute).root, absolute, 'file');
}

/**
 * Ensure a cache directory exists (created recursively under previewRoot).
 *
 * @throws {PreviewCacheError} if creation fails (cache-infrastructure error).
 */
export function ensureCacheDir(previewRoot, projectId, assetId) {
  const dir = getCacheDir(previewRoot, projectId, assetId);
  const before = inspectCachePath(previewRoot, dir, 'directory');
  if (!before.ok && before.reason !== 'missing') {
    throw new PreviewCacheError('Cannot create cache directory.');
  }

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new PreviewCacheError('Cannot create cache directory.');
  }

  const after = inspectCachePath(previewRoot, dir, 'directory');
  if (!after.ok) {
    throw new PreviewCacheError('Cannot create cache directory.');
  }
  return dir;
}

// ─── Revision token ──────────────────────────────────────────────────────
//
// A deterministic, non-secret browser revision token derived from scanned
// metadata and the derivative configuration version. Used later for
// cache-aware URLs. It is NOT an authorization mechanism and NOT proof that
// a cache entry is fresh — freshness is always revalidated against the
// source. The token must not reveal absolute paths.

/**
 * Build a deterministic revision token from non-secret scanned metadata.
 *
 * Inputs (stable, lexicographic JSON serialization):
 *   - projectId
 *   - assetId
 *   - relativePath (source, relative to project dir — no host path)
 *   - size (recorded source byte size)
 *   - mtime (recorded source modification time, ISO 8601)
 *   - derivative config version
 *
 * Output: 16-char hex string (first 8 bytes of sha256).
 *
 * @param {Object} input
 * @param {number} input.projectId
 * @param {number} input.assetId
 * @param {string} input.relativePath
 * @param {number} input.size
 * @param {string} input.mtime     - ISO 8601 source mtime.
 * @returns {string}
 */
export function buildRevisionToken({ projectId, assetId, relativePath, size, mtime }) {
  const payload = {
    projectId,
    assetId,
    relativePath,
    size,
    mtime,
    derivativeConfigVersion: DERIVATIVE_CONFIG_VERSION,
  };
  const json = JSON.stringify(payload, Object.keys(payload).sort());
  return crypto.createHash('sha256').update(json).digest('hex').slice(0, 16);
}

// ─── meta.json schema ────────────────────────────────────────────────────

/**
 * Serialize a meta.json object. Field order is stable for deterministic
 * output. No absolute host paths are stored.
 *
 * @param {Object} input
 * @param {number} input.projectId
 * @param {number} input.assetId
 * @param {string} input.relativePath       - Source relative path (project-relative).
 * @param {number} input.size               - Recorded source byte size.
 * @param {string} input.mtime              - Recorded source modification time (ISO 8601).
 * @param {string} input.generatedAt        - ISO 8601 timestamp of generation.
 * @param {Object} input.thumbnail          - { width, height, bytes, format }
 * @param {Object} input.preview            - { width, height, bytes, format }
 * @param {boolean} [input.animated]        - Whether derivatives preserved animation.
 * @param {number} [input.frameCount]       - Frame count when animated.
 * @param {'merged'|'thumbnail'} [input.sourceQuality] - Embedded Krita preview quality.
 * @returns {object} Plain object to JSON.stringify.
 */
export function serializeMeta({
  projectId,
  assetId,
  relativePath,
  size,
  mtime,
  generatedAt,
  thumbnail,
  preview,
  animated,
  frameCount,
  sourceQuality,
}) {
  const meta = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    derivativeConfigVersion: DERIVATIVE_CONFIG_VERSION,
    projectId,
    assetId,
    source: {
      relativePath,
      size,
      mtime,
    },
    generatedAt,
    thumbnail: {
      width: thumbnail.width,
      height: thumbnail.height,
      bytes: thumbnail.bytes,
      format: thumbnail.format,
    },
    preview: {
      width: preview.width,
      height: preview.height,
      bytes: preview.bytes,
      format: preview.format,
    },
  };
  if (animated != null) meta.animated = animated;
  if (frameCount != null) meta.frameCount = frameCount;
  if (sourceQuality != null) meta.source.previewQuality = sourceQuality;
  return meta;
}

/**
 * Parse and structurally validate a meta.json object.
 *
 * @param {string} content - Raw file content.
 * @returns {object} Parsed meta object.
 * @throws {Error} if the content is not valid JSON or is structurally
 *   incomplete (missing required fields, wrong types).
 */
export function parseMeta(content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('meta.json is not valid JSON.');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('meta.json root is not an object.');
  }

  requireNumber(parsed, 'schemaVersion');
  requireNumber(parsed, 'derivativeConfigVersion');
  requireNumber(parsed, 'projectId');
  requireNumber(parsed, 'assetId');

  const source = parsed.source;
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    throw new Error('meta.json source is missing or not an object.');
  }
  requireString(source, 'relativePath');
  requireNumber(source, 'size');
  requireString(source, 'mtime');
  if (
    source.previewQuality != null &&
    source.previewQuality !== 'merged' &&
    source.previewQuality !== 'thumbnail'
  ) {
    throw new Error('meta.json source preview quality is invalid.');
  }

  requireString(parsed, 'generatedAt');

  for (const key of ['thumbnail', 'preview']) {
    const d = parsed[key];
    if (typeof d !== 'object' || d === null || Array.isArray(d)) {
      throw new Error(`meta.json ${key} is missing or not an object.`);
    }
    requireNumber(d, 'width');
    requireNumber(d, 'height');
    requireNumber(d, 'bytes');
    requireString(d, 'format');
  }

  return parsed;
}

function requireNumber(obj, key) {
  if (typeof obj[key] !== 'number' || !Number.isFinite(obj[key])) {
    throw new Error(`meta.json field "${key}" is missing or not a finite number.`);
  }
}

function requireString(obj, key) {
  if (typeof obj[key] !== 'string' || obj[key].length === 0) {
    throw new Error(`meta.json field "${key}" is missing or not a non-empty string.`);
  }
}

// ─── Freshness comparison ────────────────────────────────────────────────
//
// Best-effort, last-completed-scan freshness contract. Compares the scanned
// source metadata recorded in an existing meta.json against the current
// scanned source metadata. This does NOT detect same-size content changes
// with preserved modification time — exact content hashing is deferred.

/**
 * Compare a parsed meta.json against current scanned source metadata and the
 * active derivative configuration version.
 *
 * @param {object} meta           - Parsed meta.json (from parseMeta).
 * @param {Object} current
 * @param {number} current.projectId
 * @param {number} current.assetId
 * @param {string} current.relativePath
 * @param {number} current.size
 * @param {string} current.mtime
 * @returns {{ fresh: boolean, reasons: string[] }}
 */
export function compareFreshness(meta, current) {
  const reasons = [];

  if (meta.schemaVersion !== CACHE_SCHEMA_VERSION) {
    reasons.push('schemaVersion changed');
  }
  if (meta.derivativeConfigVersion !== DERIVATIVE_CONFIG_VERSION) {
    reasons.push('derivativeConfigVersion changed');
  }
  if (meta.projectId !== current.projectId) {
    reasons.push('projectId changed');
  }
  if (meta.assetId !== current.assetId) {
    reasons.push('assetId changed');
  }
  if (meta.source.relativePath !== current.relativePath) {
    reasons.push('relativePath changed');
  }
  if (meta.source.size !== current.size) {
    reasons.push('size changed');
  }
  if (meta.source.mtime !== current.mtime) {
    reasons.push('mtime changed');
  }

  return { fresh: reasons.length === 0, reasons };
}

// ─── Atomic writes ───────────────────────────────────────────────────────
//
// Each derivative is written to a unique temporary file in the destination
// directory, flushed (fsync) where practical, validated as readable WebP,
// then renamed atomically into place. meta.json is written only after all
// required derivative files are valid. On failure, temporary files are
// removed and no previously valid cache entry is replaced.

/**
 * Generate a unique temporary filename in the destination directory.
 * Format: .{12-hex}.{kind}.webp.tmp
 *
 * @param {string} baseName  - Final filename stem (e.g. "thumbnail").
 * @returns {string}
 */
function tempFilename(baseName) {
  const hex = crypto.randomBytes(6).toString('hex');
  return `.${hex}.${baseName}.webp.tmp`;
}

/**
 * Write a Buffer to a temporary file, fsync, close, and rename atomically
 * into place. Returns the final path.
 *
 * The caller is responsible for any post-rename validation; this helper only
 * guarantees the bytes are on disk and the rename is atomic.
 *
 * @param {string} dir         - Destination directory (must exist).
 * @param {string} finalName   - Final filename (e.g. "thumbnail.webp").
 * @param {Buffer} buffer      - Bytes to write.
 * @returns {string} Final path.
 * @throws {Error} on any write/fsync/rename failure. Temp file is cleaned up.
 */
export function atomicWriteBuffer(dir, finalName, buffer) {
  const directory = inspectDirectory(dir);
  if (!directory.ok) {
    throw new PreviewCacheError('Cannot write cache file.');
  }
  const finalPath = path.join(dir, finalName);
  const stem = finalName.replace(/\.webp$/, '');
  const tempPath = path.join(dir, tempFilename(stem));

  let fd;
  try {
    fd = fs.openSync(tempPath, 'w');
    fs.writeSync(fd, buffer);
    try {
      fs.fsyncSync(fd);
    } catch {
      // fsync may be unavailable on some filesystems; not fatal. The rename
      // is still atomic, and the WebP decode validation step gates success.
    }
    fs.closeSync(fd);
    fd = null;

    fs.renameSync(tempPath, finalPath);
    return finalPath;
  } catch (err) {
    if (fd != null) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
    try { fs.rmSync(tempPath, { force: true }); } catch { /* best effort */ }
    throw new PreviewCacheError(`Cannot write cache file "${finalName}".`);
  }
}

/**
 * Write meta.json atomically (temp + fsync + rename).
 *
 * @param {string} dir       - Destination directory.
 * @param {object} meta      - Meta object (from serializeMeta).
 * @returns {string} Final meta.json path.
 */
export function atomicWriteMeta(dir, meta) {
  const content = JSON.stringify(meta, null, 2) + '\n';
  return atomicWriteBuffer(dir, META_FILENAME, Buffer.from(content, 'utf8'));
}

/**
 * Remove a derivative file if it exists. Used during failure cleanup when
 * a previously valid entry must be discarded (e.g. corrupt regeneration
 * that left a partial final file). Best-effort.
 */
export function removeDerivative(dir, finalName) {
  try {
    fs.rmSync(path.join(dir, finalName), { force: true });
  } catch {
    /* best effort */
  }
}

/**
 * Remove an entire cache directory for an asset. Best-effort.
 */
export function removeCacheDir(previewRoot, projectId, assetId) {
  try {
    fs.rmSync(getCacheDir(previewRoot, projectId, assetId), {
      recursive: true,
      force: true,
    });
  } catch {
    /* best effort */
  }
}

// ─── Publication pointer & staging ───────────────────────────────────────
//
// Atomic-set publication strategy:
//
//   1. A complete cache set (thumbnail + preview + meta) is staged under a
//      unique tmp-<rand>/ directory inside the per-asset cache root.
//   2. Once the staged set is fully validated, the staging directory is
//      renamed to an immutable r-<revision>-<rand>/ directory.
//   3. current.json is written atomically (temp + fsync + rename) to point
//      at the new revision directory. This single-file atomic replacement is
//      the publication event: before it, readers see the prior complete
//      cache; after it, readers see the new complete cache.
//
// Only server-generated revision tokens are used in directory names. Client
// revision strings never influence directory or pointer identity. All paths
// produced here remain contained under previewRoot. Stale r-*/ and tmp-*/
// entries are harmless derived cache; cleanup is deferred.

const REVISION_DIR_PREFIX = 'r-';
const STAGING_DIR_PREFIX = 'tmp-';
const REVISION_TOKEN_RE = /^[0-9a-f]{16}$/;

/**
 * Resolve the current.json pointer path for a project/asset pair.
 */
export function getCurrentPointerPath(previewRoot, projectId, assetId) {
  return path.join(getCacheDir(previewRoot, projectId, assetId), CURRENT_POINTER_FILENAME);
}

/**
 * Validate that a name is a server-generated revision directory name:
 * exactly `r-<hex>-<hex>` with no path separators or traversal segments.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isValidRevisionDirName(name) {
  return typeof name === 'string' && /^r-[0-9a-f]{4,64}-[0-9a-f]{6,}$/.test(name);
}

/**
 * Validate that a name is a server-generated staging directory name:
 * exactly `tmp-<hex>`.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isValidStagingDirName(name) {
  return typeof name === 'string' && /^tmp-[0-9a-f]{6,}$/.test(name);
}

/**
 * Build a unique revision directory name from a server-generated revision
 * token plus a random uniqueness suffix: `r-<revision>-<rand>`.
 *
 * The suffix guarantees that regenerating the same revision (e.g. after a
 * derivative-config bump or a corrupt-cache repair) never has to rename over
 * an existing published directory, which is not atomic on every platform.
 *
 * @param {string} revision - server-generated revision token (16 hex chars).
 * @returns {string}
 */
export function buildRevisionDirName(revision) {
  if (!REVISION_TOKEN_RE.test(revision)) {
    throw new Error(`Invalid revision token for directory name: ${revision}`);
  }
  const rand = crypto.randomBytes(4).toString('hex');
  return `${REVISION_DIR_PREFIX}${revision}-${rand}`;
}

/**
 * Create a unique staging directory inside parentDir. The directory name is
 * server-generated (`tmp-<rand>`); callers never supply it.
 *
 * @param {string} parentDir - per-asset cache root (must exist).
 * @returns {{ dir: string, dirName: string }}
 * @throws {Error} if directory creation fails.
 */
export function makeStagingDir(parentDir) {
  if (!inspectDirectory(parentDir).ok) {
    throw new PreviewCacheError('Cannot create cache staging directory.');
  }
  const dirName = `${STAGING_DIR_PREFIX}${crypto.randomBytes(6).toString('hex')}`;
  const dir = path.join(parentDir, dirName);
  try {
    fs.mkdirSync(dir, { recursive: false });
  } catch (err) {
    throw new PreviewCacheError('Cannot create cache staging directory.');
  }
  return { dir, dirName };
}

/**
 * Read and parse current.json.
 *
 * @returns {{ ok: true, pointer: { dir: string, revision: string, generatedAt?: string } } | { ok: false, reason: string }}
 */
export function readCurrentPointer(previewRoot, projectId, assetId) {
  const pointerPath = getCurrentPointerPath(previewRoot, projectId, assetId);
  const inspection = inspectCachePath(previewRoot, pointerPath, 'file');
  if (!inspection.ok) {
    if (inspection.reason === 'missing') return { ok: false, reason: 'missing' };
    return { ok: false, reason: 'unreadable' };
  }

  let content;
  try {
    content = fs.readFileSync(pointerPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: false, reason: 'missing' };
    return { ok: false, reason: 'unreadable' };
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'malformed' };
  }
  if (parsed.schemaVersion !== POINTER_SCHEMA_VERSION) {
    return { ok: false, reason: 'schema' };
  }
  if (!isValidRevisionDirName(parsed.dir)) {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof parsed.revision !== 'string' || !REVISION_TOKEN_RE.test(parsed.revision)) {
    return { ok: false, reason: 'malformed' };
  }
  if (!parsed.dir.startsWith(`${REVISION_DIR_PREFIX}${parsed.revision}-`)) {
    return { ok: false, reason: 'malformed' };
  }
  const pointer = { dir: parsed.dir, revision: parsed.revision };
  if (typeof parsed.generatedAt === 'string') pointer.generatedAt = parsed.generatedAt;
  return { ok: true, pointer };
}

/**
 * Atomically write current.json inside parentDir (temp + fsync + rename).
 * The pointer must reference a valid server-generated revision directory.
 *
 * @param {string} parentDir - per-asset cache root.
 * @param {{ dir: string, revision: string, generatedAt?: string }} pointer
 * @returns {string} Final current.json path.
 * @throws {Error} on invalid pointer shape or write failure.
 */
export function writeCurrentPointer(parentDir, pointer) {
  if (!pointer || !isValidRevisionDirName(pointer.dir)) {
    throw new Error('Invalid revision directory in pointer.');
  }
  if (typeof pointer.revision !== 'string' || !REVISION_TOKEN_RE.test(pointer.revision)) {
    throw new Error('Invalid revision token in pointer.');
  }
  if (!pointer.dir.startsWith(`${REVISION_DIR_PREFIX}${pointer.revision}-`)) {
    throw new Error('Invalid revision directory in pointer.');
  }
  const payload = {
    schemaVersion: POINTER_SCHEMA_VERSION,
    dir: pointer.dir,
    revision: pointer.revision,
  };
  if (typeof pointer.generatedAt === 'string') payload.generatedAt = pointer.generatedAt;
  const content = JSON.stringify(payload, null, 2) + '\n';
  return atomicWriteBuffer(parentDir, CURRENT_POINTER_FILENAME, Buffer.from(content, 'utf8'));
}

/**
 * Resolve the currently-published revision directory for an asset, with a
 * defensive containment check against a tampered pointer. Returns the
 * absolute directory path, or null when the pointer is missing/malformed,
 * references an invalid name, escapes the cache root, or the directory does
 * not exist on disk.
 *
 * @returns {string|null}
 */
export function resolvePublishedDir(previewRoot, projectId, assetId) {
  const result = readCurrentPointer(previewRoot, projectId, assetId);
  if (!result.ok) return null;

  const parentDir = getCacheDir(previewRoot, projectId, assetId);
  const parentInspection = inspectCachePath(previewRoot, parentDir, 'directory');
  if (!parentInspection.ok) return null;

  const dir = path.resolve(parentDir, result.pointer.dir);
  const relative = path.relative(path.resolve(parentDir), dir);
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith('..' + path.sep) ||
    path.isAbsolute(relative) ||
    relative.includes(path.sep)
  ) {
    return null;
  }

  const revisionInspection = inspectCachePath(parentDir, dir, 'directory');
  if (!revisionInspection.ok) return null;

  for (const filename of [THUMBNAIL_FILENAME, PREVIEW_FILENAME, META_FILENAME]) {
    if (!inspectCachePath(dir, path.join(dir, filename), 'file').ok) {
      return null;
    }
  }

  return dir;
}

/**
 * Best-effort recursive removal of a directory tree. Used to discard failed
 * staging directories and orphaned revision directories.
 */
export function removeDirTree(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

// ─── WebP validation ─────────────────────────────────────────────────────

/**
 * Read a derivative file, validate that it can be decoded as WebP, and
 * return its size and a sha256 of its bytes. Used to gate the atomic rename
 * (pre-rename) and to validate existing cache entries (post-rename).
 *
 * Importing sharp lazily keeps this storage module free of a hard startup
 * dependency on the native addon; failures surface as a normal Error.
 *
 * @param {string} filePath
 * @returns {Promise<{bytes: number, sha: string, width: number, height: number, animated: boolean, frameCount: number}>}
 */
export async function validateWebpFile(filePath) {
  if (!inspectRegularFile(filePath).ok) {
    throw new Error('Derivative file is unavailable.');
  }
  const sharp = (await import('sharp')).default;
  const buffer = fs.readFileSync(filePath);
  const meta = await sharp(buffer).metadata();

  if (meta.format !== 'webp') {
    throw new Error(`Derivative is not WebP (got "${meta.format}").`);
  }

  const animated = (meta.pages ?? 1) > 1;
  const frameCount = meta.pages ?? 1;
  const width = animated ? meta.width : meta.width;
  const height = animated ? (meta.pageHeight ?? meta.height) : meta.height;

  const sha = crypto.createHash('sha256').update(buffer).digest('hex');

  return {
    bytes: buffer.length,
    sha,
    width,
    height,
    animated,
    frameCount,
  };
}

/**
 * Stat a derivative file and return its byte size, or null if missing.
 *
 * @param {string} filePath
 * @returns {number|null}
 */
export function getDerivativeBytes(filePath) {
  const inspection = inspectRegularFile(filePath);
  if (!inspection.ok) return null;
  try {
    return fs.lstatSync(filePath).size;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    return null;
  }
}

/**
 * Read and parse meta.json for a cache directory.
 *
 * @param {string} metaPath
 * @returns {{ ok: true, meta: object } | { ok: false, reason: string }}
 */
export function readMetaFile(metaPath) {
  const inspection = inspectRegularFile(metaPath);
  if (!inspection.ok) {
    if (inspection.reason === 'missing') return { ok: false, reason: 'missing' };
    return { ok: false, reason: 'unreadable' };
  }

  let content;
  try {
    content = fs.readFileSync(metaPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: false, reason: 'missing' };
    return { ok: false, reason: 'unreadable' };
  }
  try {
    const meta = parseMeta(content);
    return { ok: true, meta };
  } catch (err) {
    return { ok: false, reason: 'malformed' };
  }
}
