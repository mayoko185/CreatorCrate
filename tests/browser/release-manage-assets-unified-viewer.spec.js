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

// Release Manage Assets opens eligible image thumbnails in the unified
// viewer (single image only) on the real page with isolated SQLite and
// filesystem data. The viewer is presentation-only: draft membership, saved
// Roles and Order, filters, pagination and Grid/List stay exactly as they
// were, and nothing but GETs is sent. Everything lives in a temporary root
// removed afterwards.

const DIALOG = '#unified-viewer-dialog';
const VIDEO_DIALOG = '#asset-video-preview-dialog';
const REGION = '[data-release-assets-live-region]';
const IMAGES = ['01-a.png', '02-b.png', '03-c.png', '04-d.png', '05-e.png', '06-f.png'];
const SELECTED = ['01-a.png', '02-b.png', '07-clip.mp4', '09-gone.png'];
// An empty but valid ZIP: indexed as a CBZ comic.
const EMPTY_ZIP = Buffer.from([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]);

let server;
let db;
let app;
let root;
let projectsRoot;
let baseURL;
let releaseService;

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-release-manage-viewer-'));
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

// A draft release selecting two images, a (fake) video and an image that goes
// missing, with the first image as Primary; the other files are candidates.
let releaseCount = 0;
async function createRelease({ extraImages = 0 } = {}) {
  releaseCount += 1;
  const project = app.locals.projectService.create({ title: `Manage Viewer ${releaseCount}`, status: 'tbd' });
  const dir = path.join(projectsRoot, project.project_dir);
  fs.mkdirSync(dir, { recursive: true });
  for (const [index, filename] of [...IMAGES, '09-gone.png'].entries()) await writeImage(path.join(dir, filename), index * 30);
  for (let index = 1; index <= extraImages; index += 1) await writeImage(path.join(dir, `x-${String(index).padStart(2, '0')}.png`), 200);
  fs.writeFileSync(path.join(dir, '07-clip.mp4'), Buffer.from('not really a video'));
  fs.writeFileSync(path.join(dir, '08-comic.cbz'), EMPTY_ZIP);
  app.locals.assetScanner.scanProjectAssets(project.id);
  const id = (filename) => String(db.prepare('SELECT id FROM assets WHERE project_id = ? AND filename = ?').get(project.id, filename)?.id);
  const release = releaseService.createReleaseWithSelectedAssets(project.id, { title: `Manage Viewer ${releaseCount} Release` },
    SELECTED.map((filename) => Number(id(filename))));
  db.prepare('UPDATE release_assets SET role = ? WHERE release_id = ? AND asset_id = ?').run('primary', release.id, Number(id('01-a.png')));
  fs.rmSync(path.join(dir, '09-gone.png'));
  app.locals.assetScanner.scanProjectAssets(project.id);
  return {
    projectId: project.id,
    releaseId: release.id,
    url: `/releases/${release.id}/assets`,
    id,
    async addImage(filename) {
      await writeImage(path.join(dir, filename));
      app.locals.assetScanner.scanProjectAssets(project.id);
    },
    async rewrite(filename) {
      await writeImage(path.join(dir, filename), 250, 64);
      app.locals.assetScanner.scanProjectAssets(project.id);
    },
    markMissing(filename) {
      fs.rmSync(path.join(dir, filename), { force: true });
      app.locals.assetScanner.scanProjectAssets(project.id);
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
      media: { status: media.status, width: media.width },
      original: media.original?.status ?? null,
      playback: state.playback,
      fullscreenElement: document.fullscreenElement
        ? (document.fullscreenElement.matches('[data-unified-viewer-card]') ? 'card' : 'other')
        : null,
    };
  });
}

// The membership the Save form would submit: visible checkboxes plus the
// hidden off-page inputs.
const draftMembership = (page) => page.evaluate(() => {
  const ids = new Set();
  document.querySelectorAll('[data-release-assets-hidden-membership] input[name="selectedAssetIds"]')
    .forEach((input) => ids.add(input.value));
  document.querySelectorAll('[data-release-assets-live-region] input[name="selectedAssetIds"]:checked')
    .forEach((input) => ids.add(input.value));
  return [...ids].sort();
});
const savedMembership = (releaseId) => db.prepare('SELECT asset_id, role, sort_order FROM release_assets WHERE release_id = ? ORDER BY asset_id')
  .all(releaseId).map((row) => `${row.asset_id}:${row.role}:${row.sort_order}`);
