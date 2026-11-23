import { expect, test } from '@playwright/test';
import {
  MONTH, calendarUrl, closeDialog, columnHeaders, createCalendarFixture, dialog, enhanced, expectEntries,
  expectRepeated, matchingCount, openDialog, openDropdown, pageAuthority, query, settled, summaryText, watch,
} from './calendar-filters-defaults-fixture.js';

// R4: a filter edit or month-picker choice made while a Reset filters GET or
// a Back / Forward navigation is pending (or failed) changes only its own
// dimension of THAT destination. Pre-Reset / abandoned-entry Projects, Types,
// status, View and week start are never reinstated. Requests are held and
// released by route interception only (no timing sleeps).

const fixture = createCalendarFixture('calendar-r4-intent');
const JUNE = '2031-06';
const AUGUST = '2031-08';
const SAVED = Object.freeze({ view: 'list', status: 'all', weekStart: 'sunday' });

test.beforeAll(async () => {
  await fixture.start();
});

test.afterAll(async () => {
  await fixture.stop();
});

function seed({ saved = true } = {}) {
  fixture.isolate();
  if (saved) Object.entries(SAVED).forEach(([option, value]) => fixture.writePageDefault('calendar', option, value));
  const p1 = fixture.project('R4 One', { projectType: 'comic' });
  const p2 = fixture.project('R4 Two', { projectType: 'images' });
  const p3 = fixture.project('R4 Three', { projectType: 'comic' });
  return {
    p1,
    p2,
    p3,
    j1: fixture.release(p1, 'R4 July One', { planned: `${MONTH}-10` }),
    j2: fixture.release(p2, 'R4 July Two', { planned: `${MONTH}-11` }),
    j2p: fixture.release(p2, 'R4 July Two Published', { planned: `${MONTH}-01`, published: `${MONTH}-12` }),
    j3: fixture.release(p3, 'R4 July Three', { planned: `${MONTH}-13` }),
    j3p: fixture.release(p3, 'R4 July Three Published', { planned: `${MONTH}-02`, published: `${MONTH}-14` }),
    u1: fixture.release(p1, 'R4 June One', { planned: `${JUNE}-05` }),
    u2: fixture.release(p2, 'R4 June Two Published', { planned: `${JUNE}-01`, published: `${JUNE}-06` }),
    u3: fixture.release(p3, 'R4 June Three Published', { planned: `${JUNE}-02`, published: `${JUNE}-07` }),
    a1: fixture.release(p1, 'R4 August One', { planned: `${AUGUST}-05` }),
  };
}

// Current Grid / Planned / Monday with Projects 1+2 and both Types: j1, j2.
function preResetUrl(s, projects = [s.p1.id, s.p2.id]) {
  return calendarUrl(fixture.baseURL, {
    month: MONTH, project: projects, type: ['comic', 'images'],
    status: 'planned', view: 'grid', weekStart: 'monday',
  });
}

async function start(page, url) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(url);
  await enhanced(page);
}

const region = (page) => page.locator('[data-calendar-live-region]');
const resetFiltersButton = (page) => dialog(page).locator('[data-calendar-filters-reset]');
const retry = (page) => page.locator('[data-live-filter-retry]').filter({ visible: true });
const isReset = (url) => [...url.searchParams.keys()].join() === 'month' && url.searchParams.get('month') === MONTH;

/** Holds live Calendar GETs matching `predicate` until delivered. */
async function hold(page, predicate) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let finished;
  const done = new Promise((resolve) => { finished = resolve; });
  const matcher = (url) => url.pathname === '/calendar' && predicate(url);
  const seen = [];
  await page.route(matcher, async (route) => {
    if (route.request().resourceType() !== 'fetch') return route.continue();
    seen.push(new URL(route.request().url()));
    await gate;
    await route.continue().catch(() => {});
    finished();
    return undefined;
  });
  return {
    seen,
    async deliver() {
      release();
      await done;
      await page.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)));
      }));
      await page.unroute(matcher);
    },
  };
}

async function checkProject(page, id) {
  const details = await openDropdown(page, 'calendar-project-filter');
  await details.locator(`input[value="${id}"]`).check();
}

async function checkType(page, value) {
  const details = await openDropdown(page, 'calendar-type-filter');
  await details.locator(`input[value="${value}"]`).check();
}

async function chooseStatus(page, label) {
  const details = await openDropdown(page, 'calendar-status-filter');
  await details.locator('label').getByText(label, { exact: true }).click();
}

async function checked(page, id) {
  return page.locator(`#${id} input:checked`).evaluateAll((inputs) => inputs.map((input) => input.value).filter(Boolean));
}

async function expectSavedPresentation(page) {
  await expect(region(page)).toHaveClass(/calendar-view-list/);
  expect((await columnHeaders(page))[0]).toBe('Sun');
  expect(await summaryText(page, 'calendar-view-filter')).toBe('List');
  expect(await summaryText(page, 'calendar-status-filter')).toBe('All releases');
  expect(await summaryText(page, 'calendar-week-start-filter')).toBe('Sunday');
}

const presentationKeys = (url) => ['status', 'view', 'weekStart'].filter((key) => url.searchParams.has(key));

test('CASE A: Reset filters held, then Project 3: only Project 3, saved presentation, July; the old Reset never reinstalls', async ({ page }) => {
  const s = seed();
  const stored = fixture.storedCalendarDefaults();
  const control = watch(page);
  await start(page, preResetUrl(s));
  await expect(region(page)).toHaveClass(/calendar-view-grid/);
  await expectEntries(page, [s.j1, s.j2]);

  await openDialog(page);
  const reset = await hold(page, isReset);
  await resetFiltersButton(page).click();
  await expect.poll(() => reset.seen.length).toBe(1);
  await expect(region(page)).toHaveAttribute('aria-busy', 'true');
  // The pending Reset destination is the form's intent at once.
  expect(await checked(page, 'calendar-project-filter')).toEqual([]);
  expect(await checked(page, 'calendar-type-filter')).toEqual([]);

  await checkProject(page, s.p3.id);
  await settled(page);
  const composed = control.gets.at(-1);
  expect([...composed.searchParams.keys()].sort()).toEqual(['month', 'project']);
  expect(composed.searchParams.get('month')).toBe(MONTH);
  expectRepeated(composed.href, 'project', [s.p3.id]);
  expect(composed.searchParams.getAll('type')).toEqual([]);
  expect(presentationKeys(composed)).toEqual([]);

  await expect(region(page)).toHaveAttribute('data-calendar-month', MONTH);
  await expectEntries(page, [s.j3, s.j3p]);
  await expectSavedPresentation(page);
  expect(await checked(page, 'calendar-project-filter')).toEqual([String(s.p3.id)]);
  expect(await checked(page, 'calendar-type-filter')).toEqual([]);
  const installedUrl = page.url();

  await reset.deliver();
  expect(page.url()).toBe(installedUrl);
  await expectEntries(page, [s.j3, s.j3p]);
  expect(await checked(page, 'calendar-project-filter')).toEqual([String(s.p3.id)]);
  expect(control.defaultsPosts()).toEqual([]);
  expect(fixture.storedCalendarDefaults()).toEqual(stored);
  expect(control.errors).toEqual([]);
});

