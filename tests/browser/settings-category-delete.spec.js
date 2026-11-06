import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { createApp } from '../../src/app.js';
import { createAssetManifest } from '../../src/asset-manifest.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { createAssetCategoryRepository } from '../../src/data/asset-category-repository.js';
import { createAssetCategoryService } from '../../src/services/asset-category-service.js';
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';

// WP11C: Delete a global asset category default on Settings → Asset
// Categories in place, in real Chromium with the compiled client, the real
// route, templates, service and an isolated SQLite database. The app is given
// the real category service wrapped only to count its Delete executions; an
// upstream gate between the browser and the app can hold a Delete POST that
// has fully arrived before the route runs. All data lives in a temporary root
// removed afterward; the app listens on its own temporary port.

const DELETE_PATH = /^\/settings\/asset-categories\/\d+\/delete$/;
const LIST_PATH = '/settings/asset-categories';
const URL_PATH = '/settings/asset-categories';
let server;
let proxy;
let db;
let app;
let root;
let baseURL;
let categories;
let fixtures = 0;
const executions = [];
const mutations = [];

const gate = {
  holdNext: 0,
  arrivals: 0,
  forwarded: 0,
  held: [],
  release() { this.held.splice(0).forEach((forward) => forward()); },
};

// WP11C-F2: Defaults preference saves. A preference POST answers with a
// redirect, and the browser's fetch follows it to the list page, whose render
// is the answer the page installs. holdRequests keeps a whole POST upstream
// before its route runs; holdAnswers lets the POST and its redirect render
// run now and holds only the rendered answer on its way back, so a released
// answer is as old as when the server rendered it.
const PREFERENCE_PATH = /^\/settings\/asset-categories\/(browser-default|preview-category)$/;
// WP11C-F5: every details (name/slug) save POST's body as it arrived; hold
// lets the next one run on the server and holds only its answer.
const DETAILS_PATH = /^\/settings\/asset-categories\/\d+$/;
// WP11C-A: holdRendered lets the next save and its redirect render run now
// and holds only that rendered answer (same held list).
const detailsAnswers = { hold: 0, holdRendered: 0, held: [], bodies: [] };

const prefGate = {
  arrivals: [],
  holdRequests: 0,
  requests: [],
  holdAnswers: 0,
  answers: [],
  rendered: 0,
  // WP11C-F9A: each held answer as the server rendered it.
  bodies: [],
};

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-category-delete-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  const viteDistRoot = path.join(root, 'client');
  fs.mkdirSync(projectsRoot);
  fs.mkdirSync(appDataRoot);
  await build({ build: { outDir: viteDistRoot }, logLevel: 'silent' });
  db = openDatabase(path.join(root, 'test.db'));
  runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
  const real = createAssetCategoryService(createAssetCategoryRepository(db));
  categories = {
    ...real,
    deleteDefault: (id) => {
      executions.push(id);
      return real.deleteDefault(id);
    },
    // WP11C-F1: every other default mutation the page can cause, counted.
    editDefault: (id, values) => {
      mutations.push(['edit', id]);
      return real.editDefault(id, values);
    },
    setDefaultEnabled: (id, enabled) => {
      mutations.push(['enabled', id]);
      return real.setDefaultEnabled(id, enabled);
    },
    reorderDefaults: (ids) => {
      mutations.push(['reorder']);
      return real.reorderDefaults(ids);
    },
  };
  const { csrfPepper } = ensureAuthEnablement(appDataRoot);
  app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, {
    appDataRoot, authState: { csrfPepper }, useViteAssets: true, viteDistRoot, assetCategoryService: categories,
    assetManifest: createAssetManifest({ distRoot: viteDistRoot,
      manifestPath: path.join(viteDistRoot, '.vite', 'manifest.json') }),
  });
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
      const target = new URL(req.url, 'http://gate');
      if (req.method === 'POST' && PREFERENCE_PATH.test(target.pathname)) {
        prefGate.arrivals.push(target.pathname);
        if (prefGate.holdRequests > 0) {
          prefGate.holdRequests -= 1;
          prefGate.requests.push(() => forward(req, body, res));
          return;
        }
      }
      if (req.method === 'GET' && target.pathname === LIST_PATH && detailsAnswers.holdRendered > 0
        && target.searchParams.get('notice') === 'category_updated') {
        detailsAnswers.holdRendered -= 1;
        const upstream = http.request({ host: '127.0.0.1', port: appPort, method: req.method, path: req.url, headers: req.headers }, (answer) => {
          const parts = [];
          answer.on('data', (chunk) => parts.push(chunk));
          answer.on('end', () => {
            detailsAnswers.held.push(() => { res.writeHead(answer.statusCode, answer.headers); res.end(Buffer.concat(parts)); });
          });
        });
        upstream.end(body);
        return;
      }
      if (req.method === 'GET' && target.pathname === LIST_PATH && prefGate.holdAnswers > 0
        && /^(global_default|preview_category)_saved$/.test(target.searchParams.get('notice') || '')) {
        prefGate.holdAnswers -= 1;
        const upstream = http.request({ host: '127.0.0.1', port: appPort, method: req.method, path: req.url, headers: req.headers }, (answer) => {
          const chunks = [];
          answer.on('data', (chunk) => chunks.push(chunk));
          answer.on('end', () => {
            prefGate.rendered += 1;
            prefGate.bodies.push(Buffer.concat(chunks).toString('utf8'));
            prefGate.answers.push(() => { res.writeHead(answer.statusCode, answer.headers); res.end(Buffer.concat(chunks)); });
          });
        });
        upstream.end(body);
        return;
      }
      if (req.method === 'POST' && DELETE_PATH.test(target.pathname)) {
        gate.arrivals += 1;
        const send = () => { gate.forwarded += 1; forward(req, body, res); };
        if (gate.holdNext > 0) {
          gate.holdNext -= 1;
          gate.held.push(send);
          return;
        }
        send();
        return;
      }
      if (req.method === 'POST' && DETAILS_PATH.test(target.pathname)) {
        detailsAnswers.bodies.push(new URLSearchParams(body.toString()));
        if (detailsAnswers.hold > 0) {
          detailsAnswers.hold -= 1;
          const upstream = http.request({ host: '127.0.0.1', port: appPort, method: req.method, path: req.url, headers: req.headers }, (answer) => {
            const parts = [];
            answer.on('data', (chunk) => parts.push(chunk));
            answer.on('end', () => {
              detailsAnswers.held.push(() => { res.writeHead(answer.statusCode, answer.headers); res.end(Buffer.concat(parts)); });
            });
          });
          upstream.end(body);
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
  gate.holdNext = 0;
  gate.arrivals = 0;
  gate.forwarded = 0;
  gate.held = [];
  executions.length = 0;
  mutations.length = 0;
  prefGate.arrivals = [];
  prefGate.holdRequests = 0;
  prefGate.requests = [];
  prefGate.holdAnswers = 0;
  prefGate.answers = [];
  prefGate.rendered = 0;
  prefGate.bodies = [];
  detailsAnswers.hold = 0;
  detailsAnswers.holdRendered = 0;
  detailsAnswers.held = [];
  detailsAnswers.bodies = [];
  // Every test starts from its own disposable defaults only.
  db.prepare('DELETE FROM asset_category_defaults').run();
  db.prepare("DELETE FROM app_meta WHERE key IN ('asset_browser.default_category', 'preview.default_category')").run();
});

test.afterAll(async () => {
  gate.release();
  prefGate.requests.splice(0).forEach((forward) => forward());
  prefGate.answers.splice(0).forEach((deliver) => deliver());
  detailsAnswers.held.splice(0).forEach((deliver) => deliver());
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

function seed(names) {
  return names.map((name) => {
    fixtures += 1;
    const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)}-${fixtures}`;
    const row = categories.addDefault({ displayName: name, directorySlug: slug, enabled: true });
    return {
      id: row.id,
      name,
      slug,
      exists: () => Boolean(db.prepare('SELECT id FROM asset_category_defaults WHERE id = ?').get(row.id)),
    };
  });
}

const savedOrder = () => db.prepare('SELECT id FROM asset_category_defaults ORDER BY display_order, id').all().map((row) => row.id);
const appMeta = () => db.prepare('SELECT key, value FROM app_meta ORDER BY key').all();
const projectCategoryRows = () => db.prepare('SELECT * FROM project_asset_categories ORDER BY id').all();

// control.post: 'pass' | 'hold' | 'lose' | 'gate' for Delete POSTs (see the
// Release Delete spec): lose lets the real request run, then fails the
// browser's fetch; gate sends it on to the upstream gate and, once it has
// arrived there, fails the browser's fetch, keeping the request alive upstream.
// control.reads: 'pass' | 'fail' for the in-page GET reads of the list.
async function open(page, { width = 1280, height = 900, javaScriptEnabled = true } = {}) {
  // WP11C-F1: reads 'hold' keeps each in-page GET in heldReads; details
  // 'hold' keeps each name/slug save POST in heldDetails.
  const control = {
    post: 'pass', reads: 'pass', details: 'pass', posts: [], heldPosts: [], heldReads: [], heldReadRequests: [], heldDetails: [],
    reads_: [], otherPosts: [], upstream: [], navigations: 0,
  };
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() === 'POST' && DELETE_PATH.test(pathname)) control.posts.push(request);
    else if (request.method() === 'POST') control.otherPosts.push(pathname);
    else if (request.method() === 'GET' && request.resourceType() === 'fetch') control.reads_.push({ pathname, method: request.method(), search: new URL(request.url()).search });
  });
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) control.navigations += 1; });
  await page.route((target) => DELETE_PATH.test(target.pathname), async (route) => {
    if (control.post === 'hold') { control.heldPosts.push(route); return undefined; }
    if (control.post === 'gate') {
      const arrivals = gate.arrivals;
      control.upstream.push(route.fetch({ timeout: 0, maxRetries: 0 })
        .then(async (response) => ({ status: response.status(), body: await response.json().catch(() => null) }))
        .catch((error) => ({ error: error.message })));
      for (let wait = 0; gate.arrivals === arrivals && wait < 200; wait += 1) await new Promise((resolve) => setTimeout(resolve, 25));
      return route.abort('failed');
    }
    if (control.post === 'lose') {
      const response = await route.fetch();
      await response.body().catch(() => null);
      return route.abort('failed');
    }
    return route.continue();
  });
  await page.route((target) => target.pathname === LIST_PATH, async (route) => {
    if (route.request().resourceType() === 'fetch' && control.reads === 'fail') return route.abort('failed');
    if (route.request().resourceType() === 'fetch' && control.reads === 'hold') {
      // The server answers now; only the answer's way back is held, so a
      // released read is as old as when it was sent.
      control.heldReads.push({ route, response: route.fetch() });
      return undefined;
    }
    // WP11C-F6: the whole read is held before it reaches the server, so it
    // starts now and renders only when released (see releaseReadRequests).
    if (route.request().resourceType() === 'fetch' && control.reads === 'holdRequest') {
      control.heldReadRequests.push(route);
      return undefined;
    }
    return route.fallback();
  });
  await page.route((target) => /^\/settings\/asset-categories\/\d+$/.test(target.pathname), async (route) => {
    if (route.request().method() === 'POST' && control.details === 'hold') {
      control.heldDetails.push(route);
      return undefined;
    }
    return route.fallback();
  });
  await page.setViewportSize({ width, height });
  await page.goto(`${baseURL}${URL_PATH}`);
  await page.locator('[data-settings-category-defaults]').waitFor({ state: 'attached' });
  control.navigations = 0;
  if (javaScriptEnabled) await page.evaluate(() => { window.__sameDocument = true; });
  return { control, errors };
}

const confirmation = (page) => page.locator('#app-confirmation-dialog');
const confirmMessage = (page) => confirmation(page).locator('[data-app-dialog-confirmation-message]');
const confirmButton = (page) => confirmation(page).locator('[data-app-dialog-confirmation-confirm]');
const cancelButton = (page) => confirmation(page).locator('[data-app-dialog-confirmation-cancel]');
const row = (page, category) => page.locator(`[data-settings-category-defaults] article[data-category-id="${category.id}"]`);
const deleteButton = (page, category) => row(page, category).locator('form[data-settings-category-delete-form] button');
const feedback = (page) => page.locator('[data-dialog-feedback]');
const heading = (page) => page.locator('#settings-category-defaults-heading');
const addName = (page) => page.locator('#add-displayName');
const rowIds = (page) => page.locator('[data-settings-category-defaults] article[data-category-id]')
  .evaluateAll((nodes) => nodes.map((node) => Number(node.getAttribute('data-category-id'))));

async function expectSameDocument(page) {
  expect(await page.evaluate(() => window.__sameDocument)).toBe(true);
  const current = new URL(page.url());
  expect(current.pathname + current.search).toBe(URL_PATH);
}

const OBSERVED = 'no longer exists, but this page could not confirm whether its Delete request deleted it.';
const STILL_PRESENT = 'It still exists, but the earlier Delete request may still run.';

test('A: local confirmation; Cancel/Escape/backdrop/requestSubmit send nothing; one confirmed POST deletes in place', async ({ page }) => {
  const [keep, target, last] = seed(['Keep A', 'Target A', 'Last A']);
  const { control, errors } = await open(page);
  await addName(page).fill('Unsaved add draft');

  await deleteButton(page, target).click();
  await expect(confirmation(page)).toBeVisible();
  await expect(confirmation(page).locator('#app-confirmation-dialog-title')).toHaveText('Delete category default?');
  await expect(confirmMessage(page)).toContainText(`Delete the asset category default “Target A” (directory slug “${target.slug}”)?`);
  await expect(confirmMessage(page)).toContainText('projects created from now on will not get this category');
  await expect(confirmMessage(page)).toContainText('Categories already copied into existing projects, with their assets, files and release selections, are not changed');
  await expect(confirmMessage(page)).not.toContainText('preview category');
  await expect(confirmButton(page)).toHaveText('Delete default');
  await cancelButton(page).click();
  await expect(confirmation(page)).toBeHidden();
  await expect(deleteButton(page, target)).toBeFocused();
  await deleteButton(page, target).click();
  await page.keyboard.press('Escape');
  await expect(confirmation(page)).toBeHidden();
  await deleteButton(page, target).click();
  await expect(confirmation(page)).toBeVisible();
  await page.mouse.click(4, 4);
  await expect(confirmation(page)).toBeHidden();
  await page.evaluate((id) => document.querySelector(`form[data-category-delete-id="${id}"]`).requestSubmit(), target.id);
  await expect(confirmation(page)).toBeVisible();
  await cancelButton(page).click();
  expect(control.posts).toHaveLength(0);
  expect(gate.arrivals).toBe(0);
  expect(target.exists()).toBe(true);

  await deleteButton(page, target).click();
  await confirmButton(page).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(feedback(page)).toHaveText('Asset category default “Target A” deleted. The category defaults are up to date.');
  await expect(row(page, target)).toHaveCount(0);
  await expect(heading(page)).toBeFocused();
  // Repeated Enter on the heading never reaches another Delete.
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(confirmation(page)).toBeHidden();
  expect(control.posts).toHaveLength(1);
  expect(executions).toEqual([target.id]);
  expect(target.exists()).toBe(false);
  expect(keep.exists() && last.exists()).toBe(true);
  expect(await rowIds(page)).toEqual([keep.id, last.id]);
  await expect(addName(page)).toHaveValue('Unsaved add draft');
  await expectSameDocument(page);
  expect(control.navigations).toBe(0);
  expect(control.reads_.every((read) => read.method === 'GET' && read.pathname === LIST_PATH)).toBe(true);
  expect(control.otherPosts).toEqual([]);
  expect(errors).toEqual([]);
});

test('B: refusals stay local — gone elsewhere (404) and CSRF (403); drafts and the page stay', async ({ page }) => {
  const [gone, guarded, other] = seed(['Gone B', 'Guarded B', 'Other B']);
  const { control, errors } = await open(page);
  await addName(page).fill('Draft B');
  // Deleted elsewhere after this page loaded: there is no protected default,
  // so the only service refusal is a default that no longer exists.
  db.prepare('DELETE FROM asset_category_defaults WHERE id = ?').run(gone.id);
  await deleteButton(page, gone).click();
  await confirmButton(page).click();
  await expect(feedback(page)).toHaveText('This category default no longer exists, so it was not deleted by this page. The category defaults are up to date.');
  await expect(row(page, gone)).toHaveCount(0);
  expect(executions).toEqual([]);

  await row(page, guarded).locator('form[data-settings-category-delete-form] input[name="_csrf"]').evaluate((input) => { input.value = 'stale-token'; });
  await deleteButton(page, guarded).click();
  await confirmButton(page).click();
  await expect(feedback(page)).toHaveText('Invalid or missing CSRF token. Nothing was deleted.');
  await expect(row(page, guarded)).toHaveCount(1);
  await expect(deleteButton(page, guarded)).not.toHaveAttribute('aria-disabled', 'true');
  expect(guarded.exists() && other.exists()).toBe(true);
  await expect(addName(page)).toHaveValue('Draft B');
  await expectSameDocument(page);
  expect(control.posts).toHaveLength(2);
  expect(executions).toEqual([]);
  expect(errors).toEqual([]);
});

test('C: category order — a saving order refuses Delete; survivors keep the saved order; no order is saved by Delete', async ({ page }) => {
  const [one, two, three, four] = seed(['One C', 'Two C', 'Three C', 'Four C']);
  categories.reorderDefaults([three.id, one.id, four.id, two.id]);
  const { control, errors } = await open(page);
  expect(await rowIds(page)).toEqual([three.id, one.id, four.id, two.id]);
  // An order change in flight: Delete is refused before its confirmation.
  const heldReorders = [];
  await page.route('**/settings/asset-categories/reorder', (route) => { heldReorders.push(route); });
  await row(page, four).locator('[data-category-reorder-handle]').focus();
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => heldReorders.length).toBe(1);
  await deleteButton(page, two).click();
  await expect(confirmation(page)).toBeHidden();
  await expect(feedback(page)).toContainText('Wait for the category order to save, then try again.');
  expect(control.posts).toHaveLength(0);
  await page.unroute('**/settings/asset-categories/reorder');
  await heldReorders[0].continue();
  await expect(page.locator('form[data-category-reorder-form]')).not.toHaveAttribute('aria-busy', 'true');
  expect(savedOrder()).toEqual([three.id, four.id, one.id, two.id]);
  const reordersBefore = control.otherPosts.filter((pathname) => pathname.endsWith('/reorder')).length;

  await deleteButton(page, one).click();
  await confirmButton(page).click();
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  expect(savedOrder()).toEqual([three.id, four.id, two.id]);
  expect(await rowIds(page)).toEqual([three.id, four.id, two.id]);
  await expect(page.locator(`article[data-category-id="${two.id}"]`)).toHaveAttribute('aria-posinset', '3');
  expect(control.otherPosts.filter((pathname) => pathname.endsWith('/reorder')).length).toBe(reordersBefore);
  // The installed list still reorders (fresh binding) and saves once.
  await row(page, two).locator('[data-category-reorder-handle]').focus();
  await page.keyboard.press('Home');
  await expect.poll(() => savedOrder()).toEqual([two.id, three.id, four.id]);
  expect(control.posts).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('D: project defaults — existing projects keep their copied category; new projects do not get it', async ({ page }) => {
  const [target, kept] = seed(['Target D', 'Kept D']);
  fixtures += 1;
  const existing = app.locals.projectService.create({ title: `Category D Existing ${fixtures}`, description: '', notes: '', status: 'in-progress' });
  const copied = projectCategoryRows().find((r) => r.project_id === existing.id && r.directory_slug === target.slug);
  expect(copied).toBeDefined();
  const assetId = Number(db.prepare(`INSERT INTO assets (project_id, filename, relative_path, category_id)
    VALUES (?, 'd.png', ?, ?)`).run(existing.id, `${target.slug}/d.png`, copied.id).lastInsertRowid);
  const before = { categories: projectCategoryRows(), asset: db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId) };
  const { control, errors } = await open(page);
  await deleteButton(page, target).click();
  await confirmButton(page).click();
  await expect(feedback(page)).toContainText('deleted.');
  expect(target.exists()).toBe(false);
  expect(projectCategoryRows()).toEqual(before.categories);
  expect(db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId)).toEqual(before.asset);
  fixtures += 1;
  const later = app.locals.projectService.create({ title: `Category D New ${fixtures}`, description: '', notes: '', status: 'in-progress' });
  const laterSlugs = projectCategoryRows().filter((r) => r.project_id === later.id).map((r) => r.directory_slug);
  expect(laterSlugs).toEqual([kept.slug]);
  expect(control.posts).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('E: confirmed Delete with a failed refresh — stays deleted; Delete unavailable; Retry refresh reads only', async ({ page }) => {
  const [target, other] = seed(['Target E', 'Other E']);
  const { control, errors } = await open(page);
  control.reads = 'fail';
  await deleteButton(page, target).click();
  await confirmButton(page).click();
  await expect(feedback(page)).toContainText('Asset category default “Target E” deleted.');
  await expect(feedback(page)).toContainText('could not be refreshed and may be out of date');
  await expect(feedback(page)).not.toContainText('could not be deleted');
  await expect(row(page, target)).toHaveCount(0);
  expect(target.exists()).toBe(false);
  await deleteButton(page, other).click();
  await expect(confirmation(page)).toBeHidden();
  await expect(feedback(page)).toContainText('The category defaults shown may be out of date. Use Retry refresh, then try again.');
  expect(control.posts).toHaveLength(1);

  control.reads = 'pass';
  // Changed elsewhere meanwhile; the retry installs it.
  categories.editDefault(other.id, { displayName: 'Other E renamed', directorySlug: other.slug });
  const retry = feedback(page).locator('[data-settings-category-delete-refresh-retry]');
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect(feedback(page)).toHaveText('Asset category default “Target E” deleted. The category defaults are up to date.');
  await expect(row(page, other).locator('input[name="displayName"]')).toHaveValue('Other E renamed');
  await expect(deleteButton(page, other)).not.toHaveAttribute('aria-disabled', 'true');
  expect(control.posts).toHaveLength(1);
  expect(executions).toEqual([target.id]);
  await expectSameDocument(page);
  expect(errors).toEqual([]);
});

test('F: lost answer after the service ran — no resend; the GET reports an observation, never a confirmed deletion', async ({ page }) => {
  const [target, other] = seed(['Target F', 'Other F']);
  const { control, errors } = await open(page);
  await addName(page).fill('Draft F');
  control.post = 'lose';
  await deleteButton(page, target).click();
  await confirmButton(page).click();
  await expect(feedback(page)).toHaveText(`“Target F” ${OBSERVED}`);
  await expect(feedback(page)).not.toContainText('Asset category default “Target F” deleted.');
  await expect(row(page, target)).toHaveCount(0);
  expect(target.exists()).toBe(false);
  expect(other.exists()).toBe(true);
  expect(control.posts).toHaveLength(1);
  expect(executions).toEqual([target.id]);
  await expect(addName(page)).toHaveValue('Draft F');
  await expectSameDocument(page);
  expect(errors).toEqual([]);
});

test('G: delayed original POST held upstream — early GET settles nothing, no second POST, one execution on release', async ({ page }) => {
  const [first, target, last] = seed(['First G', 'Target G', 'Last G']);
  const { control, errors } = await open(page);
  await addName(page).fill('Draft G');
  await row(page, last).locator('input[name="displayName"]').fill('Last G draft');
  control.post = 'gate';
  gate.holdNext = 1;
  await deleteButton(page, target).click();
  await confirmButton(page).click();
  await expect(feedback(page)).toContainText(`“Target G”: Could not confirm whether the category default was deleted. ${STILL_PRESENT}`);
  expect(gate.arrivals).toBe(1);
  expect(gate.forwarded).toBe(0);
  expect(executions).toEqual([]);
  expect(target.exists()).toBe(true);
  await expect(row(page, target)).toHaveAttribute('data-settings-category-delete-hold', 'unresolved');
  // Attempt again, and rebind the controls by deleting another default.
  await deleteButton(page, target).click({ force: true });
  await expect(confirmation(page)).toBeHidden();
  await expect(feedback(page)).toContainText('has not been confirmed, so it cannot be deleted again from this page');
  await row(page, target).locator('input[type="checkbox"]').evaluate((input) => input.click());
  await expect(row(page, target).locator('input[type="checkbox"]')).toBeChecked();
  await page.locator('[data-settings-category-delete-check]').click();
  await expect(feedback(page)).toContainText(STILL_PRESENT);
  expect(control.posts).toHaveLength(1);
  expect(gate.arrivals).toBe(1);
  await expect(page.locator('[data-settings-category-delete-check]')).toBeVisible();

  gate.release();
  const answer = await control.upstream[0];
  expect(answer.status).toBe(200);
  expect(executions).toEqual([target.id]);
  expect(target.exists()).toBe(false);
  expect(first.exists() && last.exists()).toBe(true);
  await page.locator('[data-settings-category-delete-check]').click();
  await expect(feedback(page)).toHaveText(`“Target G” ${OBSERVED}`);
  await expect(row(page, target)).toHaveCount(0);
  expect(await rowIds(page)).toEqual([first.id, last.id]);
  await expect(row(page, last).locator('input[name="displayName"]')).toHaveValue('Last G draft');
  // That name was saved once by its own autosave (on blur), never by Delete.
  expect(control.otherPosts.filter((pathname) => pathname === `/settings/asset-categories/${last.id}`)).toHaveLength(1);
  await expect(addName(page)).toHaveValue('Draft G');
  expect(control.posts).toHaveLength(1);
  expect(executions).toEqual([target.id]);
  await expectSameDocument(page);
  expect(errors).toEqual([]);
});

test('H: other Settings controls — preview and browser defaults autosave once, are described, and keep working after the install', async ({ page }) => {
  const [target, other] = seed(['Target H', 'Other H']);
  const { control, errors } = await open(page);
  const setSelect = (selector, value) => page.locator(selector).evaluate((select, next) => {
    select.value = next;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  await setSelect('#global-preview-category', target.slug);
  await expect.poll(() => control.otherPosts.filter((p) => p.endsWith('/preview-category')).length).toBe(1);
  await expect(page.locator('[data-settings-asset-category-preference="preview-category"] form')).not.toHaveAttribute('aria-busy', 'true');
  await setSelect('#global-asset-browser-default', target.slug);
  await expect.poll(() => control.otherPosts.filter((p) => p.endsWith('/browser-default')).length).toBe(1);
  await expect(page.locator('[data-settings-asset-category-preference="browser-default"]')).toHaveAttribute('data-settings-asset-category-preference-stored', target.slug);
  const metaBefore = appMeta();

  await deleteButton(page, target).click();
  await expect(confirmMessage(page)).toContainText('It is the saved global asset browser default');
  await expect(confirmMessage(page)).toContainText('It is the saved preview category');
  await confirmButton(page).click();
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  expect(appMeta()).toEqual(metaBefore);
  await expect(page.locator('[data-settings-asset-category-preference="browser-default"]')).toContainText(/unavailable/i);
  expect(control.otherPosts.filter((p) => p.endsWith('/preview-category') || p.endsWith('/browser-default'))).toHaveLength(2);
  // The installed controls still save, once each.
  await setSelect('#global-preview-category', other.slug);
  await expect.poll(() => control.otherPosts.filter((p) => p.endsWith('/preview-category')).length).toBe(2);
  await expect.poll(() => db.prepare("SELECT value FROM app_meta WHERE key = 'preview.default_category'").pluck().get()).toBe(other.slug);
  await row(page, other).locator('label.form-switch-label').click();
  await expect.poll(() => db.prepare('SELECT enabled FROM asset_category_defaults WHERE id = ?').pluck().get(other.id)).toBe(0);
  expect(control.otherPosts.filter((p) => p.endsWith('/enabled'))).toHaveLength(1);
  expect(control.posts).toHaveLength(1);
  await expectSameDocument(page);
  expect(errors).toEqual([]);
});

test('I: native Delete without JavaScript keeps its redirect and notice', async ({ browser }) => {
  const [target, other] = seed(['Target I', 'Other I']);
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(`${baseURL}${URL_PATH}`);
  await row(page, target).locator('form[data-settings-category-delete-form] button').click();
  await page.waitForURL(`${baseURL}${URL_PATH}?notice=category_deleted`);
  await expect(page.locator('body')).toContainText('Asset category default deleted.');
  expect(target.exists()).toBe(false);
  expect(other.exists()).toBe(true);
  expect(executions).toEqual([target.id]);
  await context.close();
});

test('J: keyboard and narrow viewport — long name, focus, Escape, repeated Enter and recovery controls', async ({ page }) => {
  const longName = 'An unusually long asset category default name that keeps going to test wrapping on narrow screens';
  const [target, other] = seed([longName, 'Other J']);
  const { control, errors } = await open(page, { width: 360, height: 740 });
  await deleteButton(page, target).focus();
  await page.keyboard.press('Enter');
  await expect(confirmation(page)).toBeVisible();
  await expect(confirmMessage(page)).toContainText(longName);
  const fits = await confirmation(page).evaluate((dialog) => dialog.getBoundingClientRect().right <= window.innerWidth + 0.5
    && document.documentElement.scrollWidth <= window.innerWidth + 0.5);
  expect(fits).toBe(true);
  expect(await page.evaluate(() => document.getElementById('app-confirmation-dialog').contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(confirmation(page)).toBeHidden();
  await expect(deleteButton(page, target)).toBeFocused();
  expect(control.posts).toHaveLength(0);

  control.post = 'lose';
  control.reads = 'fail';
  await page.keyboard.press('Enter');
  await confirmButton(page).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  const check = page.locator('[data-settings-category-delete-check]');
  await expect(check).toBeVisible();
  await expect(feedback(page)).toContainText('The category defaults could not be checked.');
  expect(control.posts).toHaveLength(1);
  control.reads = 'pass';
  await check.focus();
  await page.keyboard.press('Enter');
  await expect(feedback(page)).toContainText(OBSERVED);
  await expect(row(page, target)).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement?.closest?.('[data-dialog-feedback], [data-settings-category-defaults]') !== null
    || document.activeElement === document.body)).toBe(true);
  await page.keyboard.press('Enter');
  await expect(confirmation(page)).toBeHidden();
  expect(control.posts).toHaveLength(1);
  expect(other.exists()).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 0.5)).toBe(true);
  await expectSameDocument(page);
  expect(errors).toEqual([]);
});

// WP11C-F3: the native Add form leaves the page, so while a Delete is pending
// or unresolved it must not run: that would drop the hold, Check again and
// the drafts, and let the same default be deleted again from a fresh page
// while the first request may still run.
const ADD_HELD = 'The category was not added and nothing was sent: an earlier category default Delete has not been confirmed, and adding would leave this page. Use Check again first.';
const ADD_PENDING = 'Wait for the Delete to finish, then add the category.';
const addForm = (page) => page.locator('form[data-category-slug-autofill-form]');
const addSlug = (page) => page.locator('#add-directorySlug');
const addButton = (page) => addForm(page).locator('button[type="submit"]');
const addPosts = (control) => control.otherPosts.filter((pathname) => pathname === LIST_PATH);
const slugExists = (slug) => Boolean(db.prepare('SELECT id FROM asset_category_defaults WHERE directory_slug = ?').get(slug));

test('F3-B1: retained original Delete POST — Add by click, Enter, repeated Enter and requestSubmit never leaves the page', async ({ page }) => {
  const [keep, target, last] = seed(['Keep F3', 'Target F3', 'Last F3']);
  fixtures += 1;
  app.locals.projectService.create({ title: `Category F3 Project ${fixtures}`, description: '', notes: '', status: 'in-progress' });
  const projectsBefore = projectCategoryRows();
  const { control, errors } = await open(page);
  const bonusSlug = `bonus-f3-${fixtures}`;
  await addName(page).fill('Bonus F3');
  await addSlug(page).fill(bonusSlug);
  // An unsaved name on another row, typed without leaving the field.
  await row(page, last).locator('input[name="displayName"]').evaluate((input) => { input.value = 'Last F3 draft'; });

  control.post = 'gate';
  gate.holdNext = 1;
  await deleteButton(page, target).click();
  await confirmButton(page).click();
  // The early GET shows it present: still unresolved.
  await expect(feedback(page)).toContainText(`“Target F3”: Could not confirm whether the category default was deleted. ${STILL_PRESENT}`);
  expect(gate.arrivals).toBe(1);
  expect(gate.forwarded).toBe(0);
  expect(executions).toEqual([]);
  expect(target.exists()).toBe(true);
  await expect(row(page, target)).toHaveAttribute('data-settings-category-delete-hold', 'unresolved');
  const readsBefore = control.reads_.length;
  expect(readsBefore).toBeGreaterThanOrEqual(1);

  // Click.
  await addButton(page).click();
  await expect(feedback(page)).toContainText(ADD_HELD);
  await expect(addButton(page)).toBeFocused();
  // Enter, twice, in the Add name field.
  await addName(page).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(addName(page)).toBeFocused();
  // requestSubmit, with and without the submitter.
  await addForm(page).evaluate((form) => { form.requestSubmit(); form.requestSubmit(form.querySelector('button[type="submit"]')); });
  await expect(confirmation(page)).toBeHidden();

  await expectSameDocument(page);
  expect(control.navigations).toBe(0);
  expect(addPosts(control)).toEqual([]);
  expect(slugExists(bonusSlug)).toBe(false);
  await expect(addName(page)).toHaveValue('Bonus F3');
  await expect(addSlug(page)).toHaveValue(bonusSlug);
  await expect(row(page, last).locator('input[name="displayName"]')).toHaveValue('Last F3 draft');
  // The original warning and its only recovery control stay; one message, one live region.
  await expect(feedback(page)).toContainText(STILL_PRESENT);
  await expect(feedback(page)).not.toContainText(/category default added|Target F3” deleted|cancel/i);
  expect((await feedback(page).textContent()).split(ADD_HELD)).toHaveLength(2);
  await expect(page.locator('[data-dialog-feedback]')).toHaveCount(1);
  const check = page.locator('[data-settings-category-delete-check]');
  await expect(check).toBeVisible();
  await expect(row(page, target)).toHaveAttribute('data-settings-category-delete-hold', 'unresolved');
  expect(control.posts).toHaveLength(1);
  expect(gate.arrivals).toBe(1);
  expect(control.reads_).toHaveLength(readsBefore);

  // Check again: GET only, still present, still held; Add still refused.
  await check.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => control.reads_.length).toBe(readsBefore + 1);
  await expect(feedback(page)).toContainText(STILL_PRESENT);
  await expect(row(page, target)).toHaveAttribute('data-settings-category-delete-hold', 'unresolved');
  // A failed read does not unlock it either.
  control.reads = 'fail';
  await check.click();
  await expect(feedback(page)).toContainText('The category defaults could not be checked.');
  control.reads = 'pass';
  await addButton(page).click();
  await expect(feedback(page)).toContainText(ADD_HELD);
  await expectSameDocument(page);
  expect(addPosts(control)).toEqual([]);
  expect(control.reads_.every((read) => read.method === 'GET' && read.pathname === LIST_PATH)).toBe(true);
  expect(control.posts).toHaveLength(1);
  expect(gate.arrivals).toBe(1);
  expect(executions).toEqual([]);

  // The original request runs, once.
  gate.release();
  const answer = await control.upstream[0];
  expect(answer.status).toBe(200);
  expect(executions).toEqual([target.id]);
  expect(target.exists()).toBe(false);
  expect(keep.exists() && last.exists()).toBe(true);
  expect(slugExists(bonusSlug)).toBe(false);
  expect(projectCategoryRows()).toEqual(projectsBefore);
  await check.click();
  await expect(feedback(page)).toHaveText(`“Target F3” ${OBSERVED}`);
  await expect(row(page, target)).toHaveCount(0);
  await expect(addName(page)).toHaveValue('Bonus F3');
  expect(control.posts).toHaveLength(1);
  expect(addPosts(control)).toEqual([]);
  expect(errors).toEqual([]);

  // Settled as gone: Add is the native form again and adds once.
  await addButton(page).click();
  await page.waitForURL(`${baseURL}${URL_PATH}?notice=category_added`);
  await expect(page.locator('body')).toContainText('Asset category default added.');
  expect(slugExists(bonusSlug)).toBe(true);
  expect(addPosts(control)).toEqual([LIST_PATH]);
  expect(control.posts).toHaveLength(1);
  expect(executions).toEqual([target.id]);
  expect(projectCategoryRows()).toEqual(projectsBefore);
});

test('F3-B2: pending Delete at a narrow viewport — Enter in Add is refused and focus stays; the answer unlocks Add', async ({ page }) => {
  const [target, other] = seed(['Target F3 pending', 'Other F3 pending']);
  const { control, errors } = await open(page, { width: 360, height: 740 });
  const slug = `pending-f3-${fixtures}`;
  await addName(page).fill('Pending F3 add');
  await addSlug(page).fill(slug);
  control.post = 'hold';
  await deleteButton(page, target).click();
  await confirmButton(page).click();
  await expect.poll(() => control.heldPosts.length).toBe(1);
  await addSlug(page).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(feedback(page)).toContainText(ADD_PENDING);
  await expect(addSlug(page)).toBeFocused();
  await expect(confirmation(page)).toBeHidden();
  await expectSameDocument(page);
  expect(addPosts(control)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 0.5)).toBe(true);

  // The held request goes on and is answered: deleted; the hold ends.
  control.post = 'pass';
  await control.heldPosts[0].continue();
  await expect(feedback(page)).toContainText('Asset category default “Target F3 pending” deleted.');
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  expect(executions).toEqual([target.id]);
  await expect(addSlug(page)).toHaveValue(slug);
  await addSlug(page).focus();
  await page.keyboard.press('Enter');
  await page.waitForURL(`${baseURL}${URL_PATH}?notice=category_added`);
  expect(slugExists(slug)).toBe(true);
  expect(other.exists()).toBe(true);
  expect(addPosts(control)).toEqual([LIST_PATH]);
  expect(control.posts).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('F3-B3: with nothing held, Add stays native; after a confirmed Delete it still adds once', async ({ page }) => {
  const [target, other] = seed(['Target F3 normal', 'Other F3 normal']);
  fixtures += 1;
  app.locals.projectService.create({ title: `Category F3 Normal ${fixtures}`, description: '', notes: '', status: 'in-progress' });
  const projectsBefore = projectCategoryRows();
  const { control, errors } = await open(page);
  const first = `normal-f3-a-${fixtures}`;
  await addName(page).fill('Normal F3 A');
  await addSlug(page).fill(first);
  await addButton(page).click();
  await page.waitForURL(`${baseURL}${URL_PATH}?notice=category_added`);
  await expect(page.locator('body')).toContainText('Asset category default added.');
  expect(slugExists(first)).toBe(true);
  // Native validation is unchanged: an invalid slug re-renders with errors.
  await addName(page).fill('Bad F3');
  await addSlug(page).fill('Bad Slug!');
  await addButton(page).click();
  await expect(page.locator('#add-category-errors')).toBeVisible();
  await expect(addName(page)).toHaveValue('Bad F3');

  await page.evaluate(() => { window.__sameDocument = true; });
  await deleteButton(page, target).click();
  await confirmButton(page).click();
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  expect(target.exists()).toBe(false);
  await expect(page.locator('[data-settings-category-delete-check]')).toHaveCount(0);
  const second = `normal-f3-b-${fixtures}`;
  await addName(page).fill('Normal F3 B');
  await addSlug(page).fill(second);
  await addName(page).focus();
  await page.keyboard.press('Enter');
  await page.waitForURL(`${baseURL}${URL_PATH}?notice=category_added`);
  expect(slugExists(second)).toBe(true);
  expect(other.exists()).toBe(true);
  expect(addPosts(control)).toEqual([LIST_PATH, LIST_PATH, LIST_PATH]);
  expect(control.posts).toHaveLength(1);
  expect(executions).toEqual([target.id]);
  expect(projectCategoryRows()).toEqual(projectsBefore);
  expect(errors).toEqual([]);
});

// WP11C-F1: installing a list read is read-only. Taking a focused, edited
// name or slug out of the page makes Chromium end that edit (change, blur),
// and the details form saves on change; the install must not do that. The
// draft stays on screen, unsaved and distinct from its saved value, with its
// focus and caret, and the person's own Tab still saves it once.
const nameField = (page, category) => page.locator(`#global-category-${category.id}-display-name`);
const slugField = (page, category) => page.locator(`#global-category-${category.id}-directory-slug`);
const detailsStatus = (page, category) => row(page, category).locator('[data-category-details-status]');
const savedRow = (category) => db.prepare('SELECT display_name, directory_slug, display_order, enabled FROM asset_category_defaults WHERE id = ?').get(category.id);
const detailsPosts = (control, category) => control.otherPosts.filter((pathname) => pathname === `${LIST_PATH}/${category.id}`).length;
const preferencePosts = (control) => control.otherPosts.filter((pathname) => /\/(browser-default|preview-category)$/.test(pathname));
const fieldState = (locator) => locator.evaluate((field) => ({
  value: field.value,
  saved: field.defaultValue,
  focused: document.activeElement === field,
  selection: [field.selectionStart, field.selectionEnd],
  sameElement: field.__f1Marker === true,
  state: field.form?.getAttribute('data-category-details-state') || null,
}));
const markField = (locator) => locator.evaluate((field) => { field.__f1Marker = true; });
// Lets anything the install set off reach the network and the database.
const settle = (page) => page.waitForTimeout(500);

async function releaseReads(control) {
  control.reads = 'pass';
  for (const { route, response } of control.heldReads.splice(0)) await route.fulfill({ response: await response });
}

// Confirms the Delete of `category`; its list read is answered but held.
async function deleteWithHeldRead(page, control, category) {
  control.reads = 'hold';
  const reads = control.heldReads.length;
  await deleteButton(page, category).click();
  await confirmButton(page).click();
  await expect.poll(() => control.heldReads.length).toBe(reads + 1);
  await expect(row(page, category)).toHaveCount(0);
  await expect(feedback(page)).toContainText('Updating the category defaults…');
}

// Leaves `category` with a refused slug draft: saved values unchanged.
async function refusedSlugDraft(page, control, category) {
  const before = savedRow(category);
  await slugField(page, category).fill('Bad Slug!');
  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, category)).toHaveText('Could not save category details. Current changes have not been saved.');
  expect(savedRow(category)).toEqual(before);
  expect(detailsPosts(control, category)).toBe(1);
}

test('F1-B1: original P2 — a list read installed while an edited name is focused saves nothing; draft, focus and caret stay; Tab then saves once', async ({ page }) => {
  const [target, survivor, other] = seed(['Target F1', 'Survivor F1', 'Other F1']);
  const { control, errors } = await open(page);
  const before = savedRow(survivor);
  const orderBefore = savedOrder();
  await deleteWithHeldRead(page, control, target);
  expect(executions).toEqual([target.id]);
  // While the read is on its way, the person edits B's name and keeps editing.
  await nameField(page, survivor).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' draft');
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Shift+ArrowLeft');
  await markField(nameField(page, survivor));
  const draft = 'Survivor F1 draft';
  const pre = await fieldState(nameField(page, survivor));
  expect(pre).toMatchObject({ value: draft, saved: 'Survivor F1', focused: true, selection: [draft.length - 2, draft.length] });
  const postsBefore = control.otherPosts.length;

  await releaseReads(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  const after = await fieldState(nameField(page, survivor));
  expect.soft(control.otherPosts.slice(postsBefore), 'POSTs sent by installing the read').toEqual([]);
  expect.soft(mutations, 'default mutations run by installing the read').toEqual([]);
  expect.soft(savedRow(survivor), 'B in SQLite').toEqual(before);
  expect.soft(after, 'B field after the install').toEqual({ ...pre, state: null });
  expect.soft(await detailsStatus(page, survivor).textContent()).toBe('');
  expect(await rowIds(page)).toEqual([survivor.id, other.id]);
  expect(savedOrder()).toEqual(orderBefore.filter((id) => id !== target.id));
  expect(control.reads_.filter((read) => read.pathname === LIST_PATH)).toHaveLength(1);

  // The person finishing the edit still saves it, exactly once.
  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, survivor)).toHaveText('Details saved.');
  expect(savedRow(survivor)).toEqual({ ...before, display_name: draft });
  expect(detailsPosts(control, survivor)).toBe(1);
  expect(mutations).toEqual([['edit', survivor.id]]);
  await expect(nameField(page, survivor)).toHaveJSProperty('defaultValue', draft);
  expect(control.posts).toHaveLength(1);
  expect(preferencePosts(control)).toEqual([]);
  await expectSameDocument(page);
  expect(errors).toEqual([]);
});

