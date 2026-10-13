import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { openDatabase, closeDatabase, runMigrations } from '../../src/db.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';

function localDate(offsetDays = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

async function withDashboardApp(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-dashboard-refresh-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    const statuses = app.locals.projectOptionCatalogueService.getStatusCatalogue()
      .map(({ value }) => value).filter((value) => value !== 'archived');
    const [firstStatus, secondStatus] = statuses;
    const projects = app.locals.projectService;
    const project = projects.create({ title: 'Refresh Project', status: firstStatus });
    projects.create({ title: 'Other Project', status: secondStatus });
    const insert = db.prepare(`
      INSERT INTO releases (project_id, title, description, notes, planned_date, planned_time, patreon_url, published_date, archived_at, created_at)
      VALUES (?, ?, '', '', ?, NULL, NULL, NULL, NULL, ?)
    `);
    const release = (title, plannedDate, createdAt) => Number(insert.run(project.id, title, plannedDate, createdAt).lastInsertRowid);
    const ids = {
      first: release('First Undated', null, '2026-01-01 00:00:00'),
      second: release('Second Undated', null, '2026-01-02 00:00:00'),
      third: release('Third Undated', null, '2026-01-03 00:00:00'),
      scheduled: release('Scheduled Soon', localDate(2), '2026-01-04 00:00:00'),
    };
    const readSchedule = (id) => db.prepare('SELECT planned_date, planned_time FROM releases WHERE id = ?').get(id);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    await run({ origin: `http://127.0.0.1:${server.address().port}`, ids, readSchedule, firstStatus, secondStatus });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const FILTERS_BOUND = '[data-dashboard-status-filters][data-dashboard-status-filters-bound="true"]';

const SCHEDULE_BOUND = '[data-dashboard-schedule][data-dashboard-schedule-bound="true"]';

async function openDashboard(page, origin) {
  await page.goto(`${origin}/`);
  await page.locator(FILTERS_BOUND).waitFor({ state: 'attached' });
  await page.locator(SCHEDULE_BOUND).first().waitFor({ state: 'attached' });
  const traffic = { navigations: 0, dashboardGets: 0, posts: [] };
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) traffic.navigations += 1; });
  page.on('request', (request) => {
    if (request.method() === 'GET' && new URL(request.url()).pathname === '/') traffic.dashboardGets += 1;
    if (request.method() === 'POST') traffic.posts.push(request.url());
  });
  return traffic;
}

// A direct authoritative refresh, outside any scheduling lifecycle.
function refreshNow(page) {
  return page.evaluate(async () => {
    const { refreshDashboard } = await import('/client/dashboard.js');
    return refreshDashboard(document);
  });
}

// Tags the current region so a test can tell when a replacement installed.
async function markRegion(page) {
  await page.evaluate(() => { document.querySelector('[data-dashboard]').dataset.testStale = 'true'; });
}

async function waitForReplacement(page) {
  await page.waitForFunction(() => {
    const region = document.querySelector('[data-dashboard]');
    return region && !region.dataset.testStale && !region.hasAttribute('aria-busy');
  });
}

function needsDateIds(page) {
  return page.locator('[data-dashboard-needs-date-item]').evaluateAll(
    (items) => items.map((item) => Number(item.getAttribute('data-release-id'))),
  );
}

function scheduleRow(page, id) {
  return page.locator(`[data-dashboard-schedule][data-release-id="${id}"]`);
}

// Server-owned content, compared against an independent full render.
function serverRegions(target) {
  return target.evaluate(() => {
    const text = (selector) => document.querySelector(selector)?.textContent.replace(/\s+/g, ' ').trim() ?? null;
    return {
      tiles: text('.dashboard-tiles'),
      strip: [...document.querySelectorAll('.dashboard-strip-day')].map((day) => `${day.dataset.date}:${day.className}:${day.querySelectorAll('.dashboard-strip-dot').length}`),
      scheduled: text('.dashboard-scheduled'),
      recent: text('.dashboard-recent'),
      needsBadge: text('[data-dashboard-needs-date-count]'),
      viewAll: text('#needs-date .dashboard-view-all'),
      projectRows: text('[data-dashboard-projects] tbody'),
      tabCounts: [...document.querySelectorAll('.dashboard-status-tab-count')].map((count) => count.textContent.trim()),
    };
  });
}

