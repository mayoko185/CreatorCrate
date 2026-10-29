import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { openDatabase, closeDatabase, runMigrations } from '../../src/db.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';

// Edit Project saves in place on Project Detail: the document is never
// navigated or replaced, every open loads the saved project, and the page's
// project content refreshes locally after a save.

async function withProjectApp(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-project-edit-flow-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    const tags = Object.fromEntries(['Alpha', 'Beta'].map((name) => [name, app.locals.tagService.createTag({ name })]));
    const project = app.locals.projectService.create(
      { title: 'Original Title', notes: 'Original notes', status: 'tbd' },
      { tagIds: [tags.Alpha.id] },
    );
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    await run({ origin: `http://127.0.0.1:${server.address().port}`, app, db, project, tags });
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// A document replaced by navigation loses this marker.
const markDocument = (page) => page.evaluate(() => { window.__projectEditFlowDocument = true; });
const documentKept = (page) => page.evaluate(() => window.__projectEditFlowDocument === true);

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

async function openEdit(page) {
  const trigger = page.locator('.project-detail-action-toolbar [data-project-edit-id]');
  await trigger.click();
  const dialog = page.locator('#project-edit-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.app-dialog-body')).toBeVisible();
  await expect(dialog.locator('button[data-dialog-submit]')).toBeEnabled();
  return { trigger, dialog };
}

async function toggleTag(dialog, name) {
  await dialog.locator('#project-tags-form summary').click();
  await dialog.locator('#project-tags-form label', { hasText: name }).click();
  await dialog.locator('#project-tags-form summary').click();
}

const projectRow = (db, id) => db.prepare('SELECT title, notes, status, patreon_url FROM projects WHERE id = ?').get(id);
const tagNames = (app, id) => app.locals.projectTagService.listProjectTags(id).map((tag) => tag.display_name).sort();

test('Project Detail edits in place, refreshes its content, and reopens with the saved values', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 600 });

  await withProjectApp(async ({ origin, app, db, project }) => {
    const detailUrl = `${origin}/projects/${project.id}`;
    await page.goto(detailUrl);
    const navigations = trackNavigations(page);
    const posts = trackProjectPosts(page, project.id);
    await markDocument(page);

    // Changed after the page rendered: the dialog must load the saved value.
    db.prepare('UPDATE projects SET notes = ? WHERE id = ?').run('Changed elsewhere', project.id);
    const { trigger, dialog } = await openEdit(page);
    // Scroll the page behind the modal; the save must keep it there.
    await page.evaluate(() => window.scrollTo(0, 200));
    const scrollY = await page.evaluate(() => window.scrollY);
    expect(scrollY).toBeGreaterThan(0);
    // The feedback notice above may shift scrollY; what the user was looking
    // at (the Releases section, outside the refreshed region) stays put.
    const anchor = page.locator('.project-detail-releases h2');
    const anchorTop = (await anchor.boundingBox()).y;
    await expect(dialog.locator('#notes')).toHaveValue('Changed elsewhere');
    await expect(dialog.locator('#title')).toHaveValue('Original Title');

    await dialog.locator('#title').fill('Renamed In Place');
    await dialog.locator('#notes').fill('Saved notes');
    await dialog.locator('#project-status-form summary').click();
    await dialog.locator('#project-status-form label', { hasText: 'Planned' }).click();
    await toggleTag(dialog, 'Beta');
    await dialog.locator('button[data-dialog-submit]').click();

    await expect(dialog).toBeHidden();
    await expect(page.locator('[data-dialog-feedback]')).toHaveText('Project updated.');
    expect(projectRow(db, project.id)).toMatchObject({ title: 'Renamed In Place', notes: 'Saved notes', status: 'planned' });
    expect(tagNames(app, project.id)).toEqual(['Alpha', 'Beta']);

    // The page's project content shows the saved project without a reload.
    const hero = page.locator('[data-project-detail-region="hero"]');
    await expect(hero.locator('.notes')).toHaveText('Saved notes');
    await expect(hero.locator('.tag-chip')).toHaveText(['Alpha', 'Beta']);
    await expect(hero.locator('.project-status-badge')).toContainText('Planned');
    await expect(page.locator('.app-section-title')).toContainText('Renamed In Place');
    await expect(page).toHaveTitle(/Renamed In Place/);
    expect(posts).toHaveLength(1);
    expect(page.url()).toBe(detailUrl);
    expect(navigations).toEqual([]);
    expect(await documentKept(page)).toBe(true);
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThanOrEqual(scrollY);
    expect(Math.abs((await anchor.boundingBox()).y - anchorTop)).toBeLessThanOrEqual(2);
    // Focus returns to the (refreshed) Edit action.
    await expect(trigger).toBeFocused();

    // Reopening shows the saved values, tags included.
    await trigger.click();
    await expect(dialog.locator('.app-dialog-body')).toBeVisible();
    await expect(dialog.locator('#title')).toHaveValue('Renamed In Place');
    await expect(dialog.locator('#notes')).toHaveValue('Saved notes');
    await expect(dialog.locator('input[name="status"][value="planned"]')).toBeChecked();
    await expect(dialog.locator('input[name="tagIds[]"]:checked')).toHaveCount(2);
  });
  expect(pageErrors).toEqual([]);
});

