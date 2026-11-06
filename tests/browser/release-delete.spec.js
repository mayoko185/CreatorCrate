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
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';

// WP11B-2: Delete release from the Edit Release dialog on its real hosts
// (Release Detail, Dashboard, Calendar) in real Chromium with the compiled
// client, the real route, templates, service and an isolated SQLite database.
// Every test records the Delete POSTs, Archive POSTs, Edit Save POSTs, Publish
// POSTs, read-only GETs, the database, document identity and URL. The release
// service is not exposed on app.locals, so its executions are counted by the
// Delete requests that reached the app (behind the upstream gate) and by its
// own release.deleted activity rows. All data lives in a temporary root
// removed afterward; the app listens on its own temporary port.

const DELETE_PATH = /^\/releases\/\d+\/delete$/;
const ARCHIVE_PATH = /^\/releases\/\d+\/archive$/;
const SAVE_PATH = /^\/releases\/\d+$/;
const PUBLISH_PATH = /^\/releases\/\d+\/publish$/;
let server;
let proxy;
let db;
let app;
let root;
let baseURL;
let fixtures = 0;

// An upstream gate between the browser and the app: a Delete POST that
// reaches it has fully arrived, but the route and service have not run until
// the gate releases it. holdNext holds that many next arrivals; forwarded
// counts the Delete requests the app actually received.
const gate = {
  holdNext: 0,
  arrivals: 0,
  forwarded: 0,
  held: [],
  release() { this.held.splice(0).forEach((forward) => forward()); },
};

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-release-delete-'));
  const projectsRoot = path.join(root, 'projects');
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
      if (req.method === 'POST' && DELETE_PATH.test(new URL(req.url, 'http://gate').pathname)) {
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

function createProject(prefix) {
  fixtures += 1;
  return app.locals.projectService.create({
    title: `${prefix} Project ${String(fixtures).padStart(3, '0')}`,
    description: '',
    notes: '',
    status: 'in-progress',
  });
}

function insertAsset(projectId, filename) {
  return Number(db.prepare(`INSERT INTO assets (project_id, filename, relative_path)
    VALUES (?, ?, ?)`).run(projectId, filename, filename).lastInsertRowid);
}

function createRelease(projectId, prefix, { plannedDate = null, publishedDate = null, title = null, assets = [] } = {}) {
  fixtures += 1;
  const releaseTitle = title || `${prefix} Release ${String(fixtures).padStart(3, '0')}`;
  const id = db.prepare(`
    INSERT INTO releases (project_id, title, description, notes, planned_date, published_date, patreon_url)
    VALUES (?, ?, 'Saved description', 'Saved notes', ?, ?, NULL) RETURNING id
  `).get(projectId, releaseTitle, plannedDate, publishedDate).id;
  assets.forEach((assetId, index) => {
    db.prepare(`INSERT INTO release_assets (release_id, asset_id, role, sort_order)
      VALUES (?, ?, 'attachment', ?)`).run(id, assetId, index);
  });
  return {
    id,
    title: releaseTitle,
    row: () => db.prepare('SELECT * FROM releases WHERE id = ?').get(id),
    exists: () => Boolean(db.prepare('SELECT id FROM releases WHERE id = ?').get(id)),
    archived: () => db.prepare('SELECT archived_at FROM releases WHERE id = ?').get(id)?.archived_at != null,
    assetRows: () => db.prepare('SELECT asset_id FROM release_assets WHERE release_id = ?').all(id),
    deleteLogs: () => db.prepare(
      "SELECT context_json FROM application_logs WHERE event = 'release.deleted'",
    ).all().filter((row) => JSON.parse(row.context_json || '{}').releaseId === id).length,
    archiveLogs: () => db.prepare(
      "SELECT context_json FROM application_logs WHERE event = 'release.archived'",
    ).all().filter((row) => JSON.parse(row.context_json || '{}').releaseId === id).length,
  };
}

// control.post: 'pass' | 'hold' | 'lose' | 'gate' for Delete POSTs. lose lets
// the real request run first and then fails the browser's fetch; gate sends it
// on to the upstream gate and, once it has arrived there, fails the browser's
// fetch, so the request stays alive upstream while the page loses its answer.
// control.saves / control.archives: 'pass' | 'hold'.
async function open(page, url, { width = 1280, height = 900, ready = '[data-release-edit-id]' } = {}) {
  const control = {
    post: 'pass', saves: 'pass', archives: 'pass', posts: [], heldPosts: [], savePosts: [], heldSaves: [],
    archivePosts: [], heldArchives: [], publishPosts: [], gets: [], upstream: [], navigations: 0,
  };
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() === 'POST' && DELETE_PATH.test(pathname)) control.posts.push(request);
    else if (request.method() === 'POST' && ARCHIVE_PATH.test(pathname)) control.archivePosts.push(request);
    else if (request.method() === 'POST' && SAVE_PATH.test(pathname)) control.savePosts.push(request);
    else if (request.method() === 'POST' && PUBLISH_PATH.test(pathname)) control.publishPosts.push(request);
    else if (request.method() === 'GET' && request.resourceType() === 'fetch') control.gets.push(pathname);
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
  await page.route((target) => ARCHIVE_PATH.test(target.pathname), async (route) => {
    if (control.archives === 'hold') { control.heldArchives.push(route); return undefined; }
    return route.continue();
  });
  await page.route((target) => SAVE_PATH.test(target.pathname), async (route) => {
    if (route.request().method() === 'POST' && control.saves === 'hold') { control.heldSaves.push(route); return undefined; }
    return route.fallback();
  });
  await page.setViewportSize({ width, height });
  await page.goto(`${baseURL}${url}`);
  await page.locator(ready).first().waitFor({ state: 'attached' });
  control.navigations = 0;
  await page.evaluate(() => { window.__sameDocument = true; });
  return { control, errors };
}

