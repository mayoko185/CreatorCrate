import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/app.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { openDatabase, runMigrations } from '../../src/db.js';
import { createReleaseRepository } from '../../src/data/release-repository.js';
import { createWorkflowQueryService } from '../../src/services/workflow-query-service.js';
import {
  THREE, calendarUrl, closeDialog, closeDropdown, createCalendarFixture, dialog, enhanced, expectEntries, expectRepeated,
  openDialog, openDropdown, pageAuthority, query, settled, watch,
} from './calendar-filters-defaults-fixture.js';

// R6: while a monthless Today GET is pending (or failed), the month picker
// opens on the month the server resolves Today to — never the abandoned
// installed year — and a month chosen there keeps every other intended
// dimension. The server's "today" is injected (getReleaseCalendar's `today`
// option), so nothing depends on the wall clock. Requests are held and
// released by route interception only (no timing sleeps).

const fixture = createCalendarFixture('calendar-today-picker');
const clock = { today: '2026-11-19' };
const JULY_2031 = '2031-07';

test.beforeAll(async () => {
  // The shared fixture's app, with a Calendar query service whose today is
  // `clock.today`. Everything else is the real application.
  const { state } = fixture;
  state.root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-calendar-today-picker-'));
  state.projectsRoot = path.join(state.root, 'projects');
  const appDataRoot = path.join(state.root, 'app');
  fs.mkdirSync(state.projectsRoot);
  fs.mkdirSync(appDataRoot);
  state.db = openDatabase(path.join(state.root, 'test.db'));
  runMigrations(state.db, fileURLToPath(new URL('../../migrations', import.meta.url)));
  const { csrfPepper } = ensureAuthEnablement(appDataRoot);
  let app = null;
  const catalogue = new Proxy({}, {
    get(_target, key) {
      const service = app?.locals.projectOptionCatalogueService;
      const value = service?.[key];
      return typeof value === 'function' ? value.bind(service) : value;
    },
  });
  const base = createWorkflowQueryService({ db: state.db, projectOptionCatalogueService: catalogue });
  const workflowQueryService = {
    ...base,
    getReleaseCalendar: (month, options = {}) => base.getReleaseCalendar(month, { ...options, today: clock.today }),
  };
  app = createApp(
    { appName: 'CreatorCrate', db: state.db, projectsRoot: state.projectsRoot, previewRoot: path.join(state.root, 'previews') },
    { appDataRoot, authState: { csrfPepper }, workflowQueryService },
  );
  state.app = app;
  state.releases = createReleaseRepository(state.db);
  state.server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => state.server.once('listening', resolve));
  state.baseURL = `http://127.0.0.1:${state.server.address().port}`;
});

test.afterAll(async () => {
  await fixture.stop();
});

test.beforeEach(() => {
  clock.today = '2026-11-19';
});

function seed() {
  fixture.isolate();
  const p1 = fixture.project('Picker One', { projectType: 'comic' });
  const p2 = fixture.project('Picker Two', { projectType: 'images' });
  const p3 = fixture.project('Picker Three', { projectType: 'comic' });
  return {
    p1,
    p2,
    p3,
    // June 2026 — the reviewer's expected destination.
    u1: fixture.release(p1, 'Picker June 2026 One', { planned: '2026-06-10' }),
    u2: fixture.release(p2, 'Picker June 2026 Two', { planned: '2026-05-30', published: '2026-06-12' }),
    u3: fixture.release(p3, 'Picker June 2026 Three', { planned: '2026-06-20' }),
    // June 2031 — what the abandoned installed year would show.
    x1: fixture.release(p1, 'Picker June 2031 One', { planned: '2031-06-10' }),
    x2: fixture.release(p2, 'Picker June 2031 Two', { planned: '2031-06-11' }),
    // July 2031 — the installed month.
    j1: fixture.release(p1, 'Picker July 2031 One', { planned: '2031-07-10' }),
    j2: fixture.release(p2, 'Picker July 2031 Two', { planned: '2031-07-11' }),
    // November 2026 — Today.
    n1: fixture.release(p1, 'Picker November 2026 One', { planned: '2026-11-05' }),
    n2: fixture.release(p3, 'Picker November 2026 Three', { planned: '2026-11-25' }),
    // Year boundary: December of the Today year vs. the installed year.
    d27: fixture.release(p1, 'Picker December 2027 One', { planned: '2027-12-03' }),
    d31: fixture.release(p1, 'Picker December 2031 One', { planned: '2031-12-03' }),
  };
}

const region = (page) => page.locator('[data-calendar-live-region]');
const picker = (page) => page.locator('#calendar-month-dialog');
const monthless = (url) => !url.searchParams.has('month');

async function start(page, url) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(url);
  await enhanced(page);
}

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

async function openPicker(page) {
  await page.locator('.calendar-month-trigger').click();
  await expect(picker(page)).toBeVisible();
}

async function expectPicker(page, year, month) {
  await expect(picker(page).locator('#calendar-month-year')).toHaveValue(year);
  await expect.poll(() => picker(page).locator('#calendar-month-select input:checked')
    .evaluateAll((inputs) => inputs.map((input) => input.value))).toEqual([month]);
}

async function closePicker(page) {
  if (await picker(page).isVisible()) await page.keyboard.press('Escape');
  await expect(picker(page)).toBeHidden();
}

async function pickMonth(page, label) {
  await picker(page).locator('#calendar-month-select > summary').click();
  await picker(page).locator('#calendar-month-select label').getByText(label, { exact: true }).click();
  await settled(page);
  await closePicker(page);
}

async function checked(page, id) {
  // The empty value is Select all: no restriction.
  return page.locator(`#${id} input:checked`).evaluateAll((inputs) => inputs.map((input) => input.value).filter(Boolean));
}

test('REPRODUCTION: Today held from July 2031 → picker opens on 2026; June requests 2026-06 and the old Today never installs', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  await start(page, calendarUrl(fixture.baseURL, {
    month: JULY_2031, project: [s.p1.id, s.p2.id], type: ['comic', 'images'], status: 'all', weekStart: 'sunday',
  }));
  await expectEntries(page, [s.j1, s.j2]);

  const today = await hold(page, monthless);
  await page.locator('#calendar-today').click();
  await expect.poll(() => today.seen.length).toBe(1);
  expect(monthless(today.seen[0])).toBe(true);
  expectRepeated(today.seen[0].href, 'project', [s.p1.id, s.p2.id]);
  await expect(region(page)).toHaveAttribute('aria-busy', 'true');

  const getsBefore = control.gets.length;
  await openPicker(page);
  await expectPicker(page, '2026', '11');
  // Opening the picker neither navigates nor saves.
  expect(control.gets.length).toBe(getsBefore);
  await pickMonth(page, 'June');

  const june = control.gets.at(-1);
  expect(june.searchParams.getAll('month')).toEqual(['2026-06']);
  expectRepeated(june.href, 'project', [s.p1.id, s.p2.id]);
  expectRepeated(june.href, 'type', ['comic', 'images']);
  expect(june.searchParams.get('status')).toBe('all');
  expect(june.searchParams.get('weekStart')).toBe('sunday');
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2026-06');
  await expect(page.locator('[data-calendar-month-heading]')).toContainText('June 2026');
  expect(query(page).get('month')).toBe('2026-06');
  // June 2026 by release ID (count agrees); June 2031's releases are absent.
  await expectEntries(page, [s.u1, s.u2]);

  const installedUrl = page.url();
  await today.deliver();
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2026-06');
  expect(page.url()).toBe(installedUrl);
  await expectEntries(page, [s.u1, s.u2]);
  await openDialog(page);
  expect((await checked(page, 'calendar-project-filter')).sort()).toEqual([String(s.p1.id), String(s.p2.id)].sort());
  expect((await checked(page, 'calendar-type-filter')).sort()).toEqual(['comic', 'images']);
  expect(await checked(page, 'calendar-week-start-filter')).toEqual(['sunday']);
  await closeDialog(page);
  // Idle again: the installed month owns the picker.
  await openPicker(page);
  await expectPicker(page, '2026', '06');
  await closePicker(page);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('a failed Today keeps the Today month for the picker; a failed June keeps June; GET-only Retry installs June 2026', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  await start(page, calendarUrl(fixture.baseURL, { month: JULY_2031 }));

  let failing = true;
  const failed = (url) => url.pathname === '/calendar' && (monthless(url) || url.searchParams.get('month') === '2026-06');
  await page.route(failed, async (route) => {
    if (failing && route.request().resourceType() === 'fetch') {
      await route.fulfill({ status: 503, body: 'unavailable' });
      return;
    }
    await route.continue();
  });

  await page.locator('#calendar-today').click();
  await expect(page.locator('[data-live-filter-retry]').first()).toBeVisible();
  await expect(region(page)).toHaveAttribute('data-calendar-month', JULY_2031);
  await openPicker(page);
  await expectPicker(page, '2026', '11');
  await pickMonth(page, 'June');
  const june = control.gets.at(-1);
  expect(june.searchParams.get('month')).toBe('2026-06');
  await expect(page.locator('[data-live-filter-retry]').first()).toBeVisible();
  await expect(region(page)).toHaveAttribute('data-calendar-month', JULY_2031);
  await openPicker(page);
  await expectPicker(page, '2026', '06');
  await closePicker(page);

  failing = false;
  const getsBefore = control.gets.length;
  await page.locator('[data-live-filter-retry]').first().click();
  await settled(page);
  expect(control.gets.length).toBe(getsBefore + 1);
  expect(control.gets.at(-1).href).toBe(june.href);
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2026-06');
  await expectEntries(page, [s.u1, s.u2, s.u3]);
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
  await page.unroute(failed);
});

test('a pending Reset filters owns the picker month; June keeps the cleared filters', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  // Today's Calendar (monthless URL) with temporary restrictions.
  await start(page, calendarUrl(fixture.baseURL, { project: s.p1.id, type: 'comic', status: 'planned' }));
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2026-11');
  await expectEntries(page, [s.n1]);

  await openDialog(page);
  const reset = await hold(page, (url) => url.searchParams.get('month') === '2026-11' && !url.searchParams.has('project'));
  await dialog(page).locator('[data-calendar-filters-reset]').click();
  await expect.poll(() => reset.seen.length).toBe(1);
  await closeDialog(page);

  await openPicker(page);
  await expectPicker(page, '2026', '11');
  await pickMonth(page, 'June');
  expect([...control.gets.at(-1).searchParams.entries()]).toEqual([['month', '2026-06']]);
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2026-06');
  await expectEntries(page, [s.u1, s.u2, s.u3]);

  await reset.deliver();
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2026-06');
  await expectEntries(page, [s.u1, s.u2, s.u3]);
  await openDialog(page);
  expect(await checked(page, 'calendar-project-filter')).toEqual([]);
  expect(await checked(page, 'calendar-type-filter')).toEqual([]);
  await closeDialog(page);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('Back to an explicit month and Forward to the monthless Today entry each own the picker', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  await start(page, calendarUrl(fixture.baseURL, { month: JULY_2031 }));
  await page.locator('#calendar-today').click();
  await settled(page);
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2026-11');
  expect(query(page).has('month')).toBe(false);

  const back = await hold(page, (url) => url.searchParams.get('month') === JULY_2031);
  await page.goBack();
  await expect.poll(() => back.seen.length).toBe(1);
  await openPicker(page);
  await expectPicker(page, '2031', '07');
  await closePicker(page);
  await back.deliver();
  await expect(region(page)).toHaveAttribute('data-calendar-month', JULY_2031);
  await expectEntries(page, [s.j1, s.j2]);

  const forward = await hold(page, monthless);
  await page.goForward();
  await expect.poll(() => forward.seen.length).toBe(1);
  await openPicker(page);
  await expectPicker(page, '2026', '11');
  await pickMonth(page, 'June');
  expect(control.gets.at(-1).searchParams.get('month')).toBe('2026-06');
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2026-06');
  await expectEntries(page, [s.u1, s.u2, s.u3]);
  const installedUrl = page.url();
  await forward.deliver();
  expect(page.url()).toBe(installedUrl);
  await expectEntries(page, [s.u1, s.u2, s.u3]);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('an explicit month navigation after a held Today owns the picker month', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  await start(page, calendarUrl(fixture.baseURL, { month: JULY_2031 }));
  const today = await hold(page, monthless);
  await page.locator('#calendar-today').click();
  await expect.poll(() => today.seen.length).toBe(1);
  const next = await hold(page, (url) => url.searchParams.get('month') === '2031-08');
  await page.locator('#calendar-next').click();
  await expect.poll(() => next.seen.length).toBe(1);
  await openPicker(page);
  await expectPicker(page, '2031', '08');
  await pickMonth(page, 'December');
  expect(control.gets.at(-1).searchParams.get('month')).toBe('2031-12');
  await expectEntries(page, [s.d31]);
  await next.deliver();
  await today.deliver();
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2031-12');
  await expectEntries(page, [s.d31]);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('year boundary: Today in January 2027 → December requests 2027-12, not the installed 2031', async ({ page }) => {
  clock.today = '2027-01-15';
  const s = seed();
  const control = watch(page);
  await start(page, calendarUrl(fixture.baseURL, { month: JULY_2031 }));
  const today = await hold(page, monthless);
  await page.locator('#calendar-today').click();
  await expect.poll(() => today.seen.length).toBe(1);
  await openPicker(page);
  await expectPicker(page, '2027', '01');
  await pickMonth(page, 'December');
  expect(control.gets.at(-1).searchParams.get('month')).toBe('2027-12');
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2027-12');
  await expectEntries(page, [s.d27]);
  await today.deliver();
  await expectEntries(page, [s.d27]);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});

// C-F2: a monthless Calendar was resolved by the server when it rendered.
// Save new defaults and Reset defaults keep that DISPLAYED month even after
// the server's date has moved into the next month: their refresh (and the
// Reset defaults returnTo / refreshUrl) names it explicitly. A newer explicit
// navigation made while a mutation is pending keeps authority.

const DECEMBER_2026 = '2026-12';

function seedRollover() {
  fixture.isolate();
  const p1 = fixture.project('Rollover One', { projectType: 'comic' });
  const p2 = fixture.project('Rollover Two', { projectType: 'images' });
  return {
    p1,
    p2,
    n1: fixture.release(p1, 'Rollover November 2026 One', { planned: '2026-11-12' }),
    d1: fixture.release(p1, 'Rollover December 2026 One', { planned: '2026-12-15' }),
    d2: fixture.release(p2, 'Rollover December 2026 Two', { planned: '2026-12-18' }),
    j1: fixture.release(p1, 'Rollover January 2027 One', { planned: '2027-01-20' }),
    j2: fixture.release(p2, 'Rollover January 2027 Two', { planned: '2027-01-22' }),
  };
}

async function showDialog(page) {
  // ?defaults=1 opens Filters & Defaults on load.
  if (!(await dialog(page).isVisible())) await openDialog(page);
  await expect(dialog(page)).toBeVisible();
}

const defaultsStatus = (page) => dialog(page).locator('[data-settings-fetch-save-status]');

async function confirmResetDefaults(page) {
  await dialog(page).locator('[data-calendar-defaults-reset]').click();
  const confirmation = page.locator('#app-confirmation-dialog');
  if (await confirmation.isVisible()) await confirmation.locator('[data-app-dialog-confirmation-confirm]').click();
}

async function expectDecember(page, releases) {
  await expect(region(page)).toHaveAttribute('data-calendar-month', DECEMBER_2026);
  await expect(page.locator('[data-calendar-month-heading]')).toContainText('December 2026');
  await expectEntries(page, releases);
}

/** Holds the matching POST until delivered; the server only sees it then. */
async function holdPost(page, pathname) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let finished;
  const done = new Promise((resolve) => { finished = resolve; });
  const matcher = (url) => url.pathname === pathname;
  const seen = [];
  await page.route(matcher, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    seen.push(route.request());
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
      await page.unroute(matcher);
    },
  };
}

test('C-F2 A: Save new defaults on a monthless December 2026 Calendar keeps December after the server date reaches January 2027', async ({ page }) => {
  clock.today = '2026-12-10';
  const s = seedRollover();
  const control = watch(page);
  await start(page, `${calendarUrl(fixture.baseURL, {
    project: [s.p1.id, s.p2.id], status: 'planned', view: 'list', weekStart: 'sunday',
  })}&defaults=1`);
  expect(query(page).has('month')).toBe(false);
  await expectDecember(page, [s.d1, s.d2]);
  const historyLength = await page.evaluate(() => history.length);

  clock.today = '2027-01-05';
  await showDialog(page);
  const getsBefore = control.gets.length;
  await dialog(page).locator('[data-calendar-defaults-save]').click();
  await expect(defaultsStatus(page)).toHaveText('Defaults saved.');
  await settled(page);

  // Exactly one Save, of exactly the three shown settings.
  expect(control.defaultsPosts()).toHaveLength(1);
  const post = control.defaultsPosts()[0];
  expect(post.path).toBe('/calendar/defaults');
  expect(post.body.get('view')).toBe('list');
  expect(post.body.get('status')).toBe('planned');
  expect(post.body.get('weekStart')).toBe('sunday');
  expect(post.body.has('month')).toBe(false);
  expect(fixture.storedCalendarDefaults()).toEqual({ view: 'list', status: 'planned', weekStart: 'sunday' });

  // The one refresh GET names the displayed month; nothing resolves Today.
  expect(control.gets.length).toBe(getsBefore + 1);
  const refresh = control.gets.at(-1);
  expect(refresh.searchParams.getAll('month')).toEqual([DECEMBER_2026]);
  expectRepeated(refresh.href, 'project', [s.p1.id, s.p2.id]);
  await expectDecember(page, [s.d1, s.d2]);
  await expect(region(page)).toHaveClass(/calendar-view-list/);

  // The URL and its replaced history entry say what is shown.
  expect(query(page).getAll('month')).toEqual([DECEMBER_2026]);
  expectRepeated(page.url(), 'project', [s.p1.id, s.p2.id]);
  expect(query(page).get('status')).toBe('planned');
  expect(query(page).get('view')).toBe('list');
  expect(query(page).get('weekStart')).toBe('sunday');
  expect(query(page).get('defaults')).toBe('1');
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
  expect(control.documents).toHaveLength(1);
  expect(control.errors).toEqual([]);
});

test('C-F2 B: Reset defaults on a monthless December 2026 Calendar keeps December and the temporary Projects after the server date reaches January 2027', async ({ page }) => {
  clock.today = '2026-12-10';
  const s = seedRollover();
  fixture.writePageDefault('calendar', 'view', 'list');
  fixture.writePageDefault('calendar', 'status', 'planned');
  fixture.writePageDefault('calendar', 'weekStart', 'sunday');
  fixture.writePageDefault('releases', 'sort', 'title');
  const control = watch(page);
  await start(page, `${calendarUrl(fixture.baseURL, { project: s.p1.id })}&defaults=1`);
  expect(query(page).has('month')).toBe(false);
  await expectDecember(page, [s.d1]);
  await expect(region(page)).toHaveClass(/calendar-view-list/);
  const generation = fixture.generation();
  const historyLength = await page.evaluate(() => history.length);

  clock.today = '2027-01-05';
  await showDialog(page);
  const getsBefore = control.gets.length;
  await confirmResetDefaults(page);
  await expect(defaultsStatus(page)).toHaveText('Defaults reset to the application defaults.');
  await settled(page);

  // Exactly one Reset defaults, deleting only the Calendar keys.
  expect(control.defaultsPosts()).toHaveLength(1);
  const post = control.defaultsPosts()[0];
  expect(post.path).toBe('/calendar/defaults/reset');
  const returnTo = new URL(post.body.get('returnTo'), fixture.baseURL);
  expect(returnTo.searchParams.getAll('month')).toEqual([DECEMBER_2026]);
  expect(returnTo.searchParams.getAll('project')).toEqual([String(s.p1.id)]);
  expect(THREE.some((field) => post.body.has(field))).toBe(false);
  expect(fixture.calendarKeys()).toEqual([]);
  expect(fixture.generation()).toBe(generation + 1);
  expect(fixture.readPageDefault('releases', 'sort')).toBe('title');

  // One refresh GET, of the displayed month and the temporary Projects.
  expect(control.gets.length).toBe(getsBefore + 1);
  const refresh = control.gets.at(-1);
  expect(refresh.searchParams.getAll('month')).toEqual([DECEMBER_2026]);
  expect(refresh.searchParams.getAll('project')).toEqual([String(s.p1.id)]);
  for (const key of THREE) expect(refresh.searchParams.has(key)).toBe(false);

  // December stays; the three settings follow the application fallbacks.
  await expectDecember(page, [s.d1]);
  await expect(region(page)).toHaveClass(/calendar-view-grid/);
  expect((await pageAuthority(page)).savedKeys).toEqual([]);
  expect(query(page).getAll('month')).toEqual([DECEMBER_2026]);
  expect(query(page).getAll('project')).toEqual([String(s.p1.id)]);
  for (const key of THREE) expect(query(page).has(key)).toBe(false);
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
  expect(control.errors).toEqual([]);
});

test('C-F2 C: an explicit month navigation during a held Save keeps authority; the Save is confirmed once and never replayed', async ({ page }) => {
  clock.today = '2026-12-10';
  const s = seedRollover();
  const control = watch(page);
  await start(page, `${calendarUrl(fixture.baseURL, { project: [s.p1.id, s.p2.id] })}&defaults=1`);
  await expectDecember(page, [s.d1, s.d2]);

  clock.today = '2027-01-05';
  await showDialog(page);
  const save = await holdPost(page, '/calendar/defaults');
  const getsBefore = control.gets.length;
  await dialog(page).locator('[data-calendar-defaults-save]').click();
  await expect.poll(() => save.seen.length).toBe(1);
  await closeDialog(page);

  // Previous: an explicit November 2026 navigation installs while Save waits.
  await page.locator('#calendar-previous').click();
  await settled(page);
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2026-11');
  await expectEntries(page, [s.n1]);
  const navigatedUrl = page.url();
  expect(query(page).getAll('month')).toEqual(['2026-11']);

  await save.deliver();
  await showDialog(page);
  await expect(defaultsStatus(page)).toHaveText('Defaults saved.');
  await settled(page);
  expect(control.defaultsPosts()).toHaveLength(1);
  expect(fixture.calendarKeys()).toHaveLength(3);
  // The confirmed Save refreshes the newer navigation, never December or Today.
  expect(control.gets.at(-1).searchParams.getAll('month')).toEqual(['2026-11']);
  expect(control.gets.slice(getsBefore).every((url) => url.searchParams.get('month') === '2026-11')).toBe(true);
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2026-11');
  await expectEntries(page, [s.n1]);
  expect(page.url()).toBe(navigatedUrl);
  await closeDialog(page);
  expect(control.errors).toEqual([]);
});

test('C-F2 C: an explicit month navigation during a held Reset defaults refresh wins over the late December refresh', async ({ page }) => {
  clock.today = '2026-12-10';
  const s = seedRollover();
  fixture.writePageDefault('calendar', 'weekStart', 'sunday');
  const control = watch(page);
  await start(page, `${calendarUrl(fixture.baseURL, { project: s.p1.id })}&defaults=1`);
  await expectDecember(page, [s.d1]);

  clock.today = '2027-01-05';
  await showDialog(page);
  // The refresh after the confirmed Reset: the December or a monthless GET.
  const refresh = await hold(page, (url) => monthless(url) || url.searchParams.get('month') === DECEMBER_2026);
  await confirmResetDefaults(page);
  await expect.poll(() => refresh.seen.length).toBe(1);
  expect(refresh.seen[0].searchParams.getAll('month')).toEqual([DECEMBER_2026]);
  expect(control.defaultsPosts()).toHaveLength(1);
  expect(fixture.calendarKeys()).toEqual([]);
  await closeDialog(page);

  await page.locator('#calendar-previous').click();
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2026-11');
  await settled(page);
  await expectEntries(page, [s.n1]);
  const navigatedUrl = page.url();
  expect(query(page).getAll('month')).toEqual(['2026-11']);
  expectRepeated(navigatedUrl, 'project', [s.p1.id]);

  await refresh.deliver();
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2026-11');
  await expectEntries(page, [s.n1]);
  expect(page.url()).toBe(navigatedUrl);
  await showDialog(page);
  await expect(defaultsStatus(page)).toHaveText('Defaults reset to the application defaults.');
  await closeDialog(page);
  // Never replayed.
  expect(control.defaultsPosts()).toHaveLength(1);
  expect(control.errors).toEqual([]);
});

// C-F1: November 2026 is rendered on December 31, 2026, so its
// data-calendar-current-month is 2026-12. The server's date then reaches
// January 1, 2027. A month picked while Today is pending must not take its
// year from that stale installed metadata: one read-only Calendar GET (the
// displayed month) reads the server's current month, and the picked month
// navigates in THAT year. The lookup is counted separately from the one user
// navigation the pick makes.

const NOVEMBER_2026 = '2026-11';

function seedServerYear() {
  fixture.isolate();
  const p1 = fixture.project('Server Year One', { projectType: 'comic' });
  const p2 = fixture.project('Server Year Two', { projectType: 'images' });
  const p3 = fixture.project('Server Year Three', { projectType: 'comic' });
  return {
    p1,
    p2,
    p3,
    o1: fixture.release(p1, 'Server Year October 2026 One', { planned: '2026-10-08' }),
    n1: fixture.release(p1, 'Server Year November 2026 One', { planned: '2026-11-05' }),
    n2: fixture.release(p2, 'Server Year November 2026 Two', { planned: '2026-11-15' }),
    // The stale year's June: what the defect showed.
    s1: fixture.release(p1, 'Server Year June 2026 One', { planned: '2026-06-10' }),
    s2: fixture.release(p2, 'Server Year June 2026 Two', { planned: '2026-06-12' }),
    // The server year's June: the expected destination.
    y1: fixture.release(p1, 'Server Year June 2027 One', { planned: '2027-06-10' }),
    y2: fixture.release(p2, 'Server Year June 2027 Two', { planned: '2027-05-30', published: '2027-06-12' }),
    y3: fixture.release(p3, 'Server Year June 2027 Three', { planned: '2027-06-20' }),
    a1: fixture.release(p1, 'Server Year August 2027 One', { planned: '2027-08-10' }),
    k1: fixture.release(p1, 'Server Year January 2027 One', { planned: '2027-01-20' }),
    z1: fixture.release(p1, 'Server Year June 2030 One', { planned: '2030-06-10' }),
  };
}

// The server-year lookup: exactly the displayed month, nothing else.
const isLookup = (url) => url.pathname === '/calendar'
  && [...url.searchParams.keys()].length === 1 && url.searchParams.get('month') === NOVEMBER_2026;
const userNavigations = (control) => control.gets.filter((url) => !isLookup(url));

/** Holds each matching live Calendar GET individually until released. */
async function holdEach(page, predicate) {
  const held = [];
  const matcher = (url) => url.pathname === '/calendar' && predicate(url);
  await page.route(matcher, async (route) => {
    if (route.request().resourceType() !== 'fetch') return route.continue();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const entry = { url: new URL(route.request().url()), release, done: null };
    entry.done = gate.then(() => route.continue().catch(() => {}));
    held.push(entry);
    await entry.done;
    return undefined;
  });
  return {
    held,
    async release(index) {
      held[index].release();
      await held[index].done;
      await page.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)));
      }));
    },
    async releaseAll() {
      for (let index = 0; index < held.length; index += 1) await this.release(index);
      await page.unroute(matcher);
    },
  };
}

