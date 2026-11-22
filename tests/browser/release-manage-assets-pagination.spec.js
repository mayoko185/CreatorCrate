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

// WP16 Release Manage Assets pagination in real Chromium: the filter-only
// dialog's Page size and the Assets per page control beside pagination are
// two entry points to one server-authoritative size. Size, filter, page and
// history changes never save membership, roles or order. All data lives in a
// temporary root that is removed afterward.
const IMAGES = Array.from({ length: 24 }, (_, index) => `${String(index + 1).padStart(2, '0')}-image.png`);
const NOTES = ['25-note.md', '26-note.md', '27-note.md', '28-note.md'];
const SAVED = ['01-image.png', '02-image.png', '03-image.png'];
const TOTAL = IMAGES.length + NOTES.length;

let server;
let db;
let app;
let root;
let projectsRoot;
let baseURL;
let releaseService;

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-release-manage-pagination-'));
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

test.afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (db) closeDatabase(db);
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

// Images in the WIP category, notes uncategorized; three saved selections
// with the first as Primary.
async function createRelease(title, { extraImages = [] } = {}) {
  const project = app.locals.projectService.create({ title, status: 'tbd' });
  const categories = app.locals.projectAssetCategoryService;
  if (!categories.list(project.id).some((candidate) => candidate.directory_slug === 'wip')) {
    categories.add(project.id, { displayName: 'WIP', directorySlug: 'wip' });
  }
  const projectDir = path.join(projectsRoot, project.project_dir);
  const categoryDir = path.join(projectDir, 'wip');
  fs.mkdirSync(categoryDir, { recursive: true });
  for (const [index, filename] of [...IMAGES, ...extraImages].entries()) {
    await sharp({ create: { width: 40, height: 24, channels: 3,
      background: { r: (index * 10) % 256, g: 90, b: 160 } } }).png().toFile(path.join(categoryDir, filename));
  }
  NOTES.forEach((filename) => fs.writeFileSync(path.join(projectDir, filename), `# ${filename}`));
  app.locals.assetScanner.scanProjectAssets(project.id);
  const ids = Object.fromEntries(db.prepare('SELECT filename, id FROM assets WHERE project_id = ?')
    .all(project.id).map((row) => [row.filename, String(row.id)]));
  const release = releaseService.createReleaseWithSelectedAssets(project.id, { title: `${title} Release` },
    SAVED.map((filename) => Number(ids[filename])));
  db.prepare('UPDATE release_assets SET role = ? WHERE release_id = ? AND asset_id = ?')
    .run('primary', release.id, Number(ids[SAVED[0]]));
  return { projectId: project.id, releaseId: release.id, ids };
}

const sorted = (values) => [...values].sort();
const savedRows = (releaseId) => db
  .prepare('SELECT asset_id, role, sort_order FROM release_assets WHERE release_id = ? ORDER BY sort_order')
  .all(releaseId).map((row) => ({ ...row, asset_id: String(row.asset_id) }));
const params = (page) => Object.fromEntries(new URL(page.url()).searchParams);

const draftMembership = (page) => page.evaluate(() => {
  const ids = new Set();
  document.querySelectorAll('[data-release-assets-hidden-membership] input[name="selectedAssetIds"]')
    .forEach((input) => ids.add(input.value));
  document.querySelectorAll('[data-release-assets-live-region] input[name="selectedAssetIds"]:checked')
    .forEach((input) => ids.add(input.value));
  return [...ids].sort();
});

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
    info: region.locator('.pagination-info'),
    meta: region.locator('.release-asset-results-meta'),
    dialog: page.locator('#release-assets-filter-dialog'),
    trigger: page.getByRole('link', { name: 'Filter assets' }),
    dialogSize: page.locator('#asset-page-size'),
    paginationSize: page.locator('#pageSize'),
    dialogSizeSummary: page.locator('#release-asset-page-size-dropdown [data-cc-dropdown-summary-current]'),
    paginationSizeSummary: page.locator('#page-size-dropdown [data-cc-dropdown-summary-current]'),
  };
}

async function settled(page) {
  await expect(page.locator('[data-release-assets-live-region]')).not.toHaveAttribute('aria-busy', 'true');
}

async function expectSize(page, value, label = value === 'all' ? 'View All' : value) {
  const c = controls(page);
  await expect(c.dialogSize).toHaveValue(value);
  await expect(c.paginationSize).toHaveValue(value);
  await expect(c.dialogSizeSummary).toHaveText(label);
  await expect(c.paginationSizeSummary).toHaveText(label);
}

async function choosePaginationSize(page, label) {
  const dropdown = page.locator('#page-size-dropdown');
  await dropdown.locator('summary').scrollIntoViewIfNeeded();
  await dropdown.locator('summary').click();
  await dropdown.locator('.asset-filter-multiselect-panel').getByText(label, { exact: true }).click();
}

async function openFilters(page) {
  const c = controls(page);
  if (!(await c.dialog.evaluate((dialog) => dialog.open))) await c.trigger.click();
  await expect(c.dialog).toBeVisible();
}

async function chooseDialogOption(page, dropdownId, label) {
  await openFilters(page);
  const dropdown = page.locator(`#${dropdownId}`);
  await dropdown.locator('summary').click();
  await dropdown.locator('.asset-filter-multiselect-panel').getByText(label, { exact: true }).click();
}

test('WP16: both page-size controls share one size through filters, pages, views, reload and history', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createRelease('Pagination Sync');
  const requests = trackRequests(page, f.releaseId);
  const c = controls(page);
  await page.goto(`${baseURL}/releases/${f.releaseId}/assets?selection=all&pageSize=10`);
  await expectSize(page, '10');
  await expect(c.rows).toHaveCount(10);
  await expect(c.info).toHaveText('Page 1 of 3');

  // Filter-only dialog: the intended fields in order, no defaults actions.
  await openFilters(page);
  const labels = await c.dialog.locator('.app-dialog-body label[for], .app-dialog-body summary [data-cc-dropdown-label], .app-dialog-body .cc-dropdown-label')
    .allInnerTexts();
  const fieldText = (await c.dialog.locator('.app-dialog-body').innerText()).replace(/\s+/g, ' ');
  for (const label of ['Find project assets', 'Selection', 'Extension', 'Category', 'Page size']) {
    expect(fieldText).toContain(label);
  }
  expect(fieldText.indexOf('Find project assets')).toBeLessThan(fieldText.indexOf('Selection'));
  expect(fieldText.indexOf('Selection')).toBeLessThan(fieldText.indexOf('Extension'));
  expect(fieldText.indexOf('Extension')).toBeLessThan(fieldText.indexOf('Category'));
  expect(fieldText.indexOf('Category')).toBeLessThan(fieldText.indexOf('Page size'));
  expect(labels.length).toBeGreaterThan(0);
  await expect(c.dialog.getByRole('button', { name: /Save defaults|Reset filters|Reset defaults/ })).toHaveCount(0);
  await expect(c.dialog.locator('[data-defaults-explicit], [data-page-defaults-scope], input[name="scope"]')).toHaveCount(0);
  await expect(c.dialog.locator('.app-dialog-footer')).toHaveText('Clear');

  // 1. Dialog size -> pagination control follows, page 1, URL carries it.
  await chooseDialogOption(page, 'release-asset-page-size-dropdown', '25');
  await settled(page);
  await expect.poll(() => params(page)).toEqual({ selection: 'all', pageSize: '25', view: 'grid' });
  await expectSize(page, '25');
  await expect(c.rows).toHaveCount(25);
  await expect(c.info).toHaveText('Page 1 of 2');
  await page.keyboard.press('Escape');
  await expect(c.dialog).toBeHidden();
  await expect(c.trigger).toBeFocused();

  // 2. Pagination size -> dialog follows; reopening shows it.
  await choosePaginationSize(page, '50');
  await settled(page);
  await expect.poll(() => params(page).pageSize).toBe('50');
  await expectSize(page, '50');
  await expect(c.rows).toHaveCount(TOTAL);
  await expect(c.info).toHaveCount(0);
  await openFilters(page);
  await expect(c.dialogSizeSummary).toHaveText('50');
  await page.keyboard.press('Escape');

  // Reload and Back/Forward between sizes.
  await page.reload();
  await expectSize(page, '50');
  await page.goBack();
  await expect.poll(() => params(page).pageSize).toBe('25');
  await settled(page);
  await expectSize(page, '25');
  await expect(c.rows).toHaveCount(25);
  await page.goForward();
  await expect.poll(() => params(page).pageSize).toBe('50');
  await settled(page);
  await expectSize(page, '50');

  // Later page -> different size returns to page 1 of the new size.
  await choosePaginationSize(page, '10');
  await settled(page);
  await c.region.locator('.pagination-next').click();
  await c.region.locator('.pagination-next').click();
  await settled(page);
  await expect(c.info).toHaveText('Page 3 of 3');
  await expect(c.rows).toHaveCount(TOTAL - 20);
  await choosePaginationSize(page, '25');
  await settled(page);
  await expect.poll(() => params(page)).toEqual({ pageSize: '25', selection: 'all' });
  await expect(c.info).toHaveText('Page 1 of 2');
  await expectSize(page, '25');

  // View All and back to a paginated size.
  await chooseDialogOption(page, 'release-asset-page-size-dropdown', 'View All');
  await settled(page);
  await expect.poll(() => params(page).pageSize).toBe('all');
  await expect(c.rows).toHaveCount(TOTAL);
  await expect(c.info).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expectSize(page, 'all');
  await choosePaginationSize(page, '10');
  await settled(page);
  await expect(c.info).toHaveText('Page 1 of 3');
  await expectSize(page, '10');

  // Grid/List keeps the size; pagination links carry it.
  await page.getByRole('link', { name: 'List view' }).click();
  await settled(page);
  await expect.poll(() => params(page).view).toBe('list');
  expect(params(page).pageSize).toBe('10');
  await expectSize(page, '10');
  await c.region.locator('.pagination-next').click();
  await settled(page);
  await expect.poll(() => params(page)).toEqual({ selection: 'all', page: '2', pageSize: '10', view: 'list' });

  // Search, Extension, Category and Selection keep the size and reset the page.
  await openFilters(page);
  await page.locator('#asset-search').fill('note');
  await expect.poll(() => params(page).search).toBe('note');
  await settled(page);
  expect(params(page).page).toBeUndefined();
  await expectSize(page, '10');
  await expect(c.meta).toHaveText(/4 project assets match/);
  await chooseDialogOption(page, 'release-asset-extension-filter', '.md');
  await settled(page);
  await expect.poll(() => params(page).extension).toBe('md');
  await page.locator('#asset-search').fill('');
  await expect.poll(() => params(page).search).toBeUndefined();
  await settled(page);
  await chooseDialogOption(page, 'release-asset-extension-filter', 'All extensions');
  await settled(page);
  await chooseDialogOption(page, 'release-asset-category-filter', `WIP (${IMAGES.length})`);
  await settled(page);
  await expect(c.meta).toHaveText(new RegExp(`${IMAGES.length} project assets match`));
  await expectSize(page, '10');
  await expect(c.info).toHaveText('Page 1 of 3');

  // Clear keeps size and View, restores saved-selected.
  await page.locator('[data-release-assets-reset]').click();
  await settled(page);
  await expect.poll(() => params(page)).toEqual({ pageSize: '10', view: 'list' });
  await expect(page.locator('#release-asset-selection-option-selected')).toBeChecked();
  await page.keyboard.press('Escape');
  await expectSize(page, '10');
  await expect(c.meta).toHaveText(/3 selected assets match/);

  // Nothing but GETs: no membership Save, role/order write or defaults POST.
  expect(requests.filter((request) => request.method !== 'GET')).toEqual([]);
  expect(savedRows(f.releaseId).map((row) => row.asset_id)).toEqual(SAVED.map((name) => f.ids[name]));
  expect(pageErrors).toEqual([]);
});

