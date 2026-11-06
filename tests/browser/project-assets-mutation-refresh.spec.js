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

// A post-mutation refresh in real Chromium, triggered through the existing
// categories-changed caller while the test changes server state directly: the
// region is replaced with authoritative content and the user's transient state
// survives by identity. All data lives in a temporary root removed afterward.
const FILES = ['01-draft.png', '02-ref.jpg', '03-draft.png', '04-ref.jpg', '05-draft.png', '06-ref.jpg'];

let server;
let db;
let app;
let root;
let projectsRoot;
let baseURL;

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-mutation-refresh-'));
  projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  const viteDistRoot = path.join(root, 'client');
  fs.mkdirSync(projectsRoot);
  fs.mkdirSync(appDataRoot);
  await build({ build: { outDir: viteDistRoot }, logLevel: 'silent' });
  db = openDatabase(path.join(root, 'test.db'));
  runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
  const { csrfPepper } = ensureAuthEnablement(appDataRoot);
  app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, {
    appDataRoot, authState: { csrfPepper }, useViteAssets: true, viteDistRoot,
    assetManifest: createAssetManifest({ distRoot: viteDistRoot,
      manifestPath: path.join(viteDistRoot, '.vite', 'manifest.json') }),
  });
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

async function writeImage(filePath, shade = 90) {
  const image = sharp({ create: { width: 12, height: 12, channels: 3, background: { r: shade, g: 90, b: 160 } } });
  await (filePath.endsWith('.png') ? image.png() : image.jpeg()).toFile(filePath);
}

async function createProject(title) {
  const project = app.locals.projectService.create({ title, status: 'tbd' });
  const categories = app.locals.projectAssetCategoryService;
  if (!categories.list(project.id).some((candidate) => candidate.directory_slug === 'wip')) {
    categories.add(project.id, { displayName: 'WIP', directorySlug: 'wip' });
  }
  const category = categories.list(project.id).find((candidate) => candidate.directory_slug === 'wip');
  const categoryDir = path.join(projectsRoot, project.project_dir, 'wip');
  fs.mkdirSync(categoryDir, { recursive: true });
  for (const [index, filename] of FILES.entries()) await writeImage(path.join(categoryDir, filename), index * 30);
  app.locals.assetScanner.scanProjectAssets(project.id);
  const id = (filename) => db.prepare('SELECT id FROM assets WHERE project_id = ? AND filename = ?').get(project.id, filename).id;
  return {
    id: project.id,
    categoryId: category.id,
    url: `/projects/${project.id}/assets`,
    assetId: id,
    remove(filename) {
      const assetId = id(filename);
      fs.rmSync(path.join(categoryDir, filename), { force: true });
      db.prepare('DELETE FROM assets WHERE id = ?').run(assetId);
      return assetId;
    },
    async add(filename) {
      await writeImage(path.join(categoryDir, filename), 200);
      app.locals.assetScanner.scanProjectAssets(project.id);
      return id(filename);
    },
    markMissing(filename) {
      fs.rmSync(path.join(categoryDir, filename), { force: true });
      app.locals.assetScanner.scanProjectAssets(project.id);
    },
    // Moves the asset out of (or back into) a search=draft view without a new identity.
    renameRow(from, to) {
      db.prepare('UPDATE assets SET filename = ?, relative_path = ? WHERE id = ?').run(to, `wip/${to}`, id(from));
    },
  };
}

async function open(page, url, { viewport = { width: 1280, height: 900 } } = {}) {
  const control = { mode: 'pass', gets: [], held: [], posts: [] };
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.method() !== 'GET') control.posts.push(request.url());
  });
  await page.route((target) => /^\/projects\/\d+\/assets$/.test(target.pathname), async (route) => {
    const request = route.request();
    if (request.resourceType() !== 'fetch') return route.fallback();
    control.gets.push(request.url());
    if (control.mode === 'fail') return route.fulfill({ status: 500, contentType: 'text/html', body: 'failed' });
    if (control.mode === 'malformed') return route.fulfill({ status: 200, contentType: 'text/html', body: '<p>nothing</p>' });
    if (control.mode === 'hold') {
      control.held.push(route);
      return undefined;
    }
    return route.continue();
  });
  await page.setViewportSize(viewport);
  await page.goto(`${baseURL}${url}`);
  await page.evaluate(() => { window.__sameDocument = true; });
  return { control, errors };
}

