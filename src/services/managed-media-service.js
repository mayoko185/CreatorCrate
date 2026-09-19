import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { ManagedImageError, MANAGED_IMAGE_LIMITS, revalidateCommittedManagedImageBuffer,
  inspectManagedImageBufferLightweight, validateManagedImageBuffer } from './managed-image-service.js';
import { buildDerivativePipeline, IMAGE_DERIVATIVE_CONFIG } from './preview-service.js';
import { DERIVATIVE_CONFIG_VERSION, ensureCacheDirectory, inspectCachePath,
  atomicWriteBuffer, removeDerivative, PreviewCacheError } from '../storage/preview-cache.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FORMATS = { 'image/png': ['png', 'png'], 'image/jpeg': ['jpg', 'jpeg'], 'image/webp': ['webp', 'webp'] };
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => a.dev >= 0n && a.ino > 0n && a.dev === b.dev && a.ino === b.ino;
const sameNumbers = (left, right) => Array.isArray(left) && Array.isArray(right)
  && left.length === right.length && left.every((value, index) => value === right[index]);
const SHA256 = /^[0-9a-f]{64}$/;
const CACHE_AUTHORITY_KEYS = ['authorityVersion', 'sourceSha256', 'kind', 'derivativePolicyVersion',
  'sizeBytes', 'sha256', 'mimeType', 'width', 'height', 'animated', 'frameCount'];
const ANIMATED_CACHE_AUTHORITY_KEYS = [...CACHE_AUTHORITY_KEYS, 'delay', 'loop'];

export const MANAGED_DERIVATIVE_CACHE_AUTHORITY_VERSION = 1;
export const MANAGED_DERIVATIVE_METADATA_MAX_BYTES = 4096;

export class ManagedMediaError extends Error {
  constructor(code = 'MEDIA_UNAVAILABLE') {
    super(code === 'CACHE_UNAVAILABLE' ? 'Managed media cache is unavailable.' : 'Managed media is unavailable.');
    this.name = 'ManagedMediaError';
    this.code = code;
  }
}

class SourceUnavailableError extends Error {}

const sourceUnavailable = () => new SourceUnavailableError('Managed media source authority is unavailable.');
const sourceOperation = (operation) => {
  try {
    return operation();
  } catch (error) {
    if (error?.code === 'ENOENT') throw sourceUnavailable();
    throw error;
  }
};

