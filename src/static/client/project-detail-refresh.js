import { isEnhancementBound, markEnhancementBound, liveRegionWindow } from './dom.js';
import { enhancePreviewMedia } from './preview.js';
import { PROJECT_ARCHIVED_EVENT, PROJECT_DELETED_EVENT, PROJECT_EDIT_SAVED_EVENT } from './project-edit-dialog.js';
import { removeStatusRetry, showStatusRetry } from './status-retry.js';
import { NOTE_CREATE_COMMITTED_EVENT, NOTE_EDIT_COMMITTED_EVENT, NOTE_EDIT_RECONCILED_EVENT } from './chapter-dialogs.js';
import { enhanceProjectRelatedNotes, projectRelatedNoteExpansion } from './project-related-notes.js';
import { enhanceNotesCodeBlocks } from './notes-editor.js';
import { RELATED_NOTES_ORDER_SAVED_EVENT } from './project-related-notes-order.js';
import { projectRelatedNoteAssetFocus, reconcileProjectRelatedNotesViewer } from './project-detail-viewer.js';

// Project Detail refreshes in place after an Edit Project save: the page is
// fetched again with a GET and each server-rendered region whose content
// depends on editable project fields (data-project-detail-region) is replaced
// from that render, together with the page heading and document title. The
// Releases section, the dialogs and the dialog feedback notice sit outside
// every region and are never replaced. Scroll position and focus are kept.
// An Archive in place (project-archive.js) refreshes the same way, and the
// archived heading, notice and release actions are regions too, so the page
// shows the archived project's read-only state without being replaced.
// A Delete (project-delete.js) leaves nothing to refresh: that module retires
// the page, and this one supersedes any refresh still in flight, so a late
// answer neither installs regions nor reports into the retired page.
//
// Related Notes (WP5) is the "related-notes" region: the wrapper and (WP6.5)
// its section, heading and Create new note are always rendered, so empty and
// populated renders replace each other. A confirmed save or Move of a Related
// Notes Page (NOTE_EDIT_COMMITTED_EVENT, from the Notes Edit Page dialog
// mounted outside every region), or a confirmed Create Note for this project
// (NOTE_CREATE_COMMITTED_EVENT, from the Create Note dialog in the same host),
// runs this same refresh, so one GET brings every region up to date and the newest refresh of
// any kind supersedes the older ones. Each replacement keeps the current
// disclosure expansion of the notes that survive (project-related-notes.js) and
// binds the new cards; pins are only read. A render whose Notes read failed is
// installed as its inline notice by a project refresh, but a note refresh
// keeps the cards on show and reports that they could not be updated.
// F2: a save whose answer was lost, but whose following read showed the server
// holds exactly that draft (NOTE_EDIT_RECONCILED_EVENT), runs the same note
// refresh. It is not a confirmed save: the dialog keeps its own message, and
// nothing here says the Page was saved.
const PAGE_SELECTOR = '[data-project-detail]';
const REGION_SELECTOR = '[data-project-detail-region]';
const STATE_KEY = '__creatorCrateProjectDetailRefresh';
const BOUND_KEY = 'projectDetailRefreshBound';
const RETRY_KEY = 'retryButton';
const REFRESH_MESSAGE_ATTRIBUTE = 'data-project-detail-refresh-message';
// Deep-link and notice markers apply to the first render only; a refresh
// must never carry them into the regions it adopts.
const ONE_SHOT_PARAMS = ['edit', 'returnTo', 'notice'];
const FOCUSABLE_SELECTOR = 'a[href], button, input, select, textarea, summary, [tabindex]';
const RELATED_NOTES_REGION = 'related-notes';
const RELATED_NOTES_UNAVAILABLE = '[data-project-related-notes-state="unavailable"]';
const RELATED_NOTES_HEADING_ID = 'project-related-notes-heading';
const NOTE_EDITOR_HOST_SELECTOR = '[data-project-related-note-editor]';
const NOTE_CREATE_DIALOG_ID = 'project-note-create-dialog';
const NOTE_CREATE_SELECTOR = '[data-project-related-notes-region] [data-project-related-note-create]';
const CANONICAL_ID = /^[1-9]\d*$/;
// A Related Notes control is the same control in a replacement when it names
// the same note (Create new note names none: its value is empty).
const RELATED_NOTE_CONTROLS = [
  'data-project-related-note-edit',
  'data-project-related-note-pin',
  'data-project-related-note-disclosure',
  'data-project-related-note-create',
];