const sorted = (values) => [...values].sort();

const thumb = (page, id) => page.locator(`${REGION} a[data-release-assets-viewer-trigger][data-viewer-asset="${id}"]`);
const card = (page, id) => page.locator(`${REGION} article[data-asset-id="${id}"]`);
const checkbox = (page, id) => page.locator(`${REGION} input[name="selectedAssetIds"][value="${id}"]`);
const title = (page) => page.locator(`${DIALOG} [data-unified-viewer-title]`);
const shownImage = (page) => page.locator(`${DIALOG} [data-unified-viewer-media] img.unified-viewer-image:not([hidden])`);
const currentSwitch = (page) => page.locator(`${REGION} nav.view-switcher a[aria-current="page"]`);

// A real Release Manage Assets live refresh of the current (or a replaced)
// URL through the engine's own Back/Forward path.
async function liveRefresh(page, nextUrl = null) {
  await page.locator(REGION).evaluate((node) => { node.dataset.beforeRefresh = 'true'; });
  await page.evaluate((next) => {
    if (next) window.history.replaceState({ releaseAssets: true }, '', next);
    window.dispatchEvent(new PopStateEvent('popstate', { state: { releaseAssets: true } }));
  }, nextUrl);
  await expect(page.locator(`${REGION}:not([data-before-refresh])`)).toHaveCount(1);
  await expect(page.locator(REGION)).not.toHaveAttribute('aria-busy', 'true');
  expect(await page.evaluate(() => window.__sameDocument)).toBe(true);
}

async function closeViewer(page) {
  await page.locator(`${DIALOG} [data-dialog-close]`).click();
  await expect(page.locator(DIALOG)).toBeHidden();
}

