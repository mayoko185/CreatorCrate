import { appDialogFeedback, appDialogOpenCount, closeAppDialogById, openAppDialogById } from './app-dialogs.js';
import { enhanceDedicatedReorder, NOTES_REORDER_INTERACTIVE_SELECTOR } from './dedicated-reorder.js';
import { isEnhancementBound, markEnhancementBound } from './dom.js';
import { removeStatusRetry, showStatusRetry } from './status-retry.js';

// WP7.3: Project Detail "Reorder Notes".
//
// The section's Reorder Notes control ([data-project-related-notes-reorder],
// server-rendered in the Related Notes region and disabled below two Notes)
// opens the closed #project-related-notes-order-dialog rendered outside every
// refresh region (partials/project-related-notes-order-dialog.njk). Each
// opening first reads the authoritative order (GET /notes/projects/:id/order,
// WP7.2), fills a fresh list from the dialog's row template and binds it with
// the shared Notes reorder engine (enhanceDedicatedReorder): drag, Arrow
// Up/Down, Home/End, position text and the polite announcement are the
// engine's. Moves change only the draft. Save sends exactly one POST of
// { expectedNoteIds (the snapshot read at opening), orderedNoteIds } to the
// same URL; nothing is ever resent automatically. Cancel, Close and Escape
// discard the draft; the next opening reads the order again.
//
// Outcomes of Save:
// - 200 with a complete WP7.2 success answer for this project whose saved
//   order is exactly the submitted permutation: the dialog closes, the page
//   says so, the existing Related Notes cards are moved into the saved order
//   in place (their disclosure, pin and media state stay with them), and
//   RELATED_NOTES_ORDER_SAVED_EVENT asks project-detail-refresh.js for its
//   GET-only reconciliation of the page.
// - 409 stale: nothing was saved; the server's current order replaces the
//   draft for review, with its snapshot, and Save is offered again.
// - 422: the server's reasons are shown; the draft stays.
// - 404: the project is gone; Save is locked.
// - Signed out, any other 4xx: refused; the draft stays.
// - A 5xx (JSON or not), any other status, a success answer that is not that
//   exact confirmation, or no readable answer: the outcome is unknown (a 500
//   can follow a committed write). The draft stays, nothing is resent, and
//   "Check saved order" reads the order (GET only) to show what the server
//   holds now, without claiming this Save did or did not commit. The check
//   never replaces the arrangement on show (moves made while it reads
//   included): when the same Notes are saved it reports the saved order and
//   keeps the arrangement as the unsaved draft against it; when the Notes
//   themselves changed, Save waits until "Show current order" (the user's
//   choice) reads and shows the current order in place of the arrangement.
export const RELATED_NOTES_ORDER_SAVED_EVENT = 'creatorcrate:project-related-notes-order-saved';

const DIALOG_ID = 'project-related-notes-order-dialog';
const PAGE_SELECTOR = '[data-project-detail]';
const REGION_SELECTOR = '[data-project-related-notes-region]';
const TRIGGER_ATTRIBUTE = 'data-project-related-notes-reorder';
const FORM_SELECTOR = '[data-project-related-notes-order-form]';
const LIST_SELECTOR = '[data-project-related-notes-order-list]';
const ITEM_SELECTOR = '[data-project-related-notes-order-item]';
const HANDLE_SELECTOR = '[data-project-related-notes-order-handle]';
const ROW_TEMPLATE_SELECTOR = 'template[data-project-related-notes-order-row]';
const BINDING_KEY = 'projectRelatedNotesOrderBound';
const BINDING_ATTRIBUTE = 'data-project-related-notes-order-bound';
const CANONICAL_ID = /^[1-9]\d*$/;
const STALE_CODE = 'RELATED_NOTES_ORDER_STALE';

