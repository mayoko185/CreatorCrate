// Low-level CBZ (ZIP comic) page catalog and single-page reader.
//
// Works on an archive the caller has already opened through the secure asset-file path
// (openAssetFile / openAssetFileAsync). The caller keeps ownership of the descriptor and
// closes it after the returned promise settles; this module never opens, resolves or closes
// filesystem paths, and never writes anything. Members are decompressed on demand through
// yauzl's random-access reader, one page at a time, with every bound enforced on the bytes
// actually produced rather than on declared sizes.
//
// Project authorization, asset ownership, source revisions, caching and HTTP mapping belong
// to the caller (A3.3). Pages are addressed by 1-based catalog position only; member paths
// are reported for diagnostics and are never accepted as input.
import { read } from 'node:fs';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32 } from 'node:zlib';
import sharp from 'sharp';
import yauzl from 'yauzl';
import { OpenDescriptorReader } from '../storage/krita-preview-extractor.js';
import { ArchiveDecoderError, assertSafeMemberPath, assertUnambiguous } from './archive-member-listing.js';
import { sharpRuntime } from './sharp-runtime.js';

export { ArchiveDecoderError };

const MIB = 1024 * 1024;

// Shared bounds are aligned with DEFAULT_DECODER_LIMITS in archive-member-decoder.js so CBZ,
// CBR and CB7 behave alike: input size, entry count, path length, per-member size, deadline.
export const CBZ_READER_LIMITS = Object.freeze({
  maxInputBytes: 2 * 1024 * MIB,
  maxEntries: 10_000,
  maxPathLength: 1024,
  maxPages: 5_000,
  maxMemberBytes: 64 * MIB,
  // Sum of declared uncompressed sizes over every non-directory member.
  maxTotalUncompressedBytes: 4 * 1024 * MIB,
  // Declared uncompressed / compressed size of one page member.
  maxCompressionRatio: 1_000,
  // Long vertical strips are legitimate comic pages, so the edge bound is the JPEG maximum
  // and the area bound does the real work.
  maxImageDimension: 65_535,
  maxImagePixels: 100_000_000,
  timeoutMs: 30_000,
});

const STORE = 0;
const DEFLATE = 8;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAG_STRONG_ENCRYPTION = 0x0040;
const FLAG_ENCRYPTED_CENTRAL_DIRECTORY = 0x2000;
const METHOD_AES = 99;
const LOCAL_HEADER_BYTES = 30;
const ZIP_LOCAL_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const ZIP_EMPTY_SIGNATURE = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

// Hosts whose external attributes carry a Unix st_mode in the high 16 bits.
const UNIX_HOSTS = new Set([3, 19]);
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const DOS_DIRECTORY = 0x10;
const DOS_REPARSE_POINT = 0x400;

