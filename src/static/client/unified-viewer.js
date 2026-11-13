// ─── Unified viewer: shared dialog shell controller ──────────────────────────
//
// Drives the one layout-level viewer dialog (partials/unified-viewer.njk) from
// a normalized viewer source (viewer-sequence.js). It owns the viewer session
// — which source is open and which item is current — and the shell around the
// media: footer context, View details, position and Previous/Next.
//
// Everything a dialog needs beyond that is the shared app-dialog binder's:
// showModal, focus containment, Escape and dropdown handling, backdrop
// dismissal, body scroll locking and focus restoration. This module opens and
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
//
// Comics (C1b) use the same session. openComic() allocates the session and
// opens the dialog at once with an empty comic source while one abortable
// manifest request (comic-source.js) runs; a validated manifest is then
// published into that session as an 'update' (reason 'manifest') and page 1
// loads through the content participant. The session's `comic` record holds
// the source-level state: 'loading' | 'ready' | 'failed' | 'changed'. A
// current page's HTTP 409 retires the whole accepted revision back to an
// empty source ('changed') until explicit Retry. A new authoritative host
// source hint retires obsolete pages and fetches a fresh manifest immediately.
// Every manifest result is checked against its session and
// request token, so a late one never reopens, replaces or overwrites anything.
//
// C1c: a comic session also carries reader options (direction 'ltr'|'rtl',
// layout 'single'|'spread', alignment 'cover-alone'|'pair-from-first'),
// defaulting to Left-to-Right, Single Page, Cover Alone. They are
// presentation/navigation state of the session, never part of the source:
// the canonical page order, keys and revision are untouched. The session's
// `key` is the anchor page; setComicReaderOptions() keeps it and announces a
// 'reader' change, Previous/Next and the reading-direction-aware arrow keys
// step one group (resolveComicPageGroup/stepComicPageGroup), and
// getState().reader exposes the visible group.
//
// C1e: the content participant renders that group (one or two pages) and
// reconciles its page media on 'reader' changes without refetching pages
// that stay visible; playback ignores them. The shell's position text is
// the group's label ("Page 1 of 7", "Pages 2–3 of 7"), refreshed on its own
// for a reader change so the content participant's status is untouched.
//
// The footer's Reading direction and Page layout dropdowns (the
// shared compact dropdown component) are shown only for a comic session and
// always mirror the session's accepted reader options. A choice is applied
// through setComicReaderOptions() for the session the controls were rendered
// for, so a stale event never reaches another session. Every effective change
// is remembered for that comic, and each new session starts from its
// browser-local options, so the first page group
// already loads in the remembered layout. Page layout offers Single Page and
// the two spread alignments; Single Page keeps the remembered alignment.

import { liveRegionDocument, setHidden } from './dom.js';
import { comicSourceKey, fetchComicSource, COMIC_SOURCE_ERROR } from './comic-source.js';
import { closeAppDialogById, openAppDialogById } from './app-dialogs.js';
import { createComicReaderPreferences } from './comic-reader-preferences.js';
import {
  CC_DROPDOWN_SELECTOR,
  enhanceViewportDisclosures,
  syncCreatorCrateDropdownFromNative,
  updateAssetViewerFilterDisclosureState,
} from './dropdowns.js';
import { createViewerContent } from './viewer-content.js';
import { createViewerFullscreen } from './viewer-fullscreen.js';
import { createViewerPlayback, VIEWER_CAUSE_PLAYBACK, VIEWER_CAUSE_USER } from './viewer-playback.js';
import {
  createViewerSource,
  findViewerItemIndex,
  getViewerItem,
  getViewerAssetContext,
  normalizeViewerAssetContext,
  normalizeComicReaderOptions,
  normalizeViewerUrl,
  reconcileViewerSource,
  resolveComicPageGroup,
  selectInitialViewerItem,
  stepComicPageGroup,
  stepViewerSequence,
  VIEWER_LAYOUT_SINGLE,
  VIEWER_LAYOUT_SPREAD,
  VIEWER_READING_RTL,
  VIEWER_SPREAD_COVER_ALONE,
  VIEWER_SPREAD_PAIR_FROM_FIRST,
  VIEWER_RECONCILE_CLOSED,
  VIEWER_RECONCILE_IDLE,
  VIEWER_SOURCE_KIND_COMIC,
  VIEWER_SOURCE_MODE_SEQUENCE,
  VIEWER_UNAVAILABLE_MISSING_MEDIA,
} from './viewer-sequence.js';

export const UNIFIED_VIEWER_DIALOG_ID = 'unified-viewer-dialog';

// Source-level comic session states (getState().comic.state).
export const VIEWER_COMIC_LOADING = 'loading';
export const VIEWER_COMIC_READY = 'ready';
export const VIEWER_COMIC_FAILED = 'failed';
export const VIEWER_COMIC_CHANGED = 'changed';

// reconcileComic() outcomes.
export const VIEWER_COMIC_HINT_UNCHANGED = 'unchanged';
export const VIEWER_COMIC_HINT_RELOADING = 'reloading';
export const VIEWER_COMIC_HINT_RETIRED = 'retired';
export const VIEWER_COMIC_HINT_RECORDED = 'recorded';
export const VIEWER_COMIC_HINT_CLOSED = 'closed';

const COMIC_MESSAGES = Object.freeze({
  loading: 'Loading comic…',
  empty: 'This comic contains no supported pages.',
  pageUnavailable: 'Page unavailable.',
  changed: 'This comic changed while it was open. Retry to load the current version.',
  notFound: 'This comic could not be found.',
  unreadable: 'This comic could not be read.',
  busy: 'This comic is temporarily unavailable. Try again in a moment.',
  failed: 'This comic could not be loaded.',
});

// Manifest failures that a repeated request cannot fix: Retry is not offered.
const PERMANENT_MANIFEST_STATUSES = new Set([404, 415, 422]);

