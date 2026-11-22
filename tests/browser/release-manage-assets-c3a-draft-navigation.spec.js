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

// Package C3a: Release Manage Assets draft membership in real Chromium while
// the visible page changes. Saved members sit on the first, middle and last
// page (one of them missing), unsaved additions and removals are made on
// several pages, and every page, filter, Clear, Grid/List, size and history
// change must keep the exact client draft (by asset ID) without any write.
// Expected visible IDs come from SQL over the fixture plus the documented
// Manage Assets predicate, never from the client. One test ends in a real
// Save verified against release_assets. All data lives in a temporary root.
const IMAGES = Array.from({ length: 24 }, (_, index) => `${String(index + 1).padStart(2, '0')}-image.png`);
const NOTES = ['25-note.md', '26-note.md', '27-note.md', '28-note.md'];
const TOTAL = IMAGES.length + NOTES.length;
// Saved membership in saved order: Primary and Preview on page 1, two on the
// middle page (17 is missing), two on the last page (pageSize=10).
const SAVED = [
  ['01-image.png', 'primary'],
  ['04-image.png', 'preview'],
  ['13-image.png', 'attachment'],
  ['17-image.png', 'attachment'],
  ['22-image.png', 'attachment'],
  ['27-note.md', 'attachment'],
];
const MISSING = '17-image.png';
const SAVED_NAMES = SAVED.map(([name]) => name);

let server;
let db;
let app;
let root;
let projectsRoot;
let baseURL;
let releaseService;
const pendingGates = [];

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-release-manage-c3a-'));
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
  releaseService = createReleaseService({ db });
});

// A failed assertion must never leave a held GET behind for the next test.
test.afterEach(async ({ page }) => {
  pendingGates.splice(0).forEach((release) => release());
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test.afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (db) closeDatabase(db);
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

async function writeImage(filePath, index) {
  await sharp({ create: { width: 40, height: 24, channels: 3,
    background: { r: (index * 10) % 256, g: 90, b: 160 } } }).png().toFile(filePath);
}

const idsOf = (projectId) => Object.fromEntries(db.prepare('SELECT filename, id FROM assets WHERE project_id = ?')
  .all(projectId).map((row) => [row.filename, String(row.id)]));

// Images in the WIP category, notes uncategorized. A foreign project carries
// look-alike filenames that must never appear or be saved.
async function createFixture(title) {
  const projects = app.locals.projectService;
  const categories = app.locals.projectAssetCategoryService;
  const project = projects.create({ title, status: 'tbd' });
  if (!categories.list(project.id).some((candidate) => candidate.directory_slug === 'wip')) {
    categories.add(project.id, { displayName: 'WIP', directorySlug: 'wip' });
  }
  const projectDir = path.join(projectsRoot, project.project_dir);
  fs.mkdirSync(path.join(projectDir, 'wip'), { recursive: true });
  for (const [index, filename] of IMAGES.entries()) await writeImage(path.join(projectDir, 'wip', filename), index);
  NOTES.forEach((filename) => fs.writeFileSync(path.join(projectDir, filename), `# ${filename}`));
  app.locals.assetScanner.scanProjectAssets(project.id);

  const foreign = projects.create({ title: `${title} Foreign`, status: 'tbd' });
  const foreignDir = path.join(projectsRoot, foreign.project_dir);
  fs.mkdirSync(foreignDir, { recursive: true });
  await writeImage(path.join(foreignDir, '02-image.png'), 2);
  fs.writeFileSync(path.join(foreignDir, '26-note.md'), '# foreign');
  app.locals.assetScanner.scanProjectAssets(foreign.id);

  const ids = idsOf(project.id);
  const release = releaseService.createReleaseWithSelectedAssets(project.id, { title: `${title} Release` },
    SAVED_NAMES.map((name) => Number(ids[name])));
  for (const [name, role] of SAVED) {
    db.prepare('UPDATE release_assets SET role = ? WHERE release_id = ? AND asset_id = ?')
      .run(role, release.id, Number(ids[name]));
  }
  db.prepare("UPDATE assets SET is_present = 0, missing_since = '2025-02-01T00:00:00Z' WHERE id = ?")
    .run(Number(ids[MISSING]));
  const categoryId = String(categories.list(project.id).find((c) => c.directory_slug === 'wip').id);
  const fixture = {
    projectId: project.id,
    releaseId: release.id,
    ids,
    categoryId,
    foreignIds: new Set(Object.values(idsOf(foreign.id))),
  };
  fixture.id = (name) => {
    if (!ids[name]) throw new Error(`unknown fixture asset ${name}`);
    return ids[name];
  };
  fixture.idSet = (names) => sorted(names.map(fixture.id));
  return fixture;
}

const sorted = (values) => [...values].sort();
const savedRows = (releaseId) => db
  .prepare('SELECT asset_id, role, sort_order FROM release_assets WHERE release_id = ? ORDER BY sort_order')
  .all(releaseId).map((row) => ({ ...row, asset_id: String(row.asset_id) }));
const params = (page) => Object.fromEntries(new URL(page.url()).searchParams);
const assetsPath = (f) => `/releases/${f.releaseId}/assets`;
const historyLength = (page) => page.evaluate(() => history.length);
const nextFrame = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));

