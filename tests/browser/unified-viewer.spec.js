import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { build } from 'vite';
import yazl from 'yazl';
import { createApplicationContext } from '../../src/app-context.js';
import { createBackupService } from '../../src/services/backup-service.js';
import { createAssetManifest } from '../../src/asset-manifest.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';
import { createReleaseService } from '../../src/services/release-service.js';
import { createComicRuntime } from '../../src/services/comic-runtime.js';
import { defaultComicPreparationCacheRoot } from '../../src/services/comic-preparation-cache.js';
import { makeZip } from '../helpers/zip-fixture.js';

// Cross-host integration qualification of the unified viewer
// against the COMPILED production client (a scratch Vite build in a temporary
// root). Every page here loads only the built bundle, so the controller is
// reached through the dialog it is bound to, never by importing raw modules.
//
// It qualifies contracts across host pages:
// one shared viewer behind all six image hosts; single-image thumbnails
// everywhere and explicit slideshows only on Project Assets and the Asset
// Library, with complete filtered server membership; no legacy slideshow;
// bounded timers, listeners, object URLs and requests across repeated
// viewing; session-bound reconciliation of authoritative refreshes; focus and
// fullscreen on distinct page types; untouched project/release workflows; and
// video/comic separation. The per-host suites keep their detailed coverage.
//
// Everything (database, projects, previews, compiled client) lives in a
// temporary root removed afterwards.

const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DIALOG = '#unified-viewer-dialog';
const VIDEO_DIALOG = '#asset-video-preview-dialog';
const LIBRARY = '/asset-viewer';
const MEDIA_FETCH = /\/projects\/\d+\/assets\/\d+\/(preview|original)(\?|$)/;

let server;
let db;
let app;
let root;
let projectsRoot;
let baseURL;
let releaseService;
let runtime;
let comicCacheRoot;
let compiledManifest;
let appContext;
let backupService;

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-unified-viewer-compiled-'));
  projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  const viteDistRoot = path.join(root, 'client');
  const previewRoot = path.join(root, 'previews');
  fs.mkdirSync(projectsRoot);
  fs.mkdirSync(appDataRoot);
  fs.mkdirSync(previewRoot);
  await build({ root: PROJECT_ROOT, configFile: path.join(PROJECT_ROOT, 'vite.config.js'),
    build: { outDir: viteDistRoot }, logLevel: 'silent' });
  compiledManifest = JSON.parse(fs.readFileSync(path.join(viteDistRoot, '.vite', 'manifest.json'), 'utf8'));
  db = openDatabase(path.join(root, 'test.db'));
  runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
  const { csrfPepper } = ensureAuthEnablement(appDataRoot);
  comicCacheRoot = defaultComicPreparationCacheRoot(appDataRoot);
  runtime = createComicRuntime({ appDataRoot, projectsRoot, cacheOptions: { settleMs: 0 } });
  await runtime.start();
  backupService = createBackupService({ appDataRoot, databasePath: path.join(root, 'test.db'),
    migrationsDir: fileURLToPath(new URL('../../migrations', import.meta.url)) });
  appContext = createApplicationContext({ appName: 'CreatorCrate', projectsRoot, previewRoot, appOpts: {
    appDataRoot, databasePath: path.join(root, 'test.db'), migrationsDir: fileURLToPath(new URL('../../migrations', import.meta.url)),
    backupService, maintenanceState: { active: false }, authState: { csrfPepper }, comicRuntime: runtime, useViteAssets: true, viteDistRoot,
    assetManifest: createAssetManifest({ distRoot: viteDistRoot,
      manifestPath: path.join(viteDistRoot, '.vite', 'manifest.json') }),
  } }, db);
  app = appContext.app;
  server = (await import('node:http')).createServer(appContext.handleRequest).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
  releaseService = createReleaseService({ db });
});

test.afterAll(async () => {
  try {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    appContext?.releaseNotificationRuntime.stop();
    await appContext?.releaseNotificationRuntime.waitForIdle();
    await appContext?.processingJobService.waitForIdle();
    if (app) {
      const comicPause = app.locals.comicMediaService?.pauseForMaintenance();
      const services = ['generatedImageRebuildService', 'generatedImagePublicationLifecycle', 'projectOwnershipAdoption', 'legacyManifestCleanup'];
      for (const name of services) app.locals[name]?.stop();
      app.locals.comicMediaService?.stop();
      await Promise.all([...services.map((name) => app.locals[name]?.waitForIdle()), comicPause?.waitForIdle()]);
    }
  } finally {
    try { if (runtime) await runtime.close(); }
    finally {
      try {
        if (comicCacheRoot) fs.rmSync(comicCacheRoot, { recursive: true, force: true });
        if (db?.open) closeDatabase(db);
      }
      finally { if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); }
    }
  }
});

function image(width, height, shade, format) {
  const base = sharp({ create: { width, height, channels: 3, background: { r: shade, g: 80, b: 170 } } });
  if (format === 'jpeg') return base.jpeg().toBuffer();
  if (format === 'webp') return base.webp().toBuffer();
  if (format === 'gif') return base.gif().toBuffer();
  return base.png().toBuffer();
}

function kritaArchive(merged) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from('application/x-krita'), 'mimetype', { compress: false });
    zip.addBuffer(merged, 'mergedimage.png');
    zip.end();
    const chunks = [];
    zip.outputStream.on('data', (chunk) => chunks.push(chunk));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
  });
}

// Project A: a large portrait PNG, a large landscape JPEG, a WebP, a GIF, a
// preview-only Krita image, `dup-N.png` (same filename as in project B), a
// video, a CBZ comic and a text file. Two releases of A share 01-portrait.png.
let fixtureCount = 0;
async function createFixture() {
  fixtureCount += 1;
  const n = fixtureCount;
  const dup = `dup-${n}.png`;
  const a = app.locals.projectService.create({ title: `Cross A ${n}`, status: 'tbd' });
  const b = app.locals.projectService.create({ title: `Cross B ${n}`, status: 'tbd' });
  const dirA = path.join(projectsRoot, a.project_dir);
  const dirB = path.join(projectsRoot, b.project_dir);
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });
  const writeA = async (name, buffer) => fs.writeFileSync(path.join(dirA, name), await buffer);
  await writeA('01-portrait.png', image(600, 1200, 20, 'png'));
  await writeA('02-landscape.jpg', image(1400, 700, 60, 'jpeg'));
  await writeA('03-photo.webp', image(320, 320, 100, 'webp'));
  await writeA('04-still.gif', image(120, 120, 140, 'gif'));
  await writeA('05-paint.kra', kritaArchive(await image(80, 60, 180, 'png')));
  await writeA(dup, image(64, 64, 210, 'png'));
  fs.writeFileSync(path.join(dirA, 'clip.mp4'), Buffer.from('not really a video'));
  fs.writeFileSync(path.join(dirA, 'book.cbz'), makeZip([
    { name: '01.png', data: await image(120, 180, 40, 'png') },
    { name: '02.png', data: await image(120, 180, 80, 'png') },
    { name: '03.png', data: await image(120, 180, 120, 'png') },
  ]));
  fs.writeFileSync(path.join(dirA, 'notes.txt'), 'notes');
  fs.writeFileSync(path.join(dirB, dup), await image(64, 64, 240, 'png'));
  app.locals.assetScanner.scanProjectAssets(a.id);
  app.locals.assetScanner.scanProjectAssets(b.id);
  const idIn = (projectId) => (name) => String(db.prepare('SELECT id FROM assets WHERE project_id = ? AND relative_path = ?')
    .get(projectId, name)?.id);
  const id = idIn(a.id);
  const mixed = releaseService.createReleaseWithSelectedAssets(a.id, { title: `Mixed ${n}` },
    ['02-landscape.jpg', '01-portrait.png', 'clip.mp4', 'book.cbz', '05-paint.kra'].map((name) => Number(id(name))));
  const second = releaseService.createReleaseWithSelectedAssets(a.id, { title: `Second ${n}` },
    ['01-portrait.png', dup].map((name) => Number(id(name))));
  return {
    a: String(a.id),
    b: String(b.id),
    dup,
    id,
    idB: idIn(b.id),
    mixed: String(mixed.id),
    second: String(second.id),
    images: ['01-portrait.png', '02-landscape.jpg', '03-photo.webp', '04-still.gif', '05-paint.kra', dup],
    async addImages(count) {
      const added = [];
      for (let index = 0; index < count; index += 1) {
        const name = `fill-${String(index).padStart(2, '0')}.png`;
        fs.writeFileSync(path.join(dirA, name), await image(48, 32, index * 20, 'png'));
        added.push(name);
      }
      app.locals.assetScanner.scanProjectAssets(a.id);
      this.images.push(...added);
    },
    async rewrite(name) {
      fs.writeFileSync(path.join(dirA, name), await image(500, 1000, 250, 'png'));
      app.locals.assetScanner.scanProjectAssets(a.id);
    },
  };
}

