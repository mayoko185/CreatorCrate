import { expect, test } from '@playwright/test';
import {
  NINE, TEMPORARY, choose, closeDialog, createLibraryFixture, dialog, openDialog, openDropdown, pageAuthority, query,
  renderedAssetIds, settled, totalText, watch,
} from './asset-library-filters-defaults-fixture.js';

// WP9b K–T: explicit Save, Reset filters, Reset defaults and the WP9a
// generation/acknowledgement protocol through the combined dialog, against
// the real routes and the installed adapter. Failures are produced only by
// intercepting the network (route), never by mocking the UI.

const fixture = createLibraryFixture('asset-library-fd-persistence');

test.beforeAll(async () => {
  await fixture.start();
});

test.afterAll(async () => {
  await fixture.stop();
});

let tagIds = {};
async function seed() {
  fixture.isolate();
  const comic = await fixture.project('Persist Comic', 'comic', [
    'c01.png', 'c02.png', 'c03.png', 'c04.png', 'c05.png', 'c06.png', 'c07.jpg', 'c08.jpg',
    { name: 'c09.png', width: 96, height: 24 }, 'c10.png', 'c11.png',
  ]);
  const images = await fixture.project('Persist Images', 'images', ['i01.png', 'i02.png', 'i03.png', 'i04.jpg']);
  const tags = fixture.state.app.locals.tagService;
  tagIds = {};
  for (const name of ['Keep', 'Other']) {
    tagIds[name] = tags.listTags?.().find((tag) => tag.display_name === name || tag.displayName === name)?.id
      ?? tags.createTag({ name }).id;
  }
  for (const id of [...comic.assetIds, ...images.assetIds]) {
    fixture.state.app.locals.assetTagService.replaceAssetTags(id, [tagIds.Keep]);
  }
  return { comic, images };
}

const status = (page) => page.locator('#asset-viewer-defaults-form [data-settings-fetch-save-status]');
const indicator = (page) => page.locator('[data-asset-library-defaults-indicator]');
const saveButton = (page) => dialog(page).getByRole('button', { name: 'Save new defaults', exact: true });
const resetFiltersButton = (page) => dialog(page).getByRole('button', { name: 'Reset filters', exact: true });
const resetDefaultsButton = (page) => dialog(page).getByRole('button', { name: 'Reset defaults', exact: true });

function nineOf(body) {
  return Object.fromEntries(NINE.map((field) => {
    const values = body.getAll(field);
    return [field, values.length > 1 ? values : values[0]];
  }));
}

