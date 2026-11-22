import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { createApp } from '../../src/app.js';
import { createAssetManifest } from '../../src/asset-manifest.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';
import { createReleaseService } from '../../src/services/release-service.js';

// B-F2 Manage Assets rejected Save in real Chromium: a legacy role/order Save
// rejected with 422 renders a retry form that, after the live region has
// rewritten its hidden membership, still submits the same asset/role/order
// association; the indexed role error is a visible alert; navigation and
// checkbox toggles never move a role onto another asset. All data lives in a
// temporary root that is removed afterward.
const ASSETS = Array.from({ length: 25 }, (_, index) => `${String(index + 1).padStart(2, '0')}-image.txt`);

let server;
let db;
let app;
let root;
let projectsRoot;
let baseURL;
let releaseService;

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-release-rejected-save-'));
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

// Saved: 01 Primary, 02 missing Preview, 20 (off-page member), 21 (off-page
// member the draft removes). One asset in another project.
async function createFixture(title) {
  const project = app.locals.projectService.create({ title, status: 'tbd' });
  const projectDir = path.join(projectsRoot, project.project_dir);
  ASSETS.forEach((filename) => fs.writeFileSync(path.join(projectDir, filename), filename));
  app.locals.assetScanner.scanProjectAssets(project.id);
  const ids = Object.fromEntries(db.prepare('SELECT filename, id FROM assets WHERE project_id = ?')
    .all(project.id).map((row) => [row.filename, row.id]));
  const foreignProject = app.locals.projectService.create({ title: `${title} Foreign`, status: 'tbd' });
  fs.writeFileSync(path.join(projectsRoot, foreignProject.project_dir, 'foreign-secret.txt'), 'secret');
  app.locals.assetScanner.scanProjectAssets(foreignProject.id);
  const foreignId = db.prepare('SELECT id FROM assets WHERE project_id = ?').get(foreignProject.id).id;
  const release = releaseService.createRelease(project.id, {
    title: `${title} Release`, description: '', notes: '', plannedDate: null, patreonUrl: null,
  });
  const insert = db.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)');
  insert.run(release.id, ids['01-image.txt'], 'primary', 0);
  insert.run(release.id, ids['02-image.txt'], 'preview', 1);
  insert.run(release.id, ids['20-image.txt'], 'attachment', 2);
  insert.run(release.id, ids['21-image.txt'], 'attachment', 3);
  db.prepare("UPDATE assets SET is_present = 0, missing_since = '2025-02-01T00:00:00Z' WHERE id = ?").run(ids['02-image.txt']);
  return { releaseId: release.id, ids, foreignId };
}

const savedRows = (releaseId) => db
  .prepare('SELECT asset_id, role, sort_order FROM release_assets WHERE release_id = ? ORDER BY sort_order, asset_id')
  .all(releaseId);

// The Save form's entry list exactly as the browser would submit it.
const formEntries = (page) => page.evaluate(() => [...new FormData(document.getElementById('release-assets-form'))]);

// The retry form carries role/order keyed by asset ID in one compact
// `roleOrder` field (B-F2R1), never as expanded per-asset fields.
function readDraft(entries) {
  expect(entries.some(([name]) => /^(roleAssetIds|roles|sortOrder)\b/.test(name))).toBe(false);
  const carriers = entries.filter(([name]) => name === 'roleOrder');
  expect(carriers.length).toBeLessThanOrEqual(1);
  return {
    selected: entries.filter(([name]) => name === 'selectedAssetIds').map(([, value]) => Number(value)),
    carried: carriers.length
      ? JSON.parse(carriers[0][1]).map(([assetId, role, sortOrder]) => ({ assetId, role, sortOrder }))
      : [],
  };
}

const sortedIds = (ids) => [...ids].sort((a, b) => a - b);

function expectDraft(entries, draft) {
  const { selected, carried } = readDraft(entries);
  expect(new Set(selected).size).toBe(selected.length);
  expect(sortedIds(selected)).toEqual(sortedIds(draft.map((entry) => entry.assetId)));
  expect(carried).toEqual(draft);
}

// Submit a legacy positional Save as a native document POST (an older client).
async function submitLegacySave(page, url, draft) {
  await page.goto(url);
  const csrf = await page.locator('#release-assets-form input[name="_csrf"]').inputValue();
  const response = page.waitForResponse((res) => res.request().method() === 'POST');
  await page.evaluate(({ csrf, draft }) => {
    const form = document.createElement('form');
    form.method = 'post';
    form.action = window.location.href;
    const add = (name, value) => {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.value = value;
      form.append(input);
    };
    add('_csrf', csrf);
    draft.forEach((entry) => add('selectedAssetIds[]', String(entry.assetId)));
    draft.forEach((entry) => add('roles[]', entry.role));
    draft.forEach((entry) => add('sortOrder[]', String(entry.sortOrder)));
    document.body.append(form);
    form.submit();
  }, { csrf, draft });
  return response;
}

async function settled(page) {
  await expect(page.locator('[data-release-assets-live-region]')).not.toHaveAttribute('aria-busy', 'true');
}

test('B-F2: a rejected legacy Save keeps roles/order through the live region, navigation and an unchanged resubmission', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createFixture('Rejected Save');
  const url = `${baseURL}/releases/${f.releaseId}/assets?selection=all&pageSize=10`;
  const rowsBefore = savedRows(f.releaseId);
  const draft = [
    { assetId: f.ids['20-image.txt'], role: 'attachment', sortOrder: 5 },
    { assetId: f.ids['22-image.txt'], role: '<b>bogus</b>', sortOrder: 4 },
    { assetId: f.ids['01-image.txt'], role: 'primary', sortOrder: 2 },
    { assetId: f.ids['02-image.txt'], role: 'preview', sortOrder: 3 },
    { assetId: f.foreignId, role: 'attachment', sortOrder: 6 },
    { assetId: f.ids['05-image.txt'], role: 'attachment', sortOrder: 1 },
  ];

  const rejected = await submitLegacySave(page, url, draft);
  expect(rejected.status()).toBe(422);
  await page.waitForLoadState('load');

  const alert = page.locator('[data-release-assets-selection-errors]');
  await expect(alert).toBeVisible();
  await expect(alert).toHaveAttribute('role', 'alert');
  await expect(alert).toContainText(
    `Asset ${f.ids['22-image.txt']} has an invalid role "<b>bogus</b>". Role must be one of: primary, preview, attachment.`,
  );
  await expect(alert.locator('b')).toHaveCount(0);
  expect(await page.content()).not.toContain('foreign-secret');

  // After the live region bound and rewrote the hidden membership.
  const region = page.locator('[data-release-assets-live-region]');
  const checkbox = (name) => region.locator(`input[name="selectedAssetIds"][value="${f.ids[name]}"]`);
  await expect(checkbox('05-image.txt')).toBeChecked();
  await expect(checkbox('22-image.txt')).toHaveCount(0);
  await expect(checkbox('20-image.txt')).toHaveCount(0);
  expectDraft(await formEntries(page), draft);

  // Toggle a visible checkbox off and on, then page away and back.
  await checkbox('05-image.txt').uncheck({ force: true });
  expect(readDraft(await formEntries(page)).selected).not.toContain(f.ids['05-image.txt']);
  await checkbox('05-image.txt').check({ force: true });
  expectDraft(await formEntries(page), draft);
  await region.locator('.pagination-next').click();
  await settled(page);
  await expect(page.locator('.pagination-info')).toHaveText('Page 2 of 3');
  expectDraft(await formEntries(page), draft);
  await page.goBack();
  await settled(page);
  await expect(page.locator('.pagination-info')).toHaveText('Page 1 of 3');
  expectDraft(await formEntries(page), draft);
  expect(savedRows(f.releaseId)).toEqual(rowsBefore);

  // Unchanged resubmission: the same payload association and refusal.
  const posted = page.waitForRequest((request) => request.method() === 'POST');
  const again = page.waitForResponse((res) => res.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save asset selection' }).click();
  const body = [...new URLSearchParams((await posted).postData())];
  expectDraft(body, draft);
  expect((await again).status()).toBe(422);
  await page.waitForLoadState('load');
  await expect(page.locator('[data-release-assets-selection-errors]')).toContainText('invalid role "<b>bogus</b>"');
  expectDraft(await formEntries(page), draft);
  expect(savedRows(f.releaseId)).toEqual(rowsBefore);
  expect(pageErrors).toEqual([]);
});