const editDialog = (page) => page.locator('#release-edit-dialog');
const confirmation = (page) => page.locator('#app-confirmation-dialog');
const confirmButton = (page) => confirmation(page).locator('[data-app-dialog-confirmation-confirm]');
const cancelButton = (page) => confirmation(page).locator('[data-app-dialog-confirmation-cancel]');
const deleteDisclosure = (page) => editDialog(page).locator('[data-release-edit-action="delete"]');
const deleteButton = (page) => deleteDisclosure(page).locator('button[data-confirm]');
const archiveDisclosure = (page) => editDialog(page).locator('[data-release-edit-action="archive"]');
const archiveButton = (page) => archiveDisclosure(page).locator('button[data-confirm]');
const dialogStatus = (page) => editDialog(page).locator('[data-dialog-status]');
const feedback = (page) => page.locator('[data-dialog-feedback]');
const titleField = (page) => editDialog(page).locator('input[name="title"]');
const notesField = (page) => editDialog(page).locator('textarea[name="notes"]');
const saveButton = (page) => editDialog(page).locator('button[data-dialog-submit]');

async function loaded(page) {
  await expect(editDialog(page)).toBeVisible();
  await expect(editDialog(page).locator('.app-dialog-body')).toBeVisible();
  await expect(saveButton(page)).toBeEnabled();
}

async function editFromDetail(page, release) {
  await page.locator(`[data-release-edit-id="${release.id}"]`).first().click();
  await loaded(page);
}

async function editFromCard(page, release) {
  const cards = page.locator(`[data-calendar-info-card]:has([data-release-edit-id="${release.id}"])`);
  let card = null;
  for (const candidate of await cards.all()) {
    const trigger = page.locator(`[data-calendar-info-trigger][aria-controls="${await candidate.getAttribute('id')}"]`);
    if (await trigger.isVisible()) {
      await trigger.click();
      card = candidate;
      break;
    }
  }
  expect(card).not.toBeNull();
  await expect(card).toBeVisible();
  await card.locator(`[data-release-edit-id="${release.id}"]`).click();
  await loaded(page);
}

async function openDeleteConfirmation(page) {
  if (!(await deleteDisclosure(page).evaluate((node) => node.open))) await deleteDisclosure(page).locator('summary').click();
  await deleteButton(page).click();
  await expect(confirmation(page)).toBeVisible();
}

async function openArchiveConfirmation(page) {
  if (!(await archiveDisclosure(page).evaluate((node) => node.open))) await archiveDisclosure(page).locator('summary').click();
  await archiveButton(page).click();
  await expect(confirmation(page)).toBeVisible();
}

// Reaches a control the frozen dialog no longer lets the pointer reach.
async function clickProgrammatically(page, selector) {
  await page.evaluate((target) => {
    const control = document.querySelector(target);
    const details = control.closest('details');
    if (details) details.open = true;
    control.click();
  }, selector);
}

async function expectSameDocument(page, url) {
  expect(await page.evaluate(() => window.__sameDocument)).toBe(true);
  const current = new URL(page.url());
  expect(current.pathname + current.search).toBe(url);
}

const lead = (release) => `Delete “${release.title}” permanently?`;
const OBSERVED_MISSING = 'This release no longer exists, but this page could not confirm whether that Delete request deleted it.';
const STILL_PRESENT = 'The release still exists, but the earlier Delete request may still run.';

test('A: Release Detail — local confirmation; Cancel/Escape/backdrop/requestSubmit send nothing; one confirmed POST deletes and the page goes once to Releases', async ({ page }) => {
  const project = createProject('Delete A');
  const asset = insertAsset(project.id, 'a.png');
  const release = createRelease(project.id, 'Delete A', { plannedDate: '2031-07-10', assets: [asset] });
  const sibling = createRelease(project.id, 'Delete A sibling', { plannedDate: '2031-07-11', assets: [asset] });
  const siblingBefore = sibling.row();
  const url = `/releases/${release.id}`;
  const { control, errors } = await open(page, url);
  await editFromDetail(page, release);

  await openDeleteConfirmation(page);
  await expect(confirmation(page)).toContainText(lead(release));
  await expect(confirmation(page)).toContainText('The project’s assets and files are not affected');
  await expect(confirmButton(page)).toHaveText('Delete release');
  await cancelButton(page).click();
  await expect(confirmation(page)).toBeHidden();
  await expect(editDialog(page)).toBeVisible();
  await expect(deleteButton(page)).toBeFocused();
  await deleteButton(page).click();
  await page.keyboard.press('Escape');
  await expect(confirmation(page)).toBeHidden();
  await expect(editDialog(page)).toBeVisible();
  await deleteButton(page).click();
  await expect(confirmation(page)).toBeVisible();
  await page.mouse.click(4, 4);
  await expect(confirmation(page)).toBeHidden();
  await page.evaluate(() => document.querySelector('form[data-release-delete-form]').requestSubmit());
  await expect(confirmation(page)).toBeVisible();
  await cancelButton(page).click();
  expect(control.posts).toHaveLength(0);
  expect(gate.forwarded).toBe(0);
  expect(release.exists()).toBe(true);
  await expectSameDocument(page, url);

  await deleteButton(page).click();
  await confirmButton(page).focus();
  const navigated = page.waitForURL(`${baseURL}/releases`);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await navigated;
  await page.waitForLoadState('load');
  expect(control.posts).toHaveLength(1);
  expect(gate.forwarded).toBe(1);
  expect(release.deleteLogs()).toBe(1);
  expect(release.exists()).toBe(false);
  expect(release.assetRows()).toEqual([]);
  expect(db.prepare('SELECT id FROM assets WHERE id = ?').get(asset)).toBeDefined();
  expect(sibling.row()).toEqual(siblingBefore);
  expect(sibling.assetRows()).toHaveLength(1);
  // One navigation, to the Releases page; the old document is gone.
  expect(control.navigations).toBe(1);
  expect(await page.evaluate(() => window.__sameDocument)).toBeUndefined();
  await expect(page.locator(`[data-release-edit-id="${release.id}"]`)).toHaveCount(0);
  expect(control.savePosts).toHaveLength(0);
  expect(errors).toEqual([]);
});

