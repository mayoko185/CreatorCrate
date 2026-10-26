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

async function withRelease(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-detail-refresh-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    const { socialPrepSettingsService } = app.locals;
    const releaseService = createReleaseService({ db, socialPrepSettingsService, projectService: app.locals.projectService });
    const project = app.locals.projectService.create({ title: 'Detail refresh project' });
    socialPrepSettingsService.setPlatforms(['x', 'bluesky', 'patreon']);
    const release = createReleaseRepository(db).create({ projectId: project.id, title: 'Alpha release', description: '', notes: '' });
    releaseService.updateRelease(release.id, {
      title: 'Alpha release', description: 'Alpha description', notes: 'Alpha notes',
      plannedDate: '2031-07-10', plannedTime: '09:30', publishedDate: null,
      patreonUrl: 'https://example.com/alpha', selectedPlatforms: ['x', 'patreon'],
    });
    // Patreon stays selected on the release but is no longer configured.
    socialPrepSettingsService.setPlatforms(['x', 'bluesky']);
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    await run({ origin: `http://127.0.0.1:${server.address().port}`, release, releaseService, app, db });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function watchPage(page, releaseId) {
  const errors = [];
  const navigations = [];
  const posts = [];
  const refreshes = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) errors.push(message.text());
  });
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
  page.on('request', (request) => {
    const { pathname, searchParams } = new URL(request.url());
    // The test's own verification fetches are not refreshes.
    if (pathname !== `/releases/${releaseId}` || searchParams.has('verify')) return;
    if (request.method() === 'POST') posts.push(request);
    else if (request.resourceType() === 'fetch') refreshes.push(request);
  });
  return { errors, navigations, posts, refreshes };
}

async function duplicateIds(page) {
  return page.evaluate(() => {
    const ids = [...document.querySelectorAll('[id]')].map((element) => element.id);
    return ids.filter((id, index) => ids.indexOf(id) !== index);
  });
}

// Names of regions whose text differs from a fresh render of the page: the
// refreshed page must show exactly what the server renders now.
async function regionsMatchServer(page, releaseId) {
  return page.evaluate(async (id) => {
    const html = await (await fetch(`/releases/${id}?verify=1`, { cache: 'no-store' })).text();
    const fresh = new DOMParser().parseFromString(html, 'text/html');
    const text = (element) => element?.textContent.replace(/\s+/g, ' ').trim();
    return [...document.querySelectorAll('[data-release-detail-region]')]
      .map((region) => region.getAttribute('data-release-detail-region'))
      .filter((name) => text(document.querySelector(`[data-release-detail-region="${name}"]`))
        !== text(fresh.querySelector(`[data-release-detail-region="${name}"]`)));
  }, releaseId);
}

async function markDocument(page) {
  await page.evaluate(() => { window.__notReloaded = true; });
}

async function setPlatforms(form, wanted) {
  await form.locator('[data-dialog-field="selectedPlatforms"] summary').click();
  for (const input of await form.locator('input[name="selectedPlatforms"]').all()) {
    const value = await input.getAttribute('value');
    if ((await input.isChecked()) !== wanted.includes(value)) await input.locator('xpath=..').click();
  }
  await form.locator('[data-dialog-field="selectedPlatforms"] summary').click();
}

