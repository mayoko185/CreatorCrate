import { expect, test } from '@playwright/test';
import {
  checkedValues, createReleasesFixture, dialog, dropdown, enhanced, expectRepeated, openDialog, openDropdown, query,
  releasesUrl, renderedTitles, settled, summaryText, totalCount, watch,
} from './releases-filters-defaults-fixture.js';

// R9: while a Back / Forward GET is held, a requested Project the installed
// form has no option for travels in a hidden intent carrier (R10: the real
// multi-select counts it as selected, so Select all is unchecked and the
// summary is restricted). A later Search must keep
// that restriction (the empty placeholder never erases a nonempty value of the
// same name). A deliberate Select all still clears every Project.

const fixture = createReleasesFixture('releases-r9-hidden-serialization');
const UNKNOWN = 999999;

test.beforeAll(async () => {
  await fixture.start();
});

test.afterAll(async () => {
  await fixture.stop();
});

// `Needle fallback` matches Search=Needle but belongs to no restricted
// Project, so it appears only if the Project restriction is lost.
function seed() {
  fixture.isolate();
  fixture.writePageDefault('releases', 'sort', 'title');
  fixture.writePageDefault('releases', 'order', 'asc');
  const comic = fixture.project('R9 Comic', { projectType: 'comic' });
  const images = fixture.project('R9 Images', { projectType: 'images' });
  const archived = fixture.project('R9 Archived', { projectType: 'comic', archived: true });
  return {
    comic,
    images,
    archived,
    fallback: fixture.release(images, 'Needle fallback'),
    needleComic: fixture.release(comic, 'Needle Comic'),
    archivedNeedle: fixture.release(archived, 'Needle archived parent'),
    other: fixture.release(comic, 'Zulu other'),
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

/** Holds the live fetch GET for `predicate` until released. */
async function hold(page, predicate) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let markSeen;
  const seen = new Promise((resolve) => { markSeen = resolve; });
  let markDone;
  const done = new Promise((resolve) => { markDone = resolve; });
  const matcher = (url) => url.pathname === '/releases' && predicate(url);
  await page.route(matcher, async (route) => {
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

function waitForSearch(page, value) {
  return page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === '/releases' && request.resourceType() === 'fetch' && url.searchParams.get('search') === value;
  });
}

async function carriers(page, name) {
  return page.locator(`input[data-releases-intended-carrier][name="${name}"]`)
    .evaluateAll((inputs) => inputs.map((input) => input.value));
}

/** Titles the server returns for `url` loaded directly (no client serialization). */
async function directTitles(page, url) {
  const other = await page.context().newPage();
  await other.goto(url);
  const titles = await renderedTitles(other);
  await other.close();
  return titles.sort();
}

async function resetThenHoldBack(page, projectIds) {
  const restricted = page.url();
  await openDialog(page);
  await dialog(page).locator('[data-releases-filters-reset]').click();
  await settled(page);
  expect(query(page).has('project')).toBe(false);
  const back = await hold(page, (url) => !url.searchParams.has('search') && !url.searchParams.has('type')
    && url.searchParams.getAll('project').map(Number).sort().join() === projectIds.slice().sort().join());
  await page.goBack({ waitUntil: 'commit' });
  await back.seen;
  await expect.poll(() => page.url()).toBe(restricted);
  return back;
}

test('reviewer reproduction: Back to project=999999 held -> Search Needle keeps the restriction; the late Back never installs', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  const restricted = releasesUrl(fixture.baseURL, { project: UNKNOWN, pageSize: 10 });
  await start(page, restricted);
  expect(await renderedTitles(page)).toEqual([]);

  const back = await resetThenHoldBack(page, [UNKNOWN]);
  // R10: the hidden carrier is counted as selected: Select all is unchecked.
  expect(await carriers(page, 'project')).toEqual([String(UNKNOWN)]);
  expect(await checkedValues(page, 'release-project-filter')).toEqual([]);
  expect(await summaryText(page, 'release-project-filter')).toBe('1 project selected');

  const searched = waitForSearch(page, 'Needle');
  await page.locator('#releases-search').fill('Needle');
  const requested = new URL((await searched).url());
  expectRepeated(requested.href, 'project', [UNKNOWN]);
  expect(requested.searchParams.get('pageSize')).toBe('10');
  expect(requested.searchParams.get('search')).toBe('Needle');
  expect(requested.searchParams.has('page')).toBe(false);
  await settled(page);

  expect(await renderedTitles(page)).toEqual([]);
  await expect(page.locator('[data-releases-live-region]')).not.toContainText(s.fallback.title);
  expect(await directTitles(page, requested.href)).toEqual([]);
  expectRepeated(page.url(), 'project', [UNKNOWN]);
  expect(query(page).get('search')).toBe('Needle');
  expect(query(page).get('pageSize')).toBe('10');
  // The installed response renders the unavailable Project as a checked option.
  expect(await checkedValues(page, 'release-project-filter')).toEqual([String(UNKNOWN)]);
  expect(await summaryText(page, 'release-project-filter')).toBe(`Unavailable project (ID ${UNKNOWN})`);
  expect(await carriers(page, 'project')).toEqual([]);

  const installed = page.url();
  back.release();
  await back.done;
  await frame(page);
  expect(page.url()).toBe(installed);
  expect(await renderedTitles(page)).toEqual([]);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('archived Project restriction survives Back held -> Search and matches the direct server result', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  const restricted = releasesUrl(fixture.baseURL, { project: s.archived.id, pageSize: 10 });
  await start(page, restricted);
  const back = await resetThenHoldBack(page, [s.archived.id]);
  // Either rendered as a checked option or carried; never lost.
  const carried = await carriers(page, 'project');
  const checked = await checkedValues(page, 'release-project-filter');
  expect([...carried, ...checked.filter(Boolean)]).toEqual([String(s.archived.id)]);

  const searched = waitForSearch(page, 'Needle');
  await page.locator('#releases-search').fill('Needle');
  const requested = new URL((await searched).url());
  expectRepeated(requested.href, 'project', [s.archived.id]);
  expect(requested.searchParams.get('pageSize')).toBe('10');
  await settled(page);
  const expected = await directTitles(page, requested.href);
  expect((await renderedTitles(page)).sort()).toEqual(expected);
  expect(expected).not.toContain(s.fallback.title);
  await expect(page.locator('[data-releases-live-region]')).not.toContainText(s.fallback.title);

  back.release();
  await back.done;
  await frame(page);
  expect((await renderedTitles(page)).sort()).toEqual(expected);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('valid + unavailable Projects: Back held -> explicit Select all deliberately clears both', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  const restricted = releasesUrl(fixture.baseURL, { project: [s.comic.id, UNKNOWN], pageSize: 10 });
  await start(page, restricted);
  const back = await resetThenHoldBack(page, [s.comic.id, UNKNOWN]);
  expect(await checkedValues(page, 'release-project-filter')).toEqual([String(s.comic.id)]);
  expect(await carriers(page, 'project')).toEqual([String(UNKNOWN)]);

  const cleared = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === '/releases' && request.resourceType() === 'fetch' && !url.searchParams.has('project');
  });
  const details = await openDropdown(page, 'release-project-filter');
  await details.locator('.cc-dropdown-select-all-option label').click();
  const requested = new URL((await cleared).url());
  expect(requested.searchParams.getAll('project')).toEqual([]);
  expect(requested.searchParams.get('pageSize')).toBe('10');
  await settled(page);
  expect(await carriers(page, 'project')).toEqual([]);
  expect(await checkedValues(page, 'release-project-filter')).toEqual(['']);
  expect(await summaryText(page, 'release-project-filter')).toBe('All projects');
  expect((await renderedTitles(page)).sort()).toEqual([s.fallback.title, s.needleComic.title, s.other.title].sort());

  // A Search after the deliberate clear stays unrestricted.
  const searched = waitForSearch(page, 'Needle');
  await page.locator('#releases-search').fill('Needle');
  const composed = new URL((await searched).url());
  expect(composed.searchParams.getAll('project')).toEqual([]);
  await settled(page);
  expect((await renderedTitles(page)).sort()).toEqual([s.fallback.title, s.needleComic.title].sort());

  back.release();
  await back.done;
  await frame(page);
  expect((await renderedTitles(page)).sort()).toEqual([s.fallback.title, s.needleComic.title].sort());
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});

// R10: the pending hidden restriction is truthful in the real dropdown (summary
// is not All projects, Select all is unchecked) and one ordinary Select all
// activation (pointer or keyboard) clears it with a single GET.

/** Fails the first live GET matching `predicate` with a 503. */
async function failOnce(page, predicate) {
  let markSeen;
  const seen = new Promise((resolve) => { markSeen = resolve; });
  await page.route((url) => url.pathname === '/releases' && predicate(url), async (route) => {
    if (route.request().resourceType() !== 'fetch') {
      await route.fallback();
      return;
    }
    markSeen();
    await route.fulfill({ status: 503, body: 'unavailable' });
  }, { times: 1 });
  return { seen };
}

async function resetThenFailBack(page, projectIds) {
  const restricted = page.url();
  await openDialog(page);
  await dialog(page).locator('[data-releases-filters-reset]').click();
  await settled(page);
  const failed = await failOnce(page, (url) => !url.searchParams.has('search')
    && url.searchParams.getAll('project').map(Number).sort().join() === projectIds.slice().sort().join());
  await page.goBack({ waitUntil: 'commit' });
  await failed.seen;
  await expect(page.locator('[data-live-filter-retry]').first()).toBeVisible();
  await expect.poll(() => page.url()).toBe(restricted);
}

function waitForUnrestricted(page) {
  return page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === '/releases' && request.resourceType() === 'fetch' && !url.searchParams.has('project');
  });
}