test('B: Dashboard — deletes from the release card; the item leaves, siblings and scroll stay, same document', async ({ page }) => {
  const project = createProject('Delete B');
  const target = createRelease(project.id, 'Delete B');
  const other = createRelease(project.id, 'Delete B other');
  const { control, errors } = await open(page, '/');
  await page.locator('[data-dashboard-title-info-bound="true"]').first().waitFor({ state: 'attached' });
  await page.locator(`[data-dashboard-needs-date-item][data-release-id="${other.id}"]`).evaluate((node) => { node.dataset.marker = 'kept'; });
  await editFromCard(page, target);
  await openDeleteConfirmation(page);
  await expect(confirmation(page)).toContainText(lead(target));
  await confirmButton(page).click();
  await expect(editDialog(page)).toBeHidden();
  await expect(feedback(page)).toHaveText(`Release “${target.title}” deleted.`);
  await expect(page.locator(`[data-dashboard-needs-date-item][data-release-id="${target.id}"]`)).toHaveCount(0);
  await expect(page.locator(`[data-dashboard-needs-date-item][data-release-id="${other.id}"]`)).toHaveCount(1);
  await expect(page.locator('[data-dashboard-sync]')).toBeHidden();
  expect(target.exists()).toBe(false);
  expect(other.exists()).toBe(true);
  await expectSameDocument(page, '/');
  expect(control.posts).toHaveLength(1);
  expect(control.navigations).toBe(0);
  expect(control.gets).toContain('/');
  expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
  expect(errors).toEqual([]);
});

test('C: Calendar — deletes from the release card; month, view and other events stay; the event leaves', async ({ page }) => {
  const project = createProject('Delete C');
  const target = createRelease(project.id, 'Delete C', { plannedDate: '2031-07-10' });
  const other = createRelease(project.id, 'Delete C other', { plannedDate: '2031-07-12' });
  const url = '/calendar?month=2031-07&view=list';
  const { control, errors } = await open(page, url);
  const heading = await page.locator('[data-calendar-month-heading]').first().textContent();
  await editFromCard(page, target);
  await openDeleteConfirmation(page);
  await confirmButton(page).click();
  await expect(editDialog(page)).toBeHidden();
  await expect(feedback(page)).toHaveText(`Release “${target.title}” deleted.`);
  await expect(page.locator(`[data-release-edit-id="${target.id}"]`)).toHaveCount(0);
  expect(await page.locator(`[data-release-edit-id="${other.id}"]`).count()).toBeGreaterThan(0);
  await expect(page.locator('[data-calendar-month-heading]').first()).toHaveText(heading);
  await expect(page.locator('#main-content')).toBeFocused();
  expect(target.exists()).toBe(false);
  expect(other.exists()).toBe(true);
  await expectSameDocument(page, url);
  expect(control.posts).toHaveLength(1);
  expect(control.navigations).toBe(0);
  expect(control.gets.some((pathname) => pathname === '/calendar')).toBe(true);
  // The other release's card still opens with its own Edit action.
  await editFromCard(page, other);
  await expect(deleteDisclosure(page).locator('form')).toHaveAttribute('action', `/releases/${other.id}/delete`);
  expect(errors).toEqual([]);
});

test('D: unsaved drafts — warned, kept on Cancel and refusal, never saved, gone only with the deleted release', async ({ page }) => {
  const project = createProject('Delete D');
  const release = createRelease(project.id, 'Delete D', { plannedDate: '2031-07-10' });
  const url = '/calendar?month=2031-07';
  const { control, errors } = await open(page, url);
  await editFromCard(page, release);
  await titleField(page).fill('Unsaved title');
  await notesField(page).fill('Unsaved notes');
  await openDeleteConfirmation(page);
  await expect(confirmation(page).locator('#app-confirmation-dialog-title')).toHaveText('Delete release with unsaved changes?');
  await expect(confirmation(page)).toContainText(lead(release));
  await expect(confirmation(page)).toContainText('Your unsaved Edit Release changes (title and notes) will not be saved: they are kept if you cancel or the release is not deleted, and lost if it is deleted.');
  await expect(cancelButton(page)).toHaveText('Keep editing');
  await cancelButton(page).click();
  await expect(titleField(page)).toHaveValue('Unsaved title');
  await expect(notesField(page)).toHaveValue('Unsaved notes');
  expect(control.posts).toHaveLength(0);

  // An authoritative refusal (CSRF) keeps the drafts and Delete available.
  const token = await deleteDisclosure(page).locator('input[name="_csrf"]').inputValue();
  await deleteDisclosure(page).locator('input[name="_csrf"]').evaluate((input) => { input.value = 'stale-token'; });
  await openDeleteConfirmation(page);
  await confirmButton(page).click();
  await expect(dialogStatus(page)).toHaveText('Invalid or missing CSRF token. Nothing was deleted. Your unsaved changes are kept.');
  await expect(titleField(page)).toHaveValue('Unsaved title');
  await expect(notesField(page)).toHaveValue('Unsaved notes');
  await expect(deleteButton(page)).toBeFocused();
  expect(release.exists()).toBe(true);
  expect(control.posts).toHaveLength(1);
  expect(release.deleteLogs()).toBe(0);

  await deleteDisclosure(page).locator('input[name="_csrf"]').evaluate((input, value) => { input.value = value; }, token);
  await openDeleteConfirmation(page);
  await confirmButton(page).click();
  await expect(editDialog(page)).toBeHidden();
  expect(release.exists()).toBe(false);
  expect(control.posts).toHaveLength(2);
  expect(control.savePosts).toHaveLength(0);
  await expectSameDocument(page, url);
  expect(errors).toEqual([]);
});

