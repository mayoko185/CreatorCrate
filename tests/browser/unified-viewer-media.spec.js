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
  await expect(fit).toHaveAttribute('aria-pressed', 'true');
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
  await expect(fit).toHaveAttribute('aria-pressed', 'false');
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

// D1-A: real Chromium touch input (CDP Input.dispatchTouchEvent goes through
// the browser's touch-action and pointer-event pipeline). This is technical
// qualification only, not real-device acceptance. start()/move() list every
// contact down; lift() releases just the contacts it lists.
async function touchscreen(page) {
  const cdp = await page.context().newCDPSession(page);
  const points = (list) => list.map(([id, x, y]) => ({ id, x: Math.round(x), y: Math.round(y) }));
  const send = (type, list = []) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points(list) });
  return {
    start: (list) => send('touchStart', list),
    move: (list) => send('touchMove', list),
    lift: (list) => send('touchEnd', list),
    end: () => send('touchEnd'),
    cancel: () => send('touchCancel'),
    detach: () => cdp.detach(),
  };
}

test('touch pinch zooms about its midpoint and one finger pans only when enlarged', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await serveMedia(page);
  await openLibrary(page);
  await openViewer(page, [{ id: 1, media: 'large' }, { id: 2, media: 'landscape' }]);
  await waitForStatus(page, 'loaded');
  const dialog = page.locator(DIALOG);
  const zoomLevel = dialog.locator('[data-unified-viewer-zoom-level]');
  const position = await dialog.locator('[data-unified-viewer-position]').textContent();
  const view = async () => (await mediaState(page)).view;
  const touch = await touchscreen(page);

  // Only the viewer's media surface takes touch gestures from the browser.
  expect(await page.evaluate((selector) => [
    getComputedStyle(document.querySelector(selector)).touchAction,
    getComputedStyle(document.body).touchAction,
    getComputedStyle(document.documentElement).touchAction,
    getComputedStyle(document.querySelector('#unified-viewer-dialog')).touchAction,
  ], MEDIA)).toEqual(['none', 'auto', 'auto', 'auto']);

  const fitted = await boxes(page);
  const cx = fitted.surface.x + fitted.surface.width / 2;
  const cy = fitted.surface.y + fitted.surface.height / 2;
  // The content point (intrinsic px from its centre) under a client point.
  const contentPoint = (state, x, y) => ({ x: (x - cx - state.panX) / state.scale, y: (y - cy - state.panY) / state.scale });

  // At Fit one finger never pans. (D1-B: a horizontal stroke would now be a
  // swipe, so this drag is vertical; tests below cover swipe navigation.)
  await touch.start([[0, cx, cy - 150]]);
  await touch.move([[0, cx + 40, cy + 150]]);
  await touch.end();
  expect((await boxes(page)).image).toEqual(fitted.image);
  await expect(dialog.locator('[data-unified-viewer-position]')).toHaveText(position);
  await expect(dialog).toBeVisible();

  // A two-finger pinch about an off-centre midpoint.
  const mx = Math.round(cx + 150);
  const my = Math.round(cy - 60);
  const before = await view();
  const anchor = contentPoint(before, mx, my);
  await touch.start([[0, mx - 50, my]]);
  await touch.start([[0, mx - 50, my], [1, mx + 50, my]]);
  for (let step = 1; step <= 4; step += 1) {
    const half = 50 + 25 * step;
    await touch.move([[0, mx - half, my], [1, mx + half, my]]);
  }
  let state = await view();
  expect(state).toMatchObject({ touchGesture: 'pinch', touchContacts: 2, mode: 'zoom' });
  expect(state.scale / before.scale).toBeCloseTo(3, 6);
  let point = contentPoint(state, mx, my);
  expect(point.x).toBeCloseTo(anchor.x, 3);
  expect(point.y).toBeCloseTo(anchor.y, 3);
  // The rendered image agrees with the viewport state.
  let geometry = await boxes(page);
  expect(geometry.image.width).toBeCloseTo(IMAGES.large.width * state.scale, 0);
  expect(geometry.image.x + geometry.image.width / 2).toBeCloseTo(cx + state.panX, 0);
  expect(geometry.image.y + geometry.image.height / 2).toBeCloseTo(cy + state.panY, 0);

  // Moving the midpoint carries the anchored point with it.
  await touch.move([[0, mx - 110, my + 30], [1, mx + 190, my + 30]]);
  state = await view();
  point = contentPoint(state, mx + 40, my + 30);
  expect(point.x).toBeCloseTo(anchor.x, 3);
  expect(point.y).toBeCloseTo(anchor.y, 3);
  expect(state.scale / before.scale).toBeCloseTo(3, 6);

  // Lifting one finger keeps the zoom; the other pans from where it is.
  const pinched = state;
  await touch.lift([[0, mx - 110, my + 30]]);
  state = await view();
  expect(state).toMatchObject({ touchGesture: 'pan', touchContacts: 1, scale: pinched.scale, panX: pinched.panX, panY: pinched.panY });
  await expect(zoomLevel).not.toHaveText('Fit');
  await touch.move([[1, mx + 130, my + 5]]);
  state = await view();
  expect(state.panX - pinched.panX).toBeCloseTo(-60, 6);
  expect(state.panY - pinched.panY).toBeCloseTo(-25, 6);
  await expect(page.locator(MEDIA)).toHaveAttribute('data-viewer-dragging', '');
  // Dragged across the whole window: bounded, never leaving a gap.
  await touch.move([[1, 5, 5]]);
  state = await view();
  expect(Math.abs(state.panX)).toBeLessThanOrEqual(state.maxPanX);
  expect(Math.abs(state.panY)).toBeLessThanOrEqual(state.maxPanY);
  expectCovering(await boxes(page));
  await touch.end();
  await expect(page.locator(MEDIA)).not.toHaveAttribute('data-viewer-dragging', '');
  const surface = fitted.surface;
  for (const id of [3, 4]) {
    await touch.start([[id, surface.x + 10, surface.y + 10]]);
    await touch.move([[id, cx, cy]]);
    await touch.move([[id, 1275, 795]]);
    await touch.end();
  }
  state = await view();
  expect(state).toMatchObject({ touchGesture: 'none', touchContacts: 0, panX: state.maxPanX, panY: state.maxPanY });
  expectCovering(await boxes(page));
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-unified-viewer-position]')).toHaveText(position);

  // Pinching far in stops at Fit (the shared lower bound) and re-centres.
  await touch.start([[0, cx - 300, cy], [1, cx + 300, cy]]);
  await touch.move([[0, cx - 2, cy], [1, cx + 2, cy]]);
  await touch.end();
  await expect(zoomLevel).toHaveText('Fit');
  geometry = await boxes(page);
  expect(geometry.image.width).toBeCloseTo(fitted.image.width, 0);
  expect(geometry.image.x).toBeCloseTo(fitted.image.x, 0);
  expect(geometry.image.y).toBeCloseTo(fitted.image.y, 0);

  // Spreading far out stops at the maximum zoom.
  await touch.start([[0, cx - 5, cy], [1, cx + 5, cy]]);
  await touch.move([[0, cx - 600, cy], [1, cx + 600, cy]]);
  state = await view();
  expect(state.scale).toBe(state.maxScale);
  // A browser-cancelled touch abandons the gesture and keeps what it reached.
  await touch.cancel();
  await expect.poll(async () => (await view()).touchContacts).toBe(0);
  expect((await view()).scale).toBe(state.maxScale);
  await expect(page.locator(MEDIA)).not.toHaveAttribute('data-viewer-dragging', '');

  // The page itself was never pinch-zoomed or scrolled.
  expect(await page.evaluate(() => [window.visualViewport.scale, window.scrollX, window.scrollY])).toEqual([1, 0, 0]);
  await expect(dialog).toBeVisible();
  await touch.detach();
});

test('a touch gesture is dropped when navigation replaces the image mid-pinch', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await serveMedia(page);
  await openLibrary(page);
  await openViewer(page, [{ id: 1, media: 'large' }, { id: 2, media: 'landscape' }]);
  await waitForStatus(page, 'loaded');
  const dialog = page.locator(DIALOG);
  const touch = await touchscreen(page);
  const fitted = await boxes(page);
  const cx = fitted.surface.x + fitted.surface.width / 2;
  const cy = fitted.surface.y + fitted.surface.height / 2;
  await touch.start([[0, cx - 50, cy], [1, cx + 50, cy]]);
  await touch.move([[0, cx - 150, cy], [1, cx + 150, cy]]);
  expect((await mediaState(page)).view.touchGesture).toBe('pinch');
  // Keyboard navigation while the fingers are still down.
  await dialog.getByRole('button', { name: 'Next' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await mediaState(page)).key).toContain('a:2');
  await waitForStatus(page, 'loaded');
  const fresh = (await mediaState(page)).view;
  expect(fresh).toMatchObject({ mode: 'fit', panX: 0, panY: 0, touchContacts: 0, touchGesture: 'none' });
  const replaced = await boxes(page);
  await touch.move([[0, cx - 400, cy], [1, cx + 400, cy]]);
  await touch.end();
  expect((await boxes(page)).image).toEqual(replaced.image);
  expect((await mediaState(page)).view).toMatchObject({ mode: 'fit', touchContacts: 0 });
  await touch.detach();
});

