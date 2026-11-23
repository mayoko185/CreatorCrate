import { expect, test } from '@playwright/test';
import {
  createReleasesFixture, dialog, enhanced, expectTitles, openDialog, query, releasesUrl, settled, watch,
} from './releases-filters-defaults-fixture.js';

// P3 correction 5: the native Reset filters form (dialog footer, outside the
// Releases live region) follows the most recently INSTALLED page size. Once
// live enhancement is lost after successful live installs, the real native
// GET submission keeps that size (not the initial document's), clears every
// temporary restriction and the exact-asset scope, returns to page one and
// leaves Sort/Order to the saved defaults. No defaults POST.

const fixture = createReleasesFixture('releases-p3-native-reset-size');

test.beforeAll(async () => {
  await fixture.start();
});

test.afterAll(async () => {
  await fixture.stop();
});

const ROWS = Array.from({ length: 58 }, (_, index) => `Row ${String(index + 1).padStart(2, '0')}`);
const NEEDLES = ['Needle Comic', 'Needle Comic Two'];
// Saved Title / Ascending: the Needles sort before the Rows.
const ALL_TITLES = [...NEEDLES, ...ROWS];
const RESTRICTIONS = ['asset', 'search', 'project', 'type', 'schedule', 'includeArchived', 'sort', 'order', 'page'];

// Sixty active releases: size 10 gives six pages, 25 three, 50 two, 100 one.
// The two Needles share an exact asset and upcoming planned dates.
function seed() {
  fixture.isolate();
  fixture.writePageDefault('releases', 'sort', 'title');
  fixture.writePageDefault('releases', 'order', 'asc');
  const comic = fixture.project('P3N Comic', { projectType: 'comic' });
  const images = fixture.project('P3N Images', { projectType: 'images' });
  const rows = ROWS.map((title, index) => fixture.release(index % 2 === 0 ? comic : images, title));
  const needles = [
    fixture.release(comic, NEEDLES[0], { plannedDate: '2099-01-10' }),
    fixture.release(comic, NEEDLES[1], { plannedDate: '2099-02-10' }),
  ];
  const assetId = fixture.asset(comic, 'p3n-shared.png');
  needles.forEach((record) => fixture.addAsset(record, assetId));
  const ids = new Map([...rows, ...needles].map((record) => [record.title, record.id]));
  return { comic, images, rows, needles, assetId, ids };
}

// The scoped start: exact asset, Search, repeated Projects/Types, Schedule,
// Include archived and an explicit Planned/Descending.
function scopedParams(s) {
  return {
    asset: s.assetId,
    search: 'Needle',
    project: [s.comic.id, s.images.id],
    type: ['comic', 'images'],
    schedule: 'upcoming',
    includeArchived: 1,
    sort: 'planned',
    order: 'desc',
  };
}

function sized(params, pageSize) {
  return pageSize === 25 ? { ...params } : { ...params, pageSize };
}

function pathOf(params) {
  const href = releasesUrl(fixture.baseURL, params);
  const url = new URL(href);
  return `${url.pathname}${url.search}`;
}

async function start(page, url) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(url);
  await enhanced(page);
}

// A real live install through the page's own Releases engine (the module
// instance creatorcrate.js loaded), as Reset and every filter GET use it.
async function liveNavigate(page, path) {
  const status = await page.evaluate(async (destination) => {
    const live = await import('/client/live-regions.js');
    return live.navigateReleasesLive(document, destination).status;
  }, path);
  expect(status).toBe('started');
}

async function liveInstall(page, path) {
  const requested = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return `${url.pathname}${url.search}` === path && response.request().resourceType() === 'fetch';
  });
  await liveNavigate(page, path);
  await requested;
  await settled(page);
}

// Live enhancement becomes unavailable without a reload: the live engine's
// capability check fails, so Reset filters is left to the native GET form.
async function loseEnhancement(page) {
  await page.evaluate(() => { window.DOMParser = undefined; });
}

function nativeResetFields(page) {
  return page.locator('form.releases-filter-reset input[name="pageSize"]')
    .evaluateAll((inputs) => inputs.map((input) => [input.type, input.value, input.disabled]));
}