async function expectRestricted(page, summary) {
  const text = await summaryText(page, 'release-project-filter');
  expect(text).not.toBe('All projects');
  if (summary) expect(text).toBe(summary);
  await expect(dropdown(page, 'release-project-filter').locator('input[data-cc-dropdown-select-all]')).not.toBeChecked();
  await expect(dropdown(page, 'release-project-filter').locator('summary')).toHaveAttribute('aria-label', /^Projects filter: (?!All projects)/);
}

async function selectAllOnce(page, { keyboard = false } = {}) {
  const details = await openDropdown(page, 'release-project-filter');
  if (keyboard) {
    await details.locator('input[data-cc-dropdown-select-all]').focus();
    await page.keyboard.press('Space');
  } else {
    await details.locator('.cc-dropdown-select-all-option label').click();
  }
}

async function expectUnrestrictedAll(page, s) {
  await settled(page);
  expect(await carriers(page, 'project')).toEqual([]);
  expect(await checkedValues(page, 'release-project-filter')).toEqual(['']);
  expect(await summaryText(page, 'release-project-filter')).toBe('All projects');
  expect(query(page).has('project')).toBe(false);
  expect(query(page).get('pageSize')).toBe('10');
  expect((await renderedTitles(page)).sort()).toEqual([s.fallback.title, s.needleComic.title, s.other.title].sort());
  expect(await totalCount(page)).toBe(3);
}

