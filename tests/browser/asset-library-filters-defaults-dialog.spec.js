import { expect, test } from '@playwright/test';
import {
  DIALOG, checkedValues, choose, closeDialog, createLibraryFixture, dialog, openDialog, openDropdown, query, settled,
  summaryText, watch,
} from './asset-library-filters-defaults-fixture.js';

// WP9b A, B, I, W: the combined Asset Library Filters & Defaults dialog on
// the real page — structure, responsive layout with unclipped overlays,
// close/reopen state, and keyboard-only operation with focus return.

const fixture = createLibraryFixture('asset-library-fd-dialog');

test.beforeAll(async () => {
  await fixture.start();
});

test.afterAll(async () => {
  await fixture.stop();
});

async function seed() {
  fixture.isolate();
  const comic = await fixture.project('Dialog Comic', 'comic', ['c1.png', 'c2.png', 'c3.jpg']);
  const images = await fixture.project('Dialog Images', 'images', ['i1.png', 'i2.png']);
  const animation = await fixture.project('Dialog Animation', 'animation', ['a1.png']);
  return { comic, images, animation };
}

test('A: one dialog opens from the filter icon with the approved title, sections, controls and footer', async ({ page }) => {
  await seed();
  const control = watch(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.baseURL}/asset-viewer`);

  const toolbar = page.locator('.project-filter-actions');
  const icon = toolbar.getByRole('link', { name: 'Filters & Defaults', exact: true });
  await expect(icon).toHaveAttribute('data-tooltip', 'Filters & Defaults');
  // The separate Defaults entry is retired; one dialog only.
  await expect(toolbar.locator('[data-dialog-open]')).toHaveCount(1);
  await expect(page.locator('#asset-viewer-defaults-dialog')).toHaveCount(0);
  await expect(page.locator('dialog[data-app-dialog]#asset-viewer-filter-dialog')).toHaveCount(1);

  await openDialog(page);
  const box = dialog(page);
  await expect(box.getByRole('heading', { level: 2 })).toHaveText('Filters & Defaults');
  await expect(box.locator('.app-dialog-subtitle')).toHaveText('Asset Library');
  await expect(box.locator('.filters-defaults-section > h3')).toHaveText(['Filters', 'Sort options', 'Miscellaneous']);
  const labels = (index) => box.locator('.filters-defaults-section').nth(index)
    .locator(':scope .filters-defaults-grid > .field > legend, :scope .filters-defaults-grid > .field > label');
  await expect(labels(0)).toHaveText(['Search', 'Projects', 'Project Types', 'Category', 'Presence', 'Release usage', 'Tag', 'Extension']);
  await expect(labels(1)).toHaveText(['Sort by', 'Sort order']);
  await expect(labels(2)).toHaveText(['View', 'Grid style', 'Assets per page']);
  await expect(box.locator('footer button')).toHaveText(['Save new defaults', 'Reset defaults', 'Reset filters']);
  await expect(box.getByRole('button', { name: /^(Cancel|Apply|Done)$/ })).toHaveCount(0);
  await expect(box.locator('[data-asset-library-defaults-indicator]')).toHaveText('No saved defaults.');
  await expect(box.locator('#asset-order-filter [data-cc-dropdown-summary-current]')).toHaveText('Ascending');
  await openDropdown(page, 'asset-order-filter');
  await expect(box.locator('#asset-order-filter-options label')).toHaveText(['Ascending', 'Descending']);
  // Opening reads saved metadata only.
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('B: wide, medium and narrow layouts keep 3/2/1 columns, no horizontal overflow and unclipped overlays', async ({ page }) => {
  await seed();
  await page.goto(`${fixture.baseURL}/asset-viewer`);
  for (const [width, height, columns] of [[1280, 900, 3], [760, 900, 2], [390, 844, 1]]) {
    await page.setViewportSize({ width, height });
    if (!(await dialog(page).evaluate((element) => element.open))) await openDialog(page);
    const layout = await dialog(page).evaluate((element) => {
      const body = element.querySelector('.app-dialog-body');
      const grid = element.querySelector('.filters-defaults-grid');
      const card = element.querySelector('.app-dialog-card').getBoundingClientRect();
      return {
        columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
        bodyOverflow: Math.max(0, body.scrollWidth - body.clientWidth),
        // A locked page may reserve a scrollbar gutter (negative difference).
        pageOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
        cardInside: card.left >= 0 && card.right <= innerWidth,
        footer: [...element.querySelectorAll('footer button')].every((button) => {
          const rect = button.getBoundingClientRect();
          return rect.left >= 0 && rect.right <= innerWidth && rect.width > 0;
        }),
      };
    });
    expect(layout, `${width}px`).toEqual({ columns, bodyOverflow: 0, pageOverflow: 0, cardInside: true, footer: true });

    // The Projects panel opens as a fixed overlay that is hit-testable in the viewport.
    const details = await openDropdown(page, 'asset-project-filter');
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
  }
});

test('I: dismissing and reopening keeps the current filters; dismissal never persists defaults', async ({ page }) => {
  const { comic, images } = await seed();
  const control = watch(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.baseURL}/asset-viewer`);
  await openDialog(page);
  await choose(page, 'asset-project-type-filter', 'Comic');
  await choose(page, 'asset-project-filter', images.title, { search: 'images' });
  await expect.poll(() => query(page).getAll('project')).toEqual([String(images.id)]);
  await expect.poll(() => query(page).getAll('type')).toEqual(['comic']);
  await page.locator('#asset-library-search').fill('c');
  await expect.poll(() => query(page).get('search')).toBe('c');
  await settled(page);

  await closeDialog(page);
  await openDialog(page);
  expect(await checkedValues(page, 'asset-project-filter')).toEqual([String(images.id)]);
  expect(await checkedValues(page, 'asset-project-type-filter')).toEqual(['comic']);
  expect(await summaryText(page, 'asset-project-type-filter')).toBe('Comic');
  await expect(page.locator('#asset-library-search')).toHaveValue('c');

  // Escape and the backdrop dismiss too; still no defaults POST.
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  await openDialog(page);
  expect(await checkedValues(page, 'asset-project-filter')).toEqual([String(images.id)]);
  expect(control.defaultsPosts()).toEqual([]);
  expect(fixture.readPageDefault('assetViewer', 'view')).toBeUndefined();
  expect(comic.id).toBeGreaterThan(0);
});