test('N, O, P: ordinary edits never POST; Save sends one coherent nine-setting snapshot and updates status', async ({ page }) => {
  const { comic, images } = await seed();
  const control = watch(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.baseURL}/asset-viewer`);
  await openDialog(page);

  await choose(page, 'asset-project-filter', comic.title, { search: 'comic' });
  await choose(page, 'asset-project-filter', images.title, { search: 'images' });
  await choose(page, 'asset-project-type-filter', 'Comic');
  await choose(page, 'asset-project-type-filter', 'Images');
  await page.locator('#asset-library-search').fill('0');
  await expect.poll(() => query(page).get('search')).toBe('0');
  await settled(page);
  await choose(page, 'asset-usage-filter', 'Not used in releases');
  await choose(page, 'asset-extension-filter', '.png');
  await choose(page, 'asset-tag-filter', 'Keep');
  await choose(page, 'asset-presence-filter', 'Present');
  await choose(page, 'asset-sort-filter', 'Size');
  await choose(page, 'asset-order-filter', 'Descending');
  await choose(page, 'asset-page-size-filter', '50');
  // R2: Grid style is chosen while the View is still Grid; List then hides
  // it and retains the choice.
  await choose(page, 'asset-grid-style-filter', 'Cropped');
  await choose(page, 'asset-view-filter', 'List');
  await expect(page.locator('[data-asset-library-live-region] .asset-list')).toHaveCount(1);
  await expect(indicator(page)).toHaveText('No saved defaults · Current settings differ from the application defaults.');
  expect(control.defaultsPosts()).toEqual([]);
  const generation = fixture.generation();

  await saveButton(page).click();
  await expect(status(page)).toHaveText('Defaults saved.');
  // R1: the indicator now reads exactly the status line, so it steps aside.
  await expect(indicator(page)).toHaveText('Defaults saved.');
  await expect(indicator(page)).toBeHidden();
  await settled(page);

  expect(control.defaultsPosts()).toHaveLength(1);
  const [{ path, body }] = control.defaultsPosts();
  expect(path).toBe('/asset-viewer/defaults');
  expect(nineOf(body)).toEqual({
    view: 'list', gridStyle: 'cropped', sort: 'size', order: 'desc', pageSize: '50',
    extension: 'png', category: 'all', presence: 'present', tag: String(tagIds.Keep),
  });
  for (const key of TEMPORARY) expect(body.has(key)).toBe(false);
  expect(body.get('defaultsGeneration')).toBe(String(generation));
  expect(body.get('defaultsOperation')).toMatch(/\S{8,}/);
  expect(body.get('returnTo')).toContain(`project=${comic.id}&project=${images.id}`);
  expect(fixture.generation()).toBe(generation + 1);
  expect(fixture.readPageDefault('assetViewer', 'gridStyle')).toBe('cropped');
  expect(fixture.readPageDefault('assetViewer', 'view')).toBe('list');

  // The temporary context stays applied and is never stored.
  expect(query(page).getAll('project')).toEqual([String(comic.id), String(images.id)]);
  expect(query(page).getAll('type')).toEqual(['comic', 'images']);
  expect(query(page).get('search')).toBe('0');
  expect(query(page).get('usage')).toBe('unused');
  // An explicitly saved fallback value is still reported as saved.
  const authority = await pageAuthority(page);
  expect(authority.saved.category).toEqual({ stored: true, valid: true });
  expect(authority.savedKeys).toEqual(NINE);
  expect(control.errors).toEqual([]);
});

test('K, L: Reset filters restores all nine saved values with real presentation and clears temporary filters', async ({ page }) => {
  const { comic, images } = await seed();
  // Saved: Grid + Cropped, 10 per page, Size ↓, PNG, Present, tag Keep
  // (12 matching PNGs, so the saved page size really paginates).
  for (const [option, value] of Object.entries({
    view: 'grid', gridStyle: 'cropped', sort: 'size', order: 'desc', pageSize: '10',
    extension: '["png"]', category: 'all', presence: 'present', tag: `["${tagIds.Keep}"]`,
  })) fixture.writePageDefault('assetViewer', option, value);
  const control = watch(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  // Current: List, every temporary filter, and other default-backed values.
  await page.goto(`${fixture.baseURL}/asset-viewer?project=${comic.id}&project=${images.id}&type=comic&type=images&search=0&usage=unused&extension=jpg&sort=filename&order=asc&pageSize=25&view=list&page=1`);
  await expect(page.locator('[data-asset-library-live-region] .asset-list')).toHaveCount(1);
  await openDialog(page);
  // R2: List hides (and retains) the Grid style field, so the session choice
  // is set through its native control, as the other Grid style specs do.
  await page.locator('#asset-library-grid-style').selectOption('uncropped', { force: true });
  await expect(page.locator('#asset-library-grid-style')).toHaveValue('uncropped');

  await resetFiltersButton(page).click();
  await expect.poll(() => new URL(page.url()).search).not.toContain('project=');
  await settled(page);
  const url = query(page);
  for (const key of [...TEMPORARY, 'page']) expect(url.has(key)).toBe(false);
  expect(url.get('pageSize')).toBe('10');
  expect(url.get('sort')).toBe('size');
  expect(url.getAll('extension')).toEqual(['png']);
  // Actual presentation, not just control labels: a cropped Grid of 10.
  const grid = page.locator('[data-asset-library-live-region] ul.asset-grid');
  await expect(grid).toHaveAttribute('data-grid-style', 'cropped');
  await expect(page.locator('[data-asset-library-live-region] .asset-list')).toHaveCount(0);
  expect((await renderedAssetIds(page)).length).toBe(10);
  await expect(page.locator('nav.pagination')).toBeVisible();
  await expect(page.locator('#asset-library-grid-style')).toHaveValue('cropped');
  await expect(page.locator('#asset-library-search')).toHaveValue('');
  await expect(page.locator('#asset-project-filter input[data-cc-dropdown-select-all]')).toBeChecked();
  await expect(page.locator('#asset-project-type-filter input[data-cc-dropdown-select-all]')).toBeChecked();
  expect(control.defaultsPosts()).toEqual([]);
  expect(fixture.readPageDefault('assetViewer', 'pageSize')).toBe('10');

  // A saved List View restores an actual List.
  fixture.writePageDefault('assetViewer', 'view', 'list');
  await choose(page, 'asset-view-filter', 'Grid');
  await resetFiltersButton(page).click();
  await expect(page.locator('[data-asset-library-live-region] .asset-list')).toHaveCount(1);
  await expect(page.locator('#asset-view-filter input[value="list"]')).toBeChecked();
  expect(control.defaultsPosts()).toEqual([]);
});

test('M: Reset defaults deletes only the nine keys and keeps the temporary context', async ({ page }) => {
  const { comic, images } = await seed();
  for (const option of NINE) {
    fixture.writePageDefault('assetViewer', option, {
      view: 'list', gridStyle: 'cropped', sort: 'size', order: 'desc', pageSize: '10',
      extension: '["png"]', category: 'all', presence: 'present', tag: 'all',
    }[option]);
  }
  fixture.writePageDefault('projectAssets', 'view', 'list');
  fixture.writePageDefault('projects', 'sort', 'title');
  const control = watch(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.baseURL}/asset-viewer?project=${comic.id}&project=${images.id}&type=comic&type=images&search=0&usage=unused&view=list`);
  await openDialog(page);
  await expect(indicator(page)).toHaveText(/^Defaults saved/);
  const generation = fixture.generation();

  await resetDefaultsButton(page).click();
  await expect(status(page)).toHaveText('Defaults reset to the application defaults.');
  await expect(indicator(page)).toHaveText('No saved defaults.');
  await settled(page);

  expect(control.defaultsPosts().map((post) => post.path)).toEqual(['/asset-viewer/defaults/reset']);
  const { body } = control.defaultsPosts()[0];
  expect(body.get('defaultsGeneration')).toBe(String(generation));
  expect(fixture.generation()).toBe(generation + 1);
  for (const option of NINE) expect(fixture.readPageDefault('assetViewer', option)).toBeUndefined();
  expect(fixture.readPageDefault('projectAssets', 'view')).toBe('list');
  expect(fixture.readPageDefault('projects', 'sort')).toBe('title');
  // The temporary context survives with repeated keys; default-backed
  // controls follow the application fallbacks (Grid, Uncropped, 25).
  expect(query(page).getAll('project')).toEqual([String(comic.id), String(images.id)]);
  expect(query(page).getAll('type')).toEqual(['comic', 'images']);
  expect(query(page).get('search')).toBe('0');
  expect(query(page).get('usage')).toBe('unused');
  await expect(page.locator('[data-asset-library-live-region] ul.asset-grid')).toHaveAttribute('data-grid-style', 'uncropped');
  await expect(page.locator('#asset-library-grid-style')).toHaveValue('uncropped');

  // A no-op Reset still advances the durable generation.
  await resetDefaultsButton(page).click();
  await expect.poll(() => fixture.generation()).toBe(generation + 2);
  await expect(status(page)).toHaveText('Defaults reset to the application defaults.');
  expect(control.defaultsPosts()).toHaveLength(2);
});