const SAVED_MESSAGE = 'Project updated.';
const REFRESHING_MESSAGE = 'Project saved. Refreshing Project Detail…';
const STALE_MESSAGE = 'Project saved, but Project Detail could not refresh. The information shown may be out of date.';
const SIGNED_OUT_MESSAGE = 'Project saved, but your CreatorCrate sign-in has expired, so Project Detail could not refresh. Sign in again, then retry.';
const SAVE_MESSAGES = Object.freeze({
  done: SAVED_MESSAGE,
  tone: 'success',
  refreshing: REFRESHING_MESSAGE,
  stale: STALE_MESSAGE,
  signedOut: SIGNED_OUT_MESSAGE,
  // Focus lost with a replaced control moves to its counterpart.
  focusMain: false,
});

function archiveMessages(detail) {
  const lead = typeof detail?.message === 'string' && detail.message ? detail.message : 'Project archived.';
  return {
    done: lead,
    // Only an Archive this page confirmed reads as a success.
    tone: detail?.confirmed === true ? 'success' : 'error',
    refreshing: `${lead} Refreshing Project Detail…`,
    stale: `${lead} Project Detail could not refresh, so the information shown may be out of date.`,
    signedOut: `${lead} Your CreatorCrate sign-in has expired, so Project Detail could not refresh. Sign in again, then retry.`,
    // The archived project's Edit action is gone; a control in its place
    // (by position) is not what the user was on, so focus goes to the page.
    focusMain: true,
  };
}

// The Notes binder has already said the Page was saved or moved (and keeps its
// own read and Retry for the dialog's state), so a refreshed page adds nothing
// and a stale one adds a note of its own beside that message.
const NOTE_MESSAGES = Object.freeze({
  done: null,
  append: true,
  retryAttribute: 'data-project-related-notes-refresh-retry',
  refreshing: 'Refreshing Related Notes…',
  stale: 'Related Notes could not be updated, so they may be out of date.',
  signedOut: 'Your CreatorCrate sign-in has expired, so Related Notes could not be updated. Sign in again, then retry.',
  focusMain: false,
  requireRelatedNotes: true,
});

// The Create Note binder has already said the Note was created (with its View
// Note link); a refresh that fails adds the same note and Retry as a save's.
// After a Retry that held focus: Create new note, else the section; the new
// note never takes focus.
function createMessages() {
  return {
    ...NOTE_MESSAGES,
    focusResult: (document) => {
      const create = document.querySelector(NOTE_CREATE_SELECTOR);
      const region = document.querySelector('[data-project-related-notes-region]');
      return (focusable(create) && create) || (region && relatedNotesFallback(region)) || null;
    },
  };
}

// WP7.3: the Reorder Notes dialog has already said the order was saved and
// moved the cards; a failed reconciliation adds the same note and GET-only
// Retry. After a Retry that held focus: Reorder Notes, else the section.
function orderMessages() {
  return {
    ...NOTE_MESSAGES,
    focusResult: (document) => {
      const reorder = document.querySelector('[data-project-related-notes-region] [data-project-related-notes-reorder]');
      const region = document.querySelector('[data-project-related-notes-region]');
      return (focusable(reorder) && !reorder.disabled && reorder) || (region && relatedNotesFallback(region)) || null;
    },
  };
}

// After a Retry that held focus: the saved note's Edit, else the section.
function noteMessages(noteId) {
  return {
    ...NOTE_MESSAGES,
    focusResult: (document) => {
      const region = document.querySelector('[data-project-related-notes-region]');
      const edit = region?.querySelector(`[data-project-related-note-edit="${noteId}"]`);
      return (focusable(edit) && edit) || (region && relatedNotesFallback(region)) || null;
    },
  };
}

// tone: 'success', 'error' or 'pending' (neither). The message is an element
// of its own (F1), so a refresh can tell later that the text on show is still
// what it wrote: any other operation's write replaces the text, and it with it.
// Returns that element; a Retry mounted inside it goes with it (F2).
function setFeedback(document, message, tone = 'success') {
  const notice = document.querySelector('[data-dialog-feedback]');
  const text = notice?.querySelector('[data-dialog-feedback-text]');
  if (!notice || !text) return null;
  notice.classList.toggle('notice--error', tone === 'error');
  notice.classList.toggle('notice--success', tone === 'success');
  const owned = document.createElement('span');
  owned.setAttribute(REFRESH_MESSAGE_ATTRIBUTE, '');
  owned.textContent = message;
  text.replaceChildren(owned);
  notice.hidden = false;
  return owned;
}

