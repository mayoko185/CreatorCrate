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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-dashboard-recovery-'));
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
    const project = projects.create({ title: 'Recovery Project', status: firstStatus });
    projects.create({ title: 'Other Project', status: secondStatus });
    const insert = db.prepare(`
      INSERT INTO releases (project_id, title, description, notes, planned_date, planned_time, patreon_url, published_date, archived_at, created_at)
      VALUES (?, ?, '', '', NULL, NULL, NULL, NULL, NULL, ?)
    `);
    const release = (title, createdAt) => Number(insert.run(project.id, title, createdAt).lastInsertRowid);
    const ids = {
      first: release('First Undated', '2026-01-01 00:00:00'),
      second: release('Second Undated', '2026-01-02 00:00:00'),
      third: release('Third Undated', '2026-01-03 00:00:00'),
      fourth: release('Fourth Undated', '2026-01-04 00:00:00'),
    };
    const readSchedule = (id) => db.prepare('SELECT planned_date, planned_time FROM releases WHERE id = ?').get(id);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    await run({ origin: `http://127.0.0.1:${server.address().port}`, db, ids, readSchedule, secondStatus });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const SCHEDULE_BOUND = '[data-dashboard-schedule][data-dashboard-schedule-bound="true"]';
const UNDATED = { planned_date: null, planned_time: null };

async function openDashboard(page, origin) {
  await page.goto(`${origin}/`);
  await page.locator(SCHEDULE_BOUND).first().waitFor({ state: 'attached' });
  const traffic = { navigations: 0, dashboardGets: 0, posts: [] };
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) traffic.navigations += 1; });
  page.on('request', (request) => {
    if (request.method() === 'GET' && new URL(request.url()).pathname === '/') traffic.dashboardGets += 1;
    if (request.method() === 'POST') traffic.posts.push(request.url());
  });
  return traffic;
}

// Intercepts only background dashboard GETs; full page loads pass through.
function routeDashboardGet(page, handler, options = { times: 1 }) {
  return page.route((url) => url.pathname === '/', async (route) => {
    if (route.request().resourceType() === 'document') return route.continue();
    return handler(route);
  }, options);
}

async function markRegion(page) {
  await page.evaluate(() => { document.querySelector('[data-dashboard]').dataset.testStale = 'true'; });
}

async function waitForReplacement(page) {
  await page.waitForFunction(() => {
    const region = document.querySelector('[data-dashboard]');
    return region && !region.dataset.testStale && !region.hasAttribute('aria-busy');
  });
}

function scheduleRow(page, id) {
  return page.locator(`[data-dashboard-schedule][data-release-id="${id}"]`);
}

function firstPick(page, id) {
  return scheduleRow(page, id).locator('[data-dashboard-schedule-pick]').first();
}

function needsDateIds(page) {
  return page.locator('[data-dashboard-needs-date-item]').evaluateAll(
    (items) => items.map((item) => Number(item.getAttribute('data-release-id'))),
  );
}

function syncMessage(page) {
  return page.locator('[data-dashboard-sync-message]');
}

function syncState(page) {
  return page.locator('[data-dashboard-sync]');
}

function serverRegions(target) {
  return target.evaluate(() => {
    const text = (selector) => document.querySelector(selector)?.textContent.replace(/\s+/g, ' ').trim() ?? null;
    return {
      tiles: text('.dashboard-tiles'),
      strip: [...document.querySelectorAll('.dashboard-strip-day')].map((day) => `${day.dataset.date}:${day.className}:${day.querySelectorAll('.dashboard-strip-dot').length}`),
      quickPicks: [...document.querySelectorAll('[data-dashboard-needs-date-item]:not(:has([data-dashboard-schedule-undo])) [data-dashboard-schedule-pick]')]
        .map((pick) => pick.dataset.plannedDate).filter((date, index, all) => all.indexOf(date) === index),
      scheduled: text('.dashboard-scheduled'),
      recent: text('.dashboard-recent'),
      needsBadge: text('[data-dashboard-needs-date-count]'),
      projectRows: text('[data-dashboard-projects] tbody'),
    };
  });
}

async function expectMatchesFreshRender(page, context, origin) {
  const fresh = await context.newPage();
  await fresh.goto(`${origin}/`);
  expect(await serverRegions(page)).toEqual(await serverRegions(fresh));
  await fresh.close();
}

function hasHorizontalScroll(page) {
  return page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
}