const PAGE_TYPES = Object.freeze({
  jpg: Object.freeze({ format: 'jpeg', mimeType: 'image/jpeg' }),
  jpeg: Object.freeze({ format: 'jpeg', mimeType: 'image/jpeg' }),
  png: Object.freeze({ format: 'png', mimeType: 'image/png' }),
  webp: Object.freeze({ format: 'webp', mimeType: 'image/webp' }),
  gif: Object.freeze({ format: 'gif', mimeType: 'image/gif' }),
});
const MIME_BY_FORMAT = Object.freeze({ jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' });

// Names that are operating-system or tool metadata rather than pages. Any path component
// starting with "." (hidden files and folders, AppleDouble "._x") is excluded as well.
const JUNK_COMPONENTS = new Set(['__macosx', 'thumbs.db', 'desktop.ini']);

function error(code, message) {
  return new ArchiveDecoderError(code, message);
}

export function resolveCbzLimits(overrides = {}) {
  const limits = { ...CBZ_READER_LIMITS };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (!Object.hasOwn(limits, key)) throw error('INVALID_ARGUMENT', 'Unknown CBZ limit: ' + key);
    if (!Number.isSafeInteger(value) || value < 1) throw error('INVALID_ARGUMENT', 'Invalid CBZ limit: ' + key);
    limits[key] = value;
  }
  return limits;
}

// ─── Natural ordering ────────────────────────────────────────────────────────────────────

function isDigit(code) {
  return code >= 48 && code <= 57;
}

// Code-unit comparison; independent of the host locale and ICU data.
function compareCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Walks both segments together: ASCII digit runs compare by numeric value (any length, no
// Number conversion), every other character compares by code unit after NFC + lower-casing.
function compareSegments(a, b) {
  const left = a.normalize('NFC').toLowerCase();
  const right = b.normalize('NFC').toLowerCase();
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (isDigit(left.charCodeAt(i)) && isDigit(right.charCodeAt(j))) {
      let endI = i;
      let endJ = j;
      while (endI < left.length && isDigit(left.charCodeAt(endI))) endI += 1;
      while (endJ < right.length && isDigit(right.charCodeAt(endJ))) endJ += 1;
      const runA = left.slice(i, endI).replace(/^0+/, '');
      const runB = right.slice(j, endJ).replace(/^0+/, '');
      if (runA.length !== runB.length) return runA.length - runB.length;
      const result = compareCodeUnits(runA, runB);
      if (result !== 0) return result;
      i = endI;
      j = endJ;
      continue;
    }
    const result = left.charCodeAt(i) - right.charCodeAt(j);
    if (result !== 0) return result;
    i += 1;
    j += 1;
  }
  return (left.length - i) - (right.length - j);
}

/**
 * Natural, locale-independent order of complete archive paths: folder by folder, digit runs
 * by numeric value, text case-insensitively. Ties (case, leading zeros, normalization) fall
 * back to exact code-unit order, which is total because member paths are unique.
 */
export function compareComicPaths(a, b) {
  const partsA = a.split('/');
  const partsB = b.split('/');
  const count = Math.min(partsA.length, partsB.length);
  for (let index = 0; index < count; index += 1) {
    const result = compareSegments(partsA[index], partsB[index]);
    if (result !== 0) return result;
  }
  if (partsA.length !== partsB.length) return partsA.length - partsB.length;
  return compareCodeUnits(a, b);
}

// ─── Deadline and cancellation ───────────────────────────────────────────────────────────

function createGuard(signal, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  const interruption = () => {
    if (signal?.aborted) return error('CANCELLED', 'Archive reading was cancelled.');
    if (performance.now() >= deadline) return error('TIMEOUT', 'Archive reading timed out.');
    return null;
  };
  return {
    interruption,
    checkpoint() {
      const interrupted = interruption();
      if (interrupted) throw interrupted;
    },
    // Calls onInterrupt once when the signal aborts or the deadline passes; returns a disposer.
    watch(onInterrupt) {
      const fire = () => onInterrupt(interruption() ?? error('TIMEOUT', 'Archive reading timed out.'));
      const timer = setTimeout(fire, Math.max(0, deadline - performance.now()));
      signal?.addEventListener('abort', fire, { once: true });
      return () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', fire);
      };
    },
  };
}

// ─── Descriptor access ───────────────────────────────────────────────────────────────────

// Records every positional stream so a call can wait until no fs.read is pending on the
// caller's descriptor before it settles; the caller may close the descriptor right after.
class TrackedDescriptorReader extends OpenDescriptorReader {
  constructor(fd) {
    super(fd);
    this.streams = new Set();
  }

  _readStreamForRange(start, end) {
    const stream = super._readStreamForRange(start, end);
    this.streams.add(stream);
    stream.once('close', () => this.streams.delete(stream));
    return stream;
  }

  async drain() {
    const open = [...this.streams];
    await Promise.all(open.map((stream) => new Promise((resolve) => {
      if (stream.closed) return resolve();
      stream.once('close', resolve);
      if (!stream.destroyed) stream.destroy();
    })));
  }
}

function descriptorOf(openFile) {
  const handle = openFile?.handle;
  const fd = typeof handle === 'number' ? handle : handle?.fd;
  const size = openFile?.stat?.size;
  if (!Number.isInteger(fd) || fd < 0 || !Number.isSafeInteger(size) || size < 0
    || (typeof openFile.stat.isFile === 'function' && !openFile.stat.isFile())) {
    throw error('INVALID_ARGUMENT', 'An opened regular archive file is required.');
  }
  return { fd, size };
}

function readAt(fd, length, position) {
  return new Promise((resolve, reject) => {
    const buffer = Buffer.alloc(length);
    // Positional read through the callback API so the descriptor is never wrapped or closed.
    read(fd, buffer, 0, length, position, (err, bytesRead) => {
      if (err) reject(err);
      else resolve(buffer.subarray(0, bytesRead));
    });
  });
}

