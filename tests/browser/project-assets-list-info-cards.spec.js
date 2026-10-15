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

// Project Assets List title information cards in real Chromium: the shared
// Dashboard hover/pin lifecycle, and the row selection, Rename and ordering
// interactions around it. All data lives in a temporary root that is removed
// afterward.
const FILES = ['01-alpha.png', '02-beta.png', '03-gamma.png', '04-delta.png'];

let server;
let db;
let app;
let root;
let projectsRoot;
let baseURL;

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-asset-list-info-browser-'));
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

async function createProject(title, { extras = false } = {}) {
  const project = app.locals.projectService.create({ title, status: 'tbd' });
  const categories = app.locals.projectAssetCategoryService;
  if (!categories.list(project.id).some((candidate) => candidate.directory_slug === 'wip')) {
    categories.add(project.id, { displayName: 'WIP', directorySlug: 'wip' });
  }
  const category = categories.list(project.id).find((candidate) => candidate.directory_slug === 'wip');
  const categoryDir = path.join(projectsRoot, project.project_dir, 'wip');
  fs.mkdirSync(categoryDir, { recursive: true });
  for (const [index, filename] of FILES.entries()) {
    await sharp({ create: { width: 40, height: 24, channels: 3,
      background: { r: index * 50, g: 90, b: 160 } } }).png().toFile(path.join(categoryDir, filename));
  }
  if (extras) {
    fs.writeFileSync(path.join(categoryDir, '05-clip.mp4'), Buffer.from('not really a video'));
    fs.writeFileSync(path.join(categoryDir, '06-broken.png'), Buffer.from('not really a png'));
    fs.writeFileSync(path.join(categoryDir, '07-gone.png'), Buffer.from('soon missing'));
  }
  app.locals.assetScanner.scanProjectAssets(project.id);
  if (extras) {
    fs.rmSync(path.join(categoryDir, '07-gone.png'));
    app.locals.assetScanner.scanProjectAssets(project.id);
  }
  const ids = Object.fromEntries(db.prepare('SELECT filename, id FROM assets WHERE project_id = ?')
    .all(project.id).map((row) => [row.filename, row.id]));
  return { id: project.id, categoryId: category.id, ids };
}

function rowParts(page, assetId) {
  const card = page.locator(`article.asset-list-card[data-asset-id="${assetId}"]`);
  return {
    item: card.locator('xpath=..'),
    card,
    title: card.locator('[data-calendar-info-trigger]'),
    info: page.locator(`#project-asset-list-info-${assetId}`),
    checkbox: card.locator('input[name="selectedAssetIds"]'),
  };
}

async function moveAway(page) {
  await page.mouse.move(4, 4, { steps: 3 });
}

const currentPath = (page) => {
  const url = new URL(page.url());
  return url.pathname + url.search;
};