test('a saved write whose refresh fails pauses scheduling until Retry refresh reconciles it with a GET only', async ({ page, context }) => {
  await withDashboardApp(async ({ origin, ids, readSchedule }) => {
    const traffic = await openDashboard(page, origin);
    await routeDashboardGet(page, (route) => route.fulfill({ status: 503, contentType: 'text/html', body: 'Unavailable' }));

    await firstPick(page, ids.first).click();
    const sync = syncState(page);
    await expect(sync).toHaveAttribute('data-state', 'blocked');
    const savedMessage = 'The schedule change was saved, but the dashboard couldn’t refresh, so counts and lists may be out of date. Scheduling is paused until the dashboard refreshes.';
    await expect(syncMessage(page)).toHaveText(savedMessage);
    await expect(page.locator('[data-dashboard-announcer]')).toHaveText(savedMessage);
    await expect(sync.locator('[data-dashboard-sync-reload]')).toHaveAttribute('href', '/');
    await expect(sync.locator('[data-dashboard-sync-dismiss]')).toBeHidden();
    expect(readSchedule(ids.first).planned_date).not.toBeNull();
    // The confirmation reflects the confirmed write; the stale counts are not
    // presented as current.
    await expect(scheduleRow(page, ids.first).locator('[data-dashboard-schedule-status]')).toContainText('Scheduled for');
    await expect(page.locator('[data-dashboard-tile="needs-date"] [data-dashboard-tile-count]')).toHaveText('4');

    // Every further write stays local: picks, typed drafts and the Undo.
    await firstPick(page, ids.second).click();
    await expect(scheduleRow(page, ids.second).locator('[data-dashboard-schedule-error]')).toContainText('Scheduling is paused');
    await scheduleRow(page, ids.third).locator('[data-dashboard-schedule-date]').fill('2027-03-04');
    await scheduleRow(page, ids.first).locator('[data-dashboard-schedule-undo]').click();
    await expect(scheduleRow(page, ids.first).locator('[data-dashboard-schedule-error]')).toContainText('Scheduling is paused');
    expect(traffic.posts).toEqual([`${origin}/releases/${ids.first}/schedule`]);
    expect(readSchedule(ids.second)).toEqual(UNDATED);
    expect(readSchedule(ids.third)).toEqual(UNDATED);

    // A retry that fails again keeps the page blocked and explains it.
    await routeDashboardGet(page, (route) => route.abort('failed'));
    const retry = sync.locator('[data-dashboard-sync-retry]');
    await retry.focus();
    await page.keyboard.press('Enter');
    await expect(syncMessage(page)).toHaveText(`${savedMessage} Try again, or reload the page.`);
    await expect(sync).toHaveAttribute('data-state', 'blocked');
    await expect(retry).toBeFocused();

    // Repeated activation while a retry runs starts no competing refresh.
    let releaseGet;
    const held = new Promise((resolve) => { releaseGet = resolve; });
    await routeDashboardGet(page, async (route) => { await held; await route.continue(); });
    const getsBefore = traffic.dashboardGets;
    await markRegion(page);
    await page.keyboard.press('Enter');
    await expect(retry).toHaveAttribute('aria-disabled', 'true');
    await expect(syncMessage(page)).toHaveText('Refreshing the dashboard…');
    await retry.click({ force: true });
    await page.keyboard.press('Enter');
    releaseGet();
    await waitForReplacement(page);
    await expect(sync).toHaveAttribute('data-state', 'notice');
    await expect(syncMessage(page)).toHaveText('Dashboard refreshed. Scheduling is available again.');
    await expect(page.locator('[data-dashboard-announcer]')).toHaveText('Dashboard refreshed. Scheduling is available again.');
    await expect(sync.locator('[data-dashboard-sync-dismiss]')).toBeFocused();
    expect(traffic.dashboardGets - getsBefore).toBe(1);
    expect(traffic.posts).toEqual([`${origin}/releases/${ids.first}/schedule`]);
    expect(traffic.navigations).toBe(0);

    // The confirmation and its Undo survive; the draft stays on its release.
    await expect(scheduleRow(page, ids.first).locator('[data-dashboard-schedule-undo]')).toBeVisible();
    await expect(scheduleRow(page, ids.third).locator('[data-dashboard-schedule-date]')).toHaveValue('2027-03-04');
    await expect(page.locator('[data-dashboard-tile="needs-date"] [data-dashboard-tile-count]')).toHaveText('3');
    await expectMatchesFreshRender(page, context, origin);

    await page.keyboard.press('Enter');
    await expect(sync).toBeHidden();
    await expect(scheduleRow(page, ids.first).locator('[data-dashboard-schedule-undo]')).toBeFocused();

    // Scheduling is usable again, Undo included.
    await markRegion(page);
    await page.keyboard.press('Enter');
    await waitForReplacement(page);
    expect(readSchedule(ids.first)).toEqual(UNDATED);
    await expect(page.locator('[data-dashboard-tile="needs-date"] [data-dashboard-tile-count]')).toHaveText('4');
    await expect(scheduleRow(page, ids.third).locator('[data-dashboard-schedule-date]')).toHaveValue('2027-03-04');
    expect(traffic.posts).toHaveLength(2);
  });
});

test('a successful Retry refresh clears paused errors on retained confirmations but keeps other row errors', async ({ page }) => {
  await withDashboardApp(async ({ origin, ids, readSchedule }) => {
    const traffic = await openDashboard(page, origin);
    const error = (id) => scheduleRow(page, id).locator('[data-dashboard-schedule-error]');
    const undo = (id) => scheduleRow(page, id).locator('[data-dashboard-schedule-undo]');
    const scheduleUrl = (id) => `${origin}/releases/${id}/schedule`;

    for (const id of [ids.second, ids.third]) {
      await markRegion(page);
      await firstPick(page, id).click();
      await waitForReplacement(page);
      await expect(undo(id)).toBeVisible();
    }
    // A rejected Undo leaves an actionable error unrelated to the pause.
    await page.route((url) => url.pathname === `/releases/${ids.second}/schedule`, (route) => (
      route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ status: 'error', message: 'Invalid or missing CSRF token.' }) })
    ), { times: 1 });
    await undo(ids.second).click();
    await expect(error(ids.second)).toContainText('security check failed');

    await routeDashboardGet(page, (route) => route.fulfill({ status: 503, contentType: 'text/html', body: 'Unavailable' }));
    await firstPick(page, ids.first).click();
    const sync = syncState(page);
    await expect(sync).toHaveAttribute('data-state', 'blocked');
    for (const id of [ids.first, ids.third]) {
      await undo(id).click();
      await expect(error(id)).toContainText('Scheduling is paused');
    }
    const postsWhilePaused = [ids.second, ids.third, ids.second, ids.first].map(scheduleUrl);
    expect(traffic.posts).toEqual(postsWhilePaused);

    // An unsuccessful retry leaves the pause in force, so its errors stay.
    await routeDashboardGet(page, (route) => route.abort('failed'));
    const retry = sync.locator('[data-dashboard-sync-retry]');
    await retry.focus();
    await page.keyboard.press('Enter');
    await expect(syncMessage(page)).toContainText('Try again, or reload the page.');
    await expect(sync).toHaveAttribute('data-state', 'blocked');
    await expect(retry).toBeFocused();
    await expect(error(ids.first)).toContainText('Scheduling is paused');
    await expect(error(ids.third)).toContainText('Scheduling is paused');

    const getsBefore = traffic.dashboardGets;
    await markRegion(page);
    await page.keyboard.press('Enter');
    await waitForReplacement(page);
    const available = 'Dashboard refreshed. Scheduling is available again.';
    await expect(syncMessage(page)).toHaveText(available);
    await expect(page.locator('[data-dashboard-announcer]')).toHaveText(available);
    await expect(sync.locator('[data-dashboard-sync-dismiss]')).toBeFocused();
    expect(traffic.dashboardGets - getsBefore).toBe(1);
    expect(traffic.posts).toEqual(postsWhilePaused);

    for (const id of [ids.first, ids.third]) {
      await expect(error(id)).toBeHidden();
      await expect(error(id)).toHaveText('');
      await expect(scheduleRow(page, id).locator('[data-dashboard-schedule-status]')).toContainText('Scheduled for');
      await expect(undo(id)).toBeVisible();
      await expect(undo(id)).not.toHaveAttribute('aria-disabled', 'true');
    }
    await expect(page.locator('[data-dashboard-schedule-error]:visible')).toHaveCount(1);
    await expect(error(ids.second)).toContainText('security check failed');

    await page.keyboard.press('Enter');
    await expect(sync).toBeHidden();
    await expect(undo(ids.first)).toBeFocused();
    await expect(error(ids.first)).toBeHidden();

    await markRegion(page);
    await page.keyboard.press('Enter');
    await waitForReplacement(page);
    expect(readSchedule(ids.first)).toEqual(UNDATED);
    expect(traffic.posts).toEqual([...postsWhilePaused, scheduleUrl(ids.first)]);
    await expect(scheduleRow(page, ids.first).locator('[data-dashboard-schedule-pick]').first()).toBeVisible();
    await expect(page.locator('[data-dashboard-schedule-error]:visible')).toHaveCount(1);
    await expect(undo(ids.third)).toBeVisible();
    await expect(sync).toBeHidden();
  });
});