function duplicateIds(page) {
  return page.evaluate(() => {
    const seen = new Set();
    const duplicates = new Set();
    for (const { id } of document.querySelectorAll('[id]')) (seen.has(id) ? duplicates : seen).add(id);
    return [...duplicates];
  });
}

function hasHorizontalScroll(page) {
  return page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
}

test('a confirmed schedule refreshes every server region in place and keeps page state', async ({ page, context }) => {
  await withDashboardApp(async ({ origin, ids, readSchedule, secondStatus }) => {
    const traffic = await openDashboard(page, origin);
    await page.evaluate(() => {
      document.querySelector('.app-header').dataset.testShell = 'kept';
      document.querySelector('#project-create-dialog').dataset.testDialog = 'kept';
    });
    const dialogTitle = page.locator('#project-create-form [name="title"]');
    await dialogTitle.evaluate((input) => { input.value = 'Unsaved project name'; });
    expect(await needsDateIds(page)).toEqual([ids.first, ids.second, ids.third]);

    // A status filter chosen before the refresh must survive it.
    await page.locator(`[data-dashboard-status-filter="${secondStatus}"]`).click();
    await expect(page.locator('[data-dashboard-project-row]:visible')).toHaveCount(1);

    // Hold the schedule POST so a draft can be typed into another row meanwhile.
    let releasePost;
    const held = new Promise((resolve) => { releasePost = resolve; });
    await page.route(`**/releases/${ids.first}/schedule`, async (route) => { await held; await route.continue(); }, { times: 1 });

    await markRegion(page);
    const firstRow = scheduleRow(page, ids.first);
    const pick = firstRow.locator('[data-dashboard-schedule-pick]').first();
    const pickedDate = await pick.getAttribute('data-planned-date');
    await pick.click();
    const thirdDate = scheduleRow(page, ids.third).locator('[data-dashboard-schedule-date]');
    await thirdDate.fill('2027-02-03');
    await expect(scheduleRow(page, ids.third).locator('[data-dashboard-schedule-error]')).toContainText('Another schedule change');
    releasePost();
    await waitForReplacement(page);

    expect(readSchedule(ids.first)).toEqual({ planned_date: pickedDate, planned_time: null });
    expect(traffic.navigations).toBe(0);
    expect(traffic.dashboardGets).toBe(1);

    // The confirmation stays in its original place with a working Undo,
    // and the third row's unsent draft is restored without being submitted.
    expect(await needsDateIds(page)).toEqual([ids.first, ids.second, ids.third]);
    await expect(firstRow.locator('[data-dashboard-schedule-status]')).toContainText('Scheduled for');
    await expect(firstRow.locator('[data-dashboard-schedule-undo]')).toBeFocused();
    await expect(scheduleRow(page, ids.third).locator('[data-dashboard-schedule-date]')).toHaveValue('2027-02-03');
    await expect(scheduleRow(page, ids.third).locator('[data-dashboard-schedule-pick]').first()).toBeEnabled();
    expect(readSchedule(ids.third)).toEqual({ planned_date: null, planned_time: null });
    expect(traffic.posts).toEqual([`${origin}/releases/${ids.first}/schedule`]);

    // Server totals and rows match an independent full render; the retained
    // confirmation is extra and not counted as waiting.
    const fresh = await context.newPage();
    await fresh.goto(`${origin}/`);
    const [refreshed, authoritative] = [await serverRegions(page), await serverRegions(fresh)];
    expect(refreshed).toEqual(authoritative);
    expect(authoritative.needsBadge).toBe('2 waiting');
    expect(await page.locator('[data-dashboard-tile="needs-date"] [data-dashboard-tile-count]').textContent()).toBe('2');
    expect(await needsDateIds(fresh)).toEqual([ids.second, ids.third]);
    await fresh.close();

    // Filter selection carries over and recounts the new rows.
    await expect(page.locator(`[data-dashboard-status-filter="${secondStatus}"]`)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-dashboard-project-row]:visible')).toHaveCount(1);
    await expect(page.locator('[data-dashboard-projects-count]')).toHaveText('1 of 2 active projects · archived hidden');

    // Shell, header actions and the New Project dialog are the same nodes.
    expect(await page.evaluate(() => document.querySelector('.app-header').dataset.testShell)).toBe('kept');
    expect(await page.evaluate(() => document.querySelector('#project-create-dialog').dataset.testDialog)).toBe('kept');
    await expect(dialogTitle).toHaveValue('Unsaved project name');
    await expect(page.locator('[data-dialog-open="project-create-dialog"]')).toHaveCount(1);
    expect(await page.locator('[data-dashboard]').count()).toBe(1);
    expect(await duplicateIds(page)).toEqual([]);
    expect(await hasHorizontalScroll(page)).toBe(false);
  });
});

