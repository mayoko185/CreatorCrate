// Connect the Asset Detail image or comic Reader activation to the shared
// viewer. Only current file refreshes reconcile a session opened by this host;
// missing/retired authority withdraws activation until a current file install.
// Click handling is delegated once, so refreshed media needs no rebinding.

import {
  ASSET_DETAILS_VIEWER_ATTRIBUTES,
  ASSET_VIEWER_REFRESH_CHANGE,
  ASSET_VIEWER_REFRESH_REGIONS,
  observeAssetViewerRefresh,
} from './asset-viewer-refresh.js';
import { isEnhancementBound, liveRegionDocument, markEnhancementBound } from './dom.js';
import { unifiedViewerFor } from './unified-viewer.js';
import { imageSourcesFromViewerTrigger, createSingleImageSource, viewerItemFromSlideshowEntry } from './viewer-sequence.js';

const HOST_SELECTOR = '[data-asset-viewer-host]';
const TRIGGER_SELECTOR = '[data-asset-details-viewer-trigger]';
const PREVIEW_ROOT_SELECTOR = '[data-preview-enhancement]';
const PREVIEW_HEADING_SELECTOR = '#asset-preview-heading';
const COMIC_TRIGGER_SELECTOR = '[data-asset-details-comic-trigger]';
const COMIC_ROOT_SELECTOR = '[data-asset-comic-preview]';
const RETIRED_ATTRIBUTE = 'data-asset-viewer-retired';
// The inert stand-in for a trigger whose asset is gone, and the frame mark
// that makes the next current 'file' install rebuild the preview (its media
// signature includes the frame's class, which the server never renders so).
const GONE_ATTRIBUTE = 'data-asset-details-viewer-gone';
const GONE_FRAME_CLASS = 'asset-preview-frame--gone';
const BOUND_KEY = 'assetDetailsViewerBound';
const STATE_PROPERTY = '__creatorCrateAssetDetailsViewer';
const NUMERIC_ID = /^[1-9]\d*$/;

// The server-rendered descriptor attributes a trigger carries; the refresh
// keeps them in step with the server's current render.
export { ASSET_DETAILS_VIEWER_ATTRIBUTES };

function hostElement(document) {
  return document?.querySelector?.(HOST_SELECTOR) || null;
}

function hostIdentity(host) {
  const projectId = host?.getAttribute?.('data-asset-viewer-project-id') || '';
  const assetId = host?.getAttribute?.('data-asset-viewer-asset-id') || '';
  if (!NUMERIC_ID.test(projectId) || !NUMERIC_ID.test(assetId)) return null;
  return { projectId, assetId };
}

function sourceKey(identity) {
  return `asset-details:${identity.projectId}:${identity.assetId}`;
}

function hostState(document) {
  if (!document[STATE_PROPERTY]) {
    // gone: the source key of an asset a current read found gone, or null.
    // session/key/entryText belong to an image session; comic to a comic
    // session ({ session, projectId, assetId }). At most one is set.
    document[STATE_PROPERTY] = { session: 0, key: null, entryText: null, comic: null, observing: false, gone: null };
  }
  return document[STATE_PROPERTY];
}

// Only the media-bearing 'file' region and the asset's disappearance concern
// the viewer; tags and primary-image installs never do.
function onRefresh(document, change) {
  if (change.type === ASSET_VIEWER_REFRESH_CHANGE.GONE) {
    markAssetDetailsGone(document);
    reconcileAssetDetailsViewer(document, { gone: true });
  } else if (change.type === ASSET_VIEWER_REFRESH_CHANGE.INSTALLED
    && change.regions?.includes(ASSET_VIEWER_REFRESH_REGIONS.FILE)) {
    clearAssetDetailsGone(document);
    reconcileAssetDetailsViewer(document);
  }
}

// Whether the asset this page shows was found gone.
function isGone(document, identity) {
  const gone = document?.[STATE_PROPERTY]?.gone;
  return Boolean(gone && identity && gone === sourceKey(identity));
}

// Replace the trigger with an inert element holding the same nodes (the image
// is moved, not reloaded). Focus on it moves to the Preview heading. Returns
// the inert element.
function invalidateTrigger(document, trigger, className = 'asset-preview-link') {
  const parent = trigger.parentNode;
  if (!parent || typeof document.createElement !== 'function') return null;
  const active = document.activeElement;
  const hadFocus = Boolean(active && (active === trigger || trigger.contains?.(active)));
  const inert = document.createElement('span');
  inert.setAttribute('class', className);
  inert.setAttribute(GONE_ATTRIBUTE, '');
  if (trigger.hasAttribute?.('hidden')) inert.setAttribute('hidden', '');
  parent.insertBefore(inert, trigger);
  Array.from(trigger.childNodes || []).forEach((node) => inert.appendChild(node));
  trigger.remove();
  if (hadFocus) previewHeading(document)?.focus?.({ preventScroll: true });
  return inert;
}

