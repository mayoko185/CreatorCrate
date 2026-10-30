import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createApp } from '../../src/app.js';
import { openDatabase, closeDatabase, runMigrations } from '../../src/db.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';

// New Release from selected assets runs entirely on Project Assets: the host
// document is never navigated or replaced, the asset region is never replaced
// (only its release information is re-read with a GET), and the create POST is
// sent once per submission.

const FILES = ['a.png', 'b.png', 'c.png', 'd.png'];

async function withAssetsApp(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-assets-new-release-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    app.locals.socialPrepSettingsService.setPlatforms(['x', 'bluesky']);
    const signature = app.locals.releaseSignatureSettingsService
      .add({ name: 'Default Signature', body: 'Signed by default' }).entries[0];
    app.locals.releaseSignatureSettingsService.setDefault(signature.id);

    const project = app.locals.projectService.create({ title: 'Selection Project', status: 'tbd' });
    const categories = app.locals.projectAssetCategoryService;
    if (!categories.list(project.id).some((candidate) => candidate.directory_slug === 'wip')) {
      categories.add(project.id, { displayName: 'WIP', directorySlug: 'wip' });
    }
    const category = categories.list(project.id).find((candidate) => candidate.directory_slug === 'wip');
    const categoryDir = path.join(projectsRoot, project.project_dir, 'wip');
    fs.mkdirSync(categoryDir, { recursive: true });
    for (const filename of FILES) {
      await sharp({ create: { width: 12, height: 12, channels: 3, background: { r: 20, g: 90, b: 160 } } })
        .png().toFile(path.join(categoryDir, filename));
    }
    app.locals.assetScanner.scanProjectAssets(project.id);
    const ids = Object.fromEntries(db.prepare('SELECT id, filename FROM assets WHERE project_id = ?')
      .all(project.id).map((asset) => [asset.filename, asset.id]));

    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    await run({
      app, db, project, ids, origin,
      assetsUrl: `${origin}/projects/${project.id}/assets?category=${category.id}`,
    });
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const releaseCount = (db) => db.prepare('SELECT COUNT(*) AS count FROM releases').get().count;
const releaseAssetIds = (db, releaseId) => db.prepare(
  'SELECT asset_id FROM release_assets WHERE release_id = ? ORDER BY sort_order',
).all(releaseId).map((row) => row.asset_id);

const markDocument = (page) => page.evaluate(() => { window.__assetsReleaseDocument = true; });
const documentKept = (page) => page.evaluate(() => window.__assetsReleaseDocument === true);

function track(page) {
  const log = { navigations: [], creates: [], handoffs: [], pageGets: [] };
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) log.navigations.push(frame.url()); });
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (request.method() === 'POST' && pathname === '/releases') log.creates.push(request.postData());
    if (request.method() === 'POST' && pathname.endsWith('/assets/create-release')) log.handoffs.push(pathname);
    if (request.method() === 'GET' && /^\/projects\/\d+\/assets$/.test(pathname)) log.pageGets.push(request.url());
  });
  return log;
}

async function openPage(page, assetsUrl) {
  await page.goto(assetsUrl);
  await page.waitForFunction(() => document.getElementById('release-create-dialog')
    ?.__creatorCrateAppDialogState?.releaseCreateBound === true);
  await markDocument(page);
}

const checkbox = (page, id) => page.locator(`input[name="selectedAssetIds"][form="bulk-select-form"][value="${id}"]`);
const select = async (page, ...ids) => {
  for (const id of ids) await checkbox(page, id).check({ force: true });
};
const trigger = (page) => page.locator('[data-asset-actions-panel] [data-dialog-open="release-create-dialog"]');
const hiddenIds = (form) => form.locator('input[type="hidden"][name="selectedAssetIds"]')
  .evaluateAll((inputs) => inputs.map((input) => Number(input.value)));
const selectedOnPage = (page) => page.locator('input[name="selectedAssetIds"][form="bulk-select-form"]:checked')
  .evaluateAll((inputs) => inputs.map((input) => Number(input.value)));

test('opens in place with the live selection and every dismissal stays local', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await withAssetsApp(async ({ db, project, ids, assetsUrl }) => {
    await openPage(page, assetsUrl);
    const log = track(page);
    const dialog = page.locator('#release-create-dialog');
    const form = dialog.locator('#release-create-form');

    await select(page, ids['a.png'], ids['c.png']);
    await trigger(page).click();
    await expect(dialog).toBeVisible();
    expect(await hiddenIds(form)).toEqual([ids['a.png'], ids['c.png']]);
    await expect(form.locator('[data-release-create-selection-summary]')).toHaveText('Creating a release from 2 selected assets.');
    await expect(form.locator('input[name="projectId"]:checked')).toHaveValue(String(project.id));
    await expect(form.locator('input[name="projectId"]')).toHaveCount(1);
    await expect(form.getByLabel('Title')).toHaveValue('Selection Project');
    await expect(form.locator('textarea[name="description"]')).toHaveValue('Signed by default');
    await expect(form.locator('input[name="plannedDate"]')).not.toHaveValue('');
    await expect(dialog.locator('[data-dialog-submit]')).toBeEnabled();

    // Close, Escape and the backdrop: draft dropped, selection kept, focus back.
    await form.getByLabel('Title').fill('Dropped draft');
    await dialog.locator('[data-dialog-close]').first().click();
    await expect(dialog).toBeHidden();
    await expect(trigger(page)).toBeFocused();
    expect(await selectedOnPage(page)).toEqual([ids['a.png'], ids['c.png']]);
    expect(await hiddenIds(form)).toEqual([]);

    await trigger(page).click();
    await expect(form.getByLabel('Title')).toHaveValue('Selection Project');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger(page)).toBeFocused();

    await trigger(page).click();
    await page.mouse.click(4, 4);
    await expect(dialog).toBeHidden();

    // A reopen reads the selection as it is now, in page order.
    await select(page, ids['b.png']);
    await checkbox(page, ids['a.png']).uncheck({ force: true });
    await trigger(page).click();
    expect(await hiddenIds(form)).toEqual([ids['b.png'], ids['c.png']]);
    await expect(form.locator('[data-release-create-selection-summary]')).toHaveText('Creating a release from 2 selected assets.');
    await dialog.locator('[data-dialog-close]').first().click();

    // With nothing selected there is nothing to send.
    await checkbox(page, ids['b.png']).uncheck({ force: true });
    await checkbox(page, ids['c.png']).uncheck({ force: true });
    await trigger(page).click();
    await expect(form.locator('[data-release-create-selection-summary]')).toContainText('No assets selected');
    await expect(dialog.locator('[data-dialog-submit]')).toBeDisabled();
    await dialog.locator('[data-dialog-close]').first().click();
    await select(page, ids['d.png']);
    await trigger(page).click();
    await expect(dialog.locator('[data-dialog-submit]')).toBeEnabled();

    expect(log.navigations).toEqual([]);
    expect(log.handoffs).toEqual([]);
    expect(log.creates).toEqual([]);
    expect(await documentKept(page)).toBe(true);
    expect(releaseCount(db)).toBe(0);
    expect(pageErrors).toEqual([]);
  });
});