// Independent expectation: the documented Manage Assets predicate over the
// fixture rows (filename order; a saved missing member always matches; every
// other row must be present and match each active filter).
function expectedPage(f, { search = null, extension = null, category = null, selection = 'all', pageSize = '25', page = 1 } = {}) {
  const rows = db.prepare(`
    SELECT a.id, a.filename, a.extension, a.category_id, a.is_present, ra.asset_id AS saved
      FROM assets a
      LEFT JOIN release_assets ra ON ra.release_id = ? AND ra.asset_id = a.id
     WHERE a.project_id = ?
     ORDER BY a.filename COLLATE NOCASE ASC, a.id ASC`).all(f.releaseId, f.projectId);
  const matched = rows.filter((row) => {
    if (selection === 'selected' && row.saved === null) return false;
    if (row.saved !== null && row.is_present !== 1) return true;
    if (row.is_present !== 1) return false;
    if (search && !row.filename.toLowerCase().includes(search.toLowerCase())) return false;
    if (extension && String(row.extension).replace(/^\./, '').toLowerCase() !== extension) return false;
    if (category && String(row.category_id) !== String(category)) return false;
    return true;
  }).map((row) => String(row.id));
  const size = pageSize === 'all' ? Math.max(matched.length, 1) : Number(pageSize);
  return { total: matched.length, pages: Math.max(1, Math.ceil(matched.length / size)),
    ids: matched.slice((page - 1) * size, page * size) };
}

function trackRequests(page, releaseId) {
  const requests = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith(`/releases/${releaseId}`) && !url.pathname.includes('defaults')) return;
    if (request.resourceType() !== 'fetch' && request.resourceType() !== 'document') return;
    requests.push({ method: request.method(), url, body: request.postData() });
  });
  return requests;
}

function controls(page) {
  const region = page.locator('[data-release-assets-live-region]');
  return {
    region,
    rows: region.locator('.asset-grid-item, .asset-list-item'),
    gridRows: region.locator('.asset-grid-item'),
    listRows: region.locator('.asset-list-item'),
    info: region.locator('.pagination-info'),
    meta: region.locator('.release-asset-results-meta'),
    dialog: page.locator('#release-assets-filter-dialog'),
    trigger: page.getByRole('link', { name: 'Filter assets' }),
    notice: page.locator('[data-live-filter-failure]'),
    dialogSize: page.locator('#asset-page-size'),
    paginationSize: page.locator('#pageSize'),
  };
}

const regionAssetIds = (page) => page.locator('[data-release-assets-live-region] input[name="selectedAssetIds"]')
  .evaluateAll((inputs) => inputs.map((input) => input.value));

async function settled(page) {
  await expect(page.locator('[data-release-assets-live-region]')).not.toHaveAttribute('aria-busy', 'true');
}

async function expectSize(page, value) {
  const c = controls(page);
  await expect(c.dialogSize).toHaveValue(value);
  await expect(c.paginationSize).toHaveValue(value);
}

// The rendered page shows exactly the expected IDs, count and page label.
async function expectPage(page, f, query) {
  const c = controls(page);
  const expected = expectedPage(f, query);
  await expect.poll(() => regionAssetIds(page)).toEqual(expected.ids);
  const visible = await regionAssetIds(page);
  expect(visible.filter((id) => f.foreignIds.has(id))).toEqual([]);
  const noun = query.selection === 'selected' ? 'selected' : 'project';
  await expect(c.meta).toContainText(`${expected.total} ${noun} asset${expected.total === 1 ? '' : 's'}`);
  if (expected.pages > 1) await expect(c.info).toHaveText(`Page ${query.page ?? 1} of ${expected.pages}`);
  else await expect(c.info).toHaveCount(0);
  return expected;
}

// The complete draft by ID: visible checkboxes reflect it exactly, the hidden
// carrier holds the rest exactly once, and nothing is duplicated.
async function expectDraft(page, expectedIds) {
  const state = await page.evaluate(() => ({
    carrier: [...document.querySelectorAll('[data-release-assets-hidden-membership] input[name="selectedAssetIds"]')]
      .map((input) => input.value),
    boxes: [...document.querySelectorAll('[data-release-assets-live-region] input[name="selectedAssetIds"]')]
      .map((input) => ({ id: input.value, checked: input.checked })),
  }));
  const expected = new Set(expectedIds);
  expect(new Set(state.carrier).size, 'carrier duplicates').toBe(state.carrier.length);
  expect(new Set(state.boxes.map((box) => box.id)).size, 'visible duplicates').toBe(state.boxes.length);
  const visible = new Set(state.boxes.map((box) => box.id));
  expect(state.carrier.filter((id) => visible.has(id)), 'carrier repeats a visible asset').toEqual([]);
  for (const box of state.boxes) expect(box.checked, `checkbox for asset ${box.id}`).toBe(expected.has(box.id));
  expect(sorted([...state.carrier, ...state.boxes.filter((box) => box.checked).map((box) => box.id)]))
    .toEqual(sorted(expectedIds));
}

