import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createApp } from '../../src/app.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';

// B3: real image loading, Fit, button zoom, original-size inspection and
// pan in the unified viewer, opened through its controller from an isolated
// test opener on an opted-in page. Media is served by page.route from images
// generated here, so delays and failures are controlled by the test and no
// user data or production asset is involved.

const DIALOG = '#unified-viewer-dialog';
const MEDIA = `${DIALOG} [data-unified-viewer-media]`;
const SHOWN = `${MEDIA} img.unified-viewer-image:not([hidden])`;

async function startApp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-unified-viewer-media-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot);
  fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
  const { csrfPepper } = ensureAuthEnablement(appDataRoot);
  const app = createApp(
    { appName: 'CreatorCrate', db, projectsRoot },
    { appDataRoot, authState: { csrfPepper } },
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

async function makeImage(width, height, format, color = { r: 40, g: 120, b: 200 }) {
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
    + `<rect width="100%" height="100%" fill="rgb(${color.r},${color.g},${color.b})"/>`
    + `<rect x="0" y="0" width="${Math.ceil(width / 2)}" height="${Math.ceil(height / 2)}" fill="#fff"/></svg>`);
  return sharp(svg)[format]().toBuffer();
}

const IMAGES = {};
let fixture;
test.beforeAll(async () => {
  fixture = await startApp();
  IMAGES.landscape = { body: await makeImage(1600, 900, 'jpeg'), type: 'image/jpeg', width: 1600, height: 900 };
  IMAGES.portrait = { body: await makeImage(900, 1600, 'png'), type: 'image/png', width: 900, height: 1600 };
  IMAGES.small = { body: await makeImage(160, 120, 'webp'), type: 'image/webp', width: 160, height: 120 };
  IMAGES.large = { body: await makeImage(4000, 3000, 'webp'), type: 'image/webp', width: 4000, height: 3000 };
  IMAGES.original = { body: await makeImage(3200, 1800, 'png'), type: 'image/png', width: 3200, height: 1800 };
});
test.afterAll(async () => { await fixture?.close(); });

// Routes /test-media/<name>[?…]; a held name waits for release(name).
async function serveMedia(page) {
  const holds = new Map();
  const counts = new Map();
  const failures = new Map();
  await page.route('**/test-media/**', async (route) => {
    const url = new URL(route.request().url());
    const name = url.pathname.split('/').pop();
    counts.set(name, (counts.get(name) || 0) + 1);
    if (holds.has(name)) await holds.get(name).promise;
    const failure = failures.get(name);
    try {
      if (failure) {
        await route.fulfill(failure);
        return;
      }
      const image = IMAGES[name.replace(/-\d+$/, '')];
      if (!image) {
        await route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not found' });
        return;
      }
      await route.fulfill({ status: 200, contentType: image.type, body: image.body });
    } catch {
      // The page aborted the request.
    }
  });
  return {
    hold(name) {
      let release;
      const promise = new Promise((resolve) => { release = resolve; });
      holds.set(name, { promise, release });
    },
    release(name) {
      holds.get(name)?.release();
      holds.delete(name);
    },
    fail(name, response) { failures.set(name, response); },
    heal(name) { failures.delete(name); },
    count: (name) => counts.get(name) || 0,
  };
}