// D1-B: Fit-state swipe and outer-edge tap navigation through Chromium's real
// touch pipeline (CDP touch events become pointer events, and a stationary
// touch becomes the browser's own synthesized click). Technical
// qualification only, not real-device acceptance.
const FOUR = [{ id: 1, media: 'landscape' }, { id: 2, media: 'portrait' }, { id: 3, media: 'landscape' }, { id: 4, media: 'portrait' }];

// Records the controller's navigations and every click that reaches the
// document's bubble phase (a swallowed click never does).
async function recordTouchEffects(page) {
  await page.evaluate(async () => {
    const { unifiedViewerFor } = await import('/client/unified-viewer.js');
    window.__d1b = { navigations: [], clicks: [] };
    unifiedViewerFor(document).observe((change) => {
      if (change.type === 'navigate') window.__d1b.navigations.push({ key: change.key, cause: change.cause });
    });
    document.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      window.__d1b.clicks.push({
        pointerType: event.pointerType,
        target: target?.matches('[data-unified-viewer-next]') || target?.closest('[data-unified-viewer-next]') ? 'next'
          : target?.closest('[data-unified-viewer-media]') ? 'media' : target?.tagName.toLowerCase() || null,
      });
    });
  });
}
const touchEffects = (page) => page.evaluate(() => ({ navigations: window.__d1b.navigations.slice(), clicks: window.__d1b.clicks.slice() }));
const settleInput = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 50))));

async function stageGeometry(page) {
  const { surface } = await boxes(page);
  return {
    surface,
    cx: surface.x + surface.width / 2,
    cy: surface.y + surface.height / 2,
    left: surface.x + 30,
    right: surface.x + surface.width - 30,
  };
}

async function tapAt(touch, page, x, y, id = 7) {
  await touch.start([[id, x, y]]);
  await touch.end();
  await settleInput(page);
}

async function swipeAcross(touch, page, fromX, toX, y, { toY = y, id = 8 } = {}) {
  await touch.start([[id, fromX, y]]);
  for (let step = 1; step <= 4; step += 1) {
    await touch.move([[id, fromX + ((toX - fromX) * step) / 4, y + ((toY - y) * step) / 4]]);
  }
  await touch.end();
  await settleInput(page);
}

test('D1-B: Fit-state touch swipes and edge taps step the sequence once each and swallow the follow-up click', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await serveMedia(page);
  await openLibrary(page);
  await openViewer(page, FOUR);
  await waitForStatus(page, 'loaded');
  await recordTouchEffects(page);
  const dialog = page.locator(DIALOG);
  const position = dialog.locator('[data-unified-viewer-position]');
  const touch = await touchscreen(page);
  const g = await stageGeometry(page);

  // Calibration: a centre tap is not navigation, and Chromium does synthesize
  // a click for it, with pointerType 'touch', which is left alone.
  await tapAt(touch, page, g.cx, g.cy);
  let effects = await touchEffects(page);
  expect(effects.navigations).toEqual([]);
  expect(effects.clicks).toEqual([{ pointerType: 'touch', target: 'media' }]);

  // An outer-edge tap navigates once; its synthesized click never arrives.
  await tapAt(touch, page, g.right, g.cy);
  await expect(position).toHaveText('2 of 4');
  effects = await touchEffects(page);
  expect(effects.navigations).toEqual([{ key: 'p:7|a:2', cause: 'user' }]);
  expect(effects.clicks).toHaveLength(1);

  // A deliberate leftward swipe reads on; a rightward one goes back.
  await swipeAcross(touch, page, g.cx + 150, g.cx - 150, g.cy);
  await expect(position).toHaveText('3 of 4');
  await swipeAcross(touch, page, g.cx - 150, g.cx + 150, g.cy, { toY: g.cy + 60 });
  await expect(position).toHaveText('2 of 4');
  await tapAt(touch, page, g.left, g.cy);
  await expect(position).toHaveText('1 of 4');
  // The start of a non-wrapping sequence: an edge tap there is only a tap.
  await tapAt(touch, page, g.left, g.cy);
  await expect(position).toHaveText('1 of 4');

  // Short, vertical and too-diagonal strokes do nothing.
  await swipeAcross(touch, page, g.cx, g.cx - 40, g.cy);
  await swipeAcross(touch, page, g.cx, g.cx - 30, g.cy - 200, { toY: g.cy + 200 });
  await swipeAcross(touch, page, g.cx + 100, g.cx - 100, g.cy, { toY: g.cy + 200 });
  effects = await touchEffects(page);
  expect(effects.navigations.map((entry) => entry.key)).toEqual(['p:7|a:2', 'p:7|a:3', 'p:7|a:2', 'p:7|a:1']);
  await expect(position).toHaveText('1 of 4');

  // A touch on Next is the button's own: exactly one step, its click arrives.
  const next = await dialog.getByRole('button', { name: 'Next' }).boundingBox();
  // D1-C: no workaround tap. The quick strokes above end on a surface that
  // consumes its touchmove, so Chromium has no hidden fling to cancel and
  // this immediate tap on Next keeps its click.
  const clicksBefore = (await touchEffects(page)).clicks.length;
  await tapAt(touch, page, next.x + next.width / 2, next.y + next.height / 2);
  await expect(position).toHaveText('2 of 4');
  effects = await touchEffects(page);
  expect(effects.navigations).toHaveLength(5);
  expect(effects.clicks.slice(clicksBefore)).toEqual([{ pointerType: 'touch', target: 'next' }]);
  // A touch that begins on Previous and drags over the stage is never stage navigation.
  const previous = await dialog.getByRole('button', { name: 'Previous' }).boundingBox();
  await swipeAcross(touch, page, previous.x + previous.width / 2, previous.x - 250, previous.y + previous.height / 2,
    { toY: g.cy });
  await expect(position).toHaveText('2 of 4');

  // A mouse drag across the fitted image never navigates.
  await page.mouse.move(g.cx + 200, g.cy);
  await page.mouse.down();
  await page.mouse.move(g.cx - 200, g.cy, { steps: 5 });
  await page.mouse.up();
  await page.mouse.click(g.right, g.cy);
  expect((await touchEffects(page)).navigations).toHaveLength(5);
  await expect(position).toHaveText('2 of 4');
  await waitForStatus(page, 'loaded');

  // A pinch, released one finger at a time with the last one swiping off at an edge.
  await touch.start([[0, g.cx - 60, g.cy], [1, g.cx + 60, g.cy]]);
  await touch.move([[0, g.cx - 100, g.cy], [1, g.cx + 100, g.cy]]);
  await touch.move([[0, g.cx - 60, g.cy], [1, g.cx + 60, g.cy]]);
  await touch.lift([[1, g.cx + 60, g.cy]]);
  await touch.move([[0, g.cx - 300, g.cy]]);
  await touch.move([[0, g.left, g.cy]]);
  await touch.end();
  await settleInput(page);
  await expect(position).toHaveText('2 of 4');

  // Enlarged: one finger pans, an edge tap is no navigation.
  await dialog.getByRole('button', { name: 'Zoom in' }).click();
  const zoomed = (await mediaState(page)).view;
  expect(zoomed.mode).toBe('zoom');
  // (A portrait item: after one step it overflows vertically, so the stroke pans both ways.)
  await swipeAcross(touch, page, g.cx + 100, g.cx - 100, g.cy + 100, { toY: g.cy - 100 });
  const panned = (await mediaState(page)).view;
  expect([panned.panX, panned.panY]).not.toEqual([zoomed.panX, zoomed.panY]);
  await tapAt(touch, page, g.right, g.cy);
  await tapAt(touch, page, g.left, g.cy);
  await expect(position).toHaveText('2 of 4');
  expect((await touchEffects(page)).navigations).toHaveLength(5);
  expect(await page.evaluate(() => [window.visualViewport.scale, window.scrollX, window.scrollY])).toEqual([1, 0, 0]);
  await expect(dialog).toBeVisible();
  await touch.detach();
});