const checkboxSelector = (f, name) => `input[name="selectedAssetIds"][value="${f.id(name)}"]`;
const checkbox = (page, f, name) => page.locator(`[data-release-assets-live-region] ${checkboxSelector(f, name)}`);
const rowOf = (rows, page, f, name) => rows.filter({ has: page.locator(checkboxSelector(f, name)) });

async function openFilters(page) {
  const c = controls(page);
  if (!(await c.dialog.evaluate((dialog) => dialog.open))) await c.trigger.click();
  await expect(c.dialog).toBeVisible();
}

async function closeFilters(page) {
  const c = controls(page);
  if (await c.dialog.evaluate((dialog) => dialog.open)) await page.keyboard.press('Escape');
  await expect(c.dialog).toBeHidden();
}

async function chooseDialogOption(page, dropdownId, label) {
  await openFilters(page);
  const dropdown = page.locator(`#${dropdownId}`);
  await dropdown.locator('summary').click();
  await dropdown.locator('.asset-filter-multiselect-panel').getByText(label, { exact: true }).click();
}

async function choosePaginationSize(page, label) {
  const dropdown = page.locator('#page-size-dropdown');
  await dropdown.locator('summary').scrollIntoViewIfNeeded();
  await dropdown.locator('summary').click();
  await dropdown.locator('.asset-filter-multiselect-panel').getByText(label, { exact: true }).click();
}

async function search(page, value) {
  await openFilters(page);
  await page.locator('#asset-search').fill(value);
  await expect.poll(() => params(page).search ?? '').toBe(value);
  await settled(page);
}

// Holds every matching Manage Assets GET until release(); `finished()`
// resolves once each held request has completed or failed in the browser.
async function holdRequests(page, f, match) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  pendingGates.push(release);
  const held = [];
  await page.route((url) => url.pathname === assetsPath(f) && match(url.searchParams), async (route) => {
    const request = route.request();
    held.push(new Promise((resolve) => {
      const done = (candidate) => {
        if (candidate !== request) return;
        page.off('requestfinished', done);
        page.off('requestfailed', done);
        resolve();
      };
      page.on('requestfinished', done);
      page.on('requestfailed', done);
    }));
    await gate;
    await route.continue().catch(() => {});
  });
  return {
    release,
    held,
    finished: async () => {
      await Promise.all(held);
      await nextFrame(page);
      await nextFrame(page);
    },
  };
}

const nonGets = (requests) => requests.filter((request) => request.method !== 'GET');

