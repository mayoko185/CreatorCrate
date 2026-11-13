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
import { createPreviewService, buildAssetRevisionToken, _lockCountForTests } from '../src/services/preview-service.js';
import { projectImagePolicyFingerprint } from '../src/services/project-image-policy.js';
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
  const actualPool = createProcessingConcurrencyService({ concurrency: /coalesces/.test(expect.getState().currentTestName) ? 2 : 1 });
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

describe('existing comic derivative processing', () => {
  it('drains the existing derivative lock before the composed graph retires', async () => {
    const appDataRoot = path.join(h.root, 'app'); fs.mkdirSync(appDataRoot);
    h.composed = createApp({ appName: 'CreatorCrate', db: h.db, projectsRoot: h.projectsRoot, previewRoot: h.previewRoot },
      { previewService: h.preview, processingConcurrencyService: h.pool, comicRuntime: { admission: h.admission, renditions: h.renditions },
        appDataRoot, authState: { csrfPepper: '1'.repeat(64) }, startGeneratedImageRebuild: false });
    h.useComic(h.composed.locals.comicMediaService);
    const { asset } = h.add();
    const entered = deferred(), release = deferred();
    h.hooks.beforePointerWrite = async () => { entered.resolve(); await release.promise; };
    const outcome = get(asset).catch(error => error);
    await entered.promise;
    expect(h.comic.isIdle()).toBe(false);
    const pause = h.comic.pauseForMaintenance();
    let idle = false;
    const waiting = pause.waitForIdle().then(() => { idle = true; });
    try {
      await turn(); expect(idle).toBe(false);
    } finally { release.resolve(); }
    expect((await outcome).status).toBe(503);
    await waiting;
    expect(h.comic.isIdle()).toBe(true);
    expect(counts()).toEqual([1, 0, 0, 0]);
    pause.release(); delete h.hooks.beforePointerWrite;
    expect((await get(asset)).status).toBe('ready');
  });
  it('cancels during extraction and retains the permit until the source scope unwinds', async () => {
    const { asset } = h.add();
    const entered = deferred(), release = deferred(), controller = new AbortController();
    h.sourceHooks.afterRead = async () => { entered.resolve(); await release.promise; };
    const pending = get(asset, 'preview', { signal: controller.signal }).catch(error => error);
    await entered.promise; controller.abort();
    expect((await pending).status).toBe(503);
    expect(h.pool.tryRun(() => {})).toBeNull();
    release.resolve(); await h.pool.run(() => {});
    expect(counts()).toEqual([1, 0, 0, 0]);
  });
  it.each(['metadata', 'stats', 'convert'])('retires native execution after caller cancellation at %s', async phase => {
    const { asset } = h.add();
    const controller = new AbortController();
    h.sourceHooks.renditionPhase = ({ phase: current }) => { if (current === phase) controller.abort(); };
    await expect(get(asset, 'preview', { signal: controller.signal })).rejects.toMatchObject({ status: 503 });
    await h.pool.run(() => {});
    expect(h.renditions.snapshot()).toMatchObject({ active: 0, terminating: 0 });
    expect(counts()).toEqual([1, 0, 0, 0]);
  });
  it('expires a caller deadline while generation is held and refuses a pre-cancelled caller', async () => {
    const { asset } = h.add();
    const cancelled = new AbortController(); cancelled.abort();
    await expect(get(asset, 'preview', { signal: cancelled.signal })).rejects.toMatchObject({ status: 503 });
    expect(h.comic.startComicCoverSource).not.toHaveBeenCalled();
    const entered = deferred(), release = deferred();
    h.hooks.beforeThumbTransform = async () => { entered.resolve(); await release.promise; };
    const started = performance.now();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = get(asset, 'preview', { deadlineMs: 1000 }).catch(error => error);
    await entered.promise;
    try {
      await vi.advanceTimersByTimeAsync(1001);
      expect((await pending).status).toBe(503);
    } finally { vi.useRealTimers(); release.resolve(); }
    expect(performance.now() - started).toBeLessThan(500);
    await h.pool.run(() => {});
    expect(counts()).toEqual([1, 0, 0, 0]);
  });
  it.each([false, true])('generates from real CB7 with solid=%s', async solid => {
    const SevenZip = createRequire(import.meta.url)('7z-wasm');
    const module = await SevenZip({ print() {}, printErr() {} });
    module.FS.mkdir('/w'); module.FS.chdir('/w');
    module.FS.writeFile('/w/page10.png', h.png); module.FS.writeFile('/w/page1.png', h.png);
    expect(module.callMain(['a', '-t7z', `-ms=${solid ? 'on' : 'off'}`, '-mmt=1', '-bsp0', '-bso0', '-bse0', '/out.7z', 'page10.png', 'page1.png'])).toBe(0);
    const { asset } = h.add(Buffer.from(module.FS.readFile('/out.7z')), 'cb7');
    expect(await sharp((await get(asset)).path).metadata()).toMatchObject({ width: 1200, height: 800 });
  });
  it('honors distinct WebP qualities on real detailed output', async () => {
    const width = 600, height = 400, raw = Buffer.alloc(width * height * 3);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 31 + Math.floor(i / 101)) & 255;
    const png = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
    const { asset } = h.add(h.archive(png));
    h.appMeta.setValue('images.thumbnail.max_dimension', '512');
    h.appMeta.setValue('images.thumbnail.webp_quality', '10');
    h.appMeta.setValue('images.preview.webp_quality', '95');
    h.appMeta.setValue('images.preview.max_dimension', '512');
    const thumbnail = await get(asset, 'thumbnail'), preview = await get(asset);
    expect(preview.bytes).toBeGreaterThan(thumbnail.bytes * 2);
    const expected = await sharp(png).resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true }).raw().toBuffer();
    const error = async file => { const pixels = await sharp(file).raw().toBuffer(); return pixels.reduce((sum, value, i) => sum + Math.abs(value - expected[i]), 0); };
    expect(await error(preview.path)).toBeLessThan(await error(thumbnail.path));
  });
  it.each(['comic-rar4.cbr', 'comic-rar4-solid.cbr', 'comic-rar5.cbr', 'comic-rar5-solid.cbr'])('generates through real %s input', async name => {
    const bytes = fs.readFileSync(fileURLToPath(new URL(`./fixtures/comic-archives/${name}`, import.meta.url)));
    const { asset } = h.add(bytes, 'cbr');
    expect(await sharp((await get(asset)).path).metadata()).toMatchObject({ width: 48, height: 64 });
    expect(h.publications.findPublication(h.project.id, asset.id).sourceInputFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each(['webp', 'png'])('uses configured distinct %s outputs and a complete normal publication', async format => {
    h.appMeta.setValue('images.thumbnail.format', format);
    h.appMeta.setValue('images.thumbnail.max_dimension', '128');
    h.appMeta.setValue('images.preview.format', format);
    h.appMeta.setValue('images.preview.max_dimension', '960');
    const { asset } = h.add();
    const preview = await get(asset), thumbnail = await get(asset, 'thumbnail');
    expect(await sharp(preview.path).metadata()).toMatchObject({ format, width: 960, height: 640 });
    expect(await sharp(thumbnail.path).metadata()).toMatchObject({ format, width: 128, height: 85 });
    const pixel = await sharp(preview.path).raw().toBuffer();
    expect(pixel[0]).toBeGreaterThan(200);
    expect(pixel[1]).toBeLessThan(40);
    const publication = h.publications.findPublication(h.project.id, asset.id);
    expect(publication.sourceInputFingerprint).toMatch(/^[a-f0-9]{64}$/);
    for (const invalid of ['invalid', 'A'.repeat(64), ['a'.repeat(64)], 123]) {
      expect(() => normalizeGeneratedImagePublication({ ...publication, sourceInputFingerprint: invalid })).toThrow('sourceInputFingerprint');
    }
    const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(preview.path), 'meta.json')));
    expect(meta.source.inputFingerprint).toBe(publication.sourceInputFingerprint);
    expect(JSON.parse(fs.readFileSync(path.join(h.previewRoot, 'projects', String(h.project.id), String(asset.id), 'current.json'))).revision).toBe(preview.revision);
    expect(counts()).toEqual([1, 0, 1, 2]);
  });
  it('reuses warm disk bytes without another encode and reauthorizes the source', async () => {
    const { asset } = h.add();
    const encoded = vi.spyOn(h.renditions, 'run');
    const first = await get(asset);
    expect(encoded).toHaveBeenCalledTimes(2);
    const second = await get(asset);
    expect(second).toMatchObject({ revision: first.revision, path: first.path, cacheState: 'fresh' });
    expect(encoded).toHaveBeenCalledTimes(2);
    h.db.prepare('UPDATE assets SET is_present = 0 WHERE id = ?').run(asset.id);
    await expect(get(asset)).rejects.toThrow();
  });
  it('uses the non-inline Original fallback for comics and keeps ordinary Original behavior', async () => {
    h.appMeta.setValue('images.preview.format', 'original');
    const { asset } = h.add();
    const preview = await get(asset);
    expect(await sharp(preview.path).metadata()).toMatchObject({ format: 'webp', width: 1200, height: 800 });
    const response = await request(h.app).get(url(asset));
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('image/webp');
    expect((await request(h.app).get(url(asset, 'original'))).status).toBe(415);
    const ordinary = h.add(h.png, 'png', 'art.png').asset;
    expect(h.preview.getOriginalDescriptor(h.project.id, ordinary.id).status).toBe('ready');
    expect((await request(h.app).get(url(ordinary, 'original'))).body).toEqual(h.png);
  });
  it('normalizes EXIF orientation without enlargement', async () => {
    const source = await sharp({ create: { width: 60, height: 100, channels: 3, background: 'blue' } })
      .jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const { asset } = h.add(makeZip([{ name: 'page1.jpg', data: source }]));
    expect(await sharp((await get(asset)).path).metadata()).toMatchObject({ width: 100, height: 60 });
  });
  it('selects static frame zero while ordinary animated Preview stays animated', async () => {
    h.appMeta.setValue('images.preview.format', 'png');
    const source = await makeAnimatedWebp(3, { width: 20, height: 30 });
    const { asset } = h.add(makeZip([{ name: 'page1.webp', data: source }]));
    const comic = await get(asset);
    expect(await sharp(comic.path).metadata()).toMatchObject({ format: 'png', width: 20, height: 30 });
    const ordinary = h.add(source, 'webp', 'animation.webp').asset;
    h.db.prepare("UPDATE assets SET mime_type = 'image/webp', source_animated = 1 WHERE id = ?").run(ordinary.id);
    expect((await get(ordinary)).animated).toBe(true);
  });
  it('regenerates after settings-only and source-generation changes', async () => {
    const { asset } = h.add();
    const first = await get(asset);
    h.appMeta.setValue('images.preview.max_dimension', '640');
    const second = await get(asset);
    expect(second.revision).not.toBe(first.revision);
    expect((await sharp(second.path).metadata()).width).toBe(640);
    h.db.prepare('UPDATE assets SET source_generation = source_generation + 1 WHERE id = ?').run(asset.id);
    expect((await get(asset)).revision).not.toBe(second.revision);
  });
  it('rejects old cached bytes after same-size/mtime physical replacement and first-page change', async () => {
    const { asset, full } = h.add();
    const first = await get(asset);
    const before = fs.statSync(full);
    const replacement = path.join(h.directory, 'replacement.cbz');
    fs.copyFileSync(full, replacement);
    fs.utimesSync(replacement, before.atime, before.mtime);
    fs.renameSync(replacement, full);
    const second = await get(asset);
    expect(second.revision).not.toBe(first.revision);
    expect(second.inputFingerprint).not.toBe(first.inputFingerprint);
    const changed = makeZip([{ name: 'new/page0.png', data: h.png }, { name: 'page1.png', data: h.png }]);
    h.add(changed);
    expect((await get(asset)).inputFingerprint).not.toBe(second.inputFingerprint);
  });
  it.each(['opening', 'catalogue-close'])('holds source admission across proof-only %s rejection without a generation permit', async phase => {
    const { asset, full } = h.add();
    const actualOpen = fs.promises.open;
    let owned, realClose, realStat;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await actualOpen(...args);
      if (path.resolve(args[0]) === full && !owned) {
        owned = handle; realClose = handle.close.bind(handle); realStat = handle.stat.bind(handle);
        handle.close = () => Promise.reject(Object.assign(new Error('close failed'), { code: 'EIO' }));
        if (phase === 'opening') handle.stat = () => Promise.reject(Object.assign(new Error('stat failed'), { code: 'EIO' }));
      }
      return handle;
    });
    try {
      await expect(get(asset)).rejects.toThrow();
      await turn();
      expect(owned.fd).toBeGreaterThanOrEqual(0);
      expect(() => fs.fstatSync(owned.fd)).not.toThrow();
      expect(h.pool.tryRun(() => 'proof only')).not.toBeNull();
      expect(h.admission.snapshot().active).toBe(1);
      expect(counts()).toEqual([1, 0, 0, 0]);
      expect(h.renditions.run).not.toHaveBeenCalled();
    } finally {
      if (owned) { owned.close = realClose; owned.stat = realStat; }
      h.comic.stop();
      await h.comic.pauseForMaintenance().waitForIdle();
      await h.pool.run(() => {});
      if (owned?.fd >= 0 && h.comic.isIdle()) await realClose();
    }
    expect(owned.fd).toBe(-1);
    expect(h.admission.snapshot().active).toBe(0);
  });
  it.each(['staging', 'pointer', 'sqlite'])('preserves complete-pair authority across %s failure and real recovery', async fault => {
    const { asset } = h.add();
    const first = await get(asset);
    h.appMeta.setValue('images.preview.max_dimension', '640');
    if (fault === 'staging') h.hooks.beforeMetaWrite = () => { throw new Error('staging failure'); };
    if (fault === 'pointer') h.hooks.beforePointerWrite = () => { throw new Error('pointer failure'); };
    if (fault === 'sqlite') h.db.exec(`CREATE TRIGGER reject_publication BEFORE UPDATE ON generated_image_publications BEGIN SELECT RAISE(ABORT,'finalization failure'); END;`);
    await expect(get(asset)).rejects.toThrow();
    await h.pool.run(() => {});
    expect(h.publications.findPublication(h.project.id, asset.id).revision).toBe(first.revision);
    if (fault === 'sqlite') {
      h.db.exec('DROP TRIGGER reject_publication');
      const repository = createGeneratedImagePublicationLifecycleRepository(h.db);
      const lifecycle = createGeneratedImagePublicationLifecycleService({ repository, publications: h.publications,
        previewService: h.preview, managedUploadTracker: createManagedUploadTracker() });
      lifecycle.prepare(); lifecycle.signal(); await lifecycle.waitForIdle(); lifecycle.stop();
      expect(h.publications.findIntent(h.project.id, asset.id)).toBeNull();
      expect(h.publications.findPublication(h.project.id, asset.id).revision).not.toBe(first.revision);
    } else {
      delete h.hooks.beforeMetaWrite; delete h.hooks.beforePointerWrite;
      expect((await get(asset)).revision).not.toBe(first.revision);
    }
    expect(counts()).toEqual([1, 0, 1, 2]);
  });
  it('abandons an interrupted candidate after source replacement during actual lifecycle recovery', async () => {
    const { asset } = h.add();
    const first = await get(asset);
    h.appMeta.setValue('images.preview.max_dimension', '640');
    h.db.exec(`CREATE TRIGGER reject_publication BEFORE UPDATE ON generated_image_publications BEGIN SELECT RAISE(ABORT,'finalization failure'); END;`);
    await expect(get(asset)).rejects.toThrow();
    await h.pool.run(() => {});
    h.db.exec('DROP TRIGGER reject_publication');
    h.db.prepare('UPDATE assets SET source_generation = 1 WHERE id = ?').run(asset.id);
    const repository = createGeneratedImagePublicationLifecycleRepository(h.db);
    const lifecycle = createGeneratedImagePublicationLifecycleService({ repository, publications: h.publications,
      previewService: h.preview, managedUploadTracker: createManagedUploadTracker() });
    lifecycle.prepare(); lifecycle.signal(); await lifecycle.waitForIdle(); lifecycle.stop();
    expect(h.publications.findIntent(h.project.id, asset.id)).toBeNull();
    expect(h.publications.findPublication(h.project.id, asset.id).revision).toBe(first.revision);
  });
  it('queues cold generation in the existing FIFO without extracting while capacity is occupied', async () => {
    const { asset } = h.add(), gate = deferred(), order = [], proven = deferred();
    h.sourceHooks.coverAuthority = () => proven.resolve();
    const reads = h.sourceHooks.afterRead = vi.fn();
    const occupied = h.pool.run(async () => { order.push('first'); await gate.promise; });
    const queued = h.pool.run(() => order.push('queued'));
    let settled = false;
    const pending = get(asset).finally(() => { settled = true; });
    try {
      await proven.promise; await turn();
      expect(settled).toBe(false); expect(reads).not.toHaveBeenCalled();
    } finally { gate.resolve(); await Promise.all([occupied, queued]); }
    expect((await pending).status).toBe('ready');
    expect(order).toEqual(['first', 'queued']); expect(reads).toHaveBeenCalledTimes(1);
  });
  it('coalesces same-source callers and keeps a surviving caller after one cancellation', async () => {
    const { asset } = h.add();
    const entered = deferred(), release = deferred();
    h.hooks.beforeThumbTransform = async () => { entered.resolve(); await release.promise; };
    const controller = new AbortController();
    const first = get(asset, 'thumbnail', { signal: controller.signal }).catch(error => error);
    await entered.promise;
    const encoded = h.renditions.run;
    const second = get(asset);
    controller.abort(); release.resolve();
    expect((await first).status).toBe(503);
    expect((await second).status).toBe('ready');
    expect(encoded).toHaveBeenCalledTimes(2);
  });
  it('isolates callers spanning a source-generation replacement', async () => {
    const { asset } = h.add();
    const entered = deferred(), release = deferred();
    h.hooks.beforeThumbTransform = async () => { entered.resolve(); await release.promise; };
    const older = get(asset).catch(error => error);
    await entered.promise;
    h.db.prepare('UPDATE assets SET source_generation = 1 WHERE id = ?').run(asset.id);
    try { await expect(get(asset)).rejects.toMatchObject({ status: 503 }); }
    finally { release.resolve(); }
    expect((await older).status).toBe(503);
    await h.pool.run(() => {});
    delete h.hooks.beforeThumbTransform;
    expect((await get(asset)).status).toBe('ready');
    expect(h.publications.findPublication(h.project.id, asset.id).sourceGeneration).toBe(1);
    expect(counts()).toEqual([1, 0, 1, 2]);
  });
  it('keeps equal filenames in different projects bound to distinct page pixels and publications', async () => {
    const { asset } = h.add();
    let project = h.projects.create({ title: 'Other', projectType: 'images', slug: 'other', description: '', notes: '',
      status: 'tbd', priority: 'normal', plannedDate: null, publishedDate: null, patreonUrl: null });
    const directory = path.join(h.projectsRoot, `${project.id}-other`); fs.mkdirSync(directory);
    project = h.projects.setProjectDir(project.id, path.basename(directory));
    bindTestProjectOwnership(h.db, project.id, directory);
    const blue = await sharp({ create: { width: 1200, height: 800, channels: 3, background: 'blue' } }).png().toBuffer();
    const file = path.join(directory, 'book.cbz'); fs.writeFileSync(file, h.archive(blue));
    const stat = fs.statSync(file);
    const other = h.assets.upsert(project.id, 'book.cbz', { filename: 'book.cbz', extension: 'cbz',
      mimeType: 'application/octet-stream', sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() });
    const first = await get(asset), second = await h.preview.getPreview(project.id, other.id);
    expect(first.path).not.toBe(second.path);
    expect(first.inputFingerprint).not.toBe(second.inputFingerprint);
    expect((await sharp(first.path).raw().toBuffer())[0]).toBeGreaterThan(200);
    expect((await sharp(second.path).raw().toBuffer())[2]).toBeGreaterThan(200);
    await expect(h.preview.getPreview(project.id, asset.id)).rejects.toThrow('does not belong');
    expect(counts()).toEqual([2, 0, 2, 4]);
  });
  it('cancels orphaned work without publication', async () => {
    const { asset } = h.add();
    const entered = deferred(), release = deferred();
    h.hooks.beforeThumbTransform = async () => { entered.resolve(); await release.promise; };
    const controller = new AbortController();
    const outcome = get(asset, 'preview', { signal: controller.signal }).catch(error => error);
    await entered.promise; controller.abort(); release.resolve(); await outcome;
    await h.pool.run(() => {});
    expect(counts()).toEqual([1, 0, 0, 0]);
  });
  it('bounds caller interests using the existing admission capacity', async () => {
    const { asset } = h.add();
    const entered = deferred(), release = deferred();
    h.hooks.beforeThumbTransform = async () => { entered.resolve(); await release.promise; };
    const controller = new AbortController();
    const first = get(asset, 'preview', { signal: controller.signal }).catch(error => error);
    await entered.promise;
    const pending = Array.from({ length: h.admission.limits.maxActive + h.admission.limits.maxQueued - 1 },
      () => get(asset, 'preview', { signal: controller.signal }).catch(error => error));
    let refused = false;
    const excess = get(asset).catch(error => { refused = true; return error; });
    try {
      await turn();
      expect(refused).toBe(true);
      expect((await excess).status).toBe(503);
    } finally { controller.abort(); release.resolve(); await Promise.all([first, ...pending, excess]); }
    await h.pool.run(() => {});
    expect(counts()).toEqual([1, 0, 0, 0]);
  });
  it.each(['format', 'cbr-to-cb7', 'generation', 'withdrawal', 'stop'])('prevents publication after %s changes at the publication barrier', async change => {
    const { asset } = change === 'cbr-to-cb7'
      ? h.add(fs.readFileSync(fileURLToPath(new URL('./fixtures/comic-archives/comic-rar5.cbr', import.meta.url))), 'cbr') : h.add();
    h.hooks.beforePointerWrite = () => {
      if (change === 'format') h.db.prepare("UPDATE assets SET extension = 'cbr' WHERE id = ?").run(asset.id);
      if (change === 'cbr-to-cb7') h.db.prepare("UPDATE assets SET extension = 'cb7' WHERE id = ?").run(asset.id);
      if (change === 'generation') h.db.prepare('UPDATE assets SET source_generation = 1 WHERE id = ?').run(asset.id);
      if (change === 'withdrawal') h.db.prepare('UPDATE assets SET is_present = 0 WHERE id = ?').run(asset.id);
      if (change === 'stop') h.comic.stop();
    };
    await expect(get(asset)).rejects.toThrow();
    await h.pool.run(() => {});
    expect(counts()).toEqual([1, 0, 0, 0]);
  });
  it('serves PNG through common revalidation and refuses member selectors', async () => {
    h.appMeta.setValue('images.thumbnail.format', 'png'); h.appMeta.setValue('images.preview.format', 'png');
    const { asset } = h.add();
    for (const kind of ['thumbnail', 'preview']) {
      const response = await request(h.app).get(url(asset, kind)).set('If-None-Match', '*');
      expect(response.status).toBe(200);
      expect(response.headers).toMatchObject({ 'cache-control': 'private, max-age=0, must-revalidate', 'x-content-type-options': 'nosniff' });
      expect((await sharp(response.body).metadata()).format).toBe('png');
    }
    expect((await request(h.app).get(url(asset) + '?member=page10.png')).status).toBe(400);
    expect((await request(h.app).get(url(asset) + '?v=0123456789abcdef')).status).toBe(200);
    expect((await request(h.app).get(`/projects/999/assets/${asset.id}/preview`)).status).toBe(404);
  });
  it('uses exactly one processing admission for the whole shared generation', async () => {
    const { asset } = h.add();
    await get(asset);
    expect(h.pool.run).toHaveBeenCalledTimes(1);
    expect(h.pool.tryRun).not.toHaveBeenCalled();
  });
  it('refuses generic archives on the existing derivative routes', async () => {
    for (const extension of ['zip', '7z']) {
      const { asset } = h.add(h.archive(), extension);
      expect((await request(h.app).get(url(asset))).status).toBe(415);
    }
    expect(counts()).toEqual([2, 0, 0, 0]);
  });
  it('refuses stale HTTP bytes when source withdrawal occurs during stream setup', async () => {
    const { asset } = h.add();
    await get(asset);
    const real = fs.createReadStream;
    vi.spyOn(fs, 'createReadStream').mockImplementation((...args) => {
      const stream = real(...args);
      stream.once('open', () => h.db.prepare('UPDATE assets SET is_present = 0 WHERE id = ?').run(asset.id));
      return stream;
    });
    const response = await request(h.app).get(url(asset));
    expect(response.status).toBe(404);
    expect(response.headers).toMatchObject({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  });
  it('detaches an HTTP disconnect while a surviving caller receives the shared pair', async () => {
    const { asset } = h.add();
    const entered = deferred(), release = deferred();
    const joined = deferred(), original = h.preview.getPreview;
    let calls = 0;
    vi.spyOn(h.preview, 'getPreview').mockImplementation((...args) => {
      const pending = original(...args);
      if (++calls === 2) joined.resolve();
      return pending;
    });
    h.hooks.beforeThumbTransform = async () => { entered.resolve(); await release.promise; };
    const server = h.app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const disconnected = deferred();
    const client = http.get(`http://127.0.0.1:${server.address().port}${url(asset)}`);
    client.once('error', disconnected.resolve);
    try {
      await entered.promise;
      const survivor = request(h.app).get(url(asset)).then(response => response);
      await joined.promise;
      client.destroy(); await disconnected.promise;
      release.resolve();
      expect((await survivor).status).toBe(200);
      expect(h.renditions.run).toHaveBeenCalledTimes(2);
    } finally {
      release.resolve(); client.destroy();
      await new Promise(resolve => server.close(resolve));
      await h.pool.run(() => {});
    }
  });
  it('repairs a corrupt derivative through the same complete-pair journal', async () => {
    const { asset } = h.add();
    const first = await get(asset);
    fs.writeFileSync(first.path, 'corrupt');
    const staged = h.hooks.onDerivativeStaged = vi.fn();
    const repaired = await get(asset);
    expect(repaired.revision).toBe(first.revision);
    expect(repaired.path).not.toBe(first.path);
    expect((await sharp(repaired.path).metadata()).format).toBe('webp');
    expect(h.renditions.run).toHaveBeenCalledTimes(3);
    expect(staged.mock.calls).toEqual([['thumbnail', 'reused'], ['preview', 'encoded']]);
    expect(counts()).toEqual([1, 0, 1, 2]);
  });
  it('refuses a corrupt canonical page without falling back to a later image', async () => {
    const { asset } = h.add(h.archive(Buffer.from('invalid first page')));
    expect((await request(h.app).get(url(asset))).status).toBe(422);
    expect(h.renditions.run).not.toHaveBeenCalled();
    expect(counts()).toEqual([1, 0, 0, 0]);
  });
  it('includes only supported comics in rebuild traversal and resets publications on restore', async () => {
    const comic = h.add().asset;
    const image = h.add(h.png, 'png', 'art.png').asset;
    h.add(h.archive(), 'zip', 'generic.zip');
    h.add(h.archive(), '7z', 'generic.7z');
    const repository = createGeneratedImageRebuildRepository(h.db, h.appMeta);
    expect(repository.page(0, 999).map(asset => asset.id)).toEqual([comic.id, image.id]);
    const rebuilt = await h.preview.ensureTargetGeneration(h.project.id, comic.id, h.settings.getPolicy());
    expect(rebuilt.cacheState).toBe('regenerated');
    resetGeneratedImagePublicationsForRestore(h.db);
    expect(h.publications.findPublication(h.project.id, comic.id)).toBeNull();
    expect((await get(comic)).cacheState).toBe('regenerated');
  });
  it('rebuilds through the existing FIFO when shared processing is busy', async () => {
    const { asset } = h.add(), gate = deferred(), proven = deferred();
    const occupied = h.pool.run(() => gate.promise);
    const run = h.pool.run.getMockImplementation();
    h.pool.run.mockImplementation(task => { const pending = run(task); proven.resolve(); return pending; });
    const repository = createGeneratedImageRebuildRepository(h.db, h.appMeta);
    const rebuild = createGeneratedImageRebuildService({ repository, imageSettings: h.settings,
      previewService: h.preview, maintenanceState: { active: false }, managedUploadTracker: createManagedUploadTracker() });
    try {
      rebuild.queueManual(); rebuild.signal();
      await proven.promise; await turn();
      expect(repository.get()).toMatchObject({ cursor: 0, attempted: 0, phase: 'running' });
      expect(h.renditions.run).not.toHaveBeenCalled();
      gate.resolve(); await occupied; await rebuild.waitForIdle();
      expect(repository.get()).toMatchObject({ phase: 'completed', succeeded: 1, failed: 0 });
      expect(h.publications.findPublication(h.project.id, asset.id)).not.toBeNull();
    } finally { gate.resolve(); rebuild.stop(); await occupied; }
  });
});

