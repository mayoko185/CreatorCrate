import crypto from 'node:crypto';
import sharp from 'sharp';
import { sharpRuntime } from './sharp-runtime.js';
import { createManagedAssetStorage } from '../storage/managed-asset-storage.js';

export const MANAGED_IMAGE_LIMITS = Object.freeze({
  bytes: 10 * 1024 * 1024,
  pixels: 40_000_000,
  cumulativePixels: 100_000_000,
  dimension: 16_384,
  frames: 120,
});
const FORMATS = Object.freeze({ png: ['png', 'image/png'], jpeg: ['jpg', 'image/jpeg'], webp: ['webp', 'image/webp'] });

export class ManagedImageError extends Error {
  constructor(code) {
    super({ INVALID_IMAGE: 'A valid PNG, JPEG or WebP image, including bounded animated WebP, within the managed image limits is required.',
      STORAGE_ERROR: 'Managed image storage failed.', COLLISION: 'Managed image storage already exists.',
      DATABASE_ERROR: 'Managed image persistence failed.', RECOVERY_REQUIRED: 'Managed image cleanup requires recovery.',
      COMMITTED_ASSET: 'Committed managed images cannot be compensated.', INVALID_TOKEN: 'Managed image ownership token is invalid.',
      ROLLBACK_REFUSED: 'Managed image database rollback was refused.' }[code]);
    this.name = 'ManagedImageError';
    this.code = code;
  }
}

function invalidImage() {
  return new ManagedImageError('INVALID_IMAGE');
}

function isRecognizedSharpInvalidImage(error) {
  if (error?.constructor !== Error || typeof error.message !== 'string') return false;
  return error.message === 'Input buffer contains unsupported image format'
    || error.message === 'Input image exceeds pixel limit'
    || error.message.startsWith('Input buffer has corrupt header:')
    || /^vipspng: libpng read error(?:\nvipspng: libpng read error)*$/.test(error.message)
    || /^pngload_buffer: load error(?:\npngload_buffer: load error)*$/.test(error.message)
    || /^VipsJpeg: (?:Corrupt JPEG data:|Bogus Huffman table definition|Invalid SOS parameters for sequential JPEG|Quantization table 0x[\da-fA-F]+ was not defined)/.test(error.message)
    || /^webp2vips: unable to read pixels(?:\nwebpload_buffer: load error)*$/.test(error.message);
}

function readUInt24LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function assertBoundedDimensions(width, height, frameCount = 1) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || !Number.isSafeInteger(frameCount) || width < 1 || height < 1 || frameCount < 1
    || width > MANAGED_IMAGE_LIMITS.dimension || height > MANAGED_IMAGE_LIMITS.dimension
    || frameCount > MANAGED_IMAGE_LIMITS.frames) throw invalidImage();
  const framePixels = width * height;
  if (framePixels > MANAGED_IMAGE_LIMITS.pixels
    || frameCount > Math.floor(MANAGED_IMAGE_LIMITS.cumulativePixels / framePixels)) throw invalidImage();
}

function webpChunk(bytes, offset, limit) {
  if (offset + 8 > limit) throw invalidImage();
  const type = bytes.toString('latin1', offset, offset + 4);
  const length = bytes.readUInt32LE(offset + 4);
  const start = offset + 8;
  if (length > limit - start) throw invalidImage();
  const end = start + length;
  const next = end + (length % 2);
  if (next > limit || (length % 2 && bytes[end] !== 0)) throw invalidImage();
  return { type, length, start, end, next, bytes: bytes.subarray(offset, next) };
}

function losslessDimensions(bytes, start, length) {
  if (length < 5 || bytes[start] !== 0x2f || (bytes[start + 4] & 0xe0)) throw invalidImage();
  return {
    width: 1 + bytes[start + 1] + ((bytes[start + 2] & 0x3f) << 8),
    height: 1 + (bytes[start + 2] >> 6) + (bytes[start + 3] << 2) + ((bytes[start + 4] & 0x0f) << 10),
  };
}

function lossyDimensions(bytes, start, length) {
  if (length < 10 || bytes[start + 3] !== 0x9d || bytes[start + 4] !== 0x01 || bytes[start + 5] !== 0x2a) {
    throw invalidImage();
  }
  return { width: bytes.readUInt16LE(start + 6) & 0x3fff, height: bytes.readUInt16LE(start + 8) & 0x3fff };
}

function isolatedWebp(chunks, extended) {
  let header = [];
  if (extended) {
    const vp8x = Buffer.alloc(18);
    vp8x.write('VP8X', 0, 'latin1');
    vp8x.writeUInt32LE(10, 4);
    vp8x[8] = extended.alpha ? 0x10 : 0;
    vp8x.writeUIntLE(extended.width - 1, 12, 3);
    vp8x.writeUIntLE(extended.height - 1, 15, 3);
    header = [vp8x];
  }
  const result = Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBP'), ...header, ...chunks]);
  result.writeUInt32LE(result.length - 8, 4);
  return result;
}

