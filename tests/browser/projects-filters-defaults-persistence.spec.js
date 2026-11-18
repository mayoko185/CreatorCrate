import { expect, test } from '@playwright/test';
import {
  SEVEN, checkedValues, choose, closeDialog, createProjectsFixture, dialog, enhanced, expectListing, expectRepeated,
  openDialog, openDropdown, pageAuthority, projectsUrl, query, settled, summaryText, watch,
} from './projects-filters-defaults-fixture.js';

// WP10b R–Y and the Save / Reset race cases: explicit Save of exactly seven
// settings, Reset filters (read-only, all controls), Reset defaults
// (isolated deletion keeping the temporary context), failed-refresh
// recovery without replaying a confirmed mutation, and fail-closed
// initialization, on the real page with SQLite inspection.

const fixture = createProjectsFixture('projects-fd-persistence');

test.beforeAll(async () => {
  await fixture.start();
});

test.afterAll(async () => {
  await fixture.stop();
});

function seed() {
  fixture.isolate();
  fixture.writePageDefault('assetViewer', 'sort', 'size');
  const red = fixture.tag('Persist Red');
  const alpha = fixture.project('Persist Alpha', { status: 'planned', projectType: 'comic', tags: [red] });
  const beta = fixture.project('Persist Beta', { status: 'ready', projectType: 'images' });
  const gamma = fixture.project('Persist Gamma', { status: 'planned', projectType: 'comic' });
  const delta = fixture.project('Persist Delta', { status: 'in-progress', projectType: 'wallpaper', tags: [red] });
  return { red, alpha, beta, gamma, delta };
}

async function start(page, url = `${fixture.baseURL}/projects`) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(url);
  await enhanced(page);
}

const statusLine = (page) => dialog(page).locator('[data-settings-fetch-save-status]');
const indicator = (page) => dialog(page).locator('[data-projects-defaults-indicator]');
const saveButton = (page) => dialog(page).locator('[data-projects-defaults-save]');
const resetDefaultsButton = (page) => dialog(page).locator('[data-projects-defaults-reset]');
const resetFiltersButton = (page) => dialog(page).locator('[data-projects-filters-reset]');

async function chooseSavedLayout(page, red) {
  // R2: Grid style is shown (and so chosen) while the View is still Grid; List
  // then hides it and retains the choice.
  await choose(page, 'project-grid-style-filter', 'Cropped');
  await choose(page, 'project-view-filter', 'List');
  await choose(page, 'project-sort-filter', 'Title');
  await choose(page, 'project-order-filter', 'Ascending');
  await choose(page, 'project-status-filter', 'Planned');
  await choose(page, 'project-status-filter', 'In Progress');
  await choose(page, 'project-type-filter', 'Comic');
  await choose(page, 'project-type-filter', 'Wallpaper');
  await choose(page, 'project-tag-filter', red.name);
}

test('R/S: ordinary edits never POST; Save persists exactly the seven settings once, not Search or Projects', async ({ page }) => {
  const { red, alpha, gamma, delta } = seed();
  const control = watch(page);
  await start(page);
  await openDialog(page);
  await choose(page, 'project-project-filter', alpha.title);
  await choose(page, 'project-project-filter', delta.title);
  await page.locator('#projects-search').fill('Persist');
  await expect.poll(() => query(page).get('search')).toBe('Persist');
  await settled(page);
  await chooseSavedLayout(page, red);
  await expectListing(page, [alpha.id, delta.id]);
  expect(control.defaultsPosts()).toEqual([]);
  const before = page.url();

  await saveButton(page).click();
  await expect(statusLine(page)).toHaveText('Defaults saved.');
  // R1: the indicator now reads exactly the status line, so it steps aside.
  await expect(indicator(page)).toHaveText('Defaults saved.');
  await expect(indicator(page)).toBeHidden();
  expect(control.defaultsPosts()).toHaveLength(1);
  const body = control.defaultsPosts()[0].body;
  expect(control.defaultsPosts()[0].path).toBe('/projects/defaults');
  expect([...new Set([...body.keys()])].filter((key) => SEVEN.includes(key)).sort()).toEqual([...SEVEN].sort());
  expect(body.has('search')).toBe(false);
  expect(body.has('project')).toBe(false);
  expect(body.getAll('status').sort()).toEqual(['in-progress', 'planned']);
  expect(body.getAll('projectType').sort()).toEqual(['comic', 'wallpaper']);
  expect(body.get('defaultsGeneration')).toBe('0');

  expect(fixture.storedProjectsDefaults()).toEqual({
    view: 'list',
    gridStyle: 'cropped',
    sort: 'title',
    order: 'asc',
    status: JSON.stringify(['planned', 'in-progress']),
    projectType: JSON.stringify(['comic', 'wallpaper']),
    tag: JSON.stringify([String(red.id)]),
  });
  expect(fixture.generation()).toBe(1);
  // No Project ID / Search default exists; the temporary context is kept.
  expect(fixture.state.db.prepare("SELECT COUNT(*) AS count FROM app_meta WHERE key LIKE 'page_defaults.projects.%'").get().count).toBe(7);
  expect(page.url()).toBe(before);
  expectRepeated(page.url(), 'project', [alpha.id, delta.id]);
  await expect(page.locator('#projects-search')).toHaveValue('Persist');
  await expectListing(page, [alpha.id, delta.id]);
  expect(fixture.readPageDefault('assetViewer', 'sort')).toBe('size');
  expect(gamma.id).toBeGreaterThan(0);
});