// Instrumentation installed before any page script: object URLs, fetches,
// playback-length timers and document/window listeners are counted so the
// compiled viewer's resource ownership can be observed from outside.
function installProbe() {
  if (window.__probe) return;
  const probe = { objectUrls: new Map(), fetches: [], timers: new Map(), listeners: new Map() };
  window.__probe = probe;
  const create = URL.createObjectURL.bind(URL);
  const revoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = (blob) => {
    const url = create(blob);
    probe.objectUrls.set(url, blob?.type || '');
    return url;
  };
  URL.revokeObjectURL = (url) => {
    probe.objectUrls.delete(url);
    return revoke(url);
  };
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const record = { url, method: (init.method || 'GET').toUpperCase(), signal: init.signal || null, settled: false };
    probe.fetches.push(record);
    const pending = realFetch(input, init);
    pending.then(async (response) => {
      try { await response.clone().arrayBuffer(); } catch { /* aborted or consumed */ }
      record.settled = true;
    }, () => { record.settled = true; });
    return pending;
  };
  const realSet = window.setTimeout.bind(window);
  const realClear = window.clearTimeout.bind(window);
  window.setTimeout = (callback, delay, ...rest) => {
    let id = 0;
    const tracked = [2000, 4000, 6000].includes(Number(delay));
    id = realSet((...args) => {
      probe.timers.delete(id);
      if (typeof callback === 'function') callback(...args);
    }, delay, ...rest);
    if (tracked) probe.timers.set(id, Number(delay));
    return id;
  };
  window.clearTimeout = (id) => {
    probe.timers.delete(id);
    return realClear(id);
  };
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  const keyOf = (target, type, options) => {
    const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
    return `${target === window ? 'window' : 'document'}:${type}:${capture}`;
  };
  EventTarget.prototype.addEventListener = function patchedAdd(type, listener, options) {
    if ((this === window || this === document) && listener && !(typeof options === 'object' && options?.once)) {
      const key = keyOf(this, type, options);
      if (!probe.listeners.has(key)) probe.listeners.set(key, new Set());
      probe.listeners.get(key).add(listener);
    }
    return add.call(this, type, listener, options);
  };
  EventTarget.prototype.removeEventListener = function patchedRemove(type, listener, options) {
    if (this === window || this === document) probe.listeners.get(keyOf(this, type, options))?.delete(listener);
    return remove.call(this, type, listener, options);
  };
}

async function open(page, url, { viewport = { width: 1280, height: 900 } } = {}) {
  const control = { mutations: [], errors: [], comic: [], dialogs: [], assetErrors: [] };
  page.on('requestfailed', (request) => {
    if (new URL(request.url()).pathname.startsWith('/vite/')) control.assetErrors.push(request.url());
  });
  page.on('response', (response) => {
    if (new URL(response.url()).pathname.startsWith('/vite/') && response.status() >= 400) control.assetErrors.push(response.url());
  });
  page.on('pageerror', (error) => control.errors.push(error.message));
  page.on('request', (request) => {
    if (request.method() !== 'GET') control.mutations.push(`${request.method()} ${request.url()}`);
    if (/\/comic(\/|$|\?)/.test(new URL(request.url()).pathname)) control.comic.push(request.url());
  });
  await page.addInitScript(installProbe);
  await page.setViewportSize(viewport);
  await page.goto(`${baseURL}${url}`);
  await page.waitForFunction(() => Boolean(document.getElementById('unified-viewer-dialog')?.__creatorCrateUnifiedViewer));
  await page.evaluate(() => { window.__sameDocument = true; });
  return control;
}

// The page's one controller, read from the dialog it is bound to.
async function viewerState(page) {
  return page.evaluate(() => {
    const viewer = document.getElementById('unified-viewer-dialog').__creatorCrateUnifiedViewer;
    const state = viewer.getState();
    const media = viewer.media.getState();
    const playback = viewer.playback.getState();
    return {
      open: state.open,
      session: state.session,
      key: state.key,
      sourceKey: state.source?.key ?? null,
      mode: state.source?.mode ?? null,
      slideshow: state.source?.slideshow ?? null,
      wrap: state.source?.wrap ?? null,
      titles: state.source ? state.source.items.map((item) => item.title) : [],
      keys: state.source ? state.source.items.map((item) => item.key) : [],
      count: state.count,
      mediaUrl: state.item?.mediaUrl ?? null,
      originalUrl: state.item?.originalUrl ?? null,
      revision: state.item?.revision ?? null,
      media: { status: media.status, width: media.width, height: media.height, error: media.error },
      original: media.original?.status ?? null,
      quality: media.quality,
      playback: { available: playback.available, playing: playback.playing, speed: playback.speed, scheduled: playback.scheduled, pauseReason: playback.pauseReason },
      fullscreenElement: document.fullscreenElement
        ? (document.fullscreenElement.matches('[data-unified-viewer-card]') ? 'card' : 'other')
        : null,
    };
  });
}

// What the probe saw: live image object URLs, outstanding viewer media
// fetches, scheduled playback timers and net document/window listeners.
async function resources(page) {
  return page.evaluate((pattern) => {
    const probe = window.__probe;
    const media = new RegExp(pattern);
    const viewerFetches = probe.fetches.filter((record) => media.test(record.url));
    const listeners = {};
    for (const [key, set] of probe.listeners) if (set.size) listeners[key] = set.size;
    return {
      imageObjectUrls: [...probe.objectUrls.values()].filter((type) => type.startsWith('image/')).length,
      mediaFetches: viewerFetches.length,
      mediaUrls: viewerFetches.map((record) => record.url),
      outstanding: viewerFetches.filter((record) => !record.settled && !record.signal?.aborted).length,
      timers: [...probe.timers.values()],
      listeners,
      shownImages: document.querySelectorAll('#unified-viewer-dialog [data-unified-viewer-media] img').length,
    };
  }, MEDIA_FETCH.source);
}

// Shell invariants shared by every host page: one compiled bundle, one
// viewer dialog bound to one controller, no legacy slideshow scaffold.
async function pageShell(page) {
  return page.evaluate(() => {
    const dialog = document.getElementById('unified-viewer-dialog');
    const viewer = dialog?.__creatorCrateUnifiedViewer;
    return {
      viewerDialogs: document.querySelectorAll('#unified-viewer-dialog, [data-unified-viewer]').length,
      moduleScripts: Array.from(document.querySelectorAll('script[type="module"]')).map((script) => new URL(script.src).pathname),
      rawEntry: document.querySelectorAll('script[src="/creatorcrate.js"]').length,
      legacyScaffold: document.querySelectorAll('[data-slideshow-scaffold], [data-slideshow-trigger], [data-slideshow-preview], [data-slideshow-ui-focused]').length,
      outsideMain: Boolean(dialog) && !document.getElementById('main-content')?.contains(dialog),
      controllerApi: viewer ? Object.keys(viewer).sort() : [],
      slideshowTriggers: document.querySelectorAll('[data-project-assets-slideshow-trigger], [data-asset-library-slideshow-trigger]').length,
      openDialogs: Array.from(document.querySelectorAll('dialog[open]')).map((node) => node.id),
    };
  });
}

