import { closeAppDialogById, openAppDialogById } from './app-dialogs.js';
import { isEnhancementBound, markEnhancementBound } from './dom.js';

const APP_CONFIRMATION_DIALOG_ID = 'app-confirmation-dialog';
const activeRequests = new WeakMap();
const pendingControls = new WeakSet();
const replayAuthorizations = new WeakSet();

function confirmationDocument(scope) {
  if (!scope) return null;
  if (scope.nodeType === 9) return scope;
  return scope.ownerDocument || globalThis.document || null;
}

function confirmationText(dialog, selector, fallback = '') {
  return dialog.querySelector?.(selector)?.textContent || fallback;
}

export function requestAppConfirmation(document, {
  message = '',
  title = 'Confirm action',
  confirmLabel = 'Confirm',
  opener = null,
} = {}) {
  if (!document || activeRequests.has(document)) return Promise.resolve(false);

  const dialog = document.getElementById?.(APP_CONFIRMATION_DIALOG_ID);
  const state = dialog?.__creatorCrateAppDialogState;
  const titleNode = dialog?.querySelector?.(`#${APP_CONFIRMATION_DIALOG_ID}-title`);
  const messageNode = dialog?.querySelector?.('[data-app-dialog-confirmation-message]');
  const confirmControl = dialog?.querySelector?.('[data-app-dialog-confirmation-confirm]');
  if (!state || !titleNode || !messageNode || !confirmControl) return Promise.resolve(false);

  return new Promise((resolve) => {
    const previousOnClose = state.onClose;
    const previousContent = {
      title: confirmationText(dialog, `#${APP_CONFIRMATION_DIALOG_ID}-title`, 'Confirm action'),
      message: confirmationText(dialog, '[data-app-dialog-confirmation-message]'),
      confirmLabel: confirmationText(dialog, '[data-app-dialog-confirmation-confirm]', 'Confirm'),
    };
    let settled = false;

    const reset = () => {
      titleNode.textContent = previousContent.title;
      messageNode.textContent = previousContent.message;
      confirmControl.textContent = previousContent.confirmLabel;
    };
    const cleanup = () => {
      confirmControl.removeEventListener?.('click', onConfirm);
      if (state.onClose === onClose) state.onClose = previousOnClose;
      activeRequests.delete(document);
      reset();
    };
    const settle = (confirmed) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(confirmed);
    };
    const onClose = () => {
      try {
        previousOnClose?.();
      } finally {
        settle(false);
      }
    };
    const onConfirm = (event) => {
      event.preventDefault?.();
      settle(true);
      closeAppDialogById(document, APP_CONFIRMATION_DIALOG_ID);
    };

    activeRequests.set(document, true);
    titleNode.textContent = String(title ?? '');
    messageNode.textContent = String(message ?? '');
    confirmControl.textContent = String(confirmLabel ?? '');
    state.onClose = onClose;
    confirmControl.addEventListener?.('click', onConfirm);

    if (!openAppDialogById(document, APP_CONFIRMATION_DIALOG_ID, opener)) settle(false);
  });
}

export function enhanceAppConfirmationControls(scope = globalThis.document) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;
  const document = confirmationDocument(scope);
  const controls = scope.querySelectorAll('[data-confirm]');
  controls.forEach((control) => {
    if (isEnhancementBound(control, 'confirmationDialogBound')) return;
    markEnhancementBound(control, 'confirmationDialogBound');
    control.addEventListener?.('click', (event) => {
      if (replayAuthorizations.has(control)) {
        replayAuthorizations.delete(control);
        return;
      }

      event.preventDefault?.();
      if (pendingControls.has(control)) return;
      pendingControls.add(control);
      requestAppConfirmation(document, {
        message: control.getAttribute?.('data-confirm') || '',
        title: control.getAttribute?.('data-confirm-dialog-title') || 'Confirm action',
        confirmLabel: control.getAttribute?.('data-confirm-dialog-confirm-label') || 'Confirm',
        opener: control,
      }).then((confirmed) => {
        if (!confirmed || control.isConnected === false || control.disabled) return;
        replayAuthorizations.add(control);
        try {
          control.click?.();
        } finally {
          replayAuthorizations.delete(control);
        }
      }).finally(() => {
        pendingControls.delete(control);
      });
    });
  });
  return controls.length;
}
