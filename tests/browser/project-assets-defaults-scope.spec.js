import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import sharp from 'sharp';
import { createApp } from '../../src/app.js';
import { createAssetManifest } from '../../src/asset-manifest.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';

// WP7: Filters & Defaults saves defaults explicitly with Save new defaults.
async function selectAndSave(page, locator, value) {
  await locator.selectOption(value, { force: true });
  await page.locator('#project-assets-filter-dialog')
    .getByRole('button', { name: 'Save new defaults', exact: true }).click();
}

// R3: the dialog shows only the current View's presentation fields; the other
// View's Grid style / size field is hidden, but stays enabled, valued and
// saved. Several scenarios below deliberately edit that hidden field while the
// other View is displayed (a setup Save, or an edit made during a held
// activation whose request timing they measure). A user reaches it by
// switching the View, which would add a navigation to those scenarios, so a
// hidden field is set through its native select instead: the same input and
// change the dropdown dispatches for a choice. Visible fields keep the UI path.
async function chooseHiddenPresentationField(page, dropdownId, label) {
  const wrapper = page.locator(`#${dropdownId}`).locator('xpath=ancestor::*[@data-filters-visible-when-view][1]');
  if (await wrapper.count() === 0 || !(await wrapper.evaluate((node) => node.hidden))) return false;
  await page.locator(`#${dropdownId.replace(/-dropdown$/, '')}`).selectOption({ label }, { force: true });
  return true;
}

// External runs intentionally edit defaults for two explicitly named projects.
// Without these environment variables all data is isolated and removed afterward.
async function fixture({ many = false, extra = 0 } = {}) {
  const external = process.env.CREATORCRATE_BROWSER_BASE_URL;
  if (external) {
    const ids = ['CREATORCRATE_BROWSER_PROJECT_A', 'CREATORCRATE_BROWSER_PROJECT_B']
      .map((key) => Number(process.env[key]));
    if (ids.some((id) => !Number.isInteger(id) || id <= 0) || ids[0] === ids[1]) {
      throw new Error('External scope regression requires two distinct explicit project IDs.');
    }
    return { baseURL: external, ids, close: async () => {} };
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-scope-browser-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  const viteDistRoot = path.join(root, 'client');
  const previewRoot = path.join(root, 'previews');
  fs.mkdirSync(projectsRoot);
  fs.mkdirSync(appDataRoot);
  fs.mkdirSync(previewRoot);
  let db;
  let server;
  const close = async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    if (db) closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  };
  try {
    await build({ build: { outDir: viteDistRoot }, logLevel: 'silent' });
    db = openDatabase(path.join(root, 'test.db'));
    runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot, previewRoot }, {
      appDataRoot, authState: { csrfPepper }, useViteAssets: true, viteDistRoot,
      assetManifest: createAssetManifest({ distRoot: viteDistRoot,
        manifestPath: path.join(viteDistRoot, '.vite', 'manifest.json') }),
    });
    const ids = [];
    const finalCategoryIds = [];
    for (const title of ['Scope Browser A', 'Scope Browser B']) {
      const project = app.locals.projectService.create({ title, status: 'tbd' });
      ids.push(project.id);
      finalCategoryIds.push(app.locals.projectAssetCategoryService.list(project.id)
        .find((category) => category.directory_slug === 'final').id);
      await sharp({ create: { width: 12, height: 12, channels: 3, background: '#336699' } })
        .png().toFile(path.join(projectsRoot, project.project_dir, 'final', 'scope.png'));
      await sharp({ create: { width: 48, height: 12, channels: 3, background: '#993366' } })
        .png().toFile(path.join(projectsRoot, project.project_dir, 'final', 'wide.png'));
      if (many) {
        // Correction B: enough assets for a second page, two extensions, two tags.
        for (let index = 1; index <= 12; index += 1) {
          await sharp({ create: { width: 12, height: 12, channels: 3, background: '#225577' } })
            .png().toFile(path.join(projectsRoot, project.project_dir, 'final', `p${String(index).padStart(2, '0')}.png`));
        }
        for (let index = 1; index <= 3; index += 1) {
          await sharp({ create: { width: 12, height: 12, channels: 3, background: '#775522' } })
            .jpeg().toFile(path.join(projectsRoot, project.project_dir, 'final', `j${index}.jpg`));
        }
      }
      // Correction C: enough assets for three pages at the 25-per-page fallback.
      for (let index = 1; index <= extra; index += 1) {
        await sharp({ create: { width: 12, height: 12, channels: 3, background: '#557722' } })
          .png().toFile(path.join(projectsRoot, project.project_dir, 'final', `x${String(index).padStart(2, '0')}.png`));
      }
      app.locals.assetScanner.scanProjectAssets(project.id);
    }
    const tagIds = {};
    if (many) {
      for (const name of ['Alpha', 'Beta']) tagIds[name] = app.locals.tagService.createTag({ name }).id;
      db.prepare('SELECT id, filename FROM assets WHERE project_id = ?').all(ids[0]).forEach((asset) => {
        app.locals.assetTagService.replaceAssetTags(asset.id, [asset.filename.endsWith('.jpg') ? tagIds.Beta : tagIds.Alpha]);
      });
    }
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    return { baseURL: `http://127.0.0.1:${server.address().port}`, ids, finalCategoryIds, tagIds, app, close };
  } catch (error) {
    await close();
    throw error;
  }
}

test('scope-only toggles live-refresh once, survive reloads, and preserve both projects', async ({ page, context }) => {
  const f = await fixture();
  const b = await context.newPage();
  const dialog = (p) => p.locator('#project-assets-filter-dialog');
  const form = (p) => p.locator('#project-assets-defaults-form');
  const snapshots = (p) => form(p).locator('[data-project-assets-default-values]')
    .evaluate((el) => JSON.parse(el.textContent));
  const open = async (p, id) => {
    await p.goto(`${f.baseURL}/projects/${id}/assets`);
    await p.getByRole('link', { name: 'Filters & Defaults', exact: true }).click();
    await expect(dialog(p)).toBeVisible();
  };
  const settled = async (p) => {
    await expect(form(p)).toHaveAttribute('data-settings-fetch-save-state', 'saved');
    await expect(p.locator('[data-project-assets-live-region]')).not.toHaveAttribute('aria-busy', 'true');
  };
  const mutate = async (p, action) => {
    const posts = [];
    let navigations = 0;
    const onRequest = (r) => {
      if (r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/assets/defaults')) posts.push(r);
      if (r.isNavigationRequest() && r.frame() === p.mainFrame()) navigations += 1;
    };
    p.on('request', onRequest);
    const saved = p.waitForResponse((r) => r.request().method() === 'POST'
      && new URL(r.url()).pathname.endsWith('/assets/defaults'));
    try {
      await action();
      expect((await saved).status()).toBeLessThan(400);
      await settled(p);
      expect(posts).toHaveLength(1);
      expect(navigations).toBe(0);
      await expect(dialog(p)).toBeVisible();
    } finally {
      p.off('request', onRequest);
    }
  };
  const scope = async (p, value) => {
    if (await form(p).locator('input[name="loadedScope"]').inputValue() === value) return;
    await mutate(p, () => dialog(p).getByText(value === 'global' ? 'Global' : 'Project only', { exact: true }).click());
    await expect(form(p).locator('input[name="loadedScope"]')).toHaveValue(value);
    expect(new URL(p.url()).searchParams.has('defaultsScope')).toBe(false);
  };
  const choose = async (p, key, label) => {
    const dropdown = dialog(p).locator(key === 'view' ? '#asset-view-filter-dropdown' : '#asset-sort-filter');
    if (!(await dropdown.locator('summary').getAttribute('aria-label')).endsWith(`: ${label}`)) {
      await dropdown.locator('summary').click();
      await dropdown.locator('label').filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) }).click();
      await expect(dropdown.locator('summary')).toHaveAttribute('aria-label', new RegExp(`: ${label}$`));
      await expect(p.locator('[data-project-assets-live-region]')).not.toHaveAttribute('aria-busy', 'true');
    }
    await mutate(p, () => dialog(p).getByRole('button', { name: 'Save new defaults', exact: true }).click());
  };
  const effective = async (p, view, sort) => {
    await expect(p.locator(`[data-project-assets-live-region] .asset-${view}`)).toHaveCount(1);
    expect(new URL(p.url()).searchParams.get('sort') || 'filename').toBe(sort);
  };
  const reload = async (p, active, view, sort) => {
    await p.reload();
    await effective(p, view, sort);
    await p.getByRole('link', { name: 'Filters & Defaults', exact: true }).click();
    await expect(form(p).locator('input[name="loadedScope"]')).toHaveValue(active);
    await expect(dialog(p).getByRole('radio', { name: active === 'global' ? 'Global' : 'Project only', exact: true })).toBeChecked();
  };
  try {
    await open(page, f.ids[0]);
    await scope(page, 'global');
    await choose(page, 'view', 'Grid');
    await choose(page, 'sort', 'Filename');
    await scope(page, 'project');
    await choose(page, 'view', 'List');
    await choose(page, 'sort', 'Modified date');
    const aRows = (await snapshots(page)).project;
    await dialog(page).getByRole('button', { name: 'Close Filters & Defaults' }).click();
    await page.getByRole('link', { name: 'Filters & Defaults', exact: true }).click();
    let releaseSave;
    let markIntercepted;
    const heldSave = new Promise((resolve) => { releaseSave = resolve; });
    const intercepted = new Promise((resolve) => { markIntercepted = resolve; });
    const defaultsRoute = `**/projects/${f.ids[0]}/assets/defaults`;
    const holdPost = async (route) => {
      if (route.request().method() === 'POST') {
        markIntercepted();
        await heldSave;
      }
      await route.continue();
    };
    await page.route(defaultsRoute, holdPost);
    try {
      await mutate(page, async () => {
        await dialog(page).getByText('Global', { exact: true }).click();
        await intercepted;
        await dialog(page).getByRole('button', { name: 'Close Filters & Defaults' }).click();
        await page.getByRole('link', { name: 'Filters & Defaults', exact: true }).click();
        await expect(form(page).locator('input[name="loadedScope"]')).toHaveValue('project');
        releaseSave();
      });
      await expect(form(page).locator('input[name="loadedScope"]')).toHaveValue('global');
      await expect(dialog(page).getByRole('radio', { name: 'Global', exact: true })).toBeChecked();
      await expect(dialog(page).locator('#asset-view-filter')).toHaveValue('grid');
    } finally {
      releaseSave();
      await page.unroute(defaultsRoute, holdPost);
    }
    await effective(page, 'grid', 'filename');
    await reload(page, 'global', 'grid', 'filename');
    expect((await snapshots(page)).project).toEqual(aRows);
    await scope(page, 'project');
    await effective(page, 'list', 'modified');
    await reload(page, 'project', 'list', 'modified');
    expect((await snapshots(page)).project).toEqual(aRows);

    await open(b, f.ids[1]);
    await scope(b, 'project');
    await choose(b, 'view', 'List');
    await choose(b, 'sort', 'File size');
    const bRows = (await snapshots(b)).project;
    await scope(b, 'global');
    await effective(b, 'grid', 'filename');
    await choose(b, 'sort', 'Modified date');
    await reload(b, 'global', 'grid', 'modified');
    expect((await snapshots(b)).project).toEqual(bRows);
    await reload(page, 'project', 'list', 'modified');
    expect((await snapshots(page)).global.sort).toBe('modified');
    expect((await snapshots(page)).project).toEqual(aRows);
    await scope(page, 'global');
    await choose(page, 'sort', 'Filename');
    await scope(page, 'project');
    await open(b, f.ids[1]);
    await effective(b, 'grid', 'filename');
    await scope(b, 'project');
    await effective(b, 'list', 'size');
    expect((await snapshots(b)).project).toEqual(bRows);
    await scope(b, 'global');
    await reload(b, 'global', 'grid', 'filename');
    await reload(page, 'project', 'list', 'modified');
  } finally {
    await b.close();
    await f.close();
  }
});

// Grid style: Uncropped keeps intrinsic previews; Cropped squares each Grid
// media viewport through the shared .asset-grid rules, per active scope.
test('Grid style follows the active defaults scope and squares only Grid media', async ({ page }) => {
  test.skip(Boolean(process.env.CREATORCRATE_BROWSER_BASE_URL), 'Requires the isolated wide-image fixture.');
  const f = await fixture();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const dialog = page.locator('#project-assets-filter-dialog');
  const form = page.locator('#project-assets-defaults-form');
  const grid = page.locator('[data-project-assets-live-region] .asset-grid');
  const wideCard = page.locator('.asset-grid article.asset-card').filter({ has: page.locator('img[alt*="wide.png"]') });
  const wideLink = wideCard.locator('.asset-card-media-link');
  const sizeOf = (locator) => locator.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return { width: Math.round(box.width), height: Math.round(box.height) };
  });
  const expectSquare = async (locator) => {
    const size = await sizeOf(locator);
    expect(size.width).toBeGreaterThan(0);
    expect(Math.abs(size.width - size.height)).toBeLessThanOrEqual(1);
  };
  const expectWide = async (locator) => {
    const size = await sizeOf(locator);
    expect(size.width).toBeGreaterThan(size.height * 1.5);
  };
  const openDefaults = async () => {
    await page.getByRole('link', { name: 'Filters & Defaults', exact: true }).click();
    await expect(dialog).toBeVisible();
  };
  const settle = async (action) => {
    const saved = page.waitForResponse((r) => r.request().method() === 'POST'
      && new URL(r.url()).pathname.endsWith('/assets/defaults'));
    await action();
    expect((await saved).status()).toBeLessThan(400);
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'saved');
    await expect(page.locator('[data-project-assets-live-region]')).not.toHaveAttribute('aria-busy', 'true');
  };
  const chooseStyle = (value) => settle(() => selectAndSave(page, page.locator('#projectAssets-default-gridStyle'), value));
  const chooseScope = async (value) => {
    if (await form.locator('input[name="loadedScope"]').inputValue() === value) return;
    await settle(() => dialog.getByText(value === 'global' ? 'Global' : 'Project only', { exact: true }).click());
    await expect(form.locator('input[name="loadedScope"]')).toHaveValue(value);
  };
  const closeDefaults = async () => {
    await dialog.getByRole('button', { name: 'Close Filters & Defaults' }).click();
    await expect(dialog).toBeHidden();
  };

  try {
    const [first, second] = f.ids;
    await page.goto(`${f.baseURL}/projects/${first}/assets?view=grid`);
    await expect(grid).toHaveAttribute('data-grid-style', 'uncropped');
    await expect(wideCard.locator('[data-preview-image]')).toBeVisible();
    await expectWide(wideLink);

    await openDefaults();
    const fieldOrder = await dialog.locator('section [data-dialog-field]')
      .evaluateAll((nodes) => nodes.map((node) => node.dataset.dialogField));
    expect(fieldOrder).toEqual(['gridStyle', 'gridSize', 'listSize']);
    await expect(page.locator('#projectAssets-default-gridStyle')).toHaveValue('uncropped');
    await chooseScope('global');
    await chooseStyle('cropped');
    await expect(grid).toHaveAttribute('data-grid-style', 'cropped');
    await closeDefaults();

    // Image: square viewport with a covering, centered image clipped by the link.
    await expect(wideCard.locator('[data-preview-image]')).toBeVisible();
    await expectSquare(wideLink);
    expect(await wideCard.locator('[data-preview-image]').evaluate((node) => {
      const box = node.getBoundingClientRect();
      const link = node.parentElement.getBoundingClientRect();
      const computed = getComputedStyle(node);
      return {
        objectFit: computed.objectFit,
        objectPosition: computed.objectPosition,
        fills: Math.abs(box.width - link.width) <= 1 && Math.abs(box.height - link.height) <= 1,
        linkOverflow: getComputedStyle(node.parentElement).overflow,
      };
    })).toEqual({ objectFit: 'cover', objectPosition: '50% 50%', fills: true, linkOverflow: 'hidden' });

    // Only the media viewport is squared; the information card still opens.
    expect((await sizeOf(wideCard)).height).toBeGreaterThan((await sizeOf(wideLink)).height);
    await wideLink.hover();
    await expect(wideCard.locator('[data-asset-info-card]')).toBeVisible();
    await page.mouse.move(0, 0);

    // Selection and Grid size stay independent of the style.
    await wideCard.locator('.asset-selection-control').click();
    await expect(wideCard.locator('.asset-select-checkbox')).toBeChecked();
    const sizeLabel = (size) => page.locator(`[data-asset-grid-size-controls] [data-grid-size-option-label="${size}"]`);
    await sizeLabel('large').click();
    await expect(grid).toHaveAttribute('data-grid-size', 'large');
    await expect(grid).toHaveAttribute('data-grid-style', 'cropped');
    await expectSquare(wideLink);
    await expect(wideCard.locator('.asset-select-checkbox')).toBeChecked();
    await sizeLabel('default').click();

    // Grid/List switching: List is unchanged and Grid restores Cropped.
    await page.locator('nav.view-switcher a[aria-label$="List view"]').click();
    await expect(page.locator('.asset-list--project')).toBeVisible();
    await expect(page.locator('[data-grid-style]')).toHaveCount(0);
    await page.locator('nav.view-switcher a[aria-label$="Grid view"]').click();
    await expect(grid).toHaveAttribute('data-grid-style', 'cropped');
    await expectSquare(wideLink);

    // Project-only: this project's own style wins; the other project follows Global.
    await openDefaults();
    await chooseScope('project');
    await chooseStyle('uncropped');
    await expect(grid).toHaveAttribute('data-grid-style', 'uncropped');
    await closeDefaults();
    await expectWide(wideLink);
    await page.reload();
    await expect(grid).toHaveAttribute('data-grid-style', 'uncropped');
    await page.goto(`${f.baseURL}/projects/${second}/assets?view=grid`);
    await expect(grid).toHaveAttribute('data-grid-style', 'cropped');

    // Switching back to Global restores the Global style and keeps the dormant value.
    await page.goto(`${f.baseURL}/projects/${first}/assets?view=grid`);
    await openDefaults();
    await chooseScope('global');
    await expect(page.locator('#projectAssets-default-gridStyle')).toHaveValue('cropped');
    await expect(grid).toHaveAttribute('data-grid-style', 'cropped');
    const values = await form.locator('[data-project-assets-default-values]')
      .evaluate((el) => JSON.parse(el.textContent));
    expect(values.global.gridStyle).toBe('cropped');
    expect(values.project.gridStyle).toBe('uncropped');
    await closeDefaults();
    await expectSquare(wideLink);
    expect(pageErrors).toEqual([]);
  } finally {
    await f.close();
  }
});

// A Grid style-only save restyles the rendered grid in place: selection,
// an unsaved category reorder, and the grid node itself survive both
// directions under Global and Project-only scopes.
test('Grid style saves keep selection and unsaved category order in both scopes', async ({ page }) => {
  test.skip(Boolean(process.env.CREATORCRATE_BROWSER_BASE_URL), 'Requires the isolated category fixture.');
  const f = await fixture();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const [projectId] = f.ids;
  const regionLoads = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    // The save's own followed redirect is not a live-region reload.
    if (request.method() === 'GET' && !request.redirectedFrom()
      && url.pathname === `/projects/${projectId}/assets`) regionLoads.push(url.href);
  });
  const dialog = page.locator('#project-assets-filter-dialog');
  const form = page.locator('#project-assets-defaults-form');
  const region = page.locator('[data-project-assets-live-region]');
  const grid = region.locator('.asset-grid');
  const item = (name) => region.locator(`[data-auto-rename-asset][aria-label="Reorder ${name}"]`);
  const renderedNames = () => region.locator('[data-auto-rename-asset]').evaluateAll((nodes) => nodes.map(
    (node) => node.getAttribute('aria-label').replace(/^Reorder /, ''),
  ));
  const orderInput = page.locator('[data-auto-rename-order-input]');
  const count = page.locator('[data-selected-count]');
  const wideLink = item('wide.png').locator('.asset-card-media-link');
  const mediaShape = () => wideLink.evaluate((node) => {
    const box = node.getBoundingClientRect();
    if (Math.abs(box.width - box.height) <= 1) return 'square';
    return box.width > box.height * 1.5 ? 'wide' : 'other';
  });
  const settle = async (action) => {
    const saved = page.waitForResponse((r) => r.request().method() === 'POST'
      && new URL(r.url()).pathname.endsWith('/assets/defaults'));
    await action();
    expect((await saved).status()).toBeLessThan(400);
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'saved');
    await expect(region).not.toHaveAttribute('aria-busy', 'true');
  };
  const openDefaults = async () => {
    await page.getByRole('link', { name: 'Filters & Defaults', exact: true }).click();
    await expect(dialog).toBeVisible();
  };
  const closeDefaults = async () => {
    await dialog.getByRole('button', { name: 'Close Filters & Defaults' }).click();
    await expect(dialog).toBeHidden();
  };
  const chooseScope = async (value) => {
    if (await form.locator('input[name="loadedScope"]').inputValue() === value) return;
    await settle(() => dialog.getByText(value === 'global' ? 'Global' : 'Project only', { exact: true }).click());
    await expect(form.locator('input[name="loadedScope"]')).toHaveValue(value);
  };
  // Select both assets and drag wide.png ahead of scope.png without saving.
  const makeTransientState = async () => {
    await expect.poll(renderedNames).toEqual(['scope.png', 'wide.png']);
    for (const name of ['scope.png', 'wide.png']) {
      await item(name).locator('.asset-selection-control').click();
      await expect(item(name).locator('input[name="selectedAssetIds"]')).toBeChecked();
    }
    await expect(count).toHaveText('2 of 2 selected');
    const first = item('scope.png');
    const firstBox = await first.boundingBox();
    await item('wide.png').dragTo(first, { targetPosition: { x: 2, y: firstBox.height / 2 } });
    await expect.poll(renderedNames).toEqual(['wide.png', 'scope.png']);
    await grid.evaluate((node) => { node.dataset.styleRegressionMarker = 'kept'; });
    return orderInput.inputValue();
  };
  const changeStyle = async (value, pendingOrder) => {
    await openDefaults();
    const loadsBefore = regionLoads.length;
    await settle(() => selectAndSave(page, page.locator('#projectAssets-default-gridStyle'), value));
    await expect(grid).toHaveAttribute('data-grid-style', value);
    await closeDefaults();
    expect(regionLoads.slice(loadsBefore)).toEqual([]);
    await expect(grid).toHaveAttribute('data-style-regression-marker', 'kept');
    await expect(count).toHaveText('2 of 2 selected');
    for (const name of ['scope.png', 'wide.png']) {
      await expect(item(name).locator('input[name="selectedAssetIds"]')).toBeChecked();
    }
    expect(await renderedNames()).toEqual(['wide.png', 'scope.png']);
    expect(await orderInput.inputValue()).toBe(pendingOrder);
    expect(await mediaShape()).toBe(value === 'cropped' ? 'square' : 'wide');
  };

  try {
    const pageUrl = `${f.baseURL}/projects/${projectId}/assets?view=grid&category=${f.finalCategoryIds[0]}`;
    await page.goto(pageUrl);
    await expect(grid).toHaveAttribute('data-grid-style', 'uncropped');
    await expect(region.locator('[data-auto-rename-surface]'))
      .toHaveAttribute('data-category-reorder-enabled', 'true');

    // Global scope: Uncropped -> Cropped -> Uncropped.
    await openDefaults();
    await chooseScope('global');
    await closeDefaults();
    let pendingOrder = await makeTransientState();
    await changeStyle('cropped', pendingOrder);
    await changeStyle('uncropped', pendingOrder);

    // A scope switch is not style-only and still takes the full refresh.
    await openDefaults();
    const loadsBeforeScope = regionLoads.length;
    await chooseScope('project');
    expect(regionLoads.length).toBeGreaterThan(loadsBeforeScope);
    await closeDefaults();

    // Project-only scope: Cropped -> Uncropped -> Cropped.
    await page.goto(pageUrl);
    pendingOrder = await makeTransientState();
    await changeStyle('cropped', pendingOrder);
    await changeStyle('uncropped', pendingOrder);
    await changeStyle('cropped', pendingOrder);

    // Reload resolves the persisted Project-only style; Global keeps its own.
    await page.goto(pageUrl);
    await expect(grid).toHaveAttribute('data-grid-style', 'cropped');
    const values = await form.locator('[data-project-assets-default-values]')
      .evaluate((el) => JSON.parse(el.textContent));
    expect(values.project.gridStyle).toBe('cropped');
    expect(values.global.gridStyle).toBe('uncropped');

    // WP7: a Save made in List view also stores View = List (the view shown),
    // so the region re-renders through the state-preserving refresh: List
    // stays, and the style applies on Grid.
    const list = page.locator('.asset-list--project');
    await page.locator('nav.view-switcher a[aria-label$="List view"]').click();
    await expect(list).toBeVisible();
    await openDefaults();
    await settle(() => selectAndSave(page, page.locator('#projectAssets-default-gridStyle'), 'uncropped'));
    await closeDefaults();
    await expect(list).toBeVisible();
    expect((await form.locator('[data-project-assets-default-values]')
      .evaluate((el) => JSON.parse(el.textContent))).project.view).toBe('list');
    await expect(page.locator('[data-grid-style]')).toHaveCount(0);
    await page.locator('nav.view-switcher a[aria-label$="Grid view"]').click();
    await expect(grid).toHaveAttribute('data-grid-style', 'uncropped');
    expect(await mediaShape()).toBe('wide');
    expect(pageErrors).toEqual([]);
  } finally {
    await f.close();
  }
});

