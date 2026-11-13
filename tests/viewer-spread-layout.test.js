import { describe, expect, it, vi } from 'vitest';
import {
  classifyViewerSpreadChange,
  computeViewerSpreadGeometry,
  createViewerSpreadLayout,
  normalizeViewerSpreadSlots,
  presentViewerSpread,
  VIEWER_SPREAD_CHANGE_GROUP,
  VIEWER_SPREAD_CHANGE_NONE,
  VIEWER_SPREAD_CHANGE_ORDER,
  VIEWER_SPREAD_CHANGE_SIZE,
  VIEWER_SPREAD_FALLBACK_SIZE,
  VIEWER_SPREAD_GUTTER_RATIO,
  VIEWER_SPREAD_MAX_DIMENSION,
} from '../src/static/client/viewer-spread-layout.js';
import { createViewerViewport } from '../src/static/client/viewer-viewport.js';
import {
  createViewerSource,
  resolveComicPageGroup,
  VIEWER_READING_LTR,
  VIEWER_READING_RTL,
  VIEWER_SOURCE_KIND_COMIC,
} from '../src/static/client/viewer-sequence.js';

// Comic spread geometry and DOM. Pure geometry plus the layout helper
// against a minimal DOM stand-in; real layout, CSS and the shared viewport
// are covered in Chromium (tests/browser/comic-spread-layout.spec.js).

class FakeNode {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.attributes = new Map();
    this.style = {};
    this.childList = [];
    this.parentNode = null;
  }
  get children() { return this.childList.slice(); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  removeAttribute(name) { this.attributes.delete(name); }
  detach(node) {
    const index = this.childList.indexOf(node);
    if (index >= 0) this.childList.splice(index, 1);
    node.parentNode = null;
  }
  appendChild(node) { return this.insertBefore(node, null); }
  insertBefore(node, reference) {
    node.parentNode?.detach(node);
    const index = reference ? this.childList.indexOf(reference) : -1;
    if (index >= 0) this.childList.splice(index, 0, node);
    else this.childList.push(node);
    node.parentNode = this;
    this.insertions = (this.insertions || 0) + 1;
    return node;
  }
  replaceChildren(...nodes) {
    this.childList.slice().forEach((child) => this.detach(child));
    nodes.forEach((node) => this.appendChild(node));
  }
  remove() { this.parentNode?.detach(this); }
}

const fakeDocument = { createElement: (tag) => new FakeNode(tag) };

const pct = (value) => parseFloat(value);

const page = (key, width, height, extra = {}) => ({ key, width, height, state: 'loaded', ...extra });