test('D1-B: a touch held across keyboard navigation, close or reopen never acts', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await serveMedia(page);
  await openLibrary(page);
  await openViewer(page, FOUR);
  await waitForStatus(page, 'loaded');
  await recordTouchEffects(page);
  const dialog = page.locator(DIALOG);
  const position = dialog.locator('[data-unified-viewer-position]');
  const touch = await touchscreen(page);
  const g = await stageGeometry(page);

  // Keyboard navigation while a finger rests on the right edge.
  await touch.start([[3, g.right, g.cy]]);
  await dialog.getByRole('button', { name: 'Next' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(position).toHaveText('2 of 4');
  await touch.end();
  await settleInput(page);
  await expect(position).toHaveText('2 of 4');
  let effects = await touchEffects(page);
  expect(effects.navigations).toEqual([{ key: 'p:7|a:2', cause: 'user' }]);
  expect(effects.clicks.filter((click) => click.pointerType === 'touch')).toEqual([]);

  // A swipe held across a close lands on the page below without acting.
  await touch.start([[4, g.cx + 150, g.cy]]);
  await touch.move([[4, g.cx, g.cy]]);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await touch.move([[4, g.cx - 150, g.cy]]);
  await touch.end();
  // An edge tap held across a close: its click is swallowed too.
  await openViewer(page, FOUR);
  await waitForStatus(page, 'loaded');
  await touch.start([[5, g.right, g.cy]]);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await touch.end();
  await settleInput(page);
  effects = await touchEffects(page);
  expect(effects.navigations).toHaveLength(1);
  expect(effects.clicks.filter((click) => click.pointerType === 'touch')).toEqual([]);

  // Reopened, a fresh edge tap works at once.
  await openViewer(page, FOUR);
  await tapAt(touch, page, g.right, g.cy);
  await expect(position).toHaveText('2 of 4');
  expect((await touchEffects(page)).navigations).toHaveLength(2);
  await touch.detach();
});

// D1-F1: while an item's image is still loading (its response held by the
// test) the media surface — the stage's one touch classifier — keeps
// covering the whole stage, so the first touch after opening or reopening is
// never lost on a bare stage. The same item's first decode does not end a
// touch already down; a real replacement, close or reopen still does.
const viewerRoot = (page) => page.locator(`${DIALOG} [data-unified-viewer]`);
const hitsMedia = (page, x, y) => page.evaluate(({ media, x, y }) => {
  const hit = document.elementFromPoint(x, y);
  return hit ? document.querySelector(media).contains(hit) : false;
}, { media: MEDIA, x, y });
const HELD = [{ id: 1, media: 'landscape-1' }, { id: 2, media: 'portrait-2' }, { id: 3, media: 'landscape-3' }, { id: 4, media: 'portrait-4' }];

test('D1-F1: while the first image is loading the whole stage takes the first edge tap or swipe, once', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const media = await serveMedia(page);
  await openLibrary(page);
  await openViewer(page, HELD);
  await waitForStatus(page, 'loaded');
  await recordTouchEffects(page);
  const dialog = page.locator(DIALOG);
  const position = dialog.locator('[data-unified-viewer-position]');
  const touch = await touchscreen(page);
  const g = await stageGeometry(page);
  const probes = [[g.left, g.cy], [g.right, g.cy], [g.cx, g.cy],
    [g.left, g.surface.y + 12], [g.right, g.surface.y + 12], [g.left, g.surface.y + g.surface.height * 0.7]];
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // Reopened with its first image held: loading, and the surface still spans
  // the stage. (Item 3 stays held for the end of the test.)
  media.hold('landscape-1');
  media.hold('landscape-3');
  await openViewer(page, HELD);
  await expect(viewerRoot(page)).toHaveAttribute('data-viewer-media-state', 'loading');
  let loading = await boxes(page);
  expect(loading.image).toBeNull();
  expect(loading.surface).toEqual(g.surface);
  for (const [x, y] of probes) expect(await hitsMedia(page, x, y), `${x},${y}`).toBe(true);
  // The loading message keeps its centred place.
  const panel = await page.locator(`${MEDIA} [data-unified-viewer-loading]`).boundingBox();
  expect(panel.x + panel.width / 2).toBeCloseTo(g.cx, 0);
  expect(panel.y + panel.height / 2).toBeCloseTo(g.cy, 0);
  // The first touch, an outer-edge tap, navigates at once and only once.
  await tapAt(touch, page, g.right, g.cy);
  await expect(position).toHaveText('2 of 4');
  let effects = await touchEffects(page);
  expect(effects.navigations).toEqual([{ key: 'p:7|a:2', cause: 'user' }]);
  expect(effects.clicks.filter((click) => click.pointerType === 'touch')).toEqual([]);
  expect((await mediaState(page)).status).toBe('loaded');

  // A left-edge tap returns to the held item; there a swipe works at once too.
  await tapAt(touch, page, g.left, g.cy);
  await expect(position).toHaveText('1 of 4');
  await expect(viewerRoot(page)).toHaveAttribute('data-viewer-media-state', 'loading');
  loading = await boxes(page);
  expect(loading.surface).toEqual(g.surface);
  await swipeAcross(touch, page, g.cx + 150, g.cx - 150, g.cy);
  await expect(position).toHaveText('2 of 4');

  // Reopened again while held: the first gesture is a swipe.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await openViewer(page, HELD);
  await expect(viewerRoot(page)).toHaveAttribute('data-viewer-media-state', 'loading');
  await swipeAcross(touch, page, g.cx + 150, g.cx - 150, g.cy);
  await expect(position).toHaveText('2 of 4');
  // A centre tap while loading is no navigation.
  await dialog.getByRole('button', { name: 'Next', exact: true }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(viewerRoot(page)).toHaveAttribute('data-viewer-media-state', 'loading');
  await tapAt(touch, page, g.cx, g.cy);
  await expect(position).toHaveText('1 of 4');
  effects = await touchEffects(page);
  expect(effects.navigations.map((entry) => entry.key)).toEqual(['p:7|a:2', 'p:7|a:1', 'p:7|a:2', 'p:7|a:2', 'p:7|a:1']);
  expect(effects.clicks.filter((click) => click.pointerType === 'touch' && click.target !== 'media')).toEqual([]);

  // Once decoded, the surface and the ordinary fitted layout are unchanged.
  media.release('landscape-1');
  await waitForStatus(page, 'loaded');
  const loaded = await boxes(page);
  expect(loaded.surface).toEqual(g.surface);
  expectContained(loaded, IMAGES.landscape);
  for (const [x, y] of probes) expect(await hitsMedia(page, x, y), `${x},${y}`).toBe(true);
  await tapAt(touch, page, g.right, g.cy);
  await expect(position).toHaveText('2 of 4');
  expectContained(await boxes(page), IMAGES.portrait);

  // While item 3 loads, Previous and Next tapped by touch stay the
  // controls' own: one step each, no stage navigation on top.
  await waitForStatus(page, 'loaded');
  await tapButton(touch, page, 'Next');
  await expect(position).toHaveText('3 of 4');
  await expect(viewerRoot(page)).toHaveAttribute('data-viewer-media-state', 'loading');
  await tapButton(touch, page, 'Previous', 32);
  await expect(position).toHaveText('2 of 4');
  await waitForStatus(page, 'loaded');
  await tapButton(touch, page, 'Next', 33);
  await expect(position).toHaveText('3 of 4');
  effects = await touchEffects(page);
  expect(effects.navigations.map((entry) => entry.key).slice(5)).toEqual(['p:7|a:2', 'p:7|a:3', 'p:7|a:2', 'p:7|a:3']);

  // Fullscreen while item 3 loads: a centre tap keeps its chrome behavior,
  // edge taps navigate without touching the chrome.
  await enterFullscreen(page);
  await expect(viewerRoot(page)).toHaveAttribute('data-viewer-media-state', 'loading');
  const card = dialog.locator('[data-unified-viewer-card]');
  // Read at once, not polled: the idle timer may hide the chrome later.
  const chromeHidden = () => card.evaluate((element) => element.hasAttribute('data-viewer-chrome-hidden'));
  const f = await stageGeometry(page);
  expect(f.surface.width).toBeGreaterThan(g.surface.width);
  expect(await hitsMedia(page, f.right, f.cy)).toBe(true);
  await tapAt(touch, page, f.cx, f.cy);
  expect(await chromeHidden()).toBe(true);
  expect(await position.textContent()).toBe('3 of 4');
  await tapAt(touch, page, f.left, f.cy);
  expect(await position.textContent()).toBe('2 of 4');
  expect(await chromeHidden()).toBe(true);
  await tapAt(touch, page, f.right, f.cy);
  expect(await position.textContent()).toBe('3 of 4');
  expect(await chromeHidden()).toBe(true);
  await expect(viewerRoot(page)).toHaveAttribute('data-viewer-media-state', 'loading');
  // D1-C: a centre tap on hidden chrome reveals it, and navigates nowhere.
  await tapAt(touch, page, f.cx, f.cy);
  expect(await chromeHidden()).toBe(false);
  expect(await position.textContent()).toBe('3 of 4');
  effects = await touchEffects(page);
  expect(effects.navigations.map((entry) => entry.key).slice(9)).toEqual(['p:7|a:2', 'p:7|a:3']);
  // Only the two deliberate Next taps clicked Next; the revealing tap did not.
  expect(effects.clicks.filter((click) => click.pointerType === 'touch' && click.target === 'next')).toHaveLength(2);
  media.release('landscape-3');
  await waitForStatus(page, 'loaded');
  expect(await page.evaluate(() => [window.visualViewport.scale, window.scrollX, window.scrollY])).toEqual([1, 0, 0]);
  await touch.detach();
});

test('D1-F1: a touch down across the same item\'s first decode still navigates; replacement, close or reopen cancels it', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const media = await serveMedia(page);
  await openLibrary(page);
  await openViewer(page, HELD);
  await waitForStatus(page, 'loaded');
  await recordTouchEffects(page);
  const dialog = page.locator(DIALOG);
  const position = dialog.locator('[data-unified-viewer-position]');
  const touch = await touchscreen(page);
  const g = await stageGeometry(page);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // A swipe begun while the reopened item loads and finished after that
  // same item decoded navigates once. (Items 3 and 4 are held from the
  // start, so neither can arrive early as a preloaded neighbour.)
  media.hold('landscape-1');
  media.hold('landscape-3');
  media.hold('portrait-4');
  await openViewer(page, HELD);
  await expect(viewerRoot(page)).toHaveAttribute('data-viewer-media-state', 'loading');
  await touch.start([[1, g.cx + 150, g.cy]]);
  await touch.move([[1, g.cx + 75, g.cy]]);
  media.release('landscape-1');
  await waitForStatus(page, 'loaded');
  expect((await boxes(page)).surface).toEqual(g.surface);
  await touch.move([[1, g.cx - 75, g.cy]]);
  await touch.move([[1, g.cx - 150, g.cy]]);
  await touch.end();
  await settleInput(page);
  await expect(position).toHaveText('2 of 4');
  let effects = await touchEffects(page);
  expect(effects.navigations).toEqual([{ key: 'p:7|a:2', cause: 'user' }]);

  // A swipe begun while item 3 loads, held across keyboard navigation to
  // item 4 (also loading) and finished after both decoded, never acts.
  await waitForStatus(page, 'loaded');
  await dialog.getByRole('button', { name: 'Next', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(position).toHaveText('3 of 4');
  await expect(viewerRoot(page)).toHaveAttribute('data-viewer-media-state', 'loading');
  await touch.start([[2, g.cx + 150, g.cy]]);
  await touch.move([[2, g.cx + 75, g.cy]]);
  await page.keyboard.press('ArrowRight');
  await expect(position).toHaveText('4 of 4');
  media.release('landscape-3');
  media.release('portrait-4');
  await waitForStatus(page, 'loaded');
  await touch.move([[2, g.cx - 75, g.cy]]);
  await touch.move([[2, g.cx - 150, g.cy]]);
  await touch.end();
  await settleInput(page);
  await expect(position).toHaveText('4 of 4');
  effects = await touchEffects(page);
  expect(effects.navigations.map((entry) => entry.key)).toEqual(['p:7|a:2', 'p:7|a:3', 'p:7|a:4']);

  // A swipe begun while loading, held across close and a reopen whose item
  // then decodes, never acts in the new session.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  media.hold('landscape-1');
  await openViewer(page, HELD);
  await expect(viewerRoot(page)).toHaveAttribute('data-viewer-media-state', 'loading');
  await touch.start([[3, g.cx + 150, g.cy]]);
  await touch.move([[3, g.cx + 75, g.cy]]);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await openViewer(page, HELD);
  await expect(viewerRoot(page)).toHaveAttribute('data-viewer-media-state', 'loading');
  media.release('landscape-1');
  await waitForStatus(page, 'loaded');
  await touch.move([[3, g.cx - 75, g.cy]]);
  await touch.move([[3, g.cx - 150, g.cy]]);
  await touch.end();
  await settleInput(page);
  await expect(position).toHaveText('1 of 4');
  effects = await touchEffects(page);
  expect(effects.navigations.map((entry) => entry.key)).toEqual(['p:7|a:2', 'p:7|a:3', 'p:7|a:4']);
  expect(effects.clicks.filter((click) => click.pointerType === 'touch')).toEqual([]);

  // A fresh edge tap in that session works at once.
  await tapAt(touch, page, g.right, g.cy);
  await expect(position).toHaveText('2 of 4');
  expect((await touchEffects(page)).navigations).toHaveLength(4);

  // A retry note while loading sits just above the centred loading message
  // and lets touches through to the surface.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  media.fail('landscape-9', { status: 500, contentType: 'text/plain', body: 'Unavailable' });
  await openViewer(page, [{ id: 9, media: 'landscape-9' }, { id: 10, media: 'portrait-10' }]);
  await waitForStatus(page, 'failed');
  media.heal('landscape-9');
  media.hold('landscape-9');
  await dialog.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(viewerRoot(page)).toHaveAttribute('data-viewer-media-state', 'loading');
  const status = dialog.locator('[data-unified-viewer-status]');
  await expect(status).not.toHaveText('');
  expect((await boxes(page)).surface).toEqual(g.surface);
  const note = await status.boundingBox();
  const panel = await page.locator(`${MEDIA} [data-unified-viewer-loading]`).boundingBox();
  expect(panel.y + panel.height / 2).toBeCloseTo(g.cy, 0);
  expect(note.y + note.height).toBeLessThanOrEqual(panel.y + 0.5);
  expect(note.x + note.width / 2).toBeCloseTo(g.cx, 0);
  expect(await hitsMedia(page, note.x + 40, note.y + note.height / 2)).toBe(true);
  await tapAt(touch, page, g.right, note.y + note.height / 2);
  await expect(position).toHaveText('2 of 2');
  media.release('landscape-9');
  await touch.detach();
});

test('D1-B: in fullscreen a centre tap keeps its chrome behavior; navigation, pan and pinch never toggle it', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await serveMedia(page);
  await openLibrary(page);
  await openViewer(page, FOUR);
  await waitForStatus(page, 'loaded');
  await recordTouchEffects(page);
  const dialog = page.locator(DIALOG);
  const card = dialog.locator('[data-unified-viewer-card]');
  const position = dialog.locator('[data-unified-viewer-position]');
  await dialog.getByRole('button', { name: 'Enter fullscreen' }).click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement?.matches('[data-unified-viewer-card]')))).toBe(true);
  await waitForStatus(page, 'loaded');
  const touch = await touchscreen(page);
  const g = await stageGeometry(page);

  // Shown chrome: an edge tap and a swipe navigate and leave it shown.
  await tapAt(touch, page, g.right, g.cy);
  await expect(position).toHaveText('2 of 4');
  await expect(card).not.toHaveAttribute('data-viewer-chrome-hidden', '');
  await swipeAcross(touch, page, g.cx + 150, g.cx - 150, g.cy);
  await expect(position).toHaveText('3 of 4');
  await expect(card).not.toHaveAttribute('data-viewer-chrome-hidden', '');
  // The accepted centre tap hides it. D1-C (user direction): a touch tap on
  // hidden chrome reveals it, and the next centre tap hides it again.
  await tapAt(touch, page, g.cx, g.cy);
  await expect(card).toHaveAttribute('data-viewer-chrome-hidden', '');
  await tapAt(touch, page, g.cx, g.cy);
  await expect(card).not.toHaveAttribute('data-viewer-chrome-hidden', '');
  await tapAt(touch, page, g.cx, g.cy);
  await expect(card).toHaveAttribute('data-viewer-chrome-hidden', '');
  await expect(position).toHaveText('3 of 4');
  // Hidden chrome: navigation by touch keeps it hidden.
  await tapAt(touch, page, g.left, g.cy);
  await expect(position).toHaveText('2 of 4');
  await swipeAcross(touch, page, g.cx - 150, g.cx + 150, g.cy);
  await expect(position).toHaveText('1 of 4');
  await expect(card).toHaveAttribute('data-viewer-chrome-hidden', '');
  // A pinch neither navigates nor reveals; a pan neither.
  await waitForStatus(page, 'loaded');
  await touch.start([[0, g.cx - 60, g.cy], [1, g.cx + 60, g.cy]]);
  await touch.move([[0, g.cx - 160, g.cy], [1, g.cx + 160, g.cy]]);
  await touch.end();
  await settleInput(page);
  expect((await mediaState(page)).view.mode).toBe('zoom');
  await swipeAcross(touch, page, g.cx + 100, g.cx - 100, g.cy);
  await expect(card).toHaveAttribute('data-viewer-chrome-hidden', '');
  await expect(position).toHaveText('1 of 4');
  // Keyboard activity reveals; the fullscreen-first Escape still exits fullscreen only.
  await page.keyboard.press('Shift');
  await expect(card).not.toHaveAttribute('data-viewer-chrome-hidden', '');
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBe(null);
  await expect(dialog).toBeVisible();
  expect((await touchEffects(page)).navigations.map((entry) => entry.key)).toEqual(['p:7|a:2', 'p:7|a:3', 'p:7|a:2', 'p:7|a:1']);
  await touch.detach();
});

