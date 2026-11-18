import {
  enhanceSettingsFetchSave,
  queueSettingsFetchSave,
  setFetchSaveStatus,
} from './settings-fetch-save.js';
import {
  beginProjectAssetsDefaultsLiveRefresh,
  beginProjectsDefaultsLiveRefresh,
  beginReleasesDefaultsLiveRefresh,
  PROJECT_ASSETS_DEFAULTS_SAVE_REFRESH_ERROR_MESSAGE,
  refreshProjectAssetsDefaultsLiveRegion,
  refreshProjectAssetsWithLoadedDefaults,
  refreshProjectsLiveRegion,
  refreshReleasesLiveRegion,
} from './live-regions.js';
import {
  applyProjectAssetsCurrentGridStyle,
  beginProjectAssetsDefaultsAcknowledgement,
  markProjectAssetsDefaultsRendered,
  projectAssetsDefaultsEffectiveSnapshot,
  projectAssetsDefaultsGridStyleOnlyChange,
  prepareProjectAssetsDefaultsSave,
  projectAssetsDefaultsSaveBlockedReason,
  reconcileProjectAssetsDefaultsAcknowledgement,
} from './project-assets-defaults-scope.js';

const PROJECT_ASSETS_DEFAULTS_FORM_SELECTOR = '#project-assets-defaults-form';
// WP4 explicit save: a form opts in with this attribute. Only the page's submit
// control is bound to the fetch transport, so editing controls never autosave.
export const DEFAULTS_EXPLICIT_SAVE_ATTRIBUTE = 'data-defaults-explicit-save';
// Project Assets explicit saves always carry the Milestone 1 `intent=save`
// operation; a hidden input never fires `change`, so it cannot autosave.
export const PROJECT_ASSETS_DEFAULTS_EXPLICIT_SAVE_CONTROL_SELECTOR = (
  'input[type="hidden"][name="intent"][value="save"][data-autosubmit="fetch"]'
);
// WP7: the Project Assets combined dialog, whose eligible values are the live
// filter controls (project-assets-defaults-scope.js).
const DEFAULTS_LIVE_CONTROLS_ATTRIBUTE = 'data-defaults-live-controls';
const PROJECTS_DEFAULTS_FORM_SELECTOR = '#projects-defaults-form';
const RELEASES_DEFAULTS_FORM_SELECTOR = '#releases-defaults-form';
const refreshSessions = new WeakMap();
const acknowledgementFailures = new WeakSet();

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
    onAcknowledged,
    onStart,
    submitControlSelector,
    explicitSaveControlSelector,
    saveBlockedReason,
    prepareSave,
    prepareRequestBody,
  } = options;
  if (!formSelector || !markerAttribute || typeof beginRefresh !== 'function'
    || typeof refresh !== 'function' || !refreshFailureMessage) return 0;

  return defaultsForms(scope, formSelector, markerAttribute).reduce(
    (bound, form) => {
      const explicitSave = Boolean(explicitSaveControlSelector)
        && form.hasAttribute?.(DEFAULTS_EXPLICIT_SAVE_ATTRIBUTE);
      // Explicit mode binds the save control alone (the reviewed pattern used
      // by Settings reorder/mutations); autosave forms keep binding every
      // `[data-autosubmit="fetch"]` control exactly as before.
      const bindingScope = explicitSave
        ? { querySelectorAll: () => [form.querySelector?.(explicitSaveControlSelector)].filter(Boolean) }
        : form;
      const enhanced = enhanceSettingsFetchSave(bindingScope, {
        ...(typeof prepareRequestBody === 'function' ? { prepareRequestBody } : {}),
        onStart: ({ form: currentForm, payload }) => {
          onStart?.(currentForm, payload);
          clearDefaultsValidation(currentForm);
          if (!refreshSessions.has(currentForm)) {
            refreshSessions.set(currentForm, {
              authorityGeneration: beginRefresh(currentForm.ownerDocument),
              acknowledgedControls: new Set(),
            });
          }
        },
        onError: ({ form: currentForm, willContinue }) => {
          if (!willContinue) {
            refreshSessions.delete(currentForm);
            acknowledgementFailures.delete(currentForm);
          }
        },
        onAcknowledged: (detail) => {
          const acknowledgedControls = refreshSessions.get(detail.form)?.acknowledgedControls;
          detail.controlNames?.forEach((name) => acknowledgedControls?.add(name));
          if (typeof onAcknowledged !== 'function') return;
          if (onAcknowledged(detail) === false) acknowledgementFailures.add(detail.form);
          else acknowledgementFailures.delete(detail.form);
        },
        onSuccess: ({ form: currentForm, response }) => {
          const session = refreshSessions.get(currentForm);
          refreshSessions.delete(currentForm);
          const acknowledgementFailed = acknowledgementFailures.delete(currentForm);
          const outcome = refresh(
            currentForm.ownerDocument,
            response?.url,
            session?.authorityGeneration,
            { onError: () => markDefaultsRefreshFailed(currentForm, refreshFailureMessage),
              acknowledgedControls: session?.acknowledgedControls,
              form: currentForm,
              acknowledgementFailed },
          );
          if (outcome === 'unavailable') markDefaultsRefreshFailed(currentForm, refreshFailureMessage);
          if (acknowledgementFailed) {
            markDefaultsRefreshFailed(
              currentForm,
              'Settings saved, but the returned Project Assets defaults could not be read. Refresh the page before editing them again.',
            );
          }
        },
      });
      if (submitControlSelector && !form.dataset?.defaultsSubmitBound) {
        form.dataset.defaultsSubmitBound = 'true';
        form.addEventListener('submit', (event) => {
          event.preventDefault();
          queueSettingsFetchSave(form.querySelector(submitControlSelector));
        });
      }
      if (explicitSave && !form.dataset?.defaultsExplicitSaveBound) {
        form.dataset.defaultsExplicitSaveBound = 'true';
        form.addEventListener('submit', (event) => {
          // One Save action is one queued request: the transport drops a repeat
          // of the in-flight payload and keeps only the newest different one.
          // Explicit-save forms never fall back to a native POST: a missing or
          // unbound save control reports an error instead of navigating.
          event.preventDefault();
          // WP6: a page may refuse a Save it cannot target safely (Project
          // Assets while a defaults scope is changing); the refusal is shown.
          const blocked = (typeof saveBlockedReason === 'function' ? saveBlockedReason(form) : null)
            // WP7: the page brings the payload up to date with what it shows.
            || (typeof prepareSave === 'function' ? prepareSave(form) : null);
          if (blocked) {
            setFetchSaveStatus(form, blocked, 'error');
            return;
          }
          if (!queueSettingsFetchSave(form.querySelector(explicitSaveControlSelector))) {
            setFetchSaveStatus(form, 'Could not save settings. Your current changes were kept.', 'error');
          }
        });
      }
      return bound + enhanced;
    },
    0,
  );
}