async function searchNeedleUnrestricted(page, s) {
  const searched = waitForSearch(page, 'Needle');
  await page.locator('#releases-search').fill('Needle');
  const composed = new URL((await searched).url());
  expect(composed.searchParams.getAll('project')).toEqual([]);
  expect(composed.searchParams.get('pageSize')).toBe('10');
  await settled(page);
  // The unrelated Needle release is now eligible.
  expect((await renderedTitles(page)).sort()).toEqual([s.fallback.title, s.needleComic.title].sort());
  expect(await totalCount(page)).toBe(2);
  return page.url();
}

test('R10 reviewer sequence: Reset installed -> Back held -> hidden 999999 is restricted; one Select all click clears it; late Back never reinstalls', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  await start(page, releasesUrl(fixture.baseURL, { project: UNKNOWN, pageSize: 10 }));
  const back = await resetThenHoldBack(page, [UNKNOWN]);
  expect(await carriers(page, 'project')).toEqual([String(UNKNOWN)]);
  await expectRestricted(page, '1 project selected');
  expect(await checkedValues(page, 'release-project-filter')).toEqual([]);

  const gets = control.gets.length;
  const cleared = waitForUnrestricted(page);
  await selectAllOnce(page);
  const requested = new URL((await cleared).url());
  expect(requested.searchParams.getAll('project')).toEqual([]);
  expect(requested.searchParams.get('pageSize')).toBe('10');
  await expectUnrestrictedAll(page, s);
  expect(control.gets.length).toBe(gets + 1);

  const finalUrl = await searchNeedleUnrestricted(page, s);
  back.release();
  await back.done;
  await frame(page);
  expect(page.url()).toBe(finalUrl);
  expect((await renderedTitles(page)).sort()).toEqual([s.fallback.title, s.needleComic.title].sort());
  expect(await summaryText(page, 'release-project-filter')).toBe('All projects');
  expect(await carriers(page, 'project')).toEqual([]);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('R10 failed Back: the restriction stays truthful; keyboard Space on Select all clears it', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  await start(page, releasesUrl(fixture.baseURL, { project: UNKNOWN, pageSize: 10 }));
  await resetThenFailBack(page, [UNKNOWN]);
  expect(await carriers(page, 'project')).toEqual([String(UNKNOWN)]);
  await expectRestricted(page, '1 project selected');

  const cleared = waitForUnrestricted(page);
  await selectAllOnce(page, { keyboard: true });
  const requested = new URL((await cleared).url());
  expect(requested.searchParams.get('pageSize')).toBe('10');
  await expectUnrestrictedAll(page, s);
  await expect(dropdown(page, 'release-project-filter').locator('input[data-cc-dropdown-select-all]')).toBeFocused();
  await searchNeedleUnrestricted(page, s);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('R10 failed Back -> GET-only Retry held: Select all supersedes Retry; the late Retry never installs', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  await start(page, releasesUrl(fixture.baseURL, { project: UNKNOWN, pageSize: 10 }));
  await resetThenFailBack(page, [UNKNOWN]);
  const retry = await hold(page, (url) => url.searchParams.getAll('project').join() === String(UNKNOWN)
    && !url.searchParams.has('search'));
  await page.locator('[data-live-filter-retry]').first().click();
  await retry.seen;
  await expectRestricted(page, '1 project selected');

  const cleared = waitForUnrestricted(page);
  await selectAllOnce(page);
  await cleared;
  await expectUnrestrictedAll(page, s);
  const installed = page.url();
  retry.release();
  await retry.done;
  await frame(page);
  expect(page.url()).toBe(installed);
  expect(await summaryText(page, 'release-project-filter')).toBe('All projects');
  expect(await totalCount(page)).toBe(3);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('R10 archived Project during held Back: restricted, then one Select all clears it', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  await start(page, releasesUrl(fixture.baseURL, { project: s.archived.id, pageSize: 10 }));
  const back = await resetThenHoldBack(page, [s.archived.id]);
  await expectRestricted(page);
  const carried = await carriers(page, 'project');
  const checked = await checkedValues(page, 'release-project-filter');
  expect([...carried, ...checked]).toEqual([String(s.archived.id)]);

  const cleared = waitForUnrestricted(page);
  await selectAllOnce(page);
  await cleared;
  await expectUnrestrictedAll(page, s);
  back.release();
  await back.done;
  await frame(page);
  expect(await totalCount(page)).toBe(3);
  expect(query(page).has('project')).toBe(false);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('R10 mixed visible + hidden Projects during held Back: "2 projects selected"; a Type edit keeps both', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  await start(page, releasesUrl(fixture.baseURL, { project: [s.comic.id, UNKNOWN], pageSize: 10 }));
  const back = await resetThenHoldBack(page, [s.comic.id, UNKNOWN]);
  await expectRestricted(page, '2 projects selected');

  // Another dimension changes: both Projects travel (R9), the summary stays restricted.
  const typed = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === '/releases' && request.resourceType() === 'fetch' && url.searchParams.getAll('type').join() === 'comic';
  });
  const types = await openDropdown(page, 'release-type-filter');
  await types.locator('input[value="comic"]').check();
  const requested = new URL((await typed).url());
  expect(requested.searchParams.getAll('project').sort()).toEqual([String(s.comic.id), String(UNKNOWN)].sort());
  await settled(page);
  expect((await renderedTitles(page)).sort()).toEqual([s.needleComic.title, s.other.title].sort());
  expect(await totalCount(page)).toBe(2);
  back.release();
  await back.done;
  await frame(page);
  expect(query(page).getAll('type')).toEqual(['comic']);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});