test('a successful Retry refresh keeps genuine validation errors on undated rows and drops ones that no longer apply', async ({ page }) => {
  await withDashboardApp(async ({ origin, db, ids, readSchedule }) => {
    const { project_id: projectId } = db.prepare('SELECT project_id FROM releases WHERE id = ?').get(ids.first);
    const fifth = Number(db.prepare(`
      INSERT INTO releases (project_id, title, description, notes, planned_date, planned_time, patreon_url, published_date, archived_at, created_at)
      VALUES (?, 'Fifth Undated', '', '', NULL, NULL, NULL, NULL, NULL, '2026-01-05 00:00:00')
    `).run(projectId).lastInsertRowid);
    const traffic = await openDashboard(page, origin);
    const error = (id) => scheduleRow(page, id).locator('[data-dashboard-schedule-error]');
    const dateInput = (id) => scheduleRow(page, id).locator('[data-dashboard-schedule-date]');
    const scheduleUrl = (id) => `${origin}/releases/${id}/schedule`;
    const announcer = page.locator('[data-dashboard-announcer]');

    // A local validation error on an empty custom date.
    await dateInput(ids.first).focus();
    await page.keyboard.press('Enter');
    await expect(error(ids.first)).toHaveText('Choose a date first.');
    await expect(dateInput(ids.first)).toHaveAttribute('aria-invalid', 'true');

    // An actionable server validation error, alongside its unsent date.
    const serverMessage = 'Choose a date after the project starts.';
    await page.route(`**/releases/${ids.third}/schedule`, (route) => route.fulfill({
      status: 422, contentType: 'application/json', body: JSON.stringify({ status: 'error', message: serverMessage }),
    }), { times: 1 });
    await dateInput(ids.third).fill('2027-03-04');
    await expect(error(ids.third)).toHaveText(serverMessage);
    await expect(dateInput(ids.third)).toHaveAttribute('aria-invalid', 'true');

    // A real server validation error on a release that is then no longer undated.
    db.prepare('UPDATE releases SET published_date = ? WHERE id = ?').run(localDate(-1), ids.fourth);
    await dateInput(ids.fourth).fill('2027-04-05');
    await expect(error(ids.fourth)).toHaveText('Published releases cannot be rescheduled here.');

    // B's write commits but its refresh fails; a pick made meanwhile is busy.
    let releasePost;
    const held = new Promise((resolve) => { releasePost = resolve; });
    await page.route(`**/releases/${ids.second}/schedule`, async (route) => { await held; await route.continue(); }, { times: 1 });
    await routeDashboardGet(page, (route) => route.fulfill({ status: 503, contentType: 'text/html', body: 'Unavailable' }));
    await firstPick(page, ids.second).click();
    await firstPick(page, fifth).click();
    await expect(error(fifth)).toContainText('Another schedule change is still being saved');
    releasePost();
    const sync = syncState(page);
    await expect(sync).toHaveAttribute('data-state', 'blocked');
    expect(readSchedule(ids.second).planned_date).not.toBeNull();

    // The failed refresh replaced nothing, so every live error is intact.
    await expect(error(ids.first)).toHaveText('Choose a date first.');
    await expect(dateInput(ids.first)).toHaveAttribute('aria-invalid', 'true');
    await expect(error(ids.third)).toHaveText(serverMessage);
    const postsBefore = [ids.third, ids.fourth, ids.second].map(scheduleUrl);
    expect(traffic.posts).toEqual(postsBefore);

    const getsBefore = traffic.dashboardGets;
    await markRegion(page);
    await sync.locator('[data-dashboard-sync-retry]').focus();
    await page.keyboard.press('Enter');
    await waitForReplacement(page);
    const available = 'Dashboard refreshed. Scheduling is available again.';
    await expect(sync).toHaveAttribute('data-state', 'notice');
    await expect(syncMessage(page)).toHaveText(available);
    await expect(announcer).toHaveText(available);
    await expect(sync.locator('[data-dashboard-sync-dismiss]')).toBeFocused();
    expect(traffic.dashboardGets - getsBefore).toBe(1);
    expect(traffic.posts).toEqual(postsBefore);
    expect(traffic.navigations).toBe(0);
    expect(await page.evaluate(async () => {
      const { getDashboardMutationGate } = await import('/client/dashboard.js');
      return getDashboardMutationGate(document).busy;
    })).toBe(false);

    // A keeps its error and invalid state on its fresh row, still described
    // by the error it shows.
    expect(await page.evaluate(() => document.querySelector('[data-dashboard]').dataset.testStale)).toBeUndefined();
    await expect(error(ids.first)).toBeVisible();
    await expect(error(ids.first)).toHaveText('Choose a date first.');
    await expect(dateInput(ids.first)).toHaveAttribute('aria-invalid', 'true');
    await expect(dateInput(ids.first)).toHaveValue('');
    await expect(error(ids.first)).toHaveAttribute('id', `dashboard-schedule-error-${ids.first}`);
    await expect(scheduleRow(page, ids.first).locator(`[data-dashboard-schedule-controls][aria-describedby="dashboard-schedule-error-${ids.first}"]`)).toHaveCount(2);
    // The server error stays with its own release and draft.
    await expect(error(ids.third)).toHaveText(serverMessage);
    await expect(dateInput(ids.third)).toHaveAttribute('aria-invalid', 'true');
    await expect(dateInput(ids.third)).toHaveValue('2027-03-04');
    // The published release left the queue with its error; the busy error ended.
    expect(await needsDateIds(page)).toEqual([ids.first, ids.second, ids.third, fifth]);
    await expect(page.locator(`#dashboard-schedule-error-${ids.fourth}`)).toHaveCount(0);
    await expect(error(fifth)).toBeHidden();
    await expect(error(fifth)).toHaveText('');
    await expect(dateInput(fifth)).not.toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('[data-dashboard-schedule-error]:visible')).toHaveCount(2);

    // B's confirmation and Undo stay functional.
    const undo = scheduleRow(page, ids.second).locator('[data-dashboard-schedule-undo]');
    await expect(scheduleRow(page, ids.second).locator('[data-dashboard-schedule-status]')).toContainText('Scheduled for');
    await page.keyboard.press('Enter');
    await expect(sync).toBeHidden();
    await expect(undo).toBeFocused();
    await markRegion(page);
    await page.keyboard.press('Enter');
    await waitForReplacement(page);
    expect(readSchedule(ids.second)).toEqual(UNDATED);
    await expect(scheduleRow(page, ids.second).locator(':focus')).toHaveCount(1);
    expect(traffic.posts).toEqual([...postsBefore, scheduleUrl(ids.second)]);
    // A further refresh keeps both errors where they were.
    await expect(error(ids.first)).toHaveText('Choose a date first.');
    await expect(dateInput(ids.first)).toHaveAttribute('aria-invalid', 'true');
    await expect(error(ids.third)).toHaveText(serverMessage);
    await expect(dateInput(ids.third)).toHaveValue('2027-03-04');
    await expect(page.locator('[data-dashboard-schedule-error]:visible')).toHaveCount(2);
    await expect(announcer).toContainText('Undid scheduling');
  });
});

