import { expect, test } from '@playwright/test';
import {
  checkedValues, choose, closeDialog, createLibraryFixture, dialog, dropdown, openDialog, openDropdown, query,
  renderedAssetIds, settled, summaryText, totalText, watch,
} from './asset-library-filters-defaults-fixture.js';

// WP9b C–H, J, U, V: Projects / Project Types multi-selection on the real
// Asset Library — repeated URL keys, server results, Select all, hidden and
// unavailable selections, Back/Forward, the NSFW refresh and the viewer.

const fixture = createLibraryFixture('asset-library-fd-selection');

test.beforeAll(async () => {
  await fixture.start();
});

test.afterAll(async () => {
  await fixture.stop();
});

// Five projects of four catalogue Project Types; 4 + 3 + 2 + 3 + 2 assets.
async function seed() {
  fixture.isolate();
  const comicA = await fixture.project('Sel Comic A', 'comic', ['ca1.png', 'ca2.png', 'ca3.png', 'ca4.jpg']);
  const images = await fixture.project('Sel Images', 'images', ['im1.png', 'im2.png', 'im3.png']);
  const animation = await fixture.project('Sel Animation', 'animation', ['an1.png', 'an2.png']);
  const comicB = await fixture.project('Sel Comic B', 'comic', ['cb1.png', 'cb2.png', 'cb3.jpg']);
  const wallpaper = await fixture.project('Sel Wallpaper', 'wallpaper', ['wp1.png', 'wp2.png']);
  return { comicA, images, animation, comicB, wallpaper };
}

const sorted = (values) => [...values].sort((left, right) => left - right);

test('C, D, G: two Projects and two Project Types narrow the server results; hidden selections stay checked', async ({ page }) => {
  const { comicA, images, animation, comicB } = await seed();
  const control = watch(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.baseURL}/asset-viewer`);
  await expect.poll(() => totalText(page)).toBe('14 assets found');
  await openDialog(page);

  // Select two Projects through the option search, so each choice is made
  // while the other is hidden by the search.
  await choose(page, 'asset-project-filter', comicA.title, { search: 'comic a' });
  await choose(page, 'asset-project-filter', images.title, { search: 'images' });
  const projects = dropdown(page, 'asset-project-filter');
  await expect(projects.locator(`input[value="${comicA.id}"]`)).toBeChecked();
  await expect(projects.locator(`input[value="${comicA.id}"]`).locator('xpath=ancestor::div[contains(@class,"asset-filter-multiselect-option")]')).toBeHidden();
  await expect(projects.locator('[data-cc-dropdown-search]')).toHaveValue('images');
  await expect(projects.locator('input[data-cc-dropdown-select-all]')).not.toBeChecked();
  expect(await summaryText(page, 'asset-project-filter')).toBe('2 projects selected');

  await choose(page, 'asset-project-type-filter', 'Comic');
  await choose(page, 'asset-project-type-filter', 'Images');
  expect(await summaryText(page, 'asset-project-type-filter')).toBe('2 project types selected');

  // Repeated keys, never comma-joined; Projects OR, Types OR, AND between.
  await expect.poll(() => query(page).getAll('project')).toEqual([String(comicA.id), String(images.id)]);
  expect(query(page).getAll('type')).toEqual(['comic', 'images']);
  expect(page.url()).not.toMatch(/%2C|,/);
  await expect.poll(() => totalText(page)).toBe('7 assets found');
  expect(sorted(await renderedAssetIds(page))).toEqual(sorted([...comicA.assetIds, ...images.assetIds]));

  // AND with a Type that excludes one selected Project.
  await choose(page, 'asset-project-type-filter', 'Images');
  await expect.poll(() => query(page).getAll('type')).toEqual(['comic']);
  await expect.poll(() => totalText(page)).toBe('4 assets found');
  expect(sorted(await renderedAssetIds(page))).toEqual(sorted(comicA.assetIds));
  expect(animation.id).not.toBe(comicB.id);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('E: sorting, page size, pagination and View All keep every repeated selection', async ({ page }) => {
  const { comicA, images, comicB, wallpaper } = await seed();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.baseURL}/asset-viewer?project=${comicA.id}&project=${images.id}&project=${comicB.id}&type=comic&type=images`);
  await expect.poll(() => totalText(page)).toBe('10 assets found');
  await openDialog(page);
  await choose(page, 'asset-sort-filter', 'Size');
  await choose(page, 'asset-order-filter', 'Descending');
  await choose(page, 'asset-page-size-filter', '10');
  await expect.poll(() => query(page).get('pageSize')).toBe('10');
  const expectSelections = () => {
    expect(query(page).getAll('project')).toEqual([String(comicA.id), String(images.id), String(comicB.id)]);
    expect(query(page).getAll('type')).toEqual(['comic', 'images']);
  };
  expectSelections();
  expect(query(page).get('sort')).toBe('size');
  expect(query(page).get('order')).toBe('desc');
  await expect(page.locator('nav.pagination')).toHaveCount(0);

  await choose(page, 'asset-page-size-filter', 'View All');
  await expect.poll(() => query(page).get('pageSize')).toBe('all');
  expectSelections();
  expect((await renderedAssetIds(page)).length).toBe(10);

  // A page size below the total paginates; the server's Next link keeps the keys.
  await choose(page, 'asset-project-filter', wallpaper.title, { search: 'wall' });
  await choose(page, 'asset-page-size-filter', '10');
  await choose(page, 'asset-project-type-filter', 'Wallpaper');
  await expect.poll(() => totalText(page)).toBe('12 assets found');
  await closeDialog(page);
  await page.getByRole('link', { name: 'Next Asset Viewer page' }).click();
  await expect.poll(() => query(page).get('page')).toBe('2');
  await settled(page);
  expect(query(page).getAll('type')).toEqual(['comic', 'images', 'wallpaper']);
  expect(query(page).getAll('project')).toHaveLength(4);
  expect((await renderedAssetIds(page)).length).toBe(2);
  await openDialog(page);
  expect(await checkedValues(page, 'asset-project-type-filter')).toEqual(['images', 'comic', 'wallpaper']);
});

