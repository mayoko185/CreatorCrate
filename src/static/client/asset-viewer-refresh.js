// Targeted refresh of the Asset detail page (/projects/:projectId/assets/:assetId)
// after a confirmed Edit Asset change. It re-reads the page with a GET of the
// current URL (which carries the asset-browser filter context) and installs
// only the server-rendered regions that depend on the change, by name:
//
//   'tags' (the default)
//     - [data-asset-viewer-region="tags"]        the Tags section's chips
//     - #asset-edit-form[data-confirmed-tag-ids]  Edit Asset's saved tag baseline
//     - its reviewed-state field (input[data-asset-tag-review], WP10A1-F3) for
//       that same saved set
//
//   'primary-image'
//     - [data-asset-viewer-region="project-primary-image"]   Edit Asset's Project
//       primary-image section (status and its Set/Remove form) and the saved
//       selection it carries (data-primary-image-selected)
//     - [data-asset-viewer-region="book-primary-image"]      Edit Asset's Book
//       primary-image section and the Books it is saved for
//       (data-book-primary-image-book-ids). When the section keeps its shape,
//       only its usage list ([data-asset-viewer-region="book-primary-image-usages"])
//       is replaced, so the Book choice in the Set form keeps its draft; when the
//       section appears, disappears or gains/loses its Set form it is replaced.
//
//   'file' (Rename and Move)
//     - the page title
//     - [data-asset-viewer-region="filter-notice"]   the filtered-out notice and
//       whether the asset still matches the page's filters
//       (data-asset-viewer-filtered-out)
//     - [data-asset-viewer-region="file-summary"]    Filename and Location, and the
//       saved identity they carry (data-asset-filename, data-asset-destination,
//       data-asset-category-label)
//     - [data-asset-viewer-region="file-details"]    Category, extension, MIME type,
//       size and modified time
//     - the Assets back link and the Open locally link (their hrefs)
//     - inside the media host, only what the server now renders differently:
//       the preview image's URL (its revision token names the file's path) and
//       labels, and the Previous/Next links. The image or video element stays
//       (a video's URL names only the asset ID, so playback is untouched); the
//       media is rebuilt only when its kind changed (a rename that changes the
//       extension can turn an image into an unsupported file, for example).
//     - #rename-filename / #move-destination[data-confirmed-value]  Edit Asset's
//       saved filename and destination baselines (never their values)
//     - the Delete form's reviewed-state field ([data-asset-delete-review]): the
//       server deletes the asset only while it still has the state that field
//       names, so a later Delete confirms what the page now shows. A Delete
//       already submitted keeps the value it was sent with (its request body
//       was captured at confirmation).
//     - the Rename and Move forms' reviewed-state fields ([data-asset-review],
//       F2B), the same way: the server renames or moves the asset only while it
//       still has the state they name.
//
// Nothing else on the page depends on tags or primary images (the viewer's
// Previous/Next context and its filtered-out notice ignore the tag filter, and
// no primary-image state is shown outside Edit Asset), so nothing else is
// touched. The media host ([data-asset-viewer-host]) and its figure, image or
// video, the navigation beside it, the rest of the Edit Asset dialog and any
// draft in it are never replaced or re-initialized: the caller decides what the
// new baseline means for the controls it owns (see refreshAssetViewer's result).
// A later caller whose change affects another region adds that region here.
//
// A region whose read was superseded or failed stays owed: the next refresh of
// this document installs it too, whoever asks, so a newer change can never leave
// an older change's region unrefreshed.
//
// The request is a GET only and never retried by itself; a caller offers
// Retry refresh / Check again, which calls refreshAssetViewer again.

import { enhancePreviewMedia, markPreviewFailed, markPreviewLoaded } from './preview.js';
import { enhanceVideoPlayback } from './asset-video-playback.js';

