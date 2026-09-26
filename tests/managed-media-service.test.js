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
import { createManagedMediaService, MANAGED_DERIVATIVE_CACHE_AUTHORITY_VERSION,
  MANAGED_DERIVATIVE_METADATA_MAX_BYTES } from '../src/services/managed-media-service.js';
import { DERIVATIVE_CONFIG_VERSION } from '../src/storage/preview-cache.js';
import { buildDerivativePipeline, IMAGE_DERIVATIVE_CONFIG } from '../src/services/preview-service.js';
import { createApp } from '../src/app.js';
import { createAppMetaRepository } from '../src/data/app-meta-repository.js';
import { makeAnimatedWebp, makeSolidAnimatedWebp, webpChunks } from './helpers/animated-webp.js';

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
  async function animatedFixture(options = {}) {
    const bytes = await makeAnimatedWebp(3, { width: 20, height: 10,
      delay: [80, 120, 160], loop: 4, transparent: true, ...options });
    const { record } = await ingest.createCommittedImage({ bytes });
    return { bytes, record, file: path.join(root, record.storage_key) };
  }
  const cached = (record, result, kind = 'thumbnail') => path.join(previewRoot, 'managed-assets', record.id, result.revision, `${kind}.webp`);
  const authorityPath = (record, result, kind = 'thumbnail') => path.join(previewRoot, 'managed-assets',
    record.id, result.revision, `${kind}.authority.json`);
  const readAuthority = (record, result, kind = 'thumbnail') => JSON.parse(fs.readFileSync(authorityPath(record, result, kind), 'utf8'));
  const writeAuthority = (record, result, kind, authority) => fs.writeFileSync(authorityPath(record, result, kind), `${JSON.stringify(authority)}\n`);
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
      expect(readAuthority(record, result, kind)).toMatchObject({
        sourceSha256: record.sha256,
        kind,
        animated: false,
        frameCount: 1,
      });
      expect(readAuthority(record, result, kind)).not.toHaveProperty('delay');
      expect(readAuthority(record, result, kind)).not.toHaveProperty('loop');
      expect(await media.getDerivative(record.id, kind)).toMatchObject({ bytes: expected, revision: result.revision, cacheHit: true });
    }
    expect(fs.readFileSync(file)).toEqual(bytes);
    expect(fs.statSync(file).mtimeMs).toBe(originalStat.mtimeMs);
    expect(repository.findById(record.id)).toEqual(record);
  });

  it('keeps managed cache identity and WebP output when project image policy changes', async () => {
    const { record } = await fixture('png');
    const thumbnail = await media.getDerivative(record.id, 'thumbnail');
    const preview = await media.getDerivative(record.id, 'preview');
    const appMeta = createAppMetaRepository(db);
    appMeta.setValue('images.thumbnail.format', 'png');
    appMeta.setValue('images.thumbnail.max_dimension', '128');
    appMeta.setValue('images.preview.format', 'png');
    appMeta.setValue('images.preview.max_dimension', '320');
    const nextThumbnail = await media.getDerivative(record.id, 'thumbnail');
    const nextPreview = await media.getDerivative(record.id, 'preview');
    expect(nextThumbnail).toMatchObject({ revision: thumbnail.revision, cacheHit: true,
      width: 256, mimeType: 'image/webp' });
    expect(nextPreview).toMatchObject({ revision: preview.revision, cacheHit: true,
      width: 1600, mimeType: 'image/webp' });
    expect(nextThumbnail.bytes).toEqual(thumbnail.bytes);
    expect(nextPreview.bytes).toEqual(preview.bytes);
  });

  it('publishes bounded authoritative metadata and uses only lightweight derivative inspection on a valid hit', async () => {
    const { record } = await animatedFixture();
    vi.resetModules();
    vi.doMock('../src/services/managed-image-service.js', async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        validateManagedImageBuffer: vi.fn(actual.validateManagedImageBuffer),
        inspectManagedImageBufferLightweight: vi.fn(actual.inspectManagedImageBufferLightweight),
      };
    });
    try {
      const imageValidation = await import('../src/services/managed-image-service.js');
      const { createManagedMediaService: createUpdated } = await import('../src/services/managed-media-service.js');
      const updated = createUpdated({ managedAssetRoot: root, previewRoot, managedAssetRepository: repository });
      const first = await updated.getDerivative(record.id, 'preview');
      expect(first.cacheHit).toBe(false);
      expect(imageValidation.validateManagedImageBuffer).toHaveBeenCalledTimes(1);
      expect(imageValidation.inspectManagedImageBufferLightweight).not.toHaveBeenCalled();

      const sidecar = authorityPath(record, first, 'preview');
      expect(fs.statSync(sidecar).size).toBeLessThanOrEqual(MANAGED_DERIVATIVE_METADATA_MAX_BYTES);
      expect(readAuthority(record, first, 'preview')).toEqual({
        authorityVersion: MANAGED_DERIVATIVE_CACHE_AUTHORITY_VERSION,
        sourceSha256: record.sha256,
        kind: 'preview',
        derivativePolicyVersion: DERIVATIVE_CONFIG_VERSION,
        sizeBytes: first.bytes.length,
        sha256: crypto.createHash('sha256').update(first.bytes).digest('hex'),
        mimeType: 'image/webp',
        width: 20,
        height: 10,
        animated: true,
        frameCount: 3,
        delay: [80, 120, 160],
        loop: 4,
      });

      const second = await updated.getDerivative(record.id, 'preview');
      expect(second).toMatchObject({ bytes: first.bytes, cacheHit: true });
      expect(imageValidation.validateManagedImageBuffer).toHaveBeenCalledTimes(1);
      expect(imageValidation.inspectManagedImageBufferLightweight).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock('../src/services/managed-image-service.js');
      vi.resetModules();
    }
  });

  it.each(['missing', 'malformed', 'oversized'])(
    'treats a %s authority sidecar as an old or invalid cache and self-heals', async (damage) => {
      const { record } = await fixture();
      const first = await media.getDerivative(record.id, 'thumbnail');
      const sidecar = authorityPath(record, first);
      if (damage === 'missing') fs.unlinkSync(sidecar);
      else if (damage === 'malformed') fs.writeFileSync(sidecar, '{');
      else fs.writeFileSync(sidecar, Buffer.alloc(MANAGED_DERIVATIVE_METADATA_MAX_BYTES + 1, 0x20));
      const regenerated = await media.getDerivative(record.id, 'thumbnail');
      expect(regenerated).toMatchObject({ bytes: first.bytes, cacheHit: false });
      expect(readAuthority(record, regenerated)).toMatchObject({
        authorityVersion: MANAGED_DERIVATIVE_CACHE_AUTHORITY_VERSION,
        sourceSha256: record.sha256,
        kind: 'thumbnail',
      });
      expect(await media.getDerivative(record.id, 'thumbnail'))
        .toMatchObject({ bytes: first.bytes, cacheHit: true });
    },
  );

  it.each([
    ['authority version', (authority) => { authority.authorityVersion += 1; }],
    ['source SHA', (authority) => { authority.sourceSha256 = '0'.repeat(64); }],
    ['kind', (authority) => { authority.kind = 'thumbnail'; }],
    ['policy version', (authority) => { authority.derivativePolicyVersion += 1; }],
    ['size', (authority) => { authority.sizeBytes += 1; }],
    ['derivative hash', (authority) => { authority.sha256 = '0'.repeat(64); }],
    ['dimensions', (authority) => { authority.width += 1; }],
    ['animation state', (authority) => { authority.animated = false; }],
    ['frame count', (authority) => { authority.frameCount = 2; authority.delay = authority.delay.slice(0, 2); }],
    ['delay', (authority) => { authority.delay[1] += 1; }],
    ['loop', (authority) => { authority.loop += 1; }],
    ['unknown key', (authority) => { authority.extra = true; }],
  ])('rejects and replaces animated preview authority with a wrong %s', async (_label, tamper) => {
    const { record } = await animatedFixture();
    const first = await media.getDerivative(record.id, 'preview');
    const authority = readAuthority(record, first, 'preview');
    tamper(authority);
    writeAuthority(record, first, 'preview', authority);
    const regenerated = await media.getDerivative(record.id, 'preview');
    expect(regenerated).toMatchObject({ bytes: first.bytes, cacheHit: false });
    expect(readAuthority(record, regenerated, 'preview')).toMatchObject({
      sourceSha256: record.sha256,
      kind: 'preview',
      derivativePolicyVersion: DERIVATIVE_CONFIG_VERSION,
      frameCount: 3,
      delay: [80, 120, 160],
      loop: 4,
    });
  });

  it('keeps an animated managed thumbnail static and preserves preview frames, timing, loop and alpha', async () => {
    const { bytes, record, file } = await animatedFixture();
    const resolved = await media.resolveSource(record.id);
    expect(resolved.image).toMatchObject({ mimeType: 'image/webp', width: 20, height: 10,
      animated: true, frameCount: 3, delay: [80, 120, 160], loop: 4 });

    const thumbnail = await media.getDerivative(record.id, 'thumbnail');
    const thumbnailMetadata = await sharp(thumbnail.bytes, { animated: true, pages: -1 }).metadata();
    expect(thumbnail).toMatchObject({ width: 20, height: 10, mimeType: 'image/webp', cacheHit: false });
    expect(thumbnailMetadata).toMatchObject({ format: 'webp', width: 20, height: 10 });
    expect(thumbnailMetadata.pages ?? 1).toBe(1);

    const preview = await media.getDerivative(record.id, 'preview');
    const previewMetadata = await sharp(preview.bytes, { animated: true, pages: -1 }).metadata();
    expect(preview).toMatchObject({ width: 20, height: 10, mimeType: 'image/webp', cacheHit: false });
    expect(previewMetadata).toMatchObject({ format: 'webp', width: 20, height: 30,
      pageHeight: 10, pages: 3, delay: [80, 120, 160], loop: 4, hasAlpha: true });
    const decoded = await sharp(preview.bytes, { animated: true, pages: -1 }).ensureAlpha().raw().toBuffer();
    expect(Array.from(decoded.subarray(3).filter((_, index) => index % 4 === 0))).toContain(128);
    expect(await media.getDerivative(record.id, 'preview')).toMatchObject({ bytes: preview.bytes, cacheHit: true });
    expect(await media.getDerivative(record.id, 'thumbnail')).toMatchObject({ bytes: thumbnail.bytes, cacheHit: true });
    expect(fs.readFileSync(file)).toEqual(bytes);
  });

  it('revalidates source and cache for an animation above 40M cumulative pixels', async () => {
    const bytes = await makeSolidAnimatedWebp(41, { width: 988, height: 988, delay: 63, loop: 0 });
    const { record } = await ingest.createCommittedImage({ bytes });
    const resolved = await media.resolveSource(record.id);
    expect(resolved.image).toMatchObject({ width: 988, height: 988, animated: true, frameCount: 41 });

    const thumbnail = await media.getDerivative(record.id, 'thumbnail');
    expect(await sharp(thumbnail.bytes, { animated: true, pages: -1 }).metadata())
      .toMatchObject({ width: 256, height: 256 });

    const preview = await media.getDerivative(record.id, 'preview');
    expect(await sharp(preview.bytes, { animated: true, pages: -1 }).metadata()).toMatchObject({
      width: 988, height: 40_508, pageHeight: 988, pages: 41,
      delay: Array(41).fill(63), loop: 0,
    });
    expect(await media.getDerivative(record.id, 'preview'))
      .toMatchObject({ bytes: preview.bytes, revision: preview.revision, cacheHit: true });
  }, 20_000);

  it('resizes animated derivatives from canvas/page geometry without multiplying stacked height', async () => {
    const { record } = await animatedFixture({ width: 2000, height: 100, transparent: false });
    const thumbnail = await media.getDerivative(record.id, 'thumbnail');
    expect(thumbnail).toMatchObject({ width: 256, height: 13, cacheHit: false });
    const thumbnailMetadata = await sharp(thumbnail.bytes, { animated: true, pages: -1 }).metadata();
    expect(thumbnailMetadata).toMatchObject({ width: 256, height: 13 });
    expect(thumbnailMetadata.pages ?? 1).toBe(1);

    const preview = await media.getDerivative(record.id, 'preview');
    expect(preview).toMatchObject({ width: 1600, height: 80, cacheHit: false });
    expect(await sharp(preview.bytes, { animated: true, pages: -1 }).metadata())
      .toMatchObject({ width: 1600, height: 240, pageHeight: 80, pages: 3,
        delay: [80, 120, 160], loop: 4 });
  });

  it.each([
    ['still preview', async (result) => sharp({ create: { width: result.width, height: result.height,
      channels: 4, background: '#123456' } }).webp().toBuffer()],
    ['wrong frame-count preview', async (result) => makeAnimatedWebp(2, { width: result.width,
      height: result.height, delay: [80, 120], loop: 4 })],
    ['wrong timing preview', async (result) => makeAnimatedWebp(3, { width: result.width,
      height: result.height, delay: [80, 121, 160], loop: 4 })],
    ['wrong loop preview', async (result) => makeAnimatedWebp(3, { width: result.width,
      height: result.height, delay: [80, 120, 160], loop: 3 })],
  ])('rejects and regenerates an animated source cache containing a %s', async (_label, replacement) => {
    const { record } = await animatedFixture();
    const first = await media.getDerivative(record.id, 'preview');
    const file = cached(record, first, 'preview');
    fs.writeFileSync(file, await replacement(first));
    const regenerated = await media.getDerivative(record.id, 'preview');
    expect(regenerated).toMatchObject({ bytes: first.bytes, revision: first.revision, cacheHit: false });
    expect(fs.readFileSync(file)).toEqual(first.bytes);
  });

  it('rejects a later-frame tamper by hash before lightweight inspection and regenerates it', async () => {
    const { record } = await animatedFixture();
    const first = await media.getDerivative(record.id, 'preview');
    const file = cached(record, first, 'preview');
    const damaged = Buffer.from(first.bytes);
    const secondFrame = webpChunks(damaged).filter((chunk) => chunk.type === 'ANMF')[1];
    let nestedOffset = secondFrame.start + 16;
    let nestedLength = damaged.readUInt32LE(nestedOffset + 4);
    if (damaged.toString('latin1', nestedOffset, nestedOffset + 4) === 'ALPH') {
      nestedOffset += 8 + nestedLength + nestedLength % 2;
      nestedLength = damaged.readUInt32LE(nestedOffset + 4);
    }
    damaged[nestedOffset + 8] = 0;
    fs.writeFileSync(file, damaged);
    vi.resetModules();
    vi.doMock('../src/services/managed-image-service.js', async (importOriginal) => {
      const actual = await importOriginal();
      return { ...actual, inspectManagedImageBufferLightweight: vi.fn(actual.inspectManagedImageBufferLightweight) };
    });
    try {
      const imageValidation = await import('../src/services/managed-image-service.js');
      const { createManagedMediaService: createUpdated } = await import('../src/services/managed-media-service.js');
      const updated = createUpdated({ managedAssetRoot: root, previewRoot, managedAssetRepository: repository });
      const regenerated = await updated.getDerivative(record.id, 'preview');
      expect(regenerated).toMatchObject({ bytes: first.bytes, cacheHit: false });
      expect(imageValidation.inspectManagedImageBufferLightweight).not.toHaveBeenCalled();
      expect(fs.readFileSync(file)).toEqual(first.bytes);
    } finally {
      vi.doUnmock('../src/services/managed-image-service.js');
      vi.resetModules();
    }
  });

  it('rejects an animated cache for a still source while accepting a static thumbnail for an animated source', async () => {
    const still = await fixture('webp', 20, 10);
    const stillPreview = await media.getDerivative(still.record.id, 'preview');
    fs.writeFileSync(cached(still.record, stillPreview, 'preview'),
      await makeAnimatedWebp(2, { width: 20, height: 10 }));
    expect(await media.getDerivative(still.record.id, 'preview'))
      .toMatchObject({ bytes: stillPreview.bytes, cacheHit: false });

    const animated = await animatedFixture();
    const thumbnail = await media.getDerivative(animated.record.id, 'thumbnail');
    expect(await media.getDerivative(animated.record.id, 'thumbnail'))
      .toMatchObject({ bytes: thumbnail.bytes, cacheHit: true });
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

  it('does not classify an unexpected cache read fault as rebuildable image corruption', async () => {
    const { record } = await fixture();
    const first = await media.getDerivative(record.id, 'preview');
    const file = cached(record, first, 'preview');
    const before = fs.statSync(file, { bigint: true });
    const open = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation((candidate, ...args) => {
      if (candidate === file) throw Object.assign(new Error('cache read failed'), { code: 'EIO' });
      return open(candidate, ...args);
    });
    await expect(media.getDerivative(record.id, 'preview'))
      .rejects.toMatchObject({ name: 'ManagedMediaError', code: 'CACHE_UNAVAILABLE' });
    const after = fs.statSync(file, { bigint: true });
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(after.ino).toBe(before.ino);
  });

  it('keeps an authority-sidecar EIO on the CACHE_UNAVAILABLE path', async () => {
    const { record } = await fixture();
    const first = await media.getDerivative(record.id, 'thumbnail');
    const sidecar = authorityPath(record, first);
    const open = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation((candidate, ...args) => {
      if (candidate === sidecar) throw Object.assign(new Error('authority read failed'), { code: 'EIO' });
      return open(candidate, ...args);
    });
    await expect(media.getDerivative(record.id, 'thumbnail'))
      .rejects.toMatchObject({ name: 'ManagedMediaError', code: 'CACHE_UNAVAILABLE' });
  });

  it('does not leave a trusted derivative when authority publication fails', async () => {
    const { record } = await fixture();
    const resolved = await media.resolveSource(record.id);
    const dir = path.join(previewRoot, 'managed-assets', record.id, resolved.revision);
    const file = path.join(dir, 'thumbnail.webp');
    const sidecar = path.join(dir, 'thumbnail.authority.json');
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to, ...args) => {
      if (to === sidecar) throw Object.assign(new Error('authority publication failed'), { code: 'EIO' });
      return rename(from, to, ...args);
    });
    await expect(media.getDerivative(record.id, 'thumbnail'))
      .rejects.toMatchObject({ name: 'ManagedMediaError', code: 'CACHE_UNAVAILABLE' });
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(sidecar)).toBe(false);
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

  it.each(['missing', 'corrupt', 'replaced'])('fails closed for %s source even with a cache hit available', async (damage) => {
    const { record, file, bytes } = await fixture();
    await media.getDerivative(record.id, 'thumbnail');
    if (damage === 'missing') fs.unlinkSync(file);
    if (damage === 'corrupt') fs.writeFileSync(file, 'broken');
    if (damage === 'replaced') {
      const replacement = Buffer.from(bytes);
      replacement[replacement.length - 1] ^= 1;
      fs.writeFileSync(file, replacement);
    }
    await unavailable(record.id);
    expect(repository.findById(record.id)).toEqual(record);
  });

  it.each([new TypeError('repository type failure'), new Error('repository failure')])(
    'propagates unexpected repository failures', async (failure) => {
      const { record } = await fixture();
      media = createManagedMediaService({ managedAssetRoot: root, previewRoot,
        managedAssetRepository: { findById: () => { throw failure; } } });
      await expect(media.resolveSource(record.id)).rejects.toBe(failure);
    });

  it.each(['EIO', 'EACCES'])('propagates source filesystem %s failures', async (code) => {
    const { record, file } = await fixture();
    const failure = Object.assign(new Error(`source ${code}`), { code });
    const open = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation((candidate, ...args) => {
      if (candidate === file) throw failure;
      return open(candidate, ...args);
    });
    await expect(media.resolveSource(record.id)).rejects.toBe(failure);
  });

  it('propagates unexpected source validator runtime failures', async () => {
    const { record } = await fixture();
    const failure = new RangeError('validator allocation failure');
    vi.resetModules();
    vi.doMock('../src/services/managed-image-service.js', async (importOriginal) => ({
      ...await importOriginal(),
      revalidateCommittedManagedImageBuffer: vi.fn(() => { throw failure; }),
    }));
    try {
      const { createManagedMediaService: createUpdated } = await import('../src/services/managed-media-service.js');
      const updated = createUpdated({ managedAssetRoot: root, previewRoot, managedAssetRepository: repository });
      await expect(updated.resolveSource(record.id)).rejects.toBe(failure);
    } finally {
      vi.doUnmock('../src/services/managed-image-service.js');
      vi.resetModules();
    }
  });

  it('resolves a committed source without invoking the full admission validator', async () => {
    const { record } = await animatedFixture();
    const admission = vi.fn(() => { throw new Error('full admission validator must not run'); });
    vi.resetModules();
    vi.doMock('../src/services/managed-image-service.js', async (importOriginal) => ({
      ...await importOriginal(),
      validateManagedImageBuffer: admission,
    }));
    try {
      const { createManagedMediaService: createUpdated } = await import('../src/services/managed-media-service.js');
      const updated = createUpdated({ managedAssetRoot: root, previewRoot, managedAssetRepository: repository });
      await expect(updated.resolveSource(record.id)).resolves.toMatchObject({
        image: { animated: true, frameCount: 3 },
      });
      expect(admission).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('../src/services/managed-image-service.js');
      vi.resetModules();
    }
  });

  it('propagates unexpected cached-derivative validator runtime failures', async () => {
    const { record } = await fixture();
    await media.getDerivative(record.id, 'preview');
    const failure = new TypeError('cache validator runtime failure');
    vi.resetModules();
    vi.doMock('../src/services/managed-image-service.js', async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        inspectManagedImageBufferLightweight: vi.fn((bytes) => {
          if (bytes.toString('ascii', 8, 12) === 'WEBP') throw failure;
          return actual.inspectManagedImageBufferLightweight(bytes);
        }),
      };
    });
    try {
      const { createManagedMediaService: createUpdated } = await import('../src/services/managed-media-service.js');
      const updated = createUpdated({ managedAssetRoot: root, previewRoot, managedAssetRepository: repository });
      await expect(updated.getDerivative(record.id, 'preview')).rejects.toBe(failure);
    } finally {
      vi.doUnmock('../src/services/managed-image-service.js');
      vi.resetModules();
    }
  });

  it('propagates unexpected derivative-generation runtime failures', async () => {
    const { record } = await fixture();
    const failure = new RangeError('derivative allocation failure');
    vi.resetModules();
    vi.doMock('../src/services/preview-service.js', async (importOriginal) => ({
      ...await importOriginal(),
      buildDerivativePipeline: vi.fn(() => { throw failure; }),
    }));
    try {
      const { createManagedMediaService: createUpdated } = await import('../src/services/managed-media-service.js');
      const updated = createUpdated({ managedAssetRoot: root, previewRoot, managedAssetRepository: repository });
      await expect(updated.getDerivative(record.id, 'thumbnail')).rejects.toBe(failure);
    } finally {
      vi.doUnmock('../src/services/preview-service.js');
      vi.resetModules();
    }
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