function mapYauzlError(cause) {
  if (cause instanceof ArchiveDecoderError) return cause;
  const message = String(cause?.message ?? '');
  if (/invalid characters in fileName|absolute path|invalid relative path/.test(message)) {
    return error('ARCHIVE_ENTRY_UNSAFE', 'Archive member path is unsafe.');
  }
  return error('ARCHIVE_CORRUPT', 'The archive could not be read.');
}

// ─── Catalog ─────────────────────────────────────────────────────────────────────────────

function isEncrypted(entry) {
  return (entry.generalPurposeBitFlag & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION | FLAG_ENCRYPTED_CENTRAL_DIRECTORY)) !== 0
    || entry.compressionMethod === METHOD_AES;
}

// 'file', 'directory', or 'unsupported' (links, devices, reparse points, contradictions).
function entryType(entry, isDirectoryName) {
  const host = entry.versionMadeBy >>> 8;
  const attributes = entry.externalFileAttributes >>> 0;
  if ((attributes & DOS_REPARSE_POINT) !== 0) return 'unsupported';
  const dosDirectory = (attributes & DOS_DIRECTORY) !== 0;
  if (UNIX_HOSTS.has(host)) {
    const mode = (attributes >>> 16) & S_IFMT;
    if (mode !== 0 && mode !== S_IFREG && mode !== S_IFDIR) return 'unsupported';
    if (mode === S_IFDIR && !isDirectoryName) return 'unsupported';
    if (mode === S_IFREG && isDirectoryName) return 'unsupported';
  }
  if (dosDirectory && !isDirectoryName) return 'unsupported';
  if (isDirectoryName) return entry.uncompressedSize === 0 ? 'directory' : 'unsupported';
  return 'file';
}

export function isJunkPath(path) {
  return path.split('/').some((part) => part.startsWith('.') || JUNK_COMPONENTS.has(part.toLowerCase()));
}

export function pageTypeOf(path) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  const extension = name.slice(dot + 1).toLowerCase();
  return Object.hasOwn(PAGE_TYPES, extension) ? { extension, ...PAGE_TYPES[extension] } : null;
}

// A page that is listed but cannot be served keeps its position and carries the reason.
function pageProblem(entry, limits) {
  if (entry.compressionMethod !== STORE && entry.compressionMethod !== DEFLATE) return 'UNSUPPORTED_COMPRESSION';
  if (entry.uncompressedSize > limits.maxMemberBytes) return 'MEMBER_LIMIT_EXCEEDED';
  if (entry.uncompressedSize === 0) return 'PAGE_INVALID_IMAGE';
  if (entry.uncompressedSize > entry.compressedSize * limits.maxCompressionRatio) return 'EXPANSION_LIMIT_EXCEEDED';
  return null;
}

// Every member's local header and data must lie inside the region before the central
// directory without overlapping another member's (overlapping members are the classic
// non-recursive ZIP bomb). Local extra fields and data descriptors are not counted, so the
// footprint used here is a lower bound and never rejects a well-formed archive.
function assertNoOverlap(entries, centralDirectoryOffset, guard) {
  const spans = entries
    .map((entry) => ({
      start: entry.relativeOffsetOfLocalHeader,
      end: entry.relativeOffsetOfLocalHeader + LOCAL_HEADER_BYTES + entry.fileNameLength + entry.compressedSize,
    }))
    .sort((a, b) => a.start - b.start);
  let previousEnd = 0;
  for (const span of spans) {
    guard.checkpoint();
    if (!Number.isSafeInteger(span.end) || span.start < previousEnd || span.end > centralDirectoryOffset) {
      throw error('ARCHIVE_CORRUPT', 'Archive members overlap or exceed the archive data.');
    }
    previousEnd = span.end;
  }
}

async function readEntries(zipfile, limits, guard) {
  if (!Number.isSafeInteger(zipfile.entryCount) || zipfile.entryCount > limits.maxEntries) {
    throw error('ENTRY_LIMIT_EXCEEDED', 'Archive has too many entries.');
  }
  const entries = [];
  try {
    for await (const entry of zipfile.eachEntry()) {
      guard.checkpoint();
      if (entries.length >= limits.maxEntries) throw error('ENTRY_LIMIT_EXCEEDED', 'Archive has too many entries.');
      entries.push(entry);
    }
  } catch (cause) {
    throw guard.interruption() ?? mapYauzlError(cause);
  }
  if (entries.length !== zipfile.entryCount) throw error('ARCHIVE_CORRUPT', 'Archive entry count does not match its directory.');
  return entries;
}

