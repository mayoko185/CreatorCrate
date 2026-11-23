import { expect, test } from '@playwright/test';
import {
  MONTH, calendarUrl, checkedValues, choose, closeDialog, closeDropdown, createCalendarFixture, dialog, dropdown,
  enhanced, expectEntries, expectRepeated, openDialog, openDropdown, query, settled, summaryText, watch,
} from './calendar-filters-defaults-fixture.js';

// WP14b 5–12 and the WP13 legacy-control gap: the searchable Projects and
// Project Types multi-selects as the only Project/Type authority (repeated
// URL values, OR within a list, AND across lists and release status),
// unrestricted Select all, choices hidden by the option search, and month
// navigation, Today, reload and Back/Forward keeping the selections — all
// against the real displayed Calendar entries.

const fixture = createCalendarFixture('calendar-fd-selection');

test.beforeAll(async () => {
  await fixture.start();
});

test.afterAll(async () => {
  await fixture.stop();
});

function seed() {
  fixture.isolate();
  const comic = fixture.project('Sel Comic', { projectType: 'comic' });
  const comicTwo = fixture.project('Sel Comic Two', { projectType: 'comic' });
  const anim = fixture.project('Sel Anim', { projectType: 'animation', archived: true });
  const images = fixture.project('Sel Images', { projectType: 'images' });
  return {
    comic,
    comicTwo,
    anim,
    images,
    c1: fixture.release(comic, 'Sel Comic One', { planned: `${MONTH}-10` }),
    c2: fixture.release(comicTwo, 'Sel Comic Two One', { planned: `${MONTH}-11` }),
    // Published: shown on its published date (planned date ignored).
    cp: fixture.release(comic, 'Sel Comic Published', { planned: `${MONTH}-02`, published: `${MONTH}-15` }),
    a1: fixture.release(anim, 'Sel Anim One', { planned: `${MONTH}-12` }),
    i1: fixture.release(images, 'Sel Images One', { planned: `${MONTH}-13` }),
    next: fixture.release(comic, 'Sel Comic Next Month', { planned: '2031-08-05' }),
  };
}

async function start(page, url = calendarUrl(fixture.baseURL, { month: MONTH })) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(url);
  await enhanced(page);
}

const UNKNOWN_PROJECT = '900000';
const unknownUrl = (params = {}) => calendarUrl(fixture.baseURL, {
  month: MONTH, status: 'all', view: 'list', weekStart: 'monday', project: UNKNOWN_PROJECT, ...params,
});
const projects = (page) => dropdown(page, 'calendar-project-filter');
const selectAllProjects = (page) => projects(page).locator('input[data-cc-dropdown-select-all]');

async function expectProjectRestriction(page, ids = [UNKNOWN_PROJECT]) {
  const label = ids.length === 1 ? '1 project selected' : `${ids.length} projects selected`;
  await expect(projects(page).locator('summary')).toHaveAttribute('aria-label', `Projects filter: ${label}`);
  await expect(selectAllProjects(page)).not.toBeChecked();
  await expect.poll(() => page.locator('#calendar-filters').evaluate((form) => new FormData(form).getAll('project').sort()))
    .toEqual(ids.map(String).sort());
  expectRepeated(page.url(), 'project', ids);
}

test('unknown Project is restrictive on direct List load and one Select all clears it', async ({ page }) => {
  const s = seed();
  expect(fixture.state.db.prepare('SELECT id FROM projects WHERE id = ?').get(UNKNOWN_PROJECT)).toBeUndefined();
  const control = watch(page);
  await start(page, calendarUrl(fixture.baseURL, { month: MONTH, project: UNKNOWN_PROJECT, view: 'list' }));
  await expectEntries(page, []);
  const agenda = page.locator('.calendar-view-list .calendar-agenda');
  await expect(agenda).toBeAttached();
  await expect(agenda.locator('.agenda-release')).toHaveCount(0);
  await expect(page.getByText('No releases match these filters.')).toBeVisible();
  expect(control.documents).toHaveLength(1);
  await openDialog(page);
  await expectProjectRestriction(page);
  await expect(projects(page).locator('[data-cc-dropdown-summary-current]')).toHaveText('1 project selected');
  await expect(projects(page).locator(`input[value="${UNKNOWN_PROJECT}"]`)).toHaveCount(0);
  await choose(page, 'calendar-project-filter', 'Select all');
  await expectEntries(page, [s.c1, s.c2, s.cp, s.a1, s.i1]);
  await expect(agenda.locator('.agenda-release:visible')).toHaveCount(5);
  expect(query(page).has('project')).toBe(false);
  await expect(projects(page).locator('summary')).toHaveAttribute('aria-label', 'Projects filter: All projects');
  await expect(selectAllProjects(page)).toBeChecked();
  expect(control.gets).toHaveLength(1);
  expect(control.gets[0].searchParams.has('project')).toBe(false);
  expect(control.posts).toEqual([]);
});

