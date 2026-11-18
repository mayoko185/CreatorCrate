import { expect, test } from '@playwright/test';
import {
  checkedValues, closeDialog, createProjectsFixture, dialog, enhanced, openDialog, projectsUrl,
  query, renderedIds, settled, summaryText, totalCount,
} from './projects-filters-defaults-fixture.js';

/*
 * Filters & Defaults M3 F8 — a toolbar Grid/List click made while Projects
 * Reset filters is waiting for its server answer is newer View intent for the
 * Reset, not a request to abandon it. The Reset (a bare GET /projects the
 * server resolves from the saved defaults) still restores every saved
 * filter, Sort and Order; the clicked View is the only override. Requests are
 * held or failed through route gates, never through sleeps; data lives in a
 * temporary root removed afterward.
 */

const fixture = createProjectsFixture('projects-reset-view');

test.beforeAll(async () => {
  await fixture.start();
});

test.afterAll(async () => {
  await fixture.stop();
});

const FILTER_KEYS = ['search', 'status', 'type', 'tag', 'project', 'sort', 'order', 'view', 'page'];
// The Reset's own request: the server resolves saved defaults only here.
const isReset = (url) => url.pathname === '/projects' && !FILTER_KEYS.some((key) => url.searchParams.has(key));

function watch(page) {
  const control = { posts: [], gets: [], errors: [] };
  page.on('pageerror', (error) => control.errors.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() !== 'GET') control.posts.push(`${request.method()} ${url.pathname}`);
    // A redirect hop (the Reset's 302 target) is the same request, not a new GET.
    else if (url.pathname === '/projects' && request.resourceType() === 'fetch' && !request.redirectedFrom()) {
      control.gets.push(url);
    }
  });
  control.defaultsPosts = () => control.posts.filter((post) => post.includes('/projects/defaults'));
  return control;
}

