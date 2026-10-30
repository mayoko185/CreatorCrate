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

async function withRelease(run, { platforms = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-publish-dialog-'));
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
    const project = app.locals.projectService.create({ title: 'Publish dialog project' });
    if (platforms.length > 0) {
      socialPrepSettingsService.setPlatforms(platforms);
      socialPrepSettingsService.setEnabled(true);
    }
    const release = createReleaseRepository(db).create({ projectId: project.id, title: 'Alpha release', description: '', notes: '' });
    releaseService.updateRelease(release.id, {
      title: 'Alpha release', description: 'Alpha description', notes: 'Alpha notes',
      plannedDate: '2031-07-10', plannedTime: '09:30', publishedDate: null,
      patreonUrl: 'https://example.com/alpha', selectedPlatforms: platforms,
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    await run({ origin: `http://127.0.0.1:${server.address().port}`, release, releaseService, project, app, db });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function watchPage(page, releaseId) {
  const errors = [];
  const navigations = [];
  const publishes = [];
  const refreshes = [];
  const mutations = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) errors.push(message.text());
  });
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (request.method() !== 'GET') mutations.push(pathname);
    if (pathname === `/releases/${releaseId}/publish` && request.method() === 'POST') publishes.push(request);
    if (pathname === `/releases/${releaseId}` && request.resourceType() === 'fetch') refreshes.push(request);
  });
  return { errors, navigations, publishes, refreshes, mutations };
}

async function openDetail(page, origin, release, suffix = '') {
  await page.goto(`${origin}/releases/${release.id}${suffix}`);
  await page.evaluate(() => { window.__notReloaded = true; });
}

const action = (page) => page.locator('[data-dialog-open="release-publish-dialog"]');
const dialog = (page) => page.locator('#release-publish-dialog');
const feedback = (page) => page.locator('[data-dialog-feedback]');
const stayedOnPage = (page) => page.evaluate(() => window.__notReloaded === true);

test('Publishes in place, updates Release Detail and keeps page state', async ({ page }) => {
  await withRelease(async ({ origin, release, releaseService }) => {
    const { errors, navigations, publishes, refreshes } = watchPage(page, release.id);
    await page.setViewportSize({ width: 1280, height: 700 });
    await openDetail(page, origin, release, '?view=list');
    navigations.length = 0;
    await page.evaluate(() => {
      document.querySelector('[data-selected-assets]').dataset.untouched = 'kept';
      window.scrollTo(0, 80);
    });
    const scrollBefore = await page.evaluate(() => window.scrollY);

    await action(page).click();
    await expect(dialog(page)).toBeVisible();
    await dialog(page).locator('[name="publishedDate"]').fill('2031-08-03');
    await dialog(page).locator('[data-dialog-submit]').click();

    await expect(dialog(page)).toHaveCount(0);
    await expect(feedback(page)).toContainText('Release published.');
    await expect(page.locator('.publication-summary-badge')).toHaveText('Published');
    await expect(page.locator('.project-detail-info .status-badge--success')).toHaveText('Published');
    await expect(page.locator('[data-release-detail-region="details"]')).toContainText('2031-08-03');
    await expect(action(page)).toHaveCount(0);
    await expect(page.locator('[aria-label="Manage Assets"]')).toHaveCount(0);

    expect(await stayedOnPage(page)).toBe(true);
    expect(navigations).toEqual([]);
    expect(publishes).toHaveLength(1);
    expect(refreshes.every((request) => request.method() === 'GET')).toBe(true);
    expect(releaseService.findRelease(release.id).published_date).toBe('2031-08-03');
    expect(new URL(page.url()).searchParams.get('view')).toBe('list');
    expect(await page.locator('[data-selected-assets]').getAttribute('data-untouched')).toBe('kept');
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
    // Focus is not lost with the withdrawn action.
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('main-content');

    // Edit Release still opens from the authoritative published state.
    await page.locator(`[data-release-edit-id="${release.id}"]`).click();
    await expect(page.locator('#release-edit-form [name="publishedDate"]')).toHaveValue('2031-08-03');
    expect(errors).toEqual([]);
  });
});

test('The direct publish URL opens the dialog and a publication drops the marker', async ({ page }) => {
  await withRelease(async ({ origin, release }) => {
    const { publishes } = watchPage(page, release.id);
    await page.goto(`${origin}/releases/${release.id}/publish`);
    await expect(page).toHaveURL(new RegExp(`/releases/${release.id}\\?publish=1$`));
    await expect(dialog(page)).toBeVisible();
    await dialog(page).locator('[data-dialog-submit]').click();
    await expect(page.locator('.publication-summary-badge')).toHaveText('Published');
    await expect(page).toHaveURL(new RegExp(`/releases/${release.id}$`));
    expect(publishes).toHaveLength(1);
  });
});

