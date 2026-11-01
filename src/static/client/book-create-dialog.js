import { setAppDialogBaseline } from './app-dialogs.js';
import { adoptBookTransferSnapshot } from './book-transfer.js';
import { adoptBookReorderSnapshot } from './dedicated-reorder.js';
import { beginNotesBooksLiveRefresh, installNotesBooksLiveRegionSnapshot } from './live-regions.js';
import { removeStatusRetry, showStatusRetry } from './status-retry.js';

// The Books shelf New Book dialog, saved through the shared async dialog binder
// as multipart so an optional cover travels with it. A created Book leaves the
// user on the shelf: the binder closes the dialog and shows its message in the
// page feedback, this module adds a View Book link to it, and the shelf and the
// Book lists beside it refresh with a GET. The create POST is never repeated:
// a failed refresh offers Retry refresh, which only refreshes again. A directly
// visited /notes/books/new renders its form native and is left alone.
export const BOOK_CREATE_DIALOG_ID = 'book-create-dialog';

const SHELF_SELECTOR = '[data-notes-books-live-region]';
const TOOLBAR_TRIGGER_SELECTOR = `.page-heading [data-dialog-open="${BOOK_CREATE_DIALOG_ID}"]`;
const ORDER_TRIGGER_SELECTOR = '.page-heading [data-dialog-open="books-order-dialog"]';
const TRANSFER_TRIGGER_SELECTOR = '.page-heading [data-dialog-open="book-transfer-dialog"]';
const RETRY_KEY = 'bookCreateRetryButton';
const REFRESH_FAILURE_MESSAGE = 'Books could not refresh.';
const REFRESHING_MESSAGE = 'Refreshing Books…';
const UNCONFIRMED_MESSAGE = 'Could not confirm whether the Book was created. It may already exist, so check the Books shelf before trying again.';

function createdBookUrl(payload) {
  const url = payload?.book?.url;
  return typeof url === 'string' && /^\/notes\/books\/\d+$/.test(url) ? url : null;
}

function feedbackText(document) {
  return document.querySelector('[data-dialog-feedback] [data-dialog-feedback-text]');
}

// Runs after the binder writes the success message, so the link and Dismiss sit
// inside the feedback text and go with it on the next write. The shelf keeps
// its scroll position, so the confirmation stays in view until dismissed.
export function decorateFeedback(document, url) {
  const feedback = document.querySelector('[data-dialog-feedback]');
  const text = feedbackText(document);
  if (!feedback || !text) return;
  if (url) {
    const link = document.createElement('a');
    link.href = url;
    link.textContent = 'View Book';
    link.setAttribute('data-book-create-view', '');
    text.append(' ', link);
  }
  feedback.classList.add('app-dialog-feedback--pinned');
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'button button-small button-secondary';
  dismiss.textContent = 'Dismiss';
  dismiss.setAttribute('data-book-create-dismiss', '');
  dismiss.addEventListener('click', () => {
    feedback.classList.remove('app-dialog-feedback--pinned');
    feedback.hidden = true;
    feedback.setAttribute('hidden', '');
    text.textContent = '';
    document.querySelector(TOOLBAR_TRIGGER_SELECTOR)?.focus?.({ preventScroll: true });
  });
  text.append(' ', dismiss);
}

// A refresh note has its own span so a retry can replace it; an empty message
// removes it. Returns the Retry refresh button when one is offered.
function setRefreshNote(document, dialogState, message, onRetry = null) {
  removeStatusRetry(dialogState, RETRY_KEY);
  const text = feedbackText(document);
  let note = text?.querySelector('[data-book-create-refresh-note]');
  if (!message) {
    note?.remove();
    return null;
  }
  if (!text) return null;
  if (!note) {
    note = document.createElement('span');
    note.setAttribute('data-book-create-refresh-note', '');
    text.append(note);
  }
  note.textContent = ` ${message} `;
  if (!onRetry) return null;
  return showStatusRetry({
    state: dialogState,
    status: text,
    attribute: 'data-book-create-refresh-retry',
    key: RETRY_KEY,
    onRetry,
  });
}

// The empty-state New Book lives in the refreshed region; when it took focus
// with it, the heading's New Book takes over.
function restoreLostFocus(document) {
  const active = document.activeElement;
  if (active && active !== document.body && active.isConnected) return;
  document.querySelector(TOOLBAR_TRIGGER_SELECTOR)?.focus?.({ preventScroll: true });
}

// The heading's Change book order appears once there are two Books to order.
function syncOrderTrigger(document, parsed) {
  const replacement = parsed.querySelector(ORDER_TRIGGER_SELECTOR);
  const transfer = document.querySelector(TRANSFER_TRIGGER_SELECTOR);
  if (!transfer) return;
  const replacementTransfer = parsed.querySelector(TRANSFER_TRIGGER_SELECTOR);
  if (replacementTransfer) transfer.className = replacementTransfer.className;
  const trigger = document.querySelector(ORDER_TRIGGER_SELECTOR);
  if (replacement && !trigger) transfer.after(replacement);
  if (trigger && !replacement) {
    if (document.activeElement === trigger) transfer.focus({ preventScroll: true });
    trigger.remove();
  }
}

// The shelf as the server renders it now, read but not yet shown.
export async function fetchBooksShelf(document) {
  const windowObject = document.defaultView || globalThis;
  const authority = beginNotesBooksLiveRefresh(document);
  if (authority === null) throw new Error('Live refresh is unavailable.');
  const response = await windowObject.fetch('/notes', {
    method: 'GET',
    headers: { Accept: 'text/html' },
    credentials: 'same-origin',
    redirect: 'error',
  });
  if (!response?.ok) throw new Error('Books response failed.');
  const parsed = new windowObject.DOMParser().parseFromString(await response.text(), 'text/html');
  return { authority, parsed };
}