test('Q: a newer edit made while Save is pending survives the acknowledgement', async ({ page }) => {
  await seed();
  const control = watch(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.baseURL}/asset-viewer`);
  await openDialog(page);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await page.route((url) => url.pathname === '/asset-viewer/defaults', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await held;
    return route.continue();
  });
  await choose(page, 'asset-sort-filter', 'Size');
  await saveButton(page).click();
  await expect(status(page)).toHaveText('Saving defaults.');
  await expect(saveButton(page)).toHaveAttribute('aria-disabled', 'true');
  // A newer explicit choice while the POST is in flight.
  await choose(page, 'asset-order-filter', 'Descending');
  await expect.poll(() => query(page).get('order')).toBe('desc');
  release();
  await expect(status(page)).toHaveText('Defaults saved.');
  await settled(page);
  expect(control.defaultsPosts()).toHaveLength(1);
  expect(nineOf(control.defaultsPosts()[0].body)).toMatchObject({ sort: 'size', order: 'asc' });
  expect(fixture.readPageDefault('assetViewer', 'order')).toBe('asc');
  // The newer edit is still the page state, and is shown as unsaved.
  expect(query(page).get('order')).toBe('desc');
  await expect(page.locator('#asset-order-filter input[value="desc"]')).toBeChecked();
  await expect(indicator(page)).toHaveText('Defaults saved · Current settings differ from the saved defaults.');
  await expect(saveButton(page)).not.toHaveAttribute('aria-disabled', 'true');
});

test('R: a confirmed Save whose refresh GET fails recovers by GET only', async ({ page }) => {
  await seed();
  const control = watch(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.baseURL}/asset-viewer`);
  await openDialog(page);
  await choose(page, 'asset-page-size-filter', '10');
  let failNextGet = false;
  await page.route((url) => url.pathname === '/asset-viewer', (route) => {
    if (failNextGet && route.request().method() === 'GET' && route.request().resourceType() === 'fetch') {
      failNextGet = false;
      return route.fulfill({ status: 503, body: 'unavailable' });
    }
    return route.continue();
  });
  failNextGet = true;
  await saveButton(page).click();
  await expect(status(page)).toHaveText('Defaults were saved, but the Asset Viewer could not be refreshed. Retry to refresh the page.');
  expect(fixture.readPageDefault('assetViewer', 'pageSize')).toBe('10');
  const retry = dialog(page).locator('[data-live-filter-retry]');
  await expect(retry).toBeVisible();
  // No contradictory "not saved" message is shown.
  await expect(dialog(page)).not.toContainText('Defaults were not saved');

  await retry.click();
  await expect(status(page)).toHaveText('Defaults saved.');
  await settled(page);
  expect(control.defaultsPosts()).toHaveLength(1);
  await expect(dialog(page).locator('[data-live-filter-failure]')).toHaveCount(0);
});

test('S: an incomplete Reset filters installation cannot enable a stale-state Save', async ({ page }) => {
  await seed();
  fixture.writePageDefault('assetViewer', 'sort', 'size');
  const control = watch(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.baseURL}/asset-viewer?sort=filename&order=desc`);
  await openDialog(page);
  let failReset = true;
  await page.route((url) => url.pathname === '/asset-viewer' && url.searchParams.get('resetFilters') === '1', (route) => {
    if (failReset) return route.fulfill({ status: 500, body: 'failed' });
    return route.continue();
  });
  await resetFiltersButton(page).click();
  const retry = dialog(page).locator('[data-live-filter-retry]');
  await expect(retry).toBeVisible();
  await saveButton(page).click();
  await expect(status(page)).toHaveText('Reset filters did not finish. Retry loading the page before saving defaults.');
  expect(control.defaultsPosts()).toEqual([]);

  failReset = false;
  await retry.click();
  await expect.poll(() => query(page).get('sort')).toBe('size');
  await settled(page);
  await saveButton(page).click();
  await expect(status(page)).toHaveText('Defaults saved.');
  expect(control.defaultsPosts()).toHaveLength(1);
  expect(nineOf(control.defaultsPosts()[0].body)).toMatchObject({ sort: 'size', order: 'asc' });
});

test('T: a generation conflict writes nothing, keeps the current choices and is never resent', async ({ page }) => {
  await seed();
  const control = watch(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.baseURL}/asset-viewer`);
  await openDialog(page);
  await choose(page, 'asset-sort-filter', 'Size');
  const generation = fixture.generation();

  // Another tab saves first (its own generation-fenced write).
  const csrf = await page.locator('#asset-viewer-defaults-form input[name="_csrf"]').inputValue();
  const other = await page.request.post(`${fixture.baseURL}/asset-viewer/defaults`, {
    headers: { Accept: 'application/json' },
    form: {
      _csrf: csrf, returnTo: '/asset-viewer', defaultsGeneration: String(generation), defaultsOperation: 'other-tab-1',
      view: 'list', gridStyle: 'uncropped', sort: 'modified', order: 'asc', pageSize: '25',
      extension: 'all', category: 'all', presence: 'all', tag: 'all',
    },
  });
  expect(other.status()).toBe(200);
  expect(fixture.generation()).toBe(generation + 1);

  await saveButton(page).click();
  await expect(status(page)).toHaveText('Defaults were not saved because the saved defaults changed elsewhere. Your current choices were kept. Check the saved defaults, then save again.');
  expect(control.defaultsPosts()).toHaveLength(1);
  expect(fixture.readPageDefault('assetViewer', 'sort')).toBe('modified');
  expect(fixture.generation()).toBe(generation + 1);
  expect(query(page).get('sort')).toBe('size');
  await expect(page.locator('#asset-sort-filter input[value="size"]')).toBeChecked();
  // The conflict answer's authority now shows the other tab's saved state.
  await expect(indicator(page)).toHaveText('Defaults saved · Current settings differ from the saved defaults.');
  await page.waitForTimeout(500);
  expect(control.defaultsPosts()).toHaveLength(1);

  // A deliberate second Save is based on the current generation and succeeds.
  await saveButton(page).click();
  await expect(status(page)).toHaveText('Defaults saved.');
  expect(control.defaultsPosts()).toHaveLength(2);
  expect(control.defaultsPosts()[1].body.get('defaultsGeneration')).toBe(String(generation + 1));
  expect(fixture.readPageDefault('assetViewer', 'sort')).toBe('size');
  await expect.poll(() => totalText(page)).toMatch(/assets found$/);
});

