import { appDialogFeedback, closeAppDialogById, openAppDialogById } from './app-dialogs.js';
import { decorateFeedback, fetchBooksShelf, installBooksShelf } from './book-create-dialog.js';
import {
  enhanceBookEditFetchSave,
  fetchBookEditAuthority,
  installBookEditDialogPresentation,
} from './book-edit-fetch-save.js';
import { enhanceAppConfirmationControls } from './confirm-dialog.js';
import { bindRecordDelete } from './dialog-record-delete.js';
import { enhancePreviewMedia } from './preview.js';
import { removeStatusRetry, showStatusRetry } from './status-retry.js';

// Edit Book opened from the Books shelf. Each open reads the Book's own render
// and mounts its Edit Book form here, so the Book Detail autosave runs unchanged
// against that form and nothing carries over between Books. The shelf only
// changes what the autosave refreshes: a GET of /notes instead of Book Detail.
// A directly visited /notes/books/:id/edit stays on Book Detail.
const DIALOG_ID = 'book-edit-dialog';
const TRIGGER_SELECTOR = '[data-book-edit-open]';
const LOAD_SELECTOR = '[data-book-edit-shelf-load]';
const FORM_SELECTOR = 'form[data-book-edit-autosave]';
const FALLBACK_TRIGGER_SELECTOR = '.page-heading [data-dialog-open="book-create-dialog"]';
const SAVE_STATE_ATTRIBUTE = 'data-book-edit-save-state';
const ID_PREFIX = 'book-edit-';
const LOAD_RETRY_KEY = 'loadRetryButton';
const NOTE_RETRY_KEY = 'noteRetryButton';
const LOADING_MESSAGE = 'Loading Book…';
const LOAD_FAILURE_MESSAGE = 'Could not load this Book.';
const LOAD_MISSING_MESSAGE = 'This Book is no longer available.';
const SHELF_REFRESH_FAILURE_MESSAGE = 'The Book was saved, but the Books shelf could not refresh. ';
const SAVED_NOTE = 'The Book was saved, but Books could not refresh.';
const UNCERTAIN_NOTE = 'Could not confirm whether the Book change was saved, and Books could not refresh.';
const DELETED_NOTE = 'Books could not refresh.';
const UNCERTAIN_DELETE_NOTE = 'Could not confirm whether the Book was deleted, and Books could not refresh.';
const ORDER_TRIGGER_SELECTOR = '.page-heading [data-dialog-open="books-order-dialog"]';

// The New Book dialog on this page uses the same field IDs as this form.
function namespaceIds(roots) {
  const elements = roots.flatMap((root) => [root, ...root.querySelectorAll('*')]);
  const ids = new Set(elements.filter((element) => element.id).map((element) => element.id));
  for (const element of elements) {
    for (const name of ['for', 'form', 'aria-describedby', 'aria-labelledby']) {
      const value = element.getAttribute(name);
      if (!value) continue;
      element.setAttribute(name, value.split(/\s+/)
        .map((id) => (ids.has(id) ? `${ID_PREFIX}${id}` : id)).join(' '));
    }
    if (element.id) element.id = `${ID_PREFIX}${element.id}`;
  }
}

function triggerFor(ctrl, bookId) {
  return ctrl.document.querySelector(`${TRIGGER_SELECTOR}[data-book-edit-open="${bookId}"]`);
}

function restoreLostFocus(ctrl) {
  const active = ctrl.document.activeElement;
  // A closed dialog's control can keep focus until the browser next renders.
  if (active && active !== ctrl.document.body && active.isConnected && !ctrl.dialog.contains(active)) return;
  (triggerFor(ctrl, ctrl.bookId) || ctrl.document.querySelector(FALLBACK_TRIGGER_SELECTOR))
    ?.focus?.({ preventScroll: true });
}

function publishShelf(ctrl, snapshot) {
  if (!installBooksShelf(ctrl.document, snapshot)) return false;
  // The refreshed region replaced the card the dialog would return focus to.
  if (ctrl.dialog.open) ctrl.dialogState.opener = triggerFor(ctrl, ctrl.bookId);
  else restoreLostFocus(ctrl);
  clearRecoveryNote(ctrl);
  return true;
}

// Only the newest refresh shows its result; an older one reports the newest's.
function refreshShelf(ctrl) {
  const request = {};
  ctrl.refreshRequest = request;
  request.result = fetchBooksShelf(ctrl.document).then((snapshot) => (
    ctrl.refreshRequest === request ? publishShelf(ctrl, snapshot) : ctrl.refreshRequest.result
  )).catch(() => (ctrl.refreshRequest === request ? false : ctrl.refreshRequest.result));
  return request.result;
}

function clearRecoveryNote(ctrl) {
  removeStatusRetry(ctrl, NOTE_RETRY_KEY);
  const feedback = ctrl.document.querySelector('[data-dialog-feedback]');
  const text = feedback?.querySelector('[data-dialog-feedback-text]');
  const note = text?.querySelector('[data-book-edit-refresh-note]');
  if (!note) return;
  note.remove();
  if (text.textContent.trim()) return;
  text.textContent = '';
  feedback.classList.remove('app-dialog-feedback--pinned');
  feedback.hidden = true;
}

