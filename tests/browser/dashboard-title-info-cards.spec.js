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
  return { card, title: wrapper.locator(':scope > [data-calendar-info-trigger]') };
}

function currentPath(page) {
  const url = new URL(page.url());
  return url.pathname + url.search;
}

const openCards = (page) => page.locator('[data-calendar-info-card][data-info-card-open="true"]');

// Real mouse input: Playwright's mouse drives the browser's input pipeline, so
// hit testing and pointer boundary events come from the browser itself.
async function hover(page, locator) {
  await locator.scrollIntoViewIfNeeded();
  const point = center(await locator.boundingBox());
  await page.mouse.move(point.x, point.y, { steps: 4 });
  return point;
}

function withinViewport(page, box) {
  const { width, height } = page.viewportSize();
  return box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height;
}

// Hover follows the pointer, a click pins the card where it is, the pinned
// card ignores the pointer leaving, and its action navigates.
async function pinAndOpenAction(page, { card, title }, actionName, expectedPath) {
  await moveAway(page);
  await expect(card).toBeHidden();
  await title.scrollIntoViewIfNeeded();
  const titleBox = await title.boundingBox();
  await page.mouse.move(titleBox.x + 4, titleBox.y + 3, { steps: 4 });
  await expect(card).toBeVisible();
  await expect(title).toHaveAttribute('aria-expanded', 'true');
  const hoverBox = await card.boundingBox();
  await page.mouse.move(titleBox.x + titleBox.width - 4, titleBox.y + titleBox.height - 3, { steps: 6 });
  await expect.poll(async () => {
    const box = await card.boundingBox();
    return box.x !== hoverBox.x || box.y !== hoverBox.y;
  }).toBe(true);

  await page.mouse.down();
  await page.mouse.up();
  await expect(card).toBeVisible();
  const pinnedBox = await card.boundingBox();
  expect(withinViewport(page, pinnedBox)).toBe(true);
  await moveAway(page);
  await expect(card).toBeVisible();
  expect(await card.boundingBox()).toEqual(pinnedBox);
  expect(currentPath(page)).toBe('/');

  const action = card.getByRole('link', { name: actionName });
  const target = center(await action.boundingBox());
  await page.mouse.move(target.x, target.y, { steps: 25 });
  await expect(card).toBeVisible();
  expect(await card.boundingBox()).toEqual(pinnedBox);
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(() => currentPath(page)).toBe(expectedPath);
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 375, height: 740 }]) {
  test(`dashboard title cards follow the mouse, pin on click, and navigate through card actions at ${viewport.width}px`, async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.setViewportSize(viewport);

    await withDashboardApp(async ({ origin, projectId, undatedId, scheduledId }) => {
      const cases = [
        [`dashboard-release-info-needs-date-${undatedId}`, 'Edit release', `/releases/${undatedId}?edit=1`],
        [`dashboard-release-info-needs-date-${undatedId}`, 'Open release', `/releases/${undatedId}`],
        [`dashboard-project-info-needs-date-${undatedId}`, 'Open project', `/projects/${projectId}`],
        [`dashboard-release-info-scheduled-${scheduledId}`, 'Open release', `/releases/${scheduledId}`],
        [`dashboard-project-info-table-${projectId}`, 'Edit project', `/projects/${projectId}?edit=1`],
        [`dashboard-project-info-table-${projectId}`, 'Open project', `/projects/${projectId}`],
      ];
      for (const [cardId, actionName, expectedPath] of cases) {
        await gotoEnhanced(page, `${origin}/`, DASHBOARD_BOUND);
        await pinAndOpenAction(page, titleParts(page, cardId), actionName, expectedPath);
      }
    });
    expect(pageErrors).toEqual([]);
  });
}