/*
 * WP9b F2 — Save new defaults is JavaScript-only. The explicit-save
 * controller is the sole owner of the mutation: without it (JavaScript off,
 * or an initialization failure before it binds) no path of the form may POST
 * defaults, and with it every path goes through its coherent snapshot.
 */
const STORED = Object.freeze({
  view: 'grid', gridStyle: 'uncropped', sort: 'filename', order: 'asc', pageSize: '25',
  extension: 'all', category: 'all', presence: 'all', tag: 'all',
});

function storeDefaults() {
  for (const [option, value] of Object.entries(STORED)) fixture.writePageDefault('assetViewer', option, value);
}

function storedDefaults() {
  return Object.fromEntries(NINE.map((option) => [option, fixture.readPageDefault('assetViewer', option)]));
}

// Every stored Asset Library defaults key (the nine and anything else).
function storedAssetViewerKeys() {
  return fixture.state.db.prepare("SELECT key FROM app_meta WHERE key LIKE 'page_defaults.asset_viewer.%' ORDER BY key")
    .all().map((row) => row.key);
}

// Tries every way the native form could still submit, by pointer, keyboard,
// requestSubmit() and submit(); none may reach the defaults routes.
async function attemptNativeSave(page, { scripts = true } = {}) {
  const save = saveButton(page);
  await save.click({ force: true, timeout: 2_000 }).catch(() => {});
  await page.waitForLoadState('load');
  if (await save.count()) await save.press('Enter', { timeout: 2_000 }).catch(() => {});
  await page.waitForLoadState('load');
  if (scripts && await save.count()) {
    await page.evaluate(() => {
      const form = document.getElementById('asset-viewer-defaults-form');
      try { form.requestSubmit(); } catch { /* not submittable */ }
      try { form.submit(); } catch { /* not submittable */ }
    });
    await page.waitForLoadState('load');
  }
}

test.describe('F2-A: JavaScript disabled', () => {
  test.use({ javaScriptEnabled: false });

  test('no native path of the combined dialog persists defaults', async ({ page }) => {
    await seed();
    storeDefaults();
    const generation = fixture.generation();
    const before = storedDefaults();
    const control = watch(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${fixture.baseURL}/asset-viewer?defaults=1`);
    await expect(dialog(page)).toBeVisible();

    // Visible choices a user could make without scripts.
    await page.locator('#asset-sort-filter summary').click();
    await page.locator('#asset-sort-filter input[value="size"]').check({ force: true });
    await page.locator('#asset-library-grid-style').selectOption('cropped', { force: true });
    await expect(saveButton(page)).toBeVisible();

    await attemptNativeSave(page, { scripts: false });
    expect(control.defaultsPosts().map(({ type, body }) => `${type}: sort=${body.get('sort')} gridStyle=${body.get('gridStyle')}`)).toEqual([]);
    // Enter in a text field implicitly submits only the GET filter form.
    await page.goto(`${fixture.baseURL}/asset-viewer?defaults=1`);
    await page.locator('#asset-library-search').press('Enter');
    await page.waitForLoadState('load');

    expect(control.defaultsPosts()).toEqual([]);
    expect(storedDefaults()).toEqual(before);
    expect(storedAssetViewerKeys()).toHaveLength(NINE.length);
    expect(fixture.generation()).toBe(generation);

    // The Save mechanism: not a native submit control and not usable, and the
    // form carries no saveable snapshot a native POST could send.
    await page.goto(`${fixture.baseURL}/asset-viewer?defaults=1`);
    await expect(saveButton(page)).toBeDisabled();
    await expect(saveButton(page)).toHaveAttribute('type', 'button');
    for (const field of [...NINE, 'defaultsGeneration', 'returnTo']) {
      await expect(page.locator(`#asset-viewer-defaults-form [name="${field}"]`)).toHaveCount(0);
    }
  });
});

