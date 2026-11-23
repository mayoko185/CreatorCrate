import { expect, test } from '@playwright/test';
import {
  TWO, checkedValues, choose, closeDialog, createReleasesFixture, dialog, enhanced, expectRepeated, expectTitles, openDialog,
  openDropdown, pageAuthority, query, releasesUrl, settled, summaryText, watch,
} from './releases-filters-defaults-fixture.js';

// WP12 K–N, U–W and the Save / Reset races: explicit Save of exactly Sort and
// Order, no defaults POST from ordinary edits, Reset defaults deleting only
// the Releases keys while keeping the temporary context, Reset filters
// (read-only), edits during Save, a confirmed Save/Reset whose refresh fails
// (GET-only recovery, never a replayed POST), uncertain POSTs, one success
// confirmation, and fail-closed initialization — on the real page with
// SQLite inspection.

const fixture = createReleasesFixture('releases-fd-persistence');

test.beforeAll(async () => {
  await fixture.start();
});

test.afterAll(async () => {
  await fixture.stop();
});

function seed() {
  fixture.isolate();
  fixture.writePageDefault('projects', 'sort', 'title');
  fixture.writePageDefault('assetViewer', 'sort', 'size');
  const comic = fixture.project('Persist Comic', { projectType: 'comic' });
  const anim = fixture.project('Persist Anim', { projectType: 'animation' });
  const images = fixture.project('Persist Images', { projectType: 'images' });
  return {
    comic,
    anim,
    images,
    c1: fixture.release(comic, 'P Comic One', { plannedDate: '2000-01-01' }),
    c2: fixture.release(comic, 'P Comic Two', { plannedDate: '2999-01-01' }),
    a1: fixture.release(anim, 'P Anim One', { plannedDate: '2000-01-02' }),
    i1: fixture.release(images, 'P Images One'),
  };
}

async function start(page, url = `${fixture.baseURL}/releases`) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(url);
  await enhanced(page);
}

const statusLine = (page) => dialog(page).locator('[data-settings-fetch-save-status]');
const indicator = (page) => dialog(page).locator('[data-releases-defaults-indicator]');
const saveButton = (page) => dialog(page).locator('[data-releases-defaults-save]');
const resetDefaultsButton = (page) => dialog(page).locator('[data-releases-defaults-reset]');
const resetFiltersButton = (page) => dialog(page).locator('[data-releases-filters-reset]');
const savedConfirmations = (page) => dialog(page).getByText('Defaults saved.', { exact: true }).filter({ visible: true });
const savedAnnouncements = (page) => dialog(page)
  .locator('[aria-live], [role="status"], [role="alert"]').filter({ hasText: 'Defaults saved.' });