export const ASSET_VIEWER_REFRESH_STATUS = Object.freeze({
  // Every requested (and owed) region was installed from the server's current render.
  INSTALLED: 'installed',
  // The GET failed, was unreadable or returned another page. Nothing installed.
  FAILED: 'failed',
  // A newer refresh or mutation began first. Nothing installed; the newer one
  // owns the obligation, so this result reports neither success nor failure.
  SUPERSEDED: 'superseded',
  // The server answered 404: the asset is gone from this project. Nothing installed.
  MISSING: 'missing',
  // This document is not the requested Asset detail page. Nothing requested.
  UNAVAILABLE: 'unavailable',
});

export const ASSET_VIEWER_REFRESH_REGIONS = Object.freeze({
  TAGS: 'tags',
  PRIMARY_IMAGE: 'primary-image',
  FILE: 'file',
});

const REGION_ORDER = [
  ASSET_VIEWER_REFRESH_REGIONS.TAGS,
  ASSET_VIEWER_REFRESH_REGIONS.PRIMARY_IMAGE,
  ASSET_VIEWER_REFRESH_REGIONS.FILE,
];

const HOST_SELECTOR = '[data-asset-viewer-host]';
const TAGS_REGION_SELECTOR = '[data-asset-viewer-region="tags"]';
const TAG_FORM_SELECTOR = '#asset-edit-form';
const CONFIRMED_TAG_IDS_ATTRIBUTE = 'data-confirmed-tag-ids';
const TAG_REVIEW_SELECTOR = 'input[data-asset-tag-review]';
const PROJECT_PRIMARY_REGION_SELECTOR = '[data-asset-viewer-region="project-primary-image"]';
const BOOK_PRIMARY_REGION_SELECTOR = '[data-asset-viewer-region="book-primary-image"]';
const BOOK_USAGES_REGION_SELECTOR = '[data-asset-viewer-region="book-primary-image-usages"]';
const BOOK_SET_FORM_SELECTOR = '.asset-book-primary-image-set-form';
const PRIMARY_SELECTED_ATTRIBUTE = 'data-primary-image-selected';
const BOOK_IDS_ATTRIBUTE = 'data-book-primary-image-book-ids';
const FILTER_NOTICE_REGION_SELECTOR = '[data-asset-viewer-region="filter-notice"]';
const FILE_SUMMARY_REGION_SELECTOR = '[data-asset-viewer-region="file-summary"]';
const FILE_DETAILS_REGION_SELECTOR = '[data-asset-viewer-region="file-details"]';
const FILTERED_OUT_ATTRIBUTE = 'data-asset-viewer-filtered-out';
const FILE_IDENTITY_ATTRIBUTES = ['data-asset-filename', 'data-asset-destination', 'data-asset-category-label'];
const BACK_LINK_SELECTOR = 'a.asset-viewer-back';
const OPEN_LOCALLY_SELECTOR = 'a.asset-viewer-open-locally';
const RENAME_INPUT_SELECTOR = '#rename-filename';
const MOVE_SELECT_SELECTOR = '#move-destination';
const CONFIRMED_VALUE_ATTRIBUTE = 'data-confirmed-value';
const DELETE_REVIEW_SELECTOR = 'input[data-asset-delete-review]';
const FILE_REVIEW_SELECTOR = 'input[data-asset-review]';
const PREVIEW_HEADING_SELECTOR = '#asset-preview-heading';
const NAV_CLASSES = ['asset-preview-nav--previous', 'asset-preview-nav--next'];
const FOCUSABLE_TAGS = new Set(['BUTTON', 'SUMMARY', 'SELECT', 'INPUT', 'TEXTAREA', 'A']);
const STATE_KEY = '__creatorCrateAssetViewerRefresh';

function refreshState(document) {
  document[STATE_KEY] ||= { generation: 0 };
  document[STATE_KEY].owed ||= new Set();
  return document[STATE_KEY];
}

function readIdentity(root) {
  const host = root?.querySelector?.(HOST_SELECTOR);
  if (!host) return null;
  const projectId = host.getAttribute('data-asset-viewer-project-id');
  const assetId = host.getAttribute('data-asset-viewer-asset-id');
  if (!/^[1-9]\d*$/.test(projectId || '') || !/^[1-9]\d*$/.test(assetId || '')) return null;
  return { host, projectId, assetId };
}