test('Undo refreshes back to the server queue and repeated confirmations stay single', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 740 });
  await withDashboardApp(async ({ origin, ids, readSchedule }) => {
    const traffic = await openDashboard(page, origin);

    for (const id of [ids.first, ids.second]) {
      await markRegion(page);
      await scheduleRow(page, id).locator('[data-dashboard-schedule-pick]').first().click();
      await waitForReplacement(page);
      await expect(scheduleRow(page, id).locator('[data-dashboard-schedule-undo]')).toBeFocused();
    }
    expect(await needsDateIds(page)).toEqual([ids.first, ids.second, ids.third]);
    await expect(page.locator('[data-dashboard-schedule-undo]')).toHaveCount(2);
    await expect(page.locator('[data-dashboard-tile="needs-date"] [data-dashboard-tile-count]')).toHaveText('1');
    await expect(page.locator('[data-dashboard-needs-date-count]')).toHaveText('1 waiting');
    // Each confirmed release appears once in the queue and once as a scheduled row.
    for (const id of [ids.first, ids.second]) {
      await expect(page.locator(`[data-dashboard-needs-date-item][data-release-id="${id}"]`)).toHaveCount(1);
      await expect(page.locator(`[data-dashboard-release-row][data-release-id="${id}"]`)).toHaveCount(1);
    }

    await markRegion(page);
    await scheduleRow(page, ids.first).locator('[data-dashboard-schedule-undo]').click();
    await waitForReplacement(page);
    expect(readSchedule(ids.first)).toEqual({ planned_date: null, planned_time: null });
    expect(await needsDateIds(page)).toEqual([ids.first, ids.second, ids.third]);
    const firstRow = scheduleRow(page, ids.first);
    await expect(firstRow.locator('[data-dashboard-schedule-undo]')).toHaveCount(0);
    await expect(firstRow.locator('[data-dashboard-schedule-pick]').first()).toBeFocused();
    await expect(scheduleRow(page, ids.second).locator('[data-dashboard-schedule-undo]')).toHaveCount(1);
    await expect(page.locator('[data-dashboard-tile="needs-date"] [data-dashboard-tile-count]')).toHaveText('2');
    await expect(page.locator(`[data-dashboard-release-row][data-release-id="${ids.first}"]`)).toHaveCount(0);

    // After three replacements each click still sends exactly one request.
    const before = traffic.posts.length;
    await markRegion(page);
    await scheduleRow(page, ids.third).locator('[data-dashboard-schedule-pick]').first().click();
    await waitForReplacement(page);
    expect(traffic.posts.slice(before)).toEqual([`${origin}/releases/${ids.third}/schedule`]);
    expect(traffic.navigations).toBe(0);
    expect(await duplicateIds(page)).toEqual([]);
    expect(await hasHorizontalScroll(page)).toBe(false);
  });
});

