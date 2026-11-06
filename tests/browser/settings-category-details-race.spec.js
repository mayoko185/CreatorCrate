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

// WP11C-F4: an older Category Details Save answer must not save, lose or
// misreport newer typing. Real Chromium, the compiled client, the real
// Settings routes, templates and category service, an isolated SQLite
// database and a temporary port. An upstream gate between the browser and the
// app lets a details POST reach the real service (which commits or refuses
// it) and holds only that answer on its way back, so the answer is as old as
// the moment the server produced it.

const LIST_PATH = '/settings/asset-categories';
const DETAILS_PATH = /^\/settings\/asset-categories\/(\d+)$/;
const DELETE_PATH = /^\/settings\/asset-categories\/\d+\/delete$/;
let server;
let proxy;
let db;
let root;
let baseURL;
let categories;
let fixtures = 0;
const mutations = [];

const detailsGate = {
  hold: 0,
  // Every details POST that reached the gate: { id, body }.
  posts: [],
  // Answers produced by the server and not yet delivered.
  held: [],
  release(index = 0) { this.held.splice(index, 1).forEach((deliver) => deliver()); },
  releaseAll() { this.held.splice(0).forEach((deliver) => deliver()); },
};

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-category-details-race-'));
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
    // Every default mutation the page can cause, counted with its outcome.
    editDefault: (id, values) => {
      try {
        const result = real.editDefault(id, values);
        mutations.push(['edit', id, values.displayName, values.directorySlug, 'ok']);
        return result;
      } catch (error) {
        mutations.push(['edit', id, values.displayName, values.directorySlug, 'refused']);
        throw error;
      }
    },
    setDefaultEnabled: (id, enabled) => {
      mutations.push(['enabled', id, enabled]);
      return real.setDefaultEnabled(id, enabled);
    },
    reorderDefaults: (ids) => {
      mutations.push(['reorder']);
      return real.reorderDefaults(ids);
    },
    deleteDefault: (id) => {
      mutations.push(['delete', id]);
      return real.deleteDefault(id);
    },
  };
  const { csrfPepper } = ensureAuthEnablement(appDataRoot);
  const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, {
    appDataRoot, authState: { csrfPepper }, useViteAssets: true, viteDistRoot, assetCategoryService: categories,
    assetManifest: createAssetManifest({ distRoot: viteDistRoot,
      manifestPath: path.join(viteDistRoot, '.vite', 'manifest.json') }),
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const appPort = server.address().port;
  const upstream = (req, body, onAnswer) => {
    const request = http.request({ host: '127.0.0.1', port: appPort, method: req.method, path: req.url, headers: req.headers }, (answer) => {
      const chunks = [];
      answer.on('data', (chunk) => chunks.push(chunk));
      answer.on('end', () => onAnswer(answer, Buffer.concat(chunks)));
    });
    request.on('error', () => onAnswer(null, Buffer.alloc(0)));
    request.end(body);
  };
  proxy = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const target = new URL(req.url, 'http://gate');
      const details = req.method === 'POST' && DETAILS_PATH.exec(target.pathname);
      let hold = false;
      if (details) {
        detailsGate.posts.push({ id: Number(details[1]), body: new URLSearchParams(body.toString()) });
        if (detailsGate.hold > 0) {
          detailsGate.hold -= 1;
          hold = true;
        }
      }
      upstream(req, body, (answer, payload) => {
        const deliver = () => {
          if (!answer) { res.writeHead(502); res.end(); return; }
          res.writeHead(answer.statusCode, answer.headers);
          res.end(payload);
        };
        if (hold) detailsGate.held.push(deliver);
        else deliver();
      });
    });
  });
  proxy.listen(0, '127.0.0.1');
  await new Promise((resolve) => proxy.once('listening', resolve));
  baseURL = `http://127.0.0.1:${proxy.address().port}`;
});