// Global and Project-only start identical, so a failed scope-switch refresh
// leaves nothing stale but its error. The style-only save restyles in place,
// which reconciles the presentation and retires that obsolete reload prompt.
test('in-place Grid style save clears the obsolete failed-refresh error', async ({ page }) => {
  test.skip(Boolean(process.env.CREATORCRATE_BROWSER_BASE_URL), 'Requires the isolated category fixture.');
  const f = await fixture();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const [projectId] = f.ids;
  const regionLoads = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() === 'GET' && !request.redirectedFrom()
      && url.pathname === `/projects/${projectId}/assets`) regionLoads.push(url.href);
  });
  const dialog = page.locator('#project-assets-filter-dialog');
  const form = page.locator('#project-assets-defaults-form');
  const formStatus = form.locator('[data-settings-fetch-save-status]');
  const region = page.locator('[data-project-assets-live-region]');
  const liveStatus = region.locator('[data-project-assets-live-status]');
  const grid = region.locator('.asset-grid');
  const item = (name) => region.locator(`[data-auto-rename-asset][aria-label="Reorder ${name}"]`);
  const renderedNames = () => region.locator('[data-auto-rename-asset]').evaluateAll((nodes) => nodes.map(
    (node) => node.getAttribute('aria-label').replace(/^Reorder /, ''),
  ));
  const orderInput = page.locator('[data-auto-rename-order-input]');
  const count = page.locator('[data-selected-count]');
  const saved = () => page.waitForResponse((r) => r.request().method() === 'POST'
    && new URL(r.url()).pathname.endsWith('/assets/defaults'));
  const refreshPattern = new RegExp(`/projects/${projectId}/assets([?]|$)`);
  let armed = true;
  const abortRefresh = async (r) => {
    const request = r.request();
    if (!armed || request.method() !== 'GET' || request.redirectedFrom()) {
      await r.continue().catch(() => {});
      return;
    }
    armed = false;
    await r.abort('failed');
  };

  try {
    await page.goto(`${f.baseURL}/projects/${projectId}/assets?view=grid&category=${f.finalCategoryIds[0]}`);
    await expect(grid).toHaveAttribute('data-grid-style', 'uncropped');
    await expect(region.locator('[data-auto-rename-surface]'))
      .toHaveAttribute('data-category-reorder-enabled', 'true');
    const values = await form.locator('[data-project-assets-default-values]')
      .evaluate((el) => JSON.parse(el.textContent));
    expect(values.project).toEqual(values.global);

    // Selection and an unsaved reorder that must outlive both saves.
    for (const name of ['scope.png', 'wide.png']) {
      await item(name).locator('.asset-selection-control').click();
    }
    await expect(count).toHaveText('2 of 2 selected');
    const firstBox = await item('scope.png').boundingBox();
    await item('wide.png').dragTo(item('scope.png'), { targetPosition: { x: 2, y: firstBox.height / 2 } });
    await expect.poll(renderedNames).toEqual(['wide.png', 'scope.png']);
    const pendingOrder = await orderInput.inputValue();

    // A. The scope switch saves, but its live-region refresh fails.
    await page.getByRole('link', { name: 'Filters & Defaults', exact: true }).click();
    await expect(dialog).toBeVisible();
    await page.route(refreshPattern, abortRefresh);
    let response = saved();
    await dialog.getByText('Project only', { exact: true }).click();
    expect((await response).status()).toBeLessThan(400);
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'saved-refresh-error');
    await expect(liveStatus).toHaveText(
      'Defaults scope changed, but Project Assets could not refresh. Refresh the page to see the loaded defaults.',
    );
    await expect(region).toHaveAttribute('data-project-assets-live-state', 'error');
    await page.unroute(refreshPattern, abortRefresh);
    await expect(form.locator('input[name="loadedScope"]')).toHaveValue('project');

    // B. The style-only save restyles in place and clears the obsolete error.
    const loadsBefore = regionLoads.length;
    response = saved();
    await selectAndSave(page, page.locator('#projectAssets-default-gridStyle'), 'cropped');
    expect((await response).status()).toBeLessThan(400);
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'saved');
    await expect(formStatus).toHaveText('Settings saved.');
    await expect(grid).toHaveAttribute('data-grid-style', 'cropped');
    await expect(liveStatus).toHaveText('');
    await expect(region).not.toHaveAttribute('data-project-assets-live-state', /.*/);
    expect(regionLoads.slice(loadsBefore)).toEqual([]);

    // C. Selection and pending ordering survive.
    await dialog.getByRole('button', { name: 'Close Filters & Defaults' }).click();
    await expect(dialog).toBeHidden();
    await expect(count).toHaveText('2 of 2 selected');
    for (const name of ['scope.png', 'wide.png']) {
      await expect(item(name).locator('input[name="selectedAssetIds"]')).toBeChecked();
    }
    expect(await renderedNames()).toEqual(['wide.png', 'scope.png']);
    expect(await orderInput.inputValue()).toBe(pendingOrder);

    // E. WP7: View is a live control. Once List is shown, a Save stores it and
    // takes the state-preserving refresh; when that refresh fails the reload
    // prompt shows on the form and List stays on screen.
    await page.getByRole('link', { name: 'Filters & Defaults', exact: true }).click();
    await expect(dialog).toBeVisible();
    const viewDropdown = dialog.locator('#asset-view-filter-dropdown');
    await viewDropdown.locator('summary').click();
    await viewDropdown.locator('label').filter({ hasText: /^\s*List\s*$/ }).click();
    await expect(region.locator('.asset-list--project')).toBeVisible();
    await expect(region).not.toHaveAttribute('aria-busy', 'true');
    armed = true;
    await page.route(refreshPattern, abortRefresh);
    response = saved();
    await dialog.getByRole('button', { name: 'Save new defaults', exact: true }).click();
    expect((await response).status()).toBeLessThan(400);
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'saved-refresh-error');
    await expect(region.locator('.asset-list--project')).toBeVisible();
    await page.unroute(refreshPattern, abortRefresh);
    expect(pageErrors).toEqual([]);
  } finally {
    await f.close();
  }
});

// WP7: Save new defaults in the combined dialog stores the eligible values the
// page shows, never the temporary ones, and keeps the current context: Category,
// Search, Presence, Release usage, page size and selection survive, a newer edit
// made while the Save is pending wins, and a failed Save keeps the user's values.
test('Filters & Defaults Save keeps the current context, newer edits and failed values', async ({ page }) => {
  test.skip(Boolean(process.env.CREATORCRATE_BROWSER_BASE_URL), 'Requires the isolated fixture.');
  const f = await fixture();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const [projectId] = f.ids;
  const dialog = page.locator('#project-assets-filter-dialog');
  const form = page.locator('#project-assets-defaults-form');
  const region = page.locator('[data-project-assets-live-region]');
  const settledRegion = () => expect(region).not.toHaveAttribute('aria-busy', 'true');
  const snapshots = () => form.locator('[data-project-assets-default-values]').evaluate((el) => JSON.parse(el.textContent));
  const pick = async (id, label) => {
    if (await chooseHiddenPresentationField(page, id, label)) return settledRegion();
    const dropdown = dialog.locator(`#${id}`);
    await dropdown.locator('summary').click();
    await dropdown.locator('label').filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) }).click();
    // A multi-select stays open after a choice; close it from its summary.
    if (await dropdown.evaluate((node) => node.open)) await dropdown.locator('summary').click();
    await settledRegion();
  };
  const posts = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/assets/defaults')) posts.push(r.postData());
  });

  try {
    await page.goto(`${f.baseURL}/projects/${projectId}/assets?view=grid`);
    await page.getByRole('link', { name: 'Filters & Defaults', exact: true }).click();
    await expect(dialog).toBeVisible();

    // Temporary filters plus eligible values, all live; no defaults write.
    await pick('asset-category-filter', `Final \\(2\\)`);
    await dialog.locator('#search').fill('scope');
    await expect(page).toHaveURL(/search=scope/);
    await settledRegion();
    await pick('asset-presence-filter', 'Present at last scan');
    await pick('asset-usage-filter', 'Not used by a release');
    await pick('asset-sort-filter', 'File size');
    await pick('asset-extension-filter', '.png');
    await pick('page-size-dropdown', '10');
    expect(posts).toEqual([]);
    const contextUrl = new URL(page.url());
    for (const [key, value] of [['category', String(f.finalCategoryIds[0])], ['search', 'scope'],
      ['presence', 'present'], ['usage', 'unused'], ['sort', 'size'], ['extension', 'png'], ['pageSize', '10']]) {
      expect(contextUrl.searchParams.getAll(key)).toEqual([value]);
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await region.locator('.asset-selection-control').first().click();
    await expect(page.locator('[data-selected-count]')).toHaveText(/^1 of /);

    // Keyboard Save: exactly the eligible values; temporary ones are not sent.
    await page.getByRole('link', { name: 'Filters & Defaults', exact: true }).click();
    const saved = page.waitForResponse((r) => r.request().method() === 'POST'
      && new URL(r.url()).pathname.endsWith('/assets/defaults'));
    await dialog.getByRole('button', { name: 'Save new defaults', exact: true }).focus();
    await page.keyboard.press('Enter');
    expect((await saved).status()).toBe(302);
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'saved');
    await settledRegion();
    const body = new URLSearchParams(posts.at(-1));
    expect(body.get('intent')).toBe('save');
    expect(body.get('scope')).toBe('global');
    for (const [key, value] of [['sort', 'size'], ['pageSize', '10'], ['view', 'grid']]) expect(body.get(key)).toBe(value);
    expect(body.getAll('extension')).toEqual(['png']);
    for (const key of ['category', 'search', 'presence', 'usage']) expect(body.has(key)).toBe(false);
    expect((await snapshots()).global).toMatchObject({ sort: 'size', pageSize: '10', extension: ['png'] });

    // The current context survives the Save, with the selection.
    const afterSave = new URL(page.url());
    for (const key of ['category', 'search', 'presence', 'usage', 'sort', 'pageSize']) {
      expect(afterSave.searchParams.get(key)).toBe(contextUrl.searchParams.get(key));
    }
    await expect(dialog.locator('#search')).toHaveValue('scope');
    await expect(page.locator('[data-selected-count]')).toHaveText(/^1 of /);
    await expect(dialog.locator('[data-project-assets-defaults-indicator]')).toContainText('Global defaults saved');

    // A newer edit made while a Save is pending is not overwritten.
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const hold = async (route) => {
      if (route.request().method() === 'POST') await held;
      await route.continue();
    };
    const pattern = `**/projects/${projectId}/assets/defaults`;
    await page.route(pattern, hold);
    const pending = page.waitForResponse((r) => r.request().method() === 'POST'
      && new URL(r.url()).pathname.endsWith('/assets/defaults'));
    await pick('asset-sort-filter', 'Modified date');
    await dialog.getByRole('button', { name: 'Save new defaults', exact: true }).click();
    await pick('asset-order-filter', 'Descending');
    release();
    await pending;
    await page.unroute(pattern, hold);
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'saved');
    await settledRegion();
    expect(new URL(page.url()).searchParams.get('order')).toBe('desc');
    await expect(dialog.locator('#asset-order-filter summary')).toHaveAttribute('aria-label', /Descending$/);
    expect((await snapshots()).global).toMatchObject({ sort: 'modified', order: 'asc' });

    // A failed Save keeps the user's values and says so; nothing is retried.
    const failPattern = `**/projects/${projectId}/assets/defaults`;
    const fail = (route) => (route.request().method() === 'POST'
      ? route.fulfill({ status: 500, body: 'failed' }) : route.continue());
    await page.route(failPattern, fail);
    const postsBefore = posts.length;
    await dialog.getByRole('button', { name: 'Save new defaults', exact: true }).click();
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'error');
    await page.unroute(failPattern, fail);
    expect(posts.length - postsBefore).toBe(1);
    await expect(dialog.locator('#asset-order-filter summary')).toHaveAttribute('aria-label', /Descending$/);
    expect((await snapshots()).global.order).toBe('asc');
    expect(pageErrors).toEqual([]);
  } finally {
    await f.close();
  }
});

// Milestone 2 Correction A.
// F2: Grid style is a current setting: choosing it restyles the grid at once,
// by mouse or keyboard, writes nothing, survives region reloads, reopening and
// a failed Save, and is persisted only by Save new defaults.
// F1: an acknowledged Save or scope activation brings the browser's Grid/List
// sizes (stored and shown) in line with the saved ones; drafts, failures and
// Reset defaults leave them alone, and the manual size control still works.
test('Grid style applies live and acknowledged defaults synchronize browser sizes', async ({ page }) => {
  test.skip(Boolean(process.env.CREATORCRATE_BROWSER_BASE_URL), 'Requires the isolated fixture.');
  const f = await fixture();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const [projectId] = f.ids;
  const dialog = page.locator('#project-assets-filter-dialog');
  const form = page.locator('#project-assets-defaults-form');
  const region = page.locator('[data-project-assets-live-region]');
  const grid = region.locator('.asset-grid');
  const styleSelect = page.locator('#projectAssets-default-gridStyle');
  const styleDropdown = dialog.locator('#projectAssets-default-gridStyle-dropdown');
  const settledRegion = () => expect(region).not.toHaveAttribute('aria-busy', 'true');
  const snapshots = () => form.locator('[data-project-assets-default-values]').evaluate((el) => JSON.parse(el.textContent));
  const stored = () => page.evaluate(() => [
    localStorage.getItem('creatorcrate-asset-grid-size'),
    localStorage.getItem('creatorcrate-asset-list-size'),
  ]);
  const pick = async (id, label) => {
    if (await chooseHiddenPresentationField(page, id, label)) return settledRegion();
    const dropdown = dialog.locator(`#${id}`);
    await dropdown.locator('summary').click();
    await dropdown.locator('label').filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) }).click();
    await settledRegion();
  };
  const openDialog = async () => {
    await page.getByRole('link', { name: 'Filters & Defaults', exact: true }).click();
    await expect(dialog).toBeVisible();
  };
  const closeDialog = async () => {
    await page.keyboard.press('Escape');
    if (await dialog.isVisible()) await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  };
  const sizeLabel = (size) => page.locator(`[data-asset-grid-size-controls] [data-grid-size-option-label="${size}"]`);
  const save = dialog.getByRole('button', { name: 'Save new defaults', exact: true });
  const defaultsPattern = `**/projects/${projectId}/assets/defaults`;
  const posts = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname.includes('/assets/defaults')) posts.push(r.postData());
  });

  try {
    await page.goto(`${f.baseURL}/projects/${projectId}/assets?view=grid`);
    await expect(grid).toHaveAttribute('data-grid-style', 'uncropped');
    // The browser prefers Large; the manual control stores and shows it.
    await sizeLabel('large').click();
    await page.evaluate(() => localStorage.setItem('creatorcrate-asset-list-size', 'large'));
    await expect(grid).toHaveAttribute('data-grid-size', 'large');
    expect(await stored()).toEqual(['large', 'large']);

    // F2: mouse, Uncropped -> Cropped, at once and without a defaults write.
    await openDialog();
    await pick('projectAssets-default-gridStyle-dropdown', 'Cropped');
    await expect(grid).toHaveAttribute('data-grid-style', 'cropped');
    await expect(styleSelect).toHaveValue('cropped');
    // Keyboard, Cropped -> Uncropped -> Cropped, through the dropdown's radios.
    const keyboardChoose = async (key) => {
      if (!(await styleDropdown.evaluate((node) => node.open))) {
        await styleDropdown.locator('summary').focus();
        await page.keyboard.press('Enter');
        await expect(styleDropdown).toHaveAttribute('open', '');
      }
      await styleDropdown.locator('input[type="radio"]:checked').focus();
      await page.keyboard.press(key);
    };
    await keyboardChoose('ArrowUp');
    await expect(styleSelect).toHaveValue('uncropped');
    await expect(grid).toHaveAttribute('data-grid-style', 'uncropped');
    await keyboardChoose('ArrowDown');
    await expect(styleSelect).toHaveValue('cropped');
    await expect(grid).toHaveAttribute('data-grid-style', 'cropped');
    if (await styleDropdown.evaluate((node) => node.open)) await styleDropdown.locator('summary').click();
    expect(posts).toEqual([]);
    expect((await snapshots()).global.gridStyle).toBe('uncropped');

    // A live-region replacement renders the saved style; the current one stays.
    await pick('asset-sort-filter', 'File size');
    await expect(page).toHaveURL(/sort=size/);
    await expect(grid).toHaveAttribute('data-grid-style', 'cropped');

    // Reopening shows the active style in the control and the dropdown.
    await closeDialog();
    await expect(grid).toHaveAttribute('data-grid-style', 'cropped');
    await openDialog();
    await expect(styleSelect).toHaveValue('cropped');
    await expect(styleDropdown.locator('summary')).toHaveAttribute('aria-label', /Cropped$/);

    // User acceptance: the size defaults preview at once, but nothing is
    // stored or sent until Save.
    await pick('projectAssets-default-gridSize-dropdown', 'Compact');
    await pick('projectAssets-default-listSize-dropdown', 'Compact');
    expect(posts).toEqual([]);
    expect(await stored()).toEqual(['large', 'large']);
    await expect(grid).toHaveAttribute('data-grid-size', 'compact');

    // A failed Save keeps the live style and writes no browser preference.
    const fail = (route) => (route.request().method() === 'POST'
      ? route.fulfill({ status: 500, body: 'failed' }) : route.continue());
    await page.route(defaultsPattern, fail);
    await save.click();
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'error');
    await page.unroute(defaultsPattern, fail);
    expect(posts).toHaveLength(1);
    await expect(grid).toHaveAttribute('data-grid-style', 'cropped');
    await expect(styleSelect).toHaveValue('cropped');
    expect(await stored()).toEqual(['large', 'large']);
    // The failed Save leaves the live preview in place.
    await expect(grid).toHaveAttribute('data-grid-size', 'compact');

    // A pending Save writes nothing; its acknowledgement persists the style
    // and synchronizes both sizes, stored and shown.
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const hold = async (route) => {
      if (route.request().method() === 'POST') await held;
      await route.continue();
    };
    await page.route(defaultsPattern, hold);
    const acknowledged = page.waitForResponse((r) => r.request().method() === 'POST'
      && new URL(r.url()).pathname.endsWith('/assets/defaults'));
    await save.click();
    await expect(form).toHaveAttribute('aria-busy', 'true');
    expect(await stored()).toEqual(['large', 'large']);
    release();
    expect((await acknowledged).status()).toBe(302);
    await page.unroute(defaultsPattern, hold);
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'saved');
    await settledRegion();
    const savedBody = new URLSearchParams(posts.at(-1));
    expect(savedBody.get('intent')).toBe('save');
    expect(savedBody.get('gridStyle')).toBe('cropped');
    expect((await snapshots()).global).toMatchObject({ gridStyle: 'cropped', gridSize: 'compact', listSize: 'compact' });
    expect(await stored()).toEqual(['compact', 'compact']);
    await expect(grid).toHaveAttribute('data-grid-size', 'compact');
    await expect(grid).toHaveAttribute('data-grid-style', 'cropped');

    // Initial page load: the saved style, and the stored browser sizes.
    await page.reload();
    await expect(grid).toHaveAttribute('data-grid-style', 'cropped');
    await expect(grid).toHaveAttribute('data-grid-size', 'compact');

    // The manual size control still works and still beats the saved fallback.
    await sizeLabel('large').click();
    await expect(grid).toHaveAttribute('data-grid-size', 'large');
    expect(await stored()).toEqual(['large', 'compact']);
    await page.reload();
    await expect(grid).toHaveAttribute('data-grid-size', 'large');

    // An unsaved live style, then a failed activation: nothing changes.
    await openDialog();
    await pick('projectAssets-default-gridStyle-dropdown', 'Uncropped');
    await expect(grid).toHaveAttribute('data-grid-style', 'uncropped');
    await page.route(defaultsPattern, fail);
    await dialog.getByText('Project only', { exact: true }).click();
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'error');
    await page.unroute(defaultsPattern, fail);
    await expect(form.locator('input[name="loadedScope"]')).toHaveValue('global');
    expect(await stored()).toEqual(['large', 'compact']);
    await expect(grid).toHaveAttribute('data-grid-style', 'uncropped');

    // An acknowledged activation loads that scope's saved style and sizes
    // (Project-only inherits Global here), in the control, the grid and storage.
    const activated = page.waitForResponse((r) => r.request().method() === 'POST'
      && new URL(r.url()).pathname.endsWith('/assets/defaults'));
    await dialog.getByText('Project only', { exact: true }).click();
    expect((await activated).status()).toBe(200);
    await expect(form.locator('input[name="loadedScope"]')).toHaveValue('project');
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'saved');
    await settledRegion();
    expect(new URLSearchParams(posts.at(-1)).get('intent')).toBe('activate-scope');
    await expect(styleSelect).toHaveValue('cropped');
    await expect(grid).toHaveAttribute('data-grid-style', 'cropped');
    expect(await stored()).toEqual(['compact', 'compact']);
    await expect(grid).toHaveAttribute('data-grid-size', 'compact');

    // Reset defaults removes saved values only; browser sizes are kept.
    await page.evaluate(() => localStorage.setItem('creatorcrate-asset-list-size', 'large'));
    await dialog.locator('[data-project-assets-defaults-reset]').click();
    const confirm = page.locator('dialog[open]').filter({ hasText: 'Reset Project-only defaults' });
    await confirm.getByRole('button', { name: 'Reset defaults', exact: true }).click();
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'saved');
    expect(posts.at(-1)).toContain('scope=project');
    expect(await stored()).toEqual(['compact', 'large']);
    await expect(grid).toHaveAttribute('data-grid-size', 'compact');
    await expect(grid).toHaveAttribute('data-grid-style', 'cropped');
    expect(pageErrors).toEqual([]);
  } finally {
    await f.close();
  }
});