test('known and unknown Projects stay selected through status, Type, view and week start edits', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  const selected = [s.comic.id, UNKNOWN_PROJECT];
  await start(page, unknownUrl({ project: selected }));
  await expectEntries(page, [s.c1, s.cp]);
  await openDialog(page);
  await expectProjectRestriction(page, selected);
  await page.locator('#calendar-filters').evaluate((form) => {
    const empty = form.ownerDocument.createElement('input');
    empty.type = 'hidden';
    empty.name = 'project';
    form.appendChild(empty);
  });
  await choose(page, 'calendar-status-filter', 'Planned');
  await expectEntries(page, [s.c1]);
  await choose(page, 'calendar-type-filter', 'Comic');
  await choose(page, 'calendar-view-filter', 'Calendar');
  await choose(page, 'calendar-week-start-filter', 'Sunday');
  await expectProjectRestriction(page, selected);
  await expectEntries(page, [s.c1]);
  await expect(page.locator('.calendar-view-grid .calendar-scroll')).toBeVisible();
  expect(control.gets).toHaveLength(4);
  for (const url of control.gets) expectRepeated(url.href, 'project', selected);
  expect(control.gets.at(-1).searchParams.get('weekStart')).toBe('sunday');
  expect(control.posts).toEqual([]);
});

test('unknown Project survives month navigation, history, failed GET Retry, reload and defaults', async ({ page }) => {
  seed();
  const control = watch(page);
  const original = unknownUrl();
  await start(page, original);
  const region = page.locator('[data-calendar-live-region]');
  const unknownMonth = async (month) => {
    await expect(region).toHaveAttribute('data-calendar-month', month);
    await settled(page);
    await expectProjectRestriction(page);
    await expectEntries(page, []);
  };
  const next = (url) => url.pathname === '/calendar' && url.searchParams.get('month') === '2031-08';
  await page.route(next, async (route) => {
    if (route.request().resourceType() === 'fetch') await route.abort();
    else await route.fallback();
  }, { times: 1 });
  await page.locator('#calendar-next').click();
  const retry = page.locator('[data-live-filter-retry]').first();
  await expect(retry).toBeVisible();
  await expect(region).toHaveAttribute('data-calendar-month', MONTH);
  await expectEntries(page, []);
  await retry.click();
  await unknownMonth('2031-08');
  expect(control.gets.map((url) => url.searchParams.get('month'))).toEqual(['2031-08', '2031-08']);
  await page.goBack({ waitUntil: 'commit' });
  await unknownMonth(MONTH);
  expect(page.url()).toBe(original);
  await page.goForward({ waitUntil: 'commit' });
  await unknownMonth('2031-08');
  await page.reload();
  await enhanced(page);
  await unknownMonth('2031-08');

  await page.locator('#calendar-previous').click();
  await unknownMonth(MONTH);
  const currentMonth = await region.getAttribute('data-calendar-current-month');
  await page.locator('#calendar-today').click();
  await unknownMonth(currentMonth);

  const picker = page.locator('#calendar-month-dialog');
  await page.locator('.calendar-month-trigger').click();
  await expect(picker).toBeVisible();
  await picker.locator('#calendar-month-year').fill('2031');
  await picker.locator('#calendar-month-year').press('Enter');
  await unknownMonth(`2031-${currentMonth.slice(5)}`);
  if (await picker.isVisible()) await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();

  await openDialog(page);
  const statusLine = dialog(page).locator('[data-settings-fetch-save-status]');
  await dialog(page).locator('[data-calendar-defaults-save]').click();
  await expect(statusLine).toHaveText('Defaults saved.');
  await unknownMonth(`2031-${currentMonth.slice(5)}`);
  expect(fixture.storedCalendarDefaults()).toEqual({ view: 'list', status: 'all', weekStart: 'monday' });
  expect(fixture.calendarKeys()).toEqual([
    'page_defaults.calendar.status', 'page_defaults.calendar.view', 'page_defaults.calendar.week_start',
  ]);

  await dialog(page).locator('[data-calendar-defaults-reset]').click();
  const confirmation = page.locator('#app-confirmation-dialog');
  if (await confirmation.isVisible()) await confirmation.locator('[data-app-dialog-confirmation-confirm]').click();
  await expect(statusLine).toHaveText('Defaults reset to the application defaults.');
  await unknownMonth(`2031-${currentMonth.slice(5)}`);
  expect(fixture.calendarKeys()).toEqual([]);
  expect(control.posts.map(({ path }) => path)).toEqual(['/calendar/defaults', '/calendar/defaults/reset']);
  for (const post of control.posts) expectRepeated(post.body.get('returnTo'), 'project', [UNKNOWN_PROJECT]);
  for (const url of control.gets) expectRepeated(url.href, 'project', [UNKNOWN_PROJECT]);

  const beforeReset = control.gets.length;
  await dialog(page).locator('[data-calendar-filters-reset]').click();
  await expect.poll(() => query(page).has('project')).toBe(false);
  await settled(page);
  await expect(selectAllProjects(page)).toBeChecked();
  expect(control.gets).toHaveLength(beforeReset + 1);
  expect([...control.gets.at(-1).searchParams]).toEqual([['month', `2031-${currentMonth.slice(5)}`]]);
  expect(control.posts).toHaveLength(2);
  await closeDialog(page);
  expect(control.errors).toEqual([]);
});

