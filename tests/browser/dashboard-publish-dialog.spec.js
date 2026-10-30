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

function localDate(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

async function withDashboard(run, { platforms = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-dashboard-publish-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    const { socialPrepSettingsService, projectService } = app.locals;
    const releaseService = createReleaseService({ db, socialPrepSettingsService, projectService });
    const project = projectService.create({ title: 'Publish host project' });
    if (platforms.length > 0) {
      socialPrepSettingsService.setPlatforms(platforms);
      socialPrepSettingsService.setEnabled(true);
    }
    const releases = createReleaseRepository(db);
    const seed = (title, days) => {
      const release = releases.create({ projectId: project.id, title, description: '', notes: '' });
      releaseService.updateRelease(release.id, {
        title, description: '', notes: '', plannedDate: localDate(days), plannedTime: null,
        publishedDate: null, patreonUrl: 'https://example.com/post', selectedPlatforms: platforms,
      });
      return release;
    };
    const alpha = seed('Alpha overdue', -2);
    const beta = seed('Beta overdue', -1);
    const gamma = seed('Gamma today', 0);
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    await run({
      origin: `http://127.0.0.1:${server.address().port}`, alpha, beta, gamma, releaseService, project, projectService, db,
    });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function watchPage(page) {
  const errors = [];
  const navigations = [];
  const posts = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
  page.on('request', (request) => {
    if (request.method() !== 'GET') posts.push(new URL(request.url()).pathname);
  });
  return { errors, navigations, posts };
}

async function openDashboard(page, origin) {
  await page.goto(`${origin}/`);
  await page.evaluate(() => { window.__notReloaded = true; });
}

const trigger = (page, release) => page.locator(`[data-dashboard-publish="${release.id}"]`);
const dialog = (page) => page.locator('#release-publish-dialog');
const feedback = (page) => page.locator('[data-dialog-feedback]');
const banner = (page) => page.locator('[data-dashboard-sync]');
const stayed = (page) => page.evaluate(() => window.__notReloaded === true);
const activeTag = (page) => page.evaluate(() => document.activeElement?.tagName);

test('Publishes over the Dashboard, refreshes it and keeps its state', async ({ page }) => {
  await withDashboard(async ({ origin, alpha, beta, releaseService }) => {
    const { errors, navigations, posts } = watchPage(page);
    await openDashboard(page, origin);
    navigations.length = 0;

    await trigger(page, alpha).click();
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toContainText('Alpha overdue');
    expect(page.url()).toBe(`${origin}/`);
    await dialog(page).locator('[name="publishedDate"]').fill(localDate(-1));
    await dialog(page).locator('[data-dialog-submit]').click();

    await expect(feedback(page)).toContainText('“Alpha overdue” was published.');
    await expect(trigger(page, alpha)).toHaveCount(0);
    await expect(page.locator(`.dashboard-recent-item[data-release-id="${alpha.id}"]`)).toBeVisible();
    await expect(dialog(page)).toHaveCount(0);
    await expect(trigger(page, beta)).toBeVisible();
    expect(releaseService.findRelease(alpha.id).published_date).toBe(localDate(-1));
    expect(posts).toEqual([`/releases/${alpha.id}/publish`]);
    expect(navigations).toEqual([]);
    expect(await stayed(page)).toBe(true);
    await expect.poll(() => activeTag(page)).not.toBe('BODY');

    // The trigger of a refreshed row opens the release it names.
    await trigger(page, beta).click();
    await expect(dialog(page)).toContainText('Beta overdue');
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

test('Every dismissal stays local and returns focus to Publish', async ({ page }) => {
  await withDashboard(async ({ origin, alpha, releaseService }) => {
    const { navigations, posts } = watchPage(page);
    await openDashboard(page, origin);
    navigations.length = 0;
    const dismissals = [
      () => page.keyboard.press('Escape'),
      () => dialog(page).locator('[data-dialog-close]').first().click(),
      () => dialog(page).locator('footer [data-dialog-close]').click(),
      () => page.mouse.click(4, 4),
    ];
    for (const dismiss of dismissals) {
      await trigger(page, alpha).click();
      await expect(dialog(page)).toBeVisible();
      await dialog(page).locator('[name="publishedDate"]').fill('2031-01-02');
      await dismiss();
      await expect(dialog(page)).toHaveCount(0);
      await expect(trigger(page, alpha)).toBeFocused();
    }
    // A fresh open holds the current state, not the abandoned draft.
    await trigger(page, alpha).click();
    await expect(dialog(page).locator('[name="publishedDate"]')).not.toHaveValue('2031-01-02');
    expect(posts).toEqual([]);
    expect(navigations).toEqual([]);
    expect(releaseService.findRelease(alpha.id).published_date).toBeNull();
  });
});

test('A modified click still opens Release Detail through the action href', async ({ page, context }) => {
  await withDashboard(async ({ origin, alpha }) => {
    await openDashboard(page, origin);
    const [tab] = await Promise.all([
      context.waitForEvent('page'),
      trigger(page, alpha).click({ modifiers: ['Control'] }),
    ]);
    await tab.waitForLoadState();
    expect(tab.url()).toBe(`${origin}/releases/${alpha.id}?publish=1`);
    await tab.close();
    await expect(dialog(page)).toHaveCount(0);
  });
});

test('Validation stays in the dialog with its values and date control', async ({ page }) => {
  await withDashboard(async ({ origin, alpha, releaseService }) => {
    await openDashboard(page, origin);
    await trigger(page, alpha).click();
    const date = dialog(page).locator('[name="publishedDate"]');
    await page.evaluate(() => { document.querySelector('#release-publish-date').type = 'text'; });
    await date.fill('2031-02-31');
    await dialog(page).locator('[data-dialog-submit]').click();
    await expect(dialog(page).locator('#release-publish-date-error')).toBeVisible();
    await expect(date).toHaveValue('2031-02-31');
    await page.evaluate(() => { document.querySelector('#release-publish-date').type = 'date'; });
    await date.fill('2031-03-04');
    await dialog(page).locator('.date-picker-trigger').click();
    await expect(dialog(page).locator('[data-date-picker-panel]')).toBeVisible();
    await page.keyboard.press('Escape');
    expect(releaseService.findRelease(alpha.id).published_date).toBeNull();
    expect(await stayed(page)).toBe(true);
  });
});

test('A release changed elsewhere is refused safely, before and after opening', async ({ page }) => {
  await withDashboard(async ({ origin, alpha, beta, gamma, releaseService, project, projectService }) => {
    const { posts } = watchPage(page);
    await openDashboard(page, origin);

    // Already published before the click: nothing opens and the row updates.
    releaseService.publishRelease(alpha.id, localDate(0), { projectStatus: '' });
    await trigger(page, alpha).click();
    await expect(feedback(page)).toContainText('can no longer be published');
    await expect(feedback(page)).toHaveClass(/notice--error/);
    await expect(trigger(page, alpha)).toHaveCount(0);
    await expect(dialog(page)).toHaveCount(0);

    // Published while open: the refusal is shown, then dismissal refreshes.
    await trigger(page, beta).click();
    await expect(dialog(page)).toBeVisible();
    releaseService.publishRelease(beta.id, localDate(0), { projectStatus: '' });
    await dialog(page).locator('[data-dialog-submit]').click();
    await expect(dialog(page).locator('[data-dialog-submit]')).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expect(trigger(page, beta)).toHaveCount(0);
    await expect(feedback(page)).not.toContainText('was published');

    // Parent project archived while open: reported as an error, never a success.
    await trigger(page, gamma).click();
    await expect(dialog(page)).toBeVisible();
    projectService.archive(project.id);
    await dialog(page).locator('[data-dialog-submit]').click();
    await expect(dialog(page).locator('[data-dialog-submit]')).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(feedback(page)).toHaveClass(/notice--error/);
    await expect(feedback(page)).not.toContainText('was published');
    expect(releaseService.findRelease(gamma.id).published_date).toBeNull();
    await expect.poll(() => activeTag(page)).not.toBe('BODY');
    expect(posts).toEqual([`/releases/${beta.id}/publish`, `/releases/${gamma.id}/publish`]);
    expect(await stayed(page)).toBe(true);
  });
});

test('A lost publish response offers a GET-only status check', async ({ page }) => {
  await withDashboard(async ({ origin, alpha, releaseService }) => {
    const { posts } = watchPage(page);
    await openDashboard(page, origin);
    await page.route(`**/releases/${alpha.id}/publish`, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await route.fetch();
      return route.abort();
    });
    await trigger(page, alpha).click();
    await dialog(page).locator('[data-dialog-submit]').click();
    const check = dialog(page).locator('[data-release-publish-check]');
    await expect(check).toBeVisible();
    await expect(dialog(page).locator('[data-dialog-submit]')).toBeDisabled();
    await check.click();
    await expect(feedback(page)).toContainText('“Alpha overdue” was published.');
    await expect(trigger(page, alpha)).toHaveCount(0);
    expect(posts).toEqual([`/releases/${alpha.id}/publish`]);
    expect(releaseService.findRelease(alpha.id).published_date).not.toBeNull();
  });
});

test('A failed refresh keeps the confirmation and recovers with GET only', async ({ page }) => {
  await withDashboard(async ({ origin, alpha, beta }) => {
    const { posts } = watchPage(page);
    await openDashboard(page, origin);
    let failRefresh = true;
    const refreshes = [];
    await page.route(`${origin}/`, async (route) => {
      if (route.request().resourceType() !== 'fetch') return route.continue();
      refreshes.push(route.request().method());
      return failRefresh ? route.fulfill({ status: 500, body: 'no' }) : route.continue();
    });
    await trigger(page, alpha).click();
    await dialog(page).locator('[data-dialog-submit]').click();

    await expect(banner(page)).toBeVisible();
    await expect(banner(page)).toContainText('“Alpha overdue” was published, but');
    await expect(feedback(page)).toContainText('“Alpha overdue” was published.');
    await expect(feedback(page)).toHaveClass(/notice--success/);
    await expect(trigger(page, alpha)).toHaveCount(0);

    // While it is pending another Publish leads to Retry refresh instead.
    await trigger(page, beta).click();
    await expect(page.locator('[data-dashboard-sync-retry]')).toBeFocused();
    await expect(dialog(page)).toHaveCount(0);

    await page.locator('[data-dashboard-sync-retry]').click();
    await expect(banner(page)).toContainText('couldn’t refresh');
    failRefresh = false;
    await page.locator('[data-dashboard-sync-retry]').click();
    await expect(banner(page)).toContainText('Dashboard refreshed');
    await expect(page.locator(`.dashboard-recent-item[data-release-id="${alpha.id}"]`)).toBeVisible();
    expect(posts).toEqual([`/releases/${alpha.id}/publish`]);
    expect(refreshes.every((method) => method === 'GET')).toBe(true);

    await trigger(page, beta).click();
    await expect(dialog(page)).toContainText('Beta overdue');
  });
});

test('Focus survives when the original Publish action is replaced or leaves', async ({ page }) => {
  await withDashboard(async ({ origin, alpha, beta, releaseService }) => {
    await openDashboard(page, origin);
    await trigger(page, alpha).click();
    await expect(dialog(page)).toBeVisible();
    // A refresh replaces the opener while the dialog is open.
    await page.evaluate(async () => {
      const { refreshDashboard } = await import('/client/dashboard.js');
      await refreshDashboard(document);
    });
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expect(trigger(page, alpha)).toBeFocused();

    // Published elsewhere while open: the action is gone after the refresh.
    await trigger(page, alpha).click();
    await expect(dialog(page)).toBeVisible();
    releaseService.publishRelease(alpha.id, localDate(0), { projectStatus: '' });
    await page.evaluate(async () => {
      const { refreshDashboard } = await import('/client/dashboard.js');
      await refreshDashboard(document);
    });
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.locator('#dashboard-scheduled-heading')).toBeFocused();
    await expect(trigger(page, beta)).toBeVisible();
  });
});

test('Overlapping and delayed loads never open the wrong release', async ({ page }) => {
  await withDashboard(async ({ origin, alpha, beta, gamma }) => {
    await openDashboard(page, origin);
    const held = new Map();
    await page.route('**/releases/*/publish', async (route) => {
      const id = new URL(route.request().url()).pathname.split('/')[2];
      await new Promise((resolve) => { held.set(id, resolve); });
      await route.continue();
    });
    await trigger(page, alpha).click();
    await trigger(page, beta).click();
    await expect.poll(() => held.size).toBe(2);
    // Newest first, then the older response arrives and must change nothing.
    held.get(String(beta.id))();
    await expect(dialog(page)).toContainText('Beta overdue');
    await dialog(page).locator('[name="publishedDate"]').fill('2031-05-06');
    held.get(String(alpha.id))();
    await page.waitForTimeout(200);
    await expect(dialog(page)).toContainText('Beta overdue');
    await expect(dialog(page).locator('[name="publishedDate"]')).toHaveValue('2031-05-06');
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);

    // A response landing after another dialog opened populates nothing.
    held.clear();
    await trigger(page, gamma).click();
    await expect.poll(() => held.size).toBe(1);
    await page.locator('a[data-dialog-open="project-create-dialog"]').click();
    await expect(page.locator('#project-create-dialog')).toBeVisible();
    held.get(String(gamma.id))();
    await page.waitForTimeout(200);
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.locator('#project-create-dialog')).toBeVisible();
  });
});

// Holds the model GETs of the releases named by shouldHold until they are released.
async function holdPublishLoads(page, shouldHold = () => true) {
  const loads = [];
  await page.route('**/releases/*/publish', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const id = new URL(route.request().url()).pathname.split('/')[2];
    const load = { id, release: () => {} };
    loads.push(load);
    if (shouldHold(id, loads)) await new Promise((resolve) => { load.release = resolve; });
    return route.continue();
  });
  return loads;
}

// Lets a held load respond and the page handle that response.
async function releaseLoad(page, load) {
  const answered = page.waitForResponse((response) => response.request().method() === 'GET'
    && new URL(response.url()).pathname === `/releases/${load.id}/publish`);
  load.release();
  await (await answered).finished();
  await page.evaluate(() => new Promise((resolve) => { setTimeout(resolve, 0); }));
}

const newProjectTrigger = (page) => page.locator('a[data-dialog-open="project-create-dialog"]');
const newProjectDialog = (page) => page.locator('#project-create-dialog');

test('Publish works again after another dialog superseded its load', async ({ page }) => {
  await withDashboard(async ({ origin, alpha, beta, releaseService }) => {
    const { errors, navigations, posts } = watchPage(page);
    await openDashboard(page, origin);
    navigations.length = 0;
    const loads = await holdPublishLoads(page, (id, all) => all.length === 1);

    await trigger(page, alpha).click();
    await expect.poll(() => loads.length).toBe(1);
    await newProjectTrigger(page).click();
    await expect(newProjectDialog(page)).toBeVisible();
    await newProjectDialog(page).locator('[name="title"]').fill('Kept draft');

    // The old answer replaces nothing and takes nothing from the newer dialog.
    await releaseLoad(page, loads[0]);
    await expect(dialog(page)).toHaveCount(0);
    await expect(newProjectDialog(page)).toBeVisible();
    await expect(newProjectDialog(page).locator('[name="title"]')).toHaveValue('Kept draft');
    expect(await page.evaluate(() => document.getElementById('project-create-dialog').contains(document.activeElement))).toBe(true);

    await page.keyboard.press('Escape');
    await expect(newProjectDialog(page)).not.toBeVisible();
    await expect(newProjectTrigger(page)).toBeFocused();
    await expect(dialog(page)).toHaveCount(0);

    // The retried click loads a fresh model for the same release.
    await trigger(page, alpha).click();
    await expect.poll(() => loads.length).toBe(2);
    await expect(dialog(page)).toContainText('Alpha overdue');
    expect(loads.map(({ id }) => id)).toEqual([String(alpha.id), String(alpha.id)]);
    expect(posts).toEqual([]);

    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expect(trigger(page, alpha)).toBeFocused();

    await trigger(page, alpha).click();
    await expect(dialog(page)).toBeVisible();
    await dialog(page).locator('[data-dialog-submit]').click();
    await expect(feedback(page)).toContainText('“Alpha overdue” was published.');
    await expect(trigger(page, alpha)).toHaveCount(0);
    await expect(trigger(page, beta)).toBeVisible();
    expect(posts).toEqual([`/releases/${alpha.id}/publish`]);
    expect(releaseService.findRelease(alpha.id).published_date).not.toBeNull();
    expect(navigations).toEqual([]);
    expect(await stayed(page)).toBe(true);
    expect(errors).toEqual([]);
  });
});

test('A load superseded by a dialog already dismissed stays superseded', async ({ page }) => {
  await withDashboard(async ({ origin, alpha, beta }) => {
    const { navigations, posts } = watchPage(page);
    await openDashboard(page, origin);
    navigations.length = 0;
    const loads = await holdPublishLoads(page, (id, all) => all.length === 1 || all.length === 3);

    // Answering after the other dialog has gone, it still opens nothing.
    await trigger(page, alpha).click();
    await expect.poll(() => loads.length).toBe(1);
    await newProjectTrigger(page).click();
    await page.keyboard.press('Escape');
    await expect(newProjectTrigger(page)).toBeFocused();
    await releaseLoad(page, loads[0]);
    await expect(dialog(page)).toHaveCount(0);
    await expect(newProjectTrigger(page)).toBeFocused();

    await trigger(page, alpha).click();
    await expect(dialog(page)).toContainText('Alpha overdue');
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);

    // A click while the superseded load is still pending starts a fresh one,
    // and the old answer then leaves the opened dialog and its draft alone.
    await trigger(page, beta).click();
    await expect.poll(() => loads.length).toBe(3);
    await newProjectTrigger(page).click();
    await page.keyboard.press('Escape');
    await expect(newProjectTrigger(page)).toBeFocused();
    await trigger(page, beta).click();
    await expect(dialog(page)).toContainText('Beta overdue');
    expect(loads).toHaveLength(4);
    await dialog(page).locator('[name="publishedDate"]').fill('2031-05-06');
    await releaseLoad(page, loads[2]);
    await expect(dialog(page).locator('[name="publishedDate"]')).toHaveValue('2031-05-06');
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expect(trigger(page, beta)).toBeFocused();
    expect(posts).toEqual([]);
    expect(navigations).toEqual([]);
  });
});

test('An older load cannot release the guard of a newer one', async ({ page }) => {
  await withDashboard(async ({ origin, alpha, beta }) => {
    await openDashboard(page, origin);
    const loads = await holdPublishLoads(page);

    await trigger(page, alpha).click();
    await trigger(page, alpha).click();
    await expect.poll(() => loads.length).toBe(1);
    await trigger(page, beta).click();
    await expect.poll(() => loads.length).toBe(2);

    // With the superseded Alpha load settled, Beta is still the one loading.
    await releaseLoad(page, loads[0]);
    await trigger(page, beta).click();
    await page.evaluate(() => new Promise((resolve) => { setTimeout(resolve, 0); }));
    expect(loads).toHaveLength(2);

    loads[1].release();
    await expect(dialog(page)).toContainText('Beta overdue');
  });
});

test('A failed load reports locally and Publish can be tried again', async ({ page }) => {
  await withDashboard(async ({ origin, alpha }) => {
    const { navigations, posts } = watchPage(page);
    await openDashboard(page, origin);
    navigations.length = 0;
    let fail = true;
    await page.route(`**/releases/${alpha.id}/publish`, (route) => (fail
      ? route.fulfill({ status: 500, json: {} }) : route.continue()));
    await trigger(page, alpha).click();
    await expect(feedback(page)).toContainText('could not be loaded');
    await expect(feedback(page)).toHaveClass(/notice--error/);
    await expect(dialog(page)).toHaveCount(0);

    fail = false;
    await trigger(page, alpha).click();
    await expect(dialog(page)).toContainText('Alpha overdue');
    expect(posts).toEqual([]);
    expect(navigations).toEqual([]);
  });
});

test('Title cards and navigation keep working around Publish', async ({ page }) => {
  await withDashboard(async ({ origin, alpha }) => {
    await openDashboard(page, origin);
    const row = page.locator(`[data-dashboard-release-row][data-release-id="${alpha.id}"]`);
    const title = row.locator('.dashboard-item-title [data-calendar-info-trigger]');
    const card = page.locator(`#${await title.getAttribute('aria-controls')}`);
    await title.hover();
    await expect(card).toBeVisible();
    await title.click();
    await trigger(page, alpha).click();
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await title.hover();
    await expect(card).toBeVisible();
    await title.click();
    const open = card.locator(`a[href="/releases/${alpha.id}"]`).first();
    await open.click();
    await expect(page).toHaveURL(`${origin}/releases/${alpha.id}`);
  });
});

test('A publication with social preparation launches the companion once', async ({ page }) => {
  await withDashboard(async ({ origin, alpha, beta }) => {
    const { navigations } = watchPage(page);
    const activations = [];
    await page.route('**/social-prep/*', (route) => {
      activations.push(new URL(route.request().url()).pathname);
      return route.fulfill({ status: 500, json: {} });
    });
    await openDashboard(page, origin);
    navigations.length = 0;
    await page.route(`${origin}/`, (route) => (route.request().resourceType() === 'fetch'
      ? route.fulfill({ status: 500, body: 'no' }) : route.continue()));
    await trigger(page, alpha).click();
    await dialog(page).locator('[data-dialog-submit]').click();
    await expect.poll(() => activations).toEqual([`/releases/${alpha.id}/social-prep/activate`]);

    // Its status and explicit action stay here; retrying the refresh does not launch again.
    const entry = page.locator('.dashboard-publish-companion');
    await expect(entry).toContainText('Could not open publishing companion.');
    const action = entry.locator('[data-release-social-prep-companion-action]');
    await expect(action).toBeEnabled();
    await page.unroute(`${origin}/`);
    await page.locator('[data-dashboard-sync-retry]').click();
    await expect(banner(page)).toContainText('Dashboard refreshed');
    await page.waitForTimeout(200);
    expect(activations).toHaveLength(1);
    await action.click();
    await expect.poll(() => activations).toHaveLength(2);
    expect(navigations).toEqual([]);

    // No Social Preparation model is needed to keep publishing the next release.
    await trigger(page, beta).click();
    await expect(dialog(page)).toContainText('Beta overdue');
  }, { platforms: ['x'] });
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

// What the Posting Helper records through its capability-protected routes.
function helperPosts(db, release) {
  db.prepare(`UPDATE release_social_platforms SET status = 'posted', posted_at = datetime('now')
    WHERE release_id = ? AND platform = 'x'`).run(release.id);
}

function watchCompanion(page, releases) {
  const paths = new Set(['/', ...releases.map(({ id }) => `/releases/${id}`)]);
  const gets = [];
  const launches = [];
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (request.resourceType() === 'fetch' && request.method() === 'GET' && paths.has(pathname)) gets.push(pathname);
    if (request.method() === 'POST' && pathname.includes('/social-prep/')) launches.push(pathname);
  });
  return { gets, launches };
}

const companionEntry = (page, release) => page.locator(`[data-dashboard-publish-companion="${release.id}"]`);
const companionAction = (page, release) => companionEntry(page, release).locator('[data-release-social-prep-companion-action]');
const companionCheck = (page, release) => companionEntry(page, release).locator('[data-dashboard-publish-companion-check]');
const socialBadge = (page, release) => page
  .locator(`.dashboard-recent-item[data-release-id="${release.id}"] .status-badge`, { hasText: 'X ·' }).first();

// Publishes through the dialog and waits for the launched control to settle.
async function publishAndLaunch(page, release) {
  await trigger(page, release).click();
  await dialog(page).locator('[data-dialog-submit]').click();
  await expect(companionAction(page, release)).toHaveText('Retry opening companion');
  await expect(companionAction(page, release)).toBeEnabled();
}

test('A completed Posting Helper operation shows on the Dashboard after one GET-only return', async ({ page }) => {
  await withDashboard(async ({ origin, alpha, db }) => {
    const { errors, navigations, posts } = watchPage(page);
    const { gets, launches } = watchCompanion(page, [alpha]);
    await openDashboard(page, origin);
    navigations.length = 0;
    const filter = page.locator('[data-dashboard-status-filter]').last();
    await filter.click();
    const filterValue = await filter.getAttribute('data-dashboard-status-filter');

    await publishAndLaunch(page, alpha);
    expect(posts).toEqual([`/releases/${alpha.id}/publish`, `/releases/${alpha.id}/social-prep/activate`]);
    expect(launches).toHaveLength(1);
    await expect(socialBadge(page, alpha)).toHaveText('X · Not attempted');

    // An unrelated dialog and its draft are open across the return.
    await newProjectTrigger(page).click();
    await newProjectDialog(page).locator('[name="title"]').fill('Kept draft');
    gets.length = 0;

    await leavePage(page);
    helperPosts(db, alpha);
    await returnToPage(page);

    await expect(socialBadge(page, alpha)).toHaveText('X · Posted');
    // The render no longer offers this release's retry, so the control leaves.
    await expect(companionEntry(page, alpha)).toHaveCount(0);
    await expect(page.locator('[data-dashboard-publish-companions]')).toBeHidden();
    await expect.poll(() => [...gets].sort()).toEqual(['/', `/releases/${alpha.id}`]);
    await expect(banner(page)).toBeHidden();

    await expect(newProjectDialog(page)).toBeVisible();
    await expect(newProjectDialog(page).locator('[name="title"]')).toHaveValue('Kept draft');
    expect(await page.evaluate(() => document.getElementById('project-create-dialog').contains(document.activeElement))).toBe(true);
    await expect(page.locator(`[data-dashboard-status-filter="${filterValue}"]`)).toHaveAttribute('aria-pressed', 'true');

    expect(launches).toHaveLength(1);
    expect(posts).toHaveLength(2);
    expect(page.url()).toBe(`${origin}/`);
    expect(navigations).toEqual([]);
    expect(await stayed(page)).toBe(true);
    expect(errors).toEqual([]);
  }, { platforms: ['x'] });
});

test('Focus on a withdrawn control moves somewhere valid', async ({ page }) => {
  await withDashboard(async ({ origin, alpha, db }) => {
    await openDashboard(page, origin);
    await publishAndLaunch(page, alpha);
    await companionAction(page, alpha).focus();
    await leavePage(page);
    helperPosts(db, alpha);
    await returnToPage(page);
    await expect(companionEntry(page, alpha)).toHaveCount(0);
    await expect(page.locator('#dashboard-scheduled-heading')).toBeFocused();
  }, { platforms: ['x'] });
});

test('Repeated returns fold into one more refresh and never launch again', async ({ page }) => {
  await withDashboard(async ({ origin, alpha }) => {
    const { gets, launches } = watchCompanion(page, [alpha]);
    await openDashboard(page, origin);
    await publishAndLaunch(page, alpha);
    gets.length = 0;

    // Returning without leaving first is not a return.
    await returnToPage(page);
    await page.waitForTimeout(200);
    expect(gets).toEqual([]);

    const held = [];
    await page.route(`${origin}/`, async (route) => {
      if (route.request().resourceType() !== 'fetch') return route.continue();
      await new Promise((resolve) => { held.push(resolve); });
      return route.continue();
    });
    for (let index = 0; index < 3; index += 1) {
      await leavePage(page);
      await returnToPage(page);
    }
    await expect.poll(() => held.length).toBe(1);
    await expect(companionAction(page, alpha)).toBeDisabled();
    held[0]();
    await expect.poll(() => held.length).toBe(2);
    held[1]();
    await expect(companionAction(page, alpha)).toBeEnabled();
    await page.waitForTimeout(200);
    expect(gets.filter((pathname) => pathname === '/')).toHaveLength(2);
    expect(launches).toHaveLength(1);
  }, { platforms: ['x'] });
});

test('A return with no change keeps a valid retry, which still works when clicked', async ({ page }) => {
  await withDashboard(async ({ origin, alpha, db }) => {
    const { posts } = watchPage(page);
    const { launches } = watchCompanion(page, [alpha]);
    await openDashboard(page, origin);
    await publishAndLaunch(page, alpha);
    await companionAction(page, alpha).focus();

    await leavePage(page);
    await returnToPage(page);
    await expect(companionAction(page, alpha)).toBeEnabled();
    await expect(companionAction(page, alpha)).toBeFocused();
    await expect(companionAction(page, alpha)).toHaveText('Retry opening companion');
    // The activation itself left the platform pending; the helper did nothing.
    await expect(socialBadge(page, alpha)).toHaveText('X · Pending');
    await expect(banner(page)).toBeHidden();
    expect(launches).toHaveLength(1);

    // The replacement is bound: an explicit retry reissues the current session.
    await companionAction(page, alpha).click();
    await expect.poll(() => launches).toEqual([
      `/releases/${alpha.id}/social-prep/activate`, `/releases/${alpha.id}/social-prep/reissue`,
    ]);
    await expect(companionAction(page, alpha)).toBeEnabled();
    await expect(companionEntry(page, alpha).locator('[data-release-social-prep-companion-status]')).not.toHaveText('Could not open publishing companion.');

    // And its later return reconciles too.
    await leavePage(page);
    helperPosts(db, alpha);
    await returnToPage(page);
    await expect(companionEntry(page, alpha)).toHaveCount(0);
    expect(posts.filter((pathname) => pathname.endsWith('/publish'))).toHaveLength(1);
    expect(launches).toHaveLength(2);
  }, { platforms: ['x'] });
});

test('A failed return check keeps the truth, withdraws the retry and recovers with GET only', async ({ page }) => {
  await withDashboard(async ({ origin, alpha, beta, db }) => {
    const { posts } = watchPage(page);
    const { launches } = watchCompanion(page, [alpha]);
    await openDashboard(page, origin);
    await publishAndLaunch(page, alpha);
    const postsBefore = posts.length;
    const fail = (route) => (route.request().resourceType() === 'fetch'
      ? route.fulfill({ status: 500, body: 'no' }) : route.continue());
    await page.route(`${origin}/`, fail);
    await page.route(`${origin}/releases/${alpha.id}`, fail);

    await leavePage(page);
    helperPosts(db, alpha);
    await returnToPage(page);

    await expect(banner(page)).toContainText('couldn’t check for changes made in the Posting Helper');
    await expect(banner(page)).not.toContainText('failed');
    await expect(socialBadge(page, alpha)).toHaveText('X · Not attempted');
    await expect(companionAction(page, alpha)).toBeDisabled();
    await expect(page.locator('[data-dashboard-sync-reload]')).toBeVisible();

    // Recovery is still failing: nothing is relaunched.
    await page.locator('[data-dashboard-sync-retry]').click();
    await expect(banner(page)).toContainText('Try again, or reload the page.');
    await expect(companionAction(page, alpha)).toBeDisabled();

    // While the Dashboard itself is unavailable, the page-level pause applies.
    await trigger(page, beta).click();
    await expect(page.locator('[data-dashboard-sync-retry]')).toBeFocused();
    await expect(dialog(page)).toHaveCount(0);

    // Only the release check fails now: the status is current and the pause ends.
    await page.unroute(`${origin}/`);
    await leavePage(page);
    await returnToPage(page);
    await expect(socialBadge(page, alpha)).toHaveText('X · Posted');
    await expect(banner(page)).toContainText('Dashboard refreshed');
    await expect(companionAction(page, alpha)).toBeDisabled();
    await expect(companionCheck(page, alpha)).toBeVisible();

    await page.unroute(`${origin}/releases/${alpha.id}`);
    await companionCheck(page, alpha).click();
    await expect(companionEntry(page, alpha)).toHaveCount(0);
    expect(posts).toHaveLength(postsBefore);
    expect(launches).toHaveLength(1);

    await trigger(page, beta).click();
    await expect(dialog(page)).toContainText('Beta overdue');
  }, { platforms: ['x'] });
});

// ─── A companion control that could not be checked ──────────────────────

const failFetch = (route) => (route.request().resourceType() === 'fetch'
  ? route.fulfill({ status: 500, body: 'no' }) : route.continue());

// An undated release of another project, for quick scheduling.
function seedUndated(db, projectService, title) {
  const other = projectService.create({ title: `${title} project` });
  return createReleaseRepository(db).create({ projectId: other.id, title, description: '', notes: '' });
}

test('A failed companion check blocks only that control and recovers with one GET', async ({ page }) => {
  await withDashboard(async ({ origin, alpha, beta, db, projectService, releaseService }) => {
    // Beta belongs to a different project than the published release.
    const otherProject = projectService.create({ title: 'Beta project' });
    db.prepare('UPDATE releases SET project_id = ? WHERE id = ?').run(otherProject.id, beta.id);
    const undated = seedUndated(db, projectService, 'Undated quick');
    const drafted = seedUndated(db, projectService, 'Undated draft');

    const { errors, navigations, posts } = watchPage(page);
    const { gets, launches } = watchCompanion(page, [alpha]);
    const modelGets = [];
    page.on('request', (request) => {
      if (request.url().includes(`/releases/${beta.id}/`) && request.method() === 'GET') modelGets.push(request.url());
    });
    await openDashboard(page, origin);
    navigations.length = 0;

    await publishAndLaunch(page, alpha);
    expect(posts.filter((pathname) => pathname === `/releases/${alpha.id}/publish`)).toHaveLength(1);
    expect(launches).toHaveLength(1);
    await page.route(`${origin}/releases/${alpha.id}`, failFetch);
    gets.length = 0;

    await leavePage(page);
    helperPosts(db, alpha);
    await returnToPage(page);

    // The Dashboard refresh succeeded, so its status is current and nothing is paused.
    await expect(socialBadge(page, alpha)).toHaveText('X · Posted');
    await expect(companionCheck(page, alpha)).toBeVisible();
    await expect(companionAction(page, alpha)).toBeDisabled();
    await expect(companionEntry(page, alpha)).toContainText('couldn’t check whether this action is still available');
    await expect(companionEntry(page, alpha)).not.toContainText('failed');
    await expect(banner(page)).toBeHidden();
    await expect.poll(() => [...gets].sort()).toEqual(['/', `/releases/${alpha.id}`]);

    // The stale action sends nothing even if it is activated.
    await page.evaluate((id) => {
      document.querySelector(`[data-dashboard-publish-companion="${id}"] [data-release-social-prep-companion-action]`).click();
    }, alpha.id);
    expect(launches).toHaveLength(1);

    // Publish still works for another project's release, with a fresh model.
    await trigger(page, beta).click();
    await expect(dialog(page)).toContainText('Beta overdue');
    expect(modelGets.length).toBeGreaterThan(0);
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expect(trigger(page, beta)).toBeFocused();

    // Quick scheduling still saves.
    const row = page.locator(`[data-dashboard-schedule][data-release-id="${undated.id}"]`);
    await row.locator('[data-dashboard-schedule-pick]').first().click();
    await expect(row.locator('[data-dashboard-schedule-status]')).toContainText('Scheduled for');
    expect(posts).toContain(`/releases/${undated.id}/schedule`);
    expect(releaseService.findRelease(undated.id).planned_date).not.toBeNull();
    await expect(banner(page)).toBeHidden();
    // That refresh could not confirm the control, so it stays withdrawn.
    await expect(companionAction(page, alpha)).toBeDisabled();

    // Recovery: a failure stays local, and then one GET reconciles the control.
    const draft = page.locator(`[data-dashboard-schedule][data-release-id="${drafted.id}"] [data-dashboard-schedule-date]`);
    await draft.evaluate((input, value) => { input.value = value; input.dataset.sameInput = 'yes'; }, '2027-03-04');
    gets.length = 0;
    await companionCheck(page, alpha).click();
    await expect.poll(() => gets).toEqual([`/releases/${alpha.id}`]);
    await expect(companionCheck(page, alpha)).toHaveText('Check again');
    await expect(companionCheck(page, alpha)).toBeFocused();
    await expect(companionAction(page, alpha)).toBeDisabled();

    await page.unroute(`${origin}/releases/${alpha.id}`);
    const postsBefore = posts.length;
    gets.length = 0;
    await companionCheck(page, alpha).click();
    await expect(companionEntry(page, alpha)).toHaveCount(0);
    expect(gets).toEqual([`/releases/${alpha.id}`]);
    expect(posts).toHaveLength(postsBefore);
    expect(launches).toHaveLength(1);
    expect(posts.filter((pathname) => pathname.endsWith('/publish'))).toHaveLength(1);

    await expect(draft).toHaveValue('2027-03-04');
    await expect(draft).toHaveAttribute('data-same-input', 'yes');
    expect(page.url()).toBe(`${origin}/`);
    expect(navigations).toEqual([]);
    expect(await stayed(page)).toBe(true);
    expect(errors).toEqual([]);
  }, { platforms: ['x'] });
});

test('A verified retry is restored and stays usable after a failed check', async ({ page }) => {
  await withDashboard(async ({ origin, alpha }) => {
    const { launches } = watchCompanion(page, [alpha]);
    await openDashboard(page, origin);
    await publishAndLaunch(page, alpha);
    await page.route(`${origin}/releases/${alpha.id}`, failFetch);
    await companionAction(page, alpha).focus();
    await leavePage(page);
    await returnToPage(page);

    // Focus on the withdrawn control moves to its own recovery, not the page's.
    await expect(companionCheck(page, alpha)).toBeFocused();
    await page.unroute(`${origin}/releases/${alpha.id}`);
    await companionCheck(page, alpha).click();

    await expect(companionCheck(page, alpha)).toHaveCount(0);
    await expect(companionAction(page, alpha)).toBeEnabled();
    await expect(companionAction(page, alpha)).toBeFocused();
    expect(launches).toHaveLength(1);
    await companionAction(page, alpha).click();
    await expect.poll(() => launches).toEqual([
      `/releases/${alpha.id}/social-prep/activate`, `/releases/${alpha.id}/social-prep/reissue`,
    ]);
  }, { platforms: ['x'] });
});

test('One release’s failed check leaves another release’s control valid', async ({ page }) => {
  await withDashboard(async ({ origin, alpha, beta, gamma, db }) => {
    const { launches } = watchCompanion(page, [alpha, beta]);
    await openDashboard(page, origin);
    await publishAndLaunch(page, alpha);
    await publishAndLaunch(page, beta);
    await page.route(`${origin}/releases/${alpha.id}`, failFetch);

    await leavePage(page);
    helperPosts(db, alpha);
    await returnToPage(page);

    await expect(companionCheck(page, alpha)).toBeVisible();
    await expect(companionAction(page, alpha)).toBeDisabled();
    await expect(companionAction(page, beta)).toBeEnabled();
    await expect(companionCheck(page, beta)).toHaveCount(0);
    await expect(banner(page)).toBeHidden();

    await trigger(page, gamma).click();
    await expect(dialog(page)).toContainText('Gamma today');
    await page.keyboard.press('Escape');
    expect(launches).toHaveLength(2);
  }, { platforms: ['x'] });
});

test('An older failed check cannot overwrite a newer verified control', async ({ page }) => {
  await withDashboard(async ({ origin, alpha }) => {
    await openDashboard(page, origin);
    await publishAndLaunch(page, alpha);
    await page.route(`${origin}/releases/${alpha.id}`, failFetch);
    await leavePage(page);
    await returnToPage(page);
    await expect(companionCheck(page, alpha)).toBeVisible();

    // The return's check is held and fails only after a newer one succeeded.
    await page.unroute(`${origin}/releases/${alpha.id}`);
    let answerOld;
    let captured = false;
    await page.route(`${origin}/releases/${alpha.id}`, async (route) => {
      if (route.request().resourceType() !== 'fetch' || captured) return route.continue();
      captured = true;
      await new Promise((resolve) => { answerOld = resolve; });
      return route.fulfill({ status: 500, body: 'no' }).catch(() => {});
    });
    await leavePage(page);
    await returnToPage(page);
    await expect.poll(() => typeof answerOld).toBe('function');

    await companionCheck(page, alpha).click();
    await expect(companionCheck(page, alpha)).toHaveCount(0);
    await expect(companionAction(page, alpha)).toBeEnabled();

    answerOld();
    await page.waitForTimeout(200);
    await expect(companionCheck(page, alpha)).toHaveCount(0);
    await expect(companionAction(page, alpha)).toBeEnabled();
    await expect(banner(page)).toBeHidden();
  }, { platforms: ['x'] });
});

// ─── A return's check held at the Dashboard refresh ─────────────────────

const OPEN_LABEL = 'Open publishing companion';
const RETRY_LABEL = 'Retry opening companion';
const UNVERIFIED_MESSAGE = 'couldn’t check whether this action is still available';

const companionElement = (page, release) => companionEntry(page, release).locator('[data-release-social-prep-companion]');

// The old attempt ends, so the server offers a new activation instead of a retry.
function expireAttempt(db, release) {
  db.prepare(`UPDATE social_prep_sessions SET state = 'expired' WHERE release_id = ?`).run(release.id);
}

// Leaves a control showing its own Check again, from a failed return.
async function failReturnCheck(page, origin, release) {
  await page.route(`${origin}/releases/${release.id}`, failFetch);
  await leavePage(page);
  await returnToPage(page);
  await expect(companionCheck(page, release)).toBeVisible();
  await expect(banner(page)).toBeHidden();
  await page.unroute(`${origin}/releases/${release.id}`);
}

// Starts a return whose checks finish while its Dashboard response is held.
// `oldCheck` answers those checks; every later check reaches `nextCheck`, or
// the server without one. The returned function releases the Dashboard response
// and resolves once the pass has run its adoption.
async function holdReturnAtDashboard(page, origin, releases, { oldCheck = (route) => route.continue(), dashboard } = {}) {
  const hold = { nextCheck: (route) => route.continue() };
  let answerDashboard;
  let captured = false;
  await page.route(new RegExp(`^${origin}/(\\?.*)?$`, 'u'), async (route) => {
    if (route.request().resourceType() !== 'fetch' || captured) return route.continue();
    captured = true;
    const response = dashboard ? null : await route.fetch();
    await new Promise((resolve) => { answerDashboard = resolve; });
    if (dashboard) return dashboard(route);
    return route.fulfill({ response }).catch(() => {});
  });

  const answered = new Set();
  await Promise.all(releases.map((release) => page.route(`${origin}/releases/${release.id}`, async (route) => {
    if (route.request().resourceType() !== 'fetch') return route.continue();
    if (answered.has(release.id)) return hold.nextCheck(route, release);
    answered.add(release.id);
    return oldCheck(route, release);
  })));

  const finished = new Set();
  const onFinished = (request) => {
    if (request.resourceType() === 'fetch') finished.add(new URL(request.url()).pathname);
  };
  page.on('requestfinished', onFinished);

  await leavePage(page);
  await returnToPage(page);
  await expect.poll(() => typeof answerDashboard).toBe('function');
  await expect.poll(() => releases.every(({ id }) => finished.has(`/releases/${id}`))).toBe(true);
  page.off('requestfinished', onFinished);
  // A finished request has reached the page; a turn of its loop lets the body be parsed.
  await page.evaluate(() => new Promise((resolve) => { setTimeout(resolve, 0); }));

  hold.release = async () => {
    answerDashboard();
    // The refresh settles, then the pass adopts before the page's next task.
    await page.waitForFunction(() => !document.__creatorCrateDashboardLiveRegion?.dashboardRefresh);
    await page.evaluate(() => new Promise((resolve) => { setTimeout(resolve, 0); }));
  };
  return hold;
}

// Marks the live control, so that replacing it cannot go unnoticed.
const markControl = (page, release) => companionElement(page, release)
  .evaluate((element) => { element.__current = true; });
const controlIsMarked = (page, release) => companionElement(page, release)
  .evaluate((element) => element.__current === true);

test('An older successful check held at the refresh cannot replace a newer activation', async ({ page }) => {
  await withDashboard(async ({ origin, alpha, db }) => {
    const { errors, navigations, posts } = watchPage(page);
    const { launches } = watchCompanion(page, [alpha]);
    await openDashboard(page, origin);
    navigations.length = 0;
    await publishAndLaunch(page, alpha);
    await failReturnCheck(page, origin, alpha);
    const postsBefore = posts.length;

    // The return's check saw the attempt that is about to expire.
    const held = await holdReturnAtDashboard(page, origin, [alpha]);
    expireAttempt(db, alpha);

    await companionCheck(page, alpha).focus();
    await page.keyboard.press('Enter');
    await expect(companionCheck(page, alpha)).toHaveCount(0);
    await expect(companionAction(page, alpha)).toHaveText(OPEN_LABEL);
    await expect(companionElement(page, alpha)).toHaveAttribute('data-action-mode', 'activate');
    await expect(companionAction(page, alpha)).toBeEnabled();
    await expect(companionAction(page, alpha)).toBeFocused();
    await markControl(page, alpha);

    await held.release();

    expect(await controlIsMarked(page, alpha)).toBe(true);
    await expect(companionAction(page, alpha)).toHaveText(OPEN_LABEL);
    await expect(companionElement(page, alpha)).toHaveAttribute('data-action-mode', 'activate');
    await expect(companionElement(page, alpha)).not.toHaveAttribute('data-session-id', /.+/u);
    await expect(companionAction(page, alpha)).toBeEnabled();
    await expect(companionAction(page, alpha)).toBeFocused();
    await expect(companionEntry(page, alpha)).not.toContainText(UNVERIFIED_MESSAGE);
    await expect(banner(page)).toBeHidden();
    expect(launches).toHaveLength(1);
    expect(posts).toHaveLength(postsBefore);

    // The surviving control is the one the server accepts.
    await companionAction(page, alpha).click();
    await expect.poll(() => launches).toEqual([
      `/releases/${alpha.id}/social-prep/activate`, `/releases/${alpha.id}/social-prep/activate`,
    ]);
    await expect(companionAction(page, alpha)).toHaveText(RETRY_LABEL);
    await expect(companionEntry(page, alpha)).not.toContainText('Could not open publishing companion.');

    expect(page.url()).toBe(`${origin}/`);
    expect(navigations).toEqual([]);
    expect(await stayed(page)).toBe(true);
    expect(errors).toEqual([]);
  }, { platforms: ['x'] });
});

test('An older failed check held at the refresh cannot disable a newer verified control', async ({ page }) => {
  await withDashboard(async ({ origin, alpha, beta }) => {
    const { launches } = watchCompanion(page, [alpha]);
    const { posts } = watchPage(page);
    await openDashboard(page, origin);
    await publishAndLaunch(page, alpha);
    await failReturnCheck(page, origin, alpha);
    const postsBefore = posts.length;

    const held = await holdReturnAtDashboard(page, origin, [alpha], { oldCheck: failFetch });

    await companionCheck(page, alpha).click();
    await expect(companionCheck(page, alpha)).toHaveCount(0);
    await expect(companionAction(page, alpha)).toHaveText(RETRY_LABEL);
    await expect(companionAction(page, alpha)).toBeEnabled();
    await expect(companionAction(page, alpha)).toBeFocused();
    await markControl(page, alpha);
    // The setup's own failed return announced already.
    const announcer = page.locator('[data-dashboard-announcer]');
    await page.evaluate(() => new Promise((resolve) => { setTimeout(resolve, 500); }));
    await announcer.evaluate((element) => { element.textContent = ''; });

    await held.release();

    expect(await controlIsMarked(page, alpha)).toBe(true);
    await expect(companionCheck(page, alpha)).toHaveCount(0);
    await expect(companionEntry(page, alpha)).not.toContainText(UNVERIFIED_MESSAGE);
    await expect(companionAction(page, alpha)).toBeEnabled();
    await expect(companionAction(page, alpha)).toBeFocused();
    // Outlasts the announcer's own delay, so an obsolete message would have landed.
    await page.evaluate(() => new Promise((resolve) => { setTimeout(resolve, 500); }));
    await expect(announcer).toHaveText('');
    await expect(banner(page)).toBeHidden();
    expect(posts).toHaveLength(postsBefore);
    expect(launches).toHaveLength(1);

    // Still usable, and the page was never paused.
    await companionAction(page, alpha).click();
    await expect.poll(() => launches).toEqual([
      `/releases/${alpha.id}/social-prep/activate`, `/releases/${alpha.id}/social-prep/reissue`,
    ]);
    await trigger(page, beta).click();
    await expect(dialog(page)).toContainText('Beta overdue');
  }, { platforms: ['x'] });
});

test('An older successful check held at the refresh cannot clear a newer failed check', async ({ page }) => {
  await withDashboard(async ({ origin, alpha, beta }) => {
    const { gets, launches } = watchCompanion(page, [alpha]);
    await openDashboard(page, origin);
    await publishAndLaunch(page, alpha);
    await failReturnCheck(page, origin, alpha);

    const held = await holdReturnAtDashboard(page, origin, [alpha]);
    held.nextCheck = failFetch;

    gets.length = 0;
    await companionCheck(page, alpha).click();
    await expect(companionCheck(page, alpha)).toHaveText('Check again');
    await expect(companionCheck(page, alpha)).toBeFocused();
    expect(gets).toEqual([`/releases/${alpha.id}`]);
    await markControl(page, alpha);

    await held.release();

    // The newer failure stands, and stays local to this control.
    expect(await controlIsMarked(page, alpha)).toBe(true);
    await expect(companionCheck(page, alpha)).toHaveCount(1);
    await expect(companionCheck(page, alpha)).toHaveText('Check again');
    await expect(companionCheck(page, alpha)).toBeFocused();
    await expect(companionEntry(page, alpha)).toContainText(UNVERIFIED_MESSAGE);
    await expect(companionAction(page, alpha)).toBeDisabled();
    await expect(banner(page)).toBeHidden();
    expect(launches).toHaveLength(1);

    // It is still retryable with one GET.
    held.nextCheck = (route) => route.continue();
    gets.length = 0;
    await page.keyboard.press('Enter');
    await expect(companionCheck(page, alpha)).toHaveCount(0);
    await expect(companionAction(page, alpha)).toBeEnabled();
    expect(gets).toEqual([`/releases/${alpha.id}`]);

    await trigger(page, beta).click();
    await expect(dialog(page)).toContainText('Beta overdue');
  }, { platforms: ['x'] });
});

test('A check in flight when the older result is due decides the control itself', async ({ page }) => {
  await withDashboard(async ({ origin, alpha, db }) => {
    const { launches } = watchCompanion(page, [alpha]);
    await openDashboard(page, origin);
    await publishAndLaunch(page, alpha);
    await failReturnCheck(page, origin, alpha);

    const held = await holdReturnAtDashboard(page, origin, [alpha]);
    let answerNewer;
    held.nextCheck = async (route) => {
      await new Promise((resolve) => { answerNewer = resolve; });
      return route.continue();
    };
    await companionCheck(page, alpha).click();
    await expect.poll(() => typeof answerNewer).toBe('function');
    await expect(companionCheck(page, alpha)).toHaveText('Checking…');

    // The older result is due first, while the newer check has no answer yet.
    await held.release();
    await expect(companionCheck(page, alpha)).toHaveText('Checking…');
    await expect(companionAction(page, alpha)).toBeDisabled();
    await expect(banner(page)).toBeHidden();

    expireAttempt(db, alpha);
    answerNewer();
    await expect(companionCheck(page, alpha)).toHaveCount(0);
    await expect(companionAction(page, alpha)).toHaveText(OPEN_LABEL);
    await expect(companionAction(page, alpha)).toBeEnabled();
    expect(launches).toHaveLength(1);
  }, { platforms: ['x'] });
});

test('Each control keeps its own check when one is superseded at the refresh', async ({ page }) => {
  await withDashboard(async ({ origin, alpha, beta, db }) => {
    const { launches } = watchCompanion(page, [alpha, beta]);
    await openDashboard(page, origin);
    await publishAndLaunch(page, alpha);
    await publishAndLaunch(page, beta);
    await failReturnCheck(page, origin, alpha);
    await expect(companionAction(page, beta)).toBeEnabled();

    // Beta's own check fails and belongs to this pass; only alpha's is replaced.
    const held = await holdReturnAtDashboard(page, origin, [alpha, beta], {
      oldCheck: (route, release) => (release.id === beta.id ? failFetch(route) : route.continue()),
    });
    await expect(companionAction(page, beta)).toBeDisabled();
    expireAttempt(db, alpha);

    await companionCheck(page, alpha).click();
    await expect(companionAction(page, alpha)).toHaveText(OPEN_LABEL);
    await markControl(page, alpha);

    await held.release();

    expect(await controlIsMarked(page, alpha)).toBe(true);
    await expect(companionAction(page, alpha)).toHaveText(OPEN_LABEL);
    await expect(companionAction(page, alpha)).toBeEnabled();
    await expect(companionCheck(page, alpha)).toHaveCount(0);
    await expect(companionElement(page, alpha)).toHaveAttribute('data-activation-url', new RegExp(`/releases/${alpha.id}/`));

    await expect(companionCheck(page, beta)).toBeVisible();
    await expect(companionAction(page, beta)).toBeDisabled();
    await expect(companionEntry(page, beta)).toContainText(UNVERIFIED_MESSAGE);
    await expect(companionElement(page, beta)).toHaveAttribute('data-activation-url', new RegExp(`/releases/${beta.id}/`));
    await expect(banner(page)).toBeHidden();
    expect(launches).toHaveLength(2);
  }, { platforms: ['x'] });
});

test('A failed Dashboard refresh still takes page recovery when its check was superseded', async ({ page }) => {
  await withDashboard(async ({ origin, alpha, db }) => {
    const { launches } = watchCompanion(page, [alpha]);
    const { posts } = watchPage(page);
    await openDashboard(page, origin);
    await publishAndLaunch(page, alpha);
    await failReturnCheck(page, origin, alpha);
    const postsBefore = posts.length;

    const held = await holdReturnAtDashboard(page, origin, [alpha], {
      dashboard: (route) => route.fulfill({ status: 500, body: 'no' }),
    });
    expireAttempt(db, alpha);
    await companionCheck(page, alpha).click();
    await expect(companionAction(page, alpha)).toHaveText(OPEN_LABEL);
    await markControl(page, alpha);

    await held.release();

    // The page's recovery applies, and the newer control is left as it was.
    await expect(banner(page)).toBeVisible();
    await expect(banner(page)).toHaveAttribute('data-state', 'blocked');
    expect(await controlIsMarked(page, alpha)).toBe(true);
    await expect(companionAction(page, alpha)).toHaveText(OPEN_LABEL);
    expect(launches).toHaveLength(1);
    expect(posts).toHaveLength(postsBefore);

    await banner(page).locator('[data-dashboard-sync-retry]').click();
    await expect(banner(page)).not.toHaveAttribute('data-state', 'blocked');
    expect(posts).toHaveLength(postsBefore);
    expect(launches).toHaveLength(1);
  }, { platforms: ['x'] });
});

test('Repeated returns during a failed check never launch or pause anything', async ({ page }) => {
  await withDashboard(async ({ origin, alpha, beta }) => {
    const { launches } = watchCompanion(page, [alpha]);
    const { posts } = watchPage(page);
    await openDashboard(page, origin);
    await publishAndLaunch(page, alpha);
    const postsBefore = posts.length;
    await page.route(`${origin}/releases/${alpha.id}`, failFetch);

    for (let index = 0; index < 3; index += 1) {
      await leavePage(page);
      await returnToPage(page);
    }
    await expect(companionCheck(page, alpha)).toHaveCount(1);
    await page.waitForTimeout(200);
    await expect(companionCheck(page, alpha)).toHaveCount(1);
    await expect(banner(page)).toBeHidden();
    expect(launches).toHaveLength(1);
    expect(posts).toHaveLength(postsBefore);

    await trigger(page, beta).click();
    await expect(dialog(page)).toContainText('Beta overdue');
  }, { platforms: ['x'] });
});

test('A later return clears a failed check without its Check again', async ({ page }) => {
  await withDashboard(async ({ origin, alpha, db }) => {
    await openDashboard(page, origin);
    await publishAndLaunch(page, alpha);
    await page.route(`${origin}/releases/${alpha.id}`, failFetch);
    await leavePage(page);
    await returnToPage(page);
    await expect(companionCheck(page, alpha)).toBeVisible();

    await page.unroute(`${origin}/releases/${alpha.id}`);
    await leavePage(page);
    helperPosts(db, alpha);
    await returnToPage(page);
    await expect(companionEntry(page, alpha)).toHaveCount(0);
    await expect(socialBadge(page, alpha)).toHaveText('X · Posted');
    await expect(banner(page)).toBeHidden();
  }, { platforms: ['x'] });
});

test('An older Dashboard response cannot overwrite newer information', async ({ page }) => {
  await withDashboard(async ({ origin, alpha, db }) => {
    await openDashboard(page, origin);
    await publishAndLaunch(page, alpha);

    // The return's response is captured before the helper finishes, then held.
    let answerOld;
    let captured = false;
    await page.route(`${origin}/`, async (route) => {
      if (route.request().resourceType() !== 'fetch' || captured) return route.continue();
      captured = true;
      const response = await route.fetch();
      await new Promise((resolve) => { answerOld = resolve; });
      return route.fulfill({ response }).catch(() => {});
    });
    await leavePage(page);
    await returnToPage(page);
    await expect.poll(() => typeof answerOld).toBe('function');

    helperPosts(db, alpha);
    await page.evaluate(async () => {
      const { refreshDashboard } = await import('/client/dashboard.js');
      await refreshDashboard(document);
    });
    await expect(socialBadge(page, alpha)).toHaveText('X · Posted');
    answerOld();
    await page.waitForTimeout(200);
    await expect(socialBadge(page, alpha)).toHaveText('X · Posted');
    await expect(banner(page)).toBeHidden();
  }, { platforms: ['x'] });
});

test('A retry in flight during a return is left alone, then checked once it settles', async ({ page }) => {
  await withDashboard(async ({ origin, alpha, db }) => {
    const { gets, launches } = watchCompanion(page, [alpha]);
    await openDashboard(page, origin);
    await publishAndLaunch(page, alpha);

    let settleRetry;
    await page.route('**/social-prep/reissue', async (route) => {
      await new Promise((resolve) => { settleRetry = resolve; });
      return route.fulfill({ status: 500, json: {} });
    });
    await companionAction(page, alpha).click();
    await expect.poll(() => typeof settleRetry).toBe('function');
    gets.length = 0;

    await leavePage(page);
    helperPosts(db, alpha);
    await returnToPage(page);
    await expect(socialBadge(page, alpha)).toHaveText('X · Posted');
    await expect.poll(() => gets.length).toBe(2);
    await expect(companionAction(page, alpha)).toHaveCount(1);
    await expect(companionAction(page, alpha)).toBeDisabled();

    // Its failure cannot revive the control the server no longer offers.
    settleRetry();
    await expect(companionEntry(page, alpha)).toHaveCount(0);
    expect(launches).toHaveLength(2);
  }, { platforms: ['x'] });
});

test('Each release keeps its own control through a return', async ({ page }) => {
  await withDashboard(async ({ origin, alpha, beta, db }) => {
    const { launches } = watchCompanion(page, [alpha, beta]);
    await openDashboard(page, origin);
    await publishAndLaunch(page, alpha);
    await publishAndLaunch(page, beta);
    expect(launches).toHaveLength(2);

    await leavePage(page);
    helperPosts(db, alpha);
    await returnToPage(page);

    await expect(companionEntry(page, alpha)).toHaveCount(0);
    await expect(socialBadge(page, alpha)).toHaveText('X · Posted');
    await expect(companionAction(page, beta)).toBeEnabled();
    await expect(companionEntry(page, beta).locator('[data-release-social-prep-companion]'))
      .toHaveAttribute('data-activation-url', new RegExp(`/releases/${beta.id}/`));
    await expect(socialBadge(page, beta)).toHaveText('X · Pending');
    expect(launches).toHaveLength(2);
  }, { platforms: ['x'] });
});

test('Without social preparation nothing is launched', async ({ page }) => {
  await withDashboard(async ({ origin, alpha }) => {
    const { posts } = watchPage(page);
    await openDashboard(page, origin);
    await trigger(page, alpha).click();
    await dialog(page).locator('[data-dialog-submit]').click();
    await expect(trigger(page, alpha)).toHaveCount(0);
    await page.waitForTimeout(200);
    await expect(page.locator('.dashboard-publish-companion')).toHaveCount(0);
    expect(posts).toEqual([`/releases/${alpha.id}/publish`]);
  });
});