test('CASE A2: Reset filters held, then Type Images or status Published changes only that dimension', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  await start(page, preResetUrl(s));
  await openDialog(page);
  let reset = await hold(page, isReset);
  await resetFiltersButton(page).click();
  await expect.poll(() => reset.seen.length).toBe(1);
  await checkType(page, 'images');
  await settled(page);
  const typed = control.gets.at(-1);
  expect([...typed.searchParams.entries()]).toEqual([['month', MONTH], ['type', 'images']]);
  await expectEntries(page, [s.j2, s.j2p]);
  await expectSavedPresentation(page);
  await reset.deliver();
  await expectEntries(page, [s.j2, s.j2p]);

  // Again from the pre-Reset Calendar: a status edit during the held Reset.
  await page.goto(preResetUrl(s));
  await enhanced(page);
  await openDialog(page);
  reset = await hold(page, isReset);
  await resetFiltersButton(page).click();
  await expect.poll(() => reset.seen.length).toBe(1);
  await chooseStatus(page, 'Published');
  await settled(page);
  const status = control.gets.at(-1);
  expect([...status.searchParams.entries()]).toEqual([['month', MONTH], ['status', 'published']]);
  await expectEntries(page, [s.j2p, s.j3p]);
  await expect(region(page)).toHaveClass(/calendar-view-list/);
  expect((await columnHeaders(page))[0]).toBe('Sun');
  expect(await checked(page, 'calendar-project-filter')).toEqual([]);
  expect(await checked(page, 'calendar-type-filter')).toEqual([]);
  await reset.deliver();
  await expectEntries(page, [s.j2p, s.j3p]);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('CASE B: Reset filters held, then the month picker chooses June: filters stay cleared, saved presentation applies', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  await start(page, preResetUrl(s));
  await openDialog(page);
  const reset = await hold(page, isReset);
  await resetFiltersButton(page).click();
  await expect.poll(() => reset.seen.length).toBe(1);
  await closeDialog(page);

  await page.locator('.calendar-month-trigger').click();
  const picker = page.locator('#calendar-month-dialog');
  await expect(picker).toBeVisible();
  await expect(picker.locator('#calendar-month-year')).toHaveValue('2031');
  await picker.locator('#calendar-month-select > summary').click();
  await picker.locator('#calendar-month-select label').getByText('June', { exact: true }).click();
  await settled(page);
  if (await picker.isVisible()) await page.keyboard.press('Escape');

  const picked = control.gets.at(-1);
  expect([...picked.searchParams.entries()]).toEqual([['month', JUNE]]);
  await expect(region(page)).toHaveAttribute('data-calendar-month', JUNE);
  expect(query(page).get('month')).toBe(JUNE);
  await expectEntries(page, [s.u1, s.u2, s.u3]);
  await expectSavedPresentation(page);

  await reset.deliver();
  await expect(region(page)).toHaveAttribute('data-calendar-month', JUNE);
  await expectEntries(page, [s.u1, s.u2, s.u3]);
  await openDialog(page);
  expect(await checked(page, 'calendar-project-filter')).toEqual([]);
  expect(await checked(page, 'calendar-type-filter')).toEqual([]);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('CASE C: a failed Reset filters GET stays the base for a Project edit; Retry is GET-only and superseded', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  await start(page, preResetUrl(s));
  let failing = true;
  const resetRoute = (url) => url.pathname === '/calendar' && isReset(url);
  await page.route(resetRoute, async (route) => {
    if (failing && route.request().resourceType() === 'fetch') {
      await route.fulfill({ status: 503, body: 'unavailable' });
      return;
    }
    await route.continue();
  });
  await openDialog(page);
  await resetFiltersButton(page).click();
  await expect(retry(page)).toBeVisible();
  await expectEntries(page, [s.j1, s.j2]);

  // GET-only Retry of the month-only Reset fails again.
  const before = control.gets.length;
  await retry(page).click();
  await expect(retry(page)).toBeVisible();
  expect(control.gets.length).toBe(before + 1);
  expect(isReset(control.gets.at(-1))).toBe(true);

  failing = false;
  await checkProject(page, s.p3.id);
  await settled(page);
  const composed = control.gets.at(-1);
  expect([...composed.searchParams.keys()].sort()).toEqual(['month', 'project']);
  expectRepeated(composed.href, 'project', [s.p3.id]);
  await expect(retry(page)).toHaveCount(0);
  await expectEntries(page, [s.j3, s.j3p]);
  await expectSavedPresentation(page);
  expect(await checked(page, 'calendar-project-filter')).toEqual([String(s.p3.id)]);
  expect(await checked(page, 'calendar-type-filter')).toEqual([]);
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
  await page.unroute(resetRoute);
});

test('CASE D: Back held to unrestricted July, then Type Images: no abandoned Comic Project; older responses arrive last', async ({ page }) => {
  const s = seed({ saved: false });
  const control = watch(page);
  const july = calendarUrl(fixture.baseURL, { month: MONTH });
  await start(page, july);
  await expectEntries(page, [s.j1, s.j2, s.j2p, s.j3, s.j3p]);

  await openDialog(page);
  await checkProject(page, s.p1.id);
  await settled(page);
  await closeDialog(page);
  await expectEntries(page, [s.j1]);

  const august = await hold(page, (url) => url.searchParams.get('month') === AUGUST);
  await page.locator('#calendar-next').click();
  await expect.poll(() => august.seen.length).toBe(1);

  const back = await hold(page, (url) => url.searchParams.get('month') === MONTH
    && url.searchParams.getAll('project').length === 0 && url.searchParams.getAll('type').length === 0);
  await page.goBack();
  await expect.poll(() => back.seen.length).toBe(1);
  expect(back.seen[0].href).toBe(july);

  await openDialog(page);
  expect(await checked(page, 'calendar-project-filter')).toEqual([]);
  await checkType(page, 'images');
  await settled(page);
  const composed = control.gets.at(-1);
  expect(composed.searchParams.get('month')).toBe(MONTH);
  expect(composed.searchParams.getAll('project')).toEqual([]);
  expectRepeated(composed.href, 'type', ['images']);
  await expectEntries(page, [s.j2, s.j2p]);
  const installedUrl = page.url();

  await back.deliver();
  await august.deliver();
  expect(page.url()).toBe(installedUrl);
  await expect(region(page)).toHaveAttribute('data-calendar-month', MONTH);
  await expectEntries(page, [s.j2, s.j2p]);
  expect(await checked(page, 'calendar-project-filter')).toEqual([]);
  expect(await checked(page, 'calendar-type-filter')).toEqual(['images']);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('CASE E: Forward held to the Planned entry, then Project 2: composes with Planned, not the installed entry', async ({ page }) => {
  const s = seed({ saved: false });
  const control = watch(page);
  const july = calendarUrl(fixture.baseURL, { month: MONTH });
  await start(page, july);
  await openDialog(page);
  await chooseStatus(page, 'Planned');
  await settled(page);
  await closeDialog(page);
  await expectEntries(page, [s.j1, s.j2, s.j3]);
  const planned = page.url();

  await page.goBack();
  await settled(page);
  await expect.poll(() => query(page).get('status')).toBe(null);
  await expectEntries(page, [s.j1, s.j2, s.j2p, s.j3, s.j3p]);

  const forward = await hold(page, (url) => url.searchParams.get('status') === 'planned'
    && url.searchParams.getAll('project').length === 0);
  await page.goForward();
  await expect.poll(() => forward.seen.length).toBe(1);
  expect(forward.seen[0].href).toBe(planned);

  await openDialog(page);
  await checkProject(page, s.p2.id);
  await settled(page);
  const composed = control.gets.at(-1);
  expect(composed.searchParams.get('status')).toBe('planned');
  expectRepeated(composed.href, 'project', [s.p2.id]);
  await expectEntries(page, [s.j2]);
  const installedUrl = page.url();

  await forward.deliver();
  expect(page.url()).toBe(installedUrl);
  await expectEntries(page, [s.j2]);
  expect(await summaryText(page, 'calendar-status-filter')).toBe('Planned');
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});

/*
 * Cumulative P2-B: Reset defaults adopting a failed (or pending) month
 * navigation commits that navigation's outstanding push exactly once, so the
 * filtered July entry stays reachable by Back and August by Forward. Real
 * Express routes, disposable SQLite, request gates only (no sleeps).
 */
const SEPTEMBER = '2031-09';
const statusLine = (page) => dialog(page).locator('[data-settings-fetch-save-status]');
const resetDefaultsButton = (page) => dialog(page).locator('[data-calendar-defaults-reset]');
const defaultsRetry = (page) => dialog(page).locator('[data-calendar-defaults-retry]');
const historyLength = (page) => page.evaluate(() => window.history.length);
const isAugust = (url) => url.searchParams.get('month') === AUGUST;

function seedHistory() {
  const s = seed();
  return {
    ...s,
    a2: fixture.release(s.p2, 'R4 August Two Published', { planned: `${AUGUST}-01`, published: `${AUGUST}-07` }),
    a3: fixture.release(s.p3, 'R4 August Three', { planned: `${AUGUST}-09` }),
    s1: fixture.release(s.p1, 'R4 September One', { planned: `${SEPTEMBER}-04` }),
  };
}

// The route's refreshUrl: the month, Projects and Types of the failed August.
function augustResetUrl(s) {
  return calendarUrl(fixture.baseURL, { month: AUGUST, project: [s.p1.id, s.p2.id], type: ['comic', 'images'] });
}

/** Earlier page -> filtered July (two real document entries). */
async function startFilteredJuly(page, s, projects) {
  await page.setViewportSize({ width: 1280, height: 900 });
  const earlier = calendarUrl(fixture.baseURL, { month: JUNE });
  await page.goto(earlier);
  await enhanced(page);
  const july = preResetUrl(s, projects);
  await page.goto(july);
  await enhanced(page);
  await expectEntries(page, [s.j1, s.j2]);
  return { earlier, july, length: await historyLength(page) };
}

/** Fails the first `failures` live August GETs with 503; later ones continue. */
async function failAugust(page, failures) {
  const matcher = (url) => url.pathname === '/calendar' && isAugust(url);
  let remaining = failures;
  await page.route(matcher, async (route) => {
    if (remaining > 0 && route.request().resourceType() === 'fetch') {
      remaining -= 1;
      await route.fulfill({ status: 503, body: 'unavailable' });
      return;
    }
    await route.continue();
  });
  return () => page.unroute(matcher);
}

async function clickNextExpectFailure(page) {
  await page.locator('#calendar-next').click();
  await expect(retry(page)).toBeVisible();
  await settled(page);
  await expect(region(page)).toHaveAttribute('data-calendar-month', MONTH);
}

async function resetDefaults(page) {
  await openDialog(page);
  await resetDefaultsButton(page).click();
}

async function expectAugustAfterReset(page, s) {
  expect(page.url()).toBe(augustResetUrl(s));
  await expect(region(page)).toHaveAttribute('data-calendar-month', AUGUST);
  await expectEntries(page, [s.a1, s.a2]);
  await expect(region(page)).toHaveClass(/calendar-view-grid/);
  expect((await columnHeaders(page))[0]).toBe('Mon');
  expect((await checked(page, 'calendar-project-filter')).sort()).toEqual([String(s.p1.id), String(s.p2.id)].sort());
  expect((await checked(page, 'calendar-type-filter')).sort()).toEqual(['comic', 'images']);
  expect(await summaryText(page, 'calendar-status-filter')).toBe('All releases');
  expect(await summaryText(page, 'calendar-view-filter')).toBe('Calendar');
  expect(await summaryText(page, 'calendar-week-start-filter')).toBe('Monday');
}

async function expectFilteredJuly(page, s, july) {
  await settled(page);
  await expect.poll(() => page.url()).toBe(july);
  await expect(region(page)).toHaveAttribute('data-calendar-month', MONTH);
  await expectEntries(page, [s.j1, s.j2]);
  expect(await summaryText(page, 'calendar-status-filter')).toBe('Planned');
  expect((await checked(page, 'calendar-project-filter')).sort()).toEqual([String(s.p1.id), String(s.p2.id)].sort());
}

/** Back restores the exact filtered July, Forward the August entry; no duplicate. */
async function expectHistory(page, s, { july, length }, augustUrl, augustEntries) {
  expect(await historyLength(page)).toBe(length + 1);
  await page.goBack();
  await expectFilteredJuly(page, s, july);
  await page.goForward();
  await settled(page);
  await expect.poll(() => page.url()).toBe(augustUrl);
  await expectEntries(page, augustEntries);
  expect(await historyLength(page)).toBe(length + 1);
}

const resetPosts = (control) => control.defaultsPosts().filter((post) => post.path === '/calendar/defaults/reset');

test('P2-B PRIMARY: failed Next to August, then Reset defaults installs August with one push; Back is filtered July', async ({ page }) => {
  const s = seedHistory();
  const control = watch(page);
  const generation = fixture.generation();
  const entries = await startFilteredJuly(page, s);
  const restore = await failAugust(page, 1);
  await clickNextExpectFailure(page);
  expect(page.url()).toBe(entries.july);
  expect(await historyLength(page)).toBe(entries.length);

  await resetDefaults(page);
  await expect(statusLine(page)).toHaveText('Defaults reset to the application defaults.');
  await settled(page);
  expect(resetPosts(control)).toHaveLength(1);
  expect(control.defaultsPosts()).toHaveLength(1);
  expect(control.gets.filter(isAugust)).toHaveLength(2);
  expect(fixture.generation()).toBe(generation + 1);
  expect(fixture.calendarKeys()).toEqual([]);
  await expect(retry(page)).toHaveCount(0);
  await expectAugustAfterReset(page, s);
  await closeDialog(page);

  await expectHistory(page, s, entries, augustResetUrl(s), [s.a1, s.a2]);
  // The earlier page is still behind July: nothing was overwritten.
  await page.goBack();
  await page.goBack();
  await expect.poll(() => page.url()).toBe(entries.earlier);
  await restore();
  expect(control.defaultsPosts()).toHaveLength(1);
  expect(control.errors).toEqual([]);
});

test('P2-B SECOND: the Reset refresh fails too; the keyboard GET-only Retry keeps the original push; no POST replay', async ({ page }) => {
  const s = seedHistory();
  const control = watch(page);
  const generation = fixture.generation();
  const entries = await startFilteredJuly(page, s);
  const restore = await failAugust(page, 2);
  await clickNextExpectFailure(page);

  await resetDefaults(page);
  await expect(statusLine(page)).toHaveText('Defaults were reset, but Calendar could not be refreshed. Retry to refresh the page.');
  await settled(page);
  expect(control.gets.filter(isAugust)).toHaveLength(2);
  expect(page.url()).toBe(entries.july);
  await expect(defaultsRetry(page)).toBeVisible();
  await defaultsRetry(page).focus();
  await page.keyboard.press('Enter');
  await expect(statusLine(page)).toHaveText('Defaults reset to the application defaults.');
  await settled(page);

  expect(resetPosts(control)).toHaveLength(1);
  expect(control.defaultsPosts()).toHaveLength(1);
  expect(control.gets.filter(isAugust)).toHaveLength(3);
  expect(fixture.generation()).toBe(generation + 1);
  expect(fixture.calendarKeys()).toEqual([]);
  await expect(retry(page)).toHaveCount(0);
  await expect(defaultsRetry(page)).toBeHidden();
  await expectAugustAfterReset(page, s);
  await closeDialog(page);
  await expectHistory(page, s, entries, augustResetUrl(s), [s.a1, s.a2]);
  await restore();
  expect(control.defaultsPosts()).toHaveLength(1);
  expect(control.errors).toEqual([]);
});

test('P2-B THIRD: Reset defaults with August already installed (keyboard Next) adds no history entry', async ({ page }) => {
  const s = seedHistory();
  const control = watch(page);
  const entries = await startFilteredJuly(page, s);
  await page.locator('#calendar-next').focus();
  await page.keyboard.press('Enter');
  await settled(page);
  await expect(region(page)).toHaveAttribute('data-calendar-month', AUGUST);
  await expectEntries(page, [s.a1]);
  expect(await historyLength(page)).toBe(entries.length + 1);

  await resetDefaults(page);
  await expect(statusLine(page)).toHaveText('Defaults reset to the application defaults.');
  await settled(page);
  expect(resetPosts(control)).toHaveLength(1);
  expect(control.gets.filter(isAugust)).toHaveLength(2);
  await expectAugustAfterReset(page, s);
  await closeDialog(page);
  await expectHistory(page, s, entries, augustResetUrl(s), [s.a1, s.a2]);
  expect(control.errors).toEqual([]);
});

test('P2-B FOURTH: Reset defaults acknowledged while the Next GET is held keeps its push; the held GET never installs', async ({ page }) => {
  const s = seedHistory();
  const control = watch(page);
  const entries = await startFilteredJuly(page, s);
  const held = await hold(page, (url) => isAugust(url) && url.searchParams.get('status') === 'planned');
  await page.locator('#calendar-next').click();
  await expect.poll(() => held.seen.length).toBe(1);

  await resetDefaults(page);
  await expect(statusLine(page)).toHaveText('Defaults reset to the application defaults.');
  await settled(page);
  expect(resetPosts(control)).toHaveLength(1);
  expect(control.gets.filter(isAugust)).toHaveLength(2);
  await expectAugustAfterReset(page, s);
  await held.deliver();
  await expectAugustAfterReset(page, s);
  await closeDialog(page);
  await expectHistory(page, s, entries, augustResetUrl(s), [s.a1, s.a2]);
  expect(control.defaultsPosts()).toHaveLength(1);
  expect(control.errors).toEqual([]);
});

test('P2-B FIFTH: a newer September pick while the adopted August refresh is held wins; history is July -> September', async ({ page }) => {
  const s = seedHistory();
  const control = watch(page);
  const entries = await startFilteredJuly(page, s);
  const restore = await failAugust(page, 1);
  await clickNextExpectFailure(page);
  await restore();
  const refresh = await hold(page, (url) => isAugust(url) && !url.searchParams.has('status'));

  await resetDefaults(page);
  await expect.poll(() => refresh.seen.length).toBe(1);
  expect(resetPosts(control)).toHaveLength(1);
  await closeDialog(page);

  await page.locator('.calendar-month-trigger').click();
  const picker = page.locator('#calendar-month-dialog');
  await expect(picker).toBeVisible();
  await expect(picker.locator('#calendar-month-year')).toHaveValue('2031');
  await picker.locator('#calendar-month-select > summary').click();
  await picker.locator('#calendar-month-select label').getByText('September', { exact: true }).click();
  await settled(page);
  if (await picker.isVisible()) await page.keyboard.press('Escape');

  const september = control.gets.at(-1);
  expect(september.searchParams.get('month')).toBe(SEPTEMBER);
  expectRepeated(september.href, 'project', [s.p1.id, s.p2.id]);
  await expect(region(page)).toHaveAttribute('data-calendar-month', SEPTEMBER);
  await expectEntries(page, [s.s1]);
  const septemberUrl = page.url();
  expect(new URL(septemberUrl).searchParams.get('month')).toBe(SEPTEMBER);

  await refresh.deliver();
  expect(page.url()).toBe(septemberUrl);
  await expect(region(page)).toHaveAttribute('data-calendar-month', SEPTEMBER);
  await expectEntries(page, [s.s1]);
  await expectHistory(page, s, entries, septemberUrl, [s.s1]);
  expect(resetPosts(control)).toHaveLength(1);
  expect(control.defaultsPosts()).toHaveLength(1);
  expect(control.errors).toEqual([]);
});

/*
 * Cumulative closure P2: after a CONFIRMED Reset defaults, the Status / View /
 * week start controls of the pending or failed refresh show the confirmed
 * post-Reset authority (the application fallbacks), never the deleted saved
 * Published / List / Sunday the installed page's authority still names. So
 * choosing Published is a real change: one explicit status=published GET that
 * installs published releases only. Real Express routes, disposable SQLite,
 * request gates only (no sleeps).
 */
const SAVED_PUBLISHED = Object.freeze({ view: 'list', status: 'published', weekStart: 'sunday' });
const isPublished = (url) => url.searchParams.get('status') === 'published';

function seedPublishedDefault() {
  const s = seedHistory();
  fixture.clearCalendarDefaults();
  Object.entries(SAVED_PUBLISHED).forEach(([option, value]) => fixture.writePageDefault('calendar', option, value));
  return s;
}

function plannedJulyUrl() {
  return calendarUrl(fixture.baseURL, { month: MONTH, status: 'planned' });
}

async function startPlannedJuly(page, s) {
  await page.setViewportSize({ width: 1280, height: 900 });
  const earlier = calendarUrl(fixture.baseURL, { month: JUNE });
  await page.goto(earlier);
  await enhanced(page);
  const july = plannedJulyUrl();
  await page.goto(july);
  await enhanced(page);
  await expectEntries(page, [s.j1, s.j2, s.j3]);
  // The saved View / week start apply; status is explicitly Planned.
  await expect(region(page)).toHaveClass(/calendar-view-list/);
  expect(await checked(page, 'calendar-status-filter')).toEqual(['planned']);
  expect(await checked(page, 'calendar-view-filter')).toEqual(['list']);
  expect(await checked(page, 'calendar-week-start-filter')).toEqual(['sunday']);
  return { earlier, july, length: await historyLength(page) };
}

async function expectFallbackControls(page) {
  expect(await checked(page, 'calendar-status-filter')).toEqual(['all']);
  expect(await checked(page, 'calendar-view-filter')).toEqual(['grid']);
  expect(await checked(page, 'calendar-week-start-filter')).toEqual(['monday']);
  expect(await summaryText(page, 'calendar-status-filter')).toBe('All releases');
}

async function expectResetCommitted(control, generation) {
  expect(resetPosts(control)).toHaveLength(1);
  expect(control.defaultsPosts()).toHaveLength(1);
  expect(fixture.generation()).toBe(generation + 1);
  expect(fixture.calendarKeys()).toEqual([]);
}

async function chooseInDialog(page, id, label) {
  const details = await openDropdown(page, id);
  await details.locator('label').getByText(label, { exact: true }).click();
}

/** Fails the first `failures` live GETs matching `predicate` with 503. */
async function failMatching(page, predicate, failures) {
  const matcher = (url) => url.pathname === '/calendar' && predicate(url);
  let remaining = failures;
  await page.route(matcher, async (route) => {
    if (remaining > 0 && route.request().resourceType() === 'fetch') {
      remaining -= 1;
      await route.fulfill({ status: 503, body: 'unavailable' });
      return;
    }
    await route.continue();
  });
  return () => page.unroute(matcher);
}

test('P2 POST-RESET PRIMARY: held Reset refresh shows All releases; Published sends one explicit GET and installs published only', async ({ page }) => {
  const s = seedPublishedDefault();
  const control = watch(page);
  const generation = fixture.generation();
  const entries = await startPlannedJuly(page, s);

  await openDialog(page);
  const refresh = await hold(page, isReset);
  await resetDefaultsButton(page).click();
  await expect.poll(() => refresh.seen.length).toBe(1);
  // The real POST committed in SQLite before its refresh GET started.
  await expectResetCommitted(control, generation);
  await expectFallbackControls(page);

  const before = control.gets.length;
  await chooseStatus(page, 'Published');
  await expect.poll(() => control.gets.filter(isPublished).length).toBe(1);
  await settled(page);
  const chosen = control.gets.filter(isPublished)[0];
  expect(control.gets.length).toBe(before + 1);
  expect(chosen.searchParams.get('month')).toBe(MONTH);
  expect(chosen.searchParams.getAll('project')).toEqual([]);
  expect(chosen.searchParams.getAll('type')).toEqual([]);
  await expectEntries(page, [s.j2p, s.j3p]);
  expect(await checked(page, 'calendar-status-filter')).toEqual(['published']);
  const publishedUrl = page.url();
  expect(new URL(publishedUrl).searchParams.get('status')).toBe('published');

  // The older Reset refresh answers last and never installs All releases.
  await refresh.deliver();
  expect(page.url()).toBe(publishedUrl);
  await expectEntries(page, [s.j2p, s.j3p]);
  expect(await checked(page, 'calendar-status-filter')).toEqual(['published']);
  await expect(statusLine(page)).toHaveText('Defaults reset to the application defaults.');
  await closeDialog(page);

  // One entry for the explicit choice; Back is the Planned July.
  expect(await historyLength(page)).toBe(entries.length + 1);
  await page.goBack();
  await settled(page);
  await expect.poll(() => page.url()).toBe(entries.july);
  await expectEntries(page, [s.j1, s.j2, s.j3]);
  await page.goForward();
  await settled(page);
  await expect.poll(() => page.url()).toBe(publishedUrl);
  await expectEntries(page, [s.j2p, s.j3p]);
  await expectResetCommitted(control, generation);
  expect(control.errors).toEqual([]);
});

test('P2 POST-RESET SECOND: the Reset refresh fails; Published wins over the stale Retry; no POST replay', async ({ page }) => {
  const s = seedPublishedDefault();
  const control = watch(page);
  const generation = fixture.generation();
  const entries = await startPlannedJuly(page, s);
  const restore = await failMatching(page, isReset, 1);

  await openDialog(page);
  await resetDefaultsButton(page).click();
  await expect(statusLine(page)).toHaveText('Defaults were reset, but Calendar could not be refreshed. Retry to refresh the page.');
  await settled(page);
  await expect(defaultsRetry(page)).toBeVisible();
  await expectResetCommitted(control, generation);
  await expectEntries(page, [s.j1, s.j2, s.j3]);
  await expectFallbackControls(page);

  await chooseStatus(page, 'Published');
  await expect.poll(() => control.gets.filter(isPublished).length).toBe(1);
  await settled(page);
  const chosen = control.gets.filter(isPublished)[0];
  expect(chosen.searchParams.get('month')).toBe(MONTH);
  await expectEntries(page, [s.j2p, s.j3p]);
  expect(await checked(page, 'calendar-status-filter')).toEqual(['published']);
  // The newer choice owns the recovery: the stale Retry is retired.
  await expect(defaultsRetry(page)).toBeHidden();
  await expect(retry(page)).toHaveCount(0);
  await expect(statusLine(page)).toHaveText('Defaults reset to the application defaults.');
  const gets = control.gets.length;
  await closeDialog(page);
  await settled(page);
  expect(control.gets.length).toBe(gets);
  await expectEntries(page, [s.j2p, s.j3p]);
  expect(await historyLength(page)).toBe(entries.length + 1);
  await restore();
  await expectResetCommitted(control, generation);
  expect(control.errors).toEqual([]);
});

test('P2 POST-RESET THIRD: failed August, failed Reset refresh, then Published keeps August, Projects and Types; Back / Forward', async ({ page }) => {
  const s = seedPublishedDefault();
  const control = watch(page);
  const generation = fixture.generation();
  const projects = [s.p1.id, s.p2.id, 987654321];
  const entries = await startFilteredJuly(page, s, projects);
  // The Next GET and the automatic August Reset refresh both fail.
  const restore = await failAugust(page, 2);
  await clickNextExpectFailure(page);

  await resetDefaults(page);
  await expect(statusLine(page)).toHaveText('Defaults were reset, but Calendar could not be refreshed. Retry to refresh the page.');
  await settled(page);
  expect(control.gets.filter(isAugust)).toHaveLength(2);
  await expectResetCommitted(control, generation);
  await expect(region(page)).toHaveAttribute('data-calendar-month', MONTH);
  await expectFallbackControls(page);

  await chooseStatus(page, 'Published');
  await expect.poll(() => control.gets.filter(isPublished).length).toBe(1);
  await settled(page);
  const chosen = control.gets.filter(isPublished)[0];
  expect(chosen.searchParams.get('month')).toBe(AUGUST);
  expectRepeated(chosen.href, 'project', projects);
  expectRepeated(chosen.href, 'type', ['comic', 'images']);
  await expect(region(page)).toHaveAttribute('data-calendar-month', AUGUST);
  await expectEntries(page, [s.a2]);
  expect(await checked(page, 'calendar-status-filter')).toEqual(['published']);
  expect((await checked(page, 'calendar-project-filter')).sort()).toEqual([String(s.p1.id), String(s.p2.id)].sort());
  expect((await checked(page, 'calendar-type-filter')).sort()).toEqual(['comic', 'images']);
  await expect(defaultsRetry(page)).toBeHidden();
  await expect(retry(page)).toHaveCount(0);
  const augustUrl = page.url();
  expect(new URL(augustUrl).searchParams.get('month')).toBe(AUGUST);
  await closeDialog(page);

  // Exactly one August entry: Back is the filtered July, Forward August.
  await expectHistory(page, s, entries, augustUrl, [s.a2]);
  await restore();
  await expectResetCommitted(control, generation);
  expect(control.errors).toEqual([]);
});

test('P2 POST-RESET FOURTH: Reset of the installed month with no newer navigation shows the fallbacks and adds no entry', async ({ page }) => {
  const s = seedPublishedDefault();
  const control = watch(page);
  const generation = fixture.generation();
  const entries = await startPlannedJuly(page, s);
  await openDialog(page);
  await resetDefaultsButton(page).click();
  await expect(statusLine(page)).toHaveText('Defaults reset to the application defaults.');
  await settled(page);
  await expectResetCommitted(control, generation);
  expect(page.url()).toBe(calendarUrl(fixture.baseURL, { month: MONTH }));
  await expectEntries(page, [s.j1, s.j2, s.j2p, s.j3, s.j3p]);
  await expect(region(page)).toHaveClass(/calendar-view-grid/);
  expect((await columnHeaders(page))[0]).toBe('Mon');
  await expectFallbackControls(page);
  expect(await historyLength(page)).toBe(entries.length);
  await closeDialog(page);
  await page.goBack();
  await expect.poll(() => page.url()).toBe(entries.earlier);
  expect(control.errors).toEqual([]);
});

test('P2 POST-RESET FIFTH: newer Status, week start and View choices during the held refresh survive late responses', async ({ page }) => {
  const s = seedPublishedDefault();
  const control = watch(page);
  const generation = fixture.generation();
  const entries = await startPlannedJuly(page, s);
  await openDialog(page);
  const refresh = await hold(page, isReset);
  await resetDefaultsButton(page).click();
  await expect.poll(() => refresh.seen.length).toBe(1);
  await expectResetCommitted(control, generation);
  await expectFallbackControls(page);

  // Each is a real change away from the post-Reset fallback.
  await chooseStatus(page, 'Published');
  await expect.poll(() => control.gets.filter(isPublished).length).toBe(1);
  await settled(page);
  await chooseInDialog(page, 'calendar-week-start-filter', 'Sunday');
  await expect.poll(() => control.gets.filter((url) => url.searchParams.get('weekStart') === 'sunday').length).toBe(1);
  await settled(page);
  await chooseInDialog(page, 'calendar-view-filter', 'List');
  await expect.poll(() => control.gets.filter((url) => url.searchParams.get('view') === 'list').length).toBe(1);
  await settled(page);
  const latest = control.gets.at(-1);
  expect(latest.searchParams.get('month')).toBe(MONTH);
  expect(latest.searchParams.get('status')).toBe('published');
  expect(latest.searchParams.get('weekStart')).toBe('sunday');
  expect(latest.searchParams.get('view')).toBe('list');

  await refresh.deliver();
  await settled(page);
  expect(new URL(page.url()).searchParams.get('status')).toBe('published');
  await expect(region(page)).toHaveClass(/calendar-view-list/);
  await expect.poll(() => matchingCount(page)).toBe(2);
  expect(await checked(page, 'calendar-status-filter')).toEqual(['published']);
  expect(await checked(page, 'calendar-view-filter')).toEqual(['list']);
  expect(await checked(page, 'calendar-week-start-filter')).toEqual(['sunday']);
  await expectResetCommitted(control, generation);
  expect(await historyLength(page)).toBeGreaterThan(entries.length);
  expect(control.errors).toEqual([]);
});

function failCalendarAuthorityReads() {
  const service = fixture.state.app.locals.pageDefaultsService;
  const describe = service.describeSavedDefaults;
  service.describeSavedDefaults = (key, ...args) => {
    if (key === 'calendar') throw new Error('Calendar defaults metadata unavailable');
    return describe(key, ...args);
  };
  return () => { service.describeSavedDefaults = describe; };
}

const authorityScript = (page) => region(page).locator('script[data-calendar-defaults-authority]');
const isJuneOmitted = (url) => url.searchParams.get('month') === JUNE && !url.searchParams.has('status');

const unsupportedMetadata = {
  'unsupported values': { status: 'archived', view: 'timeline', weekStart: 'saturday' },
  'unsupported status': { status: 'archived' },
  'unsupported view': { view: 'timeline' },
  'unsupported week start': { weekStart: 'saturday' },
};
for (const mode of ['missing metadata', 'unreadable generation', ...Object.keys(unsupportedMetadata)]) {
  test(`METADATA P2-A: ${mode} on a Published install preserves Reset through Back`, async ({ page }) => {
    const s = seedPublishedDefault();
    const control = watch(page);
    const generation = fixture.generation();
    const june = calendarUrl(fixture.baseURL, { month: JUNE });
    await start(page, june);
    await openDialog(page);
    const junePlanned = await hold(page, (url) => url.searchParams.get('month') === JUNE
      && url.searchParams.get('status') === 'planned');
    await chooseStatus(page, 'Planned');
    await expect.poll(() => junePlanned.seen.length).toBe(1);
    await closeDialog(page);
    await page.locator('#calendar-next').click();
    await expect(region(page)).toHaveAttribute('data-calendar-month', MONTH);
    expect(query(page).get('status')).toBe('planned');
    await junePlanned.deliver();

    await openDialog(page);
    const refresh = await hold(page, isReset);
    await resetDefaultsButton(page).click();
    await expect.poll(() => refresh.seen.length).toBe(1);
    await expectResetCommitted(control, generation);
    await expectFallbackControls(page);
    const julyPublished = (url) => url.pathname === '/calendar' && url.searchParams.get('month') === MONTH && isPublished(url);
    let restore;
    if (mode === 'missing metadata') {
      restore = failCalendarAuthorityReads();
    } else {
      await page.route(julyPublished, async (route) => {
        const response = await route.fetch();
        const body = (await response.text()).replace(
          /(<script\b[^>]*data-calendar-defaults-authority[^>]*>)([^<]+)(<\/script>)/,
          (_match, opening, json, closing) => {
            const authority = JSON.parse(json);
            return opening + JSON.stringify({
              ...authority,
              generation: unsupportedMetadata[mode] ? generation + 1 : String(generation + 1),
              defaults: SAVED_PUBLISHED,
              current: { ...authority.current, ...unsupportedMetadata[mode] },
            }) + closing;
          },
        );
        await route.fulfill({ response, body });
      });
      restore = () => page.unroute(julyPublished);
    }
    try {
      const installed = page.waitForResponse((response) => julyPublished(new URL(response.url()))
        && response.request().resourceType() === 'fetch');
      await chooseStatus(page, 'Published');
      expect((await installed).status()).toBe(200);
      await expectEntries(page, [s.j2p, s.j3p]);
      if (mode === 'missing metadata') await expect(authorityScript(page)).toHaveCount(0);
      else expect(await pageAuthority(page)).toMatchObject({
        generation: unsupportedMetadata[mode] ? generation + 1 : String(generation + 1),
        defaults: SAVED_PUBLISHED,
        ...(unsupportedMetadata[mode] ? { current: unsupportedMetadata[mode] } : {}),
      });
    } finally {
      await restore();
    }
    await refresh.deliver();
    await closeDialog(page);
    const back = await hold(page, isJuneOmitted);
    await page.evaluate(() => history.go(-2));
    await expect.poll(() => back.seen.length).toBe(1);
    expect(page.url()).toBe(june);
    await openDialog(page);
    const beforeChoice = await Promise.all([
      checked(page, 'calendar-status-filter'), checked(page, 'calendar-view-filter'), checked(page, 'calendar-week-start-filter'),
    ]);
    const count = control.gets.length;
    await chooseStatus(page, 'Published');
    await expect.poll(() => control.gets.length - count, {
      message: `Published GETs after clicking with controls ${JSON.stringify(beforeChoice)}`,
    }).toBe(1);
    expect(beforeChoice).toEqual([['all'], ['grid'], ['monday']]);
    expect(control.gets.at(-1).href).toBe(calendarUrl(fixture.baseURL, { month: JUNE, status: 'published' }));
    expect(control.gets.filter(isPublished)).toHaveLength(2);
    await expectEntries(page, [s.u2, s.u3]);
    await back.deliver();
    await expectEntries(page, [s.u2, s.u3]);
    expect(await pageAuthority(page)).toMatchObject({ generation: generation + 1 });
    expect(await checked(page, 'calendar-status-filter')).toEqual(['published']);
    expect(await checked(page, 'calendar-view-filter')).toEqual(['grid']);
    expect(await checked(page, 'calendar-week-start-filter')).toEqual(['monday']);
    await expectResetCommitted(control, generation);

    if (mode === 'missing metadata' || mode === 'unsupported values') {
      await dialog(page).locator('[data-calendar-defaults-save]').click();
      await expect(statusLine(page)).toHaveText('Defaults saved.');
      expect(fixture.generation()).toBe(generation + 2);
      expect(await pageAuthority(page)).toMatchObject({ generation: generation + 2 });
      expect(fixture.storedCalendarDefaults()).toEqual({ view: 'grid', status: 'published', weekStart: 'monday' });
      await closeDialog(page);
      const afterSaveBack = await hold(page, isJuneOmitted);
      await page.goBack();
      await expect.poll(() => afterSaveBack.seen.length).toBe(1);
      expect(await checked(page, 'calendar-status-filter')).toEqual(['published']);
      await afterSaveBack.deliver();
      await settled(page);
      await page.goForward();
      await settled(page);
      await expectEntries(page, [s.u2, s.u3]);
      await openDialog(page);
      await chooseStatus(page, 'Planned');
      await expectEntries(page, [s.u1]);
      expect(control.gets.at(-1).searchParams.get('status')).toBe('planned');
      expect(control.defaultsPosts()).toHaveLength(2);
      expect(resetPosts(control)).toHaveLength(1);
    }
    expect(control.errors).toEqual([]);
  });
}

for (const [source, mode] of [
  ['previous install', 'held refresh'],
  ['previous install', 'failed refresh'],
  ['previous install', 'GET-only Retry'],
  ['cold start', 'held refresh'],
  ['cold start', 'failed refresh'],
  ['cold start', 'GET-only Retry'],
  ['cold start', 'successful refresh'],
]) {
  test(`METADATA P2-B: real committed 500 from ${source}, ${mode}`, async ({ page }) => {
    const s = seedPublishedDefault();
    const control = watch(page);
    const generation = fixture.generation();
    const coldStart = source === 'cold start';
    if (coldStart) {
      const restoreInitial = failCalendarAuthorityReads();
      try {
        await start(page, calendarUrl(fixture.baseURL, { month: MONTH }));
        await expect(authorityScript(page)).toHaveCount(0);
      } finally {
        restoreInitial();
      }
      const metadata = page.waitForResponse((response) => new URL(response.url()).pathname === '/calendar/defaults'
        && response.request().method() === 'GET');
      await openDialog(page);
      const response = await metadata;
      expect(response.status()).toBe(200);
      expect(await response.json()).toMatchObject({ status: 'success', authority: {
        generation, defaults: SAVED_PUBLISHED, fallbacks: { view: 'grid', status: 'all', weekStart: 'monday' },
      } });
      await expect(resetDefaultsButton(page)).toBeEnabled();
      expect(control.defaultsGets).toHaveLength(1);
    } else {
      await startPlannedJuly(page, s);
      await openDialog(page);
    }
    const restore = failCalendarAuthorityReads();
    try {
      if (!coldStart) await resetFiltersButton(page).click();
      await expect(authorityScript(page)).toHaveCount(0);
      await expectEntries(page, [s.j2p, s.j3p]);
      expect(await checked(page, 'calendar-status-filter')).toEqual(['published']);
      const refresh = mode === 'held refresh' ? await hold(page, isReset) : null;
      if (!refresh && mode !== 'successful refresh') {
        await failMatching(page, isReset, mode === 'GET-only Retry' ? 2 : 1);
      }
      const acknowledgement = page.waitForResponse((response) => new URL(response.url()).pathname === '/calendar/defaults/reset'
        && response.request().method() === 'POST');
      await resetDefaultsButton(page).click();
      const response = await acknowledgement;
      expect(response.status()).toBe(500);
      const operationId = control.defaultsPosts()[0].body.get('defaultsOperation');
      const payload = await response.json();
      expect(payload).toMatchObject({
        committed: true,
        operation: { id: operationId, kind: 'resetDefaults', result: 'committed', committed: true,
          expectedGeneration: generation, generation: generation + 1 },
      });
      expect(payload.authority).toBeUndefined();
      await expectResetCommitted(control, generation);
      if (refresh) await expect.poll(() => refresh.seen.length).toBe(1);
      else if (mode === 'successful refresh') {
        await expect(statusLine(page)).toHaveText('Defaults reset to the application defaults.');
        await expectEntries(page, [s.j1, s.j2, s.j2p, s.j3, s.j3p]);
      } else await expect(defaultsRetry(page)).toBeVisible();
      const beforeChoice = await Promise.all([
        checked(page, 'calendar-status-filter'), checked(page, 'calendar-view-filter'), checked(page, 'calendar-week-start-filter'),
      ]);

      if (mode === 'GET-only Retry') {
        await expectFallbackControls(page);
        const before = control.gets.length;
        await defaultsRetry(page).click();
        await expect(defaultsRetry(page)).toBeVisible();
        expect(control.gets.length).toBe(before + 1);
        await defaultsRetry(page).click();
        await expect(statusLine(page)).toHaveText('Defaults reset to the application defaults.');
        expect(control.gets.length).toBe(before + 2);
        expect(control.gets.slice(-2).every(isReset)).toBe(true);
        await expectEntries(page, [s.j1, s.j2, s.j2p, s.j3, s.j3p]);
      }
      const count = control.gets.length;
      await chooseStatus(page, 'Published');
      await expect.poll(() => control.gets.length - count, {
        message: `Published GETs after clicking with controls ${JSON.stringify(beforeChoice)}`,
      }).toBe(1);
      expect(beforeChoice).toEqual([['all'], ['grid'], ['monday']]);
      expect(control.gets.filter(isPublished)).toHaveLength(1);
      expect(control.gets.at(-1).searchParams.get('month')).toBe(MONTH);
      await expectEntries(page, [s.j2p, s.j3p]);
      if (refresh) await refresh.deliver();
      await expectEntries(page, [s.j2p, s.j3p]);
      await expect(defaultsRetry(page)).toBeHidden();
      await expect(retry(page)).toHaveCount(0);
      await expectResetCommitted(control, generation);
      expect(control.gets).toHaveLength((mode === 'GET-only Retry' ? 5 : 3) - Number(coldStart));
      expect(control.errors).toEqual([]);
    } finally {
      restore();
    }
  });
}
