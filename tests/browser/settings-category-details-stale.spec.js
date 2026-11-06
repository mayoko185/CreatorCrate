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

// WP11C-F7: an older Category Details Save REQUEST that reaches the server
// after a newer, acknowledged save of the same category must not overwrite
// it. Real Chromium, the compiled client, the real Settings routes, templates
// and category service, an isolated SQLite database and a temporary port.
// An upstream gate between the browser and the app can hold a details POST
// before the app has seen it (the original request, not a delayed answer),
// or hold the answer after the service ran (WP11C-F4).

const LIST_PATH = '/settings/asset-categories';
const DETAILS_PATH = /^\/settings\/asset-categories\/(\d+)$/;
let server;
let proxy;
let db;
let root;
let baseURL;
let categories;
let fixtures = 0;
const mutations = [];

const gate = {
  holdRequests: 0,
  holdAnswers: 0,
  // Every details POST that reached the gate: { id, body }.
  posts: [],
  // Requests not yet sent on to the app, and answers not yet delivered.
  heldRequests: [],
  heldAnswers: [],
  releaseRequests() { this.heldRequests.splice(0).forEach((forward) => forward()); },
  releaseAnswers() { this.heldAnswers.splice(0).forEach((deliver) => deliver()); },
};

function outcomeOf(error) {
  if (error?.name === 'AssetCategoryStaleError') return 'stale';
  if (error?.name === 'AssetCategoryNotFoundError') return 'missing';
  return 'refused';
}

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-category-details-stale-'));
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
    // Every service execution of a details save, with its outcome.
    editDefault: (id, values) => {
      try {
        const result = real.editDefault(id, values);
        mutations.push(['edit', id, values.displayName, values.directorySlug, 'ok']);
        return result;
      } catch (error) {
        mutations.push(['edit', id, values.displayName, values.directorySlug, outcomeOf(error)]);
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
      const details = req.method === 'POST' && DETAILS_PATH.exec(new URL(req.url, 'http://gate').pathname);
      let holdRequest = false;
      let holdAnswer = false;
      if (details) {
        gate.posts.push({ id: Number(details[1]), body: new URLSearchParams(body.toString()) });
        if (gate.holdRequests > 0) { gate.holdRequests -= 1; holdRequest = true; }
        else if (gate.holdAnswers > 0) { gate.holdAnswers -= 1; holdAnswer = true; }
      }
      const forward = () => upstream(req, body, (answer, payload) => {
        const deliver = () => {
          if (!answer) { res.writeHead(502); res.end(); return; }
          res.writeHead(answer.statusCode, answer.headers);
          res.end(payload);
        };
        if (holdAnswer) gate.heldAnswers.push(deliver);
        else deliver();
      });
      if (holdRequest) gate.heldRequests.push(forward);
      else forward();
    });
  });
  proxy.listen(0, '127.0.0.1');
  await new Promise((resolve) => proxy.once('listening', resolve));
  baseURL = `http://127.0.0.1:${proxy.address().port}`;
});

test.beforeEach(() => {
  gate.holdRequests = 0;
  gate.holdAnswers = 0;
  gate.posts = [];
  gate.heldRequests = [];
  gate.heldAnswers = [];
  mutations.length = 0;
  db.prepare('DELETE FROM asset_category_defaults').run();
  db.prepare("DELETE FROM app_meta WHERE key IN ('asset_browser.default_category', 'preview.default_category')").run();
});