test('K/L: ordinary edits never POST; Save persists exactly Sort and Order once with one confirmation', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  const assetId = fixture.asset(s.comic, 'persist.png');
  fixture.addAsset(s.c1, assetId);
  fixture.addAsset(s.c2, assetId);
  await start(page, releasesUrl(fixture.baseURL, { asset: assetId, pageSize: 7 }));
  await openDialog(page);
  await page.locator('#releases-search').fill('P Comic');
  await expect.poll(() => query(page).get('search')).toBe('P Comic');
  await settled(page);
  await choose(page, 'release-project-filter', s.comic.title);
  await choose(page, 'release-type-filter', 'Comic');
  await choose(page, 'list-schedule', 'Upcoming');
  await choose(page, 'list-schedule', 'All');
  await page.locator('#list-includeArchived').check();
  await settled(page);
  await choose(page, 'list-sort', 'Title');
  await choose(page, 'list-order', 'Descending');
  await expectTitles(page, [s.c2.title, s.c1.title]);
  // L: none of those edits wrote anything.
  expect(control.defaultsPosts()).toEqual([]);
  expect(fixture.releasesKeys()).toEqual([]);
  const before = page.url();

  await saveButton(page).click();
  await expect(statusLine(page)).toHaveText('Defaults saved.');
  await settled(page);
  expect(control.defaultsPosts()).toHaveLength(1);
  const post = control.defaultsPosts()[0];
  expect(post.path).toBe('/releases/defaults');
  expect([...new Set([...post.body.keys()])].sort())
    .toEqual(['_csrf', 'defaultsGeneration', 'defaultsOperation', 'order', 'returnTo', 'sort']);
  expect(post.body.get('sort')).toBe('title');
  expect(post.body.get('order')).toBe('desc');
  expect(post.body.get('defaultsGeneration')).toBe('0');
  for (const key of ['search', 'project', 'type', 'schedule', 'includeArchived', 'asset', 'pageSize']) {
    expect(post.body.has(key)).toBe(false);
  }
  expect(fixture.storedReleasesDefaults()).toEqual({ sort: 'title', order: 'desc' });
  expect(fixture.releasesKeys().length).toBe(2);
  expect(fixture.generation()).toBe(1);
  // Other pages' defaults are untouched; the temporary context is kept.
  expect(fixture.readPageDefault('projects', 'sort')).toBe('title');
  expect(fixture.readPageDefault('assetViewer', 'sort')).toBe('size');
  expect(new URL(page.url()).searchParams.get('asset')).toBe(String(assetId));
  expect(query(page).get('pageSize')).toBe('7');
  expect(query(page).get('search')).toBe('P Comic');
  expect(query(page).get('includeArchived')).toBe('1');
  expectRepeated(page.url(), 'project', [s.comic.id]);
  expectRepeated(page.url(), 'type', ['comic']);
  expect(new URL(page.url()).pathname).toBe(new URL(before).pathname);
  await expectTitles(page, [s.c2.title, s.c1.title]);

  // R1: one visible confirmation and one announcement; the identical
  // indicator steps aside.
  await expect(savedConfirmations(page)).toHaveCount(1);
  await expect(savedAnnouncements(page)).toHaveCount(1);
  await expect(indicator(page)).toBeHidden();
  await expect(indicator(page)).toHaveText('Defaults saved.');
  // The bare page now opens with the saved Sort/Order.
  const bare = await page.request.get(`${fixture.baseURL}/releases`, { maxRedirects: 0 });
  expect(bare.status()).toBe(302);
  expect(bare.headers().location).toBe('/releases?sort=title&order=desc');
  expect(control.errors).toEqual([]);
});

test('M/N: Reset defaults deletes only the Releases keys and keeps the temporary context; Reset filters is read-only', async ({ page }) => {
  const s = seed();
  fixture.writePageDefault('releases', 'sort', 'title');
  // An explicitly saved fallback-equal value still counts as saved.
  fixture.writePageDefault('releases', 'order', 'asc');
  const control = watch(page);
  await start(page, releasesUrl(fixture.baseURL, { project: [s.comic.id, s.anim.id], type: ['comic', 'animation'], pageSize: 9 }));
  await openDialog(page);
  await expect(indicator(page)).toHaveText('Defaults saved.');
  await choose(page, 'list-order', 'Descending');
  await page.locator('#releases-search').fill('One');
  await expect.poll(() => query(page).get('search')).toBe('One');
  await settled(page);
  const generation = fixture.generation();

  // N first: Reset filters restores saved Sort/Order and clears every
  // temporary filter, without any defaults write.
  await resetFiltersButton(page).click();
  await settled(page);
  expect([...query(page).keys()].sort()).toEqual(['pageSize', 'sort']);
  expect(query(page).get('sort')).toBe('title');
  expect(await summaryText(page, 'list-order')).toBe('Ascending');
  expect(await summaryText(page, 'release-project-filter')).toBe('All projects');
  expect(await summaryText(page, 'release-type-filter')).toBe('All types');
  await expect(page.locator('#releases-search')).toHaveValue('');
  expect(control.defaultsPosts()).toEqual([]);
  expect(fixture.generation()).toBe(generation);
  expect(fixture.storedReleasesDefaults()).toEqual({ sort: 'title', order: 'asc' });

  // Reselect a temporary context, then Reset defaults.
  await choose(page, 'release-project-filter', s.comic.title);
  await choose(page, 'release-project-filter', s.anim.title);
  await choose(page, 'release-type-filter', 'Comic');
  await resetDefaultsButton(page).click();
  await expect(statusLine(page)).toHaveText('Defaults reset to the application defaults.');
  await settled(page);
  expect(control.defaultsPosts()).toHaveLength(1);
  expect(control.defaultsPosts()[0].path).toBe('/releases/defaults/reset');
  expect(TWO.some((field) => control.defaultsPosts()[0].body.has(field))).toBe(false);
  expect(fixture.releasesKeys()).toEqual([]);
  expect(fixture.generation()).toBe(generation + 1);
  expect(fixture.readPageDefault('projects', 'sort')).toBe('title');
  expect(fixture.readPageDefault('assetViewer', 'sort')).toBe('size');
  // Temporary context kept, Sort/Order back to the application fallbacks.
  expectRepeated(page.url(), 'project', [s.comic.id, s.anim.id]);
  expectRepeated(page.url(), 'type', ['comic']);
  expect(query(page).get('pageSize')).toBe('9');
  expect(query(page).has('sort')).toBe(false);
  expect(query(page).has('order')).toBe(false);
  expect(await summaryText(page, 'list-sort')).toBe('Planned');
  expect(await summaryText(page, 'list-order')).toBe('Ascending');
  await expect(indicator(page)).toHaveText('No saved defaults.');
  expect((await pageAuthority(page)).savedKeys).toEqual([]);
  await expectTitles(page, [s.c1.title, s.c2.title]);
});

