import fs from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';

const STORE_COMPRESSION = 0;
const DEFLATE_COMPRESSION = 8;

const KRA_EXTENSION = 'kra';
const KRZ_EXTENSION = 'krz';

/**
 * Resource limits for one embedded preview entry. These limits apply only to
 * the selected entry; the ZIP reader still uses random access and never
 * buffers the complete Krita document.
 */
export const KRITA_PREVIEW_LIMITS = Object.freeze({
  maxEntries: 10_000,
  maxCompressedBytes: 128 * 1024 * 1024,
  maxUncompressedBytes: 256 * 1024 * 1024,
  maxCompressionRatio: 1_000,
});

const CANDIDATE_NAMES = Object.freeze({
  merged: 'mergedimage.png',
  thumbnail: 'preview.png',
});

/**
 * Focused internal error for every archive/extraction failure. Details from
 * yauzl, zlib, or the filesystem are intentionally not exposed to callers.
 */
export class KritaPreviewExtractionError extends Error {
  constructor() {
    super('Embedded Krita preview is unavailable.');
    this.name = 'KritaPreviewExtractionError';
    this.code = 'KRITA_PREVIEW_UNAVAILABLE';
  }
}

/**
 * Random-access reader over a descriptor owned by the caller.
 *
 * yauzl's fromFd path closes the supplied descriptor when its reader is
 * closed. This reader deliberately makes close a no-op so the descriptor
 * remains owned by openAssetFile's caller and is closed exactly once there.
 */
class OpenDescriptorReader extends yauzl.RandomAccessReader {
  constructor(handle) {
    super();
    this.handle = handle;
  }

  _readStreamForRange(start, end) {
    return new DescriptorRangeStream(this.handle, start, end);
  }

  close(callback) {
    setImmediate(callback);
  }
}

/**
 * Positional descriptor stream that never owns or closes the descriptor.
 * Node's fs.ReadStream.destroy() closes an fd supplied through `fd` on the
 * current runtime even with autoClose:false, so the extractor uses fs.read
 * directly and keeps stream destruction separate from descriptor ownership.
 */
class DescriptorRangeStream extends Readable {
  constructor(handle, start, end) {
    super();
    this.handle = handle;
    this.position = start;
    this.end = end;
    this.pending = false;
    this.destroyCallback = null;
    this.destroyError = null;
  }

  _read(size) {
    if (this.pending || this.position >= this.end) {
      if (!this.pending && this.position >= this.end) this.push(null);
      return;
    }

    const length = Math.min(
      Math.max(size || 64 * 1024, 1),
      this.end - this.position
    );
    const buffer = Buffer.allocUnsafe(length);
    this.pending = true;
    fs.read(this.handle, buffer, 0, length, this.position, (err, bytesRead) => {
      this.pending = false;

      if (this.destroyCallback) {
        const callback = this.destroyCallback;
        this.destroyCallback = null;
        callback(this.destroyError);
        return;
      }

      if (err) {
        this.destroy(err);
        return;
      }
      if (bytesRead === 0) {
        this.push(null);
        return;
      }

      this.position += bytesRead;
      this.push(buffer.subarray(0, bytesRead));
    });
  }

  _destroy(err, callback) {
    if (this.pending) {
      this.destroyError = err;
      this.destroyCallback = callback;
      return;
    }
    callback(err);
  }
}

function fail() {
  throw new KritaPreviewExtractionError();
}

function resolveLimits(overrides = {}) {
  const limits = {
    ...KRITA_PREVIEW_LIMITS,
    ...overrides,
  };

  if (
    !Number.isSafeInteger(limits.maxEntries) ||
    limits.maxEntries <= 0 ||
    !Number.isSafeInteger(limits.maxCompressedBytes) ||
    limits.maxCompressedBytes <= 0 ||
    !Number.isSafeInteger(limits.maxUncompressedBytes) ||
    limits.maxUncompressedBytes <= 0 ||
    !Number.isFinite(limits.maxCompressionRatio) ||
    limits.maxCompressionRatio <= 0
  ) {
    fail();
  }

  return limits;
}

function assertOpenDescriptor(openFile) {
  if (
    !openFile ||
    !Number.isInteger(openFile.handle) ||
    openFile.handle < 0 ||
    !openFile.stat ||
    !Number.isSafeInteger(openFile.stat.size) ||
    openFile.stat.size < 0
  ) {
    fail();
  }
}

function candidateFor(extension, candidates) {
  if (extension === KRA_EXTENSION) {
    return candidates.merged || candidates.thumbnail || null;
  }
  if (extension === KRZ_EXTENSION) {
    return candidates.thumbnail || null;
  }
  return null;
}

function isEncrypted(entry) {
  return typeof entry.isEncrypted === 'function'
    ? entry.isEncrypted()
    : (entry.generalPurposeBitFlag & 0x1) !== 0;
}