// Withdraw both Reader anchors and the old native source when authority is gone.
function invalidateComicTrigger(document, trigger) {
  const root = trigger.closest?.(COMIC_ROOT_SELECTOR);
  addClass(root, GONE_FRAME_CLASS);
  const image = root?.querySelector?.('[data-preview-image]');
  image?.removeAttribute?.('src');
  image?.setAttribute?.('hidden', '');
  invalidateTrigger(document, trigger, trigger.getAttribute('class') || 'asset-preview-link');
}

/**
 * Record that a current authoritative read found this page's asset gone and
 * invalidate its preview trigger. Idempotent. Called for the refresh's `gone`
 * notification; it never opens, reopens or requests anything.
 *
 * @param {Document} document
 * @returns {boolean} whether the page shows an asset now marked gone
 */
function markAssetDetailsGone(document) {
  const identity = hostIdentity(hostElement(document));
  if (!identity) return false;
  const state = hostState(document);
  state.gone = sourceKey(identity);
  const host = hostElement(document);
  const trigger = triggerIn(host);
  if (trigger) {
    addClass(trigger.closest?.(PREVIEW_ROOT_SELECTOR), GONE_FRAME_CLASS);
    invalidateTrigger(document, trigger);
  }
  // Any Read Comic link in the host, matching identity or not: none of them
  // may open anything once the page's asset is gone.
  Array.from(host?.querySelectorAll?.(COMIC_TRIGGER_SELECTOR) || [])
    .forEach((comicTrigger) => invalidateComicTrigger(document, comicTrigger));
  return true;
}

function addClass(element, name) {
  if (!element) return;
  const names = String(element.getAttribute?.('class') || '').split(/\s+/).filter(Boolean);
  if (!names.includes(name)) element.setAttribute?.('class', [...names, name].join(' '));
}

// A current read installed the 'file' region from a fresh render of this
// asset: the asset exists, and the preview it rebuilt carries a current
// descriptor. Only then is the gone mark lifted.
function clearAssetDetailsGone(document) {
  const state = document?.[STATE_PROPERTY];
  if (!state?.gone) return;
  const host = hostElement(document);
  if (!isGone(document, hostIdentity(host))) return;
  if (host?.querySelector?.(`[${GONE_ATTRIBUTE}]`)) return;
  state.gone = null;
}

// One observer per document, however often the page is enhanced or opened.
function ensureObserving(document) {
  const state = hostState(document);
  if (state.observing) return;
  state.observing = true;
  observeAssetViewerRefresh(document, (change) => onRefresh(document, change));
}

function forget(state) {
  state.session = 0;
  state.key = null;
  state.entryText = null;
  state.comic = null;
}

function isUnmodifiedPrimaryClick(event) {
  if (event.defaultPrevented) return false;
  if (event.button !== undefined && event.button !== 0) return false;
  return !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
}

// The host's one trigger, only inside an image preview frame.
function triggerIn(host) {
  const trigger = host?.querySelector?.(TRIGGER_SELECTOR) || null;
  if (!trigger || !trigger.closest?.(PREVIEW_ROOT_SELECTOR)) return null;
  return trigger;
}

// A trigger focus can return to: connected and not hidden by a failed preview.
function focusableTrigger(document) {
  const host = hostElement(document);
  const trigger = triggerIn(host);
  if (!trigger || trigger.hidden || trigger.hasAttribute?.('hidden')) return null;
  if (trigger.closest?.(PREVIEW_ROOT_SELECTOR)?.getAttribute?.('data-preview-state') === 'failed') return null;
  return trigger;
}

// Absent attributes are partial hints; an empty attribute explicitly clears metadata.
function comicMetadata(trigger) {
  return Object.fromEntries([
    ['filename', 'data-comic-filename'],
    ['projectName', 'data-comic-project-name'],
    ['detailsUrl', 'data-comic-details-url'],
  ].flatMap(([field, attribute]) => {
    const value = trigger.getAttribute?.(attribute);
    return value == null ? [] : [[field, value]];
  }));
}

