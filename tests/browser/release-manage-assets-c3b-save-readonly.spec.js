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
import { createStaticCredentialProvider } from '../../src/auth/credential-provider.js';
import { createLoginThrottler } from '../../src/auth/login-throttle.js';
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';
import { createReleaseService } from '../../src/services/release-service.js';
import { AUTH_CONFIG, TEST_PASSWORD, TEST_USERNAME } from '../helpers/auth.js';

// Package C3b: Release Manage Assets Save recovery, read-only presentation and
// the authorization/CSRF boundary in real Chromium. Every test builds its own
// release over 25 local assets (pageSize=10: page 1 = 01–10, page 2 = 11–20,
// page 3 = 21–25) plus a foreign project whose asset, category and project
// title are distinctive, and checks the real outgoing request and the
// release_assets rows read directly from SQLite. Expected IDs, roles and
// orders come from the fixture, never from the page's own draft parser.
// Complements (does not repeat) release-manage-assets-rejected-save.spec.js
// (B-F2 … B-F2R7, B-F4), the C1/C2 HTTP matrices and C3a navigation.
// All data lives in temporary roots that are removed afterward.
const FILE = (number) => `${String(number).padStart(2, '0')}-c3b-asset.txt`;
const FOREIGN_FILE = 'zephyr-foreign-secret.png';
const FOREIGN_CATEGORY = 'Zephyr Vault Category';
const FOREIGN_PROJECT = 'Zephyr Foreign Project';
const ORDER_ERROR = 'Invalid asset order. Each order must be a whole number from 0 to 9007199254740991.';
const FORMAT_ERROR = 'Invalid asset selection format.';
const MEMBERSHIP_FIELD = /^(selectedAssetIds|roleOrder|roleAssetIds|roles|sortOrder)\b/;

let server;
let db;
let app;
let root;
let projectsRoot;
let baseURL;
let releaseService;
let viteDistRoot;
let fixtureCount = 0;

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-release-manage-c3b-'));
  projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  viteDistRoot = path.join(root, 'client');
  fs.mkdirSync(projectsRoot);
  fs.mkdirSync(appDataRoot);
  await build({ build: { outDir: viteDistRoot }, logLevel: 'silent' });
  db = openDatabase(path.join(root, 'test.db'));
  runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
  const { csrfPepper } = ensureAuthEnablement(appDataRoot);
  app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, {
    appDataRoot, authState: { csrfPepper }, useViteAssets: true, viteDistRoot,
    assetManifest: manifest(),
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
  releaseService = createReleaseService({ db });
});

test.afterEach(async ({ page }) => {
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

function manifest() {
  return createAssetManifest({ distRoot: viteDistRoot,
    manifestPath: path.join(viteDistRoot, '.vite', 'manifest.json') });
}

// One release over 25 local assets plus a foreign project. `saved` is
// [fileNumber, role, sortOrder]; `missing` file numbers are marked missing.
async function createFixture(title, {
  targetApp = app, targetDb = db, targetProjectsRoot = projectsRoot,
  saved = [[1, 'primary', 0], [3, 'preview', 1], [12, 'attachment', 2], [15, 'attachment', 3], [21, 'attachment', 4]],
  missing = [15],
} = {}) {
  fixtureCount += 1;
  const projects = targetApp.locals.projectService;
  const project = projects.create({ title: `${title} ${fixtureCount}`, status: 'tbd' });
  const projectDir = path.join(targetProjectsRoot, project.project_dir);
  for (let number = 1; number <= 25; number += 1) fs.writeFileSync(path.join(projectDir, FILE(number)), FILE(number));
  targetApp.locals.assetScanner.scanProjectAssets(project.id);
  const byName = Object.fromEntries(targetDb.prepare('SELECT filename, id FROM assets WHERE project_id = ?')
    .all(project.id).map((row) => [row.filename, row.id]));
  const n = (number) => byName[FILE(number)];

  const foreign = projects.create({ title: `${FOREIGN_PROJECT} ${fixtureCount}`, status: 'tbd' });
  targetApp.locals.projectAssetCategoryService.add(foreign.id, { displayName: FOREIGN_CATEGORY, directorySlug: 'zephyr-vault' });
  const foreignDir = path.join(targetProjectsRoot, foreign.project_dir, 'zephyr-vault');
  fs.mkdirSync(foreignDir, { recursive: true });
  await sharp({ create: { width: 32, height: 20, channels: 3, background: { r: 200, g: 20, b: 90 } } })
    .png().toFile(path.join(foreignDir, FOREIGN_FILE));
  targetApp.locals.assetScanner.scanProjectAssets(foreign.id);
  const foreignId = targetDb.prepare('SELECT id FROM assets WHERE project_id = ?').get(foreign.id).id;

  const release = createReleaseService({ db: targetDb }).createRelease(project.id, {
    title: `${title} Release ${fixtureCount}`, description: '', notes: '', plannedDate: null, patreonUrl: null,
  });
  const insert = targetDb.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)');
  for (const [number, role, sortOrder] of saved) insert.run(release.id, n(number), role, sortOrder);
  for (const number of missing) {
    targetDb.prepare("UPDATE assets SET is_present = 0, missing_since = '2025-02-01T00:00:00Z' WHERE id = ?").run(n(number));
  }
  const persisted = [...saved].sort((a, b) => a[2] - b[2])
    .map(([number, role, sortOrder]) => ({ asset_id: n(number), role, sort_order: sortOrder }));
  const rows = savedRows(release.id, targetDb);
  expect(rows).toEqual(persisted);
  return { releaseId: release.id, projectId: project.id, n, foreignId, persisted };
}

function savedRows(releaseId, targetDb = db) {
  return targetDb
    .prepare('SELECT asset_id, role, sort_order FROM release_assets WHERE release_id = ? ORDER BY sort_order, asset_id')
    .all(releaseId);
}

const sortedIds = (ids) => [...ids].map(Number).sort((a, b) => a - b);
const tuples = (draft) => draft.map(({ assetId, role, sortOrder }) => [assetId, role, sortOrder]);

function trackPageErrors(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

// Every request the page sends to this release's Manage Assets routes.
function trackRequests(page, releaseId) {
  const requests = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith(`/releases/${releaseId}/assets`)) {
      requests.push({ method: request.method(), path: url.pathname, body: request.postData() });
    }
  });
  return requests;
}

const formEntries = (page) => page.evaluate(() => [...new FormData(document.getElementById('release-assets-form'))]);

const allForms = (page) => page.evaluate(() => [...document.forms].map((form) => ({
  id: form.id,
  method: form.method,
  action: form.action,
  entries: [...new FormData(form)],
})));

// Decode the Save entries: selected IDs and the compact roleOrder carrier.
function readDraft(entries) {
  expect(entries.some(([name]) => /^(roleAssetIds|roles|sortOrder)\b/.test(name))).toBe(false);
  const carriers = entries.filter(([name]) => name === 'roleOrder');
  expect(carriers.length).toBeLessThanOrEqual(1);
  return {
    selected: entries.filter(([name]) => name === 'selectedAssetIds').map(([, value]) => Number(value)),
    carried: carriers.length ? JSON.parse(carriers[0][1]) : null,
  };
}

// Exactly the expected IDs (each once) and the exact [id, role, order] tuples.
function expectDraft(entries, draft, label) {
  const { selected, carried } = readDraft(entries);
  expect(new Set(selected).size, label).toBe(selected.length);
  expect(sortedIds(selected), label).toEqual(sortedIds(draft.map((entry) => entry.assetId)));
  expect(carried, label).toEqual(tuples(draft));
}

const legacyEntries = (draft) => [
  ...draft.map((entry) => ['selectedAssetIds[]', String(entry.assetId)]),
  ...draft.map((entry) => ['roles[]', entry.role]),
  ...draft.map((entry) => ['sortOrder[]', String(entry.sortOrder)]),
];

const csrfOf = (page) => page.locator('#release-assets-form input[name="_csrf"]').inputValue();

// A native document POST from the current page (a legacy or adversarial
// browser client). `csrf === null` omits the token. Returns the outgoing
// request and its response.
async function nativePost(page, entries, csrf, action = null) {
  const request = page.waitForRequest((req) => req.method() === 'POST');
  const response = page.waitForResponse((res) => res.request().method() === 'POST');
  await page.evaluate(({ entries, csrf, action }) => {
    const form = document.createElement('form');
    form.method = 'post';
    form.action = action || window.location.href;
    for (const [name, value] of csrf === null ? entries : [['_csrf', csrf], ...entries]) {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.value = value;
      form.append(input);
    }
    document.body.append(form);
    form.submit();
  }, { entries, csrf, action });
  return { request: await request, response: await response };
}

// Click the real Save button; returns the outgoing request and its response.
async function clickSave(page) {
  const request = page.waitForRequest((req) => req.method() === 'POST');
  const response = page.waitForResponse((res) => res.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save asset selection' }).click();
  return { request: await request, response: await response };
}

const appendToSaveForm = (page, fields) => page.evaluate((pairs) => {
  for (const [name, value] of pairs) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    document.getElementById('release-assets-form').append(input);
  }
}, fields);