test('Actual Size uses the displayed rendition without fetching a legacy original', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const media = await serveMedia(page);
  await openLibrary(page);
  await openViewer(page, [{ id: 1, media: 'landscape', original: 'original' }], { mode: 'single' });
  await waitForStatus(page, 'loaded');
  const dialog = page.locator(DIALOG);
  await dialog.getByRole('button', { name: 'Actual size (100%)', exact: true }).click();
  expect((await mediaState(page)).view.scale).toBe(1);
  expect((await boxes(page)).natural).toEqual({ width: IMAGES.landscape.width, height: IMAGES.landscape.height });
  expect(media.count('original')).toBe(0);
  await expect(dialog.getByRole('button', { name: 'Original source', exact: true })).toBeHidden();
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

  await dialog.getByRole('button', { name: 'More viewer tools' }).click();
  await dialog.getByRole('button', { name: 'Zoom in' }).click();
  await dialog.getByRole('button', { name: 'Zoom in' }).click();
  await dialog.getByRole('button', { name: 'Zoom in' }).click();
  await page.keyboard.press('Escape');
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
  for (const name of ['Fit to viewer', 'Close Image Preview', 'Next']) {
    const box = await dialog.getByRole('button', { name }).boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375);
  }
  await dialog.getByRole('button', { name: 'More viewer tools' }).click();
  await expect(dialog.getByRole('button', { name: 'Zoom in' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Zoom out' })).toBeVisible();
  await page.keyboard.press('Escape');
  const overflow = await page.evaluate((selector) => {
    const card = document.querySelector(selector);
    return card.scrollWidth - card.clientWidth;
  }, DIALOG);
  expect(overflow).toBeLessThanOrEqual(1);
});

// ─── D1-C: responsive, fullscreen and accessibility qualification ──────────
// Chromium touch (CDP) and emulated safe areas: technical qualification
// only, not real-device acceptance.

// Every named control is shown, inside `bounds`, at least 24 px square
// (WCAG 2.5.8) and is what a press at its centre actually hits.
async function expectReachable(page, names, bounds) {
  for (const name of names) {
    const control = page.locator(DIALOG).getByRole('button', { name, exact: true });
    await expect(control, name).toBeVisible();
    const hit = await control.evaluate((element) => {
      const r = element.getBoundingClientRect();
      const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height,
        hits: Boolean(at && (at === element || element.contains(at))) };
    });
    expect(hit.hits, `${name} is hit at its centre`).toBe(true);
    expect(hit.width, name).toBeGreaterThanOrEqual(24);
    expect(hit.height, name).toBeGreaterThanOrEqual(24);
    expect(hit.x, name).toBeGreaterThanOrEqual(bounds.left - 0.5);
    expect(hit.y, name).toBeGreaterThanOrEqual(bounds.top - 0.5);
    expect(hit.right, name).toBeLessThanOrEqual(bounds.right + 0.5);
    expect(hit.bottom, name).toBeLessThanOrEqual(bounds.bottom + 0.5);
  }
}

