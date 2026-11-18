import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { build } from 'vite';
import { createAssetManifest } from '../../src/asset-manifest.js';
import { createApp } from '../../src/app.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';

// The compiled shared viewer on an isolated Asset Library installation,
// driven through its production controller from a connected test opener.

const DIALOG = '#unified-viewer-dialog';

async function startApp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-unified-viewer-browser-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot);
  fs.mkdirSync(appDataRoot);
  const viteDistRoot = path.join(root, 'client');
  await build({ build: { outDir: viteDistRoot }, logLevel: 'silent' });
  const db = openDatabase(path.join(root, 'test.db'));
  runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
  const { csrfPepper } = ensureAuthEnablement(appDataRoot);
  const app = createApp(
    { appName: 'CreatorCrate', db, projectsRoot },
    {
      appDataRoot, authState: { csrfPepper }, useViteAssets: true, viteDistRoot,
      assetManifest: createAssetManifest({ distRoot: viteDistRoot,
        manifestPath: path.join(viteDistRoot, '.vite', 'manifest.json') }),
    },
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return {
    baseURL: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      closeDatabase(db);
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

let fixture;
test.beforeAll(async () => { fixture = await startApp(); });
test.afterAll(async () => { await fixture?.close(); });

async function openLibrary(page) {
  await page.goto(`${fixture.baseURL}/assets`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(document.getElementById('unified-viewer-dialog')?.__creatorCrateUnifiedViewer));
  // An isolated opener and a stable host fallback inside the page's main.
  await page.evaluate(() => {
    const host = document.createElement('div');
    host.id = 'test-viewer-host';
    host.innerHTML = '<button type="button" id="test-opener">Open viewer</button>'
      + '<button type="button" id="test-fallback">Fallback</button>';
    document.querySelector('main').prepend(host);
    document.body.style.minHeight = '300vh';
    window.scrollTo(0, 120);
  });
}

// Opens a non-wrapping three-item sequence (or `options.single`) from #test-opener.
async function openViewer(page, { single = false, fallback = false } = {}) {
  await page.locator('#test-opener').focus();
  return page.evaluate(async ({ single, fallback }) => {
    const { unifiedViewerFor } = await import('/client/unified-viewer.js');
    const { createViewerSource } = await import('/client/viewer-sequence.js');
    const items = [1, 2, 3].map((id) => ({
      projectId: 7,
      assetId: id,
      title: `<b>image-${id}</b>.png`,
      projectName: 'Test project',
      mediaUrl: `/projects/7/assets/${id}/preview`,
      detailsUrl: `/projects/7/assets/${id}`,
    }));
    const opener = document.getElementById('test-opener');
    return unifiedViewerFor(document).open(createViewerSource({
      key: 'test',
      label: 'Test project',
      mode: single ? 'single' : 'sequence',
      items: single ? items.slice(1, 2) : items,
    }), {
      opener,
      fallbackFocus: fallback ? () => document.getElementById('test-fallback') : undefined,
    });
  }, { single, fallback });
}

const activeInDialog = (page) => page.evaluate((selector) => {
  const dialog = document.querySelector(selector);
  return dialog.contains(document.activeElement);
}, DIALOG);

test('mounts one closed viewer shell outside the page content', async ({ page }) => {
  await openLibrary(page);
  await expect(page.locator(DIALOG)).toHaveCount(1);
  await expect(page.locator(DIALOG)).toBeHidden();
  expect(await page.locator(`main ${DIALOG}`).count()).toBe(0);
  // B5b retired the library's legacy slideshow scaffold: no second viewer.
  await expect(page.locator('[data-slideshow-scaffold]')).toHaveCount(0);
});

test('opens modally with predictable focus, contains focus and locks background scroll', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openLibrary(page);
  const scrollBefore = await page.evaluate(() => window.scrollY);
  expect(scrollBefore).toBeGreaterThan(0);
  const urlBefore = page.url();

  expect(await openViewer(page)).toBeGreaterThan(0);
  const dialog = page.locator(DIALOG);
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((element) => element.matches(':modal'))).toBe(true);
  await expect(dialog).toHaveAccessibleName('Image Preview');
  await expect(page.getByRole('button', { name: 'Close Image Preview' })).toBeFocused();
  await expect(page.locator('body')).toHaveClass(/app-dialog-open/);
  await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');

  // Title is text, not markup.
  await expect(dialog.locator('[data-unified-viewer-title]')).toHaveText('<b>image-1</b>.png');
  await expect(dialog.locator('[data-unified-viewer-title] b')).toHaveCount(0);
  await expect(dialog.locator('[data-unified-viewer-source]')).toHaveText('Test project');
  await expect(dialog.getByRole('link', { name: 'View details' })).toHaveAttribute('href', '/projects/7/assets/1');
  await expect(dialog.locator('[data-unified-viewer-position]')).toHaveText('1 of 3');

  await page.mouse.move(640, 400);
  await page.mouse.wheel(0, 600);
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);

  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press('Tab');
    expect(await activeInDialog(page)).toBe(true);
  }
  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press('Shift+Tab');
    expect(await activeInDialog(page)).toBe(true);
  }

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.locator('#test-opener')).toBeFocused();
  await expect(page.locator('body')).not.toHaveClass(/app-dialog-open/);
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
  expect(page.url()).toBe(urlBefore);
});

test('navigates with buttons and arrows inside non-wrapping boundaries', async ({ page }) => {
  await openLibrary(page);
  await openViewer(page);
  const dialog = page.locator(DIALOG);
  const previous = dialog.getByRole('button', { name: 'Previous' });
  const next = dialog.getByRole('button', { name: 'Next' });
  const position = dialog.locator('[data-unified-viewer-position]');

  await expect(previous).toBeDisabled();
  await page.keyboard.press('ArrowRight');
  await expect(position).toHaveText('2 of 3');
  await expect(dialog.locator('[data-unified-viewer-title]')).toHaveText('<b>image-2</b>.png');
  await page.keyboard.press('ArrowLeft');
  await expect(position).toHaveText('1 of 3');

  await next.click();
  await next.click();
  await expect(position).toHaveText('3 of 3');
  await expect(next).toBeDisabled();
  await expect(previous).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(position).toHaveText('3 of 3');

  await dialog.getByRole('button', { name: 'Close Image Preview' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#test-opener')).toBeFocused();
});

test('a single image has no sequence controls', async ({ page }) => {
  await openLibrary(page);
  await openViewer(page, { single: true });
  const dialog = page.locator(DIALOG);
  await expect(dialog.locator('[data-unified-viewer-title]')).toHaveText('<b>image-2</b>.png');
  await expect(dialog.getByRole('button', { name: 'Previous' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Next' })).toHaveCount(0);
  await expect(dialog.locator('[data-unified-viewer-controls]')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

async function viewerState(page) {
  return page.evaluate(() => document.getElementById('unified-viewer-dialog').__creatorCrateUnifiedViewer.getState());
}

async function expectTitle(page, title) {
  const dialog = page.locator(DIALOG);
  await expect(dialog.getByRole('heading', { name: title, exact: true })).toHaveCount(1);
  await expect(dialog).toHaveAccessibleName(title);
  await expect(dialog).toHaveAttribute('aria-labelledby', 'unified-viewer-dialog-title');
  await expect(dialog.getByRole('button', { name: `Close ${title}`, exact: true })).toHaveAttribute('title', `Close ${title}`);
}

async function clickBackdrop(page) {
  const box = await page.locator(DIALOG).boundingBox();
  expect(box.x).toBeGreaterThan(4);
  await page.mouse.click(box.x / 2, box.y + box.height / 2);
}

async function serveImages(page, { width = 160, height = 120 } = {}) {
  const image = await sharp({ create: { width, height, channels: 3, background: '#7090c0' } }).png().toBuffer();
  await page.route('**/projects/7/assets/*/preview', (route) => route.fulfill({ contentType: 'image/png', body: image }));
  return image;
}

test('backdrop dismissal preserves interior clicks and drags crossing either boundary', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openLibrary(page);
  await serveImages(page);
  await openViewer(page);
  const dialog = page.locator(DIALOG);
  await expectTitle(page, 'Image Preview');
  await expect(dialog.locator('img:not([hidden])')).toBeVisible();
  // The media surface owns pointer events over the displayed image.
  const image = await dialog.locator('img:not([hidden])').boundingBox();
  await page.mouse.click(image.x + image.width / 2, image.y + image.height / 2);
  await expect(dialog).toBeVisible();
  for (const target of ['.app-dialog-header', '[data-unified-viewer-context]', '[data-unified-viewer-next]']) {
    await dialog.locator(target).click();
    await expect(dialog).toBeVisible();
  }
  const box = await dialog.boundingBox();
  const stage = await dialog.locator('[data-unified-viewer-stage]').boundingBox();
  const inside = { x: stage.x + stage.width / 2, y: stage.y + stage.height / 2 };
  const outside = { x: box.x / 2, y: box.y + 10 };
  for (const [start, end] of [[inside, outside], [outside, inside]]) {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 5 });
    await page.mouse.up();
    await expect(dialog).toBeVisible();
  }
  await page.evaluate(() => {
    window.__viewerCloses = 0;
    document.getElementById('unified-viewer-dialog').__creatorCrateUnifiedViewer.observe((change) => {
      if (change.type === 'close') window.__viewerCloses += 1;
    });
  });
  await clickBackdrop(page);
  await expect(dialog).toBeHidden();
  await expect(page.locator('#test-opener')).toBeFocused();
  expect(await page.evaluate(() => window.__viewerCloses)).toBe(1);
  expect(await viewerState(page)).toMatchObject({ open: false, mediaStatus: 'idle' });
  await expect(dialog.locator('img')).toHaveCount(0);
  await openViewer(page, { single: true });
  await expectTitle(page, 'Image Preview');
  await dialog.getByRole('button', { name: 'Close Image Preview' }).click();
  await expect(dialog).toBeHidden();
});

test('slideshow titles survive pause, one image and refresh; backdrop stops playback and releases media', async ({ page }) => {
  await openLibrary(page);
  await serveImages(page);
  await page.evaluate(async () => {
    const { createSlideshowSource } = await import('/client/viewer-sequence.js');
    const viewer = document.getElementById('unified-viewer-dialog').__creatorCrateUnifiedViewer;
    viewer.open(createSlideshowSource({ entries: [1, 2].map((id) => ({
      id, projectId: 7, filename: `slide-${id}.png`, previewUrl: `/projects/7/assets/${id}/preview`,
    })) }), { opener: document.getElementById('test-opener') });
  });
  await expectTitle(page, 'Slideshow');
  await expect.poll(async () => (await viewerState(page)).mediaStatus).toBe('loaded');
  await expect.poll(async () => (await viewerState(page)).playback.playing).toBe(true);
  await page.locator(`${DIALOG} [data-unified-viewer-play]`).click();
  expect((await viewerState(page)).playback.playing).toBe(false);
  await expectTitle(page, 'Slideshow');
  await page.evaluate(() => {
    const viewer = document.getElementById('unified-viewer-dialog').__creatorCrateUnifiedViewer;
    viewer.update([viewer.getState().source.items[0]]);
  });
  await expectTitle(page, 'Slideshow');
  await openViewer(page, { single: true });
  await expectTitle(page, 'Image Preview');
  await page.evaluate(async () => {
    const { createSlideshowSource } = await import('/client/viewer-sequence.js');
    document.getElementById('unified-viewer-dialog').__creatorCrateUnifiedViewer.open(createSlideshowSource({
      entries: [1, 2].map((id) => ({ id, projectId: 7, filename: `slide-${id}.png`, previewUrl: `/projects/7/assets/${id}/preview` })),
    }), { opener: document.getElementById('test-opener') });
  });
  await expect.poll(async () => (await viewerState(page)).playback.playing).toBe(true);
  await clickBackdrop(page);
  await expect(page.locator(DIALOG)).toBeHidden();
  expect(await viewerState(page)).toMatchObject({ open: false, mediaStatus: 'idle', playback: { playing: false, available: false } });
  await expect(page.locator(`${DIALOG} img`)).toHaveCount(0);
  await expect(page.locator('#test-opener')).toBeFocused();
  await openViewer(page);
  await expectTitle(page, 'Image Preview');
  await page.keyboard.press('Escape');
});

test('Comic Reader names loading, failure and empty states; backdrop aborts a pending request', async ({ page }) => {
  await openLibrary(page);
  let held;
  await page.route('**/projects/7/assets/40/comic', (route) => { held = route; });
  await page.evaluate(() => {
    window.__comicAborted = false;
    const fetch = window.fetch.bind(window);
    window.fetch = (url, init) => {
      if (String(url).endsWith('/comic')) init.signal.addEventListener('abort', () => { window.__comicAborted = true; });
      return fetch(url, init);
    };
    document.getElementById('unified-viewer-dialog').__creatorCrateUnifiedViewer.openComic({ projectId: 7, assetId: 40 }, {
      opener: document.getElementById('test-opener'),
    });
  });
  await expect.poll(() => Boolean(held)).toBe(true);
  await expectTitle(page, 'Comic Reader');
  expect((await viewerState(page)).comic.state).toBe('loading');
  await clickBackdrop(page);
  await expect(page.locator(DIALOG)).toBeHidden();
  expect(await page.evaluate(() => window.__comicAborted)).toBe(true);
  await expect(page.locator('#test-opener')).toBeFocused();
  await held.abort().catch(() => {});
  await page.unroute('**/projects/7/assets/40/comic');
  await page.route('**/projects/7/assets/40/comic', (route) => route.fulfill({ status: 503 }));
  await page.evaluate(() => document.getElementById('unified-viewer-dialog').__creatorCrateUnifiedViewer.openComic({ projectId: 7, assetId: 40 }));
  await expect.poll(async () => (await viewerState(page)).comic?.state).toBe('failed');
  await expectTitle(page, 'Comic Reader');
  await page.unroute('**/projects/7/assets/40/comic');
  await page.route('**/projects/7/assets/40/comic', (route) => route.fulfill({ json: {
    projectId: 7, assetId: 40, format: 'cbz', revision: 'a'.repeat(32), pageCount: 0,
    displayImageTypes: ['image/png'], preparation: { solid: false, state: 'not-required' }, unavailablePositions: [], pages: [],
  } }));
  await page.locator(`${DIALOG} [data-unified-viewer-comic-retry]`).click();
  await expect.poll(async () => (await viewerState(page)).comic?.empty).toBe(true);
  await expectTitle(page, 'Comic Reader');
  const image = await serveImages(page);
  const pageUrl = '/projects/7/assets/40/comic/pages/1?v=' + 'a'.repeat(32);
  await page.unroute('**/projects/7/assets/40/comic');
  await page.route('**/projects/7/assets/40/comic', (route) => route.fulfill({ json: {
    projectId: 7, assetId: 40, format: 'cbz', revision: 'a'.repeat(32), pageCount: 1,
    displayImageTypes: ['image/png'], preparation: { solid: false, state: 'not-required' }, unavailablePositions: [],
    pages: [{ position: 1, name: 'page.png', available: true, problem: null, url: pageUrl }],
  } }));
  await page.route('**/projects/7/assets/40/comic/pages/*', (route) => route.fulfill({ contentType: 'image/png', body: image }));
  await page.evaluate(() => document.getElementById('unified-viewer-dialog').__creatorCrateUnifiedViewer.openComic({ projectId: 7, assetId: 40 }));
  const dialog = page.locator(DIALOG);
  await expect(dialog.locator('img:not([hidden])')).toBeVisible();
  const pageBox = await dialog.locator('img:not([hidden])').boundingBox();
  await page.mouse.click(pageBox.x + pageBox.width / 2, pageBox.y + pageBox.height / 2);
  await expect(dialog).toBeVisible();
  await dialog.locator('#unified-viewer-direction-dropdown summary').click();
  await dialog.getByRole('radiogroup', { name: 'Reading direction options' }).getByText('Right-to-Left', { exact: true }).click();
  await expect(dialog).toBeVisible();
  await expectTitle(page, 'Comic Reader');
  await openViewer(page, { single: true });
  await expectTitle(page, 'Image Preview');
  await page.keyboard.press('Escape');
});

test('fullscreen stage and dropdown clicks stay open; Escape closes dropdown, fullscreen, then dialog', async ({ page }) => {
  await openLibrary(page);
  await serveImages(page);
  await page.evaluate(async () => {
    const { createViewerSource } = await import('/client/viewer-sequence.js');
    document.getElementById('unified-viewer-dialog').__creatorCrateUnifiedViewer.open(createViewerSource({
      mode: 'sequence', slideshow: true,
      items: [1, 2].map((assetId) => ({ assetId, projectId: 7, title: 'slide.png', mediaUrl: `/projects/7/assets/${assetId}/preview` })),
    }), { opener: document.getElementById('test-opener'), autoplay: false });
  });
  const dialog = page.locator(DIALOG);
  await dialog.locator('[data-unified-viewer-fullscreen]').click();
  await expect.poll(async () => (await viewerState(page)).fullscreen).toBe(true);
  await dialog.locator('[data-unified-viewer-stage]').click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-unified-viewer-card]')).toHaveAttribute('data-viewer-chrome-hidden', '');
  await page.mouse.move(300, 200);
  await expect(dialog.locator('[data-unified-viewer-card]')).not.toHaveAttribute('data-viewer-chrome-hidden');
  await dialog.locator('#unified-viewer-speed-dropdown summary').click();
  await expect(dialog.locator('#unified-viewer-speed-dropdown')).toHaveAttribute('open', '');
  await page.keyboard.press('Escape');
  await expect(dialog.locator('#unified-viewer-speed-dropdown')).not.toHaveAttribute('open');
  expect((await viewerState(page)).fullscreen).toBe(true);
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await viewerState(page)).fullscreen).toBe(false);
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.locator('#test-opener')).toBeFocused();
});

test('reopens repeatedly and falls back when the opener was replaced', async ({ page }) => {
  await openLibrary(page);
  const dialog = page.locator(DIALOG);
  const sessions = [];
  for (let round = 0; round < 3; round += 1) {
    sessions.push(await openViewer(page));
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-unified-viewer-position]')).toHaveText('1 of 3');
    await page.keyboard.press('ArrowRight');
    await expect(dialog.locator('[data-unified-viewer-position]')).toHaveText('2 of 3');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.locator('#test-opener')).toBeFocused();
  }
  expect(new Set(sessions).size).toBe(3);

  await openViewer(page, { fallback: true });
  await page.evaluate(() => document.getElementById('test-opener').remove());
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.locator('#test-fallback')).toBeFocused();

  // Without an opener or a host fallback, focus lands on the main landmark.
  await page.evaluate(() => {
    const opener = document.createElement('button');
    opener.id = 'test-opener';
    document.getElementById('test-viewer-host').append(opener);
  });
  await openViewer(page);
  await page.evaluate(() => document.getElementById('test-opener').remove());
  await page.evaluate(async () => {
    const { unifiedViewerFor } = await import('/client/unified-viewer.js');
    unifiedViewerFor(document).close();
  });
  await expect(dialog).toBeHidden();
  await expect(page.locator('main#main-content')).toBeFocused();
});