async function settled(page) {
  await expect(page.locator('[data-release-assets-live-region]')).not.toHaveAttribute('aria-busy', 'true');
}

const region = (page) => page.locator('[data-release-assets-live-region]');
const checkbox = (page, id) => region(page).locator(`input[name="selectedAssetIds"][value="${id}"]`);

async function goToPage(page, target) {
  for (;;) {
    const info = (await page.locator('.pagination-info').textContent()).trim();
    const current = Number(/^Page (\d+) of/.exec(info)[1]);
    if (current === target) return;
    await region(page).locator(current < target ? '.pagination-next' : '.pagination-prev').click();
    await settled(page);
    await expect(page.locator('.pagination-info')).toHaveText(new RegExp(`^Page ${current < target ? current + 1 : current - 1} of`));
  }
}

// Every membership or Role editing control on the page (presentation
// controls such as the grid size/style dropdowns are not editing controls):
// selection checkboxes, anything bound to the Save form, Role selects and
// forms, and retry carriers. Reported as `tag#id[name]` for a clear diff.
const editingControls = (page) => page.evaluate(() => [...document.querySelectorAll(
  'input.asset-select-checkbox, [form="release-assets-form"], #release-assets-form *, '
  + 'select[name="role"], .release-asset-role-form, .release-asset-role-form *, '
  + '[name="selectedAssetIds"], [name="roleOrder"], [name^="roles"], [name^="sortOrder"], [name^="roleAssetIds"]',
)].map((element) => `${element.tagName.toLowerCase()}#${element.id}[${element.getAttribute('name') || ''}]`));

// No foreign project, category, filename or asset URL anywhere on the page.
async function expectNoForeignMetadata(page, f) {
  const body = page.locator('body');
  await expect(body).not.toContainText('zephyr');
  await expect(body).not.toContainText('Zephyr');
  const html = await page.content();
  expect(html).not.toContain(FOREIGN_FILE);
  expect(html).not.toContain(FOREIGN_CATEGORY);
  expect(html).not.toContain(FOREIGN_PROJECT);
  expect(html).not.toMatch(new RegExp(`/assets/${f.foreignId}(?:[/?"#]|$)`));
}

// Fail-closed refusal: the error, the "Nothing was saved." notice, a GET
// reload link, and no control anywhere that could POST a membership draft.
async function expectFailClosed(page, error, f) {
  await expect(page.locator('.error-summary[role="alert"]').filter({ hasText: error })).toBeVisible();
  const notice = page.locator('[data-release-assets-save-recovery-unavailable]');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('Nothing was saved.');
  const reload = notice.getByRole('link', { name: 'Reload Manage Assets' });
  expect(new URL(await reload.getAttribute('href'), baseURL).pathname).toBe(`/releases/${f.releaseId}/assets`);
  await expect(page.locator('#release-assets-form')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save asset selection' })).toHaveCount(0);
  await expect(page.locator('input[name="selectedAssetIds"], input[name="roleOrder"], [name^="roles"], [name^="sortOrder"]')).toHaveCount(0);
  expect(await editingControls(page)).toEqual([]);
  for (const form of await allForms(page)) {
    expect(form.entries.filter(([name]) => MEMBERSHIP_FIELD.test(name)), `form ${form.id || form.action}`).toEqual([]);
    expect(form.method === 'post' && new URL(form.action).pathname.startsWith(`/releases/${f.releaseId}/assets`)).toBe(false);
  }
  await expectNoForeignMetadata(page, f);
}

// ─── 1. Recoverable Save: real 422, real FormData, Grid/List, retries ─────
test('C3b: a recoverable rejected Save round-trips its exact draft through the 422 HTML, Grid/List, an unchanged retry and a corrected Save', async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createFixture('C3b Recoverable');
  const url = `${baseURL}/releases/${f.releaseId}/assets?selection=all&pageSize=10`;
  // Saved Primary 01 and Preview 03 (page 1), off-page 12 and missing 15
  // (page 2) kept; off-page saved 21 (page 3) removed; 07 added with a
  // markup-like invalid role; off-page 23 added. Explicit roles/orders.
  const XSS = '<img src=x onerror="window.__c3bxss=1">';
  const draft = [
    { assetId: f.n(3), role: 'preview', sortOrder: 0 },
    { assetId: f.n(1), role: 'primary', sortOrder: 1 },
    { assetId: f.n(15), role: 'attachment', sortOrder: 2 },
    { assetId: f.n(7), role: XSS, sortOrder: 3 },
    { assetId: f.n(23), role: 'attachment', sortOrder: 4 },
    { assetId: f.n(12), role: 'attachment', sortOrder: 5 },
  ];
  const offPage1 = [f.n(12), f.n(15), f.n(23)];

  await page.goto(url);
  const csrf = await csrfOf(page);
  const { request, response } = await nativePost(page, legacyEntries(draft), csrf);
  expect(request.headers()['content-type']).toBe('application/x-www-form-urlencoded');
  expect([...new URLSearchParams(request.postData())]).toEqual([['_csrf', csrf], ...legacyEntries(draft)]);
  expect(response.status()).toBe(422);

  // The actual 422 HTML escapes the submitted role everywhere it is echoed.
  const html = await response.text();
  expect(html).not.toContain(XSS);
  expect(html).not.toContain('onerror="window.__c3bxss');
  expect(html).toContain('&lt;img src=x onerror=&quot;window.__c3bxss=1&quot;&gt;');
  expect(html).not.toContain(FOREIGN_FILE);

  const alert = page.locator('[data-release-assets-selection-errors]');
  await expect(alert).toBeVisible();
  await expect(alert).toHaveAttribute('role', 'alert');
  await expect(alert).toContainText('The asset selection was not saved.');
  await expect(alert.locator('li')).toHaveCount(1);
  await expect(alert.locator('li')).toHaveText(
    `Asset ${f.n(7)} has an invalid role "${XSS}". Role must be one of: primary, preview, attachment.`,
  );
  await expect(page.locator('[data-release-assets-save-recovery-unavailable]')).toHaveCount(0);
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  expect(await page.evaluate(() => window.__c3bxss)).toBeUndefined();
  await expectNoForeignMetadata(page, f);
  expect(savedRows(f.releaseId)).toEqual(f.persisted);

  // FormData built from the real rendered Save form, decoded independently.
  const entries = await formEntries(page);
  expect(entries.filter(([name]) => name === '_csrf')).toHaveLength(1);
  expect(entries.map(([name]) => name).filter((name) => !['_csrf', 'selectedAssetIds', 'roleOrder'].includes(name))).toEqual([]);
  expectDraft(entries, draft, 'rendered retry form');
  expect(readDraft(entries).selected).not.toContain(f.n(21));
  expect(readDraft(entries).selected).not.toContain(f.foreignId);
  // Off-page members ride in the hidden membership; visible ones are checked.
  const hidden = await page.locator('#release-assets-form [data-release-assets-hidden-membership] input[name="selectedAssetIds"]')
    .evaluateAll((inputs) => inputs.map((input) => Number(input.value)));
  expect(sortedIds(hidden)).toEqual(sortedIds(offPage1));
  for (const id of [f.n(1), f.n(3), f.n(7)]) await expect(checkbox(page, id)).toBeChecked();
  await expect(checkbox(page, f.n(5))).not.toBeChecked();

  // Grid -> List -> page 2 -> Grid keeps the same draft and role association.
  await page.getByRole('link', { name: 'List view' }).click();
  await settled(page);
  await expect(page.locator('.asset-list')).toBeVisible();
  expectDraft(await formEntries(page), draft, 'list page 1');
  await expect(page.locator(`#role-${f.n(1)}`)).toHaveValue('primary');
  await expect(page.locator(`#role-${f.n(3)}`)).toHaveValue('preview');
  await expect(page.locator(`#release-asset-role-${f.n(7)} img`)).toHaveCount(0);
  await goToPage(page, 2);
  await expect(checkbox(page, f.n(12))).toBeChecked();
  await expect(checkbox(page, f.n(15))).toBeChecked();
  await expect(region(page).locator('.asset-list-item.is-missing')).toHaveCount(1);
  await expect(region(page).locator('.asset-list-item.is-missing [data-asset-id]')).toHaveAttribute('data-asset-id', String(f.n(15)));
  expectDraft(await formEntries(page), draft, 'list page 2');
  await page.getByRole('link', { name: 'Grid view' }).click();
  await settled(page);
  await expect(page.locator('.asset-grid')).toBeVisible();
  expectDraft(await formEntries(page), draft, 'grid page 2');
  expect(savedRows(f.releaseId)).toEqual(f.persisted);

  // Unchanged retry: the browser posts the same tuples; refused the same way;
  // the draft is not replaced by the saved membership.
  const retry = await clickSave(page);
  expect(retry.request.headers()['content-type']).toBe('application/x-www-form-urlencoded');
  expectDraft([...new URLSearchParams(retry.request.postData())], draft, 'unchanged retry POST');
  expect(retry.response.status()).toBe(422);
  await expect(page.locator('[data-release-assets-selection-errors] li')).toHaveText(
    `Asset ${f.n(7)} has an invalid role "${XSS}". Role must be one of: primary, preview, attachment.`,
  );
  expectDraft(await formEntries(page), draft, 'after unchanged retry');
  expect(savedRows(f.releaseId)).toEqual(f.persisted);
  expect(await page.evaluate(() => window.__c3bxss)).toBeUndefined();

  // Correct 07's role in the carried draft (the legacy client's own payload),
  // from page 3 where the Primary, Preview and page-2 members are hidden.
  await goToPage(page, 3);
  await expect(checkbox(page, f.n(1))).toHaveCount(0);
  const corrected = draft.map((entry) => (entry.assetId === f.n(7) ? { ...entry, role: 'attachment' } : entry));
  await page.evaluate((value) => {
    document.querySelector('#release-assets-form input[name="roleOrder"]').value = value;
  }, JSON.stringify(tuples(corrected)));
  const saved = await clickSave(page);
  expectDraft([...new URLSearchParams(saved.request.postData())], corrected, 'corrected POST');
  expect(saved.response.status()).toBe(302);
  await page.waitForURL((target) => target.pathname === `/releases/${f.releaseId}`);
  const after = savedRows(f.releaseId);
  expect(after).toEqual([...corrected].sort((a, b) => a.sortOrder - b.sortOrder)
    .map(({ assetId, role, sortOrder }) => ({ asset_id: assetId, role, sort_order: sortOrder })));
  expect(new Set(after.map((row) => row.asset_id)).size).toBe(after.length);
  expect(after.some((row) => row.asset_id === f.n(21) || row.asset_id === f.foreignId)).toBe(false);
  expect(pageErrors).toEqual([]);
});

