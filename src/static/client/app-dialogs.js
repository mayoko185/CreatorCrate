import {
  isEnhancementBound,
  markEnhancementBound,
  setHidden,
} from './dom.js';
import { enhanceCategoryReorder } from './category-reorder.js';
import { enhanceConfirmations } from './category-details.js';
import {
  cleanupScrollableCategoryDialogDropdowns,
  CC_DROPDOWN_SELECTOR,
  creatorCrateDropdownForNativeSelect,
  enhanceDropdowns,
  syncCreatorCrateDropdownDisabledState,
  syncCreatorCrateDropdownFromNative,
  updateAssetViewerFilterDisclosureState,
} from './dropdowns.js';
import {
  ASSET_GRID_SIZE_CONFIG,
  ASSET_LIST_SIZE_CONFIG,
  gridSizeIsValid,
  writeGridSize,
} from './size-preferences.js';
export function enhanceAutoSubmit(scope = globalThis.document) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;
  const controls = scope.querySelectorAll('[data-autosubmit]');
  controls.forEach((control) => {
    if (control.form?.matches?.('.page-size-form')) {
      return;
    }
    if (isEnhancementBound(control, 'autoSubmitBound')) return;
    markEnhancementBound(control, 'autoSubmitBound');

    if (control.dataset?.autosubmit === 'submit') {
      let submitting = false;
      control.addEventListener('change', () => {
        const form = control.form;
        if (!form || submitting) return;
        submitting = true;
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.submit?.();
      });
      return;
    }

    const state = {
      confirmedChecked: Boolean(control.checked),
      pending: false,
      requestedChecked: Boolean(control.checked),
    };

    control.addEventListener('change', (event) => {
      const form = control.form;
      if (!form) return;

      event.preventDefault?.();

      if (state.pending) {
        control.checked = state.requestedChecked;
        return;
      }

      const previousChecked = state.confirmedChecked;
      const requestedChecked = Boolean(control.checked);
      state.pending = true;
      state.requestedChecked = requestedChecked;
      form.setAttribute?.('aria-busy', 'true');
      form.setAttribute?.('data-category-enabled-state', 'pending');
      const status = form.querySelector?.('[data-category-enabled-status]');
      if (status) status.textContent = 'Saving category status.';

      Promise.resolve().then(() => {
        if (typeof globalThis.fetch !== 'function' || typeof globalThis.FormData !== 'function'
          || typeof globalThis.URLSearchParams !== 'function') {
          throw new Error('In-place category status updates are unavailable.');
        }

        const action = form.action || form.getAttribute?.('action');
        const method = String(form.method || form.getAttribute?.('method') || 'POST').toUpperCase();
        return globalThis.fetch(action, {
          method,
          // Send as application/x-www-form-urlencoded (not multipart/form-data):
          // the server only parses urlencoded/JSON bodies, so a raw FormData
          // request would arrive with an empty req.body and fail CSRF (403).
          body: new globalThis.URLSearchParams(new globalThis.FormData(form)),
          credentials: 'same-origin',
          redirect: 'follow',
        });
      }).then((response) => {
        if (!response?.ok) throw new Error('Category status update failed.');
        state.confirmedChecked = requestedChecked;
        state.pending = false;
        form.removeAttribute?.('aria-busy');
        form.removeAttribute?.('data-category-enabled-state');
        if (status) status.textContent = `${requestedChecked ? 'Enabled' : 'Disabled'} status saved.`;
      }).catch(() => {
        control.checked = previousChecked;
        state.confirmedChecked = previousChecked;
        state.pending = false;
        form.removeAttribute?.('aria-busy');
        form.setAttribute?.('data-category-enabled-state', 'error');
        if (status) status.textContent = 'Could not save category status. The previous status was restored.';
      });
    });
  });
  return controls.length;
}

const APP_DIALOG_SELECTOR = '[data-app-dialog]';
const APP_DIALOG_TRIGGER_SELECTOR = '[data-dialog-open]';
const APP_DIALOG_CLOSE_SELECTOR = '[data-dialog-close]';
const APP_DIALOG_FORM_SELECTOR = '[data-dialog-form]';
const PROJECT_ASSETS_DEFAULTS_DIALOG_ID = 'project-assets-defaults-dialog';
const ASSET_BROWSER_DEFAULT_LIVE_FORM_SELECTOR = '[data-asset-browser-default-live]';
const APP_DIALOG_FOCUSABLE_SELECTOR = 'a[href], button, input, select, textarea, summary, [tabindex]';
const PROJECT_ASSET_CATEGORY_MANAGEMENT_DIALOG_ID = 'project-asset-category-management-dialog';
const PROJECT_ASSET_CATEGORY_MANAGEMENT_BODY_SELECTOR = '.project-asset-category-management-dialog-body';
const PROJECT_ASSET_CATEGORY_MANAGEMENT_ADD_FORM_SELECTOR = '#project-category-management-add-form';
const PROJECT_ASSET_CATEGORY_MANAGEMENT_RENAME_FORM_SELECTOR = '.category-name-form';
const PROJECT_ASSET_CATEGORY_MANAGEMENT_DELETE_FORM_SELECTOR = '[data-category-management-delete-form]';

