// ─── Release Manage Assets: unified viewer host integration ─────────────────
//
// Connects the Release Manage Assets page (/releases/:id/assets) to the shared
// unified viewer (unified-viewer.js). This module translates page activation
// into a viewer source and hands authoritative refresh data to the controller;
// it owns no viewer state
// machine, no selection state and no draft state of its own.
//
// - The trigger is the image thumbnail link of an eligible image only
//   (`[data-release-assets-viewer-trigger]`, emitted by the shared asset
//   presentation partial when this page asks for it). An unmodified primary
//   click opens ONLY that image (createSingleImageSource): never a gallery,
//   never Previous/Next, never autoplay. Modified and middle clicks keep the
//   link's Asset Details navigation. The card, its selection checkbox, the
//   Role control, the Details link and the list information card are never
//   triggers; a video, comic, missing or unsupported asset has no trigger.
// - The descriptor comes only from the server-rendered attributes on that
//   link (project and asset identity, filename, preview URL, original URL
//   when inline-eligible, opaque revision, Asset Details URL). No URL is
//   derived on the client.
// - Opening and closing are presentation-only. Nothing here reads or writes
//   checkboxes, the hidden membership inputs, the Role forms or the Save
//   form, and nothing is requested besides the viewer's own media GETs.
// - The live region (filtering, Grid/List, pagination, Back/Forward) replaces
//   the thumbnails. After the engine installs a CURRENT response (superseded
//   ones never install) refreshReleaseAssetsViewer() reconciles an open
//   session this page opened:
//   * the asset is rendered with a trigger → the controller's update()
//     receives its current descriptor (B1 keeps, reloads or updates it);
//   * the asset is rendered without a trigger (a saved selection now missing,
//     or no longer an eligible image) → update() with no item closes it;
//   * the asset is not rendered → pagination, ordering or filters may omit
//     it even under the same query, so the session is left as it is.
//   Sessions that have since closed, been replaced or were opened by another
//   host are never touched.
//
// Click handling is delegated from the document and bound once, so thumbnails
// re-rendered by live filtering need no rebinding and never collect listeners.

import { isEnhancementBound, liveRegionDocument, markEnhancementBound } from './dom.js';
import { unifiedViewerFor } from './unified-viewer.js';
import { createSingleImageSource, viewerItemFromSlideshowEntry } from './viewer-sequence.js';

export const RELEASE_ASSETS_VIEWER_TRIGGER_ATTRIBUTE = 'data-release-assets-viewer-trigger';
const TRIGGER_SELECTOR = `[${RELEASE_ASSETS_VIEWER_TRIGGER_ATTRIBUTE}]`;
const REGION_SELECTOR = '[data-release-assets-live-region]';
const WORKSPACE_PATH = /^\/releases\/([1-9]\d*)\/assets$/;
const PREVIEW_ROOT_SELECTOR = '[data-preview-enhancement]';
const VIEW_SWITCHER_SELECTOR = 'nav.view-switcher a';
const BOUND_KEY = 'releaseAssetsViewerBound';
const STATE_PROPERTY = '__creatorCrateReleaseAssetsViewer';
const NUMERIC_ID = /^[1-9]\d*$/;

function regionElement(document) {
  return document?.querySelector?.(REGION_SELECTOR) || null;
}

function locationUrl(document) {
  try {
    const href = (document?.defaultView || globalThis).location?.href;
    return href ? new URL(href) : null;
  } catch {
    return null;
  }
}

// The release whose workspace the installed region shows. The live engine
// records every installed response's URL in history (and only installs
// responses for this same path), so the location names it.
function releaseIdOf(document) {
  const match = locationUrl(document)?.pathname.match(WORKSPACE_PATH);
  return match ? match[1] : null;
}

function sourceKey(releaseId) {
  return `release-assets:${releaseId}`;
}

function hostState(document) {
  if (!document[STATE_PROPERTY]) {
    document[STATE_PROPERTY] = { session: 0, key: null, identity: null, entryText: null };
  }
  return document[STATE_PROPERTY];
}

function forget(state) {
  state.session = 0;
  state.key = null;
  state.identity = null;
  state.entryText = null;
}

function isUnmodifiedPrimaryClick(event) {
  if (event.defaultPrevented) return false;
  if (event.button !== undefined && event.button !== 0) return false;
  return !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
}

function triggerIdentity(trigger) {
  const projectId = trigger?.getAttribute?.('data-viewer-project') || '';
  const assetId = trigger?.getAttribute?.('data-viewer-asset') || '';
  if (!NUMERIC_ID.test(projectId) || !NUMERIC_ID.test(assetId)) return null;
  return { projectId, assetId };
}

// The authoritative slideshow-format entry for a trigger (the shape B1's
// createSingleImageSource and viewerItemFromSlideshowEntry accept).
function readEntry(trigger) {
  const identity = triggerIdentity(trigger);
  if (!identity) return null;
  const originalUrl = trigger.getAttribute?.('data-viewer-original-url') || '';
  const detailsUrl = trigger.getAttribute?.('data-viewer-details-url') || '';
  const revision = trigger.getAttribute?.('data-viewer-revision') || '';
  return {
    id: identity.assetId,
    projectId: identity.projectId,
    filename: trigger.getAttribute?.('data-viewer-filename') || '',
    previewUrl: trigger.getAttribute?.('data-viewer-preview-url') || '',
    ...(detailsUrl ? { viewerUrl: detailsUrl } : {}),
    ...(originalUrl ? { originalUrl } : {}),
    revision: revision || null,
  };
}