test('the mutation gate stays held until the refresh replacement settles', async ({ page }) => {
  await withDashboardApp(async ({ origin, ids, readSchedule }) => {
    const traffic = await openDashboard(page, origin);
    let releaseGet;
    const held = new Promise((resolve) => { releaseGet = resolve; });
    let getStarted;
    const started = new Promise((resolve) => { getStarted = resolve; });
    await page.route((url) => url.pathname === '/', async (route) => {
      if (route.request().resourceType() === 'document') return route.continue();
      getStarted();
      await held;
      await route.continue();
    }, { times: 1 });

    await markRegion(page);
    await scheduleRow(page, ids.first).locator('[data-dashboard-schedule-pick]').first().click();
    await started;
    await scheduleRow(page, ids.second).locator('[data-dashboard-schedule-pick]').first().click();
    await expect(scheduleRow(page, ids.second).locator('[data-dashboard-schedule-error]')).toContainText('Another schedule change');
    expect(traffic.posts).toEqual([`${origin}/releases/${ids.first}/schedule`]);
    expect(readSchedule(ids.second)).toEqual({ planned_date: null, planned_time: null });

    releaseGet();
    await waitForReplacement(page);
    // Focus the user moved during the refresh stays with them on the new node.
    await expect(scheduleRow(page, ids.second).locator('[data-dashboard-schedule-pick]').first()).toBeFocused();
    await expect(scheduleRow(page, ids.first).locator('[data-dashboard-schedule-undo]')).toBeVisible();
    await markRegion(page);
    await scheduleRow(page, ids.second).locator('[data-dashboard-schedule-pick]').first().click();
    await waitForReplacement(page);
    expect(readSchedule(ids.second).planned_date).not.toBeNull();
  });
});

test('the last undated release keeps its confirmation when the server queue empties', async ({ page }) => {
  await withDashboardApp(async ({ origin, ids }) => {
    await openDashboard(page, origin);
    for (const id of [ids.first, ids.second, ids.third]) {
      await markRegion(page);
      await scheduleRow(page, id).locator('[data-dashboard-schedule-pick]').first().click();
      await waitForReplacement(page);
    }
    expect(await needsDateIds(page)).toEqual([ids.first, ids.second, ids.third]);
    await expect(page.locator('#needs-date .dashboard-empty-line')).toHaveText('Every active release has a date.');
    await expect(page.locator('[data-dashboard-needs-date-count]')).toHaveCount(0);
    await expect(scheduleRow(page, ids.third).locator('[data-dashboard-schedule-undo]')).toBeFocused();
  });
});

test('title popovers, preview fallbacks and an invalid saved filter are handled on replacement nodes', async ({ page }) => {
  await withDashboardApp(async ({ origin, ids, secondStatus }) => {
    await openDashboard(page, origin);
    await page.locator(`[data-dashboard-status-filter="${secondStatus}"]`).click();

    const scheduledTitle = (scope) => scope.locator('[data-dashboard-title-info]')
      .filter({ has: page.locator(`#dashboard-release-info-scheduled-${ids.scheduled}`) })
      .locator(':scope > a[href]');
    await scheduledTitle(page).focus();
    await expect(page.locator(`#dashboard-release-info-scheduled-${ids.scheduled}`)).toBeVisible();
    await page.evaluate((id) => { window.oldCard = document.getElementById(`dashboard-release-info-scheduled-${id}`); }, ids.scheduled);

    // The next response drops the selected status tab and gives the first
    // undated release a thumbnail whose image cannot load.
    await page.route((url) => url.pathname === '/', async (route) => {
      if (route.request().resourceType() === 'document') return route.continue();
      const response = await route.fetch();
      let body = await response.text();
      body = body.replace(new RegExp(`<button[^>]*data-dashboard-status-filter="${secondStatus}"[^>]*>[\\s\\S]*?</button>`), '');
      const item = body.indexOf(`data-dashboard-needs-date-item data-release-id="${ids.first}"`);
      const marker = '<div class="dashboard-needs-date-body">';
      const insertAt = body.indexOf(marker, item);
      body = `${body.slice(0, insertAt)}<span class="dashboard-thumb dashboard-thumb--image" data-test-preview data-preview-enhancement data-preview-state="loading" aria-hidden="true"><img class="dashboard-thumb-image" data-preview-image src="/missing-dashboard-thumb.png" alt=""><span class="dashboard-thumb-initials" data-preview-fallback>FU</span></span>${body.slice(insertAt)}`;
      await route.fulfill({ response, body });
    }, { times: 1 });

    await markRegion(page);
    const outcome = await refreshNow(page);
    expect(outcome).toEqual({ status: 'refreshed' });
    await waitForReplacement(page);

    expect(await page.evaluate(() => window.oldCard.isConnected)).toBe(false);
    expect(await page.evaluate(() => [...document.querySelectorAll('[data-info-card-open]')]
      .every((card) => card.isConnected && document.querySelector('[data-dashboard]').contains(card)))).toBe(true);
    await expect(scheduledTitle(page)).toBeFocused();
    await page.locator('h1').first().click();
    await expect(page.locator(`#dashboard-release-info-scheduled-${ids.scheduled}`)).toBeHidden();
    await scheduledTitle(page).focus();
    await expect(page.locator(`#dashboard-release-info-scheduled-${ids.scheduled}`)).toBeVisible();

    await expect(page.locator('[data-test-preview]')).toHaveAttribute('data-preview-state', 'failed');
    await expect(page.locator('[data-test-preview] [data-preview-fallback]')).toBeVisible();

    await expect(page.locator('[data-dashboard-status-filter="all"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-dashboard-project-row]:visible')).toHaveCount(2);
    await expect(page.locator('[data-dashboard-projects-count]')).toHaveText('2 of 2 active projects · archived hidden');
  });
});