test('B-F2: deselecting the invalid-role asset after a rejected Save saves the remaining roles and order', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createFixture('Rejected Save Correction');
  const url = `${baseURL}/releases/${f.releaseId}/assets?selection=all&pageSize=10`;
  const draft = [
    { assetId: f.ids['20-image.txt'], role: 'preview', sortOrder: 4 },
    { assetId: f.ids['05-image.txt'], role: 'cover', sortOrder: 0 },
    { assetId: f.ids['22-image.txt'], role: 'attachment', sortOrder: 3 },
    { assetId: f.ids['01-image.txt'], role: 'primary', sortOrder: 2 },
  ];
  const rejected = await submitLegacySave(page, url, draft);
  expect(rejected.status()).toBe(422);
  await page.waitForLoadState('load');
  await expect(page.locator('[data-release-assets-selection-errors]'))
    .toContainText(`Asset ${f.ids['05-image.txt']} has an invalid role "cover".`);

  const region = page.locator('[data-release-assets-live-region]');
  await region.locator(`input[name="selectedAssetIds"][value="${f.ids['05-image.txt']}"]`).uncheck({ force: true });
  await region.locator('.pagination-next').click();
  await settled(page);

  const saved = page.waitForResponse((res) => res.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save asset selection' }).click();
  expect((await saved).status()).toBe(302);
  await expect.poll(() => savedRows(f.releaseId)).toEqual([
    // The legacy contract keeps the unsubmitted saved missing member.
    { asset_id: f.ids['02-image.txt'], role: 'preview', sort_order: 1 },
    { asset_id: f.ids['01-image.txt'], role: 'primary', sort_order: 2 },
    { asset_id: f.ids['22-image.txt'], role: 'attachment', sort_order: 3 },
    { asset_id: f.ids['20-image.txt'], role: 'preview', sort_order: 4 },
  ]);
  expect(pageErrors).toEqual([]);
});

// B-F2R1: a 300-member legacy draft. The expanded keyed carrier needed
// 4 × 300 + 1 = 1,201 URL-encoded fields, over Express's 1,000-parameter
// limit (413 before the route ran); the compact carrier needs 302.
const LARGE_ASSETS = Array.from({ length: 320 }, (_, index) => `${String(index + 1).padStart(3, '0')}-large.txt`);

test('B-F2R1: a 300-member rejected legacy Save retries through the parser unchanged, then saves exact roles/order', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const project = app.locals.projectService.create({ title: 'Large Rejected Save', status: 'tbd' });
  const projectDir = path.join(projectsRoot, project.project_dir);
  LARGE_ASSETS.forEach((filename) => fs.writeFileSync(path.join(projectDir, filename), filename));
  app.locals.assetScanner.scanProjectAssets(project.id);
  const id = Object.fromEntries(db.prepare('SELECT filename, id FROM assets WHERE project_id = ?')
    .all(project.id).map((row) => [row.filename, row.id]));
  const n = (number) => id[`${String(number).padStart(3, '0')}-large.txt`];
  const release = releaseService.createRelease(project.id, {
    title: 'Large Rejected Save Release', description: '', notes: '', plannedDate: null, patreonUrl: null,
  });
  const insert = db.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)');
  insert.run(release.id, n(1), 'primary', 0);
  insert.run(release.id, n(2), 'preview', 1);
  insert.run(release.id, n(320), 'attachment', 2);
  const rowsBefore = savedRows(release.id);
  const url = `${baseURL}/releases/${release.id}/assets?selection=all&pageSize=10`;

  // Sequence: Preview, Primary, the invalid-role asset (visible on page 1),
  // then 302…6 descending; unique explicit orders (7 is coprime with 300).
  const sequence = [n(2), n(1), n(5)];
  for (let number = 302; number >= 6; number -= 1) sequence.push(n(number));
  expect(sequence).toHaveLength(300);
  const draft = sequence.map((assetId, index) => ({
    assetId,
    role: assetId === n(1) ? 'primary' : (assetId === n(2) ? 'preview' : (assetId === n(5) ? 'bogus' : 'attachment')),
    sortOrder: (index * 7) % 300,
  }));

  const rejected = await submitLegacySave(page, url, draft);
  expect(rejected.status()).toBe(422);
  await page.waitForLoadState('load');
  const alert = page.locator('[data-release-assets-selection-errors]');
  await expect(alert).toBeVisible();
  await expect(alert).toHaveAttribute('role', 'alert');
  await expect(alert).toContainText(`Asset ${n(5)} has an invalid role "bogus".`);

  // The live region has bound; the real FormData is the complete draft.
  const region = page.locator('[data-release-assets-live-region]');
  const invalidCheckbox = region.locator(`input[name="selectedAssetIds"][value="${n(5)}"]`);
  await expect(invalidCheckbox).toBeChecked();
  const entries = await formEntries(page);
  expect(entries).toHaveLength(302);
  expect(entries.filter(([name]) => name === '_csrf')).toHaveLength(1);
  expectDraft(entries, draft);
  expect(readDraft(entries).selected).not.toContain(n(320));

  // Unchanged resubmission is received by the route and refused the same way.
  const posted = page.waitForRequest((request) => request.method() === 'POST');
  const again = page.waitForResponse((res) => res.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save asset selection' }).click();
  const request = await posted;
  expect(request.headers()['content-type']).toContain('application/x-www-form-urlencoded');
  const body = [...new URLSearchParams(request.postData())];
  expect(body).toHaveLength(302);
  expect(Buffer.byteLength(request.postData())).toBeLessThan(100 * 1024);
  expectDraft(body, draft);
  expect((await again).status()).toBe(422);
  await page.waitForLoadState('load');
  await expect(page.locator('[data-release-assets-selection-errors]')).toContainText(`Asset ${n(5)} has an invalid role "bogus".`);
  expectDraft(await formEntries(page), draft);
  expect(savedRows(release.id)).toEqual(rowsBefore);

  // Correct through the page: deselect the invalid-role asset and Save.
  await region.locator(`input[name="selectedAssetIds"][value="${n(5)}"]`).uncheck({ force: true });
  const corrected = draft.filter((entry) => entry.assetId !== n(5));
  const correctedEntries = await formEntries(page);
  expect(correctedEntries).toHaveLength(301);
  expect(sortedIds(readDraft(correctedEntries).selected)).toEqual(sortedIds(corrected.map((entry) => entry.assetId)));
  const saved = page.waitForResponse((res) => res.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save asset selection' }).click();
  expect((await saved).status()).toBe(302);
  await expect.poll(() => savedRows(release.id)).toEqual(
    [...corrected].sort((a, b) => a.sortOrder - b.sortOrder)
      .map(({ assetId, role, sortOrder }) => ({ asset_id: assetId, role, sort_order: sortOrder })),
  );
  expect(pageErrors).toEqual([]);
});

// B-F4: a malformed Save posted to a read-only release (published, archived,
// or under an archived project) stays a 422 refusal, still displays the
// complete persisted saved collection, and never turns into an editable form.
test('B-F4: a malformed Save on a read-only release shows the saved collection and no editable form', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const states = [
    ['published', 'This release is published. Asset selections are locked and read-only.',
      (f) => db.prepare("UPDATE releases SET published_date = '2025-06-15' WHERE id = ?").run(f.releaseId)],
    ['archived release', 'This release is archived. Asset selections are read-only.',
      (f) => db.prepare("UPDATE releases SET archived_at = '2026-01-01T00:00:00Z' WHERE id = ?").run(f.releaseId)],
    ['archived project', 'The parent project is archived. Asset selections are read-only.',
      (f) => db.prepare("UPDATE projects SET archived_at = '2026-01-01T00:00:00Z' WHERE id = (SELECT project_id FROM releases WHERE id = ?)").run(f.releaseId)],
  ];
  for (const [label, notice, makeReadOnly] of states) {
    const f = await createFixture(`Read-only malformed ${label}`);
    // A read-only page renders no Save form, so read this browser session's
    // CSRF token while the release is still editable.
    await page.goto(`${baseURL}/releases/${f.releaseId}/assets`);
    const csrf = await page.locator('#release-assets-form input[name="_csrf"]').inputValue();
    makeReadOnly(f);
    const rowsBefore = savedRows(f.releaseId);
    const savedIds = rowsBefore.map((row) => row.asset_id);
    for (const view of ['grid', 'list']) {
      await page.goto(`${baseURL}/releases/${f.releaseId}/assets?selection=all&pageSize=10&view=${view}`);
      const response = page.waitForResponse((res) => res.request().method() === 'POST');
      await page.evaluate(({ csrf, ids }) => {
        const form = document.createElement('form');
        form.method = 'post';
        form.action = window.location.href;
        for (const [name, value] of [['_csrf', csrf], ...ids.map((id) => ['selectedAssetIds', id])]) {
          const input = document.createElement('input');
          input.type = 'hidden';
          input.name = name;
          input.value = value;
          form.append(input);
        }
        document.body.append(form);
        form.submit();
      }, { csrf, ids: ['abc', String(f.foreignId), String(f.ids['05-image.txt'])] });
      expect((await response).status(), `${label} ${view}`).toBe(422);
      await page.waitForLoadState('load');

      await expect(page.getByText('Invalid asset selection.', { exact: true })).toBeVisible();
      await expect(page.getByText(notice)).toBeVisible();
      const region = page.locator('[data-release-assets-live-region]');
      const cards = region.locator('[data-asset-id]');
      await expect(cards).toHaveCount(savedIds.length);
      expect(await cards.evaluateAll((nodes) => nodes.map((node) => Number(node.dataset.assetId)))).toEqual(savedIds);
      await expect(cards.first()).toBeVisible();
      await expect(region.locator('.is-missing')).toHaveCount(1);
      await expect(region).toContainText('01-image.txt');
      await expect(region).toContainText('21-image.txt');
      await expect(region).not.toContainText('05-image.txt');
      await expect(page.locator('body')).not.toContainText('foreign-secret');
      // Never editable: no Save form, selection controls or retry carriers.
      await expect(page.locator('#release-assets-form')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Save asset selection' })).toHaveCount(0);
      await expect(page.locator('input[name="selectedAssetIds"], input[name="roleOrder"], [name^="roles"], [name^="sortOrder"]')).toHaveCount(0);
      await expect(region.locator('input[type="checkbox"]:not([disabled])')).toHaveCount(0);
      expect(savedRows(f.releaseId)).toEqual(rowsBefore);
    }
  }
  expect(pageErrors).toEqual([]);
});