// ─── 2. Hidden off-page membership reaches the real Save POST ─────────────
test('C3b: hidden off-page members, additions and removals reach the real Save POST exactly once and persist as the complete set', async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createFixture('C3b Hidden Save');
  const requests = trackRequests(page, f.releaseId);
  await page.goto(`${baseURL}/releases/${f.releaseId}/assets?selection=all&pageSize=10`);
  // Page 1: add 05. Page 2: remove saved 12, add 18. Page 3: remove saved 21,
  // add 24, then Save from page 3 (01, 03, 05, 15, 18 are all off-page).
  await checkbox(page, f.n(5)).check({ force: true });
  await goToPage(page, 2);
  await checkbox(page, f.n(12)).uncheck({ force: true });
  await checkbox(page, f.n(18)).check({ force: true });
  await goToPage(page, 3);
  await checkbox(page, f.n(21)).uncheck({ force: true });
  await checkbox(page, f.n(24)).check({ force: true });
  expect(requests.filter((request) => request.method !== 'GET')).toEqual([]);
  expect(savedRows(f.releaseId)).toEqual(f.persisted);

  const { request, response } = await clickSave(page);
  expect(request.headers()['content-type']).toBe('application/x-www-form-urlencoded');
  const body = [...new URLSearchParams(request.postData())];
  expect(body.filter(([name]) => name === '_csrf')).toHaveLength(1);
  expect(body.filter(([name]) => name !== '_csrf' && name !== 'selectedAssetIds')).toEqual([]);
  const posted = body.filter(([name]) => name === 'selectedAssetIds').map(([, value]) => Number(value));
  const expected = [1, 3, 5, 15, 18, 24].map(f.n);
  expect(new Set(posted).size).toBe(posted.length);
  expect(sortedIds(posted)).toEqual(sortedIds(expected));
  for (const hiddenId of [1, 3, 5, 15, 18].map(f.n)) expect(posted).toContain(hiddenId);
  for (const removed of [f.n(12), f.n(21), f.foreignId]) expect(posted).not.toContain(removed);
  expect(response.status()).toBe(302);
  await page.waitForURL((target) => target.pathname === `/releases/${f.releaseId}`);

  // Membership-only: kept rows keep role and relative order; additions append
  // as attachments in the order the browser posted them.
  const additions = posted.filter((id) => [5, 18, 24].map(f.n).includes(id));
  expect(savedRows(f.releaseId)).toEqual([
    { asset_id: f.n(1), role: 'primary', sort_order: 0 },
    { asset_id: f.n(3), role: 'preview', sort_order: 1 },
    { asset_id: f.n(15), role: 'attachment', sort_order: 2 },
    ...additions.map((assetId, index) => ({ asset_id: assetId, role: 'attachment', sort_order: 3 + index })),
  ]);
  expect(requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  expect(pageErrors).toEqual([]);
});

// ─── 3. Fail-closed refusals stay closed ─────────────────────────────────
test('C3b: unsafe-order and malformed selected-ID Saves fail closed with off-page drafts; Grid/List leaves by GET to the saved selection only', async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createFixture('C3b Fail Closed');
  const requests = trackRequests(page, f.releaseId);
  const url = `${baseURL}/releases/${f.releaseId}/assets?selection=all&pageSize=10`;
  const savedIds = sortedIds(f.persisted.map((row) => row.asset_id));

  // A. B-F2R3 order: three assets, one invalid role, order 2^53.
  await page.goto(url);
  const csrf = await csrfOf(page);
  const unsafe = await nativePost(page, legacyEntries([
    { assetId: f.n(1), role: 'primary', sortOrder: '0' },
    { assetId: f.n(3), role: 'preview', sortOrder: '1' },
    { assetId: f.n(22), role: 'bogus', sortOrder: '9007199254740992' },
  ]), csrf);
  expect(unsafe.response.status()).toBe(422);
  await expectFailClosed(page, ORDER_ERROR, f);
  expect(await page.content()).not.toContain('9007199254740992');
  expect(savedRows(f.releaseId)).toEqual(f.persisted);

  // Grid/List from the refusal is a plain GET to the saved editable page: the
  // rejected draft (22, its role and order) never comes back.
  const postsBefore = requests.filter((request) => request.method === 'POST').length;
  await page.getByRole('link', { name: 'List view' }).click();
  await page.waitForURL((target) => target.searchParams.get('view') === 'list');
  await expect(page.locator('[data-release-assets-save-recovery-unavailable]')).toHaveCount(0);
  const reloaded = readDraft(await formEntries(page));
  expect(sortedIds(reloaded.selected)).toEqual(savedIds);
  expect(reloaded.carried).toBeNull();
  await expect(checkbox(page, f.n(22))).toHaveCount(0);
  expect(requests.filter((request) => request.method === 'POST')).toHaveLength(postsBefore);

  // B–D. Malformed selected-ID fields with a real off-page draft (07 added on
  // page 1, saved 12 removed on page 2) or a foreign value: refused whole.
  const cases = [
    ['real form + selectedAssetIds[__proto__]=foreign', [['selectedAssetIds[__proto__]', String(f.foreignId)]], true],
    ['real form + unknown raw field', [['c3bUnknownField', '1']], true],
    ['native __proto__[selectedAssetIds]=foreign', [['__proto__[selectedAssetIds]', String(f.foreignId)]], false],
  ];
  for (const [label, fields, viaRealForm] of cases) {
    await page.goto(url);
    let result;
    if (viaRealForm) {
      await checkbox(page, f.n(7)).check({ force: true });
      await goToPage(page, 2);
      await checkbox(page, f.n(12)).uncheck({ force: true });
      await appendToSaveForm(page, fields);
      result = await clickSave(page);
      const sent = [...new URLSearchParams(result.request.postData())];
      const sentIds = sent.filter(([name]) => name === 'selectedAssetIds').map(([, value]) => Number(value));
      expect(sortedIds(sentIds), label).toEqual(sortedIds([1, 3, 7, 15, 21].map(f.n)));
      for (const field of fields) expect(sent, label).toContainEqual(field);
    } else {
      result = await nativePost(page, fields, csrf);
      expect([...new URLSearchParams(result.request.postData())].slice(1), label).toEqual(fields);
    }
    expect(result.response.status(), label).toBe(422);
    await expectFailClosed(page, FORMAT_ERROR, f);
    expect(savedRows(f.releaseId), label).toEqual(f.persisted);
  }

  // Only a fresh GET resumes, from the saved selection.
  await page.getByRole('link', { name: 'Reload Manage Assets' }).click();
  await expect(page.locator('#release-assets-form')).toHaveCount(1);
  const fresh = readDraft(await formEntries(page));
  expect(sortedIds(fresh.selected)).toEqual(savedIds);
  expect(fresh.carried).toBeNull();
  expect(savedRows(f.releaseId)).toEqual(f.persisted);
  expect(pageErrors).toEqual([]);
});

// ─── 4. Intentional empty Save across pages ──────────────────────────────
test('C3b control: unchecking every saved member across pages (hidden and missing included) is an intentional empty Save', async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createFixture('C3b Empty Save');
  await page.goto(`${baseURL}/releases/${f.releaseId}/assets?selection=all&pageSize=10`);
  await checkbox(page, f.n(1)).uncheck({ force: true });
  await checkbox(page, f.n(3)).uncheck({ force: true });
  await goToPage(page, 2);
  await checkbox(page, f.n(12)).uncheck({ force: true });
  await checkbox(page, f.n(15)).uncheck({ force: true });
  await goToPage(page, 3);
  await checkbox(page, f.n(21)).uncheck({ force: true });
  expect((await formEntries(page)).filter(([name]) => name !== '_csrf')).toEqual([]);
  expect(savedRows(f.releaseId)).toEqual(f.persisted);

  const { request, response } = await clickSave(page);
  expect(request.headers()['content-type']).toBe('application/x-www-form-urlencoded');
  expect(request.postData()).toMatch(/^_csrf=[^&]+$/);
  expect(response.status()).toBe(302);
  await page.waitForURL((target) => target.pathname === `/releases/${f.releaseId}`);
  expect(savedRows(f.releaseId)).toEqual([]);
  expect(pageErrors).toEqual([]);
});