test.beforeEach(() => {
  detailsGate.hold = 0;
  detailsGate.posts = [];
  detailsGate.held = [];
  mutations.length = 0;
  db.prepare('DELETE FROM asset_category_defaults').run();
  db.prepare("DELETE FROM app_meta WHERE key IN ('asset_browser.default_category', 'preview.default_category')").run();
});

test.afterAll(async () => {
  detailsGate.releaseAll();
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
    return { id: row.id, name, slug };
  });
}

// control.reads: 'pass' | 'fail' for in-page GET reads of the list.
async function open(page) {
  const control = { reads: 'pass', reads_: [], browserDetailsPosts: [] };
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() === 'POST' && DETAILS_PATH.test(pathname)) control.browserDetailsPosts.push(pathname);
    if (request.method() === 'GET' && request.resourceType() === 'fetch' && pathname === LIST_PATH && !new URL(request.url()).search) {
      control.reads_.push(pathname);
    }
  });
  await page.route((target) => target.pathname === LIST_PATH, async (route) => {
    if (route.request().resourceType() === 'fetch' && route.request().method() === 'GET'
      && !new URL(route.request().url()).search && control.reads === 'fail') return route.abort('failed');
    return route.fallback();
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${baseURL}${LIST_PATH}`);
  await page.locator('[data-settings-category-defaults]').waitFor({ state: 'attached' });
  await page.evaluate(() => { window.__sameDocument = true; });
  return { control, errors };
}

const row = (page, category) => page.locator(`[data-settings-category-defaults] article[data-category-id="${category.id}"]`);
const nameField = (page, category) => page.locator(`#global-category-${category.id}-display-name`);
const slugField = (page, category) => page.locator(`#global-category-${category.id}-directory-slug`);
const detailsForm = (page, category) => row(page, category).locator('form[data-category-details-form]');
const detailsStatus = (page, category) => row(page, category).locator('[data-category-details-status]');
const feedback = (page) => page.locator('[data-dialog-feedback]');
const deleteButton = (page, category) => row(page, category).locator('form[data-settings-category-delete-form] button');
const confirmButton = (page) => page.locator('#app-confirmation-dialog [data-app-dialog-confirmation-confirm]');
const savedRow = (category) => db.prepare('SELECT display_name, directory_slug, display_order, enabled FROM asset_category_defaults WHERE id = ?').get(category.id) || null;
const postsFor = (category) => detailsGate.posts.filter((post) => post.id === category.id);
const edits = () => mutations.filter((entry) => entry[0] === 'edit');
const fieldState = (locator) => locator.evaluate((field) => ({
  value: field.value,
  saved: field.defaultValue,
  focused: document.activeElement === field,
  selection: [field.selectionStart, field.selectionEnd],
  sameElement: field.__f4Marker === true,
  invalid: field.getAttribute('aria-invalid'),
}));
const markField = (locator) => locator.evaluate((field) => { field.__f4Marker = true; });
// Records the browser's own change/blur/focusout events on the page.
const recordEvents = (page) => page.evaluate(() => {
  window.__f4Events = [];
  ['change', 'blur', 'focusout'].forEach((type) => document.addEventListener(type, (event) => {
    if (event.target?.matches?.('input[name="displayName"], input[name="directorySlug"]')) {
      window.__f4Events.push(`${type}:${event.target.id}`);
    }
  }, true));
});
const recordedEvents = (page) => page.evaluate(() => window.__f4Events.splice(0));
const settle = (page) => page.waitForTimeout(500);
const SAVED = 'Details saved.';
const EARLIER_SAVED = 'Earlier changes saved. Current changes have not been saved.';
const EARLIER_REFUSED = 'Could not save the earlier category details. Current changes have not been saved.';
const REFUSED = 'Could not save category details. Current changes have not been saved.';

// Saves `value` into `field` by the person's Tab; its answer is held after
// the server has run it.
async function saveHeld(page, field, value) {
  const held = detailsGate.held.length;
  detailsGate.hold += 1;
  await field.fill(value);
  await page.keyboard.press('Tab');
  await expect.poll(() => detailsGate.held.length).toBe(held + 1);
}

// Back into `field` with the caret at the end; types `text`, then selects the
// last two characters.
async function typeNewer(page, field, text) {
  await field.click();
  await page.keyboard.press('End');
  await page.keyboard.type(text);
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Shift+ArrowLeft');
  await markField(field);
}

async function nameRace(page, { a, b, c }) {
  const others = [savedRow(a), savedRow(c)];
  await recordEvents(page);
  await saveHeld(page, nameField(page, b), 'Bravo One');
  // The first Save ran exactly once and committed B1; its answer is held.
  expect(postsFor(b)).toHaveLength(1);
  expect(postsFor(b)[0].body.get('displayName')).toBe('Bravo One');
  expect(postsFor(b)[0].body.get('directorySlug')).toBe(b.slug);
  expect(edits()).toEqual([['edit', b.id, 'Bravo One', b.slug, 'ok']]);
  expect(savedRow(b).display_name).toBe('Bravo One');
  await expect(detailsForm(page, b)).toHaveAttribute('aria-busy', 'true');

  await typeNewer(page, nameField(page, b), ' Two');
  const draft = 'Bravo One Two';
  const pre = await fieldState(nameField(page, b));
  expect(pre).toMatchObject({ value: draft, focused: true, selection: [draft.length - 2, draft.length] });
  await recordedEvents(page);

  detailsGate.releaseAll();
  await expect(detailsForm(page, b)).not.toHaveAttribute('aria-busy', 'true');
  await settle(page);
  const events = await recordedEvents(page);
  const after = await fieldState(nameField(page, b));
  const facts = {
    posts: postsFor(b).map((post) => post.body.get('displayName')),
    edits: edits().length,
    saved: savedRow(b).display_name,
    field: after,
    status: await detailsStatus(page, b).textContent(),
    events,
  };
  console.log('F4 name race after the old answer:', JSON.stringify(facts));
  expect.soft(facts.posts, 'details POSTs before the person finishes B2').toEqual(['Bravo One']);
  expect.soft(facts.edits, 'service executions').toBe(1);
  expect.soft(facts.saved, 'B in SQLite').toBe('Bravo One');
  expect.soft(after, 'B2 stays a focused, unsaved draft on the same field').toEqual({
    value: draft, saved: 'Bravo One', focused: true, selection: [draft.length - 2, draft.length], sameElement: true, invalid: null,
  });
  expect.soft(facts.status).toBe(EARLIER_SAVED);
  expect.soft(events, 'events raised by installing the answer').toEqual([]);
  expect([savedRow(a), savedRow(c)]).toEqual(others);
  return draft;
}

test('F4-B1: original name race — the old answer saves nothing more, keeps B2 as a draft; Tab then saves B2 once', async ({ page }) => {
  const [a, b, c] = seed(['Alpha F4', 'Bravo F4', 'Charlie F4']);
  const { control, errors } = await open(page);
  const draft = await nameRace(page, { a, b, c });

  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, b)).toHaveText(SAVED);
  expect(postsFor(b).map((post) => post.body.get('displayName'))).toEqual(['Bravo One', draft]);
  expect(edits()).toHaveLength(2);
  expect(savedRow(b).display_name).toBe(draft);
  await expect(nameField(page, b)).toHaveJSProperty('defaultValue', draft);
  await expect(slugField(page, b)).toBeFocused();
  await settle(page);
  expect(postsFor(b)).toHaveLength(2);
  expect(postsFor(a)).toHaveLength(0);
  expect(postsFor(c)).toHaveLength(0);
  expect(control.browserDetailsPosts).toHaveLength(2);
  expect(await page.evaluate(() => window.__sameDocument)).toBe(true);
  expect(errors).toEqual([]);
});