test('A held publication sends one request and cannot be dismissed', async ({ page }) => {
  await withRelease(async ({ origin, release }) => {
    const { publishes } = watchPage(page, release.id);
    await openDetail(page, origin, release);
    let release1;
    const held = new Promise((resolve) => { release1 = resolve; });
    await page.route(`**/releases/${release.id}/publish`, async (route) => {
      await held;
      await route.continue();
    });
    await action(page).click();
    const submit = dialog(page).locator('[data-dialog-submit]');
    await submit.click();
    await expect(submit).toBeDisabled();
    await expect(dialog(page).locator('[data-dialog-status]')).toHaveText('Publishing release…');
    await dialog(page).locator('[name="publishedDate"]').press('Enter');
    await page.keyboard.press('Escape');
    await dialog(page).locator('[data-dialog-close]').first().click();
    await page.mouse.click(5, 5);
    await expect(dialog(page)).toBeVisible();
    release1();
    await expect(page.locator('.publication-summary-badge')).toHaveText('Published');
    expect(publishes).toHaveLength(1);
  });
});

test('Validation failures keep the dialog, its values and a working date picker', async ({ page }) => {
  await withRelease(async ({ origin, release, releaseService }) => {
    const { errors, navigations, publishes } = watchPage(page, release.id);
    await openDetail(page, origin, release);
    navigations.length = 0;
    await action(page).click();
    const date = dialog(page).locator('[name="publishedDate"]');

    // The native control cannot hold an invalid date, but the server decides.
    await page.evaluate(() => { document.querySelector('#release-publish-date').type = 'text'; });
    await date.fill('2031-02-31');
    await dialog(page).locator('[data-dialog-submit]').click();
    const message = dialog(page).locator('#release-publish-date-error');
    await expect(message).toHaveText('Published date must be a valid date (YYYY-MM-DD).');
    await expect(dialog(page)).toBeVisible();
    await expect(date).toHaveValue('2031-02-31');
    await expect(date).toHaveAttribute('aria-invalid', 'true');
    await expect(date).toBeFocused();
    await expect(dialog(page).locator('[data-dialog-error]')).toBeVisible();
    expect((await date.getAttribute('aria-describedby')).split(' ')).toEqual(
      expect.arrayContaining(['release-publish-date-help', 'release-publish-date-error']),
    );

    // Fixing it clears the error and the calendar still works.
    await page.evaluate(() => { document.querySelector('#release-publish-date').type = 'date'; });
    await date.fill('2031-03-04');
    await dialog(page).locator('.date-picker-trigger').click();
    await expect(dialog(page).locator('[data-date-picker-panel]')).toBeVisible();
    await page.keyboard.press('Escape');

    // A status removed from the catalogue is a field error on the dropdown.
    await page.evaluate(() => {
      const input = document.querySelector('input[name="projectStatus"]:not([value=""])');
      input.value = 'no-such-status';
      input.checked = true;
    });
    await dialog(page).locator('[data-dialog-submit]').click();
    await expect(dialog(page).locator('#release-publish-project-status-error')).toContainText('no longer available');
    await expect(date).toHaveValue('2031-03-04');
    await expect(message).toHaveCount(0);
    expect(releaseService.findRelease(release.id).published_date).toBeNull();

    // A dismissal is local and clears the refused state; reopening starts over.
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
    await expect(action(page)).toBeFocused();
    await action(page).click();
    await expect(dialog(page).locator('[data-dialog-error]')).toBeHidden();
    await expect(dialog(page).locator('#release-publish-project-status-error')).toHaveCount(0);
    await expect(dialog(page).locator('input[name="projectStatus"][value=""]')).toBeChecked();
    await expect(date).not.toHaveValue('2031-03-04');

    expect(publishes).toHaveLength(2);
    expect(navigations).toEqual([]);
    expect(await stayedOnPage(page)).toBe(true);
    expect(errors).toEqual([]);
  });
});

