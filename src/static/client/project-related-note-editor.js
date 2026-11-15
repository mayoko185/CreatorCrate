import { appDialogFeedback, appDialogOpenCount, enhanceAppDialogs, openAppDialogById } from './app-dialogs.js';
import { enhanceChapterDialogs } from './chapter-dialogs.js';
import { enhanceAppConfirmationControls } from './confirm-dialog.js';
import { isEnhancementBound, markEnhancementBound } from './dom.js';
import { enhanceDropdowns } from './dropdowns.js';
import { enhanceNoteConnections } from './note-connections.js';
import { enhanceNoteDialogUnsavedChanges, readNoteDialogBaseline } from './note-dialog-dirty.js';
import { enhanceNotesEditor } from './notes-editor.js';

// WP4: Edit on a Project Detail Related Notes card opens the Notes Edit Page
// dialog in place. Each Edit reads the Page's own render (GET /notes/:id),
// takes its closed #note-edit-dialog and mounts it in the page's
// [data-project-related-note-editor] host, then runs the enhancers the page
// bootstrap runs for it, in the same order. Save, Move, Delete, the editor and
// the unsaved-changes guard are the Notes ones, unchanged; chapter-dialogs.js
// only installs its post-save reads into the dialog here, since there is no
// Page Detail around it.
//
// WP6.4: Create Note is the host's second operation (openProjectRelatedNoteCreate).
// It reads GET /notes/projects/:projectId/new, mounts that closed
// #project-note-create-dialog in the same host, runs the same enhancers, and
// saves through the New Page lifecycle (chapter-dialogs.js).
//
// One editor is mounted at a time, whichever operation it is: both are the
// Notes form, with the same ids (#note-form, #note-projects-form,
// #note-assets-native). A settled one (closed, not saving, no outcome left to
// show) is replaced by the next Edit or Create; one that still holds something
// stays, and the other operation is refused until it has settled. Each load
// supersedes the one before it, whichever operation that was.
//
// WP6-F4: a Create Note whose outcome is unresolved (chapter-dialogs.js) may be
// closed without losing its draft, message or locked Save. Until reloaded, it
// stays mounted: the next Create new note reopens that same dialog (no read, no
// new form, no POST), and Edit is refused with a message saying so.
//
// Handoff (WP5): after an acknowledged save, once the binder has closed the
// dialog, and after an acknowledged Move (the dialog stays open), the dialog
// dispatches NOTE_EDIT_COMMITTED_EVENT (chapter-dialogs.js), bubbling through
// the host, with detail { kind: 'saved' | 'moved', noteId, payload }. Refused,
// invalid and unconfirmed saves dispatch nothing. A deleted Page leaves for
// its Book or Chapter with the Undo notice, as on Page Detail.
//
// Handoff (WP6.5): after an acknowledged create (HTTP 201), once the binder has
// closed the dialog, it dispatches NOTE_CREATE_COMMITTED_EVENT
// (chapter-dialogs.js), bubbling through the host, with detail
// { noteId, projectId, payload }. Nothing here refreshes Project Detail;
// project-detail-refresh.js listens for it. The section's "Create new note"
// control (data-project-related-note-create, always rendered in the Related
// Notes region) opens Create Note through the same click listener as Edit.
const EDIT_DIALOG_ID = 'note-edit-dialog';
const CREATE_DIALOG_ID = 'project-note-create-dialog';
const MOUNTED_DIALOG_SELECTOR = `#${EDIT_DIALOG_ID}, #${CREATE_DIALOG_ID}`;
const HOST_SELECTOR = '[data-project-related-note-editor]';
const PAGE_SELECTOR = '[data-project-detail]';
const TRIGGER_ATTRIBUTE = 'data-project-related-note-edit';
// The attribute a Create control on this page carries (WP6.5): a refresh that
// replaces the control while its dialog loads hands focus to its replacement.
const CREATE_TRIGGER_ATTRIBUTE = 'data-project-related-note-create';
const CREATE_KEY = 'create';
const NOTE_ID = /^[1-9]\d*$/;
const MISSING_MESSAGE = 'This Page is no longer available. It may have been deleted.';
const LOAD_FAILURE_MESSAGE = 'The Page editor could not be opened. Try again.';
const HELD_MESSAGE = 'Another Page’s change is still unconfirmed. Open that Page’s editor to check it before editing a different Page.';
const CREATE_HELD_MESSAGE = 'A Page’s change is still unconfirmed. Open that Page’s editor to check it before creating a Note.';
const EDIT_HELD_BY_CREATE_MESSAGE = 'A new Note is still being created. Wait for it to finish before editing a Page.';
const EDIT_HELD_BY_UNRESOLVED_CREATE_MESSAGE = 'A new Note’s creation could not be confirmed, and its draft is kept. Open Create new note to review it before editing a Page.';
const CREATE_MISSING_MESSAGE = 'This project is no longer available, so a Note cannot be created here.';
const CREATE_SIGNED_OUT_MESSAGE = 'Your CreatorCrate sign-in has expired, so Create Note could not be opened. Sign in again, then try again.';
const CREATE_LOAD_FAILURE_MESSAGE = 'Create Note could not be opened. Try again.';