test('a save associates the selection once and leaves the whole page as it was', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 500 });

  await withAssetsApp(async ({ db, project, ids, assetsUrl }) => {
    await openPage(page, `${assetsUrl}&view=list`);
    const log = track(page);
    const url = page.url();
    const dialog = page.locator('#release-create-dialog');
    const form = dialog.locator('#release-create-form');

    // A pending reorder and a selected row that is not currently shown.
    await page.evaluate(({ first, last }) => {
      const row = (id) => document.querySelector(`input[name="selectedAssetIds"][value="${id}"]`).closest('[data-auto-rename-asset]');
      const moved = row(last);
      moved.parentElement.insertBefore(moved, row(first));
    }, { first: ids['a.png'], last: ids['d.png'] });
    await select(page, ids['a.png'], ids['b.png'], ids['d.png']);
    await page.evaluate((id) => {
      document.querySelector(`input[name="selectedAssetIds"][value="${id}"]`).closest('[data-auto-rename-asset]').hidden = true;
    }, ids['b.png']);
    const pageState = () => page.evaluate(() => ({
      order: Array.from(document.querySelectorAll('input[name="selectedAssetIds"][form="bulk-select-form"]')).map((input) => input.value),
      scrollY: window.scrollY,
    }));

    await trigger(page).scrollIntoViewIfNeeded();
    await page.evaluate(() => { document.querySelector('[data-project-assets-live-region]').dataset.untouched = 'yes'; });
    await trigger(page).click();
    await expect(dialog).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 120));
    const before = await pageState();

    await form.getByLabel('Title').fill('From selection');
    await form.getByLabel('Notes').fill('Selection notes');
    await form.getByLabel('Scheduled date', { exact: true }).fill('2027-06-07');
    await form.getByLabel('Scheduled time', { exact: true }).fill('14:45');
    await form.locator('#release-platforms summary').click();
    await form.locator('input[name="selectedPlatforms"][value="x"]').check({ force: true });
    await form.locator('#release-platforms summary').click();
    await form.getByLabel('Release link').fill('https://example.com/selection');
    await dialog.locator('[data-dialog-submit]').dblclick();

    const feedback = page.locator('[data-dialog-feedback]');
    await expect(feedback).toContainText('Release “From selection” created with 3 assets.');
    await expect(dialog).toBeHidden();
    await expect(trigger(page)).toBeFocused();

    const release = db.prepare('SELECT * FROM releases WHERE title = ?').get('From selection');
    expect(release).toMatchObject({
      project_id: project.id, planned_date: '2027-06-07', planned_time: '14:45',
      notes: 'Selection notes', patreon_url: 'https://example.com/selection', description: 'Signed by default',
    });
    expect(releaseAssetIds(db, release.id)).toEqual([ids['d.png'], ids['a.png'], ids['b.png']]);
    expect(db.prepare('SELECT platform FROM release_social_platforms WHERE release_id = ?').all(release.id)
      .map((row) => row.platform)).toEqual(['x']);

    await expect(feedback.locator('[data-release-create-view]')).toHaveAttribute('href', `/releases/${release.id}`);
    await expect(feedback.locator('[data-release-create-manage-assets]')).toHaveAttribute('href', `/releases/${release.id}/assets`);
    await expect(feedback).toBeInViewport();

    expect(log.creates).toHaveLength(1);
    expect(log.navigations).toEqual([]);
    await expect(page.locator('#releaseId-action-native')).toBeEnabled();
    expect(log.pageGets).toEqual([url]);
    expect(page.url()).toBe(url);
    expect(await documentKept(page)).toBe(true);
    expect(await pageState()).toEqual(before);
    expect(await page.evaluate(() => document.querySelector('[data-project-assets-live-region]').dataset.untouched)).toBe('yes');
    expect(await selectedOnPage(page)).toEqual([ids['d.png'], ids['a.png'], ids['b.png']]);

    // A reopen starts clean, for the page's project, from the current selection.
    await checkbox(page, ids['a.png']).uncheck({ force: true });
    await trigger(page).click();
    expect(await hiddenIds(form)).toEqual([ids['d.png'], ids['b.png']]);
    await expect(form.getByLabel('Title')).toHaveValue('Selection Project');
    await expect(form.getByLabel('Notes')).toHaveValue('');
    await expect(form.locator('input[name="projectId"]:checked')).toHaveValue(String(project.id));
    await expect(form.locator('input[name="selectedPlatforms"]:checked')).toHaveCount(0);
    await expect(form.getByLabel('Release link')).toHaveValue('');
    await expect(form.locator('input[name="plannedDate"]')).not.toHaveValue('2027-06-07');
    await dialog.locator('[data-dialog-close]').first().click();

    await feedback.locator('[data-release-create-dismiss]').click();
    await expect(feedback).toBeHidden();
    await expect(trigger(page)).toBeFocused();

    // A reload does not send the create again.
    await page.reload();
    await expect(page.locator('#release-create-dialog')).toBeAttached();
    expect(log.creates).toHaveLength(1);
    expect(releaseCount(db)).toBe(1);
    expect(pageErrors).toEqual([]);
  });
});