function appDialogDocument(scope) {
  if (!scope) return null;
  if (scope.nodeType === 9) return scope;
  return scope.ownerDocument || globalThis.document || null;
}

function appDialogFocusableAncestorHidden(element, dialog) {
  let ancestor = element?.parentElement || element?.parentNode || null;
  while (ancestor && ancestor !== dialog) {
    if (ancestor.hidden || ancestor.hasAttribute?.('hidden')) return true;
    if (ancestor.tagName === 'DETAILS' && ancestor.open !== true && element.tagName !== 'SUMMARY') return true;
    ancestor = ancestor.parentElement || ancestor.parentNode || null;
  }
  return false;
}

function appDialogFocusable(dialog) {
  return Array.from(dialog?.querySelectorAll?.(APP_DIALOG_FOCUSABLE_SELECTOR) || [])
    .filter((element) => !element.disabled
      && element.getAttribute?.('aria-hidden') !== 'true'
      && element.getAttribute?.('aria-disabled') !== 'true'
      && !element.hidden
      && !element.hasAttribute?.('hidden')
      && !appDialogFocusableAncestorHidden(element, dialog));
}

function appDialogBodyLock(state, locked) {
  const body = state.document?.body;
  if (!body?.classList) return;
  if (locked) body.classList.add('app-dialog-open');
  else if (!state.document.querySelector?.(`${APP_DIALOG_SELECTOR}[open]`)) body.classList.remove('app-dialog-open');
}

function appDialogRestoreFocus(state) {
  const opener = state.opener && state.document.contains?.(state.opener)
    ? state.opener
    : state.document.querySelector?.(`${APP_DIALOG_TRIGGER_SELECTOR}[data-dialog-open="${state.dialog.id}"]`);
  state.opener = null;
  opener?.focus?.({ preventScroll: true });
}

function appDialogFinishClose(state) {
  cleanupScrollableCategoryDialogDropdowns(state.dialog);
  state.onClose?.();
  state.open = false;
  appDialogBodyLock(state, false);
  appDialogRestoreFocus(state);
}

function appDialogCloseOpenDropdown(state) {
  const dropdown = state.dialog.querySelector?.(`${CC_DROPDOWN_SELECTOR}[open]`);
  if (!dropdown) return false;
  dropdown.open = false;
  dropdown.removeAttribute?.('open');
  updateAssetViewerFilterDisclosureState(dropdown);
  dropdown.querySelector?.('summary')?.focus?.({ preventScroll: true });
  return true;
}

function appDialogClose(state) {
  if (typeof state.dialog.close === 'function' && state.dialog.open) {
    state.dialog.close();
    return;
  }
  state.dialog.removeAttribute?.('open');
  state.dialog.open = false;
  appDialogFinishClose(state);
}

function appDialogValues(form) {
  const values = {};
  Array.from(form?.querySelectorAll?.('select, input, textarea') || []).forEach((control) => {
    if (control.name && !Object.hasOwn(values, control.name)) values[control.name] = control.value;
  });
  return values;
}

function syncProjectAssetsSizePreferences(dialog, values) {
  const dialogId = dialog?.id || dialog?.getAttribute?.('id');
  if (dialogId !== PROJECT_ASSETS_DEFAULTS_DIALOG_ID) return;

  if (gridSizeIsValid(values?.gridSize, ASSET_GRID_SIZE_CONFIG)) {
    writeGridSize(values.gridSize, ASSET_GRID_SIZE_CONFIG.storageKey);
  }
  if (gridSizeIsValid(values?.listSize, ASSET_LIST_SIZE_CONFIG)) {
    writeGridSize(values.listSize, ASSET_LIST_SIZE_CONFIG.storageKey);
  }
}

function appDialogAllowsSubmittedValue(form, name, value) {
  if (name !== 'listSize' || value !== 'default') return true;
  const dialog = form?.closest?.(APP_DIALOG_SELECTOR);
  const dialogId = dialog?.id || dialog?.getAttribute?.('id');
  return dialogId !== PROJECT_ASSETS_DEFAULTS_DIALOG_ID;
}