function checkAnimatedFrame(bytes, chunk, canvasWidth, canvasHeight) {
  if (chunk.length < 16) throw invalidImage();
  const x = readUInt24LE(bytes, chunk.start) * 2;
  const y = readUInt24LE(bytes, chunk.start + 3) * 2;
  const width = readUInt24LE(bytes, chunk.start + 6) + 1;
  const height = readUInt24LE(bytes, chunk.start + 9) + 1;
  // Reading the 24-bit duration validates its complete representation. Zero,
  // small and long delays are all valid policy values.
  const delay = readUInt24LE(bytes, chunk.start + 12);
  if ((bytes[chunk.start + 15] & 0xfc) !== 0 || width > canvasWidth || height > canvasHeight
    || x > canvasWidth - width || y > canvasHeight - height) throw invalidImage();

  let offset = chunk.start + 16;
  let alphaChunk;
  let imageChunk;
  let imageType;
  while (offset < chunk.end) {
    const nested = webpChunk(bytes, offset, chunk.end);
    if (nested.type === 'ALPH') {
      if (alphaChunk || imageChunk || nested.length < 1 || (bytes[nested.start] & 0xc0)
        || (bytes[nested.start] & 0x03) > 1 || ((bytes[nested.start] >> 4) & 0x03) > 1) throw invalidImage();
      alphaChunk = nested.bytes;
    } else if (nested.type === 'VP8 ' || nested.type === 'VP8L') {
      if (imageChunk || nested.length === 0 || (nested.type === 'VP8L' && alphaChunk)) throw invalidImage();
      const dimensions = nested.type === 'VP8L'
        ? losslessDimensions(bytes, nested.start, nested.length)
        : lossyDimensions(bytes, nested.start, nested.length);
      if (dimensions.width !== width || dimensions.height !== height) throw invalidImage();
      imageChunk = nested.bytes;
      imageType = nested.type;
    } else {
      throw invalidImage();
    }
    offset = nested.next;
  }
  if (!imageChunk) throw invalidImage();
  return {
    width,
    height,
    delay,
    hasAlpha: Boolean(alphaChunk),
    losslessChunk: imageType === 'VP8L' ? imageChunk : undefined,
    isolated: isolatedWebp(alphaChunk ? [alphaChunk, imageChunk] : [imageChunk],
      alphaChunk ? { alpha: true, width, height } : undefined),
  };
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
  if (bytes.readUInt32LE(4) !== bytes.length - 8) throw invalidImage();
  let offset = 12;
  let extended = false;
  let alpha = false;
  let image = null;
  let profile = false;
  let exif = false;
  let xmp = false;
  let losslessChunk;
  let animation = false;
  let animationChunk = false;
  let loop;
  let animationHasAlpha = false;
  const frames = [];
  let canvasWidth;
  let canvasHeight;
  while (offset < bytes.length) {
    const chunk = webpChunk(bytes, offset, bytes.length);
    const { type, length, start, next } = chunk;
    // Never treat a nested RIFF/WEBP as an unknown chunk.
    if (type === 'RIFF' || type === 'WEBP') throw invalidImage();
    if (type === 'VP8X') {
      if (offset !== 12 || extended || length !== 10 || (bytes[start] & 0xc1)
        || bytes.readUIntLE(start + 1, 3) !== 0) throw invalidImage();
      extended = true;
      animation = Boolean(bytes[start] & 0x02);
      canvasWidth = readUInt24LE(bytes, start + 4) + 1;
      canvasHeight = readUInt24LE(bytes, start + 7) + 1;
      assertBoundedDimensions(canvasWidth, canvasHeight);
    } else if (type === 'ALPH') {
      if (!extended || animation || alpha || image || length < 1 || !(bytes[20] & 0x10)) throw invalidImage();
      alpha = true;
    } else if (type === 'VP8 ' || type === 'VP8L') {
      if (animation || image || length === 0 || (type === 'VP8L' && alpha)) throw invalidImage();
      image = type;
      if (type === 'VP8L') {
        losslessDimensions(bytes, start, length);
        losslessChunk = bytes.subarray(offset, next);
      }
    } else if (type === 'ICCP') {
      if (!extended || profile || alpha || image || animationChunk || frames.length) throw invalidImage();
      profile = true;
    } else if (type === 'ANIM') {
      if (!extended || !animation || animationChunk || frames.length || image || alpha || length !== 6) throw invalidImage();
      animationChunk = true;
      // All 32 bits are the background color; the final two bytes are the
      // complete unsigned 16-bit loop count. Neither field is normalized.
      bytes.readUInt32LE(start);
      loop = bytes.readUInt16LE(start + 4);
    } else if (type === 'ANMF') {
      if (!extended || !animation || !animationChunk || image || alpha
        || frames.length >= MANAGED_IMAGE_LIMITS.frames) throw invalidImage();
      const frame = checkAnimatedFrame(bytes, chunk, canvasWidth, canvasHeight);
      animationHasAlpha ||= frame.hasAlpha;
      frames.push(frame);
    } else if (type === 'EXIF') {
      exif = true;
    } else if (type === 'XMP ') {
      xmp = true;
    }
    // EXIF, XMP and unknown ancillary chunks are opaque, not image payloads.
    offset = next;
  }
  const flags = extended ? bytes[20] : 0;
  if (animation) {
    if (!animationChunk || frames.length === 0 || image || alpha) throw invalidImage();
    assertBoundedDimensions(canvasWidth, canvasHeight, frames.length);
  } else {
    if (!image || animationChunk || frames.length) throw invalidImage();
    if (image === 'VP8 ' && extended && (flags & 0x10) && !alpha) throw invalidImage();
  }
  if (Boolean(flags & 0x20) !== profile || Boolean(flags & 0x08) !== exif
    || Boolean(flags & 0x04) !== xmp) throw invalidImage();
  if (animation) return {
    animated: true,
    frameCount: frames.length,
    canvasWidth,
    canvasHeight,
    alpha: Boolean(flags & 0x10),
    animationHasAlpha,
    delay: frames.map((frame) => frame.delay),
    loop,
    frames,
  };
  return { animated: false, frameCount: 1,
    ...(extended && losslessChunk ? { losslessChunk, alpha: Boolean(flags & 0x10) } : {}) };
}