function splitIds(value) {
  return String(value || '').split(',').filter(Boolean);
}

/**
 * The Asset detail page this document shows, or null on any other page.
 * @returns {{ projectId: string, assetId: string } | null}
 */
export function assetViewerIdentity(document) {
  const identity = readIdentity(document);
  return identity ? { projectId: identity.projectId, assetId: identity.assetId } : null;
}

/**
 * The primary-image selection the mounted page shows (its last installed
 * server render), or null when the page has no primary-image regions.
 * @returns {{ projectSelected: boolean, bookIds: string[] } | null}
 */
export function assetViewerPrimaryImageState(root) {
  const project = root?.querySelector?.(PROJECT_PRIMARY_REGION_SELECTOR);
  const book = root?.querySelector?.(BOOK_PRIMARY_REGION_SELECTOR);
  if (!project || !book) return null;
  return {
    projectSelected: project.getAttribute(PRIMARY_SELECTED_ATTRIBUTE) === 'true',
    bookIds: splitIds(book.getAttribute(BOOK_IDS_ATTRIBUTE)),
  };
}

/**
 * The saved file identity the mounted page shows (its last installed server
 * render), or null when the page has no file regions.
 * @returns {{ filename: string, destination: string, categoryLabel: string, filteredOut: boolean } | null}
 */
export function assetViewerFileState(root) {
  const summary = root?.querySelector?.(FILE_SUMMARY_REGION_SELECTOR);
  const notice = root?.querySelector?.(FILTER_NOTICE_REGION_SELECTOR);
  if (!summary || !notice) return null;
  return {
    filename: summary.getAttribute('data-asset-filename') || '',
    destination: summary.getAttribute('data-asset-destination') || '',
    categoryLabel: summary.getAttribute('data-asset-category-label') || '',
    filteredOut: notice.getAttribute(FILTERED_OUT_ATTRIBUTE) === 'true',
  };
}

/**
 * Call when a mutation of this asset begins. Any refresh still in flight was
 * read before that mutation and resolves `superseded` instead of installing.
 */
export function supersedeAssetViewerRefresh(document) {
  if (!document) return;
  refreshState(document).generation += 1;
}

/**
 * Whether a region is still owed: a refresh is out, or one was superseded or
 * failed and the next refresh must install it as well.
 */
export function assetViewerRefreshOwed(document) {
  return Boolean(document && refreshState(document).owed.size > 0);
}

/**
 * Call when the displayed asset no longer exists (WP10A3-B). Any refresh still
 * in flight resolves `superseded`, and every later one is `unavailable`: no
 * read can install details of the deleted asset or re-enable its controls.
 */
export function retireAssetViewer(document) {
  if (!document) return;
  const state = refreshState(document);
  state.retired = true;
  state.generation += 1;
  readIdentity(document)?.host?.setAttribute?.('data-asset-viewer-retired', '');
}

export function assetViewerRetired(document) {
  return Boolean(document?.[STATE_KEY]?.retired);
}

function importChildren(document, target, source) {
  const nodes = Array.from(source?.childNodes || []).map((node) => document.importNode(node, true));
  target.replaceChildren(...nodes);
}

function firstFocusable(root) {
  for (const node of Array.from(root?.childNodes || [])) {
    if (!node?.tagName) continue;
    if (node.hidden || node.hasAttribute?.('hidden') || node.hasAttribute?.('inert')) continue;
    const focusable = FOCUSABLE_TAGS.has(node.tagName)
      && !node.disabled && !node.hasAttribute?.('disabled')
      && node.getAttribute?.('type') !== 'hidden'
      && (node.tagName !== 'A' || node.hasAttribute?.('href'));
    if (focusable) return node;
    const nested = firstFocusable(node);
    if (nested) return nested;
  }
  return null;
}

