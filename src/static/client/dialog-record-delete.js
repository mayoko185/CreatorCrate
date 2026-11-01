import { freezeAppDialog } from './app-dialogs.js';
import { isEnhancementBound, markEnhancementBound } from './dom.js';
import { removeStatusRetry, showStatusRetry } from './status-retry.js';

// Delete Book, Chapter and Page beside an open Edit dialog. The existing
// confirmation replays the native submit, and the F2 guard in app-dialogs.js has
// already refused it if an edit is unresolved; only then does it reach this form.
// The POST is sent once and never repeated. A refusal stays in the dialog with
// every draft kept; a lost or unreadable answer is settled by reading the record.
const ERROR_RETRY_KEY = 'checkRetryButton';
const DIALOG_FORM_SELECTOR = '[data-dialog-form]';

// What the application itself refused is known not to have written anything: a
// client error, maintenance, or a coded failure. Anything else (an unhandled
// 500, a login page, an unreadable answer) leaves the outcome unknown.
export function refusedWithoutWriting(payload, response) {
  if (payload?.status !== 'error') return false;
  const status = response?.status;
  return (status >= 400 && status < 500) || status === 503 || Boolean(payload.code);
}

// One read of a Page deletion's recovery status. Its action token, when it has one,
// goes only to the caller, which holds it no longer than the call that needs it.
export async function readPageDeletionStatus(windowObject, url) {
  let response;
  let payload;
  try {
    response = await windowObject.fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
    });
    payload = await response.json();
  } catch {
    return { state: 'unknown' };
  }
  if (response.status === 401 || response.status === 403) return { state: 'unauthorized' };
  if (response.ok && payload?.status === 'restored') return { state: 'restored', payload };
  if (response.ok && payload?.status === 'available' && payload.undoToken) return { state: 'available', payload };
  if (response.status === 410 && payload?.code === 'UNDO_EXPIRED') return { state: 'expired', payload };
  if (response.status === 404 && payload?.code === 'UNDO_UNAVAILABLE') return { state: 'unavailable' };
  return { state: 'unknown' };
}

function clearError(ctrl) {
  removeStatusRetry(ctrl, ERROR_RETRY_KEY);
  ctrl.error?.remove();
  ctrl.error = null;
}

// Created before the dialog freezes, which leaves out what already exists.
function prepareError(ctrl) {
  clearError(ctrl);
  const error = ctrl.document.createElement('div');
  error.className = 'error-summary';
  error.setAttribute('role', 'alert');
  error.setAttribute('data-dialog-delete-error', '');
  error.hidden = true;
  error.append(ctrl.document.createElement('p'));
  ctrl.button.closest('.notes-workspace-disclosure-content')?.prepend(error);
  ctrl.error = error;
}

function showError(ctrl, message) {
  if (!ctrl.error) prepareError(ctrl);
  ctrl.error.querySelector('p').textContent = message;
  ctrl.error.hidden = false;
}

function lock(ctrl) {
  ctrl.dialogState.submitting = true;
  ctrl.primaryForm?.setAttribute('aria-busy', 'true');
  ctrl.unfreeze = freezeAppDialog(ctrl.dialogState);
  ctrl.previousStatus = ctrl.status?.textContent ?? '';
  if (ctrl.status) ctrl.status.textContent = `Deleting ${ctrl.label}…`;
}

function unlock(ctrl) {
  ctrl.pending = false;
  ctrl.unresolved = false;
  ctrl.dialogState.submitting = false;
  ctrl.primaryForm?.removeAttribute('aria-busy');
  ctrl.unfreeze?.();
  ctrl.unfreeze = null;
  if (ctrl.status) ctrl.status.textContent = ctrl.previousStatus;
}

function refuse(ctrl, message) {
  unlock(ctrl);
  showError(ctrl, message);
  ctrl.button.focus({ preventScroll: true });
}

// The record is gone. The dialog stays frozen: the host closes it or leaves.
function finish(ctrl, outcome) {
  ctrl.gone = true;
  ctrl.pending = false;
  ctrl.dialogState.submitting = false;
  ctrl.onGone(outcome);
}

function showUnresolved(ctrl) {
  ctrl.pending = false;
  ctrl.unresolved = true;
  ctrl.dialogState.submitting = false;
  showError(ctrl, `Could not confirm whether the ${ctrl.label} was deleted, and it could not be checked.`);
  showStatusRetry({
    state: ctrl,
    status: ctrl.error,
    attribute: 'data-dialog-delete-check-retry',
    key: ERROR_RETRY_KEY,
    label: 'Check again',
    onRetry: () => reconcile(ctrl),
  })?.focus({ preventScroll: true });
}

