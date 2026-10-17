import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import sharp from 'sharp';
import { createApp } from '../../src/app.js';
import { createAssetManifest } from '../../src/asset-manifest.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';
import { createReleaseService } from '../../src/services/release-service.js';

// Release Grid style in real Chromium: the inline Grid style dropdown on
// Release Detail and Release Manage Assets, stored per screen in browser
// storage and applied in place to the rendered grid through the shared
// .asset-grid[data-grid-style="cropped"] rules. All data lives in a temporary
// root that is removed afterward.
const IMAGES = Array.from({ length: 10 }, (_, index) => `${String(index + 1).padStart(2, '0')}-image.png`);
const EXTRAS = ['11-clip.mp4', '12-broken.png', '13-gone.png'];
const SELECTED = ['01-image.png', '02-image.png', '11-clip.mp4', '13-gone.png'];
const DETAIL_KEY = 'creatorcrate-release-detail-grid-style';
const ASSETS_KEY = 'creatorcrate-release-assets-grid-style';

let server;
let db;
let app;
let root;
let projectsRoot;
let baseURL;
let releaseService;

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-release-grid-style-browser-'));
  projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  const viteDistRoot = path.join(root, 'client');
  const previewRoot = path.join(root, 'previews');
  fs.mkdirSync(projectsRoot);
  fs.mkdirSync(appDataRoot);
  fs.mkdirSync(previewRoot);
  await build({ build: { outDir: viteDistRoot }, logLevel: 'silent' });
  db = openDatabase(path.join(root, 'test.db'));
  runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
  const { csrfPepper } = ensureAuthEnablement(appDataRoot);
  app = createApp({ appName: 'CreatorCrate', db, projectsRoot, previewRoot }, {
    appDataRoot, authState: { csrfPepper }, useViteAssets: true, viteDistRoot,
    assetManifest: createAssetManifest({ distRoot: viteDistRoot,
      manifestPath: path.join(viteDistRoot, '.vite', 'manifest.json') }),
  });
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

// A draft release selecting two wide images, a video and a file that goes
// missing, with the first image as Primary; every other file is a candidate.
async function createRelease(title) {
  const project = app.locals.projectService.create({ title, status: 'tbd' });
  const categories = app.locals.projectAssetCategoryService;
  if (!categories.list(project.id).some((candidate) => candidate.directory_slug === 'wip')) {
    categories.add(project.id, { displayName: 'WIP', directorySlug: 'wip' });
  }
  const categoryDir = path.join(projectsRoot, project.project_dir, 'wip');
  fs.mkdirSync(categoryDir, { recursive: true });
  for (const [index, filename] of IMAGES.entries()) {
    await sharp({ create: { width: 120, height: 40, channels: 3,
      background: { r: index * 20, g: 90, b: 160 } } }).png().toFile(path.join(categoryDir, filename));
  }
  fs.writeFileSync(path.join(categoryDir, EXTRAS[0]), Buffer.from('not really a video'));
  fs.writeFileSync(path.join(categoryDir, EXTRAS[1]), Buffer.from('not really a png'));
  fs.writeFileSync(path.join(categoryDir, EXTRAS[2]), Buffer.from('soon missing'));
  app.locals.assetScanner.scanProjectAssets(project.id);
  const ids = Object.fromEntries(db.prepare('SELECT filename, id FROM assets WHERE project_id = ?')
    .all(project.id).map((row) => [row.filename, String(row.id)]));
  const release = releaseService.createReleaseWithSelectedAssets(project.id, { title: `${title} Release` },
    SELECTED.map((filename) => Number(ids[filename])));
  db.prepare('UPDATE release_assets SET role = ? WHERE release_id = ? AND asset_id = ?')
    .run('primary', release.id, Number(ids['01-image.png']));
  fs.rmSync(path.join(categoryDir, EXTRAS[2]));
  app.locals.assetScanner.scanProjectAssets(project.id);
  return { projectId: project.id, releaseId: release.id, ids };
}