function feedbackText(document) {
  return document.querySelector('[data-dialog-feedback] [data-dialog-feedback-text]');
}

// F2: what the notice held when a save's or Archive's refresh began. That
// refresh may replace it; anything another operation writes later (a Notes
// editor that could not open, say) is newer than the refresh and is not its.
function feedbackBasis(document) {
  return new Set(feedbackText(document)?.childNodes || []);
}

// True while everything in the notice is from that basis or a refresh
// message of this page's own (a stale message, a return refresh's note).
function holdsNothingNewer(document, basis) {
  const text = feedbackText(document);
  if (!text) return false;
  return Array.from(text.childNodes).every((node) => basis.has(node)
    || (node.nodeType === 1 && (node.hasAttribute(REFRESH_MESSAGE_ATTRIBUTE)
      || node.hasAttribute('data-project-related-notes-refresh-note')))
    || (node.nodeType === 3 && !node.textContent.trim()));
}

// F2: a save's or Archive's refresh message. While the notice holds nothing
// newer than the refresh it replaces the notice (setFeedback). Otherwise the
// newer message stays and this one goes beside it, in place of any earlier
// message of its own, so failures never pile up. Returns the message element.
function setRefreshFeedback(document, message, tone, replace) {
  const notice = document.querySelector('[data-dialog-feedback]');
  const text = notice?.querySelector('[data-dialog-feedback-text]');
  if (!notice || !text) return null;
  if (replace || notice.hidden || !text.textContent.trim()) return setFeedback(document, message, tone);
  text.querySelectorAll(`[${REFRESH_MESSAGE_ATTRIBUTE}]`).forEach((element) => element.remove());
  if (tone === 'error') {
    notice.classList.remove('notice--success', 'notice--warning');
    notice.classList.add('notice--error');
  }
  const owned = document.createElement('span');
  owned.setAttribute(REFRESH_MESSAGE_ATTRIBUTE, '');
  owned.textContent = ` ${message} `;
  text.append(owned);
  notice.hidden = false;
  return owned;
}

// A note of its own after whatever the notice already says, so the save's
// message, its Dismiss and the dialog's own refresh note and Retry stay. An
// empty message removes it. Returns the element a Retry follows.
function setAppendedFeedback(document, message) {
  const notice = document.querySelector('[data-dialog-feedback]');
  const text = notice?.querySelector('[data-dialog-feedback-text]');
  let note = text?.querySelector('[data-project-related-notes-refresh-note]');
  if (!message) {
    note?.remove();
    return null;
  }
  if (!notice || !text) return null;
  if (!note) {
    // A notice not on show holds nothing current (a reconciled save's refresh
    // has no save message before it), so the note stands alone.
    if (notice.hidden) {
      text.textContent = '';
      notice.classList.remove('notice--success', 'notice--warning');
      notice.classList.add('notice--error');
    }
    note = document.createElement('span');
    note.setAttribute('data-project-related-notes-refresh-note', '');
    text.append(note);
  }
  note.textContent = ` ${message} `;
  notice.hidden = false;
  return text;
}


function refreshUrl(windowObject, projectId) {
  const current = new URL(windowObject.location.href);
  const url = new URL(`/projects/${projectId}`, current.origin);
  current.searchParams.forEach((value, name) => {
    if (!ONE_SHOT_PARAMS.includes(name)) url.searchParams.append(name, value);
  });
  return url;
}

function regionsByName(root) {
  const regions = new Map();
  root.querySelectorAll(REGION_SELECTOR).forEach((region) => {
    const name = region.getAttribute('data-project-detail-region');
    regions.set(name, regions.has(name) ? null : region);
  });
  return regions;
}

// Focus inside a replaced region moves to the same control in its
// replacement: by id, then link target, then position.
function focusCounterpart(oldRegion, newRegion, active) {
  const escape = globalThis.CSS?.escape || ((value) => value);
  let target = null;
  if (active.id) target = newRegion.querySelector(`#${escape(active.id)}`);
  const control = RELATED_NOTE_CONTROLS.find((name) => active.hasAttribute?.(name));
  if (!target && control) {
    // The note's control, or nothing: another note's is not what the user was on.
    return newRegion.querySelector(`[${control}="${escape(active.getAttribute(control))}"]`);
  }
  if (!target && active.getAttribute('href')) {
    target = newRegion.querySelector(`[href="${escape(active.getAttribute('href'))}"]`);
  }
  if (!target) {
    const index = Array.from(oldRegion.querySelectorAll(FOCUSABLE_SELECTOR)).indexOf(active);
    target = index >= 0 ? newRegion.querySelectorAll(FOCUSABLE_SELECTOR)[index] : null;
  }
  return target;
}

