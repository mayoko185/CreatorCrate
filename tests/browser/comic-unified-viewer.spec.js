import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import slugify from '@sindresorhus/slugify';
import sharp from 'sharp';
import { build } from 'vite';
import { createApp } from '../../src/app.js';
import { createAssetManifest } from '../../src/asset-manifest.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { createAssetRepository } from '../../src/data/asset-repository.js';
import { createProjectRepository } from '../../src/data/project-repository.js';
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';
import { defaultComicPreparationCacheRoot } from '../../src/services/comic-preparation-cache.js';
import { createComicRuntime } from '../../src/services/comic-runtime.js';
import { createPreviewService } from '../../src/services/preview-service.js';
import { formatProjectDirName } from '../../src/storage/project-storage.js';
import { bindTestProjectOwnership } from '../helpers/project-ownership.js';
import { makeZip } from '../helpers/zip-fixture.js';

// C1b: single-page comic sessions in the one shared unified viewer, in real
// Chromium against the compiled production bundle (built here into a temp
// directory) and Milestone A's real comic routes. An isolated installation
// (temp SQLite database, projects root and comic runtime) holds generated
// CBZ archives; no user data is involved. No host trigger exists yet (C2), so
// the bundle's controller is driven from an isolated test opener. Races and
// conflict timing use page.route: held or controlled responses in front of
// the real backend, which otherwise answers.

const DIALOG = '#unified-viewer-dialog';
const MEDIA = `${DIALOG} [data-unified-viewer-media]`;
// C1e: comic pages are composition images (unified-viewer-page-image).
const SHOWN = `${MEDIA} img:is(.unified-viewer-image, .unified-viewer-page-image):not([hidden])`;
const STATUS = `${DIALOG} [data-unified-viewer-status]`;
const POSITION = `${DIALOG} [data-unified-viewer-position]`;
const COMIC_RETRY = `${DIALOG} [data-unified-viewer-comic-retry]`;
const PAGE_RETRY = `${DIALOG} [data-unified-viewer-page-retry]`;
const CBZ_MIME = 'application/vnd.comicbook+zip';

let fixture;
const img = {};

async function gradient(width, height, seed) {
  const raw = Buffer.alloc(width * height * 3);
  for (let index = 0; index < raw.length; index += 1) raw[index] = (index * 7 + seed) & 0xff;
  return sharp(raw, { raw: { width, height, channels: 3 } });
}

test.beforeAll(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-comic-unified-viewer-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  const previewRoot = path.join(appDataRoot, 'previews');
  const viteDistRoot = path.join(root, 'client');
  fs.mkdirSync(projectsRoot);
  fs.mkdirSync(previewRoot, { recursive: true });
  await build({ build: { outDir: viteDistRoot }, logLevel: 'silent' });
  const db = openDatabase(path.join(root, 'test.db'));
  runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
  const { csrfPepper } = ensureAuthEnablement(appDataRoot);
  const runtime = createComicRuntime({ appDataRoot, projectsRoot, cacheOptions: { settleMs: 0 } });
  await runtime.start();
  const previewService = createPreviewService({ db, projectsRoot, previewRoot });
  const app = createApp({ appName: 'CreatorCrate', db, projectsRoot, previewRoot }, {
    appDataRoot, authState: { csrfPepper }, comicRuntime: runtime, previewService,
    useViteAssets: true, viteDistRoot,
    assetManifest: createAssetManifest({ distRoot: viteDistRoot,
      manifestPath: path.join(viteDistRoot, '.vite', 'manifest.json') }),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));

  img.page1 = await (await gradient(60, 80, 10)).jpeg().toBuffer();
  img.page2 = await (await gradient(60, 80, 90)).png().toBuffer();
  img.page3 = await (await gradient(80, 60, 170)).png().toBuffer();
  img.portrait = await (await gradient(900, 1350, 30)).jpeg().toBuffer();
  img.tall = await (await gradient(450, 1350, 45)).jpeg().toBuffer();
  img.landscape = await (await gradient(1600, 1000, 120)).jpeg().toBuffer();
  img.text = Buffer.from('this is not an image, only text. '.repeat(10));
  img.webp = await sharp({ create: { width: 320, height: 200, channels: 3, background: { r: 20, g: 140, b: 60 } } })
    .webp().toBuffer();

  const projectRepo = createProjectRepository(db);
  const assetRepo = createAssetRepository(db);
  const project = projectRepo.create({
    title: 'Comic viewer', projectType: 'images', slug: slugify('Comic viewer', { lowercase: true }),
    description: '', notes: '', status: 'tbd', priority: 'normal', plannedDate: null, publishedDate: null,
    patreonUrl: null,
  });
  const relDir = formatProjectDirName(project.id, project.slug);
  const absDir = path.resolve(projectsRoot, relDir);
  fs.mkdirSync(absDir, { recursive: true });
  projectRepo.setProjectDir(project.id, relDir);
  bindTestProjectOwnership(db, project.id, absDir);

  const write = (relPath, bytes) => {
    const full = path.join(absDir, relPath);
    fs.writeFileSync(full, bytes);
    const stat = fs.statSync(full);
    return assetRepo.upsert(project.id, relPath, {
      filename: relPath, extension: 'cbz', mimeType: CBZ_MIME, sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    });
  };
  const comics = {
    three: write('three.cbz', makeZip([
      { name: 'p1.jpg', data: img.page1 },
      { name: 'p2.png', data: img.text },
      { name: 'p3.png', data: img.page3 },
    ])).id,
    one: write('one.cbz', makeZip([{ name: 'only.png', data: img.page2 }])).id,
    other: write('other.cbz', makeZip([{ name: 'a.png', data: img.page2 }, { name: 'b.jpg', data: img.page1 }])).id,
    hostRefresh: write('host-refresh.cbz', makeZip([{ name: 'a.png', data: img.page2 }, { name: 'b.jpg', data: img.page1 }])).id,
    changing: write('changing.cbz', makeZip([
      { name: 'p1.jpg', data: img.page1 },
      { name: 'p2.png', data: img.page2 },
      { name: 'p3.png', data: img.page3 },
    ])).id,
    controlled: write('controlled.cbz', makeZip([{ name: 'x.png', data: img.page2 }])).id,
    // C1c: seven real pages for grouping and spread navigation.
    seven: write('seven.cbz', makeZip(Array.from({ length: 7 }, (_, index) => (
      { name: `s${index + 1}.png`, data: index % 2 === 0 ? img.page2 : img.page3 })))).id,
    // C1e: large portrait/landscape pages, so Fit scales a spread down.
    equal: write('equal.cbz', makeZip(Array.from({ length: 5 }, (_, index) => (
      { name: `e${index + 1}.png`, data: img.page2 })))).id,
    mixed: write('mixed.cbz', makeZip(Array.from({ length: 5 }, (_, index) => (
      { name: `m${index + 1}.jpg`, data: index % 2 === 0 ? img.portrait : img.landscape })))).id,
    portraitSpread: write('portrait-spread.cbz', makeZip(Array.from({ length: 3 }, (_, index) => (
      { name: `p${index + 1}.jpg`, data: img.portrait })))).id,
    tallSpread: write('tall-spread.cbz', makeZip(Array.from({ length: 3 }, (_, index) => (
      { name: `t${index + 1}.jpg`, data: img.tall })))).id,
    spreadChange: write('spread-change.cbz', makeZip(Array.from({ length: 4 }, (_, index) => (
      { name: `c${index + 1}.png`, data: index % 2 === 0 ? img.page2 : img.page3 })))).id,
  };

  fixture = {
    baseURL: `http://127.0.0.1:${server.address().port}`,
    projectId: project.id,
    comics,
    // Replace an archive's bytes and re-index it, as a rescan would.
    rewrite(relPath, entries) {
      const full = path.join(absDir, relPath);
      fs.writeFileSync(full, makeZip(entries));
      const later = new Date(Date.now() + 60_000);
      fs.utimesSync(full, later, later);
      write(relPath, fs.readFileSync(full));
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await runtime.close();
      closeDatabase(db);
      fs.rmSync(defaultComicPreparationCacheRoot(appDataRoot), { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    },
  };
});
test.afterAll(async () => { await fixture?.close(); });

const manifestPath = (assetId) => `/projects/${fixture.projectId}/assets/${assetId}/comic`;

// Holds and controlled answers in front of the real comic routes. A held
// request waits for release(); a controlled one is fulfilled by the test;
// everything else continues to the backend. Counts every request seen.
async function routeComics(page) {
  const holds = new Map();
  const controls = new Map();
  const seen = [];
  await page.route(/\/projects\/\d+\/assets\/\d+\/comic(\/pages\/\d+)?(\?.*)?$/, async (route) => {
    const url = new URL(route.request().url());
    const pathKey = url.pathname;
    seen.push(`${pathKey}${url.search}`);
    const hold = holds.get(pathKey);
    if (hold) {
      holds.delete(pathKey);
      await hold.promise;
    }
    const control = controls.get(pathKey);
    try {
      if (control) {
        if (control.once) controls.delete(pathKey);
        await route.fulfill(typeof control.response === 'function' ? control.response(url) : control.response);
      } else {
        await route.continue();
      }
    } catch {
      // The page aborted the request.
    }
  });
  await page.route('**/test-media/**', (route) => route.fulfill({ status: 200, contentType: 'image/webp', body: img.webp })
    .catch(() => {}));
  return {
    hold(pathKey) {
      let release;
      const promise = new Promise((resolve) => { release = resolve; });
      holds.set(pathKey, { promise, release });
      return () => release();
    },
    control(pathKey, response, { once = false } = {}) { controls.set(pathKey, { response, once }); },
    count: (pathKey) => seen.filter((entry) => entry.split('?')[0] === pathKey).length,
    seen,
  };
}

async function openPage(page) {
  await page.addInitScript(() => {
    const live = new Set();
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (object) => {
      const url = create(object);
      live.add(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      live.delete(url);
      revoke(url);
    };
    // Card covers are native image URLs; every live Blob belongs to viewer media.
    window.__liveObjectUrls = () => live.size;
  });
  const routes = await routeComics(page);
  await page.goto(`${fixture.baseURL}/assets`, { waitUntil: 'domcontentloaded' });
  expect(await page.evaluate(() => Boolean(document.querySelector('script[type="module"][src^="/vite/"]')))).toBe(true);
  await page.waitForFunction(() => Boolean(document.getElementById('unified-viewer-dialog')?.__creatorCrateUnifiedViewer));
  await page.evaluate(async () => {
    await document.fonts.ready;
    window.__comicBackgroundWidth = document.documentElement.scrollWidth;
    const host = document.createElement('div');
    host.id = 'test-viewer-host';
    host.innerHTML = '<button type="button" id="test-opener">Open comic</button>';
    document.querySelector('main').prepend(host);
    window.__viewer = () => document.getElementById('unified-viewer-dialog').__creatorCrateUnifiedViewer;
  });
  return routes;
}

async function openComic(page, assetId, title = 'Comic under test', sourceRevision, reader) {
  await page.locator('#test-opener').focus();
  return page.evaluate(({ projectId, assetId, title, sourceRevision, reader }) => window.__viewer().openComic(
    { projectId, assetId, title, sourceRevision },
    { opener: document.getElementById('test-opener'), reader },
  ), { projectId: fixture.projectId, assetId, title, sourceRevision, reader });
}

const reconcileComic = (page, assetId, session, sourceRevision) => page.evaluate(
  ({ projectId, assetId, session, sourceRevision }) => window.__viewer().reconcileComic(
    { projectId, assetId, sourceRevision }, { session },
  ), { projectId: fixture.projectId, assetId, session, sourceRevision },
);

const state = (page) => page.evaluate(() => {
  const viewer = window.__viewer();
  const { open, session, key, index, count, comic, fullscreen } = viewer.getState();
  return { open, session, key, index, count, comic, fullscreen, media: viewer.media.getState().status,
    httpStatus: viewer.media.getState().httpStatus };
});
const live = (page) => page.evaluate(() => window.__liveObjectUrls());
const comicState = async (page) => (await state(page)).comic?.state ?? null;
const pageKey = (assetId, position) => `p:${fixture.projectId}|a:${assetId}|n:${position}`;

function fakeManifest(assetId, { revision = 'c'.repeat(32), pages = [] } = {}) {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      projectId: fixture.projectId,
      assetId,
      format: 'cbz',
      revision,
      pageCount: pages.length,
      displayImageTypes: ['image/png'],
      preparation: { solid: false, state: 'not-required' },
      unavailablePositions: pages.flatMap((available, index) => (available ? [] : [index + 1])),
      pages: pages.map((available, index) => ({
        position: index + 1,
        name: `page-${index + 1}.png`,
        available,
        problem: available ? null : 'PAGE_TOO_LARGE',
        url: `/projects/${fixture.projectId}/assets/${assetId}/comic/pages/${index + 1}?v=${revision}`,
      })),
    }),
  };
}

test('opens the one dialog at once, then shows page 1 from the real manifest and navigates without wrapping', async ({ page }) => {
  const routes = await openPage(page);
  const id = fixture.comics.three;
  const release = routes.hold(manifestPath(id));
  const session = await openComic(page, id, 'Three pages');
  expect(session).toBeGreaterThan(0);
  await expect(page.locator(DIALOG)).toBeVisible();
  expect(await page.evaluate(() => document.querySelectorAll('dialog#unified-viewer-dialog').length)).toBe(1);
  await expect(page.locator(`${MEDIA} [data-unified-viewer-comic-loading]`)).toContainText('Loading comic…');
  await expect(page.locator(`${DIALOG} [data-unified-viewer-title]`)).toHaveText('Three pages');
  expect(await page.evaluate(() => document.getElementById('unified-viewer-dialog').contains(document.activeElement))).toBe(true);
  const focusedWhileLoading = await page.evaluate(() => document.activeElement.getAttribute('aria-label'));
  expect(await comicState(page)).toBe('loading');

  release();
  await expect(page.locator(SHOWN)).toBeVisible();
  await expect(page.locator(POSITION)).toHaveText('Page 1 of 3');
  expect(await state(page)).toMatchObject({ session, key: pageKey(id, 1), count: 3, comic: { state: 'ready' } });
  expect(await page.evaluate(() => document.activeElement.getAttribute('aria-label'))).toBe(focusedWhileLoading);
  expect(await page.locator(SHOWN).evaluate((image) => [image.naturalWidth, image.naturalHeight])).toEqual([60, 80]);
  // Foreground page only: nothing else was requested, and no slideshow or original.
  expect(routes.seen.filter((entry) => entry.includes('/pages/'))).toHaveLength(1);
  await expect(page.locator(`${DIALOG} [data-unified-viewer-playback]`)).toBeHidden();
  await expect(page.locator(`${DIALOG} [data-unified-viewer-original]`)).toBeHidden();
  await expect(page.locator(`${DIALOG} [data-unified-viewer-previous]`)).toBeDisabled();

  // Page 2 is not an image: the real backend refuses it; the position stays.
  await page.locator(`${DIALOG} [data-unified-viewer-next]`).click();
  await expect(page.locator(POSITION)).toHaveText('Page 2 of 3');
  await expect(page.locator(PAGE_RETRY)).toBeVisible();
  const failed = await state(page);
  expect(failed).toMatchObject({ key: pageKey(id, 2), media: 'failed', comic: { state: 'ready' } });
  expect([404, 415, 422]).toContain(failed.httpStatus);
  await expect(page.locator(STATUS)).not.toHaveText('');
  expect(await page.locator(STATUS).evaluate((element) => element.children.length)).toBe(0);
  const pageTwo = `/projects/${fixture.projectId}/assets/${id}/comic/pages/2`;
  expect(routes.count(pageTwo)).toBe(1);
  await page.locator(PAGE_RETRY).click();
  await expect.poll(() => routes.count(pageTwo)).toBe(2);
  await expect(page.locator(PAGE_RETRY)).toBeVisible();
  expect(await live(page)).toBe(0);

  await page.keyboard.press('ArrowRight');
  await expect(page.locator(POSITION)).toHaveText('Page 3 of 3');
  await expect(page.locator(SHOWN)).toBeVisible();
  await expect(page.locator(`${DIALOG} [data-unified-viewer-next]`)).toBeDisabled();
  await page.keyboard.press('ArrowRight');
  expect((await state(page)).key).toBe(pageKey(id, 3));
  await page.locator(`${DIALOG} [data-unified-viewer-previous]`).click();
  await page.locator(`${DIALOG} [data-unified-viewer-previous]`).click();
  await expect(page.locator(POSITION)).toHaveText('Page 1 of 3');
  await expect(page.locator(SHOWN)).toBeVisible();
  expect(await live(page)).toBe(1);

  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(page.locator('#test-opener')).toBeFocused();
  expect(await live(page)).toBe(0);
  expect(await page.locator(MEDIA).evaluate((media) => media.children.length)).toBe(0);
});