test('closes on a refresh that empties the source', async ({ page }) => {
  await openLibrary(page);
  const session = await openViewer(page);
  const dialog = page.locator(DIALOG);
  const result = await page.evaluate(async (current) => {
    const { unifiedViewerFor } = await import('/client/unified-viewer.js');
    const viewer = unifiedViewerFor(document);
    const stale = viewer.update([], { session: current + 1 });
    const kept = viewer.update([{ projectId: 7, assetId: 1, title: 'renamed.png', mediaUrl: '/p/1' }], { session: current });
    return { stale, kept: kept.outcome };
  }, session);
  expect(result).toEqual({ stale: null, kept: 'kept' });
  await expect(dialog.locator('[data-unified-viewer-title]')).toHaveText('renamed.png');
  await expect(dialog.getByRole('link', { name: 'View details' })).toHaveAttribute('href', '/projects/7/assets/1');
  await expect(dialog.getByRole('button', { name: 'Next' })).toHaveCount(0);

  await page.evaluate(async () => {
    const { unifiedViewerFor } = await import('/client/unified-viewer.js');
    unifiedViewerFor(document).update([]);
  });
  await expect(dialog).toBeHidden();
  await expect(page.locator('#test-opener')).toBeFocused();
  await expect(page.locator('body')).not.toHaveClass(/app-dialog-open/);
});