// Focus never goes to a control a collapsed preview or other hidden part holds.
function focusable(element) {
  return Boolean(element?.isConnected && !element.closest('[hidden]'));
}

// Where focus goes when its control left Related Notes with its note: the
// section's heading (always rendered since WP6.5), else the page.
function relatedNotesFallback(region) {
  const heading = region.querySelector(`#${RELATED_NOTES_HEADING_ID}`);
  if (!heading) return null;
  if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
  return heading;
}

// The Notes Edit Page or Create Note dialog sits outside every region, but the
// Edit or Create new note that opened it may have been replaced (a refresh after a Move, or one landing as a
// save closes it). Its focus then returns to the same note's Edit, or, with
// that note gone from Related Notes, to their heading or the page.
function keepNoteEditorOpener(document) {
  const dialog = document.querySelector(NOTE_EDITOR_HOST_SELECTOR)?.querySelector('dialog');
  const state = dialog?.__creatorCrateAppDialogState;
  const opener = state?.opener;
  if (!opener || opener.isConnected) return;
  const control = RELATED_NOTE_CONTROLS.find((name) => opener.hasAttribute?.(name));
  const counterpart = control
    ? document.querySelector(`[data-project-related-notes-region] [${control}="${opener.getAttribute(control)}"]`)
    : null;
  const region = document.querySelector('[data-project-related-notes-region]');
  state.opener = (focusable(counterpart) && counterpart)
    || (region && relatedNotesFallback(region))
    || document.getElementById('main-content');
}

// WP7.1: a return refresh can land while another page dialog is open (Edit
// Project, opened without an opener fallback). If its opener was replaced,
// dismissal returns to the same action in the replacement (by project or id),
// else to the page, never to a detached control.
function keepDialogOpeners(document) {
  keepNoteEditorOpener(document);
  const escape = globalThis.CSS?.escape || ((value) => value);
  document.querySelectorAll('dialog[open]').forEach((dialog) => {
    if (dialog.closest(NOTE_EDITOR_HOST_SELECTOR)) return;
    const state = dialog.__creatorCrateAppDialogState;
    const opener = state?.opener;
    if (!opener || opener.isConnected) return;
    let counterpart = null;
    if (opener.closest?.('[data-project-related-note-asset]')) {
      // WP7.4: a Related Notes asset control that opened the unified viewer or
      // the video preview: the same note's control for that asset, else the
      // note or the section (null leaves the viewer its own fallback).
      counterpart = projectRelatedNoteAssetFocus(document, opener);
      if (!counterpart) return;
    } else if (opener.hasAttribute?.('data-project-edit-id')) {
      counterpart = document.querySelector(`[data-project-edit-id="${escape(opener.getAttribute('data-project-edit-id'))}"]`);
    } else if (opener.id) {
      counterpart = document.getElementById(opener.id);
    }
    state.opener = (focusable(counterpart) && counterpart) || document.getElementById('main-content');
  });
}