const sizeOf = (locator) => locator.evaluate((node) => {
  const box = node.getBoundingClientRect();
  return { width: Math.round(box.width), height: Math.round(box.height) };
});

async function expectSquare(locator) {
  const size = await sizeOf(locator);
  expect(size.width).toBeGreaterThan(0);
  expect(Math.abs(size.width - size.height)).toBeLessThanOrEqual(1);
}

async function expectWide(locator) {
  const size = await sizeOf(locator);
  expect(size.width).toBeGreaterThan(size.height * 1.5);
}

function imageLink(page, assetId) {
  return page.locator(`.asset-grid article[data-asset-id="${assetId}"] .asset-card-media > .asset-card-media-link`);
}

// Choose through the visible CreatorCrate dropdown, as a user would.
async function chooseGridStyle(page, label) {
  const dropdown = page.locator('#asset-grid-style-dropdown');
  await dropdown.locator('summary').click();
  await dropdown.locator('.asset-filter-multiselect-panel').getByText(label, { exact: true }).click();
  await expect(dropdown.locator('[data-cc-dropdown-summary-current]')).toHaveText(label);
}

const stored = (page) => page.evaluate(([detailKey, assetsKey]) => ({
  detail: localStorage.getItem(detailKey),
  assets: localStorage.getItem(assetsKey),
}), [DETAIL_KEY, ASSETS_KEY]);

// Counts browser-storage writes to the Release grid style keys.
const countStyleWrites = (page) => page.addInitScript((keys) => {
  const original = Storage.prototype.setItem;
  window.__gridStyleWrites = 0;
  Storage.prototype.setItem = function setItem(key, value) {
    if (keys.includes(key)) window.__gridStyleWrites += 1;
    return original.call(this, key, value);
  };
}, [DETAIL_KEY, ASSETS_KEY]);
const styleWrites = (page) => page.evaluate(() => window.__gridStyleWrites);

const draftMembership = (page) => page.evaluate(() => {
  const ids = new Set();
  document.querySelectorAll('[data-release-assets-hidden-membership] input[name="selectedAssetIds"]')
    .forEach((input) => ids.add(input.value));
  document.querySelectorAll('[data-release-assets-live-region] input[name="selectedAssetIds"]:checked')
    .forEach((input) => ids.add(input.value));
  return [...ids].sort();
});

const noHorizontalOverflow = (page) => page.evaluate(
  () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
);

const controlFitsViewport = (page) => page.evaluate(() => {
  const box = document.querySelector('.asset-grid-style-field').getBoundingClientRect();
  return box.left >= 0 && box.right <= document.documentElement.clientWidth;
});