// The viewer's own horizontal overflow (the Assets page under it can overflow
// at 320 px by itself, viewer closed or open) and its box in the window.
const pageOverflow = (page) => page.evaluate(() => {
  const dialog = document.querySelector('#unified-viewer-dialog');
  const r = dialog.getBoundingClientRect();
  const excess = (element) => element.scrollWidth - element.clientWidth;
  return {
    x: Math.max(excess(dialog), ...[...dialog.querySelectorAll('[data-unified-viewer-card], .unified-viewer, .unified-viewer-context')].map(excess)),
    scrolled: window.scrollX,
    dialog: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, vw: innerWidth, vh: innerHeight },
  };
});

const isFullscreen = (page) => page.evaluate(() => Boolean(document.fullscreenElement?.matches('[data-unified-viewer-card]')));

async function expectFiniteGeometry(page) {
  const view = (await mediaState(page)).view;
  for (const key of ['scale', 'panX', 'panY', 'maxPanX', 'maxPanY']) expect(Number.isFinite(view[key]), key).toBe(true);
  expect(Math.abs(view.panX)).toBeLessThanOrEqual(view.maxPanX + 0.5);
  expect(Math.abs(view.panY)).toBeLessThanOrEqual(view.maxPanY + 0.5);
  return view;
}

// A quick stroke: CDP sends the moves back to back, far faster than the
// roughly 3,500 px/s at which Chromium starts a (hidden) fling.
async function quickStroke(touch, page, fromX, fromY, toX, toY, id = 21) {
  await touch.start([[id, fromX, fromY]]);
  for (let step = 1; step <= 4; step += 1) {
    await touch.move([[id, fromX + ((toX - fromX) * step) / 4, fromY + ((toY - fromY) * step) / 4]]);
  }
  await touch.end();
  await settleInput(page);
}

async function tapButton(touch, page, name, id = 31) {
  const box = await page.locator(DIALOG).getByRole('button', { name, exact: true }).boundingBox();
  await tapAt(touch, page, box.x + box.width / 2, box.y + box.height / 2, id);
}

const EIGHT = [...FOUR, { id: 5, media: 'landscape' }, { id: 6, media: 'portrait' },
  { id: 7, media: 'landscape' }, { id: 8, media: 'portrait' }];

test('D1-C: a control tapped immediately after a quick swipe, pan, pinch or edge tap keeps its click', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await serveMedia(page);
  await openLibrary(page);
  await openViewer(page, EIGHT);
  await waitForStatus(page, 'loaded');
  await recordTouchEffects(page);
  const dialog = page.locator(DIALOG);
  const position = dialog.locator('[data-unified-viewer-position]');
  const touch = await touchscreen(page);
  const g = await stageGeometry(page);
  const nextClicks = async () => (await touchEffects(page)).clicks.filter((click) => click.target === 'next').length;

  // A deliberate long, quick swipe navigates; Next tapped at once still works.
  await quickStroke(touch, page, g.surface.x + g.surface.width - 20, g.cy, g.surface.x + 20, g.cy);
  await expect(position).toHaveText('2 of 8');
  await tapButton(touch, page, 'Next', 32);
  await expect(position).toHaveText('3 of 8');
  expect(await nextClicks()).toBe(1);
  // A quick vertical stroke that does nothing, then Next.
  await quickStroke(touch, page, g.cx, g.cy - 200, g.cx, g.cy + 200, 22);
  await expect(position).toHaveText('3 of 8');
  await tapButton(touch, page, 'Next', 33);
  await expect(position).toHaveText('4 of 8');
  // A short, quick stroke below the swipe distance, then Next.
  await quickStroke(touch, page, g.cx, g.cy, g.cx - 24, g.cy, 23);
  await tapButton(touch, page, 'Next', 34);
  await expect(position).toHaveText('5 of 8');
  // An outer-edge tap, then Next.
  await tapAt(touch, page, g.right, g.cy, 35);
  await expect(position).toHaveText('6 of 8');
  await tapButton(touch, page, 'Next', 36);
  await expect(position).toHaveText('7 of 8');
  // A pinch, then Previous (which also returns to Fit on the item it shows).
  await waitForStatus(page, 'loaded');
  await touch.start([[0, g.cx - 40, g.cy], [1, g.cx + 40, g.cy]]);
  await touch.move([[0, g.cx - 150, g.cy], [1, g.cx + 150, g.cy]]);
  await touch.end();
  await settleInput(page);
  expect((await mediaState(page)).view.mode).toBe('zoom');
  await tapButton(touch, page, 'Previous', 37);
  await expect(position).toHaveText('6 of 8');
  // Enlarged: a quick pan, then the overflow trigger and Fit by touch.
  await waitForStatus(page, 'loaded');
  await touch.start([[0, g.cx - 40, g.cy], [1, g.cx + 40, g.cy]]);
  await touch.move([[0, g.cx - 150, g.cy], [1, g.cx + 150, g.cy]]);
  await touch.end();
  await settleInput(page);
  const zoomed = (await mediaState(page)).view;
  await quickStroke(touch, page, g.cx + 100, g.cy + 150, g.cx - 100, g.cy - 150, 24);
  const panned = await expectFiniteGeometry(page);
  expect([panned.panX, panned.panY]).not.toEqual([zoomed.panX, zoomed.panY]);
  await expect(position).toHaveText('6 of 8');
  await tapButton(touch, page, 'More viewer tools', 38);
  await expect(dialog.locator('[data-unified-viewer-overflow]')).toHaveAttribute('open', '');
  await tapButton(touch, page, 'Fit to viewer', 39);
  expect((await mediaState(page)).view.mode).toBe('fit');
  // Fit disables itself: the menu closes and focus moves to its trigger,
  // never to <body> or a disabled control (as for mouse and keyboard).
  await expect(dialog.locator('[data-unified-viewer-overflow]')).not.toHaveAttribute('open', '');
  await expect(dialog.getByRole('button', { name: 'More viewer tools' })).toBeFocused();
  await expect(dialog).toBeVisible();
  // A real mouse click straight after a quick swipe.
  await quickStroke(touch, page, g.surface.x + g.surface.width - 20, g.cy, g.surface.x + 20, g.cy, 25);
  await expect(position).toHaveText('7 of 8');
  await dialog.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(position).toHaveText('8 of 8');
  // One physical gesture, one action: every navigation above is accounted for.
  expect((await touchEffects(page)).navigations.map((entry) => entry.key)).toEqual(
    [2, 3, 4, 5, 6, 7, 6, 7, 8].map((id) => `p:7|a:${id}`));
  expect(await page.evaluate(() => [window.visualViewport.scale, window.scrollX, window.scrollY])).toEqual([1, 0, 0]);
  await touch.detach();
});

