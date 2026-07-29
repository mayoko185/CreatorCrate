// Phase 10.1C — Media service
//
// A thin orchestration layer over the Phase 10.1A/10.1B preview service and
// the Phase 3 `openAssetFile` safe resolver. Routes call this service and
// never touch SQL, paths, Sharp, filesystem descriptors, or repositories.
//
// Responsibilities:
//
//   - prepareDerivativeResponse(kind, projectId, assetId, requestedRevision)
//       Wraps `previewService.getThumbnail` / `getPreview`, validates that the
//       generated derivative is still inside the application-controlled preview
//       root, opens the derivative stream, and returns only HTTP response data:
//       `{ status, headers, stream, cleanup }`. Absolute cache paths never cross
//       the route boundary.
//
//   - prepareOriginalResponse(projectId, assetId)
//       Resolves original metadata, builds safe headers, opens the original via
//       `openAssetFile`, and returns `{ status, headers, stream, cleanup }`.
//       The route never receives the source path or descriptor.
//
//   - buildInlineDisposition(filename)
//       Sanitizes a filename for use in `Content-Disposition: inline` and
//       returns both an ASCII fallback (`filename`) and an RFC 5987 UTF-8
//       parameter (`filename*`) so non-ASCII names survive.
//
//   - inlineMimeFor(extension, recordedMimeType)
//       Returns the allowlisted inline MIME only when the extension and
//       recorded MIME match one of the explicit safe image pairs. Krita,
//       unknown extensions, missing MIME, `application/octet-stream`, and
//       mismatches are rejected.
//
// Error mapping is done here so routes stay declarative. The service throws
// typed errors that the route translates into controlled HTTP responses.
// Unexpected errors propagate unchanged so Express's global handler sees
// them.

import fs from 'node:fs';
import path from 'node:path';
import { openAssetFile, closeAssetFile } from '../storage/asset-file.js';
import { StorageError } from '../storage/path-manager.js';
import { PreviewCacheError } from '../storage/preview-cache.js';
import {
  PreviewAccessError,
  PreviewError,
  PreviewGenerationError,
  PreviewNotFoundError,
} from './preview-service.js';

// ─── Service errors ──────────────────────────────────────────────────────

/**
 * Base class for media-service errors. Carries an HTTP `status` so the
 * route can map it without instanceof chains. `expose` marks messages
 * safe to surface to clients (no absolute paths, no OS details, no Sharp
 * internals).
 */
export class MediaError extends Error {
  constructor(status, message, { expose = true } = {}) {
    super(message);
    this.name = 'MediaError';
    this.status = status;
    this.expose = expose;
  }
}

export class MediaNotFoundError extends MediaError {
  constructor(message) {
    super(404, message);
    this.name = 'MediaNotFoundError';
  }
}

export class MediaUnsupportedError extends MediaError {
  constructor(message) {
    super(415, message);
    this.name = 'MediaUnsupportedError';
  }
}

export class MediaBadRequestError extends MediaError {
  constructor(message) {
    super(400, message);
    this.name = 'MediaBadRequestError';
  }
}

export class MediaUnavailableError extends MediaError {
  constructor(message) {
    super(503, message, { expose: true });
    this.name = 'MediaUnavailableError';
  }
}

// ─── HTTP response helpers ───────────────────────────────────────────────

const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable';
const CACHE_REVALIDATE = 'public, max-age=0, must-revalidate';
const CACHE_NO_STORE = 'no-store';
const CACHE_ORIGINAL = 'public, max-age=0, must-revalidate';

function derivativeCacheControl(requestedRevision, currentRevision) {
  if (
    typeof requestedRevision === 'string' &&
    requestedRevision.length > 0 &&
    requestedRevision === currentRevision
  ) {
    return CACHE_IMMUTABLE;
  }
  return CACHE_REVALIDATE;
}

function buildDerivativeEtag(revision, bytes) {
  return `W/"${revision}-${bytes}"`;
}

function cleanupStream(stream) {
  if (stream && !stream.destroyed) stream.destroy();
}

