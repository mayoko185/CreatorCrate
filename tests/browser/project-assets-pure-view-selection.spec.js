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

/*
 * Milestone 3 F10 — a pure Grid/List View change on Project Assets keeps the
 * user's selection by asset identity (shown and retained hidden), while a
 * genuine filter change, Reset filters, or a View click joined to a pending
 * filter still starts a new selection. Hidden retained identities are never
 * submitted. Requests are held or failed through route gates, never sleeps.
 * All data lives in a temporary root that is removed afterward.
 */

const FILES = ['01-draft.png', '02-ref.jpg', '03-draft.png', '04-ref.jpg', '05-draft.jpg', '06-ref.png'];

let server;
let db;
let app;
let root;
let projectsRoot;
let baseURL;

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-pa-pure-view-browser-'));
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

test.beforeEach(() => {
  app.locals.pageDefaultsService.resetGlobalPageDefaults('projectAssets');
});

async function createProject(title) {
  const project = app.locals.projectService.create({ title, status: 'tbd' });
  const categories = app.locals.projectAssetCategoryService;
  if (!categories.list(project.id).some((candidate) => candidate.directory_slug === 'wip')) {
    categories.add(project.id, { displayName: 'WIP', directorySlug: 'wip' });
  }
  const category = categories.list(project.id).find((candidate) => candidate.directory_slug === 'wip');
  const categoryDir = path.join(projectsRoot, project.project_dir, 'wip');
  fs.mkdirSync(categoryDir, { recursive: true });
  for (const [index, filename] of FILES.entries()) {
    const image = sharp({ create: { width: 12, height: 12, channels: 3, background: { r: index * 30, g: 90, b: 160 } } });
    await (filename.endsWith('.png') ? image.png() : image.jpeg()).toFile(path.join(categoryDir, filename));
  }
  app.locals.assetScanner.scanProjectAssets(project.id);
  const id = (filename) => db.prepare('SELECT id FROM assets WHERE project_id = ? AND filename = ?').get(project.id, filename).id;
  const ids = Object.fromEntries(FILES.map((filename) => [filename, id(filename)]));
  return {
    id: project.id,
    categoryId: category.id,
    ids,
    files: () => fs.readdirSync(categoryDir).sort(),
    url: (query = '') => `${baseURL}/projects/${project.id}/assets${query ? `?${query}` : ''}`,
    // Moves the asset out of (or back into) a search=draft view without a new identity.
    renameRow(assetId, to) {
      db.prepare('UPDATE assets SET filename = ?, relative_path = ? WHERE id = ?').run(to, `wip/${to}`, assetId);
    },
  };
}

function defaultsRows() {
  return {
    global: db.prepare("SELECT key, value FROM app_meta WHERE key LIKE 'page_defaults.project_assets.%' ORDER BY key").all(),
    project: db.prepare("SELECT project_id, option_key, value FROM project_page_defaults WHERE page_key = 'projectAssets' ORDER BY project_id, option_key").all(),
    scopes: db.prepare("SELECT project_id, active_scope FROM project_page_default_scopes WHERE page_key = 'projectAssets' ORDER BY project_id").all(),
  };
}

const region = (page) => page.locator('[data-project-assets-live-region]');
const filterDialog = (page) => page.locator('#project-assets-filter-dialog');
const settled = (page) => expect(region(page)).not.toHaveAttribute('aria-busy', 'true');
const query = (page) => new URL(page.url()).searchParams;
const viewLink = (page, view) => page.locator(`nav.view-switcher a[aria-label="${view === 'list' ? 'List' : 'Grid'} view"]`);
const failureNotice = (page) => page.locator('[data-live-filter-failure]');
const retry = (page) => page.locator('[data-live-filter-retry]');
const countText = (page) => region(page).locator('[data-selected-count]');
const box = (page, id) => region(page).locator(`input[name="selectedAssetIds"][value="${id}"]`);
const surface = (page) => region(page).locator('[data-auto-rename-surface]');
const orderInput = (page) => page.locator('[data-auto-rename-order-input]');
const orderValue = async (page) => JSON.parse(await orderInput(page).inputValue());
const storage = (page) => page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)])));