test('T/U: Reset filters restores all seven saved defaults and clears Projects and Search, read-only', async ({ page }) => {
  const { red, alpha, beta, gamma, delta } = seed();
  fixture.writePageDefault('projects', 'view', 'list');
  fixture.writePageDefault('projects', 'gridStyle', 'cropped');
  fixture.writePageDefault('projects', 'sort', 'title');
  fixture.writePageDefault('projects', 'order', 'desc');
  fixture.writePageDefault('projects', 'status', JSON.stringify(['planned']));
  fixture.writePageDefault('projects', 'projectType', JSON.stringify(['comic']));
  fixture.writePageDefault('projects', 'tag', 'all');
  const stored = fixture.storedProjectsDefaults();
  const generationBefore = fixture.generation();
  const control = watch(page);
  // A page whose every control differs from the saved defaults.
  await start(page, projectsUrl(fixture.baseURL, [beta.id, delta.id], {
    search: 'Persist', status: ['ready', 'in-progress'], type: ['images', 'wallpaper'], tag: String(red.id),
    sort: 'updated', order: 'asc', view: 'grid', page: '1',
  }));
  await expectListing(page, [delta.id]);
  await openDialog(page);
  await choose(page, 'project-grid-style-filter', 'Uncropped');
  const posts = control.posts.length;

  await resetFiltersButton(page).click();
  await settled(page);
  await expect.poll(() => query(page).getAll('project')).toEqual([]);
  expect(query(page).has('search')).toBe(false);
  expect(query(page).has('page')).toBe(false);
  expect(query(page).getAll('status')).toEqual(['planned']);
  expect(query(page).getAll('type')).toEqual(['comic']);
  // Results, sort, view and grid style changed, not just labels.
  await expect(page.locator('[data-projects-list-table]')).toBeVisible();
  const order = await page.locator('[data-projects-list-table] tr[data-project-id]')
    .evaluateAll((rows) => rows.map((row) => Number(row.dataset.projectId)));
  expect(order).toEqual([gamma.id, alpha.id]);
  await expect(page.locator('#projects-search')).toHaveValue('');
  expect(await checkedValues(page, 'project-project-filter')).toEqual(['']);
  expect(await checkedValues(page, 'project-status-filter')).toEqual(['planned']);
  expect(await checkedValues(page, 'project-type-filter')).toEqual(['comic']);
  expect(await checkedValues(page, 'project-tag-filter')).toEqual(['']);
  expect(await summaryText(page, 'project-sort-filter')).toBe('Title');
  expect(await summaryText(page, 'project-order-filter')).toBe('Descending');
  expect(await summaryText(page, 'project-view-filter')).toBe('List');
  expect(await summaryText(page, 'project-grid-style-filter')).toBe('Cropped');
  // Grid style is applied to the actual grid when switching back to Grid.
  await choose(page, 'project-view-filter', 'Grid');
  await expect(page.locator('[data-projects-live-region] .project-grid')).toHaveAttribute('data-grid-style', 'cropped');

  // Read-only: no POST, nothing deleted or rewritten.
  expect(control.posts.length).toBe(posts);
  expect(fixture.storedProjectsDefaults()).toEqual(stored);
  expect(fixture.generation()).toBe(generationBefore);
});

