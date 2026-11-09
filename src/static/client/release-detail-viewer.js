// ─── Release Detail: unified viewer host integration (Milestone B, B7b) ──────
//
// Connects Release Detail (/releases/:id) to the shared unified viewer
// (unified-viewer.js). Like the earlier hosts (B5a, B5b, B6, B7a) this module
// only translates page activation into a B1 viewer source and hands
// authoritative refresh data to the controller; it owns no viewer state
// machine and no release state of its own.
//
// - The trigger is the image thumbnail link of an eligible selected image
//   only (`[data-release-detail-viewer-trigger]`, emitted by the shared asset
//   presentation partial when Release Detail asks for it). An unmodified
//   primary click opens ONLY that image (createSingleImageSource): never a
//   gallery, never Previous/Next, never autoplay. Modified and middle clicks
//   keep the link's Asset Details navigation. The card, its Details link, the
//   filename link, the list information card and every release action are
//   never triggers; a video, comic, missing or unsupported asset has none.
// - The descriptor comes only from the server-rendered attributes on that
//   link (project and asset identity, filename, preview URL, original URL
//   when inline-eligible, opaque revision, Asset Details URL). No URL is
//   derived on the client.
// - Opening and closing are presentation-only: nothing is submitted, nothing
//   about the release (membership, roles, order, metadata, publication) is
//   read or written, and nothing is requested besides the viewer's own media.
// - The selected assets are never replaced in place (release-detail-refresh.js
//   only replaces its release regions). Its refresh does, however, fetch a
//   current render of the whole page, and that render is the authority on
//   the release's saved selection. For each ACCEPTED refresh (a current
//   generation of this release; superseded, failed and other-release
//   responses are never reported) this host:
//   * brings every rendered trigger in step with its counterpart in that
//     render: a new descriptor (revision, preview or original URL, filename)
//     replaces the old one; a trigger whose asset the render no longer offers
//     as a viewable image (removed from the saved selection, deleted, missing
//     at the last scan, no longer an image) stops being a trigger and stays
//     the plain Asset Details link it always was, so no stale descriptor can
//     open again;
//   * reconciles an open session this page opened through the controller's
//     update(): the asset still offered → its current descriptor (B1 keeps
//     unchanged media, reloads changed media, updates the title); rendered
//     without a trigger (missing, ineligible) or not rendered at all (no
//     longer in the saved selection, or deleted) → closed.
//   A retired page (its release was deleted) closes this page's session and
//   withdraws every trigger. Sessions that have since closed, been replaced
//   or were opened by another host are never touched.
//
// Click handling is delegated from the document and bound once; the refresh
// observer is registered once per document.

import { isEnhancementBound, liveRegionDocument, markEnhancementBound } from './dom.js';
import { observeReleaseDetailRefresh, RELEASE_DETAIL_REFRESH_CHANGE } from './release-detail-refresh.js';
import { unifiedViewerFor } from './unified-viewer.js';
import { createSingleImageSource, viewerItemFromSlideshowEntry } from './viewer-sequence.js';

export const RELEASE_DETAIL_VIEWER_TRIGGER_ATTRIBUTE = 'data-release-detail-viewer-trigger';
const TRIGGER_SELECTOR = `[${RELEASE_DETAIL_VIEWER_TRIGGER_ATTRIBUTE}]`;
const PAGE_SELECTOR = '[data-release-detail]';
const SELECTED_SELECTOR = '[data-selected-assets]';
const PREVIEW_ROOT_SELECTOR = '[data-preview-enhancement]';
const VIEW_SWITCHER_SELECTOR = 'nav.view-switcher a';
// The server-rendered descriptor a trigger carries (besides its identity).
const DESCRIPTOR_ATTRIBUTES = Object.freeze([
  'data-viewer-filename',
  'data-viewer-preview-url',
  'data-viewer-original-url',
  'data-viewer-revision',
  'data-viewer-details-url',
]);
const BOUND_KEY = 'releaseDetailViewerBound';
const STATE_PROPERTY = '__creatorCrateReleaseDetailViewer';
const NUMERIC_ID = /^[1-9]\d*$/;

function releaseIdOf(root) {
  const id = root?.querySelector?.(PAGE_SELECTOR)?.getAttribute?.('data-release-detail') || '';
  return NUMERIC_ID.test(id) ? id : null;
}

function selectedElement(root) {
  return root?.querySelector?.(SELECTED_SELECTOR) || null;
}

function sourceKey(releaseId) {
  return `release-detail:${releaseId}`;
}

