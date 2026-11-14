import { describe, expect, it, vi } from 'vitest';
import {
  clampViewerPan,
  computeFitScale,
  computePanLimits,
  createViewerViewport,
  nextViewerZoomScale,
  VIEWER_MAX_ZOOM,
  VIEWER_TOUCH_NONE,
  VIEWER_TOUCH_PAN,
  VIEWER_TOUCH_PINCH,
  VIEWER_TOUCH_TRACKING,
  VIEWER_ZOOM_STEP,
  classifyViewerTouch,
  computeViewerEdgeZone,
  computeViewerSwipeDistance,
  VIEWER_CLICK_GUARD_RADIUS,
  VIEWER_CLICK_GUARD_WINDOW,
  VIEWER_TOUCH_TAP_MAX_DURATION,
  VIEWER_TOUCH_TAP_SLOP,
} from '../src/static/client/viewer-viewport.js';

// B3: viewport geometry. Pure functions plus the controller against a tiny
// surface stand-in; real layout and pointer capture are covered in Chromium
// (tests/browser/unified-viewer-media.spec.js).

function makeSurface(width = 1000, height = 800) {
  const attributes = new Map();
  const listeners = [];
  const surface = {
    clientWidth: width,
    clientHeight: height,
    captured: new Set(),
    listeners,
    setAttribute(name, value) { attributes.set(name, String(value)); },
    removeAttribute(name) { attributes.delete(name); },
    hasAttribute(name) { return attributes.has(name); },
    addEventListener(type, handler) { listeners.push({ type, handler }); },
    removeEventListener(type, handler) {
      const index = listeners.findIndex((entry) => entry.type === type && entry.handler === handler);
      if (index >= 0) listeners.splice(index, 1);
    },
    setPointerCapture: vi.fn((id) => surface.captured.add(id)),
    releasePointerCapture: vi.fn((id) => surface.captured.delete(id)),
    hasPointerCapture: (id) => surface.captured.has(id),
    fire(type, props = {}) {
      const event = {
        type,
        pointerId: 1,
        pointerType: 'mouse',
        button: 0,
        isPrimary: true,
        clientX: 0,
        clientY: 0,
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
        ...props,
      };
      listeners.filter((entry) => entry.type === type).forEach((entry) => entry.handler(event));
      return event;
    },
  };
  return surface;
}

function makeContent() {
  return { style: { width: '', height: '', transform: '' } };
}

function setup({ width = 1000, height = 800, content = { width: 2000, height: 1000 }, view = null } = {}) {
  const surface = makeSurface(width, height);
  const onChange = vi.fn();
  const viewport = createViewerViewport({ surface, view, onChange });
  const element = makeContent();
  viewport.setContent(element, content);
  return { surface, onChange, viewport, element };
}

describe('viewer viewport geometry', () => {
  it('fits a landscape image to the width, preserving aspect ratio', () => {
    const scale = computeFitScale({ width: 4000, height: 2000 }, { width: 1000, height: 800 });
    expect(scale).toBe(0.25);
    expect(4000 * scale).toBe(1000);
    expect(2000 * scale).toBe(500);
  });

  it('fits a portrait image to the height, preserving aspect ratio', () => {
    const scale = computeFitScale({ width: 1500, height: 3000 }, { width: 1000, height: 800 });
    expect(scale).toBeCloseTo(800 / 3000);
    expect(1500 * scale).toBeCloseTo(400);
    expect(3000 * scale).toBeCloseTo(800);
  });

  it('never upscales a small image and centres it', () => {
    const { viewport, element } = setup({ content: { width: 200, height: 100 } });
    expect(viewport.getState()).toMatchObject({ scale: 1, fitScale: 1, mode: 'fit', canPan: false });
    expect(element.style.width).toBe('200px');
    expect(element.style.height).toBe('100px');
    expect(element.style.transform).toBe('translate(-100px, -50px)');
  });

  it('fits a large image entirely inside the surface', () => {
    const { viewport, element } = setup({ content: { width: 8000, height: 6000 } });
    const state = viewport.getState();
    expect(state.scale).toBeCloseTo(0.125);
    expect(parseFloat(element.style.width)).toBeLessThanOrEqual(1000);
    expect(parseFloat(element.style.height)).toBeLessThanOrEqual(800);
    expect(state.canPan).toBe(false);
  });

  it('degrades to safe values for unmeasured or invalid sizes', () => {
    expect(computeFitScale({ width: 0, height: 10 }, { width: 100, height: 100 })).toBe(1);
    expect(computeFitScale({ width: 10, height: 10 }, { width: 0, height: 0 })).toBe(1);
    expect(computePanLimits({ width: 10, height: 10 }, Number.NaN, { width: 5, height: 5 })).toEqual({ x: 0, y: 0 });
    expect(clampViewerPan({ x: Number.NaN, y: Infinity }, { x: 10, y: 10 })).toEqual({ x: 0, y: 0 });
    expect(clampViewerPan({ x: -50, y: 50 }, { x: 10, y: 10 })).toEqual({ x: -10, y: 10 });
    const surface = makeSurface();
    const viewport = createViewerViewport({ surface });
    expect(viewport.setContent(makeContent(), { width: 0, height: 100 })).toBe(false);
    expect(viewport.getState().hasContent).toBe(false);
    expect(viewport.zoomIn()).toBe(false);
  });
});

describe('viewer viewport zoom', () => {
  it('steps by a fixed factor, lands on 1:1 and stays within finite bounds', () => {
    expect(nextViewerZoomScale(0.5, 'in', { fitScale: 0.5, maxScale: 8 })).toBe(0.75);
    expect(nextViewerZoomScale(0.75, 'in', { fitScale: 0.5, maxScale: 8 })).toBe(1);
    expect(nextViewerZoomScale(1, 'in', { fitScale: 0.5, maxScale: 8 })).toBe(VIEWER_ZOOM_STEP);
    expect(nextViewerZoomScale(7, 'in', { fitScale: 0.5, maxScale: 8 })).toBe(8);
    expect(nextViewerZoomScale(1.2, 'out', { fitScale: 0.5, maxScale: 8 })).toBe(1);
    expect(nextViewerZoomScale(0.6, 'out', { fitScale: 0.5, maxScale: 8 })).toBe(0.5);
    expect(nextViewerZoomScale(Number.NaN, 'in', { fitScale: Number.NaN, maxScale: -1 })).toBe(1);
  });

  it('disables controls exactly at the zoom limits', () => {
    const { viewport } = setup();
    expect(viewport.getState()).toMatchObject({ scale: 0.5, canZoomOut: false, canZoomIn: true, canFit: false });
    let guard = 0;
    while (viewport.getState().canZoomIn && guard < 50) {
      viewport.zoomIn();
      guard += 1;
    }
    const state = viewport.getState();
    expect(state.scale).toBe(VIEWER_MAX_ZOOM);
    expect(state.canZoomIn).toBe(false);
    expect(viewport.zoomIn()).toBe(true);
    expect(viewport.getState().scale).toBe(VIEWER_MAX_ZOOM);
    viewport.fit();
    expect(viewport.getState()).toMatchObject({ scale: 0.5, mode: 'fit', panX: 0, panY: 0, canZoomOut: false });
    viewport.zoomOut();
    expect(viewport.getState().scale).toBe(0.5);
    expect(Number.isFinite(viewport.getState().scale)).toBe(true);
  });

  it('keeps the surface centre fixed while zooming and clamps the pan', () => {
    const { viewport } = setup();
    viewport.actualSize();
    expect(viewport.getState()).toMatchObject({ scale: 1, maxPanX: 500, maxPanY: 100 });
    viewport.panBy(200, 50);
    viewport.zoomIn();
    expect(viewport.getState()).toMatchObject({ scale: 1.5, panX: 300, panY: 75 });
    viewport.zoomOut();
    expect(viewport.getState()).toMatchObject({ scale: 1, panX: 200, panY: 50 });
  });

  it('starts new content in Fit (or at a requested scale) with no pan', () => {
    const { viewport, element } = setup();
    viewport.zoomIn();
    viewport.panBy(-100, 0);
    viewport.setContent(element, { width: 600, height: 1200 });
    expect(viewport.getState()).toMatchObject({ mode: 'fit', panX: 0, panY: 0, contentWidth: 600 });
    viewport.setContent(element, { width: 3000, height: 2000 }, { scale: 1 });
    expect(viewport.getState()).toMatchObject({ mode: 'zoom', scale: 1, contentWidth: 3000, contentHeight: 2000 });
  });
});

