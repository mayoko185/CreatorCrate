import { expect, test } from '@playwright/test';
import {
  checkedValues, choose, chooseValue, closeDialog, createProjectsFixture, dialog, enhanced, expectListing, expectRepeated,
  openDialog, openDropdown, projectsUrl, query, renderedIds, settled, summaryText, totalCount, watch,
} from './projects-filters-defaults-fixture.js';

// WP10b D–N, P, Z, AA: the Projects multi-select and every other control of
// the combined dialog compose with repeated project= parameters on the real
// page (rendered IDs, totals, URLs, pagination, history, NSFW refresh).

const fixture = createProjectsFixture('projects-fd-selection');

test.beforeAll(async () => {
  await fixture.start();
});

test.afterAll(async () => {
  await fixture.stop();
});

function seed() {
  fixture.isolate();
  const red = fixture.tag('Red');
  const blue = fixture.tag('Blue');
  const alpha = fixture.project('Sel Alpha', { status: 'planned', projectType: 'comic', tags: [red] });
  const beta = fixture.project('Sel Beta', { status: 'ready', projectType: 'images', tags: [blue] });
  const gamma = fixture.project('Sel Gamma', { status: 'planned', projectType: 'images', tags: [red, blue] });
  const delta = fixture.project('Sel Delta', { status: 'in-progress', projectType: 'wallpaper' });
  const archived = fixture.project('Sel Archived', { status: 'planned', archived: true });
  return { red, blue, alpha, beta, gamma, delta, archived };
}

async function start(page, url = `${fixture.baseURL}/projects`) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(url);
  await enhanced(page);
}

