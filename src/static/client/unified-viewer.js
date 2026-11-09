// ─── Unified viewer: shared dialog shell controller ──────────────────────────
//
// Drives the one layout-level viewer dialog (partials/unified-viewer.njk) from
// a normalized viewer source (viewer-sequence.js). It owns the viewer session
// — which source is open and which item is current — and the shell around the
// media: header context, View details, position and Previous/Next.
//
// Everything a dialog needs beyond that is the shared app-dialog binder's:
// showModal, focus containment, Escape and dropdown handling, the static
// backdrop, body scroll locking and focus restoration. This module opens and
// closes through openAppDialogById/closeAppDialogById and only adds, through
// the binder's onClose hook, a fallback focus target for an opener that a
// live refresh has replaced.
//
// The shell itself never fetches, decodes or renders media, never schedules
// timers, never enters fullscreen and never reads page thumbnails, selection
// or filters. Sequence order, initial selection, stepping, wrapping and
// live-refresh reconciliation all come from viewer-sequence.js. Its
// participants, created here in this order, observe session changes:
// - content (B3, viewer-content.js): media loading, Fit/zoom/pan and
//   original-size inspection, exposed as `controller.media`;
// - playback (B4, viewer-playback.js): slideshow Play/Pause, speed and
//   load-aware advancement through the controller's own Next step, exposed as
//   `controller.playback`;
// - fullscreen (B4, viewer-fullscreen.js): the dialog card as the fullscreen
//   target and fullscreen-only idle chrome, exposed as `controller.fullscreen`.
// Navigation changes carry `cause`: 'user' for Previous/Next/select and keys,
// 'playback' for the slideshow's own advance.

import { liveRegionDocument, setHidden } from './dom.js';
import { closeAppDialogById, openAppDialogById } from './app-dialogs.js';
import { CC_DROPDOWN_SELECTOR } from './dropdowns.js';
import { createViewerContent } from './viewer-content.js';
import { createViewerFullscreen } from './viewer-fullscreen.js';
import { createViewerPlayback, VIEWER_CAUSE_PLAYBACK, VIEWER_CAUSE_USER } from './viewer-playback.js';
import {
  createViewerSource,
  findViewerItemIndex,
  getViewerItem,
  normalizeViewerUrl,
  reconcileViewerSource,
  selectInitialViewerItem,
  stepViewerSequence,
  VIEWER_RECONCILE_CLOSED,
  VIEWER_RECONCILE_IDLE,
  VIEWER_SOURCE_MODE_SEQUENCE,
  VIEWER_UNAVAILABLE_MISSING_MEDIA,
} from './viewer-sequence.js';

export const UNIFIED_VIEWER_DIALOG_ID = 'unified-viewer-dialog';

// Change types delivered to observers.
export const VIEWER_CHANGE_OPEN = 'open';
export const VIEWER_CHANGE_NAVIGATE = 'navigate';
export const VIEWER_CHANGE_UPDATE = 'update';
export const VIEWER_CHANGE_CLOSE = 'close';

const CONTROLLER_PROPERTY = '__creatorCrateUnifiedViewer';
const ROOT_SELECTOR = '[data-unified-viewer]';
const TITLE_SELECTOR = '[data-unified-viewer-title]';
const SOURCE_SELECTOR = '[data-unified-viewer-source]';
const DETAILS_SELECTOR = '[data-unified-viewer-details]';
const MEDIA_SELECTOR = '[data-unified-viewer-media]';
const STATUS_SELECTOR = '[data-unified-viewer-status]';
const CONTROLS_SELECTOR = '[data-unified-viewer-controls]';
const PREVIOUS_SELECTOR = '[data-unified-viewer-previous]';
const NEXT_SELECTOR = '[data-unified-viewer-next]';
const POSITION_SELECTOR = '[data-unified-viewer-position]';
const VIEW_TOOLS_SELECTOR = '[data-unified-viewer-view-tools]';
const PLAYBACK_SELECTOR = '[data-unified-viewer-playback]';
const CARD_SELECTOR = '[data-unified-viewer-card]';
const HEADER_SELECTOR = '.app-dialog-header';
const CONTEXT_SELECTOR = '[data-unified-viewer-context]';
const FULLSCREEN_SELECTOR = '[data-unified-viewer-fullscreen]';
const CLOSE_SELECTOR = '[data-dialog-close]';
const STABLE_FOCUS_FALLBACK_ID = 'main-content';