test('E: pending operations — Save, Archive and Delete in flight refuse each other; nothing extra is sent', async ({ page }) => {
  const project = createProject('Delete E');
  const release = createRelease(project.id, 'Delete E', { plannedDate: '2031-07-10' });
  const url = `/releases/${release.id}`;
  const { control, errors } = await open(page, url);

  // 1. Save in flight: Delete refused before its confirmation.
  await editFromDetail(page, release);
  await titleField(page).fill('Saved during E');
  control.saves = 'hold';
  await saveButton(page).click();
  await expect.poll(() => control.heldSaves.length).toBe(1);
  await clickProgrammatically(page, 'form[data-release-delete-form] button');
  await expect(confirmation(page)).toBeHidden();
  await expect(dialogStatus(page)).toContainText('Wait for the save to finish, then try again.');
  expect(control.posts).toHaveLength(0);
  control.saves = 'pass';
  await control.heldSaves[0].continue();
  await expect(editDialog(page)).toBeHidden();

  // 2. Archive in flight: Delete refused.
  await editFromDetail(page, release);
  control.archives = 'hold';
  await openArchiveConfirmation(page);
  await confirmButton(page).click();
  await expect.poll(() => control.heldArchives.length).toBe(1);
  await clickProgrammatically(page, 'form[data-release-delete-form] button');
  await expect(confirmation(page)).toBeHidden();
  await expect(dialogStatus(page)).toContainText('The release is being archived. Wait for the result.');
  expect(control.posts).toHaveLength(0);
  // Its answer is lost before it reaches the app, so nothing is archived but
  // the page holds the Archive as unresolved: Delete stays refused.
  await control.heldArchives[0].abort('failed');
  await expect(dialogStatus(page)).toContainText('The release still shows as active');
  await page.evaluate(() => document.querySelector('form[data-release-delete-form]').requestSubmit());
  await expect(confirmation(page)).toBeHidden();
  expect(control.posts).toHaveLength(0);
  expect(release.archived()).toBe(false);

  // 3–5. Delete in flight (fresh document): Archive, Publish and another Delete refused.
  await page.goto(`${baseURL}${url}`);
  await page.evaluate(() => { window.__sameDocument = true; });
  await editFromDetail(page, release);
  control.post = 'hold';
  await openDeleteConfirmation(page);
  await confirmButton(page).click();
  await expect.poll(() => control.heldPosts.length).toBe(1);
  await expect(dialogStatus(page)).toContainText('Deleting “Saved during E”…');
  await clickProgrammatically(page, 'form[data-release-archive-form] button');
  await clickProgrammatically(page, 'form[data-release-delete-form] button');
  await page.evaluate(() => document.querySelector('form[data-release-delete-form]').requestSubmit());
  await page.evaluate(() => document.querySelector('#release-publish-form')?.requestSubmit());
  await page.evaluate(() => document.querySelector('#release-edit-form').requestSubmit());
  await page.keyboard.press('Escape');
  await expect(editDialog(page)).toBeVisible();
  await expect(confirmation(page)).toBeHidden();
  expect(control.posts).toHaveLength(1);
  expect(control.archivePosts).toHaveLength(1);
  expect(control.publishPosts).toHaveLength(0);
  expect(control.savePosts).toHaveLength(1);
  const navigated = page.waitForURL(`${baseURL}/releases`);
  await control.heldPosts[0].continue();
  await navigated;
  expect(release.exists()).toBe(false);
  expect(release.deleteLogs()).toBe(1);
  expect(errors).toEqual([]);
});

test('F: Dashboard — a failed refresh keeps the Delete acknowledged; Retry refresh is a GET; stale controls stay refused', async ({ page }) => {
  const project = createProject('Delete F');
  const release = createRelease(project.id, 'Delete F');
  const other = createRelease(project.id, 'Delete F other');
  const { control, errors } = await open(page, '/');
  await page.locator('[data-dashboard-title-info-bound="true"]').first().waitFor({ state: 'attached' });
  let failRefresh = true;
  await page.route((target) => target.pathname === '/', (route) => {
    if (route.request().method() === 'GET' && route.request().resourceType() === 'fetch' && failRefresh) {
      return route.fulfill({ status: 500, body: 'unavailable' });
    }
    return route.fallback();
  });
  await editFromCard(page, release);
  await openDeleteConfirmation(page);
  await confirmButton(page).click();
  const sync = page.locator('[data-dashboard-sync]');
  await expect(sync).toBeVisible();
  await expect(sync).toContainText('The release was deleted, but');
  // WP11B-F1: a confirmed Delete is never reported as an Archive.
  await expect(sync).not.toContainText('archived');
  expect(release.exists()).toBe(false);
  expect(release.archiveLogs()).toBe(0);
  // The stale item is still shown; its Edit action cannot reach a release that is gone.
  await expect(page.locator(`[data-dashboard-needs-date-item][data-release-id="${release.id}"]`)).toHaveCount(1);
  failRefresh = false;
  await sync.getByRole('button', { name: 'Retry refresh' }).click();
  await expect(page.locator(`[data-dashboard-needs-date-item][data-release-id="${release.id}"]`)).toHaveCount(0);
  await expect(page.locator(`[data-dashboard-needs-date-item][data-release-id="${other.id}"]`)).toHaveCount(1);
  // The Dashboard's own recovery banner reports the installed refresh.
  await expect(sync).toContainText('Dashboard refreshed.');
  expect(control.posts).toHaveLength(1);
  expect(gate.forwarded).toBe(1);
  expect(release.deleteLogs()).toBe(1);
  await expectSameDocument(page, '/');
  expect(errors).toEqual([]);
});

test('F2: Calendar — a failed refresh keeps the Delete acknowledged; Retry refresh is a GET', async ({ page }) => {
  const project = createProject('Delete F2');
  const release = createRelease(project.id, 'Delete F2', { plannedDate: '2031-08-10' });
  const url = '/calendar?month=2031-08';
  const { control, errors } = await open(page, url);
  let failRefresh = true;
  await page.route((target) => target.pathname === '/calendar', (route) => {
    if (route.request().method() === 'GET' && route.request().resourceType() === 'fetch' && failRefresh) {
      return route.fulfill({ status: 500, body: 'unavailable' });
    }
    return route.fallback();
  });
  await editFromCard(page, release);
  await openDeleteConfirmation(page);
  await confirmButton(page).click();
  await expect(feedback(page)).toContainText('Release deleted, but Calendar could not refresh. The calendar shown may be out of date.');
  expect(release.exists()).toBe(false);
  // A stale Edit action loads nothing it could save or delete.
  await page.evaluate((id) => document.querySelector(`[data-release-edit-id="${id}"]`).click(), release.id);
  await expect(editDialog(page)).toBeVisible();
  await expect(dialogStatus(page)).toContainText('Release not found.');
  await expect(saveButton(page)).toBeDisabled();
  expect(control.posts).toHaveLength(1);
  await page.keyboard.press('Escape');
  failRefresh = false;
  await feedback(page).getByRole('button', { name: 'Retry refresh' }).click();
  await expect(page.locator(`[data-release-edit-id="${release.id}"]`)).toHaveCount(0);
  await expect(feedback(page)).toHaveText(`Release “${release.title}” deleted.`);
  expect(control.posts).toHaveLength(1);
  await expectSameDocument(page, url);
  expect(errors).toEqual([]);
});

