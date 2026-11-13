import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createApp } from '../../src/app.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';

// Comic spread layout in the real viewer dialog, CSS and fullscreen.
//
// This controlled geometry harness opens the real unified
// viewer on an unavailable single item (so the content participant shows no
// media and its own viewport stays empty), then drives the production
// viewer-viewport.js and viewer-spread-layout.js modules (imported from
// /client/, not the compiled bundle) over the dialog's real media surface.
// Page images are real decoded images served by page.route.

const DIALOG = '#unified-viewer-dialog';
const MEDIA = `${DIALOG} [data-unified-viewer-media]`;

async function startApp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-comic-spread-layout-'));
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
    + `<rect width="100%" height="100%" fill="${color}"/></svg>`);
  return sharp(svg).png().toBuffer();
}

const IMAGES = {};
let fixture;
test.beforeAll(async () => {
  fixture = await startApp();
  IMAGES.portrait = { body: await makeImage(900, 1600, '#c33'), width: 900, height: 1600 };
  IMAGES.tall = { body: await makeImage(1000, 1500, '#3a3'), width: 1000, height: 1500 };
  IMAGES.landscape = { body: await makeImage(2400, 1600, '#33c'), width: 2400, height: 1600 };
  IMAGES.wide = { body: await makeImage(2000, 1000, '#cc3'), width: 2000, height: 1000 };
});
test.afterAll(async () => { await fixture?.close(); });

async function serveMedia(page) {
  const counts = new Map();
  await page.route('**/test-media/**', async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop();
    counts.set(name, (counts.get(name) || 0) + 1);
    const image = IMAGES[name];
    try {
      if (!image) await route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not found' });
      else await route.fulfill({ status: 200, contentType: 'image/png', body: image.body });
    } catch {
      // Aborted by the page.
    }
  });
  return { count: (name) => counts.get(name) || 0 };
}

