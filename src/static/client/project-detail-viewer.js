// ─── Project Detail: unified viewer host integration (Milestone B, B7c) ──────
//
// Connects the release-thumbnail strips of Project Detail (/projects/:id) to
// the shared unified viewer (unified-viewer.js). Like the earlier hosts (B5a,
// B5b, B6, B7a, B7b) this module only translates page activation into a B1
// viewer source; it owns no viewer state machine and no project or release
// state of its own.
//
// - The trigger is the image link of an eligible strip thumbnail only
//   (`[data-project-detail-viewer-trigger]`, emitted through the shared asset
//   presentation macro for a present, previewable image with a server-built
//   preview URL). An unmodified primary click opens ONLY that image
//   (createSingleImageSource): never the release's or project's images,
//   never Previous/Next, never autoplay. Modified and middle clicks keep the
//   link's Asset Details navigation. The release title link, the "+N more"
//   link, the social-post badges, the release actions and the video tiles are
//   never triggers.
// - The descriptor comes only from the server-rendered attributes on that
//   link: project and asset identity, the release whose strip it sits in,
//   filename, preview URL, original URL when inline-eligible, opaque revision
//   and the Asset Details URL. No URL is derived on the client.
// - The same asset can sit in several release strips: each opening is keyed
//   by its project and release (`project-detail:<project>:release:<release>`)
//   and identified by its asset, and focus returns to the thumbnail that was
//   clicked, or to the same asset's thumbnail in the same release, or to that
//   release's title link.
// - Opening and closing are presentation-only: nothing is submitted, and
//   nothing about the project or a release is read or written.
// - Project Detail's own refresh (project-detail-refresh.js, after an Edit
//   Project save or an Archive in place) replaces only its project regions;
//   the Releases section sits outside every region and is never replaced, so
//   no refresh carries new strip data and there is nothing to reconcile. The
//   one authoritative change is a Delete of the page's own project
//   (project-delete.js), which retires the page: this host then closes a
//   session it opened and withdraws every trigger, for good.
//
// Click handling is delegated from the document and bound once.

import { isEnhancementBound, liveRegionDocument, markEnhancementBound } from './dom.js';
import { PROJECT_DELETED_EVENT } from './project-edit-dialog.js';
import { PROJECT_DELETED_HOST_ATTRIBUTE } from './project-delete.js';
import { unifiedViewerFor } from './unified-viewer.js';
import { createSingleImageSource } from './viewer-sequence.js';

export const PROJECT_DETAIL_VIEWER_TRIGGER_ATTRIBUTE = 'data-project-detail-viewer-trigger';
const TRIGGER_SELECTOR = `[${PROJECT_DETAIL_VIEWER_TRIGGER_ATTRIBUTE}]`;
const PAGE_SELECTOR = '[data-project-detail]';
const RELEASES_SELECTOR = '.project-detail-releases';
const STRIP_SELECTOR = '.release-thumbnail-strip';
const DESCRIPTOR_ATTRIBUTES = Object.freeze([
  'data-viewer-project',
  'data-viewer-asset',
  'data-viewer-release',
  'data-viewer-filename',
  'data-viewer-preview-url',
  'data-viewer-original-url',
  'data-viewer-revision',
  'data-viewer-details-url',
]);
const BOUND_KEY = 'projectDetailViewerBound';
const STATE_PROPERTY = '__creatorCrateProjectDetailViewer';
const NUMERIC_ID = /^[1-9]\d*$/;

function projectIdOf(document) {
  const id = document?.querySelector?.(PAGE_SELECTOR)?.getAttribute?.('data-project-detail') || '';
  return NUMERIC_ID.test(id) ? id : null;
}

function releasesElement(document) {
  return document?.querySelector?.(RELEASES_SELECTOR) || null;
}

function sourceKey(projectId, releaseId) {
  return `project-detail:${projectId}:release:${releaseId}`;
}

function hostState(document) {
  if (!document[STATE_PROPERTY]) {
    document[STATE_PROPERTY] = { session: 0, key: null, retired: false };
  }
  return document[STATE_PROPERTY];
}

function forget(state) {
  state.session = 0;
  state.key = null;
}

function isUnmodifiedPrimaryClick(event) {
  if (event.defaultPrevented) return false;
  if (event.button !== undefined && event.button !== 0) return false;
  return !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
}

function triggerIdentity(trigger) {
  const projectId = trigger?.getAttribute?.('data-viewer-project') || '';
  const assetId = trigger?.getAttribute?.('data-viewer-asset') || '';
  const releaseId = trigger?.getAttribute?.('data-viewer-release') || '';
  if (!NUMERIC_ID.test(projectId) || !NUMERIC_ID.test(assetId) || !NUMERIC_ID.test(releaseId)) return null;
  return { projectId, assetId, releaseId };
}