/** Chooses a month in the open picker without waiting for Calendar to settle. */
async function chooseMonth(page, label) {
  await picker(page).locator('#calendar-month-select > summary').click();
  await picker(page).locator('#calendar-month-select label').getByText(label, { exact: true }).click();
  await closePicker(page);
}

async function startNovemberOnDecember31(page, s, extra = {}) {
  clock.today = '2026-12-31';
  const params = {
    month: NOVEMBER_2026, project: [s.p1.id, s.p2.id], type: ['comic', 'images'], status: 'all', weekStart: 'sunday', ...extra,
  };
  Object.keys(params).forEach((key) => { if (params[key] === undefined) delete params[key]; });
  await start(page, calendarUrl(fixture.baseURL, params));
  await expect(region(page)).toHaveAttribute('data-calendar-month', NOVEMBER_2026);
  await expect(region(page)).toHaveAttribute('data-calendar-current-month', '2026-12');
  await expectEntries(page, [s.n1, s.n2]);
  // Today is enabled on the November view.
  await expect(page.locator('#calendar-today')).toBeVisible();
  // The server's date moves on.
  clock.today = '2027-01-01';
}

async function expectSelectedFilters(page, s) {
  await openDialog(page);
  expect((await checked(page, 'calendar-project-filter')).sort()).toEqual([String(s.p1.id), String(s.p2.id)].sort());
  expect((await checked(page, 'calendar-type-filter')).sort()).toEqual(['comic', 'images']);
  expect(await checked(page, 'calendar-week-start-filter')).toEqual(['sunday']);
  await closeDialog(page);
}

test('C-F1 REPRODUCTION: Today held across the server year change → June resolves 2027 by lookup, shows June 2027 before Today returns', async ({ page }) => {
  const s = seedServerYear();
  const control = watch(page);
  await startNovemberOnDecember31(page, s);
  const startUrl = page.url();
  const historyLength = await page.evaluate(() => history.length);

  const today = await hold(page, monthless);
  await page.locator('#calendar-today').click();
  await expect.poll(() => today.seen.length).toBe(1);
  expect(monthless(today.seen[0])).toBe(true);
  expectRepeated(today.seen[0].href, 'project', [s.p1.id, s.p2.id]);

  await openPicker(page);
  // The stale installed hint (December 2026) is shown, never trusted.
  await expectPicker(page, '2026', '12');
  const getsBefore = control.gets.length;
  const lookupResponse = page.waitForResponse((response) => isLookup(new URL(response.url())));
  await chooseMonth(page, 'June');

  // The independent lookup ran while Today is still held.
  const lookup = await lookupResponse;
  expect(lookup.status()).toBe(200);
  expect(await lookup.text()).toContain('data-calendar-current-month="2027-01"');
  expect(today.seen).toHaveLength(1);

  // June 2027 is visible BEFORE the older Today response is released.
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2027-06');
  await expect(page.locator('[data-calendar-month-heading]')).toContainText('June 2027');
  await settled(page);
  await expectEntries(page, [s.y1, s.y2]);
  expect(query(page).getAll('month')).toEqual(['2027-06']);

  const after = control.gets.slice(getsBefore);
  expect(after.filter(isLookup)).toHaveLength(1);
  const picks = after.filter((url) => !isLookup(url));
  expect(picks).toHaveLength(1);
  const june = picks[0];
  expect(june.searchParams.getAll('month')).toEqual(['2027-06']);
  expectRepeated(june.href, 'project', [s.p1.id, s.p2.id]);
  expectRepeated(june.href, 'type', ['comic', 'images']);
  expect(june.searchParams.get('status')).toBe('all');
  expect(june.searchParams.get('weekStart')).toBe('sunday');
  expect(control.gets.some((url) => url.searchParams.get('month') === '2026-06')).toBe(false);

  const installedUrl = page.url();
  await today.deliver();
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2027-06');
  await expectEntries(page, [s.y1, s.y2]);
  expect(page.url()).toBe(installedUrl);
  expect(new URL(installedUrl).searchParams.getAll('month')).toEqual(['2027-06']);
  expectRepeated(installedUrl, 'project', [s.p1.id, s.p2.id]);
  expectRepeated(installedUrl, 'type', ['comic', 'images']);
  // One history entry, for June 2027: Today never pushed; the lookup never did.
  expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);
  // Exactly one user navigation from the pick, after the superseded Today.
  expect(userNavigations(control).map((url) => url.searchParams.get('month'))).toEqual([null, '2027-06']);

  await expectSelectedFilters(page, s);
  await openPicker(page);
  await expectPicker(page, '2027', '06');
  await closePicker(page);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.posts).toEqual([]);
  expect(control.documents).toHaveLength(1);
  expect(control.errors).toEqual([]);

  // Back returns to the November 2026 entry.
  await page.goBack();
  await expect(region(page)).toHaveAttribute('data-calendar-month', NOVEMBER_2026);
  await settled(page);
  expect(page.url()).toBe(startUrl);
  await expectEntries(page, [s.n1, s.n2]);
});