test('a refresh that replaced the dashboard but did not finish loading stays blocked and reports Undo truthfully', async ({ page }) => {
  await withDashboardApp(async ({ origin, ids, readSchedule }) => {
    const traffic = await openDashboard(page, origin);
    // Fail the restoration step that runs right after the region is swapped.
    await page.evaluate(() => {
      const today = document.querySelector('.dashboard-today');
      today.replaceChildren = () => { delete today.replaceChildren; throw new Error('restore failed'); };
    });
    await markRegion(page);
    await firstPick(page, ids.first).click();
    await expect(syncState(page)).toHaveAttribute('data-state', 'blocked');
    await expect(syncMessage(page)).toHaveText(
      'The schedule change was saved, but the refreshed dashboard didn’t finish loading, so counts and lists may be out of date. Scheduling is paused until the dashboard refreshes.',
    );
    // The new markup is present but was never enhanced, so its native forms
    // stay disabled rather than navigating to the JSON endpoint.
    expect(await page.evaluate(() => document.querySelector('[data-dashboard]').dataset.testStale)).toBeUndefined();
    await expect(firstPick(page, ids.second)).toBeDisabled();
    expect(readSchedule(ids.first).planned_date).not.toBeNull();

    await page.locator('[data-dashboard-sync-retry]').click();
    await expect(syncState(page)).toHaveAttribute('data-state', 'notice');
    await expect(syncMessage(page)).toHaveText('Dashboard refreshed. Undo is no longer available for that change; open the release to change its date.');
    await expect(page.locator('[data-dashboard-schedule-undo]')).toHaveCount(0);
    expect(await needsDateIds(page)).toEqual([ids.second, ids.third, ids.fourth]);
    await expect(firstPick(page, ids.second)).toBeEnabled();
    expect(traffic.posts).toHaveLength(1);

    await markRegion(page);
    await firstPick(page, ids.second).click();
    await waitForReplacement(page);
    // A new outcome replaces the earlier notice.
    await expect(syncState(page)).toBeHidden();
    await expect(scheduleRow(page, ids.second).locator('[data-dashboard-schedule-undo]')).toBeFocused();
  });
});

