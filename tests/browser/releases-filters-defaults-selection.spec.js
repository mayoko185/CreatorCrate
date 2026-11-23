import { expect, test } from '@playwright/test';
import {
  checkedValues, choose, closeDialog, closeDropdown, createReleasesFixture, dialog, enhanced, expectRepeated, expectTitles,
  openDialog, openDropdown, pageAuthority, query, releasesUrl, settled, summaryText, watch,
} from './releases-filters-defaults-fixture.js';

// WP12 C–J, O, P, R–T: results Search, one/many Projects (OR) with option
// search, Project Types, Project + Type (AND), unrestricted Select all,
// Schedule / Include archived, Sort and Sort order, exact-asset scope and
// Reset, the URL page size, Back/Forward and reload, held/stale GETs, and a
// failed GET with GET-only Retry — on the real page with real URLs/results.

const fixture = createReleasesFixture('releases-fd-selection');

test.beforeAll(async () => {
  await fixture.start();
});

test.afterAll(async () => {
  await fixture.stop();
});

function seed() {
  fixture.isolate();
  const comicA = fixture.project('Sel Comic A', { projectType: 'comic' });
  const comicB = fixture.project('Sel Comic B', { projectType: 'comic' });
  const anim = fixture.project('Sel Anim', { projectType: 'animation' });
  const images = fixture.project('Sel Images', { projectType: 'images' });
  const releases = {
    ca1: fixture.release(comicA, 'CA overdue', { plannedDate: '2000-01-01' }),
    ca2: fixture.release(comicA, 'CA upcoming', { plannedDate: '2999-01-01' }),
    cb1: fixture.release(comicB, 'CB unscheduled'),
    an1: fixture.release(anim, 'AN overdue', { plannedDate: '2000-01-02' }),
    im1: fixture.release(images, 'IM unscheduled'),
    caArchived: fixture.release(comicA, 'CA archived', { plannedDate: '2000-01-03', archived: true }),
  };
  return { comicA, comicB, anim, images, ...releases };
}

async function start(page, url = `${fixture.baseURL}/releases`) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(url);
  await enhanced(page);
}

test('C: the dialog Search filters the actual results, debounced, resets page 1, with live empty state and recovery', async ({ page }) => {
  const s = seed();
  for (let i = 0; i < 3; i += 1) fixture.release(s.images, `IM extra ${i}`);
  const control = watch(page);
  await start(page, releasesUrl(fixture.baseURL, { pageSize: 2, sort: 'title', page: 2 }));
  await openDialog(page);
  const search = page.locator('#releases-search');
  await search.pressSequentially('upc', { delay: 30 });
  await expect.poll(() => query(page).get('search')).toBe('upc');
  await settled(page);
  // One debounced GET for the whole typed word.
  expect(control.gets.filter((url) => url.searchParams.has('search'))).toHaveLength(1);
  expect(query(page).has('page')).toBe(false);
  expect(query(page).get('pageSize')).toBe('2');
  await expectTitles(page, [s.ca2.title]);
  await expect(search).toBeFocused();

  await search.fill('no-such-release');
  await expect.poll(() => query(page).get('search')).toBe('no-such-release');
  await settled(page);
  await expect(page.locator('[data-releases-live-region]')).toContainText('No releases match the current filters');
  // The option-search inside a dropdown never searches the results.
  await openDropdown(page, 'release-project-filter');
  await page.locator('#release-project-filter-search').fill('Sel');
  await page.waitForTimeout(500);
  expect(query(page).get('search')).toBe('no-such-release');
  await closeDropdown(page, 'release-project-filter');
  await closeDialog(page);

  await page.locator('[data-releases-live-region] [data-releases-reset]').click();
  await settled(page);
  expect(query(page).has('search')).toBe(false);
  expect(query(page).get('pageSize')).toBe('2');
  await openDialog(page);
  await expect(search).toHaveValue('');
  expect(control.defaultsPosts()).toEqual([]);
});

