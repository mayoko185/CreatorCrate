import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
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
 * Filters & Defaults M3 F7-R1 — a real acknowledged asset mutation (Auto
 * Rename Apply through its dialog) whose Project Assets refresh starts while
 * Reset filters + a newer List View is still unresolved must carry that Reset,
 * not erase it: the saved filters install with List, Grid style and the
 * Grid/List sizes are restored, the pre-Reset selection (visible and hidden
 * retained) is cleared, and the mutation stays applied. Requests are held or
 * failed through route gates, never sleeps. All data lives in a temporary
 * root removed afterward.
 *
 * F7-R2: a newer genuine filter edit that takes over the owed refresh keeps
 * its own selection boundary (visible and hidden selections cleared, none in
 * the bulk payload), and a View chosen after a response's headers arrived but
 * before its body did still wins. Bodies are held server side after the
 * headers are flushed, released by the test.
 */

let server;
let db;
let app;
let root;
let projectsRoot;
let baseURL;
// F7-R2b: asset GETs (page fetches) whose body is held after the headers.
const bodyHolds = [];

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-pa-reset-mutation-browser-'));
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
  server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const index = request.method === 'GET' && request.headers['sec-fetch-dest'] === 'empty'
      && /^\/projects\/\d+\/assets$/.test(url.pathname)
      ? bodyHolds.findIndex((hold) => hold.match(url)) : -1;
    if (index !== -1) {
      const [hold] = bodyHolds.splice(index, 1);
      const end = response.end.bind(response);
      response.end = (...args) => {
        response.flushHeaders();
        hold.sent(url);
        hold.gate.then(() => end(...args));
        return response;
      };
    }
    app(request, response);
  });
  server.listen(0, '127.0.0.1');
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
  bodyHolds.length = 0;
});

const everyHold = [];
test.afterEach(() => {
  bodyHolds.length = 0;
  everyHold.splice(0).forEach((hold) => hold.release());
});

// The next matching page fetch answers with its headers, then waits.
function holdBody(match) {
  const hold = { match };
  hold.headersSent = new Promise((resolve) => { hold.sent = resolve; });
  hold.gate = new Promise((resolve) => { hold.release = resolve; });
  bodyHolds.push(hold);
  everyHold.push(hold);
  return hold;
}

const PAGE = 'projectAssets';
const WIP_FILES = ['alpha-1.png', 'alpha-2.png', 'alpha-3.png', 'beta-1.jpg', 'beta-2.jpg'];
const REFS_FILES = ['refs-1.jpg', 'refs-2.jpg'];
// Saved: JPG, Size/Descending, 10, Cropped, Large Grid, Compact List.
const SAVED = {
  extension: 'jpg', sort: 'size', order: 'desc', pageSize: '10',
  gridStyle: 'cropped', gridSize: 'large', listSize: 'compact',
};

async function writeImages(dir, names, offset = 0) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [index, name] of names.entries()) {
    // Distinct sizes so Sort by Size is observable.
    const side = 12 + (index + offset) * 8;
    const image = sharp({ create: { width: side, height: side, channels: 3, background: { r: index * 50, g: 90, b: 160 } } });
    await (name.endsWith('.png') ? image.png() : image.jpeg()).toFile(path.join(dir, name));
  }
}

async function createProject(title) {
  const project = app.locals.projectService.create({ title, status: 'tbd' });
  const categories = app.locals.projectAssetCategoryService;
  for (const [displayName, directorySlug] of [['WIP', 'wip'], ['Refs', 'refs']]) {
    if (!categories.list(project.id).some((candidate) => candidate.directory_slug === directorySlug)) {
      categories.add(project.id, { displayName, directorySlug });
    }
  }
  const category = (slug) => categories.list(project.id).find((candidate) => candidate.directory_slug === slug);
  const projectDir = path.join(projectsRoot, project.project_dir);
  await writeImages(path.join(projectDir, 'wip'), WIP_FILES);
  await writeImages(path.join(projectDir, 'refs'), REFS_FILES, 5);
  app.locals.assetScanner.scanProjectAssets(project.id);
  const id = (filename) => db.prepare('SELECT id FROM assets WHERE project_id = ? AND filename = ?').get(project.id, filename).id;
  const ids = Object.fromEntries([...WIP_FILES, ...REFS_FILES].map((name) => [name, id(name)]));
  const wip = category('wip').id;
  return {
    id: project.id,
    ids,
    wip,
    refs: category('refs').id,
    row: (assetId) => db.prepare('SELECT filename, relative_path FROM assets WHERE id = ?').get(assetId),
    onDisk: (relativePath) => fs.existsSync(path.join(projectDir, relativePath)),
    // JPG identities in the saved Size/Descending order.
    savedIds: () => db.prepare(`SELECT id FROM assets WHERE project_id = ? AND extension = 'jpg'
      ORDER BY size_bytes DESC, id`).all(project.id).map((row) => row.id),
    url: (search = '') => `${baseURL}/projects/${project.id}/assets${search ? `?${search}` : ''}`,
    temporary: () => `category=${wip}&extension=png&search=alpha&sort=filename&order=asc&pageSize=25&view=grid`,
  };
}