test('Cancel, Close and backdrop stay local and restore focus', async ({ page }) => {
  await withRelease(async ({ origin, release }) => {
    const { navigations, publishes } = watchPage(page, release.id);
    await openDetail(page, origin, release);
    navigations.length = 0;
    const closers = [
      () => dialog(page).locator('footer [data-dialog-close]').click(),
      () => dialog(page).locator('header [data-dialog-close]').click(),
      () => page.mouse.click(5, 5),
    ];
    for (const close of closers) {
      await action(page).click();
      await expect(dialog(page)).toBeVisible();
      await dialog(page).locator('[name="publishedDate"]').fill('2031-09-09');
      await close();
      await expect(dialog(page)).toBeHidden();
      await expect(action(page)).toBeFocused();
      await action(page).click();
      await expect(dialog(page).locator('[name="publishedDate"]')).not.toHaveValue('2031-09-09');
      await page.keyboard.press('Escape');
      await expect(dialog(page)).toBeHidden();
    }
    expect(publishes).toHaveLength(0);
    expect(navigations).toEqual([]);
  });
});

test('A failed refresh after a confirmed publication offers a GET-only retry', async ({ page }) => {
  await withRelease(async ({ origin, release, releaseService }) => {
    const { publishes, refreshes, navigations } = watchPage(page, release.id);
    await openDetail(page, origin, release);
    navigations.length = 0;
    let failRefresh = true;
    await page.route(`**/releases/${release.id}`, async (route) => {
      if (route.request().resourceType() === 'fetch' && failRefresh) await route.abort();
      else await route.continue();
    });
    await action(page).click();
    await dialog(page).locator('[data-dialog-submit]').click();

    await expect(feedback(page)).toContainText('Release published, but Release Detail could not refresh.');
    await expect(feedback(page)).toHaveClass(/notice--error/);
    await expect(action(page)).toHaveCount(0);
    const retry = page.locator('[data-release-detail-refresh-retry]');
    await expect(retry).toBeFocused();
    expect(releaseService.findRelease(release.id).published_date).not.toBeNull();

    await retry.click();
    await expect(feedback(page)).toContainText('could not refresh');
    failRefresh = false;
    await retry.click();
    await expect(page.locator('.publication-summary-badge')).toHaveText('Published');
    await expect(feedback(page)).toContainText('Release published.');
    await expect(feedback(page)).not.toContainText('could not refresh');
    await expect(feedback(page)).toHaveClass(/notice--success/);
    await expect(retry).toHaveCount(0);

    expect(publishes).toHaveLength(1);
    expect(refreshes.length).toBe(3);
    expect(refreshes.every((request) => request.method() === 'GET')).toBe(true);
    expect(navigations).toEqual([]);
  });
});

test('A lost response reports uncertainty; a GET check settles a committed publication', async ({ page }) => {
  await withRelease(async ({ origin, release, releaseService }) => {
    const { publishes, navigations } = watchPage(page, release.id);
    await openDetail(page, origin, release);
    navigations.length = 0;
    // The server commits; the browser never sees the answer.
    await page.route(`**/releases/${release.id}/publish`, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await route.fetch();
      return route.abort();
    });
    await action(page).click();
    await dialog(page).locator('[data-dialog-submit]').click();

    const summary = dialog(page).locator('[data-dialog-error]');
    await expect(summary).toContainText('Could not confirm whether the release was published.');
    await expect(summary).not.toContainText('was not published');
    await expect(dialog(page).locator('[data-dialog-submit]')).toBeDisabled();
    await expect(dialog(page)).toBeVisible();
    expect(publishes).toHaveLength(1);
    expect(releaseService.findRelease(release.id).published_date).not.toBeNull();

    await dialog(page).locator('[data-release-publish-check]').click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.locator('.publication-summary-badge')).toHaveText('Published');
    await expect(feedback(page)).toContainText('Release published.');
    expect(publishes).toHaveLength(1);
    expect(navigations).toEqual([]);
  });
});

test('A lost request that never committed can be checked and published again', async ({ page }) => {
  await withRelease(async ({ origin, release, releaseService }) => {
    const { publishes } = watchPage(page, release.id);
    await openDetail(page, origin, release);
    let drop = true;
    await page.route(`**/releases/${release.id}/publish`, async (route) => {
      if (route.request().method() === 'POST' && drop) return route.abort();
      return route.continue();
    });
    await action(page).click();
    await dialog(page).locator('[name="publishedDate"]').fill('2031-05-06');
    await dialog(page).locator('[data-dialog-submit]').click();
    await expect(dialog(page).locator('[data-dialog-submit]')).toBeDisabled();
    drop = false;
    await dialog(page).locator('[data-release-publish-check]').click();
    await expect(dialog(page).locator('[data-dialog-error]')).toContainText('The release was not published. You can publish it again.');
    const submit = dialog(page).locator('[data-dialog-submit]');
    await expect(submit).toBeEnabled();
    await expect(dialog(page).locator('[name="publishedDate"]')).toHaveValue('2031-05-06');
    expect(publishes).toHaveLength(1);

    await submit.click();
    await expect(page.locator('.publication-summary-badge')).toHaveText('Published');
    expect(releaseService.findRelease(release.id).published_date).toBe('2031-05-06');
    expect(publishes).toHaveLength(2);
  });
});