// The host's Read Comic link, only inside its comic frame and only for the
// host's own project and asset: a link naming any other identity opens nothing.
function comicTriggerIn(host) {
  const identity = hostIdentity(host);
  const triggers = Array.from(host?.querySelectorAll?.(COMIC_TRIGGER_SELECTOR) || []);
  const visible = (trigger) => !trigger.hidden && !trigger.hasAttribute?.('hidden');
  const trigger = triggers.find((node) => node.hasAttribute('data-preview-fallback') && visible(node))
    || triggers.find(visible) || triggers[0] || null;
  if (!identity || !trigger || !trigger.closest?.(COMIC_ROOT_SELECTOR)) return null;
  if (trigger.getAttribute?.('data-comic-project') !== identity.projectId
    || trigger.getAttribute?.('data-comic-asset') !== identity.assetId) return null;
  return trigger;
}

function focusableComicTrigger(document) {
  const trigger = comicTriggerIn(hostElement(document));
  if (!trigger || trigger.hidden || trigger.hasAttribute?.('hidden')) return null;
  return trigger;
}

function previewHeading(document) {
  const heading = document?.querySelector?.(PREVIEW_HEADING_SELECTOR) || null;
  if (heading && !heading.hasAttribute?.('tabindex')) heading.setAttribute?.('tabindex', '-1');
  return heading;
}

// The authoritative slideshow-format entry for the trigger (the shape B1's
// createSingleImageSource and viewerItemFromSlideshowEntry accept).
function readEntry(identity, trigger) {
  if (!identity || !trigger) return null;
  const originalUrl = trigger.getAttribute?.('data-viewer-original-url') || '';
  const revision = trigger.getAttribute?.('data-viewer-revision') || '';
  return {
    id: identity.assetId,
    projectId: identity.projectId,
    filename: trigger.getAttribute?.('data-viewer-filename') || '',
    projectName: trigger.getAttribute?.('data-viewer-project-name') || null,
    previewUrl: trigger.getAttribute?.('data-viewer-preview-url') || '',
    ...(originalUrl ? { originalUrl } : {}),
    revision: revision || null,
    imageSources: imageSourcesFromViewerTrigger(trigger),
  };
}

function isRetired(host) {
  return Boolean(host?.hasAttribute?.(RETIRED_ATTRIBUTE));
}

/**
 * Open the page's own image in single-image mode.
 *
 * @param {Document} document
 * @param {Element|null} [opener]  defaults to the page's trigger
 * @returns {number} the viewer session, or 0 when nothing opened
 */
export function openAssetDetailsImage(document, opener = null) {
  const viewer = unifiedViewerFor(document);
  const host = hostElement(document);
  const identity = hostIdentity(host);
  const trigger = triggerIn(host);
  if (!viewer || !identity || !trigger || isRetired(host) || isGone(document, identity)) return 0;
  const entry = readEntry(identity, trigger);
  const key = sourceKey(identity);
  const source = createSingleImageSource({
    key,
    entries: [entry],
    projectId: identity.projectId,
    assetId: identity.assetId,
  });
  if (source.items.length === 0) return 0;
  const session = viewer.open(source, {
    opener: opener || trigger,
    // The preview rebuilt by a refresh, else the Preview heading.
    fallbackFocus: () => focusableTrigger(document) || previewHeading(document),
  });
  if (!session) return 0;
  ensureObserving(document);
  const state = hostState(document);
  forget(state);
  state.session = session;
  state.key = key;
  state.entryText = JSON.stringify(entry);
  return session;
}

/**
 * Open the page's own comic in the shared viewer's comic reader. Only the
 * host's current Read Comic link can open it: a page whose asset is gone or
 * retired, a link naming another identity, or an opener other than the
 * current link (a detached old one) opens nothing and requests nothing.
 *
 * @param {Document} document
 * @param {Element|null} [opener]  defaults to the page's Read Comic link
 * @returns {number} the viewer session, or 0 when nothing opened
 */
export function openAssetDetailsComic(document, opener = null) {
  const viewer = unifiedViewerFor(document);
  if (!viewer || typeof viewer.openComic !== 'function') return 0;
  const host = hostElement(document);
  const identity = hostIdentity(host);
  const trigger = comicTriggerIn(host);
  if (!identity || !trigger || isRetired(host) || isGone(document, identity)) return 0;
  if (opener && opener !== trigger) return 0;
  const sourceRevision = trigger.getAttribute?.('data-comic-source-revision') || '';
  if (!sourceRevision) return 0;
  const session = viewer.openComic({
    projectId: Number(identity.projectId),
    assetId: Number(identity.assetId),
    ...comicMetadata(trigger),
    title: trigger.getAttribute?.('data-comic-title') || '',
    sourceRevision,
  }, {
    opener: trigger,
    // The link a refresh rebuilt for this comic, else the Preview heading.
    fallbackFocus: () => focusableComicTrigger(document) || previewHeading(document),
  });
  if (!session) return 0;
  ensureObserving(document);
  const state = hostState(document);
  forget(state);
  state.comic = { session, projectId: identity.projectId, assetId: identity.assetId };
  return session;
}