async function openLibrary(page) {
  await page.addInitScript(() => {
    const live = new Set();
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (object) => {
      const url = create(object);
      live.add(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      live.delete(url);
      revoke(url);
    };
    window.__liveObjectUrls = () => live.size;
  });
  await page.goto(`${fixture.baseURL}/assets`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(async () => {
    const viewer = await import('/client/unified-viewer.js');
    return Boolean(viewer.unifiedViewerFor(document));
  });
  await page.evaluate(() => {
    const host = document.createElement('div');
    host.id = 'test-viewer-host';
    host.innerHTML = '<button type="button" id="test-opener">Open viewer</button>';
    document.querySelector('main').prepend(host);
  });
}

// items: [{ id, media, original? }]
async function openViewer(page, items, { key = 'test', mode = 'sequence' } = {}) {
  await page.locator('#test-opener').focus();
  return page.evaluate(async ({ items, key, mode }) => {
    const { unifiedViewerFor } = await import('/client/unified-viewer.js');
    const { createViewerSource } = await import('/client/viewer-sequence.js');
    return unifiedViewerFor(document).open(createViewerSource({
      key,
      mode,
      items: items.map(({ id, media, original, unavailable }) => ({
        projectId: 7,
        assetId: id,
        title: `${media}-${id}.img`,
        mediaUrl: unavailable ? null : `/test-media/${media}`,
        originalUrl: original ? `/test-media/${original}` : undefined,
        detailsUrl: `/projects/7/assets/${id}`,
        revision: 'r1',
      })),
    }), { opener: document.getElementById('test-opener') });
  }, { items, key, mode });
}

const mediaState = (page) => page.evaluate(async () => {
  const { unifiedViewerFor } = await import('/client/unified-viewer.js');
  return unifiedViewerFor(document).media.getState();
});

const waitForStatus = (page, status) => expect.poll(async () => (await mediaState(page)).status).toBe(status);

// Rendered image and media boxes (viewport coordinates).
const boxes = (page) => page.evaluate(({ media, shown }) => {
  const surface = document.querySelector(media).getBoundingClientRect();
  const image = document.querySelector(shown);
  const rect = image?.getBoundingClientRect();
  return {
    surface: { x: surface.x, y: surface.y, width: surface.width, height: surface.height },
    image: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
    natural: image ? { width: image.naturalWidth, height: image.naturalHeight } : null,
    content: image?.getAttribute('data-viewer-content') || null,
  };
}, { media: MEDIA, shown: SHOWN });

function expectContained(geometry, natural) {
  const { surface, image } = geometry;
  expect(image.width).toBeLessThanOrEqual(surface.width + 0.5);
  expect(image.height).toBeLessThanOrEqual(surface.height + 0.5);
  expect(image.width / image.height).toBeCloseTo(natural.width / natural.height, 2);
  // Centred.
  expect(image.x + image.width / 2).toBeCloseTo(surface.x + surface.width / 2, 0);
  expect(image.y + image.height / 2).toBeCloseTo(surface.y + surface.height / 2, 0);
}

function expectCovering(geometry) {
  const { surface, image } = geometry;
  // A magnified image never leaves a gap on an axis it overflows.
  if (image.width >= surface.width) {
    expect(image.x).toBeLessThanOrEqual(surface.x + 0.5);
    expect(image.x + image.width).toBeGreaterThanOrEqual(surface.x + surface.width - 0.5);
  }
  if (image.height >= surface.height) {
    expect(image.y).toBeLessThanOrEqual(surface.y + 0.5);
    expect(image.y + image.height).toBeGreaterThanOrEqual(surface.y + surface.height - 0.5);
  }
}

test('loads JPEG, PNG and WebP images fitted, centred and in proportion', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await serveMedia(page);
  await openLibrary(page);
  await openViewer(page, [
    { id: 1, media: 'landscape' },
    { id: 2, media: 'portrait' },
    { id: 3, media: 'small' },
    { id: 4, media: 'large' },
  ]);
  const dialog = page.locator(DIALOG);

  for (const [name, index] of [['landscape', 0], ['portrait', 1], ['small', 2], ['large', 3]]) {
    if (index > 0) await dialog.getByRole('button', { name: 'Next' }).click();
    await waitForStatus(page, 'loaded');
    const geometry = await boxes(page);
    expect(geometry.natural).toEqual({ width: IMAGES[name].width, height: IMAGES[name].height });
    expectContained(geometry, IMAGES[name]);
    await expect(page.locator(SHOWN)).toHaveAttribute('alt', `${name}-${index + 1}.img`);
    if (name === 'small') {
      // Never upscaled.
      expect(geometry.image.width).toBeCloseTo(160, 0);
      expect(geometry.image.height).toBeCloseTo(120, 0);
    } else if (name === 'landscape' || name === 'large') {
      expect(Math.min(geometry.surface.width - geometry.image.width, geometry.surface.height - geometry.image.height))
        .toBeLessThan(1);
    }
  }
  await expect(dialog.locator('[data-unified-viewer-zoom-level]')).toHaveText('Fit');
});

test('zooms with keyboard-operable buttons and resets to Fit on navigation', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await serveMedia(page);
  await openLibrary(page);
  await openViewer(page, [{ id: 1, media: 'large' }, { id: 2, media: 'landscape' }]);
  await waitForStatus(page, 'loaded');
  const dialog = page.locator(DIALOG);
  const zoomIn = dialog.getByRole('button', { name: 'Zoom in' });
  const zoomOut = dialog.getByRole('button', { name: 'Zoom out' });
  const fit = dialog.getByRole('button', { name: 'Fit to viewer' });
  await expect(dialog.getByRole('group', { name: 'Image view' })).toBeVisible();
  await expect(zoomOut).toBeDisabled();
  await expect(fit).toBeDisabled();

  const before = await boxes(page);
  await zoomIn.focus();
  await page.keyboard.press('Enter');
  await expect(fit).toBeEnabled();
  await expect(zoomOut).toBeEnabled();
  const after = await boxes(page);
  expect(after.image.width / before.image.width).toBeCloseTo(1.5, 1);
  expect(await dialog.locator('[data-unified-viewer-zoom-level]').textContent()).toMatch(/^\d+%$/);
  expectCovering(after);

  for (let index = 0; index < 12; index += 1) {
    if (await zoomIn.isDisabled()) break;
    await zoomIn.click();
  }
  await expect(zoomIn).toBeDisabled();
  await expect(dialog.locator('[data-unified-viewer-zoom-level]')).toHaveText('800%');
  // Focus left the disabled control but stayed in the viewer.
  expect(await page.evaluate((selector) => document.querySelector(selector).contains(document.activeElement), DIALOG)).toBe(true);

  await fit.click();
  await expect(dialog.locator('[data-unified-viewer-zoom-level]')).toHaveText('Fit');
  expectContained(await boxes(page), IMAGES.large);

  await zoomIn.click();
  await dialog.getByRole('button', { name: 'Next' }).click();
  await waitForStatus(page, 'loaded');
  await expect(dialog.locator('[data-unified-viewer-zoom-level]')).toHaveText('Fit');
  expectContained(await boxes(page), IMAGES.landscape);
});