test('WP16: failed and stale size GETs keep the latest size, and Retry is GET-only', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createRelease('Pagination Failure');
  const requests = trackRequests(page, f.releaseId);
  const c = controls(page);
  await page.goto(`${baseURL}/releases/${f.releaseId}/assets?selection=all&pageSize=10`);
  await expectSize(page, '10');

  // Hold the 25 response; fail the 50 request once.
  let releaseHeld;
  const held = new Promise((resolve) => { releaseHeld = resolve; });
  await page.route((url) => url.pathname === `/releases/${f.releaseId}/assets` && url.searchParams.get('pageSize') === '25',
    async (route) => {
      await held;
      // The engine aborts a superseded fetch; if Chromium kept it, it still arrives last.
      await route.continue().catch(() => {});
    }, { times: 1 });
  await page.route((url) => url.pathname === `/releases/${f.releaseId}/assets` && url.searchParams.get('pageSize') === '50',
    (route) => route.abort('failed'), { times: 1 });

  await choosePaginationSize(page, '25');
  await expect(c.region).toHaveAttribute('aria-busy', 'true');
  await choosePaginationSize(page, '50');
  const notice = page.locator('[data-live-filter-failure]');
  await expect(notice).toBeVisible();
  // The failed request's controls stay as chosen, both of them.
  await expect(c.paginationSize).toHaveValue('50');
  await expect(c.dialogSize).toHaveValue('50');
  await expect(c.rows).toHaveCount(10);
  expect(params(page).pageSize).toBe('10');

  // The superseded 25 response arrives last and is not installed.
  releaseHeld();
  await page.waitForTimeout(400);
  await expect(c.rows).toHaveCount(10);
  expect(params(page).pageSize).toBe('10');
  await expect(c.dialogSize).toHaveValue('50');

  // Retry repeats the failed GET only.
  const before = requests.length;
  await notice.getByRole('button', { name: 'Retry' }).click();
  await settled(page);
  await expect.poll(() => params(page).pageSize).toBe('50');
  await expectSize(page, '50');
  await expect(c.rows).toHaveCount(TOTAL);
  const retried = requests.slice(before);
  expect(retried.map((request) => [request.method, request.url.searchParams.get('pageSize')])).toEqual([['GET', '50']]);

  // A pagination link followed after a failed size keeps the newer size.
  await choosePaginationSize(page, '10');
  await settled(page);
  await page.route((url) => url.pathname === `/releases/${f.releaseId}/assets` && url.searchParams.get('pageSize') === '25',
    (route) => route.abort('failed'), { times: 1 });
  await choosePaginationSize(page, '25');
  await expect(notice).toBeVisible();
  await c.region.locator('.pagination-next').click();
  await settled(page);
  // 25 is the service fallback, implicit in the URL as in rendered links.
  await expect.poll(() => params(page)).toEqual({ selection: 'all', page: '2' });
  await expect(c.info).toHaveText('Page 2 of 2');
  await expect(c.rows).toHaveCount(TOTAL - 25);
  await expectSize(page, '25');

  expect(requests.filter((request) => request.method !== 'GET')).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('WP16: an unsaved membership draft survives sizes, filters, pages and views, and Save posts the latest draft', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createRelease('Pagination Draft');
  const requests = trackRequests(page, f.releaseId);
  const c = controls(page);
  const rowsBefore = savedRows(f.releaseId);
  const checkbox = (name) => c.region.locator(`input[name="selectedAssetIds"][value="${f.ids[name]}"]`);
  await page.goto(`${baseURL}/releases/${f.releaseId}/assets?selection=all&view=list&pageSize=10`);

  await checkbox('02-image.png').uncheck({ force: true });
  await checkbox('05-image.png').check({ force: true });
  const draft = sorted([f.ids['01-image.png'], f.ids['03-image.png'], f.ids['05-image.png'], f.ids['20-image.png']]);

  await choosePaginationSize(page, '25');
  await settled(page);
  await checkbox('20-image.png').check({ force: true });
  expect(await draftMembership(page)).toEqual(draft);

  await chooseDialogOption(page, 'release-asset-page-size-dropdown', '10');
  await settled(page);
  await page.keyboard.press('Escape');
  await c.region.locator('.pagination-next').click();
  await settled(page);
  await expect(checkbox('20-image.png')).toBeChecked();
  expect(await draftMembership(page)).toEqual(draft);

  await choosePaginationSize(page, 'View All');
  await settled(page);
  await expect(checkbox('02-image.png')).not.toBeChecked();
  await expect(checkbox('05-image.png')).toBeChecked();
  await page.getByRole('link', { name: 'Grid view' }).click();
  await settled(page);
  expect(await draftMembership(page)).toEqual(draft);

  // A failed size GET and its Retry keep the draft.
  await page.route((url) => url.pathname === `/releases/${f.releaseId}/assets` && url.searchParams.get('pageSize') === '50',
    (route) => route.abort('failed'), { times: 1 });
  await choosePaginationSize(page, '50');
  await expect(page.locator('[data-live-filter-failure]')).toBeVisible();
  expect(await draftMembership(page)).toEqual(draft);
  await page.locator('[data-live-filter-failure]').getByRole('button', { name: 'Retry' }).click();
  await settled(page);
  expect(await draftMembership(page)).toEqual(draft);

  // Clear hides the additions (saved-selected) but keeps them in the payload.
  await openFilters(page);
  await page.locator('[data-release-assets-reset]').click();
  await settled(page);
  await page.keyboard.press('Escape');
  await expectSize(page, '50');
  await expect(checkbox('05-image.png')).toHaveCount(0);
  expect(await draftMembership(page)).toEqual(draft);

  // Nothing was saved along the way.
  expect(requests.filter((request) => request.method !== 'GET')).toEqual([]);
  expect(savedRows(f.releaseId)).toEqual(rowsBefore);

  await page.getByRole('button', { name: 'Save asset selection' }).click();
  await expect.poll(() => sorted(savedRows(f.releaseId).map((row) => row.asset_id))).toEqual(draft);
  const posts = requests.filter((request) => request.method === 'POST');
  expect(posts).toHaveLength(1);
  expect(sorted(new URLSearchParams(posts[0].body).getAll('selectedAssetIds'))).toEqual(draft);
  // Kept selections keep their role and relative order; additions append.
  const after = savedRows(f.releaseId);
  expect(after.find((row) => row.asset_id === f.ids['01-image.png']).role).toBe('primary');
  expect(after.slice(0, 2).map((row) => row.asset_id)).toEqual([f.ids['01-image.png'], f.ids['03-image.png']]);
  expect(pageErrors).toEqual([]);
});