test('C-F1 A: a second pick while the first lookup is held wins; the older lookup never navigates', async ({ page }) => {
  const s = seedServerYear();
  const control = watch(page);
  await startNovemberOnDecember31(page, s);
  const today = await hold(page, monthless);
  await page.locator('#calendar-today').click();
  await expect.poll(() => today.seen.length).toBe(1);
  const lookups = await holdEach(page, isLookup);

  await openPicker(page);
  await chooseMonth(page, 'June');
  await expect.poll(() => lookups.held.length).toBe(1);
  await openPicker(page);
  // The waiting choice, on the still-unconfirmed year.
  await expectPicker(page, '2026', '06');
  await chooseMonth(page, 'August');
  await expect.poll(() => lookups.held.length).toBe(2);

  await lookups.release(1);
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2027-08');
  await settled(page);
  await expectEntries(page, [s.a1]);
  const installedUrl = page.url();
  await lookups.release(0);
  await today.deliver();
  await lookups.releaseAll();
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2027-08');
  await expectEntries(page, [s.a1]);
  expect(page.url()).toBe(installedUrl);
  const picks = userNavigations(control).filter((url) => url.searchParams.has('month') && url.searchParams.get('month') !== NOVEMBER_2026);
  expect(picks.map((url) => url.searchParams.get('month'))).toEqual(['2027-08']);
  await expectSelectedFilters(page, s);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('C-F1 B: Back and Forward supersede a held lookup; its late answer never navigates', async ({ page }) => {
  const s = seedServerYear();
  const control = watch(page);
  clock.today = '2026-12-31';
  await start(page, calendarUrl(fixture.baseURL, { month: '2026-10' }));
  await page.locator('#calendar-next').click();
  await settled(page);
  await expect(region(page)).toHaveAttribute('data-calendar-month', NOVEMBER_2026);
  await expect(region(page)).toHaveAttribute('data-calendar-current-month', '2026-12');
  clock.today = '2027-01-01';

  const today = await hold(page, monthless);
  await page.locator('#calendar-today').click();
  await expect.poll(() => today.seen.length).toBe(1);
  const lookups = await holdEach(page, isLookup);
  await openPicker(page);
  await chooseMonth(page, 'June');
  await expect.poll(() => lookups.held.length).toBe(1);

  await page.goBack();
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2026-10');
  await settled(page);
  await expectEntries(page, [s.o1]);
  await lookups.releaseAll();
  await today.deliver();
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2026-10');
  expect(query(page).get('month')).toBe('2026-10');

  await page.goForward();
  await expect(region(page)).toHaveAttribute('data-calendar-month', NOVEMBER_2026);
  await settled(page);
  expect(query(page).get('month')).toBe(NOVEMBER_2026);
  expect(control.gets.some((url) => ['2026-06', '2027-06'].includes(url.searchParams.get('month')))).toBe(false);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('C-F1 C: a failed lookup keeps November and never guesses a year; GET-only Retry resolves June 2027', async ({ page }) => {
  const s = seedServerYear();
  const control = watch(page);
  await startNovemberOnDecember31(page, s);
  const today = await hold(page, monthless);
  await page.locator('#calendar-today').click();
  await expect.poll(() => today.seen.length).toBe(1);

  let failing = true;
  const lookupMatcher = (url) => isLookup(url);
  await page.route(lookupMatcher, async (route) => {
    if (failing && route.request().resourceType() === 'fetch') {
      await route.fulfill({ status: 503, contentType: 'text/html', body: '<p>unavailable</p>' });
      return;
    }
    await route.continue();
  });

  const historyLength = await page.evaluate(() => history.length);
  const urlBefore = page.url();
  await openPicker(page);
  await chooseMonth(page, 'June');
  const retry = page.locator('[data-live-filter-retry]');
  await expect(retry).toHaveCount(1);
  await expect(retry).toBeVisible();
  await expect(page.locator('[data-live-filter-failure]')).toContainText("current year couldn't be confirmed");
  await settled(page);
  await expect(region(page)).toHaveAttribute('data-calendar-month', NOVEMBER_2026);
  await expectEntries(page, [s.n1, s.n2]);
  expect(page.url()).toBe(urlBefore);

  // The superseded Today cannot install either.
  await today.deliver();
  await expect(region(page)).toHaveAttribute('data-calendar-month', NOVEMBER_2026);
  expect(page.url()).toBe(urlBefore);
  expect(control.gets.some((url) => ['2026-06', '2027-06'].includes(url.searchParams.get('month')))).toBe(false);

  failing = false;
  const getsBefore = control.gets.length;
  await retry.click();
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2027-06');
  await settled(page);
  await expectEntries(page, [s.y1, s.y2]);
  const retried = control.gets.slice(getsBefore);
  expect(retried.filter(isLookup)).toHaveLength(1);
  expect(retried.filter((url) => !isLookup(url)).map((url) => url.searchParams.get('month'))).toEqual(['2027-06']);
  await expect(page.locator('[data-live-filter-failure]')).toHaveCount(0);
  expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);
  await expectSelectedFilters(page, s);
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
  await page.unroute(lookupMatcher);
});

test('C-F1 D: a typed Year is explicit: June 2030 is requested at once, with no lookup', async ({ page }) => {
  const s = seedServerYear();
  const control = watch(page);
  await startNovemberOnDecember31(page, s);
  const today = await hold(page, monthless);
  await page.locator('#calendar-today').click();
  await expect.poll(() => today.seen.length).toBe(1);
  const getsBefore = control.gets.length;

  await openPicker(page);
  await picker(page).locator('#calendar-month-year').fill('2030');
  await picker(page).locator('#calendar-month-year').press('Enter');
  await closePicker(page);
  await openPicker(page);
  await expectPicker(page, '2030', '12');
  await chooseMonth(page, 'June');
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2030-06');
  await settled(page);
  await expectEntries(page, [s.z1]);
  await today.deliver();
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2030-06');
  const after = control.gets.slice(getsBefore);
  expect(after.filter(isLookup)).toEqual([]);
  expect(after.at(-1).searchParams.getAll('month')).toEqual(['2030-06']);
  expectRepeated(after.at(-1).href, 'project', [s.p1.id, s.p2.id]);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});

test.describe('C-F1 E: browser time zone and clock never decide the year', () => {
  // Pago Pago is UTC-11: when the server is on January 1, 2027, this
  // browser's own clock still reads December 31, 2026.
  test.use({ timezoneId: 'Pacific/Pago_Pago' });

  test('a browser still on December 31, 2026 picks June in the server\'s 2027', async ({ page }) => {
    const s = seedServerYear();
    const control = watch(page);
    await page.clock.setFixedTime(new Date('2027-01-01T10:30:00Z'));
    await startNovemberOnDecember31(page, s);
    expect(await page.evaluate(() => {
      const now = new Date();
      return [Intl.DateTimeFormat().resolvedOptions().timeZone, now.getFullYear(), now.getMonth() + 1, now.getDate()];
    })).toEqual(['Pacific/Pago_Pago', 2026, 12, 31]);

    const today = await hold(page, monthless);
    await page.locator('#calendar-today').click();
    await expect.poll(() => today.seen.length).toBe(1);
    await openPicker(page);
    await chooseMonth(page, 'June');
    await expect(region(page)).toHaveAttribute('data-calendar-month', '2027-06');
    await settled(page);
    await expectEntries(page, [s.y1, s.y2]);
    await today.deliver();
    await expect(region(page)).toHaveAttribute('data-calendar-month', '2027-06');
    expect(control.gets.filter(isLookup)).toHaveLength(1);
    expect(control.gets.some((url) => url.searchParams.get('month') === '2026-06')).toBe(false);
    expect(control.errors).toEqual([]);
  });
});

test('C-F1 F: Save is refused and Reset defaults keeps the picked month while the lookup is held; one POST, never replayed', async ({ page }) => {
  const s = seedServerYear();
  fixture.writePageDefault('calendar', 'status', 'planned');
  const control = watch(page);
  await startNovemberOnDecember31(page, s, { status: undefined });
  const generation = fixture.generation();
  const today = await hold(page, monthless);
  await page.locator('#calendar-today').click();
  await expect.poll(() => today.seen.length).toBe(1);
  const lookups = await holdEach(page, isLookup);
  await openPicker(page);
  await chooseMonth(page, 'June');
  await expect.poll(() => lookups.held.length).toBe(1);

  await showDialog(page);
  // Calendar is still loading: Save new defaults posts nothing.
  await dialog(page).locator('[data-calendar-defaults-save]').click();
  await expect(defaultsStatus(page)).toHaveText('Calendar is still loading. Save again when it has finished.');
  expect(control.defaultsPosts()).toEqual([]);

  const getsBefore = control.gets.length;
  await confirmResetDefaults(page);
  await expect.poll(() => control.defaultsPosts().length).toBe(1);
  const post = control.defaultsPosts()[0];
  expect(post.path).toBe('/calendar/defaults/reset');
  // returnTo: the pending picked intent (its month is the lookup's).
  const returnTo = new URL(post.body.get('returnTo'), fixture.baseURL);
  expect(returnTo.searchParams.has('month')).toBe(false);
  expectRepeated(returnTo.href, 'project', [s.p1.id, s.p2.id]);
  await expect.poll(() => fixture.calendarKeys()).toEqual([]);
  expect(fixture.generation()).toBe(generation + 1);
  // The confirmed refresh joined the held lookup: no other GET was sent.
  expect(control.gets.slice(getsBefore)).toEqual([]);

  await lookups.releaseAll();
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2027-06');
  await settled(page);
  await expect(defaultsStatus(page)).toHaveText('Defaults reset to the application defaults.');
  const refresh = control.gets.slice(getsBefore).filter((url) => !isLookup(url));
  expect(refresh).toHaveLength(1);
  expect(refresh[0].searchParams.getAll('month')).toEqual(['2027-06']);
  expectRepeated(refresh[0].href, 'project', [s.p1.id, s.p2.id]);
  expectRepeated(refresh[0].href, 'type', ['comic', 'images']);
  for (const key of THREE) expect(refresh[0].searchParams.has(key)).toBe(false);
  await closeDialog(page);
  await today.deliver();
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2027-06');
  // status falls back to all: both June 2027 releases of Projects 1 and 2.
  await expectEntries(page, [s.y1, s.y2]);
  expect(query(page).getAll('month')).toEqual(['2027-06']);
  expect(control.defaultsPosts()).toHaveLength(1);
  expect(control.errors).toEqual([]);
});

// C-F1 P2 / P3 (correction round 2): a picked month still waiting for — or
// failed to get — its server year survives a later filter edit (P2) and a
// saved release edit's refresh that adopted the lookup and then failed (P3).

/** Edits Status in the visible Filters & Defaults dialog without waiting for Calendar to settle. */
async function chooseStatusUnsettled(page, label) {
  await openDialog(page);
  const status = await openDropdown(page, 'calendar-status-filter');
  await status.locator('.asset-filter-multiselect-option label').getByText(label, { exact: true }).click();
  await closeDropdown(page, 'calendar-status-filter');
  await closeDialog(page);
}

function expectPlannedJune(url, s) {
  const target = new URL(url);
  expect(target.searchParams.getAll('month')).toEqual(['2027-06']);
  expect(target.searchParams.getAll('status')).toEqual(['planned']);
  expectRepeated(target.href, 'project', [s.p1.id, s.p2.id]);
  expectRepeated(target.href, 'type', ['comic', 'images']);
  expect(target.searchParams.getAll('weekStart')).toEqual(['sunday']);
}

test('C-F1 P2: a Status edit while the June lookup is held keeps June; one June 2027 navigation with Planned', async ({ page }) => {
  const s = seedServerYear();
  const control = watch(page);
  await startNovemberOnDecember31(page, s);
  const startUrl = page.url();
  const historyLength = await page.evaluate(() => history.length);
  const today = await hold(page, monthless);
  await page.locator('#calendar-today').click();
  await expect.poll(() => today.seen.length).toBe(1);
  const lookups = await holdEach(page, isLookup);
  await openPicker(page);
  await chooseMonth(page, 'June');
  await expect.poll(() => lookups.held.length).toBe(1);

  await chooseStatusUnsettled(page, 'Planned');
  // The edit runs a fresh lookup under the newer intent; no monthless GET.
  await expect.poll(() => lookups.held.length).toBe(2);
  expect(today.seen).toHaveLength(1);
  await expect(region(page)).toHaveAttribute('data-calendar-month', NOVEMBER_2026);
  expect(page.url()).toBe(startUrl);

  await lookups.release(1);
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2027-06');
  await expect(page.locator('[data-calendar-month-heading]')).toContainText('June 2027');
  await settled(page);
  await expectEntries(page, [s.y1]);
  expectPlannedJune(page.url(), s);
  const installedUrl = page.url();

  // The superseded lookup and Today answer late: neither installs.
  await lookups.release(0);
  await today.deliver();
  await lookups.releaseAll();
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2027-06');
  await expectEntries(page, [s.y1]);
  expect(page.url()).toBe(installedUrl);
  expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);
  // The user navigations: the superseded Today, then June 2027 with Planned.
  const navigations = userNavigations(control);
  expect(navigations.map((url) => url.searchParams.get('month'))).toEqual([null, '2027-06']);
  expectPlannedJune(navigations[1].href, s);
  expect(control.gets.some((url) => url.searchParams.get('month') === '2026-06')).toBe(false);
  expect(control.gets.filter(isLookup)).toHaveLength(2);

  await openDialog(page);
  expect(await checked(page, 'calendar-status-filter')).toEqual(['planned']);
  await closeDialog(page);
  await expectSelectedFilters(page, s);
  await openPicker(page);
  await expectPicker(page, '2027', '06');
  await closePicker(page);
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('C-F1 P2: a Status edit after a failed June lookup keeps June; the newer lookup resolves 2027; no stale notice', async ({ page }) => {
  const s = seedServerYear();
  const control = watch(page);
  await startNovemberOnDecember31(page, s);
  const historyLength = await page.evaluate(() => history.length);
  const today = await hold(page, monthless);
  await page.locator('#calendar-today').click();
  await expect.poll(() => today.seen.length).toBe(1);

  let failing = true;
  const lookupMatcher = (url) => isLookup(url);
  await page.route(lookupMatcher, async (route) => {
    if (failing && route.request().resourceType() === 'fetch') {
      await route.fulfill({ status: 503, contentType: 'text/html', body: '<p>unavailable</p>' });
      return;
    }
    await route.continue();
  });
  await openPicker(page);
  await chooseMonth(page, 'June');
  await expect(page.locator('[data-live-filter-failure]')).toContainText("current year couldn't be confirmed");
  await expect(page.locator('[data-live-filter-retry]')).toHaveCount(1);
  await settled(page);
  await expect(region(page)).toHaveAttribute('data-calendar-month', NOVEMBER_2026);

  failing = false;
  const getsBefore = control.gets.length;
  await chooseStatusUnsettled(page, 'Planned');
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2027-06');
  await settled(page);
  await expectEntries(page, [s.y1]);
  expectPlannedJune(page.url(), s);
  await expect(page.locator('[data-live-filter-failure]')).toHaveCount(0);
  await expect(page.locator('[data-live-filter-retry]')).toHaveCount(0);
  const after = control.gets.slice(getsBefore);
  expect(after.filter(isLookup)).toHaveLength(1);
  const picks = after.filter((url) => !isLookup(url));
  expect(picks).toHaveLength(1);
  expectPlannedJune(picks[0].href, s);

  const installedUrl = page.url();
  await today.deliver();
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2027-06');
  expect(page.url()).toBe(installedUrl);
  expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);
  // Never the installed or browser-local year.
  expect(control.gets.some((url) => url.searchParams.get('month') === '2026-06')).toBe(false);
  await expectSelectedFilters(page, s);
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
  await page.unroute(lookupMatcher);
});

test('C-F1 P3: a saved release edit adopts the June lookup; the lookup fails 503; Retry refresh resolves June 2027 without reposting', async ({ page }) => {
  const s = seedServerYear();
  const control = watch(page);
  await startNovemberOnDecember31(page, s);
  const startUrl = page.url();
  const historyLength = await page.evaluate(() => history.length);
  const today = await hold(page, monthless);
  await page.locator('#calendar-today').click();
  await expect.poll(() => today.seen.length).toBe(1);

  // Each lookup is held until the test answers it.
  const lookupRoutes = [];
  const lookupMatcher = (url) => isLookup(url);
  await page.route(lookupMatcher, async (route) => {
    if (route.request().resourceType() !== 'fetch') return route.continue();
    lookupRoutes.push(route);
    return undefined;
  });
  await openPicker(page);
  await chooseMonth(page, 'June');
  await expect.poll(() => lookupRoutes.length).toBe(1);

  // A real edit of a visible November release.
  const editDialog = page.locator('#release-edit-dialog');
  await page.locator(`[data-calendar-info-trigger][aria-controls="calendar-info-grid-${s.n1.id}"]`).click();
  await page.locator(`#calendar-info-grid-${s.n1.id} [data-release-edit-id="${s.n1.id}"]`).click();
  await expect(editDialog).toBeVisible();
  await expect(editDialog.locator('button[data-dialog-submit]')).toBeEnabled();
  await editDialog.locator('input[name="title"]').fill('Server Year November 2026 One edited');
  const getsBefore = control.gets.length;
  await editDialog.locator('button[data-dialog-submit]').click();
  await expect(editDialog).toBeHidden();
  await expect.poll(() => control.posts.length).toBe(1);
  expect(control.posts[0].path).toBe(`/releases/${s.n1.id}`);
  expect(fixture.state.db.prepare('SELECT title FROM releases WHERE id = ?').get(s.n1.id).title)
    .toBe('Server Year November 2026 One edited');
  // The refresh adopted the held lookup: no other Calendar GET was sent.
  expect(control.gets.slice(getsBefore)).toEqual([]);

  await lookupRoutes[0].fulfill({ status: 503, contentType: 'text/html', body: '<p>unavailable</p>' });
  const feedback = page.locator('[data-dialog-feedback]');
  await expect(feedback).toContainText('Release saved, but Calendar could not refresh.');
  const retry = feedback.locator('[data-calendar-edit-refresh-retry]');
  await expect(retry).toBeVisible();
  await settled(page);
  await expect(region(page)).toHaveAttribute('data-calendar-month', NOVEMBER_2026);
  expect(page.url()).toBe(startUrl);

  const retryGets = control.gets.length;
  await retry.click();
  // A fresh read-only lookup; never the installed November.
  await expect.poll(() => lookupRoutes.length).toBe(2);
  expect(control.gets.slice(retryGets).filter((url) => !isLookup(url))).toEqual([]);
  await lookupRoutes[1].continue();
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2027-06');
  await settled(page);
  await expect(feedback).toContainText('Release updated.');
  await expect(retry).toHaveCount(0);
  await expectEntries(page, [s.y1, s.y2]);
  const retried = control.gets.slice(retryGets);
  expect(retried.filter(isLookup)).toHaveLength(1);
  const picks = retried.filter((url) => !isLookup(url));
  expect(picks.map((url) => url.searchParams.get('month'))).toEqual(['2027-06']);
  expectRepeated(picks[0].href, 'project', [s.p1.id, s.p2.id]);
  expectRepeated(picks[0].href, 'type', ['comic', 'images']);
  expect(picks[0].searchParams.get('status')).toBe('all');
  expect(picks[0].searchParams.get('weekStart')).toBe('sunday');
  const installedUrl = page.url();
  expect(new URL(installedUrl).searchParams.getAll('month')).toEqual(['2027-06']);

  // The superseded Today answers late and cannot install.
  await today.deliver();
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2027-06');
  expect(page.url()).toBe(installedUrl);
  // The picked month's one history entry.
  expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);
  // Exactly one release POST: Retry refresh never replays the save.
  expect(control.posts).toHaveLength(1);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.gets.some((url) => url.searchParams.get('month') === '2026-06')).toBe(false);
  await expectSelectedFilters(page, s);
  expect(control.errors).toEqual([]);
  await page.unroute(lookupMatcher);
});

// Calendar P2 authority corrections. November 2026 (Grid, the fallback View)
// is rendered on December 31, 2026; the server then reaches January 1, 2027.
// P2-A: a toolbar View choice made while a picked June waits for (or failed
// to get) its server year is kept by a later Status edit. P2-B: a picked June
// whose release-adopted lookup failed is not silently discarded by Save new
// defaults (refused by the failed-load guard) or Reset defaults (one POST; a
// fresh lookup installs June).

const listViewLink = (page) => page.locator('.calendar-view-switcher a[aria-label="List view"]');
const releasePosts = (control) => control.posts.filter((post) => post.path.startsWith('/releases/'));

/** Holds every server-year lookup; the test answers each route itself. */
async function heldLookups(page) {
  const routes = [];
  const matcher = (url) => isLookup(url);
  await page.route(matcher, async (route) => {
    if (route.request().resourceType() !== 'fetch') return route.continue();
    routes.push(route);
    return undefined;
  });
  return {
    routes,
    fail: (index) => routes[index].fulfill({ status: 503, contentType: 'text/html', body: '<p>unavailable</p>' }),
    answer: (index) => routes[index].continue().catch(() => {}),
    stop: () => page.unroute(matcher),
  };
}

async function todayHeldThenJune(page, lookups) {
  const today = await hold(page, monthless);
  await page.locator('#calendar-today').click();
  await expect.poll(() => today.seen.length).toBe(1);
  await openPicker(page);
  await chooseMonth(page, 'June');
  await expect.poll(() => lookups.routes.length).toBe(1);
  return today;
}

/** A real Edit Release save of a visible November release (one POST). */
async function saveNovemberReleaseEdit(page, control, s) {
  const editDialog = page.locator('#release-edit-dialog');
  await page.locator(`[data-calendar-info-trigger][aria-controls="calendar-info-grid-${s.n1.id}"]`).click();
  await page.locator(`#calendar-info-grid-${s.n1.id} [data-release-edit-id="${s.n1.id}"]`).click();
  await expect(editDialog).toBeVisible();
  await expect(editDialog.locator('button[data-dialog-submit]')).toBeEnabled();
  await editDialog.locator('input[name="title"]').fill('Server Year November 2026 One edited');
  const getsBefore = control.gets.length;
  await editDialog.locator('button[data-dialog-submit]').click();
  await expect(editDialog).toBeHidden();
  await expect.poll(() => releasePosts(control).length).toBe(1);
  expect(fixture.state.db.prepare('SELECT title FROM releases WHERE id = ?').get(s.n1.id).title)
    .toBe('Server Year November 2026 One edited');
  // The refresh adopted the held lookup: no other Calendar GET was sent.
  expect(control.gets.slice(getsBefore)).toEqual([]);
}

/** Today held, June picked, a release edit adopts the lookup, it fails 503. */
async function adoptedJuneFailure(page, control, s) {
  const lookups = await heldLookups(page);
  const today = await todayHeldThenJune(page, lookups);
  await saveNovemberReleaseEdit(page, control, s);
  await lookups.fail(0);
  const feedback = page.locator('[data-dialog-feedback]');
  await expect(feedback).toContainText('Release saved, but Calendar could not refresh.');
  const retry = feedback.locator('[data-calendar-edit-refresh-retry]');
  await expect(retry).toBeVisible();
  await settled(page);
  await expect(region(page)).toHaveAttribute('data-calendar-month', NOVEMBER_2026);
  return { lookups, today, feedback, retry };
}

function expectListPlannedJune(url, s) {
  expectPlannedJune(url, s);
  expect(new URL(url).searchParams.getAll('view')).toEqual(['list']);
}

async function expectInstalledListPlannedJune(page, s) {
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2027-06');
  await expect(page.locator('[data-calendar-month-heading]')).toContainText('June 2027');
  await settled(page);
  await expect(region(page)).toHaveClass(/calendar-view-list/);
  await expectEntries(page, [s.y1]);
  expectListPlannedJune(page.url(), s);
}

test('P2-A: Today held, June, lookup held, toolbar List, Status Planned installs June 2027 in List with every filter', async ({ page }) => {
  const s = seedServerYear();
  const control = watch(page);
  await startNovemberOnDecember31(page, s);
  await expect(region(page)).toHaveClass(/calendar-view-grid/);
  const startUrl = page.url();
  const historyLength = await page.evaluate(() => history.length);
  const lookups = await heldLookups(page);
  const today = await todayHeldThenJune(page, lookups);

  await listViewLink(page).click();
  // A fresh lookup owns the List intent; nothing else navigated.
  await expect.poll(() => lookups.routes.length).toBe(2);
  expect(page.url()).toBe(startUrl);
  await chooseStatusUnsettled(page, 'Planned');
  await expect.poll(() => lookups.routes.length).toBe(3);
  await expect(region(page)).toHaveAttribute('data-calendar-month', NOVEMBER_2026);
  expect(userNavigations(control).map((url) => url.searchParams.get('month'))).toEqual([null]);

  await lookups.answer(2);
  await expectInstalledListPlannedJune(page, s);
  const installedUrl = page.url();

  // The superseded lookups and Today answer late: none installs or reverts View.
  await lookups.answer(0);
  await lookups.answer(1);
  await today.deliver();
  await settled(page);
  await expect(region(page)).toHaveClass(/calendar-view-list/);
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2027-06');
  expect(page.url()).toBe(installedUrl);
  expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);
  const navigations = userNavigations(control);
  expect(navigations.map((url) => url.searchParams.get('month'))).toEqual([null, '2027-06']);
  expectListPlannedJune(navigations[1].href, s);
  expect(control.gets.some((url) => url.searchParams.get('month') === '2026-06')).toBe(false);
  await openDialog(page);
  expect(await checked(page, 'calendar-status-filter')).toEqual(['planned']);
  await closeDialog(page);
  await expectSelectedFilters(page, s);
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
  await lookups.stop();
});