// User acceptance correction: Grid size default and List size default preview
// the presentation live, without a defaults write or a stored browser size.
test('Grid and List size defaults preview live and survive region replacement, Save and Reset', async ({ page }) => {
  test.skip(Boolean(process.env.CREATORCRATE_BROWSER_BASE_URL), 'Requires the isolated fixture.');
  test.setTimeout(120_000);
  const f = await fixture();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const [projectId] = f.ids;
  const dialog = page.locator('#project-assets-filter-dialog');
  const form = page.locator('#project-assets-defaults-form');
  const region = page.locator('[data-project-assets-live-region]');
  const grid = region.locator('.asset-grid');
  const list = region.locator('.asset-list');
  const gridSizeSelect = page.locator('#projectAssets-default-gridSize');
  const listSizeSelect = page.locator('#projectAssets-default-listSize');
  const settledRegion = () => expect(region).not.toHaveAttribute('aria-busy', 'true');
  const snapshots = () => form.locator('[data-project-assets-default-values]').evaluate((el) => JSON.parse(el.textContent));
  const stored = () => page.evaluate(() => [
    localStorage.getItem('creatorcrate-asset-grid-size'),
    localStorage.getItem('creatorcrate-asset-list-size'),
  ]);
  const choose = async (id, label) => {
    if (await chooseHiddenPresentationField(page, id, label)) return;
    const dropdown = dialog.locator(`#${id}`);
    await dropdown.locator('summary').click();
    await dropdown.locator('label').filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) }).click();
  };
  const pick = async (id, label) => {
    await choose(id, label);
    await settledRegion();
  };
  const openDialog = async () => {
    await page.getByRole('link', { name: 'Filters & Defaults', exact: true }).click();
    await expect(dialog).toBeVisible();
  };
  const closeDialog = async () => {
    await page.keyboard.press('Escape');
    if (await dialog.isVisible()) await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  };
  const gridSizeAttribute = () => grid.getAttribute('data-grid-size');
  const cardMin = () => grid.evaluate((el) => getComputedStyle(el).getPropertyValue('--asset-card-min').trim());
  const gridSizeLabel = (size) => page.locator(`[data-asset-grid-size-controls] [data-grid-size-option-label="${size}"]`);
  const save = dialog.getByRole('button', { name: 'Save new defaults', exact: true });
  const defaultsPattern = `**/projects/${projectId}/assets/defaults`;
  const posts = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname.includes('/assets/defaults')) posts.push(r.postData());
  });

  try {
    await page.goto(`${f.baseURL}/projects/${projectId}/assets?view=grid`);
    // The browser prefers a Large grid; no List size is stored.
    await gridSizeLabel('large').click();
    await expect(grid).toHaveAttribute('data-grid-size', 'large');
    expect(await stored()).toEqual(['large', null]);

    // A: the dialog opens on the sizes in use; a Grid size choice applies at once.
    await openDialog();
    await expect(gridSizeSelect).toHaveValue('large');
    await expect(listSizeSelect).toHaveValue('large');
    await pick('projectAssets-default-gridSize-dropdown', 'Compact');
    await expect(grid).toHaveAttribute('data-grid-size', 'compact');
    expect(await cardMin()).toBe('12rem');
    await expect(gridSizeLabel('compact')).toHaveAttribute('aria-pressed', 'true');
    // B: List is not shown, so its choice is held for when it renders.
    await pick('projectAssets-default-listSize-dropdown', 'Compact');
    expect(posts).toEqual([]);
    expect(await stored()).toEqual(['large', null]);
    expect((await snapshots()).global).toMatchObject({ gridSize: 'default', listSize: 'large' });

    // D: a live filter response already in flight cannot revert a newer choice.
    let releaseGet;
    const heldGet = new Promise((resolve) => { releaseGet = resolve; });
    const holdGet = async (route) => {
      const request = route.request();
      if (request.method() === 'GET' && request.resourceType() === 'fetch') await heldGet;
      await route.continue();
    };
    await page.route(`**/projects/${projectId}/assets?*`, holdGet);
    await choose('asset-sort-filter', 'File size');
    await expect(region).toHaveAttribute('aria-busy', 'true');
    await choose('projectAssets-default-gridSize-dropdown', 'Default');
    await expect.poll(gridSizeAttribute).toBeNull();
    releaseGet();
    await settledRegion();
    await page.unroute(`**/projects/${projectId}/assets?*`, holdGet);
    await expect(page).toHaveURL(/sort=size/);
    await expect.poll(gridSizeAttribute).toBeNull();
    expect(await cardMin()).toBe('15rem');

    // B: switching to List shows the held List size; switching back keeps Grid's.
    await pick('asset-view-filter-dropdown', 'List');
    await expect(list).toHaveAttribute('data-list-size', 'compact');
    await expect(page.locator('[data-asset-list-size-controls] [data-grid-size-option-label="compact"]'))
      .toHaveAttribute('aria-pressed', 'true');
    await pick('projectAssets-default-listSize-dropdown', 'Large');
    await expect(list).toHaveAttribute('data-list-size', 'large');
    await pick('projectAssets-default-listSize-dropdown', 'Compact');
    await expect(list).toHaveAttribute('data-list-size', 'compact');
    await pick('asset-view-filter-dropdown', 'Grid');
    await expect.poll(gridSizeAttribute).toBeNull();
    expect(posts).toEqual([]);
    expect(await stored()).toEqual(['large', null]);

    // D: reopening shows the sizes in use.
    await closeDialog();
    expect(await gridSizeAttribute()).toBeNull();
    await openDialog();
    await expect(gridSizeSelect).toHaveValue('default');
    await expect(listSizeSelect).toHaveValue('compact');

    // D: a failed Save keeps the preview and stores nothing.
    const fail = (route) => (route.request().method() === 'POST'
      ? route.fulfill({ status: 500, body: 'failed' }) : route.continue());
    await page.route(defaultsPattern, fail);
    await save.click();
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'error');
    await page.unroute(defaultsPattern, fail);
    expect(posts).toHaveLength(1);
    expect(await gridSizeAttribute()).toBeNull();
    await expect(gridSizeSelect).toHaveValue('default');
    expect(await stored()).toEqual(['large', null]);

    // C: Save persists both sizes once, synchronizes the browser sizes and
    // keeps the current sort and presentation.
    const savedResponse = page.waitForResponse((r) => r.request().method() === 'POST'
      && new URL(r.url()).pathname.endsWith('/assets/defaults'));
    await save.click();
    expect((await savedResponse).status()).toBeLessThan(400);
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'saved');
    await settledRegion();
    expect(posts).toHaveLength(2);
    const savedBody = new URLSearchParams(posts.at(-1));
    expect(savedBody.get('intent')).toBe('save');
    expect([savedBody.get('gridSize'), savedBody.get('listSize')]).toEqual(['default', 'compact']);
    expect((await snapshots()).global).toMatchObject({ gridSize: 'default', listSize: 'compact', sort: 'size' });
    expect(await stored()).toEqual(['default', 'compact']);
    expect(await gridSizeAttribute()).toBeNull();
    await expect(page).toHaveURL(/sort=size/);

    // The page's own size control is a newer choice than a preview, and a
    // later region install keeps it.
    await pick('projectAssets-default-gridSize-dropdown', 'Compact');
    await expect(grid).toHaveAttribute('data-grid-size', 'compact');
    await closeDialog();
    await gridSizeLabel('large').click();
    await expect(grid).toHaveAttribute('data-grid-size', 'large');
    expect(await stored()).toEqual(['large', 'compact']);
    await openDialog();
    await expect(gridSizeSelect).toHaveValue('large');
    await pick('asset-sort-filter', 'Filename');
    await expect(page).toHaveURL(/sort=filename/);
    await expect(grid).toHaveAttribute('data-grid-size', 'large');

    // D: Reset defaults keeps the sizes in use and stores nothing.
    await pick('projectAssets-default-gridSize-dropdown', 'Compact');
    const postsBeforeReset = posts.length;
    await dialog.locator('[data-project-assets-defaults-reset]').click();
    const confirm = page.locator('dialog[open]').filter({ hasText: 'Reset Global defaults' });
    await confirm.getByRole('button', { name: 'Reset defaults', exact: true }).click();
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'saved');
    await settledRegion();
    expect(posts).toHaveLength(postsBeforeReset + 1);
    await expect(grid).toHaveAttribute('data-grid-size', 'compact');
    expect(await stored()).toEqual(['large', 'compact']);

    // A reload ends the preview: the stored browser sizes decide again.
    await page.reload();
    await expect(grid).toHaveAttribute('data-grid-size', 'large');
    expect(pageErrors).toEqual([]);
  } finally {
    await f.close();
  }
});

// Milestone 2 Correction F (F8): an activation acknowledged after a newer edit
// keeps that edit, and the untouched size fields follow the activated scope's
// sizes in use, so the next Save cannot write stale pre-activation sizes.
test('a held scope activation with a newer edit synchronizes the untouched size fields', async ({ page }) => {
  test.skip(Boolean(process.env.CREATORCRATE_BROWSER_BASE_URL), 'Requires the isolated fixture.');
  test.setTimeout(120_000);
  const f = await fixture();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const [projectId] = f.ids;
  const dialog = page.locator('#project-assets-filter-dialog');
  const form = page.locator('#project-assets-defaults-form');
  const loadedScope = form.locator('input[name="loadedScope"]');
  const region = page.locator('[data-project-assets-live-region]');
  const grid = region.locator('.asset-grid');
  const list = region.locator('.asset-list');
  const gridSizeSelect = page.locator('#projectAssets-default-gridSize');
  const listSizeSelect = page.locator('#projectAssets-default-listSize');
  const gridSizeSummary = dialog.locator('#projectAssets-default-gridSize-dropdown summary');
  const listSizeSummary = dialog.locator('#projectAssets-default-listSize-dropdown summary');
  const settledRegion = () => expect(region).not.toHaveAttribute('aria-busy', 'true');
  const snapshots = () => form.locator('[data-project-assets-default-values]').evaluate((el) => JSON.parse(el.textContent));
  const stored = () => page.evaluate(() => [
    localStorage.getItem('creatorcrate-asset-grid-size'),
    localStorage.getItem('creatorcrate-asset-list-size'),
  ]);
  const choose = async (id, label) => {
    if (await chooseHiddenPresentationField(page, id, label)) return;
    const dropdown = dialog.locator(`#${id}`);
    await dropdown.locator('summary').click();
    await dropdown.locator('label').filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) }).click();
  };
  const pick = async (id, label) => {
    await choose(id, label);
    await settledRegion();
  };
  const openDialog = async () => {
    await page.getByRole('link', { name: 'Filters & Defaults', exact: true }).click();
    await expect(dialog).toBeVisible();
  };
  const closeDialog = async () => {
    await page.keyboard.press('Escape');
    if (await dialog.isVisible()) await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  };
  const save = dialog.getByRole('button', { name: 'Save new defaults', exact: true });
  const defaultsPattern = `**/projects/${projectId}/assets/defaults`;
  const posts = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname.includes('/assets/defaults')) posts.push(r.postData());
  });
  const saveAndSettle = async () => {
    const response = page.waitForResponse((r) => r.request().method() === 'POST'
      && new URL(r.url()).pathname.endsWith('/assets/defaults'));
    await save.click();
    expect((await response).status()).toBeLessThan(400);
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'saved');
    await settledRegion();
    return new URLSearchParams(posts.at(-1));
  };
  const activate = async (label, scope) => {
    const response = page.waitForResponse((r) => r.request().method() === 'POST'
      && new URL(r.url()).pathname.endsWith('/assets/defaults'));
    await dialog.getByText(label, { exact: true }).click();
    expect((await response).status()).toBe(200);
    await expect(loadedScope).toHaveValue(scope);
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'saved');
    await settledRegion();
  };
  // Holds the next activation POST until released; reads stay untouched.
  const holdActivation = async () => {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const hold = async (route) => {
      if (route.request().method() === 'POST') await held;
      await route.continue();
    };
    await page.route(defaultsPattern, hold);
    const response = page.waitForResponse((r) => r.request().method() === 'POST'
      && new URL(r.url()).pathname.endsWith('/assets/defaults'));
    return {
      release: async () => {
        release();
        expect((await response).status()).toBe(200);
        await page.unroute(defaultsPattern, hold);
      },
    };
  };

  try {
    // Saved defaults: Global Large/Large, Project only Compact/Compact.
    await page.goto(`${f.baseURL}/projects/${projectId}/assets?view=grid`);
    await openDialog();
    await pick('projectAssets-default-gridSize-dropdown', 'Large');
    await pick('projectAssets-default-listSize-dropdown', 'Large');
    await saveAndSettle();
    await activate('Project only', 'project');
    await pick('projectAssets-default-gridSize-dropdown', 'Compact');
    await pick('projectAssets-default-listSize-dropdown', 'Compact');
    await saveAndSettle();
    await activate('Global', 'global');
    await expect(gridSizeSelect).toHaveValue('large');
    await expect(listSizeSelect).toHaveValue('large');
    await expect(grid).toHaveAttribute('data-grid-size', 'large');
    expect(await stored()).toEqual(['large', 'large']);
    const saved = await snapshots();
    expect(saved.global).toMatchObject({ gridSize: 'large', listSize: 'large', sort: 'filename' });
    expect(saved.project).toMatchObject({ gridSize: 'compact', listSize: 'compact' });

    // A: the reviewer's reproduction. Sort changes while Project only is held.
    let held = await holdActivation();
    await dialog.getByText('Project only', { exact: true }).click();
    await choose('asset-sort-filter', 'Modified date');
    await expect(page).toHaveURL(/sort=modified/);
    await settledRegion();
    const postsBeforeRelease = posts.length;
    await held.release();
    await expect(loadedScope).toHaveValue('project');
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'saved');
    await expect(form.locator('[data-dialog-status]')).toHaveText(/newer changes were kept/);
    await settledRegion();
    // The presentation, the browser sizes, the fields and the dropdowns agree.
    await expect(grid).toHaveAttribute('data-grid-size', 'compact');
    expect(await stored()).toEqual(['compact', 'compact']);
    await expect(gridSizeSelect).toHaveValue('compact');
    await expect(listSizeSelect).toHaveValue('compact');
    await expect(gridSizeSummary).toHaveAttribute('aria-label', /Compact$/);
    await expect(listSizeSummary).toHaveAttribute('aria-label', /Compact$/);
    // The newer Sort stands, and synchronizing wrote nothing.
    await expect(page).toHaveURL(/sort=modified/);
    expect(posts).toHaveLength(postsBeforeRelease);
    // The next Save sends the sizes in use, never the stale Large/Large.
    let body = await saveAndSettle();
    expect(body.get('intent')).toBe('save');
    expect(body.get('scope')).toBe('project');
    expect([body.get('gridSize'), body.get('listSize'), body.get('sort')]).toEqual(['compact', 'compact', 'modified']);
    expect((await snapshots()).project).toMatchObject({ gridSize: 'compact', listSize: 'compact', sort: 'modified' });
    expect((await snapshots()).global).toMatchObject({ gridSize: 'large', listSize: 'large', sort: 'filename' });
    await expect(grid).toHaveAttribute('data-grid-size', 'compact');

    // B: a newer Grid size preview made while Global is held survives; the
    // untouched List size follows Global.
    held = await holdActivation();
    await dialog.getByText('Global', { exact: true }).click();
    await choose('projectAssets-default-gridSize-dropdown', 'Default');
    await expect.poll(() => grid.getAttribute('data-grid-size')).toBeNull();
    await held.release();
    await expect(loadedScope).toHaveValue('global');
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'saved');
    await settledRegion();
    await expect.poll(() => grid.getAttribute('data-grid-size')).toBeNull();
    await expect(gridSizeSelect).toHaveValue('default');
    await expect(listSizeSelect).toHaveValue('large');
    await expect(gridSizeSummary).toHaveAttribute('aria-label', /Default$/);
    await expect(listSizeSummary).toHaveAttribute('aria-label', /Large$/);
    expect(await stored()).toEqual(['large', 'large']);
    // E: a live-region replacement keeps the fields and the preview.
    await pick('asset-view-filter-dropdown', 'List');
    await expect(list).toHaveAttribute('data-list-size', 'large');
    await expect(gridSizeSelect).toHaveValue('default');
    await expect(listSizeSelect).toHaveValue('large');

    // B: a newer List size preview made while Project only is held survives;
    // the untouched Grid size follows Project only.
    await pick('projectAssets-default-listSize-dropdown', 'Compact');
    await expect(list).toHaveAttribute('data-list-size', 'compact');
    held = await holdActivation();
    await dialog.getByText('Project only', { exact: true }).click();
    await choose('projectAssets-default-listSize-dropdown', 'Large');
    await expect(list).toHaveAttribute('data-list-size', 'large');
    await held.release();
    await expect(loadedScope).toHaveValue('project');
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'saved');
    await settledRegion();
    await expect(list).toHaveAttribute('data-list-size', 'large');
    await expect(gridSizeSelect).toHaveValue('compact');
    await expect(listSizeSelect).toHaveValue('large');
    await expect(gridSizeSummary).toHaveAttribute('aria-label', /Compact$/);
    await expect(listSizeSummary).toHaveAttribute('aria-label', /Large$/);
    expect(await stored()).toEqual(['compact', 'compact']);

    // D: a failed activation applies nothing and keeps the preview.
    const fail = (route) => (route.request().method() === 'POST'
      ? route.fulfill({ status: 400, contentType: 'application/json', body: '{"status":"error"}' })
      : route.continue());
    await page.route(defaultsPattern, fail);
    const postsBeforeFailure = posts.length;
    await dialog.getByText('Global', { exact: true }).click();
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'error');
    await page.unroute(defaultsPattern, fail);
    expect(posts).toHaveLength(postsBeforeFailure + 1);
    await expect(loadedScope).toHaveValue('project');
    await expect(gridSizeSelect).toHaveValue('compact');
    await expect(listSizeSelect).toHaveValue('large');
    await expect(list).toHaveAttribute('data-list-size', 'large');
    expect(await stored()).toEqual(['compact', 'compact']);
    expect((await snapshots()).project).toMatchObject({ gridSize: 'compact', listSize: 'compact' });

    // E: reopening shows the sizes in use, and Save persists exactly them.
    await closeDialog();
    await openDialog();
    await expect(gridSizeSelect).toHaveValue('compact');
    await expect(listSizeSelect).toHaveValue('large');
    body = await saveAndSettle();
    expect([body.get('scope'), body.get('gridSize'), body.get('listSize')]).toEqual(['project', 'compact', 'large']);
    expect((await snapshots()).project).toMatchObject({ gridSize: 'compact', listSize: 'large' });
    expect(await stored()).toEqual(['compact', 'large']);

    // C: an ordinary activation (no newer edit) loads each scope's saved sizes.
    await activate('Global', 'global');
    await expect(gridSizeSelect).toHaveValue('large');
    await expect(listSizeSelect).toHaveValue('large');
    // Global's saved view is Grid, so the loaded presentation is its grid.
    await expect(grid).toHaveAttribute('data-grid-size', 'large');
    expect(await stored()).toEqual(['large', 'large']);
    await activate('Project only', 'project');
    await expect(gridSizeSelect).toHaveValue('compact');
    await expect(listSizeSelect).toHaveValue('large');
    // Project only was last saved in List view, so the loaded list shows.
    await expect(list).toHaveAttribute('data-list-size', 'large');
    expect(await stored()).toEqual(['compact', 'large']);
    // Switching never saved values.
    expect(new URLSearchParams(posts.at(-1)).get('intent')).toBe('activate-scope');
    expect((await snapshots()).global).toMatchObject({ gridSize: 'large', listSize: 'large' });
    expect(pageErrors).toEqual([]);
  } finally {
    await f.close();
  }
});

// Milestone 2 Correction G (F9): an activation committed by the server whose
// response is unreadable and whose automatic recovery read fails is checked
// again with a GET only; size edits made while it was unresolved survive.
test('a GET-only check after a failed recovery read keeps size edits made during the activation', async ({ page }) => {
  test.skip(Boolean(process.env.CREATORCRATE_BROWSER_BASE_URL), 'Requires the isolated fixture.');
  test.setTimeout(120_000);
  const f = await fixture();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const [projectId] = f.ids;
  const dialog = page.locator('#project-assets-filter-dialog');
  const form = page.locator('#project-assets-defaults-form');
  const loadedScope = form.locator('input[name="loadedScope"]');
  const region = page.locator('[data-project-assets-live-region]');
  const grid = region.locator('.asset-grid');
  const list = region.locator('.asset-list');
  const gridSizeSelect = page.locator('#projectAssets-default-gridSize');
  const listSizeSelect = page.locator('#projectAssets-default-listSize');
  const gridSizeSummary = dialog.locator('#projectAssets-default-gridSize-dropdown summary');
  const listSizeSummary = dialog.locator('#projectAssets-default-listSize-dropdown summary');
  const settledRegion = () => expect(region).not.toHaveAttribute('aria-busy', 'true');
  const snapshots = () => form.locator('[data-project-assets-default-values]').evaluate((el) => JSON.parse(el.textContent));
  const choose = async (id, label) => {
    if (await chooseHiddenPresentationField(page, id, label)) return;
    const dropdown = dialog.locator(`#${id}`);
    await dropdown.locator('summary').click();
    await dropdown.locator('label').filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) }).click();
  };
  const pick = async (id, label) => {
    await choose(id, label);
    await settledRegion();
  };
  const save = dialog.getByRole('button', { name: 'Save new defaults', exact: true });
  const defaultsPattern = `**/projects/${projectId}/assets/defaults`;
  const posts = [];
  const requests = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname.includes('/assets/defaults')) posts.push(r.postData());
    requests.push({ method: r.method(), url: r.url() });
  });
  const saveAndSettle = async () => {
    const response = page.waitForResponse((r) => r.request().method() === 'POST'
      && new URL(r.url()).pathname.endsWith('/assets/defaults'));
    await save.click();
    expect((await response).status()).toBeLessThan(400);
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'saved');
    await settledRegion();
    return new URLSearchParams(posts.at(-1));
  };
  const activate = async (label, scope) => {
    const response = page.waitForResponse((r) => r.request().method() === 'POST'
      && new URL(r.url()).pathname.endsWith('/assets/defaults'));
    await dialog.getByText(label, { exact: true }).click();
    expect((await response).status()).toBe(200);
    await expect(loadedScope).toHaveValue(scope);
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'saved');
    await settledRegion();
  };

  try {
    // Saved defaults: Global Large/Large, Project only Compact/Compact.
    await page.goto(`${f.baseURL}/projects/${projectId}/assets?view=grid`);
    await page.getByRole('link', { name: 'Filters & Defaults', exact: true }).click();
    await expect(dialog).toBeVisible();
    await pick('projectAssets-default-gridSize-dropdown', 'Large');
    await pick('projectAssets-default-listSize-dropdown', 'Large');
    await saveAndSettle();
    await activate('Project only', 'project');
    await pick('projectAssets-default-gridSize-dropdown', 'Compact');
    await pick('projectAssets-default-listSize-dropdown', 'Compact');
    await saveAndSettle();
    await activate('Global', 'global');
    await expect(gridSizeSelect).toHaveValue('large');
    await expect(listSizeSelect).toHaveValue('large');
    await expect(grid).toHaveAttribute('data-grid-size', 'large');

    // The server commits Project only; its response is held, then unreadable.
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const unreadablePost = async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const committed = await route.fetch();
      expect(committed.status()).toBe(200);
      await held;
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"succ' });
    };
    await page.route(defaultsPattern, unreadablePost);
    const returnTo = new URL(await form.locator('input[name="returnTo"]').inputValue(), f.baseURL).href;
    let failNextRecoveryRead = false;
    const failRecovery = (route) => {
      if (failNextRecoveryRead && route.request().method() === 'GET') {
        failNextRecoveryRead = false;
        return route.abort('failed');
      }
      return route.continue();
    };
    await page.route((url) => url.href === returnTo, failRecovery);

    const postsBeforeActivation = posts.length;
    await dialog.getByText('Project only', { exact: true }).click();
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'pending');
    // Newer size choices while the activation is unresolved.
    await choose('projectAssets-default-gridSize-dropdown', 'Default');
    await expect.poll(() => grid.getAttribute('data-grid-size')).toBeNull();
    await choose('projectAssets-default-listSize-dropdown', 'Large');
    failNextRecoveryRead = true;
    const requestsBeforeRelease = requests.length;
    release();
    await expect(form.locator('[data-dialog-status]')).toHaveText(/Could not confirm whether the defaults scope changed/);
    await page.unroute(defaultsPattern, unreadablePost);
    expect(failNextRecoveryRead).toBe(false);
    await expect(loadedScope).toHaveValue('global');
    await expect(gridSizeSelect).toHaveValue('default');
    await expect(listSizeSelect).toHaveValue('large');
    await expect.poll(() => grid.getAttribute('data-grid-size')).toBeNull();
    expect(requests.slice(requestsBeforeRelease).filter((r) => r.url === returnTo && r.method === 'GET')).toHaveLength(1);

    // Following the instruction: choosing the scope again only reads.
    const requestsBeforeCheck = requests.length;
    const checked = page.waitForResponse((r) => r.request().method() === 'GET' && r.url() === returnTo);
    await dialog.getByText('Project only', { exact: true }).click();
    expect((await checked).status()).toBe(200);
    await expect(loadedScope).toHaveValue('project');
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'saved');
    await expect(form.locator('[data-dialog-status]')).toHaveText(/newer changes were kept/);
    await settledRegion();
    await page.unroute((url) => url.href === returnTo, failRecovery);
    const checkRequests = requests.slice(requestsBeforeCheck);
    expect(checkRequests.filter((r) => r.method === 'POST')).toEqual([]);
    expect(checkRequests.filter((r) => r.method === 'GET' && r.url === returnTo)).toHaveLength(1);
    expect(posts).toHaveLength(postsBeforeActivation + 1);
    expect(new URLSearchParams(posts.at(-1)).get('intent')).toBe('activate-scope');

    // The newer choices survive in the fields, dropdowns and presentation.
    await expect(gridSizeSelect).toHaveValue('default');
    await expect(listSizeSelect).toHaveValue('large');
    await expect(gridSizeSummary).toHaveAttribute('aria-label', /Default$/);
    await expect(listSizeSummary).toHaveAttribute('aria-label', /Large$/);
    await expect.poll(() => grid.getAttribute('data-grid-size')).toBeNull();
    expect((await snapshots()).project).toMatchObject({ gridSize: 'compact', listSize: 'compact' });

    // The next Save sends them, and only Project only takes them.
    const body = await saveAndSettle();
    expect(body.get('intent')).toBe('save');
    expect([body.get('scope'), body.get('gridSize'), body.get('listSize')]).toEqual(['project', 'default', 'large']);
    expect((await snapshots()).project).toMatchObject({ gridSize: 'default', listSize: 'large' });
    expect((await snapshots()).global).toMatchObject({ gridSize: 'large', listSize: 'large' });
    await expect.poll(() => grid.getAttribute('data-grid-size')).toBeNull();
    await pick('asset-view-filter-dropdown', 'List');
    await expect(list).toHaveAttribute('data-list-size', 'large');
    expect(pageErrors).toEqual([]);
  } finally {
    await f.close();
  }
});

