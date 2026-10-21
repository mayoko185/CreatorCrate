import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { openDatabase, closeDatabase, runMigrations } from '../../src/db.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { createReleaseRepository } from '../../src/data/release-repository.js';
import { createReleaseService } from '../../src/services/release-service.js';

function isoDaysFromToday(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

async function withDashboard(page, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-dashboard-edit-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    const { socialPrepSettingsService, releaseSignatureSettingsService } = app.locals;
    const releaseService = createReleaseService({ db, socialPrepSettingsService, projectService: app.locals.projectService });
    const project = app.locals.projectService.create({ title: 'Edit host project' });
    const releases = createReleaseRepository(db);
    socialPrepSettingsService.setPlatforms(['x', 'bluesky', 'patreon']);
    const alpha = releases.create({ projectId: project.id, title: 'Alpha release', description: 'Alpha description', notes: 'Alpha notes' });
    releaseService.updateRelease(alpha.id, {
      title: 'Alpha release', description: 'Alpha description', notes: 'Alpha notes',
      plannedDate: isoDaysFromToday(3), plannedTime: '09:30', publishedDate: null,
      patreonUrl: 'https://example.com/alpha', selectedPlatforms: ['x'],
    });
    const beta = releases.create({ projectId: project.id, title: 'Beta release', description: '', notes: '' });
    releaseService.updateRelease(beta.id, {
      title: 'Beta release', description: '', notes: 'Beta notes', plannedDate: null, plannedTime: null,
      publishedDate: null, patreonUrl: null, selectedPlatforms: ['patreon', 'bluesky'],
    });
    // Beta keeps a saved platform that is no longer configured.
    socialPrepSettingsService.setPlatforms(['x', 'bluesky']);
    const signature = releaseSignatureSettingsService.add({ name: 'Thanks', body: 'Thanks for reading' }).entries[0];
    releaseSignatureSettingsService.setDefault(signature.id);
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    await run({ origin: `http://127.0.0.1:${server.address().port}`, alpha, beta, releaseService, releases, project });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function clickEdit(page, releaseId) {
  const card = page.locator(`[data-calendar-info-card]:has([data-release-edit-id="${releaseId}"])`).first();
  const cardId = await card.getAttribute('id');
  const trigger = page.locator(`[data-calendar-info-trigger][aria-controls="${cardId}"]`);
  await trigger.click();
  await card.locator(`[data-release-edit-id="${releaseId}"]`).click();
  return trigger;
}

async function platformState(form) {
  return form.locator('input[name="selectedPlatforms"]').evaluateAll((inputs) => inputs.map((input) => `${input.value}:${input.checked}`));
}

test('Dashboard edits releases in the shared dialog without navigating', async ({ page }) => {
  test.setTimeout(90_000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await withDashboard(page, async ({ origin, alpha, beta, releaseService }) => {
    await page.goto(`${origin}/`);
    const navigations = [];
    page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
    await page.evaluate(() => {
      window.savedEdits = [];
      document.addEventListener('release-edit-saved', (event) => window.savedEdits.push(event.detail));
    });
    const dialog = page.locator('#release-edit-dialog');
    const form = page.locator('#release-edit-form');
    const title = form.locator('[name="title"]');

    // Alpha loads its own values, platform choices and actions.
    const alphaTrigger = await clickEdit(page, alpha.id);
    await expect(dialog).toBeVisible();
    await expect(title).toHaveValue('Alpha release');
    await expect(form.locator('[name="description"]')).toHaveValue('Alpha description');
    await expect(form.locator('[name="plannedTime"]')).toHaveValue('09:30');
    await expect(form.locator('[name="patreonUrl"]')).toHaveValue('https://example.com/alpha');
    expect(await platformState(form)).toEqual(['x:true', 'bluesky:false']);
    await expect(form).toHaveAttribute('action', `/releases/${alpha.id}`);
    await expect(dialog.locator('[data-release-edit-action="archive"] form')).toHaveAttribute('action', `/releases/${alpha.id}/archive`);

    // Save changes uses New Release's outlined submit treatment, without the plus.
    const saveButton = dialog.getByRole('button', { name: 'Save changes', exact: true });
    await expect(saveButton).toHaveCount(1);
    await expect(saveButton.locator('.project-create-submit-icon')).toHaveCount(0);
    expect(await saveButton.evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.backgroundColor, style.backgroundImage, style.borderTopColor, style.color, style.fontSize, style.fontWeight, style.borderTopLeftRadius, `${element.getBoundingClientRect().height}`];
    })).toEqual(['rgb(13, 15, 19)', 'none', 'rgb(58, 67, 83)', 'rgb(232, 236, 241)', '14px', '600', '6px', '36']);

    // Cancel restores the loaded baseline and returns focus to the title.
    await title.fill('Scratch title');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(alphaTrigger).toBeFocused();
    await clickEdit(page, alpha.id);
    await expect(title).toHaveValue('Alpha release');
    await page.keyboard.press('Escape');

    // Beta replaces every Alpha value, including the unconfigured platform.
    await clickEdit(page, beta.id);
    await expect(title).toHaveValue('Beta release');
    await expect(form.locator('[name="description"]')).toHaveValue('');
    await expect(form.locator('[name="notes"]')).toHaveValue('Beta notes');
    await expect(form.locator('[name="plannedDate"]')).toHaveValue('');
    await expect(form.locator('[name="patreonUrl"]')).toHaveValue('');
    expect(await platformState(form)).toEqual(['patreon:true', 'x:false', 'bluesky:true']);
    await expect(form.locator('#release-edit-field-platforms summary')).toContainText('2 platforms selected');
    await expect(form.locator('[data-release-signature-field] select')).toHaveValue('');

    // Validation failure keeps the draft open, with no navigation.
    await title.fill('');
    await form.locator('[name="notes"]').fill('Draft notes');
    await dialog.locator('footer [data-dialog-submit]').click();
    await expect(form.locator('[data-dialog-field="title"] .field-error-message')).toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(form.locator('[name="notes"]')).toHaveValue('Draft notes');
    expect(page.url()).toBe(`${origin}/`);

    // Signature management opens from Edit Release; choosing a signature inserts it.
    await form.locator('button[aria-label="Manage signatures"]').click();
    await expect(page.locator('#release-signatures-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#release-signatures-dialog')).toBeHidden();
    await expect(dialog).toBeVisible();
    await form.locator('#release-edit-field-signature summary').click();
    await form.locator('[data-release-signature-field] input[type="radio"]:not([value=""])').click();
    await expect(form.locator('[name="description"]')).toHaveValue('Thanks for reading');

    // A successful save posts the complete form through the shared binder.
    await title.fill('Beta renamed');
    const postPromise = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith(`/releases/${beta.id}`));
    await dialog.locator('footer [data-dialog-submit]').click();
    const body = new URLSearchParams((await postPromise).postData());
    expect(body.get('selectedPlatformsPresent')).toBe('1');
    expect(body.getAll('selectedPlatforms')).toEqual(['patreon', 'bluesky']);
    for (const name of ['_csrf', 'title', 'description', 'notes', 'plannedDate', 'plannedTime', 'publishedDate', 'patreonUrl']) {
      expect(body.has(name)).toBe(true);
    }
    await expect(dialog).toBeHidden();
    await expect(page.locator('[data-dialog-feedback]')).toContainText('Release updated.');
    await expect.poll(() => page.evaluate(() => window.savedEdits.length)).toBe(1);
    const saved = await page.evaluate(() => window.savedEdits[0]);
    expect(saved.releaseId).toBe(String(beta.id));
    expect(saved.values.title).toBe('Beta renamed');
    const stored = releaseService.findRelease(beta.id);
    expect(stored.title).toBe('Beta renamed');
    expect(stored.notes).toBe('Draft notes');
    expect(stored.description).toBe('Thanks for reading');

    // A late Alpha response never hydrates Beta or reopens a dismissed dialog.
    let releaseAlpha;
    const alphaHeld = new Promise((resolve) => { releaseAlpha = resolve; });
    await page.route(`**/releases/${alpha.id}/edit`, async (route) => { await alphaHeld; await route.continue(); });
    await clickEdit(page, alpha.id);
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-dialog-status]')).toHaveText('Loading release…');
    await expect(dialog.locator('footer [data-dialog-submit]')).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await clickEdit(page, beta.id);
    await expect(title).toHaveValue('Beta renamed');
    releaseAlpha();
    await page.waitForTimeout(500);
    await expect(title).toHaveValue('Beta renamed');
    await expect(form).toHaveAttribute('action', `/releases/${beta.id}`);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await page.unroute(`**/releases/${alpha.id}/edit`);

    // A failed load reports in place.
    await page.route(`**/releases/${alpha.id}/edit`, (route) => route.fulfill({
      status: 409, contentType: 'application/json',
      body: JSON.stringify({ status: 'error', code: 'RELEASE_ARCHIVED', message: 'Archived releases are read-only.' }),
    }));
    await clickEdit(page, alpha.id);
    await expect(dialog.locator('[data-dialog-status]')).toHaveText('Archived releases are read-only.');
    await expect(dialog.locator('.app-dialog-body')).toBeHidden();
    await page.keyboard.press('Escape');
    await page.unroute(`**/releases/${alpha.id}/edit`);

    // New Release is untouched: fresh draft with its default signature.
    await page.locator('[data-dialog-open="release-create-dialog"]').first().click();
    const createForm = page.locator('#release-create-form');
    await expect(createForm.locator('[name="title"]')).toHaveValue('');
    await expect(createForm.locator('[name="description"]')).toHaveValue('Thanks for reading');
    await page.keyboard.press('Escape');

    expect(await page.evaluate(() => {
      const ids = [...document.querySelectorAll('[id]')].map((element) => element.id);
      return ids.filter((id, index) => ids.indexOf(id) !== index);
    })).toEqual([]);
    expect(navigations).toEqual([]);
    expect(page.url()).toBe(`${origin}/`);
    expect(pageErrors).toEqual([]);
  });
});

