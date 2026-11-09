import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createApp } from '../../src/app.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';

// B4: slideshow playback and baseline fullscreen in the unified viewer, in
// real Chromium with the real native modal dialog, shared dialog binder,
// dropdowns and Fullscreen API. The viewer is opened through its controller
// from an isolated test opener on an opted-in page (no production trigger is
// migrated yet). Media is served by page.route from images generated here,
// so delays and failures are controlled by the test; no user data is used.
//
// Environment notes, verified while writing these tests:
// - Headless Chromium grants element fullscreen inside a modal dialog (the
//   card becomes document.fullscreenElement and fills the viewport) and
//   rejects dialog.requestFullscreen() with a TypeError.
// - Headless Chromium delivers Escape to the page even in fullscreen (no
//   browser-level interception), so the viewer's own Escape ordering is what
//   is exercised here.
// - Headless Chromium never changes document.visibilityState (minimizing or
//   backgrounding a target has no effect), so the hidden-tab test overrides
//   visibilityState on the page's document and dispatches a real
//   visibilitychange event to the real listener.

const DIALOG = '#unified-viewer-dialog';
const CARD = `${DIALOG} [data-unified-viewer-card]`;
const MEDIA = `${DIALOG} [data-unified-viewer-media]`;
const SHOWN = `${MEDIA} img.unified-viewer-image:not([hidden])`;

async function startApp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-unified-viewer-playback-'));
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

async function makeImage(width, height, color) {
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
    + `<rect width="100%" height="100%" fill="rgb(${color.r},${color.g},${color.b})"/>`
    + `<rect x="0" y="0" width="${Math.ceil(width / 2)}" height="${Math.ceil(height / 2)}" fill="#fff"/></svg>`);
  return sharp(svg).webp().toBuffer();
}

const IMAGES = {};
let fixture;
test.beforeAll(async () => {
  fixture = await startApp();
  IMAGES.a = { body: await makeImage(1600, 900, { r: 200, g: 40, b: 40 }), type: 'image/webp' };
  IMAGES.b = { body: await makeImage(900, 1600, { r: 40, g: 160, b: 40 }), type: 'image/webp' };
  IMAGES.c = { body: await makeImage(1200, 1200, { r: 40, g: 40, b: 200 }), type: 'image/webp' };
  IMAGES.original = { body: await makeImage(3200, 1800, { r: 120, g: 120, b: 40 }), type: 'image/webp' };
});
test.afterAll(async () => { await fixture?.close(); });

