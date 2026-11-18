import { expect, test } from '@playwright/test';
import { createProjectsFixture } from './projects-filters-defaults-fixture.js';
import { createLibraryFixture } from './asset-library-filters-defaults-fixture.js';

/*
 * Filters & Defaults R1 — the combined dialogs' footer, on all three pages:
 * Save new defaults | Reset defaults | Reset filters in DOM, visual and Tab
 * order; Save and Reset defaults secondary, Reset filters the footer's
 * primary treatment; every action keeps its own behavior (one explicit Save
 * POST, Reset defaults' existing confirmation or immediacy, Reset filters
 * GET-only) and reopening never duplicates handlers.
 */

const projects = createProjectsFixture('filters-defaults-footer-projects');
const library = createLibraryFixture('filters-defaults-footer-library');

test.beforeAll(async () => {
  await projects.start();
  await library.start();
});

test.afterAll(async () => {
  await projects.stop();
  await library.stop();
});

const ORDER = ['Save new defaults', 'Reset defaults', 'Reset filters'];

const PAGES = {
  'Project Assets': {
    dialog: '#project-assets-filter-dialog',
    async open(page) {
      projects.isolate();
      const project = projects.project('Footer Assets');
      await page.goto(`${projects.baseURL}/projects/${project.id}/assets`);
      await expect(page.locator('[data-project-assets-defaults-save]')).toBeEnabled();
      return { project, pathname: `/projects/${project.id}/assets` };
    },
    defaultsPath: (context) => `/projects/${context.project.id}/assets/defaults`,
    resetPath: (context) => `/projects/${context.project.id}/assets/defaults/reset`,
    confirmsReset: true,
  },
  'Asset Library': {
    dialog: '#asset-viewer-filter-dialog',
    async open(page) {
      library.isolate();
      await library.project('Footer Library', 'images', ['f01.png']);
      await page.goto(`${library.baseURL}/asset-viewer`);
      await expect(page.locator('[data-asset-library-defaults-save]')).toBeEnabled();
      return { pathname: '/asset-viewer' };
    },
    defaultsPath: () => '/asset-viewer/defaults',
    resetPath: () => '/asset-viewer/defaults/reset',
    confirmsReset: false,
  },
  Projects: {
    dialog: '#projects-filter-dialog',
    async open(page) {
      projects.isolate();
      projects.project('Footer Projects');
      await page.goto(`${projects.baseURL}/projects`);
      await expect(page.locator('[data-projects-defaults-save]')).toBeEnabled();
      return { pathname: '/projects' };
    },
    defaultsPath: () => '/projects/defaults',
    resetPath: () => '/projects/defaults/reset',
    confirmsReset: false,
  },
};

function record(page) {
  const control = { posts: [], gets: [], errors: [] };
  page.on('pageerror', (error) => control.errors.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() === 'POST') control.posts.push(url.pathname);
    else if (['fetch', 'document'].includes(request.resourceType())) control.gets.push(url);
  });
  return control;
}

async function openDialog(page, selector) {
  await page.getByRole('link', { name: 'Filters & Defaults', exact: true }).click();
  await expect(page.locator(selector)).toBeVisible();
}

async function closeDialog(page, selector) {
  await page.locator(selector).getByRole('button', { name: 'Close Filters & Defaults', exact: true }).click();
  await expect(page.locator(selector)).toBeHidden();
}

// Each footer button's rendered treatment, plus a reference direct-child
// .button-primary (the treatment Save new defaults carried before R1).
async function footerLooks(page, selector) {
  return page.locator(`${selector} footer`).evaluate((footer) => {
    const look = (element) => {
      const style = getComputedStyle(element);
      return {
        background: style.backgroundColor, border: style.borderTopColor, color: style.color,
        weight: style.fontWeight, minHeight: style.minHeight, padding: style.paddingLeft, shadow: style.boxShadow,
      };
    };
    const reference = document.createElement('button');
    reference.type = 'button';
    reference.className = 'button button-primary';
    reference.textContent = 'Reference';
    footer.append(reference);
    const looks = Object.fromEntries([...footer.querySelectorAll('button')]
      .filter((button) => button !== reference).map((button) => [button.textContent.trim(), look(button)]));
    looks.reference = look(reference);
    reference.remove();
    return looks;
  });
}

