// ─── Release Detail: unified viewer host integration (Milestone B, B7b) ──────
//
// Connects Release Detail (/releases/:id) to the shared unified viewer
// (unified-viewer.js). This module translates page activation and hands
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
// - Comics: an eligible selected CBZ/CBR/CB7 card carries a Read comic
//   link (`[data-release-detail-comic-trigger]`, emitted by the shared
//   partial's native image presentation for this page). An unmodified primary click (or
//   keyboard activation) opens that one comic through the shared controller's
//   openComic(); its pages come only from its own manifest, never from the
//   release's saved selection. Modified and middle clicks keep the link's
//   Asset Details navigation. The link's project/asset ids must agree with
//   its server-built Asset Details href and its own card.
// - Comic triggers follow the same accepted renders as image triggers, with
//   the same complete saved-selection authority: a counterpart in the render
//   brings the current hint/title; none (removed from the saved selection,
//   deleted, missing, no longer readable) withdraws the Read comic link for
//   good (it stays the plain Asset Details link, labelled as such). An open
//   comic session this page opened is reconciled through reconcileComic(): a
//   rendered Read comic link forwards the server's indexed-source hint (an
//   unchanged hint reloads nothing, a new one requests one manifest); no link
//   (rendered without one, or not rendered at all) retires the reader.
//   Retirement of the page withdraws every Read comic link and retires an
//   open comic the same way it closes an image. Nothing here relies on the
//   selected assets being replaced: they are static, so withdrawal is
//   explicit and every activation re-checks the page's retirement.
//
// Click handling is delegated from the document and bound once; the refresh
// observer is registered once per document.

import { isEnhancementBound, liveRegionDocument, markEnhancementBound } from './dom.js';
import { observeReleaseDetailRefresh, RELEASE_DETAIL_REFRESH_CHANGE } from './release-detail-refresh.js';
import { unifiedViewerFor } from './unified-viewer.js';
import { markPreviewFailed, markPreviewLoaded } from './preview.js';
import { imageSourcesFromViewerTrigger, createSingleImageSource, viewerItemFromSlideshowEntry } from './viewer-sequence.js';

