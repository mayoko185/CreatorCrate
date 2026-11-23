import { expect, test } from '@playwright/test';
import {
  checkedValues, choose, closeDialog, createReleasesFixture, dialog, enhanced, expectTitles, openDialog, openDropdown,
  query, releasesUrl, settled, summaryText, watch,
} from './releases-filters-defaults-fixture.js';

// WP12 A, B, Q, X, Y, Z: the one Releases Filters & Defaults dialog — entry
// point, structure, footer order and styling, header dismissal, keyboard and
// dropdown operation, narrow and wide layouts, reopening with the current
// state, and the surrounding release actions staying operational.

const fixture = createReleasesFixture('releases-fd-dialog');

test.beforeAll(async () => {
  await fixture.start();
});

test.afterAll(async () => {
  await fixture.stop();
});

function seed() {
  fixture.isolate();
  const comic = fixture.project('Dialog Comic', { projectType: 'comic' });
  const anim = fixture.project('Dialog Anim', { projectType: 'animation' });
  const alpha = fixture.release(comic, 'Dialog Alpha', { plannedDate: '2000-01-01' });
  const beta = fixture.release(anim, 'Dialog Beta', { plannedDate: '2999-01-01' });
  return { comic, anim, alpha, beta };
}

async function start(page, url = `${fixture.baseURL}/releases`, width = 1280) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(url);
  await enhanced(page);
}