test('a new authoritative host revision automatically reloads the manifest and keeps fullscreen, focus and session', async ({ page }) => {
  const routes = await openPage(page);
  const id = fixture.comics.hostRefresh;
  const session = await openComic(page, id, 'Host refresh', 's1');
  await expect(page.locator(SHOWN)).toBeVisible();
  await page.locator(`${DIALOG} [data-unified-viewer-next]`).click();
  await expect(page.locator(POSITION)).toHaveText('Page 2 of 2');
  await expect(page.locator(SHOWN)).toBeVisible();
  const oldRevision = (await state(page)).comic.revision;
  const oldUrl = await page.locator(SHOWN).getAttribute('src');
  const fullscreen = page.locator(DIALOG).getByRole('button', { name: 'Enter fullscreen' });
  await fullscreen.click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await page.locator(`${DIALOG} [data-dialog-close]`).focus();
  await page.evaluate(() => {
    window.__originalDialog = document.getElementById('unified-viewer-dialog');
    window.__originalFullscreen = document.fullscreenElement;
    window.__originalFocus = document.activeElement;
  });
  fixture.rewrite('host-refresh.cbz', [
    { name: 'new-1.png', data: img.page3 },
    { name: 'new-2.png', data: img.page2 },
    { name: 'new-3.jpg', data: img.page1 },
  ]);
  const release = routes.hold(manifestPath(id));
  try {
    expect(await reconcileComic(page, id, session, 's2')).toEqual({ outcome: 'reloading' });
    await expect.poll(() => routes.count(manifestPath(id))).toBe(2);
    await expect(page.locator(SHOWN)).toHaveCount(0);
    expect(await live(page)).toBe(0);
    await expect(page.locator(`${MEDIA} [data-unified-viewer-comic-loading]`)).toBeVisible();
    expect(await state(page)).toMatchObject({ session, key: null, count: 0, fullscreen: true,
      comic: { state: 'loading', revision: null, sourceRevision: 's2' } });
    for (let index = 0; index < 3; index += 1) {
      expect(await reconcileComic(page, id, session, 's2')).toEqual({ outcome: 'unchanged' });
    }
    expect(routes.count(manifestPath(id))).toBe(2);
    expect(routes.seen.filter((entry) => entry.includes('/pages/'))).toHaveLength(2);
  } finally {
    release();
  }
  await expect(page.locator(SHOWN)).toBeVisible();
  await expect(page.locator(POSITION)).toHaveText('Page 1 of 3');
  const current = await state(page);
  expect(current).toMatchObject({ open: true, session, key: pageKey(id, 1), fullscreen: true,
    comic: { state: 'ready', sourceRevision: 's2' } });
  expect(current.comic.revision).not.toBe(oldRevision);
  expect(await page.locator(SHOWN).getAttribute('src')).not.toBe(oldUrl);
  expect(await page.locator(SHOWN).evaluate((image) => [image.naturalWidth, image.naturalHeight])).toEqual([80, 60]);
  expect(routes.seen.at(-1)).toBe(`/projects/${fixture.projectId}/assets/${id}/comic/pages/1?v=${current.comic.revision}`);
  expect(await reconcileComic(page, id, session, 's2')).toEqual({ outcome: 'unchanged' });
  expect(routes.count(manifestPath(id))).toBe(2);
  expect(await page.evaluate(() => [
    document.getElementById('unified-viewer-dialog') === window.__originalDialog,
    document.fullscreenElement === window.__originalFullscreen,
    document.activeElement === window.__originalFocus,
    document.querySelectorAll('dialog#unified-viewer-dialog[open]').length === 1,
  ])).toEqual([true, true, true, true]);
  expect(await live(page)).toBe(1);
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
  await expect(page.locator(DIALOG)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#test-opener')).toBeFocused();
  expect(await live(page)).toBe(0);
});

for (const action of ['hints', 'Retry']) {
  test(`a retirement observer's ${action} request survives outer reconciliation without duplication`, async ({ page }) => {
    const routes = await openPage(page);
    const id = fixture.comics.other;
    const session = await openComic(page, id, 'Reentrant refresh', 's1');
    await expect(page.locator(SHOWN)).toBeVisible();
    await page.locator(`${DIALOG} [data-unified-viewer-next]`).click();
    await expect(page.locator(POSITION)).toHaveText('Page 2 of 2');
    await expect(page.locator(SHOWN)).toBeVisible();
    await page.locator(`${DIALOG} [data-dialog-close]`).focus();
    const release = routes.hold(manifestPath(id));
    try {
      await page.evaluate(({ projectId, assetId, session, action }) => {
        const viewer = window.__viewer();
        const fetch = window.fetch.bind(window);
        window.__observerAttempts = [];
        window.fetch = (url, init) => {
          if (String(url).endsWith(`/assets/${assetId}/comic`)) {
            window.__observerAttempts.push({ signal: init.signal, hint: viewer.getState().comic.sourceRevision });
          }
          return fetch(url, init);
        };
        window.__retirementReasons = [];
        window.__refreshFocus = document.activeElement;
        const hint = (sourceRevision) => viewer.reconcileComic({ projectId, assetId, sourceRevision }, { session });
        window.__unobserveRetirement = viewer.observe((change) => {
          window.__retirementReasons.push(change.reason);
          if (change.reason !== 'source-changed') return;
          if (action === 'hints') {
            hint('s3');
            hint('s2');
          } else {
            window.__observerRetried = viewer.retryComic({ session });
          }
          window.__observerRequest = window.__observerAttempts.at(-1);
        });
        hint('s2');
      }, { projectId: fixture.projectId, assetId: id, session, action });
      const expected = action === 'hints' ? 3 : 2;
      expect(await page.evaluate(() => window.__observerAttempts.map((attempt) => ({
        hint: attempt.hint, aborted: attempt.signal.aborted,
      })))).toEqual(action === 'hints'
        ? [{ hint: 's3', aborted: true }, { hint: 's2', aborted: false }]
        : [{ hint: 's2', aborted: false }]);
      await expect.poll(() => routes.count(manifestPath(id))).toBe(expected);
      expect(await page.evaluate(() => window.__observerRequest.signal.aborted)).toBe(false);
      if (action === 'Retry') expect(await page.evaluate(() => window.__observerRetried)).toBe(true);
    } finally {
      release();
    }
    await expect(page.locator(SHOWN)).toBeVisible();
    await expect(page.locator(POSITION)).toHaveText('Page 1 of 2');
    expect(await state(page)).toMatchObject({ open: true, session, key: pageKey(id, 1),
      comic: { state: 'ready', sourceRevision: 's2', attempt: action === 'Retry' ? 1 : 0 } });
    expect(await reconcileComic(page, id, session, 's2')).toEqual({ outcome: 'unchanged' });
    expect(routes.count(manifestPath(id))).toBe(action === 'hints' ? 3 : 2);
    expect(routes.seen.filter((entry) => entry.includes('/pages/'))).toHaveLength(3);
    expect(await page.evaluate(() => [
      window.__observerRequest.signal.aborted,
      window.__observerAttempts.at(-1) === window.__observerRequest,
      document.activeElement === window.__refreshFocus,
      document.querySelectorAll('dialog#unified-viewer-dialog[open]').length,
      window.__retirementReasons,
    ])).toEqual([false, true, true, 1, ['source-changed', 'manifest']]);
    expect(await live(page)).toBe(1);
    await page.evaluate(() => window.__unobserveRetirement());
    await page.keyboard.press('Escape');
    await expect(page.locator('#test-opener')).toBeFocused();
    expect(await live(page)).toBe(0);
  });
}

test('a new host hint recovers a permanent 422 without Retry and never loops on the same failed hint', async ({ page }) => {
  const routes = await openPage(page);
  const id = fixture.comics.one;
  routes.control(manifestPath(id), { status: 422, contentType: 'text/plain', body: 'unreadable' });
  const session = await openComic(page, id, 'Recovery', 's1');
  await expect(page.locator(STATUS)).toHaveText('This comic could not be read.');
  await expect(page.locator(COMIC_RETRY)).toHaveCount(0);
  expect(await state(page)).toMatchObject({ comic: { state: 'failed', httpStatus: 422, retryable: false } });
  const release = routes.hold(manifestPath(id));
  try {
    expect(await reconcileComic(page, id, session, 's2')).toEqual({ outcome: 'reloading' });
    await expect.poll(() => routes.count(manifestPath(id))).toBe(2);
    await expect(page.locator(`${MEDIA} [data-unified-viewer-comic-loading]`)).toBeVisible();
    expect(await reconcileComic(page, id, session, 's2')).toEqual({ outcome: 'unchanged' });
  } finally {
    release();
  }
  await expect(page.locator(STATUS)).toHaveText('This comic could not be read.');
  await expect(page.locator(COMIC_RETRY)).toHaveCount(0);
  expect(await reconcileComic(page, id, session, 's2')).toEqual({ outcome: 'unchanged' });
  await page.waitForTimeout(150);
  expect(routes.count(manifestPath(id))).toBe(2);
  routes.control(manifestPath(id), fakeManifest(id, { pages: [true] }));
  routes.control(`/projects/${fixture.projectId}/assets/${id}/comic/pages/1`,
    { status: 200, contentType: 'image/png', body: img.page2 });
  expect(await reconcileComic(page, id, session, 's3')).toEqual({ outcome: 'reloading' });
  await expect(page.locator(SHOWN)).toBeVisible();
  await expect(page.locator(POSITION)).toHaveText('Page 1 of 1');
  expect(routes.count(manifestPath(id))).toBe(3);
  expect(await state(page)).toMatchObject({ session, key: pageKey(id, 1),
    comic: { state: 'ready', sourceRevision: 's3', error: null, httpStatus: null } });
  await page.keyboard.press('Escape');
  await expect(page.locator('#test-opener')).toBeFocused();
  expect(await live(page)).toBe(0);
});

test('a newer host hint wins while an obsolete manifest response is held', async ({ page }) => {
  const routes = await openPage(page);
  const id = fixture.comics.controlled;
  let attempts = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route(`**${manifestPath(id)}`, async (route) => {
    const attempt = ++attempts;
    if (attempt === 1) await gate;
    await route.fulfill(fakeManifest(id, {
      revision: (attempt === 1 ? 'a' : 'b').repeat(32), pages: attempt === 1 ? [true, true] : [true],
    })).catch(() => {});
  });
  routes.control(`/projects/${fixture.projectId}/assets/${id}/comic/pages/1`,
    { status: 200, contentType: 'image/png', body: img.page2 });
  const session = await openComic(page, id, 'Pending refresh', 's1');
  try {
    await expect.poll(() => attempts).toBe(1);
    expect(await reconcileComic(page, id, session, 's2')).toEqual({ outcome: 'reloading' });
    await expect(page.locator(SHOWN)).toBeVisible();
    expect(attempts).toBe(2);
    expect(await reconcileComic(page, id, session, 's2')).toEqual({ outcome: 'unchanged' });
  } finally {
    release();
  }
  await page.waitForTimeout(150);
  expect(await state(page)).toMatchObject({ session, key: pageKey(id, 1), count: 1,
    comic: { state: 'ready', revision: 'b'.repeat(32), sourceRevision: 's2' } });
  expect(routes.seen.filter((entry) => entry.includes('/pages/')))
    .toEqual([`/projects/${fixture.projectId}/assets/${id}/comic/pages/1?v=${'b'.repeat(32)}`]);
  expect(attempts).toBe(2);
});

test('a one-page comic has disabled Previous/Next; an empty comic and an unavailable first page are shown as such', async ({ page }) => {
  const routes = await openPage(page);
  await openComic(page, fixture.comics.one);
  await expect(page.locator(SHOWN)).toBeVisible();
  await expect(page.locator(POSITION)).toHaveText('Page 1 of 1');
  await expect(page.locator(`${DIALOG} [data-unified-viewer-next]`)).toBeDisabled();
  await expect(page.locator(`${DIALOG} [data-unified-viewer-previous]`)).toBeDisabled();

  const id = fixture.comics.controlled;
  routes.control(manifestPath(id), fakeManifest(id, { pages: [] }), { once: true });
  await openComic(page, id);
  await expect(page.locator(STATUS)).toHaveText('This comic contains no supported pages.');
  expect(await state(page)).toMatchObject({ count: 0, key: null, comic: { state: 'ready', empty: true } });
  await expect(page.locator(`${DIALOG} [data-unified-viewer-controls]`)).toBeHidden();
  await expect(page.locator(COMIC_RETRY)).toHaveCount(0);
  expect(await live(page)).toBe(0);

  routes.control(manifestPath(id), fakeManifest(id, { pages: [false, true] }), { once: true });
  const pageTwo = `/projects/${fixture.projectId}/assets/${id}/comic/pages/2`;
  routes.control(pageTwo, { status: 200, contentType: 'image/png', body: img.page2 });
  await openComic(page, id);
  await expect(page.locator(STATUS)).toHaveText('Page unavailable.');
  await expect(page.locator(POSITION)).toHaveText('Page 1 of 2');
  expect((await state(page)).key).toBe(pageKey(id, 1));
  expect(routes.count(`/projects/${fixture.projectId}/assets/${id}/comic/pages/1`)).toBe(0);
  await page.locator(`${DIALOG} [data-unified-viewer-next]`).click();
  await expect(page.locator(SHOWN)).toBeVisible();
  await page.locator(`${DIALOG} [data-unified-viewer-previous]`).click();
  await expect(page.locator(STATUS)).toHaveText('Page unavailable.');
  expect(routes.count(`/projects/${fixture.projectId}/assets/${id}/comic/pages/1`)).toBe(0);
  expect(await live(page)).toBe(0);
});

test('closing, switching comics and opening an image while a manifest is held leave no stale result', async ({ page }) => {
  const routes = await openPage(page);
  const three = fixture.comics.three;
  const other = fixture.comics.other;

  // Close with a held manifest: focus returns; the late answer reopens nothing.
  let release = routes.hold(manifestPath(three));
  await openComic(page, three);
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(page.locator('#test-opener')).toBeFocused();
  release();
  await page.waitForTimeout(300);
  await expect(page.locator(DIALOG)).toBeHidden();
  expect(await state(page)).toMatchObject({ open: false, comic: null });
  expect(routes.seen.filter((entry) => entry.includes('/pages/'))).toHaveLength(0);

  // Switch comics while the first manifest is held.
  release = routes.hold(manifestPath(three));
  await openComic(page, three);
  const second = await openComic(page, other, 'Other');
  await expect(page.locator(SHOWN)).toBeVisible();
  await expect(page.locator(POSITION)).toHaveText('Page 1 of 2');
  release();
  await page.waitForTimeout(300);
  expect(await state(page)).toMatchObject({ session: second, key: pageKey(other, 1), comic: { state: 'ready' } });
  await expect(page.locator(STATUS)).toHaveText('');
  expect(routes.seen.filter((entry) => entry.includes(`/assets/${three}/comic/pages/`))).toHaveLength(0);

  // Open a normal image while a comic manifest is held.
  release = routes.hold(manifestPath(three));
  await openComic(page, three);
  const imageSession = await page.evaluate(() => {
    const viewer = window.__viewer();
    return viewer.open({
      key: 'images', mode: 'sequence',
      items: [{ projectId: 1, assetId: 501, title: 'still.webp', mediaUrl: '/test-media/still', revision: 'r1' }],
    }, { opener: document.getElementById('test-opener') });
  });
  await expect(page.locator(SHOWN)).toBeVisible();
  release();
  await page.waitForTimeout(300);
  expect(await state(page)).toMatchObject({ session: imageSession, comic: null, key: 'p:1|a:501', media: 'loaded' });
  await expect(page.locator(POSITION)).toHaveText('1 of 1');
  expect(routes.seen.filter((entry) => entry.includes(`/assets/${three}/comic/pages/`))).toHaveLength(0);
  expect(await page.evaluate(() => document.querySelectorAll('dialog#unified-viewer-dialog').length)).toBe(1);

  await page.locator(`${DIALOG} [data-dialog-close]`).click();
  await expect(page.locator('#test-opener')).toBeFocused();
  expect(await live(page)).toBe(0);
});

test('a failed page retries only on explicit Retry; a source failure offers Retry when recoverable', async ({ page }) => {
  const routes = await openPage(page);
  const id = fixture.comics.one;
  const pageOne = `/projects/${fixture.projectId}/assets/${id}/comic/pages/1`;
  routes.control(pageOne, { status: 503, contentType: 'text/plain', body: '<b>busy</b>' }, { once: true });
  await openComic(page, id);
  await expect(page.locator(STATUS)).toHaveText('This page is temporarily unavailable. Try again in a moment.');
  expect(await state(page)).toMatchObject({ media: 'failed', httpStatus: 503, key: pageKey(id, 1) });
  await page.waitForTimeout(300);
  expect(routes.count(pageOne)).toBe(1);
  await page.locator(PAGE_RETRY).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator(SHOWN)).toBeVisible();
  expect(routes.count(pageOne)).toBe(2);
  expect(await page.evaluate(() => document.getElementById('unified-viewer-dialog').contains(document.activeElement))).toBe(true);

  // Source level: an HTML login page is refused, then Retry loads the real manifest.
  routes.control(manifestPath(id), { status: 200, contentType: 'text/html', body: '<html><script>window.__pwned = 1</script>Sign in</html>' }, { once: true });
  await openComic(page, id);
  await expect(page.locator(STATUS)).toHaveText('This comic could not be loaded.');
  await expect(page.locator(COMIC_RETRY)).toBeVisible();
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  expect(await page.locator(MEDIA).evaluate((media) => media.querySelectorAll('script').length)).toBe(0);
  await page.locator(COMIC_RETRY).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator(SHOWN)).toBeVisible();
  await expect(page.locator(`${DIALOG} [data-dialog-close]`)).toBeFocused();

  // A missing comic is a permanent source failure: no Retry, no page request.
  const before = routes.seen.length;
  const missing = await page.evaluate(({ projectId }) => window.__viewer().openComic(
    { projectId, assetId: 999999 }, { opener: document.getElementById('test-opener') },
  ), { projectId: fixture.projectId });
  expect(missing).toBeGreaterThan(0);
  await expect(page.locator(STATUS)).toHaveText('This comic could not be found.');
  await expect(page.locator(COMIC_RETRY)).toHaveCount(0);
  expect(await state(page)).toMatchObject({ comic: { state: 'failed', httpStatus: 404, retryable: false } });
  expect(routes.seen.slice(before)).toEqual([manifestPath(999999)]);
  await page.keyboard.press('Escape');
  await expect(page.locator('#test-opener')).toBeFocused();
});

test('a real page 409 retires the revision; explicit Retry loads the new manifest from page 1', async ({ page }) => {
  const routes = await openPage(page);
  const id = fixture.comics.changing;
  const session = await openComic(page, id, 'Changing');
  await expect(page.locator(SHOWN)).toBeVisible();
  const first = (await state(page)).comic.revision;
  await page.locator(`${DIALOG} [data-unified-viewer-next]`).click();
  await expect(page.locator(SHOWN)).toBeVisible();
  await expect(page.locator(POSITION)).toHaveText('Page 2 of 3');
  expect(await live(page)).toBe(1);

  fixture.rewrite('changing.cbz', [
    { name: 'n1.png', data: img.page3 },
    { name: 'n2.jpg', data: img.page1 },
  ]);
  await page.locator(`${DIALOG} [data-unified-viewer-next]`).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator(STATUS)).toHaveText('This comic changed while it was open. Retry to load the current version.');
  expect(await state(page)).toMatchObject({
    open: true, session, key: null, count: 0, comic: { state: 'changed', revision: null, httpStatus: 409 },
  });
  await expect(page.locator(SHOWN)).toHaveCount(0);
  await expect(page.locator(`${DIALOG} [data-unified-viewer-controls]`)).toBeHidden();
  expect(await live(page)).toBe(0);
  await expect(page.locator(`${DIALOG} [data-dialog-close]`)).toBeFocused();
  const manifests = routes.count(manifestPath(id));
  await page.waitForTimeout(300);
  expect(routes.count(manifestPath(id))).toBe(manifests);

  await page.locator(COMIC_RETRY).click();
  await expect(page.locator(SHOWN)).toBeVisible();
  await expect(page.locator(POSITION)).toHaveText('Page 1 of 2');
  const recovered = await state(page);
  expect(recovered).toMatchObject({ session, key: pageKey(id, 1), comic: { state: 'ready' } });
  expect(recovered.comic.revision).not.toBe(first);
  expect(routes.seen.at(-1)).toContain(`?v=${recovered.comic.revision}`);
  expect(await page.locator(SHOWN).evaluate((image) => [image.naturalWidth, image.naturalHeight])).toEqual([80, 60]);
  expect(await page.evaluate(() => document.querySelectorAll('dialog#unified-viewer-dialog[open]').length)).toBe(1);
});

test('a controlled 409 with a held old page: late old media never installs and Retry stays explicit', async ({ page }) => {
  const routes = await openPage(page);
  const id = fixture.comics.controlled;
  const pageOne = `/projects/${fixture.projectId}/assets/${id}/comic/pages/1`;
  const pageTwo = `/projects/${fixture.projectId}/assets/${id}/comic/pages/2`;
  routes.control(manifestPath(id), fakeManifest(id, { revision: 'd'.repeat(32), pages: [true, true] }), { once: true });
  const releaseOne = routes.hold(pageOne);
  routes.control(pageOne, { status: 200, contentType: 'image/png', body: img.page2 });
  routes.control(pageTwo, { status: 409, contentType: 'text/plain', body: 'stale' }, { once: true });
  await openComic(page, id);
  await expect.poll(() => routes.count(pageOne)).toBe(1);
  await page.evaluate(() => window.__viewer().next());
  await expect(page.locator(STATUS)).toHaveText('This comic changed while it was open. Retry to load the current version.');
  releaseOne();
  await page.waitForTimeout(300);
  await expect(page.locator(SHOWN)).toHaveCount(0);
  expect(await live(page)).toBe(0);
  expect(await comicState(page)).toBe('changed');

  routes.control(manifestPath(id), { status: 409, contentType: 'text/plain', body: 'conflict' }, { once: true });
  await page.locator(COMIC_RETRY).click();
  await expect(page.locator(STATUS)).toHaveText('This comic could not be loaded.');
  await page.waitForTimeout(300);
  expect(await state(page)).toMatchObject({ comic: { state: 'failed', retryable: true, httpStatus: 409 } });
  const manifests = routes.count(manifestPath(id));
  await page.locator(COMIC_RETRY).click();
  await expect(page.locator(SHOWN)).toBeVisible();
  expect(routes.count(manifestPath(id))).toBe(manifests + 1);
  expect(await state(page)).toMatchObject({ key: pageKey(id, 1), comic: { state: 'ready' } });
});

test('fullscreen survives a loading page and a 409 retirement; Escape exits it first, then closes', async ({ page }) => {
  const routes = await openPage(page);
  const id = fixture.comics.controlled;
  const revision = 'e'.repeat(32);
  const pageOne = `/projects/${fixture.projectId}/assets/${id}/comic/pages/1`;
  routes.control(manifestPath(id), fakeManifest(id, { revision, pages: [true] }), { once: true });
  const releaseOne = routes.hold(pageOne);
  routes.control(pageOne, { status: 409, contentType: 'text/plain', body: 'stale' }, { once: true });
  await openComic(page, id);
  await expect.poll(() => routes.count(pageOne)).toBe(1);
  await page.locator(`${DIALOG}`).getByRole('button', { name: 'Enter fullscreen' }).click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  expect(await state(page)).toMatchObject({ fullscreen: true, media: 'loading' });
  releaseOne();
  await expect(page.locator(STATUS)).toHaveText('This comic changed while it was open. Retry to load the current version.');
  expect(await state(page)).toMatchObject({ fullscreen: true, open: true, comic: { state: 'changed' } });
  await page.locator(COMIC_RETRY).click();
  await expect(page.locator(SHOWN)).toBeVisible();
  expect(await state(page)).toMatchObject({ fullscreen: true, comic: { state: 'ready' } });

  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
  await expect(page.locator(DIALOG)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(page.locator('#test-opener')).toBeFocused();
  expect(await live(page)).toBe(0);
  expect(await state(page)).toMatchObject({ open: false, fullscreen: false });
});

// ─── C1c: reading direction and spread grouping ──────────────────────────────
//
// Model and navigation, read from getState().reader. Since C1e the content
// participant also renders the group (see the C1e tests below), so a few
// assertions here name the second page too. Reader options are set through
// the controller API here; the C1f tests below use the visible controls.

const NEXT = `${DIALOG} [data-unified-viewer-next]`;
const PREVIOUS = `${DIALOG} [data-unified-viewer-previous]`;

const readerState = (page) => page.evaluate(() => {
  const reader = window.__viewer().getState().reader;
  return reader && {
    ...reader,
    groupItems: reader.groupItems.map((item) => item.position),
    visibleItems: reader.visibleItems.map((item) => item.position),
  };
});
const setReader = (page, patch) => page.evaluate((options) => {
  const result = window.__viewer().setComicReaderOptions(options);
  return result && { changed: result.changed };
}, patch);
const pageRequests = (routes) => routes.seen.filter((entry) => entry.includes('/comic/pages/')).length;
const shownKey = async (page, key) => {
  await expect.poll(async () => {
    const current = await state(page);
    return current.media === 'loaded' && current.key === key;
  }).toBe(true);
};

test('C1c: LTR and RTL arrows step single pages in canonical order without wrapping', async ({ page }) => {
  const routes = await openPage(page);
  const id = fixture.comics.seven;
  const session = await openComic(page, id, 'Seven pages');
  await shownKey(page, pageKey(id, 1));
  expect(await readerState(page)).toMatchObject({ direction: 'ltr', layout: 'single', alignment: 'cover-alone', label: 'Page 1 of 7' });

  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator(POSITION)).toHaveText('Page 3 of 7');
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator(POSITION)).toHaveText('Page 2 of 7');
  await shownKey(page, pageKey(id, 2));

  const requests = pageRequests(routes);
  expect(await setReader(page, { direction: 'rtl' })).toEqual({ changed: true });
  expect(pageRequests(routes)).toBe(requests);
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator(POSITION)).toHaveText('Page 3 of 7');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator(POSITION)).toHaveText('Page 1 of 7');
  // RTL Previous at page 1 does not wrap.
  await page.keyboard.press('ArrowRight');
  await expect(page.locator(POSITION)).toHaveText('Page 1 of 7');
  await expect(page.locator(PREVIOUS)).toBeDisabled();
  await shownKey(page, pageKey(id, 1));
  // Canonical source order is untouched.
  expect(await page.evaluate(() => window.__viewer().getState().source.items.map((item) => item.position)))
    .toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(await state(page)).toMatchObject({ session, open: true, comic: { state: 'ready', pageCount: 7 } });
  expect(await page.locator(SHOWN).count()).toBe(1);
});

test('C1c/C1e: spread grouping, both alignments and anchor preservation, with direction changes fetching nothing', async ({ page }) => {
  const routes = await openPage(page);
  const id = fixture.comics.seven;
  const session = await openComic(page, id, 'Seven pages');
  await shownKey(page, pageKey(id, 1));
  expect(await page.evaluate((key) => window.__viewer().select(key), pageKey(id, 5))).toBe(true);
  await shownKey(page, pageKey(id, 5));
  await page.locator(SHOWN).evaluate((image) => { image.dataset.c1cMarker = 'anchor'; });
  const requests = pageRequests(routes);
  const manifests = routes.count(manifestPath(id));

  expect(await setReader(page, { layout: 'spread' })).toEqual({ changed: true });
  expect(await readerState(page)).toMatchObject({
    anchorKey: pageKey(id, 5), anchorPosition: 5, groupPositions: [4, 5], groupItems: [4, 5], visibleItems: [4, 5],
    label: 'Pages 4–5 of 7', canPrevious: true, canNext: true,
  });
  expect(await setReader(page, { alignment: 'pair-from-first' })).toEqual({ changed: true });
  expect(await readerState(page)).toMatchObject({ anchorPosition: 5, groupPositions: [5, 6], label: 'Pages 5–6 of 7' });
  expect(await setReader(page, { direction: 'rtl' })).toEqual({ changed: true });
  expect(await readerState(page)).toMatchObject({ anchorPosition: 5, groupPositions: [5, 6], visibleItems: [6, 5] });
  expect(await setReader(page, { direction: 'rtl' })).toEqual({ changed: false });
  expect(await setReader(page, { layout: 'single' })).toEqual({ changed: true });
  expect(await readerState(page)).toMatchObject({ anchorPosition: 5, groupPositions: [5], label: 'Page 5 of 7' });

  // C1e: only the companions entering a group were fetched ([4,5] added 4,
  // [5,6] added 6); the anchor was never refetched or replaced, the
  // direction change fetched nothing, and no manifest was requested.
  await expect.poll(() => pageRequests(routes)).toBe(requests + 2);
  expect(routes.seen.filter((entry) => entry.includes('/comic/pages/')).slice(-2)
    .map((entry) => Number(entry.match(/\/comic\/pages\/(\d+)/)?.[1]))).toEqual([4, 6]);
  expect(routes.count(manifestPath(id))).toBe(manifests);
  expect(await page.locator(SHOWN).count()).toBe(1);
  expect(await page.locator(SHOWN).evaluate((image) => image.dataset.c1cMarker)).toBe('anchor');
  await expect(page.locator(POSITION)).toHaveText('Page 5 of 7');
  expect(await setReader(page, { direction: 'sideways' })).toBe(null);

  // Cover Alone spreads, read RTL by keyboard: [1] [2,3] [4,5] [6,7].
  await setReader(page, { layout: 'spread', alignment: 'cover-alone' });
  await page.locator(PREVIOUS).click();
  expect(await readerState(page)).toMatchObject({ anchorPosition: 2, groupPositions: [2, 3], visibleItems: [3, 2] });
  await page.keyboard.press('ArrowRight');
  expect(await readerState(page)).toMatchObject({ anchorPosition: 1, groupPositions: [1], canPrevious: false });
  const walk = [];
  for (let index = 0; index < 4; index += 1) {
    await page.keyboard.press('ArrowLeft');
    walk.push((await readerState(page)).groupPositions);
  }
  expect(walk).toEqual([[2, 3], [4, 5], [6, 7], [6, 7]]);
  await expect(page.locator(NEXT)).toBeDisabled();
  await shownKey(page, pageKey(id, 6));

  // Pair from Page 1, LTR: [1,2] [3,4] [5,6] [7].
  await setReader(page, { direction: 'ltr', alignment: 'pair-from-first' });
  expect(await readerState(page)).toMatchObject({ anchorPosition: 6, groupPositions: [5, 6], canNext: true });
  await expect(page.locator(NEXT)).toBeEnabled();
  await page.keyboard.press('ArrowRight');
  expect(await readerState(page)).toMatchObject({ anchorPosition: 7, groupPositions: [7], label: 'Page 7 of 7', canNext: false });
  const seenBefore = routes.seen.length;
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  expect(await readerState(page)).toMatchObject({ anchorPosition: 3, groupPositions: [3, 4] });
  await shownKey(page, pageKey(id, 3));
  // C1e: both members of [3,4] are shown; only spread members were requested.
  await expect(page.locator(SHOWN)).toHaveCount(2);
  expect(await page.locator(SHOWN).evaluateAll((images) => images.map((image) => image.alt))).toEqual(['Page 3', 'Page 4']);
  const requested = routes.seen.slice(seenBefore).map((entry) => Number(entry.match(/\/comic\/pages\/(\d+)/)?.[1]));
  expect(requested.every((position) => [3, 4, 5, 6].includes(position))).toBe(true);
  expect(requested.slice(-2).sort()).toEqual([3, 4]);
  await expect(page.locator(POSITION)).toHaveText('Pages 3–4 of 7');
  expect((await state(page)).session).toBe(session);
  await expect.poll(() => live(page)).toBe(2);
});

test('C1c: empty, one-page and unavailable pages keep their groups', async ({ page }) => {
  const routes = await openPage(page);
  await openComic(page, fixture.comics.one);
  await shownKey(page, pageKey(fixture.comics.one, 1));
  for (const alignment of ['cover-alone', 'pair-from-first']) {
    await setReader(page, { layout: 'spread', alignment });
    expect(await readerState(page)).toMatchObject({ groupPositions: [1], groupCount: 1, canPrevious: false, canNext: false, label: 'Page 1 of 1' });
    await page.keyboard.press('ArrowRight');
    expect((await state(page)).key).toBe(pageKey(fixture.comics.one, 1));
  }
  await expect(page.locator(NEXT)).toBeDisabled();

  const id = fixture.comics.controlled;
  routes.control(manifestPath(id), fakeManifest(id, { pages: [] }), { once: true });
  await openComic(page, id);
  await expect(page.locator(STATUS)).toHaveText('This comic contains no supported pages.');
  // A new session starts from the remembered options (C1f; C1c started from
  // the defaults); an empty comic has no group.
  expect(await readerState(page)).toMatchObject({
    layout: 'spread', alignment: 'pair-from-first', anchorKey: null, groupKeys: [], visibleItems: [], label: '',
  });
  expect(await setReader(page, { alignment: 'cover-alone' })).toEqual({ changed: true });
  expect(await readerState(page)).toMatchObject({ layout: 'spread', alignment: 'cover-alone', groupKeys: [], canNext: false });
  await page.keyboard.press('ArrowRight');
  expect(await state(page)).toMatchObject({ key: null, count: 0 });

  routes.control(manifestPath(id), fakeManifest(id, { pages: [true, false, false, true, true] }), { once: true });
  for (const position of [1, 4, 5]) {
    routes.control(`/projects/${fixture.projectId}/assets/${id}/comic/pages/${position}`, { status: 200, contentType: 'image/png', body: img.page2 });
  }
  await openComic(page, id);
  await shownKey(page, pageKey(id, 1));
  await setReader(page, { layout: 'spread' });
  await page.keyboard.press('ArrowRight');
  // Both members of [2,3] are unavailable and neither is skipped.
  expect(await readerState(page)).toMatchObject({ anchorPosition: 2, groupPositions: [2, 3], label: 'Pages 2–3 of 5' });
  await expect(page.locator(STATUS)).toHaveText('Page 2 is unavailable. Page 3 is unavailable.');
  await expect(page.locator(`${MEDIA} [data-unified-viewer-page-unavailable]`)).toHaveCount(2);
  expect(routes.seen.filter((entry) => /\/comic\/pages\/[23]\b/.test(entry))).toHaveLength(0);
  await page.keyboard.press('ArrowRight');
  expect(await readerState(page)).toMatchObject({ anchorPosition: 4, groupPositions: [4, 5], canNext: false });
  await shownKey(page, pageKey(id, 4));
  await setReader(page, { alignment: 'pair-from-first' });
  expect(await readerState(page)).toMatchObject({ anchorPosition: 4, groupPositions: [3, 4], canNext: true });
  expect(await live(page)).toBe(1);
});