// Milestone 2 Correction H (F10): Space on the checked Grid or List size
// option sends no click or change in Chromium. While a scope activation is
// unresolved it is still an explicit choice, so it survives the recovery read
// or GET-only check and the next Save sends it.
test('Space on the shown Grid or List size during an unresolved activation keeps that size', async ({ page }) => {
  test.skip(Boolean(process.env.CREATORCRATE_BROWSER_BASE_URL), 'Requires the isolated fixture.');
  test.setTimeout(150_000);
  const f = await fixture();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const [projectId] = f.ids;
  const dialog = page.locator('#project-assets-filter-dialog');
  const form = page.locator('#project-assets-defaults-form');
  const loadedScope = form.locator('input[name="loadedScope"]');
  const region = page.locator('[data-project-assets-live-region]');
  const grid = region.locator('.asset-grid');
  const list = region.locator('.asset-list');
  const gridSizeSelect = page.locator('#projectAssets-default-gridSize');
  const listSizeSelect = page.locator('#projectAssets-default-listSize');
  const gridSizeSummary = dialog.locator('#projectAssets-default-gridSize-dropdown summary');
  const listSizeSummary = dialog.locator('#projectAssets-default-listSize-dropdown summary');
  const settledRegion = () => expect(region).not.toHaveAttribute('aria-busy', 'true');
  const snapshots = () => form.locator('[data-project-assets-default-values]').evaluate((el) => JSON.parse(el.textContent));
  const choose = async (id, label) => {
    if (await chooseHiddenPresentationField(page, id, label)) return;
    const dropdown = dialog.locator(`#${id}`);
    await dropdown.locator('summary').click();
    await dropdown.locator('label').filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) }).click();
  };
  const pick = async (id, label) => {
    await choose(id, label);
    await settledRegion();
  };
  // Opens the dropdown, focuses its checked option and presses Space on it.
  const spaceOnShown = async (id, value) => {
    const dropdown = dialog.locator(`#${id}`);
    await dropdown.locator('summary').click();
    const shown = dropdown.locator('input[type="radio"]:checked');
    await expect(shown).toHaveValue(value);
    await shown.focus();
    await page.keyboard.press(' ');
    await expect(shown).toBeFocused();
    await expect(shown).toBeChecked();
  };
  const save = dialog.getByRole('button', { name: 'Save new defaults', exact: true });
  const defaultsPattern = `**/projects/${projectId}/assets/defaults`;
  const posts = [];
  const requests = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname.includes('/assets/defaults')) posts.push(r.postData());
    requests.push({ method: r.method(), url: r.url() });
  });
  const saveAndSettle = async () => {
    const response = page.waitForResponse((r) => r.request().method() === 'POST'
      && new URL(r.url()).pathname.endsWith('/assets/defaults'));
    await save.click();
    expect((await response).status()).toBeLessThan(400);
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'saved');
    await settledRegion();
    return new URLSearchParams(posts.at(-1));
  };
  const activate = async (label, scope) => {
    const response = page.waitForResponse((r) => r.request().method() === 'POST'
      && new URL(r.url()).pathname.endsWith('/assets/defaults'));
    await dialog.getByText(label, { exact: true }).click();
    expect((await response).status()).toBe(200);
    await expect(loadedScope).toHaveValue(scope);
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'saved');
    await settledRegion();
  };
  // The server commits the activation; its response is held, then unreadable.
  const holdUnreadable = async () => {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const handler = async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const committed = await route.fetch();
      expect(committed.status()).toBe(200);
      await held;
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"succ' });
    };
    await page.route(defaultsPattern, handler);
    return { release, unroute: () => page.unroute(defaultsPattern, handler) };
  };

  try {
    // Saved defaults: Global Large/Large, Project only Compact/Compact.
    await page.goto(`${f.baseURL}/projects/${projectId}/assets?view=grid`);
    await page.getByRole('link', { name: 'Filters & Defaults', exact: true }).click();
    await expect(dialog).toBeVisible();
    await pick('projectAssets-default-gridSize-dropdown', 'Large');
    await pick('projectAssets-default-listSize-dropdown', 'Large');
    await saveAndSettle();
    await activate('Project only', 'project');
    await pick('projectAssets-default-gridSize-dropdown', 'Compact');
    await pick('projectAssets-default-listSize-dropdown', 'Compact');
    await saveAndSettle();
    await activate('Global', 'global');
    await expect(gridSizeSelect).toHaveValue('large');
    await expect(listSizeSelect).toHaveValue('large');
    await expect(grid).toHaveAttribute('data-grid-size', 'large');

    // Grid: unreadable activation, failed recovery read, Space, GET-only check.
    const returnTo = new URL(await form.locator('input[name="returnTo"]').inputValue(), f.baseURL).href;
    let failNextRecoveryRead = false;
    const failRecovery = (route) => {
      if (failNextRecoveryRead && route.request().method() === 'GET') {
        failNextRecoveryRead = false;
        return route.abort('failed');
      }
      return route.continue();
    };
    await page.route((url) => url.href === returnTo, failRecovery);
    let held = await holdUnreadable();
    const postsBeforeActivation = posts.length;
    await dialog.getByText('Project only', { exact: true }).click();
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'pending');
    failNextRecoveryRead = true;
    held.release();
    await expect(form.locator('[data-dialog-status]')).toHaveText(/Could not confirm whether the defaults scope changed/);
    await held.unroute();
    expect(failNextRecoveryRead).toBe(false);
    await expect(loadedScope).toHaveValue('global');

    await spaceOnShown('projectAssets-default-gridSize-dropdown', 'large');
    const requestsBeforeCheck = requests.length;
    const checked = page.waitForResponse((r) => r.request().method() === 'GET' && r.url() === returnTo);
    await dialog.getByText('Project only', { exact: true }).click();
    expect((await checked).status()).toBe(200);
    await expect(loadedScope).toHaveValue('project');
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'saved');
    await expect(form.locator('[data-dialog-status]')).toHaveText(/newer changes were kept/);
    await settledRegion();
    await page.unroute((url) => url.href === returnTo, failRecovery);
    const checkRequests = requests.slice(requestsBeforeCheck);
    expect(checkRequests.filter((r) => r.method === 'POST')).toEqual([]);
    expect(checkRequests.filter((r) => r.method === 'GET' && r.url === returnTo)).toHaveLength(1);
    expect(posts).toHaveLength(postsBeforeActivation + 1);
    expect(new URLSearchParams(posts.at(-1)).get('intent')).toBe('activate-scope');

    // The Space-chosen Grid size stands; the untouched List size follows Project only.
    await expect(gridSizeSelect).toHaveValue('large');
    await expect(listSizeSelect).toHaveValue('compact');
    await expect(gridSizeSummary).toHaveAttribute('aria-label', /Large$/);
    await expect(listSizeSummary).toHaveAttribute('aria-label', /Compact$/);
    await expect(grid).toHaveAttribute('data-grid-size', 'large');
    let body = await saveAndSettle();
    expect([body.get('intent'), body.get('scope'), body.get('gridSize'), body.get('listSize')])
      .toEqual(['save', 'project', 'large', 'compact']);
    expect((await snapshots()).project).toMatchObject({ gridSize: 'large', listSize: 'compact' });
    expect((await snapshots()).global).toMatchObject({ gridSize: 'large', listSize: 'large' });

    // List: Global becomes Default/Large; Project only is Large/Compact.
    await activate('Global', 'global');
    await pick('projectAssets-default-gridSize-dropdown', 'Default');
    await saveAndSettle();
    await expect(listSizeSelect).toHaveValue('large');
    // R3: List size default is shown (and its checked option reachable by
    // Space) only while List is the View, so this half runs in List; the View
    // change happens while idle, before the activation under test.
    await pick('asset-view-filter-dropdown', 'List');
    await expect(list).toHaveAttribute('data-list-size', 'large');
    const listReturnTo = new URL(await form.locator('input[name="returnTo"]').inputValue(), f.baseURL).href;
    held = await holdUnreadable();
    const postsBeforeSecond = posts.length;
    const requestsBeforeSecond = requests.length;
    await dialog.getByText('Project only', { exact: true }).click();
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'pending');
    await spaceOnShown('projectAssets-default-listSize-dropdown', 'large');
    // The automatic recovery read succeeds at once.
    const recovered = page.waitForResponse((r) => r.request().method() === 'GET' && r.url() === listReturnTo);
    held.release();
    expect((await recovered).status()).toBe(200);
    await expect(loadedScope).toHaveValue('project');
    await expect(form.locator('[data-dialog-status]')).toHaveText(/newer changes were kept/);
    await settledRegion();
    await held.unroute();
    expect(posts).toHaveLength(postsBeforeSecond + 1);
    expect(requests.slice(requestsBeforeSecond).filter((r) => r.method === 'GET' && r.url === listReturnTo)).toHaveLength(1);
    await expect(gridSizeSelect).toHaveValue('large');
    await expect(listSizeSelect).toHaveValue('large');
    await expect(gridSizeSummary).toHaveAttribute('aria-label', /Large$/);
    await expect(listSizeSummary).toHaveAttribute('aria-label', /Large$/);
    body = await saveAndSettle();
    expect([body.get('intent'), body.get('scope'), body.get('gridSize'), body.get('listSize')])
      .toEqual(['save', 'project', 'large', 'large']);
    expect((await snapshots()).project).toMatchObject({ gridSize: 'large', listSize: 'large' });
    expect((await snapshots()).global).toMatchObject({ gridSize: 'default', listSize: 'large' });
    await expect(list).toHaveAttribute('data-list-size', 'large');
    expect(pageErrors).toEqual([]);
  } finally {
    await f.close();
  }
});

// Milestone 2 Correction B.
// F3: a Save acknowledged after a newer live filter change keeps that change
// and re-reads the current view against the saved defaults, so the pagination
// links keep the visible sort instead of falling back to the new default.
test('an acknowledged Save reconciles pagination links with a newer live filter change', async ({ page }) => {
  test.skip(Boolean(process.env.CREATORCRATE_BROWSER_BASE_URL), 'Requires the isolated fixture.');
  const f = await fixture({ many: true });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const [projectId] = f.ids;
  const dialog = page.locator('#project-assets-filter-dialog');
  const form = page.locator('#project-assets-defaults-form');
  const region = page.locator('[data-project-assets-live-region]');
  const next = region.locator('.pagination-next').first();
  const count = page.locator('[data-selected-count]');
  const settledRegion = () => expect(region).not.toHaveAttribute('aria-busy', 'true');
  const snapshots = () => form.locator('[data-project-assets-default-values]').evaluate((el) => JSON.parse(el.textContent));
  const linkParams = async (locator) => new URL(await locator.getAttribute('href'), f.baseURL).searchParams;
  const pick = async (id, label) => {
    if (await chooseHiddenPresentationField(page, id, label)) return settledRegion();
    const dropdown = dialog.locator(`#${id}`);
    await dropdown.locator('summary').click();
    await dropdown.locator('label').filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) }).click();
    if (await dropdown.evaluate((node) => node.open)) await dropdown.locator('summary').click();
    await settledRegion();
  };
  const openDialog = async () => {
    await page.getByRole('link', { name: 'Filters & Defaults', exact: true }).click();
    await expect(dialog).toBeVisible();
  };
  const closeDialog = async () => {
    await page.keyboard.press('Escape');
    if (await dialog.isVisible()) await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  };
  const save = dialog.getByRole('button', { name: 'Save new defaults', exact: true });
  const defaultsPattern = `**/projects/${projectId}/assets/defaults`;
  const isDefaultsPost = (r) => r.request().method() === 'POST'
    && new URL(r.url()).pathname.endsWith('/assets/defaults');
  // All categories: a concrete Category in Filename order is the unpaged
  // category-order surface, so it has no pagination links to go stale.
  const context = [['search', 'p'], ['presence', 'present'], ['usage', 'unused'], ['pageSize', '10']];
  const expectContext = (params) => {
    for (const [key, value] of context) expect(params.getAll(key)).toEqual([value]);
  };

  try {
    await page.goto(`${f.baseURL}/projects/${projectId}/assets?view=grid&${new URLSearchParams(context)}`);
    await expect(next).toBeVisible();

    // The Save of Modified date is held; Filename is chosen and loads meanwhile.
    await openDialog();
    await pick('asset-sort-filter', 'Modified date');
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const hold = async (route) => {
      if (route.request().method() === 'POST') await held;
      await route.continue();
    };
    await page.route(defaultsPattern, hold);
    const acknowledged = page.waitForResponse(isDefaultsPost);
    await save.click();
    await expect(form).toHaveAttribute('aria-busy', 'true');
    await pick('asset-sort-filter', 'Filename');
    await expect(page).toHaveURL(/sort=filename/);
    // A selection made in the newer view must survive the reconciliation.
    await region.locator('input[name="selectedAssetIds"]').first().evaluate((input) => input.click());
    await expect(count).toHaveText(/^1 of /);
    release();
    expect((await acknowledged).status()).toBe(302);
    await page.unroute(defaultsPattern, hold);
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'saved');
    await settledRegion();

    // The Save persisted what it captured; the newer choice is still the view.
    expect((await snapshots()).global.sort).toBe('modified');
    await expect(dialog.locator('#asset-sort-filter summary')).toHaveAttribute('aria-label', /Filename$/);
    expectContext(new URL(page.url()).searchParams);
    expect(new URL(page.url()).searchParams.get('sort')).toBe('filename');
    // The links were rebuilt against the saved default, so they carry Filename.
    await expect.poll(async () => (await linkParams(next)).get('sort')).toBe('filename');
    expectContext(await linkParams(next));
    await expect(count).toHaveText(/^1 of /);

    // Following Next keeps Filename; Previous does too.
    await closeDialog();
    await next.click();
    await expect(page).toHaveURL(/page=2/);
    await settledRegion();
    expect(new URL(page.url()).searchParams.get('sort')).toBe('filename');
    expectContext(new URL(page.url()).searchParams);
    const prev = region.locator('.pagination-prev').first();
    expect((await linkParams(prev)).get('sort')).toBe('filename');
    await openDialog();
    await expect(dialog.locator('#asset-sort-filter summary')).toHaveAttribute('aria-label', /Filename$/);

    // A Save with no concurrent edit still succeeds and keeps the page and view.
    const plain = page.waitForResponse(isDefaultsPost);
    await save.click();
    expect((await plain).status()).toBe(302);
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'saved');
    await settledRegion();
    expect((await snapshots()).global.sort).toBe('filename');
    expect(new URL(page.url()).searchParams.get('page')).toBe('2');
    expectContext(new URL(page.url()).searchParams);

    // A failed Save reports the failure and re-reads nothing.
    await pick('asset-sort-filter', 'Modified date');
    const loads = [];
    const track = (request) => {
      if (request.method() === 'GET' && new URL(request.url()).pathname === `/projects/${projectId}/assets`) loads.push(request.url());
    };
    page.on('request', track);
    const fail = (route) => (route.request().method() === 'POST'
      ? route.fulfill({ status: 500, body: 'failed' }) : route.continue());
    await page.route(defaultsPattern, fail);
    await save.click();
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'error');
    await page.unroute(defaultsPattern, fail);
    page.off('request', track);
    expect(loads).toEqual([]);
    expect((await snapshots()).global.sort).toBe('filename');
    await expect(dialog.locator('#asset-sort-filter summary')).toHaveAttribute('aria-label', /Modified date$/);
    expect(pageErrors).toEqual([]);
  } finally {
    await f.close();
  }
});

// F4: Reset defaults keeps what is on screen, and the next Save persists the
// Tag/Extension selection the page shows, not the reset (unrestricted) snapshot.
test('Reset defaults keeps the displayed Tag and Extension for the next Save', async ({ page }) => {
  test.skip(Boolean(process.env.CREATORCRATE_BROWSER_BASE_URL), 'Requires the isolated fixture.');
  const f = await fixture({ many: true });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const [projectId] = f.ids;
  const alpha = String(f.tagIds.Alpha);
  const beta = String(f.tagIds.Beta);
  const bothTags = [alpha, beta].sort();
  const bare = `${f.baseURL}/projects/${projectId}/assets`;
  const dialog = page.locator('#project-assets-filter-dialog');
  const form = page.locator('#project-assets-defaults-form');
  const region = page.locator('[data-project-assets-live-region]');
  const marker = page.locator('#asset-filters [data-project-assets-inherited-filter-defaults]');
  const indicator = dialog.locator('[data-project-assets-defaults-indicator]');
  const status = dialog.locator('[data-settings-fetch-save-status]');
  const settledRegion = () => expect(region).not.toHaveAttribute('aria-busy', 'true');
  const snapshots = () => form.locator('[data-project-assets-default-values]').evaluate((el) => JSON.parse(el.textContent));
  const members = (value) => (Array.isArray(value) ? value.map(String).sort() : value);
  // F5: a reconciled region renders no marker at all when nothing is inherited.
  const markerKeys = async () => ((await marker.count()) === 0 ? []
    : marker.evaluate((input) => (input.disabled ? [] : input.value.split(',').filter(Boolean).sort())));
  const displayed = (name) => page.locator(`#asset-filters input[name="${name}"]:checked`)
    .evaluateAll((inputs) => inputs.map((input) => input.value).filter((value) => value !== 'all').sort());
  const pick = async (id, label) => {
    if (await chooseHiddenPresentationField(page, id, label)) return settledRegion();
    const dropdown = dialog.locator(`#${id}`);
    await dropdown.locator('summary').click();
    await dropdown.locator('label').filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) }).click();
    if (await dropdown.evaluate((node) => node.open)) await dropdown.locator('summary').click();
    await settledRegion();
  };
  const openDialog = async () => {
    await page.getByRole('link', { name: 'Filters & Defaults', exact: true }).click();
    await expect(dialog).toBeVisible();
  };
  const posts = [];
  const isDefaultsPost = (r) => r.request().method() === 'POST'
    && new URL(r.url()).pathname.endsWith('/assets/defaults');
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/assets/defaults')) posts.push(r.postData());
  });
  const saveButton = dialog.getByRole('button', { name: 'Save new defaults', exact: true });
  const save = async () => {
    const saved = page.waitForResponse(isDefaultsPost);
    await saveButton.click();
    expect((await saved).status()).toBe(302);
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'saved');
    await settledRegion();
    return new URLSearchParams(posts.at(-1));
  };
  const reset = async (label, message) => {
    await dialog.locator('[data-project-assets-defaults-reset]').click();
    const confirm = page.locator('dialog[open]').filter({ hasText: `Reset ${label} defaults` });
    await confirm.getByRole('button', { name: 'Reset defaults', exact: true }).click();
    await expect(status).toHaveText(message);
  };
  const GLOBAL_RESET = 'Global defaults reset. Project-only defaults were kept.';
  // The persisted values, as a fresh page load renders them.
  const persisted = async () => {
    await page.goto(bare);
    return snapshots();
  };
  const resetPattern = `**/projects/${projectId}/assets/defaults/reset`;

  try {
    // Save PNG as the Global Extension default; a bare load then inherits it.
    await page.goto(`${bare}?view=grid`);
    await openDialog();
    await pick('asset-extension-filter', '.png');
    await save();
    expect(members((await persisted()).global.extension)).toEqual(['png']);
    expect(new URL(page.url()).searchParams.getAll('extension')).toEqual(['png']);
    expect(await markerKeys()).toEqual(['extension']);

    // 1. Global reset: PNG stays on screen, and the next Save persists PNG.
    await openDialog();
    await reset('Global', GLOBAL_RESET);
    expect(await displayed('extension')).toEqual(['png']);
    expect((await snapshots()).global.extension).toBe('all');
    expect(await markerKeys()).toEqual([]);
    await expect(indicator).toContainText('No saved defaults');
    await expect(indicator).toContainText('Current settings differ from the active defaults');
    let body = await save();
    expect(body.getAll('extension')).toEqual(['png']);
    for (const key of ['category', 'search', 'presence', 'usage']) expect(body.has(key)).toBe(false);
    await expect(indicator).toContainText('Global defaults saved');
    expect(members((await persisted()).global.extension)).toEqual(['png']);

    // The same when a reload has put the stale inherited mark back.
    await openDialog();
    await reset('Global', GLOBAL_RESET);
    await page.reload();
    expect(await displayed('extension')).toEqual(['png']);
    expect(await markerKeys()).toEqual(['extension']);
    expect((await snapshots()).global.extension).toBe('all');
    await openDialog();
    body = await save();
    expect(body.getAll('extension')).toEqual(['png']);

    // 2-4. Several extensions and several tags survive Reset and Save.
    await pick('asset-extension-filter', '.jpg');
    await pick('asset-tag-filter', 'Alpha');
    await pick('asset-tag-filter', 'Beta');
    await save();
    let saved = await persisted();
    expect(members(saved.global.extension)).toEqual(['jpg', 'png']);
    expect(members(saved.global.tag)).toEqual(bothTags);
    expect(await markerKeys()).toEqual(['extension', 'tag']);
    await openDialog();
    await reset('Global', GLOBAL_RESET);
    expect(await displayed('extension')).toEqual(['jpg', 'png']);
    expect(await displayed('tag')).toEqual(bothTags);
    expect(await markerKeys()).toEqual([]);
    body = await save();
    expect(body.getAll('extension').sort()).toEqual(['jpg', 'png']);
    expect(body.getAll('tag').sort()).toEqual(bothTags);
    saved = await persisted();
    expect(members(saved.global.extension)).toEqual(['jpg', 'png']);
    expect(members(saved.global.tag)).toEqual(bothTags);

    // 9. An explicit edit after Reset is what the next Save persists.
    await openDialog();
    await reset('Global', GLOBAL_RESET);
    await pick('asset-tag-filter', 'Beta');
    expect(await displayed('tag')).toEqual([alpha]);
    // 5. So is an explicit Select all.
    await pick('asset-extension-filter', 'Select all');
    expect(await displayed('extension')).toEqual([]);
    body = await save();
    expect(body.getAll('tag')).toEqual([alpha]);
    expect(body.getAll('extension').filter((value) => value !== 'all')).toEqual([]);
    saved = await persisted();
    expect(members(saved.global.tag)).toEqual([alpha]);
    expect(saved.global.extension).toBe('all');

    // 6. A suspended, untouched inherited Tag under a concrete Category is not
    // displayed, is not overwritten with All by a Save, and (7) returns with
    // All categories.
    expect(await markerKeys()).toEqual(['tag']);
    await openDialog();
    await pick('asset-category-filter', 'Final \\(\\d+\\)');
    expect(new URL(page.url()).searchParams.has('tag')).toBe(false);
    expect(await displayed('tag')).toEqual([]);
    expect(await markerKeys()).toEqual(['tag']);
    body = await save();
    expect(body.getAll('tag')).toEqual([alpha]);
    expect(body.has('category')).toBe(false);
    await pick('asset-category-filter', 'All categories \\(\\d+\\)');
    expect(await displayed('tag')).toEqual([alpha]);
    expect(await markerKeys()).toEqual(['tag']);
    expect(members((await persisted()).global.tag)).toEqual([alpha]);

    // 12. A reset that fails wrote nothing: the default is still inherited and
    // the next Save still persists it.
    await openDialog();
    const fail = (route) => route.fulfill({
      status: 422, contentType: 'application/json', body: JSON.stringify({ status: 'error' }),
    });
    await page.route(resetPattern, fail);
    await reset('Global', 'Defaults could not be reset. No changes were made.');
    await page.unroute(resetPattern, fail);
    expect(await markerKeys()).toEqual(['tag']);
    expect(members((await snapshots()).global.tag)).toEqual([alpha]);
    body = await save();
    expect(body.getAll('tag')).toEqual([alpha]);

    // 8. Project-only reset: Global becomes active again and is untouched.
    const activated = page.waitForResponse(isDefaultsPost);
    await dialog.getByText('Project only', { exact: true }).click();
    expect((await activated).status()).toBe(200);
    await expect(form.locator('input[name="loadedScope"]')).toHaveValue('project');
    await settledRegion();
    await pick('asset-tag-filter', 'Alpha');
    await pick('asset-tag-filter', 'Beta');
    body = await save();
    expect(body.get('scope')).toBe('project');
    expect(body.getAll('tag')).toEqual([beta]);
    await reset('Project-only', 'Project-only defaults reset. This project now uses Global defaults.');
    await expect(form.locator('input[name="loadedScope"]')).toHaveValue('global');
    await expect(dialog.locator('input[name="scope"][value="global"]')).toBeChecked();
    expect(await displayed('tag')).toEqual([beta]);
    await expect(indicator).toContainText('Using Global');
    saved = await snapshots();
    expect(members(saved.global.tag)).toEqual([alpha]);
    expect(members(saved.project.tag)).toEqual([alpha]);
    saved = await persisted();
    expect(members(saved.global.tag)).toEqual([alpha]);
    await expect(form.locator('input[name="loadedScope"]')).toHaveValue('global');

    // 12. An uncertain reset refuses the next Save until a reload.
    await openDialog();
    const abort = (route) => route.abort();
    await page.route(resetPattern, abort);
    await reset('Global', 'Could not confirm whether defaults were reset. Reload the page to check before saving defaults.');
    await page.unroute(resetPattern, abort);
    const before = posts.length;
    await saveButton.click();
    await expect(status).toHaveText('Reload the page before saving defaults.');
    expect(posts.length).toBe(before);
    expect(pageErrors).toEqual([]);
  } finally {
    await f.close();
  }
});