// Controls that use arrow keys themselves keep them.
const KEY_OWNING_SELECTOR = [
  'input',
  'textarea',
  'select',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="textbox"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="option"]',
  '[role="menu"]',
  '[role="menuitem"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="tablist"]',
  '[role="tab"]',
  CC_DROPDOWN_SELECTOR,
].join(', ');

const UNAVAILABLE_MESSAGES = {
  [VIEWER_UNAVAILABLE_MISSING_MEDIA]: 'No preview is available for this item.',
};
const UNAVAILABLE_FALLBACK_MESSAGE = 'This item is not available.';

function isConnected(document, element) {
  if (!element) return false;
  if (typeof document?.contains === 'function') return document.contains(element);
  return element.isConnected !== false;
}

/**
 * Bind the page's viewer dialog once. Requires the shared app-dialog binder
 * to have bound it first (enhanceAppDialogs). Idempotent: later calls, such
 * as a live-region re-enhancement, change nothing.
 *
 * @param {Document|Element} [scope]
 * @returns {0|1} whether the page has a bound viewer
 */
export function enhanceUnifiedViewer(scope = globalThis.document) {
  const document = liveRegionDocument(scope);
  const dialog = document?.getElementById?.(UNIFIED_VIEWER_DIALOG_ID);
  if (!dialog) return 0;
  if (dialog[CONTROLLER_PROPERTY]) return 1;
  const dialogState = dialog.__creatorCrateAppDialogState;
  const root = dialog.querySelector?.(ROOT_SELECTOR);
  if (!dialogState || !root) return 0;
  dialog[CONTROLLER_PROPERTY] = createUnifiedViewerController(document, dialog, dialogState, root);
  return 1;
}

/**
 * The page's viewer controller, or null when the page did not opt in (or it
 * is not bound yet).
 *
 * @param {Document|Element} [scope]
 */
export function unifiedViewerFor(scope = globalThis.document) {
  const document = liveRegionDocument(scope);
  return document?.getElementById?.(UNIFIED_VIEWER_DIALOG_ID)?.[CONTROLLER_PROPERTY] || null;
}