test('P2-A: a failed standalone June lookup, toolbar List, Status Planned installs June 2027 in List', async ({ page }) => {
  const s = seedServerYear();
  const control = watch(page);
  await startNovemberOnDecember31(page, s);
  const historyLength = await page.evaluate(() => history.length);
  const lookups = await heldLookups(page);
  const today = await todayHeldThenJune(page, lookups);
  await lookups.fail(0);
  await expect(page.locator('[data-live-filter-retry]')).toHaveCount(1);
  await settled(page);

  await listViewLink(page).click();
  await expect.poll(() => lookups.routes.length).toBe(2);
  await expect(page.locator('[data-live-filter-failure]')).toHaveCount(0);
  await chooseStatusUnsettled(page, 'Planned');
  await expect.poll(() => lookups.routes.length).toBe(3);
  await lookups.answer(2);
  await expectInstalledListPlannedJune(page, s);
  await lookups.answer(1);
  await today.deliver();
  await settled(page);
  await expect(region(page)).toHaveClass(/calendar-view-list/);
  expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);
  expect(userNavigations(control).map((url) => url.searchParams.get('month'))).toEqual([null, '2027-06']);
  await expectSelectedFilters(page, s);
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
  await lookups.stop();
});

test('P2-A: a failed release-adopted June lookup, toolbar List, Status Planned installs June 2027 in List; one release POST', async ({ page }) => {
  const s = seedServerYear();
  const control = watch(page);
  await startNovemberOnDecember31(page, s);
  const historyLength = await page.evaluate(() => history.length);
  const { lookups, today, feedback } = await adoptedJuneFailure(page, control, s);

  await listViewLink(page).click();
  await expect.poll(() => lookups.routes.length).toBe(2);
  await chooseStatusUnsettled(page, 'Planned');
  await expect.poll(() => lookups.routes.length).toBe(3);
  await lookups.answer(2);
  await expectInstalledListPlannedJune(page, s);
  await expect(feedback).toContainText('Release updated.');
  await lookups.answer(1);
  await today.deliver();
  await settled(page);
  await expect(region(page)).toHaveClass(/calendar-view-list/);
  expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);
  expect(userNavigations(control).map((url) => url.searchParams.get('month'))).toEqual([null, '2027-06']);
  expect(releasePosts(control)).toHaveLength(1);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
  await lookups.stop();
});

test('P2-B Save: a failed release-adopted June lookup refuses Save new defaults; Retry refresh installs June; then Save posts once', async ({ page }) => {
  const s = seedServerYear();
  const control = watch(page);
  await startNovemberOnDecember31(page, s);
  const generation = fixture.generation();
  const historyLength = await page.evaluate(() => history.length);
  const { lookups, today, retry } = await adoptedJuneFailure(page, control, s);

  await showDialog(page);
  const getsBefore = control.gets.length;
  await dialog(page).locator('[data-calendar-defaults-save]').click();
  await expect(defaultsStatus(page)).toHaveText('The current Calendar did not load. Retry loading it before saving defaults.');
  await settled(page);
  // Nothing written; November was not refreshed; June is still the choice.
  expect(control.defaultsPosts()).toEqual([]);
  expect(fixture.calendarKeys()).toEqual([]);
  expect(fixture.generation()).toBe(generation);
  expect(control.gets.slice(getsBefore)).toEqual([]);
  await closeDialog(page);
  await openPicker(page);
  await expectPicker(page, '2026', '06');
  await closePicker(page);

  // The release Retry refresh recovers June through a fresh read-only lookup.
  await retry.click();
  await expect.poll(() => lookups.routes.length).toBe(2);
  await lookups.answer(1);
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2027-06');
  await settled(page);
  await expectEntries(page, [s.y1, s.y2]);
  await today.deliver();
  await settled(page);

  await showDialog(page);
  await dialog(page).locator('[data-calendar-defaults-save]').click();
  await expect(defaultsStatus(page)).toHaveText('Defaults saved.');
  await settled(page);
  expect(control.defaultsPosts()).toHaveLength(1);
  expect(control.defaultsPosts()[0].path).toBe('/calendar/defaults');
  expect(new URL(control.defaultsPosts()[0].body.get('returnTo'), fixture.baseURL).searchParams.getAll('month')).toEqual(['2027-06']);
  expect(fixture.calendarKeys()).toHaveLength(3);
  expect(control.gets.at(-1).searchParams.getAll('month')).toEqual(['2027-06']);
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2027-06');
  expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);
  // The release save is never replayed.
  expect(releasePosts(control)).toHaveLength(1);
  await closeDialog(page);
  expect(control.errors).toEqual([]);
  await lookups.stop();
});

test('P2-B Reset: Reset defaults during a failed release-adopted June lookup posts once; a fresh lookup installs June 2027', async ({ page }) => {
  const s = seedServerYear();
  fixture.writePageDefault('calendar', 'status', 'planned');
  fixture.writePageDefault('releases', 'sort', 'title');
  const control = watch(page);
  await startNovemberOnDecember31(page, s, { status: undefined });
  const generation = fixture.generation();
  const historyLength = await page.evaluate(() => history.length);
  const { lookups, today, feedback } = await adoptedJuneFailure(page, control, s);

  await showDialog(page);
  const getsBefore = control.gets.length;
  await confirmResetDefaults(page);
  await expect.poll(() => control.defaultsPosts().length).toBe(1);
  const post = control.defaultsPosts()[0];
  expect(post.path).toBe('/calendar/defaults/reset');
  // returnTo is the failed June intent: monthless, with its temporary filters.
  const returnTo = new URL(post.body.get('returnTo'), fixture.baseURL);
  expect(returnTo.searchParams.has('month')).toBe(false);
  expectRepeated(returnTo.href, 'project', [s.p1.id, s.p2.id]);
  expectRepeated(returnTo.href, 'type', ['comic', 'images']);
  await expect.poll(() => fixture.calendarKeys()).toEqual([]);
  expect(fixture.generation()).toBe(generation + 1);
  expect(fixture.readPageDefault('releases', 'sort')).toBe('title');

  // A fresh read-only lookup; never the installed November.
  await expect.poll(() => lookups.routes.length).toBe(2);
  expect(control.gets.slice(getsBefore).filter((url) => !isLookup(url))).toEqual([]);
  await lookups.answer(1);
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2027-06');
  await settled(page);
  await expect(defaultsStatus(page)).toHaveText('Defaults reset to the application defaults.');
  const refresh = control.gets.slice(getsBefore).filter((url) => !isLookup(url));
  expect(refresh).toHaveLength(1);
  expect(refresh[0].searchParams.getAll('month')).toEqual(['2027-06']);
  expectRepeated(refresh[0].href, 'project', [s.p1.id, s.p2.id]);
  expectRepeated(refresh[0].href, 'type', ['comic', 'images']);
  for (const key of THREE) expect(refresh[0].searchParams.has(key)).toBe(false);
  await closeDialog(page);
  await today.deliver();
  await settled(page);
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2027-06');
  // Status falls back to all: both June 2027 releases of Projects 1 and 2.
  await expectEntries(page, [s.y1, s.y2]);
  await expect(region(page)).toHaveClass(/calendar-view-grid/);
  expect(query(page).getAll('month')).toEqual(['2027-06']);
  expectRepeated(page.url(), 'project', [s.p1.id, s.p2.id]);
  expectRepeated(page.url(), 'type', ['comic', 'images']);
  // The picked June's one history entry.
  expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);
  await expect(feedback).toContainText('Release updated.');
  // Temporary Projects / Types kept; the three settings follow the fallbacks.
  await openDialog(page);
  expect((await checked(page, 'calendar-project-filter')).sort()).toEqual([String(s.p1.id), String(s.p2.id)].sort());
  expect((await checked(page, 'calendar-type-filter')).sort()).toEqual(['comic', 'images']);
  expect(await checked(page, 'calendar-week-start-filter')).toEqual(['monday']);
  expect(await checked(page, 'calendar-status-filter')).toEqual(['all']);
  await closeDialog(page);
  expect(control.defaultsPosts()).toHaveLength(1);
  expect(releasePosts(control)).toHaveLength(1);
  expect(control.gets.some((url) => url.searchParams.get('month') === '2026-06')).toBe(false);
  expect(control.errors).toEqual([]);
  await lookups.stop();
});

test('P2-B precedence: an explicit month during a held Reset POST wins over the June recovery', async ({ page }) => {
  const s = seedServerYear();
  fixture.writePageDefault('calendar', 'weekStart', 'sunday');
  const control = watch(page);
  await startNovemberOnDecember31(page, s);
  const { lookups, today } = await adoptedJuneFailure(page, control, s);

  await showDialog(page);
  const reset = await holdPost(page, '/calendar/defaults/reset');
  await confirmResetDefaults(page);
  await expect.poll(() => reset.seen.length).toBe(1);
  await closeDialog(page);
  await page.locator('#calendar-previous').click();
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2026-10');
  await settled(page);
  await expectEntries(page, [s.o1]);
  await reset.deliver();
  await showDialog(page);
  await expect(defaultsStatus(page)).toHaveText('Defaults reset to the application defaults.');
  await settled(page);
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2026-10');
  expect(query(page).getAll('month')).toEqual(['2026-10']);
  await closeDialog(page);
  await today.deliver();
  await settled(page);
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2026-10');
  expect(control.defaultsPosts()).toHaveLength(1);
  expect(releasePosts(control)).toHaveLength(1);
  // The recovery never resumed: no further lookup, no June request.
  expect(lookups.routes).toHaveLength(1);
  expect(control.gets.some((url) => ['2027-06', '2026-06'].includes(url.searchParams.get('month')))).toBe(false);
  expect(control.errors).toEqual([]);
  await lookups.stop();
});

test('P2-B precedence: an explicit month during the confirmed Reset\'s held June lookup wins', async ({ page }) => {
  const s = seedServerYear();
  fixture.writePageDefault('calendar', 'weekStart', 'sunday');
  const control = watch(page);
  await startNovemberOnDecember31(page, s);
  const { lookups, today } = await adoptedJuneFailure(page, control, s);

  await showDialog(page);
  await confirmResetDefaults(page);
  await expect.poll(() => control.defaultsPosts().length).toBe(1);
  await expect.poll(() => lookups.routes.length).toBe(2);
  await closeDialog(page);
  await page.locator('#calendar-previous').click();
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2026-10');
  await settled(page);
  await expectEntries(page, [s.o1]);
  const navigatedUrl = page.url();
  // The superseded lookup and Today answer late: neither installs.
  await lookups.answer(1);
  await today.deliver();
  await settled(page);
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2026-10');
  expect(page.url()).toBe(navigatedUrl);
  await showDialog(page);
  await expect(defaultsStatus(page)).toHaveText('Defaults reset to the application defaults.');
  await closeDialog(page);
  expect(control.defaultsPosts()).toHaveLength(1);
  expect(releasePosts(control)).toHaveLength(1);
  expect(control.gets.some((url) => ['2027-06', '2026-06'].includes(url.searchParams.get('month')))).toBe(false);
  expect(control.errors).toEqual([]);
  await lookups.stop();
});

// Calendar P3. P3-A: a release-refresh Retry belongs to the generation whose
// refresh failed; once a newer navigation owns Calendar the old Retry is
// inert (no GET, no abort of the newer request, no history or feedback
// change). P3-B: release-action feedback belongs to the latest release
// action; an older Edit's completion never replaces a newer Archive's
// confirmation.

const calendarGetsFor = (control, month) => control.gets.filter((url) => url.searchParams.get('month') === month);
const nextFrame = (page) => page.evaluate(() => new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)));
}));

test('Calendar P3-A: after a failed adopted June refresh, Next to December is held; the stale Retry refresh sends nothing and December installs', async ({ page }) => {
  const s = seedServerYear();
  const control = watch(page);
  await startNovemberOnDecember31(page, s);
  const startUrl = page.url();
  const historyLength = await page.evaluate(() => history.length);
  const { lookups, today, feedback, retry } = await adoptedJuneFailure(page, control, s);

  const december = await holdEach(page, (url) => url.searchParams.get('month') === DECEMBER_2026);
  const getsBefore = control.gets.length;
  // A captured reference to the older Retry refresh.
  const captured = await retry.elementHandle();
  await page.locator('#calendar-next').click();
  await expect.poll(() => december.held.length).toBe(1);
  // Final P3-B: the older Retry refresh is retired once December owns
  // Calendar; its captured control (and callback) is inert.
  await expect(retry).toHaveCount(0);
  expect(await captured.evaluate((node) => node.isConnected)).toBe(false);
  await captured.evaluate((node) => node.click());
  await nextFrame(page);
  // Inert: no other Calendar GET (no second December, no lookup), no change.
  expect(control.gets.slice(getsBefore).map((url) => url.searchParams.get('month'))).toEqual([DECEMBER_2026]);
  expect(december.held).toHaveLength(1);
  expect(lookups.routes).toHaveLength(1);
  await expect(feedback).toContainText('Release saved, but Calendar could not refresh.');
  await expect(region(page)).toHaveAttribute('data-calendar-month', NOVEMBER_2026);
  expect(page.url()).toBe(startUrl);
  expect(await page.evaluate(() => history.length)).toBe(historyLength);

  // The original December GET answers and installs.
  await december.release(0);
  await expect(region(page)).toHaveAttribute('data-calendar-month', DECEMBER_2026);
  await settled(page);
  await expectEntries(page, []);
  const installed = new URL(page.url());
  expect(installed.searchParams.getAll('month')).toEqual([DECEMBER_2026]);
  expectRepeated(installed.href, 'project', [s.p1.id, s.p2.id]);
  expectRepeated(installed.href, 'type', ['comic', 'images']);
  expect(installed.searchParams.get('weekStart')).toBe('sunday');
  expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);
  // The completed load ends the Edit's own stale report.
  await expect(feedback).toContainText('Release updated.');
  await expect(feedback.locator('[data-calendar-edit-refresh-retry]')).toHaveCount(0);

  // The superseded Today answers late and cannot install.
  await today.deliver();
  await expect(region(page)).toHaveAttribute('data-calendar-month', DECEMBER_2026);
  expect(page.url()).toBe(installed.href);

  // Back returns to the one November entry; nothing else was added.
  await page.evaluate(() => history.back());
  await expect(region(page)).toHaveAttribute('data-calendar-month', NOVEMBER_2026);
  await settled(page);
  expect(page.url()).toBe(startUrl);
  await expectEntries(page, [s.n1, s.n2]);

  expect(calendarGetsFor(control, DECEMBER_2026)).toHaveLength(1);
  expect(control.gets.some((url) => ['2027-06', '2026-06'].includes(url.searchParams.get('month')))).toBe(false);
  // The release save was never repeated.
  expect(releasePosts(control)).toHaveLength(1);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
  await december.releaseAll();
  await lookups.stop();
});

test('Calendar P3-B: an Edit refresh fails on the adopted June lookup; a newer Archive confirmation survives June installing', async ({ page }) => {
  const s = seedServerYear();
  const control = watch(page);
  await startNovemberOnDecember31(page, s);
  const historyLength = await page.evaluate(() => history.length);
  const { lookups, today, feedback, retry } = await adoptedJuneFailure(page, control, s);
  expect(releasePosts(control).map((post) => post.path)).toEqual([`/releases/${s.n1.id}`]);

  // Archive another visible release through the real Edit Release dialog.
  const editDialog = page.locator('#release-edit-dialog');
  await page.locator(`[data-calendar-info-trigger][aria-controls="calendar-info-grid-${s.n2.id}"]`).click();
  await page.locator(`#calendar-info-grid-${s.n2.id} [data-release-edit-id="${s.n2.id}"]`).click();
  await expect(editDialog).toBeVisible();
  const archive = editDialog.locator('[data-release-edit-action="archive"]');
  await expect(archive.locator('form')).toHaveAttribute('action', `/releases/${s.n2.id}/archive`);
  if (!(await archive.evaluate((node) => node.open))) await archive.locator('summary').click();
  await archive.locator('button[data-confirm]').click();
  await page.locator('#app-confirmation-dialog [data-app-dialog-confirmation-confirm]').click();
  await expect(editDialog).toBeHidden();
  await expect.poll(() => releasePosts(control).length).toBe(2);
  expect(releasePosts(control)[1].path).toBe(`/releases/${s.n2.id}/archive`);
  expect(s.n2.archived()).toBe(true);
  expect(s.n1.archived()).toBe(false);
  const confirmation = `Release “${s.n2.title}” archived.`;
  await expect(feedback).toContainText(confirmation);
  // The Archive's own refresh took over the June recovery: a fresh lookup.
  await expect.poll(() => lookups.routes.length).toBe(2);
  await expect(retry).toHaveCount(0);

  // June installs.
  await lookups.answer(1);
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2027-06');
  await settled(page);
  await expectEntries(page, [s.y1, s.y2]);
  // The older Edit's completion never replaces the newer confirmation.
  await expect(feedback).toContainText(confirmation);
  await expect(feedback).not.toContainText('Release updated.');
  await expect(feedback).toHaveClass(/notice--success/);

  // Late answers change nothing.
  await today.deliver();
  await nextFrame(page);
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2027-06');
  await expect(feedback).toContainText(confirmation);
  expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);

  // One Edit POST and one Archive POST, never replayed.
  expect(releasePosts(control).map((post) => post.path)).toEqual([`/releases/${s.n1.id}`, `/releases/${s.n2.id}/archive`]);
  expect(fixture.state.db.prepare('SELECT title FROM releases WHERE id = ?').get(s.n1.id).title)
    .toBe('Server Year November 2026 One edited');
  expect(s.n2.archived()).toBe(true);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.gets.some((url) => url.searchParams.get('month') === '2026-06')).toBe(false);
  expect(control.errors).toEqual([]);
  await lookups.stop();
});

// Calendar second-release-action P2: a confirmed Edit refresh adopted the
// picked June's held server-year lookup; a confirmed Archive of another
// visible release then takes over the refresh before that lookup answers.
// Archive owns the release feedback and the refresh, but it changes release
// data, not the month: June stays the navigation intent (never November).