// ─── 5. Read-only presentation and refusals ──────────────────────────────
// 13 saved members (more than one page at pageSize=10) in an order unlike
// filename order; 15 is missing.
const READ_ONLY_SAVED = [
  [25, 'attachment', 0], [3, 'preview', 1], [1, 'primary', 2], [15, 'attachment', 3],
  [5, 'attachment', 4], [7, 'attachment', 5], [9, 'attachment', 6], [11, 'attachment', 7],
  [13, 'attachment', 8], [17, 'attachment', 9], [19, 'attachment', 10], [21, 'attachment', 11],
  [23, 'attachment', 12],
];
const READ_ONLY_STATES = [
  ['published', 'This release is published. Asset selections are locked and read-only.',
    (f) => db.prepare("UPDATE releases SET published_date = '2025-06-15' WHERE id = ?").run(f.releaseId),
    (f) => `Release ${f.releaseId} is published and its asset selection is locked.`],
  ['archived release', 'This release is archived. Asset selections are read-only.',
    (f) => db.prepare("UPDATE releases SET archived_at = '2026-01-01T00:00:00Z' WHERE id = ?").run(f.releaseId),
    (f) => `Release ${f.releaseId} is archived and cannot be modified.`],
  ['archived project', 'The parent project is archived. Asset selections are read-only.',
    (f) => db.prepare("UPDATE projects SET archived_at = '2026-01-01T00:00:00Z' WHERE id = ?").run(f.projectId),
    (f) => `Project ${f.projectId} is archived and cannot be modified.`],
];

// The complete saved collection in saved order with roles, the missing
// indicator and no editing surface at all.
async function expectReadOnlyCollection(page, f, view, notice, label) {
  await expect(page.getByText(notice), label).toBeVisible();
  const expectedIds = READ_ONLY_SAVED.map(([number]) => f.n(number));
  const expectedRoles = READ_ONLY_SAVED.map(([, role]) => role[0].toUpperCase() + role.slice(1));
  const items = region(page).locator(view === 'grid' ? '.asset-grid-item' : '.asset-list-item');
  // A List cell's text without its responsive column label ("Role", "Order").
  const cellTexts = (column) => items.evaluateAll((nodes, [name, heading]) => nodes.map((node) => node
    .querySelector(`.asset-list-cell--${name}`)?.textContent.replace(/\s+/g, ' ').trim()
    .replace(new RegExp(`^${heading} `), '')), [column, column[0].toUpperCase() + column.slice(1)]);
  await expect(items, label).toHaveCount(expectedIds.length);
  expect(await items.evaluateAll((nodes) => nodes.map((node) => Number(node.querySelector('[data-asset-id]').dataset.assetId))), label)
    .toEqual(expectedIds);
  const roles = view === 'grid'
    ? await items.evaluateAll((nodes) => nodes.map((node) => node.querySelector('.release-asset-grid-role-value')?.textContent.trim()))
    : await cellTexts('role');
  expect(roles, label).toEqual(expectedRoles);
  if (view === 'list') {
    expect(await cellTexts('order'), label).toEqual(READ_ONLY_SAVED.map(([, , order]) => String(order)));
  }
  await expect(items.first(), label).toBeVisible();
  await expect(items.last(), label).toBeAttached();
  const missing = region(page).locator('.is-missing');
  await expect(missing, label).toHaveCount(1);
  await expect(missing.locator('[data-asset-id]'), label).toHaveAttribute('data-asset-id', String(f.n(15)));
  // No candidate (unsaved local) asset masquerades as a member.
  const regionText = await region(page).textContent();
  const candidates = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24].map((number) => FILE(number).replace(/\.txt$/, ''));
  expect(candidates.filter((name) => regionText.includes(name)), label).toEqual([]);
  for (const [number] of READ_ONLY_SAVED) expect(regionText, label).toContain(FILE(number).replace(/\.txt$/, ''));
  // No editing surface: forms, Save, checkboxes, Role controls, pagination,
  // size or filter controls; no form that POSTs anywhere.
  await expect(page.locator('#release-assets-form'), label).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save asset selection' }), label).toHaveCount(0);
  expect(await editingControls(page), label).toEqual([]);
  await expect(page.locator('.pagination, [data-release-assets-live-page-size-form], [data-dialog-open="release-assets-filter-dialog"]'), label).toHaveCount(0);
  expect((await allForms(page)).filter((form) => form.method === 'post'), label).toEqual([]);
  await expectNoForeignMetadata(page, f);
}

test('C3b: published, archived-release and archived-project Manage Assets show the full saved collection and refuse malformed, valid and non-form Saves', async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  for (const [label, notice, makeReadOnly, guardMessage] of READ_ONLY_STATES) {
    const f = await createFixture(`C3b Read-only ${label}`, { saved: READ_ONLY_SAVED, missing: [15] });
    // A read-only page renders no Save form: read the session's CSRF token
    // while the release is still editable.
    await page.goto(`${baseURL}/releases/${f.releaseId}/assets`);
    const csrf = await csrfOf(page);
    makeReadOnly(f);

    for (const view of ['grid', 'list']) {
      const url = `${baseURL}/releases/${f.releaseId}/assets?selection=all&pageSize=10&view=${view}`;
      const at = `${label} ${view}`;
      const get = await page.goto(url);
      expect(get.status(), at).toBe(200);
      expect(page.url(), at).toBe(url);
      await expectReadOnlyCollection(page, f, view, notice, `${at} GET`);
      expect(page.url(), at).toBe(url);

      // Malformed URL-encoded Save with valid CSRF: 422, saved collection.
      const malformed = await nativePost(page, [
        ['selectedAssetIds', 'abc'], ['selectedAssetIds', String(f.n(2))], ['selectedAssetIds', String(f.foreignId)],
      ], csrf);
      expect(malformed.response.status(), at).toBe(422);
      await expect(page.locator('.error-summary[role="alert"]').filter({ hasText: 'Invalid asset selection.' })).toBeVisible();
      await expectReadOnlyCollection(page, f, view, notice, `${at} malformed POST`);
      expect(savedRows(f.releaseId), at).toEqual(f.persisted);
    }

    // A well-formed Save reaches the read-only guard: 422, nothing written.
    await page.goto(`${baseURL}/releases/${f.releaseId}/assets?selection=all&pageSize=10`);
    const valid = await nativePost(page, [['selectedAssetIds', String(f.n(2))]], csrf);
    expect(valid.response.status(), label).toBe(422);
    await expect(page.locator('.error-summary[role="alert"]').filter({ hasText: guardMessage(f) })).toBeVisible();
    await expectReadOnlyCollection(page, f, 'grid', notice, `${label} valid POST`);
    expect(savedRows(f.releaseId), label).toEqual(f.persisted);

    // Non-form media types with a valid header token: 415, nothing written,
    // and the page the browser is on stays read-only.
    for (const [kind, headers, body] of [
      ['json', { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, JSON.stringify({ selectedAssetIds: [f.n(2)] })],
      ['multipart', { 'X-CSRF-Token': csrf }, [['_csrf', csrf], ['selectedAssetIds', String(f.n(2))]]],
    ]) {
      const result = await page.evaluate(async ({ target, headers, body, kind }) => {
        let payload = body;
        if (kind === 'multipart') {
          payload = new FormData();
          for (const [name, value] of body) payload.append(name, value);
        }
        const res = await fetch(target, { method: 'POST', headers, body: payload, redirect: 'manual' });
        return { status: res.status, text: await res.text() };
      }, { target: `${baseURL}/releases/${f.releaseId}/assets`, headers, body, kind });
      expect(result.status, `${label} ${kind}`).toBe(415);
      expect(result.text, `${label} ${kind}`).toContain('Unsupported asset selection request format.');
      expect(result.text, `${label} ${kind}`).not.toContain('id="release-assets-form"');
      expect(result.text, `${label} ${kind}`).not.toContain('name="selectedAssetIds"');
      expect(savedRows(f.releaseId), `${label} ${kind}`).toEqual(f.persisted);
    }
    await expect(page.locator('#release-assets-form')).toHaveCount(0);
  }
  expect(pageErrors).toEqual([]);
});