function assertContainedPath(root, target) {
  const rootAbs = path.resolve(root);
  const targetAbs = path.resolve(target);
  const relative = path.relative(rootAbs, targetAbs);
  if (
    relative === '..' ||
    relative.startsWith('..' + path.sep) ||
    path.isAbsolute(relative)
  ) {
    throw new MediaUnavailableError('Preview unavailable');
  }
  return targetAbs;
}

function openDerivativeStream(previewRoot, filePath) {
  const containedPath = assertContainedPath(previewRoot, filePath);
  return fs.createReadStream(containedPath);
}

// ─── Inline MIME allowlist ────────────────────────────────────────────────
//
// Only PNG/JPEG/WebP/GIF may be served inline as originals, and only when
// the asset's recorded MIME agrees with the extension:
//   png + image/png, jpg/jpeg + image/jpeg, webp + image/webp, gif + image/gif.
// Krita, unknown extensions, missing MIME, `application/octet-stream`, and any
// extension/MIME mismatch are rejected with 415. The route does not infer
// inline safety from extension alone.

const INLINE_MIME_BY_EXTENSION = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
});

/**
 * Return the allowlisted inline MIME only when extension and recorded MIME agree.
 *
 * @param {string} extension - lowercased, no dot.
 * @param {string} recordedMimeType - MIME stored for the asset row.
 * @returns {string|null}
 */
export function inlineMimeFor(extension, recordedMimeType) {
  const ext = String(extension || '').toLowerCase();
  const mime = String(recordedMimeType || '').toLowerCase();
  const expected = INLINE_MIME_BY_EXTENSION[ext];
  if (!expected || mime !== expected) return null;
  return expected;
}

// ─── Filename sanitization ───────────────────────────────────────────────
//
// `Content-Disposition: inline; filename="..."` is a header-injection
// vector. The raw database filename is never trusted. We:
//
//   1. Take the basename of the asset's relative_path (rejects any stored
//      path separator — forward or back — so a stored `../x.png` or
//      `a/b.png` collapses to its final segment).
//   2. Strip control characters (C0, DEL, and C1 control bytes, tabs, NUL).
//   3. Strip CR/LF (header separators).
//   4. Strip double quotes (delimiter of the filename parameter).
//   5. Strip backslashes (escape character in the parameter).
//   6. Strip path separators (defense in depth — the basename step already
//      removed them, but a single-segment name like `..` is also rejected
//      because it could leak structure).
//   7. Strip semicolons (Content-Disposition parameter delimiter).
//   8. Collapse internal whitespace to single spaces.
//   9. Trim.
//  10. Build an ASCII-only fallback by transliterating non-ASCII code points
//      (NFD decomposition + combining-mark removal), then dropping any
//      remaining non-ASCII. If the result is empty or unsafe (`.`, `..`),
//      fall back to `asset.<ext>` (or `asset.png` if no safe extension).
//  11. Bound both filename parameters: ASCII fallback max 128 characters;
//      RFC 5987 encoded basename max 768 characters. With fixed header syntax
//      this keeps the complete Content-Disposition value below 1024 bytes.
//
// The `filename*` RFC 5987 parameter preserves the sanitized Unicode name
// through UTF-8 percent-encoding. The encoder intentionally leaves only the
// conservative attr-char subset `A-Z a-z 0-9 - . _ ~` unencoded; apostrophe,
// asterisk, parentheses, percent signs, spaces, and all non-ASCII bytes are
// percent-encoded with uppercase hexadecimal digits. The ASCII `filename`
// parameter contains ONLY safe printable ASCII, ensuring no header injection
// is possible even on legacy clients that ignore `filename*`.

const SAFE_FILENAME_FALLBACK = 'asset';
const SAFE_FALLBACK_EXTENSION = 'png';
const ASCII_FALLBACK_MAX = 128;
const UTF8_FILENAME_ENCODED_MAX = 768;
export const CONTENT_DISPOSITION_HEADER_MAX = 1024;

function isRfc5987AttrSubsetByte(byte) {
  return (
    (byte >= 0x41 && byte <= 0x5A) || // A-Z
    (byte >= 0x61 && byte <= 0x7A) || // a-z
    (byte >= 0x30 && byte <= 0x39) || // 0-9
    byte === 0x2D || // -
    byte === 0x2E || // .
    byte === 0x5F || // _
    byte === 0x7E    // ~
  );
}

