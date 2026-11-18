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
import { PAGE_DEFAULT_DEFINITIONS } from '../../src/services/page-defaults-service.js';

/*
 * Filters & Defaults M3 F7 — a toolbar Grid/List click made while Project
 * Assets Reset filters is waiting for its server answer is newer View intent
 * for the Reset, not a request to abandon it. The Reset still restores every
 * effective saved/default filter, Sort and page size from the server, and the
 * clicked View is the only override. Requests are held or failed through route
 * gates, never through sleeps. All data lives in a temporary root that is
 * removed afterward.
 */

let server;
let db;
let app;
let root;
let projectsRoot;
let baseURL;

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-pa-reset-view-browser-'));
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

// Global Project Assets defaults are application-wide; each test starts clean.
test.beforeEach(() => {
  app.locals.pageDefaultsService.resetGlobalPageDefaults('projectAssets');
});

const PAGE = 'projectAssets';
const ORIGINAL_FILES = ['alpha-1.png', 'beta-2.jpg'];
// The reviewer's temporary state: PNG + Search Alpha + Filename/Ascending + 25.
const TEMPORARY = 'extension=png&search=alpha&sort=filename&order=asc&pageSize=25';
const RESTORED = { extension: ['jpg'], sort: 'size', order: 'desc', pageSize: '10' };

async function createProject(title, names = ORIGINAL_FILES) {
  const project = app.locals.projectService.create({ title, status: 'tbd' });
  const dir = path.join(projectsRoot, project.project_dir, 'final');
  fs.mkdirSync(dir, { recursive: true });
  for (const [index, name] of names.entries()) {
    // Distinct sizes so Sort by Size is observable.
    const side = 12 + index * 8;
    const image = sharp({ create: { width: side, height: side, channels: 3, background: { r: index * 60, g: 90, b: 160 } } });
    await (name.endsWith('.png') ? image.png() : image.jpeg()).toFile(path.join(dir, name));
  }
  app.locals.assetScanner.scanProjectAssets(project.id);
  const ids = Object.fromEntries(db.prepare('SELECT filename, id FROM assets WHERE project_id = ?')
    .all(project.id).map((row) => [row.filename, row.id]));
  return {
    id: project.id,
    ids,
    url: (search = '') => `${baseURL}/projects/${project.id}/assets${search ? `?${search}` : ''}`,
  };
}

// Stored exactly as the HTTP suites seed them: project rows with an active
// project scope, and global app_meta keys.
function saveProjectDefaults(projectId, values) {
  const repository = app.locals.projectPageDefaultRepository;
  repository.setPageScope(projectId, PAGE, 'project');
  Object.entries(values).forEach(([option, value]) => repository.setOption(projectId, PAGE, option, value));
}