test('V: a confirmed Save or Reset defaults whose refresh fails recovers by GET only, never replaying the POST', async ({ page }) => {
  const s = seed();
  const generationBefore = fixture.generation();
  const control = watch(page);
  await start(page, releasesUrl(fixture.baseURL, { project: [s.comic.id, s.anim.id] }));
  await openDialog(page);
  await choose(page, 'list-sort', 'Title');

  let failNext = false;
  await page.route((url) => url.pathname === '/releases', async (route) => {
    if (failNext && route.request().resourceType() === 'fetch') {
      failNext = false;
      await route.fulfill({ status: 503, body: 'unavailable' });
      return;
    }
    await route.continue();
  });
  failNext = true;
  await saveButton(page).click();
  await expect(dialog(page).locator('[data-live-filter-retry]')).toBeVisible();
  expect(control.defaultsPosts()).toHaveLength(1);
  expect(fixture.readPageDefault('releases', 'sort')).toBe('title');
  await expect(statusLine(page)).toHaveText('Defaults were saved, but Releases could not be refreshed. Retry to refresh the page.');
  // Save stays refused until the page is coherent again.
  await saveButton(page).click();
  expect(control.defaultsPosts()).toHaveLength(1);
  await dialog(page).locator('[data-live-filter-retry]').click();
  await settled(page);
  await expect(statusLine(page)).toHaveText('Defaults saved.');
  expect(control.defaultsPosts()).toHaveLength(1);
  expectRepeated(page.url(), 'project', [s.comic.id, s.anim.id]);

  failNext = true;
  await resetDefaultsButton(page).click();
  await expect(dialog(page).locator('[data-live-filter-retry]')).toBeVisible();
  expect(control.defaultsPosts()).toHaveLength(2);
  expect(fixture.releasesKeys()).toEqual([]);
  // A second Reset defaults is refused while the confirmed one is unrefreshed.
  await resetDefaultsButton(page).click();
  expect(control.defaultsPosts()).toHaveLength(2);
  await dialog(page).locator('[data-live-filter-retry]').click();
  await settled(page);
  await expect(statusLine(page)).toHaveText('Defaults reset to the application defaults.');
  expect(control.defaultsPosts()).toHaveLength(2);
  expectRepeated(page.url(), 'project', [s.comic.id, s.anim.id]);
  expect(fixture.generation()).toBe(generationBefore + 2);
});

