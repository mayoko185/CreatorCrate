import fs from 'node:fs';
import path from 'node:path';
import { createAppMetaRepository } from '../data/app-meta-repository.js';
import { createProjectImageSettingsService, validateProjectImageSetting } from './project-image-settings-service.js';
import { createProcessingConcurrencyService } from './processing-concurrency-service.js';
import {
  projectImageGeneratedOutput,
  projectImageGenerationIdentities,
  projectImagePolicyFingerprint,
  projectImagePresentationPolicy,
} from './project-image-policy.js';
import { createSourceAnimationService } from './source-animation-service.js';
import { inspectSourceAnimation } from './source-animation.js';
import { openAssetFile, closeAssetFile } from '../storage/asset-file.js';
import {
  extractKritaPreview,
  KritaPreviewExtractionError,
} from '../storage/krita-preview-extractor.js';
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
  metaSourceGeneration,
  atomicWriteBuffer,
  atomicWriteMeta,
  validateDerivativeFile,
  readDerivativeBuffer,
  removeDerivative,
  getDerivativeBytes,
  makeStagingDir,
  buildRevisionDirName,
  writeCurrentPointer,
  resolvePublishedDir,
  readCurrentPointer,
  removeDirTree,
  PreviewCacheError,
} from '../storage/preview-cache.js';

// ─── Format allowlist ────────────────────────────────────────────────────
//
// Only formats explicitly verified to work with the preview pipeline are
// previewable. The extension AND recorded MIME must both be on the allowlist;
// the MIME value is never trusted alone.

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
const KRITA_EXTENSIONS = new Set(['kra', 'krz']);
const SUPPORTED_EXTENSIONS = new Set([
  ...IMAGE_EXTENSIONS,
  ...KRITA_EXTENSIONS,
]);

const EXTENSION_TO_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  kra: 'application/x-krita',
  krz: 'application/x-krita',
};

const SUPPORTED_MIMES = new Set(Object.values(EXTENSION_TO_MIME));

/**
 * Decide whether an asset record is previewable based on BOTH its extension
 * and recorded MIME type. The database MIME is never trusted alone — a
 * mismatch yields unsupported.
 *
 * @param {{ extension: string, mime_type: string }} asset
 * @returns {{ supported: boolean, kind: 'image'|'krita'|null, extension: string, mimeType: string, mime: string }}
 */
