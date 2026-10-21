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

const MONTH = '2031-07';

async function withReleases(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-calendar-edit-'));
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
    const project = app.locals.projectService.create({ title: 'Calendar edit project' });
    const releases = createReleaseRepository(db);
    socialPrepSettingsService.setPlatforms(['x', 'bluesky', 'patreon']);
    const alpha = releases.create({ projectId: project.id, title: 'Alpha release', description: 'Alpha description', notes: 'Alpha notes' });
    releaseService.updateRelease(alpha.id, {
      title: 'Alpha release', description: 'Alpha description', notes: 'Alpha notes',
      plannedDate: `${MONTH}-10`, plannedTime: '09:30', publishedDate: null,
      patreonUrl: 'https://example.com/alpha', selectedPlatforms: ['x'],
    });
    const beta = releases.create({ projectId: project.id, title: 'Beta release', description: '', notes: '' });
    releaseService.updateRelease(beta.id, {
      title: 'Beta release', description: '', notes: 'Beta notes', plannedDate: `${MONTH}-20`, plannedTime: null,
      publishedDate: null, patreonUrl: null, selectedPlatforms: ['patreon', 'bluesky'],
    });
    // Beta keeps a saved platform that is no longer configured.
    socialPrepSettingsService.setPlatforms(['x', 'bluesky']);
    const signature = releaseSignatureSettingsService.add({ name: 'Thanks', body: 'Thanks for reading' }).entries[0];
    releaseSignatureSettingsService.setDefault(signature.id);
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    await run({ origin: `http://127.0.0.1:${server.address().port}`, alpha, beta, releaseService });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function watchPage(page) {
  const errors = [];
  const navigations = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // Provoked 404/422 responses are logged as resource failures, not script errors.
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) errors.push(message.text());
  });
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
  return { errors, navigations };
}

async function recordSavedEdits(page) {
  await page.evaluate(() => {
    window.savedEdits = [];
    document.addEventListener('release-edit-saved', (event) => window.savedEdits.push(event.detail));
  });
}

async function duplicateIds(page) {
  return page.evaluate(() => {
    const ids = [...document.querySelectorAll('[id]')].map((element) => element.id);
    return ids.filter((id, index) => ids.indexOf(id) !== index);
  });
}

async function platformState(form) {
  return form.locator('input[name="selectedPlatforms"]').evaluateAll((inputs) => inputs.map((input) => `${input.value}:${input.checked}`));
}

// Opens the visible surface's information card, then its Edit action.
async function clickCalendarEdit(page, surface, releaseId) {
  const cardId = `calendar-info-${surface}-${releaseId}`;
  const trigger = page.locator(`[data-calendar-info-trigger][aria-controls="${cardId}"]`);
  await trigger.click();
  await page.locator(`#${cardId} [data-release-edit-id="${releaseId}"]`).click();
  return trigger;
}

