import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { openDatabase, closeDatabase, runMigrations } from '../../src/db.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';

// New Project creates in place from Dashboard and Projects: the host page is
// never navigated or replaced, and its project content refreshes locally.

async function withProjectApp(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-project-create-flow-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    for (const name of ['Alpha', 'Beta']) app.locals.tagService.createTag({ name });
    app.locals.pageDefaultsService.saveDefault('new_project', 'status', 'ready');
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    await run(`http://127.0.0.1:${server.address().port}`, app, db);
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const countProjects = (db, title) => db.prepare('SELECT COUNT(*) AS count FROM projects WHERE title = ?').get(title).count;

// A document replaced by navigation loses this marker.
const markDocument = (page) => page.evaluate(() => { window.__projectCreateFlowDocument = true; });
const documentKept = (page) => page.evaluate(() => window.__projectCreateFlowDocument === true);

function trackNavigations(page) {
  const navigations = [];
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
  return navigations;
}

async function openNewProject(page) {
  const trigger = page.locator('.page-heading [data-dialog-open="project-create-dialog"]');
  await trigger.click();
  const dialog = page.locator('#project-create-dialog');
  await expect(dialog).toBeVisible();
  return { trigger, dialog };
}

async function selectTag(dialog, name) {
  await dialog.locator('#project-tags-form summary').click();
  await dialog.locator('#project-tags-form label', { hasText: name }).click();
  await dialog.locator('#project-tags-form summary').click();
}

async function selectStatus(dialog, label) {
  await dialog.locator('#project-status-form summary').click();
  await dialog.locator('#project-status-form label', { hasText: label }).click();
}

async function expectInitialState(dialog) {
  await expect(dialog.locator('#title')).toHaveValue('');
  await expect(dialog.locator('#notes')).toHaveValue('');
  await expect(dialog.locator('input[name="status"][value="ready"]')).toBeChecked();
  await expect(dialog.locator('input[name="tagIds[]"]:checked')).toHaveCount(0);
  await expect(dialog.locator('[aria-invalid="true"]')).toHaveCount(0);
  await expect(dialog.locator('[data-dialog-error]')).toBeHidden();
}

test('Dashboard creates a project in place, refreshes its projects, and links to it', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await withProjectApp(async (origin, app, db) => {
    await page.goto(origin + '/');
    const navigations = trackNavigations(page);
    await markDocument(page);
    const { trigger, dialog } = await openNewProject(page);

    await dialog.locator('#title').fill('Dashboard Dialog Project');
    await dialog.locator('#notes').fill('Created from the dashboard');
    await selectStatus(dialog, 'Planned');
    await selectTag(dialog, 'Beta');
    const requests = [];
    page.on('request', (request) => { if (request.method() === 'POST') requests.push(request.url()); });
    await dialog.locator('button[data-dialog-submit]').click();

    await expect(dialog).toBeHidden();
    const feedback = page.locator('[data-dialog-feedback]');
    await expect(feedback).toContainText('Project “Dashboard Dialog Project” created.');
    const row = db.prepare('SELECT id, status, notes FROM projects WHERE title = ?').get('Dashboard Dialog Project');
    expect(row).toMatchObject({ status: 'planned', notes: 'Created from the dashboard' });
    await expect(feedback.getByRole('link', { name: 'View Project' })).toHaveAttribute('href', `/projects/${row.id}`);
    await expect(page.locator('[data-dashboard-projects]')).toContainText('Dashboard Dialog Project');
    expect(app.locals.projectTagService.listProjectTags(row.id).map((tag) => tag.display_name)).toEqual(['Beta']);
    expect(countProjects(db, 'Dashboard Dialog Project')).toBe(1);
    expect(requests).toHaveLength(1);
    expect(page.url()).toBe(origin + '/');
    expect(navigations).toEqual([]);
    expect(await documentKept(page)).toBe(true);
    await expect(trigger).toBeFocused();

    // Reopening starts from the New Project defaults, not the last draft.
    await trigger.click();
    await expectInitialState(dialog);
  });
  expect(pageErrors).toEqual([]);
});

test('Projects creates in place, keeps its list query and scroll, and reopens fresh', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 700 });

  await withProjectApp(async (origin, app, db) => {
    for (let index = 1; index <= 24; index += 1) {
      app.locals.projectService.create({ title: `Existing ${String(index).padStart(2, '0')}`, status: 'ready' });
    }
    const listUrl = `${origin}/projects?sort=title&order=asc&view=list`;
    await page.goto(listUrl);
    const navigations = trackNavigations(page);
    await markDocument(page);
    const { trigger, dialog } = await openNewProject(page);
    // Scroll the page behind the modal; creation must keep the rows the user
    // was looking at where they were (the notice above may shift scrollY).
    // The new title sorts last, so no row is inserted above them.
    await page.evaluate(() => window.scrollTo(0, 400));
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    const anchorRow = page.locator('[data-projects-live-region]').getByText('Existing 10', { exact: true }).first();
    const anchorTop = (await anchorRow.boundingBox()).y;

    await dialog.locator('#title').fill('Zulu Projects Dialog');
    await selectTag(dialog, 'Alpha');
    await dialog.locator('button[data-dialog-submit]').click();

    await expect(dialog).toBeHidden();
    const row = db.prepare('SELECT id, status FROM projects WHERE title = ?').get('Zulu Projects Dialog');
    expect(row.status).toBe('ready');
    await expect(page.locator('[data-dialog-feedback]').getByRole('link', { name: 'View Project' }))
      .toHaveAttribute('href', `/projects/${row.id}`);
    await expect(page.locator('[data-projects-live-region]')).toContainText('Zulu Projects Dialog');
    await expect(page.locator('[data-projects-live-region]')).not.toHaveAttribute('aria-busy', 'true');
    expect(app.locals.projectTagService.listProjectTags(row.id).map((tag) => tag.display_name)).toEqual(['Alpha']);
    expect(countProjects(db, 'Zulu Projects Dialog')).toBe(1);
    expect(page.url()).toBe(listUrl);
    expect(navigations).toEqual([]);
    expect(await documentKept(page)).toBe(true);
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThanOrEqual(400);
    expect(Math.abs((await anchorRow.boundingBox()).y - anchorTop)).toBeLessThanOrEqual(2);

    await trigger.click();
    await expectInitialState(dialog);
  });
  expect(pageErrors).toEqual([]);
});