test('C3a: cross-page additions and removals keep one draft through pages, the missing member, Grid/List, grid style and size', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createFixture('C3a Cross Page');
  const requests = trackRequests(page, f.releaseId);
  const c = controls(page);
  const rowsBefore = savedRows(f.releaseId);
  const base = { selection: 'all', pageSize: '10' };

  await page.goto(`${baseURL}${assetsPath(f)}?selection=all&pageSize=10`);
  await expectPage(page, f, { ...base, page: 1 });
  await expectDraft(page, f.idSet(SAVED_NAMES));

  // Page 1: add 06. Page 2: add 15, remove saved 13. Page 3: remove saved 22, add 24.
  await checkbox(page, f, '06-image.png').check({ force: true });
  await c.region.locator('.pagination-next').click();
  await settled(page);
  await expectPage(page, f, { ...base, page: 2 });
  await expectDraft(page, f.idSet([...SAVED_NAMES, '06-image.png']));
  // The saved missing member is shown missing, still selected and selectable.
  const missingRow = rowOf(c.gridRows, page, f, MISSING);
  await expect(missingRow).toHaveClass(/is-missing/);
  await expect(checkbox(page, f, MISSING)).toBeChecked();
  await checkbox(page, f, '15-image.png').check({ force: true });
  await checkbox(page, f, '13-image.png').uncheck({ force: true });
  await c.region.locator('.pagination-next').click();
  await settled(page);
  await expectPage(page, f, { ...base, page: 3 });
  await checkbox(page, f, '22-image.png').uncheck({ force: true });
  await checkbox(page, f, '24-image.png').check({ force: true });
  const draft = f.idSet(['01-image.png', '04-image.png', '06-image.png', '15-image.png', MISSING,
    '24-image.png', '27-note.md']);
  await expectDraft(page, draft);

  // Return to page 1, then page 2: additions kept, removals still pending.
  await c.region.locator('.pagination-prev').click();
  await settled(page);
  await c.region.locator('.pagination-prev').click();
  await settled(page);
  await expect.poll(() => params(page).page ?? '1').toBe('1');
  await expectPage(page, f, { ...base, page: 1 });
  await expectDraft(page, draft);
  await expect(checkbox(page, f, '06-image.png')).toBeChecked();
  await c.region.locator('.pagination-next').click();
  await settled(page);
  await expectPage(page, f, { ...base, page: 2 });
  await expect(checkbox(page, f, '13-image.png')).not.toBeChecked();
  await expect(checkbox(page, f, '15-image.png')).toBeChecked();
  await expectDraft(page, draft);

  // Grid -> List from page 2: the established View links return to page 1
  // (filters and size kept); the draft is unchanged. Page 2 in List shows
  // the missing indicator.
  await page.getByRole('link', { name: 'List view' }).click();
  await settled(page);
  await expect.poll(() => params(page)).toEqual({ ...base, view: 'list' });
  await expect(c.listRows).toHaveCount(10);
  await expect(c.gridRows).toHaveCount(0);
  await expectPage(page, f, { ...base, page: 1 });
  await expectDraft(page, draft);
  await c.region.locator('.pagination-next').click();
  await settled(page);
  await expect.poll(() => params(page)).toEqual({ ...base, page: '2', view: 'list' });
  await expectPage(page, f, { ...base, page: 2 });
  await expect(rowOf(c.listRows, page, f, MISSING)).toHaveClass(/is-missing/);
  await expectDraft(page, draft);

  // Pure presentation changes (List size, Grid size, Grid style) send nothing,
  // add no history entry and leave the draft alone.
  const visualRequests = requests.length;
  const visualHistory = await historyLength(page);
  const visualHref = page.url();
  await page.getByRole('button', { name: 'Select Compact list size' }).click();
  await expect(page.getByRole('button', { name: 'Select Compact list size' })).toHaveAttribute('aria-pressed', 'true');
  await expectDraft(page, draft);
  expect(requests.length).toBe(visualRequests);
  expect(await historyLength(page)).toBe(visualHistory);
  expect(page.url()).toBe(visualHref);
  await page.getByRole('link', { name: 'Grid view' }).click();
  await settled(page);
  await expect.poll(() => params(page)).toEqual(base);
  await expect(c.gridRows).toHaveCount(10);
  await expectPage(page, f, { ...base, page: 1 });
  await expectDraft(page, draft);
  const afterGrid = requests.length;
  const gridHistory = await historyLength(page);
  expect(gridHistory).toBe(visualHistory + 1);
  await page.getByRole('button', { name: 'Select Large grid size' }).click();
  await expect(page.getByRole('button', { name: 'Select Large grid size' })).toHaveAttribute('aria-pressed', 'true');
  const style = page.locator('#asset-grid-style-dropdown');
  await style.locator('summary').click();
  await style.locator('.asset-filter-multiselect-panel').getByText('Cropped', { exact: true }).click();
  await expect(style.locator('[data-cc-dropdown-summary-current]')).toHaveText('Cropped');
  await expect(c.region.locator('.asset-grid')).toHaveAttribute('data-grid-style', 'cropped');
  await expectDraft(page, draft);
  expect(requests.length).toBe(afterGrid);
  expect(await historyLength(page)).toBe(gridHistory);

  // Navigate again: the same draft is stable.
  await c.region.locator('.pagination-next').click();
  await settled(page);
  await c.region.locator('.pagination-next').click();
  await settled(page);
  await expectPage(page, f, { ...base, page: 3 });
  await expect(checkbox(page, f, '22-image.png')).not.toBeChecked();
  await expect(checkbox(page, f, '24-image.png')).toBeChecked();
  await expectDraft(page, draft);

  expect(nonGets(requests)).toEqual([]);
  expect(savedRows(f.releaseId)).toEqual(rowsBefore);
  expect(pageErrors).toEqual([]);
});

