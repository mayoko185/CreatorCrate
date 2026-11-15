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
// WP7.4 — Related Notes assets. The "related-notes" region carries the same
// opt-in activation through the shared asset presentation list card
// (options.viewerActivation): the thumbnail and the filename of an eligible
// image (`[data-project-related-note-viewer-trigger]`) open ONLY that image
// (createSingleImageSource, never a gallery of the note's assets), and those
// of a reader-eligible comic (`[data-project-related-note-comic-trigger]`)
// open it through the controller's openComic(). Supported videos keep the
// shared video preview dialog (asset-video-playback.js); missing and
// unsupported files keep their Asset Details links. Modified and middle
// clicks keep the links' navigation.
// - A session is owned by its project, note and asset: the image key is
//   `project-detail:<project>:note:<note>`, and the record names the note and
//   asset, so the same asset under two notes never shares a session, and the
//   release-strip record is separate.
// - The region is replaced by every Project Detail refresh. After an
//   installed render whose Notes read succeeded, project-detail-refresh.js
//   calls reconcileProjectRelatedNotesViewer(): the same note still offering
//   the asset brings its current descriptor (update() / reconcileComic()), and
//   none (the note or the asset left Related Notes, or the asset is no longer
//   eligible) closes or retires the session. A failed Notes read and a
//   superseded refresh are no evidence and change nothing.
// - Focus returns to the clicked control, else the same note's control for
//   the same asset (thumbnail or filename), else that note's title link, else
//   the Related Notes heading.
//
// Click handling is delegated from the document and bound once.

