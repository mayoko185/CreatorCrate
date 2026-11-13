import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import express from 'express';
import request from 'supertest';
import http from 'node:http';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createAppMetaRepository } from '../src/data/app-meta-repository.js';
import { createGeneratedImagePublicationRepository, normalizeGeneratedImagePublication } from '../src/data/generated-image-publication-repository.js';
import { createProjectImageSettingsService } from '../src/services/project-image-settings-service.js';
import { createProcessingConcurrencyService } from '../src/services/processing-concurrency-service.js';
import { createPreviewService, _lockCountForTests } from '../src/services/preview-service.js';
import { createComicMediaService } from '../src/services/comic-media-service.js';
import { createComicAdmission } from '../src/services/comic-admission.js';
import { createComicRenditionSupervisor } from '../src/services/comic-rendition-process.js';
import { createMediaService } from '../src/services/media-service.js';
import { createMediaRouter } from '../src/routes/media.js';
import { createApp } from '../src/app.js';
import { createGeneratedImageRebuildRepository } from '../src/data/generated-image-rebuild-repository.js';
import { createGeneratedImageRebuildService } from '../src/services/generated-image-rebuild-service.js';
import { createGeneratedImagePublicationLifecycleRepository } from '../src/data/generated-image-publication-lifecycle-repository.js';
import { createGeneratedImagePublicationLifecycleService } from '../src/services/generated-image-publication-lifecycle-service.js';
import { createManagedUploadTracker } from '../src/services/managed-upload-tracker.js';
import { resetGeneratedImagePublicationsForRestore } from '../src/data/generated-image-publication-lifecycle-repository.js';
import { makeZip } from './helpers/zip-fixture.js';
import { makeAnimatedWebp } from './helpers/animated-webp.js';
import { bindTestProjectOwnership } from './helpers/project-ownership.js';

const migrations = fileURLToPath(new URL('../migrations/', import.meta.url));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
let h;
vi.setConfig({ testTimeout: 30_000 });

