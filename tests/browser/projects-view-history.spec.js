import { expect, test } from '@playwright/test';
import {
  checkedValues, choose, closeDialog, createProjectsFixture, enhanced, expectListing, expectRepeated,
  openDialog, openDropdown, projectsUrl, query, renderedIds, settled, totalCount, watch,
} from './projects-filters-defaults-fixture.js';

// WP10b F6: a Projects live navigation whose FINAL canonical address is the
// address already shown must not add a duplicate browser-history entry, while
// every navigation to a genuinely different address still adds one.

const fixture = createProjectsFixture('projects-view-history');

test.beforeAll(async () => {
  await fixture.start();
});

test.afterAll(async () => {
  await fixture.stop();
});

function seed() {
  fixture.isolate();
  const alpha = fixture.project('Hist Alpha', { status: 'planned', projectType: 'comic' });
  const beta = fixture.project('Hist Beta', { status: 'ready', projectType: 'images' });
  const gamma = fixture.project('Hist Gamma', { status: 'planned', projectType: 'images' });
  return { alpha, beta, gamma, all: [alpha.id, beta.id, gamma.id] };
}

async function start(page, url = `${fixture.baseURL}/projects`) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(url);
  await enhanced(page);
}

const historyLength = (page) => page.evaluate(() => history.length);
const listShown = (page) => page.locator('[data-projects-list-table]');
const gridShown = (page) => page.locator('[data-projects-live-region] .project-grid');
const sortedIds = async (page) => (await renderedIds(page)).sort((a, b) => a - b);

async function expectView(page, view) {
  if (view === 'list') {
    await expect(listShown(page)).toBeVisible();
    await expect(gridShown(page)).toHaveCount(0);
  } else {
    await expect(gridShown(page)).toBeVisible();
    await expect(listShown(page)).toHaveCount(0);
  }
  await openDialog(page);
  expect(await checkedValues(page, 'project-view-filter')).toEqual([view]);
  await closeDialog(page);
}

async function clickView(page, name) {
  await page.getByRole('link', { name: `${name} view`, exact: true }).click();
}

/** Holds live Projects GETs matching `predicate` until released (or failed). */
async function holdGets(page, predicate) {
  const held = [];
  await page.route((url) => url.pathname === '/projects', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.resourceType() !== 'fetch' || request.method() !== 'GET' || !predicate(url)) {
      await route.fallback();
      return;
    }
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    held.push({ url, release });
    const mode = await gate;
    try {
      if (mode === 'fail') await route.fulfill({ status: 500, contentType: 'text/html', body: 'Held failure' });
      else await route.continue();
    } catch {
      // The page aborted the superseded request.
    }
  });
  return held;
}

async function pickPending(page, id, label) {
  const details = await openDropdown(page, id);
  await details.locator('.asset-filter-multiselect-option label').getByText(label, { exact: true }).first().click();
  await details.locator('summary').click();
  await expect(details).toHaveJSProperty('open', false);
}