test('Release Detail refreshes in place after Edit Release saves', async ({ page }) => {
  test.setTimeout(120_000);
  await withRelease(async ({ origin, release, releaseService }) => {
    const { errors, navigations, posts, refreshes } = watchPage(page, release.id);
    const detailUrl = `${origin}/releases/${release.id}?view=list#release-social-preparation`;
    await page.setViewportSize({ width: 1280, height: 700 });
    await page.goto(detailUrl);
    navigations.length = 0;
    await markDocument(page);
    const trigger = page.locator(`[data-release-edit-id="${release.id}"]`);
    const dialog = page.locator('#release-edit-dialog');
    const form = page.locator('#release-edit-form');
    const details = page.locator('[data-release-detail-region="details"]');
    const heading = page.locator('.app-section-title');
    const publishAction = page.locator('[data-dialog-open="release-publish-dialog"]');

    await expect(publishAction).toHaveCount(1);
    await expect(page.locator('#release-publish-dialog')).toHaveCount(1);
    await expect(page.locator('#release-social-preparation')).toContainText('Currently disabled or not configured in Settings');

    // Cancel and validation errors never refresh.
    await trigger.click();
    await expect(form.locator('[name="title"]')).toHaveValue('Alpha release');
    await form.locator('[name="title"]').fill('Scratch');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await trigger.click();
    await form.locator('[name="patreonUrl"]').fill('not a url');
    await dialog.locator('footer [data-dialog-submit]').click();
    await expect(form.locator('[data-dialog-field="patreonUrl"] .field-error-message')).toBeVisible();
    expect(posts).toHaveLength(1);
    expect(refreshes).toHaveLength(0);

    // Basic metadata, schedule and platforms; Patreon stays selected while unconfigured.
    await form.locator('[name="title"]').fill('Renamed release');
    await form.locator('[name="description"]').fill('New description');
    await form.locator('[name="notes"]').fill('New notes');
    await form.locator('[name="patreonUrl"]').fill('https://example.com/renamed');
    await form.locator('[name="plannedDate"]').fill('2031-08-02');
    await form.locator('[name="plannedTime"]').fill('14:15');
    await setPlatforms(form, ['patreon', 'bluesky']);
    const scrollY = await page.evaluate(() => { window.scrollTo(0, 200); return window.scrollY; });
    await dialog.locator('footer [data-dialog-submit]').click();
    await expect(dialog).toBeHidden();
    await expect(heading).toHaveText('Releases — Renamed release');
    await expect(page).toHaveTitle(/Renamed release/);
    await expect(details).toContainText('2031-08-02');
    await expect(details.locator('a[href="https://example.com/renamed"]')).toHaveCount(1);
    await expect(page.locator('p.description')).toHaveText('New description');
    await expect(page.locator('p.notes')).toHaveText('New notes');
    const social = page.locator('#release-social-preparation');
    await expect(social.locator('#release-social-preparation-bluesky')).toHaveCount(1);
    await expect(social.locator('#release-social-preparation-patreon')).toHaveCount(1);
    expect(await regionsMatchServer(page, release.id)).toEqual([]);
    await expect(page.locator('#release-publish-dialog')).toContainText('Renamed release');
    await expect(page.locator('[data-dialog-feedback]')).toContainText('Release updated.');
    await expect(trigger).toBeFocused();
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);
    expect(posts).toHaveLength(2);
    expect(refreshes).toHaveLength(1);
    expect(new URL(refreshes[0].url()).search).toBe('?view=list');

    // Reopening loads the saved model, platforms included.
    await trigger.click();
    await expect(form.locator('[name="title"]')).toHaveValue('Renamed release');
    await expect(form.locator('[name="plannedTime"]')).toHaveValue('14:15');
    expect(await form.locator('input[name="selectedPlatforms"]:checked').evaluateAll((inputs) => inputs.map((input) => input.value)).then((values) => values.sort()))
      .toEqual(['bluesky', 'patreon']);

    // Publishing updates every publication indicator together.
    await form.locator('[name="publishedDate"]').fill('2031-08-03');
    await dialog.locator('footer [data-dialog-submit]').click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('.project-detail-info .status-badge--success')).toHaveText('Published');
    await expect(details).toContainText('2031-08-03');
    await expect(page.locator('.publication-summary-check-detail').last()).toHaveText('2031-08-03');
    await expect(page.locator('[data-release-detail-region="notices"]')).toContainText('This release is published.');
    await expect(publishAction).toHaveCount(0);
    await expect(page.locator('#release-publish-dialog')).toHaveCount(0);
    await expect(page.locator(`a[href="/releases/${release.id}/assets"]`)).toHaveCount(0);
    expect(await regionsMatchServer(page, release.id)).toEqual([]);
    await trigger.click();
    await expect(dialog.locator('[data-release-edit-action="archive"]')).toBeHidden();
    await expect(dialog.locator('[data-release-edit-action="delete"] form')).toHaveAttribute('action', `/releases/${release.id}/delete`);

    // Unpublishing restores them, Archive included, and the restored Review & Publish works.
    await form.locator('[name="publishedDate"]').fill('');
    await dialog.locator('footer [data-dialog-submit]').click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('.project-detail-info .status-badge--success')).toHaveCount(0);
    await expect(page.locator('.publication-summary-badge')).toHaveCount(0);
    await expect(page.locator('[data-release-detail-region="notices"]')).not.toContainText('This release is published.');
    await expect(page.locator(`a[href="/releases/${release.id}/assets"]`)).toHaveCount(1);
    await expect(publishAction).toHaveCount(1);
    expect(await regionsMatchServer(page, release.id)).toEqual([]);
    await publishAction.click();
    const publishDialog = page.locator('#release-publish-dialog');
    await expect(publishDialog).toBeVisible();
    await expect(publishDialog).toContainText('Renamed release');
    await publishDialog.locator('.date-picker-trigger').click();
    await expect(publishDialog.locator('[data-date-picker-panel]')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(publishDialog).toBeHidden();
    await trigger.click();
    await expect(form.locator('[name="publishedDate"]')).toHaveValue('');
    await expect(dialog.locator('[data-release-edit-action="archive"] form')).toHaveAttribute('action', `/releases/${release.id}/archive`);
    await expect(dialog.locator('[data-release-edit-action="archive"]')).toBeVisible();

    // Manage Signatures still opens from the dialog.
    await form.locator('button[aria-label="Manage signatures"]').click();
    await expect(page.locator('#release-signatures-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    expect(releaseService.findRelease(release.id)).toMatchObject({ title: 'Renamed release', published_date: null });
    expect(posts).toHaveLength(4);
    expect(refreshes).toHaveLength(3);
    expect(await page.locator('dialog#release-edit-dialog').count()).toBe(1);
    expect(await page.locator('dialog#release-publish-dialog').count()).toBe(1);
    expect(await page.locator('[data-release-detail-region]').count()).toBe(8);
    expect(await duplicateIds(page)).toEqual([]);
    expect(await page.evaluate(() => window.__notReloaded)).toBe(true);
    expect(navigations).toEqual([]);
    expect(page.url()).toBe(detailUrl);
    expect(errors).toEqual([]);
  });
});

test('A failed Release Detail refresh reports the saved release and retries with a GET only', async ({ page }) => {
  test.setTimeout(90_000);
  await withRelease(async ({ origin, release, releaseService }) => {
    const { errors, navigations, posts, refreshes } = watchPage(page, release.id);
    await page.goto(`${origin}/releases/${release.id}`);
    navigations.length = 0;
    await markDocument(page);
    const trigger = page.locator(`[data-release-edit-id="${release.id}"]`);
    const dialog = page.locator('#release-edit-dialog');
    const form = page.locator('#release-edit-form');
    const feedback = page.locator('[data-dialog-feedback]');

    let failRefresh = true;
    await page.route(`**/releases/${release.id}`, (route) => {
      const request = route.request();
      if (failRefresh && request.method() === 'GET' && request.resourceType() === 'fetch') return route.fulfill({ status: 500, body: 'Server error' });
      return route.continue();
    });

    await trigger.click();
    await expect(form.locator('[name="title"]')).toHaveValue('Alpha release');
    await form.locator('[name="title"]').fill('Saved anyway');
    await dialog.locator('footer [data-dialog-submit]').click();
    await expect(dialog).toBeHidden();
    await expect(feedback).toContainText('Release saved, but Release Detail could not refresh. The information shown may be out of date.');
    await expect(feedback).toHaveClass(/notice--error/);
    await expect(feedback).toHaveAttribute('role', 'status');
    expect(releaseService.findRelease(release.id).title).toBe('Saved anyway');
    await expect(page.locator('.app-section-title')).toHaveText('Releases — Alpha release');

    // The confirmed baseline survives the failed refresh.
    await trigger.click();
    await expect(form.locator('[name="title"]')).toHaveValue('Saved anyway');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    const retry = feedback.locator('[data-release-detail-refresh-retry]');
    await expect(retry).toHaveCount(1);
    failRefresh = false;
    await retry.focus();
    await retry.press('Enter');
    await expect(page.locator('.app-section-title')).toHaveText('Releases — Saved anyway');
    await expect(feedback).toContainText('Release updated.');
    await expect(feedback).not.toHaveClass(/notice--error/);
    await expect(feedback.locator('[data-release-detail-refresh-retry]')).toHaveCount(0);
    await expect(trigger).toBeFocused();

    expect(posts).toHaveLength(1);
    expect(refreshes).toHaveLength(2);
    expect(await page.evaluate(() => window.__notReloaded)).toBe(true);
    expect(navigations).toEqual([]);
    expect(await duplicateIds(page)).toEqual([]);
    expect(errors).toEqual([]);
  });
});

