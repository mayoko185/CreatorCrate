import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { createApp } from '../../src/app.js';
import { createAssetManifest } from '../../src/asset-manifest.js';
import { createStaticCredentialProvider } from '../../src/auth/credential-provider.js';
import { createLoginThrottler } from '../../src/auth/login-throttle.js';
import { createAssetCategoryRepository } from '../../src/data/asset-category-repository.js';
import { createAssetCategoryService } from '../../src/services/asset-category-service.js';
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';
import { AUTH_CONFIG, TEST_PASSWORD, TEST_USERNAME } from '../helpers/auth.js';

// WP11C-B: a Defaults preference save is acknowledged only by its redirected
// Settings answer carrying that preference's own region. Real Chromium, the
// compiled client, the real routes, login/logout and an isolated SQLite
// database in a temporary root; the app and an upstream gate listen on their
// own temporary ports. The gate holds a save's redirect GET before it reaches
// the app, so it runs only when released (after a logout it runs unauthenticated
// and the app answers with its real login redirect).

const LIST_PATH = '/settings/asset-categories';
const PREFERENCE_PATH = /^\/settings\/asset-categories\/(browser-default|preview-category)$/;
const PREFS = {
  'browser-default': { select: '#global-asset-browser-default', key: 'asset_browser.default_category' },
  'preview-category': { select: '#global-preview-category', key: 'preview.default_category' },
};
let server;
let proxy;
let db;
let root;
let baseURL;
let categories;
let fixtures = 0;

// held: each redirect GET kept before the app runs it; release(mode) sends
// them on as they are ('as-is') or to the app's own Dashboard page ('unrelated').
const answers = {
  hold: 0,
  held: [],
  release(mode = 'as-is') { this.held.splice(0).forEach((send) => send(mode)); },
};

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-preference-ack-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  const viteDistRoot = path.join(root, 'client');
  fs.mkdirSync(projectsRoot);
  fs.mkdirSync(appDataRoot);
  await build({ build: { outDir: viteDistRoot }, logLevel: 'silent' });
  db = openDatabase(path.join(root, 'test.db'));
  runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
  categories = createAssetCategoryService(createAssetCategoryRepository(db));
  const provider = createStaticCredentialProvider({ username: AUTH_CONFIG.username, passwordHash: AUTH_CONFIG.passwordHash });
  const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, {
    appDataRoot,
    authConfig: { ...AUTH_CONFIG, credentialProvider: provider },
    credentialProvider: provider,
    loginThrottler: createLoginThrottler({ baseDelayMs: 0, maxDelayMs: 0 }),
    useViteAssets: true,
    viteDistRoot,
    assetCategoryService: categories,
    assetManifest: createAssetManifest({ distRoot: viteDistRoot, manifestPath: path.join(viteDistRoot, '.vite', 'manifest.json') }),
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const appPort = server.address().port;
  const forward = (req, body, res, target = req.url) => {
    const upstream = http.request({ host: '127.0.0.1', port: appPort, method: req.method, path: target, headers: req.headers }, (answer) => {
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
      if (req.method === 'GET' && target.pathname === LIST_PATH && answers.hold > 0
        && /^(global_default|preview_category)_saved$/.test(target.searchParams.get('notice') || '')) {
        answers.hold -= 1;
        answers.held.push((mode) => forward(req, body, res, mode === 'unrelated' ? '/' : req.url));
        return;
      }
      forward(req, body, res);
    });
  });
  proxy.listen(0, '127.0.0.1');
  await new Promise((resolve) => proxy.once('listening', resolve));
  baseURL = `http://127.0.0.1:${proxy.address().port}`;
});

test.beforeEach(() => {
  answers.hold = 0;
  answers.held = [];
  db.prepare('DELETE FROM asset_category_defaults').run();
  db.prepare("DELETE FROM app_meta WHERE key IN ('asset_browser.default_category', 'preview.default_category')").run();
});