// Routes /test-media/<name>; a held name waits for release(name).
async function serveMedia(page) {
  const holds = new Map();
  const counts = new Map();
  const failures = new Map();
  await page.route('**/test-media/**', async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop();
    counts.set(name, (counts.get(name) || 0) + 1);
    if (holds.has(name)) await holds.get(name).promise;
    try {
      if (failures.has(name)) {
        await route.fulfill(failures.get(name));
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
    fail(name) { failures.set(name, { status: 500, contentType: 'text/plain', body: 'boom' }); },
    heal(name) { failures.delete(name); },
    count: (name) => counts.get(name) || 0,
  };
}

async function openLibrary(page) {
  await page.goto(`${fixture.baseURL}/assets`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(async () => {
    const viewer = await import('/client/unified-viewer.js');
    return Boolean(viewer.unifiedViewerFor(document));
  });
  await page.evaluate(async () => {
    const host = document.createElement('div');
    host.id = 'test-viewer-host';
    host.innerHTML = '<button type="button" id="test-opener">Open viewer</button>';
    document.querySelector('main').prepend(host);
    document.body.style.minHeight = '300vh';
    window.scrollTo(0, 120);
    // Record the controller's and media participant's events with times.
    const { unifiedViewerFor } = await import('/client/unified-viewer.js');
    const viewer = unifiedViewerFor(document);
    window.__viewerLog = [];
    viewer.observe((change) => window.__viewerLog.push({
      kind: 'change', type: change.type, cause: change.cause || null, key: change.key, t: performance.now(),
    }));
    viewer.media.observe((state, reason) => window.__viewerLog.push({
      kind: 'media', reason, status: state.status, key: state.key, t: performance.now(),
    }));
  });
}

// items: [{ id, media, original? }]; options.slideshow builds a B1 slideshow.
async function openViewer(page, items, { slideshow = true, autoplay } = {}) {
  await page.locator('#test-opener').focus();
  return page.evaluate(async ({ items, slideshow, autoplay }) => {
    const { unifiedViewerFor } = await import('/client/unified-viewer.js');
    const { createViewerSource } = await import('/client/viewer-sequence.js');
    return unifiedViewerFor(document).open(createViewerSource({
      key: 'playback-test',
      label: 'Playback test',
      mode: 'sequence',
      wrap: slideshow,
      slideshow,
      items: items.map(({ id, media, original }) => ({
        projectId: 7,
        assetId: id,
        title: `${media}-${id}.webp`,
        mediaUrl: `/test-media/${media}`,
        originalUrl: original ? `/test-media/${original}` : undefined,
        detailsUrl: `/projects/7/assets/${id}`,
        revision: 'r1',
      })),
    }), { opener: document.getElementById('test-opener'), ...(autoplay === undefined ? {} : { autoplay }) });
  }, { items, slideshow, autoplay });
}

const viewerState = (page) => page.evaluate(async () => {
  const { unifiedViewerFor } = await import('/client/unified-viewer.js');
  const viewer = unifiedViewerFor(document);
  return {
    ...viewer.getState(),
    source: undefined,
    item: undefined,
    playbackDetail: viewer.playback.getState(),
    fullscreenDetail: viewer.fullscreen.getState(),
    media: viewer.media.getState(),
    fullscreenElement: document.fullscreenElement ? (document.fullscreenElement.matches('[data-unified-viewer-card]') ? 'card' : 'other') : null,
  };
});

const viewerLog = (page) => page.evaluate(() => window.__viewerLog.slice());

async function chooseSpeed(page, label) {
  const dialog = page.locator(DIALOG);
  await dialog.locator('#unified-viewer-speed-dropdown summary').click();
  await dialog.locator('#unified-viewer-speed-dropdown-options').getByText(label, { exact: true }).click();
}

const THREE = [{ id: 1, media: 'a' }, { id: 2, media: 'b' }, { id: 3, media: 'c' }];

test('an explicit slideshow opens playing and waits for each slide to load before its interval', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const media = await serveMedia(page);
  await openLibrary(page);
  media.hold('b');
  await openViewer(page, THREE);
  const dialog = page.locator(DIALOG);
  await expect(dialog).toBeVisible();
  const play = dialog.locator('[data-unified-viewer-play]');
  await expect(play).toHaveAccessibleName('Pause slideshow');
  await expect(dialog.getByRole('group', { name: 'Slideshow', exact: true })).toBeVisible();
  await expect(dialog.locator('#unified-viewer-speed-dropdown summary')).toContainText('4 s');
  await chooseSpeed(page, '2 s');
  await expect(dialog.locator('#unified-viewer-speed-dropdown summary')).toContainText('2 s');
  expect((await viewerState(page)).playback).toEqual({ available: true, playing: true, speed: 2000 });

  // Slide 1 shows; after its interval the slideshow moves to slide 2,
  // whose image is held: nothing advances while it loads.
  await expect(dialog.locator('[data-unified-viewer-position]')).toHaveText('2 of 3', { timeout: 8000 });
  await page.waitForTimeout(3000);
  await expect(dialog.locator('[data-unified-viewer-position]')).toHaveText('2 of 3');
  expect((await viewerState(page)).playbackDetail).toMatchObject({ playing: true, waiting: true, scheduled: false });
  media.release('b');
  await expect(dialog.locator('[data-unified-viewer-position]')).toHaveText('3 of 3', { timeout: 8000 });

  // The interval for slide 2 began only once it had loaded.
  const log = await viewerLog(page);
  const loaded2 = log.find((entry) => entry.kind === 'media' && entry.status === 'loaded' && entry.key === 'p:7|a:2');
  const advanced3 = log.find((entry) => entry.kind === 'change' && entry.type === 'navigate' && entry.key === 'p:7|a:3');
  expect(advanced3.cause).toBe('playback');
  expect(advanced3.t - loaded2.t).toBeGreaterThanOrEqual(1950);
  const advanced2 = log.find((entry) => entry.kind === 'change' && entry.type === 'navigate' && entry.key === 'p:7|a:2');
  expect(loaded2.t - advanced2.t).toBeGreaterThanOrEqual(2900);
  // An auto-advancing slideshow does not announce each slide.
  await expect(dialog.locator('[data-unified-viewer-position]')).toHaveAttribute('aria-live', 'off');

  // It wraps (the source's setting) and keeps playing.
  await expect(dialog.locator('[data-unified-viewer-position]')).toHaveText('1 of 3', { timeout: 8000 });
  expect((await viewerState(page)).playback.playing).toBe(true);

  // Pause from the keyboard keeps the slide.
  await play.focus();
  await page.keyboard.press('Enter');
  await expect(play).toHaveAccessibleName('Play slideshow');
  await expect(dialog.locator('[data-unified-viewer-position]')).toHaveAttribute('aria-live', 'polite');
  const position = await dialog.locator('[data-unified-viewer-position]').textContent();
  await page.waitForTimeout(2500);
  await expect(dialog.locator('[data-unified-viewer-position]')).toHaveText(position);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.locator('#test-opener')).toBeFocused();
});

test('reduced motion opens the slideshow paused; Play still works', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await serveMedia(page);
  await openLibrary(page);
  await openViewer(page, THREE);
  const dialog = page.locator(DIALOG);
  const play = dialog.locator('[data-unified-viewer-play]');
  await expect(play).toHaveAccessibleName('Play slideshow');
  await page.waitForTimeout(4500);
  await expect(dialog.locator('[data-unified-viewer-position]')).toHaveText('1 of 3');
  expect((await viewerState(page)).playbackDetail).toMatchObject({ playing: false, pauseReason: 'reduced-motion' });
  await dialog.getByRole('button', { name: 'Next' }).click();
  await expect(dialog.locator('[data-unified-viewer-position]')).toHaveText('2 of 3');
  await chooseSpeed(page, '2 s');
  expect((await viewerState(page)).playback.playing).toBe(false);
  await play.click();
  await expect(play).toHaveAccessibleName('Pause slideshow');
  await expect(dialog.locator('[data-unified-viewer-position]')).toHaveText('3 of 3', { timeout: 8000 });
});