test('pans a magnified image within bounds without dismissing the viewer', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await serveMedia(page);
  await openLibrary(page);
  await openViewer(page, [{ id: 1, media: 'large' }], { mode: 'single' });
  await waitForStatus(page, 'loaded');
  const dialog = page.locator(DIALOG);
  // At Fit there is nothing to pan.
  const fitted = await boxes(page);
  await page.mouse.move(fitted.surface.x + 200, fitted.surface.y + 200);
  await page.mouse.down();
  await page.mouse.move(fitted.surface.x + 400, fitted.surface.y + 300);
  await page.mouse.up();
  expect((await boxes(page)).image).toEqual(fitted.image);

  await dialog.getByRole('button', { name: 'Zoom in' }).click();
  await dialog.getByRole('button', { name: 'Zoom in' }).click();
  const start = await boxes(page);
  const cx = start.surface.x + start.surface.width / 2;
  const cy = start.surface.y + start.surface.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await expect(page.locator(MEDIA)).toHaveAttribute('data-viewer-dragging', '');
  await page.mouse.move(cx + 100, cy + 60, { steps: 4 });
  const moved = await boxes(page);
  expect(moved.image.x - start.image.x).toBeCloseTo(100, 0);
  expect(moved.image.y - start.image.y).toBeCloseTo(60, 0);
  // Far past every edge, then release outside the dialog card.
  await page.mouse.move(5, 5, { steps: 6 });
  await page.mouse.move(1275, 795, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator(MEDIA)).not.toHaveAttribute('data-viewer-dragging', '');
  await expect(dialog).toBeVisible();
  expectCovering(await boxes(page));
  expect(await page.evaluate(() => getSelection().toString())).toBe('');

  // Shift+Arrow pans; plain arrows stay with sequence navigation.
  const keyStart = await boxes(page);
  await dialog.getByRole('button', { name: 'Zoom in' }).focus();
  // The drag left the image at its right/bottom bound: only leftward moves.
  await page.keyboard.press('Shift+ArrowLeft');
  expect((await boxes(page)).image.x).toBe(keyStart.image.x);
  await page.keyboard.press('Shift+ArrowRight');
  const keyed = await boxes(page);
  expect(keyed.image.x).toBeCloseTo(keyStart.image.x - 48, 0);
  await expect(dialog.locator('[data-unified-viewer-position]')).toHaveText('');

  // A cancelled pointer ends the drag.
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.locator(MEDIA).dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse' });
  await expect(page.locator(MEDIA)).not.toHaveAttribute('data-viewer-dragging', '');
  const cancelled = await boxes(page);
  await page.mouse.move(cx + 150, cy + 150, { steps: 3 });
  expect((await boxes(page)).image).toEqual(cancelled.image);
  await page.mouse.up();
});