function applyRefresh(document, parsed, projectId, { focusMain = false, requireRelatedNotes = false } = {}) {
  const page = document.querySelector(PAGE_SELECTOR);
  const nextPage = parsed.querySelector(PAGE_SELECTOR);
  if (!page || nextPage?.getAttribute('data-project-detail') !== projectId) return false;
  const current = regionsByName(document);
  const next = regionsByName(parsed);
  // Every region must be found exactly once on both sides before anything is
  // replaced, so a refresh never leaves a mix of old and new regions.
  if (current.size === 0 || [...current].some(([name, region]) => !region || !next.get(name))) return false;
  // A note refresh exists to show Related Notes; a render whose Notes read
  // failed has none to show, so the cards on show stay and the refresh fails.
  if (requireRelatedNotes && (!current.has(RELATED_NOTES_REGION)
    || next.get(RELATED_NOTES_REGION).querySelector(RELATED_NOTES_UNAVAILABLE))) return false;

  const windowObject = liveRegionWindow(document);
  const scrollX = windowObject.scrollX;
  const scrollY = windowObject.scrollY;
  const active = document.activeElement;
  let focusTarget = null;
  let focusLost = false;

  current.forEach((region, name) => {
    const replacement = document.importNode(next.get(name), true);
    // Read before the cards go: surviving notes keep it, new ones start from
    // their pin, and removed ones are forgotten with their cards.
    const expansion = name === RELATED_NOTES_REGION ? projectRelatedNoteExpansion(region) : null;
    let lostHere = false;
    if (active && region.contains(active)) {
      focusTarget = focusMain && !active.id ? null : focusCounterpart(region, replacement, active);
      focusLost = true;
      lostHere = true;
    }
    region.replaceWith(replacement);
    enhancePreviewMedia(replacement);
    if (expansion) {
      // The full Page content carries the Notes code blocks' Copy control.
      enhanceNotesCodeBlocks(replacement);
      enhanceProjectRelatedNotes(replacement, { expansion });
      if (lostHere && !focusable(focusTarget)) focusTarget = relatedNotesFallback(replacement);
    }
  });

  // The heading and title carry the project title.
  const title = parsed.querySelector('title')?.textContent;
  if (title) document.title = title;
  for (const selector of ['.app-section-title', '.mobile-nav-section']) {
    const nextText = parsed.querySelector(selector)?.textContent;
    if (nextText) document.querySelectorAll(selector).forEach((element) => { element.textContent = nextText; });
  }

  if (focusLost) {
    (focusable(focusTarget) ? focusTarget : document.getElementById('main-content'))?.focus?.({ preventScroll: true });
  }
  keepDialogOpeners(document);
  // WP7.4: an open Related Notes viewer session follows the installed render
  // (a render whose Notes read failed is no evidence and changes nothing).
  if (current.has(RELATED_NOTES_REGION)) reconcileProjectRelatedNotesViewer(document);
  windowObject.scrollTo?.(scrollX, scrollY);
  return 'refreshed';
}

function refreshState(document) {
  document[STATE_KEY] ||= {
    generation: 0,
    abort: null,
    [RETRY_KEY]: null,
    current: null,
    // WP7.1 return refresh: the away/return latch, the return refresh in
    // flight, the message a save's failed refresh wrote (F1: the element, so
    // clearing it can tell whether it is still on show), and a deleted
    // (retired) page. An appended refresh note is known by its own attribute.
    away: false,
    returnRefresh: null,
    staleNotice: null,
    retired: false,
  };
  return document[STATE_KEY];
}

function signedOut(windowObject, response) {
  if (response.status === 401) return true;
  // An expired session answers an HTML GET with a redirect to sign-in.
  try {
    return response.redirected && new URL(response.url, windowObject.location.href).pathname === '/login';
  } catch {
    return false;
  }
}

/**
 * Fetches Project Detail again and replaces its project regions. Only a GET
 * is ever sent, so the save is never repeated. Each refresh supersedes any
 * older one still in flight, so a late response can never overwrite a newer
 * save. Resolves to 'refreshed', 'failed', 'signed-out' or 'superseded'.
 * With requireRelatedNotes, a render whose Related Notes could not be read
 * installs nothing and resolves to 'failed'.
 */
export function refreshProjectDetail(document, projectId, options = {}) {
  const state = refreshState(document);
  // The refresh in flight, so a return refresh can follow it (WP7.1).
  const run = fetchAndApply(document, projectId, options);
  state.current = run;
  run.then(() => { if (state.current === run) state.current = null; });
  return run;
}

async function fetchAndApply(document, projectId, { focusMain = false, requireRelatedNotes = false } = {}) {
  const state = refreshState(document);
  state.generation += 1;
  const generation = state.generation;
  state.abort?.abort();
  const windowObject = liveRegionWindow(document);
  const abort = typeof windowObject.AbortController === 'function' ? new windowObject.AbortController() : null;
  state.abort = abort;
  let outcome = 'failed';
  try {
    const response = await windowObject.fetch(refreshUrl(windowObject, projectId).href, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'text/html' },
      signal: abort?.signal,
    });
    const unauthenticated = signedOut(windowObject, response);
    const html = response.ok && !unauthenticated ? await response.text() : '';
    if (generation !== state.generation) return 'superseded';
    if (unauthenticated) outcome = 'signed-out';
    if (html) {
      const parsed = new windowObject.DOMParser().parseFromString(html, 'text/html');
      outcome = applyRefresh(document, parsed, projectId, { focusMain, requireRelatedNotes }) || 'failed';
    }
  } catch {
    if (generation !== state.generation) return 'superseded';
  }
  state.abort = null;
  return outcome;
}