test('V/W: Reset defaults deletes only Projects defaults and keeps the temporary Projects/Search context', async ({ page }) => {
  const { alpha, beta, gamma, delta } = seed();
  fixture.writePageDefault('projects', 'view', 'list');
  fixture.writePageDefault('projects', 'sort', 'title');
  fixture.writePageDefault('projects', 'order', 'asc');
  fixture.writePageDefault('projects', 'status', JSON.stringify(['ready']));
  const generationBefore = fixture.generation();
  const control = watch(page);
  await start(page, projectsUrl(fixture.baseURL, [alpha.id, beta.id, delta.id], { search: 'Persist', status: ['ready', 'planned'] }));
  await expectListing(page, [alpha.id, beta.id]);
  await openDialog(page);
  await expect(indicator(page)).toContainText('4 of 7 defaults saved');

  await resetDefaultsButton(page).click();
  await expect(statusLine(page)).toHaveText('Defaults reset to the application defaults.');
  await expect(indicator(page)).toHaveText('No saved defaults.');
  expect(control.defaultsPosts().map((post) => post.path)).toEqual(['/projects/defaults/reset']);
  for (const option of SEVEN) expect(fixture.readPageDefault('projects', option)).toBeUndefined();
  expect(fixture.readPageDefault('assetViewer', 'sort')).toBe('size');
  expect(fixture.generation()).toBe(generationBefore + 1);

  // Temporary context kept (repeated), every default-backed control at its fallback.
  expectRepeated(page.url(), 'project', [alpha.id, beta.id, delta.id]);
  expect(query(page).get('search')).toBe('Persist');
  expect(query(page).getAll('status')).toEqual([]);
  await expect(page.locator('[data-projects-live-region] .project-grid')).toHaveAttribute('data-grid-style', 'uncropped');
  await expectListing(page, [alpha.id, beta.id, delta.id]);
  expect(await summaryText(page, 'project-sort-filter')).toBe('Created');
  expect(await summaryText(page, 'project-order-filter')).toBe('Descending');
  expect(await summaryText(page, 'project-view-filter')).toBe('Grid');
  expect(await summaryText(page, 'project-status-filter')).toBe('All active');
  expect(await summaryText(page, 'project-project-filter')).toBe('3 projects selected');
  await expect(page.locator('#projects-search')).toHaveValue('Persist');
  expect((await pageAuthority(page)).savedKeys).toEqual([]);
  expect(gamma.id).toBeGreaterThan(0);
});