function hostState(document) {
  if (!document[STATE_PROPERTY]) {
    document[STATE_PROPERTY] = {
      session: 0, key: null, identity: null, entryText: null, observing: false, retired: false,
    };
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

// The trigger of one asset inside a selected-assets section and its image
// preview frame (the live page or a refreshed render).
function triggerFor(selected, identity) {
  if (!selected || !identity) return null;
  const trigger = selected.querySelector?.(
    `${TRIGGER_SELECTOR}[data-viewer-project="${identity.projectId}"][data-viewer-asset="${identity.assetId}"]`,
  ) || null;
  return trigger && trigger.closest?.(PREVIEW_ROOT_SELECTOR) ? trigger : null;
}

// Whether a selected-assets section renders the asset at all.
function rendersAsset(selected, identity) {
  return Boolean(selected?.querySelector?.(`article[data-asset-id="${identity.assetId}"]`));
}

function isUsableTrigger(trigger) {
  if (!trigger || trigger.hidden || trigger.hasAttribute?.('hidden')) return false;
  if (trigger.closest?.('[inert]')) return false;
  return trigger.closest?.(PREVIEW_ROOT_SELECTOR)?.getAttribute?.('data-preview-state') !== 'failed';
}

// Focus return when the opener is gone: the same asset's current trigger,
// else the selected assets' current Grid/List switch (the controller falls
// back to #main-content after that).
function fallbackFocus(document, identity) {
  const selected = selectedElement(document);
  const trigger = triggerFor(selected, identity);
  if (isUsableTrigger(trigger)) return trigger;
  return selected?.querySelector?.(`${VIEW_SWITCHER_SELECTOR}[aria-current="page"]`)
    || selected?.querySelector?.(VIEW_SWITCHER_SELECTOR)
    || null;
}

// A trigger the current render no longer offers stays the Asset Details link
// it always was, without any viewer descriptor.
function withdrawTrigger(trigger) {
  trigger.removeAttribute?.(RELEASE_DETAIL_VIEWER_TRIGGER_ATTRIBUTE);
  ['data-viewer-project', 'data-viewer-asset', ...DESCRIPTOR_ATTRIBUTES]
    .forEach((name) => trigger.removeAttribute?.(name));
}

function syncDescriptor(trigger, current) {
  DESCRIPTOR_ATTRIBUTES.forEach((name) => {
    const value = current.getAttribute?.(name);
    if (value === null || value === undefined) trigger.removeAttribute?.(name);
    else if (trigger.getAttribute?.(name) !== value) trigger.setAttribute?.(name, value);
  });
}

// Bring the page's triggers in step with an accepted render's selected assets.
function syncTriggers(document, nextSelected) {
  const selected = selectedElement(document);
  if (!selected) return;
  Array.from(selected.querySelectorAll?.(TRIGGER_SELECTOR) || []).forEach((trigger) => {
    const current = triggerFor(nextSelected, triggerIdentity(trigger));
    if (current) syncDescriptor(trigger, current);
    else withdrawTrigger(trigger);
  });
}

function withdrawAllTriggers(document) {
  Array.from(selectedElement(document)?.querySelectorAll?.(TRIGGER_SELECTOR) || []).forEach(withdrawTrigger);
}

// The open session this page opened, or null (forgetting a stale record).
function ownSession(document) {
  const state = document?.[STATE_PROPERTY];
  if (!state?.session) return null;
  const viewer = unifiedViewerFor(document);
  const viewerState = viewer?.getState?.();
  if (!viewerState?.open || viewerState.session !== state.session) {
    forget(state);
    return null;
  }
  return { state, viewer };
}

function closeOwnSession(document) {
  const own = ownSession(document);
  if (!own) return null;
  const { state, viewer } = own;
  const result = viewer.update({ key: state.key, items: [] }, { session: state.session });
  if (!viewer.getState().open) forget(state);
  return result;
}

/**
 * Reconcile Release Detail with a current, accepted render of the same
 * release (as release-detail-refresh.js reports it). Updates the page's
 * triggers and an open session this page opened. A render of another
 * release, or one without the selected assets, is no evidence and changes
 * nothing.
 *
 * @param {Document} document
 * @param {Document|Element} parsed  the accepted render
 * @returns {object|null} the session reconciliation result, or null
 */
export function reconcileReleaseDetailViewer(document, parsed) {
  if (!document || hostState(document).retired) return null;
  const releaseId = releaseIdOf(document);
  const nextSelected = selectedElement(parsed);
  if (!releaseId || releaseIdOf(parsed) !== releaseId || !nextSelected) return null;
  syncTriggers(document, nextSelected);

  const own = ownSession(document);
  if (!own) return null;
  const { state, viewer } = own;
  const key = sourceKey(releaseId);
  // A different key (another release) closes. Without a current trigger the
  // render no longer offers this image: rendered without one (missing at the
  // last scan, no longer an image) or not rendered at all (removed from the
  // saved selection, or deleted). Release Detail lists the whole saved
  // selection (no filters, no pages), so absence is authoritative. Both close.
  let items = [];
  let hostReason = 'removed';
  const current = key === state.key ? triggerFor(nextSelected, state.identity) : null;
  if (current) {
    const entry = readEntry(current);
    const entryText = entry ? JSON.stringify(entry) : null;
    // Unchanged media and title: nothing to reload.
    if (entryText && entryText === state.entryText) return null;
    state.entryText = entryText;
    items = entry ? [viewerItemFromSlideshowEntry(entry)] : [];
    hostReason = 'updated';
  } else if (key === state.key && rendersAsset(nextSelected, state.identity)) {
    hostReason = 'ineligible';
  }
  const result = viewer.update({ key, items }, { session: state.session });
  if (!viewer.getState().open) forget(state);
  return result ? { ...result, hostReason } : result;
}

/**
 * The page's release is gone: close this
 * page's session and withdraw every trigger, for good.
 *
 * @param {Document} document
 */
export function retireReleaseDetailViewer(document) {
  if (!document) return null;
  const state = hostState(document);
  if (state.retired) return null;
  const own = ownSession(document);
  const trigger = own ? triggerFor(selectedElement(document), state.identity) : null;
  state.retired = true;
  withdrawAllTriggers(document);
  if (trigger) {
    // Detach the saved opener so the controller uses the connected page
    // fallback. Keep the thumbnail's children and ordinary Details link.
    const link = trigger.cloneNode(false);
    Array.from(trigger.childNodes).forEach((child) => link.appendChild(child));
    trigger.replaceWith(link);
  }
  return closeOwnSession(document);
}

function onRefresh(document, change) {
  if (change?.releaseId !== undefined && String(change.releaseId) !== releaseIdOf(document)) return;
  if (change?.type === RELEASE_DETAIL_REFRESH_CHANGE.RETIRED) {
    retireReleaseDetailViewer(document);
  } else if (change?.type === RELEASE_DETAIL_REFRESH_CHANGE.ADOPTED && change.parsed) {
    reconcileReleaseDetailViewer(document, change.parsed);
  }
}

function ensureObserving(document) {
  const state = hostState(document);
  if (state.observing) return;
  state.observing = true;
  observeReleaseDetailRefresh(document, (change) => onRefresh(document, change));
}

/**
 * Open one eligible selected image of Release Detail in single-image mode.
 *
 * @param {Document} document
 * @param {Element} trigger  the clicked `[data-release-detail-viewer-trigger]`
 * @returns {number} the viewer session, or 0 when nothing opened
 */
export function openReleaseDetailImage(document, trigger) {
  const viewer = unifiedViewerFor(document);
  const selected = selectedElement(document);
  const releaseId = releaseIdOf(document);
  if (!viewer || !selected || !releaseId || !trigger || !selected.contains?.(trigger)) return 0;
  if (hostState(document).retired || trigger.closest?.('[inert]')) return 0;
  if (!trigger.hasAttribute?.(RELEASE_DETAIL_VIEWER_TRIGGER_ATTRIBUTE) || !trigger.closest?.(PREVIEW_ROOT_SELECTOR)) return 0;
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
  ensureObserving(document);
  const state = hostState(document);
  state.session = session;
  state.key = key;
  state.identity = identity;
  state.entryText = JSON.stringify(entry);
  return session;
}

/**
 * Bind Release Detail image thumbnail activation and its refresh observer
 * once per document. A page that is not Release Detail is left untouched.
 *
 * @param {Document|Element} [scope]
 * @returns {0|1}
 */
export function enhanceReleaseDetailViewer(scope = globalThis.document) {
  const document = liveRegionDocument(scope);
  if (!document || typeof document.addEventListener !== 'function') return 0;
  if (!selectedElement(document) || !releaseIdOf(document)) return 0;
  if (isEnhancementBound(document, BOUND_KEY)) return 1;
  markEnhancementBound(document, BOUND_KEY);
  ensureObserving(document);

  document.addEventListener('click', (event) => {
    if (!isUnmodifiedPrimaryClick(event)) return;
    const trigger = event.target?.closest?.(TRIGGER_SELECTOR);
    if (!trigger) return;
    if (openReleaseDetailImage(document, trigger)) event.preventDefault?.();
  });
  return 1;
}