// The authoritative slideshow-format entry for a trigger (the shape B1's
// createSingleImageSource accepts).
function readEntry(trigger, identity) {
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

function isRetired(document) {
  if (hostState(document).retired) return true;
  return Boolean(document.getElementById?.('main-content')?.hasAttribute?.(PROJECT_DELETED_HOST_ATTRIBUTE));
}

function isUsable(element) {
  return Boolean(element) && !element.hidden && !element.closest?.('[inert]');
}

// A current trigger of the Releases section: inside a release strip, carrying
// a complete identity of the page's own project.
function currentTrigger(document, trigger) {
  const releases = releasesElement(document);
  if (!releases || !trigger || !releases.contains?.(trigger)) return null;
  if (!trigger.hasAttribute?.(PROJECT_DETAIL_VIEWER_TRIGGER_ATTRIBUTE) || !trigger.closest?.(STRIP_SELECTOR)) return null;
  const identity = triggerIdentity(trigger);
  if (!identity || identity.projectId !== projectIdOf(document)) return null;
  return identity;
}

// Focus return when the opener is gone: the same asset's current thumbnail
// in the same release strip, else that release's title link (the controller
// falls back to #main-content after that).
function fallbackFocus(document, identity) {
  const releases = releasesElement(document);
  if (!releases) return null;
  const trigger = releases.querySelector?.(
    `${STRIP_SELECTOR} ${TRIGGER_SELECTOR}[data-viewer-release="${identity.releaseId}"][data-viewer-asset="${identity.assetId}"]`,
  );
  if (isUsable(trigger)) return trigger;
  const title = releases.querySelector?.(`.release-list > li > a[href="/releases/${identity.releaseId}"]`);
  return isUsable(title) ? title : null;
}

// A withdrawn trigger becomes a fresh copy of the same Asset Details link
// without any viewer descriptor. The old element leaves the document, so a
// cached reference can never open again, and the viewer's focus return for a
// session it opened skips it (a retired page is inert by then, so focus would
// otherwise be lost) and takes the controller's #main-content fallback.
function withdrawTrigger(trigger) {
  const replacement = typeof trigger.cloneNode === 'function' ? trigger.cloneNode(true) : null;
  const target = replacement && typeof trigger.replaceWith === 'function' ? replacement : trigger;
  target.removeAttribute?.(PROJECT_DETAIL_VIEWER_TRIGGER_ATTRIBUTE);
  DESCRIPTOR_ATTRIBUTES.forEach((name) => target.removeAttribute?.(name));
  if (target !== trigger) trigger.replaceWith(target);
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

/**
 * The page's project is gone (project-delete.js retired the page): withdraw
 * every trigger (first, so focus never returns to an inert opener) and close
 * a session this page opened, for good. The links
 * stay the plain Asset Details links they always were (inert with the page).
 *
 * @param {Document} document
 * @returns {object|null} the viewer's close result, or null
 */
export function retireProjectDetailViewer(document) {
  if (!document) return null;
  const state = hostState(document);
  state.retired = true;
  Array.from(releasesElement(document)?.querySelectorAll?.(TRIGGER_SELECTOR) || []).forEach(withdrawTrigger);
  const own = ownSession(document);
  if (!own) return null;
  const result = own.viewer.update({ key: own.state.key, items: [] }, { session: own.state.session });
  if (!own.viewer.getState().open) forget(own.state);
  return result ? { ...result, hostReason: 'removed' } : result;
}

/**
 * Open one eligible release-strip image of Project Detail in single-image
 * mode.
 *
 * @param {Document} document
 * @param {Element} trigger  the clicked `[data-project-detail-viewer-trigger]`
 * @returns {number} the viewer session, or 0 when nothing opened
 */
export function openProjectDetailImage(document, trigger) {
  const viewer = unifiedViewerFor(document);
  if (!viewer || isRetired(document) || !isUsable(trigger)) return 0;
  const identity = currentTrigger(document, trigger);
  if (!identity) return 0;
  const entry = readEntry(trigger, identity);
  const key = sourceKey(identity.projectId, identity.releaseId);
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
  return session;
}

/**
 * Bind Project Detail release-thumbnail activation and its project-deletion
 * observer once per document. A page that is not Project Detail is left
 * untouched.
 *
 * @param {Document|Element} [scope]
 * @returns {0|1}
 */
export function enhanceProjectDetailViewer(scope = globalThis.document) {
  const document = liveRegionDocument(scope);
  if (!document || typeof document.addEventListener !== 'function') return 0;
  if (!releasesElement(document) || !projectIdOf(document)) return 0;
  if (isEnhancementBound(document, BOUND_KEY)) return 1;
  markEnhancementBound(document, BOUND_KEY);

  document.addEventListener('click', (event) => {
    if (!isUnmodifiedPrimaryClick(event)) return;
    const trigger = event.target?.closest?.(TRIGGER_SELECTOR);
    if (!trigger) return;
    if (openProjectDetailImage(document, trigger)) event.preventDefault?.();
  });
  document.addEventListener(PROJECT_DELETED_EVENT, (event) => {
    // Only the page's own project, and only once the page was retired.
    const projectId = projectIdOf(document);
    if (!projectId || String(event.detail?.projectId) !== projectId || event.detail?.hostRetired !== true) return;
    retireProjectDetailViewer(document);
  });
  return 1;
}