test('C3a: Search, Extension, Category and Selected/All keep an off-filter draft; Clear resets filters and page only', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createFixture('C3a Filters');
  const requests = trackRequests(page, f.releaseId);
  const c = controls(page);
  const rowsBefore = savedRows(f.releaseId);
  const base = { selection: 'all', pageSize: '10' };
  await page.goto(`${baseURL}${assetsPath(f)}?selection=all&view=list&pageSize=10`);
  await expectPage(page, f, { ...base, page: 1 });

  // Draft before any filter: remove saved Preview 04, add 08.
  await checkbox(page, f, '04-image.png').uncheck({ force: true });
  await checkbox(page, f, '08-image.png').check({ force: true });
  let draft = f.idSet(['01-image.png', '08-image.png', '13-image.png', MISSING, '22-image.png', '27-note.md']);
  await expectDraft(page, draft);

  // Search "2": images and notes with a 2, plus the saved missing member.
  await search(page, '2');
  await expectPage(page, f, { ...base, search: '2', page: 1 });
  await expectDraft(page, draft);

  // + Extension .md: only the notes (and the always-shown saved missing member).
  await chooseDialogOption(page, 'release-asset-extension-filter', '.md');
  await settled(page);
  await expect.poll(() => params(page).extension).toBe('md');
  const mdPage = await expectPage(page, f, { ...base, search: '2', extension: 'md', page: 1 });
  expect(mdPage.ids).toContain(f.id(MISSING));
  expect(mdPage.ids).toContain(f.id('26-note.md'));
  await closeFilters(page);
  await checkbox(page, f, '26-note.md').check({ force: true });
  await checkbox(page, f, '27-note.md').uncheck({ force: true });
  draft = f.idSet(['01-image.png', '08-image.png', '13-image.png', MISSING, '22-image.png', '26-note.md']);
  await expectDraft(page, draft);

  // All extensions + Category WIP with Search "2".
  await chooseDialogOption(page, 'release-asset-extension-filter', 'All extensions');
  await settled(page);
  await chooseDialogOption(page, 'release-asset-category-filter', `WIP (${IMAGES.length})`);
  await settled(page);
  await expect.poll(() => params(page).category).toBe(f.categoryId);
  expect(params(page).extension).toBeUndefined();
  await expectPage(page, f, { ...base, search: '2', category: f.categoryId, page: 1 });
  await closeFilters(page);
  await expect(checkbox(page, f, '22-image.png')).toBeChecked();
  await checkbox(page, f, '21-image.png').check({ force: true });
  draft = sorted([...draft, f.id('21-image.png')]);
  await expectDraft(page, draft);

  // Selected assets: saved members only; unsaved 21 is hidden but kept.
  await chooseDialogOption(page, 'release-asset-selection-filter', 'Selected assets');
  await settled(page);
  await expect.poll(() => params(page).selection ?? 'selected').toBe('selected');
  await expectPage(page, f, { search: '2', category: f.categoryId, selection: 'selected', pageSize: '10', page: 1 });
  await expect(page.locator('[data-release-assets-selection-notice]')).toBeVisible();
  await expect(checkbox(page, f, '21-image.png')).toHaveCount(0);
  await expectDraft(page, draft);

  // Back to All assets, Search cleared: WIP spans 3 pages; go to page 2.
  await chooseDialogOption(page, 'release-asset-selection-filter', 'All assets');
  await settled(page);
  await search(page, '');
  await expectPage(page, f, { ...base, category: f.categoryId, page: 1 });
  await closeFilters(page);
  await c.region.locator('.pagination-next').click();
  await settled(page);
  await expect.poll(() => params(page).page).toBe('2');
  await expectPage(page, f, { ...base, category: f.categoryId, page: 2 });
  await expectDraft(page, draft);

  // Clear: Search/Extension/Category reset, Selection back to the saved
  // default (Selected assets), page 1; List and size 10 kept; draft kept.
  await openFilters(page);
  await page.locator('[data-release-assets-reset]').click();
  await settled(page);
  await expect.poll(() => params(page)).toEqual({ view: 'list', pageSize: '10' });
  await expect(page.locator('#asset-search')).toHaveValue('');
  await expect(page.locator('#release-asset-selection-option-selected')).toBeChecked();
  await expect(page.locator('#release-asset-extension-option-all')).toBeChecked();
  await expect(page.locator('#release-asset-category-option-all')).toBeChecked();
  await closeFilters(page);
  await expectSize(page, '10');
  await expect(c.listRows).toHaveCount(SAVED.length);
  await expectPage(page, f, { selection: 'selected', pageSize: '10', page: 1 });
  // Saved rows are shown; the draft decides their checkboxes.
  await expect(checkbox(page, f, '04-image.png')).not.toBeChecked();
  await expect(checkbox(page, f, '27-note.md')).not.toBeChecked();
  await expect(checkbox(page, f, '08-image.png')).toHaveCount(0);
  await expectDraft(page, draft);

  expect(nonGets(requests)).toEqual([]);
  expect(savedRows(f.releaseId)).toEqual(rowsBefore);
  expect(pageErrors).toEqual([]);
});