test('Publication elsewhere and service failures are reported safely', async ({ page }) => {
  await withRelease(async ({ origin, release, releaseService }) => {
    const { publishes, refreshes } = watchPage(page, release.id);
    await openDetail(page, origin, release);

    // A failure the route reports: nothing committed, Publish stays available.
    await page.route(`**/releases/${release.id}/publish`, (route) => route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'error', code: 'SERVER_ERROR', message: 'The release was not published. Please try again.' }),
    }));
    await action(page).click();
    await dialog(page).locator('[data-dialog-submit]').click();
    await expect(dialog(page).locator('[data-dialog-error]')).toContainText('The release was not published. Please try again.');
    await expect(dialog(page).locator('[data-dialog-submit]')).toBeEnabled();
    await page.unroute(`**/releases/${release.id}/publish`);

    // Another tab publishes first: the server refuses, the date is unchanged,
    // and dismissing refreshes this page with a GET.
    releaseService.publishRelease(release.id, '2031-01-02');
    await dialog(page).locator('[name="publishedDate"]').fill('2031-09-09');
    await dialog(page).locator('[data-dialog-submit]').click();
    await expect(dialog(page).locator('[data-dialog-error]')).toContainText('This release is already published.');
    await expect(dialog(page).locator('[data-dialog-submit]')).toBeDisabled();
    expect(refreshes).toHaveLength(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('.publication-summary-badge')).toHaveText('Published');
    await expect(page.locator('[data-release-detail-region="details"]')).toContainText('2031-01-02');
    await expect(feedback(page)).toContainText('This release is already published.');
    await expect(dialog(page)).toHaveCount(0);
    expect(releaseService.findRelease(release.id).published_date).toBe('2031-01-02');
    expect(publishes).toHaveLength(2);
    expect(refreshes.every((request) => request.method() === 'GET')).toBe(true);
  });
});