// ─── B-F2R3: unrepresentable legacy order and unsafe empty retry ───────────
// A legacy order beyond Number.MAX_SAFE_INTEGER, or a rejected Save whose
// role/order carrier cannot be read, must never come back as an editable form
// whose Save clears membership. The refusal fails closed (no Save form, no
// selection controls) and reloading starts again from the saved selection.
const ORDER_ERROR = 'Invalid asset order. Each order must be a whole number from 0 to 9007199254740991.';
const FORMAT_ERROR = 'Invalid asset selection format.';

// Two saved members: 01 Primary (order 0) and 05 Preview (order 1).
async function createTwoMemberFixture(title) {
  const f = await createFixture(title);
  db.prepare('DELETE FROM release_assets WHERE release_id = ?').run(f.releaseId);
  const insert = db.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)');
  insert.run(f.releaseId, f.ids['01-image.txt'], 'primary', 0);
  insert.run(f.releaseId, f.ids['05-image.txt'], 'preview', 1);
  const persisted = [
    { asset_id: f.ids['01-image.txt'], role: 'primary', sort_order: 0 },
    { asset_id: f.ids['05-image.txt'], role: 'preview', sort_order: 1 },
  ];
  expect(savedRows(f.releaseId)).toEqual(persisted);
  return { ...f, persisted };
}

// Every form on the page as the browser would submit it.
const allFormData = (page) => page.evaluate(() => [...document.forms].map((form) => ({
  id: form.id,
  method: form.method,
  action: form.action,
  entries: [...new FormData(form)],
})));

// Append hidden fields to the real rendered Save form.
const appendToSaveForm = (page, fields) => page.evaluate((pairs) => {
  for (const [name, value] of pairs) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    document.getElementById('release-assets-form').append(input);
  }
}, fields);

// The fail-closed refusal: visible error and notice, and no control anywhere
// on the page that could submit a membership draft.
async function expectFailClosed(page, error, f) {
  await expect(page.getByText(error, { exact: true })).toBeVisible();
  const notice = page.locator('[data-release-assets-save-recovery-unavailable]');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('Nothing was saved.');
  await expect(page.locator('#release-assets-form')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save asset selection' })).toHaveCount(0);
  await expect(page.locator('input[name="selectedAssetIds"], input[name="roleOrder"], [name^="roles"], [name^="sortOrder"]')).toHaveCount(0);
  await expect(page.locator('[data-release-assets-live-region] input[type="checkbox"]')).toHaveCount(0);
  for (const form of await allFormData(page)) {
    const membershipFields = form.entries.filter(([name]) => /^(selectedAssetIds|roleOrder|roleAssetIds|roles|sortOrder)\b/.test(name));
    expect(membershipFields, `form ${form.id || form.action}`).toEqual([]);
    expect(form.method === 'post' && new URL(form.action).pathname === `/releases/${f.releaseId}/assets`).toBe(false);
  }
  await expect(page.locator('body')).not.toContainText('foreign-secret');
}

// Follow the refusal's reload link and Save the freshly rendered form
// unchanged: the saved selection survives exactly.
async function reloadAndSaveUnchanged(page, f) {
  await page.getByRole('link', { name: 'Reload Manage Assets' }).click();
  await page.waitForLoadState('load');
  await expect(page.locator('[data-release-assets-save-recovery-unavailable]')).toHaveCount(0);
  const entries = await formEntries(page);
  expect(sortedIds(readDraft(entries).selected)).toEqual(sortedIds(f.persisted.map((row) => row.asset_id)));
  expect(readDraft(entries).carried).toEqual([]);
  const saved = page.waitForResponse((res) => res.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save asset selection' }).click();
  expect((await saved).status()).toBe(302);
  await page.waitForLoadState('load');
  expect(savedRows(f.releaseId)).toEqual(f.persisted);
}

test('B-F2R3: the unsafe-order legacy Save is refused without any resubmittable form', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createTwoMemberFixture('Unsafe Order Chain');
  const url = `${baseURL}/releases/${f.releaseId}/assets?selection=all&pageSize=10`;
  // Three selected assets (the two saved members plus off-page 22), explicit
  // roles, one invalid role, one order beyond Number.MAX_SAFE_INTEGER.
  const draft = [
    { assetId: f.ids['01-image.txt'], role: 'primary', sortOrder: '0' },
    { assetId: f.ids['05-image.txt'], role: 'preview', sortOrder: '1' },
    { assetId: f.ids['22-image.txt'], role: 'bogus', sortOrder: '9007199254740992' },
  ];

  // POST 1: the legacy Save is refused, fail-closed; nothing to resubmit.
  const rejected = await submitLegacySave(page, url, draft);
  expect(rejected.status()).toBe(422);
  await page.waitForLoadState('load');
  await expectFailClosed(page, ORDER_ERROR, f);
  expect(await page.content()).not.toContain('9007199254740992');
  expect(savedRows(f.releaseId)).toEqual(f.persisted);

  // POST 2, the only Save the server exposes: reload, Save unchanged.
  await reloadAndSaveUnchanged(page, f);
  await page.goto(url);
  expect(savedRows(f.releaseId)).toEqual(f.persisted);
  expect(pageErrors).toEqual([]);
});

test('B-F2R3: a real Save form submitted with a malformed compact carrier fails closed, never as an empty Save', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createTwoMemberFixture('Malformed Carrier Chain');
  const url = `${baseURL}/releases/${f.releaseId}/assets?selection=all&pageSize=10`;
  const id = (name) => f.ids[name];
  const member = id('01-image.txt');
  const cases = [
    ['unsafe integer order', [['roleOrder', `[[${member},"primary",0],[${id('05-image.txt')},"preview",1],[${id('22-image.txt')},"bogus",9007199254740992]]`]]],
    ['invalid JSON', [['roleOrder', `[[${member},"primary",0]`]]],
    ['entry of wrong length', [['roleOrder', `[[${member},"primary"]]`]]],
    ['invalid asset ID', [['roleOrder', '[[0,"primary",0]]']]],
    ['mixed compact and keyed', [['roleOrder', `[[${member},"primary",0]]`], ['roleAssetIds[0]', String(member)]]],
    ['repeated roleOrder', [['roleOrder', `[[${member},"primary",0]]`], ['roleOrder', `[[${member},"primary",0]]`]]],
  ];
  for (const [label, fields] of cases) {
    // The real rendered form on page 3, with off-page-for-page-1 asset 22
    // checked through the page's own selection state, plus the carrier.
    await page.goto(`${url}&page=3`);
    await page.locator(`[data-release-assets-live-region] input[name="selectedAssetIds"][value="${id('22-image.txt')}"]`).check({ force: true });
    await appendToSaveForm(page, fields);
    const entries = await formEntries(page);
    expect(sortedIds(entries.filter(([name]) => name === 'selectedAssetIds').map(([, value]) => Number(value))), label)
      .toEqual(sortedIds([member, id('05-image.txt'), id('22-image.txt')]));

    const posted = page.waitForResponse((res) => res.request().method() === 'POST');
    await page.getByRole('button', { name: 'Save asset selection' }).click();
    expect((await posted).status(), label).toBe(422);
    await page.waitForLoadState('load');
    await expectFailClosed(page, FORMAT_ERROR, f);
    expect(savedRows(f.releaseId), label).toEqual(f.persisted);
  }

  await reloadAndSaveUnchanged(page, f);
  expect(pageErrors).toEqual([]);
});

