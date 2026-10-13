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

function insertRelease(db, projectId, title, plannedDate = null) {
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO releases (project_id, title, description, notes, planned_date, planned_time, patreon_url, published_date, archived_at)
    VALUES (?, ?, '', '', ?, NULL, NULL, NULL, NULL)
  `).run(projectId, title, plannedDate);
  return Number(lastInsertRowid);
}

async function withDashboardApp(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-dashboard-title-info-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot); fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  try {
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { appDataRoot, authState: { csrfPepper } });
    const project = app.locals.projectService.create({ title: 'Hover Project' });
    const ids = {
      projectId: project.id,
      undatedId: insertRelease(db, project.id, 'Undated Release'),
      scheduledId: insertRelease(db, project.id, 'Scheduled Release', localDate(2)),
      todayId: insertRelease(db, project.id, 'Today Release', localDate(0)),
    };
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    await run({ origin: `http://127.0.0.1:${server.address().port}`, ...ids });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// Hovering the sidebar expands it over the content, so "away" is the top-right corner.
async function moveAway(page) {
  const { width } = page.viewportSize();
  await page.mouse.move(width - 4, 4, { steps: 5 });
}

async function gotoEnhanced(page, url, boundSelector) {
  await page.goto(url);
  await page.locator(boundSelector).first().waitFor({ state: 'attached' });
}

const DASHBOARD_BOUND = '[data-dashboard-title-info-bound="true"]';

function center(box) {
  return { x: box.x + (box.width / 2), y: box.y + (box.height / 2) };
}

function titleParts(page, cardId) {
  const card = page.locator(`#${cardId}`);
  const wrapper = page.locator('[data-dashboard-title-info]').filter({ has: card });
  return { card, title: wrapper.locator(':scope > a[href]') };
}

// Real mouse input: Playwright's mouse drives the browser's input pipeline, so
// hit testing and pointer boundary events come from the browser itself.
async function hover(page, locator) {
  await locator.scrollIntoViewIfNeeded();
  const point = center(await locator.boundingBox());
  await page.mouse.move(point.x, point.y, { steps: 4 });
  return point;
}

async function moveIntoCardAndClick(page, { card, title }, actionName, expectedPath) {
  await moveAway(page);
  await expect(card).toBeHidden();
  await hover(page, title);
  await expect(card).toBeVisible();
  const openedBox = await card.boundingBox();

  // A small move within the title must not drag the card along.
  const titleBox = await title.boundingBox();
  await page.mouse.move(titleBox.x + 2, titleBox.y + (titleBox.height / 2), { steps: 3 });
  expect(await card.boundingBox()).toEqual(openedBox);

  const action = card.getByRole('link', { name: actionName });
  const target = center(await action.boundingBox());
  await page.mouse.move(target.x, target.y, { steps: 25 });
  await expect(card).toBeVisible();
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(() => { const url = new URL(page.url()); return url.pathname + url.search; }).toBe(expectedPath);
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 375, height: 740 }]) {
  test(`dashboard title cards accept a real mouse moving into their actions at ${viewport.width}px`, async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.setViewportSize(viewport);

    await withDashboardApp(async ({ origin, projectId, undatedId, scheduledId }) => {
      const cases = [
        [`dashboard-release-info-needs-date-${undatedId}`, 'Edit release', `/releases/${undatedId}?edit=1`],
        [`dashboard-release-info-needs-date-${undatedId}`, 'Open release', `/releases/${undatedId}`],
        [`dashboard-release-info-scheduled-${scheduledId}`, 'Open release', `/releases/${scheduledId}`],
        [`dashboard-project-info-table-${projectId}`, 'Edit project', `/projects/${projectId}?edit=1`],
        [`dashboard-project-info-table-${projectId}`, 'Open project', `/projects/${projectId}`],
      ];
      for (const [cardId, actionName, expectedPath] of cases) {
        await gotoEnhanced(page, `${origin}/`, DASHBOARD_BOUND);
        const parts = titleParts(page, cardId);
        await moveIntoCardAndClick(page, parts, actionName, expectedPath);
      }
    });
    expect(pageErrors).toEqual([]);
  });
}