describe('viewer viewport pan', () => {
  it('drags within the image bounds with pointer capture', () => {
    const { viewport, surface, element } = setup();
    // At Fit nothing can move and the press is left alone.
    expect(surface.fire('pointerdown').defaultPrevented).toBe(false);
    viewport.actualSize();
    expect(surface.hasAttribute('data-viewer-pannable')).toBe(true);
    const down = surface.fire('pointerdown', { clientX: 100, clientY: 100 });
    expect(down.defaultPrevented).toBe(true);
    expect(surface.setPointerCapture).toHaveBeenCalledWith(1);
    expect(surface.hasAttribute('data-viewer-dragging')).toBe(true);
    surface.fire('pointermove', { clientX: 5000, clientY: -5000 });
    expect(viewport.getState()).toMatchObject({ panX: 500, panY: -100 });
    expect(element.style.transform).toBe('translate(-500px, -600px)');
    // Another pointer is ignored.
    surface.fire('pointermove', { pointerId: 2, clientX: 0, clientY: 0 });
    expect(viewport.getState().panX).toBe(500);
    surface.fire('pointerup', { clientX: 0, clientY: 0 });
    expect(surface.releasePointerCapture).toHaveBeenCalledWith(1);
    expect(surface.hasAttribute('data-viewer-dragging')).toBe(false);
    surface.fire('pointermove', { clientX: 0, clientY: 0 });
    expect(viewport.getState().panX).toBe(500);
  });

  it('ends the drag on cancel or lost capture and ignores secondary buttons', () => {
    const { viewport, surface } = setup();
    viewport.actualSize();
    surface.fire('pointerdown', { clientX: 0 });
    surface.fire('pointercancel');
    expect(viewport.getState().dragging).toBe(false);
    surface.fire('pointerdown', { clientX: 0 });
    surface.captured.clear();
    surface.fire('lostpointercapture');
    expect(viewport.getState().dragging).toBe(false);
    surface.fire('pointermove', { clientX: 300 });
    expect(viewport.getState().panX).toBe(0);

    expect(surface.fire('pointerdown', { button: 2 }).defaultPrevented).toBe(false);
    expect(viewport.getState().dragging).toBe(false);
    // A pen drags like a mouse.
    expect(surface.fire('pointerdown', { pointerType: 'pen', pointerId: 9 }).defaultPrevented).toBe(true);
    viewport.clearContent();
    expect(viewport.getState().dragging).toBe(false);
    expect(surface.captured.has(9)).toBe(false);
  });

  it('pans by keyboard steps only while magnified', () => {
    const { viewport } = setup();
    expect(viewport.panBy(48, 0)).toBe(false);
    viewport.actualSize();
    expect(viewport.panBy(48, 0)).toBe(true);
    expect(viewport.getState().panX).toBe(48);
    expect(viewport.panBy(0, 1000)).toBe(true);
    expect(viewport.getState().panY).toBe(100);
    expect(viewport.panBy(0, 1)).toBe(false);
  });

  it('re-fits and re-clamps on resize, observing only while content is shown', () => {
    const observers = [];
    class FakeResizeObserver {
      constructor(callback) { this.callback = callback; this.disconnect = vi.fn(); observers.push(this); }
      observe(target) { this.target = target; }
    }
    const { viewport, surface } = setup({ view: { ResizeObserver: FakeResizeObserver } });
    expect(observers).toHaveLength(1);
    surface.clientWidth = 500;
    observers[0].callback();
    expect(viewport.getState().scale).toBe(0.25);

    viewport.actualSize();
    viewport.panBy(-750, -100);
    expect(viewport.getState()).toMatchObject({ panX: -750, panY: -100 });
    surface.clientWidth = 1800;
    surface.clientHeight = 1000;
    observers[0].callback();
    expect(viewport.getState()).toMatchObject({ scale: 1, panX: -100, panY: 0 });

    viewport.clearContent();
    expect(observers[0].disconnect).toHaveBeenCalled();
  });

  it('falls back to window resize and removes every listener on destroy', () => {
    const view = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const { viewport, surface } = setup({ view });
    expect(view.addEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(surface.listeners.length).toBeGreaterThan(0);
    viewport.destroy();
    expect(view.removeEventListener).toHaveBeenCalledWith('resize', view.addEventListener.mock.calls[0][1]);
    expect(surface.listeners).toHaveLength(0);
  });
});

// ─── C1d: composite content (comic spreads) ──────────────────────────────────

describe('viewer viewport composite content', () => {
  function composite(size = { width: 2040, height: 1500 }, options = {}) {
    const surface = makeSurface(1000, 800);
    const onChange = vi.fn();
    const viewport = createViewerViewport({ surface, onChange, ...options });
    const element = makeContent();
    viewport.setContent(element, size, { composite: true });
    return { surface, onChange, viewport, element };
  }

  it('leaves ordinary image content exactly as before', () => {
    const { viewport, surface, element } = setup();
    expect(viewport.getState()).toMatchObject({ composite: false, scale: 0.5, mode: 'fit' });
    expect(surface.hasAttribute('data-viewer-composite')).toBe(false);
    expect(element.style).toEqual({ width: '1000px', height: '500px', transform: 'translate(-500px, -250px)' });
    viewport.zoomIn();
    expect(viewport.getState().scale).toBe(0.75);
  });

  it('fits a single-page and a two-page composition as one content element', () => {
    const single = composite({ width: 1000, height: 1500 });
    expect(single.viewport.getState()).toMatchObject({ composite: true, mode: 'fit', panX: 0, panY: 0 });
    expect(single.viewport.getState().scale).toBeCloseTo(800 / 1500);
    expect(single.surface.hasAttribute('data-viewer-composite')).toBe(true);

    const spread = composite();
    const state = spread.viewport.getState();
    expect(state.scale).toBeCloseTo(1000 / 2040);
    // The whole composition, gutter included, is inside the surface.
    expect(parseFloat(spread.element.style.width)).toBeLessThanOrEqual(1000);
    expect(parseFloat(spread.element.style.height)).toBeLessThanOrEqual(800);
    expect(state.canPan).toBe(false);
  });

  it('re-fits and re-centres when a companion page resolves in Fit', () => {
    const { viewport, element, onChange } = composite({ width: 1000, height: 1500 });
    onChange.mockClear();
    expect(viewport.resizeContent({ width: 2020, height: 1500 })).toBe(true);
    const state = viewport.getState();
    expect(state).toMatchObject({ mode: 'fit', panX: 0, panY: 0, contentWidth: 2020 });
    expect(state.scale).toBeCloseTo(1000 / 2020);
    expect(element.style.transform).toBe(`translate(${-1000 / 2}px, ${-(1500 * state.scale) / 2}px)`);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ contentWidth: 2020 }), 'content-size');
  });

  it('keeps zoom relative to Fit and re-clamps the pan when the composition changes size while zoomed', () => {
    const { viewport } = composite({ width: 1000, height: 1500 });
    viewport.zoomIn();
    viewport.zoomIn();
    viewport.panBy(0, -10000);
    const before = viewport.getState();
    expect(before.mode).toBe('zoom');
    const relative = before.scale / before.fitScale;
    viewport.resizeContent({ width: 2020, height: 1500 });
    const after = viewport.getState();
    expect(after.mode).toBe('zoom');
    expect(after.scale / after.fitScale).toBeCloseTo(relative, 9);
    expect(Math.abs(after.panX)).toBeLessThanOrEqual(after.maxPanX);
    expect(Math.abs(after.panY)).toBeLessThanOrEqual(after.maxPanY);
    // The pan stays proportionally where it was rather than jumping.
    expect(after.panY).toBeCloseTo(Math.max(-after.maxPanY, before.panY * (after.scale / before.scale)), 6);

    // A shrink that leaves no overflow re-clamps the pan to the centre.
    viewport.panBy(-10000, 0);
    viewport.resizeContent({ width: 100, height: 150 });
    const shrunk = viewport.getState();
    expect(Math.abs(shrunk.panX)).toBeLessThanOrEqual(shrunk.maxPanX);
    expect(Math.abs(shrunk.panY)).toBeLessThanOrEqual(shrunk.maxPanY);
    expect(Number.isFinite(shrunk.scale)).toBe(true);
  });

  it('treats an unchanged or invalid size as a no-op that keeps zoom and pan', () => {
    const { viewport, onChange, element } = composite();
    viewport.zoomIn();
    viewport.zoomIn();
    viewport.panBy(30, 20);
    const before = viewport.getState();
    const transform = element.style.transform;
    onChange.mockClear();
    expect(viewport.resizeContent({ width: 2040, height: 1500 })).toBe(false);
    expect(viewport.resizeContent({ width: Number.NaN, height: 10 })).toBe(false);
    expect(viewport.resizeContent(null)).toBe(false);
    expect(viewport.getState()).toEqual(before);
    expect(element.style.transform).toBe(transform);
    expect(onChange).not.toHaveBeenCalled();
    viewport.clearContent();
    expect(viewport.resizeContent({ width: 10, height: 10 })).toBe(false);
  });

  it('resets a new composition (group change) to Fit and centred', () => {
    const { viewport, element, surface } = composite();
    viewport.zoomIn();
    viewport.zoomIn();
    viewport.panBy(-200, 100);
    expect(viewport.isContent(element)).toBe(true);
    viewport.setContent(element, { width: 1000, height: 1500 }, { composite: true });
    expect(viewport.getState()).toMatchObject({ mode: 'fit', panX: 0, panY: 0, composite: true });
    // Replacing a composite with an ordinary image drops the composite mark.
    const image = makeContent();
    viewport.setContent(image, { width: 400, height: 300 });
    expect(viewport.isContent(element)).toBe(false);
    expect(viewport.isContent(image)).toBe(true);
    expect(surface.hasAttribute('data-viewer-composite')).toBe(false);
    expect(viewport.getState().composite).toBe(false);
  });

  it('continues a drag from the adjusted pan when the size changes mid-drag', () => {
    const { viewport, surface } = composite({ width: 1000, height: 1500 });
    viewport.actualSize();
    surface.fire('pointerdown', { clientX: 0, clientY: 0 });
    surface.fire('pointermove', { clientX: 0, clientY: 100 });
    expect(viewport.getState().panY).toBe(100);
    viewport.resizeContent({ width: 2020, height: 1500 });
    const pan = viewport.getState().panY;
    surface.fire('pointermove', { clientX: 0, clientY: 110 });
    expect(viewport.getState().panY).toBeCloseTo(Math.min(pan + 10, viewport.getState().maxPanY), 6);
    surface.fire('pointerup');
  });

  it('re-fits a composition on resize (fullscreen or a narrow window)', () => {
    const observers = [];
    class FakeResizeObserver {
      constructor(callback) { this.callback = callback; this.disconnect = vi.fn(); observers.push(this); }
      observe(target) { this.target = target; }
    }
    const { viewport, surface, element } = composite(undefined, { view: { ResizeObserver: FakeResizeObserver } });
    surface.clientWidth = 1920;
    surface.clientHeight = 1080;
    observers[0].callback();
    expect(viewport.getState().scale).toBeCloseTo(Math.min(1920 / 2040, 1080 / 1500));
    surface.clientWidth = 320;
    surface.clientHeight = 480;
    viewport.refresh();
    const narrow = viewport.getState();
    expect(narrow.scale).toBeCloseTo(320 / 2040);
    expect(parseFloat(element.style.width)).toBeLessThanOrEqual(320 + 1e-9);
    expect(narrow.canPan).toBe(false);
    viewport.clearContent();
    expect(observers[0].disconnect).toHaveBeenCalled();
  });
});

describe('viewer viewport interactive descendants', () => {
  // A minimal element tree: closest() walks parents to an interactive node.
  function node(name, parent = null, interactive = false) {
    return {
      name,
      parent,
      interactive,
      closest(selector) {
        expect(typeof selector).toBe('string');
        let current = this;
        while (current) {
          if (current.interactive) return current;
          current = current.parent;
        }
        return null;
      },
    };
  }

  function zoomedComposite() {
    const surface = makeSurface(1000, 800);
    // An interactive ancestor outside the surface must not block panning.
    const dialog = node('dialog', null, true);
    surface.parent = dialog;
    surface.interactive = false;
    surface.closest = node('surface', dialog).closest;
    surface.contains = (candidate) => {
      let current = candidate;
      while (current) {
        if (current === surface) return true;
        current = current.parent;
      }
      return false;
    };
    const wrapper = node('wrapper', surface);
    const slot = node('slot', wrapper);
    const retry = node('retry', slot, true);
    const label = node('label', retry);
    const viewport = createViewerViewport({ surface });
    viewport.setContent({ style: {} }, { width: 2040, height: 1500 }, { composite: true });
    viewport.actualSize();
    return { surface, viewport, slot, retry, label, wrapper, dialog };
  }

  it('never starts a pan from a Retry button or anything inside it', () => {
    const { surface, viewport, retry, label } = zoomedComposite();
    for (const target of [retry, label]) {
      const down = surface.fire('pointerdown', { target });
      expect(down.defaultPrevented).toBe(false);
      expect(viewport.getState().dragging).toBe(false);
      expect(surface.setPointerCapture).not.toHaveBeenCalled();
    }
  });

  it('pans from the surface, the wrapper and the noninteractive slot background', () => {
    const { surface, viewport, slot, wrapper } = zoomedComposite();
    for (const target of [surface, wrapper, slot, undefined]) {
      const down = surface.fire('pointerdown', { target, clientX: 0, clientY: 0 });
      expect(down.defaultPrevented).toBe(true);
      expect(viewport.getState().dragging).toBe(true);
      surface.fire('pointermove', { clientX: -20, clientY: 0 });
      surface.fire('pointerup');
      expect(viewport.getState().dragging).toBe(false);
    }
    expect(viewport.getState().panX).toBe(-80);
  });

  it('keeps keyboard panning independent of pointer targets', () => {
    const { viewport } = zoomedComposite();
    expect(viewport.panBy(48, 0)).toBe(true);
    expect(viewport.getState().panX).toBe(48);
  });

  it('removes every listener, including on a composite, on destroy', () => {
    const { surface, viewport } = zoomedComposite();
    viewport.destroy();
    expect(surface.listeners).toHaveLength(0);
    expect(surface.hasAttribute('data-viewer-composite')).toBe(false);
  });
});


