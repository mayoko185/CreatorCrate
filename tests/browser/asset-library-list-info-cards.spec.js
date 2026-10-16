import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import sharp from 'sharp';
import yazl from 'yazl';
import { createApp } from '../../src/app.js';
import { createAssetManifest } from '../../src/asset-manifest.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';
import { createReleaseService } from '../../src/services/release-service.js';

// Asset Library List in real Chromium: the eight Dashboard-style columns, the
// shared Dashboard title information card lifecycle on asset titles, and the
// navigation, slideshow, paging and live replacement around them. All data
// lives in a temporary root that is removed afterward.
const IMAGES = ['01-alpha.png', '02-beta.png', '03-gamma.png', '04-delta.png'];
// Extra images so the 10-per-page minimum leaves a second page.
const PAGING_IMAGES = ['10-epsilon.png', '11-zeta.png', '12-eta.png'];
const COLUMNS = ['Asset', 'Project', 'Category', 'Type', 'Presence', 'Releases', 'Size', 'Modified'];

let server;
let db;
let app;
let root;
let projectsRoot;
let baseURL;
let fixture;

function kritaArchive(merged) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from('application/x-krita'), 'mimetype', { compress: false });
    zip.addBuffer(merged, 'mergedimage.png');
    zip.end();
    const chunks = [];
    zip.outputStream.on('data', (chunk) => chunks.push(chunk));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
  });
}

async function writeImage(directory, filename, index) {
  await sharp({ create: { width: 40, height: 24, channels: 3,
    background: { r: index * 40, g: 90, b: 160 } } }).png().toFile(path.join(directory, filename));
}

function createProject(title) {
  const project = app.locals.projectService.create({ title, status: 'tbd' });
  const categories = app.locals.projectAssetCategoryService;
  if (!categories.list(project.id).some((candidate) => candidate.directory_slug === 'wip')) {
    categories.add(project.id, { displayName: 'WIP', directorySlug: 'wip' });
  }
  const categoryDir = path.join(projectsRoot, project.project_dir, 'wip');
  fs.mkdirSync(categoryDir, { recursive: true });
  return { project, categoryDir };
}

// Library Alpha holds an ordinary image used in a release with a direct and
// an inherited tag, three more images, a Krita file, a (non-playable) video,
// an undecodable PNG and a file that goes missing. Library Beta holds one
// image so project navigation and filtering have a second project.
async function createFixture() {
  const alpha = createProject('Library Alpha');
  for (const [index, filename] of [...IMAGES, ...PAGING_IMAGES].entries()) await writeImage(alpha.categoryDir, filename, index);
  const merged = await sharp({ create: { width: 30, height: 30, channels: 3, background: { r: 200, g: 40, b: 40 } } }).png().toBuffer();
  fs.writeFileSync(path.join(alpha.categoryDir, '05-sketch.kra'), await kritaArchive(merged));
  fs.writeFileSync(path.join(alpha.categoryDir, '06-clip.mp4'), Buffer.from('not really a video'));
  fs.writeFileSync(path.join(alpha.categoryDir, '07-broken.png'), Buffer.from('not really a png'));
  fs.writeFileSync(path.join(alpha.categoryDir, '08-gone.png'), Buffer.from('soon missing'));
  app.locals.assetScanner.scanProjectAssets(alpha.project.id);
  fs.rmSync(path.join(alpha.categoryDir, '08-gone.png'));
  app.locals.assetScanner.scanProjectAssets(alpha.project.id);

  const beta = createProject('Library Beta');
  await writeImage(beta.categoryDir, '09-other.png', 5);
  app.locals.assetScanner.scanProjectAssets(beta.project.id);

  const ids = Object.fromEntries(db.prepare('SELECT filename, id FROM assets').all()
    .map((row) => [row.filename, String(row.id)]));
  const releaseService = createReleaseService({ db });
  const release = releaseService.createReleaseWithSelectedAssets(alpha.project.id, { title: 'Library Release' },
    [Number(ids['01-alpha.png'])]);
  const direct = app.locals.tagService.createTag({ name: 'Direct Tag' });
  const inherited = app.locals.tagService.createTag({ name: 'Project Tag' });
  app.locals.assetTagService.replaceAssetTags(Number(ids['01-alpha.png']), [direct.id]);
  app.locals.projectTagService.replaceProjectTags(alpha.project.id, [inherited.id]);
  return { alphaId: alpha.project.id, betaId: beta.project.id, releaseId: release.id, ids };
}

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-asset-library-list-browser-'));
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
  fixture = await createFixture();
});