function validateCandidate(entry, limits) {
  if (isEncrypted(entry)) fail();

  if (
    entry.compressionMethod !== STORE_COMPRESSION &&
    entry.compressionMethod !== DEFLATE_COMPRESSION
  ) {
    fail();
  }

  if (
    !Number.isSafeInteger(entry.compressedSize) ||
    !Number.isSafeInteger(entry.uncompressedSize) ||
    entry.compressedSize < 0 ||
    entry.uncompressedSize < 0
  ) {
    fail();
  }

  if (
    entry.compressedSize > limits.maxCompressedBytes ||
    entry.uncompressedSize > limits.maxUncompressedBytes
  ) {
    fail();
  }

  const ratio = entry.compressedSize === 0
    ? (entry.uncompressedSize === 0 ? 0 : Number.POSITIVE_INFINITY)
    : entry.uncompressedSize / entry.compressedSize;
  if (ratio > limits.maxCompressionRatio) fail();
}

async function readEntryBytes(zipfile, entry, limits) {
  let stream;
  try {
    // Omit decodeFileData: yauzl's installed API uses the default decode path
    // for DEFLATE entries, while an explicit true value selects raw mode.
    stream = await zipfile.openReadStreamPromise(entry);
  } catch {
    fail();
  }

  const chunks = [];
  let actualSize = 0;
  const output = new Writable({
    write(chunk, encoding, callback) {
      actualSize += chunk.length;
      if (actualSize > limits.maxUncompressedBytes) {
        // Destroy the source immediately; pipeline also waits for teardown
        // before it rejects, so the descriptor is not closed mid-read.
        stream.destroy();
        callback(new Error('embedded preview output exceeds limit'));
        return;
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      callback();
    },
  });

  try {
    await pipeline(stream, output);
  } catch {
    fail();
  } finally {
    if (!stream.destroyed) stream.destroy();
  }

  let bytes;
  try {
    bytes = Buffer.concat(chunks, actualSize);
  } catch {
    fail();
  }

  if (
    bytes.length !== entry.uncompressedSize ||
    bytes.length > limits.maxUncompressedBytes
  ) {
    fail();
  }

  return bytes;
}

async function scanCandidates(zipfile, extension, limits) {
  if (
    !Number.isSafeInteger(zipfile.entryCount) ||
    zipfile.entryCount > limits.maxEntries
  ) {
    fail();
  }

  const candidates = { merged: null, thumbnail: null };
  try {
    for await (const entry of zipfile.eachEntry()) {
      if (entry.fileName === CANDIDATE_NAMES.merged && !candidates.merged) {
        candidates.merged = entry;
      }
      if (entry.fileName === CANDIDATE_NAMES.thumbnail && !candidates.thumbnail) {
        candidates.thumbnail = entry;
      }
    }
  } catch {
    fail();
  }

  const selected = candidateFor(extension, candidates);
  if (!selected) fail();
  validateCandidate(selected, limits);
  return selected;
}

/**
 * Extract the preferred embedded PNG from an already-opened Krita archive.
 *
 * The caller retains ownership of `openFile` and MUST close it after this
 * promise settles. This function never reopens or closes the descriptor.
 *
 * @param {{ handle: number, stat: { size: number } }} openFile
 * @param {{ extension: 'kra'|'krz', limits?: Partial<typeof KRITA_PREVIEW_LIMITS> }} options
 * @returns {Promise<{ bytes: Buffer, entryName: 'mergedimage.png'|'preview.png', quality: 'merged'|'thumbnail' }>}
 */
export async function extractKritaPreview(openFile, { extension, limits: limitOverrides } = {}) {
  assertOpenDescriptor(openFile);
  const normalizedExtension = String(extension || '').toLowerCase();
  if (normalizedExtension !== KRA_EXTENSION && normalizedExtension !== KRZ_EXTENSION) {
    fail();
  }

  const limits = resolveLimits(limitOverrides);
  const reader = new OpenDescriptorReader(openFile.handle);
  let zipfile = null;

  try {
    try {
      zipfile = await yauzl.fromRandomAccessReaderPromise(
        reader,
        openFile.stat.size,
        {
          autoClose: false,
          lazyEntries: true,
          decodeStrings: true,
          validateEntrySizes: true,
          strictFileNames: true,
        }
      );
    } catch {
      fail();
    }

    const entry = await scanCandidates(zipfile, normalizedExtension, limits);
    const bytes = await readEntryBytes(zipfile, entry, limits);
    const quality = entry.fileName === CANDIDATE_NAMES.merged ? 'merged' : 'thumbnail';

    return {
      bytes,
      entryName: entry.fileName,
      quality,
    };
  } catch (err) {
    if (err instanceof KritaPreviewExtractionError) throw err;
    throw new KritaPreviewExtractionError();
  } finally {
    if (zipfile) {
      try {
        zipfile.close();
      } catch {
        // The caller still owns the descriptor; cleanup is best effort here.
      }
    } else if (reader.refCount > 0) {
      try {
        reader.unref();
      } catch {
        // No descriptor is closed by this reader.
      }
    }
  }
}