test('races U: Save refused while a GET is pending; edits during Save stay current; Reset filters vs older GET and incomplete Reset', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  await start(page);
  await openDialog(page);

  // Save while a filter GET is pending is refused (nothing posted).
  let release;
  let held = new Promise((resolve) => { release = resolve; });
  const sortPending = (url) => url.pathname === '/releases' && url.searchParams.get('sort') === 'updated';
  await page.route(sortPending, async (route) => {
    await held;
    await route.continue();
  });
  const sort = await openDropdown(page, 'list-sort');
  await sort.locator('.asset-filter-multiselect-option label').getByText('Updated', { exact: true }).click();
  await expect(page.locator('[data-releases-live-region]')).toHaveAttribute('aria-busy', 'true');
  await saveButton(page).click();
  await expect(statusLine(page)).toHaveText('Releases are still loading. Save again when they have finished.');
  expect(control.defaultsPosts()).toHaveLength(0);
  release();
  await settled(page);
  await page.unroute(sortPending);

  // A delayed Save; duplicate clicks and reopening send nothing more; a newer
  // edit during the Save stays current and is not persisted.
  let releasePost;
  const heldPost = new Promise((resolve) => { releasePost = resolve; });
  await page.route('**/releases/defaults', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await heldPost;
    return route.continue();
  });
  await saveButton(page).click();
  await expect(statusLine(page)).toHaveText('Saving defaults.');
  await saveButton(page).click({ force: true });
  await closeDialog(page);
  await openDialog(page);
  await saveButton(page).click({ force: true });
  await choose(page, 'list-order', 'Descending');
  await choose(page, 'release-project-filter', s.comic.title);
  releasePost();
  await expect(statusLine(page)).toHaveText('Defaults saved.');
  await settled(page);
  expect(control.defaultsPosts()).toHaveLength(1);
  expect(fixture.storedReleasesDefaults()).toEqual({ sort: 'updated', order: 'asc' });
  expect(query(page).get('order')).toBe('desc');
  expectRepeated(page.url(), 'project', [s.comic.id]);
  expect(await summaryText(page, 'list-order')).toBe('Descending');
  await expect(indicator(page)).toContainText('Current settings differ from the saved defaults');
  await page.unroute('**/releases/defaults');

  // Reset filters supersedes an older pending GET; the newer intent wins,
  // and Save is refused while Reset filters is incomplete.
  held = new Promise((resolve) => { release = resolve; });
  const typePending = (url) => url.pathname === '/releases' && url.searchParams.getAll('type').length > 0;
  await page.route(typePending, async (route) => {
    await held;
    await route.continue().catch(() => {});
  });
  const types = await openDropdown(page, 'release-type-filter');
  await types.locator('input[value="animation"]').check();
  await types.locator('summary').click();
  let releaseReset;
  const heldReset = new Promise((resolve) => { releaseReset = resolve; });
  const resetPending = (url) => url.pathname === '/releases' && [...url.searchParams.keys()].length === 0;
  await page.route(resetPending, async (route) => {
    await heldReset;
    await route.continue().catch(() => {});
  });
  await resetFiltersButton(page).click();
  await saveButton(page).click();
  await expect(statusLine(page)).toHaveText('Reset filters has not finished. Save again when it has finished.');
  release();
  releaseReset();
  await settled(page);
  await page.waitForTimeout(300);
  expect(query(page).getAll('type')).toEqual([]);
  expect(query(page).getAll('project')).toEqual([]);
  expect(query(page).get('sort')).toBe('updated');
  expect(query(page).has('order')).toBe(false);
  expect(await summaryText(page, 'list-order')).toBe('Ascending');
  expect(await summaryText(page, 'release-type-filter')).toBe('All types');
  await expectTitles(page, [s.a1.title, s.c1.title, s.c2.title, s.i1.title], { sorted: true });
  expect(control.defaultsPosts()).toHaveLength(1);
});