test('F2-B: a controller initialization failure leaves Save inert, never a native POST', async ({ page }) => {
  await seed();
  storeDefaults();
  const generation = fixture.generation();
  const before = storedDefaults();
  let injected = false;
  // The module loads, but enhancement fails immediately before the explicit
  // controller would bind.
  await page.route((url) => url.pathname === '/client/asset-library-filters-defaults.js', async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const signature = 'export function enhanceAssetLibraryFiltersDefaults(document = globalThis.document, options = {}) {';
    injected = source.includes(signature);
    await route.fulfill({
      response,
      body: source.replace(signature, `${signature}\n  throw new Error('Injected WP9b controller initialization failure');`),
    });
  });
  const control = watch(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.baseURL}/asset-viewer`);
  expect(injected).toBe(true);
  await expect.poll(() => control.errors).toContain('Injected WP9b controller initialization failure');
  await openDialog(page);

  // Live filtering still works; Save stays inert.
  await choose(page, 'asset-sort-filter', 'Size');
  await expect.poll(() => query(page).get('sort')).toBe('size');
  await attemptNativeSave(page);

  expect(control.defaultsPosts().map(({ type, body }) => `${type}: sort=${body.get('sort')}`)).toEqual([]);
  expect(storedDefaults()).toEqual(before);
  expect(fixture.generation()).toBe(generation);
  await page.goto(`${fixture.baseURL}/asset-viewer`);
  await openDialog(page);
  await expect(saveButton(page)).toBeDisabled();
});

test('F2-C: a keyboard Save sends one controller-owned snapshot of the current settings', async ({ page }) => {
  const { comic } = await seed();
  storeDefaults();
  const generation = fixture.generation();
  const control = watch(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.baseURL}/asset-viewer`);
  await openDialog(page);
  await expect(saveButton(page)).toBeEnabled();

  await choose(page, 'asset-project-filter', comic.title, { search: 'comic' });
  await page.locator('#asset-library-search').fill('c0');
  await expect.poll(() => query(page).get('search')).toBe('c0');
  await settled(page);
  await choose(page, 'asset-sort-filter', 'Size');
  await choose(page, 'asset-order-filter', 'Descending');
  await choose(page, 'asset-extension-filter', '.png');
  await choose(page, 'asset-grid-style-filter', 'Cropped');
  expect(control.defaultsPosts()).toEqual([]);

  const answer = page.waitForResponse((response) => new URL(response.url()).pathname === '/asset-viewer/defaults'
    && response.request().method() === 'POST');
  await saveButton(page).focus();
  await page.keyboard.press('Enter');
  const payload = await (await answer).json();
  await expect(status(page)).toHaveText('Defaults saved.');
  await settled(page);

  expect(control.defaultsPosts()).toHaveLength(1);
  const [{ body, type }] = control.defaultsPosts();
  expect(type).toBe('fetch');
  expect(nineOf(body)).toEqual({
    view: 'grid', gridStyle: 'cropped', sort: 'size', order: 'desc', pageSize: '25',
    extension: 'png', category: 'all', presence: 'all', tag: 'all',
  });
  for (const key of TEMPORARY) expect(body.has(key)).toBe(false);
  expect(body.get('defaultsGeneration')).toBe(String(generation));
  // The correlated acknowledgement of exactly this request.
  expect(payload.operation).toMatchObject({
    id: body.get('defaultsOperation'), kind: 'save', result: 'committed',
    expectedGeneration: generation, generation: generation + 1,
  });
  expect(fixture.generation()).toBe(generation + 1);
  expect(fixture.readPageDefault('assetViewer', 'sort')).toBe('size');
  expect(fixture.readPageDefault('assetViewer', 'gridStyle')).toBe('cropped');
  expect(fixture.readPageDefault('assetViewer', 'order')).toBe('desc');
  expect(JSON.parse(fixture.readPageDefault('assetViewer', 'extension'))).toEqual(['png']);
  expect(fixture.readPageDefault('assetViewer', 'view')).toBe('grid');
  // Temporary filters stay applied and are never stored.
  expect(storedAssetViewerKeys()).toHaveLength(NINE.length);
  expect(query(page).getAll('project')).toEqual([String(comic.id)]);
  expect(query(page).get('search')).toBe('c0');
});

test('F2-D: Save during a pending filter GET posts nothing stale; after installation it saves the newer choice', async ({ page }) => {
  await seed();
  storeDefaults();
  const generation = fixture.generation();
  const control = watch(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.baseURL}/asset-viewer`);
  await openDialog(page);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let arrived;
  const arrival = new Promise((resolve) => { arrived = resolve; });
  await page.route((url) => url.pathname === '/asset-viewer' && url.searchParams.get('sort') === 'size', async (route) => {
    if (route.request().resourceType() !== 'fetch') return route.continue();
    arrived();
    await held;
    return route.continue().catch(() => {});
  });

  // A newer visible choice whose GET is still pending.
  const sort = await openDropdown(page, 'asset-sort-filter');
  await sort.locator('.asset-filter-multiselect-option label').getByText('Size', { exact: true }).click();
  await arrival;
  await expect(page.locator('[data-asset-library-live-region]')).toHaveAttribute('aria-busy', 'true');
  await saveButton(page).click();
  await expect(status(page)).toHaveText('The Asset Viewer is still loading. Save again when it has finished.');
  await page.evaluate(() => document.getElementById('asset-viewer-defaults-form').requestSubmit());
  await expect(status(page)).toHaveText('The Asset Viewer is still loading. Save again when it has finished.');
  expect(control.defaultsPosts()).toEqual([]);
  expect(fixture.generation()).toBe(generation);

  release();
  await settled(page);
  await expect.poll(() => query(page).get('sort')).toBe('size');
  await saveButton(page).click();
  await expect(status(page)).toHaveText('Defaults saved.');
  expect(control.defaultsPosts()).toHaveLength(1);
  expect(nineOf(control.defaultsPosts()[0].body)).toMatchObject({ sort: 'size' });
  expect(fixture.readPageDefault('assetViewer', 'sort')).toBe('size');
  expect(fixture.generation()).toBe(generation + 1);
});

test('F2-E: reopening and live replacements keep exactly one controller-owned Save path', async ({ page }) => {
  await seed();
  storeDefaults();
  const generation = fixture.generation();
  const control = watch(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.baseURL}/asset-viewer`);
  for (let round = 0; round < 3; round += 1) {
    await openDialog(page);
    await choose(page, 'asset-order-filter', round % 2 === 0 ? 'Descending' : 'Ascending');
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
  }
  await openDialog(page);
  await choose(page, 'asset-sort-filter', 'Size');
  await expect(saveButton(page)).toBeEnabled();
  await expect(saveButton(page)).toHaveAttribute('type', 'button');

  await saveButton(page).click();
  await expect(status(page)).toHaveText('Defaults saved.');
  await settled(page);
  expect(control.defaultsPosts()).toHaveLength(1);
  expect(nineOf(control.defaultsPosts()[0].body)).toMatchObject({ sort: 'size', order: 'desc' });

  // requestSubmit() is owned by the same controller: one fetch, no document POST.
  await choose(page, 'asset-order-filter', 'Ascending');
  await page.evaluate(() => document.getElementById('asset-viewer-defaults-form').requestSubmit());
  await expect.poll(() => control.defaultsPosts().length).toBe(2);
  await expect(status(page)).toHaveText('Defaults saved.');
  await page.waitForTimeout(300);
  expect(control.defaultsPosts()).toHaveLength(2);
  expect(control.defaultsPosts().map((post) => post.type)).toEqual(['fetch', 'fetch']);
  expect(nineOf(control.defaultsPosts()[1].body)).toMatchObject({ sort: 'size', order: 'asc' });
  expect(fixture.generation()).toBe(generation + 2);
  await expect(dialog(page)).toBeVisible();
});