function encode5987ValueChars(value) {
  let encoded = '';
  for (const byte of Buffer.from(value, 'utf8')) {
    if (isRfc5987AttrSubsetByte(byte)) {
      encoded += String.fromCharCode(byte);
    } else {
      encoded += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return encoded;
}

function encoded5987Length(value) {
  let length = 0;
  for (const byte of Buffer.from(value, 'utf8')) {
    length += isRfc5987AttrSubsetByte(byte) ? 1 : 3;
  }
  return length;
}

function splitUnicodeFilenameSegments(value) {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
    return Array.from(segmenter.segment(value), ({ segment }) => segment);
  }
  return Array.from(value);
}

function truncateUnicodeFilenameFor5987(filename) {
  if (encoded5987Length(filename) <= UTF8_FILENAME_ENCODED_MAX) return filename;

  const rawExt = path.extname(filename);
  const stem = path.basename(filename, rawExt);
  const extEncodedLength = rawExt ? encoded5987Length(rawExt) : 0;
  const retainedExt = rawExt && extEncodedLength < UTF8_FILENAME_ENCODED_MAX
    ? rawExt
    : '';
  const stemBudget = UTF8_FILENAME_ENCODED_MAX - encoded5987Length(retainedExt);

  let truncatedStem = '';
  let used = 0;
  for (const segment of splitUnicodeFilenameSegments(stem)) {
    const segmentLength = encoded5987Length(segment);
    if (used + segmentLength > stemBudget) break;
    truncatedStem += segment;
    used += segmentLength;
  }

  if (truncatedStem) return truncatedStem + retainedExt;

  const fallback = SAFE_FILENAME_FALLBACK + retainedExt;
  if (encoded5987Length(fallback) <= UTF8_FILENAME_ENCODED_MAX) return fallback;
  return SAFE_FILENAME_FALLBACK;
}

/**
 * Sanitize a raw filename for use in Content-Disposition.
 *
 * Returns `{ ascii, utf8 }` where:
 *   - `ascii` is an ASCII-only fallback value containing no quotes, no
 *     CR/LF, no backslashes, no path separators, no control characters, no
 *     semicolons, and no non-ASCII code points. When the original name
 *     contains non-ASCII characters, the fallback is a transliterated form
 *     (NFD decomposition + combining-mark removal). When the transliterated
 *     form is empty or unsafe, the fallback is `asset.<ext>` (or `asset.png`
 *     if no safe extension exists). The fallback is bounded to 128 characters
 *     and preserves a safe extension where possible.
 *   - `utf8` is an RFC 5987 `filename*` parameter value
 *     (`UTF-8''<percent-encoded>`) built from a Unicode basename truncated by
 *     grapheme/code-point segments until its encoded form is at most 768
 *     characters, preserving the extension where possible.
 *
 * @param {string} rawFilename
 * @returns {{ ascii: string, utf8: string }}
 */
export function sanitizeDispositionFilename(rawFilename) {
  const base = path.basename(String(rawFilename ?? ''));

  // Strip characters that are dangerous in a Content-Disposition
  // quoted-string or that could split/terminate header parameters:
  //   " — delimiter of the filename parameter value.
  //   \ — escape character in the parameter.
  //   / — path separator (defense in depth after basename).
  //   \ — path separator (defense in depth; backslash in filenames).
  //   \r \n — CR/LF are header separators.
  //   ; — Content-Disposition parameter delimiter.
  let cleaned = base.replace(/["\\\r\n/\\;]/g, '');

  // Strip C0 controls (U+0000–U+001F), DEL (U+007F), and C1 controls
  // (U+0080–U+009F), including NUL and horizontal tab.
  cleaned = cleaned.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');

  // Collapse internal whitespace, trim.
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  // Reject unsafe residues.
  if (cleaned === '' || cleaned === '.' || cleaned === '..') {
    cleaned = 'asset.png';
  }

  // ── ASCII fallback ─────────────────────────────────────────────────────
  // NFD decomposition separates base characters from combining diacritical
  // marks (U+0300–U+036F). Stripping the combining marks transliterates
  // Latin-1/accented characters to their ASCII base (é → e, ç → c, etc.).
  // CJK, emoji, and other scripts with no NFD decomposition are removed
  // entirely, leaving only ASCII-safe characters.

  // Extract the extension before transliteration so we can retain a safe
  // ASCII extension in the fallback.
  const rawExt = path.extname(cleaned);
  const extNoDot = rawExt ? rawExt.slice(1).toLowerCase() : '';
  const safeExt = /^[a-z0-9]{1,20}$/.test(extNoDot) ? extNoDot : '';

  const stem = path.basename(cleaned, rawExt);

  let asciiStem = stem
    .normalize('NFD')
    .replace(/[\u0300-\u036F]/g, '')   // combining diacritical marks
    .replace(/[^\x20-\x7E]/g, '')      // drop any remaining non-ASCII
    .replace(/\s+/g, ' ')
    .trim();

  let forceExt = false;
  if (asciiStem === '' || asciiStem === '.' || asciiStem === '..') {
    asciiStem = SAFE_FILENAME_FALLBACK;
    forceExt = true;
  }
  const finalExt = forceExt && !safeExt ? SAFE_FALLBACK_EXTENSION : safeExt;

  // Bound total length to a safe maximum, preserving the extension.
  const ascii = (() => {
    const raw = asciiStem + (finalExt ? '.' + finalExt : '');
    if (raw.length <= ASCII_FALLBACK_MAX) return raw;
    const extBudget = finalExt ? finalExt.length + 1 : 0;
    const stemBudget = Math.max(1, ASCII_FALLBACK_MAX - extBudget);
    return asciiStem.slice(0, stemBudget) + (finalExt ? '.' + finalExt : '');
  })();

  // ── RFC 5987 UTF-8 parameter ───────────────────────────────────────────
  const utf8Name = truncateUnicodeFilenameFor5987(cleaned);
  const utf8Safe = encode5987ValueChars(utf8Name);

  return { ascii, utf8: `UTF-8''${utf8Safe}` };
}

/**
 * Build a `Content-Disposition: inline` header value with both an ASCII
 * `filename` fallback and an RFC 5987 `filename*` UTF-8 parameter.
 *
 * @param {string} rawFilename
 * @returns {string}
 */
export function buildInlineDisposition(rawFilename) {
  const { ascii, utf8 } = sanitizeDispositionFilename(rawFilename);
  return `inline; filename="${ascii}"; filename*=${utf8}`;
}

// ─── Service factory ─────────────────────────────────────────────────────

/**
 * @typedef {Object} MediaServiceDeps
 * @property {import('../services/preview-service.js').PreviewService} previewService
 * @property {string} projectsRoot
 * @property {string} previewRoot
 */

/**
 * Create a media service.
 *
 * @param {MediaServiceDeps} deps
 */
export function createMediaService({ previewService, projectsRoot, previewRoot }) {
  if (!previewService) throw new TypeError('previewService is required');
  if (!projectsRoot) throw new TypeError('projectsRoot is required');
  if (!previewRoot) throw new TypeError('previewRoot is required');

  /**
   * Resolve a derivative (thumbnail or preview) for an asset.
   *
   * The preview service still returns its internal cache descriptor, including
   * an absolute path. That value is consumed entirely inside this service;
   * callers receive only a prepared response stream and headers.
   *
   * @param {'thumbnail'|'preview'} kind
   * @param {number} projectId
   * @param {number} assetId
   * @param {string} [requestedRevision]
   */
  async function getDerivative(kind, projectId, assetId, requestedRevision) {
    const fn = kind === 'thumbnail'
      ? previewService.getThumbnail
      : previewService.getPreview;
    try {
      return await fn(projectId, assetId, requestedRevision);
    } catch (err) {
      if (
        err instanceof PreviewNotFoundError ||
        err instanceof PreviewAccessError
      ) {
        throw new MediaNotFoundError('Asset is not available.');
      }
      if (
        err instanceof PreviewGenerationError ||
        err instanceof PreviewCacheError
      ) {
        throw new MediaUnavailableError('Preview unavailable');
      }
      if (err instanceof StorageError) {
        throw new MediaNotFoundError('Asset is not available.');
      }
      throw err;
    }
  }

  /**
   * Resolve original source metadata and the service-owned open-stream
   * factory. This remains internal to the media service so no source path or
   * descriptor crosses into the route layer.
   *
   * `prepareOriginalResponse` consumes this descriptor, opens the stream, and
   * returns only `{ status, headers, stream, cleanup }` to the route.
   *
   * @param {number} projectId
   * @param {number} assetId
   * @returns {{ filename: string, mimeType: string, size: number, revision: string, extension: string, openStream: () => { stream: fs.ReadStream, size: number } }}
   * @throws {MediaNotFoundError} unknown project/asset, asset missing.
   * @throws {MediaUnsupportedError} extension not inline-serveable.
   * @throws {MediaError} storage failure, unreadable source, unsafe path.
   */
  function getOriginalDescriptor(projectId, assetId) {
    let descriptor;
    try {
      descriptor = previewService.getOriginalDescriptor(projectId, assetId);
    } catch (err) {
      if (
        err instanceof PreviewNotFoundError ||
        err instanceof PreviewAccessError
      ) {
        throw new MediaNotFoundError('Asset is not available.');
      }
      throw err;
    }

    const inlineMime = inlineMimeFor(descriptor.extension, descriptor.mimeType);
    if (inlineMime === null) {
      throw new MediaUnsupportedError(
        'Original is not available for this asset type.'
      );
    }

    return {
      filename: descriptor.filename,
      mimeType: inlineMime,
      size: descriptor.size,
      revision: descriptor.revision,
      extension: descriptor.extension,
      openStream: () => {
        let opened;
        try {
          opened = openAssetFile(
            projectsRoot,
            descriptor.projectDir,
            descriptor.relativePath
          );
        } catch (err) {
          // Map source-storage failures to controlled 404.
          if (err instanceof StorageError) {
            throw new MediaNotFoundError('Asset is not available.');
          }
          throw err;
        }

        const fdSize = opened.stat.size;

        try {
          const stream = fs.createReadStream('', {
            fd: opened.handle,
            autoClose: true,
            start: 0,
            end: Math.max(0, fdSize - 1),
          });

          return { stream, size: fdSize };
        } catch (err) {
          closeAssetFile(opened);
          throw err;
        }
      },
    };
  }

  async function prepareDerivativeResponse(kind, projectId, assetId, requestedRevision) {
    const result = await getDerivative(kind, projectId, assetId, requestedRevision);

    if (result.status === 'unsupported') {
      throw new MediaUnsupportedError('Unsupported media type');
    }
    if (result.status !== 'ready') {
      throw new Error(`Unexpected derivative status: ${result.status}`);
    }

    const stream = openDerivativeStream(previewRoot, result.path);
    const cacheControl = derivativeCacheControl(requestedRevision, result.revision);
    const headers = {
      'Content-Type': result.mimeType || 'image/webp',
      'Content-Length': String(result.bytes),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': cacheControl,
    };
    if (cacheControl === CACHE_IMMUTABLE) {
      headers.ETag = buildDerivativeEtag(result.revision, result.bytes);
    }

    return {
      status: 200,
      headers,
      stream,
      cleanup: () => cleanupStream(stream),
    };
  }

  function prepareOriginalResponse(projectId, assetId) {
    const desc = getOriginalDescriptor(projectId, assetId);
    const disposition = buildInlineDisposition(desc.filename);
    const opened = desc.openStream();
    const { stream, size } = opened;

    return {
      status: 200,
      headers: {
        'Content-Type': desc.mimeType,
        'Content-Length': String(size),
        'Content-Disposition': disposition,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': CACHE_ORIGINAL,
        ETag: `W/"${desc.revision}-${size}"`,
      },
      stream,
      cleanup: () => cleanupStream(stream),
    };
  }

  return {
    getDerivative,
    getOriginalDescriptor,
    prepareDerivativeResponse,
    prepareOriginalResponse,
    // Exposed for tests / inspection. Not part of the public route contract.
    _inlineMimeFor: inlineMimeFor,
    _sanitizeDispositionFilename: sanitizeDispositionFilename,
    _buildInlineDisposition: buildInlineDisposition,
  };
}

// Re-exports for routes/tests.
export {
  PreviewError,
  PreviewNotFoundError,
  INLINE_MIME_BY_EXTENSION,
};