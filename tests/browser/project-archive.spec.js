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

// WP11A-1: Archive project from the Edit Project dialog on its hosts (Projects,
// Project Detail, Dashboard, Project Assets) in real Chromium with the compiled
// client, the real route, templates, service and an isolated SQLite database.
// Every test records the Archive POSTs, Edit Save POSTs, read-only GETs, the
// database, document identity and URL. All data lives in a temporary root
// removed afterward; the app listens on its own temporary port.

const ARCHIVE_PATH = /^\/projects\/\d+\/archive$/;
let server;
let proxy;
let db;
let app;
let root;
let baseURL;
let serviceCalls = 0;
let fixtures = 0;

// An upstream gate between the browser and the app: an Archive POST that
// reaches it has fully arrived, but the route and service have not run until
// the gate releases it. holdNext holds that many next arrivals.
const gate = {
  holdNext: 0,
  arrivals: 0,
  held: [],
  release() { this.held.splice(0).forEach((forward) => forward()); },
};

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-project-archive-'));
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
  // Counts how often the real service runs, whatever the browser saw.
  const service = app.locals.projectService;
  const archive = service.archive.bind(service);
  service.archive = (...args) => {
    serviceCalls += 1;
    return archive(...args);
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
      if (req.method === 'POST' && ARCHIVE_PATH.test(new URL(req.url, 'http://gate').pathname)) {
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

function createProject(prefix, overrides = {}) {
  fixtures += 1;
  const project = app.locals.projectService.create({
    title: `${prefix} ${String(fixtures).padStart(3, '0')}`,
    description: 'Saved description',
    notes: 'Saved notes',
    status: 'tbd',
    ...overrides,
  });
  return {
    id: project.id,
    title: project.title,
    row: () => db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id),
    archived: () => db.prepare('SELECT archived_at FROM projects WHERE id = ?').get(project.id).archived_at !== null,
  };
}

function addRelease(projectId, title) {
  return db.prepare(`
    INSERT INTO releases (project_id, title, description, notes, planned_date, published_date, patreon_url)
    VALUES (?, ?, '', '', NULL, NULL, NULL) RETURNING id
  `).get(projectId, title).id;
}

// control.post: 'pass' | 'hold' | 'lose' | 'gate' for Archive POSTs. lose lets
// the real request run first and then fails the browser's fetch; gate sends it
// on to the upstream gate and, once it has arrived there, fails the browser's
// fetch, so the request stays alive upstream while the page loses its answer.
// control.saves: 'pass' | 'hold' for Edit Save POSTs (POST /projects/:id).
async function open(page, url, { width = 1280, height = 900 } = {}) {
  const control = {
    post: 'pass', saves: 'pass', posts: [], heldPosts: [], savePosts: [], heldSaves: [], gets: [], upstream: [], navigations: 0,
  };
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() === 'POST' && ARCHIVE_PATH.test(pathname)) control.posts.push(request);
    else if (request.method() === 'POST' && /^\/projects\/\d+$/.test(pathname)) control.savePosts.push(request);
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
  await page.route((target) => /^\/projects\/\d+$/.test(target.pathname), async (route) => {
    if (route.request().method() === 'POST' && control.saves === 'hold') { control.heldSaves.push(route); return undefined; }
    return route.fallback();
  });
  await page.setViewportSize({ width, height });
  await page.goto(`${baseURL}${url}`);
  await page.locator('[data-project-edit-id]').first().waitFor({ state: 'attached' });
  control.navigations = 0;
  await page.evaluate(() => { window.__sameDocument = true; });
  return { control, errors };
}

const editDialog = (page) => page.locator('#project-edit-dialog');
const confirmation = (page) => page.locator('#app-confirmation-dialog');
const confirmButton = (page) => confirmation(page).locator('[data-app-dialog-confirmation-confirm]');
const cancelButton = (page) => confirmation(page).locator('[data-app-dialog-confirmation-cancel]');
const archiveDisclosure = (page) => editDialog(page).locator('[data-project-edit-action="archive"]');
const archiveButton = (page) => archiveDisclosure(page).getByRole('button', { name: 'Archive project' });
const dialogStatus = (page) => editDialog(page).locator('[data-dialog-status]');
const feedback = (page) => page.locator('[data-dialog-feedback]');
const titleField = (page) => editDialog(page).locator('input[name="title"]');
const notesField = (page) => editDialog(page).locator('textarea[name="notes"]');

