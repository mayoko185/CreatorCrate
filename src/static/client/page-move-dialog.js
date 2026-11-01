import { appDialogFeedback, freezeAppDialog } from './app-dialogs.js';
import { refusedWithoutWriting } from './dialog-record-delete.js';
import { syncCreatorCrateDropdownFromNative } from './dropdowns.js';
import { noteDialogIsDirty, readNoteDialogBaseline } from './note-dialog-dirty.js';
import { removeStatusRetry, showStatusRetry } from './status-retry.js';

// Move Page beside an open Edit Page dialog. The F2 guard in app-dialogs.js has
// already refused a move during a save; only then does it reach this form. The POST
// is sent once and carries the destination alone, so a draft is neither saved nor
// lost: the dialog stays open and only the saved location changes. A lost or
// unreadable answer is settled by reading Page Detail, never by sending it again.
const RETRY_KEY = 'moveRetryButton';
const DESTINATION_URL = /^\/notes\/(?:books|chapters)\/[1-9]\d*$/;
const MOVE_TARGET_SELECTOR = '#note-move-target';

function clearNotice(ctrl) {
  removeStatusRetry(ctrl, RETRY_KEY);
  ctrl.notice?.remove();
  ctrl.notice = null;
}

// Mounted before the dialog freezes, which leaves out what already exists.
function showNotice(ctrl, message, { error = false } = {}) {
  clearNotice(ctrl);
  const notice = ctrl.document.createElement('div');
  notice.className = error ? 'error-summary' : 'notice notice--success';
  notice.setAttribute('role', error ? 'alert' : 'status');
  notice.setAttribute('data-dialog-move-notice', '');
  const text = ctrl.document.createElement('p');
  text.textContent = message;
  notice.append(text);
  ctrl.button.closest('.notes-workspace-disclosure-content')?.prepend(notice);
  ctrl.notice = notice;
  return notice;
}

function lock(ctrl) {
  ctrl.pending = true;
  ctrl.dialogState.submitting = true;
  ctrl.primaryForm?.setAttribute('aria-busy', 'true');
  ctrl.unfreeze = freezeAppDialog(ctrl.dialogState);
  ctrl.previousStatus = ctrl.status?.textContent ?? '';
  if (ctrl.status) ctrl.status.textContent = 'Moving Page…';
}

function unlock(ctrl) {
  ctrl.pending = false;
  ctrl.dialogState.submitting = false;
  ctrl.primaryForm?.removeAttribute('aria-busy');
  ctrl.unfreeze?.();
  ctrl.unfreeze = null;
  if (ctrl.status) ctrl.status.textContent = ctrl.previousStatus;
}

function showSelected(ctrl, value) {
  if (Array.from(ctrl.select.options).some((option) => option.value === value)) ctrl.select.value = value;
  syncCreatorCrateDropdownFromNative(ctrl.select);
}

function savedLabel(ctrl) {
  const option = Array.from(ctrl.select.options).find((candidate) => candidate.value === ctrl.saved);
  return option ? `“${option.textContent.trim()}”` : 'its current location';
}

// A retry that had focus hands it on before going, since from the body Escape would
// skip the dialog's guard. Move is unavailable while the outcome is unknown.
function offerRead(ctrl, label, attribute, read) {
  return showStatusRetry({
    state: ctrl,
    status: ctrl.notice,
    attribute,
    key: RETRY_KEY,
    label,
    onRetry: ({ wasFocused }) => {
      if (wasFocused) {
        const next = ctrl.uncertain ? ctrl.button.closest('details')?.querySelector('summary') : ctrl.button;
        next?.focus({ preventScroll: true });
      }
      return read();
    },
  });
}

async function refreshAfterMove(ctrl) {
  const installed = await ctrl.refresh({ failureMessage: 'The Page was moved, but this page could not refresh.' });
  if (installed !== false || !ctrl.notice) return;
  ctrl.refreshFailed = true;
  removeStatusRetry(ctrl, RETRY_KEY);
  ctrl.notice.querySelector('p').textContent = `${ctrl.movedMessage} This page could not refresh.`;
  offerRead(ctrl, 'Retry refresh', 'data-page-move-refresh-retry', () => refreshAfterMove(ctrl));
}

function acknowledged(ctrl, payload) {
  unlock(ctrl);
  ctrl.saved = payload.destination.container;
  showSelected(ctrl, ctrl.saved);
  const dirty = noteDialogIsDirty(ctrl.dialogState.form, readNoteDialogBaseline(ctrl.dialogState.form));
  ctrl.movedMessage = dirty ? `${payload.message} Your unsaved edits are still here.` : payload.message;
  showNotice(ctrl, ctrl.movedMessage);
  ctrl.showMoved(payload);
  return refreshAfterMove(ctrl);
}

// Stays on the Page with the chosen destination kept. A destination may have gone,
// so this page reads again.
function refused(ctrl, payload) {
  unlock(ctrl);
  showNotice(ctrl, payload.message || 'The Page could not be moved.', { error: true });
  ctrl.button.focus({ preventScroll: true });
  ctrl.readQuietly();
}