function readBoundedCacheFile(cacheRoot, file, maximumBytes) {
  const inspected = inspectCachePath(cacheRoot, file, 'file');
  if (!inspected.ok) {
    if (inspected.reason === 'missing') return { state: 'missing' };
    throw new PreviewCacheError('Cannot read managed media cache.');
  }
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maximumBytes)) return { state: 'invalid' };
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) return { state: 'invalid' };
      offset += count;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    if (!same(before, after) || after.size !== before.size || after.mtimeNs !== before.mtimeNs
      || after.ctimeNs !== before.ctimeNs) return { state: 'invalid' };
    return { state: 'ok', bytes };
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'missing' };
    if (typeof error?.code === 'string') throw new PreviewCacheError('Cannot read managed media cache.');
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function parseCacheAuthority(bytes) {
  let authority;
  try {
    authority = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (!authority || typeof authority !== 'object' || Array.isArray(authority)) return null;
  const expectedKeys = authority.animated === true ? ANIMATED_CACHE_AUTHORITY_KEYS : CACHE_AUTHORITY_KEYS;
  const keys = Object.keys(authority);
  if (keys.length !== expectedKeys.length || keys.some((key) => !expectedKeys.includes(key))
    || authority.authorityVersion !== MANAGED_DERIVATIVE_CACHE_AUTHORITY_VERSION
    || !SHA256.test(authority.sourceSha256) || !['thumbnail', 'preview'].includes(authority.kind)
    || !Number.isSafeInteger(authority.derivativePolicyVersion) || authority.derivativePolicyVersion < 1
    || !Number.isSafeInteger(authority.sizeBytes) || authority.sizeBytes < 1
      || authority.sizeBytes > MANAGED_IMAGE_LIMITS.bytes
    || !SHA256.test(authority.sha256) || authority.mimeType !== 'image/webp'
    || !Number.isSafeInteger(authority.width) || authority.width < 1
      || authority.width > MANAGED_IMAGE_LIMITS.dimension
    || !Number.isSafeInteger(authority.height) || authority.height < 1
      || authority.height > MANAGED_IMAGE_LIMITS.dimension
    || typeof authority.animated !== 'boolean'
    || !Number.isSafeInteger(authority.frameCount) || authority.frameCount < 1
      || authority.frameCount > MANAGED_IMAGE_LIMITS.frames
    || authority.width * authority.height > MANAGED_IMAGE_LIMITS.pixels
    || authority.frameCount > Math.floor(MANAGED_IMAGE_LIMITS.cumulativePixels
      / (authority.width * authority.height))) return null;
  if (authority.animated) {
    if (!Array.isArray(authority.delay) || authority.delay.length !== authority.frameCount
      || authority.delay.some((delay) => !Number.isSafeInteger(delay) || delay < 0 || delay > 0xffffff)
      || !Number.isSafeInteger(authority.loop) || authority.loop < 0 || authority.loop > 0xffff) return null;
  } else if (authority.frameCount !== 1) return null;
  return authority;
}

// Configuration owns the root's ancestors, as in managed-asset-storage.
// Check component identities around open/read; downstream decoders receive only
// owned bytes, never a path. Node has no portable openat walk: this shares the
// documented local-filesystem TOCTOU limitation, not an arbitrary-writer sandbox.
function readSource(root, record) {
  const file = path.resolve(root, record.storage_key);
  const inspected = inspectCachePath(root, file, 'file');
  if (!inspected.ok) {
    if (inspected.reason === 'unreadable') throw new Error('Managed media source storage is unreadable.');
    throw sourceUnavailable();
  }
  const paths = [root];
  for (const segment of record.storage_key.split('/')) paths.push(path.join(paths.at(-1), segment));
  const snapshot = () => paths.map((p, i) => {
    const stat = sourceOperation(() => fs.lstatSync(p, { bigint: true }));
    if (stat.isSymbolicLink() || !(i === paths.length - 1 ? stat.isFile() : stat.isDirectory())) {
      throw sourceUnavailable();
    }
    return stat;
  });
  const before = snapshot();
  let fd;
  try {
    fd = sourceOperation(() => fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)));
    const opened = fs.fstatSync(fd, { bigint: true });
    const verify = () => {
      const current = snapshot();
      if (!current.every((s, i) => same(s, before[i])) || !same(opened, current.at(-1))) throw sourceUnavailable();
    };
    if (!opened.isFile() || opened.size !== BigInt(record.size_bytes)) throw sourceUnavailable();
    verify();
    // Bounded descriptor read; a growing file cannot cause an unbounded allocation.
    const bytes = Buffer.alloc(record.size_bytes);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw sourceUnavailable();
      offset += count;
    }
    verify();
    const after = fs.fstatSync(fd, { bigint: true });
    if (!same(opened, after) || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs
      || after.ctimeNs !== opened.ctimeNs || hash(bytes) !== record.sha256) throw sourceUnavailable();
    return bytes;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** ID-only managed media authority. No Project repositories, routes or record writes. */