test('F: Select all removes only its own restriction and never checks every Project', async ({ page }) => {
  const { comicA, images, comicB } = await seed();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.baseURL}/asset-viewer?project=${comicA.id}&project=${images.id}&type=comic&type=images&usage=unused`);
  await openDialog(page);
  await choose(page, 'asset-project-filter', 'Select all');
  await expect.poll(() => query(page).getAll('project')).toEqual([]);
  expect(query(page).getAll('type')).toEqual(['comic', 'images']);
  expect(query(page).get('usage')).toBe('unused');
  expect(await checkedValues(page, 'asset-project-filter')).toEqual(['']);
  expect(await summaryText(page, 'asset-project-filter')).toBe('All projects');
  await expect.poll(() => totalText(page)).toBe('10 assets found');
  expect(sorted(await renderedAssetIds(page)))
    .toEqual(sorted([...comicA.assetIds, ...images.assetIds, ...comicB.assetIds]));

  await choose(page, 'asset-project-type-filter', 'Select all');
  await expect.poll(() => query(page).getAll('type')).toEqual([]);
  await expect.poll(() => totalText(page)).toBe('14 assets found');
  expect(await checkedValues(page, 'asset-project-type-filter')).toEqual(['']);
});

test('H: an unavailable Project selection stays a visible restriction and is never broadened', async ({ page }) => {
  const { comicA, images } = await seed();
  // An archived project's ID and an unknown ID, beside one active Project.
  fixture.state.db.prepare("UPDATE projects SET archived_at = CURRENT_TIMESTAMP, status = 'archived' WHERE id = ?").run(images.id);
  const control = watch(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.baseURL}/asset-viewer?project=${images.id}&project=999999`);
  await expect.poll(() => totalText(page)).toBe('0 assets found');
  await openDialog(page);
  expect(await summaryText(page, 'asset-project-filter')).toBe('2 projects selected');
  expect(await summaryText(page, 'asset-project-filter')).not.toBe('All projects');
  const projects = await openDropdown(page, 'asset-project-filter');
  await expect(projects.locator('[data-asset-library-unavailable-project]')).toHaveCount(2);
  await expect(projects.locator('.asset-library-project-option--unavailable label'))
    .toHaveText([`Unavailable project (ID ${images.id})`, 'Unavailable project (ID 999999)']);
  expect(await checkedValues(page, 'asset-project-filter')).toEqual([String(images.id), '999999']);

  // Other edits keep the restriction.
  await choose(page, 'asset-sort-filter', 'Modified');
  await expect.poll(() => query(page).get('sort')).toBe('modified');
  expect(query(page).getAll('project')).toEqual([String(images.id), '999999']);
  await expect.poll(() => totalText(page)).toBe('0 assets found');

  // Adding an active Project ORs it in; the unavailable ones stay restrictive.
  await choose(page, 'asset-project-filter', comicA.title, { search: 'comic a' });
  await expect.poll(() => query(page).getAll('project')).toEqual([String(comicA.id), String(images.id), '999999']);
  await expect.poll(() => totalText(page)).toBe('4 assets found');
  expect(control.defaultsPosts()).toEqual([]);
});