// Only reads. A successful read settles the outcome in adoptTargets, whichever
// request made it; until one does, Move stays refused and the draft stays usable.
async function checkOutcome(ctrl) {
  showNotice(ctrl, 'Could not confirm whether the Page was moved. Checking…', { error: true });
  await ctrl.refresh({ failureMessage: 'Could not confirm whether the Page was moved, and this page could not refresh.' });
  if (ctrl.pending) unlock(ctrl);
  if (!ctrl.uncertain) return;
  ctrl.button.disabled = true;
  showNotice(ctrl, 'Could not confirm whether the Page was moved, and it could not be checked. Your draft is kept here.', { error: true });
  offerRead(ctrl, 'Check again', 'data-page-move-check-retry', () => checkOutcome(ctrl))?.focus({ preventScroll: true });
}

function settleUncertain(ctrl) {
  const { previous } = ctrl.uncertain;
  ctrl.uncertain = null;
  ctrl.button.disabled = false;
  const moved = ctrl.saved !== previous;
  const message = moved
    ? `This Page is now in ${savedLabel(ctrl)}.`
    : `The Page was not moved. It is still in ${savedLabel(ctrl)}.`;
  showNotice(ctrl, message, { error: !moved });
  appDialogFeedback(ctrl.document, message);
}

async function submitMove(ctrl, body) {
  const requested = ctrl.select.value;
  ctrl.refreshFailed = false;
  showNotice(ctrl, '').hidden = true;
  lock(ctrl);
  let response;
  let payload = null;
  try {
    response = await ctrl.window.fetch(ctrl.form.getAttribute('action'), {
      method: 'POST',
      body,
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
      redirect: 'error',
    });
    payload = await response.json().catch(() => null);
  } catch { /* Settled below, by a read. */ }
  if (response?.ok && payload?.status === 'success'
    && DESTINATION_URL.test(payload.destination?.url || '')
    && typeof payload.destination?.container === 'string') {
    await acknowledged(ctrl, payload);
  } else if (response && refusedWithoutWriting(payload, response)) {
    refused(ctrl, payload);
  } else {
    ctrl.uncertain = { previous: ctrl.saved, requested };
    await checkOutcome(ctrl);
  }
}

// The caller supplies the host's reads: refresh answers true once installed and false
// if it failed. Returns what that host needs:
// adoptTargets for each read of Page Detail, and reset when the dialog closes.
export function bindPageMove({
  dialog, dialogState, refresh, readQuietly, showMoved,
}) {
  const form = dialog.querySelector('#note-move-form');
  const select = dialog.querySelector(MOVE_TARGET_SELECTOR);
  const button = dialog.querySelector('button[form="note-move-form"]');
  if (!form || !select || !button) return null;
  const document = form.ownerDocument;
  const ctrl = {
    document,
    window: document.defaultView || globalThis,
    dialogState,
    form,
    select,
    button,
    refresh,
    readQuietly,
    showMoved,
    primaryForm: dialogState.form,
    status: dialog.querySelector('[data-dialog-status]'),
    saved: Array.from(select.options).find((option) => option.defaultSelected)?.value ?? select.value,
    notice: null,
    pending: false,
    uncertain: null,
    unfreeze: null,
    previousStatus: '',
    movedMessage: '',
    refreshFailed: false,
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (ctrl.pending || ctrl.uncertain) return;
    // Read before the dialog freezes, so the request holds what the user chose.
    void submitMove(ctrl, new ctrl.window.URLSearchParams(new ctrl.window.FormData(form)));
  });

  return {
    // Where the Page was last known to live, as 'chapter:7' or 'book:3'.
    savedContainer: () => ctrl.saved,
    // The destinations and saved location as last read. A destination the user has
    // chosen but not moved to stays chosen for as long as it exists.
    adoptTargets(parsed) {
      const next = parsed.querySelector(MOVE_TARGET_SELECTOR);
      if (!next) return;
      const chosen = select.value !== ctrl.saved ? select.value : null;
      const choices = (control) => Array.from(control.options, (option) => [option.value, option.textContent]);
      ctrl.saved = next.value;
      if (JSON.stringify(choices(select)) !== JSON.stringify(choices(next))) {
        select.replaceChildren(...Array.from(next.options));
      }
      const held = chosen && Array.from(select.options).some((option) => option.value === chosen);
      showSelected(ctrl, held ? chosen : ctrl.saved);
      if (ctrl.uncertain) settleUncertain(ctrl);
      else if (ctrl.refreshFailed) {
        ctrl.refreshFailed = false;
        if (ctrl.notice) showNotice(ctrl, ctrl.movedMessage);
      }
    },
    // An unknown outcome stays on show for the next open; anything else is over.
    reset() {
      if (ctrl.uncertain) return;
      ctrl.refreshFailed = false;
      clearNotice(ctrl);
      showSelected(ctrl, ctrl.saved);
    },
  };
}
