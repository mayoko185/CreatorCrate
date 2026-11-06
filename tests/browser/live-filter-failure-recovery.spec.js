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

// A failed enhanced filter GET stays on the invoking document in real Chromium:
// results, requested controls and drafts survive, and Retry repeats only a GET.
// All data lives in a temporary root that is removed afterward.
const FILES = ['01-draft.png', '02-ref.jpg', '03-draft.png', '04-ref.jpg'];
const MONTH = '2031-07';

let server;
let db;
let app;
let root;
let projectsRoot;
let baseURL;
let fixture;

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-live-filter-failure-'));
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

  const project = app.locals.projectService.create({ title: 'Filter failure project', status: 'tbd' });
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
  const assetIds = db.prepare('SELECT id FROM assets WHERE project_id = ? ORDER BY filename').all(project.id).map((row) => row.id);
  const releaseService = createReleaseService({ db });
  const release = releaseService.createReleaseWithSelectedAssets(project.id, { title: 'Filter failure release' }, assetIds);
  db.prepare('UPDATE releases SET planned_date = ? WHERE id = ?').run(`${MONTH}-10`, release.id);
  fixture = { projectId: project.id, categoryId: category.id, categoryDir, releaseId: release.id, assetIds };
});

test.afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (db) closeDatabase(db);
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

// One permanent handler controls every enhanced GET to the page's own path.
async function controlNetwork(page, pathname) {
  const control = { mode: 'pass', requests: [], held: [], posts: [] };
  page.on('request', (request) => {
    if (request.method() !== 'GET') control.posts.push(request.url());
  });
  await page.route((url) => url.pathname === pathname, async (route) => {
    const request = route.request();
    if (request.resourceType() !== 'fetch') return route.fallback();
    control.requests.push({ method: request.method(), url: request.url() });
    if (control.mode === 'fail') return route.fulfill({ status: 500, contentType: 'text/html', body: 'failed' });
    if (control.mode === 'abort') return route.abort('connectionfailed');
    if (control.mode === 'malformed') return route.fulfill({ status: 200, contentType: 'text/html', body: '<p>nothing</p>' });
    if (control.mode === 'hold') {
      control.held.push(route);
      return undefined;
    }
    return route.continue();
  });
  return control;
}

async function openPage(page, url) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${baseURL}${url}`);
  await page.evaluate(() => { window.__sameDocument = true; });
  return errors;
}

async function expectSameDocument(page) {
  expect(await page.evaluate(() => window.__sameDocument)).toBe(true);
}

const markRegion = (region) => region.evaluate((node) => { node.dataset.installedBeforeFailure = 'true'; });
const notice = (page) => page.locator('[data-live-filter-failure]');
const retry = (page) => page.locator('[data-live-filter-retry]');

async function openDialog(page, id) {
  await page.locator(`[data-dialog-open="${id}"]`).first().click();
  await expect(page.locator(`#${id}`)).toBeVisible();
}

async function closeDialog(page, id) {
  const dialog = page.locator(`#${id}`);
  for (let attempt = 0; attempt < 3 && await dialog.isVisible(); attempt += 1) await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
}

// Chooses the first option not yet selected and returns its value and input.
async function chooseOther(page, dropdownId) {
  const dropdown = page.locator(`#${dropdownId}`);
  if (!(await dropdown.evaluate((node) => node.open))) await dropdown.locator('summary').click();
  const input = dropdown.locator('input[type="radio"]:not(:checked), input[type="checkbox"]:not(:checked)').first();
  const value = await input.getAttribute('value');
  await dropdown.locator('label').filter({ has: page.locator(`input[value="${value}"]`) }).first().click();
  return { value, input: dropdown.locator(`input[value="${value}"]`).first() };
}