describe('rendition replacement geometry', () => {
  it('keeps Fit and Actual Size as separate scale intentions', () => {
    const { viewport } = setup();
    viewport.replaceContent(makeContent(), { width: 6000, height: 3000 });
    expect(viewport.getState()).toMatchObject({ mode: 'fit', scale: 1 / 6 });
    viewport.actualSize();
    viewport.replaceContent(makeContent(), { width: 3000, height: 1500 });
    expect(viewport.getState().scale).toBe(1);
    viewport.destroy();
  });

  it.each([{ width: 6000, height: 3000 }, { width: 3000, height: 6000 }, { width: 20, height: 9000 }])('preserves relative zoom and normalized focal point with safe clamping for %j', (size) => {
    const { viewport } = setup();
    viewport.zoomIn(); viewport.zoomIn(); viewport.panBy(150, 75);
    const before = viewport.getState();
    viewport.replaceContent(makeContent(), size);
    const after = viewport.getState();
    expect(after.scale / after.fitScale).toBeCloseTo(before.scale / before.fitScale);
    const expectedX = before.panX / (before.contentWidth * before.scale) * size.width * after.scale;
    const expectedY = before.panY / (before.contentHeight * before.scale) * size.height * after.scale;
    expect(after.panX).toBeCloseTo(Math.max(-after.maxPanX, Math.min(after.maxPanX, expectedX)));
    expect(after.panY).toBeCloseTo(Math.max(-after.maxPanY, Math.min(after.maxPanY, expectedY)));
    expect(Number.isFinite(after.scale)).toBe(true);
    viewport.destroy();
  });

  it('rejects invalid replacement geometry without discarding the usable image', () => {
    const { viewport } = setup(); const before = viewport.getState();
    expect(viewport.replaceContent(makeContent(), { width: Infinity, height: 0 })).toBe(false);
    expect(viewport.getState()).toEqual(before);
    viewport.destroy();
  });
});

// ─── D1-A: touch pinch-to-zoom and pan ───────────────────────────────────────

