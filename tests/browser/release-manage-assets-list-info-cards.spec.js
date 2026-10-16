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

// Release Manage Assets List title information cards in real Chromium: the
// shared Dashboard hover/pin lifecycle beside the membership checkboxes and
// Role controls, which the cards must never change. All data lives in a
// temporary root that is removed afterward.
const IMAGES = Array.from({ length: 10 }, (_, index) => `${String(index + 1).padStart(2, '0')}-image.png`);
const EXTRAS = ['11-clip.mp4', '12-broken.png', '13-gone.png'];
const SELECTED = ['01-image.png', '02-image.png', '11-clip.mp4', '13-gone.png'];

let server;
let db;
let app;
let root;
let projectsRoot;
let baseURL;
let releaseService;

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-release-manage-info-browser-'));
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

// A draft release selecting two images, a video and a file that goes
// missing, with the first image as Primary; every other file is a candidate.
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
    .all(project.id).map((row) => [row.filename, String(row.id)]));
  const release = releaseService.createReleaseWithSelectedAssets(project.id, { title: `${title} Release` },
    SELECTED.map((filename) => Number(ids[filename])));
  db.prepare('UPDATE release_assets SET role = ? WHERE release_id = ? AND asset_id = ?')
    .run('primary', release.id, Number(ids['01-image.png']));
  fs.rmSync(path.join(categoryDir, EXTRAS[2]));
  app.locals.assetScanner.scanProjectAssets(project.id);
  return { projectId: project.id, releaseId: release.id, ids };
}

function rowParts(page, assetId) {
  const card = page.locator(`article.asset-list-card--release[data-asset-id="${assetId}"]`);
  return {
    card,
    title: card.locator('[data-calendar-info-trigger]'),
    checkbox: card.locator('input[name="selectedAssetIds"]'),
    info: page.locator(`#release-manage-asset-list-info-${assetId}`),
  };
}

// The draft membership the Save form would submit: visible checkboxes plus
// the hidden off-page inputs.
const draftMembership = (page) => page.evaluate(() => {
  const ids = new Set();
  document.querySelectorAll('[data-release-assets-hidden-membership] input[name="selectedAssetIds"]')
    .forEach((input) => ids.add(input.value));
  document.querySelectorAll('[data-release-assets-live-region] input[name="selectedAssetIds"]:checked')
    .forEach((input) => ids.add(input.value));
  return [...ids].sort();
});

const savedMembership = (releaseId) => db.prepare('SELECT asset_id FROM release_assets WHERE release_id = ?')
  .all(releaseId).map((row) => String(row.asset_id)).sort();

const sorted = (values) => [...values].sort();

async function moveAway(page) {
  const { width } = page.viewportSize();
  await page.mouse.move(width - 4, 4, { steps: 3 });
}

const currentPath = (page) => {
  const url = new URL(page.url());
  return url.pathname + url.search;
};

async function liveSearch(page, value) {
  await page.getByRole('link', { name: 'Filter assets' }).click();
  await page.locator('#asset-search').fill(value);
  await expect.poll(() => new URL(page.url()).searchParams.get('search') || '').toBe(value);
  await page.keyboard.press('Escape');
}

