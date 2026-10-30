import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { openDatabase, closeDatabase, runMigrations } from '../../src/db.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';

// New Release creates in place from Releases: the host page is never
// navigated or replaced, its list refreshes with a GET, and the create POST
// is sent once per submission, even when that refresh fails.

async function withReleasesApp(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-releases-new-release-'));
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
    const first = app.locals.projectService.create({ title: 'First Releases Project' });
    const second = app.locals.projectService.create({ title: 'Second Releases Project' });
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    await run({ origin: `http://127.0.0.1:${server.address().port}`, app, db, first, second });
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function insertRelease(db, projectId, title) {
  db.prepare(`
    INSERT INTO releases (project_id, title, description, notes, planned_date, planned_time, patreon_url, published_date, archived_at)
    VALUES (?, ?, '', '', NULL, NULL, NULL, NULL, NULL)
  `).run(projectId, title);
}

const releasesTitled = (db, title) => db.prepare('SELECT * FROM releases WHERE title = ?').all(title);

// A document replaced by navigation loses this marker.
const markDocument = (page) => page.evaluate(() => { window.__releaseCreateFlowDocument = true; });
const documentKept = (page) => page.evaluate(() => window.__releaseCreateFlowDocument === true);

function track(page) {
  const navigations = [];
  const posts = [];
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/releases') posts.push(request.url());
  });
  return { navigations, posts };
}

async function waitForEnhancement(page) {
  await page.waitForFunction(() => {
    const dialog = document.getElementById('release-create-dialog');
    return dialog?.__creatorCrateAppDialogState?.releaseCreateBound === true
      && Boolean(document.__creatorCrateReleasesLiveFiltering);
  });
}

async function chooseInDropdown(form, dropdownId, selector) {
  const dropdown = form.locator(`#${dropdownId}`);
  if (!await dropdown.evaluate((element) => element.open)) await dropdown.locator('summary').click();
  await form.locator(selector).click({ force: true });
}

// The default signature fills Description once per page load; a reopened
// dialog starts empty, exactly as after a dismissal.
async function expectFreshDefaults(dialog, { signed }) {
  const form = dialog.locator('#release-create-form');
  await expect(form.getByLabel('Title')).toHaveValue('');
  await expect(form.getByLabel('Notes')).toHaveValue('');
  await expect(form.locator('textarea[name="description"]')).toHaveValue(signed ? 'Signed by default' : '');
  await expect(form.locator('[data-release-signature-field] select')).toHaveValue(signed ? /.+/ : '');
  await expect(form.locator('input[name="projectId"]:checked')).toHaveCount(0);
  await expect(form.locator('#release-create-project summary')).toContainText('Select a project');
  await expect(form.locator('input[name="selectedPlatforms"]:checked')).toHaveCount(0);
  await expect(form.getByLabel('No set release date')).not.toBeChecked();
  await expect(form.locator('input[name="plannedDate"]')).toBeEnabled();
  await expect(form.locator('input[name="plannedDate"]')).not.toHaveValue('');
  await expect(form.locator('input[name="patreonUrl"]')).toHaveValue('');
  await expect(form.locator('[aria-invalid="true"]')).toHaveCount(0);
  await expect(dialog.locator('[data-dialog-error]')).toBeHidden();
}