const LOAD_FAILURE_MESSAGE = 'Reorder Notes could not be opened. Try again.';
const PROJECT_MISSING_MESSAGE = 'This project is no longer available, so its notes cannot be reordered.';
const SIGNED_OUT_LOAD_MESSAGE = 'Your CreatorCrate sign-in has expired, so Reorder Notes could not be opened. Sign in again, then try again.';
const SAVING_MESSAGE = 'Saving note order…';
const SAVED_MESSAGE = 'Note order saved.';
const STALE_MESSAGE = 'Related Notes changed while this dialog was open, so your order was not saved. The current order is shown: review it, move notes again if needed, then select Save.';
const STALE_UNREADABLE_MESSAGE = 'Related Notes changed while this dialog was open, so your order was not saved. Close this dialog and open Reorder Notes again to review the current order.';
const SAVE_FAILURE_MESSAGE = 'The note order could not be saved. Your arrangement is kept; try again.';
const VALIDATION_MESSAGE = 'The note order could not be saved.';
const SAVE_MISSING_MESSAGE = 'This project is no longer available, so the note order cannot be saved. Close this dialog.';
const SIGNED_OUT_SAVE_MESSAGE = 'Your CreatorCrate sign-in has expired, so the note order was not saved. Your arrangement is kept; sign in again, then select Save.';
const UNCERTAIN_MESSAGE = 'The note order could not be confirmed, so it may or may not have been saved. Your arrangement is kept. Check the saved order before saving again.';
const CHECKING_MESSAGE = 'Checking the saved note order…';
const CHECK_FAILED_MESSAGE = 'The saved note order could not be read. Your arrangement is kept; check again.';
const CHECK_UNCHANGED_MESSAGE = 'The saved order is still the order this dialog opened with, so your arrangement is not in effect. It is kept; select Save to save it.';
const CHECK_MATCHES_MESSAGE = 'The saved order now matches your arrangement. Close this dialog, or move notes again and select Save.';
const CHECK_DIFFERS_MESSAGE = 'Your arrangement is still shown and is not saved; select Save to save it, or move notes again first.';
const CHECK_MEMBERSHIP_MESSAGE = 'The related notes for this project changed, so your arrangement no longer covers them and cannot be saved. Select Show current order to replace your arrangement with the current saved order, or close this dialog.';
const SHOWING_CURRENT_MESSAGE = 'Reading the current note order…';
const SAVING_CLOSE_REFUSAL = 'Wait for the note order to finish saving, then close.';

function sameIds(left, right) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function sameMembers(left, right) {
  const members = new Set(left);
  return left.length === right.length && members.size === left.length && right.every((id) => members.has(id));
}

// A Note ID exactly as the WP7.2 contract carries it: a positive safe integer,
// or its canonical digit string. Anything else (arrays, booleans, "01") is not.
function canonicalId(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  return typeof value === 'string' && CANONICAL_ID.test(value) ? value : null;
}

function currentProjectId(document) {
  const projectId = document.querySelector(PAGE_SELECTOR)?.getAttribute('data-project-detail') || '';
  return CANONICAL_ID.test(projectId) ? projectId : null;
}

// The WP7.2 order answer for exactly this project: its Notes in order (each a
// canonical ID and a title) and the snapshot naming the same Notes.
function readOrder(payload, projectId) {
  if (!payload || typeof payload !== 'object' || canonicalId(payload.project?.id) !== projectId) return null;
  if (!Array.isArray(payload.notes) || !Array.isArray(payload.expectedNoteIds)) return null;
  const notes = [];
  for (const note of payload.notes) {
    const id = canonicalId(note?.id);
    if (!id || typeof note.title !== 'string') return null;
    notes.push({ id, title: note.title });
  }
  const ids = notes.map((note) => note.id);
  const expected = payload.expectedNoteIds.map(canonicalId);
  if (new Set(ids).size !== ids.length || expected.includes(null) || !sameIds(ids, expected)) return null;
  return { notes, ids };
}

// The one confirmation of a Save: HTTP 200, the WP7.2 success answer for this
// project, and its saved order exactly the complete permutation submitted. An
// empty, partial, previous or contradictory order confirms nothing.
function readSaveAcknowledgement(response, payload, projectId, orderedNoteIds) {
  if (response?.status !== 200 || payload?.status !== 'success' || typeof payload.changed !== 'boolean') return null;
  const saved = readOrder(payload, projectId);
  return saved && sameIds(saved.ids, orderedNoteIds) ? saved : null;
}