test('F4-B2: original slug race — no implicit save of the newer slug; Tab saves it once; uniqueness still refused', async ({ page }) => {
  const [a, b, c] = seed(['Alpha F4S', 'Bravo F4S', 'Charlie F4S']);
  const { errors } = await open(page);
  const others = [savedRow(a), savedRow(c)];
  await recordEvents(page);
  await saveHeld(page, slugField(page, b), 'bravo-one');
  expect(savedRow(b).directory_slug).toBe('bravo-one');
  expect(edits()).toHaveLength(1);
  await typeNewer(page, slugField(page, b), '-two');
  await recordedEvents(page);
  detailsGate.releaseAll();
  await expect(detailsForm(page, b)).not.toHaveAttribute('aria-busy', 'true');
  await settle(page);
  const after = await fieldState(slugField(page, b));
  console.log('F4 slug race after the old answer:', JSON.stringify({ posts: postsFor(b).length, saved: savedRow(b).directory_slug, after }));
  expect.soft(postsFor(b)).toHaveLength(1);
  expect.soft(edits()).toHaveLength(1);
  expect.soft(savedRow(b).directory_slug).toBe('bravo-one');
  expect.soft(after).toEqual({ value: 'bravo-one-two', saved: 'bravo-one', focused: true, selection: [11, 13], sameElement: true, invalid: null });
  expect.soft(await detailsStatus(page, b).textContent()).toBe(EARLIER_SAVED);
  expect.soft(await recordedEvents(page)).toEqual([]);

  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, b)).toHaveText(SAVED);
  expect(savedRow(b).directory_slug).toBe('bravo-one-two');
  expect(postsFor(b)).toHaveLength(2);
  await expect(slugField(page, b)).toHaveJSProperty('defaultValue', 'bravo-one-two');

  // Uniqueness is still the server's: C's slug is refused for B and kept.
  await slugField(page, b).fill(c.slug);
  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, b)).toHaveText(REFUSED);
  expect(savedRow(b).directory_slug).toBe('bravo-one-two');
  await expect(slugField(page, b)).toHaveValue(c.slug);
  expect([savedRow(a), savedRow(c)]).toEqual(others);
  expect(errors).toEqual([]);
});

