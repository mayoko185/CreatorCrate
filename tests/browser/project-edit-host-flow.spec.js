import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createApp } from '../../src/app.js';
import { openDatabase, closeDatabase, runMigrations } from '../../src/db.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';

// Edit Project opens and saves in place from Projects, Project Assets and the
// Dashboard's project information cards: the document is never navigated or
// replaced, and each host brings its own project content up to date.

async function withHostApp(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-project-edit-hosts-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  const previewRoot = path.join(root, 'previews');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot); fs.mkdirSync(previewRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot, previewRoot }, { appDataRoot, authState: { csrfPepper } });
    const project = app.locals.projectService.create({ title: 'Host Original', notes: 'Host notes', status: 'tbd' });
    const [category] = app.locals.projectAssetCategoryService.list(project.id);
    const categoryDir = path.join(projectsRoot, project.project_dir, category.directory_slug);
    fs.mkdirSync(categoryDir, { recursive: true });
    for (const name of ['first.png', 'second.png']) {
      await sharp({ create: { width: 12, height: 12, channels: 3, background: '#336699' } })
        .png().toFile(path.join(categoryDir, name));
    }
    app.locals.assetScanner.scanProjectAssets(project.id);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    await run({ origin: `http://127.0.0.1:${server.address().port}`, app, db, project });
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const markDocument = (page) => page.evaluate(() => { window.__projectEditHostDocument = true; });
const documentKept = (page) => page.evaluate(() => window.__projectEditHostDocument === true);
const currentPath = (page) => { const url = new URL(page.url()); return url.pathname + url.search; };
const projectTitle = (db, id) => db.prepare('SELECT title FROM projects WHERE id = ?').get(id).title;

function trackNavigations(page) {
  const navigations = [];
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
  return navigations;
}

function trackProjectPosts(page, projectId) {
  const posts = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === `/projects/${projectId}`) posts.push(request.url());
  });
  return posts;
}

async function loaded(dialog) {
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.app-dialog-body')).toBeVisible();
  await expect(dialog.locator('button[data-dialog-submit]')).toBeEnabled();
  return dialog;
}

test('Project Assets edits in place, keeps selection and the asset region, and updates the title', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await withHostApp(async ({ origin, db, project }) => {
    const assetsPath = `/projects/${project.id}/assets?view=list`;
    await page.goto(origin + assetsPath);
    const navigations = trackNavigations(page);
    const posts = trackProjectPosts(page, project.id);
    await markDocument(page);
    const region = page.locator('[data-project-assets-live-region]');
    await region.evaluate((node) => { node.__projectEditHostRegion = true; });
    const checkbox = page.locator('.asset-select-checkbox').first();
    await checkbox.check();
    await expect(page.locator('a[aria-label$=" from Host Original"]').first()).toBeAttached();

    const trigger = page.locator('.page-heading [data-project-edit-id], [data-project-edit-id]').first();
    await trigger.click();
    const dialog = await loaded(page.locator('#project-edit-dialog'));
    await expect(dialog.locator('#edit-project-title')).toHaveValue('Host Original');
    expect(currentPath(page)).toBe(assetsPath);

    // Close, then Escape, leave the page as it was.
    await dialog.getByRole('button', { name: 'Close Edit Project' }).click();
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await loaded(dialog);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // A refused save keeps the dialog and the draft.
    await trigger.click();
    await loaded(dialog);
    await dialog.locator('#edit-project-title').fill('');
    await dialog.locator('#edit-project-notes').fill('Assets draft');
    await dialog.locator('button[data-dialog-submit]').click();
    await expect(dialog.locator('#edit-project-title')).toHaveAttribute('aria-invalid', 'true');
    await expect(dialog.locator('#edit-project-notes')).toHaveValue('Assets draft');

    await dialog.locator('#edit-project-title').fill('Assets Renamed');
    await dialog.locator('button[data-dialog-submit]').click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('[data-dialog-feedback]')).toHaveText('Project updated.');
    await expect(page.locator('.app-section-title')).toHaveText('Assets — Assets Renamed');
    await expect(page).toHaveTitle(/Assets — Assets Renamed$/);
    await expect(page.locator('a[aria-label$=" from Assets Renamed"]').first()).toBeAttached();
    await expect(page.locator('[data-project-assets-title]')).toHaveText('Assets Renamed');
    expect(projectTitle(db, project.id)).toBe('Assets Renamed');

    // The asset region and its client state were never replaced.
    expect(await region.evaluate((node) => node.__projectEditHostRegion === true)).toBe(true);
    await expect(checkbox).toBeChecked();
    expect(posts).toHaveLength(2);
    expect(navigations).toEqual([]);
    expect(await documentKept(page)).toBe(true);
    expect(currentPath(page)).toBe(assetsPath);

    // Reopening loads the saved values.
    await trigger.click();
    await loaded(dialog);
    await expect(dialog.locator('#edit-project-title')).toHaveValue('Assets Renamed');
    await expect(dialog.locator('#edit-project-notes')).toHaveValue('Assets draft');
  });
});