test.afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (db) closeDatabase(db);
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

function rowParts(page, assetId) {
  const card = page.locator(`.asset-list--library article.asset-list-card[data-asset-id="${assetId}"]`);
  return {
    card,
    title: card.locator('[data-calendar-info-trigger]'),
    info: page.locator(`#asset-library-list-info-${assetId}`),
  };
}

// The top-right corner: away from the titles and from the left sidebar,
// which expands over the Asset column while hovered.
async function moveAway(page) {
  const { width } = page.viewportSize();
  await page.mouse.move(width - 4, 4, { steps: 3 });
}

const currentPath = (page) => {
  const url = new URL(page.url());
  return url.pathname + url.search;
};

// Canonical query order, so the redirect-free URL compares exactly.
const LIST_PATH = '/asset-viewer?sort=filename&order=asc&pageSize=all&view=list';

test('List renders eight aligned Dashboard columns with 48px thumbnails and Dashboard table styling', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(baseURL + '/');
  const dashboardHeader = page.locator('.dashboard-projects-table th').first();
  await expect(dashboardHeader).toBeVisible();
  const styleOf = (locator) => locator.evaluate((node) => {
    const style = getComputedStyle(node);
    return ['font-family', 'font-size', 'font-weight', 'letter-spacing', 'text-transform', 'color', 'background-color',
      'padding-top', 'padding-left', 'border-bottom-color', 'border-bottom-width']
      .map((name) => style.getPropertyValue(name)).join('|');
  });
  const panelOf = (locator) => locator.evaluate((node) => {
    const style = getComputedStyle(node);
    return [style.backgroundColor, style.borderTopColor, style.borderTopWidth, style.borderRadius].join('|');
  });
  const dashboardHeaderStyle = await styleOf(dashboardHeader);
  const dashboardPanel = await panelOf(page.locator('.dashboard-table-scroll').first());

  await page.goto(baseURL + LIST_PATH);
  const header = page.locator('.asset-list-table--library .asset-list-header .asset-list-cell');
  await expect(header).toHaveText(COLUMNS);
  expect(await styleOf(header.first())).toBe(dashboardHeaderStyle);
  expect(await panelOf(page.locator('.asset-list-scroll'))).toBe(dashboardPanel);
  await expect(page.locator('.asset-list--library input[type="checkbox"]')).toHaveCount(0);
  await expect(page.locator('.asset-list--library .asset-list-cell--actions, .asset-list--library .asset-details-link')).toHaveCount(0);

  // Every row cell starts on its header's column.
  const headerX = await header.evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().x)));
  const rows = page.locator('.asset-list--library article.asset-list-card');
  await expect(rows).toHaveCount(Object.keys(fixture.ids).length);
  for (const row of await rows.all()) {
    const cells = await row.locator(':scope > .asset-list-cell').evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().x)));
    expect(cells).toEqual(headerX);
  }

  const alpha = rowParts(page, fixture.ids['01-alpha.png']);
  const thumb = alpha.card.locator('.asset-list-card-media');
  const thumbBox = await thumb.boundingBox();
  expect([Math.round(thumbBox.width), Math.round(thumbBox.height)]).toEqual([48, 48]);
  expect(await alpha.card.locator('.asset-list-card-media-image').evaluate((node) => getComputedStyle(node).objectFit)).toBe('contain');
  await expect(rowParts(page, fixture.ids['05-sketch.kra']).card.locator('.asset-list-card-media')).toHaveClass(/asset-media--krita/);
  await expect(rowParts(page, fixture.ids['08-gone.png']).card.locator('.asset-list-card-media-placeholder--missing')).toBeVisible();
  await expect(rowParts(page, fixture.ids['06-clip.mp4']).card.locator('.asset-video-link')).toBeVisible();
  await expect(alpha.card.locator('.asset-list-cell--project a')).toHaveText('Library Alpha');
  await expect(alpha.card.locator('.asset-list-cell--type')).toContainText('PNG');
  await expect(alpha.card.locator('.asset-list-cell--releases [aria-label="Used in 1 release"]')).toBeVisible();

  // Row hover uses the Dashboard row highlight.
  const surfaceHover = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.background = 'var(--surface-hover)';
    document.body.append(probe);
    const value = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return value;
  });
  await alpha.card.locator('.asset-list-cell--size').hover();
  await expect.poll(() => alpha.card.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(surfaceHover);
});