/** Archives a visible November release through the real Edit Release dialog. */
async function archiveNovemberRelease(page, control, release) {
  const editDialog = page.locator('#release-edit-dialog');
  await page.locator(`[data-calendar-info-trigger][aria-controls="calendar-info-grid-${release.id}"]`).click();
  await page.locator(`#calendar-info-grid-${release.id} [data-release-edit-id="${release.id}"]`).click();
  await expect(editDialog).toBeVisible();
  const archive = editDialog.locator('[data-release-edit-action="archive"]');
  await expect(archive.locator('form')).toHaveAttribute('action', `/releases/${release.id}/archive`);
  if (!(await archive.evaluate((node) => node.open))) await archive.locator('summary').click();
  await archive.locator('button[data-confirm]').click();
  await page.locator('#app-confirmation-dialog [data-app-dialog-confirmation-confirm]').click();
  await expect(editDialog).toBeHidden();
  await expect.poll(() => releasePosts(control).length).toBe(2);
  expect(releasePosts(control)[1].path).toBe(`/releases/${release.id}/archive`);
  expect(release.archived()).toBe(true);
}

/** Today held, June picked (lookup held), Edit adopts it, Archive takes over. */
async function archiveDuringAdoptedJuneLookup(page, control, s) {
  const lookups = await heldLookups(page);
  const today = await todayHeldThenJune(page, lookups);
  await saveNovemberReleaseEdit(page, control, s);
  // The Edit refresh adopted the held lookup: still exactly one.
  expect(lookups.routes).toHaveLength(1);
  const getsBefore = control.gets.length;
  await archiveNovemberRelease(page, control, s.n2);
  const feedback = page.locator('[data-dialog-feedback]');
  const confirmation = `Release “${s.n2.title}” archived.`;
  await expect(feedback).toContainText(confirmation);
  // June continues as one newer lookup; no November (or any page) GET.
  await expect.poll(() => lookups.routes.length).toBe(2);
  expect(control.gets.slice(getsBefore).filter((url) => !isLookup(url))).toEqual([]);
  await expect(region(page)).toHaveAttribute('data-calendar-month', NOVEMBER_2026);
  return { lookups, today, feedback, confirmation };
}

function expectReleaseWritesOnce(control, s) {
  expect(releasePosts(control).map((post) => post.path)).toEqual([`/releases/${s.n1.id}`, `/releases/${s.n2.id}/archive`]);
  expect(fixture.state.db.prepare('SELECT title FROM releases WHERE id = ?').get(s.n1.id).title)
    .toBe('Server Year November 2026 One edited');
  expect(s.n1.archived()).toBe(false);
  expect(s.n2.archived()).toBe(true);
  expect(control.defaultsPosts()).toEqual([]);
}

test('Second release action REPRODUCTION: Archive during the Edit-adopted June lookup keeps June 2027; one June entry; Archive feedback; one Edit and one Archive POST', async ({ page }) => {
  const s = seedServerYear();
  const control = watch(page);
  await startNovemberOnDecember31(page, s);
  const startUrl = page.url();
  const historyLength = await page.evaluate(() => history.length);
  const { lookups, today, feedback, confirmation } = await archiveDuringAdoptedJuneLookup(page, control, s);
  expect(page.url()).toBe(startUrl);
  expect(await page.evaluate(() => history.length)).toBe(historyLength);

  // The superseded Edit lookup answers late: nothing navigates.
  const getsBefore = control.gets.length;
  await lookups.answer(0);
  await nextFrame(page);
  expect(control.gets.slice(getsBefore).filter((url) => !isLookup(url))).toEqual([]);
  await expect(region(page)).toHaveAttribute('data-calendar-month', NOVEMBER_2026);

  // The newer lookup answers with the server's 2027: June 2027 installs.
  await lookups.answer(1);
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2027-06');
  await expect(page.locator('[data-calendar-month-heading]')).toContainText('June 2027');
  await settled(page);
  await expectEntries(page, [s.y1, s.y2]);
  const installed = new URL(page.url());
  expect(installed.searchParams.getAll('month')).toEqual(['2027-06']);
  expectRepeated(installed.href, 'project', [s.p1.id, s.p2.id]);
  expectRepeated(installed.href, 'type', ['comic', 'images']);
  expect(installed.searchParams.getAll('status')).toEqual(['all']);
  expect(installed.searchParams.getAll('weekStart')).toEqual(['sunday']);
  await expectSelectedFilters(page, s);
  expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);
  // Archive's confirmation stays; the older Edit never reports over it.
  await expect(feedback).toContainText(confirmation);
  await expect(feedback).not.toContainText('Release updated.');
  await expect(feedback).not.toContainText('could not refresh');
  await expect(feedback).toHaveClass(/notice--success/);

  // The superseded Today answers late and cannot install.
  await today.deliver();
  await nextFrame(page);
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2027-06');
  expect(page.url()).toBe(installed.href);
  await expect(feedback).toContainText(confirmation);

  // Exactly one June navigation; never November, never the stale year.
  expect(userNavigations(control).filter((url) => url.searchParams.get('month') === '2027-06')).toHaveLength(1);
  expect(userNavigations(control).some((url) => url.searchParams.get('month') === NOVEMBER_2026)).toBe(false);
  expect(control.gets.some((url) => url.searchParams.get('month') === '2026-06')).toBe(false);
  expectReleaseWritesOnce(control, s);

  // Back returns to the one November entry, which now shows both writes.
  await page.evaluate(() => history.back());
  await expect(region(page)).toHaveAttribute('data-calendar-month', NOVEMBER_2026);
  await settled(page);
  expect(page.url()).toBe(startUrl);
  await expectEntries(page, [s.n1]);
  await expect(region(page)).toContainText('Server Year November 2026 One edited');
  expectReleaseWritesOnce(control, s);
  expect(control.errors).toEqual([]);
  await lookups.stop();
});

test('Second release action: Next during the Archive-owned June lookup wins; December installs once; June never does', async ({ page }) => {
  const s = seedServerYear();
  const control = watch(page);
  await startNovemberOnDecember31(page, s);
  const historyLength = await page.evaluate(() => history.length);
  const { lookups, today, feedback, confirmation } = await archiveDuringAdoptedJuneLookup(page, control, s);

  const december = await holdEach(page, (url) => url.searchParams.get('month') === DECEMBER_2026);
  await page.locator('#calendar-next').click();
  await expect.poll(() => december.held.length).toBe(1);
  expect(december.held[0].url.searchParams.getAll('month')).toEqual([DECEMBER_2026]);
  expectRepeated(december.held[0].url.href, 'project', [s.p1.id, s.p2.id]);
  expectRepeated(december.held[0].url.href, 'type', ['comic', 'images']);
  expect(december.held[0].url.searchParams.get('weekStart')).toBe('sunday');

  // Both superseded lookups answer late: neither navigates.
  await lookups.answer(0);
  await lookups.answer(1);
  await nextFrame(page);
  await expect(region(page)).toHaveAttribute('data-calendar-month', NOVEMBER_2026);
  expect(control.gets.some((url) => url.searchParams.get('month') === '2027-06')).toBe(false);

  await december.release(0);
  await expect(region(page)).toHaveAttribute('data-calendar-month', DECEMBER_2026);
  await settled(page);
  await expectEntries(page, []);
  const installed = new URL(page.url());
  expect(installed.searchParams.getAll('month')).toEqual([DECEMBER_2026]);
  expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);
  await expect(feedback).toContainText(confirmation);
  await expect(feedback).not.toContainText('Release updated.');

  await today.deliver();
  await nextFrame(page);
  await expect(region(page)).toHaveAttribute('data-calendar-month', DECEMBER_2026);
  expect(page.url()).toBe(installed.href);
  expect(calendarGetsFor(control, DECEMBER_2026)).toHaveLength(1);
  expect(control.gets.some((url) => ['2027-06', '2026-06'].includes(url.searchParams.get('month')))).toBe(false);
  expectReleaseWritesOnce(control, s);
  expect(control.errors).toEqual([]);
  await december.releaseAll();
  await lookups.stop();
});

// Calendar P2-B post-Reset presentation authority. Saved Calendar defaults
// pick Sunday; November renders it. A confirmed Reset defaults adopts (or
// restarts) the June server-year lookup; a later visible Status edit changes
// only Status and never re-serializes the removed Sunday (or View).

const weekHeader = (page) => region(page).locator('.calendar-row-header [role="columnheader"]');

// The saved Sunday is also the address's explicit week start (as reproduced:
// the installed November and its Today link carry weekStart=sunday), so the
// filter form serializes it until a newer destination says otherwise.
async function startSavedSundayNovember(page, s) {
  fixture.writePageDefault('calendar', 'weekStart', 'sunday');
  fixture.writePageDefault('releases', 'sort', 'title');
  await startNovemberOnDecember31(page, s);
  expect(query(page).getAll('weekStart')).toEqual(['sunday']);
  await expect(weekHeader(page).first()).toHaveText('Sun');
}

/** Reset defaults through the visible dialog; exactly one committed POST. */
async function confirmedResetDefaults(page, control) {
  const generation = fixture.generation();
  await showDialog(page);
  await confirmResetDefaults(page);
  await expect.poll(() => control.defaultsPosts().length).toBe(1);
  expect(control.defaultsPosts()[0].path).toBe('/calendar/defaults/reset');
  await expect.poll(() => fixture.calendarKeys()).toEqual([]);
  expect(fixture.generation()).toBe(generation + 1);
  expect(fixture.readPageDefault('releases', 'sort')).toBe('title');
  await closeDialog(page);
}

function expectPostResetPlannedJune(url, s) {
  const target = new URL(url);
  expect(target.searchParams.getAll('month')).toEqual(['2027-06']);
  expect(target.searchParams.getAll('status')).toEqual(['planned']);
  expectRepeated(target.href, 'project', [s.p1.id, s.p2.id]);
  expectRepeated(target.href, 'type', ['comic', 'images']);
  expect(target.searchParams.has('weekStart')).toBe(false);
  expect(target.searchParams.has('view')).toBe(false);
}

async function expectInstalledPostResetPlannedJune(page, s) {
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2027-06');
  await expect(page.locator('[data-calendar-month-heading]')).toContainText('June 2027');
  await settled(page);
  await expectEntries(page, [s.y1]);
  // The Monday fallback, in the default Grid view.
  await expect(region(page)).toHaveClass(/calendar-view-grid/);
  await expect(weekHeader(page).first()).toHaveText('Mon');
  await expect(weekHeader(page).last()).toHaveText('Sun');
  expectPostResetPlannedJune(page.url(), s);
  await openDialog(page);
  expect(await checked(page, 'calendar-status-filter')).toEqual(['planned']);
  expect(await checked(page, 'calendar-week-start-filter')).toEqual(['monday']);
  expect((await checked(page, 'calendar-project-filter')).sort()).toEqual([String(s.p1.id), String(s.p2.id)].sort());
  expect((await checked(page, 'calendar-type-filter')).sort()).toEqual(['comic', 'images']);
  await closeDialog(page);
}

test('P2-B post-Reset REPRODUCTION: saved Sunday, June lookup held, Reset defaults, Planned installs June 2027 on the Monday fallback', async ({ page }) => {
  const s = seedServerYear();
  const control = watch(page);
  await startSavedSundayNovember(page, s);
  const historyLength = await page.evaluate(() => history.length);
  const lookups = await heldLookups(page);
  const today = await todayHeldThenJune(page, lookups);

  await confirmedResetDefaults(page, control);
  // The Reset refresh adopted the held lookup: no further Calendar request.
  expect(lookups.routes).toHaveLength(1);
  expect(userNavigations(control).map((url) => url.searchParams.get('month'))).toEqual([null]);
  await expect(region(page)).toHaveAttribute('data-calendar-month', NOVEMBER_2026);

  await chooseStatusUnsettled(page, 'Planned');
  await expect.poll(() => lookups.routes.length).toBe(2);
  await lookups.answer(1);
  await expectInstalledPostResetPlannedJune(page, s);
  const installedUrl = page.url();

  // The superseded lookup and Today answer late: neither installs.
  await lookups.answer(0);
  await today.deliver();
  await settled(page);
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2027-06');
  await expect(weekHeader(page).first()).toHaveText('Mon');
  expect(page.url()).toBe(installedUrl);
  expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);
  const navigations = userNavigations(control);
  expect(navigations.map((url) => url.searchParams.get('month'))).toEqual([null, '2027-06']);
  expectPostResetPlannedJune(navigations[1].href, s);
  expect(control.gets.filter(isLookup)).toHaveLength(2);
  expect(control.defaultsPosts()).toHaveLength(1);
  expect(control.posts).toHaveLength(1);
  expect(fixture.calendarKeys()).toEqual([]);
  expect(control.errors).toEqual([]);
  await lookups.stop();
});

test('P2-B post-Reset: failed release-adopted June, Reset defaults, held fresh lookup, Planned installs June 2027 without Sunday', async ({ page }) => {
  const s = seedServerYear();
  const control = watch(page);
  await startSavedSundayNovember(page, s);
  const historyLength = await page.evaluate(() => history.length);
  const { lookups, today, feedback } = await adoptedJuneFailure(page, control, s);
  await openPicker(page);
  await expectPicker(page, '2026', '06');
  await closePicker(page);

  await confirmedResetDefaults(page, control);
  // A fresh read-only lookup under the Reset destination, held.
  await expect.poll(() => lookups.routes.length).toBe(2);
  await chooseStatusUnsettled(page, 'Planned');
  await expect.poll(() => lookups.routes.length).toBe(3);
  await lookups.answer(2);
  await expectInstalledPostResetPlannedJune(page, s);
  await expect(feedback).toContainText('Release updated.');
  await lookups.answer(1);
  await today.deliver();
  await settled(page);
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2027-06');
  await expect(weekHeader(page).first()).toHaveText('Mon');
  expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);
  const navigations = userNavigations(control);
  expect(navigations.map((url) => url.searchParams.get('month'))).toEqual([null, '2027-06']);
  expectPostResetPlannedJune(navigations[1].href, s);
  expect(releasePosts(control)).toHaveLength(1);
  expect(control.defaultsPosts()).toHaveLength(1);
  expect(fixture.calendarKeys()).toEqual([]);
  expect(control.errors).toEqual([]);
  await lookups.stop();
});

test('P2-B post-Reset: Planned after the lookup resolves, while the June GET is held, keeps the Reset authority', async ({ page }) => {
  const s = seedServerYear();
  const control = watch(page);
  await startSavedSundayNovember(page, s);
  const historyLength = await page.evaluate(() => history.length);
  const lookups = await heldLookups(page);
  const today = await todayHeldThenJune(page, lookups);
  await confirmedResetDefaults(page, control);

  const june = await holdEach(page, (url) => url.searchParams.get('month') === '2027-06');
  await lookups.answer(0);
  await expect.poll(() => june.held.length).toBe(1);
  expect(june.held[0].url.searchParams.has('weekStart')).toBe(false);
  await chooseStatusUnsettled(page, 'Planned');
  await expect.poll(() => june.held.length).toBe(2);
  expectPostResetPlannedJune(june.held[1].url.href, s);
  await june.release(1);
  await expectInstalledPostResetPlannedJune(page, s);
  const installedUrl = page.url();
  await june.release(0);
  await today.deliver();
  await june.releaseAll();
  await settled(page);
  expect(page.url()).toBe(installedUrl);
  await expect(weekHeader(page).first()).toHaveText('Mon');
  expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);
  expect(control.defaultsPosts()).toHaveLength(1);
  expect(control.errors).toEqual([]);
  await lookups.stop();
});

test('P2-B post-Reset precedence: Previous after Reset and Planned wins over the post-Reset lookup without Sunday', async ({ page }) => {
  const s = seedServerYear();
  const control = watch(page);
  await startSavedSundayNovember(page, s);
  const lookups = await heldLookups(page);
  const today = await todayHeldThenJune(page, lookups);
  await confirmedResetDefaults(page, control);
  await chooseStatusUnsettled(page, 'Planned');
  await expect.poll(() => lookups.routes.length).toBe(2);

  await page.locator('#calendar-previous').click();
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2026-10');
  await settled(page);
  await expectEntries(page, [s.o1]);
  const navigatedUrl = page.url();
  const october = new URL(navigatedUrl);
  expect(october.searchParams.getAll('status')).toEqual(['planned']);
  expect(october.searchParams.has('weekStart')).toBe(false);
  await expect(weekHeader(page).first()).toHaveText('Mon');
  await lookups.answer(0);
  await lookups.answer(1);
  await today.deliver();
  await settled(page);
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2026-10');
  expect(page.url()).toBe(navigatedUrl);
  expect(control.gets.some((url) => ['2027-06', '2026-06'].includes(url.searchParams.get('month')))).toBe(false);
  expect(control.gets.slice(1).some((url) => url.searchParams.get('weekStart') === 'sunday')).toBe(false);
  expect(control.defaultsPosts()).toHaveLength(1);
  expect(control.errors).toEqual([]);
  await lookups.stop();
});

// P2-C: the release-adopted June lookup SUCCEEDS (server month 2027-01), then
// the explicit June 2027 GET it continues answers HTTP 503. That complete
// explicit destination and its push stay the recoverable Calendar intent:
// Retry refresh repeats exactly that GET (no second lookup), Save new
// defaults is refused, Reset defaults resolves it, and a newer navigation
// replaces it.

/** Holds every explicit June 2027 Calendar GET; the test answers each route. */
async function heldJune(page) {
  const routes = [];
  const matcher = (url) => url.pathname === '/calendar' && url.searchParams.get('month') === '2027-06';
  await page.route(matcher, async (route) => {
    if (route.request().resourceType() !== 'fetch') return route.continue();
    routes.push(route);
    return undefined;
  });
  return {
    routes,
    url: (index) => new URL(routes[index].request().url()),
    fail: (index) => routes[index].fulfill({ status: 503, contentType: 'text/html', body: '<p>unavailable</p>' }),
    answer: (index) => routes[index].continue().catch(() => {}),
    stop: () => page.unroute(matcher),
  };
}

function expectJuneFilters(url, s) {
  const target = new URL(url);
  expect(target.searchParams.getAll('month')).toEqual(['2027-06']);
  expectRepeated(target.href, 'project', [s.p1.id, s.p2.id]);
  expectRepeated(target.href, 'type', ['comic', 'images']);
  expect(target.searchParams.getAll('status')).toEqual(['all']);
  expect(target.searchParams.getAll('weekStart')).toEqual(['sunday']);
}

/** Today held, June picked, a release edit adopts the lookup, the lookup answers 2027-01, the explicit June GET fails 503. */
async function resolvedJuneFailure(page, control, s) {
  const june = await heldJune(page);
  const lookups = await heldLookups(page);
  const today = await todayHeldThenJune(page, lookups);
  await saveNovemberReleaseEdit(page, control, s);
  await lookups.answer(0);
  await expect.poll(() => june.routes.length).toBe(1);
  expectJuneFilters(june.url(0), s);
  await june.fail(0);
  const feedback = page.locator('[data-dialog-feedback]');
  await expect(feedback).toContainText('Release saved, but Calendar could not refresh.');
  const retry = feedback.locator('[data-calendar-edit-refresh-retry]');
  await expect(retry).toBeVisible();
  await settled(page);
  await expect(region(page)).toHaveAttribute('data-calendar-month', NOVEMBER_2026);
  return { june, lookups, today, feedback, retry };
}