test('manual navigation, a failed slide and original-size inspection pause playback', async ({ page }) => {
  const media = await serveMedia(page);
  await openLibrary(page);
  media.fail('c');
  await openViewer(page, [{ id: 1, media: 'a', original: 'original' }, { id: 2, media: 'b' }, { id: 3, media: 'c' }]);
  const dialog = page.locator(DIALOG);
  const play = dialog.locator('[data-unified-viewer-play]');
  const position = dialog.locator('[data-unified-viewer-position]');

  // Next pauses and keeps the chosen slide.
  await expect(page.locator(SHOWN)).toBeVisible();
  await dialog.getByRole('button', { name: 'Next' }).click();
  await expect(position).toHaveText('2 of 3');
  await expect(play).toHaveAccessibleName('Play slideshow');
  expect((await viewerState(page)).playbackDetail.pauseReason).toBe('navigation');
  await page.waitForTimeout(4500);
  await expect(position).toHaveText('2 of 3');

  // Playing on reaches the failing slide 3, which pauses with Retry.
  await chooseSpeed(page, '2 s');
  await play.click();
  await expect(position).toHaveText('3 of 3', { timeout: 8000 });
  await expect(dialog.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(play).toHaveAccessibleName('Play slideshow');
  expect((await viewerState(page)).playbackDetail.pauseReason).toBe('media');
  const failures = media.count('c');
  await page.waitForTimeout(4500);
  await expect(position).toHaveText('3 of 3');
  expect(media.count('c')).toBe(failures);
  // Retry succeeds without resuming.
  media.heal('c');
  await dialog.getByRole('button', { name: 'Retry' }).click();
  await expect(page.locator(SHOWN)).toBeVisible();
  await page.waitForTimeout(3000);
  await expect(position).toHaveText('3 of 3');
  expect((await viewerState(page)).playback.playing).toBe(false);

  // Original size pauses at once, stays paused while loading and after Fit.
  await play.click();
  await expect(position).toHaveText('1 of 3', { timeout: 8000 });
  await expect(page.locator(SHOWN)).toBeVisible();
  media.hold('original');
  await dialog.getByRole('button', { name: 'Original size' }).click();
  await expect(play).toHaveAccessibleName('Play slideshow');
  await expect(play).toBeDisabled();
  expect((await viewerState(page)).playbackDetail).toMatchObject({ playing: false, scheduled: false, pauseReason: 'inspection' });
  media.release('original');
  await expect(page.locator(SHOWN)).toHaveAttribute('data-viewer-content', 'original');
  await dialog.getByRole('button', { name: 'Fit to viewer' }).click();
  await page.waitForTimeout(3000);
  await expect(position).toHaveText('1 of 3');
  expect((await viewerState(page)).playback.playing).toBe(false);
});

test('a hidden tab pauses playback and showing it again does not resume', async ({ page }) => {
  await serveMedia(page);
  await openLibrary(page);
  await openViewer(page, THREE);
  const dialog = page.locator(DIALOG);
  await expect(page.locator(SHOWN)).toBeVisible();
  const setVisibility = (state) => page.evaluate((value) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => value === 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
  await setVisibility('hidden');
  expect((await viewerState(page)).playbackDetail).toMatchObject({ playing: false, scheduled: false, pauseReason: 'hidden' });
  await page.waitForTimeout(4500);
  await setVisibility('visible');
  await page.waitForTimeout(4500);
  await expect(dialog.locator('[data-unified-viewer-position]')).toHaveText('1 of 3');
  await expect(dialog.locator('[data-unified-viewer-play]')).toHaveAccessibleName('Play slideshow');
  await page.evaluate(() => {
    delete document.visibilityState;
    delete document.hidden;
  });
});

test('fullscreen uses the same viewer on the dialog card, and Escape exits it before closing', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const media = await serveMedia(page);
  await openLibrary(page);
  await openViewer(page, THREE, { autoplay: false });
  const dialog = page.locator(DIALOG);
  await expect(page.locator(SHOWN)).toBeVisible();
  const requests = media.count('a');
  const before = await page.locator(MEDIA).boundingBox();

  const enter = dialog.getByRole('button', { name: 'Enter fullscreen' });
  await enter.click();
  await expect.poll(async () => (await viewerState(page)).fullscreenElement).toBe('card');
  await expect(dialog.getByRole('button', { name: 'Exit fullscreen' })).toBeVisible();
  const state = await viewerState(page);
  expect(state).toMatchObject({ open: true, key: 'p:7|a:1', fullscreen: true, mediaStatus: 'loaded' });
  // Same image, no new request, geometry recomputed for the larger stage.
  expect(media.count('a')).toBe(requests);
  const after = await page.locator(MEDIA).boundingBox();
  expect(after.width).toBe(1280);
  expect(after.height).toBe(800);
  expect(after.height).toBeGreaterThan(before.height);
  await expect.poll(async () => (await viewerState(page)).media.view.viewportHeight).toBe(800);
  const image = await page.locator(SHOWN).boundingBox();
  expect(image.height).toBeCloseTo(800 * Math.min(1, 1280 / 1600 * 900 / 800), 0);
  await expect(page.locator(DIALOG)).toHaveAttribute('open', '');
  await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');

  // Navigation and zoom/pan work in fullscreen.
  await dialog.getByRole('button', { name: 'Zoom in' }).click();
  await dialog.getByRole('button', { name: 'Zoom in' }).click();
  let view = (await viewerState(page)).media.view;
  expect(view.mode).toBe('zoom');
  expect(view.canPan).toBe(true);
  const surface = await page.locator(MEDIA).boundingBox();
  await page.mouse.move(surface.x + surface.width / 2, surface.y + surface.height / 2);
  await page.mouse.down();
  await page.mouse.move(surface.x + surface.width / 2 + 5000, surface.y + surface.height / 2 + 5000, { steps: 4 });
  await page.mouse.up();
  view = (await viewerState(page)).media.view;
  expect(view.panX).toBeCloseTo(view.maxPanX, 3);

  // Escape exits fullscreen only; the viewer stays open on the same item.
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await viewerState(page)).fullscreenElement).toBe(null);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Enter fullscreen' })).toBeVisible();
  // Leaving fullscreen re-clamps the pan into the smaller stage.
  await expect.poll(async () => {
    const current = (await viewerState(page)).media.view;
    return current.viewportHeight < 800 && Math.abs(current.panX) <= current.maxPanX + 1e-6 && Math.abs(current.panY) <= current.maxPanY + 1e-6;
  }).toBe(true);
  expect((await viewerState(page)).key).toBe('p:7|a:1');
  // The next Escape dismisses through the shared binder, restoring focus.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.locator('#test-opener')).toBeFocused();
  await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');
  expect(await page.evaluate(() => window.scrollY)).toBe(120);
});