describe('final comic derivative authority', () => {
  const mutations = ['withdrawal', 'format', 'generation', 'policy', 'thumbnail-policy', 'stop', 'pause'];
  const deliveryMutations = [...mutations, 'same-tuple', 'catalogue', 'publication'];
  function mutate(asset, change) {
    if (change === 'withdrawal') h.db.prepare('UPDATE assets SET is_present = 0 WHERE id = ?').run(asset.id);
    if (change === 'format') h.db.prepare("UPDATE assets SET extension = 'cbr' WHERE id = ?").run(asset.id);
    if (change === 'generation') h.db.prepare('UPDATE assets SET source_generation = source_generation + 1 WHERE id = ?').run(asset.id);
    if (change === 'policy') h.appMeta.setValue('images.preview.max_dimension', '640');
    if (change === 'thumbnail-policy') h.appMeta.setValue('images.thumbnail.max_dimension', '128');
    if (change === 'stop') h.comic.stop();
    if (change === 'pause') {
      const maintenance = h.comic.pauseForMaintenance();
      maintenance.release();
    }
    if (change === 'publication') h.db.prepare('DELETE FROM generated_image_publications WHERE asset_id = ?').run(asset.id);
    if (change === 'same-tuple' || change === 'catalogue') {
      const full = path.join(h.directory, asset.relative_path), stat = fs.statSync(full);
      if (change === 'same-tuple') {
        const bytes = fs.readFileSync(full); bytes[bytes.length - 1] ^= 1;
        fs.writeFileSync(full, bytes);
      } else {
        fs.writeFileSync(full, makeZip([{ name: 'page1.png', data: h.png }, { name: 'page20.png', data: h.png }]));
      }
      fs.utimesSync(full, stat.atime, stat.mtime);
    }
  }
  const expectedStatus = change => change === 'withdrawal' ? 404 : ['stop', 'pause'].includes(change) ? 503 : 409;
  function refuse(response, status) {
    expect(response.status).toBe(status);
    expect(response.status).not.toBe(304);
    expect(response.headers).toMatchObject({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.text).not.toContain('RIFF');
  }
  function observeResult(number, callback) {
    const original = h.comic.startComicCoverSource;
    let scopes = 0, changed = false;
    h.comic.startComicCoverSource = (...args) => {
      const operation = original(...args);
      if (++scopes === number) void operation.result.then(() => { changed = true; callback(); }, () => {});
      return operation;
    };
    return () => expect(changed).toBe(true);
  }
  function watchStreams(onOpen) {
    const streams = [], original = fs.createReadStream;
    vi.spyOn(fs, 'createReadStream').mockImplementation((...args) => {
      const stream = original(...args);
      streams.push(stream);
      if (onOpen) stream.once('open', onOpen);
      return stream;
    });
    return async () => {
      for (const stream of streams) {
        if (!stream.closed) await new Promise(resolve => stream.once('close', resolve));
        expect(stream.destroyed).toBe(true);
        expect(stream.closed).toBe(true);
      }
      expect(streams.length).toBeGreaterThan(0);
    };
  }

  it.each(mutations.flatMap(change => ['thumbnail', 'preview'].map(kind => [change, kind])))('refuses the original pending HTTP handoff after %s on %s', async (change, kind) => {
    const { asset } = h.add();
    await get(asset);
    let changed = false;
    const unchangedHandleObserved = () => expect(changed).toBe(true);
    const streamsClosed = watchStreams(() => { changed = true; mutate(asset, change); });
    const response = await request(h.app).get(url(asset, kind)).set('If-None-Match', '*');
    unchangedHandleObserved();
    refuse(response, expectedStatus(change));
    await streamsClosed();
    expect(h.renditions.run).toHaveBeenCalledTimes(2);
  });

  it.each(mutations)('refuses cold success after the final R1 result: %s', async change => {
    const { asset } = h.add();
    const observed = observeResult(4, () => mutate(asset, change));
    const outcome = await get(asset).catch(error => error);
    observed();
    if (change === 'withdrawal') expect(outcome.name).toBe('PreviewNotFoundError');
    else expect(outcome.status).toBe(expectedStatus(change));
    expect(outcome.status).not.toBe('ready');
    await h.pool.run(() => {});
    expect(h.renditions.run).toHaveBeenCalledTimes(2);
    expect(counts()).toEqual([1, 0, 1, 2]);
  });

  it.each(deliveryMutations.flatMap(change => ['thumbnail', 'preview'].map(kind => [change, kind])))('refuses route commitment after prepared-stream %s on %s', async (change, kind) => {
    const { asset } = h.add();
    await get(asset);
    const entered = deferred(), release = deferred();
    const original = h.media.prepareDerivativeResponse;
    let prepared;
    vi.spyOn(h.media, 'prepareDerivativeResponse').mockImplementation(async (...args) => {
      prepared = await original(...args);
      entered.resolve();
      await release.promise;
      return prepared;
    });
    const pending = request(h.app).get(url(asset, kind)).set('If-None-Match', '*').then(response => response);
    await entered.promise;
    try { mutate(asset, change); } finally { release.resolve(); }
    refuse(await pending, expectedStatus(change));
    if (!prepared.stream.closed) await new Promise(resolve => prepared.stream.once('close', resolve));
    expect(prepared.stream.destroyed).toBe(true);
    expect(prepared.stream.closed).toBe(true);
  });

  it.each(deliveryMutations.flatMap(change => ['thumbnail', 'preview'].map(kind => [change, kind])))('revalidates %s after the awaited %s stream open', async (change, kind) => {
    const { asset } = h.add(); await get(asset);
    const original = fs.createReadStream;
    let stream;
    vi.spyOn(fs, 'createReadStream').mockImplementation((...args) => {
      stream = original(...args);
      stream.once('open', () => mutate(asset, change));
      return stream;
    });
    refuse(await request(h.app).get(url(asset, kind)).set('If-None-Match', '*'), expectedStatus(change));
    if (!stream.closed) await new Promise(resolve => stream.once('close', resolve));
    expect(stream.destroyed).toBe(true);
  });

  it.each(['withdrawal', 'policy', 'generation', 'stop'])('refuses every coalesced caller after the worker handoff: %s', async change => {
    const { asset } = h.add(), encoding = deferred(), encode = deferred(), entered = deferred(), release = deferred();
    h.hooks.beforeThumbTransform = async () => { encoding.resolve(); await encode.promise; };
    const original = h.pool.run.getMockImplementation();
    h.pool.run.mockImplementation(task => original(task).then(async result => {
      entered.resolve(); await release.promise; return result;
    }));
    const first = get(asset).catch(error => error);
    await encoding.promise;
    const joined = [get(asset).catch(error => error), get(asset).catch(error => error)];
    encode.resolve(); await entered.promise;
    mutate(asset, change); release.resolve();
    const outcomes = await Promise.all([first, ...joined]);
    for (const outcome of outcomes) {
      if (change === 'withdrawal') expect(outcome.name).toBe('PreviewNotFoundError');
      else expect(outcome.status).toBe(expectedStatus(change));
      expect(outcome.status).not.toBe('ready');
    }
    expect(h.renditions.run).toHaveBeenCalledTimes(2);
    expect(h.pool.run).toHaveBeenCalledTimes(1);
  });

  it('keeps each coalesced caller lifetime separate after successful interest removal', async () => {
    const { asset } = h.add(), entered = deferred(), release = deferred(), controller = new AbortController();
    h.hooks.beforeThumbTransform = async () => { entered.resolve(); await release.promise; };
    const first = get(asset, 'preview', { signal: controller.signal });
    await entered.promise;
    const survivor = get(asset);
    release.resolve();
    const [departing, current] = await Promise.all([first, survivor]);
    expect(departing.path).toBe(current.path);
    expect(departing).not.toBe(current);
    expect(() => h.preview.assertComicDerivativeCurrent(current)).not.toThrow();
    controller.abort();
    expect(() => h.preview.assertComicDerivativeCurrent(departing)).toThrow();
    expect(() => h.preview.assertComicDerivativeCurrent(current)).not.toThrow();
    expect(JSON.stringify(current)).not.toContain('graphAuthority');
  });

  it.each(['same-tuple', 'catalogue', 'publication'])('refuses %s replacement after prepared response without relabelling bytes', async change => {
    const { asset, full } = h.add(); await get(asset);
    const prepared = await h.media.prepareDerivativeResponse('preview', h.project.id, asset.id);
    try {
      if (change === 'publication') h.db.prepare('DELETE FROM generated_image_publications WHERE asset_id = ?').run(asset.id);
      else {
        const stat = fs.statSync(full);
        const bytes = fs.readFileSync(full);
        if (change === 'same-tuple') { bytes[bytes.length - 1] ^= 1; fs.writeFileSync(full, bytes); }
        else fs.writeFileSync(full, makeZip([{ name: 'page1.png', data: h.png }, { name: 'page10.png', data: h.png }, { name: 'page20.png', data: h.png }]));
        fs.utimesSync(full, stat.atime, stat.mtime);
      }
      expect(() => prepared.assertCurrent()).toThrow();
    } finally { prepared.cleanup(); }
    if (!prepared.stream.closed) await new Promise(resolve => prepared.stream.once('close', resolve));
    expect(prepared.stream.destroyed).toBe(true);
  });

  it('refuses caller cancellation and deadline expiry after stream preparation', async () => {
    const { asset } = h.add(); const controller = new AbortController();
    const prepared = await h.media.prepareDerivativeResponse('preview', h.project.id, asset.id, undefined, { signal: controller.signal });
    try {
      controller.abort();
      expect(() => prepared.assertCurrent()).toThrow();
    } finally { prepared.cleanup(); }
    const timed = await h.media.prepareDerivativeResponse('preview', h.project.id, asset.id);
    const clock = vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 30_001);
    try { expect(() => timed.assertCurrent()).toThrow(); }
    finally { clock.mockRestore(); timed.cleanup(); }
    for (const response of [prepared, timed]) if (!response.stream.closed) await new Promise(resolve => response.stream.once('close', resolve));
  });

  it('allows later current-authority regeneration after stale warm delivery refusal', async () => {
    const { asset } = h.add(); const first = await get(asset);
    const prepared = await h.media.prepareDerivativeResponse('preview', h.project.id, asset.id);
    h.appMeta.setValue('images.preview.max_dimension', '640');
    try { expect(() => prepared.assertCurrent()).toThrow(); } finally { prepared.cleanup(); }
    const current = await get(asset);
    expect(current.revision).not.toBe(first.revision);
    expect(current.width).toBe(640);
    const warm = await request(h.app).get(url(asset)).set('If-None-Match', '*');
    expect(warm.status).toBe(200);
    expect((await sharp(warm.body).metadata()).width).toBe(640);
    expect(h.renditions.run).toHaveBeenCalledTimes(3);
  });

  it('keeps ordinary Preview delivery independent of comic source authority', async () => {
    const { asset } = h.add(h.png, 'png', 'ordinary.png');
    vi.spyOn(h.preview, 'assertComicDerivativeCurrent').mockImplementation(() => { throw new Error('Unexpected comic authority'); });
    for (const kind of ['thumbnail', 'preview']) {
      const response = await request(h.app).get(url(asset, kind));
      expect(response.status).toBe(200);
      expect((await sharp(response.body).metadata()).format).toBe('webp');
    }
    expect(h.preview.assertComicDerivativeCurrent).not.toHaveBeenCalled();
    expect(h.comic.startComicCoverSource).not.toHaveBeenCalled();
  });
});

