import crypto from 'node:crypto';
import sharp from 'sharp';
import { sharpRuntime } from './sharp-runtime.js';
import { createManagedAssetStorage } from '../storage/managed-asset-storage.js';

export const MANAGED_IMAGE_LIMITS = Object.freeze({ bytes: 10 * 1024 * 1024, pixels: 40_000_000, dimension: 16_384 });
const FORMATS = Object.freeze({ png: ['png', 'image/png'], jpeg: ['jpg', 'image/jpeg'], webp: ['webp', 'image/webp'] });

export class ManagedImageError extends Error {
  constructor(code) {
    super({ INVALID_IMAGE: 'A valid, single still PNG, JPEG or WebP image within the managed image limits is required.',
      STORAGE_ERROR: 'Managed image storage failed.', COLLISION: 'Managed image storage already exists.',
      DATABASE_ERROR: 'Managed image persistence failed.', RECOVERY_REQUIRED: 'Managed image cleanup requires recovery.',
      COMMITTED_ASSET: 'Committed managed images cannot be compensated.', INVALID_TOKEN: 'Managed image ownership token is invalid.',
      ROLLBACK_REFUSED: 'Managed image database rollback was refused.' }[code]);
    this.name = 'ManagedImageError';
    this.code = code;
  }
}

// libvips can expose only the default image of APNG: reject its animation
// control chunk independently, including malformed chunk framing.
function checkPng(bytes) {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return;
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (length > bytes.length - offset - 12 || type === 'acTL') throw new ManagedImageError('INVALID_IMAGE');
    offset += length + 12;
    if (type === 'IEND') {
      if (length !== 0 || offset !== bytes.length) throw new ManagedImageError('INVALID_IMAGE');
      return;
    }
  }
  throw new ManagedImageError('INVALID_IMAGE');
}

function checkWebp(bytes) {
  if (bytes.readUInt32LE(4) !== bytes.length - 8) throw new Error();
  let offset = 12;
  let extended = false;
  let alpha = false;
  let image = null;
  let profile = false;
  let exif = false;
  let xmp = false;
  let losslessChunk;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new Error();
    const type = bytes.toString('latin1', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    const next = end + (length % 2);
    if (next > bytes.length || (length % 2 && bytes[end] !== 0)) throw new Error();
    // Never treat a nested RIFF/WEBP or animation frame as an unknown chunk.
    if (['RIFF', 'WEBP', 'ANIM', 'ANMF'].includes(type)) throw new Error();
    if (type === 'VP8X') {
      if (offset !== 12 || extended || length !== 10 || (bytes[start] & 0xc3)
        || bytes.readUIntLE(start + 1, 3) !== 0) throw new Error();
      extended = true;
    } else if (type === 'ALPH') {
      if (!extended || alpha || image || length < 1 || !(bytes[20] & 0x10)) throw new Error();
      alpha = true;
    } else if (type === 'VP8 ' || type === 'VP8L') {
      if (image || length === 0 || (type === 'VP8L' && alpha)) throw new Error();
      image = type;
      if (type === 'VP8L') {
        if (length < 5 || bytes[start] !== 0x2f || (bytes[start + 4] & 0xe0)) throw new Error();
        losslessChunk = bytes.subarray(offset, next);
      }
    } else if (type === 'ICCP') {
      if (!extended || profile || alpha || image) throw new Error();
      profile = true;
    } else if (type === 'EXIF') {
      exif = true;
    } else if (type === 'XMP ') {
      xmp = true;
    }
    // EXIF, XMP and unknown ancillary chunks are opaque, not image payloads.
    offset = next;
  }
  if (!image) throw new Error();
  if (image === 'VP8 ' && extended && (bytes[20] & 0x10) && !alpha) throw new Error();
  const flags = extended ? bytes[20] : 0;
  if (Boolean(flags & 0x20) !== profile || Boolean(flags & 0x08) !== exif
    || Boolean(flags & 0x04) !== xmp) throw new Error();
  if (extended && losslessChunk) return { losslessChunk, alpha: Boolean(flags & 0x10) };
}

function checkContainer(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return checkPng(bytes);
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF'
    && bytes.toString('latin1', 8, 12) === 'WEBP') return checkWebp(bytes);
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error();
  // Follow JPEG segment lengths rather than searching metadata for marker-like
  // bytes (EXIF thumbnails can contain JPEGs). Require one complete codestream.
  let offset = 2;
  let scan = false;
  while (offset < bytes.length) {
    if (scan) while (offset < bytes.length && bytes[offset] !== 0xff) offset++;
    if (bytes[offset++] !== 0xff) throw new Error();
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (scan && (marker === 0 || (marker >= 0xd0 && marker <= 0xd7))) continue;
    if (marker === 0xd9) {
      if (offset !== bytes.length) throw new Error();
      return;
    }
    if (marker === 0xd8 || marker === 0 || marker === undefined) throw new Error();
    if (marker === 1) continue;
    if (offset + 2 > bytes.length) throw new Error();
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) throw new Error();
    // Multi-Picture Format is not a single still image, even when the decoder
    // exposes only its primary JPEG.
    if (marker === 0xe2 && bytes.toString('ascii', offset + 2, offset + 6) === 'MPF\0') throw new Error();
    offset += length;
    scan = marker === 0xda;
  }
  throw new Error();
}