test('an open speed dropdown takes Escape before fullscreen and the dialog', async ({ page }) => {
  await serveMedia(page);
  await openLibrary(page);
  await openViewer(page, THREE, { autoplay: false });
  const dialog = page.locator(DIALOG);
  await dialog.getByRole('button', { name: 'Enter fullscreen' }).click();
  await expect.poll(async () => (await viewerState(page)).fullscreenElement).toBe('card');
  const dropdown = dialog.locator('#unified-viewer-speed-dropdown');
  await dropdown.locator('summary').click();
  await expect(dropdown).toHaveAttribute('open', '');
  await page.keyboard.press('Escape');
  await expect(dropdown).not.toHaveAttribute('open', '');
  expect((await viewerState(page)).fullscreenElement).toBe('card');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await viewerState(page)).fullscreenElement).toBe(null);
  await expect(dialog).toBeVisible();
});

test('closing from fullscreen exits it cleanly, and repeated fullscreen and reopen stay clean', async ({ page }) => {
  await serveMedia(page);
  await openLibrary(page);
  const dialog = page.locator(DIALOG);
  for (let round = 0; round < 3; round += 1) {
    await openViewer(page, THREE);
    await expect(page.locator(SHOWN)).toBeVisible();
    await dialog.getByRole('button', { name: 'Enter fullscreen' }).click();
    await expect.poll(async () => (await viewerState(page)).fullscreenElement).toBe('card');
    await page.mouse.move(10, 10);
    await dialog.getByRole('button', { name: 'Close Viewer' }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(async () => (await viewerState(page)).fullscreenElement).toBe(null);
    await expect(page.locator('#test-opener')).toBeFocused();
    await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');
    const state = await viewerState(page);
    expect(state).toMatchObject({ open: false, fullscreen: false, playback: { available: false, playing: false } });
    expect(state.fullscreenDetail).toMatchObject({ active: false, pending: false, chromeHidden: false });
  }
  // A request still pending when the viewer closes is released when it lands.
  await openViewer(page, THREE);
  await dialog.getByRole('button', { name: 'Enter fullscreen' }).click();
  await dialog.evaluate((element) => element.querySelector('[data-dialog-close]').click());
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await viewerState(page)).fullscreenElement, { timeout: 5000 }).toBe(null);
  expect(await page.evaluate(() => document.querySelector('[data-unified-viewer-card]').hasAttribute('data-viewer-chrome-hidden'))).toBe(false);
});