test('B-F2R3 control: an ordinary rejected legacy Save keeps its compact retry; unchanged it is refused, role-corrected it saves', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createTwoMemberFixture('Recoverable Control');
  const url = `${baseURL}/releases/${f.releaseId}/assets?selection=all&pageSize=10`;
  // Safe orders, an invalid role on off-page 22, retained Primary and Preview.
  const draft = [
    { assetId: f.ids['22-image.txt'], role: 'bogus', sortOrder: 2 },
    { assetId: f.ids['05-image.txt'], role: 'preview', sortOrder: 0 },
    { assetId: f.ids['01-image.txt'], role: 'primary', sortOrder: 1 },
  ];

  const rejected = await submitLegacySave(page, url, draft);
  expect(rejected.status()).toBe(422);
  await page.waitForLoadState('load');
  const alert = page.locator('[data-release-assets-selection-errors]');
  await expect(alert).toBeVisible();
  await expect(alert).toHaveAttribute('role', 'alert');
  await expect(alert).toContainText(`Asset ${f.ids['22-image.txt']} has an invalid role "bogus".`);
  await expect(page.locator('[data-release-assets-save-recovery-unavailable]')).toHaveCount(0);
  expectDraft(await formEntries(page), draft);
  expect(savedRows(f.releaseId)).toEqual(f.persisted);

  // Unchanged retry reaches validation and is refused for the role again.
  const posted = page.waitForRequest((request) => request.method() === 'POST');
  const again = page.waitForResponse((res) => res.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save asset selection' }).click();
  expectDraft([...new URLSearchParams((await posted).postData())], draft);
  expect((await again).status()).toBe(422);
  await page.waitForLoadState('load');
  await expect(page.locator('[data-release-assets-selection-errors]')).toContainText(`Asset ${f.ids['22-image.txt']} has an invalid role "bogus".`);
  await expect(page.getByText(FORMAT_ERROR, { exact: true })).toHaveCount(0);
  expectDraft(await formEntries(page), draft);
  expect(savedRows(f.releaseId)).toEqual(f.persisted);

  // Correct the invalid role in the carried draft and Save natively.
  const corrected = draft.map((entry) => (entry.role === 'bogus' ? { ...entry, role: 'attachment' } : entry));
  await page.evaluate((value) => {
    document.querySelector('#release-assets-form input[name="roleOrder"]').value = value;
  }, JSON.stringify(corrected.map(({ assetId, role, sortOrder }) => [assetId, role, sortOrder])));
  expectDraft(await formEntries(page), corrected);
  const saved = page.waitForResponse((res) => res.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save asset selection' }).click();
  expect((await saved).status()).toBe(302);
  await expect.poll(() => savedRows(f.releaseId)).toEqual([
    { asset_id: f.ids['05-image.txt'], role: 'preview', sort_order: 0 },
    { asset_id: f.ids['01-image.txt'], role: 'primary', sort_order: 1 },
    { asset_id: f.ids['22-image.txt'], role: 'attachment', sort_order: 2 },
  ]);
  expect(pageErrors).toEqual([]);
});

// Submit arbitrary Save fields as a native document POST from the page (a
// browser-originated legacy keyed form; the current UI never renders sparse
// indexed fields). Returns the outgoing request and its response.
async function submitNativeSave(page, url, entries) {
  await page.goto(url);
  const csrf = await page.locator('#release-assets-form input[name="_csrf"]').inputValue();
  const request = page.waitForRequest((req) => req.method() === 'POST');
  const response = page.waitForResponse((res) => res.request().method() === 'POST');
  await page.evaluate(({ csrf, entries }) => {
    const form = document.createElement('form');
    form.method = 'post';
    form.action = window.location.href;
    for (const [name, value] of [['_csrf', csrf], ...entries]) {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.value = value;
      form.append(input);
    }
    document.body.append(form);
    form.submit();
  }, { csrf, entries });
  return { request: await request, response: await response };
}

test('B-F2R4: a sparse keyed Save keeps each role/order on its original index', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createTwoMemberFixture('Sparse Keyed');
  const url = `${baseURL}/releases/${f.releaseId}/assets?selection=all&pageSize=10`;
  const [A, B] = [f.ids['01-image.txt'], f.ids['22-image.txt']];
  const entries = [
    ['selectedAssetIds', String(A)], ['selectedAssetIds', String(B)],
    ['roleAssetIds[0]', String(A)], ['roleAssetIds[1]', String(B)],
    ['roles[1]', 'preview'], ['sortOrder[1]', '19'],
  ];
  const { request, response } = await submitNativeSave(page, url, entries);
  // The browser sent exactly the sparse keyed fields.
  expect([...new URLSearchParams(request.postData())].filter(([name]) => name !== '_csrf')).toEqual(entries);
  expect(response.status()).toBe(302);
  await expect.poll(() => savedRows(f.releaseId)).toEqual([
    { asset_id: A, role: 'attachment', sort_order: 0 },
    { asset_id: B, role: 'preview', sort_order: 19 },
  ]);
  expect(pageErrors).toEqual([]);
});

test('B-F2R4: a rejected sparse keyed Save retries with its own associations; unchanged refused, corrected saved', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createTwoMemberFixture('Sparse Rejected');
  const url = `${baseURL}/releases/${f.releaseId}/assets?selection=all&pageSize=10`;
  const [A, B] = [f.ids['01-image.txt'], f.ids['22-image.txt']];
  const { response } = await submitNativeSave(page, url, [
    ['selectedAssetIds', String(A)], ['selectedAssetIds', String(B)],
    ['roleAssetIds[0]', String(A)], ['roleAssetIds[1]', String(B)],
    ['roles[1]', 'bogus'], ['sortOrder[1]', '19'],
  ]);
  expect(response.status()).toBe(422);
  await page.waitForLoadState('load');
  const alert = page.locator('[data-release-assets-selection-errors]');
  await expect(alert).toBeVisible();
  await expect(alert).toHaveAttribute('role', 'alert');
  await expect(alert).toContainText(`Asset ${B} has an invalid role "bogus".`);
  await expect(alert).not.toContainText(`Asset ${A} has an invalid role`);
  await expect(page.locator('[data-release-assets-save-recovery-unavailable]')).toHaveCount(0);
  // No index shift in the rendered retry payload: A keeps the defaults.
  const draft = [
    { assetId: A, role: 'attachment', sortOrder: 0 },
    { assetId: B, role: 'bogus', sortOrder: 19 },
  ];
  expectDraft(await formEntries(page), draft);
  expect(savedRows(f.releaseId)).toEqual(f.persisted);

  // Unchanged native retry: same payload, same refusal, no write.
  const posted = page.waitForRequest((request) => request.method() === 'POST');
  const again = page.waitForResponse((res) => res.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save asset selection' }).click();
  expectDraft([...new URLSearchParams((await posted).postData())], draft);
  expect((await again).status()).toBe(422);
  await page.waitForLoadState('load');
  await expect(page.locator('[data-release-assets-selection-errors]')).toContainText(`Asset ${B} has an invalid role "bogus".`);
  expectDraft(await formEntries(page), draft);
  expect(savedRows(f.releaseId)).toEqual(f.persisted);

  // Correct B's role in the carried draft and Save natively.
  const corrected = draft.map((entry) => (entry.role === 'bogus' ? { ...entry, role: 'preview' } : entry));
  await page.evaluate((value) => {
    document.querySelector('#release-assets-form input[name="roleOrder"]').value = value;
  }, JSON.stringify(corrected.map(({ assetId, role, sortOrder }) => [assetId, role, sortOrder])));
  expectDraft(await formEntries(page), corrected);
  const saved = page.waitForResponse((res) => res.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save asset selection' }).click();
  expect((await saved).status()).toBe(302);
  await expect.poll(() => savedRows(f.releaseId)).toEqual([
    { asset_id: A, role: 'attachment', sort_order: 0 },
    { asset_id: B, role: 'preview', sort_order: 19 },
  ]);
  expect(pageErrors).toEqual([]);
});

test('B-F2R4: a sparse role with no asset at its index fails closed, never shifted or saved', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createTwoMemberFixture('Sparse Orphan');
  const url = `${baseURL}/releases/${f.releaseId}/assets?selection=all&pageSize=10`;
  const [A, B] = [f.ids['01-image.txt'], f.ids['22-image.txt']];
  const { response } = await submitNativeSave(page, url, [
    ['selectedAssetIds', String(A)], ['selectedAssetIds', String(B)],
    ['roleAssetIds[0]', String(A)], ['roleAssetIds[2]', String(B)],
    ['roles[1]', 'primary'],
  ]);
  expect(response.status()).toBe(422);
  await page.waitForLoadState('load');
  await expect(page.getByText(FORMAT_ERROR, { exact: true })).toBeVisible();
  await expect(page.locator('[data-release-assets-save-recovery-unavailable]')).toBeVisible();
  await expect(page.locator('#release-assets-form')).toHaveCount(0);
  const forms = await allFormData(page);
  for (const form of forms) {
    expect(form.entries.filter(([name]) => /^(selectedAssetIds|roleOrder|roleAssetIds|roles|sortOrder)\b/.test(name))).toEqual([]);
  }
  expect(savedRows(f.releaseId)).toEqual(f.persisted);
});

// B-F2R5: Express's parser turns `selectedAssetIds[__proto__]=3` into an
// empty selection. A browser-originated Save carrying a malformed selected-ID
// name must be refused fail-closed, never saved as an empty membership, and
// no response in the chain may offer a Save that clears it.
test('B-F2R5: a native malformed selected-ID Save is refused and cannot be retried into an empty Save', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createTwoMemberFixture('Malformed Selected ID');
  const url = `${baseURL}/releases/${f.releaseId}/assets?selection=all&pageSize=10`;

  // POST 1: the exact reviewer field.
  const { request, response } = await submitNativeSave(page, url, [['selectedAssetIds[__proto__]', '3']]);
  expect(request.headers()['content-type']).toContain('application/x-www-form-urlencoded');
  expect(request.postData()).toMatch(/^_csrf=[^&]+&selectedAssetIds%5B__proto__%5D=3$/);
  expect([...new URLSearchParams(request.postData())].filter(([name]) => name !== '_csrf'))
    .toEqual([['selectedAssetIds[__proto__]', '3']]);
  expect(response.status()).toBe(422);
  await page.waitForLoadState('load');
  await expectFailClosed(page, FORMAT_ERROR, f);
  await expect(page.locator('.error-summary[role="alert"]')).toContainText(FORMAT_ERROR);
  expect(savedRows(f.releaseId)).toEqual(f.persisted);

  // The rejected page's every form, as the browser would submit it: nothing
  // that POSTs to Manage Assets and no membership field at all.
  for (const form of await allFormData(page)) {
    expect(form.entries.filter(([name]) => /selectedAssetIds|roleOrder|roleAssetIds|roles|sortOrder/.test(name))).toEqual([]);
  }

  // Browser fetch with the session cookie: FormData carrying the malformed
  // name (plus a valid neighbour) URL-encoded by the browser.
  const csrf = await page.evaluate(async (target) => {
    const html = await (await fetch(target)).text();
    return new DOMParser().parseFromString(html, 'text/html')
      .querySelector('#release-assets-form input[name="_csrf"]').value;
  }, url);
  for (const fields of [
    [['selectedAssetIds[__proto__]', '3']],
    [['selectedAssetIds[0]', String(f.ids['01-image.txt'])], ['selectedAssetIds[__proto__]', String(f.ids['05-image.txt'])]],
    [['selectedAssetIds[constructor]', '3']],
    [['selectedAssetIds[toString]', '3']],
  ]) {
    const result = await page.evaluate(async ({ target, csrf, fields }) => {
      const data = new FormData();
      data.append('_csrf', csrf);
      for (const [name, value] of fields) data.append(name, value);
      const body = new URLSearchParams(data);
      const res = await fetch(target, { method: 'POST', body, redirect: 'manual' });
      return { status: res.status, sent: body.toString(), text: await res.text() };
    }, { target: url, csrf, fields });
    expect(result.sent).toContain('selectedAssetIds%5B');
    expect(result.status, result.sent).toBe(422);
    expect(result.text).toContain('data-release-assets-save-recovery-unavailable');
    expect(result.text).not.toContain('id="release-assets-form"');
    expect(savedRows(f.releaseId), result.sent).toEqual(f.persisted);
  }

  // POST 2, the only Save the chain exposes: reload, Save unchanged.
  await reloadAndSaveUnchanged(page, f);
  await page.goto(url);
  expect(savedRows(f.releaseId)).toEqual(f.persisted);
  expect(pageErrors).toEqual([]);
});

