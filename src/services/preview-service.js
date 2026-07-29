import fs from 'node:fs';
import path from 'node:path';
import { openAssetFile, closeAssetFile } from '../storage/asset-file.js';
import {
  THUMBNAIL_FILENAME,
  PREVIEW_FILENAME,
  META_FILENAME,
  DERIVATIVE_CONFIG_VERSION,
  buildRevisionToken,
  ensureCacheDir,
  serializeMeta,
  readMetaFile,
  compareFreshness,
  atomicWriteBuffer,
  atomicWriteMeta,
  validateWebpFile,
  getDerivativeBytes,
  makeStagingDir,
  buildRevisionDirName,
  writeCurrentPointer,
  resolvePublishedDir,
  removeDirTree,
  PreviewCacheError,
} from '../storage/preview-cache.js';

// ─── Format allowlist ────────────────────────────────────────────────────
//
// Only formats explicitly verified to work with the Sharp pipeline are
// previewable. Unknown binary formats (Krita, PSD, arbitrary blobs) are NOT
// decoded even when the database MIME type happens to look like an image;
// the extension AND recorded MIME must both be on the allowlist.

const SUPPORTED_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);

const EXTENSION_TO_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

const SUPPORTED_MIMES = new Set(Object.values(EXTENSION_TO_MIME));

/**
 * Decide whether an asset record is previewable based on BOTH its extension
 * and recorded MIME type. The database MIME is never trusted alone — a
 * mismatch yields unsupported.
 *
 * @param {{ extension: string, mime_type: string }} asset
 * @returns {{ supported: boolean, extension: string, mimeType: string }}
 */
export function classifyPreviewable(asset) {
  const ext = String(asset.extension || '').toLowerCase();
  const mime = String(asset.mime_type || '').toLowerCase();
  const extSupported = SUPPORTED_EXTENSIONS.has(ext);
  const mimeSupported = SUPPORTED_MIMES.has(mime);
  const supported = extSupported && mimeSupported && EXTENSION_TO_MIME[ext] === mime;
  return { supported, extension: ext, mimeType: mime };
}

// ─── Service errors ──────────────────────────────────────────────────────

export class PreviewError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PreviewError';
  }
}

export class PreviewAccessError extends PreviewError {
  constructor(message) {
    super(message);
    this.name = 'PreviewAccessError';
  }
}

export class PreviewGenerationError extends PreviewError {
  constructor(message) {
    super(message);
    this.name = 'PreviewGenerationError';
  }
}

export class PreviewNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PreviewNotFoundError';
    this.status = 404;
  }
}

// ─── Derivative configuration ────────────────────────────────────────────

const THUMBNAIL_MAX = 256;
const PREVIEW_MAX = 1600;
const THUMBNAIL_QUALITY = 80;
const PREVIEW_QUALITY = 90;

/**
 * Detect whether a source is animated by reading its metadata WITHOUT the
 * `animated:true` flag. Sharp still reports `pages` for animated inputs when
 * probed this way (verified on Sharp 0.35.3 / libvips 8.18.3). For non-animated
 * inputs pages is 1 (or undefined, coerced to 1).
 *
 * @param {import('sharp').Sharp} pipeline
 * @returns {Promise<{animated: boolean, frameCount: number}>}
 */
async function detectAnimation(pipeline) {
  const meta = await pipeline.metadata();
  const pages = meta.pages ?? 1;
  return { animated: pages > 1, frameCount: pages };
}

/**
 * Build a Sharp pipeline for a derivative.
 *
 * Pipeline (applied in order):
 *   1. autoOrient()  — apply EXIF orientation, then strip the Orientation tag.
 *   2. resize({ fit: inside, withoutEnlargement: true }) — preserve aspect,
 *      never enlarge.
 *   3. webp({ quality }) — output WebP, strip source metadata (Sharp strips
 *      all non-pixel metadata by default unless keepMetadata() is called).
 *
 * Animation handling:
 *   - thumbnail: first frame only (open without `animated:true`).
 *   - preview: preserve animation when the source is animated, by opening
 *     with `animated:true`. Verified reliable on the supported Sharp/libvips
 *     combination; if animated output were unreliable we would return an
 *     unsupported-preview result instead of silently flattening.
 *
 * @param {Buffer|string} input
 * @param {{ width: number, height: number, quality: number, animated: boolean }} opts
 * @returns {Promise<import('sharp').Sharp>}
 */
