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

/*
 * WP10b follow-up F5 — the Project Assets toolbar Grid/List links are rendered
 * against the installed page. A View click while a filter edit is still
 * debounced, in flight or failed must apply the clicked View to that newest
 * intended filter state, never navigate to the stale rendered address.
 * Requests are held or failed through route gates, never through sleeps.
 * All data lives in a temporary root that is removed afterward.
 */

let server;
let db;
let app;
let root;
let projectsRoot;
let baseURL;

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-pa-pending-view-browser-'));
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

/**
 * files: [{ name, category = 'final', tag, used, missing }]. Categories other
 * than the default 'final' are added on demand.
 */
async function createProject(title, files) {
  const project = app.locals.projectService.create({ title, status: 'tbd' });
  const categories = app.locals.projectAssetCategoryService;
  const categoryId = (slug) => {
    if (!categories.list(project.id).some((candidate) => candidate.directory_slug === slug)) {
      categories.add(project.id, { displayName: slug.toUpperCase(), directorySlug: slug });
    }
    return categories.list(project.id).find((candidate) => candidate.directory_slug === slug).id;
  };
  const fileOf = (file) => path.join(projectsRoot, project.project_dir, file.category || 'final', file.name);
  for (const [index, file] of files.entries()) {
    categoryId(file.category || 'final');
    fs.mkdirSync(path.dirname(fileOf(file)), { recursive: true });
    const image = sharp({ create: { width: 12, height: 12, channels: 3, background: { r: index * 25, g: 90, b: 160 } } });
    await (file.name.endsWith('.png') ? image.png() : image.jpeg()).toFile(fileOf(file));
  }
  app.locals.assetScanner.scanProjectAssets(project.id);
  const ids = Object.fromEntries(db.prepare('SELECT filename, id FROM assets WHERE project_id = ?')
    .all(project.id).map((row) => [row.filename, row.id]));
  const tagIds = {};
  for (const file of files.filter((candidate) => candidate.tag)) {
    tagIds[file.tag] ||= app.locals.tagService.createTag({ name: `${title} ${file.tag}` }).id;
    app.locals.assetTagService.replaceAssetTags(ids[file.name], [tagIds[file.tag]]);
  }
  const used = files.filter((file) => file.used).map((file) => ids[file.name]);
  if (used.length) createReleaseService({ db }).createReleaseWithSelectedAssets(project.id, { title: `${title} Release` }, used);
  const missing = files.filter((file) => file.missing);
  if (missing.length) {
    missing.forEach((file) => fs.rmSync(fileOf(file), { force: true }));
    app.locals.assetScanner.scanProjectAssets(project.id);
  }
  return {
    id: project.id,
    dir: project.project_dir,
    ids,
    tagIds,
    categoryId,
    url: (query = '') => `${baseURL}/projects/${project.id}/assets${query ? `?${query}` : ''}`,
  };
}

const region = (page) => page.locator('[data-project-assets-live-region]');
const filterDialog = (page) => page.locator('#project-assets-filter-dialog');
const settled = (page) => expect(region(page)).not.toHaveAttribute('aria-busy', 'true');
const query = (page) => new URL(page.url()).searchParams;
const historyLength = (page) => page.evaluate(() => window.history.length);
const viewLink = (page, view) => page.locator(`nav.view-switcher a[aria-label="${view === 'list' ? 'List' : 'Grid'} view"]`);
const failureNotice = (page) => page.locator('[data-live-filter-failure]');

// Every rendered result card, by filename (missing assets included).
async function renderedNames(page) {
  return region(page).locator('ul.asset-grid > li, ul.asset-list > li').evaluateAll((items) => items.map((item) => {
    const checkbox = item.querySelector('input[name="selectedAssetIds"]');
    return checkbox?.getAttribute('data-asset-filename')
      || item.querySelector('[data-auto-rename-asset]')?.getAttribute('aria-label')?.replace(/^Reorder /, '')
      || item.textContent.trim();
  }));
}

