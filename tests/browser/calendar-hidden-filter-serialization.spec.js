import { expect, test } from '@playwright/test';
import {
  MONTH, calendarUrl, closeDropdown, createCalendarFixture, dialog, dropdown, enhanced, expectEntries, openDialog,
  openDropdown, query, settled, summaryText, watch,
} from './calendar-filters-defaults-fixture.js';

// R9 (related Calendar P3): a held Back restoring an unknown-only Project and
// Project Type keeps both in hidden intent carriers (R10: the real
// multi-selects count them as selected, Select all unchecked). A status edit
// made before the Back
// installs must keep both values in the requested URL (the server, not client
// serialization, normalizes them). A deliberate Project edit replaces only
// the Project restriction.

const fixture = createCalendarFixture('calendar-r9-hidden-serialization');
const UNKNOWN_PROJECT = 999999;
const UNKNOWN_TYPE = 'r9-unknown-type';

test.beforeAll(async () => {
  await fixture.start();
});

test.afterAll(async () => {
  await fixture.stop();
});

function seed() {
  fixture.isolate();
  const p1 = fixture.project('R9 One', { projectType: 'comic' });
  const p2 = fixture.project('R9 Two', { projectType: 'images' });
  return {
    p1,
    p2,
    planned: fixture.release(p1, 'R9 Planned', { planned: `${MONTH}-10` }),
    published: fixture.release(p2, 'R9 Published', { planned: `${MONTH}-01`, published: `${MONTH}-12` }),
  };
}

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

async function hold(page, predicate) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let markSeen;
  const seen = new Promise((resolve) => { markSeen = resolve; });
  let markDone;
  const done = new Promise((resolve) => { markDone = resolve; });
  await page.route((url) => url.pathname === '/calendar' && predicate(url), async (route) => {
    if (route.request().resourceType() !== 'fetch') {
      await route.fallback();
      return;
    }
    markSeen();
    await gate;
    await route.continue().catch(() => {});
    markDone();
  });
  return { seen, release, done };
}

async function carriers(page, name) {
  return page.locator(`input[data-calendar-intended-carrier][name="${name}"]`)
    .evaluateAll((inputs) => inputs.map((input) => input.value));
}

async function checked(page, id) {
  return page.locator(`#${id} input:checked`).evaluateAll((inputs) => inputs.map((input) => input.value));
}

async function resetThenHoldBack(page) {
  const restricted = page.url();
  await openDialog(page);
  await dialog(page).locator('[data-calendar-filters-reset]').click();
  await settled(page);
  expect(query(page).has('project')).toBe(false);
  // Only the Back GET itself: later edits legitimately carry the same values.
  const back = await hold(page, (url) => url.href === restricted);
  await page.goBack({ waitUntil: 'commit' });
  await back.seen;
  await expect.poll(() => page.url()).toBe(restricted);
  return back;
}

const restrictedUrl = () => calendarUrl(fixture.baseURL, {
  month: MONTH, project: UNKNOWN_PROJECT, type: UNKNOWN_TYPE, status: 'all', view: 'grid', weekStart: 'monday',
});

test('Back held to unknown-only Project + Type -> status Published keeps both values in the request', async ({ page }) => {
  seed();
  const control = watch(page);
  await start(page, restrictedUrl());
  const back = await resetThenHoldBack(page);
  expect(await carriers(page, 'project')).toEqual([String(UNKNOWN_PROJECT)]);
  expect(await carriers(page, 'type')).toEqual([UNKNOWN_TYPE]);
  expect(await checked(page, 'calendar-project-filter')).toEqual([]);
  expect(await checked(page, 'calendar-type-filter')).toEqual([]);

  const edited = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === '/calendar' && request.resourceType() === 'fetch' && url.searchParams.get('status') === 'published';
  });
  const details = await openDropdown(page, 'calendar-status-filter');
  await details.locator('label').getByText('Published', { exact: true }).click();
  const requested = new URL((await edited).url());
  expect(requested.searchParams.getAll('project')).toEqual([String(UNKNOWN_PROJECT)]);
  expect(requested.searchParams.getAll('type')).toEqual([UNKNOWN_TYPE]);
  expect(requested.searchParams.get('month')).toBe(MONTH);
  expect(requested.searchParams.get('view')).toBe('grid');
  expect(requested.searchParams.get('weekStart')).toBe('monday');
  await settled(page);
  // The server normalizes the unsupported Type and keeps the Project restriction.
  await expectEntries(page, []);
  await expectRestricted(page, 'calendar-project-filter', '1 project selected');

  const installed = page.url();
  back.release();
  await back.done;
  await frame(page);
  expect(page.url()).toBe(installed);
  await expectEntries(page, []);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('Back held to unknown-only Project + Type -> choosing a Project replaces only the Project', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  await start(page, restrictedUrl());
  const back = await resetThenHoldBack(page);
  const edited = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === '/calendar' && request.resourceType() === 'fetch'
      && url.searchParams.getAll('project').join() === String(s.p1.id);
  });
  const details = await openDropdown(page, 'calendar-project-filter');
  await details.locator(`input[value="${s.p1.id}"]`).check();
  const requested = new URL((await edited).url());
  expect(requested.searchParams.getAll('project')).toEqual([String(s.p1.id)]);
  expect(requested.searchParams.getAll('type')).toEqual([UNKNOWN_TYPE]);
  await settled(page);
  expect(await carriers(page, 'project')).toEqual([]);
  back.release();
  await back.done;
  await frame(page);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});