test('a lost response after the server committed is reconciled without retrying or claiming success', async ({ page }) => {
  await withDashboardApp(async ({ origin, ids, readSchedule }) => {
    const traffic = await openDashboard(page, origin);
    await page.route(`**/releases/${ids.first}/schedule`, async (route) => {
      await route.fetch();
      await route.abort('failed');
    }, { times: 1 });
    const pickedDate = await firstPick(page, ids.first).getAttribute('data-planned-date');
    const label = await page.evaluate((date) => {
      const [year, month, day] = date.split('-').map(Number);
      const options = { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' };
      if (year !== new Date().getFullYear()) options.year = 'numeric';
      return new Intl.DateTimeFormat('en-US', options).format(new Date(Date.UTC(year, month - 1, day)));
    }, pickedDate);

    await markRegion(page);
    await firstPick(page, ids.first).click();
    await waitForReplacement(page);
    const message = `We couldn’t confirm whether the schedule change was saved. “First Undated” is currently scheduled for ${label}.`;
    await expect(syncMessage(page)).toHaveText(message);
    await expect(page.locator('[data-dashboard-announcer]')).toHaveText(message);
    await expect(syncState(page)).toHaveAttribute('data-state', 'notice');
    expect(readSchedule(ids.first)).toEqual({ planned_date: pickedDate, planned_time: null });
    expect(traffic.posts).toEqual([`${origin}/releases/${ids.first}/schedule`]);
    // Matching the target date proves nothing about this request, so no
    // confirmation or Undo is fabricated for it.
    await expect(page.locator('[data-dashboard-schedule-undo]')).toHaveCount(0);
    expect(await needsDateIds(page)).toEqual([ids.second, ids.third, ids.fourth]);
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest('#needs-date')))).toBe(true);

    await markRegion(page);
    await firstPick(page, ids.second).click();
    await waitForReplacement(page);
    expect(readSchedule(ids.second).planned_date).not.toBeNull();
    expect(traffic.posts).toHaveLength(2);
  });
});

test('a malformed response that did not commit leaves the release schedulable with current expectations', async ({ page }) => {
  await withDashboardApp(async ({ origin, ids, readSchedule }) => {
    const traffic = await openDashboard(page, origin);
    await page.route(`**/releases/${ids.first}/schedule`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":' }), { times: 1 });

    await markRegion(page);
    await firstPick(page, ids.first).click();
    await waitForReplacement(page);
    await expect(syncMessage(page)).toHaveText('We couldn’t confirm whether the schedule change was saved. “First Undated” currently has no release date.');
    expect(readSchedule(ids.first)).toEqual(UNDATED);
    await expect(firstPick(page, ids.first)).toBeEnabled();
    await expect(firstPick(page, ids.first)).toBeFocused();

    const request = page.waitForRequest((candidate) => candidate.method() === 'POST');
    await markRegion(page);
    await firstPick(page, ids.first).click();
    expect((await request).postDataJSON()).toMatchObject({ expectedPlannedDate: null, expectedPlannedTime: null });
    await waitForReplacement(page);
    await expect(scheduleRow(page, ids.first).locator('[data-dashboard-schedule-undo]')).toBeFocused();
    expect(traffic.posts).toHaveLength(2);
  });
});

test('an unconfirmed outcome whose refresh also fails stays blocked until a retry reconciles it', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 740 });
  await withDashboardApp(async ({ origin, ids, readSchedule }) => {
    const traffic = await openDashboard(page, origin);
    await page.route(`**/releases/${ids.first}/schedule`, (route) => route.abort('failed'), { times: 1 });
    await routeDashboardGet(page, (route) => route.fulfill({ status: 500, contentType: 'text/html', body: 'Server error' }));

    await firstPick(page, ids.first).click();
    await expect(syncState(page)).toHaveAttribute('data-state', 'blocked');
    await expect(syncMessage(page)).toHaveText(
      'We couldn’t confirm whether the schedule change was saved. The dashboard couldn’t refresh, so it may not show the current schedule. Scheduling is paused until the dashboard refreshes.',
    );
    await expect(syncState(page)).toBeInViewport();
    expect(await hasHorizontalScroll(page)).toBe(false);
    await expect(firstPick(page, ids.first)).toBeDisabled();
    await expect(scheduleRow(page, ids.first).locator('[data-dashboard-schedule-error]')).toContainText('couldn’t confirm');

    await firstPick(page, ids.second).click();
    await expect(scheduleRow(page, ids.second).locator('[data-dashboard-schedule-error]')).toContainText('Scheduling is paused');
    expect(traffic.posts).toEqual([`${origin}/releases/${ids.first}/schedule`]);

    await markRegion(page);
    await page.locator('[data-dashboard-sync-retry]').click();
    await waitForReplacement(page);
    await expect(syncMessage(page)).toHaveText('We couldn’t confirm whether the schedule change was saved. “First Undated” currently has no release date.');
    expect(readSchedule(ids.first)).toEqual(UNDATED);
    await expect(firstPick(page, ids.first)).toBeEnabled();
    await expect(scheduleRow(page, ids.first).locator('[data-dashboard-schedule-error]')).toBeHidden();
    expect(traffic.posts).toHaveLength(1);
    expect(await hasHorizontalScroll(page)).toBe(false);
  });
});

test('a conflict keeps the newer schedule, drops the stale row and keeps other confirmations', async ({ page }) => {
  await withDashboardApp(async ({ origin, db, ids, readSchedule }) => {
    const traffic = await openDashboard(page, origin);
    await markRegion(page);
    await firstPick(page, ids.second).click();
    await waitForReplacement(page);

    // Another actor dates the first release after this page rendered it.
    const newer = localDate(9);
    db.prepare('UPDATE releases SET planned_date = ? WHERE id = ?').run(newer, ids.first);
    await markRegion(page);
    await firstPick(page, ids.first).click();
    await waitForReplacement(page);

    await expect(syncMessage(page)).toHaveText(/^Nothing was overwritten because this release’s schedule was changed elsewhere\. “First Undated” is currently scheduled for /);
    expect(readSchedule(ids.first)).toEqual({ planned_date: newer, planned_time: null });
    await expect(page.locator(`[data-dashboard-needs-date-item][data-release-id="${ids.first}"]`)).toHaveCount(0);
    await expect(page.locator(`[data-dashboard-release-row][data-release-id="${ids.first}"]`)).toHaveCount(1);
    await expect(scheduleRow(page, ids.second).locator('[data-dashboard-schedule-undo]')).toBeVisible();
    expect(traffic.posts).toHaveLength(2);

    await markRegion(page);
    await scheduleRow(page, ids.second).locator('[data-dashboard-schedule-undo]').click();
    await waitForReplacement(page);
    expect(readSchedule(ids.second)).toEqual(UNDATED);
  });
});