test('inspects the original on demand, keeping the preview while it loads', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const media = await serveMedia(page);
  await openLibrary(page);
  await openViewer(page, [{ id: 1, media: 'landscape', original: 'original' }], { mode: 'single' });
  await waitForStatus(page, 'loaded');
  expect(media.count('original')).toBe(0);
  const dialog = page.locator(DIALOG);
  const original = dialog.getByRole('button', { name: 'Original size' });
  await expect(original).toBeVisible();

  media.hold('original');
  await original.click();
  await expect(dialog.locator('[data-unified-viewer-status]')).toHaveText('Loading original size…');
  await expect(original).toBeDisabled();
  expect((await boxes(page)).content).toBe('preview');
  await expect(page.locator(SHOWN)).toBeVisible();
  media.release('original');

  await expect.poll(async () => (await mediaState(page)).original.status).toBe('active');
  const geometry = await boxes(page);
  expect(geometry.content).toBe('original');
  expect(geometry.natural).toEqual({ width: 3200, height: 1800 });
  expect(geometry.image.width).toBeCloseTo(3200, 0);
  await expect(dialog.locator('[data-unified-viewer-zoom-level]')).toHaveText('100%');
  await expect(dialog.locator('[data-unified-viewer-status]')).toHaveText('Showing original size, 3200 × 1800 pixels.');
  expectCovering(geometry);

  await dialog.getByRole('button', { name: 'Fit to viewer' }).click();
  expectContained(await boxes(page), IMAGES.original);
  await original.click();
  expect((await boxes(page)).image.width).toBeCloseTo(3200, 0);
  expect(media.count('original')).toBe(1);
});

test('keeps the fitted preview when the original fails', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const media = await serveMedia(page);
  media.fail('original', { status: 415, contentType: 'text/plain', body: 'Unsupported media type' });
  await openLibrary(page);
  await openViewer(page, [{ id: 1, media: 'portrait', original: 'original' }], { mode: 'single' });
  await waitForStatus(page, 'loaded');
  const dialog = page.locator(DIALOG);
  await dialog.getByRole('button', { name: 'Original size' }).click();
  await expect(dialog.locator('[data-unified-viewer-status]'))
    .toHaveText('The original could not be loaded. Showing the fitted image.');
  const geometry = await boxes(page);
  expect(geometry.content).toBe('preview');
  expectContained(geometry, IMAGES.portrait);
  await expect(dialog).not.toContainText('Unsupported media type');
});

