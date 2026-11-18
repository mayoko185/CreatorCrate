import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {
  NINE, checkedValues, closeDialog, createLibraryFixture, dialog, openDialog, pageAuthority, query, renderedAssetIds,
  settled, totalText, watch,
} from './asset-library-filters-defaults-fixture.js';

/*
 * Milestone 3 F9 — Asset Library: a toolbar Grid/List click while Reset
 * filters is still pending. The server resolves Reset filters from the saved
 * defaults (it ignores a request-time View); the newer View click must
 * override only the View of that authoritative result. Requests are held or
 * failed through route gates, never through sleeps. Real HTTP, SQLite and
 * scanned assets.
 */

const fixture = createLibraryFixture('asset-library-reset-view');

test.beforeAll(async () => {
  await fixture.start();
});

test.afterAll(async () => {
  await fixture.stop();
});

let shade = 20;
async function writeImage(filePath, jpeg = false) {
  shade = (shade + 37) % 230;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const pipeline = sharp({ create: { width: 40, height: 40, channels: 3, background: { r: shade, g: 120, b: 80 } } });
  await (jpeg ? pipeline.jpeg() : pipeline.png()).toFile(filePath);
}

let count = 0;
async function project(title, projectType, files) {
  count += 1;
  const { app, db, projectsRoot } = fixture.state;
  const created = app.locals.projectService.create({ title: `${title} ${count}`, status: 'tbd', projectType });
  const dir = path.join(projectsRoot, created.project_dir);
  for (const file of files) await writeImage(path.join(dir, file), file.endsWith('.jpg'));
  app.locals.assetScanner.scanProjectAssets(created.id);
  const rows = db.prepare('SELECT id, filename FROM assets WHERE project_id = ? ORDER BY id').all(created.id);
  return { id: created.id, ids: Object.fromEntries(rows.map((row) => [row.filename, row.id])) };
}

/*
 * Three projects of three Project Types. The saved restriction set
 * (PNG ∧ category Final ∧ present ∧ tag Keep) matches six assets across
 * all three projects, including one used in a release and several whose
 * names miss the temporary Search; each excluded asset fails exactly one
 * saved restriction, so a lost restriction changes the asset IDs.
 */
async function seed() {
  fixture.isolate();
  const { db, app } = fixture.state;
  const comic = await project('Reset Comic', 'comic', ['f1.png', 'f2.png', 'f3.png', 'f4.png', 'f5.jpg', 'f6.png']);
  const images = await project('Reset Images', 'images', ['g1.png', 'g2.png', 'g3.jpg', 'g4.png']);
  const animation = await project('Reset Animation', 'animation', ['h1.png', 'h2.png']);
  // The saved Category must be a catalogue category: the global 'final'.
  const category = (projectId) => db.prepare(
    "SELECT id FROM project_asset_categories WHERE project_id = ? AND directory_slug = 'final'",
  ).get(projectId)?.id ?? db.prepare(
    "INSERT INTO project_asset_categories (project_id, display_name, directory_slug) VALUES (?, 'Final', 'final')",
  ).run(projectId).lastInsertRowid;
  const finals = { [comic.id]: category(comic.id), [images.id]: category(images.id), [animation.id]: category(animation.id) };
  const setCategory = (owner, name) => db.prepare('UPDATE assets SET category_id = ? WHERE id = ?').run(finals[owner.id], owner.ids[name]);
  for (const name of ['f1.png', 'f2.png', 'f3.png', 'f5.jpg', 'f6.png']) setCategory(comic, name);
  for (const name of ['g1.png', 'g2.png']) setCategory(images, name);
  for (const name of ['h1.png', 'h2.png']) setCategory(animation, name);
  db.prepare('UPDATE assets SET is_present = 0 WHERE id = ?').run(comic.ids['f3.png']);
  const release = db.prepare("INSERT INTO releases (project_id, title) VALUES (?, 'F9 Release')").run(comic.id).lastInsertRowid;
  db.prepare('INSERT INTO release_assets (release_id, asset_id) VALUES (?, ?)').run(release, comic.ids['f2.png']);
  const tags = app.locals.tagService;
  const keep = tags.listTags?.().find((tag) => (tag.display_name ?? tag.displayName) === 'F9 Keep')?.id
    ?? tags.createTag({ name: 'F9 Keep' }).id;
  const tagged = [
    ...['f1.png', 'f2.png', 'f3.png', 'f4.png', 'f5.jpg'].map((name) => comic.ids[name]),
    ...Object.values(images.ids), ...Object.values(animation.ids),
  ];
  for (const id of tagged) app.locals.assetTagService.replaceAssetTags(id, [keep]);
  const restored = [comic.ids['f1.png'], comic.ids['f2.png'], images.ids['g1.png'], images.ids['g2.png'],
    animation.ids['h1.png'], animation.ids['h2.png']];
  // filename descending: h2, h1, g2, g1, f2, f1.
  const restoredDesc = [animation.ids['h2.png'], animation.ids['h1.png'], images.ids['g2.png'], images.ids['g1.png'],
    comic.ids['f2.png'], comic.ids['f1.png']];
  return { comic, images, animation, keep, restored, restoredDesc };
}