// ─── 6. CSRF precedence ──────────────────────────────────────────────────
test('C3b: CSRF failures are 403 before Save validation; valid-token malformed and non-form Saves reach 422 and 415', async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createFixture('C3b CSRF');
  const url = `${baseURL}/releases/${f.releaseId}/assets?selection=all&pageSize=10`;
  await page.goto(url);
  const csrf = await csrfOf(page);
  // The real Save form is a URL-encoded POST to this release.
  const form = (await allForms(page)).find((candidate) => candidate.id === 'release-assets-form');
  expect(form.method).toBe('post');
  expect(new URL(form.action).pathname).toBe(`/releases/${f.releaseId}/assets`);
  expect(await page.locator('#release-assets-form').evaluate((element) => element.enctype)).toBe('application/x-www-form-urlencoded');

  const replace = [['selectedAssetIds', String(f.n(5))]];
  const malformed = [['selectedAssetIds[__proto__]', String(f.n(5))]];
  for (const [label, entries, token, status] of [
    ['missing token', replace, null, 403],
    ['forged token', replace, 'forged-token', 403],
    ['empty token', replace, '', 403],
    ['forged token + malformed body', malformed, 'forged-token', 403],
    ['missing token + malformed body', malformed, null, 403],
    ['valid token + malformed body', malformed, csrf, 422],
  ]) {
    await page.goto(url);
    const { request, response } = await nativePost(page, entries, token);
    const sent = [...new URLSearchParams(request.postData())];
    expect(sent.filter(([name]) => name === '_csrf'), label).toEqual(token === null ? [] : [['_csrf', token]]);
    expect(response.status(), label).toBe(status);
    if (status === 403) {
      expect(await response.json(), label).toEqual({ status: 'error', message: 'Invalid or missing CSRF token.' });
    } else {
      await expectFailClosed(page, FORMAT_ERROR, f);
    }
    expect(savedRows(f.releaseId), label).toEqual(f.persisted);
  }

  // Header-token fetches: a forged header is 403 even for a non-form body; a
  // valid header with a non-form body reaches the 415 media-type boundary.
  await page.goto(url);
  for (const [label, headers, status] of [
    ['json forged header', { 'Content-Type': 'application/json', 'X-CSRF-Token': 'forged-token' }, 403],
    ['json no token', { 'Content-Type': 'application/json' }, 403],
    ['json valid header', { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, 415],
  ]) {
    const status_ = await page.evaluate(async ({ target, headers, body }) => (await fetch(target, {
      method: 'POST', headers, body, redirect: 'manual',
    })).status, { target: url, headers, body: JSON.stringify({ selectedAssetIds: [f.n(5)] }) });
    expect(status_, label).toBe(status);
    expect(savedRows(f.releaseId), label).toEqual(f.persisted);
  }

  // Control: the real form with its real token saves (membership unchanged).
  await page.goto(url);
  const saved = await clickSave(page);
  expect(saved.request.headers()['content-type']).toBe('application/x-www-form-urlencoded');
  expect(saved.response.status()).toBe(302);
  await page.waitForURL((target) => target.pathname === `/releases/${f.releaseId}`);
  expect(savedRows(f.releaseId)).toEqual(
    // Membership-only Save of the same set renumbers kept rows contiguously.
    f.persisted.map((row, index) => ({ ...row, sort_order: index })),
  );
  expect(pageErrors).toEqual([]);
});

// ─── 7. Foreign, unknown and duplicate IDs; unknown release ──────────────
test('C3b: foreign, unknown and duplicate asset IDs and an unknown release never write and never disclose foreign metadata', async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createFixture('C3b Isolation');
  const url = `${baseURL}/releases/${f.releaseId}/assets?selection=all&pageSize=10`;
  const foreignError = `Asset ${f.foreignId} does not belong to the release's project.`;

  // Foreign ID added to the real form (membership-only).
  await page.goto(url);
  const csrf = await csrfOf(page);
  await appendToSaveForm(page, [['selectedAssetIds', String(f.foreignId)]]);
  const foreignMembership = await clickSave(page);
  expect(new URLSearchParams(foreignMembership.request.postData()).getAll('selectedAssetIds').map(Number)).toContain(f.foreignId);
  expect(foreignMembership.response.status()).toBe(422);
  await expect(page.locator('.error-summary[role="alert"]').filter({ hasText: foreignError })).toBeVisible();
  await expectNoForeignMetadata(page, f);
  await expect(page.locator('input[name="roleOrder"]')).toHaveCount(0);
  // The foreign ID has no card or row: no metadata is hydrated for it.
  await expect(page.locator(`[data-asset-id="${f.foreignId}"]`)).toHaveCount(0);
  expect(savedRows(f.releaseId)).toEqual(f.persisted);

  // Foreign ID in a legacy role/order draft.
  await page.goto(url);
  const legacy = await nativePost(page, legacyEntries([
    { assetId: f.n(1), role: 'primary', sortOrder: 0 },
    { assetId: f.foreignId, role: 'preview', sortOrder: 7 },
  ]), csrf);
  expect(legacy.response.status()).toBe(422);
  await expect(page.locator('.error-summary[role="alert"]').filter({ hasText: foreignError })).toBeVisible();
  await expectNoForeignMetadata(page, f);
  await expect(page.locator(`[data-asset-id="${f.foreignId}"]`)).toHaveCount(0);
  expect(savedRows(f.releaseId)).toEqual(f.persisted);

  // Unknown asset ID: 404, no Save form, nothing written.
  await page.goto(url);
  const unknown = await nativePost(page, [['selectedAssetIds', String(f.n(1))], ['selectedAssetIds', '987654321']], csrf);
  expect(unknown.response.status()).toBe(404);
  await expect(page.locator('#release-assets-form')).toHaveCount(0);
  expect((await allForms(page)).filter((form) => form.method === 'post')).toEqual([]);
  await expectNoForeignMetadata(page, f);
  expect(savedRows(f.releaseId)).toEqual(f.persisted);

  // Duplicate selected ID from the real form: 422, nothing written.
  await page.goto(url);
  await appendToSaveForm(page, [['selectedAssetIds', String(f.n(1))]]);
  const duplicate = await clickSave(page);
  expect(new URLSearchParams(duplicate.request.postData()).getAll('selectedAssetIds').filter((id) => Number(id) === f.n(1))).toHaveLength(2);
  expect(duplicate.response.status()).toBe(422);
  await expect(page.locator('.error-summary[role="alert"]').filter({ hasText: 'Duplicate asset IDs are not allowed.' })).toBeVisible();
  expect(savedRows(f.releaseId)).toEqual(f.persisted);

  // Unknown release: 404 with valid CSRF, nothing written anywhere.
  await page.goto(url);
  const missingRelease = await nativePost(page, [['selectedAssetIds', String(f.n(1))]], csrf, `${baseURL}/releases/987654321/assets`);
  expect(missingRelease.response.status()).toBe(404);
  await expect(page.locator('#release-assets-form')).toHaveCount(0);
  expect(savedRows(f.releaseId)).toEqual(f.persisted);
  expect(pageErrors).toEqual([]);
});

// ─── 7b. C4b: foreign-ID rejected-Save retry (characterization) ──────────
// Characterizes, does not endorse, the current P3 retry usability: a foreign
// numeric ID submitted with a membership-only Save is kept by ID only in the
// hidden recovery carrier of the recoverable 422 form; no visible control can
// remove it, so an unchanged retry stays refused. The recoverable page has no
// "Reload Manage Assets" link (that exists only when recovery is
// unavailable); its own GET links are live-region navigation that keeps the
// draft. Leaving through the Release link and returning through Manage Assets
// (a document GET) shows the persisted membership and discards the draft.
async function choosePageSize(page, label) {
  const dropdown = page.locator('#page-size-dropdown');
  await dropdown.locator('summary').scrollIntoViewIfNeeded();
  await dropdown.locator('summary').click();
  await dropdown.locator('.asset-filter-multiselect-panel').getByText(label, { exact: true }).click();
}