beforeEach(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cover-processing-'));
  const projectsRoot = path.join(root, 'projects');
  const previewRoot = path.join(root, 'previews');
  fs.mkdirSync(projectsRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  runMigrations(db, migrations);
  const projects = createProjectRepository(db), assets = createAssetRepository(db);
  let project = projects.create({ title: 'Cover', projectType: 'images', slug: 'cover',
    description: '', notes: '', status: 'tbd', priority: 'normal', plannedDate: null, publishedDate: null, patreonUrl: null });
  const directory = path.join(projectsRoot, `${project.id}-cover`);
  fs.mkdirSync(directory);
  project = projects.setProjectDir(project.id, path.basename(directory));
  bindTestProjectOwnership(db, project.id, directory);
  const appMeta = createAppMetaRepository(db);
  const settings = createProjectImageSettingsService({ appMetaRepository: appMeta });
  const actualPool = createProcessingConcurrencyService({ concurrency: 1 });
  const pool = { ...actualPool, run: vi.fn(actualPool.run), tryRun: vi.fn(actualPool.tryRun) };
  const admission = createComicAdmission();
  const native = createComicRenditionSupervisor();
  const renditions = { ...native, run: vi.fn(native.run) };
  const hooks = {}, sourceHooks = {};
  const publications = createGeneratedImagePublicationRepository(db);
  let comic;
  const preview = createPreviewService({ db, projectsRoot, previewRoot,
    projectImageSettingsService: settings, processingConcurrencyService: pool,
    generatedImagePublicationRepository: publications, comicSourceProvider: () => comic,
    comicAdmissionLimits: admission.limits, _hooks: hooks });
  const source = createComicMediaService({ previewService: preview, projectsRoot, admission, renditions, _hooks: sourceHooks });
  comic = { ...source, startComicCoverSource: vi.fn(source.startComicCoverSource) };
  const media = createMediaService({ previewService: preview, projectsRoot, previewRoot });
  const app = express();
  app.use('/projects', createMediaRouter({ mediaService: media, comicMediaService: comic }));
  app.use((error, req, res, next) => res.status(error.status || 500).send(error.message));
  const png = await sharp({ create: { width: 1200, height: 800, channels: 3,
    background: { r: 230, g: 20, b: 60 } } }).png().toBuffer();
  const archive = bytes => makeZip([{ name: 'page10.png', data: png }, { name: 'page1.png', data: bytes || png }]);
  const add = (bytes = archive(), extension = 'cbz', name = `book.${extension}`) => {
    const full = path.join(directory, name);
    fs.writeFileSync(full, bytes);
    const stat = fs.statSync(full);
    const asset = assets.upsert(project.id, name, { filename: name, extension,
      mimeType: extension === 'png' ? 'image/png' : 'application/octet-stream',
      sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() });
    return { asset, full };
  };
  h = { root, db, directory, project, projects, assets, appMeta, settings, pool, admission, renditions,
    preview, comic, hooks, sourceHooks, publications, app, png, archive, add, previewRoot, projectsRoot, media,
    useComic: service => { comic = service; h.comic = service; } };
});
afterEach(async () => {
  vi.restoreAllMocks();
  h.comic.stop();
  await h.comic.pauseForMaintenance().waitForIdle();
  h.composed?.locals.generatedImageRebuildService?.stop();
  h.composed?.locals.generatedImagePublicationLifecycle?.stop();
  await h.renditions.close();
  for (let i = 0; i < 50 && _lockCountForTests(); i++) await turn();
  expect(_lockCountForTests()).toBe(0);
  expect(h.admission.snapshot()).toMatchObject({ active: 0, queued: 0 });
  expect(h.renditions.snapshot()).toMatchObject({ active: 0, terminating: 0 });
  closeDatabase(h.db);
  sharp.cache(false);
  const ownedRoot = path.resolve(h.root), tempRoot = path.resolve(os.tmpdir()) + path.sep;
  expect(ownedRoot.startsWith(tempRoot)).toBe(true);
  expect(path.basename(ownedRoot).startsWith('cc-cover-processing-')).toBe(true);
  fs.rmSync(ownedRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  expect(fs.existsSync(ownedRoot)).toBe(false);
});
const get = (asset, kind = 'preview', options) => h.preview[kind === 'thumbnail' ? 'getThumbnail' : 'getPreview'](h.project.id, asset.id, undefined, options);
const url = (asset, kind = 'preview') => `/projects/${h.project.id}/assets/${asset.id}/${kind}`;
const counts = () => ['assets', 'generated_artifacts', 'generated_image_publications', 'generated_image_derivatives']
  .map(table => h.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);

describe('ordinary lifecycle comic input', () => {
  it.each(['webp', 'png', 'original'])('publishes identical ordinary and comic %s bytes from one source read', async format => {
    const width = 1200, height = 1800, pixels = Buffer.alloc(width * height * 3);
    for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 31 + Math.floor(i / 101)) & 255;
    const png = await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
    h.appMeta.setValue('images.thumbnail.max_dimension', '128');
    h.appMeta.setValue('images.thumbnail.webp_quality', '61');
    h.appMeta.setValue('images.preview.max_dimension', '960');
    h.appMeta.setValue('images.preview.webp_quality', '73');
    h.appMeta.setValue('images.preview.format', format);
    const comic = h.add(makeZip([{ name: 'page1.png', data: png }]));
    const ordinary = h.add(png, 'png', 'art.png');
    const extracted = h.sourceHooks.afterRead = vi.fn();
    const staged = h.hooks.onDerivativeStaged = vi.fn();
    const cover = await get(comic.asset), image = await get(ordinary.asset);
    const coverThumb = await get(comic.asset, 'thumbnail'), imageThumb = await get(ordinary.asset, 'thumbnail');
    expect(extracted).toHaveBeenCalledTimes(1);
    expect(h.pool.run).toHaveBeenCalledTimes(2);
    expect(h.pool.tryRun).not.toHaveBeenCalled();
    expect(h.renditions.run).toHaveBeenCalledTimes(2);
    expect(staged.mock.calls).toEqual([['thumbnail', 'encoded'], ['preview', 'encoded'],
      ['thumbnail', 'encoded'], ['preview', 'encoded']]);
    for (const [left, right] of [[cover, image], [coverThumb, imageThumb]]) {
      expect(fs.readFileSync(left.path)).toEqual(fs.readFileSync(right.path));
      expect([left.width, left.height, left.mimeType, left.bytes]).toEqual([right.width, right.height, right.mimeType, right.bytes]);
      expect(left.cacheState).toBe(right.cacheState);
    }
    expect([coverThumb.width, coverThumb.height]).toEqual([85, 128]);
    expect([cover.width, cover.height]).toEqual(format === 'original' ? [1067, 1600] : [640, 960]);
    const publication = asset => h.publications.findPublication(h.project.id, asset.id);
    const normalize = value => { const { assetId, revision, directoryName, generatedAt, sourceRelativePath,
      sourceSizeBytes, sourceMtime, sourceInputFingerprint, ...rest } = value; return rest; };
    expect(normalize(publication(comic.asset))).toEqual(normalize(publication(ordinary.asset)));
    expect(publication(comic.asset).sourceInputFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(publication(ordinary.asset).sourceInputFingerprint).toBeNull();
    expect(counts()).toEqual([2, 0, 2, 4]);
  });

  it('reads no original or prepared image and acquires no generation permit for warm saturated hits', async () => {
    const { asset } = h.add();
    const first = await get(asset);
    const read = h.sourceHooks.afterRead = vi.fn(), prepared = h.sourceHooks.preparedRead = vi.fn();
    h.renditions.run.mockClear(); h.pool.run.mockClear(); h.pool.tryRun.mockClear();
    expect((await get(asset)).cacheState).toBe('fresh');
    expect(read).not.toHaveBeenCalled(); expect(prepared).not.toHaveBeenCalled();
    expect(h.renditions.run).not.toHaveBeenCalled();
    expect(h.pool.run).not.toHaveBeenCalled(); expect(h.pool.tryRun).not.toHaveBeenCalled();
    const gate = deferred();
    const occupied = h.pool.run(() => gate.promise);
    h.pool.run.mockClear();
    try {
      for (const kind of ['preview', 'thumbnail', 'preview']) {
        const current = await get(asset, kind);
        expect(current).toMatchObject({ status: 'ready', revision: first.revision, cacheState: 'fresh' });
        expect(() => h.preview.assertComicDerivativeCurrent(current)).not.toThrow();
      }
      expect(read).not.toHaveBeenCalled(); expect(prepared).not.toHaveBeenCalled();
      expect(h.renditions.run).not.toHaveBeenCalled();
      expect(h.pool.run).not.toHaveBeenCalled(); expect(h.pool.tryRun).not.toHaveBeenCalled();
      h.db.prepare('UPDATE assets SET is_present = 0 WHERE id = ?').run(asset.id);
      await expect(get(asset)).rejects.toThrow();
    } finally { gate.resolve(); await occupied; }
  });

  it.each(['png', 'cbz'])('fails through the existing common generation stage for %s', async extension => {
    const { asset } = extension === 'png' ? h.add(h.png, 'png', 'art.png') : h.add();
    const failure = new Error('common generation stopped');
    h.hooks.beforeThumbTransform = () => { throw failure; };
    await expect(get(asset)).rejects.toThrow();
    expect(h.renditions.run).not.toHaveBeenCalled();
    expect(counts()).toEqual([1, 0, 0, 0]);
  });

  it.each(['warm', 'pre-generation'].flatMap(state => ['deadline', 'cancel'].map(reason => [state, reason])))
  ('aborts %s proof-only work on caller %s while retaining its exact retirement', async (state, reason) => {
    const { asset } = h.add();
    if (state === 'warm') await get(asset);
    h.pool.run.mockClear(); h.renditions.run.mockClear();
    const entered = deferred(), release = deferred(), controller = new AbortController();
    let inputSignal, operation, retired = false;
    const start = h.comic.startComicCoverSource;
    h.comic.startComicCoverSource = (...args) => {
      const work = args[3];
      args[3] = async input => {
        inputSignal = input.signal;
        entered.resolve();
        await release.promise;
        return work(input);
      };
      operation = start(...args);
      void operation.retired.then(() => { retired = true; });
      return operation;
    };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = get(asset, 'preview', { deadlineMs: 1000, signal: controller.signal }).catch(error => error);
    try {
      await entered.promise;
      expect(inputSignal.aborted).toBe(false);
      if (reason === 'deadline') await vi.advanceTimersByTimeAsync(1001);
      else controller.abort();
      expect((await pending).status).toBe(503);
      expect(inputSignal.aborted).toBe(true);
      expect(retired).toBe(false);
      expect(h.admission.snapshot().active).toBe(1);
      expect(h.comic.isIdle()).toBe(false);
      expect(h.pool.run).not.toHaveBeenCalled();
      expect(h.renditions.run).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers(); release.resolve();
      await pending;
      if (operation) await operation.retired;
    }
    expect(retired).toBe(true);
    expect(h.admission.snapshot().active).toBe(0);
    expect(h.comic.isIdle()).toBe(true);
  });

  it('retains a deadline-aborted proof until its failed close actually retires', async () => {
    const { asset, full } = h.add(); await get(asset);
    const entered = deferred(), release = deferred(), closeAttempted = deferred();
    const open = fs.promises.open, start = h.comic.startComicCoverSource;
    let owned, close, operation, retired = false;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (path.resolve(args[0]) === full && !owned) {
        owned = handle; close = handle.close.bind(handle);
        handle.close = () => {
          closeAttempted.resolve();
          return Promise.reject(Object.assign(new Error('close failed'), { code: 'EIO' }));
        };
      }
      return handle;
    });
    h.comic.startComicCoverSource = (...args) => {
      const work = args[3];
      args[3] = async input => { entered.resolve(); await release.promise; return work(input); };
      operation = start(...args);
      void operation.retired.then(() => { retired = true; });
      return operation;
    };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = get(asset, 'preview', { deadlineMs: 1000 }).catch(error => error);
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(1001);
      expect((await pending).status).toBe(503);
      release.resolve(); await closeAttempted.promise; await turn();
      expect(retired).toBe(false);
      expect(owned.fd).toBeGreaterThanOrEqual(0);
      expect(h.admission.snapshot().active).toBe(1);
      expect(h.comic.isIdle()).toBe(false);
    } finally {
      vi.useRealTimers(); release.resolve();
      if (owned) owned.close = close;
      h.comic.stop();
      await pending;
      if (operation) await operation.retired;
    }
    expect(retired).toBe(true);
    expect(owned.fd).toBe(-1);
    expect(h.admission.snapshot().active).toBe(0);
  });

  it('keeps shared generation live when one caller deadline expires', async () => {
    const { asset } = h.add(), entered = deferred(), release = deferred();
    let generationSignal, scopes = 0;
    const start = h.comic.startComicCoverSource;
    h.comic.startComicCoverSource = (...args) => {
      const work = args[3], number = ++scopes;
      args[3] = input => { if (number === 3) generationSignal = input.signal; return work(input); };
      return start(...args);
    };
    h.hooks.beforeThumbTransform = async () => { entered.resolve(); await release.promise; };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const first = get(asset, 'thumbnail', { deadlineMs: 1000 }).catch(error => error);
    let survivor;
    try {
      await entered.promise;
      survivor = get(asset);
      await vi.advanceTimersByTimeAsync(1001);
      expect((await first).status).toBe(503);
      expect(generationSignal.aborted).toBe(false);
    } finally { vi.useRealTimers(); release.resolve(); await first; }
    const current = await survivor;
    expect(current.status).toBe('ready');
    expect(() => h.preview.assertComicDerivativeCurrent(current)).not.toThrow();
    expect(h.pool.run).toHaveBeenCalledTimes(1);
    expect(h.renditions.run).toHaveBeenCalledTimes(2);
  });

  it('keeps cold and warm prepared responses current after successful proof cleanup', async () => {
    const { asset } = h.add();
    for (let i = 0; i < 2; i++) {
      const controller = new AbortController();
      const prepared = await h.media.prepareDerivativeResponse('preview', h.project.id, asset.id, undefined,
        { signal: controller.signal });
      try {
        await turn();
        expect(() => prepared.assertCurrent()).not.toThrow();
        expect(h.admission.snapshot().active).toBe(0);
        expect(h.comic.isIdle()).toBe(true);
        controller.abort();
        expect(() => prepared.assertCurrent()).toThrow();
      } finally { prepared.cleanup(); }
      if (!prepared.stream.closed) await new Promise(resolve => prepared.stream.once('close', resolve));
      expect(prepared.stream.destroyed).toBe(true);
    }
  });

  it.each(['opening', 'post-encoding'])('keeps the admitted permit until exact %s failed-close retirement', async phase => {
    const { asset, full } = h.add();
    const open = fs.promises.open;
    let scopes = 0, owned, close, stat;
    const source = h.comic.startComicCoverSource;
    h.comic.startComicCoverSource = (...args) => { scopes++; return source(...args); };
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (path.resolve(args[0]) === full && scopes === 3 && !owned) {
        owned = handle; close = handle.close.bind(handle); stat = handle.stat.bind(handle);
        handle.close = () => Promise.reject(Object.assign(new Error('close failed'), { code: 'EIO' }));
        if (phase === 'opening') handle.stat = () => Promise.reject(Object.assign(new Error('stat failed'), { code: 'EIO' }));
      }
      return handle;
    });
    try {
      await expect(get(asset)).rejects.toThrow();
      await turn();
      expect(owned.fd).toBeGreaterThanOrEqual(0);
      expect(h.pool.tryRun(() => 'premature')).toBeNull();
      expect(h.admission.snapshot().active).toBe(1);
      if (phase === 'post-encoding') expect(h.renditions.run).toHaveBeenCalledTimes(2);
      expect(counts()).toEqual([1, 0, 0, 0]);
    } finally {
      if (owned) { owned.close = close; owned.stat = stat; }
      h.comic.stop(); await h.pool.run(() => {});
    }
    expect(owned.fd).toBe(-1); expect(h.admission.snapshot().active).toBe(0);
  });
});