test('failed or malformed refresh responses leave the dashboard intact and report failure', async ({ page }) => {
  await withDashboardApp(async ({ origin, ids, readSchedule }) => {
    await openDashboard(page, origin);
    const refreshWith = async (fulfill) => {
      await page.route((url) => url.pathname === '/', async (route) => {
        if (route.request().resourceType() === 'document') return route.continue();
        await fulfill(route);
      }, { times: 1 });
      return refreshNow(page);
    };
    await markRegion(page);
    const before = await page.locator('[data-dashboard]').innerHTML();

    const failures = [
      await refreshWith((route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><main><p>Sign in</p></main>' })),
      await refreshWith((route) => route.fulfill({ status: 500, contentType: 'text/html', body: 'Server error' })),
      await refreshWith(async (route) => {
        const response = await route.fetch();
        const body = (await response.text()).replace('dashboard-panel dashboard-recent', 'dashboard-panel');
        await route.fulfill({ response, body });
      }),
      await refreshWith(async (route) => {
        const response = await route.fetch();
        const body = (await response.text()).replace('<section class="dashboard-attention"', '<header class="app-header"></header><section class="dashboard-attention"');
        await route.fulfill({ response, body });
      }),
      await refreshWith((route) => route.abort('failed')),
    ];
    expect(failures.map(({ status, reason, replaced }) => [status, reason, replaced])).toEqual([
      ['failed', 'invalid', false],
      ['failed', 'response', false],
      ['failed', 'invalid', false],
      ['failed', 'invalid', false],
      ['failed', 'request', false],
    ]);
    expect(await page.evaluate(() => document.querySelector('[data-dashboard]').dataset.testStale)).toBe('true');
    await expect(page.locator('[data-dashboard]')).not.toHaveAttribute('aria-busy', 'true');
    expect(await page.locator('[data-dashboard]').innerHTML()).toBe(before);

    // A confirmed write whose refresh fails is reported, not claimed as synced.
    await page.route((url) => url.pathname === '/', async (route) => {
      if (route.request().resourceType() === 'document') return route.continue();
      await route.fulfill({ status: 503, contentType: 'text/html', body: 'Unavailable' });
    }, { times: 1 });
    await scheduleRow(page, ids.first).locator('[data-dashboard-schedule-pick]').first().click();
    await expect(page.locator('[data-dashboard-sync]')).toHaveAttribute('data-state', 'blocked');
    await expect(page.locator('[data-dashboard-sync-message]')).toContainText('The schedule change was saved, but the dashboard couldn’t refresh');
    expect(readSchedule(ids.first).planned_date).not.toBeNull();
    expect(await page.evaluate(() => document.querySelector('[data-dashboard]').dataset.testStale)).toBe('true');
    await expect(scheduleRow(page, ids.first).locator('[data-dashboard-schedule-status]')).toContainText('Scheduled for');
  });
});
