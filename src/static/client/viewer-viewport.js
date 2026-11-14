// ─── Unified viewer: viewport geometry, zoom and pan ─────────────────────────
//
// Owns the geometry of the one image shown in the unified viewer: Fit,
// button zoom and bounded pan, all through a single transform model. The
// content element is positioned at the surface's centre and sized to
// `intrinsic × scale`; `pan` is the offset of its centre from the surface's
// centre, clamped so the image never leaves an empty gap on a side it
// overflows. Nothing else sets the content element's size or transform.
//
// - Geometry is measured from the viewing surface (clientWidth/clientHeight)
//   only, never from document scroll or page coordinates, and is recomputed
//   on resize (ResizeObserver, else the window's resize event) or on demand
//   through `refresh()` — B4 calls it when fullscreen changes the space.
// - Fit is contained (never stretched, never upscaled past 1:1) and centred.
// - Pointer pan follows mouse and pen drags with pointer capture.
// - D1-A: touch contacts are tracked by pointerId (at most two; extras are
//   ignored). One contact pans while the content overflows; at Fit it is
//   only tracked (D1-B owns Fit-state swipe/tap). Two contacts pinch: the
//   scale follows the change in contact distance, bounded to [Fit, max],
//   and the content point under the contacts' midpoint stays under the
//   midpoint as it moves, subject to pan clamping. Every contact-count
//   change rebases the gesture from the current pan/scale, so nothing jumps.
//   A pointercancel or lost capture of a tracked contact abandons the whole
//   touch sequence (what was reached is kept); new or replaced content and
//   clear/destroy abandon it silently; a size change (resize, fullscreen,
//   a companion page resolving) rebases it on the new geometry. Touch relies
//   on the browser's implicit touch capture and never sets capture itself,
//   so a tap keeps its target. The CSS makes the media surface
//   `touch-action: none` so the browser hands the viewer its gestures.
// - D1-B: the same listeners are the viewer stage's ONE touch classifier.
//   Each physical interaction is a touch *sequence*: it starts with the first
//   touch contact on the surface and ends when every finger of it has lifted.
//   The sequence keeps a history that end-of-gesture state cannot rewrite:
//   whether it ever had a second contact, whether it started enlarged,
//   whether zoom/pan was changed by something else, whether it was cancelled
//   or invalidated, its first finger's start, latest point and farthest
//   travel, and the viewer identity (`touchNavigation.identity()`) and
//   surface size it started with. Its release resolves exactly once
//   (`releaseTouch(event)`, also called by the fullscreen participant, which
//   sees the pointerup first) to one outcome:
//     'navigate' — a single-finger Fit-state swipe or outer-edge tap that the
//                  owner (`touchNavigation.navigate`) accepted and performed;
//     'tap'      — a stationary touch that did not navigate (centre, an edge
//                  with nothing to navigate to, enlarged, long press): the
//                  fullscreen participant may treat it as its chrome tap;
//     'drag'     — a single-finger movement that neither panned nor swiped;
//     'consumed' — pan, pinch, any multi-contact, cancelled or invalidated
//                  sequence: no further action of any kind;
//     null       — not the stage's (a press that began on a control).
//   The viewport only classifies the physical side ('left'/'right'): the
//   owner maps it through its own reading direction and sequence rules and
//   reports whether it moved. A sequence never navigates after the current
//   item, source, content or surface size changed under it (`cancelTouch()`,
//   setContent/replaceContent/clearContent, a size change), after zoom/pan
//   changed by other means, while enlarged, or with more than one finger.
//   After a consumed or invalidated sequence the browser's follow-up click
//   for that touch is swallowed (a short, pointer-scoped document capture
//   guard; see armClickGuard), so one touch never acts twice.
// - D1-F1: the one exception is the shown item's first content filling an
//   empty viewport (its image finished loading while the finger was down):
//   that is not a replacement, so a sequence that began on the empty surface
//   continues while the owner's identity is unchanged (see
//   keepsSequenceForFirstContent). The CSS keeps the surface covering the
//   whole stage while an item loads, so such a touch reaches it.
// - D1-C: every touchmove on the surface is consumed (a non-passive
//   listener; see onSurfaceTouchMove), so a quick stroke never leaves the
//   browser a hidden fling whose cancellation swallows the next tap.
//
// - A press on an interactive descendant of the surface (a page Retry
//   button, a link, a form control, `[data-viewer-interactive]`) never
//   starts a pan, so it keeps its own click, focus and keyboard behavior.
// - C1d: the content may be a composite (a comic spread wrapper from
//   viewer-spread-layout.js, `setContent(…, { composite: true })`). Its size
//   can change in place through `resizeContent()`: Fit re-fits and
//   re-centres; a zoom keeps its level relative to Fit and re-clamps its
//   pan. A new composition goes through `setContent()` and starts in Fit.
//
// It never fetches, decodes or announces anything; viewer-content.js decides
// what is shown and reacts to `onChange`.

// Tuning — adjust freely; every consumer reads these.
export const VIEWER_ZOOM_STEP = 1.5;
export const VIEWER_MAX_ZOOM = 8;
export const VIEWER_KEYBOARD_PAN_STEP = 48;

export const VIEWER_VIEW_MODE_FIT = 'fit';
export const VIEWER_VIEW_MODE_ZOOM = 'zoom';

// D1-A touch gesture kinds, reported as `getState().touchGesture`.
export const VIEWER_TOUCH_NONE = 'none';
export const VIEWER_TOUCH_TRACKING = 'tracking';
export const VIEWER_TOUCH_PAN = 'pan';
export const VIEWER_TOUCH_PINCH = 'pinch';

// D1-B touch sequence outcomes (`releaseTouch()`).
export const VIEWER_TOUCH_OUTCOME_NAVIGATE = 'navigate';
export const VIEWER_TOUCH_OUTCOME_TAP = 'tap';
export const VIEWER_TOUCH_OUTCOME_DRAG = 'drag';
export const VIEWER_TOUCH_OUTCOME_CONSUMED = 'consumed';