test('validation failures keep the draft and the selection; stale assets fail safely', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await withAssetsApp(async ({ db, ids, assetsUrl }) => {
    await openPage(page, assetsUrl);
    const log = track(page);
    const dialog = page.locator('#release-create-dialog');
    const form = dialog.locator('#release-create-form');
    const summary = dialog.locator('[data-dialog-error]');

    await select(page, ids['a.png'], ids['b.png']);
    await trigger(page).click();
    await form.getByLabel('Title').fill('');
    await form.getByLabel('Notes').fill('Keep me');
    await form.getByLabel('Scheduled date', { exact: true }).fill('2027-08-09');
    await form.getByLabel('Scheduled time', { exact: true }).fill('09:30');
    await form.locator('#release-platforms summary').click();
    await form.locator('input[name="selectedPlatforms"][value="bluesky"]').check({ force: true });
    await form.locator('#release-platforms summary').click();
    await form.getByLabel('Release link').fill('https://example.com/kept');
    await dialog.locator('[data-dialog-submit]').click();

    await expect(form.locator('[data-dialog-field="title"] .field-error-message')).toBeVisible();
    await expect(summary).toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(form.getByLabel('Notes')).toHaveValue('Keep me');
    await expect(form.getByLabel('Scheduled date', { exact: true })).toHaveValue('2027-08-09');
    await expect(form.getByLabel('Scheduled time', { exact: true })).toHaveValue('09:30');
    await expect(form.locator('input[name="selectedPlatforms"][value="bluesky"]')).toBeChecked();
    await expect(form.getByLabel('Release link')).toHaveValue('https://example.com/kept');
    await expect(form.locator('textarea[name="description"]')).toHaveValue('Signed by default');
    expect(await hiddenIds(form)).toEqual([ids['a.png'], ids['b.png']]);
    await expect(dialog.locator('[data-dialog-submit]')).toBeEnabled();
    expect(releaseCount(db)).toBe(0);

    // An asset that went missing since the page loaded is refused whole.
    db.prepare('UPDATE assets SET is_present = 0 WHERE id = ?').run(ids['b.png']);
    await form.getByLabel('Title').fill('Stale selection');
    await dialog.locator('[data-dialog-submit]').click();
    await expect(summary).toContainText(`Asset ${ids['b.png']} is currently missing`);
    await expect(summary).toContainText('Update the selection on Project Assets');
    await expect(dialog).toBeVisible();
    expect(await hiddenIds(form)).toEqual([ids['a.png'], ids['b.png']]);
    expect(releaseCount(db)).toBe(0);

    // A deleted asset is reported the same way, without creating anything.
    db.prepare('DELETE FROM assets WHERE id = ?').run(ids['b.png']);
    await dialog.locator('[data-dialog-submit]').click();
    await expect(summary).toContainText('Update the selection on Project Assets');
    expect(releaseCount(db)).toBe(0);

    // Dismissing clears the refusal; the selection on the page is untouched.
    await dialog.locator('[data-dialog-close]').first().click();
    await expect(dialog).toBeHidden();
    expect(await selectedOnPage(page)).toEqual([ids['a.png'], ids['b.png']]);
    await checkbox(page, ids['b.png']).uncheck({ force: true });
    await trigger(page).click();
    await expect(summary).toBeHidden();
    await expect(form.locator('[aria-invalid="true"]')).toHaveCount(0);
    await form.getByLabel('Title').fill('Recovered');
    await dialog.locator('[data-dialog-submit]').click();
    await expect(page.locator('[data-dialog-feedback]')).toContainText('created with 1 asset.');

    const release = db.prepare('SELECT id FROM releases WHERE title = ?').get('Recovered');
    expect(releaseAssetIds(db, release.id)).toEqual([ids['a.png']]);
    expect(log.navigations).toEqual([]);
    expect(await documentKept(page)).toBe(true);
    expect(pageErrors).toEqual([]);
  });
});

test('lost responses and server failures never repeat the create or claim success', async ({ page }) => {
  await withAssetsApp(async ({ db, ids, assetsUrl }) => {
    await openPage(page, assetsUrl);
    const log = track(page);
    const dialog = page.locator('#release-create-dialog');
    const form = dialog.locator('#release-create-form');
    const feedback = page.locator('[data-dialog-feedback]');

    await select(page, ids['a.png'], ids['b.png']);
    await trigger(page).click();
    await form.getByLabel('Title').fill('Lost response');

    // The server commits, but the response never reaches the page.
    await page.route('**/releases', async (route) => {
      await route.fetch();
      await route.abort('connectionreset');
    });
    await dialog.locator('[data-dialog-submit]').click();
    await expect(dialog.locator('[data-dialog-status]')).toContainText('Could not confirm whether the release was created');
    await page.waitForTimeout(300);
    await expect(dialog).toBeVisible();
    await expect(feedback).toBeHidden();
    await expect(dialog.locator('[data-dialog-submit]')).toBeEnabled();
    expect(log.creates).toHaveLength(1);
    expect(releaseCount(db)).toBe(1);
    expect(await hiddenIds(form)).toEqual([ids['a.png'], ids['b.png']]);
    await page.unroute('**/releases');

    // An unexpected server failure shows no backend detail.
    await page.route('**/releases', (route) => route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'error', code: 'SERVER_ERROR', message: 'Release creation failed. Please try again.', errors: {} }),
    }));
    await dialog.locator('[data-dialog-submit]').click();
    await expect(dialog.locator('[data-dialog-error]')).toContainText('Release creation failed.');
    await expect(feedback).toBeHidden();
    await page.unroute('**/releases');
    await page.route('**/releases', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Sign in</p>' }));
    await dialog.locator('[data-dialog-submit]').click();
    await expect(dialog.locator('[data-dialog-error]')).toContainText('Release could not be created.');
    await expect(feedback).toBeHidden();
    await page.unroute('**/releases');
    expect(await selectedOnPage(page)).toEqual([ids['a.png'], ids['b.png']]);

    // An unreachable page after a confirmed create cannot trigger a second write.
    await page.route(/\/projects\/\d+\/assets(\?|$)/, (route) => route.abort());
    await form.getByLabel('Title').fill('Confirmed');
    await dialog.locator('[data-dialog-submit]').click();
    await expect(feedback).toContainText('Release “Confirmed” created');
    await expect(feedback.locator('[data-release-create-refresh-retry]')).toBeVisible();
    await page.waitForTimeout(300);
    expect(log.creates).toHaveLength(4);
    expect(db.prepare('SELECT COUNT(*) AS count FROM releases WHERE title = ?').get('Confirmed').count).toBe(1);
    expect(log.pageGets).toHaveLength(1);
    expect(log.navigations).toEqual([]);
    expect(await documentKept(page)).toBe(true);
  });
});