describe('comic Media Service Promise handoff', () => {
  it.each(['preview-result', 'stream-open'].flatMap(stage => ['thumbnail', 'preview'].map(kind => [stage, kind])))('refuses source withdrawal after %s for %s', async (stage, kind) => {
    const { asset } = h.add(); await get(asset);
    const method = kind === 'thumbnail' ? 'getThumbnail' : 'getPreview';
    const original = h.preview[method];
    let calls = 0, changed = false, prepared;
    vi.spyOn(h.preview, method).mockImplementation(async (...args) => {
      const result = await original(...args);
      if (++calls === 1 && stage === 'preview-result') {
        changed = true;
        h.db.prepare('UPDATE assets SET is_present = 0 WHERE id = ?').run(asset.id);
      }
      return result;
    });
    if (stage === 'stream-open') {
      const open = fs.createReadStream;
      vi.spyOn(fs, 'createReadStream').mockImplementation((...args) => {
        const stream = open(...args);
        stream.once('open', () => {
          changed = true;
          h.db.prepare('UPDATE assets SET is_present = 0 WHERE id = ?').run(asset.id);
        });
        return stream;
      });
    }
    const outcome = await h.media.prepareDerivativeResponse(kind, h.project.id, asset.id)
      .then(result => { prepared = result; return result; }, error => error);
    try {
      expect(changed).toBe(true);
      expect(outcome.status).toBe(404);
    } finally {
      prepared?.cleanup();
      if (prepared && !prepared.stream.closed) await new Promise(resolve => prepared.stream.once('close', resolve));
    }
  });
});

