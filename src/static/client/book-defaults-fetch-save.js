import {
  creatorCrateDropdownSummaryForNativeSelect,
  enhanceDropdowns,
  syncCreatorCrateDropdownFromNative,
} from './dropdowns.js';
import {
  beginBookDetailDefaultsLiveRefresh,
  publishBookDetailLiveRegionSnapshotAtomically,
  refreshBookDetailLiveRegion,
} from './live-regions.js';
import {
  captureRegionFocus,
  enhanceSettingsFetchSave,
  restoreRegionFocus,
} from './settings-fetch-save.js';
import { removeStatusRetry, showStatusRetry } from './status-retry.js';

const BOOK_DEFAULTS_FORM_SELECTOR = '#book-defaults-form';
const BOOK_DEFAULTS_AUTOSAVE_ATTRIBUTE = 'data-book-defaults-autosave';
const BOOK_DEFAULTS_REQUEST_MODE = 'book-defaults-autosave';
const BOOK_DEFAULTS_CONTROL_SELECTOR = '[data-autosubmit="fetch"]';
const BOOK_DEFAULTS_DETAIL_SELECTOR = '[data-book-detail-live-region]';
const BOOK_DEFAULTS_FIELDS = ['navigation', 'previewMode', 'randomPageCount'];
const BOOK_DEFAULTS_SELECTED_PAGES = 'selectedPageIds';
const sessions = new WeakMap();

function bookDefaultsForms(scope) {
  if (!scope) return [];
  const forms = [];
  if (scope.matches?.(BOOK_DEFAULTS_FORM_SELECTOR)
    && scope.hasAttribute?.(BOOK_DEFAULTS_AUTOSAVE_ATTRIBUTE)) forms.push(scope);
  scope.querySelectorAll?.(BOOK_DEFAULTS_FORM_SELECTOR).forEach((form) => {
    if (form.hasAttribute?.(BOOK_DEFAULTS_AUTOSAVE_ATTRIBUTE)) forms.push(form);
  });
  return forms;
}

function clearValidation(form) {
  const error = form.querySelector?.('[data-dialog-error]');
  if (error) error.hidden = true;
  const errorText = error?.querySelector?.('[data-dialog-error-text]');
  const errorList = error?.querySelector?.('[data-dialog-error-list]');
  if (errorText) errorText.textContent = '';
  if (errorList) errorList.textContent = '';
  form.querySelectorAll?.('.field-error-message').forEach((message) => message.remove?.());
  form.querySelectorAll?.('[aria-invalid]').forEach((control) => {
    control.removeAttribute?.('aria-invalid');
    control.removeAttribute?.('aria-describedby');
  });
  form.querySelectorAll?.('.field-error').forEach((field) => field.classList?.remove?.('field-error'));
}

function parseResponseDocument(form, html) {
  if (typeof html !== 'string' || html === '') return null;
  const DOMParser = form?.ownerDocument?.defaultView?.DOMParser || globalThis.DOMParser;
  if (typeof DOMParser !== 'function') return null;
  return new DOMParser().parseFromString(html, 'text/html');
}

function replaceValidationBody(form, html, options) {
  const nextForm = parseResponseDocument(form, html)?.querySelector?.(BOOK_DEFAULTS_FORM_SELECTOR);
  const currentBody = form.querySelector?.('.app-dialog-body');
  const nextBody = nextForm?.querySelector?.('.app-dialog-body');
  if (!currentBody || !nextBody || !currentBody.parentNode) return false;
  const focus = captureRegionFocus(currentBody);
  if (typeof currentBody.replaceWith === 'function') currentBody.replaceWith(nextBody);
  else currentBody.parentNode.replaceChild(nextBody, currentBody);
  enhanceDropdowns(form);
  enhanceBookDefaultsFetchSave(form, options);
  restoreRegionFocus(nextBody, focus);
  return true;
}

function setStatus(form, message, state) {
  const status = form.querySelector?.('[data-settings-fetch-save-status]');
  form.setAttribute?.('data-settings-fetch-save-state', state);
  if (!status) return;
  status.setAttribute?.('role', 'status');
  status.setAttribute?.('aria-live', 'polite');
  status.setAttribute?.('aria-atomic', 'true');
  status.textContent = message;
}