describe('viewer viewport touch', () => {
  // The surface sits at (100, 50) in client space, so its centre is (600, 450).
  const CX = 600;
  const CY = 450;

  function touchSetup({ content = { width: 2000, height: 1000 }, composite = false, view = null } = {}) {
    const surface = makeSurface(1000, 800);
    surface.getBoundingClientRect = () => ({ left: 100, top: 50, width: surface.clientWidth, height: surface.clientHeight });
    const onChange = vi.fn();
    const viewport = createViewerViewport({ surface, view, onChange });
    const element = makeContent();
    viewport.setContent(element, content, { composite });
    const touch = {
      down: (pointerId, clientX, clientY, extra = {}) => surface.fire('pointerdown', {
        pointerId, pointerType: 'touch', isPrimary: false, clientX, clientY, ...extra,
      }),
      move: (pointerId, clientX, clientY) => surface.fire('pointermove', { pointerId, pointerType: 'touch', clientX, clientY }),
      up: (pointerId, clientX = 0, clientY = 0) => surface.fire('pointerup', { pointerId, pointerType: 'touch', clientX, clientY }),
      cancel: (pointerId) => surface.fire('pointercancel', { pointerId, pointerType: 'touch' }),
      lost: (pointerId) => surface.fire('lostpointercapture', { pointerId, pointerType: 'touch' }),
    };
    return { surface, onChange, viewport, element, touch };
  }

  // The content point (intrinsic px from its centre) under a client point.
  function contentPoint(state, x, y) {
    return { x: (x - CX - state.panX) / state.scale, y: (y - CY - state.panY) / state.scale };
  }

  function expectValidTransform(element, state) {
    for (const value of [state.scale, state.panX, state.panY]) expect(Number.isFinite(value)).toBe(true);
    expect(state.scale).toBeGreaterThan(0);
    expect(state.scale).toBeGreaterThanOrEqual(state.fitScale - 1e-9);
    expect(state.scale).toBeLessThanOrEqual(state.maxScale + 1e-9);
    expect(Math.abs(state.panX)).toBeLessThanOrEqual(state.maxPanX + 1e-9);
    expect(Math.abs(state.panY)).toBeLessThanOrEqual(state.maxPanY + 1e-9);
    const css = `${element.style.width} ${element.style.height} ${element.style.transform}`;
    expect(css.includes('NaN') || css.includes('Infinity')).toBe(false);
    expect(parseFloat(element.style.width)).toBeGreaterThan(0);
    expect(parseFloat(element.style.height)).toBeGreaterThan(0);
  }

  it('pans an enlarged image with one finger, bounded, without capturing the pointer', () => {
    const { viewport, surface, element, touch, onChange } = touchSetup();
    viewport.actualSize();
    expect(viewport.getState()).toMatchObject({ scale: 1, maxPanX: 500, maxPanY: 100 });
    onChange.mockClear();
    const down = touch.down(41, CX, CY, { isPrimary: true });
    expect(down.defaultPrevented).toBe(true);
    expect(viewport.getState()).toMatchObject({ touchGesture: VIEWER_TOUCH_PAN, touchContacts: 1, dragging: true });
    expect(surface.hasAttribute('data-viewer-dragging')).toBe(true);
    expect(touch.move(41, CX + 100, CY + 30).defaultPrevented).toBe(true);
    expect(viewport.getState()).toMatchObject({ panX: 100, panY: 30 });
    expect(element.style.transform).toBe('translate(-900px, -470px)');
    // Far outside the viewer (implicit touch capture keeps delivering): clamped, never overscrolled.
    touch.move(41, CX + 5000, CY - 5000);
    expect(viewport.getState()).toMatchObject({ panX: 500, panY: -100 });
    touch.move(41, CX - 5000, CY + 5000);
    expect(viewport.getState()).toMatchObject({ panX: -500, panY: 100 });
    expect(onChange).not.toHaveBeenCalled();
    touch.up(41);
    expect(viewport.getState()).toMatchObject({ touchGesture: VIEWER_TOUCH_NONE, touchContacts: 0, dragging: false });
    expect(surface.hasAttribute('data-viewer-dragging')).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ panX: -500 }), 'pan');
    expect(surface.setPointerCapture).not.toHaveBeenCalled();
    expect(surface.releasePointerCapture).not.toHaveBeenCalled();
  });

  it('never pans a fitted image with one finger and leaves the press to the browser', () => {
    const { viewport, element, touch, onChange } = touchSetup();
    const transform = element.style.transform;
    onChange.mockClear();
    const down = touch.down(5, CX, CY, { isPrimary: true });
    expect(down.defaultPrevented).toBe(false);
    expect(viewport.getState()).toMatchObject({ touchGesture: VIEWER_TOUCH_TRACKING, touchContacts: 1, dragging: false });
    expect(touch.move(5, CX + 300, CY + 200).defaultPrevented).toBe(false);
    expect(viewport.getState()).toMatchObject({ mode: 'fit', scale: 0.5, panX: 0, panY: 0 });
    expect(element.style.transform).toBe(transform);
    touch.up(5, CX + 300, CY + 200);
    expect(viewport.getState()).toMatchObject({ touchGesture: VIEWER_TOUCH_NONE, touchContacts: 0 });
    // Neither a pan nor a zoom is reported, and nothing navigates (the viewport has no navigation).
    expect(onChange).not.toHaveBeenCalled();
  });

  it('pinches from Fit through the existing scale model and reports the zoom once at the end', () => {
    const { viewport, touch, onChange, element, surface } = touchSetup();
    onChange.mockClear();
    touch.down(1, CX - 100, CY, { isPrimary: true });
    const second = touch.down(2, CX + 100, CY);
    expect(second.defaultPrevented).toBe(true);
    expect(viewport.getState()).toMatchObject({ touchGesture: VIEWER_TOUCH_PINCH, touchContacts: 2, scale: 0.5, dragging: true });
    touch.move(1, CX - 200, CY);
    touch.move(2, CX + 200, CY);
    const state = viewport.getState();
    expect(state).toMatchObject({ mode: 'zoom', scale: 1, panX: 0, panY: 0, canFit: true });
    expect(element.style).toEqual({ width: '2000px', height: '1000px', transform: 'translate(-1000px, -500px)' });
    expect(onChange).not.toHaveBeenCalled();
    touch.up(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ scale: 1, mode: 'zoom' }), 'zoom');
    touch.up(2);
    expect(surface.hasAttribute('data-viewer-dragging')).toBe(false);
    // Fit and Actual Size keep their meaning after a pinch.
    viewport.fit();
    expect(viewport.getState()).toMatchObject({ mode: 'fit', scale: 0.5, panX: 0, panY: 0 });
    viewport.actualSize();
    expect(viewport.getState()).toMatchObject({ mode: 'zoom', scale: 1 });
  });

  it('keeps the content point under the midpoint while spreading and translating', () => {
    const { viewport, touch, element } = touchSetup();
    viewport.actualSize();
    // Midpoint at (+200, +50) from the centre.
    touch.down(31, CX + 100, CY + 50);
    touch.down(7, CX + 300, CY + 50);
    const anchor = contentPoint(viewport.getState(), CX + 200, CY + 50);
    expect(anchor).toEqual({ x: 200, y: 50 });
    // Double the distance about the same midpoint.
    touch.move(31, CX, CY + 50);
    touch.move(7, CX + 400, CY + 50);
    let state = viewport.getState();
    expect(state).toMatchObject({ scale: 2, panX: -200, panY: -50 });
    expect(contentPoint(state, CX + 200, CY + 50)).toEqual(anchor);
    // Translate the midpoint by (+30, -20) with no scale change.
    touch.move(31, CX + 30, CY + 30);
    touch.move(7, CX + 430, CY + 30);
    state = viewport.getState();
    expect(state).toMatchObject({ scale: 2, panX: -170, panY: -70 });
    expect(contentPoint(state, CX + 230, CY + 30)).toEqual(anchor);
    // Simultaneous translation and scale (pinch in while moving).
    touch.move(31, CX - 40, CY + 10);
    touch.move(7, CX + 260, CY + 10);
    state = viewport.getState();
    expect(state.scale).toBeCloseTo(1.5, 12);
    const mid = contentPoint(state, CX + 110, CY + 10);
    expect(mid.x).toBeCloseTo(anchor.x, 9);
    expect(mid.y).toBeCloseTo(anchor.y, 9);
    expectValidTransform(element, state);
  });

  it('clamps the pinch to Fit and to the maximum zoom, and bounds the pan', () => {
    const { viewport, touch, element } = touchSetup();
    viewport.actualSize();
    touch.down(1, CX - 100, CY);
    touch.down(2, CX + 100, CY);
    // Pinching far in stops at Fit, centred.
    touch.move(1, CX - 1, CY);
    touch.move(2, CX + 1, CY);
    expect(viewport.getState()).toMatchObject({ mode: 'fit', scale: 0.5, panX: 0, panY: 0, canFit: false });
    // Spreading far out stops at the maximum.
    touch.move(1, CX - 5000, CY);
    touch.move(2, CX + 5000, CY);
    let state = viewport.getState();
    expect(state.scale).toBe(VIEWER_MAX_ZOOM);
    expect(state.canZoomIn).toBe(false);
    expectValidTransform(element, state);
    touch.move(1, CX - 50000, CY);
    expect(viewport.getState().scale).toBe(VIEWER_MAX_ZOOM);
    // A midpoint dragged far away never pushes the content past its edges.
    touch.move(1, CX + 20000, CY + 20000);
    touch.move(2, CX + 30000, CY + 20000);
    state = viewport.getState();
    expect(state.panX).toBe(state.maxPanX);
    expect(state.panY).toBe(state.maxPanY);
    expectValidTransform(element, state);
  });

  it('passes one-to-two and two-to-one contacts without a jump', () => {
    const { viewport, touch, onChange } = touchSetup();
    viewport.actualSize();
    touch.down(900, CX, CY, { isPrimary: true });
    touch.move(900, CX + 40, CY + 20);
    expect(viewport.getState()).toMatchObject({ panX: 40, panY: 20, touchGesture: VIEWER_TOUCH_PAN });
    // A second finger: nothing moves until the contacts do.
    touch.down(13, CX + 240, CY + 20);
    expect(viewport.getState()).toMatchObject({ scale: 1, panX: 40, panY: 20, touchGesture: VIEWER_TOUCH_PINCH });
    touch.move(13, CX + 240, CY + 20);
    expect(viewport.getState()).toMatchObject({ scale: 1, panX: 40, panY: 20 });
    touch.move(13, CX + 440, CY + 20);
    const pinched = viewport.getState();
    expect(pinched.scale).toBe(2);
    onChange.mockClear();
    // Lifting either finger keeps the result; the other carries on panning from where it is.
    touch.up(900);
    const after = viewport.getState();
    expect(after).toMatchObject({ scale: 2, panX: pinched.panX, panY: pinched.panY, touchGesture: VIEWER_TOUCH_PAN, touchContacts: 1 });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ scale: 2 }), 'zoom');
    touch.move(13, CX + 440, CY + 20);
    expect(viewport.getState()).toMatchObject({ panX: pinched.panX, panY: pinched.panY });
    touch.move(13, CX + 450, CY + 25);
    expect(viewport.getState()).toMatchObject({ panX: pinched.panX + 10, panY: pinched.panY + 5 });
  });

  it.each([['first', 'second'], ['second', 'first']])('ends a pinch cleanly when the %s contact lifts first', (firstUp, secondUp) => {
    const { viewport, touch, onChange, surface } = touchSetup();
    const ids = { first: 7001, second: 3 };
    touch.down(ids.first, CX - 100, CY);
    touch.down(ids.second, CX + 100, CY);
    touch.move(ids.second, CX + 300, CY);
    onChange.mockClear();
    touch.up(ids[firstUp]);
    expect(viewport.getState().touchContacts).toBe(1);
    touch.up(ids[secondUp]);
    expect(viewport.getState()).toMatchObject({ touchGesture: VIEWER_TOUCH_NONE, touchContacts: 0, dragging: false });
    expect(surface.hasAttribute('data-viewer-dragging')).toBe(false);
    const reasons = onChange.mock.calls.map(([, reason]) => reason);
    expect(reasons[0]).toBe('zoom');
    expect(reasons.every((reason) => reason === 'zoom' || reason === 'pan')).toBe(true);
    // No phantom contact: stale ids move nothing, and a later finger starts fresh.
    const settled = viewport.getState();
    touch.move(ids.first, 0, 0);
    touch.move(ids.second, 0, 0);
    expect(viewport.getState()).toEqual(settled);
    touch.down(ids.first, CX, CY);
    expect(viewport.getState().touchContacts).toBe(1);
    expect(viewport.getState().touchGesture).not.toBe(VIEWER_TOUCH_PINCH);
  });

  it('ignores an unexpected third contact', () => {
    const { viewport, touch } = touchSetup();
    touch.down(1, CX - 100, CY);
    touch.down(2, CX + 100, CY);
    expect(touch.down(3, CX, CY + 300).defaultPrevented).toBe(true);
    expect(viewport.getState().touchContacts).toBe(2);
    touch.move(3, CX + 4000, CY + 4000);
    expect(viewport.getState()).toMatchObject({ scale: 0.5, panX: 0, panY: 0 });
    touch.up(3);
    expect(viewport.getState()).toMatchObject({ touchGesture: VIEWER_TOUCH_PINCH, touchContacts: 2 });
    touch.move(2, CX + 300, CY);
    expect(viewport.getState().scale).toBe(1);
  });

  it.each([['pointercancel', 'cancel'], ['lostpointercapture', 'lost']])('abandons the whole touch sequence on %s', (_, kind) => {
    const { viewport, touch, onChange, surface } = touchSetup();
    touch.down(21, CX - 100, CY);
    touch.down(22, CX + 100, CY);
    touch.move(22, CX + 300, CY);
    const reached = viewport.getState();
    expect(reached.scale).toBe(1);
    onChange.mockClear();
    touch[kind](21);
    // What the gesture reached is kept and reported; nothing is still tracked.
    expect(viewport.getState()).toMatchObject({ scale: 1, panX: reached.panX, touchGesture: VIEWER_TOUCH_NONE, touchContacts: 0, dragging: false });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(expect.anything(), 'zoom');
    expect(surface.hasAttribute('data-viewer-dragging')).toBe(false);
    // The surviving finger's obsolete gesture never continues.
    touch.move(22, CX + 900, CY + 200);
    touch.move(21, CX - 900, CY);
    expect(viewport.getState()).toMatchObject({ scale: 1, panX: reached.panX, panY: reached.panY });
    touch.up(22);
    touch.up(21);
    expect(onChange).toHaveBeenCalledTimes(1);
    // The cancelled id can start again as a fresh single contact.
    touch.down(21, CX, CY);
    expect(viewport.getState()).toMatchObject({ touchContacts: 1, touchGesture: VIEWER_TOUCH_PAN });
    touch.move(21, CX + 10, CY);
    expect(viewport.getState().panX).toBe(reached.panX + 10);
    touch.up(21);
    // The implicit-capture loss after a normal lift is harmless.
    touch.lost(21);
    expect(viewport.getState()).toMatchObject({ touchContacts: 0, panX: reached.panX + 10 });
  });

  it('drops the gesture when new content is shown mid-pinch', () => {
    const { viewport, touch, onChange } = touchSetup();
    touch.down(1, CX - 100, CY);
    touch.down(2, CX + 100, CY);
    touch.move(2, CX + 300, CY);
    onChange.mockClear();
    const next = makeContent();
    viewport.setContent(next, { width: 900, height: 1600 });
    expect(onChange.mock.calls.map(([, reason]) => reason)).toEqual(['content']);
    const fresh = viewport.getState();
    expect(fresh).toMatchObject({ mode: 'fit', panX: 0, panY: 0, touchContacts: 0, touchGesture: VIEWER_TOUCH_NONE });
    const transform = next.style.transform;
    touch.move(2, CX + 900, CY + 100);
    touch.move(1, CX - 900, CY);
    expect(viewport.getState()).toEqual(fresh);
    expect(next.style.transform).toBe(transform);
    touch.up(1);
    touch.up(2);
    expect(onChange.mock.calls.map(([, reason]) => reason)).toEqual(['content']);
  });

  it('drops the gesture when the rendition is replaced mid-pan', () => {
    const { viewport, touch, onChange } = touchSetup();
    viewport.zoomIn();
    viewport.zoomIn();
    touch.down(1, CX, CY, { isPrimary: true });
    touch.move(1, CX + 60, CY + 20);
    onChange.mockClear();
    const replacement = makeContent();
    viewport.replaceContent(replacement, { width: 4000, height: 2000 });
    const replaced = viewport.getState();
    expect(replaced).toMatchObject({ touchContacts: 0, touchGesture: VIEWER_TOUCH_NONE, contentWidth: 4000 });
    expect(onChange.mock.calls.map(([, reason]) => reason)).toEqual(['content']);
    touch.move(1, CX + 500, CY + 300);
    touch.up(1);
    expect(viewport.getState()).toEqual(replaced);
    viewport.clearContent();
    expect(viewport.getState().touchContacts).toBe(0);
  });

  it('rebases a pinch on a surface resize so nothing jumps and anchoring continues', () => {
    const observers = [];
    class FakeResizeObserver {
      constructor(callback) { this.callback = callback; this.disconnect = vi.fn(); observers.push(this); }
      observe() {}
    }
    const { viewport, touch, surface, element } = touchSetup({ view: { ResizeObserver: FakeResizeObserver } });
    viewport.actualSize();
    touch.down(1, CX + 100, CY);
    touch.down(2, CX + 300, CY);
    touch.move(2, CX + 500, CY);
    // An orientation change: the surface changes shape (its left/top stay put here).
    surface.clientWidth = 600;
    surface.clientHeight = 900;
    observers[0].callback();
    const settled = viewport.getState();
    expect(settled).toMatchObject({ touchGesture: VIEWER_TOUCH_PINCH, touchContacts: 2, viewportWidth: 600 });
    expectValidTransform(element, settled);
    // The next event at the same positions changes nothing.
    touch.move(2, CX + 500, CY);
    expect(viewport.getState()).toEqual(settled);
    // And anchoring continues in the new geometry (centre now (400, 500)).
    const centre = { x: 400, y: 500 };
    const mid = { x: CX + 300, y: CY };
    const anchorX = (mid.x - centre.x - settled.panX) / settled.scale;
    touch.move(1, CX - 100, CY);
    touch.move(2, CX + 700, CY);
    const after = viewport.getState();
    expect(after.scale).toBeCloseTo(settled.scale * 2, 12);
    expect((mid.x - centre.x - after.panX) / after.scale).toBeCloseTo(anchorX, 9);
    expectValidTransform(element, after);
  });

  it('pinches and pans a composite comic spread through the same geometry', () => {
    const { viewport, touch, element, surface } = touchSetup({ content: { width: 2040, height: 1500 }, composite: true });
    expect(surface.hasAttribute('data-viewer-composite')).toBe(true);
    const fit = viewport.getState().fitScale;
    expect(fit).toBeCloseTo(1000 / 2040);
    touch.down(1, CX - 100, CY - 100);
    touch.down(2, CX + 100, CY - 100);
    touch.move(1, CX - 300, CY - 100);
    touch.move(2, CX + 300, CY - 100);
    const state = viewport.getState();
    expect(state.scale).toBeCloseTo(fit * 3, 12);
    expect(state.composite).toBe(true);
    // The point under the midpoint (100 px above centre) stays there.
    expect((-100 - state.panY) / state.scale).toBeCloseTo(-100 / fit, 9);
    expectValidTransform(element, state);
    touch.up(2);
    touch.move(1, CX - 250, CY - 80);
    expect(viewport.getState()).toMatchObject({ panX: state.panX + 50, panY: state.panY + 20, composite: true });
    touch.up(1);
  });

  it('rebases a pinch when a companion page resolves (composition resized in place)', () => {
    const { viewport, touch, element, onChange } = touchSetup({ content: { width: 1000, height: 1500 }, composite: true });
    touch.down(1, CX - 100, CY);
    touch.down(2, CX + 100, CY);
    touch.move(1, CX - 200, CY);
    touch.move(2, CX + 200, CY);
    const before = viewport.getState();
    expect(before.mode).toBe('zoom');
    onChange.mockClear();
    viewport.resizeContent({ width: 2020, height: 1500 });
    const resized = viewport.getState();
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ contentWidth: 2020 }), 'content-size');
    expect(resized).toMatchObject({ touchGesture: VIEWER_TOUCH_PINCH, touchContacts: 2, composite: true });
    expect(resized.scale / resized.fitScale).toBeCloseTo(before.scale / before.fitScale, 9);
    // No stale origins: the same positions change nothing, and the pinch continues.
    touch.move(2, CX + 200, CY);
    expect(viewport.getState()).toEqual(resized);
    touch.move(2, CX + 600, CY);
    expect(viewport.getState().scale).toBeGreaterThan(resized.scale);
    expectValidTransform(element, viewport.getState());
  });

  it('rebases a touch pan after keyboard panning or button zoom', () => {
    const { viewport, touch } = touchSetup();
    viewport.actualSize();
    touch.down(1, CX, CY);
    touch.move(1, CX + 10, CY);
    viewport.panBy(48, 0);
    expect(viewport.getState().panX).toBe(58);
    touch.move(1, CX + 20, CY);
    expect(viewport.getState().panX).toBe(68);
    viewport.zoomIn();
    const zoomed = viewport.getState();
    touch.move(1, CX + 25, CY);
    expect(viewport.getState().panX).toBe(zoomed.panX + 5);
    // Fit mid-touch turns the contact back into a non-panning one.
    viewport.fit();
    expect(viewport.getState().touchGesture).toBe(VIEWER_TOUCH_TRACKING);
    touch.move(1, CX + 400, CY);
    expect(viewport.getState()).toMatchObject({ panX: 0, mode: 'fit' });
  });

  it('forgets every contact and listener when destroyed mid-gesture', () => {
    const { viewport, touch, surface, onChange } = touchSetup();
    touch.down(1, CX - 100, CY);
    touch.down(2, CX + 100, CY);
    touch.move(2, CX + 300, CY);
    onChange.mockClear();
    viewport.destroy();
    expect(viewport.getState()).toMatchObject({ hasContent: false, touchContacts: 0, touchGesture: VIEWER_TOUCH_NONE, dragging: false });
    expect(surface.listeners).toHaveLength(0);
    expect(surface.hasAttribute('data-viewer-dragging')).toBe(false);
    expect(surface.captured.size).toBe(0);
    expect(surface.setPointerCapture).not.toHaveBeenCalled();
    // Only the existing clear notice; the abandoned pinch reports nothing.
    expect(onChange.mock.calls.map(([, reason]) => reason)).toEqual(['clear']);
    surface.fire('pointermove', { pointerId: 2, pointerType: 'touch', clientX: 0, clientY: 0 });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('starts no touch gesture from a control, without content, or with invalid coordinates', () => {
    const { viewport, touch, surface, element } = touchSetup();
    viewport.actualSize();
    const control = { closest: () => control };
    surface.contains = () => true;
    expect(touch.down(1, CX, CY, { target: control }).defaultPrevented).toBe(false);
    expect(viewport.getState().touchContacts).toBe(0);
    // A second finger joins the pinch even from a control, so one gesture stays one gesture.
    touch.down(2, CX - 100, CY);
    touch.down(3, CX + 100, CY, { target: control });
    expect(viewport.getState().touchGesture).toBe(VIEWER_TOUCH_PINCH);
    touch.cancel(2);
    // Non-finite coordinates never enter the geometry.
    touch.down(4, Number.NaN, CY);
    touch.down(5, CX, Infinity);
    expect(viewport.getState().touchContacts).toBe(0);
    touch.down(6, CX, CY);
    touch.move(6, Number.NaN, Number.NaN);
    touch.move(6, CX + 10, CY);
    expect(viewport.getState().panX).toBe(10);
    touch.up(6);
    // Coincident contacts never divide by zero.
    touch.down(7, CX, CY);
    touch.down(8, CX, CY);
    touch.move(8, CX + 3, CY);
    expectValidTransform(element, viewport.getState());
    touch.up(7);
    touch.up(8);
    viewport.clearContent();
    expect(touch.down(9, CX, CY).defaultPrevented).toBe(false);
    expect(viewport.getState().touchContacts).toBe(0);
  });

  it('keeps mouse and pen drags as they were and never mixes them with touch', () => {
    const { viewport, touch, surface } = touchSetup();
    viewport.actualSize();
    // Mouse: capture, bounded drag, release.
    surface.fire('pointerdown', { clientX: 0, clientY: 0 });
    expect(surface.setPointerCapture).toHaveBeenCalledWith(1);
    // A finger during a mouse drag is ignored.
    touch.down(50, CX, CY);
    expect(viewport.getState().touchContacts).toBe(0);
    surface.fire('pointermove', { clientX: 30, clientY: 10 });
    expect(viewport.getState()).toMatchObject({ panX: 30, panY: 10, touchGesture: VIEWER_TOUCH_NONE });
    surface.fire('pointerup');
    expect(surface.releasePointerCapture).toHaveBeenCalledWith(1);
    // Pen drags like a mouse, with capture.
    surface.fire('pointerdown', { pointerType: 'pen', pointerId: 77, clientX: 0, clientY: 0 });
    expect(surface.setPointerCapture).toHaveBeenCalledWith(77);
    surface.fire('pointermove', { pointerType: 'pen', pointerId: 77, clientX: -20, clientY: 0 });
    expect(viewport.getState().panX).toBe(10);
    surface.fire('pointerup', { pointerType: 'pen', pointerId: 77 });
    expect(viewport.getState().dragging).toBe(false);
    // A mouse press during a touch gesture is ignored.
    touch.down(51, CX, CY);
    expect(surface.fire('pointerdown', { clientX: 0, clientY: 0 }).defaultPrevented).toBe(false);
    expect(surface.setPointerCapture).toHaveBeenCalledTimes(2);
    touch.up(51);
  });
});