test('C1c: session, focus and fullscreen survive reader-option changes and spread navigation', async ({ page }) => {
  await openPage(page);
  const id = fixture.comics.seven;
  const session = await openComic(page, id, 'Seven pages');
  await shownKey(page, pageKey(id, 1));
  await page.locator(DIALOG).getByRole('button', { name: 'Enter fullscreen' }).click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await page.locator(NEXT).focus();
  await setReader(page, { direction: 'rtl', layout: 'spread', alignment: 'pair-from-first' });
  await expect(page.locator(NEXT)).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  expect(await readerState(page)).toMatchObject({ anchorPosition: 3, groupPositions: [3, 4], visibleItems: [4, 3] });
  await shownKey(page, pageKey(id, 3));
  await setReader(page, { direction: 'ltr' });
  await setReader(page, { layout: 'single' });
  expect(await state(page)).toMatchObject({ session, open: true, fullscreen: true, key: pageKey(id, 3) });
  expect(await page.evaluate(() => document.fullscreenElement?.matches('[data-unified-viewer-card]'))).toBe(true);
  expect(await page.evaluate(() => document.querySelectorAll('dialog#unified-viewer-dialog[open]').length)).toBe(1);

  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
  await expect(page.locator(DIALOG)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(page.locator('#test-opener')).toBeFocused();
  expect(await live(page)).toBe(0);
  expect(await page.evaluate(() => window.__viewer().setComicReaderOptions({ direction: 'rtl' }))).toBe(null);
});

test('C1c: image sources keep their arrow keys, wrapping and no reader state', async ({ page }) => {
  await openPage(page);
  // A comic set to RTL spreads first, so nothing can leak into the image session.
  await openComic(page, fixture.comics.seven, 'Seven pages');
  await shownKey(page, pageKey(fixture.comics.seven, 1));
  await setReader(page, { direction: 'rtl', layout: 'spread' });
  await page.locator('#test-opener').focus();
  const session = await page.evaluate(() => window.__viewer().open({
    key: 'c1c-images',
    mode: 'sequence',
    wrap: true,
    items: [1, 2, 3].map((id) => ({ projectId: 1, assetId: id, title: `image-${id}`, mediaUrl: `/test-media/${id}.webp` })),
  }, { opener: document.getElementById('test-opener'), autoplay: false }));
  expect(session).toBeGreaterThan(0);
  await expect(page.locator(POSITION)).toHaveText('1 of 3');
  expect(await page.evaluate(() => window.__viewer().getState().reader)).toBe(null);
  expect(await setReader(page, { direction: 'ltr' })).toBe(null);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator(POSITION)).toHaveText('2 of 3');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator(POSITION)).toHaveText('3 of 3');
  await expect(page.locator(SHOWN)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(page.locator('#test-opener')).toBeFocused();
});

// ─── C1e: dual-page comic media in the production content participant ──────
//
// The real viewer's own content participant and viewport (no test harness
// viewport): the C1d composition is mounted in the shared media region and
// both pages of a group are fetched, decoded and shown independently.

const SPREAD = `${MEDIA} [data-viewer-content="spread"]`;
const slotOf = (id, position) => `${MEDIA} [data-viewer-spread-slot="${pageKey(id, position)}"]`;
const pageImage = (id, position) => `${slotOf(id, position)} img`;
const pagePath = (id, position) => `/projects/${fixture.projectId}/assets/${id}/comic/pages/${position}`;
const pagesSeen = (routes, id) => routes.seen
  .filter((entry) => entry.includes(`/assets/${id}/comic/pages/`))
  .map((entry) => Number(entry.match(/\/pages\/(\d+)/)[1]));
const box = (page, selector) => page.locator(selector).evaluate((element) => {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
});
const spreadTransform = (page) => page.locator(SPREAD).evaluate((element) => element.style.transform);
const mediaView = (page) => page.evaluate(() => window.__viewer().media.getState().view);
const markImages = (page) => page.locator(`${SPREAD} img`).evaluateAll((images) => {
  images.forEach((image) => { image.dataset.c1eMarker = image.alt; });
});
const markers = (page) => page.locator(`${SPREAD} img`).evaluateAll((images) => images.map((image) => image.dataset.c1eMarker || null));

function recordWrites(page) {
  const writes = [];
  page.on('request', (request) => {
    if (!['GET', 'HEAD'].includes(request.method())) writes.push(`${request.method()} ${request.url()}`);
  });
  return writes;
}

// Measure the actual image rectangles, or frames while a page is pending/failed.
// 0.25 CSS px allows Chromium's 1/64 px layout rounding at percentage edges.
async function expectGaplessSpread(page, { fitted = true, loaded = true } = {}) {
  if (loaded) await expect.poll(() => page.evaluate(() => window.__viewer().media.getState().pages.map((entry) => entry.status)))
    .toEqual(['loaded', 'loaded']);
  const entries = await page.locator(SPREAD).evaluate((element) => {
    const rect = (node) => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right,
      top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    return Array.from(element.querySelectorAll('[data-viewer-spread-slot]')).map((slot) => {
      const image = slot.querySelector('img');
      return { frame: rect(slot.querySelector('[data-viewer-spread-page]')), image: image ? rect(image) : null,
        natural: image ? image.naturalWidth / image.naturalHeight : null, key: slot.dataset.viewerSpreadSlot };
    }).sort((a, b) => a.frame.left - b.frame.left);
  });
  expect(entries).toHaveLength(2);
  const [left, right] = entries;
  for (const field of ['frame', ...(left.image && right.image ? ['image'] : [])]) {
    const separation = right[field].left - left[field].right;
    expect(Math.abs(separation)).toBeLessThanOrEqual(0.25);
    expect(separation).toBeGreaterThanOrEqual(-0.25);
  }
  const media = await box(page, MEDIA);
  for (const entry of entries) {
    if (entry.image) {
      expect(entry.image.width / entry.image.height).toBeCloseTo(entry.natural, 2);
      expect(entry.image.width).toBeCloseTo(entry.frame.width, 1);
      expect(entry.image.height).toBeCloseTo(entry.frame.height, 1);
    }
    expect(entry.frame.top + entry.frame.height / 2).toBeCloseTo(media.top + media.height / 2
      + (await mediaView(page)).panY, 0);
    if (fitted) {
      expect(entry.frame.left).toBeGreaterThanOrEqual(media.left - 0.25);
      expect(entry.frame.right).toBeLessThanOrEqual(media.right + 0.25);
      expect(entry.frame.top).toBeGreaterThanOrEqual(media.top - 0.25);
      expect(entry.frame.bottom).toBeLessThanOrEqual(media.bottom + 0.25);
    }
  }
  return entries.map((entry) => entry.key);
}

async function expectSpreadChrome(page) {
  const geometry = await page.locator(DIALOG).evaluate(async (dialog) => {
    const stage = dialog.querySelector('[data-unified-viewer-stage]');
    const media = dialog.querySelector('[data-unified-viewer-media]');
    const navigation = dialog.querySelector('[data-unified-viewer-controls]');
    const spread = media.querySelector('[data-viewer-content="spread"]');
    const rect = (element) => element.getBoundingClientRect().toJSON();
    const measureMedia = () => ({
      stage: rect(stage), media: rect(media), spread: rect(spread),
      pages: [...spread.querySelectorAll('img')].map(rect),
      view: dialog.__creatorCrateUnifiedViewer.media.getState().view,
    });
    const settle = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const fullscreen = document.fullscreenElement;
    const chrome = {
      navigation: rect(navigation),
      positionedOverStage: getComputedStyle(navigation).position === 'absolute' && navigation.offsetParent === stage,
      status: rect(dialog.querySelector('[data-unified-viewer-status]')),
      footer: rect(dialog.querySelector('[data-unified-viewer-context]')),
      header: rect(dialog.querySelector('.app-dialog-header')),
      fullscreen: fullscreen ? rect(fullscreen) : null,
      viewport: { left: 0, top: 0, right: innerWidth, bottom: innerHeight },
    };
    const withNavigation = measureMedia();
    const wasHidden = navigation.hidden;
    navigation.hidden = true;
    try {
      await settle();
      return { ...chrome, withNavigation, withoutNavigation: measureMedia() };
    } finally {
      navigation.hidden = wasHidden;
      await settle();
    }
  });

  const { navigation, status, footer, header, fullscreen, viewport, withNavigation, withoutNavigation } = geometry;
  const { stage, media } = withNavigation;
  // Allow subpixel rounding at Chromium's independently measured edges.
  const tolerance = 0.25;
  expect(stage.height).toBeGreaterThan(0);
  expect(navigation.width).toBeGreaterThan(0);
  expect(navigation.height).toBeGreaterThan(0);
  expect(geometry.positionedOverStage, 'navigation is positioned over the stage').toBe(true);
  expect(navigation.left).toBeGreaterThanOrEqual(stage.left - tolerance);
  expect(navigation.right).toBeLessThanOrEqual(stage.right + tolerance);
  expect(navigation.top).toBeGreaterThanOrEqual(stage.top - tolerance);
  expect(navigation.bottom).toBeLessThanOrEqual(stage.bottom + tolerance);
  expect(navigation.bottom, 'navigation clears the footer').toBeLessThanOrEqual(footer.top + tolerance);
  if (status.height > 0) expect(status.bottom).toBeLessThanOrEqual(navigation.top + tolerance);

  if (fullscreen) {
    for (const edge of ['left', 'top', 'right', 'bottom']) {
      expect(Math.abs(fullscreen[edge] - viewport[edge]), `fullscreen card fills viewport: ${edge}`).toBeLessThanOrEqual(tolerance);
      expect(Math.abs(stage[edge] - fullscreen[edge]), `stage fills fullscreen: ${edge}`).toBeLessThanOrEqual(tolerance);
      expect(Math.abs(media[edge] - stage[edge]), `media fills fullscreen stage: ${edge}`).toBeLessThanOrEqual(tolerance);
    }
    expect(header.bottom).toBeLessThanOrEqual(navigation.top + tolerance);
    expect(footer.top, 'footer overlays the fullscreen stage').toBeLessThan(stage.bottom - tolerance);
  } else {
    expect(stage.bottom, 'stage clears the dialog footer').toBeLessThanOrEqual(footer.top + tolerance);
  }
  expect(withoutNavigation, 'removing navigation leaves stage, media and fitted pages unchanged').toEqual(withNavigation);
}

for (const sample of ['equal', 'mixed']) {
  test('gapless compiled CBZ: ' + sample + ' pages across directions, alignments, viewport sizes and fullscreen', async ({ page }) => {
    await openPage(page);
    const id = fixture.comics[sample];
    await openComic(page, id, 'Seam geometry');
    await shownKey(page, pageKey(id, 1));
    for (const size of [{ width: 375, height: 760 }, { width: 1280, height: 900 }, { width: 1440, height: 500 }]) {
      await page.setViewportSize(size);
      for (const alignment of ['cover-alone', 'pair-from-first']) {
        await setReader(page, { layout: 'single', direction: 'ltr' });
        // Reopen at the cover to make each grouping check independent.
        await page.locator(CLOSE).click();
        await openComic(page, id, 'Seam geometry');
        await shownKey(page, pageKey(id, 1));
        await setReader(page, { layout: 'spread', alignment, direction: 'ltr' });
        if (alignment === 'cover-alone') {
          await expect(page.locator(SHOWN)).toHaveCount(1);
          const cover = await box(page, pageImage(id, 1));
          const media = await box(page, MEDIA);
          expect(cover.left + cover.width / 2).toBeCloseTo(media.left + media.width / 2, 0);
          await page.keyboard.press('ArrowRight');
        }
        for (const direction of ['ltr', 'rtl']) {
          await setReader(page, { direction });
          const order = await expectGaplessSpread(page);
          const positions = order.map((key) => Number(key.split('|n:')[1]));
          expect(positions[0] < positions[1]).toBe(direction === 'ltr');
          await expectSpreadChrome(page);
        }
      }
    }
    await setReader(page, { layout: 'spread', alignment: 'pair-from-first', direction: 'ltr' });
    await page.locator(DIALOG + ' [data-unified-viewer-fullscreen]').click();
    await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
    for (const alignment of ['cover-alone', 'pair-from-first']) {
      await setReader(page, { alignment, direction: 'ltr' });
      if ((await readerState(page)).groupPositions.length === 1) await page.keyboard.press('ArrowRight');
      for (const direction of ['ltr', 'rtl']) {
        await setReader(page, { direction });
        const order = await expectGaplessSpread(page);
        expect(Number(order[0].split('|n:')[1]) < Number(order[1].split('|n:')[1])).toBe(direction === 'ltr');
        await expectSpreadChrome(page);
      }
    }
    // Idle chrome overlays the same composition through hide and reveal.
    const media = await box(page, MEDIA);
    const beforeHide = await box(page, SPREAD);
    const beforeView = await mediaView(page);
    await page.mouse.move(media.left + media.width / 2, media.top + media.height / 2);
    await expect(page.locator(DIALOG + ' [data-unified-viewer-card]')).toHaveAttribute('data-viewer-chrome-hidden', '');
    await expectGaplessSpread(page);
    expect(await box(page, SPREAD)).toEqual(beforeHide);
    expect(await mediaView(page)).toEqual(beforeView);
    await page.mouse.move(media.left + media.width / 2 + 20, media.top + media.height / 2);
    await expect(page.locator(DIALOG + ' [data-unified-viewer-card]')).not.toHaveAttribute('data-viewer-chrome-hidden', '');
    await expectGaplessSpread(page);
    expect(await box(page, SPREAD)).toEqual(beforeHide);
    expect(await mediaView(page)).toEqual(beforeView);
    await expectSpreadChrome(page);
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
    await expectGaplessSpread(page);
  });
}

test('C1e: a real CBZ spread shows both pages fitted in one composition; direction swaps them without reloads', async ({ page }) => {
  const routes = await openPage(page);
  const writes = recordWrites(page);
  const id = fixture.comics.mixed;
  const session = await openComic(page, id, 'Mixed pages');
  await shownKey(page, pageKey(id, 1));
  await setReader(page, { layout: 'spread' });
  // Cover Alone: page 1 stays alone.
  await expect(page.locator(SHOWN)).toHaveCount(1);
  await expect(page.locator(POSITION)).toHaveText('Page 1 of 5');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator(SHOWN)).toHaveCount(2);
  await expect(page.locator(POSITION)).toHaveText('Pages 2–3 of 5');
  expect(await page.locator(MEDIA).evaluate((media) => [
    media.children.length, media.children[0].dataset.viewerContent, media.hasAttribute('data-viewer-composite'),
  ])).toEqual([1, 'spread', true]);
  expect(await page.locator(`${SPREAD} [data-viewer-spread-slot]`).evaluateAll((slots) => slots.map((slot) => slot.getAttribute('aria-label'))))
    .toEqual(['Page 2', 'Page 3']);

  // Fit contains both real pages; each keeps its own aspect ratio.
  const media = await box(page, MEDIA);
  const view = await mediaView(page);
  expect(view).toMatchObject({ mode: 'fit', composite: true });
  expect(view.scale).toBeLessThan(1);
  const ltr = { two: await box(page, pageImage(id, 2)), three: await box(page, pageImage(id, 3)) };
  for (const rect of Object.values(ltr)) {
    expect(rect.left).toBeGreaterThanOrEqual(media.left - 1);
    expect(rect.right).toBeLessThanOrEqual(media.right + 1);
    expect(rect.top).toBeGreaterThanOrEqual(media.top - 1);
    expect(rect.bottom).toBeLessThanOrEqual(media.bottom + 1);
  }
  expect(ltr.two.width / ltr.two.height).toBeCloseTo(1600 / 1000, 1);
  expect(ltr.three.width / ltr.three.height).toBeCloseTo(900 / 1350, 1);
  expect(await page.locator(pageImage(id, 2)).evaluate((image) => [image.naturalWidth, image.naturalHeight])).toEqual([1600, 1000]);
  // LTR: the earlier page is on the left.
  expect(ltr.two.right).toBeLessThanOrEqual(ltr.three.left + 1);
  await expectGaplessSpread(page);

  await markImages(page);
  const requests = pagesSeen(routes, id).length;
  const manifests = routes.count(manifestPath(id));
  const sources = await page.locator(`${SPREAD} img`).evaluateAll((images) => images.map((image) => image.src));
  const transform = await spreadTransform(page);
  expect(await live(page)).toBe(2);

  await setReader(page, { direction: 'rtl' });
  const rtl = { two: await box(page, pageImage(id, 2)), three: await box(page, pageImage(id, 3)) };
  expect(rtl.three.right).toBeLessThanOrEqual(rtl.two.left + 1);
  await expectGaplessSpread(page);
  expect(await markers(page)).toEqual(['Page 2', 'Page 3']);
  expect(await page.locator(`${SPREAD} img`).evaluateAll((images) => images.map((image) => image.src))).toEqual(sources);
  expect(await spreadTransform(page)).toBe(transform);
  expect(await mediaView(page)).toEqual(view);
  await page.waitForTimeout(200);
  expect(pagesSeen(routes, id)).toHaveLength(requests);
  expect(routes.count(manifestPath(id))).toBe(manifests);
  await expect(page.locator(POSITION)).toHaveText('Pages 2–3 of 5');

  // Pair from Page 1 regroups around anchor 2: [1,2]. Page 2 is kept.
  await setReader(page, { alignment: 'pair-from-first' });
  await expect(page.locator(POSITION)).toHaveText('Pages 1–2 of 5');
  await expect(page.locator(pageImage(id, 1))).toBeVisible();
  expect(await page.locator(pageImage(id, 2)).evaluate((image) => image.dataset.c1eMarker)).toBe('Page 2');
  expect(pagesSeen(routes, id).slice(requests)).toEqual([1]);
  await expect(page.locator(pageImage(id, 3))).toHaveCount(0);
  const pair = { one: await box(page, pageImage(id, 1)), two: await box(page, pageImage(id, 2)) };
  expect(pair.two.right).toBeLessThanOrEqual(pair.one.left + 1);
  await expectGaplessSpread(page);
  await expect.poll(() => live(page)).toBe(2);

  // Spread → Single keeps the anchor; Single → Spread adds only the companion.
  await setReader(page, { layout: 'single' });
  await expect(page.locator(SHOWN)).toHaveCount(1);
  await expect(page.locator(POSITION)).toHaveText('Page 2 of 5');
  expect(await page.locator(SHOWN).evaluate((image) => image.dataset.c1eMarker)).toBe('Page 2');
  await expect.poll(() => live(page)).toBe(1);
  await setReader(page, { layout: 'spread', alignment: 'cover-alone', direction: 'ltr' });
  await expect(page.locator(SHOWN)).toHaveCount(2);
  expect(await page.locator(pageImage(id, 2)).evaluate((image) => image.dataset.c1eMarker)).toBe('Page 2');
  expect(pagesSeen(routes, id).slice(requests)).toEqual([1, 3]);
  expect(await state(page)).toMatchObject({ session, open: true, key: pageKey(id, 2) });
  expect(writes).toEqual([]);
});

const PENDING_PANEL = '[data-unified-viewer-page-loading]';
const PENDING_CARD = `${DIALOG} [data-unified-viewer-card]`;
const PENDING_FULLSCREEN = `${DIALOG} [data-unified-viewer-fullscreen]`;

async function pendingSpreadGeometry(page) {
  return page.locator(DIALOG).evaluate((dialog, pendingSelector) => {
    const find = (selector) => dialog.querySelector(selector);
    const rect = (node) => node?.getBoundingClientRect().toJSON() ?? null;
    const card = find('[data-unified-viewer-card]');
    const stage = find('[data-unified-viewer-stage]');
    const media = find('[data-unified-viewer-media]');
    const spread = find('[data-viewer-content="spread"]');
    const pill = find('[data-unified-viewer-controls]');
    const slots = [...spread.querySelectorAll('[data-viewer-spread-slot]')];
    const composition = () => ({
      stage: rect(stage), media: rect(media), spread: rect(spread), transform: spread.style.transform,
      view: window.__viewer().media.getState().view,
      pages: slots.map((slot) => ({
        slot: rect(slot), frame: rect(slot.querySelector('[data-viewer-spread-page]')), image: rect(slot.querySelector('img')),
      })),
    });
    const geometry = composition();
    const navigation = rect(pill);
    const footer = rect(find('[data-unified-viewer-context]'));
    const panels = slots.flatMap((slot) => {
      const panel = slot.querySelector(pendingSelector);
      if (!panel) return [];
      const label = panel.lastElementChild;
      const spinner = panel.querySelector('.unified-viewer-spinner');
      const panelRect = rect(panel);
      const labelRect = rect(label);
      const labelClipped = getComputedStyle(label).clipPath !== 'none'
        || (getComputedStyle(panel).overflow === 'clip' && labelRect.top >= panelRect.bottom);
      const spinnerStyle = getComputedStyle(spinner);
      const spinnerRect = spinner.getBoundingClientRect();
      // Rotation changes the bounding square, but the painted ring stays circular.
      const width = parseFloat(spinnerStyle.width);
      const height = parseFloat(spinnerStyle.height);
      const ring = new DOMRect(spinnerRect.x + (spinnerRect.width - width) / 2,
        spinnerRect.y + (spinnerRect.height - height) / 2, width, height);
      return [{
        key: panel.getAttribute('data-unified-viewer-page-loading'), slot: rect(slot),
        panel: panelRect,
        label: labelClipped ? null : labelRect,
        spinner: spinnerStyle.display === 'none' ? null : ring.toJSON(),
      }];
    });
    const frames = slots.filter((slot) => slot.querySelector(pendingSelector)).map((slot) => slot.firstElementChild);
    media.style.containerType = 'normal';
    frames.forEach((frame) => { frame.style.display = 'flex'; });
    const withoutPendingLayout = composition();
    frames.forEach((frame) => frame.style.removeProperty('display'));
    media.style.removeProperty('container-type');
    pill.style.display = 'none';
    const withoutPill = composition();
    pill.style.removeProperty('display');
    return { geometry, withoutPill, withoutPendingLayout, navigation, footer, panels, card: rect(card) };
  }, PENDING_PANEL);
}

function overlap(first, second) {
  return {
    width: Math.min(first.right, second.right) - Math.max(first.left, second.left),
    height: Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top),
  };
}