// The rendered trigger of one asset, only inside the current region and its
// image preview frame.
function triggerFor(region, identity) {
  if (!region || !identity) return null;
  const trigger = region.querySelector?.(
    `${TRIGGER_SELECTOR}[data-viewer-project="${identity.projectId}"][data-viewer-asset="${identity.assetId}"]`,
  ) || null;
  return trigger && trigger.closest?.(PREVIEW_ROOT_SELECTOR) ? trigger : null;
}

// Whether the region renders the asset at all (with or without a trigger).
function rendersAsset(region, identity) {
  return Boolean(region?.querySelector?.(`article[data-asset-id="${identity.assetId}"]`));
}

function isUsableTrigger(trigger) {
  if (!trigger || trigger.hidden || trigger.hasAttribute?.('hidden')) return false;
  return trigger.closest?.(PREVIEW_ROOT_SELECTOR)?.getAttribute?.('data-preview-state') !== 'failed';
}

// Focus return when the opener was replaced by a live refresh: the same
// asset's re-rendered thumbnail, else the current Grid/List switch of the
// release workspace (the controller falls back to #main-content after that).
function fallbackFocus(document, identity) {
  const region = regionElement(document);
  const trigger = triggerFor(region, identity);
  if (isUsableTrigger(trigger)) return trigger;
  return region?.querySelector?.(`${VIEW_SWITCHER_SELECTOR}[aria-current="page"]`)
    || region?.querySelector?.(VIEW_SWITCHER_SELECTOR)
    || null;
}

/**
 * Open one eligible image thumbnail of the current release workspace in
 * single-image mode.
 *
 * @param {Document} document
 * @param {Element} trigger  the clicked `[data-release-assets-viewer-trigger]`
 * @returns {number} the viewer session, or 0 when nothing opened
 */
export function openReleaseAssetsImage(document, trigger) {
  const viewer = unifiedViewerFor(document);
  const region = regionElement(document);
  const releaseId = releaseIdOf(document);
  if (!viewer || !region || !releaseId || !trigger || !region.contains?.(trigger)) return 0;
  if (!trigger.hasAttribute?.(RELEASE_ASSETS_VIEWER_TRIGGER_ATTRIBUTE) || !trigger.closest?.(PREVIEW_ROOT_SELECTOR)) return 0;
  const entry = readEntry(trigger);
  if (!entry) return 0;
  const identity = { projectId: entry.projectId, assetId: entry.id };
  const key = sourceKey(releaseId);
  const source = createSingleImageSource({
    key,
    entries: [entry],
    projectId: identity.projectId,
    assetId: identity.assetId,
  });
  if (source.items.length === 0) return 0;
  const session = viewer.open(source, {
    opener: trigger,
    fallbackFocus: () => fallbackFocus(document, identity),
  });
  if (!session) return 0;
  const state = hostState(document);
  state.session = session;
  state.key = key;
  state.identity = identity;
  state.entryText = JSON.stringify(entry);
  return session;
}

/**
 * Reconcile an open Release Manage Assets viewer session with the region a
 * current live refresh just installed. Sessions this page did not open, or
 * that have since closed or been replaced, are never touched; a response that
 * does not render the open asset leaves the session as it is.
 *
 * @param {Document|Element} scope
 * @returns {object|null} the reconciliation result, or null when nothing applied
 */
export function refreshReleaseAssetsViewer(scope = globalThis.document) {
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

  const region = regionElement(document);
  const releaseId = releaseIdOf(document);
  // Without a region or its release identity nothing is authoritative.
  if (!region || !releaseId) return null;
  const key = sourceKey(releaseId);
  let items;
  if (key !== state.key) {
    // Another release's workspace: the key mismatch closes the session.
    items = [];
  } else {
    const trigger = triggerFor(region, state.identity);
    if (trigger) {
      const entry = readEntry(trigger);
      const entryText = entry ? JSON.stringify(entry) : null;
      if (entryText && entryText === state.entryText) return null;
      state.entryText = entryText;
      items = entry ? [viewerItemFromSlideshowEntry(entry)] : [];
    } else if (rendersAsset(region, state.identity)) {
      // Rendered, but no longer an eligible image (missing, unsupported).
      items = [];
    } else {
      // A limited result cannot prove removal, even for the same page/query.
      return null;
    }
  }
  const result = viewer.update({ key, items }, { session: state.session });
  if (!viewer.getState().open) forget(state);
  return result;
}

/**
 * Bind Release Manage Assets image thumbnail activation once per document.
 * A page without the Release Manage Assets region is left untouched.
 *
 * @param {Document|Element} [scope]
 * @returns {0|1}
 */
export function enhanceReleaseAssetsViewer(scope = globalThis.document) {
  const document = liveRegionDocument(scope);
  if (!document || typeof document.addEventListener !== 'function') return 0;
  if (!regionElement(document) || !releaseIdOf(document)) return 0;
  if (isEnhancementBound(document, BOUND_KEY)) return 1;
  markEnhancementBound(document, BOUND_KEY);

  document.addEventListener('click', (event) => {
    if (!isUnmodifiedPrimaryClick(event)) return;
    const trigger = event.target?.closest?.(TRIGGER_SELECTOR);
    if (!trigger) return;
    if (openReleaseAssetsImage(document, trigger)) event.preventDefault?.();
  });
  return 1;
}