test('Titles hover, pin and dismiss through the shared lifecycle without navigating', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(baseURL + LIST_PATH);
  const { card, title, info } = rowParts(page, fixture.ids['01-alpha.png']);

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

  // Click pins under the title; clicks inside keep it and never navigate.
  await title.click();
  await expect(info).toBeVisible();
  await moveAway(page);
  await expect(info).toBeVisible();
  const pinnedBox = await info.boundingBox();
  const anchored = await title.boundingBox();
  expect(pinnedBox.y >= anchored.y + anchored.height || pinnedBox.y + pinnedBox.height <= anchored.y).toBe(true);
  await info.locator('.asset-list-info-path').click();
  await expect(info).toBeVisible();
  expect(currentPath(page)).toBe(LIST_PATH);

  // Card contents for an ordinary image in a release with direct and
  // inherited tags.
  const fact = (label) => info.locator('.asset-viewer-grid-card-info-row', { has: page.locator('dt', { hasText: new RegExp(`^${label}$`) }) }).locator('dd');
  await expect(info.locator('.asset-list-info-filename')).toHaveText('01-alpha.png');
  await expect(fact('Path')).toHaveText('wip/01-alpha.png');
  await expect(fact('Project')).toHaveText('Library Alpha');
  await expect(fact('Project status')).not.toBeEmpty();
  await expect(fact('Category')).toHaveText('WIP');
  await expect(fact('Type')).toHaveText('PNG (.png)');
  await expect(fact('Presence')).toHaveText('Present');
  await expect(fact('Size')).toHaveText(/^\S+ \S+ \(\d+ bytes\)$/);
  await expect(info.locator('.calendar-release-info-media')).toHaveAttribute('data-preview-state', /^(loaded|failed)$/);
  await expect(info.locator('.asset-viewer-grid-card-info-tags')).toContainText('Direct Tag');
  await expect(info.locator('.asset-viewer-grid-card-info-tags li', { hasText: 'Project Tag' }).locator('.asset-tag-origin')).toHaveText(/Project/);
  await expect(info.getByRole('link', { name: 'Library Release' })).toHaveAttribute('href', `/releases/${fixture.releaseId}`);

  // Re-click, outside click and Escape dismiss; Escape keeps title focus.
  await title.click();
  await expect(info).toBeHidden();
  await title.click();
  await expect(info).toBeVisible();
  await page.locator('.results-meta').click();
  await expect(info).toBeHidden();
  await title.click();
  await page.keyboard.press('Escape');
  await expect(info).toBeHidden();
  await expect(title).toBeFocused();

  // Only one card at a time. A pinned card can cover neighbouring rows, so
  // the second title is activated from the keyboard.
  const other = rowParts(page, fixture.ids['04-delta.png']);
  await other.title.click();
  await expect(other.info).toBeVisible();
  await title.focus();
  await page.keyboard.press('Enter');
  await expect(info).toBeVisible();
  await expect(other.info).toBeHidden();
  await page.keyboard.press('Escape');

  // Enter and Space activate the title.
  await title.focus();
  await page.keyboard.press('Enter');
  await expect(info).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(info).toBeHidden();
  await page.keyboard.press('Space');
  await expect(info).toBeVisible();
  await page.keyboard.press('Space');
  await expect(info).toBeHidden();
  await expect(title).toBeFocused();
  expect(currentPath(page)).toBe(LIST_PATH);

  // Open project from the card, then Open asset; Back restores a bound List.
  await title.click();
  await info.getByRole('link', { name: 'Open project' }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/projects/${fixture.alphaId}`);
  await page.goBack();
  await expect(page.locator('.asset-list--library')).toBeVisible();
  await title.click();
  await expect(info).toBeVisible();
  await info.getByRole('link', { name: 'Open asset' }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/projects/${fixture.alphaId}/assets/${fixture.ids['01-alpha.png']}`);
  await page.goBack();

  // The Project column keeps its navigation; modified clicks on real links
  // stay native (no same-tab navigation).
  await card.locator('.asset-list-cell--project a').click({ modifiers: ['Control'] });
  expect(currentPath(page)).toBe(LIST_PATH);
  await card.locator('.asset-list-cell--project a').click();
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/projects/${fixture.alphaId}`);
  await page.goBack();
  await expect(page.locator('.asset-list--library')).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('Media states, thumbnail slideshow and video stay on their existing paths', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(baseURL + LIST_PATH);

  const video = rowParts(page, fixture.ids['06-clip.mp4']);
  await video.title.click();
  await expect(video.info).toContainText('MP4 video — play it from the row thumbnail');
  expect(await video.info.locator('video, img').count()).toBe(0);
  expect(await page.locator('video').evaluateAll((nodes) => nodes.every((node) => node.paused && !node.autoplay))).toBe(true);
  await page.keyboard.press('Escape');

  const broken = rowParts(page, fixture.ids['07-broken.png']);
  await broken.title.click();
  await expect(broken.info.locator('[data-preview-fallback]')).toBeVisible();
  await page.keyboard.press('Escape');

  const missing = rowParts(page, fixture.ids['08-gone.png']);
  await missing.title.click();
  await expect(missing.info).toContainText('File missing at last scan');
  await expect(missing.info.locator('img')).toHaveCount(0);
  await expect(missing.info.getByRole('link', { name: 'Open asset' })).toBeVisible();
  await page.keyboard.press('Escape');

  const krita = rowParts(page, fixture.ids['05-sketch.kra']);
  await krita.title.click();
  await expect(krita.info.locator('.asset-viewer-grid-card-info-row', { has: page.locator('dt', { hasText: /^Type$/ }) })).toContainText('KRA (.kra)');
  await page.keyboard.press('Escape');

  // An image thumbnail opens the slideshow, not navigation.
  await rowParts(page, fixture.ids['02-beta.png']).card.locator('a[data-project-assets-preview-id]').click();
  await expect(page.locator('[data-slideshow-scaffold]')).toBeVisible();
  expect(currentPath(page)).toBe(LIST_PATH);
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-slideshow-scaffold]')).toBeHidden();

  // NSFW tags blur the row thumbnail and the card preview.
  const nsfw = app.locals.tagService.createTag({ name: 'NSFW' });
  app.locals.assetTagService.replaceAssetTags(Number(fixture.ids['03-gamma.png']), [nsfw.id]);
  app.locals.nsfwFilterSettingsService.setEnabled(true);
  try {
    await page.goto(baseURL + LIST_PATH);
    const gamma = rowParts(page, fixture.ids['03-gamma.png']);
    await expect(gamma.card.locator('.asset-list-card-media-image')).toHaveClass(/asset-image--nsfw-blurred/);
    await expect(gamma.info.locator('.calendar-release-info-image')).toHaveClass(/project-image--nsfw-blurred/);
    await expect(rowParts(page, fixture.ids['02-beta.png']).card.locator('.asset-list-card-media-image')).not.toHaveClass(/nsfw/);
  } finally {
    app.locals.nsfwFilterSettingsService.setEnabled(false);
    app.locals.assetTagService.replaceAssetTags(Number(fixture.ids['03-gamma.png']), []);
  }
});

test('Pagination, View all, sorting, filtering and Back/Forward replace rows with bound titles', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const total = Object.keys(fixture.ids).length;
  await page.goto(`${baseURL}/asset-viewer?view=list&sort=filename&order=asc&pageSize=10`);
  await page.evaluate(() => { window.__assetLibraryMarker = true; });
  const rows = page.locator('.asset-list--library article.asset-list-card');
  await expect(rows).toHaveCount(10);

  // Live Next replaces the rows; the new page's titles are bound.
  await page.locator('nav.pagination a[rel="next"]').click();
  await expect(rows).toHaveCount(total - 10);
  expect(await page.evaluate(() => window.__assetLibraryMarker)).toBe(true);
  expect(new URL(page.url()).searchParams.get('page')).toBe('2');
  const last = rowParts(page, fixture.ids['12-eta.png']);
  const lastBox = await last.title.boundingBox();
  await page.mouse.move(lastBox.x + 3, lastBox.y + 3, { steps: 3 });
  await expect(last.info).toBeVisible();
  await moveAway(page);
  await expect(last.info).toBeHidden();

  // Back restores page one with bound titles; Forward returns to page two.
  await page.goBack();
  await expect(rows).toHaveCount(10);
  await rowParts(page, fixture.ids['01-alpha.png']).title.click();
  await expect(rowParts(page, fixture.ids['01-alpha.png']).info).toBeVisible();
  await page.keyboard.press('Escape');
  await page.goForward();
  await expect(rows).toHaveCount(total - 10);
  await last.title.click();
  await expect(last.info).toBeVisible();
  await page.keyboard.press('Escape');

  // View all and descending filename order.
  await page.goto(`${baseURL}/asset-viewer?view=list&sort=filename&order=desc&pageSize=all`);
  await expect(rows).toHaveCount(total);
  await expect(page.locator('nav.pagination')).toHaveCount(0);
  await expect(rows.first().locator('[data-calendar-info-trigger]')).toHaveText('12-eta.png');

  // Presence and release-usage filters.
  await page.goto(`${baseURL}/asset-viewer?view=list&presence=missing&pageSize=all`);
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator('[data-calendar-info-trigger]')).toHaveText('08-gone.png');
  await page.goto(`${baseURL}/asset-viewer?view=list&usage=used&pageSize=all`);
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator('[data-calendar-info-trigger]')).toHaveText('01-alpha.png');

  // Project filter, then a live switch to Grid and back to List.
  await page.goto(`${baseURL}/asset-viewer?view=list&project=${fixture.betaId}&pageSize=all`);
  await page.evaluate(() => { window.__assetLibraryMarker = true; });
  await expect(rows).toHaveCount(1);
  await page.locator('nav.view-switcher a[aria-label$="Grid view"]').click();
  await expect(page.locator('.asset-grid')).toBeVisible();
  await expect(page.locator('.asset-list-table')).toHaveCount(0);
  await page.locator('nav.view-switcher a[aria-label$="List view"]').click();
  await expect(rows).toHaveCount(1);
  expect(await page.evaluate(() => window.__assetLibraryMarker)).toBe(true);
  const other = rowParts(page, fixture.ids['09-other.png']);
  await other.title.click();
  await expect(other.info).toBeVisible();
  await expect(other.info.getByRole('link', { name: 'Open project' })).toHaveAttribute('href', `/projects/${fixture.betaId}`);
  await page.keyboard.press('Escape');
  await page.goBack();
  await expect(page.locator('.asset-grid')).toBeVisible();
  await page.goForward();
  await expect(rows).toHaveCount(1);
  await other.title.click();
  await expect(other.info).toBeVisible();
});

test('Narrow hover cards never cover the pointer; pinned cards scroll and the table scrolls sideways', async ({ page }) => {
  const pageWidth = () => page.evaluate(() => document.documentElement.scrollWidth);
  for (const [width, height] of [[320, 740], [375, 740], [390, 844]]) {
    await page.setViewportSize({ width, height });
    // The List scrolls inside its own region and adds no page width beyond
    // the Grid page's at the same size.
    await page.goto(baseURL + LIST_PATH.replace('view=list', 'view=grid'));
    const gridPageWidth = await pageWidth();
    await page.goto(baseURL + LIST_PATH);
    const scroller = page.locator('.asset-list-scroll');
    expect(await scroller.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
    expect(await pageWidth()).toBeLessThanOrEqual(Math.max(gridPageWidth, width));
    expect(await scroller.evaluate((node) => node.getBoundingClientRect().right <= window.innerWidth)).toBe(true);
    const row = rowParts(page, fixture.ids['01-alpha.png']);
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
      for (let step = 0; step < 4; step += 1) {
        const x = titleBox.x + 2 + step * Math.min(4, titleBox.width / 5);
        await page.mouse.move(x, y);
        const box = await row.info.evaluate((node) => new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => {
            const rect = node.getBoundingClientRect();
            resolve({ open: node.dataset.infoCardOpen === 'true', x: rect.x, y: rect.y, width: rect.width, height: rect.height });
          }));
        }));
        expect(box.open, `${width}x${height} at y=${Math.round(y)} card is open`).toBe(true);
        expect(x < box.x || x > box.x + box.width || y < box.y || y > box.y + box.height,
          `${width}x${height} at y=${Math.round(y)} card covers the pointer`).toBe(true);
        expect(box.x >= 0 && box.x + box.width <= width, `${width}x${height} card stays on screen`).toBe(true);
      }
      expect(await page.evaluate(() => window.__titleToggles), `${width}x${height} at y=${Math.round(y)}`).toBe(1);
      await moveAway(page);
      await expect(row.info).toBeHidden();
    }
  }

  // A pinned mid-viewport card scrolls to every detail and keeps its actions.
  await page.setViewportSize({ width: 375, height: 740 });
  await page.goto(baseURL + LIST_PATH);
  const row = rowParts(page, fixture.ids['01-alpha.png']);
  const pinBox = await row.title.boundingBox();
  await page.evaluate((delta) => window.scrollBy(0, delta), pinBox.y - 370);
  await row.title.click();
  await expect(row.info).toBeVisible();
  expect(await row.info.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
  const releases = row.info.locator('.asset-viewer-grid-card-info-section-label', { hasText: 'Releases' });
  await releases.scrollIntoViewIfNeeded();
  await expect(releases).toBeInViewport();
  await expect(row.info).toBeVisible();
  await page.locator('.asset-list-scroll').evaluate((node) => { node.scrollLeft = 40; });
  await expect(row.info).toBeVisible();
  await row.info.evaluate((node) => { node.scrollTop = 0; });
  await row.info.getByRole('link', { name: 'Open asset' }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/projects/${fixture.alphaId}/assets/${fixture.ids['01-alpha.png']}`);
});

test('Modified uses the server-formatted value under the 12h and 24h clock preference', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const dated = fixture.ids['02-beta.png'];
  const undated = fixture.ids['04-delta.png'];
  db.prepare('UPDATE assets SET modified_at = ? WHERE id = ?').run('2026-10-15T13:17:01.910Z', Number(dated));
  db.prepare('UPDATE assets SET modified_at = NULL WHERE id = ?').run(Number(undated));
  const clock = app.locals.clockFormatSettingsService;
  const original = clock.getClockFormat();
  try {
    for (const [preference, pattern] of [['12h', /^2026-10-1[456] \d{1,2}:\d{2} [AP]M$/], ['24h', /^2026-10-1[456] \d{2}:\d{2}$/]]) {
      clock.setClockFormat(preference);
      await page.goto(baseURL + LIST_PATH);
      const row = rowParts(page, dated);
      const text = (await row.card.locator('.asset-list-cell--modified dd').textContent()).trim();
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
