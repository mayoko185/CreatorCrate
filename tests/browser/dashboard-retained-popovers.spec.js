import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { openDatabase, closeDatabase, runMigrations } from '../../src/db.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function localDate(offsetDays = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// The project card's "Next release" label for a future date-only release.
function nextReleaseLabel(isoDate) {
  const [year, month, day] = isoDate.split('-').map(Number);
  return `${MONTHS_SHORT[month - 1]} ${day}${year !== new Date().getFullYear() ? `, ${year}` : ''}`;
}

async function withDashboardApp(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-dashboard-retained-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    const [status] = app.locals.projectOptionCatalogueService.getStatusCatalogue()
      .map(({ value }) => value).filter((value) => value !== 'archived');
    const projects = app.locals.projectService;
    const insert = db.prepare(`
      INSERT INTO releases (project_id, title, description, notes, planned_date, planned_time, patreon_url, published_date, archived_at, created_at)
      VALUES (?, ?, '', '', ?, NULL, NULL, NULL, NULL, ?)
    `);
    const release = (projectId, title, plannedDate, createdAt) => Number(
      insert.run(projectId, title, plannedDate, createdAt).lastInsertRowid,
    );
    const solo = projects.create({ title: 'Solo Project', status });
    const shared = projects.create({ title: 'Shared Project', status });
    const busy = projects.create({ title: 'Busy Project', status });
    const ids = {
      solo: release(solo.id, 'Solo Undated', null, '2026-01-01 00:00:00'),
      sharedA: release(shared.id, 'Shared A', null, '2026-01-02 00:00:00'),
      sharedB: release(shared.id, 'Shared B', null, '2026-01-03 00:00:00'),
    };
    // Five Later releases fill the Later group, so anything dated after them
    // is not listed in Scheduled releases.
    for (let index = 0; index < 5; index += 1) release(busy.id, `Later ${index}`, localDate(40 + index), '2026-01-04 00:00:00');
    const readSchedule = (id) => db.prepare('SELECT planned_date, planned_time FROM releases WHERE id = ?').get(id);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    await run({
      origin: `http://127.0.0.1:${server.address().port}`,
      db, app, status, ids, projectIds: { solo: solo.id, shared: shared.id }, readSchedule,
    });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const SCHEDULE_BOUND = '[data-dashboard-schedule][data-dashboard-schedule-bound="true"]';

async function openDashboard(page, origin) {
  await page.goto(`${origin}/`);
  await page.locator(SCHEDULE_BOUND).first().waitFor({ state: 'attached' });
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

async function refreshNow(page) {
  await markRegion(page);
  const outcome = await page.evaluate(async () => {
    const { refreshDashboard } = await import('/client/dashboard.js');
    return refreshDashboard(document);
  });
  expect(outcome).toEqual({ status: 'refreshed' });
  await waitForReplacement(page);
}

function scheduleRow(page, id) {
  return page.locator(`[data-dashboard-schedule][data-release-id="${id}"]`);
}

function needsDateItem(page, id) {
  return page.locator(`[data-dashboard-needs-date-item][data-release-id="${id}"]`);
}

const releaseCardId = (id) => `dashboard-release-info-needs-date-${id}`;
const projectCardId = (id) => `dashboard-project-info-needs-date-${id}`;

function titleTrigger(page, cardId) {
  return page.locator('[data-dashboard-title-info]').filter({ has: page.locator(`#${cardId}`) })
    .locator(':scope > [data-calendar-info-trigger]');
}

// Pins a title popover with a real click, as a user would, after an outside
// click has dismissed any card already pinned.
async function openCard(page, cardId) {
  await page.locator('h1').first().click();
  await titleTrigger(page, cardId).click();
  const card = page.locator(`#${cardId}`);
  await expect(card).toBeVisible();
  await expect(titleTrigger(page, cardId)).toHaveAttribute('aria-expanded', 'true');
  return card;
}

async function cardFact(card, label) {
  const row = card.locator('.asset-viewer-grid-card-info-row').filter({ has: card.page().locator(`dt:text-is("${label}")`) });
  return (await row.count()) ? (await row.locator('dd').textContent()).trim() : null;
}

function duplicateIds(page) {
  return page.evaluate(() => {
    const seen = new Set();
    const duplicates = new Set();
    for (const { id } of document.querySelectorAll('[id]')) (seen.has(id) ? duplicates : seen).add(id);
    return [...duplicates];
  });
}

function openCardCount(page) {
  return page.locator('[data-calendar-info-card][data-info-card-open]').count();
}

async function scheduleWithPick(page, id) {
  const pick = scheduleRow(page, id).locator('[data-dashboard-schedule-pick]').first();
  const date = await pick.getAttribute('data-planned-date');
  await markRegion(page);
  await pick.click();
  await waitForReplacement(page);
  return date;
}

async function scheduleWithDate(page, id, date) {
  const input = scheduleRow(page, id).locator('[data-dashboard-schedule-date]');
  await markRegion(page);
  // A complete date from the picker commits on change.
  await input.fill(date);
  await waitForReplacement(page);
}

test('a retained confirmation shows the current release and project popovers, and Undo restores the undated ones', async ({ page }) => {
  await withDashboardApp(async ({ origin, ids, readSchedule }) => {
    await openDashboard(page, origin);
    let card = await openCard(page, projectCardId(ids.solo));
    expect(await cardFact(card, 'Next release')).toBe('No date set');

    const date = await scheduleWithPick(page, ids.solo);
    expect(readSchedule(ids.solo)).toEqual({ planned_date: date, planned_time: null });
    await expect(scheduleRow(page, ids.solo).locator('[data-dashboard-schedule-status]')).toContainText('Scheduled for');
    await expect(scheduleRow(page, ids.solo).locator('[data-dashboard-schedule-undo]')).toBeFocused();
    await expect(page.locator('[data-dashboard-retained-titles]')).toHaveCount(0);

    card = await openCard(page, releaseCardId(ids.solo));
    expect(await cardFact(card, 'Planned')).toBe(date);
    expect(await openCardCount(page)).toBe(1);
    card = await openCard(page, projectCardId(ids.solo));
    expect(await cardFact(card, 'Next release')).toBe(nextReleaseLabel(date));
    expect(await openCardCount(page)).toBe(1);
    expect(await duplicateIds(page)).toEqual([]);

    // Undo still works from the refreshed confirmation and the row returns to
    // the server's undated rendering.
    await markRegion(page);
    await scheduleRow(page, ids.solo).locator('[data-dashboard-schedule-undo]').click();
    await waitForReplacement(page);
    expect(readSchedule(ids.solo)).toEqual({ planned_date: null, planned_time: null });
    await expect(scheduleRow(page, ids.solo).locator('[data-dashboard-schedule-pick]').first()).toBeFocused();
    card = await openCard(page, releaseCardId(ids.solo));
    expect(await cardFact(card, 'Planned')).toBeNull();
    card = await openCard(page, projectCardId(ids.solo));
    expect(await cardFact(card, 'Next release')).toBe('No date set');
    expect(await duplicateIds(page)).toEqual([]);
  });
});

test('several confirmations in one project stay current across repeated refreshes', async ({ page }) => {
  await withDashboardApp(async ({ origin, db, ids, readSchedule }) => {
    await openDashboard(page, origin);
    const firstDate = await scheduleWithPick(page, ids.sharedA);
    // While Shared B is undated the project has one undated release left.
    let card = await openCard(page, projectCardId(ids.sharedA));
    expect(await cardFact(card, 'Next release')).toBe(`${nextReleaseLabel(firstDate)} (+1 no date)`);

    const secondDate = await scheduleWithPick(page, ids.sharedB);
    const earliest = [firstDate, secondDate].sort()[0];
    // The first confirmation's project popover was rendered before Shared B
    // was scheduled; the refresh must replace it too.
    for (const id of [ids.sharedA, ids.sharedB]) {
      card = await openCard(page, projectCardId(id));
      expect(await cardFact(card, 'Next release')).toBe(nextReleaseLabel(earliest));
    }
    card = await openCard(page, releaseCardId(ids.sharedB));
    expect(await cardFact(card, 'Planned')).toBe(secondDate);
    await expect(page.locator('[data-dashboard-schedule-undo]')).toHaveCount(2);

    // Keyboard focus on a retained title survives a refresh on its new node
    // without pinning it, and the card it then pins is the refreshed one.
    await page.locator('h1').first().click();
    await titleTrigger(page, projectCardId(ids.sharedA)).focus();
    await refreshNow(page);
    await refreshNow(page);
    await expect(titleTrigger(page, projectCardId(ids.sharedA))).toBeFocused();
    await expect(page.locator(`#${projectCardId(ids.sharedA)}`)).toBeHidden();
    expect(await openCardCount(page)).toBe(0);
    await page.keyboard.press('Enter');
    await expect(page.locator(`#${projectCardId(ids.sharedA)}`)).toBeVisible();
    expect(await openCardCount(page)).toBe(1);

    // A change made elsewhere reaches the retained popovers on the next refresh.
    const movedDate = localDate(20);
    db.prepare('UPDATE releases SET planned_date = ? WHERE id = ?').run(movedDate, ids.sharedA);
    await refreshNow(page);
    card = await openCard(page, releaseCardId(ids.sharedA));
    expect(await cardFact(card, 'Planned')).toBe(movedDate);
    card = await openCard(page, projectCardId(ids.sharedB));
    expect(await cardFact(card, 'Next release')).toBe(nextReleaseLabel([movedDate, secondDate].sort()[0]));
    await expect(page.locator(`[data-dashboard-needs-date-item]`)).toHaveCount(3);
    expect(await duplicateIds(page)).toEqual([]);

    // Undo still sends the confirmed schedule as expected, so the outside
    // change is protected rather than overwritten.
    await markRegion(page);
    await scheduleRow(page, ids.sharedA).locator('[data-dashboard-schedule-undo]').click();
    await waitForReplacement(page);
    expect(readSchedule(ids.sharedA)).toEqual({ planned_date: movedDate, planned_time: null });
    await expect(page.locator('[data-dashboard-sync-message]')).toContainText('Undo wasn’t applied');
  });
});

test('a release scheduled past the Later cap in a project past the table cap keeps current popovers', async ({ page }) => {
  await withDashboardApp(async ({ origin, db, app, status, ids, projectIds }) => {
    // Fifty more recently updated projects push Solo Project out of the table.
    for (let index = 0; index < 50; index += 1) app.locals.projectService.create({ title: `Filler ${index}`, status });
    db.prepare("UPDATE projects SET updated_at = '2000-01-01 00:00:00' WHERE id = ?").run(projectIds.solo);
    await openDashboard(page, origin);

    const date = localDate(400);
    await scheduleWithDate(page, ids.solo, date);
    await expect(page.locator(`[data-dashboard-release-row][data-release-id="${ids.solo}"]`)).toHaveCount(0);
    await expect(page.locator(`[data-dashboard-project-row][data-project-id="${projectIds.solo}"]`)).toHaveCount(0);
    await expect(needsDateItem(page, ids.solo).locator('[data-dashboard-schedule-undo]')).toBeVisible();

    let card = await openCard(page, releaseCardId(ids.solo));
    expect(await cardFact(card, 'Planned')).toBe(date);
    card = await openCard(page, projectCardId(ids.solo));
    expect(await cardFact(card, 'Next release')).toBe(nextReleaseLabel(date));
    expect(await duplicateIds(page)).toEqual([]);
  });
});

test('a retained release the server no longer lists is not kept with stale popovers', async ({ page }) => {
  await withDashboardApp(async ({ origin, db, ids }) => {
    await openDashboard(page, origin);
    await scheduleWithPick(page, ids.solo);
    await expect(needsDateItem(page, ids.solo)).toHaveCount(1);

    db.prepare("UPDATE releases SET archived_at = datetime('now') WHERE id = ?").run(ids.solo);
    await refreshNow(page);
    await expect(needsDateItem(page, ids.solo)).toHaveCount(0);
    await expect(page.locator(`#${releaseCardId(ids.solo)}`)).toHaveCount(0);
    await expect(page.locator('[data-dashboard-retained-titles]')).toHaveCount(0);
  });
});

test('twelve consecutive confirmations all stay with current popovers and working Undo', async ({ page }) => {
  await withDashboardApp(async ({ origin, db, app, status, readSchedule }) => {
    // Created before the fixture's undated releases, so they head the
    // undated list; 23 undated releases in all.
    const many = app.locals.projectService.create({ title: 'Many Project', status });
    const insert = db.prepare(`
      INSERT INTO releases (project_id, title, description, notes, planned_date, planned_time, patreon_url, published_date, archived_at, created_at)
      VALUES (?, ?, '', '', NULL, NULL, NULL, NULL, NULL, ?)
    `);
    const ids = Array.from({ length: 20 }, (_, index) => Number(insert.run(
      many.id, `Many ${index}`, `2025-12-01 00:00:${String(index).padStart(2, '0')}`,
    ).lastInsertRowid));
    const scheduled = ids.slice(0, 12);
    const needsDateCount = page.locator('[data-dashboard-tile="needs-date"] [data-dashboard-tile-count]');
    const undoButtons = page.locator('[data-dashboard-needs-date-item] [data-dashboard-schedule-undo]');
    const undatedItems = page.locator('[data-dashboard-needs-date-item]:not(:has([data-dashboard-schedule-undo]))');

    await openDashboard(page, origin);
    await expect(undatedItems).toHaveCount(10);
    await expect(needsDateCount).toHaveText('23');

    const dates = new Map();
    for (const [index, id] of scheduled.entries()) {
      dates.set(id, await scheduleWithPick(page, id));
      expect(readSchedule(id)).toEqual({ planned_date: dates.get(id), planned_time: null });
      await expect(scheduleRow(page, id).locator('[data-dashboard-schedule-undo]')).toBeFocused();
      await expect(undoButtons).toHaveCount(index + 1);
      await expect(needsDateCount).toHaveText(String(23 - index - 1));
    }

    // Every confirmation stays, in scheduling order, ahead of the server's
    // still-capped undated list.
    const order = await page.locator('[data-dashboard-needs-date-item]').evaluateAll(
      (items) => items.map((item) => Number(item.getAttribute('data-release-id'))),
    );
    expect(order.slice(0, 12)).toEqual(scheduled);
    await expect(undatedItems).toHaveCount(10);
    await expect(page.locator('#needs-date a[href="/releases?schedule=unscheduled"]')).toBeVisible();

    // Repeated refreshes ask for every retained release and drop none.
    for (let pass = 0; pass < 3; pass += 1) await refreshNow(page);
    await expect(undoButtons).toHaveCount(12);
    expect(new URL(page.url()).search).toBe('');

    // One project, eight undated releases left, earliest date first: every
    // retained project popover agrees, and each release popover has its date.
    const earliest = [...dates.values()].sort()[0];
    for (const id of scheduled) {
      await expect(page.locator(`#${releaseCardId(id)} time`)).toHaveText(dates.get(id));
      await expect(page.locator(`#${projectCardId(id)}`)).toContainText(`${nextReleaseLabel(earliest)} (+8 no date)`);
    }
    let card = await openCard(page, releaseCardId(scheduled[11]));
    expect(await cardFact(card, 'Planned')).toBe(dates.get(scheduled[11]));
    card = await openCard(page, projectCardId(scheduled[10]));
    expect(await cardFact(card, 'Next release')).toBe(`${nextReleaseLabel(earliest)} (+8 no date)`);
    expect(await openCardCount(page)).toBe(1);
    expect(await duplicateIds(page)).toEqual([]);

    // Undo on the twelfth restores only that release.
    await markRegion(page);
    await scheduleRow(page, scheduled[11]).locator('[data-dashboard-schedule-undo]').click();
    await waitForReplacement(page);
    expect(readSchedule(scheduled[11])).toEqual({ planned_date: null, planned_time: null });
    for (const id of scheduled.slice(0, 11)) {
      expect(readSchedule(id)).toEqual({ planned_date: dates.get(id), planned_time: null });
      await expect(scheduleRow(page, id).locator('[data-dashboard-schedule-undo]')).toHaveCount(1);
    }
    await expect(undoButtons).toHaveCount(11);
    await expect(needsDateCount).toHaveText('12');
    await expect(scheduleRow(page, scheduled[11]).locator('[data-dashboard-schedule-pick]').first()).toBeFocused();
    await expect(undatedItems).toHaveCount(10);
    card = await openCard(page, projectCardId(scheduled[0]));
    expect(await cardFact(card, 'Next release')).toBe(`${nextReleaseLabel(earliest)} (+9 no date)`);

    // Undo on the eleventh, from a confirmation retained across all of the above.
    await markRegion(page);
    await scheduleRow(page, scheduled[10]).locator('[data-dashboard-schedule-undo]').click();
    await waitForReplacement(page);
    expect(readSchedule(scheduled[10])).toEqual({ planned_date: null, planned_time: null });
    await expect(undoButtons).toHaveCount(10);
    await expect(needsDateCount).toHaveText('13');
    expect(await duplicateIds(page)).toEqual([]);

    // Confirmations belong to the page session only.
    await page.reload();
    await page.locator(SCHEDULE_BOUND).first().waitFor({ state: 'attached' });
    await expect(undoButtons).toHaveCount(0);
    await expect(page.locator('[data-dashboard-needs-date-item]')).toHaveCount(10);
    await expect(needsDateCount).toHaveText('13');
  });
});