test('W: an uncertain POST is reconciled before reporting; a rejected Save shows no success', async ({ page }) => {
  seed();
  const control = watch(page);
  await start(page);
  await openDialog(page);
  await choose(page, 'list-sort', 'Title');

  let mode = 'reject';
  await page.route((url) => url.pathname === '/releases/defaults', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    if (mode === 'reject') {
      const sent = new URLSearchParams(route.request().postData() || '');
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({
        status: 'error', committed: false,
        operation: { id: sent.get('defaultsOperation'), kind: 'save', result: 'failed', committed: false,
          expectedGeneration: Number(sent.get('defaultsGeneration')), generation: null },
      }) });
    }
    if (mode === 'gateway') return route.fulfill({ status: 504, contentType: 'application/json', body: '{"status":"success"}' });
    return route.continue();
  });
  await saveButton(page).click();
  await expect(statusLine(page)).toHaveText('Defaults were not saved. Your current choices were kept.');
  await expect(savedConfirmations(page)).toHaveCount(0);
  expect(fixture.releasesKeys()).toEqual([]);

  // A gateway answer (not correlated) is uncertain: reconciled by GET, never
  // reported as success, and later mutations stay blocked until reload.
  mode = 'gateway';
  const reads = control.defaultsGets.length;
  await saveButton(page).click();
  await expect(statusLine(page)).toHaveText(/Could not confirm whether the defaults were saved/);
  expect(control.defaultsGets.length).toBeGreaterThan(reads);
  await expect(savedConfirmations(page)).toHaveCount(0);
  const check = dialog(page).locator('[data-releases-defaults-check]');
  await expect(check).toBeVisible();
  mode = 'pass';
  await check.click();
  await expect(statusLine(page)).toHaveText(/Could not confirm/);
  await resetDefaultsButton(page).click();
  await expect(statusLine(page)).toHaveText(/Reload the page before changing defaults again/);
  expect(control.defaultsPosts()).toHaveLength(2);
  expect(fixture.releasesKeys()).toEqual([]);

  // After reload the barrier is gone and a real Save is acknowledged once.
  await start(page, `${fixture.baseURL}/releases?sort=title`);
  await openDialog(page);
  await saveButton(page).click();
  await expect(statusLine(page)).toHaveText('Defaults saved.');
  expect(fixture.storedReleasesDefaults()).toEqual({ sort: 'title', order: 'asc' });
  expect(control.defaultsPosts()).toHaveLength(3);
  await expect(savedConfirmations(page)).toHaveCount(1);
});