test('a failed Projects refresh after a save reports it, never repeats the save, and retries with a GET', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await withHostApp(async ({ origin, db, project }) => {
    const listPath = '/projects?view=list&sort=title&order=asc';
    await page.goto(origin + listPath);
    await page.locator('[data-dashboard-title-info-bound="true"]').first().waitFor({ state: 'attached' });
    const navigations = trackNavigations(page);
    const posts = trackProjectPosts(page, project.id);
    await markDocument(page);

    await page.locator(`[aria-controls="projects-list-info-${project.id}"]`).click();
    await page.locator(`#projects-list-info-${project.id}`).getByRole('link', { name: 'Edit project' }).click();
    const dialog = await loaded(page.locator('#project-edit-dialog'));

    let failRefresh = true;
    await page.route((url) => url.pathname === '/projects', (route) => {
      if (route.request().method() === 'GET' && failRefresh) return route.fulfill({ status: 500, body: 'unavailable' });
      return route.continue();
    });
    await dialog.locator('#edit-project-title').fill('Saved Before Projects Failed');
    await dialog.locator('button[data-dialog-submit]').click();

    await expect(dialog).toBeHidden();
    const feedback = page.locator('[data-dialog-feedback]');
    await expect(feedback).toContainText('Project saved, but Projects could not refresh.');
    await expect(feedback).toHaveClass(/notice--error/);
    expect(projectTitle(db, project.id)).toBe('Saved Before Projects Failed');
    expect(posts).toHaveLength(1);

    failRefresh = false;
    await feedback.getByRole('button', { name: 'Retry refresh' }).click();
    await expect(feedback).toHaveText('Project updated.');
    await expect(page.locator(`[aria-controls="projects-list-info-${project.id}"]`)).toHaveText('Saved Before Projects Failed');
    expect(posts).toHaveLength(1);
    expect(navigations).toEqual([]);
    expect(await documentKept(page)).toBe(true);
    expect(currentPath(page)).toBe(listPath);
  });
});

test('Projects keeps its scroll position across an in-place save', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await withHostApp(async ({ origin, project }) => {
    const listPath = '/projects?view=list';
    await page.goto(origin + listPath);
    await page.locator('[data-dashboard-title-info-bound="true"]').first().waitFor({ state: 'attached' });
    await page.evaluate(() => { document.body.style.minHeight = '3000px'; window.scrollTo(0, 60); });
    const scrollBefore = await page.evaluate(() => window.scrollY);

    await page.locator(`[aria-controls="projects-list-info-${project.id}"]`).click();
    await page.locator(`#projects-list-info-${project.id}`).getByRole('link', { name: 'Edit project' }).click();
    const dialog = await loaded(page.locator('#project-edit-dialog'));
    await dialog.locator('#edit-project-title').fill('Scrolled Rename');
    await dialog.locator('button[data-dialog-submit]').click();
    await expect(dialog).toBeHidden();
    await expect(page.locator(`[aria-controls="projects-list-info-${project.id}"]`)).toHaveText('Scrolled Rename');
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
    await expect(page.locator(`[aria-controls="projects-list-info-${project.id}"]`)).toBeFocused();
  });
});

const openLocallyHref = (html) => html.match(/<a\b[^>]*\bdata-project-assets-open-locally\b[^>]*>/)?.[0]
  .match(/href="([^"]*)"/)?.[1].replace(/&amp;/g, '&');
const projectDir = (db, id) => db.prepare('SELECT project_dir FROM projects WHERE id = ?').get(id).project_dir;

test('Project Assets re-reads Open locally after a rename without touching the asset region', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await withHostApp(async ({ origin, app, db, project }) => {
    app.locals.openLocallySettingsService.setWindowsProjectsPath('D:\\CreatorCrate');
    const assetsPath = `/projects/${project.id}/assets?view=list`;
    await page.goto(origin + assetsPath);
    const navigations = trackNavigations(page);
    const posts = trackProjectPosts(page, project.id);
    await markDocument(page);
    const region = page.locator('[data-project-assets-live-region]');
    await region.evaluate((node) => { node.__projectEditHostRegion = true; });
    const checkbox = page.locator('.asset-select-checkbox').first();
    await checkbox.check();
    const link = page.locator('[data-project-assets-open-locally]');
    expect(decodeURIComponent(await link.getAttribute('href'))).toContain(`\\${project.project_dir}&`);

    await page.locator('[data-project-edit-id]').first().click();
    const dialog = await loaded(page.locator('#project-edit-dialog'));
    await dialog.locator('#edit-project-title').fill('Open Locally Renamed');
    await dialog.locator('button[data-dialog-submit]').click();
    await expect(dialog).toBeHidden();

    const renamedDir = projectDir(db, project.id);
    expect(renamedDir).not.toBe(project.project_dir);
    const fresh = openLocallyHref(await (await page.request.get(origin + assetsPath)).text());
    expect(decodeURIComponent(fresh)).toContain(`\\${renamedDir}&`);
    await expect(link).toHaveAttribute('href', fresh);
    await expect(link).not.toHaveAttribute('aria-disabled', 'true');
    expect(decodeURIComponent(await link.getAttribute('href'))).not.toContain(`\\${project.project_dir}&`);

    expect(await region.evaluate((node) => node.__projectEditHostRegion === true)).toBe(true);
    await expect(checkbox).toBeChecked();
    expect(posts).toHaveLength(1);
    expect(navigations).toEqual([]);
    expect(await documentKept(page)).toBe(true);
    expect(currentPath(page)).toBe(assetsPath);
  });
});

