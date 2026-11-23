import { expect, test } from '@playwright/test';
import {
  checkedValues, createReleasesFixture, dialog, dropdown, enhanced, expectTitles, openDialog, openDropdown, query,
  releasesUrl, renderedTitles, settled, summaryText, watch,
} from './releases-filters-defaults-fixture.js';

// P3 correction 1: a Project carrier marked data-cc-dropdown-carried-value
// counts as a selection only when native form submission would include it.
// A disabled carrier (itself, or inside a disabled <fieldset> outside its
// first <legend>) is left out of FormData, so the dropdown shows All with
// Select all checked; an enabled one stays restricted and is sent.

const fixture = createReleasesFixture('releases-p3-disabled-carrier');
const UNKNOWN = 999999;
const PROJECT = 'release-project-filter';

test.beforeAll(async () => {
  await fixture.start();
});

test.afterAll(async () => {
  await fixture.stop();
});

function seed() {
  fixture.isolate();
  fixture.writePageDefault('releases', 'sort', 'title');
  fixture.writePageDefault('releases', 'order', 'asc');
  const comic = fixture.project('P3 Comic', { projectType: 'comic' });
  const images = fixture.project('P3 Images', { projectType: 'images' });
  return {
    comic,
    images,
    fallback: fixture.release(images, 'Needle fallback'),
    needleComic: fixture.release(comic, 'Needle Comic'),
    other: fixture.release(comic, 'Zulu other'),
  };
}

/** Reset, then a Back to project=999999 whose live GET fails: the carrier stays pending. */
async function failedBackToUnknown(page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(releasesUrl(fixture.baseURL, { project: UNKNOWN, pageSize: 10 }));
  await enhanced(page);
  await openDialog(page);
  await dialog(page).locator('[data-releases-filters-reset]').click();
  await settled(page);
  expect(query(page).has('project')).toBe(false);
  let markSeen;
  const seen = new Promise((resolve) => { markSeen = resolve; });
  await page.route((url) => url.pathname === '/releases' && url.searchParams.getAll('project').includes(String(UNKNOWN)),
    async (route) => {
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
  expect(await carrierState(page)).toEqual([[String(UNKNOWN), false]]);
}

async function carrierState(page) {
  return page.locator('input[data-releases-intended-carrier][name="project"]')
    .evaluateAll((inputs) => inputs.map((input) => [input.value, input.disabled]));
}

/** Projects the real FormData of the filter form submits (Select all's empty value excluded). */
async function submittedProjects(page) {
  return page.locator('#list-releases-filter').evaluate((form) => Array.from(new FormData(form).entries())
    .filter(([name, value]) => name === 'project' && value !== '').map(([, value]) => value));
}

/** Changes the carrier's submission state, then re-runs the Project dropdown's own initialization. */
async function mutateCarrierAndRefresh(page, how) {
  await page.evaluate(async (mode) => {
    const form = document.querySelector('#list-releases-filter');
    const carrier = form.querySelector('input[data-releases-intended-carrier][name="project"]');
    if (mode === 'disabled') carrier.disabled = true;
    if (mode === 'fieldset' || mode === 'legend') {
      const fieldset = document.createElement('fieldset');
      fieldset.disabled = true;
      fieldset.hidden = true;
      if (mode === 'legend') {
        const legend = document.createElement('legend');
        fieldset.appendChild(legend);
        legend.appendChild(carrier);
      } else {
        fieldset.appendChild(carrier);
      }
      form.appendChild(fieldset);
    }
    const { initializeCreatorCrateDropdown } = await import('/client/dropdowns.js');
    initializeCreatorCrateDropdown(document.querySelector('#release-project-filter'));
  }, how);
}

async function expectUnrestrictedDisplay(page) {
  expect(await summaryText(page, PROJECT)).toBe('All projects');
  await expect(dropdown(page, PROJECT).locator('input[data-cc-dropdown-select-all]')).toBeChecked();
  expect(await checkedValues(page, PROJECT)).toEqual(['']);
}

async function expectRestrictedDisplay(page) {
  expect(await summaryText(page, PROJECT)).toBe('1 project selected');
  await expect(dropdown(page, PROJECT).locator('input[data-cc-dropdown-select-all]')).not.toBeChecked();
}

async function idle(page) {
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 1200)));
  }));
}