test('Calendar edits releases from grid and list in the shared dialog without navigating', async ({ page }) => {
  test.setTimeout(90_000);
  const { errors, navigations } = watchPage(page);
  await withReleases(async ({ origin, alpha, beta, releaseService }) => {
    const calendarUrl = `${origin}/calendar?month=${MONTH}&status=planned&weekStart=sunday`;
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(calendarUrl);
    navigations.length = 0;
    await recordSavedEdits(page);
    const dialog = page.locator('#release-edit-dialog');
    const form = page.locator('#release-edit-form');
    const title = form.locator('[name="title"]');
    await expect(page.locator('dialog#release-edit-dialog')).toHaveCount(1);

    // Grid: Alpha loads its own values, platforms and actions.
    const alphaTrigger = await clickCalendarEdit(page, 'grid', alpha.id);
    await expect(dialog).toBeVisible();
    await expect(page.locator(`#calendar-info-grid-${alpha.id}`)).toBeHidden();
    await expect(title).toHaveValue('Alpha release');
    await expect(form.locator('[name="description"]')).toHaveValue('Alpha description');
    await expect(form.locator('[name="plannedDate"]')).toHaveValue(`${MONTH}-10`);
    await expect(form.locator('[name="plannedTime"]')).toHaveValue('09:30');
    await expect(form.locator('[name="patreonUrl"]')).toHaveValue('https://example.com/alpha');
    expect(await platformState(form)).toEqual(['x:true', 'bluesky:false']);
    await expect(form.locator('[data-release-signature-field] select')).toHaveValue('');
    await expect(form).toHaveAttribute('action', `/releases/${alpha.id}`);
    await expect(dialog.locator('[data-release-edit-action="archive"] form')).toHaveAttribute('action', `/releases/${alpha.id}/archive`);
    await expect(dialog.locator('[data-release-edit-action="delete"] form')).toHaveAttribute('action', `/releases/${alpha.id}/delete`);

    // Cancel restores the baseline, keeps Calendar, and focuses the event title.
    await title.fill('Scratch title');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(alphaTrigger).toBeFocused();
    expect(page.url()).toBe(calendarUrl);

    // Validation failure keeps the Beta draft open.
    await clickCalendarEdit(page, 'grid', beta.id);
    await expect(title).toHaveValue('Beta release');
    await expect(form.locator('[name="description"]')).toHaveValue('');
    await expect(form.locator('[name="patreonUrl"]')).toHaveValue('');
    expect(await platformState(form)).toEqual(['patreon:true', 'x:false', 'bluesky:true']);
    await title.fill('');
    await form.locator('[name="notes"]').fill('Draft notes');
    await dialog.locator('footer [data-dialog-submit]').click();
    await expect(form.locator('[data-dialog-field="title"] .field-error-message')).toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(form.locator('[name="notes"]')).toHaveValue('Draft notes');

    // Manage Signatures returns to the draft; choosing a signature inserts it.
    const manage = form.locator('button[aria-label="Manage signatures"]');
    await manage.click();
    await expect(page.locator('#release-signatures-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#release-signatures-dialog')).toBeHidden();
    await expect(dialog).toBeVisible();
    await expect(manage).toBeFocused();
    await expect(form.locator('[name="notes"]')).toHaveValue('Draft notes');
    await form.locator('#release-edit-field-signature summary').click();
    await form.locator('[data-release-signature-field] input[type="radio"]:not([value=""])').click();
    await expect(form.locator('[name="description"]')).toHaveValue('Thanks for reading');

    // Save posts the complete form once, then stays on Calendar.
    await title.fill('Beta renamed');
    const posts = [];
    page.on('request', (request) => { if (request.method() === 'POST') posts.push(request); });
    const submit = dialog.locator('footer [data-dialog-submit]');
    await submit.evaluate((button) => { button.click(); button.click(); });
    await expect(dialog).toBeHidden();
    expect(posts.map((request) => new URL(request.url()).pathname)).toEqual([`/releases/${beta.id}`]);
    const body = new URLSearchParams(posts[0].postData());
    expect(body.get('selectedPlatformsPresent')).toBe('1');
    expect(body.getAll('selectedPlatforms')).toEqual(['patreon', 'bluesky']);
    for (const name of ['_csrf', 'title', 'description', 'notes', 'plannedDate', 'plannedTime', 'publishedDate', 'patreonUrl']) {
      expect(body.has(name)).toBe(true);
    }
    expect(body.get('plannedDate')).toBe(`${MONTH}-20`);
    await expect(page.locator('[data-dialog-feedback]')).toContainText('Release updated.');
    await expect.poll(() => page.evaluate(() => window.savedEdits.length)).toBe(1);
    const saved = await page.evaluate(() => window.savedEdits[0]);
    expect(saved.releaseId).toBe(String(beta.id));
    expect(saved.values.title).toBe('Beta renamed');
    expect(releaseService.findRelease(beta.id)).toMatchObject({ title: 'Beta renamed', notes: 'Draft notes', description: 'Thanks for reading' });

    // List view (switched in place) edits through the same dialog.
    await page.locator('.calendar-view-switcher a[aria-label="List view"]').click();
    await expect(page.locator('[data-calendar-live-region]')).toHaveClass(/calendar-view-list/);
    const listUrl = page.url();
    expect(new URL(listUrl).searchParams.get('view')).toBe('list');
    await page.locator('.calendar-scroll').evaluate(() => window.scrollTo(0, 200));
    const scrollBefore = await page.evaluate(() => window.scrollY);
    const listTrigger = await clickCalendarEdit(page, 'agenda', alpha.id);
    await expect(title).toHaveValue('Alpha release');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(listTrigger).toBeFocused();
    expect(page.url()).toBe(listUrl);
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);

    // Dismissing during loading prevents a late response from hydrating.
    let releaseAlpha;
    const alphaHeld = new Promise((resolve) => { releaseAlpha = resolve; });
    await page.route(`**/releases/${alpha.id}/edit`, async (route) => { await alphaHeld; await route.continue(); });
    await clickCalendarEdit(page, 'agenda', alpha.id);
    await expect(dialog.locator('[data-dialog-status]')).toHaveText('Loading release…');
    await expect(dialog.locator('footer [data-dialog-submit]')).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await clickCalendarEdit(page, 'agenda', beta.id);
    await expect(title).toHaveValue('Beta renamed');
    releaseAlpha();
    await page.waitForTimeout(500);
    await expect(title).toHaveValue('Beta renamed');
    await expect(form).toHaveAttribute('action', `/releases/${beta.id}`);
    await page.keyboard.press('Escape');
    await page.unroute(`**/releases/${alpha.id}/edit`);

    // A missing release reports in place without stale data.
    await page.route(`**/releases/${alpha.id}/edit`, (route) => route.fulfill({
      status: 404, contentType: 'application/json',
      body: JSON.stringify({ status: 'error', code: 'RELEASE_NOT_FOUND', message: 'Release not found.' }),
    }));
    await clickCalendarEdit(page, 'agenda', alpha.id);
    await expect(dialog.locator('[data-dialog-status]')).toHaveText('Release not found.');
    await expect(dialog.locator('.app-dialog-body')).toBeHidden();
    await page.keyboard.press('Escape');
    await page.unroute(`**/releases/${alpha.id}/edit`);

    // Calendar popovers still open and dismiss as before.
    const cardTrigger = page.locator(`[data-calendar-info-trigger][aria-controls="calendar-info-agenda-${alpha.id}"]`);
    await cardTrigger.click();
    await expect(page.locator(`#calendar-info-agenda-${alpha.id}`)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator(`#calendar-info-agenda-${alpha.id}`)).toBeHidden();

    expect(await duplicateIds(page)).toEqual([]);
    // Only the in-place List switch changed the URL (history, not a load).
    expect(navigations.filter((url) => url !== listUrl)).toEqual([]);
    expect(errors).toEqual([]);
  });
});

