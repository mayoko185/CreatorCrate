import { isEnhancementBound, markEnhancementBound } from './dom.js';

const FETCH_AUTOSUBMIT_SELECTOR = '[data-autosubmit="fetch"]';
const FETCH_AUTOSUBMIT_STATUS_SELECTOR = '[data-settings-fetch-save-status]';
const formStates = new WeakMap();

function fetchSaveAvailable() {
  return typeof globalThis.fetch === 'function'
    && typeof globalThis.FormData === 'function'
    && typeof globalThis.URLSearchParams === 'function';
}

function fetchSaveStatus(form) {
  return form.querySelector?.(FETCH_AUTOSUBMIT_STATUS_SELECTOR) || null;
}

function setFetchSaveStatus(form, message, state) {
  const status = fetchSaveStatus(form);
  form.setAttribute?.('data-settings-fetch-save-state', state);
  if (!status) return;
  status.setAttribute?.('role', 'status');
  status.setAttribute?.('aria-live', 'polite');
  status.setAttribute?.('aria-atomic', 'true');
  status.textContent = message;
}

async function responseHtml(response) {
  if (typeof response?.text !== 'function') return '';
  return response.text();
}

export function captureRegionFocus(region) {
  const document = region?.ownerDocument || globalThis.document;
  const activeElement = document?.activeElement;
  if (!activeElement || !region?.contains?.(activeElement)) return null;

  const id = activeElement.id || activeElement.getAttribute?.('id');
  if (!id) return null;

  const focus = { id };
  if (typeof activeElement.selectionStart === 'number' && typeof activeElement.selectionEnd === 'number') {
    focus.selectionStart = activeElement.selectionStart;
    focus.selectionEnd = activeElement.selectionEnd;
    focus.selectionDirection = activeElement.selectionDirection;
  }
  return focus;
}

export function restoreRegionFocus(region, focus) {
  if (!region || !focus?.id) return false;
  const document = region.ownerDocument || globalThis.document;
  const target = document?.getElementById?.(focus.id)
    || region.querySelector?.(`#${globalThis.CSS?.escape?.(focus.id) || focus.id}`);
  if (!target || !region.contains?.(target) || typeof target.focus !== 'function') return false;

  target.focus({ preventScroll: true });
  if (typeof focus.selectionStart === 'number' && typeof target.setSelectionRange === 'function') {
    try {
      target.setSelectionRange(focus.selectionStart, focus.selectionEnd, focus.selectionDirection);
    } catch {
      // Some focused controls do not support a text selection.
    }
  }
  return true;
}

function notify(callback, detail) {
  try {
    if (typeof callback === 'function') callback(detail);
  } catch {
    // Page-level DOM work must not change the save result.
  }
}

function createState(form, options) {
  const state = {
    form,
    options,
    pending: false,
    activePayload: '',
    queuedPayload: null,
  };
  formStates.set(form, state);
  return state;
}

function queueSave(state) {
  const { form } = state;
  const body = new globalThis.URLSearchParams(new globalThis.FormData(form));
  const payload = body.toString();

  if (state.pending) {
    state.queuedPayload = payload === state.activePayload ? null : { body, payload };
    return;
  }

  startSave(state, { body, payload });
}

function finishOrContinue(state, outcome) {
  const { form } = state;
  const next = state.queuedPayload;
  state.pending = false;
  state.activePayload = '';
  state.queuedPayload = null;

  if (next) {
    if (outcome) notify(state.options.onError, { form, ...outcome, superseded: true });
    startSave(state, next);
    return;
  }

  form.removeAttribute?.('aria-busy');
  if (outcome) {
    setFetchSaveStatus(form, 'Could not save settings. Your current changes were kept.', 'error');
    notify(state.options.onError, { form, ...outcome, superseded: false });
    return;
  }

  setFetchSaveStatus(form, 'Settings saved.', 'saved');
}

function startSave(state, request) {
  const { form } = state;
  state.pending = true;
  state.activePayload = request.payload;
  form.setAttribute?.('aria-busy', 'true');
  setFetchSaveStatus(form, 'Saving settings.', 'pending');

  const action = form.action || form.getAttribute?.('action');
  const method = String(form.method || form.getAttribute?.('method') || 'POST').toUpperCase();

  Promise.resolve().then(() => globalThis.fetch(action, {
    method,
    body: request.body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    credentials: 'same-origin',
    redirect: 'follow',
  })).then(async (response) => {
    const html = await responseHtml(response);
    if (!response?.ok || !response.redirected) {
      const superseded = state.queuedPayload !== null;
      finishOrContinue(state, { response, html, type: 'response' });
      notify(state.options.onValidationError, {
        form,
        response,
        html,
        payload: request.payload,
        superseded,
      });
      return;
    }

    const next = state.queuedPayload;
    state.pending = false;
    state.activePayload = '';
    state.queuedPayload = null;
    if (next) {
      startSave(state, next);
      return;
    }

    form.removeAttribute?.('aria-busy');
    setFetchSaveStatus(form, 'Settings saved.', 'saved');
    notify(state.options.onSuccess, { form, response, html, payload: request.payload });
  }).catch((error) => {
    finishOrContinue(state, { error, type: 'network' });
  });
}

// Explicit progressive enhancement for future Settings forms. Fetch mode is
// control-level only: detached `form="..."` controls use `.form`, and replaced
// controls can rebind without marking their surviving form. Future adopters need
// explicit POST forms, no file inputs, and must ignore superseded response DOM work.
function updateStateOptions(state, options) {
  if (state && Object.keys(options).length > 0) state.options = options;
}

function bindFetchSaveControl(control, form, options) {
  let state = formStates.get(form);
  if (isEnhancementBound(control, 'settingsFetchSaveBound')) {
    updateStateOptions(state, options);
    return false;
  }

  markEnhancementBound(control, 'settingsFetchSaveBound');
  if (!state) state = createState(form, options);
  else updateStateOptions(state, options);

  control.addEventListener('change', (event) => {
    event.preventDefault?.();
    queueSave(state);
  });
  return true;
}

export function queueSettingsFetchSave(control) {
  const state = formStates.get(control?.form);
  if (!state || !isEnhancementBound(control, 'settingsFetchSaveBound')) return false;
  queueSave(state);
  return true;
}

export function enhanceSettingsFetchSave(scope = globalThis.document, options = {}) {
  if (!scope || typeof scope.querySelectorAll !== 'function' || !fetchSaveAvailable()) return 0;
  let bound = 0;
  scope.querySelectorAll(FETCH_AUTOSUBMIT_SELECTOR).forEach((control) => {
    if (control.form && bindFetchSaveControl(control, control.form, options)) bound += 1;
  });
  return bound;
}