// The Tags region holds only chips or the untagged note: no focusable content,
// listeners or media, so its children are replaced wholesale.
function planTags(document, parsed) {
  const tagsRegion = document.querySelector(TAGS_REGION_SELECTOR);
  const parsedTagsRegion = parsed.querySelector(TAGS_REGION_SELECTOR);
  if (!tagsRegion || !parsedTagsRegion) return null;
  return {
    regions: [tagsRegion],
    apply() {
      importChildren(document, tagsRegion, parsedTagsRegion);
      // The saved tag baseline. The server omits the form when tags can no longer
      // be managed (an archived project); the attribute is then left as it was.
      const form = document.querySelector(TAG_FORM_SELECTOR);
      const parsedForm = parsed.querySelector(TAG_FORM_SELECTOR);
      const previousConfirmedTagIds = splitIds(form?.getAttribute(CONFIRMED_TAG_IDS_ATTRIBUTE));
      let confirmedTagIds = null;
      if (form && parsedForm?.hasAttribute(CONFIRMED_TAG_IDS_ATTRIBUTE)) {
        const value = parsedForm.getAttribute(CONFIRMED_TAG_IDS_ATTRIBUTE);
        form.setAttribute(CONFIRMED_TAG_IDS_ATTRIBUTE, value);
        confirmedTagIds = splitIds(value);
        // The reviewed-state witness of that same saved set (WP10A1-F3): the
        // server replaces the tags only while they are still the set it names.
        // A save already sent keeps the value its body was captured with.
        const review = form.querySelector(TAG_REVIEW_SELECTOR);
        const parsedReview = parsedForm.querySelector(TAG_REVIEW_SELECTOR);
        if (review && parsedReview) review.value = parsedReview.value;
      }
      return { confirmedTagIds, previousConfirmedTagIds };
    },
  };
}

// The Project section holds only its status and one button form, so it is
// replaced wholesale. The Book section keeps its Set form (and the Book chosen
// in it) whenever both renders have one, and replaces only the usage list.
function planPrimaryImage(document, parsed) {
  const project = document.querySelector(PROJECT_PRIMARY_REGION_SELECTOR);
  const parsedProject = parsed.querySelector(PROJECT_PRIMARY_REGION_SELECTOR);
  const book = document.querySelector(BOOK_PRIMARY_REGION_SELECTOR);
  const parsedBook = parsed.querySelector(BOOK_PRIMARY_REGION_SELECTOR);
  if (!project || !parsedProject || !book || !parsedBook) return null;
  const usages = book.querySelector(BOOK_USAGES_REGION_SELECTOR);
  const parsedUsages = parsedBook.querySelector(BOOK_USAGES_REGION_SELECTOR);
  const keepBookShell = Boolean(usages && parsedUsages)
    && Boolean(book.querySelector(BOOK_SET_FORM_SELECTOR)) === Boolean(parsedBook.querySelector(BOOK_SET_FORM_SELECTOR));
  return {
    regions: [project, keepBookShell ? usages : book],
    fallbacks: [book],
    apply() {
      const previousPrimaryImage = assetViewerPrimaryImageState(document);
      importChildren(document, project, parsedProject);
      project.setAttribute(PRIMARY_SELECTED_ATTRIBUTE, parsedProject.getAttribute(PRIMARY_SELECTED_ATTRIBUTE) || 'false');
      if (keepBookShell) importChildren(document, usages, parsedUsages);
      else importChildren(document, book, parsedBook);
      book.setAttribute(BOOK_IDS_ATTRIBUTE, parsedBook.getAttribute(BOOK_IDS_ATTRIBUTE) || '');
      return {
        primaryImage: assetViewerPrimaryImageState(document),
        previousPrimaryImage,
        bookSectionReplaced: !keepBookShell,
      };
    },
  };
}

function elementChildren(node) {
  return Array.from(node?.childNodes || []).filter((child) => child?.tagName);
}

function hasClass(node, name) {
  return String(node?.getAttribute?.('class') || '').split(/\s+/).includes(name);
}

function isNavLink(node) {
  return node?.tagName === 'A' && NAV_CLASSES.some((name) => hasClass(node, name));
}