test('dashboard title cards dismiss on leave, switch between titles, and keep title navigation', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await withDashboardApp(async ({ origin, projectId, undatedId, scheduledId }) => {
    await gotoEnhanced(page, `${origin}/`, DASHBOARD_BOUND);
    const undated = titleParts(page, `dashboard-release-info-needs-date-${undatedId}`);
    const scheduled = titleParts(page, `dashboard-release-info-scheduled-${scheduledId}`);
    const projectRow = titleParts(page, `dashboard-project-info-table-${projectId}`);

    // Leaving both the title and the card dismisses it.
    await hover(page, undated.title);
    await expect(undated.card).toBeVisible();
    const cardBox = await undated.card.boundingBox();
    await page.mouse.move(cardBox.x + 20, cardBox.y + 20, { steps: 10 });
    await moveAway(page);
    await expect(undated.card).toBeHidden();

    // Rapid movement between titles keeps exactly one card open.
    await hover(page, undated.title);
    await hover(page, scheduled.title);
    await expect(scheduled.card).toBeVisible();
    await expect(undated.card).toBeHidden();
    await hover(page, projectRow.title);
    await expect(projectRow.card).toBeVisible();
    await expect(scheduled.card).toBeHidden();
    await expect(page.locator('[data-calendar-info-card][data-info-card-open="true"]')).toHaveCount(1);

    // Clicking the title itself still navigates to the title's destination.
    await hover(page, scheduled.title);
    await page.mouse.down();
    await page.mouse.up();
    await expect(page).toHaveURL(new RegExp(`/releases/${scheduledId}$`));
  });
});

test('dashboard title cards keep keyboard focus, Tab, and Escape behavior', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await withDashboardApp(async ({ origin, undatedId }) => {
    await gotoEnhanced(page, `${origin}/`, DASHBOARD_BOUND);
    const { card, title } = titleParts(page, `dashboard-release-info-needs-date-${undatedId}`);

    await title.focus();
    await expect(card).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(card.getByRole('link', { name: 'Open release' })).toBeFocused();
    await expect(card).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(card).toBeHidden();
    await expect(title).toBeFocused();

    // Focus already rests on the title, so reopening takes a fresh focus move.
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(title).toBeFocused();
    await expect(card).toBeVisible();
    await page.keyboard.press('Shift+Tab');
    await expect(card).toBeHidden();
  });
});

function currentPath(page) {
  const url = new URL(page.url());
  return url.pathname + url.search;
}

// Records focus and card state from a window keydown listener, which runs
// synchronously after the document-level Escape handler and before any
// rendering update could move focus on the browser's own.
async function recordStateAfterEscape(page, cardId) {
  await page.evaluate((id) => {
    window.__afterEscape = null;
    window.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      const card = document.getElementById(id);
      const active = document.activeElement;
      window.__afterEscape = {
        cardOpen: card.matches(':popover-open') || card.hasAttribute('data-info-card-open'),
        focusInCard: card.contains(active),
        activeTag: active?.tagName,
        activeHref: active?.getAttribute('href') ?? null,
      };
    }, { once: true });
  }, cardId);
}

// Tab to the card's Edit action, press Escape, then Enter at once. Enter must
// follow the focused trigger link, never the hidden Edit action.
async function escapeThenEnterFromEditAction(page, { card, cardId, trigger, editName, expectedPath }) {
  await trigger.focus();
  await expect(card).toBeVisible();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(card.getByRole('link', { name: editName })).toBeFocused();

  await recordStateAfterEscape(page, cardId);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  await expect.poll(() => currentPath(page)).toBe(expectedPath);
}