test('validation keeps the dialog, the draft, tags and status; the corrected save creates once', async ({ page }) => {
  await withProjectApp(async (origin, app, db) => {
    await page.goto(origin + '/projects');
    const navigations = trackNavigations(page);
    await markDocument(page);
    const { dialog } = await openNewProject(page);

    await dialog.locator('#title').fill('Validation Draft');
    await dialog.locator('#notes').fill('Keep these notes');
    await dialog.locator('#patreonUrl').fill('not-a-url');
    await selectStatus(dialog, 'Planned');
    await selectTag(dialog, 'Beta');
    await dialog.locator('button[data-dialog-submit]').click();

    await expect(dialog.locator('#patreonUrl')).toHaveAttribute('aria-invalid', 'true');
    await expect(dialog.locator('#patreonUrl-error')).toHaveText('Project link must be a valid absolute HTTP or HTTPS URL.');
    await expect(dialog.locator('#patreonUrl')).toBeFocused();
    await expect(dialog.locator('[data-dialog-error]')).toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('#title')).toHaveValue('Validation Draft');
    await expect(dialog.locator('#notes')).toHaveValue('Keep these notes');
    await expect(dialog.locator('input[name="status"][value="planned"]')).toBeChecked();
    await expect(dialog.locator('#project-tags-form [data-cc-dropdown-summary-current]')).toHaveText('Beta');
    await expect(page.locator('[data-dialog-feedback]')).toBeHidden();
    expect(countProjects(db, 'Validation Draft')).toBe(0);

    await dialog.locator('#patreonUrl').fill('https://example.com/fixed');
    await dialog.locator('button[data-dialog-submit]').click();
    await expect(dialog).toBeHidden();
    expect(countProjects(db, 'Validation Draft')).toBe(1);
    const row = db.prepare('SELECT id, status FROM projects WHERE title = ?').get('Validation Draft');
    expect(row.status).toBe('planned');
    expect(app.locals.projectTagService.listProjectTags(row.id).map((tag) => tag.display_name)).toEqual(['Beta']);
    expect(navigations).toEqual([]);
    expect(await documentKept(page)).toBe(true);
  });
});

test('a service failure keeps the draft without success state, and dismissal leaves the page intact', async ({ page }) => {
  await withProjectApp(async (origin, app, db) => {
    await page.goto(origin + '/');
    const navigations = trackNavigations(page);
    await markDocument(page);
    const create = app.locals.projectService.create;
    app.locals.projectService.create = () => { throw new Error('EACCES: permission denied'); };
    const { trigger, dialog } = await openNewProject(page);

    await dialog.locator('#title').fill('Failing Project');
    await selectTag(dialog, 'Alpha');
    await dialog.locator('button[data-dialog-submit]').click();

    await expect(dialog.locator('[data-dialog-error-text]')).toHaveText('Project creation failed. Please try again.');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('#title')).toHaveValue('Failing Project');
    await expect(dialog.locator('#project-tags-form [data-cc-dropdown-summary-current]')).toHaveText('Alpha');
    await expect(page.locator('[data-dialog-feedback]')).toBeHidden();
    expect(countProjects(db, 'Failing Project')).toBe(0);
    app.locals.projectService.create = create;

    // Escape, then the close button: the page stays and focus returns.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expectInitialState(dialog);
    await dialog.getByRole('button', { name: 'Close New Project', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    expect(page.url()).toBe(origin + '/');
    expect(navigations).toEqual([]);
    expect(await documentKept(page)).toBe(true);
  });
});

test('the standalone New Project page still submits natively to Project Detail', async ({ page }) => {
  await withProjectApp(async (origin, _app, db) => {
    await page.goto(origin + '/projects/new');
    await page.locator('#title').fill('Standalone Project');
    await Promise.all([
      page.waitForURL(/\/projects\/\d+$/),
      page.locator('#project-form').evaluate((form) => form.requestSubmit()),
    ]);
    const row = db.prepare('SELECT id FROM projects WHERE title = ?').get('Standalone Project');
    expect(page.url()).toBe(`${origin}/projects/${row.id}`);
    expect(countProjects(db, 'Standalone Project')).toBe(1);
  });
});
