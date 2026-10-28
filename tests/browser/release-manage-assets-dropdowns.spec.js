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

// Release Manage Assets Role and Assets per page controls in real Chromium:
// the shared native-backed dropdowns post exactly one value for the intended
// asset, survive live-region replacement, and open unclipped at list edges.
// All data lives in a temporary root that is removed afterward.
const FILES = Array.from({ length: 14 }, (_, index) => `${String(index + 1).padStart(2, '0')}-image.png`);

let server;
let db;
let app;
let root;
let projectsRoot;
let baseURL;
let releaseService;

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-release-manage-dropdowns-'));
  projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  const viteDistRoot = path.join(root, 'client');
  const previewRoot = path.join(root, 'previews');
  fs.mkdirSync(projectsRoot);
  fs.mkdirSync(appDataRoot);
  fs.mkdirSync(previewRoot);
  await build({ build: { outDir: viteDistRoot }, logLevel: 'silent' });
  db = openDatabase(path.join(root, 'test.db'));
  runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
  const { csrfPepper } = ensureAuthEnablement(appDataRoot);
  app = createApp({ appName: 'CreatorCrate', db, projectsRoot, previewRoot }, {
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

// A draft release selecting every file, with the first as Primary.
async function createRelease(title) {
  const project = app.locals.projectService.create({ title, status: 'tbd' });
  const categories = app.locals.projectAssetCategoryService;
  if (!categories.list(project.id).some((candidate) => candidate.directory_slug === 'wip')) {
    categories.add(project.id, { displayName: 'WIP', directorySlug: 'wip' });
  }
  const categoryDir = path.join(projectsRoot, project.project_dir, 'wip');
  fs.mkdirSync(categoryDir, { recursive: true });
  for (const [index, filename] of FILES.entries()) {
    await sharp({ create: { width: 120, height: 40, channels: 3,
      background: { r: index * 15, g: 90, b: 160 } } }).png().toFile(path.join(categoryDir, filename));
  }
  app.locals.assetScanner.scanProjectAssets(project.id);
  const ids = Object.fromEntries(db.prepare('SELECT filename, id FROM assets WHERE project_id = ?')
    .all(project.id).map((row) => [row.filename, String(row.id)]));
  const release = releaseService.createReleaseWithSelectedAssets(project.id, { title: `${title} Release` },
    FILES.map((filename) => Number(ids[filename])));
  db.prepare('UPDATE release_assets SET role = ? WHERE release_id = ? AND asset_id = ?')
    .run('primary', release.id, Number(ids[FILES[0]]));
  return { releaseId: release.id, ids };
}

const savedRole = (releaseId, assetId) => db
  .prepare('SELECT role FROM release_assets WHERE release_id = ? AND asset_id = ?')
  .get(releaseId, Number(assetId)).role;

function roleRequests(page) {
  const requests = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/assets\/\d+\/role/.test(new URL(request.url()).pathname)) {
      requests.push({ path: new URL(request.url()).pathname, body: request.postData() });
    }
  });
  return requests;
}

async function chooseRole(page, assetId, label) {
  const dropdown = page.locator(`#release-asset-role-${assetId}`);
  await dropdown.locator('summary').click();
  await dropdown.locator('.asset-filter-multiselect-panel').getByText(label, { exact: true }).click();
  await expect(dropdown.locator('[data-cc-dropdown-summary-current]')).toHaveText(label);
}

// The open panel lies inside the viewport and is what the user hits there.
const panelReachable = (page, assetId) => page.evaluate((id) => {
  const panel = document.querySelector(`#release-asset-role-${id} .asset-filter-multiselect-panel`);
  const box = panel.getBoundingClientRect();
  const inside = box.top >= 0 && box.left >= 0
    && box.bottom <= window.innerHeight && box.right <= document.documentElement.clientWidth;
  const hit = document.elementFromPoint(box.left + box.width / 2, box.bottom - 6);
  return inside && box.height > 40 && panel.contains(hit);
}, assetId);

