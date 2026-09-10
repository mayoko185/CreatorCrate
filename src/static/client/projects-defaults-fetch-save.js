import { enhanceSettingsFetchSave } from './settings-fetch-save.js';
import {
  beginProjectsDefaultsLiveRefresh,
  beginReleasesDefaultsLiveRefresh,
  refreshProjectsLiveRegion,
  refreshReleasesLiveRegion,
} from './live-regions.js';

const PROJECTS_DEFAULTS_FORM_SELECTOR = '#projects-defaults-form';
const RELEASES_DEFAULTS_FORM_SELECTOR = '#releases-defaults-form';
const refreshSessions = new WeakMap();

function isDefaultsAutosaveForm(form, formSelector, markerAttribute) {
  return form?.matches?.(formSelector)
    && form.hasAttribute?.(markerAttribute);
}

function defaultsForms(scope, formSelector, markerAttribute) {
  if (!scope) return [];
  const forms = [];
  if (isDefaultsAutosaveForm(scope, formSelector, markerAttribute)) forms.push(scope);
  scope.querySelectorAll?.(formSelector).forEach((form) => {
    if (isDefaultsAutosaveForm(form, formSelector, markerAttribute)) forms.push(form);
  });
  return forms;
}

function clearDefaultsValidation(form) {
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

function markDefaultsRefreshFailed(form, message) {
  const status = form.querySelector?.('[data-settings-fetch-save-status]');
  form.setAttribute?.('data-settings-fetch-save-state', 'saved-refresh-error');
  if (!status) return;
  status.setAttribute?.('role', 'status');
  status.setAttribute?.('aria-live', 'polite');
  status.setAttribute?.('aria-atomic', 'true');
  status.textContent = message;
}

export function enhancePageDefaultsFetchSave(scope = globalThis.document, options = {}) {
  const {
    formSelector,
    markerAttribute,
    beginRefresh,
    refresh,
    refreshFailureMessage,
  } = options;
  if (!formSelector || !markerAttribute || typeof beginRefresh !== 'function'
    || typeof refresh !== 'function' || !refreshFailureMessage) return 0;

  return defaultsForms(scope, formSelector, markerAttribute).reduce(
    (bound, form) => bound + enhanceSettingsFetchSave(form, {
      onStart: ({ form: currentForm }) => {
        clearDefaultsValidation(currentForm);
        if (!refreshSessions.has(currentForm)) {
          refreshSessions.set(currentForm, {
            authorityGeneration: beginRefresh(currentForm.ownerDocument),
          });
        }
      },
      onError: ({ form: currentForm, superseded }) => {
        if (!superseded) refreshSessions.delete(currentForm);
      },
      onSuccess: ({ form: currentForm, response }) => {
        const session = refreshSessions.get(currentForm);
        refreshSessions.delete(currentForm);
        const outcome = refresh(
          currentForm.ownerDocument,
          response?.url,
          session?.authorityGeneration,
          { onError: () => markDefaultsRefreshFailed(currentForm, refreshFailureMessage) },
        );
        if (outcome === 'unavailable') markDefaultsRefreshFailed(currentForm, refreshFailureMessage);
      },
    }),
    0,
  );
}

export function enhanceProjectsDefaultsFetchSave(scope = globalThis.document, options = {}) {
  return enhancePageDefaultsFetchSave(scope, {
    formSelector: PROJECTS_DEFAULTS_FORM_SELECTOR,
    markerAttribute: 'data-projects-defaults-autosave',
    beginRefresh: options.beginRefresh || beginProjectsDefaultsLiveRefresh,
    refresh: options.refresh || refreshProjectsLiveRegion,
    refreshFailureMessage: 'Settings saved, but Projects could not refresh. Refresh the page to see the saved defaults.',
  });
}

export function enhanceReleasesDefaultsFetchSave(scope = globalThis.document, options = {}) {
  return enhancePageDefaultsFetchSave(scope, {
    formSelector: RELEASES_DEFAULTS_FORM_SELECTOR,
    markerAttribute: 'data-releases-defaults-autosave',
    beginRefresh: options.beginRefresh || beginReleasesDefaultsLiveRefresh,
    refresh: options.refresh || refreshReleasesLiveRegion,
    refreshFailureMessage: 'Settings saved, but Releases could not refresh. Refresh the page to see the saved defaults.',
  });
}