test('List titles hover, pin and dismiss without selecting, reordering or navigating the row', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createProject('Info Card Interactions');
  const listPath = `/projects/${f.id}/assets?category=${f.categoryId}&view=list`;
  await page.goto(baseURL + listPath);
  const { item, card, title, info, checkbox } = rowParts(page, f.ids['02-beta.png']);
  await expect(page.locator('[data-auto-rename-surface]')).toHaveAttribute('data-auto-rename-view', 'list');
  const orderInput = page.locator('[data-auto-rename-order-input]');
  const initialOrder = await orderInput.inputValue();

  // Transient hover follows the pointer and closes when it leaves.
  const titleBox = await title.boundingBox();
  await page.mouse.move(titleBox.x + 3, titleBox.y + 3, { steps: 4 });
  await expect(info).toBeVisible();
  await expect(title).toHaveAttribute('aria-expanded', 'true');
  const hoverBox = await info.boundingBox();
  await page.mouse.move(titleBox.x + titleBox.width - 3, titleBox.y + titleBox.height - 3, { steps: 6 });
  await expect.poll(async () => (await info.boundingBox()).x !== hoverBox.x).toBe(true);
  await moveAway(page);
  await expect(info).toBeHidden();
  await expect(title).toHaveAttribute('aria-expanded', 'false');

  // A click pins the card under the title; clicks and text drags inside it
  // keep it open and never select, reorder or navigate.
  await title.click();
  await expect(info).toBeVisible();
  await moveAway(page);
  await expect(info).toBeVisible();
  const pinnedBox = await info.boundingBox();
  const anchoredTitle = await title.boundingBox();
  // Anchored beside the title: below it, or above it near the viewport edge.
  expect(pinnedBox.y >= anchoredTitle.y + anchoredTitle.height
    || pinnedBox.y + pinnedBox.height <= anchoredTitle.y).toBe(true);
  // The larger preview settles to the image or its fallback (this harness
  // does not generate derived previews).
  await expect(info.locator('.calendar-release-info-media')).toHaveAttribute('data-preview-state', /^(loaded|failed)$/);
  await info.locator('.asset-list-info-path').click();
  await info.locator('.asset-viewer-grid-card-info-heading').click();
  const heading = await info.locator('.asset-viewer-grid-card-info-heading').boundingBox();
  await page.mouse.move(heading.x + 2, heading.y + heading.height / 2);
  await page.mouse.down();
  await page.mouse.move(heading.x + 60, heading.y + 120, { steps: 6 });
  await page.mouse.up();
  await expect(info).toBeVisible();
  await expect(checkbox).not.toBeChecked();
  await expect(card).not.toHaveClass(/is-selected/);
  await expect(item).toHaveAttribute('aria-grabbed', 'false');
  expect(await orderInput.inputValue()).toBe(initialOrder);
  expect(currentPath(page)).toBe(listPath);

  // Clicking the pinned title again, an outside click and Escape dismiss.
  await title.click();
  await expect(info).toBeHidden();
  await expect(checkbox).not.toBeChecked();
  await title.click();
  await expect(info).toBeVisible();
  await page.locator('.page-heading, h1').first().click();
  await expect(info).toBeHidden();
  await title.click();
  await expect(info).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(info).toBeHidden();
  await expect(title).toBeFocused();

  // Only one card is active at a time.
  const other = rowParts(page, f.ids['03-gamma.png']);
  await title.click();
  await other.title.click();
  await expect(other.info).toBeVisible();
  await expect(info).toBeHidden();
  await page.keyboard.press('Escape');

  // Dragging from the title never starts ordering.
  await title.dragTo(rowParts(page, f.ids['04-delta.png']).title);
  expect(await orderInput.inputValue()).toBe(initialOrder);
  await expect(item).toHaveAttribute('aria-grabbed', 'false');
  await page.keyboard.press('Escape');

  // Row-background clicks keep toggling selection.
  await card.locator('.asset-list-cell--size').click();
  await expect(checkbox).toBeChecked();
  await expect(page.locator('[data-selected-count]')).toContainText('1 of');
  await card.locator('.asset-list-cell--size').click();
  await expect(checkbox).not.toBeChecked();

  // Keyboard activation pins without selecting.
  await title.focus();
  await page.keyboard.press('Enter');
  await expect(info).toBeVisible();
  await expect(checkbox).not.toBeChecked();
  await page.keyboard.press('Enter');
  await expect(info).toBeHidden();
  await expect(title).toBeFocused();

  // Mouse drag from the row still reorders.
  const target = rowParts(page, f.ids['01-alpha.png']).item;
  const targetBox = await target.boundingBox();
  await rowParts(page, f.ids['04-delta.png']).card.locator('.asset-list-cell--size')
    .dragTo(target, { targetPosition: { x: targetBox.width / 2, y: 2 } });
  await expect.poll(() => orderInput.inputValue()).not.toBe(initialOrder);
  expect(JSON.parse(await orderInput.inputValue())[0]).toBe(f.ids['04-delta.png']);

  // The pinned card's Open asset action navigates to the Asset Viewer.
  await title.click();
  await expect(info).toBeVisible();
  await info.getByRole('link', { name: 'Open asset' }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/projects/${f.id}/assets/${f.ids['02-beta.png']}`);
  expect(pageErrors).toEqual([]);
});

test('Inline Rename, live filtering and List size keep working beside the information cards', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createProject('Info Card Rename');
  await page.goto(`${baseURL}/projects/${f.id}/assets?view=list`);
  const row = rowParts(page, f.ids['01-alpha.png']);

  // Rename opens the editor, Escape restores the title row and focus.
  const rename = row.card.locator('[data-asset-rename-trigger]');
  await rename.click();
  const input = row.card.locator('[data-asset-rename-input]');
  await expect(input).toBeFocused();
  await expect(row.title).toBeHidden();
  await expect(row.checkbox).not.toBeChecked();
  await page.keyboard.press('Escape');
  await expect(row.title).toBeVisible();
  await expect(rename).toBeFocused();

  // Rename submits and the renamed row keeps a working card.
  await rename.click();
  await input.fill('01-renamed');
  await row.card.locator('[data-asset-rename-confirm]').click();
  await expect(page.locator(`article.asset-list-card[data-asset-id="${f.ids['01-alpha.png']}"] [data-calendar-info-trigger]`))
    .toHaveText('01-renamed');
  const renamed = rowParts(page, f.ids['01-alpha.png']);
  await renamed.title.click();
  await expect(renamed.info.locator('.asset-list-info-filename')).toHaveText('01-renamed.png');
  await page.keyboard.press('Escape');

  // Live filtering replaces the rows and the new titles are bound.
  await page.evaluate(() => { window.__assetListMarker = true; });
  await page.getByRole('link', { name: 'Filter assets', exact: true }).click();
  await page.locator('#search').fill('gamma');
  await expect.poll(() => new URL(page.url()).searchParams.get('search')).toBe('gamma');
  await expect(page.locator('[data-project-assets-live-region]')).not.toHaveAttribute('aria-busy', 'true');
  for (let attempt = 0; attempt < 3 && await page.locator('#project-assets-filter-dialog').isVisible(); attempt += 1) {
    await page.keyboard.press('Escape');
  }
  await expect(page.locator('article.asset-list-card')).toHaveCount(1);
  expect(await page.evaluate(() => window.__assetListMarker)).toBe(true);
  const filtered = rowParts(page, f.ids['03-gamma.png']);
  const box = await filtered.title.boundingBox();
  await page.mouse.move(box.x + 3, box.y + 3, { steps: 3 });
  await expect(filtered.info).toBeVisible();
  await moveAway(page);

  // Compact/Large switching resizes the thumbnails, not the card.
  const list = page.locator('.asset-list--project');
  const thumb = filtered.card.locator('.asset-list-card-media');
  await expect(list).toHaveAttribute('data-list-size', 'large');
  expect(Math.round((await thumb.boundingBox()).width)).toBe(72);
  await page.locator('[data-asset-list-size-controls] [data-grid-size-slider]').fill('1');
  await expect(list).toHaveAttribute('data-list-size', 'compact');
  expect(Math.round((await thumb.boundingBox()).width)).toBe(48);
  await filtered.title.click();
  await expect(filtered.info).toBeVisible();
});

test('Missing, broken and video assets show placeholders; archived rows stay read-only', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createProject('Info Card Media States', { extras: true });
  await page.goto(`${baseURL}/projects/${f.id}/assets?view=list&pageSize=all`);

  const video = rowParts(page, f.ids['05-clip.mp4']);
  await video.title.click();
  await expect(video.info).toContainText('MP4 video — play it from the row thumbnail');
  expect(await video.info.locator('video, img').count()).toBe(0);
  expect(await page.locator('video').evaluateAll((nodes) => nodes.every((node) => node.paused && !node.autoplay))).toBe(true);
  await page.keyboard.press('Escape');

  const broken = rowParts(page, f.ids['06-broken.png']);
  await broken.title.click();
  await expect(broken.info.locator('[data-preview-fallback]')).toBeVisible();
  await expect(broken.info).toContainText('06-broken.png');
  await page.keyboard.press('Escape');

  const missing = rowParts(page, f.ids['07-gone.png']);
  await missing.title.click();
  await expect(missing.info).toContainText('File missing at last scan');
  await expect(missing.info).toContainText('Missing at last scan');
  await page.keyboard.press('Escape');

  app.locals.projectService.archive(f.id);
  await page.goto(`${baseURL}/projects/${f.id}/assets?view=list`);
  const archived = rowParts(page, f.ids['02-beta.png']);
  await expect(page.locator('input[name="selectedAssetIds"]')).toHaveCount(0);
  await expect(page.locator('[data-asset-rename-trigger]')).toHaveCount(0);
  await expect(page.locator('[data-auto-rename-asset]')).toHaveCount(0);
  await archived.title.click();
  await expect(archived.info.getByRole('link', { name: 'Open asset' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(archived.info).toBeHidden();
});

test('Project Assets List keeps horizontal scrolling and an on-screen card at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 740 });
  const f = await createProject('Info Card Narrow');
  await page.goto(`${baseURL}/projects/${f.id}/assets?view=list`);
  const scroller = page.locator('.asset-list-scroll');
  expect(await scroller.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const row = rowParts(page, f.ids['01-alpha.png']);

  // At this size the shared hover lifecycle can clamp a tall card over the
  // pointer; a mouse press on the title must still never select the row.
  await row.title.click();
  await expect(row.checkbox).not.toBeChecked();
  await page.keyboard.press('Escape');
  await moveAway(page);
  await expect(row.info).toBeHidden();

  await row.title.focus();
  await page.keyboard.press('Enter');
  await expect(row.info).toBeVisible();
  await expect(row.checkbox).not.toBeChecked();
  const box = await row.info.boundingBox();
  expect(box.x >= 0 && box.x + box.width <= 375).toBe(true);

  // Scrolling the table keeps a pinned card anchored, then dismisses it once
  // the title leaves the view.
  await scroller.evaluate((node) => { node.scrollLeft = 40; });
  await expect(row.info).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(row.info).toBeHidden();
});

test('Narrow hover cards never cover the pointer, and pinned cards scroll to every detail', async ({ page }) => {
  const f = await createProject('Info Card Pointer');
  const listPath = `/projects/${f.id}/assets?view=list`;
  for (const [width, height] of [[320, 740], [375, 740], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.goto(baseURL + listPath);
    const filename = FILES[0];
    const row = rowParts(page, f.ids[filename]);
    // Places the title at the top edge, mid-viewport or the bottom edge.
    for (const targetY of [24, height / 2, height - 32]) {
      const startBox = await row.title.boundingBox();
      await page.evaluate((delta) => window.scrollBy(0, delta), startBox.y - targetY);
      const titleBox = await row.title.boundingBox();
      await page.evaluate(() => {
        window.__titleToggles = 0;
        window.__titleObserver?.disconnect();
        window.__titleObserver = new MutationObserver((records) => { window.__titleToggles += records.length; });
        document.querySelectorAll('[data-calendar-info-trigger]').forEach((node) => window.__titleObserver
          .observe(node, { attributes: true, attributeFilter: ['aria-expanded'] }));
      });
      // Ordinary movement along the title, including mid-viewport titles
      // whose card fits neither above nor below the pointer uncapped.
      const y = titleBox.y + titleBox.height / 2;
      for (let step = 0; step < 4; step += 1) {
        const x = titleBox.x + 2 + step * Math.min(4, titleBox.width / 5);
        await page.mouse.move(x, y);
        // One round trip per step, read once the placement frame has run.
        const box = await row.info.evaluate((node) => new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => {
            const rect = node.getBoundingClientRect();
            resolve({ open: node.dataset.infoCardOpen === 'true', x: rect.x, y: rect.y, width: rect.width, height: rect.height });
          }));
        }));
        expect(box.open, `${width}x${height} ${filename} at y=${Math.round(y)} card is open`).toBe(true);
        expect(x < box.x || x > box.x + box.width || y < box.y || y > box.y + box.height,
          `${width}x${height} ${filename} at y=${Math.round(y)} card covers the pointer`).toBe(true);
      }
      expect(await page.evaluate(() => window.__titleToggles), `${width}x${height} ${filename} at y=${Math.round(y)}`).toBe(1);
      await moveAway(page);
      await expect(row.info).toBeHidden();
    }
  }

  // A pinned mid-viewport card keeps every detail reachable by scrolling
  // inside it, without dismissing it, and its action still works.
  await page.setViewportSize({ width: 375, height: 740 });
  await page.goto(baseURL + listPath);
  const row = rowParts(page, f.ids['01-alpha.png']);
  const pinBox = await row.title.boundingBox();
  await page.evaluate((delta) => window.scrollBy(0, delta), pinBox.y - 370);
  await row.title.click();
  await expect(row.info).toBeVisible();
  await expect(row.checkbox).not.toBeChecked();
  expect(await row.info.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
  const releases = row.info.locator('.asset-viewer-grid-card-info-section-label', { hasText: 'Releases' });
  await releases.scrollIntoViewIfNeeded();
  await expect(releases).toBeInViewport();
  await expect(row.info).toBeVisible();
  await row.info.evaluate((node) => { node.scrollTop = 0; });
  await row.info.getByRole('link', { name: 'Open asset' }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/projects/${f.id}/assets/${f.ids['01-alpha.png']}`);
});