test('coexists with the page’s other app dialogs', async ({ page }) => {
  await openLibrary(page);
  // WP9b: the Asset Library's one Filters & Defaults dialog.
  const defaults = page.locator('[data-dialog-open="asset-viewer-filter-dialog"]').first();
  await expect(defaults).toBeVisible();
  await defaults.click();
  const defaultsDialog = page.locator('#asset-viewer-filter-dialog');
  await expect(defaultsDialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(defaultsDialog).toBeHidden();
  await expect(defaults).toBeFocused();

  await openViewer(page);
  await expect(page.locator(DIALOG)).toBeVisible();
  await expect(defaultsDialog).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();

  await defaults.click();
  await expect(defaultsDialog).toBeVisible();
  await expect(page.locator(DIALOG)).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(defaultsDialog).toBeHidden();
});

test('fits a narrow viewport with usable controls', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 700 });
  await openLibrary(page);
  await page.evaluate(async () => {
    const { unifiedViewerFor } = await import('/client/unified-viewer.js');
    const { createViewerSource } = await import('/client/viewer-sequence.js');
    unifiedViewerFor(document).open(createViewerSource({
      key: 'narrow',
      label: 'A project label that is long enough to wrap on a phone screen',
      mode: 'sequence',
      items: [1, 2].map((id) => ({
        projectId: 7,
        assetId: id,
        title: `an-extremely-long-filename-without-spaces-${'x'.repeat(60)}-${id}.png`,
        mediaUrl: `/p/${id}`,
        detailsUrl: `/projects/7/assets/${id}`,
      })),
    }), { opener: document.getElementById('test-opener') });
  });
  const dialog = page.locator(DIALOG);
  await expect(dialog).toBeVisible();
  const geometry = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const card = element.querySelector('.app-dialog-card');
    const stage = element.querySelector('[data-unified-viewer-stage]').getBoundingClientRect();
    const controls = element.querySelector('[data-unified-viewer-controls]').getBoundingClientRect();
    const next = element.querySelector('[data-unified-viewer-next]').getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      cardOverflowX: card.scrollWidth - card.clientWidth,
      stageHeight: stage.height,
      controlsBottom: controls.bottom,
      nextWidth: next.width,
      nextHeight: next.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
  expect(geometry.cardOverflowX).toBeLessThanOrEqual(0);
  expect(geometry.stageHeight).toBeGreaterThan(200);
  expect(geometry.controlsBottom).toBeLessThanOrEqual(geometry.bottom);
  expect(geometry.nextWidth).toBeGreaterThanOrEqual(32);
  expect(geometry.nextHeight).toBeGreaterThanOrEqual(32);
  await expect(dialog.getByRole('link', { name: 'View details' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Close Image Preview' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

async function openFooterFixture(page, { kind = 'image', filename = 'landscape.png', projectName = 'Studio', count = 3, imageSize } = {}) {
  const image = await serveImages(page, imageSize);
  if (kind === 'comic') {
    const revision = 'b'.repeat(32);
    await page.route('**/projects/7/assets/40/comic', (route) => route.fulfill({ json: {
      projectId: 7, assetId: 40, format: 'cbz', revision, pageCount: count,
      displayImageTypes: ['image/png'], preparation: { solid: false, state: 'not-required' }, unavailablePositions: [],
      pages: Array.from({ length: count }, (_, index) => ({ position: index + 1, name: `${index + 1}.png`,
        available: true, problem: null, url: `/projects/7/assets/40/comic/pages/${index + 1}?v=${revision}` })),
    } }));
    await page.route('**/projects/7/assets/40/comic/pages/*', (route) => route.fulfill({ contentType: 'image/png', body: image }));
  }
  await page.evaluate(async ({ kind, filename, projectName, count }) => {
    const viewer = document.getElementById('unified-viewer-dialog').__creatorCrateUnifiedViewer;
    await document.fonts.ready;
    if (!viewer.getState().open) window.__footerPageWidthBefore = document.documentElement.scrollWidth;
    const opener = document.getElementById('test-opener');
    if (kind === 'comic') {
      viewer.openComic({ projectId: 7, assetId: 40, filename, projectName, detailsUrl: '/projects/7/assets/40' }, { opener });
    } else {
      const { createViewerSource } = await import('/client/viewer-sequence.js');
      viewer.open(createViewerSource({ key: 'footer', mode: kind === 'image' ? 'single' : 'sequence',
        slideshow: kind === 'slideshow', label: 'This source label is not a project name',
        items: Array.from({ length: kind === 'image' ? 1 : count }, (_, index) => ({
          assetId: index + 1, projectId: 7, filename, projectName,
          mediaUrl: `/projects/7/assets/${index + 1}/preview`, originalUrl: `/projects/7/assets/${index + 1}/preview`,
          detailsUrl: `/projects/7/assets/${index + 1}`,
        })),
      }), { opener, autoplay: false });
    }
    await document.fonts.ready;
  }, { kind, filename, projectName, count });
  await expect.poll(() => page.evaluate(() => document.getElementById('unified-viewer-dialog').__creatorCrateUnifiedViewer.media.getState().status)).toBe('loaded');
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function footerGeometry(page) {
  return page.locator(DIALOG).evaluate((dialog) => {
    const rect = (element) => {
      const r = element.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const find = (selector) => dialog.querySelector(selector);
    const title = find('[data-unified-viewer-title]');
    const source = find('[data-unified-viewer-source]');
    const project = find('[data-unified-viewer-project]');
    const header = find('.app-dialog-header');
    const footer = find('footer');
    const navigation = find('[data-unified-viewer-controls]');
    const primary = ['fit', 'fullscreen', 'details', 'play'].map((name) => find(`[data-unified-viewer-${name}]`))
      .filter((element) => element.getClientRects().length && !element.closest('[hidden]'))
      .map((element) => {
        const box = rect(element);
        return { name: element.getAttribute('aria-label') || element.textContent.trim(), ...box,
          hit: element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)) };
      });
    return { card: rect(find('.app-dialog-card')), header: rect(header), footer: rect(footer),
      metadata: rect(find('.unified-viewer-heading')), title: rect(title), project: rect(project),
      source: rect(source), projectHidden: project.hidden, sourceWidth: source.scrollWidth,
      titleOverflow: title.scrollWidth > title.clientWidth, titleValue: title.textContent, titleTooltip: title.title,
      caption: { fontSize: getComputedStyle(title).fontSize, lineHeight: getComputedStyle(title).lineHeight,
        weight: getComputedStyle(title).fontWeight, color: getComputedStyle(title).color,
        textOverflow: getComputedStyle(title).textOverflow },
      videoCaption: (() => {
        const style = getComputedStyle(document.querySelector('[data-asset-video-preview-title]'));
        return { fontSize: style.fontSize, lineHeight: style.lineHeight, weight: style.fontWeight, color: style.color };
      })(),
      sourceOverflow: getComputedStyle(source).textOverflow,
      stage: rect(find('[data-unified-viewer-stage]')), navigation: navigation.hidden ? null : rect(navigation),
      navBorder: getComputedStyle(navigation).borderTopWidth, navRadius: getComputedStyle(navigation).borderRadius,
      headerChildren: [...header.children].map((element) => element.tagName),
      shellChildren: [...find('[data-unified-viewer]').children].map((element) => element.tagName),
      slideshow: find('[data-unified-viewer]').getAttribute('data-viewer-playback') !== 'none',
      footerCount: dialog.querySelectorAll('footer').length,
      primary, scrollWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth,
      backgroundWidth: window.__footerPageWidthBefore,
      cardOverflow: find('.app-dialog-card').scrollWidth - find('.app-dialog-card').clientWidth,
      toolsCount: Object.fromEntries(['fit', 'fullscreen', 'details', 'play', 'zoom-in', 'original'].map((name) =>
        [name, dialog.querySelectorAll(`[data-unified-viewer-${name}]`).length])),
    };
  });
}

function expectFooterGeometry(geometry, { comic = false, scaled = false, fullscreen = false } = {}) {
  expect(geometry.headerChildren).toEqual(['H2', 'BUTTON']);
  expect(geometry.shellChildren).toEqual(['DIV', 'FOOTER']);
  expect(geometry.footerCount).toBe(1);
  if (fullscreen) {
    expect(geometry.stage).toEqual(geometry.card);
    expect(geometry.header.bottom).toBeLessThanOrEqual((geometry.navigation || geometry.footer).top + 0.5);
  } else {
    expect(geometry.header.bottom).toBeLessThanOrEqual(geometry.stage.top + 0.5);
    expect(geometry.stage.bottom).toBeLessThanOrEqual(geometry.footer.top + 0.5);
  }
  if (geometry.navigation) {
    expect(geometry.navigation.top).toBeGreaterThanOrEqual(geometry.stage.top);
    expect(geometry.navigation.bottom).toBeLessThanOrEqual(geometry.stage.bottom);
    expect(geometry.navigation.bottom).toBeLessThanOrEqual(geometry.footer.top + 0.5);
    expect(geometry.navigation.width).toBeLessThan(geometry.card.width * 0.9);
    if (comic) {
      expect(parseFloat(geometry.navBorder)).toBeGreaterThan(0);
      expect(parseFloat(geometry.navRadius)).toBeGreaterThan(0);
    }
  }
  expect(geometry.title.top).toBeGreaterThanOrEqual(geometry.footer.top);
  expect(geometry.title.bottom).toBeLessThanOrEqual(geometry.footer.bottom);
  expect(geometry.metadata.height).toBeLessThanOrEqual(parseFloat(geometry.caption.lineHeight) + 1);
  expect(geometry.caption.fontSize).toBe(scaled ? '19.5px' : '13px');
  expect(geometry.caption.weight).toBe('400');
  for (const property of ['fontSize', 'lineHeight', 'weight', 'color']) {
    expect(geometry.caption[property]).toBe(geometry.videoCaption[property]);
  }
  expect(geometry.caption.textOverflow).toBe('ellipsis');
  expect(geometry.titleValue).toBe(geometry.titleTooltip);
  expect(geometry.cardOverflow).toBeLessThanOrEqual(1);
  // The library itself can overflow at very small widths or large fonts;
  // opening the viewer must add no overflow and its card must fit entirely.
  expect(geometry.scrollWidth).toBeLessThanOrEqual(Math.max(geometry.viewportWidth, geometry.backgroundWidth));
  expect(geometry.card.left).toBeGreaterThanOrEqual(0);
  expect(geometry.card.right).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.footer.height).toBeLessThanOrEqual(scaled ? 112 : 80);
  if (!geometry.projectHidden) {
    expect(geometry.title.top).toBeCloseTo(geometry.source.top, 0);
    expect(geometry.sourceWidth).toBeLessThanOrEqual(geometry.source.width + 1);
    expect(geometry.sourceOverflow).toBe('clip');
    expect(geometry.source.right).toBeLessThanOrEqual(geometry.metadata.right + 0.5);
  }
  for (const control of geometry.primary) {
    expect(control.hit, control.name).toBe(true);
    expect(control.left, control.name).toBeGreaterThanOrEqual(geometry.card.left);
    expect(control.right, control.name).toBeLessThanOrEqual(geometry.card.right);
    expect(control.bottom, control.name).toBeLessThanOrEqual(geometry.card.bottom);
    expect(control.height, control.name).toBeLessThanOrEqual(scaled ? 48 : 32);
  }
  for (const name of ['Fit to viewer', fullscreen ? 'Exit fullscreen' : 'Enter fullscreen', 'View details', ...(geometry.slideshow ? ['Play slideshow'] : [])]) {
    expect(geometry.primary.some((control) => control.name === name || (name === 'Enter fullscreen' && control.name === 'Exit fullscreen')), name).toBe(true);
  }
  expect(Object.values(geometry.toolsCount).every((count) => count === 1)).toBe(true);
}

for (const width of [320, 390, 540, 768, 1440]) {
  test(`slim shared footer measures real geometry in every mode at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 700 });
    await openLibrary(page);
    for (const kind of ['image', 'slideshow', 'comic']) {
      await openFooterFixture(page, { kind, filename: 'a-very-long-filename-'.repeat(20) + '.png', projectName: 'A complete project name that cannot fit '.repeat(8) });
      const geometry = await footerGeometry(page);
      console.log(JSON.stringify({ kind, width, footerHeight: geometry.footer.height, stageHeight: geometry.stage.height,
        projectOmitted: geometry.projectHidden, cardOverflow: geometry.cardOverflow }));
      expectFooterGeometry(geometry, { comic: kind === 'comic' });
      expect(geometry.projectHidden).toBe(true);
      expect(geometry.titleOverflow).toBe(true);
      await expectTitle(page, kind === 'comic' ? 'Comic Reader' : kind === 'slideshow' ? 'Slideshow' : 'Image Preview');
      await expect(page.locator(`${DIALOG} [data-unified-viewer-details]`)).toBeVisible();
      await expect(page.locator(`${DIALOG} [data-unified-viewer-fullscreen]`)).toBeVisible();
      if (kind === 'slideshow') await expect(page.getByRole('button', { name: 'Play slideshow', exact: true })).toBeVisible();
      if (width < 1100) {
        await page.getByRole('button', { name: 'More viewer tools' }).click();
        await expect(page.getByRole('button', { name: 'Zoom in', exact: true })).toBeVisible();
        if (kind === 'comic') {
          await expect(page.getByRole('combobox', { name: 'Page layout', exact: true })).toBeVisible();
          await page.getByRole('combobox', { name: 'Page layout', exact: true }).selectOption('spread-pair-from-first');
        }
        if (kind === 'slideshow') {
          await page.getByRole('combobox', { name: 'Slideshow speed', exact: true }).selectOption('2000');
        }
        await page.keyboard.press('Escape');
        await expect(page.getByRole('button', { name: 'More viewer tools' })).toBeFocused();
      }
    }
  });
}

test('project metadata fits inline, omits whole names on resize, and never invents a source label', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await openLibrary(page);
  await openFooterFixture(page);
  let geometry = await footerGeometry(page);
  expectFooterGeometry(geometry);
  expect(geometry.projectHidden).toBe(false);
  expect(geometry.footer.height).toBeLessThanOrEqual(48);
  await page.evaluate(() => {
    document.querySelector('.unified-viewer-heading').style.maxWidth = '7rem';
  });
  await expect(page.locator('[data-unified-viewer-project]')).toBeHidden();
  await page.evaluate(() => document.querySelector('.unified-viewer-heading').style.removeProperty('max-width'));
  await expect(page.locator('[data-unified-viewer-project]')).toBeVisible();
  await openFooterFixture(page, { projectName: null });
  await expect(page.locator('[data-unified-viewer-project]')).toBeHidden();
  await expect(page.locator('[data-unified-viewer-source]')).toHaveText('');
});

test('short scaled windows keep a single metadata line and primary actions reachable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 320 });
  await openLibrary(page);
  await page.evaluate(() => { document.documentElement.style.fontSize = '24px'; });
  for (const kind of ['image', 'slideshow', 'comic']) {
    await openFooterFixture(page, { kind, count: 1, filename: 'long-'.repeat(50), projectName: 'Project '.repeat(30) });
    expectFooterGeometry(await footerGeometry(page), { comic: kind === 'comic', scaled: true });
    await expect(page.getByRole('button', { name: 'Fit to viewer', exact: true })).toBeVisible();
    if (kind === 'slideshow') await expectTitle(page, 'Slideshow');
    if (kind === 'comic') {
      await expect(page.locator('[data-unified-viewer-position]')).toHaveText('Page 1 of 1');
      await expect(page.getByRole('button', { name: 'Previous', exact: true })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
    }
  }
});

test('fullscreen chrome overlays the full stage and reveals before keyboard actions', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 600 });
  await openLibrary(page);
  await openFooterFixture(page, { kind: 'comic' });
  await page.getByRole('button', { name: 'Enter fullscreen', exact: true }).click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  expectFooterGeometry(await footerGeometry(page), { comic: true, fullscreen: true });
  const visibleHeight = await page.locator('[data-unified-viewer-stage]').evaluate((element) => element.clientHeight);
  const card = page.locator('[data-unified-viewer-card]');
  await page.mouse.move(300, 200);
  await expect(card).toHaveAttribute('data-viewer-chrome-hidden', '', { timeout: 6000 });
  await expect.poll(() => page.locator('[data-unified-viewer-stage]').evaluate((element) => element.clientHeight)).toBe(600);
  expect(visibleHeight).toBe(600);
  await page.keyboard.press('Tab');
  await expect(card).not.toHaveAttribute('data-viewer-chrome-hidden');
  expectFooterGeometry(await footerGeometry(page), { comic: true, fullscreen: true });
  await page.getByRole('button', { name: 'More viewer tools' }).click();
  await page.mouse.move(300, 200);
  await page.waitForTimeout(4200);
  await expect(card).not.toHaveAttribute('data-viewer-chrome-hidden');
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
  expectFooterGeometry(await footerGeometry(page), { comic: true });
});

test('layout assertions reject temporary UX regressions without changing source files', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await openLibrary(page);
  await openFooterFixture(page, { kind: 'comic' });
  expectFooterGeometry(await footerGeometry(page), { comic: true });
  const probes = [
    ['top context strip', () => {
      const strip = document.createElement('div');
      strip.textContent = 'Obsolete context';
      document.querySelector('[data-unified-viewer]').prepend(strip);
      return () => strip.remove();
    }],
    ['stacked metadata', () => {
      const metadata = document.querySelector('.unified-viewer-heading');
      metadata.style.flexDirection = 'column';
      return () => metadata.style.removeProperty('flex-direction');
    }],
    ['truncated project', () => {
      const source = document.querySelector('[data-unified-viewer-source]');
      const style = source.getAttribute('style');
      source.style.width = '1rem';
      source.style.overflow = 'hidden';
      source.style.textOverflow = 'ellipsis';
      return () => style === null ? source.removeAttribute('style') : source.setAttribute('style', style);
    }],
    ['oversized Fit', () => {
      const fit = document.querySelector('[data-unified-viewer-fit]');
      fit.style.height = '4rem';
      return () => fit.style.removeProperty('height');
    }],
    ['oversized Fullscreen', () => {
      const fullscreen = document.querySelector('[data-unified-viewer-fullscreen]');
      fullscreen.style.height = '4rem';
      return () => fullscreen.style.removeProperty('height');
    }],
    ['missing Details', () => {
      const details = document.querySelector('[data-unified-viewer-details]');
      details.style.display = 'none';
      return () => details.style.removeProperty('display');
    }],
    ['stretched comic navigation', () => {
      const nav = document.querySelector('[data-unified-viewer-controls]');
      nav.style.width = '100%';
      return () => nav.style.removeProperty('width');
    }],
    ['navigation overlapping footer', () => {
      const nav = document.querySelector('[data-unified-viewer-controls]');
      nav.style.transform = 'translateY(25px)';
      return () => nav.style.removeProperty('transform');
    }],
  ];
  for (const [name, mutate] of probes) {
    await page.evaluate((script) => { window.__restoreFooterProbe = (0, eval)(`(${script})`)(); }, mutate.toString());
    try {
      const geometry = await footerGeometry(page);
      expect(() => expectFooterGeometry(geometry, { comic: true }), name).toThrow();
    } finally {
      await page.evaluate(() => { window.__restoreFooterProbe(); delete window.__restoreFooterProbe; });
    }
    expectFooterGeometry(await footerGeometry(page), { comic: true });
  }
  await page.setViewportSize({ width: 320, height: 700 });
  await openFooterFixture(page, { kind: 'slideshow' });
  for (const name of ['play', 'fullscreen']) {
    await page.locator(`[data-unified-viewer-${name}]`).evaluate((element) => { element.style.display = 'none'; });
    try {
      const geometry = await footerGeometry(page);
      expect(() => expectFooterGeometry(geometry), `hidden ${name}`).toThrow();
    } finally {
      await page.locator(`[data-unified-viewer-${name}]`).evaluate((element) => element.style.removeProperty('display'));
    }
  }
});

test('responsive tool relocation restores focus and survives controller destruction and rebinding', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await openLibrary(page);
  await openFooterFixture(page, { kind: 'slideshow' });
  await page.getByRole('button', { name: 'Zoom in', exact: true }).focus();
  await page.setViewportSize({ width: 390, height: 700 });
  const tools = page.getByRole('button', { name: 'More viewer tools' });
  await expect(tools).toBeFocused();
  await tools.click();
  await page.getByRole('combobox', { name: 'Slideshow speed', exact: true }).selectOption('2000');
  await page.getByRole('combobox', { name: 'Slideshow speed', exact: true }).focus();
  await page.setViewportSize({ width: 1440, height: 800 });
  await expect(page.getByRole('button', { name: 'Close Slideshow', exact: true })).toBeFocused();
  await expect(page.locator('#unified-viewer-speed-dropdown summary')).toBeVisible();
  await expect(page.locator('#unified-viewer-speed-dropdown summary')).toContainText('2 s');
  await page.setViewportSize({ width: 390, height: 700 });
  await expect(tools).toBeVisible();
  await page.evaluate(async () => {
    const { unifiedViewerFor, enhanceUnifiedViewer } = await import('/client/unified-viewer.js');
    unifiedViewerFor(document).destroy();
    enhanceUnifiedViewer(document);
  });
  await openFooterFixture(page, { kind: 'slideshow' });
  await tools.click();
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await page.getByRole('combobox', { name: 'Slideshow speed', exact: true }).selectOption('6000');
  expect(await page.evaluate(() => document.getElementById('unified-viewer-dialog').__creatorCrateUnifiedViewer.playback.getState().speed)).toBe(6000);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Fit to viewer', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Fit to viewer', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(await activeInDialog(page)).toBe(true);
  await expect(page.getByRole('button', { name: 'Close Slideshow', exact: true })).toBeFocused();
  await openFooterFixture(page, { kind: 'comic' });
  await tools.click();
  await page.getByRole('combobox', { name: 'Reading direction', exact: true }).selectOption('rtl');
  await page.getByRole('combobox', { name: 'Page layout', exact: true }).selectOption('spread-pair-from-first');
  await page.setViewportSize({ width: 1440, height: 800 });
  await expect(page.locator('#unified-viewer-direction-dropdown summary')).toContainText('Right-to-Left');
  await expect(page.locator('#unified-viewer-layout-dropdown summary')).toContainText('Pair from Page 1');
});

async function footerHitGeometry(page) {
  return page.locator(DIALOG).evaluate((dialog) => {
    const box = (element) => {
      const { left, right, top, bottom, width, height } = element.getBoundingClientRect();
      return { left, right, top, bottom, width, height };
    };
    const footer = dialog.querySelector('footer');
    const controls = [...dialog.querySelectorAll('button, a[href], summary, select')]
      .filter((element) => !element.closest('[hidden]') && element.checkVisibility()
        && (!element.closest('details:not([open])') || element.matches('summary')) && element.getBoundingClientRect().width > 0
        && element.getBoundingClientRect().height > 0)
      .map((element) => {
        const bounds = box(element);
        return { ...bounds, name: element.getAttribute('aria-label') || element.textContent.trim(),
          footer: footer.contains(element),
          hit: element.contains(document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)),
          icon: element.matches('.unified-viewer-tool, .unified-viewer-play, .unified-viewer-nav') };
      });
    const navigation = dialog.querySelector('[data-unified-viewer-controls]');
    const stage = dialog.querySelector('[data-unified-viewer-stage]');
    const style = getComputedStyle(navigation);
    const navBox = box(navigation);
    const stageBox = box(stage);
    const state = dialog.__creatorCrateUnifiedViewer.getState();
    return { expectsNavigation: Boolean(state.item && (state.comic || state.source?.mode === 'sequence')),
      navigation: navigation.hidden ? null : {
        ...navBox, parentIsStage: navigation.parentElement === stage,
        count: dialog.querySelectorAll('[data-unified-viewer-controls]').length,
        position: style.position, background: style.backgroundColor,
        radius: parseFloat(style.borderRadius), border: parseFloat(style.borderTopWidth),
        stageBorder: parseFloat(getComputedStyle(stage).borderTopWidth),
        before: getComputedStyle(navigation, '::before').content,
        after: getComputedStyle(navigation, '::after').content,
        sideHit: stage.contains(document.elementFromPoint(stageBox.left + 2, navBox.top + navBox.height / 2))
          && !navigation.contains(document.elementFromPoint(stageBox.left + 2, navBox.top + navBox.height / 2)),
      }, controls, footer: box(footer), card: box(dialog.querySelector('.app-dialog-card')),
      rootFont: parseFloat(getComputedStyle(document.documentElement).fontSize),
      stage: box(dialog.querySelector('[data-unified-viewer-stage]')),
      actions: box(dialog.querySelector('.unified-viewer-context-actions')) };
  });
}

function expectFooterHits(geometry) {
  const { controls, card, footer, rootFont, stage } = geometry;
  expect(stage.height, 'usable media stage').toBeGreaterThan(24);
  if (geometry.expectsNavigation) expect(geometry.navigation, 'required navigation is present').not.toBeNull();
  if (geometry.navigation) {
    const nav = geometry.navigation;
    expect(nav.parentIsStage, 'navigation belongs to stage, outside pan surface').toBe(true);
    expect(nav.count).toBe(1);
    expect(nav.position).toBe('absolute');
    expect(nav.width, 'content-sized pill').toBeLessThan(stage.width * 0.95);
    expect(nav.left + nav.width / 2).toBeCloseTo(stage.left + stage.width / 2, 0);
    expect(nav.top).toBeGreaterThanOrEqual(stage.top);
    expect(nav.bottom).toBeLessThanOrEqual(Math.min(stage.bottom, footer.top) - 1);
    expect(nav.background).toBe('color(srgb 0.113725 0.133333 0.168627 / 0.88)');
    expect(nav.radius).toBeGreaterThan(0);
    expect(nav.border).toBe(1);
    expect(nav.stageBorder, 'no navigation strip border').toBe(0);
    expect(nav.before).toBe('none');
    expect(nav.after).toBe('none');
    expect(nav.sideHit, 'surrounding stage keeps pointer input').toBe(true);
  }
  for (const [index, control] of controls.entries()) {
    expect(control.hit, `${control.name} center hit`).toBe(true);
    const area = control.footer ? footer : card;
    expect(control.left, control.name).toBeGreaterThanOrEqual(area.left - 0.5);
    expect(control.right, control.name).toBeLessThanOrEqual(area.right + 0.5);
    expect(control.top, control.name).toBeGreaterThanOrEqual(area.top - 0.5);
    expect(control.bottom, control.name).toBeLessThanOrEqual(area.bottom + 0.5);
    if (control.icon) {
      expect(control.width, control.name).toBeCloseTo(2 * rootFont, 0);
      expect(control.height, control.name).toBeCloseTo(2 * rootFont, 0);
    }
    for (const other of controls.slice(index + 1)) {
      const overlapX = Math.min(control.right, other.right) - Math.max(control.left, other.left);
      const overlapY = Math.min(control.bottom, other.bottom) - Math.max(control.top, other.top);
      expect(overlapX > 0.5 && overlapY > 0.5, `${control.name} overlaps ${other.name}`).toBe(false);
    }
  }
}

async function pointerCenter(page, locator) {
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
}

for (const width of [320, 390, 540, 768, 1440]) {
  for (const fontSize of [16, 20, 24]) {
    test(`reader controls responsive hits at ${width}px with ${fontSize}px fonts`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 320 : 420 });
      await openLibrary(page);
      await page.evaluate((size) => { document.documentElement.style.fontSize = `${size}px`; }, fontSize);
      await openFooterFixture(page, { kind: 'comic', filename: 'long-comic-'.repeat(30) + '.cbz',
        projectName: 'Long project name '.repeat(20) });
      const overflow = page.locator('[data-unified-viewer-overflow]');
      const card = page.locator('[data-unified-viewer-card]');
      for (const fullscreen of [false, true]) {
        if (fullscreen) {
          await pointerCenter(page, page.locator('[data-unified-viewer-fullscreen]'));
          await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
        }
        for (const [name, menu, value, label] of [
          ['Reading direction', '#unified-viewer-direction-dropdown', 'rtl', 'Right-to-Left'],
          ['Page layout', '#unified-viewer-layout-dropdown', 'spread-pair-from-first', 'Two-Page Spread — Pair from Page 1'],
        ]) {
          if (await overflow.isVisible()) {
            await pointerCenter(page, page.getByRole('button', { name: 'More viewer tools', exact: true }));
            await expect(overflow).toHaveAttribute('open', '');
            const select = page.getByRole('combobox', { name, exact: true });
            await expect(select).toHaveCount(1);
            await expect(page.locator(`${menu} summary`)).toBeHidden();
            await select.scrollIntoViewIfNeeded();
            expect(await select.evaluate((element) => {
              const bounds = element.getBoundingClientRect();
              return element.contains(document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2));
            }), `${name} relocated center hit`).toBe(true);
            await pointerCenter(page, select);
            await page.keyboard.press('End');
            await page.keyboard.press('Enter');
            await expect(select).toHaveValue(value);
            const panel = await page.locator('[data-unified-viewer-overflow-panel]').boundingBox();
            expect(panel.x).toBeGreaterThanOrEqual(0);
            expect(panel.x + panel.width).toBeLessThanOrEqual(width);
            expect(panel.y).toBeGreaterThanOrEqual(0);
            expect(panel.y + panel.height).toBeLessThanOrEqual(page.viewportSize().height);
            await page.keyboard.press('Escape');
            await expect(overflow).not.toHaveAttribute('open');
            await expect(page.getByRole('button', { name: 'More viewer tools', exact: true })).toBeFocused();
          } else {
            await pointerCenter(page, page.locator(`${menu} summary`));
            await pointerCenter(page, page.locator(`${menu} label`).filter({ hasText: label }));
            await expect(page.locator(`${menu} summary`)).toContainText(label);
          }
          if (fullscreen) await expect(card).not.toHaveAttribute('data-viewer-chrome-hidden');
          expectFooterHits(await footerHitGeometry(page));
        }
        await pointerCenter(page, page.getByRole('button', { name: 'Fit to viewer', exact: true }));
        await expect(page.getByRole('button', { name: 'Fit to viewer', exact: true })).toHaveAttribute('aria-pressed', 'true');
        expectFooterHits(await footerHitGeometry(page));
        const metadata = await footerGeometry(page);
        expect(metadata.metadata.height).toBeLessThanOrEqual(parseFloat(metadata.caption.lineHeight) + 1);
        expect(metadata.projectHidden).toBe(true);
        expect(metadata.cardOverflow).toBeLessThanOrEqual(1);
        if (fullscreen) {
          const before = await mediaGeometry(page);
          await clickViewingArea(page);
          await expect(card).toHaveAttribute('data-viewer-chrome-hidden', '');
          expectSameMedia(await mediaGeometry(page), before);
          await page.mouse.move(20, 100);
          await expect(card).not.toHaveAttribute('data-viewer-chrome-hidden');
          expectFooterHits(await footerHitGeometry(page));
        }
      }
    });
  }
}

async function zoomFooterMedia(page) {
  await pointerCenter(page, page.getByRole('button', { name: 'More viewer tools', exact: true }));
  await expect(page.locator('[data-unified-viewer-overflow]')).toHaveAttribute('open', '');
  await pointerCenter(page, page.getByRole('button', { name: 'Zoom in', exact: true }));
  await expect.poll(() => page.evaluate(() => document.getElementById('unified-viewer-dialog')
    .__creatorCrateUnifiedViewer.media.getState().view.mode)).toBe('zoom');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-unified-viewer-overflow]')).not.toHaveAttribute('open');
}

test('footer overlap negative control reproduces wrong center hits and actions at 320px with 150% fonts', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 420 });
  await openLibrary(page);
  await page.evaluate(() => { document.documentElement.style.fontSize = '24px'; });
  await openFooterFixture(page, { kind: 'slideshow' });
  // Restore only the original action-row sizing in this page, never on disk.
  await page.evaluate(() => {
    const actions = document.querySelector('.unified-viewer-context-actions');
    const footer = actions.closest('footer');
    const elements = [actions, footer, ...actions.children];
    const styles = elements.map((element) => element.getAttribute('style'));
    actions.style.flexWrap = 'nowrap';
    actions.style.justifyContent = 'flex-end';
    actions.style.columnGap = 'var(--space-xs)';
    footer.style.paddingInline = 'var(--space-sm)';
    for (const element of actions.children) {
      element.style.flexShrink = element.matches('.button') ? '0' : '1';
    }
    window.__restoreActionSizing = () => elements.forEach((element, index) => {
      if (styles[index] === null) element.removeAttribute('style');
      else element.setAttribute('style', styles[index]);
    });
  });
  try {
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await zoomFooterMedia(page);
    const geometry = await footerHitGeometry(page);
    console.log('Original overlap geometry:', JSON.stringify(geometry));
    expect(() => expectFooterHits(geometry)).toThrow();
    const fit = geometry.controls.find((control) => control.name === 'Fit to viewer');
    const play = geometry.controls.find((control) => control.name === 'Play slideshow');
    expect(fit.hit).toBe(false);
    expect(play.hit).toBe(false);
    expect(Math.min(play.right, fit.right) - Math.max(play.left, fit.left)).toBeGreaterThan(0);
    expect(await page.locator('[data-unified-viewer-card]').evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
    await pointerCenter(page, page.getByRole('button', { name: 'Fit to viewer', exact: true }));
    await expect(page.locator('[data-unified-viewer-overflow]')).toHaveAttribute('open', '');
    expect(await page.evaluate(() => document.getElementById('unified-viewer-dialog')
      .__creatorCrateUnifiedViewer.media.getState().view.mode)).toBe('zoom');
    expect(await page.evaluate(() => document.getElementById('unified-viewer-dialog')
      .__creatorCrateUnifiedViewer.playback.getState().playing)).toBe(false);
  } finally {
    await page.evaluate(() => { window.__restoreActionSizing(); delete window.__restoreActionSizing; });
    await page.keyboard.press('Escape');
  }
  expectFooterHits(await footerHitGeometry(page));
});

for (const kind of ['image', 'slideshow', 'comic', 'fullscreen slideshow']) {
  test(`footer center pointer actions at 320x420 with 150% fonts: ${kind}`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 420 });
    await openLibrary(page);
    await page.evaluate(() => { document.documentElement.style.fontSize = '24px'; });
    await openFooterFixture(page, { kind: kind.includes('slideshow') ? 'slideshow' : kind,
      filename: 'long-filename-'.repeat(30) + '.png', projectName: 'Long project name '.repeat(30) });
    const fullscreen = page.locator('[data-unified-viewer-fullscreen]');
    const card = page.locator('[data-unified-viewer-card]');
    if (kind === 'fullscreen slideshow') {
      await pointerCenter(page, fullscreen);
      await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
    }
    expectFooterHits(await footerHitGeometry(page));
    await zoomFooterMedia(page);
    const fit = page.getByRole('button', { name: 'Fit to viewer', exact: true });
    await pointerCenter(page, fit);
    await expect(fit).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-unified-viewer-overflow]')).not.toHaveAttribute('open');
    expect(await page.evaluate(() => document.getElementById('unified-viewer-dialog')
      .__creatorCrateUnifiedViewer.media.getState().view.mode)).toBe('fit');
    if (kind.includes('slideshow')) {
      const play = page.locator('[data-unified-viewer-play]');
      await pointerCenter(page, play);
      await expect(play).toHaveAccessibleName('Pause slideshow');
      expect(await page.evaluate(() => document.getElementById('unified-viewer-dialog')
        .__creatorCrateUnifiedViewer.playback.getState().playing)).toBe(true);
      await expect(page.locator('[data-unified-viewer-overflow]')).not.toHaveAttribute('open');
      if (kind === 'fullscreen slideshow') await expect(card).not.toHaveAttribute('data-viewer-chrome-hidden');
      await pointerCenter(page, play);
      await expect(play).toHaveAccessibleName('Play slideshow');
      expect(await page.evaluate(() => document.getElementById('unified-viewer-dialog')
        .__creatorCrateUnifiedViewer.playback.getState().playing)).toBe(false);
    }
    await expect(fit).toHaveAttribute('aria-pressed', 'true');
    if (kind === 'fullscreen slideshow') {
      await expect(card).not.toHaveAttribute('data-viewer-chrome-hidden');
      const visibleHeight = (await footerHitGeometry(page)).stage.height;
      await clickViewingArea(page);
      await expect(card).toHaveAttribute('data-viewer-chrome-hidden', '');
      await expect.poll(() => page.locator('[data-unified-viewer-stage]').evaluate((element) => element.clientHeight)).toBe(420);
      expect(visibleHeight).toBe(420);
      await page.keyboard.press('Tab');
      await expect(card).not.toHaveAttribute('data-viewer-chrome-hidden');
      expectFooterHits(await footerHitGeometry(page));
      await clickViewingArea(page);
      await expect(card).toHaveAttribute('data-viewer-chrome-hidden', '');
      await page.mouse.move(20, 100);
      await expect(card).not.toHaveAttribute('data-viewer-chrome-hidden');
      expectFooterHits(await footerHitGeometry(page));
      await pointerCenter(page, fullscreen);
      await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
    } else {
      await pointerCenter(page, fullscreen);
      await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
      await expect(card).not.toHaveAttribute('data-viewer-chrome-hidden');
      expectFooterHits(await footerHitGeometry(page));
      await pointerCenter(page, fullscreen);
      await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
    }
    expectFooterHits(await footerHitGeometry(page));
    await expect(fit).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-unified-viewer-overflow]')).not.toHaveAttribute('open');
    const details = page.getByRole('link', { name: 'View details', exact: true });
    const destination = await details.getAttribute('href');
    await page.route(`**${destination}`, (route) => route.fulfill({ contentType: 'text/html', body: '<h1>Asset details destination</h1>' }));
    await pointerCenter(page, details);
    await expect(page).toHaveURL(`${fixture.baseURL}${destination}`);
    await expect(page.getByRole('heading', { name: 'Asset details destination' })).toBeVisible();
  });
}

for (const [width, fontSize] of [[320, 16], [320, 20], [320, 24], [390, 16], [390, 20], [390, 24],
  [540, 16], [540, 20], [540, 24], [768, 16], [768, 20], [768, 24]]) {
  test(`footer hit geometry and inline metadata at ${width}px and ${fontSize}px fonts`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 320 : 420 });
    await openLibrary(page);
    await page.evaluate((size) => { document.documentElement.style.fontSize = `${size}px`; }, fontSize);
    for (const kind of ['image', 'slideshow', 'comic']) {
      await openFooterFixture(page, { kind, filename: 'long-filename-'.repeat(30) + '.png', projectName: 'Long project '.repeat(30) });
      const geometry = await footerHitGeometry(page);
      expectFooterHits(geometry);
      const metadata = await footerGeometry(page);
      expect(metadata.metadata.height).toBeLessThanOrEqual(parseFloat(metadata.caption.lineHeight) + 1);
      expect(metadata.projectHidden).toBe(true);
      expect(metadata.titleOverflow).toBe(true);
      expect(metadata.titleTooltip).toBe(metadata.titleValue);
      await expect(page.locator('[data-unified-viewer-title]')).toHaveAttribute('aria-label', metadata.titleValue);
      expect(metadata.cardOverflow).toBeLessThanOrEqual(1);
      expect(metadata.scrollWidth).toBeLessThanOrEqual(Math.max(metadata.viewportWidth, metadata.backgroundWidth));
      if (width === 320 && fontSize === 24) expect(geometry.actions.height).toBeGreaterThan(2 * fontSize);
      if (width === 768 && fontSize === 16) expect(geometry.actions.height).toBeLessThanOrEqual(2 * fontSize);
      await openFooterFixture(page, { kind, filename: 'page.png', projectName: 'Art' });
      await expect(page.locator('[data-unified-viewer-project]')).toBeVisible();
      const shortMetadata = await footerGeometry(page);
      expect(shortMetadata.title.top).toBeCloseTo(shortMetadata.source.top, 0);
      expect(shortMetadata.sourceWidth).toBeLessThanOrEqual(shortMetadata.source.width + 1);
      await openFooterFixture(page, { kind, projectName: null });
      await expect(page.locator('[data-unified-viewer-project]')).toBeHidden();
      await expect(page.locator('[data-unified-viewer-source]')).toHaveText('');
      expectFooterHits(await footerHitGeometry(page));
    }
  });
}

async function mediaGeometry(page) {
  await settleCloseStyle(page);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return page.locator(DIALOG).evaluate((dialog) => {
    const viewer = dialog.__creatorCrateUnifiedViewer;
    const rect = (element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    };
    const card = dialog.querySelector('[data-unified-viewer-card]');
    const media = dialog.querySelector('[data-unified-viewer-media]');
    const content = media.querySelector('.unified-viewer-spread, img:not([hidden])');
    return {
      card: rect(card), stage: rect(dialog.querySelector('[data-unified-viewer-stage]')), viewport: rect(media),
      content: rect(content), transform: content.style.transform, view: viewer.media.getState().view,
      pages: [...media.querySelectorAll('img:not([hidden])')].map((image) => ({ src: image.src, ...rect(image) })),
      key: viewer.getState().key, position: dialog.querySelector('[data-unified-viewer-position]').textContent,
      overflowX: card.scrollWidth - card.clientWidth, overflowY: card.scrollHeight - card.clientHeight,
      canvas: getComputedStyle(card).backgroundColor, stageColor: getComputedStyle(media.parentElement).backgroundColor,
      backdrop: getComputedStyle(card, '::backdrop').backgroundColor,
      chromeColors: [...dialog.querySelectorAll('.app-dialog-close, footer, .unified-viewer-controls')]
        .filter((element) => !element.hidden).map((element) => getComputedStyle(element).backgroundColor),
      chromeRects: [...dialog.querySelectorAll('.app-dialog-header, footer, .unified-viewer-controls')]
        .filter((element) => !element.hidden).map(rect),
    };
  });
}

function expectSameMedia(actual, expected, compareChrome = true) {
  // Independently rounded Chromium edges can differ by one layout unit (1/64 px).
  // A quarter CSS pixel allows that rounding, but rejects visible movement.
  for (const field of ['card', 'stage', 'viewport', 'content']) {
    for (const axis of ['x', 'y', 'width', 'height']) {
      expect(Math.abs(actual[field][axis] - expected[field][axis]), `${field}.${axis}`).toBeLessThanOrEqual(0.25);
    }
  }
  expect(actual.view).toEqual(expected.view);
  expect(actual.transform).toBe(expected.transform);
  if (compareChrome) expect(actual.chromeRects).toEqual(expected.chromeRects);
  expect(actual.key).toBe(expected.key);
  expect(actual.position).toBe(expected.position);
  expect(actual.pages).toHaveLength(expected.pages.length);
  for (const [index, page] of actual.pages.entries()) {
    expect(page.src).toBe(expected.pages[index].src);
    for (const axis of ['x', 'y', 'width', 'height']) {
      expect(Math.abs(page[axis] - expected.pages[index][axis]), `page ${index}.${axis}`).toBeLessThanOrEqual(0.25);
    }
  }
}

function expectFullMedia(geometry) {
  for (const field of ['stage', 'viewport']) {
    for (const axis of ['x', 'y', 'width', 'height']) {
      expect(Math.abs(geometry[field][axis] - geometry.card[axis]), `${field} fills card: ${axis}`).toBeLessThanOrEqual(0.25);
    }
  }
  expect(geometry.overflowX).toBeLessThanOrEqual(1);
  expect(geometry.overflowY).toBeLessThanOrEqual(1);
  expect(geometry.canvas).toBe('rgb(13, 15, 19)');
  expect(geometry.stageColor).toBe(geometry.canvas);
  expect(geometry.backdrop).toBe(geometry.canvas);
  for (const color of geometry.chromeColors) {
    expect(color).toBe('color(srgb 0.113725 0.133333 0.168627 / 0.88)');
  }
  if (geometry.pages.length === 2) {
    const [left, right] = [...geometry.pages].sort((a, b) => a.x - b.x);
    expect(Math.abs(right.x - left.x - left.width), 'gapless page edges').toBeLessThanOrEqual(0.25);
  }
}

async function chromeGeometryCycle(page) {
  const card = page.locator('[data-unified-viewer-card]');
  const visible = await mediaGeometry(page);
  const states = { visible };
  const { x, y } = await clickViewingArea(page);
  await expect(card).toHaveAttribute('data-viewer-chrome-hidden', '');
  states.clickHidden = await mediaGeometry(page);
  const hiddenHit = await page.locator('.unified-viewer-context [data-unified-viewer-fit]').evaluate((control) => {
    const r = control.getBoundingClientRect();
    return { hit: control.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)),
      focusedInChrome: Boolean(document.activeElement.closest('.app-dialog-header, footer, .unified-viewer-controls')) };
  });
  expect(hiddenHit).toEqual({ hit: false, focusedInChrome: false });
  await page.mouse.move(x + 20, y);
  await expect(card).not.toHaveAttribute('data-viewer-chrome-hidden');
  states.pointerRevealed = await mediaGeometry(page);
  await expect(card).toHaveAttribute('data-viewer-chrome-hidden', '', { timeout: 6000 });
  states.timerHidden = await mediaGeometry(page);
  await page.keyboard.press('Tab');
  await expect(card).not.toHaveAttribute('data-viewer-chrome-hidden');
  states.keyboardRevealed = await mediaGeometry(page);
  expect(await activeInDialog(page)).toBe(true);
  return states;
}

for (const [kind, direction, layout] of [
  ['image'], ['slideshow'], ['comic', 'ltr', 'single'],
  ['comic', 'ltr', 'spread-cover-alone'], ['comic', 'rtl', 'spread-cover-alone'],
  ['comic', 'ltr', 'spread-pair-from-first'], ['comic', 'rtl', 'spread-pair-from-first'],
]) {
  test(`fullscreen stable media geometry: ${kind} ${direction || ''} ${layout || ''}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 768, height: 600 });
    await openLibrary(page);
    await openFooterFixture(page, { kind, imageSize: { width: 1200, height: 1800 } });
    if (kind === 'comic') {
      await page.getByRole('button', { name: 'More viewer tools' }).click();
      await page.getByRole('combobox', { name: 'Reading direction', exact: true }).selectOption(direction);
      await page.getByRole('combobox', { name: 'Page layout', exact: true }).selectOption(layout);
      await page.keyboard.press('Escape');
      if (layout === 'spread-cover-alone') await page.getByRole('button', { name: 'Next', exact: true }).click();
      await expect(page.locator('[data-viewer-spread-state="loaded"]')).toHaveCount(layout === 'single' ? 1 : 2);
    }
    const normal = await mediaGeometry(page);
    await pointerCenter(page, page.getByRole('button', { name: 'Enter fullscreen', exact: true }));
    await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
    const fitStates = await chromeGeometryCycle(page);
    await testInfo.attach('fit-geometry', { body: JSON.stringify(fitStates, null, 2), contentType: 'application/json' });
    for (const geometry of Object.values(fitStates)) {
      expectFullMedia(geometry);
      expectSameMedia(geometry, fitStates.visible);
    }
    expect(fitStates.visible.view.mode).toBe('fit');
    await zoomFooterMedia(page);
    // Enough zoom to overflow both axes; exercise a nonzero pan with real keys.
    await page.evaluate(() => {
      const viewer = document.getElementById('unified-viewer-dialog').__creatorCrateUnifiedViewer;
      for (let i = 0; i < 8; i += 1) viewer.media.zoomIn();
    });
    await page.getByRole('button', { name: 'Fit to viewer', exact: true }).focus();
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Shift+ArrowDown');
    const zoomStates = await chromeGeometryCycle(page);
    await testInfo.attach('zoom-geometry', { body: JSON.stringify(zoomStates, null, 2), contentType: 'application/json' });
    expect(zoomStates.visible.view.mode).toBe('zoom');
    expect(Math.abs(zoomStates.visible.view.panX) + Math.abs(zoomStates.visible.view.panY)).toBeGreaterThan(0);
    for (const geometry of Object.values(zoomStates)) {
      expectFullMedia(geometry);
      expectSameMedia(geometry, zoomStates.visible);
    }
    await pointerCenter(page, page.getByRole('button', { name: 'Fit to viewer', exact: true }));
    // Chromium refuses Browser.setWindowBounds while natively fullscreen;
    // resize its layout viewport directly without leaving fullscreen.
    const browserSession = await page.context().newCDPSession(page);
    await browserSession.send('Emulation.setDeviceMetricsOverride', { width: 540, height: 420, deviceScaleFactor: 1, mobile: false });
    await expect.poll(async () => (await mediaGeometry(page)).view.viewportWidth).toBe(540);
    const resized = await mediaGeometry(page);
    expectFullMedia(resized);
    expect(resized.view.fitScale).not.toBe(fitStates.visible.view.fitScale);
    expect(resized.content.height).not.toBe(fitStates.visible.content.height);
    await browserSession.send('Emulation.setDeviceMetricsOverride', { width: 768, height: 600, deviceScaleFactor: 1, mobile: false });
    await pointerCenter(page, page.getByRole('button', { name: 'Exit fullscreen', exact: true }));
    await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
    await browserSession.detach();
    expectSameMedia(await mediaGeometry(page), normal);
    await pointerCenter(page, page.getByRole('button', { name: `Close ${kind === 'comic' ? 'Comic Reader' : kind === 'slideshow' ? 'Slideshow' : 'Image Preview'}`, exact: true }));
    await expect(page.locator(DIALOG)).toBeHidden();
  });
}

