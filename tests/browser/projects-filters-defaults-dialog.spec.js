import { expect, test } from '@playwright/test';
import {
  DIALOG, checkedValues, choose, closeDialog, createProjectsFixture, dialog, enhanced, expectListing, openDialog,
  openDropdown, pageAuthority, query, settled, summaryText, watch,
} from './projects-filters-defaults-fixture.js';

// WP10b A, B, C, O, Q, S, AB, AC: the combined Projects Filters & Defaults
// dialog on the real page — structure, exact footer, responsive layout with
// unclipped overlays, Grid style presentation, close/reopen state, no
// defaults POST from ordinary edits, and keyboard-only operation.

const fixture = createProjectsFixture('projects-fd-dialog');

test.beforeAll(async () => {
  await fixture.start();
});

test.afterAll(async () => {
  await fixture.stop();
});

function seed() {
  fixture.isolate();
  const tagA = fixture.tag('Dialog Tag A');
  const alpha = fixture.project('Dialog Alpha', { status: 'planned', projectType: 'comic', tags: [tagA] });
  const beta = fixture.project('Dialog Beta', { status: 'ready', projectType: 'images' });
  const gamma = fixture.project('Dialog Gamma', { status: 'planned', projectType: 'wallpaper' });
  return { tagA, alpha, beta, gamma };
}

