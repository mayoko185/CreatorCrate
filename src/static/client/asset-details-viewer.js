// ─── Asset Details: unified viewer host integration (Milestone B, B6) ────────
//
// Connects the Asset Details page (/projects/:projectId/assets/:assetId) to
// the shared unified viewer (unified-viewer.js). Like the Project Assets and
// Asset Library hosts (B5a/B5b) this module only translates page activation
// into a B1 viewer source and hands authoritative refresh data to the
// controller; it owns no viewer state machine of its own.
//
// - The page's preview image is the trigger
//   (`[data-asset-details-viewer-trigger]`, inside the media host
//   `[data-asset-viewer-host]`). With an eligible original it is the existing
//   "View original" link; for a preview-only image (a Krita preview, an image
//   whose original is not inline-safe) it is a button around the image. An
//   unmodified primary click opens ONLY this asset (createSingleImageSource):
//   never a gallery, never Previous/Next inside the viewer, never autoplay.
//   Modified and middle clicks keep the link's own navigation. The page's own
//   Previous/Next asset links, the toolbar, metadata, tags and dialogs are
//   never intercepted, and a video, comic, missing or unsupported asset has no
//   trigger at all.
// - The descriptor comes only from server-rendered attributes on the trigger
//   (filename, preview URL, original URL when eligible, revision) plus the
//   host's project and asset identity. No URL is derived on the client.
// - It observes the Asset Details refresh (asset-viewer-refresh.js), which
//   reports only a current read that installed the 'file' region, or that the
//   asset was found missing or retired. reconcileAssetDetailsViewer() then
//   updates an open session this page opened through the controller's
//   update() (B1 reconciliation keeps, reloads or closes it); a session that
//   has since closed or been replaced is never touched.
// - Gone is persistent (B6-F1). When the refresh reports the asset gone (a
//   current read answered 404, or the page was retired), the host records it
//   for this asset identity and invalidates the page's preview trigger before
//   closing any session it opened: the link or button is swapped for an inert
//   element that keeps the same, already loaded image, so neither the viewer
//   nor the original URL can be reached from it again, whether or not the
//   viewer was open. The removed opener sends the viewer's focus return to its
//   fallback (the Preview heading). The frame is marked too, so only a later
//   current read that installs the 'file' region (a fresh 200 render of this
//   asset) rebuilds the preview from the server and makes it viewable again;
//   the refresh engine already keeps a superseded, failed or other-asset read
//   from ever reporting, so nothing older can undo a newer gone.
//
// Click handling is delegated from the document and bound once, so a preview
// rebuilt by a refresh needs no rebinding and never collects listeners.

import {
  ASSET_DETAILS_VIEWER_ATTRIBUTES,
  ASSET_VIEWER_REFRESH_CHANGE,
  ASSET_VIEWER_REFRESH_REGIONS,
  observeAssetViewerRefresh,
} from './asset-viewer-refresh.js';
import { isEnhancementBound, liveRegionDocument, markEnhancementBound } from './dom.js';
import { unifiedViewerFor } from './unified-viewer.js';
import { createSingleImageSource, viewerItemFromSlideshowEntry } from './viewer-sequence.js';

const HOST_SELECTOR = '[data-asset-viewer-host]';
const TRIGGER_SELECTOR = '[data-asset-details-viewer-trigger]';
const PREVIEW_ROOT_SELECTOR = '[data-preview-enhancement]';
const PREVIEW_HEADING_SELECTOR = '#asset-preview-heading';
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
    document[STATE_PROPERTY] = { session: 0, key: null, entryText: null, observing: false, gone: null };
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
// is moved, not reloaded). Focus on it moves to the Preview heading.
function invalidateTrigger(document, trigger) {
  const parent = trigger.parentNode;
  if (!parent || typeof document.createElement !== 'function') return;
  const active = document.activeElement;
  const hadFocus = Boolean(active && (active === trigger || trigger.contains?.(active)));
  const inert = document.createElement('span');
  inert.setAttribute('class', 'asset-preview-link');
  inert.setAttribute(GONE_ATTRIBUTE, '');
  if (trigger.hasAttribute?.('hidden')) inert.setAttribute('hidden', '');
  parent.insertBefore(inert, trigger);
  Array.from(trigger.childNodes || []).forEach((node) => inert.appendChild(node));
  trigger.remove();
  if (hadFocus) previewHeading(document)?.focus?.({ preventScroll: true });
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
  const trigger = triggerIn(hostElement(document));
  if (trigger) {
    addClass(trigger.closest?.(PREVIEW_ROOT_SELECTOR), GONE_FRAME_CLASS);
    invalidateTrigger(document, trigger);
  }
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
    previewUrl: trigger.getAttribute?.('data-viewer-preview-url') || '',
    ...(originalUrl ? { originalUrl } : {}),
    revision: revision || null,
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
  state.session = session;
  state.key = key;
  state.entryText = JSON.stringify(entry);
  return session;
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
    const trigger = event.target?.closest?.(TRIGGER_SELECTOR);
    if (!trigger) return;
    const host = hostElement(document);
    if (!host || !host.contains?.(trigger) || triggerIn(host) !== trigger) return;
    if (openAssetDetailsImage(document, trigger)) event.preventDefault?.();
  });
  return 1;
}