test('a deleted release is explained and its row removed by the refresh, without retrying', async ({ page }) => {
  await withDashboardApp(async ({ origin, db, ids }) => {
    const traffic = await openDashboard(page, origin);
    db.prepare('DELETE FROM releases WHERE id = ?').run(ids.first);
    await markRegion(page);
    await firstPick(page, ids.first).click();
    await waitForReplacement(page);
    await expect(syncMessage(page)).toHaveText('This release no longer exists, so its schedule wasn’t changed. The dashboard has been refreshed.');
    await expect(page.locator(`[data-dashboard-needs-date-item][data-release-id="${ids.first}"]`)).toHaveCount(0);
    await expect(page.locator('[data-dashboard-tile="needs-date"] [data-dashboard-tile-count]')).toHaveText('3');
    expect(traffic.posts).toEqual([`${origin}/releases/${ids.first}/schedule`]);
  });
});

test('validation and CSRF failures stay inline, keep the draft and neither refresh nor retry', async ({ page }) => {
  await withDashboardApp(async ({ origin, db, ids, readSchedule }) => {
    const traffic = await openDashboard(page, origin);
    await markRegion(page);

    db.prepare('UPDATE releases SET published_date = ? WHERE id = ?').run(localDate(-1), ids.first);
    const dateInput = scheduleRow(page, ids.first).locator('[data-dashboard-schedule-date]');
    await dateInput.fill('2027-04-05');
    await expect(scheduleRow(page, ids.first).locator('[data-dashboard-schedule-error]')).toHaveText('Published releases cannot be rescheduled here.');
    await expect(page.locator('[data-dashboard-announcer]')).toHaveText('Published releases cannot be rescheduled here.');
    await expect(dateInput).toHaveValue('2027-04-05');
    await expect(dateInput).toBeFocused();
    await expect(dateInput).toBeEnabled();

    await page.route(`**/releases/${ids.second}/schedule`, (route) => route.continue({
      headers: { ...route.request().headers(), 'x-csrf-token': 'stale-token' },
    }), { times: 1 });
    await firstPick(page, ids.second).click();
    await expect(scheduleRow(page, ids.second).locator('[data-dashboard-schedule-error]')).toHaveText(/security check failed\. Reload the page/);
    await expect(firstPick(page, ids.second)).toBeEnabled();
    expect(readSchedule(ids.second)).toEqual(UNDATED);

    expect(traffic.posts).toHaveLength(2);
    expect(traffic.dashboardGets).toBe(0);
    expect(await page.evaluate(() => document.querySelector('[data-dashboard]').dataset.testStale)).toBe('true');
    await expect(syncState(page)).toBeHidden();
  });
});

test('a double click sends one write and each category, Undo and reload stay authoritative', async ({ page, context }) => {
  await withDashboardApp(async ({ origin, ids, readSchedule, secondStatus }) => {
    const traffic = await openDashboard(page, origin);
    const initial = await serverRegions(page);
    await page.locator(`[data-dashboard-status-filter="${secondStatus}"]`).click();
    await scheduleRow(page, ids.fourth).locator('[data-dashboard-schedule-date]').evaluate((input) => { input.value = '2027-06-07'; });

    await markRegion(page);
    await firstPick(page, ids.first).dblclick();
    await waitForReplacement(page);
    expect(traffic.posts).toEqual([`${origin}/releases/${ids.first}/schedule`]);
    await expect(page.locator(`[data-dashboard-release-row][data-release-id="${ids.first}"]`)).toHaveCount(1);
    // Undo, then reschedule the same release into Next 7 days by custom date.
    await markRegion(page);
    await scheduleRow(page, ids.first).locator('[data-dashboard-schedule-undo]').click();
    await waitForReplacement(page);
    await markRegion(page);
    await scheduleRow(page, ids.first).locator('[data-dashboard-schedule-date]').fill(localDate(2));
    await waitForReplacement(page);

    const targets = [
      [ids.second, localDate(-3), 'overdue'],
      [ids.third, localDate(0), 'today'],
      [ids.first, localDate(2), 'next7'],
    ];
    for (const [id, date] of targets) {
      if (id === ids.first) continue;
      await markRegion(page);
      await scheduleRow(page, id).locator('[data-dashboard-schedule-date]').fill(date);
      await waitForReplacement(page);
      expect(readSchedule(id)).toEqual({ planned_date: date, planned_time: null });
    }
    for (const [id, , group] of targets) {
      await expect(page.locator(`[data-dashboard-schedule-group="${group}"] [data-dashboard-release-row][data-release-id="${id}"]`)).toHaveCount(1);
    }
    // Later, through the restored draft, which stayed on its release.
    const fourthDate = scheduleRow(page, ids.fourth).locator('[data-dashboard-schedule-date]');
    await expect(fourthDate).toHaveValue('2027-06-07');
    await markRegion(page);
    await fourthDate.focus();
    await page.keyboard.press('Enter');
    await waitForReplacement(page);
    await expect(page.locator(`[data-dashboard-schedule-group="later"] [data-dashboard-release-row][data-release-id="${ids.fourth}"]`)).toHaveCount(1);

    await expect(page.locator('[data-dashboard-schedule-undo]')).toHaveCount(4);
    await expect(page.locator('[data-dashboard-tile="needs-date"] [data-dashboard-tile-count]')).toHaveText('0');
    await expectMatchesFreshRender(page, context, origin);

    for (const id of [ids.fourth, ids.second, ids.first, ids.third]) {
      await markRegion(page);
      await scheduleRow(page, id).locator('[data-dashboard-schedule-undo]').click();
      await waitForReplacement(page);
      expect(readSchedule(id)).toEqual(UNDATED);
    }
    expect(await serverRegions(page)).toEqual(initial);
    expect(await needsDateIds(page)).toEqual([ids.first, ids.second, ids.third, ids.fourth]);
    await expect(page.locator(`[data-dashboard-status-filter="${secondStatus}"]`)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-dashboard-project-row]:visible')).toHaveCount(1);
    expect(traffic.navigations).toBe(0);
    expect(traffic.posts).toHaveLength(10);

    // Confirmations belong to the page session only.
    await markRegion(page);
    await firstPick(page, ids.first).click();
    await waitForReplacement(page);
    await page.reload();
    await page.locator(SCHEDULE_BOUND).first().waitFor({ state: 'attached' });
    await expect(page.locator('[data-dashboard-schedule-undo]')).toHaveCount(0);
    expect(await needsDateIds(page)).toEqual([ids.second, ids.third, ids.fourth]);
    await expect(firstPick(page, ids.second)).toBeEnabled();
  });
});