function comicFailure(error) {
  const status = error?.code === COMIC_SOURCE_ERROR.HTTP ? error.status : null;
  if (status === 404) return { message: COMIC_MESSAGES.notFound, retryable: false };
  if (status === 415 || status === 422) return { message: COMIC_MESSAGES.unreadable, retryable: false };
  if (status === 503) return { message: COMIC_MESSAGES.busy, retryable: true };
  if (error?.code === COMIC_SOURCE_ERROR.INVALID_REQUEST) return { message: COMIC_MESSAGES.failed, retryable: false };
  return { message: COMIC_MESSAGES.failed, retryable: !PERMANENT_MANIFEST_STATUSES.has(status) };
}

// The host's indexed-source revision hint (never the manifest revision).
function normalizeSourceHint(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.length > 0 && value.length <= 512) return value;
  return null;
}

// Change types delivered to observers.
export const VIEWER_CHANGE_OPEN = 'open';
export const VIEWER_CHANGE_NAVIGATE = 'navigate';
export const VIEWER_CHANGE_UPDATE = 'update';
export const VIEWER_CHANGE_CLOSE = 'close';
// C1c: a comic session's reader options changed; the anchor page and source
// are unchanged (reload: false, preserveView: true). C1e: the content
// participant reconciles the visible pages, keeping those that stay.
export const VIEWER_CHANGE_READER = 'reader';

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
const READER_SELECTOR = '[data-unified-viewer-reader]';
const DIRECTION_SELECTOR = '[data-unified-viewer-direction]';
const LAYOUT_SELECTOR = '[data-unified-viewer-layout]';
const STABLE_FOCUS_FALLBACK_ID = 'main-content';

// C1f: the Page layout dropdown's choices. Single Page leaves the
// alignment as it is; each spread choice sets layout and alignment.
const LAYOUT_CHOICES = Object.freeze({
  single: Object.freeze({ layout: VIEWER_LAYOUT_SINGLE }),
  'spread-cover-alone': Object.freeze({ layout: VIEWER_LAYOUT_SPREAD, alignment: VIEWER_SPREAD_COVER_ALONE }),
  'spread-pair-from-first': Object.freeze({ layout: VIEWER_LAYOUT_SPREAD, alignment: VIEWER_SPREAD_PAIR_FROM_FIRST }),
});