test('A release archived elsewhere is refused and the page withdraws Publish', async ({ page }) => {
  await withRelease(async ({ origin, release, releaseService }) => {
    const { errors } = watchPage(page, release.id);
    await openDetail(page, origin, release);
    await action(page).click();
    releaseService.archiveRelease(release.id);
    await dialog(page).locator('[data-dialog-submit]').click();
    await expect(dialog(page).locator('[data-dialog-error]')).toBeVisible();
    await expect(dialog(page).locator('[data-dialog-submit]')).toBeDisabled();
    expect(releaseService.findRelease(release.id).published_date).toBeNull();
    await page.keyboard.press('Escape');
    await expect(action(page)).toHaveCount(0);
    await expect(feedback(page)).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test('A refused archived release says why and synchronizes Release Detail in place', async ({ page }) => {
  await withRelease(async ({ origin, release, releaseService }) => {
    const { errors, publishes, refreshes, navigations } = watchPage(page, release.id);
    await openDetail(page, origin, release);
    navigations.length = 0;
    await action(page).click();
    releaseService.archiveRelease(release.id);
    const submit = dialog(page).locator('[data-dialog-submit]');
    await submit.click();

    const summary = dialog(page).locator('[data-dialog-error]');
    await expect(summary).toContainText('This release is archived, so it cannot be published.');
    await expect(submit).toBeDisabled();
    await expect(dialog(page).locator('[data-dialog-close]').last()).toBeFocused();
    // The stale dialog cannot try again, by keyboard either.
    await dialog(page).locator('[name="publishedDate"]').press('Enter');
    expect(publishes).toHaveLength(1);
    expect(refreshes).toHaveLength(0);

    await page.keyboard.press('Escape');
    await expect(page.locator('[data-release-detail-region="notices"]')).toContainText('This release is archived and read-only.');
    await expect(feedback(page)).toContainText('This release is archived, so it cannot be published.');
    await expect(feedback(page)).toHaveClass(/notice--error/);
    await expect(feedback(page)).not.toHaveClass(/notice--success/);
    await expect(page.locator('[data-release-detail-refresh-retry]')).toHaveCount(0);
    await expect(action(page)).toHaveCount(0);
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.locator('[data-release-edit-id]')).toHaveCount(0);
    await expect(page.locator('#release-edit-dialog')).toHaveCount(0);
    await expect(page.locator('[data-release-detail-region="asset-actions"]')).toHaveCount(0);
    await expect(page.locator('#main-content')).toBeFocused();

    expect(releaseService.findRelease(release.id).published_date).toBeNull();
    expect(publishes).toHaveLength(1);
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0].method()).toBe('GET');
    expect(navigations).toEqual([]);
    expect(await stayedOnPage(page)).toBe(true);
    expect(errors).toEqual([]);
  });
});

test('An archived refusal keeps its explanation while a failed refresh retries with GET', async ({ page }) => {
  await withRelease(async ({ origin, release, releaseService }) => {
    const { publishes, refreshes, navigations } = watchPage(page, release.id);
    await openDetail(page, origin, release);
    navigations.length = 0;
    let failRefresh = true;
    await page.route(`**/releases/${release.id}`, async (route) => {
      if (route.request().resourceType() === 'fetch' && failRefresh) await route.abort();
      else await route.continue();
    });
    await action(page).click();
    releaseService.archiveRelease(release.id);
    await dialog(page).locator('[data-dialog-submit]').click();
    await expect(dialog(page).locator('[data-dialog-submit]')).toBeDisabled();
    await page.keyboard.press('Escape');

    await expect(feedback(page)).toContainText('This release is archived, so it cannot be published.');
    await expect(feedback(page)).toContainText('could not refresh');
    await expect(action(page)).toHaveCount(0);
    const retry = page.locator('[data-release-detail-refresh-retry]');
    await expect(retry).toBeVisible();

    failRefresh = false;
    await retry.click();
    await expect(page.locator('[data-release-detail-region="notices"]')).toContainText('This release is archived and read-only.');
    await expect(feedback(page)).not.toContainText('could not refresh');
    await expect(feedback(page)).toHaveClass(/notice--error/);
    await expect(retry).toHaveCount(0);
    await expect(page.locator('[data-release-edit-id]')).toHaveCount(0);

    expect(publishes).toHaveLength(1);
    expect(refreshes.every((request) => request.method() === 'GET')).toBe(true);
    expect(navigations).toEqual([]);
  });
});

test('A status check that finds the release archived says so and does not publish', async ({ page }) => {
  await withRelease(async ({ origin, release, releaseService }) => {
    const { publishes } = watchPage(page, release.id);
    await openDetail(page, origin, release);
    await page.route(`**/releases/${release.id}/publish`, (route) => (
      route.request().method() === 'POST' ? route.abort() : route.continue()));
    await action(page).click();
    await dialog(page).locator('[data-dialog-submit]').click();
    await expect(dialog(page).locator('[data-release-publish-check]')).toBeVisible();

    releaseService.archiveRelease(release.id);
    await dialog(page).locator('[data-release-publish-check]').click();
    await expect(dialog(page).locator('[data-dialog-error]')).toContainText('is archived, so this release cannot be published.');
    await expect(dialog(page).locator('[data-dialog-submit]')).toBeDisabled();
    await expect(dialog(page).locator('[data-dialog-close]').last()).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(page.locator('[data-release-detail-region="notices"]')).toContainText('This release is archived and read-only.');
    await expect(feedback(page)).toHaveClass(/notice--error/);
    expect(publishes).toHaveLength(1);
    expect(releaseService.findRelease(release.id).published_date).toBeNull();
  });
});

test('An open Edit Release dialog holds the archived refresh until it closes', async ({ page }) => {
  await withRelease(async ({ origin, release, releaseService }) => {
    const { errors, navigations } = watchPage(page, release.id);
    await openDetail(page, origin, release);
    navigations.length = 0;
    await page.locator('[data-release-edit-id]').click();
    const edit = page.locator('#release-edit-dialog');
    await expect(edit).toBeVisible();
    releaseService.archiveRelease(release.id);
    await page.evaluate((releaseId) => {
      document.dispatchEvent(new CustomEvent('release-publish-settled', { detail: { outcome: 'stale', releaseId: String(releaseId) } }));
    }, release.id);

    await expect(edit.locator('[data-dialog-submit]')).toBeDisabled();
    await expect(edit).toBeVisible();
    await edit.locator('[data-dialog-close]').last().click();
    await expect(page.locator('[data-release-edit-id]')).toHaveCount(0);
    await expect(edit).toHaveCount(0);
    await expect(page.locator('[data-release-detail-region="notices"]')).toContainText('This release is archived and read-only.');
    await expect(page.locator('[data-release-detail-refresh-retry]')).toHaveCount(0);
    expect(navigations).toEqual([]);
    expect(errors).toEqual([]);
  });
});

// Answers a GET with what the server said when it arrived, but only once
// released, so the answer can be older than a later change on the server.
async function holdGetResponse(page, url) {
  let answer;
  const held = new Promise((resolve) => { answer = resolve; });
  let arrived;
  const received = new Promise((resolve) => { arrived = resolve; });
  await page.route(url, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    arrived();
    await held;
    return route.fulfill({ response });
  });
  return {
    received,
    // Resolves after the page has handled the answer.
    release: async () => {
      const handled = page.waitForResponse((response) => response.url().endsWith(url.replace('**', '')));
      answer();
      await (await handled).finished();
      await page.evaluate(() => new Promise((resolve) => { setTimeout(resolve, 0); }));
    },
  };
}