test('F4-B3: a held 422 for the old value — refusal stays with it; the newer draft is kept, not sent; then saved by Tab', async ({ page }) => {
  const [b] = seed(['Bravo F4R']);
  const { errors } = await open(page);
  const before = savedRow(b);
  await recordEvents(page);

  // Slug: the refused value is A; the newer typing is B.
  await saveHeld(page, slugField(page, b), 'Bad Slug!');
  expect(edits()).toEqual([['edit', b.id, b.name, 'Bad Slug!', 'refused']]);
  await slugField(page, b).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('bravo-fixed');
  await markField(slugField(page, b));
  await recordedEvents(page);
  detailsGate.releaseAll();
  await expect(detailsStatus(page, b)).toHaveText(EARLIER_REFUSED);
  await settle(page);
  expect(postsFor(b)).toHaveLength(1);
  expect(savedRow(b)).toEqual(before);
  expect(await fieldState(slugField(page, b))).toMatchObject({ value: 'bravo-fixed', focused: true, sameElement: true, invalid: 'true' });
  await expect(row(page, b).locator('.error-summary')).toBeVisible();
  expect(await recordedEvents(page)).toEqual([]);
  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, b)).toHaveText(SAVED);
  expect(savedRow(b).directory_slug).toBe('bravo-fixed');
  expect(postsFor(b)).toHaveLength(2);
  await expect(slugField(page, b)).not.toHaveAttribute('aria-invalid', 'true');
  await expect(row(page, b).locator('.error-summary')).toHaveCount(0);

  // Name: an empty name is refused; the newer name is kept, then saved.
  await saveHeld(page, nameField(page, b), '');
  await nameField(page, b).click();
  await page.keyboard.type('Bravo Named');
  detailsGate.releaseAll();
  await expect(detailsStatus(page, b)).toHaveText(EARLIER_REFUSED);
  await settle(page);
  expect(postsFor(b)).toHaveLength(3);
  expect(savedRow(b).display_name).toBe(b.name);
  await expect(nameField(page, b)).toHaveValue('Bravo Named');
  await expect(nameField(page, b)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, b)).toHaveText(SAVED);
  expect(savedRow(b).display_name).toBe('Bravo Named');
  expect(postsFor(b)).toHaveLength(4);
  expect(errors).toEqual([]);
});