function appDialogApplyValues(form, values = {}) {
  form?.querySelectorAll?.('option[data-dialog-submitted-value]')
    .forEach((option) => option.remove?.());
  Object.entries(values).forEach(([name, value]) => {
    if (name === '_csrf') return;
    const control = form?.querySelector?.(`[name="${name}"]`);
    if (!control) return;
    const stringValue = String(value ?? '');
    if (!appDialogAllowsSubmittedValue(form, name, stringValue)) {
      syncCreatorCrateDropdownFromNative(control);
      return;
    }
    if (control.tagName === 'SELECT') {
      const options = Array.from(control.options || control.querySelectorAll?.('option') || []);
      if (!options.some((option) => String(option.value) === stringValue)) {
        const option = control.ownerDocument?.createElement?.('option');
        if (option) {
          option.value = stringValue;
          option.textContent = `Submitted value: ${stringValue}`;
          option.setAttribute?.('data-dialog-submitted-value', '');
          control.appendChild?.(option);
        }
      }
    }
    control.value = stringValue;
    syncCreatorCrateDropdownFromNative(control);
  });
}

function appDialogClearErrors(state) {
  state.form?.querySelectorAll?.('[data-dialog-field]').forEach((field) => {
    field.classList?.remove('field-error');
    const control = field.querySelector?.('select, input:not([type="hidden"]), textarea');
    control?.removeAttribute?.('aria-invalid');
    control?.removeAttribute?.('aria-describedby');
    const summary = creatorCrateDropdownForNativeSelect(control)?.querySelector?.('summary');
    summary?.removeAttribute?.('aria-invalid');
    summary?.removeAttribute?.('aria-describedby');
    field.querySelector?.('.field-error-message')?.remove?.();
  });
  const error = state.dialog.querySelector?.('[data-dialog-error]');
  if (error) {
    error.hidden = true;
    error.setAttribute?.('hidden', '');
  }
  const errorText = state.dialog.querySelector?.('[data-dialog-error-text]');
  if (errorText) errorText.textContent = '';
  const errorList = state.dialog.querySelector?.('[data-dialog-error-list]');
  if (errorList) errorList.textContent = '';
}

function appDialogShowErrors(state, errors = {}, message = 'Fix the highlighted fields and try again.') {
  const error = state.dialog.querySelector?.('[data-dialog-error]');
  if (error) {
    error.hidden = false;
    error.removeAttribute?.('hidden');
  }
  const errorText = state.dialog.querySelector?.('[data-dialog-error-text]');
  if (errorText) errorText.textContent = message;
  const errorList = state.dialog.querySelector?.('[data-dialog-error-list]');
  if (errorList) errorList.textContent = Object.values(errors).join(' ');

  Object.entries(errors).forEach(([name, fieldError]) => {
    const field = Array.from(state.form?.querySelectorAll?.('[data-dialog-field]') || [])
      .find((candidate) => candidate.getAttribute?.('data-dialog-field') === name);
    if (!field) return;
    field.classList?.add('field-error');
    const control = field.querySelector?.('select, input:not([type="hidden"]), textarea');
    if (!control) return;
    control.setAttribute?.('aria-invalid', 'true');
    const errorId = `${control.id || `dialog-${name}`}-error`;
    control.setAttribute?.('aria-describedby', errorId);
    const summary = creatorCrateDropdownForNativeSelect(control)?.querySelector?.('summary');
    summary?.setAttribute?.('aria-invalid', 'true');
    summary?.setAttribute?.('aria-describedby', errorId);
    const messageElement = control.ownerDocument?.createElement?.('span');
    if (!messageElement) return;
    messageElement.className = 'field-error-message';
    messageElement.id = errorId;
    messageElement.textContent = fieldError;
    field.appendChild?.(messageElement);
  });
  state.form?.querySelector?.('[aria-invalid="true"]')?.focus?.({ preventScroll: true });
}

function appDialogStatus(state, message, error = false) {
  const status = state.dialog.querySelector?.('[data-dialog-status]');
  if (status) status.textContent = message || '';
  if (message) state.dialog.setAttribute?.('data-dialog-state', error ? 'error' : 'pending');
  else state.dialog.removeAttribute?.('data-dialog-state');
}

function appDialogSaveErrorMessage(state) {
  return state.form?.getAttribute?.('data-dialog-error-message')
    || state.dialog.getAttribute?.('data-dialog-error-message')
    || 'Projects defaults could not be saved.';
}

function appDialogFeedback(document, message, error = false) {
  const feedback = document?.querySelector?.('[data-dialog-feedback]');
  const text = feedback?.querySelector?.('[data-dialog-feedback-text]');
  if (!feedback || !text) return;
  feedback.classList?.toggle?.('notice--error', error);
  feedback.classList?.toggle?.('notice--success', !error);
  text.textContent = message;
  feedback.hidden = false;
  feedback.removeAttribute?.('hidden');
}