test('F1-B2: confirmed Delete with a refused draft and a focused draft on the survivor — neither is saved; order and identity stay', async ({ page }) => {
  const [first, target, survivor, last] = seed(['First F1B2', 'Target F1B2', 'Survivor F1B2', 'Last F1B2']);
  const { control, errors } = await open(page);
  const before = savedRow(survivor);
  await refusedSlugDraft(page, control, survivor);
  await deleteWithHeldRead(page, control, target);
  await nameField(page, survivor).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' renamed');
  await releaseReads(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  expect(detailsPosts(control, survivor)).toBe(1);
  expect(mutations).toEqual([['edit', survivor.id]]);
  expect(savedRow(survivor)).toEqual(before);
  await expect(nameField(page, survivor)).toHaveValue('Survivor F1B2 renamed');
  await expect(nameField(page, survivor)).toBeFocused();
  await expect(slugField(page, survivor)).toHaveValue('Bad Slug!');
  // The refused render shows the draft as the field's value; the row keeps
  // naming the saved default.
  await expect(row(page, survivor).locator('form[data-category-details-form]')).toHaveAttribute('data-category-details-state', 'error');
  await expect(row(page, survivor)).toHaveAttribute('data-category-slug', survivor.slug);
  await expect(row(page, survivor)).toHaveAttribute('data-category-label', 'Survivor F1B2');
  expect(await rowIds(page)).toEqual([first.id, survivor.id, last.id]);
  expect(savedOrder()).toEqual([first.id, survivor.id, last.id]);
  expect(executions).toEqual([target.id]);
  expect(target.exists()).toBe(false);
  // Leaving the name is the person's own save; with the bad slug it is refused.
  await page.keyboard.press('Tab');
  await expect.poll(() => detailsPosts(control, survivor)).toBe(2);
  await expect(detailsStatus(page, survivor)).toHaveText('Could not save category details. Current changes have not been saved.');
  expect(savedRow(survivor)).toEqual(before);
  // Correcting the slug saves once, with the corrected values.
  await slugField(page, survivor).fill(`${survivor.slug}-fixed`);
  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, survivor)).toHaveText('Details saved.');
  expect(savedRow(survivor)).toMatchObject({ display_name: 'Survivor F1B2 renamed', directory_slug: `${survivor.slug}-fixed` });
  expect(detailsPosts(control, survivor)).toBe(3);
  expect(control.navigations).toBe(0);
  await expectSameDocument(page);
  expect(errors).toEqual([]);
});

test('F1-B3: after an ordinary install, intentional edits save once each; invalid and duplicate values are refused and kept', async ({ page }) => {
  const [target, survivor, other] = seed(['Target F1B3', 'Survivor F1B3', 'Other F1B3']);
  const { control, errors } = await open(page);
  await deleteButton(page, target).click();
  await confirmButton(page).click();
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  expect(mutations).toEqual([]);

  await nameField(page, survivor).fill('Survivor F1B3 one');
  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, survivor)).toHaveText('Details saved.');
  expect(savedRow(survivor).display_name).toBe('Survivor F1B3 one');
  await expect(nameField(page, survivor)).toHaveJSProperty('defaultValue', 'Survivor F1B3 one');
  await nameField(page, survivor).fill('Survivor F1B3 two');
  await nameField(page, survivor).blur();
  await expect.poll(() => savedRow(survivor).display_name).toBe('Survivor F1B3 two');
  await slugField(page, survivor).fill(`${survivor.slug}-b3`);
  await page.keyboard.press('Tab');
  await expect.poll(() => savedRow(survivor).directory_slug).toBe(`${survivor.slug}-b3`);
  expect(detailsPosts(control, survivor)).toBe(3);

  // Invalid: an empty name is refused; nothing changes; the draft stays.
  await nameField(page, survivor).fill('');
  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, survivor)).toHaveText('Could not save category details. Current changes have not been saved.');
  await expect(nameField(page, survivor)).toHaveValue('');
  expect(savedRow(survivor).display_name).toBe('Survivor F1B3 two');
  // A valid name: leaving it for the slug is a real blur, so it saves.
  await nameField(page, survivor).fill('Survivor F1B3 three');
  await slugField(page, survivor).focus();
  await expect.poll(() => savedRow(survivor).display_name).toBe('Survivor F1B3 three');
  // Duplicate slug: refused the same way.
  await slugField(page, survivor).fill(other.slug);
  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, survivor)).toHaveText('Could not save category details. Current changes have not been saved.');
  await expect(slugField(page, survivor)).toHaveValue(other.slug);
  expect(savedRow(survivor)).toMatchObject({ display_name: 'Survivor F1B3 three', directory_slug: `${survivor.slug}-b3` });
  // Corrected: one more save, the corrected values.
  const posts = detailsPosts(control, survivor);
  await slugField(page, survivor).fill(`${survivor.slug}-b3-ok`);
  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, survivor)).toHaveText('Details saved.');
  expect(savedRow(survivor)).toMatchObject({ display_name: 'Survivor F1B3 three', directory_slug: `${survivor.slug}-b3-ok` });
  expect(detailsPosts(control, survivor)).toBe(posts + 1);
  expect(savedRow(other).directory_slug).toBe(other.slug);
  expect(mutations.every(([kind, id]) => kind === 'edit' && id === survivor.id)).toBe(true);
  expect(errors).toEqual([]);
});

test('F1-B4: an intentional save in flight while the read installs — no second save; pending stays truthful; the answer sets the saved value', async ({ page }) => {
  const [target, survivor, other] = seed(['Target F1B4', 'Survivor F1B4', 'Other F1B4']);
  const { control, errors } = await open(page);
  control.details = 'hold';
  await nameField(page, survivor).fill('Survivor F1B4 sent');
  await page.keyboard.press('Tab');
  await expect.poll(() => control.heldDetails.length).toBe(1);
  await expect(row(page, survivor).locator('form[data-category-details-form]')).toHaveAttribute('aria-busy', 'true');
  // Delete another default while B saves; its read installs meanwhile.
  await deleteButton(page, target).click();
  await confirmButton(page).click();
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  expect(detailsPosts(control, survivor)).toBe(1);
  await expect(row(page, survivor).locator('form[data-category-details-form]')).toHaveAttribute('aria-busy', 'true');
  await expect(detailsStatus(page, survivor)).toHaveText('Saving category details.');
  await expect(nameField(page, survivor)).toHaveValue('Survivor F1B4 sent');
  expect(savedRow(survivor).display_name).toBe('Survivor F1B4');
  expect(mutations).toEqual([]);

  control.details = 'pass';
  await control.heldDetails.shift().continue();
  await expect(detailsStatus(page, survivor)).toHaveText('Details saved.');
  expect(savedRow(survivor).display_name).toBe('Survivor F1B4 sent');
  await expect(nameField(page, survivor)).toHaveJSProperty('defaultValue', 'Survivor F1B4 sent');
  expect(detailsPosts(control, survivor)).toBe(1);
  expect(mutations).toEqual([['edit', survivor.id]]);
  expect(await rowIds(page)).toEqual([survivor.id, other.id]);

  // A refused save in flight keeps its draft too.
  control.details = 'hold';
  await slugField(page, survivor).fill(other.slug);
  await page.keyboard.press('Tab');
  await expect.poll(() => control.heldDetails.length).toBe(1);
  control.details = 'pass';
  await control.heldDetails.shift().continue();
  await expect(detailsStatus(page, survivor)).toHaveText('Could not save category details. Current changes have not been saved.');
  await expect(slugField(page, survivor)).toHaveValue(other.slug);
  expect(savedRow(survivor).directory_slug).toBe(survivor.slug);
  expect(errors).toEqual([]);
});

test('F1-B5: an older read released after a newer save — no stale overwrite and no save by the install', async ({ page }) => {
  const [target, survivor] = seed(['Target F1B5', 'Survivor F1B5']);
  const { control, errors } = await open(page);
  await deleteWithHeldRead(page, control, target);
  // The read was answered with B's old name; B is saved after that.
  await nameField(page, survivor).fill('Survivor F1B5 newer');
  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, survivor)).toHaveText('Details saved.');
  expect(savedRow(survivor).display_name).toBe('Survivor F1B5 newer');
  await releaseReads(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  await expect(nameField(page, survivor)).toHaveValue('Survivor F1B5 newer');
  await expect(nameField(page, survivor)).toHaveJSProperty('defaultValue', 'Survivor F1B5 newer');
  expect(savedRow(survivor).display_name).toBe('Survivor F1B5 newer');
  expect(detailsPosts(control, survivor)).toBe(1);
  expect(mutations).toEqual([['edit', survivor.id]]);
  await expect(row(page, target)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('F1-B6: two dirty survivors through the install — neither saved; each keeps its own draft; only the one the person leaves saves', async ({ page }) => {
  const [target, b, c] = seed(['Target F1B6', 'B F1B6', 'C F1B6']);
  const { control, errors } = await open(page);
  const savedB = savedRow(b);
  const savedC = savedRow(c);
  await refusedSlugDraft(page, control, b);
  await deleteWithHeldRead(page, control, target);
  await nameField(page, c).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' typed');
  await releaseReads(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  expect(mutations).toEqual([['edit', b.id]]);
  expect(detailsPosts(control, c)).toBe(0);
  expect(savedRow(b)).toEqual(savedB);
  expect(savedRow(c)).toEqual(savedC);
  await expect(slugField(page, b)).toHaveValue('Bad Slug!');
  await expect(nameField(page, b)).toHaveValue('B F1B6');
  await expect(nameField(page, c)).toHaveValue('C F1B6 typed');
  await expect(nameField(page, c)).toBeFocused();
  await expect(row(page, c).locator('input[type="checkbox"]')).toBeChecked();
  expect(await rowIds(page)).toEqual([b.id, c.id]);
  // Leaving C saves C only.
  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, c)).toHaveText('Details saved.');
  expect(savedRow(c).display_name).toBe('C F1B6 typed');
  expect(savedRow(b)).toEqual(savedB);
  expect(mutations).toEqual([['edit', b.id], ['edit', c.id]]);
  expect(savedOrder()).toEqual([b.id, c.id]);
  expect(errors).toEqual([]);
});

test('F1-B7: failed refresh, then Retry refresh while a survivor is being edited — reads only; the draft is neither saved nor lost', async ({ page }) => {
  const [target, survivor] = seed(['Target F1B7', 'Survivor F1B7']);
  const { control, errors } = await open(page);
  control.reads = 'fail';
  await deleteButton(page, target).click();
  await confirmButton(page).click();
  const retry = page.locator('[data-settings-category-delete-refresh-retry]');
  await expect(retry).toBeVisible();
  control.reads = 'hold';
  await retry.click();
  await expect.poll(() => control.heldReads.length).toBe(1);
  await nameField(page, survivor).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' retry');
  await releaseReads(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  expect(mutations).toEqual([]);
  expect(detailsPosts(control, survivor)).toBe(0);
  expect(savedRow(survivor).display_name).toBe('Survivor F1B7');
  await expect(nameField(page, survivor)).toHaveValue('Survivor F1B7 retry');
  await expect(nameField(page, survivor)).toBeFocused();
  expect(control.posts).toHaveLength(1);
  expect(executions).toEqual([target.id]);
  expect(errors).toEqual([]);
});

test('F1-B9: keyboard at a narrow viewport — Delete by Enter, Tab into a survivor, edit with a selection through the install, Tab saves once', async ({ page }) => {
  const [target, survivor, other] = seed(['Target F1B9', 'Survivor F1B9', 'Other F1B9']);
  const { control, errors } = await open(page, { width: 360, height: 740 });
  control.reads = 'hold';
  await deleteButton(page, target).focus();
  await page.keyboard.press('Enter');
  await expect(confirmation(page)).toBeVisible();
  await confirmButton(page).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect.poll(() => control.heldReads.length).toBe(1);
  await expect(heading(page)).toBeFocused();
  await expect(confirmation(page)).toBeHidden();
  // Heading, then B's reorder handle, then B's name.
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(nameField(page, survivor)).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.type(' keys');
  await page.keyboard.press('Shift+Home');
  const pre = await fieldState(nameField(page, survivor));
  expect(pre.selection).toEqual([0, 'Survivor F1B9 keys'.length]);
  await releaseReads(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  expect(mutations).toEqual([]);
  const after = await fieldState(nameField(page, survivor));
  expect(after).toMatchObject({ value: 'Survivor F1B9 keys', saved: 'Survivor F1B9', focused: true, selection: pre.selection });
  await page.keyboard.press('ArrowRight');
  await page.keyboard.type('!');
  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, survivor)).toHaveText('Details saved.');
  expect(savedRow(survivor).display_name).toBe('Survivor F1B9 keys!');
  expect(mutations).toEqual([['edit', survivor.id]]);
  expect(control.posts).toHaveLength(1);
  expect(other.exists()).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 0.5)).toBe(true);
  await expectSameDocument(page);
  expect(errors).toEqual([]);
});

test('F1-B10: a browser without atomic moves — the install still saves nothing and keeps the draft and focus; the next real edit and Tab save once', async ({ page }) => {
  await page.addInitScript(() => { delete Element.prototype.moveBefore; });
  const [target, survivor] = seed(['Target F1B10', 'Survivor F1B10']);
  const { control, errors } = await open(page);
  expect(await page.evaluate(() => typeof Element.prototype.moveBefore)).toBe('undefined');
  const before = savedRow(survivor);
  await deleteWithHeldRead(page, control, target);
  await nameField(page, survivor).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' old');
  await releaseReads(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  expect(mutations).toEqual([]);
  expect(detailsPosts(control, survivor)).toBe(0);
  expect(savedRow(survivor)).toEqual(before);
  await expect(nameField(page, survivor)).toHaveValue('Survivor F1B10 old');
  await expect(nameField(page, survivor)).toHaveJSProperty('defaultValue', 'Survivor F1B10');
  await expect(nameField(page, survivor)).toBeFocused();
  // WP11C-F5: typing more first, the browser's own change saves it, and the
  // change the install ended is not raised a second time (Tab alone: F5-B1).
  await page.keyboard.type('er');
  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, survivor)).toHaveText('Details saved.');
  await settle(page);
  expect(savedRow(survivor).display_name).toBe('Survivor F1B10 older');
  expect(detailsPosts(control, survivor)).toBe(1);
  expect(mutations).toEqual([['edit', survivor.id]]);
  expect(errors).toEqual([]);
});

// ------------------------------------------------------------- WP11C-F2 --
// An older Defaults preference answer, rendered before a Delete this page saw
// settle, must not bring the deleted default back as an option or say that the
// current setting is saved and usable.

const PREFS = {
  'browser-default': { select: '#global-asset-browser-default', key: 'asset_browser.default_category', path: '/browser-default' },
  'preview-category': { select: '#global-preview-category', key: 'preview.default_category', path: '/preview-category' },
};
const prefRegion = (page, identity) => page.locator(`[data-settings-asset-category-preference="${identity}"]`);
const prefForm = (page, identity) => prefRegion(page, identity).locator('form');
const prefStatus = (page, identity) => prefRegion(page, identity).locator('[data-settings-fetch-save-status]');
const storedPref = (identity) => db.prepare('SELECT value FROM app_meta WHERE key = ?').pluck().get(PREFS[identity].key) ?? null;
const prefPostsFor = (control, identity) => control.otherPosts.filter((pathname) => pathname.endsWith(PREFS[identity].path)).length;
// In-page reads of the list only, not a preference save's own redirect.
const listReads = (control) => control.reads_.filter((read) => read.pathname === LIST_PATH && !read.search).length;
// What the control offers and says: options that can be chosen (native and
// the dropdown's own radios), the selected value and label, its status line.
const prefView = (page, identity) => prefRegion(page, identity).evaluate((region) => {
  const select = region.querySelector('select');
  const enabled = [...(select?.options || [])].filter((option) => !option.disabled);
  return {
    native: enabled.map((option) => option.value),
    nativeLabels: enabled.map((option) => option.textContent.trim()),
    panel: [...region.querySelectorAll('[data-cc-dropdown] input[type="radio"]')].filter((input) => !input.disabled).map((input) => input.value),
    value: select?.value ?? null,
    summary: region.querySelector('[data-cc-dropdown-summary-current]')?.textContent.trim() || '',
    status: region.querySelector('[data-settings-fetch-save-status]')?.textContent.trim() || '',
    statuses: region.querySelectorAll('[data-settings-fetch-save-status]').length,
    stored: region.getAttribute('data-settings-asset-category-preference-stored'),
    busy: region.querySelector('form')?.getAttribute('aria-busy') === 'true',
    text: region.textContent.replace(/\s+/g, ' '),
  };
});
const choose = (page, identity, value) => page.locator(PREFS[identity].select).evaluate((select, next) => {
  select.value = next;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}, value);

function releasePrefAnswers() {
  prefGate.answers.splice(0).forEach((deliver) => deliver());
}

// The Delete of `category` is confirmed and its POST held in the browser; the
// Defaults preferences are not part of a Delete hold, so they can still save.
async function holdDelete(page, control, category) {
  control.post = 'hold';
  await deleteButton(page, category).click();
  await confirmButton(page).click();
  await expect.poll(() => control.heldPosts.length).toBe(1);
}

async function releaseDelete(control) {
  control.post = 'pass';
  await control.heldPosts.shift().continue();
}