export const RELEASE_DETAIL_VIEWER_TRIGGER_ATTRIBUTE = 'data-release-detail-viewer-trigger';
export const RELEASE_DETAIL_COMIC_TRIGGER_ATTRIBUTE = 'data-release-detail-comic-trigger';
// Marks a Read comic link an accepted render or the page's retirement
// withdrew (it remains the plain Asset Details link).
export const RELEASE_DETAIL_COMIC_WITHDRAWN_ATTRIBUTE = 'data-release-detail-comic-withdrawn';
const TRIGGER_SELECTOR = `[${RELEASE_DETAIL_VIEWER_TRIGGER_ATTRIBUTE}]`;
const COMIC_TRIGGER_SELECTOR = `[${RELEASE_DETAIL_COMIC_TRIGGER_ATTRIBUTE}]`;
const PAGE_SELECTOR = '[data-release-detail]';
const SELECTED_SELECTOR = '[data-selected-assets]';
const PREVIEW_ROOT_SELECTOR = '[data-preview-enhancement]';
const VIEW_SWITCHER_SELECTOR = 'nav.view-switcher a';
// The server-rendered descriptor a trigger carries (besides its identity).
const DESCRIPTOR_ATTRIBUTES = Object.freeze([
  'data-viewer-filename',
  'data-viewer-project-name',
  'data-viewer-preview-url',
  'data-viewer-original-url',
  'data-viewer-revision',
  'data-viewer-image-sources',
  'data-viewer-details-url',
]);
// The server-rendered descriptor a Read comic link carries (besides its
// identity): the indexed-source hint and its presentation.
const COMIC_DESCRIPTOR_ATTRIBUTES = Object.freeze([
  'data-comic-source-revision',
  'data-comic-title',
  'data-comic-filename',
  'data-comic-project-name',
  'data-comic-details-url',
  'data-comic-label',
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
      session: 0, key: null, identity: null, entryText: null, comic: null, observing: false, retired: false,
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
    projectName: trigger.getAttribute?.('data-viewer-project-name') || null,
    previewUrl: trigger.getAttribute?.('data-viewer-preview-url') || '',
    ...(detailsUrl ? { viewerUrl: detailsUrl } : {}),
    ...(originalUrl ? { originalUrl } : {}),
    revision: revision || null,
    imageSources: imageSourcesFromViewerTrigger(trigger),
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

function viewSwitchFocus(selected) {
  return selected?.querySelector?.(`${VIEW_SWITCHER_SELECTOR}[aria-current="page"]`)
    || selected?.querySelector?.(VIEW_SWITCHER_SELECTOR)
    || null;
}

// Focus return when the opener is gone: the same asset's current trigger,
// else the selected assets' current Grid/List switch (the controller falls
// back to #main-content after that).
function fallbackFocus(document, identity) {
  const selected = selectedElement(document);
  const trigger = triggerFor(selected, identity);
  if (isUsableTrigger(trigger)) return trigger;
  return viewSwitchFocus(selected);
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

// The Read comic link of one project-qualified comic inside a selected-assets
// section (the live page or a refreshed render).
function comicTriggerFor(selected, projectId, assetId) {
  if (!selected || !NUMERIC_ID.test(String(projectId)) || !NUMERIC_ID.test(String(assetId))) return null;
  const selector = `${COMIC_TRIGGER_SELECTOR}[data-comic-project="${projectId}"][data-comic-asset="${assetId}"]`;
  const triggers = Array.from(selected.querySelectorAll?.(selector) || []);
  return triggers.find((trigger) => trigger.hasAttribute?.('data-preview-fallback') && !trigger.hasAttribute?.('hidden'))
    || triggers.find((trigger) => !trigger.hasAttribute?.('hidden')) || triggers[0] || null;
}

// The identity of a Read comic link, only when its ids are well formed and
// agree with the server-built Asset Details href and with its own card.
function comicTriggerIdentity(trigger) {
  const projectId = trigger?.getAttribute?.('data-comic-project') || '';
  const assetId = trigger?.getAttribute?.('data-comic-asset') || '';
  if (!NUMERIC_ID.test(projectId) || !NUMERIC_ID.test(assetId)) return null;
  if (trigger.getAttribute?.('href') !== `/projects/${projectId}/assets/${assetId}`) return null;
  const card = trigger.closest?.('article[data-asset-id]');
  if (!card || card.getAttribute?.('data-asset-id') !== assetId) return null;
  return { projectId, assetId };
}

// Focus return for a comic whose opener is gone or withdrawn: the same
// comic's current Read comic link, else the Grid/List switch.
function comicFallbackFocus(document, identity) {
  const selected = selectedElement(document);
  const trigger = comicTriggerFor(selected, identity.projectId, identity.assetId);
  if (trigger && !trigger.closest?.('[inert]')) return trigger;
  return viewSwitchFocus(selected);
}

// A trigger the current render no longer offers stays the Asset Details link
// it always was, without any viewer descriptor.
function withdrawTrigger(trigger) {
  trigger.removeAttribute?.(RELEASE_DETAIL_VIEWER_TRIGGER_ATTRIBUTE);
  ['data-viewer-project', 'data-viewer-asset', ...DESCRIPTOR_ATTRIBUTES]
    .forEach((name) => trigger.removeAttribute?.(name));
}

// A Read comic link the current render no longer offers (or of a retired
// page) stays the Asset Details link it always was: no identity, no hint,
// and no "Read comic" wording.
function withdrawComicTrigger(trigger) {
  trigger.removeAttribute?.(RELEASE_DETAIL_COMIC_TRIGGER_ATTRIBUTE);
  ['data-comic-project', 'data-comic-asset', ...COMIC_DESCRIPTOR_ATTRIBUTES]
    .forEach((name) => trigger.removeAttribute?.(name));
  trigger.setAttribute?.(RELEASE_DETAIL_COMIC_WITHDRAWN_ATTRIBUTE, '');
  const label = trigger.getAttribute?.('aria-label');
  if (label) trigger.setAttribute?.('aria-label', label.replace(/^Read comic /, 'View details for '));
}

function syncAttribute(target, source, name) {
  const value = source.getAttribute?.(name);
  if (value === null || value === undefined) target.removeAttribute?.(name);
  else if (target.getAttribute?.(name) !== value) target.setAttribute?.(name, value);
}

// Retained cards use the same native image and Preview state transitions for
// ordinary images and covers. An unchanged source keeps its loaded/failed state.
function syncPreview(trigger, current) {
  const root = trigger.closest?.(PREVIEW_ROOT_SELECTOR);
  const nextRoot = current?.closest?.(PREVIEW_ROOT_SELECTOR);
  const image = root?.querySelector?.('[data-preview-image]');
  if (!image) return;
  const nextImage = nextRoot?.querySelector?.('[data-preview-image]');
  const source = nextImage?.getAttribute?.('src');
  if (!source) {
    image.removeAttribute?.('src');
    markPreviewFailed(root);
    return;
  }
  syncAttribute(image, nextImage, 'alt');
  if (image.getAttribute?.('src') === source) return;
  const link = image.closest?.('a');
  const fallback = root.querySelector?.('[data-preview-fallback]');
  const fallbackHadFocus = fallback === root.ownerDocument?.activeElement;
  root.setAttribute?.('data-preview-state', 'loading');
  if (root.dataset) root.dataset.previewState = 'loading';
  image.removeAttribute?.('hidden');
  link?.removeAttribute?.('hidden');
  fallback?.setAttribute?.('hidden', '');
  if (fallbackHadFocus) link?.focus?.({ preventScroll: true });
  image.addEventListener?.('load', () => {
    if (root.isConnected !== false && image.getAttribute('src') === source) markPreviewLoaded(root);
  }, { once: true });
  image.addEventListener?.('error', () => {
    if (root.isConnected !== false && image.getAttribute('src') === source) markPreviewFailed(root);
  }, { once: true });
  image.setAttribute('src', source);
}

function syncComicDescriptor(trigger, current) {
  ['href', 'aria-label', ...COMIC_DESCRIPTOR_ATTRIBUTES].forEach((name) => syncAttribute(trigger, current, name));
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
  const previews = new Set();
  Array.from(selected.querySelectorAll?.(TRIGGER_SELECTOR) || []).forEach((trigger) => {
    const current = triggerFor(nextSelected, triggerIdentity(trigger));
    if (current) {
      syncPreview(trigger, current);
      syncDescriptor(trigger, current);
    } else withdrawTrigger(trigger);
  });
  Array.from(selected.querySelectorAll?.(COMIC_TRIGGER_SELECTOR) || []).forEach((trigger) => {
    const identity = comicTriggerIdentity(trigger);
    const current = identity ? comicTriggerFor(nextSelected, identity.projectId, identity.assetId) : null;
    const root = trigger.closest?.(PREVIEW_ROOT_SELECTOR);
    if (!previews.has(root)) {
      syncPreview(trigger, current);
      previews.add(root);
    }
    if (current) syncComicDescriptor(trigger, current);
    else withdrawComicTrigger(trigger);
  });
}

function withdrawAllTriggers(document) {
  const selected = selectedElement(document);
  Array.from(selected?.querySelectorAll?.(TRIGGER_SELECTOR) || []).forEach(withdrawTrigger);
  const previews = new Set();
  Array.from(selected?.querySelectorAll?.(COMIC_TRIGGER_SELECTOR) || []).forEach((trigger) => {
    const root = trigger.closest?.(PREVIEW_ROOT_SELECTOR);
    if (!previews.has(root)) {
      syncPreview(trigger, null);
      previews.add(root);
    }
    withdrawComicTrigger(trigger);
  });
}

// The open comic session this page opened, or null (forgetting a stale record).
function ownComicSession(document) {
  const state = document?.[STATE_PROPERTY];
  if (!state?.comic) return null;
  const viewer = unifiedViewerFor(document);
  const viewerState = viewer?.getState?.();
  if (!viewerState?.open || viewerState.session !== state.comic.session || !viewerState.comic
    || typeof viewer.reconcileComic !== 'function') {
    state.comic = null;
    return null;
  }
  return { state, viewer, comic: state.comic };
}

// Reconcile an open comic session with an accepted render's complete saved
// selection: its Read comic link forwards the hint; none retires the reader.
function reconcileComicSession(document, nextSelected) {
  const own = ownComicSession(document);
  if (!own) return null;
  const { state, viewer, comic } = own;
  const identity = { projectId: Number(comic.projectId), assetId: Number(comic.assetId) };
  const current = comicTriggerFor(nextSelected, comic.projectId, comic.assetId);
  let hint;
  let hostReason;
  if (current) {
    const sourceRevision = current.getAttribute?.('data-comic-source-revision');
    hint = sourceRevision ? { ...identity, ...comicMetadata(current), sourceRevision } : { ...identity, ...comicMetadata(current) };
    hostReason = 'updated';
  } else {
    // Release Detail lists the whole saved selection, so absence is
    // authoritative: removed from it (or deleted), or rendered unreadable.
    hint = { ...identity, eligible: false };
    hostReason = rendersAsset(nextSelected, comic) ? 'ineligible' : 'removed';
  }
  const result = viewer.reconcileComic(hint, { session: comic.session });
  if (!viewer.getState().open) state.comic = null;
  return result ? { ...result, hostReason } : result;
}

// Detach a saved opener so the controller uses the connected page fallback,
// keeping the thumbnail's children and ordinary Details link.
function detachOpener(trigger) {
  const link = trigger.cloneNode(false);
  Array.from(trigger.childNodes).forEach((child) => link.appendChild(child));
  trigger.replaceWith(link);
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
  if (hostState(document).comic) return reconcileComicSession(document, nextSelected);

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
  const comicOwn = ownComicSession(document);
  const comicOpener = comicOwn
    ? comicTriggerFor(selectedElement(document), comicOwn.comic.projectId, comicOwn.comic.assetId)
    : null;
  state.retired = true;
  withdrawAllTriggers(document);
  if (trigger) detachOpener(trigger);
  if (comicOpener) detachOpener(comicOpener);
  if (comicOwn) {
    const result = comicOwn.viewer.reconcileComic(null, { session: comicOwn.comic.session });
    state.comic = null;
    return result;
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
  state.comic = null;
  return session;
}

/**
 * Open the comic of one selected Read comic link in the shared viewer.
 * Reading never changes the release. Returns 0 (and opens nothing) on a
 * retired page, for a withdrawn, inert or foreign link, or for a malformed or
 * inconsistent identity.
 *
 * @param {Document} document
 * @param {Element} trigger  the clicked `[data-release-detail-comic-trigger]`
 * @returns {number} the viewer session, or 0 when nothing opened
 */
export function openReleaseDetailComic(document, trigger) {
  const viewer = unifiedViewerFor(document);
  const selected = selectedElement(document);
  const releaseId = releaseIdOf(document);
  if (!viewer || typeof viewer.openComic !== 'function') return 0;
  if (!selected || !releaseId || !trigger || !selected.contains?.(trigger)) return 0;
  if (hostState(document).retired || trigger.closest?.('[inert]')) return 0;
  if (!trigger.hasAttribute?.(RELEASE_DETAIL_COMIC_TRIGGER_ATTRIBUTE)) return 0;
  const identity = comicTriggerIdentity(trigger);
  if (!identity) return 0;
  const sourceRevision = trigger.getAttribute?.('data-comic-source-revision') || undefined;
  const session = viewer.openComic({
    projectId: Number(identity.projectId),
    assetId: Number(identity.assetId),
    ...comicMetadata(trigger),
    title: trigger.getAttribute?.('data-comic-title') || '',
    label: trigger.getAttribute?.('data-comic-label') || '',
    sourceRevision,
  }, {
    opener: trigger,
    fallbackFocus: () => comicFallbackFocus(document, identity),
  });
  if (!session) return 0;
  ensureObserving(document);
  const state = hostState(document);
  forget(state);
  state.comic = { session, ...identity };
  return session;
}

/**
 * Bind Release Detail image thumbnail and Read comic activation and its
 * refresh observer once per document. A page that is not Release Detail is left untouched.
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
    const comicTrigger = event.target?.closest?.(COMIC_TRIGGER_SELECTOR);
    if (comicTrigger) {
      if (openReleaseDetailComic(document, comicTrigger)) event.preventDefault?.();
      return;
    }
    const trigger = event.target?.closest?.(TRIGGER_SELECTOR);
    if (!trigger) return;
    if (openReleaseDetailImage(document, trigger)) event.preventDefault?.();
  });
  return 1;
}