// The shared contract: fail locally, keep everything, Retry with GET only.
async function failThenRetry(page, control, { dialogId, dropdownId, regionSelector }) {
  const region = page.locator(regionSelector);
  await markRegion(region);
  const startUrl = page.url();
  await openDialog(page, dialogId);

  control.mode = 'fail';
  const { value, input } = await chooseOther(page, dropdownId);
  await expect(notice(page)).toBeVisible();
  await expect(notice(page)).toContainText("couldn't");
  await expect(retry(page)).toHaveCount(1);
  await expectSameDocument(page);
  expect(page.url()).toBe(startUrl);
  await expect(region).toHaveAttribute('data-installed-before-failure', 'true');
  await expect(input).toBeChecked();

  const requested = control.requests.at(-1).url;
  expect(new URL(requested).search).toContain(value);
  control.mode = 'pass';
  const requestsBefore = control.requests.length;
  await retry(page).click();
  await expect(region).not.toHaveAttribute('data-installed-before-failure', 'true');
  await expect(notice(page)).toHaveCount(0);
  await expectSameDocument(page);
  expect(control.requests.slice(requestsBefore)).toEqual([{ method: 'GET', url: requested }]);
  expect(new URL(page.url()).search).toContain(value);
  await expect(page.locator(`#${dropdownId} input[value="${value}"]`).first()).toBeChecked();
  return { value };
}

test('A: Projects filter failure stays local, follows dialogs, and later filtering works', async ({ page }) => {
  const errors = await openPage(page, '/projects');
  const control = await controlNetwork(page, '/projects');
  const options = { dialogId: 'projects-filter-dialog', dropdownId: 'project-status-filter', regionSelector: '[data-projects-live-region]' };
  await failThenRetry(page, control, options);

  // Normal enhanced filtering resumes.
  const urlAfterRetry = page.url();
  await chooseOther(page, 'project-status-filter');
  await expect.poll(() => page.url()).not.toBe(urlAfterRetry);
  await expect(notice(page)).toHaveCount(0);

  // Retry follows the modal: inside while open, above the results once closed.
  control.mode = 'abort';
  await chooseOther(page, 'project-status-filter');
  await expect(page.locator('#projects-filter-dialog [data-live-filter-failure]')).toBeVisible();
  await expect(notice(page)).toHaveAttribute('role', 'alert');
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await closeDialog(page, 'projects-filter-dialog');
  await expect(page.locator('#projects-filter-dialog [data-live-filter-failure]')).toHaveCount(0);
  await expect(notice(page)).toBeVisible();
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
  await openDialog(page, 'projects-filter-dialog');
  await expect(page.locator('#projects-filter-dialog [data-live-filter-failure]')).toBeVisible();

  // Keyboard Retry that fails again refocuses the one new Retry.
  await retry(page).focus();
  await page.keyboard.press('Enter');
  await expect(retry(page)).toHaveCount(1);
  await expect(retry(page)).toBeFocused();
  control.mode = 'pass';
  await page.keyboard.press('Enter');
  await expect(notice(page)).toHaveCount(0);
  expect(await page.evaluate(() => document.querySelector('#projects-filter-dialog').contains(document.activeElement))).toBe(true);
  expect(control.requests.every((request) => request.method === 'GET')).toBe(true);
  expect(errors).toEqual([]);
});

test('B: Releases filter failure stays local and malformed responses do not install', async ({ page }) => {
  const errors = await openPage(page, '/releases');
  const control = await controlNetwork(page, '/releases');
  await failThenRetry(page, control, { dialogId: 'releases-filter-dialog', dropdownId: 'list-schedule', regionSelector: '[data-releases-live-region]' });

  const region = page.locator('[data-releases-live-region]');
  await markRegion(region);
  control.mode = 'malformed';
  await chooseOther(page, 'list-schedule');
  await expect(notice(page)).toBeVisible();
  await expect(region).toHaveAttribute('data-installed-before-failure', 'true');
  await expectSameDocument(page);
  expect(errors).toEqual([]);
});