test('J: Back and Forward reinstall results and reconcile the dialog controls', async ({ page }) => {
  const { comicA, images } = await seed();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.baseURL}/asset-viewer`);
  await openDialog(page);
  await choose(page, 'asset-project-filter', comicA.title, { search: 'comic a' });
  await choose(page, 'asset-project-filter', images.title, { search: 'images' });
  await choose(page, 'asset-project-type-filter', 'Comic');
  await expect.poll(() => totalText(page)).toBe('4 assets found');
  await closeDialog(page);

  await page.goBack();
  await expect.poll(() => query(page).getAll('type')).toEqual([]);
  await expect.poll(() => totalText(page)).toBe('7 assets found');
  await openDialog(page);
  expect(await checkedValues(page, 'asset-project-filter')).toEqual([String(comicA.id), String(images.id)]);
  expect(await checkedValues(page, 'asset-project-type-filter')).toEqual(['']);
  await closeDialog(page);

  await page.goBack();
  await expect.poll(() => query(page).getAll('project')).toEqual([String(comicA.id)]);
  await expect.poll(() => totalText(page)).toBe('4 assets found');

  await page.goForward();
  await page.goForward();
  await expect.poll(() => query(page).getAll('type')).toEqual(['comic']);
  await expect.poll(() => totalText(page)).toBe('4 assets found');
  await openDialog(page);
  expect(await checkedValues(page, 'asset-project-filter')).toEqual([String(comicA.id), String(images.id)]);
  expect(await checkedValues(page, 'asset-project-type-filter')).toEqual(['comic']);

  // Reload renders the same server state.
  await page.reload();
  await openDialog(page);
  expect(await checkedValues(page, 'asset-project-filter')).toEqual([String(comicA.id), String(images.id)]);
  expect(await checkedValues(page, 'asset-project-type-filter')).toEqual(['comic']);
});

test('U: the NSFW refresh keeps repeated Projects, Project Types and every other filter', async ({ page }) => {
  const { comicA, images, comicB } = await seed();
  const control = watch(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  const start = `/asset-viewer?project=${comicA.id}&project=${images.id}&project=${comicB.id}&type=comic&type=images&extension=jpg&extension=png&usage=unused&sort=size&order=desc&pageSize=10&page=1`;
  await page.goto(`${fixture.baseURL}${start}`);
  const before = new URL(page.url());
  const beforeIds = await renderedAssetIds(page);
  expect(beforeIds.length).toBe(10);

  const refresh = page.waitForRequest((request) => request.method() === 'GET'
    && new URL(request.url()).pathname === '/asset-viewer' && request.resourceType() === 'fetch');
  await page.locator('[data-asset-library-nsfw-toggle]').click();
  const refreshUrl = new URL((await refresh).url());
  await settled(page);
  await expect(page.locator('[data-asset-library-nsfw-toggle]')).toHaveAttribute('aria-pressed', 'true');

  expect(control.posts.map((post) => post.path)).toEqual(['/asset-viewer/nsfw-filter']);
  expect(refreshUrl.search).toBe(before.search);
  expect(refreshUrl.searchParams.getAll('project')).toEqual([String(comicA.id), String(images.id), String(comicB.id)]);
  expect(refreshUrl.searchParams.getAll('type')).toEqual(['comic', 'images']);
  expect(refreshUrl.searchParams.getAll('extension')).toEqual(['jpg', 'png']);
  expect(refreshUrl.search).not.toMatch(/%2C|,/);
  expect(page.url()).toBe(before.href);
  expect(await renderedAssetIds(page)).toEqual(beforeIds);
  await openDialog(page);
  // Checked rows follow the option order (Project titles); compare as sets.
  expect(sorted(await checkedValues(page, 'asset-project-filter')))
    .toEqual(sorted([String(comicA.id), String(images.id), String(comicB.id)]));
  expect(await checkedValues(page, 'asset-project-type-filter')).toEqual(['images', 'comic']);

  // A later navigation still carries the full state.
  await choose(page, 'asset-order-filter', 'Ascending');
  // An explicit fallback stays explicit in the canonical URL.
  await expect.poll(() => query(page).get('order')).toBe('asc');
  expect(query(page).getAll('project')).toEqual([String(comicA.id), String(images.id), String(comicB.id)]);
  expect(query(page).getAll('type')).toEqual(['comic', 'images']);
  expect(control.defaultsPosts()).toEqual([]);
});

test('V: the Slideshow plays exactly the filtered cross-project sequence', async ({ page }) => {
  const { comicA, images, comicB } = await seed();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.baseURL}/asset-viewer`);
  await openDialog(page);
  await choose(page, 'asset-project-filter', comicA.title, { search: 'comic a' });
  await choose(page, 'asset-project-filter', comicB.title, { search: 'comic b' });
  await choose(page, 'asset-page-size-filter', '10');
  await expect.poll(() => totalText(page)).toBe('7 assets found');
  await closeDialog(page);

  const sequence = await page.evaluate(() => JSON.parse(document.querySelector('[data-asset-library-viewer-sequence]').textContent));
  const keys = sequence.map((entry) => `p:${entry.projectId}|a:${entry.id}`);
  expect(keys.length).toBe(7);
  expect(sorted(sequence.map((entry) => entry.id))).toEqual(sorted([...comicA.assetIds, ...comicB.assetIds]));

  await page.locator('[data-asset-library-slideshow-trigger]').click();
  await expect(page.locator('#unified-viewer-dialog')).toBeVisible();
  const state = await page.evaluate(async () => {
    const { unifiedViewerFor } = await import('/client/unified-viewer.js');
    const viewerState = unifiedViewerFor(document).getState();
    return { count: viewerState.count, keys: viewerState.source.items.map((item) => item.key) };
  });
  expect(state.count).toBe(7);
  expect(state.keys).toEqual(keys);
  await page.keyboard.press('Escape');
  await expect(page.locator('#unified-viewer-dialog')).toBeHidden();
  expect(query(page).getAll('project')).toEqual([String(comicA.id), String(comicB.id)]);
  expect(images.id).toBeGreaterThan(0);
});