test('G: a lost answer after the service ran — no resend; drafts kept; the GET check reports an observation and retires Release Detail without navigating', async ({ page }) => {
  const project = createProject('Delete G');
  const release = createRelease(project.id, 'Delete G');
  const url = `/releases/${release.id}`;
  const { control, errors } = await open(page, url);
  await editFromDetail(page, release);
  await titleField(page).fill('Draft kept through loss');
  control.post = 'lose';
  await openDeleteConfirmation(page);
  await confirmButton(page).click();
  await expect(feedback(page)).toContainText(OBSERVED_MISSING);
  await expect(feedback(page)).toHaveClass(/notice--error/);
  expect(release.exists()).toBe(false);
  expect(gate.forwarded).toBe(1);
  expect(release.deleteLogs()).toBe(1);
  expect(control.posts).toHaveLength(1);
  expect(control.gets).toContain(`/releases/${release.id}/edit`);
  // Retired, not navigated: the page links to Releases instead.
  await expect(page.locator('#main-content')).toHaveAttribute('data-release-deleted-host', String(release.id));
  await expect(feedback(page).getByRole('link', { name: 'Go to Releases' })).toHaveAttribute('href', '/releases');
  await expect(deleteButton(page)).toHaveAttribute('aria-disabled', 'true');
  await page.evaluate(() => document.querySelector('#release-edit-form').requestSubmit());
  await page.keyboard.press('Escape');
  await expect(editDialog(page)).toBeHidden();
  // The release's content is inert (itself or through an ancestor); the
  // feedback with its link is not.
  expect(await page.locator('[data-release-detail-region="details"]').first()
    .evaluate((node) => Boolean(node.closest('[inert]')))).toBe(true);
  expect(await feedback(page).evaluate((node) => Boolean(node.closest('[inert]')))).toBe(false);
  expect(control.savePosts).toHaveLength(0);
  expect(control.posts).toHaveLength(1);
  await expectSameDocument(page, url);
  expect(control.navigations).toBe(0);
  await feedback(page).getByRole('link', { name: 'Go to Releases' }).click();
  await page.waitForURL(`${baseURL}/releases`);
  expect(errors).toEqual([]);
});

test('H: a delayed original POST — early GET keeps the hold; no second Delete, Save, Archive or Publish; released, it deletes once', async ({ page }) => {
  const project = createProject('Delete H');
  const release = createRelease(project.id, 'Delete H');
  const url = `/releases/${release.id}`;
  const { control, errors } = await open(page, url);
  await editFromDetail(page, release);
  await notesField(page).fill('Draft notes held');
  gate.holdNext = 1;
  control.post = 'gate';
  await openDeleteConfirmation(page);
  await confirmButton(page).click();
  await expect(dialogStatus(page)).toContainText(STILL_PRESENT);
  expect(gate.arrivals).toBe(1);
  expect(gate.forwarded).toBe(0);
  expect(release.exists()).toBe(true);
  await expect(notesField(page)).toHaveValue('Draft notes held');
  await expect(feedback(page).getByRole('button', { name: 'Check again' })).toBeVisible();

  // Dismiss and reopen: the drafts and the hold come back.
  await page.keyboard.press('Escape');
  await expect(editDialog(page)).toBeHidden();
  await editFromDetail(page, release);
  await expect(notesField(page)).toHaveValue('Draft notes held');
  await expect(deleteButton(page)).toHaveAttribute('aria-disabled', 'true');
  control.post = 'pass';
  if (!(await deleteDisclosure(page).evaluate((node) => node.open))) await deleteDisclosure(page).locator('summary').click();
  await deleteButton(page).click({ force: true });
  await expect(confirmation(page)).toBeHidden();
  await expect(dialogStatus(page)).toContainText('cannot be deleted again from this page');
  await saveButton(page).click();
  await expect(dialogStatus(page)).toContainText('Changes cannot be saved while the earlier Delete request is unconfirmed.');
  if (await archiveDisclosure(page).isVisible()) {
    await archiveDisclosure(page).locator('summary').click();
    await archiveButton(page).click({ force: true });
    await expect(confirmation(page)).toBeHidden();
  }
  await page.evaluate(() => document.querySelector('form[data-release-archive-form]').requestSubmit());
  await expect(confirmation(page)).toBeHidden();
  expect(control.posts).toHaveLength(1);
  expect(control.savePosts).toHaveLength(0);
  expect(control.archivePosts).toHaveLength(0);

  await page.keyboard.press('Escape');
  await page.locator('[data-dialog-open="release-publish-dialog"]').click();
  const publishDialog = page.locator('#release-publish-dialog');
  await expect(publishDialog).toBeVisible();
  await publishDialog.locator('[data-dialog-submit]').click();
  await expect(publishDialog.locator('[data-dialog-status]')).toContainText('This release cannot be changed while its Delete request is unconfirmed.');
  expect(control.publishPosts).toHaveLength(0);
  await page.keyboard.press('Escape');
  await expect(publishDialog).toBeHidden();
  // Check again (GET) still finds it present: still held.
  await feedback(page).getByRole('button', { name: 'Check again' }).click();
  await expect(feedback(page)).toContainText(STILL_PRESENT);

  // The original request is still live upstream; releasing it deletes once.
  gate.release();
  const [upstream] = await Promise.all(control.upstream);
  expect(upstream.status).toBe(200);
  expect(upstream.body).toMatchObject({ outcome: 'deleted', releaseId: release.id });
  expect(release.exists()).toBe(false);
  expect(gate.forwarded).toBe(1);
  expect(release.deleteLogs()).toBe(1);
  await feedback(page).getByRole('button', { name: 'Check again' }).click();
  await expect(feedback(page)).toContainText(OBSERVED_MISSING);
  await expect(page.locator('#main-content')).toHaveAttribute('data-release-deleted-host', String(release.id));
  expect(control.posts).toHaveLength(1);
  expect(control.publishPosts).toHaveLength(0);
  expect(control.savePosts).toHaveLength(0);
  await expectSameDocument(page, url);
  expect(control.navigations).toBe(0);
  expect(errors).toEqual([]);
});

