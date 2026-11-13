import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import slugify from '@sindresorhus/slugify';
import sharp from 'sharp';
import { build } from 'vite';
import yazl from 'yazl';
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

// B6: Asset Details opens its own image (only) in the unified viewer, on the
// real page with isolated SQLite/filesystem data. The viewer is a single-image
// source (no gallery, no viewer Previous/Next, no autoplay); the page's own
// Previous/Next stay page navigation; Asset Details refreshes reconcile an open
// viewer by identity. Everything lives in a temporary root removed afterwards.

const DIALOG = '#unified-viewer-dialog';
const LINK = '[data-asset-viewer-host] a.asset-preview-link';
const BUTTON = '[data-asset-viewer-host] button.asset-preview-view-button';
const GONE = '[data-asset-viewer-host] [data-asset-details-viewer-gone]';
const PREVIEW_IMAGE = '[data-asset-viewer-host] img[data-preview-image]';
const PAGE_LIVE = '[aria-live]:not(#unified-viewer-dialog *)';
const EMPTY_ZIP = Buffer.from([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]);

let server;
let db;
let app;
let root;
let projectsRoot;
let baseURL;

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-asset-details-viewer-'));
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

function png(size = 48, shade = 90) {
  return sharp({ create: { width: size, height: size, channels: 3, background: { r: shade, g: 90, b: 160 } } }).png().toBuffer();
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

let projectCount = 0;
async function createProject() {
  projectCount += 1;
  const project = app.locals.projectService.create({ title: `Details Viewer ${projectCount}`, status: 'tbd' });
  const dir = path.join(projectsRoot, project.project_dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '01-a.png'), await png(48, 20));
  fs.writeFileSync(path.join(dir, '02-b.png'), await png(64, 120));
  fs.writeFileSync(path.join(dir, '03-c.png'), await png(48, 200));
  fs.writeFileSync(path.join(dir, '04-paint.kra'), await kritaArchive(await png(40, 60)));
  fs.writeFileSync(path.join(dir, '05-clip.webm'), Buffer.from('not really a video'));
  fs.writeFileSync(path.join(dir, '06-book.cbz'), EMPTY_ZIP);
  app.locals.assetScanner.scanProjectAssets(project.id);
  const id = (filename) => db.prepare('SELECT id FROM assets WHERE project_id = ? AND filename = ?').get(project.id, filename)?.id;
  const rowOf = (assetId) => db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId);
  return {
    id: project.id,
    dir,
    assetId: id,
    row: rowOf,
    url: (filename, query = '') => `/projects/${project.id}/assets/${id(filename)}${query}`,
    async rewrite(filename, size = 80) {
      fs.writeFileSync(path.join(dir, filename), await png(size, 250));
      app.locals.assetScanner.scanProjectAssets(project.id);
    },
    // Renames file and row together, keeping the asset identity.
    renameRow(assetId, to) {
      const row = rowOf(assetId);
      fs.renameSync(path.join(dir, row.relative_path), path.join(dir, to));
      db.prepare('UPDATE assets SET filename = ?, relative_path = ? WHERE id = ?').run(to, to, assetId);
    },
    async becomeKrita(assetId, to) {
      const row = rowOf(assetId);
      fs.rmSync(path.join(dir, row.relative_path));
      fs.writeFileSync(path.join(dir, to), await kritaArchive(await png(40, 90)));
      db.prepare("UPDATE assets SET filename = ?, relative_path = ?, extension = 'kra', mime_type = 'application/x-krita' WHERE id = ?")
        .run(to, to, assetId);
    },
    becomeVideo(assetId, to) {
      const row = rowOf(assetId);
      fs.renameSync(path.join(dir, row.relative_path), path.join(dir, to));
      db.prepare("UPDATE assets SET filename = ?, relative_path = ?, extension = 'webm', mime_type = 'video/webm' WHERE id = ?")
        .run(to, to, assetId);
    },
    remove(assetId) {
      const row = rowOf(assetId);
      fs.rmSync(path.join(dir, row.relative_path), { force: true });
      db.prepare('DELETE FROM assets WHERE id = ?').run(assetId);
    },
  };
}

async function open(page, url, { viewport = { width: 1280, height: 900 } } = {}) {
  const control = { mutations: [], errors: [], requests: [] };
  page.on('pageerror', (error) => control.errors.push(error.message));
  page.on('request', (request) => {
    control.requests.push(`${request.method()} ${new URL(request.url()).pathname}`);
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
    const media = viewer.media.getState();
    return {
      open: state.open,
      context: state.context,
      session: state.session,
      key: state.key,
      mode: state.source?.mode ?? null,
      slideshow: state.source?.slideshow ?? null,
      wrap: state.source?.wrap ?? null,
      count: state.count,
      title: state.item?.title ?? null,
      mediaUrl: state.item?.mediaUrl ?? null,
      originalUrl: state.item?.originalUrl ?? null,
      detailsUrl: state.item?.detailsUrl ?? null,
      revision: state.item?.revision ?? null,
      media: { status: media.status, width: media.width },
      original: media.original.status,
      playback: state.playback,
      fullscreenElement: document.fullscreenElement
        ? (document.fullscreenElement.matches('[data-unified-viewer-card]') ? 'card' : 'other')
        : null,
    };
  });
}

// The Asset Details refresh, as the page's own callers run it (GET only).
function refresh(page, regions = ['file']) {
  return page.evaluate(async (names) => {
    const refreshModule = await import('/client/asset-viewer-refresh.js');
    const identity = refreshModule.assetViewerIdentity(document);
    return (await refreshModule.refreshAssetViewer(document, { ...identity, regions: names })).status;
  }, regions);
}

const title = (page) => page.locator(`${DIALOG} [data-unified-viewer-title]`);
const shownImage = (page) => page.locator(`${DIALOG} [data-unified-viewer-media] img.unified-viewer-image:not([hidden])`);
const loaded = (width) => ({ status: 'loaded', width });