async function readJson(response) {
  if (!/\bapplication\/json\b/i.test(response.headers.get('content-type') || '')) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function signedOut(response) {
  return response.status === 401 || response.type === 'opaqueredirect';
}

function setBusy(element, busy) {
  if (busy) element?.setAttribute('aria-busy', 'true');
  else element?.removeAttribute('aria-busy');
}

function focusable(element) {
  return Boolean(element?.isConnected && !element.disabled && !element.closest('[hidden]'));
}

function list(ctrl) {
  return ctrl.form.querySelector(LIST_SELECTOR);
}

function draftIds(ctrl) {
  return Array.from(list(ctrl)?.querySelectorAll(ITEM_SELECTOR) || [], (item) => item.getAttribute('data-note-id'));
}

function setStatus(ctrl, message) {
  ctrl.status.textContent = message;
}

function setError(ctrl, message) {
  ctrl.errorText.textContent = message;
  ctrl.error.hidden = !message;
}

function syncSave(ctrl) {
  const count = list(ctrl)?.querySelectorAll(ITEM_SELECTOR).length || 0;
  // A draft over Notes the server no longer holds cannot be a complete order.
  ctrl.save.disabled = ctrl.saving || ctrl.locked || ctrl.membershipChanged || count < 2;
  ctrl.few.hidden = !ctrl.snapshot || count >= 2;
  list(ctrl)?.toggleAttribute('inert', ctrl.saving || ctrl.locked);
}

// The reorder engine's configuration for one list. The engine's form hook
// only serializes the order on a native submit; this dialog submits its own
// JSON, so the list stands in as that scope and its listener leaves with it.
function reorderConfig(ctrl, listElement) {
  return {
    listSelector: LIST_SELECTOR,
    itemSelector: ITEM_SELECTOR,
    handleSelector: HANDLE_SELECTOR,
    liveSelector: '[data-project-related-notes-order-live]',
    positionSelector: '[data-project-related-notes-order-position]',
    idDataset: 'noteId',
    idAttribute: 'data-note-id',
    labelDataset: 'noteLabel',
    labelAttribute: 'data-note-label',
    label: 'Note',
    pointerDragSurfaceSelector: ITEM_SELECTOR,
    pointerDragExcludedSelector: NOTES_REORDER_INTERACTIVE_SELECTOR,
    bindingKey: BINDING_KEY,
    form: listElement,
    syncInput: () => true,
    // The order being saved cannot change under its own request.
    isBusy: () => ctrl.saving || ctrl.locked,
    // Supplying the hook is what makes the engine announce a drop in the
    // polite region, as it already does for keyboard moves (once each). The
    // move stays a draft: nothing is saved until Save.
    onOrderChange: () => {},
  };
}

// Shows `notes` as a new, freshly bound list; the old list and its listeners go.
function installOrder(ctrl, order) {
  const { document } = ctrl;
  const current = list(ctrl);
  const replacement = current.cloneNode(false);
  replacement.removeAttribute(BINDING_ATTRIBUTE);
  const template = ctrl.form.querySelector(ROW_TEMPLATE_SELECTOR);
  order.notes.forEach((note, index) => {
    const item = template.content.firstElementChild.cloneNode(true);
    item.setAttribute('data-note-id', note.id);
    item.setAttribute('data-note-label', note.title);
    item.setAttribute('aria-posinset', String(index + 1));
    item.setAttribute('aria-setsize', String(order.notes.length));
    const positionId = `project-related-notes-order-position-${note.id}`;
    const handle = item.querySelector(HANDLE_SELECTOR);
    handle.setAttribute('aria-label', `Reorder Note: ${note.title}`);
    handle.setAttribute('aria-describedby', `project-related-notes-order-instructions ${positionId}`);
    item.querySelector('[data-project-related-notes-order-title]').textContent = note.title;
    const position = item.querySelector('[data-project-related-notes-order-position]');
    position.id = positionId;
    position.textContent = `Position ${index + 1} of ${order.notes.length}`;
    replacement.append(item);
  });
  const hadFocus = current.contains(document.activeElement);
  const focusedId = document.activeElement?.closest?.(ITEM_SELECTOR)?.getAttribute('data-note-id');
  current.replaceWith(replacement);
  enhanceDedicatedReorder(ctrl.form, reorderConfig(ctrl, replacement));
  ctrl.snapshot = order.ids;
  ctrl.membershipChanged = false;
  ctrl.live.textContent = '';
  syncSave(ctrl);
  if (hadFocus) {
    const handle = focusedId
      ? replacement.querySelector(`${ITEM_SELECTOR}[data-note-id="${focusedId}"] ${HANDLE_SELECTOR}`)
      : null;
    (handle || replacement.querySelector(HANDLE_SELECTOR) || ctrl.dialog.querySelector('[data-dialog-close]'))?.focus?.();
  }
}

function clearDialog(ctrl) {
  removeStatusRetry(ctrl, 'checkButton');
  setError(ctrl, '');
  setStatus(ctrl, '');
  ctrl.locked = false;
  ctrl.snapshot = null;
  ctrl.checking = null;
  installOrder(ctrl, { notes: [], ids: [] });
  ctrl.snapshot = null;
  syncSave(ctrl);
}

function liveTrigger(ctrl, request) {
  if (request.trigger?.isConnected) return request.trigger;
  // A Related Notes refresh may replace the control while the order loads.
  const replacement = ctrl.document.querySelector(`${REGION_SELECTOR} [${TRIGGER_ATTRIBUTE}]`);
  if (replacement && request.trigger) {
    request.trigger = replacement;
    setBusy(replacement, true);
  }
  return replacement;
}

function fail(ctrl, message) {
  appDialogFeedback(ctrl.document, message, true);
}

// Reads the order and opens the dialog on it. Resolves to whether it opened.
function load(ctrl, trigger) {
  const { document } = ctrl;
  const windowObject = document.defaultView || globalThis;
  const projectId = currentProjectId(document);
  if (!projectId) {
    fail(ctrl, LOAD_FAILURE_MESSAGE);
    return Promise.resolve(false);
  }
  ctrl.request?.abort.abort();
  if (ctrl.request && ctrl.request.trigger !== trigger) setBusy(ctrl.request.trigger, false);
  const request = {
    trigger,
    abort: new windowObject.AbortController(),
    opens: appDialogOpenCount(document),
  };
  ctrl.request = request;
  setBusy(trigger, true);
  // Superseded, a different project on show, or overtaken by any dialog
  // opening meanwhile: the late answer opens nothing.
  const current = () => ctrl.request === request && ctrl.dialog.isConnected
    && currentProjectId(document) === projectId
    && appDialogOpenCount(document) === request.opens
    && !ctrl.dialog.open;

  return windowObject.fetch(`/notes/projects/${projectId}/order`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
    redirect: 'manual',
    cache: 'no-store',
    signal: request.abort.signal,
  }).then(async (response) => {
    const payload = response.ok ? await readJson(response) : null;
    if (!current()) return false;
    if (response.status === 404) {
      fail(ctrl, PROJECT_MISSING_MESSAGE);
      return false;
    }
    if (signedOut(response)) {
      fail(ctrl, SIGNED_OUT_LOAD_MESSAGE);
      return false;
    }
    const order = payload?.status === 'success' ? readOrder(payload, projectId) : null;
    if (!order) {
      fail(ctrl, LOAD_FAILURE_MESSAGE);
      return false;
    }
    clearDialog(ctrl);
    ctrl.projectId = projectId;
    installOrder(ctrl, order);
    if (!openAppDialogById(document, DIALOG_ID, liveTrigger(ctrl, request))) {
      clearDialog(ctrl);
      fail(ctrl, LOAD_FAILURE_MESSAGE);
      return false;
    }
    return true;
  }).catch(() => {
    if (current()) fail(ctrl, LOAD_FAILURE_MESSAGE);
    return false;
  }).finally(() => {
    if (ctrl.request !== request) return;
    ctrl.request = null;
    setBusy(trigger, false);
    setBusy(request.trigger, false);
  });
}

