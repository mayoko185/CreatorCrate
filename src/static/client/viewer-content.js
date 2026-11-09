// ─── Unified viewer: foreground media loading and presentation ───────────────
//
// The content participant of the unified viewer (unified-viewer.js). It
// observes the controller's session changes and owns, for the current item
// only:
//
// - loading the server-provided display image (`mediaUrl`) through fetch,
//   validating the HTTP status and image content type, decoding it, and
//   showing it in B2's media region; loading/failed/unavailable states with
//   Retry, announced through B2's status region;
// - on explicit request, the item's eligible `originalUrl`, decoded before it
//   replaces the fitted preview (which stays on failure);
// - Fit, button zoom and pan through one viewer-viewport.js instance;
// - at most one neighbouring display image, preloaded after the current one
//   is shown and handed over if the viewer moves to it;
// - releasing every object URL, request and image it created.
//
// Safety model: each foreground load gets a fresh token and AbortController.
// A result or error is installed only while its token is still the current
// one; anything else is released on arrival. Aborting alone is never relied
// on, because a fetch or decode may already have completed when the viewer
// moves on.
//
// It never builds URLs (only B1's normalized root-relative ones are used),
// never fetches manifests, never schedules timers and never enters
// fullscreen. B4 reads `getState()`/`observe()` for load-aware playback.

import {
  normalizeViewerUrl,
  findViewerItemIndex,
  stepViewerSequence,
  VIEWER_SOURCE_MODE_SEQUENCE,
} from './viewer-sequence.js';
import { createViewerViewport, VIEWER_KEYBOARD_PAN_STEP } from './viewer-viewport.js';

// Image types CreatorCrate serves to viewers: generated previews are WebP;
// inline originals and comic pages are PNG/JPEG/WebP/GIF
// (media-service INLINE_MIME_BY_EXTENSION, COMIC_PAGE_DELIVERY_TYPES).
export const VIEWER_IMAGE_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export const VIEWER_MEDIA_IDLE = 'idle';
export const VIEWER_MEDIA_LOADING = 'loading';
export const VIEWER_MEDIA_LOADED = 'loaded';
export const VIEWER_MEDIA_FAILED = 'failed';
export const VIEWER_MEDIA_UNAVAILABLE = 'unavailable';

export const VIEWER_ORIGINAL_NONE = 'none';
export const VIEWER_ORIGINAL_AVAILABLE = 'available';
export const VIEWER_ORIGINAL_LOADING = 'loading';
export const VIEWER_ORIGINAL_ACTIVE = 'active';
export const VIEWER_ORIGINAL_FAILED = 'failed';

export const VIEWER_MEDIA_ERROR_ABORTED = 'aborted';
export const VIEWER_MEDIA_ERROR_INVALID_URL = 'invalid-url';
export const VIEWER_MEDIA_ERROR_UNSUPPORTED = 'unsupported';
export const VIEWER_MEDIA_ERROR_NETWORK = 'network';
export const VIEWER_MEDIA_ERROR_HTTP = 'http';
export const VIEWER_MEDIA_ERROR_TYPE = 'type';
export const VIEWER_MEDIA_ERROR_EMPTY = 'empty';
export const VIEWER_MEDIA_ERROR_DECODE = 'decode';

const MESSAGES = Object.freeze({
  failed: 'This image could not be loaded.',
  retrying: 'Trying again…',
  originalLoading: 'Loading original size…',
  originalFailed: 'The original could not be loaded. Showing the fitted image.',
});

const ZOOM_IN_SELECTOR = '[data-unified-viewer-zoom-in]';
const ZOOM_OUT_SELECTOR = '[data-unified-viewer-zoom-out]';
const FIT_SELECTOR = '[data-unified-viewer-fit]';
const ORIGINAL_SELECTOR = '[data-unified-viewer-original]';
const ZOOM_LEVEL_SELECTOR = '[data-unified-viewer-zoom-level]';

const PAN_KEYS = Object.freeze({
  ArrowLeft: [1, 0],
  ArrowRight: [-1, 0],
  ArrowUp: [0, 1],
  ArrowDown: [0, -1],
});

/**
 * A controlled loading failure. `code` is one of VIEWER_MEDIA_ERROR_*; no
 * response text or server diagnostics are ever carried.
 */
