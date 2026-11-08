// A3.3a — Comic media service (internal; no HTTP routes yet)
//
// Connects the A3 comic archive readers (cbz-page-reader.js, cbr-cb7-page-reader.js) to the
// established media-service architecture:
//
//   - Authority: the comic is resolved through `previewService.getOriginalDescriptor`, the same
//     project/asset ownership check the original/derivative media routes use (project exists
//     and has a directory, asset exists, belongs to the project and is present). Archived
//     projects stay readable exactly as they are for other media. The asset must be a comic by
//     A2's `classifyComicAsset` (extension only: legacy CBR rows with a generic MIME still
//     qualify, a generic .zip/.rar/.7z never does). The recorded MIME is never proof of
//     validity: the archive readers stay authoritative.
//   - Source: the original is opened only through `openAssetFileAsync` (containment, symlink
//     refusal, read-only, regular-file fstat) and the descriptor is closed in `finally` after the
//     reader has settled. No path or member path is ever accepted as input.
//   - Errors: outcomes are thrown as the existing media-service error classes (MediaError and
//     its subclasses) with an added stable `code` (and `reason` for archive/page failures), so
//     A3.3c's route maps them with the existing `mapMediaError`. Messages are fixed text; no
//     filesystem path, member path or decoder diagnostic is exposed. The original error stays
//     on `cause` for server-side logging only.
//
// Source revision
// ---------------
// A manifest's `revision` is 32 lowercase hex characters: two 64-bit halves of SHA-256 digests.
//
//   identity half: the indexed asset revision (`buildAssetRevision`: project, asset, relative
//     path, recorded size/mtime and the durable `source_generation`) plus the opened
//     descriptor's nanosecond fstat identity (dev, ino, size, mtime, ctime).
//   catalog half: the ordered page catalog the reader built from those bytes (format,
//     container, solidity, entry count, and per page its member identity, sizes, CRC32,
//     timestamp and problem code).
//
// A page request recomputes the identity half from a fresh database read and a fresh open
// before any decoding, and the catalog half from the catalog the same reader call selected the
// page from. After reading (and rendering) it re-proves that the descriptor, the path and the
// database row are all unchanged. So a page is only returned when it comes from the same
// indexed source, the same file instance and the same catalog the manifest described.
//
// ctime is included because an in-place rewrite that restores size and mtime (utimes) still
// updates ctime on POSIX and NTFS. Residual limits (not claimed as protected): a filesystem
// that does not maintain ctime, or a rewrite completing within the timestamp granularity, that
// also leaves the catalog identical (same member names, sizes and CRC32s) is not detected by
// the token itself. CBZ pages are still CRC-verified on every read and 7-Zip verifies CRCs for
// RAR4/7z, so such bytes fail as a corrupt page rather than mixing silently; RAR5 stores BLAKE2
// rather than CRC32, so for RAR5 the catalog half covers names, sizes and timestamps only.
//
// Renditions
// ----------
// Every page is fully decoded before it is returned (header checks are not enough): a valid
// static page within the rendition bounds is returned unchanged; animated GIF/WebP pages are
// rendered as their first frame; pages over the pixel/byte bounds are downscaled preserving
// aspect ratio. The algorithm runs with Sharp (failOn 'error', an input pixel limit, Sharp's
// timeout and the shared `sharpRuntime` configuration) in a disposable child process per page
// (F1a: comic-rendition-process.js / comic-rendition-child.js), because a native Sharp operation
// cannot be interrupted in-process. A request's cancellation or the rendition deadline kills the
// child, and the request settles only after the child is confirmed gone, so its admission is
// never released while that native work could still be running.
//
// Admission (A3.3b-1)
// -------------------
// Every manifest and page read runs inside the shared comic admission (comic-admission.js):
// arguments and authority are checked first (no descriptor, no queue slot), then the request
// waits for admission with its estimated weight, and only the admitted task authorizes again,
// opens the source and reads. The admission is released when that task settles. The
// application passes one admission to every service it builds (`deps.admission`); a service
// built without one owns a private default, like preview-service's processing pool.
//
// Solid preparation (A3.3b-2)
// ---------------------------
// With an application preparation cache (`deps.preparationCache`, comic-preparation-cache.js),
// solid CBR/CB7 comics are prepared once in the background (prepareSolidCbrCb7) and later pages
// are served from the verified preparation instead of decoding the solid prefix again. CBZ and
// non-solid CBR/CB7 never use it. Preparation is triggered only by a successful page read (never
// by a manifest, a scan or a listing), runs in the admission's background lane, and never delays
// a page: until it is ready, and whenever it is unavailable, pages are read on demand as before.
//
// A page is served from a preparation only when, inside the same admitted request, the source
// was authorized and opened again, its identity (indexed row incl. source_generation, plus the
// opened file's dev/ino/size/mtime/ctime) equals exactly the identity the preparation was made
// from, and the requested revision equals the preparation's revision (identity + catalog). The
// page bytes are re-checked against their SHA-256 (and CRC32) by the preparation's read(), fully
// decoded by the same rendition step, and the source is re-proven unchanged afterwards. A
// changed preparation is retired and the page is read on demand.
//
// Metadata alone is not trusted as proof that the archive is unchanged (an equal-sized
// replacement can keep inode and mtime, and some filesystems do not maintain ctime). So, after
// rendition and before the final source re-check, a prepared page is published only when the
// archive's current catalog, listed afresh from the same opened descriptor by the same bounded
// inspection a manifest uses (inspectCbrCb7: headers only, no member is extracted), still yields
// the requested revision. Otherwise the request fails REVISION_STALE, exactly like an on-demand
// read of that revision, and the preparation is retired; a page is never taken from another
// revision. Not claimed: that a preparation (or a page's SHA-256) proves the archive bytes are
// unchanged. The residual case is a rewrite that keeps size, inode, mtime and ctime and also
// leaves every catalog field identical (names, sizes, CRC32s/timestamps): that is not detected by
// the cache, as it is not by the revision token (see "Source revision").
//
// HTTP routes and application wiring are A3.3c.
//
// Graph maintenance (F2)
// ----------------------
// A service belongs to one application graph: its authority (previewService) reads that graph's
// database. The shared admission, rendition supervisor and preparation cache outlive graphs, so
// a request or preparation could otherwise wait in them past a live restore that closes that
// database. The application context therefore includes this service in the same maintenance
// pause as the graph's other background work (app-context.js pauseGeneratedImageWork):
//   - pauseForMaintenance() refuses new operations of this graph (foreground: 503 BUSY with
//     reason MAINTENANCE; background preparation: an unrecorded MAINTENANCE cache failure) and
//     aborts every operation already started, queued or admitted, through the same signal the
//     request's own cancellation uses. Its waitForIdle() resolves only when every operation of
//     this graph has settled: admission released, descriptor closed, decoder worker disposed and
//     rendition child confirmed gone (each operation is counted until its admitted task settles).
//     The context awaits it before maintenance begins, so the database is retired only after
//     this graph has stopped using it. release() lets the graph serve again (failed or refused
//     restore). isIdle() reports the same count synchronously, for the context's synchronous
//     replacement acquisition, which cannot await and so refuses while it is not idle.
//   - stop() retires the graph permanently when the context publishes its replacement; a
//     retired graph never serves or prepares again. Nothing authorized by it is carried over:
//     the replacement graph authorizes every request afresh, and preparations stay bound to
//     their exact source identity and revision (see above).
// An operation interrupted by maintenance never publishes a result, even one that completed.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { closeAssetFileAsync, openAssetFileAsync } from '../storage/asset-file.js';
import { StorageError } from '../storage/path-manager.js';
import { classifyComicAsset } from './asset-metadata.js';
import { ArchiveDecoderError, assertOpenedArchiveUnchanged } from './archive-member-decoder.js';
import { ComicAdmissionError, createComicAdmission, estimateComicOperationBytes } from './comic-admission.js';
import { CBZ_READER_LIMITS, inspectCbz, readCbzPage } from './cbz-page-reader.js';
import { CBR_CB7_READER_LIMITS, inspectCbrCb7, readCbrCb7Page } from './cbr-cb7-page-reader.js';
import { prepareSolidCbrCb7 } from './cbr-cb7-preparation.js';
import { ComicPreparationCacheError } from './comic-preparation-cache.js';
import {
  COMIC_RENDITION_PROTOCOL,
  ComicRenditionProcessError,
  defaultComicRenditionSupervisor,
} from './comic-rendition-process.js';
import {
  MediaBadRequestError,
  MediaError,
  MediaNotFoundError,
  MediaUnavailableError,
  MediaUnsupportedError,
} from './media-service.js';
import { PreviewAccessError, PreviewNotFoundError } from './preview-service.js';