function waitForSearch(page, value) {
  return page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === '/releases' && request.resourceType() === 'fetch' && url.searchParams.get('search') === value;
  });
}

test('disabled-only carrier: All, Select all checked; click and Space are no-ops; Search sends no Project', async ({ page }) => {
  const s = seed();
  const control = watch(page);
  await failedBackToUnknown(page);
  await expectRestrictedDisplay(page);

  await mutateCarrierAndRefresh(page, 'disabled');
  expect(await submittedProjects(page)).toEqual([]);
  await expectUnrestrictedDisplay(page);

  const gets = control.gets.length;
  const details = await openDropdown(page, PROJECT);
  await details.locator('.cc-dropdown-select-all-option label').click();
  await details.locator('input[data-cc-dropdown-select-all]').focus();
  await page.keyboard.press('Space');
  await idle(page);
  expect(control.gets.length).toBe(gets);
  await expectUnrestrictedDisplay(page);
  // The intentionally disabled carrier is neither re-enabled nor removed by the dropdown.
  expect(await carrierState(page)).toEqual([[String(UNKNOWN), true]]);

  const searched = waitForSearch(page, 'Needle');
  await page.locator('#releases-search').fill('Needle');
  const outgoing = new URL((await searched).url());
  expect(outgoing.searchParams.getAll('project')).toEqual([]);
  expect(outgoing.searchParams.get('pageSize')).toBe('10');
  await settled(page);
  expect((await renderedTitles(page)).sort()).toEqual([s.fallback.title, s.needleComic.title].sort());
  expect(control.gets.length).toBe(gets + 1);
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('enabled-only carrier: restricted and sent; one keyboard Space on Select all clears it with one GET', async ({ page }) => {
  seed();
  const control = watch(page);
  await failedBackToUnknown(page);
  await mutateCarrierAndRefresh(page, 'none');
  expect(await submittedProjects(page)).toEqual([String(UNKNOWN)]);
  await expectRestrictedDisplay(page);

  const gets = control.gets.length;
  const cleared = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === '/releases' && request.resourceType() === 'fetch' && !url.searchParams.has('project');
  });
  const details = await openDropdown(page, PROJECT);
  await details.locator('input[data-cc-dropdown-select-all]').focus();
  await page.keyboard.press('Space');
  const outgoing = new URL((await cleared).url());
  expect(outgoing.searchParams.get('pageSize')).toBe('10');
  await settled(page);
  await expectUnrestrictedDisplay(page);
  expect(await submittedProjects(page)).toEqual([]);
  expect(control.gets.length).toBe(gets + 1);
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});

/*
 * P3-C1 follow-up: a carrier belongs to its HTML form owner. A carrier
 * outside #list-releases-filter that names it with form="" is submitted by
 * that form, so the dropdown shows it as a restriction and one Select all
 * clears it; a carrier inside #list-releases-filter owned by another form is
 * neither counted nor removed by Releases edits.
 */
const CARRIER_MARKS = ['data-releases-intended-carrier', 'data-cc-dropdown-carried-value'];

/** Appends a marked hidden Project carrier at `where`, optionally owned via form="". */
async function placeCarrier(page, { where, form = null, value, disabled = false }) {
  await page.evaluate(async ({ where: target, form: owner, value: carried, disabled: off, marks }) => {
    const carrier = document.createElement('input');
    carrier.type = 'hidden';
    carrier.name = 'project';
    carrier.value = carried;
    carrier.disabled = off;
    marks.forEach((mark) => carrier.setAttribute(mark, ''));
    if (owner) carrier.setAttribute('form', owner);
    carrier.setAttribute('data-p3-ownership-carrier', carried);
    const parent = target === 'body' ? document.body : document.querySelector(target);
    parent.appendChild(carrier);
    const { initializeCreatorCrateDropdown } = await import('/client/dropdowns.js');
    initializeCreatorCrateDropdown(document.querySelector('#release-project-filter'));
  }, { where, form, value: String(value), disabled, marks: CARRIER_MARKS });
}

async function addForeignForm(page) {
  await page.evaluate(() => {
    const form = document.createElement('form');
    form.id = 'p3-foreign-form';
    form.method = 'get';
    form.action = '/elsewhere';
    document.body.appendChild(form);
  });
}

