import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { openDatabase, closeDatabase, runMigrations } from '../../src/db.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';

async function withDashboardApp(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-dashboard-scheduling-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    const project = app.locals.projectService.create({ title: 'Scheduling Project' });
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO releases (project_id, title, description, notes, planned_date, planned_time, patreon_url, published_date, archived_at)
      VALUES (?, 'Undated Release', '', '', NULL, NULL, NULL, NULL, NULL)
    `).run(project.id);
    const releaseId = Number(lastInsertRowid);
    const readSchedule = () => db.prepare('SELECT planned_date, planned_time FROM releases WHERE id = ?').get(releaseId);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    await run({ origin: `http://127.0.0.1:${server.address().port}`, releaseId, readSchedule });
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

test('normal initialization activates scheduling once, alongside Projects filtering', async ({ page }) => {
  await withDashboardApp(async ({ origin, releaseId }) => {
    await openDashboard(page, origin);
    const row = page.locator(`[data-dashboard-schedule][data-release-id="${releaseId}"]`);
    await expect(row.locator('[data-dashboard-schedule-pick]').first()).toBeEnabled();
    await expect(row.locator('[data-dashboard-schedule-date]')).toBeEnabled();
    await expect(row.locator('[data-dashboard-schedule-set]')).toBeHidden();
    await expect(page.locator('[data-dashboard-status-filters][data-dashboard-status-filters-bound="true"]')).toHaveCount(1);
    await expect(page.locator('[data-dashboard-sync]')).toBeHidden();

    // Initialising again must not add listeners that send a second POST.
    await page.evaluate(async () => {
      const { enhanceDashboardScheduling } = await import('/client/dashboard.js');
      enhanceDashboardScheduling(document);
      enhanceDashboardScheduling(document);
    });
    const posts = [];
    page.on('request', (request) => { if (request.method() === 'POST') posts.push(request.url()); });
    await row.locator('[data-dashboard-schedule-pick]').first().click();
    await expect(row.locator('[data-dashboard-schedule-undo]')).toBeFocused();
    expect(posts).toEqual([`${origin}/releases/${releaseId}/schedule`]);
  });
});

test('quick pick, Undo and custom date use the schedule endpoint without navigating', async ({ page }) => {
  await withDashboardApp(async ({ origin, releaseId, readSchedule }) => {
    await openDashboard(page, origin);
    const startUrl = page.url();
    const posts = [];
    let navigations = 0;
    page.on('request', (request) => { if (request.method() === 'POST') posts.push(request.url()); });
    page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations += 1; });

    const row = page.locator(`[data-dashboard-schedule][data-release-id="${releaseId}"]`);
    const pick = row.locator('[data-dashboard-schedule-pick]').first();
    const pickedDate = await pick.getAttribute('data-planned-date');
    const announcer = page.locator('[data-dashboard-announcer]');

    await pick.click();
    const undo = row.locator('[data-dashboard-schedule-undo]');
    await expect(undo).toBeFocused();
    await expect(row.locator('[data-dashboard-schedule-status]')).toContainText('Scheduled for');
    await expect(row.locator('[data-dashboard-schedule-quick-form]')).toBeHidden();
    await expect(announcer).toHaveText(/^Scheduled for /);
    expect(readSchedule()).toEqual({ planned_date: pickedDate, planned_time: null });

    await page.keyboard.press('Enter');
    await expect(row.locator('[data-dashboard-schedule-pick]').first()).toBeFocused();
    await expect(row.locator('[data-dashboard-schedule-pick]').first()).toBeEnabled();
    // The row was replaced by fresh markup; the page-level announcement survives.
    await expect(announcer).toHaveText(/^Undid scheduling for .*This release needs a date again\.$/);
    expect(readSchedule()).toEqual({ planned_date: null, planned_time: null });

    const dateInput = row.locator('[data-dashboard-schedule-date]');
    await expect(dateInput).toHaveAccessibleName('Release date');
    await dateInput.fill('2026-12-24');
    await expect(row.locator('[data-dashboard-schedule-undo]')).toBeFocused();
    expect(readSchedule()).toEqual({ planned_date: '2026-12-24', planned_time: null });

    expect(posts).toEqual(Array(3).fill(`${origin}/releases/${releaseId}/schedule`));
    expect(page.url()).toBe(startUrl);
    expect(navigations).toBe(0);
    await expect(page.locator('[data-dashboard-sync]')).toBeHidden();
  });
});