test('the preview opens only this image; inspection, fullscreen and focus; page navigation untouched', async ({ page }) => {
  const f = await createProject();
  const second = f.assetId('02-b.png');
  const control = await open(page, f.url('02-b.png', '?sort=filename&order=asc'));
  const href = page.url();

  // One viewer, mounted after the page's main content.
  await expect(page.locator(DIALOG)).toHaveCount(1);
  await expect(page.locator(`main ${DIALOG}`)).toHaveCount(0);
  expect(await page.locator(PAGE_LIVE).count()).toBe(1);
  await expect(page.locator(`${DIALOG} [data-unified-viewer-status]`)).toHaveText('');

  await page.locator(LINK).click();
  await expect(page.locator(DIALOG)).toBeVisible();
  await expect(title(page)).toHaveText('02-b.png');
  await expect(shownImage(page)).toBeVisible();
  await expect.poll(async () => (await viewerState(page)).media).toEqual(loaded(64));
  expect(await viewerState(page)).toMatchObject({
    open: true, mode: 'single', slideshow: false, wrap: false, count: 1, title: '02-b.png',
    originalUrl: `/projects/${f.id}/assets/${second}/original`,
    detailsUrl: null,
    playback: { available: false, playing: false },
  });
  expect((await viewerState(page)).mediaUrl.startsWith(`/projects/${f.id}/assets/${second}/preview?v=`)).toBe(true);
  // Single-image navigation stays separate from the page's Previous/Next links.
  await expect(page.locator(`${DIALOG} [data-unified-viewer-controls]`)).toBeHidden();
  await expect(page.locator(`${DIALOG} [data-unified-viewer-playback]`)).toBeHidden();
  await expect(page.locator(`${DIALOG} [data-unified-viewer-details]`)).toHaveAttribute('href', `/projects/${f.id}/assets/${second}`);
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  await page.keyboard.press('ArrowRight');
  await expect(title(page)).toHaveText('02-b.png');
  expect(page.url()).toBe(href);

  // Fit, button zoom and eligible original-size inspection (B3).
  await expect(page.locator(`${DIALOG} [data-unified-viewer-view-tools]`)).toBeVisible();
  await page.locator(`${DIALOG} [data-unified-viewer-zoom-in]`).click();
  await expect(page.locator(`${DIALOG} [data-unified-viewer-fit]`)).toBeEnabled();
  await page.locator(`${DIALOG} [data-unified-viewer-fit]`).click();
  const originalButton = page.locator(`${DIALOG} [data-unified-viewer-original]`);
  await expect(originalButton).toBeVisible();
  await originalButton.click();
  await expect.poll(async () => (await viewerState(page)).original).toBe('active');

  // Fullscreen (B4): Escape leaves fullscreen first, then closes.
  await page.locator(DIALOG).getByRole('button', { name: 'Enter fullscreen' }).click();
  await expect.poll(async () => (await viewerState(page)).fullscreenElement).toBe('card');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await viewerState(page)).fullscreenElement).toBe(null);
  await expect(page.locator(DIALOG)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(page.locator(LINK)).toBeFocused();
  expect(page.url()).toBe(href);

  // Keyboard activation of the same trigger opens it again.
  await page.keyboard.press('Enter');
  await expect(page.locator(DIALOG)).toBeVisible();
  await page.locator(`${DIALOG} [data-dialog-close]`).click();
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(page.locator(LINK)).toBeFocused();

  // A modified click is left to the browser (observed, then stopped here).
  await page.evaluate(() => {
    window.__modifiedClick = null;
    window.addEventListener('click', (event) => {
      window.__modifiedClick = { prevented: event.defaultPrevented };
      event.preventDefault();
    }, { once: true });
  });
  await page.locator(LINK).click({ modifiers: ['Control'] });
  expect(await page.evaluate(() => window.__modifiedClick)).toEqual({ prevented: false });
  await expect(page.locator(DIALOG)).toBeHidden();

  // The Edit Asset dialog still opens and closes on its own.
  await page.locator('.asset-viewer-edit').click();
  await expect(page.locator('#asset-edit-dialog')).toHaveJSProperty('open', true);
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('#asset-edit-dialog')).toHaveJSProperty('open', false);

  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);

  // The page's own Next/Previous still navigate between Asset Details pages,
  // with normal history.
  const nextHref = await page.locator('a.asset-preview-nav--next').getAttribute('href');
  expect(new URL(nextHref, baseURL).pathname).toBe(`/projects/${f.id}/assets/${f.assetId('03-c.png')}`);
  await page.locator('a.asset-preview-nav--next').click();
  await expect.poll(() => page.url()).toBe(new URL(nextHref, baseURL).href);
  await expect(page.locator(DIALOG)).toBeHidden();
  await page.goBack();
  await expect.poll(() => page.url()).toBe(href);
  await page.locator('a.asset-preview-nav--previous').click();
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/projects/${f.id}/assets/${f.assetId('01-a.png')}`);
});

test('a preview-only Krita image opens through its button with no Original Size', async ({ page }) => {
  const f = await createProject();
  const control = await open(page, f.url('04-paint.kra'));
  const button = page.locator('[data-asset-viewer-host] button.asset-preview-view-button');
  await expect(button).toHaveCount(1);
  await expect(button).toHaveAttribute('aria-label', 'View preview of 04-paint.kra');
  await expect(page.locator('[data-asset-viewer-host] a.asset-preview-link')).toHaveCount(0);
  // The button is drawn as the image, not as a styled button.
  expect(await button.evaluate((node) => {
    const style = getComputedStyle(node);
    return { border: style.borderTopWidth, background: style.backgroundColor, padding: style.paddingTop };
  })).toEqual({ border: '0px', background: 'rgba(0, 0, 0, 0)', padding: '0px' });

  await button.click();
  await expect(page.locator(DIALOG)).toBeVisible();
  await expect(title(page)).toHaveText('04-paint.kra');
  await expect.poll(async () => (await viewerState(page)).media.status).toBe('loaded');
  expect(await viewerState(page)).toMatchObject({ mode: 'single', count: 1, originalUrl: null });
  await expect(page.locator(`${DIALOG} [data-unified-viewer-original]`)).toBeHidden();
  // Fit and zoom still work on the preview.
  await page.locator(`${DIALOG} [data-unified-viewer-zoom-in]`).click();
  await page.locator(`${DIALOG} [data-unified-viewer-fit]`).click();
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(button).toBeFocused();
  // Space activates the button as well.
  await page.keyboard.press('Space');
  await expect(page.locator(DIALOG)).toBeVisible();
  await page.keyboard.press('Escape');

  expect(control.requests.some((request) => request.endsWith('/original'))).toBe(false);
  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('video, comic and missing assets stay outside the viewer', async ({ page }) => {
  const f = await createProject();

  const video = await open(page, f.url('05-clip.webm'));
  await expect(page.locator('[data-asset-viewer-host] video[data-asset-video]')).toHaveCount(1);
  await expect(page.locator('[data-asset-details-viewer-trigger]')).toHaveCount(0);
  // This fixture's bytes are not playable, so the existing player reports
  // its error and hides itself; activating the video frame opens nothing.
  await page.locator('[data-asset-viewer-host] figure[data-asset-video-playback]').click({ position: { x: 10, y: 10 } });
  await page.locator('[data-asset-viewer-host] video').dispatchEvent('click');
  await expect(page.locator(DIALOG)).toBeHidden();
  expect(video.requests.some((request) => /\/assets\/\d+\/preview\b/.test(request))).toBe(false);

  const comic = await open(page, f.url('06-book.cbz'));
  await expect(page.locator('[data-asset-details-viewer-trigger]')).toHaveCount(0);
  await expect(page.locator(DIALOG)).toBeHidden();
  expect(comic.requests.some((request) => (
    /^\/projects\/\d+\/assets\/\d+\/comic(?:\/|$)/.test(request.slice(request.indexOf(' ') + 1))
  ))).toBe(false);

  const missingId = f.assetId('03-c.png');
  fs.rmSync(path.join(f.dir, '03-c.png'));
  app.locals.assetScanner.scanProjectAssets(f.id);
  const missing = await open(page, `/projects/${f.id}/assets/${missingId}`);
  await expect(page.locator('[data-asset-details-viewer-trigger]')).toHaveCount(0);
  await expect(page.locator('[data-asset-viewer-host]')).toContainText('Preview unavailable for missing assets.');

  for (const control of [video, comic, missing]) {
    expect(control.mutations).toEqual([]);
    expect(control.errors).toEqual([]);
  }
});

test('a real Rename while the viewer is open reconciles it from the accepted refresh only', async ({ page }) => {
  const f = await createProject();
  const assetId = f.assetId('02-b.png');
  const control = await open(page, f.url('02-b.png'));

  // Hold the refresh GET that follows the rename.
  let held = null;
  let releaseHeld;
  const heldReady = new Promise((resolve) => { releaseHeld = resolve; });
  await page.route((url) => url.pathname === `/projects/${f.id}/assets/${assetId}`, async (route) => {
    if (route.request().resourceType() !== 'fetch' || held) return route.continue();
    held = route;
    releaseHeld();
    return undefined;
  });

  await page.locator('.asset-viewer-edit').click();
  await expect(page.locator('#asset-edit-dialog')).toHaveJSProperty('open', true);
  await page.locator('#asset-edit-dialog summary', { hasText: 'Rename file' }).click();
  await page.locator('#rename-filename').fill('02-b-final.png');
  await page.locator('form.asset-rename-form button[type="submit"]').click();
  await heldReady;
  await page.locator('#asset-edit-dialog [data-dialog-close]').first().click();
  await expect(page.locator('#asset-edit-dialog')).toHaveJSProperty('open', false);

  // Opened from the page as it was: the old name and revision.
  await page.locator(LINK).click();
  await expect(title(page)).toHaveText('02-b.png');
  await expect.poll(async () => (await viewerState(page)).media).toEqual(loaded(64));
  const before = await viewerState(page);

  await held.continue();
  await expect(title(page)).toHaveText('02-b-final.png');
  const after = await viewerState(page);
  expect(after.session).toBe(before.session);
  expect(after.revision).not.toBe(before.revision);
  expect(after.mediaUrl).not.toBe(before.mediaUrl);
  expect(after.originalUrl).toBe(before.originalUrl);
  await expect.poll(async () => (await viewerState(page)).media).toEqual(loaded(64));
  await expect(page.locator(`${DIALOG} img.unified-viewer-image:not([hidden])`)).toHaveCount(1);
  await expect(page.locator(LINK)).toHaveAttribute('aria-label', 'View original 02-b-final.png');

  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(page.locator(LINK)).toBeFocused();
  expect(f.row(assetId).filename).toBe('02-b-final.png');
  // Only the rename itself was ever posted.
  expect(control.mutations).toEqual([`POST ${baseURL}/projects/${f.id}/assets/${assetId}/rename`]);
  expect(control.errors).toEqual([]);
});

test('refreshes while open: metadata kept, revision reloads, superseded reads lose, closed sessions ignore', async ({ page }) => {
  const f = await createProject();
  const assetId = f.assetId('02-b.png');
  const detailsPath = `/projects/${f.id}/assets/${assetId}`;
  const control = await open(page, f.url('02-b.png'));

  await page.locator(LINK).click();
  await expect.poll(async () => (await viewerState(page)).media).toEqual(loaded(64));
  const first = await viewerState(page);
  await shownImage(page).evaluate((img) => { img.__sameImage = true; });

  // Metadata-only refreshes keep the media, its pixels and the session.
  expect(await refresh(page, ['tags'])).toBe('installed');
  expect(await refresh(page, ['file'])).toBe('installed');
  expect(await shownImage(page).evaluate((img) => img.__sameImage === true)).toBe(true);
  expect(await viewerState(page)).toMatchObject({ session: first.session, mediaUrl: first.mediaUrl });

  // A new file revision reloads the media in place.
  await f.rewrite('02-b.png', 80);
  expect(await refresh(page)).toBe('installed');
  await expect.poll(async () => (await viewerState(page)).media).toEqual(loaded(80));
  const second = await viewerState(page);
  expect(second.session).toBe(first.session);
  expect(second.revision).not.toBe(first.revision);

  // A superseded read (sent before a newer one) cannot restore old media.
  const staleHtml = await (await page.request.get(`${baseURL}${detailsPath}`)).text();
  let held = null;
  let releaseHeld;
  const heldReady = new Promise((resolve) => { releaseHeld = resolve; });
  await page.route((url) => url.pathname === detailsPath, async (route) => {
    if (route.request().resourceType() !== 'fetch' || held) return route.continue();
    held = route;
    releaseHeld();
    return undefined;
  });
  await page.evaluate(async () => {
    const refreshModule = await import('/client/asset-viewer-refresh.js');
    window.__olderRefresh = refreshModule.refreshAssetViewer(document, { ...refreshModule.assetViewerIdentity(document), regions: ['file'] })
      .then((result) => result.status);
  });
  await heldReady;
  await f.rewrite('02-b.png', 96);
  expect(await refresh(page)).toBe('installed');
  await expect.poll(async () => (await viewerState(page)).media).toEqual(loaded(96));
  const newest = await viewerState(page);
  await held.fulfill({ status: 200, contentType: 'text/html', body: staleHtml });
  expect(await page.evaluate(() => window.__olderRefresh)).toBe('superseded');
  expect(await viewerState(page)).toMatchObject({ session: newest.session, revision: newest.revision, mediaUrl: newest.mediaUrl });
  await expect(page.locator(LINK)).toHaveAttribute('data-viewer-revision', newest.revision);
  await page.unroute((url) => url.pathname === detailsPath);

  // A closed session ignores a later refresh; reopening starts from the page.
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();
  f.renameRow(assetId, '02-b-renamed.png');
  expect(await refresh(page)).toBe('installed');
  await expect(page.locator(DIALOG)).toBeHidden();
  expect((await viewerState(page)).open).toBe(false);
  await page.locator(LINK).click();
  await expect(title(page)).toHaveText('02-b-renamed.png');
  expect((await viewerState(page)).session).toBe(newest.session + 1);
  await page.keyboard.press('Escape');

  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('kind changes, lost originals and deletion: the viewer updates or retires, focus stays on the page', async ({ page }) => {
  const f = await createProject();
  const second = f.assetId('02-b.png');
  const control = await open(page, f.url('02-b.png'));

  // Original eligibility lost (now a preview-only Krita image): the opener is
  // rebuilt; the session keeps its item without Original Size, and focus
  // returns to the rebuilt trigger.
  await page.locator(LINK).click();
  await expect.poll(async () => (await viewerState(page)).media).toEqual(loaded(64));
  const { session } = await viewerState(page);
  await f.becomeKrita(second, '02-b.kra');
  expect(await refresh(page)).toBe('installed');
  await expect(title(page)).toHaveText('02-b.kra');
  expect(await viewerState(page)).toMatchObject({ open: true, session, originalUrl: null });
  await expect(page.locator(`${DIALOG} [data-unified-viewer-original]`)).toBeHidden();
  await expect.poll(async () => (await viewerState(page)).media.status).toBe('loaded');
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(page.locator('[data-asset-viewer-host] button.asset-preview-view-button')).toBeFocused();

  // Image replaced by video: the image viewer closes; its opener is gone, so
  // focus lands on the Preview heading.
  const first = f.assetId('01-a.png');
  await open(page, f.url('01-a.png'));
  await page.locator(LINK).click();
  await expect(page.locator(DIALOG)).toBeVisible();
  f.becomeVideo(first, '01-a.webm');
  expect(await refresh(page)).toBe('installed');
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(page.locator('[data-asset-viewer-host] video[data-asset-video]')).toHaveCount(1);
  await expect(page.locator('#asset-preview-heading')).toBeFocused();

  // Deleted elsewhere: the read answers 404 and the viewer closes.
  const third = f.assetId('03-c.png');
  await open(page, f.url('03-c.png'));
  await page.locator(LINK).click();
  await expect.poll(async () => (await viewerState(page)).media).toEqual(loaded(48));
  f.remove(third);
  expect(await refresh(page)).toBe('missing');
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(page.locator(`${DIALOG} [data-unified-viewer-media] img`)).toHaveCount(0);
  // B6-F1: the gone asset's link is no longer actionable, so focus returns to
  // the Preview heading rather than to the invalidated trigger.
  await expect(page.locator(LINK)).toHaveCount(0);
  await expect(page.locator(GONE)).toHaveCount(1);
  await expect(page.locator('#asset-preview-heading')).toBeFocused();

  // A retired page (the Delete flow's terminal state) never reopens it either.
  await page.evaluate(async () => {
    const refreshModule = await import('/client/asset-viewer-refresh.js');
    refreshModule.retireAssetViewer(document);
    window.__retiredClick = null;
    window.addEventListener('click', (event) => {
      window.__retiredClick = { prevented: event.defaultPrevented };
      event.preventDefault();
    }, { once: true });
  });
  await page.locator(PREVIEW_IMAGE).click();
  expect(await page.evaluate(() => window.__retiredClick)).toEqual({ prevented: false });
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(page.locator(GONE)).toHaveCount(1);

  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);
});

// B6-F1: a real Tags save, its automatic refresh GET held while the asset
// record is deleted, then released into an authoritative 404. Nothing calls
// retireAssetViewer(): the gone notification alone must invalidate the page's
// stale preview trigger, whether the viewer is open or already closed.
let goneTagCount = 0;
async function holdTagRefreshIntoGone(page, f, filename) {
  goneTagCount += 1;
  const tag = app.locals.tagService.createTag({ name: `Gone viewer ${goneTagCount}` });
  const assetId = f.assetId(filename);
  const detailsPath = `/projects/${f.id}/assets/${assetId}`;
  const control = await open(page, f.url(filename));

  let held = null;
  let releaseHeld;
  const heldReady = new Promise((resolve) => { releaseHeld = resolve; });
  await page.route((url) => url.pathname === detailsPath, async (route) => {
    if (route.request().resourceType() !== 'fetch' || held) return route.continue();
    held = route;
    releaseHeld();
    return undefined;
  });

  // Change a tag in Edit Asset: the POST lands, its refresh GET is held.
  await page.locator('.asset-viewer-edit').click();
  await expect(page.locator('#asset-edit-dialog')).toHaveJSProperty('open', true);
  const dropdown = page.locator('#asset-tags-form');
  if (!(await dropdown.evaluate((node) => node.open))) await dropdown.locator('summary').click();
  await page.locator(`#asset-tags-form input[name="tagIds[]"][value="${tag.id}"]`).click();
  await heldReady;

  // Deleted elsewhere while the read is out.
  f.remove(assetId);
  expect(f.row(assetId)).toBeUndefined();

  await page.locator('#asset-edit-dialog [data-dialog-close]').first().click();
  await expect(page.locator('#asset-edit-dialog')).toHaveJSProperty('open', false);
  return { assetId, detailsPath, control, release: () => held.continue() };
}

