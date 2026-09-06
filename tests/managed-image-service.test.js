import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { crc32 } from 'node:zlib';
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { openDatabase, closeDatabase, runMigrations } from '../src/db.js';
import { createManagedAssetRepository } from '../src/data/managed-asset-repository.js';
import { createManagedImageService, MANAGED_IMAGE_LIMITS } from '../src/services/managed-image-service.js';
import { createManagedAssetStorage } from '../src/storage/managed-asset-storage.js';
import { createApp } from '../src/app.js';

const id = '01234567-0123-4123-8123-0123456789ab';
const image = (format = 'png', width = 8, height = 6) => sharp({ create: {
  width, height, channels: 3, background: '#123456',
} }).toFormat(format).toBuffer();

describe.each(['native', 'mutable fallback', 'unavailable'])('managed image ingestion (%s birth time)', (birthTime) => {
  let tmp, root, db, repository, service;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-managed-ingest-'));
    root = path.join(tmp, 'assets');
    db = openDatabase(':memory:');
    runMigrations(db, fileURLToPath(new URL('../migrations', import.meta.url)));
    repository = createManagedAssetRepository(db);
    service = createManagedImageService({ managedAssetRoot: root, managedAssetRepository: repository });
    if (birthTime !== 'native') {
      let tick = 0n;
      for (const name of ['lstatSync', 'fstatSync']) {
        const original = fs[name];
        vi.spyOn(fs, name).mockImplementation((...args) => {
          const result = original(...args);
          // Model an unreliable ctime-derived birth time deterministically,
          // without depending on filesystem timestamp granularity.
          result.ctimeNs = ++tick;
          result.birthtimeNs = birthTime === 'unavailable' ? undefined : result.ctimeNs;
          return result;
        });
      }
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
    closeDatabase(db);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const staging = (root) => fs.existsSync(path.join(root, '.staging')) ? fs.readdirSync(path.join(root, '.staging')) : [];
  function configured(overrides = {}) {
    return createManagedImageService({ managedAssetRoot: root, managedAssetRepository: repository, ...overrides });
  }
  async function invalid(bytes) {
    await expect(service.createCommittedImage({ bytes })).rejects.toMatchObject({
      name: 'ManagedImageError', code: 'INVALID_IMAGE',
      message: 'A valid, single still PNG, JPEG or WebP image within the managed image limits is required.',
    });
    expect(staging(root)).toEqual([]);
    expect(db.prepare('SELECT count(*) n FROM managed_assets').get().n).toBe(0);
    if (fs.existsSync(path.join(root, 'book-covers'))) expect(fs.readdirSync(path.join(root, 'book-covers'))).toEqual([]);
  }

  function chunk(type, payload) {
    const result = Buffer.alloc(8 + payload.length + payload.length % 2);
    result.write(type); result.writeUInt32LE(payload.length, 4); payload.copy(result, 8);
    return result;
  }
  function appendWebp(bytes, tail) {
    const result = Buffer.concat([bytes, tail]);
    result.writeUInt32LE(result.length - 8, 4);
    return result;
  }
  function webpChunkTypes(bytes) {
    const types = [];
    for (let offset = 12; offset < bytes.length;) {
      types.push(bytes.toString('latin1', offset, offset + 4));
      const length = bytes.readUInt32LE(offset + 4);
      offset += 8 + length + length % 2;
    }
    return types;
  }
  function webpChunks(bytes) {
    const chunks = [];
    for (let offset = 12; offset < bytes.length;) {
      const length = bytes.readUInt32LE(offset + 4);
      const next = offset + 8 + length + length % 2;
      chunks.push(bytes.subarray(offset, next));
      offset = next;
    }
    return chunks;
  }
  function extendedWebp(bytes, flags, before = [], after = []) {
    const header = Buffer.alloc(10);
    header[0] = flags;
    header.writeUIntLE(7, 4, 3);
    header.writeUIntLE(5, 7, 3);
    return appendWebp(bytes.subarray(0, 12), Buffer.concat([
      chunk('VP8X', header), ...before, bytes.subarray(12), ...after,
    ]));
  }
  it.each([false, true])('checks extended VP8L actual transparency independently of both alpha hints (%s)', async (alpha) => {
    const bytes = await sharp({ create: { width: 8, height: 6, channels: 4,
      background: { r: 10, g: 20, b: 30, alpha: alpha ? 0.5 : 1 } } })
      .webp({ lossless: true }).toBuffer();
    expect(webpChunkTypes(bytes)).toEqual(['VP8L']);
    for (const hint of [false, true]) {
      const payload = Buffer.from(bytes);
      payload[24] = (payload[24] & ~0x10) | (hint ? 0x10 : 0);
      await invalid(extendedWebp(payload, alpha ? 0 : 0x10));
      const valid = extendedWebp(payload, alpha ? 0x10 : 0);
      const { record, ownershipToken } = await service.createCommittedImage({ bytes: valid });
      expect(webpChunkTypes(valid)).toEqual(['VP8X', 'VP8L']);
      expect(fs.readFileSync(path.join(root, record.storage_key))).toEqual(valid);
      expect(repository.findById(record.id)).toEqual(record);
      expect(staging(root)).toEqual([]);
      service.rollbackCommitted(ownershipToken);
      service.compensate(ownershipToken);
    }
  });
  it.each([['ICCP', 0x20], ['EXIF', 0x08], ['XMP ', 0x04]])(
    'checks %s feature presence in both directions and preserves valid metadata', async (type, flag) => {
      const bytes = await image('webp');
      const metadata = await sharp(await image()).withMetadata().webp().toBuffer();
      const ancillary = type === 'XMP ' ? chunk(type, Buffer.from('<x:xmpmeta/>'))
        : webpChunks(metadata).find((part) => part.toString('latin1', 0, 4) === type);
      expect(ancillary).toBeInstanceOf(Buffer);
      const withChunk = (flags) => extendedWebp(bytes, flags,
        type === 'ICCP' ? [ancillary] : [], type === 'ICCP' ? [] : [ancillary]);
      await invalid(withChunk(0));
      await invalid(extendedWebp(bytes, flag));
      const valid = withChunk(flag);
      const { record } = await service.createCommittedImage({ bytes: valid });
      expect(fs.readFileSync(path.join(root, record.storage_key))).toEqual(valid);
      expect(repository.findById(record.id)).toEqual(record);
      expect(staging(root)).toEqual([]);
    },
  );
  it('preserves valid unknown ancillary chunks', async () => {
    const bytes = extendedWebp(await image('webp'), 0, [], [chunk('test', Buffer.from('unknown'))]);
    const { record } = await service.createCommittedImage({ bytes });
    expect(fs.readFileSync(path.join(root, record.storage_key))).toEqual(bytes);
    expect(staging(root)).toEqual([]);
  });
  it('rejects lossy WebP declaring alpha without ALPH even when Sharp decodes it', async () => {
    const bytes = await image('webp');
    expect(webpChunkTypes(bytes)).toEqual(['VP8 ']);
    const header = Buffer.alloc(10);
    header[0] = 0x10;
    header.writeUIntLE(7, 4, 3);
    header.writeUIntLE(5, 7, 3);
    const malformed = appendWebp(bytes.subarray(0, 12), Buffer.concat([
      chunk('VP8X', header), bytes.subarray(12),
    ]));
    expect(webpChunkTypes(malformed)).toEqual(['VP8X', 'VP8 ']);
    await expect(sharp(malformed).raw().toBuffer()).resolves.toBeInstanceOf(Buffer);
    await expect(service.createCommittedImage({ bytes: malformed })).rejects.toMatchObject({
      name: 'ManagedImageError', code: 'INVALID_IMAGE',
      message: 'A valid, single still PNG, JPEG or WebP image within the managed image limits is required.',
    });
    expect(db.prepare('SELECT count(*) n FROM managed_assets').get().n).toBe(0);
    expect(staging(root)).toEqual([]);
    expect(fs.readdirSync(path.join(root, 'book-covers'))).toEqual([]);
  });
  it.each([false, true])('accepts ordinary lossless VP8L without ALPH (alpha=%s)', async (alpha) => {
    const bytes = await sharp({ create: { width: 8, height: 6, channels: alpha ? 4 : 3,
      background: { r: 10, g: 20, b: 30, alpha: alpha ? 0.5 : 1 } } })
      .webp({ lossless: true }).toBuffer();
    expect(webpChunkTypes(bytes)).toEqual(['VP8L']);
    expect((await sharp(bytes).metadata()).hasAlpha).toBe(alpha);
    const { record } = await service.createCommittedImage({ bytes });
    expect(fs.readFileSync(path.join(root, record.storage_key))).toEqual(bytes);
    expect(repository.findById(record.id)).toEqual(record);
    expect(staging(root)).toEqual([]);
  });
  it('rejects appended image chunks and nested complete WebP despite adjusted RIFF size', async () => {
    const bytes = await image('webp');
    await invalid(appendWebp(bytes, bytes.subarray(12)));
    await invalid(appendWebp(bytes, bytes));
    const lossless = await sharp(await image()).webp({ lossless: true }).toBuffer();
    await invalid(appendWebp(bytes, lossless.subarray(12)));
    await invalid(appendWebp(bytes, chunk('ALPH', Buffer.from([0]))));
    await invalid(appendWebp(bytes, chunk('ANMF', Buffer.alloc(16))));
  });
  it('rejects malformed WebP lengths, incomplete headers and missing/nonzero padding', async () => {
    const bytes = await image('webp');
    const oversized = chunk('XMP ', Buffer.from('x'));
    oversized.writeUInt32LE(0xffffffff, 4);
    await invalid(appendWebp(bytes, oversized));
    await invalid(appendWebp(bytes, Buffer.alloc(4)));
    const odd = chunk('XMP ', Buffer.from('x'));
    await invalid(appendWebp(bytes, odd.subarray(0, -1)));
    odd[odd.length - 1] = 1;
    await invalid(appendWebp(bytes, odd));
  });
  it.each([false, true])('preserves still WebP transparency and metadata (lossless=%s)', async (lossless) => {
    const bytes = await sharp({ create: { width: 8, height: 6, channels: 4,
      background: { r: 10, g: 20, b: 30, alpha: 0.5 } } })
      .withMetadata().webp({ lossless }).toBuffer();
    const extended = appendWebp(bytes, chunk('XMP ', Buffer.from('<x:xmpmeta/>')));
    extended[20] |= 0x04;
    const types = webpChunkTypes(extended);
    expect(types).toEqual(expect.arrayContaining(['VP8X', 'ICCP', 'EXIF', 'XMP ', lossless ? 'VP8L' : 'VP8 ']));
    expect(types.includes('ALPH')).toBe(!lossless);
    expect(extended[20] & 0x10).toBe(0x10);
    const { record } = await service.createCommittedImage({ bytes: extended });
    expect(fs.readFileSync(path.join(root, record.storage_key))).toEqual(extended);
    expect(staging(root)).toEqual([]);
  });

  it.each(['staging', 'final'])('retains a substituted %s directory', async (location) => {
    const storage = createManagedAssetStorage({ managedAssetRoot: root });
    let replaced;
    if (location === 'staging') {
      service = configured({ storage: { ...storage, publish(op, ...args) {
        replaced = op.stageDir;
        fs.renameSync(replaced, path.join(tmp, 'original-directory'));
        fs.mkdirSync(replaced);
        fs.writeFileSync(path.join(replaced, 'foreign'), 'foreign');
        return storage.publish(op, ...args);
      } } });
      await expect(service.createCommittedImage({ bytes: await image() })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    } else {
      const { record, ownershipToken } = await service.createCommittedImage({ bytes: await image() });
      service.rollbackCommitted(ownershipToken);
      replaced = path.dirname(path.join(root, record.storage_key));
      fs.renameSync(replaced, path.join(tmp, 'original-directory'));
      fs.mkdirSync(replaced);
      fs.writeFileSync(path.join(replaced, 'foreign'), 'foreign');
      expect(() => service.compensate(ownershipToken)).toThrow(expect.objectContaining({ code: 'RECOVERY_REQUIRED' }));
    }
    expect(fs.readFileSync(path.join(replaced, 'foreign'), 'utf8')).toBe('foreign');
  });
  it.each([0n, undefined, 1])('fails safe when stable file identity is invalid (%s)', async (inode) => {
    const { record, ownershipToken } = await service.createCommittedImage({ bytes: await image() });
    service.rollbackCommitted(ownershipToken);
    const original = fs.lstatSync;
    vi.spyOn(fs, 'lstatSync').mockImplementation((...args) => {
      const result = original(...args); result.ino = inode; return result;
    });
    expect(() => service.compensate(ownershipToken)).toThrow(expect.objectContaining({ code: 'RECOVERY_REQUIRED' }));
    expect(fs.existsSync(path.join(root, record.storage_key))).toBe(true);
  });
  it('keeps storage ownership across writes, child creation and hard-link publication', async () => {
    const storage = createManagedAssetStorage({ managedAssetRoot: root });
    const bytes = await image('webp');
    const op = storage.stage(bytes, id);
    const child = path.join(op.stageDir, 'owned-child');
    fs.writeFileSync(child, 'child');
    fs.unlinkSync(child);
    expect(fs.readFileSync(op.stagePath)).toEqual(bytes);
    storage.publish(op, 'webp', crypto.createHash('sha256').update(bytes).digest('hex'));
    expect(storage.cleanStaging(op)).toBe(true);
    expect(storage.compensate(op)).toBe(true);
    expect(staging(root)).toEqual([]);
    expect(fs.readdirSync(path.join(root, 'book-covers'))).toEqual([]);
  });

  it.each([['png', 'png', 'image/png'], ['jpeg', 'jpg', 'image/jpeg'], ['webp', 'webp', 'image/webp']])(
    'commits verified %s bytes and correct metadata with generated contained paths', async (format, extension, mime) => {
      const bytes = await image(format);
      const { record, ownershipToken } = await service.createCommittedImage({ bytes,
        filename: '../../foreign.svg', mimeType: 'image/svg+xml' });
      expect(record).toMatchObject({ namespace: 'book-covers', mime_type: mime,
        size_bytes: bytes.length, width: 8, height: 6,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
      expect(record.created_at).toEqual(expect.any(String));
      expect(record.storage_key).toBe(`book-covers/${record.id}/source.${extension}`);
      expect(record.id).toMatch(/^[0-9a-f-]{36}$/);
      const final = path.resolve(root, record.storage_key);
      expect(path.relative(root, final).startsWith('..')).toBe(false);
      expect(fs.readFileSync(final)).toEqual(bytes);
      expect(repository.findById(record.id)).toEqual(record);
      expect(staging(root)).toEqual([]);
      expect(Object.keys(ownershipToken)).toEqual([]);
      expect(() => service.compensate(ownershipToken)).toThrow(expect.objectContaining({ code: 'COMMITTED_ASSET' }));
      expect(fs.readFileSync(final)).toEqual(bytes);
    });

  it.each(['png', 'jpeg', 'webp'])('rejects truncated %s pixel data', async (format) => {
    const bytes = await image(format, 100, 100);
    await invalid(bytes.subarray(0, Math.floor(bytes.length * 0.75)));
  });
  it('rejects garbage, SVG despite MIME spoofing, GIF and TIFF', async () => {
    await invalid(Buffer.from('not an image'));
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>');
    await expect(service.createCommittedImage({ bytes: svg, filename: 'image.png', mimeType: 'image/png' }))
      .rejects.toMatchObject({ code: 'INVALID_IMAGE' });
    await invalid(await image('gif'));
    await invalid(await image('tiff'));
  });
  it('rejects APNG animation control even if the decoder would show only its default frame', async () => {
    const bytes = await image();
    const chunk = Buffer.alloc(20);
    chunk.writeUInt32BE(8); chunk.write('acTL', 4); chunk.writeUInt32BE(2, 8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, 16)), 16);
    await invalid(Buffer.concat([bytes.subarray(0, 33), chunk, bytes.subarray(33)]));
  });
  it('rejects missing JPEG EOI, concatenated images and MPO metadata', async () => {
    for (const format of ['png', 'jpeg', 'webp']) {
      const bytes = await image(format);
      await invalid(Buffer.concat([bytes, bytes]));
      if (format === 'jpeg') {
        await invalid(bytes.subarray(0, bytes.length - 2));
        const mpf = Buffer.from([0xff, 0xe2, 0, 6, 77, 80, 70, 0]);
        await invalid(Buffer.concat([bytes.subarray(0, 2), mpf, bytes.subarray(2)]));
      }
    }
  });
  it('accepts progressive JPEG without mistaking scan data for metadata', async () => {
    const bytes = await sharp(await image()).jpeg({ progressive: true }).toBuffer();
    const { record } = await service.createCommittedImage({ bytes });
    expect(record.mime_type).toBe('image/jpeg');
  });
  it('rejects animated WebP and multi-page TIFF', async () => {
    const raw = Buffer.alloc(4 * 8 * 3, 100);
    raw.fill(200, 4 * 4 * 3);
    for (const format of ['webp', 'tiff']) {
      const bytes = await sharp(raw, { raw: { width: 4, height: 8, channels: 3, pageHeight: 4 } })
        .toFormat(format).toBuffer();
      expect((await sharp(bytes).metadata()).pages).toBe(2);
      await invalid(bytes);
    }
  });
  it('rejects encoded overflow, empty/multiple images and unsupported namespace', async () => {
    await expect(service.createCommittedImage(null)).rejects.toMatchObject({ code: 'INVALID_IMAGE' });
    await invalid(Buffer.alloc(MANAGED_IMAGE_LIMITS.bytes + 1));
    await invalid(Buffer.alloc(0));
    await invalid([await image(), await image()]);
    await expect(service.createCommittedImage({ bytes: await image(), namespace: '../projects' }))
      .rejects.toMatchObject({ code: 'INVALID_IMAGE' });
  });
  it('rejects excessive axes and pixels', async () => {
    await invalid(await image('png', 16_385, 1));
    await invalid(await image('png', 1, 16_385));
    await invalid(await image('png', 6400, 6400));
  });
  it('accepts the inclusive encoded-size and axis limits', async () => {
    const bytes = await image('png', 16_384, 1);
    const extra = Buffer.alloc(MANAGED_IMAGE_LIMITS.bytes - bytes.length);
    extra.writeUInt32BE(extra.length - 12);
    extra.write('raNd', 4); // Unknown ancillary chunk: valid PNG padding.
    extra.writeUInt32BE(crc32(extra.subarray(4, extra.length - 4)), extra.length - 4);
    const padded = Buffer.concat([bytes.subarray(0, -12), extra, bytes.subarray(-12)]);
    const { record } = await service.createCommittedImage({ bytes: padded });
    expect(record.size_bytes).toBe(MANAGED_IMAGE_LIMITS.bytes);
    expect(record.width).toBe(16_384);
  });
  it('rejects inconsistent PNG dimensions even with a valid header checksum', async () => {
    const bytes = await image();
    bytes.writeUInt32BE(100, 16);
    bytes.writeUInt32BE(crc32(bytes.subarray(12, 29)), 29);
    await invalid(bytes);
  });
  it('copies submitted bytes before asynchronous decoding', async () => {
    const bytes = await image();
    const original = Buffer.from(bytes);
    const pending = service.createCommittedImage({ bytes });
    bytes.fill(0);
    const { record } = await pending;
    expect(fs.readFileSync(path.join(root, record.storage_key))).toEqual(original);
  });
  it('never overwrites a previous committed asset on ID collision or ordinary validation failure', async () => {
    service = configured({ generateId: () => id });
    const { record } = await service.createCommittedImage({ bytes: await image() });
    const before = fs.readFileSync(path.join(root, record.storage_key));
    await expect(service.createCommittedImage({ bytes: await image('jpeg') })).rejects.toMatchObject({ code: 'COLLISION' });
    await expect(service.createCommittedImage({ bytes: Buffer.from('bad') })).rejects.toMatchObject({ code: 'INVALID_IMAGE' });
    expect(fs.readFileSync(path.join(root, record.storage_key))).toEqual(before);
    expect(repository.findById(id)).toEqual(record);
    expect(staging(root)).toEqual([]);
  });
  it('exclusive link collision retains the foreign file and reports recovery', async () => {
    const link = fs.linkSync;
    vi.spyOn(fs, 'linkSync').mockImplementation((source, target) => {
      fs.writeFileSync(target, 'foreign', { flag: 'wx' });
      return link(source, target);
    });
    service = configured({ generateId: () => id });
    await expect(service.createCommittedImage({ bytes: await image() })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(fs.readFileSync(path.join(root, 'book-covers', id, 'source.png'), 'utf8')).toBe('foreign');
    expect(repository.findById(id)).toBeUndefined();
    expect(staging(root)).toEqual([]);
  });
  it('cleans publication and staging after failed persistence', async () => {
    vi.spyOn(repository, 'insertCommitted').mockImplementation(() => { throw new Error('unsafe private path'); });
    await expect(service.createCommittedImage({ bytes: await image() })).rejects.toMatchObject({
      code: 'DATABASE_ERROR', message: 'Managed image persistence failed.',
    });
    expect(fs.readdirSync(path.join(root, 'book-covers'))).toEqual([]);
    expect(staging(root)).toEqual([]);
  });
  it('retains a substituted published file when failed persistence needs cleanup', async () => {
    vi.spyOn(repository, 'insertCommitted').mockImplementation((record) => {
      const final = path.join(root, record.storageKey);
      fs.renameSync(final, path.join(tmp, 'original'));
      fs.writeFileSync(final, 'foreign');
      throw new Error('failed');
    });
    service = configured({ generateId: () => id });
    await expect(service.createCommittedImage({ bytes: await image() })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(fs.readFileSync(path.join(root, 'book-covers', id, 'source.png'), 'utf8')).toBe('foreign');
    expect(staging(root)).toEqual([]);
  });
  it('retains a record/source after an uncertain insert result', async () => {
    const insert = repository.insertCommitted;
    vi.spyOn(repository, 'insertCommitted').mockImplementation((record) => { insert(record); throw new Error(); });
    service = configured({ generateId: () => id });
    await expect(service.createCommittedImage({ bytes: await image() })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(fs.existsSync(path.join(root, repository.findById(id).storage_key))).toBe(true);
    expect(staging(root)).toEqual([]);
  });
  it('cleans staging and the empty owned final directory on publication failure', async () => {
    vi.spyOn(fs, 'linkSync').mockImplementation(() => { throw new Error('unavailable'); });
    await expect(service.createCommittedImage({ bytes: await image() })).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    expect(staging(root)).toEqual([]);
    expect(fs.readdirSync(path.join(root, 'book-covers'))).toEqual([]);
  });
  it('cleans partial staged writes on flush failure', async () => {
    vi.spyOn(fs, 'fsyncSync').mockImplementation(() => { throw new Error(); });
    await expect(service.createCommittedImage({ bytes: await image() })).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    expect(staging(root)).toEqual([]);
  });
  it('publishes identical submissions as distinct immutable assets', async () => {
    const bytes = await image();
    const first = await service.createCommittedImage({ bytes });
    const second = await service.createCommittedImage({ bytes });
    expect(first.record.id).not.toBe(second.record.id);
    for (const { record } of [first, second]) expect(fs.readFileSync(path.join(root, record.storage_key))).toEqual(bytes);
  });
  it('retains foreign staging and reports recovery rather than recursively removing it', async () => {
    const storage = createManagedAssetStorage({ managedAssetRoot: root });
    const publish = storage.publish;
    let stagePath;
    service = configured({ storage: { ...storage, publish(op, ...args) {
      stagePath = op.stagePath;
      fs.renameSync(op.stagePath, path.join(tmp, 'original'));
      fs.writeFileSync(op.stagePath, 'foreign');
      return publish(op, ...args);
    } } });
    await expect(service.createCommittedImage({ bytes: await image() })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(fs.readFileSync(stagePath, 'utf8')).toBe('foreign');
  });
  it('does not delete a committed source when staging cleanup fails', async () => {
    const storage = createManagedAssetStorage({ managedAssetRoot: root });
    service = configured({ generateId: () => id, storage: { ...storage, cleanStaging: () => false } });
    await expect(service.createCommittedImage({ bytes: await image() })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(repository.findById(id)).toBeDefined();
    expect(fs.existsSync(path.join(root, repository.findById(id).storage_key))).toBe(true);
  });
  it('guards compensation after a caller rollback and rejects forged tokens', async () => {
    const bytes = await image();
    const unrelated = await service.createCommittedImage({ bytes });
    const { record, ownershipToken } = await service.createCommittedImage({ bytes: await image() });
    expect(() => service.compensate({})).toThrow(expect.objectContaining({ code: 'INVALID_TOKEN' }));
    for (const wrong of [{}, { ...ownershipToken }, record, unrelated.record]) {
      expect(() => service.rollbackCommitted(wrong)).toThrow(expect.objectContaining({ code: 'INVALID_TOKEN' }));
    }
    expect(() => configured().rollbackCommitted(ownershipToken)).toThrow(expect.objectContaining({ code: 'INVALID_TOKEN' }));
    // The later synchronous Book operation fails, after async ingestion finishes.
    expect(() => db.transaction(() => {
      db.exec("INSERT INTO books (id, title, sort_order) VALUES (1, 'Failed Book', 0)");
      db.prepare('INSERT INTO book_primary_images (book_id, managed_asset_id) VALUES (1, ?)').run(record.id);
      throw new Error('later Book operation failed');
    })()).toThrow('later Book operation failed');
    expect(() => service.compensate(ownershipToken)).toThrow(expect.objectContaining({ code: 'COMMITTED_ASSET' }));
    service.rollbackCommitted(ownershipToken);
    expect(repository.findById(record.id)).toBeUndefined();
    expect(fs.existsSync(path.join(root, record.storage_key))).toBe(true);
    service.compensate(ownershipToken);
    expect(fs.existsSync(path.join(root, record.storage_key))).toBe(false);
    expect(repository.findById(unrelated.record.id)).toEqual(unrelated.record);
    expect(fs.readFileSync(path.join(root, unrelated.record.storage_key))).toEqual(bytes);
    expect(() => service.compensate(unrelated.ownershipToken)).toThrow(expect.objectContaining({ code: 'COMMITTED_ASSET' }));
    expect(() => service.rollbackCommitted(ownershipToken)).toThrow(expect.objectContaining({ code: 'INVALID_TOKEN' }));
  });
  it('preserves a Book-referenced managed record and file during rollback refusal', async () => {
    const bytes = await image();
    const { record, ownershipToken } = await service.createCommittedImage({ bytes });
    db.exec("INSERT INTO books (id, title, sort_order) VALUES (1, 'Book', 0)");
    db.prepare('INSERT INTO book_primary_images (book_id, managed_asset_id) VALUES (1, ?)').run(record.id);
    expect(() => service.rollbackCommitted(ownershipToken)).toThrow(expect.objectContaining({ code: 'ROLLBACK_REFUSED' }));
    expect(() => service.compensate(ownershipToken)).toThrow(expect.objectContaining({ code: 'COMMITTED_ASSET' }));
    expect(repository.findById(record.id)).toEqual(record);
    expect(repository.isReferenced(record.id)).toBe(true);
    expect(fs.readFileSync(path.join(root, record.storage_key))).toEqual(bytes);
  });
  it('preserves mutated records and files during rollback refusal', async () => {
    const { record, ownershipToken } = await service.createCommittedImage({ bytes: await image() });
    db.prepare('UPDATE managed_assets SET width = width + 1 WHERE id = ?').run(record.id);
    expect(() => service.rollbackCommitted(ownershipToken)).toThrow(expect.objectContaining({ code: 'ROLLBACK_REFUSED' }));
    expect(repository.findById(record.id).width).toBe(record.width + 1);
    expect(fs.existsSync(path.join(root, record.storage_key))).toBe(true);
  });
  it('retains a replaced source during later compensation', async () => {
    const { record, ownershipToken } = await service.createCommittedImage({ bytes: await image() });
    service.rollbackCommitted(ownershipToken);
    const final = path.join(root, record.storage_key);
    fs.renameSync(final, path.join(tmp, 'original'));
    fs.writeFileSync(final, 'foreign');
    expect(() => service.compensate(ownershipToken)).toThrow(expect.objectContaining({ code: 'RECOVERY_REQUIRED' }));
    expect(fs.readFileSync(final, 'utf8')).toBe('foreign');
  });
  it('rejects unsafe generated IDs before touching storage', async () => {
    service = configured({ generateId: () => '../escape' });
    await expect(service.createCommittedImage({ bytes: await image() })).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    expect(fs.existsSync(root)).toBe(false);
  });
  it('rejects directory junctions instead of publishing outside the root', async () => {
    fs.mkdirSync(root);
    const foreign = path.join(tmp, 'foreign'); fs.mkdirSync(foreign);
    fs.symlinkSync(foreign, path.join(root, 'book-covers'), 'junction');
    await expect(service.createCommittedImage({ bytes: await image() })).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    expect(fs.readdirSync(foreign)).toEqual([]);
  });
  it('rejects changed staged bytes before publication', async () => {
    const storage = createManagedAssetStorage({ managedAssetRoot: root });
    const publish = storage.publish;
    service = configured({ storage: { ...storage, publish(op, ...args) {
      fs.writeFileSync(op.stagePath, 'tampered'); return publish(op, ...args);
    } } });
    await expect(service.createCommittedImage({ bytes: await image() })).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    expect(staging(root)).toEqual([]);
    expect(fs.readdirSync(path.join(root, 'book-covers'))).toEqual([]);
  });
  it('composes lazily beneath appDataRoot without routes or Project storage', async () => {
    const app = createApp({ appName: 'test', db }, { appDataRoot: tmp });
    expect(fs.existsSync(root)).toBe(false);
    const { record } = await app.locals.managedImageService.createCommittedImage({ bytes: await image() });
    expect(fs.existsSync(path.join(root, record.storage_key))).toBe(true);
    expect(app.locals.managedAssetRepository.findById(record.id)).toEqual(record);
  });
});