async function buildDerivativePipeline(input, { width, height, quality, animated }) {
  const sh = await sharp();
  const ctorOpts = animated ? { animated: true } : {};
  return (
    sh(input, ctorOpts)
      .autoOrient()
      .resize({
        width,
        height,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality })
  );
}

// Lazy sharp import keeps the service importable without the native addon
// loaded at module-eval time (matches preview-cache.js).
let _sharp = null;
async function sharp() {
  if (_sharp) return _sharp;
  _sharp = (await import('sharp')).default;
  return _sharp;
}

// ─── In-process generation locks ─────────────────────────────────────────
//
// Keyed SOLELY by (projectId, assetId). Every cache-writing operation for a
// given asset — thumbnail or preview, any server revision, any client
// requestedRevision — shares ONE in-flight promise. This guarantees:
//
//   - A concurrent thumbnail and preview request for the same asset join the
//     same generation instead of racing two `generateBoth`-equivalent passes.
//   - Client-supplied revision strings never influence write-lock identity,
//     so arbitrary `?v=` tokens cannot fragment the lock or bypass the
//     per-asset serialization.
//   - Different assets keep independent keys and generate concurrently.
//
// Locks clear on both success and failure. Because all read-and-write access
// for an asset funnels through `withLock`, a reader that arrives while a write
// is in progress simply joins the in-flight operation's result rather than
// observing a half-published cache.

/** @type {Map<string, Promise<unknown>>} */
const locks = new Map();

function lockKey(projectId, assetId) {
  return `${projectId}:${assetId}`;
}

/**
 * Serialize cache operations for one asset as an async queue. Each caller
 * runs its OWN function (so a thumbnail caller and a preview caller each
 * receive the correct kind-specific result), but no two run concurrently:
 * callers chain onto the previous operation's tail.
 *
 * This guarantees that a concurrent thumbnail and preview request for the
 * same asset do not race two generations — the first regenerates (if needed)
 * and the second observes the freshly published cache and returns a fresh
 * hit. Identical concurrent calls likewise serialize: the first generates,
 * the rest probe and hit.
 *
 * The tail promise never rejects (rejections are swallowed before chaining)
 * so one failed operation never poisons the queue. Each completed tail
 * removes itself from the map when it is still the queue's last entry, so
 * the map drains to empty once all operations for an asset settle.
 *
 * @template T
 * @param {number} projectId
 * @param {number} assetId
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function withLock(projectId, assetId, fn) {
  const key = lockKey(projectId, assetId);
  const prev = locks.get(key) || Promise.resolve();
  // Chain after the previous operation settles; swallow its rejection so a
  // prior failure does not prevent this operation from running.
  const run = prev.catch(() => {}).then(() => fn());
  // Store a never-rejecting tail for the next waiter.
  const tail = run.then(() => {}, () => {});
  tail.finally(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  locks.set(key, tail);
  return run;
}

// Exposed for tests: verify the lock map is empty between operations.
export function _lockCountForTests() {
  return locks.size;
}

// ─── Freshness context ───────────────────────────────────────────────────

/**
 * Build the current scanned-source freshness context for an asset. Recorded
 * modification time is normalized to ISO 8601 so it is comparable against
 * the value stored in meta.json (also ISO 8601).
 *
 * @param {object} asset
 * @returns {{ projectId: number, assetId: number, relativePath: string, size: number, mtime: string }}
 */
function sourceContext(asset) {
  return {
    projectId: asset.project_id,
    assetId: asset.id,
    relativePath: asset.relative_path,
    size: asset.size_bytes,
    mtime: normalizeMtime(asset.modified_at),
  };
}

/**
 * Normalize a SQLite stored modification time to ISO 8601 with milliseconds
 * and a Z suffix, matching the format written into meta.json.
 *
 *   "YYYY-MM-DD HH:MM:SS"   → "YYYY-MM-DDTHH:MM:SS.000Z"
 *   "YYYY-MM-DDTHH:MM:SS.000Z" → unchanged
 *   null / ""               → ""
 */
