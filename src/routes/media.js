// Three narrowly-scoped GET routes for generated derivatives and safe
// original-file serving:
//
//   GET /projects/:projectId/assets/:assetId/thumbnail
//   GET /projects/:projectId/assets/:assetId/preview
//   GET /projects/:projectId/assets/:assetId/original
//
// Comic manifest and numbered-page routes (see "Comic routes" below):
//
//   GET /projects/:projectId/assets/:assetId/comic
//   GET /projects/:projectId/assets/:assetId/comic/pages/:position?v=<revision>
//
// Constraints enforced by this router:
//
//   - Routes contain NO SQL, NO path resolution, NO filesystem access, NO
//     Sharp calls. Every such concern lives in the media service or its
//     storage helpers.
//   - Both IDs are strictly parsed (positive integer, no floats/hex/signs).
//   - Generated derivatives use their validated image MIME type with
//     `X-Content-Type-Options: nosniff` and a version-aware cache policy.
//   - Originals are served inline ONLY when extension and recorded MIME
//     match the PNG/JPEG/WebP/GIF allowlisted pairs, with a sanitized
//     `Content-Disposition: inline` header and `nosniff`. Krita, unknown,
//     missing MIME, octet-stream, and mismatches get 415. Supported WebM/MP4
//     videos (per `classifySupportedVideo`) are also served inline, with
//     single `bytes=` Range support (206/416) for seeking.
//   - Routes pipe only service-prepared streams and call only generic cleanup;
//     no absolute derivative path, source path, or descriptor crosses the
//     media-service boundary.
//   - Unexpected errors reach the global Express error handler. The route
//     only maps known media-service errors to controlled responses.

import express from 'express';
import {
  MediaError,
  MediaNotFoundError,
  MediaUnsupportedError,
  MediaBadRequestError,
} from '../services/media-service.js';
import { COMIC_PAGE_DELIVERY_TYPES, COMIC_REVISION_RE } from '../services/comic-media-service.js';

/**
 * Strict positive-integer parser. Rejects floats, hex, signs, whitespace,
 * and non-numeric strings.
 *
 * @param {string} value
 * @returns {number|null}
 */
function parseStrictInt(value) {
  if (typeof value !== 'string') return null;
  if (!/^[1-9]\d*$/.test(value)) return null;
  return Number(value);
}

/**
 * Bounded revision-token syntax. Matches the server-computed token format
 * (REVISION_TOKEN_RE in preview-cache.js): exactly 16 lowercase hex chars.
 * The client `v` query parameter is normalized against this pattern at the
 * HTTP boundary so only well-formed tokens reach the service layer.
 */
const REQUESTED_REVISION_RE = /^[a-f0-9]{16}$/;

/**
 * Normalize a client-provided revision query parameter to either a valid
 * 16-hex token or null.
 *
 * Handles every malformed shape Express can produce for `req.query.v`:
 *   - repeated keys (Express yields an array)  → null
 *   - empty string                             → null
 *   - invalid characters                       → null
 *   - excessive length                         → null
 *   - non-string types                         → null
 *
 * Invalid tokens are treated as unversioned for cache-policy purposes.
 * The function never throws and never creates unique work for malformed
 * input. The service receives either a valid normalized token or null.
 *
 * @param {unknown} raw - req.query.v
 * @returns {string|null}
 */
function normalizeRequestedRevision(raw) {
  if (typeof raw !== 'string') return null;
  if (!REQUESTED_REVISION_RE.test(raw)) return null;
  return raw;
}

// New preconditions are strict. Legacy `v` remains a cache hint outside the
// explicit optimized mode, including its historical malformed-value handling.
function expectedRevision(raw) {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !REQUESTED_REVISION_RE.test(raw)) {
    throw new MediaBadRequestError('Invalid revision.');
  }
  return raw;
}

// ─── Cache-control policy ──────────────────────────────────────────────────

const CACHE_NO_STORE = 'no-store';

// ─── Shared early-reject for malformed IDs ──────────────────────────────────
//
// Strict ID parsing happens before the service is called. A malformed ID
// is a 404 with no-store + nosniff so rejected requests never mutate a
// cache and never get MIME-sniffed as something else.

function rejectMalformedIds(req, res) {
  const projectId = parseStrictInt(req.params.projectId);
  const assetId = parseStrictInt(req.params.assetId);
  if (projectId === null || assetId === null) {
    res.setHeader('Cache-Control', CACHE_NO_STORE);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.status(404).type('text/plain').send('Not found');
    return null;
  }
  return { projectId, assetId };
}