// Checked rendered checkboxes, sorted: exactly what a bulk form can submit.
const checkedIds = (page) => region(page).locator('input[type="checkbox"][name="selectedAssetIds"]')
  .evaluateAll((inputs) => inputs.filter((input) => input.checked).map((input) => Number(input.value)).sort((a, b) => a - b));
// Rendered result IDs in display order.
const renderedIds = (page) => region(page).locator('input[type="checkbox"][name="selectedAssetIds"]')
  .evaluateAll((inputs) => inputs.map((input) => Number(input.value)));
// The native Add-to-release form payload: what its submit would send.
const bulkPayload = (page) => page.evaluate(() => new FormData(document.getElementById('bulk-select-form'))
  .getAll('selectedAssetIds').map(Number).sort((a, b) => a - b));
// Retained hidden identities held by the selection model.
const retainedIds = (page) => page.evaluate(() => (document.__creatorCrateRetainedAssetSelection || []).map(Number));

async function expectPresentation(page, view) {
  await settled(page);
  if (view === 'list') {
    await expect(region(page).locator('ul.asset-list')).toBeVisible();
    await expect(region(page).locator('ul.asset-grid')).toHaveCount(0);
  } else {
    await expect(region(page).locator('ul.asset-grid')).toBeVisible();
    await expect(region(page).locator('ul.asset-list')).toHaveCount(0);
  }
  await expect(viewLink(page, view)).toHaveAttribute('aria-current', 'page');
  expect(query(page).get('view') ?? 'grid').toBe(view);
}

async function select(page, id) {
  await region(page).locator(`label[for$="-select-${id}"]`).click();
  await expect(box(page, id)).toBeChecked();
}

async function openFilters(page) {
  if (!(await filterDialog(page).isVisible())) {
    await page.getByRole('link', { name: 'Filters & Defaults', exact: true }).click();
  }
  await expect(filterDialog(page)).toBeVisible();
}

async function closeFilters(page) {
  if (!(await filterDialog(page).isVisible())) return;
  await filterDialog(page).getByRole('button', { name: 'Close Filters & Defaults', exact: true }).click();
  await expect(filterDialog(page)).toBeHidden();
}

async function toggleOption(page, dropdownId, value) {
  const dropdown = page.locator(`#${dropdownId}`);
  if (!(await dropdown.evaluate((node) => node.open))) await dropdown.locator('summary').click();
  await dropdown.locator('label').filter({ has: page.locator(`input[value="${value}"]`) }).first().click();
  if (await dropdown.evaluate((node) => node.open)) await dropdown.locator('summary').click();
}

function watch(page) {
  const control = { posts: [], gets: [], errors: [] };
  page.on('pageerror', (error) => control.errors.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() !== 'GET') control.posts.push(`${request.method()} ${url.pathname}`);
    else if (/^\/projects\/\d+\/assets$/.test(url.pathname) && request.resourceType() === 'fetch'
      && !request.redirectedFrom()) control.gets.push(url);
  });
  return control;
}

async function gateAssetGets(page) {
  const control = { rules: [] };
  await page.route((url) => /^\/projects\/\d+\/assets$/.test(url.pathname), async (route) => {
    const request = route.request();
    if (request.method() !== 'GET' || request.resourceType() !== 'fetch') return route.continue();
    const url = new URL(request.url());
    const index = control.rules.findIndex((rule) => rule.match(url));
    if (index === -1) return route.continue();
    const [rule] = control.rules.splice(index, 1);
    rule.arrived(url);
    const action = await rule.decision;
    try {
      if (action === 'fail') await route.fulfill({ status: 500, body: 'failed' });
      else await route.continue();
    } catch {
      // The page aborted this request when a newer navigation superseded it.
    }
    return undefined;
  });
  control.next = (match, { fail = false } = {}) => {
    const rule = { match };
    const arrival = new Promise((resolve) => { rule.arrived = resolve; });
    let decide;
    rule.decision = new Promise((resolve) => { decide = resolve; });
    if (fail) decide('fail');
    control.rules.push(rule);
    return { arrival, release: () => decide('continue') };
  };
  return control;
}