function normalizeMtime(value) {
  if (value == null) return '';
  const str = String(value);
  if (str === '') return '';
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(str)) {
    return str.replace(' ', 'T') + '.000Z';
  }
  return str;
}

// ─── Service factory ─────────────────────────────────────────────────────

/**
 * @typedef {Object} PreviewServiceDeps
 * @property {import('better-sqlite3').Database} db
 * @property {string} projectsRoot
 * @property {string} previewRoot
 * @property {Object} [_hooks] - Test-only injection points. Never set in
 *   production. Each hook may throw to simulate a failure at that stage, or
 *   return a Promise to gate generation timing for deterministic concurrency
 *   tests. Recognized hooks: onStagingCreated, beforeThumbTransform,
 *   beforeThumbValidate, beforePreviewTransform, beforePreviewValidate,
 *   beforeMetaWrite, beforeStagedSetValidate, beforePublishRecheck,
 *   beforePublishRename, beforePointerWrite.
 */

/**
 * Create a preview service.
 *
 * @param {PreviewServiceDeps} deps
 */
export function createPreviewService({ db, projectsRoot, previewRoot, _hooks } = {}) {
  const projectRepo = createProjectRepository(db);
  const assetRepo = createAssetRepository(db);
  const hooks = _hooks || {};

  /**
   * Run a test-only hook by name. In production `hooks` is empty and every
   * call is a no-op. A hook that throws propagates as a generation-stage
   * failure; a hook that returns a Promise is awaited (timing gate).
   */
  async function runHook(name, ...args) {
    const hook = hooks[name];
    if (typeof hook === 'function') await hook(...args);
  }

  // ── ID validation ───────────────────────────────────────────────────

  function validateId(id, label) {
    if (!Number.isInteger(id) || id <= 0) {
      throw new PreviewAccessError(`Invalid ${label}.`);
    }
  }

  /**
   * Load a project, verify ownership of the asset (asset.project_id matches),
   * and return the project + asset records. Throws PreviewNotFoundError when
   * the project or asset does not exist, or PreviewError when the asset does
   * not belong to the project.
   */
  function loadProjectAndAsset(projectId, assetId) {
    validateId(projectId, 'project id');
    validateId(assetId, 'asset id');

    const project = projectRepo.findById(projectId);
    if (!project) throw new PreviewNotFoundError('Project not found.');
    if (!project.project_dir) {
      throw new PreviewNotFoundError('Project directory is not initialized.');
    }

    const asset = assetRepo.findById(assetId);
    if (!asset) throw new PreviewNotFoundError('Asset not found.');
    if (asset.project_id !== projectId) {
      throw new PreviewAccessError('Asset does not belong to project.');
    }
    if (!asset.is_present) {
      throw new PreviewNotFoundError('Asset is not present on disk.');
    }

    return { project, asset };
  }

  // ── Original descriptor ─────────────────────────────────────────────

  /**
   * Return a descriptor of the original source asset without generating any
   * derivative. Useful for clients that want to link to the source file
   * directly through a later route.
   *
   * Phase 10.1C: also returns `projectDir` (the trusted relative project
   * directory path) and `filename` (the basename of the asset's relative
   * path) so the media service can open the original through `openAssetFile`
   * without re-resolving the project record. Both fields are derived from
   * already-validated data; no extra DB or filesystem work is done here.
   *
   * @param {number} projectId
   * @param {number} assetId
   * @returns {{ status: 'ready'|'unsupported'|'missing', projectId: number, assetId: number, projectDir: string, relativePath: string, filename: string, extension: string, mimeType: string, size: number, mtime: string, revision: string, previewable: boolean }}
   */
  function getOriginalDescriptor(projectId, assetId) {
    const { project, asset } = loadProjectAndAsset(projectId, assetId);
    const ctx = sourceContext(asset);
    const revision = buildRevisionToken(ctx);
    const { supported, mimeType } = classifyPreviewable(asset);

    return {
      status: supported ? 'ready' : 'unsupported',
      projectId: asset.project_id,
      assetId: asset.id,
      projectDir: project.project_dir,
      relativePath: asset.relative_path,
      filename: asset.filename,
      extension: String(asset.extension || '').toLowerCase(),
      mimeType,
      size: asset.size_bytes,
      mtime: ctx.mtime,
      revision,
      previewable: supported,
    };
  }

  // ── Cache validation helpers ────────────────────────────────────────

  /**
   * Validate that a derivative file on disk exists, has the byte size
   * recorded in meta, and decodes as WebP. Returns { valid, reason }.
   *
   * @param {string} filePath
   * @param {{ width: number, height: number, bytes: number }} expected
   * @param {boolean} expectAnimated
   * @returns {Promise<{ valid: boolean, reason?: string, info?: object }>}
   */
  async function validateExistingDerivative(filePath, expected, expectAnimated) {
    const size = getDerivativeBytes(filePath);
    if (size == null) return { valid: false, reason: 'missing' };
    if (size !== expected.bytes) {
      return { valid: false, reason: 'size mismatch' };
    }
    try {
      const info = await validateWebpFile(filePath);
      if (info.width !== expected.width || info.height !== expected.height) {
        return { valid: false, reason: 'dimensions mismatch', info };
      }
      if (info.animated !== expectAnimated) {
        return { valid: false, reason: 'animation mismatch', info };
      }
      return { valid: true, info };
    } catch (err) {
      return { valid: false, reason: `not decodable: ${err.message}` };
    }
  }

  /**
   * Try to load and fully validate an existing cache entry for the given
   * derivative type. Returns { state, path, meta, info } where state is one
   * of: 'fresh', 'stale', 'corrupt', 'absent'.
   *
   * @param {number} projectId
   * @param {number} assetId
   * @param {object} currentCtx      - sourceContext(asset)
   * @param {'thumbnail'|'preview'} kind
   */
  async function probeCacheEntry(projectId, assetId, currentCtx, kind) {
    // Readers resolve ONLY a complete, published cache revision via the
    // current.json pointer. Staged (tmp-*/) files are never visible here.
    const dir = resolvePublishedDir(previewRoot, projectId, assetId);
    if (!dir) {
      return { state: 'absent' };
    }
    const metaPath = path.join(dir, META_FILENAME);
    const filename = kind === 'thumbnail' ? THUMBNAIL_FILENAME : PREVIEW_FILENAME;
    const filePath = path.join(dir, filename);

    const metaResult = readMetaFile(metaPath);
    if (!metaResult.ok) {
      return { state: 'corrupt', dir, filePath };
    }
    const meta = metaResult.meta;

    const freshness = compareFreshness(meta, currentCtx);
    if (!freshness.fresh) {
      return { state: 'stale', dir, filePath, meta, reasons: freshness.reasons };
    }

    const derivativeMeta = kind === 'thumbnail' ? meta.thumbnail : meta.preview;
    const expectAnimated =
      kind === 'preview' && meta.animated === true;
    const validation = await validateExistingDerivative(
      filePath,
      derivativeMeta,
      expectAnimated
    );
    if (!validation.valid) {
      return {
        state: 'corrupt',
        dir,
        filePath,
        meta,
        reason: validation.reason,
      };
    }

    return {
      state: 'fresh',
      dir,
      filePath,
      meta,
      info: validation.info,
    };
  }

  // ── Generation ──────────────────────────────────────────────────────

  /**
   * Read source bytes through the safe resolver and return a Buffer plus the
   * opened descriptor's stat (for source-integrity assertions). Source bytes
   * and mtime are never mutated.
   *
   * @param {object} project
   * @param {object} asset
   * @returns {{ buffer: Buffer, mtime: Date }}
   */
  function readSourceBytes(project, asset) {
    const opened = openAssetFile(
      projectsRoot,
      project.project_dir,
      asset.relative_path
    );
    try {
      // stat.mtime is a Date from fstat on the opened descriptor.
      const mtime = opened.stat.mtime;
      // Read from the already-opened descriptor, NOT from the path. This
      // closes the TOCTOU window: the validated descriptor is the only
      // thing we read from, so a path swap between open and read cannot
      // cause us to read a different file.
      const buffer = fs.readFileSync(opened.handle);
      return { buffer, mtime };
    } finally {
      closeAssetFile(opened);
    }
  }

  /**
   * Generate a single derivative from source bytes into a Buffer plus
   * decoded metadata.
   *
   * @param {Buffer} sourceBuffer
   * @param {'thumbnail'|'preview'} kind
   * @param {boolean} sourceAnimated
   * @returns {Promise<{ buffer: Buffer, width: number, height: number, animated: boolean, frameCount: number }>}
   */
  async function generateDerivative(sourceBuffer, kind, sourceAnimated) {
    const config =
      kind === 'thumbnail'
        ? { width: THUMBNAIL_MAX, height: THUMBNAIL_MAX, quality: THUMBNAIL_QUALITY }
        : { width: PREVIEW_MAX, height: PREVIEW_MAX, quality: PREVIEW_QUALITY };

    // Thumbnail: first frame only. Sharp without `animated:true` reads only
    // the first frame of an animated input.
    const animated = kind === 'preview' && sourceAnimated;

    const pipeline = await buildDerivativePipeline(sourceBuffer, { ...config, animated });
    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });

    // For animated output, Sharp reports the stacked height in info.height
    // but the per-frame height in info.pageHeight. The width/height we record
    // is the per-frame (displayed) dimension.
    const outAnimated = (info.pages ?? 1) > 1;
    const outWidth = info.width;
    const outHeight = outAnimated ? (info.pageHeight ?? info.height) : info.height;

    return {
      buffer: data,
      width: outWidth,
      height: outHeight,
      animated: outAnimated,
      frameCount: info.pages ?? 1,
    };
  }

  /**
   * Write a derivative buffer into the staging directory using the storage
   * atomic-write (temp + fsync + rename). Validation is a separate step
   * (validateDerivative) so failures can be injected between write and
   * validate for deterministic testing, and so a failed validation leaves
   * the staging file to be cleaned up with the whole staging directory.
   *
   * @param {string} stagingDir
   * @param {string} filename
   * @param {Buffer} buffer
   * @returns {string} final path inside the staging directory
   */
  function writeDerivative(stagingDir, filename, buffer) {
    return atomicWriteBuffer(stagingDir, filename, buffer);
  }

  /**
   * Validate a single staged derivative file as readable WebP whose byte
   * size and dimensions match the recorded metadata.
   *
   * @param {string} filePath
   * @param {{ width: number, height: number, bytes: number }} expected
   * @param {boolean} expectAnimated
   * @returns {Promise<{ info: object }>}
   * @throws {PreviewError} on any mismatch.
   */
  async function validateDerivative(filePath, expected, expectAnimated) {
    const size = getDerivativeBytes(filePath);
    if (size == null) throw new PreviewGenerationError('Staged derivative is missing.');
    if (size !== expected.bytes) {
      throw new PreviewGenerationError('Staged derivative byte size mismatch.');
    }
    let info;
    try {
      info = await validateWebpFile(filePath);
    } catch (err) {
      throw new PreviewGenerationError(`Staged derivative is not decodable WebP: ${err.message}`);
    }
    if (info.bytes !== expected.bytes) {
      throw new PreviewGenerationError('Staged derivative byte size mismatch after decode.');
    }
    if (info.width !== expected.width || info.height !== expected.height) {
      throw new PreviewGenerationError('Staged derivative dimensions mismatch.');
    }
    if (info.animated !== expectAnimated) {
      throw new PreviewGenerationError('Staged derivative animation mismatch.');
    }
    return { info };
  }

  /**
   * Cross-validate the COMPLETE staged set (thumbnail + preview + meta) so
   * that the meta describes exactly the staged derivatives and the recorded
   * source revision. Only a fully consistent staged set may be published.
   *
   * @param {string} stagingDir
   * @param {object} meta - serialized meta describing the staged set
   * @returns {Promise<void>}
   * @throws {PreviewError} on any inconsistency.
   */
  async function validateStagedSet(stagingDir, meta) {
    await validateDerivative(
      path.join(stagingDir, THUMBNAIL_FILENAME),
      meta.thumbnail,
      false // thumbnails are always first-frame / static
    );
    await validateDerivative(
      path.join(stagingDir, PREVIEW_FILENAME),
      meta.preview,
      kindPreviewAnimated(meta) // preview preserves animation when recorded
    );

    // Re-read the staged meta.json and confirm it describes the same set.
    const metaRes = readMetaFile(path.join(stagingDir, META_FILENAME));
    if (!metaRes.ok) {
      throw new PreviewGenerationError('Staged meta.json is missing or malformed.');
    }
    const staged = metaRes.meta;
    if (
      staged.thumbnail.bytes !== meta.thumbnail.bytes ||
      staged.thumbnail.width !== meta.thumbnail.width ||
      staged.thumbnail.height !== meta.thumbnail.height ||
      staged.preview.bytes !== meta.preview.bytes ||
      staged.preview.width !== meta.preview.width ||
      staged.preview.height !== meta.preview.height ||
      staged.source.size !== meta.source.size ||
      staged.source.mtime !== meta.source.mtime ||
      staged.source.relativePath !== meta.source.relativePath ||
      staged.animated !== meta.animated ||
      staged.frameCount !== meta.frameCount
    ) {
      throw new PreviewGenerationError('Staged meta.json does not describe the staged derivatives.');
    }
  }

  /**
   * @returns {boolean}
   */
  function kindPreviewAnimated(meta) {
    return Boolean(meta && meta.animated === true);
  }

  /**
   * Recompute the authoritative source revision for an asset from a fresh DB
   * read. Returns null when the asset is gone or marked not-present, so the
   * caller can treat it as "source moved on" rather than trusting stale
   * context captured before the lock.
   *
   * @param {number} assetId
   * @returns {string|null}
   */
  function currentRevisionFor(assetId) {
    const fresh = assetRepo.findById(assetId);
    if (!fresh || !fresh.is_present) return null;
    return buildRevisionToken(sourceContext(fresh));
  }

  /**
   * Stage a COMPLETE cache set (thumbnail + preview + meta) for the
   * currently authoritative revision, validate it, then publish it
   * atomically via the current.json pointer.
   *
   * Contract:
   *   - The authoritative (project, asset) record is reloaded from the DB at
   *     the start of every attempt; context captured before acquiring the
   *     per-asset lock is never trusted as the generation source.
   *   - All writes target a unique tmp-<rand>/ staging directory inside the
   *     per-asset cache root. The prior published cache (an immutable
   *     revision directory referenced by current.json) is never mutated during
   *     staging.
   *   - Immediately before publishing, the source revision is re-read and
   *     compared to the revision being generated. If the source moved on,
   *     the staged output is DISCARDED and the operation retries once
   *     against the new revision. An older generation therefore can never
   *     overwrite a newer cache.
   *   - Publication is: rename staging → r-<rev>-<rand> (immutable dir), then
   *     atomically replace current.json. A failure between the rename and
   *     the pointer write removes the orphaned revision directory so no
   *     staged output survives a failed publication.
   *
   * On any failure the staging directory (or orphaned revision directory) is
   * removed and the previously published cache is left byte-for-byte
   * unchanged.
   *
   * @param {number} projectId
   * @param {number} assetId
   * @returns {Promise<{ thumbnailPath: string, previewPath: string, meta: object, revision: string }>}
   * @throws {PreviewError} if the source changed during both attempts and no
   *   consistent cache could be published.
   */
  async function generateAndPublish(projectId, assetId) {
    for (let attempt = 0; attempt < 2; attempt++) {
      // Reload authoritative project + asset inside the lock for THIS attempt.
      const { project, asset } = loadProjectAndAsset(projectId, assetId);
      const ctxNow = sourceContext(asset);
      const revNow = buildRevisionToken(ctxNow);

      const parentDir = ensureCacheDir(previewRoot, projectId, assetId);
      const staging = makeStagingDir(parentDir);
      await runHook('onStagingCreated', staging.dirName);

      // Track whether staging was promoted to a revision directory so the
      // failure path knows which directory to remove.
      let renamedTo = null;
      try {
        const { buffer: sourceBuffer } = readSourceBytes(project, asset);
        let sourceAnimated;
        try {
          const sh = await sharp();
          ({ animated: sourceAnimated } = await detectAnimation(sh(sourceBuffer)));
        } catch (err) {
          throw new PreviewGenerationError('Source image cannot be decoded.');
        }

        // Thumbnail: generate, write, validate (distinct stages for hooks).
        await runHook('beforeThumbTransform');
        let thumb;
        try {
          thumb = await generateDerivative(sourceBuffer, 'thumbnail', sourceAnimated);
        } catch (err) {
          throw new PreviewGenerationError('Thumbnail generation failed.');
        }
        await runHook('beforeThumbValidate');
        writeDerivative(staging.dir, THUMBNAIL_FILENAME, thumb.buffer);
        await validateDerivative(
          path.join(staging.dir, THUMBNAIL_FILENAME),
          { width: thumb.width, height: thumb.height, bytes: thumb.buffer.length },
          false
        );

        // Preview: generate, write, validate.
        await runHook('beforePreviewTransform');
        let preview;
        try {
          preview = await generateDerivative(sourceBuffer, 'preview', sourceAnimated);
        } catch (err) {
          throw new PreviewGenerationError('Preview generation failed.');
        }
        await runHook('beforePreviewValidate');
        writeDerivative(staging.dir, PREVIEW_FILENAME, preview.buffer);
        const previewVal = await validateDerivative(
          path.join(staging.dir, PREVIEW_FILENAME),
          { width: preview.width, height: preview.height, bytes: preview.buffer.length },
          preview.animated
        );

        const thumbMeta = {
          width: thumb.width,
          height: thumb.height,
          bytes: thumb.buffer.length,
          format: 'webp',
        };
        const previewMeta = {
          width: preview.width,
          height: preview.height,
          bytes: preview.buffer.length,
          format: 'webp',
        };
        const generatedAt = new Date().toISOString();
        // animated/frameCount come from the validated preview derivative: it
        // reflects what was actually written, not just what the source claimed.
        const meta = serializeMeta({
          projectId,
          assetId,
          relativePath: ctxNow.relativePath,
          size: ctxNow.size,
          mtime: ctxNow.mtime,
          generatedAt,
          thumbnail: thumbMeta,
          preview: previewMeta,
          animated: previewVal.info.animated,
          frameCount: previewVal.info.frameCount,
        });

        await runHook('beforeMetaWrite');
        atomicWriteMeta(staging.dir, meta);

        await runHook('beforeStagedSetValidate');
        await validateStagedSet(staging.dir, meta);

        // Pre-publish recheck: verify the source revision has not moved on
        // while this generation was in flight. Context captured before the
        // lock is never trusted here.
        await runHook('beforePublishRecheck');
        const revCheck = currentRevisionFor(assetId);
        if (revCheck !== revNow) {
          // Source changed during generation. Discard the staged output and
          // retry once against the now-authoritative revision.
          removeDirTree(staging.dir);
          continue;
        }

        // Publish: promote staging to an immutable revision directory, then
        // atomically swap the pointer.
        const finalDirName = buildRevisionDirName(revNow);
        const finalDir = path.join(parentDir, finalDirName);

        await runHook('beforePublishRename');
        try {
          fs.renameSync(staging.dir, finalDir);
        } catch (err) {
          throw new PreviewCacheError('Failed to publish derivative cache.');
        }
        renamedTo = finalDir;

        await runHook('beforePointerWrite');
        writeCurrentPointer(parentDir, {
          dir: finalDirName,
          revision: revNow,
          generatedAt,
        });

        return {
          thumbnailPath: path.join(finalDir, THUMBNAIL_FILENAME),
          previewPath: path.join(finalDir, PREVIEW_FILENAME),
          meta,
          revision: revNow,
        };
      } catch (err) {
        // A failure after the rename (pointer write) leaves an orphaned
        // revision directory not referenced by the pointer; remove it so no
        // staged output survives. A failure before the rename leaves the
        // staging directory; remove that. The previously published cache is
        // untouched in either case.
        removeDirTree(renamedTo || staging.dir);
        throw err;
      }
    }

    // Both attempts observed the source moving on; refuse to publish a
    // cache for a non-authoritative revision.
    throw new PreviewGenerationError(
      'Source changed during generation; unable to publish a consistent cache.'
    );
  }

  // ── Public: getThumbnail / getPreview ───────────────────────────────

  /**
   * Shared implementation for getThumbnail and getPreview.
   *
   * Concurrency & freshness contract:
   *   - The per-asset generation lock (projectId:assetId only) serializes
   *     every cache-writing operation. The client `requestedRevision` is
   *     NEVER used for locking or freshness — it is preserved on the
   *     response so the route can pick a cache-control directive, but it has
   *     zero influence on write-lock identity or generation decisions.
   *   - Inside the lock the authoritative project/asset is reloaded from the
   *     DB, the current published cache is probed, and a fresh entry is
   *     returned without regeneration when one already exists.
   *   - Regeneration stages a complete set and publishes atomically, with a
   *     pre-publish source-revision recheck (see generateAndPublish).
   *
   * @param {'thumbnail'|'preview'} kind
   * @param {number} projectId
   * @param {number} assetId
   * @param {string} [requestedRevision] - optional, from the browser. Not authoritative.
   */
  async function getDerivative(kind, projectId, assetId, requestedRevision) {
    return withLock(projectId, assetId, async () => {
      // Reload the authoritative project + asset inside the lock.
      const { asset } = loadProjectAndAsset(projectId, assetId);
      const cls = classifyPreviewable(asset);
      if (!cls.supported) {
        return {
          status: 'unsupported',
          projectId: asset.project_id,
          assetId: asset.id,
          revision: buildRevisionToken(sourceContext(asset)),
          cacheState: 'unsupported-format',
        };
      }

      const ctx = sourceContext(asset);
      const revision = buildRevisionToken(ctx);

      const probed = await probeCacheEntry(projectId, assetId, ctx, kind);

      if (probed.state === 'fresh') {
        const meta = probed.meta;
        const d = kind === 'thumbnail' ? meta.thumbnail : meta.preview;
        return {
          status: 'ready',
          path: probed.filePath,
          mimeType: 'image/webp',
          bytes: d.bytes,
          width: d.width,
          height: d.height,
          revision,
          generatedAt: meta.generatedAt,
          cacheState: 'fresh',
          animated: kind === 'preview' && meta.animated === true,
        };
      }

      // absent | stale | corrupt → regenerate the complete set atomically.
      const result = await generateAndPublish(projectId, assetId);
      const meta = result.meta;
      const d = kind === 'thumbnail' ? meta.thumbnail : meta.preview;
      const filePath =
        kind === 'thumbnail' ? result.thumbnailPath : result.previewPath;

      return {
        status: 'ready',
        path: filePath,
        mimeType: 'image/webp',
        bytes: d.bytes,
        width: d.width,
        height: d.height,
        revision: result.revision,
        generatedAt: meta.generatedAt,
        cacheState: 'regenerated',
        animated: kind === 'preview' && meta.animated === true,
      };
    });
  }

  return {
    getThumbnail: (projectId, assetId, requestedRevision) =>
      getDerivative('thumbnail', projectId, assetId, requestedRevision),
    getPreview: (projectId, assetId, requestedRevision) =>
      getDerivative('preview', projectId, assetId, requestedRevision),
    getOriginalDescriptor,

    // Exposed for tests / inspection. Not part of the public route contract.
    _classifyPreviewable: classifyPreviewable,
    _sourceContext: (asset) => sourceContext(asset),
    _buildRevisionToken: buildRevisionToken,
  };
}

// Re-exports for tests and downstream.
export {
  SUPPORTED_EXTENSIONS,
  SUPPORTED_MIMES,
  EXTENSION_TO_MIME,
  THUMBNAIL_MAX,
  PREVIEW_MAX,
  THUMBNAIL_QUALITY,
  PREVIEW_QUALITY,
  DERIVATIVE_CONFIG_VERSION,
};

// Late imports to avoid a circular dependency at module-eval time: the
// repository modules are imported here so the rest of the file can reference
// them. They are imported once, lazily, on first service construction.
import { createProjectRepository } from '../data/project-repository.js';
import { createAssetRepository } from '../data/asset-repository.js';