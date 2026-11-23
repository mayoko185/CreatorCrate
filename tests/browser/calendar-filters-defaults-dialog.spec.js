import { expect, test } from '@playwright/test';
import {
  MONTH, calendarUrl, choose, closeDialog, columnHeaders, createCalendarFixture, dialog, enhanced, expectEntries,
  expectRepeated, openDialog, query, settled, summaryText, watch,
} from './calendar-filters-defaults-fixture.js';

// WP14b 1–4, 13, 14, 25–28: the one Calendar Filters & Defaults dialog —
// entry point, structure, footer order and styling, header/Escape dismissal
// and focus, Desktop view and Week starts presentation, wide/medium/narrow
// layouts, and the Calendar release actions (read-only archived parents,
// Edit, Archive, Delete) under an active multi-selection.

const fixture = createCalendarFixture('calendar-fd-dialog');

test.beforeAll(async () => {
  await fixture.start();
});

test.afterAll(async () => {
  await fixture.stop();
});

function seed() {
  fixture.isolate();
  const comic = fixture.project('Dialog Comic', { projectType: 'comic' });
  const anim = fixture.project('Dialog Anim', { projectType: 'animation', archived: true });
  const images = fixture.project('Dialog Images', { projectType: 'images' });
  return {
    comic,
    anim,
    images,
    c1: fixture.release(comic, 'Dialog Comic One', { planned: `${MONTH}-08` }),
    c2: fixture.release(comic, 'Dialog Comic Two', { planned: `${MONTH}-16` }),
    a1: fixture.release(anim, 'Dialog Anim Parent', { planned: `${MONTH}-09` }),
    i1: fixture.release(images, 'Dialog Images One', { planned: `${MONTH}-10` }),
  };
}

async function start(page, url = calendarUrl(fixture.baseURL, { month: MONTH }), width = 1280) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(url);
  await enhanced(page);
}