async function noHiddenSelections(page) {
  await expect(page.locator('input[type="hidden"][name="project"], input[type="hidden"][name="type"]')).toHaveCount(0);
}

test('5–8, 12 and the WP13 gap: Projects OR, Types AND, status, third Project, deselect one, Select all', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  await start(page);
  await openDialog(page);
  await expectEntries(page, [s.c1, s.c2, s.cp, s.a1, s.i1]);
  // Calendar's all-Project option source, archived Projects included.
  const projectLabels = await dropdown(page).locator('.asset-filter-multiselect-option label > span').allTextContents();
  expect(projectLabels.map((label) => label.trim())).toEqual(expect.arrayContaining([
    'Select all', s.comic.title, s.comicTwo.title, `${s.anim.title} Archived`, s.images.title,
  ]));

  // One, then two Projects (OR).
  await choose(page, 'calendar-project-filter', s.comic.title);
  expectRepeated(page.url(), 'project', [s.comic.id]);
  await expectEntries(page, [s.c1, s.cp]);
  await choose(page, 'calendar-project-filter', s.comicTwo.title);
  expectRepeated(page.url(), 'project', [s.comic.id, s.comicTwo.id]);
  await expectEntries(page, [s.c1, s.c2, s.cp]);
  expect(await summaryText(page, 'calendar-project-filter')).toBe('2 projects selected');

  // Types AND Projects: Animation excludes both comic Projects; Comic keeps them.
  await choose(page, 'calendar-type-filter', 'Animation');
  expectRepeated(page.url(), 'type', ['animation']);
  await expectEntries(page, []);
  await expect(page.getByText('No releases match these filters.')).toBeVisible();
  await choose(page, 'calendar-type-filter', 'Comic');
  expectRepeated(page.url(), 'type', ['animation', 'comic']);
  await expectEntries(page, [s.c1, s.c2, s.cp]);

  // WP13 gap: changing release status keeps both Projects selected.
  await choose(page, 'calendar-status-filter', 'Planned');
  expect(query(page).get('status')).toBe('planned');
  expectRepeated(page.url(), 'project', [s.comic.id, s.comicTwo.id]);
  expect((await checkedValues(page, 'calendar-project-filter')).sort()).toEqual([String(s.comic.id), String(s.comicTwo.id)].sort());
  await expectEntries(page, [s.c1, s.c2]);
  await choose(page, 'calendar-status-filter', 'Published');
  await expectEntries(page, [s.cp]);
  await choose(page, 'calendar-status-filter', 'All releases');

  // A third Project is added (multi-select rule), not a replacement.
  await choose(page, 'calendar-project-filter', s.images.title);
  expectRepeated(page.url(), 'project', [s.comic.id, s.comicTwo.id, s.images.id]);
  // Images is excluded by the Types (Animation, Comic) until Types are unrestricted.
  await expectEntries(page, [s.c1, s.c2, s.cp]);
  await choose(page, 'calendar-type-filter', 'Select all');
  expect(query(page).getAll('type')).toEqual([]);
  expect(await summaryText(page, 'calendar-type-filter')).toBe('All types');
  await expectEntries(page, [s.c1, s.c2, s.cp, s.i1]);

  // Deselecting one removes only that ID.
  await choose(page, 'calendar-project-filter', s.comicTwo.title);
  expectRepeated(page.url(), 'project', [s.comic.id, s.images.id]);
  await expectEntries(page, [s.c1, s.cp, s.i1]);

  // Select all removes every Project restriction; no stale value survives.
  await choose(page, 'calendar-project-filter', 'Select all');
  expect(query(page).getAll('project')).toEqual([]);
  expect(await checkedValues(page, 'calendar-project-filter')).toEqual(['']);
  expect(await summaryText(page, 'calendar-project-filter')).toBe('All projects');
  await expectEntries(page, [s.c1, s.c2, s.cp, s.a1, s.i1]);
  await noHiddenSelections(page);
  // Every live GET asked for exactly what was selected (no empty values), and
  // the last one is the installed URL.
  for (const url of control.gets) {
    expect([...url.searchParams.values()].includes('')).toBe(false);
  }
  expect(control.gets.at(-1).search).toBe(new URL(page.url()).search);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);

  function dropdown(target) {
    return target.locator('#calendar-project-filter');
  }
});

