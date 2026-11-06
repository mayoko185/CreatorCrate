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

// Auto Rename Preview, Cancel and Apply on the invoking Project Assets page in
// real Chromium: the document stays mounted, the reviewed complete order keeps
// hidden positions, Apply is sent at most once per review, and every outcome is
// reported from server state. All data lives in a temporary root removed afterward.
const FILES = ['a-shot.png', 'b-shot.jpg', 'c-shot.png', 'd-shot.jpg'];

let server;
let db;
let app;
let root;
let projectsRoot;
let baseURL;

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-auto-rename-dialog-'));
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

async function createProject(title, files = FILES) {
  const project = app.locals.projectService.create({ title, status: 'tbd' });
  const categories = app.locals.projectAssetCategoryService;
  if (!categories.list(project.id).some((candidate) => candidate.directory_slug === 'wip')) {
    categories.add(project.id, { displayName: 'WIP', directorySlug: 'wip' });
  }
  const category = categories.list(project.id).find((candidate) => candidate.directory_slug === 'wip');
  const projectDir = path.join(projectsRoot, project.project_dir);
  const categoryDir = path.join(projectDir, 'wip');
  fs.mkdirSync(categoryDir, { recursive: true });
  for (const [index, filename] of files.entries()) await writeImage(path.join(categoryDir, filename), index * 40);
  app.locals.assetScanner.scanProjectAssets(project.id);
  const { slug } = db.prepare('SELECT slug FROM projects WHERE id = ?').get(project.id);
  const assetId = (filename) => db.prepare('SELECT id FROM assets WHERE project_id = ? AND filename = ?').get(project.id, filename).id;
  return {
    id: project.id,
    categoryId: category.id,
    url: `/projects/${project.id}/assets`,
    assetId,
    generated: (number, extension) => `${slug}-wip-${String(number).padStart(2, '0')}.${extension}`,
    row: (id) => db.prepare('SELECT filename, relative_path FROM assets WHERE id = ?').get(id),
    onDisk: (filename) => fs.existsSync(path.join(categoryDir, filename)),
  };
}

// Records every non-GET request and lets a test hold, fail or rewrite the
// Project Assets refresh GET, the Preview and Apply POSTs and the state GET.
async function open(page, url, { viewport = { width: 1280, height: 900 } } = {}) {
  const control = {
    posts: [], previews: [], applies: [], gets: [], states: [],
    refresh: 'pass', preview: 'pass', apply: 'pass', state: 'pass',
    held: { refresh: [], preview: [], apply: [], state: [] },
  };
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.method() !== 'GET') control.posts.push(new URL(request.url()).pathname);
  });
  const handle = async (kind, route, list) => {
    list.push(route.request());
    const mode = control[kind];
    if (mode === 'hold') {
      control.held[kind].push(route);
      return undefined;
    }
    if (mode === 'fail') return route.fulfill({ status: 500, contentType: 'text/html', body: 'failed' });
    if (mode === 'lose') {
      // The request reaches the server and commits; its answer never arrives.
      await route.fetch();
      return route.abort('failed');
    }
    if (mode === 'unreadable') {
      await route.fetch();
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<p>proxy page</p>' });
    }
    return route.continue();
  };
  await page.route((target) => /^\/projects\/\d+\/assets$/.test(target.pathname), (route) => {
    if (route.request().resourceType() !== 'fetch') return route.fallback();
    return handle('refresh', route, control.gets);
  });
  await page.route('**/assets/auto-rename/preview', (route) => handle('preview', route, control.previews));
  await page.route('**/assets/auto-rename/apply', (route) => handle('apply', route, control.applies));
  await page.route('**/assets/auto-rename/state?*', (route) => handle('state', route, control.states));
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
const autoRename = (page) => page.locator('[data-auto-rename-submit]');
const dialog = (page) => page.locator('#auto-rename-confirmation-dialog');
const applyButton = (page) => dialog(page).getByRole('button', { name: 'Apply Auto Rename' });
const cancelButton = (page) => dialog(page).getByRole('button', { name: 'Cancel', exact: true });
const feedback = (page) => page.locator('[data-dialog-feedback]');
const orderValue = async (page) => JSON.parse(await page.locator('[data-auto-rename-order-input]').inputValue());
const names = (page) => items(page).evaluateAll((nodes) => nodes.map(
  (node) => node.getAttribute('aria-label').replace(/^Reorder /, ''),
));
const sameDocument = (page) => page.evaluate(() => window.__sameDocument === true);

async function select(page, id) {
  await page.locator(`label[for$="-select-${id}"]`).click();
  await expect(box(page, id)).toBeChecked();
}