test('Release Detail edits through the shared async dialog without reloading', async ({ page }) => {
  test.setTimeout(90_000);
  const { errors, navigations } = watchPage(page);
  await withReleases(async ({ origin, alpha, releaseService }) => {
    const detailUrl = `${origin}/releases/${alpha.id}`;
    await page.goto(detailUrl);
    navigations.length = 0;
    await recordSavedEdits(page);
    await page.evaluate(() => { window.__notReloaded = true; });
    await expect(page.locator('dialog#release-edit-dialog')).toHaveCount(1);
    await expect(page.locator('[data-dialog-open="release-edit-dialog"]')).toHaveCount(0);
    const trigger = page.locator(`[data-release-edit-id="${alpha.id}"]`);
    const dialog = page.locator('#release-edit-dialog');
    const form = page.locator('#release-edit-form');
    const title = form.locator('[name="title"]');

    const loads = [];
    page.on('request', (request) => { if (request.url().endsWith(`/releases/${alpha.id}/edit`)) loads.push(request); });
    await trigger.click();
    await expect(dialog).toBeVisible();
    await expect(title).toHaveValue('Alpha release');
    await expect(form.locator('[name="publishedDate"]')).toHaveValue('');
    expect(loads).toHaveLength(1);
    await expect(dialog.locator('[data-release-edit-action="archive"]')).toBeVisible();

    // Cancel restores without reloading and returns focus to Edit.
    await title.fill('Scratch');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();

    // Validation keeps the draft visible.
    await trigger.click();
    await expect(title).toHaveValue('Alpha release');
    await form.locator('[name="patreonUrl"]').fill('not a url');
    await form.locator('[name="notes"]').fill('Detail draft');
    await dialog.locator('footer [data-dialog-submit]').click();
    await expect(form.locator('[data-dialog-field="patreonUrl"] .field-error-message')).toBeVisible();
    await expect(form.locator('[name="notes"]')).toHaveValue('Detail draft');

    // Signatures still open from Edit Release and return to it.
    await form.locator('button[aria-label="Manage signatures"]').click();
    await expect(page.locator('#release-signatures-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();

    // A published date saves asynchronously with the complete form.
    await form.locator('[name="patreonUrl"]').fill('https://example.com/alpha-2');
    await form.locator('[name="publishedDate"]').fill(`${MONTH}-11`);
    const postPromise = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith(`/releases/${alpha.id}`));
    await dialog.locator('footer [data-dialog-submit]').click();
    const body = new URLSearchParams((await postPromise).postData());
    for (const name of ['_csrf', 'title', 'description', 'notes', 'plannedDate', 'plannedTime', 'publishedDate', 'patreonUrl', 'selectedPlatformsPresent']) {
      expect(body.has(name)).toBe(true);
    }
    expect(body.has('returnTo')).toBe(false);
    expect(body.getAll('selectedPlatforms')).toEqual(['x']);
    await expect(dialog).toBeHidden();
    await expect(page.locator('[data-dialog-feedback]')).toContainText('Release updated.');
    await expect.poll(() => page.evaluate(() => window.savedEdits.length)).toBe(1);
    expect(releaseService.findRelease(alpha.id)).toMatchObject({
      notes: 'Detail draft', patreon_url: 'https://example.com/alpha-2', published_date: `${MONTH}-11`,
    });

    // Reopening loads the saved model: Archive no longer applies once published.
    await trigger.click();
    await expect(form.locator('[name="publishedDate"]')).toHaveValue(`${MONTH}-11`);
    await expect(dialog.locator('[data-release-edit-action="archive"]')).toBeHidden();
    await expect(dialog.locator('[data-release-edit-action="delete"]')).toBeVisible();
    await page.keyboard.press('Escape');

    expect(await page.evaluate(() => window.__notReloaded)).toBe(true);
    expect(navigations).toEqual([]);
    expect(page.url()).toBe(detailUrl);
    expect(await duplicateIds(page)).toEqual([]);
    expect(errors).toEqual([]);
  });
});

test('Release Detail ?edit=1 deep link loads, resets and saves through the shared dialog', async ({ page }) => {
  test.setTimeout(90_000);
  const { errors, navigations } = watchPage(page);
  await withReleases(async ({ origin, alpha, releaseService }) => {
    // The JSON edit model's title differs from the page markup, so the form
    // can only show it after the controller's normal JSON load.
    const loads = [];
    await page.route(`**/releases/${alpha.id}/edit`, async (route) => {
      const request = route.request();
      if (!(request.headers().accept || '').includes('application/json')) return route.continue();
      loads.push(request.url());
      const response = await route.fetch();
      const payload = await response.json();
      payload.values.title = 'Loaded from JSON';
      return route.fulfill({ response, json: payload });
    });
    // A bookmarked legacy /edit link with Calendar return context lands on
    // the canonical deep link without that context.
    await page.goto(`${origin}/releases/${alpha.id}/edit?returnTo=${encodeURIComponent(`/calendar?month=${MONTH}`)}`);
    const deepLinkUrl = `${origin}/releases/${alpha.id}?edit=1`;
    expect(page.url()).toBe(deepLinkUrl);
    navigations.length = 0;
    await page.evaluate(() => { window.__notReloaded = true; });
    const dialog = page.locator('#release-edit-dialog');
    const form = page.locator('#release-edit-form');
    const title = form.locator('[name="title"]');
    const trigger = page.locator(`[data-release-edit-id="${alpha.id}"]`);

    await expect(dialog).toBeVisible();
    await expect(title).toHaveValue('Loaded from JSON');
    expect(loads).toHaveLength(1);
    await expect(form).not.toHaveAttribute('data-release-edit-deep-link');
    await expect(form).toHaveAttribute('action', `/releases/${alpha.id}`);
    await expect(form.locator('[name="description"]')).toHaveValue('Alpha description');
    await expect(form.locator('[name="plannedTime"]')).toHaveValue('09:30');
    expect(await platformState(form)).toEqual(['x:true', 'bluesky:false']);
    await expect(form.locator('[data-release-signature-field] select')).toHaveValue('');
    await expectArchive(dialog, `/releases/${alpha.id}/archive`);

    // Cancel restores the loaded baseline, not the server-rendered markup.
    await title.fill('Scratch');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(title).toHaveValue('Loaded from JSON');

    // A plain Edit click reuses the same load; validation keeps the draft.
    await trigger.click();
    await expect(title).toHaveValue('Loaded from JSON');
    expect(loads).toHaveLength(2);
    await form.locator('[name="patreonUrl"]').fill('not a url');
    await form.locator('[name="notes"]').fill('Deep draft');
    await dialog.locator('footer [data-dialog-submit]').click();
    await expect(form.locator('[data-dialog-field="patreonUrl"] .field-error-message')).toBeVisible();
    await expect(form.locator('[name="notes"]')).toHaveValue('Deep draft');

    // Save is asynchronous, carries no returnTo, and refreshes Release Detail in place.
    await form.locator('[name="patreonUrl"]').fill('https://example.com/alpha-3');
    await title.fill('Deep linked');
    const postPromise = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith(`/releases/${alpha.id}`));
    const refreshPromise = page.waitForRequest((request) => request.method() === 'GET'
      && request.resourceType() === 'fetch' && new URL(request.url()).pathname === `/releases/${alpha.id}`);
    await dialog.locator('footer [data-dialog-submit]').click();
    expect(new URLSearchParams((await postPromise).postData()).has('returnTo')).toBe(false);
    expect(new URL((await refreshPromise).url()).searchParams.has('edit')).toBe(false);
    await expect(dialog).toBeHidden();
    await expect(page.locator('.app-section-title')).toContainText('Deep linked');
    expect(releaseService.findRelease(alpha.id)).toMatchObject({ title: 'Deep linked', notes: 'Deep draft' });

    // Reopening loads the saved release.
    await trigger.click();
    await expect(form.locator('[name="notes"]')).toHaveValue('Deep draft');
    await expect(form.locator('[name="patreonUrl"]')).toHaveValue('https://example.com/alpha-3');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    expect(page.url()).toBe(deepLinkUrl);
    expect(await page.evaluate(() => window.__notReloaded)).toBe(true);
    expect(navigations).toEqual([]);
    expect(await duplicateIds(page)).toEqual([]);
    expect(errors).toEqual([]);
  });
});