// ORDER A: the preference save runs on the server and its answer (rendered
// with `target` still present) is held; then the Delete runs and its refresh
// installs; the old answer is released by the test.
async function saveThenDelete(page, control, identity, target, value = target.slug) {
  await holdDelete(page, control, target);
  prefGate.holdAnswers = 1;
  await choose(page, identity, value);
  await expect.poll(() => prefGate.rendered).toBe(1);
  expect(storedPref(identity)).toBe(value);
  await releaseDelete(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  expect(target.exists()).toBe(false);
  expect(executions).toEqual([target.id]);
  const kept = await prefView(page, identity);
  expect(kept.busy).toBe(true);
  expect(kept.status).toBe('Saving settings.');
}

for (const [index, identity] of ['browser-default', 'preview-category'].entries()) {
  test(`F2-B${index + 1}: original P2 (${identity}) — an answer older than the Delete cannot restore the default or report the deleted choice as saved`, async ({ page }) => {
    const [target, keep] = seed([`Target F2 ${identity}`, `Keep F2 ${identity}`]);
    const { control, errors } = await open(page);
    const projectsBefore = projectCategoryRows();
    await saveThenDelete(page, control, identity, target);
    // While the save is still pending, the kept control no longer offers it
    // as another choice either.
    const kept = await prefView(page, identity);
    expect(kept.native.filter((value) => value === target.slug && value !== kept.value)).toEqual([]);
    const otherMeta = appMeta().filter((row) => row.key !== PREFS[identity].key);
    const readsBefore = listReads(control);

    releasePrefAnswers();
    await expect(prefForm(page, identity)).not.toHaveAttribute('aria-busy', 'true');
    await settle(page);

    const view = await prefView(page, identity);
    expect(view.native).not.toContain(target.slug);
    expect(view.panel).not.toContain(target.slug);
    expect(view.nativeLabels).not.toContain(target.name);
    expect(view.text).not.toContain('Settings saved.');
    expect(view.text).toContain('Saved setting unavailable');
    expect(view.stored).toBe(target.slug);
    expect(view.native).toContain(keep.slug);
    expect(view.statuses).toBe(1);
    // Display synchronization only: at most one more GET of the list.
    expect(listReads(control)).toBe(readsBefore + 1);
    await expect(feedback(page)).toContainText('The category defaults are up to date.');
    // The persisted setting is truthful and nothing repaired it.
    expect(storedPref(identity)).toBe(target.slug);
    expect(appMeta().filter((row) => row.key !== PREFS[identity].key)).toEqual(otherMeta);
    expect(prefGate.arrivals).toEqual([`${LIST_PATH}${PREFS[identity].path}`]);
    expect(preferencePosts(control)).toHaveLength(1);
    expect(control.posts).toHaveLength(1);
    expect(executions).toEqual([target.id]);
    expect(mutations).toEqual([]);
    expect(projectCategoryRows()).toEqual(projectsBefore);
    await expectSameDocument(page);
    expect(errors).toEqual([]);
  });
}

test('F2-B3: ORDER B — each save reaches the server only after the Delete; the refusal is shown and nothing is saved', async ({ page }) => {
  const [target, keep] = seed(['Target F2B3', 'Keep F2B3']);
  const { control, errors } = await open(page);
  await holdDelete(page, control, target);
  prefGate.holdRequests = 2;
  await choose(page, 'browser-default', target.slug);
  await choose(page, 'preview-category', target.slug);
  await expect.poll(() => prefGate.requests.length).toBe(2);
  await releaseDelete(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  expect(target.exists()).toBe(false);
  prefGate.requests.splice(0).forEach((forward) => forward());
  for (const identity of ['browser-default', 'preview-category']) {
    await expect(prefForm(page, identity)).not.toHaveAttribute('aria-busy', 'true');
  }
  await settle(page);
  for (const identity of ['browser-default', 'preview-category']) {
    const view = await prefView(page, identity);
    expect(view.text).toContain('Could not save');
    expect(view.text).not.toContain('Settings saved.');
    expect(view.nativeLabels).not.toContain(target.name);
    expect(view.native).toContain(keep.slug);
    expect(storedPref(identity)).toBe(null);
  }
  expect(prefGate.arrivals).toHaveLength(2);
  expect(preferencePosts(control)).toHaveLength(2);
  expect(control.posts).toHaveLength(1);
  expect(executions).toEqual([target.id]);
  await expectSameDocument(page);
  expect(errors).toEqual([]);
});

test('F2-B4: after the stale answer, choosing a surviving default saves it once and says so', async ({ page }) => {
  const [target, keep] = seed(['Target F2B4', 'Keep F2B4']);
  const { control, errors } = await open(page);
  await saveThenDelete(page, control, 'preview-category', target);
  releasePrefAnswers();
  await expect(prefRegion(page, 'preview-category')).toContainText('Saved setting unavailable');
  await settle(page);
  const reads = listReads(control);
  await choose(page, 'preview-category', keep.slug);
  await expect(prefStatus(page, 'preview-category')).toHaveText('Settings saved.');
  expect(storedPref('preview-category')).toBe(keep.slug);
  expect(prefPostsFor(control, 'preview-category')).toBe(2);
  expect(listReads(control)).toBe(reads);
  const view = await prefView(page, 'preview-category');
  expect(view.value).toBe(keep.slug);
  expect(view.stored).toBe(keep.slug);
  expect(view.native).not.toContain(target.slug);
  expect(control.posts).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('F2-B5: an older answer for a surviving choice keeps that state without the deleted default; a newer queued choice is not reverted', async ({ page }) => {
  const [target, keep, later] = seed(['Target F2B5', 'Keep F2B5', 'Later F2B5']);
  const { control, errors } = await open(page);
  // The older answer is for a valid choice: it is true that it saved.
  await saveThenDelete(page, control, 'browser-default', target, keep.slug);
  const reads = listReads(control);
  releasePrefAnswers();
  await expect(prefForm(page, 'browser-default')).not.toHaveAttribute('aria-busy', 'true');
  await settle(page);
  let view = await prefView(page, 'browser-default');
  expect(view.native).not.toContain(target.slug);
  expect(view.panel).not.toContain(target.slug);
  expect(view.value).toBe(keep.slug);
  expect(view.stored).toBe(keep.slug);
  expect(view.status).toBe('Settings saved.');
  expect(listReads(control)).toBe(reads);
  expect(storedPref('browser-default')).toBe(keep.slug);

  // A newer choice made while an older answer is held is sent after it, once,
  // and the older answer does not revert it.
  prefGate.holdAnswers = 1;
  await choose(page, 'browser-default', 'all');
  await expect.poll(() => prefGate.rendered).toBe(2);
  await choose(page, 'browser-default', later.slug);
  await settle(page);
  expect(prefPostsFor(control, 'browser-default')).toBe(2);
  releasePrefAnswers();
  await expect.poll(() => prefPostsFor(control, 'browser-default')).toBe(3);
  await expect(prefStatus(page, 'browser-default')).toHaveText('Settings saved.');
  view = await prefView(page, 'browser-default');
  expect(view.value).toBe(later.slug);
  expect(view.stored).toBe(later.slug);
  expect(view.native).not.toContain(target.slug);
  expect(storedPref('browser-default')).toBe(later.slug);
  expect(control.posts).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('F2-B6: failed Delete refresh — the stale answer restores nothing; Retry refresh reads only and shows the unavailable setting', async ({ page }) => {
  const [target] = seed(['Target F2B6', 'Keep F2B6']);
  const { control, errors } = await open(page);
  await holdDelete(page, control, target);
  prefGate.holdAnswers = 1;
  await choose(page, 'preview-category', target.slug);
  await expect.poll(() => prefGate.rendered).toBe(1);
  control.reads = 'fail';
  await releaseDelete(control);
  await expect(feedback(page).getByRole('button', { name: 'Retry refresh' })).toBeVisible();
  expect(target.exists()).toBe(false);
  releasePrefAnswers();
  await expect(prefForm(page, 'preview-category')).not.toHaveAttribute('aria-busy', 'true');
  await settle(page);
  let view = await prefView(page, 'preview-category');
  expect(view.native).not.toContain(target.slug);
  expect(view.panel).not.toContain(target.slug);
  expect(view.status).not.toBe('Settings saved.');
  expect(view.status).toContain('no longer exists');
  expect(view.stored).toBe(target.slug);
  control.reads = 'pass';
  await feedback(page).getByRole('button', { name: 'Retry refresh' }).click();
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await expect(prefRegion(page, 'preview-category')).toContainText('Saved setting unavailable');
  view = await prefView(page, 'preview-category');
  expect(view.native).not.toContain(target.slug);
  expect(storedPref('preview-category')).toBe(target.slug);
  expect(control.posts).toHaveLength(1);
  expect(executions).toEqual([target.id]);
  expect(preferencePosts(control)).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('F2-B7: two preferences answer independently — each keeps its own value, pending state and status', async ({ page }) => {
  const [target, keep] = seed(['Target F2B7', 'Keep F2B7']);
  const { control, errors } = await open(page);
  await holdDelete(page, control, target);
  prefGate.holdAnswers = 2;
  await choose(page, 'browser-default', target.slug);
  await expect.poll(() => prefGate.rendered).toBe(1);
  await choose(page, 'preview-category', keep.slug);
  await expect.poll(() => prefGate.rendered).toBe(2);
  await releaseDelete(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  const [browserAnswer, previewAnswer] = prefGate.answers.splice(0);
  previewAnswer();
  await expect(prefForm(page, 'preview-category')).not.toHaveAttribute('aria-busy', 'true');
  await settle(page);
  let preview = await prefView(page, 'preview-category');
  let browser = await prefView(page, 'browser-default');
  expect(preview.status).toBe('Settings saved.');
  expect(preview.value).toBe(keep.slug);
  expect(preview.native).not.toContain(target.slug);
  expect(browser.busy).toBe(true);
  expect(browser.status).toBe('Saving settings.');
  browserAnswer();
  await expect(prefForm(page, 'browser-default')).not.toHaveAttribute('aria-busy', 'true');
  await expect(prefRegion(page, 'browser-default')).toContainText('Saved setting unavailable');
  await settle(page);
  browser = await prefView(page, 'browser-default');
  preview = await prefView(page, 'preview-category');
  expect(browser.native).not.toContain(target.slug);
  expect(browser.text).not.toContain('Settings saved.');
  expect(preview.value).toBe(keep.slug);
  expect(preview.native).not.toContain(target.slug);
  expect(storedPref('browser-default')).toBe(target.slug);
  expect(storedPref('preview-category')).toBe(keep.slug);
  expect(preferencePosts(control)).toHaveLength(2);
  expect(control.posts).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('F2-B10: keyboard at a narrow viewport — after the stale answer the dropdown never offers the deleted default; a keyboard choice saves once', async ({ page }) => {
  const [target, keep] = seed(['Target F2B10', 'Keep F2B10']);
  const { control, errors } = await open(page, { width: 375, height: 800 });
  await addName(page).fill('Unrelated add draft');
  await saveThenDelete(page, control, 'browser-default', target);
  releasePrefAnswers();
  await expect(prefRegion(page, 'browser-default')).toContainText('Saved setting unavailable');
  await settle(page);
  await prefRegion(page, 'browser-default').locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(prefRegion(page, 'browser-default').locator('details[data-cc-dropdown]')).toHaveAttribute('open', '');
  const radios = prefRegion(page, 'browser-default').locator('[data-cc-dropdown] input[type="radio"]:not([disabled])');
  expect(await radios.evaluateAll((inputs) => inputs.map((input) => input.value))).not.toContain(target.slug);
  await prefRegion(page, 'browser-default').locator(`[data-cc-dropdown] input[type="radio"][value="${keep.slug}"]`).focus();
  await page.keyboard.press('Space');
  await expect(prefStatus(page, 'browser-default')).toHaveText('Settings saved.');
  expect(storedPref('browser-default')).toBe(keep.slug);
  expect(prefPostsFor(control, 'browser-default')).toBe(2);
  expect((await prefView(page, 'browser-default')).statuses).toBe(1);
  await expect(addName(page)).toHaveValue('Unrelated add draft');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(control.posts).toHaveLength(1);
  await expectSameDocument(page);
  expect(errors).toEqual([]);
});

// ------------------------------------------------------------- WP11C-F5 --
// A browser without Element.moveBefore (forced here before any page script
// runs) moves a kept row the ordinary way. That ends the browser's own edit of
// the focused field: the install raises no save (F1), and the person's next
// Tab, click away or Enter must still save the draft exactly once, without
// typing anything more.
const withoutAtomicMoves = async (page) => {
  await page.addInitScript(() => { delete Element.prototype.moveBefore; });
};
const detailsBodies = () => detailsAnswers.bodies;

// Types `suffix` at the end of `field`, focused, through a held list read
// that is then installed; returns the field state before the install.
async function draftThroughInstall(page, control, field, suffix, { select = 0 } = {}) {
  await field.click();
  await page.keyboard.press('End');
  await page.keyboard.type(suffix);
  for (let index = 0; index < select; index += 1) await page.keyboard.press('Shift+ArrowLeft');
  await markField(field);
  const pre = await fieldState(field);
  const posts = control.otherPosts.length;
  await releaseReads(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  expect.soft(control.otherPosts.slice(posts), 'POSTs sent by installing the read').toEqual([]);
  return pre;
}

test('F5-B1: original P2 — fallback install keeps the focused name draft unsaved; one Tab then saves it once with no more typing', async ({ page }) => {
  await withoutAtomicMoves(page);
  const [target, survivor, other] = seed(['Target F5', 'Survivor F5', 'Other F5']);
  const { control, errors } = await open(page);
  expect(await page.evaluate(() => typeof Element.prototype.moveBefore)).toBe('undefined');
  const before = savedRow(survivor);
  await deleteWithHeldRead(page, control, target);
  const draft = 'Survivor F5 draft';
  const pre = await draftThroughInstall(page, control, nameField(page, survivor), ' draft', { select: 2 });
  expect(pre).toMatchObject({ value: draft, saved: 'Survivor F5', focused: true, selection: [draft.length - 2, draft.length] });
  const after = await fieldState(nameField(page, survivor));
  // The same element, its draft, saved value, focus and selection.
  expect(after).toEqual({ ...pre, state: null });
  expect(mutations).toEqual([]);
  expect(savedRow(survivor)).toEqual(before);
  expect(await detailsStatus(page, survivor).textContent()).toBe('');
  expect(await rowIds(page)).toEqual([survivor.id, other.id]);

  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, survivor)).toHaveText('Details saved.');
  await settle(page);
  expect(detailsPosts(control, survivor)).toBe(1);
  expect(mutations).toEqual([['edit', survivor.id]]);
  expect(detailsBodies().map((body) => body.get('displayName'))).toEqual([draft]);
  expect(savedRow(survivor)).toEqual({ ...before, display_name: draft });
  await expect(nameField(page, survivor)).toHaveJSProperty('defaultValue', draft);
  await expect(slugField(page, survivor)).toBeFocused();
  // Leaving the slug unchanged sends nothing more.
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await settle(page);
  expect(detailsPosts(control, survivor)).toBe(1);
  expect(control.posts).toHaveLength(1);
  expect(executions).toEqual([target.id]);
  await expectSameDocument(page);
  expect(errors).toEqual([]);
});

test('F5-B2: slug — fallback install keeps the focused slug draft unsaved; one Tab saves it once', async ({ page }) => {
  await withoutAtomicMoves(page);
  const [target, survivor] = seed(['Target F5B2', 'Survivor F5B2']);
  const { control, errors } = await open(page);
  const before = savedRow(survivor);
  await deleteWithHeldRead(page, control, target);
  const pre = await draftThroughInstall(page, control, slugField(page, survivor), '-draft');
  expect(pre).toMatchObject({ value: `${survivor.slug}-draft`, saved: survivor.slug, focused: true });
  expect(await fieldState(slugField(page, survivor))).toEqual({ ...pre, state: null });
  expect(savedRow(survivor)).toEqual(before);
  expect(mutations).toEqual([]);
  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, survivor)).toHaveText('Details saved.');
  await settle(page);
  expect(detailsPosts(control, survivor)).toBe(1);
  expect(savedRow(survivor)).toEqual({ ...before, directory_slug: `${survivor.slug}-draft` });
  await expect(slugField(page, survivor)).toHaveJSProperty('defaultValue', `${survivor.slug}-draft`);
  // Name, then slug, then name again: each real edit saves once.
  await nameField(page, survivor).fill('Survivor F5B2 renamed');
  await slugField(page, survivor).focus();
  await expect.poll(() => savedRow(survivor).display_name).toBe('Survivor F5B2 renamed');
  await slugField(page, survivor).fill(`${survivor.slug}-again`);
  await nameField(page, survivor).focus();
  await expect.poll(() => savedRow(survivor).directory_slug).toBe(`${survivor.slug}-again`);
  await settle(page);
  expect(detailsPosts(control, survivor)).toBe(3);
  expect(mutations).toEqual([['edit', survivor.id], ['edit', survivor.id], ['edit', survivor.id]]);
  expect(errors).toEqual([]);
});

test('F5-B3: refusals — a duplicate slug and an empty name through the fallback install are refused once by Tab; corrections save once', async ({ page }) => {
  await withoutAtomicMoves(page);
  const [target, survivor, other] = seed(['Target F5B3', 'Survivor F5B3', 'Other F5B3']);
  const { control, errors } = await open(page);
  const before = savedRow(survivor);
  await deleteWithHeldRead(page, control, target);
  await slugField(page, survivor).click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type(other.slug);
  await releaseReads(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  expect(detailsPosts(control, survivor)).toBe(0);
  await expect(slugField(page, survivor)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, survivor)).toHaveText('Could not save category details. Current changes have not been saved.');
  await settle(page);
  expect(detailsPosts(control, survivor)).toBe(1);
  expect(savedRow(survivor)).toEqual(before);
  await expect(slugField(page, survivor)).toHaveValue(other.slug);
  // Corrected and left: one save.
  await slugField(page, survivor).fill(`${survivor.slug}-ok`);
  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, survivor)).toHaveText('Details saved.');
  expect(detailsPosts(control, survivor)).toBe(2);
  expect(savedRow(survivor).directory_slug).toBe(`${survivor.slug}-ok`);

  // An empty name through a second fallback install (GET only).
  control.reads = 'hold';
  await page.evaluate(() => { void document.__creatorCrateSettingsCategoryDelete.controller.refresh(); });
  await expect.poll(() => control.heldReads.length).toBe(1);
  await nameField(page, survivor).click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Backspace');
  await releaseReads(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  expect(detailsPosts(control, survivor)).toBe(2);
  await expect(nameField(page, survivor)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, survivor)).toHaveText('Could not save category details. Current changes have not been saved.');
  await settle(page);
  expect(detailsPosts(control, survivor)).toBe(3);
  expect(savedRow(survivor).display_name).toBe('Survivor F5B3');
  await expect(nameField(page, survivor)).toHaveValue('');
  await nameField(page, survivor).fill('Survivor F5B3 fixed');
  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, survivor)).toHaveText('Details saved.');
  await settle(page);
  expect(detailsPosts(control, survivor)).toBe(4);
  expect(savedRow(survivor)).toMatchObject({ display_name: 'Survivor F5B3 fixed', directory_slug: `${survivor.slug}-ok` });
  expect(savedRow(other).directory_slug).toBe(other.slug);
  expect(mutations).toEqual([['edit', survivor.id], ['edit', survivor.id], ['edit', survivor.id], ['edit', survivor.id]]);
  expect(control.reads_.every((read) => read.method === 'GET')).toBe(true);
  expect(errors).toEqual([]);
});

test('F5-B4: confirmed Delete, then clicking another control finishes the fallback draft — one save of B only; Enter saves once', async ({ page }) => {
  await withoutAtomicMoves(page);
  const [target, b, c] = seed(['Target F5B4', 'B F5B4', 'C F5B4']);
  const { control, errors } = await open(page);
  const savedC = savedRow(c);
  await deleteWithHeldRead(page, control, target);
  await draftThroughInstall(page, control, nameField(page, b), ' clicked');
  expect(mutations).toEqual([]);
  // A pointer click on C's name is the person leaving B.
  await nameField(page, c).click();
  await expect(detailsStatus(page, b)).toHaveText('Details saved.');
  await settle(page);
  expect(savedRow(b).display_name).toBe('B F5B4 clicked');
  expect(detailsPosts(control, b)).toBe(1);
  expect(detailsPosts(control, c)).toBe(0);
  expect(savedRow(c)).toEqual(savedC);
  expect(target.exists()).toBe(false);
  await expect(row(page, target)).toHaveCount(0);

  // Enter after another fallback install: its own submit saves once, and the
  // Tab after it sends nothing more.
  control.reads = 'hold';
  await page.evaluate(() => { void document.__creatorCrateSettingsCategoryDelete.controller.refresh(); });
  await expect.poll(() => control.heldReads.length).toBe(1);
  await draftThroughInstall(page, control, nameField(page, c), ' entered');
  await page.keyboard.press('Enter');
  await expect(detailsStatus(page, c)).toHaveText('Details saved.');
  await page.keyboard.press('Tab');
  await settle(page);
  expect(savedRow(c).display_name).toBe('C F5B4 entered');
  expect(detailsPosts(control, c)).toBe(1);
  expect(mutations).toEqual([['edit', b.id], ['edit', c.id]]);
  expect(control.posts).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('F5-B5: failed refresh, GET-only Retry installed by fallback while B is edited — nothing saved by it; Tab saves once', async ({ page }) => {
  await withoutAtomicMoves(page);
  const [target, survivor] = seed(['Target F5B5', 'Survivor F5B5']);
  const { control, errors } = await open(page);
  control.reads = 'fail';
  await deleteButton(page, target).click();
  await confirmButton(page).click();
  const retry = page.locator('[data-settings-category-delete-refresh-retry]');
  await expect(retry).toBeVisible();
  // A draft typed and left while the list is out of date saves normally.
  await nameField(page, survivor).fill('Survivor F5B5 stale');
  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, survivor)).toHaveText('Details saved.');
  expect(detailsPosts(control, survivor)).toBe(1);
  control.reads = 'hold';
  await retry.click();
  await expect.poll(() => control.heldReads.length).toBe(1);
  await draftThroughInstall(page, control, nameField(page, survivor), ' retry');
  expect(detailsPosts(control, survivor)).toBe(1);
  expect(savedRow(survivor).display_name).toBe('Survivor F5B5 stale');
  await expect(nameField(page, survivor)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect.poll(() => savedRow(survivor).display_name).toBe('Survivor F5B5 stale retry');
  await settle(page);
  expect(detailsPosts(control, survivor)).toBe(2);
  expect(control.posts).toHaveLength(1);
  expect(executions).toEqual([target.id]);
  expect(control.reads_.filter((read) => read.pathname === LIST_PATH).every((read) => read.method === 'GET')).toBe(true);
  expect(errors).toEqual([]);
});

test('F5-B6: two dirty survivors through the fallback install — independent drafts and ids; leaving B saves B only, fixing C saves C only', async ({ page }) => {
  await withoutAtomicMoves(page);
  const [target, b, c] = seed(['Target F5B6', 'B F5B6', 'C F5B6']);
  const { control, errors } = await open(page);
  const savedB = savedRow(b);
  const savedC = savedRow(c);
  await refusedSlugDraft(page, control, c);
  await deleteWithHeldRead(page, control, target);
  await draftThroughInstall(page, control, nameField(page, b), ' typed');
  expect(mutations).toEqual([['edit', c.id]]);
  await expect(slugField(page, c)).toHaveValue('Bad Slug!');
  await expect(row(page, c).locator('form[data-category-details-form]')).toHaveAttribute('data-category-details-state', 'error');
  await expect(nameField(page, b)).toHaveValue('B F5B6 typed');
  expect(await rowIds(page)).toEqual([b.id, c.id]);
  expect(await page.locator('[data-settings-category-defaults] form[data-category-details-form]').count()).toBe(2);
  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, b)).toHaveText('Details saved.');
  await settle(page);
  expect(savedRow(b)).toEqual({ ...savedB, display_name: 'B F5B6 typed' });
  expect(savedRow(c)).toEqual(savedC);
  expect(mutations).toEqual([['edit', c.id], ['edit', b.id]]);
  await slugField(page, c).fill(`${c.slug}-fixed`);
  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, c)).toHaveText('Details saved.');
  await settle(page);
  expect(savedRow(c).directory_slug).toBe(`${c.slug}-fixed`);
  expect(savedRow(b).display_name).toBe('B F5B6 typed');
  expect(mutations).toEqual([['edit', c.id], ['edit', b.id], ['edit', c.id]]);
  expect(savedOrder()).toEqual([b.id, c.id]);
  expect(errors).toEqual([]);
});

test('F5-B7: F4 race in fallback — save A ran, its answer held; newer B typed; read installs; A answers — nothing more sent; Tab saves B once', async ({ page }) => {
  await withoutAtomicMoves(page);
  const [target, survivor] = seed(['Target F5B7', 'Survivor F5B7']);
  const { control, errors } = await open(page);
  await deleteWithHeldRead(page, control, target);
  detailsAnswers.hold = 1;
  await nameField(page, survivor).fill('Survivor F5B7 A');
  await page.keyboard.press('Tab');
  await expect.poll(() => detailsAnswers.held.length).toBe(1);
  expect(savedRow(survivor).display_name).toBe('Survivor F5B7 A');
  await nameField(page, survivor).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' B');
  await releaseReads(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  expect(detailsPosts(control, survivor)).toBe(1);
  await expect(row(page, survivor).locator('form[data-category-details-form]')).toHaveAttribute('aria-busy', 'true');
  detailsAnswers.held.shift()();
  await expect(detailsStatus(page, survivor)).toHaveText('Earlier changes saved. Current changes have not been saved.');
  await settle(page);
  expect(detailsPosts(control, survivor)).toBe(1);
  expect(savedRow(survivor).display_name).toBe('Survivor F5B7 A');
  await expect(nameField(page, survivor)).toHaveValue('Survivor F5B7 A B');
  await expect(nameField(page, survivor)).toHaveJSProperty('defaultValue', 'Survivor F5B7 A');
  await expect(nameField(page, survivor)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, survivor)).toHaveText('Details saved.');
  await settle(page);
  expect(detailsPosts(control, survivor)).toBe(2);
  expect(detailsBodies().map((body) => body.get('displayName'))).toEqual(['Survivor F5B7 A', 'Survivor F5B7 A B']);
  expect(savedRow(survivor).display_name).toBe('Survivor F5B7 A B');
  expect(mutations).toEqual([['edit', survivor.id], ['edit', survivor.id]]);
  expect(errors).toEqual([]);
});

test('F5-B7b: F4 refusal in fallback — the held 422 for A stays with A; the newer draft is kept unsent; Tab saves it once', async ({ page }) => {
  await withoutAtomicMoves(page);
  const [target, survivor, other] = seed(['Target F5B7b', 'Survivor F5B7b', 'Other F5B7b']);
  const { control, errors } = await open(page);
  await deleteWithHeldRead(page, control, target);
  detailsAnswers.hold = 1;
  await slugField(page, survivor).fill(other.slug);
  await page.keyboard.press('Tab');
  await expect.poll(() => detailsAnswers.held.length).toBe(1);
  await slugField(page, survivor).click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type(`${survivor.slug}-b`);
  await releaseReads(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  detailsAnswers.held.shift()();
  await expect(detailsStatus(page, survivor)).toHaveText('Could not save the earlier category details. Current changes have not been saved.');
  await settle(page);
  expect(detailsPosts(control, survivor)).toBe(1);
  expect(savedRow(survivor).directory_slug).toBe(survivor.slug);
  await expect(slugField(page, survivor)).toHaveValue(`${survivor.slug}-b`);
  await expect(slugField(page, survivor)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, survivor)).toHaveText('Details saved.');
  await settle(page);
  expect(detailsPosts(control, survivor)).toBe(2);
  expect(savedRow(survivor).directory_slug).toBe(`${survivor.slug}-b`);
  expect(mutations).toEqual([['edit', survivor.id], ['edit', survivor.id]]);
  expect(errors).toEqual([]);
});

test('F5-B8: out of order — a newer read installs by fallback during the edit; the older read is ignored; nothing saved until Tab, then once', async ({ page }) => {
  await withoutAtomicMoves(page);
  const [target, survivor, other] = seed(['Target F5B8', 'Survivor F5B8', 'Other F5B8']);
  const { control, errors } = await open(page);
  await deleteWithHeldRead(page, control, target);
  // Saved after the older read was answered.
  await slugField(page, other).fill(`${other.slug}-newer`);
  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, other)).toHaveText('Details saved.');
  await nameField(page, survivor).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' draft');
  const older = control.heldReads.splice(0);
  control.reads = 'pass';
  await page.evaluate(() => document.__creatorCrateSettingsCategoryDelete.controller.refresh());
  await settle(page);
  for (const { route, response } of older) await route.fulfill({ response: await response });
  await settle(page);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  expect(detailsPosts(control, survivor)).toBe(0);
  await expect(nameField(page, survivor)).toHaveValue('Survivor F5B8 draft');
  await expect(nameField(page, survivor)).toBeFocused();
  await expect(slugField(page, other)).toHaveValue(`${other.slug}-newer`);
  await expect(slugField(page, other)).toHaveJSProperty('defaultValue', `${other.slug}-newer`);
  await expect(row(page, target)).toHaveCount(0);
  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, survivor)).toHaveText('Details saved.');
  await settle(page);
  expect(detailsPosts(control, survivor)).toBe(1);
  expect(savedRow(survivor).display_name).toBe('Survivor F5B8 draft');
  expect(savedRow(other).directory_slug).toBe(`${other.slug}-newer`);
  expect(mutations).toEqual([['edit', other.id], ['edit', survivor.id]]);
  expect(errors).toEqual([]);
});

test('F5-B9: main path with moveBefore — same element; no install save; one Tab save; no extra change raised', async ({ page }) => {
  const [target, survivor] = seed(['Target F5B9', 'Survivor F5B9']);
  const { control, errors } = await open(page);
  expect(await page.evaluate(() => typeof Element.prototype.moveBefore)).toBe('function');
  await deleteWithHeldRead(page, control, target);
  const pre = await draftThroughInstall(page, control, nameField(page, survivor), ' main', { select: 1 });
  expect(await fieldState(nameField(page, survivor))).toEqual({ ...pre, state: null });
  expect(mutations).toEqual([]);
  expect(await page.evaluate(() => document.__creatorCrateSettingsCategoryDelete.owedChange)).toBeNull();
  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, survivor)).toHaveText('Details saved.');
  await settle(page);
  expect(detailsPosts(control, survivor)).toBe(1);
  expect(savedRow(survivor).display_name).toBe('Survivor F5B9 main');
  expect(errors).toEqual([]);
});

test('F5-B11: keyboard at a narrow viewport (fallback) — selection kept; unchanged field leaves silently; repeated Enter saves once; no next-row Delete', async ({ page }) => {
  await withoutAtomicMoves(page);
  const [target, survivor, other] = seed(['Target F5B11 with a much longer category default name', 'Survivor F5B11', 'Other F5B11']);
  const { control, errors } = await open(page, { width: 360, height: 740 });
  control.reads = 'hold';
  await deleteButton(page, target).focus();
  await page.keyboard.press('Enter');
  await confirmButton(page).focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => control.heldReads.length).toBe(1);
  await expect(heading(page)).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(nameField(page, survivor)).toBeFocused();
  // Focused but unchanged through the install: leaving it sends nothing.
  await releaseReads(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  await expect(nameField(page, survivor)).toBeFocused();
  await page.keyboard.press('Tab');
  await settle(page);
  expect(detailsPosts(control, survivor)).toBe(0);
  await page.keyboard.press('Shift+Tab');
  await expect(nameField(page, survivor)).toBeFocused();
  // Typed, then a second read installs by fallback with a selection.
  control.reads = 'hold';
  await page.evaluate(() => { void document.__creatorCrateSettingsCategoryDelete.controller.refresh(); });
  await expect.poll(() => control.heldReads.length).toBe(1);
  await page.keyboard.press('End');
  await page.keyboard.type(' keys');
  await page.keyboard.press('Shift+Home');
  const pre = await fieldState(nameField(page, survivor));
  await releaseReads(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  expect(await fieldState(nameField(page, survivor))).toMatchObject({ value: 'Survivor F5B11 keys', focused: true, selection: pre.selection });
  expect(detailsPosts(control, survivor)).toBe(0);
  // Each Enter is the form's own submit (as without any install): repeated
  // Enter may save the same values again, never anything else; the Tab after
  // it raises nothing more.
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(detailsStatus(page, survivor)).toHaveText('Details saved.');
  await settle(page);
  const entered = detailsPosts(control, survivor);
  expect(entered).toBeGreaterThanOrEqual(1);
  expect(detailsBodies().every((body) => body.get('displayName') === 'Survivor F5B11 keys')).toBe(true);
  await page.keyboard.press('Tab');
  await settle(page);
  expect(detailsPosts(control, survivor)).toBe(entered);
  expect(savedRow(survivor).display_name).toBe('Survivor F5B11 keys');
  await expect(slugField(page, survivor)).toBeFocused();
  await expect(confirmation(page)).toBeHidden();
  expect(control.posts).toHaveLength(1);
  expect(other.exists()).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 0.5)).toBe(true);
  await expectSameDocument(page);
  expect(errors).toEqual([]);
});

// ------------------------------------------------------------- WP11C-F6 --
// A default deleted in ANOTHER tab of the same application: this page holds
// no Delete record for it and learns that it is gone only from one of its own
// installed list reads. A Defaults setting the read keeps as shown (changed
// after the read began, saving, refused) must stop offering it, and the
// setting's status must not keep saying that a choice of it is saved and
// usable. Nothing is saved to repair the setting, and nothing says this page
// deleted it.