// Requests for the gone asset's own media (preview or original), by path.
const mediaRequests = (control, assetId) => control.requests
  .filter((entry) => entry.startsWith('GET ') && entry.includes(`/assets/${assetId}/`));

test('B6-F1: an authoritative 404 from a held Tags refresh closes the open viewer and the old link never reopens it', async ({ page }) => {
  const f = await createProject();
  const held = await holdTagRefreshIntoGone(page, f, '02-b.png');
  const { assetId, control } = held;

  // Opened from the page as it still shows the asset.
  await page.locator(LINK).click();
  await expect(page.locator(DIALOG)).toBeVisible();
  const opened = await viewerState(page);
  expect(opened).toMatchObject({ open: true, title: '02-b.png' });
  expect(opened.mediaUrl).toContain(`/assets/${assetId}/`);
  // Its media work is under way for the old descriptor (the file is already
  // gone on disk, so it may have failed by now; it never stays idle).
  await expect.poll(async () => (await viewerState(page)).media.status).not.toBe('idle');

  // The held read answers 404: the viewer closes and releases its media.
  await held.release();
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect.poll(async () => (await viewerState(page)).open).toBe(false);
  await expect(page.locator(`${DIALOG} [data-unified-viewer-media] img`)).toHaveCount(0);
  expect(await viewerState(page)).toMatchObject({ session: null, media: { status: 'idle' } });
  await expect(page.locator('#asset-preview-heading')).toBeFocused();

  // The stale original link is gone, not merely flagged; the image stays.
  await expect(page.locator(LINK)).toHaveCount(0);
  await expect(page.locator('[data-asset-details-viewer-trigger]')).toHaveCount(0);
  await expect(page.locator(`[data-asset-viewer-host] a[href*="/assets/${assetId}/"]`)).toHaveCount(0);
  await expect(page.locator(GONE)).toHaveCount(1);
  await expect(page.locator(PREVIEW_IMAGE)).toBeVisible();

  // Clicking the previous preview again: no viewer, no navigation, no media request.
  const before = mediaRequests(control, assetId).length;
  await page.locator(PREVIEW_IMAGE).click();
  await page.evaluate(() => new Promise((resolve) => { requestAnimationFrame(() => requestAnimationFrame(resolve)); }));
  await expect(page.locator(DIALOG)).toBeHidden();
  expect(await viewerState(page)).toMatchObject({ open: false, session: null });
  await expect(page.locator(DIALOG)).toHaveJSProperty('open', false);
  expect(mediaRequests(control, assetId)).toHaveLength(before);
  expect(await page.evaluate(() => window.__sameDocument)).toBe(true);
  expect(control.mutations).toEqual([`POST ${baseURL}/projects/${f.id}/assets/${assetId}/tags`]);
  expect(control.errors).toEqual([]);
});

