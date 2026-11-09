import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import yazl from 'yazl';
import { createApp } from '../../src/app.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';

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
  // No viewer Previous/Next, slideshow or self-referencing View details.
  await expect(page.locator(`${DIALOG} [data-unified-viewer-controls]`)).toBeHidden();
  await expect(page.locator(`${DIALOG} [data-unified-viewer-playback]`)).toBeHidden();
  await expect(page.locator(`${DIALOG} [data-unified-viewer-details]`)).toBeHidden();
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
  expect(comic.requests.some((request) => /comic|manifest/.test(request))).toBe(false);

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