// Portrait, landscape and short windows, browser zoom (a CSS-px window at a
// device scale) and enlarged text, on one open viewer resized in place.
const D1C_SIZES = [
  { width: 320, height: 568 },
  { width: 375, height: 667 },
  { width: 390, height: 844 },
  { width: 844, height: 390, label: 'landscape phone' },
  { width: 540, height: 360, label: 'short' },
  { width: 600, height: 320, label: 'short' },
  { width: 768, height: 1024 },
  { width: 640, height: 400, scale: 2, label: '1280x800 at 200% browser zoom' },
  { width: 390, height: 844, font: '32px', label: '200% text' },
  { width: 1280, height: 800 },
];

test('D1-C: narrow, short, landscape, zoomed and large-text windows keep the viewer usable by touch, keyboard and pointer', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await serveMedia(page);
  await openLibrary(page);
  await openViewer(page, FOUR);
  await waitForStatus(page, 'loaded');
  await recordTouchEffects(page);
  const dialog = page.locator(DIALOG);
  const position = dialog.locator('[data-unified-viewer-position]');
  const emulation = await page.context().newCDPSession(page);
  const touch = await touchscreen(page);
  try {
    for (const size of D1C_SIZES) {
      const label = `${size.width}x${size.height}${size.label ? ` (${size.label})` : ''}`;
      if (size.scale) {
        await emulation.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: size.scale, mobile: false });
      } else {
        await emulation.send('Emulation.clearDeviceMetricsOverride');
        await page.setViewportSize({ width: size.width, height: size.height });
      }
      await page.evaluate((font) => { document.documentElement.style.fontSize = font; }, size.font || '');
      await expect.poll(async () => {
        const geometry = await boxes(page);
        return geometry.surface.width > 0 && geometry.surface.width <= size.width
          && geometry.image.width <= geometry.surface.width + 0.5 && geometry.image.height <= geometry.surface.height + 0.5;
      }, label).toBe(true);
      // A relayout never replaces the source or moves the current item.
      await expect(position, label).toHaveText('1 of 4');
      expectContained(await boxes(page), IMAGES.landscape);
      await expectFiniteGeometry(page);
      const overflow = await pageOverflow(page);
      expect(overflow.x, `${label}: no horizontal viewer overflow`).toBeLessThanOrEqual(0);
      expect(overflow.scrolled, label).toBe(0);
      expect(overflow.dialog.left, label).toBeGreaterThanOrEqual(0);
      expect(overflow.dialog.top, label).toBeGreaterThanOrEqual(0);
      expect(overflow.dialog.right, label).toBeLessThanOrEqual(overflow.dialog.vw + 0.5);
      expect(overflow.dialog.bottom, label).toBeLessThanOrEqual(overflow.dialog.vh + 0.5);
      const viewportBounds = { left: 0, top: 0, right: overflow.dialog.vw, bottom: overflow.dialog.vh };
      await expectReachable(page, ['Close Image Preview', 'Previous', 'Next', 'Enter fullscreen'], viewportBounds);
      const compact = await dialog.locator('[data-unified-viewer-overflow]').isVisible();
      if (compact) {
        await expectReachable(page, ['More viewer tools'], viewportBounds);
        await dialog.getByRole('button', { name: 'More viewer tools' }).click();
      }
      // Every view tool is reachable (in the menu when compact) and works.
      await expectReachable(page, ['Zoom in', 'Fit to viewer'], viewportBounds);
      await dialog.getByRole('button', { name: 'Zoom in', exact: true }).click();
      expect((await mediaState(page)).view.mode, label).toBe('zoom');
      await dialog.getByRole('button', { name: 'Fit to viewer', exact: true }).click();
      expect((await mediaState(page)).view.mode, label).toBe('fit');
      // Fit disables itself; focus moves to a usable control (the menu
      // trigger when compact, which closes the menu), never to <body>.
      await expect(dialog.locator('[data-unified-viewer-overflow]'), label).not.toHaveAttribute('open', '');
      await expect.poll(() => page.evaluate((selector) => {
        const active = document.activeElement;
        return Boolean(active && document.querySelector(selector).contains(active) && !active.disabled
          && active.getClientRects().length > 0);
      }, DIALOG), label).toBe(true);
      await expect(dialog, label).toBeVisible();
      // Touch: edge zones scale with the surface; a right-edge tap and a swipe
      // each step once, and Previous tapped at once steps back.
      const g = await stageGeometry(page);
      const zone = Math.min(g.surface.width * 0.3, Math.max(44, g.surface.width * 0.2));
      await tapAt(touch, page, g.surface.x + g.surface.width - zone / 2, g.cy, 41);
      await expect(position, label).toHaveText('2 of 4');
      await quickStroke(touch, page, g.cx + g.surface.width * 0.3, g.cy, g.cx - g.surface.width * 0.3, g.cy, 42);
      await expect(position, label).toHaveText('3 of 4');
      await tapButton(touch, page, 'Previous', 43);
      await expect(position, label).toHaveText('2 of 4');
      // Keyboard equivalence from a focused control.
      await dialog.getByRole('button', { name: 'Next', exact: true }).focus();
      await page.keyboard.press('ArrowLeft');
      await expect(position, label).toHaveText('1 of 4');
      await waitForStatus(page, 'loaded');
    }
  } finally {
    await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
    await emulation.send('Emulation.clearDeviceMetricsOverride');
    await emulation.detach();
    await touch.detach();
  }
  expect((await touchEffects(page)).navigations).toHaveLength(D1C_SIZES.length * 4);
});

test('D1-C: resizing during a touch, while enlarged, during loading and with a menu open keeps the item and bounds', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const media = await serveMedia(page);
  await openLibrary(page);
  await openViewer(page, [{ id: 1, media: 'large' }, { id: 2, media: 'portrait' }, { id: 3, media: 'landscape-3' }]);
  await waitForStatus(page, 'loaded');
  await recordTouchEffects(page);
  const dialog = page.locator(DIALOG);
  const position = dialog.locator('[data-unified-viewer-position]');
  const touch = await touchscreen(page);
  let g = await stageGeometry(page);

  // A swipe already under way when the window rotates never navigates…
  await touch.start([[1, g.cx + 120, g.cy]]);
  await touch.move([[1, g.cx, g.cy]]);
  await page.setViewportSize({ width: 844, height: 390 });
  await expect.poll(async () => (await boxes(page)).surface.width).toBeGreaterThan(500);
  await touch.move([[1, g.cx - 120, g.cy]]);
  await touch.end();
  await settleInput(page);
  await expect(position).toHaveText('1 of 3');
  expectContained(await boxes(page), IMAGES.large);
  // …and leaves no hidden fling: Next works at once.
  await tapButton(touch, page, 'Next', 2);
  await expect(position).toHaveText('2 of 3');
  await page.keyboard.press('ArrowLeft');
  await expect(position).toHaveText('1 of 3');
  await waitForStatus(page, 'loaded');

  // A pinch held across a resize rebases instead of jumping; bounds hold.
  g = await stageGeometry(page);
  await touch.start([[3, g.cx - 40, g.cy], [4, g.cx + 40, g.cy]]);
  await touch.move([[3, g.cx - 120, g.cy], [4, g.cx + 120, g.cy]]);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => (await boxes(page)).surface.width).toBeLessThan(400);
  await touch.move([[3, g.cx - 140, g.cy], [4, g.cx + 140, g.cy]]);
  await touch.end();
  await settleInput(page);
  let view = await expectFiniteGeometry(page);
  expect(view.mode).toBe('zoom');
  expect(view.scale).toBeLessThanOrEqual(view.maxScale);
  expectCovering(await boxes(page));
  // Enlarged, then rotated and shortened: still bounded and covering.
  for (const size of [{ width: 844, height: 390 }, { width: 600, height: 320 }, { width: 320, height: 568 }]) {
    await page.setViewportSize(size);
    await expect.poll(async () => (await boxes(page)).surface.width).toBeLessThan(size.width);
    await settleInput(page);
    view = await expectFiniteGeometry(page);
    expect(view.mode).toBe('zoom');
    expectCovering(await boxes(page));
  }
  await expect(position).toHaveText('1 of 3');

  // A resize while the next item is still loading keeps that item.
  media.hold('landscape-3');
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.getByRole('button', { name: 'Next', exact: true }).click();
  await dialog.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(position).toHaveText('3 of 3');
  await waitForStatus(page, 'loading');
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(dialog.getByRole('button', { name: 'Previous', exact: true })).toBeVisible();
  media.release('landscape-3');
  await waitForStatus(page, 'loaded');
  await expect(position).toHaveText('3 of 3');
  expectContained(await boxes(page), IMAGES.landscape);

  // The overflow menu open with focus inside it across a widening and back.
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = dialog.locator('[data-unified-viewer-overflow]');
  await expect(overflow).toBeVisible();
  await dialog.getByRole('button', { name: 'More viewer tools' }).click();
  await dialog.getByRole('button', { name: 'Zoom in', exact: true }).focus();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(overflow).toBeHidden();
  // Focus stays on a usable control in the dialog: never <body>, never hidden.
  await expect.poll(() => page.evaluate((selector) => {
    const active = document.activeElement;
    return Boolean(active && active !== document.body && document.querySelector(selector).contains(active)
      && active.getClientRects().length > 0 && !active.closest('[hidden]'));
  }, DIALOG)).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(overflow).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(position).toHaveText('3 of 3');
  // Wrapping is unchanged: a non-wrapping sequence stops at its end.
  await dialog.getByRole('button', { name: 'Previous', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(position).toHaveText('3 of 3');
  await expect(dialog).toBeVisible();
  expect((await touchEffects(page)).navigations.map((entry) => entry.key)).toEqual(['p:7|a:2', 'p:7|a:1', 'p:7|a:2', 'p:7|a:3']);
  await touch.detach();
});

