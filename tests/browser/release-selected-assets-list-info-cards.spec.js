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
import { createReleaseService } from '../../src/services/release-service.js';

// Release Detail Selected Assets List title information cards in real
// Chromium: the shared Dashboard hover/pin lifecycle on a read-only list,
// with release Role and stored Order. All data lives in a temporary root that
// is removed afterward.
const IMAGES = Array.from({ length: 10 }, (_, index) => `${String(index + 1).padStart(2, '0')}-image.png`);
const EXTRAS = ['11-clip.mp4', '12-broken.png', '13-gone.png'];

let server;
let db;
let app;
let root;
let projectsRoot;
let baseURL;
let releaseService;

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-release-list-info-browser-'));
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
  releaseService = createReleaseService({ db });
});

test.afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (db) closeDatabase(db);
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

// A release selecting every file in reverse filename order, so the stored
// Order differs from the filename order, with the first row as Primary.
async function createRelease(title) {
  const project = app.locals.projectService.create({ title, status: 'tbd' });
  const categories = app.locals.projectAssetCategoryService;
  if (!categories.list(project.id).some((candidate) => candidate.directory_slug === 'wip')) {
    categories.add(project.id, { displayName: 'WIP', directorySlug: 'wip' });
  }
  const categoryDir = path.join(projectsRoot, project.project_dir, 'wip');
  fs.mkdirSync(categoryDir, { recursive: true });
  for (const [index, filename] of IMAGES.entries()) {
    await sharp({ create: { width: 40, height: 24, channels: 3,
      background: { r: index * 20, g: 90, b: 160 } } }).png().toFile(path.join(categoryDir, filename));
  }
  fs.writeFileSync(path.join(categoryDir, EXTRAS[0]), Buffer.from('not really a video'));
  fs.writeFileSync(path.join(categoryDir, EXTRAS[1]), Buffer.from('not really a png'));
  fs.writeFileSync(path.join(categoryDir, EXTRAS[2]), Buffer.from('soon missing'));
  app.locals.assetScanner.scanProjectAssets(project.id);
  const ids = Object.fromEntries(db.prepare('SELECT filename, id FROM assets WHERE project_id = ?')
    .all(project.id).map((row) => [row.filename, row.id]));
  const ordered = [...IMAGES, ...EXTRAS].reverse().map((filename) => ids[filename]);
  const release = releaseService.createReleaseWithSelectedAssets(project.id, { title: `${title} Release` }, ordered);
  db.prepare('UPDATE release_assets SET role = ? WHERE release_id = ? AND asset_id = ?')
    .run('primary', release.id, ordered[0]);
  fs.rmSync(path.join(categoryDir, EXTRAS[2]));
  app.locals.assetScanner.scanProjectAssets(project.id);
  const sortOrder = Object.fromEntries(db.prepare('SELECT asset_id, sort_order FROM release_assets WHERE release_id = ?')
    .all(release.id).map((row) => [row.asset_id, row.sort_order]));
  return { projectId: project.id, releaseId: release.id, ids, sortOrder };
}

function rowParts(page, assetId) {
  const card = page.locator(`article.asset-list-card--release[data-asset-id="${assetId}"]`);
  return {
    card,
    title: card.locator('[data-calendar-info-trigger]'),
    info: page.locator(`#release-asset-list-info-${assetId}`),
  };
}

// The right edge: at desktop widths the left sidebar expands on hover and
// would cover the titles.
async function moveAway(page) {
  const { width } = page.viewportSize();
  await page.mouse.move(width - 4, 4, { steps: 3 });
}

const currentPath = (page) => {
  const url = new URL(page.url());
  return url.pathname + url.search;
};