function saveGlobalDefaults(values) {
  const write = db.prepare(`
    INSERT INTO app_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  Object.entries(values).forEach(([option, value]) => write.run(PAGE_DEFAULT_DEFINITIONS[PAGE][option].key, value));
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
const historyLength = (page) => page.evaluate(() => window.history.length);
const viewLink = (page, view) => page.locator(`nav.view-switcher a[aria-label="${view === 'list' ? 'List' : 'Grid'} view"]`);
const failureNotice = (page) => page.locator('[data-live-filter-failure]');
const retry = (page) => page.locator('[data-live-filter-retry]');
const countText = (page) => region(page).locator('[data-selected-count]');
const box = (page, id) => region(page).locator(`input[name="selectedAssetIds"][value="${id}"]`);
const autoRename = (page) => page.locator('[data-auto-rename-submit]');
const renameDialog = (page) => page.locator('#auto-rename-confirmation-dialog');
const surface = (page) => region(page).locator('[data-auto-rename-surface]');
const orderValue = async (page) => JSON.parse(await page.locator('[data-auto-rename-order-input]').inputValue());
const storage = (page) => page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)])));
const renderedIds = (page) => region(page).locator('input[type="checkbox"][name="selectedAssetIds"]')
  .evaluateAll((inputs) => inputs.map((input) => Number(input.value)));
const checkedIds = (page) => region(page).locator('input[type="checkbox"][name="selectedAssetIds"]')
  .evaluateAll((inputs) => inputs.filter((input) => input.checked).map((input) => Number(input.value)));
const retainedIds = (page) => page.evaluate(() => (document.__creatorCrateRetainedAssetSelection || []).map(Number));
const bulkPayload = (page) => page.evaluate(() => new FormData(document.getElementById('bulk-select-form'))
  .getAll('selectedAssetIds').map(Number));
// The dialog's presentation fields and what the region actually shows.
const presentation = (page) => page.evaluate(() => ({
  gridStyle: document.getElementById('projectAssets-default-gridStyle')?.value,
  gridSize: document.getElementById('projectAssets-default-gridSize')?.value,
  listSize: document.getElementById('projectAssets-default-listSize')?.value,
  shownGridStyle: document.querySelector('[data-project-assets-live-region] .asset-grid')?.getAttribute('data-grid-style') ?? null,
  shownGridSize: document.querySelector('[data-project-assets-live-region] .asset-grid')?.getAttribute('data-grid-size') ?? null,
  shownListSize: document.querySelector('[data-project-assets-live-region] .asset-list')?.getAttribute('data-list-size') ?? null,
}));

async function markRegion(page) {
  await region(page).evaluate((node) => { node.dataset.beforeRefresh = 'true'; });
}

async function expectInstalled(page) {
  await expect(page.locator('[data-project-assets-live-region]:not([data-before-refresh])')).toHaveCount(1);
  await settled(page);
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

// A live, unsaved Grid style choice in the dialog (Package C presentation).
async function chooseGridStyle(page, label) {
  await openFilters(page);
  const dropdown = filterDialog(page).locator('#projectAssets-default-gridStyle-dropdown');
  await dropdown.locator('summary').click();
  await dropdown.locator('label').filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) }).click();
  await closeFilters(page);
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
      if (action === 'fail') await route.fulfill({ status: 503, body: 'unavailable' });
      else await route.continue();
    } catch {
      // The page aborted this request when a newer load superseded it.
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
const isListContinuation = (url) => !isReset(url) && url.searchParams.get('view') === 'list';

// Auto Rename through its dialog: Preview POST, then the real Apply POST,
// whose acknowledged commit starts the Project Assets mutation refresh.
async function applyAutoRename(page) {
  await expect(autoRename(page)).toBeEnabled();
  await autoRename(page).click();
  await expect(renameDialog(page)).toBeVisible();
  const [applied] = await Promise.all([
    page.waitForResponse((response) => response.request().method() === 'POST'
      && new URL(response.url()).pathname.endsWith('/assets/auto-rename/apply')),
    renameDialog(page).getByRole('button', { name: 'Apply Auto Rename' }).click(),
  ]);
  expect(applied.ok()).toBe(true);
  await expect(renameDialog(page)).toHaveCount(0);
}

// A real acknowledged inline Rename (the card editor's POST, as JSON) and the
// page's own post-mutation refresh, as a category change triggers it.
async function renameAndRefresh(page, f, assetId, basename) {
  const status = await page.evaluate(async ({ projectId, id, filename }) => {
    const token = document.querySelector('input[name="_csrf"]')?.value;
    const body = new URLSearchParams({ _csrf: token, origin: 'assets', filename });
    const response = await fetch(`/projects/${projectId}/assets/${id}/rename`, {
      method: 'POST', body, headers: { Accept: 'application/json' }, credentials: 'same-origin',
    });
    return response.status;
  }, { projectId: f.id, id: assetId, filename: basename });
  expect(status).toBe(200);
  await markRegion(page);
  await page.evaluate(() => document.dispatchEvent(new Event('project-asset-categories-changed')));
  await expectInstalled(page);
}

/*
 * The reviewer's temporary state: PNG + Search Alpha + Filename/Ascending +
 * 25 in WIP; Uncropped, Compact Grid, Large List. alpha-3 is renamed first
 * (inline Rename), so the ordinary refresh keeps it selected but hidden;
 * alpha-1 is selected visibly.
 */
async function temporaryState(page, f) {
  saveGlobalDefaults(SAVED);
  await page.goto(f.url(f.temporary()));
  await page.evaluate(() => {
    localStorage.setItem('creatorcrate-asset-grid-size', 'compact');
    localStorage.setItem('creatorcrate-asset-list-size', 'large');
  });
  await page.reload();
  await chooseGridStyle(page, 'Uncropped');
  await expect(region(page).locator('.asset-grid')).toHaveAttribute('data-grid-style', 'uncropped');

  const a1 = f.ids['alpha-1.png'];
  const a3 = f.ids['alpha-3.png'];
  await select(page, a3);
  await renameAndRefresh(page, f, a3, 'gamma-3');
  // Control: an ordinary mutation refresh keeps identity and presentation.
  expect(f.row(a3).filename).toBe('gamma-3.png');
  await expect(box(page, a3)).toHaveCount(0);
  expect(await retainedIds(page)).toEqual([a3]);
  await expect(region(page).locator('.asset-grid')).toHaveAttribute('data-grid-style', 'uncropped');

  await select(page, a1);
  await expect(countText(page)).toHaveText('1 of 2 selected (1 more not shown)');
  expect(await presentation(page)).toMatchObject({
    gridStyle: 'uncropped', shownGridStyle: 'uncropped', shownGridSize: 'compact',
  });
  return { a1, a3 };
}

// Reset → held Reset GET → List → Reset answers → its List continuation held.
async function resetThenHeldList(page, gate) {
  await openFilters(page);
  const heldReset = gate.next(isReset);
  await filterDialog(page).locator('[data-project-assets-reset]').click();
  await heldReset.arrival;
  await closeFilters(page);
  await viewLink(page, 'list').click();
  const heldList = gate.next(isListContinuation);
  heldReset.release();
  await heldList.arrival;
  return heldList;
}

async function expectResetCompleted(page, f, { a1, a3 }, { view = 'list', mutated = [a1, a3] } = {}) {
  await settled(page);
  if (view === 'list') await expect(region(page).locator('ul.asset-list')).toBeVisible();
  else await expect(region(page).locator('.asset-grid')).toBeVisible();
  await expect(region(page).locator(view === 'list' ? '.asset-grid' : 'ul.asset-list')).toHaveCount(0);
  await expect(viewLink(page, view)).toHaveAttribute('aria-current', 'page');
  // Authoritative saved filters with the latest View.
  const params = query(page);
  expect(params.has('resetFilters')).toBe(false);
  expect(params.has('search')).toBe(false);
  expect(params.getAll('extension')).toEqual(['jpg']);
  expect(params.get('sort')).toBe('size');
  expect(params.get('order')).toBe('desc');
  expect(params.get('pageSize') ?? '25').toBe('10');
  expect(params.get('view') ?? 'grid').toBe(view);
  const savedIds = f.savedIds();
  expect(await renderedIds(page)).toEqual(savedIds);
  expect(Number(await countText(page).getAttribute('data-selected-total'))).toBe(savedIds.length);
  await openFilters(page);
  expect(await page.locator('#asset-view-filter').inputValue()).toBe(view);
  expect(await page.locator('#search').inputValue()).toBe('');
  await closeFilters(page);
  // Grid style and both sizes restored; the shown View uses the restored size.
  expect(await presentation(page)).toMatchObject({
    gridStyle: 'cropped', gridSize: 'large', listSize: 'compact',
    ...(view === 'list' ? { shownListSize: 'compact' } : { shownGridStyle: 'cropped', shownGridSize: 'large' }),
  });
  // The Reset started a new selection: nothing visible, nothing retained.
  expect(await checkedIds(page)).toEqual([]);
  expect(await retainedIds(page)).toEqual([]);
  expect(await bulkPayload(page)).toEqual([]);
  await expect(countText(page)).toHaveText(`0 of ${savedIds.length} selected`);
  // Every real mutation stays applied.
  for (const id of mutated) {
    const row = f.row(id);
    expect(row.filename).not.toMatch(/^alpha-/);
    expect(f.onDisk(row.relative_path)).toBe(true);
  }
  expect(f.onDisk('wip/alpha-1.png')).toBe(!mutated.includes(a1));
  await expect(failureNotice(page)).toHaveCount(0);
}

// F7-R2b: the engine holds this load's response (headers read, followResponse
// already asked) and is waiting only for its body.
const pendingBodyUrl = (page) => page.evaluate(() => {
  const state = document.__creatorCrateProjectAssetsLiveFiltering;
  return state?.controller && state.response ? state.response.url : null;
});

async function bodyPending(page, hold) {
  await hold.headersSent;
  await expect.poll(async () => {
    const url = await pendingBodyUrl(page);
    return Boolean(url && hold.match(new URL(url)));
  }).toBe(true);
}

const isGridContinuation = (url) => !isReset(url) && url.searchParams.get('view') === 'grid';
const isCanonical = (url) => !isReset(url) && !url.searchParams.has('view');

// Reset → List (original continuation held at the route) → real Auto Rename,
// whose refresh re-reads the Reset and continues at List: that List response
// has answered with its headers and its body is held.
async function refreshListBodyHeld(page, gate) {
  const heldList = await resetThenHeldList(page, gate);
  const listBody = holdBody(isListContinuation);
  await markRegion(page);
  await applyAutoRename(page);
  await bodyPending(page, listBody);
  return { heldList, listBody };
}

const autoRenamePosts = (f, times) => Array.from({ length: times }, () => [
  `POST /projects/${f.id}/assets/auto-rename/preview`,
  `POST /projects/${f.id}/assets/auto-rename/apply`,
]).flat();
// The setup's inline Rename of alpha-3, then the race's one Auto Rename.
const racePosts = (f) => [`POST /projects/${f.id}/assets/${f.ids['alpha-3.png']}/rename`, ...autoRenamePosts(f, 1)];

test('A: an Auto Rename refresh during the held Reset + List continuation completes the Reset', async ({ page }) => {
  const f = await createProject('R1 Continuation');
  const control = watch(page);
  const gate = await gateAssetGets(page);
  const selected = await temporaryState(page, f);
  const rowsBefore = defaultsRows();
  const storageBefore = await storage(page);
  const startLength = await historyLength(page);
  const getsBefore = control.gets.length;

  const heldList = await resetThenHeldList(page, gate);
  await markRegion(page);
  await applyAutoRename(page);
  await expectInstalled(page);
  // The obsolete continuation is released last and installs nothing.
  heldList.release();

  await expectResetCompleted(page, f, selected);
  const gets = control.gets.slice(getsBefore);
  // Reset, its List continuation (aborted), then the refresh re-reading the
  // Reset and continuing at List: GET only, no Reset replay beyond that.
  expect(gets.filter(isReset)).toHaveLength(2);
  expect(gets.filter((url) => !isReset(url))).toHaveLength(2);
  expect(await historyLength(page)).toBe(startLength + 1);
  expect(control.posts).toEqual(racePosts(f));
  expect(defaultsRows()).toEqual(rowsBefore);
  expect(await storage(page)).toEqual(storageBefore);

  // A pure View change afterwards shows the restored Grid style and size.
  await viewLink(page, 'grid').click();
  await settled(page);
  expect(await presentation(page)).toMatchObject({ shownGridStyle: 'cropped', shownGridSize: 'large' });
  await viewLink(page, 'list').click();
  await settled(page);

  // Reload: the restored address and the mutation persist.
  await page.reload();
  expect(query(page).getAll('extension')).toEqual(['jpg']);
  expect(query(page).get('view')).toBe('list');
  expect(await renderedIds(page)).toEqual(f.savedIds());
  expect(await checkedIds(page)).toEqual([]);
  expect(f.row(selected.a1).filename).not.toMatch(/^alpha-/);
  expect(control.posts).toEqual(racePosts(f));
  expect(defaultsRows()).toEqual(rowsBefore);
  expect(control.errors).toEqual([]);
});

test('C: an Auto Rename refresh during the held Reset GET itself keeps the Reset and List', async ({ page }) => {
  const f = await createProject('R1 Resolution');
  const control = watch(page);
  const gate = await gateAssetGets(page);
  const selected = await temporaryState(page, f);
  const rowsBefore = defaultsRows();
  const startLength = await historyLength(page);

  await openFilters(page);
  const heldReset = gate.next(isReset);
  await filterDialog(page).locator('[data-project-assets-reset]').click();
  await heldReset.arrival;
  await closeFilters(page);
  await viewLink(page, 'list').click();
  await markRegion(page);
  await applyAutoRename(page);
  await expectInstalled(page);
  heldReset.release();

  await expectResetCompleted(page, f, selected);
  expect(await historyLength(page)).toBe(startLength + 1);
  expect(control.posts).toEqual(racePosts(f));
  expect(defaultsRows()).toEqual(rowsBefore);
  expect(control.errors).toEqual([]);
});

test('failed refresh GET: no false Reset; GET-only Retry completes it; a late stale answer loses', async ({ page }) => {
  const f = await createProject('R1 Retry');
  const control = watch(page);
  const gate = await gateAssetGets(page);
  const selected = await temporaryState(page, f);
  const rowsBefore = defaultsRows();
  const storageBefore = await storage(page);
  const startLength = await historyLength(page);
  const startUrl = page.url();

  const heldList = await resetThenHeldList(page, gate);
  // The refresh's first GET fails (503).
  gate.next(() => true, { fail: true });
  await applyAutoRename(page);
  await expect(failureNotice(page)).toBeVisible();
  await settled(page);
  // Nothing installed: the temporary page and its selection stand.
  expect(page.url()).toBe(startUrl);
  await expect(countText(page)).toHaveText('1 of 2 selected (1 more not shown)');
  expect(await retainedIds(page)).toEqual([selected.a3]);
  expect(f.row(selected.a1).filename).not.toBe('alpha-1.png');
  const postsAfterApply = [...control.posts];

  await markRegion(page);
  await retry(page).click();
  await expectInstalled(page);
  heldList.release();

  await expectResetCompleted(page, f, selected);
  expect(await historyLength(page)).toBe(startLength + 1);
  // Retry is GET-only: no Apply or defaults POST is replayed.
  expect(control.posts).toEqual(postsAfterApply);
  expect(control.posts).toEqual(racePosts(f));
  expect(defaultsRows()).toEqual(rowsBefore);
  expect(await storage(page)).toEqual(storageBefore);
  expect(control.errors).toEqual([]);
});

test('R2a-B: a newer Search value supersedes the carried Reset and clears the selection; Back/Forward never revive it', async ({ page }) => {
  const f = await createProject('R1 Newer Edit');
  const control = watch(page);
  const gate = await gateAssetGets(page);
  const selected = await temporaryState(page, f);
  const rowsBefore = defaultsRows();
  const startLength = await historyLength(page);

  const heldList = await resetThenHeldList(page, gate);
  const heldRefresh = gate.next(isReset);
  await applyAutoRename(page);
  await heldRefresh.arrival;
  // A newer Search edit is newer intent than the Reset the refresh carries.
  await openFilters(page);
  await page.locator('#search').fill('alpha-2');
  await expect.poll(() => query(page).get('search')).toBe('alpha-2');
  await settled(page);
  await closeFilters(page);
  heldRefresh.release();
  heldList.release();
  await settled(page);

  expect(query(page).has('resetFilters')).toBe(false);
  expect(query(page).getAll('extension')).toEqual(['png']);
  expect(await renderedIds(page)).toEqual([f.ids['alpha-2.png']]);
  // F7-R2a: the newer Search keeps its own selection boundary. The owed
  // refresh is satisfied (mutated data shown) but no old identity survives.
  expect(await checkedIds(page)).toEqual([]);
  expect(await retainedIds(page)).toEqual([]);
  expect(await bulkPayload(page)).toEqual([]);
  await expect(countText(page)).toHaveText('0 of 1 selected');
  expect(f.row(selected.a1).filename).not.toMatch(/^alpha-/);
  expect(await historyLength(page)).toBe(startLength + 1);
  expect(await presentation(page)).toMatchObject({ gridStyle: 'uncropped' });

  await page.goBack();
  await settled(page);
  expect(query(page).get('search')).toBe('alpha');
  expect(query(page).has('resetFilters')).toBe(false);
  expect(await checkedIds(page)).toEqual([]);
  expect(await retainedIds(page)).toEqual([]);
  expect(await bulkPayload(page)).toEqual([]);
  await page.goForward();
  await settled(page);
  expect(query(page).get('search')).toBe('alpha-2');
  expect(await bulkPayload(page)).toEqual([]);
  expect(await presentation(page)).toMatchObject({ gridStyle: 'uncropped' });
  expect(control.posts).toEqual(racePosts(f));
  expect(defaultsRows()).toEqual(rowsBefore);
  expect(control.errors).toEqual([]);
});

test('an unsaved category order in another category survives the carried Reset unchanged', async ({ page }) => {
  const f = await createProject('R1 Order Draft');
  const control = watch(page);
  const gate = await gateAssetGets(page);
  saveGlobalDefaults(SAVED);

  const switchCategory = async (categoryId) => {
    await markRegion(page);
    await page.locator(`#asset-category-filter input[value="${categoryId}"]`).evaluate((input) => {
      input.checked = true;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expectInstalled(page);
  };

  // An unsaved Refs order: refs-2 moved before refs-1.
  await page.goto(f.url(`category=${f.refs}&extension=jpg&sort=filename&order=asc&pageSize=25&view=grid`));
  const saved = await orderValue(page);
  const item = surface(page).locator('[data-auto-rename-asset][aria-label="Reorder refs-2.jpg"]');
  await item.focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
  await expect.poll(() => orderValue(page)).not.toEqual(saved);
  const draft = await orderValue(page);

  // To WIP (live), keeping the Refs draft held; beta-1 selected there.
  await switchCategory(f.wip);
  await select(page, f.ids['beta-1.jpg']);
  const rowsBefore = defaultsRows();

  const heldList = await resetThenHeldList(page, gate);
  await markRegion(page);
  await applyAutoRename(page);
  await expectInstalled(page);
  heldList.release();
  await settled(page);
  expect(query(page).getAll('extension')).toEqual(['jpg']);
  expect(query(page).get('view')).toBe('list');
  expect(await checkedIds(page)).toEqual([]);
  expect(await retainedIds(page)).toEqual([]);
  expect(f.row(f.ids['beta-1.jpg']).filename).not.toBe('beta-1.jpg');

  // Back in Refs (live), the unsaved order returns as the same draft.
  await switchCategory(f.refs);
  expect(await orderValue(page)).toEqual(draft);
  // Nothing saved the order or touched the Refs files.
  expect(control.posts).toEqual(autoRenamePosts(f, 1));
  expect(f.row(f.ids['refs-1.jpg']).filename).toBe('refs-1.jpg');
  expect(f.row(f.ids['refs-2.jpg']).filename).toBe('refs-2.jpg');
  expect(draft).not.toEqual(saved);
  expect(defaultsRows()).toEqual(rowsBefore);
  expect(control.errors).toEqual([]);
});