test('a failed Open locally refresh disables the link and retries with a GET, never repeating the save', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await withHostApp(async ({ origin, app, db, project }) => {
    app.locals.openLocallySettingsService.setWindowsProjectsPath('D:\\CreatorCrate');
    const assetsPath = `/projects/${project.id}/assets?view=list`;
    await page.goto(origin + assetsPath);
    const navigations = trackNavigations(page);
    const posts = trackProjectPosts(page, project.id);
    const region = page.locator('[data-project-assets-live-region]');
    await region.evaluate((node) => { node.__projectEditHostRegion = true; });
    const checkbox = page.locator('.asset-select-checkbox').first();
    await checkbox.check();

    let failRefresh = true;
    await page.route((url) => url.pathname === `/projects/${project.id}/assets`, (route) => {
      if (route.request().method() === 'GET' && failRefresh) return route.fulfill({ status: 500, body: 'unavailable' });
      return route.continue();
    });
    await page.locator('[data-project-edit-id]').first().click();
    const dialog = await loaded(page.locator('#project-edit-dialog'));
    await dialog.locator('#edit-project-title').fill('Open Locally Offline');
    await dialog.locator('button[data-dialog-submit]').click();
    await expect(dialog).toBeHidden();

    const feedback = page.locator('[data-dialog-feedback]');
    await expect(feedback).toContainText('Project saved, but Open locally could not refresh.');
    await expect(feedback).toHaveClass(/notice--error/);
    const link = page.locator('[data-project-assets-open-locally]');
    expect(await link.getAttribute('href')).toBeNull();
    await expect(link).toHaveAttribute('aria-disabled', 'true');
    expect(posts).toHaveLength(1);

    failRefresh = false;
    await feedback.getByRole('button', { name: 'Retry refresh' }).click();
    await expect(feedback).toHaveText('Project updated.');
    const fresh = openLocallyHref(await (await page.request.get(origin + assetsPath)).text());
    expect(decodeURIComponent(fresh)).toContain(`\\${projectDir(db, project.id)}&`);
    await expect(link).toHaveAttribute('href', fresh);
    await expect(link).not.toHaveAttribute('aria-disabled', 'true');
    expect(await region.evaluate((node) => node.__projectEditHostRegion === true)).toBe(true);
    await expect(checkbox).toBeChecked();
    expect(posts).toHaveLength(1);
    expect(navigations).toEqual([]);
    expect(currentPath(page)).toBe(assetsPath);
  });
});

async function editFromProjectsList(page, project) {
  await page.locator('[data-dashboard-title-info-bound="true"]').first().waitFor({ state: 'attached' });
  await page.locator(`[aria-controls="projects-list-info-${project.id}"]`).click();
  await page.locator(`#projects-list-info-${project.id}`).getByRole('link', { name: 'Edit project' }).click();
  return loaded(page.locator('#project-edit-dialog'));
}

test('a save that moves the project out of the Projects status filter returns focus to the main content', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await withHostApp(async ({ origin, db, project }) => {
    const listPath = '/projects?view=list&status=tbd';
    await page.goto(origin + listPath);
    const navigations = trackNavigations(page);
    const posts = trackProjectPosts(page, project.id);
    await markDocument(page);
    const scrollBefore = await page.evaluate(() => window.scrollY);

    const dialog = await editFromProjectsList(page, project);
    await dialog.locator('#edit-project-project-status-form summary').click();
    await dialog.locator('#edit-project-project-status-form label', { hasText: 'Ready' }).click();
    await dialog.locator('button[data-dialog-submit]').click();
    await expect(dialog).toBeHidden();

    await expect(page.locator(`[aria-controls="projects-list-info-${project.id}"]`)).toHaveCount(0);
    await expect(page.locator('#main-content')).toBeFocused();
    expect(db.prepare('SELECT status FROM projects WHERE id = ?').get(project.id).status).toBe('ready');
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
    expect(posts).toHaveLength(1);
    expect(navigations).toEqual([]);
    expect(await documentKept(page)).toBe(true);
    expect(currentPath(page)).toBe(listPath);
  });
});