test('A failed ?edit=1 deep link load exposes no editable release', async ({ page }) => {
  test.setTimeout(60_000);
  const { errors } = watchPage(page);
  await withReleases(async ({ origin, alpha }) => {
    await page.route(`**/releases/${alpha.id}/edit`, (route) => route.fulfill({
      status: 500, contentType: 'application/json', body: JSON.stringify({ status: 'error', message: 'Load failed here.' }),
    }));
    await page.goto(`${origin}/releases/${alpha.id}?edit=1`);
    const dialog = page.locator('#release-edit-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-dialog-status]')).toHaveText('Load failed here.');
    await expect(dialog.locator('.app-dialog-body')).toBeHidden();
    await expect(dialog.locator('footer [data-dialog-submit]')).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    expect(errors).toEqual([]);
  });
});

test('Calendar Edit links name the canonical deep link and open it in a new tab', async ({ page, context }) => {
  test.setTimeout(90_000);
  const { errors, navigations } = watchPage(page);
  await withReleases(async ({ origin, alpha }) => {
    const canonical = `/releases/${alpha.id}?edit=1`;
    const calendarUrl = `${origin}/calendar?month=${MONTH}&status=all&weekStart=sunday`;
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(calendarUrl);
    navigations.length = 0;
    for (const surface of ['grid', 'agenda']) {
      await expect(page.locator(`#calendar-info-${surface}-${alpha.id} [data-release-edit-id="${alpha.id}"]`))
        .toHaveAttribute('href', canonical);
    }

    // A modified click keeps browser link semantics: a new tab opens the
    // deep link while this page stays put with no dialog.
    const cardId = `calendar-info-grid-${alpha.id}`;
    await page.locator(`[data-calendar-info-trigger][aria-controls="${cardId}"]`).click();
    const popupPromise = context.waitForEvent('page');
    await page.locator(`#${cardId} [data-release-edit-id="${alpha.id}"]`).click({ modifiers: ['Control'] });
    const popup = await popupPromise;
    await popup.waitForLoadState();
    expect(popup.url()).toBe(`${origin}${canonical}`);
    await expect(popup.locator('#release-edit-dialog')).toBeVisible();
    await expect(popup.locator('#release-edit-form [name="title"]')).toHaveValue('Alpha release');
    await popup.close();
    await expect(page.locator('#release-edit-dialog')).toBeHidden();
    expect(page.url()).toBe(calendarUrl);
    expect(navigations).toEqual([]);
    expect(errors).toEqual([]);
  });
});