test('C3a: page sizes 10/25/50/100/View All and Back/Forward through page, filter, view and size keep the newest draft', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createFixture('C3a Sizes History');
  const requests = trackRequests(page, f.releaseId);
  const c = controls(page);
  const rowsBefore = savedRows(f.releaseId);
  await page.goto(`${baseURL}${assetsPath(f)}?selection=all&pageSize=10`);

  // Draft: add 03 (page 1), remove saved 13 and add 16 (page 2).
  await checkbox(page, f, '03-image.png').check({ force: true });
  await c.region.locator('.pagination-next').click();
  await settled(page);
  await checkbox(page, f, '13-image.png').uncheck({ force: true });
  await checkbox(page, f, '16-image.png').check({ force: true });
  let draft = f.idSet(['01-image.png', '03-image.png', '04-image.png', '16-image.png', MISSING,
    '22-image.png', '27-note.md']);
  await expectDraft(page, draft);

  const sizes = [
    ['dialog', '25', '25'], ['pagination', '50', '50'], ['dialog', '100', '100'],
    ['pagination', 'View All', 'all'], ['dialog', '10', '10'],
  ];
  for (const [entry, label, value] of sizes) {
    if (entry === 'dialog') {
      await chooseDialogOption(page, 'release-asset-page-size-dropdown', label);
      await settled(page);
      await closeFilters(page);
    } else {
      await choosePaginationSize(page, label);
      await settled(page);
    }
    await expect.poll(() => params(page).pageSize ?? '25', label).toBe(value);
    expect(params(page).page, label).toBeUndefined();
    await expectSize(page, value);
    await expect(c.rows, label).toHaveCount(value === 'all' ? TOTAL : Math.min(Number(value), TOTAL));
    await expectPage(page, f, { selection: 'all', pageSize: value, page: 1 });
    await expectDraft(page, draft);
  }
  // 25 on its last page, then back to 10.
  await choosePaginationSize(page, '25');
  await settled(page);
  await c.region.locator('.pagination-next').click();
  await settled(page);
  await expectPage(page, f, { selection: 'all', pageSize: '25', page: 2 });
  await expect(c.rows).toHaveCount(TOTAL - 25);
  await expectDraft(page, draft);
  await choosePaginationSize(page, '10');
  await settled(page);
  await expectPage(page, f, { selection: 'all', pageSize: '10', page: 1 });

  // History: page, filter, view and size entries, one per action.
  const h0 = await historyLength(page);
  const entries = [{ selection: 'all', pageSize: '10' }];
  await c.region.locator('.pagination-next').click();
  await settled(page);
  entries.push({ selection: 'all', pageSize: '10', page: '2' });
  await expect.poll(() => params(page)).toEqual(entries.at(-1));
  await search(page, 'image');
  await closeFilters(page);
  entries.push(params(page));
  expect(entries.at(-1)).toMatchObject({ search: 'image', selection: 'all', pageSize: '10' });
  expect(entries.at(-1).page).toBeUndefined();
  await page.getByRole('link', { name: 'List view' }).click();
  await settled(page);
  await expect.poll(() => params(page).view).toBe('list');
  entries.push(params(page));
  // A toggle made on the List entry belongs to the draft, not to the entry.
  await checkbox(page, f, '05-image.png').check({ force: true });
  draft = sorted([...draft, f.id('05-image.png')]);
  await choosePaginationSize(page, '25');
  await settled(page);
  await expect.poll(() => params(page).pageSize ?? '25').toBe('25');
  entries.push(params(page));
  await page.getByRole('button', { name: 'Select Compact list size' }).click();
  expect(await historyLength(page)).toBe(h0 + 4);
  await expectDraft(page, draft);

  const expectEntry = async (entry) => {
    await settled(page);
    await expect.poll(() => params(page)).toEqual(entry);
    const view = entry.view ?? 'grid';
    await expect(view === 'list' ? c.listRows.first() : c.gridRows.first()).toBeVisible();
    await expect(view === 'list' ? c.gridRows : c.listRows).toHaveCount(0);
    await expectSize(page, entry.pageSize ?? '25');
    await expect(page.locator('#asset-search')).toHaveValue(entry.search ?? '');
    await expectPage(page, f, { ...entry, pageSize: entry.pageSize ?? '25', page: Number(entry.page ?? 1) });
    await expectDraft(page, draft);
  };
  for (let index = entries.length - 2; index >= 0; index -= 1) {
    await page.goBack();
    await expectEntry(entries[index]);
  }
  // Removed members stay removed and the newest addition stays on the oldest entry.
  await expect(checkbox(page, f, '05-image.png')).toBeChecked();
  for (let index = 1; index < entries.length; index += 1) {
    await page.goForward();
    await expectEntry(entries[index]);
  }
  expect(await historyLength(page)).toBe(h0 + 4);

  expect(nonGets(requests)).toEqual([]);
  expect(savedRows(f.releaseId)).toEqual(rowsBefore);
  expect(pageErrors).toEqual([]);
});

