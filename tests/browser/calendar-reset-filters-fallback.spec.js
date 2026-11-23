import { expect, test } from '@playwright/test';
import {
  MONTH, calendarUrl, closeDialog, columnHeaders, createCalendarFixture, dialog, enhanced, expectEntries,
  expectRepeated, openDialog, query, settled, summaryText, watch,
} from './calendar-filters-defaults-fixture.js';

// C4: Calendar Reset filters when the page's defaults authority is missing,
// malformed or carries no Reset destination. Reset filters stays GET-only and
// must keep the DISPLAYED month (a noncurrent one here, so a fall back to bare
// /calendar — the current month — is observable), clear Projects / Project
// Types and let the server restore the saved View, status and Week start.
// Save and Reset defaults stay fail-closed: no defaults POST is ever sent.

const fixture = createCalendarFixture('calendar-reset-fallback');
const NEXT_MONTH = '2031-08';

test.beforeAll(async () => {
  await fixture.start();
});

test.afterAll(async () => {
  await fixture.stop();
});

function seed() {
  fixture.isolate();
  const comic = fixture.project('Fallback Comic', { projectType: 'comic' });
  const anim = fixture.project('Fallback Anim', { projectType: 'animation' });
  const images = fixture.project('Fallback Images', { projectType: 'images' });
  // Saved (non-fallback) View and Week start; status saved at its fallback.
  fixture.writePageDefault('calendar', 'view', 'list');
  fixture.writePageDefault('calendar', 'status', 'all');
  fixture.writePageDefault('calendar', 'weekStart', 'sunday');
  return {
    comic,
    anim,
    images,
    c1: fixture.release(comic, 'F Comic Planned', { planned: `${MONTH}-10` }),
    cp: fixture.release(comic, 'F Comic Published', { planned: `${MONTH}-03`, published: `${MONTH}-12` }),
    a1: fixture.release(anim, 'F Anim Planned', { planned: `${MONTH}-14` }),
    i1: fixture.release(images, 'F Images Planned', { planned: `${MONTH}-16` }),
    n1: fixture.release(comic, 'F Comic Next', { planned: `${NEXT_MONTH}-05` }),
  };
}

const AUTHORITY_SCRIPT = /<script type="application\/json" data-calendar-defaults-authority>([\s\S]*?)<\/script>/;

// Every /calendar HTML response (document and live fetch) has its authority
// rewritten by `mode`: removed, made unparseable, or stripped of its Reset
// filters destination.
function corruptAuthority(html, mode) {
  if (!AUTHORITY_SCRIPT.test(html)) throw new Error('authority script not found');
  return html.replace(AUTHORITY_SCRIPT, (whole, json) => {
    if (mode === 'missing') return '';
    if (mode === 'malformed') return whole.replace(json, '{"page":"calendar",');
    const authority = JSON.parse(json);
    delete authority.resetFiltersUrl;
    return whole.replace(json, JSON.stringify(authority).replace(/</g, '\\u003c'));
  });
}

async function routeAuthority(page, mode, hooks = {}) {
  await page.route((url) => url.pathname === '/calendar', async (route) => {
    const request = route.request();
    if (request.method() !== 'GET') {
      await route.continue();
      return;
    }
    if (await hooks.before?.(route) === 'handled') return;
    const response = await route.fetch();
    const body = await response.text();
    await route.fulfill({ response, body: response.ok() ? corruptAuthority(body, mode) : body });
  });
}

async function start(page, url) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(url);
  await enhanced(page);
}

const filteredUrl = (s) => calendarUrl(fixture.baseURL, {
  month: MONTH,
  project: [s.comic.id, s.anim.id],
  type: ['comic', 'animation'],
  status: 'planned',
  view: 'grid',
  weekStart: 'monday',
});
const region = (page) => page.locator('[data-calendar-live-region]');
const resetFiltersButton = (page) => dialog(page).locator('[data-calendar-filters-reset]');
const saveButton = (page) => dialog(page).locator('[data-calendar-defaults-save]');
const resetDefaultsButton = (page) => dialog(page).locator('[data-calendar-defaults-reset]');
const statusLine = (page) => dialog(page).locator('[data-settings-fetch-save-status]');
const retry = (page) => page.locator('[data-live-filter-retry]').filter({ visible: true });