// Archive availability follows the authoritative JSON edit model, not the
// eligibility the page happened to render with.
function setAlphaPublished(releaseService, alpha, publishedDate) {
  releaseService.updateRelease(alpha.id, {
    title: 'Alpha release', description: 'Alpha description', notes: 'Alpha notes',
    plannedDate: `${MONTH}-10`, plannedTime: '09:30', publishedDate,
    patreonUrl: 'https://example.com/alpha', selectedPlatforms: ['x'],
  });
}

async function expectArchive(dialog, url) {
  const archive = dialog.locator('[data-release-edit-action="archive"]');
  await expect(archive).toHaveCount(1);
  if (url) await expect(archive).toBeVisible();
  else await expect(archive).toBeHidden();
  await expect(archive.locator('form')).toHaveAttribute('action', url || '');
}

test('Archive becomes available after a published release is unpublished, without a reload', async ({ page }) => {
  test.setTimeout(90_000);
  const { errors, navigations } = watchPage(page);
  await withReleases(async ({ origin, alpha, releaseService }) => {
    setAlphaPublished(releaseService, alpha, `${MONTH}-11`);
    const detailUrl = `${origin}/releases/${alpha.id}`;
    await page.goto(detailUrl);
    navigations.length = 0;
    await page.evaluate(() => { window.__notReloaded = true; });
    const trigger = page.locator(`[data-release-edit-id="${alpha.id}"]`);
    const dialog = page.locator('#release-edit-dialog');
    const form = page.locator('#release-edit-form');
    const archiveUrl = `/releases/${alpha.id}/archive`;

    // Published: rendered but unavailable.
    await expectArchive(dialog, null);
    await trigger.click();
    await expect(form.locator('[name="publishedDate"]')).toHaveValue(`${MONTH}-11`);
    await expectArchive(dialog, null);
    await expect(dialog.locator('[data-release-edit-action="delete"]')).toBeVisible();

    // Clear Published date and save asynchronously.
    await form.locator('[name="publishedDate"]').fill('');
    await dialog.locator('footer [data-dialog-submit]').click();
    await expect(dialog).toBeHidden();
    expect(releaseService.findRelease(alpha.id).published_date).toBeNull();

    // Reopen: Archive is available with this release's target.
    await trigger.click();
    await expect(form.locator('[name="publishedDate"]')).toHaveValue('');
    await expectArchive(dialog, archiveUrl);

    // The existing confirmation still guards Archive; cancelling keeps everything.
    const archive = dialog.locator('[data-release-edit-action="archive"]');
    await archive.locator('summary').click();
    await archive.locator('button[type="submit"]').click();
    const confirmation = page.locator('#app-confirmation-dialog');
    await expect(confirmation).toBeVisible();
    await expect(confirmation).toContainText('Archive this release? This cannot be undone.');
    await page.keyboard.press('Escape');
    await expect(confirmation).toBeHidden();
    expect(releaseService.findRelease(alpha.id).archived_at ?? null).toBeNull();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // Eligibility changes on the server before the next opening, both ways.
    setAlphaPublished(releaseService, alpha, `${MONTH}-12`);
    await trigger.click();
    await expect(form.locator('[name="publishedDate"]')).toHaveValue(`${MONTH}-12`);
    await expectArchive(dialog, null);
    await page.keyboard.press('Escape');
    setAlphaPublished(releaseService, alpha, null);
    await trigger.click();
    await expect(form.locator('[name="publishedDate"]')).toHaveValue('');
    await expectArchive(dialog, archiveUrl);

    // Delete keeps its target and confirmation.
    const remove = dialog.locator('[data-release-edit-action="delete"]');
    await expect(remove.locator('form')).toHaveAttribute('action', `/releases/${alpha.id}/delete`);
    await remove.locator('summary').click();
    await remove.locator('button[type="submit"]').click();
    await expect(confirmation).toBeVisible();
    await expect(confirmation).toContainText('Delete this release permanently?');
    await page.keyboard.press('Escape');
    await expect(confirmation).toBeHidden();
    expect(releaseService.findRelease(alpha.id)).toBeTruthy();
    await page.keyboard.press('Escape');

    expect(await page.locator('form[action$="/archive"]').count()).toBe(1);
    expect(await page.evaluate(() => window.__notReloaded)).toBe(true);
    expect(navigations).toEqual([]);
    expect(await duplicateIds(page)).toEqual([]);
    expect(errors).toEqual([]);
  });
});