/*
 * F7-R2a — the reviewer's reproduction: Reset → List (continuation held) →
 * real Auto Rename (its refresh held) → Search cleared. The newer Search wins
 * and starts a new selection: the previously visible alpha-1 and the hidden
 * retained gamma-3 come back into view unchecked and never reach the payload.
 */
test('R2a-A/C/D: Search cleared during the held refresh clears visible and hidden selections and the bulk payload', async ({ page }) => {
  const f = await createProject('R2 Search Cleared');
  const control = watch(page);
  const gate = await gateAssetGets(page);
  const selected = await temporaryState(page, f);
  const rowsBefore = defaultsRows();
  const startLength = await historyLength(page);
  const pngIds = ['alpha-1.png', 'alpha-2.png', 'alpha-3.png'].map((name) => f.ids[name]).sort((x, y) => x - y);

  const heldList = await resetThenHeldList(page, gate);
  const heldRefresh = gate.next(isReset);
  await applyAutoRename(page);
  await heldRefresh.arrival;
  await openFilters(page);
  await markRegion(page);
  await page.locator('#search').fill('');
  await expectInstalled(page);
  await closeFilters(page);
  // Both obsolete answers are released last and install nothing.
  heldRefresh.release();
  heldList.release();
  await settled(page);

  expect(query(page).get('search') ?? '').toBe('');
  expect(query(page).has('resetFilters')).toBe(false);
  expect(query(page).getAll('extension')).toEqual(['png']);
  // The once-hidden gamma-3 and the visible alpha-1 are both shown again.
  expect((await renderedIds(page)).sort((x, y) => x - y)).toEqual(pngIds);
  expect(await checkedIds(page)).toEqual([]);
  expect(await retainedIds(page)).toEqual([]);
  expect(await bulkPayload(page)).toEqual([]);
  await expect(countText(page)).toHaveText('0 of 3 selected');
  // A new selection is the payload's only content.
  await select(page, f.ids['alpha-2.png']);
  expect(await bulkPayload(page)).toEqual([f.ids['alpha-2.png']]);

  // The mutation persisted; one history entry (the Search); GET-only.
  expect(f.row(selected.a1).filename).not.toMatch(/^alpha-/);
  expect(f.onDisk(f.row(selected.a1).relative_path)).toBe(true);
  expect(await historyLength(page)).toBe(startLength + 1);
  expect(control.posts).toEqual(racePosts(f));
  expect(defaultsRows()).toEqual(rowsBefore);
  expect(control.errors).toEqual([]);
});