async function refreshAfterSave(document, projectId, { focusResult = false, messages = SAVE_MESSAGES, basis = null } = {}) {
  const state = refreshState(document);
  removeStatusRetry(state, RETRY_KEY);
  // F2: a Retry keeps the basis of the save it retries, so a message written
  // after that save is never taken as the refresh's to replace.
  const feedbackFrom = messages.append ? null : (basis || feedbackBasis(document));
  const outcome = await refreshProjectDetail(document, projectId, {
    focusMain: messages.focusMain,
    requireRelatedNotes: messages.requireRelatedNotes === true,
  });
  // A newer save or retry owns the outcome now.
  if (outcome === 'superseded') return;
  // F2: false once another operation has written newer feedback.
  const replace = !messages.append && holdsNothingNewer(document, feedbackFrom);
  if (outcome === 'refreshed') {
    // F1: an appended note leaves the notice's other text alone, but every
    // refresh failure it shows (a save's, a return's) is resolved now.
    // F2: so does a save's refresh when newer feedback is on show: that
    // stays, and the older completion message is not written over it.
    if (messages.append || !replace) clearStaleNotice(document, state);
    else {
      state.staleNotice = null;
      setFeedback(document, messages.done, messages.tone);
    }
    if (focusResult) {
      (messages.focusResult?.(document)
        || document.querySelector(`[data-project-edit-id="${projectId}"]`)
        || document.getElementById('main-content'))?.focus?.();
    }
    return;
  }
  // The save itself succeeded: only the page is stale, so the retry repeats
  // the GET, never the save.
  const message = outcome === 'signed-out' ? messages.signedOut : messages.stale;
  // F1: an appended note is known by its attribute, so it never takes over
  // (and loses) a save's stale message that is still on show beside it.
  // F2: a save's stale message is its own element, written beside newer
  // feedback rather than over it, and its Retry is mounted inside it, so
  // whatever replaces or removes the message takes the Retry with it.
  const notice = messages.append
    ? setAppendedFeedback(document, message)
    : setRefreshFeedback(document, message, 'error', replace);
  if (notice && !messages.append) state.staleNotice = notice;
  const retry = notice ? showStatusRetry({
    state,
    status: notice,
    attribute: messages.retryAttribute || 'data-project-detail-refresh-retry',
    key: RETRY_KEY,
    onRetry: ({ wasFocused }) => {
      if (messages.append) setAppendedFeedback(document, messages.refreshing);
      else {
        state.staleNotice = setRefreshFeedback(document, messages.refreshing, 'pending',
          holdsNothingNewer(document, feedbackFrom));
      }
      return refreshAfterSave(document, projectId, { focusResult: wasFocused, messages, basis: feedbackFrom });
    },
  }) : null;
  if (focusResult) retry?.focus?.();
}

// WP7.1: a return refresh did not save, create or move anything, so it says
// nothing when it works; when it fails it adds a note beside whatever the
// notice already says, with the same GET-only Retry.
const RETURN_MESSAGES = Object.freeze({
  ...NOTE_MESSAGES,
  retryAttribute: 'data-project-detail-return-refresh-retry',
  refreshing: 'Checking Project Detail for changes…',
  stale: 'Project Detail could not check for changes, so Related Notes may be out of date.',
  signedOut: 'Your CreatorCrate sign-in has expired, so Project Detail could not check for changes. Sign in again, then retry.',
});

// Every refresh failure on show is out of date once a refresh installs,
// whichever refresh reported it (F1): the appended note, and a save's stale
// message while it is still the one on show. A message another operation has
// written since (an editor that could not open, a save, a creation) replaced
// that one, so it is not this refresh's to clear and stays; only a notice left
// holding nothing is hidden.
function clearStaleNotice(document, state) {
  const message = state.staleNotice;
  state.staleNotice = null;
  const notice = document.querySelector('[data-dialog-feedback]');
  const text = notice?.querySelector('[data-dialog-feedback-text]');
  if (!notice || !text) return;
  const note = text.querySelector('[data-project-related-notes-refresh-note]');
  const owned = message && text.contains(message) ? message : null;
  if (!note && !owned) return;
  note?.remove();
  owned?.remove();
  if (!text.textContent.trim()) notice.hidden = true;
}

