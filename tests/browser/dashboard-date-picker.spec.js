import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { openDatabase, closeDatabase, runMigrations } from '../../src/db.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';

const UNDATED = { planned_date: null, planned_time: null };

async function withDashboardApp(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-dashboard-date-picker-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    const project = app.locals.projectService.create({ title: 'Picker Project' });
    const insert = db.prepare(`
      INSERT INTO releases (project_id, title, description, notes, planned_date, planned_time, patreon_url, published_date, archived_at, created_at)
      VALUES (?, ?, '', '', NULL, NULL, NULL, NULL, NULL, ?)
    `);
    // Needs-a-date lists the oldest first, so the ids keep this order.
    const ids = ['First', 'Second', 'Third'].map((title, index) => Number(
      insert.run(project.id, `${title} Release`, `2020-01-0${index + 1} 12:00:00`).lastInsertRowid,
    ));
    const readSchedule = (id) => db.prepare('SELECT planned_date, planned_time FROM releases WHERE id = ?').get(id);
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    await run({ origin: `http://127.0.0.1:${server.address().port}`, ids, readSchedule });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const SCHEDULE_BOUND = '[data-dashboard-schedule][data-dashboard-schedule-bound="true"]';

async function openDashboard(page, origin) {
  const posts = [];
  page.on('request', (request) => { if (request.method() === 'POST') posts.push(request.postDataJSON()); });
  await page.goto(`${origin}/`);
  await page.locator(SCHEDULE_BOUND).first().waitFor({ state: 'attached' });
  return posts;
}

function controls(page, id) {
  const row = page.locator(`[data-dashboard-schedule][data-release-id="${id}"]`);
  return {
    row,
    input: row.locator('[data-dashboard-schedule-date]'),
    trigger: row.locator('[data-dashboard-schedule-calendar]'),
    panel: row.locator('[data-date-picker-panel]'),
    day: (iso) => row.locator(`[data-date-picker-panel] .date-picker-day[data-date="${iso}"]`),
    undo: row.locator('[data-dashboard-schedule-undo]'),
    status: row.locator('[data-dashboard-schedule-status]'),
    error: row.locator('[data-dashboard-schedule-error]'),
  };
}

// Writes go out synchronously from the triggering event; one task turn plus a
// network round trip is enough for a premature POST to show up.
async function settle(page) {
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 150)));
}

async function waitForRefresh(page) {
  await page.waitForFunction(() => !document.querySelector('[data-dashboard]')?.hasAttribute('aria-busy')
    && !document.querySelector('[data-dashboard-schedule][aria-busy]'));
}