test('X: a confirmed Save or Reset defaults whose refresh fails recovers by GET only, never replaying the POST', async ({ page }) => {
  const { alpha, gamma } = seed();
  const generationBefore = fixture.generation();
  const control = watch(page);
  await start(page, projectsUrl(fixture.baseURL, [alpha.id, gamma.id]));
  await openDialog(page);
  await choose(page, 'project-sort-filter', 'Title');

  let failNext = false;
  await page.route((url) => url.pathname === '/projects', async (route) => {
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
  expect(fixture.readPageDefault('projects', 'sort')).toBe('title');
  // Save stays refused until the page is coherent again.
  await saveButton(page).click();
  await expect(statusLine(page)).not.toHaveText('Saving defaults.');
  expect(control.defaultsPosts()).toHaveLength(1);
  await dialog(page).locator('[data-live-filter-retry]').click();
  await settled(page);
  await expect(statusLine(page)).toHaveText('Defaults saved.');
  expect(control.defaultsPosts()).toHaveLength(1);
  expectRepeated(page.url(), 'project', [alpha.id, gamma.id]);

  failNext = true;
  await resetDefaultsButton(page).click();
  await expect(dialog(page).locator('[data-live-filter-retry]')).toBeVisible();
  expect(control.defaultsPosts()).toHaveLength(2);
  expect(fixture.readPageDefault('projects', 'sort')).toBeUndefined();
  // A second Reset defaults is refused while the confirmed one is unrefreshed.
  await resetDefaultsButton(page).click();
  expect(control.defaultsPosts()).toHaveLength(2);
  await dialog(page).locator('[data-live-filter-retry]').click();
  await settled(page);
  await expect(statusLine(page)).toHaveText('Defaults reset to the application defaults.');
  expect(control.defaultsPosts()).toHaveLength(2);
  expectRepeated(page.url(), 'project', [alpha.id, gamma.id]);
  expect(fixture.generation()).toBe(generationBefore + 2);
});

test('races A/B/C/H/I: pending GET, newer edit during Save, Reset filters vs older GET, reopen and duplicates', async ({ page }) => {
  const { alpha, beta, gamma, delta } = seed();
  const control = watch(page);
  await start(page);
  await openDialog(page);

  // A: Save while a filter GET is pending is refused (nothing posted).
  let release;
  let held = new Promise((resolve) => { release = resolve; });
  const sortPending = (url) => url.pathname === '/projects' && url.searchParams.get('sort') === 'updated';
  await page.route(sortPending, async (route) => {
    await held;
    await route.continue();
  });
  const sort = await openDropdown(page, 'project-sort-filter');
  await sort.locator('.asset-filter-multiselect-option label').getByText('Updated', { exact: true }).click();
  await expect(page.locator('[data-projects-live-region]')).toHaveAttribute('aria-busy', 'true');
  await saveButton(page).click();
  await expect(statusLine(page)).toHaveText('Projects are still loading. Save again when they have finished.');
  expect(control.defaultsPosts()).toHaveLength(0);
  release();
  await settled(page);
  await page.unroute(sortPending);

  // B/I/H: a delayed Save; duplicate clicks and reopening send nothing more;
  // a newer edit during the Save stays current and is not persisted.
  let releasePost;
  const heldPost = new Promise((resolve) => { releasePost = resolve; });
  await page.route('**/projects/defaults', async (route) => {
    await heldPost;
    await route.continue();
  });
  await saveButton(page).click();
  await expect(statusLine(page)).toHaveText('Saving defaults.');
  await saveButton(page).click({ force: true });
  await closeDialog(page);
  await openDialog(page);
  await saveButton(page).click({ force: true });
  await choose(page, 'project-order-filter', 'Ascending');
  releasePost();
  await expect(statusLine(page)).toHaveText('Defaults saved.');
  expect(control.defaultsPosts()).toHaveLength(1);
  expect(fixture.readPageDefault('projects', 'sort')).toBe('updated');
  expect(fixture.readPageDefault('projects', 'order')).toBe('desc');
  expect(query(page).get('order')).toBe('asc');
  expect(await summaryText(page, 'project-order-filter')).toBe('Ascending');
  await expect(indicator(page)).toContainText('Current settings differ from the saved defaults');

  // C: Reset filters supersedes an older pending GET; the newer intent wins.
  held = new Promise((resolve) => { release = resolve; });
  const projectPending = (url) => url.pathname === '/projects' && url.searchParams.getAll('project').length > 0;
  await page.route(projectPending, async (route) => {
    await held;
    await route.continue().catch(() => {});
  });
  const projects = await openDropdown(page, 'project-project-filter');
  await projects.locator(`input[value="${alpha.id}"]`).click();
  await projects.locator('summary').click();
  await resetFiltersButton(page).click();
  await settled(page);
  release();
  await page.waitForTimeout(300);
  expect(query(page).getAll('project')).toEqual([]);
  expect(query(page).get('sort')).toBe('updated');
  // The saved Order equals the fallback, so the canonical URL omits it.
  expect(query(page).has('order')).toBe(false);
  expect(await summaryText(page, 'project-order-filter')).toBe('Descending');
  expect(await summaryText(page, 'project-project-filter')).toBe('All projects');
  await expectListing(page, [alpha.id, beta.id, gamma.id, delta.id]);
  expect(control.defaultsPosts()).toHaveLength(1);
});

test('Y: partial initialization and no JavaScript never send a defaults mutation', async ({ page, browser }) => {
  seed();
  fixture.writePageDefault('projects', 'sort', 'title');
  const stored = fixture.storedProjectsDefaults();

  // Partial initialization: the module loads but enhancement throws first.
  const control = watch(page);
  let injected = false;
  await page.route((url) => url.pathname === '/client/projects-filters-defaults.js', async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const signature = 'export function enhanceProjectsFiltersDefaults(document = globalThis.document, options = {}) {';
    injected = source.includes(signature);
    await route.fulfill({ response, body: source.replace(signature, `${signature}\n  throw new Error('Injected WP10b failure');`) });
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.baseURL}/projects?project=7&search=x`);
  expect(injected).toBe(true);
  await expect.poll(() => control.errors).toContain('Injected WP10b failure');
  await openDialog(page);
  for (const button of [saveButton(page), resetDefaultsButton(page)]) {
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('type', 'button');
    await button.click({ force: true });
  }
  await page.locator('#projects-search').press('Enter');
  await page.waitForTimeout(300);
  expect(control.defaultsPosts()).toEqual([]);
  await expect(page.locator('form[action^="/projects/defaults"]')).toHaveCount(0);

  // No JavaScript: the controls stay inert; Reset filters is a plain GET.
  const context = await browser.newContext({ javaScriptEnabled: false });
  const plain = await context.newPage();
  const plainControl = watch(plain);
  await plain.goto(`${fixture.baseURL}/projects?project=7&search=x`);
  await expect(plain.locator('[data-projects-defaults-save]')).toBeDisabled();
  await expect(plain.locator('[data-projects-defaults-reset]')).toBeDisabled();
  await expect(plain.locator('form#projects-defaults-form')).toHaveAttribute('method', 'dialog');
  await Promise.all([
    plain.waitForURL((url) => !url.searchParams.has('project')),
    plain.locator('[data-projects-filters-reset]').evaluate((button) => button.form.submit()),
  ]);
  expect(new URL(plain.url()).searchParams.getAll('project')).toEqual([]);
  expect(plainControl.posts).toEqual([]);
  await context.close();
  expect(fixture.storedProjectsDefaults()).toEqual(stored);
});

// R1 — one visible, one announced success confirmation per acknowledged
// Save. Before R1 the saved-state indicator and the status line both read
// "Defaults saved." after a Save of all seven settings (one POST, two lines).
const savedConfirmations = (page) => dialog(page).getByText('Defaults saved.', { exact: true }).filter({ visible: true });
const savedAnnouncements = (page) => dialog(page)
  .locator('[aria-live], [role="status"], [role="alert"]').filter({ hasText: 'Defaults saved.' });

test('R1 K–Q: one success confirmation per acknowledged Save; none on failure or uncertainty; reopen keeps one', async ({ page }) => {
  seed();
  const control = watch(page);
  await start(page);
  await openDialog(page);
  await choose(page, 'project-sort-filter', 'Title');
  await settled(page);
  await expect(indicator(page)).toHaveText('No saved defaults · Current settings differ from the application defaults.');

  // N: a rejected Save shows no success; the indicator stays.
  let mode = 'reject';
  await page.route((url) => url.pathname === '/projects/defaults', async (route) => {
    if (mode === 'reject') {
      // The handler's correlated, rolled-back failure answer.
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
  await expect(statusLine(page)).toHaveText('Defaults were not saved. Your current choices were kept.');
  await expect(savedConfirmations(page)).toHaveCount(0);
  await expect(indicator(page)).toBeVisible();
  expect(control.defaultsPosts()).toHaveLength(1);
  expect(fixture.readPageDefault('projects', 'sort')).toBeUndefined();

  // N: an uncertain outcome (no answer) is never reported as success.
  mode = 'abort';
  await saveButton(page).click();
  await expect(statusLine(page)).toHaveText(/Could not confirm/);
  await expect(savedConfirmations(page)).toHaveCount(0);
  await expect(indicator(page)).toBeVisible();
  // The existing GET-only Check cannot confirm an unanswered Save as success
  // either; the unresolved barrier asks for a reload, which is what we do.
  mode = 'pass';
  const check = dialog(page).locator('[data-projects-defaults-check]');
  await expect(check).toBeVisible();
  await check.click();
  await expect(statusLine(page)).not.toHaveText(/^(Checking whether the defaults were saved\.)?$/);
  await expect(savedConfirmations(page)).toHaveCount(0);
  expect(control.defaultsPosts()).toHaveLength(2);
  await start(page);
  await openDialog(page);
  await choose(page, 'project-sort-filter', 'Title');
  await settled(page);
  const postsBefore = control.defaultsPosts().length;

  // L/M/P: one acknowledged Save → one POST, one visible confirmation, one
  // live announcement; the duplicate indicator is hidden, not removed.
  await saveButton(page).click();
  await expect(statusLine(page)).toHaveText('Defaults saved.');
  await settled(page);
  expect(control.defaultsPosts()).toHaveLength(postsBefore + 1);
  await expect(savedConfirmations(page)).toHaveCount(1);
  await expect(savedAnnouncements(page)).toHaveCount(1);
  await expect(savedAnnouncements(page)).toHaveAttribute('data-settings-fetch-save-status', '');
  await expect(indicator(page)).toBeHidden();
  await expect(indicator(page)).toHaveText('Defaults saved.');
  expect(fixture.readPageDefault('projects', 'sort')).toBe('title');

  // The indicator returns as soon as it says something the status does not.
  await choose(page, 'project-order-filter', 'Ascending');
  await settled(page);
  await expect(indicator(page)).toBeVisible();
  await expect(indicator(page)).toHaveText('Defaults saved · Current settings differ from the saved defaults.');
  await expect(savedConfirmations(page)).toHaveCount(1);

  // O/F: a later distinct Save (keyboard) still gets its own feedback.
  await saveButton(page).focus();
  await page.keyboard.press('Enter');
  await expect(statusLine(page)).toHaveText('Defaults saved.');
  await settled(page);
  expect(control.defaultsPosts()).toHaveLength(postsBefore + 2);
  expect(fixture.readPageDefault('projects', 'order')).toBe('asc');
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