test('P2-C Retry: the explicit June 2027 GET fails after the year resolves; Retry refresh repeats that GET only and installs June', async ({ page }) => {
  const s = seedServerYear();
  const control = watch(page);
  await startNovemberOnDecember31(page, s);
  const startUrl = page.url();
  const historyLength = await page.evaluate(() => history.length);
  const { june, lookups, today, feedback, retry } = await resolvedJuneFailure(page, control, s);

  // November stays installed and addressed; nothing was pushed.
  expect(page.url()).toBe(startUrl);
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
  await expectEntries(page, [s.n1, s.n2]);
  // The failed explicit June owns the picker.
  await openPicker(page);
  await expectPicker(page, '2027', '06');
  await closePicker(page);

  const retryGets = control.gets.length;
  await retry.click();
  await expect.poll(() => june.routes.length).toBe(2);
  // Exactly the known explicit June GET: no lookup, never November.
  expect(control.gets.slice(retryGets)).toHaveLength(1);
  expectJuneFilters(june.url(1), s);
  expect(lookups.routes).toHaveLength(1);
  await june.answer(1);
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2027-06');
  await expect(page.locator('[data-calendar-month-heading]')).toContainText('June 2027');
  await settled(page);
  await expectEntries(page, [s.y1, s.y2]);
  await expect(feedback).toContainText('Release updated.');
  await expect(retry).toHaveCount(0);
  expectJuneFilters(page.url(), s);
  // The picked June's one history entry.
  expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);

  await today.deliver();
  await settled(page);
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2027-06');
  expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);
  // One release POST, persisted; Retry is GET-only; no defaults write.
  expect(releasePosts(control)).toHaveLength(1);
  expect(control.posts).toHaveLength(1);
  expect(fixture.state.db.prepare('SELECT title FROM releases WHERE id = ?').get(s.n1.id).title)
    .toBe('Server Year November 2026 One edited');
  expect(control.defaultsPosts()).toEqual([]);
  expect(fixture.calendarKeys()).toEqual([]);
  expect(control.gets.some((url) => url.searchParams.get('month') === '2026-06')).toBe(false);
  await expectSelectedFilters(page, s);
  expect(control.errors).toEqual([]);
  await lookups.stop();
  await june.stop();
});

test('P2-C Save guard: Save new defaults is refused while the failed explicit June owns Calendar; Retry installs June; then Save posts once', async ({ page }) => {
  const s = seedServerYear();
  const control = watch(page);
  await startNovemberOnDecember31(page, s);
  const generation = fixture.generation();
  const historyLength = await page.evaluate(() => history.length);
  const { june, lookups, today, retry } = await resolvedJuneFailure(page, control, s);

  await showDialog(page);
  const getsBefore = control.gets.length;
  await dialog(page).locator('[data-calendar-defaults-save]').click();
  await expect(defaultsStatus(page)).toHaveText('The current Calendar did not load. Retry loading it before saving defaults.');
  await settled(page);
  expect(control.defaultsPosts()).toEqual([]);
  expect(fixture.calendarKeys()).toEqual([]);
  expect(fixture.generation()).toBe(generation);
  // November was not refreshed; June is still recoverable.
  expect(control.gets.slice(getsBefore)).toEqual([]);
  await closeDialog(page);
  await expect(retry).toBeVisible();

  await retry.click();
  await expect.poll(() => june.routes.length).toBe(2);
  await june.answer(1);
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2027-06');
  await settled(page);
  await expectEntries(page, [s.y1, s.y2]);
  await today.deliver();
  await settled(page);

  await showDialog(page);
  await dialog(page).locator('[data-calendar-defaults-save]').click();
  // The Save refresh of the installed June.
  await expect.poll(() => june.routes.length).toBe(3);
  await june.answer(2);
  await expect(defaultsStatus(page)).toHaveText('Defaults saved.');
  await settled(page);
  expect(control.defaultsPosts()).toHaveLength(1);
  expect(control.defaultsPosts()[0].path).toBe('/calendar/defaults');
  expect(new URL(control.defaultsPosts()[0].body.get('returnTo'), fixture.baseURL).searchParams.getAll('month')).toEqual(['2027-06']);
  expect(fixture.calendarKeys()).toHaveLength(3);
  expect(fixture.generation()).toBe(generation + 1);
  expect(control.gets.at(-1).searchParams.getAll('month')).toEqual(['2027-06']);
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2027-06');
  expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);
  expect(releasePosts(control)).toHaveLength(1);
  await closeDialog(page);
  expect(control.errors).toEqual([]);
  await lookups.stop();
  await june.stop();
});

test('P2-C precedence: Previous after the failed explicit June wins; the stale Retry sends nothing', async ({ page }) => {
  const s = seedServerYear();
  const control = watch(page);
  await startNovemberOnDecember31(page, s);
  const historyLength = await page.evaluate(() => history.length);
  const { june, lookups, today, retry } = await resolvedJuneFailure(page, control, s);

  await page.locator('#calendar-previous').click();
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2026-10');
  await settled(page);
  await expectEntries(page, [s.o1]);
  const october = control.gets.at(-1);
  expect(october.searchParams.getAll('month')).toEqual(['2026-10']);
  expectRepeated(october.href, 'project', [s.p1.id, s.p2.id]);
  expectRepeated(october.href, 'type', ['comic', 'images']);
  const navigatedUrl = page.url();
  const getsBefore = control.gets.length;
  // An obsolete Retry (whether it is still shown is P3, out of scope) is inert.
  if (await retry.isVisible()) await retry.click();
  await settled(page);
  expect(control.gets.slice(getsBefore)).toEqual([]);
  expect(june.routes).toHaveLength(1);
  await today.deliver();
  await settled(page);
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2026-10');
  expect(page.url()).toBe(navigatedUrl);
  expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);

  // Save follows the newer October context.
  await showDialog(page);
  await dialog(page).locator('[data-calendar-defaults-save]').click();
  await expect(defaultsStatus(page)).toHaveText('Defaults saved.');
  await settled(page);
  expect(control.defaultsPosts()).toHaveLength(1);
  expect(new URL(control.defaultsPosts()[0].body.get('returnTo'), fixture.baseURL).searchParams.getAll('month')).toEqual(['2026-10']);
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2026-10');
  await closeDialog(page);
  expect(june.routes).toHaveLength(1);
  expect(releasePosts(control)).toHaveLength(1);
  expect(control.errors).toEqual([]);
  await lookups.stop();
  await june.stop();
});

test('P2-C filter edit: Status Planned after the failed explicit June keeps June and every filter; one June push', async ({ page }) => {
  const s = seedServerYear();
  const control = watch(page);
  await startNovemberOnDecember31(page, s);
  const historyLength = await page.evaluate(() => history.length);
  const { june, lookups, today, feedback } = await resolvedJuneFailure(page, control, s);

  await chooseStatusUnsettled(page, 'Planned');
  await expect.poll(() => june.routes.length).toBe(2);
  expectPlannedJune(june.url(1).href, s);
  expect(lookups.routes).toHaveLength(1);
  await june.answer(1);
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2027-06');
  await settled(page);
  await expectEntries(page, [s.y1]);
  expectPlannedJune(page.url(), s);
  await expect(feedback).toContainText('Release updated.');
  await today.deliver();
  await settled(page);
  expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);
  expect(releasePosts(control)).toHaveLength(1);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
  await lookups.stop();
  await june.stop();
});

test('P2-C Reset: Reset defaults during the failed explicit June posts once and installs June with its owed history entry', async ({ page }) => {
  const s = seedServerYear();
  fixture.writePageDefault('calendar', 'status', 'planned');
  fixture.writePageDefault('releases', 'sort', 'title');
  const control = watch(page);
  await startNovemberOnDecember31(page, s, { status: 'all' });
  const generation = fixture.generation();
  const historyLength = await page.evaluate(() => history.length);
  const { june, lookups, today, feedback } = await resolvedJuneFailure(page, control, s);

  await showDialog(page);
  const getsBefore = control.gets.length;
  await confirmResetDefaults(page);
  await expect.poll(() => control.defaultsPosts().length).toBe(1);
  const post = control.defaultsPosts()[0];
  expect(post.path).toBe('/calendar/defaults/reset');
  // returnTo is the failed explicit June intent, not November.
  expectJuneFilters(new URL(post.body.get('returnTo'), fixture.baseURL).href, s);
  await expect.poll(() => fixture.calendarKeys()).toEqual([]);
  expect(fixture.generation()).toBe(generation + 1);
  expect(fixture.readPageDefault('releases', 'sort')).toBe('title');

  // One explicit June refresh; no lookup; never November.
  await expect.poll(() => june.routes.length).toBe(2);
  expect(lookups.routes).toHaveLength(1);
  const refresh = control.gets.slice(getsBefore);
  expect(refresh).toHaveLength(1);
  expect(refresh[0].searchParams.getAll('month')).toEqual(['2027-06']);
  expectRepeated(refresh[0].href, 'project', [s.p1.id, s.p2.id]);
  expectRepeated(refresh[0].href, 'type', ['comic', 'images']);
  for (const key of THREE) expect(refresh[0].searchParams.has(key)).toBe(false);
  await june.answer(1);
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2027-06');
  await settled(page);
  await expect(defaultsStatus(page)).toHaveText('Defaults reset to the application defaults.');
  await closeDialog(page);
  await today.deliver();
  await settled(page);
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2027-06');
  await expectEntries(page, [s.y1, s.y2]);
  await expect(region(page)).toHaveClass(/calendar-view-grid/);
  expect(query(page).getAll('month')).toEqual(['2027-06']);
  expectRepeated(page.url(), 'project', [s.p1.id, s.p2.id]);
  expectRepeated(page.url(), 'type', ['comic', 'images']);
  // The failed June's owed entry, once.
  expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);
  await expect(feedback).toContainText('Release updated.');
  await openDialog(page);
  expect(await checked(page, 'calendar-week-start-filter')).toEqual(['monday']);
  expect(await checked(page, 'calendar-status-filter')).toEqual(['all']);
  await closeDialog(page);
  expect(control.defaultsPosts()).toHaveLength(1);
  expect(releasePosts(control)).toHaveLength(1);
  expect(control.errors).toEqual([]);
  await lookups.stop();
  await june.stop();
});

test('P2-C ordinary: an explicit June GET failure without a release refresh keeps the engine notice and its GET-only Retry', async ({ page }) => {
  const s = seedServerYear();
  const control = watch(page);
  await startNovemberOnDecember31(page, s);
  const historyLength = await page.evaluate(() => history.length);
  const june = await heldJune(page);
  const lookups = await heldLookups(page);
  const today = await todayHeldThenJune(page, lookups);
  await lookups.answer(0);
  await expect.poll(() => june.routes.length).toBe(1);
  expectJuneFilters(june.url(0), s);
  await june.fail(0);
  const engineRetry = page.locator('[data-live-filter-retry]');
  await expect(engineRetry).toHaveCount(1);
  await expect(page.locator('[data-calendar-edit-refresh-retry]')).toHaveCount(0);
  await settled(page);
  await expect(region(page)).toHaveAttribute('data-calendar-month', NOVEMBER_2026);

  // Save is refused through the engine failure as before.
  await showDialog(page);
  await dialog(page).locator('[data-calendar-defaults-save]').click();
  await expect(defaultsStatus(page)).toHaveText('The current Calendar did not load. Retry loading it before saving defaults.');
  await closeDialog(page);

  await engineRetry.click();
  await expect.poll(() => june.routes.length).toBe(2);
  expectJuneFilters(june.url(1), s);
  await june.answer(1);
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2027-06');
  await settled(page);
  await expectEntries(page, [s.y1, s.y2]);
  await today.deliver();
  await settled(page);
  expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);
  expect(lookups.routes).toHaveLength(1);
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
  await lookups.stop();
  await june.stop();
});

// Final Calendar M1 P3. P3-A: an Edit refresh adopted the held June lookup;
// a newer Archive of another visible release is interrupted (its outcome is
// genuinely unknown to the page) and reports uncertainty with Check again.
// The older Edit lookup's late 503 must not replace that warning. P3-B: a
// failed release refresh's Retry refresh is retired once a newer navigation
// owns Calendar; that navigation's own failure keeps its own working Retry.

const ARCHIVE_UNCONFIRMED = 'Could not confirm whether the release was archived.';
const ARCHIVE_STILL_ACTIVE = 'The release still shows as active, but the earlier Archive request may still run.';

/** Every request for a release's edit model (the Archive's verification GET). */
function watchEditReads(page, release) {
  const reads = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === `/releases/${release.id}/edit`) reads.push({ method: request.method(), type: request.resourceType() });
  });
  return reads;
}

/**
 * Archives a visible November release whose POST is interrupted before it
 * reaches the server (a network failure): the page cannot know the outcome.
 */
async function interruptedArchive(page, control, release) {
  const aborted = [];
  const matcher = (url) => url.pathname === `/releases/${release.id}/archive`;
  await page.route(matcher, (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    aborted.push(route.request().url());
    return route.abort('failed');
  });
  const editDialog = page.locator('#release-edit-dialog');
  await page.locator(`[data-calendar-info-trigger][aria-controls="calendar-info-grid-${release.id}"]`).click();
  await page.locator(`#calendar-info-grid-${release.id} [data-release-edit-id="${release.id}"]`).click();
  await expect(editDialog).toBeVisible();
  const archive = editDialog.locator('[data-release-edit-action="archive"]');
  await expect(archive.locator('form')).toHaveAttribute('action', `/releases/${release.id}/archive`);
  if (!(await archive.evaluate((node) => node.open))) await archive.locator('summary').click();
  await archive.locator('button[data-confirm]').click();
  await page.locator('#app-confirmation-dialog [data-app-dialog-confirmation-confirm]').click();
  await expect.poll(() => aborted.length).toBe(1);
  await expect.poll(() => releasePosts(control).length).toBe(2);
  expect(releasePosts(control)[1].path).toBe(`/releases/${release.id}/archive`);
  return { editDialog, aborted, stop: () => page.unroute(matcher) };
}

test('Final P3-A: an older Edit lookup 503 never replaces a newer interrupted Archive\'s uncertainty or Check again; the real verification GET stays authoritative', async ({ page }) => {
  const s = seedServerYear();
  const control = watch(page);
  const editReads = watchEditReads(page, s.n2);
  await startNovemberOnDecember31(page, s);
  const startUrl = page.url();
  const historyLength = await page.evaluate(() => history.length);
  const lookups = await heldLookups(page);
  const today = await todayHeldThenJune(page, lookups);
  // 1-3. Edit release A commits once; its refresh adopts the held June lookup.
  await saveNovemberReleaseEdit(page, control, s);
  expect(lookups.routes).toHaveLength(1);
  const feedback = page.locator('[data-dialog-feedback]');

  // 4-6. Archive release B; its POST is interrupted: uncertain, not failed.
  const { editDialog, aborted, stop } = await interruptedArchive(page, control, s.n2);
  // 7. The real verification GET (no POST) finds release B still active.
  await expect(feedback).toContainText(ARCHIVE_STILL_ACTIVE);
  await expect(feedback).toContainText(ARCHIVE_UNCONFIRMED);
  await expect(feedback).toHaveClass(/notice--error/);
  const check = feedback.locator('[data-release-archive-feedback-check]');
  await expect(check).toBeVisible();
  await expect(check).toHaveText('Check again');
  // The dialog's own load of release B, then the one verification read.
  expect(editReads.filter(({ type }) => type === 'fetch').map(({ method }) => method)).toEqual(['GET', 'GET']);
  expect(s.n2.archived()).toBe(false);
  // The dialog keeps the hold and its own Check again; dismiss it.
  await expect(editDialog.locator('[data-release-archive-check]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(editDialog).toBeHidden();
  await expect(feedback).toContainText(ARCHIVE_STILL_ACTIVE);

  // 8. The older Edit's adopted lookup fails 503.
  await lookups.fail(0);
  await nextFrame(page);
  // 9-10. The Archive warning and its Check again stay authoritative.
  await expect(feedback).toContainText(ARCHIVE_STILL_ACTIVE);
  await expect(feedback).not.toContainText('Release saved, but Calendar could not refresh.');
  await expect(feedback).not.toContainText('Release updated.');
  await expect(feedback).toHaveClass(/notice--error/);
  await expect(check).toBeVisible();
  await expect(feedback.locator('[data-calendar-edit-refresh-retry]')).toHaveCount(0);
  // The failed June lookup stays recoverable as Calendar's own failure.
  const calendarFailure = page.locator('[data-live-filter-failure]');
  await expect(calendarFailure).toHaveCount(1);
  await expect(calendarFailure.locator('[data-live-filter-retry]')).toBeVisible();
  await settled(page);
  await expect(region(page)).toHaveAttribute('data-calendar-month', NOVEMBER_2026);
  expect(page.url()).toBe(startUrl);
  expect(await page.evaluate(() => history.length)).toBe(historyLength);

  // Check again only reads: one more GET, still active, nothing posted.
  await check.click();
  await expect.poll(() => editReads.filter(({ type }) => type === 'fetch').length).toBe(3);
  await expect(feedback).toContainText(ARCHIVE_STILL_ACTIVE);
  await expect(feedback.locator('[data-release-archive-feedback-check]')).toBeVisible();
  expect(editReads.every(({ method }) => method === 'GET')).toBe(true);

  // Calendar's own Retry resolves June 2027; the warning still stands.
  await calendarFailure.locator('[data-live-filter-retry]').click();
  await expect.poll(() => lookups.routes.length).toBe(2);
  await lookups.answer(1);
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2027-06');
  await settled(page);
  await expectEntries(page, [s.y1, s.y2]);
  expect(new URL(page.url()).searchParams.getAll('month')).toEqual(['2027-06']);
  expectRepeated(page.url(), 'project', [s.p1.id, s.p2.id]);
  expectRepeated(page.url(), 'type', ['comic', 'images']);
  expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);
  await expect(feedback).toContainText(ARCHIVE_STILL_ACTIVE);
  await expect(feedback).not.toContainText('Release updated.');
  await today.deliver();
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2027-06');

  // 11. SQLite and request counts: one Edit POST, one (interrupted) Archive POST.
  expect(releasePosts(control).map((post) => post.path)).toEqual([`/releases/${s.n1.id}`, `/releases/${s.n2.id}/archive`]);
  expect(aborted).toHaveLength(1);
  expect(fixture.state.db.prepare('SELECT title FROM releases WHERE id = ?').get(s.n1.id).title)
    .toBe('Server Year November 2026 One edited');
  expect(s.n1.archived()).toBe(false);
  expect(s.n2.archived()).toBe(false);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.gets.some((url) => url.searchParams.get('month') === '2026-06')).toBe(false);
  expect(userNavigations(control).filter((url) => url.searchParams.get('month') === '2027-06')).toHaveLength(1);
  expect(control.errors).toEqual([]);
  await stop();
  await lookups.stop();
});