test('a Next 7 days row opens through its pinned title card without a separate Open button', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await withDashboardApp(async ({ origin, scheduledId }) => {
    await gotoEnhanced(page, `${origin}/`, DASHBOARD_BOUND);
    const row = page.locator(`.dashboard-release-row--next7[data-release-id="${scheduledId}"]`);
    await expect(row).toHaveCount(1);
    await expect(row.locator('.dashboard-release-row-action')).toHaveCount(0);

    const parts = titleParts(page, `dashboard-release-info-scheduled-${scheduledId}`);
    await expect(parts.title).toHaveText('Scheduled Release');
    await parts.title.click();
    await expect(parts.card).toBeVisible();
    expect(currentPath(page)).toBe('/');
    await parts.card.getByRole('link', { name: 'Open release' }).click();
    await expect.poll(() => currentPath(page)).toBe(`/releases/${scheduledId}`);
  });
});

test('dashboard title pins dismiss on outside click, ignore other hovers, and switch on another click', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await withDashboardApp(async ({ origin, projectId, undatedId, scheduledId }) => {
    await gotoEnhanced(page, `${origin}/`, DASHBOARD_BOUND);
    const undated = titleParts(page, `dashboard-release-info-needs-date-${undatedId}`);
    const scheduled = titleParts(page, `dashboard-release-info-scheduled-${scheduledId}`);
    const projectRow = titleParts(page, `dashboard-project-info-table-${projectId}`);

    // Transient hover closes as soon as the pointer leaves the title.
    await hover(page, undated.title);
    await expect(undated.card).toBeVisible();
    await moveAway(page);
    await expect(undated.card).toBeHidden();

    // Moving between titles keeps exactly one transient card.
    await hover(page, undated.title);
    await hover(page, scheduled.title);
    await expect(scheduled.card).toBeVisible();
    await expect(undated.card).toBeHidden();
    await expect(openCards(page)).toHaveCount(1);

    // While a card is pinned, hovering another title leaves the pin alone.
    await undated.title.click();
    await expect(undated.title).toHaveAttribute('aria-expanded', 'true');
    await hover(page, scheduled.title);
    await expect(undated.card).toBeVisible();
    await expect(scheduled.card).toBeHidden();
    await expect(openCards(page)).toHaveCount(1);

    // Clicking another title moves the pin there.
    await projectRow.title.click();
    await expect(projectRow.card).toBeVisible();
    await expect(undated.card).toBeHidden();
    await expect(undated.title).toHaveAttribute('aria-expanded', 'false');
    await expect(projectRow.title).toHaveAttribute('aria-expanded', 'true');
    await expect(openCards(page)).toHaveCount(1);

    // Clicking the pinned title again unpins it.
    await projectRow.title.click();
    await expect(projectRow.card).toBeHidden();
    await expect(projectRow.title).toHaveAttribute('aria-expanded', 'false');

    // An outside click dismisses a pinned card without navigating.
    await scheduled.title.click();
    await expect(scheduled.card).toBeVisible();
    await page.locator('h1').first().click();
    await expect(scheduled.card).toBeHidden();
    await expect(openCards(page)).toHaveCount(0);
    expect(currentPath(page)).toBe('/');
  });
});

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
        activeControls: active?.getAttribute('aria-controls') ?? null,
      };
    }, { once: true });
  }, cardId);
}