const title = (page) => page.locator(`${DIALOG} [data-unified-viewer-title]`);
const position = (page) => page.locator(`${DIALOG} [data-unified-viewer-position]`);
const shownImage = (page) => page.locator(`${DIALOG} [data-unified-viewer-media] img.unified-viewer-image:not([hidden])`);
const closeButton = (page) => page.locator(`${DIALOG} [data-dialog-close]`);
const retry = (page) => page.locator(`${DIALOG} [data-unified-viewer-retry]`);

async function closeViewer(page) {
  await closeButton(page).click();
  await expect(page.locator(DIALOG)).toBeHidden();
}

async function loaded(page) {
  await expect(shownImage(page)).toBeVisible();
  await expect.poll(async () => (await viewerState(page)).media.status).toBe('loaded');
}

// Each host's eligible image trigger for one asset.
const HOSTS = {
  projectAssets: (f) => ({
    url: `/projects/${f.a}/assets?view=grid&sort=filename&order=asc`,
    trigger: (page, assetId) => page.locator(`a[data-project-assets-preview-id="${assetId}"]`),
    slideshow: 1,
    sourceKey: `project-assets:${f.a}`,
  }),
  library: (f) => ({
    url: `${LIBRARY}?view=grid&project=${f.a}&sort=filename&order=asc`,
    trigger: (page, assetId) => page.locator(`a[data-asset-library-preview-id="${assetId}"][data-asset-library-preview-project-id="${f.a}"]`),
    slideshow: 1,
    sourceKey: null,
  }),
  assetDetails: (f, assetId) => ({
    url: `/projects/${f.a}/assets/${assetId}`,
    trigger: (page) => page.locator('[data-asset-details-viewer-trigger]'),
    slideshow: 0,
    sourceKey: null,
  }),
  releaseAssets: (f) => ({
    url: `/releases/${f.mixed}/assets?selection=all&view=grid&pageSize=all`,
    trigger: (page, assetId) => page.locator(`[data-release-assets-live-region] a[data-release-assets-viewer-trigger][data-viewer-asset="${assetId}"]`),
    slideshow: 0,
    sourceKey: null,
  }),
  releaseDetail: (f) => ({
    url: `/releases/${f.mixed}`,
    trigger: (page, assetId) => page.locator(`[data-selected-assets] a[data-release-detail-viewer-trigger][data-viewer-asset="${assetId}"]`),
    slideshow: 0,
    sourceKey: null,
  }),
  projectDetail: (f) => ({
    url: `/projects/${f.a}`,
    trigger: (page, assetId) => page.locator(`.project-detail-releases a[data-project-detail-viewer-trigger][data-viewer-release="${f.mixed}"][data-viewer-asset="${assetId}"]`),
    slideshow: 0,
    sourceKey: `project-detail:${f.a}:release:${f.mixed}`,
  }),
};

test('scenarios B + H: all six hosts open only the clicked image in the one compiled viewer; no legacy slideshow', async ({ page }) => {
  test.setTimeout(180_000);
  const f = await createFixture();
  const landscape = f.id('02-landscape.jpg');
  const results = {};
  let controllerApi = null;
  let bundle = null;

  for (const [name, describe] of Object.entries(HOSTS)) {
    const host = describe(f, landscape);
    const control = await open(page, host.url);
    const shell = await pageShell(page);
    // One bundle, one dialog, one controller with the same API, no legacy.
    expect(shell.viewerDialogs, name).toBe(2);
    expect(shell.rawEntry, name).toBe(0);
    expect(shell.moduleScripts.length, name).toBe(1);
    expect(shell.moduleScripts[0], name).toMatch(/^\/vite\/assets\/.+\.js$/);
    bundle ??= shell.moduleScripts[0];
    expect(shell.moduleScripts[0], name).toBe(bundle);
    expect(shell.legacyScaffold, name).toBe(0);
    expect(shell.outsideMain, name).toBe(true);
    controllerApi ??= shell.controllerApi;
    expect(shell.controllerApi, name).toEqual(controllerApi);
    // Explicit slideshow entry points only on Project Assets and the Library.
    expect(shell.slideshowTriggers, name).toBe(host.slideshow);

    const href = page.url();
    const historyLength = await page.evaluate(() => history.length);
    const trigger = host.trigger(page, landscape);
    await expect(trigger, name).toHaveCount(1);
    await trigger.scrollIntoViewIfNeeded();
    await trigger.click();
    await expect(page.locator(DIALOG), name).toBeVisible();
    await expect(title(page), name).toHaveText('02-landscape.jpg');
    await loaded(page);
    const state = await viewerState(page);
    results[name] = state;
    // Only its clicked image: single mode, no sequence, no playback.
    expect(state, name).toMatchObject({ open: true, mode: 'single', slideshow: false, count: 1, titles: ['02-landscape.jpg'] });
    expect(state.key, name).toBe(`p:${f.a}|a:${landscape}`);
    if (host.sourceKey) expect(state.sourceKey, name).toBe(host.sourceKey);
    expect(state.playback, name).toMatchObject({ available: false, playing: false, scheduled: false });
    await expect(page.locator(`${DIALOG} [data-unified-viewer-controls]`), name).toBeHidden();
    await expect(page.locator(`${DIALOG} [data-unified-viewer-playback]`), name).toBeHidden();
    expect((await pageShell(page)).openDialogs, name).toEqual(['unified-viewer-dialog']);
    // Aspect-preserving Fit of a large landscape image.
    const box = await shownImage(page).boundingBox();
    expect(Math.abs(box.width / box.height - 2), name).toBeLessThan(0.05);
    const stage = await page.locator(`${DIALOG} [data-unified-viewer-stage]`).boundingBox();
    expect(box.width, name).toBeLessThanOrEqual(stage.width + 1);
    expect(box.height, name).toBeLessThanOrEqual(stage.height + 1);
    // Arrow keys never step a single image.
    await page.keyboard.press('ArrowRight');
    expect((await viewerState(page)).key, name).toBe(state.key);

    await closeViewer(page);
    await expect(trigger, name).toBeFocused();
    await expect(page.locator('body'), name).not.toHaveClass(/app-dialog-open/);
    expect(page.url(), name).toBe(href);
    expect(await page.evaluate(() => history.length), name).toBe(historyLength);
    expect(await page.evaluate(() => window.__sameDocument), name).toBe(true);
    expect(control.mutations, name).toEqual([]);
    expect(control.errors, name).toEqual([]);
    expect(control.comic, name).toEqual([]);
  }

  // Every host resolved the same asset to the same server media.
  const mediaUrls = new Set(Object.values(results).map((state) => state.mediaUrl.split('?')[0]));
  expect([...mediaUrls]).toEqual([`/projects/${f.a}/assets/${landscape}/preview`]);
});