function assetBrowserDefaultRoot(form) {
  return form?.closest?.('[data-asset-browser-default]') || form;
}

function assetBrowserDefaultControl(form) {
  return form?.querySelector?.('[name="defaultCategory"]') || null;
}

function assetBrowserDefaultSetDisabled(state, disabled) {
  const control = state.control;
  if (!control) return;
  control.disabled = disabled;
  if (disabled) control.setAttribute?.('disabled', '');
  else control.removeAttribute?.('disabled');

  const dropdown = creatorCrateDropdownForNativeSelect(control);
  if (dropdown) {
    syncCreatorCrateDropdownDisabledState(dropdown);
    updateAssetViewerFilterDisclosureState(dropdown);
  }
}

function assetBrowserDefaultSyncControl(state, value) {
  state.control.value = String(value ?? '');
  syncCreatorCrateDropdownFromNative(state.control);
}

function assetBrowserDefaultClearError(state) {
  const root = assetBrowserDefaultRoot(state.form);
  const error = root?.querySelector?.('[data-asset-browser-default-error]');
  setHidden(error, true);
  const errorText = root?.querySelector?.('[data-asset-browser-default-error-text]');
  if (errorText) errorText.textContent = '';

  state.control.removeAttribute?.('aria-invalid');
  if (state.controlDescribedBy) state.control.setAttribute?.('aria-describedby', state.controlDescribedBy);
  else state.control.removeAttribute?.('aria-describedby');
  const summary = creatorCrateDropdownForNativeSelect(state.control)?.querySelector?.('summary');
  summary?.removeAttribute?.('aria-invalid');
  if (state.summaryDescribedBy) summary?.setAttribute?.('aria-describedby', state.summaryDescribedBy);
  else summary?.removeAttribute?.('aria-describedby');
}

function assetBrowserDefaultShowError(state, message) {
  const root = assetBrowserDefaultRoot(state.form);
  const error = root?.querySelector?.('[data-asset-browser-default-error]');
  const errorText = root?.querySelector?.('[data-asset-browser-default-error-text]');
  if (errorText) errorText.textContent = message;
  setHidden(error, false);

  const errorId = error?.id || 'asset-browser-default-error';
  state.control.setAttribute?.('aria-invalid', 'true');
  state.control.setAttribute?.('aria-describedby', [state.controlDescribedBy, errorId].filter(Boolean).join(' '));
  const summary = creatorCrateDropdownForNativeSelect(state.control)?.querySelector?.('summary');
  summary?.setAttribute?.('aria-invalid', 'true');
  summary?.setAttribute?.('aria-describedby', [state.summaryDescribedBy, errorId].filter(Boolean).join(' '));
}

function assetBrowserDefaultResponseMessage(payload, fallback) {
  const details = Object.values(payload?.errors || {}).filter((value) => typeof value === 'string');
  return [payload?.message, ...details].filter(Boolean).join(' ') || fallback;
}

function assetBrowserDefaultUpdatePresentation(state, payload) {
  const root = assetBrowserDefaultRoot(state.form);
  const fallback = root?.querySelector?.('[data-asset-browser-default-fallback]');
  const fallbackText = root?.querySelector?.('[data-asset-browser-default-fallback-text]');
  if (payload?.fallbackExplanation) {
    if (fallbackText) fallbackText.textContent = payload.fallbackExplanation;
    setHidden(fallback, false);
  } else if (payload?.fallbackExplanation === null) {
    if (fallbackText) fallbackText.textContent = '';
    setHidden(fallback, true);
  }
}

