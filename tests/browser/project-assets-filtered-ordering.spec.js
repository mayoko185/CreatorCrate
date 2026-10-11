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

// Filtered-category ordering and Auto Rename (WP4A–WP4C) in real Chromium.
// Each test gets its own project whose "wip" category holds eight images
// of two extensions; filename order is the server's base category order.
// All data lives in a temporary root that is removed afterward.
const FILES = [
  '01-draft.png', '02-ref.jpg', '03-draft.png', '04-ref.jpg',
  '05-draft.jpg', '06-ref.png', '07-draft.png', '08-ref.jpg',
];

let server;
let db;
let app;
let root;
let projectsRoot;
let baseURL;

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-filtered-ordering-browser-'));
  projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  const viteDistRoot = path.join(root, 'client');
  fs.mkdirSync(projectsRoot);
  fs.mkdirSync(appDataRoot);
  await build({ build: { outDir: viteDistRoot }, logLevel: 'silent' });
  db = openDatabase(path.join(root, 'test.db'));
  runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
  const { csrfPepper } = ensureAuthEnablement(appDataRoot);
  app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, {
    appDataRoot, authState: { csrfPepper }, useViteAssets: true, viteDistRoot,
    assetManifest: createAssetManifest({ distRoot: viteDistRoot,
      manifestPath: path.join(viteDistRoot, '.vite', 'manifest.json') }),
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (db) closeDatabase(db);
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

async function createProject(title) {
  const project = app.locals.projectService.create({ title, status: 'tbd' });
  const categories = app.locals.projectAssetCategoryService;
  if (!categories.list(project.id).some((candidate) => candidate.directory_slug === 'wip')) {
    categories.add(project.id, { displayName: 'WIP', directorySlug: 'wip' });
  }
  const category = categories.list(project.id).find((candidate) => candidate.directory_slug === 'wip');
  const categoryDir = path.join(projectsRoot, project.project_dir, 'wip');
  fs.mkdirSync(categoryDir, { recursive: true });
  for (const [index, filename] of FILES.entries()) {
    const image = sharp({ create: { width: 12, height: 12, channels: 3,
      background: { r: index * 30, g: 90, b: 160 } } });
    await (filename.endsWith('.png') ? image.png() : image.jpeg()).toFile(path.join(categoryDir, filename));
  }
  app.locals.assetScanner.scanProjectAssets(project.id);
  const files = () => fs.readdirSync(categoryDir).sort();
  return { id: project.id, categoryId: category.id, categoryDir, files };
}

function pageHelpers(page, f) {
  const region = page.locator('[data-project-assets-live-region]');
  const surface = region.locator('[data-auto-rename-surface]');
  const items = surface.locator('[data-auto-rename-asset]');
  const submit = page.locator('[data-auto-rename-submit]');
  const filterDialog = page.locator('#project-assets-filter-dialog');
  const item = (name) => surface.locator(`[data-auto-rename-asset][aria-label="Reorder ${name}"]`);
  const renderedNames = () => items.evaluateAll((nodes) => nodes.map(
    (node) => node.getAttribute('aria-label').replace(/^Reorder /, ''),
  ));
  const ids = {};
  const namesFor = (idList) => idList.map((id) => Object.keys(ids).find((name) => ids[name] === id));
  return {
    region,
    surface,
    items,
    submit,
    item,
    renderedNames,
    ids,
    namesFor,
    settled: () => expect(region).not.toHaveAttribute('aria-busy', 'true'),
    orderNames: async () => namesFor(JSON.parse(await page.locator('[data-auto-rename-order-input]').inputValue())),
    baseNames: async () => namesFor(JSON.parse(await surface.getAttribute('data-auto-rename-base-order'))),
    selectedNames: async () => namesFor(JSON.parse(
      await page.locator('[data-auto-rename-selection-input]').inputValue(),
    )),
    // Reads every category asset ID from the unfiltered category view.
    learnIds: async () => {
      await page.goto(`${baseURL}/projects/${f.id}/assets?category=${f.categoryId}`);
      await expect(items).toHaveCount(FILES.length);
      const entries = await items.evaluateAll((nodes) => nodes.map((node) => [
        node.getAttribute('aria-label').replace(/^Reorder /, ''),
        Number(node.getAttribute('data-auto-rename-asset-id')),
      ]));
      for (const [name, id] of entries) ids[name] = id;
      expect(Object.keys(ids).sort()).toEqual([...FILES].sort());
    },
    openFilters: async () => {
      if (!(await filterDialog.isVisible())) {
        await page.getByRole('link', { name: 'Filter assets', exact: true }).click();
      }
      await expect(filterDialog).toBeVisible();
    },
    closeFilters: async () => {
      // The first Escape closes an open dropdown panel, the next the dialog.
      for (let attempt = 0; attempt < 3 && await filterDialog.isVisible(); attempt += 1) {
        await page.keyboard.press('Escape');
      }
      await expect(filterDialog).toBeHidden();
    },
    toggleExtension: async (extension) => {
      const dropdown = page.locator('#asset-extension-filter');
      if (!(await dropdown.locator('summary').evaluate((node) => node.parentElement.open))) {
        await dropdown.locator('summary').click();
      }
      await dropdown.locator('label').filter({ has: page.locator(`input[value="${extension}"]`) }).click();
    },
    select: async (name) => {
      await item(name).locator('.asset-selection-control').click();
      await expect(item(name).locator('input[name="selectedAssetIds"]')).toBeChecked();
    },
  };
}

function previewRequest(page, f) {
  return page.waitForRequest((request) => request.method() === 'POST'
    && new URL(request.url()).pathname === `/projects/${f.id}/assets/auto-rename/preview`);
}

test('grid: filtered selection enables Auto Rename, drag merges hidden slots, Preview/Cancel/Apply keep filters', async ({ page }) => {
  const f = await createProject('Filtered Grid Ordering');
  const h = pageHelpers(page, f);
  await h.learnIds();
  await expect(h.surface).toHaveAttribute('data-category-membership-complete', 'true');
  expect(await h.baseNames()).toEqual(FILES);

  // 1. Hide the JPEGs through the real filter UI (live, no navigation).
  await h.openFilters();
  await h.toggleExtension('png');
  await h.settled();
  await expect(page).toHaveURL(/extension=png/);
  await h.closeFilters();
  const visible = ['01-draft.png', '03-draft.png', '06-ref.png', '07-draft.png'];
  await expect(h.items).toHaveCount(visible.length);
  expect(await h.renderedNames()).toEqual(visible);
  await expect(h.surface).toHaveAttribute('data-category-membership-complete', 'false');
  await expect(h.surface).toHaveAttribute('data-category-reorder-enabled', 'true');
  await expect(h.surface).toHaveAttribute('data-auto-rename-enabled', 'true');
  await expect(h.surface).toHaveAttribute('data-auto-rename-view', 'grid');
  await expect(page.getByRole('heading', { name: 'Project actions', exact: true })).toBeVisible();
  expect(await h.baseNames()).toEqual(FILES);
  expect(await h.orderNames()).toEqual(FILES);
  await expect(h.region.locator('input[type="checkbox"][name="selectedAssetIds"]')).toHaveCount(visible.length);

  // Selection drives enablement; Clear disables it again.
  await expect(h.submit).toBeDisabled();
  await h.select('01-draft.png');
  await expect(h.submit).toBeEnabled();
  await h.region.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await expect(h.submit).toBeDisabled();
  expect(await h.selectedNames()).toEqual([]);

  // The user's scenario: three of the visible assets selected, JPEGs hidden.
  const selectAndDrag = async () => {
    for (const name of ['01-draft.png', '03-draft.png', '07-draft.png']) await h.select(name);
    await expect(page.locator('[data-selected-count]')).toHaveText('3 of 4 selected');
    await expect(h.submit).toBeEnabled();
    expect((await h.selectedNames()).sort()).toEqual(['01-draft.png', '03-draft.png', '07-draft.png']);

    // 2. Real drag: 07-draft.png onto the leading edge of the first card.
    const first = h.item('01-draft.png');
    const firstBox = await first.boundingBox();
    await h.item('07-draft.png').dragTo(first, { targetPosition: { x: 2, y: firstBox.height / 2 } });
    await expect.poll(h.renderedNames).toEqual(['07-draft.png', '01-draft.png', '03-draft.png', '06-ref.png']);
    // Hidden JPEG slots (1, 3, 4, 7) are untouched; visible slots are refilled.
    expect(await h.orderNames()).toEqual([
      '07-draft.png', '02-ref.jpg', '01-draft.png', '04-ref.jpg',
      '05-draft.jpg', '03-draft.png', '06-ref.png', '08-ref.jpg',
    ]);
    expect(await h.baseNames()).toEqual(FILES);
    await expect(h.submit).toBeEnabled();
  };
  await selectAndDrag();

  // 4. Preview submits the complete order and schedules only the selection,
  // numbered in the visible reordered sequence.
  const expectPreview = async () => {
    const [request] = await Promise.all([previewRequest(page, f), h.submit.click()]);
    const body = new URLSearchParams(request.postData() || '');
    expect(h.namesFor(JSON.parse(body.get('orderedAssetIds')))).toEqual([
      '07-draft.png', '02-ref.jpg', '01-draft.png', '04-ref.jpg',
      '05-draft.jpg', '03-draft.png', '06-ref.png', '08-ref.jpg',
    ]);
    expect(h.namesFor(JSON.parse(body.get('selectedAssetIds'))).sort())
      .toEqual(['01-draft.png', '03-draft.png', '07-draft.png']);
    expect(body.getAll('extension')).toEqual(['png']);
    const dialog = page.locator('#auto-rename-confirmation-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.auto-rename-confirmation-summary')).toContainText('3 assets:');
    await expect(dialog.locator('.auto-rename-confirmation-summary')).toContainText('3 to rename');
    const rows = dialog.locator('.auto-rename-confirmation-item');
    expect((await rows.locator('.auto-rename-confirmation-name--current code').allTextContents()).map((t) => t.trim()))
      .toEqual(['07-draft.png', '01-draft.png', '03-draft.png']);
    const proposed = (await rows.locator('.auto-rename-confirmation-name--proposed code').allTextContents())
      .map((t) => t.trim());
    expect(proposed[0]).toMatch(/-wip-01\.png$/);
    expect(proposed[1]).toMatch(/-wip-02\.png$/);
    expect(proposed[2]).toMatch(/-wip-03\.png$/);
    for (const name of ['02-ref.jpg', '04-ref.jpg', '05-draft.jpg', '06-ref.png', '08-ref.jpg']) {
      await expect(dialog).not.toContainText(name);
    }
    // The signed Apply form carries the filter context forward.
    const applyForm = dialog.locator('#auto-rename-confirmation-form');
    expect(await applyForm.locator('input[name="extension"]').evaluateAll((n) => n.map((i) => i.value)))
      .toEqual(['png']);
    return { dialog, proposed };
  };
  const { dialog: firstDialog } = await expectPreview();

  // 6. Cancel returns to the same filtered category in Grid; nothing renamed.
  await Promise.all([
    page.waitForURL((url) => url.pathname === `/projects/${f.id}/assets` && url.searchParams.has('extension')),
    firstDialog.getByRole('link', { name: 'Cancel', exact: true }).click(),
  ]);
  let url = new URL(page.url());
  expect(url.searchParams.get('category')).toBe(String(f.categoryId));
  expect(url.searchParams.getAll('extension')).toEqual(['png']);
  expect(url.searchParams.has('inheritedFilterDefaults')).toBe(false);
  expect(url.searchParams.get('view') ?? 'grid').toBe('grid');
  await expect(h.surface).toHaveAttribute('data-auto-rename-view', 'grid');
  expect(await h.renderedNames()).toEqual(visible);
  expect(f.files()).toEqual([...FILES].sort());

  // 5. Apply a fresh signed Preview.
  await selectAndDrag();
  const { dialog, proposed } = await expectPreview();
  await Promise.all([
    page.waitForURL((u) => u.searchParams.get('notice') === 'auto-rename-success'),
    dialog.getByRole('button', { name: 'Apply Auto Rename', exact: true }).click(),
  ]);
  url = new URL(page.url());
  expect(url.searchParams.get('category')).toBe(String(f.categoryId));
  expect(url.searchParams.getAll('extension')).toEqual(['png']);
  expect(url.searchParams.has('inheritedFilterDefaults')).toBe(false);
  expect(url.searchParams.get('view') ?? 'grid').toBe('grid');
  expect(f.files()).toEqual([
    ...proposed, '02-ref.jpg', '04-ref.jpg', '05-draft.jpg', '06-ref.png', '08-ref.jpg',
  ].sort());
  await expect(h.items).toHaveCount(4);
  expect((await h.renderedNames()).sort()).toEqual([...proposed, '06-ref.png'].sort());
});