test('A/B: one Filters & Defaults entry opens the combined dialog; header-only dismissal; two sections; footer order', async ({ page }) => {
  seed();
  const control = watch(page);
  await start(page);

  const toolbar = page.locator('[data-releases-live-region] .asset-viewer-display-controls');
  await expect(toolbar.locator('[data-dialog-open]')).toHaveCount(1);
  const entry = page.getByRole('link', { name: 'Filters & Defaults', exact: true });
  await expect(entry).toHaveAttribute('data-tooltip', 'Filters & Defaults');
  await expect(page.locator('[data-dialog-open="releases-defaults-dialog"]')).toHaveCount(0);
  await expect(page.locator('#releases-defaults-dialog')).toHaveCount(0);
  // The New Release heading action is untouched.
  await expect(page.locator('a.dashboard-create-action[data-dialog-open="release-create-dialog"]')).toBeVisible();

  await openDialog(page);
  const box = dialog(page);
  await expect(box.locator('h2')).toHaveText('Filters & Defaults');
  await expect(box.locator('.app-dialog-subtitle')).toHaveText('Releases');
  await expect(box.locator('.filters-defaults-section > h3')).toHaveText(['Filters', 'Sort options']);
  await expect(box.getByText('Miscellaneous')).toHaveCount(0);

  const filters = box.locator('section[aria-labelledby="releases-filters-heading"]');
  await expect(filters.getByLabel('Search', { exact: true })).toBeVisible();
  await expect(filters.locator('#release-project-filter > summary')).toHaveAttribute('aria-label', 'Projects filter: All projects');
  await expect(filters.locator('#release-type-filter > summary')).toHaveAttribute('aria-label', 'Project Types filter: All types');
  await expect(filters.locator('#list-schedule > summary')).toHaveAttribute('aria-label', 'Schedule filter: All');
  await expect(filters.getByLabel('Include archived')).not.toBeChecked();
  const sort = box.locator('section[aria-labelledby="releases-sort-heading"]');
  await expect(sort.locator('#list-sort > summary')).toHaveAttribute('aria-label', 'Sort by filter: Planned');
  await expect(sort.locator('#list-order > summary')).toHaveAttribute('aria-label', 'Sort order filter: Ascending');
  // No View, Grid style or page-size control.
  await expect(box.locator('[name="view"], [name="pageSize"]:not([type="hidden"]), [data-releases-grid-style]')).toHaveCount(0);

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
  await expect(box.locator('[data-releases-defaults-indicator]')).toHaveText('No saved defaults.');

  // Keyboard Tab order through the footer follows the DOM order.
  await buttons.nth(0).focus();
  await page.keyboard.press('Tab');
  await expect(buttons.nth(1)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(buttons.nth(2)).toBeFocused();

  // Escape and the header close both dismiss without any request.
  await page.keyboard.press('Escape');
  await expect(box).toBeHidden();
  await openDialog(page);
  await closeDialog(page);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.gets).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('X: keyboard operates the searchable Projects dropdown; option search hides choices but keeps selections', async ({ page }) => {
  const { comic, anim, alpha, beta } = seed();
  const control = watch(page);
  await start(page);

  const icon = page.getByRole('link', { name: 'Filters & Defaults', exact: true });
  await icon.focus();
  await page.keyboard.press('Enter');
  await expect(dialog(page)).toBeVisible();
  await expect(page.locator('#releases-filter-dialog [data-dialog-close]')).toBeFocused();

  // Tab through Search to the Projects trigger and open it from the keyboard.
  const trigger = dropdownSummary(page, 'release-project-filter');
  for (let step = 0; step < 6 && !(await trigger.evaluate((element) => element === document.activeElement)); step += 1) {
    await page.keyboard.press('Tab');
  }
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Enter');
  const panel = page.locator('#release-project-filter .asset-filter-multiselect-panel');
  await expect(panel).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.locator('#release-project-filter-search')).toBeFocused();
  await page.keyboard.type('Comic');
  const comicOption = page.locator(`#release-project-filter input[value="${comic.id}"]`);
  const animOption = page.locator(`#release-project-filter input[value="${anim.id}"]`);
  await expect(animOption).toBeHidden();
  // Tab past Select all to the first visible Project and check it with Space.
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(comicOption).toBeFocused();
  await page.keyboard.press('Space');
  await settled(page);
  await expect.poll(() => query(page).getAll('project')).toEqual([String(comic.id)]);
  await expectTitles(page, [alpha.title]);

  // Searching away from the selected Project hides it but keeps it checked.
  await page.locator('#release-project-filter-search').fill('Anim');
  await expect(comicOption).toBeHidden();
  await expect(comicOption).toBeChecked();
  await animOption.check();
  await settled(page);
  await expect.poll(() => query(page).getAll('project').sort())
    .toEqual([String(comic.id), String(anim.id)].sort());
  await expectTitles(page, [alpha.title, beta.title]);
  expect(await summaryText(page, 'release-project-filter')).toBe('2 projects selected');

  // Escape closes the menu first, then the dialog, returning focus to the icon.
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(dialog(page)).toBeVisible();
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  await expect(icon).toBeFocused();
  expect(control.defaultsPosts()).toEqual([]);
});

function dropdownSummary(page, id) {
  return page.locator(`#${id} > summary`);
}

test('Q: reopening the dialog reflects the current state (Back included) and re-reads saved metadata with GET only', async ({ page }) => {
  const { comic, alpha } = seed();
  const control = watch(page);
  await start(page);
  await openDialog(page);
  await choose(page, 'release-project-filter', comic.title);
  await page.locator('#releases-search').fill('Alpha');
  await expect.poll(() => query(page).get('search')).toBe('Alpha');
  await settled(page);
  await choose(page, 'list-sort', 'Title');
  await closeDialog(page);

  // Saved defaults change elsewhere; reopening reads them (GET only).
  fixture.writePageDefault('releases', 'order', 'desc');
  const reads = control.defaultsGets.length;
  await openDialog(page);
  await expect.poll(() => control.defaultsGets.length).toBeGreaterThan(reads);
  await expect(dialog(page).locator('[data-releases-defaults-indicator]'))
    .toHaveText('1 of 2 defaults saved · Current settings differ from the saved defaults.');
  await expect(page.locator('#releases-search')).toHaveValue('Alpha');
  expect(await checkedValues(page, 'release-project-filter')).toEqual([String(comic.id)]);
  expect(await summaryText(page, 'list-sort')).toBe('Title');
  await expectTitles(page, [alpha.title]);
  await closeDialog(page);

  await page.goBack();
  await settled(page);
  await openDialog(page);
  // The previous entry is the Search request (the form carries the explicit
  // Sort it had then), so the controls follow it back.
  expect(query(page).get('sort')).not.toBe('title');
  expect(await summaryText(page, 'list-sort')).toBe('Planned');
  await expect(page.locator('#releases-search')).toHaveValue('Alpha');
  expect(control.defaultsPosts()).toEqual([]);
});

test('Y: narrow and wide layouts keep every control and footer action visible without horizontal overflow', async ({ page }) => {
  seed();
  for (const width of [1280, 760, 390]) {
    await start(page, `${fixture.baseURL}/releases`, width);
    await openDialog(page);
    const box = dialog(page);
    const card = box.locator('.app-dialog-card');
    const overflow = await card.evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    const columns = await box.locator('section[aria-labelledby="releases-filters-heading"] .filters-defaults-grid')
      .evaluate((grid) => getComputedStyle(grid).gridTemplateColumns.split(' ').length);
    expect(columns).toBe(width >= 861 ? 3 : (width > 540 ? 2 : 1));
    for (const label of ['Save new defaults', 'Reset defaults', 'Reset filters']) {
      await box.getByRole('button', { name: label, exact: true }).scrollIntoViewIfNeeded();
      await expect(box.getByRole('button', { name: label, exact: true })).toBeVisible();
    }
    // An open searchable dropdown is not painted over by the next field.
    await openDropdown(page, 'release-project-filter');
    const search = page.locator('#release-project-filter-search');
    await expect(search).toBeVisible();
    const point = await search.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    const topmost = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, point);
    expect(topmost).toBe('release-project-filter-search');
    await page.keyboard.press('Escape');
    await closeDialog(page);
  }
});

test('Z: New Release, release links and pagination stay operational with the combined dialog', async ({ page }) => {
  const { comic } = seed();
  for (let i = 0; i < 3; i += 1) fixture.release(comic, `Paged ${i}`);
  const control = watch(page);
  await start(page, releasesUrl(fixture.baseURL, { pageSize: 2, sort: 'title' }));

  // Pagination is a live GET that keeps the page size.
  await page.getByRole('link', { name: 'Next', exact: true }).click();
  await settled(page);
  expect(query(page).get('page')).toBe('2');
  expect(query(page).get('pageSize')).toBe('2');
  expect(query(page).get('sort')).toBe('title');

  // New Release still opens its own dialog.
  await page.locator('a.dashboard-create-action').click();
  await expect(page.locator('#release-create-dialog')).toBeVisible();
  await page.locator('#release-create-dialog [data-dialog-close]').first().click();
  await expect(page.locator('#release-create-dialog')).toBeHidden();

  // A release title link navigates to its detail page.
  const link = page.locator('[data-releases-live-region] .releases-table tbody a[href^="/releases/"]').first();
  const href = await link.getAttribute('href');
  await link.click();
  await page.waitForURL((url) => url.pathname === href);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});