const SAVED_UNAVAILABLE = 'Saved, but that category default no longer exists';

async function releaseReadRequests(control) {
  control.reads = 'pass';
  for (const route of control.heldReadRequests.splice(0)) await route.continue();
}

// Tab 2: the same application in a second tab of the same browser context.
async function otherTab(page) {
  const tab = await page.context().newPage();
  const opened = await open(tab);
  return { tab, ...opened };
}

// Tab 2 deletes `category` through its own confirmed Delete.
async function deleteElsewhere(tab, category) {
  await deleteButton(tab, category).click();
  await confirmButton(tab).click();
  await expect(feedback(tab)).toContainText('The category defaults are up to date.');
  expect(category.exists()).toBe(false);
}

// Tab 1's own supported read of the list: confirming the Delete of an
// unrelated default `other` re-reads the list (GET). With 'holdRequest' that
// read starts now and reaches the server only when released.
async function readByUnrelatedDelete(page, control, other, reads = 'holdRequest') {
  control.reads = reads;
  await deleteButton(page, other).click();
  await confirmButton(page).click();
  await expect(row(page, other)).toHaveCount(0);
  if (reads === 'holdRequest') await expect.poll(() => control.heldReadRequests.length).toBe(1);
}

const preferenceStatuses = (page) => {
  const statuses = [];
  page.on('response', (response) => {
    const { pathname } = new URL(response.url());
    if (response.request().method() === 'POST' && PREFERENCE_PATH.test(pathname)) statuses.push(response.status());
  });
  return statuses;
};

const defaultsWithSlug = (slug) => db.prepare('SELECT id FROM asset_category_defaults WHERE directory_slug = ?').all(slug).map((entry) => entry.id);

for (const [index, identity] of ['browser-default', 'preview-category'].entries()) {
  test(`F6-B${index + 1}: original P2 (${identity}) — deleted in another tab, the installed read stops offering it; the saved setting reads as unavailable; a valid choice then saves once`, async ({ page }) => {
    const [target, keep, other] = seed([`Target F6 ${identity}`, `Keep F6 ${identity}`, `Other F6 ${identity}`]);
    const { control, errors } = await open(page);
    const second = await otherTab(page);
    const projectsBefore = projectCategoryRows();
    await readByUnrelatedDelete(page, control, other);
    // Chosen after the read began: the read keeps this setting as shown.
    await choose(page, identity, target.slug);
    await expect(prefStatus(page, identity)).toHaveText('Settings saved.');
    expect(storedPref(identity)).toBe(target.slug);
    await deleteElsewhere(second.tab, target);
    const prefPosts = preferencePosts(control).length;
    const meta = appMeta();
    const reads = listReads(control);

    await releaseReadRequests(control);
    await expect(feedback(page)).toContainText('The category defaults are up to date.');
    await settle(page);

    // The installed read observed it gone.
    expect(await rowIds(page)).toEqual([keep.id]);
    const view = await prefView(page, identity);
    expect(view.native).not.toContain(target.slug);
    expect(view.panel).not.toContain(target.slug);
    expect(view.nativeLabels).not.toContain(target.name);
    expect(view.native).toContain(keep.slug);
    expect(view.status).not.toContain('Settings saved.');
    expect(view.status).toContain(SAVED_UNAVAILABLE);
    expect(view.stored).toBe(target.slug);
    expect(view.statuses).toBe(1);
    // Observed, not attributed: the feedback is about this page's own Delete.
    await expect(feedback(page)).not.toContainText(target.name);
    // The persisted setting is truthful; nothing repaired it; reads only.
    expect(storedPref(identity)).toBe(target.slug);
    expect(appMeta()).toEqual(meta);
    expect(preferencePosts(control)).toHaveLength(prefPosts);
    expect(listReads(control)).toBe(reads);
    expect(control.posts).toHaveLength(1);
    expect(executions).toEqual([other.id, target.id]);
    expect(mutations).toEqual([]);
    expect(projectCategoryRows()).toEqual(projectsBefore);
    await expectSameDocument(page);

    // A valid choice saves once and says so.
    await choose(page, identity, keep.slug);
    await expect(prefStatus(page, identity)).toHaveText('Settings saved.');
    await settle(page);
    expect(storedPref(identity)).toBe(keep.slug);
    expect(preferencePosts(control)).toHaveLength(prefPosts + 1);
    const after = await prefView(page, identity);
    expect(after.value).toBe(keep.slug);
    expect(after.stored).toBe(keep.slug);
    expect(after.native).not.toContain(target.slug);
    expect(control.posts).toHaveLength(1);
    expect(errors).toEqual([]);
    expect(second.errors).toEqual([]);
  });
}

