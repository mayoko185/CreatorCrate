import { expect, test } from '@playwright/test';
import {
  checkedValues, closeDialog, createReleasesFixture, dialog, enhanced, expectRepeated, expectTitles, openDialog, query,
  releasesUrl, settled, summaryText, watch,
} from './releases-filters-defaults-fixture.js';

// R7: a Releases filter edit made while Reset filters is held or failed
// composes with the Reset destination: only the edited dimension changes.
// Projects, Project Types, Schedule, Include archived, the exact-asset scope
// and an obsolete Sort/Order are never re-serialized from the installed form.

const fixture = createReleasesFixture('releases-r7-reset-intent');

test.beforeAll(async () => {
  await fixture.start();
});

test.afterAll(async () => {
  await fixture.stop();
});

// Saved defaults Title / Ascending. Planned dates make Planned / Descending
// order the two Needle releases the other way round, so the installed order
// shows which Sort/Order applied.
function seed() {
  fixture.isolate();
  fixture.writePageDefault('releases', 'sort', 'title');
  fixture.writePageDefault('releases', 'order', 'asc');
  const comic = fixture.project('R7 Comic', { projectType: 'comic' });
  const images = fixture.project('R7 Images', { projectType: 'images' });
  return {
    comic,
    images,
    needleComic: fixture.release(comic, 'Needle Comic', { plannedDate: '2026-01-10' }),
    needleImages: fixture.release(images, 'Needle Images', { plannedDate: '2026-12-10' }),
    other: fixture.release(comic, 'Zulu other'),
  };
}

const NEEDLES = ['Needle Comic', 'Needle Images'];
const RESTRICTIONS = ['project', 'type', 'schedule', 'includeArchived', 'asset'];

async function start(page, url) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(url);
  await enhanced(page);
}

function isResetRequest(url) {
  return url.pathname === '/releases'
    && RESTRICTIONS.every((key) => !url.searchParams.has(key)) && !url.searchParams.has('search');
}

/**
 * Holds (or fails) the live Reset filters GET only: a fetch for /releases with
 * no restriction and no Search. `seen` resolves when the Reset GET was sent.
 */
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
    markSeen();
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

function waitForSearchRequest(page, value, extra = () => true) {
  return page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === '/releases' && request.resourceType() === 'fetch'
      && url.searchParams.get('search') === value && extra(url);
  });
}

function expectNoRestrictions(url) {
  RESTRICTIONS.forEach((key) => expect(url.searchParams.has(key), key).toBe(false));
}

async function clickResetFilters(page) {
  await dialog(page).locator('[data-releases-filters-reset]').click();
}

async function frame(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
}

