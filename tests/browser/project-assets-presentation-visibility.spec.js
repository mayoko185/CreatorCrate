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
 * Filters & Defaults R3 — the Project Assets Filters & Defaults dialog shows
 * only the presentation fields of the current View: Grid style and Grid size
 * default for Grid, List size default for List. A hidden field keeps its
 * control, value, form association and default eligibility, so Save, Reset
 * filters, Reset defaults and scope activation behave exactly as before, and
 * switching back shows the same value. Visibility never sends a request, a
 * Save or a browser-size write. Requests are held or failed through route
 * gates, never sleeps. All data lives in a temporary root removed afterward.
 */

const FILES = ['01-draft.png', '02-ref.jpg', '03-draft.png', '04-ref.jpg'];
const PAGE = 'projectAssets';

let server;
let db;
let app;
let root;
let projectsRoot;
let baseURL;

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-pa-presentation-browser-'));
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
    const side = 12 + index * 6;
    const image = sharp({ create: { width: side, height: side, channels: 3, background: { r: index * 40, g: 90, b: 160 } } });
    await (filename.endsWith('.png') ? image.png() : image.jpeg()).toFile(path.join(categoryDir, filename));
  }
  app.locals.assetScanner.scanProjectAssets(project.id);
  const ids = Object.fromEntries(db.prepare('SELECT filename, id FROM assets WHERE project_id = ?')
    .all(project.id).map((row) => [row.filename, row.id]));
  return {
    id: project.id,
    categoryId: category.id,
    ids,
    url: (search = '') => `${baseURL}/projects/${project.id}/assets${search ? `?${search}` : ''}`,
  };
}

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

function defaultsRows() {
  return {
    global: db.prepare("SELECT key, value FROM app_meta WHERE key LIKE 'page_defaults.project_assets.%' ORDER BY key").all(),
    project: db.prepare("SELECT project_id, option_key, value FROM project_page_defaults WHERE page_key = 'projectAssets' ORDER BY project_id, option_key").all(),
    scopes: db.prepare("SELECT project_id, active_scope FROM project_page_default_scopes WHERE page_key = 'projectAssets' ORDER BY project_id").all(),
  };
}
const globalRow = (option) => db.prepare('SELECT value FROM app_meta WHERE key = ?')
  .get(PAGE_DEFAULT_DEFINITIONS[PAGE][option].key)?.value;
const projectOptions = (projectId) => app.locals.projectPageDefaultRepository.getPageOptions(projectId, PAGE);

const region = (page) => page.locator('[data-project-assets-live-region]');
const dialog = (page) => page.locator('#project-assets-filter-dialog');
const defaultsForm = (page) => page.locator('#project-assets-defaults-form');
const settled = (page) => expect(region(page)).not.toHaveAttribute('aria-busy', 'true');
const query = (page) => new URL(page.url()).searchParams;
const viewLink = (page, view) => page.locator(`nav.view-switcher a[aria-label="${view === 'list' ? 'List' : 'Grid'} view"]`);
const failureNotice = (page) => page.locator('[data-live-filter-failure]');
const retry = (page) => page.locator('[data-live-filter-retry]');
const box = (page, id) => region(page).locator(`input[name="selectedAssetIds"][value="${id}"]`);
const checkedIds = (page) => region(page).locator('input[type="checkbox"][name="selectedAssetIds"]')
  .evaluateAll((inputs) => inputs.filter((input) => input.checked).map((input) => Number(input.value)).sort((a, b) => a - b));
const storage = (page) => page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)])));
const loadedScope = (page) => defaultsForm(page).locator('input[name="loadedScope"]').inputValue();