async function clickViewingArea(page) {
  const point = await page.locator('[data-unified-viewer-stage]').evaluate((stage) => {
    const r = stage.getBoundingClientRect();
    for (const fy of [0.5, 0.33, 0.25, 0.75]) {
      for (const fx of [0.5, 0.1, 0.9]) {
        const x = r.x + r.width * fx;
        const y = r.y + r.height * fy;
        const hit = document.elementFromPoint(x, y);
        if (stage.contains(hit) && !hit.closest('.unified-viewer-controls, button, a[href], summary, select, [data-viewer-interactive]')) return { x, y };
      }
    }
    throw new Error('No exposed viewing area');
  });
  await page.mouse.click(point.x, point.y);
  return point;
}

for (const width of [320, 390, 540, 768, 1440]) {
  for (const fontSize of [16, 20, 24]) {
    test(`fullscreen overlay hit geometry at ${width}px with ${fontSize}px fonts`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 320 : 420 });
      await openLibrary(page);
      await page.evaluate((size) => { document.documentElement.style.fontSize = `${size}px`; }, fontSize);
      for (const kind of ['image', 'slideshow', 'comic']) {
        await openFooterFixture(page, { kind, filename: 'long-filename-'.repeat(30), projectName: 'Long project '.repeat(30),
          imageSize: { width: 1200, height: 1800 } });
        await pointerCenter(page, page.getByRole('button', { name: 'Enter fullscreen', exact: true }));
        await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
        const visible = await mediaGeometry(page);
        expectFullMedia(visible);
        expectMinimalFullscreenClose(await fullscreenCloseGeometry(page));
        expectFooterHits(await footerHitGeometry(page));
        const metadata = await footerGeometry(page);
        expect(metadata.metadata.height).toBeLessThanOrEqual(parseFloat(metadata.caption.lineHeight) + 1);
        await clickViewingArea(page);
        await expect(page.locator('[data-unified-viewer-card]')).toHaveAttribute('data-viewer-chrome-hidden', '');
        expectSameMedia(await mediaGeometry(page), visible);
        await page.keyboard.press('Tab');
        await expect(page.locator('[data-unified-viewer-card]')).not.toHaveAttribute('data-viewer-chrome-hidden');
        expectSameMedia(await mediaGeometry(page), visible);
        expectFooterHits(await footerHitGeometry(page));
        await pointerCenter(page, page.getByRole('button', { name: 'Exit fullscreen', exact: true }));
        await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
      }
    });
  }
}