test('C3a: stale held GETs, a toggle during a held latest GET and a failed GET with Retry keep the newest draft', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createFixture('C3a Races');
  const requests = trackRequests(page, f.releaseId);
  const c = controls(page);
  const rowsBefore = savedRows(f.releaseId);
  await page.goto(`${baseURL}${assetsPath(f)}?selection=all&pageSize=10`);
  await checkbox(page, f, '06-image.png').check({ force: true });
  await checkbox(page, f, '04-image.png').uncheck({ force: true });
  let draft = f.idSet(['01-image.png', '06-image.png', '13-image.png', MISSING, '22-image.png', '27-note.md']);

  // 1. GET A (page 2) held; 07 checked on the still-displayed page; GET B
  // (size 25) finishes first; A arrives afterwards and installs nothing.
  const heldA = await holdRequests(page, f, (sp) => sp.get('page') === '2' && sp.get('pageSize') === '10');
  await c.region.locator('.pagination-next').click();
  await expect.poll(() => heldA.held.length).toBe(1);
  await expect(c.region).toHaveAttribute('aria-busy', 'true');
  await checkbox(page, f, '07-image.png').check({ force: true });
  draft = sorted([...draft, f.id('07-image.png')]);
  await expectDraft(page, draft);
  await choosePaginationSize(page, '25');
  await settled(page);
  await expect.poll(() => params(page)).toEqual({ selection: 'all', pageSize: '25' });
  const bIds = (await expectPage(page, f, { selection: 'all', pageSize: '25', page: 1 })).ids;
  await expectDraft(page, draft);
  const bHref = page.url();
  heldA.release();
  await heldA.finished();
  expect(page.url()).toBe(bHref);
  expect(await regionAssetIds(page)).toEqual(bIds);
  await expectSize(page, '25');
  await expectDraft(page, draft);

  // 2. The latest GET (Search "0") is held while 09 is added and saved 22 is
  // removed on the displayed page; its server-rendered answer then installs
  // and the draft overrides both checkboxes.
  const heldSearch = await holdRequests(page, f, (sp) => sp.get('search') === '0');
  await openFilters(page);
  await page.locator('#asset-search').fill('0');
  await expect.poll(() => heldSearch.held.length).toBe(1);
  await closeFilters(page);
  await checkbox(page, f, '09-image.png').check({ force: true });
  await checkbox(page, f, '22-image.png').uncheck({ force: true });
  draft = sorted([...draft.filter((id) => id !== f.id('22-image.png')), f.id('09-image.png')]);
  heldSearch.release();
  await heldSearch.finished();
  await settled(page);
  await expect.poll(() => params(page).search).toBe('0');
  const searchPage = await expectPage(page, f, { selection: 'all', pageSize: '25', search: '0', page: 1 });
  expect(searchPage.ids).toContain(f.id('09-image.png'));
  expect(searchPage.ids).not.toContain(f.id('22-image.png'));
  await expect(checkbox(page, f, '09-image.png')).toBeChecked();
  await expectDraft(page, draft);

  // 3. A failed List GET keeps the region and the draft; a toggle made while
  // the failure shows is kept; Retry installs List and clears the notice.
  await page.route((url) => url.pathname === assetsPath(f) && url.searchParams.get('view') === 'list',
    (route) => route.abort('failed'), { times: 1 });
  await page.getByRole('link', { name: 'List view' }).click();
  await expect(c.notice).toBeVisible();
  await expect(c.gridRows).toHaveCount(searchPage.ids.length);
  await expectDraft(page, draft);
  await checkbox(page, f, '10-image.png').check({ force: true });
  draft = sorted([...draft, f.id('10-image.png')]);
  const beforeRetry = requests.length;
  await c.notice.getByRole('button', { name: 'Retry' }).click();
  await settled(page);
  await expect(c.notice).toHaveCount(0);
  // The List link spells the default 25 implicitly, as rendered links do.
  await expect.poll(() => params(page)).toEqual({ selection: 'all', search: '0', view: 'list' });
  await expectSize(page, '25');
  expect(requests.slice(beforeRetry).map((r) => r.method)).toEqual(['GET']);
  await expect(c.listRows).toHaveCount(searchPage.ids.length);
  await expectPage(page, f, { selection: 'all', pageSize: '25', search: '0', page: 1 });
  await expectDraft(page, draft);

  // 4. A failed page-size GET stays local; Retry installs it with the draft.
  await page.route((url) => url.pathname === assetsPath(f) && url.searchParams.get('pageSize') === '10',
    (route) => route.abort('failed'), { times: 1 });
  await choosePaginationSize(page, '10');
  await expect(c.notice).toBeVisible();
  await expectDraft(page, draft);
  await c.notice.getByRole('button', { name: 'Retry' }).click();
  await settled(page);
  await expect(c.notice).toHaveCount(0);
  await expectSize(page, '10');
  await expectPage(page, f, { selection: 'all', pageSize: '10', search: '0', page: 1 });
  await expectDraft(page, draft);

  expect(nonGets(requests)).toEqual([]);
  expect(savedRows(f.releaseId)).toEqual(rowsBefore);
  expect(pageErrors).toEqual([]);
});