test('WP16: keyboard and narrow layout reach both size controls; read-only releases expose neither', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await createRelease('Pagination Keyboard');
  const c = controls(page);
  await page.goto(`${baseURL}/releases/${f.releaseId}/assets?selection=all&pageSize=10`);
  const noHorizontalScroll = () => page.evaluate(() => document.documentElement.scrollWidth
    <= document.documentElement.clientWidth);
  expect(await noHorizontalScroll()).toBe(true);

  // Keyboard: open the dialog, open Page size, choose 100 with the keyboard.
  await c.trigger.focus();
  await page.keyboard.press('Enter');
  await expect(c.dialog).toBeVisible();
  const dialogDropdown = page.locator('#release-asset-page-size-dropdown');
  await dialogDropdown.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(dialogDropdown).toHaveAttribute('open', '');
  const panelBox = await dialogDropdown.locator('.asset-filter-multiselect-panel').boundingBox();
  expect(panelBox.x).toBeGreaterThanOrEqual(0);
  expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(390);
  await dialogDropdown.locator('input[type="radio"][value="100"]').focus();
  await page.keyboard.press('Space');
  await settled(page);
  await expect.poll(() => params(page).pageSize).toBe('100');
  // Escape closes the open panel first, then the dialog, returning focus.
  if (await dialogDropdown.evaluate((node) => node.open)) {
    await page.keyboard.press('Escape');
    await expect(dialogDropdown).not.toHaveAttribute('open', '');
  }
  await page.keyboard.press('Escape');
  await expect(c.dialog).toBeHidden();
  await expect(c.trigger).toBeFocused();
  await expectSize(page, '100');
  expect(await noHorizontalScroll()).toBe(true);

  // Pagination-side control by keyboard at narrow width.
  const footer = page.locator('#page-size-dropdown');
  await footer.locator('summary').scrollIntoViewIfNeeded();
  await footer.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(footer).toHaveAttribute('open', '');
  const footerBox = await footer.locator('.asset-filter-multiselect-panel').boundingBox();
  expect(footerBox.x).toBeGreaterThanOrEqual(0);
  expect(footerBox.x + footerBox.width).toBeLessThanOrEqual(390);
  await footer.locator('input[type="radio"][value="10"]').focus();
  await page.keyboard.press('Space');
  await settled(page);
  await expect.poll(() => params(page).pageSize).toBe('10');
  await expectSize(page, '10');
  expect(await noHorizontalScroll()).toBe(true);

  // Read-only (archived) release: size navigation shows saved assets only,
  // with no size controls, filter, membership checkboxes or Save.
  db.prepare("UPDATE releases SET archived_at = datetime('now') WHERE id = ?").run(f.releaseId);
  await page.goto(`${baseURL}/releases/${f.releaseId}/assets?selection=all&pageSize=10&page=2`);
  await expect(page.locator('#pageSize, #asset-page-size, #page-size-dropdown')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Filter assets' })).toHaveCount(0);
  await expect(page.locator('[data-release-assets-live-region] input[name="selectedAssetIds"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save asset selection' })).toHaveCount(0);
  await expect(c.rows).toHaveCount(SAVED.length);
  await page.getByRole('link', { name: 'List view' }).click();
  await expect.poll(() => params(page).view).toBe('list');
  await expect(page.locator('#pageSize, #asset-page-size')).toHaveCount(0);
  await expect(page.locator('[data-release-assets-live-region] input[name="selectedAssetIds"]')).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

// R3: Grid/List, pagination and Clear links are rendered for the installed
// response; following one while a Search / page-size GET is held, debounced
// or failed composes the clicked dimension with that latest intent.
const NEEDLES = Array.from({ length: 12 }, (_, index) => `needle-${String(index + 1).padStart(2, '0')}.png`);
const assetsPath = (f) => `/releases/${f.releaseId}/assets`;

// Holds every GET matching `match` until release(); delivered() settles once
// each held route has been continued (or found aborted by the engine).
async function holdRequests(page, f, match) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const routed = [];
  await page.route((url) => url.pathname === assetsPath(f) && match(url.searchParams), async (route) => {
    let done;
    routed.push(new Promise((resolve) => { done = resolve; }));
    await gate;
    await route.continue().catch(() => {});
    done();
  });
  return { release, routed, delivered: () => Promise.all(routed) };
}

const regionAssetIds = (page) => page.locator('[data-release-assets-live-region] input[name="selectedAssetIds"]')
  .evaluateAll((inputs) => inputs.map((input) => input.value));
const dialogIntent = (page) => page.evaluate(() => Object.fromEntries(
  new FormData(document.querySelector('#release-assets-filter')).entries(),
));
const LIST_INTENT = { view: 'list', search: 'needle', selection: 'all', pageSize: '10' };

test('R3: Grid -> List during a held Search + size GET keeps Search, Selection and size; stale, failure, history, Clear and Save', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createRelease('R3 View Intent', { extraImages: NEEDLES });
  const needleIds = new Set(NEEDLES.map((name) => f.ids[name]));
  const requests = trackRequests(page, f.releaseId);
  const c = controls(page);
  const checkbox = (name) => c.region.locator(`input[name="selectedAssetIds"][value="${f.ids[name]}"]`);
  const rowsBefore = savedRows(f.releaseId);
  await page.goto(`${baseURL}${assetsPath(f)}?selection=all`);
  await expectSize(page, '25');

  // Unsaved draft: remove saved 02, add 05 (both later hidden by the Search).
  await checkbox('02-image.png').uncheck({ force: true });
  await checkbox('05-image.png').check({ force: true });

  // Hold every Grid GET carrying the Search (debounced Search, then + size 10).
  const hold = await holdRequests(page, f, (sp) => sp.get('search') === 'needle' && sp.get('view') !== 'list');
  await openFilters(page);
  await page.locator('#asset-search').fill('needle');
  await expect.poll(() => hold.routed.length).toBe(1);
  await page.keyboard.press('Escape');
  await expect(c.dialog).toBeHidden();
  await choosePaginationSize(page, '10');
  await expect.poll(() => hold.routed.length).toBe(2);
  const combined = requests.filter((r) => r.url.searchParams.get('pageSize') === '10').at(-1).url.searchParams;
  expect([combined.get('search'), combined.get('selection')]).toEqual(['needle', 'all']);
  await expect(c.region).toHaveAttribute('aria-busy', 'true');
  await expect(c.rows).toHaveCount(25);

  // The List link was rendered before the Search; following it keeps the intent.
  const listLink = page.getByRole('link', { name: 'List view' });
  expect(await listLink.getAttribute('href')).not.toContain('needle');
  await listLink.click();
  await settled(page);
  await expect.poll(() => params(page)).toEqual(LIST_INTENT);
  const listRequest = requests.filter((r) => r.url.searchParams.get('view') === 'list').at(-1);
  expect(Object.fromEntries(listRequest.url.searchParams)).toEqual(LIST_INTENT);
  await expect(c.region.locator('.asset-list-item')).toHaveCount(10);
  await expect(c.region.locator('.asset-grid-item')).toHaveCount(0);
  const listedIds = await regionAssetIds(page);
  expect(listedIds).toHaveLength(10);
  expect(listedIds.every((id) => needleIds.has(id))).toBe(true);
  await expect(c.meta).toContainText('12 project assets match');
  await expect(c.info).toHaveText('Page 1 of 2');
  await expectSize(page, '10');
  await openFilters(page);
  await expect(page.locator('#asset-search')).toHaveValue('needle');
  expect(await dialogIntent(page)).toMatchObject({ search: 'needle', selection: 'all', pageSize: '10', view: 'list' });
  await page.keyboard.press('Escape');

  // The older held responses arrive last and install nothing.
  const listedHref = page.url();
  hold.release();
  await hold.delivered();
  await page.waitForTimeout(300);
  expect(page.url()).toBe(listedHref);
  await expect(c.region.locator('.asset-list-item')).toHaveCount(10);
  expect(sorted(await regionAssetIds(page))).toEqual(sorted(listedIds));
  await expectSize(page, '10');

  // A needle addition on the composed page joins the draft.
  await checkbox('needle-03.png').check({ force: true });
  const draft = sorted([f.ids['01-image.png'], f.ids['03-image.png'], f.ids['05-image.png'], f.ids['needle-03.png']]);
  expect(await draftMembership(page)).toEqual(draft);

  // Back to Grid keeps everything; Grid stays implicit in the URL.
  await page.getByRole('link', { name: 'Grid view' }).click();
  await settled(page);
  await expect.poll(() => params(page)).toEqual({ search: 'needle', selection: 'all', pageSize: '10' });
  await expect(c.region.locator('.asset-grid-item')).toHaveCount(10);

  // A failed View GET keeps the results; Retry repeats only that GET.
  await page.route((url) => url.pathname === assetsPath(f) && url.searchParams.get('view') === 'list',
    (route) => route.abort('failed'), { times: 1 });
  await page.getByRole('link', { name: 'List view' }).click();
  const notice = page.locator('[data-live-filter-failure]');
  await expect(notice).toBeVisible();
  await expect(c.region.locator('.asset-grid-item')).toHaveCount(10);
  const beforeRetry = requests.length;
  await notice.getByRole('button', { name: 'Retry' }).click();
  await settled(page);
  await expect.poll(() => params(page)).toEqual(LIST_INTENT);
  expect(requests.slice(beforeRetry).map((r) => [r.method, Object.fromEntries(r.url.searchParams)]))
    .toEqual([['GET', LIST_INTENT]]);
  expect(await draftMembership(page)).toEqual(draft);

  // Back / Forward through the composed entries.
  await page.goBack();
  await settled(page);
  await expect.poll(() => params(page)).toEqual({ search: 'needle', selection: 'all', pageSize: '10' });
  await expect(c.region.locator('.asset-grid-item')).toHaveCount(10);
  await expectSize(page, '10');
  await page.goForward();
  await settled(page);
  await expect.poll(() => params(page)).toEqual(LIST_INTENT);
  await expect(c.region.locator('.asset-list-item')).toHaveCount(10);
  expect(await draftMembership(page)).toEqual(draft);

  // Clear while a Search edit is held: filters only; View and size stay.
  const holdEdit = await holdRequests(page, f, (sp) => sp.get('search') === 'needle-0');
  await openFilters(page);
  await page.locator('#asset-search').fill('needle-0');
  await expect.poll(() => holdEdit.routed.length).toBe(1);
  await page.locator('[data-release-assets-reset]').click();
  await settled(page);
  await expect.poll(() => params(page)).toEqual({ view: 'list', pageSize: '10' });
  holdEdit.release();
  await holdEdit.delivered();
  await page.waitForTimeout(300);
  await expect.poll(() => params(page)).toEqual({ view: 'list', pageSize: '10' });
  await expect(page.locator('#asset-search')).toHaveValue('');
  await page.keyboard.press('Escape');
  await expectSize(page, '10');
  // Saved-selected only: the unsaved additions are hidden but kept.
  await expect(checkbox('05-image.png')).toHaveCount(0);
  await expect(checkbox('needle-03.png')).toHaveCount(0);
  expect(await draftMembership(page)).toEqual(draft);

  // Nothing saved along the way; Save posts the latest draft incl. hidden ones.
  expect(requests.filter((r) => r.method !== 'GET')).toEqual([]);
  expect(savedRows(f.releaseId)).toEqual(rowsBefore);
  await page.getByRole('button', { name: 'Save asset selection' }).click();
  await expect.poll(() => sorted(savedRows(f.releaseId).map((row) => row.asset_id))).toEqual(draft);
  const posts = requests.filter((r) => r.method === 'POST');
  expect(posts).toHaveLength(1);
  const posted = new URLSearchParams(posts[0].body).getAll('selectedAssetIds');
  expect(sorted(posted)).toEqual(draft);
  expect(new Set(posted).size).toBe(posted.length);
  const after = savedRows(f.releaseId);
  expect(after.find((row) => row.asset_id === f.ids['01-image.png']).role).toBe('primary');
  expect(after.slice(0, 2).map((row) => row.asset_id)).toEqual([f.ids['01-image.png'], f.ids['03-image.png']]);
  expect(pageErrors).toEqual([]);
});