async function expectNativeResetFields(page, pageSize) {
  await expect.poll(() => nativeResetFields(page))
    .toEqual(pageSize === 25 ? [] : [['hidden', String(pageSize), false]]);
}

async function renderedIds(page) {
  return page.locator('[data-releases-live-region] .releases-table tbody tr td:first-child a')
    .evaluateAll((links) => links.map((link) => Number(new URL(link.href).pathname.split('/')[2])));
}

function paginationInfo(page) {
  return page.locator('[data-releases-live-region] .pagination-info');
}

// Clicks the real Reset filters button and returns the native document GET.
async function nativeReset(page) {
  await openDialog(page);
  const requested = page.waitForRequest((request) => request.resourceType() === 'document'
    && new URL(request.url()).pathname === '/releases');
  await dialog(page).locator('[data-releases-filters-reset]').click();
  const request = await requested;
  expect(request.method()).toBe('GET');
  await page.waitForLoadState('load');
  return new URL(request.url());
}

function expectNativeResetDestination(url, pageSize) {
  RESTRICTIONS.forEach((key) => expect(url.searchParams.has(key), key).toBe(false));
  if (pageSize === 25) expect(url.searchParams.has('pageSize')).toBe(false);
  else expect(url.searchParams.getAll('pageSize')).toEqual([String(pageSize)]);
  expect([...url.searchParams.keys()].filter((key) => key !== 'pageSize')).toEqual([]);
}

// The installed Reset: saved Title/Ascending (the server may canonicalize the
// omitted Sort/Order into the URL), page one, only the size kept.
async function expectResetPage(page, s, pageSize) {
  const url = new URL(page.url());
  expect(url.pathname).toBe('/releases');
  expect(url.searchParams.get('sort') ?? 'title').toBe('title');
  expect(url.searchParams.get('order') ?? 'asc').toBe('asc');
  RESTRICTIONS.filter((key) => key !== 'sort' && key !== 'order')
    .forEach((key) => expect(url.searchParams.has(key), key).toBe(false));
  if (pageSize === 25) expect(url.searchParams.has('pageSize')).toBe(false);
  else expect(url.searchParams.getAll('pageSize')).toEqual([String(pageSize)]);
  const titles = ALL_TITLES.slice(0, pageSize);
  await expectTitles(page, titles, { total: ALL_TITLES.length });
  expect(await renderedIds(page)).toEqual(titles.map((title) => s.ids.get(title)));
  const pages = Math.ceil(ALL_TITLES.length / pageSize);
  if (pages > 1) await expect(paginationInfo(page)).toHaveText(`Page 1 of ${pages}`);
  await expectNativeResetFields(page, pageSize);
}

test('reviewer reproduction: 50 -> live 10 -> enhancement lost -> native Reset submits pageSize=10', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  await start(page, releasesUrl(fixture.baseURL, { sort: 'title', order: 'asc', search: 'Row', pageSize: 50 }));
  await expectTitles(page, ROWS.slice(0, 50), { total: ROWS.length });
  await expectNativeResetFields(page, 50);

  await liveInstall(page, pathOf({ sort: 'title', order: 'asc', search: 'Row', pageSize: 10 }));
  await expectTitles(page, ROWS.slice(0, 10), { total: ROWS.length });
  await expect(paginationInfo(page)).toHaveText('Page 1 of 6');
  expect(query(page).get('pageSize')).toBe('10');
  await expectNativeResetFields(page, 10);

  await loseEnhancement(page);
  const gets = control.gets.length;
  const submitted = await nativeReset(page);
  expectNativeResetDestination(submitted, 10);
  // A native document navigation, not a live GET.
  expect(control.gets).toHaveLength(gets);
  await expectResetPage(page, s, 10);
  expect(control.posts).toEqual([]);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});