// Defect fix: the List Modified column uses the same server-formatted value
// as the information card under either clock preference, and a missing
// timestamp keeps the muted dash.
test('Project Assets List Modified column matches the card under 12h and 24h', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createProject('Info Card Modified');
  const dated = f.ids['01-alpha.png'];
  const undated = f.ids['02-beta.png'];
  db.prepare('UPDATE assets SET modified_at = ? WHERE id = ?').run('2026-10-15T13:17:01.910Z', Number(dated));
  db.prepare('UPDATE assets SET modified_at = NULL WHERE id = ?').run(Number(undated));
  const clock = app.locals.clockFormatSettingsService;
  const original = clock.getClockFormat();
  try {
    for (const [preference, pattern] of [['12h', /^2026-10-1[456] \d{1,2}:\d{2} [AP]M$/], ['24h', /^2026-10-1[456] \d{2}:\d{2}$/]]) {
      clock.setClockFormat(preference);
      await page.goto(baseURL + `/projects/${f.id}/assets?category=${f.categoryId}&view=list`);
      const row = rowParts(page, dated);
      const cell = row.card.locator('.asset-list-cell--modified dd');
      const text = (await cell.textContent()).trim();
      expect(text, preference).toMatch(pattern);
      await row.title.click();
      await expect(row.info.locator('.asset-viewer-grid-card-info-row', { has: page.locator('dt', { hasText: /^Modified$/ }) }).locator('dd')).toHaveText(text);
      await page.keyboard.press('Escape');
      await expect(rowParts(page, undated).card.locator('.asset-list-cell--modified dd')).toHaveText('—');
    }
  } finally {
    clock.setClockFormat(original);
  }
});