const ALL_NINE = (keep, view = 'grid') => ({
  view, gridStyle: 'cropped', sort: 'filename', order: 'desc', pageSize: '50',
  extension: '["png"]', category: '["final"]', presence: 'present', tag: `["${keep}"]`,
});

function saveDefaults(values) {
  fixture.clearAssetViewerDefaults();
  for (const [option, value] of Object.entries(values)) fixture.writePageDefault('assetViewer', option, value);
}

function storedDefaults() {
  return Object.fromEntries(NINE.map((option) => [option, fixture.readPageDefault('assetViewer', option)]));
}

// Temporary context (Projects, Types, Search, Usage) plus default-backed
// values that differ from the saved ones; it matches only g3.jpg.
const temporaryUrl = (s, view = 'grid') => `${fixture.baseURL}/asset-viewer?project=${s.images.id}&type=images&search=g&usage=unused`
  + `&extension=jpg&sort=filename&order=asc&pageSize=25&view=${view}`;

const sorted = (values) => [...values].sort((left, right) => left - right);
const historyLength = (page) => page.evaluate(() => window.history.length);
const viewLink = (page, view) => page.locator(`nav.view-switcher a[aria-label$="${view === 'list' ? 'List' : 'Grid'} view"]`);
const failureNotice = (page) => page.locator('[data-live-filter-failure]');
const nsfwToggle = (page) => page.locator('[data-asset-library-nsfw-toggle]');
const resetFiltersButton = (page) => dialog(page).getByRole('button', { name: 'Reset filters', exact: true });
const saveButton = (page) => dialog(page).getByRole('button', { name: 'Save new defaults', exact: true });
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