export class ViewerMediaError extends Error {
  constructor(code) {
    super(`Viewer media ${code}`);
    this.name = 'ViewerMediaError';
    this.code = code;
  }
}

/**
 * The supported image type named by a Content-Type header, or null.
 *
 * @param {unknown} header
 * @returns {string|null}
 */
export function viewerImageContentType(header) {
  if (typeof header !== 'string') return null;
  const type = header.split(';', 1)[0].trim().toLowerCase();
  return VIEWER_IMAGE_TYPES.includes(type) ? type : null;
}

function discardBody(response) {
  try {
    const pending = response?.body?.cancel?.();
    pending?.catch?.(() => {});
  } catch {
    // Nothing to release.
  }
}

function decodeImage(image) {
  if (typeof image.decode === 'function') return image.decode();
  return new Promise((resolve, reject) => {
    image.addEventListener?.('load', () => resolve(), { once: true });
    image.addEventListener?.('error', () => reject(new Error('decode')), { once: true });
  });
}

/**
 * Fetch, validate and decode one image. The result holds an object URL that
 * stays valid until `release()` (idempotent), which also clears the image.
 * Every failure — including an abort that lands after the fetch or decode
 * finished — releases what was created and rejects with a ViewerMediaError.
 *
 * @param {string} url  a server-provided root-relative URL
 * @param {object} deps
 * @param {typeof fetch} deps.fetch
 * @param {{ createObjectURL: Function, revokeObjectURL: Function }} deps.urlApi
 * @param {() => HTMLImageElement} deps.createImage
 * @param {AbortSignal} [deps.signal]
 * @param {'low'|'high'|'auto'} [deps.priority]
 * @returns {Promise<{ image: HTMLImageElement, width: number, height: number,
 *   type: string, release: () => void }>}
 */
export async function loadViewerImage(url, deps = {}) {
  const { fetch: fetchImpl, urlApi, createImage, signal = null, priority } = deps;
  const target = normalizeViewerUrl(url);
  if (!target) throw new ViewerMediaError(VIEWER_MEDIA_ERROR_INVALID_URL);
  if (typeof fetchImpl !== 'function' || typeof urlApi?.createObjectURL !== 'function'
    || typeof createImage !== 'function') {
    throw new ViewerMediaError(VIEWER_MEDIA_ERROR_UNSUPPORTED);
  }
  const aborted = () => new ViewerMediaError(VIEWER_MEDIA_ERROR_ABORTED);
  if (signal?.aborted) throw aborted();

  const init = {
    method: 'GET',
    credentials: 'same-origin',
    redirect: 'follow',
    headers: { Accept: VIEWER_IMAGE_TYPES.join(', ') },
    signal: signal || undefined,
  };
  if (priority) init.priority = priority;

  let response;
  try {
    response = await fetchImpl(target, init);
  } catch {
    throw signal?.aborted ? aborted() : new ViewerMediaError(VIEWER_MEDIA_ERROR_NETWORK);
  }
  if (signal?.aborted) {
    discardBody(response);
    throw aborted();
  }
  if (!response || response.ok !== true) {
    discardBody(response);
    throw new ViewerMediaError(VIEWER_MEDIA_ERROR_HTTP);
  }
  const type = viewerImageContentType(response.headers?.get?.('content-type'));
  if (!type) {
    discardBody(response);
    throw new ViewerMediaError(VIEWER_MEDIA_ERROR_TYPE);
  }

  let blob;
  try {
    blob = await response.blob();
  } catch {
    throw signal?.aborted ? aborted() : new ViewerMediaError(VIEWER_MEDIA_ERROR_NETWORK);
  }
  if (signal?.aborted) throw aborted();
  if (!blob || !(blob.size > 0)) throw new ViewerMediaError(VIEWER_MEDIA_ERROR_EMPTY);

  const objectUrl = urlApi.createObjectURL(blob);
  blob = null;
  const image = createImage();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      image.removeAttribute?.('src');
    } catch {
      // Already detached.
    }
    try {
      urlApi.revokeObjectURL?.(objectUrl);
    } catch {
      // Already revoked.
    }
  };
  // An abort during decode clears the source, which also ends the decode.
  const onAbort = () => release();
  signal?.addEventListener?.('abort', onAbort, { once: true });
  try {
    image.decoding = 'async';
    image.src = objectUrl;
    await decodeImage(image);
  } catch {
    release();
    throw signal?.aborted ? aborted() : new ViewerMediaError(VIEWER_MEDIA_ERROR_DECODE);
  } finally {
    signal?.removeEventListener?.('abort', onAbort);
  }
  if (signal?.aborted || released) {
    release();
    throw aborted();
  }
  const width = Number(image.naturalWidth);
  const height = Number(image.naturalHeight);
  if (!(Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0)) {
    release();
    throw new ViewerMediaError(VIEWER_MEDIA_ERROR_DECODE);
  }
  return Object.freeze({ image, width, height, type, release });
}