function appDialogBindLiveAssetBrowserDefault(state) {
  const form = state.form;
  if (!form || !form.matches?.(ASSET_BROWSER_DEFAULT_LIVE_FORM_SELECTOR)
    || isEnhancementBound(form, 'assetBrowserDefaultLiveBound')) return;

  const control = assetBrowserDefaultControl(form);
  if (!control) return;

  const dropdown = creatorCrateDropdownForNativeSelect(control);
  const summary = dropdown?.querySelector?.('summary');
  const errorId = assetBrowserDefaultRoot(form)?.querySelector?.('[data-asset-browser-default-error]')?.id || '';
  const withoutErrorId = (value) => String(value || '')
    .split(/\s+/)
    .filter((candidate) => candidate && candidate !== errorId)
    .join(' ');
  const liveState = {
    form,
    control,
    confirmedValue: String(control.value ?? ''),
    pending: false,
    controlDescribedBy: withoutErrorId(control.getAttribute?.('aria-describedby')),
    summaryDescribedBy: withoutErrorId(summary?.getAttribute?.('aria-describedby')),
  };
  state.assetBrowserDefault = liveState;
  markEnhancementBound(form, 'assetBrowserDefaultLiveBound');

  control.addEventListener?.('change', (event) => {
    const windowObject = state.document?.defaultView || globalThis;
    if (typeof windowObject.fetch !== 'function'
      || typeof windowObject.FormData !== 'function'
      || typeof windowObject.URLSearchParams !== 'function') return;

    const requestedValue = String(control.value ?? '');
    if (liveState.pending) {
      event.preventDefault?.();
      assetBrowserDefaultSyncControl(liveState, liveState.confirmedValue);
      return;
    }
    if (requestedValue === liveState.confirmedValue) return;

    let body;
    try {
      body = new windowObject.URLSearchParams(new windowObject.FormData(form));
    } catch {
      return;
    }

    event.preventDefault?.();
    liveState.pending = true;
    assetBrowserDefaultClearError(liveState);
    form.setAttribute?.('aria-busy', 'true');
    form.setAttribute?.('data-asset-browser-default-state', 'pending');
    const root = assetBrowserDefaultRoot(form);
    const status = root?.querySelector?.('[data-asset-browser-default-status]');
    if (status) status.textContent = 'Saving asset browser default.';
    assetBrowserDefaultSetDisabled(liveState, true);

    const action = form.action || form.getAttribute?.('action');
    const method = String(form.method || form.getAttribute?.('method') || 'POST').toUpperCase();
    Promise.resolve().then(() => windowObject.fetch(action, {
      method,
      body,
      credentials: 'same-origin',
      redirect: 'follow',
      headers: { Accept: 'application/json' },
    })).then(async (response) => ({ response, payload: await appDialogPayload(response) }))
      .then(({ response, payload }) => {
        liveState.pending = false;
        assetBrowserDefaultSetDisabled(liveState, false);
        form.removeAttribute?.('aria-busy');
        if (response?.ok !== true || payload?.status !== 'success') {
          assetBrowserDefaultSyncControl(liveState, liveState.confirmedValue);
          const message = `${assetBrowserDefaultResponseMessage(
            payload,
            'Could not save the asset browser default.',
          )} The previous setting was restored.`;
          form.setAttribute?.('data-asset-browser-default-state', 'error');
          if (status) status.textContent = message;
          assetBrowserDefaultShowError(liveState, message);
          return;
        }

        liveState.confirmedValue = String(payload.values?.defaultCategory ?? requestedValue);
        assetBrowserDefaultSyncControl(liveState, liveState.confirmedValue);
        assetBrowserDefaultUpdatePresentation(liveState, payload);
        assetBrowserDefaultClearError(liveState);
        form.setAttribute?.('data-asset-browser-default-state', 'saved');
        if (status) status.textContent = payload.message || 'Asset browser default saved.';
      })
      .catch(() => {
        liveState.pending = false;
        assetBrowserDefaultSetDisabled(liveState, false);
        form.removeAttribute?.('aria-busy');
        assetBrowserDefaultSyncControl(liveState, liveState.confirmedValue);
        const message = 'Could not save the asset browser default. The previous setting was restored. Check your connection and try again.';
        form.setAttribute?.('data-asset-browser-default-state', 'error');
        if (status) status.textContent = message;
        assetBrowserDefaultShowError(liveState, message);
      });
  });
}

async function appDialogPayload(response) {
  if (typeof response?.json === 'function') {
    try { return await response.json(); } catch {}
  }
  return {};
}

function categoryManagementMutationVerb(kind) {
  return {
    add: 'add the category',
    rename: 'save the category name',
    delete: 'delete the category',
  }[kind] || 'update the category';
}

function categoryManagementSetStatus(state, message, error = false) {
  const status = state.dialog.querySelector?.('[data-category-management-status]');
  if (status) {
    status.textContent = message || '';
    status.setAttribute?.('role', error ? 'alert' : 'status');
    status.setAttribute?.('aria-live', error ? 'assertive' : 'polite');
  }
  if (message) state.dialog.setAttribute?.('data-category-management-state', error ? 'error' : 'pending');
  else state.dialog.removeAttribute?.('data-category-management-state');
}

function categoryManagementFocus(state, focusId, error = false) {
  const dialog = state.dialog;
  const invalid = error ? dialog.querySelector?.('[aria-invalid="true"]') : null;
  const preferred = focusId && state.document?.getElementById?.(focusId);
  const fallback = dialog.querySelector?.('[data-category-reorder-handle]')
    || dialog.querySelector?.('#add-displayName')
    || dialog.querySelector?.('[data-category-management-status]');
  const target = invalid && dialog.contains?.(invalid)
    ? invalid
    : preferred && dialog.contains?.(preferred)
      ? preferred
      : fallback;
  target?.focus?.({ preventScroll: true });
}