test('C4b: a foreign ID kept in the recoverable retry carrier has no visible control, stays refused unchanged, and a GET return discards it with the draft', async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  const dialogs = [];
  page.on('dialog', (dialog) => { dialogs.push(dialog.type()); dialog.dismiss().catch(() => {}); });
  await page.setViewportSize({ width: 1280, height: 900 });
  // Saved: Primary 01, Preview 03, 12, missing 15, 21 (fixture defaults).
  const f = await createFixture('C4b Foreign Retry');
  const requests = trackRequests(page, f.releaseId);
  const foreignError = `Asset ${f.foreignId} does not belong to the release's project.`;
  const savedIds = f.persisted.map((row) => row.asset_id);
  expect(sortedIds(savedIds)).toEqual(sortedIds([f.n(1), f.n(3), f.n(12), f.n(15), f.n(21)]));
  const localIds = Array.from({ length: 25 }, (_, index) => f.n(index + 1));
  expect(localIds).not.toContain(f.foreignId);
  // Draft: add 05 (page 1) and 23 (page 3), remove saved 21 (page 3), plus
  // the foreign ID appended to the real form (a stale or tampered client).
  const draftIds = [f.n(1), f.n(3), f.n(12), f.n(15), f.n(5), f.n(23), f.foreignId];
  const selectedOf = (entries) => entries.filter(([name]) => name === 'selectedAssetIds').map(([, value]) => Number(value));
  const foreignInputs = (target) => target.locator(`input[value="${f.foreignId}"]`);

  await page.goto(`${baseURL}/releases/${f.releaseId}/assets?selection=all&pageSize=10`);
  await checkbox(page, f.n(5)).check({ force: true });
  await goToPage(page, 3);
  await checkbox(page, f.n(21)).uncheck({ force: true });
  await checkbox(page, f.n(23)).check({ force: true });
  await appendToSaveForm(page, [['selectedAssetIds', String(f.foreignId)]]);

  // 1. Initial Save: recoverable 422, nothing written.
  const first = await clickSave(page);
  const firstPosted = [...new URLSearchParams(first.request.postData())];
  expect(firstPosted.map(([name]) => name).filter((name) => name !== '_csrf' && name !== 'selectedAssetIds')).toEqual([]);
  expect(sortedIds(selectedOf(firstPosted))).toEqual(sortedIds(draftIds));
  expect(first.response.status()).toBe(422);
  expect(new URL(page.url()).pathname).toBe(`/releases/${f.releaseId}/assets`);
  await expect(page.locator('.error-summary[role="alert"]').filter({ hasText: foreignError })).toBeVisible();
  await expect(page.locator('[data-release-assets-save-recovery-unavailable]')).toHaveCount(0);
  expect(savedRows(f.releaseId)).toEqual(f.persisted);

  // 2. The rendered retry form: membership-only, every draft ID once, the
  // foreign ID by ID only in the hidden off-page carrier.
  const expectRetryForm = async (label) => {
    const entries = await formEntries(page);
    expect(entries.filter(([name]) => name === '_csrf'), label).toHaveLength(1);
    expect(entries.map(([name]) => name).filter((name) => name !== '_csrf' && name !== 'selectedAssetIds'), label).toEqual([]);
    const selected = selectedOf(entries);
    expect(new Set(selected).size, label).toBe(selected.length);
    expect(sortedIds(selected), label).toEqual(sortedIds(draftIds));
    const hidden = await page.locator('#release-assets-form [data-release-assets-hidden-membership] input[name="selectedAssetIds"]')
      .evaluateAll((inputs) => inputs.map((input) => Number(input.value)));
    expect(hidden, label).toContain(f.foreignId);
    await expect(foreignInputs(page), label).toHaveCount(1);
    await expect(page.locator(`#release-assets-form [data-release-assets-hidden-membership] input[type="hidden"][value="${f.foreignId}"]`), label).toHaveCount(1);
    await expect(page.locator('input[name="roleOrder"]'), label).toHaveCount(0);
    await expect(page.locator(`[data-asset-id="${f.foreignId}"]`), label).toHaveCount(0);
    await expectNoForeignMetadata(page, f);
    return selected;
  };
  const firstRetry = await expectRetryForm('422 page 3');
  await expect(checkbox(page, f.n(23))).toBeChecked();
  await expect(checkbox(page, f.n(21))).not.toBeChecked();

  // 3. No visible control reaches the foreign ID: at View All every local
  // asset has its checkbox and none is the foreign ID, which stays hidden.
  await choosePageSize(page, 'View All');
  await settled(page);
  await expect.poll(() => new URL(page.url()).searchParams.get('pageSize')).toBe('all');
  const boxes = await region(page).locator('input[name="selectedAssetIds"]')
    .evaluateAll((inputs) => inputs.map((input) => ({ id: Number(input.value), type: input.type, checked: input.checked })));
  expect(sortedIds(boxes.map((box) => box.id))).toEqual(sortedIds(localIds));
  expect(boxes.every((box) => box.type === 'checkbox')).toBe(true);
  expect(sortedIds(boxes.filter((box) => box.checked).map((box) => box.id)))
    .toEqual(sortedIds(draftIds.filter((id) => id !== f.foreignId)));
  await expect(page.locator(`input[type="checkbox"][value="${f.foreignId}"], select [value="${f.foreignId}"], button[value="${f.foreignId}"]`)).toHaveCount(0);
  await expectRetryForm('View All');

  // 4. Unchanged retry from the real form: refused the same way, no write,
  // no success redirect; the foreign ID is still carried.
  const retry = await clickSave(page);
  const retryPosted = [...new URLSearchParams(retry.request.postData())];
  expect(sortedIds(selectedOf(retryPosted))).toEqual(sortedIds(firstRetry));
  expect(selectedOf(retryPosted)).toContain(f.foreignId);
  expect(retry.response.status()).toBe(422);
  expect(retry.response.headers().location).toBeUndefined();
  expect(new URL(page.url()).pathname).toBe(`/releases/${f.releaseId}/assets`);
  await expect(page.locator('.error-summary[role="alert"]').filter({ hasText: foreignError })).toBeVisible();
  await expectRetryForm('after unchanged retry');
  expect(savedRows(f.releaseId)).toEqual(f.persisted);

  // 5. The recoverable page offers no Reload link; the way back by GET is
  // the Release link, then that page's Manage Assets link.
  await expect(page.getByRole('link', { name: 'Reload Manage Assets' })).toHaveCount(0);
  await Promise.all([
    page.waitForURL((url) => url.pathname === `/releases/${f.releaseId}`),
    page.getByRole('link', { name: /Release$/ }).first().click(),
  ]);
  const manage = page.getByRole('link', { name: 'Manage Assets' });
  expect(new URL(await manage.getAttribute('href'), baseURL).pathname).toBe(`/releases/${f.releaseId}/assets`);
  const reloaded = page.waitForResponse((res) => new URL(res.url()).pathname === `/releases/${f.releaseId}/assets` && res.request().method() === 'GET');
  await manage.click();
  expect((await reloaded).status()).toBe(200);
  await page.waitForURL((url) => url.pathname === `/releases/${f.releaseId}/assets`);

  // The editable page returns with the persisted membership only: the
  // foreign ID and the unsaved draft (05, 23 added; 21 removed) are gone.
  await expect(page.locator('#release-assets-form')).toHaveCount(1);
  await expect(page.locator('.error-summary[role="alert"]')).toHaveCount(0);
  const recovered = selectedOf(await formEntries(page));
  expect(new Set(recovered).size).toBe(recovered.length);
  expect(sortedIds(recovered)).toEqual(sortedIds(savedIds));
  expect(recovered).toContain(f.n(21));
  for (const discarded of [f.n(5), f.n(23), f.foreignId]) expect(recovered).not.toContain(discarded);
  await expect(foreignInputs(page)).toHaveCount(0);
  await expect(page.locator(`[data-asset-id="${f.foreignId}"]`)).toHaveCount(0);
  await expectNoForeignMetadata(page, f);

  // Nothing but the two refused Saves was ever posted; nothing was written.
  expect(requests.filter((request) => request.method !== 'GET').map((request) => request.path))
    .toEqual([`/releases/${f.releaseId}/assets`, `/releases/${f.releaseId}/assets`]);
  expect(savedRows(f.releaseId)).toEqual(f.persisted);
  expect(dialogs).toEqual([]);
  expect(pageErrors).toEqual([]);
});

// ─── B3-F1/B3-F2. One-time Save success confirmation on Release Detail ───
// The asset count also changes after a Save, so every check asserts the
// visible confirmation itself (and its absence), never the count. Each
// completed Save redirects to /releases/:id?assetsSaved=<its own ticket>;
// the server consumes the ticket once and the page then drops it from the
// address in place.
const SAVE_CONFIRMATION = 'Assets saved successfully.';

// A successful Save's Location: exactly /releases/:id with only its own
// opaque ticket. Returns the Location for following or replaying it.
function expectTicketLocation(location, releaseId, label) {
  expect(location, label).toMatch(new RegExp(`^/releases/${releaseId}\\?assetsSaved=[A-Za-z0-9_-]{43}$`));
  return location;
}

// Holds a real Save: the POST goes to the server (and persists) now, but its
// genuine 302 reaches the page only once release() is called, so the page
// follows that redirect itself, later. Playwright does not route redirect
// follow-ups, so the hold is on the Save response, not the redirected GET.
async function holdSaveRedirect(page, releaseId) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let arrived;
  const held = new Promise((resolve) => { arrived = resolve; });
  await page.route((url) => url.pathname === `/releases/${releaseId}/assets`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch({ maxRedirects: 0 });
    arrived({ status: response.status(), location: response.headers().location });
    await gate;
    return route.fulfill({ response });
  });
  return { held, release: () => release() };
}

const saveButton = (page) => page.getByRole('button', { name: 'Save asset selection' });

async function expectSaveConfirmation(page, label) {
  const feedback = page.locator('[data-dialog-feedback]');
  await expect(feedback, label).toHaveCount(1);
  await expect(feedback, label).toBeVisible();
  await expect(feedback, label).toHaveAttribute('role', 'status');
  await expect(feedback, label).toHaveClass(/\bnotice--success\b/);
  await expect(feedback, label).toHaveText(SAVE_CONFIRMATION);
  await expect(page.getByText(SAVE_CONFIRMATION, { exact: true }), label).toHaveCount(1);
}

async function expectNoSaveConfirmation(page, label) {
  await expect(page.locator('[data-release-detail]'), label).toHaveCount(1);
  await expect(page.locator('[data-dialog-feedback]'), label).toBeHidden();
  await expect(page.getByText(SAVE_CONFIRMATION), label).toHaveCount(0);
  expect(await page.content(), label).not.toContain(SAVE_CONFIRMATION);
}