async function resultCount(page) {
  const count = region(page).locator('[data-selected-count]');
  if (await count.count() === 0) return 0;
  return Number(await count.getAttribute('data-selected-total'));
}

// The installed filter state of #asset-filters, form-associated controls included.
const formState = (page) => page.evaluate(() => {
  const data = new FormData(document.getElementById('asset-filters'));
  return {
    extension: data.getAll('extension').filter(Boolean),
    tag: data.getAll('tag').filter(Boolean),
    search: data.get('search') || '',
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
  await filterDialog(page).getByRole('button', { name: 'Close Filters & Defaults', exact: true }).click();
  await expect(filterDialog(page)).toBeHidden();
}

// Toggles one dropdown option without waiting for the GET it starts, then
// closes the still-open multi-select either with a real pointer click on its
// trigger (whose centre must be the trigger's own hit target, not the panel's:
// the open panel follows its trigger when the dialog layout changes) or with
// Escape (its keyboard path). Both keep the Filters & Defaults dialog open.
async function toggleOption(page, dropdownId, value, { close = 'pointer' } = {}) {
  const dropdown = page.locator(`#${dropdownId}`);
  if (!(await dropdown.evaluate((node) => node.open))) await dropdown.locator('summary').click();
  await dropdown.locator('label').filter({ has: page.locator(`input[value="${value}"]`) }).click();
  if (await dropdown.evaluate((node) => node.open)) {
    if (close === 'escape') {
      await page.keyboard.press('Escape');
    } else {
      await expect.poll(() => dropdown.locator('summary').evaluate((summary) => {
        const rect = summary.getBoundingClientRect();
        return summary.contains(document.elementFromPoint(rect.left + (rect.width / 2), rect.top + (rect.height / 2)));
      })).toBe(true);
      await dropdown.locator('summary').click();
    }
    await expect(dropdown).toHaveJSProperty('open', false);
    await expect(filterDialog(page)).toBeVisible();
  }
}

function watch(page) {
  const control = { posts: [], gets: [], errors: [] };
  page.on('pageerror', (error) => control.errors.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() === 'POST') control.posts.push(url.pathname);
    else if (/^\/projects\/\d+\/assets$/.test(url.pathname) && request.resourceType() === 'fetch') control.gets.push(url);
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

const hasExtension = (...values) => (url) => JSON.stringify(url.searchParams.getAll('extension')) === JSON.stringify(values);
const isView = (view) => (url) => url.searchParams.get('view') === view;

test('A: List during a pending Extension GET keeps PNG; reload, history and the stale GET agree', async ({ page }) => {
  const f = await createProject('F5 Extension', [{ name: 'shot.png' }, { name: 'shot.jpg' }]);
  const control = watch(page);
  const gate = await gateAssetGets(page);
  await page.goto(f.url('view=grid'));
  expect((await renderedNames(page)).sort()).toEqual(['shot.jpg', 'shot.png']);
  const startLength = await historyLength(page);

  await openFilters(page);
  const held = gate.next((url) => hasExtension('png')(url) && !url.searchParams.has('view', 'list'));
  await toggleOption(page, 'asset-extension-filter', 'png');
  const staleUrl = await held.arrival;
  expect(staleUrl.searchParams.getAll('extension')).toEqual(['png']);
  await closeFilters(page);
  await viewLink(page, 'list').click();
  await settled(page);

  const viewGet = control.gets.at(-1);
  expect(viewGet.searchParams.getAll('extension')).toEqual(['png']);
  expect(viewGet.searchParams.get('view')).toBe('list');
  await expectPresentation(page, 'list');
  expect(await renderedNames(page)).toEqual(['shot.png']);
  expect(await resultCount(page)).toBe(1);
  expect(query(page).getAll('extension')).toEqual(['png']);
  expect(query(page).get('view')).toBe('list');
  expect(await historyLength(page)).toBe(startLength + 1);
  const state = await formState(page);
  expect(state.extension).toEqual(['png']);
  expect(state.view).toBe('list');

  // The superseded GET released last cannot restore both assets.
  held.release();
  await expect.poll(() => renderedNames(page)).toEqual(['shot.png']);
  await expectPresentation(page, 'list');
  expect(query(page).getAll('extension')).toEqual(['png']);

  await page.reload();
  await expectPresentation(page, 'list');
  expect(await renderedNames(page)).toEqual(['shot.png']);
  await page.goBack();
  await expect.poll(() => query(page).get('view')).toBe('grid');
  await settled(page);
  await expectPresentation(page, 'grid');
  expect((await renderedNames(page)).sort()).toEqual(['shot.jpg', 'shot.png']);
  await page.goForward();
  await expect.poll(() => query(page).get('view')).toBe('list');
  await settled(page);
  expect(await renderedNames(page)).toEqual(['shot.png']);
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('B: List during a debounced Search keeps only the latest Search (Alpha → Beta)', async ({ page }) => {
  const f = await createProject('F5 Search', [
    { name: 'alpha-1.png' }, { name: 'beta-1.png' }, { name: 'beta-2.jpg' }, { name: 'gamma.png' },
  ]);
  const control = watch(page);
  await page.goto(f.url('view=grid'));
  await expect.poll(() => resultCount(page)).toBe(4);
  const startLength = await historyLength(page);
  await openFilters(page);

  // Type, retype, close and click List within one task: the 350 ms Search
  // debounce cannot fire first, so the View click owns the Search.
  await page.evaluate(() => {
    const search = document.getElementById('search');
    search.value = 'alpha';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    search.value = 'beta';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#project-assets-filter-dialog [data-dialog-close]').click();
    document.querySelector('nav.view-switcher a[aria-label="List view"]').click();
  });
  await settled(page);

  await expectPresentation(page, 'list');
  expect((await renderedNames(page)).sort()).toEqual(['beta-1.png', 'beta-2.jpg']);
  expect(await resultCount(page)).toBe(2);
  expect(query(page).get('search')).toBe('beta');
  expect(query(page).get('view')).toBe('list');
  expect(await historyLength(page)).toBe(startLength + 1);
  // A debounce folded into the View click never fires a second request.
  await page.waitForTimeout(500);
  expect(control.gets.filter((url) => url.searchParams.has('search')).map((url) => url.searchParams.get('search')))
    .toEqual(['beta']);
  const state = await formState(page);
  expect(state.search).toBe('beta');
  expect(state.view).toBe('list');

  await page.reload();
  await expectPresentation(page, 'list');
  expect((await renderedNames(page)).sort()).toEqual(['beta-1.png', 'beta-2.jpg']);
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('C: List during a pending Extension GET keeps Category, Tag, Presence and Usage restrictions', async ({ page }) => {
  // Each restriction excludes a different asset; only g-cover.png matches all.
  const f = await createProject('F5 Compose', [
    { name: 'a-cover.png', tag: 'Alpha', used: true },
    { name: 'b-cover.jpg', tag: 'Alpha' },
    { name: 'c-scene.png', tag: 'Beta' },
    { name: 'e-cover.png', tag: 'Alpha', category: 'wip' },
    { name: 'f-gone.png', tag: 'Alpha', missing: true },
    { name: 'g-cover.png', tag: 'Alpha' },
  ]);
  const final = f.categoryId('final');
  const restricted = `category=${final}&tag=${f.tagIds.Alpha}&presence=present&usage=unused&extension=png`;
  const count = async (search) => {
    const response = await page.request.get(f.url(search));
    return ((await response.text()).match(/<li class="asset-grid-item/g) || []).length;
  };
  // The fixture is discriminating: dropping any one restriction adds an asset.
  expect(await count(restricted)).toBe(1);
  for (const key of ['category', 'tag', 'presence', 'usage', 'extension']) {
    const params = new URLSearchParams(restricted);
    params.delete(key);
    expect(await count(params.toString()), key).toBe(2);
  }

  const control = watch(page);
  const gate = await gateAssetGets(page);
  await page.goto(f.url(`category=${final}&tag=${f.tagIds.Alpha}&presence=present&usage=unused&view=grid`));
  expect((await renderedNames(page)).sort()).toEqual(['b-cover.jpg', 'g-cover.png']);
  await openFilters(page);
  const held = gate.next((url) => hasExtension('png')(url) && !isView('list')(url));
  await toggleOption(page, 'asset-extension-filter', 'png');
  await held.arrival;
  await closeFilters(page);
  await viewLink(page, 'list').click();
  await settled(page);

  const viewGet = control.gets.at(-1);
  for (const url of [viewGet, new URL(page.url())]) {
    expect(url.searchParams.get('category')).toBe(String(final));
    expect(url.searchParams.getAll('tag')).toEqual([String(f.tagIds.Alpha)]);
    expect(url.searchParams.get('presence')).toBe('present');
    expect(url.searchParams.get('usage')).toBe('unused');
    expect(url.searchParams.getAll('extension')).toEqual(['png']);
    expect(url.searchParams.get('view')).toBe('list');
    expect(url.href).not.toMatch(/%2C/);
  }
  await expectPresentation(page, 'list');
  expect(await renderedNames(page)).toEqual(['g-cover.png']);
  expect(await resultCount(page)).toBe(1);
  const state = await formState(page);
  expect(state.extension).toEqual(['png']);
  expect(state.tag).toEqual([String(f.tagIds.Alpha)]);
  expect(state.view).toBe('list');
  await expect(page.getByRole('heading', { name: 'Project actions', exact: true })).toBeVisible();

  held.release();
  await expect.poll(() => renderedNames(page)).toEqual(['g-cover.png']);
  await page.reload();
  expect(await renderedNames(page)).toEqual(['g-cover.png']);
  await expectPresentation(page, 'list');
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('D: Grid during a pending Tag GET started in List keeps the restriction and Grid; Back/Forward reconcile', async ({ page }) => {
  const f = await createProject('F5 Reverse', [
    { name: 'one.png', tag: 'Keep' }, { name: 'two.png', tag: 'Drop' }, { name: 'three.jpg', tag: 'Keep' },
  ]);
  const control = watch(page);
  const gate = await gateAssetGets(page);
  await page.goto(f.url('view=list'));
  await expectPresentation(page, 'list');
  const startLength = await historyLength(page);

  await openFilters(page);
  const held = gate.next((url) => url.searchParams.getAll('tag').length === 1 && !isView('grid')(url));
  await toggleOption(page, 'asset-tag-filter', String(f.tagIds.Keep), { close: 'escape' });
  await held.arrival;
  await closeFilters(page);
  await viewLink(page, 'grid').click();
  await settled(page);

  expect(control.gets.at(-1).searchParams.getAll('tag')).toEqual([String(f.tagIds.Keep)]);
  // Grid is the resolved default the canonical link leaves implicit.
  expect(control.gets.at(-1).searchParams.get('view') ?? 'grid').toBe('grid');
  expect(control.gets.at(-1).searchParams.get('view')).not.toBe('list');
  await expectPresentation(page, 'grid');
  expect((await renderedNames(page)).sort()).toEqual(['one.png', 'three.jpg']);
  expect(await resultCount(page)).toBe(2);
  expect(query(page).get('view') ?? 'grid').toBe('grid');
  expect(query(page).getAll('tag')).toEqual([String(f.tagIds.Keep)]);
  expect((await formState(page)).view).toBe('grid');
  expect(await historyLength(page)).toBe(startLength + 1);

  held.release();
  await expect.poll(() => renderedNames(page).then((names) => names.sort())).toEqual(['one.png', 'three.jpg']);
  await expectPresentation(page, 'grid');

  await page.goBack();
  await expect.poll(() => query(page).get('view')).toBe('list');
  await settled(page);
  await expectPresentation(page, 'list');
  expect((await renderedNames(page)).sort()).toEqual(['one.png', 'three.jpg', 'two.png']);
  expect((await formState(page)).view).toBe('list');
  await page.goForward();
  await expect.poll(() => query(page).get('view') ?? 'grid').toBe('grid');
  await settled(page);
  await expectPresentation(page, 'grid');
  expect((await renderedNames(page)).sort()).toEqual(['one.png', 'three.jpg']);
  expect((await formState(page)).view).toBe('grid');
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});

const ORDER_FILES = [
  '01-draft.png', '02-ref.jpg', '03-draft.png', '04-ref.jpg',
  '05-draft.jpg', '06-ref.png', '07-draft.png', '08-ref.jpg',
];

test('E: an unsaved filtered order draft with hidden assets survives a View switch over a pending Search GET', async ({ page }) => {
  const f = await createProject('F5 Ordering', ORDER_FILES.map((name) => ({ name, category: 'wip' })));
  const wip = f.categoryId('wip');
  const namesFor = (ids) => ids.map((id) => Object.keys(f.ids).find((name) => f.ids[name] === id));
  const surface = region(page).locator('[data-auto-rename-surface]');
  const item = (name) => surface.locator(`[data-auto-rename-asset][aria-label="Reorder ${name}"]`);
  const orderNames = async () => namesFor(JSON.parse(await page.locator('[data-auto-rename-order-input]').inputValue()));
  const control = watch(page);
  const gate = await gateAssetGets(page);

  await page.goto(f.url(`category=${wip}&extension=png&view=grid`));
  expect(await renderedNames(page)).toEqual(['01-draft.png', '03-draft.png', '06-ref.png', '07-draft.png']);
  for (const name of ['01-draft.png', '07-draft.png']) {
    await item(name).locator('.asset-selection-control').click();
    await expect(item(name).locator('input[name="selectedAssetIds"]')).toBeChecked();
  }
  await expect(page.locator('[data-selected-count]')).toHaveText('2 of 4 selected');

  // An unsaved drag order: 07 to the front of the visible PNGs. The hidden
  // JPEG slots (2, 4, 5, 8) keep their positions.
  const first = item('01-draft.png');
  const firstBox = await first.boundingBox();
  await item('07-draft.png').dragTo(first, { targetPosition: { x: 2, y: firstBox.height / 2 } });
  const merged = [
    '07-draft.png', '02-ref.jpg', '01-draft.png', '04-ref.jpg',
    '05-draft.jpg', '03-draft.png', '06-ref.png', '08-ref.jpg',
  ];
  await expect.poll(orderNames).toEqual(merged);

  // A newer Search held in flight, then List.
  await openFilters(page);
  const held = gate.next((url) => url.searchParams.get('search') === 'draft' && !isView('list')(url));
  await page.locator('#search').fill('draft');
  await held.arrival;
  await closeFilters(page);
  await viewLink(page, 'list').click();
  await settled(page);
  held.release();

  await expectPresentation(page, 'list');
  expect(query(page).get('search')).toBe('draft');
  expect(query(page).getAll('extension')).toEqual(['png']);
  expect(query(page).get('category')).toBe(String(wip));
  // The draft is kept: visible order follows it and the hidden 06-ref.png and
  // every JPEG keep their slots.
  await expect.poll(() => renderedNames(page)).toEqual(['07-draft.png', '01-draft.png', '03-draft.png']);
  await expect.poll(orderNames).toEqual(merged);
  expect(namesFor(JSON.parse(await surface.getAttribute('data-auto-rename-base-order')))).toEqual(ORDER_FILES);
  // Established selection model: a user's filter/View navigation starts a new
  // selection (only mutation refreshes retain hidden selections).
  await expect(page.locator('[data-selected-count]')).toHaveText('0 of 3 selected');
  // No reorder, Auto Rename or defaults POST came from the View switch.
  expect(control.posts).toEqual([]);

  // The kept draft still drives Preview, and Cancel keeps it.
  for (const name of ['01-draft.png', '07-draft.png']) {
    await item(name).locator('.asset-selection-control').click();
  }
  const submit = page.locator('[data-auto-rename-submit]');
  await expect(submit).toBeEnabled();
  const [preview] = await Promise.all([
    page.waitForRequest((request) => request.method() === 'POST'
      && new URL(request.url()).pathname === `/projects/${f.id}/assets/auto-rename/preview`),
    submit.click(),
  ]);
  const body = new URLSearchParams(preview.postData() || '');
  expect(namesFor(JSON.parse(body.get('orderedAssetIds')))).toEqual(merged);
  expect(namesFor(JSON.parse(body.get('selectedAssetIds'))).sort()).toEqual(['01-draft.png', '07-draft.png']);
  expect(body.get('view')).toBe('list');
  expect(body.get('search')).toBe('draft');
  const dialog = page.locator('#auto-rename-confirmation-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await orderNames()).toEqual(merged);
  expect(fs.readdirSync(path.join(projectsRoot, f.dir, 'wip')).sort()).toEqual([...ORDER_FILES].sort());
  expect(control.errors).toEqual([]);
});

test('F: project-scoped saved defaults stay authoritative; a View switch over a pending Search saves nothing', async ({ page }) => {
  const f = await createProject('F5 Defaults', [{ name: 'one.png' }, { name: 'two.png' }, { name: 'two.jpg' }]);
  const defaultsForm = page.locator('#project-assets-defaults-form');
  const snapshots = () => defaultsForm.locator('[data-project-assets-default-values]').evaluate((el) => JSON.parse(el.textContent));
  const scope = () => defaultsForm.locator('input[name="scope"]:checked').inputValue();
  const control = watch(page);

  // Project-only scope with a saved Extension = PNG default.
  await page.goto(f.url());
  await openFilters(page);
  const activated = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/projects/${f.id}/assets/defaults`);
  await page.locator('label[for="project-assets-defaults-scope-project"]').click();
  expect((await activated).status()).toBeLessThan(400);
  await settled(page);
  await toggleOption(page, 'asset-extension-filter', 'png', { close: 'escape' });
  await expect.poll(() => query(page).getAll('extension')).toEqual(['png']);
  await settled(page);
  const saved = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/projects/${f.id}/assets/defaults`);
  await filterDialog(page).getByRole('button', { name: 'Save new defaults', exact: true }).click();
  expect((await saved).status()).toBeLessThan(400);
  await expect(defaultsForm).toHaveAttribute('data-settings-fetch-save-state', 'saved');
  await settled(page);
  await closeFilters(page);

  await page.goto(f.url());
  expect((await renderedNames(page)).sort()).toEqual(['one.png', 'two.png']);
  const savedSnapshots = await snapshots();
  expect(await scope()).toBe('project');
  const sizesBefore = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)])));
  const postsBefore = control.posts.length;

  // A temporary Search held in flight, then List.
  const gate = await gateAssetGets(page);
  await openFilters(page);
  const held = gate.next((url) => url.searchParams.get('search') === 'two' && !isView('list')(url));
  await page.locator('#search').fill('two');
  await held.arrival;
  await closeFilters(page);
  await viewLink(page, 'list').click();
  await settled(page);
  held.release();

  await expectPresentation(page, 'list');
  expect(await renderedNames(page)).toEqual(['two.png']);
  expect(query(page).get('search')).toBe('two');
  expect(query(page).get('view')).toBe('list');
  expect(control.posts.slice(postsBefore)).toEqual([]);
  expect(await snapshots()).toEqual(savedSnapshots);
  expect(await scope()).toBe('project');
  expect(await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)]))))
    .toEqual(sizesBefore);

  // Reset filters restores every saved control, View included; nothing saved.
  await page.reload();
  expect(await renderedNames(page)).toEqual(['two.png']);
  await openFilters(page);
  await filterDialog(page).locator('[data-project-assets-reset]').click();
  await settled(page);
  await expect.poll(() => renderedNames(page).then((names) => names.sort())).toEqual(['one.png', 'two.png']);
  await expectPresentation(page, 'grid');
  expect((await formState(page)).search).toBe('');
  expect(control.posts.slice(postsBefore)).toEqual([]);
  expect(await snapshots()).toEqual(savedSnapshots);
  expect(await scope()).toBe('project');
  expect(control.errors).toEqual([]);
});

test('G: a failed View GET keeps the installed page and selection; Retry is GET-only; an earlier failed filter also composes', async ({ page }) => {
  const f = await createProject('F5 Failure', [{ name: 'keep.png' }, { name: 'keep.jpg' }]);
  const control = watch(page);
  const gate = await gateAssetGets(page);
  await page.goto(f.url('view=grid'));
  const startUrl = page.url();
  const card = (name) => region(page).locator(`input[name="selectedAssetIds"][data-asset-filename="${name}"]`);
  await card('keep.jpg').check({ force: true });
  await expect(card('keep.jpg')).toBeChecked();

  // 1. A pending Extension GET, then List whose GET fails.
  await openFilters(page);
  const held = gate.next((url) => hasExtension('png')(url) && !isView('list')(url));
  const failed = gate.next((url) => hasExtension('png')(url) && isView('list')(url), { fail: true });
  await toggleOption(page, 'asset-extension-filter', 'png');
  await held.arrival;
  await closeFilters(page);
  await viewLink(page, 'list').click();
  await failed.arrival;
  await expect(failureNotice(page)).toBeVisible();
  held.release();
  await settled(page);
  expect(page.url()).toBe(startUrl);
  await expectPresentation(page, 'grid');
  expect((await renderedNames(page)).sort()).toEqual(['keep.jpg', 'keep.png']);
  await expect(card('keep.jpg')).toBeChecked();

  const retry = page.locator('[data-live-filter-retry]').first();
  const retried = page.waitForRequest((request) => request.resourceType() === 'fetch'
    && new URL(request.url()).pathname === `/projects/${f.id}/assets`);
  await retry.click();
  const retryRequest = await retried;
  expect(retryRequest.method()).toBe('GET');
  expect(new URL(retryRequest.url()).searchParams.getAll('extension')).toEqual(['png']);
  expect(new URL(retryRequest.url()).searchParams.get('view')).toBe('list');
  await settled(page);
  await expectPresentation(page, 'list');
  expect(await renderedNames(page)).toEqual(['keep.png']);
  await expect(failureNotice(page)).toHaveCount(0);
  expect(query(page).getAll('extension')).toEqual(['png']);

  // 2. An earlier filter GET fails before the View action.
  await page.goto(f.url('view=list'));
  await openFilters(page);
  const earlier = gate.next((url) => hasExtension('jpg')(url), { fail: true });
  await toggleOption(page, 'asset-extension-filter', 'jpg');
  await earlier.arrival;
  await expect(failureNotice(page)).toBeVisible();
  await closeFilters(page);
  await viewLink(page, 'grid').click();
  await settled(page);
  await expectPresentation(page, 'grid');
  expect(await renderedNames(page)).toEqual(['keep.jpg']);
  expect(query(page).getAll('extension')).toEqual(['jpg']);
  expect(query(page).get('view') ?? 'grid').toBe('grid');
  await page.reload();
  expect(await renderedNames(page)).toEqual(['keep.jpg']);
  await page.goBack();
  await expect.poll(() => query(page).get('view')).toBe('list');
  await settled(page);
  expect((await renderedNames(page)).sort()).toEqual(['keep.jpg', 'keep.png']);
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});