function saveGlobalDefaults(values) {
  const write = db.prepare(`
    INSERT INTO app_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  Object.entries(values).forEach(([option, value]) => write.run(PAGE_DEFAULT_DEFINITIONS[PAGE][option].key, value));
}

// Every persisted Project Assets default: global keys, project rows and scopes.
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
const historyLength = (page) => page.evaluate(() => window.history.length);
const viewLink = (page, view) => page.locator(`nav.view-switcher a[aria-label="${view === 'list' ? 'List' : 'Grid'} view"]`);
const failureNotice = (page) => page.locator('[data-live-filter-failure]');
const defaultsForm = (page) => page.locator('#project-assets-defaults-form');
const scopeOf = (page) => defaultsForm(page).locator('input[name="scope"]:checked').inputValue();
const savedSnapshots = (page) => defaultsForm(page).locator('[data-project-assets-default-values]')
  .evaluate((element) => JSON.parse(element.textContent));
const storage = (page) => page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)])));

// Rendered asset IDs, in display order.
const renderedIds = (page) => region(page).locator('input[name="selectedAssetIds"]')
  .evaluateAll((inputs) => inputs.map((input) => Number(input.value)));

async function resultCount(page) {
  const count = region(page).locator('[data-selected-count]');
  if (await count.count() === 0) return 0;
  return Number(await count.getAttribute('data-selected-total'));
}

// The installed controls of #asset-filters, form-associated controls included.
const formState = (page) => page.evaluate(() => {
  const data = new FormData(document.getElementById('asset-filters'));
  return {
    extension: data.getAll('extension').filter((value) => value && value !== 'all'),
    search: data.get('search') || '',
    sort: data.get('sort'),
    order: data.get('order'),
    pageSize: data.get('pageSize'),
    view: document.getElementById('asset-view-filter')?.value,
    viewSummary: document.querySelector('#asset-view-filter-dropdown [data-cc-dropdown-summary-current]')?.textContent?.trim(),
  };
});

async function expectPresentation(page, view) {
  if (view === 'list') {
    await expect(region(page).locator('ul.asset-list')).toBeVisible();
    await expect(region(page).locator('ul.asset-grid')).toHaveCount(0);
  } else {
    await expect(region(page).locator('ul.asset-grid')).toBeVisible();
    await expect(region(page).locator('ul.asset-list')).toHaveCount(0);
  }
  await expect(viewLink(page, view)).toHaveAttribute('aria-current', 'page');
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

function watch(page) {
  const control = { posts: [], gets: [], errors: [] };
  page.on('pageerror', (error) => control.errors.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() !== 'GET') control.posts.push(`${request.method()} ${url.pathname}`);
    // A redirect hop (the Reset's 302 target) is the same request, not a new GET.
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
    return { arrival, release: () => decide('continue'), fail: () => decide('fail') };
  };
  return control;
}

const isReset = (url) => url.searchParams.has('resetFilters');

// Clicks Reset filters in the dialog and waits for its GET to be held.
async function startHeldReset(page, gate, { fail = false } = {}) {
  await openFilters(page);
  const held = gate.next(isReset, { fail });
  await filterDialog(page).locator('[data-project-assets-reset]').click();
  await held.arrival;
  await closeFilters(page);
  return held;
}

async function expectRestored(page, { view, ids, restored = RESTORED }) {
  await settled(page);
  await expectPresentation(page, view);
  expect(await renderedIds(page)).toEqual(ids);
  expect(await resultCount(page)).toBe(ids.length);
  const params = query(page);
  expect(params.has('resetFilters')).toBe(false);
  expect(params.has('search')).toBe(false);
  expect(params.has('page')).toBe(false);
  expect(params.getAll('extension')).toEqual(restored.extension);
  expect(params.get('sort') ?? 'filename').toBe(restored.sort);
  expect(params.get('order') ?? 'asc').toBe(restored.order);
  expect(params.get('pageSize') ?? '25').toBe(restored.pageSize);
  expect(params.get('view') ?? 'grid').toBe(view);
  const state = await formState(page);
  expect(state.extension).toEqual(restored.extension);
  expect(state.search).toBe('');
  expect(state.sort).toBe(restored.sort);
  expect(state.order).toBe(restored.order);
  expect(state.pageSize).toBe(restored.pageSize);
  expect(state.view).toBe(view);
  expect(state.viewSummary).toBe(view === 'list' ? 'List' : 'Grid');
}

test('F7 original: Reset → held GET → List restores the project-only defaults with List', async ({ page }) => {
  const f = await createProject('F7 Original');
  saveProjectDefaults(f.id, { extension: 'jpg', sort: 'size', order: 'desc', pageSize: '10' });
  const rowsBefore = defaultsRows();
  const control = watch(page);
  const gate = await gateAssetGets(page);

  await page.goto(f.url(`${TEMPORARY}&view=grid`));
  expect(await renderedIds(page)).toEqual([f.ids['alpha-1.png']]);
  const temporaryUrl = page.url();
  const startLength = await historyLength(page);
  const sizesBefore = await storage(page);
  const snapshotsBefore = await savedSnapshots(page);
  expect(await scopeOf(page)).toBe('project');

  const held = await startHeldReset(page, gate);
  await viewLink(page, 'list').click();
  // The View choice is shown at once; the Reset still owns the results.
  expect((await formState(page)).view).toBe('list');
  held.release();

  await expectRestored(page, { view: 'list', ids: [f.ids['beta-2.jpg']] });
  expect(query(page).get('view')).toBe('list');
  expect(query(page).get('inheritedFilterDefaults')).toBe('extension');
  // One history entry for Reset + View, at most one extra GET.
  expect(await historyLength(page)).toBe(startLength + 1);
  expect(control.gets.filter(isReset)).toHaveLength(1);
  expect(control.gets.filter((url) => !isReset(url))).toHaveLength(1);
  expect(control.posts).toEqual([]);
  expect(defaultsRows()).toEqual(rowsBefore);
  expect(await scopeOf(page)).toBe('project');
  expect(await savedSnapshots(page)).toEqual(snapshotsBefore);
  expect(await storage(page)).toEqual(sizesBefore);
  await expect(failureNotice(page)).toHaveCount(0);

  await page.reload();
  await expectRestored(page, { view: 'list', ids: [f.ids['beta-2.jpg']] });
  await page.goBack();
  await expect.poll(() => page.url()).toBe(temporaryUrl);
  await settled(page);
  await expectPresentation(page, 'grid');
  expect(await renderedIds(page)).toEqual([f.ids['alpha-1.png']]);
  await page.goForward();
  await expect.poll(() => query(page).get('view')).toBe('list');
  await expectRestored(page, { view: 'list', ids: [f.ids['beta-2.jpg']] });
  expect(control.posts).toEqual([]);
  expect(defaultsRows()).toEqual(rowsBefore);
  expect(control.errors).toEqual([]);
});

test('A: Reset → List under global defaults keeps the global scope', async ({ page }) => {
  const f = await createProject('F7 Global');
  saveGlobalDefaults({ extension: 'jpg', sort: 'size', order: 'desc', pageSize: '10' });
  const rowsBefore = defaultsRows();
  const control = watch(page);
  const gate = await gateAssetGets(page);

  await page.goto(f.url(`${TEMPORARY}&view=grid`));
  expect(await renderedIds(page)).toEqual([f.ids['alpha-1.png']]);
  expect(await scopeOf(page)).toBe('global');
  const held = await startHeldReset(page, gate);
  await viewLink(page, 'list').click();
  held.release();

  await expectRestored(page, { view: 'list', ids: [f.ids['beta-2.jpg']] });
  expect(await scopeOf(page)).toBe('global');
  expect(control.posts).toEqual([]);
  expect(defaultsRows()).toEqual(rowsBefore);
  await page.reload();
  await expectRestored(page, { view: 'list', ids: [f.ids['beta-2.jpg']] });
  expect(control.errors).toEqual([]);
});

test('B: Reset → Grid under project-only defaults whose saved View is List', async ({ page }) => {
  const f = await createProject('F7 Project Grid');
  saveProjectDefaults(f.id, { extension: 'jpg', sort: 'size', order: 'desc', pageSize: '10', view: 'list' });
  const rowsBefore = defaultsRows();
  const control = watch(page);
  const gate = await gateAssetGets(page);

  await page.goto(f.url(`${TEMPORARY}&view=list`));
  await expectPresentation(page, 'list');
  const held = await startHeldReset(page, gate);
  await viewLink(page, 'grid').click();
  held.release();

  await expectRestored(page, { view: 'grid', ids: [f.ids['beta-2.jpg']] });
  expect(await scopeOf(page)).toBe('project');
  expect(control.posts).toEqual([]);
  expect(defaultsRows()).toEqual(rowsBefore);
  await page.reload();
  await expectRestored(page, { view: 'grid', ids: [f.ids['beta-2.jpg']] });
  expect(control.errors).toEqual([]);
});

test('C: partial project-only override inherits the global values', async ({ page }) => {
  const f = await createProject('F7 Partial');
  saveGlobalDefaults({ extension: 'jpg', sort: 'size', order: 'desc' });
  saveProjectDefaults(f.id, { pageSize: '10' });
  const rowsBefore = defaultsRows();
  const control = watch(page);
  const gate = await gateAssetGets(page);

  await page.goto(f.url(`${TEMPORARY}&view=grid`));
  expect(await scopeOf(page)).toBe('project');
  const snapshotsBefore = await savedSnapshots(page);
  const held = await startHeldReset(page, gate);
  await viewLink(page, 'list').click();
  held.release();

  await expectRestored(page, { view: 'list', ids: [f.ids['beta-2.jpg']] });
  expect(await scopeOf(page)).toBe('project');
  expect(await savedSnapshots(page)).toEqual(snapshotsBefore);
  expect(control.posts).toEqual([]);
  expect(defaultsRows()).toEqual(rowsBefore);
  expect(control.errors).toEqual([]);
});

test('D: no stored defaults restores the application fallbacks with the clicked View', async ({ page }) => {
  const f = await createProject('F7 Fallback');
  const rowsBefore = defaultsRows();
  const control = watch(page);
  const gate = await gateAssetGets(page);

  await page.goto(f.url(`${TEMPORARY}&view=grid`));
  const held = await startHeldReset(page, gate);
  await viewLink(page, 'list').click();
  held.release();

  // Fallbacks: every extension, Filename, Ascending, 25 per page.
  await expectRestored(page, {
    view: 'list',
    ids: [f.ids['alpha-1.png'], f.ids['beta-2.jpg']],
    restored: { extension: [], sort: 'filename', order: 'asc', pageSize: '25' },
  });
  expect(control.posts).toEqual([]);
  expect(defaultsRows()).toEqual(rowsBefore);
  expect(control.errors).toEqual([]);
});

test('E: rapid View reversals during a pending Reset: the latest choice wins with one follow-up GET', async ({ page }) => {
  const f = await createProject('F7 Rapid');
  saveProjectDefaults(f.id, { extension: 'jpg', sort: 'size', order: 'desc', pageSize: '10' });
  const rowsBefore = defaultsRows();
  const control = watch(page);
  const gate = await gateAssetGets(page);

  // List then Grid.
  await page.goto(f.url(`${TEMPORARY}&view=list`));
  let startLength = await historyLength(page);
  let held = await startHeldReset(page, gate);
  await viewLink(page, 'list').click();
  await viewLink(page, 'grid').click();
  expect((await formState(page)).view).toBe('grid');
  held.release();
  await expectRestored(page, { view: 'grid', ids: [f.ids['beta-2.jpg']] });
  expect(await historyLength(page)).toBe(startLength + 1);
  expect(control.gets.filter(isReset)).toHaveLength(1);
  expect(control.gets.filter((url) => !isReset(url)).length).toBeLessThanOrEqual(1);

  // Grid then List.
  await page.goto(f.url(`${TEMPORARY}&view=grid`));
  control.gets.length = 0;
  startLength = await historyLength(page);
  held = await startHeldReset(page, gate);
  await viewLink(page, 'grid').click();
  await viewLink(page, 'list').click();
  expect((await formState(page)).view).toBe('list');
  held.release();
  await expectRestored(page, { view: 'list', ids: [f.ids['beta-2.jpg']] });
  expect(await historyLength(page)).toBe(startLength + 1);
  expect(control.gets.filter(isReset)).toHaveLength(1);
  expect(control.gets.filter((url) => !isReset(url))).toHaveLength(1);
  expect(control.posts).toEqual([]);
  expect(defaultsRows()).toEqual(rowsBefore);
  expect(control.errors).toEqual([]);
});

test('F: a failed Reset keeps the temporary page, then Retry restores the defaults with the latest View', async ({ page }) => {
  const f = await createProject('F7 Failed Reset');
  saveProjectDefaults(f.id, { extension: 'jpg', sort: 'size', order: 'desc', pageSize: '10' });
  const rowsBefore = defaultsRows();
  const control = watch(page);
  const gate = await gateAssetGets(page);

  // 1. A Reset that fails: nothing claims success, the temporary page stays.
  await page.goto(f.url(`${TEMPORARY}&view=grid`));
  const temporaryUrl = page.url();
  const failing = gate.next(isReset, { fail: true });
  await openFilters(page);
  await filterDialog(page).locator('[data-project-assets-reset]').click();
  await failing.arrival;
  await expect(failureNotice(page)).toBeVisible();
  await settled(page);
  expect(page.url()).toBe(temporaryUrl);
  expect(await renderedIds(page)).toEqual([f.ids['alpha-1.png']]);
  await closeFilters(page);

  // List after the failure re-requests the Reset (GET) and applies List.
  await viewLink(page, 'list').click();
  await expectRestored(page, { view: 'list', ids: [f.ids['beta-2.jpg']] });
  await expect(failureNotice(page)).toHaveCount(0);
  expect(control.gets.filter(isReset)).toHaveLength(2);

  // 2. List chosen during a Reset that then fails; Retry keeps List.
  await page.goto(f.url(`${TEMPORARY}&view=grid`));
  control.gets.length = 0;
  const lengthBefore = await historyLength(page);
  const failed = await startHeldReset(page, gate);
  await viewLink(page, 'list').click();
  await expect(failureNotice(page)).toHaveCount(0);
  // Fail the held Reset only now, after List was chosen during it.
  failed.fail();
  await expect(failureNotice(page)).toBeVisible();
  await settled(page);
  expect(page.url()).toBe(temporaryUrl);
  expect(await renderedIds(page)).toEqual([f.ids['alpha-1.png']]);
  expect((await formState(page)).view).toBe('list');
  const retried = page.waitForRequest((request) => request.resourceType() === 'fetch' && isReset(new URL(request.url())));
  await page.locator('[data-live-filter-retry]').first().click();
  expect((await retried).method()).toBe('GET');
  await expectRestored(page, { view: 'list', ids: [f.ids['beta-2.jpg']] });
  await expect(failureNotice(page)).toHaveCount(0);
  expect(await historyLength(page)).toBe(lengthBefore + 1);
  expect(control.posts).toEqual([]);
  expect(defaultsRows()).toEqual(rowsBefore);
  expect(control.errors).toEqual([]);
});

test('G: a failed follow-up View GET keeps the temporary page; GET-only Retry restores Reset + View', async ({ page }) => {
  const f = await createProject('F7 Failed View');
  saveProjectDefaults(f.id, { extension: 'jpg', sort: 'size', order: 'desc', pageSize: '10' });
  const rowsBefore = defaultsRows();
  const control = watch(page);
  const gate = await gateAssetGets(page);

  await page.goto(f.url(`${TEMPORARY}&view=grid`));
  const temporaryUrl = page.url();
  const held = await startHeldReset(page, gate);
  const followUp = gate.next((url) => !isReset(url) && url.searchParams.get('view') === 'list'
    && url.searchParams.getAll('extension').join() === 'jpg', { fail: true });
  await viewLink(page, 'list').click();
  held.release();
  const failedUrl = await followUp.arrival;
  expect(failedUrl.searchParams.get('sort')).toBe('size');
  expect(failedUrl.searchParams.get('order')).toBe('desc');
  expect(failedUrl.searchParams.get('pageSize')).toBe('10');
  expect(failedUrl.searchParams.has('search')).toBe(false);
  await expect(failureNotice(page)).toBeVisible();
  await settled(page);
  // The installed temporary page stays coherent; nothing claims the Reset.
  expect(page.url()).toBe(temporaryUrl);
  expect(await renderedIds(page)).toEqual([f.ids['alpha-1.png']]);
  await expectPresentation(page, 'grid');

  const before = control.gets.length;
  await page.locator('[data-live-filter-retry]').first().click();
  await expectRestored(page, { view: 'list', ids: [f.ids['beta-2.jpg']] });
  await expect(failureNotice(page)).toHaveCount(0);
  const retryGets = control.gets.slice(before);
  expect(retryGets.at(-1).searchParams.get('view')).toBe('list');
  expect(retryGets.at(-1).searchParams.getAll('extension')).toEqual(['jpg']);
  expect(control.posts).toEqual([]);
  expect(defaultsRows()).toEqual(rowsBefore);
  expect(control.errors).toEqual([]);
});

test('H: a newer filter edit supersedes the Reset; its late response and the deferred View never install', async ({ page }) => {
  const f = await createProject('F7 Late', ['alpha-1.png', 'beta-2.jpg', 'beta-3.png']);
  saveProjectDefaults(f.id, { extension: 'jpg', sort: 'size', order: 'desc', pageSize: '10' });
  const rowsBefore = defaultsRows();
  const control = watch(page);
  const gate = await gateAssetGets(page);

  await page.goto(f.url(`${TEMPORARY}&view=grid`));
  const held = await startHeldReset(page, gate);
  await viewLink(page, 'list').click();
  // A genuine filter edit: Search Beta, built from the controls as shown.
  await openFilters(page);
  await page.locator('#search').fill('beta');
  await expect.poll(() => query(page).get('search')).toBe('beta');
  await settled(page);
  expect(await renderedIds(page)).toEqual([f.ids['beta-3.png']]);
  await expectPresentation(page, 'list');
  const afterEdit = page.url();

  held.release();
  // The superseded Reset neither installs nor sends a deferred View GET.
  await page.waitForLoadState('networkidle');
  await settled(page);
  expect(page.url()).toBe(afterEdit);
  expect(await renderedIds(page)).toEqual([f.ids['beta-3.png']]);
  expect(control.gets.filter((url) => !isReset(url) && url.searchParams.getAll('extension').join() === 'jpg')).toEqual([]);
  expect(control.posts).toEqual([]);
  expect(defaultsRows()).toEqual(rowsBefore);
  expect(control.errors).toEqual([]);
});

test('I: Back during a pending Reset + View abandons both; Forward/reload stay coherent', async ({ page }) => {
  const f = await createProject('F7 History');
  saveProjectDefaults(f.id, { extension: 'jpg', sort: 'size', order: 'desc', pageSize: '10' });
  const control = watch(page);
  const gate = await gateAssetGets(page);

  await page.goto(f.url('view=grid'));
  await page.goto(f.url(`${TEMPORARY}&view=grid`));
  const temporaryUrl = page.url();
  const held = await startHeldReset(page, gate);
  await viewLink(page, 'list').click();
  await page.goBack();
  await expect.poll(() => query(page).has('search')).toBe(false);
  await settled(page);
  const backUrl = page.url();
  held.release();
  await settled(page);
  expect(page.url()).toBe(backUrl);
  expect(control.gets.filter((url) => !isReset(url) && url.searchParams.get('view') === 'list')).toEqual([]);
  await page.goForward();
  await expect.poll(() => page.url()).toBe(temporaryUrl);
  await settled(page);
  expect(await renderedIds(page)).toEqual([f.ids['alpha-1.png']]);
  await expectPresentation(page, 'grid');
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('J: Reset + View keeps the scope metadata and browser-local sizes; reopening shows the installed state', async ({ page }) => {
  const f = await createProject('F7 Metadata');
  saveProjectDefaults(f.id, { extension: 'jpg', sort: 'size', order: 'desc', pageSize: '10', gridSize: 'large', listSize: 'compact' });
  const rowsBefore = defaultsRows();
  const control = watch(page);
  const gate = await gateAssetGets(page);

  await page.goto(f.url(`${TEMPORARY}&view=grid`));
  await page.evaluate(() => {
    localStorage.setItem('creatorcrate-asset-grid-size', 'compact');
    localStorage.setItem('creatorcrate-asset-list-size', 'large');
  });
  await page.reload();
  const sizesBefore = await storage(page);
  const snapshotsBefore = await savedSnapshots(page);
  const held = await startHeldReset(page, gate);
  await viewLink(page, 'list').click();
  held.release();
  await expectRestored(page, { view: 'list', ids: [f.ids['beta-2.jpg']] });
  expect(await storage(page)).toEqual(sizesBefore);
  expect(await savedSnapshots(page)).toEqual(snapshotsBefore);
  expect(await scopeOf(page)).toBe('project');

  await openFilters(page);
  expect(await page.locator('#asset-view-filter').inputValue()).toBe('list');
  await expect(defaultsForm(page)).not.toHaveAttribute('data-settings-fetch-save-state', 'error');
  // A later filter edit keeps List and the restored filters.
  await page.locator('#search').fill('beta');
  await expect.poll(() => query(page).get('search')).toBe('beta');
  await settled(page);
  expect(query(page).get('view')).toBe('list');
  expect(query(page).getAll('extension')).toEqual(['jpg']);
  expect(await renderedIds(page)).toEqual([f.ids['beta-2.jpg']]);
  await closeFilters(page);
  expect(control.posts).toEqual([]);
  expect(defaultsRows()).toEqual(rowsBefore);
  expect(control.errors).toEqual([]);
});