async function expectPendingPagesClear(page, id, positions, fullscreen) {
  await expect(page.locator(`${SPREAD} ${PENDING_PANEL}`)).toHaveCount(positions.length);
  for (const position of positions) {
    const panel = page.locator(`${slotOf(id, position)} ${PENDING_PANEL}`);
    await expect(panel).toBeVisible();
    await expect(panel).toHaveText(`Loading page ${position}…`);
    await expect(page.getByRole('group', { name: `Page ${position}`, exact: true })).toMatchAriaSnapshot(`
      - group "Page ${position}": Loading page ${position}…
    `);
  }
  const result = await pendingSpreadGeometry(page);
  // A quarter CSS pixel covers subpixel rounding of percentage-based frames.
  const tolerance = 0.25;
  const { geometry, withoutPill, withoutPendingLayout, navigation, footer, panels, card } = result;
  expect(geometry).toEqual(withoutPill);
  expect(geometry).toEqual(withoutPendingLayout);
  expect(geometry.media).toEqual(geometry.stage);
  if (fullscreen) expect(geometry.stage).toEqual(card);
  else expect(Math.abs(geometry.stage.bottom - footer.top)).toBeLessThanOrEqual(tolerance);
  expect(navigation.height).toBeGreaterThan(0);
  expect(navigation.top).toBeGreaterThanOrEqual(geometry.stage.top - tolerance);
  expect(navigation.bottom).toBeLessThanOrEqual(footer.top + tolerance);
  expect(panels.map(({ key }) => key)).toEqual(positions.map((position) => pageKey(id, position)));
  for (const { key, slot, panel, label, spinner } of panels) {
    expect(label ?? spinner, `${key} has a visual loading indicator`).not.toBeNull();
    for (const [name, bounds] of Object.entries({ label, spinner, panel })) {
      if (!bounds) continue;
      const intersection = overlap(bounds, navigation);
      expect(Math.min(intersection.width, intersection.height),
        `${key} ${name} overlaps the navigation pill by ${JSON.stringify(intersection)} CSS px`).toBeLessThanOrEqual(tolerance);
      expect(bounds.width).toBeGreaterThan(0);
      expect(bounds.height).toBeGreaterThan(0);
      for (const [container, area] of Object.entries({ slot, stage: geometry.stage, panel })) {
        expect(bounds.left, `${key} ${name} left within ${container}`).toBeGreaterThanOrEqual(area.left - tolerance);
        expect(bounds.right, `${key} ${name} right within ${container}`).toBeLessThanOrEqual(area.right + tolerance);
        expect(bounds.top, `${key} ${name} top within ${container}`).toBeGreaterThanOrEqual(area.top - tolerance);
        expect(bounds.bottom, `${key} ${name} bottom within ${container}`).toBeLessThanOrEqual(area.bottom + tolerance);
      }
    }
  }
  return result;
}

async function enterPendingFullscreen(page) {
  await page.locator(PENDING_FULLSCREEN).click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await expect.poll(async () => {
    const pill = await box(page, `${DIALOG} [data-unified-viewer-controls]`);
    return pill.bottom < (await box(page, `${DIALOG} [data-unified-viewer-context]`)).top;
  }).toBe(true);
}

for (const height of [320, 304]) {
  const partial = height === 320;
  test(`tall CBZ pending clearance at 390×${height} / 24px with ${partial ? 'only page 1 ready' : 'both pages held'}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const routes = await openPage(page);
    await page.evaluate(() => { document.documentElement.style.fontSize = '24px'; });
    const id = fixture.comics.tallSpread;
    const first = pagePath(id, 1);
    const second = pagePath(id, 2);
    const releaseFirst = routes.hold(first);
    const releaseSecond = routes.hold(second);
    try {
      await openComic(page, id, 'Tall held comic pages', undefined,
        { layout: 'spread', alignment: 'pair-from-first', direction: 'ltr' });
      await expect.poll(() => [routes.count(first), routes.count(second)]).toEqual([1, 1]);
      await expect(page.locator(`${SPREAD} ${PENDING_PANEL}`)).toHaveCount(2);
      if (partial) {
        releaseFirst();
        await expect(page.locator(pageImage(id, 1))).toBeVisible();
        await expect(page.locator(pageImage(id, 2))).toHaveCount(0);
      }
      for (const fullscreen of [false, true]) {
        if (fullscreen) await enterPendingFullscreen(page);
        const result = await expectPendingPagesClear(page, id, partial ? [2] : [1, 2], fullscreen);
        await expectGaplessSpread(page, { loaded: false });
        if (partial && !fullscreen) expect(result.panels[0].slot.width).toBeCloseTo(40.33, 1);
        expect(result.geometry.pages[0].image !== null).toBe(partial);
        expect(result.geometry.pages[1].image).toBeNull();
        for (const { label, spinner } of result.panels) {
          if (partial || !fullscreen) expect(label).toBeNull();
          else expect(label).not.toBeNull();
          expect(spinner.width).toBeGreaterThanOrEqual(12);
          expect(spinner.height).toBeGreaterThanOrEqual(12);
        }
        if (fullscreen && !partial) {
          const heading = await box(page, `${DIALOG} .unified-viewer-heading`);
          const actions = await box(page, `${DIALOG} .unified-viewer-context-actions`);
          expect(actions.top).toBeGreaterThanOrEqual(heading.bottom - 0.25);
        }
        await page.locator(NEXT).click({ trial: true });
        await testInfo.attach(fullscreen ? 'fullscreen-geometry' : 'dialog-geometry', {
          body: JSON.stringify(result), contentType: 'application/json',
        });
      }
      releaseFirst();
      releaseSecond();
      await expect(page.locator(`${SPREAD} ${PENDING_PANEL}`)).toHaveCount(0);
      await expectGaplessSpread(page);
      expect([routes.count(first), routes.count(second)]).toEqual([1, 1]);
      await page.locator(NEXT).click();
      await expect(page.locator(pageImage(id, 3))).toBeVisible();
    } finally {
      releaseFirst();
      releaseSecond();
    }
  });
}

for (const fullscreen of [false, true]) {
  test(`pending comic labels clear navigation at 390×320 / 24px in ${fullscreen ? 'fullscreen' : 'dialog'}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 320 });
    const routes = await openPage(page);
    await page.evaluate(() => { document.documentElement.style.fontSize = '24px'; });
    const id = fixture.comics.portraitSpread;
    const first = pagePath(id, 1);
    const second = pagePath(id, 2);
    const releaseFirst = routes.hold(first);
    const releaseSecond = routes.hold(second);
    let releaseRetry;
    try {
      await openComic(page, id, 'Held comic pages', undefined,
        { layout: 'spread', alignment: 'pair-from-first', direction: 'ltr' });
      await expect.poll(() => [routes.count(first), routes.count(second)]).toEqual([1, 1]);
      if (fullscreen) await enterPendingFullscreen(page);
      const both = await expectPendingPagesClear(page, id, [1, 2], fullscreen);
      await expectGaplessSpread(page, { loaded: false });
      await testInfo.attach('both-pending-geometry', { body: JSON.stringify(both), contentType: 'application/json' });
      if (fullscreen) {
        const x = both.geometry.stage.left + 8;
        const y = (both.geometry.stage.top + both.navigation.top) / 2;
        await page.mouse.click(x, y);
        await expect(page.locator(PENDING_CARD)).toHaveAttribute('data-viewer-chrome-hidden', '');
        const hidden = await expectPendingPagesClear(page, id, [1, 2], true);
        expect(hidden.geometry).toEqual(both.geometry);
        await page.mouse.move(x + 20, y);
        await expect(page.locator(PENDING_CARD)).not.toHaveAttribute('data-viewer-chrome-hidden', '');
        expect((await expectPendingPagesClear(page, id, [1, 2], true)).geometry).toEqual(both.geometry);

        routes.control(second, { status: 503, contentType: 'text/plain', body: 'Temporarily unavailable' }, { once: true });
        releaseSecond();
        const retry = page.getByRole('button', { name: 'Retry page 2' });
        await expect(retry).toBeVisible();
        await expectPendingPagesClear(page, id, [1], true);
        releaseRetry = routes.hold(second);
        await retry.click();
        await expect.poll(() => routes.count(second)).toBe(2);
        await expectPendingPagesClear(page, id, [1, 2], true);
        releaseFirst();
        await expect(page.locator(pageImage(id, 1))).toBeVisible();
        await expectPendingPagesClear(page, id, [2], true);
        releaseRetry();
      } else {
        releaseSecond();
        await expect(page.locator(pageImage(id, 2))).toBeVisible();
        await expectPendingPagesClear(page, id, [1], false);
        releaseFirst();
      }
      await expect(page.locator(`${SPREAD} ${PENDING_PANEL}`)).toHaveCount(0);
      await expectGaplessSpread(page);
      expect(routes.count(manifestPath(id))).toBe(1);
      expect([routes.count(first), routes.count(second)]).toEqual([1, fullscreen ? 2 : 1]);
      if (fullscreen) await page.mouse.move(both.geometry.stage.left + 8, both.geometry.stage.top + 20);
      await page.locator(NEXT).click({ timeout: 5000 });
      await expect(page.locator(pageImage(id, 3))).toBeVisible();
      expect(routes.count(pagePath(id, 3))).toBe(1);
    } finally {
      releaseFirst();
      releaseSecond();
      releaseRetry?.();
    }
  });
}