test('R2a-E/F: an ordinary mutation refresh and a pure Grid/List change keep visible and hidden selections', async ({ page }) => {
  const f = await createProject('R2 Retained');
  const control = watch(page);
  // temporaryState's inline Rename refresh is the ordinary mutation control.
  const { a1, a3 } = await temporaryState(page, f);
  // Hidden identities are retained but are never part of the payload.
  expect(await retainedIds(page)).toEqual([a3]);
  expect(await bulkPayload(page)).toEqual([a1]);

  for (const view of ['list', 'grid']) {
    await markRegion(page);
    await viewLink(page, view).click();
    await expectInstalled(page);
    expect(query(page).get('view') ?? 'grid').toBe(view);
    expect(await checkedIds(page)).toEqual([a1]);
    expect(await retainedIds(page)).toEqual([a3]);
    expect(await bulkPayload(page)).toEqual([a1]);
    await expect(countText(page)).toHaveText('1 of 2 selected (1 more not shown)');
  }
  // Another ordinary refresh (an unrelated inline Rename) keeps both.
  await renameAndRefresh(page, f, f.ids['alpha-2.png'], 'delta-2');
  expect(await checkedIds(page)).toEqual([a1]);
  expect(await retainedIds(page)).toEqual([a3]);
  expect(await bulkPayload(page)).toEqual([a1]);
  expect(control.errors).toEqual([]);
});

