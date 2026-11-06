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

// WP10B: Remove missing assets on the invoking Project Assets page in real
// Chromium with the compiled client, the real route, templates, service,
// project lock and an isolated SQLite database. Every test records the
// removal POSTs, the read-only GETs, the database, document identity and URL.
// All data lives in a temporary root removed afterward.
const WIP = ['01-draft.png', '02-ref.png', '03-draft.png', '04-ref.png', '05-draft.png', '06-ref.png'];
const RENDERS = ['r1.png', 'r2.png'];

let server;
let db;
let app;
let root;
let projectsRoot;
let baseURL;
let serviceCalls = 0;
let proxy;

// WP10B-F1: an upstream gate between the browser and the app. A Remove
// missing assets POST that reaches it has fully arrived server-side (headers
// and body), but the route and service have not run until the gate releases
// it. holdNext holds that many next arrivals; every other request passes.
const gate = {
  holdNext: 0,
  arrivals: 0,
  held: [],
  release() { this.held.splice(0).forEach((forward) => forward()); },
};

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-remove-missing-'));
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
  // Counts how often the real service runs, whatever the browser saw.
  const service = app.locals.assetActionService;
  const removeMissingAssets = service.removeMissingAssets.bind(service);
  service.removeMissingAssets = (...args) => {
    serviceCalls += 1;
    return removeMissingAssets(...args);
  };
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const appPort = server.address().port;
  const forward = (req, body, res) => {
    const upstream = http.request({ host: '127.0.0.1', port: appPort, method: req.method, path: req.url, headers: req.headers }, (answer) => {
      res.writeHead(answer.statusCode, answer.headers);
      answer.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    upstream.end(body);
  };
  proxy = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (req.method === 'POST' && REMOVE_PATH.test(new URL(req.url, 'http://gate').pathname)) {
        gate.arrivals += 1;
        if (gate.holdNext > 0) {
          gate.holdNext -= 1;
          gate.held.push(() => forward(req, body, res));
          return;
        }
      }
      forward(req, body, res);
    });
  });
  proxy.listen(0, '127.0.0.1');
  await new Promise((resolve) => proxy.once('listening', resolve));
  baseURL = `http://127.0.0.1:${proxy.address().port}`;
});

test.beforeEach(() => {
  serviceCalls = 0;
  gate.holdNext = 0;
  gate.arrivals = 0;
  gate.held = [];
});