test('scenario A: Project Assets and Asset Library slideshows hold complete filtered server sequences', async ({ page }) => {
  test.setTimeout(150_000);
  const f = await createFixture();
  const clip = f.id('clip.mp4');
  const comic = f.id('book.cbz');

  // Project Assets: two cards per page, the slideshow holds every image.
  let control = await open(page, `/projects/${f.a}/assets?view=grid&pageSize=2&sort=filename&order=asc`);
  await expect(page.locator('a[data-project-assets-preview-id]')).toHaveCount(2);
  const portrait = f.id('01-portrait.png');
  // A pending selection draft stays as it is around the slideshow.
  await page.locator(`label[for$="-select-${f.id('02-landscape.jpg')}"]`).click();
  const entries = await page.evaluate(() => JSON.parse(document.querySelector('[data-project-assets-viewer-sequence]').textContent));
  const expected = [...f.images].sort();
  expect(entries.map((entry) => entry.filename)).toEqual(expected);
  expect(entries.map((entry) => String(entry.id))).not.toContain(clip);
  expect(entries.map((entry) => String(entry.id))).not.toContain(comic);

  await page.locator('[data-project-assets-slideshow-trigger]').click();
  await expect(page.locator(DIALOG)).toBeVisible();
  await expect(position(page)).toHaveText(`1 of ${expected.length}`);
  let state = await viewerState(page);
  expect(state).toMatchObject({ mode: 'sequence', slideshow: true, wrap: true, titles: expected, sourceKey: `project-assets:${f.a}` });
  expect(state.playback).toMatchObject({ available: true, playing: true, speed: 4000 });
  // Speed choices 2/4/6 s; changing speed keeps exactly one advancement timer.
  const speeds = await page.locator(`${DIALOG} select[data-unified-viewer-speed] option`).evaluateAll((nodes) => nodes.map((node) => node.value));
  expect(speeds).toEqual(['2000', '4000', '6000']);
  await loaded(page);
  await expect.poll(async () => (await resources(page)).timers).toEqual([4000]);
  await page.locator(`${DIALOG} #unified-viewer-speed-dropdown summary`).click();
  await page.locator(`${DIALOG} #unified-viewer-speed-dropdown-options`).getByText('2 s', { exact: true }).click();
  await expect.poll(async () => (await resources(page)).timers).toEqual([2000]);
  // It advances by itself (load-aware), wrapping is available both ways.
  await expect(title(page)).toHaveText(expected[1], { timeout: 10_000 });
  await page.locator(`${DIALOG} [data-unified-viewer-previous]`).click();
  await page.locator(`${DIALOG} [data-unified-viewer-previous]`).click();
  await expect(title(page)).toHaveText(expected[expected.length - 1]);
  state = await viewerState(page);
  expect(state.playback).toMatchObject({ playing: false, scheduled: false });
  expect((await resources(page)).timers).toEqual([]);
  await closeViewer(page);
  await expect(page.locator('[data-project-assets-slideshow-trigger]')).toBeFocused();
  await expect(page.locator(`input[name="selectedAssetIds"][value="${f.id('02-landscape.jpg')}"]`)).toBeChecked();
  expect((await resources(page)).timers).toEqual([]);
  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);

  // A search filter narrows the server sequence; the slideshow follows it.
  control = await open(page, `/projects/${f.a}/assets?view=list&search=portrait&sort=filename&order=asc`);
  await page.locator('[data-project-assets-slideshow-trigger]').click();
  state = await viewerState(page);
  expect(state.titles).toEqual(['01-portrait.png']);
  expect(state.keys).toEqual([`p:${f.a}|a:${portrait}`]);
  await closeViewer(page);

  // Asset Library: project-filtered, paged (10 per page, 14 images), the
  // same complete membership.
  await f.addImages(8);
  control = await open(page, `${LIBRARY}?view=grid&project=${f.a}&pageSize=10&sort=filename&order=asc`);
  await expect(page.locator('a[data-asset-library-preview-id]').first()).toBeVisible();
  expect(await page.locator('a[data-asset-library-preview-id]').count()).toBeLessThan(f.images.length);
  await page.locator('[data-asset-library-slideshow-trigger]').click();
  await expect(position(page)).toHaveText(`1 of ${f.images.length}`);
  state = await viewerState(page);
  expect(state).toMatchObject({ mode: 'sequence', slideshow: true, titles: [...f.images].sort() });
  expect(state.playback.playing).toBe(true);
  await closeViewer(page);
  expect((await resources(page)).timers).toEqual([]);

  // Duplicate filenames across projects stay distinct items.
  control = await open(page, `${LIBRARY}?view=grid&search=${f.dup}&sort=filename&order=asc`);
  await page.locator('[data-asset-library-slideshow-trigger]').click();
  state = await viewerState(page);
  expect(state.titles).toEqual([f.dup, f.dup]);
  expect(new Set(state.keys).size).toBe(2);
  expect(state.keys.sort()).toEqual([`p:${f.a}|a:${f.id(f.dup)}`, `p:${f.b}|a:${f.idB(f.dup)}`].sort());
  await closeViewer(page);
  // A thumbnail is project-qualified: project B's copy opens only itself.
  await page.locator(`a[data-asset-library-preview-id="${f.idB(f.dup)}"][data-asset-library-preview-project-id="${f.b}"]`).click();
  state = await viewerState(page);
  expect(state).toMatchObject({ mode: 'single', count: 1 });
  expect(state.mediaUrl).toContain(`/projects/${f.b}/assets/${f.idB(f.dup)}/preview`);
  await closeViewer(page);
  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('scenario C: repeated viewing, original inspection, pending loads and replacement release every resource', async ({ page }) => {
  test.setTimeout(150_000);
  const f = await createFixture();
  const control = await open(page, `/projects/${f.a}/assets?view=grid&sort=filename&order=asc`);
  const slideshow = page.locator('[data-project-assets-slideshow-trigger]');

  // One full cycle establishes the steady listener set.
  const cycle = async () => {
    await slideshow.click();
    await loaded(page);
    await page.locator(`${DIALOG} [data-unified-viewer-zoom-in]`).click();
    await page.locator(`${DIALOG} [data-unified-viewer-quality]`).click();
    await expect.poll(async () => (await viewerState(page)).quality.displayed).toBe('original');
    // Preview + original for the current item, plus at most one neighbour.
    expect((await resources(page)).imageObjectUrls).toBeLessThanOrEqual(3);
    expect((await viewerState(page)).playback).toMatchObject({ playing: false, pauseReason: 'inspection' });
    await page.locator(`${DIALOG} [data-unified-viewer-next]`).click();
    await loaded(page);
    // Navigation retires the prior item: current rendition plus one neighbour.
    await expect.poll(async () => (await resources(page)).imageObjectUrls).toBeLessThanOrEqual(2);
    await closeViewer(page);
    const after = await resources(page);
    expect(after.imageObjectUrls).toBe(0);
    expect(after.outstanding).toBe(0);
    expect(after.timers).toEqual([]);
    expect(after.shownImages).toBe(0);
    expect((await viewerState(page)).media.status).toBe('idle');
    return after;
  };
  const first = await cycle();
  for (let round = 0; round < 3; round += 1) {
    const again = await cycle();
    expect(again.listeners).toEqual(first.listeners);
  }

  // Single images on the same page after slideshows.
  await page.locator(`a[data-project-assets-preview-id="${f.id('03-photo.webp')}"]`).click();
  await loaded(page);
  await closeViewer(page);
  expect((await resources(page)).listeners).toEqual(first.listeners);

  // Close during a pending fetch: the held response never installs.
  const held = [];
  const portraitPreview = new RegExp(`/projects/${f.a}/assets/${f.id('01-portrait.png')}/preview`);
  await page.route(portraitPreview, (route) => { held.push(route); });
  await page.locator(`a[data-project-assets-preview-id="${f.id('01-portrait.png')}"]`).click();
  await expect.poll(() => held.length).toBe(1);
  expect((await viewerState(page)).media.status).toBe('loading');
  await closeViewer(page);
  await held.shift().continue();
  await page.waitForTimeout(300);
  expect(await resources(page)).toMatchObject({ imageObjectUrls: 0, outstanding: 0, shownImages: 0 });

  // Replace the source during a pending load: the old load cannot install.
  await page.locator(`a[data-project-assets-preview-id="${f.id('01-portrait.png')}"]`).click();
  await expect.poll(() => held.length).toBe(1);
  const firstSession = (await viewerState(page)).session;
  const replaced = await page.evaluate(() => {
    const viewer = document.getElementById('unified-viewer-dialog').__creatorCrateUnifiedViewer;
    const entries = JSON.parse(document.querySelector('[data-project-assets-viewer-sequence]').textContent);
    const target = entries.find((entry) => entry.filename === '03-photo.webp');
    return viewer.open({ key: 'b8-replacement', mode: 'single', items: [{
      projectId: target.projectId, assetId: target.id, title: target.filename, mediaUrl: target.previewUrl, revision: target.revision,
    }] });
  });
  expect(replaced).toBeGreaterThan(firstSession);
  await loaded(page);
  await held.shift().continue();
  await page.waitForTimeout(300);
  let state = await viewerState(page);
  expect(state).toMatchObject({ session: replaced, titles: ['03-photo.webp'] });
  expect(state.mediaUrl).not.toMatch(portraitPreview);
  expect((await resources(page)).imageObjectUrls).toBe(1);
  // An update for the replaced session is ignored.
  const ignored = await page.evaluate((session) => document.getElementById('unified-viewer-dialog')
    .__creatorCrateUnifiedViewer.update({ items: [] }, { session }), firstSession);
  expect(ignored).toBe(null);
  expect((await viewerState(page)).open).toBe(true);
  await closeViewer(page);
  await page.unroute(portraitPreview);
  state = await viewerState(page);
  expect(state.open).toBe(false);
  expect(await resources(page)).toMatchObject({ imageObjectUrls: 0, outstanding: 0, timers: [], listeners: first.listeners });
  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('scenario D: authoritative refreshes reconcile only the open session; filtering is not deletion', async ({ page }) => {
  test.setTimeout(150_000);
  const f = await createFixture();
  const portrait = f.id('01-portrait.png');
  const region = '[data-project-assets-live-region]';
  const refreshed = async () => {
    await page.locator(region).evaluate((node) => { node.dataset.beforeRefresh = 'true'; });
    await page.evaluate(() => document.dispatchEvent(new Event('project-asset-categories-changed')));
    await expect(page.locator(`${region}:not([data-before-refresh])`)).toHaveCount(1);
    await expect(page.locator(region)).not.toHaveAttribute('aria-busy', 'true');
  };

  // Project Assets: a changed revision reloads; an unchanged refresh does not.
  let control = await open(page, `/projects/${f.a}/assets?view=grid&sort=filename&order=asc`);
  await page.locator(`a[data-project-assets-preview-id="${portrait}"]`).click();
  await loaded(page);
  const before = await viewerState(page);
  const fetchesBefore = (await resources(page)).mediaFetches;
  await refreshed(page);
  expect((await viewerState(page)).mediaUrl).toBe(before.mediaUrl);
  expect((await resources(page)).mediaFetches).toBe(fetchesBefore);

  await f.rewrite('01-portrait.png');
  await refreshed(page);
  await expect.poll(async () => (await viewerState(page)).revision).not.toBe(before.revision);
  const after = await viewerState(page);
  expect(after.session).toBe(before.session);
  expect(after.mediaUrl).not.toBe(before.mediaUrl);
  await loaded(page);
  expect((await viewerState(page)).media).toMatchObject({ width: 500, height: 1000 });
  const displayedUrl = (await viewerState(page)).quality.url;
  expect(displayedUrl).toContain('rendition=optimized');
  expect((await resources(page)).mediaUrls).toContain(displayedUrl);
  expect((await resources(page)).imageObjectUrls).toBe(1);

  // A closed session is never reopened by a later refresh.
  await closeViewer(page);
  await f.rewrite('01-portrait.png');
  const fetchesClosed = (await resources(page)).mediaFetches;
  await refreshed(page);
  expect((await viewerState(page)).open).toBe(false);
  expect((await resources(page)).mediaFetches).toBe(fetchesClosed);
  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);

  // Release Manage Assets: a filter that hides the asset is no evidence it is
  // gone, so the open session stays; drafts survive.
  const releaseAssets = `/releases/${f.mixed}/assets`;
  control = await open(page, `${releaseAssets}?selection=all&view=grid&pageSize=all`);
  const webp = f.id('03-photo.webp');
  await page.locator(`label[for="release-asset-select-${webp}"]`).click();
  await page.locator(`[data-release-assets-live-region] a[data-release-assets-viewer-trigger][data-viewer-asset="${portrait}"]`).click();
  await loaded(page);
  const open1 = await viewerState(page);
  await page.locator('[data-release-assets-live-region]').evaluate((node) => { node.dataset.beforeRefresh = 'true'; });
  await page.evaluate((next) => {
    window.history.replaceState({ releaseAssets: true }, '', next);
    window.dispatchEvent(new PopStateEvent('popstate', { state: { releaseAssets: true } }));
  }, `${releaseAssets}?selection=all&view=grid&pageSize=all&search=landscape`);
  await expect(page.locator('[data-release-assets-live-region]:not([data-before-refresh])')).toHaveCount(1);
  await expect(page.locator('[data-release-assets-live-region]')).not.toHaveAttribute('aria-busy', 'true');
  const kept = await viewerState(page);
  expect(kept).toMatchObject({ open: true, session: open1.session, key: open1.key });
  await closeViewer(page);
  const drafts = await page.evaluate(() => {
    const ids = new Set();
    document.querySelectorAll('[data-release-assets-hidden-membership] input[name="selectedAssetIds"], [data-release-assets-live-region] input[name="selectedAssetIds"]:checked')
      .forEach((input) => ids.add(input.value));
    return [...ids].sort();
  });
  expect(drafts).toContain(webp);
  expect(control.mutations).toEqual([]);

  // Release Detail: removal from the saved selection is authoritative and
  // closes the open session; the removed asset is no longer a trigger.
  control = await open(page, `/releases/${f.second}`);
  const dup = f.id(f.dup);
  const trigger = page.locator(`[data-selected-assets] a[data-release-detail-viewer-trigger][data-viewer-asset="${dup}"]`);
  await trigger.click();
  await loaded(page);
  db.prepare('DELETE FROM release_assets WHERE release_id = ? AND asset_id = ?').run(Number(f.second), Number(dup));
  await page.evaluate((id) => document.dispatchEvent(new CustomEvent('release-edit-saved', { detail: { releaseId: id } })), Number(f.second));
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(trigger).toHaveCount(0);
  const focused = await page.evaluate(() => ({ connected: document.activeElement?.isConnected, body: document.activeElement === document.body }));
  expect(focused).toEqual({ connected: true, body: false });
  expect((await resources(page)).imageObjectUrls).toBe(0);
  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('scenario E: focus, fullscreen, Escape order and fallbacks on distinct page types', async ({ page }) => {
  test.setTimeout(150_000);
  const f = await createFixture();
  const landscape = f.id('02-landscape.jpg');

  // Asset Details: native fullscreen on the card, no reload, Escape order.
  let control = await open(page, `/projects/${f.a}/assets/${landscape}`);
  const trigger = page.locator('[data-asset-details-viewer-trigger]');
  await trigger.click();
  await loaded(page);
  const fetches = (await resources(page)).mediaFetches;
  const fullscreen = page.locator(`${DIALOG} [data-unified-viewer-fullscreen]`);
  await fullscreen.focus();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await viewerState(page)).fullscreenElement).toBe('card');
  await expect(fullscreen).toBeFocused();
  expect((await resources(page)).mediaFetches).toBe(fetches);
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await viewerState(page)).fullscreenElement).toBe(null);
  await expect(page.locator(DIALOG)).toBeVisible();
  await expect(closeButton(page)).toBeVisible();
  await fullscreen.click();
  await expect.poll(async () => (await viewerState(page)).fullscreenElement).toBe('card');
  await closeButton(page).click();
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect.poll(async () => (await viewerState(page)).fullscreenElement).toBe(null);
  await expect(trigger).toBeFocused();
  await expect(page.locator('body')).not.toHaveClass(/app-dialog-open/);
  expect(control.errors).toEqual([]);

  // Project Assets slideshow: an open speed dropdown takes Escape first.
  control = await open(page, `/projects/${f.a}/assets?view=grid&sort=filename&order=asc`);
  await page.locator('[data-project-assets-slideshow-trigger]').click();
  await page.locator(`${DIALOG} #unified-viewer-speed-dropdown summary`).click();
  await expect(page.locator(`${DIALOG} #unified-viewer-speed-dropdown`)).toHaveAttribute('open', '');
  await page.keyboard.press('Escape');
  await expect(page.locator(`${DIALOG} #unified-viewer-speed-dropdown`)).not.toHaveAttribute('open', '');
  await expect(page.locator(DIALOG)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(page.locator('[data-project-assets-slideshow-trigger]')).toBeFocused();
  expect((await resources(page)).timers).toEqual([]);

  // Release Detail: a removed opener is never focused; a valid fallback is.
  control = await open(page, `/releases/${f.mixed}`);
  const opener = page.locator(`[data-selected-assets] a[data-release-detail-viewer-trigger][data-viewer-asset="${landscape}"]`);
  await opener.click();
  await loaded(page);
  await opener.evaluate((node) => node.remove());
  await closeViewer(page);
  const fallback = await page.evaluate(() => ({
    connected: document.activeElement?.isConnected === true,
    body: document.activeElement === document.body,
    inDialog: Boolean(document.activeElement?.closest('#unified-viewer-dialog')),
  }));
  expect(fallback).toEqual({ connected: true, body: false, inDialog: false });
  expect(control.mutations).toEqual([]);

  // Project Detail (B7c): the same asset in two strips keeps its release
  // context, and a retirement after Delete closes the session and withdraws
  // every trigger, sending focus to #main-content rather than an inert opener.
  control = await open(page, `/projects/${f.a}`);
  const portrait = f.id('01-portrait.png');
  const secondThumb = page.locator(`.project-detail-releases a[data-project-detail-viewer-trigger][data-viewer-release="${f.second}"][data-viewer-asset="${portrait}"]`);
  await secondThumb.click();
  await loaded(page);
  expect((await viewerState(page)).sourceKey).toBe(`project-detail:${f.a}:release:${f.second}`);
  await closeViewer(page);
  await expect(secondThumb).toBeFocused();
  await secondThumb.click();
  await loaded(page);
  // What project-delete.js's retireProjectPage does on a terminal Delete
  // (mark the host, make its content inert, focus #main-content), followed by
  // its project-deleted event; the real Delete flow is project-delete.spec.
  await page.evaluate((projectId) => {
    const main = document.getElementById('main-content');
    main.setAttribute('data-project-deleted-host', projectId);
    Array.from(main.children).forEach((child) => child.setAttribute('inert', ''));
    main.focus({ preventScroll: true });
    document.dispatchEvent(new CustomEvent('project-deleted', { detail: { projectId, hostRetired: true } }));
  }, f.a);
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(page.locator('[data-project-detail-viewer-trigger]')).toHaveCount(0);
  await expect(page.locator('#main-content')).toBeFocused();
  await expect(page.locator('body')).not.toHaveClass(/app-dialog-open/);
  expect(await resources(page)).toMatchObject({ imageObjectUrls: 0, outstanding: 0 });
  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('scenario F: viewing never changes saved releases, drafts, project actions or asset metadata', async ({ page }) => {
  test.setTimeout(150_000);
  const f = await createFixture();
  const snapshot = () => ({
    membership: db.prepare('SELECT release_id, asset_id, role, sort_order FROM release_assets WHERE release_id IN (?, ?) ORDER BY release_id, sort_order')
      .all(Number(f.mixed), Number(f.second)),
    releases: db.prepare('SELECT * FROM releases WHERE project_id = ? ORDER BY id').all(Number(f.a)),
    projects: db.prepare('SELECT * FROM projects WHERE id IN (?, ?) ORDER BY id').all(Number(f.a), Number(f.b)),
    assets: db.prepare('SELECT * FROM assets WHERE project_id IN (?, ?) ORDER BY id').all(Number(f.a), Number(f.b)),
  });
  const saved = snapshot();
  const landscape = f.id('02-landscape.jpg');
  const portrait = f.id('01-portrait.png');
  const webp = f.id('03-photo.webp');

  // Release Manage Assets: unsaved additions and removals survive viewing,
  // keyboard activation and Enter inside the viewer never submit.
  let control = await open(page, `/releases/${f.mixed}/assets?selection=all&view=grid&pageSize=all`);
  const box = (id) => page.locator(`[data-release-assets-live-region] input[name="selectedAssetIds"][value="${id}"]`);
  await page.locator(`label[for="release-asset-select-${webp}"]`).click();
  await page.locator(`label[for="release-asset-select-${portrait}"]`).click();
  const thumb = page.locator(`[data-release-assets-live-region] a[data-release-assets-viewer-trigger][data-viewer-asset="${landscape}"]`);
  await thumb.focus();
  await page.keyboard.press('Enter');
  await loaded(page);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(box(webp)).toBeChecked();
  await expect(box(portrait)).not.toBeChecked();
  await expect(box(landscape)).toBeChecked();
  expect(control.mutations).toEqual([]);

  // Release Detail, Project Detail and Asset Details viewing: presentation only.
  for (const url of [`/releases/${f.mixed}`, `/projects/${f.a}`, `/projects/${f.a}/assets/${landscape}`]) {
    control = await open(page, url);
    const trigger = page.locator('[data-release-detail-viewer-trigger], [data-project-detail-viewer-trigger], [data-asset-details-viewer-trigger]').first();
    await trigger.click();
    await loaded(page);
    await page.locator(`${DIALOG} [data-unified-viewer-zoom-in]`).click();
    await closeViewer(page);
    expect(control.mutations, url).toEqual([]);
    expect(control.errors, url).toEqual([]);
  }
  // Release Detail order and roles as rendered stay in saved order.
  await page.goto(`${baseURL}/releases/${f.mixed}`);
  const order = await page.locator('[data-selected-assets] article[data-asset-id]').evaluateAll((nodes) => nodes.map((node) => node.dataset.assetId));
  expect(order).toEqual(saved.membership.filter((row) => String(row.release_id) === f.mixed).map((row) => String(row.asset_id)));
  // Project Detail keeps its Edit project entry point and release links.
  await page.goto(`${baseURL}/projects/${f.a}`);
  await expect(page.locator(`[data-project-edit-id="${f.a}"]`).first()).toBeVisible();
  await expect(page.locator(`.project-detail-releases a[href="/releases/${f.mixed}"]`).first()).toBeVisible();
  expect(snapshot()).toEqual(saved);
});

test('scenario G: video keeps its own player; comics never reach the image loader; failures are safe', async ({ page }) => {
  test.setTimeout(150_000);
  const f = await createFixture();
  const clip = f.id('clip.mp4');
  const comic = f.id('book.cbz');
  const kra = f.id('05-paint.kra');

  // Release Detail: video tile opens the separate video dialog only.
  let control = await open(page, `/releases/${f.mixed}`);
  await expect(page.locator(`[data-selected-assets] [data-release-detail-viewer-trigger][data-viewer-asset="${comic}"]`)).toHaveCount(0);
  await expect(page.locator(`[data-selected-assets] [data-release-detail-viewer-trigger][data-viewer-asset="${clip}"]`)).toHaveCount(0);
  const video = page.locator(`[data-selected-assets] article[data-asset-id="${clip}"] a[data-asset-video-preview-trigger]`);
  await expect(video).toHaveCount(1);
  await video.click();
  await expect(page.locator(VIDEO_DIALOG)).toBeVisible();
  await expect(page.locator(DIALOG)).toBeHidden();
  expect((await viewerState(page)).open).toBe(false);
  await page.keyboard.press('Escape');
  await expect(page.locator(VIDEO_DIALOG)).toBeHidden();
  expect((await resources(page)).mediaFetches).toBe(0);

  // A comic link is left to its own navigation, never the viewer.
  const comicLink = page.locator(`[data-selected-assets] article[data-asset-id="${comic}"] a[href="/projects/${f.a}/assets/${comic}"]`).first();
  await page.evaluate(() => {
    window.__comicClick = null;
    window.addEventListener('click', (event) => { window.__comicClick = { prevented: event.defaultPrevented }; event.preventDefault(); }, { once: true });
  });
  await comicLink.dispatchEvent('click');
  expect(await page.evaluate(() => window.__comicClick)).toEqual({ prevented: false });
  expect((await viewerState(page)).open).toBe(false);

  // Failure paths on a single-image host: HTML, invalid bytes, HTTP 500.
  const landscape = f.id('02-landscape.jpg');
  const route = new RegExp(`/projects/${f.a}/assets/${landscape}/preview`);
  const opener = page.locator(`[data-selected-assets] a[data-release-detail-viewer-trigger][data-viewer-asset="${landscape}"]`);
  for (const response of [
    { status: 200, contentType: 'text/html', body: '<html><body><img src=x onerror="window.__xss=1">nope</body></html>' },
    { status: 200, contentType: 'image/png', body: 'definitely not a png' },
    { status: 500, contentType: 'text/plain', body: 'boom' },
  ]) {
    await page.route(route, (handler) => handler.fulfill(response));
    await opener.click();
    await expect.poll(async () => (await viewerState(page)).media.status).toBe('failed');
    await expect(page.locator(`${DIALOG} [data-unified-viewer-status]`)).toHaveText('This image could not be loaded.');
    await expect(retry(page)).toBeVisible();
    await expect(shownImage(page)).toHaveCount(0);
    expect(await page.evaluate(() => window.__xss ?? null)).toBe(null);
    expect((await resources(page)).imageObjectUrls).toBe(0);
    await page.unroute(route);
    await retry(page).click();
    await loaded(page);
    await closeViewer(page);
    expect(await resources(page)).toMatchObject({ imageObjectUrls: 0, outstanding: 0 });
  }
  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);

  // Asset Details: Krita has no Original rendition; the comic and
  // video detail pages offer no viewer trigger at all.
  control = await open(page, `/projects/${f.a}/assets/${kra}`);
  await page.locator('[data-asset-details-viewer-trigger]').click();
  await loaded(page);
  expect((await viewerState(page)).originalUrl).toBe(null);
  await expect(page.locator(`${DIALOG} [data-unified-viewer-quality]`)).toBeHidden();
  await expect(page.locator(`${DIALOG} [data-unified-viewer-original]`)).toBeDisabled();
  await closeViewer(page);
  for (const id of [comic, clip]) {
    await page.goto(`${baseURL}/projects/${f.a}/assets/${id}`);
    await page.waitForFunction(() => Boolean(document.getElementById('unified-viewer-dialog')?.__creatorCrateUnifiedViewer));
    await expect(page.locator('[data-asset-details-viewer-trigger]')).toHaveCount(0);
  }

  // Project Assets: no comic or video in the image sequence, a failed slide
  // pauses playback and Retry does not resume it.
  control = await open(page, `/projects/${f.a}/assets?view=grid&sort=filename&order=asc`);
  const ids = await page.evaluate(() => JSON.parse(document.querySelector('[data-project-assets-viewer-sequence]').textContent).map((entry) => String(entry.id)));
  expect(ids).not.toContain(comic);
  expect(ids).not.toContain(clip);
  const secondPreview = new RegExp(`/projects/${f.a}/assets/${f.id('02-landscape.jpg')}/preview`);
  await page.route(secondPreview, (handler) => handler.fulfill({ status: 500, body: 'no' }));
  await page.locator('[data-project-assets-slideshow-trigger]').click();
  await expect(title(page)).toHaveText('02-landscape.jpg', { timeout: 12_000 });
  await expect.poll(async () => (await viewerState(page)).media.status).toBe('failed');
  expect((await viewerState(page)).playback).toMatchObject({ playing: false, pauseReason: 'media', scheduled: false });
  await page.unroute(secondPreview);
  await retry(page).click();
  await loaded(page);
  expect((await viewerState(page)).playback.playing).toBe(false);
  expect((await resources(page)).timers).toEqual([]);
  // A hidden page pauses; visible again does not resume.
  await page.locator(`${DIALOG} [data-unified-viewer-play]`).click();
  expect((await viewerState(page)).playback.playing).toBe(true);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect((await viewerState(page)).playback).toMatchObject({ playing: false, pauseReason: 'hidden' });
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect((await viewerState(page)).playback.playing).toBe(false);
  await closeViewer(page);
  expect((await resources(page)).timers).toEqual([]);
  expect(control.comic).toEqual([]);
  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('narrow 375px: single-image and slideshow hosts fit without horizontal scroll', async ({ page }) => {
  const f = await createFixture();
  for (const url of [`/projects/${f.a}`, `/projects/${f.a}/assets?view=list&sort=filename&order=asc`]) {
    const control = await open(page, url, { viewport: { width: 375, height: 740 } });
    const trigger = page.locator('[data-project-detail-viewer-trigger], [data-project-assets-slideshow-trigger]').first();
    await trigger.scrollIntoViewIfNeeded();
    await trigger.click();
    await loaded(page);
    const card = await page.locator(`${DIALOG} [data-unified-viewer-card]`).boundingBox();
    expect(card.x).toBeGreaterThanOrEqual(0);
    expect(card.x + card.width).toBeLessThanOrEqual(375.5);
    await expect(closeButton(page)).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    await closeViewer(page);
    await expect(trigger).toBeFocused();
    expect(control.mutations, url).toEqual([]);
    expect(control.errors, url).toEqual([]);
  }
});


test('compiled asset graph serves every emitted runtime asset without raw module fallbacks', async ({ request, page }) => {
  const files = new Set(Object.values(compiledManifest).flatMap((record) => [record.file, ...(record.css || []), ...(record.assets || [])]).filter(Boolean));
  for (const file of files) {
    const response = await request.get(`${baseURL}/vite/${file}`);
    expect(response.status(), file).toBe(200);
    expect((await response.body()).length, file).toBeGreaterThan(0);
    if (file.endsWith('.js')) expect(response.headers()['content-type'], file).toMatch(/javascript/);
    if (file.endsWith('.css')) expect(response.headers()['content-type'], file).toMatch(/text\/css/);
  }
  const f = await createFixture();
  const control = await open(page, `/projects/${f.a}/assets`);
  await page.locator('[data-project-assets-slideshow-trigger]').click();
  await loaded(page);
  await closeViewer(page);
  expect(control.assetErrors).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('existing installation retains policy, publications, identities and browser preferences through reload and history', async ({ page }) => {
  test.setTimeout(180_000);
  const f = await createFixture();
  const policy = {
    thumbnailFormat: 'png', thumbnailWebpQuality: 63, thumbnailMaxDimension: 128,
    previewFormat: 'png', previewWebpQuality: 79, previewMaxDimension: 640,
  };
  const priorMeta = db.prepare('SELECT * FROM app_meta ORDER BY key').all();
  try {
    app.locals.projectImageSettingsService.saveValidated(policy);
    for (const [key, value] of Object.entries({
      'page_defaults.project_assets.view': 'grid', 'page_defaults.project_assets.grid_style': 'cropped',
      'page_defaults.asset_viewer.view': 'list', 'page_defaults.asset_viewer.grid_style': 'uncropped',
    })) db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
    const landscape = f.id('02-landscape.jpg');
    const comic = f.id('book.cbz');
    // Populate valid ordinary derivatives before taking the existing-install snapshot.
    await app.locals.previewService.getPreview(Number(f.a), Number(landscape));
    await app.locals.previewService.getThumbnail(Number(f.a), Number(landscape));
    const snapshot = () => ({
      projects: db.prepare('SELECT * FROM projects WHERE id IN (?,?) ORDER BY id').all(Number(f.a), Number(f.b)),
      assets: db.prepare('SELECT * FROM assets WHERE project_id IN (?,?) ORDER BY id').all(Number(f.a), Number(f.b)),
      releases: db.prepare('SELECT * FROM releases WHERE project_id=? ORDER BY id').all(Number(f.a)),
      membership: db.prepare('SELECT * FROM release_assets WHERE release_id IN (?,?) ORDER BY release_id, sort_order').all(Number(f.mixed), Number(f.second)),
      policy: db.prepare("SELECT * FROM app_meta WHERE key LIKE 'images.%' OR key LIKE 'page_defaults.%' ORDER BY key").all(),
      publications: db.prepare('SELECT * FROM generated_image_publications WHERE asset_id=?').all(Number(landscape)),
      derivatives: db.prepare('SELECT * FROM generated_image_derivatives WHERE asset_id=? ORDER BY kind').all(Number(landscape)),
      artifacts: db.prepare('SELECT * FROM generated_artifacts WHERE project_id=? ORDER BY id').all(Number(f.a)),
      schema: db.prepare("SELECT * FROM sqlite_master WHERE type='table' ORDER BY name").all(),
    });
    const before = snapshot();
    expect(before.publications).toHaveLength(1);
    expect(before.derivatives).toHaveLength(2);
    await open(page, `/projects/${f.a}/assets`);
    const readerKey = `creatorcrate-comic-reader-preferences:v1:comic:${f.a}:${comic}`;
    const preferences = { version: 1, direction: 'rtl', layout: 'spread', alignment: 'pair-from-first' };
    await page.evaluate(({ readerKey, preferences }) => {
      localStorage.setItem(readerKey, JSON.stringify(preferences));
      localStorage.setItem('creatorcrate-release-detail-grid-style', 'cropped');
      localStorage.setItem('creatorcrate-release-assets-grid-style', 'uncropped');
      localStorage.setItem('creatorcrate-asset-grid-size', 'large');
    }, { readerKey, preferences });
    const storage = () => page.evaluate(() => Object.fromEntries(Object.keys(localStorage).sort().map((key) => [key, localStorage.getItem(key)])));
    const stored = await storage();
    await page.reload();
    await expect(page.locator('.asset-grid').first()).toHaveAttribute('data-grid-style', 'cropped');
    const trigger = page.locator(`a[data-project-assets-preview-id="${landscape}"]`);
    for (let round = 0; round < 2; round += 1) {
      await trigger.click();
      await loaded(page);
      const state = await viewerState(page);
      expect(state.key).toBe(`p:${f.a}|a:${landscape}`);
      expect(state.mediaUrl).toContain(`/projects/${f.a}/assets/${landscape}/preview`);
      expect(await page.evaluate(() => document.getElementById('unified-viewer-dialog').__creatorCrateUnifiedViewer.media.getState().quality))
        .toMatchObject({ desired: 'optimized', displayed: 'optimized' });
      await closeViewer(page);
    }
    // Drive the existing controller's Reader entry with real revision-bound archive pages.
    const read = async () => {
      await page.evaluate(({ projectId, assetId }) => document.getElementById('unified-viewer-dialog').__creatorCrateUnifiedViewer.openComic({ projectId, assetId }),
        { projectId: f.a, assetId: comic });
      await expect.poll(() => page.evaluate(() => document.getElementById('unified-viewer-dialog').__creatorCrateUnifiedViewer.getState().comic?.state)).toBe('ready');
      await expect.poll(() => page.evaluate(() => document.getElementById('unified-viewer-dialog').__creatorCrateUnifiedViewer.getState().reader))
        .toMatchObject({ direction: 'rtl', layout: 'spread', alignment: 'pair-from-first' });
      await expect(page.locator(`${DIALOG} .unified-viewer-page-image`)).toHaveCount(2);
      await closeViewer(page);
    };
    await read();
    await page.reload();
    await read();
    // The Library's stored List presentation and history retain source identity.
    const library = `${LIBRARY}?project=${f.a}&sort=filename&order=asc`;
    await page.goto(`${baseURL}${library}`);
    await expect(page.locator('.asset-list').first()).toBeVisible();
    await page.goto(`${baseURL}${library}&view=grid&search=landscape`);
    await page.locator('[data-asset-library-slideshow-trigger]').click();
    await loaded(page);
    expect((await viewerState(page)).keys).toEqual([`p:${f.a}|a:${landscape}`]);
    await closeViewer(page);
    await page.goBack();
    await expect(page.locator('.asset-list').first()).toBeVisible();
    await page.goForward();
    await page.locator('[data-asset-library-slideshow-trigger]').click();
    expect((await viewerState(page)).keys).toEqual([`p:${f.a}|a:${landscape}`]);
    await closeViewer(page);
    for (const [url, style] of [[`/releases/${f.mixed}`, 'cropped'], [`/releases/${f.mixed}/assets?view=grid`, 'uncropped']]) {
      await page.goto(`${baseURL}${url}`);
      await expect(page.locator('.asset-grid').first()).toHaveAttribute('data-grid-style', style);
    }
    expect(await storage()).toEqual(stored);
    expect(app.locals.projectImageSettingsService.getPolicy()).toEqual({
      thumbnail: { format: 'png', webpQuality: 63, maxDimension: 128 },
      preview: { format: 'png', webpQuality: 79, maxDimension: 640 },
    });
    expect(snapshot(), 'existing project/asset/release and derivative authority is unchanged').toEqual(before);
  } finally {
    db.transaction(() => {
      db.prepare('DELETE FROM app_meta').run();
      for (const row of priorMeta) db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run(row.key, row.value);
    })();
  }
});


test('a restored application serves the compiled viewer with retained image and Reader identities', async ({ page }) => {
  const f = await createFixture();
  const landscape = f.id('02-landscape.jpg');
  const comic = f.id('book.cbz');
  const membership = () => db.prepare('SELECT * FROM release_assets WHERE release_id=? ORDER BY sort_order').all(Number(f.mixed));
  const before = membership();
  await page.goto(`${baseURL}/settings/backups`);
  const token = await page.locator('input[name="_csrf"]').first().inputValue();
  const backed = await page.request.post(`${baseURL}/settings/backups`, { form: { _csrf: token }, maxRedirects: 0 });
  expect(backed.status()).toBe(302);
  expect(backed.headers().location).toBe('/settings/backups?notice=backup_created');
  const backup = backupService.listBackups()[0].filename;
  db.prepare('UPDATE projects SET title=? WHERE id=?').run('After backup', Number(f.a));
  const retired = db;
  const restored = await page.request.post(`${baseURL}/settings/backups/${backup}/restore`, { form: { _csrf: token }, maxRedirects: 0 });
  // Resolve the current graph even if a later assertion fails, so teardown owns the live DB.
  db = appContext.db;
  app = appContext.app;
  releaseService = createReleaseService({ db });
  expect(restored.status()).toBe(302);
  expect(restored.headers().location).toBe('/settings/backups?notice=restore_success');
  expect(db).not.toBe(retired);
  expect(retired.open).toBe(false);
  expect(db.prepare('SELECT title FROM projects WHERE id=?').get(Number(f.a)).title).not.toBe('After backup');
  expect(membership()).toEqual(before);
  const control = await open(page, `/projects/${f.a}/assets?view=grid`);
  await page.locator(`a[data-project-assets-preview-id="${landscape}"]`).click();
  await loaded(page);
  expect((await viewerState(page)).key).toBe(`p:${f.a}|a:${landscape}`);
  await closeViewer(page);
  await page.evaluate(({ projectId, assetId }) => document.getElementById('unified-viewer-dialog').__creatorCrateUnifiedViewer.openComic({ projectId, assetId }),
    { projectId: f.a, assetId: comic });
  await expect.poll(() => page.evaluate(() => document.getElementById('unified-viewer-dialog').__creatorCrateUnifiedViewer.getState().comic?.state)).toBe('ready');
  await expect(page.locator(`${DIALOG} .unified-viewer-page-image`)).toHaveCount(1);
  await closeViewer(page);
  expect((await pageShell(page)).legacyScaffold).toBe(0);
  expect(control.assetErrors).toEqual([]);
  expect(control.errors).toEqual([]);
});