function buildCatalog(rawEntries, centralDirectoryOffset, limits, guard) {
  const members = [];
  let declaredTotal = 0;
  rawEntries.forEach((entry, entryIndex) => {
    guard.checkpoint();
    if (isEncrypted(entry)) throw error('ARCHIVE_ENCRYPTED', 'Encrypted archives are not supported.');
    const isDirectoryName = entry.fileName.endsWith('/');
    const path = isDirectoryName ? entry.fileName.slice(0, -1) : entry.fileName;
    assertSafeMemberPath(path, limits.maxPathLength);
    if (!Number.isSafeInteger(entry.compressedSize) || !Number.isSafeInteger(entry.uncompressedSize)
      || !Number.isSafeInteger(entry.relativeOffsetOfLocalHeader)) {
      throw error('ARCHIVE_CORRUPT', 'Archive member sizes are invalid.');
    }
    const type = entryType(entry, isDirectoryName);
    if (type !== 'directory') {
      declaredTotal += entry.uncompressedSize;
      if (declaredTotal > limits.maxTotalUncompressedBytes) {
        throw error('EXPANSION_LIMIT_EXCEEDED', 'Archive declares more uncompressed data than allowed.');
      }
    }
    members.push({ entry, entryIndex, path, type });
  });
  assertUnambiguous(members, guard.checkpoint);
  assertNoOverlap(rawEntries, centralDirectoryOffset, guard);

  const candidates = [];
  for (const member of members) {
    if (member.type !== 'file' || isJunkPath(member.path)) continue;
    const pageType = pageTypeOf(member.path);
    if (!pageType) continue;
    if (candidates.length >= limits.maxPages) throw error('PAGE_LIMIT_EXCEEDED', 'Archive has more pages than allowed.');
    candidates.push({ member, pageType });
  }
  candidates.sort((a, b) => compareComicPaths(a.member.path, b.member.path) || a.member.entryIndex - b.member.entryIndex);

  return candidates.map(({ member, pageType }, index) => ({
    page: Object.freeze({
      position: index + 1,
      member: Object.freeze({ entryIndex: member.entryIndex, path: member.path }),
      name: member.path.slice(member.path.lastIndexOf('/') + 1),
      extension: pageType.extension,
      declaredFormat: pageType.format,
      declaredMimeType: pageType.mimeType,
      compressionMethod: member.entry.compressionMethod === DEFLATE ? 'deflate' : member.entry.compressionMethod === STORE ? 'store' : 'unsupported',
      compressedSize: member.entry.compressedSize,
      uncompressedSize: member.entry.uncompressedSize,
      crc32: member.entry.crc32 >>> 0,
      problem: pageProblem(member.entry, limits),
    }),
    entry: member.entry,
  }));
}

async function withArchive(openFile, options, work) {
  const { signal, limits: overrides } = options ?? {};
  const limits = resolveCbzLimits(overrides);
  const { fd, size } = descriptorOf(openFile);
  const guard = createGuard(signal, limits.timeoutMs);
  guard.checkpoint();
  if (size > limits.maxInputBytes) throw error('INPUT_LIMIT_EXCEEDED', 'The archive is larger than allowed.');

  const head = size >= 4 ? await readAt(fd, 4, 0).catch(() => null) : null;
  if (!head || head.length !== 4 || !(head.equals(ZIP_LOCAL_SIGNATURE) || head.equals(ZIP_EMPTY_SIGNATURE))) {
    throw error('UNSUPPORTED_FORMAT', 'The file is not a ZIP archive.');
  }

  const reader = new TrackedDescriptorReader(fd);
  let zipfile = null;
  try {
    try {
      zipfile = await yauzl.fromRandomAccessReaderPromise(reader, size, {
        autoClose: false,
        lazyEntries: true,
        decodeStrings: true,
        validateEntrySizes: true,
        strictFileNames: true,
      });
    } catch (cause) {
      throw guard.interruption() ?? mapYauzlError(cause);
    }
    guard.checkpoint();
    // yauzl starts its entry cursor at the central directory offset it parsed from the end
    // record; it does not expose that offset otherwise. Member data must end before it.
    const centralDirectoryOffset = zipfile.readEntryCursor;
    if (!Number.isSafeInteger(centralDirectoryOffset) || centralDirectoryOffset < 0 || centralDirectoryOffset > size) {
      throw error('ARCHIVE_CORRUPT', 'The archive directory location is invalid.');
    }
    const rawEntries = await readEntries(zipfile, limits, guard);
    const catalog = buildCatalog(rawEntries, centralDirectoryOffset, limits, guard);
    const result = await work({ zipfile, catalog, limits, guard });
    guard.checkpoint();
    return result;
  } finally {
    if (zipfile) {
      try { zipfile.close(); } catch { /* the descriptor stays with the caller */ }
    } else if (reader.refCount > 0) {
      try { reader.unref(); } catch { /* no descriptor is closed by this reader */ }
    }
    await reader.drain();
  }
}