function navLink(host, name) {
  return elementChildren(host).find((child) => child.tagName === 'A' && hasClass(child, name)) || null;
}

function mediaChildren(host) {
  return elementChildren(host).filter((child) => !isNavLink(child));
}

// What kind of media the host renders: the same kind is updated in place, a
// different one is rebuilt. Static notices compare by their whole markup.
function mediaSignature(host) {
  return mediaChildren(host).map((child) => {
    if (child.tagName === 'FIGURE' && child.hasAttribute('data-preview-enhancement')) {
      const link = child.querySelector('a.asset-preview-link');
      return `image|${child.getAttribute('class') || ''}|${link ? 'link' : 'nolink'}`;
    }
    if (child.tagName === 'FIGURE' && child.hasAttribute('data-asset-video-playback')) return 'video';
    if (child.tagName === 'NOSCRIPT') return 'noscript';
    return `static|${child.outerHTML ?? child.textContent ?? ''}`;
  }).join('\n');
}

function syncAttribute(target, source, name) {
  if (!target || !source) return false;
  const next = source.getAttribute(name);
  if (target.getAttribute(name) === next) return false;
  if (next === null) target.removeAttribute(name);
  else target.setAttribute(name, next);
  return true;
}

// Same kind of media: only the attributes the server renders from the file's
// name and path change. A new preview URL loads into the same <img>, and its
// load/error result reaches the frame's preview state as it does on page load.
function updateMediaInPlace(host, parsedHost) {
  const changes = [];
  const figure = host.querySelector('figure[data-preview-enhancement]');
  const parsedFigure = parsedHost.querySelector('figure[data-preview-enhancement]');
  if (figure && parsedFigure) {
    const image = figure.querySelector('img[data-preview-image]');
    const parsedImage = parsedFigure.querySelector('img[data-preview-image]');
    // An image that failed is hidden behind its fallback: rebuilt instead, so
    // the new URL gets a fresh preview state.
    if (image && parsedImage && image.getAttribute('src') !== parsedImage.getAttribute('src')
      && figure.getAttribute('data-preview-state') === 'failed') {
      return { replace: true, changes };
    }
    syncAttribute(image, parsedImage, 'alt');
    const link = figure.querySelector('a.asset-preview-link');
    const parsedLink = parsedFigure.querySelector('a.asset-preview-link');
    if (syncAttribute(link, parsedLink, 'href')) changes.push('original');
    syncAttribute(link, parsedLink, 'aria-label');
    if (image && parsedImage && image.getAttribute('src') !== parsedImage.getAttribute('src')) {
      image.addEventListener?.('load', () => { if (figure.isConnected !== false) markPreviewLoaded(figure); }, { once: true });
      image.addEventListener?.('error', () => { if (figure.isConnected !== false) markPreviewFailed(figure); }, { once: true });
      image.setAttribute('src', parsedImage.getAttribute('src'));
      changes.push('preview');
    }
  }
  // Only a changed URL is set: setting it reloads the player.
  const video = host.querySelector('video[data-asset-video]');
  const parsedVideo = parsedHost.querySelector('video[data-asset-video]');
  if (syncAttribute(video, parsedVideo, 'src')) changes.push('video');
  return { replace: false, changes };
}

function replaceMedia(document, host, parsedHost) {
  const firstNav = elementChildren(host).find(isNavLink) || null;
  // Text between elements (template whitespace) goes too, so nothing piles up.
  Array.from(host.childNodes || []).filter((node) => !isNavLink(node)).forEach((node) => node.remove?.());
  mediaChildren(parsedHost).forEach((child) => {
    const node = document.importNode(child, true);
    if (firstNav && typeof host.insertBefore === 'function') host.insertBefore(node, firstNav);
    else host.appendChild(node);
  });
  enhancePreviewMedia(host);
  enhanceVideoPlayback(host);
}