function mountedDialog(ctrl) {
  return ctrl.host.querySelector(MOUNTED_DIALOG_SELECTOR);
}

// The Page an Edit dialog saves; a Create dialog has none.
function mountedNoteId(state) {
  if (state?.dialog?.id !== EDIT_DIALOG_ID) return null;
  return state.form?.getAttribute('action')?.split('/').pop() ?? null;
}

// Open, saving, or holding an outcome only it can show: a Delete in flight or
// unresolved, or a Move that could not be confirmed.
function editorHeld(state) {
  return Boolean(state) && Boolean(state.open || state.dialog.open || state.submitting
    || state.submitLocked?.() === true
    || state.dialog.querySelector('[data-page-move-check-retry]'));
}

// A Create Note kept with its unresolved outcome (WP6-F4): reopened, never replaced.
function unresolvedCreate(state) {
  return state?.dialog?.id === CREATE_DIALOG_ID && state.unresolvedOutcome === true && !state.submitting;
}

function heldMessage(state, wanted) {
  if (unresolvedCreate(state)) return EDIT_HELD_BY_UNRESOLVED_CREATE_MESSAGE;
  if (state.dialog.id === CREATE_DIALOG_ID) return EDIT_HELD_BY_CREATE_MESSAGE;
  return wanted === CREATE_KEY ? CREATE_HELD_MESSAGE : HELD_MESSAGE;
}

// The closed Edit Page dialog of exactly this Page, saving in place.
function editorFrom(parsed, noteId) {
  const dialog = parsed.getElementById(EDIT_DIALOG_ID);
  if (!dialog?.matches('dialog[data-app-dialog]') || dialog.hasAttribute('open')) return null;
  const form = dialog.querySelector('form#note-form[data-dialog-form][data-notes-editor-form][data-note-dialog-dirty]');
  if (form?.getAttribute('action') !== `/notes/${noteId}`
    || form.getAttribute('data-dialog-async') !== 'true'
    || !readNoteDialogBaseline(form)) return null;
  return dialog;
}

// The closed Create Note dialog of exactly this Project, creating in place: its
// one Notes form, its Note location, and nothing else beside it.
function creatorFrom(parsed, projectId) {
  const dialog = parsed.getElementById(CREATE_DIALOG_ID);
  if (!dialog?.matches('dialog[data-app-dialog]') || dialog.hasAttribute('open')) return null;
  if (parsed.querySelectorAll('#note-form').length !== 1 || parsed.getElementById(EDIT_DIALOG_ID)) return null;
  const form = dialog.querySelector('form#note-form[data-dialog-form][data-notes-editor-form][data-note-dialog-dirty]');
  if (form?.getAttribute('action') !== `/notes/projects/${projectId}`
    || form.getAttribute('method')?.toLowerCase() !== 'post'
    || form.getAttribute('data-dialog-async') !== 'true'
    || typeof readNoteDialogBaseline(form)?.targetContainer !== 'string'
    || !form.querySelector('[data-note-location]')) return null;
  return dialog;
}

function setBusy(trigger, busy) {
  if (busy) trigger?.setAttribute('aria-busy', 'true');
  else trigger?.removeAttribute('aria-busy');
}

// Toast UI relays its toolbar out on a 200 ms throttle when the dialog closes or
// leaves the page, and that late update fails on an editor already destroyed.
const EDITOR_RELEASE_DELAY_MS = 1000;

// Only what mounting added goes: the markup now, and the editor's own document
// listeners once its last toolbar update has run.
function unmount(dialog) {
  const editor = dialog.querySelector('[data-notes-editor-form]')?.__creatorCrateNotesEditor;
  dialog.remove();
  if (editor?.destroy) (dialog.ownerDocument.defaultView || globalThis).setTimeout(() => editor.destroy(), EDITOR_RELEASE_DELAY_MS);
}