/*
 * F7-R2b — the refresh's List response has answered with its headers and its
 * body is held when Grid is clicked. Grid must install, in the same load.
 */
test('R2b-G/H/I/L: Grid chosen while the List body is pending installs Grid; the stale List released last loses', async ({ page }) => {
  const f = await createProject('R2 Late Body Grid');
  const control = watch(page);
  const gate = await gateAssetGets(page);
  const selected = await temporaryState(page, f);
  const rowsBefore = defaultsRows();
  const storageBefore = await storage(page);
  const startLength = await historyLength(page);
  const getsBefore = control.gets.length;

  const { heldList, listBody } = await refreshListBodyHeld(page, gate);
  await viewLink(page, 'grid').click();
  listBody.release();
  await expectInstalled(page);
  heldList.release();

  await expectResetCompleted(page, f, selected, { view: 'grid' });
  const gets = control.gets.slice(getsBefore);
  // Reset, its List continuation (aborted), the refresh's Reset re-read, its
  // List continuation (body discarded) and one Grid continuation.
  expect(gets.filter(isReset)).toHaveLength(2);
  expect(gets.filter(isListContinuation)).toHaveLength(2);
  expect(gets.filter(isGridContinuation)).toHaveLength(1);
  expect(gets).toHaveLength(5);
  expect(await historyLength(page)).toBe(startLength + 1);
  expect(control.posts).toEqual(racePosts(f));
  expect(defaultsRows()).toEqual(rowsBefore);
  expect(await storage(page)).toEqual(storageBefore);

  await page.reload();
  expect(query(page).get('view') ?? 'grid').toBe('grid');
  expect(query(page).getAll('extension')).toEqual(['jpg']);
  expect(await renderedIds(page)).toEqual(f.savedIds());
  expect(control.posts).toEqual(racePosts(f));
  expect(control.errors).toEqual([]);
});