function categoryManagementReplaceBody(state, html) {
  if (typeof html !== 'string') throw new Error('Category management response did not include markup.');

  const currentBody = state.dialog.querySelector?.(PROJECT_ASSET_CATEGORY_MANAGEMENT_BODY_SELECTOR);
  const windowObject = state.document?.defaultView || globalThis;
  if (!currentBody || typeof windowObject.DOMParser !== 'function') {
    throw new Error('Category management markup could not be applied.');
  }

  const parsed = new windowObject.DOMParser().parseFromString(html, 'text/html');
  const nextBody = parsed.querySelector?.(PROJECT_ASSET_CATEGORY_MANAGEMENT_BODY_SELECTOR);
  if (!nextBody) throw new Error('Category management response did not contain its dialog body.');

  const scrollTop = Number(currentBody.scrollTop) || 0;
  cleanupScrollableCategoryDialogDropdowns(state.dialog);
  currentBody.replaceWith?.(nextBody);
  nextBody.scrollTop = scrollTop;

  // The default form is part of the replaced server-rendered state. Rebind it
  // before the category-specific controls so its custom dropdown remains live.
  state.form = state.dialog.querySelector?.(APP_DIALOG_FORM_SELECTOR) || null;
  enhanceDropdowns(state.dialog);
  appDialogBindLiveAssetBrowserDefault(state);
  enhanceAutoSubmit(nextBody);
  enhanceCategoryReorder(nextBody);
  enhanceConfirmations(nextBody);
  enhanceProjectAssetCategoryManagement(state.dialog);
  return nextBody;
}

function categoryManagementSetPending(form, pending) {
  if (!form) return;
  if (pending) {
    form.setAttribute?.('aria-busy', 'true');
    form.setAttribute?.('data-category-management-state', 'pending');
  } else {
    form.removeAttribute?.('aria-busy');
    form.removeAttribute?.('data-category-management-state');
  }
  form.querySelectorAll?.('button[type="submit"], input[type="submit"]').forEach((control) => {
    control.disabled = pending;
    if (pending) control.setAttribute?.('disabled', '');
    else control.removeAttribute?.('disabled');
  });
}

function submitCategoryManagementMutation(state, form, kind, event) {
  const windowObject = state.document?.defaultView || globalThis;
  if (typeof windowObject.fetch !== 'function'
    || typeof windowObject.FormData !== 'function'
    || typeof windowObject.URLSearchParams !== 'function'
    || typeof windowObject.DOMParser !== 'function') {
    return; // Leave the traditional POST fallback intact.
  }

  if (state.categoryManagementSubmitting) {
    event.preventDefault?.();
    return;
  }

  let body;
  try {
    body = new windowObject.URLSearchParams(new windowObject.FormData(form));
  } catch {
    return; // A native submit is safer than sending a partial payload.
  }

  event.preventDefault?.();
  state.categoryManagementSubmitting = true;
  const submitter = event.submitter;
  categoryManagementSetPending(form, true);
  categoryManagementSetStatus(state, `Saving ${kind === 'add' ? 'new category' : `category ${kind}`}.`);

  const action = form.action || form.getAttribute?.('action');
  const method = String(form.method || form.getAttribute?.('method') || 'POST').toUpperCase();
  let request;
  try {
    request = windowObject.fetch(action, {
      method,
      body,
      credentials: 'same-origin',
      redirect: 'follow',
      headers: { Accept: 'application/json' },
    });
  } catch (error) {
    request = Promise.reject(error);
  }

  Promise.resolve(request)
    .then(async (response) => ({ response, payload: await appDialogPayload(response) }))
    .then(({ response, payload }) => {
      state.categoryManagementSubmitting = false;
      categoryManagementSetPending(form, false);

      const successful = response?.ok === true && payload?.status === 'success';
      if (!successful) {
        if (typeof payload?.html === 'string') {
          try {
            categoryManagementReplaceBody(state, payload.html);
          } catch {
            // Keep the existing controls available when a malformed fragment
            // cannot be applied; the server mutation still remains authoritative.
          }
        }
        const message = payload?.message || `Could not ${categoryManagementMutationVerb(kind)}.`;
        categoryManagementSetStatus(state, message, true);
        categoryManagementFocus(state, payload?.focus, true);
        return;
      }

      try {
        categoryManagementReplaceBody(state, payload.html);
      } catch {
        categoryManagementSetStatus(
          state,
          `${payload.message || 'Category updated.'} Refresh the page to verify the current category state.`,
          true,
        );
        categoryManagementFocus(state, null, true);
        return;
      }
      categoryManagementSetStatus(state, payload.message || 'Category updated.');
      categoryManagementFocus(state, payload.focus, false);
    })
    .catch(() => {
      state.categoryManagementSubmitting = false;
      categoryManagementSetPending(form, false);
      categoryManagementSetStatus(
        state,
        `Could not ${categoryManagementMutationVerb(kind)}. The previous state was kept. Check your connection and try again.`,
        true,
      );
      categoryManagementFocus(state, submitter?.id, true);
    });
}