test('A ?edit=1 deep link refreshes in place without reopening the dialog', async ({ page }) => {
  test.setTimeout(60_000);
  await withRelease(async ({ origin, release }) => {
    const { errors, navigations, posts, refreshes } = watchPage(page, release.id);
    await page.goto(`${origin}/releases/${release.id}?edit=1`);
    navigations.length = 0;
    await markDocument(page);
    const dialog = page.locator('#release-edit-dialog');
    const form = page.locator('#release-edit-form');
    await expect(dialog).toBeVisible();
    const deepLinkUrl = page.url();
    await form.locator('[name="title"]').fill('Deep linked');
    await form.locator('[name="publishedDate"]').fill('2031-08-03');
    await dialog.locator('footer [data-dialog-submit]').click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('.app-section-title')).toHaveText('Releases — Deep linked');
    await expect(page.locator('.publication-summary-badge')).toHaveText('Published');
    await expect(page.locator('#release-publish-dialog')).toHaveCount(0);
    // Nothing reopens once the refresh settles.
    await page.waitForTimeout(300);
    await expect(dialog).toBeHidden();
    expect(new URL(refreshes[0].url()).searchParams.has('edit')).toBe(false);

    await page.locator(`[data-release-edit-id="${release.id}"]`).click();
    await expect(form.locator('[name="title"]')).toHaveValue('Deep linked');
    await expect(form.locator('[name="publishedDate"]')).toHaveValue('2031-08-03');
    await page.keyboard.press('Escape');

    expect(posts).toHaveLength(1);
    expect(refreshes).toHaveLength(1);
    expect(page.url()).toBe(deepLinkUrl);
    expect(await page.evaluate(() => window.__notReloaded)).toBe(true);
    expect(navigations).toEqual([]);
    expect(await duplicateIds(page)).toEqual([]);
    expect(errors).toEqual([]);
  });
});

test('A late refresh response never overwrites a newer saved release', async ({ page }) => {
  test.setTimeout(60_000);
  await withRelease(async ({ origin, release }) => {
    const { errors, navigations, posts } = watchPage(page, release.id);
    await page.goto(`${origin}/releases/${release.id}`);
    navigations.length = 0;
    const trigger = page.locator(`[data-release-edit-id="${release.id}"]`);
    const dialog = page.locator('#release-edit-dialog');
    const form = page.locator('#release-edit-form');

    // The first refresh renders now but is answered only after the second save.
    let releaseFirst;
    const firstHeld = new Promise((resolve) => { releaseFirst = resolve; });
    let held = 0;
    await page.route(`**/releases/${release.id}`, async (route) => {
      const request = route.request();
      if (request.method() !== 'GET' || request.resourceType() !== 'fetch' || held++ > 0) return route.continue();
      const response = await route.fetch();
      await firstHeld;
      // The superseded request was aborted by the page; fulfilling it is a no-op.
      await route.fulfill({ response }).catch(() => {});
    });

    await trigger.click();
    await expect(form.locator('[name="title"]')).toHaveValue('Alpha release');
    await form.locator('[name="title"]').fill('First save');
    await dialog.locator('footer [data-dialog-submit]').click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => held).toBe(1);

    await trigger.click();
    await expect(form.locator('[name="title"]')).toHaveValue('First save');
    await form.locator('[name="title"]').fill('Second save');
    await dialog.locator('footer [data-dialog-submit]').click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('.app-section-title')).toHaveText('Releases — Second save');

    releaseFirst();
    await page.waitForTimeout(500);
    await expect(page.locator('.app-section-title')).toHaveText('Releases — Second save');
    await expect(page.locator('[data-dialog-feedback]')).toContainText('Release updated.');
    expect(posts).toHaveLength(2);
    expect(navigations).toEqual([]);
    expect(errors).toEqual([]);
  });
});

// Holds Release Detail refresh GETs: each is rendered when it is sent but
// answered only when the test opens its gate (or fails it).
async function holdRefreshes(page, releaseId) {
  const gates = [];
  const control = {
    count: () => gates.length,
    answer: (index) => gates[index].resolve('answer'),
    fail: (index) => gates[index].resolve('fail'),
    passThrough: false,
  };
  await page.route(`**/releases/${releaseId}*`, async (route) => {
    const request = route.request();
    const { pathname, searchParams } = new URL(request.url());
    if (control.passThrough || pathname !== `/releases/${releaseId}` || searchParams.has('verify')
      || request.method() !== 'GET' || request.resourceType() !== 'fetch') return route.continue();
    let resolve;
    const gate = new Promise((done) => { resolve = done; });
    gates.push({ resolve });
    const response = await route.fetch();
    const decision = await gate;
    // A superseded request was aborted by the page; answering it is a no-op.
    if (decision === 'fail') await route.fulfill({ status: 500, body: 'Server error' }).catch(() => {});
    else await route.fulfill({ response }).catch(() => {});
  });
  return control;
}

const DEFERRED_TEXT = 'Release saved. Some Release Detail sections will refresh when the open dialog closes or the publishing companion request finishes.';

test('Review & Publish open during a refresh is kept, marked stale and reconciled when it closes', async ({ page }) => {
  test.setTimeout(120_000);
  await withRelease(async ({ origin, release }) => {
    const { errors, navigations, posts, refreshes } = watchPage(page, release.id);
    await page.goto(`${origin}/releases/${release.id}`);
    navigations.length = 0;
    await markDocument(page);
    const held = await holdRefreshes(page, release.id);
    const trigger = page.locator(`[data-release-edit-id="${release.id}"]`);
    const dialog = page.locator('#release-edit-dialog');
    const form = page.locator('#release-edit-form');
    const feedback = page.locator('[data-dialog-feedback]');
    const publishAction = page.locator('[data-dialog-open="release-publish-dialog"]');
    const publishDialog = page.locator('#release-publish-dialog');
    const publishRegion = page.locator('[data-release-detail-region="publish-dialog"]');

    // A title change while Review & Publish is open.
    await trigger.click();
    await form.locator('[name="title"]').fill('Renamed meanwhile');
    await dialog.locator('footer [data-dialog-submit]').click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => held.count()).toBe(1);
    await publishAction.click();
    await expect(publishDialog).toBeVisible();
    await publishDialog.locator('[name="publishedDate"]').fill('2031-09-09');
    held.answer(0);
    await expect(page.locator('.app-section-title')).toHaveText('Releases — Renamed meanwhile');
    // The open dialog and its input survive, but it is not presented as current.
    await expect(publishDialog).toBeVisible();
    await expect(publishDialog).toContainText('Alpha release');
    await expect(publishDialog.locator('[name="publishedDate"]')).toHaveValue('2031-09-09');
    await expect(publishRegion).toHaveAttribute('data-release-detail-stale', '');
    await expect(publishDialog.locator('[data-dialog-submit]')).toBeDisabled();
    await expect(publishDialog.locator('[data-dialog-status]')).toHaveText('This release has changed. Close this dialog to load its current details.');
    await expect(feedback).toContainText(DEFERRED_TEXT);
    await expect(feedback).not.toContainText('Release updated.');
    await expect(feedback).not.toHaveClass(/notice--success/);
    expect(refreshes).toHaveLength(1);

    // Closing it fetches Release Detail again; reopening shows the saved release.
    await page.keyboard.press('Escape');
    await expect(publishDialog).toBeHidden();
    await expect.poll(() => held.count()).toBe(2);
    held.answer(1);
    await expect(feedback).toContainText('Release updated.');
    await expect(page.locator('[data-release-detail-stale]')).toHaveCount(0);
    await publishAction.click();
    await expect(publishDialog).toBeVisible();
    await expect(publishDialog).toContainText('Renamed meanwhile');
    await expect(publishDialog.locator('[data-dialog-submit]')).toBeEnabled();
    await expect(publishDialog.locator('[data-dialog-status]')).toHaveText('');
    await page.keyboard.press('Escape');
    await expect(publishDialog).toBeHidden();
    expect(refreshes).toHaveLength(2);

    // Publishing while Review & Publish is open: its Publish action must go.
    await trigger.click();
    await form.locator('[name="title"]').fill('Published meanwhile');
    await form.locator('[name="publishedDate"]').fill('2031-08-03');
    await dialog.locator('footer [data-dialog-submit]').click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => held.count()).toBe(3);
    await publishAction.click();
    await expect(publishDialog).toBeVisible();
    held.answer(2);
    await expect(page.locator('.publication-summary-badge')).toHaveText('Published');
    await expect(publishAction).toHaveCount(0);
    await expect(publishDialog).toBeVisible();
    await expect(publishDialog.locator('[data-dialog-submit]')).toBeDisabled();
    await expect(feedback).toContainText(DEFERRED_TEXT);
    await page.keyboard.press('Escape');
    await expect.poll(() => held.count()).toBe(4);
    held.answer(3);
    await expect(publishDialog).toHaveCount(0);
    await expect(feedback).toContainText('Release updated.');
    held.passThrough = true;
    expect(await regionsMatchServer(page, release.id)).toEqual([]);

    expect(posts).toHaveLength(2);
    expect(refreshes).toHaveLength(4);
    expect(refreshes.every((request) => request.method() === 'GET')).toBe(true);
    expect(await page.locator('[data-release-detail-region]').count()).toBe(8);
    expect(await duplicateIds(page)).toEqual([]);
    expect(await page.evaluate(() => window.__notReloaded)).toBe(true);
    expect(navigations).toEqual([]);
    expect(errors).toEqual([]);
  });
});