test('Release Manage Assets: Role dropdowns post one value per change for the intended asset', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createRelease('Manage Roles');
  const [first, second, third] = FILES.slice(0, 3).map((name) => f.ids[name]);
  await page.goto(`${baseURL}/releases/${f.releaseId}/assets?pageSize=10`);
  const requests = roleRequests(page);

  // Initial state: the visible trigger mirrors the hidden native select.
  await expect(page.locator(`#role-${first}`)).toBeHidden();
  await expect(page.locator(`#role-${first}`)).toHaveValue('primary');
  await expect(page.locator(`#release-asset-role-${first} [data-cc-dropdown-summary-current]`)).toHaveText('Primary');

  // Mouse: one POST to the chosen asset with only the token and its role.
  await chooseRole(page, second, 'Preview');
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].path).toBe(`/releases/${f.releaseId}/assets/${second}/role`);
  expect([...new URLSearchParams(requests[0].body).keys()]).toEqual(['_csrf', 'role']);
  expect(new URLSearchParams(requests[0].body).get('role')).toBe('preview');
  await expect.poll(() => savedRole(f.releaseId, second)).toBe('preview');
  await expect(page.locator(`#role-${first}`)).toHaveValue('primary');
  await expect(page.locator(`#release-asset-role-${second} summary`)).toBeFocused();

  // Keyboard on another row: open, step to Preview, select it.
  await page.locator(`#release-asset-role-${third} summary`).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Space');
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1].path).toBe(`/releases/${f.releaseId}/assets/${third}/role`);
  await expect.poll(() => savedRole(f.releaseId, third)).toBe('preview');

  // A failed save leaves the row editable: the next change posts once and persists.
  await page.route(`**/releases/${f.releaseId}/assets/${second}/role**`,
    (route) => route.fulfill({ status: 500, body: 'failed' }), { times: 1 });
  await chooseRole(page, second, 'Attachment');
  await expect.poll(() => requests.length).toBe(3);
  expect(savedRole(f.releaseId, second)).toBe('preview');
  await chooseRole(page, second, 'Primary');
  await expect.poll(() => requests.length).toBe(4);
  await expect.poll(() => savedRole(f.releaseId, second)).toBe('primary');

  // Live replacement (Next, then Previous) re-enhances once: one POST per change.
  const region = page.locator('[data-release-assets-live-region]');
  await region.locator('.pagination-next').click();
  await expect(page).toHaveURL(/page=2/);
  await region.locator('.pagination-prev').click();
  await expect(page.locator(`#release-asset-role-${second} [data-cc-dropdown-summary-current]`)).toHaveText('Primary');
  await chooseRole(page, first, 'Attachment');
  await expect.poll(() => requests.length).toBe(5);
  await page.waitForTimeout(300);
  expect(requests).toHaveLength(5);
  expect(requests[4].path).toBe(`/releases/${f.releaseId}/assets/${first}/role`);
  await expect.poll(() => savedRole(f.releaseId, first)).toBe('attachment');

  await page.reload();
  await expect(page.locator(`#role-${first}`)).toHaveValue('attachment');
  await expect(page.locator(`#role-${second}`)).toHaveValue('primary');
  expect(pageErrors).toEqual([]);
});

test('Release Manage Assets: Role panels open unclipped at list edges and page size keeps context', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const f = await createRelease('Manage Edges');
  const firstId = f.ids[FILES[0]];
  const lastOnPage = f.ids[FILES[9]];

  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    for (const view of ['grid', 'list']) {
      await page.goto(`${baseURL}/releases/${f.releaseId}/assets?view=${view}&pageSize=10`);
      for (const assetId of [firstId, lastOnPage]) {
        const dropdown = page.locator(`#release-asset-role-${assetId}`);
        await dropdown.locator('summary').scrollIntoViewIfNeeded();
        await dropdown.locator('summary').click();
        await expect(dropdown).toHaveAttribute('open', '');
        expect(await panelReachable(page, assetId)).toBe(true);
        await page.keyboard.press('Escape');
        await expect(dropdown).not.toHaveAttribute('open', '');
        await expect(dropdown.locator('summary')).toBeFocused();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth
        <= document.documentElement.clientWidth)).toBe(true);
    }
  }

  // Page size: one live request that keeps the search and view, then rows follow.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${baseURL}/releases/${f.releaseId}/assets?view=list&search=image&pageSize=10`);
  const region = page.locator('[data-release-assets-live-region]');
  await expect(region.locator('.asset-list-item')).toHaveCount(10);
  const loads = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === `/releases/${f.releaseId}/assets`) loads.push(url);
  });
  const pageSize = page.locator('#page-size-dropdown');
  await pageSize.locator('summary').click();
  await pageSize.locator('.asset-filter-multiselect-panel').getByText('25', { exact: true }).click();
  await expect(region.locator('.asset-list-item')).toHaveCount(14);
  expect(loads).toHaveLength(1);
  expect(Object.fromEntries(loads[0].searchParams)).toEqual({ pageSize: '25', search: 'image', view: 'list' });
  await expect(page).toHaveURL(/pageSize=25/);
  await expect(page.locator('#page-size-dropdown summary')).toBeFocused();
  await expect(page.locator('#pageSize')).toHaveValue('25');
  await expect(page.locator('#asset-page-size')).toHaveValue('25');
  expect(pageErrors).toEqual([]);
});