test('fail-closed: partial initialization and no JavaScript never send a defaults mutation', async ({ page, browser }) => {
  const s = seed();
  fixture.writePageDefault('releases', 'sort', 'title');
  const stored = fixture.storedReleasesDefaults();

  const control = watch(page);
  let injected = false;
  await page.route((url) => url.pathname === '/client/releases-filters-defaults.js', async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const signature = 'export function enhanceReleasesFiltersDefaults(document = globalThis.document, options = {}) {';
    injected = source.includes(signature);
    await route.fulfill({ response, body: source.replace(signature, `${signature}\n  throw new Error('Injected WP12 failure');`) });
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.baseURL}/releases?project=${s.comic.id}&search=P`);
  expect(injected).toBe(true);
  await expect.poll(() => control.errors).toContain('Injected WP12 failure');
  await openDialog(page);
  for (const button of [saveButton(page), resetDefaultsButton(page)]) {
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('type', 'button');
    await button.click({ force: true });
  }
  await page.locator('#releases-search').press('Enter');
  await page.waitForTimeout(300);
  expect(control.defaultsPosts()).toEqual([]);
  await expect(page.locator('form[action^="/releases/defaults"]')).toHaveCount(0);

  // No JavaScript: the controls stay inert; Reset filters is a plain GET that
  // keeps the URL page size.
  const context = await browser.newContext({ javaScriptEnabled: false });
  const plain = await context.newPage();
  const plainControl = watch(plain);
  await plain.goto(`${fixture.baseURL}/releases?project=${s.comic.id}&search=P&pageSize=4`);
  await expect(plain.locator('[data-releases-defaults-save]')).toBeDisabled();
  await expect(plain.locator('[data-releases-defaults-reset]')).toBeDisabled();
  await expect(plain.locator('form#releases-defaults-form')).toHaveAttribute('method', 'dialog');
  await Promise.all([
    plain.waitForURL((url) => !url.searchParams.has('project')),
    plain.locator('[data-releases-filters-reset]').evaluate((button) => button.form.submit()),
  ]);
  const plainQuery = new URL(plain.url()).searchParams;
  expect(plainQuery.getAll('project')).toEqual([]);
  expect(plainQuery.get('pageSize')).toBe('4');
  expect(plainQuery.get('sort')).toBe('title');
  expect(plainControl.posts).toEqual([]);
  await context.close();
  expect(fixture.storedReleasesDefaults()).toEqual(stored);
});

test('native Save restores temporary filters through redirect, reload and pagination', async ({ page }) => {
  const s = seed();
  fixture.release(s.comic, 'P Comic Earlier', { plannedDate: '2000-01-03' });
  fixture.release(s.comic, 'P Comic Archived', { plannedDate: '2000-01-03', archived: true });
  fixture.release(s.images, 'P Images Overdue', { plannedDate: '2000-01-04' });
  const control = watch(page);
  const startUrl = releasesUrl(fixture.baseURL, {
    search: 'P', project: [s.comic.id, s.anim.id], type: ['animation', 'comic'], schedule: 'overdue',
    includeArchived: 1, pageSize: 1, page: 2,
  });
  await start(page, startUrl);
  const { generation } = await pageAuthority(page);
  const historyLength = await page.evaluate(() => history.length);
  const destination = releasesUrl(fixture.baseURL, {
    search: 'P', project: [s.comic.id, s.anim.id], type: ['animation', 'comic'], schedule: 'overdue',
    includeArchived: 1, pageSize: 1, sort: 'title', order: 'desc', notice: 'releases_defaults_saved',
  });

  const posted = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/releases/defaults');
  await page.evaluate((generation) => {
    const action = new URL(location.href);
    action.pathname = '/releases/defaults';
    const form = document.createElement('form');
    form.action = action.href;
    form.method = 'POST';
    const fields = {
      _csrf: document.querySelector('input[name="_csrf"]').value,
      defaultsGeneration: String(generation),
      defaultsOperation: 'browser-native-save',
      sort: 'title',
      order: 'desc',
    };
    for (const [name, value] of Object.entries(fields)) {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.value = value;
      form.append(input);
    }
    document.body.append(form);
    form.submit();
  }, generation);

  const response = await posted;
  expect(response.status()).toBe(302);
  expect(new URL(response.headers().location, fixture.baseURL).href).toBe(destination);
  await page.waitForURL(destination);
  await enhanced(page);
  expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);
  await expect(page.getByText('Releases defaults saved successfully.', { exact: true })).toBeVisible();
  await expectTitles(page, [s.c1.title], { total: 3 });

  await page.reload();
  await enhanced(page);
  expect(page.url()).toBe(destination);
  await expectTitles(page, [s.c1.title], { total: 3 });
  await openDialog(page);
  await expect(page.locator('#releases-search')).toHaveValue('P');
  expect((await checkedValues(page, 'release-project-filter')).sort()).toEqual(
    [String(s.comic.id), String(s.anim.id)].sort(),
  );
  expect((await checkedValues(page, 'release-type-filter')).sort()).toEqual(['animation', 'comic']);
  expect(await summaryText(page, 'list-schedule')).toBe('Overdue');
  await expect(page.locator('#list-includeArchived')).toBeChecked();
  expect(await summaryText(page, 'list-sort')).toBe('Title');
  expect(await summaryText(page, 'list-order')).toBe('Descending');
  await closeDialog(page);

  await page.locator('[data-releases-live-region] .pagination').getByRole('link', { name: 'Next', exact: true }).click();
  await expectTitles(page, ['P Comic Earlier'], { total: 3 });
  const next = new URL(destination);
  next.searchParams.delete('notice');
  next.searchParams.set('page', '2');
  const actual = query(page);
  actual.sort();
  next.searchParams.sort();
  expect(actual.toString()).toBe(next.searchParams.toString());

  expect(control.posts).toHaveLength(1);
  expect(control.defaultsPosts()[0]).toMatchObject({ path: '/releases/defaults', type: 'document' });
  expect(fixture.generation()).toBe(generation + 1);
  expect(fixture.storedReleasesDefaults()).toEqual({ sort: 'title', order: 'desc' });
  expect(fixture.releasesKeys()).toHaveLength(2);
  expect(control.errors).toEqual([]);
});

const historyActions = [
  { action: 'Save', button: saveButton, path: '/releases/defaults', message: 'Defaults saved.' },
  { action: 'Reset', button: resetDefaultsButton, path: '/releases/defaults/reset',
    message: 'Defaults reset to the application defaults.' },
];

async function expectHistoryRelease(page, release, project) {
  await expect.poll(() => query(page).get('search')).toBe(release.title);
  await expectTitles(page, [release.title]);
  const rows = page.locator('[data-releases-live-region] .releases-table tbody tr td:first-child a');
  await expect(rows).toHaveAttribute('href', `/releases/${release.id}`);
  await expect(page.locator('#releases-search')).toHaveValue(release.title);
  await expect(page.locator('#release-project-filter input:checked')).toHaveValue(String(project.id));
  expectRepeated(page.url(), 'project', [project.id]);
  expect(query(page).get('pageSize')).toBe('7');
}

for (const { action, button, path, message } of historyActions) {
  for (const scenario of ['failed', 'pending', 'installed', 'retry', 'superseded', 'Back/Forward']) {
    test(`history: ${action} adopts ${scenario} Releases navigation`, async ({ page }) => {
      const { comic: project } = seed();
      if (action === 'Reset') {
        fixture.writePageDefault('releases', 'sort', 'updated');
        fixture.writePageDefault('releases', 'order', 'desc');
      }
      const [origin, alpha, beta, gamma] = ['Origin', 'Alpha', 'Beta', 'Gamma']
        .map((title) => fixture.release(project, title));
      const generation = fixture.generation();
      const recorded = watch(page);
      await page.setViewportSize({ width: 768, height: 680 });
      await page.goto(releasesUrl(fixture.baseURL, {
        search: origin.title, project: project.id, pageSize: 7, sort: 'title', order: 'asc',
      }));
      await enhanced(page);
      await openDialog(page);
      await expectHistoryRelease(page, origin, project);
      const originUrl = page.url();
      const initialLength = await page.evaluate(() => history.length);
      const search = page.locator('#releases-search');
      await search.fill(alpha.title);
      await expectHistoryRelease(page, alpha, project);
      const alphaUrl = page.url();

      const committed = Promise.withResolvers();
      const ack = Promise.withResolvers();
      await page.route((url) => url.pathname === path, async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        const response = await route.fetch();
        committed.resolve(response);
        await ack.promise;
        await route.fulfill({ response });
      });

      const firstBeta = Promise.withResolvers();
      const adoptedBeta = Promise.withResolvers();
      const releaseBeta = Promise.withResolvers();
      const releaseAdopted = Promise.withResolvers();
      let betaGets = 0;
      await page.route((url) => url.pathname === '/releases' && url.searchParams.get('search') === 'Beta', async (route) => {
        if (route.request().resourceType() !== 'fetch') return route.continue();
        betaGets += 1;
        if (betaGets === 1) {
          firstBeta.resolve();
          if (scenario === 'pending') await releaseBeta.promise;
          if (scenario !== 'installed' && scenario !== 'pending') {
            return route.fulfill({ status: 503, body: 'unavailable' });
          }
        } else if (betaGets === 2) {
          adoptedBeta.resolve();
          if (scenario === 'superseded' || scenario === 'Back/Forward') await releaseAdopted.promise;
          if (scenario === 'retry') return route.fulfill({ status: 503, body: 'unavailable' });
        }
        return route.continue();
      });

      const retry = dialog(page).locator('[data-live-filter-retry]');
      try {
        await button(page).click();
        const response = await committed.promise;
        expect(response.status()).toBe(200);
        const posted = recorded.defaultsPosts()[0];
        expect(posted.path).toBe(path);
        expect(posted.body.get('_csrf')).toBeTruthy();
        expect((await response.json()).operation).toMatchObject({
          id: posted.body.get('defaultsOperation'), committed: true,
          expectedGeneration: generation, generation: generation + 1,
        });

        await search.fill(beta.title);
        await firstBeta.promise;
        if (scenario === 'installed') {
          await expectHistoryRelease(page, beta, project);
        } else if (scenario !== 'pending') {
          await expect(retry).toBeVisible();
          // The form keeps the failed draft while the address and rows still show Alpha.
          expect(query(page).get('search')).toBe(alpha.title);
          await expectTitles(page, [alpha.title]);
        }

        ack.resolve();
        await adoptedBeta.promise;
        releaseBeta.resolve();
        if (scenario === 'retry') {
          await expect(statusLine(page)).toContainText('could not be refreshed');
          await retry.click();
        } else if (scenario === 'superseded') {
          await search.fill(gamma.title);
          await expectHistoryRelease(page, gamma, project);
          releaseAdopted.resolve();
        } else if (scenario === 'Back/Forward') {
          await page.goBack();
          await expectHistoryRelease(page, origin, project);
          const forward = Promise.withResolvers();
          const releaseForward = Promise.withResolvers();
          await page.route((url) => url.pathname === '/releases' && url.searchParams.get('search') === 'Alpha', async (route) => {
            forward.resolve();
            await releaseForward.promise;
            await route.continue();
          });
          try {
            await page.goForward();
            await forward.promise;
            releaseAdopted.resolve();
          } finally {
            releaseForward.resolve();
          }
          await expectHistoryRelease(page, alpha, project);
        }

        const last = scenario === 'superseded' ? gamma : scenario === 'Back/Forward' ? alpha : beta;
        await expectHistoryRelease(page, last, project);
        const lastUrl = page.url();
        await expect(statusLine(page)).toHaveText(message);
        await settled(page);
        expect(recorded.defaultsPosts()).toHaveLength(1);
        expect(recorded.gets.filter((url) => url.searchParams.get('search') === 'Beta'))
          .toHaveLength(scenario === 'retry' ? 3 : 2);
        expect(fixture.generation()).toBe(generation + 1);
        expect(fixture.readPageDefault('projects', 'sort')).toBe('title');
        expect(fixture.readPageDefault('assetViewer', 'sort')).toBe('size');
        expect(fixture.storedReleasesDefaults()).toEqual(action === 'Save'
          ? { sort: 'title', order: 'asc' } : { sort: undefined, order: undefined });
        expect(fixture.releasesKeys()).toHaveLength(action === 'Save' ? 2 : 0);

        await page.goBack();
        if (scenario !== 'Back/Forward') {
          await expectHistoryRelease(page, alpha, project);
          expect(page.url()).toBe(alphaUrl);
          await page.goBack();
        }
        await expectHistoryRelease(page, origin, project);
        expect(page.url()).toBe(originUrl);
        await page.goForward();
        await expectHistoryRelease(page, alpha, project);
        expect(page.url()).toBe(alphaUrl);
        if (scenario !== 'Back/Forward') {
          await page.goForward();
          await expectHistoryRelease(page, last, project);
          expect(page.url()).toBe(lastUrl);
        }
        expect(await page.evaluate(() => history.length))
          .toBe(initialLength + (scenario === 'Back/Forward' ? 1 : 2));
        expect(recorded.defaultsPosts()).toHaveLength(1);
        expect(recorded.errors).toEqual([]);
      } finally {
        ack.resolve();
        releaseBeta.resolve();
        releaseAdopted.resolve();
      }
    });
  }
}