test('D/E/H: one and many Projects (OR) survive option search; Select all is unrestricted; repeated never comma-joined', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  await start(page);
  await openDialog(page);

  await choose(page, 'release-project-filter', s.comicA.title);
  expectRepeated(page.url(), 'project', [s.comicA.id]);
  await expectTitles(page, [s.ca1.title, s.ca2.title], { sorted: true });
  expect(await summaryText(page, 'release-project-filter')).toBe(s.comicA.title);

  // E: search the option list for another Project; the selected one is hidden
  // by the search but stays checked and keeps restricting.
  await choose(page, 'release-project-filter', s.anim.title, { search: 'Anim' });
  expectRepeated(page.url(), 'project', [s.comicA.id, s.anim.id]);
  expect(page.url()).not.toContain('%2C');
  await expectTitles(page, [s.ca1.title, s.ca2.title, s.an1.title], { sorted: true });
  expect(await summaryText(page, 'release-project-filter')).toBe('2 projects selected');
  expect((await checkedValues(page, 'release-project-filter')).sort()).toEqual([s.comicA.id, s.anim.id].map(String).sort());

  // A second, unrelated filter change keeps both Projects (WP11 limitation).
  await choose(page, 'list-schedule', 'Overdue');
  expectRepeated(page.url(), 'project', [s.comicA.id, s.anim.id]);
  expect(query(page).get('schedule')).toBe('overdue');
  await expectTitles(page, [s.ca1.title, s.an1.title], { sorted: true });

  // H: Select all clears the restriction (no project key at all).
  await choose(page, 'release-project-filter', 'Select all');
  expect(query(page).getAll('project')).toEqual([]);
  expect(await summaryText(page, 'release-project-filter')).toBe('All projects');
  expect(await checkedValues(page, 'release-project-filter')).toEqual(['']);
  await expectTitles(page, [s.ca1.title, s.an1.title], { sorted: true });

  // Options come from the backend, never from the current results page.
  const optionValues = await page.locator('#release-project-filter input[name="project"]').evaluateAll(
    (inputs) => inputs.map((input) => input.value),
  );
  for (const owner of [s.comicA, s.comicB, s.anim, s.images]) expect(optionValues).toContain(String(owner.id));
  expect(control.defaultsPosts()).toEqual([]);
});

test('F/G/H: Project Types multi-select by catalogue value, AND with Projects, unrestricted Select all', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  await start(page, releasesUrl(fixture.baseURL, { sort: 'title' }));
  await openDialog(page);

  await choose(page, 'release-type-filter', 'Comic');
  expectRepeated(page.url(), 'type', ['comic']);
  await expectTitles(page, [s.ca1.title, s.ca2.title, s.cb1.title]);
  await choose(page, 'release-type-filter', 'Animation', { search: 'ani' });
  expectRepeated(page.url(), 'type', ['animation', 'comic']);
  expect(await summaryText(page, 'release-type-filter')).toBe('2 types selected');
  await expectTitles(page, [s.an1.title, s.ca1.title, s.ca2.title, s.cb1.title]);

  // G: Projects AND Types.
  await choose(page, 'release-project-filter', s.comicA.title);
  await choose(page, 'release-project-filter', s.images.title);
  expectRepeated(page.url(), 'project', [s.comicA.id, s.images.id]);
  expectRepeated(page.url(), 'type', ['animation', 'comic']);
  await expectTitles(page, [s.ca1.title, s.ca2.title]);

  // Reload restores every repeated selection in the dialog and results.
  await page.reload();
  await enhanced(page);
  await openDialog(page);
  expect((await checkedValues(page, 'release-type-filter')).sort()).toEqual(['animation', 'comic']);
  expect((await checkedValues(page, 'release-project-filter')).sort()).toEqual([s.comicA.id, s.images.id].map(String).sort());
  await expectTitles(page, [s.ca1.title, s.ca2.title]);

  // H: unrestricted Select all for Types removes every type key.
  await choose(page, 'release-type-filter', 'Select all');
  expect(query(page).getAll('type')).toEqual([]);
  expect(await summaryText(page, 'release-type-filter')).toBe('All types');
  await expectTitles(page, [s.ca1.title, s.ca2.title, s.im1.title]);
  expect(control.defaultsPosts()).toEqual([]);
});

test('I/J: Schedule and Include archived give the existing subsets; Sort and Sort order reorder the results', async ({ page }) => {
  const s = seed();
  await start(page, releasesUrl(fixture.baseURL, { project: s.comicA.id }));
  await openDialog(page);
  await choose(page, 'list-sort', 'Title');
  await expectTitles(page, [s.ca1.title, s.ca2.title]);

  await page.locator('#list-includeArchived').check();
  await settled(page);
  expect(query(page).get('includeArchived')).toBe('1');
  await expectTitles(page, [s.caArchived.title, s.ca1.title, s.ca2.title]);

  await choose(page, 'list-order', 'Descending');
  expect(query(page).get('order')).toBe('desc');
  await expectTitles(page, [s.ca2.title, s.ca1.title, s.caArchived.title]);

  // Schedule keeps the existing active-workflow restriction with archived.
  await choose(page, 'list-schedule', 'Overdue');
  await expectTitles(page, [s.ca1.title]);
  await choose(page, 'list-schedule', 'Upcoming');
  await expectTitles(page, [s.ca2.title]);
  await page.locator('#list-includeArchived').uncheck();
  await settled(page);
  expect(query(page).has('includeArchived')).toBe(false);
  await expectTitles(page, [s.ca2.title]);

  // The results of the dialog equal a direct server GET of the same URL.
  const direct = await page.request.get(page.url());
  const html = await direct.text();
  expect(html).toContain(s.ca2.title);
  expect(html).not.toContain(s.ca1.title);
});