test('D/E/F/G: one, two and three Projects, then unrestricted Select all', async ({ page }) => {
  const { alpha, beta, gamma, delta } = seed();
  const control = watch(page);
  await start(page);
  await expectListing(page, [alpha.id, beta.id, gamma.id, delta.id]);
  await openDialog(page);

  await choose(page, 'project-project-filter', alpha.title);
  await expect.poll(() => query(page).getAll('project')).toEqual([String(alpha.id)]);
  await expectListing(page, [alpha.id]);
  expect(await summaryText(page, 'project-project-filter')).toBe(alpha.title);

  await choose(page, 'project-project-filter', gamma.title);
  await expect.poll(() => query(page).getAll('project').length).toBe(2);
  expectRepeated(page.url(), 'project', [alpha.id, gamma.id]);
  await expectListing(page, [alpha.id, gamma.id]);
  expect(await summaryText(page, 'project-project-filter')).toBe('2 projects selected');

  await choose(page, 'project-project-filter', beta.title);
  await expect.poll(() => query(page).getAll('project').length).toBe(3);
  expectRepeated(page.url(), 'project', [alpha.id, beta.id, gamma.id]);
  await expectListing(page, [alpha.id, beta.id, gamma.id]);
  expect(await summaryText(page, 'project-project-filter')).toBe('3 projects selected');

  // Deselect one individually.
  await choose(page, 'project-project-filter', beta.title);
  await expect.poll(() => query(page).getAll('project').length).toBe(2);
  await expectListing(page, [alpha.id, gamma.id]);

  // Select all clears the restriction; it never checks every Project.
  await choose(page, 'project-project-filter', 'Select all');
  await expect.poll(() => query(page).getAll('project')).toEqual([]);
  await expectListing(page, [alpha.id, beta.id, gamma.id, delta.id]);
  expect(await checkedValues(page, 'project-project-filter')).toEqual(['']);
  expect(await summaryText(page, 'project-project-filter')).toBe('All projects');
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('H: a selected Project hidden by the dropdown search stays checked and keeps restricting', async ({ page }) => {
  const { alpha, beta, gamma } = seed();
  await start(page);
  await openDialog(page);
  await choose(page, 'project-project-filter', alpha.title);
  const details = await openDropdown(page, 'project-project-filter');
  await details.locator('[data-cc-dropdown-search]').fill('Sel Gamma');
  await expect(details.locator(`input[value="${alpha.id}"]`)).toBeHidden();
  await details.locator('.asset-filter-multiselect-option label').getByText(gamma.title, { exact: true }).click();
  await settled(page);
  await expect.poll(() => query(page).getAll('project').length).toBe(2);
  expectRepeated(page.url(), 'project', [alpha.id, gamma.id]);
  await expectListing(page, [alpha.id, gamma.id]);
  // The hidden choice is still checked and survives the reconciled form.
  await expect(details.locator(`input[value="${alpha.id}"]`)).toBeChecked();
  await details.locator('[data-cc-dropdown-search]').fill('');
  await details.locator('summary').click();
  expect((await checkedValues(page, 'project-project-filter')).sort()).toEqual([String(alpha.id), String(gamma.id)].sort());
  expect(beta.id).toBeGreaterThan(0);
});

test('I: archived and unknown selections remain restrictive and can be cleared', async ({ page }) => {
  const { alpha, archived } = seed();
  const unknown = 987654;
  await start(page, projectsUrl(fixture.baseURL, [alpha.id, archived.id, unknown]));
  // Active-only Status excludes the archived Project; the unknown ID never
  // broadens the list.
  await expectListing(page, [alpha.id]);
  await openDialog(page);
  expect(await summaryText(page, 'project-project-filter')).toBe('3 projects selected');
  const details = await openDropdown(page, 'project-project-filter');
  await expect(details.locator('[data-projects-unavailable-project]')).toBeChecked();
  await expect(details.locator('.projects-project-option--unavailable')).toContainText(`Unavailable project (ID ${unknown})`);
  await expect(details.locator('.projects-project-option--archived')).toContainText(archived.title);
  await expect(details.locator('.projects-project-option--archived')).toContainText('Archived');
  await details.locator('summary').click();

  // Including Archived status shows the archived selection; the unknown ID stays.
  await choose(page, 'project-status-filter', 'Archived');
  await expectListing(page, [archived.id]);
  expectRepeated(page.url(), 'project', [alpha.id, archived.id, unknown]);
  await choose(page, 'project-status-filter', 'Planned');
  await expectListing(page, [alpha.id, archived.id]);

  // An unknown-only restriction never reads "All projects", and clears.
  await choose(page, 'project-project-filter', alpha.title);
  await chooseValue(page, 'project-project-filter', archived.id);
  await expect.poll(() => query(page).getAll('project')).toEqual([String(unknown)]);
  await expectListing(page, []);
  expect(await summaryText(page, 'project-project-filter')).toBe(`Unavailable project (ID ${unknown})`);
  await chooseValue(page, 'project-project-filter', unknown);
  await expect.poll(() => query(page).getAll('project')).toEqual([]);
  expect(await summaryText(page, 'project-project-filter')).toBe('All projects');
});

test('J/K/L/M/N: Projects compose with Status, Type, Tag, Search, Sort and View and are never dropped', async ({ page }) => {
  const { red, alpha, beta, gamma, delta } = seed();
  await start(page, projectsUrl(fixture.baseURL, [alpha.id, beta.id, gamma.id]));
  await expectListing(page, [alpha.id, beta.id, gamma.id]);
  const keep = () => expectRepeated(page.url(), 'project', [alpha.id, beta.id, gamma.id]);
  await openDialog(page);

  // J: Status (AND between dimensions, OR within).
  await choose(page, 'project-status-filter', 'Planned');
  await expectListing(page, [alpha.id, gamma.id]);
  keep();
  await choose(page, 'project-status-filter', 'Ready');
  await expectListing(page, [alpha.id, beta.id, gamma.id]);
  keep();
  // K: Project Type.
  await choose(page, 'project-type-filter', 'Images');
  await expectListing(page, [beta.id, gamma.id]);
  keep();
  // L: Tag.
  await choose(page, 'project-tag-filter', red.name);
  await expectListing(page, [gamma.id]);
  keep();
  await choose(page, 'project-tag-filter', red.name);
  await choose(page, 'project-type-filter', 'Images');
  await expectListing(page, [alpha.id, beta.id, gamma.id]);
  // M: Search combines with the rest.
  await page.locator('#projects-search').fill('Gamma');
  await expect.poll(() => query(page).get('search')).toBe('Gamma');
  await settled(page);
  await expectListing(page, [gamma.id]);
  keep();
  await page.locator('#projects-search').fill('');
  await expect.poll(() => query(page).has('search')).toBe(false);
  await settled(page);
  // N: Sort and View keep the selection; Sort orders the results.
  await choose(page, 'project-sort-filter', 'Title');
  await choose(page, 'project-order-filter', 'Descending');
  await expect.poll(() => query(page).get('sort')).toBe('title');
  keep();
  await choose(page, 'project-view-filter', 'List');
  await expect(page.locator('[data-projects-list-table]')).toBeVisible();
  keep();
  const order = await page.locator('[data-projects-list-table] tr[data-project-id]')
    .evaluateAll((rows) => rows.map((row) => Number(row.dataset.projectId)));
  expect(order).toEqual([gamma.id, beta.id, alpha.id]);
  // The toolbar View switcher keeps them too.
  await closeDialog(page);
  await page.getByRole('link', { name: 'Grid view', exact: true }).click();
  await settled(page);
  await expect(page.locator('[data-projects-live-region] .project-grid')).toBeVisible();
  keep();
  expect(delta.id).toBeGreaterThan(0);
});

test('P: pagination, reload and Back/Forward keep repeated Projects', async ({ page }) => {
  seed();
  const many = [];
  for (let index = 0; index < 27; index += 1) many.push(fixture.project(`Paged ${String(index).padStart(2, '0')}`).id);
  const control = watch(page);
  await start(page, projectsUrl(fixture.baseURL, many, { sort: 'title', order: 'asc', view: 'list' }));
  await expect(page.locator('.pagination')).toContainText('Page 1 of 2');
  await page.locator('.pagination a', { hasText: 'Next' }).click();
  await settled(page);
  await expect(page.locator('.pagination')).toContainText('Page 2 of 2');
  expect(query(page).get('page')).toBe('2');
  expectRepeated(page.url(), 'project', many);
  await expectListing(page, many.slice(25), 27);

  await page.goBack();
  await settled(page);
  await expect(page.locator('.pagination')).toContainText('Page 1 of 2');
  expectRepeated(page.url(), 'project', many);
  await page.goForward();
  await settled(page);
  await expect(page.locator('.pagination')).toContainText('Page 2 of 2');
  await page.reload();
  await enhanced(page);
  expectRepeated(page.url(), 'project', many);
  await openDialog(page);
  expect(await summaryText(page, 'project-project-filter')).toBe('27 projects selected');
  // A filter change from the dialog keeps all 27 and returns to page 1.
  await choose(page, 'project-status-filter', 'Planned');
  await expect.poll(() => query(page).has('page')).toBe(false);
  expectRepeated(page.url(), 'project', many);
  for (const get of control.gets) expect(get.searchParams.getAll('project').some((value) => value.includes(','))).toBe(false);
});

test('Z: the NSFW toggle after dialog edits refreshes the same repeated Projects and Search', async ({ page }) => {
  const { alpha, gamma } = seed();
  const control = watch(page);
  await start(page);
  await openDialog(page);
  await choose(page, 'project-project-filter', alpha.title);
  await choose(page, 'project-project-filter', gamma.title);
  await page.locator('#projects-search').fill('Sel');
  await expect.poll(() => query(page).get('search')).toBe('Sel');
  await settled(page);
  await closeDialog(page);
  const before = page.url();
  const gets = control.gets.length;

  await page.locator('#projects-nsfw-toggle').click();
  await expect(page.locator('#projects-nsfw-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#projects-nsfw-toggle')).toBeEnabled();
  await settled(page);
  expect(control.gets.length).toBe(gets + 1);
  expectRepeated(control.gets.at(-1).href, 'project', [alpha.id, gamma.id]);
  expect(control.gets.at(-1).searchParams.get('search')).toBe('Sel');
  expect(page.url()).toBe(before);
  await expectListing(page, [alpha.id, gamma.id]);
  await openDialog(page);
  expect((await checkedValues(page, 'project-project-filter')).sort()).toEqual([String(alpha.id), String(gamma.id)].sort());
});

test('AA: a pending Grid/List switch and a newer navigation during the NSFW POST keep their intent', async ({ page }) => {
  const { alpha, beta, gamma } = seed();
  await start(page, projectsUrl(fixture.baseURL, [alpha.id, gamma.id]));

  // Pending List switch: the NSFW refresh adopts it and its owed push.
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await page.route((url) => url.pathname === '/projects' && url.searchParams.get('view') === 'list', async (route) => {
    await held;
    await route.continue();
  });
  const historyBefore = await page.evaluate(() => history.length);
  await page.getByRole('link', { name: 'List view', exact: true }).click();
  await page.locator('#projects-nsfw-toggle').click();
  release();
  await expect(page.locator('#projects-nsfw-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#projects-nsfw-toggle')).toBeEnabled();
  await settled(page);
  await expect(page.locator('[data-projects-list-table]')).toBeVisible();
  expect(query(page).get('view')).toBe('list');
  expectRepeated(page.url(), 'project', [alpha.id, gamma.id]);
  await expect.poll(() => page.evaluate(() => history.length)).toBe(historyBefore + 1);
  await page.unroute(() => true);

  // A newer dialog edit during the NSFW POST wins over the older destination.
  let releasePost;
  const heldPost = new Promise((resolve) => { releasePost = resolve; });
  await page.route('**/projects/nsfw-filter', async (route) => {
    await heldPost;
    await route.continue();
  });
  await page.locator('#projects-nsfw-toggle').click();
  await openDialog(page);
  await choose(page, 'project-project-filter', beta.title);
  releasePost();
  await expect(page.locator('#projects-nsfw-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#projects-nsfw-toggle')).toBeEnabled();
  await settled(page);
  expectRepeated(page.url(), 'project', [alpha.id, beta.id, gamma.id]);
  await expectListing(page, [alpha.id, beta.id, gamma.id]);
  expect(await dialog(page).evaluate((element) => element.open)).toBe(true);
});

// WP10b F1: a toolbar Grid/List link was rendered against the installed page.
// Clicked while a filter change is still debounced, in flight or failed, the
// View must apply to that newest intended filter state, never discard it.

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

/** Selects one dropdown option without waiting for its GET to settle. */
async function pickPending(page, id, label) {
  const details = await openDropdown(page, id);
  await details.locator('.asset-filter-multiselect-option label').getByText(label, { exact: true }).first().click();
  await details.locator('summary').click();
  await expect(details).toHaveJSProperty('open', false);
}

/** The observable outcome: last live GET, installed results, address and presentation. */
async function outcome(page, control) {
  const ids = (list) => [...list].map(String).sort();
  const last = control.gets.at(-1);
  const address = query(page);
  return {
    request: {
      project: ids(last.searchParams.getAll('project')),
      search: last.searchParams.get('search'),
      view: last.searchParams.get('view'),
    },
    count: await totalCount(page),
    rendered: ids(await renderedIds(page)),
    address: {
      project: ids(address.getAll('project')),
      search: address.get('search'),
      view: address.get('view'),
    },
    list: await page.locator('[data-projects-list-table]').isVisible(),
    grid: await page.locator('[data-projects-live-region] .project-grid').isVisible(),
  };
}

function expected({ projects, search = null, view, count = projects.length, rendered = projects }) {
  const ids = (list) => [...list].map(String).sort();
  return {
    request: { project: ids(projects), search, view },
    count,
    rendered: ids(rendered),
    address: { project: ids(projects), search, view },
    list: view === 'list',
    grid: view !== 'list',
  };
}

test('F1-A: List during a held single-Project GET keeps that Project after the dialog closes', async ({ page }) => {
  const { alpha, beta, gamma, delta } = seed();
  const control = watch(page);
  await start(page);
  await expectListing(page, [alpha.id, beta.id, gamma.id, delta.id]);
  const held = await holdGets(page, (url) => url.searchParams.get('view') !== 'list');
  await openDialog(page);
  await pickPending(page, 'project-project-filter', alpha.title);
  await expect.poll(() => held.length).toBe(1);
  await closeDialog(page);

  await page.getByRole('link', { name: 'List view', exact: true }).click();
  await settled(page);
  await expect(page.locator('[data-projects-list-table]')).toBeVisible();
  expect.soft(await outcome(page, control)).toEqual(expected({ projects: [alpha.id], view: 'list' }));
  held.forEach((entry) => entry.release());
  await expectListing(page, [alpha.id]);

  await page.reload();
  await enhanced(page);
  await expectListing(page, [alpha.id]);
  await expect(page.locator('[data-projects-list-table]')).toBeVisible();
  await openDialog(page);
  expect(await checkedValues(page, 'project-project-filter')).toEqual([String(alpha.id)]);
  expect(await checkedValues(page, 'project-view-filter')).toEqual(['list']);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('F1-B: List during a held second-Project GET keeps both repeated Projects in later Grid/List links', async ({ page }) => {
  const { alpha, gamma } = seed();
  const control = watch(page);
  await start(page);
  await openDialog(page);
  await choose(page, 'project-project-filter', alpha.title);
  const held = await holdGets(page, (url) => url.searchParams.get('view') !== 'list');
  await pickPending(page, 'project-project-filter', gamma.title);
  await expect.poll(() => held.length).toBe(1);
  await closeDialog(page);

  await page.getByRole('link', { name: 'List view', exact: true }).click();
  await settled(page);
  await expect(page.locator('[data-projects-list-table]')).toBeVisible();
  expect.soft(await outcome(page, control)).toEqual(expected({ projects: [alpha.id, gamma.id], view: 'list' }));
  held.forEach((entry) => entry.release());
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await expectListing(page, [alpha.id, gamma.id]);
  expectRepeated(page.url(), 'project', [alpha.id, gamma.id]);
  for (const get of control.gets) expect(get.searchParams.getAll('project').some((value) => value.includes(','))).toBe(false);
  const rows = await page.locator('[data-projects-list-table] tr[data-project-id]')
    .evaluateAll((elements) => elements.map((row) => Number(row.dataset.projectId)).sort((a, b) => a - b));
  expect(rows).toEqual([alpha.id, gamma.id].sort((a, b) => a - b));

  for (const name of ['Grid view', 'List view']) {
    expectRepeated(await page.getByRole('link', { name, exact: true }).getAttribute('href'), 'project', [alpha.id, gamma.id]);
  }
  await page.getByRole('link', { name: 'Grid view', exact: true }).click();
  await settled(page);
  await expect(page.locator('[data-projects-live-region] .project-grid')).toBeVisible();
  await expectListing(page, [alpha.id, gamma.id]);
  expectRepeated(page.url(), 'project', [alpha.id, gamma.id]);
});

test('F1-C: List before a debounced Search fires keeps the Search and both Projects', async ({ page }) => {
  const { alpha, beta, gamma } = seed();
  const control = watch(page);
  await start(page);
  await openDialog(page);
  await choose(page, 'project-project-filter', alpha.title);
  await choose(page, 'project-project-filter', gamma.title);
  await expectListing(page, [alpha.id, gamma.id]);
  const before = control.gets.length;

  // A paused page clock keeps the typed Search inside its debounce until the
  // toolbar click, however long the dialog takes to close.
  await page.clock.install();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await page.locator('#projects-search').fill('Alpha');
  await closeDialog(page);
  await page.getByRole('link', { name: 'List view', exact: true }).click();
  await page.clock.resume();
  await settled(page);
  await expect(page.locator('[data-projects-list-table]')).toBeVisible();
  // The click ran inside the debounce: the Search was never requested alone.
  expect(control.gets.slice(before).map((url) => url.searchParams.get('view'))).toEqual(['list']);
  expect.soft(await outcome(page, control)).toEqual(expected({
    projects: [alpha.id, gamma.id], search: 'Alpha', view: 'list', count: 1, rendered: [alpha.id],
  }));
  await expectListing(page, [alpha.id]);

  await page.reload();
  await enhanced(page);
  await expectListing(page, [alpha.id]);
  expect(query(page).get('search')).toBe('Alpha');
  expectRepeated(page.url(), 'project', [alpha.id, gamma.id]);
  await expect(page.locator('[data-projects-list-table]')).toBeVisible();
  await expect(page.locator('#projects-search')).toHaveValue('Alpha');
  expect(beta.id).toBeGreaterThan(0);
});

test('F1-D: every filter dimension survives a toolbar View click during a pending change', async ({ page }) => {
  const { red, alpha, beta, gamma } = seed();
  const control = watch(page);
  await start(page, projectsUrl(fixture.baseURL, [alpha.id, beta.id, gamma.id], { sort: 'title', order: 'desc', search: 'Sel' }));
  await openDialog(page);
  await choose(page, 'project-status-filter', 'Planned');
  await choose(page, 'project-type-filter', 'Comic');
  await choose(page, 'project-type-filter', 'Images');
  await expectListing(page, [alpha.id, gamma.id]);
  const held = await holdGets(page, (url) => url.searchParams.get('view') !== 'list');
  await pickPending(page, 'project-tag-filter', red.name);
  await expect.poll(() => held.length).toBe(1);
  await closeDialog(page);

  await page.getByRole('link', { name: 'List view', exact: true }).click();
  await settled(page);
  await expect(page.locator('[data-projects-list-table]')).toBeVisible();
  held.forEach((entry) => entry.release());
  const address = query(page);
  expectRepeated(page.url(), 'project', [alpha.id, beta.id, gamma.id]);
  expect(address.getAll('status')).toEqual(['planned']);
  expectRepeated(page.url(), 'type', ['comic', 'images']);
  expect(address.getAll('tag')).toEqual([String(red.id)]);
  expect(address.get('search')).toBe('Sel');
  expect(address.get('sort')).toBe('title');
  expect(address.get('order')).toBe('desc');
  expect(address.get('view')).toBe('list');
  await expectListing(page, [alpha.id, gamma.id]);
  const rows = await page.locator('[data-projects-list-table] tr[data-project-id]')
    .evaluateAll((elements) => elements.map((row) => Number(row.dataset.projectId)));
  expect(rows).toEqual([gamma.id, alpha.id]);
  expect(control.errors).toEqual([]);
});

test('F1-E: Grid from List during a pending change keeps the filter and shows Grid', async ({ page }) => {
  const { alpha, beta, gamma } = seed();
  const control = watch(page);
  await start(page, projectsUrl(fixture.baseURL, [], { view: 'list' }));
  await expect(page.locator('[data-projects-list-table]')).toBeVisible();
  const held = await holdGets(page, (url) => url.searchParams.get('view') === 'list');
  await openDialog(page);
  await pickPending(page, 'project-project-filter', beta.title);
  await expect.poll(() => held.length).toBe(1);
  await closeDialog(page);

  await page.getByRole('link', { name: 'Grid view', exact: true }).click();
  await settled(page);
  await expect(page.locator('[data-projects-live-region] .project-grid')).toBeVisible();
  expect.soft(await outcome(page, control)).toEqual(expected({ projects: [beta.id], view: null }));
  held.forEach((entry) => entry.release());
  await expectListing(page, [beta.id]);
  await openDialog(page);
  expect(await checkedValues(page, 'project-view-filter')).toEqual(['grid']);
  expect([alpha.id, gamma.id].every((id) => id > 0)).toBe(true);
});

test('F1-F: history after a View click that superseded a filter GET stays coherent', async ({ page }) => {
  const { alpha, gamma } = seed();
  const control = watch(page);
  await start(page, projectsUrl(fixture.baseURL, [alpha.id]));
  await expectListing(page, [alpha.id]);
  const historyBefore = await page.evaluate(() => history.length);
  const shown = page.url();
  const held = await holdGets(page, () => true);
  await openDialog(page);
  await pickPending(page, 'project-project-filter', gamma.title);
  await expect.poll(() => held.length).toBe(1);
  await closeDialog(page);

  await page.getByRole('link', { name: 'List view', exact: true }).click();
  await expect.poll(() => held.length).toBe(2);
  // Newest first; the superseded GET is released last and must not install.
  held[1].release();
  await settled(page);
  held[0].release();
  await expect(page.locator('[data-projects-list-table]')).toBeVisible();
  expect.soft(await outcome(page, control)).toEqual(expected({ projects: [alpha.id, gamma.id], view: 'list' }));
  const listed = page.url();
  await expect.poll(() => page.evaluate(() => history.length)).toBe(historyBefore + 1);
  await page.unrouteAll({ behavior: 'ignoreErrors' });

  await page.goBack();
  await settled(page);
  expect(page.url()).toBe(shown);
  await expectListing(page, [alpha.id]);
  await expect(page.locator('[data-projects-live-region] .project-grid')).toBeVisible();
  await openDialog(page);
  expect(await checkedValues(page, 'project-project-filter')).toEqual([String(alpha.id)]);
  expect(await checkedValues(page, 'project-view-filter')).toEqual(['grid']);
  await closeDialog(page);

  await page.goForward();
  await settled(page);
  expect(page.url()).toBe(listed);
  await expectListing(page, [alpha.id, gamma.id]);
  await expect(page.locator('[data-projects-list-table]')).toBeVisible();
  await openDialog(page);
  expect((await checkedValues(page, 'project-project-filter')).sort()).toEqual([String(alpha.id), String(gamma.id)].sort());
  expect(await checkedValues(page, 'project-view-filter')).toEqual(['list']);
});

test('F1-G: a failed superseding View GET keeps the page and retries the same destination GET-only', async ({ page }) => {
  const { alpha, beta, gamma, delta } = seed();
  const control = watch(page);
  await start(page);
  await expectListing(page, [alpha.id, beta.id, gamma.id, delta.id]);
  const shown = page.url();
  const held = await holdGets(page, () => true);
  await openDialog(page);
  await pickPending(page, 'project-project-filter', alpha.title);
  await expect.poll(() => held.length).toBe(1);
  await closeDialog(page);

  await page.getByRole('link', { name: 'List view', exact: true }).click();
  await expect.poll(() => held.length).toBe(2);
  held[1].release('fail');
  await expect(page.locator('[data-live-filter-failure]')).toBeVisible();
  held[0].release();
  await settled(page);
  // No misleading installation: the previous results and address remain.
  expect(page.url()).toBe(shown);
  await expectListing(page, [alpha.id, beta.id, gamma.id, delta.id]);
  await expect(page.locator('[data-projects-live-region] .project-grid')).toBeVisible();
  await page.unrouteAll({ behavior: 'ignoreErrors' });

  const posts = control.posts.length;
  await page.locator('[data-live-filter-retry]').click();
  await settled(page);
  expect(control.gets.at(-1).href).toBe(held[1].url.href);
  expect.soft(await outcome(page, control)).toEqual(expected({ projects: [alpha.id], view: 'list' }));
  await expect(page.locator('[data-live-filter-failure]')).toHaveCount(0);
  expect(control.posts.length).toBe(posts);
  expect(control.defaultsPosts()).toEqual([]);
});