// Release Detail adopts the current render while the dialog stays open.
async function adoptCurrentRender(page, releaseId) {
  await page.evaluate((id) => {
    document.dispatchEvent(new CustomEvent('release-publish-settled', { detail: { outcome: 'stale', releaseId: String(id) } }));
  }, releaseId);
  await expect(page.locator('[data-release-detail-region="notices"]')).toContainText('This release is archived and read-only.');
}

const requestSubmit = (locator) => locator.evaluate((form) => form.requestSubmit());

test('A status answer older than the archived render cannot bring Publish back', async ({ page }) => {
  await withRelease(async ({ origin, release, releaseService }) => {
    const { errors, publishes, navigations } = watchPage(page, release.id);
    await openDetail(page, origin, release);
    navigations.length = 0;
    await page.route(`**/releases/${release.id}/publish`, (route) => (
      route.request().method() === 'POST' ? route.abort() : route.continue()));
    await action(page).click();
    const submit = dialog(page).locator('[data-dialog-submit]');
    await submit.click();
    await expect(dialog(page).locator('[data-release-publish-check]')).toBeVisible();
    expect(publishes).toHaveLength(1);

    const status = await holdGetResponse(page, `**/releases/${release.id}/publish`);
    await dialog(page).locator('[data-release-publish-check]').click();
    await status.received;
    releaseService.archiveRelease(release.id);
    await adoptCurrentRender(page, release.id);
    await expect(page.locator('[data-release-detail-region="publish-dialog"]')).toHaveAttribute('data-release-detail-stale', '');
    await expect(submit).toBeDisabled();

    await status.release();

    await expect(submit).toBeDisabled();
    const summary = dialog(page).locator('[data-dialog-error]');
    await expect(summary).toContainText('Close this dialog to load its current details.');
    await expect(summary).not.toContainText('You can publish it again.');
    await expect(page.locator('[data-release-detail-region="notices"]')).toContainText('This release is archived and read-only.');
    await expect(dialog(page).locator('footer [data-dialog-close]')).toBeFocused();

    // No way of submitting the stale form reaches the server.
    await dialog(page).locator('[name="publishedDate"]').press('Enter');
    await requestSubmit(dialog(page).locator('form'));
    await submit.evaluate((control) => { control.disabled = false; control.click(); control.disabled = true; });
    expect(publishes).toHaveLength(1);
    expect(releaseService.findRelease(release.id).published_date).toBeNull();

    await dialog(page).locator('footer [data-dialog-close]').click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(action(page)).toHaveCount(0);
    await expect(page.locator('#main-content')).toBeFocused();
    expect(publishes).toHaveLength(1);
    expect(navigations).toEqual([]);
    expect(await stayedOnPage(page)).toBe(true);
    expect(errors).toEqual([]);
  });
});

test('A status answer for a release that stays active still recovers an unconfirmed publication', async ({ page }) => {
  await withRelease(async ({ origin, release, releaseService }) => {
    const { publishes } = watchPage(page, release.id);
    await openDetail(page, origin, release);
    let drop = true;
    await page.route(`**/releases/${release.id}/publish`, (route) => (
      route.request().method() === 'POST' && drop ? route.abort() : route.continue()));
    await action(page).click();
    const submit = dialog(page).locator('[data-dialog-submit]');
    await submit.click();
    await expect(dialog(page).locator('[data-release-publish-check]')).toBeVisible();

    // Publish is paused at the submit boundary until the outcome is known.
    await requestSubmit(dialog(page).locator('form'));
    expect(publishes).toHaveLength(1);

    drop = false;
    const status = await holdGetResponse(page, `**/releases/${release.id}/publish`);
    await dialog(page).locator('[data-release-publish-check]').click();
    await status.received;
    await status.release();
    await expect(dialog(page).locator('[data-dialog-error]')).toContainText('The release was not published. You can publish it again.');
    await expect(submit).toBeEnabled();
    await expect(submit).toBeFocused();
    expect(publishes).toHaveLength(1);

    await submit.click();
    await expect(page.locator('.publication-summary-badge')).toHaveText('Published');
    expect(publishes).toHaveLength(2);
    expect(releaseService.findRelease(release.id).published_date).not.toBeNull();
  });
});