test('list: keyboard reorder merges hidden slots, Escape restores, Apply keeps search and List view', async ({ page }) => {
  const f = await createProject('Filtered List Ordering');
  const h = pageHelpers(page, f);
  await h.learnIds();
  await page.goto(`${baseURL}/projects/${f.id}/assets?category=${f.categoryId}&view=list`);
  await expect(h.surface).toHaveAttribute('data-auto-rename-view', 'list');

  // Live search hides every "-ref" asset, including one PNG and three JPEGs.
  await h.openFilters();
  await page.locator('#search').fill('draft');
  await expect.poll(() => new URL(page.url()).searchParams.get('search')).toBe('draft');
  await h.settled();
  await h.closeFilters();
  const visible = ['01-draft.png', '03-draft.png', '05-draft.jpg', '07-draft.png'];
  await expect.poll(h.renderedNames).toEqual(visible);
  expect(new URL(page.url()).searchParams.get('view')).toBe('list');
  await expect(h.surface).toHaveAttribute('data-category-membership-complete', 'false');
  await expect(h.surface).toHaveAttribute('data-auto-rename-enabled', 'true');
  for (const name of ['01-draft.png', '05-draft.jpg', '07-draft.png']) await h.select(name);
  await expect(h.submit).toBeEnabled();

  // 3. Keyboard: grab 07-draft.png, move it to the top, commit.
  await h.item('07-draft.png').focus();
  await page.keyboard.press('Space');
  await expect(h.item('07-draft.png')).toHaveAttribute('aria-grabbed', 'true');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Space');
  await expect(h.item('07-draft.png')).toHaveAttribute('aria-grabbed', 'false');
  const committed = ['07-draft.png', '01-draft.png', '03-draft.png', '05-draft.jpg'];
  expect(await h.renderedNames()).toEqual(committed);
  const merged = [
    '07-draft.png', '02-ref.jpg', '01-draft.png', '04-ref.jpg',
    '03-draft.png', '06-ref.png', '05-draft.jpg', '08-ref.jpg',
  ];
  expect(await h.orderNames()).toEqual(merged);
  // Space committed the move without toggling selection.
  expect((await h.selectedNames()).sort()).toEqual(['01-draft.png', '05-draft.jpg', '07-draft.png']);

  // Escape restores the pre-grab order and the control stays operable.
  await h.item('03-draft.png').focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  expect(await h.renderedNames()).toEqual(['07-draft.png', '01-draft.png', '05-draft.jpg', '03-draft.png']);
  expect(await h.orderNames()).toEqual([
    '07-draft.png', '02-ref.jpg', '01-draft.png', '04-ref.jpg',
    '05-draft.jpg', '06-ref.png', '03-draft.png', '08-ref.jpg',
  ]);
  await page.keyboard.press('Escape');
  await expect(h.item('03-draft.png')).toHaveAttribute('aria-grabbed', 'false');
  expect(await h.renderedNames()).toEqual(committed);
  expect(await h.orderNames()).toEqual(merged);
  await expect(h.submit).toBeEnabled();

  // 4. Preview: only the selection, numbered g, a, e.
  const [request] = await Promise.all([previewRequest(page, f), h.submit.click()]);
  const body = new URLSearchParams(request.postData() || '');
  expect(h.namesFor(JSON.parse(body.get('orderedAssetIds')))).toEqual(merged);
  expect(h.namesFor(JSON.parse(body.get('selectedAssetIds'))).sort())
    .toEqual(['01-draft.png', '05-draft.jpg', '07-draft.png']);
  expect(body.get('search')).toBe('draft');
  expect(body.get('view')).toBe('list');
  const dialog = page.locator('#auto-rename-confirmation-dialog');
  await expect(dialog).toBeVisible();
  const rows = dialog.locator('.auto-rename-confirmation-item');
  expect((await rows.locator('.auto-rename-confirmation-name--current code').allTextContents()).map((t) => t.trim()))
    .toEqual(['07-draft.png', '01-draft.png', '05-draft.jpg']);
  const proposed = (await rows.locator('.auto-rename-confirmation-name--proposed code').allTextContents())
    .map((t) => t.trim());
  expect(proposed[0]).toMatch(/-wip-01\.png$/);
  expect(proposed[1]).toMatch(/-wip-02\.png$/);
  expect(proposed[2]).toMatch(/-wip-03\.jpg$/);
  const cancelHref = new URL(await dialog.getByRole('link', { name: 'Cancel', exact: true }).getAttribute('href'), baseURL);
  expect(cancelHref.searchParams.get('search')).toBe('draft');
  expect(cancelHref.searchParams.get('view')).toBe('list');
  expect(cancelHref.searchParams.get('category')).toBe(String(f.categoryId));

  // 5/6. Apply redirects back to the searched List view; renamed assets no
  // longer match "draft", so only the unselected 03-draft.png remains visible.
  await Promise.all([
    page.waitForURL((u) => u.searchParams.get('notice') === 'auto-rename-success'),
    dialog.getByRole('button', { name: 'Apply Auto Rename', exact: true }).click(),
  ]);
  const url = new URL(page.url());
  expect(url.searchParams.get('search')).toBe('draft');
  expect(url.searchParams.get('view')).toBe('list');
  expect(url.searchParams.get('category')).toBe(String(f.categoryId));
  expect(f.files()).toEqual([
    ...proposed, '03-draft.png', '02-ref.jpg', '04-ref.jpg', '06-ref.png', '08-ref.jpg',
  ].sort());
  await expect(h.surface).toHaveAttribute('data-auto-rename-view', 'list');
  expect(await h.renderedNames()).toEqual(['03-draft.png']);
});