test('Release Detail: Grid style dropdown crops in place and persists across reload and views', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await countStyleWrites(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createRelease('Detail Grid Style');
  const detailPath = `/releases/${f.releaseId}`;
  await page.goto(baseURL + detailPath);

  const grid = page.locator('[data-selected-assets] .asset-grid');
  const control = page.locator('select[data-asset-grid-style-control="release-detail"]');
  const wide = imageLink(page, f.ids['01-image.png']);
  const card = page.locator(`.asset-grid article[data-asset-id="${f.ids['01-image.png']}"]`);

  // Default: Uncropped with the intrinsic wide preview, no storage writes.
  await expect(page.locator('#asset-grid-style-dropdown')).toBeVisible();
  await expect(page.locator('.asset-viewer-display-controls legend')).toContainText('Grid style');
  await expect(control).toHaveValue('uncropped');
  await expect(grid).toHaveAttribute('data-grid-style', 'uncropped');
  await expect(card.locator('[data-preview-image]')).toBeVisible();
  await expectWide(wide);
  expect(await styleWrites(page)).toBe(0);
  const hrefsBefore = await grid.locator('a').evaluateAll((links) => links.map((link) => link.getAttribute('href')));
  const metadataBefore = await grid.locator('.release-asset-card-details').allTextContents();

  // Cropped: square media viewport only, no navigation or request.
  const requests = [];
  page.on('request', (request) => requests.push(request.url()));
  await chooseGridStyle(page, 'Cropped');
  await expect(grid).toHaveAttribute('data-grid-style', 'cropped');
  await expectSquare(wide);
  expect(await card.locator('[data-preview-image]').evaluate((node) => getComputedStyle(node).objectFit)).toBe('cover');
  expect((await sizeOf(card)).height).toBeGreaterThan((await sizeOf(wide)).height);
  expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(detailPath);
  expect(requests.filter((url) => new URL(url).pathname.startsWith('/releases'))).toEqual([]);
  expect(await stored(page)).toEqual({ detail: 'cropped', assets: null });
  expect(await styleWrites(page)).toBe(1);
  expect(await grid.locator('a').evaluateAll((links) => links.map((link) => link.getAttribute('href')))).toEqual(hrefsBefore);
  expect(await grid.locator('.release-asset-card-details').allTextContents()).toEqual(metadataBefore);

  // Missing media keeps its square placeholder; the video keeps its trigger
  // and its playback dialog is not cropped.
  const missing = page.locator(`.asset-grid article[data-asset-id="${f.ids['13-gone.png']}"] .asset-card-media > .asset-card-placeholder`);
  await expectSquare(missing);
  await expect(missing).toContainText('Missing at last scan');
  const videoTrigger = page.locator(`.asset-grid article[data-asset-id="${f.ids['11-clip.mp4']}"] [data-asset-video-preview-trigger]`);
  await expect(videoTrigger).toHaveCount(1);
  await expectSquare(videoTrigger);
  await videoTrigger.click();
  const videoDialog = page.locator('#asset-video-preview-dialog');
  await expect(videoDialog).toBeVisible();
  expect(await videoDialog.evaluate((node) => Boolean(node.closest('.asset-grid')))).toBe(false);
  expect(await videoDialog.locator('video').evaluateAll((nodes) => nodes
    .every((node) => getComputedStyle(node).objectFit !== 'cover'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(videoDialog).toBeHidden();

  // Reload restores Cropped without rewriting storage.
  await page.reload();
  await expect(control).toHaveValue('cropped');
  await expect(page.locator('#asset-grid-style-dropdown [data-cc-dropdown-summary-current]')).toHaveText('Cropped');
  await expect(grid).toHaveAttribute('data-grid-style', 'cropped');
  await expectSquare(imageLink(page, f.ids['01-image.png']));
  expect(await styleWrites(page)).toBe(0);

  // List keeps the control, renders no cropped grid and leaves thumbnails alone.
  await page.locator('nav.view-switcher a[aria-label="List view"]').click();
  await expect(page.locator('.asset-list--release')).toBeVisible();
  await expect(page.locator('#asset-grid-style-dropdown')).toBeVisible();
  await expect(control).toHaveValue('cropped');
  await expect(page.locator('[data-grid-style]')).toHaveCount(0);
  await page.locator('nav.view-switcher a[aria-label="Grid view"]').click();
  await expect(grid).toHaveAttribute('data-grid-style', 'cropped');

  // Keyboard: open the dropdown and pick Uncropped.
  await page.locator('#asset-grid-style-dropdown summary').focus();
  await page.keyboard.press('Enter');
  await page.locator('#asset-grid-style-dropdown input[value="uncropped"]').focus();
  await page.keyboard.press('Space');
  await expect(grid).toHaveAttribute('data-grid-style', 'uncropped');
  await expectWide(imageLink(page, f.ids['01-image.png']));
  expect(await stored(page)).toEqual({ detail: 'uncropped', assets: null });

  // Narrow screens: the toolbar wraps without horizontal overflow.
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.locator('#asset-grid-style-dropdown')).toBeVisible();
  expect(await controlFitsViewport(page)).toBe(true);
  expect(await noHorizontalOverflow(page)).toBe(true);
  expect(pageErrors).toEqual([]);
});

test('Release Manage Assets: style changes in place and survives live filtering, paging and views', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await countStyleWrites(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createRelease('Manage Grid Style');
  const managePath = `/releases/${f.releaseId}/assets?pageSize=10`;
  await page.goto(baseURL + managePath);

  const region = page.locator('[data-release-assets-live-region]');
  const grid = region.locator('.asset-grid');
  const control = page.locator('select[data-asset-grid-style-control="release-assets"]');
  const checkbox = (name) => region.locator(`input[name="selectedAssetIds"][value="${f.ids[name]}"]`);

  await expect(control).toHaveValue('uncropped');
  await expect(grid).toHaveAttribute('data-grid-style', 'uncropped');
  await expect(region.locator(`article[data-asset-id="${f.ids['03-image.png']}"] [data-preview-image]`)).toBeVisible();
  await expectWide(imageLink(page, f.ids['03-image.png']));
  expect(await styleWrites(page)).toBe(0);

  // Unsaved draft: select a candidate and deselect a selected asset.
  await checkbox('03-image.png').check({ force: true });
  await checkbox('02-image.png').uncheck({ force: true });
  const draft = await draftMembership(page);
  expect(draft).toEqual([f.ids['01-image.png'], f.ids['03-image.png'], f.ids['11-clip.mp4'], f.ids['13-gone.png']].sort());
  const roleBefore = await region.locator(`#role-${f.ids['01-image.png']}`).inputValue();
  const orderBefore = await region.locator('article.asset-card').evaluateAll((cards) => cards.map((card) => card.dataset.assetId));

  // A style-only change keeps the same region and grid nodes, scroll and URL.
  await region.evaluate((node) => { node.__styleMarker = true; node.querySelector('.asset-grid').__styleMarker = true; });
  await page.evaluate(() => window.scrollTo(0, 200));
  const scrollBefore = await page.evaluate(() => window.scrollY);
  const requests = [];
  page.on('request', (request) => requests.push(request.url()));
  await chooseGridStyle(page, 'Cropped');
  await expect(grid).toHaveAttribute('data-grid-style', 'cropped');
  await expectSquare(imageLink(page, f.ids['03-image.png']));
  expect(await region.evaluate((node) => [node.__styleMarker, node.querySelector('.asset-grid').__styleMarker])).toEqual([true, true]);
  await expect(region).not.toHaveAttribute('aria-busy', 'true');
  expect(requests.filter((url) => new URL(url).pathname.startsWith('/releases'))).toEqual([]);
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
  expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(managePath);
  expect(await draftMembership(page)).toEqual(draft);
  await expect(checkbox('03-image.png')).toBeChecked();
  await expect(checkbox('02-image.png')).not.toBeChecked();
  expect(await region.locator(`#role-${f.ids['01-image.png']}`).inputValue()).toBe(roleBefore);
  expect(await region.locator('article.asset-card').evaluateAll((cards) => cards.map((card) => card.dataset.assetId))).toEqual(orderBefore);
  expect(await stored(page)).toEqual({ detail: null, assets: 'cropped' });
  expect(await styleWrites(page)).toBe(1);

  // Existing card controls still work under Cropped: selection and Grid size.
  await checkbox('04-image.png').check({ force: true });
  await expect(checkbox('04-image.png')).toBeChecked();
  await page.locator('[data-asset-grid-size-controls] [data-grid-size-option-label="large"]').click();
  await expect(grid).toHaveAttribute('data-grid-size', 'large');
  await expect(grid).toHaveAttribute('data-grid-style', 'cropped');
  await page.locator('[data-asset-grid-size-controls] [data-grid-size-option-label="default"]').click();
  const draftWithFour = await draftMembership(page);

  // Live filtering replaces the region; the new grid and control restore Cropped.
  await page.getByRole('link', { name: 'Filter assets' }).click();
  await page.locator('#asset-search').fill('image');
  await expect.poll(() => new URL(page.url()).searchParams.get('search') || '').toBe('image');
  await page.keyboard.press('Escape');
  await expect(region).not.toHaveAttribute('aria-busy', 'true');
  expect(await region.evaluate((node) => node.__styleMarker)).toBeUndefined();
  await expect(control).toHaveValue('cropped');
  await expect(page.locator('#asset-grid-style-dropdown [data-cc-dropdown-summary-current]')).toHaveText('Cropped');
  await expect(grid).toHaveAttribute('data-grid-style', 'cropped');
  expect(await draftMembership(page)).toEqual(draftWithFour);

  // Pagination keeps the style and the draft.
  await region.locator('.pagination a.pagination-next').click();
  await expect.poll(() => new URL(page.url()).searchParams.get('page')).toBe('2');
  await expect(region).not.toHaveAttribute('aria-busy', 'true');
  await expect(grid).toHaveAttribute('data-grid-style', 'cropped');
  expect(await draftMembership(page)).toEqual(draftWithFour);

  // List view: the control remains, List thumbnails are untouched.
  await region.locator('nav.view-switcher a[aria-label="List view"]').click();
  await expect(region.locator('.asset-list--release')).toBeVisible();
  await expect(control).toHaveValue('cropped');
  await expect(page.locator('[data-grid-style]')).toHaveCount(0);
  await region.locator('nav.view-switcher a[aria-label="Grid view"]').click();
  await expect(grid).toHaveAttribute('data-grid-style', 'cropped');
  expect(await draftMembership(page)).toEqual(draftWithFour);
  // Rebinding after replacements never writes storage.
  expect(await styleWrites(page)).toBe(1);

  // One listener per rendered control: a change after replacements writes once.
  await chooseGridStyle(page, 'Uncropped');
  await expect(grid).toHaveAttribute('data-grid-style', 'uncropped');
  expect(await styleWrites(page)).toBe(2);
  await chooseGridStyle(page, 'Cropped');
  expect(await styleWrites(page)).toBe(3);
  expect(await draftMembership(page)).toEqual(draftWithFour);

  // Nothing was saved to the server by the style changes.
  const saved = db.prepare('SELECT asset_id FROM release_assets WHERE release_id = ?')
    .all(f.releaseId).map((row) => String(row.asset_id)).sort();
  expect(saved).toEqual(SELECTED.map((name) => f.ids[name]).sort());

  // Narrow screens: the control wraps inside the viewport. (Manage Assets
  // already has page-level horizontal overflow from elsewhere on the page.)
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.locator('#asset-grid-style-dropdown')).toBeVisible();
  expect(await controlFitsViewport(page)).toBe(true);
  expect(pageErrors).toEqual([]);
});

test('Release Grid style preferences are independent, validated and honour read-only releases', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createRelease('Grid Style Independence');
  const detailGrid = page.locator('[data-selected-assets] .asset-grid');
  const manageGrid = page.locator('[data-release-assets-live-region] .asset-grid');

  // Release Detail Cropped leaves Manage Assets Uncropped, and vice versa.
  await page.goto(`${baseURL}/releases/${f.releaseId}`);
  await chooseGridStyle(page, 'Cropped');
  await page.goto(`${baseURL}/releases/${f.releaseId}/assets`);
  await expect(manageGrid).toHaveAttribute('data-grid-style', 'uncropped');
  await expectWide(imageLink(page, f.ids['01-image.png']));
  expect(await stored(page)).toEqual({ detail: 'cropped', assets: null });

  // The preference applies to every release of the same screen type.
  const other = await createRelease('Grid Style Other Release');
  await page.goto(`${baseURL}/releases/${other.releaseId}`);
  await expect(detailGrid).toHaveAttribute('data-grid-style', 'cropped');

  // Invalid stored values fall back to Uncropped and never reach the grid.
  await page.evaluate(([detailKey, assetsKey]) => {
    localStorage.setItem(detailKey, 'stretched');
    localStorage.setItem(assetsKey, 'CROPPED');
  }, [DETAIL_KEY, ASSETS_KEY]);
  await page.reload();
  await expect(detailGrid).toHaveAttribute('data-grid-style', 'uncropped');
  await expect(page.locator('select[data-asset-grid-style-control="release-detail"]')).toHaveValue('uncropped');
  await page.goto(`${baseURL}/releases/${f.releaseId}/assets`);
  await expect(manageGrid).toHaveAttribute('data-grid-style', 'uncropped');
  await expect(page.locator('[data-grid-style="stretched"], [data-grid-style="CROPPED"]')).toHaveCount(0);

  // Published releases stay read-only; the style still applies.
  await chooseGridStyle(page, 'Cropped');
  db.prepare('UPDATE releases SET published_date = ? WHERE id = ?').run('2026-10-01', f.releaseId);
  await page.goto(`${baseURL}/releases/${f.releaseId}/assets`);
  await expect(page.locator('#release-assets-form')).toHaveCount(0);
  await expect(page.locator('input[name="selectedAssetIds"]')).toHaveCount(0);
  await expect(manageGrid).toHaveAttribute('data-grid-style', 'cropped');
  await expectSquare(imageLink(page, f.ids['01-image.png']));
  await page.goto(`${baseURL}/releases/${f.releaseId}`);
  await expect(page.getByRole('link', { name: 'Manage Assets' })).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test('Release Manage Assets: both Grid style options stay clickable above the mobile Filter row', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 375, height: 812 });
  const f = await createRelease('Mobile Grid Style');
  await page.goto(`${baseURL}/releases/${f.releaseId}/assets`);

  const region = page.locator('[data-release-assets-live-region]');
  const grid = region.locator('.asset-grid');
  const control = page.locator('select[data-asset-grid-style-control="release-assets"]');
  const dropdown = page.locator('#asset-grid-style-dropdown');
  const summary = dropdown.locator('[data-cc-dropdown-summary-current]');
  const option = (label) => dropdown.locator('.asset-filter-multiselect-panel').getByText(label, { exact: true });
  // The option itself, not the Filter row, must receive a pointer at its centre.
  const optionIsHitTarget = (label) => option(label).evaluate((node) => {
    node.scrollIntoView({ block: 'nearest' });
    const box = node.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return Boolean(hit && node.closest('label').contains(hit));
  });

  await expect(control).toHaveValue('uncropped');
  await expect(summary).toHaveText('Uncropped');
  await expect(grid).toHaveAttribute('data-grid-style', 'uncropped');
  await expectWide(imageLink(page, f.ids['01-image.png']));

  // Ordinary clicks (no force): open, choose Cropped.
  await dropdown.locator('summary').click();
  expect(await optionIsHitTarget('Cropped')).toBe(true);
  await option('Cropped').click();
  await expect(summary).toHaveText('Cropped');
  await expect(control).toHaveValue('cropped');
  await expect(grid).toHaveAttribute('data-grid-style', 'cropped');
  await expectSquare(imageLink(page, f.ids['01-image.png']));
  expect(await stored(page)).toEqual({ detail: null, assets: 'cropped' });

  // Reopen and choose Uncropped: the option sits over the Filter row.
  await dropdown.locator('summary').click();
  await expect(dropdown).toHaveAttribute('open', '');
  expect(await optionIsHitTarget('Uncropped')).toBe(true);
  await option('Uncropped').click();
  await expect(summary).toHaveText('Uncropped');
  await expect(control).toHaveValue('uncropped');
  await expect(grid).toHaveAttribute('data-grid-style', 'uncropped');
  await expectWide(imageLink(page, f.ids['01-image.png']));
  expect(await stored(page)).toEqual({ detail: null, assets: 'uncropped' });

  // Once the dropdown closes, the Filter control is clickable again.
  await page.keyboard.press('Escape');
  await expect(dropdown).not.toHaveAttribute('open', '');
  const filter = page.getByRole('link', { name: 'Filter assets' });
  await filter.click();
  await expect(page.locator('#asset-search')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#asset-search')).toBeHidden();

  // Another narrow width keeps both options reachable.
  await page.setViewportSize({ width: 320, height: 640 });
  await dropdown.locator('summary').click();
  expect(await optionIsHitTarget('Cropped')).toBe(true);
  expect(await optionIsHitTarget('Uncropped')).toBe(true);
  await option('Cropped').click();
  await expect(grid).toHaveAttribute('data-grid-style', 'cropped');
  expect(pageErrors).toEqual([]);
});