test('B-F2R5 control: unchecking every asset on the real Save form still clears membership', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createTwoMemberFixture('Intentional Empty Save');
  await page.goto(`${baseURL}/releases/${f.releaseId}/assets?selection=all&pageSize=10`);
  for (const row of f.persisted) {
    await page.locator(`[data-release-assets-live-region] input[name="selectedAssetIds"][value="${row.asset_id}"]`).uncheck({ force: true });
  }
  const entries = await formEntries(page);
  expect(entries.filter(([name]) => name !== '_csrf')).toEqual([]);
  const posted = page.waitForRequest((req) => req.method() === 'POST');
  const saved = page.waitForResponse((res) => res.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save asset selection' }).click();
  expect((await posted).postData()).toMatch(/^_csrf=[^&]+$/);
  expect((await saved).status()).toBe(302);
  await page.waitForLoadState('load');
  expect(savedRows(f.releaseId)).toEqual([]);
  expect(pageErrors).toEqual([]);
});

// B-F2R6: Express's parser drops or relocates a field whose name is outside
// the Save contract (`__proto__[selectedAssetIds]`, `selectedAssetIds.__proto__`
// …), leaving no selectedAssetIds at all. A browser-originated Save carrying
// one must be refused fail-closed — never saved as an empty or partial
// membership — and the chain may only be resumed from a fresh reload.
test('B-F2R6: unsupported Save field names are refused from native, real-form and fetch POSTs', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createTwoMemberFixture('Unsupported Save Field');
  const url = `${baseURL}/releases/${f.releaseId}/assets?selection=all&pageSize=10`;
  const [A, B, C] = [f.ids['01-image.txt'], f.ids['05-image.txt'], f.ids['03-image.txt']];

  // A. Prototype-root field from a native document POST (no selected IDs).
  const native = await submitNativeSave(page, url, [['__proto__[selectedAssetIds]', '1']]);
  expect(native.request.headers()['content-type']).toContain('application/x-www-form-urlencoded');
  expect(native.request.postData()).toMatch(/^_csrf=[^&]+&__proto__%5BselectedAssetIds%5D=1$/);
  expect([...new URLSearchParams(native.request.postData())].filter(([name]) => name !== '_csrf'))
    .toEqual([['__proto__[selectedAssetIds]', '1']]);
  expect(native.response.status()).toBe(422);
  await page.waitForLoadState('load');
  await expectFailClosed(page, FORMAT_ERROR, f);
  expect(savedRows(f.releaseId)).toEqual(f.persisted);

  // B + C. Dotted alias added to the REAL Save form, which still carries the
  // checked A and B: mixed valid and malformed fields.
  await page.goto(url);
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = 'selectedAssetIds.__proto__';
    input.value = '1';
    document.getElementById('release-assets-form').append(input);
  });
  const realEntries = await formEntries(page);
  expect(sortedIds(realEntries.filter(([name]) => name === 'selectedAssetIds').map(([, value]) => Number(value))))
    .toEqual(sortedIds([A, B]));
  expect(realEntries).toContainEqual(['selectedAssetIds.__proto__', '1']);
  const realRequest = page.waitForRequest((req) => req.method() === 'POST');
  const realResponse = page.waitForResponse((res) => res.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save asset selection' }).click();
  const sent = [...new URLSearchParams((await realRequest).postData())];
  expect(sent).toEqual(realEntries);
  expect((await realResponse).status()).toBe(422);
  await page.waitForLoadState('load');
  await expectFailClosed(page, FORMAT_ERROR, f);
  expect(savedRows(f.releaseId)).toEqual(f.persisted);

  // Browser fetches with the session cookie: FormData-encoded and exact raw
  // bodies (percent-encoded dot, unknown fields, both orders, repeated).
  const csrf = await page.evaluate(async (target) => {
    const html = await (await fetch(target)).text();
    return new DOMParser().parseFromString(html, 'text/html')
      .querySelector('#release-assets-form input[name="_csrf"]').value;
  }, url);
  const roleOrder = encodeURIComponent(JSON.stringify([[A, 'primary', 0], [B, 'preview', 1]]));
  for (const tail of [
    '__proto__%5BselectedAssetIds%5D=1',
    'constructor%5BselectedAssetIds%5D=1',
    'selectedAssetIds.__proto__=1',
    'selectedAssetIds%2E__proto__=1',
    'unknownField=1',
    `selectedAssetIds=${A}&selectedAssetIds=${C}&selectedAssetIds%2E__proto__=1`,
    `selectedAssetIds%2E__proto__=1&selectedAssetIds=${A}&selectedAssetIds=${C}`,
    `selectedAssetIds=${A}&selectedAssetIds=${B}&roleOrder=${roleOrder}&__proto__%5BselectedAssetIds%5D=1`,
    `roleAssetIds%5B0%5D=${A}&roles%5B0%5D=preview&__proto__%5BselectedAssetIds%5D=1`,
    '__proto__%5BselectedAssetIds%5D=1',
  ]) {
    const result = await page.evaluate(async ({ target, body }) => {
      const res = await fetch(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        redirect: 'manual',
      });
      return { status: res.status, text: await res.text() };
    }, { target: url, body: `_csrf=${encodeURIComponent(csrf)}&${tail}` });
    expect(result.status, tail).toBe(422);
    expect(result.text, tail).toContain(FORMAT_ERROR);
    expect(result.text, tail).toContain('data-release-assets-save-recovery-unavailable');
    expect(result.text, tail).not.toContain('id="release-assets-form"');
    expect(result.text, tail).not.toContain('name="selectedAssetIds"');
    expect(result.text, tail).not.toContain('foreign-secret');
    expect(savedRows(f.releaseId), tail).toEqual(f.persisted);
  }

  // Resume only from a fresh reload: A and B still selected, Save unchanged.
  await page.goto(url);
  await expect(page.locator(`[data-release-assets-live-region] input[name="selectedAssetIds"][value="${A}"]`)).toBeChecked();
  await expect(page.locator(`[data-release-assets-live-region] input[name="selectedAssetIds"][value="${B}"]`)).toBeChecked();
  await submitNativeSave(page, url, [['__proto__[selectedAssetIds]', '1']]).then(({ response }) => expect(response.status()).toBe(422));
  await page.waitForLoadState('load');
  await reloadAndSaveUnchanged(page, f);
  expect(savedRows(f.releaseId)).toEqual(f.persisted);
  expect(pageErrors).toEqual([]);
});