/*
 * WP9b F1 — the NSFW refresh that adopts a pending or debounced filter
 * destination owns that destination's navigation: the installed results, the
 * browser address, Back/Forward and a reload all agree. Filter GETs are held
 * or failed through route gates, never through sleeps.
 */
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
  // Holds (or fails) the next filter GET whose URL satisfies `match`.
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
async function pick(page, id, label, { search } = {}) {
  const details = await openDropdown(page, id);
  if (search !== undefined) await details.locator('[data-cc-dropdown-search]').fill(search);
  await details.locator('.asset-filter-multiselect-option label').getByText(label, { exact: true }).first().click();
  const current = dropdown(page, id);
  if (await current.evaluate((element) => element.open)) {
    // From the keyboard: a failure notice can shift the trigger under the
    // fixed option panel.
    await current.locator('summary').focus();
    await page.keyboard.press('Enter');
  }
  await expect(current).toHaveJSProperty('open', false);
}

const nsfwToggle = (page) => page.locator('[data-asset-library-nsfw-toggle]');
const nsfwPressed = async (page) => (await nsfwToggle(page).getAttribute('aria-pressed')) === 'true';
const historyLength = (page) => page.evaluate(() => window.history.length);
// The form serializes Projects in option (title) order: compare as sets.
const isProjects = (...ids) => (url) => JSON.stringify([...url.searchParams.getAll('project')].sort())
  === JSON.stringify(ids.map(String).sort());
// The server redirects a filter GET to its canonical URL. Records, per
// requested URL, the final (post-redirect) URL that answered it.
function trackCanonical(page) {
  const finals = new Map();
  page.on('requestfinished', (request) => {
    if (request.resourceType() !== 'fetch' || new URL(request.url()).pathname !== '/asset-viewer') return;
    let first = request;
    while (first.redirectedFrom()) first = first.redirectedFrom();
    finals.set(first.url(), request.url());
  });
  return (requested) => finals.get(String(requested));
}
const nextFilterGet = (page, match = () => true) => page.waitForRequest((request) => request.method() === 'GET'
  && request.resourceType() === 'fetch' && new URL(request.url()).pathname === '/asset-viewer'
  && match(new URL(request.url())));