test('W: keyboard-only opening, multi-select with Space, Escape layering and focus return', async ({ page }) => {
  const { comic, images } = await seed();
  const control = watch(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.baseURL}/asset-viewer`);

  const icon = page.getByRole('link', { name: 'Filters & Defaults', exact: true });
  await icon.focus();
  await page.keyboard.press('Enter');
  await expect(dialog(page)).toBeVisible();
  await expect(page.locator(`${DIALOG} [data-dialog-close]`)).toBeFocused();

  // Tab to the Projects trigger and open it from the keyboard.
  const trigger = page.locator('#asset-project-filter-trigger');
  for (let step = 0; step < 6 && !(await trigger.evaluate((element) => element === document.activeElement)); step += 1) {
    await page.keyboard.press('Tab');
  }
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#asset-project-filter')).toHaveJSProperty('open', true);
  await page.keyboard.press('Tab');
  await expect(page.locator('#asset-project-filter-search')).toBeFocused();
  await page.keyboard.type('dialog c');
  // Tab past Select all to the first visible Project and check it with Space.
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const comicBox = page.locator('#asset-project-filter input[type="checkbox"][value="' + comic.id + '"]');
  await expect(comicBox).toBeFocused();
  await page.keyboard.press('Space');
  await expect.poll(() => query(page).getAll('project')).toEqual([String(comic.id)]);
  await settled(page);
  await expect(comicBox).toBeChecked();
  expect(await summaryText(page, 'asset-project-filter')).toBe(comic.title);
  await expect(page.locator('#asset-project-filter')).toHaveJSProperty('open', true);

  // Escape closes the menu first, then the dialog, returning focus to the icon.
  await page.keyboard.press('Escape');
  await expect(page.locator('#asset-project-filter')).toHaveJSProperty('open', false);
  await expect(dialog(page)).toBeVisible();
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  await expect(icon).toBeFocused();
  expect(control.defaultsPosts()).toEqual([]);
  expect(images.id).toBeGreaterThan(0);
});