function catalogResult(catalog, entryCount) {
  const pages = Object.freeze(catalog.map(({ page }) => page));
  return Object.freeze({ format: 'cbz', entryCount, pageCount: pages.length, hasPages: pages.length > 0, pages });
}

/**
 * Inspect an opened CBZ and return its naturally ordered page catalog.
 *
 * The caller owns `openFile` and closes it after the promise settles.
 *
 * @param {{ handle: number|import('node:fs/promises').FileHandle, stat: import('node:fs').Stats }} openFile
 * @param {{ signal?: AbortSignal, limits?: Partial<typeof CBZ_READER_LIMITS> }} [options]
 * @returns {Promise<{ format: 'cbz', entryCount: number, pageCount: number, hasPages: boolean,
 *   pages: ReadonlyArray<{ position: number, member: { entryIndex: number, path: string }, name: string,
 *   extension: string, declaredFormat: string, declaredMimeType: string, compressionMethod: string,
 *   compressedSize: number, uncompressedSize: number, crc32: number, problem: string|null }> }>}
 * @throws {ArchiveDecoderError} archive-level failures (the archive as a whole is unusable).
 */
export async function inspectCbz(openFile, options) {
  return withArchive(openFile, options, ({ zipfile, catalog }) => catalogResult(catalog, zipfile.entryCount));
}

// ─── Page reading ────────────────────────────────────────────────────────────────────────

// The local header must name the same member, with the same method and encryption state, as
// the central directory entry; otherwise different ZIP tools would see different content.
async function verifyLocalHeader(zipfile, entry) {
  let local;
  try {
    local = await zipfile.readLocalFileHeaderPromise(entry);
  } catch {
    throw error('PAGE_CORRUPT', 'The page member header could not be read.');
  }
  const flags = local.generalPurposeBitFlag;
  if (!Buffer.from(local.fileName).equals(Buffer.from(entry.fileNameRaw))
    || local.compressionMethod !== entry.compressionMethod
    || (flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) !== 0
    || ((flags & FLAG_DATA_DESCRIPTOR) === 0 && (local.crc32 >>> 0) !== (entry.crc32 >>> 0))) {
    throw error('PAGE_CORRUPT', 'The page member header does not match the archive directory.');
  }
}

async function readMemberBytes(zipfile, entry, guard) {
  await verifyLocalHeader(zipfile, entry);
  guard.checkpoint();
  let stream;
  try {
    // decodeFileData is omitted: an explicit true selects yauzl's raw mode.
    stream = await zipfile.openReadStreamPromise(entry);
  } catch {
    throw error('PAGE_CORRUPT', 'The page member could not be opened.');
  }

  const expected = entry.uncompressedSize;
  const chunks = [];
  let actual = 0;
  let checksum = 0;
  const sink = new Writable({
    write(chunk, encoding, callback) {
      const interrupted = guard.interruption();
      if (interrupted) return callback(interrupted);
      actual += chunk.length;
      // The declared size was already checked against maxMemberBytes, so this bounds memory
      // by the limit even when the deflate stream produces more than it declared.
      if (actual > expected) return callback(error('PAGE_CORRUPT', 'The page member is larger than declared.'));
      checksum = crc32(chunk, checksum);
      chunks.push(chunk);
      return callback();
    },
  });
  const stopWatching = guard.watch((reason) => stream.destroy(reason));
  try {
    await pipeline(stream, sink);
  } catch (cause) {
    throw guard.interruption() ?? (cause instanceof ArchiveDecoderError
      ? cause
      : error('PAGE_CORRUPT', 'The page member could not be decompressed.'));
  } finally {
    stopWatching();
    if (!stream.destroyed) stream.destroy();
  }
  if (actual !== expected) throw error('PAGE_CORRUPT', 'The page member size does not match the archive.');
  if ((checksum >>> 0) !== (entry.crc32 >>> 0)) throw error('PAGE_CORRUPT', 'The page member failed its CRC check.');
  return Buffer.concat(chunks, actual);
}

