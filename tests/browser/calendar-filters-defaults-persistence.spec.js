import { expect, test } from '@playwright/test';
import {
  MONTH, THREE, calendarUrl, choose, closeDialog, columnHeaders, createCalendarFixture, dialog, enhanced, expectEntries,
  expectRepeated, openDialog, openDropdown, pageAuthority, query, settled, summaryText, watch,
} from './calendar-filters-defaults-fixture.js';

// WP14b 15–24: explicit Save of exactly Desktop view, Release status and Week
// starts (one POST, one confirmation, no autosave from ordinary edits, the
// dialog or reconciliation), Reset defaults deleting only the Calendar keys
// while keeping the month and temporary Projects/Types, Reset filters
// (GET-only, restoring the saved values and clearing Projects/Types), failed
// GET Retry, held/stale GETs, edits during Save, a confirmed Save/Reset whose
// refresh fails (GET-only recovery, never a replayed POST) and uncertain
// POSTs — on the real page with SQLite inspection.

const fixture = createCalendarFixture('calendar-fd-persistence');

test.beforeAll(async () => {
  await fixture.start();
});

test.afterAll(async () => {
  await fixture.stop();
});

function seed() {
  fixture.isolate();
  fixture.writePageDefault('releases', 'sort', 'title');
  fixture.writePageDefault('projects', 'sort', 'title');
  const comic = fixture.project('Persist Comic', { projectType: 'comic' });
  const anim = fixture.project('Persist Anim', { projectType: 'animation' });
  const images = fixture.project('Persist Images', { projectType: 'images' });
  return {
    comic,
    anim,
    images,
    c1: fixture.release(comic, 'P Comic Planned', { planned: `${MONTH}-10` }),
    cp: fixture.release(comic, 'P Comic Published', { planned: `${MONTH}-03`, published: `${MONTH}-12` }),
    a1: fixture.release(anim, 'P Anim Planned', { planned: `${MONTH}-14` }),
    i1: fixture.release(images, 'P Images Planned', { planned: `${MONTH}-16` }),
  };
}

async function start(page, url = calendarUrl(fixture.baseURL, { month: MONTH })) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(url);
  await enhanced(page);
}

const statusLine = (page) => dialog(page).locator('[data-settings-fetch-save-status]');
const indicator = (page) => dialog(page).locator('[data-calendar-defaults-indicator]');
const saveButton = (page) => dialog(page).locator('[data-calendar-defaults-save]');
const resetDefaultsButton = (page) => dialog(page).locator('[data-calendar-defaults-reset]');
const resetFiltersButton = (page) => dialog(page).locator('[data-calendar-filters-reset]');
const savedConfirmations = (page) => page.getByText('Defaults saved.', { exact: true }).filter({ visible: true });
const savedAnnouncements = (page) => page
  .locator('[aria-live], [role="status"], [role="alert"]').filter({ hasText: 'Defaults saved.' });
const retry = (page) => page.locator('[data-live-filter-retry]').filter({ visible: true });
const region = (page) => page.locator('[data-calendar-live-region]');