test('Archive availability and target follow the release loaded on Calendar and the ?edit=1 deep link', async ({ page }) => {
  test.setTimeout(90_000);
  const { errors, navigations } = watchPage(page);
  await withReleases(async ({ origin, alpha, beta, releaseService }) => {
    const calendarUrl = `${origin}/calendar?month=${MONTH}&status=all&weekStart=sunday`;
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(calendarUrl);
    navigations.length = 0;
    const dialog = page.locator('#release-edit-dialog');
    const title = page.locator('#release-edit-form [name="title"]');

    // No release loaded yet: nothing actionable.
    await expectArchive(dialog, null);

    await clickCalendarEdit(page, 'grid', alpha.id);
    await expect(title).toHaveValue('Alpha release');
    await expectArchive(dialog, `/releases/${alpha.id}/archive`);
    await page.keyboard.press('Escape');

    await clickCalendarEdit(page, 'grid', beta.id);
    await expect(title).toHaveValue('Beta release');
    await expectArchive(dialog, `/releases/${beta.id}/archive`);
    await page.keyboard.press('Escape');

    // Calendar only offers Edit on unpublished releases, so Beta becomes
    // ineligible on the server after the page rendered.
    releaseService.updateRelease(beta.id, {
      title: 'Beta release', description: '', notes: 'Beta notes', plannedDate: `${MONTH}-20`, plannedTime: null,
      publishedDate: `${MONTH}-21`, patreonUrl: null, selectedPlatforms: ['bluesky'],
    });
    await clickCalendarEdit(page, 'grid', beta.id);
    await expect(page.locator('#release-edit-form [name="publishedDate"]')).toHaveValue(`${MONTH}-21`);
    await expectArchive(dialog, null);
    await expect(dialog.locator('[data-release-edit-action="delete"] form')).toHaveAttribute('action', `/releases/${beta.id}/delete`);
    await page.keyboard.press('Escape');

    await clickCalendarEdit(page, 'grid', alpha.id);
    await expect(title).toHaveValue('Alpha release');
    await expectArchive(dialog, `/releases/${alpha.id}/archive`);
    await page.keyboard.press('Escape');
    expect(navigations).toEqual([]);
    expect(await duplicateIds(page)).toEqual([]);

    setAlphaPublished(releaseService, alpha, `${MONTH}-11`);
    // Deep link to a published release: Archive is unavailable; once the
    // server unpublishes it, the next Edit opening offers it.
    await page.goto(`${origin}/releases/${alpha.id}?edit=1`);
    await expect(dialog).toBeVisible();
    await expectArchive(dialog, null);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    setAlphaPublished(releaseService, alpha, null);
    await page.locator(`[data-release-edit-id="${alpha.id}"]`).click();
    await expect(page.locator('#release-edit-form [name="publishedDate"]')).toHaveValue('');
    await expectArchive(dialog, `/releases/${alpha.id}/archive`);
    expect(errors).toEqual([]);
  });
});

function calendarDay(page, day) {
  return page.locator('.calendar-table .calendar-day:not(.out-of-month)')
    .filter({ has: page.locator('.day-header', { hasText: new RegExp(`^${String(day).padStart(2, "0")}$`) }) });
}

async function saveEdit(page, fields) {
  const form = page.locator('#release-edit-form');
  for (const [name, value] of Object.entries(fields)) await form.locator(`[name="${name}"]`).fill(value);
  await page.locator('#release-edit-dialog footer [data-dialog-submit]').click();
  await expect(page.locator('#release-edit-dialog')).toBeHidden();
}