export function classifyPreviewable(asset) {
  const ext = String(asset.extension || '').toLowerCase();
  const mime = String(asset.mime_type || '').toLowerCase();
  const kind = KRITA_EXTENSIONS.has(ext)
    ? 'krita'
    : IMAGE_EXTENSIONS.has(ext)
      ? 'image'
      : null;
  const extSupported = SUPPORTED_EXTENSIONS.has(ext);
  const mimeSupported = SUPPORTED_MIMES.has(mime);
  const supported = extSupported && mimeSupported && EXTENSION_TO_MIME[ext] === mime;
  return { supported, kind, extension: ext, mimeType: mime, mime };
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

export const IMAGE_DERIVATIVE_CONFIG = Object.freeze({
  thumbnail: Object.freeze({ width: THUMBNAIL_MAX, height: THUMBNAIL_MAX, quality: THUMBNAIL_QUALITY }),
  preview: Object.freeze({ width: PREVIEW_MAX, height: PREVIEW_MAX, quality: PREVIEW_QUALITY }),
});

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
 *   3. Encode as WebP or PNG and strip source metadata (Sharp strips
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
export async function buildDerivativePipeline(input, { width, height, quality, animated, format = 'webp' }) {
  const sh = await sharp();
  const ctorOpts = animated ? { animated: true } : {};
  const pipeline = sh(input, ctorOpts)
      .autoOrient()
      .resize({
        width,
        height,
        fit: 'inside',
        withoutEnlargement: true,
      });
  return format === 'webp' ? pipeline.webp({ quality }) : pipeline.png();
}

// Lazy sharp import keeps the service importable without the native addon
// loaded at module-eval time (matches preview-cache.js).
let _sharp = null;
async function sharp() {
  if (_sharp) return _sharp;
  _sharp = (await import('sharp')).default;
  return _sharp;
}

// Reads an opened descriptor to EOF off the event loop without closing it.
function readDescriptor(fd) {
  return new Promise((resolve, reject) => {
    fs.readFile(fd, (err, data) => (err ? reject(err) : resolve(data)));
  });
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
// Locks clear on both success and failure. A validated published pair can be
// read before the lock; only cache writes and cold/invalid reads queue here.

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
 * @returns {{ projectId: number, assetId: number, relativePath: string, size: number, mtime: string, derivativeConfigVersion: number }}
 */
function sourceContext(asset, policyFingerprint) {
  return {
    projectId: asset.project_id,
    assetId: asset.id,
    relativePath: asset.relative_path,
    size: asset.size_bytes,
    mtime: normalizeMtime(asset.modified_at),
    // Durable application source generation; rows read before the column
    // existed (or partial presentation rows) are generation 0.
    sourceGeneration: asset.source_generation ?? 0,
    derivativeConfigVersion: DERIVATIVE_CONFIG_VERSION,
    ...(policyFingerprint ? { policyFingerprint } : {}),
  };
}

function isValidAssetRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.includes('\0')) return false;
  if (path.isAbsolute(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    return false;
  }

  const normalized = path.normalize(value.replace(/[\\/]+/g, path.sep));
  if (normalized === '' || normalized === '.') return false;
  return normalized.split(path.sep)[0] !== '..';
}

function hasParseableMtime(value) {
  return typeof value === 'string'
    && value.length > 0
    && Number.isFinite(Date.parse(value));
}

function hasUsableSourceContext(ctx) {
  return Number.isInteger(ctx.projectId) && ctx.projectId > 0
    && Number.isInteger(ctx.assetId) && ctx.assetId > 0
    && isValidAssetRelativePath(ctx.relativePath)
    && Number.isFinite(ctx.size) && ctx.size >= 0
    && hasParseableMtime(ctx.mtime)
    && Number.isSafeInteger(ctx.sourceGeneration) && ctx.sourceGeneration >= 0
    && Number.isInteger(ctx.derivativeConfigVersion)
    && ctx.derivativeConfigVersion === DERIVATIVE_CONFIG_VERSION;
}

/**
 * Build the canonical Phase 10.1 source revision descriptor for a scanned asset
 * record when all metadata required by the freshness contract is valid.
 * Returns null instead of inventing a revision from incomplete or invalid data.
 *
 * @param {object} asset
 * @returns {{ context: object, revision: string }|null}
 */
export function buildAssetRevision(asset, policyFingerprint) {
  const context = sourceContext(asset, policyFingerprint);
  if (!hasUsableSourceContext(context)) return null;
  return { context, revision: buildRevisionToken(context) };
}

/**
 * Build the canonical Phase 10.1 source revision token for a scanned asset.
 *
 * @param {object} asset
 * @returns {string|null}
 */
export function buildAssetRevisionToken(asset, policyFingerprint) {
  return buildAssetRevision(asset, policyFingerprint)?.revision ?? null;
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
 * @property {Object} [processingConcurrencyService] - the shared processing
 *   pool; only actual derivative generation acquires a permit from it.
 * @property {Object} [_hooks] - Test-only injection points. Never set in
 *   production. Each hook may throw to simulate a failure at that stage, or
 *   return a Promise to gate generation timing for deterministic concurrency
 *   tests. Recognized hooks: onStagingCreated, beforeThumbTransform,
 *   beforeThumbValidate, beforePreviewTransform, beforePreviewValidate,
 *   beforeMetaWrite, beforeStagedSetValidate, beforePublishRecheck,
 *   beforePublishRename, beforePointerWrite, beforeDerivativeReuse(kind),
 *   onDerivativeStaged(kind, 'encoded'|'reused'),
 *   beforePresentationSourceProof(kind).
 */

/**
 * Create a preview service.
 *
 * @param {PreviewServiceDeps} deps
 */
export function createPreviewService({ db, projectsRoot, previewRoot, projectImageSettingsService,
  processingConcurrencyService, _hooks } = {}) {
  // Actual derivative generation is admitted through the shared processing
  // pool; direct callers without one still receive a service-owned pool.
  const processingPool = processingConcurrencyService || createProcessingConcurrencyService();
  if (typeof processingPool.run !== 'function') {
    throw new TypeError('createPreviewService requires a processing pool with run().');
  }
  const projectRepo = createProjectRepository(db);
  const assetRepo = createAssetRepository(db);
  const hooks = _hooks || {};
  const sourceAnimation = createSourceAnimationService({
    assetRepository: assetRepo, projectRepository: projectRepo, projectsRoot,
  });
  const imageSettings = projectImageSettingsService || createProjectImageSettingsService({
    appMetaRepository: createAppMetaRepository(db),
    sourceAnimationService: sourceAnimation,
  });
  const currentPolicy = () => imageSettings.getPolicy();
  const presentationPolicy = (policy) => imageSettings.getPresentationPolicy?.(policy)
    ?? projectImagePresentationPolicy(policy);
  const resolvedIdentity = (policy, asset) => {
    const presentation = presentationPolicy(policy);
    const resolved = presentation.resolveAsset?.(asset) ?? asset;
    return { asset: resolved, fingerprint: projectImagePolicyFingerprint(policy, resolved) };
  };
  function validatedTargetPolicy(policy) {
    if (!policy || !policy.thumbnail || !policy.preview) {
      throw new TypeError('Target image policy is required.');
    }
    return {
      thumbnail: {
        format: validateProjectImageSetting('thumbnailFormat', policy.thumbnail.format),
        webpQuality: validateProjectImageSetting('thumbnailWebpQuality', policy.thumbnail.webpQuality),
        maxDimension: validateProjectImageSetting('thumbnailMaxDimension', policy.thumbnail.maxDimension),
      },
      preview: {
        format: validateProjectImageSetting('previewFormat', policy.preview.format),
        webpQuality: validateProjectImageSetting('previewWebpQuality', policy.preview.webpQuality),
        maxDimension: validateProjectImageSetting('previewMaxDimension', policy.preview.maxDimension),
      },
    };
  }

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
   * @returns {{ status: 'ready'|'unsupported'|'missing', projectId: number, assetId: number, projectDir: string, relativePath: string, filename: string, extension: string, mimeType: string, size: number, mtime: string, revision: string|null, previewable: boolean }}
   */
  function getOriginalDescriptor(projectId, assetId) {
    const { project, asset } = loadProjectAndAsset(projectId, assetId);
    const ctx = sourceContext(asset);
    const revision = buildAssetRevision(asset)?.revision ?? null;
    const classification = classifyPreviewable(asset);
    const { supported, mimeType } = classification;
    const originalSupported = supported && classification.kind === 'image';

    return {
      status: originalSupported ? 'ready' : 'unsupported',
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

  /**
   * Inspect one KRA source for primary-image eligibility without generating or
   * publishing a derivative. The existing extractor remains the single ZIP
   * reader; only its bounded embedded-preview result is used here.
   *
   * @param {object} project - already-authorized project record
   * @param {object} asset - already-authorized asset record
   * @returns {Promise<{ quality: 'merged'|'thumbnail'|null, entryName?: string }>}
   */
  async function inspectKritaPreviewSource(project, asset) {
    const projectId = typeof project === 'object' ? project?.id : project;
    const assetId = asset?.id;
    if (!Number.isInteger(projectId) || !Number.isInteger(assetId)) {
      return { quality: null };
    }

    // Re-read both records inside the per-asset lock so a POST cannot probe a
    // stale path or project summary after a scan/rename has changed the DB.
    const projectRecord = projectRepo.findById(projectId);
    const currentAsset = assetRepo.findById(assetId);
    if (
      !projectRecord
      || !projectRecord.project_dir
      || !currentAsset
      || currentAsset.project_id !== projectRecord.id
      || !currentAsset.is_present
      || !projectsRoot
    ) {
      return { quality: null };
    }

    const classification = classifyPreviewable(currentAsset);
    if (
      !classification.supported
      || classification.kind !== 'krita'
      || classification.extension !== 'kra'
    ) {
      return { quality: null };
    }

    const opened = openAssetFile(projectsRoot, projectRecord.project_dir, currentAsset.relative_path);
    try {
      try {
        const extracted = await extractKritaPreview(opened, {
          extension: classification.extension,
        });
        return {
          quality: extracted.quality,
          entryName: extracted.entryName,
        };
      } catch (err) {
        if (err instanceof KritaPreviewExtractionError) {
          return { quality: null };
        }
        throw err;
      }
    } finally {
      closeAssetFile(opened);
    }
  }

  // ── Cache validation helpers ────────────────────────────────────────

  /**
   * Validate that a derivative file on disk exists, has the byte size
   * recorded in meta, and decodes in its recorded format. Returns { valid, reason }.
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
      const info = await validateDerivativeFile(filePath, expected.format || 'webp');
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
  async function probeCacheEntry(projectId, assetId, currentCtx, kind, allowPolicyFallback = false) {
    // Readers resolve ONLY a complete, published cache revision via the
    // current.json pointer. Staged (tmp-*/) files are never visible here.
    const dir = resolvePublishedDir(previewRoot, projectId, assetId);
    if (!dir) {
      return { state: 'absent' };
    }
    const metaPath = path.join(dir, META_FILENAME);
    const metaResult = readMetaFile(metaPath);
    if (!metaResult.ok) {
      return { state: 'corrupt', dir };
    }
    const meta = metaResult.meta;
    const derivativeMeta = kind === 'thumbnail' ? meta.thumbnail : meta.preview;
    const filename = derivativeMeta.filename || (kind === 'thumbnail' ? THUMBNAIL_FILENAME : PREVIEW_FILENAME);
    const filePath = path.join(dir, filename);

    const freshness = compareFreshness(meta, currentCtx);
    const policyOnly = freshness.reasons.length === 1 && freshness.reasons[0] === 'policy changed';
    if (!freshness.fresh && !(allowPolicyFallback && policyOnly)) {
      return { state: 'stale', dir, filePath, meta, reasons: freshness.reasons };
    }

    let actualRevision;
    if (policyOnly) {
      const pointer = readCurrentPointer(previewRoot, projectId, assetId);
      actualRevision = buildRevisionToken({
        projectId: meta.projectId, assetId: meta.assetId,
        relativePath: meta.source.relativePath, size: meta.source.size,
        mtime: meta.source.mtime, policyFingerprint: meta.policyFingerprint,
        sourceGeneration: metaSourceGeneration(meta),
      });
      if (!meta.policyFingerprint || !pointer.ok || path.basename(dir) !== pointer.pointer.dir
        || pointer.pointer.revision !== actualRevision) return { state: 'corrupt', dir };
    }

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

    if (policyOnly) {
      const otherKind = kind === 'thumbnail' ? 'preview' : 'thumbnail';
      const other = meta[otherKind];
      const otherPath = path.join(dir, other.filename || `${otherKind}.webp`);
      const otherValidation = await validateExistingDerivative(
        otherPath, other, otherKind === 'preview' && meta.animated === true);
      if (!otherValidation.valid) return { state: 'corrupt', dir };
    }

    return {
      state: policyOnly ? 'prior-policy' : 'fresh',
      dir,
      filePath,
      meta,
      info: validation.info,
      actualRevision,
    };
  }

  // ── Generation ──────────────────────────────────────────────────────

  function sameSourceStat(left, right) {
    return left.dev === right.dev && left.ino === right.ino
      && left.size === right.size && left.mtimeMs === right.mtimeMs
      && left.ctimeMs === right.ctimeMs;
  }

  function sourceMatches(project, asset, readStat) {
    let opened;
    try {
      opened = openAssetFile(projectsRoot, project.project_dir, asset.relative_path);
      const descriptor = fs.fstatSync(opened.handle);
      const atPath = fs.statSync(opened.absolutePath);
      return opened.stat.size === asset.size_bytes
        && opened.stat.mtime.toISOString() === normalizeMtime(asset.modified_at)
        && sameSourceStat(opened.stat, descriptor)
        && sameSourceStat(descriptor, atPath)
        && sameSourceStat(descriptor, readStat);
    } catch {
      return false;
    } finally {
      if (opened) closeAssetFile(opened);
    }
  }

  // Proves the file on disk is still the source the DB row describes (safe
  // open, size/mtime tuple, descriptor/path identity and, for GIF/WebP, the
  // known animation state) without reading it for generation. `expectedStat`,
  // when given, additionally pins the descriptor identity observed earlier.
  // `checkAnimation: false` skips the GIF/WebP structural read when the
  // caller will decode the source itself before trusting its animation.
  // Returns 'ok'; 'changed' when the disk source was observed to differ from
  // the row or the pinned instance; or 'unknown' when it could not be proven
  // either way (open/read error, unclassified or unreadable animation).
  // `detail.finalIdentityProven`, when a `detail` object is passed, is set only
  // once every identity check this proof runs has completed and passed: for a
  // GIF/WebP whose animation is inspected, that includes the descriptor/path
  // checks after the structural read. So an 'unknown' that only concerns the
  // animation state of a proven file instance (no recorded state, or a
  // structure the inspector returns as unclassified) can be told apart from
  // one where the read or a later identity check threw, which leaves the
  // source unproven.
  function sourceProof(project, asset, expectedStat = null, { checkAnimation = true, detail = null } = {}) {
    let opened;
    try {
      opened = openAssetFile(projectsRoot, project.project_dir, asset.relative_path);
      const descriptor = fs.fstatSync(opened.handle);
      const atPath = fs.statSync(opened.absolutePath);
      if (opened.stat.size !== asset.size_bytes
        || opened.stat.mtime.toISOString() !== normalizeMtime(asset.modified_at)
        || !sameSourceStat(opened.stat, descriptor)
        || !sameSourceStat(descriptor, atPath)
        || (expectedStat && !sameSourceStat(descriptor, expectedStat))) return 'changed';
      const extension = String(asset.extension || '').toLowerCase();
      if (checkAnimation && (extension === 'gif' || extension === 'webp')) {
        // Nothing is read: the checks above are the final identity proof.
        if (asset.source_animated == null) {
          if (detail) detail.finalIdentityProven = true;
          return 'unknown';
        }
        // A throw from the read or the checks after it leaves the file
        // instance unproven ('unknown' without `finalIdentityProven`).
        const animated = inspectSourceAnimation(opened.handle, extension);
        const afterRead = fs.fstatSync(opened.handle);
        const afterPath = fs.statSync(opened.absolutePath);
        if (!sameSourceStat(descriptor, afterRead) || !sameSourceStat(afterRead, afterPath)) return 'changed';
        if (detail) detail.finalIdentityProven = true;
        if (animated == null) return 'unknown';
        if (Boolean(asset.source_animated) !== animated) return 'changed';
        return 'ok';
      }
      if (detail) detail.finalIdentityProven = true;
      return 'ok';
    } catch {
      return 'unknown';
    } finally {
      if (opened) closeAssetFile(opened);
    }
  }

  function sourceAllowsFallback(project, asset, expectedStat = null, options = {}) {
    return sourceProof(project, asset, expectedStat, options) === 'ok';
  }

  /**
   * Read source bytes through the safe resolver and return a Buffer plus the
   * opened descriptor's stat (for source-integrity assertions). Source bytes
   * and mtime are never mutated.
   *
   * @param {object} project
   * @param {object} asset
   * @returns {Promise<{ buffer: Buffer, mtime: Date }>}
   */
  async function readSourceBytes(project, asset) {
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
      // cause us to read a different file. The read is asynchronous so a
      // large (or network-mounted) source never blocks the event loop.
      const buffer = await readDescriptor(opened.handle);
      const descriptor = fs.fstatSync(opened.handle);
      const atPath = fs.statSync(opened.absolutePath);
      if (!sameSourceStat(opened.stat, descriptor) || !sameSourceStat(descriptor, atPath)) {
        throw new PreviewGenerationError('Source changed while reading.');
      }
      return { buffer, mtime, stat: descriptor };
    } finally {
      closeAssetFile(opened);
    }
  }

  /**
   * Read the bytes that Sharp should use for a derivative. Ordinary images
   * retain the existing descriptor-backed byte path; Krita documents yield a
   * bounded embedded PNG while the same validated descriptor remains open.
   *
   * @param {object} project
   * @param {object} asset
   * @param {{ kind: 'image'|'krita'|null, extension: string }} classification
   * @returns {Promise<{ buffer: Buffer, mtime: Date, quality?: 'merged'|'thumbnail' }>}
   */
  async function readSourceForDerivative(project, asset, classification) {
    if (classification.kind !== 'krita') {
      return readSourceBytes(project, asset);
    }

    const opened = openAssetFile(
      projectsRoot,
      project.project_dir,
      asset.relative_path
    );
    try {
      let extracted;
      try {
        extracted = await extractKritaPreview(opened, {
          extension: classification.extension,
        });
      } catch (err) {
        if (err instanceof KritaPreviewExtractionError) {
          throw new PreviewGenerationError('Embedded preview unavailable.');
        }
        throw err;
      }

      return {
        buffer: extracted.bytes,
        mtime: opened.stat.mtime,
        quality: extracted.quality,
      };
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
  async function generateDerivative(sourceBuffer, kind, sourceAnimated, policy) {
    // Format/quality/dimension rules come from the shared policy module so the
    // encoder and the per-kind generation identity cannot drift apart.
    const output = projectImageGeneratedOutput(policy, sourceAnimated)[kind];
    const format = output.format;
    const config = { width: output.maxDimension, height: output.maxDimension, quality: output.webpQuality };

    // Thumbnail: first frame only. Sharp without `animated:true` reads only
    // the first frame of an animated input.
    const animated = kind === 'preview' && sourceAnimated;

    const pipeline = await buildDerivativePipeline(sourceBuffer, { ...config, animated, format });
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
      format,
      filename: `${kind}.${format}`,
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
   * Validate a single staged derivative file in its recorded format whose byte
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
      info = await validateDerivativeFile(filePath, expected.format || 'webp');
    } catch (err) {
      throw new PreviewGenerationError(`Staged derivative is not decodable: ${err.message}`);
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
      path.join(stagingDir, meta.thumbnail.filename || THUMBNAIL_FILENAME),
      meta.thumbnail,
      false // thumbnails are always first-frame / static
    );
    await validateDerivative(
      path.join(stagingDir, meta.preview.filename || PREVIEW_FILENAME),
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
      staged.policyFingerprint !== meta.policyFingerprint ||
      JSON.stringify(staged.generationIdentities) !== JSON.stringify(meta.generationIdentities) ||
      staged.thumbnail.filename !== meta.thumbnail.filename ||
      staged.thumbnail.format !== meta.thumbnail.format ||
      staged.preview.filename !== meta.preview.filename ||
      staged.preview.format !== meta.preview.format ||
      staged.thumbnail.bytes !== meta.thumbnail.bytes ||
      staged.thumbnail.width !== meta.thumbnail.width ||
      staged.thumbnail.height !== meta.thumbnail.height ||
      staged.preview.bytes !== meta.preview.bytes ||
      staged.preview.width !== meta.preview.width ||
      staged.preview.height !== meta.preview.height ||
      staged.source.size !== meta.source.size ||
      staged.source.mtime !== meta.source.mtime ||
      staged.source.generation !== meta.source.generation ||
      staged.source.relativePath !== meta.source.relativePath ||
      staged.source.previewQuality !== meta.source.previewQuality ||
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
   * Find derivatives of the currently published pair that the next generation
   * may copy instead of re-encoding. Every condition must hold, otherwise the
   * kind is encoded normally:
   *   - current.json and the published directory resolve to a complete pair
   *     whose pointer revision matches its own metadata;
   *   - schema/config version, project/asset identity, source path, size,
   *     mtime and source generation match the authoritative source this
   *     attempt already verified (only the policy may differ);
   *   - recorded animation matches the source classification in use;
   *   - the entry carries per-kind identities of the current identity version
   *     (legacy entries without them never qualify), and the kind's identity,
   *     format and filename match the target's effective generated output.
   * Callers restrict this to ordinary raster sources inside the asset lock.
   */
  function findReusableDerivatives(projectId, assetId, ctx, policy, targetIdentities, sourceAnimated) {
    const reusable = { thumbnail: null, preview: null };
    const dir = resolvePublishedDir(previewRoot, projectId, assetId);
    if (!dir) return reusable;
    const pointer = readCurrentPointer(previewRoot, projectId, assetId);
    const metaResult = readMetaFile(path.join(dir, META_FILENAME));
    if (!pointer.ok || path.basename(dir) !== pointer.pointer.dir || !metaResult.ok) return reusable;
    const meta = metaResult.meta;
    const freshness = compareFreshness(meta, ctx);
    if (!freshness.fresh && !(freshness.reasons.length === 1 && freshness.reasons[0] === 'policy changed')) {
      return reusable;
    }
    if (!meta.policyFingerprint || pointer.pointer.revision !== buildRevisionToken({
      projectId: meta.projectId, assetId: meta.assetId,
      relativePath: meta.source.relativePath, size: meta.source.size,
      mtime: meta.source.mtime, policyFingerprint: meta.policyFingerprint,
      sourceGeneration: metaSourceGeneration(meta),
    })) return reusable;
    const identities = meta.generationIdentities;
    if (!identities || identities.version !== targetIdentities.version) return reusable;
    if (meta.animated !== sourceAnimated || meta.source.previewQuality !== undefined) return reusable;
    const output = projectImageGeneratedOutput(policy, sourceAnimated);
    for (const kind of ['thumbnail', 'preview']) {
      const recorded = meta[kind];
      if (identities[kind] !== targetIdentities[kind]
        || recorded.format !== output[kind].format
        || recorded.filename !== `${kind}.${recorded.format}`) continue;
      reusable[kind] = {
        filePath: path.join(dir, recorded.filename),
        expected: {
          width: recorded.width, height: recorded.height, bytes: recorded.bytes,
          format: recorded.format, filename: recorded.filename,
        },
      };
    }
    return reusable;
  }

  /**
   * Copy one reusable published derivative into the staging directory as an
   * independent file and validate it like a freshly encoded one. Returns null
   * on any failure (after removing the partial copy) so the caller encodes
   * that derivative normally instead.
   */
  async function stageReusedDerivative(stagingDir, kind, reusable, expectAnimated) {
    const { filename } = reusable.expected;
    try {
      await runHook('beforeDerivativeReuse', kind);
      const buffer = readDerivativeBuffer(reusable.filePath);
      if (buffer.length !== reusable.expected.bytes) {
        throw new PreviewGenerationError('Reused derivative byte size mismatch.');
      }
      writeDerivative(stagingDir, filename, buffer);
      const { info } = await validateDerivative(path.join(stagingDir, filename), reusable.expected,
        expectAnimated);
      return {
        buffer, width: info.width, height: info.height, animated: info.animated,
        frameCount: info.frameCount, format: reusable.expected.format, filename, info,
      };
    } catch {
      removeDerivative(stagingDir, filename);
      return null;
    }
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
    const policy = currentPolicy();
    const identity = resolvedIdentity(policy, fresh);
    return buildAssetRevisionToken(identity.asset, identity.fingerprint);
  }

  /**
   * After an ordinary raster source no longer matches the row `asset` this
   * attempt started from, bring the row up to date so a retry can generate
   * from the file now on disk. The descriptor/path mismatch the caller
   * observed proves a new source instance, so the row's source generation
   * advances in the same conditional write even when size/mtime are
   * unchanged. The update only replaces that exact row (including its source
   * generation); a row a scan or another request already moved on is accepted
   * as-is and never incremented twice. Returns whether the authoritative
   * revision changed (i.e. a retry has a new source to use).
   */
  function reconcileMovedSource(asset, revision) {
    return Boolean(sourceAnimation.reconcileSource(asset, { replaced: true }))
      || currentRevisionFor(asset.id) !== revision;
  }

  // True only when the file now at the asset path still carries the row's
  // size/mtime tuple, is stable across its open descriptor and path, and is a
  // different instance from `expectedStat`. A changed tuple is reconciled by
  // the normal post-read source check instead.
  function sourceReplacedKeepingTuple(project, asset, expectedStat) {
    let opened;
    try {
      opened = openAssetFile(projectsRoot, project.project_dir, asset.relative_path);
      const descriptor = fs.fstatSync(opened.handle);
      const atPath = fs.statSync(opened.absolutePath);
      return descriptor.size === asset.size_bytes
        && descriptor.mtime.toISOString() === normalizeMtime(asset.modified_at)
        && sameSourceStat(opened.stat, descriptor) && sameSourceStat(descriptor, atPath)
        && !sameSourceStat(descriptor, expectedStat);
    } catch {
      return false;
    } finally {
      if (opened) closeAssetFile(opened);
    }
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
   *   - Before publication, both the database revision and the opened source
   *     descriptor/path are checked against the generation input. If either
   *     moved on, the staged output is discarded within the two-attempt bound.
   *   - Publication is: rename staging → r-<rev>-<rand> (immutable dir), then
   *     atomically replace current.json. A failure between the rename and
   *     the pointer write removes the orphaned revision directory so no
   *     staged output survives a failed publication.
   *
   * On any failure the staging directory (or orphaned revision directory) is
   * removed and the previously published cache is left byte-for-byte
   * unchanged.
   *
   * Selective reuse: for ordinary raster sources (not Krita) and unless
   * `allowReuse` is false (manual force rebuild), each attempt re-inspects
   * the published pair after this attempt's source checks and copies a
   * derivative whose per-kind identity already matches the target instead of
   * re-encoding it. The staged set is still a complete, self-contained pair
   * with fresh metadata and passes the same validation and publication checks.
   *
   * Processing admission: callers already hold the per-asset lock and have
   * decided generation is needed. One shared processing permit is acquired
   * here and held across both bounded attempts (including any copied
   * derivative); target authority is rechecked at the start of the first
   * attempt, after the permit is granted and before any source or Sharp work.
   * `recheckFresh`, when given, then re-probes the published pair against the
   * refreshed authoritative identity; state may have changed while queued, so
   * a pair that is fresh again is returned as `{ current }` without staging,
   * but only after the current disk source is proven to still match the
   * refreshed source authority. Force rebuilds pass no callback and always generate.
   *
   * @param {number} projectId
   * @param {number} assetId
   * @returns {Promise<{ thumbnailPath: string, previewPath: string, meta: object, revision: string }>}
   * @throws {PreviewError} if the source changed during both attempts and no
   *   consistent cache could be published.
   */
  function generateAndPublish(projectId, assetId, targetPolicy, isTargetAuthoritative, options = {}) {
    // Pin the source's descriptor identity before queueing (still inside the
    // asset lock, permit-free) so a post-admission fresh return can also
    // reject a same-size/same-mtime replacement made while waiting, and that
    // replacement is established as a new source generation.
    const queuedSource = options.recheckFresh
      ? statQueuedSource(projectId, assetId, options.sourceBaseline) : null;
    return processingPool.run(() => generateAndPublishAdmitted(projectId, assetId, targetPolicy,
      isTargetAuthoritative, { ...options, queuedSource }));
  }

  // The source generation is pinned with the descriptor identity so a
  // replacement a scan already recorded while queued is not counted again.
  // `sourceBaseline` is the identity a failed ('changed' or 'unknown')
  // pre-lock presentation proof pinned before probing the published pair.
  // It is historical evidence only, never the current source: while the row
  // is still the one that proof ran against it stays the reference the file
  // now on disk is compared with, so a replacement made since then (even one
  // keeping size/mtime) is reconciled instead of being re-pinned as the
  // row's source. A row that moved on since then already describes a newer
  // source and is pinned afresh, so one transition is never counted twice.
  function statQueuedSource(projectId, assetId, sourceBaseline = null) {
    let opened;
    try {
      const { project, asset } = loadProjectAndAsset(projectId, assetId);
      if (sourceBaseline && (asset.source_generation ?? 0) === sourceBaseline.sourceGeneration
        && asset.relative_path === sourceBaseline.relativePath
        && asset.size_bytes === sourceBaseline.size && asset.modified_at === sourceBaseline.mtime) {
        return { stat: sourceBaseline.stat, sourceGeneration: sourceBaseline.sourceGeneration };
      }
      opened = openAssetFile(projectsRoot, project.project_dir, asset.relative_path);
      // openAssetFile already fstat-validated this descriptor.
      return { stat: opened.stat, sourceGeneration: asset.source_generation ?? 0 };
    } catch {
      return null;
    } finally {
      if (opened) closeAssetFile(opened);
    }
  }

  async function generateAndPublishAdmitted(projectId, assetId, targetPolicy, isTargetAuthoritative,
    { allowReuse = true, recheckFresh = null, queuedSource = null } = {}) {
    const assertTargetCurrent = () => {
      if (targetPolicy && (JSON.stringify(currentPolicy()) !== JSON.stringify(targetPolicy)
        || !isTargetAuthoritative())) {
        throw new PreviewGenerationError('Target image policy is obsolete.');
      }
    };
    let reuseAllowed = allowReuse;
    for (let attempt = 0; attempt < 2; attempt++) {
      // Reload authoritative project + asset inside the lock for THIS attempt.
      const { project, asset: loadedAsset } = loadProjectAndAsset(projectId, assetId);
      assertTargetCurrent();
      const policy = targetPolicy || currentPolicy();
      const { asset, fingerprint } = resolvedIdentity(policy, loadedAsset);
      const classification = classifyPreviewable(asset);
      const revisionNow = buildAssetRevision(asset, fingerprint);
      if (!revisionNow) {
        throw new PreviewNotFoundError('Asset source metadata is unavailable.');
      }
      const ctxNow = revisionNow.context;
      const revNow = revisionNow.revision;
      if (attempt === 0 && recheckFresh) {
        // Cache-vs-DB agreement is not enough: the source may have been
        // replaced on disk while queued without a rescan. A fresh pair is
        // returned only when the disk source still matches the refreshed row
        // and the identity pinned before queueing; otherwise this same
        // admitted attempt continues into normal generation/reconciliation.
        // A replaced source can keep the stored size/mtime tuple, so its
        // published bytes are never copied once this check fails.
        // Without a fresh pair to return, the check only gates reuse, which
        // later compares the decoded animation itself: skip the GIF/WebP read.
        const current = await recheckFresh(ctxNow, revNow);
        const sourceCurrent = Boolean(queuedSource)
          && sourceAllowsFallback(project, asset, queuedSource.stat, { checkAnimation: Boolean(current) });
        if (current && sourceCurrent) return { current };
        if (!sourceCurrent) reuseAllowed = false;
        // A file replaced while queued can keep the stored tuple, so its
        // bytes would otherwise publish under the old immutable revision.
        // Establish it as a new source generation (unless a scan already
        // advanced the row since pinning) and retry under the new revision.
        if (!sourceCurrent && queuedSource
          && (asset.source_generation ?? 0) === queuedSource.sourceGeneration
          && sourceReplacedKeepingTuple(project, asset, queuedSource.stat)) {
          if (reconcileMovedSource(asset, revNow)) continue;
          throw new PreviewGenerationError('Source changed since inspection.');
        }
      }

      const parentDir = ensureCacheDir(previewRoot, projectId, assetId);
      const staging = makeStagingDir(parentDir);
      await runHook('onStagingCreated', staging.dirName);

      // Track whether staging was promoted to a revision directory so the
      // failure path knows which directory to remove.
      let renamedTo = null;
      try {
        const source = await readSourceForDerivative(project, asset, classification);
        const { buffer: sourceBuffer, quality: sourceQuality } = source;
        const ordinarySource = classification.kind === 'image';
        const animationSource = classification.extension === 'gif' || classification.extension === 'webp';
        if (ordinarySource && !sourceMatches(project, asset, source.stat)) {
          // The disk source is not the one this row describes: never copy
          // published bytes again, reconcile the row to the file now on disk
          // (or accept a row that already moved on) and retry once under it.
          reuseAllowed = false;
          if (attempt === 0 && reconcileMovedSource(asset, revNow)) {
            removeDirTree(staging.dir);
            continue;
          }
          throw new PreviewGenerationError('Source changed since inspection.');
        }
        let sourceAnimated;
        try {
          const sh = await sharp();
          ({ animated: sourceAnimated } = await detectAnimation(sh(sourceBuffer)));
        } catch (err) {
          throw new PreviewGenerationError('Source image cannot be decoded.');
        }
        if (animationSource && (asset.source_animated == null
          || Boolean(asset.source_animated) !== sourceAnimated)) {
          if (attempt === 0 && sourceAnimation.reconcileSource(asset)) {
            removeDirTree(staging.dir);
            continue;
          }
          throw new PreviewGenerationError('Source animation state changed since inspection.');
        }

        // Decided per attempt, after this attempt's source checks, so a
        // reconciliation retry never inherits an earlier reuse decision.
        const generationIdentities = projectImageGenerationIdentities(policy, sourceAnimated);
        const reusable = reuseAllowed && ordinarySource
          ? findReusableDerivatives(projectId, assetId, ctxNow, policy, generationIdentities, sourceAnimated)
          : { thumbnail: null, preview: null };

        // Thumbnail: copy when proven reusable, else generate, write, validate
        // (distinct stages for hooks).
        let thumb = reusable.thumbnail
          ? await stageReusedDerivative(staging.dir, 'thumbnail', reusable.thumbnail, false)
          : null;
        if (thumb) {
          await runHook('onDerivativeStaged', 'thumbnail', 'reused');
        } else {
          await runHook('beforeThumbTransform');
          try {
            thumb = await generateDerivative(sourceBuffer, 'thumbnail', sourceAnimated, policy);
          } catch (err) {
            throw new PreviewGenerationError('Thumbnail generation failed.');
          }
          await runHook('beforeThumbValidate');
          writeDerivative(staging.dir, thumb.filename, thumb.buffer);
          await validateDerivative(
            path.join(staging.dir, thumb.filename),
            { width: thumb.width, height: thumb.height, bytes: thumb.buffer.length, format: thumb.format },
            false
          );
          await runHook('onDerivativeStaged', 'thumbnail', 'encoded');
        }

        // Preview: copy when proven reusable, else generate, write, validate.
        let preview = reusable.preview
          ? await stageReusedDerivative(staging.dir, 'preview', reusable.preview, sourceAnimated)
          : null;
        let previewVal;
        if (preview) {
          previewVal = { info: preview.info };
          await runHook('onDerivativeStaged', 'preview', 'reused');
        } else {
          await runHook('beforePreviewTransform');
          try {
            preview = await generateDerivative(sourceBuffer, 'preview', sourceAnimated, policy);
          } catch (err) {
            throw new PreviewGenerationError('Preview generation failed.');
          }
          await runHook('beforePreviewValidate');
          writeDerivative(staging.dir, preview.filename, preview.buffer);
          previewVal = await validateDerivative(
            path.join(staging.dir, preview.filename),
            { width: preview.width, height: preview.height, bytes: preview.buffer.length, format: preview.format },
            preview.animated
          );
          await runHook('onDerivativeStaged', 'preview', 'encoded');
        }

        const thumbMeta = {
          width: thumb.width,
          height: thumb.height,
          bytes: thumb.buffer.length,
          format: thumb.format,
          filename: thumb.filename,
        };
        const previewMeta = {
          width: preview.width,
          height: preview.height,
          bytes: preview.buffer.length,
          format: preview.format,
          filename: preview.filename,
        };
        const generatedAt = new Date().toISOString();
        // animated/frameCount come from the validated preview derivative: it
        // reflects what was actually written, not just what the source claimed.
        // A mixed pair gets entirely new pair metadata; nothing is carried over
        // from the generation a derivative was copied from.
        const meta = serializeMeta({
          projectId,
          assetId,
          relativePath: ctxNow.relativePath,
          size: ctxNow.size,
          mtime: ctxNow.mtime,
          sourceGeneration: ctxNow.sourceGeneration,
          generatedAt,
          thumbnail: thumbMeta,
          preview: previewMeta,
          policyFingerprint: fingerprint,
          sourceQuality,
          animated: previewVal.info.animated,
          frameCount: previewVal.info.frameCount,
          generationIdentities,
        });

        await runHook('beforeMetaWrite');
        atomicWriteMeta(staging.dir, meta);

        await runHook('beforeStagedSetValidate');
        await validateStagedSet(staging.dir, meta);

        // Recheck both database authority and disk source before promotion.
        await runHook('beforePublishRecheck');
        assertTargetCurrent();
        const revCheck = currentRevisionFor(assetId);
        let sourceMoved = ordinarySource && !sourceMatches(project, asset, source.stat);
        if (revCheck !== revNow || sourceMoved) {
          // Discard this generation and use the remaining attempt, if any.
          removeDirTree(staging.dir);
          if (sourceMoved) {
            reuseAllowed = false;
            // The retry may only run under a new source authority; otherwise
            // it could publish the replacement under this revision.
            if (attempt === 0 && !reconcileMovedSource(asset, revNow)) {
              throw new PreviewGenerationError('Source changed since inspection.');
            }
          }
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
        assertTargetCurrent();
        sourceMoved = ordinarySource && !sourceMatches(project, asset, source.stat);
        if (currentRevisionFor(assetId) !== revNow || sourceMoved) {
          removeDirTree(finalDir);
          if (sourceMoved) {
            reuseAllowed = false;
            if (attempt === 0 && !reconcileMovedSource(asset, revNow)) {
              throw new PreviewGenerationError('Source changed since inspection.');
            }
          }
          continue;
        }
        writeCurrentPointer(parentDir, {
          dir: finalDirName,
          revision: revNow,
          generatedAt,
        });

        return {
          thumbnailPath: path.join(finalDir, thumb.filename),
          previewPath: path.join(finalDir, preview.filename),
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

  function readyDerivative(kind, probed, revision, cacheState) {
    const meta = probed.meta;
    const d = meta[kind];
    return {
      status: 'ready', path: probed.filePath, mimeType: `image/${d.format}`,
      bytes: d.bytes, width: d.width, height: d.height, revision,
      generatedAt: meta.generatedAt, cacheState,
      animated: kind === 'preview' && meta.animated === true,
      quality: meta.source.previewQuality ?? null,
    };
  }

  // Descriptor identity of the file at the asset path, pinned before the
  // published pair is probed so a replacement made while the pair is being
  // validated (even one keeping size/mtime) fails the later source proof.
  function pinSourceStat(project, asset) {
    let opened;
    try {
      opened = openAssetFile(projectsRoot, project.project_dir, asset.relative_path);
      // openAssetFile already fstat-validated this descriptor.
      return opened.stat;
    } catch {
      return null;
    } finally {
      if (opened) closeAssetFile(opened);
    }
  }

  // Presentation reads of the published pair, taken before the per-asset
  // lock. Published revision directories are immutable and current.json is
  // swapped atomically, so a pair that is fresh for the current authority is
  // served exactly as the locked path would serve it, without waiting behind
  // an in-flight generation (including a manual force rebuild) that is only
  // replacing it. A complete prior-policy pair is served the same way.
  // Cache-vs-DB agreement is not enough to bypass the lock: the row can
  // predate an unscanned replacement, and the row or policy can move while
  // the pair is validated. So either candidate is returned only after the
  // disk source is proven to still be the row's source (and the instance
  // pinned before probing) and the DB/policy authority is re-read unchanged.
  // Anything else (absent, stale, corrupt, unproven) returns no `published`
  // result and queues on the lock, which reconciles and reports errors as
  // usual. When a candidate existed for an ordinary raster source but its
  // disk source could not be proven, a `sourceHandoff` is returned so the
  // locked path cannot fall back to the row's cache-vs-DB agreement:
  //   - `validationRequired` (always true): the locked path must prove the
  //     live source before serving the published pair as fresh;
  //   - `replaced`: the proof observed the source differ from the row or the
  //     pinned instance ('changed'); false when it was merely unproven
  //     ('unknown', e.g. an I/O error), which never by itself means a
  //     replacement and never by itself advances the source generation;
  //   - `baseline`: the identity pinned before probing (historical evidence
  //     only), or null when the source could not even be pinned.
  // Cache misses (absent, stale, corrupt) and policy/DB movement with an
  // otherwise proven source carry none, and neither does an 'unknown' that
  // only concerns the animation state of a file instance whose final
  // identity (after any GIF/WebP structural read) was proven.
  async function publishedForPresentation(kind, projectId, assetId) {
    const { project, asset: loadedAsset } = loadProjectAndAsset(projectId, assetId);
    const animationSource = ['gif', 'webp'].includes(String(loadedAsset.extension || '').toLowerCase());
    const animationUnknown = animationSource && loadedAsset.source_animated == null;
    const policy = currentPolicy();
    const { asset, fingerprint } = resolvedIdentity(policy, loadedAsset);
    const classification = classifyPreviewable(asset);
    if (!classification.supported) return {};
    const target = buildAssetRevision(asset, fingerprint);
    if (!target) return {};
    const pinned = pinSourceStat(project, asset);
    const probed = await probeCacheEntry(projectId, assetId, target.context, kind, !animationUnknown);
    if (probed.state !== 'fresh' && probed.state !== 'prior-policy') return {};
    // Krita documents keep their existing (tuple-only) authority model.
    const ordinarySource = classification.kind === 'image';
    if (!pinned) {
      return ordinarySource ? { sourceHandoff: { validationRequired: true, replaced: false, baseline: null } } : {};
    }
    await runHook('beforePresentationSourceProof', kind);
    const detail = {};
    const proof = sourceProof(project, asset, pinned, { detail });
    // An 'unknown' limited to the animation state of a file instance whose
    // final identity was proven leaves the locked path's existing animation
    // handling as is; one where the animation read or a later identity check
    // threw is unproven and carries the handoff like any other.
    if (proof !== 'ok' && ordinarySource && !(proof === 'unknown' && detail.finalIdentityProven)) {
      return { sourceHandoff: {
        validationRequired: true,
        replaced: proof === 'changed',
        baseline: {
          stat: pinned, sourceGeneration: asset.source_generation ?? 0,
          relativePath: asset.relative_path, size: asset.size_bytes, mtime: asset.modified_at,
        },
      } };
    }
    if (proof !== 'ok'
      || (animationSource && (typeof probed.meta.animated !== 'boolean'
        || probed.meta.animated !== Boolean(asset.source_animated)))
      || currentRevisionFor(assetId) !== target.revision
      || assetRepo.findById(assetId)?.source_animated !== asset.source_animated) return {};
    return { published: probed.state === 'fresh'
      ? readyDerivative(kind, probed, target.revision, 'fresh')
      : readyDerivative(kind, probed, probed.actualRevision, 'prior-policy') };
  }

  // ── Public: getThumbnail / getPreview ───────────────────────────────

  /**
   * Shared implementation for getThumbnail and getPreview.
   *
   * Concurrency & freshness contract:
   *   - The per-asset generation lock (projectId:assetId only) serializes
   *     every cache-writing operation. The client `requestedRevision` has
   *     zero influence on locking, freshness, or generation decisions.
   *   - A published pair that is fresh for the current authority, or a
   *     complete prior-policy pair, whose disk source and DB/policy authority
   *     are proven unchanged after validation, is read before the lock so
   *     presentation does not wait for a rebuild (automatic or manual force)
   *     of that asset. `ensureCurrent` callers skip this and always queue.
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
  async function getDerivative(kind, projectId, assetId, requestedRevision, ensureCurrent = false) {
    // Set only when a pre-lock candidate's source proof did not succeed; the
    // live source is revalidated against the current row once the lock is held.
    let sourceHandoff = null;
    if (!ensureCurrent) {
      const presentation = await publishedForPresentation(kind, projectId, assetId);
      if (presentation.published) return presentation.published;
      sourceHandoff = presentation.sourceHandoff ?? null;
    }
    const sourceValidationRequired = sourceHandoff?.validationRequired === true;
    const sourceReplaced = sourceHandoff?.replaced === true;
    return withLock(projectId, assetId, async () => {
      // Reload the authoritative project + asset inside the lock.
      const { asset: loadedAsset } = loadProjectAndAsset(projectId, assetId);
      const policy = currentPolicy();
      const { asset, fingerprint } = resolvedIdentity(policy, loadedAsset);
      const cls = classifyPreviewable(asset);
      const currentRevision = buildAssetRevision(asset, fingerprint);
      if (!cls.supported) {
        return {
          status: 'unsupported',
          projectId: asset.project_id,
          assetId: asset.id,
          revision: currentRevision?.revision ?? null,
          cacheState: 'unsupported-format',
        };
      }

      if (!currentRevision) {
        throw new PreviewNotFoundError('Asset source metadata is unavailable.');
      }

      const ctx = currentRevision.context;
      const revision = currentRevision.revision;

      // After a failed or unproven pre-lock source proof, cache-vs-DB
      // agreement is not enough: the admitted recheck returns a fresh pair
      // only once the live disk source is proven against the current row
      // (and the pinned baseline), and otherwise reconciles it first.
      if (!sourceValidationRequired) {
        const probed = await probeCacheEntry(projectId, assetId, ctx, kind);
        if (probed.state === 'fresh') {
          return readyDerivative(kind, probed, revision, 'fresh');
        }
      }

      // absent | stale | corrupt → regenerate the complete set atomically,
      // unless the pair became fresh while this request waited for admission.
      // A proven replacement never copies derivatives of the published pair;
      // an unproven source only loses reuse if the locked proof fails too.
      const result = await generateAndPublish(projectId, assetId, null, undefined, {
        allowReuse: !sourceReplaced,
        sourceBaseline: sourceHandoff?.baseline ?? null,
        recheckFresh: async (ctxNow, revNow) => {
          const current = await probeCacheEntry(projectId, assetId, ctxNow, kind);
          return current.state === 'fresh' ? readyDerivative(kind, current, revNow, 'fresh') : null;
        },
      });
      if (result.current) return result.current;
      const meta = result.meta;
      const d = kind === 'thumbnail' ? meta.thumbnail : meta.preview;
      const filePath =
        kind === 'thumbnail' ? result.thumbnailPath : result.previewPath;

      return {
        status: 'ready',
        path: filePath,
        mimeType: `image/${d.format}`,
        bytes: d.bytes,
        width: d.width,
        height: d.height,
        revision: result.revision,
        generatedAt: meta.generatedAt,
        cacheState: 'regenerated',
        animated: kind === 'preview' && meta.animated === true,
        quality: meta.source.previewQuality ?? null,
      };
    });
  }

  return {
    getThumbnail: (projectId, assetId, requestedRevision) =>
      getDerivative('thumbnail', projectId, assetId, requestedRevision),
    getPreview: (projectId, assetId, requestedRevision) =>
      getDerivative('preview', projectId, assetId, requestedRevision),
    ensureCurrentPreview: (projectId, assetId) =>
      getDerivative('preview', projectId, assetId, undefined, true),
    // The authority callback is a synchronous read of the caller's target
    // identity. It is checked again at both publication boundaries.
    ensureTargetGeneration: (projectId, assetId, targetPolicy, isTargetAuthoritative = () => true, { force = false } = {}) => {
      const target = validatedTargetPolicy(targetPolicy);
      if (typeof isTargetAuthoritative !== 'function') {
        throw new TypeError('Target authority must be a function.');
      }
      return withLock(projectId, assetId, async () => {
        if (JSON.stringify(currentPolicy()) !== JSON.stringify(target) || !isTargetAuthoritative()) {
          throw new PreviewGenerationError('Target image policy is obsolete.');
        }
        const { asset: loadedAsset } = loadProjectAndAsset(projectId, assetId);
        const { asset, fingerprint } = resolvedIdentity(target, loadedAsset);
        if (!classifyPreviewable(asset).supported) {
          return { status: 'unsupported' };
        }
        const revision = buildAssetRevision(asset, fingerprint);
        if (!revision) throw new PreviewNotFoundError('Asset source metadata is unavailable.');
        // A force rebuild always generates, so it never needs the probe
        // result (each probe re-reads and decodes a published derivative).
        const thumbnail = force ? null : await probeCacheEntry(projectId, assetId, revision.context, 'thumbnail');
        const preview = force ? null : await probeCacheEntry(projectId, assetId, revision.context, 'preview');
        if (JSON.stringify(currentPolicy()) !== JSON.stringify(target) || !isTargetAuthoritative()) {
          throw new PreviewGenerationError('Target image policy is obsolete.');
        }
        if (!force && thumbnail.state === 'fresh' && preview.state === 'fresh') {
          return { status: 'ready', revision: revision.revision,
            thumbnail: readyDerivative('thumbnail', thumbnail, revision.revision, 'fresh'),
            preview: readyDerivative('preview', preview, revision.revision, 'fresh') };
        }
        // Manual force rebuild is a repair: never reuse published bytes.
        const generated = await generateAndPublish(projectId, assetId, target, isTargetAuthoritative, {
          allowReuse: !force,
          recheckFresh: force ? null : async (ctxNow, revNow) => {
            const thumb = await probeCacheEntry(projectId, assetId, ctxNow, 'thumbnail');
            const prev = await probeCacheEntry(projectId, assetId, ctxNow, 'preview');
            if (JSON.stringify(currentPolicy()) !== JSON.stringify(target) || !isTargetAuthoritative()) {
              throw new PreviewGenerationError('Target image policy is obsolete.');
            }
            if (thumb.state !== 'fresh' || prev.state !== 'fresh') return null;
            return { status: 'ready', revision: revNow,
              thumbnail: readyDerivative('thumbnail', thumb, revNow, 'fresh'),
              preview: readyDerivative('preview', prev, revNow, 'fresh') };
          },
        });
        if (generated.current) return generated.current;
        return {
          status: 'ready', revision: generated.revision, cacheState: 'regenerated',
          thumbnail: readyDerivative('thumbnail',
            { filePath: generated.thumbnailPath, meta: generated.meta }, generated.revision, 'regenerated'),
          preview: readyDerivative('preview',
            { filePath: generated.previewPath, meta: generated.meta }, generated.revision, 'regenerated'),
        };
      });
    },
    getOriginalDescriptor,
    inspectKritaPreviewSource: (project, asset) => {
      const projectId = typeof project === 'object' ? project?.id : project;
      const assetId = asset?.id;
      if (!Number.isInteger(projectId) || !Number.isInteger(assetId)) {
        return Promise.resolve({ quality: null });
      }
      return withLock(projectId, assetId, () => inspectKritaPreviewSource(project, asset));
    },

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