function bindCategoryManagementMutationForm(state, form, kind) {
  if (!form || isEnhancementBound(form, 'categoryManagementMutationBound')) return;
  markEnhancementBound(form, 'categoryManagementMutationBound');
  form.addEventListener?.('submit', (event) => {
    submitCategoryManagementMutation(state, form, kind, event);
  });
}

export function enhanceProjectAssetCategoryManagement(scope = globalThis.document) {
  const document = appDialogDocument(scope);
  if (!document || typeof document.querySelectorAll !== 'function') return 0;

  const dialogs = Array.from(document.querySelectorAll(APP_DIALOG_SELECTOR))
    .filter((dialog) => (dialog.id || dialog.getAttribute?.('id')) === PROJECT_ASSET_CATEGORY_MANAGEMENT_DIALOG_ID);
  dialogs.forEach((dialog) => {
    const state = dialog.__creatorCrateAppDialogState;
    const body = dialog.querySelector?.(PROJECT_ASSET_CATEGORY_MANAGEMENT_BODY_SELECTOR);
    if (!state || !body) return;

    bindCategoryManagementMutationForm(
      state,
      body.querySelector?.(PROJECT_ASSET_CATEGORY_MANAGEMENT_ADD_FORM_SELECTOR),
      'add',
    );
    body.querySelectorAll?.(PROJECT_ASSET_CATEGORY_MANAGEMENT_RENAME_FORM_SELECTOR)
      .forEach((form) => bindCategoryManagementMutationForm(state, form, 'rename'));
    body.querySelectorAll?.(PROJECT_ASSET_CATEGORY_MANAGEMENT_DELETE_FORM_SELECTOR)
      .forEach((form) => bindCategoryManagementMutationForm(state, form, 'delete'));
  });
  return dialogs.length;
}

function appDialogBindForm(state) {
  const form = state.form;
  if (!form || form.getAttribute?.('data-dialog-async') === 'false'
    || isEnhancementBound(form, 'appDialogFormBound')) return;
  markEnhancementBound(form, 'appDialogFormBound');
  state.savedValues = appDialogValues(form);

  form.addEventListener?.('submit', (event) => {
    const submitter = event.submitter;
    if (submitter?.matches?.(APP_DIALOG_CLOSE_SELECTOR) || submitter?.getAttribute?.('formmethod') === 'dialog') {
      event.preventDefault?.();
      appDialogClose(state);
      return;
    }

    const windowObject = state.document?.defaultView || globalThis;
    if (typeof windowObject.fetch !== 'function'
      || typeof windowObject.FormData !== 'function'
      || typeof windowObject.URLSearchParams !== 'function') return;

    event.preventDefault?.();
    if (state.submitting) return;
    state.submitting = true;
    appDialogClearErrors(state);
    appDialogStatus(state, 'Saving defaults.');
    form.setAttribute?.('aria-busy', 'true');
    const submitButton = form.querySelector?.('[data-dialog-submit]');
    if (submitButton) submitButton.disabled = true;
    const action = form.action || form.getAttribute?.('action');
    const method = String(form.method || form.getAttribute?.('method') || 'POST').toUpperCase();

    Promise.resolve().then(() => windowObject.fetch(action, {
      method,
      body: new windowObject.URLSearchParams(new windowObject.FormData(form)),
      credentials: 'same-origin',
      redirect: 'follow',
      headers: { Accept: 'application/json' },
    })).then(async (response) => ({ response, payload: await appDialogPayload(response) }))
      .then(({ response, payload }) => {
        state.submitting = false;
        form.removeAttribute?.('aria-busy');
        if (submitButton) submitButton.disabled = false;
        if (response?.ok === false || payload?.status !== 'success') {
          if (!state.preserveValuesOnError) {
            appDialogApplyValues(form, payload?.values || appDialogValues(form));
          }
          appDialogShowErrors(state, payload?.errors || {}, payload?.message || appDialogSaveErrorMessage(state));
          appDialogStatus(state, payload?.message || 'Could not save defaults.', true);
          return;
        }
        // A successful-submit hook that begins navigation owns the terminal lifecycle.
        if (state.onSuccessfulSubmit?.(payload) === true) return;
        state.savedValues = payload?.values || appDialogValues(form);
        syncProjectAssetsSizePreferences(state.dialog, state.savedValues);
        appDialogStatus(state, '');
        appDialogFeedback(state.document, payload?.message || 'Projects defaults saved successfully.');
        appDialogClose(state);
      })
      .catch(() => {
        state.submitting = false;
        form.removeAttribute?.('aria-busy');
        if (submitButton) submitButton.disabled = false;
        appDialogShowErrors(state, {}, `${appDialogSaveErrorMessage(state)} Your selections were kept.`);
        appDialogStatus(state, 'Could not save defaults. Check your connection and try again.', true);
      });
  });
}

