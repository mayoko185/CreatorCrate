// Low-level CBR (RAR4/RAR5) and CB7 (7z) comic page catalog and single-page reader.
//
// The counterpart of cbz-page-reader.js for RAR and 7z comics, with the same page contract,
// page ordering, junk filtering and image validation. All archive work goes through the
// qualified A1 decoder (archive-member-decoder.js): every call runs in one disposable worker
// that lists the archive, lets this module choose the page from that same validated listing,
// proves the selection, extracts exactly one member and returns only after the parent has
// verified its size and CRC. No other RAR/7z code is involved and nothing is written to disk.
//
// Works on an archive the caller has already opened through the secure asset-file path
// (openAssetFile / openAssetFileAsync). The caller keeps ownership of the descriptor and
// closes it after the returned promise settles. Project authorization, asset ownership,
// source revisions, caching and HTTP mapping belong to the caller (A3.3). Pages are addressed
// by 1-based catalog position only; member paths are reported for diagnostics and are never
// accepted as input.
//
// Solid archives are read correctly but without any preparation cache: reading page N decodes
// the solid stream from the start of its block up to page N inside the worker, every time.
// cbr-cb7-preparation.js prepares a whole solid comic in one pass and reuses the catalog
// helpers exported below, so both build identical catalogs from the decoder's listing.
import {
  ArchiveDecoderError,
  DEFAULT_DECODER_LIMITS,
  extractOpenedArchiveMember,
  listOpenedArchive,
  resolveDecoderLimits,
} from './archive-member-decoder.js';
import { CBZ_READER_LIMITS, compareComicPaths, inspectImage, isJunkPath, pageTypeOf } from './cbz-page-reader.js';

export { ArchiveDecoderError };

// Decoder bounds are A1's own defaults and are validated by A1. Page bounds are shared with the
// CBZ reader so all three comic formats accept the same pages.
export const CBR_CB7_READER_LIMITS = Object.freeze({
  ...DEFAULT_DECODER_LIMITS,
  maxPages: CBZ_READER_LIMITS.maxPages,
  maxTotalUncompressedBytes: CBZ_READER_LIMITS.maxTotalUncompressedBytes,
  maxImageDimension: CBZ_READER_LIMITS.maxImageDimension,
  maxImagePixels: CBZ_READER_LIMITS.maxImagePixels,
});

const PAGE_LIMIT_KEYS = ['maxPages', 'maxTotalUncompressedBytes', 'maxImageDimension', 'maxImagePixels'];
const DECODER_FORMAT = Object.freeze({ cbr: 'rar', cb7: '7z' });

// Decoder codes that, during a page read, describe that one member rather than the archive.
// Listing-stage failures keep their archive-level codes.
const PAGE_CODES = Object.freeze({ EXTRACTION_FAILED: 'PAGE_CORRUPT', OUTPUT_LIMIT_EXCEEDED: 'PAGE_CORRUPT' });

function error(code, message, cause) {
  return new ArchiveDecoderError(code, message, { cause });
}

/**
 * Resolves reader limits. Decoder keys go through A1's own validation, so nothing here can
 * raise its memory ceiling or relax its other bounds beyond what A1 accepts.
 */
export function resolveCbrCb7Limits(overrides = {}) {
  const page = {};
  const decoder = {};
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (PAGE_LIMIT_KEYS.includes(key)) {
      if (!Number.isSafeInteger(value) || value < 1) throw error('INVALID_ARGUMENT', 'Invalid comic archive limit: ' + key);
      page[key] = value;
    } else {
      decoder[key] = value;
    }
  }
  const resolved = { ...CBR_CB7_READER_LIMITS, ...resolveDecoderLimits(decoder), ...page };
  return Object.freeze(resolved);
}

export function decoderLimitsOf(limits, timeoutMs) {
  const result = {};
  for (const key of Object.keys(DEFAULT_DECODER_LIMITS)) result[key] = limits[key];
  result.timeoutMs = timeoutMs;
  return result;
}

export function decoderFormatOf(format) {
  if (!Object.hasOwn(DECODER_FORMAT, format)) throw error('INVALID_ARGUMENT', 'format must be "cbr" or "cb7".');
  return DECODER_FORMAT[format];
}

// ─── Deadline and cancellation ───────────────────────────────────────────────────────────