test('15–17: ordinary edits never POST; Save persists exactly the three settings once with one confirmation', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  await start(page);
  await openDialog(page);
  await closeDialog(page);
  await openDialog(page);
  await choose(page, 'calendar-project-filter', s.comic.title);
  await choose(page, 'calendar-project-filter', s.anim.title);
  await choose(page, 'calendar-type-filter', 'Comic');
  await choose(page, 'calendar-type-filter', 'Animation');
  await choose(page, 'calendar-status-filter', 'Planned');
  await choose(page, 'calendar-view-filter', 'List');
  await choose(page, 'calendar-week-start-filter', 'Sunday');
  await expectEntries(page, [s.c1, s.a1]);
  await closeDialog(page);
  await page.locator('#calendar-next').click();
  await settled(page);
  await page.locator('#calendar-previous').click();
  await settled(page);
  await openDialog(page);
  // 15: none of those edits, dialog openings or reconciliations wrote anything.
  expect(control.defaultsPosts()).toEqual([]);
  expect(fixture.calendarKeys()).toEqual([]);
  const before = page.url();

  await saveButton(page).click();
  await expect(statusLine(page)).toHaveText('Defaults saved.');
  await settled(page);
  expect(control.defaultsPosts()).toHaveLength(1);
  const post = control.defaultsPosts()[0];
  expect(post.path).toBe('/calendar/defaults');
  expect([...new Set([...post.body.keys()])].sort())
    .toEqual(['_csrf', 'defaultsGeneration', 'defaultsOperation', 'returnTo', 'status', 'view', 'weekStart']);
  expect(post.body.get('view')).toBe('list');
  expect(post.body.get('status')).toBe('planned');
  expect(post.body.get('weekStart')).toBe('sunday');
  expect(post.body.get('defaultsGeneration')).toBe('0');
  for (const key of ['project', 'type', 'month', 'calendarView', 'calendarStatus', 'calendarWeekStart']) {
    expect(post.body.has(key)).toBe(false);
  }
  expect(fixture.storedCalendarDefaults()).toEqual({ view: 'list', status: 'planned', weekStart: 'sunday' });
  expect(fixture.calendarKeys()).toHaveLength(3);
  expect(fixture.generation()).toBe(1);
  // Other pages' defaults untouched; the month and temporary filters kept.
  expect(fixture.readPageDefault('releases', 'sort')).toBe('title');
  expect(fixture.readPageDefault('projects', 'sort')).toBe('title');
  expect(query(page).get('month')).toBe(MONTH);
  expectRepeated(page.url(), 'project', [s.comic.id, s.anim.id]);
  expectRepeated(page.url(), 'type', ['comic', 'animation']);
  expect(new URL(page.url()).search).toBe(new URL(before).search);
  await expectEntries(page, [s.c1, s.a1]);

  // 17: one visible confirmation and one announcement.
  await expect(savedConfirmations(page)).toHaveCount(1);
  await expect(savedAnnouncements(page)).toHaveCount(1);
  await expect(indicator(page)).toHaveText('Defaults saved.');

  // Reload: the bare month applies the three saved settings.
  await start(page, calendarUrl(fixture.baseURL, { month: MONTH }));
  await expect(region(page)).toHaveClass(/calendar-view-list/);
  expect((await columnHeaders(page))[0]).toBe('Sun');
  await expectEntries(page, [s.c1, s.a1, s.i1]);
  expect(control.defaultsPosts()).toHaveLength(1);
  expect(control.errors).toEqual([]);
});