test.afterAll(async () => {
  gate.releaseRequests();
  gate.releaseAnswers();
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

// control.reads: 'pass' | 'fail' | 'hold' for in-page GET reads of the list.
async function open(page) {
  const control = { reads: 'pass', heldReads: [], browserDetailsPosts: [] };
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() === 'POST' && DETAILS_PATH.test(pathname)) control.browserDetailsPosts.push(pathname);
  });
  await page.route((target) => target.pathname === LIST_PATH, async (route) => {
    const request = route.request();
    if (request.resourceType() === 'fetch' && request.method() === 'GET' && !new URL(request.url()).search) {
      if (control.reads === 'fail') return route.abort('failed');
      if (control.reads === 'hold') { control.heldReads.push(route); return undefined; }
    }
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
const allRows = () => db.prepare('SELECT * FROM asset_category_defaults ORDER BY id').all();
const postsFor = (category) => gate.posts.filter((post) => post.id === category.id);
const edits = () => mutations.filter((entry) => entry[0] === 'edit');
const writes = () => edits().filter((entry) => entry[4] === 'ok');
const reviewed = (page, category) => detailsForm(page, category).evaluate((form) => [
  form.querySelector('input[name="reviewedDisplayName"]').value,
  form.querySelector('input[name="reviewedDirectorySlug"]').value,
]);
const fieldState = (locator) => locator.evaluate((field) => ({
  value: field.value,
  saved: field.defaultValue,
  focused: document.activeElement === field,
}));
const settle = (page) => page.waitForTimeout(500);
const SAVED = 'Details saved.';
const STALE = 'This category was changed somewhere else, so these details were not saved. Review the saved details, then save again.';
const STALE_NEWER = 'This category was changed somewhere else, so the earlier details were not saved. Current changes have not been saved either. Review the saved details, then save again.';
const NETWORK = 'Could not save category details. Your current changes were kept.';

// Edits `field` to `value` and Tabs; the original POST is held upstream,
// before the app (and so the service) has seen it.
async function saveWithHeldRequest(page, field, value) {
  const held = gate.heldRequests.length;
  gate.holdRequests += 1;
  await field.fill(value);
  await page.keyboard.press('Tab');
  await expect.poll(() => gate.heldRequests.length).toBe(held + 1);
}

async function saveNow(page, category, field, value) {
  await field.fill(value);
  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, category)).toHaveText(SAVED);
}

async function twoTabs(page) {
  const a = await open(page);
  const pageB = await page.context().newPage();
  const b = await open(pageB);
  return { a, b, pageB };
}

for (const [label, kind, field, s1, s2] of [
  ['F7-B1: original name race', 'name', nameField, 'Bravo Older', 'Bravo Newer'],
  ['F7-B2: original slug race', 'slug', slugField, 'bravo-older', 'bravo-newer'],
]) {
  test(`${label} — the older request held before the service is refused; the newer acknowledged save survives`, async ({ page }) => {
    const [other, target] = seed([`Other F7 ${kind}`, `Bravo F7 ${kind}`]);
    const { a, b, pageB } = await twoTabs(page);
    const before = savedRow(target);
    const otherBefore = savedRow(other);

    // Tab A: the original Save is held upstream: one arrival, no execution.
    await saveWithHeldRequest(page, field(page, target), s1);
    expect(postsFor(target)).toHaveLength(1);
    expect(edits()).toEqual([]);
    expect(savedRow(target)).toEqual(before);

    // Tab B: a newer intentional Save commits and is acknowledged.
    await saveNow(pageB, target, field(pageB, target), s2);
    const committed = savedRow(target);
    expect(committed[kind === 'name' ? 'display_name' : 'directory_slug']).toBe(s2);
    await expect(field(pageB, target)).toHaveJSProperty('defaultValue', s2);

    // Tab A: the held original request now reaches the service.
    gate.releaseRequests();
    await expect(detailsStatus(page, target)).toHaveText(STALE);
    await settle(page);

    const facts = {
      payloads: postsFor(target).map((post) => [post.body.get('displayName'), post.body.get('directorySlug'),
        post.body.get('reviewedDisplayName'), post.body.get('reviewedDirectorySlug')]),
      executions: edits().map((entry) => entry.slice(2)),
      writes: writes().length,
      sqlite: savedRow(target),
      tabA: await fieldState(field(page, target)),
      tabB: await fieldState(field(pageB, target)),
      tabAReviewed: await reviewed(page, target),
      tabAStatus: await detailsStatus(page, target).textContent(),
      tabBStatus: await detailsStatus(pageB, target).textContent(),
      browserPosts: [a.control.browserDetailsPosts.length, b.control.browserDetailsPosts.length],
    };
    console.log(`F7 ${kind} race:`, JSON.stringify(facts));
    const value = kind === 'name' ? (r) => r.display_name : (r) => r.directory_slug;
    expect(value(facts.sqlite), 'SQLite keeps the newer acknowledged value').toBe(s2);
    expect(facts.sqlite).toEqual(committed);
    expect(facts.writes, 'successful writes').toBe(1);
    expect(facts.executions.map((entry) => entry[2])).toEqual(['ok', 'stale']);
    expect(facts.payloads).toHaveLength(2);
    expect(facts.payloads[0].slice(2), 'A was based on S0').toEqual([before.display_name, before.directory_slug]);
    expect(facts.payloads[1].slice(2), 'B was based on S0').toEqual([before.display_name, before.directory_slug]);
    expect(facts.tabA, 'A keeps its refused value as a draft; baseline is S2').toEqual({ value: s1, saved: s2, focused: false });
    expect(facts.tabAReviewed).toEqual([committed.display_name, committed.directory_slug]);
    await expect(detailsForm(page, target)).toHaveAttribute('data-category-details-state', 'stale');
    await expect(row(page, target).locator('.error-summary[role="alert"]')).toContainText('Saved now:');
    expect(facts.tabB).toMatchObject({ value: s2, saved: s2 });
    expect(facts.tabBStatus).toBe(SAVED);
    expect(facts.browserPosts, 'no automatic extra POST').toEqual([1, 1]);
    expect(savedRow(other)).toEqual(otherBefore);
    expect(await page.evaluate(() => window.__sameDocument)).toBe(true);

    // A new intentional save from tab A is based on S2 and is written.
    await saveNow(page, target, field(page, target), `${s1}-again`);
    expect(value(savedRow(target))).toBe(`${s1}-again`);
    expect(writes()).toHaveLength(2);
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
  });
}

