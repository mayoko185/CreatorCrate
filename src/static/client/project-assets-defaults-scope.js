import { isEnhancementBound, markEnhancementBound } from './dom.js';
import { syncCreatorCrateDropdownFromNative } from './dropdowns.js';

const FORM_SELECTOR = '#project-assets-defaults-form';
const SCOPE_SELECTOR = '[data-project-assets-defaults-scope]';
const VALUES_SELECTOR = 'script[type="application/json"][data-project-assets-default-values]';
const LOADED_SCOPE_SELECTOR = 'input[name="loadedScope"]';
const SCOPES = Object.freeze(['global', 'project']);
const VALUE_KEYS = Object.freeze([
  'view',
  'gridSize',
  'listSize',
  'sort',
  'order',
  'pageSize',
  'extension',
  'tag',
]);

function validScope(value) {
  return SCOPES.includes(value) ? value : null;
}

function scopeValues(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  for (const key of VALUE_KEYS) {
    if (typeof value[key] !== 'string') return null;
    result[key] = value[key];
  }
  return result;
}

function parseValues(script) {
  if (!script || typeof script.textContent !== 'string') return null;
  try {
    const parsed = JSON.parse(script.textContent);
    const global = scopeValues(parsed?.global);
    const project = scopeValues(parsed?.project);
    return global && project ? { global, project } : null;
  } catch {
    return null;
  }
}

function formFields(form) {
  const fields = {};
  for (const key of VALUE_KEYS) {
    const field = form.querySelector?.(`[data-dialog-field="${key}"]`);
    const select = field?.querySelector?.('select');
    if (!select) return null;
    fields[key] = select;
  }
  return fields;
}

function captureDraft(fields) {
  return Object.fromEntries(VALUE_KEYS.map((key) => [key, String(fields[key].value ?? '')]));
}

function captureSubmittedValues(fields) {
  const values = {};
  for (const key of VALUE_KEYS) {
    const value = fields[key]?.value;
    if (typeof value !== 'string') return null;
    values[key] = value;
  }
  return values;
}

function draftIsRepresentable(fields, draft) {
  return VALUE_KEYS.every((key) => Array.from(fields[key].options || [])
    .some((option) => String(option.value ?? '') === draft[key]));
}

function dispatchNativeEvent(select, type) {
  const EventConstructor = select?.ownerDocument?.defaultView?.Event || globalThis.Event;
  if (typeof EventConstructor === 'function') {
    select.dispatchEvent?.(new EventConstructor(type, { bubbles: true }));
  }
}

function clearScopeError(form) {
  const scope = form.querySelector?.(SCOPE_SELECTOR);
  const error = scope?.querySelector?.('.field-error-message');
  error?.remove?.();
  scope?.querySelectorAll?.('input[name="scope"]').forEach((radio) => {
    radio.removeAttribute?.('aria-invalid');
    radio.removeAttribute?.('aria-describedby');
  });

  const dialogError = form.querySelector?.('[data-dialog-error]');
  const dialogErrorText = form.querySelector?.('[data-dialog-error-text]');
  const dialogErrorList = form.querySelector?.('[data-dialog-error-list]');
  const message = `${dialogErrorText?.textContent || ''} ${dialogErrorList?.textContent || ''}`;
  if (dialogError && /(scope|loaded scope)/i.test(message)) {
    dialogError.hidden = true;
    dialogError.setAttribute?.('hidden', '');
    if (dialogErrorText) dialogErrorText.textContent = '';
    if (dialogErrorList) dialogErrorList.textContent = '';
  }
}

function showScopeError(form, message) {
  const error = form.querySelector?.('[data-dialog-error]');
  if (error) {
    error.hidden = false;
    error.removeAttribute?.('hidden');
  }
  const errorText = form.querySelector?.('[data-dialog-error-text]');
  if (errorText) errorText.textContent = message;
  const status = form.querySelector?.('[data-dialog-status]');
  if (status) status.textContent = message;
}

function restoreLoadedScopeRadio(scope, loadedScope) {
  scope?.querySelectorAll?.('input[name="scope"]').forEach((radio) => {
    radio.checked = radio.value === loadedScope;
  });
}

function captureSuccessfulSubmission(state) {
  const scope = validScope(
    state.scopeControl.querySelector?.('input[name="scope"]:checked')?.value,
  );
  const loadedScope = validScope(state.loadedScope.value);
  const values = captureSubmittedValues(state.fields);
  if (!scope || scope !== loadedScope || !values) return null;
  return { scope, loadedScope, values };
}

function writeCommittedValues(state) {
  state.valuesScript.textContent = JSON.stringify({
    global: { ...state.committed.global },
    project: { ...state.committed.project },
  });
}

function reconcileSuccessfulSubmission(state, payload) {
  const submitted = state.pendingSubmission;
  state.pendingSubmission = null;
  if (!submitted || !scopeValues(payload?.values)) return;

  const global = submitted.scope === 'global' ? submitted.values : state.committed.global;
  const project = submitted.values;
  state.committed = {
    global: { ...global },
    project: { ...project },
  };
  state.drafts = {
    global: { ...state.committed.global },
    project: { ...state.committed.project },
  };
  state.committedScope = submitted.loadedScope;
  state.loadedScope.value = submitted.loadedScope;
  restoreLoadedScopeRadio(state.scopeControl, submitted.loadedScope);
  writeCommittedValues(state);
  clearScopeError(state.form);
}

