import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { openDatabase, closeDatabase, runMigrations } from '../src/db.js';
import { createManagedAssetRepository } from '../src/data/managed-asset-repository.js';
import { createManagedImageService } from '../src/services/managed-image-service.js';
import { createManagedMediaService } from '../src/services/managed-media-service.js';
import { buildDerivativePipeline, IMAGE_DERIVATIVE_CONFIG } from '../src/services/preview-service.js';
import { createApp } from '../src/app.js';

describe('managed media foundation', () => {
  let tmp, root, previewRoot, db, repository, ingest, media;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-managed-media-'));
    root = path.join(tmp, 'assets');
    previewRoot = path.join(tmp, 'previews');
    db = openDatabase(':memory:');
    runMigrations(db, fileURLToPath(new URL('../migrations', import.meta.url)));
    repository = createManagedAssetRepository(db);
    ingest = createManagedImageService({ managedAssetRoot: root, managedAssetRepository: repository });
    media = createManagedMediaService({ managedAssetRoot: root, previewRoot, managedAssetRepository: repository });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    closeDatabase(db);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  async function fixture(format = 'png', width = 2000, height = 1000, orientation) {
    let pipeline = sharp({ create: { width, height, channels: 3, background: '#123456' } });
    if (orientation) pipeline = pipeline.withMetadata({ orientation });
    const bytes = await pipeline.toFormat(format).toBuffer();
    const { record } = await ingest.createCommittedImage({ bytes });
    return { bytes, record, file: path.join(root, record.storage_key) };
  }
  const cached = (record, result, kind = 'thumbnail') => path.join(previewRoot, 'managed-assets', record.id, result.revision, `${kind}.webp`);
  const unavailable = (id) => expect(media.getDerivative(id, 'thumbnail')).rejects.toMatchObject({ name: 'ManagedMediaError', code: 'MEDIA_UNAVAILABLE' });

  it.each(['png', 'jpeg', 'webp'])('resolves %s and reuses exact thumbnail/preview output without changing originals or records', async (format) => {
    const { bytes, record, file } = await fixture(format);
    const originalStat = fs.statSync(file);
    const resolved = await media.resolveSource(record.id);
    expect(resolved.bytes).toEqual(bytes);
    expect(resolved.record).toEqual(record);
    for (const [kind, width, height] of [['thumbnail', 256, 128], ['preview', 1600, 800]]) {
      const result = await media.getDerivative(record.id, kind);
      expect(result).toMatchObject({ width, height, mimeType: 'image/webp', cacheHit: false });
      const expected = await (await buildDerivativePipeline(bytes, { ...IMAGE_DERIVATIVE_CONFIG[kind], animated: false })).toBuffer();
      expect(result.bytes).toEqual(expected);
      expect(fs.readFileSync(cached(record, result, kind))).toEqual(expected);
      expect(await media.getDerivative(record.id, kind)).toMatchObject({ bytes: expected, revision: result.revision, cacheHit: true });
    }
    expect(fs.readFileSync(file)).toEqual(bytes);
    expect(fs.statSync(file).mtimeMs).toBe(originalStat.mtimeMs);
    expect(repository.findById(record.id)).toEqual(record);
  });

  it.each([
    ['horizontal', 16384, 1, 'thumbnail', 256, 1],
    ['horizontal', 16384, 1, 'preview', 1600, 1],
    ['vertical', 1, 16384, 'thumbnail', 1, 256],
    ['vertical', 1, 16384, 'preview', 1, 1600],
  ])('reuses %s extreme %ix%i %s without rewriting', async (_orientation, sourceWidth, sourceHeight, kind, width, height) => {
    const { record, bytes } = await fixture('png', sourceWidth, sourceHeight);
    const first = await media.getDerivative(record.id, kind);
    expect(first).toMatchObject({ width, height, cacheHit: false });
    expect(await sharp(first.bytes).metadata()).toMatchObject({ width, height, format: 'webp' });
    const expected = await (await buildDerivativePipeline(bytes, { ...IMAGE_DERIVATIVE_CONFIG[kind], animated: false })).toBuffer();
    expect(first.bytes).toEqual(expected);
    const file = cached(record, first, kind);
    const oldTime = new Date('2000-01-01T00:00:00Z');
    fs.utimesSync(file, oldTime, oldTime);
    const before = fs.statSync(file, { bigint: true });
    const write = vi.spyOn(fs, 'writeFileSync');
    const second = await media.getDerivative(record.id, kind);
    expect(second).toMatchObject({ width, height, bytes: expected, revision: first.revision, cacheHit: true });
    expect(write).not.toHaveBeenCalled();
    const after = fs.statSync(file, { bigint: true });
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(after.ino).toBe(before.ino);
    expect(fs.readFileSync(file)).toEqual(expected);
  });

  it.each(['thumbnail', 'preview'])('rebuilds genuinely incorrect cached %s dimensions', async (kind) => {
    const { record } = await fixture();
    const first = await media.getDerivative(record.id, kind);
    const file = cached(record, first, kind);
    const wrong = await sharp({ create: { width: first.width, height: first.height + 1, channels: 3, background: '#123456' } }).webp().toBuffer();
    fs.writeFileSync(file, wrong);
    const second = await media.getDerivative(record.id, kind);
    expect(second).toMatchObject({ width: first.width, height: first.height, bytes: first.bytes, revision: first.revision, cacheHit: false });
    expect(fs.readFileSync(file)).toEqual(first.bytes);
    expect((await media.getDerivative(record.id, kind)).cacheHit).toBe(true);
  });

  it('auto-orients and strips EXIF/ICC metadata for both derivatives', async () => {
    const { record, bytes } = await fixture('jpeg', 2000, 1000, 6);
    expect((await sharp(bytes).metadata()).exif).toBeDefined();
    for (const [kind, width, height] of [['thumbnail', 128, 256], ['preview', 800, 1600]]) {
      const result = await media.getDerivative(record.id, kind);
      expect(result).toMatchObject({ width, height });
      const metadata = await sharp(result.bytes).metadata();
      for (const key of ['exif', 'icc', 'xmp', 'orientation']) expect(metadata[key]).toBeUndefined();
      expect((await media.getDerivative(record.id, kind)).cacheHit).toBe(true);
    }
  });

  it('does not enlarge small images', async () => {
    const { record } = await fixture('png', 9, 7);
    for (const kind of ['thumbnail', 'preview']) expect(await media.getDerivative(record.id, kind)).toMatchObject({ width: 9, height: 7 });
  });

  it.each(['missing', 'corrupt', 'truncated pixels'])('rebuilds %s cached derivatives', async (damage) => {
    const { record } = await fixture();
    const first = await media.getDerivative(record.id, 'thumbnail');
    const file = cached(record, first);
    if (damage === 'missing') fs.unlinkSync(file);
    else fs.writeFileSync(file, damage === 'corrupt' ? Buffer.from('bad') : first.bytes.subarray(0, Math.floor(first.bytes.length / 2)));
    const second = await media.getDerivative(record.id, 'thumbnail');
    expect(second).toMatchObject({ revision: first.revision, bytes: first.bytes, cacheHit: false });
  });

  it('serializes concurrent generation without duplicate writes', async () => {
    const { record } = await fixture();
    const results = await Promise.all([media.getDerivative(record.id, 'thumbnail'), media.getDerivative(record.id, 'thumbnail')]);
    expect(results.map((r) => r.cacheHit)).toEqual([false, true]);
  });

  it('invalidates derivatives when the shared pipeline configuration version changes', async () => {
    const { record } = await fixture();
    const first = await media.getDerivative(record.id, 'thumbnail');
    vi.resetModules();
    vi.doMock('../src/storage/preview-cache.js', async (importOriginal) => {
      const actual = await importOriginal();
      return { ...actual, DERIVATIVE_CONFIG_VERSION: actual.DERIVATIVE_CONFIG_VERSION + 1 };
    });
    try {
      const { createManagedMediaService: createUpdated } = await import('../src/services/managed-media-service.js');
      const updated = createUpdated({ managedAssetRoot: root, previewRoot, managedAssetRepository: repository });
      const second = await updated.getDerivative(record.id, 'thumbnail');
      expect(second.revision).not.toBe(first.revision);
      expect(second.cacheHit).toBe(false);
    } finally {
      vi.doUnmock('../src/storage/preview-cache.js');
      vi.resetModules();
    }
  });

  it.each(['missing', 'corrupt', 'replaced', 'unreadable'])('fails closed for %s source even with a cache hit available', async (damage) => {
    const { record, file, bytes } = await fixture();
    await media.getDerivative(record.id, 'thumbnail');
    if (damage === 'missing') fs.unlinkSync(file);
    if (damage === 'corrupt') fs.writeFileSync(file, 'broken');
    if (damage === 'replaced') {
      const replacement = Buffer.from(bytes);
      replacement[replacement.length - 1] ^= 1;
      fs.writeFileSync(file, replacement);
    }
    if (damage === 'unreadable') {
      const open = fs.openSync;
      vi.spyOn(fs, 'openSync').mockImplementation((p, ...args) => {
        if (p === file) throw Object.assign(new Error(), { code: 'EACCES' });
        return open(p, ...args);
      });
    }
    await unavailable(record.id);
    expect(repository.findById(record.id)).toEqual(record);
  });

  it('rejects corrupt decoded content even when committed hash and size match', async () => {
    const { record, file, bytes } = await fixture('jpeg');
    const truncated = bytes.subarray(0, Math.floor(bytes.length / 2));
    fs.writeFileSync(file, truncated);
    db.prepare('UPDATE managed_assets SET size_bytes = ?, sha256 = ? WHERE id = ?').run(truncated.length, crypto.createHash('sha256').update(truncated).digest('hex'), record.id);
    await unavailable(record.id);
  });

  it('rejects missing records, non-ID input and unsupported derivative kinds', async () => {
    await unavailable(crypto.randomUUID());
    await unavailable({ path: tmp });
    await unavailable('../source.png');
    const { record } = await fixture();
    await expect(media.getDerivative(record.id, '../../escape')).rejects.toMatchObject({ code: 'MEDIA_UNAVAILABLE' });
  });

  it.each(['../escape.png', '/absolute.png', 'C:/outside.png', 'book-covers/../source.png', 'book-covers\\source.png'])('rejects unsafe stored key %s', async (storage_key) => {
    const { record } = await fixture();
    const findById = vi.fn(() => ({ ...record, storage_key }));
    media = createManagedMediaService({ managedAssetRoot: root, previewRoot, managedAssetRepository: { findById } });
    const open = vi.spyOn(fs, 'openSync');
    await unavailable(record.id);
    expect(open).not.toHaveBeenCalled();
  });

  it('rejects metadata mismatch and unsupported records', async () => {
    const { record } = await fixture();
    for (const patch of [{ width: 1 }, { mime_type: 'image/gif' }, { namespace: 'other' }]) {
      media = createManagedMediaService({ managedAssetRoot: root, previewRoot, managedAssetRepository: { findById: () => ({ ...record, ...patch }) } });
      await unavailable(record.id);
    }
  });

  it('rejects a substituted opened descriptor before reading its bytes', async () => {
    const first = await fixture();
    const other = await fixture('jpeg');
    const open = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation((p, ...args) => open(p === first.file ? other.file : p, ...args));
    const read = vi.spyOn(fs, 'readSync');
    await unavailable(first.record.id);
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects source directory junction substitution', async () => {
    const { record, file } = await fixture();
    const dir = path.dirname(file);
    const moved = `${dir}-moved`;
    fs.renameSync(dir, moved);
    fs.symlinkSync(moved, dir, process.platform === 'win32' ? 'junction' : 'dir');
    await unavailable(record.id);
  });

  it('rejects cache directory junctions without writing outside the cache', async () => {
    const { record } = await fixture();
    fs.mkdirSync(previewRoot);
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(previewRoot, 'managed-assets'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(media.getDerivative(record.id, 'thumbnail')).rejects.toMatchObject({ code: 'CACHE_UNAVAILABLE' });
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('keeps Book and managed records and original untouched on cache failure; never invokes Project media', async () => {
    const { record, bytes, file } = await fixture();
    const book = db.prepare("INSERT INTO books (title, sort_order) VALUES ('Cover', 0) RETURNING *").get();
    db.prepare('INSERT INTO book_primary_images (book_id, managed_asset_id) VALUES (?, ?)').run(book.id, record.id);
    const projectMedia = { inspectKritaPreviewSource: vi.fn(() => { throw new Error('Project media must not be used'); }),
      getDerivative: vi.fn(() => { throw new Error('Project media must not be used'); }) };
    const app = createApp({ appName: 'test', db }, { appDataRoot: tmp, mediaService: projectMedia, previewService: projectMedia });
    fs.writeFileSync(previewRoot, 'not a directory');
    await expect(app.locals.managedMediaService.getDerivative(record.id, 'preview')).rejects.toMatchObject({ code: 'CACHE_UNAVAILABLE' });
    expect(repository.findById(record.id)).toEqual(record);
    expect(db.prepare('SELECT * FROM books WHERE id = ?').get(book.id)).toEqual(book);
    expect(db.prepare('SELECT managed_asset_id FROM book_primary_images WHERE book_id = ?').get(book.id).managed_asset_id).toBe(record.id);
    expect(fs.readFileSync(file)).toEqual(bytes);
    expect(projectMedia.inspectKritaPreviewSource).not.toHaveBeenCalled();
    expect(projectMedia.getDerivative).not.toHaveBeenCalled();
  });
});