test('Calendar refreshes in place after an Edit Release save and keeps the active Calendar', async ({ page }) => {
  test.setTimeout(120_000);
  const { errors, navigations } = watchPage(page);
  await withReleases(async ({ origin, alpha, beta, releaseService }) => {
    const projectId = releaseService.findRelease(alpha.id).project_id;
    const calendarUrl = `${origin}/calendar?month=${MONTH}&status=planned&weekStart=sunday&view=grid&project=${projectId}`;
    await page.setViewportSize({ width: 1280, height: 520 });
    await page.goto(calendarUrl);
    navigations.length = 0;
    await page.evaluate(() => { window.__notReloaded = true; });
    const posts = [];
    const calendarGets = [];
    page.on('request', (request) => {
      if (request.method() === 'POST') posts.push(new URL(request.url()).pathname);
      else if (new URL(request.url()).pathname === '/calendar') calendarGets.push(request.url());
    });
    const dialog = page.locator('#release-edit-dialog');
    const region = page.locator('[data-calendar-live-region]');
    const feedback = page.locator('[data-dialog-feedback]');
    const alphaGrid = page.locator(`[data-calendar-info-trigger][aria-controls="calendar-info-grid-${alpha.id}"]`);

    // Cancel does not refresh.
    await clickCalendarEdit(page, 'grid', beta.id);
    await expect(page.locator('#release-edit-form [name="title"]')).toHaveValue('Beta release');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await page.waitForTimeout(300);
    expect(calendarGets).toEqual([]);

    // Grid: title, date and time change; the event moves to its new day.
    await page.evaluate(() => window.scrollTo(0, 120));
    await clickCalendarEdit(page, 'grid', alpha.id);
    await expect(page.locator('#release-edit-form [name="title"]')).toHaveValue('Alpha release');
    // Scroll is sampled once the dialog has closed and returned focus, just
    // before the refresh response is installed.
    let scrollBefore = null;
    const sampleScroll = async (route) => {
      scrollBefore = await page.evaluate(() => window.scrollY);
      await route.continue();
    };
    const isCalendar = (url) => url.pathname === '/calendar';
    await page.route(isCalendar, sampleScroll);
    await saveEdit(page, { title: 'Alpha moved', plannedDate: `${MONTH}-15`, plannedTime: '14:45', notes: 'Moved notes' });
    await expect(calendarDay(page, 15).locator(`[aria-controls="calendar-info-grid-${alpha.id}"]`)).toContainText('Alpha moved');
    await expect(calendarDay(page, 10)).not.toContainText('Alpha');
    await expect(alphaGrid.locator(`time[datetime="${MONTH}-15T14:45"]`)).toHaveCount(1);
    await expect(feedback).toContainText('Release updated.');
    expect(posts).toEqual([`/releases/${alpha.id}`]);
    expect(calendarGets).toEqual([calendarUrl]);
    expect(page.url()).toBe(calendarUrl);
    await expect(region).toHaveClass(/calendar-view-grid/);
    await expect(alphaGrid).toBeFocused();
    await page.unroute(isCalendar, sampleScroll);
    expect(scrollBefore).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
    // Filters and week start are still the active ones.
    await expect(page.locator('.calendar-row-header .calendar-th').first()).toHaveText('Sun');
    await expect(page.locator('#calendar-filters input[name="status"][value="planned"]')).toBeChecked();
    await expect(page.locator('#calendar-filters input[name="weekStart"][value="sunday"]')).toBeChecked();

    // The refreshed information card and its Edit action still work.
    await alphaGrid.click();
    const alphaCard = page.locator(`#calendar-info-grid-${alpha.id}`);
    await expect(alphaCard).toBeVisible();
    await expect(alphaCard).toContainText('Moved notes');
    await alphaCard.locator(`[data-release-edit-id="${alpha.id}"]`).click();
    await expect(alphaCard).toBeHidden();
    await expect(page.locator('#release-edit-form [name="title"]')).toHaveValue('Alpha moved');
    await expect(page.locator('#release-edit-form [name="plannedTime"]')).toHaveValue('14:45');

    // Moving outside the month removes it from this month.
    await saveEdit(page, { plannedDate: '2031-08-03' });
    await expect(page.locator(`[aria-controls="calendar-info-grid-${alpha.id}"]`)).toHaveCount(0);
    await expect(page.locator('[data-calendar-month-heading]')).toBeFocused();
    expect(page.url()).toBe(calendarUrl);

    // A release edited from outside the grid into the displayed month appears.
    await page.evaluate((id) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.id = 'outside-edit';
      button.setAttribute('data-release-edit-id', String(id));
      button.textContent = 'Edit outside';
      document.querySelector('[data-calendar-live-region]').before(button);
    }, alpha.id);
    await page.locator('#outside-edit').click();
    await expect(page.locator('#release-edit-form [name="plannedDate"]')).toHaveValue('2031-08-03');
    await saveEdit(page, { plannedDate: `${MONTH}-05` });
    await expect(calendarDay(page, 5)).toContainText('Alpha moved');
    await page.evaluate(() => document.getElementById('outside-edit').remove());

    // The planned status filter stays applied: publishing Beta removes it.
    await clickCalendarEdit(page, 'grid', beta.id);
    await expect(page.locator('#release-edit-form [name="title"]')).toHaveValue('Beta release');
    await saveEdit(page, { publishedDate: `${MONTH}-22` });
    await expect(page.locator(`[aria-controls="calendar-info-grid-${beta.id}"]`)).toHaveCount(0);
    expect(page.url()).toBe(calendarUrl);
    expect(posts).toEqual([`/releases/${alpha.id}`, `/releases/${alpha.id}`, `/releases/${alpha.id}`, `/releases/${beta.id}`]);
    expect(calendarGets.every((url) => url === calendarUrl)).toBe(true);
    expect(await page.evaluate(() => window.__notReloaded)).toBe(true);
    expect(navigations).toEqual([]);
    expect(await duplicateIds(page)).toEqual([]);
    expect(await page.locator('dialog#release-edit-dialog').count()).toBe(1);
    expect(await page.locator('dialog#release-signatures-dialog').count()).toBe(1);
    expect(errors).toEqual([]);
  });
});