async function moveBefore(page, name) {
  await item(page, name).focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
}

async function markRegion(page) {
  await region(page).evaluate((node) => { node.dataset.beforeRefresh = 'true'; });
}

async function expectInstalled(page) {
  await expect(page.locator('[data-project-assets-live-region]:not([data-before-refresh])')).toHaveCount(1);
  await expect(region(page)).not.toHaveAttribute('aria-busy', 'true');
}

function formFields(request) {
  return Object.fromEntries(new URLSearchParams(request.postData() || ''));
}

// Filtered to the PNGs (A, C), with C moved before A: complete order C, B, A, D.
async function filteredReview(page, f) {
  const [a, b, c, d] = FILES.map(f.assetId);
  expect(await names(page)).toEqual(['a-shot.png', 'c-shot.png']);
  await moveBefore(page, 'c-shot.png');
  expect(await orderValue(page)).toEqual([c, b, a, d]);
  await select(page, c);
  await select(page, a);
  return { a, b, c, d };
}

async function preview(page) {
  await autoRename(page).click();
  await expect(dialog(page)).toBeVisible();
}

test('A: Preview opens locally and Cancel sends no Apply and keeps the page state', async ({ page }) => {
  const f = await createProject('Dialog A');
  const { control, errors } = await open(page, `${f.url}?category=${f.categoryId}`);
  const [a, b, c, d] = FILES.map(f.assetId);
  const startUrl = page.url();
  await moveBefore(page, 'c-shot.png');
  await select(page, a);
  const order = await orderValue(page);
  expect(order).toEqual([a, c, b, d]);

  await preview(page);
  expect(page.url()).toBe(startUrl);
  expect(await sameDocument(page)).toBe(true);
  await expect(dialog(page).locator('h2')).toHaveText('Auto Rename confirmation');
  await expect(dialog(page).locator('.auto-rename-confirmation-summary')).toContainText('1 asset:');
  await expect(dialog(page).locator('.auto-rename-confirmation-name--current')).toContainText('a-shot.png');
  await expect(dialog(page).locator('.auto-rename-confirmation-name--proposed')).toContainText(f.generated(1, 'png'));
  await expect(applyButton(page)).toBeEnabled();

  await cancelButton(page).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(autoRename(page)).toBeFocused();
  expect(control.applies).toHaveLength(0);
  expect(control.posts).toEqual([`/projects/${f.id}/assets/auto-rename/preview`]);
  expect(page.url()).toBe(startUrl);
  expect(await sameDocument(page)).toBe(true);
  await expect(box(page, a)).toBeChecked();
  expect(await orderValue(page)).toEqual(order);
  expect(f.row(a).filename).toBe('a-shot.png');

  // Escape dismisses a fresh review the same way; the backdrop follows the binder.
  await preview(page);
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await expect(autoRename(page)).toBeFocused();
  expect(control.applies).toHaveLength(0);
  expect(control.previews).toHaveLength(2);
  expect(errors).toEqual([]);
});

test('B: a filtered subset previews the complete order with hidden positions and only the visible selection', async ({ page }) => {
  const f = await createProject('Dialog B');
  const { control, errors } = await open(page, `${f.url}?category=${f.categoryId}&extension=png`);
  const { a, b, c, d } = await filteredReview(page, f);

  const response = page.waitForResponse('**/assets/auto-rename/preview');
  await preview(page);
  const payload = await (await response).json();
  const sent = formFields(control.previews[0]);
  expect(JSON.parse(sent.orderedAssetIds)).toEqual([c, b, a, d]);
  expect(JSON.parse(sent.selectedAssetIds)).toEqual([c, a]);
  expect(sent.categoryId).toBe(String(f.categoryId));
  expect(payload.orderedAssetIds).toEqual([c, b, a, d]);
  expect([...payload.selectedAssetIds].sort((x, y) => x - y)).toEqual([a, c].sort((x, y) => x - y));
  expect(payload.items.map((entry) => entry.assetId)).toEqual([c, a]);
  expect(payload.items.map((entry) => entry.proposedRelativePath)).toEqual([`wip/${f.generated(1, 'png')}`, `wip/${f.generated(2, 'png')}`]);
  await expect(dialog(page).locator('.auto-rename-confirmation-item')).toHaveCount(2);
  await expect(dialog(page)).not.toContainText('b-shot.jpg');
  await expect(dialog(page)).not.toContainText('d-shot.jpg');
  expect(await box(page, b).count()).toBe(0);
  await cancelButton(page).click();
  expect(await orderValue(page)).toEqual([c, b, a, d]);
  expect(control.applies).toHaveLength(0);
  expect(errors).toEqual([]);
});

