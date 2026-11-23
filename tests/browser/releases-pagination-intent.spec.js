import { expect, test } from '@playwright/test';
import {
  closeDialog, createReleasesFixture, dialog, enhanced, expectRepeated, expectTitles, openDialog, query, releasesUrl,
  settled, watch,
} from './releases-filters-defaults-fixture.js';

// R1: a Releases pagination click while a results Search (or another filter
// edit) is debounced or its GET is still held composes the clicked page with
// the latest intended filters, never the stale rendered link address.

const fixture = createReleasesFixture('releases-r1-pagination');

test.beforeAll(async () => {
  await fixture.start();
});

test.afterAll(async () => {
  await fixture.stop();
});

// Sorted by title: unfiltered page 2 ("Bravo other") differs from the
// Needle-filtered page 2 ("Needle 2").
function seed() {
  fixture.isolate();
  const comicA = fixture.project('Pag Comic A', { projectType: 'comic' });
  const comicB = fixture.project('Pag Comic B', { projectType: 'comic' });
  return {
    comicA,
    comicB,
    alpha: fixture.release(comicA, 'Alpha other'),
    bravo: fixture.release(comicB, 'Bravo other'),
    needle1: fixture.release(comicA, 'Needle 1'),
    needle2: fixture.release(comicB, 'Needle 2'),
    needle3: fixture.release(comicA, 'Needle 3'),
  };
}

async function start(page, url) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(url);
  await enhanced(page);
}

// clock.install() alone keeps the page clock running in real time; pausing it
// holds every page timer (the Search debounce included) until runFor().
async function pausePageClock(page) {
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(now + 1000);
}

function nextLink(page) {
  return page.locator('[data-releases-live-region] .pagination').getByRole('link', { name: 'Next', exact: true });
}

function paginationInfo(page) {
  return page.locator('[data-releases-live-region] .pagination-info');
}

test('a held Search GET, dialog closed, then page 2: page 2 of the Needle results; the older response never installs', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let heldDone;
  const heldFinished = new Promise((resolve) => { heldDone = resolve; });
  await page.route((url) => url.pathname === '/releases' && url.searchParams.get('search') === 'Needle'
    && !url.searchParams.has('page'), async (route) => {
    await held;
    await route.continue().catch(() => {});
    heldDone();
  });
  await start(page, releasesUrl(fixture.baseURL, {
    project: [s.comicA.id, s.comicB.id], type: 'comic', sort: 'title', order: 'asc', pageSize: 1,
  }));
  await expectTitles(page, [s.alpha.title], { total: 5 });

  await openDialog(page);
  await page.locator('#releases-search').fill('Needle');
  await expect(page.locator('[data-releases-live-region]')).toHaveAttribute('aria-busy', 'true');
  await closeDialog(page);
  // The installed (unfiltered) results are still shown under the held GET.
  await expectTitles(page, [s.alpha.title], { total: 5 });

  const paged = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === '/releases' && url.searchParams.get('page') === '2';
  });
  await nextLink(page).click();
  const requested = new URL((await paged).url());
  expect(requested.searchParams.get('search')).toBe('Needle');
  expect(requested.searchParams.get('page')).toBe('2');
  expect(requested.searchParams.get('pageSize')).toBe('1');
  expect(requested.searchParams.get('sort')).toBe('title');
  expect(requested.searchParams.get('order')).toBe('asc');
  expectRepeated(requested.href, 'project', [s.comicA.id, s.comicB.id]);
  expectRepeated(requested.href, 'type', ['comic']);
  await settled(page);

  await expectTitles(page, [s.needle2.title], { total: 3 });
  await expect(paginationInfo(page)).toHaveText('Page 2 of 3');
  expect(query(page).get('search')).toBe('Needle');
  expect(query(page).get('page')).toBe('2');
  expect(query(page).get('pageSize')).toBe('1');
  expectRepeated(page.url(), 'project', [s.comicA.id, s.comicB.id]);
  await openDialog(page);
  await expect(page.locator('#releases-search')).toHaveValue('Needle');
  await closeDialog(page);

  // The older Search response is released last: nothing changes.
  const composedUrl = page.url();
  release();
  await heldFinished;
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
  expect(page.url()).toBe(composedUrl);
  await expectTitles(page, [s.needle2.title], { total: 3 });
  await expect(paginationInfo(page)).toHaveText('Page 2 of 3');
  await expect(page.locator('[data-live-filter-failure]')).toHaveCount(0);

  // Back returns to the page shown before the composed navigation.
  await page.goBack();
  await settled(page);
  await expect.poll(() => query(page).has('search')).toBe(false);
  await expectTitles(page, [s.alpha.title], { total: 5 });
  await page.goForward();
  await settled(page);
  await expect.poll(() => page.url()).toBe(composedUrl);
  await expectTitles(page, [s.needle2.title], { total: 3 });

  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('a Search still in its debounce interval, then page 2: one GET for page 2 of the Needle results', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  // The page's timers are under test control, so the debounce cannot fire
  // between the Search edit and the pagination click.
  await page.clock.install();
  await start(page, releasesUrl(fixture.baseURL, { sort: 'title', order: 'asc', pageSize: 1 }));
  await expectTitles(page, [s.alpha.title], { total: 5 });
  await pausePageClock(page);
  const before = control.gets.length;

  await openDialog(page);
  await page.locator('#releases-search').fill('Needle');
  await closeDialog(page);
  expect(control.gets.length).toBe(before);
  await nextLink(page).click();
  await settled(page);

  const sent = control.gets.slice(before);
  expect(sent).toHaveLength(1);
  expect(sent[0].searchParams.get('search')).toBe('Needle');
  expect(sent[0].searchParams.get('page')).toBe('2');
  expect(sent[0].searchParams.get('pageSize')).toBe('1');
  await expectTitles(page, [s.needle2.title], { total: 3 });
  await expect(paginationInfo(page)).toHaveText('Page 2 of 3');

  // The superseded debounce never sends its own (page-one) GET.
  await page.clock.runFor(2000);
  await settled(page);
  expect(control.gets.slice(before)).toHaveLength(1);
  expect(query(page).get('search')).toBe('Needle');
  expect(query(page).get('page')).toBe('2');
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('an exact-asset scope is kept with a pending Search across pagination', async ({ page }) => {
  const s = seed();
  const assetId = fixture.asset(s.comicA, 'r1-shared.png');
  // Exact-asset membership is limited to the asset's own Project: Alpha,
  // Needle 1 and Needle 3 (unfiltered page 2 would be Needle 1).
  [s.alpha, s.needle1, s.needle3].forEach((record) => fixture.addAsset(record, assetId));
  await page.clock.install();
  await start(page, releasesUrl(fixture.baseURL, { asset: assetId, sort: 'title', order: 'asc', pageSize: 1 }));
  await expectTitles(page, [s.alpha.title], { total: 3 });
  await pausePageClock(page);

  await openDialog(page);
  await page.locator('#releases-search').fill('Needle');
  await closeDialog(page);
  await nextLink(page).click();
  await settled(page);
  expect(query(page).get('asset')).toBe(String(assetId));
  expect(query(page).get('search')).toBe('Needle');
  expect(query(page).get('page')).toBe('2');
  await expectTitles(page, [s.needle3.title], { total: 2 });
  await expect(paginationInfo(page)).toHaveText('Page 2 of 2');
  await expect(dialog(page)).toBeHidden();
});