test('Final P3-A: with no newer release action the Edit refresh failure still reports, with its working Retry refresh', async ({ page }) => {
  const s = seedServerYear();
  const control = watch(page);
  await startNovemberOnDecember31(page, s);
  const { lookups, feedback, retry } = await adoptedJuneFailure(page, control, s);
  await expect(feedback).toHaveClass(/notice--error/);
  await expect(page.locator('[data-live-filter-failure]')).toHaveCount(0);
  await retry.click();
  await expect.poll(() => lookups.routes.length).toBe(2);
  await lookups.answer(1);
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2027-06');
  await settled(page);
  await expect(feedback).toContainText('Release updated.');
  expect(releasePosts(control)).toHaveLength(1);
  expect(control.errors).toEqual([]);
  await lookups.stop();
});

test('Final P3-B: Next fails 503 after a failed release-adopted lookup: the old Retry refresh is retired; December\'s own Retry recovers December by keyboard', async ({ page }) => {
  const s = seedServerYear();
  const control = watch(page);
  await startNovemberOnDecember31(page, s);
  const startUrl = page.url();
  const historyLength = await page.evaluate(() => history.length);
  // 1-2. A failed release-adopted lookup with its current Retry refresh.
  const { lookups, today, feedback, retry } = await adoptedJuneFailure(page, control, s);
  await expect(retry).toBeVisible();
  await expect(retry).toHaveText('Retry refresh');
  const captured = await retry.elementHandle();

  // 3-4. Next; its December GET answers 503.
  let decemberFailures = 0;
  const decemberMatcher = (url) => url.pathname === '/calendar' && url.searchParams.get('month') === DECEMBER_2026;
  await page.route(decemberMatcher, (route) => {
    if (route.request().resourceType() !== 'fetch' || decemberFailures > 0) return route.continue();
    decemberFailures += 1;
    return route.fulfill({ status: 503, contentType: 'text/html', body: '<p>unavailable</p>' });
  });
  const getsBefore = control.gets.length;
  await page.locator('#calendar-next').focus();
  await page.keyboard.press('Enter');
  const calendarFailure = page.locator('[data-live-filter-failure]');
  await expect(calendarFailure).toHaveCount(1);
  await expect(calendarFailure).toContainText("The requested month couldn't be loaded.");
  // 5. The obsolete Retry refresh is retired: not rendered, not focusable.
  await expect(feedback.locator('[data-calendar-edit-refresh-retry]')).toHaveCount(0);
  await expect(page.locator('[data-calendar-edit-refresh-retry]')).toHaveCount(0);
  expect(await captured.evaluate((node) => node.isConnected)).toBe(false);
  // The release report itself stays true: saved, Calendar maybe out of date.
  await expect(feedback).toContainText('Release saved, but Calendar could not refresh.');
  // 6. December's own Retry is the one Retry on the page.
  const currentRetry = calendarFailure.locator('[data-live-filter-retry]');
  await expect(currentRetry).toBeVisible();
  await expect(currentRetry).toHaveText('Retry');
  await expect(page.locator('[data-live-filter-retry], [data-calendar-edit-refresh-retry]')).toHaveCount(1);
  await expect(region(page)).toHaveAttribute('data-calendar-month', NOVEMBER_2026);
  expect(page.url()).toBe(startUrl);

  // A captured old callback is inert: no GET, no history, no feedback change.
  await captured.evaluate((node) => node.click());
  await nextFrame(page);
  expect(control.gets.slice(getsBefore).map((url) => url.searchParams.get('month'))).toEqual([DECEMBER_2026]);
  expect(lookups.routes).toHaveLength(1);
  await expect(calendarFailure).toHaveCount(1);
  await expect(feedback).toContainText('Release saved, but Calendar could not refresh.');
  expect(await page.evaluate(() => history.length)).toBe(historyLength);

  // 7. Keyboard: the current Retry takes focus and activates with Enter.
  await currentRetry.focus();
  await expect(currentRetry).toBeFocused();
  // 8-9. Enter on the current Retry; December answers.
  await page.keyboard.press('Enter');
  await expect(region(page)).toHaveAttribute('data-calendar-month', DECEMBER_2026);
  await settled(page);
  await expectEntries(page, []);
  // 10. December, its URL and one new history entry.
  const installed = new URL(page.url());
  expect(installed.searchParams.getAll('month')).toEqual([DECEMBER_2026]);
  expectRepeated(installed.href, 'project', [s.p1.id, s.p2.id]);
  expectRepeated(installed.href, 'type', ['comic', 'images']);
  expect(installed.searchParams.get('weekStart')).toBe('sunday');
  expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);
  await expect(calendarFailure).toHaveCount(0);
  await expect(feedback).toContainText('Release updated.');
  // Focus is not stranded on the document body.
  expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
  await today.deliver();
  await expect(region(page)).toHaveAttribute('data-calendar-month', DECEMBER_2026);

  // 11. Two December GETs (failed, then Retry), no other: none from the old Retry.
  expect(calendarGetsFor(control, DECEMBER_2026)).toHaveLength(2);
  expect(control.gets.some((url) => ['2027-06', '2026-06'].includes(url.searchParams.get('month')))).toBe(false);
  // 12. The release save was never repeated.
  expect(releasePosts(control)).toHaveLength(1);
  expect(fixture.state.db.prepare('SELECT title FROM releases WHERE id = ?').get(s.n1.id).title)
    .toBe('Server Year November 2026 One edited');
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
  await page.unroute(decemberMatcher);
  await lookups.stop();
});

test('Final P3-B: a focused old Retry refresh retired by Back moves focus to the main content; a newer successful navigation installs once', async ({ page }) => {
  const s = seedServerYear();
  const control = watch(page);
  await startNovemberOnDecember31(page, s);
  const historyLength = await page.evaluate(() => history.length);
  const { lookups, feedback, retry } = await adoptedJuneFailure(page, control, s);
  const captured = await retry.elementHandle();
  await retry.focus();
  await expect(retry).toBeFocused();
  // Previous by script while focus stays on the Retry refresh (a keyboard
  // user who never left it): October owns Calendar.
  const october = await holdEach(page, (url) => url.searchParams.get('month') === '2026-10');
  await page.evaluate(() => document.querySelector('#calendar-previous').click());
  await expect.poll(() => october.held.length).toBe(1);
  await expect(feedback.locator('[data-calendar-edit-refresh-retry]')).toHaveCount(0);
  await expect(page.locator('#main-content')).toBeFocused();
  // Tab moves on from the main content without reaching a Retry refresh.
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement?.hasAttribute('data-calendar-edit-refresh-retry') ?? false)).toBe(false);
  await captured.evaluate((node) => node.click());
  await nextFrame(page);
  expect(october.held).toHaveLength(1);
  expect(lookups.routes).toHaveLength(1);
  await october.release(0);
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2026-10');
  await settled(page);
  await expectEntries(page, [s.o1]);
  expect(new URL(page.url()).searchParams.getAll('month')).toEqual(['2026-10']);
  expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);
  await expect(feedback).toContainText('Release updated.');
  expect(calendarGetsFor(control, '2026-10')).toHaveLength(1);
  expect(control.gets.some((url) => url.searchParams.get('month') === '2027-06')).toBe(false);
  expect(releasePosts(control)).toHaveLength(1);
  expect(control.errors).toEqual([]);
  await october.releaseAll();
  await lookups.stop();
});

// Calendar M1 late verification (P2): release B's Archive or Delete is left
// unresolved (its POST is interrupted before the server) and a Check again
// verification GET for B is held. A newer release action on A then reports
// its outcome. B's real verification answer, delivered late, settles B's own
// record but never replaces A's feedback, recovery controls or focus; an
// answer that observes B archived or gone still refreshes Calendar (GET only).

const DELETE_UNCONFIRMED = 'Could not confirm whether the release was deleted.';
const DELETE_STILL_PRESENT = 'The release still exists, but the earlier Delete request may still run.';
const CHECKING = 'Checking…';
const STALE_EDIT_TEXT = 'Release saved, but Calendar could not refresh. The calendar shown may be out of date.';
const feedbackNotice = (page) => page.locator('[data-dialog-feedback]');
const feedbackText = (page) => page.locator('[data-dialog-feedback] [data-dialog-feedback-text]');

async function openReleaseDialog(page, release) {
  const editDialog = page.locator('#release-edit-dialog');
  await page.locator(`[data-calendar-info-trigger][aria-controls="calendar-info-grid-${release.id}"]`).click();
  await page.locator(`#calendar-info-grid-${release.id} [data-release-edit-id="${release.id}"]`).click();
  await expect(editDialog).toBeVisible();
  await expect(editDialog.locator('input[name="title"]')).toHaveValue(release.title);
  return editDialog;
}

/**
 * Archives or deletes release B with its POST interrupted before the server:
 * the outcome is unknown. Its first verification finds B unchanged; the
 * dialog is dismissed. arrive() lets that one lost request reach the server
 * later (outside the page: the page itself sent exactly one POST).
 */
async function lostReleaseMutation(page, release, kind) {
  const lost = [];
  const matcher = (url) => url.pathname === `/releases/${release.id}/${kind}`;
  await page.route(matcher, (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const request = route.request();
    lost.push({ url: request.url(), headers: request.headers(), body: request.postData() });
    return route.abort('failed');
  });
  const editDialog = await openReleaseDialog(page, release);
  const action = editDialog.locator(`[data-release-edit-action="${kind}"]`);
  await expect(action.locator('form')).toHaveAttribute('action', `/releases/${release.id}/${kind}`);
  if (!(await action.evaluate((node) => node.open))) await action.locator('summary').click();
  await action.locator('button[data-confirm]').click();
  await page.locator('#app-confirmation-dialog [data-app-dialog-confirmation-confirm]').click();
  await expect.poll(() => lost.length).toBe(1);
  await expect(feedbackNotice(page)).toContainText(kind === 'archive' ? ARCHIVE_STILL_ACTIVE : DELETE_STILL_PRESENT);
  await page.keyboard.press('Escape');
  await expect(editDialog).toBeHidden();
  const check = feedbackNotice(page).locator(`[data-release-${kind}-feedback-check]`);
  await expect(check).toBeVisible();
  return {
    lost,
    check,
    async arrive() {
      const { url, headers, body } = lost[0];
      const response = await page.request.fetch(url, { method: 'POST', headers, data: body });
      expect(response.status()).toBe(200);
    },
    stop: () => page.unroute(matcher),
  };
}

/** Holds B's next verification GET (GET /releases/:id/edit) until delivered. */
async function holdVerification(page, release) {
  const gates = [];
  const matcher = (url) => url.pathname === `/releases/${release.id}/edit`;
  await page.route(matcher, async (route) => {
    if (route.request().resourceType() !== 'fetch') return route.continue();
    let open;
    const gate = new Promise((resolve) => { open = resolve; });
    gates.push(open);
    await gate;
    await route.continue().catch(() => {});
    return undefined;
  });
  return {
    gates,
    async deliver(expectedStatus) {
      const answered = page.waitForResponse((response) => new URL(response.url()).pathname === `/releases/${release.id}/edit`);
      gates[0]();
      expect((await answered).status()).toBe(expectedStatus);
      await nextFrame(page);
      await nextFrame(page);
      await page.unroute(matcher);
    },
  };
}

/** A real Edit Release save of release A; optionally its Calendar refresh fails 503. */
async function editReleaseA(page, release, title, { refreshFails = false } = {}) {
  let failures = 0;
  const refreshMatcher = (url) => url.pathname === '/calendar';
  if (refreshFails) {
    await page.route(refreshMatcher, (route) => {
      if (route.request().resourceType() !== 'fetch' || failures > 0) return route.continue();
      failures += 1;
      return route.fulfill({ status: 503, contentType: 'text/html', body: '<p>unavailable</p>' });
    });
  }
  const editDialog = await openReleaseDialog(page, release);
  await expect(editDialog.locator('button[data-dialog-submit]')).toBeEnabled();
  await editDialog.locator('input[name="title"]').fill(title);
  await editDialog.locator('button[data-dialog-submit]').click();
  await expect(editDialog).toBeHidden();
  if (refreshFails) {
    await expect(feedbackText(page)).toHaveText(STALE_EDIT_TEXT);
    await page.unroute(refreshMatcher);
  }
  await settled(page);
  expect(fixture.state.db.prepare('SELECT title FROM releases WHERE id = ?').get(release.id).title).toBe(title);
}

const activeDescription = (page) => page.evaluate(() => {
  const node = document.activeElement;
  if (!node) return null;
  const data = [...node.attributes].map((attribute) => attribute.name).filter((name) => name.startsWith('data-'));
  return `${node.tagName}#${node.id}[${data.join(',')}]`;
});

/** B unresolved, its Check again GET held, the feedback showing B's Checking…. */
async function heldCheckAgainFor(page, s, kind) {
  const mutation = await lostReleaseMutation(page, s.n2, kind);
  const verification = await holdVerification(page, s.n2);
  await mutation.check.click();
  await expect.poll(() => verification.gates.length).toBe(1);
  await expect(feedbackText(page)).toContainText(CHECKING);
  return { mutation, verification };
}

const bFetchReads = (reads) => reads.filter(({ type }) => type === 'fetch').map(({ method }) => method);