test('A/B: one dialog from the filter icon with the approved title, sections, nine controls and exact footer', async ({ page }) => {
  seed();
  const control = watch(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.baseURL}/projects`);
  await enhanced(page);

  const toolbar = page.locator('.project-filter-actions');
  const icon = toolbar.getByRole('link', { name: 'Filters & Defaults', exact: true });
  await expect(icon).toHaveAttribute('data-tooltip', 'Filters & Defaults');
  // The separate Defaults entry is retired; one dialog only.
  await expect(toolbar.locator('[data-dialog-open]')).toHaveCount(1);
  await expect(page.locator('#projects-defaults-dialog')).toHaveCount(0);
  await expect(page.locator(`dialog[data-app-dialog]${DIALOG}`)).toHaveCount(1);
  // Unrelated toolbar controls are kept.
  await expect(page.locator('#projects-nsfw-toggle')).toBeVisible();
  await expect(page.locator('nav.view-switcher')).toBeVisible();
  await expect(page.getByRole('link', { name: 'New Project' }).first()).toBeVisible();

  await openDialog(page);
  const box = dialog(page);
  await expect(box.getByRole('heading', { level: 2 })).toHaveText('Filters & Defaults');
  await expect(box.locator('.app-dialog-subtitle')).toHaveText('Projects');
  await expect(box.locator('.filters-defaults-section > h3')).toHaveText(['Filters', 'Sort options', 'Miscellaneous']);
  const labels = (index) => box.locator('.filters-defaults-section').nth(index)
    .locator(':scope .filters-defaults-grid > .field > legend, :scope .filters-defaults-grid > .field > label');
  await expect(labels(0)).toHaveText(['Search', 'Projects', 'Status', 'Project Type', 'Tag']);
  await expect(labels(1)).toHaveText(['Sort by', 'Sort order']);
  await expect(labels(2)).toHaveText(['View', 'Grid style']);
  await expect(box.locator('footer button')).toHaveText(['Save new defaults', 'Reset defaults', 'Reset filters']);
  await expect(box.getByRole('button', { name: /^(Cancel|Apply|Done|Close|Restore|Save changes)$/ })).toHaveCount(0);
  await expect(box.locator('[data-projects-defaults-indicator]')).toHaveText('No saved defaults.');
  await openDropdown(page, 'project-sort-filter');
  await expect(box.locator('#project-sort-filter-options label')).toHaveText(['Updated', 'Created', 'Title']);
  await page.locator('#project-sort-filter summary').click();
  await openDropdown(page, 'project-order-filter');
  await expect(box.locator('#project-order-filter-options label')).toHaveText(['Ascending', 'Descending']);
  await expect(box.locator('#project-order-filter [data-cc-dropdown-summary-current]')).toHaveText('Descending');
  await page.locator('#project-order-filter summary').click();
  // No page-size selector, no scope radios.
  await expect(box.locator('input[type="radio"][name="scope"], [name="pageSize"]')).toHaveCount(0);
  // Opening reads saved metadata only.
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('C: wide, medium and narrow layouts keep 3/2/1 columns, no horizontal overflow and unclipped overlays', async ({ page }) => {
  seed();
  await page.goto(`${fixture.baseURL}/projects`);
  await enhanced(page);
  for (const [width, height, columns] of [[1280, 900, 3], [760, 900, 2], [390, 844, 1]]) {
    await page.setViewportSize({ width, height });
    if (!(await dialog(page).evaluate((element) => element.open))) await openDialog(page);
    const layout = await dialog(page).evaluate((element) => {
      const body = element.querySelector('.app-dialog-body');
      const grids = [...element.querySelectorAll('.filters-defaults-grid')];
      const card = element.querySelector('.app-dialog-card').getBoundingClientRect();
      return {
        columns: [...new Set(grids.map((grid) => getComputedStyle(grid).gridTemplateColumns.split(' ').length))],
        bodyOverflow: Math.max(0, body.scrollWidth - body.clientWidth),
        pageOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
        cardInside: card.left >= 0 && card.right <= innerWidth,
        stacked: grids.every((grid, index) => index === 0
          || grid.closest('section').getBoundingClientRect().top > grids[index - 1].closest('section').getBoundingClientRect().top),
        footer: [...element.querySelectorAll('footer button')].every((button) => {
          const rect = button.getBoundingClientRect();
          return rect.left >= 0 && rect.right <= innerWidth && rect.width > 0;
        }),
      };
    });
    expect(layout, `${width}px`).toEqual({
      columns: [columns], bodyOverflow: 0, pageOverflow: 0, cardInside: true, stacked: true, footer: true,
    });

    // The Projects panel opens as a fixed overlay that is hit-testable.
    const details = await openDropdown(page, 'project-project-filter');
    const panel = details.locator('.asset-filter-multiselect-panel');
    await expect(panel).toHaveAttribute('data-cc-dropdown-overlay', '');
    const reachable = await panel.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const x = rect.left + Math.min(rect.width / 2, 40);
      const y = rect.top + Math.min(rect.height / 2, 40);
      return rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight
        && element.contains(document.elementFromPoint(x, y));
    });
    expect(reachable, `${width}px panel`).toBe(true);
    await details.locator('summary').click();
    // The footer is reachable at every width.
    await dialog(page).locator('footer [data-projects-defaults-save]').scrollIntoViewIfNeeded();
    await expect(dialog(page).locator('footer [data-projects-defaults-save]')).toBeInViewport();
  }
});

test('O/S: Grid style and View change the actual presentation without saving defaults', async ({ page }) => {
  const { alpha } = seed();
  const control = watch(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.baseURL}/projects`);
  await enhanced(page);
  const grid = page.locator('[data-projects-live-region] .project-grid');
  const preview = page.locator(`[data-projects-live-region] a.project-grid-card-preview-link[href="/projects/${alpha.id}"]`).first();
  await expect(grid).toHaveAttribute('data-grid-style', 'uncropped');
  const geometry = () => preview.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { ratio: getComputedStyle(element).aspectRatio, square: Math.abs(rect.width - rect.height) < 1.5 };
  });
  expect((await geometry()).ratio).not.toBe('1 / 1');

  await openDialog(page);
  await choose(page, 'project-grid-style-filter', 'Cropped');
  await expect(grid).toHaveAttribute('data-grid-style', 'cropped');
  // The card media geometry changes, not just the label.
  expect(await geometry()).toEqual({ ratio: '1 / 1', square: true });
  expect(await summaryText(page, 'project-grid-style-filter')).toBe('Cropped');

  // View: List, then back to Grid; the session Grid style survives the
  // live-region replacements.
  await choose(page, 'project-view-filter', 'List');
  await expect(page.locator('[data-projects-list-table]')).toBeVisible();
  expect(query(page).get('view')).toBe('list');
  await choose(page, 'project-view-filter', 'Grid');
  await expect(page.locator('[data-projects-live-region] .project-grid')).toHaveAttribute('data-grid-style', 'cropped');
  // Sorting applies to the page too.
  await choose(page, 'project-sort-filter', 'Title');
  await choose(page, 'project-order-filter', 'Ascending');
  await expect.poll(() => query(page).get('sort')).toBe('title');
  await expect(page.locator('[data-projects-live-region] .project-grid')).toHaveAttribute('data-grid-style', 'cropped');
  await closeDialog(page);
  await openDialog(page);
  expect(await summaryText(page, 'project-grid-style-filter')).toBe('Cropped');
  expect(await summaryText(page, 'project-sort-filter')).toBe('Title');

  // Nothing was saved and no defaults request was made.
  expect(control.defaultsPosts()).toEqual([]);
  expect(fixture.storedProjectsDefaults()).toEqual({
    view: undefined, gridStyle: undefined, sort: undefined, order: undefined,
    status: undefined, projectType: undefined, tag: undefined,
  });
  await expect(dialog(page).locator('[data-projects-defaults-indicator]'))
    .toContainText('Current settings differ from the application defaults');
  expect(control.errors).toEqual([]);
});