test('A companion request in flight during a refresh reconciles Social Posts once it settles', async ({ page }) => {
  test.setTimeout(120_000);
  await withRelease(async ({ origin, release, releaseService, app }) => {
    app.locals.socialPrepSettingsService.setEnabled(true);
    releaseService.updateRelease(release.id, {
      title: 'Alpha release', description: 'Alpha description', notes: 'Alpha notes',
      plannedDate: '2031-07-10', plannedTime: '09:30', publishedDate: '2031-07-11',
      patreonUrl: 'https://example.com/alpha', selectedPlatforms: ['x'],
    });
    const { errors, navigations, posts, refreshes } = watchPage(page, release.id);
    const activations = [];
    let settleActivation;
    const activationHeld = new Promise((resolve) => { settleActivation = resolve; });
    await page.route(`**/releases/${release.id}/social-prep/**`, async (route) => {
      activations.push(route.request().method());
      await activationHeld;
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{"ok":false}' });
    });
    await page.goto(`${origin}/releases/${release.id}`);
    navigations.length = 0;
    await markDocument(page);
    const social = page.locator('[data-release-detail-region="social-preparation"]');
    const companion = social.locator('[data-release-social-prep-companion-action]');
    await expect(companion).toHaveText('Open publishing companion');
    const feedback = page.locator('[data-dialog-feedback]');
    const dialog = page.locator('#release-edit-dialog');
    const form = page.locator('#release-edit-form');

    await companion.click();
    await expect(companion).toBeDisabled();
    await expect(social.locator('[data-release-social-prep-companion-status]')).toHaveText('Opening publishing companion…');

    // Unpublishing removes the companion from a fresh render.
    await page.locator(`[data-release-edit-id="${release.id}"]`).click();
    await form.locator('[name="publishedDate"]').fill('');
    await dialog.locator('footer [data-dialog-submit]').click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('[data-release-detail-region="notices"]')).not.toContainText('This release is published.');
    await expect(feedback).toContainText(DEFERRED_TEXT);
    await expect(social).toHaveAttribute('data-release-detail-stale', '');
    await expect(companion).toBeDisabled();
    await expect(social.locator('[data-release-social-prep-companion-status]')).toHaveText('Opening publishing companion…');
    expect(refreshes).toHaveLength(1);

    settleActivation();
    await expect(page.locator('[data-release-social-prep-companion-action]')).toHaveCount(0);
    await expect(feedback).toContainText('Release updated.');
    await expect(page.locator('[data-release-detail-stale]')).toHaveCount(0);
    expect(await regionsMatchServer(page, release.id)).toEqual([]);
    await page.waitForTimeout(300);

    expect(activations).toEqual(['POST']);
    expect(posts).toHaveLength(1);
    expect(refreshes).toHaveLength(2);
    expect(await duplicateIds(page)).toEqual([]);
    expect(await page.evaluate(() => window.__notReloaded)).toBe(true);
    expect(navigations).toEqual([]);
    expect(errors).toEqual([]);
  });
});

// A published release offering the companion, whose activation POST is held
// until the test settles it with a valid, successful activation response.
async function holdSuccessfulActivation(page, { origin, release, releaseService, app }) {
  app.locals.socialPrepSettingsService.setEnabled(true);
  releaseService.updateRelease(release.id, {
    title: 'Alpha release', description: 'Alpha description', notes: 'Alpha notes',
    plannedDate: '2031-07-10', plannedTime: '09:30', publishedDate: '2031-07-11',
    patreonUrl: 'https://example.com/alpha', selectedPlatforms: ['x'],
  });
  const activations = [];
  let settle;
  const held = new Promise((resolve) => { settle = resolve; });
  await page.route(`**/releases/${release.id}/social-prep/**`, async (route) => {
    activations.push(route.request().method());
    await held;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        sessionId: '11111111-1111-4111-8111-111111111111',
        uri: `creatorcrate-social://prepare?v=2&server=${encodeURIComponent(origin)}&intent=${'A'.repeat(43)}`,
        platforms: ['x'],
      }),
    });
  });
  return { activations, settle };
}