test('A publication refused while its dialog went stale does not bring Publish back', async ({ page }) => {
  await withRelease(async ({ origin, release, releaseService }) => {
    const { publishes } = watchPage(page, release.id);
    await openDetail(page, origin, release);
    let answer;
    const held = new Promise((resolve) => { answer = resolve; });
    await page.route(`**/releases/${release.id}/publish`, async (route) => {
      await held;
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'error', code: 'SERVER_ERROR', message: 'The release was not published. Please try again.' }),
      });
    });
    await action(page).click();
    const submit = dialog(page).locator('[data-dialog-submit]');
    await submit.click();
    await expect(submit).toBeDisabled();
    releaseService.archiveRelease(release.id);
    await adoptCurrentRender(page, release.id);

    answer();
    await expect(dialog(page).locator('[data-dialog-error]')).toContainText('Please try again.');
    await expect(submit).toBeDisabled();
    await requestSubmit(dialog(page).locator('form'));
    expect(publishes).toHaveLength(1);
  });
});

test('An Edit Release load older than the archived render cannot bring Save back', async ({ page }) => {
  await withRelease(async ({ origin, release, releaseService }) => {
    const { errors, navigations, mutations, refreshes } = watchPage(page, release.id);
    await openDetail(page, origin, release);
    navigations.length = 0;
    const load = await holdGetResponse(page, `**/releases/${release.id}/edit`);
    const editAction = page.locator(`[data-release-edit-id="${release.id}"]`);
    await editAction.click();
    const edit = page.locator('#release-edit-dialog');
    const save = edit.locator('[data-dialog-submit]');
    await expect(edit).toBeVisible();
    await load.received;
    await expect(save).toBeDisabled();

    releaseService.archiveRelease(release.id);
    await adoptCurrentRender(page, release.id);
    await expect(page.locator('[data-release-detail-editing]').last()).toHaveAttribute('data-release-detail-stale', '');
    const refreshesBeforeLoad = refreshes.length;

    await load.release();

    await expect(save).toBeDisabled();
    await expect(edit.locator('[data-dialog-status]')).toContainText('Close this dialog to load its current details.');
    await expect(edit.locator('#release-edit-form')).toHaveAttribute('aria-busy', 'true');
    await requestSubmit(edit.locator('#release-edit-form'));
    await save.evaluate((control) => { control.disabled = false; control.click(); control.disabled = true; });
    expect(mutations).toEqual([]);
    expect(refreshes).toHaveLength(refreshesBeforeLoad);
    await expect(edit).toBeVisible();

    const focused = await page.evaluate(() => document.activeElement?.closest('#release-edit-dialog') !== null);
    expect(focused).toBe(true);
    await edit.locator('[data-dialog-close]').last().click();
    await expect(edit).toHaveCount(0);
    await expect(page.locator('[data-release-edit-id]')).toHaveCount(0);
    await expect(page.locator('[data-release-detail-stale]')).toHaveCount(0);
    await expect(page.locator('#main-content')).toBeFocused();
    expect(mutations).toEqual([]);
    expect(navigations).toEqual([]);
    expect(await stayedOnPage(page)).toBe(true);
    expect(errors).toEqual([]);
  });
});

test('A loaded Edit Release draft cannot be saved once archived, and a held save stays locked', async ({ page }) => {
  await withRelease(async ({ origin, release, releaseService }) => {
    const { mutations } = watchPage(page, release.id);
    await openDetail(page, origin, release);
    await page.locator(`[data-release-edit-id="${release.id}"]`).click();
    const edit = page.locator('#release-edit-dialog');
    const form = edit.locator('#release-edit-form');
    const save = edit.locator('[data-dialog-submit]');
    await expect(save).toBeEnabled();
    await form.locator('[name="title"]').fill('Draft title');

    // A save in flight when the archived render arrives.
    let answer;
    const held = new Promise((resolve) => { answer = resolve; });
    await page.route(`**/releases/${release.id}`, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await held;
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'error', code: 'SERVER_ERROR', message: 'The release was not saved.' }),
      });
    });
    await save.click();
    await expect(save).toBeDisabled();
    releaseService.archiveRelease(release.id);
    await adoptCurrentRender(page, release.id);
    answer();
    await expect(edit.locator('[data-dialog-status]')).toContainText('The release was not saved.');
    await expect(save).toBeDisabled();
    await expect(form.locator('[name="title"]')).toHaveValue('Draft title');
    expect(mutations).toEqual([`/releases/${release.id}`]);

    await form.locator('[name="title"]').press('Enter');
    await requestSubmit(form);
    expect(mutations).toEqual([`/releases/${release.id}`]);

    await page.keyboard.press('Escape');
    await expect(edit).toHaveCount(0);
    await expect(page.locator('[data-release-edit-id]')).toHaveCount(0);
  });
});