const MIB = 1024 * 1024;

export const COMIC_REVISION_RE = /^[0-9a-f]{32}$/;
const REVISION_VERSION = 1;

/**
 * Rendition bounds. A page larger than maxPixels (or, for WebP output, than libwebp's
 * 16,383-pixel edge) is downscaled; an output larger than maxOutputBytes is refused. Input
 * bounds (bytes, dimensions, pixels) are the readers' own limits, applied before this.
 * timeoutSeconds is both Sharp's conversion timeout in the child and the parent-owned elapsed
 * deadline of the whole rendition (child startup, transfers, metadata, stats, conversion).
 */
export const COMIC_RENDITION_LIMITS = Object.freeze({
  maxPixels: 25_000_000,
  maxOutputBytes: 32 * MIB,
  maxWebpDimension: 16_383,
  timeoutSeconds: 30,
});

// Image types a comic page may be stored as, and the types a rendition is delivered as.
export const COMIC_PAGE_SOURCE_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
export const COMIC_PAGE_DELIVERY_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

// ─── Outcomes ────────────────────────────────────────────────────────────────────────────

// Built on the existing media error classes so the route layer's mapMediaError applies.
function outcome(ErrorClass, code, message, { reason = null, cause } = {}) {
  const err = new ErrorClass(message);
  err.code = code;
  if (reason) err.reason = reason;
  if (cause !== undefined) err.cause = cause;
  return err;
}

function statusOutcome(status, code, message, { reason = null, cause, expose = true } = {}) {
  const err = new MediaError(status, message, { expose });
  err.name = 'ComicMediaError';
  err.code = code;
  if (reason) err.reason = reason;
  if (cause !== undefined) err.cause = cause;
  return err;
}

const notFound = (code, cause) => outcome(MediaNotFoundError, code, 'Comic is not available.', { cause });
const sourceChanged = (cause) => statusOutcome(409, 'SOURCE_CHANGED',
  'The comic has changed since it was indexed.', { cause });
const revisionStale = (cause) => statusOutcome(409, 'REVISION_STALE',
  'The comic has changed; reload its pages.', { cause });
const cancelled = (cause) => outcome(MediaUnavailableError, 'CANCELLED', 'Comic reading was cancelled.', { cause });
const internal = (cause) => statusOutcome(500, 'INTERNAL', 'Comic media error', { cause, expose: false });
const pageUnavailable = (reason, cause) => statusOutcome(422, 'PAGE_UNAVAILABLE',
  'This page cannot be displayed.', { reason, cause });