test('F1-A: a pending Project GET adopted by the NSFW refresh commits its URL; reload and Back/Forward agree', async ({ page }) => {
  const { comicA } = await seed();
  const control = watch(page);
  const canonical = trackCanonical(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.baseURL}/asset-viewer`);
  await expect.poll(() => totalText(page)).toBe('14 assets found');
  const allIds = sorted(await renderedAssetIds(page));
  const startLength = await historyLength(page);
  const wasPressed = await nsfwPressed(page);
  const gates = await gateFilterGets(page);
  const pending = gates.next(isProjects(comicA.id));

  await openDialog(page);
  await pick(page, 'asset-project-filter', comicA.title, { search: 'comic a' });
  const pendingUrl = await pending.arrival;
  await closeDialog(page);
  const refresh = gates.next(isProjects(comicA.id));
  await nsfwToggle(page).click();
  const refreshUrl = await refresh.arrival;
  refresh.release();
  await expect(nsfwToggle(page)).toHaveAttribute('aria-pressed', String(!wasPressed));
  await expect(nsfwToggle(page)).toBeEnabled();
  await settled(page);

  // The refresh requested the adopted destination and installed it there.
  expect(refreshUrl.href).toBe(pendingUrl.href);
  expect(sorted(await renderedAssetIds(page))).toEqual(sorted(comicA.assetIds));
  expect(page.url()).toBe(canonical(refreshUrl.href));
  expect(query(page).getAll('project')).toEqual([String(comicA.id)]);
  expect(await historyLength(page)).toBe(startLength + 1);

  // The stale held GET cannot restore the earlier results or address.
  pending.release();
  await page.waitForTimeout(300);
  expect(page.url()).toBe(canonical(refreshUrl.href));
  expect(sorted(await renderedAssetIds(page))).toEqual(sorted(comicA.assetIds));
  await openDialog(page);
  expect(await checkedValues(page, 'asset-project-filter')).toEqual([String(comicA.id)]);
  await closeDialog(page);

  // Reload reproduces the installed restriction.
  await page.reload();
  expect(sorted(await renderedAssetIds(page))).toEqual(sorted(comicA.assetIds));
  expect(query(page).getAll('project')).toEqual([String(comicA.id)]);

  await page.goBack();
  await expect.poll(() => query(page).getAll('project')).toEqual([]);
  await expect.poll(async () => sorted(await renderedAssetIds(page))).toEqual(allIds);
  await page.goForward();
  await expect.poll(() => query(page).getAll('project')).toEqual([String(comicA.id)]);
  await expect.poll(async () => sorted(await renderedAssetIds(page))).toEqual(sorted(comicA.assetIds));
  await openDialog(page);
  expect(await checkedValues(page, 'asset-project-filter')).toEqual([String(comicA.id)]);

  expect(control.posts.map((post) => post.path)).toEqual(['/asset-viewer/nsfw-filter']);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('F1-B: a debounced results Search adopted by the NSFW refresh installs and commits the same Search', async ({ page }) => {
  const { comicB } = await seed();
  const control = watch(page);
  const canonical = trackCanonical(page);
  // Client-initiated Search GETs (a server redirect hop is not one).
  const searchGets = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.resourceType() === 'fetch' && url.pathname === '/asset-viewer'
      && !request.redirectedFrom() && url.searchParams.get('search') === 'cb') searchGets.push(url);
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.baseURL}/asset-viewer`);
  await expect.poll(() => totalText(page)).toBe('14 assets found');
  const allIds = sorted(await renderedAssetIds(page));
  const startLength = await historyLength(page);
  await openDialog(page);

  const refresh = nextFilterGet(page);
  // Type, close and toggle within one task: the 350 ms debounce cannot fire
  // first, so the NSFW refresh is what adopts the Search.
  await page.evaluate(() => {
    const search = document.getElementById('asset-library-search');
    search.value = 'cb';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#asset-viewer-filter-dialog [data-dialog-close]').click();
    document.querySelector('[data-asset-library-nsfw-toggle]').click();
  });
  const refreshUrl = new URL((await refresh).url());
  await expect(nsfwToggle(page)).toBeEnabled();
  await settled(page);

  expect(refreshUrl.searchParams.get('search')).toBe('cb');
  expect(control.posts.map((post) => post.path)).toEqual(['/asset-viewer/nsfw-filter']);
  expect(sorted(await renderedAssetIds(page))).toEqual(sorted(comicB.assetIds));
  expect(page.url()).toBe(canonical(refreshUrl.href));
  expect(query(page).get('search')).toBe('cb');
  expect(await historyLength(page)).toBe(startLength + 1);
  // The folded debounce never sends a second Search request.
  await page.waitForTimeout(500);
  expect(searchGets).toHaveLength(1);
  await openDialog(page);
  await expect(page.locator('#asset-library-search')).toHaveValue('cb');
  await closeDialog(page);

  await page.reload();
  expect(sorted(await renderedAssetIds(page))).toEqual(sorted(comicB.assetIds));
  await page.goBack();
  await expect.poll(() => query(page).get('search')).toBeNull();
  await expect.poll(async () => sorted(await renderedAssetIds(page))).toEqual(allIds);
  await page.goForward();
  await expect.poll(() => query(page).get('search')).toBe('cb');
  await expect.poll(async () => sorted(await renderedAssetIds(page))).toEqual(sorted(comicB.assetIds));
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('F1-C/D: an adopted pending edit keeps repeated Projects, Types and Category, Tag and Extension restrictions', async ({ page }) => {
  const { comicA, images, comicB } = await seed();
  const tags = fixture.state.app.locals.tagService;
  const keep = tags.listTags?.().find((tag) => (tag.display_name ?? tag.displayName) === 'Keep')?.id
    ?? tags.createTag({ name: 'Keep' }).id;
  const taggedImages = images.assetIds.slice(0, 2);
  for (const id of [...comicA.assetIds, ...taggedImages, ...comicB.assetIds]) {
    fixture.state.app.locals.assetTagService.replaceAssetTags(id, [keep]);
  }
  const pngOf = (ids) => ids.filter((id) => fixture.state.db
    .prepare('SELECT filename FROM assets WHERE id = ?').get(id).filename.endsWith('.png'));
  const control = watch(page);
  const canonical = trackCanonical(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.baseURL}/asset-viewer?project=${comicA.id}&project=${images.id}&type=comic&type=images&category=uncategorized&tag=${keep}&extension=png`);
  expect(sorted(await renderedAssetIds(page))).toEqual(sorted(pngOf([...comicA.assetIds, ...taggedImages])));
  const startLength = await historyLength(page);
  const gates = await gateFilterGets(page);
  const all3 = isProjects(comicA.id, images.id, comicB.id);
  const pending = gates.next(all3);

  await openDialog(page);
  await pick(page, 'asset-project-filter', comicB.title, { search: 'comic b' });
  await pending.arrival;
  await closeDialog(page);
  const refresh = nextFilterGet(page, all3);
  await nsfwToggle(page).click();
  const refreshUrl = new URL((await refresh).url());
  await expect(nsfwToggle(page)).toBeEnabled();
  await settled(page);
  pending.release();

  for (const params of [refreshUrl.searchParams, query(page)]) {
    expect(sorted(params.getAll('project').map(Number))).toEqual(sorted([comicA.id, images.id, comicB.id]));
    expect([...params.getAll('type')].sort()).toEqual(['comic', 'images']);
    expect(params.get('category')).toBe('uncategorized');
    expect(params.getAll('tag')).toEqual([String(keep)]);
    expect(params.getAll('extension')).toEqual(['png']);
  }
  expect(refreshUrl.search).not.toMatch(/%2C|,/);
  expect(page.url()).toBe(canonical(refreshUrl.href));
  const expected = sorted(pngOf([...comicA.assetIds, ...taggedImages, ...comicB.assetIds]));
  expect(sorted(await renderedAssetIds(page))).toEqual(expected);
  expect(await historyLength(page)).toBe(startLength + 1);
  await openDialog(page);
  expect(sorted(await checkedValues(page, 'asset-project-filter')))
    .toEqual(sorted([String(comicA.id), String(images.id), String(comicB.id)]));
  expect([...await checkedValues(page, 'asset-project-type-filter')].sort()).toEqual(['comic', 'images']);
  expect(await checkedValues(page, 'asset-extension-filter')).toEqual(['png']);
  expect(await checkedValues(page, 'asset-tag-filter')).toEqual([String(keep)]);
  await page.reload();
  expect(sorted(await renderedAssetIds(page))).toEqual(expected);
  expect(control.defaultsPosts()).toEqual([]);
});

test('F1-E: an idle NSFW toggle keeps the installed URL and adds no history entry', async ({ page }) => {
  const { comicA, images } = await seed();
  const control = watch(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.baseURL}/asset-viewer?project=${comicA.id}&project=${images.id}&type=comic`);
  const before = page.url();
  const ids = await renderedAssetIds(page);
  const startLength = await historyLength(page);
  const wasPressed = await nsfwPressed(page);
  const refresh = nextFilterGet(page);
  await nsfwToggle(page).click();
  expect((await refresh).url()).toBe(before);
  await expect(nsfwToggle(page)).toHaveAttribute('aria-pressed', String(!wasPressed));
  await expect(nsfwToggle(page)).toBeEnabled();
  await settled(page);
  expect(page.url()).toBe(before);
  expect(await renderedAssetIds(page)).toEqual(ids);
  expect(await historyLength(page)).toBe(startLength);
  expect(control.defaultsPosts()).toEqual([]);
});