test('shows only the latest item after rapid navigation and survives close/reopen during loads', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const media = await serveMedia(page);
  await openLibrary(page);
  media.hold('landscape-1');
  media.hold('portrait-2');
  await openViewer(page, [
    { id: 1, media: 'landscape-1' },
    { id: 2, media: 'portrait-2' },
    { id: 3, media: 'small-3' },
  ]);
  const dialog = page.locator(DIALOG);
  await expect(page.locator(`${MEDIA} [data-unified-viewer-loading]`)).toBeVisible();
  // Loading never traps the user.
  await dialog.getByRole('button', { name: 'Next' }).click();
  await dialog.getByRole('button', { name: 'Next' }).click();
  await waitForStatus(page, 'loaded');
  media.release('landscape-1');
  media.release('portrait-2');
  await page.waitForTimeout(150);
  await expect(page.locator(SHOWN)).toHaveCount(1);
  expect((await boxes(page)).natural).toEqual({ width: 160, height: 120 });
  await expect(dialog.locator('[data-unified-viewer-position]')).toHaveText('3 of 3');

  // Close while loading, then reopen another source.
  media.hold('large-9');
  await page.keyboard.press('ArrowLeft');
  await openViewer(page, [{ id: 9, media: 'large-9' }], { key: 'other', mode: 'single' });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.locator('#test-opener')).toBeFocused();
  await openViewer(page, [{ id: 5, media: 'portrait-5' }], { key: 'third', mode: 'single' });
  await waitForStatus(page, 'loaded');
  media.release('large-9');
  await page.waitForTimeout(150);
  await expect(page.locator(SHOWN)).toHaveCount(1);
  expect((await boxes(page)).natural).toEqual({ width: 900, height: 1600 });

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__liveObjectUrls())).toBe(0);
});

test('fails safely on an HTML response and recovers with Retry', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const media = await serveMedia(page);
  media.fail('landscape', { status: 200, contentType: 'text/html', body: '<h1>Please sign in</h1>' });
  await openLibrary(page);
  await openViewer(page, [{ id: 1, media: 'landscape' }], { mode: 'single' });
  await waitForStatus(page, 'failed');
  const dialog = page.locator(DIALOG);
  await expect(dialog.locator('[data-unified-viewer-status]')).toHaveText('This image could not be loaded.');
  await expect(dialog).not.toContainText('Please sign in');
  await expect(page.locator(`${MEDIA} img`)).toHaveCount(0);
  await expect(dialog.getByRole('group', { name: 'Image view' })).toBeHidden();
  media.heal('landscape');
  await dialog.getByRole('button', { name: 'Retry' }).click();
  await waitForStatus(page, 'loaded');
  await expect(dialog.locator('[data-unified-viewer-status]')).toHaveText('');
  expectContained(await boxes(page), IMAGES.landscape);
});

test('re-fits and re-clamps on resize and stays usable at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await serveMedia(page);
  await openLibrary(page);
  await openViewer(page, [{ id: 1, media: 'large' }, { id: 2, media: 'small' }]);
  await waitForStatus(page, 'loaded');
  const dialog = page.locator(DIALOG);

  await page.setViewportSize({ width: 900, height: 700 });
  await expect.poll(async () => (await boxes(page)).surface.width).toBeLessThan(900);
  await expect.poll(async () => {
    const geometry = await boxes(page);
    return geometry.image.width <= geometry.surface.width + 0.5 && geometry.image.height <= geometry.surface.height + 0.5;
  }).toBe(true);
  expectContained(await boxes(page), IMAGES.large);

  await dialog.getByRole('button', { name: 'Zoom in' }).click();
  await dialog.getByRole('button', { name: 'Zoom in' }).click();
  await dialog.getByRole('button', { name: 'Zoom in' }).click();
  const start = await boxes(page);
  await page.mouse.move(start.surface.x + 50, start.surface.y + 50);
  await page.mouse.down();
  await page.mouse.move(start.surface.x + 2000, start.surface.y + 2000, { steps: 4 });
  await page.mouse.up();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(async () => (await boxes(page)).surface.width).toBeGreaterThan(900);
  expectCovering(await boxes(page));

  await page.setViewportSize({ width: 375, height: 700 });
  await dialog.getByRole('button', { name: 'Fit to viewer' }).click();
  await expect.poll(async () => {
    const geometry = await boxes(page);
    return geometry.image.width <= geometry.surface.width + 0.5;
  }).toBe(true);
  for (const name of ['Zoom out', 'Zoom in', 'Fit to viewer', 'Close Viewer', 'Next']) {
    const box = await dialog.getByRole('button', { name }).boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375);
  }
  const overflow = await page.evaluate((selector) => {
    const card = document.querySelector(selector);
    return card.scrollWidth - card.clientWidth;
  }, DIALOG);
  expect(overflow).toBeLessThanOrEqual(1);
});