test('reviewer reproduction: Reset held -> Search Needle keeps Reset semantics; both Needle releases appear', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  await start(page, releasesUrl(fixture.baseURL, {
    project: s.comic.id, type: 'comic', sort: 'planned', order: 'desc', pageSize: 10,
  }));
  await expectTitles(page, [s.other.title, s.needleComic.title], { sorted: true });

  const reset = await controlReset(page);
  await openDialog(page);
  await clickResetFilters(page);
  await reset.seen;
  // The dialog shows the Reset destination while its GET is held.
  await expect(page.locator('#releases-search')).toHaveValue('');
  expect(await checkedValues(page, 'release-project-filter')).toEqual(['']);
  expect(await checkedValues(page, 'release-type-filter')).toEqual(['']);
  expect(await summaryText(page, 'list-sort')).toBe('Title');
  expect(await summaryText(page, 'list-order')).toBe('Ascending');

  const searched = waitForSearchRequest(page, 'Needle');
  await page.locator('#releases-search').fill('Needle');
  const requested = new URL((await searched).url());
  expectNoRestrictions(requested);
  expect(requested.searchParams.get('pageSize')).toBe('10');
  expect(requested.searchParams.has('page')).toBe(false);
  // Sort/Order are left to the server's saved defaults, never the obsolete
  // installed Planned / Descending.
  expect(requested.searchParams.get('sort') ?? 'title').toBe('title');
  expect(requested.searchParams.get('order') ?? 'asc').toBe('asc');
  await settled(page);

  await expectTitles(page, NEEDLES, { total: 2 });
  expect(query(page).get('search')).toBe('Needle');
  expect(query(page).get('pageSize')).toBe('10');
  expectNoRestrictions(new URL(page.url()));
  expect(query(page).get('sort') ?? 'title').toBe('title');
  expect(query(page).get('order') ?? 'asc').toBe('asc');
  await expect(page.locator('#releases-search')).toHaveValue('Needle');
  expect(await checkedValues(page, 'release-project-filter')).toEqual(['']);
  expect(await checkedValues(page, 'release-type-filter')).toEqual(['']);
  expect(await summaryText(page, 'list-sort')).toBe('Title');
  expect(await summaryText(page, 'list-order')).toBe('Ascending');

  // The older Reset response is released last: nothing changes.
  const composed = page.url();
  reset.release();
  await reset.done;
  await frame(page);
  expect(page.url()).toBe(composed);
  await expectTitles(page, NEEDLES, { total: 2 });
  await expect(page.locator('#releases-search')).toHaveValue('Needle');
  await expect(page.locator('[data-live-filter-failure]')).toHaveCount(0);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('failed Reset -> Search fails too -> GET-only Retry repeats the composed Search', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  await start(page, releasesUrl(fixture.baseURL, {
    project: s.comic.id, type: 'comic', sort: 'planned', order: 'desc', pageSize: 10,
  }));
  const reset = await controlReset(page, { fail: true });
  await openDialog(page);
  await clickResetFilters(page);
  await reset.done;
  const notice = page.locator('[data-live-filter-failure]');
  await expect(notice).toHaveCount(1);
  // The installed results stay; the controls keep the Reset intent.
  await expectTitles(page, [s.other.title, s.needleComic.title], { sorted: true });
  expect(await checkedValues(page, 'release-project-filter')).toEqual(['']);

  let failSearch = true;
  await page.route((url) => url.pathname === '/releases' && url.searchParams.get('search') === 'Needle', async (route) => {
    if (failSearch && route.request().resourceType() === 'fetch') {
      failSearch = false;
      await route.abort('failed');
      return;
    }
    await route.fallback();
  });
  const searched = waitForSearchRequest(page, 'Needle');
  await page.locator('#releases-search').fill('Needle');
  const requested = new URL((await searched).url());
  expectNoRestrictions(requested);
  expect(requested.searchParams.get('pageSize')).toBe('10');
  await expect(notice).toHaveCount(1);

  const retried = waitForSearchRequest(page, 'Needle');
  await notice.getByRole('button', { name: 'Retry' }).click();
  expect((await retried).url()).toBe(requested.href);
  await settled(page);
  await expectTitles(page, NEEDLES, { total: 2 });
  expectNoRestrictions(new URL(page.url()));
  await expect(notice).toHaveCount(0);
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('Reset held -> a Project choice restricts only Projects; the cleared Type and Search stay cleared', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  await start(page, releasesUrl(fixture.baseURL, {
    project: s.comic.id, type: 'comic', search: 'Zulu', sort: 'planned', order: 'desc', pageSize: 10,
  }));
  await expectTitles(page, [s.other.title]);
  const reset = await controlReset(page);
  await openDialog(page);
  await clickResetFilters(page);
  await reset.seen;

  const chosen = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === '/releases' && url.searchParams.has('project');
  });
  const details = page.locator('#release-project-filter');
  await details.locator('summary').click();
  await details.locator('.asset-filter-multiselect-option label').getByText(s.images.title, { exact: true }).click();
  const requested = new URL((await chosen).url());
  expectRepeated(requested.href, 'project', [s.images.id]);
  ['type', 'schedule', 'includeArchived', 'asset', 'search'].forEach((key) => expect(requested.searchParams.has(key), key).toBe(false));
  expect(requested.searchParams.get('sort') ?? 'title').toBe('title');
  await settled(page);
  await expectTitles(page, [s.needleImages.title]);
  expect(await checkedValues(page, 'release-type-filter')).toEqual(['']);
  await expect(page.locator('#releases-search')).toHaveValue('');

  reset.release();
  await reset.done;
  await frame(page);
  await expectTitles(page, [s.needleImages.title]);
  expect(control.posts).toEqual([]);
});