test('R3: List -> Grid and pagination compose with a held Search GET', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createRelease('R3 Grid Intent', { extraImages: NEEDLES });
  const needleIds = new Set(NEEDLES.map((name) => f.ids[name]));
  const requests = trackRequests(page, f.releaseId);
  const c = controls(page);
  await page.goto(`${baseURL}${assetsPath(f)}?selection=all&view=list&pageSize=10`);
  await expect(c.info).toHaveText('Page 1 of 4');

  // List -> Grid while the Search GET is held.
  const hold = await holdRequests(page, f, (sp) => sp.get('search') === 'needle' && sp.get('view') === 'list');
  await openFilters(page);
  await page.locator('#asset-search').fill('needle');
  await expect.poll(() => hold.routed.length).toBe(1);
  await page.keyboard.press('Escape');
  await page.getByRole('link', { name: 'Grid view' }).click();
  await settled(page);
  await expect.poll(() => params(page)).toEqual({ search: 'needle', selection: 'all', pageSize: '10' });
  await expect(c.region.locator('.asset-grid-item')).toHaveCount(10);
  expect((await regionAssetIds(page)).every((id) => needleIds.has(id))).toBe(true);
  hold.release();
  await hold.delivered();
  await page.waitForTimeout(300);
  await expect.poll(() => params(page)).toEqual({ search: 'needle', selection: 'all', pageSize: '10' });

  // Clear back to an unfiltered page 1 of 4, then page 2 while a Search GET is held.
  await openFilters(page);
  await page.locator('[data-release-assets-reset]').click();
  await settled(page);
  await page.keyboard.press('Escape');
  await expect.poll(() => params(page)).toEqual({ pageSize: '10' });
  await page.goto(`${baseURL}${assetsPath(f)}?selection=all&pageSize=10`);
  await expect(c.info).toHaveText('Page 1 of 4');
  const holdPaged = await holdRequests(page, f, (sp) => sp.get('search') === 'needle' && !sp.has('page'));
  await openFilters(page);
  await page.locator('#asset-search').fill('needle');
  await expect.poll(() => holdPaged.routed.length).toBe(1);
  await page.keyboard.press('Escape');
  expect(await c.region.locator('.pagination-next').getAttribute('href')).not.toContain('needle');
  await c.region.locator('.pagination-next').click();
  await settled(page);
  await expect.poll(() => params(page)).toEqual({ view: 'grid', search: 'needle', selection: 'all', pageSize: '10', page: '2' });
  await expect(c.info).toHaveText('Page 2 of 2');
  await expect(c.rows).toHaveCount(2);
  expect((await regionAssetIds(page)).every((id) => needleIds.has(id))).toBe(true);
  await expectSize(page, '10');
  holdPaged.release();
  await holdPaged.delivered();
  await page.waitForTimeout(300);
  await expect(c.info).toHaveText('Page 2 of 2');

  expect(requests.filter((r) => r.method !== 'GET')).toEqual([]);
  expect(pageErrors).toEqual([]);
});

// R5: a Back/Forward that starts while an older page-size GET is held owns
// page size (and every other navigation dimension) from the moment it starts;
// a later View, Clear or filter action composes with it, never with the
// abandoned size. Only a newer explicit size choice replaces it.
async function referenceIds(page, href) {
  const fresh = await page.context().newPage();
  await fresh.goto(href);
  const ids = await regionAssetIds(fresh);
  await fresh.close();
  return ids;
}

const sizeParam = (value) => (sp) => sp.get('pageSize') === value;

test('R5: reviewer sequence - size 25 held, Back to size 10 held, List keeps size 10 and Selection=all', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createRelease('R5 Back View');
  const requests = trackRequests(page, f.releaseId);
  const c = controls(page);
  const rowsBefore = savedRows(f.releaseId);
  await page.goto(`${baseURL}${assetsPath(f)}?selection=all&pageSize=10`);
  await expect(c.rows).toHaveCount(10);

  await choosePaginationSize(page, '50');
  await settled(page);
  await expect.poll(() => params(page)).toEqual({ selection: 'all', pageSize: '50' });
  await expect(c.rows).toHaveCount(TOTAL);

  const held25 = await holdRequests(page, f, sizeParam('25'));
  await choosePaginationSize(page, '25');
  await expect.poll(() => held25.routed.length).toBe(1);
  await expectSize(page, '25');

  const heldBack = await holdRequests(page, f, (sp) => sp.get('pageSize') === '10' && sp.get('view') !== 'list');
  await page.goBack({ waitUntil: 'commit' });
  await expect.poll(() => heldBack.routed.length).toBe(1);
  await expect(c.region).toHaveAttribute('aria-busy', 'true');
  // Both controls follow the Back destination before it installs.
  await expectSize(page, '10');
  await expect(c.rows).toHaveCount(TOTAL);

  const beforeList = requests.length;
  await page.getByRole('link', { name: 'List view' }).click();
  await settled(page);
  const LISTED = { selection: 'all', pageSize: '10', view: 'list' };
  await expect.poll(() => params(page)).toEqual(LISTED);
  const listRequests = requests.slice(beforeList).filter((r) => r.url.searchParams.get('view') === 'list');
  expect(listRequests.map((r) => Object.fromEntries(r.url.searchParams))).toEqual([LISTED]);
  await expect(c.region.locator('.asset-list-item')).toHaveCount(10);
  await expect(c.region.locator('.asset-grid-item')).toHaveCount(0);
  await expect(c.info).toHaveText('Page 1 of 3');
  await expect(c.meta).toContainText(`${TOTAL} project assets match`);
  await expectSize(page, '10');
  const listedHref = page.url();
  const listedIds = await regionAssetIds(page);
  expect(listedIds).toEqual(await referenceIds(page, listedHref));

  await openFilters(page);
  expect(await dialogIntent(page)).toMatchObject({ selection: 'all', pageSize: '10', view: 'list', search: '' });
  await expect(page.locator('#release-asset-selection-option-all')).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(c.dialog).toBeHidden();

  // The abandoned 25 and the superseded Back answers arrive last: no change.
  held25.release();
  heldBack.release();
  await Promise.all([held25.delivered(), heldBack.delivered()]);
  await page.waitForTimeout(300);
  expect(page.url()).toBe(listedHref);
  expect(await regionAssetIds(page)).toEqual(listedIds);
  await expectSize(page, '10');

  // One history entry for the List action: Back returns to the Back destination.
  await page.goBack();
  await settled(page);
  await expect.poll(() => params(page)).toEqual({ selection: 'all', pageSize: '10' });
  await expect(c.region.locator('.asset-grid-item')).toHaveCount(10);
  await expectSize(page, '10');
  await page.goForward();
  await settled(page);
  await expect.poll(() => params(page)).toEqual(LISTED);

  expect(requests.filter((r) => r.method !== 'GET')).toEqual([]);
  expect(savedRows(f.releaseId)).toEqual(rowsBefore);
  expect(pageErrors).toEqual([]);
});

