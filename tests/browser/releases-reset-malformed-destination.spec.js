import { expect, test } from '@playwright/test';
import {
  checkedValues, createReleasesFixture, dialog, enhanced, expectTitles, openDialog, pageAuthority, query,
  releasesUrl, settled, summaryText, watch,
} from './releases-filters-defaults-fixture.js';

// P3 correction 3: an otherwise readable Releases defaults authority whose
// Reset filters destination is whitespace or fragment-only must not resolve
// to the current (asset-scoped, searched) address. The controller rejects it
// before resolution and uses the P3-B fallback: /releases with only the
// intended page size. GET only; no defaults POST.

const fixture = createReleasesFixture('releases-p3c3-reset-destination');

test.beforeAll(async () => {
  await fixture.start();
});

test.afterAll(async () => {
  await fixture.stop();
});

const ALPHAS = Array.from({ length: 10 }, (_, index) => `Alpha ${String(index + 1).padStart(2, '0')}`);
const NEEDLES = ['Needle Comic', 'Needle Comic Two'];
const RESTRICTIONS = ['asset', 'search', 'project', 'type', 'schedule', 'includeArchived', 'sort', 'order', 'page'];
const MALFORMED = ['   ', '#ignored'];

// P3-C3 follow-up: a scheme with nothing (or only a fragment) after it
// resolves against the same-scheme page to the CURRENT scoped address; a
// same-origin, same-page URL carrying userinfo passes the origin/path check
// but cannot be requested by the live engine. Both use the fallback.
function credentialUrl(base) {
  const url = new URL('/releases?pageSize=50', base);
  url.username = 'p3user';
  url.password = 'p3secret';
  return url.href;
}

// [label, destination(baseURL)]
const DESTINATIONS = [
  ...MALFORMED.map((value) => [JSON.stringify(value), () => value]),
  ['"http:"', () => 'http:'],
  ['"http:#ignored"', () => 'http:#ignored'],
  ['same-origin credentials', credentialUrl],
];

// Saved defaults Title / Ascending. Twelve active releases: ten Alphas and two
// Needles sharing an exact asset, so size 10 gives two pages.
function seed() {
  fixture.isolate();
  fixture.writePageDefault('releases', 'sort', 'title');
  fixture.writePageDefault('releases', 'order', 'asc');
  const comic = fixture.project('P3C3 Comic', { projectType: 'comic' });
  const images = fixture.project('P3C3 Images', { projectType: 'images' });
  const alphas = ALPHAS.map((title, index) => fixture.release(index % 2 === 0 ? comic : images, title));
  const needles = [
    fixture.release(comic, NEEDLES[0], { plannedDate: '2099-01-10' }),
    fixture.release(comic, NEEDLES[1], { plannedDate: '2099-02-10' }),
  ];
  const assetId = fixture.asset(comic, 'p3c3-shared.png');
  needles.forEach((record) => fixture.addAsset(record, assetId));
  return { comic, images, alphas, needles, assetId };
}