async function validate(bytes) {
  try {
    const webp = checkContainer(bytes);
    sharpRuntime.initialize();
    const options = { failOn: 'warning', limitInputPixels: MANAGED_IMAGE_LIMITS.pixels };
    const metadata = await sharp(bytes, options).metadata();
    const { width, height, format } = metadata;
    if (!Object.hasOwn(FORMATS, format) || (metadata.pages ?? 1) !== 1
      || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
      || width > MANAGED_IMAGE_LIMITS.dimension || height > MANAGED_IMAGE_LIMITS.dimension
      || width * height > MANAGED_IMAGE_LIMITS.pixels) throw new Error();
    if (webp?.losslessChunk) {
      // VP8L's alpha_is_used is only a hint. Decode its isolated bitstream with
      // that hint enabled, never letting a malformed VP8X suppress alpha.
      const isolated = Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBP'), webp.losslessChunk]);
      isolated.writeUInt32LE(isolated.length - 8, 4);
      isolated[24] |= 0x10;
      const { data, info } = await sharp(isolated, options).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      if (info.width !== width || info.height !== height || info.channels !== 4) throw new Error();
      let transparent = false;
      for (let offset = 3; offset < data.length; offset += 4) {
        if (data[offset] !== 255) { transparent = true; break; }
      }
      if (transparent !== webp.alpha) throw new Error();
    }
    // Metadata alone does not detect truncated pixel data. Force full decode,
    // without resizing, then check the actual decoded dimensions as well.
    const { info } = await sharp(bytes, options).raw().toBuffer({ resolveWithObject: true });
    if (info.width !== width || info.height !== height) throw new Error();
    return { width, height, extension: FORMATS[format][0], mimeType: FORMATS[format][1],
      sizeBytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  } catch { throw new ManagedImageError('INVALID_IMAGE'); }
}

/** Buffer-only ingestion; transport limits and active-upload coordination belong to later packages. */
export function createManagedImageService({ managedAssetRoot, managedAssetRepository,
  storage = createManagedAssetStorage({ managedAssetRoot }), generateId = crypto.randomUUID }) {
  const tokens = new WeakMap();
  return Object.freeze({
    async createCommittedImage(input = {}) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ManagedImageError('INVALID_IMAGE');
      const { bytes, namespace = 'book-covers' } = input;
      if (namespace !== 'book-covers' || !Buffer.isBuffer(bytes) || bytes.length === 0
        || bytes.length > MANAGED_IMAGE_LIMITS.bytes) throw new ManagedImageError('INVALID_IMAGE');
      const ownedBytes = Buffer.from(bytes);
      let operation;
      let record;
      try {
        operation = storage.stage(ownedBytes, generateId());
        const metadata = await validate(ownedBytes);
        const storageKey = storage.publish(operation, metadata.extension, metadata.sha256);
        try {
          record = managedAssetRepository.insertCommitted({ id: operation.id, storageKey, namespace, ...metadata });
        } catch { throw new ManagedImageError('DATABASE_ERROR'); }
        if (!storage.cleanStaging(operation)) throw new ManagedImageError('RECOVERY_REQUIRED');
        const ownershipToken = Object.freeze({});
        tokens.set(ownershipToken, { operation, record });
        return { record, ownershipToken };
      } catch (error) {
        let clean = true;
        if (operation) {
          // An uncertain insert outcome must not delete a persisted source.
          try {
            if (!record && (!operation.published || !managedAssetRepository.findById(operation.id))) clean = storage.compensate(operation);
            else if (!record) clean = false;
          } catch { clean = false; }
          clean = storage.cleanStaging(operation) && clean;
        }
        if (!clean) throw new ManagedImageError('RECOVERY_REQUIRED');
        if (error instanceof ManagedImageError) throw error;
        throw new ManagedImageError(error?.code === 'RECOVERY_REQUIRED' ? 'RECOVERY_REQUIRED'
          : error?.code === 'EEXIST' ? 'COLLISION' : 'STORAGE_ERROR');
      }
    },
    // Explicit DB-only rollback for a failed later compound operation.
    rollbackCommitted(ownershipToken) {
      const creation = tokens.get(ownershipToken);
      if (!creation) throw new ManagedImageError('INVALID_TOKEN');
      try {
        if (!managedAssetRepository.rollbackCommitted(creation.record)) throw new ManagedImageError('ROLLBACK_REFUSED');
      } catch (error) {
        if (error instanceof ManagedImageError) throw error;
        throw new ManagedImageError('DATABASE_ERROR');
      }
    },
    // Only after explicit DB rollback has removed the inserted row.
    // This is not asset deletion or garbage collection; tokens are instance-local.
    compensate(ownershipToken) {
      const creation = tokens.get(ownershipToken);
      if (!creation) throw new ManagedImageError('INVALID_TOKEN');
      const { operation } = creation;
      try {
        if (managedAssetRepository.findById(operation.id)) throw new ManagedImageError('COMMITTED_ASSET');
        if (!storage.compensate(operation)) throw new ManagedImageError('RECOVERY_REQUIRED');
        tokens.delete(ownershipToken);
      } catch (error) {
        if (error instanceof ManagedImageError) throw error;
        throw new ManagedImageError('RECOVERY_REQUIRED');
      }
    },
  });
}
