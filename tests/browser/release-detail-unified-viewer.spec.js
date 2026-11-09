import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { build } from 'vite';
import { createApp } from '../../src/app.js';
import { createAssetManifest } from '../../src/asset-manifest.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';
import { createReleaseService } from '../../src/services/release-service.js';

// B7b: Release Detail opens eligible selected image thumbnails in the unified
// viewer (single image only) on the real page with isolated SQLite and
// filesystem data. Viewing never changes the release: saved membership, Role,
// Order, metadata and publication stay as they were and nothing but GETs is
// sent. Authoritative Release Detail refreshes (an Edit Release save, a return
// from the Posting Helper) keep an open session in step with the current
// render. Everything lives in a temporary root removed afterwards.

const DIALOG = '#unified-viewer-dialog';
const VIDEO_DIALOG = '#asset-video-preview-dialog';
const SELECTED = '[data-selected-assets]';
// Saved order: b before a; then a video, a comic, a text file, c, and an
// image that goes missing.
const ORDER = ['02-b.png', '01-a.png', '04-clip.mp4', '05-comic.cbz', '06-notes.txt', '03-c.png', '07-gone.png'];
const IMAGES = ['01-a.png', '02-b.png', '03-c.png'];
const EMPTY_ZIP = Buffer.from([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]);

let server;
let db;
let app;
let root;
let projectsRoot;
let baseURL;
let releaseService;

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-release-detail-viewer-'));
  projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot);
  fs.mkdirSync(appDataRoot);
  const viteDistRoot = path.join(root, 'client');
  await build({ build: { outDir: viteDistRoot, sourcemap: true }, logLevel: 'warn' });
  db = openDatabase(path.join(root, 'test.db'));
  runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
  const { csrfPepper } = ensureAuthEnablement(appDataRoot);
  app = createApp(
    { appName: 'CreatorCrate', db, projectsRoot, previewRoot: path.join(root, 'previews') },
    {
      appDataRoot, authState: { csrfPepper }, assetMode: 'production', viteDistRoot,
      assetManifest: createAssetManifest({ distRoot: viteDistRoot, manifestPath: path.join(viteDistRoot, '.vite', 'manifest.json') }),
    },
  );
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
  releaseService = createReleaseService({ db });
});

test.afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (db) closeDatabase(db);
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

async function writeImage(filePath, shade = 90, size = 40) {
  await sharp({ create: { width: size, height: size, channels: 3, background: { r: shade, g: 90, b: 160 } } })
    .png().toFile(filePath);
}

let releaseCount = 0;
async function createRelease() {
  releaseCount += 1;
  const project = app.locals.projectService.create({ title: `Detail Viewer ${releaseCount}`, status: 'tbd' });
  const dir = path.join(projectsRoot, project.project_dir);
  fs.mkdirSync(dir, { recursive: true });
  for (const [index, filename] of [...IMAGES, '07-gone.png'].entries()) await writeImage(path.join(dir, filename), index * 40);
  fs.writeFileSync(path.join(dir, '04-clip.mp4'), Buffer.from('not really a video'));
  fs.writeFileSync(path.join(dir, '05-comic.cbz'), EMPTY_ZIP);
  fs.writeFileSync(path.join(dir, '06-notes.txt'), 'notes');
  app.locals.assetScanner.scanProjectAssets(project.id);
  const id = (filename) => String(db.prepare('SELECT id FROM assets WHERE project_id = ? AND filename = ?').get(project.id, filename)?.id);
  const release = releaseService.createReleaseWithSelectedAssets(project.id, { title: `Detail Viewer ${releaseCount} Release` },
    ORDER.map((filename) => Number(id(filename))));
  db.prepare('UPDATE release_assets SET role = ? WHERE release_id = ? AND asset_id = ?').run('primary', release.id, Number(id('02-b.png')));
  fs.rmSync(path.join(dir, '07-gone.png'));
  app.locals.assetScanner.scanProjectAssets(project.id);
  return {
    projectId: project.id,
    releaseId: release.id,
    url: `/releases/${release.id}`,
    id,
    async rewrite(filename) {
      await writeImage(path.join(dir, filename), 250, 64);
      app.locals.assetScanner.scanProjectAssets(project.id);
    },
    markMissing(filename) {
      fs.rmSync(path.join(dir, filename), { force: true });
      app.locals.assetScanner.scanProjectAssets(project.id);
    },
    // What a Release Manage Assets save in another tab does to the saved selection.
    unselect(filename) {
      db.prepare('DELETE FROM release_assets WHERE release_id = ? AND asset_id = ?').run(release.id, Number(id(filename)));
    },
    retitle(title) {
      db.prepare('UPDATE releases SET title = ? WHERE id = ?').run(title, release.id);
    },
  };
}