// Counts the page gate's live reopen subscriptions from here on and rebinds
// every row through a refresh, so each bound row is counted.
async function trackReopenSubscriptions(page) {
  await page.evaluate(async () => {
    const { getDashboardMutationGate } = await import('/client/dashboard.js');
    const gate = getDashboardMutationGate(document);
    const subscribe = gate.onReopen;
    const live = new Set();
    window.testReopenSubscriptions = live;
    window.testScheduleRows = [];
    gate.onReopen = (listener) => {
      const token = {};
      live.add(token);
      const stop = subscribe(listener);
      return () => { live.delete(token); stop(); };
    };
  });
  await markRegion(page);
  await page.evaluate(async () => {
    const { refreshDashboard } = await import('/client/dashboard.js');
    return refreshDashboard(document);
  });
  await waitForReplacement(page);
}

function subscriptionCounts(page) {
  return page.evaluate((bound) => {
    for (const row of document.querySelectorAll('[data-dashboard-schedule]')) window.testScheduleRows.push(new WeakRef(row));
    return { live: window.testReopenSubscriptions.size, bound: document.querySelectorAll(bound).length };
  }, SCHEDULE_BOUND);
}

async function reachableDetachedRows(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.detach();
  return page.evaluate(() => {
    const rows = new Set(window.testScheduleRows.map((ref) => ref.deref()).filter((row) => row && !row.isConnected));
    return rows.size;
  });
}

test('repeated Schedule and Undo release retired rows from the recovery gate but keep retained confirmations subscribed', async ({ page }) => {
  await withDashboardApp(async ({ origin, ids, readSchedule }) => {
    const traffic = await openDashboard(page, origin);
    await trackReopenSubscriptions(page);
    const draft = scheduleRow(page, ids.fourth).locator('[data-dashboard-schedule-date]');
    // An unsent draft: assigning the value fires no change, so nothing submits.
    await draft.evaluate((input) => { input.value = '2027-03-04'; });
    expect(await subscriptionCounts(page)).toEqual({ live: 4, bound: 4 });

    const undo = (id) => scheduleRow(page, id).locator('[data-dashboard-schedule-undo]');
    for (let cycle = 0; cycle < 10; cycle += 1) {
      await markRegion(page);
      await firstPick(page, ids.first).click();
      await waitForReplacement(page);
      await expect(undo(ids.first)).toBeFocused();
      await expect(page.locator('[data-dashboard-announcer]')).toContainText('Scheduled for');
      expect(await subscriptionCounts(page)).toEqual({ live: 4, bound: 4 });

      await markRegion(page);
      await undo(ids.first).click();
      await waitForReplacement(page);
      await expect(firstPick(page, ids.first)).toBeVisible();
      expect(await subscriptionCounts(page)).toEqual({ live: 4, bound: 4 });
    }
    expect(readSchedule(ids.first)).toEqual(UNDATED);
    await expect(draft).toHaveValue('2027-03-04');
    expect(await reachableDetachedRows(page)).toBe(0);

    // Several retained confirmations survive further refreshes subscribed and
    // with working Undo controls.
    for (const id of [ids.first, ids.second, ids.third]) {
      await markRegion(page);
      await firstPick(page, id).click();
      await waitForReplacement(page);
      await expect(undo(id)).toBeVisible();
    }
    expect(await subscriptionCounts(page)).toEqual({ live: 4, bound: 4 });
    await markRegion(page);
    await undo(ids.second).click();
    await waitForReplacement(page);
    expect(readSchedule(ids.second)).toEqual(UNDATED);
    expect(await subscriptionCounts(page)).toEqual({ live: 4, bound: 4 });
    for (const id of [ids.first, ids.third]) {
      await markRegion(page);
      await undo(id).click();
      await waitForReplacement(page);
      expect(readSchedule(id)).toEqual(UNDATED);
    }
    expect(await subscriptionCounts(page)).toEqual({ live: 4, bound: 4 });
    await expect(draft).toHaveValue('2027-03-04');
    expect(await reachableDetachedRows(page)).toBe(0);
    expect(traffic.posts).toHaveLength(26);
    expect(readSchedule(ids.fourth)).toEqual(UNDATED);
    expect(traffic.navigations).toBe(0);
  });
});

