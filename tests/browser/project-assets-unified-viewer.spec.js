import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createApp } from '../../src/app.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';

// B5a: Project Assets opens image thumbnails and its Slideshow action in the
// unified viewer, on the real page with isolated SQLite/filesystem data.
// Thumbnails open only their own image; Slideshow opens the complete
// server-filtered sequence (all pages, server order); live refreshes of the
// page reconcile an open viewer by identity. Everything lives in a temporary
// root removed afterwards.

const DIALOG = '#unified-viewer-dialog';
const FILES = ['01-a.png', '02-b.png', '03-c.png', '04-d.png', '05-e.png'];

let server;
let db;
let app;
let root;
let projectsRoot;
let baseURL;

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-project-assets-viewer-'));
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

async function writeImage(filePath, shade = 90, size = 48) {
  await sharp({ create: { width: size, height: size, channels: 3, background: { r: shade, g: 90, b: 160 } } })
    .png().toFile(filePath);
}

// An empty but valid ZIP: indexed as a CBZ comic.
const EMPTY_ZIP = Buffer.from([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]);

let projectCount = 0;
async function createProject({ comic = false } = {}) {
  projectCount += 1;
  const project = app.locals.projectService.create({ title: `Viewer ${projectCount}`, status: 'tbd' });
  const dir = path.join(projectsRoot, project.project_dir);
  fs.mkdirSync(dir, { recursive: true });
  for (const [index, filename] of FILES.entries()) await writeImage(path.join(dir, filename), index * 40);
  if (comic) fs.writeFileSync(path.join(dir, '06-comic.cbz'), EMPTY_ZIP);
  app.locals.assetScanner.scanProjectAssets(project.id);
  const id = (filename) => db.prepare('SELECT id FROM assets WHERE project_id = ? AND filename = ?').get(project.id, filename)?.id;
  return {
    id: project.id,
    title: project.title,
    url: `/projects/${project.id}/assets`,
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
      mode: state.source?.mode ?? null,
      slideshow: state.source?.slideshow ?? null,
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
  () => JSON.parse(document.querySelector('[data-project-assets-viewer-sequence]').textContent),
);
const thumb = (page, id) => page.locator(`a[data-project-assets-preview-id="${id}"]`);
const trigger = (page) => page.locator('[data-project-assets-slideshow-trigger]');
const title = (page) => page.locator(`${DIALOG} [data-unified-viewer-title]`);
const position = (page) => page.locator(`${DIALOG} [data-unified-viewer-position]`);
const shownImage = (page) => page.locator(`${DIALOG} [data-unified-viewer-media] img.unified-viewer-image:not([hidden])`);

// A real Project Assets live refresh, through the existing mutation caller.
async function refreshed(page) {
  await page.locator('[data-project-assets-live-region]').evaluate((node) => { node.dataset.beforeRefresh = 'true'; });
  await page.evaluate(() => document.dispatchEvent(new Event('project-asset-categories-changed')));
  await expect(page.locator('[data-project-assets-live-region]:not([data-before-refresh])')).toHaveCount(1);
  await expect(page.locator('[data-project-assets-live-region]')).not.toHaveAttribute('aria-busy', 'true');
  expect(await page.evaluate(() => window.__sameDocument)).toBe(true);
}

test('a thumbnail opens only its image; closing keeps URL, scroll and selection', async ({ page }) => {
  const f = await createProject();
  const url = `${f.url}?view=grid&pageSize=2&sort=filename&order=asc`;
  const control = await open(page, url, { viewport: { width: 1100, height: 520 } });
  const first = f.assetId('01-a.png');
  const second = f.assetId('02-b.png');

  await page.locator(`label[for$="-select-${first}"]`).click();
  await expect(page.locator(`input[name="selectedAssetIds"][value="${first}"]`)).toBeChecked();
  await thumb(page, second).scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, 40));
  const scrollY = await page.evaluate(() => window.scrollY);
  const href = page.url();

  await thumb(page, second).click();
  await expect(page.locator(DIALOG)).toBeVisible();
  await expect(title(page)).toHaveText('02-b.png');
  await expect(shownImage(page)).toBeVisible();
  await expect.poll(async () => (await viewerState(page)).media).toEqual({ status: 'loaded', width: 48 });
  expect((await viewerState(page)).mediaUrl.startsWith(`/projects/${f.id}/assets/${second}/preview?v=`)).toBe(true);
  await expect(page.locator(`${DIALOG} [data-unified-viewer-controls]`)).toBeHidden();
  await expect(page.locator(`${DIALOG} [data-unified-viewer-playback]`)).toBeHidden();
  await expect(page.locator(`${DIALOG} [data-unified-viewer-details]`)).toHaveAttribute('href', `/projects/${f.id}/assets/${second}`);
  expect(await viewerState(page)).toMatchObject({
    open: true, mode: 'single', slideshow: false, count: 1, titles: ['02-b.png'],
    playback: { available: false, playing: false },
  });
  // One viewer only: no legacy scaffold, one open dialog.
  await expect(page.locator('[data-slideshow-scaffold]')).toHaveCount(0);
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  await page.keyboard.press('ArrowRight');
  await expect(title(page)).toHaveText('02-b.png');

  // Basic button zoom and Fit work for the single image.
  await page.locator(`${DIALOG} [data-unified-viewer-zoom-in]`).click();
  await expect(page.locator(`${DIALOG} [data-unified-viewer-fit]`)).toBeEnabled();
  await page.locator(`${DIALOG} [data-unified-viewer-fit]`).click();

  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(thumb(page, second)).toBeFocused();
  expect(page.url()).toBe(href);
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);
  await expect(page.locator(`input[name="selectedAssetIds"][value="${first}"]`)).toBeChecked();
  await expect(page.locator(`input[name="selectedAssetIds"][value="${second}"]`)).not.toBeChecked();

  // A modified click is left to the browser (observed, then stopped here so
  // the test does not open a tab).
  await page.evaluate(() => {
    window.__modifiedClick = null;
    window.addEventListener('click', (event) => {
      window.__modifiedClick = { prevented: event.defaultPrevented };
      event.preventDefault();
    }, { once: true });
  });
  await thumb(page, second).click({ modifiers: ['Control'] });
  expect(await page.evaluate(() => window.__modifiedClick)).toEqual({ prevented: false });
  await expect(page.locator(DIALOG)).toBeHidden();

  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);

  // The explicit Details link still navigates.
  await page.locator('.asset-grid-item', { has: thumb(page, second) }).locator('a.asset-details-link').click();
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/projects/${f.id}/assets/${second}`);
});

test('Slideshow plays the complete server-filtered sequence across pages in server order', async ({ page }) => {
  const f = await createProject();
  const url = `${f.url}?view=list&pageSize=2&sort=filename&order=desc`;
  const control = await open(page, url);
  const fourth = f.assetId('04-d.png');
  // Only two images are rendered; the server sequence holds all five.
  await expect(page.locator('a[data-project-assets-preview-id]')).toHaveCount(2);
  const entries = await sequenceEntries(page);
  expect(entries.map((entry) => entry.filename)).toEqual(['05-e.png', '04-d.png', '03-c.png', '02-b.png', '01-a.png']);
  await page.locator(`label[for$="-select-${fourth}"]`).click();
  const href = page.url();

  await trigger(page).click();
  await expect(page.locator(DIALOG)).toBeVisible();
  await expect(title(page)).toHaveText('05-e.png');
  await expect(position(page)).toHaveText('1 of 5');
  expect(await viewerState(page)).toMatchObject({
    mode: 'sequence', slideshow: true, count: 5,
    titles: ['05-e.png', '04-d.png', '03-c.png', '02-b.png', '01-a.png'],
    playback: { available: true, playing: true, speed: 4000 },
  });

  // It advances by itself, then user navigation pauses it.
  await expect(title(page)).toHaveText('04-d.png', { timeout: 12_000 });
  await page.locator(`${DIALOG} [data-unified-viewer-next]`).click();
  await expect(title(page)).toHaveText('03-c.png');
  expect((await viewerState(page)).playback.playing).toBe(false);
  // Navigation wraps.
  for (let step = 0; step < 3; step += 1) await page.locator(`${DIALOG} [data-unified-viewer-previous]`).click();
  await expect(title(page)).toHaveText('01-a.png');
  await expect(position(page)).toHaveText('5 of 5');

  // Fullscreen from Project Assets: Escape leaves fullscreen first.
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
  await expect(page.locator(`input[name="selectedAssetIds"][value="${fourth}"]`)).toBeChecked();
  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('reduced motion opens the slideshow paused', async ({ page }) => {
  const f = await createProject();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page, `${f.url}?view=grid`);
  await trigger(page).click();
  await expect(title(page)).toHaveText('01-a.png');
  expect((await viewerState(page)).playback).toMatchObject({ available: true, playing: false });
});

test('an open viewer follows live refreshes by identity: order, revision, removal and replaced openers', async ({ page }) => {
  const f = await createProject();
  const control = await open(page, `${f.url}?view=grid&sort=filename&order=asc`);

  await trigger(page).click();
  await page.locator(`${DIALOG} [data-unified-viewer-next]`).click();
  await expect(title(page)).toHaveText('02-b.png');
  await expect(position(page)).toHaveText('2 of 5');
  const { session } = await viewerState(page);

  // A changed order keeps the shown asset in the new server order.
  f.renameRow('01-a.png', '09-a.png');
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
  await f.rewrite('02-b.png');
  await refreshed(page);
  await expect(title(page)).toHaveText('02-b.png');
  const after = (await viewerState(page)).mediaUrl;
  expect(after).not.toBe(before);
  await expect.poll(async () => (await viewerState(page)).media).toEqual({ status: 'loaded', width: 64 });
  expect(reloads.some((requested) => requested.endsWith(after))).toBe(true);
  await expect(page.locator(`${DIALOG} img.unified-viewer-image:not([hidden])`)).toHaveCount(1);

  // Removing the shown asset hands over to its successor.
  f.remove('02-b.png');
  await refreshed(page);
  await expect(title(page)).toHaveText('03-c.png');
  await expect(position(page)).toHaveText('1 of 4');

  // The Slideshow button was replaced by the refreshes: focus lands on the
  // current one.
  await page.locator(`${DIALOG} [data-dialog-close]`).click();
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(trigger(page)).toBeFocused();

  // A single-image session survives an unrelated refresh, returns focus to
  // its replacement thumbnail, and closes once its asset is gone.
  const third = f.assetId('03-c.png');
  await thumb(page, third).click();
  await refreshed(page);
  await expect(page.locator(DIALOG)).toBeVisible();
  await expect(title(page)).toHaveText('03-c.png');
  await page.keyboard.press('Escape');
  await expect(thumb(page, third)).toBeFocused();

  await thumb(page, third).click();
  f.remove('03-c.png');
  await refreshed(page);
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(trigger(page)).toBeFocused();

  // An empty filtered sequence closes the slideshow and disables the button.
  await trigger(page).click();
  for (const filename of ['04-d.png', '05-e.png', '09-a.png']) f.remove(filename);
  await refreshed(page);
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(trigger(page)).toBeDisabled();
  expect(await sequenceEntries(page)).toEqual([]);

  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('comics and missing files stay out of the image viewer; narrow viewports fit', async ({ page }) => {
  const f = await createProject({ comic: true });
  f.markMissing('05-e.png');
  const control = await open(page, `${f.url}?view=grid`, { viewport: { width: 375, height: 720 } });
  const comic = f.assetId('06-comic.cbz');
  const missing = f.assetId('05-e.png');
  expect(comic).toBeTruthy();
  const ids = (await sequenceEntries(page)).map((entry) => entry.id);
  expect(ids).not.toContain(comic);
  expect(ids).not.toContain(missing);
  expect(ids).toHaveLength(4);
  await expect(thumb(page, comic)).toHaveCount(0);

  await thumb(page, f.assetId('01-a.png')).click();
  await expect(page.locator(DIALOG)).toBeVisible();
  await expect(shownImage(page)).toBeVisible();
  const card = await page.locator(`${DIALOG} [data-unified-viewer-card]`).boundingBox();
  expect(card.x).toBeGreaterThanOrEqual(0);
  expect(card.x + card.width).toBeLessThanOrEqual(375);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();

  await trigger(page).click();
  expect((await viewerState(page)).count).toBe(4);
  await page.keyboard.press('Escape');
  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);
});