// D1-B threshold policy (CSS px / ms), measured on the media surface:
// - A tap travels at most VIEWER_TOUCH_TAP_SLOP from its start at any point
//   (the fullscreen chrome tap's own movement allowance) and lasts at most
//   VIEWER_TOUCH_TAP_MAX_DURATION; a longer stationary press never navigates.
// - A swipe ends at least computeViewerSwipeDistance(width) away
//   horizontally — 10% of the surface width, kept within [32, 96] so a phone
//   needs a deliberate stroke and a wide screen never needs a long one — and
//   is at least VIEWER_SWIPE_DIRECTION_RATIO times more horizontal than
//   vertical (within ~33.7° of horizontal). The end point counts, so a
//   stroke that returns toward its start does not navigate.
// - The outer navigation regions are computeViewerEdgeZone(width) wide on
//   each side: 20% of the width, at least a 44 px touch target, never more
//   than 30%, so at least 40% of the centre stays a chrome/viewing area.
export const VIEWER_TOUCH_TAP_SLOP = 6;
export const VIEWER_TOUCH_TAP_MAX_DURATION = 500;
export const VIEWER_SWIPE_DISTANCE_RATIO = 0.1;
export const VIEWER_SWIPE_MIN_DISTANCE = 32;
export const VIEWER_SWIPE_MAX_DISTANCE = 96;
export const VIEWER_SWIPE_DIRECTION_RATIO = 1.5;
export const VIEWER_EDGE_ZONE_RATIO = 0.2;
export const VIEWER_EDGE_ZONE_MIN = 44;
export const VIEWER_EDGE_ZONE_MAX_RATIO = 0.3;
// A follow-up click is swallowed only within this time of the touch's lift
// and this distance of its last point.
export const VIEWER_CLICK_GUARD_WINDOW = 800;
export const VIEWER_CLICK_GUARD_RADIUS = 48;

const EPSILON = 1e-6;
// Below this contact separation (CSS px) the distance ratio is meaningless.
const MIN_PINCH_DISTANCE = 1;

// Descendants of the surface whose presses belong to themselves, not to pan.
export const VIEWER_INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  'label',
  'summary',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="button"]',
  '[role="link"]',
  '[data-viewer-interactive]',
].join(', ');

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/**
 * The contained scale for content in a viewport: the largest scale at which
 * the whole content fits, never above 1 (small images are not upscaled).
 * An unmeasured viewport or content yields 1.
 *
 * @param {{ width: number, height: number }} content intrinsic size
 * @param {{ width: number, height: number }} viewport surface size
 * @returns {number}
 */
export function computeFitScale(content, viewport) {
  const width = positive(content?.width);
  const height = positive(content?.height);
  const viewWidth = positive(viewport?.width);
  const viewHeight = positive(viewport?.height);
  if (!width || !height || !viewWidth || !viewHeight) return 1;
  return Math.min(1, viewWidth / width, viewHeight / height);
}

/**
 * How far the content's centre may move from the viewport's centre on each
 * axis at a scale: half the overflow, or 0 when that axis fits.
 *
 * @returns {{ x: number, y: number }}
 */
export function computePanLimits(content, scale, viewport) {
  const factor = positive(scale);
  const viewWidth = positive(viewport?.width);
  const viewHeight = positive(viewport?.height);
  if (!factor || !viewWidth || !viewHeight) return { x: 0, y: 0 };
  return {
    x: Math.max(0, (positive(content?.width) * factor - viewWidth) / 2),
    y: Math.max(0, (positive(content?.height) * factor - viewHeight) / 2),
  };
}

/**
 * @param {{ x: number, y: number }} pan
 * @param {{ x: number, y: number }} limits
 * @returns {{ x: number, y: number }}
 */
export function clampViewerPan(pan, limits) {
  const limitX = positive(limits?.x);
  const limitY = positive(limits?.y);
  const clamp = (value, limit) => Math.max(-limit, Math.min(limit, finite(value))) || 0;
  return { x: clamp(pan?.x, limitX), y: clamp(pan?.y, limitY) };
}

/**
 * The next button-zoom scale: one VIEWER_ZOOM_STEP in or out, landing on
 * 1:1 when a step crosses it, and bounded to [fitScale, maxScale].
 *
 * @param {number} scale current scale
 * @param {'in'|'out'} direction
 * @param {{ fitScale: number, maxScale: number }} bounds
 * @returns {number}
 */
export function nextViewerZoomScale(scale, direction, { fitScale, maxScale }) {
  const low = positive(fitScale) || 1;
  const high = Math.max(low, positive(maxScale) || low);
  const current = Math.min(high, Math.max(low, positive(scale) || low));
  let target = direction === 'out' ? current / VIEWER_ZOOM_STEP : current * VIEWER_ZOOM_STEP;
  if (direction === 'out' ? current > 1 + EPSILON && target < 1 : current < 1 - EPSILON && target > 1) {
    target = 1;
  }
  return Math.min(high, Math.max(low, target));
}

/** The horizontal travel a Fit-state swipe needs on a surface `width` wide. */
export function computeViewerSwipeDistance(width) {
  return Math.min(VIEWER_SWIPE_MAX_DISTANCE,
    Math.max(VIEWER_SWIPE_MIN_DISTANCE, positive(width) * VIEWER_SWIPE_DISTANCE_RATIO));
}

/** The width of each outer edge-tap region on a surface `width` wide (0 when unmeasured). */
export function computeViewerEdgeZone(width) {
  const span = positive(width);
  if (!span) return 0;
  return Math.min(span * VIEWER_EDGE_ZONE_MAX_RATIO, Math.max(VIEWER_EDGE_ZONE_MIN, span * VIEWER_EDGE_ZONE_RATIO));
}

