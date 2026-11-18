import { expect, test } from '@playwright/test';
import {
  checkedValues, choose, closeDialog, createLibraryFixture, dropdown, openDialog, openDropdown, query,
  renderedAssetIds, settled, totalText, watch,
} from './asset-library-filters-defaults-fixture.js';

/*
 * WP10b follow-up F4 — the Asset Library toolbar Grid/List links are rendered
 * against the installed page. A View click while a filter edit is still
 * debounced, in flight or failed must apply the clicked View to that newest
 * intended filter state, never navigate to the stale rendered address.
 * Requests are held or failed through route gates, never through sleeps.
 */

const fixture = createLibraryFixture('asset-library-pending-view');

test.beforeAll(async () => {
  await fixture.start();
});

test.afterAll(async () => {
  await fixture.stop();
});

// Five projects of four catalogue Project Types; 4 + 3 + 2 + 3 + 2 assets.
async function seed() {
  fixture.isolate();
  const comicA = await fixture.project('View Comic A', 'comic', ['ca1.png', 'ca2.png', 'ca3.png', 'ca4.jpg']);
  const images = await fixture.project('View Images', 'images', ['im1.png', 'im2.png', 'im3.png']);
  const animation = await fixture.project('View Animation', 'animation', ['an1.png', 'an2.png']);
  const comicB = await fixture.project('View Comic B', 'comic', ['cb1.png', 'cb2.png', 'cb3.jpg']);
  const wallpaper = await fixture.project('View Wallpaper', 'wallpaper', ['wp1.png', 'wp2.png']);
  return { comicA, images, animation, comicB, wallpaper };
}

const sorted = (values) => [...values].sort((left, right) => left - right);
const historyLength = (page) => page.evaluate(() => window.history.length);
const viewLink = (page, view) => page.locator(`nav.view-switcher a[aria-label$="${view === 'list' ? 'List' : 'Grid'} view"]`);
const nsfwToggle = (page) => page.locator('[data-asset-library-nsfw-toggle]');
const failureNotice = (page) => page.locator('[data-live-filter-failure]');
const sequenceIds = (page) => page.locator('[data-asset-library-viewer-sequence]')
  .evaluate((element) => JSON.parse(element.textContent || '[]').map((entry) => Number(entry.id ?? entry.assetId)));

async function expectPresentation(page, view) {
  const region = page.locator('[data-asset-library-live-region]');
  if (view === 'list') {
    await expect(region.locator('ul.asset-list')).toBeVisible();
    await expect(region.locator('ul.asset-grid')).toHaveCount(0);
  } else {
    await expect(region.locator('ul.asset-grid')).toBeVisible();
    await expect(region.locator('ul.asset-list')).toHaveCount(0);
  }
  await expect(viewLink(page, view)).toHaveAttribute('aria-current', 'page');
}

async function expectDialogView(page, view) {
  await openDialog(page);
  expect(await checkedValues(page, 'asset-view-filter')).toEqual([view]);
  await closeDialog(page);
}

async function gateFilterGets(page) {
  const control = { rules: [], requests: [] };
  await page.route((url) => url.pathname === '/asset-viewer', async (route) => {
    const request = route.request();
    if (request.method() !== 'GET' || request.resourceType() !== 'fetch') return route.continue();
    const url = new URL(request.url());
    control.requests.push(url);
    const index = control.rules.findIndex((rule) => rule.match(url));
    if (index === -1) return route.continue();
    const [rule] = control.rules.splice(index, 1);
    rule.arrived(url);
    const action = await rule.decision;
    try {
      if (action === 'fail') await route.fulfill({ status: 500, body: 'failed' });
      else await route.continue();
    } catch {
      // The page aborted this request when a newer navigation superseded it.
    }
    return undefined;
  });
  control.next = (match, { fail = false } = {}) => {
    const rule = { match };
    const arrival = new Promise((resolve) => { rule.arrived = resolve; });
    let decide;
    rule.decision = new Promise((resolve) => { decide = resolve; });
    if (fail) decide('fail');
    control.rules.push(rule);
    return { arrival, release: () => decide('continue') };
  };
  return control;
}