for (const [from, to] of [[10, 50], [50, 25], [25, 100]]) {
  test(`installed ${from} -> live ${to} -> native Reset keeps ${to}; the exact-asset scope and filters clear`, async ({ page }) => {
    const s = seed();
    const control = watch(page);
    await start(page, releasesUrl(fixture.baseURL, sized(scopedParams(s), from)));
    await expectTitles(page, [NEEDLES[1], NEEDLES[0]], { total: 2 });
    await expectNativeResetFields(page, from);

    await liveInstall(page, pathOf(sized(scopedParams(s), to)));
    await expectTitles(page, [NEEDLES[1], NEEDLES[0]], { total: 2 });
    expect(query(page).get('asset')).toBe(String(s.assetId));
    await expectNativeResetFields(page, to);

    await loseEnhancement(page);
    const submitted = await nativeReset(page);
    expectNativeResetDestination(submitted, to);
    await expectResetPage(page, s, to);
    expect(control.defaultsPosts()).toEqual([]);
    expect(control.posts).toEqual([]);
    expect(control.errors).toEqual([]);
  });
}

test('successful Back/Forward install their sizes; native Reset then uses the Forward size (50)', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  const ten = releasesUrl(fixture.baseURL, { sort: 'title', order: 'asc', pageSize: 10 });
  await start(page, ten);
  await expectNativeResetFields(page, 10);
  await liveInstall(page, pathOf({ sort: 'title', order: 'asc', pageSize: 50 }));
  await expectNativeResetFields(page, 50);
  const fifty = page.url();

  // Back: a live history install of size 10 (no reload, no extra entry).
  let gets = control.gets.length;
  await page.goBack();
  await settled(page);
  await expect.poll(() => page.url()).toBe(ten);
  await expectTitles(page, ALL_TITLES.slice(0, 10), { total: 60 });
  expect(control.gets.length).toBe(gets + 1);
  await expectNativeResetFields(page, 10);

  gets = control.gets.length;
  await page.goForward();
  await settled(page);
  await expect.poll(() => page.url()).toBe(fifty);
  await expectTitles(page, ALL_TITLES.slice(0, 50), { total: 60 });
  expect(control.gets.length).toBe(gets + 1);
  await expectNativeResetFields(page, 50);

  await loseEnhancement(page);
  const submitted = await nativeReset(page);
  expectNativeResetDestination(submitted, 50);
  await expectResetPage(page, s, 50);

  // The native Reset added one document entry: Back returns to size 50.
  await page.goBack();
  await expect.poll(() => page.url()).toBe(fifty);
  await expectTitles(page, ALL_TITLES.slice(0, 50), { total: 60 });
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('a superseded response delivered last and a held then failed Back never update the native form', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  await start(page, releasesUrl(fixture.baseURL, { sort: 'title', order: 'asc', pageSize: 50 }));
  const tenPath = pathOf({ sort: 'title', order: 'asc', pageSize: 10 });
  await liveInstall(page, tenPath);
  await expectNativeResetFields(page, 10);

  // Hold live GETs of size 100 and (later) size 10 until released.
  const held = [];
  let holdTen = false;
  await page.route((url) => url.pathname === '/releases'
    && (url.searchParams.get('pageSize') === '100' || (holdTen && url.searchParams.get('pageSize') === '10')), (route) => {
    if (route.request().resourceType() !== 'fetch') return route.fallback();
    held.push(route);
    return undefined;
  });

  // A size-100 GET is held, then superseded by a size-25 GET that installs.
  await liveNavigate(page, pathOf({ sort: 'title', order: 'asc', pageSize: 100 }));
  await expect.poll(() => held.length).toBe(1);
  await expectNativeResetFields(page, 10);
  await liveInstall(page, pathOf({ sort: 'title', order: 'asc' }));
  await expectNativeResetFields(page, 25);
  // The older response is released last: nothing installs it.
  await held[0].continue().catch(() => {});
  await expect(page.locator('[data-releases-live-region]')).not.toHaveAttribute('aria-busy', 'true');
  await expectTitles(page, ALL_TITLES.slice(0, 25), { total: 60 });
  await expectNativeResetFields(page, 25);

  // Back to the size-10 entry: a live history GET, held (pending), then failed.
  holdTen = true;
  await page.goBack();
  await expect.poll(() => held.length).toBe(2);
  await expectNativeResetFields(page, 25);
  await held[1].abort('failed');
  await expect(page.locator('[data-live-filter-failure]')).toHaveCount(1);
  await expectTitles(page, ALL_TITLES.slice(0, 25), { total: 60 });
  await expectNativeResetFields(page, 25);
  await page.unrouteAll({ behavior: 'ignoreErrors' });

  await loseEnhancement(page);
  const submitted = await nativeReset(page);
  expectNativeResetDestination(submitted, 25);
  await expectResetPage(page, s, 25);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.posts).toEqual([]);
});