function checkContainer(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return checkPng(bytes);
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF'
    && bytes.toString('latin1', 8, 12) === 'WEBP') return checkWebp(bytes);
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw invalidImage();
  // Follow JPEG segment lengths rather than searching metadata for marker-like
  // bytes (EXIF thumbnails can contain JPEGs). Require one complete codestream.
  let offset = 2;
  let scan = false;
  while (offset < bytes.length) {
    if (scan) while (offset < bytes.length && bytes[offset] !== 0xff) offset++;
    if (bytes[offset++] !== 0xff) throw invalidImage();
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (scan && (marker === 0 || (marker >= 0xd0 && marker <= 0xd7))) continue;
    if (marker === 0xd9) {
      if (offset !== bytes.length) throw invalidImage();
      return;
    }
    if (marker === 0xd8 || marker === 0 || marker === undefined) throw invalidImage();
    if (marker === 1) continue;
    if (offset + 2 > bytes.length) throw invalidImage();
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) throw invalidImage();
    // Multi-Picture Format is not a single still image, even when the decoder
    // exposes only its primary JPEG.
    if (marker === 0xe2 && bytes.toString('ascii', offset + 2, offset + 6) === 'MPF\0') throw invalidImage();
    offset += length;
    scan = marker === 0xda;
  }
  throw invalidImage();
}

function assertManagedImageBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0
    || bytes.length > MANAGED_IMAGE_LIMITS.bytes) throw new ManagedImageError('INVALID_IMAGE');
}

async function inspectManagedImageMetadata(bytes) {
  const webp = checkContainer(bytes);
  sharpRuntime.initialize();
  const animated = webp?.animated === true;
  const frameCount = animated ? webp.frameCount : 1;
  const options = { failOn: 'warning', limitInputPixels: animated
    ? MANAGED_IMAGE_LIMITS.cumulativePixels : MANAGED_IMAGE_LIMITS.pixels,
    ...(animated ? { animated: true, pages: -1 } : {}) };
  const metadata = await sharp(bytes, options).metadata();
  const { width, format } = metadata;
  const height = animated ? (metadata.pageHeight ?? metadata.height) : metadata.height;
  if (!Object.hasOwn(FORMATS, format) || (metadata.pages ?? 1) !== frameCount
    || (animated && format !== 'webp')
    || (animated && (width !== webp.canvasWidth || height !== webp.canvasHeight
      || metadata.height !== height * frameCount))) throw invalidImage();
  assertBoundedDimensions(width, height, frameCount);
  return { webp, options, metadata, width, height, format, animated, frameCount };
}

function imageResult(bytes, inspection, sha256 = crypto.createHash('sha256').update(bytes).digest('hex')) {
  const { webp, metadata, width, height, format, animated, frameCount } = inspection;
  return { width, height, extension: FORMATS[format][0], mimeType: FORMATS[format][1],
    sizeBytes: bytes.length, sha256,
    animated, frameCount, orientation: metadata.orientation,
    delay: animated ? webp.delay : undefined,
    loop: animated ? webp.loop : undefined };
}

