// ─── Unified viewer: foreground media loading and presentation ───────────────
//
// The content participant of the unified viewer (unified-viewer.js). It
// observes the controller's session changes and owns, for the current item
// only:
//
// - fetching, validating and decoding the active item's authoritative rendition;
// - replacing decoded images atomically while retaining the previous usable image;
// - session-local desired quality, separate from the actually displayed quality;
// - Fit, Actual Size, zoom and pan through one viewer-viewport.js instance;
// - one neighbouring optimized image preload and bounded foreground resources.
//
// Safety model: each foreground load gets a fresh token and AbortController.
// A result or error is installed only while its token is still the current
// one; anything else is released on arrival. Aborting alone is never relied
// on, because a fetch or decode may already have completed when the viewer
// moves on.
//
// It never builds URLs (only B1's normalized root-relative ones are used),
// never fetches manifests, never advances slides and never enters
// fullscreen. Its load deadlines only bound pending image work. B4 reads `getState()`/`observe()` for load-aware playback.
//
// Comic sources (kind 'comic', C1b) use the same loader with a stricter
// policy: no neighbour preload, no original, no followed redirect,
// page-specific messages, and an HTTP 409 handed to the controller
// (`onPageConflict`), which retires the whole accepted revision.
//
// C1e: a comic shows the controller's current page group (change.reader:
// one page in Single Page, one or two in Two-Page Spread) as ONE composite
// content element of the same viewport, built by viewer-spread-layout.js
// and mounted in the same media region. Each visible page is an entry keyed
// by its canonical identity, accepted revision and validated URL, with its
// own loading/loaded/failed/unavailable state, Retry and result. Entries are
// reconciled on every comic change, so a direction, layout or alignment
// change keeps (never refetches) the pages that stay visible and releases
// the rest. Bounds: at most VIEWER_COMIC_MAX_PAGES entries (and so retained
// results/object URLs) and at most VIEWER_COMIC_MAX_PAGE_REQUESTS page
// attempts outstanding, counting cancelled attempts until they settle;
// pages waiting for a free attempt are only ever the current group's.

import {
  normalizeViewerUrl,
  findViewerItemIndex,
  stepViewerSequence,
  VIEWER_SOURCE_KIND_COMIC,
  VIEWER_SOURCE_MODE_SEQUENCE,
} from './viewer-sequence.js';
import { createViewerViewport, VIEWER_KEYBOARD_PAN_STEP } from './viewer-viewport.js';
import {
  createViewerSpreadLayout,
  presentViewerSpread,
  VIEWER_SPREAD_MAX_SLOTS,
  VIEWER_SPREAD_SLOT_FAILED,
  VIEWER_SPREAD_SLOT_LOADED,
  VIEWER_SPREAD_SLOT_PENDING,
  VIEWER_SPREAD_SLOT_UNAVAILABLE,
} from './viewer-spread-layout.js';

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
export const VIEWER_MEDIA_ERROR_REDIRECTED = 'redirected';

const MESSAGES = Object.freeze({
  failed: 'This image could not be loaded.',
  retrying: 'Trying again…',
  loadingImage: 'Loading image…',
  pageFailed: 'This page could not be loaded.',
  pageUnreadable: 'This page could not be read from the comic.',
  pageBusy: 'This page is temporarily unavailable. Try again in a moment.',
  pageUnavailable: 'Page unavailable.',
});

// C1e bounds: page entries (and so retained results) and outstanding page
// fetch/decode attempts of the one comic composition.
export const VIEWER_COMIC_MAX_PAGES = VIEWER_SPREAD_MAX_SLOTS;
export const VIEWER_COMIC_MAX_PAGE_REQUESTS = 2;

const isComicSource = (source) => source?.kind === VIEWER_SOURCE_KIND_COMIC;

function comicPageFailureMessage(httpStatus) {
  if (httpStatus === 422) return MESSAGES.pageUnreadable;
  if (httpStatus === 503) return MESSAGES.pageBusy;
  return MESSAGES.pageFailed;
}

// The same messages naming the page, for a page shown beside another one.
function comicNamedPageMessage(entry) {
  const page = `Page ${entry.position}`;
  if (entry.status === VIEWER_MEDIA_UNAVAILABLE) return `${page} is unavailable.`;
  if (entry.httpStatus === 422) return `${page} could not be read from the comic.`;
  if (entry.httpStatus === 503) return `${page} is temporarily unavailable. Try again in a moment.`;
  return `${page} could not be loaded.`;
}

const PAGE_RETRY_ATTRIBUTE = 'data-unified-viewer-page-retry';

