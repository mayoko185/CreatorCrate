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

// WP11B-1: Archive release from the Edit Release dialog on its real hosts
// (Release Detail, Dashboard, Calendar) in real Chromium with the compiled
// client, the real route, templates, service and an isolated SQLite database.
// Every test records the Archive POSTs, Edit Save POSTs, Publish POSTs,
// read-only GETs, the database, document identity and URL. The release
// service is not exposed on app.locals, so its executions are counted by the
// Archive requests that reached the app (behind the upstream gate) and by its
// own release.archived activity rows. All data lives in a temporary root
// removed afterward; the app listens on its own temporary port.

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

// An upstream gate between the browser and the app: an Archive POST that
// reaches it has fully arrived, but the route and service have not run until
// the gate releases it. holdNext holds that many next arrivals; forwarded
// counts the Archive requests the app actually received.
const gate = {
  holdNext: 0,
  arrivals: 0,
  forwarded: 0,
  held: [],
  release() { this.held.splice(0).forEach((forward) => forward()); },
};

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-release-archive-'));
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
      if (req.method === 'POST' && ARCHIVE_PATH.test(new URL(req.url, 'http://gate').pathname)) {
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

function createRelease(projectId, prefix, { plannedDate = null, publishedDate = null, title = null } = {}) {
  fixtures += 1;
  const releaseTitle = title || `${prefix} Release ${String(fixtures).padStart(3, '0')}`;
  const id = db.prepare(`
    INSERT INTO releases (project_id, title, description, notes, planned_date, published_date, patreon_url)
    VALUES (?, ?, 'Saved description', 'Saved notes', ?, ?, NULL) RETURNING id
  `).get(projectId, releaseTitle, plannedDate, publishedDate).id;
  return {
    id,
    title: releaseTitle,
    row: () => db.prepare('SELECT * FROM releases WHERE id = ?').get(id),
    archived: () => db.prepare('SELECT archived_at FROM releases WHERE id = ?').get(id).archived_at !== null,
    archiveLogs: () => db.prepare(
      "SELECT context_json FROM application_logs WHERE event = 'release.archived'",
    ).all().filter((row) => JSON.parse(row.context_json || '{}').releaseId === id).length,
  };
}

// control.post: 'pass' | 'hold' | 'lose' | 'gate' for Archive POSTs. lose lets
// the real request run first and then fails the browser's fetch; gate sends it
// on to the upstream gate and, once it has arrived there, fails the browser's
// fetch, so the request stays alive upstream while the page loses its answer.
// control.saves: 'pass' | 'hold' for Edit Save POSTs (POST /releases/:id).
async function open(page, url, { width = 1280, height = 900, ready = '[data-release-edit-id]' } = {}) {
  const control = {
    post: 'pass', saves: 'pass', posts: [], heldPosts: [], savePosts: [], heldSaves: [], publishPosts: [],
    gets: [], upstream: [], navigations: 0,
  };
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() === 'POST' && ARCHIVE_PATH.test(pathname)) control.posts.push(request);
    else if (request.method() === 'POST' && SAVE_PATH.test(pathname)) control.savePosts.push(request);
    else if (request.method() === 'POST' && PUBLISH_PATH.test(pathname)) control.publishPosts.push(request);
    else if (request.method() === 'GET' && request.resourceType() === 'fetch') control.gets.push(pathname);
  });
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) control.navigations += 1; });
  await page.route((target) => ARCHIVE_PATH.test(target.pathname), async (route) => {
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
const archiveDisclosure = (page) => editDialog(page).locator('[data-release-edit-action="archive"]');
// By its markup: inside a closed disclosure the button has no accessible role.
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

// Dashboard and Calendar: the release's information card holds Edit release.
async function editFromCard(page, release) {
  // A host may render a release in more than one layout; use the shown one.
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

async function openArchiveConfirmation(page) {
  if (!(await archiveDisclosure(page).evaluate((node) => node.open))) await archiveDisclosure(page).locator('summary').click();
  await archiveButton(page).click();
  await expect(confirmation(page)).toBeVisible();
}

async function expectSameDocument(page, url) {
  expect(await page.evaluate(() => window.__sameDocument)).toBe(true);
  const current = new URL(page.url());
  expect(current.pathname + current.search).toBe(url);
}

const plain = (release) => `Archive “${release.title}”? It keeps its details, selected assets and any publication record, but becomes archived and read-only: it can no longer be edited, published or deleted, and it leaves the Dashboard and Calendar. This cannot be undone.`;

test('A: Release Detail — local confirmation; Cancel/Escape/backdrop/requestSubmit send nothing; one confirmed POST archives in place', async ({ page }) => {
  const project = createProject('Archive A');
  const release = createRelease(project.id, 'Archive A', { plannedDate: '2031-07-10' });
  const sibling = createRelease(project.id, 'Archive A sibling', { plannedDate: '2031-07-11' });
  const siblingBefore = sibling.row();
  const url = `/releases/${release.id}`;
  const { control, errors } = await open(page, url);
  await page.locator('[data-release-detail-region="details"]').evaluate((node) => { node.dataset.marker = 'before'; });
  await editFromDetail(page, release);

  await openArchiveConfirmation(page);
  await expect(confirmation(page)).toContainText(plain(release));
  await expect(confirmButton(page)).toHaveText('Archive release');
  await cancelButton(page).click();
  await expect(confirmation(page)).toBeHidden();
  await expect(editDialog(page)).toBeVisible();
  await expect(archiveButton(page)).toBeFocused();

  await archiveButton(page).click();
  await expect(confirmation(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(confirmation(page)).toBeHidden();
  await expect(editDialog(page)).toBeVisible();
  await archiveButton(page).click();
  await expect(confirmation(page)).toBeVisible();
  await page.mouse.click(4, 4);
  await expect(confirmation(page)).toBeHidden();
  await expect(editDialog(page)).toBeVisible();
  // requestSubmit never bypasses the confirmation.
  await page.evaluate(() => document.querySelector('form[data-release-archive-form]').requestSubmit());
  await expect(confirmation(page)).toBeVisible();
  await cancelButton(page).click();
  expect(control.posts).toHaveLength(0);
  expect(gate.forwarded).toBe(0);
  expect(release.archived()).toBe(false);

  await archiveButton(page).click();
  await expect(confirmation(page)).toBeVisible();
  await confirmButton(page).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(editDialog(page)).toHaveCount(0);
  await expect(feedback(page)).toHaveText(`Release “${release.title}” archived.`);
  await expect(feedback(page)).toHaveClass(/notice--success/);
  expect(control.posts).toHaveLength(1);
  expect(gate.forwarded).toBe(1);
  expect(release.archiveLogs()).toBe(1);
  expect(release.archived()).toBe(true);
  expect(sibling.row()).toEqual(siblingBefore);

  // Release Detail survives Archive: the archived render replaces its regions
  // and withdraws the editing controls and Review & Publish.
  await expect(page.locator('[data-release-detail-archived]')).toHaveCount(1);
  await expect(page.getByText('This release is archived and read-only.')).toBeVisible();
  await expect(page.locator(`[data-release-edit-id="${release.id}"]`)).toHaveCount(0);
  await expect(page.locator('[data-dialog-open="release-publish-dialog"]')).toHaveCount(0);
  await expect(page.locator('[data-release-detail-region="details"]')).toContainText('Archived');
  await expect(page.locator('#main-content')).toBeFocused();
  await expectSameDocument(page, url);
  expect(control.navigations).toBe(0);
  expect(control.gets).toContain(url);
  await page.keyboard.press('Enter');
  expect(control.posts).toHaveLength(1);
  expect(control.savePosts).toHaveLength(0);
  expect(errors).toEqual([]);
});

test('B1: Dashboard — archives from the release information card; the item leaves and the page stays', async ({ page }) => {
  const project = createProject('Archive B1');
  const target = createRelease(project.id, 'Archive B1');
  const other = createRelease(project.id, 'Archive B1 other');
  const { control, errors } = await open(page, '/');
  await page.locator('[data-dashboard-title-info-bound="true"]').first().waitFor({ state: 'attached' });
  await page.evaluate(() => window.scrollTo(0, 120));
  await editFromCard(page, target);
  await openArchiveConfirmation(page);
  await expect(confirmation(page)).toContainText(plain(target));
  await confirmButton(page).click();
  await expect(editDialog(page)).toBeHidden();
  await expect(feedback(page)).toHaveText(`Release “${target.title}” archived.`);
  await expect(page.locator(`[data-dashboard-needs-date-item][data-release-id="${target.id}"]`)).toHaveCount(0);
  await expect(page.locator(`[data-dashboard-needs-date-item][data-release-id="${other.id}"]`)).toHaveCount(1);
  await expect(page.locator('[data-dashboard-sync]')).toBeHidden();
  expect(target.archived()).toBe(true);
  expect(other.archived()).toBe(false);
  await expectSameDocument(page, '/');
  expect(control.posts).toHaveLength(1);
  expect(control.navigations).toBe(0);
  expect(control.gets).toContain('/');
  // Focus never falls to the body when the item leaves.
  expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
  expect(errors).toEqual([]);
});

test('B2: Calendar — archives from the release card; month, view and filters stay; the event leaves', async ({ page }) => {
  const project = createProject('Archive B2');
  const target = createRelease(project.id, 'Archive B2', { plannedDate: '2031-07-10' });
  const other = createRelease(project.id, 'Archive B2 other', { plannedDate: '2031-07-12' });
  const url = '/calendar?month=2031-07&view=list';
  const { control, errors } = await open(page, url);
  const heading = await page.locator('[data-calendar-month-heading]').first().textContent();
  await editFromCard(page, target);
  await openArchiveConfirmation(page);
  await confirmButton(page).click();
  await expect(editDialog(page)).toBeHidden();
  await expect(feedback(page)).toHaveText(`Release “${target.title}” archived.`);
  await expect(page.locator(`[data-release-edit-id="${target.id}"]`)).toHaveCount(0);
  // Calendar renders each release in its grid and list layouts.
  expect(await page.locator(`[data-release-edit-id="${other.id}"]`).count()).toBeGreaterThan(0);
  await expect(page.locator('[data-calendar-month-heading]').first()).toHaveText(heading);
  await expect(page.locator('#main-content')).toBeFocused();
  expect(target.archived()).toBe(true);
  await expectSameDocument(page, url);
  expect(control.posts).toHaveLength(1);
  expect(control.navigations).toBe(0);
  expect(control.gets.some((pathname) => pathname === '/calendar')).toBe(true);
  expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
  expect(errors).toEqual([]);
});

test('B3: Releases list and Project Detail render no Edit Release dialog, so no in-place Archive (not applicable)', async ({ page }) => {
  const project = createProject('Archive B3');
  createRelease(project.id, 'Archive B3');
  for (const url of ['/releases', `/projects/${project.id}`]) {
    await page.goto(`${baseURL}${url}`);
    await expect(page.locator('#release-edit-dialog')).toHaveCount(0);
    await expect(page.locator('form[data-release-archive-form]')).toHaveCount(0);
  }
});

test('C: unsaved Edit drafts — warned, kept on Cancel and on refusal, never saved, discarded only on success', async ({ page }) => {
  const project = createProject('Archive C');
  const release = createRelease(project.id, 'Archive C', { plannedDate: '2031-07-10' });
  const url = `/releases/${release.id}`;
  const { control, errors } = await open(page, url);
  await editFromDetail(page, release);
  await titleField(page).fill('Unsaved title');
  await notesField(page).fill('Unsaved notes');

  await openArchiveConfirmation(page);
  await expect(confirmation(page).locator('#app-confirmation-dialog-title')).toHaveText('Archive release with unsaved changes?');
  await expect(confirmation(page)).toContainText(`Archive “${release.title}”?`);
  await expect(confirmation(page)).toContainText('Your unsaved Edit Release changes (title and notes) will not be saved: they are kept if you cancel or the release is not archived, and lost if it is archived.');
  await expect(cancelButton(page)).toHaveText('Keep editing');
  await cancelButton(page).click();
  await expect(titleField(page)).toHaveValue('Unsaved title');
  await expect(notesField(page)).toHaveValue('Unsaved notes');
  await expect(cancelButton(page)).toHaveText('Cancel');
  expect(control.posts).toHaveLength(0);

  // An authoritative refusal (CSRF) keeps the drafts and Archive available.
  const token = await archiveDisclosure(page).locator('input[name="_csrf"]').inputValue();
  await archiveDisclosure(page).locator('input[name="_csrf"]').evaluate((input) => { input.value = 'stale-token'; });
  await openArchiveConfirmation(page);
  await confirmButton(page).click();
  await expect(dialogStatus(page)).toHaveText('Invalid or missing CSRF token. Nothing was archived. Your unsaved changes are kept.');
  await expect(editDialog(page)).toBeVisible();
  await expect(titleField(page)).toHaveValue('Unsaved title');
  await expect(notesField(page)).toHaveValue('Unsaved notes');
  await expect(archiveButton(page)).toBeFocused();
  expect(release.archived()).toBe(false);
  expect(control.posts).toHaveLength(1);
  expect(gate.forwarded).toBe(1);
  expect(release.archiveLogs()).toBe(0);

  await archiveDisclosure(page).locator('input[name="_csrf"]').evaluate((input, value) => { input.value = value; }, token);
  await openArchiveConfirmation(page);
  await confirmButton(page).click();
  await expect(page.locator('[data-release-detail-archived]')).toHaveCount(1);
  expect(release.archived()).toBe(true);
  expect(control.posts).toHaveLength(2);
  expect(control.savePosts).toHaveLength(0);
  expect(release.row().title).toBe(release.title);
  expect(release.row().notes).toBe('Saved notes');
  await expectSameDocument(page, url);
  expect(errors).toEqual([]);
});

test('D: Archive appears immediately after an acknowledged Edit Save makes the release eligible', async ({ page }) => {
  const project = createProject('Archive D');
  const release = createRelease(project.id, 'Archive D', { publishedDate: '2026-10-01' });
  const url = `/releases/${release.id}`;
  const { control, errors } = await open(page, url);
  await editFromDetail(page, release);
  // Published: Archive is hidden and targetless.
  await expect(archiveDisclosure(page)).toBeHidden();
  await expect(editDialog(page).locator('form[data-release-archive-form]')).toHaveAttribute('action', '');

  await editDialog(page).locator('input[name="publishedDate"]').fill('');
  await saveButton(page).click();
  await expect(editDialog(page)).toBeHidden();
  expect(control.savePosts).toHaveLength(1);
  expect(release.row().published_date).toBeNull();
  // The saved model made it eligible: shown and targeted with no new load.
  const getsAfterSave = control.gets.filter((pathname) => pathname.endsWith('/edit')).length;
  await expect(editDialog(page).locator('[data-release-edit-action="archive"]')).not.toHaveAttribute('hidden', '');
  await expect(editDialog(page).locator('form[data-release-archive-form]')).toHaveAttribute('action', `/releases/${release.id}/archive`);
  expect(control.gets.filter((pathname) => pathname.endsWith('/edit')).length).toBe(getsAfterSave);

  await editFromDetail(page, release);
  await expect(archiveDisclosure(page)).toBeVisible();
  await openArchiveConfirmation(page);
  await confirmButton(page).click();
  await expect(page.locator('[data-release-detail-archived]')).toHaveCount(1);
  expect(release.archived()).toBe(true);
  expect(control.posts).toHaveLength(1);
  await expectSameDocument(page, url);
  expect(control.navigations).toBe(0);
  expect(errors).toEqual([]);
});

test('E: Release Detail — a failed refresh after a confirmed Archive stays truthful and Retry refresh only reads', async ({ page }) => {
  const project = createProject('Archive E');
  const release = createRelease(project.id, 'Archive E');
  const url = `/releases/${release.id}`;
  const { control, errors } = await open(page, url);
  let failRefresh = true;
  await page.route((target) => target.pathname === url, (route) => {
    if (route.request().method() === 'GET' && route.request().resourceType() === 'fetch' && failRefresh) {
      return route.fulfill({ status: 500, body: 'unavailable' });
    }
    return route.fallback();
  });
  await editFromDetail(page, release);
  await openArchiveConfirmation(page);
  await confirmButton(page).click();
  await expect(feedback(page)).toContainText('Release archived, but Release Detail could not refresh. The information shown may be out of date.');
  await expect(feedback(page)).toHaveClass(/notice--error/);
  expect(release.archived()).toBe(true);
  // Review & Publish is withdrawn while the page is stale.
  await expect(page.locator('[data-dialog-open="release-publish-dialog"]')).toHaveCount(0);

  failRefresh = false;
  await feedback(page).getByRole('button', { name: 'Retry refresh' }).click();
  await expect(feedback(page)).toHaveText(`Release “${release.title}” archived.`);
  await expect(page.locator('[data-release-detail-archived]')).toHaveCount(1);
  expect(control.posts).toHaveLength(1);
  expect(gate.forwarded).toBe(1);
  expect(release.archiveLogs()).toBe(1);
  await expectSameDocument(page, url);
  expect(errors).toEqual([]);
});

test('E2: Calendar — a failed refresh keeps the archive acknowledged; Retry refresh is a GET', async ({ page }) => {
  const project = createProject('Archive E2');
  const release = createRelease(project.id, 'Archive E2', { plannedDate: '2031-08-10' });
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
  await openArchiveConfirmation(page);
  await confirmButton(page).click();
  await expect(feedback(page)).toContainText('Release archived, but Calendar could not refresh. The calendar shown may be out of date.');
  expect(release.archived()).toBe(true);
  failRefresh = false;
  await feedback(page).getByRole('button', { name: 'Retry refresh' }).click();
  await expect(page.locator(`[data-release-edit-id="${release.id}"]`)).toHaveCount(0);
  await expect(feedback(page)).toHaveText(`Release “${release.title}” archived.`);
  expect(control.posts).toHaveLength(1);
  await expectSameDocument(page, url);
  expect(errors).toEqual([]);
});

test('F: a lost answer after the service ran — no resend; the GET check is reported as an observation', async ({ page }) => {
  const project = createProject('Archive F');
  const release = createRelease(project.id, 'Archive F');
  const url = `/releases/${release.id}`;
  const { control, errors } = await open(page, url);
  await editFromDetail(page, release);
  await titleField(page).fill('Draft kept through loss');
  control.post = 'lose';
  await openArchiveConfirmation(page);
  await confirmButton(page).click();
  const observed = 'The release is archived now, but this page could not confirm whether that Archive request archived it.';
  await expect(feedback(page)).toContainText(observed);
  expect(release.archived()).toBe(true);
  expect(gate.forwarded).toBe(1);
  expect(release.archiveLogs()).toBe(1);
  expect(control.posts).toHaveLength(1);
  expect(control.gets).toContain(`/releases/${release.id}/edit`);
  await expect(titleField(page)).toHaveValue('Draft kept through loss');
  await expect(archiveButton(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(feedback(page)).toHaveClass(/notice--error/);
  // Release Detail defers its archived render while the dialog is open and
  // says so; Save is refused for the now read-only release; nothing is sent.
  await expect(dialogStatus(page)).toContainText('This release has changed. Close this dialog to load its current details.');
  await page.evaluate(() => document.querySelector('#release-edit-form').requestSubmit());
  expect(control.savePosts).toHaveLength(0);
  // Closing it adopts the archived render.
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-release-detail-archived]')).toHaveCount(1);
  await expect(feedback(page)).toContainText(observed);
  await expect(feedback(page)).toHaveClass(/notice--error/);
  expect(control.posts).toHaveLength(1);
  await expectSameDocument(page, url);
  expect(control.navigations).toBe(0);
  expect(errors).toEqual([]);
});

test('G: a delayed original POST — early GET does not settle it; no second Archive, Save or Publish; released, it archives once', async ({ page }) => {
  const project = createProject('Archive G');
  const release = createRelease(project.id, 'Archive G');
  const url = `/releases/${release.id}`;
  const { control, errors } = await open(page, url);
  await editFromDetail(page, release);
  await notesField(page).fill('Draft notes held');
  gate.holdNext = 1;
  control.post = 'gate';
  await openArchiveConfirmation(page);
  await confirmButton(page).click();
  await expect(dialogStatus(page)).toContainText('The release still shows as active, but the earlier Archive request may still run.');
  expect(gate.arrivals).toBe(1);
  expect(gate.forwarded).toBe(0);
  expect(gate.held).toHaveLength(1);
  expect(release.archived()).toBe(false);
  await expect(notesField(page)).toHaveValue('Draft notes held');
  await expect(feedback(page).getByRole('button', { name: 'Check again' })).toBeVisible();

  // Dismiss and reopen: the drafts and the hold come back.
  await page.keyboard.press('Escape');
  await expect(editDialog(page)).toBeHidden();
  await expectSameDocument(page, url);
  await editFromDetail(page, release);
  await expect(notesField(page)).toHaveValue('Draft notes held');
  await expect(archiveButton(page)).toHaveAttribute('aria-disabled', 'true');
  control.post = 'pass';
  if (!(await archiveDisclosure(page).evaluate((node) => node.open))) await archiveDisclosure(page).locator('summary').click();
  // aria-disabled keeps it focusable; a click still reaches it and is refused.
  await archiveButton(page).click({ force: true });
  await expect(confirmation(page)).toBeHidden();
  await expect(dialogStatus(page)).toContainText('cannot be archived again from this page');
  await saveButton(page).click();
  await expect(dialogStatus(page)).toContainText('Changes cannot be saved while the earlier Archive request is unconfirmed.');
  expect(control.posts).toHaveLength(1);
  expect(control.savePosts).toHaveLength(0);

  // Review & Publish for the same release is refused before it sends.
  await page.keyboard.press('Escape');
  await page.locator('[data-dialog-open="release-publish-dialog"]').click();
  const publishDialog = page.locator('#release-publish-dialog');
  await expect(publishDialog).toBeVisible();
  await publishDialog.locator('[data-dialog-submit]').click();
  await expect(publishDialog.locator('[data-dialog-status]')).toContainText('This release cannot be changed while its Archive request is unconfirmed.');
  expect(control.publishPosts).toHaveLength(0);
  await page.keyboard.press('Escape');
  await expect(publishDialog).toBeHidden();

  // The original request is still live upstream; releasing it archives once.
  gate.release();
  const [upstream] = await Promise.all(control.upstream);
  expect(upstream.status).toBe(200);
  expect(upstream.body).toMatchObject({ outcome: 'archived', releaseId: release.id });
  expect(release.archived()).toBe(true);
  expect(gate.forwarded).toBe(1);
  expect(release.archiveLogs()).toBe(1);
  // Check again (GET only) now observes it without claiming the request did it.
  await feedback(page).getByRole('button', { name: 'Check again' }).click();
  await expect(feedback(page)).toContainText('The release is archived now, but this page could not confirm whether that Archive request archived it.');
  await expect(page.locator('[data-release-detail-archived]')).toHaveCount(1);
  expect(control.posts).toHaveLength(1);
  expect(control.publishPosts).toHaveLength(0);
  expect(control.savePosts).toHaveLength(0);
  await expectSameDocument(page, url);
  expect(control.navigations).toBe(0);
  expect(errors).toEqual([]);
});

test('H: Save in flight refuses Archive before its confirmation; a pending Archive blocks Save and dismissal', async ({ page }) => {
  const project = createProject('Archive H');
  const release = createRelease(project.id, 'Archive H', { plannedDate: '2031-07-10' });
  const url = `/releases/${release.id}`;
  const { control, errors } = await open(page, url);
  await editFromDetail(page, release);
  await titleField(page).fill('Saved during H');
  control.saves = 'hold';
  await saveButton(page).click();
  await expect.poll(() => control.heldSaves.length).toBe(1);
  // The dialog is frozen during the save, so the Archive control is reached
  // programmatically: the secondary-action guard refuses it before confirming.
  await page.evaluate(() => {
    const details = document.querySelector('[data-release-edit-action="archive"]');
    details.open = true;
    details.querySelector('button').click();
  });
  await expect(confirmation(page)).toBeHidden();
  await expect(dialogStatus(page)).toContainText('Wait for the save to finish, then try again.');
  expect(control.posts).toHaveLength(0);
  control.saves = 'pass';
  await control.heldSaves[0].continue();
  await expect(editDialog(page)).toBeHidden();
  expect(release.row().title).toBe('Saved during H');

  // A pending Archive: Save is frozen, Escape keeps the dialog open.
  await editFromDetail(page, release);
  control.post = 'hold';
  await openArchiveConfirmation(page);
  await confirmButton(page).click();
  await expect.poll(() => control.heldPosts.length).toBe(1);
  await expect(dialogStatus(page)).toContainText('Archiving “Saved during H”…');
  await page.keyboard.press('Escape');
  await expect(editDialog(page)).toBeVisible();
  await page.evaluate(() => document.querySelector('#release-edit-form').requestSubmit());
  expect(control.savePosts).toHaveLength(1);
  await control.heldPosts[0].continue();
  await expect(page.locator('[data-release-detail-archived]')).toHaveCount(1);
  expect(control.posts).toHaveLength(1);
  expect(release.archived()).toBe(true);
  expect(release.row().title).toBe('Saved during H');
  await expectSameDocument(page, url);
  expect(errors).toEqual([]);
});

test('I: native and security — a form submitted without the enhancement keeps its POST and redirect; the archived release refuses edits', async ({ page }) => {
  const project = createProject('Archive I');
  const release = createRelease(project.id, 'Archive I');
  const url = `/releases/${release.id}`;
  await open(page, url);
  await editFromDetail(page, release);
  // HTMLFormElement.submit() skips every submit listener: the native contract.
  const navigated = page.waitForEvent('framenavigated', { predicate: (frame) => frame === page.mainFrame() });
  await page.evaluate(() => HTMLFormElement.prototype.submit.call(document.querySelector('form[data-release-archive-form]')))
    .catch(() => {});
  await navigated;
  await page.waitForLoadState('load');
  expect(new URL(page.url()).pathname).toBe(url);
  expect(await page.evaluate(() => window.__sameDocument)).toBeUndefined();
  await expect(page.locator('[data-release-detail-archived]')).toHaveCount(1);
  expect(release.archived()).toBe(true);
  // A request without the session's CSRF token is refused.
  const other = createRelease(project.id, 'Archive I other');
  const refused = await page.request.post(`${baseURL}/releases/${other.id}/archive`, {
    headers: { Accept: 'application/json' }, form: { _csrf: 'wrong' },
  });
  expect(refused.status()).toBe(403);
  expect(other.archived()).toBe(false);
  // An archived release's edit model refuses (what Check again reads).
  const edit = await page.request.get(`${baseURL}/releases/${release.id}/edit`, { headers: { Accept: 'application/json' } });
  expect(edit.status()).toBe(409);
});

test('J: narrow layout — long title, keyboard confirmation, Escape, repeated Enter, reachable Check again', async ({ page }) => {
  const project = createProject('Archive J');
  const longTitle = `Archive J ${'Very long release title segment '.repeat(6)}end`;
  const release = createRelease(project.id, 'Archive J', { title: longTitle });
  const url = `/releases/${release.id}`;
  const { control, errors } = await open(page, url, { width: 375, height: 760 });
  await editFromDetail(page, release);
  await openArchiveConfirmation(page);
  await expect(confirmation(page)).toContainText(`Archive “${longTitle}”?`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(confirmButton(page)).toBeInViewport();
  await page.keyboard.press('Escape');
  await expect(confirmation(page)).toBeHidden();
  await expect(archiveButton(page)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(confirmation(page)).toBeVisible();

  gate.holdNext = 1;
  control.post = 'gate';
  await confirmButton(page).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(dialogStatus(page)).toContainText('The release still shows as active');
  expect(control.posts).toHaveLength(1);
  // The page-level Check again stays reachable once the dialog is dismissed.
  await page.keyboard.press('Escape');
  await expect(editDialog(page)).toBeHidden();
  const check = feedback(page).getByRole('button', { name: 'Check again' });
  await check.scrollIntoViewIfNeeded();
  await expect(check).toBeInViewport();
  await check.click();
  await expect(feedback(page)).toContainText('The release still shows as active');
  expect(control.posts).toHaveLength(1);
  gate.release();
  await Promise.all(control.upstream);
  expect(release.archived()).toBe(true);
  await expectSameDocument(page, url);
  expect(errors).toEqual([]);
});