test('F6-B3: both settings — both on the default, or only one — each reconciles on its own; a valid one keeps its true saved state', async ({ page }) => {
  const [target, keep, other, last] = seed(['Target F6B3', 'Keep F6B3', 'Other F6B3', 'Last F6B3']);
  const { control, errors } = await open(page);
  const second = await otherTab(page);
  // A: both settings name the default.
  await readByUnrelatedDelete(page, control, other);
  await choose(page, 'browser-default', target.slug);
  await expect(prefStatus(page, 'browser-default')).toHaveText('Settings saved.');
  await choose(page, 'preview-category', target.slug);
  await expect(prefStatus(page, 'preview-category')).toHaveText('Settings saved.');
  await deleteElsewhere(second.tab, target);
  await releaseReadRequests(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  for (const identity of ['browser-default', 'preview-category']) {
    const view = await prefView(page, identity);
    expect(view.native).not.toContain(target.slug);
    expect(view.panel).not.toContain(target.slug);
    expect(view.status).toContain(SAVED_UNAVAILABLE);
    expect(view.stored).toBe(target.slug);
    expect(storedPref(identity)).toBe(target.slug);
  }
  expect(preferencePosts(control)).toHaveLength(2);

  // B/C: the browser default moves to a valid default; only the preview
  // category still names the deleted one. Each keeps its own state.
  await choose(page, 'browser-default', keep.slug);
  await expect(prefStatus(page, 'browser-default')).toHaveText('Settings saved.');
  await settle(page);
  const browser = await prefView(page, 'browser-default');
  const preview = await prefView(page, 'preview-category');
  expect(browser.value).toBe(keep.slug);
  expect(browser.native).not.toContain(target.slug);
  expect(preview.native).not.toContain(target.slug);
  expect(storedPref('browser-default')).toBe(keep.slug);
  expect(storedPref('preview-category')).toBe(target.slug);
  expect(preview.status).toContain(SAVED_UNAVAILABLE);
  expect(preferencePosts(control)).toHaveLength(3);

  // The preview category moves to another valid default; the browser
  // default's saved state is untouched by it.
  await choose(page, 'preview-category', last.slug);
  await expect(prefStatus(page, 'preview-category')).toHaveText('Settings saved.');
  await settle(page);
  expect((await prefView(page, 'browser-default')).status).toBe('Settings saved.');
  expect((await prefView(page, 'browser-default')).value).toBe(keep.slug);
  expect(preferencePosts(control)).toHaveLength(4);
  expect(storedPref('preview-category')).toBe(last.slug);
  expect(storedPref('browser-default')).toBe(keep.slug);
  expect(control.posts).toHaveLength(1);
  expect(executions).toEqual([other.id, target.id]);
  await expectSameDocument(page);
  expect(errors).toEqual([]);
});

for (const [index, identity] of ['browser-default', 'preview-category'].entries()) {
  test(`F6-B4${'ab'[index]}: delayed answer (${identity}) — produced before the other tab's Delete, released after this page's read; it cannot restore the default or say it is saved and usable`, async ({ page }) => {
    const [target, keep, other] = seed([`Target F6B4 ${identity}`, `Keep F6B4 ${identity}`, `Other F6B4 ${identity}`]);
    const { control, errors } = await open(page);
    const second = await otherTab(page);
    // This page's own read comes from an unrelated Delete, held first so a
    // preference save can still start (a saving setting refuses Delete).
    await holdDelete(page, control, other);
    prefGate.holdAnswers = 1;
    await choose(page, identity, target.slug);
    await expect.poll(() => prefGate.rendered).toBe(1);
    expect(storedPref(identity)).toBe(target.slug);
    await deleteElsewhere(second.tab, target);
    await releaseDelete(control);
    await expect(feedback(page)).toContainText('The category defaults are up to date.');
    // Kept while saving: the in-flight value stays its save's value.
    const kept = await prefView(page, identity);
    expect(kept.busy).toBe(true);
    expect(kept.status).toBe('Saving settings.');
    expect(kept.value).toBe(target.slug);
    const reads = listReads(control);

    releasePrefAnswers();
    await expect(prefForm(page, identity)).not.toHaveAttribute('aria-busy', 'true');
    await settle(page);

    const view = await prefView(page, identity);
    expect(view.native).not.toContain(target.slug);
    expect(view.panel).not.toContain(target.slug);
    expect(view.nativeLabels).not.toContain(target.name);
    expect(view.text).not.toContain('Settings saved.');
    expect(view.text).toContain('Saved setting unavailable');
    expect(view.stored).toBe(target.slug);
    expect(view.native).toContain(keep.slug);
    expect(view.statuses).toBe(1);
    // GET only, for the server's own unavailable-setting display.
    expect(listReads(control)).toBe(reads + 1);
    expect(storedPref(identity)).toBe(target.slug);
    expect(prefGate.arrivals).toEqual([`${LIST_PATH}${PREFS[identity].path}`]);
    expect(preferencePosts(control)).toHaveLength(1);
    expect(control.posts).toHaveLength(1);
    expect(executions).toEqual([target.id, other.id]);
    expect(mutations).toEqual([]);
    await expect(feedback(page)).not.toContainText(target.name);
    await expectSameDocument(page);
    expect(errors).toEqual([]);
  });
}

test('F6-B5: Delete in another tab before the save runs — the actual 422 refusal is shown for each setting; nothing is saved or recreated', async ({ page }) => {
  const [target, keep, other] = seed(['Target F6B5', 'Keep F6B5', 'Other F6B5']);
  const { control, errors } = await open(page);
  const statuses = preferenceStatuses(page);
  const second = await otherTab(page);
  await holdDelete(page, control, other);
  prefGate.holdRequests = 2;
  await choose(page, 'browser-default', target.slug);
  await choose(page, 'preview-category', target.slug);
  await expect.poll(() => prefGate.requests.length).toBe(2);
  await deleteElsewhere(second.tab, target);
  await releaseDelete(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  prefGate.requests.splice(0).forEach((forward) => forward());
  for (const identity of ['browser-default', 'preview-category']) {
    await expect(prefForm(page, identity)).not.toHaveAttribute('aria-busy', 'true');
  }
  await settle(page);
  expect(statuses).toEqual([422, 422]);
  for (const identity of ['browser-default', 'preview-category']) {
    const view = await prefView(page, identity);
    expect(view.text).toContain('Could not save');
    expect(view.text).not.toContain('Settings saved.');
    // The server's own refusal display: the submitted slug only as its
    // "unavailable" placeholder, never as the deleted default.
    expect(view.nativeLabels).not.toContain(target.name);
    view.native.forEach((value, position) => {
      if (value === target.slug) expect(view.nativeLabels[position]).toContain('unavailable');
    });
    expect(view.native).toContain(keep.slug);
    expect(storedPref(identity)).toBe(null);
  }
  expect(defaultsWithSlug(target.slug)).toEqual([]);
  expect(preferencePosts(control)).toHaveLength(2);
  expect(control.posts).toHaveLength(1);
  expect(executions).toEqual([target.id, other.id]);
  // Corrected after the refusal: one save each.
  await choose(page, 'browser-default', keep.slug);
  await expect(prefStatus(page, 'browser-default')).toHaveText('Settings saved.');
  await choose(page, 'preview-category', keep.slug);
  await expect(prefStatus(page, 'preview-category')).toHaveText('Settings saved.');
  expect(storedPref('browser-default')).toBe(keep.slug);
  expect(storedPref('preview-category')).toBe(keep.slug);
  expect(preferencePosts(control)).toHaveLength(4);
  await expectSameDocument(page);
  expect(errors).toEqual([]);
});

test('F6-B7: out of order — an older read listing the default arrives after a newer installed read without it; it stays unavailable', async ({ page }) => {
  const [target, keep, lost] = seed(['Target F6B7', 'Keep F6B7', 'Lost F6B7']);
  const { control, errors } = await open(page);
  const second = await otherTab(page);
  // An unresolved Delete of `lost` (its request ran, its answer was lost):
  // its automatic Check reads the list; that answer is rendered now, with
  // `target` present, and held.
  control.reads = 'hold';
  control.post = 'lose';
  await deleteButton(page, lost).click();
  await confirmButton(page).click();
  await expect.poll(() => control.heldReads.length).toBe(1);
  await (control.heldReads[0].response);
  const older = control.heldReads.splice(0);
  control.post = 'pass';
  // The newer read (Check again) is held before the server renders it; a
  // valid choice is saved meanwhile (its answer still lists `target`), so the
  // read keeps that setting as shown. Then the other tab deletes `target`.
  control.reads = 'holdRequest';
  await feedback(page).getByRole('button', { name: 'Check again' }).click();
  await expect.poll(() => control.heldReadRequests.length).toBe(1);
  await choose(page, 'browser-default', keep.slug);
  await expect(prefStatus(page, 'browser-default')).toHaveText('Settings saved.');
  expect((await prefView(page, 'browser-default')).native).toContain(target.slug);
  await deleteElsewhere(second.tab, target);
  await releaseReadRequests(control);
  await expect(feedback(page)).toContainText(OBSERVED);
  await settle(page);
  expect(await rowIds(page)).toEqual([keep.id]);
  let view = await prefView(page, 'browser-default');
  expect(view.native).not.toContain(target.slug);
  expect(view.panel).not.toContain(target.slug);
  expect(view.value).toBe(keep.slug);
  expect(view.status).toBe('Settings saved.');
  // The older read now arrives: it installs nothing.
  for (const { route, response } of older) await route.fulfill({ response: await response });
  await settle(page);
  expect(await rowIds(page)).toEqual([keep.id]);
  view = await prefView(page, 'browser-default');
  expect(view.native).not.toContain(target.slug);
  expect(view.panel).not.toContain(target.slug);
  expect((await prefView(page, 'preview-category')).native).not.toContain(target.slug);
  expect(control.posts).toHaveLength(1);
  expect(executions).toEqual([lost.id, target.id]);
  expect(preferencePosts(control)).toHaveLength(1);
  await expectSameDocument(page);
  expect(errors).toEqual([]);
});

test('F6-B8: a failed read observes nothing; GET-only Retry refresh then applies the current defaults', async ({ page }) => {
  const [target, keep, other] = seed(['Target F6B8', 'Keep F6B8', 'Other F6B8']);
  const { control, errors } = await open(page);
  const second = await otherTab(page);
  await readByUnrelatedDelete(page, control, other, 'fail');
  await expect(feedback(page)).toContainText('could not be refreshed');
  // Nothing was learned: the default is still offered, and still exists.
  expect((await prefView(page, 'browser-default')).native).toContain(target.slug);
  control.reads = 'holdRequest';
  await feedback(page).getByRole('button', { name: 'Retry refresh' }).click();
  await expect.poll(() => control.heldReadRequests.length).toBe(1);
  // Saved while the Retry read is held, before the other tab's Delete.
  await choose(page, 'preview-category', keep.slug);
  await expect(prefStatus(page, 'preview-category')).toHaveText('Settings saved.');
  await deleteElsewhere(second.tab, target);
  // Nothing installed yet: this page has not observed it gone.
  expect((await prefView(page, 'preview-category')).native).toContain(target.slug);
  const posts = control.otherPosts.length;
  await releaseReadRequests(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  for (const identity of ['browser-default', 'preview-category']) {
    const view = await prefView(page, identity);
    expect(view.native).not.toContain(target.slug);
    expect(view.panel).not.toContain(target.slug);
  }
  expect((await prefView(page, 'preview-category')).status).toBe('Settings saved.');
  expect(control.otherPosts.slice(posts)).toEqual([]);
  expect(listReads(control)).toBe(2);
  expect(control.posts).toHaveLength(1);
  expect(executions).toEqual([other.id, target.id]);
  await expectSameDocument(page);
  expect(errors).toEqual([]);
});

test('F6-B9: a new default reusing the deleted slug (new id) — the current default is offered under its own name and saves once; the old id is not revived', async ({ page }) => {
  const [target, keep, other] = seed(['Target F6B9', 'Keep F6B9', 'Other F6B9']);
  const { control, errors } = await open(page);
  const second = await otherTab(page);
  await readByUnrelatedDelete(page, control, other);
  // Saved while the read is held; its answer still lists the old default.
  await choose(page, 'browser-default', keep.slug);
  await expect(prefStatus(page, 'browser-default')).toHaveText('Settings saved.');
  await deleteElsewhere(second.tab, target);
  // Tab 2 adds a new default with the same slug through the native Add form.
  await addName(second.tab).fill('Reborn F6B9');
  await second.tab.locator('#add-directorySlug').fill(target.slug);
  await second.tab.locator('form[action="/settings/asset-categories"] button[type="submit"]').click();
  await expect.poll(() => defaultsWithSlug(target.slug).length).toBe(1);
  const [rebornId] = defaultsWithSlug(target.slug);
  expect(rebornId).not.toBe(target.id);
  await releaseReadRequests(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  const ids = await rowIds(page);
  expect(ids).toContain(rebornId);
  expect(ids).not.toContain(target.id);
  const view = await prefView(page, 'browser-default');
  expect(view.native).toContain(target.slug);
  expect(view.panel).toContain(target.slug);
  expect(view.nativeLabels).not.toContain(target.name);
  expect(view.nativeLabels).toContain('Reborn F6B9');
  await choose(page, 'browser-default', target.slug);
  await expect(prefStatus(page, 'browser-default')).toHaveText('Settings saved.');
  await settle(page);
  expect(storedPref('browser-default')).toBe(target.slug);
  expect(preferencePosts(control)).toHaveLength(2);
  const after = await prefView(page, 'browser-default');
  expect(after.value).toBe(target.slug);
  expect(after.summary).toContain('Reborn F6B9');
  expect(control.posts).toHaveLength(1);
  await expectSameDocument(page);
  expect(errors).toEqual([]);
});

for (const [index, fallback] of [false, true].entries()) {
  test(`F6-B${10 + index}: ${fallback ? 'without moveBefore — ' : ''}a dirty focused name through the read that observes the other tab's Delete — nothing saved; the setting reconciles; Tab saves once`, async ({ page }) => {
    if (fallback) await withoutAtomicMoves(page);
    const [target, survivor, other] = seed([`Target F6B1${index}`, `Survivor F6B1${index}`, `Other F6B1${index}`]);
    const { control, errors } = await open(page);
    if (fallback) expect(await page.evaluate(() => typeof Element.prototype.moveBefore)).toBe('undefined');
    const second = await otherTab(page);
    const before = savedRow(survivor);
    await readByUnrelatedDelete(page, control, other);
    await choose(page, 'preview-category', target.slug);
    await expect(prefStatus(page, 'preview-category')).toHaveText('Settings saved.');
    await deleteElsewhere(second.tab, target);
    // The read is released while the survivor's name is being edited.
    const field = nameField(page, survivor);
    await field.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' draft');
    const posts = control.otherPosts.length;
    await releaseReadRequests(control);
    await expect(feedback(page)).toContainText('The category defaults are up to date.');
    await settle(page);
    expect(control.otherPosts.slice(posts)).toEqual([]);
    expect(savedRow(survivor)).toEqual(before);
    await expect(field).toHaveValue(`Survivor F6B1${index} draft`);
    await expect(field).toHaveJSProperty('defaultValue', `Survivor F6B1${index}`);
    await expect(field).toBeFocused();
    const view = await prefView(page, 'preview-category');
    expect(view.native).not.toContain(target.slug);
    expect(view.status).toContain(SAVED_UNAVAILABLE);
    // The person's own Tab saves the draft once (F1/F5).
    await page.keyboard.press('Tab');
    await expect(detailsStatus(page, survivor)).toHaveText('Details saved.');
    await settle(page);
    expect(savedRow(survivor).display_name).toBe(`Survivor F6B1${index} draft`);
    expect(detailsPosts(control, survivor)).toBe(1);
    expect(mutations).toEqual([['edit', survivor.id]]);
    expect(preferencePosts(control)).toHaveLength(1);
    expect(storedPref('preview-category')).toBe(target.slug);
    await expectSameDocument(page);
    expect(errors).toEqual([]);
  });
}

test('F6-B13: keyboard at a narrow viewport — the unavailable setting is explained once; only valid choices are offered; a keyboard choice saves once', async ({ page }) => {
  const [target, keep, other] = seed(['Target F6B13 with a fairly long display name', 'Keep F6B13', 'Other F6B13']);
  const { control, errors } = await open(page, { width: 375, height: 800 });
  const second = await otherTab(page);
  await addName(page).fill('Unrelated add draft');
  await readByUnrelatedDelete(page, control, other);
  await choose(page, 'browser-default', target.slug);
  await expect(prefStatus(page, 'browser-default')).toHaveText('Settings saved.');
  await deleteElsewhere(second.tab, target);
  await releaseReadRequests(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  const region = prefRegion(page, 'browser-default');
  await expect(prefStatus(page, 'browser-default')).toContainText(SAVED_UNAVAILABLE);
  expect(await page.locator('[role="status"]').evaluateAll((nodes, text) => nodes.filter((node) => node.textContent.includes(text)).length, SAVED_UNAVAILABLE)).toBe(1);
  await region.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(region.locator('details[data-cc-dropdown]')).toHaveAttribute('open', '');
  const radios = region.locator('[data-cc-dropdown] input[type="radio"]:not([disabled])');
  expect(await radios.evaluateAll((inputs) => inputs.map((input) => input.value))).not.toContain(target.slug);
  await region.locator(`[data-cc-dropdown] input[type="radio"][value="${keep.slug}"]`).focus();
  await page.keyboard.press('Space');
  await expect(prefStatus(page, 'browser-default')).toHaveText('Settings saved.');
  expect(storedPref('browser-default')).toBe(keep.slug);
  expect(preferencePosts(control)).toHaveLength(2);
  expect((await prefView(page, 'browser-default')).statuses).toBe(1);
  expect(await page.evaluate(() => document.activeElement && document.activeElement !== document.body)).toBe(true);
  await expect(addName(page)).toHaveValue('Unrelated add draft');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(control.posts).toHaveLength(1);
  await expectSameDocument(page);
  expect(errors).toEqual([]);
});

// ---------------------------------------------------------------------------
// WP11C-F8: a default's slug is not fixed. A confirmed Details save renames
// it on this page; when another tab then deletes it, the installed read that
// observes it gone must withdraw the slug it has now, not only the slug it
// had when the page was rendered.

// The person renames `category`'s slug through its own Details form: one
// intentional save (Tab), acknowledged, and in SQLite.
async function renameSlug(page, control, category, slug) {
  const posts = detailsPosts(control, category);
  await slugField(page, category).fill(slug);
  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, category)).toHaveText('Details saved.');
  await expect(slugField(page, category)).toHaveJSProperty('defaultValue', slug);
  expect(savedRow(category).directory_slug).toBe(slug);
  expect(detailsPosts(control, category)).toBe(posts + 1);
}

// The settings offer the renamed slug: the server's own answer to a save of
// another valid choice re-renders the setting from the current list.
async function offerRenamed(page, identity, keep, slug) {
  await choose(page, identity, keep.slug);
  await expect(prefStatus(page, identity)).toHaveText('Settings saved.');
  await settle(page);
  expect((await prefView(page, identity)).native).toContain(slug);
}

for (const [index, identity] of ['browser-default', 'preview-category'].entries()) {
  test(`F8-B${index + 1}: original P2 (${identity}) — renamed here, deleted in another tab; the installed read withdraws the renamed slug; the saved setting reads as unavailable; a valid choice then saves once`, async ({ page }) => {
    const [target, keep, other] = seed([`Target F8 ${identity}`, `Keep F8 ${identity}`, `Other F8 ${identity}`]);
    const { control, errors } = await open(page);
    const second = await otherTab(page);
    const renamed = `${target.slug}-renamed`;
    await renameSlug(page, control, target, renamed);
    expect(mutations).toEqual([['edit', target.id]]);
    await offerRenamed(page, identity, keep, renamed);
    await readByUnrelatedDelete(page, control, other);
    // Chosen after the read began: the read keeps this setting as shown.
    await choose(page, identity, renamed);
    await expect(prefStatus(page, identity)).toHaveText('Settings saved.');
    expect(storedPref(identity)).toBe(renamed);
    await deleteElsewhere(second.tab, target);
    expect(defaultsWithSlug(renamed)).toEqual([]);
    const prefPosts = preferencePosts(control).length;
    const detailsBefore = detailsPosts(control, target);
    const meta = appMeta();
    const reads = listReads(control);

    await releaseReadRequests(control);
    await expect(feedback(page)).toContainText('The category defaults are up to date.');
    await settle(page);

    expect(await rowIds(page)).toEqual([keep.id]);
    for (const each of ['browser-default', 'preview-category']) {
      const view = await prefView(page, each);
      expect(view.native).not.toContain(renamed);
      expect(view.panel).not.toContain(renamed);
      expect(view.native).not.toContain(target.slug);
      expect(view.native).toContain(keep.slug);
    }
    const view = await prefView(page, identity);
    expect(view.value).toBe(renamed);
    expect(view.status).not.toContain('Settings saved.');
    expect(view.status).toContain(SAVED_UNAVAILABLE);
    expect(view.stored).toBe(renamed);
    expect(view.statuses).toBe(1);
    await expect(feedback(page)).not.toContainText(target.name);
    // Truthful and untouched: nothing repaired the setting; reads only.
    expect(storedPref(identity)).toBe(renamed);
    expect(appMeta()).toEqual(meta);
    expect(preferencePosts(control)).toHaveLength(prefPosts);
    expect(detailsPosts(control, target)).toBe(detailsBefore);
    expect(listReads(control)).toBe(reads);
    expect(control.posts).toHaveLength(1);
    expect(executions).toEqual([other.id, target.id]);
    expect(mutations).toEqual([['edit', target.id]]);
    await expectSameDocument(page);

    // A valid choice saves once and says so.
    await choose(page, identity, keep.slug);
    await expect(prefStatus(page, identity)).toHaveText('Settings saved.');
    await settle(page);
    expect(storedPref(identity)).toBe(keep.slug);
    expect(preferencePosts(control)).toHaveLength(prefPosts + 1);
    const after = await prefView(page, identity);
    expect(after.value).toBe(keep.slug);
    expect(after.native).not.toContain(renamed);
    expect(control.posts).toHaveLength(1);
    expect(errors).toEqual([]);
    expect(second.errors).toEqual([]);
  });
}

test('F8-B3: both settings on the renamed default — each reconciles on its own; one valid follow-up save settles only its own setting', async ({ page }) => {
  const [target, keep, other] = seed(['Target F8B3', 'Keep F8B3', 'Other F8B3']);
  const { control, errors } = await open(page);
  const second = await otherTab(page);
  const renamed = `${target.slug}-b3`;
  await renameSlug(page, control, target, renamed);
  await offerRenamed(page, 'browser-default', keep, renamed);
  await offerRenamed(page, 'preview-category', keep, renamed);
  await readByUnrelatedDelete(page, control, other);
  await choose(page, 'browser-default', renamed);
  await expect(prefStatus(page, 'browser-default')).toHaveText('Settings saved.');
  await choose(page, 'preview-category', renamed);
  await expect(prefStatus(page, 'preview-category')).toHaveText('Settings saved.');
  await deleteElsewhere(second.tab, target);
  await releaseReadRequests(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  for (const identity of ['browser-default', 'preview-category']) {
    const view = await prefView(page, identity);
    expect(view.native).not.toContain(renamed);
    expect(view.panel).not.toContain(renamed);
    expect(view.status).toContain(SAVED_UNAVAILABLE);
    expect(view.stored).toBe(renamed);
    expect(storedPref(identity)).toBe(renamed);
  }
  const posts = preferencePosts(control).length;
  await choose(page, 'browser-default', keep.slug);
  await expect(prefStatus(page, 'browser-default')).toHaveText('Settings saved.');
  await settle(page);
  expect(storedPref('browser-default')).toBe(keep.slug);
  expect(storedPref('preview-category')).toBe(renamed);
  const preview = await prefView(page, 'preview-category');
  expect(preview.status).toContain(SAVED_UNAVAILABLE);
  expect(preview.native).not.toContain(renamed);
  expect(preferencePosts(control)).toHaveLength(posts + 1);
  expect(mutations).toEqual([['edit', target.id]]);
  expect(control.posts).toHaveLength(1);
  await expectSameDocument(page);
  expect(errors).toEqual([]);
});

for (const [index, identity] of ['browser-default', 'preview-category'].entries()) {
  test(`F8-B4${'ab'[index]}: delayed answer (${identity}) for the renamed slug — produced before the other tab's Delete, released after this page's read; no option comes back and nothing says it is saved and usable`, async ({ page }) => {
    const [target, keep, other] = seed([`Target F8B4 ${identity}`, `Keep F8B4 ${identity}`, `Other F8B4 ${identity}`]);
    const { control, errors } = await open(page);
    const second = await otherTab(page);
    const renamed = `${target.slug}-b4`;
    await renameSlug(page, control, target, renamed);
    await offerRenamed(page, identity, keep, renamed);
    await holdDelete(page, control, other);
    prefGate.holdAnswers = 1;
    await choose(page, identity, renamed);
    await expect.poll(() => prefGate.rendered).toBe(1);
    expect(storedPref(identity)).toBe(renamed);
    await deleteElsewhere(second.tab, target);
    await releaseDelete(control);
    await expect(feedback(page)).toContainText('The category defaults are up to date.');
    const kept = await prefView(page, identity);
    expect(kept.busy).toBe(true);
    expect(kept.value).toBe(renamed);
    const reads = listReads(control);

    releasePrefAnswers();
    await expect(prefForm(page, identity)).not.toHaveAttribute('aria-busy', 'true');
    await settle(page);

    const view = await prefView(page, identity);
    expect(view.native).not.toContain(renamed);
    expect(view.panel).not.toContain(renamed);
    expect(view.text).not.toContain('Settings saved.');
    expect(view.text).toContain('Saved setting unavailable');
    expect(view.stored).toBe(renamed);
    expect(view.native).toContain(keep.slug);
    expect(view.statuses).toBe(1);
    // GET only, for the server's own unavailable-setting display.
    expect(listReads(control)).toBe(reads + 1);
    expect(storedPref(identity)).toBe(renamed);
    expect(preferencePosts(control)).toHaveLength(2);
    expect(control.posts).toHaveLength(1);
    expect(executions).toEqual([target.id, other.id]);
    expect(mutations).toEqual([['edit', target.id]]);
    await expect(feedback(page)).not.toContainText(target.name);
    await expectSameDocument(page);
    expect(errors).toEqual([]);
  });
}

test('F8-B5: several confirmed renames (alpha → beta → gamma), then deleted elsewhere — the latest slug is withdrawn; a valid default still saves once', async ({ page }) => {
  const [target, keep, other] = seed(['Target F8B5', 'Keep F8B5', 'Other F8B5']);
  const { control, errors } = await open(page);
  const second = await otherTab(page);
  const slugs = ['alpha', 'beta', 'gamma'].map((name) => `${target.slug}-${name}`);
  for (const slug of slugs) await renameSlug(page, control, target, slug);
  expect(mutations).toEqual(slugs.map(() => ['edit', target.id]));
  await offerRenamed(page, 'browser-default', keep, slugs[2]);
  await readByUnrelatedDelete(page, control, other);
  await choose(page, 'browser-default', slugs[2]);
  await expect(prefStatus(page, 'browser-default')).toHaveText('Settings saved.');
  await deleteElsewhere(second.tab, target);
  const posts = control.otherPosts.length;
  await releaseReadRequests(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  for (const identity of ['browser-default', 'preview-category']) {
    const view = await prefView(page, identity);
    for (const slug of [target.slug, ...slugs]) {
      expect(view.native).not.toContain(slug);
      expect(view.panel).not.toContain(slug);
    }
    expect(view.native).toContain(keep.slug);
  }
  expect((await prefView(page, 'browser-default')).status).toContain(SAVED_UNAVAILABLE);
  expect(control.otherPosts.slice(posts)).toEqual([]);
  await choose(page, 'browser-default', keep.slug);
  await expect(prefStatus(page, 'browser-default')).toHaveText('Settings saved.');
  expect(storedPref('browser-default')).toBe(keep.slug);
  expect(control.otherPosts.slice(posts)).toEqual([`${LIST_PATH}/browser-default`]);
  await expectSameDocument(page);
  expect(errors).toEqual([]);
});

test('F8-B6: a stale Details refusal (409) — the slug saved elsewhere is the identity, never the refused draft; deleted elsewhere, that slug is withdrawn', async ({ page }) => {
  const [target, keep, other] = seed(['Target F8B6', 'Keep F8B6', 'Other F8B6']);
  const { control, errors } = await open(page);
  const second = await otherTab(page);
  const elsewhere = `${target.slug}-elsewhere`;
  const proposed = `${target.slug}-proposed`;
  // Tab 2 renames it first; tab 1's own rename, based on the old details, is refused.
  await renameSlug(second.tab, second.control, target, elsewhere);
  const statuses = [];
  page.on('response', (response) => {
    if (response.request().method() === 'POST' && new URL(response.url()).pathname === `${LIST_PATH}/${target.id}`) statuses.push(response.status());
  });
  await slugField(page, target).fill(proposed);
  await page.keyboard.press('Tab');
  await expect(row(page, target).locator('form[data-category-details-form]')).toHaveAttribute('data-category-details-state', 'stale');
  expect(statuses).toEqual([409]);
  expect(savedRow(target).directory_slug).toBe(elsewhere);
  expect(defaultsWithSlug(proposed)).toEqual([]);
  // The draft stays as typed; the saved baseline is the server's.
  await expect(slugField(page, target)).toHaveValue(proposed);
  await expect(slugField(page, target)).toHaveJSProperty('defaultValue', elsewhere);
  await offerRenamed(page, 'preview-category', keep, elsewhere);
  expect((await prefView(page, 'preview-category')).native).not.toContain(proposed);
  await readByUnrelatedDelete(page, control, other);
  await choose(page, 'preview-category', elsewhere);
  await expect(prefStatus(page, 'preview-category')).toHaveText('Settings saved.');
  await deleteElsewhere(second.tab, target);
  const posts = control.otherPosts.length;
  await releaseReadRequests(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  const view = await prefView(page, 'preview-category');
  expect(view.native).not.toContain(elsewhere);
  expect(view.panel).not.toContain(elsewhere);
  expect(view.status).toContain(SAVED_UNAVAILABLE);
  expect(storedPref('preview-category')).toBe(elsewhere);
  expect(control.otherPosts.slice(posts)).toEqual([]);
  expect(statuses).toEqual([409]);
  expect(mutations).toEqual([['edit', target.id], ['edit', target.id]]);
  await expectSameDocument(page);
  expect(errors).toEqual([]);
});

test('F8-B7: out of order — an older read rendered after the rename (target present) arrives after the newer installed read without it; nothing comes back', async ({ page }) => {
  const [target, keep, lost] = seed(['Target F8B7', 'Keep F8B7', 'Lost F8B7']);
  const { control, errors } = await open(page);
  const second = await otherTab(page);
  const renamed = `${target.slug}-b7`;
  await renameSlug(page, control, target, renamed);
  await offerRenamed(page, 'browser-default', keep, renamed);
  control.reads = 'hold';
  control.post = 'lose';
  await deleteButton(page, lost).click();
  await confirmButton(page).click();
  await expect.poll(() => control.heldReads.length).toBe(1);
  await (control.heldReads[0].response);
  const older = control.heldReads.splice(0);
  control.post = 'pass';
  control.reads = 'holdRequest';
  await feedback(page).getByRole('button', { name: 'Check again' }).click();
  await expect.poll(() => control.heldReadRequests.length).toBe(1);
  await choose(page, 'browser-default', renamed);
  await expect(prefStatus(page, 'browser-default')).toHaveText('Settings saved.');
  await deleteElsewhere(second.tab, target);
  await releaseReadRequests(control);
  await expect(feedback(page)).toContainText(OBSERVED);
  await settle(page);
  expect(await rowIds(page)).toEqual([keep.id]);
  let view = await prefView(page, 'browser-default');
  expect(view.native).not.toContain(renamed);
  expect(view.status).toContain(SAVED_UNAVAILABLE);
  for (const { route, response } of older) await route.fulfill({ response: await response });
  await settle(page);
  expect(await rowIds(page)).toEqual([keep.id]);
  view = await prefView(page, 'browser-default');
  expect(view.native).not.toContain(renamed);
  expect(view.panel).not.toContain(renamed);
  expect(view.status).toContain(SAVED_UNAVAILABLE);
  expect((await prefView(page, 'preview-category')).native).not.toContain(renamed);
  expect(control.posts).toHaveLength(1);
  expect(executions).toEqual([lost.id, target.id]);
  expect(preferencePosts(control)).toHaveLength(2);
  expect(mutations).toEqual([['edit', target.id]]);
  await expectSameDocument(page);
  expect(errors).toEqual([]);
});

test('F8-B8: a failed read observes nothing about the renamed default; GET-only Retry refresh withdraws it', async ({ page }) => {
  const [target, keep, other] = seed(['Target F8B8', 'Keep F8B8', 'Other F8B8']);
  const { control, errors } = await open(page);
  const second = await otherTab(page);
  const renamed = `${target.slug}-b8`;
  await renameSlug(page, control, target, renamed);
  await offerRenamed(page, 'preview-category', keep, renamed);
  await readByUnrelatedDelete(page, control, other, 'fail');
  await expect(feedback(page)).toContainText('could not be refreshed');
  control.reads = 'holdRequest';
  await feedback(page).getByRole('button', { name: 'Retry refresh' }).click();
  await expect.poll(() => control.heldReadRequests.length).toBe(1);
  await choose(page, 'preview-category', renamed);
  await expect(prefStatus(page, 'preview-category')).toHaveText('Settings saved.');
  await deleteElsewhere(second.tab, target);
  // Nothing installed yet: this page has not observed it gone.
  expect((await prefView(page, 'preview-category')).native).toContain(renamed);
  const posts = control.otherPosts.length;
  await releaseReadRequests(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  const view = await prefView(page, 'preview-category');
  expect(view.native).not.toContain(renamed);
  expect(view.status).toContain(SAVED_UNAVAILABLE);
  await expect(feedback(page)).not.toContainText(target.name);
  expect(control.otherPosts.slice(posts)).toEqual([]);
  expect(listReads(control)).toBe(2);
  expect(control.posts).toHaveLength(1);
  expect(executions).toEqual([other.id, target.id]);
  await expectSameDocument(page);
  expect(errors).toEqual([]);
});

test('F8-B9: an enabled new default (new id) reuses the renamed slug — offered under its own name and saves once; the old id is not revived', async ({ page }) => {
  const [target, keep, other] = seed(['Target F8B9', 'Keep F8B9', 'Other F8B9']);
  const { control, errors } = await open(page);
  const second = await otherTab(page);
  const renamed = `${target.slug}-b9`;
  await renameSlug(page, control, target, renamed);
  await offerRenamed(page, 'browser-default', keep, renamed);
  await readByUnrelatedDelete(page, control, other);
  await choose(page, 'browser-default', renamed);
  await expect(prefStatus(page, 'browser-default')).toHaveText('Settings saved.');
  await deleteElsewhere(second.tab, target);
  await addName(second.tab).fill('Reborn F8B9');
  await second.tab.locator('#add-directorySlug').fill(renamed);
  await second.tab.locator('form[action="/settings/asset-categories"] button[type="submit"]').click();
  await expect.poll(() => defaultsWithSlug(renamed).length).toBe(1);
  const [rebornId] = defaultsWithSlug(renamed);
  expect(rebornId).not.toBe(target.id);
  await releaseReadRequests(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  const ids = await rowIds(page);
  expect(ids).toContain(rebornId);
  expect(ids).not.toContain(target.id);
  const view = await prefView(page, 'browser-default');
  expect(view.native).toContain(renamed);
  expect(view.panel).toContain(renamed);
  expect(view.nativeLabels).toContain('Reborn F8B9');
  expect(view.nativeLabels).not.toContain(target.name);
  // Its stored slug names a current default again: nothing is unavailable.
  expect(view.status).not.toContain(SAVED_UNAVAILABLE);
  const posts = preferencePosts(control).length;
  await choose(page, 'browser-default', keep.slug);
  await expect(prefStatus(page, 'browser-default')).toHaveText('Settings saved.');
  await choose(page, 'browser-default', renamed);
  await expect(prefStatus(page, 'browser-default')).toHaveText('Settings saved.');
  await settle(page);
  expect(storedPref('browser-default')).toBe(renamed);
  expect(preferencePosts(control)).toHaveLength(posts + 2);
  const after = await prefView(page, 'browser-default');
  expect(after.value).toBe(renamed);
  expect(after.summary).toContain('Reborn F8B9');
  expect(control.posts).toHaveLength(1);
  await expectSameDocument(page);
  expect(errors).toEqual([]);
});

test('F8-B10: name-only edit, slug rename, then a refused case-only draft (422) — identity is the confirmed slug; deleted elsewhere, it is withdrawn', async ({ page }) => {
  const [target, keep, other] = seed(['Target F8B10', 'Keep F8B10', 'Other F8B10']);
  const { control, errors } = await open(page);
  const second = await otherTab(page);
  await nameField(page, target).fill('Target F8B10 renamed');
  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, target)).toHaveText('Details saved.');
  expect(savedRow(target)).toMatchObject({ display_name: 'Target F8B10 renamed', directory_slug: target.slug });
  const renamed = `${target.slug}-b10`;
  await renameSlug(page, control, target, renamed);
  // Slugs are lowercase only: a case-only change is refused and kept as a draft.
  const upper = renamed.toUpperCase();
  await slugField(page, target).fill(upper);
  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, target)).toHaveText('Could not save category details. Current changes have not been saved.');
  await expect(slugField(page, target)).toHaveValue(upper);
  expect(savedRow(target).directory_slug).toBe(renamed);
  await offerRenamed(page, 'browser-default', keep, renamed);
  await readByUnrelatedDelete(page, control, other);
  await choose(page, 'browser-default', renamed);
  await expect(prefStatus(page, 'browser-default')).toHaveText('Settings saved.');
  await deleteElsewhere(second.tab, target);
  const posts = control.otherPosts.length;
  await releaseReadRequests(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  const view = await prefView(page, 'browser-default');
  expect(view.native).not.toContain(renamed);
  expect(view.native).not.toContain(target.slug);
  expect(view.native).not.toContain(upper);
  expect(view.nativeLabels).not.toContain('Target F8B10 renamed');
  expect(view.native).toContain(keep.slug);
  expect(view.status).toContain(SAVED_UNAVAILABLE);
  expect(control.otherPosts.slice(posts)).toEqual([]);
  expect(mutations).toEqual([['edit', target.id], ['edit', target.id], ['edit', target.id]]);
  await expectSameDocument(page);
  expect(errors).toEqual([]);
});

test('F8-B15: keyboard at a narrow viewport — renamed and deleted elsewhere: explained once, only valid choices offered, a keyboard choice saves once', async ({ page }) => {
  const [target, keep, other] = seed(['Target F8B15 with a fairly long display name', 'Keep F8B15', 'Other F8B15']);
  const { control, errors } = await open(page, { width: 375, height: 800 });
  const second = await otherTab(page);
  const renamed = `${target.slug}-b15`;
  await renameSlug(page, control, target, renamed);
  await offerRenamed(page, 'browser-default', keep, renamed);
  await addName(page).fill('Unrelated add draft');
  await readByUnrelatedDelete(page, control, other);
  await choose(page, 'browser-default', renamed);
  await expect(prefStatus(page, 'browser-default')).toHaveText('Settings saved.');
  await deleteElsewhere(second.tab, target);
  await releaseReadRequests(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  const region = prefRegion(page, 'browser-default');
  await expect(prefStatus(page, 'browser-default')).toContainText(SAVED_UNAVAILABLE);
  expect(await page.locator('[role="status"]').evaluateAll((nodes, text) => nodes.filter((node) => node.textContent.includes(text)).length, SAVED_UNAVAILABLE)).toBe(1);
  await region.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(region.locator('details[data-cc-dropdown]')).toHaveAttribute('open', '');
  const radios = region.locator('[data-cc-dropdown] input[type="radio"]:not([disabled])');
  expect(await radios.evaluateAll((inputs) => inputs.map((input) => input.value))).not.toContain(renamed);
  await region.locator(`[data-cc-dropdown] input[type="radio"][value="${keep.slug}"]`).focus();
  await page.keyboard.press('Space');
  await expect(prefStatus(page, 'browser-default')).toHaveText('Settings saved.');
  expect(storedPref('browser-default')).toBe(keep.slug);
  expect((await prefView(page, 'browser-default')).statuses).toBe(1);
  await expect(addName(page)).toHaveValue('Unrelated add draft');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(control.posts).toHaveLength(1);
  await expectSameDocument(page);
  expect(errors).toEqual([]);
});

// ------------------------------------------------------------- WP11C-F9 --
// A default exists is not a default can be chosen. Both Defaults settings
// offer only ENABLED defaults (the server's own rule, which also refuses a
// disabled one). When a default deleted in another tab has its slug again on
// a NEW default (new id) that is DISABLED, the slug must stay unavailable
// here: neither a kept setting, an older answer nor a superseded read may
// offer it, or name it after the disabled default. The disabled default stays
// listed and managed under its own id. Enabled (by a later installed read),
// the slug is a choice again. Nothing is saved to repair anything.

const UNAVAILABLE_DISABLED = (name) => `Saved setting unavailable — ${name} (disabled).`;
const defaultRow = (id) => db.prepare('SELECT id, display_name, directory_slug, enabled FROM asset_category_defaults WHERE id = ?').get(id);

// Tab 2 adds a default through the native Add form, enabled or DISABLED.
async function addElsewhere(tab, name, slug, enabled) {
  await addName(tab).fill(name);
  await tab.locator('#add-directorySlug').fill(slug);
  await tab.locator('#add-enabled').evaluate((input, on) => { input.checked = on; }, enabled);
  await tab.locator('form[action="/settings/asset-categories"] button[type="submit"]').click();
  await expect.poll(() => defaultsWithSlug(slug).length).toBe(1);
  const [id] = defaultsWithSlug(slug);
  expect(defaultRow(id)).toMatchObject({ display_name: name, directory_slug: slug, enabled: enabled ? 1 : 0 });
  await row(tab, { id }).waitFor();
  return { id, name, slug, exists: () => Boolean(defaultRow(id)) };
}

// Tab 2 turns a default on or off with its own in-place status switch.
async function setEnabledElsewhere(tab, category, enabled) {
  const control = tab.locator(`#global-category-enabled-${category.id}`);
  expect(await control.isChecked()).toBe(!enabled);
  await tab.locator(`label[for="global-category-enabled-${category.id}"]`).click();
  await expect.poll(() => defaultRow(category.id)?.enabled).toBe(enabled ? 1 : 0);
  await expect(row(tab, category).locator('form.category-enabled-form')).not.toHaveAttribute('aria-busy', 'true');
}

// Tab 2: the default is deleted, then a new default (new id) takes its slug.
async function replaceElsewhere(tab, target, name, enabled, slug = target.slug) {
  await deleteElsewhere(tab, target);
  const reborn = await addElsewhere(tab, name, slug, enabled);
  expect(reborn.id).not.toBe(target.id);
  expect(target.exists()).toBe(false);
  expect(defaultsWithSlug(slug)).toEqual([reborn.id]);
  return reborn;
}

for (const [index, identity] of ['browser-default', 'preview-category'].entries()) {
  test(`F9-B${index + 1} (B7): original P2 (${identity}) — deleted in another tab and re-added DISABLED with the same slug; the older answer (rendered while it existed) is released after the installed read; the slug is not offered; the saved setting reads as unavailable`, async ({ page }) => {
    const [target, keep, other] = seed([`Target F9B${index + 1}`, `Keep F9B${index + 1}`, `Other F9B${index + 1}`]);
    const { control, errors } = await open(page);
    const second = await otherTab(page);
    const projectsBefore = projectCategoryRows();
    expect((await prefView(page, identity)).native).toContain(target.slug);
    await holdDelete(page, control, other);
    // The save runs now; its answer (listing `target`, enabled) is held.
    prefGate.holdAnswers = 1;
    await choose(page, identity, target.slug);
    await expect.poll(() => prefGate.rendered).toBe(1);
    expect(storedPref(identity)).toBe(target.slug);
    const reborn = await replaceElsewhere(second.tab, target, `Reborn F9B${index + 1}`, false);
    // This page's own Delete settles; its read is the installed current list.
    await releaseDelete(control);
    await expect(feedback(page)).toContainText('The category defaults are up to date.');
    const kept = await prefView(page, identity);
    expect(kept.busy).toBe(true);
    const reads = listReads(control);

    releasePrefAnswers();
    await expect(prefForm(page, identity)).not.toHaveAttribute('aria-busy', 'true');
    await settle(page);

    const view = await prefView(page, identity);
    expect(view.native).not.toContain(target.slug);
    expect(view.panel).not.toContain(target.slug);
    expect(view.nativeLabels).not.toContain(reborn.name);
    expect(view.nativeLabels).not.toContain(target.name);
    expect(view.text).not.toContain('Settings saved.');
    expect(view.text).toContain(UNAVAILABLE_DISABLED(reborn.name));
    expect(view.native).toContain(keep.slug);
    expect(view.stored).toBe(target.slug);
    expect(view.statuses).toBe(1);
    // The other setting never offers it either.
    const otherIdentity = identity === 'browser-default' ? 'preview-category' : 'browser-default';
    expect((await prefView(page, otherIdentity)).native).not.toContain(target.slug);
    // The read showed X gone and Y present but disabled; Y stays managed.
    const ids = await rowIds(page);
    expect(ids).toContain(reborn.id);
    expect(ids).not.toContain(target.id);
    await expect(row(page, reborn)).toHaveAttribute('data-category-enabled', 'false');
    await expect(row(page, reborn).locator(`#global-category-enabled-${reborn.id}`)).not.toBeChecked();
    // GET only, for the server's own unavailable-setting display.
    expect(listReads(control)).toBe(reads + 1);
    expect(storedPref(identity)).toBe(target.slug);
    expect(preferencePosts(control)).toHaveLength(1);
    expect(control.posts).toHaveLength(1);
    expect(executions).toEqual([target.id, other.id]);
    expect(mutations).toEqual([]);
    expect(defaultRow(reborn.id)).toMatchObject({ directory_slug: target.slug, enabled: 0 });
    expect(target.exists()).toBe(false);
    expect(projectCategoryRows()).toEqual(projectsBefore);
    await expect(feedback(page)).not.toContainText(target.name);
    await expect(feedback(page)).not.toContainText(reborn.name);

    // B11: a valid choice saves once and says so.
    await choose(page, identity, keep.slug);
    await expect(prefStatus(page, identity)).toHaveText('Settings saved.');
    await settle(page);
    expect(storedPref(identity)).toBe(keep.slug);
    expect(preferencePosts(control)).toHaveLength(2);
    expect((await prefView(page, identity)).native).not.toContain(target.slug);
    expect(defaultRow(reborn.id)).toMatchObject({ enabled: 0 });
    await expectSameDocument(page);
    expect(errors).toEqual([]);
    expect(second.errors).toEqual([]);
  });
}

for (const [index, identity] of ['browser-default', 'preview-category'].entries()) {
  test(`F9-B${index + 3}: kept setting (${identity}) — chosen after the read began; the read shows the default gone and a DISABLED new default with its slug; the slug is withdrawn, not renamed after it; "Settings saved." corrected`, async ({ page }) => {
    const [target, keep, other] = seed([`Target F9B${index + 3}`, `Keep F9B${index + 3}`, `Other F9B${index + 3}`]);
    const { control, errors } = await open(page);
    const second = await otherTab(page);
    await readByUnrelatedDelete(page, control, other);
    await choose(page, identity, target.slug);
    await expect(prefStatus(page, identity)).toHaveText('Settings saved.');
    const reborn = await replaceElsewhere(second.tab, target, `Reborn F9B${index + 3}`, false);
    const meta = appMeta();
    const reads = listReads(control);
    await releaseReadRequests(control);
    await expect(feedback(page)).toContainText('The category defaults are up to date.');
    await settle(page);

    const view = await prefView(page, identity);
    expect(view.native).not.toContain(target.slug);
    expect(view.panel).not.toContain(target.slug);
    expect(view.nativeLabels).not.toContain(reborn.name);
    expect(view.summary).not.toContain(reborn.name);
    expect(view.status).toContain(SAVED_UNAVAILABLE);
    expect(view.status).not.toContain('Settings saved.');
    expect(view.value).toBe(target.slug);
    expect(view.stored).toBe(target.slug);
    expect(view.native).toContain(keep.slug);
    expect(await rowIds(page)).toEqual([keep.id, reborn.id]);
    await expect(row(page, reborn)).toHaveAttribute('data-category-enabled', 'false');
    expect(appMeta()).toEqual(meta);
    expect(listReads(control)).toBe(reads);
    expect(preferencePosts(control)).toHaveLength(1);
    expect(mutations).toEqual([]);

    await choose(page, identity, keep.slug);
    await expect(prefStatus(page, identity)).toHaveText('Settings saved.');
    await settle(page);
    expect(storedPref(identity)).toBe(keep.slug);
    expect(preferencePosts(control)).toHaveLength(2);
    expect(control.posts).toHaveLength(1);
    await expectSameDocument(page);
    expect(errors).toEqual([]);
    expect(second.errors).toEqual([]);
  });
}

test('F9-B5 (B3): both settings on the slug — each reconciles on its own; one follow-up save settles only its own setting', async ({ page }) => {
  const [target, keep, other] = seed(['Target F9B5', 'Keep F9B5', 'Other F9B5']);
  const { control, errors } = await open(page);
  const second = await otherTab(page);
  await readByUnrelatedDelete(page, control, other);
  for (const identity of ['browser-default', 'preview-category']) {
    await choose(page, identity, target.slug);
    await expect(prefStatus(page, identity)).toHaveText('Settings saved.');
  }
  const reborn = await replaceElsewhere(second.tab, target, 'Reborn F9B5', false);
  await releaseReadRequests(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  for (const identity of ['browser-default', 'preview-category']) {
    const view = await prefView(page, identity);
    expect(view.native).not.toContain(target.slug);
    expect(view.panel).not.toContain(target.slug);
    expect(view.nativeLabels).not.toContain(reborn.name);
    expect(view.status).toContain(SAVED_UNAVAILABLE);
    expect(view.stored).toBe(target.slug);
    expect(storedPref(identity)).toBe(target.slug);
  }
  expect(preferencePosts(control)).toHaveLength(2);
  await choose(page, 'preview-category', keep.slug);
  await expect(prefStatus(page, 'preview-category')).toHaveText('Settings saved.');
  await settle(page);
  expect(storedPref('preview-category')).toBe(keep.slug);
  expect(storedPref('browser-default')).toBe(target.slug);
  const untouched = await prefView(page, 'browser-default');
  expect(untouched.status).toContain(SAVED_UNAVAILABLE);
  expect(untouched.native).not.toContain(target.slug);
  expect(preferencePosts(control)).toHaveLength(3);
  expect(control.posts).toHaveLength(1);
  expect(mutations).toEqual([]);
  await expectSameDocument(page);
  expect(errors).toEqual([]);
});

test('F9-B6 (B4): an ENABLED new default with the slug — the older answer is vetoed but the slug is offered under the new name and saves intentionally once; the old id is not revived', async ({ page }) => {
  const [target, keep, other] = seed(['Target F9B6', 'Keep F9B6', 'Other F9B6']);
  const { control, errors } = await open(page);
  const second = await otherTab(page);
  await holdDelete(page, control, other);
  prefGate.holdAnswers = 1;
  await choose(page, 'browser-default', target.slug);
  await expect.poll(() => prefGate.rendered).toBe(1);
  const reborn = await replaceElsewhere(second.tab, target, 'Reborn F9B6', true);
  await releaseDelete(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  releasePrefAnswers();
  await expect(prefForm(page, 'browser-default')).not.toHaveAttribute('aria-busy', 'true');
  await settle(page);
  const ids = await rowIds(page);
  expect(ids).toContain(reborn.id);
  expect(ids).not.toContain(target.id);
  await expect(row(page, reborn)).toHaveAttribute('data-category-enabled', 'true');
  let view = await prefView(page, 'browser-default');
  expect(view.native).toContain(target.slug);
  expect(view.panel).toContain(target.slug);
  expect(view.nativeLabels).toContain(reborn.name);
  expect(view.nativeLabels).not.toContain(target.name);
  expect(view.text).not.toContain('Saved setting unavailable');
  // Intentionally saved under the current default: away, then back.
  await choose(page, 'browser-default', keep.slug);
  await expect(prefStatus(page, 'browser-default')).toHaveText('Settings saved.');
  await choose(page, 'browser-default', target.slug);
  await expect(prefStatus(page, 'browser-default')).toHaveText('Settings saved.');
  await settle(page);
  expect(storedPref('browser-default')).toBe(target.slug);
  expect(preferencePosts(control)).toHaveLength(3);
  view = await prefView(page, 'browser-default');
  expect(view.value).toBe(target.slug);
  expect(view.summary).toContain(reborn.name);
  expect(target.exists()).toBe(false);
  expect(control.posts).toHaveLength(1);
  expect(mutations).toEqual([]);
  await expectSameDocument(page);
  expect(errors).toEqual([]);
});

test('F9-B7 (B5): the status switch in another tab — disabled → enabled makes the slug a choice again; enabled → disabled withdraws it from a setting kept while saving; nothing saved by availability', async ({ page }) => {
  const [target, keep, otherA, otherB, otherC] = seed(['Target F9B7', 'Keep F9B7', 'Other A F9B7', 'Other B F9B7', 'Other C F9B7']);
  const { control, errors } = await open(page);
  const second = await otherTab(page);
  await readByUnrelatedDelete(page, control, otherA);
  await choose(page, 'browser-default', target.slug);
  await expect(prefStatus(page, 'browser-default')).toHaveText('Settings saved.');
  const reborn = await replaceElsewhere(second.tab, target, 'Reborn F9B7', false);
  await releaseReadRequests(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  expect((await prefView(page, 'browser-default')).native).not.toContain(target.slug);

  // Enabled in Tab 2 by its own switch; Tab 1 learns it from its next read.
  await setEnabledElsewhere(second.tab, reborn, true);
  expect((await prefView(page, 'browser-default')).native).not.toContain(target.slug);
  await readByUnrelatedDelete(page, control, otherB, 'pass');
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  await expect(row(page, reborn)).toHaveAttribute('data-category-enabled', 'true');
  let view = await prefView(page, 'browser-default');
  expect(view.native).toContain(target.slug);
  expect(view.panel).toContain(target.slug);
  expect(view.nativeLabels).toContain(reborn.name);
  expect(view.value).toBe(target.slug);
  expect(view.summary).toContain(reborn.name);
  expect(view.text).not.toContain('Saved setting unavailable');
  expect(preferencePosts(control)).toHaveLength(1);

  // Disabled again in Tab 2 while a save of another choice is held upstream
  // (the setting is kept as shown, saving, through the read).
  await readByUnrelatedDelete(page, control, otherC);
  prefGate.holdRequests = 1;
  await choose(page, 'browser-default', keep.slug);
  await expect.poll(() => prefGate.requests.length).toBe(1);
  await setEnabledElsewhere(second.tab, reborn, false);
  await releaseReadRequests(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  await expect(row(page, reborn)).toHaveAttribute('data-category-enabled', 'false');
  view = await prefView(page, 'browser-default');
  expect(view.busy).toBe(true);
  expect(view.value).toBe(keep.slug);
  expect(view.native).not.toContain(target.slug);
  expect(view.panel).not.toContain(target.slug);
  expect(view.nativeLabels).not.toContain(reborn.name);
  // The held save is its own: released, it saves exactly what was chosen.
  prefGate.requests.splice(0).forEach((forward) => forward());
  await expect(prefStatus(page, 'browser-default')).toHaveText('Settings saved.');
  await settle(page);
  expect(storedPref('browser-default')).toBe(keep.slug);
  view = await prefView(page, 'browser-default');
  expect(view.native).not.toContain(target.slug);
  expect(defaultRow(reborn.id)).toMatchObject({ directory_slug: target.slug, enabled: 0 });
  // Only the person's two choices were ever saved; the switches were Tab 2's.
  expect(preferencePosts(control)).toHaveLength(2);
  expect(mutations.filter(([kind]) => kind !== 'enabled')).toEqual([]);
  expect(mutations.filter(([kind, id]) => kind === 'enabled' && id === reborn.id)).toHaveLength(2);
  expect(errors).toEqual([]);
  expect(second.errors).toEqual([]);
});

test('F9-B8 (B6): F8 rename alpha → beta, deleted in another tab, DISABLED new default takes beta — withdrawn; enabled later, beta is a choice under the new default; the old id never returns', async ({ page }) => {
  const [target, keep, otherA, otherB] = seed(['Target F9B8', 'Keep F9B8', 'Other A F9B8', 'Other B F9B8']);
  const { control, errors } = await open(page);
  const second = await otherTab(page);
  const beta = `${target.slug}-beta`;
  await renameSlug(page, control, target, beta);
  await offerRenamed(page, 'browser-default', keep, beta);
  await readByUnrelatedDelete(page, control, otherA);
  await choose(page, 'browser-default', beta);
  await expect(prefStatus(page, 'browser-default')).toHaveText('Settings saved.');
  expect(storedPref('browser-default')).toBe(beta);
  // Tab 2 still shows the page-load slug; it deletes by id all the same.
  const reborn = await replaceElsewhere(second.tab, target, 'Reborn F9B8', false, beta);
  await releaseReadRequests(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  let view = await prefView(page, 'browser-default');
  expect(view.native).not.toContain(beta);
  expect(view.native).not.toContain(target.slug);
  expect(view.panel).not.toContain(beta);
  expect(view.nativeLabels).not.toContain(reborn.name);
  expect(view.status).toContain(SAVED_UNAVAILABLE);
  expect(view.stored).toBe(beta);
  expect(await rowIds(page)).toEqual([keep.id, otherB.id, reborn.id]);
  expect(preferencePosts(control)).toHaveLength(2);
  expect(mutations).toEqual([['edit', target.id]]);

  await setEnabledElsewhere(second.tab, reborn, true);
  await readByUnrelatedDelete(page, control, otherB, 'pass');
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  view = await prefView(page, 'browser-default');
  expect(view.native).toContain(beta);
  expect(view.nativeLabels).toContain(reborn.name);
  expect(view.summary).toContain(reborn.name);
  expect(await rowIds(page)).toEqual([keep.id, reborn.id]);
  expect(target.exists()).toBe(false);
  expect(storedPref('browser-default')).toBe(beta);
  expect(preferencePosts(control)).toHaveLength(2);
  await expectSameDocument(page);
  expect(errors).toEqual([]);
  expect(second.errors).toEqual([]);
});

for (const [index, identity] of ['browser-default', 'preview-category'].entries()) {
  test(`F9-B${9 + index} (B8): current 422 (${identity}) — the slug saved after the other tab disabled its new default is refused by the service; the refusal stays truthful through the next read; a correction saves once`, async ({ page }) => {
    const [target, keep, other] = seed([`Target F9B${9 + index}`, `Keep F9B${9 + index}`, `Other F9B${9 + index}`]);
    const { control, errors } = await open(page);
    const second = await otherTab(page);
    const statuses = preferenceStatuses(page);
    const reborn = await replaceElsewhere(second.tab, target, `Reborn F9B${9 + index}`, false);
    // This page has read nothing since: it still offers the slug.
    expect((await prefView(page, identity)).native).toContain(target.slug);
    const meta = appMeta();
    await choose(page, identity, target.slug);
    await expect(prefForm(page, identity)).not.toHaveAttribute('aria-busy', 'true');
    await expect(prefRegion(page, identity).locator('[role="alert"]')).toBeVisible();
    await settle(page);
    expect(statuses).toEqual([422]);
    let view = await prefView(page, identity);
    expect(view.text).toContain(identity === 'browser-default'
      ? 'The selected global category is disabled.'
      : 'The selected preview category is disabled.');
    expect(view.text).not.toContain('Settings saved.');
    expect(view.nativeLabels).not.toContain(reborn.name);
    expect(view.nativeLabels).not.toContain(target.name);
    expect(appMeta()).toEqual(meta);
    // The read that observes the old default gone keeps the refused setting
    // as shown (error); the refused slug is not offered as a choice.
    await readByUnrelatedDelete(page, control, other, 'pass');
    await expect(feedback(page)).toContainText('The category defaults are up to date.');
    await settle(page);
    view = await prefView(page, identity);
    expect(view.native).not.toContain(target.slug);
    expect(view.panel).not.toContain(target.slug);
    expect(view.text).toContain('Could not save');
    expect(view.nativeLabels).not.toContain(reborn.name);
    expect(appMeta()).toEqual(meta);
    expect(preferencePosts(control)).toHaveLength(1);
    await choose(page, identity, keep.slug);
    await expect(prefStatus(page, identity)).toHaveText('Settings saved.');
    await settle(page);
    expect(storedPref(identity)).toBe(keep.slug);
    expect(preferencePosts(control)).toHaveLength(2);
    expect(defaultRow(reborn.id)).toMatchObject({ enabled: 0 });
    expect(mutations).toEqual([]);
    await expectSameDocument(page);
    expect(errors).toEqual([]);
  });
}

test('F9-B11 (B9): out of order — an older read (old default enabled) arrives after the newer installed read showing the DISABLED new default; nothing comes back', async ({ page }) => {
  const [target, keep, lost] = seed(['Target F9B11', 'Keep F9B11', 'Lost F9B11']);
  const { control, errors } = await open(page);
  const second = await otherTab(page);
  control.reads = 'hold';
  control.post = 'lose';
  await deleteButton(page, lost).click();
  await confirmButton(page).click();
  await expect.poll(() => control.heldReads.length).toBe(1);
  await (control.heldReads[0].response);
  const older = control.heldReads.splice(0);
  control.post = 'pass';
  control.reads = 'holdRequest';
  await feedback(page).getByRole('button', { name: 'Check again' }).click();
  await expect.poll(() => control.heldReadRequests.length).toBe(1);
  await choose(page, 'browser-default', target.slug);
  await expect(prefStatus(page, 'browser-default')).toHaveText('Settings saved.');
  const reborn = await replaceElsewhere(second.tab, target, 'Reborn F9B11', false);
  await releaseReadRequests(control);
  await expect(feedback(page)).toContainText(OBSERVED);
  await settle(page);
  expect(await rowIds(page)).toEqual([keep.id, reborn.id]);
  let view = await prefView(page, 'browser-default');
  expect(view.native).not.toContain(target.slug);
  expect(view.status).toContain(SAVED_UNAVAILABLE);
  for (const { route, response } of older) await route.fulfill({ response: await response });
  await settle(page);
  expect(await rowIds(page)).toEqual([keep.id, reborn.id]);
  await expect(row(page, reborn)).toHaveAttribute('data-category-enabled', 'false');
  view = await prefView(page, 'browser-default');
  expect(view.native).not.toContain(target.slug);
  expect(view.panel).not.toContain(target.slug);
  expect(view.nativeLabels).not.toContain(reborn.name);
  expect((await prefView(page, 'preview-category')).native).not.toContain(target.slug);
  expect(control.posts).toHaveLength(1);
  expect(executions).toEqual([lost.id, target.id]);
  expect(preferencePosts(control)).toHaveLength(1);
  await expectSameDocument(page);
  expect(errors).toEqual([]);
});

test('F9-B12 (B10): a failed read observes nothing; GET-only Retry refresh then installs the DISABLED new default and withdraws the slug', async ({ page }) => {
  const [target, keep, other] = seed(['Target F9B12', 'Keep F9B12', 'Other F9B12']);
  const { control, errors } = await open(page);
  const second = await otherTab(page);
  await readByUnrelatedDelete(page, control, other, 'fail');
  await expect(feedback(page)).toContainText('could not be refreshed');
  expect((await prefView(page, 'preview-category')).native).toContain(target.slug);
  await expect(row(page, target)).toHaveAttribute('data-category-enabled', 'true');
  control.reads = 'holdRequest';
  await feedback(page).getByRole('button', { name: 'Retry refresh' }).click();
  await expect.poll(() => control.heldReadRequests.length).toBe(1);
  await choose(page, 'preview-category', target.slug);
  await expect(prefStatus(page, 'preview-category')).toHaveText('Settings saved.');
  const reborn = await replaceElsewhere(second.tab, target, 'Reborn F9B12', false);
  expect((await prefView(page, 'preview-category')).native).toContain(target.slug);
  const posts = control.otherPosts.length;
  await releaseReadRequests(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  for (const identity of ['browser-default', 'preview-category']) {
    const view = await prefView(page, identity);
    expect(view.native).not.toContain(target.slug);
    expect(view.panel).not.toContain(target.slug);
  }
  expect((await prefView(page, 'preview-category')).status).toContain(SAVED_UNAVAILABLE);
  expect(await rowIds(page)).toEqual([keep.id, reborn.id]);
  expect(control.otherPosts.slice(posts)).toEqual([]);
  expect(listReads(control)).toBe(2);
  expect(control.posts).toHaveLength(1);
  expect(storedPref('preview-category')).toBe(target.slug);
  await expectSameDocument(page);
  expect(errors).toEqual([]);
});

test('F9-B13 (B16): keyboard at a narrow viewport — the unavailable setting is explained once; the disabled default is not offered; a keyboard choice saves once', async ({ page }) => {
  const [target, keep, other] = seed(['Target F9B13 with a fairly long display name', 'Keep F9B13', 'Other F9B13']);
  const { control, errors } = await open(page, { width: 375, height: 800 });
  const second = await otherTab(page);
  await addName(page).fill('Unrelated add draft');
  await readByUnrelatedDelete(page, control, other);
  await choose(page, 'browser-default', target.slug);
  await expect(prefStatus(page, 'browser-default')).toHaveText('Settings saved.');
  const reborn = await replaceElsewhere(second.tab, target, 'Reborn F9B13', false);
  await releaseReadRequests(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  const region = prefRegion(page, 'browser-default');
  await expect(prefStatus(page, 'browser-default')).toContainText(SAVED_UNAVAILABLE);
  expect(await page.locator('[role="status"]').evaluateAll((nodes, text) => nodes.filter((node) => node.textContent.includes(text)).length, SAVED_UNAVAILABLE)).toBe(1);
  await region.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(region.locator('details[data-cc-dropdown]')).toHaveAttribute('open', '');
  const radios = region.locator('[data-cc-dropdown] input[type="radio"]:not([disabled])');
  expect(await radios.evaluateAll((inputs) => inputs.map((input) => input.value))).not.toContain(target.slug);
  expect(await region.locator('[data-cc-dropdown] label:not([data-cc-dropdown-option-disabled])').evaluateAll((labels, name) => labels.filter((label) => label.textContent.includes(name)).length, reborn.name)).toBe(0);
  await region.locator(`[data-cc-dropdown] input[type="radio"][value="${keep.slug}"]`).focus();
  await page.keyboard.press('Space');
  await expect(prefStatus(page, 'browser-default')).toHaveText('Settings saved.');
  expect(storedPref('browser-default')).toBe(keep.slug);
  expect(preferencePosts(control)).toHaveLength(2);
  expect((await prefView(page, 'browser-default')).statuses).toBe(1);
  expect(await page.evaluate(() => document.activeElement && document.activeElement !== document.body)).toBe(true);
  await expect(addName(page)).toHaveValue('Unrelated add draft');
  await expect(row(page, reborn)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(control.posts).toHaveLength(1);
  expect(control.navigations).toBe(0);
  await expectSameDocument(page);
  expect(errors).toEqual([]);
});

// ------------------------------------------------------------ WP11C-F9A --
// A current id is not current eligibility. Tab 2 deletes X and adds Y (a NEW
// id) with X's slug S, ENABLED. Tab 1 saves S: the save runs and its answer
// is rendered while Y is enabled (it lists Y's current id, enabled, and
// offers S), and that answer is held on its way back. Tab 2 then disables Y
// with its own switch. Tab 1's own read, SENT BEFORE the save but held on
// its way to the server, is rendered only now: it observes Y disabled and
// installs. (The answer does not list any default this page deleted, so the
// WP11C-F2 veto does not apply.) The old answer, released last, must not make S
// choosable again or say "Settings saved." as if S were usable: the
// installed read decides what can be chosen. Nothing is saved to repair it.

const SAVED_DISABLED = 'Saved, but that category default is disabled';

// What a held answer (the save's redirect render) lists and offers.
const answerShows = (page, html, identity, category, slug) => page.evaluate(({ html: text, identity: which, id, slug: value }) => {
  const parsed = new DOMParser().parseFromString(text, 'text/html');
  const article = parsed.querySelector(`[data-settings-category-defaults] article[data-category-id="${id}"]`);
  const select = parsed.querySelector(`[data-settings-asset-category-preference="${which}"] select`);
  const option = [...(select?.options || [])].find((candidate) => candidate.value === value);
  return {
    listed: Boolean(article),
    enabled: article?.getAttribute('data-category-enabled') ?? null,
    offered: Boolean(option) && !option.disabled,
    label: option?.textContent.trim() ?? null,
  };
}, { html, identity, id: category.id, slug });

// Tab 2 replaces X by an ENABLED Y; Tab 1 saves S (answer held), Tab 2
// disables Y, Tab 1's own read installs. Returns what the steps created.
async function f9aOrder(page, control, second, identity, { target, other, name }) {
  const reborn = await replaceElsewhere(second.tab, target, name, true);
  expect(defaultRow(reborn.id)).toMatchObject({ directory_slug: target.slug, enabled: 1 });
  // An unrelated Delete runs now; its read is sent now and held upstream.
  await readByUnrelatedDelete(page, control, other);
  expect(other.exists()).toBe(false);
  prefGate.holdAnswers = 1;
  await choose(page, identity, target.slug);
  await expect.poll(() => prefGate.rendered).toBe(1);
  expect(storedPref(identity)).toBe(target.slug);
  const shown = await answerShows(page, prefGate.bodies[0], identity, reborn, target.slug);
  expect(shown).toEqual({ listed: true, enabled: 'true', offered: true, label: name });
  expect(await answerShows(page, prefGate.bodies[0], identity, target, target.slug)).toMatchObject({ listed: false });
  expect(await answerShows(page, prefGate.bodies[0], identity, other, other.slug)).toMatchObject({ listed: false });
  await setEnabledElsewhere(second.tab, reborn, false);
  expect(defaultRow(reborn.id)).toMatchObject({ directory_slug: target.slug, enabled: 0 });
  await releaseReadRequests(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await expect(row(page, reborn)).toHaveAttribute('data-category-enabled', 'false');
  const kept = await prefView(page, identity);
  expect(kept.busy).toBe(true);
  expect(kept.value).toBe(target.slug);
  return reborn;
}

for (const [index, identity] of ['browser-default', 'preview-category'].entries()) {
  test(`F9A-B${index + 1}: original P2 (${identity}) — the older answer lists Y's CURRENT id enabled; Y disabled since; the newer installed read decides; S is not choosable and nothing says "Settings saved."`, async ({ page }) => {
    const [target, keep, other] = seed([`Target F9AB${index + 1}`, `Keep F9AB${index + 1}`, `Other F9AB${index + 1}`]);
    const { control, errors } = await open(page);
    const second = await otherTab(page);
    const projectsBefore = projectCategoryRows();
    const reborn = await f9aOrder(page, control, second, identity, { target, other, name: `Reborn F9AB${index + 1}` });
    const reads = listReads(control);

    // The GET the vetoed answer starts is held, so the answer's own effect
    // is seen first.
    control.reads = 'holdRequest';
    releasePrefAnswers();
    await expect(prefForm(page, identity)).not.toHaveAttribute('aria-busy', 'true');
    await settle(page);
    const answered = await prefView(page, identity);
    expect(answered.native).not.toContain(target.slug);
    expect(answered.panel).not.toContain(target.slug);
    expect(answered.nativeLabels).not.toContain(reborn.name);
    expect(answered.status).not.toBe('Settings saved.');
    expect(answered.status).toContain(SAVED_UNAVAILABLE);
    expect(answered.value).toBe(target.slug);
    expect(answered.stored).toBe(target.slug);
    expect(answered.native).toContain(keep.slug);
    expect(await prefRegion(page, identity).locator(`select option[value="${target.slug}"]`).getAttribute('data-settings-category-withdrawn')).toBe('');
    await expect.poll(() => control.heldReadRequests.length).toBe(1);
    expect(preferencePosts(control)).toHaveLength(1);
    await releaseReadRequests(control);
    await expect.poll(() => listReads(control)).toBe(reads + 1);
    await expect(feedback(page)).toContainText('The category defaults are up to date.');
    await settle(page);

    const view = await prefView(page, identity);
    expect(view.native).not.toContain(target.slug);
    expect(view.panel).not.toContain(target.slug);
    expect(view.nativeLabels).not.toContain(reborn.name);
    expect(view.text).not.toContain('Settings saved.');
    expect(view.text).toContain(UNAVAILABLE_DISABLED(reborn.name));
    expect(view.native).toContain(keep.slug);
    expect(view.stored).toBe(target.slug);
    expect(view.statuses).toBe(1);
    const otherIdentity = identity === 'browser-default' ? 'preview-category' : 'browser-default';
    expect((await prefView(page, otherIdentity)).native).not.toContain(target.slug);
    // X stays deleted; Y present, disabled, managed under its own id.
    expect(target.exists()).toBe(false);
    expect(await rowIds(page)).toEqual([keep.id, reborn.id]);
    await expect(row(page, reborn).locator(`#global-category-enabled-${reborn.id}`)).not.toBeChecked();
    expect(defaultRow(reborn.id)).toMatchObject({ directory_slug: target.slug, enabled: 0 });
    // The save ran once, as acknowledged; nothing saved since; GET only.
    expect(storedPref(identity)).toBe(target.slug);
    expect(preferencePosts(control)).toHaveLength(1);
    expect(prefGate.arrivals).toEqual([`${LIST_PATH}${PREFS[identity].path}`]);
    expect(control.posts).toHaveLength(1);
    expect(executions).toEqual([target.id, other.id]);
    expect(mutations).toEqual([['enabled', reborn.id]]);
    expect(projectCategoryRows()).toEqual(projectsBefore);
    await expectSameDocument(page);
    expect(errors).toEqual([]);
    expect(second.errors).toEqual([]);
  });
}

test('F9A-B3: both settings — the older browser answer (S) and the older preview answer (T) each reconcile on their own; one GET; neither offers S', async ({ page }) => {
  const [target, keep, other] = seed(['Target F9AB3', 'Keep F9AB3', 'Other F9AB3']);
  const { control, errors } = await open(page);
  const second = await otherTab(page);
  const reborn = await replaceElsewhere(second.tab, target, 'Reborn F9AB3', true);
  await readByUnrelatedDelete(page, control, other);
  prefGate.holdAnswers = 2;
  await choose(page, 'browser-default', target.slug);
  await choose(page, 'preview-category', keep.slug);
  await expect.poll(() => prefGate.rendered).toBe(2);
  expect(storedPref('browser-default')).toBe(target.slug);
  expect(storedPref('preview-category')).toBe(keep.slug);
  await setEnabledElsewhere(second.tab, reborn, false);
  await releaseReadRequests(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  const reads = listReads(control);
  releasePrefAnswers();
  await expect(prefForm(page, 'browser-default')).not.toHaveAttribute('aria-busy', 'true');
  await expect(prefForm(page, 'preview-category')).not.toHaveAttribute('aria-busy', 'true');
  await expect.poll(() => listReads(control)).toBe(reads + 1);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  expect(listReads(control)).toBe(reads + 1);
  const browser = await prefView(page, 'browser-default');
  const preview = await prefView(page, 'preview-category');
  expect(browser.native).not.toContain(target.slug);
  expect(preview.native).not.toContain(target.slug);
  expect(browser.text).toContain(UNAVAILABLE_DISABLED(reborn.name));
  expect(browser.text).not.toContain('Settings saved.');
  expect(preview.value).toBe(keep.slug);
  expect(preview.stored).toBe(keep.slug);
  expect(preview.text).not.toContain('Saved setting unavailable');
  expect(storedPref('browser-default')).toBe(target.slug);
  expect(storedPref('preview-category')).toBe(keep.slug);
  expect(preferencePosts(control)).toHaveLength(2);
  expect(mutations).toEqual([['enabled', reborn.id]]);
  expect(errors).toEqual([]);
});

test('F9A-B4 / B12: a save held before it runs while Y is disabled and the read installs — the payload stays S (no extra POST); its current 422 is shown as the server rendered it', async ({ page }) => {
  const [target, keep, other] = seed(['Target F9AB4', 'Keep F9AB4', 'Other F9AB4']);
  const { control, errors } = await open(page);
  const second = await otherTab(page);
  const statuses = preferenceStatuses(page);
  const reborn = await replaceElsewhere(second.tab, target, 'Reborn F9AB4', true);
  await holdDelete(page, control, other);
  prefGate.holdRequests = 1;
  await choose(page, 'browser-default', target.slug);
  await expect.poll(() => prefGate.requests.length).toBe(1);
  await setEnabledElsewhere(second.tab, reborn, false);
  const meta = appMeta();
  await releaseDelete(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  // Kept while saving: the in-flight value is untouched (no new change).
  let view = await prefView(page, 'browser-default');
  expect(view.busy).toBe(true);
  expect(view.value).toBe(target.slug);
  expect(preferencePosts(control)).toHaveLength(1);
  prefGate.requests.splice(0).forEach((forward) => forward());
  await expect(prefForm(page, 'browser-default')).not.toHaveAttribute('aria-busy', 'true');
  await expect(prefRegion(page, 'browser-default').locator('[role="alert"]')).toBeVisible();
  await settle(page);
  expect(statuses).toEqual([422]);
  view = await prefView(page, 'browser-default');
  expect(view.text).toContain('The selected global category is disabled.');
  expect(view.text).not.toContain('Settings saved.');
  expect(view.nativeLabels).not.toContain(reborn.name);
  // The submitted value follows the server's placeholder convention.
  const placeholder = await prefRegion(page, 'browser-default').locator(`select option[value="${target.slug}"]`).allTextContents();
  expect(placeholder.map((text) => text.trim())).toEqual(['Submitted value is unavailable; choose a valid replacement.']);
  expect(appMeta()).toEqual(meta);
  expect(preferencePosts(control)).toHaveLength(1);
  // A valid choice afterward saves once.
  await choose(page, 'browser-default', keep.slug);
  await expect(prefStatus(page, 'browser-default')).toHaveText('Settings saved.');
  expect(storedPref('browser-default')).toBe(keep.slug);
  expect(preferencePosts(control)).toHaveLength(2);
  expect(mutations).toEqual([['enabled', reborn.id]]);
  expect(errors).toEqual([]);
});

test('F9A-B5 / B6 / B9: enabled follow-up — Y enabled in Tab 2 and read here: S is offered under Y and saves once; disabled again, the next read withdraws S; nothing saved by availability', async ({ page }) => {
  const [target, keep, other, otherB, otherC] = seed(['Target F9AB5', 'Keep F9AB5', 'Other F9AB5', 'Other B F9AB5', 'Other C F9AB5']);
  const { control, errors } = await open(page);
  const second = await otherTab(page);
  const reborn = await f9aOrder(page, control, second, 'browser-default', { target, other, name: 'Reborn F9AB5' });
  releasePrefAnswers();
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  expect((await prefView(page, 'browser-default')).native).not.toContain(target.slug);

  await setEnabledElsewhere(second.tab, reborn, true);
  await readByUnrelatedDelete(page, control, otherB, 'pass');
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  await expect(row(page, reborn)).toHaveAttribute('data-category-enabled', 'true');
  let view = await prefView(page, 'browser-default');
  expect(view.native).toContain(target.slug);
  expect(view.panel).toContain(target.slug);
  expect(view.nativeLabels).toContain(reborn.name);
  expect(view.nativeLabels).not.toContain(target.name);
  expect(preferencePosts(control)).toHaveLength(1);
  // Intentionally chosen (it is stored already, so choose T then S).
  await choose(page, 'browser-default', keep.slug);
  await expect(prefStatus(page, 'browser-default')).toHaveText('Settings saved.');
  await choose(page, 'browser-default', target.slug);
  await expect(prefStatus(page, 'browser-default')).toHaveText('Settings saved.');
  await settle(page);
  expect(storedPref('browser-default')).toBe(target.slug);
  expect(preferencePosts(control)).toHaveLength(3);

  await setEnabledElsewhere(second.tab, reborn, false);
  await readByUnrelatedDelete(page, control, otherC, 'pass');
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  view = await prefView(page, 'browser-default');
  expect(view.native).not.toContain(target.slug);
  expect(view.panel).not.toContain(target.slug);
  expect(view.text).toContain(UNAVAILABLE_DISABLED(reborn.name));
  expect(storedPref('browser-default')).toBe(target.slug);
  expect(preferencePosts(control)).toHaveLength(3);
  expect(mutations).toEqual([['enabled', reborn.id], ['enabled', reborn.id], ['enabled', reborn.id]]);
  expect(target.exists()).toBe(false);
  expect(errors).toEqual([]);
});

test('F9A-B10: out of order — an older read (Y enabled) answers after the newer installed read (Y disabled); the older answer is then still not installed', async ({ page }) => {
  const [target, keep, lost] = seed(['Target F9AB10', 'Keep F9AB10', 'Lost F9AB10']);
  const { control, errors } = await open(page);
  const second = await otherTab(page);
  const reborn = await replaceElsewhere(second.tab, target, 'Reborn F9AB10', true);
  // A lost Delete answer: its Check read (rendered now, Y enabled) is held.
  control.reads = 'hold';
  control.post = 'lose';
  await deleteButton(page, lost).click();
  await confirmButton(page).click();
  await expect.poll(() => control.heldReads.length).toBe(1);
  await (control.heldReads[0].response);
  const older = control.heldReads.splice(0);
  control.post = 'pass';
  prefGate.holdAnswers = 1;
  await choose(page, 'browser-default', target.slug);
  await expect.poll(() => prefGate.rendered).toBe(1);
  await setEnabledElsewhere(second.tab, reborn, false);
  control.reads = 'holdRequest';
  await feedback(page).getByRole('button', { name: 'Check again' }).click();
  await expect.poll(() => control.heldReadRequests.length).toBe(1);
  await releaseReadRequests(control);
  await expect(feedback(page)).toContainText(OBSERVED);
  await expect(row(page, reborn)).toHaveAttribute('data-category-enabled', 'false');
  for (const { route, response } of older) await route.fulfill({ response: await response });
  await settle(page);
  await expect(row(page, reborn)).toHaveAttribute('data-category-enabled', 'false');
  control.reads = 'pass';
  releasePrefAnswers();
  await expect(prefForm(page, 'browser-default')).not.toHaveAttribute('aria-busy', 'true');
  await settle(page);
  const view = await prefView(page, 'browser-default');
  expect(view.native).not.toContain(target.slug);
  expect(view.panel).not.toContain(target.slug);
  expect(view.nativeLabels).not.toContain(reborn.name);
  expect(view.text).not.toContain('Settings saved.');
  expect(await rowIds(page)).toEqual([keep.id, reborn.id]);
  expect(storedPref('browser-default')).toBe(target.slug);
  expect(preferencePosts(control)).toHaveLength(1);
  expect(control.posts).toHaveLength(1);
  expect(executions).toEqual([target.id, lost.id]);
  expect(errors).toEqual([]);
});

test('F9A-B11: a failed read observes nothing (the answer, newer than anything installed, installs); GET-only Retry refresh then installs Y disabled and withdraws S', async ({ page }) => {
  const [target, keep, other] = seed(['Target F9AB11', 'Keep F9AB11', 'Other F9AB11']);
  const { control, errors } = await open(page);
  const second = await otherTab(page);
  const reborn = await replaceElsewhere(second.tab, target, 'Reborn F9AB11', true);
  await readByUnrelatedDelete(page, control, other, 'fail');
  await expect(feedback(page)).toContainText('could not be refreshed');
  prefGate.holdAnswers = 1;
  await choose(page, 'browser-default', target.slug);
  await expect.poll(() => prefGate.rendered).toBe(1);
  await setEnabledElsewhere(second.tab, reborn, false);
  releasePrefAnswers();
  await expect(prefStatus(page, 'browser-default')).toHaveText('Settings saved.');
  await settle(page);
  const posts = control.otherPosts.length;
  const reads = listReads(control);
  control.reads = 'pass';
  await feedback(page).getByRole('button', { name: 'Retry refresh' }).click();
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  await expect(row(page, reborn)).toHaveAttribute('data-category-enabled', 'false');
  const view = await prefView(page, 'browser-default');
  expect(view.native).not.toContain(target.slug);
  expect(view.panel).not.toContain(target.slug);
  expect(view.text).toContain(UNAVAILABLE_DISABLED(reborn.name));
  expect(control.otherPosts.slice(posts)).toEqual([]);
  expect(listReads(control)).toBe(reads + 1);
  expect(storedPref('browser-default')).toBe(target.slug);
  expect(preferencePosts(control)).toHaveLength(1);
  expect(keep.exists()).toBe(true);
  expect(errors).toEqual([]);
});

test('F9A-B15: keyboard at a narrow viewport — after the vetoed answer the disabled slug is not offered, one status explains it; a keyboard choice saves once; no navigation', async ({ page }) => {
  const [target, keep, other] = seed(['Target F9AB15 with a fairly long display name', 'Keep F9AB15', 'Other F9AB15']);
  const { control, errors } = await open(page, { width: 375, height: 800 });
  const second = await otherTab(page);
  const reborn = await f9aOrder(page, control, second, 'browser-default', { target, other, name: 'Reborn F9AB15 with a fairly long name' });
  releasePrefAnswers();
  await expect(prefForm(page, 'browser-default')).not.toHaveAttribute('aria-busy', 'true');
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  const region = prefRegion(page, 'browser-default');
  await expect(region).toContainText(UNAVAILABLE_DISABLED(reborn.name));
  expect((await prefView(page, 'browser-default')).statuses).toBe(1);
  await region.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(region.locator('details[data-cc-dropdown]')).toHaveAttribute('open', '');
  const radios = region.locator('[data-cc-dropdown] input[type="radio"]:not([disabled])');
  expect(await radios.evaluateAll((inputs) => inputs.map((input) => input.value))).not.toContain(target.slug);
  await region.locator(`[data-cc-dropdown] input[type="radio"][value="${keep.slug}"]`).focus();
  await page.keyboard.press('Space');
  await expect(prefStatus(page, 'browser-default')).toHaveText('Settings saved.');
  expect(storedPref('browser-default')).toBe(keep.slug);
  expect(preferencePosts(control)).toHaveLength(2);
  expect((await prefView(page, 'browser-default')).statuses).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(control.navigations).toBe(0);
  await expectSameDocument(page);
  expect(errors).toEqual([]);
});

// ------------------------------------------------------------ WP11C-F9B --
// A list read older than an acknowledged Defaults save cannot roll it back.
// T is saved. The person chooses S; that save reaches the upstream gate and
// is held BEFORE its route runs. Retry refresh then sends the list read,
// which the server renders now (T still stored) and whose answer is held on
// its way back. The save is released: the service stores S and the page
// acknowledges it ("Settings saved."). The older read is released last. It
// must not install T as the selected value or the saved baseline: SQLite
// holds S, and choosing T afterwards must be a new change that saves once.

// What a held read (the list page as the server rendered it) shows stored
// and selected for a setting.
const renderedPref = (page, html, identity) => page.evaluate(({ html: text, identity: which }) => {
  const parsed = new DOMParser().parseFromString(text, 'text/html');
  const region = parsed.querySelector(`[data-settings-asset-category-preference="${which}"]`);
  return {
    stored: region?.getAttribute('data-settings-asset-category-preference-stored') ?? null,
    value: region?.querySelector('select')?.value ?? null,
  };
}, { html, identity });

// The person picks `value` in the dropdown with the pointer.
async function pickPref(page, identity, value) {
  const region = prefRegion(page, identity);
  await region.locator('summary').click();
  await expect(region.locator('details[data-cc-dropdown]')).toHaveAttribute('open', '');
  await region.locator(`[data-cc-dropdown] input[type="radio"][value="${value}"]`).locator('xpath=ancestor::label[1]').click();
}

// Saves `value` normally and waits for its acknowledgement.
async function savePref(page, identity, value) {
  await choose(page, identity, value);
  await expect(prefForm(page, identity)).not.toHaveAttribute('aria-busy', 'true');
  await expect(prefStatus(page, identity)).toHaveText('Settings saved.');
  expect(storedPref(identity)).toBe(value);
}

// The list is marked possibly out of date by a failed read, so Retry refresh
// (GET only) is offered.
async function staleList(page, control, other) {
  await readByUnrelatedDelete(page, control, other, 'fail');
  await expect(feedback(page)).toContainText('could not be refreshed');
  await feedback(page).getByRole('button', { name: 'Retry refresh' }).waitFor();
}

// Holds the next save upstream before its route runs.
async function holdSave(page, identity, value) {
  const held = prefGate.requests.length;
  prefGate.holdRequests += 1;
  await choose(page, identity, value);
  await expect.poll(() => prefGate.requests.length).toBe(held + 1);
  await expect(prefForm(page, identity)).toHaveAttribute('aria-busy', 'true');
}

// Retry refresh with its read rendered now and held on its way back
// ('hold', returns the rendered page), or held before it reaches the server
// ('holdRequest').
async function retryHeld(page, control, reads = 'hold') {
  control.reads = reads;
  await feedback(page).getByRole('button', { name: 'Retry refresh' }).click();
  if (reads === 'hold') {
    await expect.poll(() => control.heldReads.length).toBe(1);
    return (await control.heldReads[0].response).text();
  }
  await expect.poll(() => control.heldReadRequests.length).toBe(1);
  return null;
}

for (const [index, identity] of ['browser-default', 'preview-category'].entries()) {
  test(`F9B-B${index + 1} / B4: original P2 (${identity}) — a read rendered with T before the save of S runs, delivered after S is acknowledged, cannot roll S back; T chosen afterwards saves once`, async ({ page }) => {
    const [s, t, other] = seed([`S F9BB${index + 1}`, `T F9BB${index + 1}`, `Other F9BB${index + 1}`]);
    const { control, errors } = await open(page);
    await savePref(page, identity, t.slug);
    await staleList(page, control, other);
    const statuses = preferenceStatuses(page);
    const posts = preferencePosts(control).length;
    const arrivals = prefGate.arrivals.length;
    const reads = listReads(control);
    await holdSave(page, identity, s.slug);
    expect(storedPref(identity)).toBe(t.slug);
    const html = await retryHeld(page, control);
    // The read ran on the server while T was still stored.
    expect(await renderedPref(page, html, identity)).toEqual({ stored: t.slug, value: t.slug });
    expect(storedPref(identity)).toBe(t.slug);
    // The save runs now and is acknowledged.
    prefGate.requests.shift()();
    await expect(prefStatus(page, identity)).toHaveText('Settings saved.');
    await expect(prefForm(page, identity)).not.toHaveAttribute('aria-busy', 'true');
    expect(storedPref(identity)).toBe(s.slug);
    expect(await prefView(page, identity)).toMatchObject({ value: s.slug, stored: s.slug, busy: false });
    // The older read arrives last.
    await releaseReads(control);
    await expect(feedback(page)).toContainText('The category defaults are up to date.');
    await settle(page);
    const view = await prefView(page, identity);
    expect(storedPref(identity)).toBe(s.slug);
    expect(view.value).toBe(s.slug);
    expect(view.stored).toBe(s.slug);
    expect(view.summary).toContain(s.name);
    expect(view.status).toBe('Settings saved.');
    expect(view.statuses).toBe(1);
    expect(view.native).toEqual(expect.arrayContaining([s.slug, t.slug]));
    expect(preferencePosts(control).length).toBe(posts + 1);
    expect(prefGate.arrivals.length).toBe(arrivals + 1);
    expect(statuses).toEqual([302]);
    expect(listReads(control)).toBe(reads + 1);
    expect(await feedback(page).getByRole('button', { name: 'Retry refresh' }).count()).toBe(0);
    // B4: T, chosen intentionally in the dropdown, is a new change: one save.
    await pickPref(page, identity, t.slug);
    await expect(prefStatus(page, identity)).toHaveText('Settings saved.');
    await expect(prefForm(page, identity)).not.toHaveAttribute('aria-busy', 'true');
    expect(storedPref(identity)).toBe(t.slug);
    expect(preferencePosts(control).length).toBe(posts + 2);
    expect(statuses).toEqual([302, 302]);
    expect(await prefView(page, identity)).toMatchObject({ value: t.slug, stored: t.slug });
    expect(control.navigations).toBe(0);
    await expectSameDocument(page);
    expect(errors).toEqual([]);
  });
}

test('F9B-B3: both settings saving through the same older read, acknowledged in the other order — each keeps its own acknowledged value', async ({ page }) => {
  const [s, t, other, u] = seed(['S F9BB3', 'T F9BB3', 'Other F9BB3', 'U F9BB3']);
  const { control, errors } = await open(page);
  await savePref(page, 'browser-default', t.slug);
  await savePref(page, 'preview-category', t.slug);
  await staleList(page, control, other);
  const posts = preferencePosts(control).length;
  await holdSave(page, 'browser-default', s.slug);
  await holdSave(page, 'preview-category', u.slug);
  const html = await retryHeld(page, control);
  expect(await renderedPref(page, html, 'browser-default')).toEqual({ stored: t.slug, value: t.slug });
  expect(await renderedPref(page, html, 'preview-category')).toEqual({ stored: t.slug, value: t.slug });
  // Released in the other order: preview first, then browser.
  prefGate.requests.pop()();
  await expect(prefStatus(page, 'preview-category')).toHaveText('Settings saved.');
  // The browser setting is still saving its own choice.
  expect(await prefView(page, 'browser-default')).toMatchObject({ busy: true, value: s.slug, stored: t.slug });
  prefGate.requests.shift()();
  await expect(prefStatus(page, 'browser-default')).toHaveText('Settings saved.');
  expect(storedPref('browser-default')).toBe(s.slug);
  expect(storedPref('preview-category')).toBe(u.slug);
  await releaseReads(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  expect(await prefView(page, 'browser-default')).toMatchObject({ value: s.slug, stored: s.slug, status: 'Settings saved.' });
  expect(await prefView(page, 'preview-category')).toMatchObject({ value: u.slug, stored: u.slug, status: 'Settings saved.' });
  expect(preferencePosts(control).length).toBe(posts + 2);
  expect(errors).toEqual([]);
});

test('F9B-B3b: one setting saving, the other untouched — the read installs the untouched setting as rendered (changed in another tab) and keeps only the saving one', async ({ page }) => {
  const [s, t, other, u] = seed(['S F9BB3b', 'T F9BB3b', 'Other F9BB3b', 'U F9BB3b']);
  const { control, errors } = await open(page);
  const second = await otherTab(page);
  await savePref(page, 'browser-default', t.slug);
  await staleList(page, control, other);
  await holdSave(page, 'browser-default', s.slug);
  // Tab 2 saves the preview setting before this page's read runs.
  await savePref(second.tab, 'preview-category', u.slug);
  const html = await retryHeld(page, control);
  expect(await renderedPref(page, html, 'preview-category')).toEqual({ stored: u.slug, value: u.slug });
  prefGate.requests.shift()();
  await expect(prefStatus(page, 'browser-default')).toHaveText('Settings saved.');
  await releaseReads(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  expect(await prefView(page, 'browser-default')).toMatchObject({ value: s.slug, stored: s.slug });
  // The untouched setting is not protected by the other setting's save.
  expect(await prefView(page, 'preview-category')).toMatchObject({ value: u.slug, stored: u.slug, status: '' });
  expect(storedPref('browser-default')).toBe(s.slug);
  expect(preferencePosts(control)).toHaveLength(2);
  expect(errors).toEqual([]);
});

test('F9B-B5: a read sent before the save but run after it renders S — the page shows S, saved, with no conflict and no extra save', async ({ page }) => {
  const [s, t, other] = seed(['S F9BB5', 'T F9BB5', 'Other F9BB5']);
  const { control, errors } = await open(page);
  await savePref(page, 'browser-default', t.slug);
  await staleList(page, control, other);
  await holdSave(page, 'browser-default', s.slug);
  await retryHeld(page, control, 'holdRequest');
  prefGate.requests.shift()();
  await expect(prefStatus(page, 'browser-default')).toHaveText('Settings saved.');
  expect(storedPref('browser-default')).toBe(s.slug);
  await releaseReadRequests(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  expect(await prefView(page, 'browser-default')).toMatchObject({ value: s.slug, stored: s.slug, busy: false, statuses: 1 });
  // Current either way: the kept acknowledged region or the read's own render.
  expect(['Settings saved.', '']).toContain((await prefView(page, 'browser-default')).status);
  expect(preferencePosts(control)).toHaveLength(2);
  expect(errors).toEqual([]);
});

test('F9B-B6 / B7 / B8: a fresh read after the acknowledged save installs normally; after another tab saves T later, a new read shows T; a failed read changes nothing; GET only', async ({ page }) => {
  const [s, t, other, other2, other3] = seed(['S F9BB6', 'T F9BB6', 'Other F9BB6', 'Other2 F9BB6', 'Other3 F9BB6']);
  const { control, errors } = await open(page);
  const second = await otherTab(page);
  await savePref(page, 'browser-default', t.slug);
  await staleList(page, control, other);
  await holdSave(page, 'browser-default', s.slug);
  await retryHeld(page, control);
  prefGate.requests.shift()();
  await expect(prefStatus(page, 'browser-default')).toHaveText('Settings saved.');
  await releaseReads(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  expect(await prefView(page, 'browser-default')).toMatchObject({ value: s.slug, stored: s.slug });
  // B6: a read sent after the acknowledgement installs the region as rendered.
  await prefRegion(page, 'browser-default').evaluate((region) => { region.__f9bMarker = true; });
  await readByUnrelatedDelete(page, control, other2, 'pass');
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  expect(await prefRegion(page, 'browser-default').evaluate((region) => region.__f9bMarker === true)).toBe(false);
  expect(await prefView(page, 'browser-default')).toMatchObject({ value: s.slug, stored: s.slug });
  const posts = preferencePosts(control).length;
  // B7: Tab 2 saves T later; this page's next read reflects it.
  await savePref(second.tab, 'browser-default', t.slug);
  // B8: a failed read observes nothing.
  await readByUnrelatedDelete(page, control, other3, 'fail');
  await expect(feedback(page)).toContainText('could not be refreshed');
  expect(await prefView(page, 'browser-default')).toMatchObject({ value: s.slug, stored: s.slug });
  control.reads = 'pass';
  const reads = listReads(control);
  await feedback(page).getByRole('button', { name: 'Retry refresh' }).click();
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  expect(await prefView(page, 'browser-default')).toMatchObject({ value: t.slug, stored: t.slug, status: '' });
  expect(storedPref('browser-default')).toBe(t.slug);
  expect(listReads(control)).toBe(reads + 1);
  // This page sent nothing for T.
  expect(preferencePosts(control).length).toBe(posts);
  expect(errors).toEqual([]);
});

test('F9B-B10: a held save refused (422, its default disabled meanwhile) through the older read — the refusal stays, nothing reads as saved, nothing stays pending; a valid choice saves once', async ({ page }) => {
  const [s, t, other, u] = seed(['S F9BB10', 'T F9BB10', 'Other F9BB10', 'U F9BB10']);
  const { control, errors } = await open(page);
  const second = await otherTab(page);
  await savePref(page, 'browser-default', t.slug);
  await staleList(page, control, other);
  const statuses = preferenceStatuses(page);
  await holdSave(page, 'browser-default', s.slug);
  await retryHeld(page, control);
  await setEnabledElsewhere(second.tab, s, false);
  prefGate.requests.shift()();
  await expect.poll(() => statuses).toEqual([422]);
  await expect(prefForm(page, 'browser-default')).not.toHaveAttribute('aria-busy', 'true');
  await expect(prefRegion(page, 'browser-default').locator('[role="alert"]')).toHaveCount(1);
  expect(storedPref('browser-default')).toBe(t.slug);
  await releaseReads(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  const view = await prefView(page, 'browser-default');
  expect(view.status).not.toBe('Settings saved.');
  expect(view.busy).toBe(false);
  expect(view.stored).toBe(t.slug);
  await expect(prefRegion(page, 'browser-default').locator('[role="alert"]')).toHaveCount(1);
  await pickPref(page, 'browser-default', u.slug);
  await expect(prefStatus(page, 'browser-default')).toHaveText('Settings saved.');
  expect(storedPref('browser-default')).toBe(u.slug);
  expect(statuses).toEqual([422, 302]);
  expect(errors).toEqual([]);
});

test('F9B-B15: keyboard at a narrow viewport — after the older read the acknowledged S stays; a keyboard choice of T saves once; no navigation', async ({ page }) => {
  const [s, t, other] = seed(['S F9BB15 with a fairly long display name', 'T F9BB15', 'Other F9BB15']);
  const { control, errors } = await open(page, { width: 375, height: 800 });
  await savePref(page, 'preview-category', t.slug);
  await staleList(page, control, other);
  await holdSave(page, 'preview-category', s.slug);
  await retryHeld(page, control);
  prefGate.requests.shift()();
  await expect(prefStatus(page, 'preview-category')).toHaveText('Settings saved.');
  await releaseReads(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  const region = prefRegion(page, 'preview-category');
  expect(await prefView(page, 'preview-category')).toMatchObject({ value: s.slug, stored: s.slug });
  await region.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(region.locator('details[data-cc-dropdown]')).toHaveAttribute('open', '');
  await region.locator(`[data-cc-dropdown] input[type="radio"][value="${t.slug}"]`).focus();
  await page.keyboard.press('Space');
  await expect(prefStatus(page, 'preview-category')).toHaveText('Settings saved.');
  expect(storedPref('preview-category')).toBe(t.slug);
  expect(preferencePosts(control)).toHaveLength(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(control.navigations).toBe(0);
  await expectSameDocument(page);
  expect(errors).toEqual([]);
});

// ---------------------------------------------------------------------------
// WP11C-F10: a kept dirty details form never overrides the installed list's
// current identity for what the Defaults settings can choose. Tab 2 renames
// through the real details route (its own CSRF token and witnesses) without
// taking focus from this tab's draft.

const STALE_DETAILS = 'This category was changed somewhere else';

async function renameElsewhere(tab, category, { name, slug, reviewed }) {
  const csrf = await tab.locator('input[name="_csrf"]').first().inputValue();
  const response = await tab.request.post(`${baseURL}${LIST_PATH}/${category.id}`, {
    form: { _csrf: csrf, displayName: name, directorySlug: slug, reviewedDisplayName: reviewed.name, reviewedDirectorySlug: reviewed.slug },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(302);
  expect(savedRow(category)).toMatchObject({ display_name: name, directory_slug: slug });
}

// The row's article (latest installed render) and its kept form's witnesses.
const rowIdentity = (page, category) => row(page, category).evaluate((article) => ({
  slug: article.getAttribute('data-category-slug'),
  name: article.getAttribute('data-category-label'),
  reviewed: [...article.querySelectorAll('input[data-category-details-reviewed]')].map((input) => input.value),
}));
const seenSlug = (page, category) => page.evaluate((id) => document.__creatorCrateSettingsCategoryDelete.seen.get(String(id))?.slug ?? null, category.id);

async function typeDraft(page, category, suffix = ' private draft') {
  const field = nameField(page, category);
  await field.focus();
  await page.keyboard.press('End');
  await page.keyboard.type(suffix);
  await markField(field);
  return field;
}

// The reviewer's order: Delete of `other` held; S saved (its answer held);
// a focused name draft on `target`; Tab 2 renames `target`; the Delete runs
// and its automatic read installs the current list.
async function f10Order(page, control, second, identity, { target, other, renamed }) {
  await holdDelete(page, control, other);
  prefGate.holdAnswers = 1;
  await choose(page, identity, target.slug);
  await expect.poll(() => prefGate.rendered).toBe(1);
  expect(storedPref(identity)).toBe(target.slug);
  const field = await typeDraft(page, target);
  await renameElsewhere(second.tab, target, { ...renamed, reviewed: target });
  await releaseDelete(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  return field;
}

for (const [index, identity] of ['browser-default', 'preview-category'].entries()) {
  test(`F10-B${index + 1}: original P2 (${identity}) — kept dirty form, renamed elsewhere, the Delete's read installs the new slug, the older answer is released: the old slug is not offered, no "Settings saved.", the draft and its witnesses stay; Tab is refused stale (F7)`, async ({ page }) => {
    const [target, keep, other] = seed([`Original F10B${index + 1}`, `Alternative F10B${index + 1}`, `Unrelated F10B${index + 1}`]);
    const { control, errors } = await open(page);
    const second = await otherTab(page);
    const renamed = { name: `Renamed elsewhere F10B${index + 1}`, slug: `${target.slug}-beta` };
    const field = await f10Order(page, control, second, identity, { target, other, renamed });

    // The read installed: the article is current, the kept form is the draft's own basis.
    expect(await rowIdentity(page, target)).toEqual({ slug: renamed.slug, name: renamed.name, reviewed: [target.name, target.slug] });
    expect(await seenSlug(page, target)).toBe(renamed.slug);
    const reads = listReads(control);
    releasePrefAnswers();
    await settle(page);

    for (const each of ['browser-default', 'preview-category']) {
      const view = await prefView(page, each);
      expect(view.native).not.toContain(target.slug);
      expect(view.panel).not.toContain(target.slug);
      expect(view.native).toContain(keep.slug);
    }
    const view = await prefView(page, identity);
    expect(view.status).not.toContain('Settings saved.');
    expect(view.text).toContain('Saved setting unavailable');
    expect(view.stored).toBe(target.slug);
    expect(view.busy).toBe(false);
    // Nothing repaired or re-saved: reads only (one GET for the server's display).
    expect(storedPref(identity)).toBe(target.slug);
    expect(preferencePosts(control)).toHaveLength(1);
    expect(prefGate.arrivals).toHaveLength(1);
    expect(listReads(control)).toBe(reads + 1);
    expect(detailsPosts(control, target)).toBe(0);
    expect(control.posts).toHaveLength(1);
    expect(executions).toEqual([other.id]);
    expect(mutations).toEqual([['edit', target.id]]);
    expect(savedRow(target)).toMatchObject({ display_name: renamed.name, directory_slug: renamed.slug, enabled: 1 });
    // The draft, focus and witnesses are exactly as typed and rendered.
    expect(await fieldState(field)).toMatchObject({ value: `${target.name} private draft`, saved: target.name, focused: true, sameElement: true });
    expect((await rowIdentity(page, target)).reviewed).toEqual([target.name, target.slug]);
    await expectSameDocument(page);

    // F7: saving the draft on its old basis is refused; the newer row survives.
    await page.keyboard.press('Tab');
    await expect(detailsStatus(page, target)).toContainText(STALE_DETAILS);
    expect(detailsPosts(control, target)).toBe(1);
    expect(savedRow(target)).toMatchObject({ display_name: renamed.name, directory_slug: renamed.slug });
    expect(await nameField(page, target).inputValue()).toBe(`${target.name} private draft`);
    expect((await rowIdentity(page, target)).reviewed).toEqual([renamed.name, renamed.slug]);
    expect((await prefView(page, identity)).native).not.toContain(target.slug);
    expect(errors).toEqual([]);
    expect(second.errors).toEqual([]);
  });
}

for (const enabled of [true, false]) {
  test(`F10-B${enabled ? 3 : 4}: a NEW ${enabled ? 'enabled' : 'DISABLED'} default (new id) takes the old slug after the rename — ${enabled ? 'it is offered under its own name' : 'it stays listed but is not offered'}; the kept form cannot change that`, async ({ page }) => {
    const tag = enabled ? 'F10B3' : 'F10B4';
    const [target, keep, other] = seed([`Original ${tag}`, `Alternative ${tag}`, `Unrelated ${tag}`]);
    const { control, errors } = await open(page);
    const second = await otherTab(page);
    const identity = 'browser-default';
    await holdDelete(page, control, other);
    prefGate.holdAnswers = 1;
    await choose(page, identity, target.slug);
    await expect.poll(() => prefGate.rendered).toBe(1);
    const field = await typeDraft(page, target);
    const renamed = { name: `Renamed ${tag}`, slug: `${target.slug}-beta` };
    await renameElsewhere(second.tab, target, { ...renamed, reviewed: target });
    const reborn = categories.addDefault({ displayName: `Reborn ${tag}`, directorySlug: target.slug, enabled });
    expect(defaultsWithSlug(target.slug)).toEqual([reborn.id]);
    await releaseDelete(control);
    await expect(feedback(page)).toContainText('The category defaults are up to date.');
    releasePrefAnswers();
    await settle(page);

    expect(await rowIds(page)).toEqual([target.id, keep.id, reborn.id]);
    expect(await rowIdentity(page, target)).toMatchObject({ slug: renamed.slug, reviewed: [target.name, target.slug] });
    const view = await prefView(page, identity);
    if (enabled) {
      expect(view.native).toContain(target.slug);
      expect(view.panel).toContain(target.slug);
      expect(view.nativeLabels).toContain(`Reborn ${tag}`);
      expect(view.nativeLabels).not.toContain(target.name);
      expect(view.status).toBe('Settings saved.');
    } else {
      expect(view.native).not.toContain(target.slug);
      expect(view.panel).not.toContain(target.slug);
      expect(view.status).not.toContain('Settings saved.');
    }
    expect(storedPref(identity)).toBe(target.slug);
    expect(preferencePosts(control)).toHaveLength(1);
    expect(detailsPosts(control, target)).toBe(0);
    expect(mutations).toEqual([['edit', target.id]]);
    expect(await fieldState(field)).toMatchObject({ value: `${target.name} private draft`, focused: true, sameElement: true });
    expect(errors).toEqual([]);
  });
}

test('F10-B5: deleted in another tab while its form is kept dirty — it is gone, its slug is withdrawn from both settings, nothing is saved', async ({ page }) => {
  const [target, keep, other] = seed(['Original F10B5', 'Alternative F10B5', 'Unrelated F10B5']);
  const { control, errors } = await open(page);
  await holdDelete(page, control, other);
  prefGate.holdAnswers = 1;
  await choose(page, 'preview-category', target.slug);
  await expect.poll(() => prefGate.rendered).toBe(1);
  await typeDraft(page, target);
  categories.deleteDefault(target.id);
  expect(target.exists()).toBe(false);
  await releaseDelete(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  releasePrefAnswers();
  await settle(page);
  expect(await rowIds(page)).toEqual([keep.id]);
  for (const each of ['browser-default', 'preview-category']) {
    expect((await prefView(page, each)).native).not.toContain(target.slug);
  }
  expect((await prefView(page, 'preview-category')).status).not.toContain('Settings saved.');
  expect(storedPref('preview-category')).toBe(target.slug);
  expect(preferencePosts(control)).toHaveLength(1);
  expect(detailsPosts(control, target)).toBe(0);
  expect(mutations).toEqual([]);
  expect(errors).toEqual([]);
});

test('F10-B6: a local rename acknowledged after a read was rendered (older) — the confirmed slug stays the identity and stays choosable', async ({ page }) => {
  const [target, keep, other] = seed(['Original F10B6', 'Alternative F10B6', 'Unrelated F10B6']);
  const { control, errors } = await open(page);
  const mine = `${target.slug}-mine`;
  // The read is rendered now (target as saved), its answer held.
  await deleteWithHeldRead(page, control, other);
  await renameSlug(page, control, target, mine);
  await releaseReads(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  expect(await rowIdentity(page, target)).toEqual({ slug: target.slug, name: target.name, reviewed: [target.name, mine] });
  expect(await seenSlug(page, target)).toBe(mine);
  await offerRenamed(page, 'browser-default', keep, mine);
  await choose(page, 'browser-default', mine);
  await expect(prefStatus(page, 'browser-default')).toHaveText('Settings saved.');
  expect(storedPref('browser-default')).toBe(mine);
  expect((await prefView(page, 'browser-default')).native).not.toContain(target.slug);
  expect(preferencePosts(control)).toHaveLength(2);
  expect(detailsPosts(control, target)).toBe(1);
  expect(mutations).toEqual([['edit', target.id]]);
  expect(errors).toEqual([]);
});

test('F10-B7: a failed read observes nothing; GET-only Retry then installs the rename and the kept dirty form cannot keep the old slug choosable', async ({ page }) => {
  const [target, keep, other] = seed(['Original F10B7', 'Alternative F10B7', 'Unrelated F10B7']);
  const { control, errors } = await open(page);
  const second = await otherTab(page);
  await holdDelete(page, control, other);
  prefGate.holdAnswers = 1;
  await choose(page, 'browser-default', target.slug);
  await expect.poll(() => prefGate.rendered).toBe(1);
  const field = await typeDraft(page, target);
  const renamed = { name: 'Renamed F10B7', slug: `${target.slug}-beta` };
  await renameElsewhere(second.tab, target, { ...renamed, reviewed: target });
  control.reads = 'fail';
  await releaseDelete(control);
  await expect(feedback(page)).toContainText('could not be refreshed');
  expect(await seenSlug(page, target)).toBe(target.slug);
  releasePrefAnswers();
  await settle(page);
  control.reads = 'pass';
  // Activated without taking focus: leaving the field would be the person's own save.
  await feedback(page).locator('[data-settings-category-delete-refresh-retry]').evaluate((button) => button.click());
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  expect(await rowIdentity(page, target)).toMatchObject({ slug: renamed.slug, reviewed: [target.name, target.slug] });
  expect((await prefView(page, 'browser-default')).native).not.toContain(target.slug);
  expect((await prefView(page, 'browser-default')).status).not.toContain('Settings saved.');
  expect(await fieldState(field)).toMatchObject({ value: `${target.name} private draft`, sameElement: true });
  expect(storedPref('browser-default')).toBe(target.slug);
  expect(preferencePosts(control)).toHaveLength(1);
  expect(detailsPosts(control, target)).toBe(0);
  expect(control.posts).toHaveLength(1);
  expect(errors).toEqual([]);
});

// ------------------------------------------------------------ WP11C-F11 --
// A Defaults save whose answer is lost (or unreadable) after an installed
// list read showed its choice deleted or disabled. While the save is pending
// its selected option stays enabled, so the save's form payload is never
// changed under it; once the save settles without a readable answer, the
// setting must stop offering that choice all the same. Nothing claims the
// save happened or was refused, the stored baseline stays the last one this
// page saw acknowledged, nothing is saved again, and SQLite decides.
//
// The browser's preference POST is intercepted here: 'execute' lets the real
// route run now (the service stores the choice) and keeps the browser's
// request open; 'upstream' sends it to the upstream gate, held BEFORE its
// route runs, and keeps the browser's request open. The test then loses the
// browser's answer (network failure), makes it unreadable (200, no
// redirect, no Settings page), or delivers what the server answered.

const UNCONFIRMED_GONE = 'Could not confirm whether this setting was saved. That category default no longer exists';
const UNCONFIRMED_DISABLED = 'Could not confirm whether this setting was saved. That category default is disabled';
const COULD_NOT_SAVE = 'Could not save settings. Your current changes were kept.';

async function losableSaves(page) {
  const saves = { modes: [], held: [], upstream: [] };
  await page.route((target) => PREFERENCE_PATH.test(target.pathname), async (route) => {
    const mode = route.request().method() === 'POST' ? saves.modes.shift() : undefined;
    if (!mode) return route.fallback();
    if (mode === 'execute') {
      const response = await route.fetch({ maxRedirects: 0 });
      saves.upstream.push(response.status());
      saves.held.push({ route, response: Promise.resolve(response) });
      return undefined;
    }
    const arrivals = prefGate.arrivals.length;
    prefGate.holdRequests += 1;
    const response = route.fetch({ maxRedirects: 0, timeout: 0, maxRetries: 0 });
    response.then((answer) => saves.upstream.push(answer.status()), (error) => saves.upstream.push(error.message));
    for (let wait = 0; prefGate.arrivals.length === arrivals && wait < 200; wait += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    saves.held.push({ route, response });
    return undefined;
  });
  return saves;
}

// The browser's answer for the oldest held save: lost, unreadable, or as the
// server answered it.
async function answerSave(page, saves, identity, how = 'lost') {
  const { route, response } = saves.held.shift();
  if (how === 'lost') await route.abort('failed');
  else if (how === 'unreadable') await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Proxy</title><p>Unreadable answer</p>' });
  else await route.fulfill({ response: await response });
  await expect(prefForm(page, identity)).not.toHaveAttribute('aria-busy', 'true');
}

async function releaseUpstreamSaves() {
  prefGate.requests.splice(0).forEach((forward) => forward());
}

// The reviewer's order. The Delete of `unrelated` is held in this tab; the
// person saves S (`mode`); Tab 2 disables, deletes or replaces X; the Delete
// runs and its automatic read installs the current list while S is saving.
async function f11Order(page, control, second, saves, identity, { target, unrelated, change, mode = 'execute', name }) {
  await holdDelete(page, control, unrelated);
  saves.modes.push(mode);
  await choose(page, identity, target.slug);
  await expect.poll(() => saves.held.length).toBe(1);
  expect(prefGate.arrivals).toHaveLength(1);
  expect(storedPref(identity)).toBe(mode === 'execute' ? target.slug : null);
  let current = null;
  if (change === 'disabled') await setEnabledElsewhere(second.tab, target, false);
  else if (change === 'deleted') await deleteElsewhere(second.tab, target);
  else current = await replaceElsewhere(second.tab, target, name, change === 'replaced-enabled');
  await releaseDelete(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  if (change === 'disabled') await expect(row(page, target)).toHaveAttribute('data-category-enabled', 'false');
  else await expect(row(page, target)).toHaveCount(0);
  // F11-C3 / C6: the save is still pending; its selected value is still its
  // payload's and is not taken out of the form under it.
  const kept = await prefView(page, identity);
  expect(kept.busy).toBe(true);
  expect(kept.value).toBe(target.slug);
  expect(kept.native).toContain(target.slug);
  return current;
}

const withdrawnAttribute = (page, identity, slug) => prefRegion(page, identity).locator(`select option[value="${slug}"]`).getAttribute('data-settings-category-withdrawn');

for (const [index, identity] of ['browser-default', 'preview-category'].entries()) {
  for (const change of ['disabled', 'deleted']) {
    for (const mode of ['execute', 'upstream']) {
      test(`F11-B${index + 1}-${change}-${mode}: original P2 (${identity}) — ${change} in another tab while saving (${mode === 'execute' ? 'the service ran, the answer is lost' : 'the save still upstream, the browser feedback is lost'}); once it settles the choice is not offered, nothing says it saved or was refused, nothing is saved again`, async ({ page }) => {
        const tag = `F11B${index + 1}${change[0]}${mode[0]}`;
        const [target, keep, unrelated] = seed([`Target ${tag}`, `Keep ${tag}`, `Unrelated ${tag}`]);
        const { control, errors } = await open(page);
        const saves = await losableSaves(page);
        const second = await otherTab(page);
        const statuses = preferenceStatuses(page);
        const before = await prefView(page, identity);
        const otherIdentity = identity === 'browser-default' ? 'preview-category' : 'browser-default';
        const otherBefore = storedPref(otherIdentity);
        await f11Order(page, control, second, saves, identity, { target, unrelated, change, mode });
        const reads = listReads(control);

        await answerSave(page, saves, identity, 'lost');
        await settle(page);
        const view = await prefView(page, identity);
        // C7 / C8 / C9: the settled setting no longer offers it, native or dropdown.
        expect(view.native).not.toContain(target.slug);
        expect(view.panel).not.toContain(target.slug);
        expect(await withdrawnAttribute(page, identity, target.slug)).toBe('');
        expect(view.native).toContain(keep.slug);
        expect(view.panel).toContain(keep.slug);
        // C10 / C11 / C13: the draft is still shown; nothing says saved or refused; the baseline is not the uncertain value.
        expect(view.value).toBe(target.slug);
        expect(view.busy).toBe(false);
        expect(view.status).toContain(change === 'deleted' ? UNCONFIRMED_GONE : UNCONFIRMED_DISABLED);
        expect(view.text).not.toContain('Settings saved.');
        expect(view.status).not.toContain('Could not save settings');
        expect(view.stored).toBe(before.stored);
        expect(view.statuses).toBe(1);
        expect((await prefView(page, otherIdentity)).native).not.toContain(target.slug);
        // C12: nothing sent again; no read loop; SQLite decides.
        expect(preferencePosts(control)).toHaveLength(1);
        expect(prefGate.arrivals).toHaveLength(1);
        expect(listReads(control)).toBe(reads);
        expect(statuses).toEqual([]);
        expect(storedPref(identity)).toBe(mode === 'execute' ? target.slug : null);
        expect(storedPref(otherIdentity)).toBe(otherBefore);
        if (mode === 'execute') expect(saves.upstream).toEqual([302]);

        if (mode === 'upstream') {
          // The original request runs only now, under the server's own rules.
          await releaseUpstreamSaves();
          await expect.poll(() => saves.upstream.length).toBe(1);
          expect(saves.upstream[0]).toBe(422);
          expect(storedPref(identity)).toBe(null);
          await settle(page);
          expect((await prefView(page, identity)).native).not.toContain(target.slug);
          expect(prefGate.arrivals).toHaveLength(1);
        }
        expect(target.exists()).toBe(change === 'disabled');
        if (change === 'disabled') expect(defaultRow(target.id)).toMatchObject({ enabled: 0 });
        expect(executions).toEqual(change === 'deleted' ? [target.id, unrelated.id] : [unrelated.id]);
        expect(mutations).toEqual(change === 'disabled' ? [['enabled', target.id]] : []);
        expect(control.posts).toHaveLength(1);
        await expectSameDocument(page);

        // C14 / B14: an intentional valid choice saves exactly once.
        await savePref(page, identity, keep.slug);
        expect(preferencePosts(control)).toHaveLength(2);
        expect(prefGate.arrivals).toHaveLength(2);
        const after = await prefView(page, identity);
        expect(after.stored).toBe(keep.slug);
        expect(after.native).not.toContain(target.slug);
        expect(after.statuses).toBe(1);
        expect(errors).toEqual([]);
        expect(second.errors).toEqual([]);
      });
    }
  }
}

for (const [index, identity] of ['browser-default', 'preview-category'].entries()) {
  const change = index === 0 ? 'disabled' : 'deleted';
  test(`F11-B3${'ab'[index]} (C5): unreadable answer (${identity}, ${change}) — a 200 that is not the redirected Settings page, after the installed read: uncertain; withdrawn; no false saved/refused; SQLite keeps S; nothing sent again`, async ({ page }) => {
    const tag = `F11B3${'ab'[index]}`;
    const [target, keep, unrelated] = seed([`Target ${tag}`, `Keep ${tag}`, `Unrelated ${tag}`]);
    const { control, errors } = await open(page);
    const saves = await losableSaves(page);
    const second = await otherTab(page);
    const before = await prefView(page, identity);
    await f11Order(page, control, second, saves, identity, { target, unrelated, change });
    await answerSave(page, saves, identity, 'unreadable');
    await settle(page);
    const view = await prefView(page, identity);
    expect(view.native).not.toContain(target.slug);
    expect(view.panel).not.toContain(target.slug);
    expect(view.value).toBe(target.slug);
    expect(view.status).toContain(change === 'deleted' ? UNCONFIRMED_GONE : UNCONFIRMED_DISABLED);
    expect(view.text).not.toContain('Settings saved.');
    expect(view.stored).toBe(before.stored);
    expect(view.native).toContain(keep.slug);
    expect(storedPref(identity)).toBe(target.slug);
    expect(preferencePosts(control)).toHaveLength(1);
    expect(prefGate.arrivals).toHaveLength(1);
    await expectSameDocument(page);
    expect(errors).toEqual([]);
  });
}

const SUBMITTED_UNAVAILABLE = 'Submitted value is unavailable; choose a valid replacement.';
// Every native option with `slug`: its label and whether it is selected.
const refusalEcho = (page, identity, slug) => prefRegion(page, identity).evaluate((region, value) => [...region.querySelector('select').options]
  .filter((option) => option.value === value)
  .map((option) => ({ label: option.textContent.trim(), selected: option.selected })), slug);

test('F11-B5: current 422 — the save reaches the server only after the other tab disabled S; the refusal is delivered and installed as the server rendered it; S is not offered as the category; a correction saves once', async ({ page }) => {
  const [target, keep, unrelated] = seed(['Target F11B5', 'Keep F11B5', 'Unrelated F11B5']);
  const { control, errors } = await open(page);
  const saves = await losableSaves(page);
  const second = await otherTab(page);
  const before = await prefView(page, 'browser-default');
  await f11Order(page, control, second, saves, 'browser-default', { target, unrelated, change: 'disabled', mode: 'upstream' });
  await releaseUpstreamSaves();
  await expect.poll(() => saves.upstream.length).toBe(1);
  expect(saves.upstream).toEqual([422]);
  await answerSave(page, saves, 'browser-default', 'deliver');
  await settle(page);
  const view = await prefView(page, 'browser-default');
  // The server's own refusal render (installed as rendered, F9/F9A): S is
  // not offered as the category; only the refused value is echoed, selected
  // and labelled unavailable, as the existing 422 convention shows it.
  expect(await refusalEcho(page, 'browser-default', target.slug)).toEqual([{ label: SUBMITTED_UNAVAILABLE, selected: true }]);
  expect(view.nativeLabels).not.toContain(target.name);
  expect(view.text).not.toContain('Settings saved.');
  expect(view.status).not.toContain('Could not confirm');
  // The refusal render replaced the region: its own alert says it was not saved.
  expect(await prefRegion(page, 'browser-default').locator('[role="alert"]:not([hidden])').count()).toBeGreaterThan(0);
  expect(view.stored).toBe(before.stored);
  expect(storedPref('browser-default')).toBe(null);
  expect(preferencePosts(control)).toHaveLength(1);
  expect(prefGate.arrivals).toHaveLength(1);
  await savePref(page, 'browser-default', keep.slug);
  expect(preferencePosts(control)).toHaveLength(2);
  await expectSameDocument(page);
  expect(errors).toEqual([]);
});


// Both settings save S (their answers held in the browser); Tab 2 disables
// S; this page's read installs while both are saving.
async function bothSaving(page, control, second, saves, { target, unrelated, modes = ['execute', 'execute'] }) {
  await holdDelete(page, control, unrelated);
  saves.modes.push(...modes);
  await choose(page, 'browser-default', target.slug);
  await expect.poll(() => saves.held.length).toBe(1);
  await choose(page, 'preview-category', target.slug);
  await expect.poll(() => saves.held.length).toBe(2);
  await setEnabledElsewhere(second.tab, target, false);
  await releaseDelete(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  for (const identity of ['browser-default', 'preview-category']) expect((await prefView(page, identity)).busy).toBe(true);
}

test('F11-B6a: both settings saving — only the browser answer is lost, the preview answer is delivered — each settles on its own; no baseline crosses; nothing sent again', async ({ page }) => {
  const [target, keep, unrelated] = seed(['Target F11B6a', 'Keep F11B6a', 'Unrelated F11B6a']);
  const { control, errors } = await open(page);
  const saves = await losableSaves(page);
  const second = await otherTab(page);
  const before = await prefView(page, 'browser-default');
  await bothSaving(page, control, second, saves, { target, unrelated });
  await answerSave(page, saves, 'browser-default', 'lost');
  await settle(page);
  let browser = await prefView(page, 'browser-default');
  let preview = await prefView(page, 'preview-category');
  expect(browser.native).not.toContain(target.slug);
  expect(browser.status).toContain(UNCONFIRMED_DISABLED);
  expect(browser.stored).toBe(before.stored);
  // The preview save is still pending: its payload's option stays.
  expect(preview.busy).toBe(true);
  expect(preview.value).toBe(target.slug);
  expect(preview.native).toContain(target.slug);
  // Delivered now, the preview answer's redirect render is current (S
  // disabled): it installs as the server rendered it (the established
  // convention), saved and shown unavailable. The browser default is untouched.
  await answerSave(page, saves, 'preview-category', 'deliver');
  await settle(page);
  preview = await prefView(page, 'preview-category');
  expect(preview.native).not.toContain(target.slug);
  expect(preview.panel).not.toContain(target.slug);
  expect(preview.text).toContain(`Saved setting unavailable — ${target.name} (disabled).`);
  expect(preview.status).not.toContain('Could not');
  expect(preview.stored).toBe(target.slug);
  browser = await prefView(page, 'browser-default');
  expect(browser.stored).toBe(before.stored);
  expect(browser.status).toContain(UNCONFIRMED_DISABLED);
  expect(storedPref('browser-default')).toBe(target.slug);
  expect(storedPref('preview-category')).toBe(target.slug);
  expect(preferencePosts(control)).toHaveLength(2);
  expect(prefGate.arrivals).toHaveLength(2);
  // Each control's next intentional save is its own, once.
  await savePref(page, 'browser-default', keep.slug);
  expect(preferencePosts(control)).toHaveLength(3);
  expect(storedPref('preview-category')).toBe(target.slug);
  expect((await prefView(page, 'preview-category')).native).not.toContain(target.slug);
  await expectSameDocument(page);
  expect(errors).toEqual([]);
});

test('F11-B6b: both settings saving — both answers lost — both withdraw S, each with its own uncertain status and baseline; follow-up saves are independent and once each', async ({ page }) => {
  const [target, keep, unrelated] = seed(['Target F11B6b', 'Keep F11B6b', 'Unrelated F11B6b']);
  const { control, errors } = await open(page);
  const saves = await losableSaves(page);
  const second = await otherTab(page);
  const before = { 'browser-default': await prefView(page, 'browser-default'), 'preview-category': await prefView(page, 'preview-category') };
  await bothSaving(page, control, second, saves, { target, unrelated });
  await answerSave(page, saves, 'browser-default', 'lost');
  await answerSave(page, saves, 'preview-category', 'lost');
  await settle(page);
  for (const identity of ['browser-default', 'preview-category']) {
    const view = await prefView(page, identity);
    expect(view.native).not.toContain(target.slug);
    expect(view.panel).not.toContain(target.slug);
    expect(view.value).toBe(target.slug);
    expect(view.status).toContain(UNCONFIRMED_DISABLED);
    expect(view.stored).toBe(before[identity].stored);
    expect(view.statuses).toBe(1);
    expect(storedPref(identity)).toBe(target.slug);
  }
  expect(preferencePosts(control)).toHaveLength(2);
  expect(prefGate.arrivals).toHaveLength(2);
  await savePref(page, 'preview-category', keep.slug);
  expect(preferencePosts(control)).toHaveLength(3);
  expect(storedPref('browser-default')).toBe(target.slug);
  expect((await prefView(page, 'browser-default')).status).toContain(UNCONFIRMED_DISABLED);
  await savePref(page, 'browser-default', keep.slug);
  expect(preferencePosts(control)).toHaveLength(4);
  await expectSameDocument(page);
  expect(errors).toEqual([]);
});

test('F11-B6c: both settings — the browser save reaches the server only after the disable (current 422, delivered) while the preview save ran before it (answer delivered) — the refusal stays a refusal; the preview stays truthfully saved but disabled', async ({ page }) => {
  const [target, keep, unrelated] = seed(['Target F11B6c', 'Keep F11B6c', 'Unrelated F11B6c']);
  const { control, errors } = await open(page);
  const saves = await losableSaves(page);
  const second = await otherTab(page);
  const before = await prefView(page, 'browser-default');
  await bothSaving(page, control, second, saves, { target, unrelated, modes: ['upstream', 'execute'] });
  await releaseUpstreamSaves();
  await expect.poll(() => saves.upstream.length).toBe(2);
  expect([...saves.upstream].sort()).toEqual([302, 422]);
  await answerSave(page, saves, 'browser-default', 'deliver');
  await answerSave(page, saves, 'preview-category', 'deliver');
  await settle(page);
  const browser = await prefView(page, 'browser-default');
  const preview = await prefView(page, 'preview-category');
  expect(await refusalEcho(page, 'browser-default', target.slug)).toEqual([{ label: SUBMITTED_UNAVAILABLE, selected: true }]);
  expect(browser.nativeLabels).not.toContain(target.name);
  expect(browser.status).not.toContain('Could not confirm');
  expect(browser.text).not.toContain('Settings saved.');
  expect(browser.stored).toBe(before.stored);
  expect(storedPref('browser-default')).toBe(null);
  expect(preview.native).not.toContain(target.slug);
  expect(preview.text).toContain(`Saved setting unavailable — ${target.name} (disabled).`);
  expect(preview.status).not.toContain('Could not');
  expect(preview.stored).toBe(target.slug);
  expect(storedPref('preview-category')).toBe(target.slug);
  expect(preferencePosts(control)).toHaveLength(2);
  expect(prefGate.arrivals).toHaveLength(2);
  await savePref(page, 'browser-default', keep.slug);
  expect(preferencePosts(control)).toHaveLength(3);
  await expectSameDocument(page);
  expect(errors).toEqual([]);
});

for (const enabled of [true, false]) {
  test(`F11-B${enabled ? 7 : 8}: slug reuse — X deleted in another tab, a NEW ${enabled ? 'enabled' : 'DISABLED'} default (new id) takes its slug while S is saving; the answer is lost; ${enabled ? 'S stays a choice under the new name' : 'S is not offered'}; the old id never returns`, async ({ page }) => {
    const tag = enabled ? 'F11B7' : 'F11B8';
    const [target, keep, unrelated] = seed([`Target ${tag}`, `Keep ${tag}`, `Unrelated ${tag}`]);
    const { control, errors } = await open(page);
    const saves = await losableSaves(page);
    const second = await otherTab(page);
    const before = await prefView(page, 'browser-default');
    const reborn = await f11Order(page, control, second, saves, 'browser-default', {
      target, unrelated, change: enabled ? 'replaced-enabled' : 'replaced-disabled', name: `Reborn ${tag}`,
    });
    await answerSave(page, saves, 'browser-default', 'lost');
    await settle(page);
    const view = await prefView(page, 'browser-default');
    expect(view.value).toBe(target.slug);
    expect(view.stored).toBe(before.stored);
    expect(view.text).not.toContain('Settings saved.');
    if (enabled) {
      expect(view.native).toContain(target.slug);
      expect(view.panel).toContain(target.slug);
      expect(view.nativeLabels).toContain(reborn.name);
      expect(view.nativeLabels).not.toContain(target.name);
      expect(view.status).toBe(COULD_NOT_SAVE);
    } else {
      expect(view.native).not.toContain(target.slug);
      expect(view.panel).not.toContain(target.slug);
      expect(view.nativeLabels).not.toContain(reborn.name);
      // X itself is gone, so the gone wording applies (F9 / savedUnavailableMessage).
      expect(view.status).toContain(UNCONFIRMED_GONE);
    }
    expect(await rowIds(page)).toEqual([keep.id, reborn.id]);
    expect(target.exists()).toBe(false);
    expect(defaultRow(reborn.id)).toMatchObject({ directory_slug: target.slug, enabled: enabled ? 1 : 0 });
    expect(storedPref('browser-default')).toBe(target.slug);
    expect(preferencePosts(control)).toHaveLength(1);
    expect(prefGate.arrivals).toHaveLength(1);
    expect(executions).toEqual([target.id, unrelated.id]);
    await expectSameDocument(page);
    expect(errors).toEqual([]);
  });
}

test('F11-B9: F8 / F10 — a kept dirty details draft on X; X renamed in another tab while S (its old slug) saves; the read installs; the answer is lost: the old slug is not offered, the draft and its witnesses stay unsaved; Tab is refused stale (F7)', async ({ page }) => {
  const [target, keep, unrelated] = seed(['Original F11B9', 'Alternative F11B9', 'Unrelated F11B9']);
  const { control, errors } = await open(page);
  const saves = await losableSaves(page);
  const second = await otherTab(page);
  const renamed = { name: 'Renamed elsewhere F11B9', slug: `${target.slug}-beta` };
  await holdDelete(page, control, unrelated);
  saves.modes.push('execute');
  await choose(page, 'browser-default', target.slug);
  await expect.poll(() => saves.held.length).toBe(1);
  const field = await typeDraft(page, target);
  await renameElsewhere(second.tab, target, { ...renamed, reviewed: target });
  await releaseDelete(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  expect(await rowIdentity(page, target)).toEqual({ slug: renamed.slug, name: renamed.name, reviewed: [target.name, target.slug] });
  // The answer is lost in the network layer: nothing on the page is clicked, so the focused draft is not blurred.
  await answerSave(page, saves, 'browser-default', 'lost');
  await settle(page);
  const view = await prefView(page, 'browser-default');
  expect(view.native).not.toContain(target.slug);
  expect(view.panel).not.toContain(target.slug);
  expect(view.status).toContain(UNCONFIRMED_GONE);
  expect(view.text).not.toContain('Settings saved.');
  expect(storedPref('browser-default')).toBe(target.slug);
  expect(preferencePosts(control)).toHaveLength(1);
  expect(detailsPosts(control, target)).toBe(0);
  expect(mutations).toEqual([['edit', target.id]]);
  expect(await fieldState(field)).toMatchObject({ value: `${target.name} private draft`, saved: target.name, focused: true, sameElement: true });
  expect((await rowIdentity(page, target)).reviewed).toEqual([target.name, target.slug]);
  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, target)).toContainText(STALE_DETAILS);
  expect(detailsPosts(control, target)).toBe(1);
  expect(savedRow(target)).toMatchObject({ display_name: renamed.name, directory_slug: renamed.slug });
  expect((await prefView(page, 'browser-default')).native).not.toContain(target.slug);
  expect(preferencePosts(control)).toHaveLength(1);
  await expectSameDocument(page);
  expect(errors).toEqual([]);
});

test('F11-B12 (R2 / R3 / R5 / R8): a failed read observes nothing (S still offered after the lost answer); GET-only Retry installs X disabled and withdraws S; enabled again and read, S is a choice again; nothing saved', async ({ page }) => {
  const [target, keep, unrelated, unrelated2] = seed(['Target F11B12', 'Keep F11B12', 'Unrelated F11B12', 'Unrelated2 F11B12']);
  const { control, errors } = await open(page);
  const saves = await losableSaves(page);
  const second = await otherTab(page);
  const before = await prefView(page, 'browser-default');
  await holdDelete(page, control, unrelated);
  saves.modes.push('execute');
  await choose(page, 'browser-default', target.slug);
  await expect.poll(() => saves.held.length).toBe(1);
  await setEnabledElsewhere(second.tab, target, false);
  control.reads = 'fail';
  await releaseDelete(control);
  await expect(feedback(page)).toContainText('could not be refreshed');
  // R5: the answer is lost before any read showing X disabled is installed.
  await answerSave(page, saves, 'browser-default', 'lost');
  await settle(page);
  let view = await prefView(page, 'browser-default');
  expect(view.native).toContain(target.slug);
  expect(view.status).toBe(COULD_NOT_SAVE);
  expect(view.stored).toBe(before.stored);
  // R3: GET-only Retry.
  control.reads = 'pass';
  await feedback(page).getByRole('button', { name: 'Retry refresh' }).click();
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  view = await prefView(page, 'browser-default');
  expect(view.native).not.toContain(target.slug);
  expect(view.panel).not.toContain(target.slug);
  expect(view.status).toContain(UNCONFIRMED_DISABLED);
  expect(view.value).toBe(target.slug);
  expect(view.stored).toBe(before.stored);
  expect(storedPref('browser-default')).toBe(target.slug);
  expect(preferencePosts(control)).toHaveLength(1);
  // R8: enabled again in Tab 2 and read here: S is a choice again and the
  // status no longer says it is disabled. Nothing is saved by availability.
  await setEnabledElsewhere(second.tab, target, true);
  await readByUnrelatedDelete(page, control, unrelated2, 'pass');
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  view = await prefView(page, 'browser-default');
  expect(view.native).toContain(target.slug);
  expect(view.panel).toContain(target.slug);
  expect(view.status).toBe(COULD_NOT_SAVE);
  expect(view.stored).toBe(before.stored);
  expect(preferencePosts(control)).toHaveLength(1);
  expect(prefGate.arrivals).toHaveLength(1);
  expect(control.reads_.every((read) => read.method === 'GET')).toBe(true);
  await expectSameDocument(page);
  expect(errors).toEqual([]);
});

test('F11-B13 (R4): out of order — an older read (X enabled) delivered after the newer installed read (X disabled) and the lost answer restores nothing', async ({ page }) => {
  const [target, keep, lost] = seed(['Target F11B13', 'Keep F11B13', 'Lost F11B13']);
  const { control, errors } = await open(page);
  const saves = await losableSaves(page);
  const second = await otherTab(page);
  control.reads = 'hold';
  control.post = 'lose';
  await deleteButton(page, lost).click();
  await confirmButton(page).click();
  await expect.poll(() => control.heldReads.length).toBe(1);
  await (control.heldReads[0].response);
  const older = control.heldReads.splice(0);
  control.post = 'pass';
  saves.modes.push('execute');
  await choose(page, 'browser-default', target.slug);
  await expect.poll(() => saves.held.length).toBe(1);
  control.reads = 'holdRequest';
  await feedback(page).getByRole('button', { name: 'Check again' }).click();
  await expect.poll(() => control.heldReadRequests.length).toBe(1);
  await setEnabledElsewhere(second.tab, target, false);
  await releaseReadRequests(control);
  await expect(feedback(page)).toContainText(OBSERVED);
  await expect(row(page, target)).toHaveAttribute('data-category-enabled', 'false');
  expect((await prefView(page, 'browser-default')).busy).toBe(true);
  await answerSave(page, saves, 'browser-default', 'lost');
  await settle(page);
  expect((await prefView(page, 'browser-default')).native).not.toContain(target.slug);
  for (const { route, response } of older) await route.fulfill({ response: await response });
  await settle(page);
  const view = await prefView(page, 'browser-default');
  await expect(row(page, target)).toHaveAttribute('data-category-enabled', 'false');
  expect(view.native).not.toContain(target.slug);
  expect(view.panel).not.toContain(target.slug);
  expect(view.status).toContain(UNCONFIRMED_DISABLED);
  expect(storedPref('browser-default')).toBe(target.slug);
  expect(preferencePosts(control)).toHaveLength(1);
  expect(executions).toEqual([lost.id]);
  await expectSameDocument(page);
  expect(errors).toEqual([]);
});

test('F11-B15: keyboard at a narrow viewport — after the lost answer the disabled choice is not offered, one status explains it; a keyboard choice saves once; no navigation', async ({ page }) => {
  const [target, keep, unrelated] = seed(['Target F11B15 with a fairly long display name', 'Keep F11B15', 'Unrelated F11B15']);
  const { control, errors } = await open(page, { width: 375, height: 800 });
  const saves = await losableSaves(page);
  const second = await otherTab(page);
  await f11Order(page, control, second, saves, 'preview-category', { target, unrelated, change: 'disabled' });
  await answerSave(page, saves, 'preview-category', 'lost');
  await settle(page);
  const region = prefRegion(page, 'preview-category');
  await expect(region).toContainText(UNCONFIRMED_DISABLED);
  expect((await prefView(page, 'preview-category')).statuses).toBe(1);
  await region.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(region.locator('details[data-cc-dropdown]')).toHaveAttribute('open', '');
  expect(await region.locator(`[data-cc-dropdown] input[type="radio"][value="${target.slug}"]`).isDisabled()).toBe(true);
  const radios = region.locator('[data-cc-dropdown] input[type="radio"]:not([disabled])');
  expect(await radios.evaluateAll((inputs) => inputs.map((input) => input.value))).not.toContain(target.slug);
  await region.locator(`[data-cc-dropdown] input[type="radio"][value="${keep.slug}"]`).focus();
  await page.keyboard.press('Space');
  await expect(prefStatus(page, 'preview-category')).toHaveText('Settings saved.');
  expect(storedPref('preview-category')).toBe(keep.slug);
  expect(preferencePosts(control)).toHaveLength(2);
  expect(prefGate.arrivals).toHaveLength(2);
  expect((await prefView(page, 'preview-category')).statuses).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(control.navigations).toBe(0);
  await expectSameDocument(page);
  expect(errors).toEqual([]);
});

// ------------------------------------------------------------- WP11C-A --
// An older Details answer never overrides newer installed category identity.
// The audit's order: this page saves target alpha → beta (the server commits
// it; its answer is held); a read installs beta; the Defaults setting saves
// beta (its answer rendered with beta current); Tab 2 commits beta → gamma;
// the held Delete's read installs gamma; then the beta Details answer is
// delivered last, and the setting's answer is delivered (or lost) after it.

// The save runs and the server renders its answer (the redirect's page) now;
// only that rendered answer's way back is held, so it is as old as its render.
async function slugSaveHeld(page, category, slug) {
  detailsAnswers.holdRendered = 1;
  await slugField(page, category).fill(slug);
  await page.keyboard.press('Tab');
  await expect.poll(() => detailsAnswers.held.length).toBe(1);
  expect(savedRow(category).directory_slug).toBe(slug);
}

async function confirmDelete(page, category) {
  await deleteButton(page, category).click();
  await confirmButton(page).click();
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  expect(category.exists()).toBe(false);
}

async function betaGammaOrder(page, control, second, identity, { target, first, unrelated, saves = null }) {
  const beta = `${target.slug}-beta`;
  const gamma = `${target.slug}-gamma`;
  await slugSaveHeld(page, target, beta);
  await confirmDelete(page, first);
  expect(await rowIdentity(page, target)).toMatchObject({ slug: beta });
  await holdDelete(page, control, unrelated);
  if (saves) saves.modes.push('execute');
  else prefGate.holdAnswers = 1;
  await choose(page, identity, beta);
  if (saves) await expect.poll(() => saves.held.length).toBe(1);
  else await expect.poll(() => prefGate.rendered).toBe(1);
  expect(storedPref(identity)).toBe(beta);
  await renameElsewhere(second.tab, target, { name: target.name, slug: gamma, reviewed: { name: target.name, slug: beta } });
  await releaseDelete(control);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  expect(await rowIdentity(page, target)).toMatchObject({ slug: gamma });
  // The older beta answer is delivered last.
  const reads = listReads(control);
  detailsAnswers.held.shift()();
  // Installed (its status may then go with the reconciling read's render).
  await expect(row(page, target).locator('form[data-category-details-form]')).not.toHaveAttribute('aria-busy', 'true');
  return { beta, gamma, reads };
}

for (const [index, identity] of ['browser-default', 'preview-category'].entries()) {
  for (const how of ['readable', 'lost']) {
    test(`A-B${index + 1}${how === 'lost' ? 'b' : 'a'}: original P2 (${identity}, ${how} answer) — beta answered after gamma's read installed: gamma stays the identity, beta is not offered, no "Settings saved."`, async ({ page }) => {
      const tag = `AB${index + 1}${how === 'lost' ? 'b' : 'a'}`;
      const [target, keep, first, unrelated] = seed([`Target ${tag}`, `Keep ${tag}`, `First ${tag}`, `Unrelated ${tag}`]);
      const { control, errors } = await open(page);
      const saves = how === 'lost' ? await losableSaves(page) : null;
      const second = await otherTab(page);
      const { beta, gamma, reads } = await betaGammaOrder(page, control, second, identity, { target, first, unrelated, saves });
      await expect(feedback(page)).toContainText('The category defaults are up to date.');
      if (how === 'lost') await answerSave(page, saves, identity, 'lost');
      else releasePrefAnswers();
      await settle(page);
      await expect(feedback(page)).toContainText('The category defaults are up to date.');
      await settle(page);

      expect(savedRow(target).directory_slug).toBe(gamma);
      expect(await rowIdentity(page, target)).toMatchObject({ slug: gamma });
      expect(await seenSlug(page, target)).toBe(gamma);
      const view = await prefView(page, identity);
      expect(view.status).not.toBe('Settings saved.');
      // Lost: F11's uncertain wording; readable: vetoed (F9A), the server's own render.
      if (how === 'lost') expect(view.status).toContain(UNCONFIRMED_GONE);
      else expect(view.text).toContain('Saved setting unavailable');
      expect(view.text).not.toContain('Settings saved.');
      for (const each of ['browser-default', 'preview-category']) {
        const shown = await prefView(page, each);
        expect(shown.native).not.toContain(beta);
        expect(shown.panel).not.toContain(beta);
        // A setting kept while saving keeps the options it was rendered with.
        if (how === 'readable' || each !== identity) expect(shown.native).toContain(gamma);
        expect(shown.native).toContain(keep.slug);
      }
      expect(view.busy).toBe(false);
      expect(storedPref(identity)).toBe(beta);
      // Reads only: one GET resolves the ambiguous Details answer, and the
      // vetoed readable setting answer (F9A) reads once more; nothing is saved.
      expect(listReads(control)).toBe(reads + (how === 'lost' ? 1 : 2));
      expect(preferencePosts(control)).toHaveLength(1);
      expect(detailsPosts(control, target)).toBe(1);
      expect(control.posts).toHaveLength(2);
      expect(mutations).toEqual([['edit', target.id], ['edit', target.id]]);
      expect(errors).toEqual([]);
      expect(second.errors).toEqual([]);
    });
  }
}

test('A-B3: inverse order and a later read — a save sent after the read installed is answered late: beta is the identity and saves as a choice with no extra GET; a later read after gamma elsewhere installs gamma', async ({ page }) => {
  const [target, keep, first, unrelated] = seed(['Target AB3', 'Keep AB3', 'First AB3', 'Unrelated AB3']);
  const { control, errors } = await open(page);
  const second = await otherTab(page);
  const beta = `${target.slug}-beta`;
  const gamma = `${target.slug}-gamma`;
  await confirmDelete(page, first);
  const reads = listReads(control);
  // D: sent after the read installed, so its answer is newer whenever it arrives.
  await slugSaveHeld(page, target, beta);
  await settle(page);
  detailsAnswers.held.shift()();
  await expect(detailsStatus(page, target)).toHaveText('Details saved.');
  await settle(page);
  expect(listReads(control)).toBe(reads);
  expect(await rowIdentity(page, target)).toEqual({ slug: target.slug, name: target.name, reviewed: [target.name, beta] });
  await offerRenamed(page, 'browser-default', keep, beta);
  await choose(page, 'browser-default', beta);
  await expect(prefStatus(page, 'browser-default')).toHaveText('Settings saved.');
  expect(storedPref('browser-default')).toBe(beta);
  // E: changed elsewhere later; a read sent after that installs gamma.
  await renameElsewhere(second.tab, target, { name: target.name, slug: gamma, reviewed: { name: target.name, slug: beta } });
  await confirmDelete(page, unrelated);
  await settle(page);
  expect(await rowIdentity(page, target)).toMatchObject({ slug: gamma, reviewed: [target.name, gamma] });
  expect(await seenSlug(page, target)).toBe(gamma);
  for (const each of ['browser-default', 'preview-category']) {
    expect((await prefView(page, each)).native).not.toContain(beta);
    expect((await prefView(page, each)).native).toContain(gamma);
  }
  expect(listReads(control)).toBe(reads + 1);
  expect(preferencePosts(control)).toHaveLength(2);
  expect(detailsPosts(control, target)).toBe(1);
  expect(savedRow(target).directory_slug).toBe(gamma);
  expect(errors).toEqual([]);
});

test('A-B4: dirty draft, refusal and follow-up — the late beta answer installs around newer typing; one GET keeps the draft and its witnesses; Tab is refused stale (F7); a new intentional save then saves once', async ({ page }) => {
  const [target, keep, first, unrelated] = seed(['Target AB4', 'Keep AB4', 'First AB4', 'Unrelated AB4']);
  const { control, errors } = await open(page);
  const second = await otherTab(page);
  const beta = `${target.slug}-beta`;
  const gamma = `${target.slug}-gamma`;
  await slugSaveHeld(page, target, beta);
  await confirmDelete(page, first);
  await renameElsewhere(second.tab, target, { name: target.name, slug: gamma, reviewed: { name: target.name, slug: beta } });
  await confirmDelete(page, unrelated);
  expect(await rowIdentity(page, target)).toMatchObject({ slug: gamma });
  const field = await typeDraft(page, target);
  const reads = listReads(control);
  detailsAnswers.held.shift()();
  await expect(detailsStatus(page, target)).toHaveText('Earlier changes saved. Current changes have not been saved.');
  await expect.poll(() => listReads(control)).toBe(reads + 1);
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  // G: the draft, focus and the answer's witnesses stay; the read is the identity.
  expect(await fieldState(field)).toMatchObject({ value: `${target.name} private draft`, focused: true, sameElement: true });
  expect(await rowIdentity(page, target)).toEqual({ slug: gamma, name: target.name, reviewed: [target.name, beta] });
  expect(await seenSlug(page, target)).toBe(gamma);
  for (const each of ['browser-default', 'preview-category']) {
    expect((await prefView(page, each)).native).not.toContain(beta);
  }
  expect(detailsPosts(control, target)).toBe(1);
  // F: the draft's basis is beta, so the server refuses it stale; nothing is promoted.
  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, target)).toContainText(STALE_DETAILS);
  expect(detailsPosts(control, target)).toBe(2);
  expect(savedRow(target)).toMatchObject({ display_name: target.name, directory_slug: gamma });
  expect((await rowIdentity(page, target)).reviewed).toEqual([target.name, gamma]);
  expect(await seenSlug(page, target)).toBe(gamma);
  expect((await prefView(page, 'browser-default')).native).not.toContain(beta);
  // H: a new intentional save on the current basis saves once.
  const delta = `${target.slug}-delta`;
  await renameSlug(page, control, target, delta);
  expect(savedRow(target)).toMatchObject({ display_name: `${target.name} private draft`, directory_slug: delta });
  await offerRenamed(page, 'preview-category', keep, delta);
  expect(detailsPosts(control, target)).toBe(3);
  expect(preferencePosts(control)).toHaveLength(1);
  // beta here, gamma in Tab 2, the refused stale attempt (written nothing), delta here.
  expect(mutations).toEqual([['edit', target.id], ['edit', target.id], ['edit', target.id], ['edit', target.id]]);
  expect(errors).toEqual([]);
  expect(second.errors).toEqual([]);
});
