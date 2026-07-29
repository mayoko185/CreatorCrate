// Phase 10.1C — Media routes
//
// Three narrowly-scoped GET routes for generated derivatives and safe
// original-file serving:
//
//   GET /projects/:projectId/assets/:assetId/thumbnail
//   GET /projects/:projectId/assets/:assetId/preview
//   GET /projects/:projectId/assets/:assetId/original
//
// Constraints enforced by this router:
//
//   - Routes contain NO SQL, NO path resolution, NO filesystem access, NO
//     Sharp calls. Every such concern lives in the media service or its
//     storage helpers.
//   - Both IDs are strictly parsed (positive integer, no floats/hex/signs).
//   - Generated derivatives are served as `image/webp` with
//     `X-Content-Type-Options: nosniff` and a version-aware cache policy.
//   - Originals are served inline ONLY when extension and recorded MIME
//     match the PNG/JPEG/WebP/GIF allowlisted pairs, with a sanitized
//     `Content-Disposition: inline` header and `nosniff`. Krita, unknown,
//     missing MIME, octet-stream, and mismatches get 415.
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
    const { stream } = prepared;
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

    res.status(prepared.status || 200);
    for (const [name, value] of Object.entries(prepared.headers || {})) {
      res.setHeader(name, value);
    }

    if (req.method === 'HEAD') {
      cleanup();
      res.end();
      return;
    }

    stream.pipe(res);
  } catch (err) {
    cleanup();
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

    const requestedRevision = normalizeRequestedRevision(req.query.v);

    let prepared;
    try {
      prepared = await mediaService.prepareDerivativeResponse(
        kind,
        projectId,
        assetId,
        requestedRevision
      );
    } catch (err) {
      const mapped = mapMediaError(res, err);
      if (mapped) return;
      return next(err);
    }

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
      prepared = mediaService.prepareOriginalResponse(projectId, assetId);
    } catch (err) {
      const mapped = mapMediaError(res, err);
      if (mapped) return;
      return next(err);
    }

    return sendPreparedMediaResponse(req, res, next, prepared);
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
 *
 * The order matters: these three routes are more specific than the later
 * `GET /projects/:projectId/assets/:assetId` detail route (4 segments vs
 * 3), so they are matched first by Express without conflict.
 *
 * @param {object} deps
 * @param {import('../services/media-service.js').MediaService} deps.mediaService
 */
export function createMediaRouter({ mediaService }) {
  if (!mediaService) throw new TypeError('mediaService is required');
  const router = express.Router({ mergeParams: true });

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