test('dashboard title cards pin from Enter and Space and return focus safely on Escape', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  await withDashboardApp(async ({ origin, projectId, undatedId }) => {
    await gotoEnhanced(page, `${origin}/`, DASHBOARD_BOUND);
    const cardId = `dashboard-release-info-needs-date-${undatedId}`;
    const { card, title } = titleParts(page, cardId);
    await expect(title).toHaveAttribute('type', 'button');
    await expect(title).toHaveAttribute('aria-controls', cardId);
    await expect(title).toHaveAccessibleName('Undated Release');

    // As on the Calendar, focus alone leaves the card closed; activation pins it.
    await title.focus();
    await expect(card).toBeHidden();
    await page.keyboard.press('Enter');
    await expect(card).toBeVisible();
    await expect(title).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Tab');
    await expect(card.getByRole('link', { name: 'Open release' })).toBeFocused();

    // Escape from a card action closes it and puts focus back on the title
    // before any further key could reach the hidden action.
    await recordStateAfterEscape(page, cardId);
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => window.__afterEscape)).toEqual({
      cardOpen: false,
      focusInCard: false,
      activeControls: cardId,
    });
    await expect(title).toBeFocused();
    await expect(title).toHaveAttribute('aria-expanded', 'false');

    // Enter straight after Escape pins the card again instead of following
    // the hidden Edit action.
    await page.keyboard.press('Enter');
    await expect(card).toBeVisible();
    expect(currentPath(page)).toBe('/');
    await page.keyboard.press('Enter');
    await expect(card).toBeHidden();

    // Space pins a project title the same way.
    const project = titleParts(page, `dashboard-project-info-table-${projectId}`);
    await project.title.focus();
    await page.keyboard.press('Space');
    await expect(project.card).toBeVisible();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(project.card.getByRole('link', { name: 'Edit project' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(project.card).toBeHidden();
    await expect(project.title).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(project.card).toBeVisible();
    expect(currentPath(page)).toBe('/');
  });
  expect(pageErrors).toEqual([]);
});

test('Escape from inside a hovered, unpinned card returns focus to its title', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  await withDashboardApp(async ({ origin, projectId, undatedId }) => {
    const cases = [
      [`dashboard-release-info-needs-date-${undatedId}`, 'Open release'],
      [`dashboard-project-info-table-${projectId}`, 'Open project'],
    ];
    for (const [cardId, actionName] of cases) {
      await gotoEnhanced(page, `${origin}/`, DASHBOARD_BOUND);
      const { card, title } = titleParts(page, cardId);

      // Hover opens the card transiently; focusing the title does not pin it.
      await moveAway(page);
      await hover(page, title);
      await expect(card).toBeVisible();
      await title.focus();
      await page.keyboard.press('Tab');
      await expect(card.getByRole('link', { name: actionName })).toBeFocused();

      await recordStateAfterEscape(page, cardId);
      await page.keyboard.press('Escape');
      expect(await page.evaluate(() => window.__afterEscape)).toEqual({
        cardOpen: false,
        focusInCard: false,
        activeControls: cardId,
      });
      await expect(title).toBeFocused();
      await expect(title).toHaveAttribute('aria-expanded', 'false');

      // Enter now reaches the title and pins its card instead of following
      // the hidden action.
      await page.keyboard.press('Enter');
      await expect(card).toBeVisible();
      await expect(title).toHaveAttribute('aria-expanded', 'true');
      await expect(openCards(page)).toHaveCount(1);
      expect(currentPath(page)).toBe('/');

      // Keyboard navigation keeps working from the re-pinned card.
      await page.keyboard.press('Tab');
      await expect(card.getByRole('link', { name: actionName })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(card).toBeHidden();
      await expect(title).toBeFocused();
      expect(currentPath(page)).toBe('/');
    }
  });
  expect(pageErrors).toEqual([]);
});

test('Escape on a hovered card leaves focus where the user put it', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await withDashboardApp(async ({ origin, undatedId }) => {
    await gotoEnhanced(page, `${origin}/`, DASHBOARD_BOUND);
    const undated = titleParts(page, `dashboard-release-info-needs-date-${undatedId}`);

    await hover(page, undated.title);
    await expect(undated.card).toBeVisible();
    const elsewhere = page.locator('a[data-dashboard-tile="overdue"]');
    await elsewhere.focus();
    await page.keyboard.press('Escape');
    await expect(undated.card).toBeHidden();
    await expect(elsewhere).toBeFocused();
  });
});