async function openHarness(page) {
  const media = await serveMedia(page);
  await page.goto(`${fixture.baseURL}/assets`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(async () => {
    const viewer = await import('/client/unified-viewer.js');
    return Boolean(viewer.unifiedViewerFor(document));
  });
  await page.evaluate(async () => {
    const host = document.createElement('div');
    host.innerHTML = '<button type="button" id="test-opener">Open viewer</button>';
    document.querySelector('main').prepend(host);
    const opener = document.getElementById('test-opener');
    opener.focus();
    const { unifiedViewerFor } = await import('/client/unified-viewer.js');
    const { createViewerSource } = await import('/client/viewer-sequence.js');
    unifiedViewerFor(document).open(createViewerSource({
      key: 'spread-harness',
      mode: 'single',
      items: [{ projectId: 7, assetId: 1, title: 'Harness', mediaUrl: null, revision: 'r1' }],
    }), { opener });
  });
  await expect(page.locator(DIALOG)).toBeVisible();
  await page.evaluate(async (mediaSelector) => {
    const { createViewerViewport } = await import('/client/viewer-viewport.js');
    const spread = await import('/client/viewer-spread-layout.js');
    const surface = document.querySelector(mediaSelector);
    const layout = spread.createViewerSpreadLayout({ document });
    const viewport = createViewerViewport({ surface, view: window });
    surface.replaceChildren(layout.element);
    const images = new Map();
    window.__retries = 0;
    async function image(name) {
      if (!images.has(name)) {
        const element = document.createElement('img');
        element.className = 'unified-viewer-image';
        element.alt = name;
        element.draggable = false;
        element.src = `/test-media/${name}`;
        await element.decode();
        images.set(name, element);
      }
      return images.get(name);
    }
    // slots: [{ name, position, state? }] in visual order. 'failed' and
    // 'pending' slots show a panel instead of an image.
    window.__spread = async (slots) => {
      const described = [];
      for (const slot of slots) {
        if (slot.state === 'failed' || slot.state === 'pending') {
          described.push({ key: slot.name, position: slot.position, state: slot.state });
        } else {
          const element = await image(slot.name);
          described.push({ key: slot.name, position: slot.position, state: 'loaded', width: element.naturalWidth, height: element.naturalHeight });
        }
      }
      const result = layout.update(described);
      for (const slot of slots) {
        if (slot.state === 'failed') {
          if (layout.getSlot(slot.name).frame.querySelector('button')) continue;
          const panel = document.createElement('div');
          panel.className = 'unified-viewer-failure';
          const retry = document.createElement('button');
          retry.type = 'button';
          retry.className = 'button button-small button-secondary';
          retry.textContent = `Retry ${slot.name}`;
          retry.addEventListener('click', () => { window.__retries += 1; });
          panel.append(retry);
          layout.setSlotContent(slot.name, panel);
        } else if (slot.state === 'pending') {
          layout.setSlotContent(slot.name);
        } else if (!layout.getSlot(slot.name).frame.contains(images.get(slot.name))) {
          layout.setSlotContent(slot.name, images.get(slot.name));
        }
      }
      return { action: spread.presentViewerSpread(viewport, layout, result), change: result.change };
    };
    window.__viewport = viewport;
    window.__layout = layout;
    window.__images = images;
  }, MEDIA);
  return media;
}

const spread = (page, slots) => page.evaluate((list) => window.__spread(list), slots);
const view = (page) => page.evaluate(() => window.__viewport.getState());

// Rendered boxes (viewport coordinates) of the surface, wrapper, slots and
// images, keyed by slot key in visual left-to-right order.
const boxes = (page) => page.evaluate((mediaSelector) => {
  const rect = (element) => {
    const r = element.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  const surface = document.querySelector(mediaSelector);
  const wrapper = surface.querySelector('.unified-viewer-spread');
  const slots = Array.from(wrapper.querySelectorAll('[data-viewer-spread-slot]')).map((slot) => {
    const image = slot.querySelector('img');
    return {
      key: slot.getAttribute('data-viewer-spread-slot'),
      slot: rect(slot),
      frame: rect(slot.querySelector('[data-viewer-spread-page]')),
      image: image ? rect(image) : null,
      natural: image ? { width: image.naturalWidth, height: image.naturalHeight } : null,
    };
  }).sort((a, b) => a.slot.x - b.slot.x);
  return {
    surface: rect(surface),
    wrapper: rect(wrapper),
    transform: wrapper.style.transform,
    slots,
    composite: surface.hasAttribute('data-viewer-composite'),
    position: getComputedStyle(surface).position,
  };
}, MEDIA);

function expectInside(inner, outer, tolerance = 0.75) {
  expect(inner.x).toBeGreaterThanOrEqual(outer.x - tolerance);
  expect(inner.y).toBeGreaterThanOrEqual(outer.y - tolerance);
  expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width + tolerance);
  expect(inner.y + inner.height).toBeLessThanOrEqual(outer.y + outer.height + tolerance);
}

function expectAspect(entry) {
  expect(entry.image.width / entry.image.height).toBeCloseTo(entry.natural.width / entry.natural.height, 2);
}

// Chromium rounds percentage-positioned boxes to layout units (1/64 CSS px).
// Allow 0.25 CSS px for independently rounded edges, never a deliberate gutter.
function expectTouching(geometry) {
  if (geometry.slots.length !== 2) return;
  const [left, right] = geometry.slots;
  for (const field of ['frame', ...(left.image && right.image ? ['image'] : [])]) {
    const delta = right[field].x - (left[field].x + left[field].width);
    expect(Math.abs(delta)).toBeLessThanOrEqual(0.25);
    expect(delta).toBeGreaterThanOrEqual(-0.25);
  }
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
});

test('composes two real pages side by side, LTR and RTL, without reloading or moving them', async ({ page }) => {
  const media = await openHarness(page);
  expect(await spread(page, [{ name: 'portrait', position: 1 }, { name: 'tall', position: 2 }])).toEqual({ action: 'content', change: 'group' });
  let geometry = await boxes(page);
  expectTouching(geometry);
  expect(geometry.composite).toBe(true);
  expect(geometry.slots.map((slot) => slot.key)).toEqual(['portrait', 'tall']);
  const [left, right] = geometry.slots;
  expect(left.slot.width).toBeCloseTo(right.slot.width, 1);
  expect(left.slot.height).toBeCloseTo(right.slot.height, 1);
  expect(right.slot.x - (left.slot.x + left.slot.width)).toBeCloseTo(0, 2);
  expect(right.slot.x + right.slot.width).toBeCloseTo(geometry.wrapper.x + geometry.wrapper.width, 0);
  geometry.slots.forEach(expectAspect);

  // Zoom, pan, then reverse the direction: same pages, same transform.
  await page.evaluate(() => { window.__viewport.zoomIn(); window.__viewport.zoomIn(); window.__viewport.panBy(-60, 40); });
  const before = await view(page);
  const transform = (await boxes(page)).transform;
  const elements = await page.evaluate(() => {
    window.__marks = Array.from(window.__images.values());
    window.__slotMarks = Array.from(document.querySelectorAll('[data-viewer-spread-slot]'));
    return window.__marks.length;
  });
  expect(elements).toBe(2);
  expect(await spread(page, [{ name: 'tall', position: 2 }, { name: 'portrait', position: 1 }])).toEqual({ action: 'kept', change: 'order' });
  geometry = await boxes(page);
  expectTouching(geometry);
  expect(geometry.slots.map((slot) => slot.key)).toEqual(['tall', 'portrait']);
  expect(geometry.transform).toBe(transform);
  expect(await view(page)).toMatchObject({ scale: before.scale, panX: before.panX, panY: before.panY, mode: 'zoom' });
  expect(await page.evaluate(() => {
    const slots = Array.from(document.querySelectorAll('[data-viewer-spread-slot]'));
    return window.__marks.every((image) => image.isConnected)
      && slots.length === 2 && slots.every((slot, index) => slot === window.__slotMarks[index]);
  })).toBe(true);
  expect(media.count('portrait')).toBe(1);
  expect(media.count('tall')).toBe(1);
});