test('F1-F: a filter GET that failed before the NSFW toggle is committed by the refresh; a failed refresh changes nothing', async ({ page }) => {
  const { comicA, comicB } = await seed();
  const control = watch(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.baseURL}/asset-viewer`);
  await expect.poll(() => totalText(page)).toBe('14 assets found');
  const startLength = await historyLength(page);
  const gates = await gateFilterGets(page);

  // Failed before: the Retry notice owns the failed request.
  gates.next(isProjects(comicA.id), { fail: true });
  await openDialog(page);
  await pick(page, 'asset-project-filter', comicA.title, { search: 'comic a' });
  await expect(dialog(page).locator('[data-live-filter-retry]')).toBeVisible();
  expect(page.url()).toBe(`${fixture.baseURL}/asset-viewer`);
  await closeDialog(page);
  await nsfwToggle(page).click();
  await expect.poll(() => query(page).getAll('project')).toEqual([String(comicA.id)]);
  await expect(nsfwToggle(page)).toBeEnabled();
  await settled(page);
  expect(sorted(await renderedAssetIds(page))).toEqual(sorted(comicA.assetIds));
  expect(await historyLength(page)).toBe(startLength + 1);
  await expect(page.locator('[data-live-filter-failure]')).toHaveCount(0);
  await page.reload();
  expect(sorted(await renderedAssetIds(page))).toEqual(sorted(comicA.assetIds));

  // Failed during: the adopted refresh itself fails, so neither the results
  // nor the address move, and a reload shows those same results.
  const afterReload = page.url();
  const reloadLength = await historyLength(page);
  const pending = gates.next(isProjects(comicA.id, comicB.id));
  await openDialog(page);
  await pick(page, 'asset-project-filter', comicB.title, { search: 'comic b' });
  await pending.arrival;
  await closeDialog(page);
  gates.next(isProjects(comicA.id, comicB.id), { fail: true });
  await nsfwToggle(page).click();
  await expect(page.locator('[data-asset-library-live-status]')).toContainText('could not refresh');
  pending.release();
  await page.waitForTimeout(300);
  expect(page.url()).toBe(afterReload);
  expect(sorted(await renderedAssetIds(page))).toEqual(sorted(comicA.assetIds));
  expect(await historyLength(page)).toBe(reloadLength);
  await page.reload();
  expect(sorted(await renderedAssetIds(page))).toEqual(sorted(comicA.assetIds));
  expect(control.defaultsPosts()).toEqual([]);
});

test('F1-G: a newer filter edit made while the adopted NSFW refresh is pending wins URL and results', async ({ page }) => {
  const { comicA, images } = await seed();
  const control = watch(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.baseURL}/asset-viewer`);
  await expect.poll(() => totalText(page)).toBe('14 assets found');
  const allIds = sorted(await renderedAssetIds(page));
  const startLength = await historyLength(page);
  const wasPressed = await nsfwPressed(page);
  const gates = await gateFilterGets(page);

  await openDialog(page);
  await choose(page, 'asset-project-filter', comicA.title, { search: 'comic a' });
  const afterFirst = page.url();
  const pending = gates.next(isProjects(comicA.id, images.id));
  await pick(page, 'asset-project-filter', images.title, { search: 'images' });
  await pending.arrival;
  await closeDialog(page);
  const refresh = gates.next(isProjects(comicA.id, images.id));
  await nsfwToggle(page).click();
  await refresh.arrival;

  // A newer edit while the adopted refresh is still held.
  await openDialog(page);
  await pick(page, 'asset-project-type-filter', 'Images');
  await expect.poll(() => query(page).getAll('type')).toEqual(['images']);
  await settled(page);
  refresh.release();
  pending.release();
  await page.waitForTimeout(300);

  expect(query(page).getAll('project')).toEqual([String(comicA.id), String(images.id)]);
  expect(query(page).getAll('type')).toEqual(['images']);
  expect(sorted(await renderedAssetIds(page))).toEqual(sorted(images.assetIds));
  // The newer load carried the owed NSFW refresh to completion.
  await expect(nsfwToggle(page)).toHaveAttribute('aria-pressed', String(!wasPressed));
  await expect(nsfwToggle(page)).toBeEnabled();
  // First edit +1, the superseded adopted refresh +0, the newer edit +1.
  expect(await historyLength(page)).toBe(startLength + 2);
  expect(await checkedValues(page, 'asset-project-type-filter')).toEqual(['images']);
  await closeDialog(page);

  await page.goBack();
  await expect.poll(() => page.url()).toBe(afterFirst);
  await expect.poll(async () => sorted(await renderedAssetIds(page))).toEqual(sorted(comicA.assetIds));
  await page.goBack();
  await expect.poll(async () => sorted(await renderedAssetIds(page))).toEqual(allIds);
  await page.goForward();
  await page.goForward();
  await expect.poll(() => query(page).getAll('type')).toEqual(['images']);
  await expect.poll(async () => sorted(await renderedAssetIds(page))).toEqual(sorted(images.assetIds));
  await page.reload();
  expect(sorted(await renderedAssetIds(page))).toEqual(sorted(images.assetIds));
  expect(control.defaultsPosts()).toEqual([]);
});

