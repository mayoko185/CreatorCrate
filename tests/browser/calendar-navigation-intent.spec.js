import { expect, test } from '@playwright/test';
import {
  MONTH, calendarUrl, closeDialog, createCalendarFixture, enhanced, expectEntries, expectRepeated, openDialog,
  openDropdown, query, settled, watch,
} from './calendar-filters-defaults-fixture.js';

// R2: Calendar month and filter navigation preserve the latest user intent,
// whatever order their GETs complete in. Both independently reviewed P2
// sequences (FILTER -> MONTH and MONTH -> FILTER) are reproduced with a held
// first request; the composed second request installs, and the older
// response delivered last never reinstalls. Requests are held and released
// by route interception only (no timing sleeps).

const fixture = createCalendarFixture('calendar-nav-intent');
const AUGUST = '2031-08';

test.beforeAll(async () => {
  await fixture.start();
});

test.afterAll(async () => {
  await fixture.stop();
});

function seed() {
  fixture.isolate();
  const p1 = fixture.project('Intent One', { projectType: 'comic' });
  const p2 = fixture.project('Intent Two', { projectType: 'images' });
  const p3 = fixture.project('Intent Three', { projectType: 'comic' });
  return {
    p1,
    p2,
    p3,
    j1: fixture.release(p1, 'Intent July One', { planned: `${MONTH}-10` }),
    j2: fixture.release(p2, 'Intent July Two', { planned: `${MONTH}-11` }),
    j3: fixture.release(p3, 'Intent July Three', { planned: `${MONTH}-02`, published: `${MONTH}-14` }),
    a1: fixture.release(p1, 'Intent August One', { planned: `${AUGUST}-05` }),
    a2: fixture.release(p2, 'Intent August Two', { planned: `${AUGUST}-06` }),
    // Published: shown on its published date in August.
    a3: fixture.release(p1, 'Intent August One Published', { planned: `${MONTH}-28`, published: `${AUGUST}-20` }),
    a4: fixture.release(p3, 'Intent August Three', { planned: `${AUGUST}-07` }),
  };
}

async function start(page, url = calendarUrl(fixture.baseURL, { month: MONTH })) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(url);
  await enhanced(page);
}

const region = (page) => page.locator('[data-calendar-live-region]');

/**
 * Holds live Calendar GETs matching `predicate` until released. `done`
 * settles once the held request was continued (or found aborted by the page).
 */
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
      // Let the page run every task the late response could have queued.
      await page.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)));
      }));
      await page.unroute(matcher);
    },
  };
}

async function checkProject(page, id, checked = true) {
  const details = await openDropdown(page, 'calendar-project-filter');
  const input = details.locator(`input[value="${id}"]`);
  if (checked) await input.check();
  else await input.uncheck();
}

async function checkType(page, value) {
  const details = await openDropdown(page, 'calendar-type-filter');
  await details.locator(`input[value="${value}"]`).check();
}

async function checked(page, id) {
  return page.locator(`#${id} input:checked`).evaluateAll((inputs) => inputs.map((input) => input.value));
}

async function expectAugust(page) {
  await expect(region(page)).toHaveAttribute('data-calendar-month', AUGUST);
  await expect(page.locator('[data-calendar-month-heading]')).toContainText('August 2031');
  expect(query(page).get('month')).toBe(AUGUST);
}

