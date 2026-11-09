import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createApp } from '../../src/app.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';

// B5b: the Global Asset Library (/asset-viewer) opens image thumbnails and its
// Slideshow action in the unified viewer, on the real page with isolated
// SQLite/filesystem data. Thumbnails open only their own project-qualified
// image; Slideshow opens the complete server-filtered cross-project sequence
// (all pages, server order); live refreshes, filtering and Back/Forward
// reconcile an open viewer by identity. Each test archives the projects of
// earlier tests so the library shows only its own; everything lives in a
// temporary root removed afterwards.

const DIALOG = '#unified-viewer-dialog';
const VIDEO_DIALOG = '#asset-video-preview-dialog';
const FILES = ['01-a.png', '02-b.png', '03-c.png', '04-d.png', '05-e.png'];
const LIBRARY = '/asset-viewer';

let server;
let db;
let app;
let root;
let projectsRoot;
let baseURL;

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-asset-library-viewer-'));
  projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot);
  fs.mkdirSync(appDataRoot);
  db = openDatabase(path.join(root, 'test.db'));
  runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
  const { csrfPepper } = ensureAuthEnablement(appDataRoot);
  app = createApp(
    { appName: 'CreatorCrate', db, projectsRoot, previewRoot: path.join(root, 'previews') },
    { appDataRoot, authState: { csrfPepper } },
  );
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (db) closeDatabase(db);
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

// Earlier tests' projects leave the active library.
function isolateLibrary() {
  db.prepare("UPDATE projects SET archived_at = CURRENT_TIMESTAMP, status = 'archived' WHERE archived_at IS NULL").run();
}

async function writeImage(filePath, shade = 90, size = 48) {
  await sharp({ create: { width: size, height: size, channels: 3, background: { r: shade, g: 90, b: 160 } } })
    .png().toFile(filePath);
}

// An empty but valid ZIP: indexed as a CBZ comic.
const EMPTY_ZIP = Buffer.from([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]);

let projectCount = 0;
// Every project holds the same filenames, so cross-project duplicates are the
// norm in these tests.
async function createProject({ comic = false, video = false, shadeOffset = 0 } = {}) {
  projectCount += 1;
  const project = app.locals.projectService.create({ title: `Library ${projectCount}`, status: 'tbd' });
  const dir = path.join(projectsRoot, project.project_dir);
  fs.mkdirSync(dir, { recursive: true });
  for (const [index, filename] of FILES.entries()) await writeImage(path.join(dir, filename), index * 40 + shadeOffset);
  if (comic) fs.writeFileSync(path.join(dir, '06-comic.cbz'), EMPTY_ZIP);
  if (video) fs.writeFileSync(path.join(dir, '07-clip.webm'), Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]));
  app.locals.assetScanner.scanProjectAssets(project.id);
  const id = (filename) => db.prepare('SELECT id FROM assets WHERE project_id = ? AND filename = ?').get(project.id, filename)?.id;
  return {
    id: project.id,
    title: project.title,
    assetId: id,
    remove(filename) {
      const assetId = id(filename);
      fs.rmSync(path.join(dir, filename), { force: true });
      db.prepare('DELETE FROM assets WHERE id = ?').run(assetId);
    },
    async rewrite(filename) {
      await writeImage(path.join(dir, filename), 250, 64);
      app.locals.assetScanner.scanProjectAssets(project.id);
    },
    markMissing(filename) {
      fs.rmSync(path.join(dir, filename), { force: true });
      app.locals.assetScanner.scanProjectAssets(project.id);
    },
    // Renames file and row together, keeping the asset identity.
    renameRow(from, to) {
      fs.renameSync(path.join(dir, from), path.join(dir, to));
      db.prepare('UPDATE assets SET filename = ?, relative_path = ? WHERE id = ?').run(to, to, id(from));
    },
  };
}