test('A companion request that succeeds while Social Posts is stale reconciles it', async ({ page }) => {
  test.setTimeout(120_000);
  await withRelease(async (context) => {
    const { origin, release } = context;
    const { activations, settle } = await holdSuccessfulActivation(page, context);
    const { errors, navigations, posts, refreshes } = watchPage(page, release.id);
    await page.goto(`${origin}/releases/${release.id}`);
    navigations.length = 0;
    await markDocument(page);
    const social = page.locator('[data-release-detail-region="social-preparation"]');
    const companion = social.locator('[data-release-social-prep-companion-action]');
    const feedback = page.locator('[data-dialog-feedback]');
    const dialog = page.locator('#release-edit-dialog');
    const form = page.locator('#release-edit-form');

    await companion.click();
    await expect(companion).toBeDisabled();

    // Unpublishing removes the companion from a fresh render.
    await page.locator(`[data-release-edit-id="${release.id}"]`).click();
    await form.locator('[name="publishedDate"]').fill('');
    await dialog.locator('footer [data-dialog-submit]').click();
    await expect(dialog).toBeHidden();
    await expect(feedback).toContainText(DEFERRED_TEXT);
    await expect(social).toHaveAttribute('data-release-detail-stale', '');
    expect(refreshes).toHaveLength(1);

    // The request succeeds: its status stays a status, but it is no longer active.
    settle();
    await expect(page.locator('[data-release-social-prep-companion-action]')).toHaveCount(0);
    await expect(feedback).toContainText('Release updated.');
    await expect(feedback).toHaveClass(/notice--success/);
    await expect(page.locator('[data-release-detail-stale]')).toHaveCount(0);
    expect(await regionsMatchServer(page, release.id)).toEqual([]);
    await page.waitForTimeout(300);

    expect(activations).toEqual(['POST']);
    expect(posts).toHaveLength(1);
    expect(refreshes).toHaveLength(2);
    expect(await duplicateIds(page)).toEqual([]);
    expect(await page.evaluate(() => window.__notReloaded)).toBe(true);
    expect(navigations).toEqual([]);
    expect(errors).toEqual([]);
  });
});

test('A companion request that succeeds while a newer refresh is pending is adopted by that refresh', async ({ page }) => {
  test.setTimeout(120_000);
  await withRelease(async (context) => {
    const { origin, release } = context;
    const { activations, settle } = await holdSuccessfulActivation(page, context);
    const { errors, navigations, posts, refreshes } = watchPage(page, release.id);
    await page.goto(`${origin}/releases/${release.id}`);
    navigations.length = 0;
    await markDocument(page);
    const held = await holdRefreshes(page, release.id);
    const social = page.locator('[data-release-detail-region="social-preparation"]');
    const companion = social.locator('[data-release-social-prep-companion-action]');
    const feedback = page.locator('[data-dialog-feedback]');
    const heading = page.locator('.app-section-title');
    const dialog = page.locator('#release-edit-dialog');
    const form = page.locator('#release-edit-form');
    const save = async (fill, gateCount) => {
      await page.locator(`[data-release-edit-id="${release.id}"]`).click();
      await fill();
      await dialog.locator('footer [data-dialog-submit]').click();
      await expect(dialog).toBeHidden();
      await expect.poll(() => held.count()).toBe(gateCount);
    };

    await companion.click();
    await expect(companion).toBeDisabled();
    await save(() => form.locator('[name="publishedDate"]').fill(''), 1);
    held.answer(0);
    await expect(feedback).toContainText(DEFERRED_TEXT);
    await expect(social).toHaveAttribute('data-release-detail-stale', '');

    // Two newer saves: the second supersedes the first's refresh.
    await save(() => form.locator('[name="title"]').fill('Second save'), 2);
    await save(() => form.locator('[name="title"]').fill('Third save'), 3);

    // The companion succeeds while the newest refresh is still pending.
    settle();
    await expect(companion).toHaveText('Retry opening companion');
    await expect(companion).toBeDisabled();
    await page.waitForTimeout(200);
    expect(held.count()).toBe(3);

    held.answer(2);
    await expect(heading).toHaveText('Releases — Third save');
    await expect(page.locator('[data-release-social-prep-companion-action]')).toHaveCount(0);
    await expect(feedback).toContainText('Release updated.');
    await expect(page.locator('[data-release-detail-stale]')).toHaveCount(0);
    // The superseded response cannot replace the newer state.
    held.answer(1);
    await page.waitForTimeout(500);
    await expect(heading).toHaveText('Releases — Third save');
    await expect(feedback).toContainText('Release updated.');
    expect(held.count()).toBe(3);
    held.passThrough = true;
    expect(await regionsMatchServer(page, release.id)).toEqual([]);

    expect(activations).toEqual(['POST']);
    expect(posts).toHaveLength(3);
    expect(refreshes).toHaveLength(3);
    expect(refreshes.every((request) => request.method() === 'GET')).toBe(true);
    expect(await duplicateIds(page)).toEqual([]);
    expect(await page.evaluate(() => window.__notReloaded)).toBe(true);
    expect(navigations).toEqual([]);
    expect(errors).toEqual([]);
  });
});

test('A failed deferred reconciliation reports stale data, retries with a GET, and never overwrites a newer save', async ({ page }) => {
  test.setTimeout(120_000);
  await withRelease(async ({ origin, release }) => {
    const { errors, navigations, posts, refreshes } = watchPage(page, release.id);
    await page.goto(`${origin}/releases/${release.id}`);
    navigations.length = 0;
    await markDocument(page);
    const held = await holdRefreshes(page, release.id);
    const trigger = page.locator(`[data-release-edit-id="${release.id}"]`);
    const dialog = page.locator('#release-edit-dialog');
    const form = page.locator('#release-edit-form');
    const feedback = page.locator('[data-dialog-feedback]');
    const heading = page.locator('.app-section-title');
    const publishAction = page.locator('[data-dialog-open="release-publish-dialog"]');
    const publishDialog = page.locator('#release-publish-dialog');

    const save = async (title, gateCount) => {
      await trigger.click();
      await form.locator('[name="title"]').fill(title);
      await dialog.locator('footer [data-dialog-submit]').click();
      await expect(dialog).toBeHidden();
      await expect.poll(() => held.count()).toBe(gateCount);
    };

    // The reconciliation after the dialog closes fails.
    await save('First save', 1);
    await publishAction.click();
    await expect(publishDialog).toBeVisible();
    held.answer(0);
    await expect(feedback).toContainText(DEFERRED_TEXT);
    await page.keyboard.press('Escape');
    await expect.poll(() => held.count()).toBe(2);
    held.fail(1);
    await expect(feedback).toContainText('Release saved, but Release Detail could not refresh. The information shown may be out of date.');
    await expect(feedback).toHaveClass(/notice--error/);
    await expect(page.locator('[data-release-detail-region="publish-dialog"]')).toHaveAttribute('data-release-detail-stale', '');
    await publishAction.click();
    await expect(publishDialog.locator('[data-dialog-submit]')).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(publishDialog).toBeHidden();
    // A dialog closing again does not start an unrequested refresh.
    await page.waitForTimeout(200);
    expect(held.count()).toBe(2);

    const retry = feedback.locator('[data-release-detail-refresh-retry]');
    await expect(retry).toHaveCount(1);
    await retry.click();
    await expect.poll(() => held.count()).toBe(3);
    held.answer(2);
    await expect(feedback).toContainText('Release updated.');
    await expect(feedback).not.toHaveClass(/notice--error/);
    await expect(page.locator('[data-release-detail-stale]')).toHaveCount(0);
    await expect(publishDialog).toContainText('First save');

    // A reconciliation still in flight when a newer save lands is superseded.
    await save('Second save', 4);
    await publishAction.click();
    await expect(publishDialog).toBeVisible();
    held.answer(3);
    await expect(feedback).toContainText(DEFERRED_TEXT);
    await page.keyboard.press('Escape');
    await expect.poll(() => held.count()).toBe(5);
    await save('Third save', 6);
    held.answer(5);
    await expect(heading).toHaveText('Releases — Third save');
    held.answer(4);
    await page.waitForTimeout(500);
    await expect(heading).toHaveText('Releases — Third save');
    await expect(publishDialog).toContainText('Third save');
    await expect(feedback).toContainText('Release updated.');
    held.passThrough = true;
    expect(await regionsMatchServer(page, release.id)).toEqual([]);

    expect(posts).toHaveLength(3);
    expect(refreshes.every((request) => request.method() === 'GET')).toBe(true);
    expect(await page.locator('[data-release-detail-region]').count()).toBe(8);
    expect(await duplicateIds(page)).toEqual([]);
    expect(await page.evaluate(() => window.__notReloaded)).toBe(true);
    expect(navigations).toEqual([]);
    expect(errors).toEqual([]);
  });
});