test('B3-F1: a real Save confirms once on Release Detail; refresh, away-and-back and Back never replay it; a second Save confirms again', async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createFixture('B3F1 Save Confirmation');
  const requests = trackRequests(page, f.releaseId);
  await page.goto(`${baseURL}/releases/${f.releaseId}`);
  await expectNoSaveConfirmation(page, 'before any Save');

  // 1–5. Manage Assets, select an eligible off-saved asset, Save through the
  // visible button, observe the real POST and follow the real redirect.
  await page.goto(`${baseURL}/releases/${f.releaseId}/assets?selection=all&pageSize=10`);
  await checkbox(page, f.n(5)).check({ force: true });
  const { request, response } = await clickSave(page);
  expect(request.method()).toBe('POST');
  expect(new URL(request.url()).pathname).toBe(`/releases/${f.releaseId}/assets`);
  expect(request.headers()['content-type']).toBe('application/x-www-form-urlencoded');
  const posted = [...new URLSearchParams(request.postData())]
    .filter(([name]) => name === 'selectedAssetIds').map(([, value]) => Number(value));
  expect(sortedIds(posted)).toEqual(sortedIds([1, 3, 5, 12, 15, 21].map(f.n)));
  expect(response.status()).toBe(302);
  const ticketLocation = expectTicketLocation(await response.headerValue('location'), f.releaseId, 'first Save');
  await page.waitForURL((target) => target.pathname === `/releases/${f.releaseId}`);

  // 6–8. Release Detail shows the confirmation; SQLite holds the membership.
  await expectSaveConfirmation(page, 'after the first Save');
  expect(savedRows(f.releaseId)).toEqual([...f.persisted, { asset_id: f.n(5), role: 'attachment', sort_order: 5 }]);
  // The spent ticket leaves the address in place, with no extra history entry.
  await expect(page).toHaveURL(`${baseURL}/releases/${f.releaseId}`);

  // Back returns to Manage Assets (the redirect replaced nothing else), and
  // Forward to Release Detail does not bring the confirmation back.
  await page.goBack();
  await page.waitForURL((target) => target.pathname === `/releases/${f.releaseId}/assets`);
  await page.goForward();
  await page.waitForURL((target) => target.pathname === `/releases/${f.releaseId}`);
  await expectNoSaveConfirmation(page, 'after Back then Forward');

  // 9–10. Refresh.
  await page.reload();
  await expectNoSaveConfirmation(page, 'after refresh');
  // The spent ticket itself, requested again, confirms nothing.
  await page.goto(`${baseURL}${ticketLocation}`);
  await expectNoSaveConfirmation(page, 'the spent ticket requested again');

  // 11–12. Navigate away through the visible Releases navigation, then return
  // through a visible Release link.
  await page.goto(`${baseURL}/releases`);
  await page.locator(`a[href="/releases/${f.releaseId}"]`).first().click();
  await page.waitForURL((target) => target.pathname === `/releases/${f.releaseId}`);
  await expectNoSaveConfirmation(page, 'after away and back');

  // 13–14. A second successful Save shows exactly one new confirmation.
  await page.goto(`${baseURL}/releases/${f.releaseId}/assets?selection=all&pageSize=10`);
  await checkbox(page, f.n(1)).uncheck({ force: true });
  const second = await clickSave(page);
  expect(second.response.status()).toBe(302);
  const secondLocation = expectTicketLocation(await second.response.headerValue('location'), f.releaseId, 'second Save');
  expect(secondLocation).not.toBe(ticketLocation);
  await page.waitForURL((target) => target.pathname === `/releases/${f.releaseId}`);
  await expectSaveConfirmation(page, 'after the second Save');
  expect(savedRows(f.releaseId)).toEqual([
    { asset_id: f.n(3), role: 'preview', sort_order: 0 },
    { asset_id: f.n(12), role: 'attachment', sort_order: 1 },
    { asset_id: f.n(15), role: 'attachment', sort_order: 2 },
    { asset_id: f.n(21), role: 'attachment', sort_order: 3 },
    { asset_id: f.n(5), role: 'attachment', sort_order: 4 },
  ]);

  // History Back to the confirming entry does not replay it either.
  await page.goto(`${baseURL}/releases`);
  await page.goBack();
  await page.waitForURL((target) => target.pathname === `/releases/${f.releaseId}`);
  await expectNoSaveConfirmation(page, 'after Back to the confirming entry');

  expect(requests.filter((entry) => entry.method === 'POST')).toHaveLength(2);
  expect(pageErrors).toEqual([]);
});

test('B3-F1: rejected Saves (recoverable 422, fail-closed 422, invalid CSRF 403) never lead to a success confirmation', async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createFixture('B3F1 Rejected');

  // Recoverable 422: a foreign ID kept in the visible Save's draft.
  await page.goto(`${baseURL}/releases/${f.releaseId}/assets?selection=all&pageSize=10`);
  await appendToSaveForm(page, [['selectedAssetIds', String(f.foreignId)]]);
  const recoverable = await clickSave(page);
  expect(recoverable.response.status()).toBe(422);
  await expect(page.locator('.error-summary, [role="alert"]').first()).toBeVisible();
  await expect(page.getByText(SAVE_CONFIRMATION)).toHaveCount(0);
  expect(savedRows(f.releaseId)).toEqual(f.persisted);

  // Fail-closed 422: an unsafe order.
  await page.goto(`${baseURL}/releases/${f.releaseId}/assets?selection=all&pageSize=10`);
  const csrf = await csrfOf(page);
  const failClosed = await nativePost(page, [
    ['selectedAssetIds[]', String(f.n(1))], ['roles[]', 'primary'], ['sortOrder[]', '9007199254740992'],
  ], csrf);
  expect(failClosed.response.status()).toBe(422);
  await expect(page.getByText(ORDER_ERROR)).toBeVisible();
  await expect(page.getByText(SAVE_CONFIRMATION)).toHaveCount(0);

  // Invalid CSRF 403.
  await page.goto(`${baseURL}/releases/${f.releaseId}/assets?selection=all&pageSize=10`);
  const forbidden = await nativePost(page, [['selectedAssetIds', String(f.n(1))]], 'not-a-token');
  expect(forbidden.response.status()).toBe(403);
  await expect(page.getByText(SAVE_CONFIRMATION)).toHaveCount(0);

  expect(savedRows(f.releaseId)).toEqual(f.persisted);
  await page.goto(`${baseURL}/releases/${f.releaseId}`);
  await expectNoSaveConfirmation(page, 'Release Detail after the rejections');
  expect(pageErrors).toEqual([]);
});

test('B3-F2: with JavaScript disabled the server alone keeps the ticket single-use', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1280, height: 900 } });
  try {
    const page = await context.newPage();
    const f = await createFixture('B3F2 No Script');
    await page.goto(`${baseURL}/releases/${f.releaseId}/assets?selection=all&pageSize=10`);
    await checkbox(page, f.n(5)).check({ force: true });
    const { response } = await clickSave(page);
    expect(response.status()).toBe(302);
    const location = expectTicketLocation(await response.headerValue('location'), f.releaseId, 'no-script Save');
    await page.waitForURL((target) => target.pathname === `/releases/${f.releaseId}`);
    // Without script the ticket stays in the address; the server already spent it.
    const landed = new URL(page.url());
    expect(`${landed.pathname}${landed.search}`).toBe(location);
    await expectSaveConfirmation(page, 'no-script redirect');
    expect(savedRows(f.releaseId)).toEqual([...f.persisted, { asset_id: f.n(5), role: 'attachment', sort_order: 5 }]);
    await page.reload();
    await expectNoSaveConfirmation(page, 'no-script refresh of the ticket URL');
    await page.goto(`${baseURL}/releases`);
    await page.goBack();
    await page.waitForURL((target) => target.pathname === `/releases/${f.releaseId}`);
    await expectNoSaveConfirmation(page, 'no-script Back to the ticket URL');
  } finally {
    await context.close();
  }
});