// The page's authoritative descriptor for the open comic, after a current
// 'file' install (or gone): its Read Comic link's hint, or `eligible: false`
// when the page no longer offers that comic. Another identity yields null,
// which closes the reader.
function comicHint(document, comic, gone) {
  const host = hostElement(document);
  const identity = hostIdentity(host);
  if (!identity || identity.projectId !== comic.projectId || identity.assetId !== comic.assetId) return null;
  const ids = { projectId: Number(comic.projectId), assetId: Number(comic.assetId) };
  if (gone || isRetired(host) || isGone(document, identity)) return { ...ids, eligible: false };
  const trigger = comicTriggerIn(host);
  const sourceRevision = trigger?.getAttribute?.('data-comic-source-revision') || '';
  return sourceRevision ? { ...ids, ...comicMetadata(trigger), sourceRevision } : { ...ids, eligible: false };
}

function reconcileComicSession(document, state, gone) {
  const { comic } = state;
  const viewer = unifiedViewerFor(document);
  const viewerState = viewer?.getState?.();
  if (!viewerState?.open || viewerState.session !== comic.session || !viewerState.comic
    || typeof viewer.reconcileComic !== 'function') {
    forget(state);
    return null;
  }
  // The controller compares the hint itself: an unchanged one reloads nothing.
  const result = viewer.reconcileComic(comicHint(document, comic, gone), { session: comic.session });
  if (!viewer.getState().open) forget(state);
  return result;
}

/**
 * Reconcile an open Asset Details viewer session with the page as an
 * authoritative refresh just installed it. Call only after a current read
 * was accepted, or with `gone` when the asset was found missing or retired.
 * Sessions this page did not open, or that have since closed or been
 * replaced, are never touched.
 *
 * @param {Document|Element} scope
 * @param {{ gone?: boolean }} [options]
 * @returns {object|null} the reconciliation result, or null when nothing applied
 */
export function reconcileAssetDetailsViewer(scope = globalThis.document, { gone = false } = {}) {
  const document = liveRegionDocument(scope);
  if (!document) return null;
  const state = document[STATE_PROPERTY];
  if (state?.comic) return reconcileComicSession(document, state, gone);
  if (!state?.session) return null;
  const viewer = unifiedViewerFor(document);
  const viewerState = viewer?.getState?.();
  if (!viewerState?.open || viewerState.session !== state.session) {
    forget(state);
    return null;
  }

  const host = hostElement(document);
  const identity = hostIdentity(host);
  const trigger = gone || isRetired(host) || isGone(document, identity) ? null : triggerIn(host);
  const entry = identity && trigger ? readEntry(identity, trigger) : null;
  const entryText = entry ? JSON.stringify(entry) : null;
  // Unchanged authoritative data needs no update (a tags or primary-image
  // refresh, or a file refresh that changed nothing the viewer shows).
  if (entryText && entryText === state.entryText) return null;
  state.entryText = entryText;
  // A different asset identity names a different source key, which closes;
  // no entry (gone, or no longer an image) closes too.
  const result = viewer.update({
    key: identity ? sourceKey(identity) : state.key,
    items: entry ? [viewerItemFromSlideshowEntry(entry)] : [],
  }, { session: state.session });
  if (!viewer.getState().open) forget(state);
  return result;
}

/**
 * Bind Asset Details preview activation once per document. A page without
 * the Asset Details media host is left untouched.
 *
 * @param {Document|Element} [scope]
 * @returns {0|1}
 */
export function enhanceAssetDetailsViewer(scope = globalThis.document) {
  const document = liveRegionDocument(scope);
  if (!document || typeof document.addEventListener !== 'function') return 0;
  if (!hostElement(document)) return 0;
  if (isEnhancementBound(document, BOUND_KEY)) return 1;
  markEnhancementBound(document, BOUND_KEY);
  ensureObserving(document);

  document.addEventListener('click', (event) => {
    if (!isUnmodifiedPrimaryClick(event)) return;
    const comicTrigger = event.target?.closest?.(COMIC_TRIGGER_SELECTOR);
    if (comicTrigger) {
      const host = hostElement(document);
      if (!host || !host.contains?.(comicTrigger) || comicTriggerIn(host) !== comicTrigger) return;
      if (openAssetDetailsComic(document, comicTrigger)) event.preventDefault?.();
      return;
    }
    const trigger = event.target?.closest?.(TRIGGER_SELECTOR);
    if (!trigger) return;
    const host = hostElement(document);
    if (!host || !host.contains?.(trigger) || triggerIn(host) !== trigger) return;
    if (openAssetDetailsImage(document, trigger)) event.preventDefault?.();
  });
  return 1;
}