// ── WP9b F4: the NSFW refresh compares its FINAL canonical response URL with
// the shown address, so an edit undone within the debounce adds no entry. ──

async function seedSearch() {
  fixture.isolate();
  const first = await fixture.project('Hist One', 'comic', ['alpha1.png', 'alpha2.png', 'beta1.png']);
  const second = await fixture.project('Hist Two', 'images', ['alpha3.png', 'beta2.png', 'gamma1.png']);
  const idsOf = (...needles) => [first, second].flatMap((project) => project.assetIds)
    .filter((id) => needles.some((needle) => fixture.state.db
      .prepare('SELECT filename FROM assets WHERE id = ?').get(id).filename.includes(needle)));
  return { first, second, idsOf };
}

// Edits the results Search, closes the dialog and toggles NSFW within one
// task, so the 350 ms debounce cannot fire before the NSFW refresh adopts it.
async function typeThenToggle(page, values) {
  await page.evaluate((sequence) => {
    const search = document.getElementById('asset-library-search');
    for (const value of sequence) {
      search.value = value;
      search.dispatchEvent(new Event('input', { bubbles: true }));
    }
    document.querySelector('#asset-viewer-filter-dialog [data-dialog-close]').click();
    document.querySelector('[data-asset-library-nsfw-toggle]').click();
  }, values);
}

const F4_START = '/asset-viewer?search=alpha&presence=all&sort=filename&order=asc&pageSize=25&view=grid';

test('F4-A: an edit undone within the debounce and adopted by the NSFW refresh adds no history entry', async ({ page }) => {
  const { idsOf } = await seedSearch();
  const control = watch(page);
  const canonical = trackCanonical(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.baseURL}${F4_START}`);
  const before = page.url();
  const alphaIds = sorted(idsOf('alpha'));
  expect(sorted(await renderedAssetIds(page))).toEqual(alphaIds);
  const startLength = await historyLength(page);
  const wasPressed = await nsfwPressed(page);
  await openDialog(page);

  const refresh = nextFilterGet(page);
  await typeThenToggle(page, ['alphax', 'alpha']);
  const refreshUrl = new URL((await refresh).url());
  await expect(nsfwToggle(page)).toHaveAttribute('aria-pressed', String(!wasPressed));
  await expect(nsfwToggle(page)).toBeEnabled();
  await settled(page);

  expect(refreshUrl.searchParams.get('search')).toBe('alpha');
  await expect.poll(() => canonical(refreshUrl.href)).toBe(before);
  expect(page.url()).toBe(before);
  expect(sorted(await renderedAssetIds(page))).toEqual(alphaIds);
  expect(await historyLength(page)).toBe(startLength);
  await page.reload();
  expect(page.url()).toBe(before);
  expect(sorted(await renderedAssetIds(page))).toEqual(alphaIds);
  expect(control.posts.map((post) => post.path)).toEqual(['/asset-viewer/nsfw-filter']);
  expect(control.errors).toEqual([]);
});

test('F4-B: a genuinely changed debounced Search adopted by the NSFW refresh adds one entry; Back/Forward agree', async ({ page }) => {
  const { idsOf } = await seedSearch();
  const control = watch(page);
  const canonical = trackCanonical(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.baseURL}${F4_START}`);
  const before = page.url();
  const startLength = await historyLength(page);
  await openDialog(page);

  const refresh = nextFilterGet(page);
  await typeThenToggle(page, ['beta']);
  const refreshUrl = new URL((await refresh).url());
  await expect(nsfwToggle(page)).toBeEnabled();
  await settled(page);

  expect(refreshUrl.searchParams.get('search')).toBe('beta');
  expect(page.url()).toBe(canonical(refreshUrl.href));
  expect(query(page).get('search')).toBe('beta');
  expect(sorted(await renderedAssetIds(page))).toEqual(sorted(idsOf('beta')));
  expect(await historyLength(page)).toBe(startLength + 1);
  const after = page.url();

  await page.goBack();
  await expect.poll(() => page.url()).toBe(before);
  await expect.poll(async () => sorted(await renderedAssetIds(page))).toEqual(sorted(idsOf('alpha')));
  await page.goForward();
  await expect.poll(() => page.url()).toBe(after);
  await expect.poll(async () => sorted(await renderedAssetIds(page))).toEqual(sorted(idsOf('beta')));
  expect(control.errors).toEqual([]);
});