test('R2b-J: List chosen while the carried Reset restored body is pending installs List', async ({ page }) => {
  const f = await createProject('R2 Late Body List');
  const control = watch(page);
  const gate = await gateAssetGets(page);
  const selected = await temporaryState(page, f);
  const rowsBefore = defaultsRows();
  const startLength = await historyLength(page);
  const getsBefore = control.gets.length;

  await openFilters(page);
  const heldReset = gate.next(isReset);
  await filterDialog(page).locator('[data-project-assets-reset]').click();
  await heldReset.arrival;
  await closeFilters(page);
  // The refresh re-reads the Reset; its restored (Grid) answer's body is held.
  const restoredBody = holdBody(isCanonical);
  await markRegion(page);
  await applyAutoRename(page);
  await bodyPending(page, restoredBody);
  await viewLink(page, 'list').click();
  restoredBody.release();
  await expectInstalled(page);
  heldReset.release();

  await expectResetCompleted(page, f, selected, { view: 'list' });
  const gets = control.gets.slice(getsBefore);
  expect(gets.filter(isReset)).toHaveLength(2);
  expect(gets.filter(isListContinuation)).toHaveLength(1);
  expect(await historyLength(page)).toBe(startLength + 1);
  expect(control.posts).toEqual(racePosts(f));
  expect(defaultsRows()).toEqual(rowsBefore);
  expect(control.errors).toEqual([]);
});

test('R2b-K: a rapid Grid then List while the List body is pending installs List with no extra GET', async ({ page }) => {
  const f = await createProject('R2 Late Body Reversal');
  const control = watch(page);
  const gate = await gateAssetGets(page);
  const selected = await temporaryState(page, f);
  const startLength = await historyLength(page);
  const getsBefore = control.gets.length;

  const { heldList, listBody } = await refreshListBodyHeld(page, gate);
  await viewLink(page, 'grid').click();
  await viewLink(page, 'list').click();
  listBody.release();
  await expectInstalled(page);
  heldList.release();

  await expectResetCompleted(page, f, selected, { view: 'list' });
  const gets = control.gets.slice(getsBefore);
  expect(gets.filter(isGridContinuation)).toHaveLength(0);
  expect(gets).toHaveLength(4);
  expect(await historyLength(page)).toBe(startLength + 1);
  expect(control.posts).toEqual(racePosts(f));
  expect(control.errors).toEqual([]);
});