test('R5: Forward during a held View All -> Grid, Back during a held 25 -> Clear, then Save posts the draft', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createRelease('R5 Forward Clear');
  const requests = trackRequests(page, f.releaseId);
  const c = controls(page);
  const rowsBefore = savedRows(f.releaseId);
  const checkbox = (name) => c.region.locator(`input[name="selectedAssetIds"][value="${f.ids[name]}"]`);
  await page.goto(`${baseURL}${assetsPath(f)}?selection=all&view=list&pageSize=10`);

  // Unsaved draft created before the held history sequence.
  await checkbox('02-image.png').uncheck({ force: true });
  await checkbox('05-image.png').check({ force: true });
  const draft = sorted([f.ids['01-image.png'], f.ids['03-image.png'], f.ids['05-image.png']]);

  await choosePaginationSize(page, '50');
  await settled(page);
  await expect.poll(() => params(page).pageSize).toBe('50');
  await page.goBack();
  await settled(page);
  await expect.poll(() => params(page).pageSize).toBe('10');
  await expectSize(page, '10');

  // View All held (no entry pushed yet), then Forward to the size-50 entry, held.
  const heldAll = await holdRequests(page, f, sizeParam('all'));
  await choosePaginationSize(page, 'View All');
  await expect.poll(() => heldAll.routed.length).toBe(1);
  const heldForward = await holdRequests(page, f, (sp) => sp.get('pageSize') === '50' && sp.get('view') === 'list');
  await page.goForward({ waitUntil: 'commit' });
  await expect.poll(() => heldForward.routed.length).toBe(1);
  await expectSize(page, '50');

  await page.getByRole('link', { name: 'Grid view' }).click();
  await settled(page);
  // Grid stays implicit, as the established View links spell it.
  await expect.poll(() => params(page)).toEqual({ selection: 'all', pageSize: '50' });
  await expect(c.region.locator('.asset-grid-item')).toHaveCount(TOTAL);
  await expect(c.info).toHaveCount(0);
  await expectSize(page, '50');
  heldAll.release();
  heldForward.release();
  await Promise.all([heldAll.delivered(), heldForward.delivered()]);
  await page.waitForTimeout(300);
  await expect.poll(() => params(page)).toEqual({ selection: 'all', pageSize: '50' });
  await expect(c.region.locator('.asset-grid-item')).toHaveCount(TOTAL);
  expect(await draftMembership(page)).toEqual(draft);

  // Back (to the List size-50 entry) while a size-25 GET is held, then Clear.
  const held25 = await holdRequests(page, f, sizeParam('25'));
  await choosePaginationSize(page, '25');
  await expect.poll(() => held25.routed.length).toBe(1);
  const heldBack = await holdRequests(page, f, (sp) => sp.get('pageSize') === '50' && sp.get('view') === 'list'
    && sp.get('selection') === 'all');
  await page.goBack({ waitUntil: 'commit' });
  await expect.poll(() => heldBack.routed.length).toBe(1);
  await expectSize(page, '50');
  await openFilters(page);
  await page.locator('[data-release-assets-reset]').click();
  await settled(page);
  await expect.poll(() => params(page)).toEqual({ view: 'list', pageSize: '50' });
  await expect(page.locator('#release-asset-selection-option-selected')).toBeChecked();
  await expect(page.locator('#asset-search')).toHaveValue('');
  await page.keyboard.press('Escape');
  held25.release();
  heldBack.release();
  await Promise.all([held25.delivered(), heldBack.delivered()]);
  await page.waitForTimeout(300);
  await expect.poll(() => params(page)).toEqual({ view: 'list', pageSize: '50' });
  await expectSize(page, '50');
  await expect(c.meta).toHaveText(/3 selected assets match/);
  // Saved-selected only: the unsaved addition is hidden but kept.
  await expect(checkbox('05-image.png')).toHaveCount(0);
  expect(await draftMembership(page)).toEqual(draft);

  expect(requests.filter((r) => r.method !== 'GET')).toEqual([]);
  expect(savedRows(f.releaseId)).toEqual(rowsBefore);
  await page.getByRole('button', { name: 'Save asset selection' }).click();
  await expect.poll(() => sorted(savedRows(f.releaseId).map((row) => row.asset_id))).toEqual(draft);
  const posts = requests.filter((r) => r.method === 'POST');
  expect(posts).toHaveLength(1);
  const posted = new URLSearchParams(posts[0].body).getAll('selectedAssetIds');
  expect(sorted(posted)).toEqual(draft);
  expect(new Set(posted).size).toBe(posted.length);
  const after = savedRows(f.releaseId);
  expect(after.find((row) => row.asset_id === f.ids['01-image.png']).role).toBe('primary');
  expect(after.slice(0, 2).map((row) => row.asset_id)).toEqual([f.ids['01-image.png'], f.ids['03-image.png']]);
  expect(pageErrors).toEqual([]);
});

test('R5: implicit 25 Back owns the size; a failed Back keeps its size for List and Retry; Category composes', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createRelease('R5 Default Failure');
  const requests = trackRequests(page, f.releaseId);
  const c = controls(page);
  const rowsBefore = savedRows(f.releaseId);

  // Default size 25 is implicit in the history entry.
  await page.goto(`${baseURL}${assetsPath(f)}?selection=all`);
  await expectSize(page, '25');
  await choosePaginationSize(page, 'View All');
  await settled(page);
  await expect.poll(() => params(page).pageSize).toBe('all');
  const held50 = await holdRequests(page, f, sizeParam('50'));
  await choosePaginationSize(page, '50');
  await expect.poll(() => held50.routed.length).toBe(1);
  const heldDefault = await holdRequests(page, f, (sp) => !sp.has('pageSize') && sp.get('view') !== 'list');
  await page.goBack({ waitUntil: 'commit' });
  await expect.poll(() => heldDefault.routed.length).toBe(1);
  await expectSize(page, '25');
  await page.getByRole('link', { name: 'List view' }).click();
  await settled(page);
  await expect.poll(() => params(page)).toEqual({ selection: 'all', view: 'list' });
  await expect(c.region.locator('.asset-list-item')).toHaveCount(25);
  await expect(c.info).toHaveText('Page 1 of 2');
  await expectSize(page, '25');
  held50.release();
  heldDefault.release();
  await Promise.all([held50.delivered(), heldDefault.delivered()]);
  await page.waitForTimeout(300);
  await expect.poll(() => params(page)).toEqual({ selection: 'all', view: 'list' });
  await expect(c.region.locator('.asset-list-item')).toHaveCount(25);

  // List size 10, then View All; a size-25 GET held, Back to List size 10 fails.
  await choosePaginationSize(page, '10');
  await settled(page);
  await choosePaginationSize(page, 'View All');
  await settled(page);
  await expect.poll(() => params(page)).toEqual({ selection: 'all', view: 'list', pageSize: 'all' });
  const held25 = await holdRequests(page, f, sizeParam('25'));
  await choosePaginationSize(page, '25');
  await expect.poll(() => held25.routed.length).toBe(1);
  await page.route((url) => url.pathname === assetsPath(f) && url.searchParams.get('pageSize') === '10',
    (route) => route.abort('failed'), { times: 1 });
  await page.goBack({ waitUntil: 'commit' });
  const notice = page.locator('[data-live-filter-failure]');
  await expect(notice).toBeVisible();
  await expect(c.region.locator('.asset-list-item')).toHaveCount(TOTAL);
  await expectSize(page, '10');

  // Retry repeats only the failed Back GET.
  const beforeRetry = requests.length;
  await notice.getByRole('button', { name: 'Retry' }).click();
  await settled(page);
  await expect.poll(() => params(page)).toEqual({ selection: 'all', view: 'list', pageSize: '10' });
  expect(requests.slice(beforeRetry).map((r) => [r.method, Object.fromEntries(r.url.searchParams)]))
    .toEqual([['GET', { selection: 'all', view: 'list', pageSize: '10' }]]);
  await expect(c.region.locator('.asset-list-item')).toHaveCount(10);
  await expectSize(page, '10');

  // Forward (to View All) fails, then Grid composes with the failed entry.
  await page.route((url) => url.pathname === assetsPath(f) && url.searchParams.get('pageSize') === 'all',
    (route) => route.abort('failed'), { times: 1 });
  await page.goForward({ waitUntil: 'commit' });
  await expect(notice).toBeVisible();
  await expectSize(page, 'all');
  await page.getByRole('link', { name: 'Grid view' }).click();
  await settled(page);
  await expect.poll(() => params(page)).toEqual({ selection: 'all', pageSize: 'all' });
  await expect(c.region.locator('.asset-grid-item')).toHaveCount(TOTAL);

  // Back (to the List View All entry) held while a size-25 GET is pending -> Category.
  const held25b = await holdRequests(page, f, (sp) => sp.get('pageSize') === '25' && sp.get('view') !== 'list');
  await choosePaginationSize(page, '25');
  await expect.poll(() => held25b.routed.length).toBe(1);
  const heldBack = await holdRequests(page, f,
    (sp) => sp.get('pageSize') === 'all' && sp.get('view') === 'list' && !sp.has('category'));
  await page.goBack({ waitUntil: 'commit' });
  await expect.poll(() => heldBack.routed.length).toBe(1);
  await expectSize(page, 'all');
  await chooseDialogOption(page, 'release-asset-category-filter', `WIP (${IMAGES.length})`);
  await settled(page);
  await expect.poll(() => params(page).category).toBeDefined();
  const categorized = params(page);
  expect(categorized).toMatchObject({ selection: 'all', view: 'list', pageSize: 'all' });
  await expect(c.meta).toHaveText(new RegExp(`${IMAGES.length} project assets match`));
  await expect(c.region.locator('.asset-list-item')).toHaveCount(IMAGES.length);
  await page.keyboard.press('Escape');
  held25.release();
  held25b.release();
  heldBack.release();
  await Promise.all([held25.delivered(), held25b.delivered(), heldBack.delivered()]);
  await page.waitForTimeout(300);
  expect(params(page)).toEqual(categorized);
  await expectSize(page, 'all');

  expect(requests.filter((r) => r.method !== 'GET')).toEqual([]);
  expect(savedRows(f.releaseId)).toEqual(rowsBefore);
  expect(pageErrors).toEqual([]);
});