test('failed refreshes keep active rows subscribed and release rows a partial replacement detached', async ({ page }) => {
  await withDashboardApp(async ({ origin, ids }) => {
    const traffic = await openDashboard(page, origin);
    await trackReopenSubscriptions(page);
    const error = (id) => scheduleRow(page, id).locator('[data-dashboard-schedule-error]');
    const sync = syncState(page);

    // A refresh failing before replacement leaves every row active.
    await routeDashboardGet(page, (route) => route.fulfill({ status: 503, contentType: 'text/html', body: 'Unavailable' }));
    await firstPick(page, ids.first).click();
    await expect(sync).toHaveAttribute('data-state', 'blocked');
    expect(await subscriptionCounts(page)).toEqual({ live: 4, bound: 4 });
    await firstPick(page, ids.second).click();
    await expect(error(ids.second)).toContainText('Scheduling is paused');

    // A replacement whose restoration fails detaches every previous row,
    // including the confirmation it could not carry over.
    await page.evaluate(() => {
      const today = document.querySelector('.dashboard-today');
      today.replaceChildren = () => { delete today.replaceChildren; throw new Error('restore failed'); };
    });
    await markRegion(page);
    await sync.locator('[data-dashboard-sync-retry]').click();
    await expect(syncMessage(page)).toContainText('Try again, or reload the page.');
    await expect(sync).toHaveAttribute('data-state', 'blocked');
    expect(await subscriptionCounts(page)).toEqual({ live: 0, bound: 0 });
    expect(await reachableDetachedRows(page)).toBe(0);

    await markRegion(page);
    await sync.locator('[data-dashboard-sync-retry]').click();
    await waitForReplacement(page);
    await expect(sync).toHaveAttribute('data-state', 'notice');
    expect(await subscriptionCounts(page)).toEqual({ live: 3, bound: 3 });
    await expect(page.locator('[data-dashboard-schedule-error]:visible')).toHaveCount(0);
    expect(traffic.posts).toHaveLength(1);

    await markRegion(page);
    await firstPick(page, ids.second).click();
    await waitForReplacement(page);
    await expect(scheduleRow(page, ids.second).locator('[data-dashboard-schedule-undo]')).toBeFocused();
    expect(await subscriptionCounts(page)).toEqual({ live: 3, bound: 3 });
  });
});

function trackDatePickerFields(page) {
  return page.evaluate(() => {
    window.testDatePickerFields ??= [];
    for (const field of document.querySelectorAll('[data-dashboard] [data-date-picker-field]')) {
      window.testDatePickerFields.push(new WeakRef(field));
    }
  });
}

async function reachableDetachedDatePickers(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.detach();
  return page.evaluate(() => window.testDatePickerFields
    .map((ref) => ref.deref()).filter((field) => field && !field.isConnected).length);
}

async function documentListenerCounts(page) {
  const cdp = await page.context().newCDPSession(page);
  const { result } = await cdp.send('Runtime.evaluate', { expression: 'document' });
  const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
  await cdp.detach();
  return {
    click: listeners.filter(({ type }) => type === 'click').length,
    keydown: listeners.filter(({ type }) => type === 'keydown').length,
  };
}

test('a partial replacement with no date pickers releases the detached pickers at once, and Retry restores working ones', async ({ page }) => {
  await withDashboardApp(async ({ origin, db, ids, readSchedule }) => {
    // Only the fourth release is left undated.
    db.prepare('UPDATE releases SET planned_date = ? WHERE id IN (?, ?, ?)')
      .run(localDate(40), ids.first, ids.second, ids.third);
    const traffic = await openDashboard(page, origin);
    expect(await needsDateIds(page)).toEqual([ids.fourth]);
    await trackDatePickerFields(page);
    const listenersBefore = await documentListenerCounts(page);
    const sync = syncState(page);

    // Scheduling the last undated release replaces the region with one that
    // has no date pickers; restoring the confirmation into it then fails.
    await page.evaluate(() => {
      const today = document.querySelector('.dashboard-today');
      today.replaceChildren = () => { delete today.replaceChildren; throw new Error('restore failed'); };
    });
    await markRegion(page);
    // Activated from the keyboard: the page's pointer-press record would
    // otherwise keep the pressed button, and so its old subtree, reachable
    // until the next press.
    await firstPick(page, ids.fourth).focus();
    await page.keyboard.press('Enter');
    await expect(sync).toHaveAttribute('data-state', 'blocked');
    expect(readSchedule(ids.fourth).planned_date).not.toBeNull();
    expect(await page.locator('[data-dashboard] [data-date-picker-field]').count()).toBe(0);
    // No click, Escape or open has happened since the replacement.
    expect(await reachableDetachedDatePickers(page)).toBe(0);

    // The retried refresh renders a release that became undated meanwhile.
    db.prepare('UPDATE releases SET planned_date = NULL WHERE id = ?').run(ids.third);
    await sync.locator('[data-dashboard-sync-retry]').click();
    await expect(sync).toHaveAttribute('data-state', 'notice');
    expect(await needsDateIds(page)).toEqual([ids.third]);
    await trackDatePickerFields(page);

    const row = scheduleRow(page, ids.third);
    const trigger = row.locator('[data-dashboard-schedule-calendar]');
    const panel = row.locator('[data-date-picker-panel]');
    await trigger.click();
    await expect(panel).toBeVisible();
    await syncMessage(page).click();
    await expect(panel).toBeHidden();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await trigger.click();
    await expect(panel).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(trigger).toBeFocused();
    expect(await documentListenerCounts(page)).toEqual(listenersBefore);

    await trigger.click();
    await panel.locator('.date-picker-next').click();
    const picked = await panel.locator('.date-picker-day:not([disabled])').nth(14).getAttribute('data-date');
    await panel.locator(`.date-picker-day[data-date="${picked}"]`).click();
    await expect(row.locator('[data-dashboard-schedule-undo]')).toBeFocused();
    await waitForReplacement(page);
    expect(readSchedule(ids.third)).toEqual({ planned_date: picked, planned_time: null });
    await row.locator('[data-dashboard-schedule-undo]').click();
    await expect(firstPick(page, ids.third)).toBeFocused();
    expect(readSchedule(ids.third)).toEqual(UNDATED);
    expect(traffic.posts).toHaveLength(3);
    expect(traffic.navigations).toBe(0);
    expect(await documentListenerCounts(page)).toEqual(listenersBefore);
    expect(await reachableDetachedDatePickers(page)).toBe(0);
  });
});