test('Calendar list refresh follows the published-date rule and recovers from a failed refresh without reposting', async ({ page }) => {
  test.setTimeout(120_000);
  const { errors, navigations } = watchPage(page);
  await withReleases(async ({ origin, alpha, beta }) => {
    const listUrl = `${origin}/calendar?month=${MONTH}&status=all&weekStart=monday&view=list`;
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(listUrl);
    navigations.length = 0;
    await page.evaluate(() => { window.__notReloaded = true; });
    const posts = [];
    page.on('request', (request) => { if (request.method() === 'POST') posts.push(new URL(request.url()).pathname); });
    const region = page.locator('[data-calendar-live-region]');
    const feedback = page.locator('[data-dialog-feedback]');
    const agendaDay = (date) => page.locator('.agenda-day')
      .filter({ has: page.locator('.agenda-day-date', { hasText: date }) });
    const isCalendar = (url) => url.pathname === '/calendar';

    // List: a published release shows on its published date.
    await clickCalendarEdit(page, 'agenda', alpha.id);
    await expect(page.locator('#release-edit-form [name="title"]')).toHaveValue('Alpha release');
    await saveEdit(page, { title: 'Alpha published', publishedDate: `${MONTH}-25` });
    await expect(agendaDay(`${MONTH}-25`)).toContainText('Alpha published');
    await expect(agendaDay(`${MONTH}-25`).locator('.calendar-release-status')).toHaveText('Published');
    await expect(agendaDay(`${MONTH}-10`)).not.toContainText('Alpha');
    await expect(region).toHaveClass(/calendar-view-list/);
    expect(page.url()).toBe(listUrl);

    // Refresh failure: the save is acknowledged, Calendar is kept and marked
    // possibly stale, and Retry refresh only fetches Calendar.
    await page.route(isCalendar, (route) => route.fulfill({ status: 500, body: 'down' }));
    await clickCalendarEdit(page, 'agenda', beta.id);
    await expect(page.locator('#release-edit-form [name="title"]')).toHaveValue('Beta release');
    await saveEdit(page, { title: 'Beta renamed' });
    await expect(feedback).toContainText('Release saved, but Calendar could not refresh.');
    await expect(feedback).toHaveClass(/notice--error/);
    const retry = feedback.locator('[data-calendar-edit-refresh-retry]');
    await expect(retry).toBeVisible();
    await expect(agendaDay(`${MONTH}-20`)).toContainText('Beta release');
    await expect(region).not.toHaveAttribute('aria-busy', 'true');
    expect(page.url()).toBe(listUrl);
    expect(posts).toEqual([`/releases/${alpha.id}`, `/releases/${beta.id}`]);

    await page.unroute(isCalendar);
    await retry.click();
    await expect(agendaDay(`${MONTH}-20`)).toContainText('Beta renamed');
    await expect(feedback).toContainText('Release updated.');
    await expect(feedback).toHaveClass(/notice--success/);
    await expect(retry).toHaveCount(0);
    expect(posts).toHaveLength(2);
    expect(page.url()).toBe(listUrl);

    // Rapid edits: an older refresh cannot overwrite a newer one.
    let releaseFirst;
    const firstHeld = new Promise((resolve) => { releaseFirst = resolve; });
    let held = false;
    const holdFirst = async (route) => {
      if (held) return route.continue();
      held = true;
      await firstHeld;
      try { await route.continue(); } catch {}
    };
    await page.route(isCalendar, holdFirst);
    await clickCalendarEdit(page, 'agenda', beta.id);
    await expect(page.locator('#release-edit-form [name="title"]')).toHaveValue('Beta renamed');
    await saveEdit(page, { title: 'Beta first' });
    await clickCalendarEdit(page, 'agenda', beta.id);
    await expect(page.locator('#release-edit-form [name="title"]')).toHaveValue('Beta first');
    await saveEdit(page, { title: 'Beta second' });
    await expect(agendaDay(`${MONTH}-20`)).toContainText('Beta second');
    releaseFirst();
    await page.waitForTimeout(500);
    await expect(agendaDay(`${MONTH}-20`)).toContainText('Beta second');
    await page.unroute(isCalendar, holdFirst);
    expect(posts).toHaveLength(4);

    expect(await page.evaluate(() => window.__notReloaded)).toBe(true);
    expect(navigations).toEqual([]);
    expect(await duplicateIds(page)).toEqual([]);
    expect(errors).toEqual([]);
  });
});