test('B6-F1: a 404 arriving after the viewer closed invalidates the preview-only button too', async ({ page }) => {
  const f = await createProject();
  const held = await holdTagRefreshIntoGone(page, f, '04-paint.kra');
  const { assetId, control } = held;

  // Opened and closed again before the read answers.
  await page.locator(BUTTON).click();
  await expect(page.locator(DIALOG)).toBeVisible();
  expect((await viewerState(page)).originalUrl).toBeNull();
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(page.locator(BUTTON)).toBeFocused();
  const { session } = await page.evaluate(async () => {
    const { unifiedViewerFor } = await import('/client/unified-viewer.js');
    return { session: unifiedViewerFor(document).getState().session };
  });
  expect(session).toBeNull();

  await held.release();
  // Nothing is reopened to report it; the focused button is replaced and its
  // focus moves to the Preview heading, never to the body.
  await expect(page.locator(BUTTON)).toHaveCount(0);
  await expect(page.locator(GONE)).toHaveCount(1);
  await expect(page.locator('#asset-preview-heading')).toBeFocused();
  await expect(page.locator(DIALOG)).toBeHidden();

  const before = mediaRequests(control, assetId).length;
  await page.locator(PREVIEW_IMAGE).click();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  await page.evaluate(() => new Promise((resolve) => { requestAnimationFrame(() => requestAnimationFrame(resolve)); }));
  await expect(page.locator(DIALOG)).toBeHidden();
  expect(await viewerState(page)).toMatchObject({ open: false, session: null });
  expect(mediaRequests(control, assetId)).toHaveLength(before);
  expect(control.mutations).toEqual([`POST ${baseURL}/projects/${f.id}/assets/${assetId}/tags`]);
  expect(control.errors).toEqual([]);
});

test('narrow viewport: the viewer fits without horizontal scrolling and closes back to the page', async ({ page }) => {
  const f = await createProject();
  const control = await open(page, f.url('02-b.png'), { viewport: { width: 375, height: 740 } });
  await page.locator(LINK).click();
  await expect(page.locator(DIALOG)).toBeVisible();
  await expect.poll(async () => (await viewerState(page)).media).toEqual(loaded(64));
  await expect(page.locator(`${DIALOG} [data-unified-viewer-view-tools]`)).toBeVisible();
  await expect(page.locator(`${DIALOG} [data-dialog-close]`)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const card = await page.locator(`${DIALOG} [data-unified-viewer-card]`).boundingBox();
  expect(card.x).toBeGreaterThanOrEqual(0);
  expect(card.x + card.width).toBeLessThanOrEqual(375);
  await page.locator(`${DIALOG} [data-dialog-close]`).click();
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(page.locator(LINK)).toBeFocused();
  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);
});