test('the Releases toolbar creates a scheduled release in place and keeps the filtered view', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 600 });

  await withReleasesApp(async ({ origin, app, db, first, second }) => {
    for (let index = 1; index <= 12; index += 1) insertRelease(db, first.id, `Existing ${String(index).padStart(2, '0')}`);
    insertRelease(db, second.id, 'Other Project Release');
    const listUrl = `${origin}/releases?project=${first.id}&sort=title&order=asc`;
    await page.goto(listUrl);
    await waitForEnhancement(page);
    const { navigations, posts } = track(page);
    await markDocument(page);
    const region = page.locator('[data-releases-live-region]');
    await expect(region).not.toContainText('Other Project Release');

    const trigger = page.locator('.page-heading [data-dialog-open="release-create-dialog"]');
    const dialog = page.locator('#release-create-dialog');
    const form = page.locator('#release-create-form');
    await trigger.click();
    await expect(dialog).toBeVisible();
    expect(navigations).toEqual([]);
    await expectFreshDefaults(dialog, { signed: true });
    await page.evaluate(() => window.scrollTo(0, 200));
    const scrollY = await page.evaluate(() => window.scrollY);

    await chooseInDropdown(form, 'release-create-project', `input[name="projectId"][value="${first.id}"]`);
    await form.getByLabel('Title').fill('Zulu Toolbar Release');
    await form.getByLabel('Notes').fill('Toolbar notes');
    await form.getByLabel('Scheduled date', { exact: true }).fill('2027-06-07');
    await form.getByLabel('Scheduled time', { exact: true }).fill('14:45');
    await chooseInDropdown(form, 'release-platforms', 'input[name="selectedPlatforms"][value="x"]');
    await form.getByLabel('Release link').fill('https://example.com/zulu');
    await dialog.getByRole('button', { name: 'Create release' }).click();

    await expect(dialog).toBeHidden();
    const feedback = page.locator('[data-dialog-feedback]');
    await expect(feedback).toContainText('Release “Zulu Toolbar Release” created.');
    const created = releasesTitled(db, 'Zulu Toolbar Release');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      project_id: first.id, notes: 'Toolbar notes', description: 'Signed by default',
      planned_date: '2027-06-07', planned_time: '14:45', patreon_url: 'https://example.com/zulu',
    });
    expect(app.locals.socialPrepRepository.listPlatformsByReleaseId(created[0].id)
      .filter((row) => row.is_selected === 1).map((row) => row.platform)).toEqual(['x']);
    await expect(feedback.getByRole('link', { name: 'View Release' })).toHaveAttribute('href', `/releases/${created[0].id}`);
    await expect(region).toContainText('Zulu Toolbar Release');
    await expect(region).not.toHaveAttribute('aria-busy', 'true');
    await expect(region).not.toContainText('Other Project Release');
    await expect(region.locator('.results-meta')).toHaveText('13 releases found');
    await expect(feedback.locator('[data-release-create-refresh-note]')).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(posts).toHaveLength(1);
    expect(page.url()).toBe(listUrl);
    expect(navigations).toEqual([]);
    expect(await documentKept(page)).toBe(true);
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThanOrEqual(Math.min(scrollY, 1));

    // Reopening starts fresh rather than from the created release.
    await trigger.click();
    await expectFreshDefaults(dialog, { signed: false });
    await dialog.getByRole('button', { name: 'Close New Release', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });
  expect(pageErrors).toEqual([]);
});

test('the Releases empty state creates an unscheduled release and the list replaces it', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await withReleasesApp(async ({ origin, db, second }) => {
    await page.goto(`${origin}/releases`);
    await waitForEnhancement(page);
    const { navigations, posts } = track(page);
    await markDocument(page);
    const region = page.locator('[data-releases-live-region]');
    const emptyAction = region.locator('[data-dialog-open="release-create-dialog"]');
    await expect(region).toContainText('No releases yet');
    const dialog = page.locator('#release-create-dialog');
    const form = page.locator('#release-create-form');

    await emptyAction.click();
    await expect(dialog).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/releases');
    await chooseInDropdown(form, 'release-create-project', `input[name="projectId"][value="${second.id}"]`);
    await form.getByLabel('Title').fill('Empty State Release');
    await form.getByLabel('No set release date').check();
    await dialog.getByRole('button', { name: 'Create release' }).click();

    await expect(dialog).toBeHidden();
    await expect(region).toContainText('Empty State Release');
    await expect(region).not.toContainText('No releases yet');
    const created = releasesTitled(db, 'Empty State Release');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ project_id: second.id, planned_date: null, planned_time: null });
    // The empty-state trigger left with the refreshed region; the heading's
    // New Release takes focus instead of the page body.
    await expect(page.locator('.page-heading [data-dialog-open="release-create-dialog"]')).toBeFocused();
    expect(posts).toHaveLength(1);
    expect(navigations).toEqual([]);
    expect(await documentKept(page)).toBe(true);
  });
  expect(pageErrors).toEqual([]);
});