test('I: native and security — a form submitted without the enhancement keeps its POST and redirect; refusals render safely', async ({ page }) => {
  const project = createProject('Delete I');
  const release = createRelease(project.id, 'Delete I');
  const url = `/releases/${release.id}`;
  await open(page, url);
  await editFromDetail(page, release);
  const navigated = page.waitForEvent('framenavigated', { predicate: (frame) => frame === page.mainFrame() });
  await page.evaluate(() => HTMLFormElement.prototype.submit.call(document.querySelector('form[data-release-delete-form]')))
    .catch(() => {});
  await navigated;
  await page.waitForLoadState('load');
  expect(new URL(page.url()).pathname).toBe('/releases');
  expect(release.exists()).toBe(false);
  // The session's token, from a page that renders the Edit Release dialog.
  await page.goto(`${baseURL}/`);
  const token = await page.locator('#release-edit-dialog input[name="_csrf"]').first().inputValue();
  // A second native delete of the gone release is a 404 page.
  const missing = await page.request.post(`${baseURL}/releases/${release.id}/delete`, {
    headers: { Accept: 'text/html' }, form: { _csrf: token }, maxRedirects: 0,
  });
  expect(missing.status()).toBe(404);
  expect(missing.headers()['content-type']).toMatch(/text\/html/);
  const other = createRelease(project.id, 'Delete I other');
  const refused = await page.request.post(`${baseURL}/releases/${other.id}/delete`, {
    headers: { Accept: 'application/json' }, form: { _csrf: 'wrong' },
  });
  expect(refused.status()).toBe(403);
  expect(other.exists()).toBe(true);
  // An archived release's native Delete renders the read-only page.
  db.prepare("UPDATE releases SET archived_at = datetime('now') WHERE id = ?").run(other.id);
  const archived = await page.request.post(`${baseURL}/releases/${other.id}/delete`, {
    headers: { Accept: 'text/html' }, form: { _csrf: token },
  });
  expect(archived.status()).toBe(422);
  const text = await archived.text();
  expect(text).toContain('This release is archived and read-only.');
  expect(text).not.toMatch(/SQLITE|at [A-Za-z]+ \(/);
  expect(other.exists()).toBe(true);
});

test('J: eligibility races — archived elsewhere is refused with drafts kept; published elsewhere still deletes; a project archived before execution refuses', async ({ page }) => {
  const project = createProject('Delete J');
  const archivedLater = createRelease(project.id, 'Delete J archived', { plannedDate: '2031-07-10' });
  const publishedLater = createRelease(project.id, 'Delete J published', { plannedDate: '2031-07-11' });
  const url = '/calendar?month=2031-07';
  const { control, errors } = await open(page, url);

  await editFromCard(page, archivedLater);
  await titleField(page).fill('Draft over archived');
  db.prepare("UPDATE releases SET archived_at = datetime('now') WHERE id = ?").run(archivedLater.id);
  await openDeleteConfirmation(page);
  await confirmButton(page).click();
  await expect(dialogStatus(page)).toContainText('Archived releases cannot be deleted. Nothing was deleted.');
  await expect(titleField(page)).toHaveValue('Draft over archived');
  expect(archivedLater.exists()).toBe(true);
  expect(archivedLater.deleteLogs()).toBe(0);
  await page.keyboard.press('Escape');
  await expect(editDialog(page)).toBeHidden();
  // The Calendar re-read it (GET only) and it left as archived.
  await expect(page.locator(`[data-release-edit-id="${archivedLater.id}"]`)).toHaveCount(0);

  await editFromCard(page, publishedLater);
  db.prepare("UPDATE releases SET published_date = '2026-10-01' WHERE id = ?").run(publishedLater.id);
  await openDeleteConfirmation(page);
  await confirmButton(page).click();
  await expect(editDialog(page)).toBeHidden();
  expect(publishedLater.exists()).toBe(false);

  const projectLater = createProject('Delete J project');
  const inProject = createRelease(projectLater.id, 'Delete J in project', { plannedDate: '2031-07-12' });
  await page.goto(`${baseURL}/releases/${inProject.id}`);
  await page.evaluate(() => { window.__sameDocument = true; });
  await editFromDetail(page, inProject);
  gate.holdNext = 1;
  control.post = 'gate';
  await openDeleteConfirmation(page);
  await confirmButton(page).click();
  await expect.poll(() => gate.held.length).toBe(1);
  app.locals.projectService.archive(projectLater.id);
  gate.release();
  const [upstream] = await Promise.all(control.upstream.slice(-1));
  expect(upstream.status).toBe(409);
  expect(upstream.body).toMatchObject({ code: 'PROJECT_ARCHIVED', outcome: 'refused' });
  expect(inProject.exists()).toBe(true);
  expect(inProject.deleteLogs()).toBe(0);
  expect(errors).toEqual([]);
});

test('K: regressions and focus — Archive still works and then offers no Delete; narrow long title; repeated Enter sends one Delete', async ({ page }) => {
  const project = createProject('Delete K');
  const archivedHere = createRelease(project.id, 'Delete K archive');
  const url = `/releases/${archivedHere.id}`;
  const first = await open(page, url);
  await editFromDetail(page, archivedHere);
  await openArchiveConfirmation(page);
  await confirmButton(page).click();
  await expect(page.locator('[data-release-detail-archived]')).toHaveCount(1);
  expect(archivedHere.archived()).toBe(true);
  // The archived render withdraws the editing controls, Delete with them.
  await expect(page.locator('form[data-release-delete-form]')).toHaveCount(0);
  expect(first.control.posts).toHaveLength(0);
  expect(first.errors).toEqual([]);

  const longTitle = `Delete K ${'Very long release title segment '.repeat(6)}end`;
  const release = createRelease(project.id, 'Delete K', { title: longTitle });
  await page.setViewportSize({ width: 375, height: 760 });
  await page.goto(`${baseURL}/releases/${release.id}`);
  await editFromDetail(page, release);
  await openDeleteConfirmation(page);
  await expect(confirmation(page)).toContainText(`Delete “${longTitle}” permanently?`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(confirmButton(page)).toBeInViewport();
  await page.keyboard.press('Escape');
  await expect(confirmation(page)).toBeHidden();
  await expect(deleteButton(page)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(confirmation(page)).toBeVisible();
  let posts = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && DELETE_PATH.test(new URL(request.url()).pathname)) posts += 1;
  });
  gate.holdNext = 1;
  await confirmButton(page).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect.poll(() => gate.held.length).toBe(1);
  expect(posts).toBe(1);
  await expect(dialogStatus(page)).toContainText(`Deleting “${longTitle}”…`);
  const navigated = page.waitForURL(`${baseURL}/releases`);
  gate.release();
  await navigated;
  expect(release.exists()).toBe(false);
  expect(posts).toBe(1);
  expect(release.deleteLogs()).toBe(1);
});