test('C3a: Save after off-page removal, off-page additions, filter, size, view and Clear persists the exact membership', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createFixture('C3a Save');
  const requests = trackRequests(page, f.releaseId);
  const c = controls(page);
  const rowsBefore = savedRows(f.releaseId);
  expect(rowsBefore.map((row) => [row.asset_id, row.role])).toEqual(SAVED.map(([name, role]) => [f.id(name), role]));
  await page.goto(`${baseURL}${assetsPath(f)}?selection=all&pageSize=10`);

  // Page 1: add 09. Page 3: remove saved 22, add 25-note.md.
  await checkbox(page, f, '09-image.png').check({ force: true });
  await c.region.locator('.pagination-next').click();
  await settled(page);
  await c.region.locator('.pagination-next').click();
  await settled(page);
  await expectPage(page, f, { selection: 'all', pageSize: '10', page: 3 });
  await checkbox(page, f, '22-image.png').uncheck({ force: true });
  await checkbox(page, f, '25-note.md').check({ force: true });
  const draft = f.idSet(['01-image.png', '04-image.png', '09-image.png', '13-image.png', MISSING,
    '25-note.md', '27-note.md']);
  await expectDraft(page, draft);

  // Filter (25-note.md and 27-note.md off-filter), size 50, List, then Clear
  // (saved-selected only: 09 and 25-note.md off-page, 22 shown unchecked).
  await search(page, 'image');
  await closeFilters(page);
  await expectPage(page, f, { selection: 'all', pageSize: '10', search: 'image', page: 1 });
  await expectDraft(page, draft);
  await choosePaginationSize(page, '50');
  await settled(page);
  await page.getByRole('link', { name: 'List view' }).click();
  await settled(page);
  await expect.poll(() => params(page)).toEqual({ selection: 'all', pageSize: '50', search: 'image', view: 'list' });
  await expectDraft(page, draft);
  await openFilters(page);
  await page.locator('[data-release-assets-reset]').click();
  await settled(page);
  await closeFilters(page);
  await expect.poll(() => params(page)).toEqual({ view: 'list', pageSize: '50' });
  await expectPage(page, f, { selection: 'selected', pageSize: '50', page: 1 });
  await expect(checkbox(page, f, '22-image.png')).not.toBeChecked();
  await expect(checkbox(page, f, '09-image.png')).toHaveCount(0);
  await expect(checkbox(page, f, '25-note.md')).toHaveCount(0);
  await expect(rowOf(c.listRows, page, f, MISSING)).toHaveClass(/is-missing/);
  await expectDraft(page, draft);

  // No autosave: persisted membership is unchanged right before Save.
  expect(nonGets(requests)).toEqual([]);
  expect(savedRows(f.releaseId)).toEqual(rowsBefore);

  const [response] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === assetsPath(f)),
    page.getByRole('button', { name: 'Save asset selection' }).click(),
  ]);
  expect([302, 303]).toContain(response.status());
  await page.waitForURL((url) => url.pathname === `/releases/${f.releaseId}`);

  const posts = nonGets(requests);
  expect(posts.map((r) => r.method)).toEqual(['POST']);
  const posted = new URLSearchParams(posts[0].body).getAll('selectedAssetIds');
  expect(new Set(posted).size).toBe(posted.length);
  expect(sorted(posted)).toEqual(draft);

  // Kept members keep role and relative order (22 removed); the two additions
  // append as attachments in submitted form order, which is not asserted.
  const after = savedRows(f.releaseId);
  expect(sorted(after.map((row) => row.asset_id))).toEqual(draft);
  expect(new Set(after.map((row) => row.asset_id)).size).toBe(after.length);
  expect(after.map((row) => row.sort_order)).toEqual(after.map((_, index) => index));
  expect(after.slice(0, 5).map((row) => [row.asset_id, row.role])).toEqual([
    [f.id('01-image.png'), 'primary'],
    [f.id('04-image.png'), 'preview'],
    [f.id('13-image.png'), 'attachment'],
    [f.id(MISSING), 'attachment'],
    [f.id('27-note.md'), 'attachment'],
  ]);
  expect(sorted(after.slice(5).map((row) => row.asset_id))).toEqual(f.idSet(['09-image.png', '25-note.md']));
  expect(after.slice(5).every((row) => row.role === 'attachment')).toBe(true);
  expect(after.find((row) => row.asset_id === f.id('22-image.png'))).toBeUndefined();
  expect(after.filter((row) => f.foreignIds.has(row.asset_id))).toEqual([]);
  expect(db.prepare('SELECT is_present FROM assets WHERE id = ?').get(Number(f.id(MISSING))).is_present).toBe(0);

  // A fresh server-rendered Manage Assets page shows exactly the saved draft.
  await page.goto(`${baseURL}${assetsPath(f)}?selection=selected&pageSize=50`);
  await expectPage(page, f, { selection: 'selected', pageSize: '50', page: 1 });
  expect(sorted(await regionAssetIds(page))).toEqual(draft);
  await expectDraft(page, draft);
  expect(pageErrors).toEqual([]);
});