// R10: while the Back is pending (or failed / retrying) both dropdowns show a
// restriction (never All, Select all unchecked). One Select all activation
// clears only its own dimension; the other keeps its restriction.

const noProject = (url) => !url.searchParams.has('project');

function liveGet(page, predicate) {
  return page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === '/calendar' && request.resourceType() === 'fetch' && predicate(url);
  });
}

async function expectRestricted(page, id, text) {
  expect(await summaryText(page, id)).toBe(text);
  await expect(dropdown(page, id).locator('input[data-cc-dropdown-select-all]')).not.toBeChecked();
  await expect(dropdown(page, id).locator('summary')).not.toHaveAttribute('aria-label', /All (projects|types)$/);
}

async function selectAllOnce(page, id, { keyboard = false } = {}) {
  const details = await openDropdown(page, id);
  if (keyboard) {
    await details.locator('input[data-cc-dropdown-select-all]').focus();
    await page.keyboard.press('Space');
  } else {
    await details.locator('.cc-dropdown-select-all-option label').click();
  }
  await closeDropdown(page, id);
}

async function failBack(page) {
  const restricted = page.url();
  await openDialog(page);
  await dialog(page).locator('[data-calendar-filters-reset]').click();
  await settled(page);
  let markSeen;
  const seen = new Promise((resolve) => { markSeen = resolve; });
  await page.route((url) => url.pathname === '/calendar' && url.href === restricted, async (route) => {
    if (route.request().resourceType() !== 'fetch') {
      await route.fallback();
      return;
    }
    markSeen();
    await route.fulfill({ status: 503, body: 'unavailable' });
  }, { times: 1 });
  await page.goBack({ waitUntil: 'commit' });
  await seen;
  await expect(page.locator('[data-live-filter-retry]').first()).toBeVisible();
  await expect.poll(() => page.url()).toBe(restricted);
  return restricted;
}

/** Clears Projects (held, so Type is still pending-restricted), then Types. */
async function clearProjectsThenTypes(page, s, { keyboard = false } = {}) {
  await expectRestricted(page, 'calendar-project-filter', '1 project selected');
  await expectRestricted(page, 'calendar-type-filter', '1 type selected');

  const projectCleared = await hold(page, (url) => noProject(url) && url.searchParams.getAll('type').join() === UNKNOWN_TYPE);
  const projectRequest = liveGet(page, (url) => noProject(url) && url.searchParams.getAll('type').join() === UNKNOWN_TYPE);
  await selectAllOnce(page, 'calendar-project-filter', { keyboard });
  const first = new URL((await projectRequest).url());
  await projectCleared.seen;
  expect(first.searchParams.getAll('type')).toEqual([UNKNOWN_TYPE]);
  expect(first.searchParams.get('month')).toBe(MONTH);
  expect(await carriers(page, 'project')).toEqual([]);
  expect(await carriers(page, 'type')).toEqual([UNKNOWN_TYPE]);
  expect(await summaryText(page, 'calendar-project-filter')).toBe('All projects');
  await expect(dropdown(page, 'calendar-project-filter').locator('input[data-cc-dropdown-select-all]')).toBeChecked();
  await expectRestricted(page, 'calendar-type-filter', '1 type selected');

  const typeRequest = liveGet(page, (url) => noProject(url) && !url.searchParams.has('type'));
  await selectAllOnce(page, 'calendar-type-filter', { keyboard });
  const second = new URL((await typeRequest).url());
  expect(second.searchParams.get('month')).toBe(MONTH);
  await settled(page);
  expect(query(page).has('project')).toBe(false);
  expect(query(page).has('type')).toBe(false);
  expect(query(page).get('month')).toBe(MONTH);
  expect(await summaryText(page, 'calendar-project-filter')).toBe('All projects');
  expect(await summaryText(page, 'calendar-type-filter')).toBe('All types');
  expect(await page.locator('input[data-calendar-intended-carrier]').count()).toBe(0);
  return { second, projectCleared };
}