test('one Fit contains the whole spread; zoom and pan move the complete wrapper', async ({ page }) => {
  await openHarness(page);
  await spread(page, [{ name: 'portrait', position: 1 }, { name: 'landscape', position: 2 }]);
  let geometry = await boxes(page);
  expectTouching(geometry);
  expectInside(geometry.wrapper, geometry.surface);
  geometry.slots.forEach((slot) => expectInside(slot.slot, geometry.surface));
  // Centred.
  expect(geometry.wrapper.x + geometry.wrapper.width / 2).toBeCloseTo(geometry.surface.x + geometry.surface.width / 2, 0);
  expect(geometry.wrapper.y + geometry.wrapper.height / 2).toBeCloseTo(geometry.surface.y + geometry.surface.height / 2, 0);
  // Portrait + landscape keep their own aspect ratios in equal slots.
  geometry.slots.forEach(expectAspect);
  const fitRatio = geometry.slots[0].image.width / geometry.slots[1].image.width;

  await page.evaluate(() => window.__viewport.zoomIn());
  geometry = await boxes(page);
  expectTouching(geometry);
  const state = await view(page);
  // Both pages scale together by the one viewport scale.
  expect(geometry.slots[0].image.width / geometry.slots[1].image.width).toBeCloseTo(fitRatio, 3);
  expect(geometry.wrapper.width).toBeCloseTo(state.contentWidth * state.scale, 0);
  geometry.slots.forEach(expectAspect);

  await page.evaluate(() => window.__viewport.actualSize());
  const leftBefore = (await boxes(page)).slots.map((slot) => slot.image.x);
  // Pointer drag from an image (pointer-events reach the surface).
  const actual = await boxes(page);
  expectTouching(actual);
  // The visible part of a page image inside the surface.
  const visible = actual.slots.map((slot) => {
    const x1 = Math.max(slot.image.x, actual.surface.x);
    const x2 = Math.min(slot.image.x + slot.image.width, actual.surface.x + actual.surface.width - 130);
    return x2 - x1 > 20 ? { x: (x1 + x2) / 2 } : null;
  }).find(Boolean);
  expect(visible).toBeTruthy();
  const start = { x: visible.x, y: actual.surface.y + actual.surface.height / 2 };
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.matches('[data-unified-viewer-media]'), start)).toBe(true);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 120, start.y + 30, { steps: 4 });
  await page.mouse.up();
  expectTouching(await boxes(page));
  const leftAfter = (await boxes(page)).slots.map((slot) => slot.image.x);
  expect(leftAfter[0] - leftBefore[0]).toBeCloseTo(120, 0);
  expect(leftAfter[1] - leftBefore[1]).toBeCloseTo(120, 0);
  expect((await view(page)).panX).toBeCloseTo(120, 0);
});