test.afterAll(async () => {
  answers.release();
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
    const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${fixtures}`;
    const row = categories.addDefault({ displayName: name, directorySlug: slug, enabled: true });
    return { id: row.id, name, slug };
  });
}

const storedPref = (identity) => db.prepare('SELECT value FROM app_meta WHERE key = ?').pluck().get(PREFS[identity].key) ?? null;
const enabledInDb = (category) => db.prepare('SELECT enabled FROM asset_category_defaults WHERE id = ?').pluck().get(category.id);
const prefRegion = (page, identity) => page.locator(`[data-settings-asset-category-preference="${identity}"]`);
const prefForm = (page, identity) => prefRegion(page, identity).locator('form');
const prefStatus = (page, identity) => prefRegion(page, identity).locator('[data-settings-fetch-save-status]');
const row = (page, category) => page.locator(`[data-settings-category-defaults] article[data-category-id="${category.id}"]`);
const prefView = (page, identity) => prefRegion(page, identity).evaluate((region) => {
  const select = region.querySelector('select');
  return {
    native: [...(select?.options || [])].filter((option) => !option.disabled).map((option) => option.value),
    panel: [...region.querySelectorAll('[data-cc-dropdown] input[type="radio"]')].filter((input) => !input.disabled).map((input) => input.value),
    value: select?.value ?? null,
    status: region.querySelector('[data-settings-fetch-save-status]')?.textContent.trim() || '',
    state: region.querySelector('form')?.getAttribute('data-settings-fetch-save-state') || null,
    stored: region.getAttribute('data-settings-asset-category-preference-stored'),
    busy: region.querySelector('form')?.getAttribute('aria-busy') === 'true',
  };
});
const choose = (page, identity, value) => page.locator(PREFS[identity].select).evaluate((select, next) => {
  select.value = next;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}, value);

async function login(page) {
  await page.goto(`${baseURL}/login`);
  await page.locator('#username').fill(TEST_USERNAME);
  await page.locator('#password').fill(TEST_PASSWORD);
  await Promise.all([page.waitForURL((url) => url.pathname === '/'), page.locator('#password').press('Enter')]);
}

async function open(page) {
  const control = { posts: [], answerGets: [], navigations: 0, errors: [] };
  page.on('pageerror', (error) => control.errors.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() === 'POST' && PREFERENCE_PATH.test(url.pathname)) control.posts.push(url.pathname);
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (response.request().resourceType() === 'fetch' && response.request().method() === 'GET'
      && (url.pathname === '/login' || /_saved$/.test(url.searchParams.get('notice') || ''))) {
      control.answerGets.push({ pathname: url.pathname, status: response.status(), redirect: Boolean(response.request().redirectedFrom()) });
    }
  });
  await page.goto(`${baseURL}${LIST_PATH}`);
  await page.locator('[data-settings-category-defaults]').waitFor({ state: 'attached' });
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) control.navigations += 1; });
  await page.evaluate(() => { window.__sameDocument = true; });
  return control;
}

async function expectSameDocument(page, control) {
  expect(await page.evaluate(() => window.__sameDocument)).toBe(true);
  expect(control.navigations).toBe(0);
  expect(new URL(page.url()).pathname).toBe(LIST_PATH);
}

// Saves `value` with its redirect GET held before the app runs it.
async function saveHeld(page, identity, value) {
  answers.hold += 1;
  await choose(page, identity, value);
  await expect.poll(() => answers.held.length).toBe(1);
  await expect(prefForm(page, identity)).toHaveAttribute('aria-busy', 'true');
}

// Tab 2 (same browser context) turns `category` off with its status switch.
async function disableElsewhere(tab, category) {
  await tab.goto(`${baseURL}${LIST_PATH}`);
  await tab.locator(`label[for="global-category-enabled-${category.id}"]`).click();
  await expect.poll(() => enabledInDb(category)).toBe(0);
}

// Tab 1's own authoritative read of the list: the confirmed Delete of an
// unrelated default re-reads the list (GET) and installs it. Its POST is held
// first so a preference save can still start (a saving setting refuses Delete).
async function holdUnrelatedDelete(page, other) {
  const held = [];
  await page.route((url) => url.pathname === `${LIST_PATH}/${other.id}/delete`, (route) => { held.push(route); });
  await row(page, other).locator('form[data-settings-category-delete-form] button').click();
  await page.locator('#app-confirmation-dialog [data-app-dialog-confirmation-confirm]').click();
  await expect.poll(() => held.length).toBe(1);
  return async () => {
    await held[0].continue();
    await expect(row(page, other)).toHaveCount(0);
    await expect(page.locator('[data-dialog-feedback]')).toContainText('The category defaults are up to date.');
  };
}

const UNCONFIRMED_DISABLED = 'Could not confirm whether this setting was saved. That category default is disabled, so choose another category or enable it first.';

for (const identity of ['browser-default', 'preview-category']) {
  test(`B-${identity}: the save ran, its delayed answer became the login page after a logout — not acknowledged; the disabled choice is not offered; nothing reads "Settings saved."`, async ({ page }) => {
    const [target, other, spare] = seed(['Ack Target', 'Ack Other', 'Ack Spare']);
    await login(page);
    const control = await open(page);
    const before = await prefView(page, identity);
    const otherIdentity = identity === 'browser-default' ? 'preview-category' : 'browser-default';
    const otherBefore = await prefView(page, otherIdentity);

    const releaseDelete = await holdUnrelatedDelete(page, other);
    await saveHeld(page, identity, target.slug);
    // 1. The preference service really committed.
    expect(storedPref(identity)).toBe(target.slug);
    // 3. Another tab disables it.
    const tab = await page.context().newPage();
    await disableElsewhere(tab, target);
    // 4. This page's authoritative read installs the disabled state.
    await releaseDelete();
    await expect(page.locator(`#global-category-enabled-${target.id}`)).not.toBeChecked();
    // 5. Log out (tab 2).
    await Promise.all([
      tab.waitForURL((url) => url.pathname === '/login'),
      tab.locator('form.app-logout-form').first().evaluate((form) => form.requestSubmit()),
    ]);
    // 6. The delayed answer runs unauthenticated: the app's login redirect.
    answers.release();
    await expect(prefForm(page, identity)).not.toHaveAttribute('aria-busy', 'true');
    await expect.poll(() => control.answerGets.map(({ pathname, status }) => `${pathname} ${status}`))
      .toEqual([`${LIST_PATH} 302`, '/login 200']);

    const view = await prefView(page, identity);
    expect(control.posts).toEqual([`${LIST_PATH}/${identity}`]);
    expect(storedPref(identity)).toBe(target.slug);
    expect(enabledInDb(target)).toBe(0);
    expect(view.status).not.toBe('Settings saved.');
    expect(view.state).toBe('error');
    expect(view.status).toBe(UNCONFIRMED_DISABLED);
    // The previous acknowledged value is what the page says is stored.
    expect(view.stored).toBe(before.stored);
    // The disabled default cannot be chosen.
    expect(view.native).not.toContain(target.slug);
    expect(view.panel).not.toContain(target.slug);
    expect(view.native).toContain(spare.slug);
    // The other setting is untouched.
    expect(await prefView(page, otherIdentity)).toMatchObject({ stored: otherBefore.stored, status: otherBefore.status, value: otherBefore.value });
    await expectSameDocument(page, control);
    expect(control.errors).toEqual([]);
    await tab.close();
  });
}