test('C: Apply renames once, refreshes in place and retires the review', async ({ page }) => {
  const f = await createProject('Dialog C');
  const { control, errors } = await open(page, `${f.url}?category=${f.categoryId}&extension=png&view=list`);
  const startUrl = page.url();
  const { a, b, c, d } = await filteredReview(page, f);
  await preview(page);
  await markRegion(page);
  await applyButton(page).click();

  await expect(dialog(page)).toHaveCount(0);
  await expectInstalled(page);
  await expect(feedback(page)).toHaveText('Renamed 2 assets. Skipped 0 unchanged assets.');
  expect(control.applies).toHaveLength(1);
  // Token-only Apply: the browsing context round-trips, no order, selection or path does.
  const applied = formFields(control.applies[0]);
  expect(applied.planToken).toBeTruthy();
  expect(applied).toMatchObject({ categoryId: String(f.categoryId), extension: 'png', view: 'list' });
  expect(Object.keys(applied)).not.toEqual(expect.arrayContaining(['orderedAssetIds']));
  expect(Object.keys(applied).filter((key) => /selected|ordered|proposed|path/i.test(key))).toEqual([]);
  expect(f.row(c)).toMatchObject({ filename: f.generated(1, 'png'), relative_path: `wip/${f.generated(1, 'png')}` });
  expect(f.row(a)).toMatchObject({ filename: f.generated(2, 'png'), relative_path: `wip/${f.generated(2, 'png')}` });
  expect(f.row(b).filename).toBe('b-shot.jpg');
  expect(f.row(d).filename).toBe('d-shot.jpg');
  expect(f.onDisk(f.generated(1, 'png'))).toBe(true);
  expect(f.onDisk('a-shot.png')).toBe(false);

  // Same document, URL, filter and presentation; current names and selection.
  expect(page.url()).toBe(startUrl);
  expect(await sameDocument(page)).toBe(true);
  expect(await names(page)).toEqual([f.generated(1, 'png'), f.generated(2, 'png')]);
  await expect(page.locator('.asset-list')).toHaveCount(1);
  await expect(box(page, a)).toBeChecked();
  await expect(box(page, c)).toBeChecked();
  expect(control.posts.filter((post) => !post.endsWith('/auto-rename/preview'))).toEqual([`/projects/${f.id}/assets/auto-rename/apply`]);

  // Another Apply needs a fresh review.
  await preview(page);
  expect(control.previews).toHaveLength(2);
  await expect(dialog(page).locator('.auto-rename-confirmation-notice')).toContainText('no changes to apply');
  await expect(applyButton(page)).toBeDisabled();
  await cancelButton(page).click();
  expect(control.applies).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('D: stale and tampered plans are refused locally with nothing renamed', async ({ page }) => {
  const f = await createProject('Dialog D');
  const { control, errors } = await open(page, `${f.url}?category=${f.categoryId}&extension=png`);
  const { a, b, c, d } = await filteredReview(page, f);

  await preview(page);
  db.prepare('UPDATE assets SET modified_at = ? WHERE id = ?').run('2001-01-01T00:00:00.000Z', a);
  await applyButton(page).click();
  await expect(dialog(page).locator('[data-dialog-error-text]')).toContainText('The rename preview is no longer current.');
  await expect(dialog(page).locator('[data-dialog-error-text]')).toContainText('choose Auto Rename again');
  await expect(applyButton(page)).toBeDisabled();
  await applyButton(page).evaluate((button) => button.form.requestSubmit());
  await expect(cancelButton(page)).toBeFocused();
  expect(control.applies).toHaveLength(1);
  expect(f.row(a).filename).toBe('a-shot.png');
  expect(f.row(c).filename).toBe('c-shot.png');
  await cancelButton(page).click();
  expect(await sameDocument(page)).toBe(true);
  expect(await orderValue(page)).toEqual([c, b, a, d]);

  // A fresh review, then a tampered token.
  app.locals.assetScanner.scanProjectAssets(f.id);
  await preview(page);
  await dialog(page).locator('input[name="planToken"]').evaluate((input) => { input.value = `${input.value.slice(0, -4)}AAAA`; });
  await applyButton(page).click();
  // A tampered token is not the plan its Apply attempt reviewed.
  await expect(dialog(page).locator('[data-dialog-error-text]')).toContainText('This Auto Rename review is no longer available. No files were renamed.');
  await expect(applyButton(page)).toBeDisabled();
  expect(control.applies).toHaveLength(2);
  expect(f.row(a).filename).toBe('a-shot.png');
  expect(f.row(c).filename).toBe('c-shot.png');
  await cancelButton(page).click();
  expect(await sameDocument(page)).toBe(true);
  await expect(box(page, a)).toBeChecked();
  expect(errors).toEqual([]);
});

test('E: a failed refresh keeps the confirmed success and recovers through GET-only Retry', async ({ page }) => {
  const f = await createProject('Dialog E');
  const { control, errors } = await open(page, `${f.url}?category=${f.categoryId}&extension=png`);
  const { a, c } = await filteredReview(page, f);
  await preview(page);
  control.refresh = 'fail';
  await applyButton(page).click();

  await expect(feedback(page)).toContainText('Renamed 2 assets.');
  await expect(feedback(page)).toContainText('Project Assets could not refresh and may be outdated.');
  await expect(feedback(page)).toHaveClass(/notice--warning/);
  await expect(page.locator('[data-live-filter-retry]')).toBeVisible();
  expect(f.row(c).filename).toBe(f.generated(1, 'png'));
  expect(f.row(a).filename).toBe(f.generated(2, 'png'));

  control.refresh = 'pass';
  await markRegion(page);
  await page.locator('[data-live-filter-retry]').click();
  await expectInstalled(page);
  await expect(feedback(page)).toHaveText('Renamed 2 assets. Skipped 0 unchanged assets.');
  await expect(feedback(page)).toHaveClass(/notice--success/);
  expect(await names(page)).toEqual([f.generated(1, 'png'), f.generated(2, 'png')]);
  expect(control.applies).toHaveLength(1);
  expect(await sameDocument(page)).toBe(true);
  expect(errors).toEqual([]);
});

test('F: a lost Apply answer is settled by its recorded receipt through GETs without resending Apply', async ({ page }) => {
  const f = await createProject('Dialog F');
  const { control, errors } = await open(page, `${f.url}?category=${f.categoryId}&extension=png`);
  const startUrl = page.url();
  const { a, c } = await filteredReview(page, f);
  await preview(page);
  control.apply = 'lose';
  control.state = 'fail';
  await applyButton(page).click();

  const check = dialog(page).getByRole('button', { name: 'Check again' });
  await expect(check).toBeVisible();
  await expect(dialog(page).locator('[data-dialog-error-text]')).toContainText('Auto Rename may have been applied. It was not sent again.');
  await expect(applyButton(page)).toBeDisabled();
  expect(control.applies).toHaveLength(1);
  expect(control.states).toHaveLength(1);
  expect(f.row(c).filename).toBe(f.generated(1, 'png'));

  control.state = 'pass';
  await markRegion(page);
  await check.click();
  await expect(dialog(page)).toHaveCount(0);
  await expectInstalled(page);
  await expect(feedback(page)).toHaveText('Auto Rename was applied. Renamed 2 assets. Skipped 0 unchanged assets.');
  await expect(page.locator('[data-auto-rename-pending]')).toBeHidden();
  expect(control.states).toHaveLength(2);
  expect(new URL(control.states[1].url()).searchParams.get('categoryId')).toBe(String(f.categoryId));
  expect(new URL(control.states[1].url()).searchParams.get('attempt'))
    .toBe(new URLSearchParams(control.applies[0].postData()).get('attemptId'));
  expect(new URL(control.states[1].url()).searchParams.get('attempt')).toMatch(/^[0-9a-f]{32}$/);
  expect(control.applies).toHaveLength(1);
  // The reconciliation read is JSON only: the filtered view stays filtered.
  expect(page.url()).toBe(startUrl);
  expect(await names(page)).toEqual([f.generated(1, 'png'), f.generated(2, 'png')]);
  expect(await items(page).count()).toBe(2);
  expect(await box(page, a).isChecked()).toBe(true);
  expect(await sameDocument(page)).toBe(true);
  expect(errors).toEqual([]);
});

test('F2: an unreadable Apply answer is settled by its recorded refusal, not by file names', async ({ page }) => {
  const f = await createProject('Dialog F2');
  const { control, errors } = await open(page, `${f.url}?category=${f.categoryId}&extension=png`);
  const { a } = await filteredReview(page, f);
  await preview(page);
  // A stale plan: the server refuses, but the answer is replaced by an unreadable page.
  db.prepare('UPDATE assets SET modified_at = ? WHERE id = ?').run('2001-01-01T00:00:00.000Z', a);
  control.apply = 'unreadable';
  await applyButton(page).click();
  await expect(dialog(page).locator('[data-dialog-error-text]')).toContainText('The rename preview is no longer current.');
  await expect(dialog(page).locator('[data-dialog-error-text]')).toContainText('It was not sent again.');
  await expect(dialog(page).getByRole('button', { name: 'Check again' })).toHaveCount(0);
  await expect(page.locator('[data-auto-rename-pending]')).toBeHidden();
  await expect(applyButton(page)).toBeDisabled();
  expect(control.applies).toHaveLength(1);
  expect(f.row(a).filename).toBe('a-shot.png');
  await cancelButton(page).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(control.applies).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('G: an obsolete Preview never opens over a changed selection, order or newer Preview', async ({ page }) => {
  const f = await createProject('Dialog G');
  const { control, errors } = await open(page, `${f.url}?category=${f.categoryId}&extension=png`);
  const { a, b, c, d } = await filteredReview(page, f);

  control.preview = 'hold';
  await autoRename(page).click();
  await expect.poll(() => control.held.preview.length).toBe(1);
  await page.locator(`label[for$="-select-${a}"]`).click();
  await expect(box(page, a)).not.toBeChecked();
  await control.held.preview.shift().continue();
  await expect(page.locator('[data-auto-rename-live]')).toContainText('changed while the review loaded');
  await expect(dialog(page)).toHaveCount(0);

  // An order change while loading supersedes the review too.
  await autoRename(page).click();
  await expect.poll(() => control.held.preview.length).toBe(1);
  await moveBefore(page, 'a-shot.png');
  expect(await orderValue(page)).toEqual([a, b, c, d]);
  await control.held.preview.shift().continue();
  await expect(page.locator('[data-auto-rename-live]')).toContainText('changed while the review loaded');
  await expect(dialog(page)).toHaveCount(0);

  // Two quick Previews: only the newer one opens.
  await autoRename(page).click();
  await autoRename(page).click();
  await expect.poll(() => control.held.preview.length).toBe(2);
  const [older, newer] = control.held.preview.splice(0, 2);
  control.preview = 'pass';
  await newer.continue();
  await expect(dialog(page)).toBeVisible();
  await older.continue().catch(() => {});
  await expect(dialog(page)).toHaveCount(1);
  await expect(dialog(page).locator('.auto-rename-confirmation-item')).toHaveCount(1);
  await cancelButton(page).click();
  expect(control.applies).toHaveLength(0);
  expect(await sameDocument(page)).toBe(true);
  expect(errors).toEqual([]);
});

test('H: double-click, Enter and requestSubmit send one Apply per review', async ({ page }) => {
  const f = await createProject('Dialog H');
  const { control, errors } = await open(page, `${f.url}?category=${f.categoryId}&extension=png`);
  await filteredReview(page, f);
  await preview(page);
  control.apply = 'hold';
  await applyButton(page).dblclick();
  await expect.poll(() => control.held.apply.length).toBe(1);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await dialog(page).locator('form').evaluate((form) => { form.requestSubmit(); form.requestSubmit(); });
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).locator('form')).toHaveAttribute('aria-busy', 'true');
  expect(control.applies).toHaveLength(1);
  control.apply = 'pass';
  await control.held.apply.shift().continue();
  await expect(dialog(page)).toHaveCount(0);
  await expect(feedback(page)).toContainText('Renamed 2 assets.');
  expect(control.applies).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('I: a long-name review fits a narrow viewport and keeps grid style', async ({ page }) => {
  const long = 'a-very-long-reference-filename-that-keeps-going-for-layout-checking-purposes.png';
  const f = await createProject('Dialog I narrow layout with a long project title', [long, 'b-shot.jpg', 'c-shot.png']);
  const { control, errors } = await open(page, `${f.url}?category=${f.categoryId}&view=grid&gridStyle=uncropped`, {
    viewport: { width: 390, height: 844 },
  });
  const gridStyle = await page.locator('.asset-grid').getAttribute('data-grid-style');
  const ids = [long, 'b-shot.jpg', 'c-shot.png'].map(f.assetId);
  for (const id of ids) await select(page, id);
  await preview(page);
  await expect(dialog(page).locator('.auto-rename-confirmation-item')).toHaveCount(3);
  const layout = await page.evaluate(() => {
    const card = document.querySelector('#auto-rename-confirmation-dialog .app-dialog-card').getBoundingClientRect();
    return { left: card.left, right: card.right, width: window.innerWidth, scroll: document.documentElement.scrollWidth };
  });
  expect(layout.left).toBeGreaterThanOrEqual(0);
  expect(layout.right).toBeLessThanOrEqual(layout.width);
  expect(layout.scroll).toBeLessThanOrEqual(layout.width);
  await cancelButton(page).click();
  await expect(page.locator('.asset-grid')).toHaveAttribute('data-grid-style', gridStyle);
  expect(control.applies).toHaveLength(0);
  expect(errors).toEqual([]);
});