function sniffFormat(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.toString('latin1', 0, 6))) return 'gif';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

// Header-level validation: the content must be one of the four page formats, Sharp must agree,
// and the declared dimensions must fit the limits. Sharp reads the header on the libuv pool,
// so the event loop is not blocked, and no pixels are decoded here.
export async function inspectImage(bytes, limits) {
  const format = sniffFormat(bytes);
  if (!format) throw error('PAGE_INVALID_IMAGE', 'The page is not a supported image.');
  sharpRuntime.initialize();
  let metadata;
  try {
    // metadata() parses the header only; the pixel bound is checked explicitly below so an
    // oversized page reports IMAGE_LIMIT_EXCEEDED rather than an unreadable image.
    metadata = await sharp(bytes, { failOn: 'error', limitInputPixels: false }).metadata();
  } catch {
    throw error('PAGE_INVALID_IMAGE', 'The page image could not be read.');
  }
  const { width, height } = metadata;
  if (metadata.format !== format || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || width < 1 || height < 1) {
    throw error('PAGE_INVALID_IMAGE', 'The page image could not be read.');
  }
  if (width > limits.maxImageDimension || height > limits.maxImageDimension || width * height > limits.maxImagePixels) {
    throw error('IMAGE_LIMIT_EXCEEDED', 'The page image dimensions exceed the allowed limits.');
  }
  const frameCount = Number.isSafeInteger(metadata.pages) && metadata.pages > 0 ? metadata.pages : 1;
  return Object.freeze({ format, mimeType: MIME_BY_FORMAT[format], width, height, frameCount, animated: frameCount > 1 });
}

/**
 * Read one page by its 1-based catalog position.
 *
 * The catalog is rebuilt from the same descriptor in the same call, so the position always
 * refers to the member the catalog shows for these bytes. Positions never shift when another
 * page is unreadable. Animated GIF/WebP pages are returned as stored with `animated: true`;
 * the consumer shows the first frame as a still page.
 *
 * @param {{ handle: number|import('node:fs/promises').FileHandle, stat: import('node:fs').Stats }} openFile
 * @param {number} position
 * @param {{ signal?: AbortSignal, limits?: Partial<typeof CBZ_READER_LIMITS> }} [options]
 * @returns {Promise<{ page: object, bytes: Buffer, image: { format: string, mimeType: string,
 *   width: number, height: number, frameCount: number, animated: boolean }, catalog: object }>}
 *   `catalog` is the inspectCbz-shaped catalog the page was selected from in this same call.
 * @throws {ArchiveDecoderError} PAGE_NOT_FOUND, a page `problem` code, PAGE_CORRUPT,
 *   PAGE_INVALID_IMAGE, IMAGE_LIMIT_EXCEEDED, or any archive-level code from inspectCbz.
 */
export async function readCbzPage(openFile, position, options) {
  if (!Number.isSafeInteger(position) || position < 1) throw error('PAGE_NOT_FOUND', 'The archive has no such page.');
  return withArchive(openFile, options, async ({ zipfile, catalog, limits, guard }) => {
    const selected = catalog[position - 1];
    if (!selected) throw error('PAGE_NOT_FOUND', 'The archive has no such page.');
    const { page, entry } = selected;
    if (page.problem) throw error(page.problem, 'The page cannot be read: ' + page.problem + '.');
    const bytes = await readMemberBytes(zipfile, entry, guard);
    guard.checkpoint();
    const image = await inspectImage(bytes, limits);
    // The catalog this read selected from, so a caller can tie the page to a manifest revision.
    return { page, bytes, image, catalog: catalogResult(catalog, zipfile.entryCount) };
  });
}