// The confirmed order, shown at once by moving the existing cards: nothing is
// rebuilt, so expansion, pins, media and code-block controls stay as they are.
function orderCards(document, ids) {
  const cardList = document.querySelector(`${REGION_SELECTOR} .project-related-note-list`);
  if (!cardList) return;
  const items = new Map();
  cardList.querySelectorAll(':scope > .project-related-note-item').forEach((item) => {
    const id = item.querySelector('[data-project-related-note]')?.getAttribute('data-project-related-note');
    if (id) items.set(id, item);
  });
  const windowObject = document.defaultView || globalThis;
  const { scrollX, scrollY } = windowObject;
  // Notes the answer names, in its order, ahead of any it does not (which the
  // reconciliation read that follows settles).
  const named = ids.filter((id) => items.has(id)).map((id) => items.get(id));
  const rest = Array.from(cardList.children).filter((item) => !named.includes(item));
  [...named, ...rest].forEach((item) => cardList.append(item));
  windowObject.scrollTo?.(scrollX, scrollY);
}

function showCheck(ctrl) {
  showStatusRetry({
    state: ctrl,
    status: ctrl.status,
    attribute: 'data-project-related-notes-order-check',
    key: 'checkButton',
    label: 'Check saved order',
    onRetry: ({ wasFocused }) => checkSavedOrder(ctrl, wasFocused),
  });
}