// ── WP9b F3: Reset defaults is controller-owned (the F2 fail-closed pattern).
// No native or uncontrolled path may delete the saved defaults. ──

// Tries every way a native Reset defaults could still submit: pointer,
// keyboard (Enter and Space) and, with scripts, requestSubmit()/submit() of
// any form that still contains the control.
async function attemptNativeResetDefaults(page, { scripts = true } = {}) {
  const reset = resetDefaultsButton(page);
  await reset.click({ force: true, timeout: 2_000 }).catch(() => {});
  await page.waitForLoadState('load');
  for (const key of ['Enter', 'Space']) {
    if (await reset.count()) await reset.press(key, { timeout: 2_000 }).catch(() => {});
    await page.waitForLoadState('load');
  }
  if (scripts && await reset.count()) {
    await page.evaluate(() => {
      const control = document.querySelector('[data-asset-library-defaults-reset]');
      const form = control?.form || control?.closest('form') || document.getElementById('asset-viewer-defaults-reset-form');
      if (!form) return;
      try { form.requestSubmit(control?.type === 'submit' ? control : undefined); } catch { /* not submittable */ }
      try { form.submit(); } catch { /* not submittable */ }
    });
    await page.waitForLoadState('load');
  }
}

// Records top-level document navigations from now on.
function trackNavigations(page) {
  const navigations = [];
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations.push(frame.url());
  });
  return navigations;
}