async function expectResetToSavedSettings(page, s) {
  await expect.poll(() => [...query(page).keys()].sort()).toEqual(['month']);
  expect(query(page).get('month')).toBe(MONTH);
  await expect(region(page)).toHaveAttribute('data-calendar-month', MONTH);
  await expect(region(page)).toHaveClass(/calendar-view-list/);
  expect((await columnHeaders(page))[0]).toBe('Sun');
  expect(await summaryText(page, 'calendar-view-filter')).toBe('List');
  expect(await summaryText(page, 'calendar-status-filter')).toBe('All releases');
  expect(await summaryText(page, 'calendar-week-start-filter')).toBe('Sunday');
  expect(await summaryText(page, 'calendar-project-filter')).toBe('All projects');
  expect(await summaryText(page, 'calendar-type-filter')).toBe('All types');
  await expectEntries(page, [s.c1, s.cp, s.a1, s.i1]);
}

for (const mode of ['missing', 'malformed', 'no-destination']) {
  test(`authority ${mode}: Reset filters keeps the displayed month, clears Projects/Types, restores saved settings, never POSTs`, async ({ page }) => {
    const s = seed();
    const stored = fixture.storedCalendarDefaults();
    const generation = fixture.generation();
    await routeAuthority(page, mode);
    // No trustworthy authority anywhere: the dialog's GET re-read of the
    // saved defaults fails too, so nothing can fence a defaults write.
    await page.route((url) => url.pathname === '/calendar/defaults', async (route) => {
      if (route.request().method() === 'GET') await route.fulfill({ status: 503, body: 'unavailable' });
      else await route.continue();
    });
    const control = watch(page);
    await start(page, filteredUrl(s));
    if (mode === 'no-destination') await expect(page.locator('[data-calendar-defaults-authority]')).toHaveCount(1);
    else if (mode === 'missing') await expect(page.locator('[data-calendar-defaults-authority]')).toHaveCount(0);
    await expect(region(page)).toHaveClass(/calendar-view-grid/);
    await expectEntries(page, [s.c1, s.a1]);
    await openDialog(page);

    if (mode !== 'no-destination') {
      // Untrustworthy authority: Save and Reset defaults stay fail-closed.
      await saveButton(page).click();
      await expect(statusLine(page)).toHaveText('The current settings could not be read. Refresh the page before saving defaults.');
      await resetDefaultsButton(page).click();
      const confirmation = page.locator('#app-confirmation-dialog');
      if (await confirmation.isVisible()) await confirmation.locator('[data-app-dialog-confirmation-confirm]').click();
      await page.waitForTimeout(200);
      expect(control.defaultsPosts()).toEqual([]);
    }

    const documentsBefore = control.documents.length;
    await resetFiltersButton(page).click();
    await settled(page);
    await expectResetToSavedSettings(page, s);
    // One live GET of the displayed month; never a full page load.
    expect(control.gets.at(-1).searchParams.toString()).toBe(`month=${MONTH}`);
    expect(control.documents.length).toBe(documentsBefore);
    await expect(dialog(page)).toBeVisible();
    expect(control.defaultsPosts()).toEqual([]);
    expect(fixture.generation()).toBe(generation);
    expect(fixture.storedCalendarDefaults()).toEqual(stored);
    expect(control.errors).toEqual([]);
  });
}