test('F4-D: repeated Projects and Project Types stay repeated; a no-op edit adds no entry, a real one adds one', async ({ page }) => {
  const { first, second, idsOf } = await seedSearch();
  const control = watch(page);
  const canonical = trackCanonical(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  // The explicit canonical form the filter form produces (an omitted neutral
  // value follows saved defaults, so the minimal URL is a different state).
  await page.goto(`${fixture.baseURL}/asset-viewer?project=${first.id}&project=${second.id}&type=comic&type=images&presence=all&sort=filename&order=asc&pageSize=25&view=grid`);
  const before = page.url();
  const allIds = sorted([...first.assetIds, ...second.assetIds]);
  expect(sorted(await renderedAssetIds(page))).toEqual(allIds);
  const startLength = await historyLength(page);

  await openDialog(page);
  let refresh = nextFilterGet(page);
  await typeThenToggle(page, ['gamma', '']);
  let refreshUrl = new URL((await refresh).url());
  await expect(nsfwToggle(page)).toBeEnabled();
  await settled(page);
  for (const params of [refreshUrl.searchParams, query(page)]) {
    expect(sorted(params.getAll('project').map(Number))).toEqual(sorted([first.id, second.id]));
    expect([...params.getAll('type')].sort()).toEqual(['comic', 'images']);
  }
  expect(refreshUrl.search).not.toMatch(/%2C|,/);
  expect(page.url()).toBe(before);
  expect(canonical(refreshUrl.href)).toBe(before);
  expect(sorted(await renderedAssetIds(page))).toEqual(allIds);
  expect(await historyLength(page)).toBe(startLength);

  await openDialog(page);
  refresh = nextFilterGet(page);
  await typeThenToggle(page, ['gamma']);
  refreshUrl = new URL((await refresh).url());
  await expect(nsfwToggle(page)).toBeEnabled();
  await settled(page);
  expect(page.url()).toBe(canonical(refreshUrl.href));
  expect(sorted(query(page).getAll('project').map(Number))).toEqual(sorted([first.id, second.id]));
  expect([...query(page).getAll('type')].sort()).toEqual(['comic', 'images']);
  expect(query(page).get('search')).toBe('gamma');
  expect(sorted(await renderedAssetIds(page))).toEqual(sorted(idsOf('gamma')));
  expect(await historyLength(page)).toBe(startLength + 1);
  await page.goBack();
  await expect.poll(() => page.url()).toBe(before);
  await expect.poll(async () => sorted(await renderedAssetIds(page))).toEqual(allIds);
  expect(control.errors).toEqual([]);
});

test('F4-E: a failed same-address NSFW refresh commits no history; reload and a later idle toggle stay neutral', async ({ page }) => {
  const { idsOf } = await seedSearch();
  const control = watch(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.baseURL}${F4_START}`);
  const before = page.url();
  const alphaIds = sorted(idsOf('alpha'));
  const startLength = await historyLength(page);
  const gates = await gateFilterGets(page);
  await openDialog(page);

  const failing = gates.next((url) => url.searchParams.get('search') === 'alpha', { fail: true });
  await typeThenToggle(page, ['alphax', 'alpha']);
  await failing.arrival;
  await expect(page.locator('[data-asset-library-live-status]')).toContainText('could not refresh');
  await expect(nsfwToggle(page)).toBeEnabled();
  expect(page.url()).toBe(before);
  expect(sorted(await renderedAssetIds(page))).toEqual(alphaIds);
  expect(await historyLength(page)).toBe(startLength);

  await page.reload();
  expect(page.url()).toBe(before);
  expect(sorted(await renderedAssetIds(page))).toEqual(alphaIds);
  const reloadLength = await historyLength(page);
  const refresh = nextFilterGet(page);
  await nsfwToggle(page).click();
  expect((await refresh).url()).toBe(before);
  await expect(nsfwToggle(page)).toBeEnabled();
  await settled(page);
  expect(page.url()).toBe(before);
  expect(await historyLength(page)).toBe(reloadLength);
  expect(control.posts.map((post) => post.path)).toEqual(['/asset-viewer/nsfw-filter', '/asset-viewer/nsfw-filter']);
});