test('touch taps pin dashboard title cards and reach their actions', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 375, height: 740 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  try {
    await withDashboardApp(async ({ origin, scheduledId, projectId }) => {
      await gotoEnhanced(page, `${origin}/`, DASHBOARD_BOUND);
      const scheduled = titleParts(page, `dashboard-release-info-scheduled-${scheduledId}`);
      const projectRow = titleParts(page, `dashboard-project-info-table-${projectId}`);

      await scheduled.title.tap();
      await expect(scheduled.card).toBeVisible();
      await expect(scheduled.title).toHaveAttribute('aria-expanded', 'true');
      await page.locator('.dashboard-today').tap();
      await expect(scheduled.card).toBeHidden();

      await projectRow.title.tap();
      await expect(projectRow.card).toBeVisible();
      expect(withinViewport(page, await projectRow.card.boundingBox())).toBe(true);
      await projectRow.card.getByRole('link', { name: 'Open project' }).tap();
      await expect.poll(() => currentPath(page)).toBe(`/projects/${projectId}`);
    });
  } finally {
    await context.close();
  }
  expect(pageErrors).toEqual([]);
});

for (const viewport of [{ width: 1280, height: 600 }, { width: 375, height: 640 }]) {
  test(`Projects table cards escape the table and stay inside a ${viewport.width}px viewport`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await withDashboardApp(async ({ origin, projectId }) => {
      await gotoEnhanced(page, `${origin}/`, DASHBOARD_BOUND);
      const { card, title } = titleParts(page, `dashboard-project-info-table-${projectId}`);

      // Put the title against the bottom edge so the card has to flip and clamp.
      await moveAway(page);
      await title.evaluate((node) => node.scrollIntoView({ block: 'end' }));
      const titleBox = await title.boundingBox();
      expect(titleBox.y + titleBox.height).toBeGreaterThan(viewport.height - 60);
      await page.mouse.move(titleBox.x + titleBox.width - 2, titleBox.y + (titleBox.height / 2), { steps: 4 });
      await expect(card).toBeVisible();
      await expect.poll(async () => withinViewport(page, await card.boundingBox())).toBe(true);

      await page.mouse.down();
      await page.mouse.up();
      await moveAway(page);
      await expect(card).toBeVisible();
      expect(withinViewport(page, await card.boundingBox())).toBe(true);
      // Nothing in the table clips or covers the card: its own action is the
      // topmost element where it is drawn.
      const action = card.getByRole('link', { name: 'Open project' });
      const point = center(await action.boundingBox());
      expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.textContent.trim(), point)).toBe('Open project');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    });
  });
}

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

test('Due today tile is a plain listing link while Today rows keep their release cards', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  await withDashboardApp(async ({ origin, todayId }) => {
    await gotoEnhanced(page, `${origin}/`, DASHBOARD_BOUND);
    // Repeated enhancement must not double-bind the titles.
    expect(await page.evaluate(async () => {
      const { enhanceDashboardTitleInfoCards } = await import('/client/info-cards.js');
      return enhanceDashboardTitleInfoCards(document);
    })).toBe(0);

    const attention = page.locator('.dashboard-attention');
    const tile = attention.locator('a[data-dashboard-tile="today"]');
    const openCards = page.locator('[data-calendar-info-card][data-info-card-open="true"]');
    await expect(tile).toHaveText(/^\s*1\s+Due today\s*$/);
    await expect(attention.locator('.dashboard-tile-context, [data-dashboard-tile-info], [data-calendar-info-card]'))
      .toHaveCount(0);

    // Neither hover nor focus on the tile opens a release card.
    await moveAway(page);
    await hover(page, tile);
    await expect(openCards).toHaveCount(0);
    await tile.focus();
    await expect(openCards).toHaveCount(0);
    await page.evaluate(() => document.activeElement?.blur());

    // The Today schedule row still carries the release title card.
    const todayRow = titleParts(page, `dashboard-release-info-scheduled-${todayId}`);
    await expect(todayRow.title).toHaveText('Today Release');
    await expect(todayRow.card.locator('.asset-viewer-grid-card-info-heading')).toHaveText('Today Release');
    await pinAndOpenAction(page, todayRow, 'Open release', `/releases/${todayId}`);

    await gotoEnhanced(page, `${origin}/`, DASHBOARD_BOUND);
    await tile.click();
    await expect.poll(() => currentPath(page)).toBe('/releases?schedule=today');
  });
  expect(pageErrors).toEqual([]);
});