async function overlayStyleProbe(page, css) {
  return page.evaluateHandle((text) => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(text);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    return sheet;
  }, css);
}

async function removeOverlayStyleProbe(handle) {
  await handle.evaluate((sheet) => { document.adoptedStyleSheets = document.adoptedStyleSheets.filter((entry) => entry !== sheet); });
  await handle.dispose();
}

test('fullscreen geometry assertions reject shrinking flow, collapsing chrome and blocked overlay hits', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 600 });
  await openLibrary(page);
  for (const kind of ['image', 'comic']) {
    await openFooterFixture(page, { kind, imageSize: { width: 1200, height: 1800 } });
    if (kind === 'comic') {
      await page.getByRole('button', { name: 'More viewer tools' }).click();
      await page.getByRole('combobox', { name: 'Page layout', exact: true }).selectOption('spread-pair-from-first');
      await page.keyboard.press('Escape');
      await expect(page.locator('[data-viewer-spread-state="loaded"]')).toHaveCount(2);
    }
    await pointerCenter(page, page.getByRole('button', { name: 'Enter fullscreen', exact: true }));
    const baseline = await mediaGeometry(page);
    const prefix = '.unified-viewer-dialog > .app-dialog-card:fullscreen';
    const mutations = [
      `${prefix} { display:flex; flex-direction:column; }
       ${prefix} .unified-viewer { position:static; display:flex; }
       ${prefix} .unified-viewer-stage { position:relative; inset:auto; }
       ${prefix} > .app-dialog-header { position:static; }`,
      `${prefix} .unified-viewer-stage { bottom:100px; }`,
    ];
    for (const css of mutations) {
      const style = await overlayStyleProbe(page, css);
      try {
        const changed = await mediaGeometry(page);
        expect(() => expectFullMedia(changed)).toThrow();
        expect(() => expectSameMedia(changed, baseline)).toThrow();
        expect(changed.view.fitScale).not.toBe(baseline.view.fitScale);
        expect(changed.pages).not.toEqual(baseline.pages);
      } finally { await removeOverlayStyleProbe(style); }
      expectSameMedia(await mediaGeometry(page), baseline);
    }
    const blocked = await overlayStyleProbe(page, `${prefix} footer { pointer-events:none; }`);
    try {
      const hits = await footerHitGeometry(page);
      expect(() => expectFooterHits(hits)).toThrow();
    } finally {
      await removeOverlayStyleProbe(blocked);
    }
    expectFooterHits(await footerHitGeometry(page));
    await clickViewingArea(page);
    const collapsed = await overlayStyleProbe(page, `${prefix}[data-viewer-chrome-hidden] :is(.app-dialog-header, footer, .unified-viewer-controls)
      { height:0; min-height:0; max-height:0; padding:0; margin:0; border:0; overflow:hidden; }`);
    try {
      const changed = await mediaGeometry(page);
      expect(() => expectSameMedia(changed, baseline)).toThrow();
    } finally {
      await removeOverlayStyleProbe(collapsed);
    }
    expectSameMedia(await mediaGeometry(page), baseline);
    await page.keyboard.press('Tab');
    await pointerCenter(page, page.getByRole('button', { name: 'Exit fullscreen', exact: true }));
    await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
  }
});