// After the Notes themselves changed: the user's explicit choice to read the
// current order (GET only) and show it in place of the arrangement.
function showReload(ctrl) {
  showStatusRetry({
    state: ctrl,
    status: ctrl.status,
    attribute: 'data-project-related-notes-order-reload',
    key: 'checkButton',
    label: 'Show current order',
    onRetry: ({ wasFocused }) => checkSavedOrder(ctrl, wasFocused, { replace: true }),
  });
}

function describeOrder(order) {
  return order.notes.map((note, index) => `${index + 1}. ${note.title}`).join(', ');
}

// GET only. Says what the server holds now; never that this Save committed.
// The arrangement is read when the answer arrives, not when the check began,
// so moves made while it reads are never overwritten; only `replace` (the
// user's Show current order) puts the server's order on show.
async function checkSavedOrder(ctrl, focusResult, { replace = false } = {}) {
  const { document } = ctrl;
  const windowObject = document.defaultView || globalThis;
  const projectId = ctrl.projectId;
  const check = {};
  ctrl.checking = check;
  setStatus(ctrl, replace ? SHOWING_CURRENT_MESSAGE : CHECKING_MESSAGE);
  let order = null;
  let missing = false;
  try {
    const response = await windowObject.fetch(`/notes/projects/${projectId}/order`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
      redirect: 'manual',
      cache: 'no-store',
    });
    missing = response.status === 404;
    const payload = response.ok ? await readJson(response) : null;
    order = payload?.status === 'success' ? readOrder(payload, projectId) : null;
  } catch {
    order = null;
  }
  // Superseded by a later check, a Save, a close or another opening.
  if (ctrl.checking !== check || !ctrl.dialog.open || ctrl.saving) return;
  ctrl.checking = null;
  if (missing) {
    lock(ctrl, SAVE_MISSING_MESSAGE);
    return;
  }
  if (!order) {
    // The arrangement and what is known about the Save stay as they were.
    setStatus(ctrl, CHECK_FAILED_MESSAGE);
    if (ctrl.membershipChanged) showReload(ctrl);
    else showCheck(ctrl);
    if (focusResult) ctrl.checkButton?.focus?.();
    return;
  }
  setStatus(ctrl, '');
  const draft = draftIds(ctrl);
  if (replace) {
    installOrder(ctrl, order);
    setError(ctrl, `The current saved order is shown: ${describeOrder(order)}. Move notes if needed, then select Save.`);
  } else if (!sameMembers(order.ids, draft)) {
    // Notes joined or left: the arrangement is kept on show but is no longer a
    // complete order, so Save waits for the user's Show current order.
    ctrl.membershipChanged = true;
    syncSave(ctrl);
    setError(ctrl, CHECK_MEMBERSHIP_MESSAGE);
    showReload(ctrl);
    if (focusResult) ctrl.checkButton?.focus?.();
    return;
  } else if (sameIds(order.ids, draft)) {
    // Checked first: an arrangement moved back to the opening order matches
    // what is saved, whichever way the uncertain Save went. The arrangement
    // stays as it is, now measured against what is saved.
    ctrl.snapshot = order.ids;
    setError(ctrl, CHECK_MATCHES_MESSAGE);
  } else if (sameIds(order.ids, ctrl.snapshot)) {
    setError(ctrl, CHECK_UNCHANGED_MESSAGE);
  } else {
    // The arrangement stays on show as the unsaved draft; a Save now is
    // measured against the order the server holds.
    ctrl.snapshot = order.ids;
    setError(ctrl, `The saved order is now: ${describeOrder(order)}. ${CHECK_DIFFERS_MESSAGE}`);
  }
  if (focusResult) (focusable(ctrl.save) ? ctrl.save : ctrl.dialog.querySelector('[data-dialog-close]'))?.focus?.();
}