function parseBookDefaultsAcknowledgement({ response, body }) {
  if (!response?.ok || typeof body !== 'string' || body === '') return null;
  try {
    const acknowledgement = JSON.parse(body);
    if (acknowledgement?.status !== 'success'
      || typeof acknowledgement.refreshUrl !== 'string'
      || acknowledgement.refreshUrl === '') return null;
    return acknowledgement;
  } catch {
    return null;
  }
}

function isUncertainMutationOutcome(outcome) {
  return outcome?.type === 'network'
    || (outcome?.type === 'response' && outcome.response?.ok === true);
}

function setControlsDisabled(form, session, disabled) {
  form.querySelectorAll?.(BOOK_DEFAULTS_CONTROL_SELECTOR).forEach((control) => {
    if (disabled) {
      if (!session.disabledControls.has(control)) {
        session.disabledControls.set(control, Boolean(control.disabled));
      }
      control.disabled = true;
      control.setAttribute?.('disabled', '');
    } else {
      control.disabled = session.disabledControls.get(control) || false;
      if (!control.disabled) control.removeAttribute?.('disabled');
    }
    syncCreatorCrateDropdownFromNative(control);
  });
  if (!disabled) session.disabledControls.clear();
}

function removeReconciliationRetry(session) {
  session.retryButton?.remove?.();
  session.retryButton = null;
}

function showReconciliationFailure(form, session, retry) {
  setStatus(
    form,
    'Could not restore current Book Defaults authority. Defaults changes remain blocked. Retry reconciliation to continue.',
    'reconciliation-error',
  );
  const button = form.ownerDocument?.createElement?.('button');
  const body = form.querySelector?.('.app-dialog-body');
  if (!button || !body) return;
  removeReconciliationRetry(session);
  button.type = 'button';
  button.className = 'button button-secondary';
  button.setAttribute?.('data-book-defaults-reconciliation-retry', '');
  button.textContent = 'Retry reconciliation';
  button.addEventListener?.('click', retry);
  body.appendChild?.(button);
  session.retryButton = button;
  button.focus?.();
}