test('F4-B4: two fields — a held name answer neither sends nor drops a focused slug draft (and the reverse)', async ({ page }) => {
  const [b] = seed(['Bravo F4F']);
  const { errors } = await open(page);
  await recordEvents(page);
  // Tab from the name lands in the slug, where the person keeps typing.
  await saveHeld(page, nameField(page, b), 'Bravo Field');
  await expect(slugField(page, b)).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.type('-x');
  await markField(slugField(page, b));
  await recordedEvents(page);
  detailsGate.releaseAll();
  await expect(detailsStatus(page, b)).toHaveText(EARLIER_SAVED);
  await settle(page);
  expect(postsFor(b)).toHaveLength(1);
  expect(savedRow(b)).toMatchObject({ display_name: 'Bravo Field', directory_slug: b.slug });
  expect(await fieldState(slugField(page, b))).toMatchObject({ value: `${b.slug}-x`, saved: b.slug, focused: true, sameElement: true });
  await expect(nameField(page, b)).toHaveJSProperty('defaultValue', 'Bravo Field');
  expect(await recordedEvents(page)).toEqual([]);
  await page.keyboard.press('Shift+Tab');
  await expect(detailsStatus(page, b)).toHaveText(SAVED);
  expect(savedRow(b).directory_slug).toBe(`${b.slug}-x`);
  expect(postsFor(b)).toHaveLength(2);

  // Reverse: a held slug answer while the name is being typed.
  await expect(nameField(page, b)).toBeFocused();
  await slugField(page, b).focus();
  await saveHeld(page, slugField(page, b), 'bravo-reverse');
  await nameField(page, b).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Rev');
  detailsGate.releaseAll();
  await expect(detailsStatus(page, b)).toHaveText(EARLIER_SAVED);
  await settle(page);
  expect(postsFor(b)).toHaveLength(3);
  expect(savedRow(b)).toMatchObject({ display_name: 'Bravo Field', directory_slug: 'bravo-reverse' });
  await expect(nameField(page, b)).toHaveValue('Bravo Field Rev');
  await expect(nameField(page, b)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, b)).toHaveText(SAVED);
  expect(savedRow(b).display_name).toBe('Bravo Field Rev');
  expect(postsFor(b)).toHaveLength(4);
  expect(errors).toEqual([]);
});

test('F4-B5: two categories — B answers while C holds a focused draft; out-of-order answers settle each row alone', async ({ page }) => {
  const [a, b, c] = seed(['Alpha F4C', 'Bravo F4C', 'Charlie F4C']);
  const { errors } = await open(page);
  const aBefore = savedRow(a);
  await saveHeld(page, nameField(page, b), 'Bravo Cat');
  await typeNewer(page, nameField(page, c), ' draft');
  const cPre = await fieldState(nameField(page, c));
  detailsGate.releaseAll();
  await expect(detailsStatus(page, b)).toHaveText(SAVED);
  await settle(page);
  expect(postsFor(c)).toHaveLength(0);
  expect(savedRow(c).display_name).toBe('Charlie F4C');
  expect(await fieldState(nameField(page, c))).toEqual(cPre);
  await expect(detailsStatus(page, c)).toHaveText('');
  await expect(nameField(page, b)).toHaveValue('Bravo Cat');
  // Leaving C is the person's own end of that edit: it saves once.
  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, c)).toHaveText(SAVED);
  expect(postsFor(c)).toHaveLength(1);
  expect(savedRow(c).display_name).toBe('Charlie F4C draft');

  // Two saves pending at once: B's slug and C's name; A then holds a draft.
  await saveHeld(page, slugField(page, b), 'bravo-cat');
  await saveHeld(page, nameField(page, c), 'Charlie Two');
  await typeNewer(page, nameField(page, a), ' wip');
  // C answers first, then B.
  detailsGate.release(1);
  await expect(detailsStatus(page, c)).toHaveText(SAVED);
  await expect(detailsForm(page, b)).toHaveAttribute('aria-busy', 'true');
  detailsGate.releaseAll();
  await expect(detailsStatus(page, b)).toHaveText(SAVED);
  await settle(page);
  expect(savedRow(b)).toMatchObject({ display_name: 'Bravo Cat', directory_slug: 'bravo-cat' });
  expect(savedRow(c).display_name).toBe('Charlie Two');
  expect(savedRow(a)).toEqual(aBefore);
  expect(postsFor(a)).toHaveLength(0);
  await expect(nameField(page, a)).toHaveValue('Alpha F4C wip');
  await expect(nameField(page, a)).toBeFocused();
  expect(await page.locator('[data-settings-category-defaults] article[data-category-id]')
    .evaluateAll((nodes) => nodes.map((node) => Number(node.getAttribute('data-category-id'))))).toEqual([a.id, b.id, c.id]);
  expect(errors).toEqual([]);
});