test('a Grid thumbnail opens only its image; drafts, Role, Order and URL survive', async ({ page }) => {
  const f = await createRelease();
  const url = `${f.url}?selection=all&view=grid&pageSize=all`;
  const control = await open(page, url);
  const [a, b, c, e] = ['01-a.png', '02-b.png', '03-c.png', '05-e.png'].map(f.id);
  const saved = savedMembership(f.releaseId);

  // Unsaved drafts: add 03, remove 02 (checkbox labels, the reviewed path).
  await page.locator(`label[for="release-asset-select-${c}"]`).click();
  await page.locator(`label[for="release-asset-select-${b}"]`).click();
  const draft = await draftMembership(page);
  expect(draft).toContain(c);
  expect(draft).not.toContain(b);
  const roleSelect = card(page, a).locator('select[name="role"]');
  await expect(roleSelect).toHaveValue('primary');

  // The image info card still opens on hover.
  await thumb(page, e).hover();
  await expect(card(page, e).locator('[data-asset-info-card]')).toBeVisible();

  await thumb(page, e).click();
  await expect(page.locator(DIALOG)).toBeVisible();
  await expect(title(page)).toHaveText('05-e.png');
  await expect(shownImage(page)).toBeVisible();
  await expect.poll(async () => (await viewerState(page)).media).toEqual({ status: 'loaded', width: 40 });
  const state = await viewerState(page);
  expect(state).toMatchObject({
    open: true, mode: 'single', slideshow: false, wrap: false, count: 1, titles: ['05-e.png'],
    sourceKey: `release-assets:${f.releaseId}`,
    originalUrl: `/projects/${f.projectId}/assets/${e}/original`,
    detailsUrl: `/projects/${f.projectId}/assets/${e}`,
    playback: { available: false, playing: false },
  });
  expect(state.mediaUrl.startsWith(`/projects/${f.projectId}/assets/${e}/preview?v=`)).toBe(true);
  // No Previous/Next or playback; controls stay visible in dialog mode.
  await expect(page.locator(`${DIALOG} [data-unified-viewer-controls]`)).toBeHidden();
  await expect(page.locator(`${DIALOG} [data-unified-viewer-playback]`)).toBeHidden();
  await expect(page.locator(`${DIALOG} [data-unified-viewer-view-tools]`)).toBeVisible();
  await expect(page.locator(`${DIALOG} [data-unified-viewer-details]`)).toHaveAttribute('href', `/projects/${f.projectId}/assets/${e}`);
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');
  // Measured with the viewer open: the click itself may scroll the card in.
  const scrollY = await page.evaluate(() => window.scrollY);
  await page.keyboard.press('ArrowRight');
  await expect(title(page)).toHaveText('05-e.png');

  // Fit, zoom and Original Size (B3).
  await page.locator(`${DIALOG} [data-unified-viewer-zoom-in]`).click();
  await expect(page.locator(`${DIALOG} [data-unified-viewer-fit]`)).toBeEnabled();
  await page.locator(`${DIALOG} [data-unified-viewer-fit]`).click();
  await expect(page.locator(`${DIALOG} [data-unified-viewer-zoom-level]`)).toHaveText('Fit');
  await page.locator(`${DIALOG} [data-unified-viewer-original]`).click();
  await expect.poll(async () => (await viewerState(page)).original).toBe('active');

  // Fullscreen (B4): Escape leaves fullscreen first, then closes.
  await page.locator(DIALOG).getByRole('button', { name: 'Enter fullscreen' }).click();
  await expect.poll(async () => (await viewerState(page)).fullscreenElement).toBe('card');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await viewerState(page)).fullscreenElement).toBe(null);
  await expect(page.locator(DIALOG)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(thumb(page, e)).toBeFocused();
  expect(page.url()).toBe(baseURL + url);
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);
  await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');

  // Keyboard activation opens the image without toggling the card.
  await page.keyboard.press('Enter');
  await expect(page.locator(DIALOG)).toBeVisible();
  await expect(title(page)).toHaveText('05-e.png');
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(thumb(page, e)).toBeFocused();

  // Closing from fullscreen with the close button.
  await thumb(page, a).click();
  await expect(title(page)).toHaveText('01-a.png');
  await page.locator(DIALOG).getByRole('button', { name: 'Enter fullscreen' }).click();
  await expect.poll(async () => (await viewerState(page)).fullscreenElement).toBe('card');
  await closeViewer(page);
  await expect.poll(async () => (await viewerState(page)).fullscreenElement).toBe(null);
  await expect(thumb(page, a)).toBeFocused();

  // Everything the editor owns is untouched.
  expect(await draftMembership(page)).toEqual(draft);
  await expect(checkbox(page, e)).not.toBeChecked();
  await expect(checkbox(page, a)).toBeChecked();
  await expect(card(page, e)).toHaveAttribute('aria-selected', 'false');
  await expect(roleSelect).toHaveValue('primary');
  expect(savedMembership(f.releaseId)).toEqual(saved);

  // A modified click is left to the browser (observed, then stopped here).
  await page.evaluate(() => {
    window.__modifiedClick = null;
    window.addEventListener('click', (event) => {
      window.__modifiedClick = { prevented: event.defaultPrevented };
      event.preventDefault();
    }, { once: true });
  });
  // The image information card opens on focus and hover (the restored focus
  // is on this thumbnail): blur, move away, and press the thumbnail's corner
  // so the click lands on the link itself.
  await page.evaluate(() => document.activeElement?.blur());
  await page.mouse.move(1270, 4, { steps: 3 });
  await expect(page.locator('[data-asset-info-card][data-info-card-open="true"]')).toHaveCount(0);
  await thumb(page, e).click({ modifiers: ['Control'], position: { x: 4, y: 4 } });
  expect(await page.evaluate(() => window.__modifiedClick)).toEqual({ prevented: false });
  await expect(page.locator(DIALOG)).toBeHidden();

  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);

  // The explicit Details link still navigates (the pointer leaves the last
  // hovered thumbnail first, so its information card closes).
  await page.mouse.move(1270, 4, { steps: 3 });
  await expect(page.locator('[data-asset-info-card][data-info-card-open="true"]')).toHaveCount(0);
  await card(page, e).locator('a.asset-details-link').click();
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/projects/${f.projectId}/assets/${e}`);
});

test('List thumbnails open single images; filtering, pagination and Grid/List keep drafts', async ({ page }) => {
  const f = await createRelease({ extraImages: 6 });
  const url = `${f.url}?selection=all&view=list&pageSize=10`;
  const control = await open(page, url);
  const [a, b, d, f6] = ['01-a.png', '02-b.png', '04-d.png', '06-f.png'].map(f.id);
  const saved = savedMembership(f.releaseId);
  const orderBefore = await card(page, a).locator('.asset-list-cell--order').textContent();

  await page.locator(`label[for="release-asset-select-${d}"]`).click();
  await page.locator(`label[for="release-asset-select-${b}"]`).click();
  const draft = await draftMembership(page);

  // The list title information card still works beside the trigger.
  const titleTrigger = card(page, f6).locator('[data-calendar-info-trigger]');
  await titleTrigger.hover();
  await expect(page.locator(`#release-manage-asset-list-info-${f6}`)).toBeVisible();
  await page.mouse.move(1270, 4, { steps: 3 });

  await thumb(page, f6).click();
  await expect(title(page)).toHaveText('06-f.png');
  expect(await viewerState(page)).toMatchObject({ mode: 'single', count: 1, slideshow: false });
  await closeViewer(page);
  await expect(thumb(page, f6)).toBeFocused();
  expect(await draftMembership(page)).toEqual(draft);

  // Narrow the visible subset: the drafted 04 leaves the page but stays in
  // the draft (hidden input); 01 is still shown.
  await page.getByRole('link', { name: 'Filter assets' }).click();
  await page.locator('#asset-search').fill('01-a');
  await expect.poll(() => new URL(page.url()).searchParams.get('search') || '').toBe('01-a');
  await page.keyboard.press('Escape');
  await expect(card(page, d)).toHaveCount(0);
  expect(await draftMembership(page)).toEqual(draft);
  await thumb(page, a).click();
  await expect(title(page)).toHaveText('01-a.png');
  await closeViewer(page);
  expect(await draftMembership(page)).toEqual(draft);
  expect(new URL(page.url()).searchParams.get('search')).toBe('01-a');

  // Clear the filter and switch to Grid (live): drafts restored on the cards.
  await page.getByRole('link', { name: 'Filter assets' }).click();
  await page.locator('#asset-search').fill('');
  await expect.poll(() => new URL(page.url()).searchParams.get('search')).toBe(null);
  await page.keyboard.press('Escape');
  await page.locator(`${REGION} nav.view-switcher a[aria-label="Grid view"]`).click();
  await expect(page.locator(`${REGION} ul.asset-grid`)).toHaveCount(1);
  await expect(checkbox(page, d)).toBeChecked();
  await expect(checkbox(page, b)).not.toBeChecked();
  await thumb(page, d).click();
  await expect(title(page)).toHaveText('04-d.png');
  await closeViewer(page);
  await expect(checkbox(page, d)).toBeChecked();

  // Pagination (live Next/Previous): drafts on the other page are carried in
  // hidden inputs, and a page-2 image opens alone.
  await page.locator(`${REGION} nav.view-switcher a[aria-label="List view"]`).click();
  await expect(page.locator(`${REGION} ul.asset-list`)).toHaveCount(1);
  await expect(page.locator(`${REGION} .pagination-info`)).toHaveText('Page 1 of 2');
  await page.locator(`${REGION} .pagination-next`).click();
  await expect(page.locator(`${REGION} .pagination-info`)).toHaveText('Page 2 of 2');
  expect(await page.evaluate(() => window.__sameDocument)).toBe(true);
  expect(await draftMembership(page)).toEqual(draft);
  const onPageTwo = await page.locator(`${REGION} a[data-release-assets-viewer-trigger]`).first();
  const pageTwoName = await onPageTwo.getAttribute('data-viewer-filename');
  await onPageTwo.click();
  await expect(title(page)).toHaveText(pageTwoName);
  expect(await viewerState(page)).toMatchObject({ mode: 'single', count: 1 });
  await closeViewer(page);
  expect(await draftMembership(page)).toEqual(draft);
  await page.locator(`${REGION} .pagination-prev`).click();
  await expect(page.locator(`${REGION} .pagination-info`)).toHaveText('Page 1 of 2');
  await expect(checkbox(page, d)).toBeChecked();
  await expect(checkbox(page, b)).not.toBeChecked();
  expect(await draftMembership(page)).toEqual(draft);
  await expect(card(page, a).locator('.asset-list-cell--order')).toHaveText(orderBefore);
  await expect(card(page, a).locator('select[name="role"]')).toHaveValue('primary');

  expect(savedMembership(f.releaseId)).toEqual(saved);
  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('Saved-selection filter hides unselected assets; hidden drafts survive open/close and paging', async ({ page }) => {
  const f = await createRelease();
  const control = await open(page, `${f.url}?selection=all&view=grid&pageSize=10`);
  const [a, c] = ['01-a.png', '03-c.png'].map(f.id);
  await page.locator(`label[for="release-asset-select-${c}"]`).click();
  const draft = await draftMembership(page);

  // Selected-only view: the unsaved 03 is hidden but stays in the draft.
  await thumb(page, c).click();
  await expect.poll(async () => (await viewerState(page)).media.status).toBe('loaded');
  const session = (await viewerState(page)).session;
  await liveRefresh(page, `${f.url}?view=grid&pageSize=10`);
  await expect(page.locator('[data-release-assets-selection-notice]')).toBeVisible();
  await expect(card(page, c)).toHaveCount(0);
  expect(await viewerState(page)).toMatchObject({ open: true, session, key: `p:${f.projectId}|a:${c}` });
  await closeViewer(page);
  await expect(currentSwitch(page)).toBeFocused();
  expect(await draftMembership(page)).toEqual(draft);
  await thumb(page, a).click();
  await expect(title(page)).toHaveText('01-a.png');
  await closeViewer(page);
  expect(await draftMembership(page)).toEqual(draft);
  expect(control.mutations).toEqual([]);

  // Save stays authoritative and is the only mutation.
  await page.getByRole('button', { name: 'Save asset selection' }).click();
  await expect.poll(() => savedMembership(f.releaseId).map((value) => value.split(':')[0]).sort())
    .toEqual(sorted(draft));
  expect(control.mutations.every((request) => request.startsWith('POST ') && request.includes(`/releases/${f.releaseId}/assets`))).toBe(true);
  expect(control.errors).toEqual([]);
});