test('F7-B2b: slug race keeps uniqueness: a duplicate of another default is refused; a valid follow-up saves', async ({ page }) => {
  const [other, target] = seed(['Other F7 dup', 'Bravo F7 dup']);
  const { errors } = await open(page);
  await slugField(page, target).fill(other.slug);
  await page.keyboard.press('Tab');
  await expect(detailsForm(page, target)).toHaveAttribute('data-category-details-state', 'error');
  await expect(row(page, target)).toContainText('A category with this directory slug already exists.');
  expect(savedRow(target).directory_slug).toBe(target.slug);
  expect(edits().map((entry) => entry[4])).toEqual(['refused']);
  await slugField(page, target).fill(`${target.slug}-fixed`);
  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, target)).toHaveText(SAVED);
  expect(savedRow(target).directory_slug).toBe(`${target.slug}-fixed`);
  expect(savedRow(other).directory_slug).toBe(other.slug);
  expect(errors).toEqual([]);
});

test('F7-B3: reverse order — A executes first; B, based on the old details, is refused; then B saves intentionally', async ({ page }) => {
  const [target] = seed(['Bravo F7 reverse']);
  const { pageB, b } = await twoTabs(page);
  await saveNow(page, target, nameField(page, target), 'First Executed');
  expect(savedRow(target).display_name).toBe('First Executed');

  await nameField(pageB, target).fill('Second Stale');
  await pageB.keyboard.press('Tab');
  await expect(detailsStatus(pageB, target)).toHaveText(STALE);
  expect(savedRow(target).display_name).toBe('First Executed');
  expect(edits().map((entry) => [entry[2], entry[4]])).toEqual([['First Executed', 'ok'], ['Second Stale', 'stale']]);
  await expect(nameField(pageB, target)).toHaveJSProperty('defaultValue', 'First Executed');
  await expect(nameField(pageB, target)).toHaveValue('Second Stale');
  await settle(pageB);
  expect(b.control.browserDetailsPosts).toHaveLength(1);

  await saveNow(pageB, target, nameField(pageB, target), 'Second Intended');
  expect(savedRow(target).display_name).toBe('Second Intended');
  expect(writes()).toHaveLength(2);
});