it('public settlement: real source-result microtasks cannot bypass the outer public Preview fence',async()=>{
 const {promiseHooks}=await import('node:v8');const {asset}=h.add();await get(asset);
 const original=h.comic.startComicCoverSource,rows=[];
 const later=(count,work)=>{if(!count)work();else queueMicrotask(()=>later(count-1,work));};
 for(let ticks=0;ticks<28;ticks++){
  let scopes=0,pending,settled=false,beforeSettlement,changed=false;const mutated=deferred();
  const stop=promiseHooks.createHook({settled(p){if(p===pending)settled=true;}});
  h.comic.startComicCoverSource=(...args)=>{const operation=original(...args);if(++scopes===1)void operation.result.then(()=>later(ticks,()=>{
   beforeSettlement=!settled;h.db.prepare('UPDATE assets SET is_present = 0 WHERE id = ?').run(asset.id);changed=true;mutated.resolve();
  }),()=>{});return operation;};
  let outcome;try{pending=get(asset);outcome=await pending.catch(error=>error);await mutated.promise;}finally{stop();}
  rows.push({ticks,scopes,changed,beforeSettlement,status:outcome.status||outcome.name});
  h.db.prepare('UPDATE assets SET is_present = 1 WHERE id = ?').run(asset.id);
 }
 console.log('QUEUED_SOURCE_HANDOFF',JSON.stringify(rows));
 expect(rows.every(row=>row.scopes===1&&row.changed)).toBe(true);
 const stale=rows.filter(row=>row.beforeSettlement&&row.status==='ready');
 console.log('STALE_BEFORE_PUBLIC_SETTLEMENT',JSON.stringify(stale));
 expect(stale).toEqual([]);
});