for (const { width, height, font, reader, positions } of [
  { width: 320, height: 340, font: 24, reader: { layout: 'spread', alignment: 'pair-from-first', direction: 'rtl' }, positions: [1, 2] },
  { width: 540, height: 360, font: 20, reader: { layout: 'spread', alignment: 'cover-alone', direction: 'rtl' }, positions: [1] },
  { width: 768, height: 400, font: 16, reader: { layout: 'single', direction: 'ltr' }, positions: [1] },
]) {
  test(`pending comic labels clear navigation at ${width}×${height} / ${font}px in ${reader.alignment ?? reader.layout}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const routes = await openPage(page);
    await page.evaluate((size) => { document.documentElement.style.fontSize = `${size}px`; }, font);
    const id = fixture.comics.portraitSpread;
    const releases = positions.map((position) => routes.hold(pagePath(id, position)));
    try {
      await openComic(page, id, 'Held comic pages', undefined, reader);
      await expect.poll(() => pagesSeen(routes, id).sort()).toEqual(positions);
      for (const fullscreen of [false, true]) {
        if (fullscreen) await enterPendingFullscreen(page);
        const { panels, geometry } = await expectPendingPagesClear(page, id, positions, fullscreen);
        if (positions.length === 2) {
          expect(panels[0].slot.left).toBeGreaterThan(panels[1].slot.left);
          await expectGaplessSpread(page, { loaded: false });
        }
        if (reader.layout === 'single') {
          const { panel, slot, label } = panels[0];
          expect(label).not.toBeNull();
          expect(Math.abs((panel.top + panel.bottom) / 2 - (slot.top + slot.bottom) / 2)).toBeLessThanOrEqual(0.25);
          expect(panels[0].slot).toEqual(geometry.spread);
        }
      }
      releases.forEach((release) => release());
      for (const position of positions) await expect(page.locator(pageImage(id, position))).toBeVisible();
      await expect(page.locator(`${SPREAD} ${PENDING_PANEL}`)).toHaveCount(0);
      expect(pagesSeen(routes, id).sort()).toEqual(positions);
    } finally {
      releases.forEach((release) => release());
    }
  });
}

test('C1e: a pending or failed page keeps its slot beside a shown neighbour; per-page Retry and pan stay apart', async ({ page }) => {
  const routes = await openPage(page);
  const writes = recordWrites(page);
  const id = fixture.comics.mixed;
  await openComic(page, id, 'Mixed pages');
  await shownKey(page, pageKey(id, 1));
  await setReader(page, { layout: 'spread' });
  const releaseThree = routes.hold(pagePath(id, 3));
  await page.keyboard.press('ArrowRight');
  await expect(page.locator(pageImage(id, 2))).toBeVisible();
  await expect(page.locator(`${slotOf(id, 3)} [data-unified-viewer-page-loading]`)).toHaveText('Loading page 3…');
  await expect(page.locator(slotOf(id, 3))).toHaveAttribute('data-viewer-spread-state', 'pending');
  await expect(page.locator(NEXT)).toBeEnabled();
  await expect(page.locator(`${DIALOG} [data-unified-viewer-zoom-in]`)).toBeEnabled();
  await expectGaplessSpread(page, { loaded: false });
  const pendingHeight = (await mediaView(page)).contentHeight;
  await markImages(page);
  releaseThree();
  await expect(page.locator(SHOWN)).toHaveCount(2);
  expect(await page.locator(pageImage(id, 2)).evaluate((image) => image.dataset.c1eMarker)).toBe('Page 2');
  expect((await mediaView(page)).mode).toBe('fit');
  // The portrait companion makes the slots taller; Fit re-fits in place.
  expect((await mediaView(page)).contentHeight).toBeGreaterThan(pendingHeight);
  await expectGaplessSpread(page);

  // A failed companion: plain-text message, a page-specific Retry, neighbour kept.
  routes.control(pagePath(id, 5), { status: 503, contentType: 'text/html', body: '<h1>Internal detail</h1>' }, { once: true });
  await page.keyboard.press('ArrowRight');
  const retryFive = page.getByRole('button', { name: 'Retry page 5' });
  await expect(retryFive).toBeVisible();
  await expect(page.locator(pageImage(id, 4))).toBeVisible();
  await expect(page.locator(STATUS)).toHaveText('Page 5 is temporarily unavailable. Try again in a moment.');
  await expectGaplessSpread(page, { loaded: false });
  await expect(page.locator(`${slotOf(id, 5)} .unified-viewer-page-message`)).toHaveText('Page 5 is temporarily unavailable. Try again in a moment.');
  await expect(page.locator(COMIC_RETRY)).toHaveCount(0);
  await markImages(page);
  await page.waitForTimeout(300);
  expect(pagesSeen(routes, id).filter((position) => position === 5)).toHaveLength(1);

  // Zoomed: pressing and dragging from Retry never pans; dragging a page does.
  await page.locator(`${DIALOG} [data-unified-viewer-zoom-in]`).click();
  await page.locator(`${DIALOG} [data-unified-viewer-zoom-in]`).click();
  expect(await page.evaluate(() => window.__viewer().media.getState().view.canPan)).toBe(true);
  const zoomed = await spreadTransform(page);
  const retryBox = await retryFive.boundingBox();
  await page.mouse.move(retryBox.x + retryBox.width / 2, retryBox.y + retryBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(retryBox.x - 120, retryBox.y + 40, { steps: 4 });
  await page.mouse.up();
  expect(await spreadTransform(page)).toBe(zoomed);
  expect(pagesSeen(routes, id).filter((position) => position === 5)).toHaveLength(1);
  const fourBox = await box(page, pageImage(id, 4));
  const fourBefore = fourBox;
  await page.mouse.move(Math.max(fourBox.left, (await box(page, MEDIA)).left) + 30, (await box(page, MEDIA)).top + 60);
  await page.mouse.down();
  await page.mouse.move(Math.max(fourBox.left, (await box(page, MEDIA)).left) + 90, (await box(page, MEDIA)).top + 60, { steps: 4 });
  await page.mouse.up();
  const panned = await spreadTransform(page);
  expect(panned).not.toBe(zoomed);
  // Both pages moved together: the wrapper is the only transformed element.
  const fourAfter = await box(page, pageImage(id, 4));
  expect(fourAfter.left - fourBefore.left).toBeCloseTo(60, -1);
  expect(await page.locator(`${SPREAD} img`).evaluateAll((images) => images.map((image) => image.style.transform || ''))).toEqual(['']);
  // Shift+Arrow pans physically.
  await page.locator(`${DIALOG} [data-dialog-close]`).focus();
  await page.keyboard.press('Shift+ArrowRight');
  expect(await spreadTransform(page)).not.toBe(panned);

  // Enter on the focused page Retry reloads that page only.
  await retryFive.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator(pageImage(id, 5))).toBeVisible();
  expect(await page.locator(pageImage(id, 4)).evaluate((image) => image.dataset.c1eMarker)).toBe('Page 4');
  await expectGaplessSpread(page, { fitted: false });
  expect(pagesSeen(routes, id).filter((position) => position === 5)).toHaveLength(2);
  expect(pagesSeen(routes, id).filter((position) => position === 4)).toHaveLength(1);
  // Focus left the replaced Retry for a connected control in the dialog.
  expect(await page.evaluate(() => document.activeElement?.isConnected
    && document.getElementById('unified-viewer-dialog').contains(document.activeElement))).toBe(true);

  // Space works too, on a failed first spread member.
  routes.control(pagePath(id, 2), { status: 404, contentType: 'text/plain', body: 'missing' }, { once: true });
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator(pageImage(id, 3))).toBeVisible();
  const retryTwo = page.getByRole('button', { name: 'Retry page 2' });
  await expect(retryTwo).toBeVisible();
  await expect(page.locator(STATUS)).toHaveText('Page 2 could not be loaded.');
  await retryTwo.focus();
  await page.keyboard.press('Space');
  await expect(page.locator(pageImage(id, 2))).toBeVisible();
  await expect.poll(() => live(page)).toBe(2);
  expect(writes).toEqual([]);
});

for (const { failed, fullscreen } of [{ failed: 1, fullscreen: false }, { failed: 2, fullscreen: true }]) {
  test(`revision retirement focus: Retry page ${failed}, fullscreen ${fullscreen}`, async ({ page }) => {
    const routes = await openPage(page);
    const id = fixture.comics.controlled;
    const conflict = failed === 1 ? 2 : 1;
    routes.control(manifestPath(id), fakeManifest(id, { pages: [true, true] }));
    routes.control(pagePath(id, failed), { status: 503, contentType: 'text/plain', body: 'unavailable' });
    routes.control(pagePath(id, conflict), { status: 409, contentType: 'text/plain', body: 'changed' });
    const release = routes.hold(pagePath(id, conflict));
    try {
      const session = await openComic(page, id);
      await setReader(page, { layout: 'spread', alignment: 'pair-from-first' });
      const pageRetry = page.getByRole('button', { name: `Retry page ${failed}`, exact: true });
      await expect(pageRetry).toBeVisible();
      await expect.poll(() => routes.count(pagePath(id, conflict))).toBe(1);
      if (fullscreen) {
        await page.locator(`${DIALOG} [data-unified-viewer-fullscreen]`).click();
        await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
      }
      await pageRetry.focus();
      await expect(pageRetry).toBeFocused();
      await pageRetry.evaluate((button) => { window.__retiringRetry = button; });
      const manifests = routes.count(manifestPath(id));
      release();
      await expect(page.locator(STATUS)).toHaveText('This comic changed while it was open. Retry to load the current version.');
      await expect(page.locator(PAGE_RETRY)).toHaveCount(0);
      await expect(page.locator(SPREAD)).toHaveCount(0);
      await expect(page.locator(COMIC_RETRY)).toBeFocused();
      expect(await page.evaluate(() => ({
        body: document.activeElement === document.body,
        connected: document.activeElement.isConnected,
        inside: document.querySelector('#unified-viewer-dialog').contains(document.activeElement),
        oldConnected: window.__retiringRetry.isConnected,
        openDialogs: document.querySelectorAll('dialog[open]').length,
      }))).toEqual({ body: false, connected: true, inside: true, oldConnected: false, openDialogs: 1 });
      expect(await state(page)).toMatchObject({ open: true, session, fullscreen, comic: { state: 'changed' } });
      expect(await live(page)).toBe(0);
      expect(routes.count(manifestPath(id))).toBe(manifests);
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.querySelector('#unified-viewer-dialog').contains(document.activeElement))).toBe(true);
      expect(routes.count(manifestPath(id))).toBe(manifests);
      routes.control(manifestPath(id), fakeManifest(id, { revision: 'd'.repeat(32), pages: [true, true] }));
      for (const position of [1, 2]) {
        routes.control(pagePath(id, position), { status: 200, contentType: 'image/png', body: img.page2 });
      }
      await page.locator(COMIC_RETRY).press('Enter');
      await expect(page.locator(SHOWN)).toHaveCount(2);
      expect(routes.count(manifestPath(id))).toBe(manifests + 1);
      expect(await readerState(page)).toMatchObject({ anchorPosition: 1, layout: 'spread', alignment: 'pair-from-first' });
      expect(await state(page)).toMatchObject({ session, open: true, fullscreen });
    } finally {
      release();
      await page.evaluate(() => window.__viewer().close());
    }
  });
}

test('image Retry keeps focus in the compiled unified viewer', async ({ page }) => {
  await openPage(page);
  let requests = 0;
  await page.route('**/test-media/retry.webp', (route) => {
    requests += 1;
    return route.fulfill(requests === 1
      ? { status: 503, contentType: 'text/plain', body: 'unavailable' }
      : { status: 200, contentType: 'image/webp', body: img.webp });
  });
  await page.evaluate(() => window.__viewer().open({
    key: 'image-retry-focus', mode: 'single',
    items: [{ projectId: 1, assetId: 1, mediaUrl: '/test-media/retry.webp' }],
  }, { opener: document.getElementById('test-opener') }));
  const retry = page.locator(`${DIALOG} [data-unified-viewer-retry]`);
  await expect(retry).toBeVisible();
  await retry.focus();
  await expect(retry).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator(SHOWN)).toBeVisible();
  await expect(page.locator(`${DIALOG} [data-dialog-close]`)).toBeFocused();
  expect(requests).toBe(2);
  await page.keyboard.press('Escape');
  await expect(page.locator('#test-opener')).toBeFocused();
});

test('revision retirement focus: another modal retains ownership', async ({ page }) => {
  const routes = await openPage(page);
  const id = fixture.comics.controlled;
  routes.control(manifestPath(id), fakeManifest(id, { pages: [true, true] }));
  routes.control(pagePath(id, 1), { status: 503, contentType: 'text/plain', body: 'unavailable' });
  routes.control(pagePath(id, 2), { status: 409, contentType: 'text/plain', body: 'changed' });
  const release = routes.hold(pagePath(id, 2));
  try {
    await openComic(page, id);
    await setReader(page, { layout: 'spread', alignment: 'pair-from-first' });
    const retry = page.getByRole('button', { name: 'Retry page 1', exact: true });
    await expect(retry).toBeVisible();
    await retry.focus();
    await expect(retry).toBeFocused();
    await expect.poll(() => routes.count(pagePath(id, 2))).toBe(1);
    await page.evaluate(() => {
      const modal = document.createElement('dialog');
      modal.id = 'test-other-modal';
      modal.innerHTML = '<button autofocus>Keep focus</button>';
      document.body.append(modal);
      modal.showModal();
    });
    const modalButton = page.locator('#test-other-modal button');
    await expect(modalButton).toBeFocused();
    release();
    await expect(page.locator(STATUS)).toHaveText('This comic changed while it was open. Retry to load the current version.');
    await expect(page.locator(PAGE_RETRY)).toHaveCount(0);
    await expect(modalButton).toBeFocused();
    expect(routes.count(manifestPath(id))).toBe(1);
    expect(await comicState(page)).toBe('changed');
  } finally {
    release();
    await page.evaluate(() => {
      document.getElementById('test-other-modal')?.close();
      document.getElementById('test-other-modal')?.remove();
      window.__viewer().close();
    });
  }
});

test('C1e: a real 409 from the second spread page retires the revision; Retry loads one manifest at page 1', async ({ page }) => {
  const routes = await openPage(page);
  const id = fixture.comics.spreadChange;
  const session = await openComic(page, id, 'Spread change');
  await shownKey(page, pageKey(id, 1));
  const first = (await state(page)).comic.revision;
  await setReader(page, { layout: 'spread', direction: 'rtl' });
  const releaseThree = routes.hold(pagePath(id, 3));
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator(pageImage(id, 2))).toBeVisible();
  await expect.poll(() => routes.count(pagePath(id, 3))).toBe(1);
  await page.evaluate(() => {
    window.__retired = 0;
    window.__viewer().observe((change) => { if (change.outcome === 'retired') window.__retired += 1; });
  });
  fixture.rewrite('spread-change.cbz', [
    { name: 'n1.png', data: img.page3 },
    { name: 'n2.jpg', data: img.page1 },
    { name: 'n3.png', data: img.page2 },
  ]);
  const manifests = routes.count(manifestPath(id));
  releaseThree();
  await expect(page.locator(STATUS)).toHaveText('This comic changed while it was open. Retry to load the current version.');
  expect(await state(page)).toMatchObject({ open: true, session, key: null, comic: { state: 'changed', httpStatus: 409 } });
  await expect(page.locator(SHOWN)).toHaveCount(0);
  await expect(page.locator(SPREAD)).toHaveCount(0);
  expect(await live(page)).toBe(0);
  expect(await page.evaluate(() => window.__retired)).toBe(1);
  await page.waitForTimeout(300);
  expect(routes.count(manifestPath(id))).toBe(manifests);

  await page.locator(COMIC_RETRY).click();
  await expect(page.locator(SHOWN)).toHaveCount(1);
  expect(routes.count(manifestPath(id))).toBe(manifests + 1);
  await expect(page.locator(POSITION)).toHaveText('Page 1 of 3');
  const recovered = await state(page);
  expect(recovered).toMatchObject({ session, key: pageKey(id, 1), comic: { state: 'ready' } });
  expect(recovered.comic.revision).not.toBe(first);
  expect(await readerState(page)).toMatchObject({ direction: 'rtl', layout: 'spread', alignment: 'cover-alone', groupPositions: [1] });
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator(SHOWN)).toHaveCount(2);
  await expect(page.locator(POSITION)).toHaveText('Pages 2–3 of 3');
  expect(routes.seen.filter((entry) => entry.includes(`/assets/${id}/comic/pages/`)).slice(-2)
    .every((entry) => entry.includes(`?v=${recovered.comic.revision}`))).toBe(true);
});

test('C1e: a current 409 from the first spread page, or from both, retires once and never mixes revisions', async ({ page }) => {
  const routes = await openPage(page);
  const id = fixture.comics.controlled;
  const revision = 'f'.repeat(32);
  routes.control(manifestPath(id), fakeManifest(id, { revision, pages: [true, true, true, true, true] }));
  for (const position of [1, 4, 5]) {
    routes.control(pagePath(id, position), { status: 200, contentType: 'image/png', body: img.page2 });
  }
  const conflict = { status: 409, contentType: 'text/plain', body: 'stale' };
  routes.control(pagePath(id, 2), conflict);
  routes.control(pagePath(id, 3), conflict);
  const session = await openComic(page, id);
  await shownKey(page, pageKey(id, 1));
  await page.evaluate(() => {
    window.__retired = 0;
    window.__viewer().observe((change) => { if (change.outcome === 'retired') window.__retired += 1; });
  });
  await setReader(page, { layout: 'spread' });
  await page.keyboard.press('ArrowRight');
  await expect(page.locator(STATUS)).toHaveText('This comic changed while it was open. Retry to load the current version.');
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__retired)).toBe(1);
  expect(await state(page)).toMatchObject({ session, key: null, comic: { state: 'changed' } });
  await expect(page.locator(SHOWN)).toHaveCount(0);
  expect(await live(page)).toBe(0);
  const manifests = routes.count(manifestPath(id));

  // Only the first member conflicts now.
  routes.control(pagePath(id, 3), { status: 200, contentType: 'image/png', body: img.page3 });
  await page.locator(COMIC_RETRY).click();
  await shownKey(page, pageKey(id, 1));
  expect(routes.count(manifestPath(id))).toBe(manifests + 1);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator(STATUS)).toHaveText('This comic changed while it was open. Retry to load the current version.');
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__retired)).toBe(2);
  await expect(page.locator(SHOWN)).toHaveCount(0);
  expect(await live(page)).toBe(0);
  expect(await page.evaluate(() => document.querySelectorAll('dialog#unified-viewer-dialog[open]').length)).toBe(1);
});

test('C1e: rapid navigation keeps at most two page attempts and stale pages never install', async ({ page }) => {
  const routes = await openPage(page);
  const id = fixture.comics.seven;
  await openComic(page, id, 'Seven pages');
  await shownKey(page, pageKey(id, 1));
  await page.evaluate(() => {
    window.__maxAttempts = 0;
    window.__viewer().media.observe((media) => { window.__maxAttempts = Math.max(window.__maxAttempts, media.pageRequests); });
  });
  await setReader(page, { layout: 'spread' });
  const releases = [2, 3].map((position) => routes.hold(pagePath(id, position)));
  await page.evaluate(() => window.__viewer().next());
  await expect.poll(() => routes.count(pagePath(id, 3))).toBe(1);
  expect(routes.count(pagePath(id, 2))).toBe(1);
  // A burst of navigation in one task: only the newest group may load.
  const samples = await page.evaluate(() => {
    const viewer = window.__viewer();
    const seen = [];
    for (let index = 0; index < 4; index += 1) {
      viewer.next();
      seen.push(viewer.media.getState().pageRequests);
    }
    viewer.previous();
    viewer.next();
    seen.push(viewer.media.getState().pageRequests);
    return seen;
  });
  expect(samples.every((count) => count <= 2)).toBe(true);
  expect((await readerState(page)).groupPositions).toEqual([6, 7]);
  await expect(page.locator(SHOWN)).toHaveCount(2);
  expect(await page.locator(SHOWN).evaluateAll((images) => images.map((image) => image.alt))).toEqual(['Page 6', 'Page 7']);
  expect([...new Set(pagesSeen(routes, id))].sort()).toEqual([1, 2, 3, 6, 7]);
  // The held old pages complete late: nothing of theirs is installed.
  releases.forEach((release) => release());
  await page.waitForTimeout(300);
  expect(await page.locator(SHOWN).evaluateAll((images) => images.map((image) => image.alt))).toEqual(['Page 6', 'Page 7']);
  expect(await live(page)).toBe(2);
  expect(await page.evaluate(() => window.__maxAttempts)).toBeLessThanOrEqual(2);

  // A held page of a replaced comic never installs into the new one.
  const other = fixture.comics.other;
  const releaseOther = routes.hold(pagePath(other, 1));
  await openComic(page, other, 'Other');
  await expect.poll(() => routes.count(pagePath(other, 1))).toBe(1);
  await openComic(page, fixture.comics.one, 'One');
  await shownKey(page, pageKey(fixture.comics.one, 1));
  releaseOther();
  await page.waitForTimeout(300);
  await expect(page.locator(SHOWN)).toHaveCount(1);
  expect(await state(page)).toMatchObject({ key: pageKey(fixture.comics.one, 1) });
  expect(await live(page)).toBe(1);

  // The image viewer afterwards keeps its single-image path.
  await page.locator('#test-opener').focus();
  await page.evaluate(() => window.__viewer().open({
    key: 'c1e-images', mode: 'sequence',
    items: [1, 2].map((n) => ({ projectId: 1, assetId: n, title: `image-${n}`, mediaUrl: `/test-media/${n}.webp` })),
  }, { opener: document.getElementById('test-opener'), autoplay: false }));
  await expect(page.locator(`${MEDIA} > img.unified-viewer-image`)).toBeVisible();
  await expect(page.locator(SPREAD)).toHaveCount(0);
  expect(await page.locator(MEDIA).evaluate((media) => media.hasAttribute('data-viewer-composite'))).toBe(false);
  expect(await page.evaluate(() => window.__viewer().media.getState().composite)).toBe(false);
});

test('C1e: fullscreen and focus survive a spread with a failed page; a removed Retry hands focus to Close', async ({ page }) => {
  const routes = await openPage(page);
  const id = fixture.comics.mixed;
  const session = await openComic(page, id, 'Mixed pages');
  await shownKey(page, pageKey(id, 1));
  await page.locator(DIALOG).getByRole('button', { name: 'Enter fullscreen' }).click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  routes.control(pagePath(id, 3), { status: 503, contentType: 'text/plain', body: 'busy' }, { once: true });
  await setReader(page, { layout: 'spread' });
  await page.keyboard.press('ArrowRight');
  const retry = page.getByRole('button', { name: 'Retry page 3' });
  await expect(retry).toBeVisible();
  await expect(page.locator(pageImage(id, 2))).toBeVisible();
  await retry.focus();
  await setReader(page, { direction: 'rtl' });
  await expect(retry).toBeFocused();
  // RTL: ArrowLeft is Next; the Retry's page leaves the composition.
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator(POSITION)).toHaveText('Pages 4–5 of 5');
  await expect(retry).toHaveCount(0);
  await expect(page.locator(`${DIALOG} [data-dialog-close]`)).toBeFocused();
  expect(await state(page)).toMatchObject({ session, open: true, fullscreen: true });

  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
  await expect(page.locator(DIALOG)).toBeVisible();
  // The composition re-fits the stage through the shared viewport on exit.
  await expect.poll(async () => (await mediaView(page)).mode).toBe('fit');
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(page.locator('#test-opener')).toBeFocused();
  expect(await live(page)).toBe(0);
  expect(await page.locator(MEDIA).evaluate((media) => [media.children.length, media.hasAttribute('data-viewer-composite')]))
    .toEqual([0, false]);
});

// ─── C1f: reader controls and browser-local preferences ─────────────────────
//
// The compiled viewer's real Reading direction and Page layout dropdowns,
// operated with the mouse and keyboard. Each test runs in a fresh browser
// context, so localStorage starts empty unless a test says otherwise.

const PREFERENCES_KEY = 'creatorcrate-comic-reader-preferences';
const READER = `${DIALOG} [data-unified-viewer-reader]`;
const DIRECTION_MENU = `${DIALOG} #unified-viewer-direction-dropdown`;
const LAYOUT_MENU = `${DIALOG} #unified-viewer-layout-dropdown`;
const CLOSE = `${DIALOG} [data-dialog-close]`;

async function openSecondaryTools(page) {
  const overflow = page.locator('[data-unified-viewer-overflow]');
  if (!await overflow.isVisible()) return false;
  if (!await overflow.evaluate((element) => element.open)) await page.getByRole('button', { name: 'More viewer tools' }).click();
  return true;
}

async function closeSecondaryTools(page) {
  if (await page.locator('[data-unified-viewer-overflow]').evaluate((element) => element.open)) await page.keyboard.press('Escape');
}

async function choose(page, menu, label) {
  if (await openSecondaryTools(page)) {
    await page.locator(menu).locator('..').locator('select').selectOption({ label });
    await closeSecondaryTools(page);
    return;
  }
  await page.locator(`${menu} summary`).click();
  await expect(page.locator(menu)).toHaveAttribute('open', '');
  await page.locator(`${menu} .asset-filter-multiselect-panel`).getByText(label, { exact: true }).click();
  await expect(page.locator(menu)).not.toHaveAttribute('open', '');
}
const shownChoice = (page, menu) => page.locator(`${menu} [data-cc-dropdown-summary-current]`);

async function readerControlGeometry(page) {
  return page.locator(READER).evaluate((reader) => {
    const rect = (element) => {
      const { left, right, width, height } = element.getBoundingClientRect();
      return { left, right, width, height };
    };
    const fields = [...reader.querySelectorAll('fieldset')].map((field) => {
      const summary = field.querySelector('summary');
      const current = summary.querySelector('[data-cc-dropdown-summary-current]');
      const range = document.createRange();
      range.selectNodeContents(current);
      const style = getComputedStyle(summary);
      return { field: rect(field), trigger: rect(summary), text: rect(current),
        textHeight: range.getBoundingClientRect().height,
        grow: getComputedStyle(field).flexGrow,
        sizingVisible: getComputedStyle(summary.querySelector('.asset-filter-multiselect-summary-width')).display !== 'none',
        padding: parseFloat(style.paddingLeft) + parseFloat(style.paddingRight),
        lineHeight: parseFloat(style.lineHeight), font: parseFloat(style.fontSize),
        expectedWidth: range.getBoundingClientRect().width + parseFloat(style.paddingLeft)
          + parseFloat(style.paddingRight) + parseFloat(style.columnGap)
          + parseFloat(getComputedStyle(summary, '::after').width)
          + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth) };
    });
    return { fields, fit: rect(document.querySelector('[data-unified-viewer-fit]')),
      fullscreen: rect(document.querySelector('[data-unified-viewer-fullscreen]')),
      footer: rect(reader.closest('footer')), gap: parseFloat(getComputedStyle(reader).columnGap),
      rootFont: parseFloat(getComputedStyle(document.documentElement).fontSize) };
  });
}

function expectReaderControlsCompact(geometry) {
  const [direction, layout] = geometry.fields;
  for (const field of geometry.fields) {
    expect(field.grow, 'reader field must not grow').toBe('0');
    expect(field.sizingVisible, 'current selection owns trigger width').toBe(false);
    expect(field.field.width, 'no empty fieldset width').toBeCloseTo(field.trigger.width, 0);
    expect(field.trigger.width, 'trigger width follows current text').toBeCloseTo(field.expectedWidth, 0);
    expect(field.padding, 'compact horizontal padding').toBe(geometry.rootFont);
    expect(field.lineHeight / field.font).toBeCloseTo(1.25, 2);
    expect(field.textHeight, 'current value is not clipped').toBeLessThanOrEqual(field.text.height + 1);
    expect(field.trigger.height).toBeCloseTo(2 * geometry.rootFont, 0);
  }
  expect(direction.trigger.height).toBe(layout.trigger.height);
  for (const gap of [direction.field.left - geometry.fit.right,
    layout.field.left - direction.field.right, geometry.fullscreen.left - layout.field.right]) {
    expect(gap, 'adjacent control spacing').toBeCloseTo(geometry.gap, 0);
  }
  expect(geometry.footer.height, 'desktop footer stays slim').toBeLessThanOrEqual(2.9 * geometry.rootFont);
}

async function readerOptionGeometry(page, menu) {
  return page.locator(`${menu} .asset-filter-multiselect-panel`).evaluate((panel) => {
    const rect = (element) => {
      const { left, right, top, bottom, width, height } = element.getBoundingClientRect();
      return { left, right, top, bottom, width, height };
    };
    return { panel: rect(panel), align: getComputedStyle(panel).textAlign,
      gap: parseFloat(getComputedStyle(panel).rowGap), viewport: { width: innerWidth, height: innerHeight },
      rows: [...panel.querySelectorAll('label')].map((label) => {
        const input = label.querySelector('input');
        const text = label.querySelector('span');
        const range = document.createRange();
        range.selectNodeContents(text);
        const style = getComputedStyle(label);
        return { row: rect(label), text: rect(text), indicator: rect(input),
          content: range.getBoundingClientRect().toJSON(), lineHeight: parseFloat(style.lineHeight),
          padding: parseFloat(style.paddingTop), textOverflow: text.scrollWidth - text.clientWidth,
          checked: input.checked, checkImage: getComputedStyle(input).backgroundImage,
          background: getComputedStyle(label.parentElement).backgroundColor };
      }) };
  });
}

function expectReaderOptionsReadable(geometry) {
  expect(geometry.align, 'option text starts at leading edge').toBe('start');
  expect(geometry.gap).toBe(1);
  expect(geometry.panel.left).toBeGreaterThanOrEqual(0);
  expect(geometry.panel.right).toBeLessThanOrEqual(geometry.viewport.width);
  expect(geometry.panel.top).toBeGreaterThanOrEqual(0);
  expect(geometry.panel.bottom).toBeLessThanOrEqual(geometry.viewport.height);
  expect(geometry.rows.filter((row) => row.checked)).toHaveLength(1);
  for (const row of geometry.rows) {
    expect(row.content.left, 'text starts consistently').toBeCloseTo(row.text.left, 0);
    expect(row.textOverflow, 'long option does not overflow').toBeLessThanOrEqual(1);
    expect(row.content.right).toBeLessThanOrEqual(row.indicator.left + 1);
    expect(row.content.top).toBeGreaterThanOrEqual(row.row.top);
    expect(row.content.bottom).toBeLessThanOrEqual(row.row.bottom);
    expect(row.indicator.right).toBeCloseTo(geometry.rows[0].indicator.right, 0);
    expect(row.indicator.top + row.indicator.height / 2).toBeCloseTo(row.row.top + row.row.height / 2, 0);
    expect(row.padding).toBeGreaterThanOrEqual(6);
    expect(row.row.height).toBeGreaterThanOrEqual(row.lineHeight + 2 * row.padding - 1);
    if (row.checked) {
      expect(row.checkImage).toContain('data:image/svg+xml');
      expect(row.background).not.toBe('rgba(0, 0, 0, 0)');
    }
  }
}

for (const [width, fontSize] of [[1280, 16], [1680, 20], [1920, 24]]) {
  test(`reader control styling: current-value sizing and options at ${width}px with ${fontSize}px fonts`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 720 });
    await openPage(page);
    await page.evaluate((size) => { document.documentElement.style.fontSize = `${size}px`; }, fontSize);
    await openComic(page, fixture.comics.seven);
    await shownKey(page, pageKey(fixture.comics.seven, 1));
    const initialWidth = (await readerControlGeometry(page)).fields[1].trigger.width;
    for (const fullscreen of [false, true]) {
      if (fullscreen) {
        await page.locator('[data-unified-viewer-fullscreen]').click();
        await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
      }
      for (const label of ['Two-Page Spread — Cover Alone', 'Two-Page Spread — Pair from Page 1', 'Single Page']) {
        await page.locator(`${LAYOUT_MENU} summary`).click();
        const options = await readerOptionGeometry(page, LAYOUT_MENU);
        expectReaderOptionsReadable(options);
        if (label === 'Two-Page Spread — Pair from Page 1') {
          console.log('Reader option measurements:', JSON.stringify({ width, fontSize, fullscreen, options }));
          await page.screenshot({ path: testInfo.outputPath(`options-${fullscreen ? 'fullscreen' : 'dialog'}.png`) });
        }
        await page.locator(`${LAYOUT_MENU} label`).filter({ hasText: label }).click();
        await expect(shownChoice(page, LAYOUT_MENU)).toHaveText(label);
        await expect(page.locator(`${LAYOUT_MENU} summary`)).toBeFocused();
        const geometry = await readerControlGeometry(page);
        expectReaderControlsCompact(geometry);
        if (label !== 'Single Page') expect(geometry.fields[1].trigger.width).toBeGreaterThan(initialWidth + 80);
        else expect(geometry.fields[1].trigger.width).toBeCloseTo(initialWidth, 0);
        console.log('Reader control measurements:', JSON.stringify({ width, fontSize, fullscreen, label, geometry }));
      }
      await page.locator(`${DIRECTION_MENU} summary`).click();
      expectReaderOptionsReadable(await readerOptionGeometry(page, DIRECTION_MENU));
      await page.locator(`${DIRECTION_MENU} label`).filter({ hasText: 'Right-to-Left' }).click();
      await expect(shownChoice(page, DIRECTION_MENU)).toHaveText('Right-to-Left');
      await page.locator(`${LAYOUT_MENU} summary`).focus();
      await page.keyboard.press('Space');
      await page.keyboard.press('Tab');
      const focus = await page.locator(`${LAYOUT_MENU} input:focus`).evaluate((input) => {
        const style = getComputedStyle(input.closest('.asset-filter-multiselect-option'));
        return { width: style.outlineWidth, style: style.outlineStyle };
      });
      expect(focus).toEqual({ width: '2px', style: 'solid' });
      await page.keyboard.press('Escape');
      await expect(page.locator(`${LAYOUT_MENU} summary`)).toBeFocused();
      expect(await page.locator(`${LAYOUT_MENU} summary`).evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe('none');
      if (fullscreen) await expect(page.locator('[data-unified-viewer-card]')).not.toHaveAttribute('data-viewer-chrome-hidden');
      await page.screenshot({ path: testInfo.outputPath(`reader-${fullscreen ? 'fullscreen' : 'dialog'}.png`) });
    }
  });
}

test('reader control styling: assertions detect field, sizing, alignment, padding, clipping and selection regressions', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openPage(page);
  await openComic(page, fixture.comics.seven);
  await shownKey(page, pageKey(fixture.comics.seven, 1));
  expectReaderControlsCompact(await readerControlGeometry(page));
  const scope = '.unified-viewer-dialog .unified-viewer-reader-field';
  const probes = [
    [`${scope} { flex: 1 1 auto !important; }`, 'controls', 'reader field must not grow'],
    [`${scope} .asset-filter-multiselect-summary-width { display: flex !important; }`, 'controls', 'current selection owns trigger width'],
    [`${scope} summary { padding: 0.375rem 0.625rem !important; }`, 'controls', 'compact horizontal padding'],
    [`${scope} .asset-filter-multiselect-panel { text-align: center !important; }`, 'options', 'option text starts at leading edge'],
    [`${scope} label > span { white-space: nowrap !important; width: 2rem !important; flex: none !important; overflow: hidden !important; }`, 'options', 'long option does not overflow'],
    [`${scope} input:checked { background-image: none !important; }`, 'options', 'data:image/svg+xml'],
  ];
  for (const [css, kind, failure] of probes) {
    if (kind === 'options') await page.locator(`${LAYOUT_MENU} summary`).click();
    const style = await page.evaluateHandle((css) => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      return sheet;
    }, css);
    try {
      const geometry = kind === 'controls' ? await readerControlGeometry(page) : await readerOptionGeometry(page, LAYOUT_MENU);
      expect(() => (kind === 'controls' ? expectReaderControlsCompact : expectReaderOptionsReadable)(geometry)).toThrow(failure);
    } finally {
      await style.evaluate((sheet) => { document.adoptedStyleSheets = document.adoptedStyleSheets.filter((entry) => entry !== sheet); });
      await style.dispose();
    }
    if (kind === 'options') {
      expectReaderOptionsReadable(await readerOptionGeometry(page, LAYOUT_MENU));
      await page.keyboard.press('Escape');
    } else expectReaderControlsCompact(await readerControlGeometry(page));
  }
});

test('reader control styling: constrained long labels wrap without clipping in a short dialog and fullscreen', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 320 });
  await openPage(page);
  await openComic(page, fixture.comics.seven);
  await shownKey(page, pageKey(fixture.comics.seven, 1));
  await choose(page, LAYOUT_MENU, 'Two-Page Spread — Pair from Page 1');
  const sheet = await page.evaluateHandle(() => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`.unified-viewer-reader-field .cc-dropdown { max-width: 9rem !important; }
      .unified-viewer-reader-field .asset-filter-multiselect-panel { max-width: 12rem !important; }`);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    return sheet;
  });
  try {
    for (const fullscreen of [false, true]) {
      if (fullscreen) {
        await page.locator('[data-unified-viewer-fullscreen]').click();
        await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
      }
      const geometry = await readerControlGeometry(page);
      const layout = geometry.fields[1];
      expect(layout.trigger.width).toBeLessThanOrEqual(9 * geometry.rootFont);
      expect(layout.textHeight).toBeGreaterThan(layout.lineHeight);
      expect(layout.textHeight).toBeLessThanOrEqual(layout.trigger.height);
      await page.locator(`${LAYOUT_MENU} summary`).click();
      const options = await readerOptionGeometry(page, LAYOUT_MENU);
      expectReaderOptionsReadable(options);
      expect(options.rows[2].content.height, 'long option uses multiple lines').toBeGreaterThan(1.5 * options.rows[2].lineHeight);
      for (const option of await page.locator(`${LAYOUT_MENU} label`).all()) await expectPointerTarget(option);
      await page.screenshot({ path: testInfo.outputPath(`wrapped-${fullscreen ? 'fullscreen' : 'dialog'}.png`) });
      await page.keyboard.press('Escape');
      if (fullscreen) await expect(page.locator('[data-unified-viewer-card]')).not.toHaveAttribute('data-viewer-chrome-hidden');
    }
  } finally {
    await sheet.evaluate((sheet) => { document.adoptedStyleSheets = document.adoptedStyleSheets.filter((entry) => entry !== sheet); });
    await sheet.dispose();
  }
});

async function openClickHideImage(page, slideshow = false) {
  await page.evaluate((slideshow) => window.__viewer().open({
    key: 'click-hide-images', mode: slideshow ? 'sequence' : 'single', wrap: slideshow, slideshow,
    items: [901, 902, 903].map((assetId) => ({ projectId: 1, assetId, title: `Image ${assetId}`,
      mediaUrl: `/test-media/${assetId}.webp`, detailsUrl: `/projects/1/assets/${assetId}` })),
  }, { opener: document.getElementById('test-opener'), autoplay: false }), slideshow);
  await expect(page.locator(SHOWN)).toBeVisible();
}

async function clickHideGeometry(page) {
  return page.locator(DIALOG).evaluate((dialog) => {
    const box = (selector) => {
      const element = dialog.querySelector(selector);
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, height: rect.height, left: rect.left, right: rect.right,
        opacity: getComputedStyle(element).opacity };
    };
    const viewer = window.__viewer();
    const current = viewer.getState();
    return { open: dialog.open, fullscreen: document.fullscreenElement === dialog.querySelector('[data-unified-viewer-card]'),
      session: current.session, key: current.key, playback: viewer.playback.getState(), view: viewer.media.getState().view,
      card: box('[data-unified-viewer-card]'),
      header: box('.app-dialog-header'), footer: box('.unified-viewer-context'),
      navigation: box('.unified-viewer-controls'),
      stage: box('[data-unified-viewer-stage]'), media: box('[data-unified-viewer-media]'),
      focusInChrome: Boolean(document.activeElement?.closest('.app-dialog-header, .unified-viewer-context, .unified-viewer-controls')),
      images: [...dialog.querySelectorAll('[data-unified-viewer-media] img')].map((img) => ({
        src: img.src, ...Object.fromEntries(['top', 'bottom', 'left', 'right', 'width', 'height']
          .map((key) => [key, img.getBoundingClientRect()[key]])),
      })) };
  });
}