test('a live filter change shows the selection the dialog will use and the dialog controls stay functional', async ({ page }) => {
  await withAssetsApp(async ({ ids, assetsUrl }) => {
    await openPage(page, assetsUrl);
    const dialog = page.locator('#release-create-dialog');
    const form = dialog.locator('#release-create-form');

    // Replacing the region for a view switch keeps the host and its dialog bound.
    await select(page, ids['a.png']);
    await page.locator('nav.view-switcher a[href*="view=list"]').first().click();
    await expect(page.locator('[data-project-assets-live-region]')).not.toHaveAttribute('aria-busy', 'true');
    // The established refresh renders a new, unselected page; the count says so.
    const remaining = await selectedOnPage(page);
    expect(remaining).toEqual([]);
    await expect(page.locator('[data-selected-count]')).toContainText(`${remaining.length} of`);

    await trigger(page).click();
    await expect(dialog).toBeVisible();
    expect(await hiddenIds(form)).toEqual(remaining);

    // Enhanced picker and signature controls answer in this host.
    await form.locator('.date-picker-trigger').first().click();
    await expect(form.locator('[data-date-picker-panel]').first()).toBeVisible();
    await page.keyboard.press('Escape');
    await form.getByLabel('No set release date').check();
    await expect(form.locator('input[name="plannedDate"]')).toBeDisabled();
    await form.getByLabel('No set release date').uncheck();
    await expect(form.locator('input[name="plannedDate"]')).toBeEnabled();
    await form.locator('[data-dialog-open="release-signatures-dialog"]').click();
    await expect(page.locator('#release-signatures-dialog')).toBeVisible();
    await page.locator('#release-signatures-dialog [data-dialog-close]').first().click();
    await expect(dialog).toBeVisible();

    // No element id collides with the page's other dialogs.
    const duplicates = await page.evaluate(() => {
      const repeated = new Set();
      document.querySelectorAll('#release-create-dialog [id], #release-signatures-dialog [id]').forEach((element) => {
        if (document.querySelectorAll(`[id="${CSS.escape(element.id)}"]`).length > 1) repeated.add(element.id);
      });
      return [...repeated];
    });
    expect(duplicates).toEqual([]);
  });
});

// --- Host synchronization after a confirmed create ---

const releaseSelect = (page) => page.locator('#releaseId-action-native');
const addSubmit = (page) => page.locator('[data-bulk-submit]');
const releaseOptionValues = (page) => releaseSelect(page).locator('option')
  .evaluateAll((options) => options.map((option) => option.value));
const panelValues = (page) => page.locator('#releaseId-action input[type="radio"]')
  .evaluateAll((inputs) => inputs.map((input) => input.value));
const cardRelease = (page, id) => page.locator(`article[data-asset-id="${id}"] [data-asset-release-section]`);
const listUsage = (page, id) => page.locator(`article[data-asset-id="${id}"] .asset-list-cell--releases`);
const ASSETS_ROUTE = /\/projects\/\d+\/assets(\?|$)/;

async function createFromSelection(page, title) {
  const dialog = page.locator('#release-create-dialog');
  await trigger(page).click();
  await dialog.getByLabel('Title').fill(title);
  await dialog.locator('[data-dialog-submit]').click();
  await expect(page.locator('[data-dialog-feedback]')).toContainText(`Release “${title}” created`);
  await expect(dialog).toBeHidden();
}

async function chooseRelease(page, releaseId) {
  await page.locator('#releaseId-action summary').click();
  await page.locator(`#releaseId-action input[type="radio"][value="${releaseId}"]`).check({ force: true });
  await expect(releaseSelect(page)).toHaveValue(String(releaseId));
}

test('a first release becomes available in place, usable through the existing Add to release', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await withAssetsApp(async ({ db, ids, assetsUrl }) => {
    await openPage(page, assetsUrl);
    const log = track(page);
    const url = page.url();
    expect(await releaseOptionValues(page)).toEqual(['']);

    await page.evaluate(({ first, last }) => {
      const row = (id) => document.querySelector(`input[name="selectedAssetIds"][value="${id}"]`).closest('[data-auto-rename-asset]');
      const moved = row(last);
      moved.parentElement.insertBefore(moved, row(first));
    }, { first: ids['a.png'], last: ids['b.png'] });
    await select(page, ids['b.png'], ids['a.png']);
    const order = await page.evaluate(() => {
      window.__keptRegion = document.querySelector('[data-project-assets-live-region]');
      window.__keptForm = document.getElementById('bulk-select-form');
      window.__keptCard = document.querySelector('[data-auto-rename-asset]');
      return Array.from(document.querySelectorAll('input[name="selectedAssetIds"][form="bulk-select-form"]')).map((input) => input.value);
    });
    await expect(cardRelease(page, ids['a.png'])).toContainText('Not used by a release');

    await createFromSelection(page, 'First release');
    const release = db.prepare('SELECT id FROM releases WHERE title = ?').get('First release');
    expect(releaseAssetIds(db, release.id)).toEqual([ids['b.png'], ids['a.png']]);

    await expect(releaseSelect(page)).toBeEnabled();
    expect(await releaseOptionValues(page)).toEqual(['', String(release.id)]);
    expect(await panelValues(page)).toEqual(['', String(release.id)]);
    await expect(releaseSelect(page)).toHaveValue('');
    await expect(cardRelease(page, ids['a.png'])).toContainText('Used in 1 release');
    await expect(cardRelease(page, ids['b.png'])).toContainText('Used in 1 release');
    await expect(cardRelease(page, ids['c.png'])).toContainText('Not used by a release');

    // Nothing else on the page moved: same document, region, form, cards and
    // selection, in the same order, and the confirmation still links out.
    expect(await page.evaluate(() => ({
      region: window.__keptRegion === document.querySelector('[data-project-assets-live-region]'),
      form: window.__keptForm === document.getElementById('bulk-select-form'),
      card: window.__keptCard.isConnected,
      order: Array.from(document.querySelectorAll('input[name="selectedAssetIds"][form="bulk-select-form"]')).map((input) => input.value),
    }))).toEqual({ region: true, form: true, card: true, order });
    expect(await selectedOnPage(page)).toEqual([ids['b.png'], ids['a.png']]);
    await expect(page.locator('[data-selected-count]')).toContainText('2 of 4 selected');
    await expect(page.locator('[data-release-create-view]')).toHaveAttribute('href', `/releases/${release.id}`);
    await expect(page.locator('[data-release-create-manage-assets]')).toHaveAttribute('href', `/releases/${release.id}/assets`);
    expect(log.creates).toHaveLength(1);
    expect(log.pageGets).toHaveLength(1);
    expect(log.navigations).toEqual([]);
    expect(page.url()).toBe(url);
    expect(await documentKept(page)).toBe(true);

    // The dropdown and its backing select stay in step and drive the submit.
    await expect(addSubmit(page)).toBeDisabled();
    await checkbox(page, ids['a.png']).uncheck({ force: true });
    await checkbox(page, ids['b.png']).uncheck({ force: true });
    await select(page, ids['c.png']);
    await chooseRelease(page, release.id);
    await expect(page.locator('#releaseId-action summary')).toContainText('First release');
    await expect(addSubmit(page)).toBeEnabled();
    await addSubmit(page).click();

    await page.waitForURL(/bulk_added=1/);
    expect(releaseAssetIds(db, release.id)).toEqual([ids['b.png'], ids['a.png'], ids['c.png']]);
    await expect(cardRelease(page, ids['c.png'])).toContainText('Used in 1 release');
    expect(log.creates).toHaveLength(1);
    expect(pageErrors).toEqual([]);
  });
});