test('Dashboard refreshes in place after a saved Edit Release', async ({ page }) => {
  test.setTimeout(90_000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await withDashboard(page, async ({ origin, alpha, beta, releaseService }) => {
    await page.goto(`${origin}/`);
    const navigations = [];
    page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
    const refreshes = [];
    const posts = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (request.method() === 'GET' && url.pathname === '/' && request.resourceType() === 'fetch') refreshes.push(url.href);
      if (request.method() === 'POST' && /^\/releases\/\d+$/.test(url.pathname)) posts.push(url.pathname);
    });
    const dialog = page.locator('#release-edit-dialog');
    const form = page.locator('#release-edit-form');
    const submit = dialog.locator('footer [data-dialog-submit]');
    const banner = page.locator('[data-dashboard-sync]');
    const alphaRow = page.locator(`[data-dashboard-release-row][data-release-id="${alpha.id}"]`);
    const betaUndated = page.locator(`[data-dashboard-needs-date-item][data-release-id="${beta.id}"]`);
    const needsDateCount = page.locator('[data-dashboard-tile="needs-date"] [data-dashboard-tile-count]');
    await expect(betaUndated).toHaveCount(1);
    await expect(needsDateCount).toHaveText('1');

    // The New Release and New Project dialogs sit outside the refreshed
    // region; tag them to prove refreshes never replace them.
    await page.evaluate(() => {
      for (const id of ['release-create-dialog', 'project-create-dialog']) document.getElementById(id).ccKept = true;
    });

    // Cancel and a rejected save never refresh.
    await clickEdit(page, alpha.id);
    await expect(form.locator('[name="title"]')).toHaveValue('Alpha release');
    await form.locator('[name="title"]').fill('Cancelled title');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await clickEdit(page, alpha.id);
    await form.locator('[name="title"]').fill('');
    await submit.click();
    await expect(form.locator('[data-dialog-field="title"] .field-error-message')).toBeVisible();
    await expect(dialog).toBeVisible();
    await page.waitForTimeout(300);
    expect(refreshes).toEqual([]);
    // The rejected save is the only POST so far (server-side validation).
    expect(posts).toEqual([`/releases/${alpha.id}`]);

    // A save refreshes the dashboard once: title, date, time and notes.
    const newDate = isoDaysFromToday(5);
    await form.locator('[name="title"]').fill('Alpha renamed');
    await form.locator('[name="plannedDate"]').fill(newDate);
    await form.locator('[name="plannedTime"]').fill('14:45');
    await form.locator('[name="notes"]').fill('Fresh alpha notes');
    await submit.click();
    await expect(dialog).toBeHidden();
    await expect(alphaRow.locator('[data-calendar-info-trigger]').first()).toHaveText('Alpha renamed');
    await expect(alphaRow.locator('.dashboard-date-block time')).toHaveAttribute('datetime', newDate);
    await expect(alphaRow.locator('.dashboard-date-block-time')).not.toHaveText('9:30 AM');
    await expect(alphaRow.locator('[data-calendar-info-card]').first()).toContainText('Fresh alpha notes');
    await expect(page.locator('[data-dialog-feedback]')).toContainText('Release updated.');
    expect(refreshes).toHaveLength(1);
    expect(posts).toEqual([`/releases/${alpha.id}`, `/releases/${alpha.id}`]);
    await expect(banner).toBeHidden();

    // Refreshed cards still open the shared dialog; scheduling Beta moves it
    // out of Needs a date and updates the count.
    await clickEdit(page, beta.id);
    await expect(form.locator('[name="title"]')).toHaveValue('Beta release');
    await form.locator('[name="plannedDate"]').fill(isoDaysFromToday(4));
    await submit.click();
    await expect(dialog).toBeHidden();
    await expect(betaUndated).toHaveCount(0);
    await expect(page.locator(`[data-dashboard-release-row][data-release-id="${beta.id}"]`)).toHaveCount(1);
    await expect(needsDateCount).toHaveText('0');
    expect(refreshes).toHaveLength(2);

    // A refresh failure after a confirmed save reports a saved release, never
    // repeats the POST, and Retry refresh reconciles.
    const dashboardUrl = (url) => url.pathname === '/';
    await page.route(dashboardUrl, (route) => (
      route.request().resourceType() === 'fetch' ? route.fulfill({ status: 500, body: 'down' }) : route.continue()));
    await clickEdit(page, alpha.id);
    await expect(form.locator('[name="title"]')).toHaveValue('Alpha renamed');
    await form.locator('[name="title"]').fill('Alpha after outage');
    await submit.click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('[data-dialog-feedback]')).toContainText('Release updated.');
    await expect(banner).toBeVisible();
    await expect(banner.locator('[data-dashboard-sync-message]')).toContainText('The release was saved, but the dashboard couldn’t refresh');
    await expect(page.locator('[data-dashboard-announcer]')).toContainText('The release was saved');
    await expect(page.getByText('could not be saved')).toHaveCount(0);
    expect(releaseService.findRelease(alpha.id).title).toBe('Alpha after outage');
    await expect(alphaRow.locator('[data-calendar-info-trigger]').first()).toHaveText('Alpha renamed');
    await page.unroute(dashboardUrl);
    await banner.locator('[data-dashboard-sync-retry]').click();
    await expect(banner.locator('[data-dashboard-sync-message]')).toHaveText('Dashboard refreshed. Scheduling is available again.');
    await expect(alphaRow.locator('[data-calendar-info-trigger]').first()).toHaveText('Alpha after outage');
    expect(posts).toEqual([`/releases/${alpha.id}`, `/releases/${alpha.id}`, `/releases/${beta.id}`, `/releases/${alpha.id}`]);

    // Unrelated dialogs survived every refresh and still open normally.
    expect(await page.evaluate(() => ['release-create-dialog', 'project-create-dialog']
      .map((id) => document.getElementById(id).ccKept === true))).toEqual([true, true]);
    await page.locator('[data-dialog-open="release-create-dialog"]').first().click();
    await expect(page.locator('#release-create-form [name="description"]')).toHaveValue('Thanks for reading');
    await page.keyboard.press('Escape');
    await page.locator('[data-dialog-open="project-create-dialog"]').first().click();
    await expect(page.locator('#project-create-dialog')).toBeVisible();
    await page.keyboard.press('Escape');

    expect(navigations).toEqual([]);
    expect(page.url()).toBe(`${origin}/`);
    expect(pageErrors).toEqual([]);
  });
});