// Shows a fetched shelf and the Book lists beside it. False when it has no
// region or a newer refresh has already been shown.
export function installBooksShelf(document, { authority, parsed }) {
  const shelf = parsed.querySelector(SHELF_SELECTOR);
  if (!shelf || installNotesBooksLiveRegionSnapshot(document, authority, shelf) !== 'installed') return false;
  adoptBookTransferSnapshot(document, parsed);
  adoptBookReorderSnapshot(document, parsed);
  syncOrderTrigger(document, parsed);
  return true;
}

async function fetchAndInstallShelf(document, dialogState, request) {
  const snapshot = await fetchBooksShelf(document);
  // A later refresh has already taken over and reports its own outcome.
  if (dialogState.bookCreateRefresh !== request) return false;
  if (!installBooksShelf(document, snapshot)) throw new Error('Books response could not be installed.');
  return true;
}

function refreshShelf(document, dialogState, { focusRetry = false } = {}) {
  const request = {};
  dialogState.bookCreateRefresh = request;
  return fetchAndInstallShelf(document, dialogState, request).then((installed) => {
    if (!installed) return;
    setRefreshNote(document, dialogState, '');
    restoreLostFocus(document);
  }).catch(() => {
    if (dialogState.bookCreateRefresh !== request) return;
    const retry = setRefreshNote(document, dialogState, REFRESH_FAILURE_MESSAGE, ({ wasFocused }) => {
      setRefreshNote(document, dialogState, REFRESHING_MESSAGE);
      refreshShelf(document, dialogState, { focusRetry: wasFocused });
    });
    if (focusRetry) retry?.focus?.();
  });
}

function showUnconfirmed(document, dialog, dialogState) {
  const errorText = dialog.querySelector('[data-dialog-error-text]');
  if (errorText) errorText.textContent = UNCONFIRMED_MESSAGE;
  const status = dialog.querySelector('[data-dialog-status]');
  if (status) status.textContent = '';
  // Only reads: a Book that did commit is on the shelf when the dialog closes.
  const request = {};
  dialogState.bookCreateRefresh = request;
  fetchAndInstallShelf(document, dialogState, request).catch(() => {});
}

// What the application itself refused is known not to have created a Book: a
// client error, maintenance, or a coded cover failure. Anything else (an
// unhandled 500, a login page, an unreadable answer) leaves the outcome unknown.
function refusedWithoutCreating(payload, response) {
  if (payload?.status !== 'error') return false;
  const status = response?.status;
  return (status >= 400 && status < 500) || status === 503 || Boolean(payload.code);
}

export function enhanceBookCreateDialog(scope = globalThis.document) {
  const document = scope?.nodeType === 9 ? scope : scope?.ownerDocument;
  const dialog = document?.getElementById?.(BOOK_CREATE_DIALOG_ID);
  const dialogState = dialog?.__creatorCrateAppDialogState;
  const form = dialogState?.form;
  if (!form || form.getAttribute('data-dialog-async') !== 'true' || dialogState.bookCreateBound) return null;
  dialogState.bookCreateBound = true;

  // A refused create keeps the title and the selected cover file.
  dialogState.preserveValuesOnError = true;
  // Only the title is restorable: reset clears the file input by itself, and a
  // dismissal also clears a refused create's errors and status.
  setAppDialogBaseline(document, BOOK_CREATE_DIALOG_ID, { title: '' });

  const coverDisclosure = form.querySelector('[data-dialog-field="cover"]')?.closest('details');
  const previousOnClose = dialogState.onClose;
  dialogState.onClose = (...args) => {
    if (coverDisclosure) coverDisclosure.open = false;
    return previousOnClose?.(...args);
  };

  // A create in flight may already have written the Book, so the dialog stays
  // open until its outcome is known rather than resetting the draft.
  const previousBeforeClose = dialogState.beforeClose;
  dialogState.beforeClose = (context) => {
    if (dialogState.submitting) return false;
    return previousBeforeClose ? previousBeforeClose(context) : true;
  };

  dialogState.onUnconfirmedSubmit = () => showUnconfirmed(document, dialog, dialogState);

  const previousFailure = dialogState.onFailedSubmit;
  dialogState.onFailedSubmit = (payload, response) => {
    previousFailure?.(payload, response);
    if (!refusedWithoutCreating(payload, response)) {
      showUnconfirmed(document, dialog, dialogState);
      return;
    }
    // The cover's error sits in a disclosure the user may have closed, or in one
    // that hides the invalid control from the binder's focus. A title error
    // takes focus first, as the binder already gave it.
    if (payload.errors?.cover && !payload.errors?.title && coverDisclosure) {
      coverDisclosure.open = true;
      form.querySelector('[name="cover"]')?.focus?.({ preventScroll: true });
    }
  };

  const previousSuccess = dialogState.onSuccessfulSubmit;
  dialogState.onSuccessfulSubmit = (payload) => {
    const result = previousSuccess?.(payload);
    if (result === true) return true;
    const url = createdBookUrl(payload);
    // After the binder records the fresh defaults, shows the message and
    // closes the dialog.
    Promise.resolve().then(() => {
      removeStatusRetry(dialogState, RETRY_KEY);
      decorateFeedback(document, url);
      refreshShelf(document, dialogState);
    });
    return result;
  };
  return dialogState;
}
