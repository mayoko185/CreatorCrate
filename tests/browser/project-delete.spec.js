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

// WP11A-2: Delete project from the Edit Project dialog on its hosts (Projects,
// Dashboard, Project Detail, Project Assets) in real Chromium with the compiled
// client, the real route, templates, service (ownership-verified quarantine,
// transaction, cleanup) and an isolated SQLite database and projects folder.
// Every test records the Delete POSTs, Edit Save and Archive POSTs, read-only
// GETs, the database, the folders, document identity and URL. All data lives
// in a temporary root removed afterward; the app listens on its own port.

const DELETE_PATH = /^\/projects\/\d+\/delete$/;
const ARCHIVE_PATH = /^\/projects\/\d+\/archive$/;
let server;
let proxy;
let db;
let app;
let root;
let projectsRoot;
let baseURL;
let serviceCalls = 0;
let fixtures = 0;

// An upstream gate between the browser and the app: a Delete POST that
// reaches it has fully arrived, but the route and service have not run until
// the gate releases it. holdNext holds that many next arrivals.
const gate = {
  holdNext: 0,
  arrivals: 0,
  held: [],
  release() { this.held.splice(0).forEach((forward) => forward()); },
};

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-project-delete-'));
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
  const service = app.locals.projectService;
  const deleteProject = service.deleteProject.bind(service);
  service.deleteProject = (...args) => {
    serviceCalls += 1;
    return deleteProject(...args);
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
      if (req.method === 'POST' && DELETE_PATH.test(new URL(req.url, 'http://gate').pathname)) {
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
  const dir = path.join(projectsRoot, project.project_dir);
  fs.writeFileSync(path.join(dir, 'owned-file.txt'), 'owned');
  return {
    id: project.id,
    title: project.title,
    dir,
    row: () => db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id),
    exists: () => Boolean(db.prepare('SELECT 1 FROM projects WHERE id = ?').get(project.id)),
    folder: () => fs.existsSync(dir),
  };
}

function addRelease(projectId, title) {
  return db.prepare(`
    INSERT INTO releases (project_id, title, description, notes, planned_date, published_date, patreon_url)
    VALUES (?, ?, '', '', NULL, NULL, NULL) RETURNING id
  `).get(projectId, title).id;
}

const quarantineEntries = () => fs.readdirSync(projectsRoot).filter((name) => name.startsWith('.cc-quarantine-'));

// control.post: 'pass' | 'hold' | 'lose' | 'gate' for Delete POSTs. lose lets
// the real request run first and then fails the browser's fetch; gate sends it
// on to the upstream gate and, once it has arrived there, fails the browser's
// fetch, so the original request stays alive upstream while the page loses
// its answer. control.saves / control.archives: 'pass' | 'hold'.
async function open(page, url, { width = 1280, height = 900 } = {}) {
  const control = {
    post: 'pass', saves: 'pass', archives: 'pass', posts: [], heldPosts: [], savePosts: [], heldSaves: [],
    archivePosts: [], heldArchives: [], gets: [], upstream: [], navigations: 0,
  };
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() === 'POST' && DELETE_PATH.test(pathname)) control.posts.push(request);
    else if (request.method() === 'POST' && ARCHIVE_PATH.test(pathname)) control.archivePosts.push(request);
    else if (request.method() === 'POST' && /^\/projects\/\d+$/.test(pathname)) control.savePosts.push(request);
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
const deleteDisclosure = (page) => editDialog(page).locator('[data-project-edit-action="delete"]');
const deleteButton = (page) => deleteDisclosure(page).getByRole('button', { name: 'Delete project' });
const archiveDisclosure = (page) => editDialog(page).locator('[data-project-edit-action="archive"]');
const archiveButton = (page) => archiveDisclosure(page).getByRole('button', { name: 'Archive project' });
const saveButton = (page) => editDialog(page).locator('button[data-dialog-submit]');
const dialogStatus = (page) => editDialog(page).locator('[data-dialog-status]');
const feedback = (page) => page.locator('[data-dialog-feedback]');
const titleField = (page) => editDialog(page).locator('input[name="title"]');
const notesField = (page) => editDialog(page).locator('textarea[name="notes"]');
const descriptionField = (page) => editDialog(page).locator('textarea[name="description"]');

async function loaded(page) {
  await expect(editDialog(page)).toBeVisible();
  await expect(editDialog(page).locator('.app-dialog-body')).toBeVisible();
  await expect(saveButton(page)).toBeEnabled();
}

async function editFromList(page, project) {
  await page.locator('[data-dashboard-title-info-bound="true"]').first().waitFor({ state: 'attached' });
  await page.locator(`[aria-controls="projects-list-info-${project.id}"]`).click();
  await page.locator(`#projects-list-info-${project.id}`).getByRole('link', { name: 'Edit project' }).click();
  await loaded(page);
}

async function editFromHeading(page, project) {
  await page.locator(`[data-project-edit-id="${project.id}"]`).first().click();
  await loaded(page);
}

async function openDisclosure(disclosure) {
  if (!(await disclosure.evaluate((node) => node.open))) await disclosure.locator('summary').click();
}

async function openDeleteConfirmation(page) {
  await openDisclosure(deleteDisclosure(page));
  await deleteButton(page).click();
  await expect(confirmation(page)).toBeVisible();
}

async function expectSameDocument(page, url) {
  expect(await page.evaluate(() => window.__sameDocument)).toBe(true);
  const current = new URL(page.url());
  expect(current.pathname + current.search).toBe(url);
}

const LIST = '/projects?view=list&sort=title&order=asc';
const SCOPE = 'This deletes the project, its releases, its assets and its project folder with every file in it';