// ─── Error mapping ─────────────────────────────────────────────────────────
//
// Map known service errors to controlled HTTP responses. Unknown errors
// reach the global handler (caller's `next(err)`).

function mapMediaError(res, err) {
  // All mapped errors are served with no-store so rejected/unsupported
  // responses are never cached immutably. nosniff is set on every response
  // to prevent MIME-sniffing of error bodies.
  const setCommon = (status, body) => {
    res.setHeader('Cache-Control', CACHE_NO_STORE);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.status(status).type('text/plain').send(body);
  };

  if (err instanceof MediaNotFoundError) {
    return setCommon(404, 'Not found');
  }
  if (err instanceof MediaUnsupportedError) {
    return setCommon(415, 'Unsupported media type');
  }
  if (err instanceof MediaBadRequestError) {
    return setCommon(400, 'Bad request');
  }
  if (err instanceof MediaError) {
    const status = err.status || 500;
    return setCommon(status, err.expose ? err.message : 'Media error');
  }
  return null;
}

// ─── Prepared response sender ──────────────────────────────────────────────

function sendPreparedMediaResponse(req, res, next, prepared) {
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (typeof prepared.cleanup === 'function') prepared.cleanup();
  };

  try {
    if (req.aborted || res.destroyed) {
      cleanup();
      return;
    }
    const { stream } = prepared;
    // `stream: null` with 416 is an explicit bodiless response; the service
    // has already released its descriptor.
    if (stream === null && prepared.status === 416) {
      res.status(416);
      for (const [name, value] of Object.entries(prepared.headers || {})) {
        res.setHeader(name, value);
      }
      res.end();
      return;
    }
    if (!stream || typeof stream.pipe !== 'function' || typeof stream.on !== 'function') {
      throw new Error('Media service returned an invalid stream.');
    }

    stream.on('error', (err) => {
      cleanup();
      next(err);
    });
    req.on('aborted', cleanup);
    res.on('close', () => {
      if (!res.writableEnded) cleanup();
    });

    // The service guard survives the prepared-response Promise handoff. Commit
    // comic headers in this same turn, before stream piping can yield again.
    prepared.assertCurrent?.();
    res.status(prepared.status || 200);
    for (const [name, value] of Object.entries(prepared.headers || {})) {
      res.setHeader(name, value);
    }

    if (req.method === 'HEAD') {
      cleanup();
      res.end();
      return;
    }

    if (prepared.assertCurrent) res.flushHeaders();
    stream.pipe(res);
  } catch (err) {
    cleanup();
    if (prepared.assertCurrent && !res.headersSent && mapMediaError(res, err)) return;
    next(err);
  }
}

// ─── Shared derivative handler ─────────────────────────────────────────────

/**
 * Build a handler for /thumbnail or /preview. Both share the same caching
 * and response shape; only the service method differs.
 *
 * @param {'thumbnail'|'preview'} kind
 * @param {import('../services/media-service.js').MediaService} mediaService
 */
function makeDerivativeHandler(kind, mediaService) {
  return async (req, res, next) => {
    const ids = rejectMalformedIds(req, res);
    if (ids === null) return;
    const { projectId, assetId } = ids;

    const watch = watchClientDisconnect(req, res);
    let prepared;
    try {
      const optimized = kind === 'preview' && req.query.rendition === 'optimized';
      if (req.query.rendition !== undefined && !optimized) {
        throw new MediaBadRequestError('Invalid rendition.');
      }
      const sourceRevision = expectedRevision(req.query.sourceRevision);
      if (sourceRevision !== undefined && !optimized) {
        throw new MediaBadRequestError('Source revision requires an explicit rendition.');
      }
      const requestedRevision = optimized
        ? expectedRevision(req.query.v) : normalizeRequestedRevision(req.query.v);
      prepared = await mediaService.prepareDerivativeResponse(
        kind,
        projectId,
        assetId,
        requestedRevision,
        { optimized, expectedSourceRevision: sourceRevision, signal: watch.signal, query: req.query }
      );
    } catch (err) {
      if (watch.gone()) return;
      const mapped = mapMediaError(res, err);
      if (mapped) return;
      return next(err);
    } finally { watch.release(); }
    if (watch.gone()) { prepared?.cleanup?.(); return; }
    return sendPreparedMediaResponse(req, res, next, prepared);
  };
}

// ─── Original handler ──────────────────────────────────────────────────────