function setHiddenFlag(element, hidden) {
  if (!element) return;
  element.hidden = hidden;
  if (hidden) element.setAttribute?.('hidden', '');
  else element.removeAttribute?.('hidden');
}

function setDisabledFlag(control, disabled) {
  if (!control) return;
  control.disabled = disabled;
  if (disabled) control.setAttribute?.('disabled', '');
  else control.removeAttribute?.('disabled');
}

/**
 * Create the content participant for a bound viewer controller.
 *
 * @param {object} options
 * @param {Document} options.document
 * @param {{ root: Element, media: Element, status: Element, viewTools: Element }} options.regions
 * @param {(listener: Function) => Function} options.observe  the controller's observe()
 * @param {Element} [options.keyTarget]   where viewer keys are handled (the dialog)
 * @param {(target: Element) => boolean} [options.keyOwned]  keys owned by a control
 * @param {() => Element|null} [options.focusFallback]  focus target when a used tool disappears
 * @param {typeof fetch} [options.fetch]
 * @param {{ createObjectURL: Function, revokeObjectURL: Function }} [options.urlApi]
 * @param {Window|null} [options.view]
 */
export function createViewerContent(options = {}) {
  const { document, regions, observe } = options;
  const view = options.view !== undefined ? options.view : (document?.defaultView || null);
  const fetchImpl = options.fetch
    || (typeof view?.fetch === 'function' ? view.fetch.bind(view) : null)
    || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
  const urlApi = options.urlApi || view?.URL || globalThis.URL;
  const Abort = view?.AbortController || globalThis.AbortController;
  const keyOwned = typeof options.keyOwned === 'function' ? options.keyOwned : () => false;
  const focusFallback = typeof options.focusFallback === 'function' ? options.focusFallback : () => null;
  const keyTarget = options.keyTarget || regions?.root || null;
  const media = regions?.media || null;
  const status = regions?.status || null;
  const root = regions?.root || null;
  const tools = regions?.viewTools || null;
  const zoomInButton = tools?.querySelector?.(ZOOM_IN_SELECTOR) || null;
  const zoomOutButton = tools?.querySelector?.(ZOOM_OUT_SELECTOR) || null;
  const fitButton = tools?.querySelector?.(FIT_SELECTOR) || null;
  const originalButton = tools?.querySelector?.(ORIGINAL_SELECTOR) || null;
  const zoomLevel = tools?.querySelector?.(ZOOM_LEVEL_SELECTOR) || null;
  const toolButtons = [zoomOutButton, zoomInButton, fitButton, originalButton].filter(Boolean);

  const createImage = () => document.createElement('img');
  const loaderDeps = (signal, priority) => ({ fetch: fetchImpl, urlApi, createImage, signal, priority });

  // Persistent pieces of the media region, built with DOM APIs only.
  const loadingPanel = document.createElement('div');
  loadingPanel.setAttribute('class', 'unified-viewer-loading');
  loadingPanel.setAttribute('data-unified-viewer-loading', '');
  const spinner = document.createElement('span');
  spinner.setAttribute('class', 'unified-viewer-spinner');
  spinner.setAttribute('aria-hidden', 'true');
  const loadingText = document.createElement('span');
  loadingText.textContent = 'Loading image…';
  loadingPanel.appendChild(spinner);
  loadingPanel.appendChild(loadingText);

  const failurePanel = document.createElement('div');
  failurePanel.setAttribute('class', 'unified-viewer-failure');
  failurePanel.setAttribute('data-unified-viewer-failure', '');
  const retryButton = document.createElement('button');
  retryButton.setAttribute('type', 'button');
  retryButton.setAttribute('class', 'button button-small button-secondary');
  retryButton.setAttribute('data-unified-viewer-retry', '');
  retryButton.textContent = 'Retry';
  failurePanel.appendChild(retryButton);

  let generation = 0;
  // The shown item: { token, session, source, item, status, attempt, error,
  // abort, result, original, notice }.
  let current = null;
  // At most one neighbour: { session, key, mediaUrl, revision, abort, promise,
  // result, cancelled, failed }.
  let preload = null;
  let direction = 'next';
  let destroyed = false;
  const listeners = new Set();

  const viewport = createViewerViewport({
    surface: media,
    view,
    onChange: (state, reason) => {
      if (reason === 'zoom' || reason === 'fit' || reason === 'actual') {
        if (current) current.notice = '';
      }
      renderTools();
      if (current?.status === VIEWER_MEDIA_LOADED) renderStatus();
      // New or cleared content is reported with its status/original change.
      if (reason !== 'content' && reason !== 'clear') emit('view');
    },
  });

  const isCurrent = (token) => !destroyed && current !== null && current.token === token;

  // ── State for B4 and other participants ───────────────────────────────────

  function originalStatus() {
    if (!current || current.status !== VIEWER_MEDIA_LOADED || !current.item?.originalUrl) {
      return VIEWER_ORIGINAL_NONE;
    }
    return current.original?.status || VIEWER_ORIGINAL_AVAILABLE;
  }

  /**
   * A frozen snapshot of the current item's media:
   * { session, key, status, attempt, error, retryable, width, height,
   *   original: { status, width, height }, view }.
   */
  function getState() {
    const result = current?.result;
    const originalResult = current?.original?.result;
    return Object.freeze({
      session: current ? current.session : null,
      key: current?.item ? current.item.key : null,
      status: current ? current.status : VIEWER_MEDIA_IDLE,
      attempt: current ? current.attempt : 0,
      error: current ? current.error : null,
      retryable: current?.status === VIEWER_MEDIA_FAILED,
      width: result ? result.width : 0,
      height: result ? result.height : 0,
      original: Object.freeze({
        status: originalStatus(),
        width: originalResult ? originalResult.width : 0,
        height: originalResult ? originalResult.height : 0,
      }),
      view: viewport.getState(),
    });
  }

  function emit(reason) {
    if (destroyed || listeners.size === 0) return;
    const state = getState();
    for (const listener of Array.from(listeners)) {
      try {
        listener(state, reason);
      } catch {
        // One listener never blocks the others.
      }
    }
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function rescueFocus(focused) {
    if (!focused) return;
    const owned = focused === retryButton || toolButtons.includes(focused);
    if (!owned) return;
    const usable = (control) => control && !control.disabled && !control.hidden && !tools?.hidden
      && (typeof document.contains !== 'function' || document.contains(control));
    if (usable(focused)) return;
    const target = toolButtons.find(usable) || focusFallback();
    target?.focus?.({ preventScroll: true });
  }

  function renderStatus() {
    if (!status || !current) return;
    let text = null;
    if (current.status === VIEWER_MEDIA_LOADING) text = current.attempt > 0 ? MESSAGES.retrying : '';
    else if (current.status === VIEWER_MEDIA_FAILED) text = MESSAGES.failed;
    else if (current.status === VIEWER_MEDIA_LOADED) text = current.notice || '';
    // Unavailable items keep the shell's own message.
    if (text !== null && status.textContent !== text) status.textContent = text;
  }

  function zoomLabel(state) {
    if (!state.hasContent) return '';
    if (state.mode === 'fit') return 'Fit';
    return `${Math.round(state.scale * 100)}%`;
  }

  function renderTools() {
    const focused = document.activeElement;
    const loaded = current?.status === VIEWER_MEDIA_LOADED;
    const state = viewport.getState();
    setHiddenFlag(tools, !loaded);
    setDisabledFlag(zoomOutButton, !loaded || !state.canZoomOut);
    setDisabledFlag(zoomInButton, !loaded || !state.canZoomIn);
    setDisabledFlag(fitButton, !loaded || !state.canFit);
    if (zoomLevel) zoomLevel.textContent = loaded ? zoomLabel(state) : '';
    const originalState = originalStatus();
    setHiddenFlag(originalButton, originalState === VIEWER_ORIGINAL_NONE);
    setDisabledFlag(originalButton, originalState === VIEWER_ORIGINAL_NONE
      || originalState === VIEWER_ORIGINAL_LOADING
      || (originalState === VIEWER_ORIGINAL_ACTIVE && Math.abs(state.scale - 1) < 1e-6));
    if (originalState === VIEWER_ORIGINAL_LOADING) originalButton?.setAttribute?.('aria-busy', 'true');
    else originalButton?.removeAttribute?.('aria-busy');
    rescueFocus(focused);
  }

  function renderState() {
    const focused = document.activeElement;
    const state = current ? current.status : VIEWER_MEDIA_IDLE;
    root?.setAttribute?.('data-viewer-media-state', state);
    root?.setAttribute?.('data-viewer-original-state', originalStatus());
    if (state === VIEWER_MEDIA_LOADING) media?.setAttribute?.('aria-busy', 'true');
    else media?.removeAttribute?.('aria-busy');
    renderStatus();
    renderTools();
    rescueFocus(focused);
  }

  function showPanel(panel) {
    if (panel) media?.replaceChildren?.(panel);
    else media?.replaceChildren?.();
  }

  // ── Neighbour preload (one slot) ──────────────────────────────────────────

  function slotMatches(slot, item, session) {
    return slot && slot.session === session && slot.key === item.key
      && slot.mediaUrl === item.mediaUrl && slot.revision === item.revision;
  }

  function cancelPreload() {
    if (!preload) return;
    const slot = preload;
    preload = null;
    slot.cancelled = true;
    slot.abort?.abort();
    slot.result?.release();
  }

  // Hand a matching preload over to the foreground (its request and result
  // become the foreground's); anything else is cancelled.
  function takePreload(item, session) {
    if (preload && !preload.failed && slotMatches(preload, item, session)) {
      const slot = preload;
      preload = null;
      return slot;
    }
    cancelPreload();
    return null;
  }

  function schedulePreload() {
    if (!current || current.status !== VIEWER_MEDIA_LOADED || current.original || !Abort) return;
    const { source, item, session } = current;
    if (source?.mode !== VIEWER_SOURCE_MODE_SEQUENCE || source.items.length < 2) return;
    const step = stepViewerSequence(source, item.key, direction, { skipUnavailable: true });
    const neighbour = step.moved ? source.items[step.index] : null;
    if (!neighbour || !neighbour.available || !neighbour.mediaUrl || neighbour.key === item.key) {
      cancelPreload();
      return;
    }
    if (slotMatches(preload, neighbour, session)) return;
    cancelPreload();
    const abort = new Abort();
    const slot = {
      session,
      key: neighbour.key,
      mediaUrl: neighbour.mediaUrl,
      revision: neighbour.revision,
      abort,
      result: null,
      cancelled: false,
      failed: false,
    };
    slot.promise = loadViewerImage(neighbour.mediaUrl, loaderDeps(abort.signal, 'low')).then((result) => {
      if (slot.cancelled) {
        result.release();
        throw new ViewerMediaError(VIEWER_MEDIA_ERROR_ABORTED);
      }
      slot.result = result;
      return result;
    });
    slot.promise.catch(() => { slot.failed = true; });
    preload = slot;
  }

  // ── Foreground loading ────────────────────────────────────────────────────

  function cancelOriginal({ restorePreview }) {
    const entry = current?.original;
    if (!entry) return;
    current.original = null;
    entry.abort?.abort();
    if (entry.result) {
      viewport.clearContent();
      entry.result.image.remove?.();
      entry.result.release();
      const preview = current.result;
      if (restorePreview && preview) {
        setHiddenFlag(preview.image, false);
        viewport.setContent(preview.image, preview);
      }
    }
  }

  function stopForeground() {
    if (!current) return;
    const ended = current;
    cancelOriginal({ restorePreview: false });
    current = null;
    ended.abort?.abort();
    viewport.clearContent();
    ended.result?.image?.remove?.();
    ended.result?.release();
  }

  function install(token, result) {
    current.abort = null;
    current.result = result;
    const { image } = result;
    image.setAttribute?.('class', 'unified-viewer-image');
    image.setAttribute?.('alt', current.item.alt);
    image.setAttribute?.('data-viewer-content', 'preview');
    image.draggable = false;
    showPanel(image);
    current.status = VIEWER_MEDIA_LOADED;
    current.error = null;
    viewport.setContent(image, result);
    if (!isCurrent(token)) return;
    renderState();
    emit('status');
    schedulePreload();
  }

  function fail(token, error) {
    current.abort = null;
    current.status = VIEWER_MEDIA_FAILED;
    current.error = error?.code || VIEWER_MEDIA_ERROR_NETWORK;
    showPanel(failurePanel);
    renderState();
    emit('status');
  }

  function request(token, item, { allowPreload }) {
    const adopted = allowPreload ? takePreload(item, current.session) : null;
    let promise;
    if (adopted) {
      current.abort = adopted.abort;
      promise = adopted.promise;
    } else {
      if (!Abort) {
        fail(token, new ViewerMediaError(VIEWER_MEDIA_ERROR_UNSUPPORTED));
        return;
      }
      const abort = new Abort();
      current.abort = abort;
      promise = loadViewerImage(item.mediaUrl, loaderDeps(abort.signal));
    }
    promise.then((result) => {
      if (!isCurrent(token)) {
        result.release();
        return;
      }
      install(token, result);
    }, (error) => {
      if (!isCurrent(token)) return;
      // A failed preload is only a hint: load once more in the foreground.
      if (adopted) {
        request(token, item, { allowPreload: false });
        return;
      }
      fail(token, error);
    });
  }

  function begin(change, attempt = 0) {
    stopForeground();
    generation += 1;
    const token = generation;
    const item = change.item || null;
    current = {
      token,
      session: change.session,
      source: change.source,
      item,
      status: VIEWER_MEDIA_IDLE,
      attempt,
      error: null,
      abort: null,
      result: null,
      original: null,
      notice: '',
    };
    if (!item) {
      cancelPreload();
      showPanel(null);
      renderState();
      emit('status');
      return;
    }
    if (!item.available || !item.mediaUrl) {
      cancelPreload();
      current.status = VIEWER_MEDIA_UNAVAILABLE;
      showPanel(null);
      renderState();
      emit('status');
      return;
    }
    current.status = VIEWER_MEDIA_LOADING;
    showPanel(loadingPanel);
    renderState();
    emit('status');
    request(token, item, { allowPreload: true });
  }

  function end() {
    cancelPreload();
    stopForeground();
    generation += 1;
    showPanel(null);
    root?.setAttribute?.('data-viewer-media-state', VIEWER_MEDIA_IDLE);
    root?.setAttribute?.('data-viewer-original-state', VIEWER_ORIGINAL_NONE);
    media?.removeAttribute?.('aria-busy');
    setHiddenFlag(tools, true);
    if (zoomLevel) zoomLevel.textContent = '';
    emit('status');
  }

  function travelDirection(change) {
    const previousIndex = findViewerItemIndex(change.source, change.previousKey);
    if (previousIndex === -1 || change.index === -1) return 'next';
    const forward = change.index > previousIndex;
    return forward !== (change.wrapped === true) ? 'next' : 'previous';
  }

  // ── Session changes from the controller ───────────────────────────────────

  function onSessionChange(change) {
    if (destroyed || !change) return;
    switch (change.type) {
      case 'open':
        direction = 'next';
        begin(change);
        break;
      case 'navigate':
        direction = travelDirection(change);
        begin(change);
        break;
      case 'update': {
        const kept = current && current.session === change.session && current.item
          && change.item && current.item.key === change.item.key;
        if (!kept || change.reload) {
          begin(change);
          break;
        }
        current.item = change.item;
        current.source = change.source;
        if (change.originalChanged) cancelOriginal({ restorePreview: true });
        current.result?.image?.setAttribute?.('alt', current.item.alt);
        current.original?.result?.image?.setAttribute?.('alt', current.item.alt);
        // The shell re-rendered its status; restate ours.
        renderState();
        emit('status');
        // Keeps a still-matching neighbour preload; replaces a stale one.
        if (current.status === VIEWER_MEDIA_LOADED && !current.original) schedulePreload();
        else cancelPreload();
        break;
      }
      case 'close':
        end();
        break;
      default:
        break;
    }
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  /** Retry the current failed item. Returns whether a load started. */
  function retry() {
    if (!current || current.status !== VIEWER_MEDIA_FAILED || !current.item) return false;
    const { session, source, item, attempt } = current;
    begin({ session, source, item }, attempt + 1);
    return true;
  }

  /**
   * Show the current item's original at 1:1. Loads it on first use (the
   * fitted preview stays until the original is decoded) and reuses it after.
   */
  function showOriginal() {
    if (!current || current.status !== VIEWER_MEDIA_LOADED || !Abort) return false;
    const url = current.item?.originalUrl;
    if (!url) return false;
    const existing = current.original;
    if (existing?.status === VIEWER_ORIGINAL_ACTIVE) {
      current.notice = '';
      return viewport.actualSize();
    }
    if (existing?.status === VIEWER_ORIGINAL_LOADING) return false;

    cancelPreload();
    const { token } = current;
    const abort = new Abort();
    const entry = { url, status: VIEWER_ORIGINAL_LOADING, abort, result: null };
    current.original = entry;
    current.notice = MESSAGES.originalLoading;
    renderState();
    emit('original');

    loadViewerImage(url, loaderDeps(abort.signal)).then((result) => {
      if (!isCurrent(token) || current.original !== entry) {
        result.release();
        return;
      }
      entry.abort = null;
      entry.result = result;
      entry.status = VIEWER_ORIGINAL_ACTIVE;
      const { image } = result;
      image.setAttribute?.('class', 'unified-viewer-image');
      image.setAttribute?.('alt', current.item.alt);
      image.setAttribute?.('data-viewer-content', 'original');
      image.draggable = false;
      media?.appendChild?.(image);
      if (current.result) setHiddenFlag(current.result.image, true);
      current.notice = `Showing original size, ${result.width} × ${result.height} pixels.`;
      viewport.setContent(image, result, { scale: 1 });
      renderState();
      emit('original');
    }, () => {
      if (!isCurrent(token) || current.original !== entry) return;
      entry.abort = null;
      entry.status = VIEWER_ORIGINAL_FAILED;
      current.notice = MESSAGES.originalFailed;
      renderState();
      emit('original');
    });
    return true;
  }

  const command = (action) => (event) => {
    event?.preventDefault?.();
    if (!current || current.status !== VIEWER_MEDIA_LOADED) return;
    action();
  };
  const onZoomIn = command(() => viewport.zoomIn());
  const onZoomOut = command(() => viewport.zoomOut());
  const onFit = command(() => viewport.fit());
  const onOriginal = command(() => showOriginal());
  const onRetry = (event) => {
    event?.preventDefault?.();
    retry();
  };

  const onKeydown = (event) => {
    if (!current || current.status !== VIEWER_MEDIA_LOADED) return;
    if (event.defaultPrevented || event.isComposing) return;
    if (!event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
    const delta = PAN_KEYS[event.key];
    if (!delta || keyOwned(event.target)) return;
    if (!viewport.getState().canPan) return;
    event.preventDefault?.();
    viewport.panBy(delta[0] * VIEWER_KEYBOARD_PAN_STEP, delta[1] * VIEWER_KEYBOARD_PAN_STEP);
  };

  zoomInButton?.addEventListener?.('click', onZoomIn);
  zoomOutButton?.addEventListener?.('click', onZoomOut);
  fitButton?.addEventListener?.('click', onFit);
  originalButton?.addEventListener?.('click', onOriginal);
  retryButton.addEventListener('click', onRetry);
  keyTarget?.addEventListener?.('keydown', onKeydown);
  const unobserve = typeof observe === 'function' ? observe(onSessionChange) : () => {};
  setHiddenFlag(tools, true);

  /** Register a media-state listener `(state, reason)`; returns an unsubscribe. */
  function observeMedia(listener) {
    if (destroyed || typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  function destroy() {
    if (destroyed) return;
    end();
    destroyed = true;
    listeners.clear();
    unobserve();
    viewport.destroy();
    zoomInButton?.removeEventListener?.('click', onZoomIn);
    zoomOutButton?.removeEventListener?.('click', onZoomOut);
    fitButton?.removeEventListener?.('click', onFit);
    originalButton?.removeEventListener?.('click', onOriginal);
    retryButton.removeEventListener('click', onRetry);
    keyTarget?.removeEventListener?.('keydown', onKeydown);
  }

  return Object.freeze({
    getState,
    observe: observeMedia,
    retry,
    zoomIn: () => (current?.status === VIEWER_MEDIA_LOADED ? viewport.zoomIn() : false),
    zoomOut: () => (current?.status === VIEWER_MEDIA_LOADED ? viewport.zoomOut() : false),
    fit: () => (current?.status === VIEWER_MEDIA_LOADED ? viewport.fit() : false),
    showOriginal,
    refreshGeometry: () => viewport.refresh(),
    destroy,
  });
}