test('validation and network failures keep the draft and controls; dismissal stays local', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await withReleasesApp(async ({ origin, db, first }) => {
    insertRelease(db, first.id, 'Already Here');
    await page.goto(`${origin}/releases?sort=title`);
    await waitForEnhancement(page);
    const { navigations, posts } = track(page);
    await markDocument(page);
    const trigger = page.locator('.page-heading [data-dialog-open="release-create-dialog"]');
    const dialog = page.locator('#release-create-dialog');
    const form = page.locator('#release-create-form');
    const submit = dialog.getByRole('button', { name: 'Create release' });

    // Missing project and title, an invalid link: field errors in place.
    await trigger.click();
    await form.getByLabel('Notes').fill('Keep my notes');
    await form.getByLabel('Scheduled date', { exact: true }).fill('2027-08-09');
    await form.getByLabel('Scheduled time', { exact: true }).fill('07:05');
    await chooseInDropdown(form, 'release-platforms', 'input[name="selectedPlatforms"][value="bluesky"]');
    await form.getByLabel('Release link').fill('not-a-url');
    await submit.click();

    await expect(form.locator('#projectId-error')).toHaveText('Project is required.');
    await expect(form.locator('#release-create-project summary')).toHaveAttribute('aria-invalid', 'true');
    await expect(form.locator('#release-create-project summary')).toBeFocused();
    await expect(dialog.locator('[data-dialog-error]')).toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(form.getByLabel('Notes')).toHaveValue('Keep my notes');
    await expect(form.locator('input[name="plannedDate"]')).toHaveValue('2027-08-09');
    await expect(form.locator('input[name="plannedTime"]')).toHaveValue('07:05');
    await expect(form.locator('input[name="selectedPlatforms"][value="bluesky"]')).toBeChecked();
    await expect(form.getByLabel('Release link')).toHaveValue('not-a-url');
    await expect(page.locator('[data-dialog-feedback]')).toBeHidden();
    await expect(submit).toBeEnabled();

    // The project dropdown still works; the next refusal names the next fields.
    await chooseInDropdown(form, 'release-create-project', `input[name="projectId"][value="${first.id}"]`);
    await expect(form.locator('#release-create-project summary')).toContainText('First Releases Project');
    await submit.click();
    await expect(form.locator('#title-error')).toBeVisible();
    await expect(form.locator('#projectId-error')).toHaveCount(0);
    await expect(form.locator('#patreonUrl-error')).toBeVisible();
    await expect(form.locator(`input[name="projectId"][value="${first.id}"]`)).toBeChecked();
    await expect(form.locator('input[name="plannedDate"]')).toHaveValue('2027-08-09');
    expect(db.prepare('SELECT COUNT(*) AS count FROM releases').get().count).toBe(1);

    // An uncertain network outcome is reported, never retried, and leaves
    // the dialog usable.
    await form.getByLabel('Title').fill('Network Release');
    await form.getByLabel('Release link').fill('https://example.com/network');
    await page.route((url) => url.pathname === '/releases', (route) => (
      route.request().method() === 'POST' ? route.abort('failed') : route.continue()
    ), { times: 1 });
    await submit.click();
    await expect(dialog.locator('[data-dialog-status]')).toHaveText('Could not confirm whether the release was created. Check Releases before creating it again.');
    await expect(dialog).toBeVisible();
    await expect(submit).toBeEnabled();
    await expect(form.getByLabel('Title')).toHaveValue('Network Release');
    await expect(page.locator('[data-dialog-feedback]')).toBeHidden();
    await page.waitForTimeout(500);
    expect(posts).toHaveLength(3);

    // Escape, backdrop and Close all dismiss locally and reset the draft.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expect(form.getByLabel('Title')).toHaveValue('');
    await expect(form.locator('[aria-invalid="true"]')).toHaveCount(0);
    await expect(form.locator('.field-error-message')).toHaveCount(0);
    await expect(dialog.locator('[data-dialog-status]')).toHaveText('');
    await form.getByLabel('Title').fill('Backdrop draft');
    await page.mouse.click(4, 4);
    await expect(dialog).toBeHidden();
    await trigger.click();
    await expect(form.getByLabel('Title')).toHaveValue('');
    await dialog.getByRole('button', { name: 'Close New Release', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    expect(releasesTitled(db, 'Network Release')).toHaveLength(0);
    expect(posts).toHaveLength(3);
    expect(new URL(page.url()).pathname).toBe('/releases');
    expect(navigations).toEqual([]);
    expect(await documentKept(page)).toBe(true);
  });
  expect(pageErrors).toEqual([]);
});

test('a failed refresh after a confirmed create retries with GET only', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await withReleasesApp(async ({ origin, db, first }) => {
    insertRelease(db, first.id, 'Before Refresh');
    await page.goto(`${origin}/releases?sort=title&order=asc`);
    await waitForEnhancement(page);
    const { navigations, posts } = track(page);
    const dialog = page.locator('#release-create-dialog');
    const form = page.locator('#release-create-form');
    await page.locator('.page-heading [data-dialog-open="release-create-dialog"]').click();
    await chooseInDropdown(form, 'release-create-project', `input[name="projectId"][value="${first.id}"]`);
    await form.getByLabel('Title').fill('Refresh Failure Release');

    let refreshGets = 0;
    await page.route((url) => url.pathname === '/releases', (route) => {
      const request = route.request();
      if (request.method() !== 'GET' || request.resourceType() === 'document') return route.continue();
      refreshGets += 1;
      return refreshGets === 1
        ? route.fulfill({ status: 500, contentType: 'text/html', body: 'refresh failed' })
        : route.continue();
    });
    await dialog.getByRole('button', { name: 'Create release' }).click();

    await expect(dialog).toBeHidden();
    const feedback = page.locator('[data-dialog-feedback]');
    await expect(feedback).toContainText('Release “Refresh Failure Release” created.');
    await expect(feedback).toContainText('Releases could not refresh.');
    const created = releasesTitled(db, 'Refresh Failure Release');
    expect(created).toHaveLength(1);
    const view = feedback.getByRole('link', { name: 'View Release' });
    await expect(view).toHaveAttribute('href', `/releases/${created[0].id}`);
    await expect(page.locator('[data-releases-live-region]')).not.toContainText('Refresh Failure Release');

    await feedback.getByRole('button', { name: 'Retry refresh' }).click();
    await expect(page.locator('[data-releases-live-region]')).toContainText('Refresh Failure Release');
    await expect(feedback.locator('[data-release-create-refresh-note]')).toHaveCount(0);
    await expect(feedback.getByRole('button', { name: 'Retry refresh' })).toHaveCount(0);
    await expect(view).toBeVisible();
    expect(refreshGets).toBe(2);
    expect(posts).toHaveLength(1);
    expect(releasesTitled(db, 'Refresh Failure Release')).toHaveLength(1);
    expect(navigations).toEqual([]);

    await Promise.all([page.waitForURL(`${origin}/releases/${created[0].id}`), view.click()]);
  });
  expect(pageErrors).toEqual([]);
});

test('the standalone New Release page still submits natively to Release Detail', async ({ page }) => {
  await withReleasesApp(async ({ origin, db, first }) => {
    await page.goto(`${origin}/releases/new?projectId=${first.id}`);
    await page.locator('#release-form').getByLabel('Title').fill('Standalone Release');
    await Promise.all([
      page.waitForURL(/\/releases\/\d+$/),
      page.locator('#release-form').evaluate((form) => form.requestSubmit()),
    ]);
    const created = releasesTitled(db, 'Standalone Release');
    expect(created).toHaveLength(1);
    expect(page.url()).toBe(`${origin}/releases/${created[0].id}`);
  });
});