test('an open viewer follows current refreshes: revision, filtered-away, ineligible and delayed', async ({ page }) => {
  const f = await createRelease();
  const url = `${f.url}?selection=all&view=grid&pageSize=all`;
  const control = await open(page, url);
  const [c, d, e] = ['03-c.png', '04-d.png', '05-e.png'].map(f.id);
  await page.locator(`label[for="release-asset-select-${c}"]`).click();
  const draft = await draftMembership(page);

  await thumb(page, e).click();
  await expect.poll(async () => (await viewerState(page)).media).toEqual({ status: 'loaded', width: 40 });
  const { session, mediaUrl: before } = await viewerState(page);

  // An unchanged refresh keeps the session and the loaded image.
  await liveRefresh(page);
  expect(await viewerState(page)).toMatchObject({ open: true, session, mediaUrl: before });

  // A changed revision reloads the kept image in the same session.
  await f.rewrite('05-e.png');
  await liveRefresh(page);
  await expect.poll(async () => (await viewerState(page)).mediaUrl).not.toBe(before);
  expect((await viewerState(page)).session).toBe(session);
  await expect.poll(async () => (await viewerState(page)).media).toEqual({ status: 'loaded', width: 64 });
  await expect(shownImage(page)).toHaveCount(1);
  expect(await draftMembership(page)).toEqual(draft);

  // Filtered off the visible page: no evidence about the asset, so the
  // session stays; closing returns focus to the release workspace.
  await liveRefresh(page, `${f.url}?selection=all&view=grid&pageSize=all&search=01-a`);
  await expect(thumb(page, e)).toHaveCount(0);
  expect(await viewerState(page)).toMatchObject({ open: true, session });
  await closeViewer(page);
  await expect(currentSwitch(page)).toBeFocused();
  expect(await draftMembership(page)).toEqual(draft);

  // A missing unselected candidate leaves the results entirely. The page
  // cannot distinguish this absence from pagination or filtering.
  await liveRefresh(page, url);
  await thumb(page, d).click();
  await expect(title(page)).toHaveText('04-d.png');
  f.markMissing('04-d.png');
  await liveRefresh(page);
  await expect(card(page, d)).toHaveCount(0);
  await expect(page.locator(DIALOG)).toBeVisible();
  await closeViewer(page);
  await expect(currentSwitch(page)).toBeFocused();

  // A saved selection that goes missing stays listed, without a trigger.
  const b = f.id('02-b.png');
  await thumb(page, b).click();
  await expect(title(page)).toHaveText('02-b.png');
  f.markMissing('02-b.png');
  await liveRefresh(page);
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(card(page, b)).toHaveCount(1);
  await expect(thumb(page, b)).toHaveCount(0);
  await expect(currentSwitch(page)).toBeFocused();
  expect(await draftMembership(page)).toEqual(draft);

  // A refresh that was already in flight when the viewer opened lands while
  // it is open; a newer response supersedes an older one.
  const first = f.id('01-a.png');
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let heldCount = 0;
  await page.route((requestUrl) => requestUrl.pathname === f.url && requestUrl.searchParams.get('pageSize') === 'all', async (route) => {
    heldCount += 1;
    if (heldCount === 1) await held;
    await route.continue();
  });
  await page.evaluate(() => window.dispatchEvent(new PopStateEvent('popstate', { state: { releaseAssets: true } })));
  await expect(page.locator(REGION)).toHaveAttribute('aria-busy', 'true');
  await thumb(page, first).click();
  await expect(title(page)).toHaveText('01-a.png');
  const opened = (await viewerState(page)).session;
  await f.rewrite('01-a.png');
  release();
  await expect(page.locator(REGION)).not.toHaveAttribute('aria-busy', 'true');
  await expect.poll(async () => (await viewerState(page)).media).toEqual({ status: 'loaded', width: 64 });
  expect((await viewerState(page)).session).toBe(opened);
  await closeViewer(page);
  await expect(thumb(page, first)).toBeFocused();
  await page.unroute(() => true);

  expect(await draftMembership(page)).toEqual(draft);
  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('same-query pagination displacement preserves media, session, drafts and connected close focus', async ({ page, request }) => {
  const f = await createRelease({ extraImages: 8 });
  const url = `${f.url}?selection=all&view=list&pageSize=10&page=1`;
  const control = await open(page, url);
  await expect(page.locator('script[type="module"][src^="/vite/"]')).toHaveCount(1);
  await expect(page.locator(`${REGION} .pagination-info`)).toHaveText('Page 1 of 2');
  const [b, c] = ['02-b.png', '03-c.png'].map(f.id);
  await page.locator(`label[for="release-asset-select-${c}"]`).click();
  await page.locator(`label[for="release-asset-select-${b}"]`).click();
  const draft = await draftMembership(page);
  const saved = savedMembership(f.releaseId);
  // The last image on page 1 is displaced by a new earlier filename.
  const opener = page.locator(`${REGION} [data-release-assets-viewer-trigger]`).last();
  const id = await opener.getAttribute('data-viewer-asset');
  const filename = await opener.getAttribute('data-viewer-filename');
  await opener.click();
  await expect(shownImage(page)).toBeVisible();
  await expect.poll(async () => (await viewerState(page)).media.status).toBe('loaded');
  const before = await viewerState(page);
  await page.evaluate(() => {
    const viewer = document.querySelector('#unified-viewer-dialog').__creatorCrateUnifiedViewer;
    window.__paginationSource = viewer.getState().source;
    window.__paginationImage = document.querySelector('#unified-viewer-dialog img.unified-viewer-image:not([hidden])');
    window.__paginationChanges = [];
    viewer.observe((change) => window.__paginationChanges.push({ type: change.type, reload: change.reload }));
  });
  const mediaRequests = [];
  page.on('request', (req) => {
    if (new URL(req.url()).pathname === `/projects/${f.projectId}/assets/${id}/preview`) mediaRequests.push(req.url());
  });

  await f.addImage('00-earlier.png');
  await liveRefresh(page);
  await expect(card(page, id)).toHaveCount(0);
  // A separate server-rendered page proves the image is still eligible on
  // page 2 without changing the active browser's URL or pagination state.
  const page2Url = new URL(baseURL + url);
  page2Url.searchParams.set('page', '2');
  const response = await request.get(page2Url.href);
  expect(response.ok()).toBe(true);
  const html = await response.text();
  expect(html).toContain(`data-viewer-asset="${id}"`);
  expect(db.prepare('SELECT is_present FROM assets WHERE id = ?').get(id).is_present).toBe(1);
  expect(await viewerState(page)).toEqual(before);
  await expect(title(page)).toHaveText(filename);
  expect(await page.evaluate(() => ({
    source: document.querySelector('#unified-viewer-dialog').__creatorCrateUnifiedViewer.getState().source === window.__paginationSource,
    image: document.querySelector('#unified-viewer-dialog img.unified-viewer-image:not([hidden])') === window.__paginationImage,
    changes: window.__paginationChanges,
  }))).toEqual({ source: true, image: true, changes: [] });
  expect(mediaRequests).toEqual([]);
  expect(await draftMembership(page)).toEqual(draft);
  await closeViewer(page);
  await expect(currentSwitch(page)).toBeFocused();
  expect(await page.evaluate(() => document.activeElement.isConnected)).toBe(true);
  await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');
  expect(page.url()).toBe(baseURL + url);
  await expect(page.locator(`${REGION} .pagination-info`)).toHaveText('Page 1 of 2');
  expect(await draftMembership(page)).toEqual(draft);
  expect(savedMembership(f.releaseId)).toEqual(saved);
  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('retained older responses cannot restore media or change closed, replaced or foreign sessions', async ({ page }) => {
  const f = await createRelease();
  const url = `${f.url}?selection=all&view=grid&pageSize=all`;
  const control = await open(page, url);
  const [d, e] = ['04-d.png', '05-e.png'].map(f.id);
  await thumb(page, e).click();
  await expect.poll(async () => (await viewerState(page)).media.status).toBe('loaded');

  async function retainRefresh() {
    await page.evaluate(async (path) => {
      const originalFetch = window.fetch;
      window.__heldReady = false;
      window.__heldDelivered = false;
      const held = new Promise((resolve) => { window.__releaseHeld = resolve; });
      window.fetch = async (...args) => {
        if (new URL(args[0], location.href).pathname !== path) return originalFetch(...args);
        window.fetch = originalFetch;
        const response = await originalFetch(...args);
        const html = await response.text();
        // Retain an actual server response even if its request is later
        // aborted, so generation checks must reject the obsolete body.
        return { ok: response.ok, url: response.url, text: async () => {
          window.__heldReady = true;
          await held;
          window.__heldDelivered = true;
          return html;
        } };
      };
      window.dispatchEvent(new PopStateEvent('popstate', { state: { releaseAssets: true } }));
    }, f.url);
    await expect.poll(() => page.evaluate(() => window.__heldReady)).toBe(true);
  }

  async function deliverRetained() {
    await page.evaluate(async () => {
      window.__releaseHeld();
      // Drain the engine's promise callbacks before inspecting its result.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(await page.evaluate(() => window.__heldDelivered)).toBe(true);
  }

  await retainRefresh();
  await f.rewrite('05-e.png');
  await liveRefresh(page);
  await expect.poll(async () => (await viewerState(page)).media).toEqual({ status: 'loaded', width: 64 });
  const current = await viewerState(page);
  await deliverRetained();
  expect(await viewerState(page)).toEqual(current);

  await retainRefresh();
  await closeViewer(page);
  await deliverRetained();
  expect((await viewerState(page)).open).toBe(false);

  await thumb(page, e).click();
  await retainRefresh();
  await closeViewer(page);
  await thumb(page, d).click();
  await expect.poll(async () => (await viewerState(page)).media.status).toBe('loaded');
  const replacement = await viewerState(page);
  expect(replacement.session).not.toBe(current.session);
  await deliverRetained();
  expect(await viewerState(page)).toEqual(replacement);

  await retainRefresh();
  // The shared controller can be owned by a different host while a Manage
  // Assets response is pending. Its source and session must stay untouched.
  await page.evaluate(() => {
    const viewer = document.querySelector('#unified-viewer-dialog').__creatorCrateUnifiedViewer;
    const state = viewer.getState();
    viewer.open({ ...state.source, key: 'release-detail:other-release' });
  });
  await expect.poll(async () => (await viewerState(page)).media.status).toBe('loaded');
  const foreign = await viewerState(page);
  await deliverRetained();
  expect(await viewerState(page)).toEqual(foreign);
  await closeViewer(page);

  await thumb(page, e).click();
  await expect.poll(async () => (await viewerState(page)).media.status).toBe('loaded');
  const own = await viewerState(page);
  const other = await createRelease();
  const redirect = (requestUrl) => requestUrl.pathname === f.url;
  await page.route(redirect, (route) => route.fulfill({ status: 302, headers: { location: other.url } }));
  await page.evaluate(() => window.dispatchEvent(new PopStateEvent('popstate', { state: { releaseAssets: true } })));
  await expect(page.locator('[data-live-filter-failure]')).toBeVisible();
  await expect(page.locator(REGION)).not.toHaveAttribute('aria-busy', 'true');
  expect(await viewerState(page)).toEqual(own);
  await page.unroute(redirect);
  await closeViewer(page);
  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('video keeps its player; comics, missing and unsupported files never open the image viewer', async ({ page }) => {
  const f = await createRelease();
  const control = await open(page, `${f.url}?selection=all&view=grid&pageSize=all`);
  const [video, comic, missing] = ['07-clip.mp4', '08-comic.cbz', '09-gone.png'].map(f.id);

  await expect(page.locator(`${REGION} [data-release-assets-viewer-trigger]`)).toHaveCount(IMAGES.length);
  for (const id of [video, comic, missing]) await expect(thumb(page, id)).toHaveCount(0);

  await card(page, video).locator('[data-asset-video-preview-trigger]').click();
  await expect(page.locator(VIDEO_DIALOG)).toBeVisible();
  await expect(page.locator(DIALOG)).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.locator(VIDEO_DIALOG)).toBeHidden();

  // Their media area is just part of the selectable card: a click is the
  // existing selection toggle (twice restores it), never the viewer.
  const draftBefore = await draftMembership(page);
  for (const id of [comic, missing]) {
    const media = card(page, id).locator('.asset-card-media');
    await media.click();
    await expect(page.locator(DIALOG)).toBeHidden();
    await media.click();
  }
  expect((await viewerState(page)).open).toBe(false);
  expect(await draftMembership(page)).toEqual(draftBefore);

  expect(control.comic).toEqual([]);
  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('published and archived workspaces stay read-only; the viewer still opens', async ({ page }) => {
  const f = await createRelease();
  const a = f.id('01-a.png');
  db.prepare("UPDATE releases SET published_date = '2026-01-02' WHERE id = ?").run(f.releaseId);
  const control = await open(page, f.url);
  await expect(page.getByText('Asset selections are locked and read-only.')).toBeVisible();
  await expect(page.locator('input[name="selectedAssetIds"]')).toHaveCount(0);
  await expect(page.locator('#release-assets-form')).toHaveCount(0);
  await thumb(page, a).click();
  await expect(title(page)).toHaveText('01-a.png');
  await closeViewer(page);
  await expect(thumb(page, a)).toBeFocused();
  await expect(page.locator('input[name="selectedAssetIds"]')).toHaveCount(0);

  db.prepare("UPDATE releases SET published_date = NULL, archived_at = datetime('now') WHERE id = ?").run(f.releaseId);
  await page.goto(`${baseURL}${f.url}`);
  await expect(page.getByText('This release is archived. Asset selections are read-only.')).toBeVisible();
  await expect(page.locator('input[name="selectedAssetIds"]')).toHaveCount(0);
  await thumb(page, a).click();
  await expect(title(page)).toHaveText('01-a.png');
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();
  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('narrow 375px viewport: the single image fits and closes back to its thumbnail', async ({ page }) => {
  const f = await createRelease();
  const control = await open(page, `${f.url}?selection=all&view=list&pageSize=all`, { viewport: { width: 375, height: 740 } });
  const e = f.id('05-e.png');
  const draft = await draftMembership(page);
  await thumb(page, e).scrollIntoViewIfNeeded();
  await thumb(page, e).click();
  await expect(shownImage(page)).toBeVisible();
  const box = await page.locator(`${DIALOG} [data-unified-viewer-card]`).boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(375.5);
  await expect(page.locator(`${DIALOG} [data-dialog-close]`)).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await closeViewer(page);
  await expect(thumb(page, e)).toBeFocused();
  expect(await draftMembership(page)).toEqual(draft);
  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);
});