test('GET-only Retry of a failed size change installs it and updates the native form', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  await start(page, releasesUrl(fixture.baseURL, { sort: 'title', order: 'asc', pageSize: 50 }));
  let failNext = true;
  await page.route((url) => url.pathname === '/releases' && url.searchParams.get('pageSize') === '10', async (route) => {
    if (failNext && route.request().resourceType() === 'fetch') {
      failNext = false;
      await route.abort('failed');
      return;
    }
    await route.fallback();
  });
  const target = pathOf({ sort: 'title', order: 'asc', pageSize: 10 });
  await liveNavigate(page, target);
  const notice = page.locator('[data-live-filter-failure]');
  await expect(notice).toHaveCount(1);
  await expectTitles(page, ALL_TITLES.slice(0, 50), { total: 60 });
  await expectNativeResetFields(page, 50);

  const retried = page.waitForRequest((request) => request.resourceType() === 'fetch'
    && new URL(request.url()).searchParams.get('pageSize') === '10');
  await notice.getByRole('button', { name: 'Retry' }).click();
  expect((await retried).method()).toBe('GET');
  await settled(page);
  await expect(notice).toHaveCount(0);
  await expectTitles(page, ALL_TITLES.slice(0, 10), { total: 60 });
  await expectNativeResetFields(page, 10);

  await loseEnhancement(page);
  expectNativeResetDestination(await nativeReset(page), 10);
  await expectResetPage(page, s, 10);
  expect(control.posts).toEqual([]);
});

test('enhanced Reset (valid authority) and reload keep using the server-rendered size', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  await start(page, releasesUrl(fixture.baseURL, sized(scopedParams(s), 50)));
  await liveInstall(page, pathOf(sized(scopedParams(s), 10)));

  // Enhanced Reset: one live GET to the authority destination.
  await openDialog(page);
  const requested = page.waitForRequest((request) => request.resourceType() === 'fetch'
    && new URL(request.url()).pathname === '/releases' && !new URL(request.url()).searchParams.has('asset'));
  await dialog(page).locator('[data-releases-filters-reset]').click();
  expectNativeResetDestination(new URL((await requested).url()), 10);
  await settled(page);
  await expectResetPage(page, s, 10);

  await page.reload();
  await enhanced(page);
  await expectResetPage(page, s, 10);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('no live enhancement from the initial load: the server-rendered native form submits the URL size', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  await page.addInitScript(() => { window.DOMParser = undefined; });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(releasesUrl(fixture.baseURL, sized(scopedParams(s), 50)));
  await expect(page.locator('[data-releases-defaults-save]')).toBeEnabled();
  await expectTitles(page, [NEEDLES[1], NEEDLES[0]], { total: 2 });
  await expectNativeResetFields(page, 50);

  const submitted = await nativeReset(page);
  expectNativeResetDestination(submitted, 50);
  await expectResetPage(page, s, 50);
  expect(control.gets).toEqual([]);
  expect(control.posts).toEqual([]);
});

test('JavaScript disabled: the native Reset form is rendered with the URL size only', async ({ browser }) => {
  const s = seed();
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  for (const [pageSize, expected] of [[50, [['hidden', '50', false]]], [25, []], [10, [['hidden', '10', false]]]]) {
    await page.goto(releasesUrl(fixture.baseURL, sized(scopedParams(s), pageSize)));
    expect(await nativeResetFields(page)).toEqual(expected);
    expect(await page.locator('form.releases-filter-reset').evaluate((form) => [form.method, new URL(form.action).pathname]))
      .toEqual(['get', '/releases']);
  }
  await context.close();
});