describe('public comic settlement and graph proof ownership', () => {
  const later = (count, work) => count ? queueMicrotask(() => later(count - 1, work)) : work();

  // Observe the actual production token Sets without replacing the R1 handles.
  function observeTokenOwners() {
    const tokens = new WeakSet(), owners = [];
    let peak = 0, scopes = 0;
    const original = h.comic.startComicCoverSource;
    h.comic.startComicCoverSource = (...args) => {
      const operation = original(...args);
      tokens.add(operation.graphAuthority);
      scopes++;
      return operation;
    };
    const add = Set.prototype.add;
    vi.spyOn(Set.prototype, 'add').mockImplementation(function(value) {
      const result = add.call(this, value);
      if (tokens.has(value)) {
        if (!owners.includes(this)) owners.push(this);
        peak = Math.max(peak, owners.reduce((sum, owner) => sum + owner.size, 0));
      }
      return result;
    });
    return { get peak() { return peak; }, get scopes() { return scopes; },
      get retained() { return owners.reduce((sum, owner) => sum + owner.size, 0); } };
  }

  const changes = ['withdrawal', 'format', 'generation', 'first-page', 'policy', 'thumbnail-policy',
    'stop', 'pause', 'cancel', 'deadline', 'supersession', 'target'];
  it.each(['cold', 'warm'].flatMap(cache => changes.map(change => [cache, change])))
  ('refuses %s public settlement after %s at the last handoff', async (cache, change) => {
    const { promiseHooks } = await import('node:v8');
    const { asset, full } = h.add(), controller = new AbortController();
    if (cache === 'warm') await get(asset);
    const owners = observeTokenOwners();
    let pending, settled = false, changed = false, beforeSettlement, afterProof = false, reads = 0, current = true;
    const original = h.comic.startComicCoverSource;
    h.comic.startComicCoverSource = (...args) => {
      const operation = original(...args);
      if (owners.scopes === (cache === 'warm' ? 1 : 4)) void operation.result.then(() => { afterProof = true; }, () => {});
      return operation;
    };
    const policy = h.settings.getPolicy;
    vi.spyOn(h.settings, 'getPolicy').mockImplementation(() => {
      const value = policy();
      if (afterProof && ++reads === 2) queueMicrotask(() => {
        beforeSettlement = !settled;
        if (change === 'withdrawal') h.db.prepare('UPDATE assets SET is_present = 0 WHERE id = ?').run(asset.id);
        if (change === 'format') h.db.prepare("UPDATE assets SET extension = 'cbr' WHERE id = ?").run(asset.id);
        if (change === 'generation') h.db.prepare('UPDATE assets SET source_generation = source_generation + 1 WHERE id = ?').run(asset.id);
        if (change === 'first-page') fs.writeFileSync(full, makeZip([{ name: 'page0.png', data: h.png }, { name: 'page1.png', data: h.png }]));
        if (change === 'policy') h.appMeta.setValue('images.preview.max_dimension', '640');
        if (change === 'thumbnail-policy') h.appMeta.setValue('images.thumbnail.max_dimension', '128');
        if (change === 'stop') h.comic.stop();
        if (change === 'pause') h.comic.pauseForMaintenance().release();
        if (change === 'cancel') controller.abort();
        if (change === 'deadline') vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 31_000);
        if (change === 'supersession') h.db.prepare('DELETE FROM generated_image_publications WHERE asset_id = ?').run(asset.id);
        if (change === 'target') current = false;
        changed = true;
      });
      return value;
    });
    const stop = promiseHooks.createHook({ settled(promise) { if (promise === pending) settled = true; } });
    let result;
    try {
      pending = get(asset, 'preview', { signal: controller.signal, isTargetAuthoritative: () => current });
      result = await pending.catch(error => error);
    } finally { stop(); }
    expect(changed).toBe(true);
    expect(beforeSettlement).toBe(true);
    expect(result.status).not.toBe('ready');
    if (change === 'withdrawal') expect(result.name).toBe('PreviewNotFoundError');
    else if (change === 'target') expect(result.name).toBe('PreviewGenerationError');
    else expect(result.status).toBe(['stop', 'pause', 'cancel', 'deadline'].includes(change) ? 503 : 409);
    expect(owners.retained).toBe(0);
    expect(h.renditions.run).toHaveBeenCalledTimes(2);
    expect(h.pool.run).toHaveBeenCalledTimes(1);
  });

  it.each(['getPreview', 'getThumbnail', 'ensureCurrentPreview', 'ensureTargetGeneration'])
  ('keeps current cold and warm %s results usable after proof cleanup', async method => {
    const { asset } = h.add(), owners = observeTokenOwners();
    const call = () => method === 'ensureTargetGeneration'
      ? h.preview[method](h.project.id, asset.id, h.settings.getPolicy())
      : h.preview[method](h.project.id, asset.id);
    for (let i = 0; i < 5; i++) {
      const result = await call();
      expect(result.status).toBe('ready');
      expect(() => h.preview.assertComicDerivativeCurrent(result.preview || result)).not.toThrow();
      expect(owners.retained).toBe(0);
    }
    expect(h.renditions.run).toHaveBeenCalledTimes(2);
    expect(owners.peak).toBeLessThanOrEqual(3);
  });

  it('bounds actual graph token ownership for 300 callers with at most three pending', async () => {
    const { asset } = h.add(), entered = deferred(), release = deferred(), owners = observeTokenOwners();
    const outcomes = [], churned = deferred(), awaitingProof = [], proofCallers = new WeakMap();
    let active = 0, peak = 0, calls = 0, rotating, observedActiveProof = false;
    const join = () => {
      const controller = new AbortController();
      const caller = { controller };
      awaitingProof.push(caller);
      calls++; active++; peak = Math.max(peak, active);
      const pending = get(asset, 'preview', { signal: controller.signal }).then(
        value => { active--; return value; }, error => { active--; return error; });
      outcomes.push(pending);
      if (calls === 300) churned.resolve();
      return Object.assign(caller, { pending });
    };
    h.hooks.beforeThumbTransform = async () => { entered.resolve(); await release.promise; };
    const original = h.comic.startComicCoverSource;
    h.comic.startComicCoverSource = (...args) => {
      const operation = original(...args), number = owners.scopes;
      const signal = args[2]?.signal;
      // A caller reuses its own proof signal; the admitted generation has a separate signal.
      if (signal && !proofCallers.has(signal) && awaitingProof.length) proofCallers.set(signal, awaitingProof.shift());
      if (number >= 3 && calls < 300 && rotating && proofCallers.get(signal) === rotating) void operation.result.then(() => {
        if (calls >= 300) return;
        observedActiveProof ||= owners.retained >= 2;
        const previous = rotating;
        rotating = join();
        previous.controller.abort();
        previous.controller.abort();
      }, () => {});
      return operation;
    };
    const anchor = join(); await entered.promise; rotating = join(); release.resolve();
    const result = await anchor.pending;
    await churned.promise;
    const all = await Promise.all(outcomes);
    expect(calls).toBe(300);
    expect(peak).toBeLessThanOrEqual(3);
    expect(active).toBe(0);
    expect(result.status).toBe('ready');
    expect(all.filter(value => value.status === 'ready')).toHaveLength(2);
    expect(all.filter(value => value.status === 503)).toHaveLength(298);
    expect(observedActiveProof).toBe(true);
    expect(owners.peak).toBeLessThanOrEqual(4);
    expect(owners.retained).toBe(0);
    expect(h.renditions.run).toHaveBeenCalledTimes(2);
    expect(h.pool.run).toHaveBeenCalledTimes(1);
    expect(() => h.preview.assertComicDerivativeCurrent(result)).not.toThrow();
    h.comic.stop();
    expect(() => h.preview.assertComicDerivativeCurrent(result)).toThrow();
    console.log('BOUNDED_TOKEN_CHURN', JSON.stringify({ calls, scopes: owners.scopes, peakPending: peak,
      peakOwnedTokens: owners.peak, finalOwnedTokens: owners.retained, deliveredProofTokens: 2 }));
  });

  it.each(['rejected', 'cancelled', 'deadline'])('releases repeated %s caller proofs', async mode => {
    const { asset } = h.add(); await get(asset);
    const owners = observeTokenOwners();
    const original = h.comic.startComicCoverSource;
    let invalidate;
    h.comic.startComicCoverSource = (...args) => {
      const operation = original(...args);
      void operation.result.then(() => invalidate(), () => {});
      return operation;
    };
    for (let i = 0; i < 10; i++) {
      const controller = new AbortController();
      let clock;
      invalidate = () => mode === 'rejected' ? h.db.prepare('UPDATE assets SET is_present = 0 WHERE id = ?').run(asset.id)
        : mode === 'cancelled' ? controller.abort()
        : clock = vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 31_000);
      const result = await h.preview.getPreview(h.project.id, asset.id,
        undefined, { signal: controller.signal }).catch(error => error);
      clock?.mockRestore();
      if (mode === 'rejected') h.db.prepare('UPDATE assets SET is_present = 1 WHERE id = ?').run(asset.id);
      expect(result.status).not.toBe('ready');
      await h.pool.run(() => {});
      expect(owners.retained).toBe(0);
    }
    expect(owners.peak).toBeLessThanOrEqual(2);
  });

  it('keeps a joined caller current when its peer leaves during the public handoff', async () => {
    const { asset } = h.add(), entered = deferred(), release = deferred(), controller = new AbortController();
    const owners = observeTokenOwners();
    h.hooks.beforeThumbTransform = async () => { entered.resolve(); await release.promise; };
    const first = get(asset, 'preview', { signal: controller.signal }).catch(error => error);
    await entered.promise;
    const second = get(asset);
    const original = h.comic.startComicCoverSource;
    h.comic.startComicCoverSource = (...args) => {
      const operation = original(...args);
      if (owners.scopes === 4) void operation.result.then(() => later(1, () => controller.abort()), () => {});
      return operation;
    };
    release.resolve();
    const [departed, survivor] = await Promise.all([first, second]);
    expect(departed.status).toBe(503);
    expect(survivor.status).toBe('ready');
    expect(owners.retained).toBe(0);
    expect(() => h.preview.assertComicDerivativeCurrent(survivor)).not.toThrow();
    h.comic.stop();
    expect(() => h.preview.assertComicDerivativeCurrent(survivor)).toThrow();
  });

  it('keeps delivered proof ownership isolated between two source graphs', async () => {
    const { asset } = h.add(), owners = observeTokenOwners(), original = h.comic;
    const first = await get(asset);
    const replacement = createComicMediaService({ previewService: h.preview, projectsRoot: h.projectsRoot,
      admission: h.admission, renditions: h.renditions });
    try {
      h.useComic(replacement);
      const second = await get(asset);
      expect(owners.retained).toBe(0);
      original.stop();
      expect(() => h.preview.assertComicDerivativeCurrent(first)).toThrow();
      expect(() => h.preview.assertComicDerivativeCurrent(second)).not.toThrow();
      replacement.stop();
      expect(() => h.preview.assertComicDerivativeCurrent(second)).toThrow();
    } finally { original.stop(); await original.pauseForMaintenance().waitForIdle(); }
  });

  it('coalesces callers independently across simultaneous projects and assets', async () => {
    const { asset } = h.add(), owners = observeTokenOwners();
    let project = h.projects.create({ title: 'Other', projectType: 'images', slug: 'other', description: '', notes: '',
      status: 'tbd', priority: 'normal', plannedDate: null, publishedDate: null, patreonUrl: null });
    const directory = path.join(h.projectsRoot, `${project.id}-other`); fs.mkdirSync(directory);
    project = h.projects.setProjectDir(project.id, path.basename(directory));
    bindTestProjectOwnership(h.db, project.id, directory);
    const filename = path.join(directory, 'book.cbz'); fs.writeFileSync(filename, h.archive());
    const stat = fs.statSync(filename);
    const other = h.assets.upsert(project.id, 'book.cbz', { filename: 'book.cbz', extension: 'cbz',
      mimeType: 'application/octet-stream', sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() });
    const entered = deferred(), release = deferred(), controller = new AbortController();
    let started = 0;
    h.hooks.beforeThumbTransform = async () => { if (++started === 2) entered.resolve(); await release.promise; };
    const first = get(asset, 'preview', { signal: controller.signal }).catch(error => error);
    const second = h.preview.getPreview(project.id, other.id);
    await entered.promise;
    const survivor = get(asset);
    controller.abort(); release.resolve();
    const [departed, independent, joined] = await Promise.all([first, second, survivor]);
    expect(departed.status).toBe(503);
    expect(independent.status).toBe('ready'); expect(joined.status).toBe('ready');
    expect(independent.path).not.toBe(joined.path);
    expect(owners.retained).toBe(0);
    expect(() => h.preview.assertComicDerivativeCurrent(independent)).not.toThrow();
    expect(() => h.preview.assertComicDerivativeCurrent(joined)).not.toThrow();
    expect(h.renditions.run).toHaveBeenCalledTimes(4);
    expect(h.pool.run).toHaveBeenCalledTimes(2);
  });
});