import { isEnhancementBound, liveRegionDocument, markEnhancementBound } from './dom.js';
import { PROJECT_DELETED_EVENT } from './project-edit-dialog.js';
import { PROJECT_DELETED_HOST_ATTRIBUTE } from './project-delete.js';
import { unifiedViewerFor } from './unified-viewer.js';
import { imageSourcesFromViewerTrigger, createSingleImageSource, viewerItemFromSlideshowEntry } from './viewer-sequence.js';

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
  'data-viewer-project-name',
  'data-viewer-preview-url',
  'data-viewer-original-url',
  'data-viewer-revision',
  'data-viewer-image-sources',
  'data-viewer-details-url',
]);
export const PROJECT_RELATED_NOTE_VIEWER_TRIGGER_ATTRIBUTE = 'data-project-related-note-viewer-trigger';
export const PROJECT_RELATED_NOTE_COMIC_TRIGGER_ATTRIBUTE = 'data-project-related-note-comic-trigger';
const NOTE_TRIGGER_SELECTOR = `[${PROJECT_RELATED_NOTE_VIEWER_TRIGGER_ATTRIBUTE}]`;
const NOTE_COMIC_TRIGGER_SELECTOR = `[${PROJECT_RELATED_NOTE_COMIC_TRIGGER_ATTRIBUTE}]`;
const NOTES_REGION_SELECTOR = '[data-project-related-notes-region]';
const NOTES_UNAVAILABLE_SELECTOR = '[data-project-related-notes-state="unavailable"]';
const NOTES_HEADING_ID = 'project-related-notes-heading';
const NOTE_CARD_ATTRIBUTE = 'data-project-related-note';
const NOTE_ASSET_ATTRIBUTE = 'data-project-related-note-asset';
const NOTE_MEDIA_CONTROL_SELECTOR = '.asset-list-card-media a[href]';
const NOTE_TITLE_CONTROL_SELECTOR = '.asset-file-link';
const COMIC_DESCRIPTOR_ATTRIBUTES = Object.freeze([
  'data-comic-project',
  'data-comic-asset',
  'data-comic-source-revision',
  'data-comic-title',
  'data-comic-filename',
  'data-comic-project-name',
  'data-comic-details-url',
  'data-comic-label',
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
    // `note`: the Related Notes session record (WP7.4), apart from the strip's.
    document[STATE_PROPERTY] = { session: 0, key: null, note: null, retired: false };
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
    projectName: trigger.getAttribute?.('data-viewer-project-name') || null,
    previewUrl: trigger.getAttribute?.('data-viewer-preview-url') || '',
    ...(detailsUrl ? { viewerUrl: detailsUrl } : {}),
    ...(originalUrl ? { originalUrl } : {}),
    revision: revision || null,
    imageSources: imageSourcesFromViewerTrigger(trigger),
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
function withdrawTrigger(trigger, attribute = PROJECT_DETAIL_VIEWER_TRIGGER_ATTRIBUTE, descriptor = DESCRIPTOR_ATTRIBUTES) {
  const replacement = typeof trigger.cloneNode === 'function' ? trigger.cloneNode(true) : null;
  const target = replacement && typeof trigger.replaceWith === 'function' ? replacement : trigger;
  target.removeAttribute?.(attribute);
  descriptor.forEach((name) => target.removeAttribute?.(name));
  // A withdrawn Read comic link reads as the Asset Details link it now is.
  const label = target.getAttribute?.('aria-label');
  if (label && attribute === PROJECT_RELATED_NOTE_COMIC_TRIGGER_ATTRIBUTE) {
    target.setAttribute?.('aria-label', label.replace(/^Read comic /, 'View details for '));
  }
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
  Array.from(releasesElement(document)?.querySelectorAll?.(TRIGGER_SELECTOR) || []).forEach((trigger) => withdrawTrigger(trigger));
  const noteResult = retireRelatedNoteSession(document);
  if (noteResult) return noteResult;
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
  state.note = null;
  return session;
}

// ── Related Notes (WP7.4) ───────────────────────────────────────────────────

function notesRegion(document) {
  return document?.querySelector?.(NOTES_REGION_SELECTOR) || null;
}

function isFocusable(element) {
  return Boolean(element) && element.isConnected !== false && isUsable(element) && !element.closest?.('[hidden]');
}

// The note card and asset item a Related Notes control sits in (the live
// region, or a replaced one it was detached with), and which of the asset's
// two controls it is.
function noteControlContext(control) {
  const card = control?.closest?.(`[${NOTE_CARD_ATTRIBUTE}]`);
  const item = control?.closest?.(`[${NOTE_ASSET_ATTRIBUTE}]`);
  const noteId = card?.getAttribute?.(NOTE_CARD_ATTRIBUTE) || '';
  const assetId = item?.getAttribute?.(NOTE_ASSET_ATTRIBUTE) || '';
  if (!NUMERIC_ID.test(noteId) || !NUMERIC_ID.test(assetId) || !card.contains?.(item)) return null;
  return { noteId, assetId, role: control.matches?.(NOTE_TITLE_CONTROL_SELECTOR) ? 'title' : 'media' };
}

// The current asset item of one note in the live region.
function noteAssetItem(document, noteId, assetId) {
  const card = notesRegion(document)?.querySelector?.(`[${NOTE_CARD_ATTRIBUTE}="${noteId}"]`);
  return card?.querySelector?.(`[${NOTE_ASSET_ATTRIBUTE}="${assetId}"]`) || null;
}

/**
 * Where focus goes for a Related Notes asset control that a refresh replaced:
 * the same note's control for the same asset (the same one, thumbnail or
 * filename, first), else that note's title link, else the Related Notes
 * heading. Null when none can take focus.
 *
 * @param {Document} document
 * @param {{ noteId: string, assetId: string, role?: string }|Element} context
 * @returns {Element|null}
 */
export function projectRelatedNoteAssetFocus(document, context) {
  const ctx = context?.nodeType === 1 ? noteControlContext(context) : context;
  const region = notesRegion(document);
  if (!ctx || !region) return null;
  const item = noteAssetItem(document, ctx.noteId, ctx.assetId);
  const controls = [NOTE_MEDIA_CONTROL_SELECTOR, NOTE_TITLE_CONTROL_SELECTOR];
  if (ctx.role === 'title') controls.reverse();
  for (const selector of controls) {
    const control = Array.from(item?.querySelectorAll?.(selector) || []).find(isFocusable);
    if (control) return control;
  }
  const title = region.querySelector?.(`[${NOTE_CARD_ATTRIBUTE}="${ctx.noteId}"] [data-project-related-note-page-link]`);
  if (isFocusable(title)) return title;
  const heading = region.querySelector?.(`#${NOTES_HEADING_ID}`);
  if (!isFocusable(heading)) return null;
  if (!heading.hasAttribute?.('tabindex')) heading.setAttribute?.('tabindex', '-1');
  return heading;
}

// A control inside the live Related Notes region of the page's own project,
// in a note card, with an asset item whose card names the same asset.
function noteTriggerContext(document, trigger, assetId) {
  const region = notesRegion(document);
  if (!region || !trigger || !region.contains?.(trigger) || !isUsable(trigger)) return null;
  const ctx = noteControlContext(trigger);
  if (!ctx || ctx.assetId !== assetId) return null;
  const card = trigger.closest?.('article[data-asset-id]');
  if (!card || card.getAttribute?.('data-asset-id') !== assetId) return null;
  return ctx;
}

// A filename trigger is refused while its card's image preview failed, like
// the hidden thumbnail beside it; the link keeps its Asset Details navigation.
function previewFailed(trigger) {
  const card = trigger.closest?.('article[data-asset-id]');
  return card?.querySelector?.('[data-preview-enhancement]')?.getAttribute?.('data-preview-state') === 'failed';
}

function noteImageIdentity(document, trigger) {
  if (!trigger?.hasAttribute?.(PROJECT_RELATED_NOTE_VIEWER_TRIGGER_ATTRIBUTE)) return null;
  const projectId = trigger.getAttribute?.('data-viewer-project') || '';
  const assetId = trigger.getAttribute?.('data-viewer-asset') || '';
  if (!NUMERIC_ID.test(projectId) || !NUMERIC_ID.test(assetId) || projectId !== projectIdOf(document)) return null;
  return { projectId, assetId };
}

// The identity of a Read comic link, only when its ids are well formed, of
// the page's own project, and agree with its server-built Asset Details href.
function noteComicIdentity(document, trigger) {
  if (!trigger?.hasAttribute?.(PROJECT_RELATED_NOTE_COMIC_TRIGGER_ATTRIBUTE)) return null;
  const projectId = trigger.getAttribute?.('data-comic-project') || '';
  const assetId = trigger.getAttribute?.('data-comic-asset') || '';
  if (!NUMERIC_ID.test(projectId) || !NUMERIC_ID.test(assetId) || projectId !== projectIdOf(document)) return null;
  if (trigger.getAttribute?.('href') !== `/projects/${projectId}/assets/${assetId}`) return null;
  return { projectId, assetId };
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

function noteSourceKey(projectId, noteId) {
  return `project-detail:${projectId}:note:${noteId}`;
}

// The current trigger of a kind for one note's asset in the live region.
function currentNoteTrigger(document, record, selector) {
  const item = noteAssetItem(document, record.noteId, record.assetId);
  return Array.from(item?.querySelectorAll?.(selector) || []).find((trigger) => isUsable(trigger)
    && !trigger.closest?.('[hidden]')) || null;
}

// The open Related Notes session this page opened, or null (forgetting a
// stale record).
function ownNoteSession(document) {
  const state = document?.[STATE_PROPERTY];
  if (!state?.note) return null;
  const viewer = unifiedViewerFor(document);
  const viewerState = viewer?.getState?.();
  const comic = state.note.kind === 'comic';
  if (!viewerState?.open || viewerState.session !== state.note.session || Boolean(viewerState.comic) !== comic
    || (comic && typeof viewer.reconcileComic !== 'function')) {
    state.note = null;
    return null;
  }
  return { state, viewer, record: state.note };
}

function retireRelatedNoteSession(document) {
  const region = notesRegion(document);
  Array.from(region?.querySelectorAll?.(NOTE_TRIGGER_SELECTOR) || []).forEach((trigger) => withdrawTrigger(
    trigger, PROJECT_RELATED_NOTE_VIEWER_TRIGGER_ATTRIBUTE, ['data-viewer-project', 'data-viewer-asset', ...DESCRIPTOR_ATTRIBUTES],
  ));
  Array.from(region?.querySelectorAll?.(NOTE_COMIC_TRIGGER_SELECTOR) || []).forEach((trigger) => withdrawTrigger(
    trigger, PROJECT_RELATED_NOTE_COMIC_TRIGGER_ATTRIBUTE, COMIC_DESCRIPTOR_ATTRIBUTES,
  ));
  const own = ownNoteSession(document);
  if (!own) return null;
  const { state, viewer, record } = own;
  const result = record.kind === 'comic'
    ? viewer.reconcileComic(null, { session: record.session })
    : viewer.update({ key: record.key, items: [] }, { session: record.session });
  if (!viewer.getState().open) state.note = null;
  return result ? { ...result, hostReason: 'removed' } : result;
}

/**
 * Open one eligible Related Notes image (its thumbnail or filename) in
 * single-image mode, owned by its note.
 *
 * @param {Document} document
 * @param {Element} trigger  the clicked `[data-project-related-note-viewer-trigger]`
 * @returns {number} the viewer session, or 0 when nothing opened
 */
export function openProjectRelatedNoteImage(document, trigger) {
  const viewer = unifiedViewerFor(document);
  if (!viewer || isRetired(document)) return 0;
  const identity = noteImageIdentity(document, trigger);
  const ctx = identity ? noteTriggerContext(document, trigger, identity.assetId) : null;
  if (!ctx || previewFailed(trigger)) return 0;
  const entry = readEntry(trigger, identity);
  const key = noteSourceKey(identity.projectId, ctx.noteId);
  const source = createSingleImageSource({
    key,
    entries: [entry],
    projectId: identity.projectId,
    assetId: identity.assetId,
  });
  if (source.items.length === 0) return 0;
  const session = viewer.open(source, {
    opener: trigger,
    fallbackFocus: () => projectRelatedNoteAssetFocus(document, ctx),
  });
  if (!session) return 0;
  const state = hostState(document);
  forget(state);
  state.note = {
    kind: 'image', session, key, projectId: identity.projectId, noteId: ctx.noteId, assetId: identity.assetId,
    entryText: JSON.stringify(entry),
  };
  return session;
}

/**
 * Open one readable Related Notes comic (its Read comic thumbnail or
 * filename) in the shared reader, owned by its note.
 *
 * @param {Document} document
 * @param {Element} trigger  the clicked `[data-project-related-note-comic-trigger]`
 * @returns {number} the viewer session, or 0 when nothing opened
 */
export function openProjectRelatedNoteComic(document, trigger) {
  const viewer = unifiedViewerFor(document);
  if (!viewer || typeof viewer.openComic !== 'function' || isRetired(document)) return 0;
  const identity = noteComicIdentity(document, trigger);
  const ctx = identity ? noteTriggerContext(document, trigger, identity.assetId) : null;
  if (!ctx) return 0;
  const session = viewer.openComic({
    projectId: Number(identity.projectId),
    assetId: Number(identity.assetId),
    ...comicMetadata(trigger),
    title: trigger.getAttribute?.('data-comic-title') || '',
    label: trigger.getAttribute?.('data-comic-label') || '',
    sourceRevision: trigger.getAttribute?.('data-comic-source-revision') || undefined,
  }, {
    opener: trigger,
    fallbackFocus: () => projectRelatedNoteAssetFocus(document, ctx),
  });
  if (!session) return 0;
  const state = hostState(document);
  forget(state);
  state.note = { kind: 'comic', session, projectId: identity.projectId, noteId: ctx.noteId, assetId: identity.assetId };
  return session;
}

/**
 * Reconcile an open Related Notes session with the region a Project Detail
 * refresh has just installed (project-detail-refresh.js calls this only for
 * an installed, current render). A render whose Notes read failed is no
 * evidence: the session stays. Otherwise the same note still offering the
 * asset as a trigger brings its current descriptor, and none closes the image
 * or retires the comic. Release-strip sessions and sessions another host
 * opened are never touched.
 *
 * @param {Document} document
 * @returns {object|null} the reconciliation result, or null
 */
export function reconcileProjectRelatedNotesViewer(document) {
  if (!document || isRetired(document)) return null;
  const region = notesRegion(document);
  if (!region || region.querySelector?.(NOTES_UNAVAILABLE_SELECTOR)) return null;
  const own = ownNoteSession(document);
  if (!own) return null;
  const { state, viewer, record } = own;
  const rendered = Boolean(noteAssetItem(document, record.noteId, record.assetId));
  let result;
  let hostReason;
  if (record.kind === 'comic') {
    const identity = { projectId: Number(record.projectId), assetId: Number(record.assetId) };
    const current = currentNoteTrigger(document, record, NOTE_COMIC_TRIGGER_SELECTOR);
    const sourceRevision = current?.getAttribute?.('data-comic-source-revision');
    const hint = current
      ? { ...identity, ...comicMetadata(current), ...(sourceRevision ? { sourceRevision } : {}) }
      : { ...identity, eligible: false };
    hostReason = current ? 'updated' : (rendered ? 'ineligible' : 'removed');
    result = viewer.reconcileComic(hint, { session: record.session });
  } else {
    const current = currentNoteTrigger(document, record, NOTE_TRIGGER_SELECTOR);
    const identity = current ? noteImageIdentity(document, current) : null;
    let items = [];
    if (identity && identity.assetId === record.assetId) {
      const entry = readEntry(current, identity);
      const entryText = JSON.stringify(entry);
      // Unchanged media and title: nothing to reload.
      if (entryText === record.entryText) return null;
      record.entryText = entryText;
      items = [viewerItemFromSlideshowEntry(entry)];
      hostReason = 'updated';
    } else {
      hostReason = rendered ? 'ineligible' : 'removed';
    }
    result = viewer.update({ key: record.key, items }, { session: record.session });
  }
  if (!viewer.getState().open) state.note = null;
  return result ? { ...result, hostReason } : result;
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
    const noteComic = event.target?.closest?.(NOTE_COMIC_TRIGGER_SELECTOR);
    if (noteComic) {
      if (openProjectRelatedNoteComic(document, noteComic)) event.preventDefault?.();
      return;
    }
    const noteImage = event.target?.closest?.(NOTE_TRIGGER_SELECTOR);
    if (noteImage) {
      if (openProjectRelatedNoteImage(document, noteImage)) event.preventDefault?.();
      return;
    }
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