test('C: Project Assets filter failure keeps selection and ordering drafts without any mutation', async ({ page }) => {
  const errors = await openPage(page, `/projects/${fixture.projectId}/assets?category=${fixture.categoryId}`);
  const control = await controlNetwork(page, `/projects/${fixture.projectId}/assets`);
  const filesBefore = fs.readdirSync(fixture.categoryDir).sort();
  const surface = page.locator('[data-auto-rename-surface]');
  const items = surface.locator('[data-auto-rename-asset]');
  const orderInput = page.locator('[data-auto-rename-order-input]');
  const selectionInput = page.locator('[data-auto-rename-selection-input]');

  await items.nth(0).locator('.asset-selection-control').click();
  await items.nth(0).dragTo(items.nth(2));
  await expect.poll(() => orderInput.inputValue()).not.toBe('');
  const order = await orderInput.inputValue();
  const selection = await selectionInput.inputValue();
  const scroll = await page.evaluate(() => window.scrollY);

  await markRegion(page.locator('[data-project-assets-live-region]'));
  // The drag leaves a hovered asset's information card over the toolbar.
  await page.mouse.move(0, 0);
  await openDialog(page, 'project-assets-filter-dialog');
  control.mode = 'fail';
  const { input } = await chooseOther(page, 'asset-extension-filter');
  await expect(notice(page)).toBeVisible();
  await expect(input).toBeChecked();
  await expectSameDocument(page);
  await expect(page.locator('[data-project-assets-live-region]')).toHaveAttribute('data-installed-before-failure', 'true');
  expect(await orderInput.inputValue()).toBe(order);
  expect(await selectionInput.inputValue()).toBe(selection);
  expect(await page.evaluate(() => window.scrollY)).toBe(scroll);

  control.mode = 'pass';
  const requested = control.requests.at(-1).url;
  await retry(page).click();
  await expect(notice(page)).toHaveCount(0);
  await expect.poll(() => page.url()).toBe(requested);
  await expect(input).toBeChecked();
  await expectSameDocument(page);
  expect(control.posts).toEqual([]);
  expect(fs.readdirSync(fixture.categoryDir).sort()).toEqual(filesBefore);
  expect(errors).toEqual([]);
});

test('D: Asset Viewer filter failure keeps the viewer and its display settings', async ({ page }) => {
  const errors = await openPage(page, '/asset-viewer?view=list');
  const control = await controlNetwork(page, '/asset-viewer');
  await failThenRetry(page, control, { dialogId: 'asset-viewer-filter-dialog', dropdownId: 'asset-category-filter', regionSelector: '[data-asset-library-live-region]' });
  expect(new URL(page.url()).searchParams.get('view')).toBe('list');
  expect(errors).toEqual([]);
});

test('E: Calendar filter failure keeps the grid and pending controls', async ({ page }) => {
  const errors = await openPage(page, `/calendar?month=${MONTH}`);
  const control = await controlNetwork(page, '/calendar');
  await failThenRetry(page, control, { dialogId: 'calendar-filter-dialog', dropdownId: 'calendar-status-filter', regionSelector: '[data-calendar-live-region]' });
  await expect(page.locator('[data-calendar-live-region]')).toHaveAttribute('data-calendar-month', MONTH);
  expect(errors).toEqual([]);
});

test('F: Choose month keeps a failed month pending, then Retry displays it with correct history', async ({ page }) => {
  const errors = await openPage(page, `/calendar?month=${MONTH}`);
  const control = await controlNetwork(page, '/calendar');
  const region = page.locator('[data-calendar-live-region]');
  const startUrl = page.url();
  const historyLength = await page.evaluate(() => window.history.length);

  await openDialog(page, 'calendar-month-dialog');
  control.mode = 'fail';
  await page.locator('#calendar-month-year').fill('2032');
  await page.locator('#calendar-month-year').press('Enter');
  await expect(page.locator('#calendar-month-dialog [data-live-filter-failure]')).toContainText('requested month');
  await expect(region).toHaveAttribute('data-calendar-month', MONTH);
  expect(page.url()).toBe(startUrl);

  await closeDialog(page, 'calendar-month-dialog');
  await expect(notice(page)).toBeVisible();
  await openDialog(page, 'calendar-month-dialog');
  await expect(page.locator('#calendar-month-year')).toHaveValue('2032');
  await expect(page.locator('#calendar-month-select input[value="07"]')).toBeChecked();

  control.mode = 'pass';
  await retry(page).click();
  await expect(page.locator('[data-calendar-live-region]')).toHaveAttribute('data-calendar-month', '2032-07');
  await expect(notice(page)).toHaveCount(0);
  await expectSameDocument(page);
  expect(new URL(page.url()).searchParams.get('month')).toBe('2032-07');
  expect(await page.evaluate(() => window.history.length)).toBe(historyLength + 1);
  expect(control.requests.every((request) => request.method === 'GET')).toBe(true);

  await closeDialog(page, 'calendar-month-dialog');
  await page.goBack();
  await expect(page.locator('[data-calendar-live-region]')).toHaveAttribute('data-calendar-month', MONTH);
  await expectSameDocument(page);
  expect(errors).toEqual([]);
});