// Admission refused (QUEUE_FULL) or the wait ran out (ADMISSION_TIMEOUT): retry later. Distinct
// from DECODER_UNAVAILABLE, which reports a decoder that ran and failed.
const busy = (reason, cause) => outcome(MediaUnavailableError, 'BUSY', 'Comics are busy; try again shortly.',
  { reason, cause });
// F2: this graph is paused or retired for database/auth replacement; retry once it is over.
const maintenance = (cause) => busy('MAINTENANCE', cause);
const preparationMaintenance = () => new ComicPreparationCacheError('MAINTENANCE',
  'Comic preparation stopped for application maintenance.');

// Codes that describe the archive as a whole (the comic cannot be opened at all).
const ARCHIVE_CODES = new Set([
  'ARCHIVE_CORRUPT', 'ARCHIVE_ENCRYPTED', 'ARCHIVE_ENTRY_UNSAFE', 'ENTRY_LIMIT_EXCEEDED',
  'INPUT_LIMIT_EXCEEDED', 'PAGE_LIMIT_EXCEEDED', 'UNSUPPORTED_FORMAT', 'LISTING_LIMIT_EXCEEDED',
  'ARCHIVE_ENTRY_AMBIGUOUS', 'ARCHIVE_MULTIVOLUME',
]);
// Codes that describe one page; its position stays and other pages remain readable.
const PAGE_CODES = new Set([
  'PAGE_CORRUPT', 'PAGE_INVALID_IMAGE', 'IMAGE_LIMIT_EXCEEDED', 'MEMBER_LIMIT_EXCEEDED',
  'UNSUPPORTED_COMPRESSION', 'EXTRACTION_FAILED', 'OUTPUT_LIMIT_EXCEEDED',
]);
// Decoder or resource failures: retrying later may succeed.
const RESOURCE_CODES = new Set([
  'TIMEOUT', 'MEMORY_LIMIT_EXCEEDED', 'DECODER_FAILED', 'DECODER_UNAVAILABLE', 'PROTOCOL_ERROR',
  'LOG_LIMIT_EXCEEDED', 'OUTPUT_WRITE_FAILED', 'INPUT_UNAVAILABLE',
]);

/**
 * Map a reader/decoder failure to a comic outcome. `stage` is 'manifest' or 'page'.
 * EXPANSION_LIMIT_EXCEEDED is archive-level while cataloging; during a page read whose
 * revision was already proven against a manifest, the archive-level variant cannot recur for
 * the same bytes, so there it is the page's own ratio problem.
 */
function fromArchiveError(err, stage) {
  if (err instanceof MediaError) return err;
  if (err instanceof ComicAdmissionError) {
    return err.code === 'CANCELLED' ? cancelled(err) : busy(err.code, err);
  }
  if (!(err instanceof ArchiveDecoderError)) return internal(err);
  const { code } = err;
  if (code === 'CANCELLED') return cancelled(err);
  if (code === 'INPUT_CHANGED') return revisionStale(err);
  if (code === 'PAGE_NOT_FOUND') return notFound('PAGE_NOT_FOUND', err);
  if (PAGE_CODES.has(code) || (stage === 'page' && code === 'EXPANSION_LIMIT_EXCEEDED')) {
    return pageUnavailable(code === 'EXTRACTION_FAILED' || code === 'OUTPUT_LIMIT_EXCEEDED' ? 'PAGE_CORRUPT' : code, err);
  }
  if (ARCHIVE_CODES.has(code) || code === 'EXPANSION_LIMIT_EXCEEDED') {
    return statusOutcome(422, 'COMIC_UNREADABLE', 'The comic archive cannot be read.', { reason: code, cause: err });
  }
  if (RESOURCE_CODES.has(code)) {
    return outcome(MediaUnavailableError, 'DECODER_UNAVAILABLE', 'The comic cannot be read right now.',
      { reason: code === 'INPUT_UNAVAILABLE' ? 'SOURCE_UNAVAILABLE' : code, cause: err });
  }
  return internal(err);
}

// ─── Limits ──────────────────────────────────────────────────────────────────────────────

// Overrides may only tighten a default; nothing here can raise a reader or rendition bound.
function tightenOnly(defaults, overrides, label) {
  const result = {};
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (!Object.hasOwn(defaults, key)) throw new TypeError(`Unknown ${label} limit: ${key}`);
    if (!Number.isSafeInteger(value) || value < 1 || value > defaults[key]) {
      throw new TypeError(`Invalid ${label} limit: ${key}`);
    }
    result[key] = value;
  }
  return result;
}

// ─── Revision ────────────────────────────────────────────────────────────────────────────

function digest16(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function bigintIdentity(stat) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  };
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function identityValue(source) {
  return {
    v: REVISION_VERSION,
    projectId: source.projectId,
    assetId: source.assetId,
    format: source.format,
    indexed: source.indexedRevision,
    file: source.identity,
  };
}

function identityHalf(source) {
  return digest16(identityValue(source));
}

// The full (untruncated) identity a preparation is bound to; compared exactly, never hashed.
function identityKeyOf(source) {
  return JSON.stringify(identityValue(source));
}

// Latest of mtime and ctime, in milliseconds (for the cache's settle rule).
function changedAtMs(identity) {
  const mtime = BigInt(identity.mtimeNs);
  const ctime = BigInt(identity.ctimeNs);
  return Number((mtime > ctime ? mtime : ctime) / 1_000_000n);
}

function catalogHalf(catalog) {
  return digest16({
    v: REVISION_VERSION,
    format: catalog.format,
    container: catalog.container ?? 'zip',
    solid: Boolean(catalog.solid),
    entryCount: catalog.entryCount,
    pages: catalog.pages.map((page) => [
      page.position, page.member.entryIndex, page.member.path, page.uncompressedSize,
      page.compressedSize ?? null, page.crc32 ?? null, page.modified ?? null, page.problem ?? null,
    ]),
  });
}