test('controls stay visible in the dialog and idle-hide only in fullscreen', async ({ page }) => {
  await serveMedia(page);
  await openLibrary(page);
  await openViewer(page, THREE, { autoplay: false });
  const dialog = page.locator(DIALOG);
  const card = page.locator(CARD);
  const controls = dialog.locator('[data-unified-viewer-controls]');
  await expect(page.locator(SHOWN)).toBeVisible();
  await page.mouse.move(640, 400);
  await page.waitForTimeout(5000);
  await expect(controls).toHaveCSS('opacity', '1');
  await expect(card).not.toHaveAttribute('data-viewer-chrome-hidden', '');

  await dialog.getByRole('button', { name: 'Enter fullscreen' }).click();
  await expect.poll(async () => (await viewerState(page)).fullscreenElement).toBe('card');
  // The pointer rests over the image: the chrome hides after ~4 s.
  await page.mouse.move(640, 400);
  await expect(card).toHaveAttribute('data-viewer-chrome-hidden', '', { timeout: 6000 });
  await expect(controls).toHaveCSS('opacity', '0');
  // The image stays fully visible.
  await expect(page.locator(SHOWN)).toBeVisible();
  // Pointer movement reveals it.
  await page.mouse.move(600, 380);
  await expect(card).not.toHaveAttribute('data-viewer-chrome-hidden', '');
  await expect(card).toHaveAttribute('data-viewer-chrome-hidden', '', { timeout: 6000 });
  // A key reveals it; Tab focus inside the controls keeps it.
  await page.keyboard.press('Tab');
  await expect(card).not.toHaveAttribute('data-viewer-chrome-hidden', '');
  const focusedInChrome = await page.evaluate(() => Boolean(document.activeElement.closest('.app-dialog-header, [data-unified-viewer-context], [data-unified-viewer-controls]')));
  expect(focusedInChrome).toBe(true);
  await page.waitForTimeout(5500);
  await expect(card).not.toHaveAttribute('data-viewer-chrome-hidden', '');
  // An open dropdown is never hidden.
  await dialog.locator('#unified-viewer-speed-dropdown summary').click();
  await page.mouse.move(640, 300);
  await page.waitForTimeout(5500);
  await expect(card).not.toHaveAttribute('data-viewer-chrome-hidden', '');
  await expect(dialog.locator('#unified-viewer-speed-dropdown')).toHaveAttribute('open', '');
  await page.keyboard.press('Escape');
  // Leaving fullscreen returns the chrome to normal dialog visibility.
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await viewerState(page)).fullscreenElement).toBe(null);
  await expect(card).not.toHaveAttribute('data-viewer-chrome-hidden', '');
  await page.waitForTimeout(5000);
  await expect(controls).toHaveCSS('opacity', '1');
  await expect(card).not.toHaveAttribute('data-viewer-chrome-hidden', '');
});