function layoutChoiceOf(reader) {
  if (reader.layout === VIEWER_LAYOUT_SINGLE) return 'single';
  return reader.alignment === VIEWER_SPREAD_PAIR_FROM_FIRST ? 'spread-pair-from-first' : 'spread-cover-alone';
}

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
  '[data-cc-viewport-disclosure]',
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
  const dialogTitle = dialog.querySelector?.(`#${UNIFIED_VIEWER_DIALOG_ID}-title`) || null;
  const closeButton = dialog.querySelector?.(CLOSE_SELECTOR) || null;
  const title = root.querySelector?.(TITLE_SELECTOR) || null;
  const sourceLabel = root.querySelector?.(SOURCE_SELECTOR) || null;
  const projectLabel = root.querySelector?.('[data-unified-viewer-project]') || null;
  const metadata = root.querySelector?.('.unified-viewer-heading') || null;
  const footer = root.querySelector?.(CONTEXT_SELECTOR) || null;
  const overflow = root.querySelector?.('[data-unified-viewer-overflow]') || null;
  const overflowPanel = root.querySelector?.('[data-unified-viewer-overflow-panel]') || null;
  enhanceViewportDisclosures(root);
  const zoomTools = root.querySelector?.('[data-unified-viewer-zoom-tools]') || null;
  const speedTools = root.querySelector?.('.unified-viewer-speed-field') || null;
  const details = root.querySelector?.(DETAILS_SELECTOR) || null;
  const controls = root.querySelector?.(CONTROLS_SELECTOR) || null;
  const previous = root.querySelector?.(PREVIOUS_SELECTOR) || null;
  const next = root.querySelector?.(NEXT_SELECTOR) || null;
  const position = root.querySelector?.(POSITION_SELECTOR) || null;
  const readerGroup = root.querySelector?.(READER_SELECTOR) || null;
  const directionSelect = readerGroup?.querySelector?.(DIRECTION_SELECTOR) || null;
  const layoutSelect = readerGroup?.querySelector?.(LAYOUT_SELECTOR) || null;
  const preferences = createComicReaderPreferences();
  // The comic session the reader controls present; 0 while they are hidden.
  let readerControlsSession = 0;

  const view = document.defaultView || null;
  const secondaryTools = [zoomTools, readerGroup, speedTools].filter(Boolean)
    .map((element) => ({ element, parent: element.parentNode, next: element.nextSibling }));
  let compactTools = false;
  let footerFrame = null;
  let textMeasure = null;

  function closeToolMenus(selector = '[data-cc-viewport-disclosure][open]') {
    for (const menu of root.querySelectorAll?.(selector) || []) {
      menu.open = false;
      menu.removeAttribute?.('open');
      updateAssetViewerFilterDisclosureState(menu);
    }
  }

  function syncFooterLayout() {
    if (!dialog.open || !footer?.clientWidth || !view?.getComputedStyle) return;
    const focused = document.activeElement;
    const fontSize = Number.parseFloat(view.getComputedStyle(document.documentElement).fontSize) || 16;
    const compact = footer.clientWidth < 64 * fontSize;
    let movedFocus = false;
    if (compact !== compactTools) {
      closeToolMenus();
      compactTools = compact;
      for (const { element, parent, next } of secondaryTools) {
        if (compact) overflowPanel?.appendChild(element);
        else parent?.insertBefore(element, next?.parentNode === parent ? next : null);
      }
      for (const select of [directionSelect, layoutSelect, speedTools?.querySelector('select')].filter(Boolean)) {
        setHidden(select, !compact);
        // Compact native selections must refresh the restored dropdown summary.
        if (!compact) syncCreatorCrateDropdownFromNative(select);
      }
      movedFocus = focused && secondaryTools.some(({ element }) => element.contains(focused));
    }
    setHidden(zoomTools, regions.viewTools?.hidden !== false);
    setHidden(speedTools, regions.playback?.hidden !== false);
    const hasTools = secondaryTools.some(({ element }) => !element.hidden);
    const hiddenFocus = focused && secondaryTools.some(({ element }) => element.hidden && element.contains(focused));
    if ((!compact || !hasTools) && overflow?.open) closeToolMenus();
    setHidden(overflow, !compact || !hasTools);
    if (movedFocus || hiddenFocus) {
      (compact && hasTools ? overflow?.querySelector('summary') : closeButton)?.focus({ preventScroll: true });
    } else if (focused && overflow?.contains(focused) && (!hasTools || !compact)) {
      closeButton?.focus({ preventScroll: true });
    }

    // Chrome keeps its boxes while hidden, so these offsets never collapse
    // on inactivity and never change the media viewport.
    root.style?.setProperty('--viewer-footer-height', `${footer.getBoundingClientRect().height}px`);
    root.style?.setProperty('--viewer-navigation-height', `${controls?.hidden ? 0 : controls?.getBoundingClientRect().height || 0}px`);
    const failure = regions.media?.querySelector?.('[data-unified-viewer-failure]');
    root.style?.setProperty('--viewer-retry-width', `${failure?.getBoundingClientRect().width || 0}px`);

    // Measure the caption's actual font and allocated width. Optional project
    // text must fit whole while a long filename keeps most of that width.
    textMeasure ||= document.createElement('canvas').getContext('2d');
    if (!textMeasure || !metadata || !title || !sourceLabel) return;
    const caption = view.getComputedStyle(title);
    textMeasure.font = caption.font;
    const available = metadata.clientWidth;
    const filenameWidth = textMeasure.measureText(title.textContent).width;
    const filenameAllocation = Math.min(filenameWidth, Math.max(12 * parseFloat(caption.fontSize), available * 0.6));
    const projectWidth = textMeasure.measureText(sourceLabel.textContent).width
      + textMeasure.measureText('\u00b7').width + 0.375 * fontSize;
    const gap = parseFloat(view.getComputedStyle(metadata).columnGap) || 0;
    const showProject = Boolean(sourceLabel.textContent) && filenameAllocation + projectWidth + gap + 1 <= available;
    setHidden(projectLabel, !showProject);
  }

  function queueFooterLayout() {
    if (footerFrame !== null || !view?.requestAnimationFrame) return;
    footerFrame = view.requestAnimationFrame(() => {
      footerFrame = null;
      if (!destroyed) syncFooterLayout();
    });
  }

  function renderMetadata(context, filename) {
    setText(title, filename);
    title?.setAttribute?.('title', filename);
    title?.setAttribute?.('aria-label', filename);
    const projectName = context?.projectName || '';
    if (sourceLabel?.textContent !== projectName || !projectName) setHidden(projectLabel, true);
    setText(sourceLabel, projectName);
    setHidden(sourceLabel, !projectName);
    queueFooterLayout();
  }

  let sessionCounter = 0;
  // Manifest request tokens, unique across sessions.
  let manifestCounter = 0;
  // The open session: { session, source, key, opener, fallbackFocus, comic }.
  // `comic` is null for image sources; for a comic it is the source-level
  // record { projectId, assetId, key, title, label, sourceHint, state,
  // revision, pageCount, request, abort, message, retryable, error,
  // httpStatus, attempt }. A comic session also has `reader`: its frozen
  // reader options (C1c), kept across manifest requests within the session.
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
    renderMetadata(null, '');
    closeToolMenus();
    details?.removeAttribute?.('href');
    setHidden(details, true);
    setText(regions.status, '');
    regions.media?.replaceChildren?.();
    setText(position, '');
    setHidden(controls, true);
    root.setAttribute?.('data-viewer-item-state', 'empty');
    root.removeAttribute?.('data-viewer-comic-state');
    syncReaderControls();
  }

  // ── Comic reader controls (C1f) ───────────────────────────────────────────

  function setSelectValue(select, value) {
    if (!select || String(select.value) === value) return;
    select.value = value;
    syncCreatorCrateDropdownFromNative(select);
  }

  function closeReaderMenus() {
    for (const menu of readerGroup?.querySelectorAll?.(`${CC_DROPDOWN_SELECTOR}[open]`) || []) {
      menu.open = false;
      menu.removeAttribute?.('open');
      updateAssetViewerFilterDisclosureState(menu);
    }
  }

  // Show the controls with the open comic session's accepted options, or
  // hide them (closing an open menu) for an image session or no session.
  // Focus held inside hidden controls moves to Close.
  function syncReaderControls() {
    if (!readerGroup) return;
    const session = active?.comic ? active : null;
    if (!session) {
      readerControlsSession = 0;
      if (readerGroup.hidden) return;
      const focused = document.activeElement;
      closeReaderMenus();
      setHidden(readerGroup, true);
      if (focused && readerGroup.contains?.(focused) && dialog.open) {
        dialog.querySelector?.(CLOSE_SELECTOR)?.focus?.({ preventScroll: true });
      }
      return;
    }
    readerControlsSession = session.session;
    setSelectValue(directionSelect, session.reader.direction);
    setSelectValue(layoutSelect, layoutChoiceOf(session.reader));
    setHidden(readerGroup, false);
  }

  // A choice made in the controls applies only to the session they were
  // rendered for; anything rejected re-shows the accepted options.
  function applyReaderChoice(patch) {
    if (destroyed) return;
    const sessionId = readerControlsSession;
    if (patch && sessionId && active?.comic && active.session === sessionId) {
      setComicReaderOptions(patch, { session: sessionId });
    }
    syncReaderControls();
  }

  const onDirectionChange = () => {
    applyReaderChoice({ direction: directionSelect?.value });
  };
  const onLayoutChange = () => {
    const value = String(layoutSelect?.value ?? '');
    applyReaderChoice(Object.prototype.hasOwnProperty.call(LAYOUT_CHOICES, value) ? LAYOUT_CHOICES[value] : null);
  };

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

  function syncDetails(context) {
    const url = normalizeViewerUrl(context?.detailsUrl);
    if (url) details?.setAttribute?.('href', url);
    else details?.removeAttribute?.('href');
    setHidden(details, !url);
  }

  // A comic without a current page retains its archive context.
  function renderComicSource(focusedBefore) {
    const { comic } = active;
    renderMetadata(active.source.context, active.source.context?.filename || comic.title || 'Comic');
    syncDetails(active.source.context);
    root.setAttribute?.('data-viewer-item-state', 'empty');
    root.setAttribute?.('data-viewer-comic-state', comic.state);
    let message = '';
    if (comic.state === VIEWER_COMIC_READY) message = COMIC_MESSAGES.empty;
    else if (comic.state === VIEWER_COMIC_FAILED || comic.state === VIEWER_COMIC_CHANGED) message = comic.message;
    setText(regions.status, message);
    setText(position, '');
    setHidden(controls, true);
    rescueFocus(focusedBefore);
  }

  function syncDialogTitle() {
    if (!active) return;
    const heading = active.source.kind === VIEWER_SOURCE_KIND_COMIC
      ? 'Comic Reader'
      : (active.source.slideshow ? 'Slideshow' : 'Image Preview');
    setText(dialogTitle, heading);
    closeButton?.setAttribute?.('aria-label', `Close ${heading}`);
    closeButton?.setAttribute?.('title', `Close ${heading}`);
  }

  function render() {
    syncDialogTitle();
    const focusedBefore = document.activeElement;
    syncReaderControls();
    const { item, index, count } = currentView();
    if (active?.comic && !item) {
      renderComicSource(focusedBefore);
      return;
    }
    if (!active || !item) {
      resetPresentation();
      return;
    }

    const isComic = Boolean(active.comic);
    const context = getViewerAssetContext(active.source, active.key);
    renderMetadata(context, context?.filename || (isComic && active.comic.title) || item.title);
    if (isComic) root.setAttribute?.('data-viewer-comic-state', active.comic.state);

    syncDetails(context);

    root.setAttribute?.('data-viewer-item-state', item.available ? 'available' : 'unavailable');
    let unavailableMessage = '';
    if (!item.available) {
      unavailableMessage = isComic
        ? COMIC_MESSAGES.pageUnavailable
        : (UNAVAILABLE_MESSAGES[item.unavailableReason] || UNAVAILABLE_FALLBACK_MESSAGE);
    }
    setText(regions.status, unavailableMessage);

    const isSequence = active.source.mode === VIEWER_SOURCE_MODE_SEQUENCE;
    const navigable = isSequence && count > 1;
    setHidden(controls, !isSequence);
    let positionText = '';
    // A comic names its rendered group, in canonical page numbers.
    if (isSequence) positionText = isComic ? comicPositionText(index, count) : `${index + 1} of ${count}`;
    setText(position, positionText);
    setHidden(previous, !navigable && !isComic);
    setHidden(next, !navigable && !isComic);
    syncNavigationState(index, count, navigable);
    rescueFocus(focusedBefore);
  }

  function syncNavigationState(index, count, navigable) {
    const group = active?.comic ? resolveComicPageGroup(active.source, active.key, active.reader) : null;
    if (group) {
      // Comic boundaries follow the anchor's group, not the anchor's index.
      setDisabled(previous, !navigable || group.previousKey === null);
      setDisabled(next, !navigable || group.nextKey === null);
      return;
    }
    const wrap = active?.source.wrap === true;
    setDisabled(previous, !navigable || (!wrap && index <= 0));
    setDisabled(next, !navigable || (!wrap && index >= count - 1));
  }

  function comicPositionText(index, count) {
    const group = resolveComicPageGroup(active.source, active.key, active.reader);
    return group ? group.label : `Page ${index + 1} of ${count}`;
  }

  // A reader-option change re-evaluates Previous/Next and the group's
  // position text only: the anchor item and its status (owned by the
  // content participant) are unchanged.
  function renderReaderNavigation() {
    const focusedBefore = document.activeElement;
    const { item, index, count } = currentView();
    if (!item) return;
    syncNavigationState(index, count, active.source.mode === VIEWER_SOURCE_MODE_SEQUENCE && count > 1);
    const label = comicPositionText(index, count);
    if (position && active.source.mode === VIEWER_SOURCE_MODE_SEQUENCE && position.textContent !== label) {
      setText(position, label);
    }
    rescueFocus(focusedBefore);
  }

  // ── Comic reader contract (C1c) ───────────────────────────────────────────

  // The intended visible comic pages of a session, null for image sources.
  // Group fields are empty while no page is current (loading, failed,
  // changed or an empty comic). `visibleItems` is in visual left-to-right
  // order; every other list is canonical ascending order.
  function readerSnapshot(session) {
    if (!session?.comic) return null;
    const options = session.reader;
    const group = resolveComicPageGroup(session.source, session.key, options);
    return Object.freeze({
      direction: options.direction,
      layout: options.layout,
      alignment: options.alignment,
      anchorKey: group ? group.anchorKey : null,
      anchorPosition: group ? group.anchorPosition : null,
      groupPositions: group ? group.positions : Object.freeze([]),
      groupKeys: group ? group.keys : Object.freeze([]),
      groupItems: group ? group.items : Object.freeze([]),
      visibleItems: group ? group.visibleItems : Object.freeze([]),
      groupIndex: group ? group.groupIndex : -1,
      groupCount: group ? group.groupCount : 0,
      pageCount: group ? group.pageCount : 0,
      canPrevious: Boolean(group && group.previousKey !== null),
      canNext: Boolean(group && group.nextKey !== null),
      previousKey: group ? group.previousKey : null,
      nextKey: group ? group.nextKey : null,
      label: group ? group.label : '',
    });
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
      context: getViewerAssetContext(session.source, session.key),
      previousKey: null,
      reload: false,
      preserveView: false,
      reason: null,
      reader: readerSnapshot(session),
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
    // A pending manifest of this session is cancelled; its token no longer
    // matches the (now absent) active session, so nothing it settles with
    // is shown.
    if (ended.comic) {
      const pending = ended.comic.abort;
      ended.comic.abort = null;
      ended.comic.request = 0;
      pending?.abort();
    }
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
    if (canRestoreFocus(candidate) && !dialog.contains?.(candidate)) return candidate;
    return document.getElementById?.(STABLE_FOCUS_FALLBACK_ID) || null;
  }

  function canRestoreFocus(element) {
    return isConnected(document, element) && !element.hidden && !element.disabled
      && !element.closest?.('[hidden], [inert]');
  }

  // Runs inside the binder's dismissal, before it restores focus to
  // dialogState.opener: native Preview failure can hide a retained opener.
  function applyFocusFallback() {
    const plan = pendingFocus;
    pendingFocus = null;
    if (!plan) return;
    if (canRestoreFocus(plan.opener)) {
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
    // fallback covers an opener withdrawn in the meantime.
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
   *   fallbackFocus: used when the opener was disconnected or hidden by a live refresh;
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

  // ── Comic sessions (C1b) ──────────────────────────────────────────────────

  function initialReaderOptions(comic, patch) {
    const remembered = preferences.read(comic);
    if (patch === undefined) return remembered;
    return normalizeComicReaderOptions(patch, remembered) || remembered;
  }

  function emptyComicSource(comic) {
    return createViewerSource({ key: comic.key, label: comic.label, kind: VIEWER_SOURCE_KIND_COMIC, context: comic.context, items: [] });
  }

  // Shown in the media region only while a comic session has no current
  // page; with a page, the content participant owns the region.
  const comicLoadingPanel = document.createElement('div');
  comicLoadingPanel.setAttribute('class', 'unified-viewer-loading');
  comicLoadingPanel.setAttribute('data-unified-viewer-comic-loading', '');
  const comicSpinner = document.createElement('span');
  comicSpinner.setAttribute('class', 'unified-viewer-spinner');
  comicSpinner.setAttribute('aria-hidden', 'true');
  const comicLoadingText = document.createElement('span');
  comicLoadingText.textContent = COMIC_MESSAGES.loading;
  comicLoadingPanel.appendChild(comicSpinner);
  comicLoadingPanel.appendChild(comicLoadingText);
  const comicFailurePanel = document.createElement('div');
  comicFailurePanel.setAttribute('class', 'unified-viewer-failure');
  comicFailurePanel.setAttribute('data-unified-viewer-comic-failure', '');
  const comicRetryButton = document.createElement('button');
  comicRetryButton.setAttribute('type', 'button');
  comicRetryButton.setAttribute('class', 'button button-small button-secondary');
  comicRetryButton.setAttribute('data-unified-viewer-comic-retry', '');
  comicRetryButton.textContent = 'Retry';
  comicFailurePanel.appendChild(comicRetryButton);

  function syncComicPanel() {
    if (!active?.comic || currentView().item) return;
    const { state, retryable } = active.comic;
    let panel = null;
    if (state === VIEWER_COMIC_LOADING) panel = comicLoadingPanel;
    else if ((state === VIEWER_COMIC_FAILED && retryable) || state === VIEWER_COMIC_CHANGED) panel = comicFailurePanel;
    if (panel) regions.media?.replaceChildren?.(panel);
    else regions.media?.replaceChildren?.();
    if (state === VIEWER_COMIC_LOADING) regions.media?.setAttribute?.('aria-busy', 'true');
    else regions.media?.removeAttribute?.('aria-busy');
  }

  // Capture page ownership before content observers remove the retiring spread.
  // Recovery runs after the replacement panel is connected, unless an observer
  // has handed focus to another control, modal or viewer session.
  function rescueComicFocus(focused, ownedPage) {
    if (!ownedPage && focused !== comicRetryButton && focused !== previous && focused !== next) return;
    const now = document.activeElement;
    if (now && now !== document.body && now !== focused) return;
    if (Array.from(document.querySelectorAll?.('dialog[open]') || []).some((other) => other !== dialog)) return;
    const usable = (control) => control && isConnected(document, control) && control.isConnected !== false
      && !control.hidden && !control.disabled && dialog.contains?.(control);
    if (usable(focused) && !((focused === previous || focused === next) && controls?.hidden)) {
      if (document.activeElement !== focused) focused.focus?.({ preventScroll: true });
      return;
    }
    const close = dialog.querySelector?.(CLOSE_SELECTOR);
    const target = (usable(comicRetryButton) && comicRetryButton)
      || (usable(close) && close) || dialog;
    target.focus?.({ preventScroll: true });
  }

  function comicTransition(apply) {
    const session = active;
    const focusedBefore = document.activeElement;
    const pageKey = focusedBefore?.getAttribute?.('data-unified-viewer-page-retry');
    const ownedPage = Boolean(pageKey && session?.comic && regions.media?.contains?.(focusedBefore)
      && readerSnapshot(session)?.groupKeys.includes(pageKey));
    apply();
    if (destroyed || active !== session || !dialog.open || !isConnected(document, dialog)) return;
    syncComicPanel();
    rescueComicFocus(focusedBefore, ownedPage);
  }

  function currentFetch() {
    if (typeof view?.fetch === 'function') return view.fetch.bind(view);
    return typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined;
  }

  function ownsManifest(session, token) {
    return !destroyed && active === session && session.comic.request === token;
  }

  function publishComic(session, result) {
    const { comic } = session;
    comicTransition(() => {
      comic.state = VIEWER_COMIC_READY;
      comic.revision = result.comic.revision;
      comic.pageCount = result.comic.pageCount;
      comic.message = '';
      comic.retryable = false;
      comic.error = null;
      comic.httpStatus = null;
      const initial = selectInitialViewerItem(result.source);
      // The manifest carries pages, not archive metadata; use the latest accepted host context.
      session.source = createViewerSource({ ...result.source, context: comic.context });
      session.key = initial.key;
      render();
      notify(VIEWER_CHANGE_UPDATE, session, {
        previousKey: null,
        outcome: 'published',
        reload: true,
        reason: 'manifest',
      });
    });
  }

  function failComic(session, error) {
    const { comic } = session;
    const failure = comicFailure(error);
    comicTransition(() => {
      comic.state = VIEWER_COMIC_FAILED;
      comic.message = failure.message;
      comic.retryable = failure.retryable;
      comic.error = typeof error?.code === 'string' ? error.code : COMIC_SOURCE_ERROR.NETWORK;
      comic.httpStatus = Number.isInteger(error?.status) ? error.status : null;
      render();
    });
  }

  // One abortable manifest request for the session; an older one is aborted
  // and its token invalidated first.
  function requestManifest(session) {
    const { comic } = session;
    const previousAbort = comic.abort;
    manifestCounter += 1;
    const token = manifestCounter;
    const Abort = view?.AbortController || globalThis.AbortController;
    const abort = typeof Abort === 'function' ? new Abort() : null;
    comic.request = token;
    comic.abort = abort;
    previousAbort?.abort();
    comicTransition(() => {
      comic.state = VIEWER_COMIC_LOADING;
      comic.revision = null;
      comic.pageCount = 0;
      comic.message = '';
      comic.retryable = false;
      comic.error = null;
      comic.httpStatus = null;
      render();
    });
    fetchComicSource({
      projectId: comic.projectId,
      assetId: comic.assetId,
      signal: abort?.signal,
      fetch: currentFetch(),
      key: comic.key,
      label: comic.label,
    }).then((result) => {
      if (!ownsManifest(session, token)) return;
      comic.abort = null;
      publishComic(session, result);
    }, (error) => {
      // A cancelled request (Close, Destroy, replacement, a newer request)
      // is never a user-facing failure.
      if (!ownsManifest(session, token) || abort?.signal?.aborted) return;
      comic.abort = null;
      failComic(session, error);
    });
  }

  /**
   * Open a comic. The dialog opens at once on an empty comic source in the
   * 'loading' state while one manifest request runs (fetchComicSource); the
   * validated source is then published into this same session, on page 1.
   * Opening ends any other session first, exactly like open().
   *
   * @param {{ projectId: number|string, assetId: number|string, filename?: string,
   *   projectName?: string, detailsUrl?: string, title?: string,
   *   label?: string, key?: string, sourceRevision?: string|number }} descriptor
   *   Authoritative identity; `title` heads the viewer (else the page name),
   *   `label` is the source label, `sourceRevision` the host's indexed-source
   *   hint compared by reconcileComic() (never the manifest revision).
   * @param {{ opener?: Element|null, fallbackFocus?: Element|(() => Element|null),
   *   reader?: { direction?: string, layout?: string, alignment?: string } }} [options]
   *   reader (C1f): reader options for this session only, over the
   *   remembered preferences (an invalid patch is ignored); not remembered.
   * @returns {number} the new session id, or 0 when nothing could be opened
   */
  function openComic(descriptor, options = {}) {
    if (destroyed) return 0;
    const desc = descriptor && typeof descriptor === 'object' ? descriptor : {};
    let defaultKey;
    try {
      defaultKey = comicSourceKey(desc.projectId, desc.assetId);
    } catch {
      return 0;
    }
    const opts = options && typeof options === 'object' ? options : {};
    const opener = opts.opener !== undefined ? opts.opener : (defaultOpener() || active?.opener || null);
    if (active) endSession('replaced');
    sessionCounter += 1;
    const comic = {
      projectId: desc.projectId,
      assetId: desc.assetId,
      context: normalizeViewerAssetContext(desc),
      key: typeof desc.key === 'string' && desc.key ? desc.key : defaultKey,
      title: typeof desc.title === 'string' ? desc.title.replace(/\s+/g, ' ').trim() : '',
      label: typeof desc.label === 'string' ? desc.label.replace(/\s+/g, ' ').trim() : '',
      sourceHint: normalizeSourceHint(desc.sourceRevision),
      state: VIEWER_COMIC_LOADING,
      revision: null,
      pageCount: 0,
      request: 0,
      abort: null,
      message: '',
      retryable: false,
      error: null,
      httpStatus: null,
      attempt: 0,
    };
    const session = {
      session: sessionCounter,
      source: emptyComicSource(comic),
      key: null,
      opener: opener || null,
      fallbackFocus: opts.fallbackFocus ?? null,
      comic,
      reader: initialReaderOptions(comic, opts.reader),
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
    notify(VIEWER_CHANGE_OPEN, session, { reload: true, autoplay: false });
    // An observer may have closed or replaced the session it was handed.
    if (active === session) requestManifest(session);
    return session.session;
  }

  /**
   * Explicit Retry of the comic source: one fresh manifest request after a
   * retryable manifest failure or a retired ('changed') revision.
   *
   * @param {{ session?: number }} [options]
   * @returns {boolean} whether a request started
   */
  function retryComic(options = {}) {
    if (destroyed || !active?.comic) return false;
    const session = options && typeof options === 'object' ? options.session : undefined;
    if (session !== undefined && session !== active.session) return false;
    const { comic } = active;
    const retryable = (comic.state === VIEWER_COMIC_FAILED && comic.retryable) || comic.state === VIEWER_COMIC_CHANGED;
    if (!retryable) return false;
    comic.attempt += 1;
    requestManifest(active);
    return true;
  }

  // Retire the session's whole accepted page set: abort and release every
  // page load (the content participant ends its foreground on the update),
  // drop every page URL with the source and keep the dialog. Page conflicts
  // wait for explicit Retry; a new host hint immediately requests a manifest.
  // Only the current session's current revision can be
  // retired, so a late or stale conflict changes nothing.
  function retireComicRevision(sessionId, revision, reason) {
    if (destroyed || !active?.comic || active.session !== sessionId) return false;
    const session = active;
    const { comic } = session;
    if (comic.state !== VIEWER_COMIC_READY || typeof revision !== 'string' || revision !== comic.revision) {
      return false;
    }
    comicTransition(() => {
      const previousKey = session.key;
      comic.state = VIEWER_COMIC_CHANGED;
      comic.revision = null;
      comic.pageCount = 0;
      comic.message = COMIC_MESSAGES.changed;
      comic.retryable = true;
      comic.error = null;
      comic.httpStatus = reason === 'conflict' ? 409 : null;
      session.source = emptyComicSource(comic);
      session.key = null;
      render();
      notify(VIEWER_CHANGE_UPDATE, session, { previousKey, outcome: 'retired', reload: true, reason });
    });
    return true;
  }

  // The content participant's report of a current comic page's HTTP 409.
  function onPageConflict(conflict) {
    retireComicRevision(conflict?.session, conflict?.revision, 'conflict');
  }

  /**
   * Reconcile the open comic with its host's authoritative descriptor (C2).
   * Bound to a session: a hint for another session, or for another comic,
   * is ignored (null).
   * - `null` or `{ eligible: false }`: the comic was retired; the viewer closes.
   * - optional metadata fields replace only those supplied by the host.
   * - an unchanged (or absent) `sourceRevision`: nothing reloads.
   * - a changed `sourceRevision`: retire any accepted pages and request one
   *   fresh manifest, including after a permanent failure or page conflict.
   *
   * @param {{ projectId: number|string, assetId: number|string,
   *   sourceRevision?: string|number, eligible?: boolean, filename?: string,
   *   projectName?: string|null, detailsUrl?: string|null }|null} hint
   * @param {{ session: number }} options  the id returned by openComic()
   * @returns {{ outcome: string }|null}
   */
  function reconcileComic(hint, options = {}) {
    if (destroyed || !active?.comic) return null;
    const session = options && typeof options === 'object' ? options.session : undefined;
    if (session !== active.session) return null;
    const { comic } = active;
    if (hint === null) {
      closeWith('retired');
      return Object.freeze({ outcome: VIEWER_COMIC_HINT_CLOSED });
    }
    if (!hint || typeof hint !== 'object') return null;
    let sameComic = false;
    try {
      sameComic = comicSourceKey(hint.projectId, hint.assetId) === comicSourceKey(comic.projectId, comic.assetId);
    } catch {
      sameComic = false;
    }
    if (!sameComic) return null;
    if (hint.eligible === false) {
      closeWith('retired');
      return Object.freeze({ outcome: VIEWER_COMIC_HINT_CLOSED });
    }
    const context = normalizeViewerAssetContext({
      ...comic.context,
      ...Object.fromEntries(['filename', 'projectName', 'detailsUrl']
        .filter((field) => Object.hasOwn(hint, field)).map((field) => [field, hint[field]])),
    });
    const metadataChanged = ['filename', 'projectName', 'detailsUrl']
      .some((field) => context[field] !== comic.context[field]);
    if (metadataChanged) {
      comic.context = context;
      active.source = createViewerSource({ ...active.source, context });
      render();
    }
    const next = normalizeSourceHint(hint.sourceRevision);
    if (next === null || next === comic.sourceHint) {
      if (metadataChanged) notify(VIEWER_CHANGE_UPDATE, active, { preserveView: true, reason: 'metadata' });
      return Object.freeze({ outcome: VIEWER_COMIC_HINT_UNCHANGED });
    }
    const current = active;
    const request = comic.request;
    comic.sourceHint = next;
    if (comic.state === VIEWER_COMIC_READY) {
      retireComicRevision(current.session, comic.revision, 'source-changed');
    }
    // Retirement observers may start a request and return to the same hint.
    // Preserve their request even if it has already settled.
    if (!destroyed && active === current && current.comic === comic
      && comic.sourceHint === next && comic.request === request) {
      requestManifest(current);
    }
    return Object.freeze({ outcome: VIEWER_COMIC_HINT_RELOADING });
  }

  const onComicRetry = (event) => {
    event?.preventDefault?.();
    retryComic();
  };
  comicRetryButton.addEventListener('click', onComicRetry);

  function moveTo(key, extra) {
    const previousKey = active.key;
    active.key = key;
    render();
    notify(VIEWER_CHANGE_NAVIGATE, active, { previousKey, reload: true, cause: VIEWER_CAUSE_USER, ...extra });
  }

  function step(direction, options, cause) {
    if (!active) return null;
    // A comic steps one group (one page in Single Page) in canonical order,
    // unavailable pages included, onto the destination group's first page.
    const result = (active.comic && stepComicPageGroup(active.source, active.key, direction, active.reader))
      || stepViewerSequence(active.source, active.key, direction, {
        skipUnavailable: !active.comic && options?.skipUnavailable === true,
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
   * Change the open comic's reader options (C1c). Accepts any subset of
   * `{ direction: 'ltr'|'rtl', layout: 'single'|'spread',
   * alignment: 'cover-alone'|'pair-from-first' }`; a patch with any invalid
   * value is rejected whole. The anchor page, source, dialog and fullscreen
   * are kept; pages that stay visible keep their media (a direction-only
   * change also keeps zoom/pan; a different group starts in Fit). An
   * effective change re-renders Previous/Next and the position and
   * announces one 'reader' change; repeating the current options announces
   * nothing.
   *
   * @param {object} patch
   * @param {{ session?: number }} [options] the id returned by openComic()
   * @returns {{ changed: boolean, reader: object }|null} null when rejected
   *   (invalid patch, no comic session, or another session)
   */
  function setComicReaderOptions(patch, options = {}) {
    if (destroyed || !active?.comic) return null;
    const session = options && typeof options === 'object' ? options.session : undefined;
    if (session !== undefined && session !== active.session) return null;
    const current = active;
    const previousReader = current.reader;
    const requested = normalizeComicReaderOptions(patch, previousReader);
    if (!requested) return null;
    const fields = Object.keys(requested);
    if (fields.every((name) => requested[name] === previousReader[name])) {
      return Object.freeze({ changed: false, reader: readerSnapshot(current) });
    }
    const changes = {};
    for (const name of fields) {
      if (patch[name] !== undefined) changes[name] = requested[name];
    }
    const result = preferences.write(current.comic, changes);
    if (!result || active !== current) return null;
    current.reader = result.preferences;
    const changedFields = fields.filter((name) => current.reader[name] !== previousReader[name]);
    syncReaderControls();
    renderReaderNavigation();
    notify(VIEWER_CHANGE_READER, current, {
      previousKey: current.key,
      reload: false,
      preserveView: true,
      reason: 'reader-options',
      changed: Object.freeze(changedFields),
      previousReader,
    });
    return Object.freeze({ changed: true, reader: readerSnapshot(current) });
  }

  /**
   * Reconcile the open source with authoritative refreshed data
   * (reconcileViewerSource). An update for another session — one this
   * viewer has since closed or replaced — is ignored. When the reconciled
   * source has nothing left to show, or names a different source, the
   * viewer closes. A comic's pages come only from its manifest, so a comic
   * session ignores item lists (hosts use reconcileComic()).
   *
   * @param {Array<object>|{ key?: string, label?: string, items?: Array<object> }} replacement
   * @param {{ session?: number }} [options] the id returned by open()
   * @returns {object|null} the reconciliation result, or null when ignored
   */
  function update(replacement, options = {}) {
    if (!active || active.comic) return null;
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
      context: active ? getViewerAssetContext(active.source, active.key) : null,
      // B4 summaries; the participants' own getState() has the detail.
      mediaStatus: mediaState.status,
      playback: Object.freeze({
        available: playbackState.available,
        playing: playbackState.playing,
        speed: playbackState.speed,
      }),
      fullscreen: fullscreen.getState().active,
      // C1b: the comic source-level state, null for image sources.
      comic: active?.comic ? Object.freeze({
        state: active.comic.state,
        projectId: active.comic.projectId,
        assetId: active.comic.assetId,
        revision: active.comic.revision,
        pageCount: active.comic.pageCount,
        empty: active.comic.state === VIEWER_COMIC_READY && active.source.items.length === 0,
        retryable: (active.comic.state === VIEWER_COMIC_FAILED && active.comic.retryable)
          || active.comic.state === VIEWER_COMIC_CHANGED,
        error: active.comic.error,
        httpStatus: active.comic.httpStatus,
        message: active.comic.message,
        sourceRevision: active.comic.sourceHint,
        attempt: active.comic.attempt,
      }) : null,
      // C1c: reader options and the intended visible group, null for images.
      reader: readerSnapshot(active),
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
    // Shift+Arrow belongs to the content participant's physical panning.
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    // A Right-to-Left comic reads leftwards: ArrowLeft is Next.
    const rtl = Boolean(active.comic) && active.reader?.direction === VIEWER_READING_RTL;
    const forwardKey = rtl ? 'ArrowLeft' : 'ArrowRight';
    const backwardKey = rtl ? 'ArrowRight' : 'ArrowLeft';
    const direction = event.key === backwardKey ? 'previous' : event.key === forwardKey ? 'next' : null;
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
  directionSelect?.addEventListener?.('change', onDirectionChange);
  layoutSelect?.addEventListener?.('change', onLayoutChange);
  // The content participant observes first, so later participants (B4)
  // already see the media state of the change they are handed.
  const content = createViewerContent({
    document,
    regions,
    observe,
    keyTarget: dialog,
    keyOwned: keyOwnedByControl,
    focusFallback: () => dialog.querySelector?.(CLOSE_SELECTOR) || null,
    onPageConflict,
  });
  const media = Object.freeze({
    getState: content.getState,
    observe: content.observe,
    retry: content.retry,
    zoomIn: content.zoomIn,
    zoomOut: content.zoomOut,
    fit: content.fit,
    showOriginal: content.showOriginal,
    actualSize: content.actualSize,
    switchQuality: content.switchQuality,
    toggleQuality: content.toggleQuality,
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
    dismissMenus: () => closeToolMenus('[data-cc-dropdown][open], [data-cc-viewport-disclosure][open]'),
  });
  const stopMediaLayout = media.observe(queueFooterLayout);
  const stopPlaybackLayout = playback.observe(queueFooterLayout);
  const stopFullscreenLayout = fullscreen.observe(queueFooterLayout);
  const footerResize = view?.ResizeObserver ? new view.ResizeObserver(queueFooterLayout) : null;
  if (footer) footerResize?.observe(footer, { box: 'border-box' });
  if (controls) footerResize?.observe(controls);
  if (metadata) footerResize?.observe(metadata);
  document.fonts?.addEventListener?.('loadingdone', queueFooterLayout);
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
      const opener = canRestoreFocus(plan.opener)
        ? plan.opener
        : resolveFallbackFocus(plan.fallbackFocus);
      fullscreen.deferFocus(opener, () => resolveFallbackFocus(plan.fallbackFocus));
    }
    stopMediaLayout();
    stopPlaybackLayout();
    stopFullscreenLayout();
    footerResize?.disconnect();
    document.fonts?.removeEventListener?.('loadingdone', queueFooterLayout);
    if (footerFrame !== null) view?.cancelAnimationFrame?.(footerFrame);
    fullscreen.destroy();
    playback.destroy();
    content.destroy();
    if (compactTools) {
      for (const { element, parent, next } of secondaryTools) {
        parent?.insertBefore(element, next?.parentNode === parent ? next : null);
      }
      for (const select of [directionSelect, layoutSelect, speedTools?.querySelector('select')].filter(Boolean)) {
        setHidden(select, true);
      }
      setHidden(overflow, true);
    }
    destroyed = true;
    pendingFocus = null;
    observers.clear();
    dialog.removeEventListener?.('keydown', onKeydown);
    previous?.removeEventListener?.('click', onPrevious);
    next?.removeEventListener?.('click', onNext);
    directionSelect?.removeEventListener?.('change', onDirectionChange);
    layoutSelect?.removeEventListener?.('change', onLayoutChange);
    comicRetryButton.removeEventListener('click', onComicRetry);
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
    openComic,
    retryComic,
    reconcileComic,
    setComicReaderOptions,
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