describe('common comic delivery and reuse', () => {
  it('closes the abandoned stream after final response refusal', async () => {
    const { asset } = h.add(); await get(asset);
    const original = h.media.prepareDerivativeResponse;
    let prepared;
    vi.spyOn(h.media, 'prepareDerivativeResponse').mockImplementation(async (...args) => {
      prepared = await original(...args);
      h.db.prepare('UPDATE assets SET is_present = 0 WHERE id = ?').run(asset.id);
      return prepared;
    });
    try {
      const response = await request(h.app).get(url(asset)).set('If-None-Match', '*');
      expect(response.status).toBe(404);
      expect(response.status).not.toBe(304);
      expect(prepared.stream.destroyed).toBe(true);
    } finally {
      prepared?.stream.destroy();
      if (prepared && !prepared.stream.closed) await new Promise(resolve => prepared.stream.once('close', resolve));
    }
  });

  it.each(['thumbnail', 'preview'])('resolves exactly one %s per HTTP request with ordinary revision cache policy', async kind => {
    const { asset } = h.add(); const current = await get(asset, kind);
    const method = kind === 'thumbnail' ? 'getThumbnail' : 'getPreview';
    const resolve = vi.spyOn(h.preview, method);
    const sourceHint = buildAssetRevisionToken(asset);
    const policyHint = buildAssetRevisionToken(asset, projectImagePolicyFingerprint(h.settings.getPolicy(), asset));
    expect(sourceHint).not.toBe(current.revision);
    expect(policyHint).not.toBe(current.revision);
    for (const revision of [undefined, '0123456789abcdef', sourceHint, policyHint, current.revision]) {
      resolve.mockClear();
      const response = await request(h.app).get(url(asset, kind) + (revision ? `?v=${revision}` : ''))
        .set('If-None-Match', `W/"${current.revision}-${current.bytes}"`);
      expect(response.status).toBe(200);
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(response.body).toEqual(fs.readFileSync(current.path));
      expect(response.headers['cache-control']).toBe(revision === current.revision
        ? 'private, max-age=31536000, immutable' : 'private, max-age=0, must-revalidate');
      expect(response.headers.etag).toBe(revision === current.revision ? `W/"${current.revision}-${current.bytes}"` : undefined);
    }
    expect((await request(h.app).get(url(asset) + '?member=page1.png')).status).toBe(400);
    expect((await request(h.app).get(url(asset) + '?sourceRevision=0123456789abcdef')).status).toBe(400);
  });

  it('treats old source and policy presentation revisions as hints while returning current authorized pixels', async () => {
    const { asset } = h.add();
    const hint = () => {
      const current = h.assets.findById(asset.id);
      return buildAssetRevisionToken(current, projectImagePolicyFingerprint(h.settings.getPolicy(), current));
    };
    const oldHint = hint(), first = await get(asset);
    h.appMeta.setValue('images.preview.max_dimension', '640');
    expect(hint()).not.toBe(oldHint);
    const policyHint = hint();
    h.db.prepare('UPDATE assets SET source_generation = source_generation + 1 WHERE id = ?').run(asset.id);
    expect(hint()).not.toBe(policyHint);
    const response = await request(h.app).get(url(asset) + `?v=${oldHint}`).set('If-None-Match', `W/"${first.revision}-${first.bytes}"`);
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('private, max-age=0, must-revalidate');
    expect(response.headers.etag).toBeUndefined();
    expect((await sharp(response.body).metadata()).width).toBe(640);
    expect(response.body).not.toEqual(fs.readFileSync(first.path));
    h.db.prepare('UPDATE assets SET is_present = 0 WHERE id = ?').run(asset.id);
    expect((await request(h.app).get(url(asset) + `?v=${oldHint}`).set('If-None-Match', '*')).status).toBe(404);
  });

  it('serves a valid warm HTTP cover under full generation capacity without original or prepared reads', async () => {
    const { asset } = h.add(); const first = await get(asset);
    const read = h.sourceHooks.afterRead = vi.fn(), prepared = h.sourceHooks.preparedRead = vi.fn();
    const entered = deferred(), gate = deferred();
    const occupied = h.pool.run(async () => { entered.resolve(); await gate.promise; });
    await entered.promise;
    h.pool.run.mockClear(); h.pool.tryRun.mockClear(); h.renditions.run.mockClear();
    try {
      const response = await request(h.app).get(url(asset) + `?v=${first.revision}`);
      expect(response.status).toBe(200);
      expect(response.body).toEqual(fs.readFileSync(first.path));
      expect(read).not.toHaveBeenCalled(); expect(prepared).not.toHaveBeenCalled();
      expect(h.renditions.run).not.toHaveBeenCalled();
      expect(h.pool.run).not.toHaveBeenCalled(); expect(h.pool.tryRun).not.toHaveBeenCalled();
    } finally { gate.resolve(); await occupied; }
  });

  it.each(['preview', 'thumbnail'])('copies the unchanged derivative when only %s policy changes', async changed => {
    const { asset } = h.add(); const first = await get(asset);
    const unaffected = changed === 'preview' ? 'thumbnail' : 'preview';
    const old = await get(asset, unaffected), oldBytes = fs.readFileSync(old.path);
    h.appMeta.setValue(`images.${changed}.webp_quality`, '61');
    const staged = h.hooks.onDerivativeStaged = vi.fn();
    const reads = h.sourceHooks.afterRead = vi.fn();
    h.renditions.run.mockClear(); h.pool.run.mockClear();
    const current = await get(asset), copied = await get(asset, unaffected);
    expect(current.revision).not.toBe(first.revision);
    expect(current.inputFingerprint).toBe(first.inputFingerprint);
    expect(copied.path).not.toBe(old.path);
    expect(fs.readFileSync(copied.path)).toEqual(oldBytes);
    expect(staged.mock.calls).toEqual([['thumbnail', changed === 'thumbnail' ? 'encoded' : 'reused'],
      ['preview', changed === 'preview' ? 'encoded' : 'reused']]);
    expect(h.renditions.run).toHaveBeenCalledTimes(1);
    expect(h.renditions.run.mock.calls[0][0].kind).toBe(changed);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(h.pool.run).toHaveBeenCalledTimes(1);
    expect(counts()).toEqual([1, 0, 1, 2]);
  });

  it.each(['generation', 'fingerprint', 'force'])('encodes the complete pair for changed %s authority', async reason => {
    const { asset, full } = h.add(); const first = await get(asset);
    if (reason === 'generation') h.db.prepare('UPDATE assets SET source_generation = source_generation + 1 WHERE id = ?').run(asset.id);
    if (reason === 'fingerprint') {
      fs.writeFileSync(full, makeZip([{ name: 'page1.png', data: h.png }, { name: 'page20.png', data: h.png }]));
      const stat = fs.statSync(full);
      h.db.prepare('UPDATE assets SET size_bytes = ?, modified_at = ? WHERE id = ?').run(stat.size, stat.mtime.toISOString(), asset.id);
    }
    const staged = h.hooks.onDerivativeStaged = vi.fn(); h.renditions.run.mockClear();
    const current = reason === 'force'
      ? (await h.preview.ensureTargetGeneration(h.project.id, asset.id, h.settings.getPolicy(), () => true, { force: true })).preview
      : await get(asset);
    expect(current.status).toBe('ready');
    if (reason !== 'force') expect(current.revision).not.toBe(first.revision);
    if (reason === 'fingerprint') expect(current.inputFingerprint).not.toBe(first.inputFingerprint);
    expect(staged.mock.calls).toEqual([['thumbnail', 'encoded'], ['preview', 'encoded']]);
    expect(h.renditions.run).toHaveBeenCalledTimes(2);
    expect(counts()).toEqual([1, 0, 1, 2]);
  });

  it('honors the caller deadline across derivative stream opening', async () => {
    const { asset } = h.add(); await get(asset);
    const deadlineAt = performance.now() + 1000;
    const original = fs.createReadStream;
    vi.spyOn(fs, 'createReadStream').mockImplementation((...args) => {
      const stream = original(...args);
      stream.once('open', () => vi.spyOn(performance, 'now').mockReturnValue(deadlineAt + 1));
      return stream;
    });
    await expect(h.media.prepareDerivativeResponse('preview', h.project.id, asset.id, undefined, { deadlineAt }))
      .rejects.toMatchObject({ status: 503 });
  });
});