// The reviewer's start: exact asset, Search, Projects/Types, Schedule,
// Include archived, Planned/Descending and size 10.
function scopedUrl(s) {
  return releasesUrl(fixture.baseURL, {
    asset: s.assetId,
    search: 'Needle',
    project: [s.comic.id, s.images.id],
    type: ['comic', 'images'],
    schedule: 'upcoming',
    includeArchived: 1,
    sort: 'planned',
    order: 'desc',
    pageSize: 10,
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

// Keeps the installed authority readable and only replaces its Reset
// destination.
async function setResetDestination(page, value) {
  await page.evaluate((destination) => {
    const script = document.querySelector('[data-releases-live-region] script[data-releases-defaults-authority]');
    const authority = JSON.parse(script.textContent);
    authority.resetFiltersUrl = destination;
    script.textContent = JSON.stringify(authority);
  }, value);
  expect((await pageAuthority(page)).resetFiltersUrl).toBe(value);
}

function isResetRequest(url) {
  return url.pathname === '/releases' && RESTRICTIONS.every((key) => !url.searchParams.has(key));
}

function waitForResetGet(page) {
  return page.waitForRequest((request) => request.resourceType() === 'fetch' && isResetRequest(new URL(request.url())));
}

/** Holds (or fails) the live Reset GET only; `seen` resolves when it was sent. */
async function controlReset(page, { fail = false } = {}) {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let markSeen;
  const seen = new Promise((resolve) => { markSeen = resolve; });
  let markDone;
  const done = new Promise((resolve) => { markDone = resolve; });
  await page.route((url) => isResetRequest(url), async (route) => {
    if (route.request().resourceType() !== 'fetch') {
      await route.fallback();
      return;
    }
    markSeen(route.request().url());
    if (fail) {
      await route.abort('failed').catch(() => {});
      markDone();
      return;
    }
    await held;
    await route.continue().catch(() => {});
    markDone();
  });
  return { release, seen, done };
}

function expectResetRequest(url) {
  expect(`${url.pathname}${url.search}`).toBe('/releases?pageSize=10');
}

function expectResetLocation(page) {
  const url = new URL(page.url());
  expect(url.pathname).toBe('/releases');
  expect(url.searchParams.get('sort') ?? 'title').toBe('title');
  expect(url.searchParams.get('order') ?? 'asc').toBe('asc');
  RESTRICTIONS.filter((key) => key !== 'sort' && key !== 'order')
    .forEach((key) => expect(url.searchParams.has(key), key).toBe(false));
  expect(url.searchParams.getAll('pageSize')).toEqual(['10']);
}

async function expectClearedDialog(page) {
  await expect(page.locator('#releases-search')).toHaveValue('');
  expect(await checkedValues(page, 'release-project-filter')).toEqual(['']);
  expect(await checkedValues(page, 'release-type-filter')).toEqual(['']);
  expect(await checkedValues(page, 'list-schedule')).toEqual(['']);
  await expect(page.locator('#list-includeArchived')).not.toBeChecked();
  await expect(page.locator('#list-releases-filter input[name="asset"]:not([disabled])')).toHaveCount(0);
}

async function frame(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
}

for (const [label, destinationFor] of DESTINATIONS) {
  test(`reviewer reproduction (${label}): Reset GETs /releases?pageSize=10 and clears every restriction`, async ({ page }) => {
    const s = seed();
    const control = watch(page);
    const scoped = scopedUrl(s);
    await start(page, scoped);
    await expectTitles(page, [NEEDLES[1], NEEDLES[0]], { total: 2 });
    await setResetDestination(page, destinationFor(fixture.baseURL));
    const fetched = [];
    page.on('request', (request) => fetched.push(request.url()));

    await openDialog(page);
    const requested = waitForResetGet(page);
    await dialog(page).locator('[data-releases-filters-reset]').click();
    expectResetRequest(new URL((await requested).url()));
    await settled(page);

    // Saved Title / Ascending, size 10: ten Alphas of twelve, page 1 of 2.
    await expectTitles(page, ALPHAS, { total: 12 });
    expect(await renderedIds(page)).toEqual(s.alphas.map((record) => record.id));
    await expect(paginationInfo(page)).toHaveText('Page 1 of 2');
    expectResetLocation(page);
    await expectClearedDialog(page);
    expect(await summaryText(page, 'list-sort')).toBe('Title');
    expect(await summaryText(page, 'list-order')).toBe('Ascending');
    const resetHref = page.url();

    // Page 2 keeps size 10 and stays unscoped.
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
    await page.locator('[data-releases-live-region] .pagination').getByRole('link', { name: 'Next', exact: true }).click();
    await settled(page);
    expect(await renderedIds(page)).toEqual(s.needles.map((record) => record.id));
    await expect(paginationInfo(page)).toHaveText('Page 2 of 2');
    expect(query(page).get('pageSize')).toBe('10');
    expect(query(page).has('asset')).toBe(false);
    expect(query(page).has('search')).toBe(false);

    // Back to the Reset entry, Back to the scoped entry, Forward again.
    await page.goBack();
    await settled(page);
    await expect.poll(() => page.url()).toBe(resetHref);
    await expectTitles(page, ALPHAS, { total: 12 });
    await page.goBack();
    await settled(page);
    await expect.poll(() => page.url()).toBe(scoped);
    await expectTitles(page, [NEEDLES[1], NEEDLES[0]], { total: 2 });
    expect(query(page).get('asset')).toBe(String(s.assetId));
    await page.goForward();
    await settled(page);
    await expect.poll(() => page.url()).toBe(resetHref);
    await expectTitles(page, ALPHAS, { total: 12 });
    expect(query(page).has('asset')).toBe(false);

    // No request ever addressed userinfo; no credentials reached the address bar.
    expect(fetched.filter((href) => new URL(href).username !== '')).toEqual([]);
    expect(page.url()).not.toContain('p3secret');
    expect(control.posts).toEqual([]);
    expect(control.defaultsPosts()).toEqual([]);
    expect(control.errors).toEqual([]);
  });
}

for (const [label, destinationFor] of [DESTINATIONS[1], DESTINATIONS[2], DESTINATIONS[4]]) {
test(`${label} Reset held -> Search stays unscoped at size 10; the older Reset response never reinstalls`, async ({ page }) => {
  const s = seed();
  const control = watch(page);
  await start(page, scopedUrl(s));
  await setResetDestination(page, destinationFor(fixture.baseURL));
  const reset = await controlReset(page);
  await openDialog(page);
  await dialog(page).locator('[data-releases-filters-reset]').click();
  expectResetRequest(new URL(await reset.seen));
  await expectClearedDialog(page);

  const searched = page.waitForRequest((request) => request.resourceType() === 'fetch'
    && new URL(request.url()).searchParams.get('search') === 'Alpha 0');
  await page.locator('#releases-search').fill('Alpha 0');
  const requested = new URL((await searched).url());
  RESTRICTIONS.filter((key) => key !== 'search' && key !== 'sort' && key !== 'order')
    .forEach((key) => expect(requested.searchParams.has(key), key).toBe(false));
  expect(requested.searchParams.get('sort') ?? 'title').toBe('title');
  expect(requested.searchParams.get('order') ?? 'asc').toBe('asc');
  expect(requested.searchParams.get('pageSize')).toBe('10');
  await settled(page);
  await expectTitles(page, ALPHAS.slice(0, 9), { total: 9 });
  const composed = page.url();

  reset.release();
  await reset.done;
  await frame(page);
  expect(page.url()).toBe(composed);
  await expectTitles(page, ALPHAS.slice(0, 9), { total: 9 });
  expect(query(page).has('asset')).toBe(false);
  await expect(page.locator('[data-live-filter-failure]')).toHaveCount(0);
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});
}

for (const [label, destinationFor] of [DESTINATIONS[0], DESTINATIONS[3], DESTINATIONS[4]]) {
test(`${label} Reset fails -> GET-only Retry repeats /releases?pageSize=10`, async ({ page }) => {
  const s = seed();
  const control = watch(page);
  await start(page, scopedUrl(s));
  await setResetDestination(page, destinationFor(fixture.baseURL));
  const reset = await controlReset(page, { fail: true });
  await openDialog(page);
  await dialog(page).locator('[data-releases-filters-reset]').click();
  const failedHref = await reset.seen;
  expectResetRequest(new URL(failedHref));
  await reset.done;
  const notice = page.locator('[data-live-filter-failure]');
  await expect(notice).toHaveCount(1);
  await expectTitles(page, [NEEDLES[1], NEEDLES[0]], { total: 2 });
  await expectClearedDialog(page);

  await page.unrouteAll({ behavior: 'wait' });
  const retried = waitForResetGet(page);
  await notice.getByRole('button', { name: 'Retry' }).click();
  expect((await retried).url()).toBe(failedHref);
  await settled(page);
  await expectTitles(page, ALPHAS, { total: 12 });
  expectResetLocation(page);
  await expect(notice).toHaveCount(0);
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});
}

test('negative control: a valid authority destination is used as given (pageSize=50)', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  await start(page, scopedUrl(s));
  await setResetDestination(page, '/releases?pageSize=50');
  await openDialog(page);
  const requested = waitForResetGet(page);
  await dialog(page).locator('[data-releases-filters-reset]').click();
  const url = new URL((await requested).url());
  expect(`${url.pathname}${url.search}`).toBe('/releases?pageSize=50');
  await settled(page);
  await expectTitles(page, [...ALPHAS, ...NEEDLES], { total: 12 });
  await expect(paginationInfo(page)).toHaveText('Page 1 of 1');
  expect(query(page).get('pageSize')).toBe('50');
  expect(query(page).has('asset')).toBe(false);
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});