test('a save that moves the project out of the Projects type filter returns focus to the main content', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await withHostApp(async ({ origin, db, project }) => {
    const { project_type: type } = db.prepare('SELECT project_type FROM projects WHERE id = ?').get(project.id);
    const listPath = `/projects?view=list&type=${encodeURIComponent(type)}`;
    await page.goto(origin + listPath);
    const navigations = trackNavigations(page);
    const posts = trackProjectPosts(page, project.id);

    const dialog = await editFromProjectsList(page, project);
    await dialog.locator('#edit-project-project-type-form summary').click();
    await dialog.locator('#edit-project-project-type-form label:has(input[type="radio"]:not(:checked):not([value=""]))').first().click();
    await dialog.locator('button[data-dialog-submit]').click();
    await expect(dialog).toBeHidden();

    await expect(page.locator(`[aria-controls="projects-list-info-${project.id}"]`)).toHaveCount(0);
    await expect(page.locator('#main-content')).toBeFocused();
    expect(db.prepare('SELECT project_type FROM projects WHERE id = ?').get(project.id).project_type).not.toBe(type);
    expect(posts).toHaveLength(1);
    expect(navigations).toEqual([]);
    expect(currentPath(page)).toBe(listPath);
  });
});

test('the Projects focus fallback never takes focus the user moved elsewhere during the refresh', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await withHostApp(async ({ origin, project }) => {
    await page.goto(`${origin}/projects?view=list&status=tbd`);
    const dialog = await editFromProjectsList(page, project);

    let releaseRefresh;
    const refreshHeld = new Promise((resolve) => { releaseRefresh = resolve; });
    await page.route((url) => url.pathname === '/projects', async (route) => {
      if (route.request().method() === 'GET') await refreshHeld;
      return route.continue();
    });
    await dialog.locator('#edit-project-project-status-form summary').click();
    await dialog.locator('#edit-project-project-status-form label', { hasText: 'Ready' }).click();
    await dialog.locator('button[data-dialog-submit]').click();
    await expect(dialog).toBeHidden();

    // Outside the live region, so the refresh itself does not remove it.
    const elsewhere = page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Calendar' });
    await elsewhere.focus();
    releaseRefresh();
    await expect(page.locator(`[aria-controls="projects-list-info-${project.id}"]`)).toHaveCount(0);
    await expect(page.locator('[data-dialog-feedback]')).toHaveText('Project updated.');
    await expect(elsewhere).toBeFocused();
  });
});

test('Dashboard project cards edit in place and the Dashboard refreshes after a save', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await withHostApp(async ({ origin, db, project }) => {
    await page.goto(`${origin}/`);
    await page.locator('[data-dashboard-title-info-bound="true"]').first().waitFor({ state: 'attached' });
    const navigations = trackNavigations(page);
    const posts = trackProjectPosts(page, project.id);
    await markDocument(page);

    const cardId = `dashboard-project-info-table-${project.id}`;
    const title = page.locator(`[aria-controls="${cardId}"]`);
    await title.click();
    const card = page.locator(`#${cardId}`);
    await expect(card).toBeVisible();
    await card.getByRole('link', { name: 'Edit project' }).click();
    const dialog = await loaded(page.locator('#project-edit-dialog'));
    await expect(card).toBeHidden();
    await expect(dialog.locator('#edit-project-title')).toHaveValue('Host Original');

    // New Project's fields keep their own ids beside Edit Project's.
    await expect(page.locator('#project-create-dialog #title')).toHaveCount(1);

    await dialog.locator('#edit-project-title').fill('Dashboard Renamed');
    await dialog.locator('button[data-dialog-submit]').click();
    await expect(dialog).toBeHidden();
    await expect(page.locator(`[aria-controls="${cardId}"]`)).toHaveText('Dashboard Renamed');
    expect(projectTitle(db, project.id)).toBe('Dashboard Renamed');
    expect(posts).toHaveLength(1);
    expect(navigations).toEqual([]);
    expect(await documentKept(page)).toBe(true);
    expect(currentPath(page)).toBe('/');

    // The refreshed card still pins, and reopening loads the saved values.
    await page.locator(`[aria-controls="${cardId}"]`).click();
    await expect(page.locator(`#${cardId}`)).toBeVisible();
    await page.locator(`#${cardId}`).getByRole('link', { name: 'Edit project' }).click();
    await loaded(dialog);
    await expect(dialog.locator('#edit-project-title')).toHaveValue('Dashboard Renamed');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
  expect(pageErrors).toEqual([]);
});