async function open(page, url, { viewport = { width: 1280, height: 900 } } = {}) {
  const control = { mutations: [], errors: [], comic: [] };
  page.on('pageerror', (error) => control.errors.push(error.message));
  page.on('request', (request) => {
    if (request.method() !== 'GET') control.mutations.push(`${request.method()} ${request.url()}`);
    if (/\/comic(\/|$|\?)/.test(new URL(request.url()).pathname)) control.comic.push(request.url());
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
      sourceKey: state.source?.key ?? null,
      mode: state.source?.mode ?? null,
      slideshow: state.source?.slideshow ?? null,
      wrap: state.source?.wrap ?? null,
      titles: state.source ? state.source.items.map((item) => item.title) : [],
      count: state.count,
      mediaUrl: state.item?.mediaUrl ?? null,
      originalUrl: state.item?.originalUrl ?? null,
      detailsUrl: state.item?.detailsUrl ?? null,
      revision: state.item?.revision ?? null,
      media: { status: media.status, width: media.width },
      original: media.original?.status ?? null,
      playback: state.playback,
      fullscreenElement: document.fullscreenElement
        ? (document.fullscreenElement.matches('[data-unified-viewer-card]') ? 'card' : 'other')
        : null,
    };
  });
}

const savedMembership = (releaseId) => db.prepare('SELECT asset_id, role, sort_order FROM release_assets WHERE release_id = ? ORDER BY sort_order')
  .all(releaseId).map((row) => `${row.asset_id}:${row.role}:${row.sort_order}`);
const savedRelease = (releaseId) => db.prepare('SELECT title, published_date, archived_at, updated_at FROM releases WHERE id = ?').get(releaseId);

const thumb = (page, id) => page.locator(`${SELECTED} a[data-release-detail-viewer-trigger][data-viewer-asset="${id}"]`);
const mediaLink = (page, id) => page.locator(`${SELECTED} article[data-asset-id="${id}"] :is(.asset-card-media-link, .asset-list-card-media-link)`);
const card = (page, id) => page.locator(`${SELECTED} article[data-asset-id="${id}"]`);
const title = (page) => page.locator(`${DIALOG} [data-unified-viewer-title]`);
const shownImage = (page) => page.locator(`${DIALOG} [data-unified-viewer-media] img.unified-viewer-image:not([hidden])`);
const presentedOrder = (page) => page.locator(`${SELECTED} article[data-asset-id]`).evaluateAll((nodes) => nodes.map((node) => node.dataset.assetId));
const presentedDetails = (page) => page.locator(`${SELECTED} .release-asset-card-details`).allTextContents();

async function closeViewer(page) {
  await page.locator(`${DIALOG} [data-dialog-close]`).click();
  await expect(page.locator(DIALOG)).toBeHidden();
}

// An acknowledged Edit Release save: Release Detail refreshes in place.
async function editSaved(page, releaseId) {
  await page.evaluate((id) => {
    document.dispatchEvent(new CustomEvent('release-edit-saved', { detail: { releaseId: id } }));
  }, releaseId);
}