test.describe('F3-A: JavaScript disabled', () => {
  test.use({ javaScriptEnabled: false });

  test('no native path of Reset defaults deletes the saved defaults', async ({ page }) => {
    await seed();
    storeDefaults();
    const generation = fixture.generation();
    const before = storedDefaults();
    const control = watch(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${fixture.baseURL}/asset-viewer?defaults=1`);
    await expect(dialog(page)).toBeVisible();
    await expect(resetDefaultsButton(page)).toBeVisible();

    await attemptNativeResetDefaults(page, { scripts: false });

    expect(control.defaultsPosts().map((post) => `${post.type} ${post.path}`)).toEqual([]);
    expect(storedDefaults()).toEqual(before);
    expect(storedAssetViewerKeys()).toHaveLength(NINE.length);
    expect(fixture.generation()).toBe(generation);
    expect(new URL(page.url()).searchParams.get('notice')).toBeNull();
    await expect(page.getByText('Defaults reset to the application defaults.')).toHaveCount(0);
    // The control is inert and never a native submit control.
    await expect(resetDefaultsButton(page)).toBeDisabled();
    await expect(resetDefaultsButton(page)).toHaveAttribute('type', 'button');
    await expect(page.locator('form[action="/asset-viewer/defaults/reset"]')).toHaveCount(0);
  });
});

async function injectControllerFailure(page) {
  const injection = { injected: false };
  await page.route((url) => url.pathname === '/client/asset-library-filters-defaults.js', async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const signature = 'export function enhanceAssetLibraryFiltersDefaults(document = globalThis.document, options = {}) {';
    injection.injected = source.includes(signature);
    await route.fulfill({
      response,
      body: source.replace(signature, `${signature}\n  throw new Error('Injected WP9b controller initialization failure');`),
    });
  });
  return injection;
}

for (const pendingKind of ['Project', 'Search']) {
  test(`F3-B: a controller initialization failure leaves Reset defaults inert during a pending ${pendingKind} change`, async ({ page }) => {
    const { comic } = await seed();
    storeDefaults();
    const generation = fixture.generation();
    const before = storedDefaults();
    const injection = await injectControllerFailure(page);
    const control = watch(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${fixture.baseURL}/asset-viewer`);
    expect(injection.injected).toBe(true);
    await expect.poll(() => control.errors).toContain('Injected WP9b controller initialization failure');
    await openDialog(page);
    const startUrl = page.url();
    const navigations = trackNavigations(page);

    // Hold the GET of the pending temporary change.
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let arrived;
    const arrival = new Promise((resolve) => { arrived = resolve; });
    await page.route((url) => url.pathname === '/asset-viewer'
      && (url.searchParams.has('project') || url.searchParams.get('search') === 'c0'), async (route) => {
      if (route.request().resourceType() !== 'fetch') return route.continue();
      arrived();
      await held;
      return route.continue().catch(() => {});
    });
    if (pendingKind === 'Project') {
      const projects = await openDropdown(page, 'asset-project-filter');
      await projects.locator('[data-cc-dropdown-search]').fill('comic');
      await projects.locator('.asset-filter-multiselect-option label').getByText(comic.title, { exact: true }).click();
      await arrival;
      await projects.locator('summary').click();
    } else {
      await page.locator('#asset-library-search').fill('c0');
      await arrival;
    }

    await attemptNativeResetDefaults(page);

    expect(control.defaultsPosts().map((post) => `${post.type} ${post.path}`)).toEqual([]);
    expect(storedDefaults()).toEqual(before);
    expect(storedAssetViewerKeys()).toHaveLength(NINE.length);
    expect(fixture.generation()).toBe(generation);
    expect(navigations).toEqual([]);
    expect(page.url()).toBe(startUrl);
    await expect(resetDefaultsButton(page)).toBeDisabled();
    release();
  });
}

test('F3-C: Reset defaults is one controller-owned POST that keeps the latest temporary context', async ({ page }) => {
  const { comic, images } = await seed();
  storeDefaults();
  const generation = fixture.generation();
  const control = watch(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.baseURL}/asset-viewer`);
  await openDialog(page);
  await expect(resetDefaultsButton(page)).toBeEnabled();
  await expect(resetDefaultsButton(page)).toHaveAttribute('type', 'button');

  await choose(page, 'asset-project-filter', comic.title, { search: 'comic' });
  await page.locator('#asset-library-search').fill('c0');
  await expect.poll(() => query(page).get('search')).toBe('c0');
  await settled(page);
  const expectedIds = comic.assetIds.filter((id) => fixture.state.db
    .prepare('SELECT filename FROM assets WHERE id = ?').get(id).filename.includes('c0'));

  const answer = page.waitForResponse((response) => new URL(response.url()).pathname === '/asset-viewer/defaults/reset'
    && response.request().method() === 'POST');
  await resetDefaultsButton(page).focus();
  await page.keyboard.press('Enter');
  const payload = await (await answer).json();
  await expect(status(page)).toHaveText('Defaults reset to the application defaults.');
  await settled(page);

  expect(control.defaultsPosts()).toHaveLength(1);
  const [{ body, type, path: postPath }] = control.defaultsPosts();
  expect(type).toBe('fetch');
  expect(postPath).toBe('/asset-viewer/defaults/reset');
  expect(body.get('_csrf')).toBeTruthy();
  expect(body.get('defaultsGeneration')).toBe(String(generation));
  const returnTo = new URL(body.get('returnTo'), fixture.baseURL);
  expect(returnTo.searchParams.getAll('project')).toEqual([String(comic.id)]);
  expect(returnTo.searchParams.get('search')).toBe('c0');
  expect(payload.operation).toMatchObject({
    id: body.get('defaultsOperation'), result: 'committed',
    expectedGeneration: generation, generation: generation + 1,
  });
  expect(fixture.generation()).toBe(generation + 1);
  expect(storedAssetViewerKeys()).toEqual([]);
  expect(query(page).getAll('project')).toEqual([String(comic.id)]);
  expect(query(page).get('search')).toBe('c0');
  expect([...await renderedAssetIds(page)].sort((a, b) => a - b)).toEqual(expectedIds);
  await page.reload();
  expect([...await renderedAssetIds(page)].sort((a, b) => a - b)).toEqual(expectedIds);

  // Repeated Projects and Project Types, and a still-debounced Search: the
  // reset keeps the latest intention, not the last installed one.
  storeDefaults();
  const second = fixture.generation();
  await page.goto(`${fixture.baseURL}/asset-viewer?project=${comic.id}&project=${images.id}&type=comic&type=images&usage=used`);
  await openDialog(page);
  await expect(resetDefaultsButton(page)).toBeEnabled();
  await page.evaluate(() => {
    const search = document.getElementById('asset-library-search');
    search.value = 'i0';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-asset-library-defaults-reset]').click();
  });
  await expect(status(page)).toHaveText('Defaults reset to the application defaults.');
  await settled(page);
  expect(control.defaultsPosts()).toHaveLength(2);
  const debounced = new URL(control.defaultsPosts()[1].body.get('returnTo'), fixture.baseURL);
  expect(debounced.searchParams.get('search')).toBe('i0');
  expect(storedAssetViewerKeys()).toEqual([]);
  expect(fixture.generation()).toBe(second + 1);
  await expect.poll(() => query(page).get('search')).toBe('i0');
  expect([...query(page).getAll('project')].sort()).toEqual([String(comic.id), String(images.id)].sort());
  expect([...query(page).getAll('type')].sort()).toEqual(['comic', 'images']);
  expect(query(page).get('usage')).toBe('used');
  expect(page.url()).not.toMatch(/%2C/);
  expect(control.posts.filter((post) => post.type !== 'fetch')).toEqual([]);
});

test('F3-D: a confirmed Reset defaults whose refresh GET fails recovers by GET only', async ({ page }) => {
  const { comic } = await seed();
  storeDefaults();
  const generation = fixture.generation();
  const control = watch(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.baseURL}/asset-viewer?project=${comic.id}&search=c0`);
  await openDialog(page);
  let failNext = true;
  await page.route((url) => url.pathname === '/asset-viewer', async (route) => {
    if (route.request().resourceType() !== 'fetch' || route.request().method() !== 'GET' || !failNext) return route.continue();
    failNext = false;
    return route.fulfill({ status: 500, body: 'failed' });
  });

  await resetDefaultsButton(page).click();
  const retry = page.locator('[data-live-filter-retry]:visible, [data-asset-library-defaults-retry]:visible').first();
  await expect(retry).toBeVisible();
  expect(control.defaultsPosts()).toHaveLength(1);
  expect(storedAssetViewerKeys()).toEqual([]);
  expect(fixture.generation()).toBe(generation + 1);

  // Reset again while the refresh is owed: never a second deletion.
  await resetDefaultsButton(page).click();
  await page.waitForTimeout(300);
  expect(control.defaultsPosts()).toHaveLength(1);

  const gets = control.gets.length;
  await retry.click();
  await settled(page);
  await expect(page.locator('[data-live-filter-failure]')).toHaveCount(0);
  expect(control.gets.length).toBeGreaterThan(gets);
  expect(control.defaultsPosts()).toHaveLength(1);
  expect(fixture.generation()).toBe(generation + 1);
  expect(query(page).getAll('project')).toEqual([String(comic.id)]);
  expect(query(page).get('search')).toBe('c0');
});