// ─── C2b: comics on Asset Details, compiled production bundle ────────────────
//
// Read Comic on the real Asset Details page against the compiled production
// bundle (built here into a temp directory) and Milestone A's real comic
// routes, with an isolated installation (temp SQLite database, projects root
// and comic runtime). Every request is recorded, so manifest and page
// requests are proven to start only from Read Comic or an accepted source-hint
// change. Refreshes run through the page's own Edit Asset flows (a real Rename,
// a real Tags save held into an authoritative 404); where a test needs a plain
// 'file' re-read, it calls the same refresh engine the page's callers use
// (its generation, owed regions and observers live on the document, so the
// compiled host hears it exactly as it hears its own callers).
test.describe('C2b: Asset Details Read Comic (compiled bundle)', () => {
  const COMIC = '[data-asset-viewer-host] a[data-asset-details-comic-trigger]';
  const readerLink = (page) => page.locator(`${COMIC}:visible`);
  const COMIC_GONE = '[data-asset-viewer-host] [data-asset-comic-preview] [data-asset-details-viewer-gone]';
  const POSITION = `${DIALOG} [data-unified-viewer-position]`;
  const NEXT = `${DIALOG} [data-unified-viewer-next]`;
  const SHOWN = `${DIALOG} [data-unified-viewer-media] img:is(.unified-viewer-image, .unified-viewer-page-image):not([hidden])`;
  const DIRECTION_MENU = `${DIALOG} #unified-viewer-direction-dropdown`;
  const LAYOUT_MENU = `${DIALOG} #unified-viewer-layout-dropdown`;
  const FIXTURES = fileURLToPath(new URL('../fixtures/archive-decoder/', import.meta.url));
  const MIME = {
    cbz: 'application/vnd.comicbook+zip', cbr: 'application/vnd.comicbook-rar', cb7: 'application/x-cb7',
    png: 'image/png', webm: 'video/webm',
  };
  let c;

  test.beforeAll(async () => {
    const croot = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-asset-details-comic-'));
    const cProjectsRoot = path.join(croot, 'projects');
    const cAppDataRoot = path.join(croot, 'app');
    const cPreviewRoot = path.join(cAppDataRoot, 'previews');
    const viteDistRoot = path.join(croot, 'client');
    fs.mkdirSync(cProjectsRoot);
    fs.mkdirSync(cPreviewRoot, { recursive: true });
    const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
    await build({ root: projectRoot, configFile: path.join(projectRoot, 'vite.config.js'),
      build: { outDir: viteDistRoot }, logLevel: 'silent' });
    const cdb = openDatabase(path.join(croot, 'test.db'));
    runMigrations(cdb, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(cAppDataRoot);
    const runtime = createComicRuntime({ appDataRoot: cAppDataRoot, projectsRoot: cProjectsRoot, cacheOptions: { settleMs: 0 } });
    await runtime.start();
    const capp = createApp({ appName: 'CreatorCrate', db: cdb, projectsRoot: cProjectsRoot, previewRoot: cPreviewRoot }, {
      appDataRoot: cAppDataRoot, authState: { csrfPepper }, comicRuntime: runtime,
      startGeneratedImageRebuild: false,
      useViteAssets: true, viteDistRoot,
      assetManifest: createAssetManifest({ distRoot: viteDistRoot, manifestPath: path.join(viteDistRoot, '.vite', 'manifest.json') }),
    });
    capp.locals.generatedImagePublicationLifecycle.prepare();
    capp.locals.generatedImagePublicationLifecycle.signal();
    await capp.locals.generatedImagePublicationLifecycle.waitForIdle();
    const cserver = capp.listen(0, '127.0.0.1');
    await new Promise((resolve) => cserver.once('listening', resolve));

    const gradient = async (width, height, seed) => {
      const raw = Buffer.alloc(width * height * 3);
      for (let index = 0; index < raw.length; index += 1) raw[index] = (index * 7 + seed) & 0xff;
      return sharp(raw, { raw: { width, height, channels: 3 } });
    };
    const pages = [
      await (await gradient(60, 80, 10)).jpeg().toBuffer(),
      await (await gradient(60, 80, 90)).png().toBuffer(),
      await (await gradient(80, 60, 170)).png().toBuffer(),
    ];
    const projectRepo = createProjectRepository(cdb);
    const assetRepo = createAssetRepository(cdb);
    const project = projectRepo.create({
      title: 'Details Comics', projectType: 'images', slug: slugify('Details Comics', { lowercase: true }),
      description: '', notes: '', status: 'tbd', priority: 'normal', plannedDate: null, publishedDate: null, patreonUrl: null,
    });
    const relDir = formatProjectDirName(project.id, project.slug);
    const absDir = path.resolve(cProjectsRoot, relDir);
    fs.mkdirSync(absDir, { recursive: true });
    projectRepo.setProjectDir(project.id, relDir);
    bindTestProjectOwnership(cdb, project.id, absDir);
    const write = (relPath, bytes) => {
      fs.writeFileSync(path.join(absDir, relPath), bytes);
      const stat = fs.statSync(path.join(absDir, relPath));
      const extension = relPath.split('.').pop();
      return assetRepo.upsert(project.id, relPath, {
        filename: relPath, extension, mimeType: MIME[extension], sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString(),
      }).id;
    };
    const cbz = () => makeZip(pages.map((data, index) => ({ name: `p${index + 1}.${index ? 'png' : 'jpg'}`, data })));
    const ids = {
      issue: write('a-issue.cbz', cbz()),
      renamed: write('b-issue.cbz', cbz()),
      gone: write('c-issue.cbz', cbz()),
      cb7: write('d-volume.cb7', fs.readFileSync(path.join(FIXTURES, 'pages-nonsolid.7z'))),
      cbr: write('e-volume.cbr', fs.readFileSync(path.join(FIXTURES, 'rar5-compressed.rar'))),
      image: write('f-image.png', await (await gradient(40, 40, 30)).png().toBuffer()),
      video: write('g-clip.webm', Buffer.from('not really a video')),
      encrypted: write('h-encrypted.cbr', fs.readFileSync(path.join(FIXTURES, 'rar5-encrypted.rar'))),
    };
    const rowOf = (assetId) => cdb.prepare('SELECT * FROM assets WHERE id = ?').get(assetId);
    let tagCount = 0;
    c = {
      baseURL: `http://127.0.0.1:${cserver.address().port}`,
      project,
      ids,
      app: capp,
      row: rowOf,
      previewService: capp.locals.previewService,
      fileExists: (filename) => fs.existsSync(path.join(absDir, filename)),
      url: (assetId) => `/projects/${project.id}/assets/${assetId}`,
      tag: () => { tagCount += 1; return capp.locals.tagService.createTag({ name: `Comic gone ${tagCount}` }); },
      // Deletes the record only (the archive stays on disk), and puts the
      // same record back: a later current read of the same identity is 200.
      deleteRow(assetId) {
        const saved = rowOf(assetId);
        cdb.prepare('DELETE FROM assets WHERE id = ?').run(assetId);
        return () => {
          const columns = Object.keys(saved);
          cdb.prepare(`INSERT INTO assets (${columns.join(', ')}) VALUES (${columns.map((name) => `@${name}`).join(', ')})`).run(saved);
        };
      },
      async close() {
        cserver.closeAllConnections();
        await new Promise((resolve) => cserver.close(resolve));
        capp.locals.comicMediaService.stop();
        await capp.locals.comicMediaService.pauseForMaintenance().waitForIdle();
        for (const owner of [capp.locals.generatedImageRebuildService, capp.locals.generatedImagePublicationLifecycle]) {
          owner.stop();
          await owner.waitForIdle();
        }
        await runtime.close();
        closeDatabase(cdb);
        const cacheRoot = defaultComicPreparationCacheRoot(cAppDataRoot);
        if (!path.resolve(croot).startsWith(path.resolve(os.tmpdir()) + path.sep)
          || !path.resolve(cacheRoot).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unsafe comic fixture cleanup');
        fs.rmSync(cacheRoot, { recursive: true, force: true });
        fs.rmSync(croot, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
      },
    };
  });
  test.afterAll(async () => { await c?.close(); });

  const manifestPath = (assetId) => `/projects/${c.project.id}/assets/${assetId}/comic`;

  async function openDetails(page, assetId, { viewport = { width: 1280, height: 900 } } = {}) {
    const control = { requests: [], mutations: [], errors: [] };
    page.on('pageerror', (error) => control.errors.push(error.message));
    page.on('request', (request) => {
      const parsed = new URL(request.url());
      control.requests.push(`${parsed.pathname}${parsed.search}`);
      if (request.method() !== 'GET') control.mutations.push(`${request.method()} ${parsed.pathname}`);
    });
    control.comic = () => control.requests.filter((entry) => /\/comic(\/pages\/\d+)?(\?|$)/.test(entry));
    control.manifests = (id) => control.requests.filter((entry) => entry === manifestPath(id));
    control.pages = (id) => control.requests.filter((entry) => entry.startsWith(`${manifestPath(id)}/pages/`));
    await page.setViewportSize(viewport);
    await page.goto(`${c.baseURL}${c.url(assetId)}`);
    // The compiled production bundle, not the unbundled client.
    expect(await page.evaluate(() => Boolean(document.querySelector('script[type="module"][src^="/vite/"]')))).toBe(true);
    await page.waitForFunction(() => Boolean(document.getElementById('unified-viewer-dialog')?.__creatorCrateUnifiedViewer));
    await page.evaluate(() => { window.__sameDocument = true; });
    return control;
  }

  const state = (page) => page.evaluate(() => {
    const viewer = document.getElementById('unified-viewer-dialog').__creatorCrateUnifiedViewer;
    const { open, session, comic, reader, item, context } = viewer.getState();
    return {
      open, session, reader, context,
      title: item?.title ?? null,
      comic: comic ? { state: comic.state, projectId: comic.projectId, assetId: comic.assetId,
        sourceRevision: comic.sourceRevision, revision: comic.revision, pageCount: comic.pageCount } : null,
      fullscreen: document.fullscreenElement
        ? (document.fullscreenElement.matches('[data-unified-viewer-card]') ? 'card' : 'other') : null,
      dialogs: document.querySelectorAll('#unified-viewer-dialog').length,
    };
  });

  // A plain 'file' re-read by the page's refresh engine (GET only).
  const fileRefresh = (page) => page.evaluate(async () => {
    const refreshModule = await import('/client/asset-viewer-refresh.js');
    const identity = refreshModule.assetViewerIdentity(document);
    return (await refreshModule.refreshAssetViewer(document, { ...identity, regions: ['file'] })).status;
  });

  async function readerReady(page, title) {
    await expect(page.locator(DIALOG)).toBeVisible();
    await expect(page.locator(`${DIALOG} [data-unified-viewer-title]`)).toHaveText(title);
    await expect.poll(async () => (await state(page)).comic?.state).toBe('ready');
  }

  async function choose(page, menu, label) {
    await page.locator(`${menu} summary`).click();
    await expect(page.locator(menu)).toHaveAttribute('open', '');
    await page.locator(`${menu} .asset-filter-multiselect-panel`).getByText(label, { exact: true }).click();
    await expect(page.locator(menu)).not.toHaveAttribute('open', '');
  }

  // Hold the page's next refresh GET of this asset (a fetch, not navigation).
  async function holdNextRefresh(page, assetId) {
    let held = null;
    let releaseHeld;
    const ready = new Promise((resolve) => { releaseHeld = resolve; });
    const matcher = (url) => url.pathname === c.url(assetId);
    await page.route(matcher, async (route) => {
      if (route.request().resourceType() !== 'fetch' || held) return route.continue();
      held = route;
      releaseHeld();
      return undefined;
    });
    return { ready, route: () => held, unroute: () => page.unroute(matcher) };
  }

  test('CBZ: Read Comic opens the shared reader only on activation; reads, RTL/Spread, fullscreen and focus', async ({ page }, testInfo) => {
    const { ids } = c;
    const control = await openDetails(page, ids.issue);
    const link = readerLink(page);
    await expect(link).toHaveCount(1);
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', c.url(ids.issue));
    await expect(link).toHaveAttribute('aria-label', 'Read comic a-issue.cbz');
    await expect(page.locator(COMIC)).toHaveCount(2);
    await expect(page.locator('[data-asset-comic-preview]')).not.toContainText(/CB[ZR7] comic/);
    await expect(page.locator('[data-asset-comic-preview] [data-preview-fallback]')).toBeHidden();
    await expect(page.locator(PREVIEW_IMAGE)).toHaveCount(1);
    await expect(page.locator('[data-asset-comic-preview]')).toHaveAttribute('data-preview-state', 'loaded');
    await expect(page.locator(PREVIEW_IMAGE)).toBeVisible();
    await expect(page.locator(PREVIEW_IMAGE)).toHaveAttribute('src', new RegExp(`/assets/${ids.issue}/preview\\?`));
    expect(await page.locator(PREVIEW_IMAGE).evaluate((image) => image.complete && image.naturalWidth > 0)).toBe(true);
    for (const trigger of await page.locator(COMIC).all()) {
      await expect(trigger).toHaveAttribute('data-comic-project', String(c.project.id));
      await expect(trigger).toHaveAttribute('data-comic-asset', String(ids.issue));
      await expect(trigger).toHaveAttribute('data-comic-source-revision', /.+/);
    }
    await expect(page.locator('[data-asset-details-viewer-trigger]')).toHaveCount(0);
    await expect(page.locator(DIALOG)).toHaveCount(1);
    await expect(page.locator(DIALOG)).toBeHidden();

    // Native Preview loading never fetches Reader manifests or original pages.
    await link.hover();
    await link.focus();
    await page.locator('.asset-viewer-edit').click();
    await expect(page.locator('#asset-edit-dialog')).toHaveJSProperty('open', true);
    await page.locator('#asset-edit-dialog [data-dialog-close]').first().click();
    await expect(page.locator('#asset-edit-dialog')).toHaveJSProperty('open', false);
    await page.waitForTimeout(300);
    expect(control.comic()).toEqual([]);

    // A modified click is left to the link (never prevented, never the reader).
    const modified = await link.evaluate((node) => {
      let prevented = null;
      const probe = (event) => { prevented = event.defaultPrevented; event.preventDefault(); };
      window.addEventListener('click', probe, { once: true });
      node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
      return prevented;
    });
    expect(modified).toBe(false);
    await expect(page.locator(DIALOG)).toBeHidden();
    expect(control.comic()).toEqual([]);

    // Activation: the one shared dialog, one manifest, then page 1.
    await link.click();
    await readerReady(page, 'a-issue.cbz');
    await expect(page.locator(POSITION)).toHaveText('Page 1 of 3');
    await expect(page.locator(SHOWN)).toHaveCount(1);
    expect(control.manifests(ids.issue)).toHaveLength(1);
    expect(control.pages(ids.issue)[0]).toMatch(/\/pages\/1\?v=[0-9a-f]{32}$/);
    const opened = await state(page);
    expect(opened).toMatchObject({ open: true, dialogs: 1, comic: { projectId: c.project.id, assetId: ids.issue }, context: { filename: 'a-issue.cbz', projectName: c.project.title, projectId: String(c.project.id), assetId: String(ids.issue), detailsUrl: c.url(ids.issue) } });
    // The host's indexed hint, never the manifest revision.
    expect(opened.comic.sourceRevision).toBe(await link.getAttribute('data-comic-source-revision'));
    expect(opened.comic.sourceRevision).not.toBe(opened.comic.revision);
    expect(page.url()).toBe(`${c.baseURL}${c.url(ids.issue)}`);

    await page.locator(NEXT).click();
    await expect(page.locator(POSITION)).toHaveText('Page 2 of 3');
    await choose(page, DIRECTION_MENU, 'Right-to-Left');
    await choose(page, LAYOUT_MENU, 'Two-Page Spread — Cover Alone');
    await expect(page.locator(POSITION)).toHaveText('Pages 2–3 of 3');
    await expect(page.locator(SHOWN)).toHaveCount(2);
    expect((await state(page)).reader).toMatchObject({ direction: 'rtl', layout: 'spread' });

    // Fullscreen first, a file re-read with the same hint changes nothing.
    await page.locator(DIALOG).getByRole('button', { name: 'Enter fullscreen' }).click();
    await expect.poll(async () => (await state(page)).fullscreen).toBe('card');
    expect(await fileRefresh(page)).toBe('installed');
    expect(await fileRefresh(page)).toBe('installed');
    await expect(page.locator(POSITION)).toHaveText('Pages 2–3 of 3');
    expect(await state(page)).toMatchObject({ open: true, session: opened.session, fullscreen: 'card', comic: { state: 'ready', revision: opened.comic.revision } });
    expect(control.manifests(ids.issue)).toHaveLength(1);
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await state(page)).fullscreen).toBe(null);
    await expect(page.locator(DIALOG)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator(DIALOG)).toBeHidden();
    await expect(link).toBeFocused();

    // Keyboard activation reopens it (a new session, preferences kept).
    await page.keyboard.press('Enter');
    await readerReady(page, 'a-issue.cbz');
    expect((await state(page)).session).toBe(opened.session + 1);
    expect((await state(page)).reader).toMatchObject({ direction: 'rtl', layout: 'spread' });
    expect(control.manifests(ids.issue)).toHaveLength(2);
    await page.keyboard.press('Escape');
    await expect(page.locator(DIALOG)).toBeHidden();
    await expect(link).toBeFocused();

    expect(await page.evaluate(() => window.__sameDocument)).toBe(true);
    expect(control.mutations).toEqual([]);
    expect(control.errors).toEqual([]);
    await testInfo.attach('native-cover-reader-focus', { body: await page.screenshot(), contentType: 'image/png' });
  });

  test('a real Rename while the reader is open: one fresh manifest from the accepted refresh, same session, page 1', async ({ page }, testInfo) => {
    const { ids } = c;
    const control = await openDetails(page, ids.renamed);
    const before = await readerLink(page).getAttribute('data-comic-source-revision');
    const oldPreview = await page.locator(PREVIEW_IMAGE).getAttribute('src');

    // Rename in Edit Asset; its refresh GET is held.
    const hold = await holdNextRefresh(page, ids.renamed);
    await page.locator('.asset-viewer-edit').click();
    await expect(page.locator('#asset-edit-dialog')).toHaveJSProperty('open', true);
    await page.locator('#asset-edit-dialog summary', { hasText: 'Rename file' }).click();
    await page.locator('#rename-filename').fill('b-issue-final.cbz');
    await page.locator('form.asset-rename-form button[type="submit"]').click();
    await hold.ready;
    await page.locator('#asset-edit-dialog [data-dialog-close]').first().click();
    await expect(page.locator('#asset-edit-dialog')).toHaveJSProperty('open', false);
    expect(c.row(ids.renamed).filename).toBe('b-issue-final.cbz');
    expect(c.row(ids.renamed).relative_path).toBe('b-issue-final.cbz');
    expect(c.fileExists('b-issue-final.cbz')).toBe(true);
    expect(c.fileExists('b-issue.cbz')).toBe(false);

    // Opened from the page as it still shows the old name and hint.
    await readerLink(page).click();
    await readerReady(page, 'b-issue.cbz');
    await page.locator(NEXT).click();
    await expect(page.locator(POSITION)).toHaveText('Page 2 of 3');
    const opened = await state(page);
    expect(opened.comic.sourceRevision).toBe(before);
    expect(control.manifests(ids.renamed)).toHaveLength(1);

    // The accepted refresh: a new hint, exactly one fresh manifest, page 1.
    await hold.route().continue();
    await expect(readerLink(page)).toHaveAttribute('aria-label', 'Read comic b-issue-final.cbz');
    const after = await readerLink(page).getAttribute('data-comic-source-revision');
    expect(after).not.toBe(before);
    await expect(page.locator(COMIC)).toHaveCount(2);
    await expect(readerLink(page)).toHaveCount(1);
    await expect(page.locator(PREVIEW_IMAGE)).not.toHaveAttribute('src', oldPreview);
    await expect(page.locator('[data-asset-comic-preview]')).toHaveAttribute('data-preview-state', 'loaded');
    await expect(page.locator(PREVIEW_IMAGE)).toBeVisible();
    for (const trigger of await page.locator(COMIC).all()) {
      await expect(trigger).toHaveAttribute('data-comic-source-revision', after);
      await expect(trigger).toHaveAttribute('data-comic-filename', 'b-issue-final.cbz');
    }
    await expect.poll(async () => (await state(page)).comic?.sourceRevision).toBe(after);
    await expect.poll(async () => (await state(page)).comic?.state).toBe('ready');
    await expect(page.locator(POSITION)).toHaveText('Page 1 of 3');
    // The same session; its page set was retired and republished (the secure
    // manifest revision is the backend's own and may stay equal).
    expect(await state(page)).toMatchObject({ open: true, session: opened.session, context: { filename: 'b-issue-final.cbz' } });
    expect(control.manifests(ids.renamed)).toHaveLength(2);
    await hold.unroute();

    // Repeated equivalent re-reads reload nothing.
    expect(await fileRefresh(page)).toBe('installed');
    expect(await fileRefresh(page)).toBe('installed');
    await page.waitForTimeout(200);
    expect(control.manifests(ids.renamed)).toHaveLength(2);

    // Refresh synchronizes media in place; closing restores focus to the retained opener.
    await page.keyboard.press('Escape');
    await expect(page.locator(DIALOG)).toBeHidden();
    await expect(readerLink(page)).toBeFocused();
    expect(control.mutations).toEqual([`POST /projects/${c.project.id}/assets/${ids.renamed}/rename`]);
    expect(control.errors).toEqual([]);
    await testInfo.attach('renamed-cover-reader-focus', { body: await page.screenshot(), contentType: 'image/png' });
  });

  test('an authoritative 404 closes the reader and persistently invalidates Read Comic; only a newer render restores it', async ({ page }, testInfo) => {
    const { ids } = c;
    const tag = c.tag();
    const control = await openDetails(page, ids.gone);
    const hold = await holdNextRefresh(page, ids.gone);

    // A real Tags save; its refresh GET is held.
    await page.locator('.asset-viewer-edit').click();
    await expect(page.locator('#asset-edit-dialog')).toHaveJSProperty('open', true);
    const dropdown = page.locator('#asset-tags-form');
    if (!(await dropdown.evaluate((node) => node.open))) await dropdown.locator('summary').click();
    await page.locator(`#asset-tags-form input[name="tagIds[]"][value="${tag.id}"]`).click();
    await hold.ready;
    await page.locator('#asset-edit-dialog [data-dialog-close]').first().click();
    await expect(page.locator('#asset-edit-dialog')).toHaveJSProperty('open', false);

    // Reading, then the record is deleted elsewhere while the read is out.
    await readerLink(page).click();
    await readerReady(page, 'c-issue.cbz');
    const oldLink = await readerLink(page).elementHandle();
    const restore = c.deleteRow(ids.gone);
    expect(control.manifests(ids.gone)).toHaveLength(1);

    await hold.route().continue();
    await expect(page.locator(DIALOG)).toBeHidden();
    await expect.poll(async () => (await state(page)).open).toBe(false);
    await expect(page.locator(`${DIALOG} [data-unified-viewer-media] img`)).toHaveCount(0);
    await expect(page.locator('#asset-preview-heading')).toBeFocused();
    await expect(page.locator(COMIC)).toHaveCount(0);
    await expect(page.locator(COMIC_GONE)).toHaveCount(2);
    for (const marker of await page.locator(COMIC_GONE).all()) {
      expect(await marker.evaluate((node) => node.tagName)).toBe('SPAN');
      await expect(marker).not.toHaveAttribute('href');
    }
    await expect(page.locator(PREVIEW_IMAGE)).toBeHidden();
    await expect(page.locator(PREVIEW_IMAGE)).not.toHaveAttribute('src');
    await expect(page.locator('[data-asset-viewer-host] [data-comic-source-revision]')).toHaveCount(0);
    await expect(page.locator('[data-asset-viewer-host] [data-comic-project], [data-asset-viewer-host] [data-comic-asset]')).toHaveCount(0);
    await testInfo.attach('withdrawn-cover-no-reader', { body: await page.screenshot(), contentType: 'image/png' });
    await expect(page.locator(`[data-asset-viewer-host] a[href="${c.url(ids.gone)}"]`)).toHaveCount(0);
    await hold.unroute();

    // The marker, the detached old link and the host's own entry point open nothing.
    await page.locator(COMIC_GONE).evaluateAll((markers) => markers.forEach((marker) => marker.click()));
    await page.keyboard.press('Enter');
    // The detached old link: its click never reaches the page's delegated
    // binding. (Its own default — navigating to this page's href — is
    // cancelled here; a detached <a> can still navigate by spec.)
    expect(await oldLink.evaluate((node) => {
      let reached = false;
      const probe = () => { reached = true; };
      document.addEventListener('click', probe, true);
      node.addEventListener('click', (event) => event.preventDefault(), { once: true });
      node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      document.removeEventListener('click', probe, true);
      return { reached, connected: node.isConnected };
    })).toEqual({ reached: false, connected: false });
    const direct = await page.evaluate(async (node) => {
      const host = await import('/client/asset-details-viewer.js');
      return [host.openAssetDetailsComic(document), host.openAssetDetailsComic(document, node)];
    }, oldLink);
    expect(direct).toEqual([0, 0]);
    await page.evaluate(() => new Promise((resolve) => { requestAnimationFrame(() => requestAnimationFrame(resolve)); }));
    await expect(page.locator(DIALOG)).toBeHidden();
    expect(await state(page)).toMatchObject({ open: false, session: null });
    expect(control.manifests(ids.gone)).toHaveLength(1);

    // A second authoritative 404 is idempotent.
    expect(await fileRefresh(page)).toBe('missing');
    await expect(page.locator(COMIC_GONE)).toHaveCount(2);
    await expect(page.locator(COMIC)).toHaveCount(0);
    await expect(page.locator(PREVIEW_IMAGE)).not.toHaveAttribute('src');

    // The record comes back. An older read (sent first) still answering 404
    // after a newer 200 cannot undo the restoration.
    restore();
    const older = await holdNextRefresh(page, ids.gone);
    await page.evaluate(async () => {
      const refreshModule = await import('/client/asset-viewer-refresh.js');
      window.__olderRead = refreshModule.refreshAssetViewer(document, { ...refreshModule.assetViewerIdentity(document), regions: ['file'] })
        .then((result) => result.status);
    });
    await older.ready;
    expect(await fileRefresh(page)).toBe('installed');
    await expect(page.locator(COMIC)).toHaveCount(2);
    await expect(readerLink(page)).toHaveCount(1);
    await expect(page.locator(COMIC_GONE)).toHaveCount(0);
    await older.route().fulfill({ status: 404, contentType: 'text/html', body: 'Not found' });
    expect(await page.evaluate(() => window.__olderRead)).toBe('superseded');
    await older.unroute();
    await expect(readerLink(page)).toHaveCount(1);
    await expect(readerLink(page)).toHaveAttribute('data-comic-source-revision', /.+/);
    await expect(page.locator(PREVIEW_IMAGE)).toHaveAttribute('src', /\/preview\?/);
    await expect(page.locator('[data-asset-comic-preview]')).toHaveAttribute('data-preview-state', 'loaded');
    await expect(page.locator(PREVIEW_IMAGE)).toBeVisible();
    // Restoration revives no session and requests nothing.
    await expect(page.locator(DIALOG)).toBeHidden();
    expect(await state(page)).toMatchObject({ open: false, session: null });
    expect(control.manifests(ids.gone)).toHaveLength(1);

    // The restored link opens a new, valid session.
    await readerLink(page).click();
    await readerReady(page, 'c-issue.cbz');
    expect(control.manifests(ids.gone)).toHaveLength(2);
    await page.keyboard.press('Escape');
    await expect(readerLink(page)).toBeFocused();
    expect(control.mutations).toEqual([`POST /projects/${c.project.id}/assets/${ids.gone}/tags`]);
    expect(control.errors).toEqual([]);
  });

  test('CB7 and CBR activate through the same endpoints; image and video keep their own behavior', async ({ page }, testInfo) => {
    const { ids } = c;
    for (const [assetId, format, filename] of [[ids.cb7, 'CB7', 'd-volume.cb7'], [ids.cbr, 'CBR', 'e-volume.cbr']]) {
      const control = await openDetails(page, assetId);
      await expect(page.locator(COMIC)).toHaveCount(2);
      await expect(readerLink(page)).toHaveCount(1);
      await expect(readerLink(page)).toHaveAttribute('aria-label', `Read comic ${filename}`);
      await expect(page.locator('[data-asset-comic-preview]')).toHaveAttribute('data-comic-format', format.toLowerCase());
      await expect(page.locator('[data-asset-comic-preview]')).not.toContainText(`${format} comic`);
      await expect(page.locator('[data-asset-comic-preview]')).toHaveAttribute('data-preview-state', 'failed');
      await expect(page.locator(PREVIEW_IMAGE)).toBeHidden();
      await expect(readerLink(page)).toHaveAttribute('data-preview-fallback', '');
      await page.waitForTimeout(150);
      expect(control.comic()).toEqual([]);
      await readerLink(page).click();
      await readerReady(page, filename);
      expect(control.manifests(assetId)).toHaveLength(1);
      // These real archive fixtures contain non-image payloads only.
      expect((await state(page)).comic).toMatchObject({ projectId: c.project.id, assetId, pageCount: 0 });
      await expect(page.locator(`${DIALOG} [data-unified-viewer-status]`)).toHaveText('This comic contains no supported pages.');
      await expect(page.locator(SHOWN)).toHaveCount(0);
      expect(control.pages(assetId)).toHaveLength(0);
      await testInfo.attach(`${format.toLowerCase()}-empty-reader`, { body: await page.screenshot(), contentType: 'image/png' });
      await page.keyboard.press('Escape');
      await expect(page.locator(DIALOG)).toBeHidden();
      await expect(readerLink(page)).toBeFocused();
      expect(control.mutations).toEqual([]);
      expect(control.errors).toEqual([]);
    }

    const encrypted = await openDetails(page, ids.encrypted);
    await expect(page.locator('[data-asset-comic-preview]')).toHaveAttribute('data-preview-state', 'failed');
    await expect(readerLink(page)).toHaveCount(1);
    await expect(readerLink(page)).toHaveAttribute('data-preview-fallback', '');
    expect(encrypted.comic()).toEqual([]);
    await readerLink(page).click();
    await expect(page.locator(DIALOG)).toBeVisible();
    await expect.poll(async () => (await state(page)).comic?.state).toBe('failed');
    expect(encrypted.manifests(ids.encrypted)).toHaveLength(1);
    expect(encrypted.pages(ids.encrypted)).toHaveLength(0);
    await testInfo.attach('encrypted-reader-error', { body: await page.screenshot(), contentType: 'image/png' });
    await page.keyboard.press('Escape');
    await expect(readerLink(page)).toBeFocused();
    expect(encrypted.mutations).toEqual([]);
    expect(encrypted.errors).toEqual([]);

    // An image still opens only itself in the image viewer.
    const image = await openDetails(page, ids.image);
    await expect(page.locator(COMIC)).toHaveCount(0);
    await page.locator(LINK).click();
    await expect(page.locator(DIALOG)).toBeVisible();
    await expect.poll(async () => (await state(page)).title).toBe('f-image.png');
    expect((await state(page)).comic).toBeNull();
    await page.keyboard.press('Escape');
    await expect(page.locator(LINK)).toBeFocused();
    expect(image.comic()).toEqual([]);

    // A video keeps its own inline player and never opens the viewer.
    const video = await openDetails(page, ids.video);
    await expect(page.locator('[data-asset-viewer-host] video[data-asset-video]')).toHaveCount(1);
    await expect(page.locator(COMIC)).toHaveCount(0);
    await page.locator('[data-asset-viewer-host] video').dispatchEvent('click');
    await expect(page.locator(DIALOG)).toBeHidden();
    expect(video.comic()).toEqual([]);
    for (const control of [image, video]) {
      expect(control.mutations).toEqual([]);
      expect(control.errors).toEqual([]);
    }
  });
});