async function open(page, url, { viewport = { width: 1280, height: 900 } } = {}) {
  const control = { mutations: [], errors: [] };
  page.on('pageerror', (error) => control.errors.push(error.message));
  page.on('request', (request) => {
    if (request.method() !== 'GET') control.mutations.push(`${request.method()} ${request.url()}`);
  });
  await page.setViewportSize(viewport);
  await page.goto(`${baseURL}${url}`);
  await page.waitForFunction(async () => {
    const viewer = await import('/client/unified-viewer.js');
    return Boolean(viewer.unifiedViewerFor(document));
  });
  await page.evaluate(() => { window.__sameDocument = true; });
  return control;
}

async function viewerState(page) {
  return page.evaluate(async () => {
    const { unifiedViewerFor } = await import('/client/unified-viewer.js');
    const viewer = unifiedViewerFor(document);
    const state = viewer.getState();
    return {
      open: state.open,
      session: state.session,
      key: state.key,
      sourceKey: state.source?.key ?? null,
      mode: state.source?.mode ?? null,
      slideshow: state.source?.slideshow ?? null,
      keys: state.source ? state.source.items.map((item) => item.key) : [],
      titles: state.source ? state.source.items.map((item) => item.title) : [],
      count: state.count,
      mediaUrl: state.item?.mediaUrl ?? null,
      detailsUrl: state.item?.detailsUrl ?? null,
      media: { status: viewer.media.getState().status, width: viewer.media.getState().width },
      playback: state.playback,
      fullscreenElement: document.fullscreenElement
        ? (document.fullscreenElement.matches('[data-unified-viewer-card]') ? 'card' : 'other')
        : null,
    };
  });
}

const sequenceEntries = (page) => page.evaluate(
  () => JSON.parse(document.querySelector('[data-asset-library-viewer-sequence]').textContent),
);
const keyOf = (project, assetId) => `p:${project.id}|a:${assetId}`;
const thumb = (page, project, assetId) => page.locator(
  `a[data-asset-library-preview-id="${assetId}"][data-asset-library-preview-project-id="${project.id}"]`,
);
const trigger = (page) => page.locator('[data-asset-library-slideshow-trigger]');
const title = (page) => page.locator(`${DIALOG} [data-unified-viewer-title]`);
const position = (page) => page.locator(`${DIALOG} [data-unified-viewer-position]`);
const shownImage = (page) => page.locator(`${DIALOG} [data-unified-viewer-media] img.unified-viewer-image:not([hidden])`);
const region = (page) => page.locator('[data-asset-library-live-region]');

// A real Asset Library live refresh of the current URL, through the existing
// authority-checked refresh path (history is replaced with the same URL).
async function refreshed(page, destination = null) {
  await region(page).evaluate((node) => { node.dataset.beforeRefresh = 'true'; });
  const outcome = await page.evaluate(async (target) => {
    const live = await import('/client/live-regions.js');
    const generation = live.beginAssetViewerDefaultsLiveRefresh(document);
    return live.refreshAssetViewerLiveRegion(document, target || window.location.href, generation);
  }, destination);
  expect(outcome).not.toBe('unavailable');
  await expect(page.locator('[data-asset-library-live-region]:not([data-before-refresh])')).toHaveCount(1);
  await expect(region(page)).not.toHaveAttribute('aria-busy', 'true');
  expect(await page.evaluate(() => window.__sameDocument)).toBe(true);
}

// Lazy thumbnails finish loading first, so later layout never moves the page.
async function settlePreviews(page) {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(page.locator('[data-preview-enhancement][data-preview-state="loading"]')).toHaveCount(0);
  await page.evaluate(() => window.scrollTo(0, 0));
}

async function waitForRegionSwap(page, action) {
  await region(page).evaluate((node) => { node.dataset.beforeSwap = 'true'; });
  await action();
  await expect(page.locator('[data-asset-library-live-region]:not([data-before-swap])')).toHaveCount(1);
  await expect(region(page)).not.toHaveAttribute('aria-busy', 'true');
}