/**
 * Classify one finger's completed touch on the surface (pure; D1-B).
 * `side` is the physical side the gesture advances toward: a tap on the
 * right edge, or a swipe whose finger moves leftwards (pulling in what lies
 * to the right), is 'right' — the same physical sense as ArrowRight.
 *
 * @param {{ dx: number, dy: number, travel: number, duration: number,
 *   offsetX: number, width: number }} touch  end displacement, farthest
 *   travel from the start, duration (ms), release x from the surface's left
 * @returns {{ kind: 'tap', side: 'left'|'right'|'center' }
 *   | { kind: 'press' } | { kind: 'swipe', side: 'left'|'right' } | { kind: 'drag' }}
 */
export function classifyViewerTouch({ dx, dy, travel, duration, offsetX, width } = {}) {
  if (finite(travel) <= VIEWER_TOUCH_TAP_SLOP) {
    if (finite(duration) > VIEWER_TOUCH_TAP_MAX_DURATION) return { kind: 'press' };
    const span = positive(width);
    const zone = computeViewerEdgeZone(span);
    const x = finite(offsetX);
    let side = 'center';
    if (zone > 0 && x >= 0 && x < zone) side = 'left';
    else if (zone > 0 && x <= span && x > span - zone) side = 'right';
    return { kind: 'tap', side };
  }
  const horizontal = Math.abs(finite(dx));
  const vertical = Math.abs(finite(dy));
  if (horizontal >= computeViewerSwipeDistance(width) && horizontal >= vertical * VIEWER_SWIPE_DIRECTION_RATIO) {
    return { kind: 'swipe', side: finite(dx) < 0 ? 'right' : 'left' };
  }
  return { kind: 'drag' };
}

/**
 * Create the viewport controller for a viewing surface.
 *
 * @param {object} options
 * @param {HTMLElement} options.surface  the geometry boundary (B2's media region)
 * @param {Window|null} [options.view]   for ResizeObserver / resize fallback
 * @param {(state: object, reason: string) => void} [options.onChange]
 * @param {{ identity?: () => unknown,
 *   navigate?: (intent: { kind: 'swipe'|'tap', side: 'left'|'right', identity: unknown }) => boolean }}
 *   [options.touchNavigation]  D1-B: the navigation owner. `identity()` is
 *   captured when a touch sequence starts and handed back with its intent;
 *   `navigate()` returns whether it moved. Without it nothing navigates.
 */