function scheduledLabel(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  const options = { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' };
  if (year !== new Date().getFullYear()) options.year = 'numeric';
  return new Intl.DateTimeFormat('en-US', options).format(new Date(Date.UTC(year, month - 1, day)));
}

async function firstDayNextMonth(c) {
  await c.panel.locator('.date-picker-next').click();
  return c.panel.locator('.date-picker-day:not([disabled])').nth(14).getAttribute('data-date');
}

test('the Dashboard uses the CreatorCrate calendar, and a picked day schedules exactly once and undoes', async ({ page }) => {
  await withDashboardApp(async ({ origin, ids, readSchedule }) => {
    const posts = await openDashboard(page, origin);
    const c = controls(page, ids[0]);

    await expect(c.input).toHaveAttribute('type', 'date');
    await expect(c.input).toHaveAccessibleName('Release date');
    await expect(c.trigger).toHaveAttribute('type', 'button');
    await expect(c.trigger).toHaveAccessibleName('Open calendar for First Release');
    await expect(c.trigger).toHaveAttribute('aria-controls', `dashboard-schedule-date-${ids[0]}-calendar`);
    await expect(c.panel).toHaveAttribute('id', `dashboard-schedule-date-${ids[0]}-calendar`);
    await expect(page.locator(`label[for="dashboard-schedule-date-${ids[0]}"]`)).toHaveCount(1);
    // The native calendar indicator is hidden by the shared scheduling rule.
    expect(await c.input.evaluate((input) => [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules])
      .some((rule) => rule.style?.display === 'none' && rule.selectorText?.split(',')
        .some((selector) => selector.includes('::-webkit-calendar-picker-indicator')
          && input.matches(selector.replace('::-webkit-calendar-picker-indicator', '')))))).toBe(true);
    await expect(c.row.locator('[data-dashboard-schedule-set]')).toBeHidden();
    await expect(c.panel).toBeHidden();

    await c.trigger.click();
    await expect(c.panel).toBeVisible();
    await expect(c.trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(c.panel.locator('.date-picker-day:focus')).toHaveCount(1);
    const picked = await firstDayNextMonth(c);
    await c.day(picked).click();

    await expect(c.undo).toBeFocused();
    await expect(c.status).toContainText(`Scheduled for ${scheduledLabel(picked)}`);
    await waitForRefresh(page);
    await settle(page);
    expect(posts).toEqual([{ plannedDate: picked, plannedTime: null, expectedPlannedDate: null, expectedPlannedTime: null }]);
    expect(readSchedule(ids[0])).toEqual({ planned_date: picked, planned_time: null });

    await c.undo.click();
    await expect(c.row.locator('[data-dashboard-schedule-pick]').first()).toBeFocused();
    expect(readSchedule(ids[0])).toEqual(UNDATED);
    expect(posts.map(({ plannedDate }) => plannedDate)).toEqual([picked, null]);
  });
});

test('opening the calendar over a typed draft does not write it, and the picked day wins', async ({ page }) => {
  await withDashboardApp(async ({ origin, ids, readSchedule }) => {
    const posts = await openDashboard(page, origin);
    const c = controls(page, ids[0]);

    await c.input.focus();
    await page.keyboard.type('02152027');
    await expect(c.input).toHaveValue('2027-02-15');
    await c.trigger.click();
    await expect(c.panel).toBeVisible();
    await settle(page);
    expect(posts).toEqual([]);
    // The calendar opens on the draft.
    await expect(c.panel.locator('.date-picker-month-title')).toHaveText('February 2027');
    await expect(c.day('2027-02-15')).toHaveClass(/is-selected/);

    await c.day('2027-02-20').click();
    await expect(c.undo).toBeFocused();
    await expect(c.status).toContainText(`Scheduled for ${scheduledLabel('2027-02-20')}`);
    await waitForRefresh(page);
    await settle(page);
    expect(posts.map(({ plannedDate }) => plannedDate)).toEqual(['2027-02-20']);
    expect(readSchedule(ids[0])).toEqual({ planned_date: '2027-02-20', planned_time: null });

    await c.undo.click();
    await expect(c.row.locator('[data-dashboard-schedule-pick]').first()).toBeFocused();
    expect(readSchedule(ids[0])).toEqual(UNDATED);

    // Dismissing an opened calendar keeps the draft unsent, and a press that
    // opened it does not suppress a later ordinary blur.
    await c.input.focus();
    await page.keyboard.type('03012027');
    await c.trigger.click();
    await expect(c.panel).toBeVisible();
    await page.locator('#needs-date h2').click();
    await expect(c.panel).toBeHidden();
    await settle(page);
    expect(posts).toHaveLength(2);
    await c.input.focus();
    await page.locator('#needs-date h2').click();
    await expect(c.undo).toBeFocused();
    expect(posts.map(({ plannedDate }) => plannedDate)).toEqual(['2027-02-20', null, '2027-03-01']);
  });
});

test('keyboard users reach and use the calendar without writing a typed draft early', async ({ page }) => {
  await withDashboardApp(async ({ origin, ids, readSchedule }) => {
    const posts = await openDashboard(page, origin);
    const c = controls(page, ids[0]);

    // Incomplete dates never submit.
    await c.input.focus();
    await page.keyboard.type('0215');
    await page.locator('#needs-date h2').click();
    await settle(page);
    expect(posts).toEqual([]);

    await c.input.fill('');
    await c.input.focus();
    await page.keyboard.type('02152027');
    await page.keyboard.press('Tab');
    await expect(c.trigger).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(c.panel).toBeVisible();
    await expect(c.day('2027-02-15')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(c.panel).toBeHidden();
    await expect(c.trigger).toBeFocused();
    await settle(page);
    expect(posts).toEqual([]);

    // Leaving the date field commits the typed draft, as an ordinary blur does.
    await page.keyboard.press('Tab');
    await expect(c.undo).toBeFocused();
    expect(posts.map(({ plannedDate }) => plannedDate)).toEqual(['2027-02-15']);
    expect(readSchedule(ids[0])).toEqual({ planned_date: '2027-02-15', planned_time: null });
    await page.keyboard.press('Enter');
    await expect(c.row.locator('[data-dashboard-schedule-pick]').first()).toBeFocused();

    // Choosing a day by keyboard schedules it.
    await c.trigger.focus();
    await page.keyboard.press('Space');
    await expect(c.panel).toBeVisible();
    const focusedDay = await c.panel.locator('.date-picker-day:focus').getAttribute('data-date');
    await page.keyboard.press('Enter');
    await expect(c.undo).toBeFocused();
    expect(posts.map(({ plannedDate }) => plannedDate)).toEqual(['2027-02-15', null, focusedDay]);
  });
});

test('refreshed rows get working calendars without duplicate listeners, and keep drafts and errors per release', async ({ page }) => {
  await page.addInitScript(() => {
    window.testDocumentListeners = { click: 0, keydown: 0 };
    const add = Document.prototype.addEventListener;
    Document.prototype.addEventListener = function (type, ...rest) {
      if (type in window.testDocumentListeners) window.testDocumentListeners[type] += 1;
      return add.call(this, type, ...rest);
    };
  });
  await withDashboardApp(async ({ origin, ids, readSchedule }) => {
    const posts = await openDashboard(page, origin);
    const [first, second, third] = ids.map((id) => controls(page, id));
    const listeners = () => page.evaluate(() => ({ ...window.testDocumentListeners }));
    const initial = await listeners();

    // A validation error on the second release and an unsent draft on the third.
    await second.input.focus();
    await page.keyboard.press('Enter');
    await expect(second.error).toHaveText('Choose a date first.');
    await expect(second.input).toHaveAttribute('aria-invalid', 'true');
    await third.input.evaluate((input) => { input.value = '2027-04-04'; });

    for (let cycle = 0; cycle < 3; cycle += 1) {
      await first.trigger.click();
      const picked = await firstDayNextMonth(first);
      await first.day(picked).click();
      await expect(first.undo).toBeFocused();
      await waitForRefresh(page);
      await first.undo.click();
      await expect(first.row.locator('[data-dashboard-schedule-pick]').first()).toBeFocused();
      await waitForRefresh(page);
    }
    await settle(page);
    expect(posts).toHaveLength(6);
    expect(await listeners()).toEqual(initial);

    await expect(second.error).toHaveText('Choose a date first.');
    await expect(second.input).toHaveAttribute('aria-invalid', 'true');
    await expect(third.input).toHaveValue('2027-04-04');
    await expect(third.error).toBeHidden();
    await expect(third.input).not.toHaveAttribute('aria-invalid', 'true');
    expect(readSchedule(ids[2])).toEqual(UNDATED);

    // A fresh row's calendar dismisses by outside click and Escape.
    await third.trigger.click();
    await expect(third.panel).toBeVisible();
    await expect(third.day('2027-04-04')).toHaveClass(/is-selected/);
    await page.locator('#needs-date h2').click();
    await expect(third.panel).toBeHidden();
    await third.trigger.click();
    await expect(third.panel).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(third.panel).toBeHidden();
    await expect(third.trigger).toBeFocused();
    // Opening one calendar closes another. (An open calendar covers the rows
    // below it, so the lower row's calendar is opened first.)
    await third.trigger.click();
    await expect(third.panel).toBeVisible();
    await second.trigger.click();
    await expect(third.panel).toBeHidden();
    await expect(second.panel).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(second.panel).toBeHidden();
    await third.trigger.click();
    await expect(third.panel).toBeVisible();
    await third.day('2027-04-10').click();
    await expect(third.undo).toBeFocused();
    await waitForRefresh(page);
    await settle(page);
    expect(posts).toHaveLength(7);
    expect(posts[6]).toEqual({ plannedDate: '2027-04-10', plannedTime: null, expectedPlannedDate: null, expectedPlannedTime: null });
    expect(readSchedule(ids[2])).toEqual({ planned_date: '2027-04-10', planned_time: null });
    // The validation error stays with its own release across that refresh.
    await expect(second.error).toHaveText('Choose a date first.');
  });
});

for (const width of [1440, 1280, 1024, 768, 375, 320]) {
  test(`the Dashboard calendar stays inside the viewport at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width < 768 ? 740 : 900 });
    await withDashboardApp(async ({ origin, ids }) => {
      await openDashboard(page, origin);
      const c = controls(page, ids[0]);
      await c.trigger.scrollIntoViewIfNeeded();
      await c.trigger.click();
      await expect(c.panel).toBeVisible();
      await c.panel.scrollIntoViewIfNeeded();
      const geometry = await c.panel.evaluate((panel) => {
        const box = panel.getBoundingClientRect();
        const centre = document.elementFromPoint(box.left + box.width / 2, box.top + Math.min(box.height / 2, 40));
        return {
          left: box.left,
          right: box.right,
          width: box.width,
          viewport: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
          unobscured: panel.contains(centre),
        };
      });
      expect(geometry.left).toBeGreaterThanOrEqual(0);
      expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
      expect(geometry.width).toBeGreaterThan(200);
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.viewport);
      expect(geometry.unobscured).toBe(true);
      // The last visible day is reachable and choosable.
      await expect(c.panel.locator('.date-picker-day:not([disabled])').last()).toBeInViewport();
    });
  });
}

test('release edit and publish pickers keep the shared calendar behaviour', async ({ page }) => {
  await withDashboardApp(async ({ origin, ids }) => {
    const posts = await openDashboard(page, origin);

    await page.goto(`${origin}/releases/${ids[0]}/edit`);
    const planned = page.locator('[data-date-picker-field]').filter({ has: page.locator('#plannedDate') });
    const published = page.locator('[data-date-picker-field]').filter({ has: page.locator('#publishedDate') });
    await planned.locator('.date-picker-trigger').click();
    await expect(planned.locator('[data-date-picker-panel]')).toBeVisible();
    const day = await planned.locator('.date-picker-day:not([disabled])').nth(9).getAttribute('data-date');
    await planned.locator(`.date-picker-day[data-date="${day}"]`).click();
    await expect(page.locator('#plannedDate')).toHaveValue(day);
    await expect(planned.locator('[data-date-picker-panel]')).toBeHidden();
    await expect(planned.locator('.date-picker-trigger')).toBeFocused();

    await planned.locator('.date-picker-trigger').click();
    await published.locator('.date-picker-trigger').click();
    await expect(planned.locator('[data-date-picker-panel]')).toBeHidden();
    await expect(published.locator('[data-date-picker-panel]')).toBeVisible();
    // The edit route opens the Edit Release dialog; click outside the calendar inside it.
    await page.locator('#release-edit-dialog-title').click();
    await expect(published.locator('[data-date-picker-panel]')).toBeHidden();
    await expect(page.locator('#release-edit-dialog')).toBeVisible();

    await page.goto(`${origin}/releases/${ids[0]}`);
    await page.locator('[data-dialog-open="release-publish-dialog"]').click();
    const dialog = page.locator('#release-publish-dialog');
    await expect(dialog).toBeVisible();
    const field = dialog.locator('[data-date-picker-field]');
    await field.locator('.date-picker-trigger').click();
    await expect(field.locator('[data-date-picker-panel]')).toBeVisible();
    // Escape inside the calendar closes only the calendar.
    await page.keyboard.press('Escape');
    await expect(field.locator('[data-date-picker-panel]')).toBeHidden();
    await expect(dialog).toBeVisible();
    await field.locator('.date-picker-trigger').click();
    const publishDay = await field.locator('.date-picker-day:not([disabled])').first().getAttribute('data-date');
    await field.locator(`.date-picker-day[data-date="${publishDay}"]`).click();
    await expect(dialog.locator('#release-publish-date')).toHaveValue(publishDay);
    await expect(dialog).toBeVisible();
    expect(posts).toEqual([]);
  });
});