async function gateGets(page) {
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

const isReset = (url) => url.searchParams.get('resetFilters') === '1';
const isView = (view) => (url) => !isReset(url) && url.searchParams.get('view') === view;

// Clicks the dialog's Reset filters and closes the dialog while the Reset
// GET is held, so the toolbar is reachable.
async function startHeldReset(page, gates, options) {
  const held = gates.next(isReset, options);
  await openDialog(page);
  await resetFiltersButton(page).click();
  const url = await held.arrival;
  await closeDialog(page);
  return { ...held, url };
}

// The restored saved filters (the nine minus View) with the temporary
// context cleared, from the address, the controls and the rendered assets.
async function expectRestored(page, s, view, { ids = s.restoredDesc } = {}) {
  const url = query(page);
  for (const key of ['project', 'type', 'search', 'usage', 'page', 'resetFilters']) expect(url.has(key)).toBe(false);
  expect(url.getAll('extension')).toEqual(['png']);
  expect(url.getAll('category')).toEqual(['final']);
  expect(url.get('presence')).toBe('present');
  expect(url.getAll('tag')).toEqual([String(s.keep)]);
  expect(url.get('order')).toBe('desc');
  expect(url.get('pageSize')).toBe('50');
  expect(url.get('view') ?? 'grid').toBe(view);
  await expect.poll(() => totalText(page)).toBe(`${ids.length} assets found`);
  // Filename descending: the restored order, not just the restored set.
  expect(await renderedAssetIds(page)).toEqual(ids);
  expect(sorted(await sequenceIds(page))).toEqual(sorted(ids));
  await expectPresentation(page, view);
  await expect(page.locator('#asset-library-grid-style')).toHaveValue('cropped');
  await openDialog(page);
  expect(await checkedValues(page, 'asset-view-filter')).toEqual([view]);
  expect(await checkedValues(page, 'asset-extension-filter')).toEqual(['png']);
  expect(await checkedValues(page, 'asset-category-filter')).toEqual(['final']);
  expect(await checkedValues(page, 'asset-presence-filter')).toEqual(['present']);
  expect(await checkedValues(page, 'asset-tag-filter')).toEqual([String(s.keep)]);
  expect(await checkedValues(page, 'asset-order-filter')).toEqual(['desc']);
  expect(await checkedValues(page, 'asset-page-size-filter')).toEqual(['50']);
  await expect(page.locator('#asset-library-search')).toHaveValue('');
  await expect(page.locator('#asset-project-filter input[data-cc-dropdown-select-all]')).toBeChecked();
  await expect(page.locator('#asset-project-type-filter input[data-cc-dropdown-select-all]')).toBeChecked();
  expect(await checkedValues(page, 'asset-usage-filter')).toEqual(['all']);
  await closeDialog(page);
}

async function expectTemporary(page, s) {
  await expect.poll(() => totalText(page)).toBe('1 asset found');
  expect(await renderedAssetIds(page)).toEqual([s.images.ids['g3.jpg']]);
}

test('A: List clicked during a held Reset installs the restored saved filters in List (the original F9 reproduction)', async ({ page }) => {
  const s = await seed();
  saveDefaults(ALL_NINE(s.keep, 'grid'));
  const stored = storedDefaults();
  const generation = fixture.generation();
  const control = watch(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(temporaryUrl(s));
  await expectTemporary(page, s);
  const startLength = await historyLength(page);
  const gates = await gateGets(page);

  const reset = await startHeldReset(page, gates);
  expect(reset.url.search).toBe('?resetFilters=1');
  await viewLink(page, 'list').click();
  reset.release();
  await settled(page);

  await expectRestored(page, s, 'list');
  expect(await historyLength(page)).toBe(startLength + 1);
  // One Reset GET (redirected to its canonical address) and one View GET.
  const requested = gates.requests.map((url) => url.pathname + url.search);
  expect(requested.filter((entry) => entry.includes('resetFilters'))).toEqual(['/asset-viewer?resetFilters=1']);
  expect(requested.filter((entry) => !entry.includes('resetFilters'))).toEqual([new URL(page.url()).pathname + new URL(page.url()).search]);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.posts).toEqual([]);
  expect(storedDefaults()).toEqual(stored);
  expect(fixture.generation()).toBe(generation);
  expect(control.errors).toEqual([]);

  // Reload keeps the composed result; Back returns to the temporary page.
  const installed = page.url();
  await page.reload();
  await expectRestored(page, s, 'list');
  await page.goBack();
  await expectTemporary(page, s);
  await expectPresentation(page, 'grid');
  await page.goForward();
  await expect.poll(() => page.url()).toBe(installed);
  await expectRestored(page, s, 'list');
});

test('B: Grid clicked during a Reset whose saved View is List installs Grid; the saved List and filters stay stored', async ({ page }) => {
  const s = await seed();
  saveDefaults(ALL_NINE(s.keep, 'list'));
  const stored = storedDefaults();
  const control = watch(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(temporaryUrl(s, 'list'));
  await expectTemporary(page, s);
  const gates = await gateGets(page);

  const reset = await startHeldReset(page, gates);
  await viewLink(page, 'grid').click();
  reset.release();
  await settled(page);

  await expectRestored(page, s, 'grid');
  // An explicit Grid, since the saved List would otherwise apply.
  expect(query(page).get('view')).toBe('grid');
  await expect(page.locator('[data-asset-library-live-region] ul.asset-grid')).toHaveAttribute('data-grid-style', 'cropped');
  expect(control.defaultsPosts()).toEqual([]);
  expect(storedDefaults()).toEqual(stored);
  expect(control.errors).toEqual([]);
});

test('Grid matching the saved Grid costs no extra GET; List matching the saved List costs none either', async ({ page }) => {
  const s = await seed();
  saveDefaults(ALL_NINE(s.keep, 'grid'));
  const control = watch(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(temporaryUrl(s, 'list'));
  await expectTemporary(page, s);
  const gates = await gateGets(page);

  let reset = await startHeldReset(page, gates);
  await viewLink(page, 'grid').click();
  reset.release();
  await settled(page);
  await expectRestored(page, s, 'grid');
  expect(query(page).has('view')).toBe(false);
  expect(gates.requests.map((url) => url.search)).toEqual(['?resetFilters=1']);

  saveDefaults(ALL_NINE(s.keep, 'list'));
  await page.goto(temporaryUrl(s, 'grid'));
  await expectTemporary(page, s);
  gates.requests.length = 0;
  reset = await startHeldReset(page, gates);
  await viewLink(page, 'list').click();
  reset.release();
  await settled(page);
  await expectRestored(page, s, 'list');
  expect(gates.requests.map((url) => url.search)).toEqual(['?resetFilters=1']);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('C: rapid List → Grid → List during the Reset, and Grid during the follow-up View GET, keep the latest View', async ({ page }) => {
  const s = await seed();
  saveDefaults(ALL_NINE(s.keep, 'grid'));
  const control = watch(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(temporaryUrl(s));
  await expectTemporary(page, s);
  const startLength = await historyLength(page);
  const gates = await gateGets(page);

  const reset = await startHeldReset(page, gates);
  await viewLink(page, 'list').click();
  await viewLink(page, 'grid').click();
  await viewLink(page, 'list').click();
  // The follow-up List GET is held; Grid is chosen while it is in flight.
  const followUp = gates.next(isView('list'));
  reset.release();
  await followUp.arrival;
  await viewLink(page, 'grid').click();
  followUp.release();
  await settled(page);

  await expectRestored(page, s, 'grid');
  // Grid is the saved View: the canonical Reset address itself.
  expect(query(page).has('view')).toBe(false);
  expect(await historyLength(page)).toBe(startLength + 1);
  // Reset, its List continuation, then back to the canonical Reset address.
  expect(gates.requests.map((url) => url.searchParams.get('view') ?? (isReset(url) ? 'reset' : 'canonical')))
    .toEqual(['reset', 'list', 'canonical']);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('D: partial and fallback-equal saved defaults, and no saved defaults, still compose with the newer View', async ({ page }) => {
  const s = await seed();
  const control = watch(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  const gates = await gateGets(page);

  // Partial: only Extension and Order saved; the rest are application fallbacks.
  saveDefaults({ extension: '["png"]', order: 'desc' });
  await page.goto(temporaryUrl(s));
  await expectTemporary(page, s);
  let reset = await startHeldReset(page, gates);
  await viewLink(page, 'list').click();
  reset.release();
  await settled(page);
  let url = query(page);
  for (const key of ['project', 'type', 'search', 'usage', 'category', 'presence', 'tag', 'pageSize']) expect(url.has(key)).toBe(false);
  expect(url.getAll('extension')).toEqual(['png']);
  expect(url.get('order')).toBe('desc');
  expect(url.get('view')).toBe('list');
  // Every present-or-missing PNG of the three projects (f3 is missing, f6 untagged).
  const pngs = [s.comic.ids['f1.png'], s.comic.ids['f2.png'], s.comic.ids['f3.png'], s.comic.ids['f4.png'], s.comic.ids['f6.png'],
    s.images.ids['g1.png'], s.images.ids['g2.png'], s.images.ids['g4.png'], s.animation.ids['h1.png'], s.animation.ids['h2.png']];
  await expect.poll(() => totalText(page)).toBe(`${pngs.length} assets found`);
  expect(sorted(await renderedAssetIds(page))).toEqual(sorted(pngs));
  await expectPresentation(page, 'list');

  // Explicitly saved fallback-equal values (all, Grid, Uncropped, 25).
  saveDefaults({
    view: 'grid', gridStyle: 'uncropped', sort: 'filename', order: 'asc', pageSize: '25',
    extension: 'all', category: 'all', presence: 'all', tag: 'all',
  });
  await page.goto(temporaryUrl(s));
  await expectTemporary(page, s);
  reset = await startHeldReset(page, gates);
  await viewLink(page, 'list').click();
  reset.release();
  await settled(page);
  expect(new URL(page.url()).search).toBe('?view=list');
  const everything = [...Object.values(s.comic.ids), ...Object.values(s.images.ids), ...Object.values(s.animation.ids)];
  await expect.poll(() => totalText(page)).toBe(`${everything.length} assets found`);
  expect(sorted(await renderedAssetIds(page))).toEqual(sorted(everything));
  await expectPresentation(page, 'list');

  // No saved defaults at all.
  fixture.clearAssetViewerDefaults();
  await page.goto(temporaryUrl(s));
  await expectTemporary(page, s);
  reset = await startHeldReset(page, gates);
  await viewLink(page, 'list').click();
  reset.release();
  await settled(page);
  expect(new URL(page.url()).search).toBe('?view=list');
  expect(sorted(await renderedAssetIds(page))).toEqual(sorted(everything));
  await expectPresentation(page, 'list');
  await openDialog(page);
  expect(await checkedValues(page, 'asset-view-filter')).toEqual(['list']);
  await closeDialog(page);
  for (const option of NINE) expect(fixture.readPageDefault('assetViewer', option)).toBeUndefined();
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('E: a saved default changed while the Reset is pending is honoured by the server, never replaced by a stale snapshot', async ({ page }) => {
  const s = await seed();
  saveDefaults(ALL_NINE(s.keep, 'grid'));
  const control = watch(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(temporaryUrl(s));
  await expectTemporary(page, s);
  const gates = await gateGets(page);

  const reset = await startHeldReset(page, gates);
  await viewLink(page, 'list').click();
  // Another tab saves a different Order before the Reset is resolved.
  fixture.writePageDefault('assetViewer', 'order', 'asc');
  reset.release();
  await settled(page);

  const url = query(page);
  expect(url.has('order')).toBe(false);
  expect(url.get('view')).toBe('list');
  expect(await renderedAssetIds(page)).toEqual([...s.restoredDesc].reverse());
  expect(fixture.readPageDefault('assetViewer', 'order')).toBe('asc');
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('G: a failed Reset keeps the previous page coherent; a View click and Retry are GET-only and re-resolve the Reset', async ({ page }) => {
  const s = await seed();
  saveDefaults(ALL_NINE(s.keep, 'grid'));
  const control = watch(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(temporaryUrl(s));
  await expectTemporary(page, s);
  const before = page.url();
  const startLength = await historyLength(page);
  const gates = await gateGets(page);

  const reset = await startHeldReset(page, gates, { fail: true });
  await settled(page);
  await expect(failureNotice(page)).toBeVisible();
  expect(page.url()).toBe(before);
  await expectTemporary(page, s);

  // A View click on the failed Reset re-requests the Reset with that View.
  const again = gates.next(isReset, { fail: true });
  await viewLink(page, 'list').click();
  await again.arrival;
  await settled(page);
  await expect(failureNotice(page)).toBeVisible();
  expect(page.url()).toBe(before);
  await expectTemporary(page, s);
  await expectPresentation(page, 'grid');

  // Retry re-resolves the Reset, then applies the retained List.
  await failureNotice(page).getByRole('button', { name: 'Retry' }).click();
  await settled(page);
  await expect(failureNotice(page)).toHaveCount(0);
  await expectRestored(page, s, 'list');
  expect(await historyLength(page)).toBe(startLength + 1);
  expect(reset.url.search).toBe('?resetFilters=1');
  expect(gates.requests.filter(isReset)).toHaveLength(3);
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('H: a failed follow-up View GET installs nothing; Retry repeats the Reset and keeps the latest View', async ({ page }) => {
  const s = await seed();
  saveDefaults(ALL_NINE(s.keep, 'grid'));
  const control = watch(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(temporaryUrl(s));
  await expectTemporary(page, s);
  const before = page.url();
  const startLength = await historyLength(page);
  const gates = await gateGets(page);

  const reset = await startHeldReset(page, gates);
  await viewLink(page, 'list').click();
  const followUp = gates.next(isView('list'), { fail: true });
  reset.release();
  await followUp.arrival;
  await settled(page);
  await expect(failureNotice(page)).toBeVisible();
  // No false install: the temporary page and its address remain.
  expect(page.url()).toBe(before);
  await expectTemporary(page, s);
  await expectPresentation(page, 'grid');
  await openDialog(page);
  expect(await checkedValues(page, 'asset-view-filter')).toEqual(['list']);
  await closeDialog(page);

  gates.requests.length = 0;
  await failureNotice(page).getByRole('button', { name: 'Retry' }).click();
  await settled(page);
  await expectRestored(page, s, 'list');
  expect(await historyLength(page)).toBe(startLength + 1);
  // Retry repeats the authoritative Reset first, then the View.
  expect(gates.requests.map((url) => (isReset(url) ? 'reset' : url.searchParams.get('view')))).toEqual(['reset', 'list']);
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('I: a filter edit after Reset → View supersedes both; neither late response installs nor revives the View', async ({ page }) => {
  const s = await seed();
  saveDefaults(ALL_NINE(s.keep, 'grid'));
  const control = watch(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(temporaryUrl(s));
  await expectTemporary(page, s);
  const gates = await gateGets(page);

  const reset = await startHeldReset(page, gates);
  await viewLink(page, 'list').click();
  // A new Order edit (the dialog still says List) is newer intent.
  const edit = gates.next((url) => !isReset(url) && url.searchParams.get('order') === 'desc');
  await openDialog(page);
  const order = page.locator('#asset-order-filter');
  await order.locator('summary').click();
  await order.locator('.asset-filter-multiselect-option label').getByText('Descending', { exact: true }).click();
  const editUrl = await edit.arrival;
  // The edit keeps the temporary filters (it is not a Reset) and the chosen List.
  expect(editUrl.searchParams.get('project')).toBe(String(s.images.id));
  expect(editUrl.searchParams.get('view')).toBe('list');
  edit.release();
  await settled(page);
  await closeDialog(page);
  const edited = page.url();
  // The superseded Reset is released last.
  reset.release();
  await page.waitForTimeout(300);
  expect(page.url()).toBe(edited);
  expect(query(page).get('project')).toBe(String(s.images.id));
  await expectTemporary(page, s);
  await expectPresentation(page, 'list');
  // Only one Reset GET, aborted; no continuation was ever requested.
  expect(gates.requests.filter((url) => !isReset(url) && !url.searchParams.has('project'))).toEqual([]);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('J: Back during a Reset → View drops the deferred View; a later ordinary navigation is not affected', async ({ page }) => {
  const s = await seed();
  saveDefaults(ALL_NINE(s.keep, 'grid'));
  const control = watch(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.baseURL}/asset-viewer?project=${s.comic.id}&view=grid`);
  await expect.poll(() => totalText(page)).toBe('6 assets found');
  await page.goto(temporaryUrl(s));
  await expectTemporary(page, s);
  const gates = await gateGets(page);

  const reset = await startHeldReset(page, gates);
  await viewLink(page, 'list').click();
  await page.goBack();
  await expect.poll(() => totalText(page)).toBe('6 assets found');
  reset.release();
  await page.waitForTimeout(300);
  await expectPresentation(page, 'grid');
  expect(query(page).get('project')).toBe(String(s.comic.id));
  // Forward is ordinary history navigation: the old List does not return.
  await page.goForward();
  await expectTemporary(page, s);
  await expectPresentation(page, 'grid');
  expect(gates.requests.filter((url) => !isReset(url) && url.searchParams.get('view') === 'list')).toEqual([]);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('H2: a second Reset replaces the first; the empty-results Reset link composes with View too', async ({ page }) => {
  const s = await seed();
  saveDefaults(ALL_NINE(s.keep, 'grid'));
  const control = watch(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(temporaryUrl(s));
  await expectTemporary(page, s);
  const gates = await gateGets(page);

  // Reset → List, then a second Reset: the List belonged to the first.
  await startHeldReset(page, gates);
  await viewLink(page, 'list').click();
  const second = await startHeldReset(page, gates);
  second.release();
  await settled(page);
  await expectRestored(page, s, 'grid');

  // The filtered-empty Reset link is the same Reset.
  await page.goto(`${fixture.baseURL}/asset-viewer?search=nothing-matches&view=grid`);
  await expect(page.locator('[data-asset-library-reset]')).toBeVisible();
  const held = gates.next(isReset);
  await page.locator('[data-asset-library-reset]').click();
  await held.arrival;
  await viewLink(page, 'list').click();
  held.release();
  await settled(page);
  await expectRestored(page, s, 'list');
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('K + L: the viewer opens the restored sequence; an explicit Save afterwards stores the installed List', async ({ page }) => {
  const s = await seed();
  saveDefaults(ALL_NINE(s.keep, 'grid'));
  const control = watch(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(temporaryUrl(s));
  await expectTemporary(page, s);
  const gates = await gateGets(page);

  const reset = await startHeldReset(page, gates);
  await viewLink(page, 'list').click();
  reset.release();
  await settled(page);
  await expectRestored(page, s, 'list');
  expect(control.defaultsPosts()).toEqual([]);

  // The Slideshow walks the restored assets in the restored order.
  await page.locator('[data-asset-library-slideshow-trigger]').click();
  const viewer = page.locator('#unified-viewer-dialog');
  await expect(viewer).toBeVisible();
  await expect(viewer.locator('[data-unified-viewer-position]')).toHaveText(`1 of ${s.restoredDesc.length}`);
  await expect(viewer.locator('[data-unified-viewer-title]')).toHaveText('h2.png');
  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();
  await expectRestored(page, s, 'list');

  // Only an explicit Save persists the newly installed View.
  const generation = fixture.generation();
  await openDialog(page);
  await saveButton(page).click();
  await expect(page.locator('[data-asset-library-defaults-indicator]')).toHaveText(/Defaults saved/);
  await closeDialog(page);
  expect(control.defaultsPosts().map((post) => post.path)).toEqual(['/asset-viewer/defaults']);
  expect(control.defaultsPosts()[0].body.get('view')).toBe('list');
  expect(fixture.readPageDefault('assetViewer', 'view')).toBe('list');
  expect(fixture.generation()).toBe(generation + 1);
  const authority = await pageAuthority(page);
  expect(authority.savedKeys).toEqual(NINE);
  expect(control.errors).toEqual([]);
});

test('N1: an NSFW toggle during Reset → List refreshes the Reset itself and still installs List', async ({ page }) => {
  const s = await seed();
  saveDefaults(ALL_NINE(s.keep, 'grid'));
  const control = watch(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(temporaryUrl(s));
  await expectTemporary(page, s);
  const startLength = await historyLength(page);
  const wasPressed = (await nsfwToggle(page).getAttribute('aria-pressed')) === 'true';
  const gates = await gateGets(page);

  await startHeldReset(page, gates);
  await viewLink(page, 'list').click();
  // The NSFW POST supersedes the held Reset; its refresh is that Reset.
  const refresh = gates.next(isReset);
  await nsfwToggle(page).click();
  const refreshUrl = await refresh.arrival;
  expect(refreshUrl.search).toBe('?resetFilters=1');
  refresh.release();
  await settled(page);

  await expect(nsfwToggle(page)).toHaveAttribute('aria-pressed', String(!wasPressed));
  await expect(nsfwToggle(page)).toBeEnabled();
  await expectRestored(page, s, 'list');
  expect(await historyLength(page)).toBe(startLength + 1);
  expect(control.posts.map((post) => post.path)).toEqual(['/asset-viewer/nsfw-filter']);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);

  await nsfwToggle(page).click();
  await expect(nsfwToggle(page)).toHaveAttribute('aria-pressed', String(wasPressed));
});

test('N2: an NSFW toggle while the View continuation is in flight re-resolves the Reset with the newest View', async ({ page }) => {
  const s = await seed();
  saveDefaults(ALL_NINE(s.keep, 'grid'));
  const control = watch(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(temporaryUrl(s));
  await expectTemporary(page, s);
  const startLength = await historyLength(page);
  const wasPressed = (await nsfwToggle(page).getAttribute('aria-pressed')) === 'true';
  const gates = await gateGets(page);

  const reset = await startHeldReset(page, gates);
  await viewLink(page, 'list').click();
  const followUp = gates.next(isView('list'));
  reset.release();
  await followUp.arrival;
  // Grid is chosen during the continuation, then NSFW is toggled.
  await viewLink(page, 'grid').click();
  await nsfwToggle(page).click();
  await expect(nsfwToggle(page)).toHaveAttribute('aria-pressed', String(!wasPressed));
  await expect(nsfwToggle(page)).toBeEnabled();
  await settled(page);
  // The stale List continuation is released last and cannot install.
  followUp.release();
  await page.waitForTimeout(300);

  await expectRestored(page, s, 'grid');
  expect(query(page).has('view')).toBe(false);
  expect(await historyLength(page)).toBe(startLength + 1);
  expect(gates.requests.map((url) => (isReset(url) ? 'reset' : url.searchParams.get('view') ?? 'canonical')))
    .toEqual(['reset', 'list', 'reset']);
  expect(control.posts.map((post) => post.path)).toEqual(['/asset-viewer/nsfw-filter']);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);

  await nsfwToggle(page).click();
  await expect(nsfwToggle(page)).toHaveAttribute('aria-pressed', String(wasPressed));
});
