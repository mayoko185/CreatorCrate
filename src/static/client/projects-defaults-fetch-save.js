import { enhanceSettingsFetchSave } from './settings-fetch-save.js';
import {
  beginProjectsDefaultsLiveRefresh,
  refreshProjectsLiveRegion,
} from './live-regions.js';

const PROJECTS_DEFAULTS_FORM_SELECTOR = '#projects-defaults-form';
const refreshSessions = new WeakMap();

function isProjectsDefaultsAutosaveForm(form) {
  return form?.matches?.(PROJECTS_DEFAULTS_FORM_SELECTOR)
    && form.hasAttribute?.('data-projects-defaults-autosave');
}

function projectsDefaultsForms(scope) {
  if (!scope) return [];
  const forms = [];
  if (isProjectsDefaultsAutosaveForm(scope)) forms.push(scope);
  scope.querySelectorAll?.(PROJECTS_DEFAULTS_FORM_SELECTOR).forEach((form) => {
    if (isProjectsDefaultsAutosaveForm(form)) forms.push(form);
  });
  return forms;
}

function clearProjectsDefaultsValidation(form) {
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

function markProjectsDefaultsRefreshFailed(form) {
  const status = form.querySelector?.('[data-settings-fetch-save-status]');
  form.setAttribute?.('data-settings-fetch-save-state', 'saved-refresh-error');
  if (!status) return;
  status.setAttribute?.('role', 'status');
  status.setAttribute?.('aria-live', 'polite');
  status.setAttribute?.('aria-atomic', 'true');
  status.textContent = 'Settings saved, but Projects could not refresh. Refresh the page to see the saved defaults.';
}

export function enhanceProjectsDefaultsFetchSave(scope = globalThis.document, options = {}) {
  const beginRefresh = options.beginRefresh || beginProjectsDefaultsLiveRefresh;
  const refresh = options.refresh || refreshProjectsLiveRegion;
  return projectsDefaultsForms(scope).reduce(
    (bound, form) => bound + enhanceSettingsFetchSave(form, {
      onStart: ({ form: currentForm }) => {
        clearProjectsDefaultsValidation(currentForm);
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
          { onError: () => markProjectsDefaultsRefreshFailed(currentForm) },
        );
        if (outcome === 'unavailable') markProjectsDefaultsRefreshFailed(currentForm);
      },
    }),
    0,
  );
}