test('authority missing: a failed Reset GET keeps the installed Calendar; GET-only Retry keeps the month', async ({ page }) => {
  const s = seed();
  let failNext = false;
  await routeAuthority(page, 'missing', {
    before: async (route) => {
      if (!failNext || route.request().resourceType() !== 'fetch') return null;
      failNext = false;
      await route.fulfill({ status: 503, body: 'unavailable' });
      return 'handled';
    },
  });
  const control = watch(page);
  const url = filteredUrl(s);
  await start(page, url);
  await openDialog(page);

  failNext = true;
  await resetFiltersButton(page).click();
  await expect(retry(page)).toBeVisible();
  // The installed (filtered) Calendar and its URL are kept.
  expect(page.url()).toBe(url);
  await expect(region(page)).toHaveAttribute('data-calendar-month', MONTH);
  await expectEntries(page, [s.c1, s.a1]);
  expect(control.gets.at(-1).searchParams.toString()).toBe(`month=${MONTH}`);

  const getsBefore = control.gets.length;
  await retry(page).first().click();
  await settled(page);
  await expectResetToSavedSettings(page, s);
  expect(control.gets.length).toBe(getsBefore + 1);
  expect(control.gets.at(-1).searchParams.toString()).toBe(`month=${MONTH}`);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('authority missing: a newer month navigation supersedes a held Reset; Back/Forward reconcile', async ({ page }) => {
  const s = seed();
  let releaseReset;
  const heldReset = new Promise((resolve) => { releaseReset = resolve; });
  let held = 0;
  await routeAuthority(page, 'missing', {
    before: async (route) => {
      const target = new URL(route.request().url());
      if (route.request().resourceType() === 'fetch' && target.search === `?month=${MONTH}` && held === 0) {
        held += 1;
        await heldReset;
      }
      return null;
    },
  });
  const control = watch(page);
  const url = filteredUrl(s);
  await start(page, url);
  await openDialog(page);

  await resetFiltersButton(page).click();
  await expect.poll(() => held).toBe(1);
  // A newer navigation (Next month, from the installed filtered page).
  await closeDialog(page);
  await page.getByRole('link', { name: 'Next month', exact: true }).click();
  await settled(page);
  await expect.poll(() => query(page).get('month')).toBe(NEXT_MONTH);
  releaseReset();
  await page.waitForTimeout(300);
  // The late Reset response never reinstalls over the newer month.
  await expect(region(page)).toHaveAttribute('data-calendar-month', NEXT_MONTH);
  expect(query(page).get('month')).toBe(NEXT_MONTH);
  // R2: the newer month navigation composes with the held Reset (the latest
  // intent), never with the installed page's filters: Projects / Project
  // Types stay cleared and the saved View, status and Week start apply.
  expect([...query(page).keys()]).toEqual(['month']);
  expect(query(page).getAll('project')).toEqual([]);
  expect(query(page).getAll('type')).toEqual([]);
  await expect(region(page)).toHaveClass(/calendar-view-list/);
  await expectEntries(page, [s.n1]);

  // Back returns to the original filtered month; Forward to the next month.
  await page.goBack();
  await settled(page);
  await expect.poll(() => page.url()).toBe(url);
  await expect(region(page)).toHaveAttribute('data-calendar-month', MONTH);
  await expectEntries(page, [s.c1, s.a1]);
  await page.goForward();
  await settled(page);
  await expect(region(page)).toHaveAttribute('data-calendar-month', NEXT_MONTH);

  // Back again, then Reset filters (dialog reopened) keeps that month.
  await page.goBack();
  await settled(page);
  await expect(region(page)).toHaveAttribute('data-calendar-month', MONTH);
  await openDialog(page);
  await resetFiltersButton(page).click();
  await settled(page);
  await expectResetToSavedSettings(page, s);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('authority missing and displayed month unreadable: Reset filters refuses with a recovery message, no navigation', async ({ page }) => {
  const s = seed();
  await routeAuthority(page, 'missing');
  const control = watch(page);
  const url = filteredUrl(s);
  await start(page, url);
  await region(page).evaluate((element) => element.removeAttribute('data-calendar-month'));
  await openDialog(page);
  const getsBefore = control.gets.length;
  const documentsBefore = control.documents.length;
  await resetFiltersButton(page).click();
  await expect(statusLine(page)).toHaveText(
    'Filters could not be reset because the displayed month could not be read. Reload the page, then reset filters again.',
  );
  await page.waitForTimeout(300);
  expect(control.gets.length).toBe(getsBefore);
  expect(control.documents.length).toBe(documentsBefore);
  expect(page.url()).toBe(url);
  await expectEntries(page, [s.c1, s.a1]);
  await expect(resetFiltersButton(page)).toBeFocused();
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('authority missing, no JavaScript: the native Reset filters form keeps the displayed month', async ({ browser }) => {
  const s = seed();
  const context = await browser.newContext({ javaScriptEnabled: false });
  const plain = await context.newPage();
  await routeAuthority(plain, 'missing');
  const control = watch(plain);
  await plain.goto(filteredUrl(s));
  await expect(plain.locator('[data-calendar-defaults-authority]')).toHaveCount(0);
  await Promise.all([
    plain.waitForURL((url) => !url.searchParams.has('project')),
    plain.locator('[data-calendar-filters-reset]').evaluate((button) => button.form.submit()),
  ]);
  const plainQuery = new URL(plain.url()).searchParams;
  expect([...plainQuery.keys()]).toEqual(['month']);
  expect(plainQuery.get('month')).toBe(MONTH);
  await expect(plain.locator('[data-calendar-live-region]')).toHaveClass(/calendar-view-list/);
  expect(control.posts).toEqual([]);
  await context.close();
});