test('Grid: a thumbnail opens only its project-qualified image; closing keeps URL, scroll and state', async ({ page }) => {
  isolateLibrary();
  const one = await createProject();
  const two = await createProject({ shadeOffset: 5 });
  const url = `${LIBRARY}?view=grid&sort=filename&order=asc`;
  const control = await open(page, url, { viewport: { width: 1100, height: 520 } });
  const twoSecond = two.assetId('02-b.png');
  const oneSecond = one.assetId('02-b.png');

  // Both projects render a 02-b.png, each with its own hook.
  await expect(page.locator('a[data-asset-library-preview-id]')).toHaveCount(10);
  await expect(page.locator('a[data-project-assets-preview-id]')).toHaveCount(0);
  await settlePreviews(page);
  const href = page.url();

  // (Playwright may scroll first so the click reaches the link rather than
  // the card's hover information panel; the page position is then recorded
  // with the viewer open and must survive closing it.)
  await thumb(page, two, twoSecond).click();
  await expect(page.locator(DIALOG)).toBeVisible();
  const scrollY = await page.evaluate(() => window.scrollY);
  expect(scrollY).toBeGreaterThan(0);
  await expect(title(page)).toHaveText('02-b.png');
  await expect(shownImage(page)).toBeVisible();
  await expect.poll(async () => (await viewerState(page)).media).toEqual({ status: 'loaded', width: 48 });
  const state = await viewerState(page);
  expect(state).toMatchObject({
    open: true, mode: 'single', slideshow: false, count: 1, sourceKey: 'asset-library',
    key: keyOf(two, twoSecond), keys: [keyOf(two, twoSecond)],
    playback: { available: false, playing: false },
  });
  expect(state.mediaUrl.startsWith(`/projects/${two.id}/assets/${twoSecond}/preview?v=`)).toBe(true);
  await expect(page.locator(`${DIALOG} [data-unified-viewer-controls]`)).toBeHidden();
  await expect(page.locator(`${DIALOG} [data-unified-viewer-playback]`)).toBeHidden();
  await expect(page.locator(`${DIALOG} [data-unified-viewer-details]`)).toHaveAttribute('href', `/projects/${two.id}/assets/${twoSecond}`);
  // One viewer only: no legacy scaffold, one open dialog.
  await expect(page.locator('[data-slideshow-scaffold]')).toHaveCount(0);
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  await page.keyboard.press('ArrowRight');
  await expect(title(page)).toHaveText('02-b.png');

  // Button zoom and Fit work for the single image.
  await page.locator(`${DIALOG} [data-unified-viewer-zoom-in]`).click();
  await expect(page.locator(`${DIALOG} [data-unified-viewer-fit]`)).toBeEnabled();
  await page.locator(`${DIALOG} [data-unified-viewer-fit]`).click();

  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(thumb(page, two, twoSecond)).toBeFocused();
  expect(page.url()).toBe(href);
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);

  // The other project's equal filename is a different asset.
  await thumb(page, one, oneSecond).click();
  await expect(title(page)).toHaveText('02-b.png');
  expect((await viewerState(page)).key).toBe(keyOf(one, oneSecond));
  expect((await viewerState(page)).detailsUrl).toBe(`/projects/${one.id}/assets/${oneSecond}`);
  await page.keyboard.press('Escape');
  await expect(thumb(page, one, oneSecond)).toBeFocused();

  // A modified click is left to the browser (observed, then stopped here so
  // the test does not open a tab).
  await page.evaluate(() => {
    window.__modifiedClick = null;
    window.addEventListener('click', (event) => {
      window.__modifiedClick = { prevented: event.defaultPrevented };
      event.preventDefault();
    }, { once: true });
  });
  await thumb(page, two, twoSecond).click({ modifiers: ['Control'] });
  expect(await page.evaluate(() => window.__modifiedClick)).toEqual({ prevented: false });
  await expect(page.locator(DIALOG)).toBeHidden();
  expect(page.url()).toBe(href);

  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);

  // The explicit Details link still navigates.
  await page.locator('.asset-grid-item', { has: thumb(page, two, twoSecond) }).locator('a.asset-details-link').click();
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/projects/${two.id}/assets/${twoSecond}`);
});

test('List: Slideshow plays the complete cross-project sequence across pages in server order', async ({ page }) => {
  isolateLibrary();
  const one = await createProject();
  const two = await createProject({ shadeOffset: 5 });
  const three = await createProject({ shadeOffset: 10 });
  const url = `${LIBRARY}?view=list&pageSize=10&sort=filename&order=desc`;
  const control = await open(page, url);
  // Only ten images are rendered; the server sequence holds all fifteen.
  await expect(page.locator('a[data-asset-library-preview-id]')).toHaveCount(10);
  const entries = await sequenceEntries(page);
  expect(entries).toHaveLength(15);
  expect(new Set(entries.map((entry) => entry.projectId))).toEqual(new Set([one.id, two.id, three.id]));
  expect(entries.map((entry) => entry.filename)).toEqual(
    ['05-e.png', '04-d.png', '03-c.png', '02-b.png', '01-a.png'].flatMap((filename) => [filename, filename, filename]),
  );
  const serverKeys = entries.map((entry) => `p:${entry.projectId}|a:${entry.id}`);
  expect(new Set(serverKeys).size).toBe(15);
  // The off-page images (the last five in server order) are not rendered.
  for (const entry of entries.slice(10)) {
    await expect(page.locator(`a[data-asset-library-preview-id="${entry.id}"]`)).toHaveCount(0);
  }
  await expect(page.locator('nav.pagination')).toContainText('Page 1 of 2');
  // The list row's own navigation stays plain.
  const firstRow = page.locator('.asset-list-item').first();
  await expect(firstRow.locator('a.asset-project-link')).toHaveAttribute('href', /^\/projects\/\d+$/);
  const href = page.url();

  await trigger(page).click();
  await expect(page.locator(DIALOG)).toBeVisible();
  await expect(title(page)).toHaveText('05-e.png');
  await expect(position(page)).toHaveText('1 of 15');
  expect(await viewerState(page)).toMatchObject({
    mode: 'sequence', slideshow: true, count: 15, keys: serverKeys,
    playback: { available: true, playing: true, speed: 4000 },
  });
  await expect(page.locator(`${DIALOG} [data-unified-viewer-controls]`)).toBeVisible();

  // It advances by itself, then user navigation pauses it.
  await expect(position(page)).toHaveText('2 of 15', { timeout: 12_000 });
  await page.locator(`${DIALOG} [data-unified-viewer-next]`).click();
  await expect(position(page)).toHaveText('3 of 15');
  expect((await viewerState(page)).playback.playing).toBe(false);
  // Navigation wraps.
  for (let step = 0; step < 3; step += 1) await page.locator(`${DIALOG} [data-unified-viewer-previous]`).click();
  await expect(position(page)).toHaveText('15 of 15');
  await expect(title(page)).toHaveText('01-a.png');
  expect((await viewerState(page)).key).toBe(serverKeys[14]);

  // Fullscreen from the Asset Library: Escape leaves fullscreen first.
  await page.locator(DIALOG).getByRole('button', { name: 'Enter fullscreen' }).click();
  await expect.poll(async () => (await viewerState(page)).fullscreenElement).toBe('card');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await viewerState(page)).fullscreenElement).toBe(null);
  await expect(page.locator(DIALOG)).toBeVisible();
  await page.locator(DIALOG).getByRole('button', { name: 'Enter fullscreen' }).click();
  await expect.poll(async () => (await viewerState(page)).fullscreenElement).toBe('card');
  await page.locator(`${DIALOG} [data-dialog-close]`).click();
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect.poll(async () => (await viewerState(page)).fullscreenElement).toBe(null);
  await expect(trigger(page)).toBeFocused();

  expect(page.url()).toBe(href);
  await expect(page.locator('nav.pagination')).toContainText('Page 1 of 2');
  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('reduced motion opens the library slideshow paused', async ({ page }) => {
  isolateLibrary();
  await createProject();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page, `${LIBRARY}?view=grid&sort=filename&order=asc`);
  await trigger(page).click();
  await expect(title(page)).toHaveText('01-a.png');
  expect((await viewerState(page)).playback).toMatchObject({ available: true, playing: false });
});

test('an open viewer follows live refreshes by identity: order, revision, removal and replaced openers', async ({ page }) => {
  isolateLibrary();
  const one = await createProject();
  const two = await createProject({ shadeOffset: 5 });
  const control = await open(page, `${LIBRARY}?view=grid&project=${two.id}&sort=filename&order=asc`);
  const href = page.url();

  await trigger(page).click();
  await page.locator(`${DIALOG} [data-unified-viewer-next]`).click();
  await expect(title(page)).toHaveText('02-b.png');
  await expect(position(page)).toHaveText('2 of 5');
  const { session } = await viewerState(page);
  expect((await viewerState(page)).key).toBe(keyOf(two, two.assetId('02-b.png')));

  // A changed order keeps the shown asset in the new server order.
  two.renameRow('01-a.png', '09-a.png');
  await refreshed(page);
  await expect(title(page)).toHaveText('02-b.png');
  await expect(position(page)).toHaveText('1 of 5');
  expect((await viewerState(page)).titles).toEqual(['02-b.png', '03-c.png', '04-d.png', '05-e.png', '09-a.png']);
  expect((await viewerState(page)).session).toBe(session);

  // A changed revision reloads the kept asset's media.
  await expect.poll(async () => (await viewerState(page)).media).toEqual({ status: 'loaded', width: 48 });
  const before = (await viewerState(page)).mediaUrl;
  const reloads = [];
  page.on('request', (request) => { if (request.url().includes('/preview?v=')) reloads.push(request.url()); });
  await two.rewrite('02-b.png');
  await refreshed(page);
  await expect(title(page)).toHaveText('02-b.png');
  const after = (await viewerState(page)).mediaUrl;
  expect(after).not.toBe(before);
  await expect.poll(async () => (await viewerState(page)).media).toEqual({ status: 'loaded', width: 64 });
  expect(reloads.some((requested) => requested.endsWith(after))).toBe(true);
  await expect(page.locator(`${DIALOG} img.unified-viewer-image:not([hidden])`)).toHaveCount(1);

  // Removing the shown asset hands over to its successor.
  two.remove('02-b.png');
  await refreshed(page);
  await expect(title(page)).toHaveText('03-c.png');
  await expect(position(page)).toHaveText('1 of 4');
  expect((await viewerState(page)).key).toBe(keyOf(two, two.assetId('03-c.png')));

  // The Slideshow button was replaced by the refreshes: focus lands on the
  // current one.
  await page.locator(`${DIALOG} [data-dialog-close]`).click();
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(trigger(page)).toBeFocused();

  // A single-image session survives an unrelated refresh, returns focus to
  // its replacement thumbnail, and closes once its asset is gone.
  const third = two.assetId('03-c.png');
  await thumb(page, two, third).click();
  one.remove('03-c.png'); // the same filename in another project
  await refreshed(page);
  await expect(page.locator(DIALOG)).toBeVisible();
  await expect(title(page)).toHaveText('03-c.png');
  await page.keyboard.press('Escape');
  await expect(thumb(page, two, third)).toBeFocused();

  await thumb(page, two, third).click();
  two.remove('03-c.png');
  await refreshed(page);
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(trigger(page)).toBeFocused();

  // An empty filtered sequence closes the slideshow and disables the button.
  await trigger(page).click();
  for (const filename of ['04-d.png', '05-e.png', '09-a.png']) two.remove(filename);
  await refreshed(page);
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(trigger(page)).toBeDisabled();
  expect(await sequenceEntries(page)).toEqual([]);

  expect(page.url()).toBe(href);
  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('filtering, Back/Forward and a delayed stale response reconcile to the latest authoritative sequence', async ({ page }) => {
  isolateLibrary();
  const one = await createProject();
  const two = await createProject({ shadeOffset: 5 });
  const allUrl = `${LIBRARY}?view=grid&sort=filename&order=asc`;
  const control = await open(page, allUrl);
  const canonicalAllUrl = page.url();
  const historyLength = await page.evaluate(() => window.history.length);
  expect(await sequenceEntries(page)).toHaveLength(10);

  // Filter to project two through the real Filter dialog (live, pushed).
  await page.getByRole('link', { name: 'Filter assets' }).click();
  const filterDialog = page.locator('#asset-viewer-filter-dialog');
  await expect(filterDialog).toBeVisible();
  await waitForRegionSwap(page, async () => {
    await filterDialog.locator('#asset-project-filter > summary').click();
    await filterDialog.locator(`input[name="project"][value="${two.id}"]`).check();
  });
  await expect.poll(() => new URL(page.url()).searchParams.get('project')).toBe(String(two.id));
  await filterDialog.locator('[data-dialog-close]').click();
  await expect(filterDialog).toBeHidden();
  const filteredUrl = page.url();
  expect((await sequenceEntries(page)).map((entry) => entry.projectId)).toEqual([two.id, two.id, two.id, two.id, two.id]);

  await trigger(page).click();
  await page.locator(`${DIALOG} [data-unified-viewer-next]`).click();
  await page.locator(`${DIALOG} [data-unified-viewer-next]`).click();
  await expect(position(page)).toHaveText('3 of 5');
  const shown = keyOf(two, two.assetId('03-c.png'));
  expect((await viewerState(page)).key).toBe(shown);
  const { session } = await viewerState(page);

  // Back restores the unfiltered results; the open slideshow keeps its asset
  // within the wider server sequence.
  await waitForRegionSwap(page, () => page.goBack());
  expect(page.url()).toBe(canonicalAllUrl);
  await expect(page.locator(DIALOG)).toBeVisible();
  expect(await sequenceEntries(page)).toHaveLength(10);
  await expect.poll(async () => (await viewerState(page)).count).toBe(10);
  expect(await viewerState(page)).toMatchObject({ key: shown, session });

  // Forward again: back to project two only.
  await waitForRegionSwap(page, () => page.goForward());
  expect(page.url()).toBe(filteredUrl);
  await expect.poll(async () => (await viewerState(page)).count).toBe(5);
  expect(await viewerState(page)).toMatchObject({ key: shown, session });

  // A slow response for the unfiltered results is superseded by a newer
  // navigation: its stale sequence never reaches the viewer.
  let releaseStale;
  const staleHeld = new Promise((resolve) => { releaseStale = resolve; });
  let staleRequests = 0;
  await page.route(
    (url) => url.pathname === LIBRARY && !url.searchParams.has('project'),
    async (route) => {
      staleRequests += 1;
      await staleHeld;
      await route.continue().catch(() => {});
    },
  );
  await page.goBack();
  await expect.poll(() => staleRequests).toBe(1);
  await waitForRegionSwap(page, () => page.goForward());
  releaseStale();
  await page.waitForTimeout(500);
  await page.unroute((url) => url.pathname === LIBRARY && !url.searchParams.has('project'));
  expect(page.url()).toBe(filteredUrl);
  expect((await sequenceEntries(page)).map((entry) => entry.projectId)).toEqual([two.id, two.id, two.id, two.id, two.id]);
  expect(await viewerState(page)).toMatchObject({ open: true, key: shown, session, count: 5 });

  // Closing restores focus to the current Slideshow button; no history entry
  // was added by opening or closing the viewer.
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(trigger(page)).toBeFocused();
  expect(page.url()).toBe(filteredUrl);

  // A single image of project one closes once a navigation filters it out.
  await waitForRegionSwap(page, () => page.goBack());
  const oneFirst = one.assetId('01-a.png');
  await thumb(page, one, oneFirst).click();
  await expect(title(page)).toHaveText('01-a.png');
  await waitForRegionSwap(page, () => page.goForward());
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(trigger(page)).toBeFocused();
  expect(await page.evaluate(() => window.history.length)).toBe(historyLength + 1);

  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('videos, comics and missing files stay out of the image viewer; narrow viewports fit', async ({ page }) => {
  isolateLibrary();
  const one = await createProject({ comic: true, video: true });
  one.markMissing('05-e.png');
  const control = await open(page, `${LIBRARY}?view=grid&sort=filename&order=asc`, { viewport: { width: 375, height: 720 } });
  const comic = one.assetId('06-comic.cbz');
  const video = one.assetId('07-clip.webm');
  const missing = one.assetId('05-e.png');
  expect(comic).toBeTruthy();
  expect(video).toBeTruthy();
  const ids = (await sequenceEntries(page)).map((entry) => entry.id);
  expect(ids).not.toContain(comic);
  expect(ids).not.toContain(video);
  expect(ids).not.toContain(missing);
  expect(ids).toHaveLength(4);
  await expect(thumb(page, one, comic)).toHaveCount(0);
  await expect(thumb(page, one, video)).toHaveCount(0);
  await expect(thumb(page, one, missing)).toHaveCount(0);
  // Comic cards keep their Details navigation.
  await expect(page.locator(`article[data-asset-id="${comic}"] a.asset-details-link`)).toHaveAttribute('href', `/projects/${one.id}/assets/${comic}`);

  // The video link opens the separate video dialog, never the image viewer.
  const videoLink = page.locator(`article[data-asset-id="${video}"] a[data-asset-video-preview-trigger]`);
  await videoLink.scrollIntoViewIfNeeded();
  await videoLink.click();
  await expect(page.locator(VIDEO_DIALOG)).toBeVisible();
  await expect(page.locator(DIALOG)).toBeHidden();
  expect((await viewerState(page)).open).toBe(false);
  await page.keyboard.press('Escape');
  await expect(page.locator(VIDEO_DIALOG)).toBeHidden();

  await thumb(page, one, one.assetId('01-a.png')).click();
  await expect(page.locator(DIALOG)).toBeVisible();
  await expect(shownImage(page)).toBeVisible();
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  const card = await page.locator(`${DIALOG} [data-unified-viewer-card]`).boundingBox();
  expect(card.x).toBeGreaterThanOrEqual(0);
  expect(card.x + card.width).toBeLessThanOrEqual(375);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();

  await trigger(page).click();
  expect((await viewerState(page)).count).toBe(4);
  await page.keyboard.press('Escape');
  // No comic archive or video was ever requested as an image.
  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('a delayed image keeps the slideshow from advancing and a failed image pauses it', async ({ page }) => {
  isolateLibrary();
  const one = await createProject();
  const second = one.assetId('02-b.png');
  const third = one.assetId('03-c.png');
  await open(page, `${LIBRARY}?view=grid&sort=filename&order=asc`);
  let releaseSecond;
  const secondHeld = new Promise((resolve) => { releaseSecond = resolve; });
  await page.route(`**/projects/${one.id}/assets/${second}/preview?*`, async (route) => {
    await secondHeld;
    await route.continue().catch(() => {});
  });
  await page.route(`**/projects/${one.id}/assets/${third}/preview?*`, (route) => route.fulfill({ status: 500, body: 'no' }));

  await trigger(page).click();
  await expect(title(page)).toHaveText('01-a.png');
  // Advances to the delayed image, then waits there while it loads.
  await expect(title(page)).toHaveText('02-b.png', { timeout: 12_000 });
  await page.waitForTimeout(5_000);
  await expect(title(page)).toHaveText('02-b.png');
  expect((await viewerState(page)).playback.playing).toBe(true);
  releaseSecond();
  await expect.poll(async () => (await viewerState(page)).media.status).toBe('loaded');
  // Advances to the failing image and pauses there; resuming needs the user.
  await expect(title(page)).toHaveText('03-c.png', { timeout: 12_000 });
  await expect.poll(async () => (await viewerState(page)).playback.playing).toBe(false);
  await page.waitForTimeout(4_500);
  await expect(title(page)).toHaveText('03-c.png');
  await page.keyboard.press('Escape');
});