test('Escape from a dashboard card action returns focus to its trigger without reopening it', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  await withDashboardApp(async ({ origin, projectId, undatedId, todayId }) => {
    await gotoEnhanced(page, `${origin}/`, DASHBOARD_BOUND);
    const cardId = `dashboard-release-info-needs-date-${undatedId}`;
    const { card, title } = titleParts(page, cardId);

    // Immediately after Escape, focus sits on the title and the card stays closed.
    await title.focus();
    await page.keyboard.press('Tab');
    await expect(card.getByRole('link', { name: 'Open release' })).toBeFocused();
    await recordStateAfterEscape(page, cardId);
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => window.__afterEscape)).toEqual({
      cardOpen: false,
      focusInCard: false,
      activeTag: 'A',
      activeHref: `/releases/${undatedId}`,
    });
    await expect(title).toBeFocused();
    await page.waitForTimeout(300);
    await expect(card).toBeHidden();
    await expect(title).toBeFocused();

    // Intentional keyboard focus afterwards opens the card normally.
    await page.keyboard.press('Shift+Tab');
    await expect(card).toBeHidden();
    await page.keyboard.press('Tab');
    await expect(title).toBeFocused();
    await expect(card).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(card).toBeHidden();
    await expect(title).toBeFocused();

    // Rapid Escape -> Enter follows the release title, not the hidden Edit action.
    await gotoEnhanced(page, `${origin}/`, DASHBOARD_BOUND);
    const releaseParts = titleParts(page, cardId);
    await escapeThenEnterFromEditAction(page, {
      card: releaseParts.card,
      cardId,
      trigger: releaseParts.title,
      editName: 'Edit release',
      expectedPath: `/releases/${undatedId}`,
    });

    // The same holds for a project title.
    await gotoEnhanced(page, `${origin}/`, DASHBOARD_BOUND);
    const projectCardId = `dashboard-project-info-table-${projectId}`;
    const projectParts = titleParts(page, projectCardId);
    await escapeThenEnterFromEditAction(page, {
      card: projectParts.card,
      cardId: projectCardId,
      trigger: projectParts.title,
      editName: 'Edit project',
      expectedPath: `/projects/${projectId}`,
    });

    // And for the Due today tile, whose trigger is the tile link around the title.
    await gotoEnhanced(page, `${origin}/`, '[data-dashboard-tile-info-bound="true"]');
    const tileCardId = `dashboard-release-info-today-tile-${todayId}`;
    const wrapper = page.locator('[data-dashboard-tile-info]');
    const tile = wrapper.locator(':scope > a[data-dashboard-tile="today"]');
    const tileCard = wrapper.locator(`:scope > #${tileCardId}`);
    await tile.focus();
    await page.keyboard.press('Tab');
    await recordStateAfterEscape(page, tileCardId);
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => window.__afterEscape)).toEqual({
      cardOpen: false,
      focusInCard: false,
      activeTag: 'A',
      activeHref: '/releases?schedule=today',
    });
    await expect(tileCard).toBeHidden();
    await expect(tile).toBeFocused();

    await gotoEnhanced(page, `${origin}/`, '[data-dashboard-tile-info-bound="true"]');
    await escapeThenEnterFromEditAction(page, {
      card: tileCard,
      cardId: tileCardId,
      trigger: tile,
      editName: 'Edit release',
      expectedPath: '/releases?schedule=today',
    });
  });
  expect(pageErrors).toEqual([]);
});

test('Escape does not pull focus back to a dashboard title once focus has moved elsewhere', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await withDashboardApp(async ({ origin, undatedId }) => {
    await gotoEnhanced(page, `${origin}/`, DASHBOARD_BOUND);
    const undated = titleParts(page, `dashboard-release-info-needs-date-${undatedId}`);

    // A hovered card closes on Escape while focus stays where the user put it.
    await hover(page, undated.title);
    await expect(undated.card).toBeVisible();
    const elsewhere = page.locator('a[data-dashboard-tile="overdue"]');
    await elsewhere.focus();
    await page.keyboard.press('Escape');
    await expect(undated.card).toBeHidden();
    await expect(elsewhere).toBeFocused();
  });
});