async function gateGets(page) {
  const control = { rules: [] };
  await page.route((url) => url.pathname === '/projects', async (route) => {
    const request = route.request();
    if (request.method() !== 'GET' || request.resourceType() !== 'fetch') return route.continue();
    const url = new URL(request.url());
    const index = control.rules.findIndex((rule) => rule.match(url));
    if (index === -1) return route.continue();
    const [rule] = control.rules.splice(index, 1);
    rule.arrived(url);
    const action = await rule.decision;
    try {
      if (action === 'fail') await route.fulfill({ status: 500, contentType: 'text/html', body: 'failed' });
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
    return { arrival, release: () => decide('continue'), fail: () => decide('fail') };
  };
  return control;
}

async function start(page, url) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(url);
  await enhanced(page);
}

const historyLength = (page) => page.evaluate(() => history.length);
const listShown = (page) => page.locator('[data-projects-list-table]');
const gridShown = (page) => page.locator('[data-projects-live-region] .project-grid');
const failureNotice = (page) => page.locator('[data-live-filter-failure]');
const resetButton = (page) => dialog(page).locator('[data-projects-filters-reset]');
const viewLink = (page, name) => page.getByRole('link', { name: `${name} view`, exact: true });

/** The displayed Project ids in display order (grid cards or list rows). */
async function displayedIds(page) {
  return renderedIds(page);
}

// Clicks Reset filters in the dialog, waits for its GET to be held, closes.
async function startHeldReset(page, gate, { fail = false } = {}) {
  await openDialog(page);
  const held = gate.next(isReset, { fail });
  await resetButton(page).click();
  await held.arrival;
  await closeDialog(page);
  return held;
}

async function viewControl(page) {
  await openDialog(page);
  const checked = await checkedValues(page, 'project-view-filter');
  await closeDialog(page);
  return checked;
}

/**
 * Asserts the installed page is the Reset's restored state with `view`:
 * URL, results (ids in order), count, presentation and dialog controls.
 */
async function expectRestored(page, { view, ids, restored }) {
  await settled(page);
  await expect(failureNotice(page)).toHaveCount(0);
  if (view === 'list') {
    await expect(listShown(page)).toBeVisible();
    await expect(gridShown(page)).toHaveCount(0);
  } else {
    await expect(gridShown(page)).toBeVisible();
    await expect(listShown(page)).toHaveCount(0);
    await expect(gridShown(page)).toHaveAttribute('data-grid-style', restored.gridStyle ?? 'uncropped');
  }
  expect(await displayedIds(page)).toEqual(ids);
  expect(await totalCount(page)).toBe(ids.length);
  const params = query(page);
  expect(params.has('search')).toBe(false);
  expect(params.has('page')).toBe(false);
  expect(params.getAll('project')).toEqual([]);
  expect(params.getAll('status')).toEqual(restored.status ?? []);
  expect(params.getAll('type')).toEqual(restored.type ?? []);
  expect(params.getAll('tag')).toEqual(restored.tag ?? []);
  expect(params.get('sort') ?? 'created').toBe(restored.sort ?? 'created');
  expect(params.get('order') ?? 'desc').toBe(restored.order ?? 'desc');
  expect(params.get('view') ?? 'grid').toBe(view);

  await openDialog(page);
  await expect(page.locator('#projects-search')).toHaveValue('');
  expect(await checkedValues(page, 'project-project-filter')).toEqual(['']);
  expect(await checkedValues(page, 'project-status-filter')).toEqual(restored.status ?? ['']);
  expect(await checkedValues(page, 'project-type-filter')).toEqual(restored.type ?? ['']);
  expect(await checkedValues(page, 'project-tag-filter')).toEqual(restored.tag ?? ['']);
  expect(await checkedValues(page, 'project-view-filter')).toEqual([view]);
  expect(await summaryText(page, 'project-view-filter')).toBe(view === 'list' ? 'List' : 'Grid');
  expect(await summaryText(page, 'project-grid-style-filter'))
    .toBe((restored.gridStyle ?? 'uncropped') === 'cropped' ? 'Cropped' : 'Uncropped');
  await closeDialog(page);
}

// The reviewer's reproduction: three Projects, saved Status = Planned.
function seedPlanned() {
  fixture.isolate();
  const alpha = fixture.project('F8 Alpha', { status: 'planned', projectType: 'comic' });
  const beta = fixture.project('F8 Beta', { status: 'ready', projectType: 'images' });
  const gamma = fixture.project('F8 Gamma', { status: 'planned', projectType: 'images' });
  // Distinct creation times: the default Sort is Created, newest first.
  [alpha, beta, gamma].forEach((project, index) => {
    fixture.state.db.prepare('UPDATE projects SET created_at = ? WHERE id = ?')
      .run(`2026-01-0${index + 1} 10:00:00`, project.id);
  });
  fixture.writePageDefault('projects', 'status', JSON.stringify(['planned']));
  return { alpha, beta, gamma, planned: [gamma.id, alpha.id] };
}

function temporaryUrl({ beta, gamma }, extra = {}) {
  return projectsUrl(fixture.baseURL, [beta.id, gamma.id], { search: 'F8', status: 'ready', ...extra });
}

const PLANNED = { status: ['planned'] };

test('F8 original: saved Planned → Reset → held GET → List shows only the Planned Projects in List', async ({ page }) => {
  const seed = seedPlanned();
  const stored = fixture.storedProjectsDefaults();
  const generationBefore = fixture.generation();
  const control = watch(page);
  const gate = await gateGets(page);
  await start(page, temporaryUrl(seed));
  expect(await displayedIds(page)).toEqual([seed.beta.id]);
  const temporary = page.url();
  const startLength = await historyLength(page);

  const held = await startHeldReset(page, gate);
  await viewLink(page, 'List').click();
  // The View choice is shown at once; the Reset still owns the results.
  expect(await viewControl(page)).toEqual(['list']);
  held.release();

  await expectRestored(page, { view: 'list', ids: seed.planned, restored: PLANNED });
  // One Reset GET and one View follow-up, never the unrestricted ?view=list.
  expect(control.gets.map((url) => url.search)).toEqual(['', '?status=planned&view=list']);
  expect(await historyLength(page)).toBe(startLength + 1);
  expect(control.posts).toEqual([]);
  expect(fixture.storedProjectsDefaults()).toEqual(stored);
  expect(fixture.generation()).toBe(generationBefore);

  // J: reload, Back and Forward stay coherent.
  await page.reload();
  await enhanced(page);
  await expectRestored(page, { view: 'list', ids: seed.planned, restored: PLANNED });
  await page.goBack();
  await expect.poll(() => page.url()).toBe(temporary);
  await settled(page);
  expect(await displayedIds(page)).toEqual([seed.beta.id]);
  await expect(gridShown(page)).toBeVisible();
  expect(await viewControl(page)).toEqual(['grid']);
  await page.goForward();
  await expect.poll(() => query(page).get('view')).toBe('list');
  await expectRestored(page, { view: 'list', ids: seed.planned, restored: PLANNED });
  expect(control.posts).toEqual([]);
  expect(fixture.storedProjectsDefaults()).toEqual(stored);
  expect(control.errors).toEqual([]);
});

test('B: all seven saved settings modified temporarily → Reset → opposite View (Grid)', async ({ page }) => {
  fixture.isolate();
  const red = fixture.tag('F8 Red');
  const blue = fixture.tag('F8 Blue');
  const a = fixture.project('Seven Bravo', { status: 'planned', projectType: 'comic', tags: [red] });
  const b = fixture.project('Seven Alpha', { status: 'planned', projectType: 'comic', tags: [red] });
  const c = fixture.project('Seven Charlie', { status: 'planned', projectType: 'images', tags: [red] });
  const d = fixture.project('Seven Delta', { status: 'ready', projectType: 'comic', tags: [blue] });
  const e = fixture.project('Seven Echo', { status: 'planned', projectType: 'comic', tags: [blue] });
  fixture.writePageDefault('projects', 'view', 'list');
  fixture.writePageDefault('projects', 'gridStyle', 'cropped');
  fixture.writePageDefault('projects', 'sort', 'title');
  fixture.writePageDefault('projects', 'order', 'asc');
  fixture.writePageDefault('projects', 'status', JSON.stringify(['planned']));
  fixture.writePageDefault('projects', 'projectType', JSON.stringify(['comic']));
  fixture.writePageDefault('projects', 'tag', JSON.stringify([String(red.id)]));
  const stored = fixture.storedProjectsDefaults();
  const control = watch(page);
  const gate = await gateGets(page);
  await start(page, projectsUrl(fixture.baseURL, [c.id, d.id, e.id], {
    search: 'Seven', status: ['ready', 'planned'], type: 'images', tag: String(blue.id),
    sort: 'updated', order: 'desc', view: 'list', page: '1',
  }));
  expect(await displayedIds(page)).toEqual([]);
  // Session Grid style differs from the saved Cropped. R2: the List page
  // hides the Grid style field (retaining it), so the session choice is set
  // through its native control, as the other Grid style specs do.
  await page.locator('#projects-grid-style').selectOption('uncropped', { force: true });
  await expect(page.locator('#projects-grid-style')).toHaveValue('uncropped');

  const held = await startHeldReset(page, gate);
  await viewLink(page, 'Grid').click();
  held.release();

  // Title ascending: Alpha (b) before Bravo (a); Charlie (images), Delta
  // (ready) and Echo (blue) are excluded by the saved Type/Status/Tag.
  const restored = {
    status: ['planned'], type: ['comic'], tag: [String(red.id)], sort: 'title', order: 'asc', gridStyle: 'cropped',
  };
  await expectRestored(page, { view: 'grid', ids: [b.id, a.id], restored });
  expect(control.gets).toHaveLength(2);
  expect(isReset(control.gets[0])).toBe(true);
  expect(control.gets[1].searchParams.get('view')).toBe('grid');
  expect(control.posts).toEqual([]);
  expect(fixture.storedProjectsDefaults()).toEqual(stored);
  expect(control.errors).toEqual([]);
});

test('C: partial defaults with explicit fallback-equal values; Grid needs no follow-up GET', async ({ page }) => {
  const seed = seedPlanned();
  fixture.writePageDefault('projects', 'sort', 'created');
  fixture.writePageDefault('projects', 'order', 'desc');
  fixture.writePageDefault('projects', 'view', 'grid');
  const stored = fixture.storedProjectsDefaults();
  expect(stored.sort).toBe('created');
  const control = watch(page);
  const gate = await gateGets(page);
  await start(page, temporaryUrl(seed, { view: 'list', sort: 'title', order: 'asc' }));
  await expect(listShown(page)).toBeVisible();

  let held = await startHeldReset(page, gate);
  await viewLink(page, 'Grid').click();
  held.release();
  await expectRestored(page, { view: 'grid', ids: seed.planned, restored: PLANNED });
  // The restored address already shows Grid: the Reset GET alone.
  expect(control.gets.map((url) => url.search)).toEqual(['']);
  expect(page.url()).toBe(`${fixture.baseURL}/projects?status=planned`);

  await page.goto(temporaryUrl(seed));
  await enhanced(page);
  control.gets.length = 0;
  held = await startHeldReset(page, gate);
  await viewLink(page, 'List').click();
  held.release();
  await expectRestored(page, { view: 'list', ids: seed.planned, restored: PLANNED });
  expect(control.gets.map((url) => url.search)).toEqual(['', '?status=planned&view=list']);
  expect(control.posts).toEqual([]);
  expect(fixture.storedProjectsDefaults()).toEqual(stored);
});

test('D: no saved defaults restores the application fallbacks with the clicked View', async ({ page }) => {
  const seed = seedPlanned();
  fixture.clearProjectsDefaults();
  const control = watch(page);
  const gate = await gateGets(page);
  await start(page, temporaryUrl(seed));

  const held = await startHeldReset(page, gate);
  await viewLink(page, 'List').click();
  held.release();
  await expectRestored(page, { view: 'list', ids: [seed.gamma.id, seed.beta.id, seed.alpha.id], restored: {} });
  expect(control.gets.map((url) => url.search)).toEqual(['', '?view=list']);
  expect(page.url()).toBe(`${fixture.baseURL}/projects?view=list`);
  expect(control.posts).toEqual([]);
  expect(fixture.storedProjectsDefaults()).toEqual(Object.fromEntries(Object.keys(fixture.storedProjectsDefaults()).map((key) => [key, undefined])));
});

test('E: rapid View reversals during a pending Reset: the latest choice wins', async ({ page }) => {
  const seed = seedPlanned();
  const control = watch(page);
  const gate = await gateGets(page);
  await start(page, temporaryUrl(seed));

  // List → Grid: the Reset address is already Grid, no follow-up.
  let held = await startHeldReset(page, gate);
  await viewLink(page, 'List').click();
  await viewLink(page, 'Grid').click();
  expect(await viewControl(page)).toEqual(['grid']);
  held.release();
  await expectRestored(page, { view: 'grid', ids: seed.planned, restored: PLANNED });
  expect(control.gets.map((url) => url.search)).toEqual(['']);

  // Grid → List → Grid → List: one follow-up with the last choice.
  await page.goto(temporaryUrl(seed));
  await enhanced(page);
  control.gets.length = 0;
  held = await startHeldReset(page, gate);
  await viewLink(page, 'Grid').click();
  await viewLink(page, 'List').click();
  await viewLink(page, 'Grid').click();
  await viewLink(page, 'List').click();
  held.release();
  await expectRestored(page, { view: 'list', ids: seed.planned, restored: PLANNED });
  expect(control.gets.map((url) => url.search)).toEqual(['', '?status=planned&view=list']);
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('F: a View click during the follow-up GET supersedes it; the late follow-up never installs', async ({ page }) => {
  const seed = seedPlanned();
  const control = watch(page);
  const gate = await gateGets(page);
  await start(page, temporaryUrl(seed));
  const startLength = await historyLength(page);

  const held = await startHeldReset(page, gate);
  const follow = gate.next((url) => url.searchParams.get('view') === 'list');
  await viewLink(page, 'List').click();
  held.release();
  await follow.arrival;
  await viewLink(page, 'Grid').click();
  await expectRestored(page, { view: 'grid', ids: seed.planned, restored: PLANNED });
  const installed = page.url();
  follow.release();
  await expect.poll(() => control.gets.length).toBe(3);
  await settled(page);
  expect(page.url()).toBe(installed);
  await expectRestored(page, { view: 'grid', ids: seed.planned, restored: PLANNED });
  expect(control.gets.map((url) => url.search)).toEqual(['', '?status=planned&view=list', '?status=planned']);
  expect(await historyLength(page)).toBe(startLength + 1);
  expect(control.posts).toEqual([]);
});

test('G: a failed Reset GET keeps the temporary page; Retry restores the defaults with the latest View', async ({ page }) => {
  const seed = seedPlanned();
  const control = watch(page);
  const gate = await gateGets(page);
  await start(page, temporaryUrl(seed));
  const temporary = page.url();

  const held = await startHeldReset(page, gate);
  await viewLink(page, 'List').click();
  held.fail();
  await expect(failureNotice(page)).toBeVisible();
  // No false Reset success: the temporary results and address remain.
  expect(page.url()).toBe(temporary);
  expect(await displayedIds(page)).toEqual([seed.beta.id]);

  await page.locator('[data-live-filter-retry]').click();
  await expectRestored(page, { view: 'list', ids: seed.planned, restored: PLANNED });
  expect(control.gets.map((url) => url.search)).toEqual(['', '', '?status=planned&view=list']);
  expect(control.posts).toEqual([]);

  // A View click on a failed Reset re-requests the Reset with that View.
  await page.goto(temporaryUrl(seed));
  await enhanced(page);
  control.gets.length = 0;
  const again = await startHeldReset(page, gate, { fail: true });
  void again;
  await expect(failureNotice(page)).toBeVisible();
  await viewLink(page, 'List').click();
  await expectRestored(page, { view: 'list', ids: seed.planned, restored: PLANNED });
  expect(control.gets.map((url) => url.search)).toEqual(['', '', '?status=planned&view=list']);
  expect(control.posts).toEqual([]);
});

test('H: a failed follow-up View GET keeps the temporary page; GET-only Retry restores Reset + View', async ({ page }) => {
  const seed = seedPlanned();
  const control = watch(page);
  const gate = await gateGets(page);
  await start(page, temporaryUrl(seed));
  const temporary = page.url();
  const startLength = await historyLength(page);

  const held = await startHeldReset(page, gate);
  gate.next((url) => url.searchParams.get('view') === 'list', { fail: true });
  await viewLink(page, 'List').click();
  held.release();
  await expect(failureNotice(page)).toBeVisible();
  expect(page.url()).toBe(temporary);
  expect(await displayedIds(page)).toEqual([seed.beta.id]);

  await page.locator('[data-live-filter-retry]').click();
  await expectRestored(page, { view: 'list', ids: seed.planned, restored: PLANNED });
  // Retry repeats the authoritative Reset, then applies the View.
  expect(control.gets.map((url) => url.search))
    .toEqual(['', '?status=planned&view=list', '', '?status=planned&view=list']);
  expect(await historyLength(page)).toBe(startLength + 1);
  expect(control.posts).toEqual([]);
});

test('I: a newer filter edit supersedes Reset + View; the late Reset response never installs', async ({ page }) => {
  const seed = seedPlanned();
  const control = watch(page);
  const gate = await gateGets(page);
  await start(page, temporaryUrl(seed));

  const held = await startHeldReset(page, gate);
  await viewLink(page, 'List').click();
  // A genuine newer edit: the Search field (its own debounced GET).
  await openDialog(page);
  await page.locator('#projects-search').fill('F8 Gamma');
  await expect.poll(() => control.gets.length).toBe(2);
  await settled(page);
  await closeDialog(page);
  const edited = page.url();
  held.release();
  await expect.poll(() => control.gets.length).toBe(2);
  await settled(page);
  expect(page.url()).toBe(edited);
  const params = query(page);
  expect(params.get('search')).toBe('F8 Gamma');
  expect(params.get('view')).toBe('list');
  expect(params.getAll('status')).toEqual(['ready']);
  expect(await displayedIds(page)).toEqual([]);
  await expect(listShown(page)).toHaveCount(0);
  expect(control.gets.filter((url) => !isReset(url))).toHaveLength(1);
  expect(control.posts).toEqual([]);
});

test('Back during a pending Reset + View abandons both; a new Reset drops the earlier View', async ({ page }) => {
  const seed = seedPlanned();
  const control = watch(page);
  const gate = await gateGets(page);
  // A same-document history entry to go Back to: temporary List → Grid.
  await start(page, temporaryUrl(seed, { view: 'list' }));
  const listEntry = page.url();
  await viewLink(page, 'Grid').click();
  await settled(page);
  expect(query(page).has('view')).toBe(false);
  control.gets.length = 0;

  const held = await startHeldReset(page, gate);
  await viewLink(page, 'List').click();
  await page.goBack();
  await expect.poll(() => page.url()).toBe(listEntry);
  await settled(page);
  held.release();
  await expect.poll(() => control.gets.length).toBe(2);
  await settled(page);
  expect(page.url()).toBe(listEntry);
  expect(await displayedIds(page)).toEqual([seed.beta.id]);
  await expect(listShown(page)).toBeVisible();
  expect(control.gets.map((url) => isReset(url))).toEqual([true, false]);

  // Back to a bare /projects entry (no saved defaults) is itself a default
  // navigation: it must not adopt the abandoned Reset's View.
  fixture.clearProjectsDefaults();
  await start(page, `${fixture.baseURL}/projects`);
  await viewLink(page, 'List').click();
  await settled(page);
  expect(query(page).get('view')).toBe('list');
  control.gets.length = 0;
  const bareHeld = await startHeldReset(page, gate);
  await viewLink(page, 'List').click();
  const backHeld = gate.next(isReset);
  await page.goBack();
  await backHeld.arrival;
  bareHeld.release();
  backHeld.release();
  await settled(page);
  await expect.poll(() => page.url()).toBe(`${fixture.baseURL}/projects`);
  await expect(gridShown(page)).toBeVisible();
  expect(control.gets.map((url) => url.search)).toEqual(['', '']);
  fixture.writePageDefault('projects', 'status', JSON.stringify(['planned']));

  // Reset → List, then a new Reset: the new Reset carries no earlier View.
  await page.goto(temporaryUrl(seed));
  await enhanced(page);
  control.gets.length = 0;
  const first = await startHeldReset(page, gate);
  await viewLink(page, 'List').click();
  const second = await startHeldReset(page, gate);
  first.release();
  second.release();
  await expectRestored(page, { view: 'grid', ids: seed.planned, restored: PLANNED });
  expect(control.gets.map((url) => url.search)).toEqual(['', '']);
  expect(control.posts).toEqual([]);
});

test('NSFW toggle during a pending Reset + View keeps the Reset and the View', async ({ page }) => {
  const seed = seedPlanned();
  const control = watch(page);
  const gate = await gateGets(page);
  await start(page, temporaryUrl(seed));

  const held = await startHeldReset(page, gate);
  await viewLink(page, 'List').click();
  const refresh = gate.next(isReset);
  await page.locator('#projects-nsfw-toggle').click();
  await refresh.arrival;
  held.release();
  refresh.release();
  await expectRestored(page, { view: 'list', ids: seed.planned, restored: PLANNED });
  await expect(page.locator('#projects-nsfw-toggle')).toBeEnabled();
  expect(control.posts).toEqual(['POST /projects/nsfw-filter']);
  expect(control.gets.at(-1).search).toBe('?status=planned&view=list');
  expect(control.errors).toEqual([]);
});

test('K: explicit Save after Reset + View captures the installed state', async ({ page }) => {
  const seed = seedPlanned();
  const control = watch(page);
  const gate = await gateGets(page);
  await start(page, temporaryUrl(seed));

  const held = await startHeldReset(page, gate);
  await viewLink(page, 'List').click();
  held.release();
  await expectRestored(page, { view: 'list', ids: seed.planned, restored: PLANNED });
  expect(fixture.readPageDefault('projects', 'view')).toBeUndefined();
  expect(control.defaultsPosts()).toEqual([]);

  await openDialog(page);
  await dialog(page).locator('[data-projects-defaults-save]').click();
  await expect(dialog(page).locator('[data-settings-fetch-save-status]')).toHaveText('Defaults saved.');
  expect(control.defaultsPosts()).toEqual(['POST /projects/defaults']);
  const saved = fixture.storedProjectsDefaults();
  expect(saved.view).toBe('list');
  expect(saved.status).toBe(JSON.stringify(['planned']));
  expect(saved.sort).toBe('created');
  expect(saved.order).toBe('desc');
  expect(saved.gridStyle).toBe('uncropped');
  await closeDialog(page);
});