function lock(ctrl, message) {
  ctrl.locked = true;
  removeStatusRetry(ctrl, 'checkButton');
  setStatus(ctrl, '');
  setError(ctrl, message);
  syncSave(ctrl);
  if (!ctrl.dialog.contains(ctrl.document.activeElement) || ctrl.document.activeElement?.disabled) {
    ctrl.dialog.querySelector('[data-dialog-close]')?.focus?.();
  }
}

function settleSave(ctrl) {
  ctrl.saving = false;
  setBusy(ctrl.form, false);
  syncSave(ctrl);
}

// After a refusal or unknown outcome, focus stays usable in the dialog.
function keepFocus(ctrl) {
  const active = ctrl.document.activeElement;
  if (ctrl.dialog.contains(active) && focusable(active)) return;
  (focusable(ctrl.save) ? ctrl.save : ctrl.dialog.querySelector('[data-dialog-close]'))?.focus?.();
}

async function save(ctrl) {
  if (ctrl.saving || ctrl.locked || ctrl.membershipChanged || !ctrl.snapshot || !ctrl.dialog.open) return;
  const { document } = ctrl;
  const windowObject = document.defaultView || globalThis;
  const projectId = ctrl.projectId;
  const orderedNoteIds = draftIds(ctrl);
  if (orderedNoteIds.length < 2) return;
  const body = JSON.stringify({ expectedNoteIds: ctrl.snapshot, orderedNoteIds });
  const csrf = ctrl.form.querySelector('input[name="_csrf"]')?.value || '';
  ctrl.saving = true;
  ctrl.checking = null;
  removeStatusRetry(ctrl, 'checkButton');
  setError(ctrl, '');
  setStatus(ctrl, SAVING_MESSAGE);
  setBusy(ctrl.form, true);
  syncSave(ctrl);

  let response;
  let payload = null;
  try {
    response = await windowObject.fetch(ctrl.form.getAttribute('action'), {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      credentials: 'same-origin',
      redirect: 'manual',
      cache: 'no-store',
      body,
    });
    payload = await readJson(response);
  } catch {
    response = null;
  }
  settleSave(ctrl);

  if (response && signedOut(response)) {
    setStatus(ctrl, '');
    setError(ctrl, SIGNED_OUT_SAVE_MESSAGE);
    keepFocus(ctrl);
    return;
  }
  if (response?.status === 404) {
    lock(ctrl, SAVE_MISSING_MESSAGE);
    return;
  }
  if (response?.status === 409 && payload?.code === STALE_CODE) {
    const order = readOrder(payload, projectId);
    if (order) {
      setStatus(ctrl, '');
      installOrder(ctrl, order);
      setError(ctrl, STALE_MESSAGE);
      keepFocus(ctrl);
      return;
    }
  }
  if (response?.status === 409) {
    // Stale, without a current order to review here: only a fresh opening can.
    lock(ctrl, STALE_UNREADABLE_MESSAGE);
    return;
  }
  if (response?.status === 422 && payload?.status === 'error') {
    const reasons = Object.values(payload.errors || {}).filter((reason) => typeof reason === 'string');
    setStatus(ctrl, '');
    setError(ctrl, [payload.message || VALIDATION_MESSAGE, ...reasons].join(' '));
    keepFocus(ctrl);
    return;
  }
  // Any other 4xx is a refusal before anything was written. A 5xx is not:
  // WP7.2 can fail after its transaction committed (its later project
  // lookup), whatever its JSON says, so it stays unconfirmed below.
  if (response && response.status >= 400 && response.status < 500) {
    setStatus(ctrl, '');
    setError(ctrl, SAVE_FAILURE_MESSAGE);
    keepFocus(ctrl);
    return;
  }
  const saved = readSaveAcknowledgement(response, payload, projectId, orderedNoteIds);
  if (!saved) {
    // No answer that proves this order was written: the POST may or may not
    // have committed. Nothing moves, closes or is announced; nothing is resent.
    setStatus(ctrl, UNCERTAIN_MESSAGE);
    showCheck(ctrl);
    keepFocus(ctrl);
    return;
  }

  setStatus(ctrl, '');
  closeAppDialogById(document, DIALOG_ID);
  appDialogFeedback(document, typeof payload.message === 'string' && payload.message ? payload.message : SAVED_MESSAGE);
  orderCards(document, saved.ids);
  ctrl.dialog.dispatchEvent(new windowObject.CustomEvent(RELATED_NOTES_ORDER_SAVED_EVENT, {
    bubbles: true,
    detail: { projectId, orderedNoteIds: saved.ids, changed: payload.changed === true },
  }));
}