test('G: Manage Release Assets filter failure keeps the membership draft and Retry never saves', async ({ page }) => {
  const errors = await openPage(page, `/releases/${fixture.releaseId}/assets`);
  const control = await controlNetwork(page, `/releases/${fixture.releaseId}/assets`);
  const checkbox = page.locator(`#release-asset-select-${fixture.assetIds[0]}`);
  await expect(checkbox).toBeChecked();
  await checkbox.evaluate((node) => node.click());
  await expect(checkbox).not.toBeChecked();

  await failThenRetry(page, control, { dialogId: 'release-assets-filter-dialog', dropdownId: 'release-asset-extension-filter', regionSelector: '[data-release-assets-live-region]' });
  const draftAfterRetry = page.locator(`input[name="selectedAssetIds"][value="${fixture.assetIds[0]}"]:checked, [data-release-assets-hidden-membership][value="${fixture.assetIds[0]}"]`);
  await expect(draftAfterRetry).toHaveCount(0);
  expect(control.posts).toEqual([]);
  const saved = db.prepare('SELECT COUNT(*) AS count FROM release_assets WHERE release_id = ?').get(fixture.releaseId).count;
  expect(saved).toBe(fixture.assetIds.length);
  expect(errors).toEqual([]);
});

test('H: only the newest request may install; stale responses and Retries cannot reset it', async ({ page }) => {
  const errors = await openPage(page, '/releases');
  const control = await controlNetwork(page, '/releases');
  await openDialog(page, 'releases-filter-dialog');

  // A fails, its Retry is kept, then B starts: the old Retry must do nothing.
  control.mode = 'fail';
  await chooseOther(page, 'list-schedule');
  await expect(retry(page)).toHaveCount(1);
  await retry(page).evaluate((node) => { window.__staleRetry = node; });

  control.mode = 'hold';
  await chooseOther(page, 'list-schedule');
  await expect.poll(() => control.held.length).toBe(1);
  await expect(notice(page)).toHaveCount(0);
  const requestsWithB = control.requests.length;
  await page.evaluate(() => window.__staleRetry.click());
  expect(control.requests.length).toBe(requestsWithB);

  // C supersedes held B; B is released afterward and must not install.
  const c = await chooseOther(page, 'list-schedule');
  await expect.poll(() => control.held.length).toBe(2);
  const [heldB, heldC] = control.held;
  await heldC.continue();
  await expect.poll(() => new URL(page.url()).searchParams.get('schedule')).toBe(c.value);
  await heldB.continue().catch(() => {});
  await page.waitForTimeout(150);
  expect(new URL(page.url()).searchParams.get('schedule')).toBe(c.value);
  await expect(page.locator(`#list-schedule input[value="${c.value}"]`)).toBeChecked();
  await page.evaluate(() => window.__staleRetry.click());
  expect(control.requests.length).toBe(requestsWithB + 1);
  await expect(notice(page)).toHaveCount(0);
  await expectSameDocument(page);
  expect(errors).toEqual([]);
});

test('I: a failed Back stays local and Retry loads the current history entry', async ({ page }) => {
  const errors = await openPage(page, '/projects');
  const control = await controlNetwork(page, '/projects');
  const region = page.locator('[data-projects-live-region]');
  const startUrl = page.url();

  await openDialog(page, 'projects-filter-dialog');
  await chooseOther(page, 'project-status-filter');
  await expect.poll(() => page.url()).not.toBe(startUrl);
  await closeDialog(page, 'projects-filter-dialog');
  const filteredUrl = page.url();
  const historyLength = await page.evaluate(() => window.history.length);

  await markRegion(region);
  control.mode = 'fail';
  await page.goBack();
  await expect(notice(page)).toContainText('may not match');
  await expectSameDocument(page);
  expect(page.url()).toBe(startUrl);
  await expect(region).toHaveAttribute('data-installed-before-failure', 'true');

  control.mode = 'pass';
  const requestsBefore = control.requests.length;
  await retry(page).click();
  await expect(notice(page)).toHaveCount(0);
  await expect(region).not.toHaveAttribute('data-installed-before-failure', 'true');
  expect(control.requests.slice(requestsBefore)).toEqual([{ method: 'GET', url: startUrl }]);
  expect(page.url()).toBe(startUrl);
  expect(await page.evaluate(() => window.history.length)).toBe(historyLength);

  await page.goForward();
  await expect.poll(() => page.url()).toBe(filteredUrl);
  await expect(notice(page)).toHaveCount(0);
  await expectSameDocument(page);
  expect(errors).toEqual([]);
});