// ─── D1-B: Fit-state swipe/tap classification and gesture ownership ─────────

describe('viewer touch classification thresholds (D1-B)', () => {
  it('scales the swipe distance with the surface, within [32, 96]', () => {
    expect(computeViewerSwipeDistance(200)).toBe(32);
    expect(computeViewerSwipeDistance(375)).toBe(37.5);
    expect(computeViewerSwipeDistance(800)).toBe(80);
    expect(computeViewerSwipeDistance(1920)).toBe(96);
    expect(computeViewerSwipeDistance(0)).toBe(32);
  });

  it('sizes the edge regions at 20%, at least 44 px, never over 30%', () => {
    expect(computeViewerEdgeZone(1000)).toBe(200);
    expect(computeViewerEdgeZone(375)).toBe(75);
    expect(computeViewerEdgeZone(180)).toBe(44);
    expect(computeViewerEdgeZone(120)).toBeCloseTo(36, 9);
    expect(computeViewerEdgeZone(0)).toBe(0);
  });

  const at = (overrides) => classifyViewerTouch({ dx: 0, dy: 0, travel: 0, duration: 100, offsetX: 500, width: 1000, ...overrides });

  it('classifies stationary touches by region and duration', () => {
    expect(at({ offsetX: 0 })).toEqual({ kind: 'tap', side: 'left' });
    expect(at({ offsetX: 199.9 })).toEqual({ kind: 'tap', side: 'left' });
    expect(at({ offsetX: 200 })).toEqual({ kind: 'tap', side: 'center' });
    expect(at({ offsetX: 800 })).toEqual({ kind: 'tap', side: 'center' });
    expect(at({ offsetX: 800.1 })).toEqual({ kind: 'tap', side: 'right' });
    expect(at({ offsetX: 1000 })).toEqual({ kind: 'tap', side: 'right' });
    expect(at({ offsetX: 1001 })).toEqual({ kind: 'tap', side: 'center' });
    expect(at({ offsetX: 50, width: 0 })).toEqual({ kind: 'tap', side: 'center' });
    // Jitter within the slop is still a tap; beyond it never is.
    expect(at({ offsetX: 50, travel: VIEWER_TOUCH_TAP_SLOP })).toEqual({ kind: 'tap', side: 'left' });
    expect(at({ offsetX: 50, travel: VIEWER_TOUCH_TAP_SLOP + 0.1, dx: 1 })).toEqual({ kind: 'drag' });
    expect(at({ offsetX: 50, duration: VIEWER_TOUCH_TAP_MAX_DURATION })).toEqual({ kind: 'tap', side: 'left' });
    expect(at({ offsetX: 50, duration: VIEWER_TOUCH_TAP_MAX_DURATION + 1 })).toEqual({ kind: 'press' });
  });

  it('needs a deliberate, mostly horizontal end displacement to swipe', () => {
    // 1000 px wide: 96 px needed.
    expect(at({ dx: -96, travel: 96 })).toEqual({ kind: 'swipe', side: 'right' });
    expect(at({ dx: 96, travel: 96 })).toEqual({ kind: 'swipe', side: 'left' });
    expect(at({ dx: -95.9, travel: 95.9 })).toEqual({ kind: 'drag' });
    // Diagonal tolerance: up to |dx| = 1.5 |dy| (~33.7°).
    expect(at({ dx: -150, dy: 100, travel: 181 })).toEqual({ kind: 'swipe', side: 'right' });
    expect(at({ dx: -150, dy: 100.1, travel: 181 })).toEqual({ kind: 'drag' });
    expect(at({ dx: 120, dy: 120, travel: 170 })).toEqual({ kind: 'drag' });
    expect(at({ dx: 10, dy: 300, travel: 300 })).toEqual({ kind: 'drag' });
    // The end counts: travelling out and back is no swipe.
    expect(at({ dx: -20, travel: 300 })).toEqual({ kind: 'drag' });
    // A phone-width surface needs less.
    expect(at({ dx: -38, travel: 38, width: 375 })).toEqual({ kind: 'swipe', side: 'right' });
    expect(at({ dx: -37, travel: 37, width: 375 })).toEqual({ kind: 'drag' });
  });
});

