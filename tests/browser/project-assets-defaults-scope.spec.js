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

// External runs intentionally edit defaults for two explicitly named projects.
// Without these environment variables all data is isolated and removed afterward.
async function fixture() {
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
      app.locals.assetScanner.scanProjectAssets(project.id);
    }
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    return { baseURL: `http://127.0.0.1:${server.address().port}`, ids, finalCategoryIds, close };
  } catch (error) {
    await close();
    throw error;
  }
}

test('scope-only toggles live-refresh once, survive reloads, and preserve both projects', async ({ page, context }) => {
  const f = await fixture();
  const b = await context.newPage();
  const dialog = (p) => p.locator('#project-assets-defaults-dialog');
  const form = (p) => p.locator('#project-assets-defaults-form');
  const snapshots = (p) => form(p).locator('[data-project-assets-default-values]')
    .evaluate((el) => JSON.parse(el.textContent));
  const open = async (p, id) => {
    await p.goto(`${f.baseURL}/projects/${id}/assets`);
    await p.getByRole('link', { name: 'Project Assets defaults', exact: true }).click();
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
      expect((await saved).status()).toBe(302);
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
    const dropdown = dialog(p).locator(`#projectAssets-default-${key}-dropdown`);
    if ((await dropdown.locator('summary').getAttribute('aria-label')).endsWith(`: ${label}`)) return;
    await dropdown.locator('summary').click();
    await mutate(p, () => dropdown.locator('label').filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) }).click());
  };
  const effective = async (p, view, sort) => {
    await expect(p.locator(`[data-project-assets-live-region] .asset-${view}`)).toHaveCount(1);
    expect(new URL(p.url()).searchParams.get('sort') || 'filename').toBe(sort);
  };
  const reload = async (p, active, view, sort) => {
    await p.reload();
    await effective(p, view, sort);
    await p.getByRole('link', { name: 'Project Assets defaults', exact: true }).click();
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
    await dialog(page).getByRole('button', { name: 'Close Project Assets defaults' }).click();
    await page.getByRole('link', { name: 'Project Assets defaults', exact: true }).click();
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
        await dialog(page).getByRole('button', { name: 'Close Project Assets defaults' }).click();
        await page.getByRole('link', { name: 'Project Assets defaults', exact: true }).click();
        await expect(form(page).locator('input[name="loadedScope"]')).toHaveValue('project');
        releaseSave();
      });
      await expect(form(page).locator('input[name="loadedScope"]')).toHaveValue('global');
      await expect(dialog(page).getByRole('radio', { name: 'Global', exact: true })).toBeChecked();
      await expect(form(page).locator('[data-dialog-field="view"] select')).toHaveValue('grid');
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
  const dialog = page.locator('#project-assets-defaults-dialog');
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
    await page.getByRole('link', { name: 'Project Assets defaults', exact: true }).click();
    await expect(dialog).toBeVisible();
  };
  const settle = async (action) => {
    const saved = page.waitForResponse((r) => r.request().method() === 'POST'
      && new URL(r.url()).pathname.endsWith('/assets/defaults'));
    await action();
    expect((await saved).status()).toBe(302);
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'saved');
    await expect(page.locator('[data-project-assets-live-region]')).not.toHaveAttribute('aria-busy', 'true');
  };
  const chooseStyle = (value) => settle(() => page.locator('#projectAssets-default-gridStyle')
    .selectOption(value, { force: true }));
  const chooseScope = async (value) => {
    if (await form.locator('input[name="loadedScope"]').inputValue() === value) return;
    await settle(() => dialog.getByText(value === 'global' ? 'Global' : 'Project only', { exact: true }).click());
    await expect(form.locator('input[name="loadedScope"]')).toHaveValue(value);
  };
  const closeDefaults = async () => {
    await dialog.getByRole('button', { name: 'Close Project Assets defaults' }).click();
    await expect(dialog).toBeHidden();
  };

  try {
    const [first, second] = f.ids;
    await page.goto(`${f.baseURL}/projects/${first}/assets?view=grid`);
    await expect(grid).toHaveAttribute('data-grid-style', 'uncropped');
    await expect(wideCard.locator('[data-preview-image]')).toBeVisible();
    await expectWide(wideLink);

    await openDefaults();
    const fieldOrder = await form.locator('[data-dialog-field]')
      .evaluateAll((nodes) => nodes.map((node) => node.dataset.dialogField));
    expect(fieldOrder.slice(0, 3)).toEqual(['view', 'gridStyle', 'gridSize']);
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
  const dialog = page.locator('#project-assets-defaults-dialog');
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
    expect((await saved).status()).toBe(302);
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'saved');
    await expect(region).not.toHaveAttribute('aria-busy', 'true');
  };
  const openDefaults = async () => {
    await page.getByRole('link', { name: 'Project Assets defaults', exact: true }).click();
    await expect(dialog).toBeVisible();
  };
  const closeDefaults = async () => {
    await dialog.getByRole('button', { name: 'Close Project Assets defaults' }).click();
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
    await settle(() => page.locator('#projectAssets-default-gridStyle').selectOption(value, { force: true }));
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

    // A style-only save made in List view leaves List alone and applies on Grid.
    const list = page.locator('.asset-list--project');
    await page.locator('nav.view-switcher a[aria-label$="List view"]').click();
    await expect(list).toBeVisible();
    await list.evaluate((node) => { node.dataset.styleRegressionMarker = 'kept'; });
    await openDefaults();
    await settle(() => page.locator('#projectAssets-default-gridStyle').selectOption('uncropped', { force: true }));
    await closeDefaults();
    await expect(list).toHaveAttribute('data-style-regression-marker', 'kept');
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
  const dialog = page.locator('#project-assets-defaults-dialog');
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
    await page.getByRole('link', { name: 'Project Assets defaults', exact: true }).click();
    await expect(dialog).toBeVisible();
    await page.route(refreshPattern, abortRefresh);
    let response = saved();
    await dialog.getByText('Project only', { exact: true }).click();
    expect((await response).status()).toBe(302);
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'saved-refresh-error');
    await expect(liveStatus).toHaveText(
      'Defaults were saved, but Project Assets could not refresh. Refresh the page to see the saved defaults.',
    );
    await expect(region).toHaveAttribute('data-project-assets-live-state', 'error');
    await page.unroute(refreshPattern, abortRefresh);
    await expect(form.locator('input[name="loadedScope"]')).toHaveValue('project');

    // B. The style-only save restyles in place and clears the obsolete error.
    const loadsBefore = regionLoads.length;
    response = saved();
    await page.locator('#projectAssets-default-gridStyle').selectOption('cropped', { force: true });
    expect((await response).status()).toBe(302);
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'saved');
    await expect(formStatus).toHaveText('Settings saved.');
    await expect(grid).toHaveAttribute('data-grid-style', 'cropped');
    await expect(liveStatus).toHaveText('');
    await expect(region).not.toHaveAttribute('data-project-assets-live-state', /.*/);
    expect(regionLoads.slice(loadsBefore)).toEqual([]);

    // C. Selection and pending ordering survive.
    await dialog.getByRole('button', { name: 'Close Project Assets defaults' }).click();
    await expect(dialog).toBeHidden();
    await expect(count).toHaveText('2 of 2 selected');
    for (const name of ['scope.png', 'wide.png']) {
      await expect(item(name).locator('input[name="selectedAssetIds"]')).toBeChecked();
    }
    expect(await renderedNames()).toEqual(['wide.png', 'scope.png']);
    expect(await orderInput.inputValue()).toBe(pendingOrder);

    // E. With a View change still unrendered, a style-only save takes the full
    // refresh; when that fails too the reload prompt stays.
    await page.getByRole('link', { name: 'Project Assets defaults', exact: true }).click();
    await expect(dialog).toBeVisible();
    for (const [name, value] of [['view', 'list'], ['gridStyle', 'uncropped']]) {
      armed = true;
      await page.route(refreshPattern, abortRefresh);
      response = saved();
      await page.locator(`#projectAssets-default-${name}`).selectOption(value, { force: true });
      expect((await response).status()).toBe(302);
      await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'saved-refresh-error');
      await expect(region).toHaveAttribute('data-project-assets-live-state', 'error');
      await expect(liveStatus).toContainText('Refresh the page to see the saved defaults.');
      await page.unroute(refreshPattern, abortRefresh);
    }
    await expect(grid).toHaveAttribute('data-grid-style', 'cropped');
    expect(pageErrors).toEqual([]);
  } finally {
    await f.close();
  }
});