// A return from the Posting Helper (armed by a companion launch attempt):
// Release Detail refreshes once, with no dialog and whatever is open.
async function armCompanionReturn(page) {
  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('release-social-prep-companion-settled', { detail: { launchAttempted: true } }));
  });
}
async function returnFromHelper(page) {
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

// Wait until a refresh has replaced the heading region (and so was adopted).
async function markHeading(page) {
  await page.locator('[data-release-detail-region="heading"]').evaluate((node) => { node.dataset.beforeRefresh = 'true'; });
}
async function headingReplaced(page) {
  await expect(page.locator('[data-release-detail-region="heading"]:not([data-before-refresh])')).toHaveCount(1);
  expect(await page.evaluate(() => window.__sameDocument)).toBe(true);
}

test('a Grid thumbnail opens only its image; release state, order, roles and URL survive', async ({ page }) => {
  const f = await createRelease();
  const control = await open(page, f.url);
  const [a, b, c] = ['01-a.png', '02-b.png', '03-c.png'].map(f.id);
  const saved = savedMembership(f.releaseId);
  const release = savedRelease(f.releaseId);
  const order = await presentedOrder(page);
  const details = await presentedDetails(page);
  expect(order).toEqual(ORDER.map(f.id));
  await expect(page.locator(`${SELECTED} [data-release-detail-viewer-trigger]`)).toHaveCount(3);
  await expect(page.locator('[data-release-assets-viewer-trigger]')).toHaveCount(0);

  await thumb(page, a).click();
  await expect(page.locator(DIALOG)).toBeVisible();
  await expect(title(page)).toHaveText('01-a.png');
  await expect(shownImage(page)).toBeVisible();
  await expect.poll(async () => (await viewerState(page)).media).toEqual({ status: 'loaded', width: 40 });
  const state = await viewerState(page);
  expect(state).toMatchObject({
    open: true, mode: 'single', slideshow: false, wrap: false, count: 1, titles: ['01-a.png'],
    sourceKey: `release-detail:${f.releaseId}`,
    originalUrl: `/projects/${f.projectId}/assets/${a}/original`,
    detailsUrl: `/projects/${f.projectId}/assets/${a}`,
    playback: { available: false, playing: false },
  });
  expect(state.mediaUrl.startsWith(`/projects/${f.projectId}/assets/${a}/preview?v=`)).toBe(true);
  // Single image: no Previous/Next, no playback; the view tools stay visible.
  await expect(page.locator(`${DIALOG} [data-unified-viewer-controls]`)).toBeHidden();
  await expect(page.locator(`${DIALOG} [data-unified-viewer-playback]`)).toBeHidden();
  await expect(page.locator(`${DIALOG} [data-unified-viewer-view-tools]`)).toBeVisible();
  await expect(page.locator(`${DIALOG} [data-unified-viewer-details]`)).toHaveAttribute('href', `/projects/${f.projectId}/assets/${a}`);
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');
  const scrollY = await page.evaluate(() => window.scrollY);
  await page.keyboard.press('ArrowRight');
  await expect(title(page)).toHaveText('01-a.png');

  // Fit, zoom and Original Size.
  await page.locator(`${DIALOG} [data-unified-viewer-zoom-in]`).click();
  await expect(page.locator(`${DIALOG} [data-unified-viewer-fit]`)).toBeEnabled();
  await page.locator(`${DIALOG} [data-unified-viewer-fit]`).click();
  await expect(page.locator(`${DIALOG} [data-unified-viewer-zoom-level]`)).toHaveText('Fit');
  await page.locator(`${DIALOG} [data-unified-viewer-original]`).click();
  await expect.poll(async () => (await viewerState(page)).original).toBe('active');

  // Fullscreen: Escape leaves fullscreen first, then closes.
  await page.locator(DIALOG).getByRole('button', { name: 'Enter fullscreen' }).click();
  await expect.poll(async () => (await viewerState(page)).fullscreenElement).toBe('card');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await viewerState(page)).fullscreenElement).toBe(null);
  await expect(page.locator(DIALOG)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(thumb(page, a)).toBeFocused();
  expect(page.url()).toBe(baseURL + f.url);
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);
  await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');

  // Keyboard activation opens it again.
  await page.keyboard.press('Enter');
  await expect(title(page)).toHaveText('01-a.png');
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(thumb(page, a)).toBeFocused();

  // Closing from fullscreen with the close button; a preview-only-free second image.
  await thumb(page, b).click();
  await expect(title(page)).toHaveText('02-b.png');
  await page.locator(DIALOG).getByRole('button', { name: 'Enter fullscreen' }).click();
  await expect.poll(async () => (await viewerState(page)).fullscreenElement).toBe('card');
  await closeViewer(page);
  await expect.poll(async () => (await viewerState(page)).fullscreenElement).toBe(null);
  await expect(thumb(page, b)).toBeFocused();

  // Nothing about the release changed.
  expect(savedMembership(f.releaseId)).toEqual(saved);
  expect(savedRelease(f.releaseId)).toEqual(release);
  expect(await presentedOrder(page)).toEqual(order);
  expect(await presentedDetails(page)).toEqual(details);
  expect((await presentedDetails(page))[0]).toContain('Primary');

  // Release actions work while the viewer is closed: Edit Release and Review & Publish.
  await page.locator(`[data-release-edit-id="${f.releaseId}"]`).click();
  await expect(page.locator('#release-edit-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#release-edit-dialog')).toBeHidden();
  await page.locator('[data-dialog-open="release-publish-dialog"]').click();
  await expect(page.locator('#release-publish-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#release-publish-dialog')).toBeHidden();
  await expect(page.locator(DIALOG)).toBeHidden();

  // A modified click is left to the browser (observed, then stopped here).
  await page.evaluate(() => {
    window.__modifiedClick = null;
    window.addEventListener('click', (event) => {
      window.__modifiedClick = { prevented: event.defaultPrevented };
      event.preventDefault();
    }, { once: true });
  });
  await thumb(page, c).click({ modifiers: ['Control'] });
  expect(await page.evaluate(() => window.__modifiedClick)).toEqual({ prevented: false });
  await expect(page.locator(DIALOG)).toBeHidden();

  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);

  // The filename link and the Details link still navigate.
  await card(page, c).locator('a.asset-file-link').click();
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/projects/${f.projectId}/assets/${c}`);
  await page.goBack();
  await card(page, a).locator('a.asset-details-link').click();
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/projects/${f.projectId}/assets/${a}`);
});