/**
 * WP7.1: refreshes Project Detail when the user comes back to it (another
 * tab, another window, or a back-forward restoration), so Related Notes show
 * what was changed elsewhere. GET only, through refreshProjectDetail. A
 * refresh already in flight is followed, not superseded (it may be a save's,
 * which reports its own outcome); returns while this one runs fold into one
 * more GET; a newer save's refresh supersedes this one and reports instead.
 */
async function refreshOnReturn(document, projectId, { focusResult = false } = {}) {
  const state = refreshState(document);
  if (state.returnRefresh) {
    state.returnRefresh.again = true;
    return;
  }
  const run = { again: true };
  state.returnRefresh = run;
  let outcome = 'superseded';
  try {
    while (run.again) {
      run.again = false;
      while (state.current) await state.current;
      if (state.retired) return;
      removeStatusRetry(state, RETRY_KEY);
      outcome = await refreshProjectDetail(document, projectId, { requireRelatedNotes: true });
    }
  } finally {
    state.returnRefresh = null;
  }
  if (outcome === 'superseded' || state.retired) return;
  if (outcome === 'refreshed') {
    clearStaleNotice(document, state);
    if (focusResult) document.getElementById('main-content')?.focus?.({ preventScroll: true });
    return;
  }
  // The cards on show stay; only a GET is ever retried.
  // Beside whatever is on show; a save's stale message keeps its ownership.
  const notice = setAppendedFeedback(document, outcome === 'signed-out' ? RETURN_MESSAGES.signedOut : RETURN_MESSAGES.stale);
  const retry = notice ? showStatusRetry({
    state,
    status: notice,
    attribute: RETURN_MESSAGES.retryAttribute,
    key: RETRY_KEY,
    onRetry: ({ wasFocused }) => {
      setAppendedFeedback(document, RETURN_MESSAGES.refreshing);
      return refreshOnReturn(document, projectId, { focusResult: wasFocused });
    },
  }) : null;
  if (focusResult) retry?.focus?.();
}

// WP7.1, after Release Detail's companion return latch: leaving the page
// (window blur, hidden document, pagehide) arms it; the first focus, visible
// document or back-forward restoration after that refreshes once, and the
// others announcing the same return find it disarmed. Focus moving within the
// page (fields, buttons, dialogs) never blurs the window, so it never arms.
// Bound once per document; a back-forward restoration keeps the same document
// and so the same listeners.
function armReturnRefresh(document, onReturn) {
  const windowObject = liveRegionWindow(document);
  const state = refreshState(document);
  // A page first shown in a background tab is refreshed when it is first seen.
  state.away = document.visibilityState === 'hidden';
  const leave = () => { state.away = true; };
  const back = () => {
    if (!state.away || document.visibilityState === 'hidden') return;
    state.away = false;
    onReturn();
  };
  windowObject.addEventListener('blur', leave);
  windowObject.addEventListener('focus', back);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') leave();
    else back();
  });
  windowObject.addEventListener('pagehide', leave);
  windowObject.addEventListener('pageshow', (event) => {
    if (event.persisted) back();
  });
  // Back or Forward without the back-forward cache may load this document
  // from the HTTP cache (HTML is only no-store with sign-in enabled), showing
  // the render from before the user left: that load is a return too. A load
  // that came over the network is already current.
  if (loadedFromHistoryCache(windowObject) && document.visibilityState !== 'hidden') onReturn();
}

function loadedFromHistoryCache(windowObject) {
  try {
    const [entry] = windowObject.performance?.getEntriesByType?.('navigation') || [];
    return entry?.type === 'back_forward' && !(entry.transferSize > 0);
  } catch {
    return false;
  }
}