// ─── Rendition ───────────────────────────────────────────────────────────────────────────

// Process-level rendition failures are resources that failed, not verdicts on the page.
const renditionUnavailable = (reason, cause) => outcome(MediaUnavailableError, 'DECODER_UNAVAILABLE',
  'The comic cannot be read right now.', { reason, cause });

function fromRenditionError(err, signal) {
  if (!(err instanceof ComicRenditionProcessError)) return internal(err);
  switch (err.code) {
    case 'CANCELLED':
      return cancelled(err);
    // A failure of a rendition the client no longer waits for is reported as the cancellation.
    case 'PAGE_INVALID_IMAGE':
      return signal?.aborted ? cancelled(err) : pageUnavailable('PAGE_INVALID_IMAGE', err);
    case 'RENDITION_LIMIT_EXCEEDED':
    case 'OUTPUT_LIMIT_EXCEEDED':
      return pageUnavailable('RENDITION_LIMIT_EXCEEDED', err);
    case 'INPUT_LIMIT_EXCEEDED':
      return pageUnavailable('MEMBER_LIMIT_EXCEEDED', err);
    case 'TIMEOUT':
      return renditionUnavailable('TIMEOUT', err);
    case 'CLOSED':
      return renditionUnavailable('RENDITION_CLOSED', err);
    case 'PROTOCOL_ERROR':
    case 'JOB_INVALID':
      return renditionUnavailable('PROTOCOL_ERROR', err);
    default:
      // STARTUP_FAILED, CHILD_EXITED, IPC_FAILED, INTERNAL.
      return signal?.aborted ? cancelled(err) : renditionUnavailable('DECODER_FAILED', err);
  }
}

/**
 * Produce a bounded, browser-compatible still image from a page the reader already validated
 * at header level (`image` from inspectImage). The rendition runs in a disposable child process
 * (comic-rendition-child.js) that fully decodes the first frame (failOn 'error'), so truncated
 * or invalid pixel data fails there even when the header was valid. A valid static page within
 * the bounds comes back as "unchanged" and `bytes` itself is returned; it is never sent back.
 *
 * Cancellation (`signal`) and the deadline (`limits.timeoutSeconds`, parent-owned, monotonic):
 * an already-aborted signal starts no child; an abort or an expired deadline kills the child
 * at once, wherever its native work is (metadata, stats or conversion), and this rejects with
 * CANCELLED or DECODER_UNAVAILABLE/TIMEOUT only after the child is confirmed gone. A result
 * that arrives after either is discarded. The caller keeps its admission slot until then.
 * `onPhase` (test-only) is called when the child reports that a native operation ('metadata',
 * 'stats', 'convert') has started.
 *
 * @param {Buffer} bytes
 * @param {object} image
 * @param {{ maxInputPixels?: number, limits?: object, signal?: AbortSignal,
 *   onPhase?: (phase: string) => void, renditions?: object }} [options] - `renditions` is the
 *   owning supervisor (comic-rendition-process.js); defaults to the process-wide one.
 * @returns {Promise<{ bytes: Buffer, mimeType: string, width: number, height: number, converted: boolean }>}
 */
export async function renderComicPageStill(bytes, image, {
  maxInputPixels, limits = COMIC_RENDITION_LIMITS, signal, onPhase, renditions,
} = {}) {
  if (signal?.aborted) throw cancelled();
  if (bytes.length > COMIC_RENDITION_PROTOCOL.maxInputBytes) throw pageUnavailable('MEMBER_LIMIT_EXCEEDED');
  const supervisor = renditions ?? defaultComicRenditionSupervisor();
  let result;
  try {
    result = await supervisor.run({
      bytes,
      image: { format: image.format, width: image.width, height: image.height, animated: Boolean(image.animated) },
      maxInputPixels: maxInputPixels ?? CBZ_READER_LIMITS.maxImagePixels,
      limits: {
        maxPixels: limits.maxPixels,
        maxOutputBytes: limits.maxOutputBytes,
        maxWebpDimension: limits.maxWebpDimension,
        timeoutSeconds: limits.timeoutSeconds,
      },
    }, { signal, deadlineMs: limits.timeoutSeconds * 1000, onPhase });
  } catch (err) {
    throw fromRenditionError(err, signal);
  }
  // The supervisor already refuses a result accepted after an abort; checked here as well.
  if (signal?.aborted) throw cancelled();
  if (result.unchanged) {
    return { bytes, mimeType: result.mimeType, width: result.width, height: result.height, converted: false };
  }
  return { bytes: result.bytes, mimeType: result.mimeType, width: result.width, height: result.height, converted: true };
}

// ─── Service ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} deps
 * @param {import('./preview-service.js').PreviewService} deps.previewService - established
 *   project/asset authority (getOriginalDescriptor).
 * @param {string} deps.projectsRoot
 * @param {object} [deps.readerLimits] - tighten-only reader overrides (shared CBZ/CBR/CB7 keys).
 * @param {object} [deps.renditionLimits] - tighten-only COMIC_RENDITION_LIMITS overrides.
 * @param {object} [deps.admission] - the application's shared comic admission
 *   (createComicAdmission). Defaults to one owned by this service.
 * @param {object} [deps.preparationCache] - the application's solid preparation cache
 *   (createComicPreparationCache). Without one, solid comics are always read on demand.
 * @param {object} [deps.renditions] - the application's rendition process supervisor
 *   (createComicRenditionSupervisor, owned by the comic runtime). Defaults to the process-wide one.
 * @param {object} [deps._hooks] - test-only timing hooks ({ afterRead, beforePrepare, preparedRead,
 *   catalogChecked, renditionPhase }).
 */