test('an existing release and its chosen target survive; sequential creates add one option each', async ({ page }) => {
  await withAssetsApp(async ({ db, project, ids, assetsUrl }) => {
    const existing = db.prepare(`
      INSERT INTO releases (project_id, title, description, notes,
                            planned_date, published_date, patreon_url, archived_at)
      VALUES (?, 'Existing release', '', '', NULL, NULL, NULL, NULL)
      RETURNING id
    `).get(project.id);
    await openPage(page, `${assetsUrl}&view=list`);
    expect(await releaseOptionValues(page)).toEqual(['', String(existing.id)]);
    await chooseRelease(page, existing.id);

    await select(page, ids['a.png']);
    await createFromSelection(page, 'Second');
    await expect(releaseSelect(page)).toBeEnabled();
    const second = db.prepare('SELECT id FROM releases WHERE title = ?').get('Second').id;
    expect((await releaseOptionValues(page)).sort()).toEqual(['', String(existing.id), String(second)].sort());
    await expect(releaseSelect(page)).toHaveValue(String(existing.id));
    await expect(page.locator('#releaseId-action summary')).toContainText('Existing release');
    await expect(listUsage(page, ids['a.png']).locator('.asset-indicator--used')).toHaveCount(1);
    await expect(listUsage(page, ids['b.png']).locator('.asset-indicator--unused')).toHaveCount(1);

    await createFromSelection(page, 'Third');
    await expect(releaseSelect(page)).toBeEnabled();
    const third = db.prepare('SELECT id FROM releases WHERE title = ?').get('Third').id;
    expect((await releaseOptionValues(page)).sort()).toEqual(['', String(existing.id), String(second), String(third)].sort());
    const values = await panelValues(page);
    expect(new Set(values).size).toBe(values.length);
    await expect(listUsage(page, ids['a.png']).locator('.asset-list-card-release-count')).toHaveText('2');
    await expect(page.locator(`article[data-asset-id="${ids['a.png']}"] [data-asset-release-section]`)).toContainText('Third');

    // The server decides eligibility: a release published meanwhile drops out,
    // along with the choice of it.
    db.prepare("UPDATE releases SET published_date = '2026-09-21' WHERE id = ?").run(existing.id);
    await createFromSelection(page, 'Fourth');
    await expect(releaseSelect(page)).toBeEnabled();
    expect(await releaseOptionValues(page)).not.toContain(String(existing.id));
    expect(await panelValues(page)).not.toContain(String(existing.id));
    await expect(releaseSelect(page)).toHaveValue('');
    await expect(page.locator('#releaseId-action summary')).toContainText('Select a release');
    await expect(addSubmit(page)).toBeDisabled();

    // New Release still opens and dismisses from the current selection.
    await trigger(page).click();
    await expect(page.locator('#release-create-dialog').getByLabel('Title')).toHaveValue('Selection Project');
    await page.keyboard.press('Escape');
    await expect(trigger(page)).toBeFocused();
  });
});

test('a filtered subset keeps its order; "Not used by a release" still learns the new membership', async ({ page }) => {
  await withAssetsApp(async ({ db, ids, assetsUrl }) => {
    await openPage(page, `${assetsUrl}&usage=unused&order=desc`);
    const log = track(page);
    const url = page.url();
    const order = () => page.locator('input[name="selectedAssetIds"][form="bulk-select-form"]')
      .evaluateAll((inputs) => inputs.map((input) => input.value));
    const before = await order();
    await select(page, ids['c.png'], ids['a.png']);
    await createFromSelection(page, 'Filtered');
    await expect(releaseSelect(page)).toBeEnabled();

    const release = db.prepare('SELECT id FROM releases WHERE title = ?').get('Filtered');
    await expect(cardRelease(page, ids['a.png'])).toContainText('Used in 1 release');
    await expect(cardRelease(page, ids['b.png'])).toContainText('Not used by a release');
    expect(await releaseOptionValues(page)).toEqual(['', String(release.id)]);
    expect(await order()).toEqual(before);
    expect(await selectedOnPage(page)).toEqual([ids['c.png'], ids['a.png']]);
    expect(new URL(log.pageGets[0]).searchParams.has('usage')).toBe(false);
    expect(page.url()).toBe(url);
    expect(log.navigations).toEqual([]);
  });
});