// Previous/Next sit after the media, previous first. A link in both renders
// keeps its element (and any focus on it); only its href changes.
function syncNavigation(document, host, parsedHost) {
  let removedFocus = false;
  NAV_CLASSES.forEach((name, index) => {
    const current = navLink(host, name);
    const parsed = navLink(parsedHost, name);
    if (current && parsed) {
      syncAttribute(current, parsed, 'href');
      return;
    }
    if (current) {
      if (document.activeElement === current) removedFocus = true;
      current.remove();
      return;
    }
    if (!parsed) return;
    const node = document.importNode(parsed, true);
    const following = index === 0 ? navLink(host, NAV_CLASSES[1]) : null;
    if (following && typeof host.insertBefore === 'function') host.insertBefore(node, following);
    else host.appendChild(node);
  });
  return removedFocus;
}

// The file's name and location, wherever the page renders them. The media
// host keeps its element (asset identity) and its media element whenever the
// kind of media is unchanged.
function planFile(document, parsed) {
  const current = readIdentity(document);
  const parsedIdentity = readIdentity(parsed);
  const notice = document.querySelector(FILTER_NOTICE_REGION_SELECTOR);
  const parsedNotice = parsed.querySelector(FILTER_NOTICE_REGION_SELECTOR);
  const summary = document.querySelector(FILE_SUMMARY_REGION_SELECTOR);
  const parsedSummary = parsed.querySelector(FILE_SUMMARY_REGION_SELECTOR);
  const details = document.querySelector(FILE_DETAILS_REGION_SELECTOR);
  const parsedDetails = parsed.querySelector(FILE_DETAILS_REGION_SELECTOR);
  if (!current || !parsedIdentity || !notice || !parsedNotice || !summary || !parsedSummary || !details || !parsedDetails) {
    return null;
  }
  return {
    // These regions hold no focusable content; a removed Previous/Next link
    // inside the media host hands its focus to the Preview heading below.
    regions: [notice, summary, details],
    apply() {
      const previousFile = assetViewerFileState(document);
      const host = current.host;
      const parsedHost = parsedIdentity.host;

      if (typeof parsed.title === 'string' && parsed.title) document.title = parsed.title;
      importChildren(document, notice, parsedNotice);
      notice.setAttribute(FILTERED_OUT_ATTRIBUTE, parsedNotice.getAttribute(FILTERED_OUT_ATTRIBUTE) || 'false');
      importChildren(document, summary, parsedSummary);
      FILE_IDENTITY_ATTRIBUTES.forEach((name) => syncAttribute(summary, parsedSummary, name));
      importChildren(document, details, parsedDetails);

      syncAttribute(document.querySelector(BACK_LINK_SELECTOR), parsed.querySelector(BACK_LINK_SELECTOR), 'href');
      syncAttribute(document.querySelector(OPEN_LOCALLY_SELECTOR), parsed.querySelector(OPEN_LOCALLY_SELECTOR), 'href');

      let mediaReplaced = false;
      let mediaChanges = [];
      const update = mediaSignature(host) === mediaSignature(parsedHost)
        ? updateMediaInPlace(host, parsedHost)
        : { replace: true, changes: [] };
      if (update.replace) {
        replaceMedia(document, host, parsedHost);
        mediaReplaced = true;
      } else {
        mediaChanges = update.changes;
      }
      if (syncNavigation(document, host, parsedHost)) {
        const heading = document.querySelector(PREVIEW_HEADING_SELECTOR);
        if (heading && !heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
        heading?.focus?.({ preventScroll: true });
      }

      // The saved baselines only: the caller owns the controls' values.
      const rename = document.querySelector(RENAME_INPUT_SELECTOR);
      const parsedRename = parsed.querySelector(RENAME_INPUT_SELECTOR);
      if (rename && parsedRename?.hasAttribute(CONFIRMED_VALUE_ATTRIBUTE)) syncAttribute(rename, parsedRename, CONFIRMED_VALUE_ATTRIBUTE);
      const move = document.querySelector(MOVE_SELECT_SELECTOR);
      const parsedMove = parsed.querySelector(MOVE_SELECT_SELECTOR);
      if (move && parsedMove?.hasAttribute(CONFIRMED_VALUE_ATTRIBUTE)) syncAttribute(move, parsedMove, CONFIRMED_VALUE_ATTRIBUTE);
      // The reviewed state now shown. A server render without the field (no
      // Delete form) clears it, so a stale value can never be submitted.
      const review = document.querySelector(DELETE_REVIEW_SELECTOR);
      if (review) review.setAttribute('value', parsed.querySelector(DELETE_REVIEW_SELECTOR)?.getAttribute('value') || '');
      // F2B: likewise the Rename and Move forms' reviewed state, so a later
      // Rename or Move is made against what the page now shows. A request
      // already sent keeps the value it captured at submission.
      const fileReview = parsed.querySelector(FILE_REVIEW_SELECTOR)?.getAttribute('value') || '';
      Array.from(document.querySelectorAll(FILE_REVIEW_SELECTOR)).forEach((input) => input.setAttribute('value', fileReview));

      return {
        file: assetViewerFileState(document),
        previousFile,
        mediaReplaced,
        mediaChanges,
      };
    },
  };
}

const PLANNERS = {
  [ASSET_VIEWER_REFRESH_REGIONS.TAGS]: planTags,
  [ASSET_VIEWER_REFRESH_REGIONS.PRIMARY_IMAGE]: planPrimaryImage,
  [ASSET_VIEWER_REFRESH_REGIONS.FILE]: planFile,
};

// All or nothing: every region is checked before any is replaced. Focus inside
// a replaced region moves to the first control of its replacement (or of the
// enclosing region, or the dialog's close control), never to the body.
function install(document, parsed, regions) {
  const plans = regions.map((region) => PLANNERS[region](document, parsed));
  if (plans.some((plan) => !plan)) return null;

  const focused = document.activeElement;
  const focusRegion = plans.flatMap((plan) => plan.regions).find((region) => region !== focused && region.contains?.(focused));
  const focusFallbacks = focusRegion
    ? [...plans.flatMap((plan) => plan.fallbacks || []).filter((region) => region.contains?.(focusRegion)), focusRegion]
    : [];
  const dialog = focusRegion?.closest?.('dialog');

  const result = {};
  plans.forEach((plan) => Object.assign(result, plan.apply()));

  if (focusRegion && !focused.isConnected) {
    // The section's heading, not its first control: the replacement control
    // is often the opposite action (Set → Remove) or the next Book's Remove,
    // which a repeated Enter would otherwise trigger.
    const heading = [focusRegion, ...focusFallbacks]
      .map((region) => region.querySelector?.('h3') || region.closest?.('section')?.querySelector?.('h3'))
      .find((node) => node?.isConnected);
    if (heading && !heading.hasAttribute?.('tabindex')) heading.setAttribute('tabindex', '-1');
    const target = heading
      || firstFocusable(focusRegion)
      || focusFallbacks.map(firstFocusable).find(Boolean)
      || dialog?.querySelector?.('[data-dialog-close]');
    target?.focus?.({ preventScroll: true });
  }
  return result;
}

function normalizeRegions(requested) {
  const names = Array.isArray(requested) && requested.length > 0 ? requested : [ASSET_VIEWER_REFRESH_REGIONS.TAGS];
  return names.filter((name) => Object.hasOwn(PLANNERS, name));
}

/**
 * Re-read the Asset detail page and install its asset-dependent regions.
 *
 * @param {Document} document  The mounted Asset detail document.
 * @param {{
 *   projectId?: number|string,
 *   assetId?: number|string,
 *   regions?: Array<'tags'|'primary-image'|'file'>,  // default ['tags']
 * }} [expected]
 *   The identity the caller's change applied to; a document showing another
 *   asset is left alone (`unavailable`). Regions owed by an earlier superseded
 *   or failed refresh are installed as well.
 * @returns {Promise<{
 *   status: 'installed'|'failed'|'superseded'|'missing'|'unavailable',
 *   // installed, when 'tags' was installed:
 *   confirmedTagIds?: string[]|null,          // the server's saved tag IDs
 *                                              // (null when it rendered no tag form)
 *   previousConfirmedTagIds?: string[],       // the baseline it replaced
 *   // installed, when 'primary-image' was installed:
 *   primaryImage?: { projectSelected: boolean, bookIds: string[] },   // as saved now
 *   previousPrimaryImage?: { projectSelected: boolean, bookIds: string[] } | null,
 *   bookSectionReplaced?: boolean,            // the Book section (with its Set form) was rebuilt
 *   // installed, when 'file' was installed:
 *   file?: { filename, destination, categoryLabel, filteredOut },   // as saved now
 *   previousFile?: { filename, destination, categoryLabel, filteredOut } | null,
 *   mediaReplaced?: boolean,                  // the media's kind changed, so it was rebuilt
 *   mediaChanges?: string[],                  // in-place updates: 'preview'|'original'|'video'
 *   httpStatus?: number,                      // failed/missing, when a response arrived
 * }>}
 *   Never rejects. `installed` is reported only after every region is in place.
 */
export function refreshAssetViewer(document, expected = {}) {
  const current = readIdentity(document);
  const windowObject = document?.defaultView || globalThis;
  if (!current
    || assetViewerRetired(document)
    || (expected.projectId != null && String(expected.projectId) !== current.projectId)
    || (expected.assetId != null && String(expected.assetId) !== current.assetId)
    || typeof windowObject.fetch !== 'function'
    || typeof windowObject.DOMParser !== 'function') {
    return Promise.resolve({ status: ASSET_VIEWER_REFRESH_STATUS.UNAVAILABLE });
  }

  const state = refreshState(document);
  normalizeRegions(expected.regions).forEach((region) => state.owed.add(region));
  const regions = REGION_ORDER.filter((region) => state.owed.has(region));
  state.generation += 1;
  const generation = state.generation;
  const superseded = () => generation !== state.generation || Boolean(state.retired);
  let httpStatus;

  return Promise.resolve()
    .then(() => windowObject.fetch(windowObject.location.href, {
      method: 'GET',
      credentials: 'same-origin',
      redirect: 'follow',
      cache: 'no-store',
      headers: { Accept: 'text/html' },
    }))
    .then((response) => {
      httpStatus = response?.status;
      if (superseded()) return { status: ASSET_VIEWER_REFRESH_STATUS.SUPERSEDED };
      if (response?.status === 404) return { status: ASSET_VIEWER_REFRESH_STATUS.MISSING, httpStatus };
      if (!response?.ok || typeof response.text !== 'function') {
        return { status: ASSET_VIEWER_REFRESH_STATUS.FAILED, httpStatus };
      }
      return response.text().then((html) => {
        if (superseded()) return { status: ASSET_VIEWER_REFRESH_STATUS.SUPERSEDED };
        // The host may have been torn down while the GET was out.
        if (!current.host.isConnected) return { status: ASSET_VIEWER_REFRESH_STATUS.UNAVAILABLE };
        const parsed = new windowObject.DOMParser().parseFromString(html, 'text/html');
        const parsedIdentity = readIdentity(parsed);
        // A sign-in page, an error page or another asset is never installed.
        if (!parsedIdentity
          || parsedIdentity.projectId !== current.projectId
          || parsedIdentity.assetId !== current.assetId) {
          return { status: ASSET_VIEWER_REFRESH_STATUS.FAILED, httpStatus };
        }
        const installed = install(document, parsed, regions);
        if (!installed) return { status: ASSET_VIEWER_REFRESH_STATUS.FAILED, httpStatus };
        regions.forEach((region) => state.owed.delete(region));
        return { status: ASSET_VIEWER_REFRESH_STATUS.INSTALLED, ...installed };
      });
    })
    .catch(() => (superseded()
      ? { status: ASSET_VIEWER_REFRESH_STATUS.SUPERSEDED }
      : { status: ASSET_VIEWER_REFRESH_STATUS.FAILED, ...(httpStatus ? { httpStatus } : {}) }));
}