const isView = (view) => (url) => (url.searchParams.get('view') ?? 'grid') === view && !url.searchParams.has('resetFilters');

// A post-mutation refresh, as a category change elsewhere dispatches it.
async function mutationRefresh(page) {
  await region(page).evaluate((node) => { node.dataset.beforeRefresh = 'true'; });
  await page.evaluate(() => document.dispatchEvent(new Event('project-asset-categories-changed')));
  await expect(page.locator('[data-project-assets-live-region]:not([data-before-refresh])')).toHaveCount(1);
  await settled(page);
}

test('A/B: Grid -> List -> Grid keeps two selected identities, writes nothing and keeps defaults', async ({ page }) => {
  const f = await createProject('F10 Pure View');
  const a = f.ids['01-draft.png'];
  const c = f.ids['03-draft.png'];
  const control = watch(page);
  await page.goto(f.url(`category=${f.categoryId}`));
  await expectPresentation(page, 'grid');
  const rowsBefore = defaultsRows();
  const sizesBefore = await storage(page);
  const order = await orderValue(page);
  const shown = await renderedIds(page);
  expect(shown).toHaveLength(FILES.length);

  await select(page, a);
  await select(page, c);
  await expect(countText(page)).toHaveText('2 of 6 selected');

  await viewLink(page, 'list').click();
  await expectPresentation(page, 'list');
  expect(await renderedIds(page)).toEqual(shown);
  expect(await checkedIds(page)).toEqual([a, c].sort((x, y) => x - y));
  await expect(countText(page)).toHaveText('2 of 6 selected');
  await expect(region(page).locator('li.is-selected, [aria-selected="true"].is-selected')).toHaveCount(2);
  expect(await bulkPayload(page)).toEqual([a, c].sort((x, y) => x - y));
  expect(await retainedIds(page)).toEqual([]);
  expect(query(page).get('category')).toBe(String(f.categoryId));
  await expect(surface(page)).toHaveAttribute('data-auto-rename-view', 'list');
  await expect(page.locator('[data-auto-rename-submit]')).toBeEnabled();

  await viewLink(page, 'grid').click();
  await expectPresentation(page, 'grid');
  expect(await checkedIds(page)).toEqual([a, c].sort((x, y) => x - y));
  await expect(countText(page)).toHaveText('2 of 6 selected');
  expect(await bulkPayload(page)).toEqual([a, c].sort((x, y) => x - y));
  expect(await orderValue(page)).toEqual(order);

  expect(control.gets).toHaveLength(2);
  expect(control.posts).toEqual([]);
  expect(defaultsRows()).toEqual(rowsBefore);
  expect(await storage(page)).toEqual(sizesBefore);
  expect(f.files()).toEqual([...FILES].sort());
  await expect(failureNotice(page)).toHaveCount(0);

  // Reload shows the addressed View and results; the count matches its boxes.
  await page.reload();
  await expectPresentation(page, 'grid');
  const afterReload = await checkedIds(page);
  await expect(countText(page)).toHaveText(`${afterReload.length} of 6 selected`);
  expect(control.errors).toEqual([]);
});