test('F7-B4: a native (no-JS) form cannot bypass the check: 409 page, current details shown, then an intentional resubmit', async ({ page, browser }) => {
  const [target] = seed(['Bravo F7 native']);
  const nativeContext = await browser.newContext({ javaScriptEnabled: false });
  const native = await nativeContext.newPage();
  try {
    await native.goto(`${baseURL}${LIST_PATH}`);
    await open(page);
    await saveNow(page, target, nameField(page, target), 'Newer Enhanced');

    await nameField(native, target).fill('Older Native');
    const [answer] = await Promise.all([
      native.waitForResponse((response) => response.request().method() === 'POST' && DETAILS_PATH.test(new URL(response.url()).pathname)),
      row(native, target).getByRole('button', { name: 'Save details' }).click(),
    ]);
    expect(answer.status()).toBe(409);
    expect(answer.headers()['content-type']).toMatch(/text\/html/);
    expect(savedRow(target).display_name).toBe('Newer Enhanced');
    await expect(row(native, target).locator('.error-summary[role="alert"]')).toContainText('Saved now: “Newer Enhanced”');
    await expect(nameField(native, target)).toHaveValue('Older Native');
    expect(await reviewed(native, target)).toEqual(['Newer Enhanced', target.slug]);
    await expect(native.locator('body')).not.toContainText(/SqliteError|SQLITE_/);

    // Missing review fields are refused, never written blindly.
    await native.evaluate(() => document.querySelectorAll('input[data-category-details-reviewed]').forEach((input) => input.remove()));
    const [missing] = await Promise.all([
      native.waitForResponse((response) => response.request().method() === 'POST' && DETAILS_PATH.test(new URL(response.url()).pathname)),
      row(native, target).getByRole('button', { name: 'Save details' }).click(),
    ]);
    expect(missing.status()).toBe(400);
    expect(savedRow(target).display_name).toBe('Newer Enhanced');

    // Reviewing the current page and saving again is intentional and written.
    await native.goto(`${baseURL}${LIST_PATH}`);
    await nameField(native, target).fill('Native Intended');
    await Promise.all([
      native.waitForURL(/notice=category_updated/),
      row(native, target).getByRole('button', { name: 'Save details' }).click(),
    ]);
    expect(savedRow(target).display_name).toBe('Native Intended');
    expect(edits().map((entry) => entry[4])).toEqual(['ok', 'stale', 'ok']);
  } finally {
    await nativeContext.close();
  }
});

test('F7-B5: F4 answer race still holds — the older answer saves nothing more; Tab saves the newer draft once, based on the earlier save', async ({ page }) => {
  const [target] = seed(['Bravo F7 F4']);
  const { control, errors } = await open(page);
  gate.holdAnswers += 1;
  await nameField(page, target).fill('Bravo One');
  await page.keyboard.press('Tab');
  await expect.poll(() => gate.heldAnswers.length).toBe(1);
  expect(savedRow(target).display_name).toBe('Bravo One');
  await nameField(page, target).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Two');
  gate.releaseAnswers();
  await expect(detailsForm(page, target)).not.toHaveAttribute('aria-busy', 'true');
  await settle(page);
  expect(postsFor(target)).toHaveLength(1);
  expect(await fieldState(nameField(page, target))).toEqual({ value: 'Bravo One Two', saved: 'Bravo One', focused: true });
  expect(await reviewed(page, target)).toEqual(['Bravo One', target.slug]);
  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, target)).toHaveText(SAVED);
  expect(savedRow(target).display_name).toBe('Bravo One Two');
  expect(edits().map((entry) => entry[4])).toEqual(['ok', 'ok']);
  expect(control.browserDetailsPosts).toHaveLength(2);
  expect(errors).toEqual([]);
});

test('F7-B5b: a stale refusal arriving while an even newer draft is focused keeps it unsaved; Tab then saves it once', async ({ page }) => {
  const [target] = seed(['Bravo F7 newer']);
  const { a, pageB } = await twoTabs(page);
  await saveWithHeldRequest(page, nameField(page, target), 'Bravo Mine');
  await saveNow(pageB, target, nameField(pageB, target), 'Bravo Theirs');
  await nameField(page, target).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' More');
  gate.releaseRequests();
  await expect(detailsStatus(page, target)).toHaveText(STALE_NEWER);
  await settle(page);
  expect(savedRow(target).display_name).toBe('Bravo Theirs');
  expect(await fieldState(nameField(page, target))).toEqual({ value: 'Bravo Mine More', saved: 'Bravo Theirs', focused: true });
  expect(a.control.browserDetailsPosts).toHaveLength(1);
  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, target)).toHaveText(SAVED);
  expect(savedRow(target).display_name).toBe('Bravo Mine More');
  expect(a.control.browserDetailsPosts).toHaveLength(2);
  expect(edits().map((entry) => [entry[2], entry[4]])).toEqual([['Bravo Theirs', 'ok'], ['Bravo Mine', 'stale'], ['Bravo Mine More', 'ok']]);
});