test('F4-B6: a held save answer released after a Delete’s list read installed — no second save, no lost draft, no deleted row back', async ({ page }) => {
  const [a, b, c] = seed(['Alpha F4L', 'Bravo F4L', 'Charlie F4L']);
  const { control, errors } = await open(page);
  await saveHeld(page, nameField(page, b), 'Bravo List');
  await deleteButton(page, a).click();
  await confirmButton(page).click();
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await expect(row(page, a)).toHaveCount(0);
  expect(control.reads_).toHaveLength(1);
  await expect(detailsForm(page, b)).toHaveAttribute('aria-busy', 'true');
  await recordEvents(page);
  await typeNewer(page, nameField(page, b), ' Two');
  await recordedEvents(page);
  detailsGate.releaseAll();
  await expect(detailsStatus(page, b)).toHaveText(EARLIER_SAVED);
  await settle(page);
  expect(postsFor(b)).toHaveLength(1);
  expect(savedRow(b).display_name).toBe('Bravo List');
  expect(savedRow(a)).toBe(null);
  await expect(row(page, a)).toHaveCount(0);
  expect(await fieldState(nameField(page, b))).toMatchObject({ value: 'Bravo List Two', saved: 'Bravo List', focused: true, sameElement: true });
  expect(await recordedEvents(page)).toEqual([]);
  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, b)).toHaveText(SAVED);
  expect(savedRow(b).display_name).toBe('Bravo List Two');
  expect(postsFor(b)).toHaveLength(2);
  expect(postsFor(c)).toHaveLength(0);
  expect(mutations.filter((entry) => entry[0] === 'delete')).toEqual([['delete', a.id]]);
  expect(errors).toEqual([]);
});

test('F4-B7: failed list read and GET-only Retry while a save answer settles — truthful state, no duplicate save', async ({ page }) => {
  const [a, b, c] = seed(['Alpha F4G', 'Bravo F4G', 'Charlie F4G']);
  const { control, errors } = await open(page);
  await saveHeld(page, nameField(page, b), 'Bravo Get');
  control.reads = 'fail';
  await deleteButton(page, a).click();
  await confirmButton(page).click();
  await expect(feedback(page)).toContainText('could not be refreshed and may be out of date');
  await typeNewer(page, nameField(page, b), ' Two');
  detailsGate.releaseAll();
  await expect(detailsStatus(page, b)).toHaveText(EARLIER_SAVED);
  await settle(page);
  expect(postsFor(b)).toHaveLength(1);
  expect(savedRow(b).display_name).toBe('Bravo Get');
  await expect(nameField(page, b)).toHaveValue('Bravo Get Two');
  await expect(row(page, a)).toHaveCount(0);
  // The person finishes B2 (one save), then Retry refresh only reads.
  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, b)).toHaveText(SAVED);
  expect(postsFor(b)).toHaveLength(2);
  control.reads = 'pass';
  const reads = control.reads_.length;
  const retry = feedback(page).locator('[data-settings-category-delete-refresh-retry]');
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  expect(control.reads_.length).toBe(reads + 1);
  expect(postsFor(b)).toHaveLength(2);
  expect(postsFor(c)).toHaveLength(0);
  expect(savedRow(b).display_name).toBe('Bravo Get Two');
  await expect(nameField(page, b)).toHaveValue('Bravo Get Two');
  expect(mutations.filter((entry) => entry[0] === 'delete')).toEqual([['delete', a.id]]);
  expect(errors).toEqual([]);
});