function restoreCommittedStateOnOpen(state) {
  const loadedScope = validScope(state.committedScope);
  state.pendingSubmission = null;
  if (!loadedScope) {
    showScopeError(state.form, 'Project Assets defaults scope could not be restored safely.');
    return false;
  }

  state.drafts = {
    global: { ...state.committed.global },
    project: { ...state.committed.project },
  };
  state.loadedScope.value = loadedScope;
  restoreLoadedScopeRadio(state.scopeControl, loadedScope);
  return applyDraft(state, loadedScope);
}

function bindDialogHooks(state) {
  const dialogState = state.form.closest?.('[data-app-dialog]')?.__creatorCrateAppDialogState;
  if (!dialogState || state.dialogState === dialogState) return;

  state.dialogState = dialogState;
  const onOpen = dialogState.onOpen;
  dialogState.onOpen = (...args) => {
    onOpen?.(...args);
    restoreCommittedStateOnOpen(state);
  };

  const onSuccessfulSubmit = dialogState.onSuccessfulSubmit;
  dialogState.onSuccessfulSubmit = (payload) => {
    const result = onSuccessfulSubmit?.(payload);
    reconcileSuccessfulSubmission(state, payload);
    return result === true;
  };
}

function applyDraft(state, targetScope) {
  const currentScope = validScope(state.loadedScope.value);
  const targetDraft = state.drafts[targetScope];
  if (!currentScope || !targetDraft || !draftIsRepresentable(state.fields, targetDraft)) return false;

  const previousValues = captureDraft(state.fields);
  state.applying = true;
  try {
    VALUE_KEYS.forEach((key) => {
      const select = state.fields[key];
      select.value = targetDraft[key];
      syncCreatorCrateDropdownFromNative(select);
      dispatchNativeEvent(select, 'input');
      dispatchNativeEvent(select, 'change');
    });
    state.loadedScope.value = targetScope;
    clearScopeError(state.form);
    return true;
  } catch {
    VALUE_KEYS.forEach((key) => {
      const select = state.fields[key];
      select.value = previousValues[key];
      syncCreatorCrateDropdownFromNative(select);
    });
    return false;
  } finally {
    state.applying = false;
  }
}

export function enhanceProjectAssetsDefaultsScope(scope = globalThis.document) {
  const form = scope?.querySelector?.(FORM_SELECTOR);
  if (!form || isEnhancementBound(form, 'projectAssetsDefaultsScopeBound')) return 0;

  const scopeControl = form.querySelector?.(SCOPE_SELECTOR);
  const loadedScope = form.querySelector?.(LOADED_SCOPE_SELECTOR);
  const valuesScript = form.querySelector?.(VALUES_SELECTOR);
  const values = parseValues(valuesScript);
  const fields = formFields(form);
  const currentScope = validScope(loadedScope?.value);
  if (!scopeControl || !loadedScope || !values || !fields || !currentScope) {
    showScopeError(form, 'Project Assets defaults scope could not be changed safely.');
    return 0;
  }

  const state = {
    form,
    scopeControl,
    loadedScope,
    valuesScript,
    fields,
    committed: {
      global: { ...values.global },
      project: { ...values.project },
    },
    drafts: {
      global: { ...values.global },
      project: { ...values.project },
    },
    applying: false,
    pendingSubmission: null,
    dialogState: null,
    committedScope: currentScope,
  };
  state.drafts[currentScope] = captureDraft(fields);

  bindDialogHooks(state);
  form.ownerDocument?.addEventListener?.('click', () => bindDialogHooks(state));
  globalThis.queueMicrotask?.(() => bindDialogHooks(state));

  form.addEventListener?.('submit', () => {
    state.pendingSubmission = captureSuccessfulSubmission(state);
    bindDialogHooks(state);
  });

  Object.values(fields).forEach((select) => {
    const capture = () => {
      const activeScope = validScope(loadedScope.value);
      if (!state.applying && activeScope) state.drafts[activeScope] = captureDraft(fields);
    };
    select.addEventListener?.('input', capture);
    select.addEventListener?.('change', capture);
  });

  scopeControl.querySelectorAll?.('input[name="scope"]').forEach((radio) => {
    radio.addEventListener?.('change', () => {
      const targetScope = validScope(radio.value);
      const activeScope = validScope(loadedScope.value);
      if (!targetScope || !activeScope || !radio.checked || targetScope === activeScope) return;
      state.drafts[activeScope] = captureDraft(fields);
      if (!applyDraft(state, targetScope)) {
        restoreLoadedScopeRadio(scopeControl, activeScope);
        showScopeError(form, 'Project Assets defaults scope could not be changed safely.');
      }
    });
  });

  markEnhancementBound(form, 'projectAssetsDefaultsScopeBound');
  return 1;
}