test('4, 9: keyboard-only search and selection; selections hidden by the option search are kept', async ({ page }) => {
  const s = seed();
  await start(page);
  await openDialog(page);

  // Keyboard: open Projects from its summary, type a search, choose by Space.
  await page.locator('#calendar-project-filter > summary').focus();
  await page.keyboard.press('Enter');
  const projects = page.locator('#calendar-project-filter');
  await expect(projects).toHaveJSProperty('open', true);
  const search = projects.locator('[data-cc-dropdown-search]');
  await search.focus();
  await page.keyboard.type('Comic Two');
  await expect(projects.locator(`input[value="${s.comic.id}"]`)).toBeHidden();
  const comicTwo = projects.locator(`input[value="${s.comicTwo.id}"]`);
  await expect(comicTwo).toBeVisible();
  await comicTwo.focus();
  await page.keyboard.press('Space');
  await settled(page);
  expectRepeated(page.url(), 'project', [s.comicTwo.id]);
  await expectEntries(page, [s.c2]);

  // The typed search survives the live install; a different search hides the
  // checked choice, which keeps submitting when another one is chosen.
  await expect(page.locator('#calendar-project-filter [data-cc-dropdown-search]')).toHaveValue('Comic Two');
  const searchAgain = page.locator('#calendar-project-filter [data-cc-dropdown-search]');
  await searchAgain.fill('Images');
  await expect(page.locator(`#calendar-project-filter input[value="${s.comicTwo.id}"]`)).toBeHidden();
  const images = page.locator(`#calendar-project-filter input[value="${s.images.id}"]`);
  await images.focus();
  await page.keyboard.press('Space');
  await settled(page);
  expectRepeated(page.url(), 'project', [s.comicTwo.id, s.images.id]);
  await expectEntries(page, [s.c2, s.i1]);
  // Escape closes the dropdown before the dialog.
  await page.keyboard.press('Escape');
  await expect(page.locator('#calendar-project-filter')).toHaveJSProperty('open', false);
  await expect(dialog(page)).toBeVisible();

  // Project Types by keyboard search too: hidden checked Types keep submitting.
  await page.locator('#calendar-type-filter > summary').focus();
  await page.keyboard.press('Enter');
  const types = page.locator('#calendar-type-filter');
  await types.locator('[data-cc-dropdown-search]').fill('Ima');
  await types.locator('input[value="images"]').focus();
  await page.keyboard.press('Space');
  await settled(page);
  await types.locator('[data-cc-dropdown-search]').fill('Com');
  await expect(types.locator('input[value="images"]')).toBeHidden();
  await types.locator('input[value="comic"]').focus();
  await page.keyboard.press('Space');
  await settled(page);
  expectRepeated(page.url(), 'type', ['comic', 'images']);
  await expectEntries(page, [s.c2, s.i1]);
  await closeDropdown(page, 'calendar-type-filter');
});

