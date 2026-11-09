// ─── Project Assets: unified viewer host integration (Milestone B, B5a) ──────
//
// Connects the Project Assets page to the shared unified viewer
// (unified-viewer.js). This module only translates page activation into B1
// viewer sources and hands live-refresh data to the controller; it owns no
// viewer state machine of its own.
//
// - An unmodified primary click on an image thumbnail
//   (`[data-project-assets-preview-id]`) opens ONLY that image
//   (createSingleImageSource). Thumbnails whose asset is not in the
//   server-filtered image sequence (videos, comics, missing or unsupported
//   media) are left alone, so their link (or the video player) behaves as
//   before. Modified and middle clicks keep normal link navigation.
// - The toolbar Slideshow button (`[data-project-assets-slideshow-trigger]`)
//   opens the complete server-filtered image sequence in server order
//   (createSlideshowSource) — every matching image, not just the rendered
//   page, cards or selection.
// - After a live refresh the page's authoritative sequence JSON
//   (`[data-project-assets-viewer-sequence]`, outside the live region) has
//   already been replaced; refreshProjectAssetsViewer() hands it to the
//   viewer's update(), bound to the session this page opened, so the B1
//   reconciliation keeps, replaces or closes the shown item.
//
// Click handling is delegated from the document and bound once, so thumbnails
// and the toolbar button re-rendered by live filtering need no rebinding and
// can never collect duplicate listeners.

import { isEnhancementBound, liveRegionDocument, markEnhancementBound } from './dom.js';
import { unifiedViewerFor } from './unified-viewer.js';
import {
  createSingleImageSource,
  createSlideshowSource,
  viewerItemFromSlideshowEntry,
} from './viewer-sequence.js';

export const PROJECT_ASSETS_VIEWER_SEQUENCE_SELECTOR = '[data-project-assets-viewer-sequence]';
const SEQUENCE_SELECTOR = PROJECT_ASSETS_VIEWER_SEQUENCE_SELECTOR;
const SLIDESHOW_TRIGGER_SELECTOR = '[data-project-assets-slideshow-trigger]';
const PREVIEW_SELECTOR = '[data-project-assets-preview-id]';
const BOUND_KEY = 'projectAssetsViewerBound';
const STATE_PROPERTY = '__creatorCrateProjectAssetsViewer';

function sequenceElement(document) {
  return document?.querySelector?.(SEQUENCE_SELECTOR) || null;
}

// The raw sequence text plus its parsed entries. `entries` is null when the
// text is not a JSON array, so malformed data never stands in for "empty".
function readSequence(document) {
  const element = sequenceElement(document);
  if (!element) return null;
  const text = element.textContent || '[]';
  let entries = null;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) entries = parsed;
  } catch {
    entries = null;
  }
  return {
    text,
    entries,
    projectId: element.getAttribute?.('data-project-id') || null,
    label: element.getAttribute?.('data-viewer-label') || '',
  };
}

function sourceKey(projectId) {
  return projectId ? `project-assets:${projectId}` : 'project-assets';
}

function hostState(document) {
  if (!document[STATE_PROPERTY]) document[STATE_PROPERTY] = { session: 0, text: null };
  return document[STATE_PROPERTY];
}

function isUnmodifiedPrimaryClick(event) {
  if (event.defaultPrevented) return false;
  if (event.button !== undefined && event.button !== 0) return false;
  return !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
}

function slideshowTrigger(document) {
  return document?.querySelector?.(SLIDESHOW_TRIGGER_SELECTOR) || null;
}

function enabledSlideshowTrigger(document) {
  const trigger = slideshowTrigger(document);
  return trigger && !trigger.disabled ? trigger : null;
}

function previewLinkFor(document, assetId) {
  if (!/^\d+$/.test(String(assetId))) return null;
  return document?.querySelector?.(`[data-project-assets-preview-id="${assetId}"]`) || null;
}

// Like the legacy slideshow, the Slideshow button is unavailable while the
// filtered sequence holds no image.
function syncSlideshowTrigger(document, sequence = readSequence(document)) {
  const trigger = slideshowTrigger(document);
  if (!trigger) return;
  const entries = sequence?.entries;
  if (entries) trigger.disabled = entries.length === 0;
}

function remember(document, session, text) {
  const state = hostState(document);
  state.session = session;
  state.text = text;
  return session;
}