function mount(ctrl, source, trigger) {
  const { document } = ctrl;
  const previous = mountedDialog(ctrl);
  if (previous) unmount(previous);
  const dialog = document.importNode(source, true);
  ctrl.host.append(dialog);
  // As the page bootstrap runs them; the guard replaces the binder's close check.
  enhanceNotesEditor(dialog);
  enhanceNoteConnections(dialog);
  // Dropdowns delegate from the scope they were enhanced with: the document, as
  // the bootstrap does, so no second set of listeners handles the same events.
  enhanceDropdowns(document);
  enhanceAppDialogs(document);
  enhanceChapterDialogs(document);
  enhanceNoteDialogUnsavedChanges(dialog);
  enhanceAppConfirmationControls(dialog);
  if (!openAppDialogById(document, source.id, trigger)) {
    unmount(dialog);
    return false;
  }
  return true;
}

// Focus stays on the control that was used, so trying again is one more press.
function fail(ctrl, message) {
  appDialogFeedback(ctrl.document, message, true);
}

function currentProjectId(document) {
  const projectId = document.querySelector(PAGE_SELECTOR)?.getAttribute('data-project-detail') || '';
  return NOTE_ID.test(projectId) ? projectId : null;
}

// What each operation reads, how it tells a usable answer, and what it says.
function editOperation(document, noteId) {
  return {
    key: noteId,
    url: `/notes/${noteId}`,
    // A Related Notes refresh (WP5) may replace the card while its editor
    // loads: the same note's Edit in the new card carries on. A card whose
    // note left the section has none.
    replacement: () => document.querySelector(`[data-project-related-notes-region] [${TRIGGER_ATTRIBUTE}="${noteId}"]`),
    stillWanted: () => true,
    source: (parsed) => editorFrom(parsed, noteId),
    missing: MISSING_MESSAGE,
    signedOut: LOAD_FAILURE_MESSAGE,
    failure: LOAD_FAILURE_MESSAGE,
  };
}

function createOperation(document, projectId) {
  return {
    key: CREATE_KEY,
    url: `/notes/projects/${projectId}/new`,
    replacement: () => document.querySelector(`[${CREATE_TRIGGER_ATTRIBUTE}]`),
    // Not a control's card but the page: the same project still shown.
    stillWanted: () => currentProjectId(document) === projectId,
    source: (parsed) => creatorFrom(parsed, projectId),
    missing: CREATE_MISSING_MESSAGE,
    signedOut: CREATE_SIGNED_OUT_MESSAGE,
    failure: CREATE_LOAD_FAILURE_MESSAGE,
  };
}

// Resolves to whether the dialog was mounted and opened.
function load(ctrl, trigger, operation) {
  const { document } = ctrl;
  const windowObject = document.defaultView || globalThis;
  if (ctrl.request) {
    ctrl.request.abort.abort();
    if (ctrl.request.trigger !== trigger) setBusy(ctrl.request.trigger, false);
  }
  const request = {
    key: operation.key,
    trigger,
    abort: new windowObject.AbortController(),
    opens: appDialogOpenCount(document),
    settled: null,
  };
  ctrl.request = request;
  setBusy(trigger, true);
  // An opener that was replaced hands over to its replacement. Create may be
  // asked for with no opener at all; Edit always has its card's control.
  const liveTrigger = () => {
    if (request.trigger?.isConnected) return request.trigger;
    const replacement = operation.replacement();
    if (replacement && request.trigger) {
      request.trigger = replacement;
      setBusy(replacement, true);
    }
    return replacement;
  };
  // A load superseded by another, outlived by its host, page or card, or
  // overtaken by any dialog opening meanwhile never mounts or opens anything.
  const current = () => ctrl.request === request && ctrl.host.isConnected && operation.stillWanted()
    && (operation.key === CREATE_KEY || Boolean(liveTrigger()))
    && appDialogOpenCount(document) === request.opens;

  request.settled = windowObject.fetch(operation.url, {
    method: 'GET',
    headers: { Accept: 'text/html' },
    credentials: 'same-origin',
    // An expired session answers with a redirect to sign-in, never followed.
    redirect: operation.key === CREATE_KEY ? 'manual' : 'error',
    cache: 'no-store',
    signal: request.abort.signal,
  }).then(async (response) => {
    const html = response.ok && /^text\/html\b/i.test(response.headers.get('content-type') || '')
      ? await response.text()
      : '';
    if (!current()) return false;
    if (response.status === 404) {
      fail(ctrl, operation.missing);
      return false;
    }
    if (response.status === 401 || response.type === 'opaqueredirect') {
      fail(ctrl, operation.signedOut);
      return false;
    }
    const source = html ? operation.source(new windowObject.DOMParser().parseFromString(html, 'text/html')) : null;
    if (!source) {
      fail(ctrl, operation.failure);
      return false;
    }
    // Checked again: what the mounted editor holds may have changed meanwhile.
    const held = mountedDialog(ctrl)?.__creatorCrateAppDialogState;
    if (editorHeld(held)) {
      fail(ctrl, heldMessage(held, operation.key));
      return false;
    }
    if (mount(ctrl, source, liveTrigger())) return true;
    fail(ctrl, operation.failure);
    return false;
  }).catch(() => {
    if (current()) fail(ctrl, operation.failure);
    return false;
  }).finally(() => {
    if (ctrl.request !== request) return;
    ctrl.request = null;
    setBusy(trigger, false);
    setBusy(request.trigger, false);
  });
  return request.settled;
}