test('F4-B8: normal editing — Tab, Enter, pointer and status switch save once each; refusals and corrections work', async ({ page }) => {
  const [a, b] = seed(['Alpha F4N', 'Bravo F4N']);
  const { errors } = await open(page);
  // Name then slug, by Tab.
  await nameField(page, b).fill('Bravo Normal');
  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, b)).toHaveText(SAVED);
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('bravo-normal');
  await page.keyboard.press('Enter');
  await expect(slugField(page, b)).toHaveJSProperty('defaultValue', 'bravo-normal');
  await expect(detailsStatus(page, b)).toHaveText(SAVED);
  expect(savedRow(b)).toMatchObject({ display_name: 'Bravo Normal', directory_slug: 'bravo-normal' });
  expect(postsFor(b)).toHaveLength(2);
  // Slug then name, leaving by pointer.
  await slugField(page, b).fill('bravo-pointer');
  await nameField(page, b).click();
  await expect(slugField(page, b)).toHaveJSProperty('defaultValue', 'bravo-pointer');
  await nameField(page, b).fill('Bravo Pointer');
  await page.locator('#settings-category-defaults-heading').click();
  await expect(nameField(page, b)).toHaveJSProperty('defaultValue', 'Bravo Pointer');
  expect(postsFor(b)).toHaveLength(4);
  // Invalid name, duplicate slug, then corrections.
  await nameField(page, b).fill('');
  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, b)).toHaveText(REFUSED);
  expect(savedRow(b).display_name).toBe('Bravo Pointer');
  await nameField(page, b).fill('Bravo Fixed');
  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, b)).toHaveText(SAVED);
  await slugField(page, b).fill(a.slug);
  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, b)).toHaveText(REFUSED);
  expect(savedRow(b).directory_slug).toBe('bravo-pointer');
  await slugField(page, b).fill('bravo-fixed');
  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, b)).toHaveText(SAVED);
  expect(savedRow(b)).toMatchObject({ display_name: 'Bravo Fixed', directory_slug: 'bravo-fixed' });
  await settle(page);
  expect(postsFor(b)).toHaveLength(8);
  // The status switch is its own form and still saves once.
  const enabled = row(page, b).locator('form.category-enabled-form input[type="checkbox"]');
  await enabled.click({ force: true });
  await expect.poll(() => savedRow(b).enabled).toBe(0);
  await settle(page);
  expect(mutations.filter((entry) => entry[0] === 'enabled')).toEqual([['enabled', b.id, false]]);
  expect(postsFor(a)).toHaveLength(0);
  expect(errors).toEqual([]);
});

test('F4-B11: a browser without atomic moves — the old answer still saves nothing and keeps B2; Tab saves it once', async ({ page }) => {
  await page.addInitScript(() => { delete Element.prototype.moveBefore; });
  const [a, b, c] = seed(['Alpha F4M', 'Bravo F4M', 'Charlie F4M']);
  const { errors } = await open(page);
  expect(await page.evaluate(() => typeof Element.prototype.moveBefore)).toBe('undefined');
  const draft = await nameRace(page, { a, b, c });
  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, b)).toHaveText(SAVED);
  expect(savedRow(b).display_name).toBe(draft);
  expect(postsFor(b)).toHaveLength(2);
  expect(errors).toEqual([]);
});