test('fullscreen chrome toggles preserve a running slideshow deadline', async ({ page }) => {
  await page.clock.install();
  await page.setViewportSize({ width: 768, height: 600 });
  await openLibrary(page);
  await openFooterFixture(page, { kind: 'slideshow' });
  await pointerCenter(page, page.getByRole('button', { name: 'Enter fullscreen', exact: true }));
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await page.clock.pauseAt(new Date(Date.now() + 100));
  await pointerCenter(page, page.getByRole('button', { name: 'Play slideshow', exact: true }));
  const playback = () => page.evaluate(() => document.getElementById('unified-viewer-dialog')
    .__creatorCrateUnifiedViewer.playback.getState());
  const first = await playback();
  expect(first).toMatchObject({ playing: true, scheduled: true, speed: 4000 });
  await page.clock.runFor(1500);
  await clickViewingArea(page);
  await expect(page.locator('[data-unified-viewer-card]')).toHaveAttribute('data-viewer-chrome-hidden', '');
  expect(await playback()).toEqual(first);
  await page.clock.runFor(1500);
  await page.mouse.move(100, 180);
  await expect(page.locator('[data-unified-viewer-card]')).not.toHaveAttribute('data-viewer-chrome-hidden');
  expect(await playback()).toEqual(first);
  await page.clock.runFor(999);
  expect((await playback()).key).toBe(first.key);
  await page.clock.runFor(1);
  await expect(page.locator('[data-unified-viewer-position]')).toHaveText('2 of 3');
  expect((await playback()).playing).toBe(true);
});

test('fullscreen overlay styles leave Video Preview geometry and surfaces unchanged', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 600 });
  await openLibrary(page);
  const videoStyles = () => page.locator('[data-asset-video-preview-title]').evaluate((title) => {
    const dialog = title.closest('dialog');
    dialog.showModal();
    const result = [...dialog.querySelectorAll('.app-dialog-card, .app-dialog-header, footer, video')].map((element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return { tag: element.tagName, x, y, width, height, position: style.position, background: style.backgroundColor };
    });
    dialog.close();
    return result;
  });
  const before = await videoStyles();
  expect(before.length).toBeGreaterThan(0);
  await openFooterFixture(page);
  await pointerCenter(page, page.getByRole('button', { name: 'Enter fullscreen', exact: true }));
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await pointerCenter(page, page.getByRole('button', { name: 'Close Image Preview', exact: true }));
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
  expect(await videoStyles()).toEqual(before);
});

test('fullscreen safe-area insets protect overlay targets without reducing the media viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 420 });
  await openLibrary(page);
  await page.evaluate(() => { document.documentElement.style.fontSize = '24px'; });
  await openFooterFixture(page, { kind: 'slideshow', imageSize: { width: 1200, height: 1800 } });
  const browserSession = await page.context().newCDPSession(page);
  await browserSession.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 30, right: 28, bottom: 34, left: 24 } });
  try {
    await pointerCenter(page, page.getByRole('button', { name: 'Enter fullscreen', exact: true }));
    const visible = await mediaGeometry(page);
    expectFullMedia(visible);
    const close = await fullscreenCloseGeometry(page);
    expectMinimalFullscreenClose(close);
    expect(close.button.y).toBeGreaterThanOrEqual(30);
    expect(close.button.right).toBeLessThanOrEqual(390 - 28);
    const hits = await footerHitGeometry(page);
    expectFooterHits(hits);
    for (const control of hits.controls) {
      expect(control.left, control.name).toBeGreaterThanOrEqual(24);
      expect(control.right, control.name).toBeLessThanOrEqual(390 - 28);
      expect(control.top, control.name).toBeGreaterThanOrEqual(30);
      expect(control.bottom, control.name).toBeLessThanOrEqual(420 - 34);
    }
    await clickViewingArea(page);
    expectSameMedia(await mediaGeometry(page), visible);
    await page.keyboard.press('Tab');
    expectSameMedia(await mediaGeometry(page), visible);
    expectFooterHits(await footerHitGeometry(page));
  } finally {
    await browserSession.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
    await browserSession.detach();
  }
});

async function settleCloseStyle(page) {
  await page.locator(`${DIALOG} [data-dialog-close]`).first().evaluate(async (button) => {
    getComputedStyle(button).backgroundColor;
    await Promise.all(button.getAnimations().map((animation) => animation.finished.catch(() => {})));
  });
}