// R8: Clear filters owns Search, Selection, Extension and Category from the
// moment its GET starts. The dialog follows the Clear destination at once, so
// a filter, View or size edit made while Clear is held or failed changes only
// its own dimension and never restores what Clear removed. Searchable
// `asset-*` files contrast in extension and saved state: asset-01/02 are
// unsaved WIP images, asset-03.md an unsaved uncategorized note.
const ASSET_IMAGES = ['asset-01.png', 'asset-02.png'];

async function createClearRelease(title) {
  const f = await createRelease(title, { extraImages: ASSET_IMAGES });
  const project = db.prepare('SELECT project_dir FROM projects WHERE id = ?').get(f.projectId);
  fs.writeFileSync(path.join(projectsRoot, project.project_dir, 'asset-03.md'), '# asset-03');
  app.locals.assetScanner.scanProjectAssets(f.projectId);
  f.ids = Object.fromEntries(db.prepare('SELECT filename, id FROM assets WHERE project_id = ?')
    .all(f.projectId).map((row) => [row.filename, String(row.id)]));
  return f;
}

// The dialog spells the default Selection and Grid explicitly; links omit them.
const intentOf = (searchParams) => Object.fromEntries([...searchParams]
  .filter(([key, value]) => !(key === 'selection' && value === 'selected') && !(key === 'view' && value === 'grid')));
const pageIntent = (page) => intentOf(new URL(page.url()).searchParams);
const isClearOf = (size, view) => (sp) => sp.get('pageSize') === size && (sp.get('view') || 'grid') === view
  && !sp.has('search') && !sp.has('extension') && !sp.has('category') && (sp.get('selection') || 'selected') === 'selected';

async function expectClearedDialog(page) {
  await expect(page.locator('#asset-search')).toHaveValue('');
  await expect(page.locator('#release-asset-selection-option-selected')).toBeChecked();
  await expect(page.locator('#release-asset-extension-option-all')).toBeChecked();
  await expect(page.locator('#release-asset-category-option-all')).toBeChecked();
  await expect(page.locator('#release-asset-selection-filter [data-cc-dropdown-summary-current]')).toHaveText('Selected assets');
  await expect(page.locator('#release-asset-extension-filter [data-cc-dropdown-summary-current]')).not.toContainText('.md');
  await expect(page.locator('#release-asset-category-filter [data-cc-dropdown-summary-current]')).not.toContainText('WIP');
}

test('R8: reviewer case - Clear held, Search=asset-01 composes with Clear; stale Clear, View, size and Save', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createClearRelease('R8 Clear Search');
  const requests = trackRequests(page, f.releaseId);
  const c = controls(page);
  const checkbox = (name) => c.region.locator(`input[name="selectedAssetIds"][value="${f.ids[name]}"]`);
  const rowsBefore = savedRows(f.releaseId);
  await page.goto(`${baseURL}${assetsPath(f)}?selection=all&view=list&pageSize=10`);
  await expectSize(page, '10');

  // Unsaved draft: remove saved 02, add unsaved 05; saved 03 later hidden.
  await checkbox('02-image.png').uncheck({ force: true });
  await checkbox('05-image.png').check({ force: true });
  const draft = sorted([f.ids['01-image.png'], f.ids['03-image.png'], f.ids['05-image.png']]);

  // Search=asset, Extension=md, Selection=All assets (already).
  await openFilters(page);
  await page.locator('#asset-search').fill('asset');
  await settled(page);
  await expect.poll(() => params(page).search).toBe('asset');
  await chooseDialogOption(page, 'release-asset-extension-filter', '.md');
  await settled(page);
  await expect.poll(() => pageIntent(page)).toEqual({ search: 'asset', extension: 'md', selection: 'all', view: 'list', pageSize: '10' });
  expect(await regionAssetIds(page)).toEqual([f.ids['asset-03.md']]);

  // Clear held: its GET keeps only List and size 10; the dialog follows it now.
  const heldClear = await holdRequests(page, f, isClearOf('10', 'list'));
  const beforeClear = requests.length;
  await page.locator('[data-release-assets-reset]').click();
  await expect.poll(() => heldClear.routed.length).toBe(1);
  const clearRequest = requests.slice(beforeClear).find((r) => r.method === 'GET');
  expect(Object.fromEntries(clearRequest.url.searchParams)).toEqual({ view: 'list', pageSize: '10' });
  await expect(c.region).toHaveAttribute('aria-busy', 'true');
  await expectClearedDialog(page);
  await expectSize(page, '10');

  // Search typed while Clear is held composes with Clear only.
  const beforeSearch = requests.length;
  await page.locator('#asset-search').fill('asset-01');
  await settled(page);
  await expect.poll(() => params(page).search).toBe('asset-01');
  const searchRequests = requests.slice(beforeSearch).filter((r) => r.method === 'GET');
  expect(searchRequests.map((r) => intentOf(r.url.searchParams)))
    .toEqual([{ view: 'list', pageSize: '10', search: 'asset-01' }]);
  expect(pageIntent(page)).toEqual({ view: 'list', pageSize: '10', search: 'asset-01' });
  // asset-01 is not saved, so Selected assets matches nothing.
  expect(await regionAssetIds(page)).toEqual([]);
  await expect(c.rows).toHaveCount(0);
  await expect(page.locator('#asset-search')).toHaveValue('asset-01');
  await expect(page.locator('#release-asset-selection-option-selected')).toBeChecked();
  await expect(page.locator('#release-asset-extension-option-all')).toBeChecked();
  await expect(page.locator('#release-asset-category-option-all')).toBeChecked();
  expect(await dialogIntent(page)).toMatchObject({ search: 'asset-01', selection: 'selected', pageSize: '10', view: 'list' });

  // The original Clear answer arrives last and installs nothing.
  const searchedHref = page.url();
  heldClear.release();
  await heldClear.delivered();
  await page.waitForTimeout(300);
  expect(page.url()).toBe(searchedHref);
  await expect(page.locator('#asset-search')).toHaveValue('asset-01');
  await expect(c.rows).toHaveCount(0);
  await page.keyboard.press('Escape');

  // All assets shows the one asset-01 match; then Clear held -> Grid -> size.
  await chooseDialogOption(page, 'release-asset-selection-filter', 'All assets');
  await settled(page);
  await expect.poll(() => pageIntent(page)).toEqual({ view: 'list', pageSize: '10', search: 'asset-01', selection: 'all' });
  expect(await regionAssetIds(page)).toEqual([f.ids['asset-01.png']]);
  const heldClear2 = await holdRequests(page, f, isClearOf('10', 'list'));
  await page.locator('[data-release-assets-reset]').click();
  await expect.poll(() => heldClear2.routed.length).toBe(1);
  await expectClearedDialog(page);
  await page.keyboard.press('Escape');
  await expect(c.dialog).toBeHidden();
  await page.getByRole('link', { name: 'Grid view' }).click();
  await settled(page);
  await expect.poll(() => pageIntent(page)).toEqual({ pageSize: '10' });
  // Saved-selected: the three persisted assets (the draft lives client-side).
  await expect(c.region.locator('.asset-grid-item')).toHaveCount(3);
  await choosePaginationSize(page, '50');
  await settled(page);
  await expect.poll(() => pageIntent(page)).toEqual({ pageSize: '50' });
  heldClear2.release();
  await heldClear2.delivered();
  await page.waitForTimeout(300);
  await expect.poll(() => pageIntent(page)).toEqual({ pageSize: '50' });
  await expectSize(page, '50');
  await openFilters(page);
  await expectClearedDialog(page);
  await page.keyboard.press('Escape');
  expect(await draftMembership(page)).toEqual(draft);

  // Exactly one intentional Save; every navigation before it was a GET.
  expect(requests.filter((r) => r.method !== 'GET')).toEqual([]);
  expect(savedRows(f.releaseId)).toEqual(rowsBefore);
  await page.getByRole('button', { name: 'Save asset selection' }).click();
  await expect.poll(() => sorted(savedRows(f.releaseId).map((row) => row.asset_id))).toEqual(draft);
  const posts = requests.filter((r) => r.method === 'POST');
  expect(posts).toHaveLength(1);
  const posted = new URLSearchParams(posts[0].body).getAll('selectedAssetIds');
  expect(sorted(posted)).toEqual(draft);
  expect(new Set(posted).size).toBe(posted.length);
  const after = savedRows(f.releaseId);
  expect(after.find((row) => row.asset_id === f.ids['01-image.png']).role).toBe('primary');
  expect(after.slice(0, 2).map((row) => row.asset_id)).toEqual([f.ids['01-image.png'], f.ids['03-image.png']]);
  expect(pageErrors).toEqual([]);
});