test('a failed refresh keeps the confirmation, withholds Add to release, and recovers by GET alone', async ({ page }) => {
  await withAssetsApp(async ({ db, ids, assetsUrl }) => {
    await openPage(page, assetsUrl);
    const log = track(page);
    const feedback = page.locator('[data-dialog-feedback]');
    await select(page, ids['a.png'], ids['b.png']);

    await page.route(ASSETS_ROUTE, (route) => route.fulfill({ status: 500, body: 'no' }));
    await createFromSelection(page, 'Recover me');
    const release = db.prepare('SELECT id FROM releases WHERE title = ?').get('Recover me');

    const retry = feedback.locator('[data-release-create-refresh-retry]');
    await expect(retry).toHaveText('Retry refresh');
    await expect(feedback).toContainText('Release “Recover me” created with 2 assets.');
    await expect(feedback).toContainText('could not refresh');
    await expect(feedback.locator('[data-release-create-view]')).toHaveAttribute('href', `/releases/${release.id}`);
    await expect(feedback.locator('[data-release-create-manage-assets]')).toBeVisible();
    await expect(feedback.locator('[data-release-create-dismiss]')).toBeHidden();
    await expect(releaseSelect(page)).toBeDisabled();
    await expect(addSubmit(page)).toBeDisabled();
    expect(await selectedOnPage(page)).toEqual([ids['a.png'], ids['b.png']]);

    // A page that is not this one's render (a sign-in, say) is not adopted.
    await page.unroute(ASSETS_ROUTE);
    await page.route(ASSETS_ROUTE, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Sign in</p>' }));
    await retry.click();
    await expect(retry).toBeFocused();
    await expect(releaseSelect(page)).toBeDisabled();

    await page.unroute(ASSETS_ROUTE);
    await retry.click();
    await expect(releaseSelect(page)).toBeEnabled();
    await expect(retry).toHaveCount(0);
    await expect(feedback).not.toContainText('could not refresh');
    await expect(feedback).toContainText('Release “Recover me” created');
    await expect(feedback.locator('[data-release-create-dismiss]')).toBeVisible();
    await expect(trigger(page)).toBeFocused();
    expect(await releaseOptionValues(page)).toEqual(['', String(release.id)]);
    await expect(cardRelease(page, ids['a.png'])).toContainText('Used in 1 release');
    expect(await selectedOnPage(page)).toEqual([ids['a.png'], ids['b.png']]);
    expect(log.creates).toHaveLength(1);
    expect(releaseCount(db)).toBe(1);
    expect(log.navigations).toEqual([]);
    expect(await documentKept(page)).toBe(true);

    // Add to release works after recovery.
    await chooseRelease(page, release.id);
    await select(page, ids['c.png']);
    await addSubmit(page).click();
    await page.waitForURL(/bulk_added=1/);
    expect(releaseAssetIds(db, release.id)).toEqual([ids['a.png'], ids['b.png'], ids['c.png']]);
  });
});

test('a load in flight at the create cannot leave older release information; a later load settles a failure', async ({ page }) => {
  await withAssetsApp(async ({ db, ids, assetsUrl }) => {
    await openPage(page, assetsUrl);
    const feedback = page.locator('[data-dialog-feedback]');
    const dialog = page.locator('#release-create-dialog');
    await select(page, ids['a.png']);
    await trigger(page).click();
    await dialog.getByLabel('Title').fill('Raced');

    // The view switch is rendered before the create commits but lands after it.
    let releaseStale;
    const staleHeld = new Promise((resolve) => { releaseStale = resolve; });
    let fetched = false;
    let held = false;
    await page.route(/view=list/, async (route) => {
      if (held) return route.continue();
      held = true;
      const response = await route.fetch();
      const body = await response.text();
      fetched = true;
      await staleHeld;
      return route.fulfill({ response, body });
    });
    await page.evaluate(() => document.querySelector('nav.view-switcher a[href*="view=list"]').click());
    await expect.poll(() => fetched).toBe(true);
    await dialog.locator('[data-dialog-submit]').click();
    await expect(feedback).toContainText('Release “Raced” created');
    const release = db.prepare('SELECT id FROM releases WHERE title = ?').get('Raced');
    await expect(releaseSelect(page)).toBeEnabled();
    releaseStale();

    // The stale region lands without the release, then is read again.
    await expect(page.locator(`article.asset-list-card[data-asset-id="${ids['a.png']}"]`)).toBeVisible();
    await expect.poll(() => releaseOptionValues(page)).toEqual(['', String(release.id)]);
    await expect(listUsage(page, ids['a.png']).locator('.asset-indicator--used')).toHaveCount(1);
    await expect(releaseSelect(page)).toBeEnabled();
    expect(page.url()).toContain('view=list');
    await page.unroute(/view=list/);

    // With a refresh failed, an ordinary view load is itself the fresh render.
    await select(page, ids['b.png']);
    await page.route(ASSETS_ROUTE, (route) => route.fulfill({ status: 500, body: 'no' }));
    await createFromSelection(page, 'Then failed');
    await expect(feedback.locator('[data-release-create-refresh-retry]')).toBeVisible();
    await page.unroute(ASSETS_ROUTE);
    await page.locator('nav.view-switcher a[aria-label="Grid view"]').click();
    await expect(feedback.locator('[data-release-create-refresh-retry]')).toHaveCount(0);
    await expect(feedback).not.toContainText('could not refresh');
    await expect(feedback).toContainText('Release “Then failed” created');
    await expect(releaseSelect(page)).toBeEnabled();
    expect(await releaseOptionValues(page)).toHaveLength(3);
    expect(releaseCount(db)).toBe(2);
  });
});

// --- The default title follows an in-place project rename ---

const EDIT_TRIGGER = '[data-project-assets-project-title]';

async function renameProject(page, title) {
  const editDialog = page.locator('#project-edit-dialog');
  await page.locator(EDIT_TRIGGER).click();
  await expect(editDialog.locator('#edit-project-title')).toBeEnabled();
  await expect(editDialog.locator('[data-dialog-submit]')).toBeEnabled();
  await editDialog.locator('#edit-project-title').fill(title);
  await editDialog.locator('[data-dialog-submit]').click();
  await expect(editDialog).toBeHidden();
  await expect(page.locator('[data-project-assets-title]')).toHaveText(title);
}

const projectSummary = (page) => page.locator('#release-create-project summary');
const dispatchSaved = (page, detail) => page.evaluate((eventDetail) => {
  document.dispatchEvent(new CustomEvent('project-edit-saved', { detail: eventDetail }));
}, detail);

test('a renamed project is the default in every invocation and in the created release', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await withAssetsApp(async ({ db, project, ids, assetsUrl }) => {
    await openPage(page, `${assetsUrl}&view=list&order=desc`);
    const log = track(page);
    const url = page.url();
    const dialog = page.locator('#release-create-dialog');
    const form = dialog.locator('#release-create-form');
    const title = form.getByLabel('Title');
    await expect(page.locator('[data-project-assets-title]')).toHaveText('Selection Project');

    await page.evaluate(({ first, last }) => {
      const row = (id) => document.querySelector(`input[name="selectedAssetIds"][value="${id}"]`).closest('[data-auto-rename-asset]');
      const moved = row(last);
      moved.parentElement.insertBefore(moved, row(first));
      window.__keptRegion = document.querySelector('[data-project-assets-live-region]');
    }, { first: ids['b.png'], last: ids['a.png'] });
    await select(page, ids['a.png'], ids['b.png']);
    const selected = await selectedOnPage(page);
    const order = await page.locator('input[name="selectedAssetIds"][form="bulk-select-form"]')
      .evaluateAll((inputs) => inputs.map((input) => input.value));

    await renameProject(page, 'Renamed Project');

    await trigger(page).click();
    await expect(title).toHaveValue('Renamed Project');
    await expect(projectSummary(page)).toContainText('Renamed Project');
    await expect(projectSummary(page)).not.toContainText('Selection Project');
    await expect(form.locator('input[name="projectId"]:checked')).toHaveValue(String(project.id));
    expect(await hiddenIds(form)).toEqual(selected);

    // Every dismissal resets to the current default, not the page's rendered one.
    await dialog.locator('[data-dialog-close]').first().click();
    await expect(dialog).toBeHidden();
    await expect(trigger(page)).toBeFocused();
    await trigger(page).click();
    await expect(title).toHaveValue('Renamed Project');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger(page)).toBeFocused();
    await trigger(page).click();
    await expect(title).toHaveValue('Renamed Project');
    await page.mouse.click(4, 4);
    await expect(dialog).toBeHidden();
    await trigger(page).click();
    await expect(title).toHaveValue('Renamed Project');

    // It agrees with a fresh server render of the same page.
    const fresh = await page.evaluate(async () => {
      const html = await (await fetch(window.location.href, { headers: { Accept: 'text/html' } })).text();
      const parsed = new DOMParser().parseFromString(html, 'text/html');
      const form = parsed.getElementById('release-create-form');
      return {
        title: form.querySelector('input[name="title"]').getAttribute('value'),
        summary: form.querySelector('#release-create-project summary').textContent.trim().replace(/\s+/g, ' '),
      };
    });
    expect(fresh.title).toBe('Renamed Project');
    await expect(title).toHaveValue(fresh.title);
    expect((await projectSummary(page).textContent()).trim().replace(/\s+/g, ' ')).toBe(fresh.summary);

    await dialog.locator('[data-dialog-submit]').dblclick();
    await expect(page.locator('[data-dialog-feedback]')).toContainText('Release “Renamed Project” created with 2 assets.');
    await expect(dialog).toBeHidden();
    await expect(trigger(page)).toBeFocused();

    const release = db.prepare('SELECT * FROM releases').get();
    expect(release).toMatchObject({ title: 'Renamed Project', project_id: project.id });
    expect(releaseAssetIds(db, release.id)).toEqual(selected);
    expect(releaseCount(db)).toBe(1);
    expect(log.creates).toHaveLength(1);
    expect(log.navigations).toEqual([]);
    expect(page.url()).toBe(url);
    expect(await documentKept(page)).toBe(true);

    // C3's GET-only synchronization still adopts the new release in place.
    await expect(releaseSelect(page)).toBeEnabled();
    expect(await releaseOptionValues(page)).toEqual(['', String(release.id)]);
    expect(await selectedOnPage(page)).toEqual(selected);
    expect(await page.locator('input[name="selectedAssetIds"][form="bulk-select-form"]')
      .evaluateAll((inputs) => inputs.map((input) => input.value))).toEqual(order);
    expect(await page.evaluate(() => window.__keptRegion === document.querySelector('[data-project-assets-live-region]'))).toBe(true);

    // The server's fresh defaults after the create keep the renamed title.
    await trigger(page).click();
    await expect(title).toHaveValue('Renamed Project');
    expect(pageErrors).toEqual([]);
  });
});