function createUnifiedViewerController(document, dialog, dialogState, root) {
  const regions = Object.freeze({
    root,
    media: root.querySelector?.(MEDIA_SELECTOR) || null,
    status: root.querySelector?.(STATUS_SELECTOR) || null,
    viewTools: root.querySelector?.(VIEW_TOOLS_SELECTOR) || null,
    playback: root.querySelector?.(PLAYBACK_SELECTOR) || null,
  });
  const title = root.querySelector?.(TITLE_SELECTOR) || null;
  const sourceLabel = root.querySelector?.(SOURCE_SELECTOR) || null;
  const details = root.querySelector?.(DETAILS_SELECTOR) || null;
  const controls = root.querySelector?.(CONTROLS_SELECTOR) || null;
  const previous = root.querySelector?.(PREVIOUS_SELECTOR) || null;
  const next = root.querySelector?.(NEXT_SELECTOR) || null;
  const position = root.querySelector?.(POSITION_SELECTOR) || null;

  let sessionCounter = 0;
  // The open session: { session, source, key, opener, fallbackFocus }.
  let active = null;
  // Where focus goes once the binder finishes the latest dismissal.
  let pendingFocus = null;
  let opening = false;
  let destroyed = false;
  const observers = new Set();

  // ── Presentation ──────────────────────────────────────────────────────────

  function currentView() {
    if (!active) return { item: null, index: -1, count: 0 };
    const index = findViewerItemIndex(active.source, active.key);
    return {
      item: index === -1 ? null : active.source.items[index],
      index,
      count: active.source.items.length,
    };
  }

  function setText(element, text) {
    if (element) element.textContent = text;
  }

  function setDisabled(control, disabled) {
    if (!control) return;
    control.disabled = disabled;
    if (disabled) control.setAttribute?.('disabled', '');
    else control.removeAttribute?.('disabled');
  }

  function resetPresentation() {
    setText(title, '');
    setText(sourceLabel, '');
    setHidden(sourceLabel, true);
    details?.removeAttribute?.('href');
    setHidden(details, true);
    setText(regions.status, '');
    regions.media?.replaceChildren?.();
    setText(position, '');
    setHidden(controls, true);
    root.setAttribute?.('data-viewer-item-state', 'empty');
  }

  // A control that just became disabled or hidden must not strand focus.
  // Browsers blur it at once, so the focus held before rendering is checked.
  function rescueFocus(focused) {
    if (focused !== previous && focused !== next) return;
    if (!focused.disabled && !focused.hidden && !controls?.hidden) return;
    const other = focused === previous ? next : previous;
    const target = other && !other.disabled && !other.hidden && !controls?.hidden
      ? other
      : dialog.querySelector?.(CLOSE_SELECTOR);
    target?.focus?.({ preventScroll: true });
  }

  function render() {
    const focusedBefore = document.activeElement;
    const { item, index, count } = currentView();
    if (!active || !item) {
      resetPresentation();
      return;
    }

    setText(title, item.title);
    const label = active.source.label || '';
    setText(sourceLabel, label);
    setHidden(sourceLabel, !label);

    const detailsUrl = normalizeViewerUrl(item.detailsUrl);
    if (details) {
      if (detailsUrl) details.setAttribute?.('href', detailsUrl);
      else details.removeAttribute?.('href');
      setHidden(details, !detailsUrl);
    }

    root.setAttribute?.('data-viewer-item-state', item.available ? 'available' : 'unavailable');
    setText(regions.status, item.available
      ? ''
      : (UNAVAILABLE_MESSAGES[item.unavailableReason] || UNAVAILABLE_FALLBACK_MESSAGE));

    const isSequence = active.source.mode === VIEWER_SOURCE_MODE_SEQUENCE;
    const navigable = isSequence && count > 1;
    setHidden(controls, !isSequence);
    setText(position, isSequence ? `${index + 1} of ${count}` : '');
    setHidden(previous, !navigable);
    setHidden(next, !navigable);
    const wrap = active.source.wrap === true;
    setDisabled(previous, !navigable || (!wrap && index <= 0));
    setDisabled(next, !navigable || (!wrap && index >= count - 1));
    rescueFocus(focusedBefore);
  }

  // ── Observers (content and playback participants) ────────────────────────

  function notify(type, session, extra = {}) {
    const { item, index, count } = session === active
      ? currentView()
      : { item: getViewerItem(session.source, session.key), index: findViewerItemIndex(session.source, session.key), count: session.source.items.length };
    const change = Object.freeze({
      type,
      session: session.session,
      source: session.source,
      key: item ? item.key : null,
      index,
      count,
      item,
      previousKey: null,
      reload: false,
      preserveView: false,
      reason: null,
      ...extra,
    });
    for (const observer of Array.from(observers)) {
      try {
        observer(change);
      } catch {
        // One participant's failure never blocks the shell or the others.
      }
    }
  }

  // ── Session lifecycle ─────────────────────────────────────────────────────

  function endSession(reason) {
    if (!active) return;
    const ended = active;
    active = null;
    pendingFocus = { opener: ended.opener, fallbackFocus: ended.fallbackFocus };
    notify(VIEWER_CHANGE_CLOSE, ended, { reason });
    resetPresentation();
  }

  function resolveFallbackFocus(fallbackFocus) {
    let candidate = fallbackFocus;
    if (typeof candidate === 'function') {
      try {
        candidate = candidate();
      } catch {
        candidate = null;
      }
    }
    if (candidate && isConnected(document, candidate) && !dialog.contains?.(candidate)) return candidate;
    return document.getElementById?.(STABLE_FOCUS_FALLBACK_ID) || null;
  }

  // Runs inside the binder's dismissal, before it restores focus to
  // dialogState.opener: a replaced opener is swapped for a connected target.
  function applyFocusFallback() {
    const plan = pendingFocus;
    pendingFocus = null;
    if (!plan) return;
    if (plan.opener && isConnected(document, plan.opener)) {
      dialogState.opener = plan.opener;
      return;
    }
    dialogState.opener = resolveFallbackFocus(plan.fallbackFocus);
  }

  const previousOnClose = dialogState.onClose;
  const onDialogClose = () => {
    previousOnClose?.();
    // A reopen that finishes a still-queued dismissal must not end the
    // session it is starting, and the new opener stays as given.
    if (destroyed || opening) return;
    endSession('dismissed');
    const plan = pendingFocus;
    applyFocusFallback();
    // Closing from fullscreen, or while an entry request is still pending:
    // the page stays inert (or loses focus to a late grant) until the card
    // has left fullscreen, so that focus return is completed afterwards. The
    // fallback covers an opener disconnected in the meantime.
    fullscreen.deferFocus(dialogState.opener, () => resolveFallbackFocus(plan?.fallbackFocus));
  };
  dialogState.onClose = onDialogClose;

  function defaultOpener() {
    const focused = document.activeElement;
    if (!focused || focused === document.body || dialog.contains?.(focused)) return null;
    return focused;
  }

  /**
   * Open a viewer source. The source is normalized through
   * createViewerSource (idempotent for a B1 source), and its initial item is
   * chosen by selectInitialViewerItem. Opening while another source is shown
   * ends that session first, so none of its state stays visible or
   * actionable.
   *
   * @param {object} source  A viewer source (createViewerSource and friends).
   * @param {{ opener?: Element|null, fallbackFocus?: Element|(() => Element|null), autoplay?: boolean }} [options]
   *   opener: focus returns here on close (defaults to the focused element).
   *   fallbackFocus: used when the opener was disconnected by a live refresh;
   *   the page's main landmark is the last resort.
   *   autoplay: false opens a slideshow source paused (it otherwise starts
   *   playing unless reduced motion is preferred); other sources never play.
   * @returns {number} the new session id, or 0 when nothing could be opened
   */
  function open(source, options = {}) {
    if (destroyed) return 0;
    const normalized = createViewerSource(source);
    const initial = selectInitialViewerItem(normalized);
    if (initial.index === -1) return 0;

    const opts = options && typeof options === 'object' ? options : {};
    // Replacing the shown source from within the viewer keeps its opener.
    const opener = opts.opener !== undefined ? opts.opener : (defaultOpener() || active?.opener || null);
    if (active) endSession('replaced');
    sessionCounter += 1;
    const session = {
      session: sessionCounter,
      source: normalized,
      key: initial.key,
      opener: opener || null,
      fallbackFocus: opts.fallbackFocus ?? null,
    };
    active = session;
    pendingFocus = null;
    render();

    opening = true;
    let opened = false;
    try {
      opened = openAppDialogById(document, UNIFIED_VIEWER_DIALOG_ID, session.opener);
    } finally {
      opening = false;
    }
    if (!opened) {
      active = null;
      pendingFocus = null;
      resetPresentation();
      return 0;
    }
    notify(VIEWER_CHANGE_OPEN, session, { reload: true, autoplay: opts.autoplay !== false });
    return session.session;
  }

  function closeWith(reason) {
    if (!active) return false;
    endSession(reason);
    if (!closeAppDialogById(document, UNIFIED_VIEWER_DIALOG_ID)) pendingFocus = null;
    return true;
  }

  /**
   * Close the viewer. Safe to repeat: returns false when nothing is open.
   */
  function close() {
    return closeWith('closed');
  }

  function moveTo(key, extra) {
    const previousKey = active.key;
    active.key = key;
    render();
    notify(VIEWER_CHANGE_NAVIGATE, active, { previousKey, reload: true, cause: VIEWER_CAUSE_USER, ...extra });
  }

  function step(direction, options, cause) {
    if (!active) return null;
    const result = stepViewerSequence(active.source, active.key, direction, {
      skipUnavailable: options?.skipUnavailable === true,
    });
    if (result.moved && result.key !== active.key) moveTo(result.key, { wrapped: result.wrapped, cause });
    return result;
  }

  /**
   * Step through the sequence (stepViewerSequence decides wrapping and
   * boundaries) as user navigation, which pauses slideshow playback. Returns
   * the step result, or null when nothing is open.
   *
   * @param {'next'|'previous'} direction
   * @param {{ skipUnavailable?: boolean }} [options]
   */
  function navigate(direction, options = {}) {
    return step(direction, options, VIEWER_CAUSE_USER);
  }

  /**
   * Show a specific item of the open source by key.
   *
   * @param {string} key
   * @returns {boolean} whether that item is now current
   */
  function select(key) {
    if (!active || findViewerItemIndex(active.source, key) === -1) return false;
    if (key !== active.key) moveTo(key, { wrapped: false });
    return true;
  }

  /**
   * Reconcile the open source with authoritative refreshed data
   * (reconcileViewerSource). An update for another session — one this
   * viewer has since closed or replaced — is ignored. When the reconciled
   * source has nothing left to show, or names a different source, the
   * viewer closes.
   *
   * @param {Array<object>|{ key?: string, label?: string, items?: Array<object> }} replacement
   * @param {{ session?: number }} [options] the id returned by open()
   * @returns {object|null} the reconciliation result, or null when ignored
   */
  function update(replacement, options = {}) {
    if (!active) return null;
    const session = options && typeof options === 'object' ? options.session : undefined;
    if (session !== undefined && session !== active.session) return null;

    const result = reconcileViewerSource(active.source, active.key, replacement);
    if (result.outcome === VIEWER_RECONCILE_CLOSED || result.outcome === VIEWER_RECONCILE_IDLE || !result.item) {
      closeWith(result.reason || 'empty');
      return result;
    }

    const previousKey = active.key;
    active.source = result.source;
    active.key = result.key;
    render();
    notify(VIEWER_CHANGE_UPDATE, active, {
      previousKey,
      outcome: result.outcome,
      reload: result.reload,
      preserveView: result.preserveView,
      revisionChanged: result.revisionChanged,
      mediaChanged: result.mediaChanged,
      originalChanged: result.originalChanged,
      availabilityChanged: result.availabilityChanged,
      reason: result.reason,
    });
    return result;
  }

  /**
   * A frozen snapshot of the viewer session.
   */
  function getState() {
    const { item, index, count } = currentView();
    const mediaState = content.getState();
    const playbackState = playback.getState();
    return Object.freeze({
      open: Boolean(active),
      session: active ? active.session : null,
      source: active ? active.source : null,
      key: item ? item.key : null,
      index,
      count,
      item,
      // B4 summaries; the participants' own getState() has the detail.
      mediaStatus: mediaState.status,
      playback: Object.freeze({
        available: playbackState.available,
        playing: playbackState.playing,
        speed: playbackState.speed,
      }),
      fullscreen: fullscreen.getState().active,
    });
  }

  /**
   * Register a participant called with every frozen change
   * ({ type: 'open'|'navigate'|'update'|'close', session, source, key,
   * index, count, item, previousKey, reload, preserveView, reason, ... }).
   * `reload` says the current item's media must be (re)loaded; a change whose
   * `session` is not the current one is history. Returns an unsubscribe.
   *
   * @param {(change: object) => void} listener
   */
  function observe(listener) {
    if (destroyed || typeof listener !== 'function') return () => {};
    observers.add(listener);
    return () => { observers.delete(listener); };
  }

  // ── Viewer-owned listeners ────────────────────────────────────────────────

  function keyOwnedByControl(target) {
    if (target?.closest?.(KEY_OWNING_SELECTOR)) return true;
    return Boolean(dialog.querySelector?.(`${CC_DROPDOWN_SELECTOR}[open]`));
  }

  const onKeydown = (event) => {
    if (!active || event.defaultPrevented || event.isComposing) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const direction = event.key === 'ArrowLeft' ? 'previous' : event.key === 'ArrowRight' ? 'next' : null;
    if (!direction || keyOwnedByControl(event.target)) return;
    if (active.source.mode !== VIEWER_SOURCE_MODE_SEQUENCE || active.source.items.length < 2) return;
    event.preventDefault?.();
    navigate(direction);
  };
  const onPrevious = (event) => {
    event?.preventDefault?.();
    navigate('previous');
  };
  const onNext = (event) => {
    event?.preventDefault?.();
    navigate('next');
  };

  dialog.addEventListener?.('keydown', onKeydown);
  previous?.addEventListener?.('click', onPrevious);
  next?.addEventListener?.('click', onNext);
  // The content participant observes first, so later participants (B4)
  // already see the media state of the change they are handed.
  const content = createViewerContent({
    document,
    regions,
    observe,
    keyTarget: dialog,
    keyOwned: keyOwnedByControl,
    focusFallback: () => dialog.querySelector?.(CLOSE_SELECTOR) || null,
  });
  const media = Object.freeze({
    getState: content.getState,
    observe: content.observe,
    retry: content.retry,
    zoomIn: content.zoomIn,
    zoomOut: content.zoomOut,
    fit: content.fit,
    showOriginal: content.showOriginal,
    refreshGeometry: content.refreshGeometry,
  });
  // Playback observes after content, so the media state it reads for a change
  // is already that change's.
  const playback = createViewerPlayback({
    document,
    regions,
    observe,
    media,
    advance: () => step('next', {}, VIEWER_CAUSE_PLAYBACK),
    focusFallback: () => dialog.querySelector?.(CLOSE_SELECTOR) || null,
  });
  const card = dialog.querySelector?.(CARD_SELECTOR) || null;
  const fullscreen = createViewerFullscreen({
    document,
    dialog,
    target: card,
    root,
    button: root.querySelector?.(FULLSCREEN_SELECTOR) || null,
    chrome: [
      card?.querySelector?.(HEADER_SELECTOR) || null,
      root.querySelector?.(CONTEXT_SELECTOR) || null,
      controls,
    ],
    observe,
    media,
  });
  resetPresentation();

  /**
   * Close the viewer and remove everything this controller installed.
   */
  function destroy() {
    if (destroyed) return;
    close();
    // A dismissal this close (or an earlier one in the same task) queued
    // finishes after onDialogClose is unhooked below, so a focus return that
    // must outlast fullscreen is handed over now, as the hook would have.
    // deferFocus declines when the viewer holds no fullscreen and no request.
    const plan = pendingFocus;
    if (plan) {
      const opener = plan.opener && isConnected(document, plan.opener)
        ? plan.opener
        : resolveFallbackFocus(plan.fallbackFocus);
      fullscreen.deferFocus(opener, () => resolveFallbackFocus(plan.fallbackFocus));
    }
    fullscreen.destroy();
    playback.destroy();
    content.destroy();
    destroyed = true;
    pendingFocus = null;
    observers.clear();
    dialog.removeEventListener?.('keydown', onKeydown);
    previous?.removeEventListener?.('click', onPrevious);
    next?.removeEventListener?.('click', onNext);
    if (dialogState.onClose === onDialogClose) dialogState.onClose = previousOnClose;
    if (dialog[CONTROLLER_PROPERTY] === controller) delete dialog[CONTROLLER_PROPERTY];
  }

  const controller = Object.freeze({
    regions,
    media,
    playback: Object.freeze({
      getState: playback.getState,
      observe: playback.observe,
      play: playback.play,
      pause: playback.pause,
      toggle: playback.toggle,
      setSpeed: playback.setSpeed,
    }),
    fullscreen: Object.freeze({
      getState: fullscreen.getState,
      observe: fullscreen.observe,
      enter: fullscreen.enter,
      exit: fullscreen.exit,
      toggle: fullscreen.toggle,
    }),
    open,
    close,
    next: (options) => navigate('next', options),
    previous: (options) => navigate('previous', options),
    select,
    update,
    getState,
    observe,
    destroy,
  });
  return controller;
}