async function clickHidePoint(page) {
  const box = await page.locator(MEDIA).boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function expectClickShownGeometry(page) {
  const geometry = await clickHideGeometry(page);
  expect(geometry.header.height).toBeGreaterThan(0);
  expect(geometry.footer.height).toBeGreaterThan(0);
  expect(geometry.header.opacity).toBe('1');
  expect(geometry.footer.opacity).toBe('1');
  expect(geometry.stage).toEqual(geometry.card);
  expect(geometry.media).toEqual(geometry.card);
  expect(geometry.header.bottom).toBeLessThanOrEqual(
    (geometry.navigation.height > 0 ? geometry.navigation.top : geometry.footer.top) + 0.5,
  );
  if (geometry.navigation.height > 0) expect(geometry.navigation.bottom).toBeLessThanOrEqual(geometry.footer.top + 0.5);
  for (const image of geometry.images) {
    expect(image.top).toBeGreaterThanOrEqual(geometry.media.top - 0.5);
    expect(image.bottom).toBeLessThanOrEqual(geometry.media.bottom + 0.5);
    expect(image.left).toBeGreaterThanOrEqual(geometry.media.left - 0.5);
    expect(image.right).toBeLessThanOrEqual(geometry.media.right + 0.5);
  }
}

async function expectClickHidden(page, before) {
  await expect.poll(async () => (await clickHideGeometry(page)).header.opacity, { timeout: 1000 }).toBe('0');
  const hidden = await clickHideGeometry(page);
  expect(hidden).toMatchObject({ open: true, fullscreen: true, session: before.session, key: before.key,
    focusInChrome: false, header: { height: before.header.height, opacity: '0' },
    footer: { height: before.footer.height, opacity: '0' } });
  expect(hidden.stage).toEqual(before.stage);
  expect(hidden.media).toEqual(before.media);
  expect(hidden.view).toEqual(before.view);
  expect(hidden.images).toEqual(before.images);
  return hidden;
}

for (const width of [375, 1280]) {
  for (const mode of ['image', 'slideshow', 'comic']) {
    test(`fullscreen click-to-hide: ${mode} at ${width}px preserves content and overlay geometry`, async ({ page }) => {
      await page.setViewportSize({ width, height: 812 });
      await openPage(page);
      if (mode === 'comic') {
        await openComic(page, fixture.comics.mixed);
        await setReader(page, { layout: 'spread', alignment: 'pair-from-first', direction: 'rtl' });
        await expect.poll(() => spreadStatuses(page)).toEqual(['loaded', 'loaded']);
      } else await openClickHideImage(page, mode === 'slideshow');
      // Ordinary dialog clicks keep chrome and the dialog visible.
      let point = await clickHidePoint(page);
      await page.mouse.click(point.x, point.y);
      expect((await clickHideGeometry(page)).header.opacity).toBe('1');
      await page.locator(`${DIALOG} [data-unified-viewer-fullscreen]`).click();
      await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
      await expectClickShownGeometry(page);
      const before = await clickHideGeometry(page);
      point = await clickHidePoint(page);
      await page.mouse.move(point.x, point.y);
      await page.mouse.down();
      expect((await clickHideGeometry(page)).header.opacity).toBe('1');
      await page.mouse.up();
      const hidden = await expectClickHidden(page, before);
      expect(hidden.playback).toEqual(before.playback);
      await page.waitForTimeout(150); // Catch a compatibility click or a geometry-induced reveal.
      expect((await clickHideGeometry(page)).header.opacity).toBe('0');
      // A second click while hidden stays hidden, including its pointerdown.
      await page.mouse.down();
      expect((await clickHideGeometry(page)).header.opacity).toBe('0');
      await page.mouse.up();
      expect((await clickHideGeometry(page)).header.opacity).toBe('0');
      await page.mouse.move(point.x + 20, point.y);
      await expect.poll(async () => (await clickHideGeometry(page)).header.opacity).toBe('1');
      await expectClickShownGeometry(page);
      // Existing idle hiding still works after manual hide and pointer reveal.
      await expect.poll(async () => (await clickHideGeometry(page)).header.opacity, { timeout: 6000 }).toBe('0');
      await page.keyboard.press('Tab');
      await expect.poll(async () => (await clickHideGeometry(page)).header.opacity).toBe('1');
      await page.locator(`${DIALOG} [data-unified-viewer-fullscreen]`).click();
      await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
      await page.locator(CLOSE).click();
      await expect(page.locator('#test-opener')).toBeFocused();
    });
  }
}

test('fullscreen click-to-hide: drag, cancellation, reader controls and Retry keep their actions', async ({ page }) => {
  const routes = await openPage(page);
  await openComic(page, fixture.comics.mixed);
  await setReader(page, { layout: 'spread', alignment: 'pair-from-first' });
  await expect.poll(() => spreadStatuses(page)).toEqual(['loaded', 'loaded']);
  await page.locator(`${DIALOG} [data-unified-viewer-fullscreen]`).click();
  await openSecondaryTools(page);
  await page.locator(`${DIALOG} [data-unified-viewer-zoom-in]`).click();
  await closeSecondaryTools(page);
  const before = await clickHideGeometry(page);
  let point = await clickHidePoint(page);
  const transform = await page.locator('[data-viewer-content="spread"]').getAttribute('style');
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 60, point.y + 30, { steps: 8 });
  await page.mouse.up();
  expect((await clickHideGeometry(page)).header.opacity).toBe('1');
  expect(await page.locator('[data-viewer-content="spread"]').getAttribute('style')).not.toBe(transform);
  expect((await clickHideGeometry(page)).key).toBe(before.key);
  await page.locator(`${DIALOG} [data-unified-viewer-fit]`).click();
  point = await clickHidePoint(page);
  await page.locator(MEDIA).dispatchEvent('pointerdown', { pointerId: 55, pointerType: 'pen', isPrimary: true,
    button: 0, clientX: point.x, clientY: point.y });
  await page.locator(MEDIA).dispatchEvent('pointercancel', { pointerId: 55 });
  await page.locator(MEDIA).dispatchEvent('pointerup', { pointerId: 55, pointerType: 'pen', isPrimary: true,
    button: 0, clientX: point.x, clientY: point.y });
  expect((await clickHideGeometry(page)).header.opacity).toBe('1');
  await page.locator(NEXT).click();
  await expect.poll(() => spreadStatuses(page)).toEqual(['loaded', 'loaded']);
  expect((await clickHideGeometry(page)).key).not.toBe(before.key);
  expect((await clickHideGeometry(page)).header.opacity).toBe('1');
  await page.locator(CLOSE).click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
  await openComic(page, fixture.comics.three);
  await setReader(page, { layout: 'single' });
  await shownKey(page, pageKey(fixture.comics.three, 1));
  await page.locator(NEXT).click();
  await expect(page.locator(PAGE_RETRY)).toBeVisible();
  await page.locator(`${DIALOG} [data-unified-viewer-fullscreen]`).click();
  const retryKey = (await state(page)).key;
  const retryPath = `${manifestPath(fixture.comics.three)}/pages/2`;
  const requests = routes.count(retryPath);
  await page.locator(PAGE_RETRY).click();
  await expect.poll(() => routes.count(retryPath)).toBe(requests + 1);
  await expect(page.locator(PAGE_RETRY)).toBeVisible();
  expect(await state(page)).toMatchObject({ key: retryKey, open: true, fullscreen: true });
  expect((await clickHideGeometry(page)).header.opacity).toBe('1');
});

for (const width of [375, 1280]) {
  test(`fullscreen click-to-hide: dropdown dismissal and focus at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 812 });
    await openPage(page);
    await openClickHideImage(page, true);
    await page.locator(`${DIALOG} [data-unified-viewer-fullscreen]`).click();
    await choose(page, `${DIALOG} #unified-viewer-speed-dropdown`, '2 s');
    expect(await page.evaluate(() => window.__viewer().playback.getState().speed)).toBe(2000);
    const compact = await openSecondaryTools(page);
    const menu = compact ? '[data-unified-viewer-overflow]' : '#unified-viewer-speed-dropdown';
    if (!compact) await page.locator(`${menu} summary`).click();
    await expect(page.locator(menu)).toHaveAttribute('open', '');
    const before = await clickHideGeometry(page);
    const point = await clickHidePoint(page);
    await page.mouse.click(point.x, point.y);
    await expectClickHidden(page, before);
    await expect(page.locator(`${DIALOG} details[open]`)).toHaveCount(0);
    await page.keyboard.press('Tab');
    await expect.poll(async () => (await clickHideGeometry(page)).header.opacity).toBe('1');
    await page.locator(CLOSE).click();
    await expect(page.locator('#test-opener')).toBeFocused();
  });
}

test('fullscreen click-to-hide: slideshow deadline survives click and controls remain usable', async ({ page }) => {
  await openPage(page);
  await openClickHideImage(page, true);
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await page.locator(`${DIALOG} [data-unified-viewer-fullscreen]`).click();
  await page.locator(`${DIALOG} [data-unified-viewer-play]`).click();
  const before = await clickHideGeometry(page);
  await page.clock.runFor(1000);
  const point = await clickHidePoint(page);
  await page.mouse.click(point.x, point.y);
  await expectClickHidden(page, before);
  expect(await page.evaluate(() => window.__viewer().playback.getState().playing)).toBe(true);
  await page.clock.runFor(2999);
  expect((await state(page)).key).toBe(before.key);
  await page.clock.runFor(1);
  await expect.poll(async () => (await state(page)).key).not.toBe(before.key);
  await page.mouse.move(point.x + 20, point.y);
  await page.locator(`${DIALOG} [data-unified-viewer-play]`).click();
  expect(await page.evaluate(() => window.__viewer().playback.getState().playing)).toBe(false);
  await page.locator(PREVIOUS).click();
  expect((await state(page)).key).toBe(before.key);
});

test('fullscreen click-to-hide: image pan, reopen, backdrop and View Details retain their behavior', async ({ page }) => {
  await openPage(page);
  await openClickHideImage(page);
  await page.locator(`${DIALOG} [data-unified-viewer-fullscreen]`).click();
  await openSecondaryTools(page);
  for (let count = 0; count < 4; count += 1) await page.locator(`${DIALOG} [data-unified-viewer-zoom-in]`).click();
  await closeSecondaryTools(page);
  let point = await clickHidePoint(page);
  const transform = await page.locator('[data-viewer-content]').getAttribute('style');
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 65, point.y + 30, { steps: 6 });
  await page.mouse.up();
  expect(await page.locator('[data-viewer-content]').getAttribute('style')).not.toBe(transform);
  expect((await clickHideGeometry(page)).header.opacity).toBe('1');
  // An unfinished press from the old session cannot dismiss the new one.
  await page.locator(MEDIA).dispatchEvent('pointerdown', { pointerId: 62, pointerType: 'mouse',
    isPrimary: true, button: 0, clientX: point.x, clientY: point.y });
  await page.locator(CLOSE).click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
  await openClickHideImage(page);
  await page.locator(`${DIALOG} [data-unified-viewer-fullscreen]`).click();
  await page.locator(MEDIA).dispatchEvent('pointerup', { pointerId: 62, pointerType: 'mouse',
    isPrimary: true, button: 0, clientX: point.x, clientY: point.y });
  expect((await clickHideGeometry(page)).header.opacity).toBe('1');
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
  point = await clickHidePoint(page);
  await page.mouse.click(point.x, point.y);
  await expect(page.locator(DIALOG)).toBeVisible();
  await page.mouse.click(2, 2);
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(page.locator('#test-opener')).toBeFocused();
  await openClickHideImage(page);
  await page.locator(`${DIALOG} [data-unified-viewer-fullscreen]`).click();
  await page.route('**/projects/1/assets/901', (route) => route.fulfill({ contentType: 'text/html', body: '<p>Asset Details</p>' }));
  await page.getByRole('link', { name: 'View details', exact: true }).click();
  await expect(page).toHaveURL(`${fixture.baseURL}/projects/1/assets/901`);
});

test.describe('fullscreen click-to-hide touch', () => {
  test.use({ hasTouch: true });
  test('a browser tap hides chrome and a cancelled touch never hides it', async ({ page }) => {
    await openPage(page);
    await openClickHideImage(page);
    await page.locator(`${DIALOG} [data-unified-viewer-fullscreen]`).click();
    const before = await clickHideGeometry(page);
    const point = await clickHidePoint(page);
    await page.touchscreen.tap(point.x, point.y);
    await expectClickHidden(page, before);
    // D1-C (user direction): a touch tap on hidden chrome reveals it; the
    // next one hides it again.
    await page.touchscreen.tap(point.x, point.y);
    expect((await clickHideGeometry(page)).header.opacity).toBe('1');
    await page.touchscreen.tap(point.x, point.y);
    expect((await clickHideGeometry(page)).header.opacity).toBe('0');
    await page.keyboard.press('Tab');
    await page.locator(MEDIA).dispatchEvent('pointerdown', { pointerId: 44, pointerType: 'touch',
      isPrimary: true, button: 0, clientX: point.x, clientY: point.y });
    await page.locator(MEDIA).dispatchEvent('pointermove', { pointerId: 44, pointerType: 'touch',
      clientX: point.x, clientY: point.y + 40 });
    await page.locator(MEDIA).dispatchEvent('pointercancel', { pointerId: 44 });
    expect((await clickHideGeometry(page)).header.opacity).toBe('1');
  });
});

const preferenceKey = (id) => `${PREFERENCES_KEY}:v1:comic:${fixture.projectId}:${id}`;
const storedPreferences = (page, id) => page.evaluate((key) => {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  const { version, ...options } = JSON.parse(raw);
  if (version !== 1) throw new Error('Expected preference schema version 1');
  return options;
}, preferenceKey(id));
const viewerSession = (page) => page.evaluate(() => window.__viewer().getState().session);
const spreadStatuses = (page) => page.evaluate(() => window.__viewer().media.getState().pages.map((entry) => entry.status));

// The page's own test host again after a reload (openPage's routes and init
// script stay installed on the page).
async function rebindHost(page) {
  await page.waitForFunction(() => Boolean(document.getElementById('unified-viewer-dialog')?.__creatorCrateUnifiedViewer));
  await page.evaluate(() => {
    const host = document.createElement('div');
    host.id = 'test-viewer-host';
    host.innerHTML = '<button type="button" id="test-opener">Open comic</button>';
    document.querySelector('main').prepend(host);
    window.__viewer = () => document.getElementById('unified-viewer-dialog').__creatorCrateUnifiedViewer;
  });
}

test('C1f: the visible controls set direction, layout and alignment, keeping the anchor and fetching only new pages', async ({ page }) => {
  const routes = await openPage(page);
  const writes = recordWrites(page);
  const id = fixture.comics.mixed;
  const session = await openComic(page, id, 'Mixed pages');
  await shownKey(page, pageKey(id, 1));

  // A: defaults, clearly named.
  await expect(page.locator(READER)).toBeVisible();
  await expect(page.getByRole('group', { name: 'Comic reading' })).toBeVisible();
  await expect(shownChoice(page, DIRECTION_MENU)).toHaveText('Left-to-Right');
  await expect(shownChoice(page, LAYOUT_MENU)).toHaveText('Single Page');
  await expect(page.locator(`${DIRECTION_MENU} summary`)).toHaveAttribute('aria-label', 'Reading direction: Left-to-Right');
  await expect(page.locator(`${LAYOUT_MENU} summary`)).toHaveAttribute('aria-label', 'Page layout: Single Page');
  expect(await storedPreferences(page, id)).toBe(null);

  // F/G: Two-Page Spread — Cover Alone; page 1 stays alone.
  await choose(page, LAYOUT_MENU, 'Two-Page Spread — Cover Alone');
  await expect(shownChoice(page, LAYOUT_MENU)).toHaveText('Two-Page Spread — Cover Alone');
  await expect(page.locator(`${LAYOUT_MENU} summary`)).toBeFocused();
  await expect(page.locator(POSITION)).toHaveText('Page 1 of 5');
  await expect(page.locator(SHOWN)).toHaveCount(1);
  expect(pagesSeen(routes, id)).toEqual([1]);

  // H: pages 2–3.
  await page.locator(NEXT).click();
  await expect(page.locator(POSITION)).toHaveText('Pages 2–3 of 5');
  await expect(page.locator(SHOWN)).toHaveCount(2);
  await expect.poll(() => spreadStatuses(page)).toEqual(['loaded', 'loaded']);
  const ltr = { two: await box(page, pageImage(id, 2)), three: await box(page, pageImage(id, 3)) };
  expect(ltr.two.right).toBeLessThanOrEqual(ltr.three.left + 1);

  // Clicking a dropdown never pans a magnified spread.
  await page.locator(`${DIALOG} [data-unified-viewer-zoom-in]`).click();
  const zoomed = await mediaView(page);
  expect(zoomed.mode).toBe('zoom');
  await page.locator(`${DIRECTION_MENU} summary`).click();
  await page.locator(`${DIRECTION_MENU} summary`).click();
  await expect(page.locator(DIRECTION_MENU)).not.toHaveAttribute('open', '');
  expect(await mediaView(page)).toEqual(zoomed);

  // B/C/E: Right-to-Left swaps placement with no page or manifest request.
  await markImages(page);
  const requests = pagesSeen(routes, id).length;
  const sources = await page.locator(`${SPREAD} img`).evaluateAll((images) => images.map((image) => image.src));
  await choose(page, DIRECTION_MENU, 'Right-to-Left');
  await expect(shownChoice(page, DIRECTION_MENU)).toHaveText('Right-to-Left');
  await expect(page.locator(`${DIRECTION_MENU} summary`)).toHaveAttribute('aria-label', 'Reading direction: Right-to-Left');
  const rtl = { two: await box(page, pageImage(id, 2)), three: await box(page, pageImage(id, 3)) };
  expect(rtl.three.right).toBeLessThanOrEqual(rtl.two.left + 1);
  expect(await markers(page)).toEqual(['Page 2', 'Page 3']);
  expect(await page.locator(`${SPREAD} img`).evaluateAll((images) => images.map((image) => image.src))).toEqual(sources);
  expect(await mediaView(page)).toEqual(zoomed);
  await page.waitForTimeout(200);
  expect(pagesSeen(routes, id)).toHaveLength(requests);
  expect(routes.count(manifestPath(id))).toBe(1);
  await expect(page.locator(`${DIRECTION_MENU} summary`)).toBeFocused();

  // D: arrows on the menu trigger never turn pages; from the viewer, RTL arrows reverse.
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator(POSITION)).toHaveText('Pages 2–3 of 5');
  await page.locator(CLOSE).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator(POSITION)).toHaveText('Pages 4–5 of 5');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator(POSITION)).toHaveText('Pages 2–3 of 5');
  await expect.poll(() => spreadStatuses(page)).toEqual(['loaded', 'loaded']);
  await markImages(page);
  const beforePair = pagesSeen(routes, id).length;

  // I/J: Pair from Page 1 regroups around anchor 2 as [1,2]; page 2 is kept.
  await choose(page, LAYOUT_MENU, 'Two-Page Spread — Pair from Page 1');
  await expect(page.locator(POSITION)).toHaveText('Pages 1–2 of 5');
  expect((await state(page)).key).toBe(pageKey(id, 2));
  await expect(page.locator(pageImage(id, 1))).toBeVisible();
  expect(await page.locator(pageImage(id, 2)).evaluate((image) => image.dataset.c1eMarker)).toBe('Page 2');
  expect(pagesSeen(routes, id).slice(beforePair)).toEqual([1]);
  const pair = { one: await box(page, pageImage(id, 1)), two: await box(page, pageImage(id, 2)) };
  expect(pair.two.right).toBeLessThanOrEqual(pair.one.left + 1);
  expect((await mediaView(page)).mode).toBe('fit');

  // K: Single Page keeps the anchor and releases its companion.
  await choose(page, LAYOUT_MENU, 'Single Page');
  await expect(page.locator(POSITION)).toHaveText('Page 2 of 5');
  await expect(page.locator(SHOWN)).toHaveCount(1);
  expect(await page.locator(SHOWN).evaluate((image) => image.dataset.c1eMarker)).toBe('Page 2');
  await expect.poll(() => live(page)).toBe(1);
  // L/M: the spread alignment is remembered underneath Single Page …
  expect(await readerState(page)).toMatchObject({ layout: 'single', alignment: 'pair-from-first', direction: 'rtl' });
  expect(await storedPreferences(page, id)).toEqual({ direction: 'rtl', layout: 'single', alignment: 'pair-from-first' });
  // … and returning to two pages uses it, with the menu following the controller.
  await setReader(page, { layout: 'spread' });
  await expect(page.locator(POSITION)).toHaveText('Pages 1–2 of 5');
  await expect(shownChoice(page, LAYOUT_MENU)).toHaveText('Two-Page Spread — Pair from Page 1');
  // Picking the current choice again is a no-op. (The shared dropdown, like
  // the speed menu, stays open for an already-checked option; Escape closes it.)
  const seenBefore = routes.seen.length;
  const writesBefore = await page.evaluate(() => {
    window.__preferenceWrites = 0;
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function counted(...args) {
      window.__preferenceWrites += 1;
      return setItem.apply(this, args);
    };
    return window.__preferenceWrites;
  });
  await page.locator(`${LAYOUT_MENU} summary`).click();
  await page.locator(`${LAYOUT_MENU} .asset-filter-multiselect-panel`).getByText('Two-Page Spread — Pair from Page 1', { exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator(LAYOUT_MENU)).not.toHaveAttribute('open', '');
  await expect(page.locator(DIALOG)).toBeVisible();
  await page.waitForTimeout(150);
  expect(routes.seen.length).toBe(seenBefore);
  expect(await page.evaluate(() => window.__preferenceWrites)).toBe(writesBefore);
  await expect(page.locator(POSITION)).toHaveText('Pages 1–2 of 5');

  // Same dialog and session throughout; Z: nothing but GETs.
  expect(await state(page)).toMatchObject({ session, open: true });
  expect(await page.evaluate(() => document.querySelectorAll('dialog#unified-viewer-dialog').length)).toBe(1);
  expect(writes).toEqual([]);
  await page.locator(CLOSE).click();
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(page.locator('#test-opener')).toBeFocused();
  expect(await live(page)).toBe(0);
});

test('reading preferences stay with each comic across reopen, reload and a replacement browser context', async ({ page, browser }) => {
  const routes = await openPage(page);
  const writes = recordWrites(page);
  const a = fixture.comics.seven;
  const b = fixture.comics.mixed;
  const c = fixture.comics.equal;
  const cover = 'Two-Page Spread — Cover Alone';
  const pair = 'Two-Page Spread — Pair from Page 1';
  const single = 'Single Page';
  const rtl = 'Right-to-Left';
  const ltr = 'Left-to-Right';
  const close = (tab) => tab.locator(CLOSE).click();

  async function check(tab, direction, layout, position) {
    await expect(shownChoice(tab, DIRECTION_MENU)).toHaveText(direction);
    await expect(shownChoice(tab, LAYOUT_MENU)).toHaveText(layout);
    await expect(tab.locator(`${DIRECTION_MENU} input[type="radio"]:checked`)).toHaveValue(direction === rtl ? 'rtl' : 'ltr');
    await expect(tab.locator(`${LAYOUT_MENU} input[type="radio"]:checked`)).toHaveValue(
      layout === single ? 'single' : layout === cover ? 'spread-cover-alone' : 'spread-pair-from-first',
    );
    await expect(tab.locator(POSITION)).toHaveText(position);
  }

  await openComic(page, a);
  await shownKey(page, pageKey(a, 1));
  await choose(page, DIRECTION_MENU, rtl);
  await choose(page, LAYOUT_MENU, cover);
  await check(page, rtl, cover, 'Page 1 of 7');
  await close(page);

  await openComic(page, b);
  await shownKey(page, pageKey(b, 1));
  await check(page, ltr, single, 'Page 1 of 5');
  await choose(page, DIRECTION_MENU, rtl);
  await choose(page, LAYOUT_MENU, pair);
  await choose(page, DIRECTION_MENU, ltr);
  await choose(page, LAYOUT_MENU, single);
  await check(page, ltr, single, 'Page 1 of 5');
  await close(page);

  await openComic(page, c);
  await shownKey(page, pageKey(c, 1));
  await check(page, ltr, single, 'Page 1 of 5');
  await choose(page, DIRECTION_MENU, rtl);
  await choose(page, LAYOUT_MENU, pair);
  await expect.poll(() => spreadStatuses(page)).toEqual(['loaded', 'loaded']);
  await close(page);

  const verifyAll = async (tab) => {
    await openComic(tab, a);
    await check(tab, rtl, cover, 'Page 1 of 7');
    await close(tab);
    await openComic(tab, b);
    await check(tab, ltr, single, 'Page 1 of 5');
    await close(tab);
    await openComic(tab, c);
    await check(tab, rtl, pair, 'Pages 1–2 of 5');
    await expect(tab.locator(SHOWN)).toHaveCount(2);
    const one = await box(tab, pageImage(c, 1));
    const two = await box(tab, pageImage(c, 2));
    expect(two.right).toBeLessThanOrEqual(one.left + 1);
    await close(tab);
  };

  const before = pagesSeen(routes, c).length;
  await verifyAll(page);
  expect(pagesSeen(routes, c).slice(before).sort()).toEqual([1, 2]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await rebindHost(page);
  await verifyAll(page);
  expect(await storedPreferences(page, a)).toEqual({ direction: 'rtl', layout: 'spread', alignment: 'cover-alone' });
  expect(await storedPreferences(page, b)).toEqual({ direction: 'ltr', layout: 'single', alignment: 'pair-from-first' });
  expect(await storedPreferences(page, c)).toEqual({ direction: 'rtl', layout: 'spread', alignment: 'pair-from-first' });
  expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.includes('comic')))).toHaveLength(3);
  expect(writes).toEqual([]);

  const saved = await page.context().storageState();
  await page.context().close();
  const context = await browser.newContext({ storageState: saved });
  try {
    const restored = await context.newPage();
    await openPage(restored);
    await verifyAll(restored);
  } finally {
    await context.close();
  }

  const freshContext = await browser.newContext();
  try {
    const fresh = await freshContext.newPage();
    await openPage(fresh);
    await openComic(fresh, a);
    await check(fresh, ltr, single, 'Page 1 of 7');
    expect(await storedPreferences(fresh, a)).toBe(null);
  } finally {
    await freshContext.close();
  }
});