for (const [name, config] of Object.entries(PAGES)) {
  test(`R1 A–E ${name}: footer DOM order, styling and Tab order`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const control = record(page);
    await config.open(page);
    await openDialog(page, config.dialog);
    const footer = page.locator(`${config.dialog} footer`);

    // A: the actual DOM order (the footer is a plain flex row, no CSS order).
    await expect(footer.locator('button')).toHaveText(ORDER);
    const orderStyles = await footer.locator('button, form').evaluateAll((elements) => elements
      .map((element) => getComputedStyle(element).order));
    expect(new Set(orderStyles)).toEqual(new Set(['0']));
    // Visual order follows DOM order on one row.
    const boxes = await footer.locator('button').evaluateAll((buttons) => buttons
      .map((button) => button.getBoundingClientRect().left));
    expect([...boxes].sort((a, b) => a - b)).toEqual(boxes);

    // B/C/D: classes and the rendered treatments.
    const save = footer.getByRole('button', { name: ORDER[0], exact: true });
    const resetDefaults = footer.getByRole('button', { name: ORDER[1], exact: true });
    const resetFilters = footer.getByRole('button', { name: ORDER[2], exact: true });
    await expect(save).toHaveClass('button button-secondary');
    await expect(resetDefaults).toHaveClass('button button-secondary');
    await expect(resetFilters).toHaveClass('button button-primary');
    await expect(footer.locator('[style]')).toHaveCount(0);
    const looks = await footerLooks(page, config.dialog);
    expect(looks[ORDER[0]]).toEqual(looks[ORDER[1]]);
    expect(looks[ORDER[2]]).toEqual(looks.reference);
    expect(looks[ORDER[2]]).not.toEqual(looks[ORDER[0]]);

    // Element types and form ownership are unchanged.
    expect(await resetFilters.evaluate((button) => [button.type, button.form?.method, button.form?.classList
      .contains('filters-defaults-reset-form')])).toEqual(['submit', 'get', true]);
    expect(await resetDefaults.evaluate((button) => button.type)).toBe('button');

    // E: keyboard Tab order matches.
    await save.focus();
    await page.keyboard.press('Tab');
    await expect(resetDefaults).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(resetFilters).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(resetDefaults).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(save).toBeFocused();

    // Nothing above wrote anything.
    expect(control.posts).toEqual([]);
    expect(control.errors).toEqual([]);
  });

  test(`R1 F–J ${name}: Save, Reset defaults and Reset filters keep their behavior`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const control = record(page);
    const context = await config.open(page);
    const box = page.locator(config.dialog);
    const save = box.getByRole('button', { name: ORDER[0], exact: true });
    const resetDefaults = box.getByRole('button', { name: ORDER[1], exact: true });
    const resetFilters = box.getByRole('button', { name: ORDER[2], exact: true });
    const defaultsPosts = () => control.posts.filter((path) => path === config.defaultsPath(context));
    const resetPosts = () => control.posts.filter((path) => path === config.resetPath(context));

    // J: repeated opening never duplicates the Save handler.
    for (let round = 0; round < 3; round += 1) {
      await openDialog(page, config.dialog);
      await closeDialog(page, config.dialog);
    }
    await openDialog(page, config.dialog);

    // F (mouse) and I (pending): one POST; a second click while it is held
    // sends nothing more.
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    await page.route((url) => url.pathname === config.defaultsPath(context), async (route) => {
      await held;
      await route.continue();
    });
    await save.click();
    await expect.poll(() => defaultsPosts().length).toBe(1);
    await save.click({ force: true });
    if (name !== 'Project Assets') await expect(save).toHaveAttribute('aria-disabled', 'true');
    release();
    await expect(box.locator('[data-settings-fetch-save-status]')).toHaveText(/saved\.$/);
    await page.unroute((url) => url.pathname === config.defaultsPath(context));
    await expect(save).not.toHaveAttribute('aria-disabled', 'true');
    expect(defaultsPosts()).toHaveLength(1);

    // F (keyboard): Enter and Space each save exactly once.
    await save.focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => defaultsPosts().length).toBe(2);
    await expect(box.locator('[data-settings-fetch-save-status]')).toHaveText(/saved\.$/);
    await save.focus();
    await page.keyboard.press('Space');
    await expect.poll(() => defaultsPosts().length).toBe(3);
    await expect(box.locator('[data-settings-fetch-save-status]')).toHaveText(/saved\.$/);
    await page.waitForLoadState('networkidle');
    expect(defaultsPosts()).toHaveLength(3);

    // G: Reset defaults keeps its own confirmation behavior.
    if (config.confirmsReset) {
      await resetDefaults.click();
      const confirm = page.locator('dialog[open]').filter({ hasText: 'Reset Global defaults' });
      await expect(confirm).toBeVisible();
      await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(confirm).toBeHidden();
      expect(resetPosts()).toEqual([]);
      await resetDefaults.click();
      await confirm.getByRole('button', { name: 'Reset defaults', exact: true }).click();
    } else {
      await resetDefaults.click();
    }
    await expect.poll(() => resetPosts().length).toBe(1);
    await expect(box.locator('[data-settings-fetch-save-status]')).toHaveText(/reset/i);
    await page.waitForLoadState('networkidle');

    // H: Reset filters is a GET to the page; it never POSTs or saves.
    const postsBefore = control.posts.length;
    const getsBefore = control.gets.length;
    await resetFilters.click();
    await expect.poll(() => control.gets.slice(getsBefore)
      .some((url) => url.pathname === context.pathname)).toBe(true);
    await page.waitForLoadState('networkidle');
    expect(control.posts.slice(postsBefore)).toEqual([]);
    expect(control.errors).toEqual([]);
  });
}
