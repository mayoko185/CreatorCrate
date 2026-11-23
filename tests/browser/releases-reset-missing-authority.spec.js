import { expect, test } from '@playwright/test';
import {
  checkedValues, closeDialog, createReleasesFixture, dialog, enhanced, expectTitles, openDialog, pageAuthority, query,
  releasesUrl, settled, summaryText, watch,
} from './releases-filters-defaults-fixture.js';

// P3-B: Reset filters with a missing or malformed installed defaults
// authority must keep the URL page size (as the authority path and the native
// Reset form do), clear every temporary restriction and the exact-asset
// scope, return to page one and leave Sort/Order to the saved defaults. GET
// only; no defaults POST.

const fixture = createReleasesFixture('releases-p3b-reset-authority');

test.beforeAll(async () => {
  await fixture.start();
});

test.afterAll(async () => {
  await fixture.stop();
});

const ALPHAS = Array.from({ length: 10 }, (_, index) => `Alpha ${String(index + 1).padStart(2, '0')}`);
const NEEDLES = ['Needle Comic', 'Needle Comic Two'];
const RESTRICTIONS = ['asset', 'search', 'project', 'type', 'schedule', 'includeArchived', 'sort', 'order', 'page'];

// Saved defaults Title / Ascending. Twelve active releases: ten Alphas and two
// Needles, so size 10 gives two pages (the default 25 would give one). The
// Needles share an exact asset and upcoming planned dates.
function seed() {
  fixture.isolate();
  fixture.writePageDefault('releases', 'sort', 'title');
  fixture.writePageDefault('releases', 'order', 'asc');
  const comic = fixture.project('P3B Comic', { projectType: 'comic' });
  const images = fixture.project('P3B Images', { projectType: 'images' });
  const alphas = ALPHAS.map((title, index) => fixture.release(index % 2 === 0 ? comic : images, title));
  const needles = [
    fixture.release(comic, NEEDLES[0], { plannedDate: '2099-01-10' }),
    fixture.release(comic, NEEDLES[1], { plannedDate: '2099-02-10' }),
  ];
  const assetId = fixture.asset(comic, 'p3b-shared.png');
  needles.forEach((record) => fixture.addAsset(record, assetId));
  return { comic, images, alphas, needles, assetId };
}

// The reviewer's scoped start: exact asset, Search, repeated Projects/Types,
// Schedule, Include archived, an explicit Planned/Descending and size 10.
function scopedUrl(s, pageSize = 10) {
  return releasesUrl(fixture.baseURL, {
    asset: s.assetId,
    search: 'Needle',
    project: [s.comic.id, s.images.id],
    type: ['comic', 'images'],
    schedule: 'upcoming',
    includeArchived: 1,
    sort: 'planned',
    order: 'desc',
    ...(pageSize === 25 ? {} : { pageSize }),
  });
}

async function start(page, url) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(url);
  await enhanced(page);
}

async function renderedIds(page) {
  return page.locator('[data-releases-live-region] .releases-table tbody tr td:first-child a')
    .evaluateAll((links) => links.map((link) => Number(new URL(link.href).pathname.split('/')[2])));
}

function paginationInfo(page) {
  return page.locator('[data-releases-live-region] .pagination-info');
}

async function breakAuthority(page, mode) {
  await page.evaluate((how) => {
    const script = document.querySelector('[data-releases-live-region] script[data-releases-defaults-authority]');
    if (how === 'remove') script.remove();
    else script.textContent = '{"page":"releases",';
  }, mode);
}

function waitForResetGet(page) {
  return page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === '/releases' && request.resourceType() === 'fetch' && !url.searchParams.has('search');
  });
}

function expectResetDestination(url, pageSize) {
  RESTRICTIONS.forEach((key) => expect(url.searchParams.has(key), key).toBe(false));
  if (pageSize === null) expect(url.searchParams.has('pageSize')).toBe(false);
  else expect(url.searchParams.getAll('pageSize')).toEqual([String(pageSize)]);
}

// The installed Reset location: the server canonicalizes the omitted Sort to
// the saved Title (its existing saved-defaults redirect); nothing else but
// the page size.
function expectResetLocation(page, pageSize) {
  const url = new URL(page.url());
  expect(url.pathname).toBe('/releases');
  expect(url.searchParams.get('sort') ?? 'title').toBe('title');
  expect(url.searchParams.get('order') ?? 'asc').toBe('asc');
  RESTRICTIONS.filter((key) => key !== 'sort' && key !== 'order')
    .forEach((key) => expect(url.searchParams.has(key), key).toBe(false));
  if (pageSize === null) expect(url.searchParams.has('pageSize')).toBe(false);
  else expect(url.searchParams.getAll('pageSize')).toEqual([String(pageSize)]);
}

async function expectResetDialog(page) {
  await expect(page.locator('#releases-search')).toHaveValue('');
  expect(await checkedValues(page, 'release-project-filter')).toEqual(['']);
  expect(await checkedValues(page, 'release-type-filter')).toEqual(['']);
  expect(await checkedValues(page, 'list-schedule')).toEqual(['']);
  await expect(page.locator('#list-includeArchived')).not.toBeChecked();
  await expect(page.locator('#list-releases-filter [data-releases-asset-scope]')).toBeHidden();
  await expect(page.locator('#list-releases-filter input[name="asset"]:not([disabled])')).toHaveCount(0);
}