function makeOriginalHandler(mediaService) {
  return (req, res, next) => {
    const ids = rejectMalformedIds(req, res);
    if (ids === null) return;
    const { projectId, assetId } = ids;

    let prepared;
    try {
      prepared = mediaService.prepareOriginalResponse(projectId, assetId, {
        range: req.headers.range,
        ifRange: req.headers['if-range'],
        expectedSourceRevision: expectedRevision(req.query.sourceRevision),
      });
    } catch (err) {
      const mapped = mapMediaError(res, err);
      if (mapped) return;
      return next(err);
    }

    return sendPreparedMediaResponse(req, res, next, prepared);
  };
}

// ─── Comic routes (A3.3c-2) ────────────────────────────────────────────────
//
// Thin HTTP adapters over the application graph's one comic media service
// (comic-media-service.js, built by createApp with the shared comic runtime's
// admission and recovered preparation cache). The routes never open, list or
// decode an archive themselves: authorization, source revision, admission,
// bounded extraction, preparation and rendition all stay in the service. The
// only inputs are the two IDs, a 1-based page number and the manifest's
// revision; no member path or selector is ever accepted.
//
// Caching: both responses are `no-store`. A page URL names a revision, but the
// service re-authorizes and re-proves the source on every request (a stale
// revision is an explicit 409, never another revision's page), and the
// revision token cannot prove absolute content identity, so no browser or
// intermediary copy may stand in for that check.

/**
 * Same-origin page URL for one numbered page of a manifest revision. Every
 * component is server-issued (integers and a 32-hex revision) and encoded.
 */
function comicPageUrl(projectId, assetId, position, revision) {
  return `/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}`
    + `/comic/pages/${encodeURIComponent(position)}?v=${encodeURIComponent(revision)}`;
}

/**
 * Public manifest projection. Keeps only what a viewer needs: identity,
 * format, revision, ordered numbered pages (display name, availability and
 * page URL) and the display image types. Member paths, entry indexes, sizes,
 * containers and source MIME declarations stay inside the service.
 */
function publicComicManifest(manifest, projectId, assetId) {
  if (manifest.projectId !== projectId || manifest.assetId !== assetId
    || typeof manifest.revision !== 'string' || !COMIC_REVISION_RE.test(manifest.revision)
    || !Number.isSafeInteger(manifest.pageCount) || manifest.pages.length !== manifest.pageCount) {
    throw new Error('Comic media service returned an invalid manifest.');
  }
  const { revision } = manifest;
  const pages = manifest.pages.map((page, index) => {
    if (page.position !== index + 1) throw new Error('Comic manifest pages are not numbered in order.');
    return {
      position: page.position,
      name: page.name,
      available: page.available === true,
      problem: page.problem ?? null,
      url: comicPageUrl(projectId, assetId, page.position, revision),
    };
  });
  return {
    projectId,
    assetId,
    format: manifest.format,
    revision,
    pageCount: manifest.pageCount,
    displayImageTypes: [...manifest.deliveryImageTypes],
    preparation: {
      solid: manifest.preparation.solid === true,
      state: manifest.preparation.state,
    },
    unavailablePositions: [...manifest.unavailablePositions],
    pages,
  };
}

/**
 * Abort the service call when the client goes away before the response is
 * written. `close` on the response is the established signal (see
 * sendPreparedMediaResponse): a completed response has `writableEnded` set,
 * so normal completion is never mistaken for a disconnect. The listener is
 * removed as soon as the service settles, so nothing retains req/res.
 * Background preparations run under the cache's own signal and are never
 * cancelled by this one.
 */
function watchClientDisconnect(req, res) {
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.once('close', onClose);
  if (res.destroyed || req.socket?.destroyed) controller.abort();
  return {
    signal: controller.signal,
    gone: () => controller.signal.aborted || res.destroyed,
    release: () => res.off('close', onClose),
  };
}

function rejectComicUnavailable(res) {
  // This graph has no comic service (rootless or test-only application).
  res.setHeader('Cache-Control', CACHE_NO_STORE);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.status(404).type('text/plain').send('Not found');
}

function respondComicError(req, res, next, err, watch) {
  // Nothing can be written to a client that went away; the service has
  // already released its admission, descriptor and leases.
  if (watch.gone()) return undefined;
  if (err instanceof MediaError && err.status >= 500 && err.status !== 503) {
    try {
      req.app.locals.applicationLogger?.error?.({
        kind: 'diagnostic',
        subsystem: 'comics',
        event: 'comics.http.failed',
        message: 'A comic request failed unexpectedly.',
        error: err.cause ?? err,
      });
    } catch {
      // Diagnostics must not change the response.
    }
  }
  if (mapMediaError(res, err)) return undefined;
  return next(err);
}

