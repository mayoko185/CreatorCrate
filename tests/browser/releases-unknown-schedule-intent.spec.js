import { expect, test } from '@playwright/test';
import {
  checkedValues, choose, createReleasesFixture, dialog, dropdown, enhanced, expectRepeated, openDialog, query,
  releasesUrl, renderedTitles, settled, summaryText, totalCount, watch,
} from './releases-filters-defaults-fixture.js';

// P3 correction 2: the server serves an unsupported Schedule
// (anything but overdue / today / upcoming / unscheduled) unrestricted. While
// a Back / Forward / failed history GET to such a destination is the latest
// intent, the pending Schedule control must show that effective All (All radio
// checked, All summary, no stale Overdue) and a later filter GET must omit the
// raw value. The history GET itself keeps its own URL.

const fixture = createReleasesFixture('releases-p3-unknown-schedule');
const INVALID = 'invalid-schedule';
const SCHEDULE = 'list-schedule';
const UNKNOWN = 999999;

test.beforeAll(async () => {
  await fixture.start();
});

test.afterAll(async () => {
  await fixture.stop();
});

// Overdue: a past planned date. Upcoming: a far-future one. Unscheduled: none.
// Search=Needle unrestricted matches three; Overdue alone matches two; the
// Overdue restriction with Needle would match only one.
function seed() {
  // No saved Sort / Order: the initially loaded entry keeps its own URL (with
  // saved defaults the page canonicalizes it, dropping the unsupported value
  // before any Back could restore it). Titles are compared order-free.
  fixture.isolate();
  const comic = fixture.project('P3S Comic', { projectType: 'comic' });
  return {
    comic,
    needleOverdue: fixture.release(comic, 'Needle overdue', { plannedDate: '2020-01-15' }),
    needleUpcoming: fixture.release(comic, 'Needle upcoming', { plannedDate: '2099-06-01' }),
    needleUnscheduled: fixture.release(comic, 'Needle unscheduled'),
    zuluOverdue: fixture.release(comic, 'Zulu overdue', { plannedDate: '2020-02-20' }),
  };
}

const ALL_TITLES = ['Needle overdue', 'Needle unscheduled', 'Needle upcoming', 'Zulu overdue'];
const NEEDLE_TITLES = ['Needle overdue', 'Needle unscheduled', 'Needle upcoming'];
const OVERDUE_TITLES = ['Needle overdue', 'Zulu overdue'];

async function start(page, url) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(url);
  await enhanced(page);
}

async function frame(page) {
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)));
  }));
}

/** Holds (or fails) the live fetch GET for `predicate` until released. */
async function hold(page, predicate, { fail = false } = {}) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let markSeen;
  const seen = new Promise((resolve) => { markSeen = resolve; });
  let markDone;
  const done = new Promise((resolve) => { markDone = resolve; });
  let handled = false;
  await page.route((url) => url.pathname === '/releases' && predicate(url), async (route) => {
    if (handled || route.request().resourceType() !== 'fetch') {
      await route.fallback();
      return;
    }
    handled = true;
    markSeen();
    if (fail) {
      await route.abort('failed').catch(() => {});
      markDone();
      return;
    }
    await gate;
    await route.continue().catch(() => {});
    markDone();
  });
  return { seen, release, done };
}

function waitForSearch(page, value) {
  return page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === '/releases' && request.resourceType() === 'fetch' && url.searchParams.get('search') === value;
  });
}

async function scheduleState(page) {
  const details = dropdown(page, SCHEDULE);
  return {
    trigger: (await details.locator('summary').innerText()).trim(),
    summary: await summaryText(page, SCHEDULE),
    aria: await details.locator('summary').getAttribute('aria-label'),
    checked: await checkedValues(page, SCHEDULE),
    carriers: await page.locator('input[data-releases-intended-carrier][name="schedule"]')
      .evaluateAll((inputs) => inputs.map((input) => input.value)),
    submitted: await page.locator('form[data-releases-filter]').evaluate((form) => new FormData(form).getAll('schedule')),
  };
}

const EFFECTIVE_ALL = {
  trigger: 'All', summary: 'All', aria: 'Schedule filter: All', checked: [''], carriers: [], submitted: [''],
};

/** Titles the server returns for `url` loaded directly (no client serialization). */
async function directTitles(page, url) {
  const other = await page.context().newPage();
  await other.goto(url);
  const titles = await renderedTitles(other);
  await other.close();
  return titles.sort();
}