// B-F2R7: the Save form posts application/x-www-form-urlencoded. A
// browser-originated Save with any other media type — JSON (which the
// application parser also reads), text/plain, octet-stream or multipart (which
// leave the parsed body empty) — is refused with 415 before the draft is read,
// even with a valid CSRF token, and never replaces membership. The rendered
// form, a URL-encoded fetch with the browser's charset, and an intentional
// empty Save still work.
test('B-F2R7: unsupported Save media types are refused from browser fetches; the real form and empty Save still work', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const posts = [];
  page.on('request', (req) => {
    if (req.method() === 'POST') posts.push({ contentType: req.headers()['content-type'], body: req.postDataBuffer()?.toString('utf8') ?? null });
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createTwoMemberFixture('Unsupported Save Media Type');
  const url = `${baseURL}/releases/${f.releaseId}/assets?selection=all&pageSize=10`;
  const [A, B, C] = [f.ids['01-image.txt'], f.ids['05-image.txt'], f.ids['03-image.txt']];
  await page.goto(url);
  const csrf = await page.locator('#release-assets-form input[name="_csrf"]').inputValue();

  const send = (request) => page.evaluate(async ({ target, request }) => {
    let body = request.body;
    // Bytes with an explicit type (Chromium does not report Blob bodies to request events).
    if (request.kind === 'blob') body = new TextEncoder().encode(request.body);
    if (request.kind === 'formdata') {
      body = new FormData();
      for (const [name, value] of request.body) body.append(name, value);
    }
    const res = await fetch(target, { method: 'POST', headers: request.headers, body, redirect: 'manual' });
    return { status: res.status, text: await res.text() };
  }, { target: url, request });

  const roleOrder = JSON.stringify([[A, 'primary', 0], [C, 'preview', 1]]);
  const cases = [
    ['json unknown, token in body', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ _csrf: csrf, unknown: 1 }) }, 'application/json'],
    ['json partial, token in body', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ _csrf: csrf, selectedAssetIds: [A, C], unknown: 1 }) }, 'application/json'],
    ['json selected, header token', { headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-CSRF-Token': csrf }, body: JSON.stringify({ selectedAssetIds: [A, B] }) }, 'application/json; charset=utf-8'],
    ['json empty, header token', { headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ selectedAssetIds: [] }) }, 'application/json'],
    ['json compact, header token', { headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ selectedAssetIds: [A, C], roleOrder }) }, 'application/json'],
    ['text/plain string', { headers: { 'X-CSRF-Token': csrf }, body: `selectedAssetIds=${C}` }, 'text/plain;charset=UTF-8'],
    ['text/plain explicit', { headers: { 'Content-Type': 'text/plain', 'X-CSRF-Token': csrf }, body: 'selectedAssetIds=3' }, 'text/plain'],
    ['octet-stream bytes', { kind: 'blob', headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': csrf }, body: 'selectedAssetIds=3' }, 'application/octet-stream'],
    ['multipart FormData', { kind: 'formdata', headers: { 'X-CSRF-Token': csrf }, body: [['_csrf', csrf], ['selectedAssetIds', String(A)]] }, /^multipart\/form-data; boundary=/],
    ['look-alike type', { headers: { 'Content-Type': 'application/x-www-form-urlencodedx', 'X-CSRF-Token': csrf }, body: `_csrf=${encodeURIComponent(csrf)}&selectedAssetIds=${A}` }, 'application/x-www-form-urlencodedx'],
  ];
  for (const [label, request, expectedType] of cases) {
    posts.length = 0;
    const result = await send(request);
    // The outgoing request as Chromium actually sent it.
    expect(posts, label).toHaveLength(1);
    if (expectedType instanceof RegExp) expect(posts[0].contentType, label).toMatch(expectedType);
    else expect(posts[0].contentType, label).toBe(expectedType);
    if (request.kind === 'formdata') expect(posts[0].body, label).toContain('name="selectedAssetIds"');
    else expect(posts[0].body, label).toBe(request.body);
    expect(savedRows(f.releaseId), label).toEqual(f.persisted);
    expect(result.status, label).toBe(415);
    expect(result.text, label).toContain('Unsupported asset selection request format.');
    expect(result.text, label).not.toContain('id="release-assets-form"');
    expect(result.text, label).not.toContain('name="selectedAssetIds"');
    expect(result.text, label).not.toContain('foreign-secret');
  }

  // Authorization controls: a forged or missing token is still 403.
  for (const [label, request] of [
    ['json forged header', { headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'forged' }, body: JSON.stringify({ selectedAssetIds: [A] }) }],
    ['text/plain no token', { headers: { 'Content-Type': 'text/plain' }, body: `_csrf=${csrf}&selectedAssetIds=3` }],
    ['octet-stream forged', { kind: 'blob', headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': 'forged' }, body: 'selectedAssetIds=3' }],
  ]) {
    const result = await send(request);
    expect(result.status, label).toBe(403);
    expect(savedRows(f.releaseId), label).toEqual(f.persisted);
  }

  // The page is still the editable saved collection: reload and Save the real
  // form unchanged. Chromium posts it URL-encoded.
  await page.goto(url);
  await expect(page.locator(`[data-release-assets-live-region] input[name="selectedAssetIds"][value="${A}"]`)).toBeChecked();
  await expect(page.locator(`[data-release-assets-live-region] input[name="selectedAssetIds"][value="${B}"]`)).toBeChecked();
  posts.length = 0;
  const saved = page.waitForResponse((res) => res.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save asset selection' }).click();
  expect((await saved).status()).toBe(302);
  await page.waitForLoadState('load');
  expect(posts[0].contentType).toBe('application/x-www-form-urlencoded');
  expect(sortedIds([...new URLSearchParams(posts[0].body)].filter(([name]) => name === 'selectedAssetIds').map(([, value]) => Number(value))))
    .toEqual(sortedIds([A, B]));
  expect(savedRows(f.releaseId)).toEqual(f.persisted);

  // A URL-encoded fetch with Chromium's ;charset=UTF-8 parameter still saves.
  posts.length = 0;
  const charsetResponse = page.waitForResponse((res) => res.request().method() === 'POST');
  const charsetResult = await send({
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: new URLSearchParams([['_csrf', csrf], ['selectedAssetIds', String(A)], ['selectedAssetIds', String(B)]]).toString(),
  });
  expect(charsetResult.status).toBe(0); // opaque redirect
  expect((await charsetResponse).status()).toBe(302);
  expect(posts[0].contentType).toBe('application/x-www-form-urlencoded;charset=UTF-8');
  expect(savedRows(f.releaseId)).toEqual(f.persisted);

  // An intentional empty Save from the real form still clears membership.
  await page.goto(url);
  for (const row of f.persisted) {
    await page.locator(`[data-release-assets-live-region] input[name="selectedAssetIds"][value="${row.asset_id}"]`).uncheck({ force: true });
  }
  posts.length = 0;
  const cleared = page.waitForResponse((res) => res.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save asset selection' }).click();
  expect((await cleared).status()).toBe(302);
  await page.waitForLoadState('load');
  expect(posts[0].contentType).toBe('application/x-www-form-urlencoded');
  expect(posts[0].body).toMatch(/^_csrf=[^&]+$/);
  expect(savedRows(f.releaseId)).toEqual([]);
  expect(pageErrors).toEqual([]);
});

// B7-F1: records every POST a page starts itself — a fetch (the per-asset
// Role autosubmit path) or a form submission — synchronously, so "no role
// POST" needs no waiting. Installed before each document in the context.
async function recordPagePosts(page) {
  await page.addInitScript(() => {
    window.__pagePosts = [];
    const originalFetch = window.fetch;
    window.fetch = function recordingFetch(input, init) {
      if (String(init?.method || 'GET').toUpperCase() === 'POST') {
        window.__pagePosts.push(`fetch ${new URL(String(input?.url ?? input), window.location.href).pathname}`);
      }
      return originalFetch.apply(this, arguments);
    };
    document.addEventListener('submit', (event) => {
      window.__pagePosts.push(`submit ${new URL(event.target.action, window.location.href).pathname}`);
    }, true);
  });
}
const pagePosts = (page) => page.evaluate(() => window.__pagePosts);

const roleSummary = (page, assetId) => page.locator(`#release-asset-role-${assetId} [data-cc-dropdown-summary-current]`);
const roleField = (page, assetId) => page.locator('.release-asset-role-field', { has: page.locator(`#release-asset-role-${assetId}`) });

async function chooseRole(page, assetId, label) {
  const dropdown = page.locator(`#release-asset-role-${assetId}`);
  await dropdown.locator('summary').click();
  await dropdown.locator('.asset-filter-multiselect-panel').getByText(label, { exact: true }).click();
  await expect(roleSummary(page, assetId)).toHaveText(label);
}

test('B7-F1: a rejected invalid draft role is corrected through its Role dropdown, without any role POST, then saved', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  await recordPagePosts(page);
  const f = await createFixture('Role Correction');
  const id = (name) => f.ids[name];
  const url = `${baseURL}/releases/${f.releaseId}/assets?selection=all&pageSize=10`;
  const rowsBefore = savedRows(f.releaseId);
  // 03 is a newly selected visible asset with an invalid role; 02 is the
  // saved missing Preview; 20 a saved off-page member; 22 a newly selected
  // off-page member; saved 21 is removed by the draft.
  const draft = [
    { assetId: id('01-image.txt'), role: 'primary', sortOrder: 0 },
    { assetId: id('03-image.txt'), role: 'bogus', sortOrder: 1 },
    { assetId: id('02-image.txt'), role: 'preview', sortOrder: 2 },
    { assetId: id('20-image.txt'), role: 'attachment', sortOrder: 3 },
    { assetId: id('22-image.txt'), role: 'attachment', sortOrder: 4 },
  ];
  const corrected = draft.map((entry) => (entry.role === 'bogus' ? { ...entry, role: 'attachment' } : entry));

  const rejected = await submitLegacySave(page, url, draft);
  expect(rejected.status()).toBe(422);
  // The server-rendered (pre-script) Role controls: draft-only, the invalid
  // role on its correction prompt rather than coerced to a valid role.
  const html = await rejected.text();
  const nativeRole = (assetId) => new RegExp(`<select id="role-${assetId}"[^>]*>[\\s\\S]*?</select>`).exec(html)?.[0] ?? '';
  expect(nativeRole(id('03-image.txt'))).toMatch(/aria-invalid="true"/);
  expect(nativeRole(id('03-image.txt'))).toMatch(/<option value="" selected>Select a valid role<\/option>/);
  expect(nativeRole(id('03-image.txt'))).not.toMatch(/<option value="(primary|preview|attachment)"[^>]* selected/);
  expect(nativeRole(id('01-image.txt'))).toMatch(/<option value="primary" selected>/);
  expect(nativeRole(id('01-image.txt'))).not.toMatch(/aria-invalid/);
  expect(html).not.toMatch(/data-autosubmit[^>]*>\s*<option value="primary"/);
  expect(html).not.toMatch(/action="[^"]*\/role"/);
  await page.waitForLoadState('load');
  await expect(page.locator('[data-release-assets-selection-errors]'))
    .toContainText(`Asset ${id('03-image.txt')} has an invalid role "bogus".`);
  expect(savedRows(f.releaseId)).toEqual(rowsBefore);
  expectDraft(await formEntries(page), draft);
  const posts = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') posts.push(new URL(request.url()).pathname);
  });

  // The invalid role visibly needs correction; valid draft roles show as such.
  const invalid = id('03-image.txt');
  await expect(roleSummary(page, invalid)).toHaveText('Select a valid role');
  await expect(roleField(page, invalid)).toHaveClass(/\bfield-error\b/);
  await expect(page.locator(`#role-${invalid}`)).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator(`#role-${invalid}`)).toHaveValue('');
  await expect(roleSummary(page, id('01-image.txt'))).toHaveText('Primary');
  await expect(roleField(page, id('01-image.txt'))).not.toHaveClass(/\bfield-error\b/);
  // No Role control is a per-asset role form or autosubmits.
  await expect(page.locator('form[action*="/role"]')).toHaveCount(0);
  await expect(page.locator('select[name="role"][data-autosubmit]')).toHaveCount(0);

  // The real dropdown edits only that asset's carried role.
  await chooseRole(page, invalid, 'Attachment');
  await expect(page.locator(`#role-${invalid}`)).toHaveValue('attachment');
  await expect(page.locator(`#role-${invalid}`)).not.toHaveAttribute('aria-invalid', /.*/);
  await expect(roleField(page, invalid)).not.toHaveClass(/\bfield-error\b/);
  expect(await pagePosts(page)).toEqual([]);
  expectDraft(await formEntries(page), corrected);
  expect(savedRows(f.releaseId)).toEqual(rowsBefore);

  // Page, return and switch to List: saved members' installed role forms
  // become draft controls showing the carried role, and the draft holds.
  const region = page.locator('[data-release-assets-live-region]');
  await region.locator('.pagination-next').click();
  await settled(page);
  await expect(page.locator('.pagination-info')).toHaveText('Page 2 of 3');
  expectDraft(await formEntries(page), corrected);
  await page.goBack();
  await settled(page);
  await expect(page.locator('.pagination-info')).toHaveText('Page 1 of 3');
  await page.locator('nav.view-switcher a[href*="view=list"]').first().click();
  await settled(page);
  await expect(region.locator('.asset-list')).toHaveCount(1);
  expectDraft(await formEntries(page), corrected);
  const saved01 = id('01-image.txt');
  await expect(page.locator('select[name="role"][data-autosubmit]')).toHaveCount(0);
  await expect(page.locator(`#role-${saved01}`)).toHaveAttribute('data-release-asset-draft-role-select', String(saved01));
  await expect(roleSummary(page, saved01)).toHaveText('Primary');
  // An installed (converted) control also edits only the draft.
  await chooseRole(page, saved01, 'Preview');
  expectDraft(await formEntries(page), corrected.map((entry) => (
    entry.assetId === saved01 ? { ...entry, role: 'preview' } : entry)));
  await chooseRole(page, saved01, 'Primary');
  expectDraft(await formEntries(page), corrected);
  expect(await pagePosts(page)).toEqual([]);
  expect(posts).toEqual([]);
  expect(savedRows(f.releaseId)).toEqual(rowsBefore);

  // Only the visible Save persists the corrected draft.
  const posted = page.waitForRequest((request) => request.method() === 'POST');
  const response = page.waitForResponse((res) => res.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save asset selection' }).click();
  const body = [...new URLSearchParams((await posted).postData())];
  expectDraft(body, corrected);
  expect(body.filter(([name]) => name === '_csrf')).toHaveLength(1);
  const result = await response;
  expect(result.status()).toBe(302);
  expect(result.headers().location).toMatch(new RegExp(`^/releases/${f.releaseId}\\?assetsSaved=`));
  expect(posts).toEqual([`/releases/${f.releaseId}/assets`]);
  await expect.poll(() => savedRows(f.releaseId)).toEqual(
    corrected.map(({ assetId, role, sortOrder }) => ({ asset_id: assetId, role, sort_order: sortOrder })),
  );

  // B3-F2's confirmation, once, on Release Detail.
  await expect(page).toHaveURL(new RegExp(`/releases/${f.releaseId}(\\?|$)`));
  await expect(page.locator('[data-release-assets-saved]')).toHaveText('Assets saved successfully.');

  // Reopened, Manage Assets is a normal page with the saved roles.
  await page.goto(url);
  await expect(page.locator('[data-release-assets-submitted-role-order]')).toHaveCount(0);
  await expect(roleSummary(page, invalid)).toHaveText('Attachment');
  await expect(roleSummary(page, saved01)).toHaveText('Primary');
  await expect(page.locator(`form[action*="/assets/${invalid}/role"] select[data-autosubmit]`)).toHaveCount(1);
  await expect(page.locator('.release-asset-role-field.field-error')).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test('B7-F1 control: normal Manage Assets Role controls still persist immediately in Selected and All modes', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  await recordPagePosts(page);
  const f = await createTwoMemberFixture('Normal Roles');
  const posts = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') posts.push({ path: new URL(request.url()).pathname, body: request.postData() });
  });
  const role = (assetId) => db.prepare('SELECT role FROM release_assets WHERE release_id = ? AND asset_id = ?')
    .get(f.releaseId, assetId).role;

  for (const [query, assetId, label] of [
    ['pageSize=10', f.ids['05-image.txt'], 'Attachment'],
    ['selection=all&pageSize=10', f.ids['01-image.txt'], 'Preview'],
  ]) {
    const before = posts.length;
    await page.goto(`${baseURL}/releases/${f.releaseId}/assets?${query}`);
    await expect(page.locator('[data-release-assets-submitted-role-order]')).toHaveCount(0);
    await expect(page.locator('[data-release-asset-draft-role-select]')).toHaveCount(0);
    await expect(page.locator(`form[action*="/assets/${assetId}/role"] select[data-autosubmit]`)).toHaveCount(1);
    const saveForm = await formEntries(page);
    await chooseRole(page, assetId, label);
    await expect.poll(() => posts.length).toBe(before + 1);
    expect(posts[before].path).toBe(`/releases/${f.releaseId}/assets/${assetId}/role`);
    expect(new URLSearchParams(posts[before].body).get('role')).toBe(label.toLowerCase());
    await expect.poll(() => role(assetId)).toBe(label.toLowerCase());
    expect(await pagePosts(page)).toEqual([`fetch /releases/${f.releaseId}/assets/${assetId}/role`]);
    // The Save form's draft is untouched and no Save confirmation appears.
    expect(await formEntries(page)).toEqual(saveForm);
    await expect(page.locator('[data-release-assets-saved]')).toHaveCount(0);
  }
  expect(posts).toHaveLength(2);
  expect(pageErrors).toEqual([]);
});