for (const mode of ['remove', 'malform']) {
  test(`reviewer reproduction (${mode} authority): Reset keeps pageSize=10 and clears the asset scope and filters`, async ({ page }) => {
    const s = seed();
    const control = watch(page);
    await start(page, scopedUrl(s));
    // Planned / Descending: the later Needle first.
    await expectTitles(page, [NEEDLES[1], NEEDLES[0]], { total: 2 });
    await breakAuthority(page, mode);

    await openDialog(page);
    const requested = waitForResetGet(page);
    await dialog(page).locator('[data-releases-filters-reset]').click();
    const resetUrl = new URL((await requested).url());
    expect(`${resetUrl.pathname}${resetUrl.search}`).toBe('/releases?pageSize=10');
    expectResetDestination(resetUrl, 10);
    await settled(page);

    // Saved Title / Ascending, size 10: ten Alphas of twelve, page 1 of 2.
    await expectTitles(page, ALPHAS, { total: 12 });
    expect(await renderedIds(page)).toEqual(s.alphas.map((record) => record.id));
    await expect(paginationInfo(page)).toHaveText('Page 1 of 2');
    expectResetLocation(page, 10);
    // The installed response carries a valid authority again.
    const authority = await pageAuthority(page);
    expect(authority.current).toEqual({ sort: 'title', order: 'asc' });
    expect(authority.resetFiltersUrl).toBe('/releases?pageSize=10');
    await expectResetDialog(page);
    expect(await summaryText(page, 'list-sort')).toBe('Title');
    expect(await summaryText(page, 'list-order')).toBe('Ascending');
    await expect(page.locator('#list-releases-filter input[name="pageSize"]')).toHaveValue('10');

    // Page 2 keeps size 10 and no restriction.
    await closeDialog(page);
    await page.locator('[data-releases-live-region] .pagination').getByRole('link', { name: 'Next', exact: true }).click();
    await settled(page);
    await expectTitles(page, NEEDLES, { total: 12 });
    expect(await renderedIds(page)).toEqual(s.needles.map((record) => record.id));
    await expect(paginationInfo(page)).toHaveText('Page 2 of 2');
    expect(query(page).get('pageSize')).toBe('10');
    expect(query(page).has('asset')).toBe(false);

    expect(control.posts).toEqual([]);
    expect(control.defaultsPosts()).toEqual([]);
    expect(control.errors).toEqual([]);
  });
}

test('missing authority with another size (50) and the default size (25)', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  for (const [pageSize, expected, path] of [[50, 50, '/releases?pageSize=50'], [25, null, '/releases']]) {
    await start(page, scopedUrl(s, pageSize));
    await breakAuthority(page, 'remove');
    await openDialog(page);
    const requested = waitForResetGet(page);
    await dialog(page).locator('[data-releases-filters-reset]').click();
    const resetUrl = new URL((await requested).url());
    expect(`${resetUrl.pathname}${resetUrl.search}`).toBe(path);
    expectResetDestination(resetUrl, expected);
    await settled(page);
    await expectTitles(page, [...ALPHAS, ...NEEDLES], { total: 12 });
    await expect(paginationInfo(page)).toHaveText('Page 1 of 1');
    expectResetLocation(page, expected);
    await expectResetDialog(page);
  }
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('missing authority: failed Reset GET keeps the results; GET-only Retry repeats /releases?pageSize=10', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  await start(page, scopedUrl(s));
  await expectTitles(page, [NEEDLES[1], NEEDLES[0]], { total: 2 });
  await breakAuthority(page, 'malform');

  let failNext = true;
  await page.route((url) => url.pathname === '/releases' && !url.searchParams.has('search'), async (route) => {
    if (failNext && route.request().resourceType() === 'fetch') {
      failNext = false;
      await route.abort('failed');
      return;
    }
    await route.fallback();
  });
  await openDialog(page);
  const first = waitForResetGet(page);
  await dialog(page).locator('[data-releases-filters-reset]').click();
  const failedUrl = new URL((await first).url());
  expectResetDestination(failedUrl, 10);
  const notice = page.locator('[data-live-filter-failure]');
  await expect(notice).toHaveCount(1);
  // The installed scoped results stay; the dialog shows the Reset intent.
  await expectTitles(page, [NEEDLES[1], NEEDLES[0]], { total: 2 });
  await expectResetDialog(page);

  const retried = waitForResetGet(page);
  await notice.getByRole('button', { name: 'Retry' }).click();
  expect((await retried).url()).toBe(failedUrl.href);
  await settled(page);
  await expectTitles(page, ALPHAS, { total: 12 });
  expectResetLocation(page, 10);
  await expect(notice).toHaveCount(0);
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('missing authority: Back restores the scoped list and size; Forward and reload keep the Reset', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  const scoped = scopedUrl(s);
  await start(page, scoped);
  await breakAuthority(page, 'remove');
  await openDialog(page);
  const requested = waitForResetGet(page);
  await dialog(page).locator('[data-releases-filters-reset]').click();
  await requested;
  await settled(page);
  await expectTitles(page, ALPHAS, { total: 12 });
  const resetHref = page.url();

  await page.goBack();
  await settled(page);
  await expect.poll(() => page.url()).toBe(scoped);
  await expectTitles(page, [NEEDLES[1], NEEDLES[0]], { total: 2 });
  expect(query(page).get('pageSize')).toBe('10');
  expect(query(page).get('asset')).toBe(String(s.assetId));

  await page.goForward();
  await settled(page);
  await expect.poll(() => page.url()).toBe(resetHref);
  await expectTitles(page, ALPHAS, { total: 12 });

  await page.reload();
  await enhanced(page);
  await expectTitles(page, ALPHAS, { total: 12 });
  expectResetLocation(page, 10);
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});