export function createComicMediaService({
  previewService, projectsRoot, readerLimits, renditionLimits, admission, preparationCache, renditions, _hooks,
} = {}) {
  if (!previewService || typeof previewService.getOriginalDescriptor !== 'function') {
    throw new TypeError('previewService is required');
  }
  if (!projectsRoot) throw new TypeError('projectsRoot is required');
  if (admission !== undefined && typeof admission?.run !== 'function') {
    throw new TypeError('admission must be a comic admission with run().');
  }
  const comicAdmission = admission ?? createComicAdmission();
  if (renditions !== undefined && typeof renditions?.run !== 'function') {
    throw new TypeError('renditions must be a comic rendition supervisor with run().');
  }
  const renditionSupervisor = renditions ?? defaultComicRenditionSupervisor();
  const cache = preparationCache ?? null;
  if (cache !== null) {
    for (const method of ['schedule', 'lease', 'state', 'invalidate', 'protects']) {
      if (typeof cache[method] !== 'function') throw new TypeError('preparationCache must be a comic preparation cache.');
    }
    // Derived data never lives inside the projects tree. The cache enforces this physically
    // (through junctions, symlinked ancestors and aliases) before every reservation and removal,
    // so it must have been built protecting this projects root; this lexical check only refuses
    // an obviously wrong configuration early.
    if (!cache.protects(projectsRoot)) {
      throw new TypeError('The preparation cache does not protect this projects root.');
    }
    const fold = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
    const relative = path.relative(fold(path.resolve(projectsRoot)), fold(path.resolve(String(cache.stagingRoot))));
    if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      throw new TypeError('The preparation cache must not be inside the projects root.');
    }
  }

  const cbzLimits = tightenOnly(CBZ_READER_LIMITS, pick(readerLimits, CBZ_READER_LIMITS), 'reader');
  const cbrCb7Limits = tightenOnly(CBR_CB7_READER_LIMITS, pick(readerLimits, CBR_CB7_READER_LIMITS), 'reader');
  for (const key of Object.keys(readerLimits ?? {})) {
    if (!Object.hasOwn(CBZ_READER_LIMITS, key) && !Object.hasOwn(CBR_CB7_READER_LIMITS, key)) {
      throw new TypeError(`Unknown reader limit: ${key}`);
    }
  }
  const rendition = Object.freeze({
    ...COMIC_RENDITION_LIMITS,
    ...tightenOnly(COMIC_RENDITION_LIMITS, renditionLimits, 'rendition'),
  });
  const hooks = _hooks || {};

  // ── Graph maintenance (F2) ──────────────────────────────────────────────────────────────

  // Aborted while this graph is paused or once it is stopped; replaced when the last pause is
  // released. Every operation's signal follows it as well as the caller's own signal.
  let graphController = new AbortController();
  let pauses = 0;
  let stopped = false;
  let operations = 0;
  const idleWaiters = new Set();

  function waitForIdle() {
    if (operations === 0) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.add(resolve));
  }

  // Synchronous form of waitForIdle(): true only when no operation of this graph is queued,
  // admitted or still settling (the same count waitForIdle() resolves on).
  function isIdle() {
    return operations === 0;
  }

  function pauseForMaintenance() {
    pauses += 1;
    graphController.abort();
    let released = false;
    return Object.freeze({
      waitForIdle,
      release() {
        if (released) return;
        released = true;
        pauses -= 1;
        if (pauses === 0 && !stopped) graphController = new AbortController();
      },
    });
  }

  function stop() {
    stopped = true;
    graphController.abort();
  }

  // Runs one operation of this graph. Refused before it touches anything while the graph is
  // paused or stopped; otherwise counted until it has fully settled. `work` receives a signal
  // aborted by the caller's signal or by maintenance. A maintenance cancellation (and any result
  // completed after maintenance began) becomes `refusal()`; every other outcome passes through.
  async function tracked(callerSignal, refusal, work) {
    if (stopped || pauses > 0) throw refusal();
    const graphSignal = graphController.signal;
    const controller = new AbortController();
    const forward = () => controller.abort();
    if (callerSignal?.aborted) controller.abort();
    callerSignal?.addEventListener('abort', forward, { once: true });
    graphSignal.addEventListener('abort', forward, { once: true });
    const interrupted = () => graphSignal.aborted && !callerSignal?.aborted;
    operations += 1;
    try {
      const result = await work(controller.signal);
      if (interrupted()) throw refusal();
      return result;
    } catch (err) {
      if (interrupted() && err?.code === 'CANCELLED') throw refusal(err);
      throw err;
    } finally {
      callerSignal?.removeEventListener('abort', forward);
      graphSignal.removeEventListener('abort', forward);
      operations -= 1;
      if (operations === 0) {
        const waiters = [...idleWaiters];
        idleWaiters.clear();
        for (const resolve of waiters) resolve();
      }
    }
  }

  // Admission weight per operation and format, from the limits this service reads with.
  const weights = Object.freeze({
    manifest: Object.freeze({
      cbz: estimateComicOperationBytes('manifest', 'cbz', cbzLimits),
      cbr: estimateComicOperationBytes('manifest', 'cbr', cbrCb7Limits),
      cb7: estimateComicOperationBytes('manifest', 'cb7', cbrCb7Limits),
    }),
    page: Object.freeze({
      cbz: estimateComicOperationBytes('page', 'cbz', cbzLimits),
      cbr: estimateComicOperationBytes('page', 'cbr', cbrCb7Limits),
      cb7: estimateComicOperationBytes('page', 'cb7', cbrCb7Limits),
    }),
  });

  // Preparation reads with the same (tighten-only) reader limits; its deadline and disk budget
  // come from the cache (A3.2b's 120 s / 1 GiB at most), not from the per-read timeout.
  const { timeoutMs: _readTimeout, ...preparationReaderLimits } = cbrCb7Limits;
  const preparationWeights = Object.freeze({
    cbr: estimateComicOperationBytes('preparation', 'cbr', preparationReaderLimits),
    cb7: estimateComicOperationBytes('preparation', 'cb7', preparationReaderLimits),
  });
  if (cache !== null && comicAdmission.limits) {
    const { maxBackgroundActive, memoryBudgetBytes, foregroundReserveBytes, maxDecoderActive } = comicAdmission.limits;
    const weight = Math.min(Math.max(preparationWeights.cbr, preparationWeights.cb7), memoryBudgetBytes);
    // A preparation runs a decoder and must leave one decoder slot to the foreground.
    if (maxBackgroundActive < 1 || weight > memoryBudgetBytes - foregroundReserveBytes
      || (maxDecoderActive !== undefined && maxDecoderActive < 2)) {
      throw new TypeError('The comic admission has no background capacity for preparations.');
    }
  }

  function pick(source, allowed) {
    const result = {};
    for (const [key, value] of Object.entries(source ?? {})) if (Object.hasOwn(allowed, key)) result[key] = value;
    return result;
  }

  // ── Authority ──────────────────────────────────────────────────────────────────────────

  function authorize(projectId, assetId) {
    if (!Number.isSafeInteger(projectId) || projectId < 1 || !Number.isSafeInteger(assetId) || assetId < 1) {
      throw notFound('ASSET_NOT_FOUND');
    }
    let descriptor;
    try {
      descriptor = previewService.getOriginalDescriptor(projectId, assetId);
    } catch (err) {
      // IDs are validated above, so an access error here is an asset of another project.
      if (err instanceof PreviewAccessError) throw notFound('ASSET_PROJECT_MISMATCH', err);
      if (err instanceof PreviewNotFoundError) {
        throw notFound(err.message === 'Asset is not present on disk.' ? 'SOURCE_MISSING' : 'ASSET_NOT_FOUND', err);
      }
      throw err;
    }
    const comic = classifyComicAsset({ extension: descriptor.extension });
    if (!comic.comic) {
      throw outcome(MediaUnsupportedError, 'UNSUPPORTED_COMIC', 'This asset is not a supported comic.');
    }
    // A row without a usable indexed revision (incomplete scan data) cannot anchor a revision.
    if (!descriptor.revision) throw sourceChanged();
    return { descriptor, format: comic.format };
  }

  // ── Source ─────────────────────────────────────────────────────────────────────────────

  async function pathIdentity(absolutePath) {
    try {
      return bigintIdentity(await fs.promises.stat(absolutePath, { bigint: true }));
    } catch {
      return null;
    }
  }

  // Opens the authorized original and proves it is the indexed source. The caller closes it.
  async function openSource(projectId, assetId) {
    const { descriptor, format } = authorize(projectId, assetId);
    let opened;
    try {
      opened = await openAssetFileAsync(projectsRoot, descriptor.projectDir, descriptor.relativePath);
    } catch (err) {
      if (err instanceof StorageError) throw notFound('SOURCE_MISSING', err);
      throw err;
    }
    try {
      const identity = bigintIdentity(await opened.handle.stat({ bigint: true }));
      const atPath = await pathIdentity(opened.absolutePath);
      if (opened.stat.size !== descriptor.size
        || opened.stat.mtime.toISOString() !== descriptor.mtime
        || !atPath || !sameIdentity(identity, atPath)) {
        throw sourceChanged();
      }
      return {
        opened,
        format,
        projectId,
        assetId,
        identity,
        indexedRevision: descriptor.revision,
        projectDir: descriptor.projectDir,
        relativePath: descriptor.relativePath,
      };
    } catch (err) {
      await closeAssetFileAsync(opened);
      throw err;
    }
  }

  // Re-proves, after reading, that the descriptor, the path and the indexed row still describe
  // the source that was read. Any difference makes the output stale.
  async function assertUnchanged(source) {
    try {
      await assertOpenedArchiveUnchanged(source.opened);
    } catch (err) {
      throw revisionStale(err);
    }
    const now = bigintIdentity(await source.opened.handle.stat({ bigint: true }));
    const atPath = await pathIdentity(source.opened.absolutePath);
    if (!sameIdentity(now, source.identity) || !atPath || !sameIdentity(atPath, source.identity)) {
      throw revisionStale();
    }
    let current;
    try {
      current = authorize(source.projectId, source.assetId).descriptor;
    } catch (err) {
      throw revisionStale(err);
    }
    if (current.revision !== source.indexedRevision || current.projectDir !== source.projectDir
      || current.relativePath !== source.relativePath) {
      throw revisionStale();
    }
  }

  function readerOptions(source, signal) {
    return source.format === 'cbz'
      ? { signal, limits: cbzLimits }
      : { format: source.format, signal, limits: cbrCb7Limits };
  }

  function maxInputPixels(source) {
    return (source.format === 'cbz' ? { ...CBZ_READER_LIMITS, ...cbzLimits } : { ...CBR_CB7_READER_LIMITS, ...cbrCb7Limits })
      .maxImagePixels;
  }

  function checkSignal(signal) {
    if (signal?.aborted) throw cancelled();
  }

  // Authority is checked before queueing (an unauthorized or non-comic request never takes a
  // queue place) and again by openSource once admitted, since the row, the file or the asset's
  // project may change while the request waits. No descriptor exists until admission.
  // F2: the whole operation, from the first authorization to the settled admission, is one
  // tracked operation of this graph; `work` receives the operation's signal.
  function withSource(projectId, assetId, requestSignal, stage, work) {
    return tracked(requestSignal, maintenance, async (signal) => {
      checkSignal(signal);
      const { format } = authorize(projectId, assetId);
      return comicAdmission.run(async () => {
        const source = await openSource(projectId, assetId);
        try {
          // The weight was chosen for the format seen before queueing.
          if (source.format !== format) throw sourceChanged();
          return await work(source, signal);
        } catch (err) {
          throw fromArchiveError(err, stage);
        } finally {
          await closeAssetFileAsync(source.opened);
        }
      // F1b-P3: CBR/CB7 manifests and pages count against the admission's decoder bound.
      }, { signal, lane: 'foreground', weightBytes: weights[stage][format], decoder: format !== 'cbz' });
    });
  }

  // ── Solid preparation (A3.3b-2) ────────────────────────────────────────────────────────

  const comicKey = (source) => ({ projectId: source.projectId, assetId: source.assetId });

  // The background job the cache runs for one revision. Nothing is opened until the background
  // lane admits it; then it authorizes and opens again, proves the exact identity the triggering
  // read saw, reserves disk, prepares, and proves the result is that revision of that source.
  // F2: a tracked operation of the graph that scheduled it (never of a later graph).
  function runPreparation(projectId, assetId, format, revision, identityKey) {
    return ({ signal: cacheSignal, reserve, discard, isSettled }) => tracked(cacheSignal, preparationMaintenance,
      (signal) => comicAdmission.run(async () => {
        const room = await reserve();
        const source = await openSource(projectId, assetId);
        try {
          if (source.format !== format || identityKeyOf(source) !== identityKey) throw revisionStale();
          if (!isSettled(changedAtMs(source.identity))) {
            throw new ComicPreparationCacheError('SOURCE_UNSETTLED', 'The comic changed too recently to prepare.');
          }
          await hooks.beforePrepare?.({ projectId, assetId });
          const prepared = await prepareSolidCbrCb7(source.opened, {
            format,
            stagingRoot: room.stagingRoot,
            onStaging: room.onStaging,
            beforeStagingRemoval: room.beforeStagingRemoval,
            signal,
            limits: { ...preparationReaderLimits, timeoutMs: room.timeoutMs, maxPreparedBytes: room.maxPreparedBytes },
          });
          try {
            if (identityHalf(source) + catalogHalf(prepared) !== revision) throw revisionStale();
            await assertUnchanged(source);
            // Never hand a preparation to the cache once this graph's maintenance began.
            checkSignal(signal);
          } catch (err) {
            await discard(prepared);
            throw err;
          }
          return { prepared, identityKey };
        } finally {
          await closeAssetFileAsync(source.opened);
        }
      }, { signal, lane: 'background', weightBytes: preparationWeights[format], decoder: true }));
  }

  // After a successful on-demand read of a solid CBR/CB7 page: ask the cache to prepare this
  // revision (deduplicated, bounded and backed off by the cache; never awaited).
  function schedulePreparation(source, identityKey, revision, catalog) {
    if (cache === null || source.format === 'cbz' || !catalog.solid) return;
    // Exactly the bytes prepareSolidCbrCb7 stages for this catalog: every page without a problem.
    const expectedBytes = catalog.pages.reduce((sum, page) => (page.problem === null ? sum + page.uncompressedSize : sum), 0);
    cache.schedule({
      projectId: source.projectId,
      assetId: source.assetId,
      revision,
      expectedBytes,
      changedAtMs: changedAtMs(source.identity),
      run: runPreparation(source.projectId, source.assetId, source.format, revision, identityKey),
    });
  }

  // A page from the verified preparation of exactly this source and revision, or null to read
  // it on demand. The lease keeps the preparation from being removed until its bytes are read.
  async function readPreparedPage(source, identityKey, revision, position, signal) {
    if (cache === null || source.format === 'cbz') return null;
    const lease = cache.lease({ ...comicKey(source), revision, identityKey });
    if (!lease) return null;
    let verdict;
    try {
      const { prepared } = lease;
      const slot = prepared.slots[position - 1];
      // PAGE_CORRUPT slots include pages left unverified by a broken solid stream; an on-demand
      // read decides those. Other error slots are the reader's own verdict and are served as is.
      if (slot?.status === 'error' && slot.code === 'PAGE_CORRUPT') return null;
      let read;
      try {
        read = await prepared.read(position);
      } catch (err) {
        if (err instanceof ArchiveDecoderError && (err.code === 'PREPARATION_CHANGED' || err.code === 'PREPARATION_DISPOSED')) {
          lease.discard();
          return null;
        }
        verdict = err;
      }
      if (verdict === undefined) {
        await hooks.preparedRead?.({ projectId: source.projectId, assetId: source.assetId, position });
        return { page: read.page, bytes: read.bytes, image: read.image, catalog: prepared };
      }
    } finally {
      lease.release();
    }
    // A cached page verdict describes the prepared bytes; it is reported only while the
    // current catalog still names this revision (otherwise REVISION_STALE).
    await assertPreparedCatalogCurrent(source, revision, signal);
    throw verdict;
  }

  // Before a prepared page is published: the archive's current catalog, listed afresh from the
  // opened descriptor (bounded listing, no extraction), must still yield the requested revision.
  // The source identity was already matched, so a difference here is a content change the
  // metadata did not show. The preparation (and any job for another revision) is retired, and
  // the request fails as an on-demand read of that revision would.
  async function assertPreparedCatalogCurrent(source, revision, signal) {
    const catalog = await inspectCbrCb7(source.opened, readerOptions(source, signal));
    await hooks.catalogChecked?.({ projectId: source.projectId, assetId: source.assetId });
    const current = identityHalf(source) + catalogHalf(catalog);
    if (current !== revision) {
      cache.invalidate(comicKey(source), { revision: current });
      throw revisionStale();
    }
  }

  // ── Manifest ───────────────────────────────────────────────────────────────────────────

  /**
   * Ordered page manifest for a comic. Lists the archive once (no page is extracted).
   *
   * @param {number} projectId
   * @param {number} assetId
   * @param {{ signal?: AbortSignal }} [options]
   */
  async function getComicManifest(projectId, assetId, { signal } = {}) {
    try {
      return await withSource(projectId, assetId, signal, 'manifest', async (source, signal) => {
        const catalog = source.format === 'cbz'
          ? await inspectCbz(source.opened, readerOptions(source, signal))
          : await inspectCbrCb7(source.opened, readerOptions(source, signal));
        await hooks.afterRead?.({ stage: 'manifest', projectId, assetId });
        checkSignal(signal);
        await assertUnchanged(source);
        const revision = identityHalf(source) + catalogHalf(catalog);
        // Solid comics are read on demand until a preparation of this exact revision is ready.
        // Listing a comic never starts one; a preparation of an older source is retired here.
        let preparationState = catalog.solid ? 'on-demand' : 'not-required';
        if (cache !== null && catalog.solid) {
          cache.invalidate(comicKey(source), { revision, identityKey: identityKeyOf(source) });
          preparationState = cache.state(comicKey(source), revision) ?? 'on-demand';
        }
        const pages = catalog.pages.map((page) => Object.freeze({
          position: page.position,
          name: page.name,
          declaredMimeType: page.declaredMimeType,
          size: page.uncompressedSize,
          available: page.problem === null,
          problem: page.problem,
        }));
        return Object.freeze({
          projectId,
          assetId,
          format: source.format,
          container: catalog.container ?? 'zip',
          revision,
          pageCount: catalog.pageCount,
          pages: Object.freeze(pages),
          unavailablePositions: Object.freeze(pages.filter((page) => !page.available).map((page) => page.position)),
          sourceImageTypes: COMIC_PAGE_SOURCE_TYPES,
          deliveryImageTypes: COMIC_PAGE_DELIVERY_TYPES,
          // 'not-required' (CBZ, non-solid), 'on-demand', 'preparing' or 'ready'.
          preparation: Object.freeze({
            solid: Boolean(catalog.solid),
            state: preparationState,
          }),
        });
      });
    } catch (err) {
      throw fromArchiveError(err, 'manifest');
    }
  }

  // ── Page ───────────────────────────────────────────────────────────────────────────────

  /**
   * Read and render one numbered page of a manifest revision.
   *
   * @param {number} projectId
   * @param {number} assetId
   * @param {{ revision: string, position: number, signal?: AbortSignal }} request
   */
  async function getComicPage(projectId, assetId, { revision, position, signal } = {}) {
    if (typeof revision !== 'string' || !COMIC_REVISION_RE.test(revision)) {
      throw outcome(MediaBadRequestError, 'REVISION_INVALID', 'A comic revision is required.');
    }
    if (!Number.isSafeInteger(position) || position < 1) {
      throw outcome(MediaBadRequestError, 'PAGE_INVALID_POSITION', 'Invalid page number.');
    }
    try {
      return await withSource(projectId, assetId, signal, 'page', async (source, signal) => {
        const identityKey = identityKeyOf(source);
        // Refuse a stale revision before any decoding work.
        if (identityHalf(source) !== revision.slice(0, 16)) {
          cache?.invalidate(comicKey(source), { identityKey });
          throw revisionStale();
        }
        let read = await readPreparedPage(source, identityKey, revision, position, signal);
        const fromPreparation = read !== null;
        if (!fromPreparation) {
          read = source.format === 'cbz'
            ? await readCbzPage(source.opened, position, readerOptions(source, signal))
            : await readCbrCb7Page(source.opened, position, readerOptions(source, signal));
          if (catalogHalf(read.catalog) !== revision.slice(16)) throw revisionStale();
        }
        await hooks.afterRead?.({ stage: 'page', projectId, assetId, position });
        checkSignal(signal);
        // The request's signal reaches the rendition child, which is killed on abort; the
        // admission slot is held until that child is confirmed gone.
        const still = await renderComicPageStill(read.bytes, read.image, {
          maxInputPixels: maxInputPixels(source),
          limits: rendition,
          signal,
          renditions: renditionSupervisor,
          onPhase: hooks.renditionPhase && ((phase) => hooks.renditionPhase({ phase, projectId, assetId, position })),
        });
        checkSignal(signal);
        // A prepared page was not selected from a catalog of the current bytes: prove one now.
        if (fromPreparation) {
          await assertPreparedCatalogCurrent(source, revision, signal);
          checkSignal(signal);
        }
        // Accept the output only if the source is still the one the revision names.
        await assertUnchanged(source);
        if (!fromPreparation) schedulePreparation(source, identityKey, revision, read.catalog);
        return Object.freeze({
          projectId,
          assetId,
          format: source.format,
          revision,
          position: read.page.position,
          pageCount: read.catalog.pageCount,
          mimeType: still.mimeType,
          width: still.width,
          height: still.height,
          byteLength: still.bytes.length,
          bytes: still.bytes,
          converted: still.converted,
          sourceAnimated: read.image.animated,
          // Served from the verified solid preparation rather than decoded from the archive.
          prepared: fromPreparation,
        });
      });
    } catch (err) {
      throw fromArchiveError(err, 'page');
    }
  }

  return Object.freeze({ getComicManifest, getComicPage, pauseForMaintenance, isIdle, stop });
}