test('exact-asset Reset held -> Search never restores the asset scope', async ({ page }) => {
  const s = seed();
  const assetId = fixture.asset(s.comic, 'r7-scoped.png');
  fixture.addAsset(s.needleComic, assetId);
  fixture.addAsset(s.other, assetId);
  const control = watch(page);
  await start(page, releasesUrl(fixture.baseURL, { asset: assetId, sort: 'planned', order: 'desc', pageSize: 10 }));
  await expectTitles(page, [s.other.title, s.needleComic.title], { sorted: true });
  const reset = await controlReset(page);
  await openDialog(page);
  await expect(dialog(page).locator('[data-releases-asset-scope]')).toBeVisible();
  await clickResetFilters(page);
  await reset.seen;
  await expect(dialog(page).locator('[data-releases-asset-scope]')).toBeHidden();

  const searched = waitForSearchRequest(page, 'Needle');
  await page.locator('#releases-search').fill('Needle');
  const requested = new URL((await searched).url());
  expectNoRestrictions(requested);
  await settled(page);
  await expectTitles(page, NEEDLES, { total: 2 });
  expect(query(page).has('asset')).toBe(false);
  await expect(page.locator('[data-releases-live-region] .results-meta')).not.toContainText('containing asset');
  await expect(dialog(page).locator('[data-releases-asset-scope]')).toHaveCount(0);
  reset.release();
  await reset.done;
  await frame(page);
  await expectTitles(page, NEEDLES, { total: 2 });
  expect(control.posts).toEqual([]);
});

test('Reset held -> Search held -> page 2 is page 2 of the composed Needle results', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  await start(page, releasesUrl(fixture.baseURL, {
    project: s.comic.id, type: 'comic', sort: 'planned', order: 'desc', pageSize: 1,
  }));
  await expect(page.locator('[data-releases-live-region] .pagination-info')).toHaveText('Page 1 of 2');
  const reset = await controlReset(page);
  let releaseSearch;
  const searchHeld = new Promise((resolve) => { releaseSearch = resolve; });
  await page.route((url) => url.pathname === '/releases' && url.searchParams.get('search') === 'Needle'
    && !url.searchParams.has('page'), async (route) => {
    await searchHeld;
    await route.continue().catch(() => {});
  });
  await openDialog(page);
  await clickResetFilters(page);
  await reset.seen;
  const searched = waitForSearchRequest(page, 'Needle');
  await page.locator('#releases-search').fill('Needle');
  await searched;
  await closeDialog(page);

  const paged = page.waitForRequest((request) => new URL(request.url()).searchParams.get('page') === '2');
  await page.locator('[data-releases-live-region] .pagination').getByRole('link', { name: 'Next', exact: true }).click();
  const requested = new URL((await paged).url());
  expect(requested.searchParams.get('search')).toBe('Needle');
  expect(requested.searchParams.get('pageSize')).toBe('1');
  expectNoRestrictions(requested);
  await settled(page);
  await expectTitles(page, [s.needleImages.title], { total: 2 });
  await expect(page.locator('[data-releases-live-region] .pagination-info')).toHaveText('Page 2 of 2');

  const composed = page.url();
  releaseSearch();
  reset.release();
  await reset.done;
  await frame(page);
  expect(page.url()).toBe(composed);
  await expectTitles(page, [s.needleImages.title], { total: 2 });
  expect(control.posts).toEqual([]);
});

test('Back during a held Reset owns every dimension again; a Search then composes with that entry', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  const first = releasesUrl(fixture.baseURL, { project: s.comic.id, type: 'comic', sort: 'planned', order: 'desc', pageSize: 10 });
  await start(page, first);
  const firstShown = page.url();
  await openDialog(page);
  await page.locator('#list-includeArchived').check();
  await settled(page);
  expect(query(page).get('includeArchived')).toBe('1');
  await closeDialog(page);

  const reset = await controlReset(page);
  await openDialog(page);
  await clickResetFilters(page);
  await reset.seen;
  await closeDialog(page);
  await page.goBack();
  await settled(page);
  await expect.poll(() => page.url()).toBe(firstShown);
  await openDialog(page);
  expect(await checkedValues(page, 'release-project-filter')).toEqual([String(s.comic.id)]);
  expect(await checkedValues(page, 'release-type-filter')).toEqual(['comic']);
  await expect(page.locator('#list-includeArchived')).not.toBeChecked();

  const searched = waitForSearchRequest(page, 'Needle');
  await page.locator('#releases-search').fill('Needle');
  const requested = new URL((await searched).url());
  expectRepeated(requested.href, 'project', [s.comic.id]);
  expectRepeated(requested.href, 'type', ['comic']);
  expect(requested.searchParams.has('includeArchived')).toBe(false);
  expect(requested.searchParams.get('sort')).toBe('planned');
  expect(requested.searchParams.get('order')).toBe('desc');
  await settled(page);
  await expectTitles(page, [s.needleComic.title]);

  reset.release();
  await reset.done;
  await frame(page);
  await expectTitles(page, [s.needleComic.title]);
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});