function appDialogOpen(state, opener = null) {
  state.opener = opener || state.document.querySelector?.(
    `${APP_DIALOG_TRIGGER_SELECTOR}[data-dialog-open="${state.dialog.id}"]`
  );
  appDialogApplyValues(state.form, state.savedValues || {});
  state.onOpen?.();
  try {
    if (typeof state.dialog.showModal === 'function') {
      if (state.dialog.open) state.dialog.close?.();
      state.dialog.showModal();
    } else {
      state.dialog.setAttribute?.('open', '');
      state.dialog.open = true;
    }
  } catch {
    state.dialog.setAttribute?.('open', '');
    state.dialog.open = true;
  }
  state.open = true;
  appDialogBodyLock(state, true);
  (state.dialog.querySelector?.('[autofocus]')
    || state.dialog.querySelector?.(APP_DIALOG_CLOSE_SELECTOR)
    || appDialogFocusable(state.dialog)[0])?.focus?.({ preventScroll: true });
}

function appDialogBind(state) {
  if (isEnhancementBound(state.dialog, 'appDialogBound')) return;
  markEnhancementBound(state.dialog, 'appDialogBound');
  state.form = state.dialog.querySelector?.(APP_DIALOG_FORM_SELECTOR) || null;
  appDialogBindForm(state);
  appDialogBindLiveAssetBrowserDefault(state);
  state.dialog.addEventListener?.('close', () => appDialogFinishClose(state));
  state.dialog.addEventListener?.('cancel', (event) => {
    event.preventDefault?.();
    if (appDialogCloseOpenDropdown(state)) return;
    appDialogClose(state);
  });
  state.dialog.addEventListener?.('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault?.();
    if (appDialogCloseOpenDropdown(state)) return;
    appDialogClose(state);
  });
  state.dialog.addEventListener?.('click', (event) => {
    if (event.target === state.dialog) {
      event.preventDefault?.();
      if (state.dialog.hasAttribute?.('data-dialog-backdrop-static')) return;
      appDialogClose(state);
    }
  });
  state.dialog.querySelectorAll?.(APP_DIALOG_CLOSE_SELECTOR).forEach((control) => {
    if (isEnhancementBound(control, 'appDialogCloseBound')) return;
    markEnhancementBound(control, 'appDialogCloseBound');
    control.addEventListener?.('click', (event) => {
      event.preventDefault?.();
      appDialogClose(state);
    });
  });
  state.dialog.addEventListener?.('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const focusable = appDialogFocusable(state.dialog);
    if (focusable.length === 0) return;
    const index = focusable.indexOf(state.document.activeElement);
    if (!event.shiftKey && (index === focusable.length - 1 || index === -1)) {
      event.preventDefault?.();
      focusable[0].focus?.();
    } else if (event.shiftKey && index <= 0) {
      event.preventDefault?.();
      focusable[focusable.length - 1].focus?.();
    }
  });
  if (state.dialog.hasAttribute?.('open')) appDialogOpen(state);
}

export function enhanceAppDialogs(scope = globalThis.document) {
  const document = appDialogDocument(scope);
  if (!document || typeof document.querySelectorAll !== 'function') return 0;
  const dialogs = Array.from(document.querySelectorAll(APP_DIALOG_SELECTOR));
  dialogs.forEach((dialog) => {
    if (dialog.__creatorCrateAppDialogState) return;
    const state = {
      document,
      dialog,
      form: null,
      opener: null,
      savedValues: null,
      open: false,
      submitting: false,
      preserveValuesOnError: false,
      onOpen: null,
      onClose: null,
      onSuccessfulSubmit: null,
    };
    dialog.__creatorCrateAppDialogState = state;
    appDialogBind(state);
  });
  if (!isEnhancementBound(document, 'appDialogsBound')) {
    markEnhancementBound(document, 'appDialogsBound');
    document.addEventListener?.('click', (event) => {
      const trigger = event.target?.closest?.(APP_DIALOG_TRIGGER_SELECTOR);
      if (!trigger) return;
      const dialog = document.getElementById?.(trigger.getAttribute?.('data-dialog-open'));
      const state = dialog?.__creatorCrateAppDialogState;
      if (!state) return;
      event.preventDefault?.();
      appDialogOpen(state, trigger);
    });
  }
  return dialogs.length;
}