// B7-F2: a live GET renders Role controls only for saved members, so after
// navigation a newly selected draft member (03, never saved) has its Role
// control restored from the recovery template, keyed by asset ID, showing the
// carried draft role, in the Grid top row or the List Role column.
const draftCard = (page, view, assetId) => page.locator(
  `[data-release-assets-live-region] article.${view === 'list' ? 'asset-list-card' : 'asset-card'}[data-asset-id="${assetId}"]`,
);

// Exactly one visible, labelled, draft-only Role control in the right place,
// inside its card's box and level with the saved member's server-rendered one.
async function expectDraftRoleControl(page, view, assetId, filename, summaryText, referenceAssetId) {
  const card = draftCard(page, view, assetId);
  await expect(card.locator('input.asset-select-checkbox')).toBeChecked();
  await expect(card.locator('select[name="role"]')).toHaveCount(1);
  await expect(card.locator('.release-asset-role-form')).toHaveCount(1);
  const slot = view === 'list' ? '.asset-list-cell--role' : '.asset-card-top > .release-asset-grid-role';
  const dropdown = card.locator(`${slot} #release-asset-role-${assetId}`);
  await expect(dropdown).toBeVisible();
  await expect(page.locator(`#role-${assetId}`)).toHaveAttribute('data-release-asset-draft-role-select', String(assetId));
  await expect(page.locator(`#role-${assetId}`)).not.toHaveAttribute('data-autosubmit', /.*/);
  await expect(page.locator(`#role-${assetId}`)).toHaveAttribute('aria-label', `Role for ${filename}`);
  await expect(card.locator('form')).toHaveCount(0);
  await expect(dropdown.locator('summary')).toHaveAttribute('aria-label', `Role for ${filename}: ${summaryText}`);
  await expect(roleSummary(page, assetId)).toHaveText(summaryText);
  const cardBox = await card.boundingBox();
  const box = await dropdown.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(cardBox.x - 1);
  expect(box.x + box.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1);
  expect(box.y).toBeGreaterThanOrEqual(cardBox.y - 1);
  expect(box.y + box.height).toBeLessThanOrEqual(cardBox.y + cardBox.height + 1);
  if (referenceAssetId) {
    const reference = draftCard(page, view, referenceAssetId);
    const referenceCardBox = await reference.boundingBox();
    const referenceBox = await reference.locator(`#release-asset-role-${referenceAssetId}`).boundingBox();
    // Same column/row position as the server-rendered control.
    expect(Math.abs((box.x - cardBox.x) - (referenceBox.x - referenceCardBox.x))).toBeLessThanOrEqual(2);
    expect(Math.abs((box.y - cardBox.y) - (referenceBox.y - referenceCardBox.y))).toBeLessThanOrEqual(2);
  }
}