// Only a successfully reconciled acknowledgement may restyle the grid in place.
// The rendered baseline advances only once the region shows the acknowledged
// values: immediately for an in-place restyle, or when a full refresh installs.
// WP6: an explicit-save form applies the acknowledged effective values to the
// latest intended view (keeping Category, Search, Show, Usage, page and
// suspended Tag/Extension provenance) instead of the success URL, which was
// built from a returnTo that a pending filter change may have outdated.
function refreshProjectAssetsDefaults(document, destination, authorityGeneration, options = {}) {
  const { form, acknowledgementFailed = false } = options;
  const gridStyle = acknowledgementFailed ? null : projectAssetsDefaultsGridStyleOnlyChange(form);
  const acknowledged = acknowledgementFailed ? null : projectAssetsDefaultsEffectiveSnapshot(form);
  if (acknowledged && form?.hasAttribute?.(DEFAULTS_EXPLICIT_SAVE_ATTRIBUTE)) {
    const outcome = refreshProjectAssetsWithLoadedDefaults(document, authorityGeneration, acknowledged, {
      onError: options.onError,
      gridStyle,
      onComplete: () => {
        markProjectAssetsDefaultsRendered(form, acknowledged);
        // Correction A (F2): a Grid style chosen while this refresh was
        // pending is the current one; the installed saved style yields to it.
        applyProjectAssetsCurrentGridStyle(form);
      },
      failureMessage: PROJECT_ASSETS_DEFAULTS_SAVE_REFRESH_ERROR_MESSAGE,
      // WP7: the combined dialog saved the Tag/Extension it shows, so the
      // current filter (explicit or inherited) is kept exactly as it is.
      filterDefaults: !form.hasAttribute?.(DEFAULTS_LIVE_CONTROLS_ATTRIBUTE),
    });
    if (outcome === 'applied') {
      markProjectAssetsDefaultsRendered(form, acknowledged);
      // The in-place restyle shows the saved style; a newer current choice
      // (the control) stays the one in use, as after an installed refresh.
      applyProjectAssetsCurrentGridStyle(form);
    }
    return outcome;
  }
  const outcome = refreshProjectAssetsDefaultsLiveRegion(
    document,
    destination,
    authorityGeneration,
    {
      ...options,
      gridStyle,
      onComplete: acknowledged ? () => markProjectAssetsDefaultsRendered(form, acknowledged) : null,
    },
  );
  if (outcome === 'applied' && acknowledged) markProjectAssetsDefaultsRendered(form, acknowledged);
  return outcome;
}

export function enhanceProjectAssetsDefaultsFetchSave(scope = globalThis.document, options = {}) {
  return enhancePageDefaultsFetchSave(scope, {
    formSelector: PROJECT_ASSETS_DEFAULTS_FORM_SELECTOR,
    markerAttribute: 'data-project-assets-defaults-autosave',
    // Inert unless the form opts in with DEFAULTS_EXPLICIT_SAVE_ATTRIBUTE.
    explicitSaveControlSelector: PROJECT_ASSETS_DEFAULTS_EXPLICIT_SAVE_CONTROL_SELECTOR,
    saveBlockedReason: projectAssetsDefaultsSaveBlockedReason,
    prepareSave: prepareProjectAssetsDefaultsSave,
    onStart: beginProjectAssetsDefaultsAcknowledgement,
    beginRefresh: options.beginRefresh || beginProjectAssetsDefaultsLiveRefresh,
    refresh: options.refresh || refreshProjectAssetsDefaults,
    refreshFailureMessage: 'Settings saved, but Project Assets could not refresh. Refresh the page to see the saved defaults.',
    onAcknowledged: options.onAcknowledged || ((detail) => (
      reconcileProjectAssetsDefaultsAcknowledgement(
        detail.form,
        detail.payload,
        { html: detail.html, superseded: detail.superseded },
      )
    )),
  });
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