test('C: a redirected 200 answer that is another page (no preference region) is not acknowledged; a later valid save is acknowledged once in place', async ({ page }) => {
  const [first, second] = seed(['Plain First', 'Plain Second']);
  await login(page);
  const control = await open(page);
  const before = await prefView(page, 'browser-default');

  await saveHeld(page, 'browser-default', first.slug);
  answers.release('unrelated');
  await expect(prefForm(page, 'browser-default')).not.toHaveAttribute('aria-busy', 'true');
  let view = await prefView(page, 'browser-default');
  expect(storedPref('browser-default')).toBe(first.slug);
  expect(control.posts).toHaveLength(1);
  expect(view).toMatchObject({ state: 'error', status: 'Could not save settings. Your current changes were kept.', stored: before.stored, value: first.slug });
  expect(view.native).toContain(first.slug);

  // I. Recovery: an intentional valid save, acknowledged by its real answer.
  await choose(page, 'browser-default', second.slug);
  await expect(prefStatus(page, 'browser-default')).toHaveText('Settings saved.');
  view = await prefView(page, 'browser-default');
  expect(view).toMatchObject({ state: 'saved', stored: second.slug, value: second.slug, busy: false });
  expect(storedPref('browser-default')).toBe(second.slug);
  expect(control.posts).toHaveLength(2);
  await expectSameDocument(page, control);
  expect(control.errors).toEqual([]);
});

test('A: a normal save is acknowledged by its Settings answer — one POST, stored, "Settings saved." for that setting only', async ({ page }) => {
  const [first] = seed(['Normal First']);
  await login(page);
  const control = await open(page);
  for (const identity of ['browser-default', 'preview-category']) {
    await choose(page, identity, first.slug);
    await expect(prefStatus(page, identity)).toHaveText('Settings saved.');
    expect(await prefView(page, identity)).toMatchObject({ state: 'saved', stored: first.slug, value: first.slug, busy: false });
    expect(storedPref(identity)).toBe(first.slug);
  }
  expect(control.posts).toEqual([`${LIST_PATH}/browser-default`, `${LIST_PATH}/preview-category`]);
  await expectSameDocument(page, control);
  expect(control.errors).toEqual([]);
});