async function rejectNewMemberRole(page, title, view) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await recordPagePosts(page);
  const f = await createFixture(title);
  const id = (name) => f.ids[name];
  const url = `${baseURL}/releases/${f.releaseId}/assets?selection=all&pageSize=10${view === 'list' ? '&view=list' : ''}`;
  const rowsBefore = savedRows(f.releaseId);
  // 03 is newly selected and visible on page 1 with an invalid role; 22 is a
  // newly selected off-page member; saved 21 is removed by the draft.
  const draft = [
    { assetId: id('01-image.txt'), role: 'primary', sortOrder: 0 },
    { assetId: id('03-image.txt'), role: 'bogus', sortOrder: 1 },
    { assetId: id('02-image.txt'), role: 'preview', sortOrder: 2 },
    { assetId: id('20-image.txt'), role: 'attachment', sortOrder: 3 },
    { assetId: id('22-image.txt'), role: 'attachment', sortOrder: 4 },
  ];
  const rejected = await submitLegacySave(page, url, draft);
  expect(rejected.status()).toBe(422);
  await page.waitForLoadState('load');
  await expect(page.locator('[data-release-assets-selection-errors]'))
    .toContainText(`Asset ${id('03-image.txt')} has an invalid role "bogus".`);
  expect(savedRows(f.releaseId)).toEqual(rowsBefore);
  expectDraft(await formEntries(page), draft);
  return { f, id, draft, rowsBefore };
}

async function navigateAwayAndBack(page) {
  const region = page.locator('[data-release-assets-live-region]');
  await region.locator('.pagination-next').click();
  await settled(page);
  await expect(page.locator('.pagination-info')).toHaveText('Page 2 of 3');
  await page.goBack();
  await settled(page);
  await expect(page.locator('.pagination-info')).toHaveText('Page 1 of 3');
}

async function switchView(page, view) {
  await page.locator('nav.view-switcher').first().getByRole('link', { name: `${view === 'list' ? 'List' : 'Grid'} view` }).click();
  await settled(page);
  await expect(page.locator('[data-release-assets-live-region]').locator(view === 'list' ? '.asset-list' : '.asset-grid')).toHaveCount(1);
}

async function saveAndExpectRows(page, f, draft, posts) {
  const posted = page.waitForRequest((request) => request.method() === 'POST');
  const response = page.waitForResponse((res) => res.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save asset selection' }).click();
  const body = [...new URLSearchParams((await posted).postData())];
  expectDraft(body, draft);
  expect(body.filter(([name]) => name === '_csrf')).toHaveLength(1);
  const result = await response;
  expect(result.status()).toBe(302);
  expect(result.headers().location).toMatch(new RegExp(`^/releases/${f.releaseId}\\?assetsSaved=`));
  expect(posts).toEqual([`/releases/${f.releaseId}/assets`]);
  await expect.poll(() => savedRows(f.releaseId)).toEqual(
    draft.map(({ assetId, role, sortOrder }) => ({ asset_id: assetId, role, sort_order: sortOrder })),
  );
  await expect(page).toHaveURL(new RegExp(`/releases/${f.releaseId}(\\?|$)`));
  await expect(page.locator('[data-release-assets-saved]')).toHaveText('Assets saved successfully.');
}

test('B7-F2: a new draft member\'s invalid Role control returns after navigation, is corrected without a role POST, then saved', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const { f, id, draft, rowsBefore } = await rejectNewMemberRole(page, 'Navigation Role', 'grid');
  const posts = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') posts.push(new URL(request.url()).pathname);
  });
  const added = id('03-image.txt');
  const saved01 = id('01-image.txt');
  // The 422 page rendered 03's editor itself.
  await expect(draftCard(page, 'grid', added).locator('select[name="role"]')).toHaveCount(1);

  // Grid -> page 2 -> Grid: the GET knows only saved membership, yet 03 is
  // still selected and has its invalid draft editor back.
  await navigateAwayAndBack(page);
  expectDraft(await formEntries(page), draft);
  await expectDraftRoleControl(page, 'grid', added, '03-image.txt', 'Select a valid role', saved01);
  await expect(roleField(page, added)).toHaveClass(/\bfield-error\b/);
  await expect(page.locator(`#role-${added}`)).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator(`#role-${added}`)).toHaveValue('');
  // An unselected visible candidate has no Role editor.
  await expect(draftCard(page, 'grid', id('04-image.txt')).locator('.release-asset-role-form')).toHaveCount(0);
  expect(savedRows(f.releaseId)).toEqual(rowsBefore);

  await chooseRole(page, added, 'Attachment');
  await expect(page.locator(`#role-${added}`)).toHaveValue('attachment');
  await expect(page.locator(`#role-${added}`)).not.toHaveAttribute('aria-invalid', /.*/);
  await expect(roleField(page, added)).not.toHaveClass(/\bfield-error\b/);
  const corrected = draft.map((entry) => (entry.assetId === added ? { ...entry, role: 'attachment' } : entry));
  expectDraft(await formEntries(page), corrected);
  expect(await pagePosts(page)).toEqual([]);
  expect(posts).toEqual([]);
  expect(savedRows(f.releaseId)).toEqual(rowsBefore);

  // Grid -> page 2 -> List: the correction holds and stays editable.
  await page.locator('[data-release-assets-live-region] .pagination-next').click();
  await settled(page);
  await switchView(page, 'list');
  await expect(page.locator('.pagination-info')).toHaveText('Page 1 of 3');
  await expectDraftRoleControl(page, 'list', added, '03-image.txt', 'Attachment', saved01);
  await expect(roleField(page, added)).not.toHaveClass(/\bfield-error\b/);
  await chooseRole(page, added, 'Preview');
  expectDraft(await formEntries(page), corrected.map((entry) => (entry.assetId === added ? { ...entry, role: 'preview' } : entry)));
  await chooseRole(page, added, 'Attachment');
  expectDraft(await formEntries(page), corrected);
  // Repeated region loads never duplicate it.
  await navigateAwayAndBack(page);
  await expectDraftRoleControl(page, 'list', added, '03-image.txt', 'Attachment', saved01);
  await expect(page.locator('select[name="role"][data-autosubmit]')).toHaveCount(0);
  expect(await pagePosts(page)).toEqual([]);
  expect(posts).toEqual([]);
  expect(savedRows(f.releaseId)).toEqual(rowsBefore);

  await saveAndExpectRows(page, f, corrected, posts);
  expect(pageErrors).toEqual([]);
});

test('B7-F2: a draft role corrected before navigation stays visible and revisable in List and Grid, then saves', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const { f, id, draft, rowsBefore } = await rejectNewMemberRole(page, 'Corrected Role', 'list');
  const posts = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') posts.push(new URL(request.url()).pathname);
  });
  const added = id('03-image.txt');
  const saved01 = id('01-image.txt');
  const withRole = (role) => draft.map((entry) => (entry.assetId === added ? { ...entry, role } : entry));

  // Corrected on the 422 page's own (server-rendered) List control.
  await expect(page.locator('[data-release-assets-live-region] .asset-list')).toHaveCount(1);
  await expect(roleSummary(page, added)).toHaveText('Select a valid role');
  await chooseRole(page, added, 'Attachment');
  expectDraft(await formEntries(page), withRole('attachment'));

  // List -> page 2 -> List.
  await navigateAwayAndBack(page);
  await expectDraftRoleControl(page, 'list', added, '03-image.txt', 'Attachment', saved01);
  await expect(page.locator(`#role-${added}`)).not.toHaveAttribute('aria-invalid', /.*/);
  await chooseRole(page, added, 'Preview');
  await expect(page.locator(`#role-${added}`)).toHaveValue('preview');
  expectDraft(await formEntries(page), withRole('preview'));
  expect(await pagePosts(page)).toEqual([]);

  // List -> page 2 -> Grid.
  await page.locator('[data-release-assets-live-region] .pagination-next').click();
  await settled(page);
  await switchView(page, 'grid');
  await expect(page.locator('.pagination-info')).toHaveText('Page 1 of 3');
  await expectDraftRoleControl(page, 'grid', added, '03-image.txt', 'Preview', saved01);
  // Grid -> page 2 -> Grid, still one control and the same draft entry.
  await navigateAwayAndBack(page);
  await expectDraftRoleControl(page, 'grid', added, '03-image.txt', 'Preview', saved01);
  expectDraft(await formEntries(page), withRole('preview'));
  expect(await pagePosts(page)).toEqual([]);
  expect(posts).toEqual([]);
  expect(savedRows(f.releaseId)).toEqual(rowsBefore);

  await saveAndExpectRows(page, f, withRole('preview'), posts);
  expect(pageErrors).toEqual([]);
});
