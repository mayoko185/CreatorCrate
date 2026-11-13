import { describe, expect, it, vi } from 'vitest';
import {
  clampViewerPan,
  computeFitScale,
  computePanLimits,
  createViewerViewport,
  nextViewerZoomScale,
  VIEWER_MAX_ZOOM,
  VIEWER_ZOOM_STEP,
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

  it('ends the drag on cancel or lost capture and ignores touch and secondary buttons', () => {
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

    expect(surface.fire('pointerdown', { pointerType: 'touch' }).defaultPrevented).toBe(false);
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