test('18, 19: Reset defaults deletes only the Calendar keys and keeps month, Projects and Types; Reset filters is read-only', async ({ page }) => {
  const s = seed();
  fixture.writePageDefault('calendar', 'view', 'list');
  // An explicitly saved fallback-equal value still counts as saved.
  fixture.writePageDefault('calendar', 'status', 'all');
  fixture.writePageDefault('calendar', 'weekStart', 'sunday');
  const control = watch(page);
  await start(page, calendarUrl(fixture.baseURL, {
    month: MONTH, project: [s.comic.id, s.anim.id], type: ['comic', 'animation'], status: 'published', view: 'grid', weekStart: 'monday',
  }));
  await openDialog(page);
  await expect(indicator(page)).toContainText(/Current settings differ from the saved defaults|Defaults saved\./);
  expect((await pageAuthority(page)).savedKeys).toEqual(['view', 'status', 'weekStart']);
  await expectEntries(page, [s.cp]);
  const generation = fixture.generation();

  // 19: Reset filters restores all three saved values, clears Projects and
  // Types, keeps the month — GET only.
  await resetFiltersButton(page).click();
  await settled(page);
  await expect.poll(() => [...query(page).keys()].sort()).toEqual(['month']);
  expect(query(page).get('month')).toBe(MONTH);
  await expect(region(page)).toHaveClass(/calendar-view-list/);
  expect((await columnHeaders(page))[0]).toBe('Sun');
  expect(await summaryText(page, 'calendar-view-filter')).toBe('List');
  expect(await summaryText(page, 'calendar-status-filter')).toBe('All releases');
  expect(await summaryText(page, 'calendar-week-start-filter')).toBe('Sunday');
  expect(await summaryText(page, 'calendar-project-filter')).toBe('All projects');
  expect(await summaryText(page, 'calendar-type-filter')).toBe('All types');
  await expect(indicator(page)).toHaveText('Defaults saved.');
  await expectEntries(page, [s.c1, s.cp, s.a1, s.i1]);
  expect(control.defaultsPosts()).toEqual([]);
  expect(fixture.generation()).toBe(generation);
  expect(fixture.storedCalendarDefaults()).toEqual({ view: 'list', status: 'all', weekStart: 'sunday' });

  // Reselect a temporary context, then Reset defaults.
  await choose(page, 'calendar-project-filter', s.comic.title);
  await choose(page, 'calendar-project-filter', s.images.title);
  await choose(page, 'calendar-type-filter', 'Comic');
  await resetDefaultsButton(page).click();
  const confirmation = page.locator('#app-confirmation-dialog');
  if (await confirmation.isVisible()) await confirmation.locator('[data-app-dialog-confirmation-confirm]').click();
  await expect(statusLine(page)).toHaveText('Defaults reset to the application defaults.');
  await settled(page);
  expect(control.defaultsPosts()).toHaveLength(1);
  expect(control.defaultsPosts()[0].path).toBe('/calendar/defaults/reset');
  expect(THREE.some((field) => control.defaultsPosts()[0].body.has(field))).toBe(false);
  expect(fixture.calendarKeys()).toEqual([]);
  expect(fixture.generation()).toBe(generation + 1);
  expect(fixture.readPageDefault('releases', 'sort')).toBe('title');
  expect(fixture.readPageDefault('projects', 'sort')).toBe('title');
  // Month and temporary selections kept; the three settings at their fallbacks.
  expect(query(page).get('month')).toBe(MONTH);
  expectRepeated(page.url(), 'project', [s.comic.id, s.images.id]);
  expectRepeated(page.url(), 'type', ['comic']);
  for (const key of THREE) expect(query(page).has(key)).toBe(false);
  await expect(region(page)).toHaveClass(/calendar-view-grid/);
  expect((await columnHeaders(page))[0]).toBe('Mon');
  expect(await summaryText(page, 'calendar-view-filter')).toBe('Calendar');
  expect(await summaryText(page, 'calendar-week-start-filter')).toBe('Monday');
  await expect(indicator(page)).toHaveText('No saved defaults.');
  expect((await pageAuthority(page)).savedKeys).toEqual([]);
  await expectEntries(page, [s.c1, s.cp]);
  expect(control.errors).toEqual([]);
});