test('validation keeps the dialog, the draft and tags; Close and Escape keep the page', async ({ page }) => {
  await withProjectApp(async ({ origin, app, db, project }) => {
    const detailUrl = `${origin}/projects/${project.id}`;
    await page.goto(detailUrl);
    const navigations = trackNavigations(page);
    const posts = trackProjectPosts(page, project.id);
    await markDocument(page);
    const before = projectRow(db, project.id);
    const { trigger, dialog } = await openEdit(page);

    await dialog.locator('#notes').fill('Draft notes');
    await dialog.locator('#patreonUrl').fill('not-a-url');
    await toggleTag(dialog, 'Beta');
    await dialog.locator('button[data-dialog-submit]').click();

    await expect(dialog.locator('#patreonUrl')).toHaveAttribute('aria-invalid', 'true');
    await expect(dialog.locator('#patreonUrl-error')).toHaveText('Project link must be a valid absolute HTTP or HTTPS URL.');
    await expect(dialog.locator('#patreonUrl')).toBeFocused();
    await expect(dialog.locator('[data-dialog-error]')).toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('#notes')).toHaveValue('Draft notes');
    await expect(dialog.locator('#project-tags-form [data-cc-dropdown-summary-current]')).toHaveText('2 tags selected');
    await expect(page.locator('[data-dialog-feedback]')).toBeHidden();
    expect(projectRow(db, project.id)).toEqual(before);
    expect(tagNames(app, project.id)).toEqual(['Alpha']);
    expect(posts).toHaveLength(1);

    // Close discards the draft and its errors and returns focus.
    await dialog.locator('.app-dialog-close').click();
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expect(dialog.locator('.app-dialog-body')).toBeVisible();
    await expect(dialog.locator('#notes')).toHaveValue('Original notes');
    await expect(dialog.locator('#patreonUrl')).toHaveValue('');
    await expect(dialog.locator('[aria-invalid="true"]')).toHaveCount(0);
    await expect(dialog.locator('[data-dialog-error]')).toBeHidden();
    await expect(dialog.locator('input[name="tagIds[]"]:checked')).toHaveCount(1);

    // Escape dismisses locally too.
    await dialog.locator('#notes').fill('Escaped draft');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();

    expect(projectRow(db, project.id)).toEqual(before);
    expect(posts).toHaveLength(1);
    expect(page.url()).toBe(detailUrl);
    expect(navigations).toEqual([]);
    expect(await documentKept(page)).toBe(true);
  });
});

test('a failed Project Detail refresh after a save reports it, never repeats the save, and retries with a GET', async ({ page }) => {
  await withProjectApp(async ({ origin, db, project }) => {
    const detailUrl = `${origin}/projects/${project.id}`;
    await page.goto(detailUrl);
    const navigations = trackNavigations(page);
    const posts = trackProjectPosts(page, project.id);
    await markDocument(page);
    const { dialog } = await openEdit(page);

    let failRefresh = true;
    await page.route(`${detailUrl}`, (route) => {
      if (route.request().method() === 'GET' && failRefresh) return route.fulfill({ status: 500, body: 'unavailable' });
      return route.continue();
    });
    await dialog.locator('#title').fill('Saved Before Refresh Failed');
    await dialog.locator('button[data-dialog-submit]').click();

    await expect(dialog).toBeHidden();
    const feedback = page.locator('[data-dialog-feedback]');
    await expect(feedback).toContainText('Project saved, but Project Detail could not refresh.');
    await expect(feedback).toHaveClass(/notice--error/);
    expect(projectRow(db, project.id).title).toBe('Saved Before Refresh Failed');
    expect(posts).toHaveLength(1);

    failRefresh = false;
    await feedback.getByRole('button', { name: 'Retry refresh' }).click();
    await expect(feedback).toHaveText('Project updated.');
    await expect(page.locator('.app-section-title')).toContainText('Saved Before Refresh Failed');
    expect(posts).toHaveLength(1);
    expect(navigations).toEqual([]);
    expect(await documentKept(page)).toBe(true);
  });
});

test('a service failure keeps the dialog and draft with a safe message', async ({ page }) => {
  await withProjectApp(async ({ origin, app, db, project }) => {
    await page.goto(`${origin}/projects/${project.id}`);
    const navigations = trackNavigations(page);
    await markDocument(page);
    const { dialog } = await openEdit(page);
    const update = app.locals.projectService.update;
    app.locals.projectService.update = () => { throw new Error(`EACCES private detail ${os.tmpdir()}`); };

    try {
      await dialog.locator('#title').fill('Never Saved');
      await dialog.locator('button[data-dialog-submit]').click();
      await expect(dialog.locator('[data-dialog-error-text]')).toHaveText('Project update failed. Please try again.');
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('#title')).toHaveValue('Never Saved');
      await expect(dialog).not.toContainText('EACCES');
    } finally {
      app.locals.projectService.update = update;
    }
    expect(projectRow(db, project.id).title).toBe('Original Title');
    expect(navigations).toEqual([]);
    expect(await documentKept(page)).toBe(true);
  });
});

test('the ?edit=1 deep link opens the dialog and a returnTo deep link still returns after saving', async ({ page }) => {
  await withProjectApp(async ({ origin, db, project }) => {
    await page.goto(`${origin}/projects/${project.id}/edit`);
    expect(new URL(page.url()).search).toBe('?edit=1');
    const dialog = page.locator('#project-edit-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('#title')).toHaveValue('Original Title');
    await dialog.locator('#title').fill('Deep Link Saved');
    await dialog.locator('button[data-dialog-submit]').click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('.app-section-title')).toContainText('Deep Link Saved');
    expect(projectRow(db, project.id).title).toBe('Deep Link Saved');

    await page.goto(`${origin}/projects/${project.id}/edit?returnTo=${encodeURIComponent('/projects?view=list')}`);
    await expect(dialog).toBeVisible();
    await dialog.locator('#title').fill('Returned To Projects');
    await Promise.all([
      page.waitForURL(`${origin}/projects?view=list`),
      dialog.locator('button[data-dialog-submit]').click(),
    ]);
    expect(projectRow(db, project.id).title).toBe('Returned To Projects');
  });
});