test('Q: dismissing and reopening keeps the current filters; dismissal never persists defaults', async ({ page }) => {
  const { alpha, gamma, tagA } = seed();
  const control = watch(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.baseURL}/projects`);
  await enhanced(page);
  await openDialog(page);
  await choose(page, 'project-status-filter', 'Planned');
  await choose(page, 'project-project-filter', alpha.title, { search: 'dialog' });
  await choose(page, 'project-project-filter', gamma.title);
  await expect.poll(() => query(page).getAll('project').sort()).toEqual([String(alpha.id), String(gamma.id)].sort());
  await page.locator('#projects-search').fill('Dialog');
  await expect.poll(() => query(page).get('search')).toBe('Dialog');
  await settled(page);
  await expectListing(page, [alpha.id, gamma.id]);

  await closeDialog(page);
  await openDialog(page);
  expect((await checkedValues(page, 'project-project-filter')).sort()).toEqual([String(alpha.id), String(gamma.id)].sort());
  expect(await checkedValues(page, 'project-status-filter')).toEqual(['planned']);
  expect(await summaryText(page, 'project-project-filter')).toBe('2 projects selected');
  await expect(page.locator('#projects-search')).toHaveValue('Dialog');

  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  await openDialog(page);
  expect(await summaryText(page, 'project-status-filter')).toBe('Planned');
  expect(control.defaultsPosts()).toEqual([]);
  expect(fixture.readPageDefault('projects', 'status')).toBeUndefined();
  expect((await pageAuthority(page)).savedKeys).toEqual([]);
  expect(tagA.id).toBeGreaterThan(0);
});

test('AB/AC: keyboard-only opening, multi-select with Space, Escape layering and focus return', async ({ page }) => {
  const { alpha, beta } = seed();
  const control = watch(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.baseURL}/projects`);
  await enhanced(page);

  const icon = page.getByRole('link', { name: 'Filters & Defaults', exact: true });
  await icon.focus();
  await page.keyboard.press('Enter');
  await expect(dialog(page)).toBeVisible();
  await expect(page.locator(`${DIALOG} [data-dialog-close]`)).toBeFocused();

  // Tab through Search to the Projects trigger and open it from the keyboard.
  const trigger = page.locator('#project-project-filter-trigger');
  for (let step = 0; step < 6 && !(await trigger.evaluate((element) => element === document.activeElement)); step += 1) {
    await page.keyboard.press('Tab');
  }
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#project-project-filter')).toHaveJSProperty('open', true);
  await page.keyboard.press('Tab');
  await expect(page.locator('#project-project-filter-search')).toBeFocused();
  await page.keyboard.type('dialog beta');
  // Tab past Select all to the first visible Project and check it with Space.
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const betaBox = page.locator(`#project-project-filter input[type="checkbox"][value="${beta.id}"]`);
  await expect(betaBox).toBeFocused();
  await page.keyboard.press('Space');
  await expect.poll(() => query(page).getAll('project')).toEqual([String(beta.id)]);
  await settled(page);
  await expect(betaBox).toBeChecked();
  expect(await summaryText(page, 'project-project-filter')).toBe(beta.title);
  await expect(page.locator('#project-project-filter')).toHaveJSProperty('open', true);
  await expectListing(page, [beta.id]);

  // Escape closes the menu first, then the dialog, returning focus to the icon.
  await page.keyboard.press('Escape');
  await expect(page.locator('#project-project-filter')).toHaveJSProperty('open', false);
  await expect(dialog(page)).toBeVisible();
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  await expect(icon).toBeFocused();

  // The header X dismisses too and returns focus.
  await icon.click();
  await expect(dialog(page)).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Close Filters & Defaults', exact: true }).click();
  await expect(dialog(page)).toBeHidden();
  await expect(icon).toBeFocused();
  expect(control.defaultsPosts()).toEqual([]);
  expect(alpha.id).toBeGreaterThan(0);
});