test('typing a date commits on Enter, never on the intermediate values the native input reports', async ({ page }) => {
  await withDashboardApp(async ({ origin, releaseId, readSchedule }) => {
    await openDashboard(page, origin);
    const posts = [];
    page.on('request', (request) => { if (request.method() === 'POST') posts.push(request.postDataJSON()); });
    const row = page.locator(`[data-dashboard-schedule][data-release-id="${releaseId}"]`);
    const dateInput = row.locator('[data-dashboard-schedule-date]');

    // An unsent draft, as restored after a dashboard refresh, edited by keyboard.
    await dateInput.evaluate((input) => { input.value = '2027-02-03'; });
    await dateInput.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.type('15');
    await expect(dateInput).toHaveValue('2027-02-15');
    expect(posts).toEqual([]);
    expect(readSchedule()).toEqual({ planned_date: null, planned_time: null });

    await page.keyboard.press('Enter');
    await expect(row.locator('[data-dashboard-schedule-undo]')).toBeFocused();
    expect(posts.map(({ plannedDate }) => plannedDate)).toEqual(['2027-02-15']);
    expect(readSchedule()).toEqual({ planned_date: '2027-02-15', planned_time: null });
  });
});

test('a stale Undo is refused with 409, reconciled from the server and never overwrites', async ({ page }) => {
  await withDashboardApp(async ({ origin, releaseId, readSchedule }) => {
    await openDashboard(page, origin);
    const posts = [];
    page.on('request', (request) => { if (request.method() === 'POST') posts.push(request.url()); });
    const row = page.locator(`[data-dashboard-schedule][data-release-id="${releaseId}"]`);
    await row.locator('[data-dashboard-schedule-pick]').first().click();
    const undo = row.locator('[data-dashboard-schedule-undo]');
    await expect(undo).toBeFocused();

    // Another tab changes the schedule after this one confirmed its write.
    const current = readSchedule();
    const csrf = await page.locator('[data-dashboard-schedule] [name="_csrf"]').first().inputValue();
    const changed = await page.evaluate(async ({ url, csrf, expected }) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ plannedDate: '2027-01-05', plannedTime: null, expectedPlannedDate: expected, expectedPlannedTime: null }),
      });
      return response.status;
    }, { url: `/releases/${releaseId}/schedule`, csrf, expected: current.planned_date });
    expect(changed).toBe(200);
    posts.length = 0;

    await undo.click();
    const sync = page.locator('[data-dashboard-sync]');
    await expect(sync).toHaveAttribute('data-state', 'notice');
    await expect(sync.locator('[data-dashboard-sync-message]')).toHaveText(
      'Undo wasn’t applied because this release’s schedule was changed elsewhere. “Undated Release” is currently scheduled for Tue, Jan 5, 2027.',
    );
    await expect(page.locator('[data-dashboard-announcer]')).toHaveText(/^Undo wasn’t applied/);
    expect(readSchedule()).toEqual({ planned_date: '2027-01-05', planned_time: null });
    expect(posts).toEqual([`${origin}/releases/${releaseId}/schedule`]);
    // The stale confirmation and its Undo are gone; the release left the queue.
    await expect(page.locator('[data-dashboard-schedule-undo]')).toHaveCount(0);
    await expect(page.locator(`[data-dashboard-needs-date-item][data-release-id="${releaseId}"]`)).toHaveCount(0);
    await expect(page.locator(`[data-dashboard-release-row][data-release-id="${releaseId}"] .dashboard-date-block time`)).toHaveAttribute('datetime', '2027-01-05');
  });
});