test('1–3, 25: one Filters & Defaults entry; two sections; footer order and styling; header X and Escape dismissal', async ({ page }) => {
  seed();
  const control = watch(page);
  await start(page);

  // The toolbar holds exactly one dialog entry, in the Filters button's place;
  // month navigation and the view toggle are untouched.
  const actions = page.locator('.calendar-nav-actions');
  await expect(actions.locator('[data-dialog-open]')).toHaveCount(1);
  const entry = page.getByRole('link', { name: 'Filters & Defaults', exact: true });
  await expect(entry).toHaveAttribute('data-tooltip', 'Filters & Defaults');
  await expect(entry).toHaveAttribute('data-dialog-open', 'calendar-filter-dialog');
  await expect(page.locator('[data-dialog-open="calendar-defaults-dialog"], #calendar-defaults-dialog, #calendar-defaults-form')).toHaveCount(0);
  for (const label of ['Previous month', 'Today', 'Next month']) {
    await expect(page.locator('.calendar-nav-right').getByRole('link', { name: label, exact: true })).toBeVisible();
  }
  await expect(page.locator('.calendar-view-switcher')).toBeVisible();
  await expect(page.locator('.calendar-month-trigger')).toBeVisible();

  await openDialog(page);
  const box = dialog(page);
  await expect(box.locator('h2')).toHaveText('Filters & Defaults');
  await expect(box.locator('.app-dialog-subtitle')).toHaveText('Calendar');
  await expect(box.locator('.filters-defaults-section > h3')).toHaveText(['Filters', 'Miscellaneous']);
  await expect(box.getByText('Sort options')).toHaveCount(0);
  const filters = box.locator('section[aria-labelledby="calendar-filters-heading"]');
  await expect(filters.locator('fieldset > legend')).toHaveText(['Projects', 'Project Types', 'Release status']);
  await expect(filters.locator('#calendar-project-filter > summary')).toHaveAttribute('aria-label', 'Projects filter: All projects');
  await expect(filters.locator('#calendar-type-filter > summary')).toHaveAttribute('aria-label', 'Project Types filter: All types');
  await expect(filters.locator('#calendar-status-filter > summary')).toHaveAttribute('aria-label', 'Release status filter: All releases');
  const misc = box.locator('section[aria-labelledby="calendar-misc-heading"]');
  await expect(misc.locator('fieldset > legend')).toHaveText(['Desktop view', 'Week starts']);
  await expect(misc.locator('#calendar-view-filter > summary')).toHaveAttribute('aria-label', 'Desktop view filter: Calendar');
  await expect(misc.locator('#calendar-week-start-filter > summary')).toHaveAttribute('aria-label', 'Week starts filter: Monday');
  // No Sort, page size, grid style/size, search or scope control.
  await expect(box.locator('[name="sort"], [name="order"], [name="pageSize"], [name="search"], [name="scope"], [name="defaultsScope"]')).toHaveCount(0);

  const footer = box.locator('footer.filters-defaults-footer');
  const buttons = footer.locator('button');
  await expect(buttons).toHaveText(['Save new defaults', 'Reset defaults', 'Reset filters']);
  await expect(buttons.nth(0)).toHaveClass('button button-secondary');
  await expect(buttons.nth(1)).toHaveClass('button button-secondary');
  await expect(buttons.nth(2)).toHaveClass('button button-primary');
  await expect(buttons.nth(0)).toBeEnabled();
  await expect(buttons.nth(1)).toBeEnabled();
  await expect(footer.getByRole('button', { name: /^(Cancel|Apply|Done|Close)$/ })).toHaveCount(0);
  await expect(box.locator('[data-dialog-close]')).toHaveCount(1);
  await expect(box.locator('[data-calendar-defaults-indicator]')).toHaveText('No saved defaults.');
  // Footer DOM and visual order agree (left to right), and Tab follows them.
  const xs = await buttons.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().left));
  expect([...xs].sort((left, right) => left - right)).toEqual(xs);
  await buttons.nth(0).focus();
  await page.keyboard.press('Tab');
  await expect(buttons.nth(1)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(buttons.nth(2)).toBeFocused();

  // Header X closes and returns focus to the entry; Escape does the same.
  await closeDialog(page);
  await expect(entry).toBeFocused();
  await openDialog(page);
  await page.keyboard.press('Escape');
  await expect(box).toBeHidden();
  await expect(entry).toBeFocused();
  // Opening and closing never writes defaults.
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('4, 13, 14: keyboard-only dropdowns; Desktop view and Week starts update the presentation without saving', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  await start(page);
  await openDialog(page);

  // Keyboard only: open the Desktop view dropdown from its summary and pick List.
  const viewSummary = page.locator('#calendar-view-filter > summary');
  await viewSummary.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#calendar-view-filter')).toHaveJSProperty('open', true);
  const listOption = page.locator('#calendar-view-filter input[value="list"]');
  await listOption.focus();
  await page.keyboard.press('Space');
  await settled(page);
  await expect.poll(() => query(page).get('view')).toBe('list');
  await expect(page.locator('[data-calendar-live-region]')).toHaveClass(/calendar-view-list/);
  await expect(page.locator('.calendar-agenda')).toBeVisible();
  await expect(page.locator('.calendar-scroll')).toBeHidden();
  expect(query(page).get('month')).toBe(MONTH);
  await expect(page.locator('.calendar-view-switcher [aria-current="page"]')).toHaveAttribute('aria-label', 'List view');
  await expect(page.locator('.calendar-agenda .agenda-release')).toHaveCount(4);

  // Back to Calendar through the view toggle outside the dialog keeps the
  // dialog control in step (the toolbar is unchanged).
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  await page.locator('.calendar-view-switcher').getByRole('link', { name: 'Calendar view' }).click();
  await settled(page);
  await expect(page.locator('[data-calendar-live-region]')).toHaveClass(/calendar-view-grid/);
  await openDialog(page);
  expect(await summaryText(page, 'calendar-view-filter')).toBe('Calendar');

  // Week starts: Monday → Sunday reorders the columns and shifts the first
  // day of the month; the month and the entries stay.
  const firstDayColumn = () => page.locator('.calendar-table .calendar-row:not(.calendar-row-header)').first()
    .locator('.calendar-day').evaluateAll((cells) => cells.findIndex((cell) => !cell.classList.contains('out-of-month')));
  const weekday = new Date(`${MONTH}-01T00:00:00Z`).getUTCDay(); // 0 = Sunday
  expect((await columnHeaders(page))[0]).toBe('Mon');
  expect(await firstDayColumn()).toBe((weekday + 6) % 7);
  await choose(page, 'calendar-week-start-filter', 'Sunday');
  await expect.poll(() => query(page).get('weekStart')).toBe('sunday');
  expect(await columnHeaders(page)).toEqual(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
  expect(await firstDayColumn()).toBe(weekday);
  // Weekend shading follows the start day: the first and last columns.
  const weekendColumns = await page.locator('.calendar-table .calendar-row:not(.calendar-row-header)').nth(1)
    .locator('.calendar-day').evaluateAll((cells) => cells.map((cell, index) => (cell.classList.contains('weekend') ? index : -1)).filter((index) => index >= 0));
  expect(weekendColumns).toEqual([0, 6]);
  expect(query(page).get('month')).toBe(MONTH);
  await expectEntries(page, [s.c1, s.c2, s.a1, s.i1]);
  // Day grouping: the 8th holds exactly c1.
  const eighth = page.locator('.calendar-table .calendar-day:not(.out-of-month)')
    .filter({ has: page.locator('.day-header', { hasText: /^08$/ }) });
  await expect(eighth.locator('[data-calendar-info-trigger]')).toHaveAttribute('aria-controls', `calendar-info-grid-${s.c1.id}`);

  // Monday again.
  await choose(page, 'calendar-week-start-filter', 'Monday');
  expect((await columnHeaders(page))[0]).toBe('Mon');
  expect(await firstDayColumn()).toBe((weekday + 6) % 7);
  expect(control.defaultsPosts()).toEqual([]);
  expect(fixture.calendarKeys()).toEqual([]);
  expect(control.errors).toEqual([]);
});

for (const [name, width] of [['wide', 1440], ['medium', 900], ['narrow', 390]]) {
  test(`26: ${name} layout keeps the dialog inside the viewport with no horizontal overflow`, async ({ page }) => {
    seed();
    await start(page, calendarUrl(fixture.baseURL, { month: MONTH }), width);
    await openDialog(page);
    const box = dialog(page);
    const card = box.locator('.app-dialog-card');
    const rect = await card.boundingBox();
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.width).toBeLessThanOrEqual(width + 1);
    expect(await card.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    await expect(box.locator('.filters-defaults-section')).toHaveCount(2);
    for (const button of await box.locator('footer button').all()) {
      await button.scrollIntoViewIfNeeded();
      await expect(button).toBeVisible();
    }
    // An open Projects dropdown stays inside the dialog card horizontally.
    const projects = box.locator('#calendar-project-filter');
    await projects.locator('summary').click();
    const panel = projects.locator('.asset-filter-multiselect-panel');
    await expect(panel).toBeVisible();
    const panelRect = await panel.boundingBox();
    expect(panelRect.x).toBeGreaterThanOrEqual(rect.x - 1);
    expect(panelRect.x + panelRect.width).toBeLessThanOrEqual(rect.x + rect.width + 1);
    if (name === 'narrow') {
      // Narrow: the two section grids stack into one column.
      const columns = await box.locator('.filters-defaults-grid').first()
        .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length);
      expect(columns).toBe(1);
    }
  });
}