test('REPRODUCTION A: Next month while a held Project 1 GET is pending installs August with Project 1', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  await start(page);
  await expectEntries(page, [s.j1, s.j2, s.j3]);

  const first = await hold(page, (url) => url.searchParams.get('month') === MONTH
    && url.searchParams.getAll('project').length === 1);
  await openDialog(page);
  await checkProject(page, s.p1.id);
  await expect.poll(() => first.seen.length).toBe(1);
  await expect(region(page)).toHaveAttribute('aria-busy', 'true');
  // The dialog closes while the filter GET is still held.
  await closeDialog(page);

  await page.locator('#calendar-next').click();
  await settled(page);
  const second = control.gets.at(-1);
  expect(second.searchParams.get('month')).toBe(AUGUST);
  expectRepeated(second.href, 'project', [s.p1.id]);
  expect(second.searchParams.getAll('project')).not.toContain(String(s.p2.id));

  await expectAugust(page);
  expectRepeated(page.url(), 'project', [s.p1.id]);
  await expectEntries(page, [s.a1, s.a3]);
  await openDialog(page);
  expect(await checked(page, 'calendar-project-filter')).toEqual([String(s.p1.id)]);
  await closeDialog(page);

  // The older (July, Project 1) response delivered last is ignored.
  const installedUrl = page.url();
  await first.deliver();
  await expectAugust(page);
  expect(page.url()).toBe(installedUrl);
  await expectEntries(page, [s.a1, s.a3]);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('REPRODUCTION B: selecting Project 1 while a held August GET is pending installs August with Project 1', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  await start(page);

  const first = await hold(page, (url) => url.searchParams.get('month') === AUGUST
    && url.searchParams.getAll('project').length === 0);
  await page.locator('#calendar-next').click();
  await expect.poll(() => first.seen.length).toBe(1);
  await expect(region(page)).toHaveAttribute('aria-busy', 'true');

  await openDialog(page);
  await checkProject(page, s.p1.id);
  await settled(page);
  const second = control.gets.at(-1);
  expect(second.searchParams.getAll('month')).toEqual([AUGUST]);
  expectRepeated(second.href, 'project', [s.p1.id]);

  await closeDialog(page);
  await expectAugust(page);
  expectRepeated(page.url(), 'project', [s.p1.id]);
  await expectEntries(page, [s.a1, s.a3]);
  await openDialog(page);
  expect(await checked(page, 'calendar-project-filter')).toEqual([String(s.p1.id)]);
  await closeDialog(page);

  const installedUrl = page.url();
  await first.deliver();
  await expectAugust(page);
  expect(page.url()).toBe(installedUrl);
  await expectEntries(page, [s.a1, s.a3]);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('multiple Projects, Types and status compose with a held month; reload and Back/Forward keep it', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  const initialUrl = calendarUrl(fixture.baseURL, { month: MONTH });
  await start(page, initialUrl);

  const first = await hold(page, (url) => url.searchParams.get('month') === AUGUST
    && url.searchParams.getAll('project').length === 0);
  await page.locator('#calendar-next').click();
  await expect.poll(() => first.seen.length).toBe(1);

  await openDialog(page);
  await checkProject(page, s.p1.id);
  await checkProject(page, s.p3.id);
  await checkType(page, 'comic');
  const status = await openDropdown(page, 'calendar-status-filter');
  await status.locator('label').getByText('Planned', { exact: true }).click();
  await settled(page);

  const latest = control.gets.at(-1);
  expect(latest.searchParams.getAll('month')).toEqual([AUGUST]);
  expectRepeated(latest.href, 'project', [s.p1.id, s.p3.id]);
  expectRepeated(latest.href, 'type', ['comic']);
  expect(latest.searchParams.getAll('status')).toEqual(['planned']);
  await closeDialog(page);
  await expectAugust(page);
  await expectEntries(page, [s.a1, s.a4]);
  await first.deliver();
  await expectAugust(page);
  await expectEntries(page, [s.a1, s.a4]);

  // Reload after the composed navigation.
  const composedUrl = page.url();
  await page.reload();
  await enhanced(page);
  expect(page.url()).toBe(composedUrl);
  await expectAugust(page);
  await expectEntries(page, [s.a1, s.a4]);

  // Each filter edit made after the held month installed its own August
  // entry: Back returns to the previous one (August, all statuses), never to
  // a July carrying those filters; Forward returns to the composed entry.
  await page.goBack();
  await expect.poll(() => query(page).get('status')).toBe('all');
  await settled(page);
  await expectAugust(page);
  expectRepeated(page.url(), 'project', [s.p1.id, s.p3.id]);
  expectRepeated(page.url(), 'type', ['comic']);
  await expectEntries(page, [s.a1, s.a3, s.a4]);
  await page.goForward();
  await expectAugust(page);
  await settled(page);
  expect(page.url()).toBe(composedUrl);
  await expectEntries(page, [s.a1, s.a4]);
  await openDialog(page);
  expect((await checked(page, 'calendar-project-filter')).sort()).toEqual([String(s.p1.id), String(s.p3.id)].sort());
  expect(await checked(page, 'calendar-type-filter')).toEqual(['comic']);
  expect(await checked(page, 'calendar-status-filter')).toEqual(['planned']);
  await closeDialog(page);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('a failed month GET keeps July; a filter edit keeps the failed month; GET-only Retry installs both', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  await start(page);

  let failing = true;
  const augustRequest = (url) => url.pathname === '/calendar' && url.searchParams.get('month') === AUGUST;
  await page.route(augustRequest, async (route) => {
    if (failing && route.request().resourceType() === 'fetch') {
      await route.fulfill({ status: 503, body: 'unavailable' });
      return;
    }
    await route.continue();
  });

  await page.locator('#calendar-next').click();
  await expect(page.locator('[data-live-filter-retry]').first()).toBeVisible();
  await expect(region(page)).toHaveAttribute('data-calendar-month', MONTH);
  await expectEntries(page, [s.j1, s.j2, s.j3]);

  await openDialog(page);
  await checkProject(page, s.p1.id);
  await expect(page.locator('[data-live-filter-retry]').first()).toBeVisible();
  const composed = control.gets.at(-1);
  expect(composed.searchParams.get('month')).toBe(AUGUST);
  expectRepeated(composed.href, 'project', [s.p1.id]);
  await expect(region(page)).toHaveAttribute('data-calendar-month', MONTH);
  // The failed request did not restore the old (empty) Project selection.
  expect(await checked(page, 'calendar-project-filter')).toEqual([String(s.p1.id)]);

  failing = false;
  const getsBefore = control.gets.length;
  await page.locator('[data-live-filter-retry]').first().click();
  await settled(page);
  expect(control.gets.length).toBe(getsBefore + 1);
  expect(control.gets.at(-1).href).toBe(composed.href);
  await closeDialog(page);
  await expectAugust(page);
  await expectEntries(page, [s.a1, s.a3]);
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
  await page.unroute(augustRequest);
});