// Milestone 2 Correction C.
// F5: Reset defaults keeps the current view, so the pagination links the
// server rendered against the deleted defaults are rebuilt against the ones
// now persisted: a value the reset made differ from its default becomes
// explicit, and Next/Previous keep the view instead of inheriting Global.
test('Reset defaults rebuilds pagination links so Next and Previous keep the current view', async ({ page }) => {
  test.skip(Boolean(process.env.CREATORCRATE_BROWSER_BASE_URL), 'Requires the isolated fixture.');
  test.setTimeout(120_000);
  // 57 assets: three pages at 25 (25/25/7), six at 10.
  const f = await fixture({ many: true, extra: 40 });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const [projectId] = f.ids;
  const bare = `${f.baseURL}/projects/${projectId}/assets`;
  const dialog = page.locator('#project-assets-filter-dialog');
  const form = page.locator('#project-assets-defaults-form');
  const region = page.locator('[data-project-assets-live-region]');
  const grid = region.locator('.asset-grid');
  const next = region.locator('.pagination-next').first();
  const prev = region.locator('.pagination-prev').first();
  const cards = region.locator('input[name="selectedAssetIds"]');
  const count = page.locator('[data-selected-count]');
  const status = dialog.locator('[data-settings-fetch-save-status]');
  const settledRegion = () => expect(region).not.toHaveAttribute('aria-busy', 'true');
  const snapshots = () => form.locator('[data-project-assets-default-values]').evaluate((el) => JSON.parse(el.textContent));
  const linkParams = async (locator) => Object.fromEntries(new URL(await locator.getAttribute('href'), f.baseURL).searchParams);
  const current = () => page.evaluate(() => {
    const data = new FormData(document.getElementById('asset-filters'));
    return { sort: data.get('sort'), order: data.get('order'), pageSize: data.get('pageSize'), view: data.get('view') };
  });
  const urlParams = () => Object.fromEntries(new URL(page.url()).searchParams);
  const pick = async (id, label) => {
    if (await chooseHiddenPresentationField(page, id, label)) return settledRegion();
    const dropdown = dialog.locator(`#${id}`);
    await dropdown.locator('summary').click();
    await dropdown.locator('label').filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) }).click();
    if (await dropdown.evaluate((node) => node.open)) await dropdown.locator('summary').click();
    await settledRegion();
  };
  const openDialog = async () => {
    await page.getByRole('link', { name: 'Filters & Defaults', exact: true }).click();
    await expect(dialog).toBeVisible();
  };
  const closeDialog = async () => {
    await page.keyboard.press('Escape');
    if (await dialog.isVisible()) await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  };
  const isDefaultsPost = (r) => r.request().method() === 'POST'
    && new URL(r.url()).pathname.endsWith('/assets/defaults');
  const resetPosts = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/assets/defaults/reset')) resetPosts.push(r.postData());
  });
  const save = async () => {
    const saved = page.waitForResponse(isDefaultsPost);
    await dialog.getByRole('button', { name: 'Save new defaults', exact: true }).click();
    expect((await saved).status()).toBe(302);
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'saved');
    await settledRegion();
  };
  const activate = async (label) => {
    const activated = page.waitForResponse(isDefaultsPost);
    await dialog.getByText(label, { exact: true }).click();
    expect((await activated).status()).toBe(200);
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'saved');
    await settledRegion();
  };
  const reset = async (label, message) => {
    await dialog.locator('[data-project-assets-defaults-reset]').click();
    const confirm = page.locator('dialog[open]').filter({ hasText: `Reset ${label} defaults` });
    await confirm.getByRole('button', { name: 'Reset defaults', exact: true }).click();
    await expect(status).toHaveText(message);
  };
  const PROJECT_RESET = 'Project-only defaults reset. This project now uses Global defaults.';
  const GLOBAL_RESET = 'Global defaults reset. Project-only defaults were kept.';
  const REFRESH_FAILED = 'Defaults were reset, but Project Assets could not refresh, so its page and view links are unavailable. Retry, or reload the page.';
  const PROJECT_VIEW = { sort: 'filename', order: 'asc', pageSize: '25', view: 'grid' };
  const GLOBAL_VIEW = { sort: 'modified', order: 'desc', pageSize: '10', view: 'list' };
  const assetGets = [];
  page.on('request', (r) => {
    if (r.method() === 'GET' && new URL(r.url()).pathname === `/projects/${projectId}/assets`
      && r.resourceType() === 'fetch') assetGets.push(r.url());
  });
  const isAssetsGet = (url) => new URL(url).pathname === `/projects/${projectId}/assets`;

  try {
    // Global: Modified date / Descending / 10 / List.
    await page.goto(`${bare}?${new URLSearchParams(GLOBAL_VIEW)}`);
    await openDialog();
    await save();
    // Project only: Filename / Ascending / 25 / Grid (every one a fallback
    // value, so the server leaves them all out of the links it renders).
    await activate('Project only');
    await page.goto(`${bare}?${new URLSearchParams(PROJECT_VIEW)}`);
    await openDialog();
    await expect(form.locator('input[name="loadedScope"]')).toHaveValue('project');
    await save();
    const saved = await snapshots();
    expect(saved.global).toMatchObject({ sort: 'modified', order: 'desc', view: 'list' });
    expect(String(saved.global.pageSize)).toBe('10');
    expect(saved.project).toMatchObject({ sort: 'filename', order: 'asc', view: 'grid' });
    expect(String(saved.project.pageSize)).toBe('25');

    // A. Project-only reset on page 2.
    await page.goto(bare);
    expect(await current()).toEqual(PROJECT_VIEW);
    await next.click();
    await expect(page).toHaveURL(/page=2/);
    await settledRegion();
    await expect(cards).toHaveCount(25);
    // The links rely on the Project-only defaults the reset will delete.
    expect(await linkParams(next)).toEqual({ page: '3' });
    // Transient state the reconciliation must keep.
    await cards.first().evaluate((input) => input.click());
    await expect(count).toHaveText(/^1 of /);
    await page.locator('[data-asset-grid-size-controls] [data-grid-size-option-label="large"]').click();
    await expect(grid).toHaveAttribute('data-grid-size', 'large');
    await openDialog();
    await pick('projectAssets-default-gridStyle-dropdown', 'Cropped');
    await expect(grid).toHaveAttribute('data-grid-style', 'cropped');
    const storedSize = await page.evaluate(() => localStorage.getItem('creatorcrate-asset-grid-size'));

    await reset('Project-only', PROJECT_RESET);
    await settledRegion();
    await expect(form.locator('input[name="loadedScope"]')).toHaveValue('global');
    // Next and Previous now carry the retained view explicitly.
    await expect.poll(async () => (await linkParams(next)).sort).toBe('filename');
    expect(await linkParams(next)).toMatchObject({ ...PROJECT_VIEW, page: '3' });
    expect(await linkParams(prev)).toMatchObject(PROJECT_VIEW);
    // Controls, results, page, selection, Grid style and browser size kept.
    expect(await current()).toEqual(PROJECT_VIEW);
    expect(urlParams().page).toBe('2');
    await expect(cards).toHaveCount(25);
    await expect(count).toHaveText(/^1 of /);
    await expect(grid).toHaveAttribute('data-grid-style', 'cropped');
    await expect(grid).toHaveAttribute('data-grid-size', 'large');
    expect(await page.evaluate(() => localStorage.getItem('creatorcrate-asset-grid-size'))).toBe(storedSize);
    expect(resetPosts.at(-1)).toContain('scope=project');
    const afterProjectReset = await snapshots();
    expect(afterProjectReset.project).toEqual(afterProjectReset.global);

    // Following the links keeps Filename / Ascending / 25 / Grid.
    await closeDialog();
    await next.click();
    await expect(page).toHaveURL(/page=3/);
    await settledRegion();
    expect(await current()).toEqual(PROJECT_VIEW);
    await expect(grid).toBeVisible();
    await expect(cards).toHaveCount(7);
    await expect(region).toContainText('x34.png');
    await expect(region).toContainText('x40.png');
    await prev.click();
    await expect(page).toHaveURL(/page=2/);
    await settledRegion();
    expect(await current()).toEqual(PROJECT_VIEW);
    await expect(grid).toBeVisible();
    await expect(cards).toHaveCount(25);

    // B. Global reset: a Project-only override kept while Global is active.
    await openDialog();
    await activate('Project only');
    await page.goto(`${bare}?sort=size`);
    await openDialog();
    await save();
    expect((await snapshots()).project.sort).toBe('size');
    await activate('Global');
    await page.goto(bare);
    expect(await current()).toEqual(GLOBAL_VIEW);
    await next.click();
    await expect(page).toHaveURL(/page=2/);
    await settledRegion();
    // Values that differ from the built-in fallbacks are always explicit, so
    // the reconciliation must simply keep them (and the page) as they are.
    await openDialog();
    await reset('Global', GLOBAL_RESET);
    await settledRegion();
    await expect.poll(async () => (await linkParams(next)).sort).toBe('modified');
    expect(await linkParams(next)).toMatchObject({ ...GLOBAL_VIEW, page: '3' });
    expect(await current()).toEqual(GLOBAL_VIEW);
    await expect(cards).toHaveCount(10);
    expect((await snapshots()).project.sort).toBe('size');
    await closeDialog();
    await next.click();
    await expect(page).toHaveURL(/page=3/);
    await settledRegion();
    expect(await current()).toEqual(GLOBAL_VIEW);
    await expect(grid).toHaveCount(0);
    await expect(cards).toHaveCount(10);
    // The override survived on the server too.
    await page.goto(bare);
    expect((await snapshots()).project.sort).toBe('size');

    // C. Filter context: Search, Presence and Usage stay; links keep them.
    const contextQuery = { search: 'x', presence: 'present', usage: 'unused' };
    await page.goto(`${bare}?${new URLSearchParams({ ...contextQuery, ...GLOBAL_VIEW })}`);
    await openDialog();
    await save();
    await page.goto(`${bare}?${new URLSearchParams(contextQuery)}`);
    expect(await current()).toEqual(GLOBAL_VIEW);
    await next.click();
    await expect(page).toHaveURL(/page=2/);
    await settledRegion();
    await openDialog();
    await reset('Global', GLOBAL_RESET);
    await settledRegion();
    await expect.poll(async () => (await linkParams(next)).sort).toBe('modified');
    expect(await linkParams(next)).toMatchObject({ ...contextQuery, ...GLOBAL_VIEW, page: '3' });
    expect(await current()).toEqual(GLOBAL_VIEW);
    expect(urlParams()).toMatchObject(contextQuery);

    // D1. A failed reset re-reads nothing and reports the failure.
    await save();
    let gets = assetGets.length;
    let resets = resetPosts.length;
    const resetPattern = `**/projects/${projectId}/assets/defaults/reset`;
    const refuse = (route) => route.fulfill({
      status: 422, contentType: 'application/json', body: JSON.stringify({ status: 'error' }),
    });
    await page.route(resetPattern, refuse);
    await reset('Global', 'Defaults could not be reset. No changes were made.');
    await page.unroute(resetPattern, refuse);
    expect(resetPosts.length).toBe(resets + 1);
    expect(assetGets.length).toBe(gets);
    expect((await snapshots()).global.sort).toBe('modified');

    // D2. A committed reset whose GET fails stays committed, says so, is never
    // re-sent, and the shared GET-only Retry completes the reconciliation.
    const failGet = (route) => (route.request().method() === 'GET' && route.request().resourceType() === 'fetch'
      ? route.fulfill({ status: 500, body: 'failed' }) : route.continue());
    await page.route(isAssetsGet, failGet);
    resets = resetPosts.length;
    await reset('Global', REFRESH_FAILED);
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'saved-refresh-error');
    expect((await snapshots()).global.sort).toBe('filename');
    expect(await current()).toEqual(GLOBAL_VIEW);
    const retry = dialog.locator('[data-live-filter-retry]');
    await expect(retry).toBeVisible();
    await page.unroute(isAssetsGet, failGet);
    await retry.click();
    await settledRegion();
    await expect(status).toHaveText(GLOBAL_RESET);
    await expect.poll(async () => (await linkParams(next)).sort).toBe('modified');
    expect(await linkParams(next)).toMatchObject({ ...contextQuery, ...GLOBAL_VIEW, page: '3' });
    expect(resetPosts.length).toBe(resets + 1);

    // D3. A filter edit made while the reconciliation GET is pending wins.
    await save();
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let holding = true;
    const holdFirst = async (route) => {
      if (holding && route.request().method() === 'GET' && route.request().resourceType() === 'fetch') {
        holding = false;
        await held;
      }
      await route.continue().catch(() => {});
    };
    await page.route(isAssetsGet, holdFirst);
    gets = assetGets.length;
    await reset('Global', GLOBAL_RESET);
    await expect.poll(() => assetGets.length).toBe(gets + 1);
    await pick('asset-sort-filter', 'File size');
    await expect(page).toHaveURL(/sort=size/);
    release();
    await page.unroute(isAssetsGet, holdFirst);
    await settledRegion();
    expect(await current()).toEqual({ ...GLOBAL_VIEW, sort: 'size' });
    expect(urlParams().sort).toBe('size');
    // The newer load was rendered after the reset, so its links are explicit.
    expect(await linkParams(next)).toMatchObject({ ...contextQuery, sort: 'size', order: 'desc', pageSize: '10', view: 'list' });
    await expect(status).toHaveText(GLOBAL_RESET);
    expect(resetPosts.length).toBe(resets + 2);
    expect(pageErrors).toEqual([]);
  } finally {
    await f.close();
  }
});

// Milestone 2 Correction D. Shared helpers for the F6 and F7 regressions.
function resetHarness(page, f) {
  const [projectId] = f.ids;
  const bare = `${f.baseURL}/projects/${projectId}/assets`;
  const dialog = page.locator('#project-assets-filter-dialog');
  const form = page.locator('#project-assets-defaults-form');
  const region = page.locator('[data-project-assets-live-region]');
  const status = dialog.locator('[data-settings-fetch-save-status]');
  const settledRegion = () => expect(region).not.toHaveAttribute('aria-busy', 'true');
  const isDefaultsPost = (r) => r.request().method() === 'POST'
    && new URL(r.url()).pathname.endsWith('/assets/defaults');
  const isAssetsGet = (url) => new URL(url).pathname === `/projects/${projectId}/assets`;
  const resetPosts = [];
  const assetGets = [];
  page.on('request', (r) => {
    const pathname = new URL(r.url()).pathname;
    if (r.method() === 'POST' && pathname.endsWith('/assets/defaults/reset')) resetPosts.push(r.postData());
    if (r.method() === 'GET' && pathname === `/projects/${projectId}/assets` && r.resourceType() === 'fetch') {
      assetGets.push(r.url());
    }
  });
  return {
    projectId,
    bare,
    dialog,
    form,
    region,
    status,
    settledRegion,
    isAssetsGet,
    resetPosts,
    assetGets,
    current: () => page.evaluate(() => {
      const data = new FormData(document.getElementById('asset-filters'));
      return { sort: data.get('sort'), order: data.get('order'), pageSize: data.get('pageSize'), view: data.get('view') };
    }),
    stored: () => page.evaluate(() => [
      localStorage.getItem('creatorcrate-asset-grid-size'),
      localStorage.getItem('creatorcrate-asset-list-size'),
    ]),
    pick: async (id, label) => {
      if (await chooseHiddenPresentationField(page, id, label)) return settledRegion();
      const dropdown = dialog.locator(`#${id}`);
      await dropdown.locator('summary').click();
      await dropdown.locator('label').filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) }).click();
      if (await dropdown.evaluate((node) => node.open)) await dropdown.locator('summary').click();
      await settledRegion();
    },
    openDialog: async () => {
      await page.getByRole('link', { name: 'Filters & Defaults', exact: true }).click();
      await expect(dialog).toBeVisible();
    },
    closeDialog: async () => {
      await page.keyboard.press('Escape');
      if (await dialog.isVisible()) await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    },
    save: async () => {
      const saved = page.waitForResponse(isDefaultsPost);
      await dialog.getByRole('button', { name: 'Save new defaults', exact: true }).click();
      expect((await saved).status()).toBe(302);
      await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'saved');
      await settledRegion();
    },
    activate: async (label) => {
      const activated = page.waitForResponse(isDefaultsPost);
      await dialog.getByText(label, { exact: true }).click();
      expect((await activated).status()).toBe(200);
      await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'saved');
      await settledRegion();
    },
    reset: async (label, message) => {
      await dialog.locator('[data-project-assets-defaults-reset]').click();
      const confirm = page.locator('dialog[open]').filter({ hasText: `Reset ${label} defaults` });
      await confirm.getByRole('button', { name: 'Reset defaults', exact: true }).click();
      await expect(status).toHaveText(message);
    },
  };
}

const GLOBAL_RESET_DONE = 'Global defaults reset. Project-only defaults were kept.';
const RESET_REFRESH_FAILED = 'Defaults were reset, but Project Assets could not refresh, so its page and view links are unavailable. Retry, or reload the page.';

// F6: Reset defaults keeps the displayed Grid and List sizes when no browser
// size is stored, without creating or rewriting a browser size preference.
test('Reset defaults keeps the displayed Grid and List sizes without writing browser sizes', async ({ page }) => {
  test.skip(Boolean(process.env.CREATORCRATE_BROWSER_BASE_URL), 'Requires the isolated fixture.');
  test.setTimeout(120_000);
  const f = await fixture({ many: true });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const h = resetHarness(page, f);
  const grid = h.region.locator('.asset-grid');
  const list = h.region.locator('.asset-list');
  const cards = h.region.locator('input[name="selectedAssetIds"]');
  const count = page.locator('[data-selected-count]');
  const cardMin = () => grid.evaluate((el) => el.style.getPropertyValue('--asset-card-min'));
  const viewLink = (name) => h.region.getByRole('link', { name: `${name} view`, exact: true });
  const sizeLabel = (size) => page.locator(`[data-asset-grid-size-controls] [data-grid-size-option-label="${size}"]`);
  const isFetchGet = (r) => h.isAssetsGet(r.url()) && r.request().resourceType() === 'fetch';

  try {
    // Global: Grid Large, List Compact, Modified date.
    await page.goto(`${h.bare}?view=grid&sort=modified`);
    await h.openDialog();
    await h.pick('projectAssets-default-gridSize-dropdown', 'Large');
    await h.pick('projectAssets-default-listSize-dropdown', 'Compact');
    await h.save();
    // No browser override: the sizes come from the saved defaults alone.
    await page.evaluate(() => localStorage.clear());
    await page.goto(h.bare);
    expect(await h.stored()).toEqual([null, null]);
    expect((await h.current()).sort).toBe('modified');
    await expect(grid).toHaveAttribute('data-grid-size', 'large');
    expect(await cardMin()).toBe('20rem');
    await expect(h.region).toHaveAttribute('data-project-assets-list-size-default', 'compact');

    // Transient state that must survive.
    await cards.first().evaluate((input) => input.click());
    await expect(count).toHaveText(/^1 of /);
    await h.openDialog();
    await h.pick('projectAssets-default-gridStyle-dropdown', 'Cropped');
    await expect(grid).toHaveAttribute('data-grid-style', 'cropped');

    // A. Reset Global; hold the reconciliation GET to check it pending too.
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let holding = true;
    const holdFirst = async (route) => {
      if (holding && route.request().method() === 'GET' && route.request().resourceType() === 'fetch') {
        holding = false;
        await held;
      }
      await route.continue().catch(() => {});
    };
    await page.route(h.isAssetsGet, holdFirst);
    const gets = h.assetGets.length;
    await h.reset('Global', GLOBAL_RESET_DONE);
    await expect.poll(() => h.assetGets.length).toBe(gets + 1);
    await expect(grid).toHaveAttribute('data-grid-size', 'large');
    expect(await cardMin()).toBe('20rem');
    const installed = page.waitForResponse(isFetchGet);
    release();
    await installed;
    await page.unroute(h.isAssetsGet, holdFirst);
    await h.settledRegion();
    // The reconciliation installed a region rendered after the reset.
    await expect.poll(async () => new URL(await viewLink('List').getAttribute('href'), f.baseURL)
      .searchParams.get('sort')).toBe('modified');
    await expect(grid).toHaveAttribute('data-grid-size', 'large');
    expect(await cardMin()).toBe('20rem');
    await expect(h.region).toHaveAttribute('data-project-assets-list-size-default', 'compact');
    await expect(grid).toHaveAttribute('data-grid-style', 'cropped');
    await expect(count).toHaveText(/^1 of /);
    expect((await h.current()).sort).toBe('modified');
    expect(await h.stored()).toEqual([null, null]);

    // B. Each mode keeps its size across later mode switches.
    await h.closeDialog();
    await viewLink('List').click();
    await expect(page).toHaveURL(/view=list/);
    await h.settledRegion();
    await expect(list).toHaveAttribute('data-list-size', 'compact');
    await viewLink('Grid').click();
    await expect(page).not.toHaveURL(/view=list/);
    await h.settledRegion();
    await expect(grid).toHaveAttribute('data-grid-size', 'large');
    expect(await cardMin()).toBe('20rem');
    expect(await h.stored()).toEqual([null, null]);

    // C. A manual browser override is neither overwritten nor cleared.
    // (Reopening shows the saved size defaults, so they are chosen again.)
    await h.openDialog();
    await h.pick('projectAssets-default-gridSize-dropdown', 'Large');
    await h.pick('projectAssets-default-listSize-dropdown', 'Compact');
    await h.save();
    expect(await h.stored()).toEqual(['large', 'compact']);
    await h.closeDialog();
    await sizeLabel('compact').click();
    await expect(grid).toHaveAttribute('data-grid-size', 'compact');
    expect(await h.stored()).toEqual(['compact', 'compact']);
    await h.openDialog();
    const reconciled = page.waitForResponse(isFetchGet);
    await h.reset('Global', GLOBAL_RESET_DONE);
    await reconciled;
    await h.settledRegion();
    await expect(grid).toHaveAttribute('data-grid-size', 'compact');
    expect(await h.stored()).toEqual(['compact', 'compact']);
    expect(h.resetPosts).toHaveLength(2);
    expect(pageErrors).toEqual([]);
  } finally {
    await f.close();
  }
});