test('Edit Release refreshes the Social Posts of a retained scheduling confirmation', async ({ page }) => {
  test.setTimeout(90_000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await withDashboard(page, async ({ origin, releaseService, releases, project }) => {
    const gamma = releases.create({ projectId: project.id, title: 'Gamma release', description: '', notes: '' });
    releaseService.updateRelease(gamma.id, {
      title: 'Gamma release', description: '', notes: '', plannedDate: null, plannedTime: null,
      publishedDate: null, patreonUrl: null, selectedPlatforms: ['x'],
    });
    await page.goto(`${origin}/`);
    const posts = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (request.method() === 'POST' && /^\/releases\/\d+$/.test(url.pathname)) posts.push(url.pathname);
    });
    const dialog = page.locator('#release-edit-dialog');
    const form = page.locator('#release-edit-form');
    const banner = page.locator('[data-dashboard-sync]');
    const retained = page.locator(`[data-dashboard-needs-date-item][data-release-id="${gamma.id}"]`);
    const retainedSocial = retained.locator('.dashboard-readiness .release-social-prep-summary');
    const row = page.locator(`[data-dashboard-release-row][data-release-id="${gamma.id}"]`);
    const badges = (locator) => locator.locator('.status-badge').evaluateAll(
      (nodes) => nodes.map((node) => node.textContent.split('·')[0].trim()));
    const platformsCell = (locator) => locator.locator('[data-calendar-info-card] dt:text-is("Platforms") + dd').first();

    // Quick-schedule Gamma and keep its confirmation with Undo.
    await retained.locator('[data-dashboard-schedule-pick]').first().click();
    const undo = retained.locator('[data-dashboard-schedule-undo]');
    await expect(undo).toBeVisible();
    await expect(row).toHaveCount(1);
    expect(await badges(retainedSocial)).toEqual(['X']);

    // Edit from the retained confirmation's own card: add Bluesky.
    const card = retained.locator(`.dashboard-item-title [data-calendar-info-card]`);
    await retained.locator(`.dashboard-item-title [data-calendar-info-trigger]`).click();
    await card.locator(`[data-release-edit-id="${gamma.id}"]`).click();
    await expect(dialog).toBeVisible();
    expect(await platformState(form)).toEqual(['x:true', 'bluesky:false']);
    await form.locator('#release-edit-field-platforms summary').click();
    await form.locator('input[name="selectedPlatforms"][value="bluesky"]').check();
    await dialog.locator('footer [data-dialog-submit]').click();
    await expect(dialog).toBeHidden();

    // Scheduled row, information card and retained confirmation agree.
    await expect(platformsCell(row)).toHaveText('X, Bluesky');
    await expect.poll(() => badges(row.locator('.release-social-prep-summary'))).toEqual(['X', 'Bluesky']);
    await expect(platformsCell(retained)).toHaveText('X, Bluesky');
    await expect.poll(() => badges(retainedSocial)).toEqual(['X', 'Bluesky']);
    await expect(retained.locator('.dashboard-readiness')).toHaveCount(1);
    await expect(retained.locator('.release-social-prep-summary')).toHaveCount(1);
    await expect(undo).toHaveCount(1);
    await expect(undo).toBeVisible();
    await expect(banner).toBeHidden();

    // A refresh failure after saving keeps the stale metadata and reports it;
    // Retry (GET only) reconciles it.
    const dashboardUrl = (url) => url.pathname === '/';
    await page.route(dashboardUrl, (route) => (
      route.request().resourceType() === 'fetch' ? route.fulfill({ status: 500, body: 'down' }) : route.continue()));
    await retained.locator(`.dashboard-item-title [data-calendar-info-trigger]`).click();
    await card.locator(`[data-release-edit-id="${gamma.id}"]`).click();
    await expect(dialog).toBeVisible();
    await form.locator('#release-edit-field-platforms summary').click();
    await form.locator('input[name="selectedPlatforms"][value="x"]').uncheck();
    await dialog.locator('footer [data-dialog-submit]').click();
    await expect(dialog).toBeHidden();
    await expect(banner.locator('[data-dashboard-sync-message]')).toContainText('The release was saved, but the dashboard couldn’t refresh');
    expect(await badges(retainedSocial)).toEqual(['X', 'Bluesky']);
    await page.unroute(dashboardUrl);
    await banner.locator('[data-dashboard-sync-retry]').click();
    await expect(banner.locator('[data-dashboard-sync-message]')).toHaveText('Dashboard refreshed. Scheduling is available again.');
    await expect.poll(() => badges(retainedSocial)).toEqual(['Bluesky']);
    await expect.poll(() => badges(row.locator('.release-social-prep-summary'))).toEqual(['Bluesky']);
    await expect(retained.locator('.release-social-prep-summary')).toHaveCount(1);
    expect(posts).toEqual([`/releases/${gamma.id}`, `/releases/${gamma.id}`]);

    // Undo still works after both refreshes and returns Gamma to Needs a date.
    await expect(undo).toHaveCount(1);
    await undo.click();
    await expect(row).toHaveCount(0);
    await expect(retained.locator('[data-dashboard-schedule-pick]').first()).toBeEnabled();
    expect(await page.evaluate(() => {
      const ids = [...document.querySelectorAll('[id]')].map((element) => element.id);
      return ids.filter((id, index) => ids.indexOf(id) !== index);
    })).toEqual([]);
    expect(page.url()).toBe(`${origin}/`);
    expect(pageErrors).toEqual([]);
  });
});