// One deadline for the whole call. The decoder receives the time that is left, so listing,
// extraction and image inspection together never exceed timeoutMs.
export function createGuard(signal, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  const interruption = () => {
    if (signal?.aborted) return error('CANCELLED', 'Archive reading was cancelled.');
    if (performance.now() >= deadline) return error('TIMEOUT', 'Archive reading timed out.');
    return null;
  };
  return {
    checkpoint() {
      const interrupted = interruption();
      if (interrupted) throw interrupted;
    },
    remainingMs() {
      const remaining = Math.ceil(deadline - performance.now());
      if (remaining < 1) throw error('TIMEOUT', 'Archive reading timed out.');
      return remaining;
    },
  };
}

// Decoder failures carry codes, not text meant for clients. DECODER_FAILED may quote the WASM
// runtime, so its message is replaced; anything that is not an ArchiveDecoderError (an fs error
// reading the signature) becomes INPUT_UNAVAILABLE. The original stays available as `cause`.
export function toReaderError(cause, { page = false } = {}) {
  if (!(cause instanceof ArchiveDecoderError)) return error('INPUT_UNAVAILABLE', 'The archive could not be read.', cause);
  const code = page && Object.hasOwn(PAGE_CODES, cause.code) ? PAGE_CODES[cause.code] : cause.code;
  if (code === 'PAGE_CORRUPT') return error(code, 'The page member could not be decoded.', cause);
  if (code === 'DECODER_FAILED') return error(code, 'The archive decoder failed.', cause);
  return cause;
}

// ─── Catalog ─────────────────────────────────────────────────────────────────────────────

// A listed page that cannot be served keeps its position and carries the reason. Per-member
// packed sizes are not meaningful inside solid blocks, so there is no ratio check here; A1
// bounds the decoded output by the declared size, maxMemberBytes and the deadline instead.
function pageProblem(entry, limits) {
  if (entry.size > limits.maxMemberBytes) return 'MEMBER_LIMIT_EXCEEDED';
  if (entry.size === 0) return 'PAGE_INVALID_IMAGE';
  return null;
}

// listing: the A1 listing ({ solid, entries }), already validated by the decoder's parent side
// (safe paths, no duplicates or case/normalization collisions, no encryption or volumes,
// links and special entries typed 'unsupported').
export function buildCatalog(listing, limits, checkpoint) {
  let declaredTotal = 0;
  const candidates = [];
  for (const entry of listing.entries) {
    checkpoint();
    if (entry.type !== 'directory') {
      declaredTotal += entry.size;
      if (declaredTotal > limits.maxTotalUncompressedBytes) {
        throw error('EXPANSION_LIMIT_EXCEEDED', 'Archive declares more uncompressed data than allowed.');
      }
    }
    // Links, devices and other special entries are never pages, whatever their names.
    if (entry.type !== 'file' || isJunkPath(entry.path)) continue;
    const pageType = pageTypeOf(entry.path);
    if (!pageType) continue;
    if (candidates.length >= limits.maxPages) throw error('PAGE_LIMIT_EXCEEDED', 'Archive has more pages than allowed.');
    candidates.push({ entry, pageType });
  }
  candidates.sort((a, b) => compareComicPaths(a.entry.path, b.entry.path) || a.entry.index - b.entry.index);

  return candidates.map(({ entry, pageType }, index) => Object.freeze({
    position: index + 1,
    member: Object.freeze({ entryIndex: entry.index, path: entry.path }),
    name: entry.path.slice(entry.path.lastIndexOf('/') + 1),
    extension: pageType.extension,
    declaredFormat: pageType.format,
    declaredMimeType: pageType.mimeType,
    // 7-Zip's per-member method string is not part of the validated A1 listing.
    compressionMethod: null,
    // null when the decoder reports no per-member packed size (members inside a 7z solid block).
    compressedSize: entry.packedSize,
    uncompressedSize: entry.size,
    // null when the archive stores no CRC32 (RAR5 BLAKE2); 7-Zip's own integrity check applies.
    crc32: entry.crc32,
    modified: entry.modified,
    problem: pageProblem(entry, limits),
  }));
}

export function catalogResult(format, container, listing, pages) {
  const frozen = Object.freeze(pages);
  return Object.freeze({
    format,
    container,
    solid: listing.solid,
    entryCount: listing.entries.length,
    pageCount: frozen.length,
    hasPages: frozen.length > 0,
    pages: frozen,
  });
}