async function sortedTitles(page) {
  return (await renderedTitles(page)).sort();
}

/** Invalid installed -> choose Overdue -> Back to the invalid entry, its GET held (or failed). */
async function overdueThenBack(page, { fail = false, extra = {} } = {}) {
  const invalidUrl = releasesUrl(fixture.baseURL, { ...extra, schedule: INVALID, pageSize: 10 });
  await start(page, invalidUrl);
  // The server already renders the unsupported value as All.
  expect(await scheduleState(page)).toMatchObject({ summary: 'All', checked: [''] });
  await openDialog(page);
  await choose(page, SCHEDULE, 'Overdue');
  expect(query(page).get('schedule')).toBe('overdue');
  expect(await scheduleState(page)).toMatchObject({ summary: 'Overdue', checked: ['overdue'] });

  const back = await hold(page, (url) => url.searchParams.get('schedule') === INVALID && !url.searchParams.has('search'), { fail });
  await page.goBack({ waitUntil: 'commit' });
  await back.seen;
  await expect.poll(() => page.url()).toBe(invalidUrl);
  return { back, invalidUrl };
}

test('reviewer reproduction: invalid -> Overdue -> Back held -> All shown -> Search Needle omits Schedule; the late Back never installs', async ({ page }) => {
  seed();
  const control = watch(page);
  const { back, invalidUrl } = await overdueThenBack(page);
  // Inspect BEFORE the Back GET installs: the pending control shows the effective All.
  expect(await sortedTitles(page)).toEqual(OVERDUE_TITLES);
  expect(await scheduleState(page)).toEqual(EFFECTIVE_ALL);
  // (The summary's aria-hidden width sizer lists every label; the visible current text must not.)
  await expect(dropdown(page, SCHEDULE).locator('[data-cc-dropdown-summary-current]')).not.toContainText('Overdue');
  expect(await page.locator('#releases-search').inputValue()).toBe('');
  expect(await checkedValues(page, 'release-project-filter')).toEqual(['']);
  expect(await checkedValues(page, 'release-type-filter')).toEqual(['']);
  expect(page.url()).toBe(invalidUrl);

  const searched = waitForSearch(page, 'Needle');
  await page.locator('#releases-search').fill('Needle');
  const requested = new URL((await searched).url());
  expect(requested.searchParams.has('schedule')).toBe(false);
  expect(requested.searchParams.get('pageSize')).toBe('10');
  expect(requested.searchParams.has('project')).toBe(false);
  expect(requested.searchParams.has('type')).toBe(false);
  await settled(page);
  await expect.poll(() => sortedTitles(page)).toEqual(NEEDLE_TITLES);
  expect(await totalCount(page)).toBe(3);
  expect(await directTitles(page, requested.href)).toEqual(NEEDLE_TITLES);

  const installed = page.url();
  back.release();
  await back.done;
  await frame(page);
  expect(page.url()).toBe(installed);
  expect(query(page).has('schedule')).toBe(false);
  expect(query(page).get('search')).toBe('Needle');
  expect(await sortedTitles(page)).toEqual(NEEDLE_TITLES);
  expect(await totalCount(page)).toBe(3);
  expect(await scheduleState(page)).toMatchObject({ summary: 'All', checked: [''], carriers: [] });
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('valid history: Overdue -> Upcoming -> Back held to Overdue keeps Overdue; Search composes with it', async ({ page }) => {
  seed();
  const control = watch(page);
  const overdueUrl = releasesUrl(fixture.baseURL, { schedule: 'overdue', pageSize: 10 });
  await start(page, overdueUrl);
  await openDialog(page);
  await choose(page, SCHEDULE, 'Upcoming');
  expect(query(page).get('schedule')).toBe('upcoming');
  expect(await renderedTitles(page)).toEqual(['Needle upcoming']);

  const back = await hold(page, (url) => url.searchParams.get('schedule') === 'overdue' && !url.searchParams.has('search'));
  await page.goBack({ waitUntil: 'commit' });
  await back.seen;
  expect(await scheduleState(page)).toEqual({
    trigger: 'Overdue', summary: 'Overdue', aria: 'Schedule filter: Overdue',
    checked: ['overdue'], carriers: [], submitted: ['overdue'],
  });

  const searched = waitForSearch(page, 'Needle');
  await page.locator('#releases-search').fill('Needle');
  const requested = new URL((await searched).url());
  expect(requested.searchParams.getAll('schedule')).toEqual(['overdue']);
  await settled(page);
  await expect.poll(() => renderedTitles(page)).toEqual(['Needle overdue']);
  expect(await totalCount(page)).toBe(1);
  back.release();
  await back.done;
  await frame(page);
  expect(await renderedTitles(page)).toEqual(['Needle overdue']);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('failed Back to invalid -> All stays -> Search omits Schedule and renders unrestricted matches', async ({ page }) => {
  seed();
  const control = watch(page);
  const { back } = await overdueThenBack(page, { fail: true });
  await back.done;
  await expect(page.locator('[data-live-filter-failure]')).toHaveCount(1);
  expect(await scheduleState(page)).toEqual(EFFECTIVE_ALL);

  const searched = waitForSearch(page, 'Needle');
  await page.locator('#releases-search').fill('Needle');
  const requested = new URL((await searched).url());
  expect(requested.searchParams.has('schedule')).toBe(false);
  await settled(page);
  await expect.poll(() => sortedTitles(page)).toEqual(NEEDLE_TITLES);
  expect(await totalCount(page)).toBe(3);
  await expect(page.locator('[data-live-filter-failure]')).toHaveCount(0);
  expect(query(page).has('schedule')).toBe(false);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('Reset filters during the held invalid Back: GET only, no Schedule, All shown; the late Back never installs', async ({ page }) => {
  seed();
  const control = watch(page);
  const { back } = await overdueThenBack(page);
  expect(await scheduleState(page)).toEqual(EFFECTIVE_ALL);
  const reset = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === '/releases' && request.resourceType() === 'fetch' && !url.searchParams.has('schedule');
  });
  await dialog(page).locator('[data-releases-filters-reset]').click();
  const requested = new URL((await reset).url());
  expect(requested.searchParams.has('schedule')).toBe(false);
  expect(requested.searchParams.get('pageSize')).toBe('10');
  await settled(page);
  await expect.poll(() => sortedTitles(page)).toEqual(ALL_TITLES);
  expect(await totalCount(page)).toBe(4);
  expect(await scheduleState(page)).toMatchObject({ summary: 'All', checked: [''], carriers: [] });

  const installed = page.url();
  back.release();
  await back.done;
  await frame(page);
  expect(page.url()).toBe(installed);
  expect(await sortedTitles(page)).toEqual(ALL_TITLES);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('hidden Project alongside invalid Schedule: Back held -> Search keeps the Project, omits Schedule', async ({ page }) => {
  seed();
  const control = watch(page);
  const restricted = releasesUrl(fixture.baseURL, { project: UNKNOWN, schedule: INVALID, pageSize: 10 });
  await start(page, restricted);
  expect(await renderedTitles(page)).toEqual([]);
  await openDialog(page);
  await dialog(page).locator('[data-releases-filters-reset]').click();
  await settled(page);
  expect(query(page).has('project')).toBe(false);
  await choose(page, SCHEDULE, 'Overdue');
  expect(await summaryText(page, SCHEDULE)).toBe('Overdue');

  // Back two entries: past the Overdue choice and the Reset, to the restricted entry.
  const back = await hold(page, (url) => url.searchParams.get('schedule') === INVALID && !url.searchParams.has('search'));
  await page.goBack({ waitUntil: 'commit' });
  await settled(page);
  await page.goBack({ waitUntil: 'commit' });
  await back.seen;
  await expect.poll(() => page.url()).toBe(restricted);
  expect(await scheduleState(page)).toEqual(EFFECTIVE_ALL);
  expect(await summaryText(page, 'release-project-filter')).toBe('1 project selected');

  const searched = waitForSearch(page, 'Needle');
  await page.locator('#releases-search').fill('Needle');
  const requested = new URL((await searched).url());
  expectRepeated(requested.href, 'project', [UNKNOWN]);
  expect(requested.searchParams.has('schedule')).toBe(false);
  await settled(page);
  expect(await renderedTitles(page)).toEqual([]);
  expect(await directTitles(page, requested.href)).toEqual([]);
  back.release();
  await back.done;
  await frame(page);
  expect(await renderedTitles(page)).toEqual([]);
  expect(query(page).has('schedule')).toBe(false);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});