// iPhone-like landscape insets (Chromium emulation of env(safe-area-inset-*)).
const LANDSCAPE_INSETS = { top: 20, right: 44, bottom: 21, left: 44 };

async function enterFullscreen(page) {
  await page.locator(DIALOG).getByRole('button', { name: 'Enter fullscreen', exact: true }).click();
  await expect.poll(() => isFullscreen(page)).toBe(true);
  await settleInput(page);
}

test('D1-C: fullscreen with safe-area insets keeps controls clear and reachable; a touch tap brings hidden chrome back', async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await serveMedia(page);
  await openLibrary(page);
  const emulation = await page.context().newCDPSession(page);
  await emulation.send('Emulation.setSafeAreaInsetsOverride', { insets: LANDSCAPE_INSETS });
  const touch = await touchscreen(page);
  try {
    await openViewer(page, FOUR);
    await waitForStatus(page, 'loaded');
    await recordTouchEffects(page);
    const dialog = page.locator(DIALOG);
    const card = dialog.locator('[data-unified-viewer-card]');
    const position = dialog.locator('[data-unified-viewer-position]');
    const hidden = () => card.evaluate((element) => element.hasAttribute('data-viewer-chrome-hidden'));
    const safe = { left: LANDSCAPE_INSETS.left, top: LANDSCAPE_INSETS.top, right: 844 - LANDSCAPE_INSETS.right, bottom: 390 - LANDSCAPE_INSETS.bottom };
    const essentials = ['Close Image Preview', 'Previous', 'Next'];

    // Dialog mode: everything essential is inside the window and hittable.
    await expectReachable(page, [...essentials, 'Enter fullscreen'], { left: 0, top: 0, right: 844, bottom: 390 });

    await enterFullscreen(page);
    await expect(dialog.getByRole('button', { name: 'Exit fullscreen', exact: true })).toBeVisible();
    // Fullscreen: close, navigation and footer controls clear every inset.
    await expectReachable(page, [...essentials, 'Exit fullscreen'], safe);
    const compact = await dialog.locator('[data-unified-viewer-overflow]').isVisible();
    await expectReachable(page, compact ? ['More viewer tools'] : ['Zoom in', 'Fit to viewer'], safe);
    // The media still uses the whole screen (insets never shrink the stage).
    const g = await stageGeometry(page);
    expect(g.surface).toMatchObject({ x: 0, y: 0, width: 844, height: 390 });
    // Reduced motion: chrome hides and shows without any transition.
    expect(await card.evaluate((element) => [...element.querySelectorAll('.app-dialog-header, .unified-viewer-context, .unified-viewer-controls')]
      .map((surface) => getComputedStyle(surface).transitionDuration))).toEqual(['0s', '0s', '0s']);

    // Touch chrome: a centre tap hides, a tap on hidden chrome reveals.
    await tapAt(touch, page, g.cx, g.cy, 51);
    expect(await hidden()).toBe(true);
    await tapAt(touch, page, g.cx, g.cy, 52);
    expect(await hidden()).toBe(false);
    await tapAt(touch, page, g.cx, g.cy, 53);
    expect(await hidden()).toBe(true);
    // A tap where the hidden footer and navigation sit reveals them; it never
    // activates the invisible control under the finger.
    const next = await dialog.getByRole('button', { name: 'Next', exact: true }).boundingBox();
    await tapAt(touch, page, next.x + next.width / 2, next.y + next.height / 2, 54);
    expect(await hidden()).toBe(false);
    await expect(position).toHaveText('1 of 4');
    await tapAt(touch, page, g.cx, g.cy, 55);
    expect(await hidden()).toBe(true);
    // Edge taps just inside the usable area navigate and keep chrome hidden.
    await tapAt(touch, page, safe.right - 12, g.cy, 56);
    await expect(position).toHaveText('2 of 4');
    expect(await hidden()).toBe(true);
    await tapAt(touch, page, safe.left + 12, g.cy, 57);
    await expect(position).toHaveText('1 of 4');
    expect(await hidden()).toBe(true);
    await waitForStatus(page, 'loaded');

    // Enlarged with hidden chrome: pans and pinches keep it hidden, a tap
    // brings it back, and every essential control is then reachable by touch.
    await touch.start([[0, g.cx - 40, g.cy], [1, g.cx + 40, g.cy]]);
    await touch.move([[0, g.cx - 160, g.cy], [1, g.cx + 160, g.cy]]);
    await touch.end();
    await settleInput(page);
    expect((await mediaState(page)).view.mode).toBe('zoom');
    expect(await hidden()).toBe(true);
    await quickStroke(touch, page, g.cx + 100, g.cy, g.cx - 100, g.cy, 58);
    expect(await hidden()).toBe(true);
    await tapAt(touch, page, safe.right - 12, g.cy, 59);
    expect(await hidden()).toBe(false);
    await expect(position).toHaveText('1 of 4');
    await expectReachable(page, [...essentials, 'Exit fullscreen'], safe);
    if (compact) await tapButton(touch, page, 'More viewer tools', 60);
    await tapButton(touch, page, 'Fit to viewer', 61);
    expect((await mediaState(page)).view.mode).toBe('fit');
    expect(await isFullscreen(page)).toBe(true);

    // Keyboard: Tab reveals hidden chrome onto a visibly focused control.
    await tapAt(touch, page, g.cx, g.cy, 62);
    expect(await hidden()).toBe(true);
    await page.keyboard.press('Tab');
    expect(await hidden()).toBe(false);
    const focused = await page.evaluate(() => {
      const active = document.activeElement;
      const r = active.getBoundingClientRect();
      const style = getComputedStyle(active);
      return { inCard: Boolean(active.closest('[data-unified-viewer-card]')), visible: active.matches(':focus-visible'),
        outline: style.outlineStyle, ring: { left: r.left - 3, top: r.top - 3, right: r.right + 3, bottom: r.bottom + 3 } };
    });
    expect(focused).toMatchObject({ inCard: true, visible: true });
    expect(focused.ring.left).toBeGreaterThanOrEqual(0);
    expect(focused.ring.top).toBeGreaterThanOrEqual(0);
    expect(focused.ring.right).toBeLessThanOrEqual(844);
    expect(focused.ring.bottom).toBeLessThanOrEqual(390);

    // Escape order: an open menu first, then fullscreen, then the dialog.
    if (compact) {
      await dialog.getByRole('button', { name: 'More viewer tools' }).click();
      await page.keyboard.press('Escape');
      await expect(dialog.locator('[data-unified-viewer-overflow]')).not.toHaveAttribute('open', '');
      expect(await isFullscreen(page)).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect.poll(() => isFullscreen(page)).toBe(false);
    await expect(dialog).toBeVisible();
    await expect(position).toHaveText('1 of 4');
    expect(await page.evaluate((selector) => document.querySelector(selector).contains(document.activeElement), DIALOG)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.locator('#test-opener')).toBeFocused();
    expect((await touchEffects(page)).navigations.map((entry) => entry.key)).toEqual(['p:7|a:2', 'p:7|a:1']);
  } finally {
    await emulation.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
    await emulation.detach();
    await touch.detach();
  }
});