test('R8: failed Clear -> Retry and Search; Clear held -> Category, View and page size keep the cleared filters', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createClearRelease('R8 Clear Failure');
  const requests = trackRequests(page, f.releaseId);
  const c = controls(page);
  const rowsBefore = savedRows(f.releaseId);
  const FILTERED = `${baseURL}${assetsPath(f)}?selection=all&search=asset&extension=md&view=list&pageSize=10`;
  const failNextClear = () => page.route(
    (url) => url.pathname === assetsPath(f) && isClearOf('10', 'list')(url.searchParams),
    (route) => route.abort('failed'), { times: 1 });
  const notice = page.locator('[data-live-filter-failure]');
  await page.goto(FILTERED);
  expect(await regionAssetIds(page)).toEqual([f.ids['asset-03.md']]);

  // A failed Clear keeps the results but stays the latest intent.
  await failNextClear();
  await openFilters(page);
  await page.locator('[data-release-assets-reset]').click();
  await expect(notice).toBeVisible();
  expect(await regionAssetIds(page)).toEqual([f.ids['asset-03.md']]);
  await expectClearedDialog(page);

  // Retry repeats only the Clear GET.
  const beforeRetry = requests.length;
  await notice.getByRole('button', { name: 'Retry' }).click();
  await settled(page);
  expect(requests.slice(beforeRetry).map((r) => [r.method, Object.fromEntries(r.url.searchParams)]))
    .toEqual([['GET', { view: 'list', pageSize: '10' }]]);
  await expect.poll(() => pageIntent(page)).toEqual({ view: 'list', pageSize: '10' });
  await page.keyboard.press('Escape');

  // Failed Clear -> Search: composes with Clear, not the installed filters.
  await page.goto(FILTERED);
  await failNextClear();
  await openFilters(page);
  await page.locator('[data-release-assets-reset]').click();
  await expect(notice).toBeVisible();
  await page.locator('#asset-search').fill('asset-0');
  await settled(page);
  await expect.poll(() => pageIntent(page)).toEqual({ view: 'list', pageSize: '10', search: 'asset-0' });
  await expect(notice).toHaveCount(0);
  expect(await regionAssetIds(page)).toEqual([]);
  await page.keyboard.press('Escape');

  // Clear held -> Category: only Category changes.
  await page.goto(FILTERED);
  const heldCategory = await holdRequests(page, f, isClearOf('10', 'list'));
  await openFilters(page);
  await page.locator('[data-release-assets-reset]').click();
  await expect.poll(() => heldCategory.routed.length).toBe(1);
  await chooseDialogOption(page, 'release-asset-category-filter', `WIP (${IMAGES.length + ASSET_IMAGES.length})`);
  await settled(page);
  await expect.poll(() => params(page).category).toBeDefined();
  const categorized = pageIntent(page);
  expect(categorized).toEqual({ view: 'list', pageSize: '10', category: categorized.category });
  await expect(c.meta).toHaveText(/3 selected assets match/);
  await page.keyboard.press('Escape');
  heldCategory.release();
  await heldCategory.delivered();

  // Clear held -> Grid.
  await page.goto(FILTERED);
  const heldView = await holdRequests(page, f, isClearOf('10', 'list'));
  await openFilters(page);
  await page.locator('[data-release-assets-reset]').click();
  await expect.poll(() => heldView.routed.length).toBe(1);
  await page.keyboard.press('Escape');
  await page.getByRole('link', { name: 'Grid view' }).click();
  await settled(page);
  await expect.poll(() => pageIntent(page)).toEqual({ pageSize: '10' });
  heldView.release();
  await heldView.delivered();

  // Clear held -> pagination size View All.
  await page.goto(FILTERED);
  const heldSize = await holdRequests(page, f, isClearOf('10', 'list'));
  await openFilters(page);
  await page.locator('[data-release-assets-reset]').click();
  await expect.poll(() => heldSize.routed.length).toBe(1);
  await page.keyboard.press('Escape');
  await choosePaginationSize(page, 'View All');
  await settled(page);
  await expect.poll(() => pageIntent(page)).toEqual({ view: 'list', pageSize: 'all' });
  await expect(c.meta).toHaveText(/3 selected assets match/);
  heldSize.release();
  await heldSize.delivered();
  await page.waitForTimeout(300);
  await expect.poll(() => pageIntent(page)).toEqual({ view: 'list', pageSize: 'all' });
  await expectSize(page, 'all');

  expect(requests.filter((r) => r.method !== 'GET')).toEqual([]);
  expect(savedRows(f.releaseId)).toEqual(rowsBefore);
  expect(pageErrors).toEqual([]);
});

test('R8: history - Clear pending -> Back owns the filters; Clear entry restored by Forward composes a Search', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createClearRelease('R8 Clear History');
  const requests = trackRequests(page, f.releaseId);
  const c = controls(page);
  const rowsBefore = savedRows(f.releaseId);
  await page.goto(`${baseURL}${assetsPath(f)}?selection=all&view=list&pageSize=10`);
  await openFilters(page);
  await page.locator('#asset-search').fill('asset');
  await settled(page);
  await expect.poll(() => params(page).search).toBe('asset');
  await chooseDialogOption(page, 'release-asset-extension-filter', '.md');
  await settled(page);
  const filteredIntent = { search: 'asset', extension: 'md', selection: 'all', view: 'list', pageSize: '10' };
  await expect.poll(() => pageIntent(page)).toEqual(filteredIntent);

  // Clear held -> Back: the history entry (Search=asset only) owns the dialog.
  const heldClear = await holdRequests(page, f, isClearOf('10', 'list'));
  await page.locator('[data-release-assets-reset]').click();
  await expect.poll(() => heldClear.routed.length).toBe(1);
  await expectClearedDialog(page);
  await page.goBack();
  await settled(page);
  const searchedIntent = { search: 'asset', selection: 'all', view: 'list', pageSize: '10' };
  await expect.poll(() => pageIntent(page)).toEqual(searchedIntent);
  await expect(page.locator('#asset-search')).toHaveValue('asset');
  await expect(page.locator('#release-asset-selection-option-all')).toBeChecked();
  await expect(page.locator('#release-asset-extension-option-all')).toBeChecked();
  heldClear.release();
  await heldClear.delivered();
  await page.waitForTimeout(300);
  await expect.poll(() => pageIntent(page)).toEqual(searchedIntent);

  // Forward to the filtered entry, then Clear installs: one history entry.
  await page.goForward();
  await settled(page);
  await expect.poll(() => pageIntent(page)).toEqual(filteredIntent);
  await page.locator('[data-release-assets-reset]').click();
  await settled(page);
  await expect.poll(() => pageIntent(page)).toEqual({ view: 'list', pageSize: '10' });
  const clearHref = page.url();
  await page.goBack();
  await settled(page);
  await expect.poll(() => pageIntent(page)).toEqual(filteredIntent);
  await expect(page.locator('#release-asset-extension-option-all')).not.toBeChecked();
  await page.goForward();
  await settled(page);
  expect(page.url()).toBe(clearHref);
  await expectClearedDialog(page);

  // A Search on the restored Clear entry composes with it only.
  await page.locator('#asset-search').fill('asset-01');
  await settled(page);
  await expect.poll(() => pageIntent(page)).toEqual({ view: 'list', pageSize: '10', search: 'asset-01' });
  await expect(c.rows).toHaveCount(0);
  await page.keyboard.press('Escape');

  expect(requests.filter((r) => r.method !== 'GET')).toEqual([]);
  expect(savedRows(f.releaseId)).toEqual(rowsBefore);
  expect(pageErrors).toEqual([]);
});

// P3 correction 4: an unsupported pageSize (7, 15, a repeated value, ...) used
// to query and render that many rows while both page-size controls showed 10,
// so the next Search could silently switch to 10. Only the supported sizes are
// honoured now; anything else is the default 25 for the query, the metadata,
// both controls and every navigation composed from it. The address of a
// direct load is not rewritten (no extra history entry); Back to it renders 25.
const effectiveIds = (f, query) => releaseService
  .getReleaseAssetManagementPage(f.releaseId, query).assetPage.map((asset) => String(asset.id));
const sizeOrDefault = (searchParams) => searchParams.get('pageSize') ?? '25';
const nextFrame = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));