test('A publication that initializes Social Preparation launches the companion once, in place', async ({ page }) => {
  await withRelease(async ({ origin, release }) => {
    const { navigations, publishes, mutations } = watchPage(page, release.id);
    const activations = [];
    await page.route(`**/releases/${release.id}/social-prep/**`, async (route) => {
      activations.push(new URL(route.request().url()).pathname);
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
    await openDetail(page, origin, release);
    navigations.length = 0;
    await action(page).click();
    await expect(dialog(page)).toContainText('Social Preparation');
    await dialog(page).locator('[data-dialog-submit]').click();

    const companion = page.locator('[data-release-social-prep-companion]:not([data-target-platform]) [data-release-social-prep-companion-action]');
    await expect(companion).toHaveText('Retry opening companion');
    expect(activations).toEqual([`/releases/${release.id}/social-prep/activate`]);
    expect(publishes).toHaveLength(1);
    expect(mutations.filter((pathname) => pathname.endsWith('/publish'))).toHaveLength(1);
    expect(await stayedOnPage(page)).toBe(true);
    expect(new URL(page.url()).searchParams.has('prep')).toBe(false);
    expect(navigations.filter((url) => url.startsWith('http'))).toEqual([]);
  }, { platforms: ['x'] });
});

test('A failed refresh never launches the companion after its retry', async ({ page }) => {
  await withRelease(async ({ origin, release }) => {
    const activations = [];
    await page.route(`**/releases/${release.id}/social-prep/**`, async (route) => {
      activations.push(route.request().url());
      await route.abort();
    });
    await openDetail(page, origin, release);
    let failRefresh = true;
    await page.route(`**/releases/${release.id}`, async (route) => {
      if (route.request().resourceType() === 'fetch' && failRefresh) await route.abort();
      else await route.continue();
    });
    await action(page).click();
    await dialog(page).locator('[data-dialog-submit]').click();
    const retry = page.locator('[data-release-detail-refresh-retry]');
    await expect(retry).toBeVisible();
    failRefresh = false;
    await retry.click();
    const companion = page.locator('[data-release-social-prep-companion]:not([data-target-platform]) [data-release-social-prep-companion-action]');
    await expect(companion).toBeEnabled();
    expect(activations).toEqual([]);
  }, { platforms: ['x'] });
});

test('A page without the dialog can load and publish through the same controller', async ({ page }) => {
  await withRelease(async ({ origin, release, releaseService }) => {
    const { errors, publishes } = watchPage(page, release.id);
    await page.goto(`${origin}/settings`);
    await page.evaluate(() => { window.__notReloaded = true; });
    const startUrl = page.url();
    const result = await page.evaluate(async (releaseId) => {
      const { openReleasePublishDialog, RELEASE_PUBLISH_SETTLED_EVENT } = await import('/client/release-publish-dialog.js');
      const mount = document.createElement('div');
      document.body.append(mount);
      window.__settled = [];
      document.addEventListener(RELEASE_PUBLISH_SETTLED_EVENT, (event) => {
        window.__settled.push({ outcome: event.detail.outcome, releaseId: event.detail.releaseId, message: event.detail.message });
      });
      return openReleasePublishDialog(document, releaseId, { mount });
    }, release.id);
    expect(result).toEqual({ status: 'opened' });
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toContainText('Alpha release');
    await dialog(page).locator('[name="publishedDate"]').fill('2031-06-07');
    await dialog(page).locator('[data-dialog-submit]').click();
    await expect(dialog(page)).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.__settled)).toEqual([
      { outcome: 'published', releaseId: String(release.id), message: 'Release published.' },
    ]);
    expect(page.url()).toBe(startUrl);
    expect(await stayedOnPage(page)).toBe(true);
    expect(publishes).toHaveLength(1);
    expect(releaseService.findRelease(release.id).published_date).toBe('2031-06-07');

    // A release that left review is reported rather than opened.
    const second = await page.evaluate(async (releaseId) => {
      const { openReleasePublishDialog } = await import('/client/release-publish-dialog.js');
      return openReleasePublishDialog(document, releaseId, { mount: document.body.lastElementChild });
    }, release.id);
    expect(second.status).toBe('unavailable');
    expect(errors).toEqual([]);
  });
});