test('20, 23: a failed GET has a GET-only Retry; a confirmed Save or Reset defaults whose refresh fails is never replayed', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  // The durable generation persists across this file's tests.
  const generationBefore = fixture.generation();
  await start(page, calendarUrl(fixture.baseURL, { month: MONTH, project: [s.comic.id, s.anim.id] }));
  await openDialog(page);

  let failNext = false;
  await page.route((url) => url.pathname === '/calendar', async (route) => {
    if (failNext && route.request().resourceType() === 'fetch') {
      failNext = false;
      await route.fulfill({ status: 503, body: 'unavailable' });
      return;
    }
    await route.continue();
  });

  // 20: an ordinary edit whose GET fails; Retry repeats only that GET.
  failNext = true;
  const details = await openDropdown(page, 'calendar-status-filter');
  await details.locator('label').getByText('Planned', { exact: true }).click();
  await expect(retry(page)).toBeVisible();
  await expectEntries(page, [s.c1, s.cp, s.a1]);
  const getsBefore = control.gets.length;
  await retry(page).first().click();
  await settled(page);
  await expect.poll(() => query(page).get('status')).toBe('planned');
  await expectEntries(page, [s.c1, s.a1]);
  expect(control.gets.length).toBe(getsBefore + 1);
  expect(control.defaultsPosts()).toEqual([]);

  // 23: Save commits, its refresh fails; recovery is GET-only.
  failNext = true;
  await saveButton(page).click();
  await expect(retry(page)).toBeVisible();
  expect(control.defaultsPosts()).toHaveLength(1);
  expect(fixture.storedCalendarDefaults()).toEqual({ view: 'grid', status: 'planned', weekStart: 'monday' });
  await expect(statusLine(page)).toHaveText('Defaults were saved, but Calendar could not be refreshed. Retry to refresh the page.');
  await saveButton(page).click();
  expect(control.defaultsPosts()).toHaveLength(1);
  await retry(page).first().click();
  await settled(page);
  await expect(statusLine(page)).toHaveText('Defaults saved.');
  await expect(savedConfirmations(page)).toHaveCount(1);
  expect(control.defaultsPosts()).toHaveLength(1);
  expect(query(page).get('month')).toBe(MONTH);
  expectRepeated(page.url(), 'project', [s.comic.id, s.anim.id]);

  failNext = true;
  await resetDefaultsButton(page).click();
  const confirmation = page.locator('#app-confirmation-dialog');
  if (await confirmation.isVisible()) await confirmation.locator('[data-app-dialog-confirmation-confirm]').click();
  await expect(retry(page)).toBeVisible();
  expect(control.defaultsPosts()).toHaveLength(2);
  expect(fixture.calendarKeys()).toEqual([]);
  await resetDefaultsButton(page).click();
  expect(control.defaultsPosts()).toHaveLength(2);
  await retry(page).first().click();
  await settled(page);
  await expect(statusLine(page)).toHaveText('Defaults reset to the application defaults.');
  expect(control.defaultsPosts()).toHaveLength(2);
  expect(query(page).get('month')).toBe(MONTH);
  expectRepeated(page.url(), 'project', [s.comic.id, s.anim.id]);
  // Exactly one Save and one Reset defaults reached the server.
  expect(fixture.generation()).toBe(generationBefore + 2);
});