// Counts the document's own listeners by type and phase (B4/D1-B listeners
// are registered there; the click guard is armed only transiently).
async function countDocumentListeners(page) {
  await page.addInitScript(() => {
    const live = new Map();
    const add = EventTarget.prototype.addEventListener;
    const remove = EventTarget.prototype.removeEventListener;
    const key = (type, options) => `${type}|${typeof options === 'boolean' ? options : Boolean(options?.capture)}`;
    EventTarget.prototype.addEventListener = function addCounted(type, handler, options) {
      if (this === document && handler) {
        const entries = live.get(handler) || new Set();
        entries.add(key(type, options));
        live.set(handler, entries);
      }
      return add.call(this, type, handler, options);
    };
    EventTarget.prototype.removeEventListener = function removeCounted(type, handler, options) {
      if (this === document && handler) live.get(handler)?.delete(key(type, options));
      return remove.call(this, type, handler, options);
    };
    window.__documentListeners = () => {
      const counts = {};
      for (const entries of live.values()) for (const entry of entries) counts[entry] = (counts[entry] || 0) + 1;
      return counts;
    };
  });
}

test('D1-C: leaving fullscreen during a pinch, pan, swipe or open menu leaves no stale gesture, focus or listener', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await countDocumentListeners(page);
  await serveMedia(page);
  await openLibrary(page);
  await openViewer(page, EIGHT);
  await waitForStatus(page, 'loaded');
  await recordTouchEffects(page);
  const baseline = await page.evaluate(() => window.__documentListeners());
  const dialog = page.locator(DIALOG);
  const position = dialog.locator('[data-unified-viewer-position]');
  const touch = await touchscreen(page);

  // A pinch in progress when Escape leaves fullscreen.
  await enterFullscreen(page);
  let g = await stageGeometry(page);
  await touch.start([[1, g.cx - 40, g.cy], [2, g.cx + 40, g.cy]]);
  await touch.move([[1, g.cx - 120, g.cy], [2, g.cx + 120, g.cy]]);
  await page.keyboard.press('Escape');
  await expect.poll(() => isFullscreen(page)).toBe(false);
  await touch.move([[1, g.cx - 300, g.cy], [2, g.cx + 300, g.cy]]);
  await touch.end();
  await settleInput(page);
  await expect(dialog).toBeVisible();
  let view = await expectFiniteGeometry(page);
  expect(view.scale).toBeLessThanOrEqual(view.maxScale);
  expect(view).toMatchObject({ touchContacts: 0, touchGesture: 'none' });
  await expect(position).toHaveText('1 of 8');

  // A pan in progress when the browser leaves fullscreen.
  await enterFullscreen(page);
  g = await stageGeometry(page);
  expect((await mediaState(page)).view.mode).toBe('zoom');
  await touch.start([[3, g.cx, g.cy]]);
  await touch.move([[3, g.cx - 60, g.cy - 60]]);
  await page.evaluate(() => document.exitFullscreen());
  await expect.poll(() => isFullscreen(page)).toBe(false);
  await touch.move([[3, g.cx - 400, g.cy - 400]]);
  await touch.end();
  await settleInput(page);
  view = await expectFiniteGeometry(page);
  expectCovering(await boxes(page));
  await expect(position).toHaveText('1 of 8');

  // A swipe begun in fullscreen and finished after it ended never navigates.
  await dialog.getByRole('button', { name: 'Next', exact: true }).click();
  await waitForStatus(page, 'loaded');
  await enterFullscreen(page);
  g = await stageGeometry(page);
  await touch.start([[4, g.cx + 150, g.cy]]);
  await touch.move([[4, g.cx + 60, g.cy]]);
  await page.evaluate(() => document.exitFullscreen());
  await expect.poll(() => isFullscreen(page)).toBe(false);
  await touch.move([[4, g.cx - 150, g.cy]]);
  await touch.end();
  await settleInput(page);
  await expect(position).toHaveText('2 of 8');
  // …and the next control tap works at once.
  await tapButton(touch, page, 'Next', 5);
  await expect(position).toHaveText('3 of 8');

  // The overflow menu open (focus inside it) when fullscreen ends.
  await enterFullscreen(page);
  await dialog.getByRole('button', { name: 'More viewer tools' }).click();
  await dialog.getByRole('button', { name: 'Zoom in', exact: true }).focus();
  await page.evaluate(() => document.exitFullscreen());
  await expect.poll(() => isFullscreen(page)).toBe(false);
  await expect(dialog).toBeVisible();
  expect(await page.evaluate((selector) => document.querySelector(selector).contains(document.activeElement), DIALOG)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog.locator('[data-unified-viewer-overflow]')).not.toHaveAttribute('open', '');
  await expect(dialog).toBeVisible();

  // Repeated entry and exit, then close and reopen: no listener accumulates,
  // the follow-up click guard is gone, and focus returns to the opener.
  for (let round = 0; round < 3; round += 1) {
    await enterFullscreen(page);
    await tapAt(touch, page, g.right, g.cy, 10 + round);
    await page.keyboard.press('Escape');
    await expect.poll(() => isFullscreen(page)).toBe(false);
  }
  await expect(position).toHaveText('6 of 8');
  await page.waitForTimeout(900);
  expect(await page.evaluate(() => window.__documentListeners())).toEqual(baseline);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.locator('#test-opener')).toBeFocused();
  await openViewer(page, EIGHT);
  await waitForStatus(page, 'loaded');
  await expect(position).toHaveText('1 of 8');
  expect(await page.evaluate(() => window.__documentListeners())).toEqual(baseline);
  expect((await touchEffects(page)).navigations.map((entry) => entry.key)).toEqual(
    ['p:7|a:2', 'p:7|a:3', 'p:7|a:4', 'p:7|a:5', 'p:7|a:6']);
  await touch.detach();
});

test('D1-C: failure status and Retry stay reachable by touch and keyboard at narrow, landscape and fullscreen sizes', async ({ page }) => {
  const media = await serveMedia(page);
  media.fail('portrait', { status: 500, contentType: 'text/plain', body: 'nope' });
  await page.setViewportSize({ width: 320, height: 568 });
  await openLibrary(page);
  const emulation = await page.context().newCDPSession(page);
  const touch = await touchscreen(page);
  try {
    await openViewer(page, [{ id: 1, media: 'landscape' }, { id: 2, media: 'portrait' }]);
    await waitForStatus(page, 'loaded');
    const dialog = page.locator(DIALOG);
    const status = dialog.locator('[data-unified-viewer-status]');
    await expect(status).toHaveAttribute('role', 'status');
    // Swipe onto the failing item: failure is announced and Retry is reachable.
    let g = await stageGeometry(page);
    await quickStroke(touch, page, g.cx + 100, g.cy, g.cx - 100, g.cy, 1);
    await waitForStatus(page, 'failed');
    await expect(status).toHaveText('This image could not be loaded.');
    await expect(dialog.locator('[data-unified-viewer-position]')).toHaveText('2 of 2');
    for (const size of [{ width: 320, height: 568 }, { width: 568, height: 320 }]) {
      await page.setViewportSize(size);
      await expectReachable(page, ['Retry', 'Previous', 'Close Image Preview'], { left: 0, top: 0, right: size.width, bottom: size.height });
    }
    // Keyboard reaches Retry from the dialog's controls.
    await dialog.getByRole('button', { name: 'Previous', exact: true }).focus();
    let reached = false;
    for (let step = 0; step < 12 && !reached; step += 1) {
      await page.keyboard.press('Shift+Tab');
      reached = await dialog.getByRole('button', { name: 'Retry', exact: true }).evaluate((button) => button === document.activeElement);
    }
    expect(reached).toBe(true);
    // In fullscreen with insets, Retry stays clear of them and a touch tap on it
    // (never a stage gesture) retries.
    await emulation.send('Emulation.setSafeAreaInsetsOverride', { insets: LANDSCAPE_INSETS });
    await enterFullscreen(page);
    await expectReachable(page, ['Retry'], { left: LANDSCAPE_INSETS.left, top: LANDSCAPE_INSETS.top,
      right: 568 - LANDSCAPE_INSETS.right, bottom: 320 - LANDSCAPE_INSETS.bottom });
    // The failure message clears the left inset and never runs under Retry.
    const text = await status.boundingBox();
    const retry = await dialog.getByRole('button', { name: 'Retry', exact: true }).boundingBox();
    expect(text.x).toBeGreaterThanOrEqual(LANDSCAPE_INSETS.left - 0.5);
    expect(text.x + text.width).toBeLessThanOrEqual(retry.x + 0.5);
    media.heal('portrait');
    await tapButton(touch, page, 'Retry', 2);
    await waitForStatus(page, 'loaded');
    await expect(status).toHaveText('');
    expect(await isFullscreen(page)).toBe(true);
    // Retry's removal never strands focus on <body>.
    expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
    g = await stageGeometry(page);
    expectContained(await boxes(page), IMAGES.portrait);
  } finally {
    await emulation.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
    await emulation.detach();
    await touch.detach();
  }
});