const KEYS = ['gridStyle', 'gridSize', 'listSize'];
const FIELD_VIEW = { gridStyle: 'grid', gridSize: 'grid', listSize: 'list' };
const LABELS = { cropped: 'Cropped', uncropped: 'Uncropped', compact: 'Compact', default: 'Default', large: 'Large', grid: 'Grid', list: 'List' };
const wrapper = (page, key) => dialog(page).locator(`.filters-defaults-section [data-dialog-field="${key}"]`);
const nativeField = (page, key) => page.locator(`#projectAssets-default-${key}`);
const dropdownId = (key) => (key === 'view' ? 'asset-view-filter-dropdown' : `projectAssets-default-${key}-dropdown`);

async function openFilters(page) {
  if (!(await dialog(page).isVisible())) {
    await page.getByRole('link', { name: 'Filters & Defaults', exact: true }).click();
  }
  await expect(dialog(page)).toBeVisible();
}

async function closeFilters(page) {
  if (!(await dialog(page).isVisible())) return;
  await dialog(page).getByRole('button', { name: 'Close Filters & Defaults', exact: true }).click();
  await expect(dialog(page)).toBeHidden();
}

// Chooses through the dialog's CreatorCrate dropdown, as a user does.
async function pick(page, key, value) {
  const dropdown = dialog(page).locator(`#${dropdownId(key)}`);
  if (!(await dropdown.evaluate((node) => node.open))) await dropdown.locator('summary').click();
  await dropdown.locator('label').filter({ hasText: new RegExp(`^\\s*${LABELS[value]}\\s*$`) }).click();
  if (await dropdown.evaluate((node) => node.open)) await dropdown.locator('summary').click();
}

async function chooseView(page, view) {
  await pick(page, 'view', view);
  await expect(page.locator('#asset-view-filter')).toHaveValue(view);
}

// Visible fields are exactly the current View's; every value (shown or
// hidden) is the expected one, in the native field and the dropdown summary.
async function expectFields(page, view, values) {
  await expect(page.locator('#asset-view-filter')).toHaveValue(view);
  for (const key of KEYS) {
    if (FIELD_VIEW[key] === view) await expect(wrapper(page, key)).toBeVisible();
    else await expect(wrapper(page, key)).toBeHidden();
    await expect(wrapper(page, key)).toHaveJSProperty('hidden', FIELD_VIEW[key] !== view);
    if (values?.[key]) {
      await expect(nativeField(page, key)).toHaveValue(values[key]);
      await expect(nativeField(page, key)).toBeEnabled();
      await expect(dialog(page).locator(`#${dropdownId(key)} summary`))
        .toHaveAttribute('aria-label', new RegExp(`${LABELS[values[key]]}$`));
    }
  }
}

function watch(page) {
  const control = { posts: [], bodies: [], gets: [], errors: [] };
  page.on('pageerror', (error) => control.errors.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() !== 'GET') {
      control.posts.push(`${request.method()} ${url.pathname}`);
      control.bodies.push(new URLSearchParams(request.postData() || ''));
    } else if (/^\/projects\/\d+\/assets$/.test(url.pathname) && request.resourceType() === 'fetch'
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

const isReset = (url) => url.searchParams.has('resetFilters');
const isView = (view) => (url) => !isReset(url) && (url.searchParams.get('view') ?? 'grid') === view;

// Save new defaults: exactly one POST, acknowledged, and its refresh installed.
async function saveDefaults(page, control) {
  const before = control.posts.length;
  const answered = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith('/assets/defaults'));
  await dialog(page).getByRole('button', { name: 'Save new defaults', exact: true }).click();
  // The Save POST answers with its redirect, which fetch follows.
  expect([200, 302]).toContain((await answered).status());
  await expect(defaultsForm(page)).toHaveAttribute('data-settings-fetch-save-state', 'saved');
  await settled(page);
  expect(control.posts).toHaveLength(before + 1);
  return control.bodies.at(-1);
}

async function activateScope(page, label) {
  const answered = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith('/assets/defaults'));
  await dialog(page).getByText(label, { exact: true }).click();
  expect((await answered).status()).toBe(200);
  await expect(defaultsForm(page).locator('input[name="loadedScope"]')).toHaveValue(label === 'Global' ? 'global' : 'project');
  await expect(defaultsForm(page)).toHaveAttribute('data-settings-fetch-save-state', 'saved');
  await settled(page);
}