function expectValidGeometry(geometry) {
  for (const value of [geometry.width, geometry.height, geometry.slotWidth, geometry.slotHeight, geometry.gutter]) {
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
  }
  for (const slot of geometry.slots) {
    for (const value of [slot.x, slot.y, slot.width, slot.height, slot.page.x, slot.page.y, slot.page.width, slot.page.height]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
    expect(slot.width).toBeGreaterThan(0);
    expect(slot.page.width).toBeGreaterThan(0);
    // The page box never leaves its slot (no cropping).
    expect(slot.page.x + slot.page.width).toBeLessThanOrEqual(slot.width + 1e-9);
    expect(slot.page.y + slot.page.height).toBeLessThanOrEqual(slot.height + 1e-9);
    expect(slot.x + slot.width).toBeLessThanOrEqual(geometry.width + 1e-9);
  }
}

function expectAspect(box, width, height) {
  expect(box.width / box.height).toBeCloseTo(width / height, 9);
}

describe('spread geometry', () => {
  it('is empty for no slots', () => {
    const geometry = computeViewerSpreadGeometry([]);
    expect(geometry).toMatchObject({ width: 0, height: 0, gutter: 0 });
    expect(geometry.slots).toHaveLength(0);
    expectValidGeometry(geometry);
  });

  it('makes one page its own centred slot with no gutter or second slot', () => {
    const geometry = computeViewerSpreadGeometry([page('a', 900, 1400)]);
    expect(geometry).toMatchObject({ width: 900, height: 1400, gutter: 0 });
    expect(geometry.slots).toHaveLength(1);
    expect(geometry.slots[0]).toMatchObject({ x: 0, y: 0, width: 900, height: 1400 });
    expect(geometry.slots[0].page).toEqual({ x: 0, y: 0, width: 900, height: 1400 });
  });

  it('lays two equal portrait pages edge to edge with zero gutter', () => {
    const geometry = computeViewerSpreadGeometry([page('a', 1000, 1500), page('b', 1000, 1500)]);
    const gutter = 0;
    expect(VIEWER_SPREAD_GUTTER_RATIO).toBe(0);
    expect(geometry.gutter).toBe(gutter);
    expect(geometry.width).toBe(2000 + gutter);
    expect(geometry.height).toBe(1500);
    expect(geometry.slots.map((slot) => slot.x)).toEqual([0, 1000 + gutter]);
    geometry.slots.forEach((slot) => expect(slot.page).toEqual({ x: 0, y: 0, width: 1000, height: 1500 }));
    expectValidGeometry(geometry);
  });

  it('gives mixed portrait/landscape pages equal slots from the maximum sizes, preserving each aspect', () => {
    const geometry = computeViewerSpreadGeometry([page('p', 900, 1600), page('l', 2400, 1600)]);
    expect(geometry).toMatchObject({ slotWidth: 2400, slotHeight: 1600 });
    const [portrait, landscape] = geometry.slots;
    expect(portrait.width).toBe(landscape.width);
    expect(portrait.height).toBe(landscape.height);
    expectAspect(portrait.page, 900, 1600);
    expectAspect(landscape.page, 2400, 1600);
    // Narrow pages meet the seam, leaving whitespace at the outer edge.
    expect(portrait.page).toEqual({ x: 1500, y: 0, width: 900, height: 1600 });
    expect(landscape.page).toEqual({ x: 0, y: 0, width: 2400, height: 1600 });
    expectValidGeometry(geometry);
  });

  it('handles two landscape pages and very unequal sizes without cropping or stretching', () => {
    const landscapes = computeViewerSpreadGeometry([page('a', 2000, 1000), page('b', 1600, 1200)]);
    expect(landscapes).toMatchObject({ slotWidth: 2000, slotHeight: 1200 });
    expectAspect(landscapes.slots[0].page, 2000, 1000);
    expectAspect(landscapes.slots[1].page, 1600, 1200);
    expectValidGeometry(landscapes);

    const unequal = computeViewerSpreadGeometry([page('tiny', 10, 4000), page('wide', 6000, 20)]);
    expectAspect(unequal.slots[0].page, 10, 4000);
    expectAspect(unequal.slots[1].page, 6000, 20);
    expectValidGeometry(unequal);
  });

  it('uses the known page for the slot and a neutral portrait placeholder for an unknown one', () => {
    const geometry = computeViewerSpreadGeometry([page('a', 1200, 1800), { key: 'b', state: 'pending' }]);
    expect(geometry).toMatchObject({ slotWidth: 1200, slotHeight: 1800 });
    const placeholder = geometry.slots[1];
    expect(placeholder.known).toBe(false);
    expectAspect(placeholder.page, VIEWER_SPREAD_FALLBACK_SIZE.width, VIEWER_SPREAD_FALLBACK_SIZE.height);
    // Both slots keep their allotted bounds.
    expect(placeholder.width).toBe(1200);
    expectValidGeometry(geometry);
  });

  it('uses the bounded fallback when no size is known, for pending, failed or unavailable pages', () => {
    for (const states of [['pending', 'pending'], ['failed', 'unavailable'], ['failed', 'failed']]) {
      const geometry = computeViewerSpreadGeometry(states.map((state, index) => ({ key: `k${index}`, state })));
      expect(geometry.slotWidth).toBe(VIEWER_SPREAD_FALLBACK_SIZE.width);
      expect(geometry.slotHeight).toBe(VIEWER_SPREAD_FALLBACK_SIZE.height);
      expect(geometry.width).toBeGreaterThan(0);
      expectValidGeometry(geometry);
    }
    const single = computeViewerSpreadGeometry([{ key: 'x', state: 'failed' }]);
    expect(single).toMatchObject({ width: 1000, height: 1500, gutter: 0 });
  });

  it('keeps a failed slot\'s geometry when its partner is loaded', () => {
    const geometry = computeViewerSpreadGeometry([page('a', 800, 1200), { key: 'b', state: 'failed', width: 0 }]);
    expect(geometry.slots[1]).toMatchObject({ x: 800 + 800 * VIEWER_SPREAD_GUTTER_RATIO, width: 800, height: 1200, known: false });
  });

  it('sanitizes malformed input', () => {
    const slots = normalizeViewerSpreadSlots([
      null,
      { key: '' },
      { key: 7 },
      { key: 'a', width: Number.NaN, height: 10, state: 'weird', position: 1.5 },
      { key: 'a', width: 100, height: 100 },
      { key: 'b', width: -5, height: Infinity, position: 2 },
      { key: 'c', width: 100, height: 100 },
    ]);
    expect(slots).toEqual([
      { key: 'a', position: null, width: 0, height: 0, state: 'pending' },
      { key: 'b', position: 2, width: 0, height: 0, state: 'pending' },
    ]);
    expect(normalizeViewerSpreadSlots('nope')).toEqual([]);
    expect(normalizeViewerSpreadSlots([{ key: 'big', width: 1e12, height: 1e12 }])[0].width).toBe(VIEWER_SPREAD_MAX_DIMENSION);
    expectValidGeometry(computeViewerSpreadGeometry([{ key: 'z', width: 1e-300, height: 1e300 }]));
    expectValidGeometry(computeViewerSpreadGeometry(undefined));
  });

  it('classifies group, size, order and no-op changes', () => {
    const a = computeViewerSpreadGeometry([page('1', 100, 150), page('2', 100, 150)]);
    const swapped = computeViewerSpreadGeometry([page('2', 100, 150), page('1', 100, 150)]);
    const grown = computeViewerSpreadGeometry([page('1', 100, 150), page('2', 200, 150)]);
    const other = computeViewerSpreadGeometry([page('3', 100, 150), page('4', 100, 150)]);
    expect(classifyViewerSpreadChange(null, a)).toBe(VIEWER_SPREAD_CHANGE_GROUP);
    expect(classifyViewerSpreadChange(a, a)).toBe(VIEWER_SPREAD_CHANGE_NONE);
    expect(classifyViewerSpreadChange(a, swapped)).toBe(VIEWER_SPREAD_CHANGE_ORDER);
    expect(classifyViewerSpreadChange(a, grown)).toBe(VIEWER_SPREAD_CHANGE_SIZE);
    expect(classifyViewerSpreadChange(a, other)).toBe(VIEWER_SPREAD_CHANGE_GROUP);
    expect(classifyViewerSpreadChange(a, computeViewerSpreadGeometry([page('1', 100, 150)]))).toBe(VIEWER_SPREAD_CHANGE_GROUP);
    // A page box that moves inside unchanged composition bounds is a size change.
    const pending = computeViewerSpreadGeometry([page('1', 100, 150), { key: '2' }]);
    const resolved = computeViewerSpreadGeometry([page('1', 100, 150), page('2', 100, 120)]);
    expect(classifyViewerSpreadChange(pending, resolved)).toBe(VIEWER_SPREAD_CHANGE_SIZE);
  });
});

function expectSeam(geometry) {
  expect(geometry.gutter).toBe(0);
  const [left, right] = geometry.slots;
  const leftEdge = left.x + left.page.x + left.page.width;
  const rightEdge = right.x + right.page.x;
  expect(leftEdge).toBeCloseTo(rightEdge, 9);
  expect(leftEdge).toBeCloseTo(geometry.width / 2, 9);
  expect(leftEdge).toBeLessThanOrEqual(rightEdge + 1e-9);
  geometry.slots.forEach((slot) => {
    expect(slot.page.y + slot.page.height / 2).toBeCloseTo(geometry.height / 2, 9);
  });
  expectValidGeometry(geometry);
}

describe('gapless actual page rectangles', () => {
  it.each([
    [1000, 1500, 1000, 1500],
    [900, 1500, 1000, 1500],
    [450, 1600, 1100, 1600],
    [1000, 1400, 1000, 1800],
    [900, 1600, 2400, 1600],
    [1000, 1700, 1900, 900],
    [913.7, 1500.3, 1061.1, 1700.9],
  ])('touches without overlap or distortion for %s×%s and %s×%s in either direction', (w1, h1, w2, h2) => {
    const slots = [page('a', w1, h1), page('b', w2, h2)];
    for (const ordered of [slots, slots.slice().reverse()]) {
      const geometry = computeViewerSpreadGeometry(ordered);
      expectSeam(geometry);
      geometry.slots.forEach((slot, index) => expectAspect(slot.page, ordered[index].width, ordered[index].height));
      expect(geometry.slots.map((slot) => slot.key)).toEqual(ordered.map((slot) => slot.key));
      expect(geometry.width).toBe(2 * Math.max(w1, w2));
    }
  });

  it('keeps the existing outer whitespace and intrinsic containment model', () => {
    const geometry = computeViewerSpreadGeometry([page('a', 900, 1600), page('b', 2400, 1600)]);
    expectSeam(geometry);
    expect(geometry.slots[0].page.x).toBe(1500);
    expect(geometry.width).toBe(4800);
    expect(geometry.slots[0].page.width).toBe(900);
    expect(geometry.slots[1].page.width).toBe(2400);
  });

  it('keeps placeholder edges together through independent loading, failure, Retry and late dimensions', () => {
    const layout = createViewerSpreadLayout({ document: fakeDocument });
    const states = [
      [{ key: 'a' }, { key: 'b' }],
      [page('a', 900, 1600), { key: 'b' }],
      [page('a', 900, 1600), { key: 'b', state: 'failed' }],
      [page('a', 900, 1600), { key: 'b', state: 'pending' }],
      [page('a', 900, 1600), page('b', 2400, 1000)],
    ];
    let kept;
    states.forEach((slots, index) => {
      const result = layout.update(slots);
      expectSeam(result.geometry);
      if (index === 0) kept = layout.getSlot('a');
      else expect(layout.getSlot('a').frame).toBe(kept.frame);
      expect(layout.update(slots).change).toBe(VIEWER_SPREAD_CHANGE_NONE);
    });
  });

  it.each(['cover-alone', 'pair-from-first'])('preserves %s grouping, cover, odd tail and single-page geometry', (alignment) => {
    for (const count of [1, 5]) {
      const source = createViewerSource({ key: 'groups', kind: VIEWER_SOURCE_KIND_COMIC,
        items: Array.from({ length: count }, (_, index) => ({ projectId: 1, assetId: 2, position: index + 1,
          mediaUrl: '/page/' + (index + 1), revision: 'r1' })) });
      for (const direction of ['ltr', 'rtl']) for (const layout of ['single', 'spread']) {
        for (const item of source.items) {
          const group = resolveComicPageGroup(source, item.key, { direction, layout, alignment });
          const geometry = computeViewerSpreadGeometry(group.visibleItems.map((entry) => page(entry.key, 900, 1600)));
          if (geometry.slots.length === 2) expectSeam(geometry);
          else expect(geometry).toMatchObject({ width: 900, height: 1600, gutter: 0,
            slots: [{ x: 0, page: { x: 0, y: 0, width: 900, height: 1600 } }] });
        }
      }
      expect(source.items.map((item) => item.position)).toEqual(Array.from({ length: count }, (_, index) => index + 1));
    }
  });
});

describe('spread visual order from the C1c reader contract', () => {
  const source = createViewerSource({
    key: 'comic:1',
    kind: VIEWER_SOURCE_KIND_COMIC,
    items: [1, 2, 3].map((position) => ({
      projectId: 7,
      assetId: 70,
      position,
      title: `Page ${position}`,
      mediaUrl: `/projects/7/assets/70/comic/pages/${position}?v=r1`,
      revision: 'r1',
    })),
  });
  const slotsFor = (direction) => {
    const group = resolveComicPageGroup(source, 'p:7|a:70|n:2', { direction, layout: 'spread', alignment: 'cover-alone' });
    return group.visibleItems.map((item) => ({ key: item.key, position: item.position, width: 100, height: 150, state: 'loaded' }));
  };

  it('places the earlier page left in LTR and right in RTL without changing identities', () => {
    const ltr = computeViewerSpreadGeometry(slotsFor(VIEWER_READING_LTR));
    const rtl = computeViewerSpreadGeometry(slotsFor(VIEWER_READING_RTL));
    const p2 = 'p:7|a:70|n:2';
    const p3 = 'p:7|a:70|n:3';
    expect(ltr.slots.map((slot) => [slot.key, slot.x])).toEqual([[p2, 0], [p3, 100]]);
    expect(rtl.slots.map((slot) => [slot.key, slot.x])).toEqual([[p3, 0], [p2, 100]]);
    expect(source.items.map((item) => item.position)).toEqual([1, 2, 3]);
  });
});

describe('spread layout DOM', () => {
  const create = () => createViewerSpreadLayout({ document: fakeDocument });

  it('creates one wrapper with positioned slots and page frames', () => {
    const layout = create();
    expect(layout.element.getAttribute('data-viewer-content')).toBe('spread');
    const result = layout.update([page('a', 900, 1600, { position: 1 }), page('b', 2400, 1600, { position: 2 })]);
    expect(result.change).toBe(VIEWER_SPREAD_CHANGE_GROUP);
    expect(result.size).toEqual({ width: 4800, height: 1600 });
    expect(layout.element.children).toHaveLength(2);
    const a = layout.getSlot('a');
    expect(a.slot.getAttribute('data-viewer-spread-state')).toBe('loaded');
    expect(pct(a.slot.style.left)).toBe(0);
    expect(pct(a.slot.style.width) * 2).toBeCloseTo(100, 9);
    expect(pct(a.frame.style.width)).toBeCloseTo(900 / 2400 * 100, 9);
    expect(pct(a.frame.style.left)).toBeCloseTo(1500 / 2400 * 100, 9);
    expect(pct(layout.getSlot('b').slot.style.left)).toBeCloseTo(50, 9);
    for (const value of [...Object.values(a.slot.style), ...Object.values(a.frame.style)]) {
      expect(value).toMatch(/^\d+(\.\d+)?(e-?\d+)?%$/);
    }
  });

  it('reorders by position only: no DOM move, same elements and contents, order change reported', () => {
    const layout = create();
    layout.update([page('a', 100, 150, { position: 1 }), page('b', 100, 150, { position: 2 })]);
    const a = layout.getSlot('a');
    const b = layout.getSlot('b');
    const image = new FakeNode('img');
    layout.setSlotContent('a', image);
    const insertions = layout.element.insertions;
    const result = layout.update([page('b', 100, 150, { position: 2 }), page('a', 100, 150, { position: 1 })]);
    expect(result.change).toBe(VIEWER_SPREAD_CHANGE_ORDER);
    expect(result.removed).toEqual([]);
    expect(layout.element.insertions).toBe(insertions);
    expect(layout.element.children).toEqual([a.slot, b.slot]);
    expect(layout.getSlot('a').slot).toBe(a.slot);
    expect(a.frame.children).toEqual([image]);
    expect(pct(b.slot.style.left)).toBe(0);
    expect(pct(a.slot.style.left)).toBe(50);
    expect(a.slot.getAttribute('data-viewer-spread-index')).toBe('1');
  });

  it('keeps elements and reports a size change when a page resolves', () => {
    const layout = create();
    layout.update([page('a', 1000, 1500), { key: 'b', state: 'pending' }]);
    const b = layout.getSlot('b');
    const result = layout.update([page('a', 1000, 1500), page('b', 2000, 1500)]);
    expect(result.change).toBe(VIEWER_SPREAD_CHANGE_SIZE);
    expect(layout.getSlot('b').slot).toBe(b.slot);
    expect(b.slot.getAttribute('data-viewer-spread-state')).toBe('loaded');
  });

  it('removes obsolete slots, reuses kept ones and inserts new ones in canonical order', () => {
    const layout = create();
    layout.update([page('p2', 100, 150, { position: 2 }), page('p3', 100, 150, { position: 3 })]);
    const p3 = layout.getSlot('p3').slot;
    // An alignment change keeps p3 and pairs it with p4 instead (RTL visual order).
    const result = layout.update([page('p4', 100, 150, { position: 4 }), page('p3', 100, 150, { position: 3 })]);
    expect(result.change).toBe(VIEWER_SPREAD_CHANGE_GROUP);
    expect(result.removed).toEqual(['p2']);
    expect(layout.getSlot('p2')).toBeNull();
    expect(layout.getSlot('p3').slot).toBe(p3);
    expect(layout.element.children.map((node) => node.getAttribute('data-viewer-spread-slot'))).toEqual(['p3', 'p4']);
    expect(layout.setSlotContent('p2', new FakeNode('img'))).toBe(false);

    const final = layout.update([page('p5', 100, 150, { position: 5 })]);
    expect(final.removed.slice().sort()).toEqual(['p3', 'p4']);
    expect(layout.element.children).toHaveLength(1);
    expect(layout.element.getAttribute('data-viewer-spread-count')).toBe('1');
    expect(final.size).toEqual({ width: 100, height: 150 });

    const empty = layout.clear();
    expect(empty.size).toEqual({ width: 0, height: 0 });
    expect(layout.element.children).toHaveLength(0);
  });

  it('is inert after destroy', () => {
    const parent = new FakeNode('div');
    const layout = create();
    parent.appendChild(layout.element);
    layout.update([page('a', 10, 10)]);
    layout.destroy();
    expect(parent.children).toHaveLength(0);
    expect(layout.update([page('a', 10, 10)])).toBeNull();
    layout.destroy();
  });
});

describe('presentViewerSpread policies', () => {
  function setup() {
    const surface = {
      clientWidth: 1000,
      clientHeight: 800,
      attributes: new Map(),
      setAttribute(name, value) { this.attributes.set(name, String(value)); },
      removeAttribute(name) { this.attributes.delete(name); },
      addEventListener() {},
      removeEventListener() {},
    };
    const viewport = createViewerViewport({ surface });
    const layout = createViewerSpreadLayout({ document: fakeDocument });
    return { surface, viewport, layout };
  }

  it('starts a group in Fit, resizes in place, keeps the transform for a reorder and clears when empty', () => {
    const { surface, viewport, layout } = setup();
    expect(presentViewerSpread(viewport, layout, layout.update([page('a', 1000, 1500, { position: 1 }), { key: 'b', position: 2 }]))).toBe('content');
    expect(viewport.getState()).toMatchObject({ mode: 'fit', composite: true, contentWidth: 2000, contentHeight: 1500 });
    expect(surface.attributes.has('data-viewer-composite')).toBe(true);
    viewport.zoomIn();
    viewport.zoomIn();
    viewport.panBy(-40, 30);
    const zoomed = viewport.getState();

    expect(presentViewerSpread(viewport, layout, layout.update([page('b', 1000, 1500, { position: 2 }), page('a', 1000, 1500, { position: 1 })]))).toBe('kept');
    expect(viewport.getState()).toMatchObject({ scale: zoomed.scale, panX: zoomed.panX, panY: zoomed.panY });
    expect(layout.element.style.transform).toBe(`translate(${zoomed.panX - 2000 * zoomed.scale / 2}px, ${zoomed.panY - 1500 * zoomed.scale / 2}px)`);

    expect(presentViewerSpread(viewport, layout, layout.update([page('b', 2000, 1500, { position: 2 }), page('a', 1000, 1500, { position: 1 })]))).toBe('resize');
    const resized = viewport.getState();
    expect(resized.scale / resized.fitScale).toBeCloseTo(zoomed.scale / zoomed.fitScale, 9);

    expect(presentViewerSpread(viewport, layout, layout.update([page('c', 1000, 1500, { position: 3 })]))).toBe('content');
    expect(viewport.getState()).toMatchObject({ mode: 'fit', panX: 0, panY: 0, contentWidth: 1000 });

    expect(presentViewerSpread(viewport, layout, layout.clear())).toBe('cleared');
    expect(viewport.getState().hasContent).toBe(false);
    expect(surface.attributes.has('data-viewer-composite')).toBe(false);
    expect(presentViewerSpread(viewport, layout, layout.clear())).toBe('none');
    expect(presentViewerSpread(null, layout, null)).toBe('none');
  });

  it.each([[240, 340], [1440, 900], [1440, 260], [913.5, 611.25]])('keeps actual edges together in Fit, zoom, Original size, pan and resize at %s×%s', (width, height) => {
    const { surface, viewport, layout } = setup();
    surface.clientWidth = width;
    surface.clientHeight = height;
    const result = layout.update([page('a', 913.7, 1500.3), page('b', 1900.1, 900.9)]);
    presentViewerSpread(viewport, layout, result);
    const check = () => {
      const geometry = layout.getGeometry();
      expectSeam(geometry);
      const state = viewport.getState();
      const [left, right] = geometry.slots;
      const origin = state.panX - geometry.width * state.scale / 2;
      expect(origin + (left.x + left.page.x + left.page.width) * state.scale)
        .toBeCloseTo(origin + (right.x + right.page.x) * state.scale, 9);
      expect(Math.abs(state.panX)).toBeLessThanOrEqual(state.maxPanX + 1e-9);
      expect(Math.abs(state.panY)).toBeLessThanOrEqual(state.maxPanY + 1e-9);
      return state;
    };
    const fit = check();
    expect(fit.scale).toBeCloseTo(Math.min(1, width / result.size.width, height / result.size.height), 9);
    viewport.zoomIn(); check();
    viewport.panBy(75, -40); check();
    viewport.zoomOut(); check();
    viewport.actualSize();
    expect(check().scale).toBe(1);
    surface.clientWidth = 1920;
    surface.clientHeight = 1080;
    viewport.refresh(); check();
    viewport.fit(); check();
    viewport.destroy();
  });

  it('re-presents a composition the viewport no longer shows', () => {
    const { viewport, layout } = setup();
    const result = layout.update([page('a', 100, 150)]);
    presentViewerSpread(viewport, layout, result);
    viewport.clearContent();
    const onChange = vi.fn();
    expect(presentViewerSpread(viewport, layout, layout.update([page('a', 100, 150)]))).toBe('content');
    expect(viewport.isContent(layout.element)).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });
});
