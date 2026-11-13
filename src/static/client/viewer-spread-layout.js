// ─── Unified viewer: comic spread composition ────────────────────────────────
//
// Geometry and DOM for a comic composition of zero, one or two page slots,
// shown as ONE content element of the shared viewer viewport
// (viewer-viewport.js). The viewport alone scales and moves the composition
// wrapper, so both pages share one Fit, one zoom level and one pan.
//
// Geometry model (composition units = intrinsic image pixels):
// - Two slots are equally sized: the slot is as wide as the widest known page
//   and as tall as the tallest known page. Each page is contained in its slot
//   with its own aspect ratio (never stretched or cropped), vertically
//   centred and aligned to the shared inner edge. Slots have no gutter;
//   unequal pages leave whitespace only at the outer edges.
// - One slot is exactly its page: no reserved second slot, no gutter.
// - A page whose size is not known yet (pending, failed, unavailable)
//   occupies a neutral portrait placeholder (VIEWER_SPREAD_FALLBACK_SIZE
//   ratio) contained in its slot; with no known page at all the slot itself
//   is the fallback size.
// - Slot and page boxes are written as percentages of their parent, so a
//   zoom or pan never touches them: the viewport sets the wrapper's
//   width/height/transform only.
//
// Order: slots arrive in VISUAL left-to-right order (the
// reader.visibleItems). Their DOM order is canonical reading order (by
// `position` when every slot has one), so a direction change only swaps the
// percentage positions: no element is moved, re-created or refetched, and
// focus inside a slot is kept.
//
// It never fetches, decodes, owns object URLs, retries, navigates, groups
// pages or touches fullscreen. The content participant mounts media and states
// into each slot's frame (`setSlotContent`) and presents the composition
// through `presentViewerSpread`.

export const VIEWER_SPREAD_MAX_SLOTS = 2;
export const VIEWER_SPREAD_GUTTER_RATIO = 0;
export const VIEWER_SPREAD_FALLBACK_SIZE = Object.freeze({ width: 1000, height: 1500 });
// Upper bound for any page dimension the composition accepts.
export const VIEWER_SPREAD_MAX_DIMENSION = 65536;

export const VIEWER_SPREAD_SLOT_PENDING = 'pending';
export const VIEWER_SPREAD_SLOT_LOADED = 'loaded';
export const VIEWER_SPREAD_SLOT_FAILED = 'failed';
export const VIEWER_SPREAD_SLOT_UNAVAILABLE = 'unavailable';
const SLOT_STATES = new Set([
  VIEWER_SPREAD_SLOT_PENDING,
  VIEWER_SPREAD_SLOT_LOADED,
  VIEWER_SPREAD_SLOT_FAILED,
  VIEWER_SPREAD_SLOT_UNAVAILABLE,
]);

// How a composition update relates to the previous one.
export const VIEWER_SPREAD_CHANGE_NONE = 'none';     // nothing visible changed
export const VIEWER_SPREAD_CHANGE_ORDER = 'order';   // same pages and size, slots swapped
export const VIEWER_SPREAD_CHANGE_SIZE = 'size';     // same pages, new composition size
export const VIEWER_SPREAD_CHANGE_GROUP = 'group';   // a different set of pages

function dimension(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(VIEWER_SPREAD_MAX_DIMENSION, number);
}

/**
 * Sanitize slot descriptors: at most VIEWER_SPREAD_MAX_SLOTS entries with a
 * non-empty unique string key, in the given (visual) order. Invalid sizes
 * become 0 (unknown); unknown states become 'pending'.
 *
 * @param {Array<{ key: string, position?: number, width?: number, height?: number, state?: string }>} slots
 * @returns {ReadonlyArray<Readonly<{ key: string, position: number|null, width: number, height: number, state: string }>>}
 */
export function normalizeViewerSpreadSlots(slots) {
  const list = [];
  const seen = new Set();
  for (const raw of Array.isArray(slots) ? slots : []) {
    if (list.length >= VIEWER_SPREAD_MAX_SLOTS) break;
    const key = typeof raw?.key === 'string' ? raw.key : '';
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const width = dimension(raw.width);
    const height = dimension(raw.height);
    const known = width > 0 && height > 0;
    const position = Number.isInteger(raw.position) && raw.position > 0 ? raw.position : null;
    list.push(Object.freeze({
      key,
      position,
      width: known ? width : 0,
      height: known ? height : 0,
      state: SLOT_STATES.has(raw.state) ? raw.state : VIEWER_SPREAD_SLOT_PENDING,
    }));
  }
  return Object.freeze(list);
}