const region = (page) => page.locator('[data-project-assets-live-region]');
const surface = (page) => page.locator('[data-auto-rename-surface]');
const items = (page) => surface(page).locator('[data-auto-rename-asset]');
const item = (page, name) => surface(page).locator(`[data-auto-rename-asset][aria-label="Reorder ${name}"]`);
const box = (page, id) => page.locator(`input[name="selectedAssetIds"][value="${id}"]`);
const notice = (page) => page.locator('[data-live-filter-failure]');
const retry = (page) => page.locator('[data-live-filter-retry]');
const orderInput = (page) => page.locator('[data-auto-rename-order-input]');
const orderValue = async (page) => JSON.parse(await orderInput(page).inputValue());
const names = (page) => items(page).evaluateAll((nodes) => nodes.map(
  (node) => node.getAttribute('aria-label').replace(/^Reorder /, ''),
));

async function markRegion(page) {
  await region(page).evaluate((node) => { node.dataset.beforeRefresh = 'true'; });
}

function triggerRefresh(page) {
  return page.evaluate(() => document.dispatchEvent(new Event('project-asset-categories-changed')));
}

async function expectInstalled(page) {
  await expect(page.locator('[data-project-assets-live-region]:not([data-before-refresh])')).toHaveCount(1);
  await expect(region(page)).not.toHaveAttribute('aria-busy', 'true');
  expect(await page.evaluate(() => window.__sameDocument)).toBe(true);
}

async function refreshed(page) {
  await markRegion(page);
  await triggerRefresh(page);
  await expectInstalled(page);
}

async function select(page, id) {
  await page.locator(`label[for$="-select-${id}"]`).click();
  await expect(box(page, id)).toBeChecked();
}

// Moves one rendered asset with the keyboard.
async function moveBefore(page, name) {
  const target = item(page, name);
  await target.focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
}

const statusText = (page) => page.locator('[data-project-assets-live-status]');
const KEPT_MESSAGE = 'Your unsaved category order was kept, but it cannot be shown in this view.';

