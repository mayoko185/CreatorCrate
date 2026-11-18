import { expect, test } from '@playwright/test';
import { createProjectsFixture } from './projects-filters-defaults-fixture.js';
import { createLibraryFixture } from './asset-library-filters-defaults-fixture.js';

/*
 * Filters & Defaults R2 — conditional Grid style visibility on the two
 * radio-backed combined dialogs (Asset Library, Projects). Grid style is
 * shown only while the dialog's View is Grid; hidden is presentation only
 * (same element, enabled, same value), so an explicit Save from List still
 * carries it and returning to Grid shows it unchanged. Every View path is
 * covered: dialog radio, toolbar link (no change event), form reconciliation
 * after a GET, Reset filters / Reset defaults, failed GET + Retry, rapid
 * choices with stale responses, Back/Forward, reload and NSFW refresh.
 * Project Assets (native-select View) is R3 and is not touched here.
 */

const projects = createProjectsFixture('fd-grid-style-visibility-projects');
const library = createLibraryFixture('fd-grid-style-visibility-library');

test.beforeAll(async () => {
  await projects.start();
  await library.start();
});

test.afterAll(async () => {
  await projects.stop();
  await library.stop();
});

const PAGES = {
  'Asset Library': {
    fixture: library,
    pathname: '/asset-viewer',
    dialog: '#asset-viewer-filter-dialog',
    region: '[data-asset-library-live-region]',
    viewId: 'asset-view-filter',
    gridStyleId: 'asset-grid-style-filter',
    field: '[data-asset-library-grid-style-field]',
    select: '#asset-library-grid-style',
    save: '[data-asset-library-defaults-save]',
    resetDefaults: '[data-asset-library-defaults-reset]',
    resetFilters: '[data-asset-library-filters-reset]',
    indicator: '[data-asset-library-defaults-indicator]',
    defaultsPath: '/asset-viewer/defaults',
    resetPath: '/asset-viewer/defaults/reset',
    nsfwToggle: '[data-asset-library-nsfw-toggle]',
    page: 'assetViewer',
    async seed() {
      library.isolate();
      return { project: await library.project('Visibility Library', 'images', ['v01.png', 'v02.png', 'v03.png']) };
    },
  },
  Projects: {
    fixture: projects,
    pathname: '/projects',
    dialog: '#projects-filter-dialog',
    region: '[data-projects-live-region]',
    viewId: 'project-view-filter',
    gridStyleId: 'project-grid-style-filter',
    field: '[data-projects-grid-style-field]',
    select: '#projects-grid-style',
    save: '[data-projects-defaults-save]',
    resetDefaults: '[data-projects-defaults-reset]',
    resetFilters: '[data-projects-filters-reset]',
    indicator: '[data-projects-defaults-indicator]',
    defaultsPath: '/projects/defaults',
    resetPath: '/projects/defaults/reset',
    nsfwToggle: '#projects-nsfw-toggle',
    page: 'projects',
    async seed() {
      projects.isolate();
      return {
        alpha: projects.project('Visibility Alpha'),
        beta: projects.project('Visibility Beta'),
        gamma: projects.project('Visibility Gamma'),
      };
    },
  },
};

function record(page, config) {
  const control = { posts: [], gets: [], errors: [] };
  page.on('pageerror', (error) => control.errors.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() === 'POST') {
      control.posts.push({ path: url.pathname, body: new URLSearchParams(request.postData() || '') });
    } else if (url.pathname === config.pathname && request.resourceType() === 'fetch') {
      control.gets.push(url);
    }
  });
  control.defaultsPosts = () => control.posts.filter((post) => post.path === config.defaultsPath);
  return control;
}

/**
 * Holds every live GET of the page (fetch only) until the test releases it.
 * `held.unhold()` removes this exact route (unroute matches the same matcher).
 */
async function holdGets(page, config) {
  const held = [];
  const matcher = (url) => url.pathname === config.pathname;
  await page.route(matcher, async (route) => {
    if (route.request().resourceType() !== 'fetch') return route.continue();
    held.push(route);
    return undefined;
  });
  held.unhold = () => page.unroute(matcher);
  return held;
}