test('O/P/N: exact-asset scope is kept by filtering and sorting; Reset filters removes it and keeps the page size', async ({ page }) => {
  const s = seed();
  const assetId = fixture.asset(s.comicA, 'scoped.png');
  fixture.addAsset(s.ca1, assetId);
  fixture.addAsset(s.ca2, assetId);
  fixture.addAsset(s.caArchived, assetId);
  fixture.writePageDefault('releases', 'sort', 'title');
  const control = watch(page);
  await start(page, releasesUrl(fixture.baseURL, { asset: assetId, pageSize: 5, sort: 'title' }));
  await openDialog(page);
  await expect(dialog(page).locator('[data-releases-asset-scope]')).toContainText('scoped.png');

  await choose(page, 'list-order', 'Descending');
  expect(query(page).get('asset')).toBe(String(assetId));
  expect(query(page).get('pageSize')).toBe('5');
  await expectTitles(page, [s.ca2.title, s.ca1.title]);
  await page.locator('#releases-search').fill('overdue');
  await expect.poll(() => query(page).get('search')).toBe('overdue');
  await settled(page);
  expect(query(page).get('asset')).toBe(String(assetId));
  await expectTitles(page, [s.ca1.title]);
  await choose(page, 'release-type-filter', 'Comic');
  await choose(page, 'list-schedule', 'Overdue');
  await page.locator('#list-includeArchived').check();
  await settled(page);
  expect(query(page).get('asset')).toBe(String(assetId));

  const generation = fixture.generation();
  await dialog(page).locator('[data-releases-filters-reset]').click();
  await settled(page);
  // N: every temporary control cleared, Sort/Order = saved/effective,
  // page size kept, exact-asset scope removed, page 1, no defaults write.
  expect([...query(page).keys()].sort()).toEqual(['pageSize', 'sort']);
  expect(query(page).get('pageSize')).toBe('5');
  expect(query(page).get('sort')).toBe('title');
  await expect(dialog(page).locator('[data-releases-asset-scope]')).toHaveCount(0);
  await expect(page.locator('#list-releases-filter input[name="asset"]')).toHaveCount(0);
  await expect(page.locator('#releases-search')).toHaveValue('');
  expect(await checkedValues(page, 'release-project-filter')).toEqual(['']);
  expect(await checkedValues(page, 'release-type-filter')).toEqual(['']);
  expect(await summaryText(page, 'list-schedule')).toBe('All');
  await expect(page.locator('#list-includeArchived')).not.toBeChecked();
  expect(await summaryText(page, 'list-sort')).toBe('Title');
  expect(await summaryText(page, 'list-order')).toBe('Ascending');
  await expectTitles(page, [s.an1.title, s.ca1.title, s.ca2.title, s.cb1.title, s.im1.title]);
  await expect(page.locator('[data-releases-live-region] .results-meta')).not.toContainText('containing asset');
  expect((await pageAuthority(page)).current).toEqual({ sort: 'title', order: 'asc' });
  expect(control.defaultsPosts()).toEqual([]);
  expect(fixture.generation()).toBe(generation);
  expect(fixture.storedReleasesDefaults()).toEqual({ sort: 'title', order: undefined });

  // An invalid scope is never widened into an unrestricted listing.
  const invalid = await page.request.get(`${fixture.baseURL}/releases?asset=abc`);
  expect(invalid.status()).toBe(400);
});