test('21, 22: held/stale GETs never reinstall; Save refused while loading; edits during Save stay current; month never jumps', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  await start(page);
  await openDialog(page);

  // 21: an older Project GET held until after a newer Type GET installs.
  let releaseOld;
  const heldOld = new Promise((resolve) => { releaseOld = resolve; });
  const oldRequest = (url) => url.pathname === '/calendar' && url.searchParams.getAll('project').length === 1
    && url.searchParams.getAll('type').length === 0;
  await page.route(oldRequest, async (route) => {
    await heldOld;
    await route.continue().catch(() => {});
  });
  const projects = await openDropdown(page, 'calendar-project-filter');
  await projects.locator(`input[value="${s.comic.id}"]`).check();
  await expect(region(page)).toHaveAttribute('aria-busy', 'true');
  // Save while that GET is pending is refused.
  await saveButton(page).click();
  await expect(statusLine(page)).toHaveText('Calendar is still loading. Save again when it has finished.');
  const types = await openDropdown(page, 'calendar-type-filter');
  await types.locator('input[value="comic"]').check();
  await settled(page);
  expectRepeated(page.url(), 'type', ['comic']);
  releaseOld();
  await page.waitForTimeout(300);
  await settled(page);
  expectRepeated(page.url(), 'project', [s.comic.id]);
  expectRepeated(page.url(), 'type', ['comic']);
  await expectEntries(page, [s.c1, s.cp]);
  expect(await page.locator('#calendar-type-filter input:checked').evaluateAll((inputs) => inputs.map((input) => input.value))).toEqual(['comic']);
  await page.unroute(oldRequest);

  // Week start and View changes during a pending status GET: the newest wins.
  let releaseStatus;
  const heldStatus = new Promise((resolve) => { releaseStatus = resolve; });
  // Only the older request (published, still Monday) is held; the newer one
  // carries the same status plus Sunday and must install first.
  const statusRequest = (url) => url.pathname === '/calendar' && url.searchParams.get('status') === 'published'
    && url.searchParams.get('weekStart') === 'monday';
  await page.route(statusRequest, async (route) => {
    await heldStatus;
    await route.continue().catch(() => {});
  });
  const status = await openDropdown(page, 'calendar-status-filter');
  await status.locator('label').getByText('Published', { exact: true }).click();
  const week = await openDropdown(page, 'calendar-week-start-filter');
  await week.locator('label').getByText('Sunday', { exact: true }).click();
  await settled(page);
  releaseStatus();
  await page.waitForTimeout(300);
  await settled(page);
  expect(query(page).get('weekStart')).toBe('sunday');
  expect(query(page).get('status')).toBe('published');
  expect((await columnHeaders(page))[0]).toBe('Sun');
  await expectEntries(page, [s.cp]);
  await page.unroute(statusRequest);
  expect(control.defaultsPosts()).toEqual([]);

  // 22: a held Save; duplicate clicks and reopening send nothing more; edits
  // and month navigation during the Save stay current and are not persisted.
  let releasePost;
  const heldPost = new Promise((resolve) => { releasePost = resolve; });
  await page.route('**/calendar/defaults', async (route) => {
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
  await choose(page, 'calendar-view-filter', 'List');
  await closeDialog(page);
  await page.locator('#calendar-next').click();
  await settled(page);
  releasePost();
  await openDialog(page);
  await expect(statusLine(page)).toHaveText('Defaults saved.');
  await settled(page);
  expect(control.defaultsPosts()).toHaveLength(1);
  expect(fixture.storedCalendarDefaults()).toEqual({ view: 'grid', status: 'published', weekStart: 'sunday' });
  // The later edit and the later month are kept (the Save's older return URL
  // does not move the Calendar back).
  expect(query(page).get('view')).toBe('list');
  expect(query(page).get('month')).toBe('2031-08');
  await expect(region(page)).toHaveClass(/calendar-view-list/);
  expect(await summaryText(page, 'calendar-view-filter')).toBe('List');
  await expect(indicator(page)).toContainText('Current settings differ from the saved defaults');
  await page.unroute('**/calendar/defaults');

  // Reset filters supersedes an older pending GET and Save is refused while
  // it is unfinished; the Reset result is what is installed.
  let releaseType;
  const heldType = new Promise((resolve) => { releaseType = resolve; });
  const typeRequest = (url) => url.pathname === '/calendar' && url.searchParams.getAll('type').includes('animation');
  await page.route(typeRequest, async (route) => {
    await heldType;
    await route.continue().catch(() => {});
  });
  const typesAgain = await openDropdown(page, 'calendar-type-filter');
  await typesAgain.locator('input[value="animation"]').check();
  let releaseReset;
  const heldReset = new Promise((resolve) => { releaseReset = resolve; });
  const resetRequest = (url) => url.pathname === '/calendar' && [...url.searchParams.keys()].join() === 'month';
  await page.route(resetRequest, async (route) => {
    await heldReset;
    await route.continue().catch(() => {});
  });
  await resetFiltersButton(page).click();
  await saveButton(page).click();
  await expect(statusLine(page)).toHaveText('Reset filters has not finished. Save again when it has finished.');
  releaseType();
  releaseReset();
  await page.waitForTimeout(300);
  await settled(page);
  expect([...query(page).keys()]).toEqual(['month']);
  expect(query(page).get('month')).toBe('2031-08');
  expect(await summaryText(page, 'calendar-type-filter')).toBe('All types');
  expect(await summaryText(page, 'calendar-project-filter')).toBe('All projects');
  expect(await summaryText(page, 'calendar-view-filter')).toBe('Calendar');
  await expect(region(page)).toHaveClass(/calendar-view-grid/);
  expect(control.defaultsPosts()).toHaveLength(1);
  expect(control.errors).toEqual([]);
});

test('24: an uncertain POST is reconciled by GET before reporting; a rejected Save shows no success', async ({ page }) => {
  seed();
  const control = watch(page);
  await start(page);
  await openDialog(page);
  await choose(page, 'calendar-status-filter', 'Planned');

  let mode = 'reject';
  await page.route((url) => url.pathname === '/calendar/defaults', async (route) => {
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
  expect(fixture.calendarKeys()).toEqual([]);

  mode = 'gateway';
  const reads = control.defaultsGets.length;
  await saveButton(page).click();
  await expect(statusLine(page)).toHaveText(/Could not confirm whether the defaults were saved/);
  expect(control.defaultsGets.length).toBeGreaterThan(reads);
  await expect(savedConfirmations(page)).toHaveCount(0);
  const check = dialog(page).locator('[data-calendar-defaults-check]');
  await expect(check).toBeVisible();
  mode = 'pass';
  await check.click();
  await expect(statusLine(page)).toHaveText(/Could not confirm/);
  await resetDefaultsButton(page).click();
  await expect(statusLine(page)).toHaveText(/Reload the page before changing defaults again/);
  expect(control.defaultsPosts()).toHaveLength(2);
  expect(fixture.calendarKeys()).toEqual([]);

  // After reload the barrier is gone and a real Save is acknowledged once.
  await start(page, calendarUrl(fixture.baseURL, { month: MONTH, status: 'planned' }));
  await openDialog(page);
  await saveButton(page).click();
  await expect(statusLine(page)).toHaveText('Defaults saved.');
  expect(fixture.storedCalendarDefaults()).toEqual({ view: 'grid', status: 'planned', weekStart: 'monday' });
  expect(control.defaultsPosts()).toHaveLength(3);
  await expect(savedConfirmations(page)).toHaveCount(1);
});

test('fail-closed: partial initialization and no JavaScript never send a defaults mutation', async ({ page, browser }) => {
  const s = seed();
  fixture.writePageDefault('calendar', 'view', 'list');
  const stored = fixture.storedCalendarDefaults();
  const control = watch(page);
  let injected = false;
  await page.route((url) => url.pathname === '/client/calendar-filters-defaults.js', async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const signature = 'export function enhanceCalendarFiltersDefaults(document = globalThis.document, options = {}) {';
    injected = source.includes(signature);
    await route.fulfill({ response, body: source.replace(signature, `${signature}\n  throw new Error('Injected WP14b failure');`) });
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(calendarUrl(fixture.baseURL, { month: MONTH, project: s.comic.id }));
  expect(injected).toBe(true);
  await expect.poll(() => control.errors).toContain('Injected WP14b failure');
  await openDialog(page);
  for (const button of [saveButton(page), resetDefaultsButton(page)]) {
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('type', 'button');
    await button.click({ force: true });
  }
  // Ordinary filtering still works through the live engine.
  await choose(page, 'calendar-status-filter', 'Planned');
  await page.waitForTimeout(300);
  expect(control.defaultsPosts()).toEqual([]);

  // No JavaScript: the defaults controls stay inert; Reset filters is a plain
  // GET keeping the month and applying the saved View.
  const context = await browser.newContext({ javaScriptEnabled: false });
  const plain = await context.newPage();
  const plainControl = watch(plain);
  await plain.goto(calendarUrl(fixture.baseURL, { month: MONTH, project: s.comic.id, view: 'grid' }));
  await expect(plain.locator('[data-calendar-defaults-save]')).toBeDisabled();
  await expect(plain.locator('[data-calendar-defaults-reset]')).toBeDisabled();
  await expect(plain.locator('form#calendar-filters-defaults-form')).toHaveAttribute('method', 'dialog');
  await Promise.all([
    plain.waitForURL((url) => !url.searchParams.has('project')),
    plain.locator('[data-calendar-filters-reset]').evaluate((button) => button.form.submit()),
  ]);
  const plainQuery = new URL(plain.url()).searchParams;
  expect([...plainQuery.keys()]).toEqual(['month']);
  expect(plainQuery.get('month')).toBe(MONTH);
  await expect(plain.locator('[data-calendar-live-region]')).toHaveClass(/calendar-view-list/);
  expect(plainControl.posts).toEqual([]);
  await context.close();
  expect(fixture.storedCalendarDefaults()).toEqual(stored);
});