test('Late verification CASE 1: an older Archive Check again 200 (still active) arrives after a newer Edit success; the Edit report stays', async ({ page }) => {
  const s = seedServerYear();
  const control = watch(page);
  const bReads = watchEditReads(page, s.n2);
  await startNovemberOnDecember31(page, s);
  const startUrl = page.url();
  const historyLength = await page.evaluate(() => history.length);
  const { mutation, verification } = await heldCheckAgainFor(page, s, 'archive');

  await editReleaseA(page, s.n1, 'Late Verification Edited One');
  const editReport = await feedbackText(page).textContent();
  expect(editReport).not.toContain(ARCHIVE_UNCONFIRMED);
  expect(editReport).not.toContain(CHECKING);
  await expect(feedbackNotice(page).locator('button')).toHaveCount(0);
  const focusBefore = await activeDescription(page);

  // B's real verification GET answers 200: B is still active.
  await verification.deliver(200);
  await expect(feedbackText(page)).toHaveText(editReport);
  await expect(feedbackNotice(page)).not.toContainText(ARCHIVE_STILL_ACTIVE);
  await expect(feedbackNotice(page).locator('button')).toHaveCount(0);
  expect(await activeDescription(page)).toBe(focusBefore);
  // Load, first verification, the held Check again: GETs only.
  expect(bFetchReads(bReads)).toEqual(['GET', 'GET', 'GET']);
  expect(releasePosts(control).map((post) => post.path)).toEqual([`/releases/${s.n2.id}/archive`, `/releases/${s.n1.id}`]);
  expect(mutation.lost).toHaveLength(1);
  expect(s.n2.exists()).toBe(true);
  expect(s.n2.archived()).toBe(false);
  expect(s.n1.archived()).toBe(false);
  await settled(page);
  await expect(region(page)).toHaveAttribute('data-calendar-month', NOVEMBER_2026);
  expect(page.url()).toBe(startUrl);
  expect(await page.evaluate(() => history.length)).toBe(historyLength);

  // B keeps its own result: its dialog reopens with that warning and Check again.
  const editDialog = await openReleaseDialog(page, s.n2);
  await expect(editDialog.locator('[data-dialog-status]')).toContainText(ARCHIVE_STILL_ACTIVE);
  await expect(editDialog.locator('[data-release-archive-check]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(editDialog).toBeHidden();
  expect(releasePosts(control)).toHaveLength(2);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
  await mutation.stop();
});

test('Late verification CASE 2: an older Archive Check again 200 arrives after a newer Edit whose Calendar refresh failed; the Edit warning and its Retry refresh stay and work by keyboard', async ({ page }) => {
  const s = seedServerYear();
  const control = watch(page);
  const bReads = watchEditReads(page, s.n2);
  await startNovemberOnDecember31(page, s);
  const startUrl = page.url();
  const historyLength = await page.evaluate(() => history.length);
  const { mutation, verification } = await heldCheckAgainFor(page, s, 'archive');

  await editReleaseA(page, s.n1, 'Late Verification Edited One', { refreshFails: true });
  const retry = feedbackNotice(page).locator('[data-calendar-edit-refresh-retry]');
  await expect(retry).toBeVisible();
  await expect(feedbackNotice(page).locator('button')).toHaveCount(1);
  await retry.focus();
  await expect(retry).toBeFocused();
  const getsBefore = control.gets.length;

  await verification.deliver(200);
  // A's warning and its one Retry refresh stay; B adds nothing to them.
  await expect(feedbackText(page)).toHaveText(STALE_EDIT_TEXT);
  await expect(feedbackNotice(page)).not.toContainText(ARCHIVE_UNCONFIRMED);
  await expect(feedbackNotice(page).locator('button')).toHaveCount(1);
  await expect(feedbackNotice(page).locator('[data-release-archive-feedback-check]')).toHaveCount(0);
  await expect(retry).toBeFocused();
  await expect(feedbackNotice(page)).toHaveClass(/notice--error/);
  expect(control.gets.slice(getsBefore)).toEqual([]);

  // The Retry refresh still belongs to A: Enter re-reads November (GET only).
  await page.keyboard.press('Enter');
  await expect(feedbackText(page)).toHaveText('Release updated.');
  await settled(page);
  await expect(feedbackNotice(page).locator('button')).toHaveCount(0);
  const reread = control.gets.slice(getsBefore);
  expect(reread).toHaveLength(1);
  expect(reread[0].searchParams.getAll('month')).toEqual([NOVEMBER_2026]);
  expectRepeated(reread[0].href, 'project', [s.p1.id, s.p2.id]);
  expectRepeated(reread[0].href, 'type', ['comic', 'images']);
  expect(page.url()).toBe(startUrl);
  expect(await page.evaluate(() => history.length)).toBe(historyLength);

  expect(bFetchReads(bReads)).toEqual(['GET', 'GET', 'GET']);
  expect(releasePosts(control).map((post) => post.path)).toEqual([`/releases/${s.n2.id}/archive`, `/releases/${s.n1.id}`]);
  expect(s.n2.archived()).toBe(false);
  expect(s.n2.exists()).toBe(true);
  expect(control.errors).toEqual([]);
  await mutation.stop();
});

test('Late verification CASE 3: an older Delete Check again 200 (still present) arrives after a newer Edit success; the Edit report stays', async ({ page }) => {
  const s = seedServerYear();
  const control = watch(page);
  const bReads = watchEditReads(page, s.n2);
  await startNovemberOnDecember31(page, s);
  const startUrl = page.url();
  const historyLength = await page.evaluate(() => history.length);
  const { mutation, verification } = await heldCheckAgainFor(page, s, 'delete');

  await editReleaseA(page, s.n1, 'Late Verification Edited One');
  const editReport = await feedbackText(page).textContent();
  expect(editReport).not.toContain(DELETE_UNCONFIRMED);
  const focusBefore = await activeDescription(page);

  await verification.deliver(200);
  await expect(feedbackText(page)).toHaveText(editReport);
  await expect(feedbackNotice(page)).not.toContainText(DELETE_STILL_PRESENT);
  await expect(feedbackNotice(page).locator('button')).toHaveCount(0);
  expect(await activeDescription(page)).toBe(focusBefore);
  expect(bFetchReads(bReads)).toEqual(['GET', 'GET', 'GET']);
  expect(releasePosts(control).map((post) => post.path)).toEqual([`/releases/${s.n2.id}/delete`, `/releases/${s.n1.id}`]);
  expect(mutation.lost).toHaveLength(1);
  expect(s.n2.exists()).toBe(true);
  await settled(page);
  await expect(region(page)).toHaveAttribute('data-calendar-month', NOVEMBER_2026);
  expect(page.url()).toBe(startUrl);
  expect(await page.evaluate(() => history.length)).toBe(historyLength);

  const editDialog = await openReleaseDialog(page, s.n2);
  await expect(editDialog.locator('[data-dialog-status]')).toContainText(DELETE_STILL_PRESENT);
  await expect(editDialog.locator('[data-release-delete-check]')).toBeVisible();
  await page.keyboard.press('Escape');
  expect(control.errors).toEqual([]);
  await mutation.stop();
});

test('Late verification CASE 4: an older Delete Check again 200 arrives after a newer confirmed Archive of A; the Archive confirmation stays', async ({ page }) => {
  const s = seedServerYear();
  const control = watch(page);
  const bReads = watchEditReads(page, s.n2);
  await startNovemberOnDecember31(page, s);
  const startUrl = page.url();
  const historyLength = await page.evaluate(() => history.length);
  const { mutation, verification } = await heldCheckAgainFor(page, s, 'delete');

  await archiveNovemberRelease(page, control, s.n1);
  const confirmation = `Release “${s.n1.title}” archived.`;
  await expect(feedbackText(page)).toHaveText(confirmation);
  await settled(page);
  await expectEntries(page, [s.n2]);
  const focusBefore = await activeDescription(page);

  await verification.deliver(200);
  await expect(feedbackText(page)).toHaveText(confirmation);
  await expect(feedbackNotice(page)).toHaveClass(/notice--success/);
  await expect(feedbackNotice(page).locator('button')).toHaveCount(0);
  expect(await activeDescription(page)).toBe(focusBefore);
  expect(bFetchReads(bReads)).toEqual(['GET', 'GET', 'GET']);
  expect(releasePosts(control).map((post) => post.path)).toEqual([`/releases/${s.n2.id}/delete`, `/releases/${s.n1.id}/archive`]);
  expect(mutation.lost).toHaveLength(1);
  expect(s.n1.archived()).toBe(true);
  expect(s.n2.exists()).toBe(true);
  expect(s.n2.archived()).toBe(false);
  await settled(page);
  await expect(region(page)).toHaveAttribute('data-calendar-month', NOVEMBER_2026);
  await expectEntries(page, [s.n2]);
  expect(page.url()).toBe(startUrl);
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
  expect(control.errors).toEqual([]);
  await mutation.stop();
});

test('Late verification OBSERVED ARCHIVE: the lost Archive reaches the server late; B\'s held Check again observes it archived; Calendar re-reads November, the newer Edit report stays', async ({ page }) => {
  const s = seedServerYear();
  const control = watch(page);
  const bReads = watchEditReads(page, s.n2);
  await startNovemberOnDecember31(page, s);
  const startUrl = page.url();
  const historyLength = await page.evaluate(() => history.length);
  const { mutation, verification } = await heldCheckAgainFor(page, s, 'archive');

  await editReleaseA(page, s.n1, 'Late Verification Edited One');
  const editReport = await feedbackText(page).textContent();
  await expectEntries(page, [s.n1, s.n2]);
  // The one lost Archive request runs on the server now.
  await mutation.arrive();
  expect(s.n2.archived()).toBe(true);
  const getsBefore = control.gets.length;

  // B's real verification GET answers 409 RELEASE_ARCHIVED.
  await verification.deliver(409);
  await settled(page);
  // Calendar re-read November (GET only, every filter kept) and B left it.
  const reread = control.gets.slice(getsBefore);
  expect(reread).toHaveLength(1);
  expect(reread[0].searchParams.getAll('month')).toEqual([NOVEMBER_2026]);
  expectRepeated(reread[0].href, 'project', [s.p1.id, s.p2.id]);
  expectRepeated(reread[0].href, 'type', ['comic', 'images']);
  expect(reread[0].searchParams.get('weekStart')).toBe('sunday');
  await expectEntries(page, [s.n1]);
  // The newer Edit report is untouched.
  await expect(feedbackText(page)).toHaveText(editReport);
  await expect(feedbackNotice(page).locator('button')).toHaveCount(0);
  await expect(page.locator('[data-live-filter-failure]')).toHaveCount(0);
  expect(page.url()).toBe(startUrl);
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
  // The page sent one Archive POST and one Edit POST; B's reads were GETs.
  expect(releasePosts(control).map((post) => post.path)).toEqual([`/releases/${s.n2.id}/archive`, `/releases/${s.n1.id}`]);
  expect(bFetchReads(bReads)).toEqual(['GET', 'GET', 'GET']);
  expect(s.n1.archived()).toBe(false);
  expect(control.errors).toEqual([]);
  await mutation.stop();
});

test('Late verification OBSERVED DELETE: after a newer Edit and Previous to October, B\'s held Check again finds it gone (404); Calendar re-reads October, never November', async ({ page }) => {
  const s = seedServerYear();
  const control = watch(page);
  const bReads = watchEditReads(page, s.n2);
  await startNovemberOnDecember31(page, s);
  const historyLength = await page.evaluate(() => history.length);
  const { mutation, verification } = await heldCheckAgainFor(page, s, 'delete');

  await editReleaseA(page, s.n1, 'Late Verification Edited One');
  const editReport = await feedbackText(page).textContent();
  await page.locator('#calendar-previous').click();
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2026-10');
  await settled(page);
  await expectEntries(page, [s.o1]);
  const octoberUrl = page.url();
  expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);
  await mutation.arrive();
  expect(s.n2.exists()).toBe(false);
  const getsBefore = control.gets.length;

  await verification.deliver(404);
  await settled(page);
  const reread = control.gets.slice(getsBefore);
  expect(reread).toHaveLength(1);
  expect(reread[0].searchParams.getAll('month')).toEqual(['2026-10']);
  expectRepeated(reread[0].href, 'project', [s.p1.id, s.p2.id]);
  await expect(region(page)).toHaveAttribute('data-calendar-month', '2026-10');
  await expectEntries(page, [s.o1]);
  await expect(feedbackText(page)).toHaveText(editReport);
  await expect(feedbackNotice(page).locator('button')).toHaveCount(0);
  expect(page.url()).toBe(octoberUrl);
  expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);
  expect(control.gets.slice(getsBefore).some((url) => url.searchParams.get('month') === NOVEMBER_2026)).toBe(false);
  expect(releasePosts(control).map((post) => post.path)).toEqual([`/releases/${s.n2.id}/delete`, `/releases/${s.n1.id}`]);
  expect(bFetchReads(bReads)).toEqual(['GET', 'GET', 'GET']);
  expect(control.errors).toEqual([]);
  await mutation.stop();
});

// Calendar Correction M1 (P2): page feedback, its recovery controls and focus
// have one owner. An older unresolved Archive / Delete of B loses its
// page-level Check again to a newer Edit of A; reopening B uses B's dialog
// only, and a terminal reopen read settles B without reclaiming A's report.
// (P3): an older nonterminal verification failure never downgrades a newer
// same-release result.
const ARCHIVE_OBSERVED = 'The release is archived now, but this page could not confirm whether that Archive request archived it.';
const DELETE_OBSERVED = 'This release no longer exists, but this page could not confirm whether that Delete request deleted it.';
const CHECK_FAILED = 'The release could not be checked.';
const releaseFeedbackChecks = (page) => feedbackNotice(page)
  .locator('[data-release-archive-feedback-check], [data-release-delete-feedback-check]');

/** Opens B's Edit Release dialog whose load is refused (B archived or gone). */
async function openRefusedReleaseDialog(page, release, status) {
  const editDialog = page.locator('#release-edit-dialog');
  const answered = page.waitForResponse((response) => new URL(response.url()).pathname === `/releases/${release.id}/edit`
    && response.request().resourceType() === 'fetch');
  await page.locator(`[data-calendar-info-trigger][aria-controls="calendar-info-grid-${release.id}"]`).click();
  await page.locator(`#calendar-info-grid-${release.id} [data-release-edit-id="${release.id}"]`).click();
  expect((await answered).status()).toBe(status);
  await expect(editDialog).toBeVisible();
  return editDialog;
}

for (const kind of ['archive', 'delete']) {
  const still = kind === 'archive' ? ARCHIVE_STILL_ACTIVE : DELETE_STILL_PRESENT;
  test(`Correction M1 CASE ${kind === 'archive' ? 1 : 2}: ${kind} B unresolved, Edit A refresh fails, reopen and dismiss B: only A's Retry sits under A's notice and recovers by keyboard`, async ({ page }) => {
    const s = seedServerYear();
    const control = watch(page);
    const bReads = watchEditReads(page, s.n2);
    await startNovemberOnDecember31(page, s);
    const startUrl = page.url();
    const historyLength = await page.evaluate(() => history.length);
    const mutation = await lostReleaseMutation(page, s.n2, kind);
    await expect(releaseFeedbackChecks(page)).toHaveCount(1);

    // A newer Edit of A takes the feedback: B's old page Check again is retired.
    await editReleaseA(page, s.n1, 'Ownership Edited One', { refreshFails: true });
    const retry = feedbackNotice(page).locator('[data-calendar-edit-refresh-retry]');
    await expect(retry).toBeVisible();
    await expect(releaseFeedbackChecks(page)).toHaveCount(0);
    await expect(feedbackNotice(page).locator('button')).toHaveCount(1);

    // Reopening B shows B's result and Check again in B's dialog only.
    const editDialog = await openReleaseDialog(page, s.n2);
    await expect(editDialog.locator('[data-dialog-status]')).toContainText(still);
    await expect(editDialog.locator(`[data-release-${kind}-check]`)).toBeVisible();
    await expect(feedbackText(page)).toHaveText(STALE_EDIT_TEXT);
    await expect(releaseFeedbackChecks(page)).toHaveCount(0);
    await expect(feedbackNotice(page).locator('button')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(editDialog).toBeHidden();
    await expect(feedbackText(page)).toHaveText(STALE_EDIT_TEXT);
    await expect(feedbackNotice(page).locator('button')).toHaveCount(1);
    await expect(releaseFeedbackChecks(page)).toHaveCount(0);

    // Keyboard: Tab from A's Retry never reaches a B page control.
    await retry.focus();
    await expect(retry).toBeFocused();
    await page.keyboard.press('Tab');
    expect(await activeDescription(page)).not.toMatch(/feedback-check/);
    await retry.focus();
    const getsBefore = control.gets.length;
    await page.keyboard.press('Enter');
    await expect(feedbackText(page)).toHaveText('Release updated.');
    await settled(page);
    await expect(feedbackNotice(page).locator('button')).toHaveCount(0);
    const reread = control.gets.slice(getsBefore);
    expect(reread).toHaveLength(1);
    expect(reread[0].searchParams.getAll('month')).toEqual([NOVEMBER_2026]);
    expectRepeated(reread[0].href, 'project', [s.p1.id, s.p2.id]);
    expectRepeated(reread[0].href, 'type', ['comic', 'images']);
    expect(page.url()).toBe(startUrl);
    expect(await page.evaluate(() => history.length)).toBe(historyLength);

    // Load, first verification, reopen load: GETs only. One B POST, one Edit POST.
    expect(bFetchReads(bReads)).toEqual(['GET', 'GET', 'GET']);
    expect(releasePosts(control).map((post) => post.path)).toEqual([`/releases/${s.n2.id}/${kind}`, `/releases/${s.n1.id}`]);
    expect(mutation.lost).toHaveLength(1);
    expect(s.n2.exists()).toBe(true);
    expect(s.n2.archived()).toBe(false);
    expect(control.errors).toEqual([]);
    await mutation.stop();
  });
}

for (const kind of ['archive', 'delete']) {
  const terminal = kind === 'archive' ? 409 : 404;
  const observed = kind === 'archive' ? ARCHIVE_OBSERVED : DELETE_OBSERVED;
  const refusal = kind === 'archive' ? 'Archived releases are read-only.' : 'Release not found.';
  test(`Correction M1 CASE ${kind === 'archive' ? 3 : 4}: after a newer Edit A success, reopening ${kind} B reads a real ${terminal}: B settles, Calendar re-reads data only, A's report stays`, async ({ page }) => {
    const s = seedServerYear();
    const control = watch(page);
    const bReads = watchEditReads(page, s.n2);
    await startNovemberOnDecember31(page, s);
    const startUrl = page.url();
    const historyLength = await page.evaluate(() => history.length);
    const mutation = await lostReleaseMutation(page, s.n2, kind);

    await editReleaseA(page, s.n1, 'Ownership Edited One');
    const editReport = await feedbackText(page).textContent();
    expect(editReport).not.toContain(observed);
    await expect(feedbackNotice(page).locator('button')).toHaveCount(0);
    await expectEntries(page, [s.n1, s.n2]);
    // The one lost request runs on the server now.
    await mutation.arrive();
    if (kind === 'archive') expect(s.n2.archived()).toBe(true);
    else expect(s.n2.exists()).toBe(false);
    const getsBefore = control.gets.length;

    const editDialog = await openRefusedReleaseDialog(page, s.n2, terminal);
    // B's dialog shows the server's own refusal of the read.
    await expect(editDialog.locator('[data-dialog-status]')).toHaveText(refusal);
    await settled(page);
    // B's record settled with its observation; Calendar re-read November
    // (GET only) and B left it.
    const record = await page.evaluate(({ id, key }) => {
      const found = document[key]?.records.get(String(id));
      return found ? { phase: found.phase, message: found.message } : null;
    }, { id: s.n2.id, key: kind === 'archive' ? '__creatorCrateReleaseArchive' : '__creatorCrateReleaseDelete' });
    expect(record.phase).toBe(kind === 'archive' ? 'archived' : 'missing');
    expect(record.message).toContain(observed);
    const reread = control.gets.slice(getsBefore);
    expect(reread).toHaveLength(1);
    expect(reread[0].searchParams.getAll('month')).toEqual([NOVEMBER_2026]);
    expectRepeated(reread[0].href, 'project', [s.p1.id, s.p2.id]);
    expectRepeated(reread[0].href, 'type', ['comic', 'images']);
    await expectEntries(page, [s.n1]);
    // A's report, without any B control, is untouched; focus stays in B's dialog.
    await expect(feedbackText(page)).toHaveText(editReport);
    await expect(feedbackNotice(page).locator('button')).toHaveCount(0);
    expect(await page.evaluate(() => document.getElementById('release-edit-dialog').contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(editDialog).toBeHidden();
    await expect(feedbackText(page)).toHaveText(editReport);
    await nextFrame(page);
    // Closing B never moves focus into the page feedback (A's report or a B control).
    expect(await activeDescription(page)).not.toMatch(/feedback-check|calendar-edit-refresh-retry/);
    expect(page.url()).toBe(startUrl);
    expect(await page.evaluate(() => history.length)).toBe(historyLength);
    expect(bFetchReads(bReads)).toEqual(['GET', 'GET', 'GET']);
    expect(releasePosts(control).map((post) => post.path)).toEqual([`/releases/${s.n2.id}/${kind}`, `/releases/${s.n1.id}`]);
    expect(s.n1.archived()).toBe(false);
    expect(control.errors).toEqual([]);
    await mutation.stop();
  });
}

test('Correction M1 CASE 5: an older Archive verification 503 released after a newer dialog Check again 200 never downgrades the newer result', async ({ page }) => {
  const s = seedServerYear();
  const control = watch(page);
  const bReads = watchEditReads(page, s.n2);
  await startNovemberOnDecember31(page, s);
  const startUrl = page.url();
  const mutation = await lostReleaseMutation(page, s.n2, 'archive');

  // Hold the next verification GET; it will answer 503. Later reads are real.
  let openOld;
  const oldGate = new Promise((resolve) => { openOld = resolve; });
  let held = 0;
  const matcher = (url) => url.pathname === `/releases/${s.n2.id}/edit`;
  await page.route(matcher, async (route) => {
    if (route.request().resourceType() !== 'fetch' || held > 0) return route.continue();
    held += 1;
    await oldGate;
    return route.fulfill({
      status: 503, contentType: 'application/json', body: JSON.stringify({ status: 'error', message: 'Service unavailable' }),
    }).catch(() => {});
  });
  await mutation.check.click();
  await expect.poll(() => held).toBe(1);
  await expect(feedbackText(page)).toContainText(CHECKING);

  const editDialog = await openReleaseDialog(page, s.n2);
  const dialogCheck = editDialog.locator('[data-release-archive-check]');
  await expect(dialogCheck).toBeVisible();
  const newer = page.waitForResponse((response) => matcher(new URL(response.url())) && response.status() === 200
    && response.request().resourceType() === 'fetch');
  await dialogCheck.click();
  await newer;
  await expect(editDialog.locator('[data-dialog-status]')).toContainText(ARCHIVE_STILL_ACTIVE);
  await expect(feedbackText(page)).toContainText(ARCHIVE_STILL_ACTIVE);

  const older = page.waitForResponse((response) => matcher(new URL(response.url())) && response.status() === 503);
  openOld();
  await older;
  await nextFrame(page);
  await nextFrame(page);
  await expect(editDialog.locator('[data-dialog-status]')).toContainText(ARCHIVE_STILL_ACTIVE);
  await expect(editDialog.locator('[data-dialog-status]')).not.toContainText(CHECK_FAILED);
  await expect(editDialog.locator('[data-release-archive-check]')).toBeVisible();
  await expect(feedbackText(page)).toContainText(ARCHIVE_STILL_ACTIVE);
  await expect(feedbackText(page)).not.toContainText(CHECK_FAILED);
  const phase = await page.evaluate((id) => document.__creatorCrateReleaseArchive?.records.get(String(id))?.phase, s.n2.id);
  expect(phase).toBe('unresolved');
  // Load, first verification, held check, reopen load, dialog check: GETs only.
  expect(bFetchReads(bReads)).toEqual(['GET', 'GET', 'GET', 'GET', 'GET']);
  expect(releasePosts(control).map((post) => post.path)).toEqual([`/releases/${s.n2.id}/archive`]);
  expect(mutation.lost).toHaveLength(1);
  expect(s.n2.archived()).toBe(false);
  expect(page.url()).toBe(startUrl);
  await page.keyboard.press('Escape');
  await expect(editDialog).toBeHidden();
  expect(control.errors).toEqual([]);
  await page.unroute(matcher);
  await mutation.stop();
});