test('a resolving companion re-fits in Fit, keeps relative zoom and re-clamps pan when zoomed; a group change resets to Fit', async ({ page }) => {
  await openHarness(page);
  // Fit: the pending companion keeps its placeholder; resolving re-fits.
  await spread(page, [{ name: 'tall', position: 1 }, { name: 'wide', position: 2, state: 'pending' }]);
  let geometry = await boxes(page);
  expectTouching(geometry);
  expect(geometry.slots[1].image).toBeNull();
  expect(geometry.slots[1].frame.width).toBeGreaterThan(0);
  expect(await spread(page, [{ name: 'tall', position: 1 }, { name: 'wide', position: 2 }])).toEqual({ action: 'resize', change: 'size' });
  geometry = await boxes(page);
  expectTouching(geometry);
  expect(await view(page)).toMatchObject({ mode: 'fit', panX: 0, panY: 0 });
  expectInside(geometry.wrapper, geometry.surface);

  // Zoomed with the pan at an edge: resolving a larger companion.
  await spread(page, [{ name: 'portrait', position: 3 }, { name: 'landscape', position: 4, state: 'pending' }]);
  expect(await view(page)).toMatchObject({ mode: 'fit', panX: 0, panY: 0 });
  await page.evaluate(() => { window.__viewport.zoomIn(); window.__viewport.zoomIn(); window.__viewport.panBy(-5000, -5000); });
  const zoomed = await view(page);
  expect(await spread(page, [{ name: 'portrait', position: 3 }, { name: 'landscape', position: 4 }])).toEqual({ action: 'resize', change: 'size' });
  const resized = await view(page);
  expect(resized.mode).toBe('zoom');
  expect(resized.scale / resized.fitScale).toBeCloseTo(zoomed.scale / zoomed.fitScale, 6);
  expect(Math.abs(resized.panX)).toBeLessThanOrEqual(resized.maxPanX + 1e-6);
  expect(Math.abs(resized.panY)).toBeLessThanOrEqual(resized.maxPanY + 1e-6);
  geometry = await boxes(page);
  expectTouching(geometry);
  // The magnified composition still covers the surface on overflowing axes.
  if (geometry.wrapper.width >= geometry.surface.width) {
    expect(geometry.wrapper.x).toBeLessThanOrEqual(geometry.surface.x + 0.5);
    expect(geometry.wrapper.x + geometry.wrapper.width).toBeGreaterThanOrEqual(geometry.surface.x + geometry.surface.width - 0.5);
  }

  // Navigation to another group: Fit, centred, valid pan bounds.
  expect(await spread(page, [{ name: 'wide', position: 5 }])).toEqual({ action: 'content', change: 'group' });
  expect(await view(page)).toMatchObject({ mode: 'fit', panX: 0, panY: 0, canPan: false });
});

test('a one-page group is centred with no reserved second slot', async ({ page }) => {
  await openHarness(page);
  await spread(page, [{ name: 'portrait', position: 7 }]);
  const geometry = await boxes(page);
  expectTouching(geometry);
  expect(geometry.slots).toHaveLength(1);
  expect(geometry.wrapper.width).toBeCloseTo(geometry.slots[0].image.width, 0);
  expect(geometry.wrapper.x + geometry.wrapper.width / 2).toBeCloseTo(geometry.surface.x + geometry.surface.width / 2, 0);
  expect(geometry.wrapper.y + geometry.wrapper.height / 2).toBeCloseTo(geometry.surface.y + geometry.surface.height / 2, 0);
  expectAspect(geometry.slots[0]);
});

test('a per-page Retry is clickable and keyboard accessible and never starts a pan', async ({ page }) => {
  await openHarness(page);
  await spread(page, [{ name: 'portrait', position: 1 }, { name: 'broken', position: 2, state: 'failed' }]);
  // Even while the shell reports a loading/failed state, the composite keeps
  // its absolute pan surface.
  await page.evaluate(() => document.querySelector('[data-unified-viewer]').setAttribute('data-viewer-media-state', 'failed'));
  expect((await boxes(page)).position).toBe('absolute');
  await page.evaluate(() => window.__viewport.actualSize());
  const before = await view(page);
  expect(before.canPan).toBe(true);
  const retry = page.locator(MEDIA).getByRole('button', { name: 'Retry broken' });
  await expect(retry).toBeVisible();
  const box = await retry.boundingBox();
  // A press-and-drag on Retry neither pans nor captures the pointer.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  expect(await page.evaluate(() => window.__viewport.getState().dragging)).toBe(false);
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2, { steps: 3 });
  await page.mouse.up();
  expect((await view(page)).panX).toBe(before.panX);
  await retry.click();
  expect(await page.evaluate(() => window.__retries)).toBe(1);
  await retry.focus();
  await expect(retry).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  expect(await page.evaluate(() => window.__retries)).toBe(3);

  // Reversing the direction swaps the slots without moving the focused
  // Retry in the DOM: focus and the transform are kept.
  const transform = (await boxes(page)).transform;
  expect(await spread(page, [{ name: 'broken', position: 2, state: 'failed' }, { name: 'portrait', position: 1 }])).toEqual({ action: 'kept', change: 'order' });
  await expect(retry).toBeFocused();
  expect((await boxes(page)).transform).toBe(transform);
  expect((await boxes(page)).slots.map((slot) => slot.key)).toEqual(['broken', 'portrait']);

  // Panning from the noninteractive slot background still works.
  const background = (await boxes(page)).slots.find((slot) => slot.key === 'broken').slot;
  const startPan = (await view(page)).panX;
  const point = { x: background.x + 6, y: background.y + 6 };
  const surface = (await boxes(page)).surface;
  const x = Math.min(Math.max(point.x, surface.x + 6), surface.x + surface.width - 100);
  const y = Math.min(Math.max(point.y, surface.y + 6), surface.y + surface.height - 6);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 50, y, { steps: 3 });
  await page.mouse.up();
  expect((await view(page)).panX).not.toBe(startPan);

  // Escape still closes the dialog.
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();
});