test('C/E-stale: rapid Grid -> List -> Grid keeps the selection once; the held List response never installs', async ({ page }) => {
  const f = await createProject('F10 Rapid');
  const a = f.ids['01-draft.png'];
  const b = f.ids['02-ref.jpg'];
  const control = watch(page);
  const gate = await gateAssetGets(page);
  await page.goto(f.url(`category=${f.categoryId}`));
  await select(page, a);
  await select(page, b);

  const held = gate.next(isView('list'));
  await viewLink(page, 'list').click();
  await held.arrival;
  await viewLink(page, 'grid').click();
  await expectPresentation(page, 'grid');
  expect(await checkedIds(page)).toEqual([a, b].sort((x, y) => x - y));
  await expect(countText(page)).toHaveText('2 of 6 selected');

  held.release();
  await expect.poll(() => checkedIds(page)).toEqual([a, b].sort((x, y) => x - y));
  await expectPresentation(page, 'grid');
  expect(new Set(await renderedIds(page)).size).toBe(FILES.length);
  expect(await bulkPayload(page)).toEqual([a, b].sort((x, y) => x - y));
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('D/J: a hidden retained selection survives pure View changes and is never submitted', async ({ page }) => {
  const f = await createProject('F10 Hidden');
  const a = f.ids['01-draft.png'];
  const c = f.ids['03-draft.png'];
  const control = watch(page);
  await page.goto(f.url(`category=${f.categoryId}&search=draft`));
  await select(page, a);
  await select(page, c);
  await expect(countText(page)).toHaveText('2 of 3 selected');

  // A mutation moves 03 out of this search; the refresh retains it hidden.
  f.renameRow(c, '03-moved.png');
  await mutationRefresh(page);
  await expect(box(page, c)).toHaveCount(0);
  await expect(countText(page)).toHaveText('1 of 2 selected (1 more not shown)');
  expect(await retainedIds(page)).toEqual([c]);

  for (const view of ['list', 'grid', 'list']) {
    await viewLink(page, view).click();
    await expectPresentation(page, view);
    await expect(countText(page)).toHaveText('1 of 2 selected (1 more not shown)');
    expect(await checkedIds(page)).toEqual([a]);
    expect(await retainedIds(page)).toEqual([c]);
    await expect(box(page, c)).toHaveCount(0);
    expect(await bulkPayload(page)).toEqual([a]);
  }
  expect(query(page).get('search')).toBe('draft');

  // Auto Rename Preview schedules only the shown selection.
  const submit = page.locator('[data-auto-rename-submit]');
  await expect(submit).toBeEnabled();
  const [preview] = await Promise.all([
    page.waitForRequest((request) => request.method() === 'POST'
      && new URL(request.url()).pathname === `/projects/${f.id}/assets/auto-rename/preview`),
    submit.click(),
  ]);
  const body = new URLSearchParams(preview.postData() || '');
  expect(JSON.parse(body.get('selectedAssetIds'))).toEqual([a]);
  const dialog = page.locator('#auto-rename-confirmation-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(f.files()).toEqual([...FILES].sort());

  // Shown again by a later refresh, the retained identity is selected again.
  f.renameRow(c, '03-draft.png');
  await mutationRefresh(page);
  await expect(box(page, c)).toBeChecked();
  expect(await retainedIds(page)).toEqual([]);
  await expect(countText(page)).toHaveText('2 of 3 selected');
  expect(control.posts).toEqual([`POST /projects/${f.id}/assets/auto-rename/preview`]);
  expect(control.errors).toEqual([]);
});

test('E: genuine Extension and Category changes still start a new selection', async ({ page }) => {
  const f = await createProject('F10 Filter Clears');
  const a = f.ids['01-draft.png'];
  const c = f.ids['03-draft.png'];
  const control = watch(page);
  await page.goto(f.url(`category=${f.categoryId}&search=draft`));
  await select(page, a);
  await select(page, c);
  f.renameRow(c, '03-moved.png');
  await mutationRefresh(page);
  expect(await retainedIds(page)).toEqual([c]);

  await openFilters(page);
  await toggleOption(page, 'asset-extension-filter', 'png');
  await settled(page);
  expect(query(page).getAll('extension')).toEqual(['png']);
  expect(await checkedIds(page)).toEqual([]);
  expect(await retainedIds(page)).toEqual([]);
  await expect(countText(page)).toHaveText(/^0 of \d+ selected$/);
  await closeFilters(page);

  await select(page, a);
  await openFilters(page);
  await toggleOption(page, 'asset-category-filter', 'all');
  await settled(page);
  expect(query(page).get('category')).toBe('all');
  expect(await checkedIds(page)).toEqual([]);
  expect(await retainedIds(page)).toEqual([]);
  await closeFilters(page);
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('F: a View click joined to a pending Search is a filter change and clears', async ({ page }) => {
  const f = await createProject('F10 Search View');
  const a = f.ids['02-ref.jpg'];
  const control = watch(page);
  const gate = await gateAssetGets(page);
  await page.goto(f.url(`category=${f.categoryId}`));
  await select(page, f.ids['01-draft.png']);
  await select(page, a);

  await openFilters(page);
  const held = gate.next((url) => url.searchParams.get('search') === 'draft' && isView('grid')(url));
  await page.locator('#search').fill('draft');
  await held.arrival;
  await closeFilters(page);
  await viewLink(page, 'list').click();
  await expectPresentation(page, 'list');
  held.release();

  expect(query(page).get('search')).toBe('draft');
  expect(await checkedIds(page)).toEqual([]);
  expect(await retainedIds(page)).toEqual([]);
  await expect(countText(page)).toHaveText('0 of 3 selected');
  expect(control.gets.at(-1).searchParams.get('view')).toBe('list');
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('G: a failed pure View GET keeps the selection; GET-only Retry installs List with it', async ({ page }) => {
  const f = await createProject('F10 Failed View');
  const a = f.ids['04-ref.jpg'];
  const c = f.ids['06-ref.png'];
  const control = watch(page);
  const gate = await gateAssetGets(page);
  await page.goto(f.url(`category=${f.categoryId}`));
  await select(page, a);
  await select(page, c);

  const failed = gate.next(isView('list'), { fail: true });
  await viewLink(page, 'list').click();
  await failed.arrival;
  await expect(failureNotice(page)).toBeVisible();
  await expect(region(page).locator('ul.asset-grid')).toBeVisible();
  expect(await checkedIds(page)).toEqual([a, c].sort((x, y) => x - y));
  await expect(countText(page)).toHaveText('2 of 6 selected');
  expect(await bulkPayload(page)).toEqual([a, c].sort((x, y) => x - y));

  await retry(page).first().click();
  await expectPresentation(page, 'list');
  await expect(failureNotice(page)).toHaveCount(0);
  expect(await checkedIds(page)).toEqual([a, c].sort((x, y) => x - y));
  await expect(countText(page)).toHaveText('2 of 6 selected');
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('H: Back/Forward between the Views of one filter context keep the selection', async ({ page }) => {
  const f = await createProject('F10 History');
  const a = f.ids['05-draft.jpg'];
  const control = watch(page);
  await page.goto(f.url(`category=${f.categoryId}&sort=size&order=desc`));
  await select(page, a);
  await viewLink(page, 'list').click();
  await expectPresentation(page, 'list');
  expect(await checkedIds(page)).toEqual([a]);

  await page.goBack();
  await expect.poll(() => query(page).get('view')).toBeNull();
  await expectPresentation(page, 'grid');
  expect(await checkedIds(page)).toEqual([a]);
  await page.goForward();
  await expect.poll(() => query(page).get('view')).toBe('list');
  await expectPresentation(page, 'list');
  expect(await checkedIds(page)).toEqual([a]);
  expect(query(page).get('sort')).toBe('size');
  await expect(countText(page)).toHaveText('1 of 6 selected');
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('I: a pending filtered reorder draft and the selection survive Grid -> List -> Grid; Preview/Cancel use them', async ({ page }) => {
  const f = await createProject('F10 Order Draft');
  const first = f.ids['01-draft.png'];
  const third = f.ids['03-draft.png'];
  const control = watch(page);
  await page.goto(f.url(`category=${f.categoryId}&extension=png`));
  await expect(surface(page)).toHaveAttribute('data-category-reorder-enabled', 'true');
  const saved = await orderValue(page);

  // Keyboard reorder: 03-draft.png moves before 01-draft.png; JPEG slots stay.
  const item = surface(page).locator('[data-auto-rename-asset][aria-label="Reorder 03-draft.png"]');
  await item.focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
  await expect.poll(() => orderValue(page)).not.toEqual(saved);
  const draft = await orderValue(page);
  expect(JSON.parse(await surface(page).getAttribute('data-auto-rename-base-order'))).toEqual(saved);
  expect(draft).not.toEqual(saved);
  expect(draft.filter((id) => ![first, third].includes(id)))
    .toEqual(saved.filter((id) => ![first, third].includes(id)));
  await select(page, first);
  await select(page, third);

  for (const view of ['list', 'grid']) {
    await viewLink(page, view).click();
    await expectPresentation(page, view);
    await expect(surface(page)).toHaveAttribute('data-auto-rename-draft', 'true');
    expect(await orderValue(page)).toEqual(draft);
    expect(await checkedIds(page)).toEqual([first, third].sort((x, y) => x - y));
    await expect(countText(page)).toHaveText('2 of 3 selected');
  }
  expect(control.posts).toEqual([]);

  const [preview] = await Promise.all([
    page.waitForRequest((request) => request.method() === 'POST'
      && new URL(request.url()).pathname === `/projects/${f.id}/assets/auto-rename/preview`),
    page.locator('[data-auto-rename-submit]').click(),
  ]);
  const body = new URLSearchParams(preview.postData() || '');
  expect(JSON.parse(body.get('orderedAssetIds'))).toEqual(draft);
  expect(JSON.parse(body.get('selectedAssetIds')).sort((x, y) => x - y)).toEqual([first, third].sort((x, y) => x - y));
  const dialog = page.locator('#auto-rename-confirmation-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await orderValue(page)).toEqual(draft);
  expect(await checkedIds(page)).toEqual([first, third].sort((x, y) => x - y));
  expect(f.files()).toEqual([...FILES].sort());
  expect(control.posts).toEqual([`POST /projects/${f.id}/assets/auto-rename/preview`]);
  expect(control.errors).toEqual([]);
});

test('K: a live Grid style change and later View changes keep the selection', async ({ page }) => {
  const f = await createProject('F10 Grid Style');
  const a = f.ids['02-ref.jpg'];
  const control = watch(page);
  await page.goto(f.url(`category=${f.categoryId}`));
  const rowsBefore = defaultsRows();
  await select(page, a);

  await openFilters(page);
  const dropdown = filterDialog(page).locator('#projectAssets-default-gridStyle-dropdown');
  await dropdown.locator('summary').click();
  await dropdown.locator('label').filter({ hasText: /^\s*Cropped\s*$/ }).click();
  await expect(region(page).locator('.asset-grid')).toHaveAttribute('data-grid-style', 'cropped');
  await closeFilters(page);
  expect(await checkedIds(page)).toEqual([a]);

  await viewLink(page, 'list').click();
  await expectPresentation(page, 'list');
  expect(await checkedIds(page)).toEqual([a]);
  await viewLink(page, 'grid').click();
  await expectPresentation(page, 'grid');
  expect(await checkedIds(page)).toEqual([a]);
  await expect(countText(page)).toHaveText('1 of 6 selected');
  expect(control.posts).toEqual([]);
  expect(defaultsRows()).toEqual(rowsBefore);
  expect(control.errors).toEqual([]);
});

test('L: Reset filters + View keeps F7 composition and its selection-clearing contract', async ({ page }) => {
  const f = await createProject('F10 Reset View');
  const a = f.ids['01-draft.png'];
  const control = watch(page);
  const gate = await gateAssetGets(page);
  await page.goto(f.url(`category=${f.categoryId}&extension=png`));
  const rowsBefore = defaultsRows();
  await select(page, a);

  await openFilters(page);
  const held = gate.next((url) => url.searchParams.has('resetFilters'));
  await filterDialog(page).locator('[data-project-assets-reset]').click();
  await held.arrival;
  await closeFilters(page);
  await viewLink(page, 'list').click();
  held.release();

  await expectPresentation(page, 'list');
  expect(query(page).has('resetFilters')).toBe(false);
  expect(query(page).getAll('extension')).toEqual([]);
  expect(await renderedIds(page)).toHaveLength(FILES.length);
  expect(await checkedIds(page)).toEqual([]);
  expect(await retainedIds(page)).toEqual([]);
  expect(control.posts).toEqual([]);
  expect(defaultsRows()).toEqual(rowsBefore);
  expect(control.errors).toEqual([]);
});