/**
 * Open the complete server-filtered image sequence as a slideshow.
 *
 * @param {Document} document
 * @param {Element|null} opener
 * @returns {number} the viewer session, or 0 when nothing opened
 */
export function openProjectAssetsSlideshow(document, opener = null) {
  const viewer = unifiedViewerFor(document);
  const sequence = readSequence(document);
  if (!viewer || !sequence?.entries?.length) return 0;
  const source = createSlideshowSource({
    key: sourceKey(sequence.projectId),
    label: sequence.label,
    entries: sequence.entries,
  });
  const session = viewer.open(source, {
    opener,
    fallbackFocus: () => enabledSlideshowTrigger(document),
  });
  return session ? remember(document, session, sequence.text) : 0;
}

/**
 * Open only one image of the sequence. Returns 0 (and opens nothing) when
 * the asset is not an eligible image of the current sequence.
 *
 * @param {Document} document
 * @param {string} assetId
 * @param {Element|null} opener
 * @returns {number} the viewer session, or 0 when nothing opened
 */
export function openProjectAssetsImage(document, assetId, opener = null) {
  const viewer = unifiedViewerFor(document);
  const sequence = readSequence(document);
  if (!viewer || !sequence?.entries?.length) return 0;
  const source = createSingleImageSource({
    key: sourceKey(sequence.projectId),
    label: sequence.label,
    entries: sequence.entries,
    projectId: sequence.projectId ?? undefined,
    assetId,
  });
  if (source.items.length === 0) return 0;
  const session = viewer.open(source, {
    opener,
    fallbackFocus: () => previewLinkFor(document, assetId) || enabledSlideshowTrigger(document),
  });
  return session ? remember(document, session, sequence.text) : 0;
}

/**
 * Reconcile an open Project Assets viewer session with the page's current
 * authoritative sequence (after a live refresh replaced it), and resync the
 * Slideshow button. Sessions this page did not open, or that have since
 * closed or been replaced, are never touched.
 *
 * @param {Document|Element} scope
 * @returns {object|null} the reconciliation result, or null when nothing applied
 */
export function refreshProjectAssetsViewer(scope = globalThis.document) {
  const document = liveRegionDocument(scope);
  if (!document) return null;
  const sequence = readSequence(document);
  if (!sequence) return null;
  syncSlideshowTrigger(document, sequence);

  const state = hostState(document);
  if (!state.session) return null;
  const viewer = unifiedViewerFor(document);
  const viewerState = viewer?.getState?.();
  if (!viewerState?.open || viewerState.session !== state.session) {
    state.session = 0;
    state.text = null;
    return null;
  }
  // Unparseable data is not authoritative; unchanged data needs no update.
  if (!sequence.entries || sequence.text === state.text) return null;
  state.text = sequence.text;
  const result = viewer.update({
    key: sourceKey(sequence.projectId),
    label: sequence.label,
    items: sequence.entries.map(viewerItemFromSlideshowEntry),
  }, { session: state.session });
  if (!viewer.getState().open) {
    state.session = 0;
    state.text = null;
  }
  return result;
}

/**
 * Bind Project Assets thumbnail and Slideshow activation once per document.
 * A page without the Project Assets sequence is left untouched.
 *
 * @param {Document|Element} [scope]
 * @returns {0|1}
 */
export function enhanceProjectAssetsViewer(scope = globalThis.document) {
  const document = liveRegionDocument(scope);
  if (!document || typeof document.addEventListener !== 'function') return 0;
  if (!sequenceElement(document)) return 0;
  syncSlideshowTrigger(document);
  if (isEnhancementBound(document, BOUND_KEY)) return 1;
  markEnhancementBound(document, BOUND_KEY);

  document.addEventListener('click', (event) => {
    if (!isUnmodifiedPrimaryClick(event)) return;
    const target = event.target;
    const trigger = target?.closest?.(SLIDESHOW_TRIGGER_SELECTOR);
    if (trigger) {
      if (trigger.disabled) return;
      if (openProjectAssetsSlideshow(document, trigger)) event.preventDefault?.();
      return;
    }
    const link = target?.closest?.(PREVIEW_SELECTOR);
    if (!link) return;
    const assetId = link.getAttribute?.('data-project-assets-preview-id');
    if (openProjectAssetsImage(document, assetId, link)) event.preventDefault?.();
  });
  return 1;
}