export function enhanceProjectDetailRefresh(scope = globalThis.document) {
  const document = scope?.nodeType === 9 ? scope : scope?.ownerDocument;
  const page = document?.querySelector?.(PAGE_SELECTOR);
  if (!page || isEnhancementBound(document.documentElement, BOUND_KEY)) return false;
  markEnhancementBound(document.documentElement, BOUND_KEY);
  document.addEventListener(PROJECT_EDIT_SAVED_EVENT, (event) => {
    // The page marker sits on a region, so it is read from the current one.
    const projectId = document.querySelector(PAGE_SELECTOR)?.getAttribute('data-project-detail');
    // Only a save of the project this page shows changes it.
    if (String(event.detail?.projectId) !== projectId) return;
    void refreshAfterSave(document, projectId);
  });
  document.addEventListener(PROJECT_ARCHIVED_EVENT, (event) => {
    const projectId = document.querySelector(PAGE_SELECTOR)?.getAttribute('data-project-detail');
    if (String(event.detail?.projectId) !== projectId) return;
    void refreshAfterSave(document, projectId, { messages: archiveMessages(event.detail) });
  });
  // Bubbles from the Notes Edit Page dialog mounted on this page once the Notes
  // binder has an acknowledged save (dialog closed) or Move (dialog open).
  // Refused, invalid and unconfirmed saves send nothing, so nothing refreshes.
  document.addEventListener(NOTE_EDIT_COMMITTED_EVENT, (event) => {
    if (!event.target?.closest?.(NOTE_EDITOR_HOST_SELECTOR)) return;
    if (event.detail?.kind !== 'saved' && event.detail?.kind !== 'moved') return;
    const noteId = String(event.detail?.noteId ?? '');
    if (!/^[1-9]\d*$/.test(noteId)) return;
    const projectId = document.querySelector(PAGE_SELECTOR)?.getAttribute('data-project-detail');
    if (!projectId) return;
    void refreshAfterSave(document, projectId, { messages: noteMessages(noteId) });
  });
  // Bubbles from that dialog, or from its host once it has been replaced, after
  // an unconfirmed save that the dialog's own read showed the server holds.
  // A failed or inconclusive read sends nothing, so nothing refreshes.
  document.addEventListener(NOTE_EDIT_RECONCILED_EVENT, (event) => {
    if (!event.target?.closest?.(NOTE_EDITOR_HOST_SELECTOR)) return;
    const noteId = String(event.detail?.noteId ?? '');
    if (!CANONICAL_ID.test(noteId)) return;
    const projectId = document.querySelector(PAGE_SELECTOR)?.getAttribute('data-project-detail');
    if (!projectId) return;
    void refreshAfterSave(document, projectId, { messages: noteMessages(noteId) });
  });
  // Bubbles from the Create Note dialog mounted on this page once the binder
  // has closed it after an acknowledged HTTP 201 naming the created Page and
  // this project. Refused, failed and unconfirmed creations, and dialogs
  // closed without one, send nothing, so nothing refreshes. Only a GET is sent.
  document.addEventListener(NOTE_CREATE_COMMITTED_EVENT, (event) => {
    const dialog = event.target;
    if (dialog?.id !== NOTE_CREATE_DIALOG_ID || !dialog.closest?.(NOTE_EDITOR_HOST_SELECTOR)) return;
    const noteId = String(event.detail?.noteId ?? '');
    const createdFor = String(event.detail?.projectId ?? '');
    if (!CANONICAL_ID.test(noteId) || !CANONICAL_ID.test(createdFor)) return;
    const projectId = document.querySelector(PAGE_SELECTOR)?.getAttribute('data-project-detail');
    if (createdFor !== projectId) return;
    void refreshAfterSave(document, projectId, { messages: createMessages() });
  });
  // WP7.3: bubbles from the Reorder Notes dialog once a Save was confirmed
  // (HTTP 200 naming this project) and the cards were moved into that order.
  // Refused, stale and unconfirmed Saves send nothing. Only a GET is sent.
  document.addEventListener(RELATED_NOTES_ORDER_SAVED_EVENT, (event) => {
    if (event.target?.id !== 'project-related-notes-order-dialog') return;
    const projectId = document.querySelector(PAGE_SELECTOR)?.getAttribute('data-project-detail');
    if (!projectId || String(event.detail?.projectId ?? '') !== projectId) return;
    void refreshAfterSave(document, projectId, { messages: orderMessages() });
  });
  document.addEventListener(PROJECT_DELETED_EVENT, (event) => {
    const projectId = document.querySelector(PAGE_SELECTOR)?.getAttribute('data-project-detail');
    if (String(event.detail?.projectId) !== projectId) return;
    const state = refreshState(document);
    state.generation += 1;
    state.abort?.abort();
    state.abort = null;
    state.retired = true;
    removeStatusRetry(state, RETRY_KEY);
  });
  armReturnRefresh(document, () => {
    const projectId = document.querySelector(PAGE_SELECTOR)?.getAttribute('data-project-detail');
    if (!projectId || refreshState(document).retired) return;
    void refreshOnReturn(document, projectId);
  });
  return true;
}