/**
 * Strict container and decoder-metadata inspection without raw pixel decode.
 * Admission boundaries must continue to use validateManagedImageBuffer().
 */
export async function inspectManagedImageBufferLightweight(bytes) {
  try {
    assertManagedImageBytes(bytes);
    return imageResult(bytes, await inspectManagedImageMetadata(bytes));
  } catch (error) {
    if (error instanceof ManagedImageError) throw error;
    if (isRecognizedSharpInvalidImage(error)) throw invalidImage();
    throw error;
  }
}

/**
 * Revalidates bytes only after binding them to committed immutable DB authority.
 * This is not an admission API: new/untrusted bytes must use validateManagedImageBuffer().
 */
export async function revalidateCommittedManagedImageBuffer(bytes, authority) {
  try {
    assertManagedImageBytes(bytes);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (!authority || typeof authority !== 'object' || Array.isArray(authority)
      || authority.sizeBytes !== bytes.length
      || !/^[0-9a-f]{64}$/.test(authority.sha256)
      || sha256 !== authority.sha256) throw invalidImage();
    const inspection = await inspectManagedImageMetadata(bytes);
    const result = imageResult(bytes, inspection, sha256);
    if (result.mimeType !== authority.mimeType || result.width !== authority.width
      || result.height !== authority.height) throw invalidImage();
    return result;
  } catch (error) {
    if (error instanceof ManagedImageError) throw error;
    if (isRecognizedSharpInvalidImage(error)) throw invalidImage();
    throw error;
  }
}

export async function validateManagedImageBuffer(bytes) {
  try {
    assertManagedImageBytes(bytes);
    const inspection = await inspectManagedImageMetadata(bytes);
    const { webp, options, width, height, animated, frameCount } = inspection;
    if (webp?.losslessChunk) {
      // VP8L's alpha_is_used is only a hint. Decode its isolated bitstream with
      // that hint enabled, never letting a malformed VP8X suppress alpha.
      const isolated = Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBP'), webp.losslessChunk]);
      isolated.writeUInt32LE(isolated.length - 8, 4);
      isolated[24] |= 0x10;
      const { data, info } = await sharp(isolated, options).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      if (info.width !== width || info.height !== height || info.channels !== 4) throw invalidImage();
      let transparent = false;
      for (let offset = 3; offset < data.length; offset += 4) {
        if (data[offset] !== 255) { transparent = true; break; }
      }
      if (transparent !== webp.alpha) throw invalidImage();
    }
    if (animated) {
      let hasAlpha = webp.animationHasAlpha;
      for (const frame of webp.frames) {
        const frameMetadata = await sharp(frame.isolated, { failOn: 'warning',
          limitInputPixels: MANAGED_IMAGE_LIMITS.pixels }).metadata();
        if (frameMetadata.format !== 'webp' || frameMetadata.width !== frame.width
          || frameMetadata.height !== frame.height || (frameMetadata.pages ?? 1) !== 1) throw invalidImage();
        if (frame.losslessChunk) {
          const isolated = isolatedWebp([frame.losslessChunk]);
          isolated[24] |= 0x10;
          const { data, info } = await sharp(isolated, { failOn: 'warning',
            limitInputPixels: MANAGED_IMAGE_LIMITS.pixels }).ensureAlpha().raw()
            .toBuffer({ resolveWithObject: true });
          if (info.width !== frame.width || info.height !== frame.height || info.channels !== 4) throw invalidImage();
          for (let offset = 3; offset < data.length; offset += 4) {
            if (data[offset] !== 255) { hasAlpha = true; break; }
          }
        }
      }
      if (hasAlpha !== webp.alpha) throw invalidImage();
    }
    // Metadata alone does not detect truncated pixel data. Force full decode,
    // without resizing, then check the actual decoded dimensions as well.
    const { info } = await sharp(bytes, options).raw().toBuffer({ resolveWithObject: true });
    if (info.width !== width || info.height !== height * frameCount
      || (info.pages ?? 1) !== frameCount
      || (animated && info.pageHeight !== undefined && info.pageHeight !== height)) throw invalidImage();
    const result = imageResult(bytes, inspection);
    return { width: result.width, height: result.height, extension: result.extension,
      mimeType: result.mimeType, sizeBytes: result.sizeBytes, sha256: result.sha256,
      animated: result.animated, frameCount: result.frameCount };
  } catch (error) {
    if (error instanceof ManagedImageError) throw error;
    if (isRecognizedSharpInvalidImage(error)) throw invalidImage();
    throw error;
  }
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
        const metadata = await validateManagedImageBuffer(ownedBytes);
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