function showRecoveryNote(ctrl, message, focusRetry) {
  const feedback = ctrl.document.querySelector('[data-dialog-feedback]');
  const text = feedback?.querySelector('[data-dialog-feedback-text]');
  if (!text) return;
  clearRecoveryNote(ctrl);
  const note = ctrl.document.createElement('span');
  note.setAttribute('data-book-edit-refresh-note', '');
  note.textContent = ` ${message} `;
  text.append(note);
  feedback.classList.add('app-dialog-feedback--pinned');
  feedback.hidden = false;
  const retry = showStatusRetry({
    state: ctrl,
    status: note,
    attribute: 'data-book-edit-refresh-note-retry',
    key: NOTE_RETRY_KEY,
    onRetry: ({ wasFocused }) => recoverShelf(ctrl, message, wasFocused),
  });
  if (focusRetry) retry?.focus?.();
}

// Reads only: what the Book's writes did is already settled on the server.
function recoverShelf(ctrl, message, focusRetry = false) {
  return refreshShelf(ctrl).then((refreshed) => {
    if (refreshed) {
      if (focusRetry) restoreLostFocus(ctrl);
      return;
    }
    showRecoveryNote(ctrl, message, focusRetry);
  });
}

// The dialog's own status and retry are out of sight once it has closed, so an
// unfinished refresh moves to the page.
function recoverDismissedForm(ctrl, form) {
  const state = form.getAttribute(SAVE_STATE_ATTRIBUTE);
  if (state === 'saved-refresh-error' || state === 'saved-refresh-pending') recoverShelf(ctrl, SAVED_NOTE);
  else if (state === 'reconciliation-error') recoverShelf(ctrl, UNCERTAIN_NOTE);
}

function autosaveOptions(ctrl) {
  return {
    beginRefresh: () => 0,
    refresh(_document, _url, _generation, { onComplete, onError }) {
      refreshShelf(ctrl).then((refreshed) => (refreshed ? onComplete() : onError()));
      return 'started';
    },
    async fetchAuthority(state) {
      const [authority, shelf] = await Promise.all([
        fetchBookEditAuthority(state),
        fetchBooksShelf(ctrl.document).catch(() => null),
      ]);
      return authority && shelf ? { ...authority, detailRegion: shelf } : null;
    },
    installDetail: (_document, _url, _generation, shelf) => (publishShelf(ctrl, shelf) ? 'installed' : 'superseded'),
    installDialogPresentation(state, authority) {
      if (!installBookEditDialogPresentation(state, authority)) return false;
      enhancePreviewMedia(state.form);
      return true;
    },
    publishDetailAndDialog(_document, _url, _generation, shelf, publishPeer) {
      if (publishPeer() !== true) return 'unavailable';
      return publishShelf(ctrl, shelf) ? 'installed' : 'superseded';
    },
    updateVisibleTitle() {},
    refreshFailureMessage: SHELF_REFRESH_FAILURE_MESSAGE,
    onPresentationFailure(state) {
      if (!ctrl.dialog.open || state.form !== ctrl.form) recoverDismissedForm(ctrl, state.form);
    },
  };
}

function unmountForm(ctrl) {
  ctrl.mounted.forEach((element) => element.remove());
  ctrl.mounted = [];
}

// The Book is gone, whatever a refresh then manages: nothing here may still act
// on it. Focus moves to the Book beside it, or to New Book for the last one. The
// order dialog holds every Book, so it stays out of reach until a refresh, which
// restores its trigger when there are still Books to order.
function removeDeletedBook(ctrl, message) {
  const { document, bookId } = ctrl;
  const card = triggerFor(ctrl, bookId)?.closest('.notes-book-card');
  const neighbour = (card?.nextElementSibling || card?.previousElementSibling)?.querySelector(TRIGGER_SELECTOR);
  ctrl.bookId = neighbour?.getAttribute('data-book-edit-open') ?? null;
  card?.remove();
  document.querySelector(ORDER_TRIGGER_SELECTOR)?.remove();
  document.querySelector(`[data-book-export-choice][value="${bookId}"]`)?.closest('li')?.remove();
  ctrl.deleteControl = null;
  ctrl.form = null;
  unmountForm(ctrl);
  closeAppDialogById(document, DIALOG_ID);
  appDialogFeedback(document, message);
  decorateFeedback(document, null);
  recoverShelf(ctrl, DELETED_NOTE);
}

function mountForm(ctrl, form, deleteForm) {
  const roots = [form, deleteForm].filter(Boolean);
  namespaceIds(roots);
  ctrl.load.after(...roots);
  ctrl.mounted = roots;
  ctrl.form = form;
  ctrl.load.hidden = true;
  ctrl.load.textContent = '';
  enhanceBookEditFetchSave(ctrl.dialog, autosaveOptions(ctrl));
  enhanceAppConfirmationControls(ctrl.dialog);
  ctrl.deleteControl = bindRecordDelete({
    dialog: ctrl.dialog,
    dialogState: ctrl.dialogState,
    form: deleteForm,
    label: 'Book',
    validDestination: (url) => url === '/notes',
    onGone: ({ message }) => removeDeletedBook(ctrl, message),
    formOutlivesDialog: false,
  });
  enhancePreviewMedia(form);
}