function makeComicManifestHandler(comicMediaService) {
  return async (req, res, next) => {
    const ids = rejectMalformedIds(req, res);
    if (ids === null) return undefined;
    if (!comicMediaService) return rejectComicUnavailable(res);
    const { projectId, assetId } = ids;

    const watch = watchClientDisconnect(req, res);
    let manifest;
    try {
      manifest = await comicMediaService.getComicManifest(projectId, assetId, { signal: watch.signal });
    } catch (err) {
      return respondComicError(req, res, next, err, watch);
    } finally {
      watch.release();
    }
    if (watch.gone()) return undefined;

    let body;
    try {
      body = publicComicManifest(manifest, projectId, assetId);
    } catch (err) {
      return next(err);
    }
    res.setHeader('Cache-Control', CACHE_NO_STORE);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.status(200).json(body);
  };
}

function makeComicPageHandler(comicMediaService) {
  return async (req, res, next) => {
    const ids = rejectMalformedIds(req, res);
    if (ids === null) return undefined;
    if (!comicMediaService) return rejectComicUnavailable(res);
    const { projectId, assetId } = ids;

    // Malformed values reach the service as null, which refuses them
    // (REVISION_INVALID / PAGE_INVALID_POSITION → 400) before any
    // authorization, admission or file access. A missing revision is never
    // replaced by the current one.
    const position = parseStrictInt(req.params.position);
    const revision = typeof req.query.v === 'string' ? req.query.v : null;

    const watch = watchClientDisconnect(req, res);
    let page;
    try {
      page = await comicMediaService.getComicPage(projectId, assetId, {
        revision,
        position,
        signal: watch.signal,
      });
    } catch (err) {
      return respondComicError(req, res, next, err, watch);
    } finally {
      watch.release();
    }
    if (watch.gone()) return undefined;

    if (!Buffer.isBuffer(page?.bytes) || !COMIC_PAGE_DELIVERY_TYPES.includes(page.mimeType)
      || page.revision !== revision || page.position !== position) {
      return next(new Error('Comic media service returned an invalid page.'));
    }
    res.status(200);
    res.setHeader('Content-Type', page.mimeType);
    res.setHeader('Content-Length', String(page.bytes.length));
    res.setHeader('Cache-Control', CACHE_NO_STORE);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method === 'HEAD') return res.end();
    return res.end(page.bytes);
  };
}

// ─── Router factory ───────────────────────────────────────────────────────

/**
 * Create the media router, mounted at /projects.
 *
 * Routes (with mergeParams so :projectId/:assetId from the mount point
 * work):
 *
 *   GET /projects/:projectId/assets/:assetId/thumbnail
 *   GET /projects/:projectId/assets/:assetId/preview
 *   GET /projects/:projectId/assets/:assetId/original
 *   GET /projects/:projectId/assets/:assetId/comic
 *   GET /projects/:projectId/assets/:assetId/comic/pages/:position
 *
 * The order matters: these three routes are more specific than the later
 * `GET /projects/:projectId/assets/:assetId` detail route (4 segments vs
 * 3), so they are matched first by Express without conflict.
 *
 * The comic routes have five and six segments and literal `comic`/`pages`
 * parts, so they cannot shadow (or be shadowed by) the routes above or the
 * asset detail/tag routes.
 *
 * @param {object} deps
 * @param {import('../services/media-service.js').MediaService|null} [deps.mediaService]
 * @param {object|null} [deps.comicMediaService] - the graph's comic media service
 *   (app.locals.comicMediaService); null answers the comic routes 404.
 */
export function createMediaRouter({ mediaService = null, comicMediaService = null } = {}) {
  if (!mediaService && !comicMediaService) throw new TypeError('mediaService is required');
  const router = express.Router({ mergeParams: true });

  router.get('/:projectId/assets/:assetId/comic', makeComicManifestHandler(comicMediaService));
  router.get('/:projectId/assets/:assetId/comic/pages/:position', makeComicPageHandler(comicMediaService));

  if (!mediaService) return router;

  router.get(
    '/:projectId/assets/:assetId/thumbnail',
    makeDerivativeHandler('thumbnail', mediaService)
  );
  router.get(
    '/:projectId/assets/:assetId/preview',
    makeDerivativeHandler('preview', mediaService)
  );
  router.get(
    '/:projectId/assets/:assetId/original',
    makeOriginalHandler(mediaService)
  );

  return router;
}