test('List thumbnails open single images; the title information card stays separate', async ({ page }) => {
  const f = await createRelease();
  const control = await open(page, `${f.url}?view=list`);
  const [a, b] = ['01-a.png', '02-b.png'].map(f.id);
  await expect(page.locator(`${SELECTED} .asset-list`)).toHaveCount(1);
  await expect(page.locator(`${SELECTED} [data-release-detail-viewer-trigger]`)).toHaveCount(3);

  // The title opens the information card (Role and Order), never the viewer.
  await card(page, b).locator('[data-calendar-info-trigger]').click();
  const info = page.locator(`#release-asset-list-info-${b}`);
  await expect(info).toBeVisible();
  await expect(info).toContainText('Primary');
  await expect(page.locator(DIALOG)).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(info).toBeHidden();

  await thumb(page, a).click();
  await expect(title(page)).toHaveText('01-a.png');
  expect((await viewerState(page))).toMatchObject({ count: 1, mode: 'single', sourceKey: `release-detail:${f.releaseId}` });
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(thumb(page, a)).toBeFocused();
  expect(new URL(page.url()).searchParams.get('view')).toBe('list');

  // Middle click is left to the browser.
  await page.evaluate(() => {
    window.__auxClick = null;
    window.addEventListener('auxclick', (event) => {
      window.__auxClick = { prevented: event.defaultPrevented };
      event.preventDefault();
    }, { once: true });
  });
  await thumb(page, b).click({ button: 'middle' });
  expect(await page.evaluate(() => window.__auxClick)).toEqual({ prevented: false });
  await expect(page.locator(DIALOG)).toBeHidden();

  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('an open viewer follows authoritative refreshes: metadata-only, revision and stale responses', async ({ page }) => {
  const f = await createRelease();
  const control = await open(page, f.url);
  const a = f.id('01-a.png');
  await armCompanionReturn(page);

  await thumb(page, a).click();
  await expect.poll(async () => (await viewerState(page)).media).toEqual({ status: 'loaded', width: 40 });
  const first = await viewerState(page);
  await page.locator(`${DIALOG} [data-unified-viewer-zoom-in]`).click();
  const zoomed = await page.locator(`${DIALOG} [data-unified-viewer-zoom-level]`).textContent();

  // Metadata only (the release title): the region refresh lands, the image is
  // neither reloaded nor reset.
  const previewRequests = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === `/projects/${f.projectId}/assets/${a}/preview`) previewRequests.push(request.url());
  });
  f.retitle('Renamed Release');
  await markHeading(page);
  await returnFromHelper(page);
  await headingReplaced(page);
  await expect(page.locator('.app-section-title')).toHaveText('Releases — Renamed Release');
  expect(await viewerState(page)).toMatchObject({ open: true, session: first.session, mediaUrl: first.mediaUrl });
  await expect(page.locator(`${DIALOG} [data-unified-viewer-zoom-level]`)).toHaveText(zoomed);
  expect(previewRequests).toEqual([]);

  // A changed file: the refresh reloads the current media in the same session,
  // and the page's trigger carries the current descriptor.
  await f.rewrite('01-a.png');
  await markHeading(page);
  await returnFromHelper(page);
  await headingReplaced(page);
  await expect.poll(async () => (await viewerState(page)).media).toEqual({ status: 'loaded', width: 64 });
  const second = await viewerState(page);
  expect(second.session).toBe(first.session);
  expect(second.revision).not.toBe(first.revision);
  await expect(page.locator(`${DIALOG} [data-unified-viewer-zoom-level]`)).toHaveText('Fit');
  await expect(thumb(page, a)).toHaveAttribute('data-viewer-revision', second.revision);

  // A stale response cannot revive old media: the first refresh is held with
  // an older render while a newer one is adopted, then released.
  const staleHtml = await (await page.request.get(`${baseURL}${f.url}`)).text();
  await f.rewrite('01-a.png');
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  await page.route((url) => url.pathname === f.url, async (route) => {
    calls += 1;
    if (calls === 1) {
      await held;
      await route.fulfill({ status: 200, contentType: 'text/html', body: staleHtml }).catch(() => {});
      return;
    }
    await route.continue();
  });
  await editSaved(page, f.releaseId);
  await expect.poll(() => calls).toBe(1);
  await markHeading(page);
  await editSaved(page, f.releaseId);
  await headingReplaced(page);
  await expect.poll(async () => (await viewerState(page)).revision).not.toBe(second.revision);
  const third = await viewerState(page);
  release();
  await page.waitForTimeout(300);
  expect(await viewerState(page)).toMatchObject({ open: true, session: first.session, revision: third.revision, mediaUrl: third.mediaUrl });
  await expect(thumb(page, a)).toHaveAttribute('data-viewer-revision', third.revision);
  await page.unroute(() => true);

  await closeViewer(page);
  await expect(thumb(page, a)).toBeFocused();
  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('removal from the saved selection, a missing file and a deleted release close the viewer for good', async ({ page }) => {
  const f = await createRelease();
  const control = await open(page, f.url);
  const [a, b, c] = ['01-a.png', '02-b.png', '03-c.png'].map(f.id);
  await armCompanionReturn(page);

  // Removed from the saved selection (another tab saved Manage Assets).
  await thumb(page, a).click();
  await expect(title(page)).toHaveText('01-a.png');
  f.unselect('01-a.png');
  await markHeading(page);
  await returnFromHelper(page);
  await headingReplaced(page);
  await expect(page.locator(DIALOG)).toBeHidden();
  expect((await viewerState(page)).open).toBe(false);
  await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');
  // Its thumbnail is the plain Asset Details link again, never a trigger.
  await expect(thumb(page, a)).toHaveCount(0);
  await expect(mediaLink(page, a)).toHaveAttribute('href', `/projects/${f.projectId}/assets/${a}`);
  await expect(mediaLink(page, a)).toBeFocused();

  // The underlying file went missing: rendered, but no longer an image.
  await thumb(page, b).click();
  await expect(title(page)).toHaveText('02-b.png');
  f.markMissing('02-b.png');
  await markHeading(page);
  await editSaved(page, f.releaseId);
  await headingReplaced(page);
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(thumb(page, b)).toHaveCount(0);

  // Replaced opener: focus returns to the same asset's current trigger.
  await thumb(page, c).click();
  await expect(title(page)).toHaveText('03-c.png');
  await page.locator(`${SELECTED} article[data-asset-id="${c}"]`).evaluate((article) => {
    article.replaceWith(article.cloneNode(true));
  });
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(thumb(page, c)).toBeFocused();
  // A removed opener (whole card gone) falls back to the Grid/List switch.
  await thumb(page, c).click();
  await expect(title(page)).toHaveText('03-c.png');
  await page.locator(`${SELECTED} article[data-asset-id="${c}"]`).evaluate((article) => article.remove());
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(page.locator(`${SELECTED} nav.view-switcher a[aria-current="page"]`)).toBeFocused();
  await page.goto(`${baseURL}${f.url}`);
  await page.evaluate(() => { window.__sameDocument = true; });

  // The release is deleted while its image is open: the page retires, the
  // viewer closes and no trigger remains.
  await thumb(page, c).click();
  await expect(title(page)).toHaveText('03-c.png');
  await page.evaluate(async (id) => {
    const { retireReleaseDetailPage } = await import('/client/release-delete.js');
    retireReleaseDetailPage(document, id, { destination: '/releases' });
  }, f.releaseId);
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(page.locator(`${SELECTED} [data-release-detail-viewer-trigger]`)).toHaveCount(0);
  await expect(page.locator('#main-content')).toBeFocused();
  await editSaved(page, f.releaseId);
  await page.waitForTimeout(300);
  expect((await viewerState(page)).open).toBe(false);

  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('video keeps its player; comics, missing and unsupported files never open the image viewer', async ({ page }) => {
  const f = await createRelease();
  const control = await open(page, f.url);
  const [video, comic, notes, missing] = ['04-clip.mp4', '05-comic.cbz', '06-notes.txt', '07-gone.png'].map(f.id);
  for (const id of [video, comic, notes, missing]) await expect(thumb(page, id)).toHaveCount(0);

  await card(page, video).locator('[data-asset-video-preview-trigger]').click();
  await expect(page.locator(VIDEO_DIALOG)).toBeVisible();
  await expect(page.locator(DIALOG)).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.locator(VIDEO_DIALOG)).toBeHidden();

  for (const id of [comic, notes, missing]) {
    await card(page, id).locator('.asset-card-media').click();
    await expect(page.locator(DIALOG)).toBeHidden();
    await expect(card(page, id).locator('a.asset-details-link')).toHaveAttribute('href', `/projects/${f.projectId}/assets/${id}`);
  }
  expect(new URL(page.url()).pathname).toBe(f.url);
  expect((await viewerState(page)).open).toBe(false);
  expect(control.comic).toEqual([]);
  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('published and archived releases stay read-only; the viewer still opens', async ({ page }) => {
  const f = await createRelease();
  const a = f.id('01-a.png');
  db.prepare("UPDATE releases SET published_date = '2026-01-02' WHERE id = ?").run(f.releaseId);
  const control = await open(page, f.url);
  await expect(page.getByText('This release is published.', { exact: false })).toBeVisible();
  await expect(page.locator(`a[href="/releases/${f.releaseId}/assets"]`)).toHaveCount(0);
  await expect(page.locator('[data-dialog-open="release-publish-dialog"]')).toHaveCount(0);
  await thumb(page, a).click();
  await expect(title(page)).toHaveText('01-a.png');
  await closeViewer(page);
  await expect(thumb(page, a)).toBeFocused();
  expect(savedRelease(f.releaseId).published_date).toBe('2026-01-02');

  db.prepare("UPDATE releases SET archived_at = datetime('now') WHERE id = ?").run(f.releaseId);
  await page.goto(`${baseURL}${f.url}`);
  await expect(page.getByText('This release is archived and read-only.')).toBeVisible();
  await expect(page.locator('[data-release-edit-id]')).toHaveCount(0);
  await thumb(page, a).click();
  await expect(title(page)).toHaveText('01-a.png');
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(page.locator('[data-release-edit-id]')).toHaveCount(0);
  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('narrow 375px viewport: the single image fits and closes back to its thumbnail', async ({ page }) => {
  const f = await createRelease();
  const control = await open(page, `${f.url}?view=list`, { viewport: { width: 375, height: 740 } });
  const c = f.id('03-c.png');
  await thumb(page, c).scrollIntoViewIfNeeded();
  await thumb(page, c).click();
  await expect(shownImage(page)).toBeVisible();
  const box = await page.locator(`${DIALOG} [data-unified-viewer-card]`).boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(375.5);
  await expect(page.locator(`${DIALOG} [data-dialog-close]`)).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await closeViewer(page);
  await expect(thumb(page, c)).toBeFocused();
  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);
});


for (const mode of ['open', 'closed', 'fullscreen']) {
  const opened = mode !== 'closed';
  test(`authoritative 404 retires Release Detail with viewer ${mode}`, async ({ page }) => {
    const f = await createRelease();
    const control = await open(page, f.url);
    const a = f.id('01-a.png');
    const requests = [];
    page.on('request', (request) => requests.push(request.url()));
    await expect(page.locator('script[type="module"][src^="/vite/assets/main-"]')).toHaveCount(1);
    await thumb(page, a).evaluate((node) => {
      window.__oldThumbnail = node;
      window.__cachedThumbnail = node.cloneNode(true);
    });
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let refreshes = 0;
    await page.route((url) => url.pathname === f.url, async (route) => {
      refreshes += 1;
      await held;
      await route.fulfill({ status: 404, contentType: 'text/html', body: 'Release not found' });
    });
    await editSaved(page, f.releaseId);
    await expect.poll(() => refreshes).toBe(1);
    if (opened) {
      await thumb(page, a).click();
      await expect(shownImage(page)).toBeVisible();
      await expect.poll(async () => (await viewerState(page)).media.status).toBe('loaded');
      if (mode === 'fullscreen') {
        await page.locator(DIALOG).getByRole('button', { name: 'Enter fullscreen' }).click();
        await expect.poll(async () => (await viewerState(page)).fullscreenElement).toBe('card');
      }
    } else {
      await page.locator('[data-release-edit-id]').focus();
    }
    release();
    await expect(page.locator(`${SELECTED} [data-release-detail-viewer-trigger]`)).toHaveCount(0);
    await expect(page.locator(DIALOG)).not.toHaveAttribute('open', '');
    expect(await page.locator(DIALOG).evaluate((node) => node.open || node.matches(':modal'))).toBe(false);
    expect(await viewerState(page)).toMatchObject({ open: false, count: 0, media: { status: 'idle' } });
    await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');
    await expect.poll(async () => (await viewerState(page)).fullscreenElement).toBe(null);
    await expect(page.locator(`${DIALOG} img[src]`)).toHaveCount(0);
    if (opened) {
      await expect(page.locator(`${SELECTED} nav.view-switcher a[aria-current="page"]`)).toBeFocused();
      expect(await page.evaluate(() => window.__oldThumbnail.isConnected)).toBe(false);
    } else {
      await expect(page.locator('[data-release-edit-id]')).toBeFocused();
    }
    await expect(page.locator('[data-dialog-feedback-text]')).toHaveText('This release no longer exists.');
    await expect(page.locator('[data-release-detail-refresh-retry]')).toHaveCount(0);
    const before = requests.length;
    // Keep Details navigation in this document while inspecting viewer handling.
    await page.evaluate(() => {
      document.addEventListener('click', (event) => {
        if (event.target.closest('.asset-card-media-link')) {
          window.__retiredClickPrevented = event.defaultPrevented;
          event.preventDefault();
        }
      });
    });
    await mediaLink(page, a).click();
    expect(await page.evaluate(() => window.__retiredClickPrevented)).toBe(false);
    expect(await page.evaluate(async () => {
      const { openReleaseDetailImage, reconcileReleaseDetailViewer } = await import('/client/release-detail-viewer.js');
      const cached = window.__cachedThumbnail;
      // Even a cached descriptor reattached to the selected section is retired.
      document.querySelector('[data-selected-assets]').appendChild(cached);
      const result = [openReleaseDetailImage(document, window.__oldThumbnail), openReleaseDetailImage(document, cached)];
      cached.remove();
      reconcileReleaseDetailViewer(document, document.cloneNode(true));
      return result;
    })).toEqual([0, 0]);
    await editSaved(page, f.releaseId);
    expect(await page.evaluate(async (id) => {
      const { refreshReleaseDetail } = await import('/client/release-detail-refresh.js');
      return refreshReleaseDetail(document, id);
    }, f.releaseId)).toBe('superseded');
    await expect(page.locator(`${SELECTED} [data-release-detail-viewer-trigger]`)).toHaveCount(0);
    expect((await viewerState(page)).open).toBe(false);
    expect(requests.slice(before).filter((url) => /\/assets\/[^/]+\/(preview|original)/.test(url))).toEqual([]);
    expect(refreshes).toBe(1);
    await expect(mediaLink(page, a)).toHaveAttribute('href', `/projects/${f.projectId}/assets/${a}`);
    expect(control.mutations).toEqual([]);
    expect(control.errors).toEqual([]);
  });
}

test('a superseded held 404 cannot retire a newer valid Release Detail session', async ({ page }) => {
  const f = await createRelease();
  const control = await open(page, f.url);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  let finished;
  const handled = new Promise((resolve) => { finished = resolve; });
  await page.route((url) => url.pathname === f.url, async (route) => {
    calls += 1;
    if (calls === 1) {
      await held;
      await route.fulfill({ status: 404, contentType: 'text/html', body: 'Old missing response' }).catch(() => {});
      finished();
    } else await route.continue();
  });
  await editSaved(page, f.releaseId);
  await expect.poll(() => calls).toBe(1);
  await markHeading(page);
  await editSaved(page, f.releaseId);
  await headingReplaced(page);
  await thumb(page, f.id('02-b.png')).click();
  const session = (await viewerState(page)).session;
  release();
  await handled;
  expect(await page.evaluate(async () => {
    await document.__creatorCrateReleaseDetailRefresh.current;
    return document.__creatorCrateReleaseDetailRefresh.retired === true;
  })).toBe(false);
  expect(await viewerState(page)).toMatchObject({ open: true, session });
  expect(await page.locator(DIALOG).evaluate((node) => node.open && node.matches(':modal'))).toBe(true);
  await expect(thumb(page, f.id('02-b.png'))).toHaveCount(1);
  await closeViewer(page);
  await expect(thumb(page, f.id('02-b.png'))).toBeFocused();
  expect(control.errors).toEqual([]);
});


test('authoritative 404 keeps another active modal and its focus ownership', async ({ page }) => {
  const f = await createRelease();
  const control = await open(page, f.url);
  await thumb(page, f.id('01-a.png')).click();
  await expect(shownImage(page)).toBeVisible();
  await page.evaluate(async () => {
    const { openAppDialogById } = await import('/client/app-dialogs.js');
    openAppDialogById(document, 'release-edit-dialog');
    window.__otherModalFocus = document.activeElement;
  });
  const edit = page.locator('#release-edit-dialog');
  await expect(edit).toBeVisible();
  await page.route((url) => url.pathname === f.url, (route) => route.fulfill({
    status: 404, contentType: 'text/html', body: 'Release not found',
  }));
  await editSaved(page, f.releaseId);
  await expect(page.locator(`${SELECTED} [data-release-detail-viewer-trigger]`)).toHaveCount(0);
  expect((await viewerState(page)).open).toBe(false);
  expect(await edit.evaluate((node) => node.open && node.matches(':modal'))).toBe(true);
  await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');
  expect(await page.evaluate(() => document.activeElement === window.__otherModalFocus
    && document.querySelector('#release-edit-dialog').contains(document.activeElement))).toBe(true);
  expect(control.errors).toEqual([]);
});