test('Selected asset titles hover, pin, dismiss and open the asset without navigating the page', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createRelease('Release Info Interactions');
  const listPath = `/releases/${f.releaseId}?view=list`;
  await page.goto(baseURL + listPath);

  // The read-only eight-column layout in the Dashboard panel; Modified is last.
  const header = page.locator('[data-selected-assets] .asset-list-header .asset-list-cell');
  await expect(header).toHaveText(['Order', 'Asset', 'Category', 'Role', 'Type', 'Presence', 'Size', 'Modified']);
  await expect(page.locator('[data-selected-assets] .asset-list-cell--actions')).toHaveCount(0);
  await expect(page.locator('[data-selected-assets] .dashboard-panel .dashboard-table-scroll')).toHaveCount(1);
  // The inline Grid style dropdown is presentation-only and is excluded.
  await expect(page.locator('[data-selected-assets] input:not(.asset-grid-style-field *), [data-selected-assets] select:not(.asset-grid-style-field *), [data-selected-assets] [draggable="true"]')).toHaveCount(0);

  const assetId = f.ids['09-image.png'];
  const { card, title, info } = rowParts(page, assetId);
  await expect(card.locator('.asset-list-cell--order')).toContainText(String(f.sortOrder[assetId]));

  // Transient hover follows the pointer and closes when it leaves.
  await title.scrollIntoViewIfNeeded();
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

  // A click pins the card beside the title; clicks inside keep it open and
  // never navigate.
  await title.click();
  await expect(info).toBeVisible();
  expect(currentPath(page)).toBe(listPath);
  await moveAway(page);
  await expect(info).toBeVisible();
  const pinnedBox = await info.boundingBox();
  const anchoredTitle = await title.boundingBox();
  expect(pinnedBox.y >= anchoredTitle.y + anchoredTitle.height
    || pinnedBox.y + pinnedBox.height <= anchoredTitle.y).toBe(true);
  await expect(info.locator('.calendar-release-info-media')).toHaveAttribute('data-preview-state', /^(loaded|failed)$/);
  await expect(info.locator('.asset-list-info-filename')).toHaveText('09-image.png');
  await expect(info.locator('.asset-list-info-path')).toHaveText(/wip[\\/]09-image\.png$/);
  const facts = Object.fromEntries(await info.locator('.asset-viewer-grid-card-info-row').evaluateAll((rows) => rows
    .map((row) => [row.querySelector('dt').textContent.trim(), row.querySelector('dd').textContent.trim().replace(/\s+/g, ' ')])));
  expect(facts).toMatchObject({
    Presence: 'Present', Category: 'WIP', Role: 'Attachment', Order: String(f.sortOrder[assetId]), Type: 'PNG (.png)',
  });
  expect(facts.Size).toMatch(/\d/);
  expect(facts.Modified).toMatch(/^\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}/);
  await info.locator('.asset-list-info-path').click();
  await info.locator('.asset-viewer-grid-card-info-heading').click();
  await expect(info).toBeVisible();
  expect(currentPath(page)).toBe(listPath);

  // Re-click, outside click and Escape dismiss.
  await title.click();
  await expect(info).toBeHidden();
  await title.click();
  await expect(info).toBeVisible();
  await page.locator('.release-detail-list').click();
  await expect(info).toBeHidden();
  await title.click();
  await expect(info).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(info).toBeHidden();
  await expect(title).toBeFocused();

  // Only one card at a time; the Primary row reports its role.
  const primary = rowParts(page, f.ids['13-gone.png']);
  await title.click();
  await primary.title.click();
  await expect(primary.info).toBeVisible();
  await expect(info).toBeHidden();
  await expect(primary.info).toContainText('Primary');
  await expect(primary.card.locator('.asset-list-cell--role')).toContainText('Primary');
  await page.keyboard.press('Escape');

  // Enter and Space activate the focused title.
  await title.focus();
  await page.keyboard.press('Enter');
  await expect(info).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(info).toBeHidden();
  await page.keyboard.press(' ');
  await expect(info).toBeVisible();
  await page.keyboard.press(' ');
  await expect(info).toBeHidden();
  await expect(title).toBeFocused();
  expect(currentPath(page)).toBe(listPath);

  // No Actions column: the row has no Details link.
  await expect(card.locator('.asset-details-link')).toHaveCount(0);

  // The pinned card's Open asset action navigates to the Asset Viewer.
  await title.click();
  await info.getByRole('link', { name: 'Open asset' }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/projects/${f.projectId}/assets/${assetId}`);
  expect(pageErrors).toEqual([]);
});

test('Missing, broken and video assets show placeholders, video keeps its preview, and views switch', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createRelease('Release Info Media');
  await page.goto(`${baseURL}/releases/${f.releaseId}?view=list`);

  const video = rowParts(page, f.ids['11-clip.mp4']);
  await video.title.click();
  await expect(video.info).toContainText('MP4 video — play it from the row thumbnail');
  expect(await video.info.locator('video, img').count()).toBe(0);
  expect(await page.locator('video').evaluateAll((nodes) => nodes.every((node) => node.paused && !node.autoplay))).toBe(true);
  await page.keyboard.press('Escape');
  // The row thumbnail keeps the shared video preview trigger.
  await expect(video.card.locator('[data-asset-video-preview-trigger]')).toHaveCount(1);

  const broken = rowParts(page, f.ids['12-broken.png']);
  await broken.title.click();
  await expect(broken.info.locator('[data-preview-fallback]')).toBeVisible();
  await page.keyboard.press('Escape');

  const missing = rowParts(page, f.ids['13-gone.png']);
  await expect(missing.card.locator('.asset-list-card-media-placeholder--missing')).toHaveCount(1);
  await missing.title.click();
  await expect(missing.info).toContainText('File missing at last scan');
  await page.keyboard.press('Escape');

  // An image thumbnail still links to the Asset Viewer.
  const image = rowParts(page, f.ids['01-image.png']);
  await expect(image.card.locator('.asset-list-card-media-link'))
    .toHaveAttribute('href', `/projects/${f.projectId}/assets/${f.ids['01-image.png']}`);

  // Grid has no title cards; List returns with the view query.
  await page.getByRole('link', { name: 'Grid view' }).click();
  await expect.poll(() => new URL(page.url()).searchParams.has('view')).toBe(false);
  await expect(page.locator('[data-selected-assets] .asset-grid')).toHaveCount(1);
  await expect(page.locator('[data-selected-assets] [data-calendar-info-trigger]')).toHaveCount(0);
  await page.getByRole('link', { name: 'List view' }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('view')).toBe('list');
  await image.title.click();
  await expect(image.info).toBeVisible();

  // Archived releases stay read-only and keep their cards.
  releaseService.archiveRelease(f.releaseId);
  await page.goto(`${baseURL}/releases/${f.releaseId}?view=list`);
  await expect(page.getByRole('link', { name: 'Manage Assets' })).toHaveCount(0);
  await expect(page.locator('[data-selected-assets] input:not(.asset-grid-style-field *), [data-selected-assets] form')).toHaveCount(0);
  await image.title.click();
  await expect(image.info.getByRole('link', { name: 'Open asset' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(image.info).toBeHidden();
});

test('Narrow hover cards never cover the pointer, and pinned cards scroll to every detail', async ({ page }) => {
  const f = await createRelease('Release Info Pointer');
  const listPath = `/releases/${f.releaseId}?view=list`;
  const assetId = f.ids['06-image.png'];
  for (const [width, height] of [[320, 740], [375, 740], [390, 844], [1280, 900]]) {
    await page.setViewportSize({ width, height });
    await page.goto(baseURL + listPath);
    if (width < 768) {
      const scroller = page.locator('[data-selected-assets] .asset-list-scroll');
      expect(await scroller.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    const row = rowParts(page, assetId);
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
      const y = titleBox.y + titleBox.height / 2;
      const label = `${width}x${height} title at y=${Math.round(y)}`;
      for (let step = 0; step < 4; step += 1) {
        const x = titleBox.x + 2 + step * Math.min(4, titleBox.width / 5);
        await page.mouse.move(x, y);
        const box = await row.info.evaluate((node) => new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => {
            const rect = node.getBoundingClientRect();
            resolve({ open: node.dataset.infoCardOpen === 'true', x: rect.x, y: rect.y, width: rect.width, height: rect.height });
          }));
        }));
        expect(box.open, `${label} card is open`).toBe(true);
        expect(x < box.x || x > box.x + box.width || y < box.y || y > box.y + box.height,
          `${label} card covers the pointer`).toBe(true);
        expect(box.x >= 0 && box.x + box.width <= width, `${label} card stays on screen`).toBe(true);
      }
      expect(await page.evaluate(() => window.__titleToggles), label).toBe(1);
      await moveAway(page);
      await expect(row.info).toBeHidden();
    }
  }

  // A pinned mid-viewport card keeps every detail reachable by scrolling
  // inside it, without dismissing it, and its action still works.
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto(baseURL + listPath);
  const row = rowParts(page, assetId);
  const pinBox = await row.title.boundingBox();
  await page.evaluate((delta) => window.scrollBy(0, delta), pinBox.y - 284);
  await row.title.click();
  await expect(row.info).toBeVisible();
  expect(await row.info.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
  const modified = row.info.locator('dt', { hasText: 'Modified' });
  await modified.scrollIntoViewIfNeeded();
  await expect(modified).toBeInViewport();
  await expect(row.info).toBeVisible();
  await row.info.evaluate((node) => { node.scrollTop = 0; });
  await row.info.getByRole('link', { name: 'Open asset' }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/projects/${f.projectId}/assets/${assetId}`);
});

// Defect fix: the List Modified column uses the same server-formatted value
// as the information card under either clock preference, and a missing
// timestamp keeps the muted dash.
test('Selected Assets List Modified column matches the card under 12h and 24h', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createRelease('Release Info Modified');
  const dated = f.ids['01-image.png'];
  const undated = f.ids['02-image.png'];
  db.prepare('UPDATE assets SET modified_at = ? WHERE id = ?').run('2026-10-15T13:17:01.910Z', Number(dated));
  db.prepare('UPDATE assets SET modified_at = NULL WHERE id = ?').run(Number(undated));
  const clock = app.locals.clockFormatSettingsService;
  const original = clock.getClockFormat();
  try {
    for (const [preference, pattern] of [['12h', /^2026-10-1[456] \d{1,2}:\d{2} [AP]M$/], ['24h', /^2026-10-1[456] \d{2}:\d{2}$/]]) {
      clock.setClockFormat(preference);
      await page.goto(baseURL + `/releases/${f.releaseId}?view=list`);
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