// The filter form lives in a dialog; these drive its real change events.
async function setSearch(page, value) {
  await page.locator('#search').evaluate((input, next) => {
    input.value = next;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

async function searched(page, value) {
  await markRegion(page);
  await setSearch(page, value);
  await expectInstalled(page);
}

async function switchCategory(page, categoryId) {
  await markRegion(page);
  await page.locator(`#asset-category-filter input[value="${categoryId}"]`).evaluate((input) => {
    input.checked = true;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expectInstalled(page);
}

const savedOrder = async (page) => JSON.parse(await surface(page).getAttribute('data-auto-rename-base-order'));

async function expectDraftHeld(page) {
  await expect(surface(page)).toHaveCount(0);
  await expect(statusText(page)).toHaveText(KEPT_MESSAGE);
}

async function expectDraftShown(page, order, saved) {
  expect(await orderValue(page)).toEqual(order);
  expect(new Set(order).size).toBe(order.length);
  expect(await savedOrder(page)).toEqual(saved);
  await expect(surface(page)).toHaveAttribute('data-auto-rename-draft', 'true');
  await expect(surface(page)).toHaveAttribute('data-auto-rename-membership', 'valid');
}

test('H: a retained order returns with the matching filter after a superseded refresh and a zero-match view', async ({ page }) => {
  const f = await createProject('Retained H');
  const { control, errors } = await open(page, `${f.url}?category=${f.categoryId}&search=draft`);
  const [a, b, c, d, e, g] = FILES.map(f.assetId);
  await moveBefore(page, '03-draft.png');
  expect(await orderValue(page)).toEqual([c, b, a, d, e, g]);

  // A newer zero-match filter replaces the pending refresh, which then arrives late.
  await markRegion(page);
  control.mode = 'hold';
  await triggerRefresh(page);
  await expect.poll(() => control.held.length).toBe(1);
  const superseded = control.held.shift();
  control.mode = 'pass';
  await setSearch(page, 'nothing-matches');
  await expectInstalled(page);
  await expectDraftHeld(page);
  await superseded.fulfill({ status: 200, contentType: 'text/html', body: '<div data-project-assets-live-region>stale</div>' }).catch(() => {});
  await expectDraftHeld(page);

  await searched(page, 'draft');
  await expectDraftShown(page, [c, b, a, d, e, g], [a, b, c, d, e, g]);
  expect(await names(page)).toEqual(['03-draft.png', '01-draft.png', '05-draft.png']);
  await expect(statusText(page)).toHaveText('');

  // Ordering continues, around the same hidden positions.
  await moveBefore(page, '05-draft.png');
  expect(await orderValue(page)).toEqual([c, b, e, d, a, g]);
  expect(await savedOrder(page)).toEqual([a, b, c, d, e, g]);
  expect(await page.evaluate(() => window.__sameDocument)).toBe(true);
  expect(control.posts).toEqual([]);
  expect(errors).toEqual([]);
});

test('I: each category keeps its own order through the other category', async ({ page }) => {
  const f = await createProject('Retained I');
  const categories = app.locals.projectAssetCategoryService;
  categories.add(f.id, { displayName: 'Other', directorySlug: 'other' });
  const other = categories.list(f.id).find((candidate) => candidate.directory_slug === 'other');
  const project = app.locals.projectService.getById?.(f.id) ?? db.prepare('SELECT project_dir FROM projects WHERE id = ?').get(f.id);
  const otherDir = path.join(projectsRoot, project.project_dir, 'other');
  fs.mkdirSync(otherDir, { recursive: true });
  await writeImage(path.join(otherDir, 'x1.png'));
  await writeImage(path.join(otherDir, 'x2.png'));
  await writeImage(path.join(otherDir, 'x3.png'));
  app.locals.assetScanner.scanProjectAssets(f.id);
  const [x1, x2, x3] = ['x1.png', 'x2.png', 'x3.png'].map(f.assetId);
  const [a, b, c, d, e, g] = FILES.map(f.assetId);

  const { control, errors } = await open(page, `${f.url}?category=${f.categoryId}`);
  await moveBefore(page, '03-draft.png');
  const draftA = [a, c, b, d, e, g];
  expect(await orderValue(page)).toEqual(draftA);

  // Never installed on the other category, which stays on its saved order.
  await switchCategory(page, other.id);
  await expect(surface(page)).toHaveAttribute('data-auto-rename-category-id', String(other.id));
  expect(await orderValue(page)).toEqual([x1, x2, x3]);
  await expect(surface(page)).not.toHaveAttribute('data-auto-rename-draft', 'true');
  await expect(statusText(page)).toHaveText(KEPT_MESSAGE);

  // A second draft does not push out the first one.
  await moveBefore(page, 'x3.png');
  expect(await orderValue(page)).toEqual([x1, x3, x2]);

  await switchCategory(page, f.categoryId);
  await expectDraftShown(page, draftA, [a, b, c, d, e, g]);
  await expect(statusText(page)).toHaveText(KEPT_MESSAGE);

  await switchCategory(page, other.id);
  await expectDraftShown(page, [x1, x3, x2], [x1, x2, x3]);

  await switchCategory(page, f.categoryId);
  await expectDraftShown(page, draftA, [a, b, c, d, e, g]);
  expect(control.posts).toEqual([]);
  expect(errors).toEqual([]);
});

test('J: repeated views and refreshes keep one stable draft and one set of listeners', async ({ page }) => {
  const f = await createProject('Retained J');
  const { control, errors } = await open(page, `${f.url}?category=${f.categoryId}&search=draft`);
  const [a, b, c, d, e, g] = FILES.map(f.assetId);
  await moveBefore(page, '03-draft.png');
  const draft = [c, b, a, d, e, g];
  const saved = [a, b, c, d, e, g];

  for (let round = 0; round < 3; round += 1) {
    await refreshed(page);
    await expectDraftShown(page, draft, saved);
    await searched(page, 'nothing-matches');
    await expectDraftHeld(page);
    await refreshed(page);
    await expectDraftHeld(page);
    await searched(page, 'ref');
    await expectDraftShown(page, draft, saved);
    expect(await names(page)).toEqual(['02-ref.jpg', '04-ref.jpg', '06-ref.jpg']);
    await searched(page, 'draft');
    await expectDraftShown(page, draft, saved);
  }

  // One key press moves one position, so no handlers were bound twice.
  await moveBefore(page, '01-draft.png');
  expect(await names(page)).toEqual(['01-draft.png', '03-draft.png', '05-draft.png']);
  expect(await orderValue(page)).toEqual(saved);
  expect(control.posts).toEqual([]);
  expect(errors).toEqual([]);
});

test('K: a held order reconciles membership when it returns, with review only for additions', async ({ page }) => {
  const f = await createProject('Retained K');
  const { control, errors } = await open(page, `${f.url}?category=${f.categoryId}&search=draft`);
  const [a, b, c, , e, g] = FILES.map(f.assetId);
  await moveBefore(page, '03-draft.png');
  const review = page.locator('[data-auto-rename-order-review]');

  await searched(page, 'nothing-matches');
  f.remove('04-ref.jpg');
  await searched(page, 'draft');
  await expectDraftShown(page, [c, b, a, e, g], [a, b, c, e, g]);
  await expect(review).toHaveCount(0);

  await searched(page, 'nothing-matches');
  const added = await f.add('02x-draft.png');
  await searched(page, 'draft');
  await expectDraftShown(page, [c, b, added, a, e, g], [a, b, added, c, e, g]);
  await expect(review).toBeVisible();

  // A pending review also survives another trip away.
  await searched(page, 'nothing-matches');
  await expectDraftHeld(page);
  await searched(page, 'draft');
  await expect(review).toBeVisible();
  await expectDraftShown(page, [c, b, added, a, e, g], [a, b, added, c, e, g]);
  await select(page, a);
  await expect(page.locator('[data-auto-rename-submit]')).toBeDisabled();

  await review.getByRole('button', { name: 'Keep this order' }).click();
  await expect(review).toHaveCount(0);
  await expect(page.locator('[data-auto-rename-submit]')).toBeEnabled();
  expect(await savedOrder(page)).toEqual([a, b, added, c, e, g]);
  expect(control.posts).toEqual([]);
  expect(errors).toEqual([]);
});

test('L: an order ends only when moved back to the saved order or when the page reloads', async ({ page }) => {
  const f = await createProject('Retained L');
  const url = `${f.url}?category=${f.categoryId}&search=draft`;
  const { control, errors } = await open(page, url);
  const saved = FILES.map(f.assetId);
  const [a, b, c, d, e, g] = saved;

  await moveBefore(page, '03-draft.png');
  await moveBefore(page, '01-draft.png');
  expect(await orderValue(page)).toEqual(saved);
  await searched(page, 'nothing-matches');
  await expect(surface(page)).toHaveCount(0);
  await expect(statusText(page)).toHaveText('');
  await searched(page, 'draft');
  expect(await orderValue(page)).toEqual(saved);
  await expect(surface(page)).not.toHaveAttribute('data-auto-rename-draft', 'true');

  await moveBefore(page, '03-draft.png');
  await searched(page, 'nothing-matches');
  await expectDraftHeld(page);
  await searched(page, 'draft');
  await expectDraftShown(page, [c, b, a, d, e, g], saved);
  await searched(page, 'nothing-matches');
  await page.goto(`${baseURL}${url}`);
  expect(await orderValue(page)).toEqual(saved);
  await expect(surface(page)).not.toHaveAttribute('data-auto-rename-draft', 'true');
  expect(control.posts).toEqual([]);
  expect(errors).toEqual([]);
});

test('M: a held order survives failed filters and refreshes, and Retry restores it with GET only', async ({ page }) => {
  const f = await createProject('Retained M');
  const { control, errors } = await open(page, `${f.url}?category=${f.categoryId}&search=draft`);
  const [a, b, c, d, e, g] = FILES.map(f.assetId);
  const draft = [c, b, a, d, e, g];
  const saved = [a, b, c, d, e, g];
  await moveBefore(page, '03-draft.png');

  // A rendered order is untouched when the filter leaving it fails.
  await markRegion(page);
  control.mode = 'fail';
  await setSearch(page, 'nothing-matches');
  await expect(notice(page)).toBeVisible();
  expect(await orderValue(page)).toEqual(draft);
  control.mode = 'pass';
  await retry(page).click();
  await expectInstalled(page);
  await expectDraftHeld(page);

  // A failed refresh in the zero-match view, then a failed return.
  await markRegion(page);
  control.mode = 'fail';
  await triggerRefresh(page);
  await expect(notice(page)).toBeVisible();
  control.mode = 'pass';
  await retry(page).click();
  await expectInstalled(page);
  await expectDraftHeld(page);

  await markRegion(page);
  control.mode = 'fail';
  await setSearch(page, 'draft');
  await expect(notice(page)).toBeVisible();
  control.mode = 'pass';
  await retry(page).click();
  await expectInstalled(page);
  await expect(notice(page)).toHaveCount(0);
  await expectDraftShown(page, draft, saved);
  expect(control.posts).toEqual([]);
  expect(errors).toEqual([]);
});

test('A: filtered selection keeps surviving and hidden identities, then restores them when shown again', async ({ page }) => {
  const f = await createProject('Refresh A');
  const { control, errors } = await open(page, `${f.url}?category=${f.categoryId}&search=draft`);
  const first = f.assetId('01-draft.png');
  const third = f.assetId('03-draft.png');
  await select(page, first);
  await select(page, third);

  f.renameRow('03-draft.png', '03-moved.png');
  await refreshed(page);
  await expect(box(page, first)).toBeChecked();
  await expect(box(page, third)).toHaveCount(0);
  await expect(page.locator('[data-selected-count]')).toContainText('1 of 2 selected (1 more not shown)');

  f.renameRow('03-moved.png', '03-draft.png');
  await refreshed(page);
  await expect(box(page, third)).toBeChecked();
  await expect(page.locator('[data-selected-count]')).toHaveText('2 of 3 selected');
  expect(control.posts).toEqual([]);
  expect(errors).toEqual([]);
});

test('B: a complete pending order keeps hidden positions and stays an unsaved draft', async ({ page }) => {
  const f = await createProject('Refresh B');
  const { control, errors } = await open(page, `${f.url}?category=${f.categoryId}&search=draft`);
  const [a, b, c, d, e, g] = FILES.map(f.assetId);
  expect(await orderValue(page)).toEqual([a, b, c, d, e, g]);

  await moveBefore(page, '03-draft.png');
  expect(await orderValue(page)).toEqual([c, b, a, d, e, g]);

  await refreshed(page);
  expect(await names(page)).toEqual(['03-draft.png', '01-draft.png', '05-draft.png']);
  expect(await orderValue(page)).toEqual([c, b, a, d, e, g]);
  expect(JSON.parse(await surface(page).getAttribute('data-auto-rename-base-order'))).toEqual([a, b, c, d, e, g]);
  await expect(surface(page)).toHaveAttribute('data-auto-rename-draft', 'true');
  await expect(surface(page)).toHaveAttribute('data-auto-rename-membership', 'valid');

  // A further move still merges around hidden assets after the refresh.
  await moveBefore(page, '05-draft.png');
  expect(await names(page)).toEqual(['03-draft.png', '05-draft.png', '01-draft.png']);
  expect(await orderValue(page)).toEqual([c, b, e, d, a, g]);
  expect(control.posts).toEqual([]);
  expect(errors).toEqual([]);
});

test('C: membership change removes deleted identities, integrates new ones, and blocks Auto Rename pending review', async ({ page }) => {
  const f = await createProject('Refresh C');
  const { control, errors } = await open(page, `${f.url}?category=${f.categoryId}&search=draft`);
  const [a, b, c, d, e, g] = FILES.map(f.assetId);
  await select(page, a);
  await select(page, e);
  await moveBefore(page, '03-draft.png');

  // Removal alone reconciles safely.
  f.remove('04-ref.jpg');
  f.remove('05-draft.png');
  await refreshed(page);
  expect(await orderValue(page)).toEqual([c, b, a, g]);
  await expect(box(page, e)).toHaveCount(0);
  await expect(page.locator('[data-selected-count]')).toHaveText('1 of 2 selected');
  await expect(page.locator('[data-auto-rename-order-review]')).toHaveCount(0);

  // A new identity follows its server predecessor and needs confirmation.
  const added = await f.add('02x-draft.png');
  await refreshed(page);
  expect(await orderValue(page)).toEqual([c, b, added, a, g]);
  await expect(box(page, added)).not.toBeChecked();
  await expect(box(page, a)).toBeChecked();
  const review = page.locator('[data-auto-rename-order-review]');
  await expect(review).toBeVisible();
  await expect(page.locator('[data-auto-rename-submit]')).toBeDisabled();

  // Check again repeats only the GET and keeps the review.
  const getsBefore = control.gets.length;
  await review.getByRole('button', { name: 'Check again' }).click();
  await expect.poll(() => control.gets.length).toBe(getsBefore + 1);
  await expect(region(page)).not.toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('[data-auto-rename-order-review]')).toBeVisible();

  await page.locator('[data-auto-rename-order-review]').getByRole('button', { name: 'Keep this order' }).click();
  await expect(page.locator('[data-auto-rename-order-review]')).toHaveCount(0);
  await expect(page.locator('[data-auto-rename-submit]')).toBeEnabled();
  expect(await orderValue(page)).toEqual([c, b, added, a, g]);
  expect(control.posts).toEqual([]);
  expect(errors).toEqual([]);
});

test('D: a failed refresh changes nothing and Retry installs with GET only', async ({ page }) => {
  const f = await createProject('Refresh D');
  const { control, errors } = await open(page, `${f.url}?category=${f.categoryId}&search=draft`);
  const a = f.assetId('01-draft.png');
  const c = f.assetId('03-draft.png');
  await select(page, a);
  await moveBefore(page, '03-draft.png');
  const before = await orderValue(page);

  await markRegion(page);
  control.mode = 'hold';
  await triggerRefresh(page);
  await expect.poll(() => control.held.length).toBe(1);
  await expect(region(page)).toHaveAttribute('aria-busy', 'true');
  await expect(box(page, a)).toBeChecked();
  await control.held.shift().fulfill({ status: 500, contentType: 'text/html', body: 'failed' });

  await expect(notice(page)).toBeVisible();
  await expect(notice(page)).toContainText("couldn't");
  await expect(page.locator('[data-project-assets-live-region][data-before-refresh]')).toHaveCount(1);
  await expect(box(page, a)).toBeChecked();
  expect(await orderValue(page)).toEqual(before);
  await expect(retry(page)).toHaveCount(1);

  control.mode = 'malformed';
  await retry(page).click();
  await expect(retry(page)).toHaveCount(1);
  await expect(page.locator('[data-project-assets-live-region][data-before-refresh]')).toHaveCount(1);

  control.mode = 'pass';
  f.renameRow('05-draft.png', '05-draft-renamed.png');
  await retry(page).click();
  await expectInstalled(page);
  await expect(notice(page)).toHaveCount(0);
  await expect(item(page, '05-draft-renamed.png')).toBeVisible();
  await expect(box(page, a)).toBeChecked();
  expect(await orderValue(page)).toEqual(before);
  expect(before[0]).toBe(c);
  expect(control.posts).toEqual([]);
  expect(errors).toEqual([]);
});

test('E: races never install stale results or falsely resolve the owed refresh', async ({ page }) => {
  const f = await createProject('Refresh E');
  const { control, errors } = await open(page, `${f.url}?category=${f.categoryId}`);
  const a = f.assetId('01-draft.png');
  await select(page, a);

  // Older filter GET still pending; the refresh takes over its URL and history.
  await page.getByRole('link', { name: 'Filter assets', exact: true }).click();
  const search = page.locator('#search');
  control.mode = 'hold';
  await search.fill('draft');
  await expect.poll(() => control.held.length).toBe(1);
  const oldFilter = control.held.shift();
  expect(oldFilter.request().url()).toContain('search=draft');

  control.mode = 'pass';
  await refreshed(page);
  expect(new URL(page.url()).searchParams.get('search')).toBe('draft');
  expect(control.gets.at(-1)).toContain('search=draft');
  await expect(box(page, a)).toBeChecked();
  await oldFilter.abort().catch(() => {});
  await expect(items(page)).toHaveCount(3);

  // Refresh pending; a newer filter fails. The newer request owns Retry, and
  // its install still carries the state the refresh owed.
  await markRegion(page);
  control.mode = 'hold';
  await triggerRefresh(page);
  await expect.poll(() => control.held.length).toBe(1);
  const superseded = control.held.shift();
  control.mode = 'fail';
  await search.fill('ref');
  await expect(notice(page)).toBeVisible();
  await expect(notice(page)).toContainText('requested filters were not applied');
  await superseded.fulfill({ status: 200, contentType: 'text/html', body: '<div data-project-assets-live-region>stale</div>' }).catch(() => {});
  await expect(page.locator('[data-project-assets-live-region][data-before-refresh]')).toHaveCount(1);
  await expect(box(page, a)).toBeChecked();
  await expect(search).toHaveValue('ref');

  control.mode = 'pass';
  await retry(page).click();
  await expectInstalled(page);
  expect(new URL(page.url()).searchParams.get('search')).toBe('ref');
  await expect(notice(page)).toHaveCount(0);
  await expect(item(page, '02-ref.jpg')).toBeVisible();
  // The asset is hidden by the newer filter, not deleted, so it stays selected.
  await expect(page.locator('[data-selected-count]')).toContainText('(1 more not shown)');
  expect(control.posts).toEqual([]);
  expect(errors).toEqual([]);
});

test('F: presentation, focus, scroll and slideshow survive by identity', async ({ page }) => {
  const f = await createProject('Refresh F');
  const { control, errors } = await open(page, `${f.url}?category=${f.categoryId}&view=list`, { viewport: { width: 1000, height: 320 } });
  await expect(page.locator('.asset-list')).toBeVisible();
  const third = f.assetId('03-draft.png');
  const fourth = f.assetId('04-ref.jpg');

  // List view, focus and page scroll.
  await box(page, third).focus();
  const scrollY = await page.evaluate(() => {
    window.scrollTo(0, 60);
    return window.scrollY;
  });
  expect(scrollY).toBeGreaterThan(0);
  await refreshed(page);
  await expect(page.locator('.asset-list')).toBeVisible();
  await expect(page.locator('.asset-grid')).toHaveCount(0);
  await expect(box(page, third)).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);

  // A deleted focused asset hands focus to a meaningful survivor.
  await item(page, '03-draft.png').focus();
  f.remove('03-draft.png');
  await refreshed(page);
  await expect(item(page, '04-ref.jpg')).toBeFocused();
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');

  // Grid view keeps the cropped style chosen in place.
  await page.goto(`${baseURL}${f.url}?category=${f.categoryId}&view=grid`);
  await page.evaluate(() => { window.__sameDocument = true; });
  await page.locator('.asset-grid').evaluate((grid) => grid.setAttribute('data-grid-style', 'cropped'));
  await refreshed(page);
  await expect(page.locator('.asset-grid')).toHaveAttribute('data-grid-style', 'cropped');

  // Slideshow stays on the same asset, then falls to a neighbor once it is gone.
  await page.setViewportSize({ width: 1280, height: 900 });
  const scaffold = page.locator('[data-slideshow-scaffold]');
  const caption = scaffold.locator('.slideshow-caption');
  await page.locator('[data-slideshow-trigger]').click();
  await expect(scaffold).toBeVisible();
  await scaffold.locator('[data-slideshow-next]').click();
  await expect(caption).toHaveText('02-ref.jpg');
  await scaffold.locator('[data-slideshow-next]').click();
  await expect(caption).toHaveText('04-ref.jpg');
  await expect(scaffold.locator('[data-slideshow-status]')).toHaveText('3 of 5');

  await f.add('00-first.png');
  await refreshed(page);
  await expect(caption).toHaveText('04-ref.jpg');
  await expect(scaffold.locator('[data-slideshow-status]')).toHaveText('4 of 6');
  await expect(scaffold).toBeVisible();
  await expect(page.locator('[data-slideshow-trigger]')).toHaveAttribute('aria-expanded', 'true');

  f.remove('04-ref.jpg');
  await refreshed(page);
  await expect(caption).toHaveText('05-draft.png');
  await expect(scaffold.locator('[data-slideshow-status]')).toHaveText('4 of 5');
  await expect(scaffold.locator('img.slideshow-preview-img')).toHaveCount(1);

  // No duplicated listeners: one click moves one asset, one close closes.
  // Pointer activity first, since the controls auto-hide during the refreshes.
  await page.mouse.move(640, 300);
  await scaffold.locator('[data-slideshow-next]').click();
  await expect(scaffold.locator('[data-slideshow-status]')).toHaveText('5 of 5');
  await page.mouse.move(640, 320);
  await scaffold.locator('[data-slideshow-close]').click();
  await expect(scaffold).toBeHidden();
  await expect(page.locator('[data-slideshow-trigger]')).toBeFocused();
  await page.locator('[data-slideshow-trigger]').click();
  await expect(scaffold.locator('[data-slideshow-status]')).toHaveText('1 of 5');
  await page.mouse.move(640, 300);
  await scaffold.locator('[data-slideshow-close]').click();
  expect(fourth).toBeGreaterThan(0);
  expect(control.posts).toEqual([]);
  expect(errors).toEqual([]);
});

test('G: counts, cleanup, release options and archived state follow the server', async ({ page }) => {
  const f = await createProject('Refresh G');
  const { control, errors } = await open(page, `${f.url}?category=${f.categoryId}&view=list`);
  const cleanup = page.locator('[data-dialog-open="remove-missing-assets-dialog"]');
  const categorySummary = page.locator('#asset-category-filter summary');
  await expect(cleanup).toHaveCount(0);
  await expect(categorySummary).toContainText(`WIP (${FILES.length})`);
  await expect(page.locator('[data-selected-count]')).toHaveText(`0 of ${FILES.length} selected`);
  await expect(page.locator('#remove-missing-assets-dialog')).toHaveCount(0);

  // A selected asset that goes missing stops being selectable.
  const second = f.assetId('02-ref.jpg');
  await select(page, second);
  f.markMissing('02-ref.jpg');
  await refreshed(page);
  await expect(cleanup).toHaveCount(1);
  await expect(page.locator('[data-selected-count]')).toHaveText(`0 of ${FILES.length} selected`);
  await cleanup.click();
  await expect(page.locator('#remove-missing-assets-dialog')).toBeVisible();
  await page.locator('#remove-missing-assets-dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('#remove-missing-assets-dialog')).toBeHidden();

  f.remove('02-ref.jpg');
  f.remove('06-ref.jpg');
  await refreshed(page);
  await expect(cleanup).toHaveCount(0);
  await expect(page.locator('#remove-missing-assets-dialog')).toHaveCount(0);
  await expect(categorySummary).toContainText(`WIP (${FILES.length - 2})`);
  await expect(page.locator('[data-selected-count]')).toHaveText(`0 of ${FILES.length - 2} selected`);

  // Newly eligible release targets, with the chosen draft kept.
  const releaseService = createReleaseService({ db });
  const firstRelease = releaseService.createReleaseWithSelectedAssets(f.id, { title: 'Refresh target one' }, [f.assetId('01-draft.png')]);
  await refreshed(page);
  const releaseSelect = page.locator('#releaseId-action-native');
  await expect(releaseSelect.locator(`option[value="${firstRelease.id}"]`)).toHaveCount(1);
  await releaseSelect.evaluate((select, value) => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }, String(firstRelease.id));
  const secondRelease = releaseService.createReleaseWithSelectedAssets(f.id, { title: 'Refresh target two' }, [f.assetId('03-draft.png')]);
  await refreshed(page);
  await expect(releaseSelect.locator(`option[value="${secondRelease.id}"]`)).toHaveCount(1);
  await expect(releaseSelect).toHaveValue(String(firstRelease.id));
  await expect(item(page, '01-draft.png').locator('[data-asset-release-section]')).toContainText('Refresh target one');

  // Archived is represented only by the server's answer.
  await expect(page.locator('[data-project-assets-archived-notice]')).toHaveCount(0);
  app.locals.projectService.archive(f.id);
  await refreshed(page);
  await expect(page.locator('[data-project-assets-archived-notice]')).toBeVisible();
  await expect(page.locator('[data-asset-selection-form]')).toHaveCount(0);
  await expect(page.locator('form[action$="/scan/manual"]')).toHaveCount(0);
  expect(control.posts).toEqual([]);
  expect(errors).toEqual([]);
});