test('Calendar keyboard pinning still returns focus to its trigger on Escape', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await withDashboardApp(async ({ origin }) => {
    await gotoEnhanced(page, `${origin}/calendar`, '[data-calendar-info-bound="true"]');
    const event = page.locator('[data-calendar-event]').filter({ hasText: 'Today Release' }).first();
    const trigger = event.locator('[data-calendar-info-trigger]');
    const card = event.locator('[data-calendar-info-card]');

    await trigger.focus();
    await expect(card).toBeHidden();
    await page.keyboard.press('Enter');
    await expect(card).toBeVisible();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Tab');
    await expect(card.getByRole('link', { name: 'Open release' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(card).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });
});

test('Calendar entries keep pointer-following hover and click-to-pin', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await withDashboardApp(async ({ origin }) => {
    await gotoEnhanced(page, `${origin}/calendar`, '[data-calendar-info-bound="true"]');
    const event = page.locator('[data-calendar-event]').filter({ hasText: 'Today Release' }).first();
    const trigger = event.locator('[data-calendar-info-trigger]');
    const card = event.locator('[data-calendar-info-card]');

    const box = await trigger.boundingBox();
    await page.mouse.move(box.x + 4, box.y + (box.height / 2), { steps: 3 });
    await expect(card).toBeVisible();
    const first = await card.boundingBox();
    await page.mouse.move(box.x + box.width - 4, box.y + (box.height / 2), { steps: 3 });
    await expect.poll(async () => (await card.boundingBox())?.x).not.toBe(first.x);

    // Unpinned Calendar hover still dismisses as soon as the pointer leaves.
    await moveAway(page);
    await expect(card).toBeHidden();

    const point = center(await trigger.boundingBox());
    await page.mouse.click(point.x, point.y);
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await moveAway(page);
    await expect(card).toBeVisible();
    const { width } = page.viewportSize();
    await page.mouse.click(width - 4, 4);
    await expect(card).toBeHidden();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });
});

test('Due today tile title opens its release card without changing tile navigation', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  await withDashboardApp(async ({ origin, todayId }) => {
    await gotoEnhanced(page, `${origin}/`, '[data-dashboard-tile-info-bound="true"]');
    // Repeated enhancement must not double-bind the tile or the titles.
    expect(await page.evaluate(async () => {
      const { enhanceDashboardTitleInfoCards } = await import('/client/info-cards.js');
      return enhanceDashboardTitleInfoCards(document);
    })).toBe(0);

    const wrapper = page.locator('[data-dashboard-tile-info]');
    const tile = wrapper.locator(':scope > a[data-dashboard-tile="today"]');
    const title = tile.locator('[data-dashboard-tile-info-title]');
    const card = wrapper.locator(`:scope > #dashboard-release-info-today-tile-${todayId}`);
    const parts = { card, title };

    await expect(title).toHaveText('Today Release');
    await expect(title).not.toHaveAttribute('title', /.*/);
    expect(await tile.evaluate((link) => link.querySelectorAll('a, button, [data-calendar-info-card]').length)).toBe(0);
    await expect(card.locator('.asset-viewer-grid-card-info-heading')).toHaveText('Today Release');

    // Only the release title opens the card; the rest of the tile does not.
    await moveAway(page);
    await hover(page, tile.locator('[data-dashboard-tile-count]'));
    await expect(card).toBeHidden();
    await hover(page, title);
    await expect(card).toBeVisible();
    await expect(page.locator('[data-calendar-info-card][data-info-card-open="true"]')).toHaveCount(1);
    await moveAway(page);
    await expect(card).toBeHidden();

    // Keyboard focus on the tile link opens the card and Tab reaches its actions.
    await tile.focus();
    await expect(card).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(card.getByRole('link', { name: 'Open release' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(card).toBeHidden();
    await page.evaluate(() => document.activeElement?.blur());

    await moveIntoCardAndClick(page, parts, 'Edit release', `/releases/${todayId}?edit=1`);
    await gotoEnhanced(page, `${origin}/`, '[data-dashboard-tile-info-bound="true"]');
    await moveIntoCardAndClick(page, parts, 'Open release', `/releases/${todayId}`);

    // Clicking the title inside the tile still follows the tile's listing link.
    await gotoEnhanced(page, `${origin}/`, '[data-dashboard-tile-info-bound="true"]');
    await hover(page, title);
    await page.mouse.down();
    await page.mouse.up();
    await expect.poll(() => { const url = new URL(page.url()); return url.pathname + url.search; }).toBe('/releases?schedule=today');
  });
  expect(pageErrors).toEqual([]);
});