// Correction E (F6): a live GET already rendered against the old size defaults
// when a size-only Reset is acknowledged must not retire the sizes that Reset
// retained; a later acknowledged Save still supersedes them.
test('a response rendered before Reset does not retire the retained Grid and List sizes', async ({ page }) => {
  test.skip(Boolean(process.env.CREATORCRATE_BROWSER_BASE_URL), 'Requires the isolated fixture.');
  test.setTimeout(120_000);
  const f = await fixture({ many: true });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const h = resetHarness(page, f);
  const grid = h.region.locator('.asset-grid');
  const list = h.region.locator('.asset-list');
  const cardMin = () => grid.evaluate((el) => el.style.getPropertyValue('--asset-card-min'));
  const viewLink = (name) => h.region.getByRole('link', { name: `${name} view`, exact: true });
  const defaultsPosts = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/assets/defaults')) defaultsPosts.push(r.url());
  });
  const expectRetained = async () => {
    await expect(grid).toHaveAttribute('data-grid-size', 'large');
    expect(await cardMin()).toBe('20rem');
    await expect(h.region).toHaveAttribute('data-project-assets-list-size-default', 'compact');
    expect(await h.stored()).toEqual([null, null]);
  };

  try {
    // Global saves only Grid Large and List Compact, so a Global reset leaves
    // every navigation default unchanged and starts no reconciliation GET.
    await page.goto(h.bare);
    await h.openDialog();
    await h.pick('projectAssets-default-gridSize-dropdown', 'Large');
    await h.pick('projectAssets-default-listSize-dropdown', 'Compact');
    await h.save();
    await page.evaluate(() => localStorage.clear());
    await page.goto(h.bare);
    await expectRetained();

    // A. A live Sort GET is answered by the server before the reset, and that
    // old-defaults response is held back until after the reset is acknowledged.
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let rendered;
    const renderedBeforeReset = new Promise((resolve) => { rendered = resolve; });
    let holding = true;
    const holdRendered = async (route) => {
      if (!holding || route.request().method() !== 'GET' || route.request().resourceType() !== 'fetch') {
        await route.continue().catch(() => {});
        return;
      }
      holding = false;
      const response = await route.fetch();
      rendered();
      await held;
      await route.fulfill({ response }).catch(() => {});
    };
    await page.route(h.isAssetsGet, holdRendered);
    await h.openDialog();
    const sort = h.dialog.locator('#asset-sort-filter');
    await sort.locator('summary').click();
    await sort.locator('label').filter({ hasText: /^\s*File size\s*$/ }).click();
    if (await sort.evaluate((node) => node.open)) await sort.locator('summary').click();
    await renderedBeforeReset;
    const gets = h.assetGets.length;
    await h.reset('Global', GLOBAL_RESET_DONE);
    await page.waitForTimeout(200);
    expect(h.assetGets.length).toBe(gets);
    await expectRetained();

    const installed = page.waitForResponse((r) => h.isAssetsGet(r.url()) && r.request().resourceType() === 'fetch');
    release();
    await installed;
    await page.unroute(h.isAssetsGet, holdRendered);
    await h.settledRegion();
    await expect(page).toHaveURL(/sort=size/);
    await expectRetained();

    // D. Later ordinary filter and view navigation keeps both sizes.
    await h.pick('asset-sort-filter', 'Filename');
    await expect(page).toHaveURL(/sort=filename/);
    await expectRetained();
    await h.closeDialog();
    await viewLink('List').click();
    await expect(page).toHaveURL(/view=list/);
    await h.settledRegion();
    await expect(list).toHaveAttribute('data-list-size', 'compact');
    await viewLink('Grid').click();
    await expect(page).not.toHaveURL(/view=list/);
    await h.settledRegion();
    await expectRetained();

    // B. A later acknowledged Save with different sizes supersedes them.
    await h.openDialog();
    await h.pick('projectAssets-default-gridSize-dropdown', 'Compact');
    await h.pick('projectAssets-default-listSize-dropdown', 'Large');
    await h.save();
    await expect(grid).toHaveAttribute('data-grid-size', 'compact');
    expect(await cardMin()).toBe('12rem');
    expect(await h.stored()).toEqual(['compact', 'large']);
    await h.pick('asset-sort-filter', 'File size');
    await expect(page).toHaveURL(/sort=size/);
    await expect(grid).toHaveAttribute('data-grid-size', 'compact');
    await expect(h.region).toHaveAttribute('data-project-assets-list-size-default', 'large');
    await h.closeDialog();
    await viewLink('List').click();
    await h.settledRegion();
    await expect(list).toHaveAttribute('data-list-size', 'large');

    // E. One reset POST and only the two Saves: no extra defaults writes.
    expect(h.resetPosts).toHaveLength(1);
    expect(defaultsPosts).toHaveLength(2);
    expect(pageErrors).toEqual([]);
  } finally {
    await f.close();
  }
});

// F7: a committed reset whose reconciliation GET fails leaves the page and
// view links rendered against the deleted defaults unavailable until a newer
// region installs; Retry is GET-only and the reset is never re-sent.
test('a failed reset reconciliation makes the obsolete page and view links unavailable', async ({ page }) => {
  test.skip(Boolean(process.env.CREATORCRATE_BROWSER_BASE_URL), 'Requires the isolated fixture.');
  test.setTimeout(120_000);
  // 57 assets: three pages at 25, six at 10.
  const f = await fixture({ many: true, extra: 40 });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const h = resetHarness(page, f);
  const grid = h.region.locator('.asset-grid');
  const cards = h.region.locator('input[name="selectedAssetIds"]');
  const next = h.region.locator('.pagination-next').first();
  const prev = h.region.locator('.pagination-prev').first();
  const viewLinks = h.region.locator('nav.view-switcher a');
  const failure = page.locator('[data-live-filter-failure]');
  const retry = page.locator('[data-live-filter-retry]');
  const PROJECT_VIEW = { sort: 'filename', order: 'asc', pageSize: '25', view: 'grid' };
  const GLOBAL_VIEW = { sort: 'modified', order: 'desc', pageSize: '10', view: 'list' };
  const urlParams = () => Object.fromEntries(new URL(page.url()).searchParams);
  const linkParams = async (locator) => Object.fromEntries(new URL(await locator.getAttribute('href'), f.baseURL).searchParams);
  const failGet = (route) => (route.request().method() === 'GET' && route.request().resourceType() === 'fetch'
    ? route.fulfill({ status: 500, body: 'failed' }) : route.continue());
  const expectUnavailable = async (locator) => {
    await expect(locator).not.toHaveAttribute('href', /./);
    await expect(locator).toHaveAttribute('aria-disabled', 'true');
    await expect(locator).toHaveAttribute('role', 'link');
  };
  // Correction E (P3): computed appearance of a link, for enabled/disabled comparison.
  const look = (locator) => locator.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      opacity: style.opacity, color: style.color, background: style.backgroundColor, cursor: style.cursor,
    };
  });

  try {
    await page.goto(`${h.bare}?${new URLSearchParams(GLOBAL_VIEW)}`);
    await h.openDialog();
    await h.save();
    await h.activate('Project only');
    await page.goto(`${h.bare}?${new URLSearchParams(PROJECT_VIEW)}`);
    await h.openDialog();
    await h.save();

    // Project-only active, page 2.
    await page.goto(h.bare);
    expect(await h.current()).toEqual(PROJECT_VIEW);
    await next.click();
    await expect(page).toHaveURL(/page=2/);
    await h.settledRegion();
    expect(await linkParams(next)).toEqual({ page: '3' });
    await page.mouse.move(0, 0);
    await page.waitForTimeout(400);
    const enabledNext = await look(next);
    const enabledView = await look(viewLinks.last());

    // A. Reset POST succeeds; its reconciliation GET fails.
    await h.openDialog();
    await page.route(h.isAssetsGet, failGet);
    await h.reset('Project-only', RESET_REFRESH_FAILED);
    await expect(h.form).toHaveAttribute('data-settings-fetch-save-state', 'saved-refresh-error');
    expect(h.resetPosts).toHaveLength(1);
    await h.closeDialog();
    const gets = h.assetGets.length;
    await expectUnavailable(next);
    await expectUnavailable(prev);
    await expect(viewLinks).toHaveCount(2);
    for (const link of await viewLinks.all()) await expectUnavailable(link);
    // P3: they also look unavailable, and hover does not make them look active.
    await page.mouse.move(0, 0);
    await page.waitForTimeout(400);
    const staleNext = await look(next);
    const staleView = await look(viewLinks.last());
    expect(staleNext).toMatchObject({ opacity: '0.6', cursor: 'not-allowed' });
    expect(staleNext.color).not.toBe(enabledNext.color);
    expect(staleNext.background).not.toBe(enabledNext.background);
    expect(staleView).toMatchObject({ opacity: '0.6', cursor: 'not-allowed' });
    expect(enabledNext.opacity).toBe('1');
    expect(enabledView.opacity).toBe('1');
    await next.hover({ force: true });
    await page.waitForTimeout(400);
    expect(await look(next)).toEqual(staleNext);
    await viewLinks.last().hover({ force: true });
    await page.waitForTimeout(400);
    expect(await look(viewLinks.last())).toEqual(staleView);
    await page.mouse.move(0, 0);
    // The failure and its GET-only Retry are shown above the results.
    await expect(failure).toBeVisible();
    await expect(retry).toBeVisible();
    await expect(h.status).toHaveText(RESET_REFRESH_FAILED);

    // Pointer (forced past the disabled state), keyboard and view-switch
    // activation go nowhere.
    await next.click({ force: true });
    await prev.click({ force: true });
    await viewLinks.last().click({ force: true });
    await next.focus();
    await page.keyboard.press('Enter');
    expect(await next.evaluate((el) => el === document.activeElement)).toBe(false);
    await page.waitForTimeout(300);
    expect(urlParams().page).toBe('2');
    expect(h.assetGets.length).toBe(gets);
    expect(await h.current()).toEqual(PROJECT_VIEW);
    await expect(grid).toBeVisible();
    await expect(cards).toHaveCount(25);

    // B. Retry is a GET only and installs links that keep the view.
    await page.unroute(h.isAssetsGet, failGet);
    await retry.click();
    await h.settledRegion();
    await expect(failure).toHaveCount(0);
    expect(await linkParams(next)).toMatchObject({ ...PROJECT_VIEW, page: '3' });
    await expect(next).not.toHaveAttribute('aria-disabled', 'true');
    await page.mouse.move(0, 0);
    await expect.poll(() => look(next)).toEqual(enabledNext);
    await expect.poll(() => look(viewLinks.last())).toEqual(enabledView);
    expect(h.resetPosts).toHaveLength(1);
    await next.click();
    await expect(page).toHaveURL(/page=3/);
    await h.settledRegion();
    expect(await h.current()).toEqual(PROJECT_VIEW);
    await expect(cards).toHaveCount(7);

    // C. A newer successful live load resolves the stale state too.
    await h.openDialog();
    await page.route(h.isAssetsGet, failGet);
    await h.reset('Global', RESET_REFRESH_FAILED);
    await expectUnavailable(prev);
    await page.unroute(h.isAssetsGet, failGet);
    await h.pick('asset-sort-filter', 'File size');
    await expect(page).toHaveURL(/sort=size/);
    await h.settledRegion();
    await expect(failure).toHaveCount(0);
    // The newer load starts again at page 1, with links rendered after the reset.
    await expect(next).not.toHaveAttribute('aria-disabled', 'true');
    expect(await linkParams(next)).toMatchObject({ sort: 'size', page: '2' });
    expect(h.resetPosts).toHaveLength(2);

    // D. A failed reset POST and F. a no-op reset leave valid links usable.
    const resetPattern = `**/projects/${h.projectId}/assets/defaults/reset`;
    const refuse = (route) => route.fulfill({
      status: 422, contentType: 'application/json', body: JSON.stringify({ status: 'error' }),
    });
    await page.route(resetPattern, refuse);
    await h.reset('Global', 'Defaults could not be reset. No changes were made.');
    await page.unroute(resetPattern, refuse);
    await expect(next).toHaveAttribute('href', /sort=size/);
    await h.reset('Global', 'No Global defaults were saved, so nothing was reset.');
    await expect(next).toHaveAttribute('href', /sort=size/);
    await expect(next).not.toHaveAttribute('aria-disabled', 'true');
    // E. The valid links still navigate.
    await h.closeDialog();
    await next.click();
    await expect(page).toHaveURL(/page=2/);
    await h.settledRegion();
    expect(await h.current()).toEqual({ ...PROJECT_VIEW, sort: 'size' });
    expect(pageErrors).toEqual([]);
  } finally {
    await f.close();
  }
});