// The rendered baseline advances only once a refresh installs. A failed or
// superseded View refresh leaves Grid on screen, so the next style-only save
// must reconcile the outstanding View instead of restyling the stale grid.
test('Grid style saves reconcile a View change whose refresh failed or was superseded', async ({ page }) => {
  test.skip(Boolean(process.env.CREATORCRATE_BROWSER_BASE_URL), 'Requires the isolated fixture.');
  const f = await fixture();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const [first, second] = f.ids;
  const dialog = page.locator('#project-assets-defaults-dialog');
  const form = page.locator('#project-assets-defaults-form');
  const region = page.locator('[data-project-assets-live-region]');
  const grid = region.locator('.asset-grid');
  const list = region.locator('.asset-list--project');
  const status = form.locator('[data-settings-fetch-save-status]');
  const saved = () => page.waitForResponse((r) => r.request().method() === 'POST'
    && new URL(r.url()).pathname.endsWith('/assets/defaults'));
  // Intercepts the next live-region GET (not the save's followed redirect).
  const interceptRefresh = async (projectId, handler) => {
    const pattern = new RegExp(`/projects/${projectId}/assets([?]|$)`);
    let armed = true;
    const route = async (r) => {
      const request = r.request();
      if (!armed || request.method() !== 'GET' || request.redirectedFrom()) {
        await r.continue().catch(() => {});
        return;
      }
      armed = false;
      await handler(r);
    };
    await page.route(pattern, route);
    return () => page.unroute(pattern, route);
  };
  const select = (name, value) => page.locator(`#projectAssets-default-${name}`)
    .selectOption(value, { force: true });
  const settledSave = async (name, value) => {
    const response = saved();
    await select(name, value);
    expect((await response).status()).toBe(302);
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'saved');
    await expect(region).not.toHaveAttribute('aria-busy', 'true');
  };
  const openGlobalDefaults = async (projectId) => {
    await page.goto(`${f.baseURL}/projects/${projectId}/assets`);
    await expect(grid).toHaveAttribute('data-grid-style', 'uncropped');
    await page.getByRole('link', { name: 'Project Assets defaults', exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(form.locator('input[name="loadedScope"]')).toHaveValue('global');
  };

  try {
    // Failed refresh: View = List is saved but Grid stays rendered.
    await openGlobalDefaults(first);
    let stopIntercept = await interceptRefresh(first, (r) => r.abort('failed'));
    let response = saved();
    await select('view', 'list');
    expect((await response).status()).toBe(302);
    await expect(form).toHaveAttribute('data-settings-fetch-save-state', 'saved-refresh-error');
    await expect(status).toContainText('could not refresh');
    await expect(grid).toBeVisible();
    await expect(list).toHaveCount(0);
    await stopIntercept();

    // The style-only save reconciles the outstanding View with a full refresh.
    await settledSave('gridStyle', 'cropped');
    await expect(list).toBeVisible();
    await expect(page.locator('[data-grid-style]')).toHaveCount(0);
    await expect(status).not.toContainText('could not refresh');

    // Returning to Grid shows the saved style, and a later style-only save
    // is applied in place again now that the baseline is current.
    await settledSave('view', 'grid');
    await expect(grid).toHaveAttribute('data-grid-style', 'cropped');
    await grid.evaluate((node) => { node.dataset.styleRegressionMarker = 'kept'; });
    await settledSave('gridStyle', 'uncropped');
    await expect(grid).toHaveAttribute('data-grid-style', 'uncropped');
    await expect(grid).toHaveAttribute('data-style-regression-marker', 'kept');

    // Superseded refresh: a style save made while the View refresh is still
    // in flight invalidates it, so it can never mark List as rendered.
    await page.goto(`${f.baseURL}/projects/${second}/assets`);
    await expect(grid).toHaveAttribute('data-grid-style', 'uncropped');
    await page.getByRole('link', { name: 'Project Assets defaults', exact: true }).click();
    await expect(dialog).toBeVisible();
    let releaseHeld;
    const held = new Promise((resolve) => { releaseHeld = resolve; });
    let heldRoute;
    stopIntercept = await interceptRefresh(second, (r) => {
      heldRoute = r;
      releaseHeld();
    });
    response = saved();
    await select('view', 'list');
    expect((await response).status()).toBe(302);
    await held;
    await expect(region).toHaveAttribute('aria-busy', 'true');
    await expect(grid).toBeVisible();
    await settledSave('gridStyle', 'cropped');
    await heldRoute.continue().catch(() => {});
    await stopIntercept();
    await expect(list).toBeVisible();
    await expect(page.locator('[data-grid-style]')).toHaveCount(0);

    // Reload agrees with what the live region now shows.
    await page.reload();
    await expect(list).toBeVisible();
    expect(pageErrors).toEqual([]);
  } finally {
    await f.close();
  }
});