async function verifyTwoTabPreferenceRecovery({ page, context }, { corruptDirection = false } = {}) {
  const other = await context.newPage();
  const id = fixture.comics.seven;
  const cover = 'Two-Page Spread — Cover Alone';
  const pair = 'Two-Page Spread — Pair from Page 1';
  const rtlPair = { direction: 'rtl', layout: 'spread', alignment: 'pair-from-first' };
  await page.addInitScript((prefix) => {
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    window.__preferenceWrites = 0;
    Storage.prototype.getItem = function (key) {
      if (key.startsWith(prefix) && window.__denyPreferences) throw new DOMException('Denied', 'SecurityError');
      return get.call(this, key);
    };
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith(prefix)) {
        if (window.__denyPreferences) throw new DOMException('Denied', 'QuotaExceededError');
        window.__preferenceWrites += 1;
      }
      return set.call(this, key, value);
    };
  }, PREFERENCES_KEY);
  const routes = await openPage(page);
  await openPage(other);
  const session = await openComic(page, id);
  await openComic(other, id);
  await shownKey(page, pageKey(id, 1));
  await shownKey(other, pageKey(id, 1));

  await page.evaluate(() => { window.__denyPreferences = true; });
  await choose(page, LAYOUT_MENU, cover);
  await expect(shownChoice(page, LAYOUT_MENU)).toHaveText(cover);
  await expect(page.locator(POSITION)).toHaveText('Page 1 of 7');
  expect(await storedPreferences(other, id)).toBeNull();

  await choose(other, LAYOUT_MENU, pair);
  expect(await storedPreferences(other, id)).toEqual({ ...rtlPair, direction: 'ltr' });
  await expect(other.locator(POSITION)).toHaveText('Pages 1–2 of 7');
  await expect(other.locator(pageImage(id, 1))).toBeVisible();
  await expect(other.locator(pageImage(id, 2))).toBeVisible();

  if (corruptDirection) {
    await other.evaluate((key) => {
      const saved = JSON.parse(localStorage.getItem(key));
      localStorage.setItem(key, JSON.stringify({ ...saved, direction: 'up' }));
    }, preferenceKey(id));
    await other.locator(CLOSE).click();
    await openComic(other, id);
    await expect(shownChoice(other, DIRECTION_MENU)).toHaveText('Left-to-Right');
    await expect(shownChoice(other, LAYOUT_MENU)).toHaveText(pair);
    await expect(other.locator(`${LAYOUT_MENU} input:checked`)).toHaveValue('spread-pair-from-first');
    await expect(other.locator(POSITION)).toHaveText('Pages 1–2 of 7');
    await expect(other.locator(pageImage(id, 1))).toBeVisible();
    await expect(other.locator(pageImage(id, 2))).toBeVisible();
    expect(await storedPreferences(other, id)).toEqual({ ...rtlPair, direction: 'up' });
  }

  await page.evaluate(() => { window.__denyPreferences = false; });
  await choose(page, DIRECTION_MENU, 'Right-to-Left');
  expect(await storedPreferences(other, id)).toEqual(rtlPair);
  async function checkMergedReader() {
    await expect(shownChoice(page, DIRECTION_MENU)).toHaveText('Right-to-Left');
    await expect(shownChoice(page, LAYOUT_MENU)).toHaveText(pair);
    await expect(page.locator(`${DIRECTION_MENU} input:checked`)).toHaveValue('rtl');
    await expect(page.locator(`${LAYOUT_MENU} input:checked`)).toHaveValue('spread-pair-from-first');
    await expect(page.locator(POSITION)).toHaveText('Pages 1–2 of 7');
    expect(await readerState(page)).toMatchObject({ ...rtlPair, anchorPosition: 1, groupPositions: [1, 2], visibleItems: [2, 1] });
    await expect(page.locator(pageImage(id, 1))).toBeVisible();
    await expect(page.locator(pageImage(id, 2))).toBeVisible();
    expect((await box(page, pageImage(id, 2))).left).toBeLessThan((await box(page, pageImage(id, 1))).left);
  }
  await checkMergedReader();
  expect(await viewerSession(page)).toBe(session);
  expect(routes.count(manifestPath(id))).toBe(1);
  expect(await page.evaluate(() => window.__preferenceWrites)).toBe(1);

  await page.locator(CLOSE).click();
  await openComic(page, id);
  await checkMergedReader();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await rebindHost(page);
  await openComic(page, id);
  await checkMergedReader();
  expect(await page.evaluate(() => window.__preferenceWrites)).toBe(0);
  expect(await storedPreferences(page, id)).toEqual(rtlPair);

  // The other tab still shows LTR. Its Page Spread edits retain the saved RTL.
  await expect(shownChoice(other, DIRECTION_MENU)).toHaveText('Left-to-Right');
  await choose(other, LAYOUT_MENU, cover);
  expect(await storedPreferences(page, id)).toEqual({ ...rtlPair, alignment: 'cover-alone' });
  await expect(shownChoice(other, DIRECTION_MENU)).toHaveText('Right-to-Left');
  await expect(other.locator(POSITION)).toHaveText('Page 1 of 7');
  await choose(other, LAYOUT_MENU, pair);
  await choose(other, LAYOUT_MENU, 'Single Page');
  expect(await storedPreferences(page, id)).toEqual({ ...rtlPair, layout: 'single' });
  await expect(other.locator(POSITION)).toHaveText('Page 1 of 7');
}

test('two tabs merge comic reader preferences after storage recovers', async ({ page, context }) => {
  await verifyTwoTabPreferenceRecovery({ page, context });
});

test('two tabs preserve valid comic reader fields after storage recovers with an invalid saved direction', async ({ page, context }) => {
  await verifyTwoTabPreferenceRecovery({ page, context }, { corruptDirection: true });
});

async function seedProtectedPreferences(page, entries) {
  await page.evaluate(({ entries, prefix }) => {
    for (const [key, raw] of entries) localStorage.setItem(key, raw);
    const set = Storage.prototype.setItem;
    window.__protectedPreferenceWrites = [];
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith(prefix)) window.__protectedPreferenceWrites.push(key);
      return set.call(this, key, value);
    };
  }, { entries, prefix: PREFERENCES_KEY });
}

test('oversized future comic preferences preserve raw storage through reader edits and reopen', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const routes = await openPage(page);
  const id = fixture.comics.seven;
  const key = preferenceKey(id);
  const future = 'x'.repeat(1024);
  const raw = JSON.stringify({ version: 2, direction: 'rtl', layout: 'spread', alignment: 'pair-from-first', future });
  expect(raw.length).toBeGreaterThan(1024);
  await seedProtectedPreferences(page, [[key, raw]]);
  const original = await page.evaluate((key) => localStorage.getItem(key), key);
  const session = await openComic(page, id);
  await shownKey(page, pageKey(id, 1));
  expect(await readerState(page)).toMatchObject({ direction: 'ltr', layout: 'single', alignment: 'cover-alone' });
  await choose(page, DIRECTION_MENU, 'Right-to-Left');
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(original);
  expect(await readerState(page)).toMatchObject({ direction: 'rtl' });
  await choose(page, LAYOUT_MENU, 'Two-Page Spread — Pair from Page 1');
  await expect.poll(() => spreadStatuses(page)).toEqual(['loaded', 'loaded']);
  await page.locator(NEXT).click();
  await expect(page.locator(POSITION)).toHaveText('Pages 3–4 of 7');
  expect(routes.count(manifestPath(id))).toBe(1);
  expect(await viewerSession(page)).toBe(session);
  await page.locator(CLOSE).click();
  await openComic(page, id);
  await expect(page.locator(POSITION)).toHaveText('Pages 1–2 of 7');
  expect(await readerState(page)).toMatchObject({ direction: 'rtl', layout: 'spread', alignment: 'pair-from-first' });
  expect(await page.evaluate((session) => window.__viewer().setComicReaderOptions({ direction: 'ltr' }, { session }), session)).toBeNull();
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(original);
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).future, key)).toBe(future);
  expect(await page.evaluate(() => window.__protectedPreferenceWrites)).toEqual([]);

  const other = fixture.comics.mixed;
  await openComic(page, other);
  await shownKey(page, pageKey(other, 1));
  await choose(page, DIRECTION_MENU, 'Right-to-Left');
  expect(await storedPreferences(page, other)).toEqual({ direction: 'rtl', layout: 'single', alignment: 'cover-alone' });
  expect(await page.evaluate(() => window.__protectedPreferenceWrites)).toEqual([preferenceKey(other)]);
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(original);
  expect(errors).toEqual([]);
});

test('oversized defaults snapshot survives legacy migration and repeated reader edits', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const routes = await openPage(page);
  const id = fixture.comics.seven;
  const key = `${PREFERENCES_KEY}:v1:defaults`;
  const raw = JSON.stringify({ version: 1, direction: 'ltr', layout: 'spread', alignment: 'pair-from-first', future: 'x'.repeat(1024) });
  const legacy = JSON.stringify({ direction: 'rtl', layout: 'single', alignment: 'cover-alone' });
  await seedProtectedPreferences(page, [[key, raw], [PREFERENCES_KEY, legacy]]);
  const original = await page.evaluate((key) => localStorage.getItem(key), key);
  await openComic(page, id);
  await shownKey(page, pageKey(id, 1));
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(original);
  expect(await readerState(page)).toMatchObject({ direction: 'rtl', layout: 'single', alignment: 'cover-alone' });
  await choose(page, DIRECTION_MENU, 'Left-to-Right');
  await choose(page, LAYOUT_MENU, 'Two-Page Spread — Pair from Page 1');
  await expect.poll(() => spreadStatuses(page)).toEqual(['loaded', 'loaded']);
  expect(await storedPreferences(page, id)).toEqual({ direction: 'ltr', layout: 'spread', alignment: 'pair-from-first' });
  expect(routes.count(manifestPath(id))).toBe(1);
  await page.locator(CLOSE).click();
  const other = fixture.comics.mixed;
  await openComic(page, other);
  await shownKey(page, pageKey(other, 1));
  expect(await readerState(page)).toMatchObject({ direction: 'rtl', layout: 'single', alignment: 'cover-alone' });
  await choose(page, DIRECTION_MENU, 'Left-to-Right');
  expect(await storedPreferences(page, other)).toEqual({ direction: 'ltr', layout: 'single', alignment: 'cover-alone' });
  await page.locator(CLOSE).click();
  await openComic(page, id);
  await expect.poll(() => spreadStatuses(page)).toEqual(['loaded', 'loaded']);
  expect(await readerState(page)).toMatchObject({ direction: 'ltr', layout: 'spread', alignment: 'pair-from-first' });
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(original);
  expect(await page.evaluate((key) => localStorage.getItem(key), PREFERENCES_KEY)).toBe(legacy);
  expect(await page.evaluate(() => window.__protectedPreferenceWrites)).toEqual([
    preferenceKey(id), preferenceKey(id), preferenceKey(other),
  ]);
  expect(errors).toEqual([]);
});

test('malformed and denied preference storage keeps a separate fallback for each comic during loading and failure', async ({ page }) => {
  const a = fixture.comics.seven;
  const b = fixture.comics.mixed;
  await page.addInitScript(({ key, legacy }) => {
    localStorage.setItem(key, '{');
    localStorage.setItem(legacy, 'broken JSON');
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    Storage.prototype.getItem = function (name) {
      if (name.startsWith(legacy) && window.__denyPreferences) throw new DOMException('Denied', 'SecurityError');
      return get.call(this, name);
    };
    Storage.prototype.setItem = function (name, value) {
      if (name.startsWith(legacy) && window.__denyPreferences) throw new DOMException('Denied', 'QuotaExceededError');
      return set.call(this, name, value);
    };
  }, { key: preferenceKey(a), legacy: PREFERENCES_KEY });
  const routes = await openPage(page);
  const release = routes.hold(manifestPath(a));
  try {
    await openComic(page, a);
    await expect(shownChoice(page, DIRECTION_MENU)).toHaveText('Left-to-Right');
    await expect(shownChoice(page, LAYOUT_MENU)).toHaveText('Single Page');
    await expect.poll(() => routes.count(manifestPath(a))).toBe(1);
    await page.evaluate(() => { window.__denyPreferences = true; });
    await choose(page, DIRECTION_MENU, 'Right-to-Left');
    await choose(page, LAYOUT_MENU, 'Two-Page Spread — Cover Alone');
    routes.control(manifestPath(b), { status: 503, contentType: 'text/plain', body: 'busy' }, { once: true });
    await openComic(page, b);
    await expect(page.locator(COMIC_RETRY)).toBeVisible();
    await expect(shownChoice(page, DIRECTION_MENU)).toHaveText('Left-to-Right');
    await expect(shownChoice(page, LAYOUT_MENU)).toHaveText('Single Page');
  } finally {
    release();
  }
  await openComic(page, a);
  await shownKey(page, pageKey(a, 1));
  await expect(shownChoice(page, DIRECTION_MENU)).toHaveText('Right-to-Left');
  await expect(shownChoice(page, LAYOUT_MENU)).toHaveText('Two-Page Spread — Cover Alone');
  await expect(page.locator(POSITION)).toHaveText('Page 1 of 7');
});

test('C1f: keyboard operation and Escape order in fullscreen; the session and fullscreen survive every choice', async ({ page }) => {
  await openPage(page);
  const id = fixture.comics.seven;
  const session = await openComic(page, id, 'Seven pages');
  await shownKey(page, pageKey(id, 1));
  await page.locator(DIALOG).getByRole('button', { name: 'Enter fullscreen' }).click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  const isFullscreen = () => page.evaluate(() => Boolean(document.fullscreenElement));

  // U: Enter opens, Escape closes the menu only (fullscreen and dialog kept).
  const directionSummary = page.locator(`${DIRECTION_MENU} summary`);
  await directionSummary.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator(DIRECTION_MENU)).toHaveAttribute('open', '');
  await expect(page.locator(READER)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator(DIRECTION_MENU)).not.toHaveAttribute('open', '');
  await expect(directionSummary).toBeFocused();
  expect(await isFullscreen()).toBe(true);
  await expect(page.locator(DIALOG)).toBeVisible();

  // Keyboard choice: Enter, Tab to the options, ArrowDown picks the next.
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement.closest('#unified-viewer-direction-dropdown') !== null)).toBe(true);
  await page.keyboard.press('ArrowDown');
  await expect(shownChoice(page, DIRECTION_MENU)).toHaveText('Right-to-Left');
  await expect(page.locator(DIRECTION_MENU)).not.toHaveAttribute('open', '');
  await expect(directionSummary).toBeFocused();
  // Menu-owned arrows did not turn the page.
  await expect(page.locator(POSITION)).toHaveText('Page 1 of 7');

  // Space opens the layout menu; a keyboard pick keeps fullscreen.
  const layoutSummary = page.locator(`${LAYOUT_MENU} summary`);
  await layoutSummary.focus();
  await page.keyboard.press('Space');
  await expect(page.locator(LAYOUT_MENU)).toHaveAttribute('open', '');
  await page.keyboard.press('Tab');
  await page.keyboard.press('ArrowDown');
  await expect(shownChoice(page, LAYOUT_MENU)).toHaveText('Two-Page Spread — Cover Alone');
  await expect(layoutSummary).toBeFocused();
  // V: both choices applied in fullscreen; the same session and dialog.
  expect(await readerState(page)).toMatchObject({ direction: 'rtl', layout: 'spread', alignment: 'cover-alone' });
  expect(await state(page)).toMatchObject({ session, open: true, fullscreen: true });
  expect(await isFullscreen()).toBe(true);
  // A mouse choice in fullscreen too.
  await choose(page, LAYOUT_MENU, 'Two-Page Spread — Pair from Page 1');
  await expect(page.locator(POSITION)).toHaveText('Pages 1–2 of 7');
  expect(await isFullscreen()).toBe(true);

  // Escape: the open menu first, then fullscreen, then the viewer.
  await layoutSummary.click();
  await expect(page.locator(LAYOUT_MENU)).toHaveAttribute('open', '');
  await page.keyboard.press('Escape');
  await expect(page.locator(LAYOUT_MENU)).not.toHaveAttribute('open', '');
  expect(await isFullscreen()).toBe(true);
  expect(await page.evaluate(() => document.getElementById('unified-viewer-dialog').contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect.poll(isFullscreen).toBe(false);
  await expect(page.locator(DIALOG)).toBeVisible();
  expect(await viewerSession(page)).toBe(session);
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(page.locator('#test-opener')).toBeFocused();
  expect(await live(page)).toBe(0);
});

test('compact reader tools and comic navigation remain usable at 375px', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openPage(page);
  const id = fixture.comics.seven;
  await openComic(page, id, 'Seven pages');
  await shownKey(page, pageKey(id, 1));
  await choose(page, LAYOUT_MENU, 'Two-Page Spread — Cover Alone');
  await page.locator(NEXT).click();
  await expect(page.locator(POSITION)).toHaveText('Pages 2–3 of 7');
  await expectToolbarGeometry(page);
  await openSecondaryTools(page);
  for (const name of ['Reading direction', 'Page layout']) {
    const select = page.getByRole('combobox', { name, exact: true });
    await expect(select).toBeVisible();
    await expectPointerTarget(select);
  }
  const panel = await box(page, '[data-unified-viewer-overflow-panel]');
  expect(panel.left).toBeGreaterThanOrEqual(0);
  expect(panel.right).toBeLessThanOrEqual(375);
  expect(panel.top).toBeGreaterThanOrEqual(0);
  expect(panel.bottom).toBeLessThanOrEqual(812);
  await page.getByRole('combobox', { name: 'Page layout', exact: true }).selectOption('spread-pair-from-first');
  await closeSecondaryTools(page);
  await expect(page.locator(POSITION)).toHaveText('Pages 1–2 of 7');
  await expect(page.locator(PREVIOUS)).toBeDisabled();
  await page.locator(NEXT).click();
  await expect(page.locator(POSITION)).toHaveText('Pages 3–4 of 7');
  await page.locator(CLOSE).click();
});

test('C1f: image sessions expose no reader controls; slideshow, speed and Original size stay usable', async ({ page }) => {
  await openPage(page);
  const writes = recordWrites(page);
  // A comic set to RTL spreads first, so nothing can leak into the images.
  await openComic(page, fixture.comics.seven, 'Seven pages');
  await shownKey(page, pageKey(fixture.comics.seven, 1));
  await choose(page, DIRECTION_MENU, 'Right-to-Left');
  await choose(page, LAYOUT_MENU, 'Two-Page Spread — Cover Alone');
  await page.locator('#test-opener').focus();
  const session = await page.evaluate(() => window.__viewer().open({
    key: 'c1f-slideshow',
    mode: 'sequence',
    wrap: true,
    slideshow: true,
    items: [1, 2, 3].map((id) => ({
      projectId: 1, assetId: id, title: `image-${id}`, mediaUrl: `/test-media/${id}.webp`, originalUrl: `/test-media/${id}-original.webp`,
    })),
  }, { opener: document.getElementById('test-opener'), autoplay: false }));
  expect(session).toBeGreaterThan(0);
  await expect(page.locator(SHOWN)).toBeVisible();
  // X: no reader controls or reader state for images.
  await expect(page.locator(READER)).toBeHidden();
  await expect(page.locator(`${DIRECTION_MENU} summary`)).toBeHidden();
  expect(await page.evaluate(() => window.__viewer().getState().reader)).toBe(null);
  // Y: slideshow controls, speed and Original size.
  await expect(page.locator(`${DIALOG} [data-unified-viewer-playback]`)).toBeVisible();
  await page.locator('#unified-viewer-speed-dropdown summary').click();
  await page.locator('#unified-viewer-speed-dropdown-options').getByText('2 s', { exact: true }).click();
  await expect(page.locator('#unified-viewer-speed-dropdown summary')).toContainText('2 s');
  expect(await page.evaluate(() => window.__viewer().getState().playback.speed)).toBe(2000);
  const original = page.locator(`${DIALOG} [data-unified-viewer-original]`);
  await expect(original).toBeVisible();
  await expect(original).toBeEnabled();
  await original.click();
  await expect.poll(() => page.evaluate(() => window.__viewer().media.getState().status)).toBe('loaded');
  // Image arrows are not reversed by the remembered comic direction.
  await page.locator(CLOSE).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator(POSITION)).toHaveText('2 of 3');
  await page.locator(`${DIALOG} [data-unified-viewer-play]`).click();
  await expect.poll(() => page.evaluate(() => window.__viewer().getState().playback.playing)).toBe(true);
  await page.locator(`${DIALOG} [data-unified-viewer-play]`).click();
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(page.locator('#test-opener')).toBeFocused();
  // Image sessions left the remembered comic choices as they were.
  expect(await storedPreferences(page, fixture.comics.seven)).toEqual({ direction: 'rtl', layout: 'spread', alignment: 'cover-alone' });
  expect(writes).toEqual([]);
});

test('C1f: choices survive a page 409 Retry and a host-hint refresh; page Retry stays clickable beside the controls', async ({ page }) => {
  const routes = await openPage(page);
  const id = fixture.comics.mixed;
  const session = await openComic(page, id, 'Mixed pages', 's1');
  await shownKey(page, pageKey(id, 1));
  await choose(page, DIRECTION_MENU, 'Right-to-Left');
  await choose(page, LAYOUT_MENU, 'Two-Page Spread — Pair from Page 1');
  await expect(page.locator(POSITION)).toHaveText('Pages 1–2 of 5');

  // A failed page's own Retry stays clickable with the controls present.
  routes.control(pagePath(id, 4), { status: 503, contentType: 'text/plain', body: 'busy' }, { once: true });
  await page.locator(NEXT).click();
  const retry = page.getByRole('button', { name: 'Retry page 4' });
  await expect(retry).toBeVisible();
  await retry.click();
  await expect.poll(() => spreadStatuses(page)).toEqual(['loaded', 'loaded']);

  // A page 409 retires the revision; the reader choices stay, page controls go.
  routes.control(pagePath(id, 1), { status: 409, contentType: 'text/plain', body: 'stale' }, { once: true });
  await page.locator(PREVIOUS).click();
  await expect(page.locator(COMIC_RETRY)).toBeVisible();
  await expect(page.locator(NEXT)).toBeHidden();
  await expect(page.locator(READER)).toBeVisible();
  await expect(shownChoice(page, DIRECTION_MENU)).toHaveText('Right-to-Left');
  await page.locator(COMIC_RETRY).click();
  await expect(page.locator(POSITION)).toHaveText('Pages 1–2 of 5');
  expect(await readerState(page)).toMatchObject({ direction: 'rtl', layout: 'spread', alignment: 'pair-from-first', anchorPosition: 1 });

  // A new host hint refreshes once, keeping the choices and the session.
  const manifests = routes.count(manifestPath(id));
  expect(await reconcileComic(page, id, session, 's2')).toEqual({ outcome: 'reloading' });
  await expect(page.locator(POSITION)).toHaveText('Pages 1–2 of 5');
  expect(routes.count(manifestPath(id))).toBe(manifests + 1);
  expect(await readerState(page)).toMatchObject({ direction: 'rtl', layout: 'spread', alignment: 'pair-from-first' });
  await expect(shownChoice(page, LAYOUT_MENU)).toHaveText('Two-Page Spread — Pair from Page 1');
  expect(await viewerSession(page)).toBe(session);
  // Changing a choice never requests the manifest again.
  await choose(page, LAYOUT_MENU, 'Single Page');
  await page.waitForTimeout(150);
  expect(routes.count(manifestPath(id))).toBe(manifests + 1);
});

async function expectReaderPanelGeometry(page, menu) {
  const panel = page.locator(`${menu} .asset-filter-multiselect-panel`);
  const geometry = await panel.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
      height: rect.height, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight,
      cssBottom: element.computedStyleMap().get('bottom').toString(), overflowY: style.overflowY };
  });
  expect(geometry.clientHeight).toBeGreaterThan(40);
  expect(geometry.height).toBeGreaterThan(42);
  expect(geometry.cssBottom).toBe('auto');
  expect(geometry.overflowY).toBe('auto');
  const viewport = page.viewportSize();
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(viewport.width);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.bottom).toBeLessThanOrEqual(viewport.height);
  return geometry;
}

async function expectPointerTarget(locator) {
  await locator.scrollIntoViewIfNeeded();
  expect(await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return element.contains(hit);
  })).toBe(true);
}