// ─── Returning from the Posting Helper ──────────────────────────────────

// The page cannot really lose focus to a native app under test, so leaving and
// returning dispatch the window and document events a browser would.
async function leavePage(page) {
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
}

async function returnToPage(page) {
  // One return announces itself through both focus and visibilitychange.
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

// What the Posting Helper does through its capability-protected PATCH.
function helperSavesLink({ releaseService, release }, releaseLink, expectedReleaseLink = 'https://example.com/alpha') {
  return releaseService.updateReleaseLink(release.id, { releaseLink, expectedReleaseLink });
}

async function launchCompanion(page, context) {
  const { activations, settle } = await holdSuccessfulActivation(page, context);
  settle();
  return activations;
}

const RETURN_FAILED_TEXT = 'Release Detail could not check for changes made in the Posting Helper.';
const CHECKING_TEXT = 'Checking whether the Release link changed in the Posting Helper…';

test('Returning from a launched Posting Helper refreshes Release Detail once per return, GET only', async ({ page }) => {
  test.setTimeout(120_000);
  await withRelease(async (context) => {
    const { origin, release, db } = context;
    const activations = await launchCompanion(page, context);
    const { errors, navigations, posts, refreshes } = watchPage(page, release.id);
    await page.goto(`${origin}/releases/${release.id}`);
    navigations.length = 0;
    await markDocument(page);
    const details = page.locator('[data-release-detail-region="details"]');
    const social = page.locator('[data-release-detail-region="social-preparation"]');
    const companion = page.locator('[data-release-social-prep-companion-action]').first();
    const feedback = page.locator('[data-dialog-feedback]');

    // Nothing is armed before a launch attempt.
    await leavePage(page);
    await returnToPage(page);
    await page.waitForTimeout(300);
    expect(refreshes).toHaveLength(0);

    await companion.click();
    await expect(companion).toHaveText('Retry opening companion');
    expect(activations).toEqual(['POST']);
    await expect(details).not.toContainText('https://example.com/helper');

    // The helper saves the link and records a posted platform meanwhile.
    await leavePage(page);
    helperSavesLink(context, 'https://example.com/helper');
    db.prepare(`UPDATE release_social_platforms SET status = 'posted', posted_at = datetime('now')
      WHERE release_id = ? AND platform = 'x'`).run(release.id);
    await returnToPage(page);
    await expect(details).toContainText('https://example.com/helper');
    await expect(details).toHaveAttribute('data-release-link', 'https://example.com/helper');
    await expect(social).toContainText('1 of 1 platforms marked as posted.');
    await page.waitForTimeout(300);
    expect(refreshes).toHaveLength(1);
    // A refresh is no save: no success notice, no POST.
    await expect(feedback).toBeHidden();
    expect(await regionsMatchServer(page, release.id)).toEqual([]);

    // An unchanged return keeps the same content and stays quiet.
    await leavePage(page);
    await returnToPage(page);
    await expect.poll(() => refreshes.length).toBe(2);
    await expect(details).toHaveAttribute('data-release-link', 'https://example.com/helper');
    await expect(feedback).toBeHidden();

    // Returning again without leaving first is not a return.
    await returnToPage(page);
    await page.waitForTimeout(300);
    expect(refreshes).toHaveLength(2);

    // A repeated launch reuses the same listeners: still one refresh per return.
    await page.locator('[data-release-social-prep-companion-action]').first().click();
    await expect.poll(() => activations.length).toBe(2);
    await leavePage(page);
    await returnToPage(page);
    await expect.poll(() => refreshes.length).toBe(3);
    await page.waitForTimeout(300);
    expect(refreshes).toHaveLength(3);

    // Returns never relaunch, prepare or post anything.
    expect(activations).toHaveLength(2);
    expect(posts).toHaveLength(0);
    expect(refreshes.every((request) => request.method() === 'GET')).toBe(true);
    expect(await duplicateIds(page)).toEqual([]);
    expect(await page.evaluate(() => window.__notReloaded)).toBe(true);
    expect(navigations).toEqual([]);
    expect(errors).toEqual([]);
  });
});

test('A failed companion launch arms no return refresh', async ({ page }) => {
  test.setTimeout(120_000);
  await withRelease(async (context) => {
    const { origin, release, app, releaseService } = context;
    app.locals.socialPrepSettingsService.setEnabled(true);
    releaseService.updateRelease(release.id, {
      title: 'Alpha release', description: 'Alpha description', notes: 'Alpha notes',
      plannedDate: '2031-07-10', plannedTime: '09:30', publishedDate: '2031-07-11',
      patreonUrl: 'https://example.com/alpha', selectedPlatforms: ['x'],
    });
    await page.route(`**/releases/${release.id}/social-prep/**`, (route) => route.fulfill({
      status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false }),
    }));
    const { errors, refreshes } = watchPage(page, release.id);
    await page.goto(`${origin}/releases/${release.id}`);
    const status = page.locator('[data-release-social-prep-companion-status]').first();
    await page.locator('[data-release-social-prep-companion-action]').first().click();
    await expect(status).toHaveText('Could not open publishing companion.');
    await leavePage(page);
    await returnToPage(page);
    await page.waitForTimeout(300);
    expect(refreshes).toHaveLength(0);
    await expect(status).toHaveText('Could not open publishing companion.');
    expect(errors).toEqual([]);
  });
});