// WP11B-F1: a release-archived event is no evidence that an Archive ran. A
// Delete refused because the release (or its project) is archived asks the
// Dashboard to re-read it; whether that read installs or fails, the Dashboard
// never reports an Archive that did not happen, and recovery only reads.
const PROJECT_REFUSAL = 'The parent project is archived, so this release is read-only. Nothing was deleted.';
const RELEASE_REFUSAL = 'Archived releases cannot be deleted. Nothing was deleted.';
const FALSE_ARCHIVE = /release was archived|archived successfully|release archived/i;

// Fails (or holds once) the Dashboard's own GET-only refresh of '/'.
async function controlDashboardRefresh(page) {
  const refresh = { mode: 'pass', held: [], gets: 0 };
  await page.route((target) => target.pathname === '/', (route) => {
    if (route.request().method() !== 'GET' || route.request().resourceType() !== 'fetch') return route.fallback();
    refresh.gets += 1;
    if (refresh.mode === 'fail') return route.fulfill({ status: 500, body: 'unavailable' });
    if (refresh.mode === 'hold-once') { refresh.mode = 'pass'; refresh.held.push(route); return undefined; }
    return route.fallback();
  });
  return refresh;
}

// Archives the release through Release Detail's Edit Release in another tab.
async function archiveInOtherTab(page, release) {
  const other = await page.context().newPage();
  await other.goto(`${baseURL}/releases/${release.id}`);
  await other.locator(`[data-release-edit-id="${release.id}"]`).first().click();
  await expect(other.locator('#release-edit-dialog button[data-dialog-submit]')).toBeEnabled();
  const disclosure = other.locator('#release-edit-dialog [data-release-edit-action="archive"]');
  await disclosure.locator('summary').click();
  await disclosure.locator('button[data-confirm]').click();
  await other.locator('#app-confirmation-dialog [data-app-dialog-confirmation-confirm]').click();
  await expect(other.locator('[data-release-detail-archived]')).toHaveCount(1);
  await other.close();
}

for (const kind of ['project', 'release']) {
  for (const failing of [true, false]) {
    const name = `${kind === 'project' ? 'B1' : 'B2'}${failing ? '' : ' / B3'}`;
    test(`F1-${name}: Dashboard — Delete refused because the ${kind} is archived; ${failing ? 'failed refresh and GET-only Retry' : 'installed refresh'}; never reported as an Archive`, async ({ page }) => {
      const project = createProject(`F1 ${name}`);
      const asset = insertAsset(project.id, 'kept.png');
      const release = createRelease(project.id, `F1 ${name}`, { assets: [asset] });
      const { control, errors } = await open(page, '/');
      await page.locator('[data-dashboard-title-info-bound="true"]').first().waitFor({ state: 'attached' });
      const refresh = await controlDashboardRefresh(page);
      await editFromCard(page, release);
      await titleField(page).fill('Unsaved F1 title');
      await notesField(page).fill('Unsaved F1 notes');
      if (kind === 'project') app.locals.projectService.archive(project.id);
      else await archiveInOtherTab(page, release);
      const archiveLogsBefore = release.archiveLogs();
      expect(archiveLogsBefore).toBe(kind === 'project' ? 0 : 1);
      if (failing) refresh.mode = 'fail';

      const responded = page.waitForResponse((response) => DELETE_PATH.test(new URL(response.url()).pathname));
      await openDeleteConfirmation(page);
      await confirmButton(page).click();
      const response = await responded;
      expect(response.status()).toBe(409);
      expect(await response.json()).toMatchObject({
        code: kind === 'project' ? 'PROJECT_ARCHIVED' : 'RELEASE_ARCHIVED', outcome: 'refused',
      });
      const refusal = kind === 'project' ? PROJECT_REFUSAL : RELEASE_REFUSAL;
      await expect(dialogStatus(page)).toContainText(refusal);
      await expect(dialogStatus(page)).not.toContainText(FALSE_ARCHIVE);
      // Drafts and the saved baseline stay; nothing was saved for them.
      await expect(titleField(page)).toHaveValue('Unsaved F1 title');
      await expect(notesField(page)).toHaveValue('Unsaved F1 notes');
      expect(release.row().title).toBe(release.title);
      expect(release.row().notes).toBe('Saved notes');

      const sync = page.locator('[data-dashboard-sync]');
      await expect.poll(() => refresh.gets).toBeGreaterThan(0);
      if (failing) {
        await expect(sync).toBeVisible();
        await expect(sync).toContainText(`${refusal} The dashboard couldn’t refresh, so counts and lists may be out of date.`);
        await expect(sync).not.toContainText(FALSE_ARCHIVE);
        await page.keyboard.press('Escape');
        await expect(editDialog(page)).toBeHidden();
        // A Retry that fails again keeps the same attribution and reads only.
        await sync.getByRole('button', { name: 'Retry refresh' }).click();
        await expect(sync).toContainText('Try again, or reload the page.');
        await expect(sync).toContainText(refusal);
        await expect(sync).not.toContainText(FALSE_ARCHIVE);
        refresh.mode = 'pass';
        await sync.getByRole('button', { name: 'Retry refresh' }).click();
        await expect(sync).toContainText('Dashboard refreshed.');
        await expect(sync).not.toContainText(FALSE_ARCHIVE);
      } else {
        // The refresh installs behind the open dialog; nothing reports an Archive.
        await expect(page.locator(`[data-dashboard-needs-date-item][data-release-id="${release.id}"]`)).toHaveCount(0);
        await expect(sync).toBeHidden();
        await page.keyboard.press('Escape');
        await expect(editDialog(page)).toBeHidden();
      }
      await expect(page.locator(`[data-dashboard-needs-date-item][data-release-id="${release.id}"]`)).toHaveCount(0);
      await expect(feedback(page)).not.toContainText(FALSE_ARCHIVE);
      expect(await page.locator('body').innerText()).not.toMatch(FALSE_ARCHIVE);

      // Service and database evidence: one Delete arrived, none ran, no Archive ran here.
      expect(control.posts).toHaveLength(1);
      expect(gate.forwarded).toBe(1);
      expect(release.deleteLogs()).toBe(0);
      expect(release.exists()).toBe(true);
      expect(release.archived()).toBe(kind === 'release');
      expect(release.archiveLogs()).toBe(archiveLogsBefore);
      expect(release.assetRows()).toEqual([{ asset_id: asset }]);
      expect(control.archivePosts).toHaveLength(0);
      expect(control.savePosts).toHaveLength(0);
      expect(control.publishPosts).toHaveLength(0);
      await expectSameDocument(page, '/');
      expect(control.navigations).toBe(0);
      expect(errors).toEqual([]);
    });
  }
}