const SLOT_STATE_BY_STATUS = Object.freeze({
  [VIEWER_MEDIA_LOADING]: VIEWER_SPREAD_SLOT_PENDING,
  [VIEWER_MEDIA_LOADED]: VIEWER_SPREAD_SLOT_LOADED,
  [VIEWER_MEDIA_FAILED]: VIEWER_SPREAD_SLOT_FAILED,
  [VIEWER_MEDIA_UNAVAILABLE]: VIEWER_SPREAD_SLOT_UNAVAILABLE,
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
 * response text or server diagnostics are ever carried. `status` is the
 * numeric HTTP status of an unsuccessful response (code 'http' only; null for
 * every other code, including network failures, redirects and aborts).
 */
export class ViewerMediaError extends Error {
  constructor(code, { status = null } = {}) {
    super(`Viewer media ${code}`);
    this.name = 'ViewerMediaError';
    this.code = code;
    this.status = code === VIEWER_MEDIA_ERROR_HTTP && Number.isInteger(status) && status >= 100 && status <= 599
      ? status
      : null;
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
 * @param {boolean} [deps.rejectRedirects]  refuse any redirect ('redirected')
 *   instead of following it (comic pages are never redirected by the server)
 * @returns {Promise<{ image: HTMLImageElement, width: number, height: number,
 *   type: string, release: () => void }>}
 */
export async function loadViewerImage(url, deps = {}) {
  const { fetch: fetchImpl, urlApi, createImage, signal = null, priority, rejectRedirects = false } = deps;
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
    redirect: rejectRedirects ? 'manual' : 'follow',
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
  if (rejectRedirects && (response?.type === 'opaqueredirect' || response?.redirected === true
    || (Number.isInteger(response?.status) && response.status >= 300 && response.status < 400))) {
    discardBody(response);
    throw new ViewerMediaError(VIEWER_MEDIA_ERROR_REDIRECTED);
  }
  if (!response || response.ok !== true) {
    discardBody(response);
    // Only the numeric status is kept; the (plain-text) body is never read.
    throw new ViewerMediaError(VIEWER_MEDIA_ERROR_HTTP, { status: response?.status });
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

// Items have already passed the shared identity/revision/URL normalizer.
export function viewerImageSelection(item, desired = 'optimized') {
  if (!item?.available) return null;
  const sources = item.imageSources;
  const optimized = sources?.optimized?.eligible && sources.optimized.url;
  const original = sources?.original?.eligible && sources.original.url;
  if (desired === 'original' && original && sources.toggleEligible) return { url: original, quality: 'original' };
  if (optimized) return { url: optimized, quality: 'optimized' };
  if (original) return { url: original, quality: 'original' };
  return item.mediaUrl ? { url: item.mediaUrl, quality: item.mediaUrl === item.originalUrl ? 'original' : null } : null;
}

const renditionIdentity = (item) => JSON.stringify([item?.key, item?.available, item?.imageSources ?? null,
  item?.mediaUrl, item?.originalUrl, item?.revision]);
const selectedRenditionIdentity = (item, selection) => JSON.stringify([item?.key, selection?.url,
  item?.imageSources?.sourceRevision ?? item?.revision,
  selection?.quality === 'optimized' ? item?.imageSources?.optimized?.revision : null]);

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
 * @param {(conflict: { session: number, key: string, revision: string|null, mediaUrl: string }) => void} [options.onPageConflict]
 *   called after a CURRENT comic page attempt (either page of a spread)
 *   failed with HTTP 409 (the accepted page set is no longer current), at
 *   most once per shown revision; the controller decides whether it still
 *   belongs to its session and revision.
 * @param {(intent: { kind: 'swipe'|'tap', side: 'left'|'right', session: number|null, key: string|null }) => boolean} [options.touchNavigate]
 *   D1-B: a Fit-state touch swipe or outer-edge tap (classified by the
 *   viewport) for the item that was current when the touch began; the
 *   controller maps the physical side and returns whether it navigated.
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
  const onPageConflict = typeof options.onPageConflict === 'function' ? options.onPageConflict : null;
  const touchNavigate = typeof options.touchNavigate === 'function' ? options.touchNavigate : null;
  const keyTarget = options.keyTarget || regions?.root || null;
  const media = regions?.media || null;
  const status = regions?.status || null;
  const root = regions?.root || null;
  const tools = regions?.viewTools || null;
  const zoomInButton = tools?.querySelector?.(ZOOM_IN_SELECTOR) || null;
  const zoomOutButton = tools?.querySelector?.(ZOOM_OUT_SELECTOR) || null;
  const fitButton = tools?.querySelector?.(FIT_SELECTOR) || null;
  const originalButton = tools?.querySelector?.(ORIGINAL_SELECTOR) || null;
  const qualityButton = root?.querySelector?.('[data-unified-viewer-quality]') || null;
  const zoomLevel = tools?.querySelector?.(ZOOM_LEVEL_SELECTOR) || null;
  const toolButtons = [zoomOutButton, zoomInButton, fitButton, originalButton, qualityButton].filter(Boolean);

  const createImage = () => document.createElement('img');
  const loaderDeps = (signal, priority, rejectRedirects = false) => ({
    fetch: fetchImpl, urlApi, createImage, signal, priority, rejectRedirects,
  });

  // Persistent pieces of the media region, built with DOM APIs only.
  const loadingPanel = document.createElement('div');
  loadingPanel.setAttribute('class', 'unified-viewer-loading');
  loadingPanel.setAttribute('data-unified-viewer-loading', '');
  const spinner = document.createElement('span');
  spinner.setAttribute('class', 'unified-viewer-spinner');
  spinner.setAttribute('aria-hidden', 'true');
  const loadingText = document.createElement('span');
  loadingText.textContent = MESSAGES.loadingImage;
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
  let desiredQuality = 'optimized';
  // The shown item: { token, session, source, item, status, attempt, error,
  // httpStatus, abort, result, original, notice, comic }. For a comic
  // (`comic: true`) `item` is the anchor page and status/attempt/error
  // summarize the page entries (see summarizeComic).
  let current = null;
  // C1e: the shown comic composition, or null: { session, revision,
  // entries: Map<key, entry> (≤ VIEWER_COMIC_MAX_PAGES), order: keys with
  // the anchor first, visibleKeys: visual left-to-right, conflictReported }.
  let comic = null;
  // Every comic page attempt whose promise has not settled, cancelled ones
  // included: { entry, abort, cancelled }.
  const pageAttempts = new Set();
  // The C1d composition, created on first use and reused for every comic.
  let spread = null;
  // At most one neighbour: { session, key, mediaUrl, revision, abort, promise,
  // result, cancelled, failed }.
  let preload = null;
  let direction = 'next';
  let destroyed = false;
  const listeners = new Set();

  const viewport = createViewerViewport({
    surface: media,
    view,
    // D1-B: a touch sequence is bound to the item current when it began
    // (its token, session and key); any later change cancels it (see
    // onSessionChange), and the controller re-checks session and key.
    touchNavigation: {
      identity: () => (current ? { token: current.token, session: current.session, key: current.item?.key ?? null } : null),
      navigate: (intent) => {
        const identity = intent?.identity;
        if (destroyed || !touchNavigate || !current || !identity || identity.token !== current.token
          || identity.session !== current.session || identity.key !== (current.item?.key ?? null)) return false;
        return touchNavigate({ kind: intent.kind, side: intent.side, session: identity.session, key: identity.key }) === true;
      },
    },
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
    if (!current || current.comic || !current.item?.imageSources?.original?.eligible) return VIEWER_ORIGINAL_NONE;
    if (current.qualityRequest?.quality === 'original') return VIEWER_ORIGINAL_LOADING;
    return current.displayedQuality === 'original' ? VIEWER_ORIGINAL_ACTIVE : VIEWER_ORIGINAL_AVAILABLE;
  }

  function qualityEligible() {
    return Boolean(current && !current.comic && current.item?.available && current.item.imageSources?.toggleEligible
      && current.blockedContract !== renditionIdentity(current.item));
  }

  function pageSnapshot(entry) {
    return Object.freeze({
      key: entry.key,
      position: entry.position,
      status: entry.status,
      attempt: entry.attempt,
      error: entry.error,
      httpStatus: entry.httpStatus,
      retryable: entry.status === VIEWER_MEDIA_FAILED,
      requested: Boolean(entry.request),
      width: entry.result ? entry.result.width : 0,
      height: entry.result ? entry.result.height : 0,
    });
  }

  /**
   * A frozen snapshot of the current item's media:
   * { session, key, status, attempt, error, httpStatus, retryable, width,
   *   height, original: { status, width, height }, view, composite, pages,
   *   pageRequests }. `httpStatus` is the numeric status of a failed HTTP
   * response, else null.
   *
   * For a comic, `key` is the anchor page; `pages` lists the shown page
   * entries in canonical order with their own states; `status` is 'loaded'
   * when any page is shown, else 'loading' when any is loading, else
   * 'failed' when any failed, else 'unavailable'; `error`/`httpStatus` are
   * the first failed page's; `retryable` says some page can be retried;
   * width/height are the composition's; `pageRequests` counts outstanding
   * page attempts (cancelled ones until they settle).
   */
  function getState() {
    const isComic = Boolean(current?.comic);
    const result = current?.result;
    const originalResult = current?.displayedQuality === 'original' ? result : null;
    const geometry = isComic && spread ? spread.getGeometry() : null;
    const pages = isComic && comic
      ? Array.from(comic.entries.values()).sort((a, b) => a.position - b.position).map(pageSnapshot)
      : [];
    return Object.freeze({
      session: current ? current.session : null,
      key: current?.item ? current.item.key : null,
      status: current ? current.status : VIEWER_MEDIA_IDLE,
      attempt: current ? current.attempt : 0,
      error: current ? current.error : null,
      httpStatus: current ? current.httpStatus : null,
      retryable: isComic ? pages.some((page) => page.retryable) : current?.status === VIEWER_MEDIA_FAILED,
      width: geometry ? geometry.width : (result ? result.width : 0),
      height: geometry ? geometry.height : (result ? result.height : 0),
      composite: isComic,
      pages: Object.freeze(pages),
      pageRequests: pageAttempts.size,
      original: Object.freeze({
        status: originalStatus(),
        width: originalResult ? originalResult.width : 0,
        height: originalResult ? originalResult.height : 0,
      }),
      quality: Object.freeze({
        desired: desiredQuality,
        displayed: current?.displayedQuality ?? null,
        url: current?.displayedUrl ?? null,
        loading: Boolean(current?.qualityRequest),
        eligible: qualityEligible(),
        error: current?.qualityError ?? null,
        httpStatus: current?.qualityHttpStatus ?? null,
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
    // Closed disclosures can retain layout boxes without exposing their controls.
    const usable = (control) => control && !control.disabled && !control.hidden && (control === qualityButton || !tools?.hidden)
      && !control.closest?.('details:not([open])')
      && (!control.getClientRects || control.getClientRects().length > 0)
      && (typeof document.contains !== 'function' || document.contains(control));
    if (usable(focused)) return;
    const target = toolButtons.find(usable) || focusFallback();
    target?.focus?.({ preventScroll: true });
  }

  // A comic's status line: a single page keeps C1b's messages; beside
  // another page, each failed or unavailable page is named.
  function comicStatusText() {
    const entries = comic
      ? Array.from(comic.entries.values()).sort((a, b) => a.position - b.position)
      : [];
    if (entries.length === 1) {
      const [entry] = entries;
      if (entry.status === VIEWER_MEDIA_LOADING) return entry.attempt > 0 ? MESSAGES.retrying : '';
      if (entry.status === VIEWER_MEDIA_FAILED) return comicPageFailureMessage(entry.httpStatus);
      if (entry.status === VIEWER_MEDIA_UNAVAILABLE) return MESSAGES.pageUnavailable;
      return current.notice || '';
    }
    const problems = entries
      .filter((entry) => entry.status === VIEWER_MEDIA_FAILED || entry.status === VIEWER_MEDIA_UNAVAILABLE)
      .map(comicNamedPageMessage);
    if (problems.length) return problems.join(' ');
    if (current.status === VIEWER_MEDIA_LOADING) {
      return entries.some((entry) => entry.attempt > 0) ? MESSAGES.retrying : '';
    }
    return current.notice || '';
  }

  function renderStatus() {
    if (!status || !current) return;
    if (current.comic) {
      const text = comicStatusText();
      if (status.textContent !== text) status.textContent = text;
      return;
    }
    let text = null;
    if (current.status === VIEWER_MEDIA_LOADING) text = current.attempt > 0 ? MESSAGES.retrying : '';
    else if (current.status === VIEWER_MEDIA_FAILED) text = current.httpStatus === 409
      ? 'Image source changed. Refresh this view to load current source information.' : MESSAGES.failed;
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
    fitButton?.setAttribute?.('aria-pressed', String(loaded && state.mode === 'fit'));
    if (zoomLevel) zoomLevel.textContent = loaded ? zoomLabel(state) : '';
    setHiddenFlag(originalButton, !loaded || current?.comic);
    setDisabledFlag(originalButton, !loaded || current?.comic || Math.abs(state.scale - 1) < 1e-6);
    const eligible = qualityEligible();
    const loading = Boolean(current?.qualityRequest);
    setHiddenFlag(qualityButton, !eligible);
    setDisabledFlag(qualityButton, !eligible || !loaded);
    qualityButton?.setAttribute?.('aria-pressed', String(current?.displayedQuality === 'original'));
    qualityButton?.setAttribute?.('aria-busy', String(loading));
    const displayed = current?.displayedQuality;
    const target = loading ? desiredQuality : current?.qualityError ? desiredQuality : displayed === 'original' ? 'optimized' : 'original';
    qualityButton?.setAttribute?.('data-tooltip', loading
      ? `Loading ${desiredQuality} source; showing ${displayed || 'current'} source. Click to cancel.`
      : `${current?.qualityError ? 'Retry' : 'Show'} ${target} source`);
    rescueFocus(focused);
  }

  function renderState() {
    const focused = document.activeElement;
    const state = current ? current.status : VIEWER_MEDIA_IDLE;
    root?.setAttribute?.('data-viewer-media-state', state);
    root?.setAttribute?.('data-viewer-original-state', originalStatus());
    setDisabledFlag(retryButton, Boolean(current?.blockedContract));
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
      && slot.mediaUrl === viewerImageSelection(item)?.url && slot.revision === renditionIdentity(item);
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
    if (!current || current.status !== VIEWER_MEDIA_LOADED || current.qualityRequest || desiredQuality === 'original' || !Abort) return;
    const { source, item, session } = current;
    if (source?.mode !== VIEWER_SOURCE_MODE_SEQUENCE || source.items.length < 2) return;
    // A comic loads its current page only: no speculative neighbour.
    if (isComicSource(source)) {
      cancelPreload();
      return;
    }
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
      mediaUrl: viewerImageSelection(neighbour)?.url,
      revision: renditionIdentity(neighbour),
      abort,
      result: null,
      cancelled: false,
      failed: false,
    };
    slot.promise = loadViewerImage(slot.mediaUrl, loaderDeps(abort.signal, 'low')).then((result) => {
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

  function cancelQuality() {
    const entry = current?.qualityRequest;
    if (!entry) return;
    current.qualityRequest = null;
    (view?.clearTimeout || globalThis.clearTimeout)(entry.timer);
    entry.abort.abort();
  }

  function stopForeground() {
    if (!current) return;
    const ended = current;
    cancelQuality();
    (view?.clearTimeout || globalThis.clearTimeout)(ended.loadTimer);
    current = null;
    ended.abort?.abort();
    viewport.clearContent();
    ended.result?.image?.remove?.();
    ended.result?.release();
  }

  function install(token, result, selection) {
    current.displayedQuality = selection.quality;
    current.displayedUrl = selection.url;
    current.displayedContract = selectedRenditionIdentity(current.item, selection);
    current.abort = null;
    current.result = result;
    const { image } = result;
    image.setAttribute?.('class', 'unified-viewer-image');
    image.setAttribute?.('alt', current.item.alt);
    image.setAttribute?.('data-viewer-content', selection.quality || 'preview');
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
    current.httpStatus = error?.code === VIEWER_MEDIA_ERROR_HTTP && Number.isInteger(error.status)
      ? error.status
      : null;
    showPanel(failurePanel);
    renderState();
    emit('status');
  }

  function request(token, item, { allowPreload }) {
    const selection = viewerImageSelection(item, current.initialQuality || desiredQuality);
    const adopted = allowPreload && selection?.quality !== 'original' ? takePreload(item, current.session) : null;
    if (!adopted) cancelPreload();
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
      promise = loadViewerImage(selection?.url, loaderDeps(abort.signal));
    }
    const attempt = {};
    current.requestIdentity = attempt;
    current.loadTimer = (view?.setTimeout || globalThis.setTimeout)(() => {
      if (!isCurrent(token) || current.requestIdentity !== attempt) return;
      current.requestIdentity = null;
      current.abort?.abort();
      fail(token, new ViewerMediaError(VIEWER_MEDIA_ERROR_NETWORK));
    }, 30000);
    promise.then((result) => {
      if (!isCurrent(token) || current.requestIdentity !== attempt) {
        result.release();
        return;
      }
      (view?.clearTimeout || globalThis.clearTimeout)(current.loadTimer);
      install(token, result, selection);
    }, (error) => {
      if (!isCurrent(token) || current.requestIdentity !== attempt) return;
      (view?.clearTimeout || globalThis.clearTimeout)(current.loadTimer);
      // A failed preload is only a hint: load once more in the foreground.
      if (adopted) {
        request(token, item, { allowPreload: false });
        return;
      }
      if (error?.status !== 409 && selection?.quality === 'original' && item.imageSources?.optimized?.eligible && !current.initialQuality) {
        current.initialQuality = 'optimized';
        current.notice = 'The original could not be loaded. Showing optimized source.';
        request(token, item, { allowPreload: false });
        return;
      }
      if (error?.status === 409) {
        current.blockedContract = renditionIdentity(item);
        current.blockedRendition = selectedRenditionIdentity(item, selection);
      }
      fail(token, error);
    });
  }

  function begin(change, attempt = 0) {
    endComic();
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
      httpStatus: null,
      abort: null,
      result: null,
      original: null,
      qualityRequest: null,
      displayedQuality: null,
      displayedUrl: null,
      notice: '',
      comic: false,
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
    endComic();
    stopForeground();
    generation += 1;
    showPanel(null);
    root?.setAttribute?.('data-viewer-media-state', VIEWER_MEDIA_IDLE);
    root?.setAttribute?.('data-viewer-original-state', VIEWER_ORIGINAL_NONE);
    media?.removeAttribute?.('aria-busy');
    setHiddenFlag(tools, true);
    setHiddenFlag(qualityButton, true);
    setDisabledFlag(qualityButton, true);
    desiredQuality = 'optimized';
    if (zoomLevel) zoomLevel.textContent = '';
    emit('status');
  }

  function travelDirection(change) {
    const previousIndex = findViewerItemIndex(change.source, change.previousKey);
    if (previousIndex === -1 || change.index === -1) return 'next';
    const forward = change.index > previousIndex;
    return forward !== (change.wrapped === true) ? 'next' : 'previous';
  }

  // ── Comic pages (C1e) ─────────────────────────────────────────────────────

  function spreadLayout() {
    if (!spread) spread = createViewerSpreadLayout({ document });
    return spread;
  }

  const pageUsable = (control) => Boolean(control) && !control.hidden && !control.disabled
    && control.isConnected !== false && (typeof document.contains !== 'function' || document.contains(control));

  // A page Retry that just left the DOM (its page reloads, or its page is no
  // longer shown) hands focus to another page's Retry, else the dialog's
  // fallback. A Retry still connected keeps focus. Focus held anywhere else
  // is never moved.
  function rescuePageFocus(focused) {
    if (!focused?.hasAttribute?.(PAGE_RETRY_ATTRIBUTE)) return;
    if (pageUsable(focused)) {
      if (document.activeElement !== focused) focused.focus?.({ preventScroll: true });
      return;
    }
    const other = comic
      ? Array.from(comic.entries.values()).map((entry) => entry.retryButton).find((button) => button !== focused && pageUsable(button))
      : null;
    (other || focusFallback())?.focus?.({ preventScroll: true });
  }

  function createPageEntry(item, session) {
    const available = Boolean(item.available && item.mediaUrl);
    return {
      key: item.key,
      position: item.position,
      item,
      session,
      revision: item.revision,
      mediaUrl: item.mediaUrl,
      available,
      status: available ? VIEWER_MEDIA_LOADING : VIEWER_MEDIA_UNAVAILABLE,
      attempt: 0,
      error: null,
      httpStatus: null,
      request: null,
      result: null,
      shown: null,
      loadingPanel: null,
      failurePanel: null,
      failureMessage: null,
      unavailablePanel: null,
      retryButton: null,
      onRetry: null,
    };
  }

  // Reuse needs the same page identity, accepted revision, validated URL and
  // availability; anything else is a different page.
  const pageEntryMatches = (entry, item, session) => entry.session === session
    && entry.key === item.key && entry.revision === item.revision && entry.mediaUrl === item.mediaUrl
    && entry.available === Boolean(item.available && item.mediaUrl);

  function cancelPageRequest(entry) {
    const request = entry.request;
    if (!request) return;
    entry.request = null;
    request.cancelled = true;
    // The attempt stays counted in pageAttempts until its promise settles.
    request.abort?.abort();
  }

  function disposePageEntry(entry) {
    cancelPageRequest(entry);
    if (entry.result) {
      entry.result.image?.remove?.();
      entry.result.release();
      entry.result = null;
    }
    entry.retryButton?.removeEventListener?.('click', entry.onRetry);
    entry.shown = null;
  }

  // The node shown in an entry's page frame for its state.
  function pageNode(entry) {
    const page = `page ${entry.position}`;
    if (entry.status === VIEWER_MEDIA_LOADED && entry.result) return entry.result.image;
    if (entry.status === VIEWER_MEDIA_FAILED) {
      if (!entry.failurePanel) {
        const panel = document.createElement('div');
        panel.setAttribute('class', 'unified-viewer-failure unified-viewer-page-failure');
        panel.setAttribute('data-unified-viewer-page-failure', entry.key);
        const message = document.createElement('p');
        message.setAttribute('class', 'unified-viewer-page-message');
        const button = document.createElement('button');
        button.setAttribute('type', 'button');
        button.setAttribute('class', 'button button-small button-secondary');
        button.setAttribute(PAGE_RETRY_ATTRIBUTE, entry.key);
        button.setAttribute('aria-label', `Retry ${page}`);
        button.textContent = 'Retry';
        // Bound to this entry: a Retry kept by an obsolete reference after its
        // page left the composition does nothing.
        entry.onRetry = (event) => {
          event?.preventDefault?.();
          retryPage(entry.key, entry);
        };
        button.addEventListener('click', entry.onRetry);
        panel.appendChild(message);
        panel.appendChild(button);
        entry.failurePanel = panel;
        entry.failureMessage = message;
        entry.retryButton = button;
      }
      entry.failureMessage.textContent = comicNamedPageMessage(entry);
      return entry.failurePanel;
    }
    if (entry.status === VIEWER_MEDIA_UNAVAILABLE) {
      if (!entry.unavailablePanel) {
        const panel = document.createElement('div');
        panel.setAttribute('class', 'unified-viewer-failure unified-viewer-page-unavailable');
        panel.setAttribute('data-unified-viewer-page-unavailable', entry.key);
        const message = document.createElement('p');
        message.setAttribute('class', 'unified-viewer-page-message');
        message.textContent = comicNamedPageMessage(entry);
        panel.appendChild(message);
        entry.unavailablePanel = panel;
      }
      return entry.unavailablePanel;
    }
    if (!entry.loadingPanel) {
      const panel = document.createElement('div');
      panel.setAttribute('class', 'unified-viewer-loading');
      panel.setAttribute('data-unified-viewer-page-loading', entry.key);
      const pageSpinner = document.createElement('span');
      pageSpinner.setAttribute('class', 'unified-viewer-spinner');
      pageSpinner.setAttribute('aria-hidden', 'true');
      const text = document.createElement('span');
      text.textContent = `Loading ${page}…`;
      panel.appendChild(pageSpinner);
      panel.appendChild(text);
      entry.loadingPanel = panel;
    }
    return entry.loadingPanel;
  }

  // Summarize the entries into `current` (see getState()).
  function summarizeComic() {
    if (!current?.comic || !comic) return;
    const entries = Array.from(comic.entries.values()).sort((a, b) => a.position - b.position);
    const has = (state) => entries.some((entry) => entry.status === state);
    if (has(VIEWER_MEDIA_LOADED)) current.status = VIEWER_MEDIA_LOADED;
    else if (has(VIEWER_MEDIA_LOADING)) current.status = VIEWER_MEDIA_LOADING;
    else if (has(VIEWER_MEDIA_FAILED)) current.status = VIEWER_MEDIA_FAILED;
    else current.status = VIEWER_MEDIA_UNAVAILABLE;
    const failed = entries.find((entry) => entry.status === VIEWER_MEDIA_FAILED) || null;
    current.error = failed ? failed.error : null;
    current.httpStatus = failed ? failed.httpStatus : null;
    current.attempt = comic.entries.get(current.item?.key)?.attempt || 0;
  }

  // Bring the composition's slots, their contents and the shared viewport
  // up to date. Kept slots and contents are never re-inserted (focus inside
  // them stays); the viewport policy is presentViewerSpread's: a new group
  // starts in Fit, a size change re-fits or keeps the zoom relative to Fit,
  // an order change keeps zoom and pan.
  function renderComic() {
    if (!comic) return;
    const focused = document.activeElement;
    const layout = spreadLayout();
    if (layout.element.parentNode !== media) media?.replaceChildren?.(layout.element);
    const result = layout.update(comic.visibleKeys.map((key) => {
      const entry = comic.entries.get(key);
      return {
        key,
        position: entry.position,
        width: entry.result ? entry.result.width : 0,
        height: entry.result ? entry.result.height : 0,
        state: SLOT_STATE_BY_STATUS[entry.status] || VIEWER_SPREAD_SLOT_PENDING,
      };
    }));
    for (const entry of comic.entries.values()) {
      const parts = layout.getSlot(entry.key);
      if (!parts) continue;
      const label = `Page ${entry.position}`;
      if (parts.slot.getAttribute?.('aria-label') !== label) {
        parts.slot.setAttribute?.('role', 'group');
        parts.slot.setAttribute?.('aria-label', label);
      }
      const node = pageNode(entry);
      if (entry.shown !== node || node.parentNode !== parts.frame) {
        layout.setSlotContent(entry.key, node);
        entry.shown = node;
      }
    }
    if (result) presentViewerSpread(viewport, layout, result);
    rescuePageFocus(focused);
  }

  function endComic() {
    if (!comic) return;
    const ended = comic;
    comic = null;
    // The ended composition is no longer current, so the viewport's clear
    // notification cannot restate its status over the shell's (a retired
    // revision's "changed" message).
    if (current?.comic) current = null;
    for (const entry of ended.entries.values()) disposePageEntry(entry);
    if (spread) {
      viewport.clearContent();
      spread.clear();
      spread.element.remove?.();
    }
  }

  const ownsPageRequest = (request) => !destroyed && !request.cancelled && comic !== null
    && request.entry.request === request && comic.entries.get(request.entry.key) === request.entry;

  // Start attempts for the current group's waiting pages (the anchor first)
  // while fewer than VIEWER_COMIC_MAX_PAGE_REQUESTS are outstanding. Nothing
  // else ever waits, so a burst of navigation never queues obsolete pages.
  function pumpPageRequests() {
    if (destroyed || !comic) return;
    for (const key of comic.order) {
      if (pageAttempts.size >= VIEWER_COMIC_MAX_PAGE_REQUESTS) return;
      const entry = comic.entries.get(key);
      if (entry && entry.status === VIEWER_MEDIA_LOADING && !entry.request && !entry.result) startPageRequest(entry);
    }
  }

  function startPageRequest(entry) {
    if (!Abort) {
      failPage(entry, new ViewerMediaError(VIEWER_MEDIA_ERROR_UNSUPPORTED));
      return;
    }
    const abort = new Abort();
    const request = { entry, abort, cancelled: false };
    entry.request = request;
    pageAttempts.add(request);
    // Comic pages are never redirected by the server.
    loadViewerImage(entry.mediaUrl, loaderDeps(abort.signal, undefined, true)).then((result) => {
      pageAttempts.delete(request);
      if (ownsPageRequest(request)) installPage(entry, result);
      else result.release();
      pumpPageRequests();
    }, (error) => {
      pageAttempts.delete(request);
      if (ownsPageRequest(request)) failPage(entry, error);
      pumpPageRequests();
    });
  }

  function installPage(entry, result) {
    entry.request = null;
    entry.result = result;
    entry.status = VIEWER_MEDIA_LOADED;
    entry.error = null;
    entry.httpStatus = null;
    const { image } = result;
    image.setAttribute?.('class', 'unified-viewer-page-image');
    image.setAttribute?.('alt', entry.item.alt);
    image.setAttribute?.('data-viewer-content', 'page');
    image.draggable = false;
    summarizeComic();
    renderComic();
    renderState();
    emit('status');
  }

  function failPage(entry, error) {
    entry.request = null;
    entry.status = VIEWER_MEDIA_FAILED;
    entry.error = error?.code || VIEWER_MEDIA_ERROR_NETWORK;
    entry.httpStatus = error?.code === VIEWER_MEDIA_ERROR_HTTP && Number.isInteger(error.status)
      ? error.status
      : null;
    summarizeComic();
    renderComic();
    renderState();
    emit('status');
    // A page answered 409: the whole accepted revision is obsolete, whichever
    // page of the spread it was. Reported last and once per shown revision;
    // the controller may retire the source synchronously, which ends every
    // page of it.
    if (onPageConflict && comic && !comic.conflictReported && entry.httpStatus === 409
      && comic.entries.get(entry.key) === entry) {
      comic.conflictReported = true;
      try {
        onPageConflict(Object.freeze({
          session: entry.session, key: entry.key, revision: entry.revision, mediaUrl: entry.mediaUrl,
        }));
      } catch {
        // The failure stays shown with its Retry.
      }
    }
  }

  /**
   * Retry one failed page of the shown composition. `reference`, when given,
   * must be that page's current entry. Returns whether an attempt was
   * started or queued.
   */
  function retryPage(key, reference = null) {
    if (destroyed || !comic || !current?.comic) return false;
    const entry = comic.entries.get(key);
    if (!entry || (reference && entry !== reference) || entry.status !== VIEWER_MEDIA_FAILED) return false;
    entry.attempt += 1;
    entry.status = VIEWER_MEDIA_LOADING;
    entry.error = null;
    entry.httpStatus = null;
    summarizeComic();
    renderComic();
    renderState();
    emit('status');
    pumpPageRequests();
    return true;
  }

  // The visible group of a comic change in canonical and visual order. A
  // change without the C1c reader snapshot shows its current page alone.
  function comicGroup(change) {
    const reader = change.reader;
    const groupItems = Array.isArray(reader?.groupItems) && reader.groupItems.length
      && reader.groupItems.some((item) => item?.key === change.item.key)
      ? reader.groupItems.slice(0, VIEWER_COMIC_MAX_PAGES)
      : [change.item];
    const visible = Array.isArray(reader?.visibleItems) && reader.visibleItems.length === groupItems.length
      && reader.visibleItems.every((item) => groupItems.includes(item))
      ? reader.visibleItems
      : groupItems;
    return { groupItems, visible };
  }

  // Show a comic change's group, reusing the entries of pages that stay.
  function syncComic(change) {
    const { item, session } = change;
    const same = comic !== null && current?.comic === true && change.type !== 'open'
      && comic.session === session && comic.revision === item.revision;
    if (!same) {
      cancelPreload();
      endComic();
      stopForeground();
      generation += 1;
      current = {
        token: generation,
        session,
        source: change.source,
        item,
        status: VIEWER_MEDIA_LOADING,
        attempt: 0,
        error: null,
        httpStatus: null,
        abort: null,
        result: null,
        original: null,
        notice: '',
        comic: true,
      };
      comic = {
        session,
        revision: item.revision,
        entries: new Map(),
        order: [],
        visibleKeys: [],
        conflictReported: false,
      };
    } else {
      current.source = change.source;
      current.item = item;
    }
    const { groupItems, visible } = comicGroup(change);
    const entries = new Map();
    for (const page of groupItems) {
      const existing = comic.entries.get(page.key);
      const kept = existing && pageEntryMatches(existing, page, session);
      if (kept) existing.item = page;
      entries.set(page.key, kept ? existing : createPageEntry(page, session));
    }
    for (const [key, entry] of comic.entries) {
      if (entries.get(key) !== entry) disposePageEntry(entry);
    }
    comic.entries = entries;
    comic.order = [item.key, ...groupItems.map((page) => page.key).filter((key) => key !== item.key)];
    comic.visibleKeys = visible.map((page) => page.key);
    summarizeComic();
    renderComic();
    renderState();
    emit('status');
    pumpPageRequests();
  }

  // ── Session changes from the controller ───────────────────────────────────

  function onSessionChange(change) {
    if (destroyed || !change) return;
    // D1-B: whatever changed (navigation by any means, playback, a reader
    // choice, a refresh, open or close), a touch still down belongs to what
    // was shown before and can no longer act.
    viewport.cancelTouch();
    // A comic with a current page shows its group, whatever the change.
    if (change.type !== 'close' && change.item && isComicSource(change.source)) {
      direction = 'next';
      syncComic(change);
      return;
    }
    switch (change.type) {
      case 'open':
        desiredQuality = 'optimized';
        direction = 'next';
        begin(change);
        break;
      case 'navigate':
        direction = travelDirection(change);
        begin(change);
        break;
      case 'update': {
        const kept = current && !current.comic && current.session === change.session && current.item
          && change.item && current.item.key === change.item.key;
        const contractChanged = kept && renditionIdentity(current.item) !== renditionIdentity(change.item);
        const selection = viewerImageSelection(change.item, desiredQuality);
        if (kept && current.blockedRendition === selectedRenditionIdentity(change.item, selection)) {
          current.item = change.item;
          current.source = change.source;
          current.blockedContract = renditionIdentity(change.item);
          renderState();
          emit('status');
          break;
        }
        if (!kept || !change.item.available || (current.status !== VIEWER_MEDIA_LOADED && contractChanged)
          || (change.reload && !current.item.imageSources && !change.item.imageSources)) {
          begin(change);
          break;
        }
        current.item = change.item;
        current.source = change.source;
        current.result?.image?.setAttribute?.('alt', current.item.alt);
        if (contractChanged) {
          cancelQuality();
          current.blockedContract = null;
          current.blockedRendition = null;
          current.qualityError = null;
          current.notice = '';
          if (current.displayedContract !== selectedRenditionIdentity(current.item, selection)) {
            switchQuality(desiredQuality, { refresh: true });
          }
        }
        renderState();
        emit('status');
        schedulePreload();
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

  /**
   * Retry the current failed item. Returns whether a load started. For a
   * comic, `key` retries that shown page only; without it every failed
   * shown page is retried (each once).
   */
  function retry(key) {
    if (current?.comic) {
      if (typeof key === 'string') return retryPage(key);
      const failed = comic
        ? Array.from(comic.entries.values()).filter((entry) => entry.status === VIEWER_MEDIA_FAILED)
        : [];
      return failed.map((entry) => retryPage(entry.key, entry)).some(Boolean);
    }
    if (!current || current.status !== VIEWER_MEDIA_FAILED || !current.item
      || current.blockedContract === renditionIdentity(current.item)) return false;
    const { session, source, item, attempt } = current;
    // The loading panel replaces the failure panel, removing a focused Retry;
    // browsers blur it at once, so the focus held before is the one rescued.
    const focused = document.activeElement;
    begin({ session, source, item }, attempt + 1);
    rescueFocus(focused);
    return true;
  }

  /** Actual Size changes only the scale of the already displayed rendition. */
  function showOriginal() {
    return current?.status === VIEWER_MEDIA_LOADED && !current.comic ? viewport.actualSize() : false;
  }

  function switchQuality(quality, { refresh = false } = {}) {
    if (!current || current.comic || current.status !== VIEWER_MEDIA_LOADED || !Abort
      || (!refresh && !qualityEligible()) || current.blockedContract === renditionIdentity(current.item)
      || !['optimized', 'original'].includes(quality)) return false;
    desiredQuality = quality;
    const selection = viewerImageSelection(current.item, quality);
    if (!selection) return false;
    if (current.qualityRequest?.url === selection.url) return true;
    cancelQuality();
    current.qualityError = null;
    current.qualityHttpStatus = null;
    current.notice = '';
    if (current.displayedContract === selectedRenditionIdentity(current.item, selection)) {
      renderState();
      emit('quality');
      return true;
    }
    cancelPreload();
    const { token } = current;
    const contract = renditionIdentity(current.item);
    const abort = new Abort();
    const entry = { ...selection, abort, timer: null };
    current.qualityRequest = entry;
    const owned = () => isCurrent(token) && current.qualityRequest === entry
      && renditionIdentity(current.item) === contract;
    const failed = (error) => {
      if (!owned()) return;
      current.qualityRequest = null;
      (view?.clearTimeout || globalThis.clearTimeout)(entry.timer);
      abort.abort();
      current.qualityError = error?.code || VIEWER_MEDIA_ERROR_NETWORK;
      current.qualityHttpStatus = error?.status ?? null;
      if (error?.status === 409) {
        current.blockedContract = contract;
        current.blockedRendition = selectedRenditionIdentity(current.item, selection);
      }
      current.notice = error?.status === 409
        ? 'Image source changed. Refresh this view to load current source information.'
        : `The ${selection.quality || 'requested'} source could not be loaded. Keeping the current image. Use the source button to retry.`;
      renderState();
      emit('quality');
    };
    entry.timer = (view?.setTimeout || globalThis.setTimeout)(() => failed(new ViewerMediaError(VIEWER_MEDIA_ERROR_NETWORK)), 30000);
    current.notice = `Loading ${selection.quality || 'image'} source…`;
    renderState();
    emit('quality');
    loadViewerImage(selection.url, loaderDeps(abort.signal)).then((result) => {
      if (!owned()) { result.release(); return; }
      (view?.clearTimeout || globalThis.clearTimeout)(entry.timer);
      current.qualityRequest = null;
      const previous = current.result;
      const { image } = result;
      image.setAttribute?.('class', 'unified-viewer-image');
      image.setAttribute?.('alt', current.item.alt);
      image.setAttribute?.('data-viewer-content', selection.quality || 'preview');
      image.draggable = false;
      current.result = result;
      current.displayedQuality = selection.quality;
      current.displayedUrl = selection.url;
      current.displayedContract = selectedRenditionIdentity(current.item, selection);
      current.notice = `Showing ${selection.quality || 'image'} source.`;
      viewport.replaceContent(image, result);
      if (!isCurrent(token) || current.result !== result || renditionIdentity(current.item) !== contract) {
        previous?.release();
        result.release();
        return;
      }
      showPanel(image);
      previous?.release();
      renderState();
      emit('quality');
      schedulePreload();
    }, failed);
    return true;
  }

  function toggleQuality() {
    const target = current?.qualityError ? desiredQuality
      : (current?.qualityRequest ? desiredQuality : current?.displayedQuality) === 'original' ? 'optimized' : 'original';
    return switchQuality(target);
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
  const onQuality = command(() => toggleQuality());
  const onRetry = (event) => {
    event?.preventDefault?.();
    if (!current?.comic) retry();
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
  qualityButton?.addEventListener?.('click', onQuality);
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
    spread?.destroy();
    spread = null;
    viewport.destroy();
    zoomInButton?.removeEventListener?.('click', onZoomIn);
    zoomOutButton?.removeEventListener?.('click', onZoomOut);
    fitButton?.removeEventListener?.('click', onFit);
    originalButton?.removeEventListener?.('click', onOriginal);
    qualityButton?.removeEventListener?.('click', onQuality);
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
    actualSize: showOriginal,
    switchQuality,
    toggleQuality,
    refreshGeometry: () => viewport.refresh(),
    // D1-B: the stage's touch classifier, for the fullscreen participant.
    // D1-C: `guardClick` swallows the follow-up click of a touch the
    // fullscreen participant used to reveal hidden chrome.
    touchGestures: Object.freeze({ owns: viewport.ownsTouch, release: viewport.releaseTouch, guardClick: viewport.guardTouchClick }),
    destroy,
  });
}