test('B3-F2b: two tabs saving the same release each follow their own redirect and see their own confirmation', async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createFixture('B3F2b Two Tabs');
  const tabB = await page.context().newPage();
  const tabBErrors = trackPageErrors(tabB);
  await tabB.setViewportSize({ width: 1280, height: 900 });
  try {
    const assetsUrl = `${baseURL}/releases/${f.releaseId}/assets?selection=all&pageSize=10`;
    await page.goto(assetsUrl);
    await tabB.goto(assetsUrl);

    // Tab A saves; its real redirect is held before it reaches the server.
    const holdA = await holdSaveRedirect(page, f.releaseId);
    await checkbox(page, f.n(5)).check({ force: true });
    const clickedA = saveButton(page).click();
    const a = await holdA.held;
    expect(a.status).toBe(302);
    const locationA = a.location;
    expect(savedRows(f.releaseId)).toEqual([...f.persisted, { asset_id: f.n(5), role: 'attachment', sort_order: 5 }]);

    // Tab B, loaded before A saved, saves its own draft and follows its redirect.
    await checkbox(tabB, f.n(6)).check({ force: true });
    const b = await clickSave(tabB);
    expect(b.response.status()).toBe(302);
    const locationB = await b.response.headerValue('location');
    await tabB.waitForURL((target) => target.pathname === `/releases/${f.releaseId}`);
    await expectSaveConfirmation(tabB, 'tab B, its own redirect');
    // The later submission is the membership.
    const afterB = [...f.persisted, { asset_id: f.n(6), role: 'attachment', sort_order: 5 }];
    expect(savedRows(f.releaseId)).toEqual(afterB);

    // Tab A's held redirect now reaches the server: its own confirmation.
    holdA.release();
    await clickedA;
    await page.waitForURL((target) => target.pathname === `/releases/${f.releaseId}`);
    await expectSaveConfirmation(page, 'tab A, its own redirect after tab B');

    // Neither replays.
    await page.reload();
    await expectNoSaveConfirmation(page, 'tab A refresh');
    await tabB.reload();
    await expectNoSaveConfirmation(tabB, 'tab B refresh');
    await tabB.goto(`${baseURL}${locationA}`);
    await expectNoSaveConfirmation(tabB, "tab A's spent ticket in tab B");
    await page.goto(`${baseURL}${locationB}`);
    await expectNoSaveConfirmation(page, "tab B's spent ticket in tab A");

    expectTicketLocation(locationA, f.releaseId, 'tab A');
    expectTicketLocation(locationB, f.releaseId, 'tab B');
    expect(locationA).not.toBe(locationB);
    expect(savedRows(f.releaseId)).toEqual(afterB);
    expect(pageErrors).toEqual([]);
    expect(tabBErrors).toEqual([]);
  } finally {
    await tabB.close();
  }
});

test('B3-F2a: a pending successful Save, then a refused Save, never confirms an unrelated Release Detail visit', async ({ page }) => {
  const pageErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createFixture('B3F2a Pending');
  const other = await page.context().newPage();
  const otherErrors = trackPageErrors(other);
  try {
    await page.goto(`${baseURL}/releases/${f.releaseId}/assets?selection=all&pageSize=10`);
    const hold = await holdSaveRedirect(page, f.releaseId);
    await checkbox(page, f.n(5)).check({ force: true });
    const clicked = saveButton(page).click();
    const saved = await hold.held;
    expect(saved.status).toBe(302);
    const afterSave = [...f.persisted, { asset_id: f.n(5), role: 'attachment', sort_order: 5 }];
    expect(savedRows(f.releaseId)).toEqual(afterSave);

    // Another tab's Save is refused (invalid CSRF): nothing is written.
    await other.goto(`${baseURL}/releases/${f.releaseId}/assets?selection=all&pageSize=10`);
    const refused = await nativePost(other, [['selectedAssetIds', String(f.n(6))]], 'not-a-token');
    expect(refused.response.status()).toBe(403);
    expect(savedRows(f.releaseId)).toEqual(afterSave);

    // An unrelated Release Detail visit, from a fresh tab, shows no success.
    const visit = await page.context().newPage();
    const visitErrors = trackPageErrors(visit);
    await visit.goto(`${baseURL}/releases/${f.releaseId}`);
    await expectNoSaveConfirmation(visit, 'unrelated visit after the refused Save');
    await visit.close();
    expect(visitErrors).toEqual([]);

    // The genuine pending redirect, once it arrives, confirms its own Save.
    hold.release();
    await clicked;
    await page.waitForURL((target) => target.pathname === `/releases/${f.releaseId}`);
    await expectSaveConfirmation(page, 'the genuine held redirect');
    await page.reload();
    await expectNoSaveConfirmation(page, 'refresh after the genuine redirect');
    expectTicketLocation(saved.location, f.releaseId, 'pending Save');
    expect(pageErrors).toEqual([]);
    expect(otherErrors).toEqual([]);
  } finally {
    await other.close();
  }
});

// ─── 8. Authentication enabled: unauthenticated and logged-out sessions ──
test.describe('with authentication enabled', () => {
  let authServer;
  let authDb;
  let authApp;
  let authURL;
  let authProjectsRoot;

  test.beforeAll(async () => {
    authProjectsRoot = path.join(root, 'auth-projects');
    const authDataRoot = path.join(root, 'auth-app');
    fs.mkdirSync(authProjectsRoot);
    fs.mkdirSync(authDataRoot);
    authDb = openDatabase(path.join(root, 'auth.db'));
    runMigrations(authDb, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const provider = createStaticCredentialProvider({ username: AUTH_CONFIG.username, passwordHash: AUTH_CONFIG.passwordHash });
    authApp = createApp({ appName: 'CreatorCrate', db: authDb, projectsRoot: authProjectsRoot }, {
      appDataRoot: authDataRoot,
      authConfig: { ...AUTH_CONFIG, credentialProvider: provider },
      credentialProvider: provider,
      loginThrottler: createLoginThrottler({ baseDelayMs: 0, maxDelayMs: 0 }),
      useViteAssets: true,
      viteDistRoot,
      assetManifest: manifest(),
    });
    authServer = authApp.listen(0, '127.0.0.1');
    await new Promise((resolve) => authServer.once('listening', resolve));
    authURL = `http://127.0.0.1:${authServer.address().port}`;
  });

  test.afterAll(async () => {
    if (authServer) {
      authServer.closeAllConnections();
      await new Promise((resolve) => authServer.close(resolve));
    }
    if (authDb) closeDatabase(authDb);
  });

  test('C3b: unauthenticated and logged-out browsers never reach Save; the logged-in real form still saves', async ({ page }) => {
    const pageErrors = trackPageErrors(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    const f = await createFixture('C3b Auth', { targetApp: authApp, targetDb: authDb, targetProjectsRoot: authProjectsRoot });
    const assetsPath = `/releases/${f.releaseId}/assets?selection=all&pageSize=10`;
    const rows = () => savedRows(f.releaseId, authDb);
    const post = (entries, csrf) => page.evaluate(async ({ target, entries, csrf }) => {
      const body = new URLSearchParams(csrf === null ? entries : [['_csrf', csrf], ...entries]);
      const res = await fetch(target, { method: 'POST', body, redirect: 'manual' });
      return { status: res.status, type: res.headers.get('content-type'), text: await res.text() };
    }, { target: `${authURL}${assetsPath}`, entries, csrf });

    // Unauthenticated GET is sent to login; nothing of the release renders.
    await page.goto(`${authURL}${assetsPath}`);
    await page.waitForURL((url) => url.pathname === '/login');
    expect(new URL(page.url()).searchParams.get('next')).toBe(assetsPath);
    await expect(page.locator('#release-assets-form')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(FILE(1));

    // Unauthenticated POSTs, with no token or the login page's anonymous token.
    const anonymous = await page.locator('input[name="_csrf"]').first().inputValue();
    for (const [label, token] of [['no token', null], ['anonymous login token', anonymous]]) {
      const result = await post([['selectedAssetIds', String(f.n(5))]], token);
      expect(result.status, label).toBe(401);
      expect(JSON.parse(result.text), label).toEqual({ status: 'error', message: 'Authentication required.' });
      expect(result.text, label).not.toContain(FILE(1));
      expect(rows(), label).toEqual(f.persisted);
    }

    // Log in through the real form; capture this session's Save token.
    await page.locator('#username').fill(TEST_USERNAME);
    await page.locator('#password').fill(TEST_PASSWORD);
    await Promise.all([
      page.waitForURL((url) => url.pathname === `/releases/${f.releaseId}/assets`),
      page.locator('#password').press('Enter'),
    ]);
    const sessionToken = await csrfOf(page);
    // A forged token in the authenticated session is still 403.
    const forged = await post([['selectedAssetIds', String(f.n(5))]], 'forged-token');
    expect(forged.status).toBe(403);
    expect(rows()).toEqual(f.persisted);

    // Log out; the old session's token never reaches Save.
    await Promise.all([
      page.waitForURL((url) => url.pathname === '/login'),
      page.evaluate(() => document.querySelector('form[action="/logout"]').submit()),
    ]);
    const stale = await post([['selectedAssetIds', String(f.n(5))]], sessionToken);
    expect(stale.status).toBe(401);
    expect(JSON.parse(stale.text)).toEqual({ status: 'error', message: 'Authentication required.' });
    expect(stale.text).not.toContain('release-assets-form');
    expect(rows()).toEqual(f.persisted);

    // Logged in again, the real form saves an off-page addition.
    await page.goto(`${authURL}/login`);
    await page.locator('#username').fill(TEST_USERNAME);
    await page.locator('#password').fill(TEST_PASSWORD);
    await Promise.all([page.waitForURL((url) => url.pathname === '/'), page.locator('#password').press('Enter')]);
    await page.goto(`${authURL}${assetsPath}`);
    await checkbox(page, f.n(5)).check({ force: true });
    const saved = await clickSave(page);
    expect(saved.response.status()).toBe(302);
    await page.waitForURL((url) => url.pathname === `/releases/${f.releaseId}`);
    expect(rows()).toEqual([
      ...f.persisted.map((row, index) => ({ ...row, sort_order: index })),
      { asset_id: f.n(5), role: 'attachment', sort_order: f.persisted.length },
    ]);
    expect(pageErrors).toEqual([]);
  });
});