async function loaded(page) {
  await expect(editDialog(page)).toBeVisible();
  await expect(editDialog(page).locator('.app-dialog-body')).toBeVisible();
  await expect(editDialog(page).locator('button[data-dialog-submit]')).toBeEnabled();
}

async function editFromList(page, project) {
  await page.locator('[data-dashboard-title-info-bound="true"]').first().waitFor({ state: 'attached' });
  await page.locator(`[aria-controls="projects-list-info-${project.id}"]`).click();
  await page.locator(`#projects-list-info-${project.id}`).getByRole('link', { name: 'Edit project' }).click();
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

const LIST = '/projects?view=list&sort=title&order=asc';

test('A: Projects — local confirmation; Cancel/Escape send nothing; one confirmed POST archives in place', async ({ page }) => {
  const target = createProject('Archive A');
  const neighbour = createProject('Archive A');
  const { control, errors } = await open(page, LIST);
  await editFromList(page, target);

  await openArchiveConfirmation(page);
  await expect(confirmation(page)).toContainText(`Archive “${target.title}”? It keeps its data, assets and releases, but becomes archived and read-only. This cannot be undone.`);
  await expect(confirmButton(page)).toHaveText('Archive project');
  await cancelButton(page).click();
  await expect(confirmation(page)).toBeHidden();
  await expect(editDialog(page)).toBeVisible();
  await expect(archiveButton(page)).toBeFocused();

  await archiveButton(page).click();
  await expect(confirmation(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(confirmation(page)).toBeHidden();
  await expect(editDialog(page)).toBeVisible();
  // The backdrop dismisses the confirmation only.
  await archiveButton(page).click();
  await expect(confirmation(page)).toBeVisible();
  await page.mouse.click(4, 4);
  await expect(confirmation(page)).toBeHidden();
  await expect(editDialog(page)).toBeVisible();
  // requestSubmit never bypasses the confirmation.
  await page.evaluate(() => document.querySelector('form[data-project-archive-form]').requestSubmit());
  await expect(confirmation(page)).toBeVisible();
  await cancelButton(page).click();
  await expect(confirmation(page)).toBeHidden();
  expect(control.posts).toHaveLength(0);
  expect(serviceCalls).toBe(0);
  expect(target.archived()).toBe(false);

  await archiveButton(page).click();
  await expect(confirmation(page)).toBeVisible();
  // Enter on the focused confirm control; key repeat cannot send twice.
  await confirmButton(page).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(editDialog(page)).toBeHidden();
  await expect(feedback(page)).toHaveText(`Project “${target.title}” archived.`);
  await expect(feedback(page)).toHaveClass(/notice--success/);
  expect(control.posts).toHaveLength(1);
  expect(serviceCalls).toBe(1);
  expect(target.archived()).toBe(true);
  expect(target.row().status).toBe('archived');

  // The default (active) filter no longer lists it; the neighbour stays, and
  // the page, its URL and its view are the same document.
  await expect(page.locator(`[aria-controls="projects-list-info-${target.id}"]`)).toHaveCount(0);
  await expect(page.locator(`[aria-controls="projects-list-info-${neighbour.id}"]`)).toHaveCount(1);
  await expectSameDocument(page, LIST);
  expect(control.navigations).toBe(0);
  // Focus lost with the row goes to the main content, and Enter does nothing.
  await expect(page.locator('#main-content')).toBeFocused();
  await page.keyboard.press('Enter');
  expect(control.posts).toHaveLength(1);
  expect(control.navigations).toBe(0);
  expect(control.savePosts).toHaveLength(0);
  expect(errors).toEqual([]);
});

test('A2: Projects with the Archived filter keeps the archived row in place', async ({ page }) => {
  const target = createProject('Archive A2');
  const url = '/projects?view=list&status=tbd&status=archived&sort=title&order=asc';
  const { control, errors } = await open(page, url);
  await editFromList(page, target);
  await openArchiveConfirmation(page);
  await confirmButton(page).click();
  await expect(feedback(page)).toHaveText(`Project “${target.title}” archived.`);
  await expect(page.locator(`[data-project-id="${target.id}"]`)).toHaveClass(/projects-list-row--archived/);
  await expectSameDocument(page, url);
  expect(control.posts).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('B: Project Detail — archives in place and shows the read-only state; releases and media stay', async ({ page }) => {
  const project = createProject('Archive B');
  addRelease(project.id, 'Kept Release');
  const url = `/projects/${project.id}`;
  const { control, errors } = await open(page, url);
  await page.locator('.project-detail-releases .release-list').evaluate((node) => { node.dataset.kept = 'yes'; });
  await expect(page.getByRole('link', { name: 'Create release record' })).toBeVisible();
  await page.locator(`[data-project-edit-id="${project.id}"]`).click();
  await loaded(page);
  await openArchiveConfirmation(page);
  await confirmButton(page).click();
  await expect(editDialog(page)).toBeHidden();
  await expect(feedback(page)).toHaveText(`Project “${project.title}” archived.`);

  expect(project.archived()).toBe(true);
  await expect(page.locator('.page-heading .status-badge')).toHaveText(/archived/i);
  await expect(page.getByText('This project is archived and read-only. Editing, releases, and asset scanning are restricted.')).toBeVisible();
  await expect(page.locator(`[data-project-edit-id="${project.id}"]`)).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Create release record' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'View release records' })).toBeVisible();
  await expect(page.locator('.project-detail-info')).toContainText('Archived');
  // The Releases list outside the refreshed regions is the same element.
  await expect(page.locator('.project-detail-releases .release-list[data-kept="yes"]')).toHaveCount(1);
  await expect(page.locator('#main-content')).toBeFocused();
  await expectSameDocument(page, url);
  expect(control.posts).toHaveLength(1);
  expect(control.navigations).toBe(0);
  expect(control.gets).toContain(`/projects/${project.id}`);
  expect(errors).toEqual([]);
});

test('C: Dashboard — archives from the project information card; the row leaves and the status filter stays', async ({ page }) => {
  const target = createProject('Archive C');
  const other = createProject('Archive C');
  const { control, errors } = await open(page, '/');
  await page.locator('[data-dashboard-title-info-bound="true"]').first().waitFor({ state: 'attached' });
  const tbdFilter = page.locator('[data-dashboard-status-filter="tbd"]');
  await tbdFilter.click();
  await expect(tbdFilter).toHaveAttribute('aria-pressed', 'true');
  const cardId = `dashboard-project-info-table-${target.id}`;
  await page.locator(`[aria-controls="${cardId}"]`).click();
  await page.locator(`#${cardId}`).getByRole('link', { name: 'Edit project' }).click();
  await loaded(page);
  await openArchiveConfirmation(page);
  await confirmButton(page).click();
  await expect(editDialog(page)).toBeHidden();
  await expect(page.locator(`[aria-controls="${cardId}"]`)).toHaveCount(0);
  await expect(page.locator(`[aria-controls="dashboard-project-info-table-${other.id}"]`)).toHaveCount(1);
  await expect(page.locator('[data-dashboard-status-filter="tbd"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(feedback(page)).toHaveText(`Project “${target.title}” archived.`);
  await expect(page.locator('[data-dashboard-sync]')).toBeHidden();
  expect(target.archived()).toBe(true);
  await expectSameDocument(page, '/');
  expect(control.posts).toHaveLength(1);
  expect(control.navigations).toBe(0);
  expect(errors).toEqual([]);
});

test('D: unsaved Edit drafts — warned, kept on Cancel and on refusal, never saved, discarded only on success', async ({ page }) => {
  const project = createProject('Archive D');
  const { control, errors } = await open(page, LIST);
  await editFromList(page, project);
  await titleField(page).fill('Unsaved title');
  await notesField(page).fill('Unsaved notes');

  await openArchiveConfirmation(page);
  await expect(confirmation(page).locator('#app-confirmation-dialog-title')).toHaveText('Archive project with unsaved changes?');
  await expect(confirmation(page)).toContainText(`Archive “${project.title}”?`);
  await expect(confirmation(page)).toContainText('Your unsaved Edit Project changes (title and notes) will not be saved: they are kept if you cancel or the project is not archived, and lost if it is archived.');
  await expect(cancelButton(page)).toHaveText('Keep editing');
  await cancelButton(page).click();
  await expect(confirmation(page)).toBeHidden();
  await expect(titleField(page)).toHaveValue('Unsaved title');
  await expect(notesField(page)).toHaveValue('Unsaved notes');
  // The shared confirmation returns to its own labels.
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
  expect(project.archived()).toBe(false);
  expect(control.posts).toHaveLength(1);
  expect(serviceCalls).toBe(0);

  await archiveDisclosure(page).locator('input[name="_csrf"]').evaluate((input, value) => { input.value = value; }, token);
  await openArchiveConfirmation(page);
  await confirmButton(page).click();
  await expect(editDialog(page)).toBeHidden();
  expect(project.archived()).toBe(true);
  expect(control.posts).toHaveLength(2);
  expect(control.savePosts).toHaveLength(0);
  // Nothing in the drafts was saved.
  expect(project.row().title).toBe(project.title);
  expect(project.row().notes).toBe('Saved notes');
  await expectSameDocument(page, LIST);
  expect(errors).toEqual([]);
});

test('E: a failed refresh after a confirmed Archive stays truthful and Retry refresh only reads', async ({ page }) => {
  const project = createProject('Archive E');
  const { control, errors } = await open(page, LIST);
  await editFromList(page, project);
  let failRefresh = true;
  await page.route((target) => target.pathname === '/projects', (route) => {
    if (route.request().method() === 'GET' && route.request().resourceType() === 'fetch' && failRefresh) {
      return route.fulfill({ status: 500, body: 'unavailable' });
    }
    return route.fallback();
  });
  await openArchiveConfirmation(page);
  await confirmButton(page).click();
  await expect(feedback(page)).toContainText(`Project “${project.title}” archived. Projects could not refresh, so the information shown may be out of date.`);
  await expect(feedback(page)).toHaveClass(/notice--error/);
  expect(project.archived()).toBe(true);
  // The stale list still shows the row until the refresh succeeds.
  await expect(page.locator(`[aria-controls="projects-list-info-${project.id}"]`)).toHaveCount(1);

  failRefresh = false;
  await feedback(page).getByRole('button', { name: 'Retry refresh' }).click();
  await expect(feedback(page)).toHaveText(`Project “${project.title}” archived.`);
  await expect(page.locator(`[aria-controls="projects-list-info-${project.id}"]`)).toHaveCount(0);
  expect(control.posts).toHaveLength(1);
  expect(serviceCalls).toBe(1);
  await expectSameDocument(page, LIST);
  expect(errors).toEqual([]);
});

test('E2: Project Detail failed refresh offers Retry refresh with GET only', async ({ page }) => {
  const project = createProject('Archive E2');
  const url = `/projects/${project.id}`;
  const { control, errors } = await open(page, url);
  let failRefresh = true;
  await page.route((target) => target.pathname === url, (route) => {
    if (route.request().method() === 'GET' && route.request().resourceType() === 'fetch' && failRefresh) {
      return route.fulfill({ status: 500, body: 'unavailable' });
    }
    return route.fallback();
  });
  await page.locator(`[data-project-edit-id="${project.id}"]`).click();
  await loaded(page);
  await openArchiveConfirmation(page);
  await confirmButton(page).click();
  await expect(feedback(page)).toContainText('Project Detail could not refresh, so the information shown may be out of date.');
  failRefresh = false;
  await feedback(page).getByRole('button', { name: 'Retry refresh' }).click();
  await expect(feedback(page)).toHaveText(`Project “${project.title}” archived.`);
  await expect(page.locator(`[data-project-edit-id="${project.id}"]`)).toHaveCount(0);
  expect(control.posts).toHaveLength(1);
  await expectSameDocument(page, url);
  expect(errors).toEqual([]);
});

test('F: a lost answer after the service ran — no resend; the GET check is reported as an observation', async ({ page }) => {
  const project = createProject('Archive F');
  const { control, errors } = await open(page, LIST);
  await editFromList(page, project);
  await titleField(page).fill('Draft kept through loss');
  control.post = 'lose';
  await openArchiveConfirmation(page);
  await confirmButton(page).click();
  await expect(dialogStatus(page)).toHaveText('The project is archived now, but this page could not confirm whether that Archive request archived it. Your unsaved changes are kept here, but this project can no longer be edited.');
  expect(project.archived()).toBe(true);
  expect(serviceCalls).toBe(1);
  expect(control.posts).toHaveLength(1);
  expect(control.gets).toContain(`/projects/${project.id}/edit`);
  await expect(editDialog(page)).toBeVisible();
  await expect(titleField(page)).toHaveValue('Draft kept through loss');
  await expect(archiveButton(page)).toHaveAttribute('aria-disabled', 'true');
  // Never a success tone for an unproven outcome.
  await expect(feedback(page)).toHaveClass(/notice--error/);

  // Archive and Save are refused for it now; nothing is sent. (aria-disabled
  // keeps the control focusable, so a real click still arrives.)
  await archiveButton(page).click({ force: true });
  await expect(confirmation(page)).toBeHidden();
  await editDialog(page).locator('button[data-dialog-submit]').click();
  await expect(dialogStatus(page)).toContainText('This project is archived and read-only, so it cannot be archived or saved again.');
  expect(control.posts).toHaveLength(1);
  expect(control.savePosts).toHaveLength(0);
  await page.keyboard.press('Escape');
  await expect(editDialog(page)).toBeHidden();
  await expect(page.locator(`[aria-controls="projects-list-info-${project.id}"]`)).toHaveCount(0);
  await expectSameDocument(page, LIST);
  expect(errors).toEqual([]);
});

test('G: a delayed original POST — an early GET showing it active never clears the hold; no second POST', async ({ page }) => {
  const project = createProject('Archive G');
  const { control, errors } = await open(page, LIST);
  await editFromList(page, project);
  await titleField(page).fill('Draft across the delay');
  gate.holdNext = 1;
  control.post = 'gate';
  await openArchiveConfirmation(page);
  await confirmButton(page).click();

  await expect(dialogStatus(page)).toContainText('Could not confirm whether the project was archived. The project still shows as active, but the earlier Archive request may still run.');
  expect(gate.arrivals).toBe(1);
  expect(gate.held).toHaveLength(1);
  expect(serviceCalls).toBe(0);
  expect(project.archived()).toBe(false);
  await expect(archiveButton(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(feedback(page)).toContainText('the earlier Archive request may still run');
  await expect(feedback(page).getByRole('button', { name: 'Check again' })).toBeVisible();

  // Another Archive and a Save in the same host are refused, never queued.
  control.post = 'pass';
  await archiveButton(page).click({ force: true });
  await expect(confirmation(page)).toBeHidden();
  await expect(dialogStatus(page)).toContainText('The earlier Archive request has not been confirmed, so this project cannot be archived again from this page.');
  await editDialog(page).locator('button[data-dialog-submit]').click();
  await expect(dialogStatus(page)).toContainText('Changes cannot be saved while the earlier Archive request is unconfirmed.');
  expect(control.savePosts).toHaveLength(0);

  // Dismissal and reopening keep the drafts and the warning.
  await page.keyboard.press('Escape');
  await expect(editDialog(page)).toBeHidden();
  // Reopened from the keyboard: the warning above the list moves the title,
  // so a pointer would open the hover card over it.
  const reopen = page.locator(`[aria-controls="projects-list-info-${project.id}"]`);
  await page.locator('#main-content').focus();
  await reopen.focus();
  await page.keyboard.press('Enter');
  await page.locator(`#projects-list-info-${project.id}`).getByRole('link', { name: 'Edit project' }).focus();
  await page.keyboard.press('Enter');
  await loaded(page);
  await expect(titleField(page)).toHaveValue('Draft across the delay');
  await expect(dialogStatus(page)).toContainText('the earlier Archive request may still run');
  // The disclosure is closed again on each load; the control keeps its hold.
  await expect(archiveDisclosure(page).locator('form[data-project-archive-form]')).toHaveAttribute('data-project-archive-hold', 'unresolved');
  await expect(archiveDisclosure(page).locator('button[data-confirm]')).toHaveAttribute('aria-disabled', 'true');
  await editDialog(page).getByRole('button', { name: 'Check again' }).click();
  await expect(dialogStatus(page)).toContainText('The project still shows as active');
  expect(project.archived()).toBe(false);

  // The original request finally runs; Check again (a GET) observes it.
  gate.release();
  await expect.poll(() => project.archived()).toBe(true);
  const [upstream] = await Promise.all(control.upstream);
  expect(upstream.status).toBe(200);
  await editDialog(page).getByRole('button', { name: 'Check again' }).click();
  await expect(dialogStatus(page)).toContainText('The project is archived now, but this page could not confirm whether that Archive request archived it.');
  expect(gate.arrivals).toBe(1);
  expect(serviceCalls).toBe(1);
  expect(control.posts).toHaveLength(1);
  await expectSameDocument(page, LIST);
  expect(errors).toEqual([]);
});

test('H: Edit Save and Archive never overlap, in either order', async ({ page }) => {
  const project = createProject('Archive H');
  const url = `/projects/${project.id}`;
  const { control, errors } = await open(page, url);
  await page.locator(`[data-project-edit-id="${project.id}"]`).click();
  await loaded(page);

  // A Save in flight refuses Archive before the confirmation opens.
  control.saves = 'hold';
  await titleField(page).fill('Saved during H');
  await editDialog(page).locator('button[data-dialog-submit]').click();
  await expect.poll(() => control.heldSaves.length).toBe(1);
  await archiveDisclosure(page).locator('summary').click({ force: true }).catch(() => {});
  await archiveButton(page).click({ force: true }).catch(() => {});
  await expect(confirmation(page)).toBeHidden();
  expect(control.posts).toHaveLength(0);
  control.saves = 'pass';
  await control.heldSaves[0].continue();
  await expect(editDialog(page)).toBeHidden();
  await expect.poll(() => project.row().title).toBe('Saved during H');

  // An Archive in flight freezes the dialog: Save cannot be sent.
  await page.locator(`[data-project-edit-id="${project.id}"]`).click();
  await loaded(page);
  await titleField(page).fill('Never saved');
  control.post = 'hold';
  await openArchiveConfirmation(page);
  await confirmButton(page).click();
  await expect.poll(() => control.heldPosts.length).toBe(1);
  await expect(dialogStatus(page)).toHaveText('Archiving “Saved during H”…');
  await editDialog(page).locator('button[data-dialog-submit]').click({ force: true, timeout: 2000 }).catch(() => {});
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(editDialog(page)).toBeVisible();
  expect(control.savePosts).toHaveLength(1);
  await control.heldPosts[0].continue();
  await expect(editDialog(page)).toBeHidden();
  expect(project.archived()).toBe(true);
  expect(project.row().title).toBe('Saved during H');
  expect(control.posts).toHaveLength(1);
  expect(control.savePosts).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('I: native Archive without JavaScript keeps its redirect; CSRF is enforced', async ({ browser, request }) => {
  const project = createProject('Archive I');
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(`${baseURL}/projects/${project.id}?edit=1`);
  await page.locator('[data-project-edit-action="archive"] summary').click();
  await page.locator('[data-project-edit-action="archive"]').getByRole('button', { name: 'Archive project' }).click();
  await page.waitForURL(`${baseURL}/projects`);
  expect(project.archived()).toBe(true);
  await context.close();

  const other = createProject('Archive I');
  const refused = await request.post(`${baseURL}/projects/${other.id}/archive`, {
    form: { _csrf: 'wrong' }, maxRedirects: 0,
  });
  expect(refused.status()).toBe(403);
  expect(other.archived()).toBe(false);
});

test('J: Archive follows the authoritative saved project after an Edit Save, without replacing the page', async ({ page }) => {
  const project = createProject('Archive J');
  const url = `/projects/${project.id}`;
  const { control, errors } = await open(page, url, { width: 390, height: 844 });
  await page.locator(`[data-project-edit-id="${project.id}"]`).click();
  await loaded(page);
  await titleField(page).fill('Renamed J');
  await editDialog(page).locator('button[data-dialog-submit]').click();
  await expect(editDialog(page)).toBeHidden();
  await expect(feedback(page)).toHaveText('Project updated.');

  // The refreshed Edit action reopens the saved project; Archive names it.
  await page.locator(`[data-project-edit-id="${project.id}"]`).click();
  await loaded(page);
  await expect(archiveDisclosure(page)).toBeVisible();
  await openArchiveConfirmation(page);
  await expect(confirmation(page)).toContainText('Archive “Renamed J”?');
  // Narrow layout: the confirmation fits without horizontal scroll.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await confirmButton(page).click();
  await expect(feedback(page)).toHaveText('Project “Renamed J” archived.');
  await expect(page.locator(`[data-project-edit-id="${project.id}"]`)).toHaveCount(0);
  expect(control.posts).toHaveLength(1);
  expect(control.savePosts).toHaveLength(1);
  await expectSameDocument(page, url);
  expect(errors).toEqual([]);
});

test('K: Project Assets — archives in place and becomes read-only', async ({ page }) => {
  const project = createProject('Archive K');
  const url = `/projects/${project.id}/assets`;
  const { control, errors } = await open(page, url);
  await page.locator('.page-heading [data-project-edit-id]').click();
  await loaded(page);
  await openArchiveConfirmation(page);
  await confirmButton(page).click();
  await expect(editDialog(page)).toBeHidden();
  await expect(feedback(page)).toHaveText(`Project “${project.title}” archived.`);
  await expect(page.locator('[data-project-assets-archived-notice]')).toBeVisible();
  await expect(page.locator('.page-heading [data-project-edit-id]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Manually scan project files' })).toHaveCount(0);
  expect(project.archived()).toBe(true);
  await expectSameDocument(page, url);
  expect(control.posts).toHaveLength(1);
  expect(control.navigations).toBe(0);
  expect(errors).toEqual([]);
});

// WP11A-F1: Project Detail's deep link (?edit=1&returnTo=) goes back to its
// invoking page when the dialog is dismissed. While this page holds an
// Archive that would discard the hold, the drafts and Check again with the
// document, so a dismissal stays on the page; with nothing held it returns.
const deepLink = (project, returnTo = `/projects/${project.id}/assets`) => ({
  returnTo,
  url: `/projects/${project.id}?edit=1&returnTo=${encodeURIComponent(returnTo)}`,
});
const settle = (page) => page.waitForTimeout(400);
const saveButton = (page) => editDialog(page).locator('button[data-dialog-submit]');
const descriptionField = (page) => editDialog(page).locator('textarea[name="description"]');
const closeControl = (page) => editDialog(page).locator('[data-dialog-close]').first();

async function editFromHeading(page, project) {
  await page.locator(`[data-project-edit-id="${project.id}"]`).first().click();
  await loaded(page);
}

test('F1-B2 / B4: deep link — a delayed Archive held upstream; Escape, Close and backdrop stay, drafts and hold survive; release archives once', async ({ page }) => {
  const project = createProject('Archive F1 B2');
  const { url } = deepLink(project);
  const { control, errors } = await open(page, url);
  await loaded(page);
  await titleField(page).fill('Renamed while archive held');
  await descriptionField(page).fill('Draft description while held');
  await notesField(page).fill('Draft notes while held');

  gate.holdNext = 1;
  control.post = 'gate';
  await openArchiveConfirmation(page);
  await confirmButton(page).click();
  await expect(dialogStatus(page)).toContainText('The project still shows as active, but the earlier Archive request may still run.');
  expect(gate.arrivals).toBe(1);
  expect(gate.held).toHaveLength(1);
  expect(serviceCalls).toBe(0);
  expect(project.archived()).toBe(false);
  expect(control.gets).toContain(`/projects/${project.id}/edit`);
  control.post = 'pass';

  const dismissals = [
    ['Escape', () => page.keyboard.press('Escape')],
    ['Close', () => closeControl(page).click()],
    ['backdrop', () => page.mouse.click(4, 4)],
  ];
  for (const [name, dismiss] of dismissals) {
    await dismiss();
    await expect(editDialog(page), name).toBeHidden();
    await settle(page);
    expect(control.navigations, name).toBe(0);
    await expectSameDocument(page, url);
    expect(await page.evaluate(() => document.activeElement && document.activeElement !== document.body)).toBe(true);
    await expect(feedback(page), name).toContainText('the earlier Archive request may still run');
    await expect(feedback(page).getByRole('button', { name: 'Check again' })).toBeVisible();

    await editFromHeading(page, project);
    await expect(titleField(page)).toHaveValue('Renamed while archive held');
    await expect(descriptionField(page)).toHaveValue('Draft description while held');
    await expect(notesField(page)).toHaveValue('Draft notes while held');
    await expect(archiveDisclosure(page).locator('form[data-project-archive-form]')).toHaveAttribute('data-project-archive-hold', 'unresolved');

    const reads = control.gets.length;
    await editDialog(page).getByRole('button', { name: 'Check again' }).click();
    await expect(dialogStatus(page)).toContainText('The project still shows as active');
    expect(control.gets.length).toBe(reads + 1);

    await saveButton(page).click();
    await expect(dialogStatus(page)).toContainText('Changes cannot be saved while the earlier Archive request is unconfirmed.');
    if (!(await archiveDisclosure(page).evaluate((node) => node.open))) await archiveDisclosure(page).locator('summary').click();
    await archiveButton(page).click({ force: true });
    await expect(confirmation(page)).toBeHidden();
    expect(control.posts).toHaveLength(1);
    expect(control.savePosts).toHaveLength(0);
  }
  await page.keyboard.press('Escape');
  await expect(editDialog(page)).toBeHidden();
  await settle(page);
  expect(control.navigations).toBe(0);
  expect(project.row().title).toBe(project.title);

  // The original request finally runs, once, on the project as it was.
  gate.release();
  await expect.poll(() => project.archived()).toBe(true);
  const [upstream] = await Promise.all(control.upstream);
  expect(upstream.status).toBe(200);
  expect(project.row().title).toBe(project.title);
  await feedback(page).getByRole('button', { name: 'Check again' }).click();
  await expect(feedback(page)).toContainText('The project is archived now, but this page could not confirm whether that Archive request archived it.');
  expect(gate.arrivals).toBe(1);
  expect(serviceCalls).toBe(1);
  expect(control.posts).toHaveLength(1);
  expect(control.savePosts).toHaveLength(0);
  expect(control.navigations).toBe(0);
  await expectSameDocument(page, url);
  expect(errors).toEqual([]);
});

test('F1-B5: deep link with nothing held — Escape and Close return to the invoking page as before', async ({ page }) => {
  const project = createProject('Archive F1 B5');
  const { url, returnTo } = deepLink(project);
  const { control, errors } = await open(page, url);
  await loaded(page);
  await page.keyboard.press('Escape');
  await page.waitForURL(`${baseURL}${returnTo}`);
  expect(control.navigations).toBe(1);

  const { url: otherUrl, returnTo: otherReturn } = deepLink(project, '/projects?status=tbd');
  await page.goto(`${baseURL}${otherUrl}`);
  await loaded(page);
  await closeControl(page).click();
  await page.waitForURL(`${baseURL}${otherReturn}`);
  expect(control.posts).toHaveLength(0);
  expect(project.archived()).toBe(false);
  expect(errors).toEqual([]);
});

test('F1-B6: deep link — an authoritative Archive refusal keeps the drafts; the next dismissal returns as before', async ({ page }) => {
  const project = createProject('Archive F1 B6');
  const { url, returnTo } = deepLink(project);
  const { control, errors } = await open(page, url);
  await loaded(page);
  await titleField(page).fill('Draft through refusal');
  await archiveDisclosure(page).locator('input[name="_csrf"]').evaluate((input) => { input.value = 'stale-token'; });
  await openArchiveConfirmation(page);
  await confirmButton(page).click();
  await expect(dialogStatus(page)).toContainText('Nothing was archived. Your unsaved changes are kept.');
  await expect(titleField(page)).toHaveValue('Draft through refusal');
  expect(serviceCalls).toBe(0);
  expect(control.navigations).toBe(0);
  await page.keyboard.press('Escape');
  await page.waitForURL(`${baseURL}${returnTo}`);
  expect(control.navigations).toBe(1);
  expect(project.archived()).toBe(false);
  expect(project.row().title).toBe(project.title);
  expect(control.posts).toHaveLength(1);
  expect(errors).toEqual([]);
});