test('F3-E: reopening and live replacements keep one Reset defaults owner, distinct from Save and Reset filters', async ({ page }) => {
  await seed();
  storeDefaults();
  const generation = fixture.generation();
  const control = watch(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.baseURL}/asset-viewer`);
  for (let round = 0; round < 3; round += 1) {
    await openDialog(page);
    await choose(page, 'asset-order-filter', round % 2 === 0 ? 'Descending' : 'Ascending');
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
  }
  await openDialog(page);
  // A duplicate enhancement returns the one controller.
  await page.evaluate(async () => {
    const module = await import('/client/asset-library-filters-defaults.js');
    module.enhanceAssetLibraryFiltersDefaults(document);
  });
  await expect(page.locator('[data-asset-library-defaults-reset]')).toHaveCount(1);
  await expect(resetDefaultsButton(page)).toHaveAttribute('type', 'button');
  await expect(resetDefaultsButton(page)).toBeEnabled();
  expect(await resetDefaultsButton(page).evaluate((button) => Boolean(button.form || button.closest('form')))).toBe(false);

  // Reset filters is GET-only.
  await resetFiltersButton(page).click();
  await settled(page);
  expect(control.defaultsPosts()).toEqual([]);

  await resetDefaultsButton(page).click();
  await expect(status(page)).toHaveText('Defaults reset to the application defaults.');
  await settled(page);
  await page.waitForTimeout(300);
  expect(control.defaultsPosts().map((post) => `${post.type} ${post.path}`)).toEqual(['fetch /asset-viewer/defaults/reset']);
  expect(fixture.generation()).toBe(generation + 1);

  // Save stays a separate operation.
  await choose(page, 'asset-sort-filter', 'Size');
  await saveButton(page).click();
  await expect(status(page)).toHaveText('Defaults saved.');
  expect(control.defaultsPosts().map((post) => post.path)).toEqual(['/asset-viewer/defaults/reset', '/asset-viewer/defaults']);
  expect(fixture.generation()).toBe(generation + 2);
  await expect(dialog(page)).toBeVisible();
});

// R1 — one visible, one announced success confirmation per acknowledged
// Save. Before R1 the saved-state indicator and the status line both read
// "Defaults saved." after a Save of all nine settings (one POST, two lines).
const savedConfirmations = (page) => dialog(page).getByText('Defaults saved.', { exact: true }).filter({ visible: true });
const savedAnnouncements = (page) => dialog(page)
  .locator('[aria-live], [role="status"], [role="alert"]').filter({ hasText: 'Defaults saved.' });

test('R1 K–Q: one success confirmation per acknowledged Save; none on failure or uncertainty; reopen keeps one', async ({ page }) => {
  await seed();
  const control = watch(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.baseURL}/asset-viewer`);
  await openDialog(page);
  await choose(page, 'asset-sort-filter', 'Size');
  await settled(page);
  await expect(indicator(page)).toHaveText('No saved defaults · Current settings differ from the application defaults.');

  // N: a correlated, rolled-back failure shows no success; the indicator stays.
  let mode = 'reject';
  await page.route((url) => url.pathname === '/asset-viewer/defaults', async (route) => {
    if (mode === 'reject') {
      const sent = new URLSearchParams(route.request().postData() || '');
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({
        status: 'error', committed: false,
        operation: { id: sent.get('defaultsOperation'), kind: 'save', result: 'failed', committed: false,
          expectedGeneration: Number(sent.get('defaultsGeneration')), generation: null },
      }) });
    }
    if (mode === 'abort') return route.abort('failed');
    return route.continue();
  });
  await saveButton(page).click();
  await expect(status(page)).toHaveText('Defaults were not saved. Your current choices were kept.');
  await expect(savedConfirmations(page)).toHaveCount(0);
  await expect(indicator(page)).toBeVisible();
  expect(control.defaultsPosts()).toHaveLength(1);
  expect(fixture.readPageDefault('assetViewer', 'sort')).toBeUndefined();

  // N: an unanswered Save is never reported as success, nor after Check.
  mode = 'abort';
  await saveButton(page).click();
  await expect(status(page)).toHaveText(/Could not confirm/);
  await expect(savedConfirmations(page)).toHaveCount(0);
  await expect(indicator(page)).toBeVisible();
  expect(control.defaultsPosts()).toHaveLength(2);
  mode = 'pass';
  const check = dialog(page).locator('[data-asset-library-defaults-check]');
  await expect(check).toBeVisible();
  await check.click();
  await expect(status(page)).not.toHaveText(/^(Checking whether the defaults were saved\.)?$/);
  await expect(savedConfirmations(page)).toHaveCount(0);
  await page.goto(`${fixture.baseURL}/asset-viewer`);
  await openDialog(page);
  await choose(page, 'asset-sort-filter', 'Size');
  await settled(page);
  const postsBefore = control.defaultsPosts().length;

  // L/M/P: one acknowledged Save → one POST, one visible confirmation, one
  // live announcement; the duplicate indicator is hidden, not removed.
  await saveButton(page).click();
  await expect(status(page)).toHaveText('Defaults saved.');
  await settled(page);
  expect(control.defaultsPosts()).toHaveLength(postsBefore + 1);
  await expect(savedConfirmations(page)).toHaveCount(1);
  await expect(savedAnnouncements(page)).toHaveCount(1);
  await expect(savedAnnouncements(page)).toHaveAttribute('data-settings-fetch-save-status', '');
  await expect(indicator(page)).toBeHidden();
  await expect(indicator(page)).toHaveText('Defaults saved.');
  expect(fixture.readPageDefault('assetViewer', 'sort')).toBe('size');

  // The indicator returns as soon as it says something the status does not.
  const nextOrder = await page.locator('#asset-order-filter input[value="asc"]').isChecked() ? 'desc' : 'asc';
  await choose(page, 'asset-order-filter', nextOrder === 'asc' ? 'Ascending' : 'Descending');
  await settled(page);
  await expect(indicator(page)).toBeVisible();
  await expect(indicator(page)).toHaveText('Defaults saved · Current settings differ from the saved defaults.');
  await expect(savedConfirmations(page)).toHaveCount(1);

  // O/F: a later distinct Save (keyboard) still gets its own feedback.
  await saveButton(page).focus();
  await page.keyboard.press('Enter');
  await expect(status(page)).toHaveText('Defaults saved.');
  await settled(page);
  expect(control.defaultsPosts()).toHaveLength(postsBefore + 2);
  expect(fixture.readPageDefault('assetViewer', 'order')).toBe(nextOrder);
  await expect(savedConfirmations(page)).toHaveCount(1);
  await expect(indicator(page)).toBeHidden();

  // Q: closing and reopening does not reinstall a second confirmation.
  await closeDialog(page);
  await openDialog(page);
  await expect(indicator(page)).toHaveText('Defaults saved.');
  await expect(savedConfirmations(page)).toHaveCount(1);
  await expect(savedAnnouncements(page)).toHaveCount(1);
  expect(control.defaultsPosts()).toHaveLength(postsBefore + 2);
  expect(control.errors).toEqual([]);
});