test('An open Edit Release draft survives a return refresh and cannot save over a helper-saved link', async ({ page }) => {
  test.setTimeout(120_000);
  await withRelease(async (context) => {
    const { origin, release, releaseService } = context;
    await launchCompanion(page, context);
    const { errors, navigations, posts, refreshes } = watchPage(page, release.id);
    await page.goto(`${origin}/releases/${release.id}`);
    navigations.length = 0;
    await markDocument(page);
    const dialog = page.locator('#release-edit-dialog');
    const form = page.locator('#release-edit-form');
    const conflict = form.locator('[data-release-edit-link-conflict]');
    const resolve = conflict.locator('[data-release-edit-link-conflict-resolve]');
    const status = dialog.locator('[data-dialog-status]');
    const save = dialog.locator('footer [data-dialog-submit]');
    const companion = page.locator('[data-release-social-prep-companion-action]').first();

    await companion.click();
    await expect(companion).toHaveText('Retry opening companion');
    await page.locator(`[data-release-edit-id="${release.id}"]`).click();
    await expect(form.locator('[name="patreonUrl"]')).toHaveValue('https://example.com/alpha');
    await form.locator('[name="title"]').fill('Draft title');
    await form.locator('[name="notes"]').fill('Draft notes');

    await leavePage(page);
    helperSavesLink(context, 'https://example.com/helper');
    await returnToPage(page);
    await expect(conflict).toBeVisible();
    await expect(conflict).toHaveAttribute('role', 'alert');
    await expect(conflict).toContainText('It is now https://example.com/helper.');
    await expect(conflict).toContainText('keeps your other unsaved changes');
    // The draft is untouched by the background refresh.
    await expect(dialog).toBeVisible();
    await expect(form.locator('[name="title"]')).toHaveValue('Draft title');
    await expect(form.locator('[name="notes"]')).toHaveValue('Draft notes');
    await expect(form.locator('[name="patreonUrl"]')).toHaveValue('https://example.com/alpha');
    await expect(page.locator('[data-release-detail-region="details"]')).toContainText('https://example.com/helper');

    // Neither the Save button nor implicit submission can send the stale link.
    await save.click();
    await expect(status).toContainText('Not saved. The saved Release link changed');
    await expect(resolve).toBeFocused();
    await form.locator('[name="title"]').press('Enter');
    await page.waitForTimeout(300);
    expect(posts).toHaveLength(0);
    expect(releaseService.findRelease(release.id).patreon_url).toBe('https://example.com/helper');

    // Explicit resolution adopts the saved link and keeps the rest of the draft.
    await resolve.click();
    await expect(conflict).toBeHidden();
    await expect(form.locator('[name="patreonUrl"]')).toHaveValue('https://example.com/helper');
    await expect(form.locator('[name="patreonUrl"]')).toBeFocused();
    await expect(form.locator('[name="title"]')).toHaveValue('Draft title');
    await expect(status).toContainText('The form now uses the saved Release link.');
    await save.click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('[data-dialog-feedback]')).toContainText('Release updated.');
    expect(posts).toHaveLength(1);
    const saved = releaseService.findRelease(release.id);
    expect(saved.patreon_url).toBe('https://example.com/helper');
    expect(saved.title).toBe('Draft title');
    expect(saved.notes).toBe('Draft notes');

    // A later dialog opens current and unflagged.
    await page.locator(`[data-release-edit-id="${release.id}"]`).click();
    await expect(form.locator('[name="patreonUrl"]')).toHaveValue('https://example.com/helper');
    await expect(conflict).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    expect(refreshes.every((request) => request.method() === 'GET')).toBe(true);
    expect(await duplicateIds(page)).toEqual([]);
    expect(await page.evaluate(() => window.__notReloaded)).toBe(true);
    expect(navigations).toEqual([]);
    expect(errors).toEqual([]);
  });
});

test('A save made while a return refresh is in flight waits for it, and continues only when the link is unchanged', async ({ page }) => {
  test.setTimeout(120_000);
  await withRelease(async (context) => {
    const { origin, release, releaseService } = context;
    await launchCompanion(page, context);
    const { errors, posts } = watchPage(page, release.id);
    await page.goto(`${origin}/releases/${release.id}`);
    const companion = page.locator('[data-release-social-prep-companion-action]').first();
    await companion.click();
    await expect(companion).toHaveText('Retry opening companion');
    const held = await holdRefreshes(page, release.id);
    const dialog = page.locator('#release-edit-dialog');
    const form = page.locator('#release-edit-form');
    const conflict = form.locator('[data-release-edit-link-conflict]');
    const status = dialog.locator('[data-dialog-status]');
    const save = dialog.locator('footer [data-dialog-submit]');

    await page.locator(`[data-release-edit-id="${release.id}"]`).click();
    await expect(form.locator('[name="patreonUrl"]')).toHaveValue('https://example.com/alpha');
    await form.locator('[name="title"]').fill('Raced title');

    // The stale save is attempted before the return refresh answers.
    await leavePage(page);
    helperSavesLink(context, 'https://example.com/helper');
    await returnToPage(page);
    await expect.poll(() => held.count()).toBe(1);
    await save.click();
    await expect(status).toHaveText(CHECKING_TEXT);
    await page.waitForTimeout(300);
    expect(posts).toHaveLength(0);
    held.answer(0);
    await expect(conflict).toBeVisible();
    await expect(status).toContainText('Not saved. The saved Release link changed');
    await page.waitForTimeout(300);
    expect(posts).toHaveLength(0);
    expect(releaseService.findRelease(release.id).patreon_url).toBe('https://example.com/helper');

    // Resolved, then another return with no change: the held save goes through.
    await conflict.locator('[data-release-edit-link-conflict-resolve]').click();
    await leavePage(page);
    await returnToPage(page);
    await expect.poll(() => held.count()).toBe(2);
    await save.click();
    await expect(status).toHaveText(CHECKING_TEXT);
    expect(posts).toHaveLength(0);
    held.passThrough = true;
    held.answer(1);
    await expect(dialog).toBeHidden();
    expect(posts).toHaveLength(1);
    const saved = releaseService.findRelease(release.id);
    expect(saved.patreon_url).toBe('https://example.com/helper');
    expect(saved.title).toBe('Raced title');
    expect(errors).toEqual([]);
  });
});