function contain(size, box) {
  const scale = Math.min(box.width / size.width, box.height / size.height);
  const width = size.width * scale;
  const height = size.height * scale;
  return { x: (box.width - width) / 2, y: (box.height - height) / 2, width, height };
}

/**
 * Pure composition geometry for normalized (or raw) slots in visual order.
 * Every number is finite; sizes are positive whenever there is a slot. An
 * empty composition is 0×0 with no slots.
 *
 * @returns {Readonly<{ width: number, height: number, slotWidth: number,
 *   slotHeight: number, gutter: number, slots: ReadonlyArray<{ key, x, y,
 *   width, height, known, page: { x, y, width, height } }> }>}
 *   Slot boxes are in composition units; `page` is the contained page box
 *   relative to its slot.
 */
export function computeViewerSpreadGeometry(slots) {
  const list = normalizeViewerSpreadSlots(slots);
  if (list.length === 0) {
    return Object.freeze({ width: 0, height: 0, slotWidth: 0, slotHeight: 0, gutter: 0, slots: Object.freeze([]) });
  }
  const known = list.filter((slot) => slot.width > 0);
  const slotWidth = known.length ? Math.max(...known.map((slot) => slot.width)) : VIEWER_SPREAD_FALLBACK_SIZE.width;
  const slotHeight = known.length ? Math.max(...known.map((slot) => slot.height)) : VIEWER_SPREAD_FALLBACK_SIZE.height;
  const box = { width: slotWidth, height: slotHeight };
  const gutter = list.length > 1 ? slotWidth * VIEWER_SPREAD_GUTTER_RATIO : 0;
  const placed = list.map((slot, index) => {
    const isKnown = slot.width > 0;
    const page = contain(isKnown ? slot : VIEWER_SPREAD_FALLBACK_SIZE, box);
    if (list.length === 2) {
      // Align actual page edges, including narrow pages and placeholders.
      page.x = index === 0 ? slotWidth - page.width : 0;
    }
    return Object.freeze({
      key: slot.key,
      x: index * (slotWidth + gutter),
      y: 0,
      width: slotWidth,
      height: slotHeight,
      known: isKnown,
      page: Object.freeze(page),
    });
  });
  return Object.freeze({
    width: list.length * slotWidth + gutter * (list.length - 1),
    height: slotHeight,
    slotWidth,
    slotHeight,
    gutter,
    slots: Object.freeze(placed),
  });
}

/**
 * Classify the move from one geometry to the next (see VIEWER_SPREAD_CHANGE_*).
 * A missing previous geometry is a group change.
 */
export function classifyViewerSpreadChange(previous, next) {
  const before = previous?.slots || [];
  const after = next?.slots || [];
  if (!previous) return VIEWER_SPREAD_CHANGE_GROUP;
  const keysBefore = before.map((slot) => slot.key);
  const keysAfter = after.map((slot) => slot.key);
  if (keysBefore.length !== keysAfter.length || keysAfter.some((key) => !keysBefore.includes(key))) {
    return VIEWER_SPREAD_CHANGE_GROUP;
  }
  if (previous.width !== next.width || previous.height !== next.height) return VIEWER_SPREAD_CHANGE_SIZE;
  if (keysAfter.some((key, index) => key !== keysBefore[index])) return VIEWER_SPREAD_CHANGE_ORDER;
  const moved = after.some((slot, index) => {
    const old = before[index];
    return old.page.x !== slot.page.x || old.page.y !== slot.page.y
      || old.page.width !== slot.page.width || old.page.height !== slot.page.height;
  });
  return moved ? VIEWER_SPREAD_CHANGE_SIZE : VIEWER_SPREAD_CHANGE_NONE;
}

const percent = (part, whole) => `${whole > 0 ? (part / whole) * 100 : 0}%`;

/**
 * Create the composition DOM. `element` is the one content element handed
 * to the viewport; it must be placed in the viewer's media region by the
 * caller (C1e).
 *
 * @param {{ document: Document }} options
 */