test('R10 Back held to unknown Project + Type: both restricted; clear Projects (Type stays), then Types; old responses last', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  await start(page, restrictedUrl());
  const back = await resetThenHoldBack(page);
  const { second, projectCleared } = await clearProjectsThenTypes(page, s);
  expect(second.searchParams.get('status')).toBe('all');
  expect(second.searchParams.get('view')).toBe('grid');
  expect(second.searchParams.get('weekStart')).toBe('monday');
  await expectEntries(page, [s.planned, s.published]);

  const installed = page.url();
  projectCleared.release();
  back.release();
  await projectCleared.done;
  await back.done;
  await frame(page);
  expect(page.url()).toBe(installed);
  await expectEntries(page, [s.planned, s.published]);
  expect(await summaryText(page, 'calendar-project-filter')).toBe('All projects');
  expect(await summaryText(page, 'calendar-type-filter')).toBe('All types');
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('R10 failed Back: both restricted; keyboard Space on each Select all clears them in turn', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  await start(page, restrictedUrl());
  await failBack(page);
  const { projectCleared } = await clearProjectsThenTypes(page, s, { keyboard: true });
  await expectEntries(page, [s.planned, s.published]);
  const installed = page.url();
  projectCleared.release();
  await projectCleared.done;
  await frame(page);
  expect(page.url()).toBe(installed);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('R10 failed Back -> GET-only Retry held -> clearing supersedes Retry; the late Retry never installs', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  await start(page, restrictedUrl());
  const restricted = await failBack(page);
  const retry = await hold(page, (url) => url.href === restricted);
  await page.locator('[data-live-filter-retry]').first().click();
  await retry.seen;
  const { projectCleared } = await clearProjectsThenTypes(page, s);
  await expectEntries(page, [s.planned, s.published]);
  const installed = page.url();
  projectCleared.release();
  retry.release();
  await projectCleared.done;
  await retry.done;
  await frame(page);
  expect(page.url()).toBe(installed);
  await expectEntries(page, [s.planned, s.published]);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('R10 after a status edit during the held Back both stay restricted; clearing keeps the edited status', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  await start(page, restrictedUrl());
  const back = await resetThenHoldBack(page);
  const statusHold = await hold(page, (url) => url.searchParams.get('status') === 'published'
    && url.searchParams.getAll('project').join() === String(UNKNOWN_PROJECT));
  const details = await openDropdown(page, 'calendar-status-filter');
  await details.locator('label').getByText('Published', { exact: true }).click();
  await statusHold.seen;
  const { second, projectCleared } = await clearProjectsThenTypes(page, s);
  expect(second.searchParams.get('status')).toBe('published');
  await expectEntries(page, [s.published]);
  const installed = page.url();
  statusHold.release();
  projectCleared.release();
  back.release();
  await Promise.all([statusHold.done, projectCleared.done, back.done]);
  await frame(page);
  expect(page.url()).toBe(installed);
  await expectEntries(page, [s.published]);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('R10 one visible + one hidden Project during the held Back: "2 projects selected"; one Select all clears both', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  await start(page, calendarUrl(fixture.baseURL, {
    month: MONTH, project: [s.p2.id, UNKNOWN_PROJECT], status: 'all', view: 'grid', weekStart: 'monday',
  }));
  await expectEntries(page, [s.published]);
  const back = await resetThenHoldBack(page);
  await expectRestricted(page, 'calendar-project-filter', '2 projects selected');
  expect(await summaryText(page, 'calendar-type-filter')).toBe('All types');
  const cleared = liveGet(page, noProject);
  await selectAllOnce(page, 'calendar-project-filter');
  expect((await cleared).url()).not.toContain('project=');
  await settled(page);
  expect(await summaryText(page, 'calendar-project-filter')).toBe('All projects');
  await expectEntries(page, [s.planned, s.published]);
  back.release();
  await back.done;
  await frame(page);
  await expectEntries(page, [s.planned, s.published]);
  expect(query(page).has('project')).toBe(false);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});

/*
 * P3-C1 follow-up: Calendar carriers follow their HTML form owner. A carrier
 * outside #calendar-filters that names it with form="" is submitted by that
 * form, so its dropdown shows the restriction and one Select all clears it;
 * a carrier inside #calendar-filters owned by another real form is neither
 * counted, sent nor removed by Calendar edits.
 */
async function placeCalendarCarrier(page, { where, form = null, name, value }) {
  await page.evaluate(async ({ where: target, form: owner, name: field, value: carried }) => {
    if (owner === 'p3-calendar-foreign' && !document.getElementById(owner)) {
      const foreign = document.createElement('form');
      foreign.id = owner;
      foreign.method = 'get';
      foreign.action = '/elsewhere';
      document.body.appendChild(foreign);
    }
    const carrier = document.createElement('input');
    carrier.type = 'hidden';
    carrier.name = field;
    carrier.value = carried;
    carrier.setAttribute('data-calendar-intended-carrier', '');
    carrier.setAttribute('data-cc-dropdown-carried-value', '');
    carrier.setAttribute('data-p3-ownership-carrier', carried);
    if (owner) carrier.setAttribute('form', owner);
    (target === 'body' ? document.body : document.querySelector(target)).appendChild(carrier);
    const { initializeCreatorCrateDropdown } = await import('/client/dropdowns.js');
    ['#calendar-project-filter', '#calendar-type-filter']
      .forEach((selector) => initializeCreatorCrateDropdown(document.querySelector(selector)));
  }, { where, form, name, value: String(value) });
}

async function ownedCarriers(page) {
  return page.locator('input[data-p3-ownership-carrier]').evaluateAll((inputs) => inputs.map((input) => ({
    name: input.name,
    value: input.value,
    insideFilterForm: Boolean(input.closest('#calendar-filters')),
    owner: input.form ? input.form.id : null,
  })));
}

async function formValues(page, selector, name) {
  return page.locator(selector).evaluate((form, field) => Array.from(new FormData(form).entries())
    .filter(([key, value]) => key === field && value !== '').map(([, value]) => value), name);
}

const presentationOf = (url) => ['month', 'status', 'view', 'weekStart'].map((key) => url.searchParams.get(key));

test('P3-C1 follow-up: external Type carrier restricts and one Select all clears it; a foreign-owned Project carrier survives', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  await start(page, calendarUrl(fixture.baseURL, { month: MONTH, status: 'all', view: 'list', weekStart: 'sunday' }));
  await expectEntries(page, [s.planned, s.published]);
  await openDialog(page);
  await placeCalendarCarrier(page, { where: 'body', form: 'calendar-filters', name: 'type', value: 'comic' });
  await placeCalendarCarrier(page, { where: '#calendar-filters', form: 'p3-calendar-foreign', name: 'project', value: UNKNOWN_PROJECT });
  expect((await ownedCarriers(page)).sort((left, right) => left.name.localeCompare(right.name))).toEqual([
    { name: 'project', value: String(UNKNOWN_PROJECT), insideFilterForm: true, owner: 'p3-calendar-foreign' },
    { name: 'type', value: 'comic', insideFilterForm: false, owner: 'calendar-filters' },
  ]);
  expect(await formValues(page, '#calendar-filters', 'type')).toEqual(['comic']);
  expect(await formValues(page, '#calendar-filters', 'project')).toEqual([]);
  expect(await formValues(page, '#p3-calendar-foreign', 'project')).toEqual([String(UNKNOWN_PROJECT)]);
  await expectRestricted(page, 'calendar-type-filter', '1 type selected');
  expect(await summaryText(page, 'calendar-project-filter')).toBe('All projects');
  await expect(dropdown(page, 'calendar-project-filter').locator('input[data-cc-dropdown-select-all]')).toBeChecked();

  // A Project edit sends the chosen Project + the external Type, never the foreign value.
  const gets = control.gets.length;
  const projectHold = await hold(page, (url) => url.searchParams.getAll('project').includes(String(s.p2.id))
    && url.searchParams.has('type'));
  const details = await openDropdown(page, 'calendar-project-filter');
  await details.locator('.asset-filter-multiselect-option label').getByText(s.p2.title, { exact: true }).click();
  await projectHold.seen;
  const projectEdit = control.gets[control.gets.length - 1];
  expect(projectEdit.searchParams.getAll('project')).toEqual([String(s.p2.id)]);
  expect(projectEdit.searchParams.getAll('type')).toEqual(['comic']);
  expect(presentationOf(projectEdit)).toEqual([MONTH, 'all', 'list', 'sunday']);
  // While the GET is held, the foreign carrier is still in place and still owned elsewhere.
  expect((await ownedCarriers(page)).filter((carrier) => carrier.name === 'project')).toEqual([
    { name: 'project', value: String(UNKNOWN_PROJECT), insideFilterForm: true, owner: 'p3-calendar-foreign' },
  ]);
  expect(await formValues(page, '#p3-calendar-foreign', 'project')).toEqual([String(UNKNOWN_PROJECT)]);
  await closeDropdown(page, 'calendar-project-filter');
  projectHold.release();
  await projectHold.done;
  await settled(page);
  // p2 is an Images project: restricted to comic, nothing matches.
  await expectEntries(page, []);

  // One Select all on Types clears only Types; Project, month and presentation remain.
  const cleared = liveGet(page, (url) => !url.searchParams.has('type'));
  await selectAllOnce(page, 'calendar-type-filter');
  const clearedUrl = new URL((await cleared).url());
  expect(clearedUrl.searchParams.getAll('project')).toEqual([String(s.p2.id)]);
  expect(presentationOf(clearedUrl)).toEqual([MONTH, 'all', 'list', 'sunday']);
  expect((await ownedCarriers(page)).filter((carrier) => carrier.name === 'type')).toEqual([]);
  await settled(page);
  await expectEntries(page, [s.published]);
  expect(await summaryText(page, 'calendar-type-filter')).toBe('All types');
  await expect(dropdown(page, 'calendar-type-filter').locator('input[data-cc-dropdown-select-all]')).toBeChecked();
  expect(control.gets.length).toBe(gets + 2);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('P3-C1 follow-up: external Project carrier during a held Back counts with the carried one; one Space on Select all clears both', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  await start(page, restrictedUrl());
  const back = await resetThenHoldBack(page);
  await placeCalendarCarrier(page, { where: 'body', form: 'calendar-filters', name: 'project', value: s.p1.id });
  await placeCalendarCarrier(page, { where: '#calendar-filters', form: 'p3-calendar-foreign', name: 'project', value: 777777 });
  expect((await formValues(page, '#calendar-filters', 'project')).sort())
    .toEqual([String(UNKNOWN_PROJECT), String(s.p1.id)].sort());
  await expectRestricted(page, 'calendar-project-filter', '2 projects selected');
  await expectRestricted(page, 'calendar-type-filter', '1 type selected');

  const gets = control.gets.length;
  const clearHold = await hold(page, (url) => noProject(url) && url.searchParams.get('type') === UNKNOWN_TYPE);
  await selectAllOnce(page, 'calendar-project-filter', { keyboard: true });
  await clearHold.seen;
  const clearedUrl = control.gets[control.gets.length - 1];
  expect(clearedUrl.searchParams.getAll('type')).toEqual([UNKNOWN_TYPE]);
  expect(clearedUrl.searchParams.get('month')).toBe(MONTH);
  expect(await formValues(page, '#calendar-filters', 'project')).toEqual([]);
  expect((await ownedCarriers(page)).filter((carrier) => carrier.owner === 'p3-calendar-foreign')).toEqual([
    { name: 'project', value: '777777', insideFilterForm: true, owner: 'p3-calendar-foreign' },
  ]);
  expect(await summaryText(page, 'calendar-project-filter')).toBe('All projects');
  await expect(dropdown(page, 'calendar-project-filter').locator('input[data-cc-dropdown-select-all]')).toBeChecked();
  await expectRestricted(page, 'calendar-type-filter', '1 type selected');
  clearHold.release();
  await clearHold.done;
  await settled(page);
  back.release();
  await back.done;
  await frame(page);
  expect(query(page).has('project')).toBe(false);
  expect(control.gets.length).toBe(gets + 1);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});
