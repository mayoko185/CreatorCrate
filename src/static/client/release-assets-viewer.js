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
// - Comics (C2c): an eligible CBZ/CBR/CB7 card carries a Read comic link
//   (`[data-release-assets-comic-trigger]`, emitted by the shared partial's
//   comicReaderAttributes for this page) whether or not the asset is selected for
//   the release. An unmodified primary click (or keyboard activation) opens
//   that one comic through the shared controller's openComic(); its pages come
//   only from the comic's own manifest, never from the image source or from
//   release membership. Modified and middle clicks keep the link's Asset
//   Details navigation. The link's project/asset ids must agree with its
//   server-built Asset Details href and its own card, so a malformed or
//   foreign identity opens nothing.
// - An open comic session is reconciled with the same installed region, with
//   the same paginated-absence rule as images, through reconcileComic():
//   * its Read comic link is rendered -> the server's indexed-source hint
//     (an unchanged hint reloads nothing, a new one requests one manifest);
//   * its card is rendered without one (missing, no longer readable) ->
//     `eligible: false` retires the reader;
//   * its card is not rendered -> nothing is known, the reader stays open;
//   * another release's workspace -> retired, like an image session.
//
// Click handling is delegated from the document and bound once, so thumbnails
// re-rendered by live filtering need no rebinding and never collect listeners.

import { isEnhancementBound, liveRegionDocument, markEnhancementBound } from './dom.js';
import { unifiedViewerFor } from './unified-viewer.js';
import { imageSourcesFromViewerTrigger, createSingleImageSource, viewerItemFromSlideshowEntry } from './viewer-sequence.js';

export const RELEASE_ASSETS_VIEWER_TRIGGER_ATTRIBUTE = 'data-release-assets-viewer-trigger';
export const RELEASE_ASSETS_COMIC_TRIGGER_ATTRIBUTE = 'data-release-assets-comic-trigger';
const TRIGGER_SELECTOR = `[${RELEASE_ASSETS_VIEWER_TRIGGER_ATTRIBUTE}]`;
const COMIC_TRIGGER_SELECTOR = `[${RELEASE_ASSETS_COMIC_TRIGGER_ATTRIBUTE}]`;
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

// `session`/`key`/`identity`/`entryText` belong to an image session; `comic`
// to a comic session ({ session, key, projectId, assetId }). Only one of them
// can be the viewer's open session at a time.
function hostState(document) {
  if (!document[STATE_PROPERTY]) {
    document[STATE_PROPERTY] = { session: 0, key: null, identity: null, entryText: null, comic: null };
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

function viewSwitchFocus(region) {
  return region?.querySelector?.(`${VIEW_SWITCHER_SELECTOR}[aria-current="page"]`)
    || region?.querySelector?.(VIEW_SWITCHER_SELECTOR)
    || null;
}

// Focus return when the opener was replaced by a live refresh: the same
// asset's re-rendered thumbnail, else the current Grid/List switch of the
// release workspace (the controller falls back to #main-content after that).
function fallbackFocus(document, identity) {
  const region = regionElement(document);
  const trigger = triggerFor(region, identity);
  if (isUsableTrigger(trigger)) return trigger;
  return viewSwitchFocus(region);
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

// The rendered Read comic link of one project-qualified comic in a region.
function comicTriggerFor(region, projectId, assetId) {
  if (!region || !NUMERIC_ID.test(String(projectId)) || !NUMERIC_ID.test(String(assetId))) return null;
  const selector = `${COMIC_TRIGGER_SELECTOR}[data-comic-project="${projectId}"][data-comic-asset="${assetId}"]`;
  const triggers = Array.from(region.querySelectorAll?.(selector) || []);
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

// Focus return for a comic whose opener a live refresh replaced: the same
// comic's re-rendered Read comic link, else the Grid/List switch.
function comicFallbackFocus(document, identity) {
  const region = regionElement(document);
  return comicTriggerFor(region, identity.projectId, identity.assetId) || viewSwitchFocus(region);
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
  state.comic = null;
  return session;
}

/**
 * Open the comic of one Read comic link of the current release workspace in
 * the shared viewer. Reading never touches the release's membership, roles,
 * order or drafts. Returns 0 (and opens nothing) for a link outside the
 * workspace region or with a malformed or inconsistent identity.
 *
 * @param {Document} document
 * @param {Element} trigger  the clicked `[data-release-assets-comic-trigger]`
 * @returns {number} the viewer session, or 0 when nothing opened
 */
export function openReleaseAssetsComic(document, trigger) {
  const viewer = unifiedViewerFor(document);
  const region = regionElement(document);
  const releaseId = releaseIdOf(document);
  if (!viewer || typeof viewer.openComic !== 'function') return 0;
  if (!region || !releaseId || !trigger || !region.contains?.(trigger)) return 0;
  if (!trigger.hasAttribute?.(RELEASE_ASSETS_COMIC_TRIGGER_ATTRIBUTE)) return 0;
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
  const state = hostState(document);
  forget(state);
  state.comic = { session, key: sourceKey(releaseId), ...identity };
  return session;
}

// Reconcile an open comic session with the installed region (see header).
function refreshComicSession(document, state, viewer) {
  const { comic } = state;
  const viewerState = viewer?.getState?.();
  if (!viewerState?.open || viewerState.session !== comic.session || !viewerState.comic) {
    state.comic = null;
    return null;
  }
  const region = regionElement(document);
  const releaseId = releaseIdOf(document);
  if (!region || !releaseId) return null;
  const identity = { projectId: Number(comic.projectId), assetId: Number(comic.assetId) };
  let hint = null;
  if (sourceKey(releaseId) !== comic.key) {
    // Another release's workspace: like an image session, it is retired.
    hint = { ...identity, eligible: false };
  } else {
    const trigger = comicTriggerFor(region, comic.projectId, comic.assetId);
    if (trigger) {
      const sourceRevision = trigger.getAttribute?.('data-comic-source-revision');
      hint = sourceRevision ? { ...identity, ...comicMetadata(trigger), sourceRevision } : { ...identity, ...comicMetadata(trigger) };
    } else if (rendersAsset(region, comic)) {
      hint = { ...identity, eligible: false };
    } else {
      // A limited result cannot prove removal, even for the same page/query.
      return null;
    }
  }
  const result = viewer.reconcileComic(hint, { session: comic.session });
  if (!viewer.getState().open) state.comic = null;
  return result;
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
  if (state?.comic) return refreshComicSession(document, state, unifiedViewerFor(document));
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
 * Bind Release Manage Assets image thumbnail and Read comic activation once
 * per document.
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
    const comicTrigger = event.target?.closest?.(COMIC_TRIGGER_SELECTOR);
    if (comicTrigger) {
      if (openReleaseAssetsComic(document, comicTrigger)) event.preventDefault?.();
      return;
    }
    const trigger = event.target?.closest?.(TRIGGER_SELECTOR);
    if (!trigger) return;
    if (openReleaseAssetsImage(document, trigger)) event.preventDefault?.();
  });
  return 1;
}