test('a second rename wins, and a refused or failed rename changes nothing', async ({ page }) => {
  await withAssetsApp(async ({ ids, assetsUrl }) => {
    await openPage(page, assetsUrl);
    const dialog = page.locator('#release-create-dialog');
    const title = dialog.getByLabel('Title');
    const editDialog = page.locator('#project-edit-dialog');
    await select(page, ids['a.png']);

    await renameProject(page, 'First Rename');
    await trigger(page).click();
    await expect(title).toHaveValue('First Rename');
    await expect(projectSummary(page)).toHaveAttribute('title', 'First Rename');
    await expect(projectSummary(page)).toHaveAttribute('aria-label', /: First Rename$/);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    await renameProject(page, 'Second Rename');
    await trigger(page).click();
    await expect(title).toHaveValue('Second Rename');
    await expect(projectSummary(page)).toContainText('Second Rename');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // A validation refusal.
    await page.locator(EDIT_TRIGGER).click();
    await expect(editDialog.locator('[data-dialog-submit]')).toBeEnabled();
    await editDialog.locator('#edit-project-title').fill('');
    await editDialog.locator('[data-dialog-submit]').click();
    await expect(editDialog.locator('#edit-project-title')).toHaveAttribute('aria-invalid', 'true');
    // A server failure with the rename in the draft.
    await editDialog.locator('#edit-project-title').fill('Never Saved');
    await page.route(/\/projects\/\d+$/, (route) => (route.request().method() === 'POST'
      ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ status: 'error', message: 'No.', errors: {} }) })
      : route.continue()));
    await editDialog.locator('[data-dialog-submit]').click();
    await expect(editDialog.locator('[data-dialog-error]')).toBeVisible();
    await page.unroute(/\/projects\/\d+$/);
    await editDialog.locator('[data-dialog-close]').first().click();
    await expect(editDialog).toBeHidden();

    await trigger(page).click();
    await expect(title).toHaveValue('Second Rename');
    await expect(projectSummary(page)).toContainText('Second Rename');
  });
});