test('A/B: the server renders the current View\'s fields before any script (URL, Project-only, Global, fallback)', async ({ browser }) => {
  const f = await createProject('R3 Initial');
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  try {
    // Fallback Grid.
    await page.goto(f.url('defaults=1'));
    await expectFields(page, 'grid', { gridStyle: 'uncropped', gridSize: 'default' });
    await expect(nativeField(page, 'listSize')).toHaveValue('large');

    // Project-only saved List; the hidden Grid values are present.
    saveProjectDefaults(f.id, { view: 'list', gridStyle: 'cropped', gridSize: 'compact', listSize: 'compact' });
    await page.goto(f.url('defaults=1'));
    await expectFields(page, 'list', { listSize: 'compact' });
    await expect(nativeField(page, 'gridStyle')).toHaveValue('cropped');
    await expect(nativeField(page, 'gridSize')).toHaveValue('compact');

    // An explicit URL View wins over the saved one.
    await page.goto(f.url('view=grid&defaults=1'));
    await expectFields(page, 'grid', { gridStyle: 'cropped', gridSize: 'compact' });
    await expect(nativeField(page, 'listSize')).toHaveValue('compact');

    // The Global authority decides once it is active again.
    saveGlobalDefaults({ view: 'list', gridStyle: 'uncropped', gridSize: 'large', listSize: 'large' });
    app.locals.pageDefaultsService.setPageDefaultScope(PAGE, 'global', { projectId: f.id });
    await page.goto(f.url('defaults=1'));
    await expectFields(page, 'list', { listSize: 'large' });
    await expect(nativeField(page, 'gridSize')).toHaveValue('large');
  } finally {
    await context.close();
  }
});

test('C/D/T/P: Grid → List → Grid keeps all three values; keyboard skips hidden fields; nothing is written', async ({ page }) => {
  const f = await createProject('R3 Toggle');
  const control = watch(page);
  await page.goto(f.url('view=grid'));
  const rowsBefore = defaultsRows();
  const sizesBefore = await storage(page);
  await openFilters(page);
  await expectFields(page, 'grid', { gridStyle: 'uncropped', gridSize: 'default', listSize: 'large' });

  await pick(page, 'gridStyle', 'cropped');
  await pick(page, 'gridSize', 'large');
  await settled(page);
  await chooseView(page, 'list');
  // The fields follow the choice at once, before the GET answers.
  await expectFields(page, 'list', { gridStyle: 'cropped', gridSize: 'large', listSize: 'large' });
  await settled(page);
  expect(query(page).get('view')).toBe('list');
  await pick(page, 'listSize', 'compact');
  await expectFields(page, 'list', { gridStyle: 'cropped', gridSize: 'large', listSize: 'compact' });

  await chooseView(page, 'grid');
  await settled(page);
  await expectFields(page, 'grid', { gridStyle: 'cropped', gridSize: 'large', listSize: 'compact' });

  // P: Tab and Shift+Tab move through the visible fields only and stay in the dialog.
  const walk = async (key, count) => {
    const visited = [];
    for (let index = 0; index < count; index += 1) {
      await page.keyboard.press(key);
      visited.push(await page.evaluate(() => {
        const active = document.activeElement;
        const field = active?.closest('[data-filters-visible-when-view]');
        return {
          id: active?.id || active?.closest('[id]')?.id || '',
          inDialog: Boolean(active?.closest('#project-assets-filter-dialog')),
          inHidden: Boolean(field?.hidden),
          visible: Boolean(active?.checkVisibility?.()),
        };
      }));
    }
    return visited;
  };
  const viewSummary = dialog(page).locator('#asset-view-filter-dropdown summary');
  for (const view of ['grid', 'list']) {
    if (view === 'list') {
      await chooseView(page, 'list');
      await settled(page);
    }
    await viewSummary.focus();
    const forward = await walk('Tab', 30);
    const backward = await walk('Shift+Tab', 30);
    for (const step of [...forward, ...backward]) {
      expect(step.inDialog).toBe(true);
      expect(step.inHidden).toBe(false);
      expect(step.visible).toBe(true);
    }
    // The first stop after View is the current View's first field.
    const summaryId = async (key) => dialog(page).locator(`#${dropdownId(key)} summary`).getAttribute('id');
    expect(forward[0].id).toBe(await summaryId(view === 'grid' ? 'gridStyle' : 'listSize'));
    const hiddenKeys = view === 'grid' ? ['listSize'] : ['gridStyle', 'gridSize'];
    for (const key of hiddenKeys) {
      expect([...forward, ...backward].map((step) => step.id)).not.toContain(await summaryId(key));
    }
  }

  // Escape closes the dialog; nothing was posted, saved or stored.
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  expect(control.posts).toEqual([]);
  expect(defaultsRows()).toEqual(rowsBefore);
  expect(await storage(page)).toEqual(sizesBefore);
  expect(control.errors).toEqual([]);
});