export function createManagedMediaService({ managedAssetRoot, previewRoot, managedAssetRepository }) {
  const root = path.resolve(managedAssetRoot);
  const cacheRoot = path.resolve(previewRoot);
  const locks = new Map();

  async function resolveSource(id) {
    try {
      if (typeof id !== 'string' || !UUID.test(id)) throw sourceUnavailable();
      const record = managedAssetRepository.findById(id);
      const format = record && Object.hasOwn(FORMATS, record.mime_type) && FORMATS[record.mime_type];
      if (!record || record.id !== id || record.namespace !== 'book-covers' || !format
        || record.storage_key !== `book-covers/${id}/source.${format[0]}`
        || !Number.isSafeInteger(record.size_bytes) || record.size_bytes < 1 || record.size_bytes > MANAGED_IMAGE_LIMITS.bytes
        || !/^[0-9a-f]{64}$/.test(record.sha256)
        || ![record.width, record.height].every((n) => Number.isSafeInteger(n) && n > 0 && n <= MANAGED_IMAGE_LIMITS.dimension)
        || record.width * record.height > MANAGED_IMAGE_LIMITS.pixels) throw sourceUnavailable();
      const bytes = readSource(root, record);
      const validated = await revalidateCommittedManagedImageBuffer(bytes, {
        sizeBytes: record.size_bytes,
        sha256: record.sha256,
        mimeType: record.mime_type,
        width: record.width,
        height: record.height,
      });
      const revision = hash(JSON.stringify([id, record.storage_key, record.sha256, record.size_bytes,
        record.mime_type, record.width, record.height, DERIVATIVE_CONFIG_VERSION, IMAGE_DERIVATIVE_CONFIG])).slice(0, 16);
      return { record: { ...record }, bytes, revision, image: {
        ...validated,
      } };
    } catch (error) {
      if (error instanceof SourceUnavailableError
        || (error instanceof ManagedImageError && error.code === 'INVALID_IMAGE')) {
        throw new ManagedMediaError();
      }
      throw error;
    }
  }

  function expectedDimensions(source, kind) {
    const size = IMAGE_DERIVATIVE_CONFIG[kind];
    const swap = source.image.orientation >= 5;
    const width = swap ? source.image.height : source.image.width;
    const height = swap ? source.image.width : source.image.height;
    const ratio = Math.min(1, size.width / width, size.height / height);
    return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
  }

  async function validateDerivative(bytes, source, kind) {
    const expectedAnimated = kind === 'preview' && source.image.animated;
    const expectedFrames = expectedAnimated ? source.image.frameCount : 1;
    const expected = expectedDimensions(source, kind);
    const validated = await validateManagedImageBuffer(bytes);
    if (validated.mimeType !== 'image/webp' || validated.animated !== expectedAnimated
      || validated.frameCount !== expectedFrames || validated.width !== expected.width
      || validated.height !== expected.height) throw new ManagedImageError('INVALID_IMAGE');
    const metadata = await sharp(bytes, { failOn: 'warning', limitInputPixels: expectedAnimated
      ? MANAGED_IMAGE_LIMITS.cumulativePixels : MANAGED_IMAGE_LIMITS.pixels,
      ...(expectedAnimated ? { animated: true, pages: -1 } : {}) }).metadata();
    if (metadata.exif || metadata.icc || metadata.xmp
      || (metadata.pages ?? 1) !== expectedFrames
      || (expectedAnimated && (metadata.width !== expected.width
        || metadata.pageHeight !== expected.height || metadata.height !== expected.height * expectedFrames
        || !sameNumbers(metadata.delay, source.image.delay) || metadata.loop !== source.image.loop))) {
      throw new ManagedImageError('INVALID_IMAGE');
    }
    return {
      width: validated.width,
      height: validated.height,
      mimeType: validated.mimeType,
      sizeBytes: validated.sizeBytes,
      sha256: validated.sha256,
      animated: expectedAnimated,
      frameCount: expectedFrames,
      ...(expectedAnimated ? { delay: [...source.image.delay], loop: source.image.loop } : {}),
    };
  }

  function buildCacheAuthority(source, kind, derivative) {
    return {
      authorityVersion: MANAGED_DERIVATIVE_CACHE_AUTHORITY_VERSION,
      sourceSha256: source.record.sha256,
      kind,
      derivativePolicyVersion: DERIVATIVE_CONFIG_VERSION,
      sizeBytes: derivative.sizeBytes,
      sha256: derivative.sha256,
      mimeType: derivative.mimeType,
      width: derivative.width,
      height: derivative.height,
      animated: derivative.animated,
      frameCount: derivative.frameCount,
      ...(derivative.animated ? { delay: derivative.delay, loop: derivative.loop } : {}),
    };
  }

  function cacheAuthorityMatchesExpected(authority, source, kind) {
    const expectedAnimated = kind === 'preview' && source.image.animated;
    const expectedFrames = expectedAnimated ? source.image.frameCount : 1;
    const expected = expectedDimensions(source, kind);
    return authority.sourceSha256 === source.record.sha256
      && authority.kind === kind
      && authority.derivativePolicyVersion === DERIVATIVE_CONFIG_VERSION
      && authority.width === expected.width
      && authority.height === expected.height
      && authority.animated === expectedAnimated
      && authority.frameCount === expectedFrames
      && (!expectedAnimated
        || (sameNumbers(authority.delay, source.image.delay) && authority.loop === source.image.loop));
  }

  function inspectedDerivativeMatchesAuthority(inspected, authority) {
    return inspected.sizeBytes === authority.sizeBytes
      && inspected.sha256 === authority.sha256
      && inspected.mimeType === authority.mimeType
      && inspected.width === authority.width
      && inspected.height === authority.height
      && inspected.animated === authority.animated
      && inspected.frameCount === authority.frameCount
      && (!authority.animated
        || (sameNumbers(inspected.delay, authority.delay) && inspected.loop === authority.loop));
  }

  async function derivative(id, kind) {
    if (!Object.hasOwn(IMAGE_DERIVATIVE_CONFIG, kind)) throw new ManagedMediaError();
    const source = await resolveSource(id); // Never serve cached output for an unavailable source.
    const dir = path.join(cacheRoot, 'managed-assets', source.record.id, source.revision);
    const filename = `${kind}.webp`;
    const authorityFilename = `${kind}.authority.json`;
    const file = path.join(dir, filename);
    const authorityFile = path.join(dir, authorityFilename);
    try {
      const authorityRead = readBoundedCacheFile(cacheRoot, authorityFile,
        MANAGED_DERIVATIVE_METADATA_MAX_BYTES);
      const authority = authorityRead.state === 'ok' ? parseCacheAuthority(authorityRead.bytes) : null;
      if (authority && cacheAuthorityMatchesExpected(authority, source, kind)) {
        const derivativeRead = readBoundedCacheFile(cacheRoot, file, MANAGED_IMAGE_LIMITS.bytes);
        if (derivativeRead.state === 'ok' && derivativeRead.bytes.length === authority.sizeBytes
          && hash(derivativeRead.bytes) === authority.sha256) {
          try {
            const inspected = await inspectManagedImageBufferLightweight(derivativeRead.bytes);
            if (inspectedDerivativeMatchesAuthority(inspected, authority)) {
              return { bytes: derivativeRead.bytes, mimeType: authority.mimeType, revision: source.revision,
                width: authority.width, height: authority.height, cacheHit: true };
            }
          } catch (error) {
            if (!(error instanceof ManagedImageError && error.code === 'INVALID_IMAGE')) throw error;
          }
        }
      }
      const animated = kind === 'preview' && source.image.animated;
      const pipeline = await buildDerivativePipeline(source.bytes, { ...IMAGE_DERIVATIVE_CONFIG[kind], animated });
      const { data } = await pipeline.toBuffer({ resolveWithObject: true });
      const validated = await validateDerivative(data, source, kind);
      const authorityBytes = Buffer.from(`${JSON.stringify(buildCacheAuthority(source, kind, validated))}\n`, 'utf8');
      if (authorityBytes.length > MANAGED_DERIVATIVE_METADATA_MAX_BYTES) {
        throw new Error('Managed derivative cache authority exceeds its size limit.');
      }
      ensureCacheDirectory(cacheRoot, dir);
      try {
        // The derivative is published first and authority last. Readers require
        // both and verify the exact hash, so every interruption is a cache miss.
        atomicWriteBuffer(dir, filename, data);
        atomicWriteBuffer(dir, authorityFilename, authorityBytes);
      } catch (error) {
        removeDerivative(dir, filename);
        removeDerivative(dir, authorityFilename);
        throw error;
      }
      return { bytes: data, mimeType: 'image/webp', revision: source.revision,
        width: validated.width, height: validated.height, cacheHit: false };
    } catch (error) {
      if (error instanceof PreviewCacheError) throw new ManagedMediaError('CACHE_UNAVAILABLE');
      throw error;
    }
  }

  return Object.freeze({
    resolveSource,
    async getDerivative(id, kind) {
      // FIFO per ID; each caller verifies the source, including after prior generation.
      const previous = locks.get(id) || Promise.resolve();
      const pending = previous.catch(() => {}).then(() => derivative(id, kind));
      locks.set(id, pending);
      try { return await pending; } finally { if (locks.get(id) === pending) locks.delete(id); }
    },
  });
}