test('a save of another project, or without a title, leaves the default alone', async ({ page }) => {
  await withAssetsApp(async ({ project, ids, assetsUrl }) => {
    await openPage(page, assetsUrl);
    const title = page.locator('#release-create-dialog').getByLabel('Title');
    await select(page, ids['a.png']);

    await dispatchSaved(page, { projectId: String(project.id + 1), project: { id: project.id + 1, title: 'Other Project' } });
    await dispatchSaved(page, { projectId: String(project.id), project: null });
    await dispatchSaved(page, { projectId: String(project.id), project: { id: project.id, title: '' } });
    await trigger(page).click();
    await expect(title).toHaveValue('Selection Project');
    await expect(projectSummary(page)).toContainText('Selection Project');
  });
});

test('updated defaults never overwrite an open draft, a refused draft or a pending create', async ({ page }) => {
  await withAssetsApp(async ({ db, project, ids, assetsUrl }) => {
    await openPage(page, assetsUrl);
    const log = track(page);
    const dialog = page.locator('#release-create-dialog');
    const form = dialog.locator('#release-create-form');
    const title = form.getByLabel('Title');
    const saved = (name) => ({ projectId: String(project.id), project: { id: project.id, title: name } });
    await select(page, ids['a.png']);

    // An open draft, its other metadata included.
    await trigger(page).click();
    await title.fill('Custom draft');
    await form.getByLabel('Notes').fill('Draft notes');
    await dispatchSaved(page, saved('While Drafting'));
    await expect(title).toHaveValue('Custom draft');
    await expect(form.getByLabel('Notes')).toHaveValue('Draft notes');

    // A refused create keeps the custom title and everything else.
    await page.route('**/releases', (route) => route.fulfill({
      status: 422,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'error', message: 'Refused.', errors: { patreonUrl: 'Bad link.' } }),
    }));
    await dialog.locator('[data-dialog-submit]').click();
    await expect(dialog.locator('[data-dialog-error]')).toBeVisible();
    await dispatchSaved(page, saved('After Refusal'));
    await expect(title).toHaveValue('Custom draft');
    await expect(form.getByLabel('Notes')).toHaveValue('Draft notes');
    await page.unroute('**/releases');

    // A pending create's title is not touched, and is what gets saved.
    let finish;
    const held = new Promise((resolve) => { finish = resolve; });
    await page.route('**/releases', async (route) => {
      await held;
      await route.continue();
    });
    await dialog.locator('[data-dialog-submit]').click();
    await expect(dialog.locator('[data-dialog-status]')).toContainText('Creating release');
    await dispatchSaved(page, saved('During Create'));
    await expect(title).toHaveValue('Custom draft');
    finish();
    await expect(page.locator('[data-dialog-feedback]')).toContainText('Release “Custom draft” created');
    await page.unroute('**/releases');
    expect(db.prepare('SELECT title, notes FROM releases').get()).toEqual({ title: 'Custom draft', notes: 'Draft notes' });
    expect(log.creates).toHaveLength(2);
    await expect(dialog).toBeHidden();
    await expect(releaseSelect(page)).toBeEnabled();

    // The next clean invocation uses the default, with no draft or errors left.
    await trigger(page).click();
    await expect(title).not.toHaveValue('Custom draft');
    await expect(form.getByLabel('Notes')).toHaveValue('');
    await expect(dialog.locator('[data-dialog-error]')).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
});

test('a dismissed draft gives way to the renamed default and clears its refusal', async ({ page }) => {
  await withAssetsApp(async ({ ids, assetsUrl }) => {
    await openPage(page, assetsUrl);
    const dialog = page.locator('#release-create-dialog');
    const form = dialog.locator('#release-create-form');
    await select(page, ids['a.png']);
    await renameProject(page, 'Current Project');

    await trigger(page).click();
    await form.getByLabel('Title').fill('');
    await form.getByLabel('Notes').fill('Dropped notes');
    await dialog.locator('[data-dialog-submit]').click();
    await expect(form.locator('[data-dialog-field="title"] .field-error-message')).toBeVisible();
    await expect(form.getByLabel('Notes')).toHaveValue('Dropped notes');
    await expect(form.getByLabel('Title')).toHaveValue('');

    await dialog.locator('[data-dialog-close]').first().click();
    await expect(dialog).toBeHidden();
    await trigger(page).click();
    await expect(form.getByLabel('Title')).toHaveValue('Current Project');
    await expect(form.getByLabel('Notes')).toHaveValue('');
    await expect(form.locator('[aria-invalid="true"]')).toHaveCount(0);
    await expect(dialog.locator('[data-dialog-error]')).toBeHidden();
    expect(await selectedOnPage(page)).toEqual([ids['a.png']]);
    expect(await hiddenIds(form)).toEqual([ids['a.png']]);
  });
});

test('an older refresh cannot overwrite a newer one', async ({ page }) => {
  await withAssetsApp(async ({ db, ids, assetsUrl }) => {
    await openPage(page, assetsUrl);
    await select(page, ids['a.png']);

    let releaseFirst;
    const firstHeld = new Promise((resolve) => { releaseFirst = resolve; });
    let held = false;
    await page.route(ASSETS_ROUTE, async (route) => {
      if (route.request().method() !== 'GET' || held) return route.continue();
      held = true;
      const response = await route.fetch();
      const body = await response.text();
      await firstHeld;
      return route.fulfill({ response, body });
    });
    await createFromSelection(page, 'One');
    await expect(releaseSelect(page)).toBeDisabled();
    await createFromSelection(page, 'Two');
    await expect(releaseSelect(page)).toBeEnabled();
    expect(await releaseOptionValues(page)).toHaveLength(3);

    releaseFirst();
    await page.waitForTimeout(250);
    expect(await releaseOptionValues(page)).toHaveLength(3);
    expect(releaseCount(db)).toBe(2);
  });
});