test('F7-B6: Delete races — a held save of a deleted default recreates nothing; an older save after a newer one and another Delete is refused', async ({ page }) => {
  const [keep, target, newer, gone] = seed(['Keep F7 del', 'Target F7 del', 'Newer F7 del', 'Gone F7 del']);
  const { a, pageB } = await twoTabs(page);

  // Scenario A: held save; the category is deleted in tab B; release.
  await saveWithHeldRequest(page, nameField(page, target), 'Target Renamed');
  await deleteButton(pageB, target).click();
  await confirmButton(pageB).click();
  await expect(row(pageB, target)).toHaveCount(0);
  const afterDelete = allRows();
  gate.releaseRequests();
  await expect(detailsStatus(page, target)).toHaveText(NETWORK);
  await settle(page);
  expect(savedRow(target)).toBe(null);
  expect(allRows()).toEqual(afterDelete);
  expect(edits().map((entry) => entry[4])).toEqual(['missing']);

  // Scenario B: tab B saves newer details; tab A's older save is held; tab B
  // deletes another default; release.
  await saveNow(pageB, newer, nameField(pageB, newer), 'Newer Acknowledged');
  await saveWithHeldRequest(page, nameField(page, newer), 'Newer Older');
  await deleteButton(pageB, gone).click();
  await confirmButton(pageB).click();
  await expect(row(pageB, gone)).toHaveCount(0);
  gate.releaseRequests();
  await expect(detailsStatus(page, newer)).toHaveText(STALE);
  await settle(page);
  expect(savedRow(newer).display_name).toBe('Newer Acknowledged');
  expect(savedRow(gone)).toBe(null);
  expect(savedRow(keep).display_name).toBe(keep.name);
  expect(edits().map((entry) => [entry[1], entry[4]])).toEqual([[target.id, 'missing'], [newer.id, 'ok'], [newer.id, 'stale']]);
  expect(mutations.filter((entry) => entry[0] === 'delete')).toEqual([['delete', target.id], ['delete', gone.id]]);
  expect(a.control.browserDetailsPosts).toHaveLength(2);
});

async function refreshScenario(page) {
  const [edited, untouched] = seed(['Edited F7 refresh', 'Untouched F7 refresh']);
  const { a, pageB } = await twoTabs(page);
  // Tab A holds a focused, unsaved draft; tab B saves both rows.
  await nameField(page, edited).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' draft');
  await saveNow(pageB, edited, nameField(pageB, edited), 'Edited Elsewhere');
  await saveNow(pageB, untouched, nameField(pageB, untouched), 'Untouched Elsewhere');
  await page.bringToFront();
  await nameField(page, edited).focus();

  // Tab A reads the list (GET only).
  await page.evaluate(() => document.__creatorCrateSettingsCategoryDelete.controller.refresh());
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  await settle(page);
  expect(writes()).toHaveLength(2);
  expect(a.control.browserDetailsPosts).toHaveLength(0);
  // The dirty row stays as it was, still based on what it showed.
  expect(await fieldState(nameField(page, edited))).toEqual({ value: `${edited.name} draft`, saved: edited.name, focused: true });
  expect(await reviewed(page, edited)).toEqual([edited.name, edited.slug]);
  // The untouched row took the read: its basis is the details saved now.
  expect(await reviewed(page, untouched)).toEqual(['Untouched Elsewhere', untouched.slug]);

  // Tab saves the draft: refused, the newer save in SQLite survives.
  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, edited)).toHaveText(STALE);
  expect(savedRow(edited).display_name).toBe('Edited Elsewhere');
  // The refreshed row saves normally, without a false refusal.
  await saveNow(page, untouched, nameField(page, untouched), 'Untouched Mine');
  expect(savedRow(untouched).display_name).toBe('Untouched Mine');
  await settle(page);
  expect(a.control.browserDetailsPosts).toHaveLength(2);
  expect(edits().map((entry) => entry[4])).toEqual(['ok', 'ok', 'stale', 'ok']);
  expect(a.errors).toEqual([]);
}