test('R2b: a failed late Grid continuation keeps the page; GET-only Retry completes the Reset with Grid', async ({ page }) => {
  const f = await createProject('R2 Late Body Retry');
  const control = watch(page);
  const gate = await gateAssetGets(page);
  const selected = await temporaryState(page, f);
  const rowsBefore = defaultsRows();
  const startLength = await historyLength(page);
  const startUrl = page.url();

  const { heldList, listBody } = await refreshListBodyHeld(page, gate);
  gate.next(isGridContinuation, { fail: true });
  await viewLink(page, 'grid').click();
  listBody.release();
  await expect(failureNotice(page)).toBeVisible();
  await settled(page);
  // Nothing installed: no hybrid List page, no URL change.
  expect(page.url()).toBe(startUrl);
  await expect(countText(page)).toHaveText('1 of 2 selected (1 more not shown)');
  const postsAfterApply = [...control.posts];

  await markRegion(page);
  await retry(page).click();
  await expectInstalled(page);
  heldList.release();

  await expectResetCompleted(page, f, selected, { view: 'grid' });
  expect(await historyLength(page)).toBe(startLength + 1);
  expect(control.posts).toEqual(postsAfterApply);
  expect(control.posts).toEqual(racePosts(f));
  expect(defaultsRows()).toEqual(rowsBefore);
  expect(control.errors).toEqual([]);
});

test('R2b: a new Reset while the List body is pending supersedes the old Reset; the old body installs nothing', async ({ page }) => {
  const f = await createProject('R2 Late Body New Reset');
  const control = watch(page);
  const gate = await gateAssetGets(page);
  const selected = await temporaryState(page, f);
  const rowsBefore = defaultsRows();
  const startLength = await historyLength(page);

  const { heldList, listBody } = await refreshListBodyHeld(page, gate);
  await openFilters(page);
  await filterDialog(page).locator('[data-project-assets-reset]').click();
  await expectInstalled(page);
  await closeFilters(page);
  listBody.release();
  heldList.release();

  // The new Reset carries no earlier View: the restored Grid stands.
  await expectResetCompleted(page, f, selected, { view: 'grid' });
  expect(await historyLength(page)).toBe(startLength + 1);
  expect(control.posts).toEqual(racePosts(f));
  expect(defaultsRows()).toEqual(rowsBefore);
  expect(control.errors).toEqual([]);
});

test('R2b: a newer Search while the List body is pending wins with its own selection boundary', async ({ page }) => {
  const f = await createProject('R2 Late Body Search');
  const control = watch(page);
  const gate = await gateAssetGets(page);
  const selected = await temporaryState(page, f);
  const rowsBefore = defaultsRows();
  const startLength = await historyLength(page);

  const { heldList, listBody } = await refreshListBodyHeld(page, gate);
  await openFilters(page);
  await markRegion(page);
  await page.locator('#search').fill('alpha-2');
  await expectInstalled(page);
  await closeFilters(page);
  listBody.release();
  heldList.release();
  await settled(page);

  expect(query(page).get('search')).toBe('alpha-2');
  expect(query(page).has('resetFilters')).toBe(false);
  expect(query(page).getAll('extension')).toEqual(['png']);
  expect(await renderedIds(page)).toEqual([f.ids['alpha-2.png']]);
  expect(await checkedIds(page)).toEqual([]);
  expect(await retainedIds(page)).toEqual([]);
  expect(await bulkPayload(page)).toEqual([]);
  expect(f.row(selected.a1).filename).not.toMatch(/^alpha-/);
  expect(await historyLength(page)).toBe(startLength + 1);
  expect(control.posts).toEqual(racePosts(f));
  expect(defaultsRows()).toEqual(rowsBefore);
  expect(control.errors).toEqual([]);
});

/*
 * F7-R3 — the independent two-mutation reproduction. Reset + List (held) →
 * real Auto Rename M1 (its refresh GET held) → Search cleared (held) → real
 * inline Rename M2, whose refresh re-reads the newer Search destination.
 * Data ownership passes to M2's GET; the Search's selection-clearing decision
 * must pass with it, so the old visible and hidden identities stay cleared.
 */
const isSearchCleared = (url) => !isReset(url) && url.searchParams.getAll('extension').includes('png')
  && !url.searchParams.get('search');

// A real acknowledged inline Rename and the page's post-mutation refresh,
// without waiting for any install (the caller decides what installs).
async function renameStartingRefresh(page, f, assetId, basename) {
  const status = await page.evaluate(async ({ projectId, id, filename }) => {
    const token = document.querySelector('input[name="_csrf"]')?.value;
    const body = new URLSearchParams({ _csrf: token, origin: 'assets', filename });
    const response = await fetch(`/projects/${projectId}/assets/${id}/rename`, {
      method: 'POST', body, headers: { Accept: 'application/json' }, credentials: 'same-origin',
    });
    return response.status;
  }, { projectId: f.id, id: assetId, filename: basename });
  expect(status).toBe(200);
  await page.evaluate(() => document.dispatchEvent(new Event('project-asset-categories-changed')));
}

// Steps 1–7: the held Reset/List, held M1 refresh and held newer Search.
async function mutationThenHeldSearch(page, gate) {
  const heldList = await resetThenHeldList(page, gate);
  const heldM1 = gate.next(isReset);
  await applyAutoRename(page);
  await heldM1.arrival;
  const heldSearch = gate.next(isSearchCleared);
  await openFilters(page);
  await page.locator('#search').fill('');
  await heldSearch.arrival;
  await closeFilters(page);
  await markRegion(page);
  return { heldList, heldM1, heldSearch };
}