test('27, 28: archived-parent entries stay read-only; Edit, Archive and Delete keep the multi-selection and month', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  const url = calendarUrl(fixture.baseURL, { month: MONTH, project: [s.comic.id, s.anim.id], type: ['comic', 'animation'] });
  await start(page, url);
  await expectEntries(page, [s.c1, s.c2, s.a1]);

  // The archived parent's release opens read-only (no Edit action).
  const anim = page.locator(`[data-calendar-info-trigger][aria-controls="calendar-info-grid-${s.a1.id}"]`);
  await anim.click();
  const animCard = page.locator(`#calendar-info-grid-${s.a1.id}`);
  await expect(animCard).toBeVisible();
  await expect(animCard.getByText('Edit release')).toHaveCount(0);
  await expect(animCard.getByRole('link', { name: 'Open release' })).toHaveAttribute('href', `/releases/${s.a1.id}`);
  await page.keyboard.press('Escape');

  const editDialog = page.locator('#release-edit-dialog');
  async function edit(release) {
    await page.locator(`[data-calendar-info-trigger][aria-controls="calendar-info-grid-${release.id}"]`).click();
    await page.locator(`#calendar-info-grid-${release.id} [data-release-edit-id="${release.id}"]`).click();
    await expect(editDialog).toBeVisible();
    await expect(editDialog.locator('button[data-dialog-submit]')).toBeEnabled();
  }
  function expectContext() {
    expect(query(page).get('month')).toBe(MONTH);
    expectRepeated(page.url(), 'project', [s.comic.id, s.anim.id]);
    expectRepeated(page.url(), 'type', ['comic', 'animation']);
  }

  // Edit: the refresh keeps the month and the repeated selections.
  await edit(s.c1);
  await editDialog.locator('input[name="title"]').fill('Dialog Comic One edited');
  await editDialog.locator('button[data-dialog-submit]').click();
  await expect(editDialog).toBeHidden();
  await settled(page);
  await expect(page.locator(`#calendar-info-grid-${s.c1.id}`)).toContainText('Dialog Comic One edited');
  expectContext();
  await expectEntries(page, [s.c1, s.c2, s.a1]);

  // Archive: the release leaves; the selection stays.
  await edit(s.c2);
  const archive = editDialog.locator('[data-release-edit-action="archive"]');
  if (!(await archive.evaluate((node) => node.open))) await archive.locator('summary').click();
  await archive.locator('button[data-confirm]').click();
  await page.locator('#app-confirmation-dialog [data-app-dialog-confirmation-confirm]').click();
  await expect(editDialog).toBeHidden();
  await settled(page);
  await expectEntries(page, [s.c1, s.a1]);
  expect(s.c2.archived()).toBe(true);
  expectContext();

  // Delete: the release leaves; the selection stays.
  await edit(s.c1);
  const remove = editDialog.locator('[data-release-edit-action="delete"]');
  if (!(await remove.evaluate((node) => node.open))) await remove.locator('summary').click();
  await remove.locator('button[data-confirm]').click();
  await page.locator('#app-confirmation-dialog [data-app-dialog-confirmation-confirm]').click();
  await expect(editDialog).toBeHidden();
  await settled(page);
  await expectEntries(page, [s.a1]);
  expect(s.c1.exists()).toBe(false);
  expectContext();

  // The dialog still shows the active selection, and nothing wrote defaults.
  await openDialog(page);
  expect(await summaryText(page, 'calendar-project-filter')).toBe('2 projects selected');
  expect(await summaryText(page, 'calendar-type-filter')).toBe('2 types selected');
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});