/**
 * Inspect an opened CBR or CB7 and return its naturally ordered page catalog.
 *
 * The caller owns `openFile` and closes it after the promise settles. The result has the
 * shape of inspectCbz's, plus `container` and `solid`; `compressionMethod` is null and
 * `compressedSize`/`crc32` may be null (see buildCatalog).
 *
 * @param {{ handle: number|import('node:fs/promises').FileHandle, stat: import('node:fs').Stats }} openFile
 * @param {{ format: 'cbr'|'cb7', signal?: AbortSignal, limits?: Partial<typeof CBR_CB7_READER_LIMITS> }} options
 * @returns {Promise<{ format: 'cbr'|'cb7', container: 'rar4'|'rar5'|'7z', solid: boolean,
 *   entryCount: number, pageCount: number, hasPages: boolean, pages: ReadonlyArray<object> }>}
 * @throws {ArchiveDecoderError} archive-level failures (the archive as a whole is unusable).
 */
export async function inspectCbrCb7(openFile, options = {}) {
  const { format, signal } = options;
  const decoderFormat = decoderFormatOf(format);
  const limits = resolveCbrCb7Limits(options.limits);
  const guard = createGuard(signal, limits.timeoutMs);
  guard.checkpoint();
  let listing;
  try {
    listing = await listOpenedArchive(openFile, {
      format: decoderFormat,
      signal,
      limits: decoderLimitsOf(limits, guard.remainingMs()),
    });
  } catch (cause) {
    throw toReaderError(cause);
  }
  const pages = buildCatalog(listing, limits, guard.checkpoint);
  guard.checkpoint();
  return catalogResult(format, listing.format, listing, pages);
}

// ─── Page reading ────────────────────────────────────────────────────────────────────────

/**
 * Read one page by its 1-based catalog position.
 *
 * One decoder job lists the archive, rebuilds the catalog from that listing, picks the member
 * at `position`, proves the decoder selects exactly that member and extracts it. The position
 * therefore always refers to the member the catalog shows for these bytes, and positions never
 * shift when another page is unreadable. Animated GIF/WebP pages are returned as stored with
 * `animated: true`; the consumer shows the first frame as a still page.
 *
 * @param {{ handle: number|import('node:fs/promises').FileHandle, stat: import('node:fs').Stats }} openFile
 * @param {number} position
 * @param {{ format: 'cbr'|'cb7', signal?: AbortSignal, limits?: Partial<typeof CBR_CB7_READER_LIMITS> }} options
 * @returns {Promise<{ page: object, bytes: Buffer, image: { format: string, mimeType: string,
 *   width: number, height: number, frameCount: number, animated: boolean }, catalog: object }>}
 *   `catalog` is the inspectCbrCb7-shaped catalog the page was selected from in this same job.
 * @throws {ArchiveDecoderError} PAGE_NOT_FOUND, a page `problem` code, PAGE_CORRUPT,
 *   PAGE_INVALID_IMAGE, IMAGE_LIMIT_EXCEEDED, or any archive-level code from inspectCbrCb7.
 */
export async function readCbrCb7Page(openFile, position, options = {}) {
  const { format, signal } = options;
  const decoderFormat = decoderFormatOf(format);
  if (!Number.isSafeInteger(position) || position < 1) throw error('PAGE_NOT_FOUND', 'The archive has no such page.');
  const limits = resolveCbrCb7Limits(options.limits);
  const guard = createGuard(signal, limits.timeoutMs);
  guard.checkpoint();

  let page = null;
  let selectedFrom = null;
  const select = (listing, checkpoint) => {
    const pages = buildCatalog(listing, limits, checkpoint);
    const selected = pages[position - 1];
    if (!selected) throw error('PAGE_NOT_FOUND', 'The archive has no such page.');
    if (selected.problem) throw error(selected.problem, 'The page cannot be read: ' + selected.problem + '.');
    page = selected;
    selectedFrom = { listing, pages };
    return selected.member.path;
  };
  let extracted;
  try {
    extracted = await extractOpenedArchiveMember(openFile, select, {
      format: decoderFormat,
      signal,
      limits: decoderLimitsOf(limits, guard.remainingMs()),
    });
  } catch (cause) {
    // Before a page was chosen every failure concerns the archive (or the requested position).
    throw toReaderError(cause, { page: page !== null });
  }
  if (page === null || extracted.entry.index !== page.member.entryIndex || extracted.entry.path !== page.member.path) {
    throw error('PROTOCOL_ERROR', 'The decoder returned a different member than the one selected.');
  }
  guard.checkpoint();
  const image = await inspectImage(extracted.data, limits);
  guard.checkpoint();
  // The catalog this job selected from, so a caller can tie the page to a manifest revision.
  const catalog = catalogResult(format, extracted.format, selectedFrom.listing, selectedFrom.pages);
  return { page, bytes: extracted.data, image, catalog };
}
