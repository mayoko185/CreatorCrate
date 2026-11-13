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
// - Pointer pan follows mouse and pen drags with pointer capture. Touch is
//   deliberately left to the browser: swipe and pinch belong to Milestone D,
//   and no touch-action is suppressed here.
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

const EPSILON = 1e-6;

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

/**
 * Create the viewport controller for a viewing surface.
 *
 * @param {object} options
 * @param {HTMLElement} options.surface  the geometry boundary (B2's media region)
 * @param {Window|null} [options.view]   for ResizeObserver / resize fallback
 * @param {(state: object, reason: string) => void} [options.onChange]
 */
export function createViewerViewport({ surface, view = null, onChange = null } = {}) {
  let element = null;
  let intrinsic = { width: 0, height: 0 };
  let viewport = { width: 0, height: 0 };
  let mode = VIEWER_VIEW_MODE_FIT;
  let actual = false;
  let scale = 1;
  let pan = { x: 0, y: 0 };
  let drag = null;
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
      dragging: Boolean(drag),
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

  const onPointerDown = (event) => {
    if (drag || !hasContent()) return;
    // Touch gestures stay with the browser until Milestone D.
    if (event.pointerType === 'touch') return;
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

  // Native image drag-and-drop never starts from the viewer.
  const onDragStart = (event) => { event.preventDefault?.(); };

  surface?.addEventListener?.('pointerdown', onPointerDown);
  surface?.addEventListener?.('pointermove', onPointerMove);
  surface?.addEventListener?.('pointerup', onPointerEnd);
  surface?.addEventListener?.('pointercancel', onPointerEnd);
  surface?.addEventListener?.('lostpointercapture', onPointerEnd);
  surface?.addEventListener?.('dragstart', onDragStart);

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
    if (options.scale !== undefined) return setScale(options.scale, 'content');
    apply();
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
    emit('content-size');
    return true;
  }

  /** Re-measure the surface and re-settle Fit, zoom and pan. */
  function refresh() {
    if (!hasContent()) return getState();
    measure();
    settle();
    apply();
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
    emit('pan');
    return true;
  }

  function destroy() {
    if (destroyed) return;
    clearContent();
    destroyed = true;
    surface?.removeEventListener?.('pointerdown', onPointerDown);
    surface?.removeEventListener?.('pointermove', onPointerMove);
    surface?.removeEventListener?.('pointerup', onPointerEnd);
    surface?.removeEventListener?.('pointercancel', onPointerEnd);
    surface?.removeEventListener?.('lostpointercapture', onPointerEnd);
    surface?.removeEventListener?.('dragstart', onDragStart);
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
    getState,
    destroy,
  });
}