test('R: Back/Forward and reload reconcile the dialog, URL and results', async ({ page }) => {
  const s = seed();
  await start(page);
  await openDialog(page);
  await choose(page, 'release-project-filter', s.comicA.title);
  await choose(page, 'release-project-filter', s.comicB.title);
  const twoProjects = page.url();
  await choose(page, 'list-sort', 'Title');
  await expectTitles(page, [s.ca1.title, s.ca2.title, s.cb1.title]);
  await closeDialog(page);

  await page.goBack();
  await settled(page);
  expect(page.url()).toBe(twoProjects);
  await openDialog(page);
  expect((await checkedValues(page, 'release-project-filter')).sort()).toEqual([s.comicA.id, s.comicB.id].map(String).sort());
  expect(await summaryText(page, 'list-sort')).toBe('Planned');
  await closeDialog(page);

  await page.goBack();
  await settled(page);
  await openDialog(page);
  expect(await checkedValues(page, 'release-project-filter')).toEqual([String(s.comicA.id)]);
  await expectTitles(page, [s.ca1.title, s.ca2.title], { sorted: true });
  await closeDialog(page);

  await page.goForward();
  await settled(page);
  await page.goForward();
  await settled(page);
  await openDialog(page);
  expect(await summaryText(page, 'list-sort')).toBe('Title');
  expect((await checkedValues(page, 'release-project-filter')).sort()).toEqual([s.comicA.id, s.comicB.id].map(String).sort());
  await expectTitles(page, [s.ca1.title, s.ca2.title, s.cb1.title]);

  await page.reload();
  await enhanced(page);
  await openDialog(page);
  expect(await summaryText(page, 'list-sort')).toBe('Title');
  await expectTitles(page, [s.ca1.title, s.ca2.title, s.cb1.title]);
});

test('S: a held Search GET superseded by a Sort edit never installs; the stale response delivered last is ignored', async ({ page }) => {
  const s = seed();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await page.route((url) => url.pathname === '/releases' && url.searchParams.get('search') === 'CA'
    && !url.searchParams.has('sort', 'title'), async (route) => {
    await held;
    await route.continue().catch(() => {});
  });
  await start(page);
  await openDialog(page);
  await page.locator('#releases-search').fill('CA');
  await expect(page.locator('[data-releases-live-region]')).toHaveAttribute('aria-busy', 'true');
  await choose(page, 'list-sort', 'Title');
  expect(query(page).get('search')).toBe('CA');
  expect(query(page).get('sort')).toBe('title');
  await expectTitles(page, [s.ca1.title, s.ca2.title]);
  release();
  await page.waitForTimeout(400);
  expect(query(page).get('sort')).toBe('title');
  expect(await summaryText(page, 'list-sort')).toBe('Title');
  await expectTitles(page, [s.ca1.title, s.ca2.title]);

  // Pending Projects followed by a pagination-independent second filter:
  // the newer navigation keeps both selections.
  let releaseProjects;
  const heldProjects = new Promise((resolve) => { releaseProjects = resolve; });
  await page.route((url) => url.pathname === '/releases' && url.searchParams.getAll('project').length === 1
    && !url.searchParams.has('schedule'), async (route) => {
    await heldProjects;
    await route.continue().catch(() => {});
  });
  const projects = await openDropdown(page, 'release-project-filter');
  await projects.locator(`input[value="${s.comicA.id}"]`).check();
  await closeDropdown(page, 'release-project-filter');
  await choose(page, 'list-schedule', 'Overdue');
  releaseProjects();
  await page.waitForTimeout(400);
  expectRepeated(page.url(), 'project', [s.comicA.id]);
  expect(query(page).get('schedule')).toBe('overdue');
  await expectTitles(page, [s.ca1.title]);
});

test('T: a failed GET keeps the chosen controls and offers a GET-only Retry that applies them', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  let failNext = true;
  await page.route((url) => url.pathname === '/releases' && url.searchParams.get('type') === 'animation', async (route) => {
    if (failNext) {
      failNext = false;
      await route.fulfill({ status: 503, body: 'unavailable' });
      return;
    }
    await route.continue();
  });
  await start(page);
  await openDialog(page);
  await choose(page, 'release-type-filter', 'Animation');
  const notice = page.locator('[data-live-filter-failure]');
  await expect(notice).toBeVisible();
  // The previous results stay; the requested control stays chosen.
  await expectTitles(page, [s.ca1.title, s.an1.title, s.ca2.title, s.cb1.title, s.im1.title], { sorted: true });
  expect(await checkedValues(page, 'release-type-filter')).toEqual(['animation']);
  // Save is refused while the load failed.
  await dialog(page).locator('[data-releases-defaults-save]').click();
  await expect(dialog(page).locator('[data-settings-fetch-save-status]'))
    .toHaveText('The current filters did not load. Retry loading them before saving defaults.');

  const postsBefore = control.posts.length;
  await notice.getByRole('button', { name: 'Retry' }).click();
  await settled(page);
  await expect(notice).toHaveCount(0);
  expectRepeated(page.url(), 'type', ['animation']);
  await expectTitles(page, [s.an1.title]);
  expect(control.posts.length).toBe(postsBefore);
  expect(control.defaultsPosts()).toEqual([]);
});