test('live navigation re-initializes the base order; restrictions and stale orders stay blocked', async ({ page }) => {
  const f = await createProject('Filtered Live Ordering');
  const h = pageHelpers(page, f);
  await h.learnIds();

  // 7. Live filter change, then an unsubmitted drag.
  await h.openFilters();
  await h.toggleExtension('jpg');
  await h.settled();
  await h.closeFilters();
  const jpgs = ['02-ref.jpg', '04-ref.jpg', '05-draft.jpg', '08-ref.jpg'];
  await expect.poll(h.renderedNames).toEqual(jpgs);
  expect(await h.orderNames()).toEqual(FILES);
  const firstBox = await h.item('02-ref.jpg').boundingBox();
  await h.item('08-ref.jpg').dragTo(h.item('02-ref.jpg'), { targetPosition: { x: 2, y: firstBox.height / 2 } });
  await expect.poll(h.renderedNames).toEqual(['08-ref.jpg', '02-ref.jpg', '04-ref.jpg', '05-draft.jpg']);
  expect(await h.orderNames()).toEqual([
    '01-draft.png', '08-ref.jpg', '03-draft.png', '02-ref.jpg',
    '04-ref.jpg', '06-ref.png', '07-draft.png', '05-draft.jpg',
  ]);

  // Grid → List replaces the surface; the base order comes from the server.
  await page.getByRole('link', { name: 'List view', exact: true }).click();
  await expect(page).toHaveURL(/view=list/);
  await h.settled();
  await expect(h.surface).toHaveAttribute('data-auto-rename-view', 'list');
  await expect.poll(h.renderedNames).toEqual(jpgs);
  expect(await h.baseNames()).toEqual(FILES);
  expect(await h.orderNames()).toEqual(FILES);
  expect(new URL(page.url()).searchParams.getAll('extension')).toEqual(['jpg']);

  // Keyboard still works on the replaced surface.
  await h.item('04-ref.jpg').focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Space');
  expect(await h.renderedNames()).toEqual(['04-ref.jpg', '02-ref.jpg', '05-draft.jpg', '08-ref.jpg']);
  expect(await h.orderNames()).toEqual([
    '01-draft.png', '04-ref.jpg', '03-draft.png', '02-ref.jpg',
    '05-draft.jpg', '06-ref.png', '07-draft.png', '08-ref.jpg',
  ]);

  // Back/Forward re-render from the server with fresh base orders.
  await page.goBack();
  await expect(page).not.toHaveURL(/view=list/);
  await h.settled();
  await expect(h.surface).toHaveAttribute('data-auto-rename-view', 'grid');
  await expect.poll(h.renderedNames).toEqual(jpgs);
  expect(await h.orderNames()).toEqual(FILES);
  await page.goForward();
  await expect(page).toHaveURL(/view=list/);
  await h.settled();
  await expect(h.surface).toHaveAttribute('data-auto-rename-view', 'list');
  expect(await h.orderNames()).toEqual(FILES);

  // Restoring the complete category view.
  await h.openFilters();
  await h.toggleExtension('jpg');
  await h.settled();
  await h.closeFilters();
  await expect(h.items).toHaveCount(FILES.length);
  await expect(h.surface).toHaveAttribute('data-category-membership-complete', 'true');
  expect(await h.orderNames()).toEqual(FILES);
  await h.item('02-ref.jpg').focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Space');
  expect((await h.orderNames()).slice(0, 2)).toEqual(['02-ref.jpg', '01-draft.png']);

  // 8. Invalid or stale orders cannot bypass server validation. The client
  // rewrites its own input from the base order, so post the form directly.
  await page.goto(`${baseURL}/projects/${f.id}/assets?category=${f.categoryId}&extension=png`);
  await h.select('01-draft.png');
  const tampered = async (orderedIds) => page.evaluate(async (order) => {
    const form = document.querySelector('[data-auto-rename-form]');
    const data = new URLSearchParams(new FormData(form));
    data.set('orderedAssetIds', JSON.stringify(order));
    const response = await fetch(form.action, { method: 'POST', body: data });
    return { status: response.status, text: await response.text() };
  }, orderedIds);
  const visibleOnly = ['01-draft.png', '03-draft.png', '06-ref.png', '07-draft.png'].map((n) => h.ids[n]);
  const missingHidden = FILES.filter((n) => n !== '08-ref.jpg').map((n) => h.ids[n]);
  const foreign = [...FILES.map((n) => h.ids[n]), 999999];
  for (const order of [visibleOnly, missingHidden, foreign]) {
    const result = await tampered(order);
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.text).not.toContain('auto-rename-confirmation-dialog');
  }
  expect(f.files()).toEqual([...FILES].sort());

  // Empty filtered results: no ordering surface and no usable Auto Rename.
  // The visible Auto Rename button stays, disabled and unbound to any form.
  const autoRenameButton = page.getByRole('button', { name: 'Auto Rename', exact: true });
  await page.goto(`${baseURL}/projects/${f.id}/assets?category=${f.categoryId}&search=zzz-none`);
  await expect(h.surface).toHaveCount(0);
  await expect(page.locator('[data-auto-rename-asset]')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Project actions', exact: true })).toBeVisible();
  await expect(h.submit).toHaveCount(0);
  await expect(autoRenameButton).toBeDisabled();

  // All and Uncategorized never gain the category capability.
  for (const category of ['all', 'uncategorized']) {
    await page.goto(`${baseURL}/projects/${f.id}/assets?category=${category}`);
    await expect(page.getByRole('heading', { name: 'Project actions', exact: true })).toBeVisible();
    await expect(h.surface).toHaveCount(0);
    await expect(page.locator('[data-auto-rename-asset]')).toHaveCount(0);
    await expect(h.submit).toHaveCount(0);
    await expect(autoRenameButton).toBeDisabled();
  }
});