for (const raw of ['7', '15']) {
  test(`P3-C4: direct pageSize=${raw} renders 25 on both controls; Search and history keep 25`, async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.setViewportSize({ width: 1280, height: 900 });
    const f = await createRelease(`C4 Direct ${raw}`, { extraImages: NEEDLES });
    const total = TOTAL + NEEDLES.length;
    const requests = trackRequests(page, f.releaseId);
    const c = controls(page);
    const firstPage = effectiveIds(f, { selection: 'all', pageSize: '25' });
    const secondPage = effectiveIds(f, { selection: 'all', pageSize: '25', page: '2' });
    expect(firstPage).toHaveLength(25);
    expect(secondPage).toHaveLength(total - 25);

    await page.goto(`${baseURL}${assetsPath(f)}?selection=all&pageSize=${raw}`);
    const historyLength = await page.evaluate(() => history.length);
    await expectSize(page, '25');
    await expect(c.rows).toHaveCount(25);
    expect(await regionAssetIds(page)).toEqual(firstPage);
    await expect(c.meta).toContainText(`${total} project assets match`);
    await expect(c.info).toHaveText('Page 1 of 2');
    // Generated links use the effective (implicit) 25, never the raw value.
    const next = new URL(await c.region.locator('.pagination-next').getAttribute('href'), baseURL);
    expect(Object.fromEntries(next.searchParams)).toEqual({ selection: 'all', page: '2' });
    for (const name of ['Grid view', 'List view']) {
      const href = new URL(await page.getByRole('link', { name }).getAttribute('href'), baseURL);
      expect(href.searchParams.has('pageSize'), name).toBe(false);
    }
    // The direct-load address is kept as is: no redirect, no extra entry.
    expect(params(page)).toEqual({ selection: 'all', pageSize: raw });
    expect(await page.evaluate(() => history.length)).toBe(historyLength);

    // Pagination keeps the effective 25.
    await c.region.locator('.pagination-next').click();
    await settled(page);
    await expect.poll(() => params(page)).toEqual({ selection: 'all', page: '2' });
    await expect(c.rows).toHaveCount(total - 25);
    expect(await regionAssetIds(page)).toEqual(secondPage);
    await expectSize(page, '25');

    // Search submits 25, not 10 and not the raw value.
    await openFilters(page);
    await page.locator('#asset-search').fill('needle');
    await settled(page);
    await expect.poll(() => params(page).search).toBe('needle');
    const searchRequest = requests.filter((r) => r.url.searchParams.get('search') === 'needle').at(-1);
    expect(sizeOrDefault(searchRequest.url.searchParams)).toBe('25');
    expect(sizeOrDefault(new URL(page.url()).searchParams)).toBe('25');
    await page.keyboard.press('Escape');
    await expect(c.rows).toHaveCount(NEEDLES.length);
    await expectSize(page, '25');

    // Back to the unsupported entry: still the effective 25 on both controls.
    await page.goBack();
    await settled(page);
    await expect.poll(() => params(page)).toEqual({ selection: 'all', page: '2' });
    await page.goBack();
    await settled(page);
    await expect.poll(() => params(page)).toEqual({ selection: 'all', pageSize: raw });
    await expectSize(page, '25');
    await expect(c.rows).toHaveCount(25);
    expect(await regionAssetIds(page)).toEqual(firstPage);

    // A later List link composes 25 with the restored entry.
    await page.getByRole('link', { name: 'List view' }).click();
    await settled(page);
    await expect.poll(() => params(page)).toEqual({ selection: 'all', view: 'list' });
    await expect(c.region.locator('.asset-list-item')).toHaveCount(25);
    await expectSize(page, '25');

    // Forward and Back again never restore the raw size.
    await page.goBack();
    await settled(page);
    await expect.poll(() => params(page).pageSize).toBe(raw);
    await expectSize(page, '25');
    await expect(c.rows).toHaveCount(25);

    expect(requests.filter((request) => request.method !== 'GET')).toEqual([]);
    expect(requests.filter((request) => request.method === 'GET' && request.url.searchParams.get('pageSize') === '10'))
      .toEqual([]);
    expect(pageErrors).toEqual([]);
  });
}

test('P3-C4: repeated, malformed and oversized sizes render 25; supported sizes and View All are kept', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createRelease('C4 Catalogue', { extraImages: NEEDLES });
  const total = TOTAL + NEEDLES.length;
  const c = controls(page);
  const firstPage = effectiveIds(f, { selection: 'all', pageSize: '25' });

  for (const query of ['pageSize=50&pageSize=10', 'pageSize=999999', 'pageSize=abc', 'pageSize=ALL', 'pageSize=010', 'pageSize=0']) {
    await page.goto(`${baseURL}${assetsPath(f)}?selection=all&${query}`);
    await expectSize(page, '25');
    await expect(c.rows, query).toHaveCount(25);
    expect(await regionAssetIds(page), query).toEqual(firstPage);
    await expect(c.info, query).toHaveText('Page 1 of 2');
  }
  for (const size of ['10', '25', '50', '100', '150', '200', 'all']) {
    await page.goto(`${baseURL}${assetsPath(f)}?selection=all&view=list&pageSize=${size}`);
    await expectSize(page, size);
    const expected = size === 'all' ? total : Math.min(Number(size), total);
    await expect(c.region.locator('.asset-list-item'), size).toHaveCount(expected);
    expect(await regionAssetIds(page), size).toEqual(effectiveIds(f, { selection: 'all', pageSize: size }));
  }
  expect(pageErrors).toEqual([]);
});

test('P3-C4: unsupported size -> held/superseded sizes, held Back -> List, failed Back -> Search, Clear, then Save once', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createRelease('C4 Draft', { extraImages: NEEDLES });
  const total = TOTAL + NEEDLES.length;
  const requests = trackRequests(page, f.releaseId);
  const c = controls(page);
  const rowsBefore = savedRows(f.releaseId);
  const checkbox = (name) => c.region.locator(`input[name="selectedAssetIds"][value="${f.ids[name]}"]`);

  await page.goto(`${baseURL}${assetsPath(f)}?selection=all&pageSize=15`);
  await expectSize(page, '25');
  await expect(c.rows).toHaveCount(25);

  // Draft: remove saved 02, add 05 and needle-01 (needle-01 is on page 2).
  await checkbox('02-image.png').uncheck({ force: true });
  await checkbox('05-image.png').check({ force: true });
  await c.region.locator('.pagination-next').click();
  await settled(page);
  await checkbox('needle-01.png').check({ force: true });
  const draft = sorted([f.ids['01-image.png'], f.ids['03-image.png'], f.ids['05-image.png'], f.ids['needle-01.png']]);
  expect(await draftMembership(page)).toEqual(draft);

  // A held 50 is superseded by the dialog's 100; the 50 answer arriving last installs nothing.
  const held50 = await holdRequests(page, f, sizeParam('50'));
  await choosePaginationSize(page, '50');
  await expect.poll(() => held50.routed.length).toBe(1);
  await expectSize(page, '50');
  await chooseDialogOption(page, 'release-asset-page-size-dropdown', '100');
  await settled(page);
  await page.keyboard.press('Escape');
  await expect.poll(() => params(page).pageSize).toBe('100');
  await expect(c.rows).toHaveCount(total);
  held50.release();
  await held50.delivered();
  await nextFrame(page);
  await expect.poll(() => params(page).pageSize).toBe('100');
  await expectSize(page, '100');
  await expect(c.rows).toHaveCount(total);

  // Pagination from the unsupported load already used the implicit 25. Back
  // to that page-2 entry is held; List composes the effective 25.
  const heldBack = await holdRequests(page, f,
    (sp) => !sp.has('pageSize') && sp.get('page') === '2' && sp.get('view') !== 'list');
  await page.goBack({ waitUntil: 'commit' });
  await expect.poll(() => heldBack.routed.length).toBe(1);
  await expectSize(page, '25');
  await page.getByRole('link', { name: 'List view' }).click();
  await settled(page);
  await expect.poll(() => params(page)).toEqual({ selection: 'all', view: 'list' });
  await expect(c.region.locator('.asset-list-item')).toHaveCount(25);
  await expectSize(page, '25');
  heldBack.release();
  await heldBack.delivered();
  await nextFrame(page);
  await expect.poll(() => params(page)).toEqual({ selection: 'all', view: 'list' });
  await expect(c.region.locator('.asset-list-item')).toHaveCount(25);
  expect(await draftMembership(page)).toEqual(draft);

  // Back to page 2, then a failed Back to the unsupported direct-load entry,
  // then Search: 25, never 15 or 100.
  await page.goBack();
  await settled(page);
  await expect.poll(() => params(page)).toEqual({ selection: 'all', page: '2' });
  await page.route((url) => url.pathname === assetsPath(f) && url.searchParams.get('pageSize') === '15',
    (route) => route.abort('failed'), { times: 1 });
  await page.goBack({ waitUntil: 'commit' });
  const notice = page.locator('[data-live-filter-failure]');
  await expect(notice).toBeVisible();
  await expectSize(page, '25');
  await openFilters(page);
  await page.locator('#asset-search').fill('needle');
  await settled(page);
  await expect.poll(() => params(page).search).toBe('needle');
  const searched = requests.filter((r) => r.url.searchParams.get('search') === 'needle').at(-1).url.searchParams;
  expect(sizeOrDefault(searched)).toBe('25');
  expect(searched.get('selection')).toBe('all');
  await page.keyboard.press('Escape');
  await expect(c.rows).toHaveCount(NEEDLES.length);
  await expectSize(page, '25');
  expect(await draftMembership(page)).toEqual(draft);

  // Clear keeps the effective 25 (implicit), not the raw 15.
  await openFilters(page);
  await page.locator('[data-release-assets-reset]').click();
  await settled(page);
  await page.keyboard.press('Escape');
  await expect.poll(() => sizeOrDefault(new URL(page.url()).searchParams)).toBe('25');
  expect(params(page).search).toBeUndefined();
  expect(params(page).selection).toBeUndefined();
  await expectSize(page, '25');
  expect(await draftMembership(page)).toEqual(draft);

  // View All is still honoured after all of that.
  await choosePaginationSize(page, 'View All');
  await settled(page);
  await expect.poll(() => params(page).pageSize).toBe('all');
  await expectSize(page, 'all');
  expect(await draftMembership(page)).toEqual(draft);

  // Nothing was saved along the way; Save posts the draft exactly once.
  expect(requests.filter((request) => request.method !== 'GET')).toEqual([]);
  expect(savedRows(f.releaseId)).toEqual(rowsBefore);
  await page.getByRole('button', { name: 'Save asset selection' }).click();
  await expect.poll(() => sorted(savedRows(f.releaseId).map((row) => row.asset_id))).toEqual(draft);
  const posts = requests.filter((request) => request.method === 'POST');
  expect(posts).toHaveLength(1);
  const posted = new URLSearchParams(posts[0].body).getAll('selectedAssetIds');
  expect(new Set(posted).size).toBe(posted.length);
  expect(sorted(posted)).toEqual(draft);
  const after = savedRows(f.releaseId);
  expect(after.find((row) => row.asset_id === f.ids['01-image.png']).role).toBe('primary');
  expect(after.find((row) => row.asset_id === f.ids['02-image.png'])).toBeUndefined();
  expect(after.slice(0, 2).map((row) => row.asset_id)).toEqual([f.ids['01-image.png'], f.ids['03-image.png']]);
  expect(pageErrors).toEqual([]);
});