function authorityUrl(form) {
  const action = form.action || form.getAttribute?.('action') || '';
  try {
    const url = new URL(action, form.ownerDocument?.defaultView?.location?.href || '/notes');
    if (!/^\/notes\/books\/[1-9]\d*\/defaults$/.test(url.pathname)) return null;
    url.pathname = url.pathname.replace(/\/defaults$/, '');
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

async function fetchCanonicalAuthority(form) {
  const destination = authorityUrl(form);
  const Parser = form.ownerDocument?.defaultView?.DOMParser || globalThis.DOMParser;
  if (!destination || typeof Parser !== 'function' || typeof globalThis.fetch !== 'function') return null;
  try {
    const response = await globalThis.fetch(destination, {
      method: 'GET',
      headers: { Accept: 'text/html' },
      credentials: 'same-origin',
      redirect: 'error',
    });
    if (!response?.ok || typeof response.text !== 'function') return null;
    const parsed = new Parser().parseFromString(await response.text(), 'text/html');
    const canonicalForm = parsed?.querySelector?.(BOOK_DEFAULTS_FORM_SELECTOR);
    const detailRegion = parsed?.querySelector?.(BOOK_DEFAULTS_DETAIL_SELECTOR);
    const dialogBody = canonicalForm?.querySelector?.('.app-dialog-body');
    if (!canonicalForm || !detailRegion || !dialogBody) return null;
    return { destination, detailRegion, dialogBody, canonicalForm };
  } catch {
    return null;
  }
}

function prepareCanonicalDialog(form, authority) {
  const currentBody = form.querySelector?.('.app-dialog-body');
  if (!currentBody || !authority?.dialogBody || !currentBody.parentNode) return false;
  return () => {
    if (form.querySelector?.('.app-dialog-body') !== currentBody || !currentBody.parentNode) return false;
    if (typeof currentBody.replaceWith === 'function') currentBody.replaceWith(authority.dialogBody);
    else currentBody.parentNode.replaceChild(authority.dialogBody, currentBody);
    return true;
  };
}

function captureBookDefaultsFocus(form) {
  const body = form.querySelector?.('.app-dialog-body');
  const document = form.ownerDocument || globalThis.document;
  const activeElement = document?.activeElement;
  if (!body || !activeElement || !body.contains?.(activeElement)) return null;

  const dropdown = activeElement.closest?.('[data-cc-dropdown]');
  const nativeControl = dropdown?.parentElement?.querySelector?.('[data-cc-dropdown-native-select]')
    || dropdown?.parentNode?.querySelector?.('[data-cc-dropdown-native-select]');
  return {
    fieldId: nativeControl?.id || nativeControl?.getAttribute?.('id') || '',
    fieldName: nativeControl?.name || nativeControl?.getAttribute?.('name') || '',
    regionFocus: captureRegionFocus(body),
  };
}

function bookDefaultsControl(form, focus) {
  const controls = Array.from(form.querySelectorAll?.(BOOK_DEFAULTS_CONTROL_SELECTOR) || []);
  return controls.find((control) => focus?.fieldId && control.id === focus.fieldId)
    || controls.find((control) => focus?.fieldName && control.name === focus.fieldName)
    || null;
}

function focusBookDefaultsControl(control) {
  const target = creatorCrateDropdownSummaryForNativeSelect(control) || control;
  if (!target || target.disabled || typeof target.focus !== 'function') return false;
  target.focus({ preventScroll: true });
  return true;
}

function restoreBookDefaultsFocus(form, focus) {
  if (!focus) return false;
  const body = form.querySelector?.('.app-dialog-body');
  const equivalent = bookDefaultsControl(form, focus);
  if (equivalent && focusBookDefaultsControl(equivalent)) return true;
  if (restoreRegionFocus(body, focus.regionFocus)) return true;

  const fallback = Array.from(form.querySelectorAll?.(BOOK_DEFAULTS_CONTROL_SELECTOR) || [])
    .find((control) => !control.disabled);
  if (focusBookDefaultsControl(fallback)) return true;
  const close = form.closest?.('[data-app-dialog]')?.querySelector?.('[data-dialog-close]');
  if (!close || typeof close.focus !== 'function') return false;
  close.focus({ preventScroll: true });
  return true;
}

function namedControl(form, name) {
  return form.querySelector?.(`[name="${name}"]`) || null;
}

function allowedValues(control) {
  return Array.from(control?.options || []).map((option) => String(option.value));
}

function canonicalPayload(form) {
  try {
    return new globalThis.URLSearchParams(new globalThis.FormData(form)).toString();
  } catch {
    return null;
  }
}

function reconstructQueuedRequest(form, queuedRequest) {
  if (!queuedRequest?.payload) return { request: null, invalid: false, values: null };
  try {
    const queued = new globalThis.URLSearchParams(queuedRequest.payload);
    const body = new globalThis.URLSearchParams(new globalThis.FormData(form));
    const values = {};
    for (const name of BOOK_DEFAULTS_FIELDS) {
      const submittedValues = queued.getAll(name);
      const control = namedControl(form, name);
      if (submittedValues.length !== 1 || !control || !allowedValues(control).includes(submittedValues[0])) {
        return { request: null, invalid: true };
      }
      body.set(name, submittedValues[0]);
      values[name] = submittedValues[0];
    }
    const selectedControl = namedControl(form, BOOK_DEFAULTS_SELECTED_PAGES);
    const selected = queued.getAll(BOOK_DEFAULTS_SELECTED_PAGES);
    const pageOptions = allowedValues(selectedControl);
    if (!selectedControl || selected.some((value) => !pageOptions.includes(value))) {
      return { request: null, invalid: true };
    }
    body.delete(BOOK_DEFAULTS_SELECTED_PAGES);
    selected.forEach((value) => body.append(BOOK_DEFAULTS_SELECTED_PAGES, value));
    values[BOOK_DEFAULTS_SELECTED_PAGES] = selected;
    const payload = body.toString();
    return { request: { body, payload }, invalid: false, values };
  } catch {
    return { request: null, invalid: true };
  }
}

function applyQueuedValues(form, values) {
  if (!values) return;
  for (const name of BOOK_DEFAULTS_FIELDS) {
    const control = namedControl(form, name);
    if (control) control.value = values[name];
  }
  const selectedControl = namedControl(form, BOOK_DEFAULTS_SELECTED_PAGES);
  const selected = new Set(values[BOOK_DEFAULTS_SELECTED_PAGES] || []);
  Array.from(selectedControl?.options || []).forEach((option) => {
    option.selected = selected.has(String(option.value));
  });
}

async function reconcileUncertainDefaults(
  form,
  session,
  options,
  focus = captureBookDefaultsFocus(form),
) {
  session.reconciling = true;
  form.setAttribute?.('aria-busy', 'true');
  setControlsDisabled(form, session, true);
  setStatus(
    form,
    'Could not confirm whether defaults were saved. Restoring current Book Defaults authority.',
    'reconciling',
  );

  const fetchAuthority = options.fetchAuthority || (() => fetchCanonicalAuthority(form));
  const authority = await fetchAuthority({ form, session });
  const baseline = authority?.canonicalForm ? canonicalPayload(authority.canonicalForm) : null;
  const publishDialog = baseline !== null && prepareCanonicalDialog(form, authority);
  const publishAuthority = options.publishAuthority || (options.installDetail
    ? (document, destination, generation, detailRegion, publishPeer) => {
      const outcome = options.installDetail(document, destination, generation, detailRegion);
      if (outcome !== 'installed') return outcome;
      return publishPeer() ? 'installed' : 'unavailable';
    }
    : publishBookDetailLiveRegionSnapshotAtomically);
  const detailInstalled = Boolean(publishDialog) && publishAuthority(
    form.ownerDocument,
    authority.destination,
    session.authorityGeneration,
    authority.detailRegion,
    publishDialog,
  ) === 'installed';
  if (detailInstalled) setControlsDisabled(form, session, true);
  if (!detailInstalled) {
    showReconciliationFailure(form, session, async () => {
      const retryFocus = captureBookDefaultsFocus(form);
      removeReconciliationRetry(session);
      session.authorityGeneration = session.beginRefresh(form.ownerDocument);
      await reconcileUncertainDefaults(form, session, options, retryFocus);
    });
    return false;
  }

  session.acknowledgedPayload = baseline;
  const queued = reconstructQueuedRequest(form, session.queuedRequest);
  session.queuedRequest = null;
  if (!queued.invalid) applyQueuedValues(form, queued.values);
  enhanceDropdowns(form);
  enhanceBookDefaultsFetchSave(form, options);
  session.reconciling = false;
  session.active = false;
  removeReconciliationRetry(session);
  setControlsDisabled(form, session, false);
  form.removeAttribute?.('aria-busy');
  clearValidation(form);
  restoreBookDefaultsFocus(form, focus);
  if (queued.invalid) {
    setStatus(
      form,
      'Current Book Defaults were restored. A newer queued change was not applied because its Page choices are no longer valid.',
      'reconciled-queued-invalid',
    );
    return true;
  }
  setStatus(form, 'Current Book Defaults were restored.', 'reconciled');
  if (queued.request) session.resume?.(queued.request);
  return true;
}

function refreshAcknowledgedState(form, session, beginRefresh, refresh) {
  if (!session?.destination) return 'unnecessary';
  const onError = () => showAcknowledgedRefreshFailure(form, session);
  const onComplete = () => {
    removeStatusRetry(session);
    setStatus(form, 'Settings saved.', 'saved');
  };
  let outcome = refresh(
    form.ownerDocument,
    session.destination,
    session.authorityGeneration,
    { onComplete, onError },
  );
  if (outcome === 'superseded') {
    const currentGeneration = beginRefresh(form.ownerDocument);
    outcome = currentGeneration === null
      ? 'unavailable'
      : refresh(form.ownerDocument, session.destination, currentGeneration, { onComplete, onError });
  }
  if (outcome === 'unavailable') onError();
  if (outcome === 'superseded') onError();
  return outcome;
}

function showAcknowledgedRefreshFailure(form, session) {
  setStatus(
    form,
    'Defaults were saved, but the Book detail could not refresh. ',
    'saved-refresh-error',
  );
  const status = form.querySelector?.('[data-settings-fetch-save-status]');
  showStatusRetry({
    state: session,
    status,
    attribute: 'data-book-defaults-refresh-retry',
    onRetry: () => retryAcknowledgedRefresh(form, session),
  });
}

async function retryAcknowledgedRefresh(form, session) {
  if (session.refreshRetryInFlight) return false;
  session.refreshRetryInFlight = true;
  const attempt = session.presentationVersion;
  setStatus(form, 'Defaults were saved. Retrying the Book detail refresh.', 'saved-refresh-pending');
  const authorityGeneration = session.beginRefresh(form.ownerDocument);
  const fetchAuthority = session.options.fetchAuthority || (() => fetchCanonicalAuthority(form));
  const authority = await fetchAuthority({ form, session });
  if (attempt !== session.presentationVersion) {
    session.refreshRetryInFlight = false;
    return false;
  }
  const baseline = authority?.canonicalForm ? canonicalPayload(authority.canonicalForm) : null;
  const publishDialog = baseline !== null && prepareCanonicalDialog(form, authority);
  const publishAuthority = session.options.publishAuthority || (session.options.installDetail
    ? (document, destination, generation, detailRegion, publishPeer) => {
      const outcome = session.options.installDetail(document, destination, generation, detailRegion);
      if (outcome !== 'installed') return outcome;
      return publishPeer() ? 'installed' : 'unavailable';
    }
    : publishBookDetailLiveRegionSnapshotAtomically);
  const installed = authorityGeneration !== null && Boolean(publishDialog) && publishAuthority(
    form.ownerDocument,
    authority.destination,
    authorityGeneration,
    authority.detailRegion,
    publishDialog,
  ) === 'installed';
  session.refreshRetryInFlight = false;
  if (!installed) {
    showAcknowledgedRefreshFailure(form, session);
    return false;
  }

  session.acknowledgedPayload = baseline;
  session.authorityGeneration = null;
  removeStatusRetry(session);
  enhanceDropdowns(form);
  enhanceBookDefaultsFetchSave(form, session.options);
  clearValidation(form);
  restoreBookDefaultsFocus(form, {});
  setStatus(form, 'Settings saved. Book detail refreshed.', 'saved');
  return true;
}

export function enhanceBookDefaultsFetchSave(scope = globalThis.document, options = {}) {
  const beginRefresh = options.beginRefresh || beginBookDetailDefaultsLiveRefresh;
  const refresh = options.refresh || refreshBookDetailLiveRegion;
  return bookDefaultsForms(scope).reduce(
    (bound, form) => bound + enhanceSettingsFetchSave(form, {
      headers: { 'X-CreatorCrate-Enhancement': BOOK_DEFAULTS_REQUEST_MODE },
      parseAcknowledgement: parseBookDefaultsAcknowledgement,
      shouldQueue: ({ form: currentForm }) => !sessions.get(currentForm)?.reconciling,
      onStart: ({ form: currentForm }) => {
        clearValidation(currentForm);
        if (!sessions.has(currentForm)) {
          sessions.set(currentForm, {
            active: true,
            authorityGeneration: beginRefresh(currentForm.ownerDocument),
            destination: null,
            acknowledgedPayload: null,
            beginRefresh,
            disabledControls: new Map(),
            form: currentForm,
            options,
            presentationVersion: 0,
            queuedRequest: null,
            reconciling: false,
            refreshRetryButton: null,
            refreshRetryInFlight: false,
            resume: null,
            retryButton: null,
          });
        } else {
          const session = sessions.get(currentForm);
          if (!session.active) {
            session.active = true;
            session.authorityGeneration = beginRefresh(currentForm.ownerDocument);
            session.destination = null;
            session.presentationVersion += 1;
            removeStatusRetry(session);
          }
          session.options = options;
        }
      },
      onAcknowledged: ({ form: currentForm, acknowledgement, payload }) => {
        const session = sessions.get(currentForm);
        if (!session) return;
        session.destination = acknowledgement.refreshUrl;
        session.acknowledgedPayload = payload;
      },
      onSuccess: ({ form: currentForm }) => {
        const session = sessions.get(currentForm);
        if (session) session.active = false;
        refreshAcknowledgedState(currentForm, session, beginRefresh, refresh);
      },
      onUncertain: ({ form: currentForm, queuedRequest, resume }) => {
        const session = sessions.get(currentForm);
        if (!session) return;
        session.queuedRequest = queuedRequest;
        session.resume = resume;
        void reconcileUncertainDefaults(currentForm, session, options);
      },
      onError: ({ form: currentForm, superseded, ...outcome }) => {
        if (superseded) return;
        const session = sessions.get(currentForm);
        if (session) session.active = false;
        refreshAcknowledgedState(currentForm, session, beginRefresh, refresh);
        if (isUncertainMutationOutcome(outcome)) {
          setStatus(
            currentForm,
            'Could not confirm whether defaults were saved. Refresh the page before making more changes.',
            'error',
          );
        }
      },
      onValidationError: ({ form: currentForm, response, html, superseded }) => {
        if (superseded) return;
        if (response?.ok) return;
        if (!replaceValidationBody(currentForm, html, options)) {
          setStatus(currentForm, 'Could not save defaults. Your current changes were kept.', 'error');
        }
      },
    }),
    0,
  );
}