test('Q/J/O: an open size dropdown is closed and focus leaves it when Back hides its field; Forward and reload agree', async ({ page }) => {
  const f = await createProject('R3 Open Dropdown');
  const control = watch(page);
  await page.goto(f.url('view=list'));
  await viewLink(page, 'grid').click();
  await settled(page);
  expect(query(page).get('view') ?? 'grid').toBe('grid');
  await openFilters(page);
  await pick(page, 'gridSize', 'compact');

  // The Grid size dropdown is open and focused when Back restores List.
  const gridSize = dialog(page).locator(`#${dropdownId('gridSize')}`);
  await gridSize.locator('summary').click();
  await expect(gridSize).toHaveJSProperty('open', true);
  await page.goBack();
  await expect.poll(() => query(page).get('view')).toBe('list');
  await settled(page);
  await expectFields(page, 'list', { gridSize: 'compact', listSize: 'large' });
  await expect(gridSize).toHaveJSProperty('open', false);
  expect(await page.evaluate(() => document.activeElement?.id))
    .toBe(await dialog(page).locator('#asset-view-filter-dropdown summary').getAttribute('id'));
  // Escape closes the dialog (no dropdown is left open to absorb it).
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();

  // Forward shows Grid again; the field returns closed with its value.
  await page.goForward();
  await expect.poll(() => query(page).get('view') ?? 'grid').toBe('grid');
  await settled(page);
  await openFilters(page);
  await expectFields(page, 'grid', { gridSize: 'compact' });
  await expect(gridSize).toHaveJSProperty('open', false);

  // A reload renders the fields of its View from the server.
  await page.reload();
  await openFilters(page);
  await expectFields(page, 'grid', { gridStyle: 'uncropped', gridSize: 'default', listSize: 'large' });
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('E/F/G: Global Save from List stores the hidden Grid values; Save from Grid stores the hidden List size', async ({ page }) => {
  const f = await createProject('R3 Global Save');
  const control = watch(page);
  await page.goto(f.url('view=grid'));
  const sizesBefore = await storage(page);
  await openFilters(page);
  await pick(page, 'gridStyle', 'cropped');
  await pick(page, 'gridSize', 'large');
  await settled(page);
  await chooseView(page, 'list');
  await settled(page);
  await pick(page, 'listSize', 'compact');
  expect(control.posts).toEqual([]);
  // Choosing and switching Views wrote no browser size.
  expect(await storage(page)).toEqual(sizesBefore);

  const fromList = await saveDefaults(page, control);
  expect(fromList.get('intent')).toBe('save');
  expect(fromList.get('scope')).toBe('global');
  expect(Object.fromEntries(KEYS.map((key) => [key, fromList.get(key)])))
    .toEqual({ gridStyle: 'cropped', gridSize: 'large', listSize: 'compact' });
  expect(fromList.get('view')).toBe('list');
  expect([globalRow('view'), globalRow('gridStyle'), globalRow('gridSize'), globalRow('listSize')])
    .toEqual(['list', 'cropped', 'large', 'compact']);
  // The acknowledged Save's established size sync: both saved sizes, the
  // hidden Grid size included.
  const afterListSave = { 'creatorcrate-asset-grid-size': 'large', 'creatorcrate-asset-list-size': 'compact' };
  expect(await storage(page)).toEqual(afterListSave);
  await expectFields(page, 'list', { gridStyle: 'cropped', gridSize: 'large', listSize: 'compact' });

  await chooseView(page, 'grid');
  await settled(page);
  await expectFields(page, 'grid', { gridStyle: 'cropped', gridSize: 'large', listSize: 'compact' });

  // The other direction: List size chosen in List, saved from Grid.
  await chooseView(page, 'list');
  await settled(page);
  await pick(page, 'listSize', 'large');
  await chooseView(page, 'grid');
  await settled(page);
  await pick(page, 'gridStyle', 'uncropped');
  await pick(page, 'gridSize', 'compact');
  await settled(page);
  expect(await storage(page)).toEqual(afterListSave);
  const fromGrid = await saveDefaults(page, control);
  expect(Object.fromEntries(KEYS.map((key) => [key, fromGrid.get(key)])))
    .toEqual({ gridStyle: 'uncropped', gridSize: 'compact', listSize: 'large' });
  expect(fromGrid.get('view')).toBe('grid');
  expect([globalRow('view'), globalRow('gridStyle'), globalRow('gridSize'), globalRow('listSize')])
    .toEqual(['grid', 'uncropped', 'compact', 'large']);
  expect(control.posts).toHaveLength(2);
  expect(defaultsRows().project).toEqual([]);

  expect(await storage(page)).toEqual({ 'creatorcrate-asset-grid-size': 'compact', 'creatorcrate-asset-list-size': 'large' });

  await page.goto(f.url());
  await openFilters(page);
  await expectFields(page, 'grid', { gridStyle: 'uncropped', gridSize: 'compact', listSize: 'large' });
  expect(control.errors).toEqual([]);
});

test('H/G: Project-only Save and inheritance; scope switches while List update the hidden Grid fields', async ({ page }) => {
  const f = await createProject('R3 Scope');
  // An activation re-reads the activated scope's saved View; both are List.
  saveGlobalDefaults({ view: 'list', gridStyle: 'cropped', gridSize: 'large', listSize: 'compact' });
  const control = watch(page);
  await page.goto(f.url('view=list'));
  await openFilters(page);
  expect(await loadedScope(page)).toBe('global');
  await expectFields(page, 'list', { gridStyle: 'cropped', gridSize: 'large', listSize: 'compact' });

  // Project only inherits Global until it saves its own values.
  await activateScope(page, 'Project only');
  expect(control.bodies.at(-1).get('intent')).toBe('activate-scope');
  await expectFields(page, 'list', { gridStyle: 'cropped', gridSize: 'large', listSize: 'compact' });
  await chooseView(page, 'grid');
  await settled(page);
  await pick(page, 'gridStyle', 'uncropped');
  await settled(page);
  await chooseView(page, 'list');
  await settled(page);
  await pick(page, 'listSize', 'large');
  const saved = await saveDefaults(page, control);
  expect(saved.get('scope')).toBe('project');
  expect(Object.fromEntries(KEYS.map((key) => [key, saved.get(key)])))
    .toEqual({ gridStyle: 'uncropped', gridSize: 'large', listSize: 'large' });
  expect(projectOptions(f.id)).toMatchObject({ view: 'list', gridStyle: 'uncropped', gridSize: 'large', listSize: 'large' });
  expect([globalRow('gridStyle'), globalRow('gridSize'), globalRow('listSize')]).toEqual(['cropped', 'large', 'compact']);
  expect(await storage(page)).toEqual({ 'creatorcrate-asset-grid-size': 'large', 'creatorcrate-asset-list-size': 'large' });

  // While List shows: Global → its List size; its Grid values wait hidden.
  await activateScope(page, 'Global');
  await expectFields(page, 'list', { gridStyle: 'cropped', gridSize: 'large', listSize: 'compact' });
  const afterGlobal = await storage(page);
  await chooseView(page, 'grid');
  await settled(page);
  await expectFields(page, 'grid', { gridStyle: 'cropped', gridSize: 'large', listSize: 'compact' });
  // A View switch alone writes no browser size.
  expect(await storage(page)).toEqual(afterGlobal);
  // The dormant Project-only override returns with its scope (and its List).
  await activateScope(page, 'Project only');
  await expectFields(page, 'list', { gridStyle: 'uncropped', gridSize: 'large', listSize: 'large' });
  await chooseView(page, 'grid');
  await settled(page);
  await expectFields(page, 'grid', { gridStyle: 'uncropped', gridSize: 'large', listSize: 'large' });
  expect(projectOptions(f.id)).toMatchObject({ gridStyle: 'uncropped', gridSize: 'large', listSize: 'large' });
  expect(control.errors).toEqual([]);
});

test('J: Reset defaults asks first, Cancel deletes nothing, and confirming keeps the displayed hidden values', async ({ page }) => {
  const f = await createProject('R3 Reset Defaults');
  saveProjectDefaults(f.id, { view: 'list', gridStyle: 'cropped', gridSize: 'compact', listSize: 'compact' });
  const control = watch(page);
  await page.goto(f.url('view=list'));
  const rowsBefore = defaultsRows();
  const sizesBefore = await storage(page);
  await openFilters(page);
  await expectFields(page, 'list', { gridStyle: 'cropped', gridSize: 'compact', listSize: 'compact' });

  const reset = dialog(page).locator('[data-project-assets-defaults-reset]');
  const confirmation = page.locator('dialog[open]').filter({ hasText: 'Reset Project-only defaults' });
  await reset.click();
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  expect(control.posts).toEqual([]);
  expect(defaultsRows()).toEqual(rowsBefore);

  await reset.click();
  const answered = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith('/assets/defaults/reset'));
  await confirmation.getByRole('button', { name: 'Reset defaults', exact: true }).click();
  expect((await answered).status()).toBe(200);
  await expect(defaultsForm(page)).toHaveAttribute('data-settings-fetch-save-state', 'saved');
  await settled(page);
  expect(control.posts).toEqual([`POST /projects/${f.id}/assets/defaults/reset`]);
  expect(control.bodies.at(-1).get('scope')).toBe('project');
  expect(projectOptions(f.id)).toEqual({});
  // Saved values are gone; what the dialog shows (hidden included) stays.
  await expectFields(page, 'list', { gridStyle: 'cropped', gridSize: 'compact', listSize: 'compact' });
  await chooseView(page, 'grid');
  await settled(page);
  await expectFields(page, 'grid', { gridStyle: 'cropped', gridSize: 'compact', listSize: 'compact' });
  expect(await storage(page)).toEqual(sizesBefore);
  expect(control.errors).toEqual([]);
});

test('I: Reset filters restores every setting, hidden ones included, under both authorities, GET only', async ({ page }) => {
  const f = await createProject('R3 Reset Filters');
  const control = watch(page);
  const temporary = async (view) => {
    await page.goto(f.url(`category=${f.categoryId}&extension=png&search=draft&sort=filename&order=asc&pageSize=25&view=grid`));
    await openFilters(page);
    await pick(page, 'gridStyle', 'uncropped');
    await pick(page, 'gridSize', 'default');
    await settled(page);
    await chooseView(page, 'list');
    await settled(page);
    await pick(page, 'listSize', 'large');
    if (view === 'grid') {
      await chooseView(page, 'grid');
      await settled(page);
    }
  };
  const resetFilters = async () => {
    await dialog(page).getByRole('button', { name: 'Reset filters', exact: true }).click();
    await expect.poll(() => query(page).has('resetFilters') || query(page).has('search')).toBe(false);
    await settled(page);
  };

  // Global authority restores Grid; the hidden List size is its saved one.
  saveGlobalDefaults({ view: 'grid', extension: 'jpg', sort: 'size', order: 'desc', pageSize: '10', gridStyle: 'cropped', gridSize: 'large', listSize: 'compact' });
  let rowsBefore = defaultsRows();
  await temporary('list');
  await resetFilters();
  await expectFields(page, 'grid', { gridStyle: 'cropped', gridSize: 'large', listSize: 'compact' });
  expect(query(page).getAll('extension')).toEqual(['jpg']);
  expect(query(page).get('sort')).toBe('size');
  expect(query(page).get('order')).toBe('desc');
  expect(query(page).get('pageSize')).toBe('10');
  expect(query(page).has('category')).toBe(false);
  expect(query(page).get('view') ?? 'grid').toBe('grid');
  await expect(region(page).locator('ul.asset-grid')).toHaveAttribute('data-grid-style', 'cropped');
  expect(defaultsRows()).toEqual(rowsBefore);

  // Project-only authority restores List; the hidden Grid values are its own.
  saveProjectDefaults(f.id, { view: 'list', gridStyle: 'uncropped', gridSize: 'compact', listSize: 'large' });
  rowsBefore = defaultsRows();
  await temporary('grid');
  await pick(page, 'gridStyle', 'cropped');
  await settled(page);
  await resetFilters();
  await expectFields(page, 'list', { gridStyle: 'uncropped', gridSize: 'compact', listSize: 'large' });
  expect(query(page).get('view')).toBe('list');
  await expect(region(page).locator('ul.asset-list')).toBeVisible();
  expect(defaultsRows()).toEqual(rowsBefore);
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('K/L/N: toolbar View follows rapid clicks; the older held response released last restores nothing', async ({ page }) => {
  const f = await createProject('R3 Toolbar');
  const control = watch(page);
  const gate = await gateAssetGets(page);
  await page.goto(f.url('view=grid'));
  await openFilters(page);
  await pick(page, 'gridStyle', 'cropped');
  await settled(page);
  await closeFilters(page);

  const heldList = gate.next(isView('list'));
  await viewLink(page, 'list').click();
  await heldList.arrival;
  await openFilters(page);
  await expectFields(page, 'list', { gridStyle: 'cropped', listSize: 'large' });
  // List → Grid in the dialog before the List GET answers.
  const heldGrid = gate.next(isView('grid'));
  await chooseView(page, 'grid');
  await heldGrid.arrival;
  await expectFields(page, 'grid', { gridStyle: 'cropped', listSize: 'large' });
  heldGrid.release();
  await settled(page);
  heldList.release();
  await settled(page);
  expect(query(page).get('view') ?? 'grid').toBe('grid');
  await expectFields(page, 'grid', { gridStyle: 'cropped', gridSize: 'default', listSize: 'large' });
  await expect(region(page).locator('ul.asset-grid')).toBeVisible();

  // L: a canonical toolbar install replaces the dialog's View control.
  await closeFilters(page);
  const before = await page.locator('#asset-view-filter').evaluate((node) => { node.dataset.r3Before = '1'; return true; });
  expect(before).toBe(true);
  await viewLink(page, 'list').click();
  await settled(page);
  await expect(page.locator('#asset-view-filter[data-r3-before]')).toHaveCount(0);
  await openFilters(page);
  await expectFields(page, 'list', { gridStyle: 'cropped', listSize: 'large' });
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('M: a failed View GET keeps the chosen View\'s fields; the GET-only Retry installs it', async ({ page }) => {
  const f = await createProject('R3 Retry');
  const control = watch(page);
  const gate = await gateAssetGets(page);
  await page.goto(f.url('view=grid'));
  await openFilters(page);
  gate.next(isView('list'), { fail: true });
  await chooseView(page, 'list');
  await expect(failureNotice(page)).toBeVisible();
  await expectFields(page, 'list', { gridStyle: 'uncropped', gridSize: 'default', listSize: 'large' });
  await retry(page).first().click();
  await settled(page);
  await expect(failureNotice(page)).toHaveCount(0);
  expect(query(page).get('view')).toBe('list');
  await expectFields(page, 'list', { gridStyle: 'uncropped', gridSize: 'default', listSize: 'large' });
  expect(control.gets.filter(isView('list')).length).toBeGreaterThanOrEqual(2);
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('S/R: a pure View change keeps the selection; a real mutation refresh during Reset → List ends on List\'s fields', async ({ page }) => {
  const f = await createProject('R3 Selection Refresh');
  saveGlobalDefaults({ view: 'grid', gridStyle: 'cropped', gridSize: 'large', listSize: 'compact' });
  const control = watch(page);
  const gate = await gateAssetGets(page);
  const a = f.ids['01-draft.png'];
  const c = f.ids['03-draft.png'];
  await page.goto(f.url(`category=${f.categoryId}&view=grid`));
  for (const id of [a, c]) {
    await region(page).locator(`label[for$="-select-${id}"]`).click();
    await expect(box(page, id)).toBeChecked();
  }

  // S: a pure Grid/List change in the dialog keeps both identities.
  await openFilters(page);
  await chooseView(page, 'list');
  await settled(page);
  await expectFields(page, 'list', { listSize: 'compact' });
  expect(await checkedIds(page)).toEqual([a, c].sort((x, y) => x - y));
  await chooseView(page, 'grid');
  await settled(page);
  expect(await checkedIds(page)).toEqual([a, c].sort((x, y) => x - y));

  // R: Reset filters held, List chosen on the toolbar, then a real rename
  // refresh; the final View (List) decides the fields.
  await pick(page, 'gridStyle', 'uncropped');
  await settled(page);
  const heldReset = gate.next(isReset);
  await dialog(page).getByRole('button', { name: 'Reset filters', exact: true }).click();
  await heldReset.arrival;
  await closeFilters(page);
  await viewLink(page, 'list').click();
  const status = await page.evaluate(async ({ projectId, id }) => {
    const token = document.querySelector('input[name="_csrf"]')?.value;
    const body = new URLSearchParams({ _csrf: token, origin: 'assets', filename: '01-renamed' });
    const response = await fetch(`/projects/${projectId}/assets/${id}/rename`, {
      method: 'POST', body, headers: { Accept: 'application/json' }, credentials: 'same-origin',
    });
    return response.status;
  }, { projectId: f.id, id: a });
  expect(status).toBe(200);
  await page.evaluate(() => document.dispatchEvent(new Event('project-asset-categories-changed')));
  heldReset.release();
  await expect.poll(() => query(page).get('view')).toBe('list');
  await expect.poll(() => query(page).has('resetFilters')).toBe(false);
  await settled(page);
  await expect(region(page).locator('ul.asset-list')).toBeVisible();
  await openFilters(page);
  await expectFields(page, 'list', { gridStyle: 'cropped', gridSize: 'large', listSize: 'compact' });
  expect(control.posts).toEqual([`POST /projects/${f.id}/assets/${a}/rename`]);
  expect(control.errors).toEqual([]);
});
