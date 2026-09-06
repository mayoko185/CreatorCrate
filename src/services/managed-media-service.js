import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { sharpRuntime } from './sharp-runtime.js';
import { MANAGED_IMAGE_LIMITS } from './managed-image-service.js';
import { buildDerivativePipeline, IMAGE_DERIVATIVE_CONFIG } from './preview-service.js';
import { DERIVATIVE_CONFIG_VERSION, ensureCacheDirectory, inspectCachePath,
  atomicWriteBuffer, PreviewCacheError } from '../storage/preview-cache.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FORMATS = { 'image/png': ['png', 'png'], 'image/jpeg': ['jpg', 'jpeg'], 'image/webp': ['webp', 'webp'] };
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => a.dev >= 0n && a.ino > 0n && a.dev === b.dev && a.ino === b.ino;

export class ManagedMediaError extends Error {
  constructor(code = 'MEDIA_UNAVAILABLE') {
    super(code === 'CACHE_UNAVAILABLE' ? 'Managed media cache is unavailable.' : 'Managed media is unavailable.');
    this.name = 'ManagedMediaError';
    this.code = code;
  }
}

// Configuration owns the root's ancestors, as in managed-asset-storage.
// Check component identities around open/read; downstream decoders receive only
// owned bytes, never a path. Node has no portable openat walk: this shares the
// documented local-filesystem TOCTOU limitation, not an arbitrary-writer sandbox.
function readSource(root, record) {
  const file = path.resolve(root, record.storage_key);
  if (!inspectCachePath(root, file, 'file').ok) throw new Error();
  const paths = [root];
  for (const segment of record.storage_key.split('/')) paths.push(path.join(paths.at(-1), segment));
  const snapshot = () => paths.map((p, i) => {
    const stat = fs.lstatSync(p, { bigint: true });
    if (stat.isSymbolicLink() || !(i === paths.length - 1 ? stat.isFile() : stat.isDirectory())) throw new Error();
    return stat;
  });
  const before = snapshot();
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(fd, { bigint: true });
    const verify = () => {
      const current = snapshot();
      if (!current.every((s, i) => same(s, before[i])) || !same(opened, current.at(-1))) throw new Error();
    };
    if (!opened.isFile() || opened.size !== BigInt(record.size_bytes)) throw new Error();
    verify();
    // Bounded descriptor read; a growing file cannot cause an unbounded allocation.
    const bytes = Buffer.alloc(record.size_bytes);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error();
      offset += count;
    }
    verify();
    const after = fs.fstatSync(fd, { bigint: true });
    if (!same(opened, after) || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs
      || after.ctimeNs !== opened.ctimeNs || hash(bytes) !== record.sha256) throw new Error();
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
      if (typeof id !== 'string' || !UUID.test(id)) throw new Error();
      const record = managedAssetRepository.findById(id);
      const format = record && Object.hasOwn(FORMATS, record.mime_type) && FORMATS[record.mime_type];
      if (!record || record.id !== id || record.namespace !== 'book-covers' || !format
        || record.storage_key !== `book-covers/${id}/source.${format[0]}`
        || !Number.isSafeInteger(record.size_bytes) || record.size_bytes < 1 || record.size_bytes > MANAGED_IMAGE_LIMITS.bytes
        || !/^[0-9a-f]{64}$/.test(record.sha256)
        || ![record.width, record.height].every((n) => Number.isSafeInteger(n) && n > 0 && n <= MANAGED_IMAGE_LIMITS.dimension)
        || record.width * record.height > MANAGED_IMAGE_LIMITS.pixels) throw new Error();
      const bytes = readSource(root, record);
      sharpRuntime.initialize();
      const options = { failOn: 'warning', limitInputPixels: MANAGED_IMAGE_LIMITS.pixels };
      const metadata = await sharp(bytes, options).metadata();
      if (metadata.format !== format[1] || (metadata.pages ?? 1) !== 1
        || metadata.width !== record.width || metadata.height !== record.height) throw new Error();
      await sharp(bytes, options).raw().toBuffer();
      const revision = hash(JSON.stringify([id, record.storage_key, record.sha256, record.size_bytes,
        record.mime_type, record.width, record.height, DERIVATIVE_CONFIG_VERSION, IMAGE_DERIVATIVE_CONFIG])).slice(0, 16);
      return { record: { ...record }, bytes, revision };
    } catch { throw new ManagedMediaError(); }
  }

  async function derivative(id, kind) {
    if (!Object.hasOwn(IMAGE_DERIVATIVE_CONFIG, kind)) throw new ManagedMediaError();
    const source = await resolveSource(id); // Never serve cached output for an unavailable source.
    const dir = path.join(cacheRoot, 'managed-assets', source.record.id, source.revision);
    const filename = `${kind}.webp`;
    const file = path.join(dir, filename);
    try {
      if (inspectCachePath(cacheRoot, file, 'file').ok) {
        try {
          const bytes = fs.readFileSync(file);
          const decoder = sharp(bytes, { failOn: 'warning' });
          const meta = await decoder.metadata();
          if (meta.format !== 'webp' || (meta.pages ?? 1) !== 1 || meta.exif || meta.icc || meta.xmp) throw new Error();
          const size = IMAGE_DERIVATIVE_CONFIG[kind];
          const oriented = await sharp(source.bytes).metadata();
          const swap = oriented.orientation >= 5;
          const width = swap ? source.record.height : source.record.width;
          const height = swap ? source.record.width : source.record.height;
          const ratio = Math.min(1, size.width / width, size.height / height);
          if (meta.width !== Math.max(1, Math.round(width * ratio)) || meta.height !== Math.max(1, Math.round(height * ratio))) throw new Error();
          await decoder.raw().toBuffer();
          return { bytes, mimeType: 'image/webp', revision: source.revision, width: meta.width, height: meta.height, cacheHit: true };
        } catch { /* Missing/corrupt derived data is rebuildable. */ }
      }
      const pipeline = await buildDerivativePipeline(source.bytes, { ...IMAGE_DERIVATIVE_CONFIG[kind], animated: false });
      const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
      ensureCacheDirectory(cacheRoot, dir);
      atomicWriteBuffer(dir, filename, data);
      return { bytes: data, mimeType: 'image/webp', revision: source.revision, width: info.width, height: info.height, cacheHit: false };
    } catch (error) {
      if (error instanceof PreviewCacheError) throw new ManagedMediaError('CACHE_UNAVAILABLE');
      throw new ManagedMediaError();
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