export function createViewerSpreadLayout({ document } = {}) {
  const element = document.createElement('div');
  element.setAttribute('class', 'unified-viewer-spread');
  element.setAttribute('data-viewer-content', 'spread');
  element.setAttribute('data-viewer-spread-count', '0');
  // key → { slot, frame }
  const entries = new Map();
  let geometry = computeViewerSpreadGeometry([]);
  let destroyed = false;

  function createEntry(key) {
    const slot = document.createElement('div');
    slot.setAttribute('class', 'unified-viewer-spread-slot');
    slot.setAttribute('data-viewer-spread-slot', key);
    const frame = document.createElement('div');
    frame.setAttribute('class', 'unified-viewer-spread-page');
    frame.setAttribute('data-viewer-spread-page', '');
    slot.appendChild(frame);
    return { slot, frame };
  }

  function place(entry, box, index, state) {
    const { slot, frame } = entry;
    slot.setAttribute('data-viewer-spread-index', String(index));
    slot.setAttribute('data-viewer-spread-state', state);
    slot.style.left = percent(box.x, geometry.width);
    slot.style.top = percent(box.y, geometry.height);
    slot.style.width = percent(box.width, geometry.width);
    slot.style.height = percent(box.height, geometry.height);
    frame.style.left = percent(box.page.x, box.width);
    frame.style.top = percent(box.page.y, box.height);
    frame.style.width = percent(box.page.width, box.width);
    frame.style.height = percent(box.page.height, box.height);
  }

  /**
   * Reconcile the composition with `slots` (visual left-to-right order).
   * Slots whose key is kept keep their elements and contents; obsolete ones
   * are removed from the DOM (their contents are the caller's to release).
   *
   * @returns {Readonly<{ geometry, change: string, size: { width, height }, removed: string[] }>}
   */
  function update(slots) {
    if (destroyed) return null;
    const list = normalizeViewerSpreadSlots(slots);
    const previous = entries.size || geometry.slots.length ? geometry : null;
    const next = computeViewerSpreadGeometry(list);
    const change = classifyViewerSpreadChange(previous, next);
    geometry = next;

    const removed = [];
    const wanted = new Set(list.map((slot) => slot.key));
    for (const [key, entry] of entries) {
      if (wanted.has(key)) continue;
      entry.slot.remove();
      entries.delete(key);
      removed.push(key);
    }
    list.forEach((slot, index) => {
      let entry = entries.get(slot.key);
      if (!entry) {
        entry = createEntry(slot.key);
        entries.set(slot.key, entry);
      }
      place(entry, next.slots[index], index, slot.state);
    });

    // DOM order is canonical reading order; only newly created slots are
    // ever inserted, so kept slots (and focus inside them) never move.
    const canonical = list.every((slot) => slot.position !== null)
      ? list.slice().sort((a, b) => a.position - b.position)
      : list;
    canonical.forEach((slot, index) => {
      const { slot: node } = entries.get(slot.key);
      const at = element.children[index] || null;
      if (at !== node) element.insertBefore(node, at);
    });

    element.setAttribute('data-viewer-spread-count', String(list.length));
    return Object.freeze({
      geometry: next,
      change,
      size: Object.freeze({ width: next.width, height: next.height }),
      removed: Object.freeze(removed),
    });
  }

  /** The slot box and page frame of a page, or null. */
  function getSlot(key) {
    const entry = entries.get(key);
    return entry ? Object.freeze({ slot: entry.slot, frame: entry.frame }) : null;
  }

  /** Replace a page frame's contents (image, loading or failure panel). */
  function setSlotContent(key, ...nodes) {
    const entry = entries.get(key);
    if (!entry) return false;
    entry.frame.replaceChildren(...nodes.filter(Boolean));
    return true;
  }

  function clear() {
    return update([]);
  }

  function destroy() {
    if (destroyed) return;
    clear();
    destroyed = true;
    element.remove();
  }

  return Object.freeze({
    element,
    update,
    getSlot,
    setSlotContent,
    getGeometry: () => geometry,
    clear,
    destroy,
  });
}

/**
 * Apply an `update()` result to the shared viewport with the approved
 * policies:
 * - group change (or the viewport is not showing this composition): new
 *   content, starting in Fit and centred;
 * - size change: in-place resize (Fit re-fits and re-centres; a zoom keeps
 *   its level relative to Fit and its pan is re-clamped);
 * - order/none: nothing (zoom and pan are kept).
 * An empty composition clears the viewport if it was showing it.
 *
 * @returns {'content'|'resize'|'kept'|'cleared'|'none'}
 */
export function presentViewerSpread(viewport, layout, result) {
  if (!viewport || !layout || !result) return 'none';
  const showing = viewport.isContent(layout.element);
  const { width, height } = result.size;
  if (!width || !height) {
    if (showing) viewport.clearContent();
    return showing ? 'cleared' : 'none';
  }
  if (!showing || result.change === VIEWER_SPREAD_CHANGE_GROUP) {
    viewport.setContent(layout.element, result.size, { composite: true });
    return 'content';
  }
  if (result.change === VIEWER_SPREAD_CHANGE_SIZE) {
    viewport.resizeContent(result.size);
    return 'resize';
  }
  return 'kept';
}