async function fullscreenCloseGeometry(page) {
  await settleCloseStyle(page);
  return page.locator(DIALOG).evaluate((dialog) => {
    const rect = (element) => {
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    };
    const header = dialog.querySelector('.app-dialog-header');
    const heading = header.querySelector('h2');
    const button = header.querySelector('[data-dialog-close]');
    const stage = dialog.querySelector('[data-unified-viewer-stage]');
    const hs = getComputedStyle(header);
    const ts = getComputedStyle(heading);
    const bs = getComputedStyle(button);
    const b = rect(button);
    const beside = { x: b.x - 8, y: b.y + b.height / 2 };
    const center = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
    return {
      header: rect(header), heading: rect(heading), button: b, beside,
      headerBackground: hs.backgroundColor, headerBorder: hs.borderBottomWidth,
      headerPadding: [hs.paddingTop, hs.paddingRight, hs.paddingBottom, hs.paddingLeft],
      headingClip: ts.clip, headingDisplay: ts.display, headingVisibility: ts.visibility,
      headingAriaHidden: heading.getAttribute('aria-hidden'),
      labelledBy: dialog.getAttribute('aria-labelledby'), headingId: heading.id, title: heading.textContent,
      closeLabel: button.getAttribute('aria-label'), closeTooltip: button.title,
      closeCount: dialog.querySelectorAll('[data-dialog-close]').length,
      buttonBackground: bs.backgroundColor, buttonRadius: bs.borderRadius,
      buttonColor: bs.color, buttonOutline: bs.outlineStyle, buttonShadow: bs.boxShadow,
      hovered: button.matches(':hover'), focused: button.matches(':focus-visible'),
      headerOpacity: hs.opacity, buttonPointerEvents: bs.pointerEvents,
      centerHitsClose: button.contains(center), besideHitsStage: stage.contains(document.elementFromPoint(beside.x, beside.y)),
      focusedInChrome: Boolean(document.activeElement.closest('.app-dialog-header, footer, .unified-viewer-controls')),
      viewport: { width: innerWidth, height: innerHeight }, rootFont: parseFloat(getComputedStyle(document.documentElement).fontSize),
    };
  });
}

function expectMinimalFullscreenClose(g) {
  expect(g.closeCount, 'one existing close button').toBe(1);
  expect(g.labelledBy, 'stable accessible title reference').toBe('unified-viewer-dialog-title');
  expect(g.headingId).toBe(g.labelledBy);
  expect(g.title.trim()).toMatch(/^(Image Preview|Slideshow|Comic Reader)$/);
  expect(g.closeLabel).toBe(`Close ${g.title.trim()}`);
  expect(g.closeTooltip).toBe(g.closeLabel);
  expect(g.headingDisplay).not.toBe('none');
  expect(g.headingVisibility).toBe('visible');
  expect(g.headingAriaHidden).not.toBe('true');
  expect(g.headingClip, 'fullscreen title visually clipped').toBe('rect(0px, 0px, 0px, 0px)');
  expect(g.heading.width).toBe(1);
  expect(g.heading.height).toBe(1);
  expect(g.headerBackground, 'no header surface').toBe('rgba(0, 0, 0, 0)');
  expect(g.headerBorder, 'no header border').toBe('0px');
  expect(g.headerPadding).toEqual(['0px', '0px', '0px', '0px']);
  expect(g.header).toEqual(g.button);
  expect(g.button.width).toBeGreaterThanOrEqual(2 * g.rootFont);
  expect(g.button.height).toBeGreaterThanOrEqual(2 * g.rootFont);
  expect(g.button.width).toBeLessThanOrEqual(2.5 * g.rootFont);
  expect(g.button.height).toBeLessThanOrEqual(2.5 * g.rootFont);
  expect(g.button.x).toBeGreaterThanOrEqual(0);
  expect(g.button.y).toBeGreaterThanOrEqual(0);
  expect(g.button.right).toBeLessThanOrEqual(g.viewport.width);
  expect(g.button.bottom).toBeLessThanOrEqual(g.viewport.height);
  expect(g.buttonRadius).toBe(`${0.5 * g.rootFont}px`);
  expect(g.buttonBackground).toBe(g.hovered ? 'rgb(35, 42, 56)' : 'color(srgb 0.113725 0.133333 0.168627 / 0.88)');
  expect(g.centerHitsClose, 'physical close target').toBe(true);
  expect(g.besideHitsStage, 'former header region belongs to stage').toBe(true);
}

for (const kind of ['image', 'slideshow', 'comic']) {
  test(`minimal fullscreen close: ${kind} title, physical hits, chrome lifecycle and reopen`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 768, height: 600 });
    await openLibrary(page);
    await openFooterFixture(page, { kind, imageSize: { width: 1200, height: 1800 } });
    const title = kind === 'comic' ? 'Comic Reader' : kind === 'slideshow' ? 'Slideshow' : 'Image Preview';
    const dialog = page.locator(DIALOG);
    const card = dialog.locator('[data-unified-viewer-card]');
    const close = dialog.locator('[data-dialog-close]');
    const normal = await fullscreenCloseGeometry(page);
    expect(normal.headingClip).toBe('auto');
    expect(normal.header.width).toBeGreaterThan(normal.button.width * 2);
    expect(normal.headerBorder).toBe('1px');
    await expect(dialog.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await expectTitle(page, title);
    await page.evaluate(() => {
      const dialog = document.getElementById('unified-viewer-dialog');
      window.__minimalHeader = dialog.querySelector('.app-dialog-header');
      window.__minimalHeading = dialog.querySelector('h2');
      window.__minimalClose = dialog.querySelector('[data-dialog-close]');
      window.__minimalCloses = 0;
      dialog.__creatorCrateUnifiedViewer.observe((change) => { if (change.type === 'close') window.__minimalCloses += 1; });
    });
    await pointerCenter(page, dialog.getByRole('button', { name: 'Enter fullscreen', exact: true }));
    await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
    await expectTitle(page, title);
    const visible = await fullscreenCloseGeometry(page);
    expectMinimalFullscreenClose(visible);
    const media = await mediaGeometry(page);
    expectFullMedia(media);
    expect(await page.evaluate(() => {
      const dialog = document.getElementById('unified-viewer-dialog');
      return window.__minimalHeader === dialog.querySelector('.app-dialog-header')
        && window.__minimalHeading === dialog.querySelector('h2') && window.__minimalClose === dialog.querySelector('[data-dialog-close]');
    })).toBe(true);
    // A physical click beside X reaches the stage and uses the existing click-to-hide lifecycle.
    await page.mouse.click(visible.beside.x, visible.beside.y);
    await expect(card).toHaveAttribute('data-viewer-chrome-hidden', '');
    const hidden = await fullscreenCloseGeometry(page);
    expect(hidden.headerOpacity).toBe('0');
    expect(hidden.buttonPointerEvents).toBe('none');
    expect(hidden.centerHitsClose).toBe(false);
    expect(hidden.focusedInChrome).toBe(false);
    expectSameMedia(await mediaGeometry(page), media);
    expect((await viewerState(page)).open).toBe(true);
    expect((await viewerState(page)).fullscreen).toBe(true);
    await page.mouse.move(visible.beside.x - 20, visible.beside.y);
    await expect(card).not.toHaveAttribute('data-viewer-chrome-hidden');
    expectMinimalFullscreenClose(await fullscreenCloseGeometry(page));
    expectSameMedia(await mediaGeometry(page), media);
    await expect(card).toHaveAttribute('data-viewer-chrome-hidden', '', { timeout: 6000 });
    await page.keyboard.press('Tab');
    await expect(card).not.toHaveAttribute('data-viewer-chrome-hidden');
    await close.focus();
    const focused = await fullscreenCloseGeometry(page);
    expect(focused.focused).toBe(true);
    expect(focused.buttonOutline !== 'none' || focused.buttonShadow !== 'none').toBe(true);
    await close.hover();
    await expect(close).toHaveCSS('background-color', 'rgb(35, 42, 56)');
    await expect(close).toHaveCSS('color', 'rgb(232, 236, 241)');
    const hovered = await fullscreenCloseGeometry(page);
    expectMinimalFullscreenClose(hovered);
    await testInfo.attach('fullscreen-close', { body: await page.screenshot(), contentType: 'image/png' });
    await testInfo.attach('minimal-close-geometry', { body: JSON.stringify({ normal, visible, hidden, focused, hovered }, null, 2), contentType: 'application/json' });
    await pointerCenter(page, close);
    await expect(dialog).toBeHidden();
    await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
    await expect(page.locator('#test-opener')).toBeFocused();
    expect(await page.evaluate(() => window.__minimalCloses)).toBe(1);
    expect(await viewerState(page)).toMatchObject({ open: false, mediaStatus: 'idle', playback: { playing: false } });
    await expect(dialog.locator('img')).toHaveCount(0);
    await openFooterFixture(page, { kind });
    await expectTitle(page, title);
    expect(await fullscreenCloseGeometry(page)).toMatchObject({ header: normal.header, headingClip: 'auto', headerBorder: normal.headerBorder });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
}

test('minimal fullscreen close assertions reject header, title, hitbox, background, position, name and duplicate regressions', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 600 });
  await openLibrary(page);
  await openFooterFixture(page);
  await pointerCenter(page, page.getByRole('button', { name: 'Enter fullscreen', exact: true }));
  const baseline = await fullscreenCloseGeometry(page);
  expectMinimalFullscreenClose(baseline);
  const prefix = '.unified-viewer-dialog > .app-dialog-card:fullscreen';
  for (const css of [
    `${prefix} > .app-dialog-header { left:0; right:0; background:var(--surface-card); border-bottom:1px solid var(--border); }`,
    `${prefix} > .app-dialog-header h2 { position:static; width:auto; height:auto; clip:auto; margin:0; }`,
    `${prefix} > .app-dialog-header { left:0; right:0; justify-content:flex-end; }`,
    `${prefix} .app-dialog-close { background:transparent !important; }`,
    `${prefix} > .app-dialog-header { right:-100px; }`,
    `${prefix} .unified-viewer-stage { top:48px; }`,
  ]) {
    const sheet = await overlayStyleProbe(page, css);
    try {
      if (css.includes('.unified-viewer-stage')) expect(() => expectFullMedia(awaitedGeometry)).toBeDefined();
      const changed = await fullscreenCloseGeometry(page);
      if (css.includes('.unified-viewer-stage')) {
        const geometry = await mediaGeometry(page);
        expect(() => expectFullMedia(geometry)).toThrow();
      } else {
        expect(() => expectMinimalFullscreenClose(changed)).toThrow();
      }
    } finally { await removeOverlayStyleProbe(sheet); }
    expectMinimalFullscreenClose(await fullscreenCloseGeometry(page));
  }
  await page.locator(DIALOG).evaluate((dialog) => dialog.removeAttribute('aria-labelledby'));
  try {
    const changed = await fullscreenCloseGeometry(page);
    expect(() => expectMinimalFullscreenClose(changed)).toThrow();
    await expect(page.locator(DIALOG)).not.toHaveAccessibleName('Image Preview');
  } finally { await page.locator(DIALOG).evaluate((dialog) => dialog.setAttribute('aria-labelledby', 'unified-viewer-dialog-title')); }
  await page.locator(DIALOG).evaluate((dialog) => {
    const copy = dialog.querySelector('[data-dialog-close]').cloneNode(true);
    copy.dataset.testDuplicateClose = '';
    dialog.querySelector('.app-dialog-header').append(copy);
  });
  try {
    const changed = await fullscreenCloseGeometry(page);
    expect(() => expectMinimalFullscreenClose(changed)).toThrow();
  } finally { await page.locator('[data-test-duplicate-close]').evaluate((element) => element.remove()); }
  expectMinimalFullscreenClose(await fullscreenCloseGeometry(page));
  await expectTitle(page, 'Image Preview');
});

test('minimal fullscreen close keeps contextual names through session replacement, paused slideshow and comic loading/failure', async ({ page }) => {
  await openLibrary(page);
  await openFooterFixture(page);
  await pointerCenter(page, page.getByRole('button', { name: 'Enter fullscreen', exact: true }));
  await openFooterFixture(page, { kind: 'slideshow' });
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
  await expectTitle(page, 'Slideshow');
  expect((await viewerState(page)).playback.playing).toBe(false);
  expect((await fullscreenCloseGeometry(page)).headingClip).toBe('auto');
  await pointerCenter(page, page.getByRole('button', { name: 'Enter fullscreen', exact: true }));
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  expectMinimalFullscreenClose(await fullscreenCloseGeometry(page));
  let pending;
  await page.route('**/projects/7/assets/77/comic', (route) => { pending = route; });
  await page.evaluate(() => document.getElementById('unified-viewer-dialog').__creatorCrateUnifiedViewer.openComic(
    { projectId: 7, assetId: 77 }, { opener: document.getElementById('test-opener') },
  ));
  await expect.poll(() => Boolean(pending)).toBe(true);
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
  expect((await viewerState(page)).comic.state).toBe('loading');
  await expectTitle(page, 'Comic Reader');
  expect((await fullscreenCloseGeometry(page)).headingClip).toBe('auto');
  await pointerCenter(page, page.getByRole('button', { name: 'Enter fullscreen', exact: true }));
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  expectMinimalFullscreenClose(await fullscreenCloseGeometry(page));
  await pending.fulfill({ status: 503 });
  await expect.poll(async () => (await viewerState(page)).comic.state).toBe('failed');
  await expectTitle(page, 'Comic Reader');
  expectMinimalFullscreenClose(await fullscreenCloseGeometry(page));
  await pointerCenter(page, page.getByRole('button', { name: 'Close Comic Reader', exact: true }));
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
});