async function expectSearchClearedInstalled(page, f, startLength) {
  await settled(page);
  const pngIds = ['alpha-1.png', 'alpha-2.png', 'alpha-3.png'].map((name) => f.ids[name]).sort((x, y) => x - y);
  expect(query(page).get('search') ?? '').toBe('');
  expect(query(page).has('resetFilters')).toBe(false);
  expect(query(page).getAll('extension')).toEqual(['png']);
  expect(f.url(query(page).toString())).toBe(page.url());
  expect((await renderedIds(page)).sort((x, y) => x - y)).toEqual(pngIds);
  await openFilters(page);
  expect(await page.locator('#search').inputValue()).toBe('');
  await closeFilters(page);
  // No old identity is resurrected, visibly or as a hidden retained one.
  expect(await checkedIds(page)).toEqual([]);
  expect(await retainedIds(page)).toEqual([]);
  expect(await bulkPayload(page)).toEqual([]);
  await expect(countText(page)).toHaveText('0 of 3 selected');
  await expect(failureNotice(page)).toHaveCount(0);
  // Only the Search added a history entry.
  expect(await historyLength(page)).toBe(startLength + 1);
}

test('R3-A/D/E: M1 -> newer Search -> M2 re-reading it keeps old visible and hidden ids cleared', async ({ page }) => {
  const f = await createProject('R3 Two Mutations');
  const control = watch(page);
  const gate = await gateAssetGets(page);
  const { a1, a3 } = await temporaryState(page, f);
  const a2 = f.ids['alpha-2.png'];
  const rowsBefore = defaultsRows();
  const startLength = await historyLength(page);

  const { heldList, heldM1, heldSearch } = await mutationThenHeldSearch(page, gate);
  // M2 installs before the Search response it re-reads.
  await renameStartingRefresh(page, f, a2, 'delta-2');
  await expectInstalled(page);
  // The older responses released last install nothing.
  heldSearch.release();
  heldM1.release();
  heldList.release();
  await expectSearchClearedInstalled(page, f, startLength);

  // Both real mutations persisted; nothing replayed.
  expect(f.row(a1).filename).not.toMatch(/^alpha-/);
  expect(f.onDisk(f.row(a1).relative_path)).toBe(true);
  expect(f.row(a2).filename).toBe('delta-2.png');
  expect(f.onDisk(f.row(a2).relative_path)).toBe(true);
  expect(f.row(a3).filename).not.toMatch(/^alpha-/);
  expect(control.posts).toEqual([...racePosts(f), `POST /projects/${f.id}/assets/${a2}/rename`]);
  // A new selection is the payload's only content.
  await select(page, a2);
  expect(await bulkPayload(page)).toEqual([a2]);
  expect(defaultsRows()).toEqual(rowsBefore);
  expect(control.errors).toEqual([]);
});

test('R3-B: M1 -> newer Search -> M2 (held) -> M3 keeps the clearing decision', async ({ page }) => {
  const f = await createProject('R3 Three Mutations');
  const control = watch(page);
  const gate = await gateAssetGets(page);
  const { a1 } = await temporaryState(page, f);
  const a2 = f.ids['alpha-2.png'];
  const startLength = await historyLength(page);

  const { heldList, heldM1, heldSearch } = await mutationThenHeldSearch(page, gate);
  const heldM2 = gate.next(isSearchCleared);
  await renameStartingRefresh(page, f, a2, 'delta-2');
  await heldM2.arrival;
  await renameStartingRefresh(page, f, a1, 'epsilon-1');
  await expectInstalled(page);
  heldM2.release();
  heldSearch.release();
  heldM1.release();
  heldList.release();
  await expectSearchClearedInstalled(page, f, startLength);

  expect(f.row(a2).filename).toBe('delta-2.png');
  expect(f.row(a1).filename).toBe('epsilon-1.png');
  expect(f.onDisk('wip/epsilon-1.png')).toBe(true);
  expect(control.posts).toEqual([
    ...racePosts(f),
    `POST /projects/${f.id}/assets/${a2}/rename`,
    `POST /projects/${f.id}/assets/${a1}/rename`,
  ]);
  expect(control.errors).toEqual([]);
});

test('R3-F: a failed M2 re-read keeps the page; its GET-only Retry installs with old ids cleared', async ({ page }) => {
  const f = await createProject('R3 Failed Retry');
  const control = watch(page);
  const gate = await gateAssetGets(page);
  const { a1, a3 } = await temporaryState(page, f);
  const a2 = f.ids['alpha-2.png'];
  const startLength = await historyLength(page);

  const { heldList, heldM1, heldSearch } = await mutationThenHeldSearch(page, gate);
  const failedM2 = gate.next(isSearchCleared, { fail: true });
  await renameStartingRefresh(page, f, a2, 'delta-2');
  await failedM2.arrival;
  await expect(failureNotice(page)).toBeVisible();
  // Nothing installed: the page keeps its own selection meanwhile.
  expect(await checkedIds(page)).toEqual([a1]);
  expect(await retainedIds(page)).toEqual([a3]);

  const gets = control.gets.length;
  await retry(page).click();
  await expectInstalled(page);
  expect(control.gets.slice(gets).map((url) => isSearchCleared(url))).toEqual([true]);
  heldSearch.release();
  heldM1.release();
  heldList.release();
  await expectSearchClearedInstalled(page, f, startLength);
  expect(f.row(a2).filename).toBe('delta-2.png');
  expect(control.posts).toEqual([...racePosts(f), `POST /projects/${f.id}/assets/${a2}/rename`]);
  expect(control.errors).toEqual([]);
});