test('a single image and an ordinary sequence show no playback controls', async ({ page }) => {
  await serveMedia(page);
  await openLibrary(page);
  await openViewer(page, THREE, { slideshow: false });
  const dialog = page.locator(DIALOG);
  await expect(page.locator(SHOWN)).toBeVisible();
  await expect(dialog.locator('[data-unified-viewer-playback]')).toBeHidden();
  await expect(dialog.getByRole('button', { name: 'Enter fullscreen' })).toBeVisible();
  await page.waitForTimeout(4500);
  await expect(dialog.locator('[data-unified-viewer-position]')).toHaveText('1 of 3');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('the playback controls fit a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 700 });
  await serveMedia(page);
  await openLibrary(page);
  await openViewer(page, THREE, { autoplay: false });
  const dialog = page.locator(DIALOG);
  await expect(page.locator(SHOWN)).toBeVisible();
  const geometry = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const box = (selector) => element.querySelector(selector).getBoundingClientRect();
    return {
      dialog: { left: rect.left, right: rect.right, bottom: rect.bottom },
      play: box('[data-unified-viewer-play]'),
      speed: box('#unified-viewer-speed-dropdown summary'),
      next: box('[data-unified-viewer-next]'),
      fullscreen: box('[data-unified-viewer-fullscreen]'),
      controlsOverflow: element.querySelector('[data-unified-viewer-controls]').scrollWidth
        - element.querySelector('[data-unified-viewer-controls]').clientWidth,
      pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  for (const control of ['play', 'speed', 'next', 'fullscreen']) {
    expect(geometry[control].left).toBeGreaterThanOrEqual(geometry.dialog.left);
    expect(geometry[control].right).toBeLessThanOrEqual(geometry.dialog.right);
    expect(geometry[control].bottom).toBeLessThanOrEqual(geometry.dialog.bottom);
    expect(geometry[control].width).toBeGreaterThan(0);
  }
  expect(geometry.controlsOverflow).toBeLessThanOrEqual(0);
  expect(geometry.pageOverflowX).toBeLessThanOrEqual(0);
  await dialog.locator('[data-unified-viewer-play]').click();
  await expect(dialog.locator('[data-unified-viewer-play]')).toHaveAccessibleName('Pause slideshow');
  await dialog.getByRole('button', { name: 'Enter fullscreen' }).click();
  await expect.poll(async () => (await viewerState(page)).fullscreenElement).toBe('card');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await viewerState(page)).fullscreenElement).toBe(null);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});