test('A failed or signed-out return refresh keeps the draft, reports it and retries with a GET only', async ({ page }) => {
  test.setTimeout(120_000);
  await withRelease(async (context) => {
    const { origin, release } = context;
    await launchCompanion(page, context);
    const { errors, navigations, posts, refreshes } = watchPage(page, release.id);
    await page.goto(`${origin}/releases/${release.id}`);
    navigations.length = 0;
    await markDocument(page);
    const companion = page.locator('[data-release-social-prep-companion-action]').first();
    await companion.click();
    await expect(companion).toHaveText('Retry opening companion');
    const held = await holdRefreshes(page, release.id);
    const dialog = page.locator('#release-edit-dialog');
    const form = page.locator('#release-edit-form');
    const feedback = page.locator('[data-dialog-feedback]');
    const retry = page.locator('[data-release-detail-refresh-retry]');

    await page.locator(`[data-release-edit-id="${release.id}"]`).click();
    await form.locator('[name="title"]').fill('Kept draft');
    await leavePage(page);
    await returnToPage(page);
    await expect.poll(() => held.count()).toBe(1);
    held.fail(0);
    await expect(feedback).toContainText(RETURN_FAILED_TEXT);
    await expect(feedback).toHaveClass(/notice--error/);
    await expect(dialog).toBeVisible();
    await expect(form.locator('[name="title"]')).toHaveValue('Kept draft');

    // The form cannot be shown to be current, so saving stays blocked.
    const notice = form.locator('[data-release-edit-link-conflict]');
    const recheck = notice.locator('[data-release-edit-link-recheck]');
    const status = dialog.locator('[data-dialog-status]');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Saving is paused until it is checked');
    await expect(notice.locator('[data-release-edit-link-conflict-resolve]')).toBeHidden();
    await dialog.locator('footer [data-dialog-submit]').click();
    await expect(status).toContainText('Not saved. Could not check whether the Release link changed');
    await expect(recheck).toBeFocused();
    await form.locator('[name="title"]').press('Enter');
    await page.waitForTimeout(300);
    expect(posts).toHaveLength(0);

    // A failed recheck keeps it blocked; a working one releases it.
    let failEdit = true;
    await page.route(`**/releases/${release.id}/edit`, (route) => (failEdit ? route.abort() : route.continue()));
    await recheck.click();
    await expect(status).toContainText('Not saved. Could not check');
    await expect(notice).toBeVisible();
    failEdit = false;
    await recheck.click();
    await expect(notice).toBeHidden();
    await expect(form.locator('[name="title"]')).toHaveValue('Kept draft');
    await page.unroute(`**/releases/${release.id}/edit`);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // Retry is a GET; once it works the failure notice is withdrawn.
    await retry.click();
    await expect.poll(() => held.count()).toBe(2);
    held.answer(1);
    await expect(feedback).toBeHidden();
    await expect(page.locator('#main-content')).toBeFocused();

    // An expired sign-in says so instead of reporting a generic failure.
    held.passThrough = true;
    await page.route(`**/releases/${release.id}`, (route) => (route.request().resourceType() === 'fetch'
      ? route.fulfill({ status: 401, contentType: 'application/json', body: '{"status":"error"}' })
      : route.continue()));
    await leavePage(page);
    await returnToPage(page);
    await expect(feedback).toContainText('Your CreatorCrate sign-in has expired');
    await expect(retry).toBeVisible();

    expect(posts).toHaveLength(0);
    expect(refreshes.every((request) => request.method() === 'GET')).toBe(true);
    expect(await page.evaluate(() => window.__notReloaded)).toBe(true);
    expect(navigations).toEqual([]);
    expect(errors).toEqual([]);
  });
});

test('A save sent after the helper changed the link is refused by the server and keeps the whole draft', async ({ page }) => {
  test.setTimeout(120_000);
  await withRelease(async (context) => {
    const { origin, release, releaseService } = context;
    const { errors, navigations, posts } = watchPage(page, release.id);
    await page.goto(`${origin}/releases/${release.id}`);
    navigations.length = 0;
    await markDocument(page);
    const dialog = page.locator('#release-edit-dialog');
    const form = page.locator('#release-edit-form');
    const conflict = form.locator('[data-release-edit-link-conflict]');
    const resolve = conflict.locator('[data-release-edit-link-conflict-resolve]');
    const status = dialog.locator('[data-dialog-status]');
    const save = dialog.locator('footer [data-dialog-submit]');
    const link = form.locator('[name="patreonUrl"]');
    const expected = form.locator('[name="expectedPatreonUrl"]');
    const sentToken = (request) => new URLSearchParams(request.postData()).get('expectedPatreonUrl');

    await page.locator(`[data-release-edit-id="${release.id}"]`).click();
    await expect(link).toHaveValue('https://example.com/alpha');
    await expect(expected).toHaveValue('https://example.com/alpha');
    await form.locator('[name="title"]').fill('Draft title');
    await form.locator('[name="notes"]').fill('Draft notes');
    await link.fill('https://example.com/typed');
    // Editing the link never moves the baseline.
    await expect(expected).toHaveValue('https://example.com/alpha');

    // No return refresh runs: only the server can catch this one.
    helperSavesLink(context, 'https://example.com/helper');
    await save.click();
    await expect(conflict).toBeVisible();
    expect(posts).toHaveLength(1);
    expect(sentToken(posts[0])).toBe('https://example.com/alpha');
    await expect(conflict).toContainText('It is now https://example.com/helper.');
    await expect(conflict).toContainText('replaces the link you entered');
    await expect(status).toContainText('Not saved. The saved Release link changed');
    await expect(resolve).toBeFocused();
    await expect(dialog).toBeVisible();
    await expect(form.locator('[name="title"]')).toHaveValue('Draft title');
    await expect(form.locator('[name="notes"]')).toHaveValue('Draft notes');
    await expect(link).toHaveValue('https://example.com/typed');
    await expect(expected).toHaveValue('https://example.com/alpha');
    let stored = releaseService.findRelease(release.id);
    expect(stored.patreon_url).toBe('https://example.com/helper');
    expect(stored.title).toBe('Alpha release');
    expect(stored.notes).toBe('Alpha notes');

    // Neither Save nor Enter resends the stale form.
    await save.click();
    await form.locator('[name="title"]').press('Enter');
    await page.waitForTimeout(300);
    expect(posts).toHaveLength(1);

    // Explicit resolution adopts the saved link and advances the baseline.
    await resolve.click();
    await expect(conflict).toBeHidden();
    await expect(link).toHaveValue('https://example.com/helper');
    await expect(expected).toHaveValue('https://example.com/helper');
    await expect(form.locator('[name="title"]')).toHaveValue('Draft title');
    await save.click();
    await expect(dialog).toBeHidden();
    expect(posts).toHaveLength(2);
    expect(sentToken(posts[1])).toBe('https://example.com/helper');
    stored = releaseService.findRelease(release.id);
    expect(stored.patreon_url).toBe('https://example.com/helper');
    expect(stored.title).toBe('Draft title');
    expect(stored.notes).toBe('Draft notes');
    expect(navigations).toEqual([]);
    expect(errors).toEqual([]);
  });
});