// Package A (U1–U3): the status row is two fixed columns. The saved-default
// status wraps in its own column while the compact "Use default:" radios stay
// anchored top-right at desktop/intermediate widths and stack above the status
// at the 540px dialog breakpoint, whatever the status or message says.
test('Use default scope choices stay anchored while the saved status changes', async ({ page }) => {
  test.skip(Boolean(process.env.CREATORCRATE_BROWSER_BASE_URL), 'Requires the isolated fixture.');
  test.setTimeout(150_000);
  const f = await fixture();
  const shotDir = process.env.CREATORCRATE_BROWSER_SCREENSHOT_DIR || '';
  const dialog = page.locator('#project-assets-filter-dialog');
  const form = page.locator('#project-assets-defaults-form');
  const row = dialog.locator('.filters-defaults-status-row');
  const indicator = dialog.locator('[data-project-assets-defaults-indicator]');
  const status = dialog.locator('[data-dialog-status]');
  const scopeGroup = dialog.locator('[data-project-assets-defaults-scope]');
  const radio = (name) => dialog.getByRole('radio', { name, exact: true });
  const posts = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/assets/defaults')) posts.push(r.url());
  });
  const settled = async () => {
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'saved');
    await expect(page.locator('[data-project-assets-live-region]')).not.toHaveAttribute('aria-busy', 'true');
    await expect(scopeGroup).not.toHaveAttribute('aria-busy', 'true');
  };
  const activate = async (label, value) => {
    const before = posts.length;
    await dialog.getByText(label, { exact: true }).click();
    await expect(form.locator('input[name="loadedScope"]')).toHaveValue(value);
    await settled();
    expect(posts.length - before).toBe(1);
  };
  const chooseSort = async (label) => {
    const dropdown = dialog.locator('#asset-sort-filter');
    await dropdown.locator('summary').click();
    await dropdown.locator('label').filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) }).click();
    await expect(dropdown.locator('summary')).toHaveAttribute('aria-label', new RegExp(`: ${label}$`));
    await expect(page.locator('[data-project-assets-live-region]')).not.toHaveAttribute('aria-busy', 'true');
    await expect(dialog).toBeVisible();
  };
  const save = async () => {
    const before = posts.length;
    await dialog.getByRole('button', { name: 'Save new defaults', exact: true }).click();
    await settled();
    expect(posts.length - before).toBe(1);
  };
  const geometry = () => row.evaluate((el) => {
    const box = (node) => {
      const r = node.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const dlg = el.closest('dialog');
    const body = dlg.querySelector('.app-dialog-body');
    const scope = el.querySelector('[data-project-assets-defaults-scope]');
    return {
      row: box(el),
      scope: box(scope),
      indicator: box(el.querySelector('[data-project-assets-defaults-indicator]')),
      header: box(dlg.querySelector('.app-dialog-header')),
      options: [...scope.querySelectorAll('.filters-defaults-scope-option')].map(box),
      // One line: every item's vertical extent overlaps every other's.
      scopeOneLine: (() => {
        const items = [scope.querySelector('legend'), ...scope.querySelectorAll('.filters-defaults-scope-option')]
          .map((node) => node.getBoundingClientRect());
        return Math.max(...items.map((r) => r.top)) < Math.min(...items.map((r) => r.bottom));
      })(),
      dialogOverflow: dlg.scrollWidth - dlg.clientWidth,
      bodyOverflow: body.scrollWidth - body.clientWidth,
      pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  const DESKTOP = [1440, 1000, 861, 860, 700, 541];
  const NARROW = [540, 390];
  const anchors = new Map();
  const measurements = [];
  const shot = async (name) => {
    if (shotDir) await row.screenshot({ path: path.join(shotDir, `${name}.png`) });
  };
  // Every state is checked at every width: desktop keeps one top-right line
  // whose position never depends on the status; narrow stacks scope first.
  const checkLayout = async (state) => {
    const resizePosts = posts.length;
    for (const width of [...DESKTOP, ...NARROW]) {
      await page.setViewportSize({ width, height: 900 });
      const g = await geometry();
      const at = `${state} @${width}`;
      measurements.push({ state, width, scopeX: Math.round(g.scope.left - g.row.left), scopeY: Math.round(g.scope.top - g.row.top),
        rowW: Math.round(g.row.width), indicatorH: Math.round(g.indicator.height) });
      expect(g.pageOverflow, at).toBeLessThanOrEqual(0);
      expect(g.dialogOverflow, at).toBeLessThanOrEqual(0);
      expect(g.bodyOverflow, at).toBeLessThanOrEqual(0);
      expect(g.row.top, at).toBeGreaterThanOrEqual(g.header.bottom);
      for (const option of g.options) {
        expect(option.width, at).toBeGreaterThan(0);
        expect(option.left, at).toBeGreaterThanOrEqual(g.row.left - 0.5);
        expect(option.right, at).toBeLessThanOrEqual(g.row.right + 0.5);
      }
      if (DESKTOP.includes(width)) {
        expect(g.scopeOneLine, at).toBe(true);
        expect(Math.abs(g.scope.right - g.row.right), at).toBeLessThanOrEqual(0.5);
        expect(Math.abs(g.scope.top - g.row.top), at).toBeLessThanOrEqual(0.5);
        if (g.indicator.height > 0) expect(g.indicator.right, at).toBeLessThanOrEqual(g.scope.left);
        const anchor = { x: g.scope.left - g.row.left, y: g.scope.top - g.row.top, w: g.scope.width };
        if (!anchors.has(width)) anchors.set(width, anchor);
        expect(anchor, at).toEqual(anchors.get(width));
      } else {
        expect(Math.abs(g.scope.left - g.row.left), at).toBeLessThanOrEqual(0.5);
        expect(Math.abs(g.scope.top - g.row.top), at).toBeLessThanOrEqual(0.5);
        if (g.indicator.height > 0) expect(g.indicator.top, at).toBeGreaterThanOrEqual(g.scope.bottom);
      }
      if (width === 1440 || width === 700 || width === 390) await shot(`${state}-${width}`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    expect(posts.length, `${state}: layout alone never posts`).toBe(resizePosts);
  };
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${f.baseURL}/projects/${f.ids[0]}/assets`);
    await page.getByRole('link', { name: 'Filters & Defaults', exact: true }).click();
    await expect(dialog).toBeVisible();

    // U3: the native group is named by its legend; both choices keep their names.
    await expect(dialog.getByRole('group', { name: 'Use default:', exact: true })).toBeVisible();
    await expect(dialog.getByText('Defaults scope:')).toHaveCount(0);
    await expect(radio('Global')).toBeChecked();
    await expect(radio('Project only')).not.toBeChecked();
    await expect(dialog.locator('footer button')).toHaveText(['Save new defaults', 'Reset defaults', 'Reset filters']);

    // U2: the compact themed radio, not the native control or a segmented toggle.
    const look = (name) => radio(name).evaluate((el) => {
      const s = getComputedStyle(el);
      const label = getComputedStyle(el.closest('label'));
      return { appearance: s.appearance, width: s.width, height: s.height, radius: s.borderRadius,
        background: s.backgroundColor, border: s.borderTopColor, labelBackground: label.backgroundColor };
    });
    const globalLook = await look('Global');
    const projectLook = await look('Project only');
    expect(globalLook).toMatchObject({ appearance: 'none', width: '16px', height: '16px', radius: '50%' });
    expect(projectLook).toMatchObject({ appearance: 'none', width: '16px', height: '16px', radius: '50%' });
    expect(globalLook.background).not.toBe(projectLook.background);
    expect(globalLook.labelBackground).toBe('rgba(0, 0, 0, 0)');
    await dialog.locator('label[for="project-assets-defaults-scope-project"]').hover();
    await expect.poll(async () => (await look('Project only')).border).not.toBe(projectLook.border);
    await page.mouse.move(0, 0);

    await expect(indicator).toHaveText('Using Global · No saved defaults.');
    await checkLayout('initial');

    await chooseSort('Modified date');
    await expect(indicator).toContainText('Current settings differ from the active defaults');
    await checkLayout('differs');
    await save();
    await expect(indicator).toHaveText(/^Using Global · Global defaults saved/);
    await expect(status).not.toBeEmpty();
    await checkLayout('global-saved');

    await activate('Project only', 'project');
    await expect(status).toHaveText('Project-only defaults loaded.');
    await checkLayout('project-loaded');
    await chooseSort('File size');
    await save();
    await expect(indicator).toHaveText(/^Using Project only · Global defaults saved · Project-only defaults saved/);
    await checkLayout('project-saved');

    await activate('Global', 'global');
    await expect(status).toHaveText('Global defaults loaded.');
    await checkLayout('global-loaded');
    await chooseSort('Filename');
    await expect(indicator).toHaveText('Using Global · Global defaults saved · Project-only defaults saved, not in use · Current settings differ from the active defaults.');
    await checkLayout('long-status');

    // Keyboard: Tab-focus shows the focus ring; Arrow selects and activates once.
    await radio('Global').focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(radio('Global')).toBeFocused();
    expect(await radio('Global').evaluate((el) => {
      const s = getComputedStyle(el);
      return el.matches(':focus-visible') && s.outlineStyle === 'solid' && s.outlineWidth === '2px';
    })).toBe(true);
    await shot('focus-visible-1440');

    // Pending: a held activation disables both radios in place, readably.
    let release = () => {};
    let markHeld;
    const held = new Promise((resolve) => { markHeld = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const route = `**/projects/${f.ids[0]}/assets/defaults`;
    const hold = async (r) => {
      if (r.request().method() !== 'POST') return r.continue();
      markHeld();
      await gate;
      return r.continue();
    };
    await page.route(route, hold);
    try {
      const before = posts.length;
      await page.keyboard.press('ArrowRight');
      await held;
      await expect(radio('Project only')).toBeChecked();
      await expect(radio('Global')).toBeDisabled();
      await expect(scopeGroup).toHaveAttribute('aria-busy', 'true');
      await expect(status).toHaveText('Loading Project-only defaults.');
      expect(await radio('Project only').evaluate((el) => Number(getComputedStyle(el).opacity))).toBeGreaterThanOrEqual(0.5);
      await checkLayout('pending');
      release();
      await expect(form.locator('input[name="loadedScope"]')).toHaveValue('project');
      await settled();
      expect(posts.length - before).toBe(1);
    } finally {
      release();
      await page.unroute(route, hold);
    }

    // Error: a refused activation keeps the previous scope; the anchor holds.
    const refuse = (r) => (r.request().method() === 'POST'
      ? r.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'Refused for layout check.' }) })
      : r.continue());
    await page.route(route, refuse);
    try {
      await dialog.getByText('Global', { exact: true }).click();
      await expect(status).not.toHaveText(/^Loading/);
      await expect(status).not.toBeEmpty();
      await checkLayout('error');
    } finally {
      await page.unroute(route, refuse);
    }

    // Stress: a much longer status and warning wrap in their own column and
    // never push the scope choices off their anchor.
    await indicator.evaluate((el) => { el.textContent = `${el.textContent} `.repeat(4).trim(); });
    await status.evaluate((el) => {
      el.textContent = 'Defaults scope changed, but Project Assets could not refresh. Refresh the page to see the loaded defaults. '.repeat(3).trim();
    });
    await checkLayout('long-warning');
    if (shotDir) fs.writeFileSync(path.join(shotDir, 'measurements.json'), JSON.stringify(measurements, null, 1));
  } finally {
    await f.close();
  }
});

// Package B: Reset filters restores the effective saved/default filters, Sort,
// View and page size from page 1 (Grid style and size defaults are Package C),
// supersedes a pending View load in either direction, and keeps Save and scope
// activation out while it owns the live region.
test('Reset filters restores saved/default filters, Sort, View and page size over pending loads', async ({ page }) => {
  test.skip(Boolean(process.env.CREATORCRATE_BROWSER_BASE_URL), 'Requires the isolated fixture.');
  const f = await fixture({ many: true });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const [projectId] = f.ids;
  const bare = `${f.baseURL}/projects/${projectId}/assets`;
  const dialog = page.locator('#project-assets-filter-dialog');
  const form = page.locator('#project-assets-defaults-form');
  const region = page.locator('[data-project-assets-live-region]');
  const status = dialog.locator('[data-settings-fetch-save-status]');
  const resetFilters = dialog.getByRole('button', { name: 'Reset filters', exact: true });
  const settledRegion = () => expect(region).not.toHaveAttribute('aria-busy', 'true');
  const openDialog = async () => {
    if (await dialog.isVisible()) return;
    await page.getByRole('link', { name: 'Filters & Defaults', exact: true }).click();
    await expect(dialog).toBeVisible();
  };
  const pick = async (id, label) => {
    if (await chooseHiddenPresentationField(page, id, label)) return;
    const dropdown = dialog.locator(`#${id}`);
    await dropdown.locator('summary').click();
    await dropdown.locator('label').filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) }).click();
    if (await dropdown.evaluate((node) => node.open)) await dropdown.locator('summary').click();
  };
  const native = (selector) => page.locator(selector).first().evaluate((select) => (
    select.multiple ? [...select.selectedOptions].map((option) => option.value).sort() : select.value));
  const checked = (name) => page.locator(`#asset-filters input[name="${name}"]:checked`)
    .evaluateAll((inputs) => inputs.map((input) => input.value).filter((value) => value !== 'all').sort());
  const listed = (locator) => locator.evaluateAll((nodes) => [
    ...new Set(nodes.map((node) => node.getAttribute('data-asset-filename'))),
  ]);
  const params = () => new URL(page.url()).searchParams;
  const resetRequests = [];
  const posts = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.searchParams.has('resetFilters')) resetRequests.push({ method: request.method(), search: url.search });
    if (request.method() === 'POST' && url.pathname.endsWith('/assets/defaults')) posts.push(request.postData());
  });
  const storedSizes = () => page.evaluate(() => [
    localStorage.getItem('creatorcrate-asset-grid-size'),
    localStorage.getItem('creatorcrate-asset-list-size'),
  ]);
  // The effective results a fresh, explicit full-page load renders for a view.
  const freshOrder = async (query) => {
    const other = await page.context().newPage();
    try {
      await other.goto(`${bare}?${query}`);
      return await listed(other.locator('[data-project-assets-live-region] [data-asset-filename]'));
    } finally {
      await other.close();
    }
  };
  const expectRestored = async ({ view, sort, order, pageSize, sortLabel, orderLabel, extension }) => {
    await settledRegion();
    await expect(page.locator('#asset-view-filter')).toHaveValue(view);
    // Sort and Order are the live form's radios (the dropdowns' native inputs).
    await expect(page.locator('#asset-filters input[name="sort"]:checked')).toHaveValue(sort);
    await expect(page.locator('#asset-filters input[name="order"]:checked')).toHaveValue(order);
    expect(await native('#pageSize')).toBe(pageSize);
    await expect(dialog.locator('#asset-sort-filter summary')).toContainText(sortLabel);
    await expect(dialog.locator('#asset-order-filter summary')).toContainText(orderLabel);
    await expect(dialog.locator('#asset-view-filter-dropdown summary')).toContainText(view === 'grid' ? 'Grid' : 'List');
    await expect(page.locator('#search')).toHaveValue('');
    expect(await checked('presence')).toEqual([]);
    expect(await checked('usage')).toEqual([]);
    // The saved Extension is restored (inherited); Tag had no saved default.
    expect(await checked('extension')).toEqual(extension);
    expect(await checked('tag')).toEqual([]);
    const url = params();
    expect(url.getAll('extension')).toEqual(extension);
    expect(url.get('inheritedFilterDefaults')).toBe('extension');
    for (const key of ['resetFilters', 'search', 'presence', 'usage', 'page', 'tag']) {
      expect(url.has(key)).toBe(false);
    }
    if (view === 'list') await expect(region.locator('.asset-list--project')).toBeVisible();
    else await expect(region.locator('.asset-grid')).toBeVisible();
    const shown = await listed(region.locator('[data-asset-filename]'));
    expect(shown).toHaveLength(Number(pageSize));
    expect(shown.every((name) => name.endsWith('.png'))).toBe(true);
    expect(shown).toEqual(await freshOrder(`view=${view}&sort=${sort}&order=${order}&pageSize=${pageSize}&extension=png`));
    await expect(region.locator('.pagination a', { hasText: /next/i }).first()).toBeVisible();
  };
  // Holds the next live GET whose URL matches until released.
  const holdNext = async (matches) => {
    let release;
    let seenResolve;
    const released = new Promise((resolve) => { release = resolve; });
    const seen = new Promise((resolve) => { seenResolve = resolve; });
    await page.route((url) => url.pathname === `/projects/${projectId}/assets` && matches(url), async (route) => {
      seenResolve();
      await released;
      await route.continue().catch(() => {});
    }, { times: 1 });
    return { seen, release };
  };
  const RESTORED_GLOBAL = {
    view: 'list', sort: 'size', order: 'desc', pageSize: '10', sortLabel: 'File size', orderLabel: 'Descending', extension: ['png'],
  };

  try {
    // Global defaults with non-fallback Sort, Order, View, page size and Extension.
    await page.goto(`${bare}?view=grid`);
    await openDialog();
    for (const [id, label] of [
      ['asset-sort-filter', 'File size'],
      ['asset-order-filter', 'Descending'],
      ['asset-view-filter-dropdown', 'List'],
      ['page-size-dropdown', '10'],
      ['asset-extension-filter', '.png'],
    ]) {
      await pick(id, label);
      await settledRegion();
    }
    await dialog.getByRole('button', { name: 'Save new defaults', exact: true }).click();
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'saved');
    await settledRegion();
    const savedPosts = posts.length;
    // An acknowledged Save synchronizes browser sizes; from here only Resets run until the next Save.
    const sizesBefore = await storedSizes();

    // 1/3/4. Several simultaneous filters, explicit Select all, other Sort, View and page size.
    for (const [id, label] of [
      ['asset-sort-filter', 'Filename'],
      ['asset-order-filter', 'Ascending'],
      ['asset-view-filter-dropdown', 'Grid'],
      ['page-size-dropdown', '25'],
      ['asset-presence-filter', 'Present at last scan'],
      ['asset-usage-filter', 'Not used by a release'],
      ['asset-tag-filter', 'Alpha'],
      ['asset-extension-filter', 'Select all'],
    ]) {
      await pick(id, label);
      await settledRegion();
    }
    // Select all is the explicit unrestricted choice over the inherited .png.
    expect(await checked('extension')).toEqual([]);
    expect(params().getAll('extension').filter((value) => value !== 'all')).toEqual([]);
    expect(params().get('inheritedFilterDefaults') || '').not.toContain('extension');
    expect(await checked('tag')).toEqual([String(f.tagIds.Alpha)]);
    await page.locator('#search').fill('p');
    await expect.poll(() => params().get('search')).toBe('p');
    await settledRegion();

    await resetFilters.click();
    await expectRestored(RESTORED_GLOBAL);
    expect(resetRequests.at(-1)).toEqual({ method: 'GET', search: '?resetFilters=1' });
    expect(posts).toHaveLength(savedPosts);

    // 6. From page 2, Reset returns to page 1.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await region.locator('.pagination a', { hasText: /next/i }).first().click();
    await settledRegion();
    expect(params().get('page')).toBe('2');
    await openDialog();
    await resetFilters.click();
    await expectRestored(RESTORED_GLOBAL);

    // 5a. Pending List-to-Grid: the saved List wins and the late Grid load never installs.
    let held = await holdNext((url) => url.searchParams.get('view') === 'grid' && !url.searchParams.has('resetFilters'));
    await pick('asset-view-filter-dropdown', 'Grid');
    await held.seen;
    await expect(page.locator('#asset-view-filter')).toHaveValue('grid');
    await resetFilters.click();
    await expectRestored(RESTORED_GLOBAL);
    expect(resetRequests.at(-1).search).toBe('?resetFilters=1');
    held.release();
    await page.waitForTimeout(500);
    await expect(region.locator('.asset-list--project')).toBeVisible();
    await expect(page.locator('#asset-view-filter')).toHaveValue('list');
    expect(params().get('view')).not.toBe('grid');

    // 2. Partial Project-only inheritance: only View is overridden (Grid).
    f.app.locals.pageDefaultsService.saveProjectDefault('projectAssets', 'view', 'grid', undefined, { projectId });
    f.app.locals.pageDefaultsService.setPageDefaultScope('projectAssets', 'project', { projectId });
    await page.goto(`${bare}?view=list&sort=filename&order=asc&pageSize=25`);
    await openDialog();
    await expect(dialog.getByRole('radio', { name: 'Project only', exact: true })).toBeChecked();
    const RESTORED_PROJECT = { ...RESTORED_GLOBAL, view: 'grid' };

    // 5b. Pending Grid-to-List from the restored Grid: the Project-only Grid wins;
    // Sort, Order and page size are inherited from Global.
    await resetFilters.click();
    await expectRestored(RESTORED_PROJECT);
    held = await holdNext((url) => url.searchParams.get('view') === 'list' && !url.searchParams.has('resetFilters'));
    await pick('asset-view-filter-dropdown', 'List');
    await held.seen;
    await expect(page.locator('#asset-view-filter')).toHaveValue('list');
    await resetFilters.click();
    await expectRestored(RESTORED_PROJECT);
    held.release();
    await page.waitForTimeout(500);
    await expect(region.locator('.asset-grid')).toBeVisible();
    await expect(page.locator('#asset-view-filter')).toHaveValue('grid');
    expect(f.app.locals.projectPageDefaultRepository.getPageOptions(projectId, 'projectAssets'))
      .toEqual({ view: 'grid' });

    // 7. While Reset owns its request, Save and scope activation are refused; afterwards both work.
    await pick('asset-sort-filter', 'Filename');
    await settledRegion();
    held = await holdNext((url) => url.searchParams.has('resetFilters'));
    await resetFilters.click();
    await held.seen;
    const postsBeforeRefusal = posts.length;
    await dialog.getByRole('button', { name: 'Save new defaults', exact: true }).click();
    await expect(status).toHaveText('Wait for Reset filters to finish before saving.');
    await dialog.getByText('Global', { exact: true }).click();
    await expect(status).toHaveText('Wait for Reset filters to finish before changing the defaults scope.');
    await expect(dialog.getByRole('radio', { name: 'Project only', exact: true })).toBeChecked();
    expect(posts).toHaveLength(postsBeforeRefusal);
    held.release();
    await expectRestored(RESTORED_PROJECT);

    // No Reset filters wrote browser size preferences.
    expect(await storedSizes()).toEqual(sizesBefore);

    // Save captures the restored eligible controls, not the pre-Reset ones.
    await dialog.getByRole('button', { name: 'Save new defaults', exact: true }).click();
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'saved');
    const body = new URLSearchParams(posts.at(-1));
    expect(body.get('scope')).toBe('project');
    expect({ view: body.get('view'), sort: body.get('sort'), order: body.get('order'), pageSize: body.get('pageSize') })
      .toEqual({ view: 'grid', sort: 'size', order: 'desc', pageSize: '10' });
    await settledRegion();

    await dialog.getByText('Global', { exact: true }).click();
    await expect(dialog.getByRole('radio', { name: 'Global', exact: true })).toBeChecked();
    await expect(status).toHaveText('Global defaults loaded.');
    await settledRegion();
    await expect(page.locator('#asset-view-filter')).toHaveValue('list');

    // Reset filters never sent anything but GETs.
    expect(resetRequests.every((request) => request.method === 'GET')).toBe(true);
    expect(pageErrors).toEqual([]);
  } finally {
    await f.close();
  }
});

// Package C: Reset filters also restores Grid style and the Grid/List size
// defaults to the active scope's saved/default values, in the real layout,
// over a different browser-stored size, without writing browser storage or
// defaults; a style or size chosen while the Reset is pending stands.
test('Reset filters restores Grid style and Grid/List sizes without touching browser sizes', async ({ page }) => {
  test.skip(Boolean(process.env.CREATORCRATE_BROWSER_BASE_URL), 'Requires the isolated fixture.');
  const f = await fixture({ many: true });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const [projectId] = f.ids;
  const bare = `${f.baseURL}/projects/${projectId}/assets`;
  const dialog = page.locator('#project-assets-filter-dialog');
  const form = page.locator('#project-assets-defaults-form');
  const region = page.locator('[data-project-assets-live-region]');
  const grid = region.locator('.asset-grid');
  const list = region.locator('.asset-list');
  const resetFilters = dialog.getByRole('button', { name: 'Reset filters', exact: true });
  const save = dialog.getByRole('button', { name: 'Save new defaults', exact: true });
  const settledRegion = () => expect(region).not.toHaveAttribute('aria-busy', 'true');
  const openDialog = async () => {
    if (await dialog.isVisible()) return;
    await page.getByRole('link', { name: 'Filters & Defaults', exact: true }).click();
    await expect(dialog).toBeVisible();
  };
  const closeDialog = async () => {
    await page.keyboard.press('Escape');
    if (await dialog.isVisible()) await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  };
  const pick = async (id, label) => {
    if (await chooseHiddenPresentationField(page, id, label)) return;
    const dropdown = dialog.locator(`#${id}`);
    await dropdown.locator('summary').click();
    await dropdown.locator('label').filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) }).click();
    if (await dropdown.evaluate((node) => node.open)) await dropdown.locator('summary').click();
  };
  const LABELS = { cropped: 'Cropped', uncropped: 'Uncropped', compact: 'Compact', default: 'Default', large: 'Large' };
  const DROPDOWN = {
    gridStyle: 'projectAssets-default-gridStyle-dropdown',
    gridSize: 'projectAssets-default-gridSize-dropdown',
    listSize: 'projectAssets-default-listSize-dropdown',
  };
  const choose = async (key, value) => {
    await pick(DROPDOWN[key], LABELS[value]);
    await settledRegion();
  };
  // Native fields and dropdown summaries agree on each restored value.
  const expectFields = async (values) => {
    for (const [key, value] of Object.entries(values)) {
      await expect(page.locator(`#projectAssets-default-${key}`)).toHaveValue(value);
      await expect(dialog.locator(`#${DROPDOWN[key]} summary`)).toHaveAttribute('aria-label', new RegExp(`${LABELS[value]}$`));
    }
  };
  // Real layout: card width (Grid size), media aspect ratio (Grid style),
  // list thumbnail height (List size).
  const gridLayout = () => grid.evaluate((node) => {
    const card = node.querySelector('.asset-card');
    const media = node.querySelector('.asset-card-media > .asset-card-media-link, .asset-card-media > .asset-card-placeholder');
    return {
      size: node.getAttribute('data-grid-size') || 'default',
      style: node.getAttribute('data-grid-style'),
      cardWidth: Math.round(card.getBoundingClientRect().width),
      aspect: getComputedStyle(media).aspectRatio,
    };
  });
  const listLayout = () => list.first().evaluate((node) => ({
    size: node.getAttribute('data-list-size'),
    thumb: Math.round(node.querySelector('.asset-list-card-media').getBoundingClientRect().height),
  }));
  const stored = () => page.evaluate(() => [
    localStorage.getItem('creatorcrate-asset-grid-size'),
    localStorage.getItem('creatorcrate-asset-list-size'),
  ]);
  const posts = [];
  const resetRequests = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() === 'POST' && url.pathname.includes('/assets/defaults')) posts.push(request.postData());
    if (url.searchParams.has('resetFilters')) resetRequests.push(request.method());
  });
  const holdNextReset = async () => {
    let release;
    let seenResolve;
    const released = new Promise((resolve) => { release = resolve; });
    const seen = new Promise((resolve) => { seenResolve = resolve; });
    await page.route((url) => url.pathname === `/projects/${projectId}/assets` && url.searchParams.has('resetFilters'), async (route) => {
      seenResolve();
      await released;
      await route.continue().catch(() => {});
    }, { times: 1 });
    return { seen, release };
  };
  const resetAndSettle = async () => {
    const before = resetRequests.length;
    await resetFilters.click();
    await expect.poll(() => resetRequests.length).toBeGreaterThan(before);
    await settledRegion();
  };

  try {
    // 1. Global saved defaults: Cropped, Compact, Compact.
    await page.goto(`${bare}?view=grid`);
    await openDialog();
    await choose('gridStyle', 'cropped');
    await choose('gridSize', 'compact');
    await choose('listSize', 'compact');
    await save.click();
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'saved');
    await settledRegion();
    const savedPosts = posts.length;

    // 4. The browser now prefers Large for both; a reload shows them.
    await page.evaluate(() => {
      localStorage.setItem('creatorcrate-asset-grid-size', 'large');
      localStorage.setItem('creatorcrate-asset-list-size', 'large');
    });
    await page.goto(`${bare}?view=grid`);
    const browserLarge = await gridLayout();
    expect(browserLarge).toMatchObject({ size: 'large', style: 'cropped', aspect: '1 / 1' });

    // 5. Older unsaved previews: Uncropped, Default, Large.
    await openDialog();
    await choose('gridStyle', 'uncropped');
    await choose('gridSize', 'default');
    await choose('listSize', 'large');
    const previewed = await gridLayout();
    expect(previewed).toMatchObject({ size: 'default', style: 'uncropped' });
    expect(previewed.aspect).not.toBe('1 / 1');

    await resetAndSettle();
    await expect.poll(async () => (await gridLayout()).size).toBe('compact');
    const restored = await gridLayout();
    expect(restored).toMatchObject({ size: 'compact', style: 'cropped', aspect: '1 / 1' });
    expect(restored.cardWidth).toBeLessThan(previewed.cardWidth);
    expect(restored.cardWidth).toBeLessThan(browserLarge.cardWidth);
    await expectFields({ gridStyle: 'cropped', gridSize: 'compact', listSize: 'compact' });
    expect(await stored()).toEqual(['large', 'large']);
    expect(posts).toHaveLength(savedPosts);

    // The inactive List view takes the restored List size when it renders,
    // and a later ordinary GET and a reopen keep all three.
    await pick('asset-view-filter-dropdown', 'List');
    await settledRegion();
    await expect(list.first()).toBeVisible();
    const listCompact = await listLayout();
    expect(listCompact.size).toBe('compact');
    await closeDialog();
    await openDialog();
    await expectFields({ gridStyle: 'cropped', gridSize: 'compact', listSize: 'compact' });

    // Reset with List active: a List size preview of Large is replaced.
    await choose('listSize', 'large');
    const listLarge = await listLayout();
    expect(listLarge.size).toBe('large');
    expect(listLarge.thumb).toBeGreaterThan(listCompact.thumb);
    await resetAndSettle();
    // Reset restores the saved View (Grid); the List size waits for List.
    await expect(grid).toBeVisible();
    await pick('asset-view-filter-dropdown', 'List');
    await settledRegion();
    await expect(list.first()).toBeVisible();
    expect(await listLayout()).toEqual(listCompact);
    await pick('asset-view-filter-dropdown', 'Grid');
    await settledRegion();
    await expect(grid).toBeVisible();
    expect(await gridLayout()).toMatchObject({ size: 'compact', style: 'cropped' });
    expect(await stored()).toEqual(['large', 'large']);

    // 6. Async ownership: a Grid size chosen while Reset is pending stands;
    // the older style and List size previews are restored.
    await choose('gridStyle', 'uncropped');
    await choose('listSize', 'large');
    const held = await holdNextReset();
    await resetFilters.click();
    await held.seen;
    await pick(DROPDOWN.gridSize, 'Large');
    held.release();
    await expect.poll(async () => (await gridLayout()).style).toBe('cropped');
    await settledRegion();
    expect(await gridLayout()).toMatchObject({ size: 'large', style: 'cropped', aspect: '1 / 1' });
    await expectFields({ gridStyle: 'cropped', gridSize: 'large', listSize: 'compact' });
    expect(await stored()).toEqual(['large', 'large']);

    // 2. Project only overrides Grid style (Uncropped); sizes inherit Global.
    f.app.locals.pageDefaultsService.saveProjectDefault('projectAssets', 'gridStyle', 'uncropped', undefined, { projectId });
    f.app.locals.pageDefaultsService.setPageDefaultScope('projectAssets', 'project', { projectId });
    await page.goto(`${bare}?view=grid`);
    await openDialog();
    await expect(dialog.getByRole('radio', { name: 'Project only', exact: true })).toBeChecked();
    await choose('gridStyle', 'cropped');
    await choose('gridSize', 'default');
    await choose('listSize', 'large');
    await resetAndSettle();
    await expect.poll(async () => (await gridLayout()).style).toBe('uncropped');
    expect(await gridLayout()).toMatchObject({ size: 'compact', style: 'uncropped' });
    await expectFields({ gridStyle: 'uncropped', gridSize: 'compact', listSize: 'compact' });
    expect(await stored()).toEqual(['large', 'large']);
    expect(posts).toHaveLength(savedPosts);

    // 9. Save after Reset sends the restored presentation.
    await save.click();
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'saved');
    const body = new URLSearchParams(posts.at(-1));
    expect(body.get('scope')).toBe('project');
    expect({ gridStyle: body.get('gridStyle'), gridSize: body.get('gridSize'), listSize: body.get('listSize') })
      .toEqual({ gridStyle: 'uncropped', gridSize: 'compact', listSize: 'compact' });
    expect(posts).toHaveLength(savedPosts + 1);
    expect(resetRequests.every((method) => method === 'GET')).toBe(true);
    expect(pageErrors).toEqual([]);
  } finally {
    await f.close();
  }
});