test('Titles hover, pin and dismiss without touching membership, Role or navigation', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createRelease('Manage Info Interactions');
  const listPath = `/releases/${f.releaseId}/assets?view=list&pageSize=all`;
  await page.goto(baseURL + listPath);

  const header = page.locator('.asset-list-header .asset-list-cell');
  await expect(header).toHaveText(['', 'Asset', 'Category', 'Role', 'Order', 'Type', 'Presence', 'Size', 'Modified']);
  await expect(page.locator('.asset-list-cell--actions, .asset-details-link')).toHaveCount(0);
  const initial = sorted(SELECTED.map((name) => f.ids[name]));
  expect(await draftMembership(page)).toEqual(initial);

  const selected = rowParts(page, f.ids['02-image.png']);
  const candidate = rowParts(page, f.ids['05-image.png']);
  await expect(selected.card.locator('.asset-list-cell--role select[data-autosubmit]')).toHaveValue('attachment');
  await expect(selected.card.locator('.asset-list-cell--order')).not.toContainText('—');
  await expect(candidate.card.locator('.asset-list-cell--role')).toContainText('—');
  await expect(candidate.card.locator('.asset-list-cell--order')).toContainText('—');

  // Transient hover follows the pointer and closes when it leaves.
  const titleBox = await candidate.title.boundingBox();
  await page.mouse.move(titleBox.x + 3, titleBox.y + 3, { steps: 4 });
  await expect(candidate.info).toBeVisible();
  const hoverBox = await candidate.info.boundingBox();
  await page.mouse.move(titleBox.x + titleBox.width - 3, titleBox.y + titleBox.height - 3, { steps: 6 });
  await expect.poll(async () => (await candidate.info.boundingBox()).x !== hoverBox.x).toBe(true);
  await moveAway(page);
  await expect(candidate.info).toBeHidden();

  // Pin, click inside, re-click, outside click and Escape: membership and
  // the checkbox never change, and the page never navigates.
  for (const row of [candidate, selected]) {
    const before = await row.checkbox.isChecked();
    await row.title.click();
    await expect(row.info).toBeVisible();
    await moveAway(page);
    await expect(row.info).toBeVisible();
    const pinned = await row.info.boundingBox();
    const anchored = await row.title.boundingBox();
    expect(pinned.y >= anchored.y + anchored.height || pinned.y + pinned.height <= anchored.y).toBe(true);
    await row.info.locator('.asset-list-info-path').click();
    await row.info.locator('.asset-list-info-filename').click();
    await expect(row.info).toBeVisible();
    await row.title.click();
    await expect(row.info).toBeHidden();
    await row.title.click();
    await page.locator('.release-workflow-status').click();
    await expect(row.info).toBeHidden();
    await row.title.click();
    await page.keyboard.press('Escape');
    await expect(row.info).toBeHidden();
    await expect(row.title).toBeFocused();
    for (const key of ['Enter', 'Enter', ' ', ' ']) await page.keyboard.press(key);
    await expect(row.info).toBeHidden();
    await expect(row.title).toBeFocused();
    expect(await row.checkbox.isChecked()).toBe(before);
    expect(await draftMembership(page)).toEqual(initial);
    expect(currentPath(page)).toBe(listPath);
  }

  // Card contents: membership state, Role and Order only when selected.
  await selected.title.click();
  const facts = async (info) => Object.fromEntries(await info.locator('.asset-viewer-grid-card-info-row').evaluateAll((rows) => rows
    .map((row) => [row.querySelector('dt').textContent.trim(), row.querySelector('dd').textContent.trim().replace(/\s+/g, ' ')])));
  expect(await facts(selected.info)).toMatchObject({ Release: 'Selected', Role: 'Attachment', Presence: 'Present', Category: 'WIP', Type: 'PNG (.png)' });
  await expect(selected.info.locator('.calendar-release-info-media')).toHaveAttribute('data-preview-state', /^(loaded|failed)$/);
  await page.keyboard.press('Escape');
  await candidate.title.click();
  const candidateFacts = await facts(candidate.info);
  expect(candidateFacts).toMatchObject({ Release: 'Not selected' });
  expect(candidateFacts).not.toHaveProperty('Role');
  expect(candidateFacts).not.toHaveProperty('Order');
  expect(candidateFacts.Modified).toMatch(/^\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}/);
  await page.keyboard.press('Escape');

  const missing = rowParts(page, f.ids['13-gone.png']);
  await missing.title.click();
  await expect(missing.info).toContainText('File missing at last scan');
  await page.keyboard.press('Escape');
  const video = rowParts(page, f.ids['11-clip.mp4']);
  await video.title.click();
  await expect(video.info).toContainText('MP4 video — play it from the row thumbnail');
  expect(await video.info.locator('video, img').count()).toBe(0);
  await page.keyboard.press('Escape');
  await expect(video.card.locator('[data-asset-video-preview-trigger]')).toHaveCount(1);
  expect(await page.locator('video').evaluateAll((nodes) => nodes.every((node) => node.paused && !node.autoplay))).toBe(true);

  // Membership still changes through the checkbox and the row background,
  // including removing the selected missing asset.
  await candidate.checkbox.click();
  await missing.card.locator('.asset-list-cell--size').click();
  await expect(candidate.checkbox).toBeChecked();
  await expect(missing.checkbox).not.toBeChecked();
  const draft = sorted([...initial.filter((id) => id !== f.ids['13-gone.png']), f.ids['05-image.png']]);
  expect(await draftMembership(page)).toEqual(draft);
  // Title and card interaction on the toggled rows leaves the draft alone.
  await candidate.title.click();
  await candidate.info.locator('.asset-list-info-path').click();
  await page.keyboard.press('Escape');
  expect(await draftMembership(page)).toEqual(draft);

  // Open asset navigates to the Asset Viewer.
  await candidate.title.click();
  await candidate.info.getByRole('link', { name: 'Open asset' }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/projects/${f.projectId}/assets/${f.ids['05-image.png']}`);
  expect(savedMembership(f.releaseId)).toEqual(initial);
  expect(pageErrors).toEqual([]);
});

test('Live filtering and pagination rebind cards once and keep off-page selections', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createRelease('Manage Info Live');
  await page.goto(`${baseURL}/releases/${f.releaseId}/assets?view=list&pageSize=10`);
  const initial = sorted(SELECTED.map((name) => f.ids[name]));

  // Draft a selection, then filter it off the page.
  const picked = rowParts(page, f.ids['03-image.png']);
  await picked.checkbox.click();
  const draft = sorted([...initial, f.ids['03-image.png']]);
  await liveSearch(page, '07-image');
  // Selected missing assets stay listed under any filter so they remain
  // removable.
  await expect(page.locator('article.asset-list-card--release')).toHaveCount(2);
  await expect(rowParts(page, f.ids['13-gone.png']).checkbox).toBeChecked();
  await expect(picked.card).toHaveCount(0);
  expect(await draftMembership(page)).toEqual(draft);

  // The replaced row's title is bound exactly once: one click opens and
  // one click closes.
  const filtered = rowParts(page, f.ids['07-image.png']);
  await filtered.title.click();
  await expect(filtered.info).toBeVisible();
  await filtered.title.click();
  await expect(filtered.info).toBeHidden();
  await filtered.title.click();
  await filtered.info.locator('.asset-list-info-path').click();
  await page.keyboard.press('Escape');
  await expect(filtered.checkbox).not.toBeChecked();
  expect(await draftMembership(page)).toEqual(draft);

  // Clearing the filter and paging keep the draft and rebind every page.
  await liveSearch(page, '');
  await expect(picked.checkbox).toBeChecked();
  await page.locator('.pagination-next').click();
  await expect.poll(() => new URL(page.url()).searchParams.get('page')).toBe('2');
  expect(await draftMembership(page)).toEqual(draft);
  const paged = rowParts(page, f.ids['12-broken.png']);
  await paged.title.click();
  await expect(paged.info.locator('[data-preview-fallback]')).toBeVisible();
  await paged.title.click();
  await expect(paged.info).toBeHidden();
  await page.goBack();
  await expect.poll(() => new URL(page.url()).searchParams.get('page')).toBeNull();
  await expect(picked.checkbox).toBeChecked();
  await picked.title.click();
  await expect(picked.info).toBeVisible();
  await page.keyboard.press('Escape');

  // Compact/Large resize the thumbnails; the cards still work.
  const list = page.locator('.asset-list--release');
  const thumb = picked.card.locator('.asset-list-card-media');
  await expect(list).toHaveAttribute('data-list-size', 'large');
  expect(Math.round((await thumb.boundingBox()).width)).toBe(72);
  await page.locator('[data-asset-list-size-controls] [data-grid-size-slider]').fill('1');
  await expect(list).toHaveAttribute('data-list-size', 'compact');
  expect(Math.round((await thumb.boundingBox()).width)).toBe(48);
  await picked.title.click();
  await expect(picked.info).toBeVisible();
  await page.keyboard.press('Escape');

  // Grid has no title cards; List returns with the view query.
  await page.getByRole('link', { name: 'Grid view' }).click();
  await expect(page.locator('[data-release-assets-live-region] .asset-grid')).toHaveCount(1);
  await expect(page.locator('[data-release-assets-live-region] [data-calendar-info-trigger]')).toHaveCount(0);
  await page.getByRole('link', { name: 'List view' }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('view')).toBe('list');
  await picked.title.click();
  await expect(picked.info).toBeVisible();
  await page.keyboard.press('Escape');

  // Save submits the draft, including the off-page selection.
  await page.getByRole('button', { name: 'Save Selection' }).click();
  await expect.poll(() => savedMembership(f.releaseId)).toEqual(draft);
  expect(pageErrors).toEqual([]);
});

test('Role autosubmit still works and read-only releases keep cards without controls', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createRelease('Manage Info Role');
  const listPath = `/releases/${f.releaseId}/assets?view=list&pageSize=all`;
  await page.goto(baseURL + listPath);
  const row = rowParts(page, f.ids['02-image.png']);
  await row.title.click();
  await expect(row.info).toBeVisible();
  await page.keyboard.press('Escape');
  await row.card.locator('.asset-list-cell--role select').selectOption('preview');
  await expect.poll(() => db.prepare('SELECT role FROM release_assets WHERE release_id = ? AND asset_id = ?')
    .get(f.releaseId, Number(f.ids['02-image.png'])).role).toBe('preview');

  for (const lock of ['published', 'archived']) {
    if (lock === 'published') {
      db.prepare("UPDATE releases SET published_date = '2026-01-01' WHERE id = ?").run(f.releaseId);
    } else {
      db.prepare('UPDATE releases SET published_date = NULL, archived_at = CURRENT_TIMESTAMP WHERE id = ?').run(f.releaseId);
    }
    await page.goto(baseURL + listPath);
    await expect(page.locator('.asset-list-header .asset-list-cell')).toHaveText(
      ['Asset', 'Category', 'Role', 'Order', 'Type', 'Presence', 'Size', 'Modified']);
    await expect(page.locator('[data-release-assets-live-region] input[name="selectedAssetIds"], [data-release-assets-live-region] select, [data-release-assets-live-region] form')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save Selection' })).toHaveCount(0);
    const locked = rowParts(page, f.ids['02-image.png']);
    await expect(locked.card.locator('.asset-list-cell--role')).toContainText('Preview');
    await locked.title.click();
    await expect(locked.info).toContainText('Selected');
    await expect(locked.info.getByRole('link', { name: 'Open asset' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(locked.info).toBeHidden();
    await expect(locked.card.locator('.asset-list-card-media-link')).toHaveAttribute('href', `/projects/${f.projectId}/assets/${f.ids['02-image.png']}`);
  }
});

test('Narrow hover cards never cover the pointer, and pinned cards scroll without changing membership', async ({ page }) => {
  const f = await createRelease('Manage Info Pointer');
  const listPath = `/releases/${f.releaseId}/assets?view=list`;
  const assetId = f.ids['06-image.png'];
  for (const [width, height] of [[320, 740], [375, 740], [390, 844], [1280, 900]]) {
    await page.setViewportSize({ width, height });
    await page.goto(baseURL + listPath);
    if (width < 768) {
      const scroller = page.locator('.asset-list-scroll');
      expect(await scroller.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
      // The List panel fits the viewport and scrolls internally. (The page
      // heading's back-link pair overflows narrow viewports independently
      // of the List, in Grid as well, so the document width is not checked.)
      expect(await page.locator('.asset-list-panel').evaluate((node) => node.getBoundingClientRect().right <= window.innerWidth)).toBe(true);
    }
    const row = rowParts(page, assetId);
    // The top-edge case sits just below any fixed or sticky top bar, which
    // would otherwise take the pointer instead of the title.
    const topInset = await page.evaluate(() => Math.max(0, ...Array.from(document.querySelectorAll('body *'))
      .filter((node) => ['fixed', 'sticky'].includes(getComputedStyle(node).position))
      .map((node) => node.getBoundingClientRect())
      .filter((rect) => rect.top <= 0 && rect.width > window.innerWidth / 2 && rect.height < window.innerHeight / 3)
      .map((rect) => rect.bottom)));
    for (const targetY of [topInset + 24, height / 2, height - 32]) {
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

  // A pinned mid-viewport card scrolls to every detail; clicks inside it
  // never toggle the row, and Open asset still works.
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto(baseURL + listPath);
  const initial = await draftMembership(page);
  const row = rowParts(page, assetId);
  const pinBox = await row.title.boundingBox();
  await page.evaluate((delta) => window.scrollBy(0, delta), pinBox.y - 284);
  await row.title.click();
  await expect(row.info).toBeVisible();
  expect(await row.info.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
  const modified = row.info.locator('dt', { hasText: 'Modified' });
  await modified.scrollIntoViewIfNeeded();
  await expect(modified).toBeInViewport();
  await modified.click();
  await expect(row.info).toBeVisible();
  await expect(row.checkbox).not.toBeChecked();
  expect(await draftMembership(page)).toEqual(initial);
  await row.info.evaluate((node) => { node.scrollTop = 0; });
  await row.info.getByRole('link', { name: 'Open asset' }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/projects/${f.projectId}/assets/${assetId}`);
});