test('F7-B7: list refresh with a dirty draft — no refresh-induced save; the kept draft stays based on what it showed and is refused; a refreshed row saves', async ({ page }) => {
  await refreshScenario(page);
});

test('F7-B8: the same without atomic moves (fallback install)', async ({ page }) => {
  await page.context().addInitScript(() => { delete Element.prototype.moveBefore; });
  await refreshScenario(page);
});

test('F7-B7b: an older list read installed after this page’s own save does not put back the old basis', async ({ page }) => {
  const [target] = seed(['Bravo F7 old read']);
  const { control } = await open(page);
  control.reads = 'hold';
  void page.evaluate(() => document.__creatorCrateSettingsCategoryDelete.controller.refresh());
  await expect.poll(() => control.heldReads.length).toBe(1);
  // The held read is released only after this page's own save is answered.
  control.reads = 'pass';
  await saveNow(page, target, nameField(page, target), 'Bravo Saved');
  const held = control.heldReads.splice(0);
  await Promise.all(held.map((route) => route.fallback()));
  await settle(page);
  expect(await reviewed(page, target)).toEqual(['Bravo Saved', target.slug]);
  await saveNow(page, target, nameField(page, target), 'Bravo Saved Again');
  expect(savedRow(target).display_name).toBe('Bravo Saved Again');
  expect(edits().map((entry) => entry[4])).toEqual(['ok', 'ok']);
});

test('F7-B7c: failed refresh, then a GET-only Retry, leaves the basis on the saved details', async ({ page }) => {
  const [deleted, target] = seed(['Deleted F7 retry', 'Bravo F7 retry']);
  const { control } = await open(page);
  control.reads = 'fail';
  await deleteButton(page, deleted).click();
  await confirmButton(page).click();
  await expect(feedback(page)).toContainText('could not be refreshed and may be out of date');
  control.reads = 'pass';
  await feedback(page).getByRole('button', { name: 'Retry refresh' }).click();
  await expect(feedback(page)).toContainText('The category defaults are up to date.');
  expect(edits()).toEqual([]);
  expect(await reviewed(page, target)).toEqual([target.name, target.slug]);
  await saveNow(page, target, nameField(page, target), 'Bravo After Retry');
  expect(savedRow(target).display_name).toBe('Bravo After Retry');
});

test('F7-B9: validation refusals — invalid name, duplicate slug, correction, then a fresh intentional save', async ({ page }) => {
  const [other, target] = seed(['Other F7 valid', 'Bravo F7 valid']);
  const { control, errors } = await open(page);
  await nameField(page, target).fill('   ');
  await page.keyboard.press('Tab');
  await expect(detailsForm(page, target)).toHaveAttribute('data-category-details-state', 'error');
  await expect(row(page, target)).toContainText('Display name is required.');
  expect(await reviewed(page, target)).toEqual([target.name, target.slug]);
  await nameField(page, target).fill('Bravo Valid');
  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, target)).toHaveText(SAVED);
  await slugField(page, target).fill(other.slug);
  await page.keyboard.press('Tab');
  await expect(row(page, target)).toContainText('A category with this directory slug already exists.');
  expect(await reviewed(page, target)).toEqual(['Bravo Valid', target.slug]);
  await slugField(page, target).fill(`${target.slug}-ok`);
  await page.keyboard.press('Tab');
  await expect(detailsStatus(page, target)).toHaveText(SAVED);
  expect(savedRow(target)).toMatchObject({ display_name: 'Bravo Valid', directory_slug: `${target.slug}-ok` });
  expect(edits().map((entry) => entry[4])).toEqual(['refused', 'ok', 'refused', 'ok']);
  expect(control.browserDetailsPosts).toHaveLength(4);
  expect(errors).toEqual([]);
});