async function expectToolbarGeometry(page) {
  const geometry = await page.locator(DIALOG).evaluate((dialog) => {
    const rect = (element) => {
      const r = element.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const card = dialog.querySelector('.app-dialog-card');
    const context = dialog.querySelector('.unified-viewer-context');
    const controls = [...dialog.querySelectorAll('button, summary, a[href]')]
      .filter((element) => element.getClientRects().length && !element.closest('.asset-filter-multiselect-panel'))
      .map((element) => ({ name: element.getAttribute('aria-label') || element.textContent.trim(), ...rect(element),
        region: rect(element.closest('.unified-viewer-context, .unified-viewer-controls, .app-dialog-header')) }));
    return { card: rect(card), context: rect(context), controls, fullscreen: document.fullscreenElement === card,
      title: rect(dialog.querySelector('[data-unified-viewer-title]')),
      stage: rect(dialog.querySelector('[data-unified-viewer-stage]')),
      navigation: rect(dialog.querySelector('.unified-viewer-controls')),
      scrollWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth,
      backgroundWidth: window.__comicBackgroundWidth };
  });
  for (const control of geometry.controls) {
    expect(control.left, control.name).toBeGreaterThanOrEqual(geometry.card.left - 0.5);
    expect(control.right, control.name).toBeLessThanOrEqual(geometry.card.right + 0.5);
    expect(control.top, control.name).toBeGreaterThanOrEqual(geometry.card.top - 0.5);
    expect(control.bottom, control.name).toBeLessThanOrEqual(geometry.card.bottom + 0.5);
    expect(control.left, control.name).toBeGreaterThanOrEqual(control.region.left - 0.5);
    expect(control.right, control.name).toBeLessThanOrEqual(control.region.right + 0.5);
    expect(control.top, control.name).toBeGreaterThanOrEqual(control.region.top - 0.5);
    expect(control.bottom, control.name).toBeLessThanOrEqual(control.region.bottom + 0.5);
  }
  for (let index = 0; index < geometry.controls.length; index += 1) {
    const a = geometry.controls[index];
    for (const b of geometry.controls.slice(index + 1)) {
      expect(a.left < b.right - 0.5 && b.left < a.right - 0.5
        && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5, `${a.name} overlaps ${b.name}`).toBe(false);
    }
  }
  expect(geometry.title.width).toBeGreaterThan(0);
  expect(geometry.title.height).toBeLessThan(65);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(Math.max(geometry.viewportWidth, geometry.backgroundWidth));
  expect(geometry.card.left).toBeGreaterThanOrEqual(0);
  expect(geometry.card.right).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.stage.height).toBeGreaterThan(250);
  if (geometry.fullscreen) expect(geometry.stage).toEqual(geometry.card);
  else expect(geometry.stage.bottom).toBeLessThanOrEqual(geometry.context.top + 0.5);
  expect(geometry.navigation.bottom).toBeLessThanOrEqual(geometry.context.top + 0.5);
  return geometry;
}

for (const width of [1280]) {
  for (const [name, menu, choices, property] of [
    ['layout', LAYOUT_MENU, [
      ['Two-Page Spread — Cover Alone', 'spread-cover-alone'],
      ['Two-Page Spread — Pair from Page 1', 'spread-pair-from-first'],
      ['Single Page', 'single'],
    ], 'layout'],
    ['direction', DIRECTION_MENU, [['Right-to-Left', 'rtl'], ['Left-to-Right', 'ltr']], 'direction'],
  ]) {
    test(`reader dropdown geometry: ${name} options are pointer-selectable at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 812 });
      const routes = await openPage(page);
      await openComic(page, fixture.comics.seven, 'Comic toolbar geometry');
      await shownKey(page, pageKey(fixture.comics.seven, 1));
      const before = pagesSeen(routes, fixture.comics.seven).length;
      for (const [label, value] of choices) {
        await page.locator(`${menu} summary`).click();
        const geometry = await expectReaderPanelGeometry(page, menu);
        console.log(JSON.stringify({ dropdown: name, width, label, ...geometry }));
        const option = page.locator(`${menu} label`).filter({ hasText: label });
        await expectPointerTarget(option);
        await option.click();
        await expect(page.locator(menu)).not.toHaveAttribute('open', '');
        await expect(shownChoice(page, menu)).toHaveText(label);
        await expect(page.locator(`${menu} summary`)).toBeFocused();
        const reader = await readerState(page);
        expect(property === 'direction' ? reader.direction : reader.layout === 'single'
          ? 'single' : `spread-${reader.alignment}`).toBe(value);
      }
      if (property === 'direction') expect(pagesSeen(routes, fixture.comics.seven)).toHaveLength(before);
      await page.locator(CLOSE).click();
      await expect(page.locator('#test-opener')).toBeFocused();
    });
  }
}

for (const width of [320, 375, 540, 541, 600, 640, 768, 1280]) {
  test(`toolbar geometry: comic single, spread and images at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 812 });
    await openPage(page);
    await openComic(page, fixture.comics.mixed, 'Comic toolbar geometry');
    await shownKey(page, pageKey(fixture.comics.mixed, 1));
    for (const layout of ['single', 'spread']) {
      await setReader(page, { layout, alignment: 'pair-from-first' });
      await expect.poll(() => spreadStatuses(page)).toEqual(layout === 'single' ? ['loaded'] : ['loaded', 'loaded']);
      await expectToolbarGeometry(page);
      await choose(page, DIRECTION_MENU, 'Right-to-Left');
      await choose(page, DIRECTION_MENU, 'Left-to-Right');
      await page.locator(NEXT).click();
      await page.locator(PREVIOUS).click();
      await openSecondaryTools(page);
      await page.locator(`${DIALOG} [data-unified-viewer-zoom-in]`).click();
      await page.locator(`${DIALOG} [data-unified-viewer-zoom-out]`).click();
      await page.locator(`${DIALOG} [data-unified-viewer-zoom-in]`).click();
      await closeSecondaryTools(page);
      await page.locator(`${DIALOG} [data-unified-viewer-fit]`).click();
    }
    const fullscreen = page.locator(`${DIALOG} [data-unified-viewer-fullscreen]`);
    await fullscreen.click();
    await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
    await expectToolbarGeometry(page);
    await choose(page, DIRECTION_MENU, 'Right-to-Left');
    expect(await page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
    await page.locator(CLOSE).click();
    await expect(page.locator('#test-opener')).toBeFocused();

    await page.evaluate(() => window.__viewer().open({
      key: 'geometry-images', mode: 'sequence', wrap: true, slideshow: true,
      items: [1, 2, 3].map((assetId) => ({ projectId: 1, assetId, title: 'Image toolbar geometry',
        mediaUrl: `/test-media/${assetId}.webp`, originalUrl: `/test-media/${assetId}-original.webp` })),
    }, { opener: document.getElementById('test-opener'), autoplay: false }));
    await expect(page.locator(SHOWN)).toBeVisible();
    await expectToolbarGeometry(page);
    await expect(page.locator(READER)).toBeHidden();
    const compact = await openSecondaryTools(page);
    await page.locator(`${DIALOG} [data-unified-viewer-zoom-in]`).click();
    await page.locator(`${DIALOG} [data-unified-viewer-zoom-out]`).click();
    await page.locator(`${DIALOG} [data-unified-viewer-original]`).click();
    await expect.poll(() => page.evaluate(() => window.__viewer().media.getState().status)).toBe('loaded');
    if (compact) {
      await page.getByRole('combobox', { name: 'Slideshow speed', exact: true }).selectOption('2000');
      await closeSecondaryTools(page);
    } else {
      await page.locator('#unified-viewer-speed-dropdown summary').click();
      await page.locator('#unified-viewer-speed-dropdown-options').getByText('2 s', { exact: true }).click();
    }
    expect(await page.evaluate(() => window.__viewer().playback.getState().speed)).toBe(2000);
    await page.locator(NEXT).click();
    await page.locator(PREVIOUS).click();
    await fullscreen.click();
    await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
    await expectToolbarGeometry(page);
    await page.locator(CLOSE).click();
    await expect(page.locator(DIALOG)).toBeHidden();
    await expect(page.locator('#test-opener')).toBeFocused();
  });
}

test('compact tools constrain their height and preserve every reader option', async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 180 });
  await openPage(page);
  await openComic(page, fixture.comics.seven, 'Comic toolbar geometry');
  await shownKey(page, pageKey(fixture.comics.seven, 1));
  await openSecondaryTools(page);
  const panel = page.locator('[data-unified-viewer-overflow-panel]');
  const geometry = await panel.evaluate((element) => {
    const r = element.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
  });
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.bottom).toBeLessThanOrEqual(180);
  expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
  const select = page.getByRole('combobox', { name: 'Page layout', exact: true });
  await expect(select.locator('option')).toHaveCount(3);
  for (const value of ['spread-cover-alone', 'spread-pair-from-first', 'single']) {
    await select.selectOption(value);
    expect(await readerState(page)).toMatchObject({ layout: value === 'single' ? 'single' : 'spread' });
  }
});

test('compact reader keyboard choices and Escape preserve focus and fullscreen', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const routes = await openPage(page);
  const id = fixture.comics.seven;
  const session = await openComic(page, id, 'Comic toolbar geometry');
  await shownKey(page, pageKey(id, 1));
  await page.locator(`${DIALOG} [data-unified-viewer-fullscreen]`).click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  const before = pagesSeen(routes, id).length;
  await openSecondaryTools(page);
  const direction = page.getByRole('combobox', { name: 'Reading direction', exact: true });
  await direction.focus();
  await direction.press('End');
  await expect.poll(() => readerState(page)).toMatchObject({ direction: 'rtl' });
  expect(pagesSeen(routes, id)).toHaveLength(before);
  const layout = page.getByRole('combobox', { name: 'Page layout', exact: true });
  await layout.focus();
  await layout.press('ArrowDown');
  await expect.poll(() => readerState(page)).toMatchObject({ direction: 'rtl', layout: 'spread', alignment: 'cover-alone' });
  expect(await state(page)).toMatchObject({ session, fullscreen: true, open: true });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'More viewer tools' })).toBeFocused();
  expect(await page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(page.locator('#test-opener')).toBeFocused();
});

// ─── D1-B: Comic Reader touch navigation (real CBZ, real Chromium touch) ─────
// CDP Input.dispatchTouchEvent drives Chromium's touch/pointer pipeline;
// technical qualification only, not real-device acceptance.

async function comicTouchscreen(page) {
  const cdp = await page.context().newCDPSession(page);
  const points = (list) => list.map(([id, x, y]) => ({ id, x: Math.round(x), y: Math.round(y) }));
  const send = (type, list = []) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points(list) });
  const surface = await page.locator(MEDIA).boundingBox();
  const cx = surface.x + surface.width / 2;
  const cy = surface.y + surface.height / 2;
  const settleInput = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 50))));
  const touch = {
    cx,
    cy,
    left: surface.x + 30,
    right: surface.x + surface.width - 30,
    start: (list) => send('touchStart', list),
    move: (list) => send('touchMove', list),
    lift: (list) => send('touchEnd', list),
    end: () => send('touchEnd'),
    async tap(x) {
      await send('touchStart', [[1, x, cy]]);
      await send('touchEnd');
      await settleInput();
    },
    async swipe(fromX, toX) {
      await send('touchStart', [[2, fromX, cy]]);
      for (let step = 1; step <= 4; step += 1) await send('touchMove', [[2, fromX + ((toX - fromX) * step) / 4, cy]]);
      await send('touchEnd');
      await settleInput();
    },
    detach: () => cdp.detach(),
  };
  return touch;
}

test('D1-B: touch swipes and edge taps follow reading direction, spreads and boundaries', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const routes = await openPage(page);
  const id = fixture.comics.seven;
  const session = await openComic(page, id, 'Seven pages');
  await shownKey(page, pageKey(id, 1));
  const touch = await comicTouchscreen(page);
  const group = async () => (await readerState(page)).groupItems;

  // Left-to-Right single pages: a leftward swipe or the right edge reads on.
  await touch.swipe(touch.cx + 150, touch.cx - 150);
  await expect(page.locator(POSITION)).toHaveText('Page 2 of 7');
  await touch.tap(touch.right);
  await expect(page.locator(POSITION)).toHaveText('Page 3 of 7');
  await touch.tap(touch.left);
  await expect(page.locator(POSITION)).toHaveText('Page 2 of 7');
  await touch.swipe(touch.cx - 150, touch.cx + 150);
  await expect(page.locator(POSITION)).toHaveText('Page 1 of 7');
  // The first page does not wrap; a centre tap does nothing.
  await touch.tap(touch.left);
  await touch.swipe(touch.cx - 150, touch.cx + 150);
  await touch.tap(touch.cx);
  await expect(page.locator(POSITION)).toHaveText('Page 1 of 7');

  // Right-to-Left: the left edge and a rightward swipe read on.
  expect(await setReader(page, { direction: 'rtl' })).toEqual({ changed: true });
  await touch.tap(touch.left);
  await expect(page.locator(POSITION)).toHaveText('Page 2 of 7');
  await touch.swipe(touch.cx - 150, touch.cx + 150);
  await expect(page.locator(POSITION)).toHaveText('Page 3 of 7');
  await touch.tap(touch.right);
  await expect(page.locator(POSITION)).toHaveText('Page 2 of 7');
  await touch.tap(touch.right);
  await touch.tap(touch.right);
  await expect(page.locator(POSITION)).toHaveText('Page 1 of 7');

  // Two-Page Spread, cover alone, still Right-to-Left: whole groups, visual order swapped.
  expect(await setReader(page, { layout: 'spread', alignment: 'cover-alone' })).toEqual({ changed: true });
  await touch.tap(touch.left);
  expect(await group()).toEqual([2, 3]);
  expect((await readerState(page)).visibleItems).toEqual([3, 2]);
  await touch.swipe(touch.cx - 150, touch.cx + 150);
  expect(await group()).toEqual([4, 5]);
  // Left-to-Right pairs from the first page, to the last group and no further.
  expect(await setReader(page, { direction: 'ltr', alignment: 'pair-from-first' })).toEqual({ changed: true });
  expect(await group()).toEqual([3, 4]);
  await touch.tap(touch.right);
  await touch.swipe(touch.cx + 150, touch.cx - 150);
  expect(await group()).toEqual([7]);
  await touch.tap(touch.right);
  expect(await group()).toEqual([7]);
  await touch.tap(touch.left);
  expect(await group()).toEqual([5, 6]);
  await expect(page.locator(POSITION)).toHaveText('Pages 5–6 of 7');

  // A pinch on the composed spread, finished by one finger at an edge, never turns a page.
  await expect.poll(async () => (await state(page)).media).toBe('loaded');
  await touch.start([[0, touch.cx - 60, touch.cy], [1, touch.cx + 60, touch.cy]]);
  await touch.move([[0, touch.cx - 140, touch.cy], [1, touch.cx + 140, touch.cy]]);
  await touch.lift([[1, touch.cx + 140, touch.cy]]);
  await touch.move([[0, touch.left, touch.cy]]);
  await touch.end();
  expect(await group()).toEqual([5, 6]);
  expect(await mediaView(page)).toMatchObject({ composite: true, mode: 'zoom', touchContacts: 0 });
  // Enlarged, an edge tap is not navigation either.
  await touch.tap(touch.right);
  expect(await group()).toEqual([5, 6]);

  expect(await state(page)).toMatchObject({ session, open: true, comic: { state: 'ready', pageCount: 7 } });
  expect(await page.evaluate(() => window.__viewer().getState().source.items.map((item) => item.position)))
    .toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(pageRequests(routes)).toBeGreaterThan(0);
  await touch.detach();
});

// ─── D1-C: Comic Reader by touch at phone sizes and in fullscreen ──────────
// Compiled bundle, real CBZ, CDP touch and emulated safe areas: technical
// qualification only, not real-device acceptance.

async function comicTapControl(page, selector, id) {
  const box = await page.locator(selector).boundingBox();
  const cdp = await page.context().newCDPSession(page);
  const point = [{ id, x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 50))));
}

// The control is shown, at least 24 px square, hit at its centre and inside `bounds`.
async function expectComicControlReachable(page, selector, bounds) {
  await expect(page.locator(selector)).toBeVisible();
  const hit = await page.locator(selector).evaluate((element) => {
    const r = element.getBoundingClientRect();
    const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height,
      hits: Boolean(at && (at === element || element.contains(at))) };
  });
  expect(hit.hits, selector).toBe(true);
  expect(Math.min(hit.width, hit.height), selector).toBeGreaterThanOrEqual(24);
  expect(hit.left, selector).toBeGreaterThanOrEqual(bounds.left - 0.5);
  expect(hit.top, selector).toBeGreaterThanOrEqual(bounds.top - 0.5);
  expect(hit.right, selector).toBeLessThanOrEqual(bounds.right + 0.5);
  expect(hit.bottom, selector).toBeLessThanOrEqual(bounds.bottom + 0.5);
}

test('D1-C: a Right-to-Left spread by touch at phone sizes and in fullscreen keeps choices, groups and controls', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPage(page);
  const id = fixture.comics.seven;
  const session = await openComic(page, id, 'Seven pages');
  await shownKey(page, pageKey(id, 1));
  expect(await setReader(page, { direction: 'rtl', layout: 'spread', alignment: 'cover-alone' })).toEqual({ changed: true });
  const choices = { direction: 'rtl', layout: 'spread', alignment: 'cover-alone' };
  const group = async () => (await readerState(page)).groupItems;
  const loaded = () => expect.poll(async () => (await state(page)).media).toBe('loaded');
  const card = page.locator(`${DIALOG} [data-unified-viewer-card]`);
  const hidden = () => card.evaluate((element) => element.hasAttribute('data-viewer-chrome-hidden'));
  const fullscreen = () => page.evaluate(() => Boolean(document.fullscreenElement?.matches('[data-unified-viewer-card]')));

  // Portrait phone: a quick rightward swipe reads on (Right-to-Left), and
  // Next tapped straight after it keeps its click.
  let touch = await comicTouchscreen(page);
  await touch.swipe(touch.cx - 140, touch.cx + 140);
  expect(await group()).toEqual([2, 3]);
  await comicTapControl(page, NEXT, 11);
  expect(await group()).toEqual([4, 5]);
  await touch.detach();
  await loaded();

  // Rotating to landscape keeps the group, the choices and the session.
  await page.setViewportSize({ width: 844, height: 390 });
  await loaded();
  expect(await readerState(page)).toMatchObject({ ...choices, groupItems: [4, 5], visibleItems: [5, 4] });
  expect(await mediaView(page)).toMatchObject({ composite: true, mode: 'fit' });
  const view = await mediaView(page);
  for (const key of ['scale', 'panX', 'panY']) expect(Number.isFinite(view[key]), key).toBe(true);

  // Fullscreen with landscape insets: choices survive, navigation clears them.
  const insets = { top: 20, right: 44, bottom: 21, left: 44 };
  const emulation = await page.context().newCDPSession(page);
  await emulation.send('Emulation.setSafeAreaInsetsOverride', { insets });
  try {
    await page.getByRole('button', { name: 'Enter fullscreen', exact: true }).click();
    await expect.poll(fullscreen).toBe(true);
    await loaded();
    expect(await readerState(page)).toMatchObject({ ...choices, groupItems: [4, 5] });
    const safe = { left: insets.left, top: insets.top, right: 844 - insets.right, bottom: 390 - insets.bottom };
    for (const selector of [NEXT, PREVIOUS, `${DIALOG} [data-dialog-close]`, `${DIALOG} [data-unified-viewer-fullscreen]`]) {
      await expectComicControlReachable(page, selector, safe);
    }
    touch = await comicTouchscreen(page);
    // A centre tap hides the chrome; a left-edge tap (inside the safe area) reads on and keeps it hidden.
    await touch.tap(touch.cx);
    expect(await hidden()).toBe(true);
    await touch.tap(safe.left + 12);
    expect(await group()).toEqual([6, 7]);
    expect(await hidden()).toBe(true);
    // At the last group an edge tap has nowhere to go: as a tap it reveals the chrome.
    await touch.tap(safe.left + 12);
    expect(await group()).toEqual([6, 7]);
    expect(await hidden()).toBe(false);
    await touch.tap(touch.cx);
    expect(await hidden()).toBe(true);
    // Enlarged with hidden chrome: a pinch keeps it hidden, a tap brings it
    // back, and Previous tapped by touch steps one group back to Fit.
    await loaded();
    await touch.start([[0, touch.cx - 60, touch.cy], [1, touch.cx + 60, touch.cy]]);
    await touch.move([[0, touch.cx - 160, touch.cy], [1, touch.cx + 160, touch.cy]]);
    await touch.end();
    expect(await mediaView(page)).toMatchObject({ composite: true, mode: 'zoom', touchContacts: 0 });
    expect(await hidden()).toBe(true);
    await touch.tap(touch.cx);
    expect(await hidden()).toBe(false);
    expect(await group()).toEqual([6, 7]);
    await comicTapControl(page, PREVIOUS, 12);
    expect(await group()).toEqual([4, 5]);
    await loaded();
    expect(await mediaView(page)).toMatchObject({ mode: 'fit' });
    await touch.detach();
    // Escape leaves fullscreen first; the choices and session are unchanged.
    await page.keyboard.press('Escape');
    await expect.poll(fullscreen).toBe(false);
    await expect(page.locator(DIALOG)).toBeVisible();
    expect(await readerState(page)).toMatchObject({ ...choices, groupItems: [4, 5] });
    expect(await state(page)).toMatchObject({ session, open: true });
    await page.keyboard.press('Escape');
    await expect(page.locator(DIALOG)).toBeHidden();
    await expect(page.locator('#test-opener')).toBeFocused();
  } finally {
    await emulation.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
    await emulation.detach();
  }
});

// ─── D1-F1: the Reader's first touch while its page is still loading ────────
// Held real page responses: the media surface keeps covering the stage, so
// the first edge tap or swipe reaches the one classifier; a swipe down
// across that same page's first decode still turns the page once.

test('D1-F1: while a page or spread is still loading the whole stage takes the first edge tap or swipe', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const routes = await openPage(page);
  const id = fixture.comics.seven;
  const stage = async () => page.locator(`${DIALOG} [data-unified-viewer-stage]`).boundingBox();
  const surface = async () => page.locator(MEDIA).boundingBox();
  const hitsMedia = (x, y) => page.evaluate(({ media, x, y }) => {
    const hit = document.elementFromPoint(x, y);
    return hit ? document.querySelector(media).contains(hit) : false;
  }, { media: MEDIA, x, y });
  const settleInput = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 50))));
  const cdp = await page.context().newCDPSession(page);
  const send = (type, list = []) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: list.map(([pointId, x, y]) => ({ id: pointId, x: Math.round(x), y: Math.round(y) })),
  });

  // Single page 1 held: loading, yet the surface spans the stage; the first
  // touch is a right-edge tap and reads on once.
  const releaseOne = routes.hold(pagePath(id, 1));
  const releaseTwo = routes.hold(pagePath(id, 2));
  await openComic(page, id, 'Seven pages');
  await expect.poll(async () => (await state(page)).comic?.state).toBe('ready');
  await expect(page.locator(`${DIALOG} [data-unified-viewer]`)).toHaveAttribute('data-viewer-media-state', 'loading');
  const box = await stage();
  expect(await surface()).toEqual(box);
  const g = { cx: box.x + box.width / 2, cy: box.y + box.height / 2, left: box.x + 30, right: box.x + box.width - 30 };
  for (const [x, y] of [[g.left, g.cy], [g.right, g.cy], [g.cx, g.cy], [g.right, box.y + 12]]) {
    expect(await hitsMedia(x, y), `${x},${y}`).toBe(true);
  }
  await send('touchStart', [[1, g.right, g.cy]]);
  await send('touchEnd');
  await settleInput();
  await expect(page.locator(POSITION)).toHaveText('Page 2 of 7');
  // Page 2 is held too: a swipe begun while it loads and finished after it
  // decoded reads on once more.
  await expect(page.locator(`${DIALOG} [data-unified-viewer]`)).toHaveAttribute('data-viewer-media-state', 'loading');
  await send('touchStart', [[2, g.cx + 150, g.cy]]);
  await send('touchMove', [[2, g.cx + 75, g.cy]]);
  releaseTwo();
  await shownKey(page, pageKey(id, 2));
  await expect.poll(async () => (await state(page)).media).toBe('loaded');
  expect(await surface()).toEqual(box);
  await send('touchMove', [[2, g.cx - 75, g.cy]]);
  await send('touchMove', [[2, g.cx - 150, g.cy]]);
  await send('touchEnd');
  await settleInput();
  await expect(page.locator(POSITION)).toHaveText('Page 3 of 7');
  releaseOne();

  // Two-Page Spread, Right-to-Left, with the next group's pages held: a
  // rightward swipe on the loading spread reads on by whole groups.
  expect(await setReader(page, { direction: 'rtl', layout: 'spread', alignment: 'cover-alone' })).toEqual({ changed: true });
  await expect.poll(async () => (await state(page)).media).toBe('loaded');
  const releaseFour = routes.hold(pagePath(id, 4));
  const releaseFive = routes.hold(pagePath(id, 5));
  await send('touchStart', [[3, g.left, g.cy]]);
  await send('touchEnd');
  await settleInput();
  expect((await readerState(page)).groupItems).toEqual([4, 5]);
  await expect(page.locator(`${DIALOG} [data-unified-viewer]`)).toHaveAttribute('data-viewer-media-state', 'loading');
  expect(await surface()).toEqual(box);
  expect(await hitsMedia(g.left, g.cy)).toBe(true);
  await send('touchStart', [[4, g.cx - 150, g.cy]]);
  for (let step = 1; step <= 4; step += 1) await send('touchMove', [[4, g.cx - 150 + 75 * step, g.cy]]);
  await send('touchEnd');
  await settleInput();
  expect((await readerState(page)).groupItems).toEqual([6, 7]);
  releaseFour();
  releaseFive();
  await expect.poll(async () => (await state(page)).media).toBe('loaded');
  expect(await surface()).toEqual(box);
  expect(await mediaView(page)).toMatchObject({ composite: true, mode: 'fit' });
  // The last group does not wrap.
  await send('touchStart', [[5, g.left, g.cy]]);
  await send('touchEnd');
  await settleInput();
  expect((await readerState(page)).groupItems).toEqual([6, 7]);
  await cdp.detach();
});