// Drops whatever load is under way: a held dialog reopens instead.
function abortLoad(ctrl) {
  if (!ctrl.request) return;
  ctrl.request.abort.abort();
  setBusy(ctrl.request.trigger, false);
  ctrl.request = null;
}

function openEditor(ctrl, trigger, noteId) {
  // A second Edit of the Page already loading waits for that load.
  if (ctrl.request?.key === noteId) return;
  const state = mountedDialog(ctrl)?.__creatorCrateAppDialogState;
  if (editorHeld(state)) {
    if (state.open || state.dialog.open) return;
    if (mountedNoteId(state) === noteId) {
      // Its unconfirmed outcome is on show there, with its own Check again.
      abortLoad(ctrl);
      openAppDialogById(ctrl.document, EDIT_DIALOG_ID, trigger);
      return;
    }
    fail(ctrl, heldMessage(state, noteId));
    return;
  }
  load(ctrl, trigger, editOperation(ctrl.document, noteId));
}

function openCreator(ctrl, opener) {
  // Repeated requests wait for the load already under way.
  if (ctrl.request?.key === CREATE_KEY) return ctrl.request.settled;
  const projectId = currentProjectId(ctrl.document);
  if (!projectId) {
    fail(ctrl, CREATE_LOAD_FAILURE_MESSAGE);
    return Promise.resolve(false);
  }
  const state = mountedDialog(ctrl)?.__creatorCrateAppDialogState;
  if (editorHeld(state)) {
    // An open dialog is modal and already in front: nothing replaces it.
    if (state.open || state.dialog.open) return Promise.resolve(false);
    // The unresolved creation it keeps comes back as it was left (WP6-F4).
    if (unresolvedCreate(state)) {
      abortLoad(ctrl);
      return Promise.resolve(openAppDialogById(ctrl.document, CREATE_DIALOG_ID, opener));
    }
    fail(ctrl, heldMessage(state, CREATE_KEY));
    return Promise.resolve(false);
  }
  return load(ctrl, opener, createOperation(ctrl.document, projectId));
}

/**
 * Open Create Note on this Project Detail page (WP6.5's Create control calls
 * this from its click). The opener, when given, is busy while the dialog loads
 * and receives focus back when it closes. Resolves to true once the dialog is
 * open, and false when it was refused, superseded or could not be loaded, in
 * which case the page feedback says why (except when superseded).
 */
export function openProjectRelatedNoteCreate(document, { opener = null } = {}) {
  const ctrl = document?.querySelector?.(HOST_SELECTOR)?.__creatorCrateProjectRelatedNoteEditor;
  if (!ctrl) return Promise.resolve(false);
  return ctrl.openCreate(opener);
}

/**
 * Bind Edit on the Related Notes cards of Project Detail, and the section's
 * Create new note. Cards and the section come and go (WP5 refresh); the one
 * click listener reads the clicked control at each click.
 */
export function enhanceProjectRelatedNoteEditor(scope = globalThis.document) {
  const document = scope?.nodeType === 9 ? scope : scope?.ownerDocument;
  const host = document?.querySelector?.(HOST_SELECTOR);
  if (!host || isEnhancementBound(host, 'projectRelatedNoteEditorBound')) return null;
  markEnhancementBound(host, 'projectRelatedNoteEditorBound');
  const ctrl = { document, host, request: null };
  // The controller stays reachable from its host, as the page's other
  // controllers are, for whatever opens Create Note on this page.
  ctrl.openCreate = (opener = null) => openCreator(ctrl, opener?.nodeType === 1 ? opener : null);
  host.__creatorCrateProjectRelatedNoteEditor = ctrl;

  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    const creator = event.target?.closest?.(`[${CREATE_TRIGGER_ATTRIBUTE}]`);
    if (creator?.closest('[data-project-related-notes-region]')) {
      event.preventDefault();
      // A press while its dialog loads waits for that load (openCreator).
      void ctrl.openCreate(creator);
      return;
    }
    const trigger = event.target?.closest?.(`[${TRIGGER_ATTRIBUTE}]`);
    const noteId = trigger?.getAttribute(TRIGGER_ATTRIBUTE);
    if (!noteId || !NOTE_ID.test(noteId) || !trigger.closest('[data-project-related-notes-region]')) return;
    event.preventDefault();
    openEditor(ctrl, trigger, noteId);
  });

  return ctrl;
}