test('10, 11: Previous/Next, Today, month picker, reload and Back/Forward keep repeated selections', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  const url = calendarUrl(fixture.baseURL, {
    month: MONTH, status: 'planned', weekStart: 'sunday', project: [s.comicTwo.id, s.comic.id], type: 'comic',
  });
  await start(page, url);
  await expectEntries(page, [s.c1, s.c2]);
  const expectContext = () => {
    expectRepeated(page.url(), 'project', [s.comic.id, s.comicTwo.id]);
    expectRepeated(page.url(), 'type', ['comic']);
    expect(query(page).get('status')).toBe('planned');
    expect(query(page).get('weekStart')).toBe('sunday');
  };

  await page.locator('#calendar-next').click();
  await settled(page);
  await expect.poll(() => query(page).get('month')).toBe('2031-08');
  expectContext();
  await expectEntries(page, [s.next]);

  await page.locator('#calendar-previous').click();
  await settled(page);
  await expect.poll(() => query(page).get('month')).toBe(MONTH);
  expectContext();
  await expectEntries(page, [s.c1, s.c2]);

  // Month picker: August through the picker dialog.
  await page.locator('.calendar-month-trigger').click();
  const picker = page.locator('#calendar-month-dialog');
  await expect(picker).toBeVisible();
  await picker.locator('#calendar-month-select > summary').click();
  await picker.locator('#calendar-month-select label').getByText('August', { exact: true }).click();
  await settled(page);
  await expect.poll(() => query(page).get('month')).toBe('2031-08');
  expectContext();
  await expectEntries(page, [s.next]);
  if (await picker.isVisible()) await page.keyboard.press('Escape');

  // Back / Forward restore month and controls.
  await page.goBack();
  await settled(page);
  await expect.poll(() => query(page).get('month')).toBe(MONTH);
  expectContext();
  await expectEntries(page, [s.c1, s.c2]);
  await openDialog(page);
  expect((await checkedValues(page, 'calendar-project-filter')).sort()).toEqual([String(s.comic.id), String(s.comicTwo.id)].sort());
  expect(await checkedValues(page, 'calendar-type-filter')).toEqual(['comic']);
  await page.keyboard.press('Escape');
  await page.goForward();
  await settled(page);
  await expect.poll(() => query(page).get('month')).toBe('2031-08');
  await expectEntries(page, [s.next]);

  // Reload: the server renders the same selections in the dialog.
  await page.reload();
  await enhanced(page);
  expectContext();
  await expectEntries(page, [s.next]);
  await openDialog(page);
  expect(await summaryText(page, 'calendar-project-filter')).toBe('2 projects selected');
  expect(await summaryText(page, 'calendar-type-filter')).toBe('Comic');
  expect(await summaryText(page, 'calendar-status-filter')).toBe('Planned');
  expect(await summaryText(page, 'calendar-week-start-filter')).toBe('Sunday');
  await page.keyboard.press('Escape');

  // Today keeps the selections (month leaves the URL).
  await page.locator('#calendar-today').click();
  await settled(page);
  await expect.poll(() => query(page).has('month')).toBe(false);
  expectContext();
  // A status change in the dialog after navigation still keeps the Projects.
  await openDialog(page);
  await choose(page, 'calendar-status-filter', 'All releases');
  expectRepeated(page.url(), 'project', [s.comic.id, s.comicTwo.id]);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('WP13 gap: a URL with two Projects edits correctly in the visible control and submits no stale values', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  await start(page, calendarUrl(fixture.baseURL, { month: MONTH, project: [s.comic.id, s.comicTwo.id] }));
  await openDialog(page);
  await noHiddenSelections(page);
  expect((await checkedValues(page, 'calendar-project-filter')).sort()).toEqual([String(s.comic.id), String(s.comicTwo.id)].sort());
  const details = await openDropdown(page, 'calendar-project-filter');
  await expect(details.locator('input[value=""]')).not.toBeChecked();
  await closeDropdown(page, 'calendar-project-filter');
  // Select all on this page leaves no old Project value in the next GET.
  await choose(page, 'calendar-project-filter', 'Select all');
  expect(control.gets.at(-1).searchParams.getAll('project')).toEqual([]);
  expect(query(page).getAll('project')).toEqual([]);
  await expectEntries(page, [s.c1, s.c2, s.cp, s.a1, s.i1]);
});