// M2 F11–F13 integration corrections. One harness per tab: the combined
// dialog's presentation fields, the rendered grid/list, Reset filters GETs,
// defaults POSTs and every browser size-preference write.
async function presentationHarness(page, projectId) {
  await page.addInitScript(() => {
    window.__sizeWrites = [];
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItemSpy(key, value) {
      if (String(key).startsWith('creatorcrate-asset-')) window.__sizeWrites.push([key, value]);
      return setItem.call(this, key, value);
    };
  });
  const dialog = page.locator('#project-assets-filter-dialog');
  const form = page.locator('#project-assets-defaults-form');
  const region = page.locator('[data-project-assets-live-region]');
  const LABELS = {
    cropped: 'Cropped', uncropped: 'Uncropped', compact: 'Compact', default: 'Default', large: 'Large',
  };
  const DROPDOWN = {
    gridStyle: 'projectAssets-default-gridStyle-dropdown',
    gridSize: 'projectAssets-default-gridSize-dropdown',
    listSize: 'projectAssets-default-listSize-dropdown',
  };
  const h = {
    dialog,
    form,
    region,
    grid: region.locator('.asset-grid'),
    list: region.locator('.asset-list'),
    loadedScope: form.locator('input[name="loadedScope"]'),
    indicator: form.locator('[data-project-assets-defaults-indicator]'),
    resetFilters: dialog.getByRole('button', { name: 'Reset filters', exact: true }),
    save: dialog.getByRole('button', { name: 'Save new defaults', exact: true }),
    retry: page.locator('[data-live-filter-retry]'),
    posts: [],
    resetGets: [],
    settled: () => expect(region).not.toHaveAttribute('aria-busy', 'true'),
  };
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() === 'POST' && url.pathname.includes('/assets/defaults')) h.posts.push(request.postData());
    if (url.searchParams.has('resetFilters')) h.resetGets.push(request.method());
  });
  h.open = async () => {
    if (await dialog.isVisible()) return;
    await page.getByRole('link', { name: 'Filters & Defaults', exact: true }).click();
    await expect(dialog).toBeVisible();
  };
  h.dropdown = (key) => dialog.locator(`#${DROPDOWN[key]}`);
  h.closeDropdown = async (key) => {
    if (await h.dropdown(key).evaluate((node) => node.open)) await h.dropdown(key).locator('summary').click();
  };
  // A pointer choice of an option (the shown one, or another).
  h.choose = async (key, value) => {
    if (await chooseHiddenPresentationField(page, DROPDOWN[key], LABELS[value])) return;
    const dropdown = h.dropdown(key);
    await dropdown.locator('summary').click();
    await dropdown.locator('label').filter({ hasText: new RegExp(`^\\s*${LABELS[value]}\\s*$`) }).click();
    await h.closeDropdown(key);
  };
  // Real Chromium Space on the checked option.
  h.spaceOnShown = async (key, value) => {
    const dropdown = h.dropdown(key);
    await dropdown.locator('summary').click();
    const shown = dropdown.locator('input[type="radio"]:checked');
    await expect(shown).toHaveValue(value);
    await shown.focus();
    await page.keyboard.press(' ');
    await expect(shown).toBeChecked();
    await h.closeDropdown(key);
  };
  // Native field, dropdown summary and checked option agree on each value.
  h.expectFields = async (values) => {
    for (const [key, value] of Object.entries(values)) {
      await expect(page.locator(`#projectAssets-default-${key}`)).toHaveValue(value);
      await expect(h.dropdown(key).locator('summary')).toHaveAttribute('aria-label', new RegExp(`${LABELS[value]}$`));
      await expect(h.dropdown(key).locator('input[type="radio"]:checked')).toHaveValue(value);
    }
  };
  h.gridLayout = () => h.grid.evaluate((node) => {
    const media = node.querySelector('.asset-card-media > .asset-card-media-link, .asset-card-media > .asset-card-placeholder');
    return {
      size: node.getAttribute('data-grid-size') || 'default',
      style: node.getAttribute('data-grid-style'),
      aspect: getComputedStyle(media).aspectRatio,
    };
  });
  h.listSize = () => h.list.first().getAttribute('data-list-size');
  h.sizeWrites = () => page.evaluate(() => window.__sizeWrites.slice());
  h.saveAndSettle = async () => {
    const response = page.waitForResponse((r) => r.request().method() === 'POST'
      && new URL(r.url()).pathname.endsWith('/assets/defaults'));
    await h.save.click();
    expect((await response).status()).toBeLessThan(400);
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'saved');
    await h.settled();
    return new URLSearchParams(h.posts.at(-1));
  };
  const resetRoute = (url) => url.pathname === `/projects/${projectId}/assets` && url.searchParams.has('resetFilters');
  // Holds the next Reset filters GET until released.
  h.holdNextReset = async () => {
    let release;
    let seenResolve;
    const released = new Promise((resolve) => { release = resolve; });
    const seen = new Promise((resolve) => { seenResolve = resolve; });
    await page.route(resetRoute, async (route) => {
      seenResolve();
      await released;
      await route.continue().catch(() => {});
    }, { times: 1 });
    return { seen, release };
  };
  // Fails the next `count` Reset filters GETs.
  h.failResets = async (count) => {
    await page.route(resetRoute, (route) => route.abort('failed'), { times: count });
  };
  return h;
}

test('F11: re-choosing the shown Grid style during a held Reset keeps it, by pointer and by Space', async ({ page }) => {
  test.skip(Boolean(process.env.CREATORCRATE_BROWSER_BASE_URL), 'Requires the isolated fixture.');
  test.setTimeout(150_000);
  const f = await fixture();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const [projectId] = f.ids;
  const h = await presentationHarness(page, projectId);
  // Re-choosing the shown style during a held Reset, then releasing it.
  const heldReset = async (rechoose) => {
    const held = await h.holdNextReset();
    const before = h.resetGets.length;
    await h.resetFilters.click();
    await held.seen;
    if (rechoose) await rechoose();
    held.release();
    await expect.poll(() => h.resetGets.length).toBe(before + 1);
    await h.settled();
  };

  try {
    // Global saved Grid style: Cropped. Shown, unsaved: Uncropped.
    f.app.locals.pageDefaultsService.saveDefault('projectAssets', 'gridStyle', 'cropped');
    await page.goto(`${f.baseURL}/projects/${projectId}/assets?view=grid`);
    await h.open();
    await h.expectFields({ gridStyle: 'cropped' });
    await h.choose('gridStyle', 'uncropped');
    await expect.poll(async () => (await h.gridLayout()).style).toBe('uncropped');

    // Control: an untouched Grid style is restored by a held Reset.
    await heldReset(null);
    await expect.poll(async () => (await h.gridLayout()).style).toBe('cropped');
    await h.expectFields({ gridStyle: 'cropped' });

    // F11-B: real Chromium Space on the checked Uncropped while Reset is held.
    await h.choose('gridStyle', 'uncropped');
    await heldReset(() => h.spaceOnShown('gridStyle', 'uncropped'));
    expect(await h.gridLayout()).toMatchObject({ style: 'uncropped' });
    expect((await h.gridLayout()).aspect).not.toBe('1 / 1');
    await h.expectFields({ gridStyle: 'uncropped' });

    // F11-A: pointer choice of the checked Uncropped while Reset is held.
    await heldReset(() => h.choose('gridStyle', 'uncropped'));
    expect(await h.gridLayout()).toMatchObject({ style: 'uncropped' });
    await h.expectFields({ gridStyle: 'uncropped' });

    // F11-C: a different style chosen during the held Reset also stands.
    await heldReset(async () => {
      await h.choose('gridStyle', 'cropped');
      await h.choose('gridStyle', 'uncropped');
    });
    await h.expectFields({ gridStyle: 'uncropped' });
    expect(h.posts).toHaveLength(0);
    expect(h.resetGets).toEqual(['GET', 'GET', 'GET', 'GET']);

    // The next Save sends what the grid shows.
    const body = await h.saveAndSettle();
    expect([body.get('scope'), body.get('gridStyle')]).toEqual(['global', 'uncropped']);
    expect(h.posts).toHaveLength(1);
    expect(f.app.locals.pageDefaultsService.getSavedDefault('projectAssets', 'gridStyle')).toBe('uncropped');
    expect(pageErrors).toEqual([]);
  } finally {
    await f.close();
  }
});

test('F12: a shown Grid or List size re-chosen after a failed Reset survives failed Retries', async ({ page }) => {
  test.skip(Boolean(process.env.CREATORCRATE_BROWSER_BASE_URL), 'Requires the isolated fixture.');
  test.setTimeout(180_000);
  const f = await fixture();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const [projectId] = f.ids;
  const h = await presentationHarness(page, projectId);
  const pds = f.app.locals.pageDefaultsService;
  // Reset fails `failures` times (the click, then each Retry but the last);
  // `between` runs after the first failure; the final Retry installs.
  const failingReset = async (failures, between) => {
    await h.failResets(failures);
    const before = h.resetGets.length;
    await h.resetFilters.click();
    await expect(h.retry).toBeVisible();
    await between();
    for (let attempt = 1; attempt < failures; attempt += 1) {
      await h.retry.click();
      await expect.poll(() => h.resetGets.length).toBe(before + attempt + 1);
      await expect(h.retry).toBeVisible();
    }
    await h.retry.click();
    await expect(h.retry).toBeHidden();
    await h.settled();
    expect(h.resetGets.length).toBe(before + failures + 1);
  };

  try {
    // Global saved: Grid view, Grid size Compact, List size Compact.
    pds.saveDefault('projectAssets', 'gridSize', 'compact');
    pds.saveDefault('projectAssets', 'listSize', 'compact');
    await page.goto(`${f.baseURL}/projects/${projectId}/assets?view=list`);
    await h.open();
    await h.expectFields({ gridSize: 'compact', listSize: 'compact' });
    await h.choose('gridSize', 'large');
    await h.choose('listSize', 'large');
    await expect.poll(() => h.listSize()).toBe('large');
    const writesBefore = (await h.sizeWrites()).length;

    // F12-A: pointer re-choice of the shown List size between failures;
    // two failed attempts, then success. Untouched Grid size is restored.
    await failingReset(2, () => h.choose('listSize', 'large'));
    await h.expectFields({ listSize: 'large', gridSize: 'compact' });
    // Reset restores the saved View (Grid); the List size waits for List.
    await expect(h.grid).toBeVisible();
    expect((await h.gridLayout()).size).toBe('compact');

    // F12-B: real Space on the shown Grid size between failures, three
    // failed attempts; untouched List size (previewed Compact here) restores.
    await h.choose('gridSize', 'large');
    await h.choose('listSize', 'large');
    await failingReset(3, () => h.spaceOnShown('gridSize', 'large'));
    await h.expectFields({ gridSize: 'large', listSize: 'compact' });
    expect((await h.gridLayout()).size).toBe('large');
    expect(h.posts).toHaveLength(0);
    expect((await h.sizeWrites()).length).toBe(writesBefore);

    // F12-C: a new Reset after a failed one is its own boundary.
    await h.failResets(1);
    await h.resetFilters.click();
    await expect(h.retry).toBeVisible();
    await h.choose('listSize', 'large');
    const fresh = h.resetGets.length;
    await h.resetFilters.click();
    await expect.poll(() => h.resetGets.length).toBe(fresh + 1);
    await h.settled();
    await h.expectFields({ gridSize: 'compact', listSize: 'compact' });

    // F12-D: newer navigation supersedes the failed Reset and its Retry.
    await h.failResets(1);
    await h.resetFilters.click();
    await expect(h.retry).toBeVisible();
    await h.choose('listSize', 'large');
    await h.choose('listSize', 'large');
    const sortDropdown = h.dialog.locator('#asset-sort-filter');
    await sortDropdown.locator('summary').click();
    await sortDropdown.locator('label').filter({ hasText: /^\s*File size\s*$/ }).click();
    await h.settled();
    await expect(h.retry).toBeHidden();
    await h.expectFields({ listSize: 'large' });

    // The next Save sends the shown sizes; no Reset ever POSTed or stored sizes.
    const body = await h.saveAndSettle();
    expect([body.get('scope'), body.get('gridSize'), body.get('listSize')]).toEqual(['global', 'compact', 'large']);
    expect(h.posts).toHaveLength(1);
    expect(h.resetGets.every((method) => method === 'GET')).toBe(true);
    expect(pageErrors).toEqual([]);
  } finally {
    await f.close();
  }
});

test('F13: a Reset answered under a scope another tab activated adopts that scope before Save', async ({ page, context }) => {
  test.skip(Boolean(process.env.CREATORCRATE_BROWSER_BASE_URL), 'Requires the isolated fixture.');
  test.setTimeout(180_000);
  const f = await fixture();
  const pageErrors = [];
  const tabB = await context.newPage();
  [page, tabB].forEach((tab) => tab.on('pageerror', (error) => pageErrors.push(error.message)));
  await page.setViewportSize({ width: 1280, height: 900 });
  await tabB.setViewportSize({ width: 1280, height: 900 });
  const [projectId] = f.ids;
  const pds = f.app.locals.pageDefaultsService;
  const context_ = { projectId };
  const a = await presentationHarness(page, projectId);
  const b = await presentationHarness(tabB, projectId);
  const bare = `${f.baseURL}/projects/${projectId}/assets`;
  const serverScope = () => pds.getPageDefaultScope('projectAssets', context_);
  const globalSaved = () => ['view', 'gridStyle', 'gridSize', 'listSize']
    .map((option) => pds.getSavedDefault('projectAssets', option));
  const activateIn = async (h, tab, label, scope) => {
    const response = tab.waitForResponse((r) => r.request().method() === 'POST'
      && new URL(r.url()).pathname.endsWith('/assets/defaults'));
    await h.dialog.getByText(label, { exact: true }).click();
    expect((await response).status()).toBe(200);
    await expect(h.loadedScope).toHaveValue(scope);
    await h.settled();
  };

  try {
    // Global: List, Cropped, Compact/Compact. Project only: Grid, Uncropped, Large/Large.
    pds.saveDefault('projectAssets', 'view', 'list');
    pds.saveDefault('projectAssets', 'gridStyle', 'cropped');
    pds.saveDefault('projectAssets', 'gridSize', 'compact');
    pds.saveDefault('projectAssets', 'listSize', 'compact');
    for (const [option, value] of [['view', 'grid'], ['gridStyle', 'uncropped'], ['gridSize', 'large'], ['listSize', 'large']]) {
      pds.saveProjectDefault('projectAssets', option, value, undefined, context_);
    }
    pds.setPageDefaultScope('projectAssets', 'global', context_);
    const globalBefore = globalSaved();
    expect(globalBefore).toEqual(['list', 'cropped', 'compact', 'compact']);

    // Tab A: Global active, List view.
    await page.goto(bare);
    await a.open();
    await expect(a.loadedScope).toHaveValue('global');
    await expect(a.list.first()).toBeVisible();
    await expect(a.indicator).toHaveText(/^Using Global/);

    // 1. Tab A's Reset GET is held.
    const held = await a.holdNextReset();
    await a.resetFilters.click();
    await held.seen;

    // 2–3. Tab B activates Project only; the server accepts it.
    await tabB.goto(bare);
    await b.open();
    await activateIn(b, tabB, 'Project only', 'project');
    expect(serverScope()).toBe('project');

    // 4. Tab A's Reset answers with the server's Project-only page.
    held.release();
    await expect.poll(() => a.resetGets.length).toBe(1);
    await a.settled();
    await expect(a.loadedScope).toHaveValue('project');
    await expect(a.dialog.getByRole('radio', { name: 'Project only', exact: true })).toBeChecked();
    await expect(a.dialog.getByRole('radio', { name: 'Global', exact: true })).not.toBeChecked();
    await expect(a.indicator).toHaveText(/^Using Project only/);
    await expect(a.form.locator('[data-settings-fetch-save-status]')).toHaveText('Project-only defaults are active.');
    // One scope, not a mixture: Project only's View, style and sizes.
    await expect(a.grid).toBeVisible();
    await expect.poll(async () => (await a.gridLayout()).style).toBe('uncropped');
    expect(await a.gridLayout()).toMatchObject({ size: 'large', style: 'uncropped' });
    await a.expectFields({ gridStyle: 'uncropped', gridSize: 'large', listSize: 'large' });
    await expect(page.locator('#asset-view-filter')).toHaveValue('grid');
    // No POST, no activation, no size write, and Global is untouched.
    expect(a.posts).toHaveLength(0);
    expect(await a.sizeWrites()).toEqual([]);
    expect(globalSaved()).toEqual(globalBefore);
    expect(serverScope()).toBe('project');

    // 5. Save targets Project only with the shown values; Global stays.
    await a.choose('gridStyle', 'cropped');
    const body = await a.saveAndSettle();
    expect([body.get('intent'), body.get('scope'), body.get('loadedScope'), body.get('view'), body.get('gridStyle')])
      .toEqual(['save', 'project', 'project', 'grid', 'cropped']);
    expect(a.posts).toHaveLength(1);
    expect(serverScope()).toBe('project');
    expect(globalSaved()).toEqual(globalBefore);
    expect(pds.resolveProjectPageDefaults('projectAssets', {}, context_).gridStyle).toBe('cropped');

    // 7. A superseded Reset's late answer cannot reverse newer authority.
    const writesBeforeStale = (await a.sizeWrites()).length;
    const first = await a.holdNextReset();
    await a.resetFilters.click();
    await first.seen;
    const second = await a.holdNextReset();
    await a.resetFilters.click();
    await second.seen;
    await activateIn(b, tabB, 'Global', 'global');
    second.release();
    await expect(a.loadedScope).toHaveValue('global');
    await a.settled();
    await activateIn(b, tabB, 'Project only', 'project');
    first.release();
    await a.settled();
    await expect(a.loadedScope).toHaveValue('global');
    await expect(a.indicator).toHaveText(/^Using Global/);
    await a.expectFields({ gridStyle: 'cropped', gridSize: 'compact', listSize: 'compact' });
    expect(a.posts).toHaveLength(1);
    expect((await a.sizeWrites()).length).toBe(writesBeforeStale);
    expect(globalSaved()).toEqual(globalBefore);

    // Ordinary single-tab Reset and explicit scope switching still work.
    await page.goto(bare);
    await a.open();
    await expect(a.loadedScope).toHaveValue('project');
    await activateIn(a, page, 'Global', 'global');
    expect(serverScope()).toBe('global');
    await activateIn(a, page, 'Project only', 'project');
    expect(serverScope()).toBe('project');
    expect(globalSaved()).toEqual(globalBefore);
    await a.choose('gridSize', 'compact');
    const before = a.resetGets.length;
    await a.resetFilters.click();
    await expect.poll(() => a.resetGets.length).toBe(before + 1);
    await a.settled();
    await expect(a.loadedScope).toHaveValue('project');
    await a.expectFields({ gridStyle: 'cropped', gridSize: 'large', listSize: 'large' });
    expect(pageErrors).toEqual([]);
  } finally {
    await tabB.close().catch(() => {});
    await f.close();
  }
});

test('F14: a Reset that adopted another tab\'s scope but failed to install refuses Save until a Retry installs', async ({ page, context }) => {
  test.skip(Boolean(process.env.CREATORCRATE_BROWSER_BASE_URL), 'Requires the isolated fixture.');
  test.setTimeout(180_000);
  const f = await fixture();
  const pageErrors = [];
  const tabB = await context.newPage();
  [page, tabB].forEach((tab) => tab.on('pageerror', (error) => pageErrors.push(error.message)));
  await page.setViewportSize({ width: 1280, height: 900 });
  await tabB.setViewportSize({ width: 1280, height: 900 });
  const [projectId] = f.ids;
  const pds = f.app.locals.pageDefaultsService;
  const context_ = { projectId };
  const a = await presentationHarness(page, projectId);
  const b = await presentationHarness(tabB, projectId);
  const bare = `${f.baseURL}/projects/${projectId}/assets`;
  const serverScope = () => pds.getPageDefaultScope('projectAssets', context_);
  const globalSaved = () => ['view', 'gridStyle', 'gridSize', 'listSize']
    .map((option) => pds.getSavedDefault('projectAssets', option));
  const projectResolved = () => {
    const resolved = pds.resolveProjectPageDefaults('projectAssets', {}, context_);
    return ['view', 'gridStyle', 'gridSize', 'listSize'].map((option) => resolved[option]);
  };
  const status = a.form.locator('[data-settings-fetch-save-status]');
  const INCOMPLETE = 'Reset filters did not finish loading the active defaults. Retry it, or use Reset filters again, before saving.';
  // Every Save entry path: pointer, keyboard and requestSubmit.
  const attemptSaves = async () => {
    await a.save.click();
    await a.save.focus();
    await page.keyboard.press('Enter');
    await a.form.evaluate((form) => form.requestSubmit());
    await expect(status).toHaveText(INCOMPLETE);
  };

  try {
    // Global: List, Cropped, Compact/Compact. Project only: Grid, Uncropped, Large/Large.
    pds.saveDefault('projectAssets', 'view', 'list');
    pds.saveDefault('projectAssets', 'gridStyle', 'cropped');
    pds.saveDefault('projectAssets', 'gridSize', 'compact');
    pds.saveDefault('projectAssets', 'listSize', 'compact');
    for (const [option, value] of [['view', 'grid'], ['gridStyle', 'uncropped'], ['gridSize', 'large'], ['listSize', 'large']]) {
      pds.saveProjectDefault('projectAssets', option, value, undefined, context_);
    }
    pds.setPageDefaultScope('projectAssets', 'global', context_);
    const globalBefore = globalSaved();
    expect(globalBefore).toEqual(['list', 'cropped', 'compact', 'compact']);
    const projectBefore = projectResolved();
    expect(projectBefore).toEqual(['grid', 'uncropped', 'large', 'large']);

    // Tab A: Global active, List view.
    await page.goto(bare);
    await a.open();
    await expect(a.loadedScope).toHaveValue('global');
    await expect(a.list.first()).toBeVisible();
    // Arms one failure of the live-region replacement, injected after this
    // tab has processed the prepared Reset response (adopted its scope).
    await page.evaluate(() => {
      document.addEventListener('project-assets-filters-reset', (event) => {
        if (event.detail?.phase !== 'prepared' || !window.__f14ArmInstallFailure) return;
        window.__f14ArmInstallFailure = false;
        const replaceWith = Element.prototype.replaceWith;
        Element.prototype.replaceWith = function failOnce(...nodes) {
          if (this.matches?.('[data-project-assets-live-region]')) {
            Element.prototype.replaceWith = replaceWith;
            window.__f14InstallFailures = (window.__f14InstallFailures || 0) + 1;
            throw new Error('F14 injected install failure');
          }
          return replaceWith.apply(this, nodes);
        };
      });
      window.__f14ArmInstallFailure = true;
    });

    // 1. Tab A's Reset GET is held.
    const held = await a.holdNextReset();
    await a.resetFilters.click();
    await held.seen;

    // 2–3. Tab B activates Project only; the server accepts it.
    await tabB.goto(bare);
    await b.open();
    const activated = tabB.waitForResponse((r) => r.request().method() === 'POST'
      && new URL(r.url()).pathname.endsWith('/assets/defaults'));
    await b.dialog.getByText('Project only', { exact: true }).click();
    expect((await activated).status()).toBe(200);
    await expect(b.loadedScope).toHaveValue('project');
    expect(serverScope()).toBe('project');

    // 4–5. Tab A's valid Reset response is prepared, then its install fails.
    held.release();
    await expect.poll(() => a.resetGets.length).toBe(1);
    await expect(a.retry).toBeVisible();
    await a.settled();
    expect(await page.evaluate(() => window.__f14InstallFailures)).toBe(1);
    // The reviewer's state: Project only adopted, presentation still stale.
    await expect(a.loadedScope).toHaveValue('project');
    await expect(a.list.first()).toBeVisible();
    await a.expectFields({ gridStyle: 'cropped', gridSize: 'compact', listSize: 'compact' });

    // 6. Save is refused on every entry path, before any defaults POST.
    await attemptSaves();
    expect(a.posts).toHaveLength(0);

    // A failed GET-only Retry keeps Save refused.
    await a.failResets(1);
    await a.retry.click();
    await expect.poll(() => a.resetGets.length).toBe(2);
    await expect(a.retry).toBeVisible();
    await a.settled();
    await attemptSaves();
    expect(a.posts).toHaveLength(0);

    // A successful GET-only Retry installs coherent Project-only state.
    await a.retry.click();
    await expect(a.retry).toBeHidden();
    await a.settled();
    expect(a.resetGets).toEqual(['GET', 'GET', 'GET']);
    await expect(status).toHaveText('Project-only defaults are active.');
    await expect(a.loadedScope).toHaveValue('project');
    await expect(a.dialog.getByRole('radio', { name: 'Project only', exact: true })).toBeChecked();
    await expect(a.indicator).toHaveText(/^Using Project only/);
    await expect(a.grid).toBeVisible();
    await expect(page.locator('#asset-view-filter')).toHaveValue('grid');
    await expect.poll(async () => (await a.gridLayout()).style).toBe('uncropped');
    expect(await a.gridLayout()).toMatchObject({ size: 'large', style: 'uncropped' });
    expect((await a.gridLayout()).aspect).not.toBe('1 / 1');
    await a.expectFields({ gridStyle: 'uncropped', gridSize: 'large', listSize: 'large' });
    const snapshots = JSON.parse(await a.form.locator('[data-project-assets-default-values]').textContent());
    expect([snapshots.project.view, snapshots.project.gridStyle, snapshots.project.gridSize, snapshots.project.listSize])
      .toEqual(projectBefore);
    expect(a.posts).toHaveLength(0);
    expect(await a.sizeWrites()).toEqual([]);

    // 7. Save is allowed and posts the Project-only values; Global unchanged.
    const body = await a.saveAndSettle();
    expect(['intent', 'scope', 'loadedScope', 'view', 'gridStyle', 'gridSize', 'listSize'].map((key) => body.get(key)))
      .toEqual(['save', 'project', 'project', 'grid', 'uncropped', 'large', 'large']);
    expect(a.posts).toHaveLength(1);
    expect(a.posts.some((post) => new URLSearchParams(post).get('intent') === 'activate-scope')).toBe(false);
    expect(serverScope()).toBe('project');
    expect(globalSaved()).toEqual(globalBefore);
    expect(projectResolved()).toEqual(projectBefore);
    expect(pageErrors).toEqual([]);
  } finally {
    await tabB.close().catch(() => {});
    await f.close();
  }
});