test('F1-B4 / B5: Dashboard — a confirmed Archive is still reported, and with a failed refresh stays acknowledged; Retry refresh is a GET', async ({ page }) => {
  const project = createProject('F1 B4');
  const archivedNow = createRelease(project.id, 'F1 B4');
  const archivedLater = createRelease(project.id, 'F1 B5');
  const other = createRelease(project.id, 'F1 B4 other');
  const { control, errors } = await open(page, '/');
  await page.locator('[data-dashboard-title-info-bound="true"]').first().waitFor({ state: 'attached' });
  const refresh = await controlDashboardRefresh(page);

  await editFromCard(page, archivedNow);
  await openArchiveConfirmation(page);
  await confirmButton(page).click();
  await expect(editDialog(page)).toBeHidden();
  await expect(feedback(page)).toHaveText(`Release “${archivedNow.title}” archived.`);
  await expect(page.locator(`[data-dashboard-needs-date-item][data-release-id="${archivedNow.id}"]`)).toHaveCount(0);
  await expect(page.locator('[data-dashboard-sync]')).toBeHidden();
  expect(archivedNow.archived()).toBe(true);
  expect(archivedNow.archiveLogs()).toBe(1);

  refresh.mode = 'fail';
  await editFromCard(page, archivedLater);
  await openArchiveConfirmation(page);
  await confirmButton(page).click();
  await expect(editDialog(page)).toBeHidden();
  const sync = page.locator('[data-dashboard-sync]');
  await expect(sync).toBeVisible();
  await expect(sync).toContainText('The release was archived, but the dashboard couldn’t refresh, so counts and lists may be out of date.');
  expect(archivedLater.archived()).toBe(true);
  expect(archivedLater.archiveLogs()).toBe(1);
  await expect(page.locator(`[data-dashboard-needs-date-item][data-release-id="${archivedLater.id}"]`)).toHaveCount(1);
  const gets = refresh.gets;
  refresh.mode = 'pass';
  await sync.getByRole('button', { name: 'Retry refresh' }).click();
  await expect(sync).toContainText('Dashboard refreshed.');
  expect(refresh.gets).toBe(gets + 1);
  await expect(page.locator(`[data-dashboard-needs-date-item][data-release-id="${archivedLater.id}"]`)).toHaveCount(0);
  await expect(page.locator(`[data-dashboard-needs-date-item][data-release-id="${other.id}"]`)).toHaveCount(1);
  expect(control.archivePosts).toHaveLength(2);
  expect(control.posts).toHaveLength(0);
  expect(control.savePosts).toHaveLength(0);
  expect(control.publishPosts).toHaveLength(0);
  expect(other.archived()).toBe(false);
  await expectSameDocument(page, '/');
  expect(control.navigations).toBe(0);
  expect(errors).toEqual([]);
});

test('F1-B8: Dashboard — an older refresh held behind a newer one cannot bring back a wrong or stale report', async ({ page }) => {
  const refusedProject = createProject('F1 B8 refused');
  const refused = createRelease(refusedProject.id, 'F1 B8 refused');
  const project = createProject('F1 B8');
  const archived = createRelease(project.id, 'F1 B8 archived');
  const { control, errors } = await open(page, '/');
  await page.locator('[data-dashboard-title-info-bound="true"]').first().waitFor({ state: 'attached' });
  const refresh = await controlDashboardRefresh(page);

  // The refused Delete's observational refresh is held.
  await editFromCard(page, refused);
  app.locals.projectService.archive(refusedProject.id);
  refresh.mode = 'hold-once';
  await openDeleteConfirmation(page);
  await confirmButton(page).click();
  await expect(dialogStatus(page)).toContainText(PROJECT_REFUSAL);
  await expect.poll(() => refresh.held.length).toBe(1);
  await page.keyboard.press('Escape');
  await expect(editDialog(page)).toBeHidden();

  // A newer confirmed Archive refreshes and installs first.
  await editFromCard(page, archived);
  await openArchiveConfirmation(page);
  await confirmButton(page).click();
  await expect(editDialog(page)).toBeHidden();
  await expect(feedback(page)).toHaveText(`Release “${archived.title}” archived.`);
  await expect(page.locator(`[data-dashboard-needs-date-item][data-release-id="${archived.id}"]`)).toHaveCount(0);

  // The older read finally answers; it is superseded and reports nothing.
  await refresh.held[0].continue();
  await page.waitForTimeout(300);
  const sync = page.locator('[data-dashboard-sync]');
  await expect(sync).toBeHidden();
  await expect(feedback(page)).toHaveText(`Release “${archived.title}” archived.`);
  await expect(page.locator(`[data-dashboard-needs-date-item][data-release-id="${refused.id}"]`)).toHaveCount(0);
  expect(refused.exists()).toBe(true);
  expect(refused.archived()).toBe(false);
  expect(refused.archiveLogs()).toBe(0);
  expect(refused.deleteLogs()).toBe(0);
  expect(archived.archiveLogs()).toBe(1);
  expect(control.posts).toHaveLength(1);
  expect(control.archivePosts).toHaveLength(1);
  expect(control.savePosts).toHaveLength(0);
  await expectSameDocument(page, '/');
  expect(errors).toEqual([]);
});