test('A: Projects — local confirmation; Cancel/Escape/backdrop/requestSubmit send nothing; one confirmed POST deletes in place', async ({ page }) => {
  const target = createProject('Delete A');
  const neighbour = createProject('Delete A');
  addRelease(target.id, 'Goes with it');
  const { control, errors } = await open(page, LIST);
  await editFromList(page, target);

  await openDeleteConfirmation(page);
  await expect(confirmation(page).locator('#app-confirmation-dialog-title')).toHaveText('Delete project?');
  await expect(confirmation(page)).toContainText(`Delete “${target.title}” permanently? ${SCOPE}`);
  await expect(confirmation(page)).toContainText('This cannot be undone.');
  await expect(confirmButton(page)).toHaveText('Delete project');
  await expect(confirmButton(page)).toHaveClass(/button-danger/);
  await cancelButton(page).click();
  await expect(confirmation(page)).toBeHidden();
  await expect(editDialog(page)).toBeVisible();
  await expect(deleteButton(page)).toBeFocused();

  await deleteButton(page).click();
  await expect(confirmation(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(confirmation(page)).toBeHidden();
  await expect(editDialog(page)).toBeVisible();
  await deleteButton(page).click();
  await expect(confirmation(page)).toBeVisible();
  await page.mouse.click(4, 4);
  await expect(confirmation(page)).toBeHidden();
  await expect(editDialog(page)).toBeVisible();
  // requestSubmit never bypasses the confirmation.
  await page.evaluate(() => document.querySelector('form[data-project-delete-form]').requestSubmit());
  await expect(confirmation(page)).toBeVisible();
  await cancelButton(page).click();
  await expect(confirmation(page)).toBeHidden();
  expect(control.posts).toHaveLength(0);
  expect(serviceCalls).toBe(0);
  expect(target.exists()).toBe(true);

  await deleteButton(page).click();
  await expect(confirmation(page)).toBeVisible();
  // Enter on the focused confirm control; key repeat cannot send twice.
  await confirmButton(page).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(editDialog(page)).toBeHidden();
  await expect(feedback(page)).toHaveText(`Project “${target.title}” deleted.`);
  await expect(feedback(page)).toHaveClass(/notice--success/);
  expect(control.posts).toHaveLength(1);
  expect(serviceCalls).toBe(1);
  expect(target.exists()).toBe(false);
  expect(target.folder()).toBe(false);
  expect(db.prepare('SELECT COUNT(*) AS c FROM releases WHERE project_id = ?').get(target.id).c).toBe(0);
  expect(quarantineEntries()).toEqual([]);

  await expect(page.locator(`[aria-controls="projects-list-info-${target.id}"]`)).toHaveCount(0);
  await expect(page.locator(`[aria-controls="projects-list-info-${neighbour.id}"]`)).toHaveCount(1);
  expect(neighbour.exists()).toBe(true);
  expect(neighbour.folder()).toBe(true);
  await expectSameDocument(page, LIST);
  expect(control.navigations).toBe(0);
  await expect(page.locator('#main-content')).toBeFocused();
  await page.keyboard.press('Enter');
  expect(control.posts).toHaveLength(1);
  expect(control.savePosts).toHaveLength(0);
  expect(control.archivePosts).toHaveLength(0);
  expect(errors).toEqual([]);
});

test('B: Dashboard — deletes from the project information card; the row leaves, the filter and document stay', async ({ page }) => {
  const target = createProject('Delete B');
  const other = createProject('Delete B');
  const { control, errors } = await open(page, '/');
  await page.locator('[data-dashboard-title-info-bound="true"]').first().waitFor({ state: 'attached' });
  const tbdFilter = page.locator('[data-dashboard-status-filter="tbd"]');
  await tbdFilter.click();
  await expect(tbdFilter).toHaveAttribute('aria-pressed', 'true');
  const cardId = `dashboard-project-info-table-${target.id}`;
  await page.locator(`[aria-controls="${cardId}"]`).click();
  await page.locator(`#${cardId}`).getByRole('link', { name: 'Edit project' }).click();
  await loaded(page);
  await openDeleteConfirmation(page);
  await confirmButton(page).click();
  await expect(editDialog(page)).toBeHidden();
  await expect(page.locator(`[aria-controls="${cardId}"]`)).toHaveCount(0);
  await expect(page.locator(`[aria-controls="dashboard-project-info-table-${other.id}"]`)).toHaveCount(1);
  await expect(page.locator('[data-dashboard-status-filter="tbd"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(feedback(page)).toHaveText(`Project “${target.title}” deleted.`);
  await expect(page.locator('[data-dashboard-sync]')).toBeHidden();
  expect(target.exists()).toBe(false);
  expect(other.exists()).toBe(true);
  await expectSameDocument(page, '/');
  expect(control.posts).toHaveLength(1);
  expect(control.navigations).toBe(0);
  expect(errors).toEqual([]);
});

test('C: Project Detail deep link — terminal delete navigates once to Projects, never to returnTo', async ({ page }) => {
  const project = createProject('Delete C');
  const url = `/projects/${project.id}?edit=1&returnTo=${encodeURIComponent('/projects?status=ready')}`;
  const { control, errors } = await open(page, url);
  await loaded(page);
  await openDeleteConfirmation(page);
  // Cancel keeps the deep-linked page where it is.
  await cancelButton(page).click();
  await expect(editDialog(page)).toBeVisible();
  expect(control.navigations).toBe(0);
  await deleteButton(page).click();
  await confirmButton(page).click();
  await page.waitForURL(`${baseURL}/projects`);
  await expect(page.locator('[data-projects-live-region]')).toBeAttached();
  expect(control.navigations).toBe(1);
  expect(await page.evaluate(() => window.__sameDocument)).toBeUndefined();
  expect(control.posts).toHaveLength(1);
  expect(serviceCalls).toBe(1);
  expect(project.exists()).toBe(false);
  expect(project.folder()).toBe(false);
  // No read of the deleted project was attempted.
  expect(control.gets).not.toContain(`/projects/${project.id}`);
  expect(errors).toEqual([]);
});

test('D: Project Assets — terminal delete retires the page and navigates once to Projects', async ({ page }) => {
  const project = createProject('Delete D');
  const url = `/projects/${project.id}/assets`;
  const { control, errors } = await open(page, url);
  await page.locator('.page-heading [data-project-edit-id]').click();
  await loaded(page);
  await openDeleteConfirmation(page);
  await confirmButton(page).click();
  await page.waitForURL(`${baseURL}/projects`);
  expect(control.navigations).toBe(1);
  expect(control.posts).toHaveLength(1);
  expect(serviceCalls).toBe(1);
  expect(project.exists()).toBe(false);
  expect(project.folder()).toBe(false);
  await expect(page.locator(`[aria-controls="projects-list-info-${project.id}"]`)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('E: unsaved Edit drafts — warned, kept on Cancel and on refusal, never saved, discarded only on success', async ({ page }) => {
  const project = createProject('Delete E');
  const { control, errors } = await open(page, LIST);
  await editFromList(page, project);
  await titleField(page).fill('Unsaved title');
  await notesField(page).fill('Unsaved notes');
  await descriptionField(page).fill('Unsaved description');

  await openDeleteConfirmation(page);
  await expect(confirmation(page).locator('#app-confirmation-dialog-title')).toHaveText('Delete project with unsaved changes?');
  await expect(confirmation(page)).toContainText(`Delete “${project.title}” permanently?`);
  await expect(confirmation(page)).toContainText('Your unsaved Edit Project changes (title, description and notes) will not be saved: they are kept if you cancel or the project is not deleted, and lost if it is deleted.');
  await expect(cancelButton(page)).toHaveText('Keep editing');
  await cancelButton(page).click();
  await expect(titleField(page)).toHaveValue('Unsaved title');
  await expect(notesField(page)).toHaveValue('Unsaved notes');
  await expect(descriptionField(page)).toHaveValue('Unsaved description');
  await expect(cancelButton(page)).toHaveText('Cancel');
  expect(control.posts).toHaveLength(0);

  // An authoritative refusal (CSRF) keeps the drafts and Delete available.
  const token = await deleteDisclosure(page).locator('input[name="_csrf"]').inputValue();
  await deleteDisclosure(page).locator('input[name="_csrf"]').evaluate((input) => { input.value = 'stale-token'; });
  await openDeleteConfirmation(page);
  await confirmButton(page).click();
  await expect(dialogStatus(page)).toHaveText('Invalid or missing CSRF token. Nothing was deleted. Your unsaved changes are kept.');
  await expect(editDialog(page)).toBeVisible();
  await expect(titleField(page)).toHaveValue('Unsaved title');
  await expect(notesField(page)).toHaveValue('Unsaved notes');
  await expect(deleteButton(page)).toBeFocused();
  expect(project.exists()).toBe(true);
  expect(control.posts).toHaveLength(1);
  expect(serviceCalls).toBe(0);

  // A service refusal (ownership marker missing) keeps them too.
  await deleteDisclosure(page).locator('input[name="_csrf"]').evaluate((input, value) => { input.value = value; }, token);
  const marker = path.join(project.dir, '.creatorcrate-owner');
  const markerBytes = fs.readFileSync(marker);
  fs.rmSync(marker);
  await openDeleteConfirmation(page);
  await confirmButton(page).click();
  await expect(dialogStatus(page)).toHaveText('Project directory ownership marker is missing. Nothing was deleted. Your unsaved changes are kept.');
  await expect(titleField(page)).toHaveValue('Unsaved title');
  expect(project.exists()).toBe(true);
  expect(project.folder()).toBe(true);
  expect(serviceCalls).toBe(1);
  fs.writeFileSync(marker, markerBytes);

  await openDeleteConfirmation(page);
  await confirmButton(page).click();
  await expect(editDialog(page)).toBeHidden();
  expect(project.exists()).toBe(false);
  expect(control.posts).toHaveLength(3);
  expect(control.savePosts).toHaveLength(0);
  await expectSameDocument(page, LIST);
  expect(errors).toEqual([]);
});

test('F: a failed refresh after a confirmed Delete stays truthful and Retry refresh only reads', async ({ page }) => {
  const project = createProject('Delete F');
  const { control, errors } = await open(page, LIST);
  await editFromList(page, project);
  let failRefresh = true;
  await page.route((target) => target.pathname === '/projects', (route) => {
    if (route.request().method() === 'GET' && route.request().resourceType() === 'fetch' && failRefresh) {
      return route.fulfill({ status: 500, body: 'unavailable' });
    }
    return route.fallback();
  });
  await openDeleteConfirmation(page);
  await confirmButton(page).click();
  await expect(feedback(page)).toContainText(`Project “${project.title}” deleted. Projects could not refresh, so the information shown may be out of date.`);
  await expect(feedback(page)).toHaveClass(/notice--error/);
  expect(project.exists()).toBe(false);
  // The stale list still shows the row until a refresh succeeds; its Edit
  // action can no longer load the project.
  await expect(page.locator(`[aria-controls="projects-list-info-${project.id}"]`)).toHaveCount(1);

  failRefresh = false;
  await feedback(page).getByRole('button', { name: 'Retry refresh' }).click();
  await expect(feedback(page)).toHaveText(`Project “${project.title}” deleted.`);
  await expect(page.locator(`[aria-controls="projects-list-info-${project.id}"]`)).toHaveCount(0);
  expect(control.posts).toHaveLength(1);
  expect(serviceCalls).toBe(1);
  await expectSameDocument(page, LIST);
  expect(errors).toEqual([]);
});

test('G: a lost answer after the service ran — no resend; the GET check reports an observation, not a clean delete', async ({ page }) => {
  const project = createProject('Delete G');
  const { control, errors } = await open(page, LIST);
  await editFromList(page, project);
  await titleField(page).fill('Draft kept through loss');
  control.post = 'lose';
  await openDeleteConfirmation(page);
  await confirmButton(page).click();
  await expect(dialogStatus(page)).toHaveText('This project no longer exists, but this page could not confirm whether its Delete request removed it, or whether its folder was fully removed. Your unsaved changes are kept here, but this project can no longer be saved.');
  expect(project.exists()).toBe(false);
  expect(serviceCalls).toBe(1);
  expect(control.posts).toHaveLength(1);
  expect(control.gets).toContain(`/projects/${project.id}/edit`);
  await expect(editDialog(page)).toBeVisible();
  await expect(titleField(page)).toHaveValue('Draft kept through loss');
  await expect(deleteButton(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(feedback(page)).toHaveClass(/notice--error/);
  await expect(feedback(page)).not.toHaveText(/deleted\.$/);

  await deleteButton(page).click({ force: true });
  await expect(confirmation(page)).toBeHidden();
  await saveButton(page).click();
  await expect(dialogStatus(page)).toContainText('This project no longer exists.');
  expect(control.posts).toHaveLength(1);
  expect(control.savePosts).toHaveLength(0);
  await page.keyboard.press('Escape');
  await expect(editDialog(page)).toBeHidden();
  await expect(page.locator(`[aria-controls="projects-list-info-${project.id}"]`)).toHaveCount(0);
  await expectSameDocument(page, LIST);
  expect(errors).toEqual([]);
});

test('H: a delayed original POST — an early GET finding the project present never clears the hold; no second POST', async ({ page }) => {
  const project = createProject('Delete H');
  const { control, errors } = await open(page, LIST);
  await editFromList(page, project);
  await titleField(page).fill('Draft across the delay');
  gate.holdNext = 1;
  control.post = 'gate';
  await openDeleteConfirmation(page);
  await confirmButton(page).click();

  await expect(dialogStatus(page)).toContainText('Could not confirm whether the project was deleted. The project still exists, but the earlier Delete request may still run.');
  expect(gate.arrivals).toBe(1);
  expect(gate.held).toHaveLength(1);
  expect(serviceCalls).toBe(0);
  expect(project.exists()).toBe(true);
  await expect(deleteButton(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(feedback(page).getByRole('button', { name: 'Check again' })).toBeVisible();

  // Another Delete, an Archive and a Save in the same host are refused, never queued.
  control.post = 'pass';
  await deleteButton(page).click({ force: true });
  await expect(confirmation(page)).toBeHidden();
  await expect(dialogStatus(page)).toContainText('The earlier Delete request has not been confirmed, so this project cannot be deleted again from this page.');
  await openDisclosure(archiveDisclosure(page));
  await archiveButton(page).click();
  await expect(confirmation(page)).toBeHidden();
  await expect(dialogStatus(page)).toContainText('This project cannot be archived while its Delete request is unconfirmed or needs recovery.');
  await saveButton(page).click();
  await expect(dialogStatus(page)).toContainText('Changes cannot be saved while the earlier Delete request is unconfirmed.');
  expect(control.savePosts).toHaveLength(0);
  expect(control.archivePosts).toHaveLength(0);

  // Dismissal and reopening (from the keyboard) keep the drafts and the warning.
  await page.keyboard.press('Escape');
  await expect(editDialog(page)).toBeHidden();
  const reopen = page.locator(`[aria-controls="projects-list-info-${project.id}"]`);
  await page.locator('#main-content').focus();
  await reopen.focus();
  await page.keyboard.press('Enter');
  await page.locator(`#projects-list-info-${project.id}`).getByRole('link', { name: 'Edit project' }).focus();
  await page.keyboard.press('Enter');
  await loaded(page);
  await expect(titleField(page)).toHaveValue('Draft across the delay');
  await expect(deleteDisclosure(page).locator('form[data-project-delete-form]')).toHaveAttribute('data-project-delete-hold', 'unresolved');
  await editDialog(page).getByRole('button', { name: 'Check again' }).click();
  await expect(dialogStatus(page)).toContainText('The project still exists');
  expect(project.exists()).toBe(true);

  // The original request finally runs; Check again (a GET) observes it.
  gate.release();
  await expect.poll(() => project.exists()).toBe(false);
  const [upstream] = await Promise.all(control.upstream);
  expect(upstream.status).toBe(200);
  expect(upstream.body.outcome).toBe('deleted');
  expect(project.folder()).toBe(false);
  await editDialog(page).getByRole('button', { name: 'Check again' }).click();
  await expect(dialogStatus(page)).toContainText('This project no longer exists, but this page could not confirm whether its Delete request removed it');
  expect(gate.arrivals).toBe(1);
  expect(serviceCalls).toBe(1);
  expect(control.posts).toHaveLength(1);
  expect(control.savePosts).toHaveLength(0);
  await expectSameDocument(page, LIST);
  expect(errors).toEqual([]);
});

test('I: restoration failure — recovery required keeps Project Detail, drafts and holds; no second POST', async ({ page }) => {
  const project = createProject('Delete I');
  const url = `/projects/${project.id}`;
  const { control, errors } = await open(page, url);
  await editFromHeading(page, project);
  await notesField(page).fill('Draft through recovery');
  const actualRename = fs.renameSync;
  let staged = null;
  fs.renameSync = (source, destination) => {
    if (source === project.dir && path.basename(destination).startsWith('.cc-quarantine-')) {
      actualRename(source, destination);
      staged = destination;
      return undefined;
    }
    if (staged && source === staged) throw new Error('restore failed');
    return actualRename(source, destination);
  };
  db.exec("CREATE TRIGGER fail_delete_i BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT, 'delete fault'); END");
  try {
    await openDeleteConfirmation(page);
    await confirmButton(page).click();
    await expect(dialogStatus(page)).toContainText('The project was not deleted, but its folder could not be put back where it was after the deletion failed.');
    await expect(dialogStatus(page)).toContainText('Your unsaved changes are kept.');
  } finally {
    fs.renameSync = actualRename;
    db.exec('DROP TRIGGER fail_delete_i');
  }
  expect(project.exists()).toBe(true);
  expect(project.folder()).toBe(false);
  expect(fs.existsSync(path.join(staged, 'owned-file.txt'))).toBe(true);
  await expect(editDialog(page)).toBeVisible();
  await expect(notesField(page)).toHaveValue('Draft through recovery');
  await expect(feedback(page)).toHaveClass(/notice--error/);
  await expect(editDialog(page).getByRole('button', { name: 'Check again' })).toHaveCount(0);
  await deleteButton(page).click({ force: true });
  await expect(confirmation(page)).toBeHidden();
  await saveButton(page).click();
  await expect(dialogStatus(page)).toContainText('Changes cannot be saved while this project’s folder needs recovery.');
  expect(control.posts).toHaveLength(1);
  expect(control.savePosts).toHaveLength(0);
  expect(serviceCalls).toBe(1);
  expect(await page.locator('#main-content').getAttribute('data-project-deleted-host')).toBeNull();
  await expectSameDocument(page, url);
  expect(control.navigations).toBe(0);
  // Put the folder back for the remaining tests' shared root.
  fs.renameSync(staged, project.dir);
  expect(errors).toEqual([]);
});

test('I2: proven restoration — the folder is put back, drafts kept, Delete available again', async ({ page }) => {
  const project = createProject('Delete I2');
  const url = `/projects/${project.id}`;
  const { control, errors } = await open(page, url);
  await editFromHeading(page, project);
  await titleField(page).fill('Draft through restore');
  db.exec("CREATE TRIGGER fail_delete_i2 BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT, 'delete fault'); END");
  try {
    await openDeleteConfirmation(page);
    await confirmButton(page).click();
    await expect(dialogStatus(page)).toHaveText('The project could not be deleted. Nothing was deleted, and its folder is where it was. Please try again. Your unsaved changes are kept.');
  } finally {
    db.exec('DROP TRIGGER fail_delete_i2');
  }
  expect(project.exists()).toBe(true);
  expect(project.folder()).toBe(true);
  expect(quarantineEntries()).toEqual([]);
  await expect(titleField(page)).toHaveValue('Draft through restore');
  await expect(deleteButton(page)).not.toHaveAttribute('aria-disabled', 'true');
  expect(control.posts).toHaveLength(1);
  await expectSameDocument(page, url);
  expect(errors).toEqual([]);
});

test('J: cleanup failure after commit — never a clean success; the page is retired with a link, no second POST', async ({ page }) => {
  const project = createProject('Delete J');
  const url = `/projects/${project.id}`;
  const { control, errors } = await open(page, url);
  await editFromHeading(page, project);
  const actualRm = fs.rmSync;
  let stuck = null;
  fs.rmSync = (target, options) => {
    if (path.basename(String(target)).startsWith('.cc-quarantine-')) {
      stuck = target;
      fs.rmSync = actualRm;
      const error = new Error('permission denied');
      error.code = 'EACCES';
      throw error;
    }
    return actualRm(target, options);
  };
  try {
    await openDeleteConfirmation(page);
    await confirmButton(page).click();
    await expect(feedback(page)).toContainText(`Project “${project.title}” was deleted, but its folder could not be fully removed`);
  } finally {
    fs.rmSync = actualRm;
  }
  await expect(feedback(page)).toHaveClass(/notice--error/);
  await expect(feedback(page)).not.toContainText('Opening Projects');
  expect(project.exists()).toBe(false);
  expect(fs.existsSync(stuck)).toBe(true);
  await expect(editDialog(page)).toBeHidden();
  const main = page.locator('#main-content');
  await expect(main).toHaveAttribute('data-project-deleted-host', String(project.id));
  await expect(page.locator(`[data-project-edit-id="${project.id}"]`).first()).toHaveJSProperty('inert', false);
  expect(await page.locator(`[data-project-edit-id="${project.id}"]`).first()
    .evaluate((node) => Boolean(node.closest('[inert]')))).toBe(true);
  await expect(main).toBeFocused();
  // The retired page's Edit action cannot be used.
  await page.locator(`[data-project-edit-id="${project.id}"]`).first().click({ force: true, timeout: 2000 }).catch(() => {});
  await expect(editDialog(page)).toBeHidden();
  expect(control.posts).toHaveLength(1);
  expect(serviceCalls).toBe(1);
  expect(control.navigations).toBe(0);
  await expectSameDocument(page, url);
  // The recovery link goes to Projects.
  await feedback(page).getByRole('link', { name: 'Go to Projects' }).click();
  await page.waitForURL(`${baseURL}/projects`);
  expect(control.posts).toHaveLength(1);
  actualRm(stuck, { recursive: true, force: true });
  expect(errors).toEqual([]);
});

test('K: Edit Save, Archive and Delete never overlap', async ({ page }) => {
  const project = createProject('Delete K');
  const url = `/projects/${project.id}`;
  const { control, errors } = await open(page, url);
  await editFromHeading(page, project);

  // A Save in flight refuses Delete before the confirmation opens.
  control.saves = 'hold';
  await titleField(page).fill('Saved during K');
  await saveButton(page).click();
  await expect.poll(() => control.heldSaves.length).toBe(1);
  await deleteDisclosure(page).locator('summary').click({ force: true, timeout: 2000 }).catch(() => {});
  await deleteButton(page).click({ force: true, timeout: 2000 }).catch(() => {});
  await page.evaluate(() => document.querySelector('form[data-project-delete-form]').requestSubmit());
  await expect(confirmation(page)).toBeHidden();
  expect(control.posts).toHaveLength(0);
  control.saves = 'pass';
  await control.heldSaves[0].continue();
  await expect(editDialog(page)).toBeHidden();
  await expect.poll(() => project.row().title).toBe('Saved during K');

  // An Archive in flight refuses Delete.
  await editFromHeading(page, project);
  control.archives = 'hold';
  await openDisclosure(archiveDisclosure(page));
  await archiveButton(page).click();
  await confirmButton(page).click();
  await expect.poll(() => control.heldArchives.length).toBe(1);
  await deleteDisclosure(page).locator('summary').click({ force: true, timeout: 2000 }).catch(() => {});
  await deleteButton(page).click({ force: true, timeout: 2000 }).catch(() => {});
  await page.evaluate(() => document.querySelector('form[data-project-delete-form]').requestSubmit());
  await expect(confirmation(page)).toBeHidden();
  expect(control.posts).toHaveLength(0);
  // A refused Archive (stale token) releases the dialog without archiving.
  await control.heldArchives[0].fulfill({
    status: 403, contentType: 'application/json', body: JSON.stringify({ status: 'error', message: 'Invalid or missing CSRF token.' }),
  });
  await expect(dialogStatus(page)).toContainText('Nothing was archived.');

  // A Delete in flight freezes the dialog: Save and Archive cannot be sent.
  await titleField(page).fill('Never saved');
  control.post = 'hold';
  await openDeleteConfirmation(page);
  await confirmButton(page).click();
  await expect.poll(() => control.heldPosts.length).toBe(1);
  await expect(dialogStatus(page)).toHaveText('Deleting “Saved during K”…');
  await saveButton(page).click({ force: true, timeout: 2000 }).catch(() => {});
  await archiveButton(page).click({ force: true, timeout: 2000 }).catch(() => {});
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(editDialog(page)).toBeVisible();
  expect(control.savePosts).toHaveLength(1);
  expect(control.archivePosts).toHaveLength(1);
  await control.heldPosts[0].continue();
  await page.waitForURL(`${baseURL}/projects`);
  expect(project.exists()).toBe(false);
  expect(control.posts).toHaveLength(1);
  expect(control.savePosts).toHaveLength(1);
  expect(serviceCalls).toBe(1);
  expect(errors).toEqual([]);
});

test('L: native Delete without JavaScript keeps its redirect; CSRF and authentication are enforced', async ({ browser, request }) => {
  const project = createProject('Delete L');
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(`${baseURL}/projects/${project.id}?edit=1`);
  await page.locator('[data-project-edit-action="delete"] summary').click();
  await page.locator('[data-project-edit-action="delete"]').getByRole('button', { name: 'Delete project' }).click();
  await page.waitForURL(`${baseURL}/projects`);
  expect(project.exists()).toBe(false);
  expect(project.folder()).toBe(false);
  await context.close();

  const other = createProject('Delete L');
  const refused = await request.post(`${baseURL}/projects/${other.id}/delete`, {
    form: { _csrf: 'wrong' }, maxRedirects: 0,
  });
  expect(refused.status()).toBe(403);
  const refusedJson = await request.post(`${baseURL}/projects/${other.id}/delete`, {
    form: { _csrf: 'wrong' }, headers: { Accept: 'application/json' }, maxRedirects: 0,
  });
  expect(refusedJson.status()).toBe(403);
  expect(other.exists()).toBe(true);
  expect(other.folder()).toBe(true);
});

test('M: narrow viewport and a long project name — the confirmation fits; keyboard confirmation sends once', async ({ page }) => {
  const project = createProject('Delete M with a very long project name that keeps going well past any narrow phone width');
  const { control, errors } = await open(page, LIST, { width: 390, height: 844 });
  await editFromList(page, project);
  await openDisclosure(deleteDisclosure(page));
  await deleteButton(page).focus();
  await page.keyboard.press('Enter');
  await expect(confirmation(page)).toBeVisible();
  await expect(confirmation(page)).toContainText(`Delete “${project.title}” permanently?`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const box = await confirmation(page).locator('.app-dialog-card').boundingBox();
  expect(box.width).toBeLessThanOrEqual(390);
  // The confirmation holds focus; Tab stays within it.
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => Boolean(document.activeElement.closest('#app-confirmation-dialog')))).toBe(true);
  await confirmButton(page).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  await expect(editDialog(page)).toBeHidden();
  await expect(feedback(page)).toContainText('deleted.');
  expect(control.posts).toHaveLength(1);
  expect(serviceCalls).toBe(1);
  expect(project.exists()).toBe(false);
  await expect(page.locator('#main-content')).toBeFocused();
  await expectSameDocument(page, LIST);
  expect(errors).toEqual([]);
});

// WP11A-F1: Project Detail's deep link (?edit=1&returnTo=) goes back to its
// invoking page when the dialog is dismissed. While this page holds a Delete
// that would discard the hold, the drafts and Check again with the document,
// so a dismissal stays on the page; with nothing held it returns as always.
const deepLink = (project, returnTo = `/projects/${project.id}/assets`) => ({
  returnTo,
  url: `/projects/${project.id}?edit=1&returnTo=${encodeURIComponent(returnTo)}`,
});
// Lets a navigation the dismissal might have started begin before asserting.
const settle = (page) => page.waitForTimeout(400);
const closeControl = (page) => editDialog(page).locator('[data-dialog-close]').first();

async function expectFocusKept(page) {
  // Focus returns to the page's own Edit action, or to its main content.
  expect(await page.evaluate(() => {
    const active = document.activeElement;
    return Boolean(active && active !== document.body
      && (active.matches('[data-project-edit-id]') || active.id === 'main-content'));
  })).toBe(true);
}

test('F1-B1 / B4: deep link — a delayed Delete held upstream; Escape, Close and backdrop stay, drafts and hold survive; release deletes once', async ({ page }) => {
  const project = createProject('Delete F1 B1');
  const { url } = deepLink(project);
  const { control, errors } = await open(page, url);
  await loaded(page);
  await titleField(page).fill('Renamed while held');
  await descriptionField(page).fill('Draft description while held');
  await notesField(page).fill('Draft notes while held');

  gate.holdNext = 1;
  control.post = 'gate';
  await openDeleteConfirmation(page);
  await confirmButton(page).click();
  // The original POST arrived upstream and is still alive there; the page lost
  // its answer, and its early GET found the project present.
  await expect(dialogStatus(page)).toContainText('The project still exists, but the earlier Delete request may still run.');
  expect(gate.arrivals).toBe(1);
  expect(gate.held).toHaveLength(1);
  expect(serviceCalls).toBe(0);
  expect(project.exists()).toBe(true);
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
    await expectFocusKept(page);
    await expect(feedback(page).getByRole('button', { name: 'Check again' }), name).toBeVisible();

    // Reopened: the drafts, the hold and Check again are all still here.
    await editFromHeading(page, project);
    await expect(titleField(page)).toHaveValue('Renamed while held');
    await expect(descriptionField(page)).toHaveValue('Draft description while held');
    await expect(notesField(page)).toHaveValue('Draft notes while held');
    await expect(deleteDisclosure(page).locator('form[data-project-delete-form]')).toHaveAttribute('data-project-delete-hold', 'unresolved');

    // Check again only reads, and a present project keeps the hold.
    const reads = control.gets.length;
    await editDialog(page).getByRole('button', { name: 'Check again' }).click();
    await expect(dialogStatus(page)).toContainText('The project still exists');
    expect(control.gets.length).toBe(reads + 1);

    // Save, another Delete and an Archive from the held document send nothing.
    await saveButton(page).click();
    await expect(dialogStatus(page)).toContainText('Changes cannot be saved while the earlier Delete request is unconfirmed.');
    await openDisclosure(deleteDisclosure(page));
    await deleteButton(page).click({ force: true });
    await expect(confirmation(page)).toBeHidden();
    await openDisclosure(archiveDisclosure(page));
    await archiveButton(page).click();
    await expect(confirmation(page)).toBeHidden();
    expect(control.posts).toHaveLength(1);
    expect(control.savePosts).toHaveLength(0);
    expect(control.archivePosts).toHaveLength(0);
  }
  await page.keyboard.press('Escape');
  await expect(editDialog(page)).toBeHidden();
  await settle(page);
  expect(control.navigations).toBe(0);
  expect(serviceCalls).toBe(0);
  expect(project.row().title).toBe(project.title);

  // The original request finally runs, once, on the project as it was.
  gate.release();
  await expect.poll(() => project.exists()).toBe(false);
  const [upstream] = await Promise.all(control.upstream);
  expect(upstream.status).toBe(200);
  expect(upstream.body.outcome).toBe('deleted');
  expect(project.folder()).toBe(false);
  expect(db.prepare('SELECT COUNT(*) AS n FROM projects WHERE title = ?').get('Renamed while held').n).toBe(0);
  expect(gate.arrivals).toBe(1);
  expect(serviceCalls).toBe(1);
  expect(control.posts).toHaveLength(1);
  expect(control.savePosts).toHaveLength(0);
  expect(control.archivePosts).toHaveLength(0);
  expect(control.navigations).toBe(0);
  await expectSameDocument(page, url);
  expect(errors).toEqual([]);
});

test('F1-B3: deep link to its Assets — committed Delete, lost answer, failed check; Escape never opens the deleted Assets page', async ({ page }) => {
  const project = createProject('Delete F1 B3');
  const { url, returnTo } = deepLink(project);
  const { control, errors } = await open(page, url);
  await loaded(page);
  await titleField(page).fill('Draft through the failed check');
  let failChecks = true;
  await page.route((target) => target.pathname === `/projects/${project.id}/edit`, (route) => (
    failChecks && route.request().resourceType() === 'fetch' ? route.abort('failed') : route.fallback()));
  const documents = [];
  page.on('response', (response) => {
    if (response.request().isNavigationRequest()) documents.push({ url: new URL(response.url()).pathname, status: response.status() });
  });

  control.post = 'lose';
  await openDeleteConfirmation(page);
  await confirmButton(page).click();
  await expect(dialogStatus(page)).toContainText('Could not confirm whether the project was deleted. The project could not be checked.');
  expect(serviceCalls).toBe(1);
  expect(project.exists()).toBe(false);
  expect(project.folder()).toBe(false);
  control.post = 'pass';

  await page.keyboard.press('Escape');
  await expect(editDialog(page)).toBeHidden();
  await settle(page);
  expect(control.navigations).toBe(0);
  expect(documents).toEqual([]);
  expect(page.url()).not.toContain(returnTo);
  await expectSameDocument(page, url);
  await expectFocusKept(page);
  await expect(feedback(page)).toContainText('Could not confirm whether the project was deleted.');
  await expect(feedback(page)).toHaveClass(/notice--error/);
  await expect(feedback(page)).not.toContainText('Project deleted');

  // Check again stays a GET; a failed one keeps the notice and the page.
  const posts = control.posts.length;
  await feedback(page).getByRole('button', { name: 'Check again' }).click();
  await expect(feedback(page)).toContainText('The project could not be checked.');
  expect(control.posts).toHaveLength(posts);
  expect(control.navigations).toBe(0);

  // Once a check can read, it reports an observation (never a clean
  // deletion) and offers Projects; nothing navigates by itself.
  failChecks = false;
  await feedback(page).getByRole('button', { name: 'Check again' }).click();
  await expect(feedback(page)).toContainText('This project no longer exists, but this page could not confirm whether its Delete request removed it');
  await expect(feedback(page).getByRole('link', { name: 'Go to Projects' })).toHaveAttribute('href', '/projects');
  await settle(page);
  expect(control.navigations).toBe(0);
  expect(documents).toEqual([]);
  expect(control.posts).toHaveLength(1);
  expect(serviceCalls).toBe(1);
  expect(control.savePosts).toHaveLength(0);
  expect(errors).toEqual([]);
});

test('F1-B5: deep link with nothing held — Cancel/Escape return to the invoking page as before', async ({ page }) => {
  const project = createProject('Delete F1 B5');
  const { url, returnTo } = deepLink(project);
  const { control, errors } = await open(page, url);
  await loaded(page);
  await page.keyboard.press('Escape');
  await page.waitForURL(`${baseURL}${returnTo}`);
  expect(control.navigations).toBe(1);

  const other = createProject('Delete F1 B5');
  const { url: otherUrl, returnTo: otherReturn } = deepLink(other, '/projects?status=tbd');
  await page.goto(`${baseURL}${otherUrl}`);
  await loaded(page);
  await closeControl(page).click();
  await page.waitForURL(`${baseURL}${otherReturn}`);
  expect(control.posts).toHaveLength(0);
  expect(project.exists() && other.exists()).toBe(true);
  expect(errors).toEqual([]);
});

test('F1-B6: deep link — an authoritative Delete refusal keeps the drafts; the next dismissal returns as before', async ({ page }) => {
  const project = createProject('Delete F1 B6');
  const { url, returnTo } = deepLink(project);
  const { control, errors } = await open(page, url);
  await loaded(page);
  await titleField(page).fill('Draft through refusal');
  await deleteDisclosure(page).locator('input[name="_csrf"]').evaluate((input) => { input.value = 'stale-token'; });
  await openDeleteConfirmation(page);
  await confirmButton(page).click();
  await expect(dialogStatus(page)).toHaveText('Invalid or missing CSRF token. Nothing was deleted. Your unsaved changes are kept.');
  await expect(titleField(page)).toHaveValue('Draft through refusal');
  expect(serviceCalls).toBe(0);
  expect(control.navigations).toBe(0);
  await page.keyboard.press('Escape');
  await page.waitForURL(`${baseURL}${returnTo}`);
  expect(control.navigations).toBe(1);
  expect(project.exists()).toBe(true);
  expect(project.row().title).toBe(project.title);
  expect(control.posts).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('F1-B7: deep link to its Assets — a clean Delete navigates once, to Projects, never to returnTo', async ({ page }) => {
  const project = createProject('Delete F1 B7');
  const { url, returnTo } = deepLink(project);
  const { control, errors } = await open(page, url);
  await loaded(page);
  const documents = [];
  page.on('response', (response) => {
    if (response.request().isNavigationRequest()) documents.push(new URL(response.url()).pathname);
  });
  await openDeleteConfirmation(page);
  await confirmButton(page).click();
  await page.waitForURL(`${baseURL}/projects`);
  await expect(page.locator('[data-projects-live-region]')).toBeAttached();
  await settle(page);
  expect(control.navigations).toBe(1);
  expect(documents).toEqual(['/projects']);
  expect(documents).not.toContain(returnTo);
  expect(project.exists()).toBe(false);
  expect(project.folder()).toBe(false);
  expect(control.posts).toHaveLength(1);
  expect(serviceCalls).toBe(1);
  await expect(page.locator(`[aria-controls="projects-list-info-${project.id}"]`)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('F1-B8: deep link to its Assets — cleanup incomplete keeps the recovery notice; nothing navigates to the dead returnTo', async ({ page }) => {
  const project = createProject('Delete F1 B8');
  const { url } = deepLink(project);
  const { control, errors } = await open(page, url);
  await loaded(page);
  const actualRm = fs.rmSync;
  let stuck = null;
  fs.rmSync = (target, options) => {
    if (path.basename(String(target)).startsWith('.cc-quarantine-')) {
      stuck = target;
      fs.rmSync = actualRm;
      const error = new Error('permission denied');
      error.code = 'EACCES';
      throw error;
    }
    return actualRm(target, options);
  };
  try {
    await openDeleteConfirmation(page);
    await confirmButton(page).click();
    await expect(feedback(page)).toContainText(`Project “${project.title}” was deleted, but its folder could not be fully removed`);
  } finally {
    fs.rmSync = actualRm;
  }
  await expect(editDialog(page)).toBeHidden();
  await page.keyboard.press('Escape');
  await settle(page);
  expect(control.navigations).toBe(0);
  await expectSameDocument(page, url);
  await expect(feedback(page)).toHaveClass(/notice--error/);
  await expect(feedback(page).getByRole('link', { name: 'Go to Projects' })).toHaveAttribute('href', '/projects');
  await expect(page.locator('#main-content')).toHaveAttribute('data-project-deleted-host', String(project.id));
  expect(project.exists()).toBe(false);
  expect(control.posts).toHaveLength(1);
  expect(serviceCalls).toBe(1);
  if (stuck) actualRm(stuck, { recursive: true, force: true });
  expect(errors).toEqual([]);
});