test('F6-A/J: Grid → held List → Grid adds no entry and the late List response never installs', async ({ page }) => {
  const { all } = seed();
  const control = watch(page);
  await start(page);
  await expectListing(page, all);
  const original = page.url();
  const historyBefore = await historyLength(page);

  const held = await holdGets(page, (url) => url.searchParams.get('view') === 'list');
  await clickView(page, 'List');
  await expect.poll(() => held.length).toBe(1);
  await clickView(page, 'Grid');
  await settled(page);
  // J: the superseded List response is released last and must not install.
  held[0].release();
  await expect.poll(() => control.gets.length).toBe(2);
  await settled(page);

  expect(page.url()).toBe(original);
  expect(await historyLength(page)).toBe(historyBefore);
  expect(await sortedIds(page)).toEqual([...all].sort((a, b) => a - b));
  expect(await totalCount(page)).toBe(all.length);
  await expectView(page, 'grid');
  expect(control.gets.map((url) => url.searchParams.get('view'))).toEqual(['list', null]);
  await page.unrouteAll({ behavior: 'ignoreErrors' });

  // A later genuine change is still one meaningful entry, and Back returns
  // to the original Grid state (not a duplicate copy of it).
  await clickView(page, 'List');
  await settled(page);
  await expectView(page, 'list');
  expect(await historyLength(page)).toBe(historyBefore + 1);
  await page.goBack();
  await settled(page);
  expect(page.url()).toBe(original);
  await expectView(page, 'grid');
  await expectListing(page, all);

  await page.reload();
  await enhanced(page);
  expect(page.url()).toBe(original);
  await expectListing(page, all);
  await expectView(page, 'grid');
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('F6-B: genuine Grid → List adds exactly one entry', async ({ page }) => {
  const { all } = seed();
  const control = watch(page);
  await start(page);
  const historyBefore = await historyLength(page);
  await clickView(page, 'List');
  await settled(page);
  expect(query(page).get('view')).toBe('list');
  expect(await historyLength(page)).toBe(historyBefore + 1);
  await expectListing(page, all);
  await expectView(page, 'list');
  expect(control.errors).toEqual([]);
});

test('F6-C: genuine List → Grid adds exactly one entry', async ({ page }) => {
  const { all } = seed();
  const control = watch(page);
  await start(page, projectsUrl(fixture.baseURL, [], { view: 'list' }));
  await expectView(page, 'list');
  const historyBefore = await historyLength(page);
  await clickView(page, 'Grid');
  await settled(page);
  expect(query(page).get('view')).toBeNull();
  expect(await historyLength(page)).toBe(historyBefore + 1);
  await expectListing(page, all);
  await expectView(page, 'grid');
  expect(control.errors).toEqual([]);
});

test('F6-D/I: installed Grid → List → Grid keeps both entries and Back/Forward walk real states', async ({ page }) => {
  const { all } = seed();
  await start(page);
  const grid = page.url();
  const historyBefore = await historyLength(page);

  await clickView(page, 'List');
  await settled(page);
  await expectView(page, 'list');
  const list = page.url();
  expect(list).not.toBe(grid);
  await clickView(page, 'Grid');
  await settled(page);
  await expectView(page, 'grid');
  // The address equals one shown earlier, but not the one displayed: kept.
  expect(page.url()).toBe(grid);
  expect(await historyLength(page)).toBe(historyBefore + 2);

  await page.goBack();
  await settled(page);
  expect(page.url()).toBe(list);
  await expectView(page, 'list');
  await expectListing(page, all);
  await page.goBack();
  await settled(page);
  expect(page.url()).toBe(grid);
  await expectView(page, 'grid');
  await page.goForward();
  await settled(page);
  expect(page.url()).toBe(list);
  await expectView(page, 'list');
  await page.goForward();
  await settled(page);
  expect(page.url()).toBe(grid);
  await expectView(page, 'grid');
  expect(await historyLength(page)).toBe(historyBefore + 2);
});

test('F6-E: a pending Project filter followed by List and then Grid keeps the filter as one entry', async ({ page }) => {
  const { alpha, gamma, all } = seed();
  const control = watch(page);
  await start(page);
  await expectListing(page, all);
  const historyBefore = await historyLength(page);
  const held = await holdGets(page, () => true);
  await openDialog(page);
  await pickPending(page, 'project-project-filter', alpha.title);
  await pickPending(page, 'project-project-filter', gamma.title);
  await expect.poll(() => held.length).toBe(2);
  await closeDialog(page);

  await clickView(page, 'List');
  await expect.poll(() => held.length).toBe(3);
  await clickView(page, 'Grid');
  await expect.poll(() => held.length).toBe(4);
  // Newest first; every superseded GET is released afterwards.
  held[3].release();
  await settled(page);
  held.slice(0, 3).forEach((entry) => entry.release());
  await settled(page);
  await page.unrouteAll({ behavior: 'ignoreErrors' });

  // The filtered Grid differs from the unfiltered Grid shown: one entry.
  expectRepeated(page.url(), 'project', [alpha.id, gamma.id]);
  expect(query(page).get('view')).toBeNull();
  expect(await historyLength(page)).toBe(historyBefore + 1);
  await expectListing(page, [alpha.id, gamma.id]);
  await expectView(page, 'grid');
  expectRepeated(control.gets.at(-1).href, 'project', [alpha.id, gamma.id]);

  await page.goBack();
  await settled(page);
  expect(query(page).getAll('project')).toEqual([]);
  await expectListing(page, all);
});

test('F6-F: a debounced Search followed by List is one entry with the Search', async ({ page }) => {
  const { alpha, all } = seed();
  const control = watch(page);
  await start(page);
  await expectListing(page, all);
  const historyBefore = await historyLength(page);
  const before = control.gets.length;

  await page.clock.install();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await openDialog(page);
  await page.locator('#projects-search').fill('Alpha');
  await closeDialog(page);
  await clickView(page, 'List');
  await page.clock.resume();
  await settled(page);

  expect(control.gets.slice(before).map((url) => url.searchParams.get('view'))).toEqual(['list']);
  expect(query(page).get('search')).toBe('Alpha');
  expect(query(page).get('view')).toBe('list');
  expect(await historyLength(page)).toBe(historyBefore + 1);
  await expectListing(page, [alpha.id]);
  await expectView(page, 'list');
});

test('F6-G: following the active Grid link (same final address) adds no entry', async ({ page }) => {
  const { alpha, gamma } = seed();
  const control = watch(page);
  const shownUrl = projectsUrl(fixture.baseURL, [alpha.id, gamma.id], { sort: 'title', order: 'desc' });
  await start(page, shownUrl);
  await expectListing(page, [alpha.id, gamma.id]);
  const shown = page.url();
  const historyBefore = await historyLength(page);

  await clickView(page, 'Grid');
  await settled(page);
  expect(control.gets.length).toBe(1);
  expect(page.url()).toBe(shown);
  expect(await historyLength(page)).toBe(historyBefore);
  await expectListing(page, [alpha.id, gamma.id]);
  await expectView(page, 'grid');

  // Sort is a genuinely different state even though it renders the same rows.
  await page.goto(projectsUrl(fixture.baseURL, [alpha.id, gamma.id], { sort: 'title', order: 'asc' }));
  await enhanced(page);
  const ascending = await historyLength(page);
  await page.getByRole('link', { name: 'List view', exact: true }).click();
  await settled(page);
  expect(await historyLength(page)).toBe(ascending + 1);
  expect(query(page).get('order')).toBe('asc');
});

test('F6-H: a redirected Reset filters to the shown canonical address adds no entry', async ({ page }) => {
  const { alpha, beta, gamma, all } = seed();
  fixture.writePageDefault('projects', 'sort', 'title');
  const control = watch(page);
  await start(page);
  // The saved default canonicalizes the bare address by redirect.
  expect(query(page).get('sort')).toBe('title');
  await expectListing(page, all);
  const shown = page.url();
  const historyBefore = await historyLength(page);
  const before = control.gets.length;

  await openDialog(page);
  await page.locator('[data-projects-filters-reset]').click();
  await settled(page);
  // The bare request is answered by a redirect to the canonical address.
  expect(control.gets.slice(before).map((url) => `${url.pathname}${url.search}`))
    .toEqual(['/projects', `/projects${new URL(shown).search}`]);
  expect(page.url()).toBe(shown);
  expect(await historyLength(page)).toBe(historyBefore);
  await expectListing(page, all);
  expect(control.defaultsPosts()).toEqual([]);

  // Reset from a genuinely different (filtered) state is a meaningful entry
  // whose final address is the redirect target, not the bare request. The
  // dialog stays open after Reset filters.
  await choose(page, 'project-project-filter', beta.title);
  await expectListing(page, [beta.id]);
  const filtered = await historyLength(page);
  await page.locator('[data-projects-filters-reset]').click();
  await settled(page);
  expect(page.url()).toBe(shown);
  expect(await historyLength(page)).toBe(filtered + 1);
  await expectListing(page, all);
  expect([alpha.id, gamma.id].every((id) => id > 0)).toBe(true);
  expect(control.errors).toEqual([]);
});