function showLoadStatus(ctrl, message) {
  removeStatusRetry(ctrl, LOAD_RETRY_KEY);
  ctrl.load.hidden = false;
  ctrl.load.textContent = message;
}

// A write of the previous session may still change what the server renders.
// One whose reconciliation failed has finished and only waits for a retry.
function formSettled(form) {
  const settled = () => !form?.hasAttribute('aria-busy')
    || form.getAttribute(SAVE_STATE_ATTRIBUTE) === 'reconciliation-error';
  if (settled()) return Promise.resolve();
  const Observer = form.ownerDocument.defaultView.MutationObserver;
  return new Promise((resolve) => {
    const observer = new Observer(() => {
      if (!settled()) return;
      observer.disconnect();
      resolve();
    });
    observer.observe(form, { attributes: true, attributeFilter: ['aria-busy', SAVE_STATE_ATTRIBUTE] });
  });
}

function cancelLoad(ctrl) {
  ctrl.generation += 1;
  ctrl.abort?.abort?.();
  ctrl.abort = null;
}

function loadBook(ctrl, bookId) {
  const { document, dialog } = ctrl;
  const windowObject = document.defaultView || globalThis;
  cancelLoad(ctrl);
  const generation = ctrl.generation;
  const abort = new windowObject.AbortController();
  ctrl.abort = abort;
  const current = () => generation === ctrl.generation && dialog.open;
  const previousForm = ctrl.form;
  unmountForm(ctrl);
  ctrl.form = null;
  showLoadStatus(ctrl, LOADING_MESSAGE);

  const fail = (message) => {
    showLoadStatus(ctrl, message);
    showStatusRetry({
      state: ctrl,
      status: ctrl.load,
      attribute: 'data-book-edit-shelf-load-retry',
      key: LOAD_RETRY_KEY,
      label: 'Try again',
      onRetry: ({ wasFocused }) => {
        loadBook(ctrl, bookId);
        if (wasFocused) dialog.querySelector('[data-dialog-close]')?.focus?.({ preventScroll: true });
      },
    });
  };

  formSettled(previousForm).then(() => {
    if (!current()) return null;
    return windowObject.fetch(`/notes/books/${bookId}`, {
      method: 'GET',
      headers: { Accept: 'text/html' },
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      signal: abort.signal,
    }).then(async (response) => {
      const html = response.ok ? await response.text() : '';
      // A superseded or dismissed load never fills or reopens the dialog.
      if (!current()) return;
      ctrl.abort = null;
      if (response.status === 404) {
        fail(LOAD_MISSING_MESSAGE);
        refreshShelf(ctrl);
        return;
      }
      const parsed = new windowObject.DOMParser().parseFromString(html, 'text/html');
      const form = parsed.querySelector(FORM_SELECTOR);
      const expectedPath = `/notes/books/${bookId}`;
      if (!response.ok || form?.getAttribute('action') !== expectedPath) {
        fail(LOAD_FAILURE_MESSAGE);
        return;
      }
      mountForm(ctrl, form, parsed.getElementById('book-delete-form'));
    });
  }).catch(() => {
    if (current()) fail(LOAD_FAILURE_MESSAGE);
  });
}

export function enhanceBookEditShelfDialog(scope = globalThis.document) {
  const document = scope?.nodeType === 9 ? scope : scope?.ownerDocument;
  const dialog = document?.getElementById?.(DIALOG_ID);
  const load = dialog?.querySelector?.(LOAD_SELECTOR);
  const dialogState = dialog?.__creatorCrateAppDialogState;
  if (!load || !dialogState || dialogState.bookEditShelfBound) return null;
  dialogState.bookEditShelfBound = true;

  const ctrl = {
    document,
    dialog,
    dialogState,
    load,
    mounted: [],
    form: null,
    deleteControl: null,
    bookId: null,
    generation: 0,
    abort: null,
    refreshRequest: null,
  };

  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0
      || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const trigger = event.target?.closest?.(TRIGGER_SELECTOR);
    const bookId = trigger?.getAttribute('data-book-edit-open');
    if (!bookId || !/^[1-9]\d*$/.test(bookId)) return;
    event.preventDefault();
    ctrl.bookId = bookId;
    if (dialog.open) dialogState.opener = trigger;
    else openAppDialogById(document, DIALOG_ID, trigger);
    loadBook(ctrl, bookId);
  });

  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    cancelLoad(ctrl);
    if (ctrl.deleteControl?.releaseUnresolved()) recoverShelf(ctrl, UNCERTAIN_DELETE_NOTE);
    else if (ctrl.form) recoverDismissedForm(ctrl, ctrl.form);
    // The binder has already returned focus to an opener that survived.
    restoreLostFocus(ctrl);
  });

  return ctrl;
}