test('minimal fullscreen close survives emulated 200% browser zoom and fullscreen resizing', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 600 });
  await openLibrary(page);
  await openFooterFixture(page);
  await pointerCenter(page, page.getByRole('button', { name: 'Enter fullscreen', exact: true }));
  const browserSession = await page.context().newCDPSession(page);
  try {
    // Model browser zoom with half the CSS layout viewport and twice the device scale.
    for (const metrics of [{ width: 384, height: 300, deviceScaleFactor: 2 }, { width: 540, height: 420, deviceScaleFactor: 1 }]) {
      await browserSession.send('Emulation.setDeviceMetricsOverride', { ...metrics, mobile: false });
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(metrics.width);
      expectMinimalFullscreenClose(await fullscreenCloseGeometry(page));
      const visible = await mediaGeometry(page);
      expectFullMedia(visible);
      await clickViewingArea(page);
      expectSameMedia(await mediaGeometry(page), visible);
      await page.keyboard.press('Tab');
      expectMinimalFullscreenClose(await fullscreenCloseGeometry(page));
      expectSameMedia(await mediaGeometry(page), visible);
      expectFooterHits(await footerHitGeometry(page));
    }
  } finally {
    await browserSession.send('Emulation.clearDeviceMetricsOverride');
    await browserSession.detach();
  }
  await pointerCenter(page, page.getByRole('button', { name: 'Close Image Preview', exact: true }));
  await expect(page.locator(DIALOG)).toBeHidden();
});

for (const kind of ['comic', 'slideshow']) {
  test(`navigation overlay owns zero layout space and follows measured footer: ${kind}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 768, height: 600 });
    await openLibrary(page);
    await openFooterFixture(page, { kind, imageSize: { width: 1200, height: 1800 }, count: 10 });
    const nav = page.locator('[data-unified-viewer-controls]');
    const next = page.getByRole('button', { name: 'Next', exact: true });
    await nav.evaluate((element) => { window.__originalNavigation = element; });
    expectFooterHits(await footerHitGeometry(page));
    const normal = await mediaGeometry(page);
    await nav.evaluate((element) => { element.hidden = true; });
    expectSameMedia(await mediaGeometry(page), normal, false);
    await nav.evaluate((element) => { element.hidden = false; });
    expectSameMedia(await mediaGeometry(page), normal);
    await pointerCenter(page, next);
    await expect(page.locator('[data-unified-viewer-position]')).toHaveText(kind === 'comic' ? 'Page 2 of 10' : '2 of 10');
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('[data-unified-viewer-position]')).toHaveText(kind === 'comic' ? 'Page 1 of 10' : '1 of 10');
    await pointerCenter(page, page.getByRole('button', { name: 'Enter fullscreen', exact: true }));
    await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
    const baseline = await mediaGeometry(page);
    const before = await footerHitGeometry(page);
    await page.locator('[data-unified-viewer-context]').evaluate((footer) => { footer.style.paddingBottom = '64px'; });
    await expect.poll(async () => {
      const geometry = await footerHitGeometry(page);
      return geometry.navigation.bottom < geometry.footer.top;
    }).toBe(true);
    const wrapped = await footerHitGeometry(page);
    expectFooterHits(wrapped);
    expect(wrapped.footer.height).toBeGreaterThan(before.footer.height + 30);
    expect(before.navigation.top - wrapped.navigation.top).toBeCloseTo(wrapped.footer.height - before.footer.height, 0);
    expectSameMedia(await mediaGeometry(page), baseline, false);
    await page.locator('[data-unified-viewer-context]').evaluate((footer) => footer.style.removeProperty('padding-bottom'));
    await expect.poll(async () => (await footerHitGeometry(page)).navigation.top).toBe(before.navigation.top);
    expectSameMedia(await mediaGeometry(page), baseline);
    await pointerCenter(page, next);
    await expect(page.locator('[data-viewer-chrome-hidden]')).toHaveCount(0);
    await expect(page.locator('[data-unified-viewer-position]')).toHaveText(kind === 'comic' ? 'Page 2 of 10' : '2 of 10');
    await page.getByRole('button', { name: 'Previous', exact: true }).focus();
    await clickViewingArea(page);
    await expect(page.locator('[data-unified-viewer-card]')).toHaveAttribute('data-viewer-chrome-hidden', '');
    expect(await nav.evaluate((element) => {
      const r = element.getBoundingClientRect();
      return { hit: element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)),
        focus: element.contains(document.activeElement) };
    })).toEqual({ hit: false, focus: false });
    await page.keyboard.press('Tab');
    expect(await nav.evaluate((element) => element === window.__originalNavigation)).toBe(true);
    expectFooterHits(await footerHitGeometry(page));
    await testInfo.attach('navigation-measurements', { body: JSON.stringify({ normal, baseline, before, wrapped }, null, 2), contentType: 'application/json' });
  });
}

test('navigation overlay assertions reject flow, strips, pan ownership, overlap and missing slideshow controls', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 600 });
  await openLibrary(page);
  for (const kind of ['comic', 'slideshow']) {
    await openFooterFixture(page, { kind });
    const probes = [
      () => {
        const nav = document.querySelector('[data-unified-viewer-controls]');
        nav.hidden = true;
        return () => { nav.hidden = false; };
      },
      () => {
        const nav = document.querySelector('[data-unified-viewer-controls]');
        const stage = nav.parentElement;
        stage.after(nav);
        nav.style.position = 'static';
        return () => { stage.append(nav); nav.style.removeProperty('position'); };
      },
      () => {
        const stage = document.querySelector('[data-unified-viewer-stage]');
        stage.style.borderTop = '1px solid red';
        return () => stage.style.removeProperty('border-top');
      },
      () => {
        const nav = document.querySelector('[data-unified-viewer-controls]');
        nav.style.width = '100%';
        return () => nav.style.removeProperty('width');
      },
      () => {
        const nav = document.querySelector('[data-unified-viewer-controls]');
        nav.style.bottom = '-30px';
        return () => nav.style.removeProperty('bottom');
      },
      () => {
        const nav = document.querySelector('[data-unified-viewer-controls]');
        const stage = nav.parentElement;
        document.querySelector('[data-unified-viewer-media]').append(nav);
        return () => stage.append(nav);
      },
      () => {
        const nav = document.querySelector('[data-unified-viewer-controls]');
        nav.style.background = 'var(--surface-card)';
        return () => nav.style.removeProperty('background');
      },
      () => {
        const next = document.querySelector('[data-unified-viewer-next]');
        next.style.pointerEvents = 'none';
        return () => next.style.removeProperty('pointer-events');
      },
    ];
    for (const probe of probes) {
      await page.evaluate((script) => { window.__restoreNavigation = (0, eval)(`(${script})`)(); }, probe.toString());
      try {
        const geometry = await footerHitGeometry(page);
        expect(() => expectFooterHits(geometry)).toThrow();
      } finally { await page.evaluate(() => { window.__restoreNavigation(); delete window.__restoreNavigation; }); }
      expectFooterHits(await footerHitGeometry(page));
    }
    await pointerCenter(page, page.getByRole('button', { name: 'Enter fullscreen', exact: true }));
    const baseline = await mediaGeometry(page);
    await clickViewingArea(page);
    const probe = await overlayStyleProbe(page, '.app-dialog-card:fullscreen[data-viewer-chrome-hidden] .unified-viewer-controls { bottom: 0; }');
    try {
      const moved = await mediaGeometry(page);
      expect(() => expectSameMedia(moved, baseline)).toThrow();
    } finally { await removeOverlayStyleProbe(probe); }
    expectSameMedia(await mediaGeometry(page), baseline);
    await page.keyboard.press('Tab');
    await pointerCenter(page, page.getByRole('button', { name: 'Exit fullscreen', exact: true }));
  }
});

test('navigation overlay leaves page Retry and status actions accessible in short windows', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 320 });
  await openLibrary(page);
  await page.evaluate(() => { document.documentElement.style.fontSize = '24px'; });
  await openFooterFixture(page, { kind: 'comic', imageSize: { width: 1200, height: 1800 } });
  let failed = true;
  await page.route('**/projects/7/assets/40/comic/pages/*', (route) => failed
    ? route.fulfill({ status: 503, body: '' }) : route.fallback());
  await page.evaluate(() => document.getElementById('unified-viewer-dialog').__creatorCrateUnifiedViewer.openComic({
    projectId: 7, assetId: 40, filename: 'retry.cbz', detailsUrl: '/projects/7/assets/40',
  }));
  const retry = page.locator('[data-unified-viewer-page-retry]');
  await expect(retry).toBeVisible();
  expectFooterHits(await footerHitGeometry(page));
  failed = false;
  await pointerCenter(page, retry);
  await expect(retry).toHaveCount(0);
  await page.locator('[data-unified-viewer-status]').evaluate((status) => { status.textContent = 'Source status notification'; });
  const bounds = await page.locator(DIALOG).evaluate((dialog) => {
    const status = dialog.querySelector('[data-unified-viewer-status]').getBoundingClientRect();
    const nav = dialog.querySelector('[data-unified-viewer-controls]').getBoundingClientRect();
    return { statusBottom: status.bottom, navTop: nav.top };
  });
  expect(bounds.statusBottom).toBeLessThanOrEqual(bounds.navTop);
});

test.describe('navigation touch targets', () => {
  test.use({ hasTouch: true });
  for (const kind of ['comic', 'slideshow']) {
    test(`navigation overlay touch taps keep chrome and stage gestures separate: ${kind}`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 700 });
      await openLibrary(page);
      await openFooterFixture(page, { kind });
      const next = page.getByRole('button', { name: 'Next', exact: true });
      const previous = page.getByRole('button', { name: 'Previous', exact: true });
      const card = page.locator('[data-unified-viewer-card]');
      const position = page.locator('[data-unified-viewer-position]');
      await next.tap();
      await expect(position).toHaveText(kind === 'comic' ? 'Page 2 of 3' : '2 of 3');
      await page.getByRole('button', { name: 'Enter fullscreen', exact: true }).tap();
      await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
      await previous.tap();
      await expect(position).toHaveText(kind === 'comic' ? 'Page 1 of 3' : '1 of 3');
      await expect(card).not.toHaveAttribute('data-viewer-chrome-hidden');
      const stage = await page.locator('[data-unified-viewer-stage]').boundingBox();
      await page.touchscreen.tap(stage.x + 20, stage.y + stage.height / 3);
      await expect(card).toHaveAttribute('data-viewer-chrome-hidden', '');
      await page.keyboard.press('Tab');
      await expect(card).not.toHaveAttribute('data-viewer-chrome-hidden');
      // Simulate a stage-hide handler incorrectly accepting a navigation tap.
      await page.locator('[data-unified-viewer-controls]').evaluate((nav) => {
        const hide = () => nav.closest('[data-unified-viewer-card]').setAttribute('data-viewer-chrome-hidden', '');
        nav.addEventListener('pointerup', hide);
        window.__restoreNavigationTap = () => {
          nav.removeEventListener('pointerup', hide);
          nav.closest('[data-unified-viewer-card]').removeAttribute('data-viewer-chrome-hidden');
        };
      });
      try {
        await next.tap();
        const hidden = await card.getAttribute('data-viewer-chrome-hidden');
        expect(() => expect(hidden, 'a navigation tap must keep chrome visible').toBeNull()).toThrow();
      } finally {
        await page.evaluate(() => { window.__restoreNavigationTap(); delete window.__restoreNavigationTap; });
      }
      await next.tap();
      await expect(position).toHaveText(kind === 'comic' ? 'Page 2 of 3' : '2 of 3');
      await expect(card).not.toHaveAttribute('data-viewer-chrome-hidden');
      expectFooterHits(await footerHitGeometry(page));
    });
  }
});

test('navigation overlay preserves slideshow failure Retry in a short scaled dialog', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 320 });
  await openLibrary(page);
  await page.evaluate(() => { document.documentElement.style.fontSize = '24px'; });
  const image = await serveImages(page);
  let failed = true;
  await page.route('**/failed-slide', (route) => failed ? route.fulfill({ status: 503, body: '' })
    : route.fulfill({ contentType: 'image/png', body: image }));
  await page.evaluate(async () => {
    const { createViewerSource } = await import('/client/viewer-sequence.js');
    document.getElementById('unified-viewer-dialog').__creatorCrateUnifiedViewer.open(createViewerSource({
      key: 'failed-slides', mode: 'sequence', slideshow: true,
      items: [1, 2].map((assetId) => ({ projectId: 7, assetId, filename: 'failed.png', mediaUrl: '/failed-slide', detailsUrl: '/details' })),
    }), { autoplay: false });
  });
  const retry = page.locator('[data-unified-viewer-retry]');
  await expect(retry).toBeVisible();
  expectFooterHits(await footerHitGeometry(page));
  failed = false;
  await pointerCenter(page, retry);
  await expect(retry).toHaveCount(0);
  await expect(page.locator('[data-unified-viewer-position]')).toHaveText('1 of 2');
  expectFooterHits(await footerHitGeometry(page));
});