// Chooses a dropdown option without waiting for the filter GET it starts.
async function pick(page, id, label) {
  const details = await openDropdown(page, id);
  await details.locator('.asset-filter-multiselect-option label').getByText(label, { exact: true }).first().click();
  const current = dropdown(page, id);
  if (await current.evaluate((element) => element.open)) {
    await current.locator('summary').focus();
    await page.keyboard.press('Enter');
  }
  await expect(current).toHaveJSProperty('open', false);
}

const isView = (view) => (url) => url.searchParams.get('view') === view;
const hasTypes = (...types) => (url) => JSON.stringify(url.searchParams.getAll('type')) === JSON.stringify(types);

function expectRepeated(url, projectIds, types) {
  expect(sorted(url.searchParams.getAll('project').map(Number))).toEqual(sorted(projectIds));
  // Type order follows the catalogue order of the form; each value stays its own key.
  expect([...url.searchParams.getAll('type')].sort()).toEqual([...types].sort());
  expect(url.href).not.toMatch(/%2C/);
}

test('A + E: List during a pending Projects/Types GET keeps both repeated restrictions; history, reload and the stale GET agree', async ({ page }) => {
  const { comicA, images } = await seed();
  const control = watch(page);
  const expected = sorted([...comicA.assetIds, ...images.assetIds]);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.baseURL}/asset-viewer?project=${comicA.id}&project=${images.id}&type=comic&view=grid`);
  await expect.poll(() => totalText(page)).toBe('4 assets found');
  await expectPresentation(page, 'grid');
  const installedUrl = page.url();
  const startLength = await historyLength(page);
  const gates = await gateFilterGets(page);
  const pending = gates.next(hasTypes('images', 'comic'));

  await openDialog(page);
  await pick(page, 'asset-project-type-filter', 'Images');
  const pendingUrl = await pending.arrival;
  expectRepeated(pendingUrl, [comicA.id, images.id], ['images', 'comic']);
  await closeDialog(page);

  const listRequest = gates.next(isView('list'));
  await viewLink(page, 'list').click();
  const listUrl = await listRequest.arrival;
  // The View request carries the newest intent: both Projects, both Types.
  expectRepeated(listUrl, [comicA.id, images.id], ['images', 'comic']);
  expect(listUrl.searchParams.getAll('view')).toEqual(['list']);
  listRequest.release();
  await settled(page);

  await expect.poll(() => totalText(page)).toBe('7 assets found');
  expect(sorted(await renderedAssetIds(page))).toEqual(expected);
  expect(sorted(await sequenceIds(page))).toEqual(expected);
  await expectPresentation(page, 'list');
  expectRepeated(new URL(page.url()), [comicA.id, images.id], ['comic', 'images']);
  expect(query(page).get('view')).toBe('list');
  expect(await historyLength(page)).toBe(startLength + 1);
  const listedUrl = page.url();

  // The superseded filter GET is released last and cannot steal the page.
  pending.release();
  await page.waitForTimeout(300);
  expect(page.url()).toBe(listedUrl);
  expect(sorted(await renderedAssetIds(page))).toEqual(expected);
  await expectPresentation(page, 'list');
  await openDialog(page);
  expect(sorted((await checkedValues(page, 'asset-project-filter')).map(Number))).toEqual(sorted([comicA.id, images.id]));
  expect((await checkedValues(page, 'asset-project-type-filter')).sort()).toEqual(['comic', 'images']);
  expect(await checkedValues(page, 'asset-view-filter')).toEqual(['list']);
  await closeDialog(page);

  await page.reload();
  await expect.poll(() => totalText(page)).toBe('7 assets found');
  expect(sorted(await renderedAssetIds(page))).toEqual(expected);
  await expectPresentation(page, 'list');

  await page.goBack();
  await expect.poll(() => page.url()).toBe(installedUrl);
  await expect.poll(() => totalText(page)).toBe('4 assets found');
  expect(sorted(await renderedAssetIds(page))).toEqual(sorted(comicA.assetIds));
  await expectPresentation(page, 'grid');
  await expectDialogView(page, 'grid');

  await page.goForward();
  await expect.poll(() => page.url()).toBe(listedUrl);
  await expect.poll(() => totalText(page)).toBe('7 assets found');
  expect(sorted(await renderedAssetIds(page))).toEqual(expected);
  await expectPresentation(page, 'list');
  await expectDialogView(page, 'list');

  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('B: List during a debounced Search keeps the Search and both repeated restrictions', async ({ page }) => {
  const { comicA, images } = await seed();
  const control = watch(page);
  const searchGets = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.resourceType() === 'fetch' && url.pathname === '/asset-viewer'
      && !request.redirectedFrom() && url.searchParams.get('search') === 'im2') searchGets.push(url);
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.baseURL}/asset-viewer?project=${comicA.id}&project=${images.id}&type=comic&type=images&view=grid`);
  await expect.poll(() => totalText(page)).toBe('7 assets found');
  const startLength = await historyLength(page);
  await openDialog(page);

  // Type, close and click List within one task: the 350 ms Search debounce
  // cannot fire first, so the View click is what owns the Search.
  await page.evaluate(() => {
    const search = document.getElementById('asset-library-search');
    search.value = 'im2';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#asset-viewer-filter-dialog [data-dialog-close]').click();
    document.querySelector('nav.view-switcher a[aria-label$="List view"]').click();
  });
  await settled(page);

  await expect.poll(() => totalText(page)).toBe('1 asset found');
  expect(await renderedAssetIds(page)).toEqual([images.assetId('im2.png')]);
  expect(await sequenceIds(page)).toEqual([images.assetId('im2.png')]);
  await expectPresentation(page, 'list');
  expect(query(page).get('search')).toBe('im2');
  expectRepeated(new URL(page.url()), [comicA.id, images.id], ['comic', 'images']);
  expect(query(page).get('view')).toBe('list');
  expect(await historyLength(page)).toBe(startLength + 1);
  // The folded debounce never sends a second Search request.
  await page.waitForTimeout(500);
  expect(searchGets).toHaveLength(1);
  await openDialog(page);
  await expect(page.locator('#asset-library-search')).toHaveValue('im2');
  expect((await checkedValues(page, 'asset-project-type-filter')).sort()).toEqual(['comic', 'images']);
  expect(await checkedValues(page, 'asset-view-filter')).toEqual(['list']);
  await closeDialog(page);

  await page.reload();
  await expect.poll(() => totalText(page)).toBe('1 asset found');
  expect(await renderedAssetIds(page)).toEqual([images.assetId('im2.png')]);
  await expectPresentation(page, 'list');
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('C: List during a pending Release usage GET keeps Category, Presence, Tag, Extension and every restriction', async ({ page }) => {
  const { comicA, images } = await seed();
  const control = watch(page);
  const db = fixture.state.db;
  // Each excluded asset fails exactly one restriction.
  const category = db.prepare("INSERT INTO project_asset_categories (project_id, display_name, directory_slug) VALUES (?, 'F4 Renders', 'f4-renders')")
    .run(comicA.id).lastInsertRowid;
  db.prepare('UPDATE assets SET category_id = ? WHERE id = ?').run(category, comicA.assetId('ca1.png'));
  db.prepare('UPDATE assets SET is_present = 0 WHERE id = ?').run(comicA.assetId('ca2.png'));
  const release = db.prepare("INSERT INTO releases (project_id, title) VALUES (?, 'F4 Release')").run(comicA.id).lastInsertRowid;
  db.prepare('INSERT INTO release_assets (release_id, asset_id) VALUES (?, ?)').run(release, comicA.assetId('ca3.png'));
  const tags = fixture.state.app.locals.tagService;
  const keep = tags.listTags?.().find((tag) => (tag.display_name ?? tag.displayName) === 'F4 Keep')?.id
    ?? tags.createTag({ name: 'F4 Keep' }).id;
  for (const id of [...comicA.assetIds, images.assetId('im2.png'), images.assetId('im3.png')]) {
    fixture.state.app.locals.assetTagService.replaceAssetTags(id, [keep]);
  }
  const included = sorted([images.assetId('im2.png'), images.assetId('im3.png')]);
  const restrictions = `project=${comicA.id}&project=${images.id}&type=comic&type=images`
    + `&category=uncategorized&presence=present&tag=${keep}&extension=png`;

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.baseURL}/asset-viewer?${restrictions}&view=grid`);
  // ca3 (in a release) still matches before Release usage is restricted.
  await expect.poll(() => totalText(page)).toBe('3 assets found');
  expect(sorted(await renderedAssetIds(page))).toEqual(sorted([...included, comicA.assetId('ca3.png')]));
  const gates = await gateFilterGets(page);
  const pending = gates.next((url) => url.searchParams.get('usage') === 'unused');

  await openDialog(page);
  await pick(page, 'asset-usage-filter', 'Not used in releases');
  await pending.arrival;
  await closeDialog(page);
  const listRequest = gates.next(isView('list'));
  await viewLink(page, 'list').click();
  const listUrl = await listRequest.arrival;
  expectRepeated(listUrl, [comicA.id, images.id], ['comic', 'images']);
  expect(listUrl.searchParams.getAll('category')).toEqual(['uncategorized']);
  expect(listUrl.searchParams.get('presence')).toBe('present');
  expect(listUrl.searchParams.getAll('tag')).toEqual([String(keep)]);
  expect(listUrl.searchParams.getAll('extension')).toEqual(['png']);
  expect(listUrl.searchParams.get('usage')).toBe('unused');
  expect(listUrl.searchParams.get('view')).toBe('list');
  listRequest.release();
  await settled(page);
  pending.release();

  await expect.poll(() => totalText(page)).toBe('2 assets found');
  expect(sorted(await renderedAssetIds(page))).toEqual(included);
  await expectPresentation(page, 'list');
  const shown = query(page);
  expect(shown.getAll('category')).toEqual(['uncategorized']);
  expect(shown.get('presence')).toBe('present');
  expect(shown.getAll('tag')).toEqual([String(keep)]);
  expect(shown.getAll('extension')).toEqual(['png']);
  expect(shown.get('usage')).toBe('unused');
  await page.reload();
  await expect.poll(() => totalText(page)).toBe('2 assets found');
  expect(sorted(await renderedAssetIds(page))).toEqual(included);
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('D: Grid during a pending GET started in List keeps the restrictions and shows Grid', async ({ page }) => {
  const { comicA, images } = await seed();
  const control = watch(page);
  const expected = sorted([...comicA.assetIds, ...images.assetIds]);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.baseURL}/asset-viewer?project=${comicA.id}&project=${images.id}&type=comic&view=list`);
  await expect.poll(() => totalText(page)).toBe('4 assets found');
  await expectPresentation(page, 'list');
  const gates = await gateFilterGets(page);
  const pending = gates.next(hasTypes('images', 'comic'));

  await openDialog(page);
  await pick(page, 'asset-project-type-filter', 'Images');
  expect((await pending.arrival).searchParams.get('view')).toBe('list');
  await closeDialog(page);
  const gridRequest = gates.next(isView('grid'));
  await viewLink(page, 'grid').click();
  const gridUrl = await gridRequest.arrival;
  expectRepeated(gridUrl, [comicA.id, images.id], ['images', 'comic']);
  expect(gridUrl.searchParams.getAll('view')).toEqual(['grid']);
  gridRequest.release();
  await settled(page);
  pending.release();

  await expect.poll(() => totalText(page)).toBe('7 assets found');
  expect(sorted(await renderedAssetIds(page))).toEqual(expected);
  await expectPresentation(page, 'grid');
  expect(query(page).get('view')).toBe('grid');
  await expectDialogView(page, 'grid');

  // A later filter edit keeps the chosen View.
  await openDialog(page);
  await choose(page, 'asset-project-type-filter', 'Images');
  await expect.poll(() => query(page).getAll('type')).toEqual(['comic']);
  expect(query(page).get('view')).toBe('grid');
  await closeDialog(page);
  await expectPresentation(page, 'grid');
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('F: a failed View GET keeps the installed results coherent; Retry is GET-only and installs the intended filters plus View', async ({ page }) => {
  const { comicA, images } = await seed();
  const control = watch(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.baseURL}/asset-viewer?project=${comicA.id}&project=${images.id}&type=comic&view=grid`);
  await expect.poll(() => totalText(page)).toBe('4 assets found');
  const installedUrl = page.url();
  const gates = await gateFilterGets(page);
  const pending = gates.next(hasTypes('images', 'comic'));

  await openDialog(page);
  await pick(page, 'asset-project-type-filter', 'Images');
  await pending.arrival;
  await closeDialog(page);
  const failed = gates.next(isView('list'), { fail: true });
  await viewLink(page, 'list').click();
  const failedUrl = await failed.arrival;
  expectRepeated(failedUrl, [comicA.id, images.id], ['images', 'comic']);
  expect(failedUrl.searchParams.get('view')).toBe('list');
  pending.release();

  await expect(failureNotice(page)).toBeVisible();
  // The previous installed result stays, and the address does not claim success.
  expect(page.url()).toBe(installedUrl);
  expect(sorted(await renderedAssetIds(page))).toEqual(sorted(comicA.assetIds));
  await expectPresentation(page, 'grid');

  const retried = gates.next(isView('list'));
  await failureNotice(page).getByRole('button', { name: 'Retry' }).click();
  const retryUrl = await retried.arrival;
  expect(retryUrl.href).toBe(failedUrl.href);
  retried.release();
  await settled(page);
  await expect(failureNotice(page)).toHaveCount(0);
  await expect.poll(() => totalText(page)).toBe('7 assets found');
  expect(sorted(await renderedAssetIds(page))).toEqual(sorted([...comicA.assetIds, ...images.assetIds]));
  await expectPresentation(page, 'list');
  expectRepeated(new URL(page.url()), [comicA.id, images.id], ['comic', 'images']);
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('G: List during the NSFW refresh of a debounced Search keeps the Search, Projects/Types and the NSFW change', async ({ page }) => {
  const { comicA, images } = await seed();
  const control = watch(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.baseURL}/asset-viewer?project=${comicA.id}&project=${images.id}&type=comic&type=images&view=grid`);
  await expect.poll(() => totalText(page)).toBe('7 assets found');
  const startLength = await historyLength(page);
  const wasPressed = (await nsfwToggle(page).getAttribute('aria-pressed')) === 'true';
  const gates = await gateFilterGets(page);
  const refresh = gates.next((url) => url.searchParams.get('search') === 'im2');
  await openDialog(page);

  await page.evaluate(() => {
    const search = document.getElementById('asset-library-search');
    search.value = 'im2';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#asset-viewer-filter-dialog [data-dialog-close]').click();
    document.querySelector('[data-asset-library-nsfw-toggle]').click();
  });
  // The NSFW POST succeeded; its refresh (which adopted the Search) is held.
  const refreshUrl = await refresh.arrival;
  expect(refreshUrl.searchParams.get('view')).toBe('grid');

  const listRequest = gates.next(isView('list'));
  await viewLink(page, 'list').click();
  const listUrl = await listRequest.arrival;
  expect(listUrl.searchParams.get('search')).toBe('im2');
  expectRepeated(listUrl, [comicA.id, images.id], ['comic', 'images']);
  listRequest.release();
  await settled(page);
  refresh.release();

  await expect(nsfwToggle(page)).toHaveAttribute('aria-pressed', String(!wasPressed));
  await expect(nsfwToggle(page)).toBeEnabled();
  await expect.poll(() => totalText(page)).toBe('1 asset found');
  expect(await renderedAssetIds(page)).toEqual([images.assetId('im2.png')]);
  await expectPresentation(page, 'list');
  expect(query(page).get('search')).toBe('im2');
  expect(await historyLength(page)).toBe(startLength + 1);
  await page.waitForTimeout(300);
  expect(await renderedAssetIds(page)).toEqual([images.assetId('im2.png')]);
  expect(control.posts.map((post) => post.path)).toEqual(['/asset-viewer/nsfw-filter']);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);

  // Restore the per-user NSFW setting for later tests in this file.
  await nsfwToggle(page).click();
  await expect(nsfwToggle(page)).toHaveAttribute('aria-pressed', String(wasPressed));
});