async function start(page, config, query = '') {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${config.fixture.baseURL}${config.pathname}${query}`);
  await expect(page.locator(config.save)).toBeEnabled();
}

const dialogOf = (page, config) => page.locator(config.dialog);
const fieldOf = (page, config) => page.locator(config.field);
const viewOf = async (page, config) => page.locator(`#${config.viewId} input[name="view"]:checked`).inputValue();

async function settled(page, config) {
  await expect(page.locator(config.region)).not.toHaveAttribute('aria-busy', 'true');
}

async function openDialog(page, config) {
  await page.getByRole('link', { name: 'Filters & Defaults', exact: true }).click();
  await expect(dialogOf(page, config)).toBeVisible();
}

async function closeDialog(page, config) {
  await dialogOf(page, config).getByRole('button', { name: 'Close Filters & Defaults', exact: true }).click();
  await expect(dialogOf(page, config)).toBeHidden();
}

/** Clicks a single-select option without waiting for its GET (it may be held). */
async function pick(page, id, label) {
  const details = page.locator(`#${id}`);
  if (!(await details.evaluate((element) => element.open))) await details.locator('summary').click();
  await details.locator('.asset-filter-multiselect-option label').getByText(label, { exact: true }).first().click();
  await expect(details).toHaveJSProperty('open', false);
}

async function choose(page, config, id, label) {
  await pick(page, id, label);
  await settled(page, config);
}

/** Hidden is presentation only: the same enabled, unnamed control and value. */
async function expectRetained(page, config, value) {
  const select = page.locator(config.select);
  await expect(select).toHaveCount(1);
  await expect(select).toBeEnabled();
  await expect(select).toHaveValue(value);
  expect(await select.evaluate((element) => element.hasAttribute('name'))).toBe(false);
}

async function expectVisibility(page, config, view) {
  await expect.poll(() => viewOf(page, config)).toBe(view);
  if (view === 'list') {
    await expect(fieldOf(page, config)).toBeHidden();
    await expect(fieldOf(page, config)).toHaveJSProperty('hidden', true);
  } else {
    await expect(fieldOf(page, config)).toHaveJSProperty('hidden', false);
  }
}

for (const [name, config] of Object.entries(PAGES)) {
  test(`R2 A/B/N ${name}: initial Grid shows, initial List hides, reload and saved List keep it hidden`, async ({ page }) => {
    const control = record(page, config);
    await config.seed();

    await start(page, config, '?view=grid');
    await openDialog(page, config);
    await expectVisibility(page, config, 'grid');
    await expect(fieldOf(page, config)).toBeVisible();

    await start(page, config, '?view=list');
    await openDialog(page, config);
    await expectVisibility(page, config, 'list');
    await page.reload();
    await expect(page.locator(config.save)).toBeEnabled();
    await openDialog(page, config);
    await expectVisibility(page, config, 'list');

    // A saved List View is the effective initial View; explicit URL wins.
    config.fixture.writePageDefault(config.page, 'view', 'list');
    await start(page, config);
    await openDialog(page, config);
    await expectVisibility(page, config, 'list');
    await start(page, config, '?view=grid');
    await openDialog(page, config);
    await expectVisibility(page, config, 'grid');
    expect(control.posts).toEqual([]);
    expect(control.errors).toEqual([]);
  });

  test(`R2 C–G/Q ${name}: View changes hide/show at once, keep the value, and Save carries it from List and Grid`, async ({ page }) => {
    const control = record(page, config);
    await config.seed();
    await start(page, config, '?view=grid');
    await openDialog(page, config);
    await choose(page, config, config.gridStyleId, 'Cropped');
    await expectRetained(page, config, 'cropped');

    // C: hidden immediately, before the List GET answers.
    const held = await holdGets(page, config);
    await pick(page, config.viewId, 'List');
    await expect.poll(() => held.length).toBe(1);
    await expectVisibility(page, config, 'list');
    await expectRetained(page, config, 'cropped');
    await held.shift().continue();
    await settled(page, config);
    await held.unhold();
    expect(new URL(page.url()).searchParams.get('view')).toBe('list');
    await expectVisibility(page, config, 'list');
    await expectRetained(page, config, 'cropped');
    // Q: no View or visibility change wrote anything.
    expect(control.defaultsPosts()).toEqual([]);

    // F: Save while List carries the retained Grid style, once.
    await page.locator(config.save).click();
    await expect(dialogOf(page, config).locator('[data-settings-fetch-save-status]')).toHaveText('Defaults saved.');
    expect(control.defaultsPosts()).toHaveLength(1);
    let body = control.defaultsPosts()[0].body;
    expect(body.get('view')).toBe('list');
    expect(body.get('gridStyle')).toBe('cropped');
    expect(config.fixture.readPageDefault(config.page, 'gridStyle')).toBe('cropped');
    expect(config.fixture.readPageDefault(config.page, 'view')).toBe('list');
    const savedIndicator = await page.locator(config.indicator).textContent();

    // D/E: back to Grid restores the field with the same value; no POST.
    await choose(page, config, config.viewId, 'Grid');
    await expectVisibility(page, config, 'grid');
    await expect(fieldOf(page, config)).toBeVisible();
    await expectRetained(page, config, 'cropped');
    await expect(page.locator(`#${config.gridStyleId} [data-cc-dropdown-summary-current]`)).toHaveText('Cropped');
    expect(control.defaultsPosts()).toHaveLength(1);
    // Visibility never marks Grid style changed: returning to the saved View
    // reads the same saved state.
    await choose(page, config, config.viewId, 'List');
    await expect(page.locator(config.indicator)).toHaveText(savedIndicator);
    await choose(page, config, config.viewId, 'Grid');

    // G: Save while Grid carries the current Grid style.
    await choose(page, config, config.gridStyleId, 'Uncropped');
    expect(control.defaultsPosts()).toHaveLength(1);
    await page.locator(config.save).click();
    await expect.poll(() => control.defaultsPosts().length).toBe(2);
    await expect(dialogOf(page, config).locator('[data-settings-fetch-save-status]')).toHaveText('Defaults saved.');
    body = control.defaultsPosts()[1].body;
    expect(body.get('view')).toBe('grid');
    expect(body.get('gridStyle')).toBe('uncropped');
    expect(config.fixture.readPageDefault(config.page, 'view')).toBe('grid');
    expect(config.fixture.readPageDefault(config.page, 'gridStyle')).toBe('uncropped');
    // One visible success message.
    await expect(dialogOf(page, config).getByText('Defaults saved.', { exact: true }).locator('visible=true')).toHaveCount(1);
    expect(control.errors).toEqual([]);
  });

  test(`R2 H/I/L ${name}: toolbar View, live form replacement and rapid choices with stale responses`, async ({ page }) => {
    const control = record(page, config);
    await config.seed();
    await start(page, config, '?view=grid');

    // H: the toolbar synchronizes the radio without a change event.
    const held = await holdGets(page, config);
    await page.locator(`${config.region} nav.view-switcher a[aria-label="List view"]`).click();
    await expect.poll(() => held.length).toBe(1);
    await openDialog(page, config);
    await expectVisibility(page, config, 'list');
    // I: the installed response replaces the form's children; still hidden.
    await held.shift().continue();
    await settled(page, config);
    expect(new URL(page.url()).searchParams.get('view')).toBe('list');
    await expectVisibility(page, config, 'list');

    // L: List -> Grid -> List -> Grid, every GET held; release oldest last.
    await pick(page, config.viewId, 'Grid');
    await expectVisibility(page, config, 'grid');
    await pick(page, config.viewId, 'List');
    await expectVisibility(page, config, 'list');
    await pick(page, config.viewId, 'Grid');
    await expectVisibility(page, config, 'grid');
    await expect.poll(() => held.length).toBe(3);
    const [first, second, latest] = held.splice(0);
    await latest.continue();
    await settled(page, config);
    await expect.poll(() => new URL(page.url()).searchParams.get('view')).toBe('grid');
    await expectVisibility(page, config, 'grid');
    // Older (aborted) responses arriving last never install.
    await second.continue().catch(() => {});
    await first.continue().catch(() => {});
    await settled(page, config);
    expect(new URL(page.url()).searchParams.get('view')).toBe('grid');
    await expectVisibility(page, config, 'grid');
    await expect(fieldOf(page, config)).toBeVisible();
    await expect(page.locator(`${config.region} nav.view-switcher a[aria-label="Grid view"]`)).toHaveAttribute('aria-current', 'page');
    await held.unhold();
    expect(control.defaultsPosts()).toEqual([]);
    expect(control.errors).toEqual([]);
  });

  test(`R2 J/R ${name}: Reset filters restores saved visibility and value; Reset defaults keeps its semantics`, async ({ page }) => {
    const control = record(page, config);
    await config.seed();
    config.fixture.writePageDefault(config.page, 'view', 'list');
    config.fixture.writePageDefault(config.page, 'gridStyle', 'cropped');
    await start(page, config, '?view=grid');
    await openDialog(page, config);
    await expectVisibility(page, config, 'grid');
    await choose(page, config, config.gridStyleId, 'Uncropped');

    // J: Reset filters resolves the saved List + Cropped.
    await page.locator(config.resetFilters).click();
    await settled(page, config);
    await expect.poll(() => new URL(page.url()).searchParams.get('view')).toBe('list');
    await expectVisibility(page, config, 'list');
    await expectRetained(page, config, 'cropped');
    await choose(page, config, config.viewId, 'Grid');
    await expect(page.locator(`#${config.gridStyleId} [data-cc-dropdown-summary-current]`)).toHaveText('Cropped');
    await choose(page, config, config.viewId, 'List');
    expect(control.defaultsPosts()).toEqual([]);

    // R: Reset defaults deletes the saved settings once; visibility follows
    // whatever View the page then shows.
    await page.locator(config.resetDefaults).click();
    await expect.poll(() => control.posts.filter((post) => post.path === config.resetPath).length).toBe(1);
    await expect.poll(() => config.fixture.readPageDefault(config.page, 'view')).toBeUndefined();
    await settled(page, config);
    const view = await viewOf(page, config);
    await expectVisibility(page, config, view);
    await expect(page.locator(config.indicator)).toHaveText('No saved defaults.');
    expect(control.defaultsPosts()).toEqual([]);
    expect(control.errors).toEqual([]);
  });

  test(`R2 K ${name}: a failed GET keeps the intended View and visibility; GET-only Retry installs it`, async ({ page }) => {
    const control = record(page, config);
    await config.seed();
    await start(page, config, '?view=grid');
    await openDialog(page, config);
    let fail = true;
    const matcher = (url) => url.pathname === config.pathname;
    await page.route(matcher, async (route) => {
      if (fail && route.request().resourceType() === 'fetch') return route.abort('failed');
      return route.continue();
    });
    await pick(page, config.viewId, 'List');
    await expect(page.locator('[data-live-filter-retry]')).toBeVisible();
    expect(new URL(page.url()).searchParams.get('view')).toBe('grid');
    await expectVisibility(page, config, 'list');
    await expectRetained(page, config, 'uncropped');

    fail = false;
    const postsBefore = control.posts.length;
    await page.locator('[data-live-filter-retry]').click();
    await settled(page, config);
    await expect.poll(() => new URL(page.url()).searchParams.get('view')).toBe('list');
    await expectVisibility(page, config, 'list');
    expect(control.posts.length).toBe(postsBefore);
    await page.unroute(matcher);
    expect(control.errors).toEqual([]);
  });

  test(`R2 M/O/P ${name}: Back/Forward, Tab skips the hidden field, and an open Grid style dropdown closes safely`, async ({ page }) => {
    const control = record(page, config);
    await config.seed();
    await start(page, config, '?view=grid');
    await openDialog(page, config);

    // O: in Grid, Tab from View reaches Grid style; in List it never does.
    const viewSummary = page.locator(`#${config.viewId} > summary`);
    const gridStyleSummary = page.locator(`#${config.gridStyleId} > summary`);
    await viewSummary.focus();
    await page.keyboard.press('Tab');
    await expect(gridStyleSummary).toBeFocused();

    await choose(page, config, config.viewId, 'List');
    await viewSummary.focus();
    for (let step = 0; step < 6; step += 1) {
      await page.keyboard.press('Tab');
      expect(await fieldOf(page, config).evaluate((field) => field.contains(document.activeElement))).toBe(false);
    }
    await choose(page, config, config.viewId, 'Grid');
    await expectVisibility(page, config, 'grid');

    // P: an open Grid style dropdown, focus inside it, while Back installs List.
    await gridStyleSummary.click();
    await expect(page.locator(`#${config.gridStyleId}`)).toHaveJSProperty('open', true);
    await page.locator(`#${config.gridStyleId} input[type="radio"]:checked`).focus();
    await page.goBack();
    await settled(page, config);
    await expect.poll(() => new URL(page.url()).searchParams.get('view')).toBe('list');
    await expectVisibility(page, config, 'list');
    await expect(page.locator(`#${config.gridStyleId}`)).toHaveJSProperty('open', false);
    expect(await fieldOf(page, config).evaluate((field) => field.contains(document.activeElement))).toBe(false);
    expect(await dialogOf(page, config).evaluate((dialog) => dialog.contains(document.activeElement))).toBe(true);
    await expect(dialogOf(page, config)).toBeVisible();

    // M: Forward returns to Grid; the dropdown is not reopened.
    await page.goForward();
    await settled(page, config);
    await expect.poll(() => new URL(page.url()).searchParams.get('view')).toBe('grid');
    await expectVisibility(page, config, 'grid');
    await expect(page.locator(`#${config.gridStyleId}`)).toHaveJSProperty('open', false);
    await page.goBack();
    await settled(page, config);
    await expectVisibility(page, config, 'list');

    // Escape still dismisses the dialog.
    await page.keyboard.press('Escape');
    await expect(dialogOf(page, config)).toBeHidden();
    expect(control.posts).toEqual([]);
    expect(control.errors).toEqual([]);
  });
}

test('R2 Asset Library: Assets per page stays visible, the viewer sequence follows, NSFW refresh keeps List hidden', async ({ page }) => {
  const config = PAGES['Asset Library'];
  const control = record(page, config);
  const { project } = await config.seed();
  await start(page, config, '?view=list');
  await openDialog(page, config);
  await expectVisibility(page, config, 'list');
  await expect(page.locator('#asset-page-size-filter')).toBeVisible();
  await expect(page.locator(`#${config.viewId}`)).toBeVisible();

  await choose(page, config, config.viewId, 'Grid');
  await expect(page.locator('#asset-page-size-filter')).toBeVisible();
  const sequence = async () => page.locator('[data-asset-library-viewer-sequence]')
    .evaluate((element) => JSON.parse(element.textContent).length);
  await expect.poll(sequence).toBe(project.assetIds.length);
  await choose(page, config, config.viewId, 'List');
  await expect.poll(sequence).toBe(project.assetIds.length);
  await closeDialog(page, config);

  await page.locator(config.nsfwToggle).click();
  await expect(page.locator(config.nsfwToggle)).toHaveAttribute('aria-pressed', 'true');
  await settled(page, config);
  expect(new URL(page.url()).searchParams.get('view')).toBe('list');
  await openDialog(page, config);
  await expectVisibility(page, config, 'list');
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('R2 Projects: fixed 25-item pages, multi-Project selections and NSFW refresh survive View visibility', async ({ page }) => {
  const config = PAGES.Projects;
  const control = record(page, config);
  const { alpha, gamma } = await config.seed();
  await start(page, config, '?view=grid');
  await openDialog(page, config);
  // A multi-select stays open for more choices; close it as a user would.
  const projectFilter = page.locator('#project-project-filter');
  for (const title of [alpha.title, gamma.title]) {
    if (!(await projectFilter.evaluate((element) => element.open))) await projectFilter.locator('summary').click();
    await projectFilter.locator('.asset-filter-multiselect-option label').getByText(title, { exact: true }).first().click();
    await settled(page, config);
  }
  if (await projectFilter.evaluate((element) => element.open)) await projectFilter.locator('summary').click();
  await expect(projectFilter).toHaveJSProperty('open', false);
  await choose(page, config, config.viewId, 'List');
  await expectVisibility(page, config, 'list');
  expect(new URL(page.url()).searchParams.getAll('project').sort()).toEqual([String(alpha.id), String(gamma.id)].sort());
  await choose(page, config, config.viewId, 'Grid');
  await expectVisibility(page, config, 'grid');
  expect(new URL(page.url()).searchParams.getAll('project').sort()).toEqual([String(alpha.id), String(gamma.id)].sort());
  await choose(page, config, config.viewId, 'List');
  await closeDialog(page, config);

  await page.locator(config.nsfwToggle).click();
  await settled(page, config);
  expect(new URL(page.url()).searchParams.get('view')).toBe('list');
  expect(new URL(page.url()).searchParams.getAll('project').sort()).toEqual([String(alpha.id), String(gamma.id)].sort());
  await openDialog(page, config);
  await expectVisibility(page, config, 'list');
  await closeDialog(page, config);

  // Fixed 25-item pagination: 26 active projects span two pages in List.
  projects.isolate();
  for (let index = 0; index < 26; index += 1) projects.project(`Paged ${index}`);
  await start(page, config, '?view=list');
  await expect(page.locator(`${config.region} tr[data-project-id]`)).toHaveCount(25);
  await openDialog(page, config);
  await expectVisibility(page, config, 'list');
  await expect(dialogOf(page, config).locator('[name="pageSize"]')).toHaveCount(0);
  expect(control.defaultsPosts()).toEqual([]);
  expect(control.errors).toEqual([]);
});