export function createViewerViewport({ surface, view = null, onChange = null, touchNavigation = null } = {}) {
  let element = null;
  let intrinsic = { width: 0, height: 0 };
  let viewport = { width: 0, height: 0 };
  let mode = VIEWER_VIEW_MODE_FIT;
  let actual = false;
  let scale = 1;
  let pan = { x: 0, y: 0 };
  let drag = null;
  // D1-A: pointerId → { x, y } client position, insertion-ordered, ≤ 2.
  const contacts = new Map();
  // null, or { kind: 'tracking'|'pan'|'pinch', … } derived from `contacts`.
  let touch = null;
  // D1-B: the touch sequence in progress (see the header), or null.
  let sequence = null;
  // The last resolved release: { event, outcome } (resolution is idempotent).
  let released = null;
  // The follow-up click guard, or null (armClickGuard).
  let guard = null;
  let composite = false;
  let resizeObserver = null;
  let windowResizeBound = false;
  let destroyed = false;

  const hasContent = () => Boolean(element && intrinsic.width && intrinsic.height);
  const fitScale = () => computeFitScale(intrinsic, viewport);
  const maxScale = () => Math.max(fitScale(), VIEWER_MAX_ZOOM);
  const limits = () => computePanLimits(intrinsic, scale, viewport);

  function measure() {
    viewport = { width: positive(surface?.clientWidth), height: positive(surface?.clientHeight) };
  }

  function getState() {
    const fit = fitScale();
    const max = maxScale();
    const bounds = hasContent() ? limits() : { x: 0, y: 0 };
    const present = hasContent();
    return Object.freeze({
      hasContent: present,
      mode,
      scale: present ? scale : 1,
      fitScale: fit,
      minScale: fit,
      maxScale: max,
      panX: pan.x,
      panY: pan.y,
      maxPanX: bounds.x,
      maxPanY: bounds.y,
      canZoomIn: present && scale < max - EPSILON,
      canZoomOut: present && scale > fit + EPSILON,
      canFit: present && mode !== VIEWER_VIEW_MODE_FIT,
      canPan: present && (bounds.x > 0 || bounds.y > 0),
      dragging: Boolean(drag) || touch?.kind === VIEWER_TOUCH_PAN || touch?.kind === VIEWER_TOUCH_PINCH,
      touchGesture: touch?.kind ?? VIEWER_TOUCH_NONE,
      touchContacts: contacts.size,
      composite: present && composite,
      contentWidth: intrinsic.width,
      contentHeight: intrinsic.height,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
    });
  }

  function apply() {
    if (!hasContent()) {
      surface?.removeAttribute?.('data-viewer-pannable');
      return;
    }
    const width = intrinsic.width * scale;
    const height = intrinsic.height * scale;
    const style = element.style;
    if (style) {
      style.width = `${width}px`;
      style.height = `${height}px`;
      style.transform = `translate(${pan.x - width / 2}px, ${pan.y - height / 2}px)`;
    }
    const bounds = limits();
    if (bounds.x > 0 || bounds.y > 0) surface?.setAttribute?.('data-viewer-pannable', '');
    else surface?.removeAttribute?.('data-viewer-pannable');
  }

  function emit(reason) {
    if (destroyed) return;
    try {
      onChange?.(getState(), reason);
    } catch {
      // The viewport keeps working whatever its listener does.
    }
  }

  // Re-derive scale and pan from the current mode after any size change.
  function settle() {
    const fit = fitScale();
    if (mode === VIEWER_VIEW_MODE_FIT) scale = fit;
    else {
      scale = Math.min(maxScale(), Math.max(fit, positive(scale) || fit));
      if (Math.abs(scale - fit) < EPSILON) mode = VIEWER_VIEW_MODE_FIT;
    }
    pan = clampViewerPan(pan, limits());
  }

  function setScale(target, reason) {
    if (!hasContent()) return false;
    measure();
    const fit = fitScale();
    const next = Math.min(maxScale(), Math.max(fit, positive(target) || fit));
    const ratio = scale > 0 ? next / scale : 1;
    // Button zoom keeps the point at the surface centre in place.
    pan = { x: pan.x * ratio, y: pan.y * ratio };
    scale = next;
    actual = reason === 'actual';
    mode = Math.abs(next - fit) < EPSILON ? VIEWER_VIEW_MODE_FIT : VIEWER_VIEW_MODE_ZOOM;
    if (mode === VIEWER_VIEW_MODE_FIT) pan = { x: 0, y: 0 };
    pan = clampViewerPan(pan, limits());
    apply();
    disturbSequence();
    rebaseTouch();
    emit(reason);
    return true;
  }

  // ── Resize observation (only while content is shown) ──────────────────────

  const onResize = () => refresh();

  function startObserving() {
    if (resizeObserver || windowResizeBound || destroyed) return;
    const Observer = view?.ResizeObserver;
    if (typeof Observer === 'function' && surface) {
      resizeObserver = new Observer(onResize);
      resizeObserver.observe(surface);
      return;
    }
    if (typeof view?.addEventListener === 'function') {
      view.addEventListener('resize', onResize);
      windowResizeBound = true;
    }
  }

  function stopObserving() {
    resizeObserver?.disconnect?.();
    resizeObserver = null;
    if (windowResizeBound) view?.removeEventListener?.('resize', onResize);
    windowResizeBound = false;
  }

  // ── Pointer pan ───────────────────────────────────────────────────────────

  function endDrag() {
    if (!drag) return;
    const { pointerId } = drag;
    drag = null;
    surface?.removeAttribute?.('data-viewer-dragging');
    if (typeof surface?.releasePointerCapture === 'function'
      && (typeof surface.hasPointerCapture !== 'function' || surface.hasPointerCapture(pointerId))) {
      try {
        surface.releasePointerCapture(pointerId);
      } catch {
        // Capture may already be gone.
      }
    }
    emit('pan');
  }

  // Whether a press started on an interactive element inside the surface.
  function startsOnInteractive(target) {
    if (!target || target === surface || typeof target.closest !== 'function') return false;
    const control = target.closest(VIEWER_INTERACTIVE_SELECTOR);
    if (!control || control === surface) return false;
    return typeof surface?.contains === 'function' ? surface.contains(control) : true;
  }

  // ── Touch pan and pinch (D1-A) ────────────────────────────────────────────

  // The surface's padding-box origin in client coordinates.
  function surfaceOrigin() {
    let left = 0;
    let top = 0;
    if (typeof surface?.getBoundingClientRect === 'function') {
      const rect = surface.getBoundingClientRect();
      left = finite(rect?.left) + finite(surface.clientLeft);
      top = finite(rect?.top) + finite(surface.clientTop);
    }
    return { left, top };
  }

  // The surface centre in client coordinates: pan is measured from it.
  function surfaceCentre() {
    const { left, top } = surfaceOrigin();
    return { x: left + viewport.width / 2, y: top + viewport.height / 2 };
  }

  function pinchPoints() {
    const [a, b] = contacts.values();
    return {
      distance: Math.max(MIN_PINCH_DISTANCE, Math.hypot(b.x - a.x, b.y - a.y)),
      midX: (a.x + b.x) / 2,
      midY: (a.y + b.y) / 2,
    };
  }

  function setTouchDragging() {
    if (touch?.kind === VIEWER_TOUCH_PAN || touch?.kind === VIEWER_TOUCH_PINCH) {
      surface?.setAttribute?.('data-viewer-dragging', '');
    } else if (!drag) {
      surface?.removeAttribute?.('data-viewer-dragging');
    }
  }

  // (Re)derive the touch gesture from the current contacts and geometry:
  // every origin is taken from where things are now, so a contact-count or
  // geometry change never jumps the content.
  function rebaseTouch() {
    if (!contacts.size || !hasContent()) {
      touch = null;
      setTouchDragging();
      return;
    }
    measure();
    if (contacts.size >= 2) {
      const { distance, midX, midY } = pinchPoints();
      const centre = surfaceCentre();
      const current = scale > 0 ? scale : fitScale();
      touch = {
        kind: VIEWER_TOUCH_PINCH,
        centre,
        startDistance: distance,
        startScale: current,
        // The content point (intrinsic px from the content centre) under the midpoint.
        anchorX: (midX - centre.x - pan.x) / current,
        anchorY: (midY - centre.y - pan.y) / current,
      };
    } else {
      const [contact] = contacts.values();
      const bounds = limits();
      touch = bounds.x > 0 || bounds.y > 0
        ? { kind: VIEWER_TOUCH_PAN, startX: contact.x, startY: contact.y, panX: pan.x, panY: pan.y }
        : { kind: VIEWER_TOUCH_TRACKING };
    }
    setTouchDragging();
  }

  // Forget every contact. `reason` (if any) reports what the gesture reached.
  function abandonTouch(reason = null) {
    if (!contacts.size && !touch) return;
    const moved = touch?.kind === VIEWER_TOUCH_PINCH ? 'zoom' : touch?.kind === VIEWER_TOUCH_PAN ? 'pan' : null;
    contacts.clear();
    touch = null;
    setTouchDragging();
    if (reason && moved) emit(moved);
  }

  function applyTouch() {
    if (!touch || !hasContent()) return;
    if (touch.kind === VIEWER_TOUCH_PAN) {
      const [contact] = contacts.values();
      pan = clampViewerPan({
        x: touch.panX + contact.x - touch.startX,
        y: touch.panY + contact.y - touch.startY,
      }, limits());
    } else if (touch.kind === VIEWER_TOUCH_PINCH) {
      const { distance, midX, midY } = pinchPoints();
      const fit = fitScale();
      const target = touch.startScale * (distance / touch.startDistance);
      const next = Math.min(maxScale(), Math.max(fit, Number.isFinite(target) && target > 0 ? target : fit));
      scale = next;
      actual = false;
      mode = Math.abs(next - fit) < EPSILON ? VIEWER_VIEW_MODE_FIT : VIEWER_VIEW_MODE_ZOOM;
      pan = mode === VIEWER_VIEW_MODE_FIT ? { x: 0, y: 0 } : clampViewerPan({
        x: midX - touch.centre.x - touch.anchorX * next,
        y: midY - touch.centre.y - touch.anchorY * next,
      }, limits());
    } else {
      return;
    }
    apply();
  }

  function onTouchDown(event) {
    if (drag || !hasContent()) return;
    const id = event.pointerId;
    if (contacts.has(id)) return;
    const x = Number(event.clientX);
    const y = Number(event.clientY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (contacts.size >= 2) {
      // An extra finger never joins or disturbs the pinch.
      event.preventDefault?.();
      return;
    }
    // A first press on a control keeps its own tap; a second finger joins the pinch.
    if (!contacts.size && startsOnInteractive(event.target)) return;
    contacts.set(id, { x, y });
    rebaseTouch();
    if (touch?.kind === VIEWER_TOUCH_PAN || touch?.kind === VIEWER_TOUCH_PINCH) event.preventDefault?.();
  }

  function onTouchMove(event) {
    const contact = contacts.get(event.pointerId);
    const x = Number(event.clientX);
    const y = Number(event.clientY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    contact.x = x;
    contact.y = y;
    if (touch?.kind !== VIEWER_TOUCH_PAN && touch?.kind !== VIEWER_TOUCH_PINCH) return;
    event.preventDefault?.();
    applyTouch();
  }

  function onTouchUp(event) {
    const ended = touch?.kind;
    contacts.delete(event.pointerId);
    rebaseTouch();
    if (ended === VIEWER_TOUCH_PINCH) emit('zoom');
    else if (ended === VIEWER_TOUCH_PAN && !contacts.size) emit('pan');
  }

  // ── Touch sequences: swipe/tap classification (D1-B) ──────────────────────

  const now = () => Date.now();
  const timers = {
    set: typeof view?.setTimeout === 'function' ? view.setTimeout.bind(view) : globalThis.setTimeout.bind(globalThis),
    clear: typeof view?.clearTimeout === 'function' ? view.clearTimeout.bind(view) : globalThis.clearTimeout.bind(globalThis),
  };

  // The follow-up click guard. Browsers synthesize a click after a stationary
  // touch, dispatched wherever the finger is once the touch has ended, so
  // after a touch that navigated (the next item may now be under it) or was
  // consumed or invalidated, that click must not activate anything — in the
  // viewer or, if the viewer closed meanwhile, on the page below. The guard
  // is armed only for such a touch and listens on the document in the
  // capture phase only while armed: it waits for the touch's own fingers
  // (`pending`) to lift, then swallows at most one `click` whose pointerType
  // is 'touch', within VIEWER_CLICK_GUARD_WINDOW ms of the lift and
  // VIEWER_CLICK_GUARD_RADIUS px of its last point. Any other pointer going
  // down (a new interaction), a cancelled touch (no click follows), the
  // window ending or destroy() disarms it. Mouse, pen, keyboard and
  // programmatic clicks are never matched.
  const guardDocument = () => {
    const owner = surface?.ownerDocument;
    return owner && typeof owner.addEventListener === 'function' ? owner : null;
  };

  function disarmClickGuard() {
    if (!guard) return;
    const { document, timer } = guard;
    guard = null;
    if (timer !== null) timers.clear(timer);
    document.removeEventListener('pointerdown', onGuardDown, true);
    document.removeEventListener('pointerup', onGuardUp, true);
    document.removeEventListener('pointercancel', onGuardCancel, true);
    document.removeEventListener('click', onGuardClick, true);
  }

  function startClickGuardWindow() {
    if (!guard || guard.timer !== null) return;
    guard.timer = timers.set(disarmClickGuard, VIEWER_CLICK_GUARD_WINDOW);
  }

  function armClickGuard(pending, x, y) {
    disarmClickGuard();
    const document = guardDocument();
    if (destroyed || !document) return;
    guard = { document, pending: new Set(pending), x: finite(x), y: finite(y), timer: null };
    document.addEventListener('pointerdown', onGuardDown, true);
    document.addEventListener('pointerup', onGuardUp, true);
    document.addEventListener('pointercancel', onGuardCancel, true);
    document.addEventListener('click', onGuardClick, true);
    if (!guard.pending.size) startClickGuardWindow();
  }

  function onGuardDown(event) {
    if (guard && !guard.pending.has(event?.pointerId)) disarmClickGuard();
  }

  function onGuardUp(event) {
    if (!guard?.pending.has(event?.pointerId)) return;
    guard.pending.delete(event.pointerId);
    if (Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
      guard.x = event.clientX;
      guard.y = event.clientY;
    }
    if (!guard.pending.size) startClickGuardWindow();
  }

  function onGuardCancel(event) {
    if (!guard?.pending.has(event?.pointerId)) return;
    guard.pending.delete(event.pointerId);
    if (!guard.pending.size) disarmClickGuard();
  }

  function onGuardClick(event) {
    if (!guard || guard.pending.size || event?.pointerType !== 'touch') return;
    if (Math.hypot(finite(event.clientX) - guard.x, finite(event.clientY) - guard.y) > VIEWER_CLICK_GUARD_RADIUS) return;
    disarmClickGuard();
    event.preventDefault?.();
    event.stopImmediatePropagation?.();
  }

  // Follow the sequence's first finger: its latest point and farthest travel.
  function trackSequencePoint(event) {
    if (!sequence || event.pointerId !== sequence.first) return;
    const x = Number(event.clientX);
    const y = Number(event.clientY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    sequence.lastX = x;
    sequence.lastY = y;
    sequence.travel = Math.max(sequence.travel, Math.hypot(x - sequence.startX, y - sequence.startY));
  }

  function beginSequenceContact(event) {
    const id = event.pointerId;
    // A primary touch means no other finger is down: anything left over from
    // a sequence whose lift never reached the surface is stale.
    if (sequence && event.isPrimary === true && !sequence.pointers.has(id)) sequence = null;
    if (sequence) {
      if (!sequence.pointers.has(id)) {
        sequence.pointers.add(id);
        sequence.multi = true;
      }
      return;
    }
    const x = Number(event.clientX);
    const y = Number(event.clientY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    measure();
    let identity = null;
    try {
      identity = touchNavigation?.identity?.() ?? null;
    } catch {
      identity = null;
    }
    sequence = {
      first: id,
      pointers: new Set([id]),
      interactive: startsOnInteractive(event.target),
      identity,
      // D1-F1: begun while nothing was shown (the item still loading).
      empty: !hasContent(),
      startX: x,
      startY: y,
      lastX: x,
      lastY: y,
      travel: 0,
      startTime: now(),
      width: viewport.width,
      height: viewport.height,
      enlarged: hasContent() && mode !== VIEWER_VIEW_MODE_FIT,
      multi: false,
      disturbed: false,
      invalid: false,
    };
  }

  // The sequence can no longer act: its eventual release is 'consumed' and
  // the click that may follow it is swallowed.
  function invalidateSequence() {
    if (!sequence || sequence.invalid) return;
    sequence.invalid = true;
    if (!sequence.interactive) armClickGuard(sequence.pointers, sequence.lastX, sequence.lastY);
  }

  // D1-F1: the shown item's first content filling an empty viewport is not
  // a replacement of what a touch began on. A sequence that began while
  // nothing was shown survives it only while the owner's identity
  // (`touchNavigation.identity()`, compared field by field) is still the one
  // it began with: another item, source, attempt, session or a close/reopen
  // changes that identity (and has already cancelled the sequence through
  // cancelTouch()). Content shown at another size or scale still cannot
  // navigate (finishSequence checks the surface size and Fit).
  function sameIdentity(a, b) {
    if (a === b) return a !== null && a !== undefined;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length
      && keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && Object.is(a[key], b[key]));
  }

  function keepsSequenceForFirstContent() {
    if (!sequence || sequence.invalid || !sequence.empty || hasContent()) return false;
    let identity = null;
    try {
      identity = touchNavigation?.identity?.() ?? null;
    } catch {
      return false;
    }
    return sameIdentity(sequence.identity, identity);
  }

  // Something other than the sequence changed zoom or pan while it was down.
  function disturbSequence() {
    if (sequence) sequence.disturbed = true;
  }

  function navigateFromTouch(completed, kind, side) {
    if (typeof touchNavigation?.navigate !== 'function') return false;
    // Armed first: the navigation itself may replace what is under the finger.
    armClickGuard([], completed.lastX, completed.lastY);
    let moved = false;
    try {
      moved = touchNavigation.navigate({ kind, side, identity: completed.identity }) === true;
    } catch {
      moved = false;
    }
    if (!moved) disarmClickGuard();
    return moved;
  }

  function finishSequence(completed) {
    if (completed.interactive) return null;
    if (completed.invalid || completed.multi) {
      armClickGuard([], completed.lastX, completed.lastY);
      return VIEWER_TOUCH_OUTCOME_CONSUMED;
    }
    measure();
    const { left } = surfaceOrigin();
    const gesture = classifyViewerTouch({
      dx: completed.lastX - completed.startX,
      dy: completed.lastY - completed.startY,
      travel: completed.travel,
      duration: now() - completed.startTime,
      offsetX: completed.lastX - left,
      width: viewport.width,
    });
    const enlarged = completed.enlarged || (hasContent() && mode !== VIEWER_VIEW_MODE_FIT);
    const navigable = !enlarged && !completed.disturbed && !drag
      && viewport.width === completed.width && viewport.height === completed.height;
    if (gesture.kind === 'tap' || gesture.kind === 'press') {
      if (completed.disturbed) return VIEWER_TOUCH_OUTCOME_CONSUMED;
      if (gesture.kind === 'tap' && gesture.side !== 'center' && navigable
        && navigateFromTouch(completed, 'tap', gesture.side)) return VIEWER_TOUCH_OUTCOME_NAVIGATE;
      return VIEWER_TOUCH_OUTCOME_TAP;
    }
    if (enlarged || completed.disturbed) {
      armClickGuard([], completed.lastX, completed.lastY);
      return VIEWER_TOUCH_OUTCOME_CONSUMED;
    }
    if (gesture.kind === 'swipe' && navigable && navigateFromTouch(completed, 'swipe', gesture.side)) {
      return VIEWER_TOUCH_OUTCOME_NAVIGATE;
    }
    return VIEWER_TOUCH_OUTCOME_DRAG;
  }

  /**
   * Resolve a touch pointerup of the stage's sequence (idempotent per event:
   * the fullscreen participant's capture listener usually calls it first,
   * the surface's own listener then gets the same answer). The sequence's
   * last finger completes it and performs its navigation, if any.
   *
   * @returns {'navigate'|'tap'|'drag'|'consumed'|null}
   */
  function releaseTouch(event) {
    if (destroyed || !event || event.pointerType !== 'touch') return null;
    if (released?.event === event) return released.outcome;
    if (!sequence?.pointers.has(event.pointerId)) return null;
    const current = sequence;
    trackSequencePoint(event);
    current.pointers.delete(event.pointerId);
    let outcome;
    if (current.pointers.size) {
      outcome = current.interactive ? null : VIEWER_TOUCH_OUTCOME_CONSUMED;
    } else {
      sequence = null;
      outcome = finishSequence(current);
    }
    released = { event, outcome };
    return outcome;
  }

  /**
   * D1-C: swallow the browser's follow-up click for a touch `event` that
   * another participant has just acted on (the fullscreen participant
   * revealing hidden chrome, which puts a control under that click) — the
   * same one-click, pointer-scoped guard as above. Non-touch events are ignored.
   */
  function guardTouchClick(event) {
    if (destroyed || event?.pointerType !== 'touch') return;
    armClickGuard([], event.clientX, event.clientY);
  }

  /** Whether `pointerId` belongs to the stage's touch sequence (not a control press). */
  function ownsTouch(pointerId) {
    return Boolean(sequence && !sequence.interactive && sequence.pointers.has(pointerId));
  }

  /**
   * The viewer's item, source or session changed: the touch in progress can
   * no longer pan, pinch or navigate (what it reached is kept and reported).
   */
  function cancelTouch() {
    invalidateSequence();
    abandonTouch('cancel');
  }

  const onPointerDown = (event) => {
    if (event.pointerType === 'touch') {
      if (!drag) beginSequenceContact(event);
      onTouchDown(event);
      return;
    }
    if (drag || contacts.size || !hasContent()) return;
    if (event.button !== 0 || event.isPrimary === false) return;
    if (startsOnInteractive(event.target)) return;
    const bounds = limits();
    if (bounds.x <= 0 && bounds.y <= 0) return;
    event.preventDefault?.();
    drag = {
      pointerId: event.pointerId,
      startX: finite(event.clientX),
      startY: finite(event.clientY),
      panX: pan.x,
      panY: pan.y,
    };
    surface.setAttribute?.('data-viewer-dragging', '');
    try {
      surface.setPointerCapture?.(event.pointerId);
    } catch {
      // Capture is an enhancement; the drag still works over the surface.
    }
  };

  const onPointerMove = (event) => {
    if (event.pointerType === 'touch') trackSequencePoint(event);
    if (contacts.has(event.pointerId)) {
      onTouchMove(event);
      return;
    }
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault?.();
    pan = clampViewerPan({
      x: drag.panX + finite(event.clientX) - drag.startX,
      y: drag.panY + finite(event.clientY) - drag.startY,
    }, limits());
    apply();
  };

  const onPointerEnd = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    endDrag();
  };

  const onPointerUp = (event) => {
    if (event.pointerType === 'touch') releaseTouch(event);
    if (contacts.has(event.pointerId)) onTouchUp(event);
    else onPointerEnd(event);
  };

  // A cancelled or uncaptured contact ends the whole touch sequence; the
  // browser sends no click after it, and its other fingers can only end it.
  const onPointerCancel = (event) => {
    if (sequence?.pointers.has(event.pointerId)) {
      sequence.invalid = true;
      sequence.pointers.delete(event.pointerId);
      if (!sequence.pointers.size) sequence = null;
    }
    if (contacts.has(event.pointerId)) abandonTouch('cancel');
    else onPointerEnd(event);
  };

  // Native image drag-and-drop never starts from the viewer.
  const onDragStart = (event) => { event.preventDefault?.(); };

  // D1-C: `touch-action: none` stops the browser from scrolling or zooming
  // from the surface, but Chromium still turns a quick stroke (roughly
  // 3,500 px/s and up) into a fling it never shows, and treats the next touch
  // anywhere — within the next second or more — as that fling's
  // cancellation: the touch's pointer events fire, but its tap and click
  // never do, so an immediate tap on Next or Close after a quick swipe was
  // lost. Consuming the surface's touchmove stops the browser's scroll
  // gesture, and so the fling, at its source. Pointer events (this module's
  // classifier, pan and pinch) are unaffected, and a tap still gets its
  // click: it moves no farther than the browser's tap slop, and a consumed
  // touchmove never cancels a click. Nothing else in the page is touched.
  const onSurfaceTouchMove = (event) => {
    if (event.cancelable) event.preventDefault();
  };
  const SURFACE_TOUCH_MOVE_OPTIONS = Object.freeze({ passive: false });

  surface?.addEventListener?.('pointerdown', onPointerDown);
  surface?.addEventListener?.('pointermove', onPointerMove);
  surface?.addEventListener?.('pointerup', onPointerUp);
  surface?.addEventListener?.('pointercancel', onPointerCancel);
  surface?.addEventListener?.('lostpointercapture', onPointerCancel);
  surface?.addEventListener?.('dragstart', onDragStart);
  surface?.addEventListener?.('touchmove', onSurfaceTouchMove, SURFACE_TOUCH_MOVE_OPTIONS);

  // ── Public commands ───────────────────────────────────────────────────────

  function setComposite(value) {
    composite = value;
    if (value) surface?.setAttribute?.('data-viewer-composite', '');
    else surface?.removeAttribute?.('data-viewer-composite');
  }

  /**
   * Show `content` (already in the surface) at `size` intrinsic pixels.
   * Starts in Fit unless `options.scale` asks for a specific scale. `options.composite` marks a multi-page composition (C1d).
   * Returns false and clears the viewport for an invalid size.
   */
  function setContent(content, size, options = {}) {
    endDrag();
    const kept = keepsSequenceForFirstContent();
    if (!kept) invalidateSequence();
    abandonTouch();
    const width = positive(size?.width);
    const height = positive(size?.height);
    if (!content || !width || !height) {
      clearContent();
      return false;
    }
    element = content;
    setComposite(options.composite === true);
    intrinsic = { width, height };
    pan = { x: 0, y: 0 };
    mode = VIEWER_VIEW_MODE_FIT;
    actual = false;
    measure();
    scale = fitScale();
    startObserving();
    // D1-F1: the kept sequence's one finger becomes a contact from where it
    // is now, so a second finger pinches about the real midpoint.
    if (kept && sequence.pointers.size === 1 && !sequence.multi) {
      contacts.set(sequence.first, { x: sequence.lastX, y: sequence.lastY });
    }
    if (options.scale !== undefined) return setScale(options.scale, 'content');
    apply();
    if (contacts.size) rebaseTouch();
    emit('content');
    return true;
  }

  /** Replace a decoded rendition, keeping scale intent and the normalized centre point. */
  function replaceContent(content, size) {
    const width = positive(size?.width);
    const height = positive(size?.height);
    if (!content || !width || !height) return false;
    if (!hasContent()) return setContent(content, size);
    endDrag();
    invalidateSequence();
    abandonTouch();
    measure();
    const relative = scale / fitScale();
    const focal = { x: pan.x / (intrinsic.width * scale), y: pan.y / (intrinsic.height * scale) };
    element = content;
    intrinsic = { width, height };
    setComposite(false);
    const fit = fitScale();
    scale = actual ? 1 : mode === VIEWER_VIEW_MODE_FIT ? fit : fit * relative;
    scale = Math.min(maxScale(), Math.max(fit, positive(scale) || fit));
    pan = mode === VIEWER_VIEW_MODE_FIT && !actual ? { x: 0, y: 0 }
      : { x: focal.x * width * scale, y: focal.y * height * scale };
    if (!actual && Math.abs(scale - fit) < EPSILON) mode = VIEWER_VIEW_MODE_FIT;
    else if (actual) mode = VIEWER_VIEW_MODE_ZOOM;
    pan = clampViewerPan(pan, limits());
    apply();
    emit('content');
    return true;
  }

  /** Forget the content (it is not removed from the DOM here). */
  function clearContent() {
    endDrag();
    invalidateSequence();
    abandonTouch();
    const hadContent = Boolean(element);
    if (element?.style) {
      element.style.width = '';
      element.style.height = '';
      element.style.transform = '';
    }
    element = null;
    intrinsic = { width: 0, height: 0 };
    mode = VIEWER_VIEW_MODE_FIT;
    scale = 1;
    pan = { x: 0, y: 0 };
    setComposite(false);
    stopObserving();
    surface?.removeAttribute?.('data-viewer-pannable');
    if (hadContent) emit('clear');
  }

  /** Whether `candidate` is the element currently shown. */
  function isContent(candidate) {
    return Boolean(candidate) && hasContent() && element === candidate;
  }

  /**
   * Change the shown content's intrinsic size in place (C1d: a companion
   * page resolved, so the composition grew or shrank). In Fit it re-fits
   * and re-centres; zoomed, it keeps the zoom level relative to Fit, scales
   * the pan with it and re-clamps it. A drag in progress continues from the
   * adjusted pan. Returns whether anything changed; an unchanged or invalid
   * size is a no-op.
   */
  function resizeContent(size) {
    if (!hasContent()) return false;
    const width = positive(size?.width);
    const height = positive(size?.height);
    if (!width || !height) return false;
    if (width === intrinsic.width && height === intrinsic.height) return false;
    measure();
    const oldFit = fitScale();
    const oldScale = scale;
    const oldPan = pan;
    intrinsic = { width, height };
    const newFit = fitScale();
    if (mode === VIEWER_VIEW_MODE_FIT) {
      scale = newFit;
      pan = { x: 0, y: 0 };
    } else {
      const relative = oldFit > 0 ? oldScale / oldFit : 1;
      scale = Math.min(maxScale(), Math.max(newFit, newFit * relative));
      if (Math.abs(scale - newFit) < EPSILON) {
        mode = VIEWER_VIEW_MODE_FIT;
        pan = { x: 0, y: 0 };
      } else {
        const ratio = oldScale > 0 ? scale / oldScale : 1;
        pan = { x: pan.x * ratio, y: pan.y * ratio };
      }
    }
    pan = clampViewerPan(pan, limits());
    if (drag) {
      drag.panX += pan.x - oldPan.x;
      drag.panY += pan.y - oldPan.y;
    }
    apply();
    rebaseTouch();
    emit('content-size');
    return true;
  }

  /** Re-measure the surface and re-settle Fit, zoom and pan. */
  function refresh() {
    if (!hasContent()) return getState();
    measure();
    settle();
    apply();
    rebaseTouch();
    emit('resize');
    return getState();
  }

  function fit() {
    return setScale(fitScale(), 'fit');
  }

  function zoomIn() {
    if (!hasContent()) return false;
    measure();
    return setScale(nextViewerZoomScale(scale, 'in', { fitScale: fitScale(), maxScale: maxScale() }), 'zoom');
  }

  function zoomOut() {
    if (!hasContent()) return false;
    measure();
    return setScale(nextViewerZoomScale(scale, 'out', { fitScale: fitScale(), maxScale: maxScale() }), 'zoom');
  }

  /** 1:1 intrinsic pixels (bounded below by Fit for small content). */
  function actualSize() {
    return setScale(1, 'actual');
  }

  /** Move by a delta; returns whether anything moved. */
  function panBy(dx, dy) {
    if (!hasContent()) return false;
    measure();
    const next = clampViewerPan({ x: pan.x + finite(dx), y: pan.y + finite(dy) }, limits());
    if (next.x === pan.x && next.y === pan.y) return false;
    pan = next;
    apply();
    disturbSequence();
    rebaseTouch();
    emit('pan');
    return true;
  }

  function destroy() {
    if (destroyed) return;
    clearContent();
    disarmClickGuard();
    sequence = null;
    released = null;
    destroyed = true;
    surface?.removeEventListener?.('pointerdown', onPointerDown);
    surface?.removeEventListener?.('pointermove', onPointerMove);
    surface?.removeEventListener?.('pointerup', onPointerUp);
    surface?.removeEventListener?.('pointercancel', onPointerCancel);
    surface?.removeEventListener?.('lostpointercapture', onPointerCancel);
    surface?.removeEventListener?.('dragstart', onDragStart);
    surface?.removeEventListener?.('touchmove', onSurfaceTouchMove, SURFACE_TOUCH_MOVE_OPTIONS);
  }

  return Object.freeze({
    setContent,
    replaceContent,
    clearContent,
    resizeContent,
    isContent,
    refresh,
    fit,
    zoomIn,
    zoomOut,
    actualSize,
    panBy,
    cancelTouch,
    ownsTouch,
    releaseTouch,
    guardTouchClick,
    getState,
    destroy,
  });
}