async function formProjects(page, selector) {
  return page.locator(selector).evaluate((form) => Array.from(new FormData(form).entries())
    .filter(([name, value]) => name === 'project' && value !== '').map(([, value]) => value));
}

async function placedCarriers(page) {
  return page.locator('input[data-p3-ownership-carrier]').evaluateAll((inputs) => inputs.map((input) => ({
    value: input.value,
    insideFilterForm: Boolean(input.closest('#list-releases-filter')),
    owner: input.form ? input.form.id : null,
  })));
}

/** Holds the next live GET matching `predicate` until release() is called. */
async function holdNextGet(page, predicate) {
  let release;
  let markSeen;
  const seen = new Promise((resolve) => { markSeen = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  await page.route((url) => url.pathname === '/releases' && predicate(url), async (route) => {
    if (route.request().resourceType() !== 'fetch') {
      await route.fallback();
      return;
    }
    markSeen(new URL(route.request().url()));
    await held;
    // A superseded request may already be aborted by the live engine.
    await route.continue().catch(() => {});
  }, { times: 1 });
  return { seen, release: () => release() };
}

async function freshReleases(page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(releasesUrl(fixture.baseURL, { pageSize: 10 }));
  await enhanced(page);
  await openDialog(page);
}

test('external carrier owned with form="list-releases-filter": counted, submitted, one Select all clears it', async ({ page }) => {
  const s = seed();
  const comicProject = s.comic.id;
  const control = watch(page);
  await freshReleases(page);
  await expectUnrestrictedDisplay(page);

  await placeCarrier(page, { where: 'body', form: 'list-releases-filter', value: comicProject });
  expect(await placedCarriers(page)).toEqual([{ value: String(comicProject), insideFilterForm: false, owner: 'list-releases-filter' }]);
  expect(await submittedProjects(page)).toEqual([String(comicProject)]);
  await expectRestrictedDisplay(page);

  // R9: an unrelated Search keeps the active restriction (its GET is held).
  const gets = control.gets.length;
  const searchHold = await holdNextGet(page, (url) => url.searchParams.get('search') === 'Needle');
  await page.locator('#releases-search').fill('Needle');
  const restricted = await searchHold.seen;
  expect(restricted.searchParams.getAll('project')).toEqual([String(comicProject)]);
  // The pending destination renders the Project as a checked option (its owner
  // sync retires the now-redundant owned carrier): still one active restriction.
  expect(await summaryText(page, PROJECT)).toBe(s.comic.title);
  await expect(dropdown(page, PROJECT).locator('input[data-cc-dropdown-select-all]')).not.toBeChecked();
  expect(await submittedProjects(page)).toEqual([String(comicProject)]);

  // One Select all click during the pending Search clears the external carrier.
  const cleared = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === '/releases' && request.resourceType() === 'fetch'
      && url.searchParams.get('search') === 'Needle' && !url.searchParams.has('project');
  });
  const details = await openDropdown(page, PROJECT);
  await details.locator('.cc-dropdown-select-all-option label').click();
  const outgoing = new URL((await cleared).url());
  expect(outgoing.searchParams.getAll('project')).toEqual([]);
  expect(outgoing.searchParams.get('pageSize')).toBe('10');
  expect(await placedCarriers(page)).toEqual([]);
  await expectUnrestrictedDisplay(page);
  expect(await submittedProjects(page)).toEqual([]);
  await settled(page);
  await expectTitles(page, [s.fallback.title, s.needleComic.title], { sorted: true });
  // The superseded Search response may now arrive; it must not reinstall anything.
  searchHold.release();
  await idle(page);
  await expectTitles(page, [s.fallback.title, s.needleComic.title], { sorted: true });
  await expectUnrestrictedDisplay(page);
  expect(control.gets.length).toBe(gets + 2);

  // Settled page, external carrier again: one Select all click removes it (held GET).
  await placeCarrier(page, { where: 'body', form: 'list-releases-filter', value: comicProject });
  await expectRestrictedDisplay(page);
  const clearHold = await holdNextGet(page, (url) => url.searchParams.get('search') === 'Needle' && !url.searchParams.has('project'));
  const reopened = await openDropdown(page, PROJECT);
  await reopened.locator('.cc-dropdown-select-all-option label').click();
  const clearUrl = await clearHold.seen;
  expect(clearUrl.searchParams.getAll('project')).toEqual([]);
  expect(clearUrl.searchParams.get('search')).toBe('Needle');
  expect(await placedCarriers(page)).toEqual([]);
  await expectUnrestrictedDisplay(page);
  expect(await submittedProjects(page)).toEqual([]);
  clearHold.release();
  await settled(page);
  await expectTitles(page, [s.fallback.title, s.needleComic.title], { sorted: true });
  await idle(page);
  expect(control.gets.length).toBe(gets + 3);
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('carrier inside the Releases form but owned by another form: not counted; a Project edit keeps it', async ({ page }) => {
  const s = seed();
  const comicProject = s.comic.id;
  const control = watch(page);
  await freshReleases(page);
  await addForeignForm(page);
  await placeCarrier(page, { where: '#list-releases-filter', form: 'p3-foreign-form', value: UNKNOWN });
  expect(await placedCarriers(page)).toEqual([{ value: String(UNKNOWN), insideFilterForm: true, owner: 'p3-foreign-form' }]);
  expect(await submittedProjects(page)).toEqual([]);
  expect(await formProjects(page, '#p3-foreign-form')).toEqual([String(UNKNOWN)]);
  await expectUnrestrictedDisplay(page);

  // Genuinely unrestricted: Select all stays a no-op (no GET).
  const before = control.gets.length;
  const details = await openDropdown(page, PROJECT);
  await details.locator('.cc-dropdown-select-all-option label').click();
  await idle(page);
  expect(control.gets.length).toBe(before);
  await expectUnrestrictedDisplay(page);

  const hold = await holdNextGet(page, (url) => url.searchParams.getAll('project').length > 0);
  await details.locator('.asset-filter-multiselect-option label').getByText(s.comic.title, { exact: true }).click();
  const outgoing = await hold.seen;
  expect(outgoing.searchParams.getAll('project')).toEqual([String(comicProject)]);
  // While the GET is held: the foreign carrier is still in place and owned elsewhere.
  expect(await placedCarriers(page)).toEqual([{ value: String(UNKNOWN), insideFilterForm: true, owner: 'p3-foreign-form' }]);
  expect(await submittedProjects(page)).toEqual([String(comicProject)]);
  expect(await formProjects(page, '#p3-foreign-form')).toEqual([String(UNKNOWN)]);
  hold.release();
  await settled(page);
  await expectTitles(page, [s.needleComic.title, s.other.title], { sorted: true });
  expect(control.gets.length).toBe(before + 1);
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('disabled external carrier is ignored; an enabled one next to it stays the only restriction', async ({ page }) => {
  seed();
  const control = watch(page);
  await freshReleases(page);
  await placeCarrier(page, { where: 'body', form: 'list-releases-filter', value: 888888, disabled: true });
  expect(await submittedProjects(page)).toEqual([]);
  await expectUnrestrictedDisplay(page);
  await placeCarrier(page, { where: 'body', form: 'list-releases-filter', value: UNKNOWN });
  expect(await submittedProjects(page)).toEqual([String(UNKNOWN)]);
  await expectRestrictedDisplay(page);

  const gets = control.gets.length;
  const cleared = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === '/releases' && request.resourceType() === 'fetch' && !url.searchParams.has('project');
  });
  const details = await openDropdown(page, PROJECT);
  await details.locator('input[data-cc-dropdown-select-all]').focus();
  await page.keyboard.press('Space');
  await cleared;
  await settled(page);
  await expectUnrestrictedDisplay(page);
  expect(await submittedProjects(page)).toEqual([]);
  expect(control.gets.length).toBe(gets + 1);
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('disabled fieldset hides the carrier from FormData and the dropdown; its first legend does not', async ({ page }) => {
  seed();
  const control = watch(page);
  await failedBackToUnknown(page);
  await mutateCarrierAndRefresh(page, 'fieldset');
  expect(await submittedProjects(page)).toEqual([]);
  await expectUnrestrictedDisplay(page);

  await page.reload();
  await enhanced(page);
  await failedBackToUnknown(page);
  await mutateCarrierAndRefresh(page, 'legend');
  expect(await submittedProjects(page)).toEqual([String(UNKNOWN)]);
  await expectRestrictedDisplay(page);
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});