// Defect fix: the List Modified column uses the same server-formatted value
// as the information card under either clock preference, and a missing
// timestamp keeps the muted dash.
test('Manage Assets List Modified column matches the card under 12h and 24h', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createRelease('Manage Info Modified');
  const dated = f.ids['05-image.png'];
  const undated = f.ids['06-image.png'];
  db.prepare('UPDATE assets SET modified_at = ? WHERE id = ?').run('2026-10-15T13:17:01.910Z', Number(dated));
  db.prepare('UPDATE assets SET modified_at = NULL WHERE id = ?').run(Number(undated));
  const clock = app.locals.clockFormatSettingsService;
  const original = clock.getClockFormat();
  try {
    for (const [preference, pattern] of [['12h', /^2026-10-1[456] \d{1,2}:\d{2} [AP]M$/], ['24h', /^2026-10-1[456] \d{2}:\d{2}$/]]) {
      clock.setClockFormat(preference);
      await page.goto(baseURL + `/releases/${f.releaseId}/assets?view=list&pageSize=all`);
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

// Defect fix: the information card follows the draft membership, not the
// saved one. Unsaved changes are marked, stored Role/Order never appear for an
// unsaved addition, and stay labelled as saved values while a saved selection
// is pending removal — across live filtering, pagination, history and Save.
test('Information cards follow unsaved draft membership', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const f = await createRelease('Manage Info Draft');
  const listPath = `/releases/${f.releaseId}/assets?view=list&pageSize=10`;
  await page.goto(baseURL + listPath);
  const initial = sorted(SELECTED.map((name) => f.ids[name]));

  // Visible fact rows only: hidden stored facts must not read as current.
  const cardFacts = async (row) => {
    await row.title.click();
    await expect(row.info).toBeVisible();
    const facts = Object.fromEntries(await row.info.locator('.asset-viewer-grid-card-info-row').evaluateAll((rows) => rows
      .filter((node) => !node.hidden)
      .map((node) => [node.querySelector('dt').textContent.trim(), node.querySelector('dd').textContent.trim()])));
    await page.keyboard.press('Escape');
    await expect(row.info).toBeHidden();
    return facts;
  };
  const membershipFacts = async (row) => {
    const facts = await cardFacts(row);
    return Object.fromEntries(['Release', 'Role', 'Order', 'Saved role', 'Saved order']
      .filter((key) => key in facts).map((key) => [key, facts[key]]));
  };

  const added = rowParts(page, f.ids['05-image.png']);
  const removed = rowParts(page, f.ids['02-image.png']);
  const missing = rowParts(page, f.ids['13-gone.png']);
  const savedOrder = String(db.prepare('SELECT sort_order FROM release_assets WHERE release_id = ? AND asset_id = ?')
    .get(f.releaseId, Number(f.ids['02-image.png'])).sort_order);
  expect(await membershipFacts(added)).toEqual({ Release: 'Not selected' });
  expect(await membershipFacts(removed)).toEqual({ Release: 'Selected', Role: 'Attachment', Order: savedOrder });

  // Pin both cards first, then change membership: reopening shows the draft.
  await added.title.click();
  await page.keyboard.press('Escape');
  await removed.title.click();
  await page.keyboard.press('Escape');
  await added.checkbox.click();
  await removed.card.locator('.asset-list-cell--size').click();
  await expect(added.card).toHaveAttribute('aria-selected', 'true');
  await expect(removed.card).toHaveAttribute('aria-selected', 'false');
  const addedDraft = { Release: 'Selected (unsaved)' };
  const removedDraft = { Release: 'Not selected (unsaved)', 'Saved role': 'Attachment', 'Saved order': savedOrder };
  expect(await membershipFacts(added)).toEqual(addedDraft);
  expect(await membershipFacts(removed)).toEqual(removedDraft);

  // An open pinned card updates in place when its checkbox changes.
  await added.title.click();
  await added.checkbox.focus();
  await page.keyboard.press(' ');
  await expect(added.checkbox).not.toBeChecked();
  await expect(added.info.locator('[data-release-asset-membership-status]')).toHaveText('Not selected');
  await page.keyboard.press(' ');
  await expect(added.checkbox).toBeChecked();
  await expect(added.info.locator('[data-release-asset-membership-status]')).toHaveText('Selected (unsaved)');
  await page.keyboard.press('Escape');

  // Re-selecting a saved asset returns it to its saved state and labels.
  await removed.checkbox.click();
  expect(await membershipFacts(removed)).toEqual({ Release: 'Selected', Role: 'Attachment', Order: savedOrder });
  await removed.checkbox.click();

  // Live replacement (filtering) restores the draft into the new cards. The
  // selected missing asset stays listed, removable, and its card follows.
  await liveSearch(page, '05-image');
  await expect(page.locator('article.asset-list-card--release')).toHaveCount(2);
  expect(await membershipFacts(added)).toEqual(addedDraft);
  expect(await membershipFacts(missing)).toMatchObject({ Release: 'Selected', Role: 'Attachment' });
  await missing.checkbox.click();
  await expect(missing.checkbox).not.toBeChecked();
  expect(await membershipFacts(missing)).toMatchObject({ Release: 'Not selected (unsaved)', 'Saved role': 'Attachment' });
  const draft = sorted([...initial.filter((id) => id !== f.ids['02-image.png'] && id !== f.ids['13-gone.png']),
    f.ids['05-image.png']]);
  expect(await draftMembership(page)).toEqual(draft);
  await liveSearch(page, '');
  expect(await membershipFacts(removed)).toEqual(removedDraft);

  // Pagination and Back/Forward keep the draft in the cards.
  await page.locator('.pagination-next').click();
  await expect.poll(() => new URL(page.url()).searchParams.get('page')).toBe('2');
  await page.goBack();
  await expect.poll(() => new URL(page.url()).searchParams.get('page')).toBeNull();
  expect(await membershipFacts(added)).toEqual(addedDraft);
  expect(await membershipFacts(removed)).toEqual(removedDraft);
  await page.goForward();
  await expect.poll(() => new URL(page.url()).searchParams.get('page')).toBe('2');
  await page.goBack();
  await expect.poll(() => new URL(page.url()).searchParams.get('page')).toBeNull();
  expect(await membershipFacts(added)).toEqual(addedDraft);

  // Card interactions never changed membership; nothing was saved yet.
  expect(await draftMembership(page)).toEqual(draft);
  expect(savedMembership(f.releaseId)).toEqual(initial);

  // Save persists the draft; the cards then show plain saved state.
  await page.getByRole('button', { name: 'Save Selection' }).click();
  await expect.poll(() => savedMembership(f.releaseId)).toEqual(draft);
  await page.goto(baseURL + listPath);
  const addedFacts = await membershipFacts(added);
  expect(addedFacts).toMatchObject({ Release: 'Selected', Role: 'Attachment' });
  expect(addedFacts.Order).toMatch(/^\d+$/);
  expect(await membershipFacts(removed)).toEqual({ Release: 'Not selected' });

  // Read-only releases show persisted membership without draft markers.
  db.prepare("UPDATE releases SET published_date = '2026-01-01' WHERE id = ?").run(f.releaseId);
  await page.goto(baseURL + listPath);
  const locked = await membershipFacts(rowParts(page, f.ids['05-image.png']));
  expect(locked).toMatchObject({ Release: 'Selected', Role: 'Attachment' });
  expect(pageErrors).toEqual([]);
});