/**
 * Bind Reorder Notes on Project Detail: the one click listener reads the
 * control at each click, so replaced Related Notes regions need nothing more.
 */
export function enhanceProjectRelatedNotesOrder(scope = globalThis.document) {
  const document = scope?.nodeType === 9 ? scope : scope?.ownerDocument;
  const dialog = document?.getElementById?.(DIALOG_ID);
  const form = dialog?.querySelector(FORM_SELECTOR);
  const appState = dialog?.__creatorCrateAppDialogState;
  if (!form || !appState || isEnhancementBound(dialog, 'projectRelatedNotesOrderDialogBound')) return null;
  markEnhancementBound(dialog, 'projectRelatedNotesOrderDialogBound');

  const ctrl = {
    document,
    dialog,
    form,
    status: form.querySelector('[data-project-related-notes-order-status]'),
    error: form.querySelector('[data-project-related-notes-order-error]'),
    errorText: form.querySelector('[data-project-related-notes-order-error-text]'),
    few: form.querySelector('[data-project-related-notes-order-few]'),
    live: form.querySelector('[data-project-related-notes-order-live]'),
    save: form.querySelector('[data-project-related-notes-order-save]'),
    request: null,
    projectId: null,
    snapshot: null,
    saving: false,
    locked: false,
    membershipChanged: false,
    checking: null,
    checkButton: null,
  };
  dialog.__creatorCrateProjectRelatedNotesOrder = ctrl;
  syncSave(ctrl);

  // A Save in flight finishes before the dialog can go; closing never discards
  // an answer that is still on its way.
  appState.beforeClose = () => {
    if (!ctrl.saving) return true;
    setStatus(ctrl, `${SAVING_MESSAGE} ${SAVING_CLOSE_REFUSAL}`);
    return false;
  };
  // Closing discards the draft; the next opening reads the order again.
  appState.onClose = () => clearDialog(ctrl);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void save(ctrl);
  });

  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    const trigger = event.target?.closest?.(`[${TRIGGER_ATTRIBUTE}]`);
    if (!trigger?.closest(REGION_SELECTOR) || trigger.disabled) return;
    event.preventDefault();
    // A press while the order loads waits for that load.
    if (ctrl.request || ctrl.dialog.open) return;
    void load(ctrl, trigger);
  });

  return ctrl;
}