test('fullscreen and window resizes recalculate the shared geometry', async ({ page }) => {
  await openHarness(page);
  await spread(page, [{ name: 'portrait', position: 1 }, { name: 'landscape', position: 2 }]);
  const windowed = await view(page);
  await page.locator(DIALOG).getByRole('button', { name: 'Enter fullscreen' }).click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement?.matches('[data-unified-viewer-card]')))).toBe(true);
  await expect.poll(async () => (await view(page)).viewportWidth).not.toBe(windowed.viewportWidth);
  let geometry = await boxes(page);
  expectTouching(geometry);
  expectInside(geometry.wrapper, geometry.surface);
  expect((await view(page)).mode).toBe('fit');
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBe(null);
  await expect.poll(async () => (await view(page)).viewportWidth).toBe(windowed.viewportWidth);

  // A narrow window: still contained, and the dialog controls stay on screen.
  await page.setViewportSize({ width: 420, height: 760 });
  await expect.poll(async () => (await view(page)).viewportWidth).toBeLessThan(windowed.viewportWidth);
  geometry = await boxes(page);
  expectTouching(geometry);
  expectInside(geometry.wrapper, geometry.surface);
  geometry.slots.forEach(expectAspect);
  const close = await page.locator(DIALOG).getByRole('button', { name: /close/i }).first().boundingBox();
  expect(close.x + close.width).toBeLessThanOrEqual(420 + 0.5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(420);
});

test('the existing single-image viewer is unchanged', async ({ page }) => {
  await serveMedia(page);
  await page.goto(`${fixture.baseURL}/assets`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(async () => {
    const viewer = await import('/client/unified-viewer.js');
    return Boolean(viewer.unifiedViewerFor(document));
  });
  await page.evaluate(async () => {
    const host = document.createElement('div');
    host.innerHTML = '<button type="button" id="test-opener">Open viewer</button>';
    document.querySelector('main').prepend(host);
    const opener = document.getElementById('test-opener');
    opener.focus();
    const { unifiedViewerFor } = await import('/client/unified-viewer.js');
    const { createViewerSource } = await import('/client/viewer-sequence.js');
    unifiedViewerFor(document).open(createViewerSource({
      key: 'single',
      mode: 'single',
      items: [{ projectId: 7, assetId: 2, title: 'Wide', mediaUrl: '/test-media/landscape', revision: 'r1' }],
    }), { opener });
  });
  const image = page.locator(`${MEDIA} img.unified-viewer-image`);
  await expect(image).toBeVisible();
  const geometry = await page.evaluate((mediaSelector) => {
    const surface = document.querySelector(mediaSelector);
    const img = surface.querySelector('img');
    const s = surface.getBoundingClientRect();
    const r = img.getBoundingClientRect();
    return {
      surface: { x: s.x, y: s.y, width: s.width, height: s.height },
      image: { x: r.x, y: r.y, width: r.width, height: r.height },
      composite: surface.hasAttribute('data-viewer-composite'),
      spread: Boolean(surface.querySelector('.unified-viewer-spread')),
    };
  }, MEDIA);
  expect(geometry).toMatchObject({ composite: false, spread: false });
  expectInside(geometry.image, geometry.surface);
  expect(geometry.image.width / geometry.image.height).toBeCloseTo(2400 / 1600, 2);
  await page.locator(DIALOG).getByRole('button', { name: 'Zoom in' }).click();
  await expect(page.locator(`${DIALOG} [data-unified-viewer-zoom-level]`)).not.toHaveText('Fit');
  await page.locator(DIALOG).getByRole('button', { name: 'Fit to viewer' }).click();
  await expect(page.locator(`${DIALOG} [data-unified-viewer-zoom-level]`)).toHaveText('Fit');
});