// Only reads. Until one answers, Delete stays locked and the host stays as it is. A
// host with a stronger source of truth than the record's existence asks it first.
async function reconcile(ctrl) {
  ctrl.pending = true;
  ctrl.unresolved = false;
  ctrl.dialogState.submitting = true;
  showError(ctrl, `Could not confirm whether the ${ctrl.label} was deleted. Checking…`);
  const outcome = await ctrl.readOutcome?.();
  if (outcome?.redirectUrl) {
    finish(ctrl, { redirectUrl: outcome.redirectUrl });
    return;
  }
  if (outcome?.refusal) {
    refuse(ctrl, outcome.refusal);
    return;
  }
  if (outcome?.unknown) {
    showUnresolved(ctrl);
    return;
  }
  let response = null;
  try {
    response = await ctrl.window.fetch(ctrl.recordUrl, {
      method: 'GET',
      headers: { Accept: 'text/html' },
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
    });
  } catch { /* Reported below, with Check again. */ }
  if (response?.status === 404) {
    finish(ctrl, { message: `This ${ctrl.label} is no longer available.` });
    return;
  }
  if (response?.ok) {
    refuse(ctrl, `The deletion could not be confirmed, and this ${ctrl.label} still exists.`);
    return;
  }
  showUnresolved(ctrl);
}

async function submitDelete(ctrl) {
  prepareError(ctrl);
  ctrl.pending = true;
  lock(ctrl);
  let response;
  let payload = null;
  try {
    const body = new ctrl.window.URLSearchParams(new ctrl.window.FormData(ctrl.form));
    response = await ctrl.window.fetch(ctrl.form.getAttribute('action'), {
      method: 'POST',
      body,
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
      redirect: 'error',
    });
    payload = await response.json().catch(() => null);
  } catch {
    await reconcile(ctrl);
    return;
  }
  if (response.ok && payload?.status === 'success' && ctrl.validDestination(payload.redirectUrl)) {
    finish(ctrl, { message: payload.message, redirectUrl: payload.redirectUrl });
  } else if (response.status === 404 && payload?.status === 'error') {
    finish(ctrl, { message: payload.message });
  } else if (refusedWithoutWriting(payload, response)) {
    refuse(ctrl, payload.message || `The ${ctrl.label} could not be deleted.`);
  } else {
    await reconcile(ctrl);
  }
}

// Returns a handle with releaseUnresolved(), for a host whose dialog content does
// not outlive a dismissal: it reports whether an outcome was still unknown.
export function bindRecordDelete({
  dialog, dialogState, form, label, validDestination, onGone, readOutcome = null, formOutlivesDialog = true,
}) {
  if (!form || isEnhancementBound(form, 'recordDeleteBound')) return null;
  const document = form.ownerDocument;
  const button = Array.from(form.elements).find((control) => control.matches('[data-confirm]'));
  if (!button) return null;
  markEnhancementBound(form, 'recordDeleteBound');
  const ctrl = {
    document,
    window: document.defaultView || globalThis,
    dialog,
    dialogState,
    form,
    button,
    label,
    validDestination,
    onGone,
    readOutcome,
    recordUrl: form.getAttribute('action').replace(/\/delete$/, ''),
    primaryForm: dialog.querySelector(DIALOG_FORM_SELECTOR),
    status: dialog.querySelector('[data-dialog-status], [data-book-edit-save-status]'),
    error: null,
    pending: false,
    unresolved: false,
    gone: false,
    unfreeze: null,
    previousStatus: '',
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (ctrl.pending || ctrl.unresolved) return;
    void submitDelete(ctrl);
  });

  // A delete in flight may already have committed, so the dialog waits for it. The
  // Chapter dialogs' own close check holds it the same way.
  if (!dialogState.beforeClose) dialogState.beforeClose = () => !dialogState.submitting;
  // An unknown outcome stays on show for the next open; anything else is over. The
  // shelf mounts a new form for each open, so its old messages go with the old form.
  if (formOutlivesDialog) {
    dialog.addEventListener('close', () => {
      if (!dialog.open && !ctrl.pending && !ctrl.unresolved) clearError(ctrl);
    });
  }

  return {
    // Whether a save beside this delete must wait: it is in flight, its outcome is
    // unknown, or the record has gone.
    holdsRecord: () => ctrl.pending || ctrl.unresolved || ctrl.gone,
    releaseUnresolved() {
      if (!ctrl.unresolved) return false;
      unlock(ctrl);
      clearError(ctrl);
      return true;
    },
  };
}

// Edit Book on Book Detail, whose form is enhanced however the page was reached.
// A Book that is gone has no detail page left, so it returns to the Books shelf.
export function enhanceBookDetailDelete(scope = globalThis.document) {
  const document = scope?.nodeType === 9 ? scope : scope?.ownerDocument;
  const dialog = document?.getElementById?.('book-edit-dialog');
  const dialogState = dialog?.__creatorCrateAppDialogState;
  const form = dialog?.querySelector?.('#book-delete-form');
  if (!dialogState || !form) return null;
  return bindRecordDelete({
    dialog,
    dialogState,
    form,
    label: 'Book',
    validDestination: (url) => url === '/notes',
    onGone: () => (document.defaultView || globalThis).location.assign('/notes'),
  });
}