describe('viewer viewport touch navigation (D1-B)', () => {
  // Surface 1000 × 800 at (100, 50): edge regions x < 300 and x > 900; swipes need 96 px.
  const LEFT = 150;
  const CENTER = 600;
  const RIGHT = 1000;
  const Y = 450;

  function makeDocument() {
    const listeners = [];
    return {
      listeners,
      addEventListener: vi.fn((type, handler, capture) => listeners.push({ type, handler, capture })),
      removeEventListener: vi.fn((type, handler, capture) => {
        const index = listeners.findIndex((entry) => entry.type === type && entry.handler === handler && entry.capture === capture);
        if (index >= 0) listeners.splice(index, 1);
      }),
      fire(type, props = {}) {
        const event = {
          type,
          pointerType: 'touch',
          defaultPrevented: false,
          stopped: false,
          preventDefault() { this.defaultPrevented = true; },
          stopImmediatePropagation() { this.stopped = true; },
          ...props,
        };
        listeners.filter((entry) => entry.type === type).forEach((entry) => entry.handler(event));
        return event;
      },
    };
  }

  function navSetup({ content = { width: 2000, height: 1000 }, navigate = () => true, identity = () => 'item-1', document = makeDocument() } = {}) {
    const surface = makeSurface(1000, 800);
    surface.getBoundingClientRect = () => ({ left: 100, top: 50, width: surface.clientWidth, height: surface.clientHeight });
    surface.ownerDocument = document;
    const control = { closest: (selector) => (selector.includes('button') ? control : null) };
    surface.contains = (node) => node === control;
    const onChange = vi.fn();
    const intents = [];
    const touchNavigation = {
      identity: vi.fn(identity),
      navigate: vi.fn((intent) => {
        intents.push(intent);
        return navigate(intent);
      }),
    };
    const viewport = createViewerViewport({ surface, onChange, touchNavigation });
    viewport.setContent(makeContent(), content);
    const touch = {
      down: (pointerId, clientX, clientY = Y, extra = {}) => surface.fire('pointerdown', {
        pointerId, pointerType: 'touch', isPrimary: false, clientX, clientY, ...extra,
      }),
      move: (pointerId, clientX, clientY = Y) => surface.fire('pointermove', { pointerId, pointerType: 'touch', clientX, clientY }),
      up: (pointerId, clientX, clientY = Y) => surface.fire('pointerup', { pointerId, pointerType: 'touch', clientX, clientY }),
      cancel: (pointerId) => surface.fire('pointercancel', { pointerId, pointerType: 'touch' }),
      lost: (pointerId) => surface.fire('lostpointercapture', { pointerId, pointerType: 'touch' }),
      swipe: (pointerId, fromX, toX, { fromY = Y, toY = Y } = {}) => {
        touch.down(pointerId, fromX, fromY, { isPrimary: true });
        touch.move(pointerId, (fromX + toX) / 2, (fromY + toY) / 2);
        touch.move(pointerId, toX, toY);
        return touch.up(pointerId, toX, toY);
      },
      tap: (pointerId, x, y = Y) => {
        touch.down(pointerId, x, y, { isPrimary: true });
        return touch.up(pointerId, x, y);
      },
    };
    return { surface, document, onChange, viewport, touch, intents, touchNavigation, control };
  }

  it('turns a Fit-state leftward swipe into one rightward intent, and a rightward swipe into a leftward one', () => {
    const { touch, intents, viewport } = navSetup();
    const up = touch.swipe(1, 700, 550);
    expect(intents).toEqual([{ kind: 'swipe', side: 'right', identity: 'item-1' }]);
    expect(viewport.releaseTouch(up)).toBe('navigate');
    touch.swipe(2, 400, 600);
    expect(intents.at(-1)).toEqual({ kind: 'swipe', side: 'left', identity: 'item-1' });
    expect(intents).toHaveLength(2);
    expect(viewport.getState()).toMatchObject({ mode: 'fit', panX: 0, panY: 0, touchContacts: 0, touchGesture: 'none' });
  });

  it('turns outer-edge taps into intents and leaves centre taps to the chrome', () => {
    const { touch, intents, viewport } = navSetup();
    const left = touch.tap(1, LEFT);
    expect(viewport.releaseTouch(left)).toBe('navigate');
    touch.tap(2, RIGHT);
    expect(intents.map((intent) => `${intent.kind}:${intent.side}`)).toEqual(['tap:left', 'tap:right']);
    const centre = touch.tap(3, CENTER);
    expect(viewport.releaseTouch(centre)).toBe('tap');
    expect(intents).toHaveLength(2);
  });

  it('never navigates on small, vertical or too-diagonal movement, or a long press', () => {
    vi.useFakeTimers();
    try {
      const { touch, intents, viewport } = navSetup();
      expect(viewport.releaseTouch(touch.swipe(1, 700, 605))).toBe('drag');
      expect(viewport.releaseTouch(touch.swipe(2, 600, 640, { toY: 750 }))).toBe('drag');
      expect(viewport.releaseTouch(touch.swipe(3, 700, 560, { toY: Y + 140 }))).toBe('drag');
      // Within ~33.7° of horizontal it is a swipe.
      expect(viewport.releaseTouch(touch.swipe(4, 700, 550, { toY: Y + 90 }))).toBe('navigate');
      // Out and back: the end displacement counts.
      touch.down(5, 700, Y, { isPrimary: true });
      touch.move(5, 400, Y);
      touch.move(5, 690, Y);
      expect(viewport.releaseTouch(touch.up(5, 690, Y))).toBe('drag');
      // A press longer than a tap at an edge.
      touch.down(6, LEFT, Y, { isPrimary: true });
      vi.advanceTimersByTime(VIEWER_TOUCH_TAP_MAX_DURATION + 1);
      expect(viewport.releaseTouch(touch.up(6, LEFT, Y))).toBe('tap');
      // Jitter beyond the tap slop at an edge.
      touch.down(7, LEFT, Y, { isPrimary: true });
      touch.move(7, LEFT + 7, Y);
      expect(viewport.releaseTouch(touch.up(7, LEFT, Y))).toBe('drag');
      expect(intents).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never navigates while enlarged: one finger pans, a still finger is a chrome tap', () => {
    const { touch, intents, viewport } = navSetup();
    viewport.actualSize();
    expect(viewport.releaseTouch(touch.swipe(1, 700, 400))).toBe('consumed');
    expect(viewport.getState()).toMatchObject({ mode: 'zoom', panX: -300 });
    expect(viewport.releaseTouch(touch.tap(2, LEFT))).toBe('tap');
    expect(viewport.releaseTouch(touch.tap(3, RIGHT))).toBe('tap');
    // A pan that ends back at Fit (pan at the clamp edge) still does not navigate.
    viewport.fit();
    viewport.zoomIn();
    touch.down(4, 700, Y, { isPrimary: true });
    touch.move(4, 500, Y);
    viewport.fit();
    expect(viewport.releaseTouch(touch.up(4, 500, Y))).toBe('consumed');
    expect(intents).toHaveLength(0);
  });

  it('a pinch — from Fit, back to Fit, or ending with one finger that then swipes — never navigates', () => {
    const { touch, intents, viewport } = navSetup();
    touch.down(1, 500, Y, { isPrimary: true });
    touch.down(2, 700, Y);
    touch.move(2, 900, Y);
    touch.move(2, 700, Y);
    expect(viewport.getState()).toMatchObject({ mode: 'fit' });
    expect(viewport.releaseTouch(touch.up(2, 700, Y))).toBe('consumed');
    // The remaining finger now moves like a swipe and lifts at an edge.
    touch.move(1, 200, Y);
    expect(viewport.releaseTouch(touch.up(1, 200, Y))).toBe('consumed');
    // A two-finger tap at the edges.
    touch.down(3, LEFT, Y, { isPrimary: true });
    touch.down(4, RIGHT, Y);
    touch.up(3, LEFT, Y);
    expect(viewport.releaseTouch(touch.up(4, RIGHT, Y))).toBe('consumed');
    // A third finger joins the sequence history too.
    touch.down(5, 500, Y, { isPrimary: true });
    touch.down(6, 600, Y);
    touch.down(7, 700, Y);
    touch.up(5, 500, Y);
    touch.up(6, 600, Y);
    touch.move(7, 400, Y);
    expect(viewport.releaseTouch(touch.up(7, 400, Y))).toBe('consumed');
    expect(intents).toHaveLength(0);
    expect(viewport.getState()).toMatchObject({ touchContacts: 0, touchGesture: 'none' });
  });

  it('a cancelled or uncaptured touch never navigates, and its other fingers cannot revive it', () => {
    const { touch, intents, viewport } = navSetup();
    touch.down(1, 700, Y, { isPrimary: true });
    touch.move(1, 500, Y);
    touch.cancel(1);
    expect(viewport.releaseTouch(touch.up(1, 500, Y))).toBe(null);
    touch.down(2, LEFT, Y, { isPrimary: true });
    touch.lost(2);
    expect(viewport.releaseTouch(touch.up(2, LEFT, Y))).toBe(null);
    touch.down(3, 700, Y, { isPrimary: true });
    touch.down(4, 800, Y);
    touch.cancel(4);
    touch.move(3, 500, Y);
    expect(viewport.releaseTouch(touch.up(3, 500, Y))).toBe('consumed');
    expect(intents).toHaveLength(0);
    // The next interaction is unaffected.
    touch.tap(5, RIGHT);
    expect(intents).toHaveLength(1);
  });

  it('a touch that begins on a control is the control’s, however it moves', () => {
    const { touch, intents, viewport, control } = navSetup();
    touch.down(1, LEFT, Y, { isPrimary: true, target: control });
    expect(viewport.ownsTouch(1)).toBe(false);
    touch.move(1, 50, Y);
    expect(viewport.releaseTouch(touch.up(1, 50, Y))).toBe(null);
    touch.down(2, RIGHT, Y, { isPrimary: true, target: control });
    expect(viewport.releaseTouch(touch.up(2, RIGHT, Y))).toBe(null);
    expect(intents).toHaveLength(0);
  });

  it('resolves each release once, whoever asks first, and reports a declined navigation as a plain tap or drag', () => {
    let allow = false;
    const { touch, intents, viewport, touchNavigation, surface } = navSetup({ navigate: () => allow });
    touch.down(1, LEFT, Y, { isPrimary: true });
    expect(viewport.ownsTouch(1)).toBe(true);
    // The fullscreen participant asks first; the surface's own listener then gets the same answer.
    const up = { pointerId: 1, pointerType: 'touch', clientX: LEFT, clientY: Y };
    expect(viewport.releaseTouch(up)).toBe('tap');
    surface.listeners.filter((entry) => entry.type === 'pointerup').forEach((entry) => entry.handler(up));
    expect(viewport.releaseTouch(up)).toBe('tap');
    expect(viewport.getState().touchContacts).toBe(0);
    expect(viewport.ownsTouch(1)).toBe(false);
    expect(touchNavigation.navigate).toHaveBeenCalledTimes(1);
    expect(viewport.releaseTouch(touch.swipe(2, 700, 500))).toBe('drag');
    allow = true;
    const event = touch.tap(3, RIGHT);
    expect(viewport.releaseTouch(event)).toBe('navigate');
    expect(viewport.releaseTouch(event)).toBe('navigate');
    expect(intents).toHaveLength(3);
    // Mouse and pen never navigate.
    expect(viewport.releaseTouch({ ...event, pointerType: 'mouse' })).toBe(null);
  });

  it('binds a touch to the identity it began with', () => {
    let identity = 'item-1';
    const { touch, intents } = navSetup({ identity: () => identity });
    touch.down(1, 700, Y, { isPrimary: true });
    identity = 'item-2';
    touch.move(1, 500, Y);
    touch.up(1, 500, Y);
    expect(intents).toEqual([{ kind: 'swipe', side: 'right', identity: 'item-1' }]);
  });

  it('cancelTouch, new or replaced content, clearing and destroy invalidate a touch in progress', () => {
    const { touch, intents, viewport, surface } = navSetup();
    for (const invalidate of [
      () => viewport.cancelTouch(),
      () => viewport.setContent(makeContent(), { width: 600, height: 400 }),
      () => viewport.replaceContent(makeContent(), { width: 1200, height: 800 }),
    ]) {
      touch.down(1, 700, Y, { isPrimary: true });
      touch.move(1, 500, Y);
      invalidate();
      expect(viewport.ownsTouch(1)).toBe(true);
      expect(viewport.releaseTouch(touch.up(1, 500, Y))).toBe('consumed');
      touch.down(2, LEFT, Y, { isPrimary: true });
      invalidate();
      expect(viewport.releaseTouch(touch.up(2, LEFT, Y))).toBe('consumed');
    }
    touch.down(3, LEFT, Y, { isPrimary: true });
    viewport.clearContent();
    expect(viewport.releaseTouch(touch.up(3, LEFT, Y))).toBe('consumed');
    expect(intents).toHaveLength(0);
    touch.down(4, LEFT, Y, { isPrimary: true });
    viewport.destroy();
    expect(viewport.releaseTouch({ pointerId: 4, pointerType: 'touch', clientX: LEFT, clientY: Y })).toBe(null);
    expect(intents).toHaveLength(0);
    expect(surface.listeners).toHaveLength(0);
  });

  // D1-F1: the item's image may still be loading when the first touch lands.
  it('a touch begun while nothing is shown survives that item\'s first content and navigates once', () => {
    const { touch, intents, viewport } = navSetup({ identity: () => ({ token: 4, session: 2, key: 'a' }) });
    viewport.clearContent();
    // A swipe that starts before the content and ends after it.
    touch.down(1, 700, Y, { isPrimary: true });
    touch.move(1, 650, Y);
    expect(viewport.ownsTouch(1)).toBe(true);
    expect(viewport.setContent(makeContent(), { width: 2000, height: 1000 })).toBe(true);
    expect(viewport.ownsTouch(1)).toBe(true);
    touch.move(1, 500, Y);
    expect(viewport.getState()).toMatchObject({ mode: 'fit', panX: 0, panY: 0 });
    expect(viewport.releaseTouch(touch.up(1, 500, Y))).toBe('navigate');
    // An edge tap likewise, against a fresh but equal identity object.
    viewport.clearContent();
    touch.down(2, RIGHT, Y, { isPrimary: true });
    viewport.setContent(makeContent(), { width: 600, height: 400 });
    expect(viewport.releaseTouch(touch.up(2, RIGHT, Y))).toBe('navigate');
    expect(intents).toEqual([
      { kind: 'swipe', side: 'right', identity: { token: 4, session: 2, key: 'a' } },
      { kind: 'tap', side: 'right', identity: { token: 4, session: 2, key: 'a' } },
    ]);
  });

  it('a touch kept across the first content rebases: a second finger pinches about the real midpoint and never navigates', () => {
    const { touch, intents, viewport } = navSetup({ content: { width: 1000, height: 800 } });
    viewport.clearContent();
    touch.down(1, 500, Y, { isPrimary: true });
    touch.move(1, 520, Y);
    expect(viewport.getState().touchContacts).toBe(0);
    viewport.setContent(makeContent(), { width: 1000, height: 800 });
    expect(viewport.getState()).toMatchObject({ touchContacts: 1, touchGesture: VIEWER_TOUCH_TRACKING });
    // Midpoint (620, 450) = surface (100, 50) + (520, 400): 20 px right of the centre.
    touch.down(2, 720, Y);
    expect(viewport.getState().touchGesture).toBe(VIEWER_TOUCH_PINCH);
    touch.move(1, 420, Y);
    touch.move(2, 820, Y);
    const state = viewport.getState();
    expect(state.mode).toBe('zoom');
    expect(state.scale).toBeCloseTo(2, 5);
    // The content point under the midpoint stays there: pan = −20 × (2 − 1).
    expect(state.panX).toBeCloseTo(-20, 5);
    expect(state.panY).toBeCloseTo(0, 5);
    expect(Number.isFinite(state.panX) && Number.isFinite(state.panY)).toBe(true);
    touch.up(2, 820, Y);
    expect(viewport.releaseTouch(touch.up(1, 420, Y))).toBe('consumed');
    expect(intents).toHaveLength(0);
  });

  it('first content never revives a touch whose identity changed, that was cancelled, or that began on shown content', () => {
    let identity = { token: 1, session: 1, key: 'a' };
    const { touch, intents, viewport, surface } = navSetup({ identity: () => identity });
    // Another item (navigation by any means) before its first content.
    viewport.clearContent();
    touch.down(1, RIGHT, Y, { isPrimary: true });
    identity = { token: 2, session: 1, key: 'b' };
    viewport.setContent(makeContent(), { width: 2000, height: 1000 });
    expect(viewport.releaseTouch(touch.up(1, RIGHT, Y))).toBe('consumed');
    // Another session (close and reopen) with the same item key.
    viewport.clearContent();
    touch.down(2, RIGHT, Y, { isPrimary: true });
    identity = { token: 3, session: 2, key: 'b' };
    viewport.setContent(makeContent(), { width: 2000, height: 1000 });
    expect(viewport.releaseTouch(touch.up(2, RIGHT, Y))).toBe('consumed');
    // Cancelled (the owner's session change) and then the same identity's content.
    viewport.clearContent();
    touch.down(3, 700, Y, { isPrimary: true });
    viewport.cancelTouch();
    viewport.setContent(makeContent(), { width: 2000, height: 1000 });
    touch.move(3, 500, Y);
    expect(viewport.releaseTouch(touch.up(3, 500, Y))).toBe('consumed');
    // Begun on shown content: clearing and showing content again is a replacement.
    touch.down(4, RIGHT, Y, { isPrimary: true });
    viewport.clearContent();
    viewport.setContent(makeContent(), { width: 2000, height: 1000 });
    expect(viewport.releaseTouch(touch.up(4, RIGHT, Y))).toBe('consumed');
    // Kept across first content, then really replaced: consumed.
    viewport.clearContent();
    touch.down(5, RIGHT, Y, { isPrimary: true });
    viewport.setContent(makeContent(), { width: 2000, height: 1000 });
    viewport.setContent(makeContent(), { width: 1200, height: 800 });
    expect(viewport.releaseTouch(touch.up(5, RIGHT, Y))).toBe('consumed');
    // Invalid content clears instead.
    viewport.clearContent();
    touch.down(6, RIGHT, Y, { isPrimary: true });
    viewport.setContent(makeContent(), { width: 0, height: 0 });
    expect(viewport.releaseTouch(touch.up(6, RIGHT, Y))).toBe('consumed');
    // The surface changed size while loading: a plain tap, no navigation.
    viewport.clearContent();
    touch.down(7, RIGHT, Y, { isPrimary: true });
    surface.clientWidth = 900;
    viewport.setContent(makeContent(), { width: 2000, height: 1000 });
    expect(viewport.releaseTouch(touch.up(7, RIGHT, Y))).toBe('tap');
    // First content at another scale (enlarged): no navigation either.
    surface.clientWidth = 1000;
    viewport.clearContent();
    touch.down(8, 700, Y, { isPrimary: true });
    viewport.setContent(makeContent(), { width: 2000, height: 1000 }, { scale: 1 });
    touch.move(8, 500, Y);
    expect(viewport.releaseTouch(touch.up(8, 500, Y))).toBe('consumed');
    expect(intents).toHaveLength(0);
  });

  it('first content keeps no touch without an owner identity', () => {
    const { touch, intents, viewport } = navSetup({ identity: () => null });
    viewport.clearContent();
    touch.down(1, RIGHT, Y, { isPrimary: true });
    viewport.setContent(makeContent(), { width: 2000, height: 1000 });
    expect(viewport.releaseTouch(touch.up(1, RIGHT, Y))).toBe('consumed');
    expect(intents).toHaveLength(0);
  });

  it('a cancelled pinch reports the zoom it reached', () => {
    const { touch, viewport, onChange } = navSetup();
    touch.down(1, 500, Y, { isPrimary: true });
    touch.down(2, 700, Y);
    touch.move(2, 900, Y);
    onChange.mockClear();
    viewport.cancelTouch();
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ mode: 'zoom', touchContacts: 0 }), 'zoom');
    touch.move(2, 1000, Y);
    expect(viewport.getState().scale).toBe(onChange.mock.calls.at(-1)[0].scale);
  });

  it('a zoom/pan from elsewhere, or a surface resize, during the touch forbids navigation', () => {
    const { touch, intents, viewport, surface } = navSetup();
    touch.down(1, LEFT, Y, { isPrimary: true });
    viewport.zoomIn();
    viewport.fit();
    expect(viewport.releaseTouch(touch.up(1, LEFT, Y))).toBe('consumed');
    touch.down(2, 700, Y, { isPrimary: true });
    touch.move(2, 500, Y);
    viewport.zoomIn();
    viewport.fit();
    expect(viewport.releaseTouch(touch.up(2, 500, Y))).toBe('consumed');
    touch.down(3, 700, Y, { isPrimary: true });
    surface.clientWidth = 900;
    viewport.refresh();
    touch.move(3, 500, Y);
    expect(viewport.releaseTouch(touch.up(3, 500, Y))).toBe('drag');
    touch.down(4, RIGHT - 50, Y, { isPrimary: true });
    surface.clientWidth = 1000;
    viewport.refresh();
    expect(viewport.releaseTouch(touch.up(4, RIGHT - 50, Y))).toBe('tap');
    expect(intents).toHaveLength(0);
    // Unchanged geometry (a re-measure of the same size) does not.
    touch.down(5, LEFT, Y, { isPrimary: true });
    viewport.refresh();
    expect(viewport.releaseTouch(touch.up(5, LEFT, Y))).toBe('navigate');
  });

  it('a primary touch discards a sequence whose lift never reached the surface', () => {
    const { touch, intents, viewport } = navSetup();
    touch.down(1, 700, Y, { isPrimary: true });
    viewport.cancelTouch();
    // Pointer 1 lifted elsewhere; a fresh touch is a fresh sequence.
    touch.tap(2, RIGHT);
    expect(intents).toHaveLength(1);
    // A non-primary finger while a sequence is down joins it instead.
    touch.down(3, 700, Y, { isPrimary: true });
    touch.down(4, LEFT, Y);
    touch.up(3, 700, Y);
    expect(viewport.releaseTouch(touch.up(4, LEFT, Y))).toBe('consumed');
    expect(intents).toHaveLength(1);
  });

  it('works without content (loading or failed item) but not without an owner', () => {
    const { touch, intents, viewport } = navSetup();
    viewport.clearContent();
    touch.swipe(1, 700, 500);
    expect(intents).toHaveLength(1);
    const surface = makeSurface(1000, 800);
    const bare = createViewerViewport({ surface });
    bare.setContent(makeContent(), { width: 2000, height: 1000 });
    surface.fire('pointerdown', { pointerId: 9, pointerType: 'touch', isPrimary: true, clientX: 700, clientY: Y });
    surface.fire('pointermove', { pointerId: 9, pointerType: 'touch', clientX: 400, clientY: Y });
    expect(bare.releaseTouch({ pointerId: 9, pointerType: 'touch', clientX: 400, clientY: Y })).toBe('drag');
  });

  it('mouse and pen drags and clicks never navigate', () => {
    const { surface, intents, viewport } = navSetup();
    for (const pointerType of ['mouse', 'pen']) {
      surface.fire('pointerdown', { pointerId: 20, pointerType, clientX: 700, clientY: Y });
      surface.fire('pointermove', { pointerId: 20, pointerType, clientX: 300, clientY: Y });
      surface.fire('pointerup', { pointerId: 20, pointerType, clientX: 300, clientY: Y });
      surface.fire('pointerdown', { pointerId: 21, pointerType, clientX: LEFT, clientY: Y });
      surface.fire('pointerup', { pointerId: 21, pointerType, clientX: LEFT, clientY: Y });
    }
    expect(intents).toHaveLength(0);
    // A mouse pan of an enlarged image still works.
    viewport.actualSize();
    surface.fire('pointerdown', { pointerId: 22, pointerType: 'mouse', clientX: 700, clientY: Y });
    surface.fire('pointermove', { pointerId: 22, pointerType: 'mouse', clientX: 600, clientY: Y });
    surface.fire('pointerup', { pointerId: 22, pointerType: 'mouse', clientX: 600, clientY: Y });
    expect(viewport.getState().panX).toBe(-100);
    expect(intents).toHaveLength(0);
  });

  describe('follow-up click guard', () => {
    const clickAt = (document, x, y = Y, extra = {}) => document.fire('click', { clientX: x, clientY: y, detail: 1, ...extra });

    it('swallows exactly the click that follows a navigating tap', () => {
      const { touch, document } = navSetup();
      touch.tap(1, RIGHT);
      expect(document.listeners.map((entry) => entry.type).sort()).toEqual(['click', 'pointercancel', 'pointerdown', 'pointerup']);
      expect(document.listeners.every((entry) => entry.capture === true)).toBe(true);
      const first = clickAt(document, RIGHT + 2);
      expect(first).toMatchObject({ defaultPrevented: true, stopped: true });
      expect(document.listeners).toHaveLength(0);
      const second = clickAt(document, RIGHT);
      expect(second).toMatchObject({ defaultPrevented: false, stopped: false });
    });

    it('never swallows mouse, pen, keyboard or distant clicks, and a chrome tap arms nothing', () => {
      const { touch, document } = navSetup();
      touch.tap(1, CENTER);
      expect(document.listeners).toHaveLength(0);
      touch.tap(2, RIGHT);
      for (const extra of [{ pointerType: 'mouse' }, { pointerType: 'pen' }, { pointerType: '', detail: 0 }]) {
        expect(clickAt(document, RIGHT, Y, extra).defaultPrevented).toBe(false);
      }
      expect(clickAt(document, RIGHT - VIEWER_CLICK_GUARD_RADIUS - 1).defaultPrevented).toBe(false);
      expect(clickAt(document, RIGHT).defaultPrevented).toBe(true);
    });

    it('is disarmed by a new pointer, by its window ending, and by destroy', () => {
      vi.useFakeTimers();
      try {
        const { touch, document, viewport } = navSetup();
        touch.tap(1, RIGHT);
        document.fire('pointerdown', { pointerId: 2, pointerType: 'mouse' });
        expect(document.listeners).toHaveLength(0);
        expect(clickAt(document, RIGHT).defaultPrevented).toBe(false);
        touch.tap(3, RIGHT);
        vi.advanceTimersByTime(VIEWER_CLICK_GUARD_WINDOW);
        expect(document.listeners).toHaveLength(0);
        expect(clickAt(document, RIGHT).defaultPrevented).toBe(false);
        touch.tap(4, RIGHT);
        viewport.destroy();
        expect(document.listeners).toHaveLength(0);
        expect(clickAt(document, RIGHT).defaultPrevented).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('guards a pan, a pinch and an invalidated touch, waiting for fingers that lift elsewhere', () => {
      const { touch, document, viewport } = navSetup();
      viewport.actualSize();
      touch.swipe(1, 700, 690);
      expect(clickAt(document, 690).defaultPrevented).toBe(true);
      viewport.fit();
      touch.down(2, 500, Y, { isPrimary: true });
      touch.down(3, 700, Y);
      touch.up(2, 500, Y);
      touch.up(3, 700, Y);
      expect(clickAt(document, 500).defaultPrevented).toBe(true);
      // Invalidated while down; the lift lands outside the surface (the viewer closed).
      touch.down(4, LEFT, Y, { isPrimary: true });
      viewport.cancelTouch();
      expect(clickAt(document, LEFT).defaultPrevented).toBe(false);
      document.fire('pointerup', { pointerId: 4, clientX: LEFT + 3, clientY: Y });
      expect(clickAt(document, LEFT + 3).defaultPrevented).toBe(true);
      // A cancelled touch sends no click: nothing stays armed.
      touch.down(5, LEFT, Y, { isPrimary: true });
      viewport.cancelTouch();
      document.fire('pointercancel', { pointerId: 5 });
      expect(document.listeners).toHaveLength(0);
    });
  });
});

// ─── D1-C: the surface consumes touchmove (no hidden browser fling) ─────────

describe('viewer viewport touchmove consumption (D1-C)', () => {
  it('consumes every cancelable touchmove on the surface, non-passively', () => {
    const surface = makeSurface(1000, 800);
    const added = [];
    const add = surface.addEventListener;
    surface.addEventListener = (type, handler, options) => {
      added.push({ type, options });
      add.call(surface, type, handler, options);
    };
    const viewport = createViewerViewport({ surface });
    expect(added.find((entry) => entry.type === 'touchmove')).toEqual({ type: 'touchmove', options: { passive: false } });
    // At Fit, enlarged, with or without content: the browser never gets the stroke.
    for (const prepare of [() => {}, () => viewport.setContent(makeContent(), { width: 2000, height: 1000 }), () => viewport.zoomIn()]) {
      prepare();
      expect(surface.fire('touchmove', { cancelable: true }).defaultPrevented).toBe(true);
    }
    // A touchmove the browser already declared uncancelable is left alone.
    expect(surface.fire('touchmove', { cancelable: false }).defaultPrevented).toBe(false);
    viewport.destroy();
    expect(surface.listeners.some((entry) => entry.type === 'touchmove')).toBe(false);
  });

  it('pointer classification is unchanged by the consumed touchmove', () => {
    const surface = makeSurface(1000, 800);
    const intents = [];
    const viewport = createViewerViewport({
      surface,
      touchNavigation: { identity: () => 'item', navigate: (intent) => { intents.push(intent.side); return true; } },
    });
    viewport.setContent(makeContent(), { width: 600, height: 400 });
    const touch = { pointerType: 'touch', isPrimary: true, clientY: 400 };
    surface.fire('pointerdown', { ...touch, pointerId: 9, clientX: 700 });
    surface.fire('pointermove', { ...touch, pointerId: 9, clientX: 400 });
    surface.fire('touchmove', { cancelable: true });
    const up = surface.fire('pointerup', { ...touch, pointerId: 9, clientX: 400 });
    expect(viewport.releaseTouch(up)).toBe('navigate');
    expect(intents).toEqual(['right']);
    viewport.destroy();
  });
});

describe('viewer viewport follow-up click guard for another participant (D1-C)', () => {
  function guardSetup() {
    const listeners = [];
    const document = {
      listeners,
      addEventListener: (type, handler, capture) => listeners.push({ type, handler, capture }),
      removeEventListener: (type, handler, capture) => {
        const index = listeners.findIndex((entry) => entry.type === type && entry.handler === handler && entry.capture === capture);
        if (index >= 0) listeners.splice(index, 1);
      },
      fire(type, props = {}) {
        const event = { type, defaultPrevented: false, stopped: false,
          preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...props };
        listeners.filter((entry) => entry.type === type).forEach((entry) => entry.handler(event));
        return event;
      },
    };
    const surface = makeSurface(1000, 800);
    surface.ownerDocument = document;
    const viewport = createViewerViewport({ surface });
    return { document, viewport };
  }

  it('swallows only the touch click near the revealing touch, once', () => {
    vi.useFakeTimers();
    try {
      const { document, viewport } = guardSetup();
      viewport.guardTouchClick({ pointerType: 'mouse', clientX: 10, clientY: 10 });
      expect(document.listeners).toHaveLength(0);
      viewport.guardTouchClick({ pointerType: 'touch', pointerId: 4, clientX: 500, clientY: 700 });
      expect(document.listeners.map((entry) => entry.type).sort()).toEqual(['click', 'pointercancel', 'pointerdown', 'pointerup']);
      // A mouse click, or one far away, is not the touch's click.
      expect(document.fire('click', { pointerType: 'mouse', clientX: 500, clientY: 700 }).defaultPrevented).toBe(false);
      expect(document.fire('click', { pointerType: 'touch', clientX: 900, clientY: 100 }).defaultPrevented).toBe(false);
      const click = document.fire('click', { pointerType: 'touch', clientX: 510, clientY: 700 });
      expect(click).toMatchObject({ defaultPrevented: true, stopped: true });
      expect(document.listeners).toHaveLength(0);
      // A new touch disarms it, and the window ends it.
      viewport.guardTouchClick({ pointerType: 'touch', pointerId: 5, clientX: 500, clientY: 700 });
      document.fire('pointerdown', { pointerId: 6 });
      expect(document.listeners).toHaveLength(0);
      viewport.guardTouchClick({ pointerType: 'touch', pointerId: 7, clientX: 500, clientY: 700 });
      vi.advanceTimersByTime(800);
      expect(document.listeners).toHaveLength(0);
      viewport.destroy();
      viewport.guardTouchClick({ pointerType: 'touch', pointerId: 8, clientX: 500, clientY: 700 });
      expect(document.listeners).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
