import { closeAppDialogById, openAppDialogById } from './app-dialogs.js';
import { isEnhancementBound, markEnhancementBound } from './dom.js';
import { initializeCreatorCrateDropdown } from './dropdowns.js';

const APP_CONFIRMATION_DIALOG_ID = 'app-confirmation-dialog';
const activeRequests = new WeakMap();
const pendingControls = new WeakSet();
const replayAuthorizations = new WeakSet();
const submitAuthorizations = new WeakSet();
const describedControls = new WeakMap();
// A form whose submit, however it is requested, must have been confirmed first.
const CONFIRMATION_REQUIRED_FORM_SELECTOR = 'form[data-confirm-submit-required]';

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
  cancelLabel = null,
  opener = null,
  replacementTemplate = null,
  destructive = true,
} = {}) {
  if (!document || activeRequests.has(document)) return Promise.resolve(false);

  const dialog = document.getElementById?.(APP_CONFIRMATION_DIALOG_ID);
  const state = dialog?.__creatorCrateAppDialogState;
  const titleNode = dialog?.querySelector?.(`#${APP_CONFIRMATION_DIALOG_ID}-title`);
  const messageNode = dialog?.querySelector?.('[data-app-dialog-confirmation-message]');
  const fieldHost = dialog?.querySelector?.('[data-app-dialog-confirmation-field]');
  const confirmControl = dialog?.querySelector?.('[data-app-dialog-confirmation-confirm]');
  const cancelControl = dialog?.querySelector?.('[data-app-dialog-confirmation-cancel]');
  if (!state || !titleNode || !messageNode || !confirmControl
    || (replacementTemplate && !fieldHost)) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const previousOnClose = state.onClose;
    const previousContent = {
      title: confirmationText(dialog, `#${APP_CONFIRMATION_DIALOG_ID}-title`, 'Confirm action'),
      message: confirmationText(dialog, '[data-app-dialog-confirmation-message]'),
      confirmLabel: confirmationText(dialog, '[data-app-dialog-confirmation-confirm]', 'Confirm'),
      cancelLabel: confirmationText(dialog, '[data-app-dialog-confirmation-cancel]', 'Cancel'),
      confirmDanger: confirmControl.classList?.contains?.('button-danger'),
      confirmSecondary: confirmControl.classList?.contains?.('button-secondary'),
    };
    let settled = false;
    let replacementSelect = null;
    let replacementDropdown = null;

    const clearField = () => {
      if (!fieldHost) return;
      fieldHost.replaceChildren?.();
      fieldHost.hidden = true;
    };
    const installReplacementDropdown = () => {
      const fragment = replacementTemplate?.content?.cloneNode?.(true);
      if (!fragment || !fieldHost) return !replacementTemplate;
      fieldHost.replaceChildren(fragment);
      replacementSelect = fieldHost.querySelector?.('[data-project-option-delete-replacement]');
      replacementDropdown = fieldHost.querySelector?.('[data-cc-dropdown]');
      if (!replacementSelect || !replacementDropdown) {
        clearField();
        replacementSelect = null;
        replacementDropdown = null;
        return false;
      }
      initializeCreatorCrateDropdown(replacementDropdown);
      const updateValidity = () => {
        confirmControl.disabled = Boolean(replacementSelect.required && !replacementSelect.value);
      };
      replacementSelect.addEventListener?.('change', updateValidity);
      replacementSelect.__creatorCrateConfirmationChange = updateValidity;
      fieldHost.hidden = false;
      updateValidity();
      return true;
    };

    const reset = () => {
      const onChange = replacementSelect?.__creatorCrateConfirmationChange;
      if (onChange) replacementSelect.removeEventListener?.('change', onChange);
      replacementSelect = null;
      replacementDropdown = null;
      clearField();
      titleNode.textContent = previousContent.title;
      messageNode.textContent = previousContent.message;
      confirmControl.textContent = previousContent.confirmLabel;
      if (cancelControl) cancelControl.textContent = previousContent.cancelLabel;
      confirmControl.disabled = false;
      confirmControl.classList?.toggle?.('button-danger', previousContent.confirmDanger);
      confirmControl.classList?.toggle?.('button-secondary', previousContent.confirmSecondary);
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
      if (replacementSelect?.required && !replacementSelect.value) {
        (replacementDropdown?.querySelector?.('summary') || replacementSelect).focus?.();
        return;
      }
      settle(replacementSelect
        ? { confirmed: true, value: replacementSelect.value }
        : true);
      closeAppDialogById(document, APP_CONFIRMATION_DIALOG_ID);
    };

    activeRequests.set(document, true);
    titleNode.textContent = String(title ?? '');
    messageNode.textContent = String(message ?? '');
    confirmControl.textContent = String(confirmLabel ?? '');
    if (cancelControl && cancelLabel) cancelControl.textContent = String(cancelLabel);
    confirmControl.classList?.toggle?.('button-danger', destructive);
    confirmControl.classList?.toggle?.('button-secondary', !destructive);
    clearField();
    if (!installReplacementDropdown()) {
      settle(false);
      return;
    }
    state.onClose = onClose;
    confirmControl.addEventListener?.('click', onConfirm);

    if (!openAppDialogById(document, APP_CONFIRMATION_DIALOG_ID, opener)) settle(false);
  });
}

// What a control's confirmation says when it depends on the moment it is asked:
// the resolver may return fields replacing those the control's attributes give.
export function describeAppConfirmation(control, resolve) {
  describedControls.set(control, resolve);
}

function bindConfirmationControl(control, document) {
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
      ...describedControls.get(control)?.(),
    }).then((confirmed) => {
      if (!confirmed || control.isConnected === false || control.disabled) return;
      replayAuthorizations.add(control);
      // The replay's submit happens within this click, so nothing else can use it.
      if (control.form) submitAuthorizations.add(control.form);
      try {
        control.click?.();
      } finally {
        replayAuthorizations.delete(control);
        if (control.form) submitAuthorizations.delete(control.form);
      }
    }).finally(() => {
      pendingControls.delete(control);
    });
  });
}

export function enhanceAppConfirmationControls(scope = globalThis.document) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;
  const document = confirmationDocument(scope);
  const controls = scope.querySelectorAll('[data-confirm]');
  controls.forEach((control) => bindConfirmationControl(control, document));
  return controls.length;
}

// A click is confirmed by its control, but form.requestSubmit() never clicks. Only
// the replay of a completed confirmation may submit one of these forms; any other
// submit is stopped here, ahead of the form's own handlers, and takes the same
// confirmation through the same control, under the same guards. Installed before
// the other enhancers, so it does not depend on any of them having run.
export function installAppConfirmationSubmitGate(document = globalThis.document) {
  if (!document?.addEventListener || isEnhancementBound(document, 'confirmationSubmitGateBound')) return;
  markEnhancementBound(document, 'confirmationSubmitGateBound');
  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (!form?.matches?.(CONFIRMATION_REQUIRED_FORM_SELECTOR)) return;
    if (submitAuthorizations.delete(form)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const control = Array.from(form.elements).find((candidate) => candidate.matches('[data-confirm]'));
    if (!control) return;
    bindConfirmationControl(control, document);
    control.click();
  }, true);
}