test.afterAll(async () => {
  gate.release();
  if (proxy) {
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
  }
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (db) closeDatabase(db);
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

async function writeImage(filePath, shade = 90) {
  await sharp({ create: { width: 12, height: 12, channels: 3, background: { r: shade, g: 90, b: 160 } } }).png().toFile(filePath);
}

async function createProject(title) {
  const project = app.locals.projectService.create({ title, status: 'tbd' });
  const categories = app.locals.projectAssetCategoryService;
  const ensure = (slug, name) => categories.list(project.id).find((c) => c.directory_slug === slug)
    || categories.add(project.id, { displayName: name, directorySlug: slug });
  const wip = ensure('wip', 'WIP');
  const renders = ensure('renders', 'Renders');
  const projectDir = path.join(projectsRoot, project.project_dir);
  for (const [slug, files] of [['wip', WIP], ['renders', RENDERS]]) {
    fs.mkdirSync(path.join(projectDir, slug), { recursive: true });
    for (const [index, filename] of files.entries()) await writeImage(path.join(projectDir, slug, filename), index * 30);
  }
  app.locals.assetScanner.scanProjectAssets(project.id);
  const ids = new Map(db.prepare('SELECT id, filename FROM assets WHERE project_id = ?').all(project.id)
    .map((row) => [row.filename, row.id]));
  const fileOf = (filename) => path.join(projectDir, RENDERS.includes(filename) ? 'renders' : 'wip', filename);
  return {
    id: project.id,
    wipId: wip.id,
    rendersId: renders.id,
    url: `/projects/${project.id}/assets`,
    assetId: (filename) => ids.get(filename),
    // A file deleted outside CreatorCrate and found missing by a real scan,
    // as another tab's or the scheduler's scan would.
    markMissing(...filenames) {
      filenames.forEach((filename) => fs.rmSync(fileOf(filename), { force: true }));
      app.locals.assetScanner.scanProjectAssets(project.id);
    },
    rows: () => db.prepare('SELECT id, is_present FROM assets WHERE project_id = ? ORDER BY id').all(project.id),
    missing: () => db.prepare('SELECT id FROM assets WHERE project_id = ? AND is_present = 0 ORDER BY id').all(project.id).map((r) => r.id),
    exists: (id) => Boolean(db.prepare('SELECT 1 FROM assets WHERE id = ?').get(id)),
    filesOnDisk: () => [...fs.readdirSync(path.join(projectDir, 'wip')), ...fs.readdirSync(path.join(projectDir, 'renders'))].sort(),
  };
}

function publish(projectId, assetIds) {
  const releaseId = db.prepare(`
    INSERT INTO releases (project_id, title, description, notes, planned_date, published_date, patreon_url)
    VALUES (?, 'Published', '', '', NULL, '2026-08-05', NULL) RETURNING id
  `).get(projectId).id;
  assetIds.forEach((assetId, index) => db.prepare(
    "INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, 'attachment', ?)",
  ).run(releaseId, assetId, index));
  return releaseId;
}

const REMOVE_PATH = /^\/projects\/\d+\/assets\/remove-missing$/;

// control.get: 'pass' | 'fail' | 'hold' for Project Assets refresh GETs.
// control.post: 'pass' | 'hold' | 'lose' | 'corrupt' | 'gate' for the removal
// POST; lose/corrupt let the real request reach the server first. gate sends
// the real request on to the upstream gate and, once it has arrived there,
// fails the browser's fetch: the request stays alive upstream while the page
// loses its answer. control.upstream keeps each gated request's own answer.
async function open(page, url) {
  const control = { get: 'pass', post: 'pass', gets: [], heldGets: [], posts: [], heldPosts: [], otherPosts: [], upstream: [], navigations: 0 };
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.method() === 'GET') return;
    if (REMOVE_PATH.test(new URL(request.url()).pathname)) control.posts.push(request);
    else control.otherPosts.push(request.url());
  });
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) control.navigations += 1; });
  await page.route((target) => /^\/projects\/\d+\/assets$/.test(target.pathname), async (route) => {
    const request = route.request();
    if (request.resourceType() !== 'fetch' || request.method() !== 'GET') return route.fallback();
    control.gets.push(request.url());
    if (control.get === 'fail') return route.fulfill({ status: 500, contentType: 'text/html', body: 'failed' });
    if (control.get === 'hold') { control.heldGets.push(route); return undefined; }
    return route.continue();
  });
  await page.route((target) => REMOVE_PATH.test(target.pathname), async (route) => {
    if (control.post === 'hold') { control.heldPosts.push(route); return undefined; }
    if (control.post === 'gate') {
      const arrivals = gate.arrivals;
      control.upstream.push(route.fetch({ timeout: 0, maxRetries: 0 })
        .then(async (response) => ({ status: response.status(), body: await response.json().catch(() => null) }))
        .catch((error) => ({ error: error.message })));
      for (let wait = 0; gate.arrivals === arrivals && wait < 200; wait += 1) await new Promise((resolve) => setTimeout(resolve, 25));
      return route.abort('failed');
    }
    if (control.post === 'lose' || control.post === 'corrupt') {
      const response = await route.fetch();
      await response.body().catch(() => null);
      if (control.post === 'lose') return route.abort('failed');
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"succ' });
    }
    return route.continue();
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${baseURL}${url}`);
  control.navigations = 0;
  await page.evaluate(() => { window.__sameDocument = true; });
  return { control, errors };
}

const dialog = (page) => page.locator('#remove-missing-assets-dialog');
const trigger = (page) => page.locator('[data-dialog-open="remove-missing-assets-dialog"]');
const confirmButton = (page) => dialog(page).locator('[data-dialog-submit]');
const feedback = (page) => page.locator('[data-dialog-feedback]');
const feedbackText = (page) => page.locator('[data-dialog-feedback-text]');
const pending = (page) => page.locator('[data-remove-missing-pending]');
const pendingText = (page) => page.locator('[data-remove-missing-pending-text]');
const checkAgain = (page) => page.locator('[data-remove-missing-pending-check]');
const region = (page) => page.locator('[data-project-assets-live-region]');
const surface = (page) => page.locator('[data-auto-rename-surface]');
const item = (page, name) => surface(page).locator(`[data-auto-rename-asset][aria-label="Reorder ${name}"]`);
const orderValue = async (page) => JSON.parse(await page.locator('[data-auto-rename-order-input]').inputValue());
const savedOrder = async (page) => JSON.parse(await surface(page).getAttribute('data-auto-rename-base-order'));
const box = (page, id) => page.locator(`input[name="selectedAssetIds"][value="${id}"]`);
const retry = (page) => page.locator('[data-live-filter-retry]');
const statusText = (page) => page.locator('[data-project-assets-live-status]');
const KEPT_MESSAGE = 'Your unsaved category order was kept, but it cannot be shown in this view.';

async function markRegion(page) {
  await region(page).evaluate((node) => { node.dataset.beforeRefresh = 'true'; });
}

async function expectInstalled(page) {
  await expect(page.locator('[data-project-assets-live-region]:not([data-before-refresh])')).toHaveCount(1);
  await expect(region(page)).not.toHaveAttribute('aria-busy', 'true');
}

async function expectSameDocument(page, url) {
  expect(await page.evaluate(() => window.__sameDocument)).toBe(true);
  expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(url);
}

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

async function searched(page, value) {
  await markRegion(page);
  await page.locator('#search').evaluate((input, next) => {
    input.value = next;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
  await expectInstalled(page);
}

async function openConfirmation(page) {
  await trigger(page).click();
  await expect(dialog(page)).toBeVisible();
}

async function confirm(page) {
  await openConfirmation(page);
  await markRegion(page);
  await confirmButton(page).click();
}

test('A: the confirmation is local; Cancel, Close, Escape and the backdrop send nothing and keep the page', async ({ page }) => {
  const f = await createProject('Remove Missing A');
  f.markMissing('02-ref.png');
  const url = `${f.url}?category=${f.wipId}`;
  const { control, errors } = await open(page, url);
  const [a, , c, d, e, g] = WIP.map(f.assetId);
  const b = f.assetId('02-ref.png');
  await moveBefore(page, '03-draft.png');
  const draft = await orderValue(page);
  expect(draft).toEqual([a, c, b, d, e, g]);
  await select(page, d);

  await openConfirmation(page);
  await expect(dialog(page)).toContainText('This applies to every asset record in Remove Missing A that is marked missing when the removal is processed, including any hidden by the current filters or category.');
  await expect(dialog(page)).toContainText('A scan or another change may mark more records missing, or fewer, between now and then.');
  await expect(dialog(page)).not.toContainText('when you confirm');
  await expect(dialog(page)).toContainText('Missing assets protected by published-release rules will remain.');
  await expect(dialog(page)).toContainText('No files are deleted.');
  await dialog(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog(page)).toBeHidden();
  await expect(trigger(page)).toBeFocused();

  await openConfirmation(page);
  await dialog(page).getByRole('button', { name: 'Close Remove missing assets' }).click();
  await expect(dialog(page)).toBeHidden();

  await openConfirmation(page);
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  await expect(trigger(page)).toBeFocused();

  await openConfirmation(page);
  await page.mouse.click(8, 8);
  await expect(dialog(page)).toBeHidden();

  expect(control.posts).toHaveLength(0);
  expect(control.gets).toHaveLength(0);
  expect(serviceCalls).toBe(0);
  expect(f.missing()).toEqual([b]);
  expect(await orderValue(page)).toEqual(draft);
  await expect(box(page, d)).toBeChecked();
  await expectSameDocument(page, url);
  expect(control.navigations).toBe(0);
  expect(errors).toEqual([]);
});

test('B: confirming removes every eligible missing record with one POST, in place, and refreshes counts', async ({ page }) => {
  const f = await createProject('Remove Missing B');
  f.markMissing('02-ref.png', '04-ref.png', 'r1.png');
  const removed = ['02-ref.png', '04-ref.png', 'r1.png'].map(f.assetId);
  const url = `${f.url}?category=${f.wipId}&view=list`;
  const { control, errors } = await open(page, url);
  const before = f.filesOnDisk();
  await expect(page.locator('#asset-category-filter summary')).toContainText(`WIP (${WIP.length})`);

  await openConfirmation(page);
  const scrollY = await page.evaluate(() => window.scrollY);
  await markRegion(page);
  await confirmButton(page).click();
  await expectInstalled(page);
  await expect(feedbackText(page)).toHaveText('Removed 3 of 3 missing asset records. No files were deleted.');
  await expect(feedback(page)).toHaveClass(/notice--success/);

  expect(control.posts).toHaveLength(1);
  expect(control.posts[0].headers().accept).toContain('application/json');
  expect(serviceCalls).toBe(1);
  removed.forEach((id) => expect(f.exists(id)).toBe(false));
  expect(f.rows()).toHaveLength(WIP.length + RENDERS.length - 3);
  expect(f.missing()).toEqual([]);
  expect(f.filesOnDisk()).toEqual(before);
  await expect(trigger(page)).toHaveCount(0);
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator('#asset-category-filter summary')).toContainText(`WIP (${WIP.length - 2})`);
  await expect(page.locator('[data-selected-count]')).toHaveText(`0 of ${WIP.length - 2} selected`);
  await expect(page.locator('.asset-list-card, [data-asset-id]').first()).toBeVisible();
  // Focus leaves the removed trigger for the heading, never the body.
  expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
  expect(Math.abs((await page.evaluate(() => window.scrollY)) - scrollY)).toBeLessThanOrEqual(1);
  await expectSameDocument(page, url);
  expect(control.navigations).toBe(0);
  expect(control.otherPosts).toEqual([]);
  expect(errors).toEqual([]);
});

test('exactly one POST: double click, Enter, requestSubmit and dismissal while pending', async ({ page }) => {
  const f = await createProject('Remove Missing Once');
  f.markMissing('02-ref.png');
  const { control, errors } = await open(page, f.url);
  control.post = 'hold';
  await openConfirmation(page);
  await confirmButton(page).dblclick();
  await expect.poll(() => control.heldPosts.length).toBe(1);
  await page.keyboard.press('Enter');
  await page.evaluate(() => {
    const form = document.getElementById('remove-missing-assets-form');
    form.requestSubmit();
    form.requestSubmit();
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  });
  // The confirmation stays while its result is unknown.
  await page.keyboard.press('Escape');
  await dialog(page).getByRole('button', { name: 'Cancel' }).click({ force: true });
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).locator('[data-dialog-status]')).toHaveText('Removing missing asset records…');
  expect(control.posts).toHaveLength(1);

  control.post = 'pass';
  await control.heldPosts[0].continue();
  await expect(feedbackText(page)).toHaveText('Removed 1 of 1 missing asset record. No files were deleted.');
  await expect(dialog(page)).toHaveCount(0);
  expect(control.posts).toHaveLength(1);
  expect(serviceCalls).toBe(1);
  await expectSameDocument(page, f.url);
  expect(errors).toEqual([]);
});

test('C: hidden missing records are in scope; held and shown order drafts are reconciled, never resurrected', async ({ page }) => {
  const f = await createProject('Remove Missing C');
  // Missing when the page loads, so the action is offered.
  f.markMissing('r1.png');
  const url = `${f.url}?category=${f.wipId}&search=draft`;
  const { control, errors } = await open(page, url);
  const [a, b, c, d, e, g] = WIP.map(f.assetId);
  await moveBefore(page, '03-draft.png');
  const draft = await orderValue(page);
  expect(draft).toEqual([c, b, a, d, e, g]);
  // Missing elsewhere after the page loaded: one shown, one hidden by search,
  // one in another category.
  f.markMissing('05-draft.png', '04-ref.png', 'r2.png');

  await confirm(page);
  await expectInstalled(page);
  await expect(feedbackText(page)).toHaveText('Removed 4 of 4 missing asset records. No files were deleted.');
  expect([e, d, f.assetId('r1.png'), f.assetId('r2.png')].map(f.exists)).toEqual([false, false, false, false]);
  expect(f.missing()).toEqual([]);
  await expectSameDocument(page, url);

  // The shown draft keeps its order around the surviving hidden positions.
  expect(await orderValue(page)).toEqual([c, b, a, g]);
  expect(await savedOrder(page)).toEqual([a, b, c, g]);
  await expect(surface(page)).toHaveAttribute('data-auto-rename-draft', 'true');
  // Held through a view that cannot show it, and back without the removed ids.
  await searched(page, 'nothing-matches');
  await expect(statusText(page)).toHaveText(KEPT_MESSAGE);
  await searched(page, 'draft');
  expect(await orderValue(page)).toEqual([c, b, a, g]);
  expect(await savedOrder(page)).toEqual([a, b, c, g]);
  await expect(surface(page)).toHaveAttribute('data-auto-rename-draft', 'true');

  expect(control.posts).toHaveLength(1);
  expect(control.otherPosts).toEqual([]);
  expect(await page.evaluate(() => window.__sameDocument)).toBe(true);
  expect(errors).toEqual([]);
});

test('D: published-release records stay; feedback and counts say exactly what happened', async ({ page }) => {
  const f = await createProject('Remove Missing D');
  f.markMissing('02-ref.png', '04-ref.png', '06-ref.png');
  const [b, d, g] = ['02-ref.png', '04-ref.png', '06-ref.png'].map(f.assetId);
  publish(f.id, [d]);
  const { control, errors } = await open(page, `${f.url}?category=${f.wipId}`);

  await confirm(page);
  await expectInstalled(page);
  await expect(feedbackText(page)).toHaveText('Removed 2 of 3 missing asset records. No files were deleted. Kept 1 missing asset record protected by published-release rules.');
  expect(f.missing()).toEqual([d]);
  expect([b, g].map(f.exists)).toEqual([false, false]);
  await expect(trigger(page)).toHaveCount(1);
  await expect(page.locator('#asset-category-filter summary')).toContainText(`WIP (${WIP.length - 2})`);

  // Only protected ones left: a non-removal, not a success.
  await confirm(page);
  await expectInstalled(page);
  await expect(feedbackText(page)).toHaveText('Nothing was removed: 1 missing asset record is protected by published-release rules and was kept.');
  await expect(feedback(page)).toHaveClass(/notice--warning/);
  expect(f.missing()).toEqual([d]);
  expect(control.posts).toHaveLength(2);
  expect(serviceCalls).toBe(2);
  await expectSameDocument(page, `${f.url}?category=${f.wipId}`);
  expect(errors).toEqual([]);
});

test('E: nothing left to remove (another tab removed them) is a clear no-op in place', async ({ page }) => {
  const f = await createProject('Remove Missing E');
  f.markMissing('02-ref.png');
  const { control, errors } = await open(page, f.url);
  app.locals.assetActionService.removeMissingAssets(f.id);
  serviceCalls = 0;
  const rows = f.rows();

  await confirm(page);
  await expectInstalled(page);
  await expect(feedbackText(page)).toHaveText('No asset records were marked missing, so nothing was removed.');
  await expect(trigger(page)).toHaveCount(0);
  expect(f.rows()).toEqual(rows);
  expect(control.posts).toHaveLength(1);
  expect(serviceCalls).toBe(1);
  await expectSameDocument(page, f.url);
  expect(control.navigations).toBe(0);
  expect(errors).toEqual([]);
});

test('F: a confirmed removal whose refresh fails stays confirmed; Retry refresh is GET only', async ({ page }) => {
  const f = await createProject('Remove Missing F');
  f.markMissing('02-ref.png', '04-ref.png');
  const url = `${f.url}?category=${f.wipId}&search=ref`;
  const { control, errors } = await open(page, url);
  const shown = await region(page).locator('[data-asset-id]').count();
  control.get = 'fail';

  await confirm(page);
  await expect(feedbackText(page)).toHaveText('Removed 2 of 2 missing asset records. No files were deleted. Project Assets could not refresh and may be outdated. Use Retry refresh to load the current assets.');
  await expect(feedback(page)).toHaveClass(/notice--warning/);
  await expect(retry(page)).toBeVisible();
  // The stale view stays as it was, filtered, not replaced.
  await expect(page.locator('[data-project-assets-live-region][data-before-refresh]')).toHaveCount(1);
  expect(await region(page).locator('[data-asset-id]').count()).toBe(shown);
  expect(f.missing()).toEqual([]);
  const getsAfterFailure = control.gets.length;
  expect(getsAfterFailure).toBeGreaterThanOrEqual(1);

  control.get = 'pass';
  await retry(page).click();
  await expectInstalled(page);
  await expect(feedbackText(page)).toHaveText('Removed 2 of 2 missing asset records. No files were deleted.');
  expect(control.gets.length).toBe(getsAfterFailure + 1);
  expect(new URL(control.gets.at(-1)).searchParams.get('search')).toBe('ref');
  expect(control.posts).toHaveLength(1);
  expect(serviceCalls).toBe(1);
  await expect(trigger(page)).toHaveCount(0);
  await expect(region(page).locator('[data-asset-id]')).toHaveCount(1);
  await expectSameDocument(page, url);
  expect(errors).toEqual([]);
});

for (const mode of ['lose', 'corrupt']) {
  test(`G: a ${mode === 'lose' ? 'lost' : 'corrupt'} answer is never re-sent; Check again only reads`, async ({ page }) => {
    const f = await createProject(`Remove Missing G ${mode}`);
    f.markMissing('02-ref.png', '04-ref.png');
    const url = `${f.url}?category=${f.wipId}`;
    const { control, errors } = await open(page, url);
    const keep = f.assetId('01-draft.png');
    await select(page, keep);
    await moveBefore(page, '03-draft.png');
    const draft = await orderValue(page);
    control.post = mode;
    control.get = 'fail';

    await confirm(page);
    await expect(dialog(page)).toBeHidden();
    await expect(pending(page)).toBeVisible();
    await expect(pendingText(page)).toContainText('Could not load Project Assets.');
    await expect(pendingText(page)).toContainText('The result of the earlier Remove missing assets request is still unknown.');
    await expect(pendingText(page)).toContainText('The earlier request was not sent again and may still be processed');
    await expect(checkAgain(page)).toBeVisible();
    await expect(feedback(page)).toBeHidden();
    expect(serviceCalls).toBe(1);
    // The request did run on the server; the page does not claim either way.
    expect(f.missing()).toEqual([]);

    // While unresolved, a reopened confirmation cannot send.
    await openConfirmation(page);
    await expect(dialog(page)).toContainText('another removal cannot be sent from this page');
    await expect(confirmButton(page)).toBeDisabled();
    await confirmButton(page).click({ force: true });
    await page.evaluate(() => document.getElementById('remove-missing-assets-form').requestSubmit());
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
    expect(control.posts).toHaveLength(1);

    control.get = 'pass';
    const gets = control.gets.length;
    await markRegion(page);
    await checkAgain(page).click();
    await expectInstalled(page);
    await expect(pendingText(page)).toContainText('with no missing asset records. That read does not show which request, scan or other change removed them.');
    await expect(pendingText(page)).toContainText('still unknown');
    // WP10B-F1: the read is an observation; the hold and Check again stay.
    await expect(checkAgain(page)).toBeVisible();
    await expect(checkAgain(page)).toBeFocused();
    await expect(feedback(page)).toBeHidden();
    expect(control.gets.length).toBe(gets + 1);
    expect(control.posts).toHaveLength(1);
    expect(serviceCalls).toBe(1);
    await expect(trigger(page)).toHaveCount(0);
    await expect(box(page, keep)).toBeChecked();
    expect(await orderValue(page)).toEqual(draft.filter((id) => f.exists(id)));
    await expectSameDocument(page, url);
    expect(control.navigations).toBe(0);
    expect(errors).toEqual([]);
  });
}

// WP10B-F1: a completed read-only GET shows what Project Assets holds now. It
// is no evidence that a submitted removal finished, failed or can no longer
// run, so it never releases the page's hold on that removal.
async function expectRemovalBlocked(page) {
  await openConfirmation(page);
  await expect(confirmButton(page)).toBeDisabled();
  await expect(dialog(page)).toContainText('It may still be processed, so another removal cannot be sent from this page.');
  // Clicking, Enter, requestSubmit and a replayed submit all reach the gate.
  await confirmButton(page).click({ force: true });
  await confirmButton(page).dblclick({ force: true });
  await page.evaluate(() => {
    const form = document.getElementById('remove-missing-assets-form');
    form.requestSubmit();
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  });
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
}

async function expectUnresolvedNotice(page) {
  await expect(pending(page)).toBeVisible();
  await expect(pendingText(page)).toContainText('The result of the earlier Remove missing assets request is still unknown.');
  await expect(pendingText(page)).toContainText('may still be processed, so Remove missing assets stays unavailable on this page.');
  await expect(feedback(page)).toBeHidden();
  await expect(page.locator('body')).not.toContainText(/Removed \d+ of \d+ missing/);
}

async function checkAgainReadsOnly(page, control) {
  const gets = control.gets.length;
  const posts = control.posts.length;
  await markRegion(page);
  await checkAgain(page).click();
  await expectInstalled(page);
  expect(control.gets.length).toBe(gets + 1);
  expect(control.posts.length).toBe(posts);
}

test('B1 (WP10B-F1): an early read never unlocks a second removal while the original POST is held upstream', async ({ page }) => {
  const f = await createProject('Remove Missing F1 B1');
  f.markMissing('02-ref.png', '06-ref.png');
  const a = f.assetId('02-ref.png');
  const b = f.assetId('04-ref.png');
  const p = f.assetId('06-ref.png');
  publish(f.id, [p]);
  const url = `${f.url}?category=${f.wipId}`;
  const { control, errors } = await open(page, url);
  expect(f.missing()).toEqual([a, p]);

  // 1-5. The original POST reaches the upstream gate and is held there before
  // the route runs; the browser's fetch then fails.
  gate.holdNext = 1;
  control.post = 'gate';
  await confirm(page);
  await expect(pending(page)).toBeVisible();
  expect(gate.arrivals).toBe(1);
  expect(gate.held).toHaveLength(1);
  expect(serviceCalls).toBe(0);
  // Any later removal POST would pass straight through to the service.
  control.post = 'pass';

  // 6-7. The early read installs and still shows A missing.
  await expectInstalled(page);
  expect(control.gets).toHaveLength(1);
  expect(f.missing()).toEqual([a, p]);
  await expect(trigger(page)).toHaveCount(1);
  await expect(pendingText(page)).toContainText('some are still marked missing. That read does not show whether the earlier request arrived, finished or failed.');
  await expectUnresolvedNotice(page);
  await expect(checkAgain(page)).toBeVisible();

  // 8. Another removal is attempted every way the page allows.
  await expectRemovalBlocked(page);
  await checkAgainReadsOnly(page, control);
  await expectRemovalBlocked(page);
  await checkAgainReadsOnly(page, control);
  expect(control.posts).toHaveLength(1);
  expect(gate.arrivals).toBe(1);
  expect(serviceCalls).toBe(0);
  expect(f.missing()).toEqual([a, p]);
  await expectUnresolvedNotice(page);
  await expectSameDocument(page, url);

  // 9. A real scan marks B missing while the original is still upstream.
  f.markMissing('04-ref.png');
  expect(f.missing()).toEqual([a, b, p]);
  const filesBefore = f.filesOnDisk();

  // 10-11. The original request is released and runs once, with the
  // service's execution-time scope.
  gate.release();
  const original = await control.upstream[0];
  expect(original.status).toBe(200);
  expect(original.body).toMatchObject({ status: 'success', outcome: 'removed', protectedAssetIds: [p] });
  expect([...original.body.removedAssetIds].sort((x, y) => x - y)).toEqual([a, b]);
  expect(serviceCalls).toBe(1);
  expect([a, b].map(f.exists)).toEqual([false, false]);
  expect(f.missing()).toEqual([p]);
  expect(f.filesOnDisk()).toEqual(filesBefore);

  // 12. No other removal was ever sent; the page never claims the result.
  expect(control.posts).toHaveLength(1);
  expect(gate.arrivals).toBe(1);
  await expectUnresolvedNotice(page);
  await expectSameDocument(page, url);
  expect(control.navigations).toBe(0);
  expect(control.otherPosts).toEqual([]);
  console.log(`[WP10B-F1 B1] A=${a} B=${b} protected=${p} removalPosts=${control.posts.length} upstreamArrivals=${gate.arrivals} serviceCalls=${serviceCalls} gets=${control.gets.length} removed=${JSON.stringify(original.body.removedAssetIds)} remainingMissing=${JSON.stringify(f.missing())}`);
  expect(errors).toEqual([]);
});

test('B2 (WP10B-F1): a read showing no missing rows attributes nothing and keeps the hold, even for a reinserted confirmation', async ({ page }) => {
  const f = await createProject('Remove Missing F1 B2');
  f.markMissing('02-ref.png');
  const a = f.assetId('02-ref.png');
  const b = f.assetId('04-ref.png');
  const url = `${f.url}?category=${f.wipId}`;
  const { control, errors } = await open(page, url);
  gate.holdNext = 1;
  control.post = 'gate';
  control.get = 'hold';
  await confirm(page);
  await expect.poll(() => control.heldGets.length).toBe(1);
  control.post = 'pass';
  expect(serviceCalls).toBe(0);
  // Another tab removes the missing record before the read answers.
  app.locals.assetActionService.removeMissingAssets(f.id);
  expect(f.exists(a)).toBe(false);
  control.get = 'pass';
  await control.heldGets.shift().continue();
  await expectInstalled(page);
  await expect(trigger(page)).toHaveCount(0);
  await expect(pendingText(page)).toContainText('with no missing asset records. That read does not show which request, scan or other change removed them.');
  await expectUnresolvedNotice(page);
  await expect(checkAgain(page)).toBeVisible();

  // A scan finds B missing; a GET-only refresh brings back the action and a
  // freshly rendered confirmation, which is bound blocked.
  f.markMissing('04-ref.png');
  await markRegion(page);
  await page.evaluate(() => document.dispatchEvent(new Event('project-asset-categories-changed')));
  await expectInstalled(page);
  await expect(trigger(page)).toHaveCount(1);
  await expectRemovalBlocked(page);
  expect(control.posts).toHaveLength(1);
  expect(gate.arrivals).toBe(1);
  // Only the other tab's call ran so far.
  expect(serviceCalls).toBe(1);

  gate.release();
  const original = await control.upstream[0];
  expect(original.body).toMatchObject({ status: 'success', outcome: 'removed', removedAssetIds: [b] });
  expect(serviceCalls).toBe(2);
  expect(f.missing()).toEqual([]);
  expect(control.posts).toHaveLength(1);
  await expectUnresolvedNotice(page);
  await expectSameDocument(page, url);
  expect(errors).toEqual([]);
});

test('B4 (WP10B-F1): category, search, zero matches, List/Grid, crop style and refreshes keep the hold', async ({ page }) => {
  const f = await createProject('Remove Missing F1 B4');
  f.markMissing('02-ref.png');
  const url = `${f.url}?category=${f.wipId}&view=grid`;
  const { control, errors } = await open(page, url);
  const keep = f.assetId('01-draft.png');
  await moveBefore(page, '03-draft.png');
  const draft = await orderValue(page);
  gate.holdNext = 1;
  control.post = 'gate';
  await confirm(page);
  await expectInstalled(page);
  control.post = 'pass';
  await expectUnresolvedNotice(page);

  // Text filter, then a zero-match search, then back.
  await searched(page, 'ref');
  await expectUnresolvedNotice(page);
  await searched(page, 'nothing-matches');
  await expectUnresolvedNotice(page);
  await searched(page, '');
  // Category changes.
  for (const categoryId of [f.rendersId, f.wipId]) {
    await markRegion(page);
    await page.locator(`#asset-category-filter input[value="${categoryId}"]`).evaluate((input) => {
      input.checked = true;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expectInstalled(page);
    await expectUnresolvedNotice(page);
  }
  // List, then Grid.
  for (const name of ['List view', 'Grid view']) {
    await markRegion(page);
    await page.getByRole('link', { name, exact: true }).click();
    await expectInstalled(page);
    await expectUnresolvedNotice(page);
  }
  // Filter navigation itself starts a fresh selection (as without any
  // removal); refreshes from here on must keep this one.
  await select(page, keep);
  // Crop style through Project Assets defaults (its own POST, then a GET).
  await page.getByRole('link', { name: 'Project Assets defaults', exact: true }).click();
  await expect(page.locator('#project-assets-defaults-dialog')).toBeVisible();
  const saved = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/assets/defaults'));
  await page.locator('#projectAssets-default-gridStyle').selectOption('cropped', { force: true });
  await saved;
  await expect(region(page)).not.toHaveAttribute('aria-busy', 'true');
  await page.locator('#project-assets-defaults-dialog').getByRole('button', { name: 'Close Project Assets defaults' }).click();
  await expect(page.locator('.asset-grid')).toHaveAttribute('data-grid-style', 'cropped');
  await expectUnresolvedNotice(page);
  // Another feature's mutation refresh (category sync) and a Check again.
  await markRegion(page);
  await page.evaluate(() => document.dispatchEvent(new Event('project-asset-categories-changed')));
  await expectInstalled(page);
  await checkAgainReadsOnly(page, control);
  await expectUnresolvedNotice(page);

  await expectRemovalBlocked(page);
  expect(control.posts).toHaveLength(1);
  expect(gate.arrivals).toBe(1);
  expect(serviceCalls).toBe(0);
  // Navigation and view controls stayed usable; selection and the draft survive.
  await expect(box(page, keep)).toBeChecked();
  expect(await orderValue(page)).toEqual(draft);
  // Live filters update the URL in place (pushState); the document is the same.
  expect(await page.evaluate(() => window.__sameDocument)).toBe(true);

  gate.release();
  expect((await control.upstream[0]).status).toBe(200);
  expect(serviceCalls).toBe(1);
  expect(control.posts).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('B6 (WP10B-F1): a proven refusal leaves no hold; the next confirmation sends and settles', async ({ page }) => {
  const f = await createProject('Remove Missing F1 B6');
  f.markMissing('02-ref.png');
  const { control, errors } = await open(page, f.url);
  await openConfirmation(page);
  const token = page.locator('#remove-missing-assets-form input[name="_csrf"]');
  const valid = await token.inputValue();
  await token.evaluate((input) => { input.value = 'tampered'; });
  await confirmButton(page).click();
  await expect(dialog(page).locator('[data-dialog-error-text]')).toHaveText('Invalid or missing CSRF token. Nothing was removed.');
  await expect(pending(page)).toBeHidden();
  expect(serviceCalls).toBe(0);
  await page.keyboard.press('Escape');
  // The refusal created no hold: a new confirmation (with a valid token) sends.
  await openConfirmation(page);
  await expect(confirmButton(page)).toBeEnabled();
  await expect(dialog(page).locator('[data-dialog-error]')).toBeHidden();
  await token.evaluate((input, value) => { input.value = value; }, valid);
  await markRegion(page);
  await confirmButton(page).click();
  await expectInstalled(page);
  await expect(feedbackText(page)).toHaveText('Removed 1 of 1 missing asset record. No files were deleted.');
  await expect(pending(page)).toBeHidden();
  expect(control.posts).toHaveLength(2);
  expect(serviceCalls).toBe(1);
  expect(f.missing()).toEqual([]);
  await expectSameDocument(page, f.url);
  expect(errors).toEqual([]);
});

test('H: removed ids leave the selection and the order draft; survivors and the saved baseline stay distinct', async ({ page }) => {
  const f = await createProject('Remove Missing H');
  // Missing in another category when the page loads, so the action is offered.
  f.markMissing('r1.png');
  const url = `${f.url}?category=${f.wipId}`;
  const { control, errors } = await open(page, url);
  const [a, b, c, d, e, g] = WIP.map(f.assetId);
  await select(page, a);
  await select(page, c);
  await select(page, e);
  await moveBefore(page, '03-draft.png');
  expect(await orderValue(page)).toEqual([a, c, b, d, e, g]);
  await expect(page.locator('[data-selected-count]')).toHaveText(`3 of ${WIP.length} selected`);
  // Selected and in the draft, then found missing by another tab's scan.
  f.markMissing('03-draft.png');

  await confirm(page);
  await expectInstalled(page);
  await expect(feedbackText(page)).toHaveText('Removed 2 of 2 missing asset records. No files were deleted.');
  expect(f.exists(c)).toBe(false);
  await expect(box(page, a)).toBeChecked();
  await expect(box(page, e)).toBeChecked();
  await expect(box(page, c)).toHaveCount(0);
  await expect(page.locator('[data-selected-count]')).toHaveText(`2 of ${WIP.length - 1} selected`);
  // The draft without c is the saved order: nothing unsaved is left, and
  // nothing was saved for the user.
  expect(await orderValue(page)).toEqual([a, b, d, e, g]);
  expect(await savedOrder(page)).toEqual([a, b, d, e, g]);
  expect(control.otherPosts).toEqual([]);

  // A draft that still differs survives removal of another id.
  await moveBefore(page, '05-draft.png');
  expect(await orderValue(page)).toEqual([a, b, e, d, g]);
  // Found missing later; a GET-only refresh shows the action again and keeps the draft.
  f.markMissing('02-ref.png');
  await markRegion(page);
  await page.evaluate(() => document.dispatchEvent(new Event('project-asset-categories-changed')));
  await expectInstalled(page);
  expect(await orderValue(page)).toEqual([a, b, e, d, g]);
  await confirm(page);
  await expectInstalled(page);
  expect(await orderValue(page)).toEqual([a, e, d, g]);
  expect(await savedOrder(page)).toEqual([a, d, e, g]);
  await expect(surface(page)).toHaveAttribute('data-auto-rename-draft', 'true');
  await expect(box(page, a)).toBeChecked();
  await expect(box(page, e)).toBeChecked();
  expect(control.posts).toHaveLength(2);
  expect(control.otherPosts).toEqual([]);
  await expectSameDocument(page, url);
  expect(errors).toEqual([]);
});

test('presentation: grid size, list view and slideshow survive a removal', async ({ page }) => {
  const f = await createProject('Remove Missing Presentation');
  f.markMissing('06-ref.png');
  const url = `${f.url}?category=${f.wipId}&view=grid`;
  const { control, errors } = await open(page, url);
  const grid = page.locator('.asset-grid');
  const style = await grid.getAttribute('data-grid-style');
  await confirm(page);
  await expectInstalled(page);
  await expect(feedbackText(page)).toHaveText('Removed 1 of 1 missing asset record. No files were deleted.');
  expect(await page.locator('.asset-grid').getAttribute('data-grid-style')).toBe(style);
  const sequence = await page.evaluate(() => JSON.parse(document.querySelector('[data-slideshow-scaffold] [data-slideshow-sequence]')?.textContent || '[]'));
  expect(JSON.stringify(sequence)).not.toContain(`"${f.assetId('06-ref.png')}"`);
  expect(control.posts).toHaveLength(1);
  await expectSameDocument(page, url);
  expect(errors).toEqual([]);
});

test('I: refusals stay local: CSRF and archived project remove nothing and never navigate', async ({ page }) => {
  const f = await createProject('Remove Missing I');
  f.markMissing('02-ref.png');
  const { control, errors } = await open(page, f.url);
  await openConfirmation(page);
  await page.locator('#remove-missing-assets-form input[name="_csrf"]').evaluate((input) => { input.value = 'tampered'; });
  await confirmButton(page).click();
  await expect(dialog(page).locator('[data-dialog-error-text]')).toHaveText('Invalid or missing CSRF token. Nothing was removed.');
  await expect(dialog(page)).toBeVisible();
  expect(serviceCalls).toBe(0);
  expect(f.missing()).toHaveLength(1);
  await page.keyboard.press('Escape');

  // Archived in another tab after the page loaded.
  db.prepare("UPDATE projects SET archived_at = datetime('now') WHERE id = ?").run(f.id);
  await page.reload();
  await page.evaluate(() => { window.__sameDocument = true; });
  await expect(trigger(page)).toHaveCount(0);
  db.prepare('UPDATE projects SET archived_at = NULL WHERE id = ?').run(f.id);
  await page.reload();
  await page.evaluate(() => { window.__sameDocument = true; });
  control.navigations = 0;
  await openConfirmation(page);
  db.prepare("UPDATE projects SET archived_at = datetime('now') WHERE id = ?").run(f.id);
  await confirmButton(page).click();
  await expect(dialog(page).locator('[data-dialog-error-text]')).toHaveText('This project is archived and read-only. Nothing was removed.');
  await expect(confirmButton(page)).toBeDisabled();
  await expect(page.locator('[data-project-assets-archived-notice]')).toHaveCount(1);
  expect(f.missing()).toHaveLength(1);
  await page.keyboard.press('Escape');
  // A dismissed dialog is dropped by the next install, not at once.
  await expect(dialog(page)).toBeHidden();
  await expect(trigger(page)).toHaveCount(0);
  expect(control.navigations).toBe(0);
  expect(await page.evaluate(() => window.__sameDocument)).toBe(true);
  expect(errors).toEqual([]);
});

test('I: without JavaScript the native form still removes and redirects with the counts', async ({ browser }) => {
  const f = await createProject('Remove Missing Native');
  f.markMissing('02-ref.png');
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  try {
    await page.goto(`${baseURL}${f.url}?category=${f.wipId}&search=ref&remove_missing=1`);
    await expect(dialog(page)).toBeVisible();
    await confirmButton(page).click();
    await page.waitForURL(/missing_cleanup=ok/);
    const location = new URL(page.url());
    expect(location.pathname).toBe(f.url);
    expect(location.searchParams.get('search')).toBe('ref');
    expect(location.searchParams.get('missing_removed')).toBe('1');
    await expect(page.locator('.scan-success')).toContainText('Missing asset cleanup complete: removed 1 of 1 missing asset record.');
    expect(f.missing()).toEqual([]);
  } finally {
    await context.close();
  }
});
