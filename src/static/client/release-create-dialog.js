import { setAppDialogBaseline } from './app-dialogs.js';
import { DASHBOARD_RELEASE_CREATED_EVENT, refreshDashboard } from './dashboard.js';
import { initializeCreatorCrateDropdown } from './dropdowns.js';
import { beginReleasesDefaultsLiveRefresh, refreshReleasesLiveRegion } from './live-regions.js';
import { bindProjectAssetsReleaseSync, syncProjectAssetsReleaseHost } from './project-assets-release-sync.js';
import { PROJECT_EDIT_SAVED_EVENT } from './project-edit-dialog.js';
import { removeStatusRetry, showStatusRetry } from './status-retry.js';

// The Dashboard, Releases and Project Assets New Release dialog, saved through
// the shared async dialog binder. A created release leaves the user on the host page:
// the binder closes the dialog and shows its message in the page feedback,
// this module adds a View Release link to it, and the host refreshes its own
// release content with a GET (filters, view and scroll stay as they were).
// The create POST is never repeated: a failed refresh offers Retry refresh,
// which only refreshes again. On Project Assets the dialog creates the release
// from the assets selected when it opened and adopts only the page's release
// information (project-assets-release-sync.js), so selections, pending order
// and filters stay exactly as they were. The Releases handoff dialog keeps its
// native submission and is left alone.
export const RELEASE_CREATE_DIALOG_ID = 'release-create-dialog';

const DASHBOARD_REFRESH_FAILURE_MESSAGE = 'The dashboard could not refresh. Reload the page to see it.';
const RELEASES_REFRESH_FAILURE_MESSAGE = 'Releases could not refresh.';
const RELEASES_UNAVAILABLE_MESSAGE = 'Releases could not refresh. Refresh the page to see it.';
const RELEASES_REFRESHING_MESSAGE = 'Refreshing Releases…';
const PROJECT_PLACEHOLDER = 'Select a project';
const RETRY_KEY = 'releaseCreateRetryButton';
const BASELINE_EXCLUDED_FIELDS = new Set([
  'description', 'plannedDate', 'plannedTime', 'noSetReleaseDate', 'retainedPlannedDate', 'retainedPlannedTime',
]);
const SELECTION_FORM_ATTRIBUTE = 'data-release-create-selection-form';
const SELECTION_SUMMARY_SELECTOR = '[data-release-create-selection-summary]';
const SELECTION_INPUT_SELECTOR = 'input[type="hidden"][name="selectedAssetIds"]';
const NO_SELECTION_MESSAGE = 'No assets selected. Close this dialog and select the assets for this release.';
const TOOLBAR_TRIGGER_SELECTOR =`.page-heading [data-dialog-open="${RELEASE_CREATE_DIALOG_ID}"]`;

function createdReleaseUrl(payload) {
  const url = payload?.release?.url;
  return typeof url === 'string' && /^\/releases\/\d+$/.test(url) ? url : null;
}

function createdReleaseManageAssetsUrl(payload) {
  const url = payload?.release?.manageAssetsUrl;
  return typeof url === 'string' && /^\/releases\/\d+\/assets$/.test(url) ? url : null;
}

function feedbackText(document) {
  return document.querySelector('[data-dialog-feedback] [data-dialog-feedback-text]');
}

// Runs after the binder writes the success message, so the link sits inside
// the feedback text and goes with it on the next write.
function appendLink(document, url, label, attribute) {
  const text = feedbackText(document);
  if (!text || !url) return;
  const link = document.createElement('a');
  link.href = url;
  link.textContent = label;
  link.setAttribute(attribute, '');
  text.append(' ', link);
}

function appendViewLink(document, url) {
  appendLink(document, url, 'View Release', 'data-release-create-view');
}

// The page keeps its scroll position, so the confirmation stays in view until
// the user dismisses it.
function pinFeedback(document) {
  const feedback = document.querySelector('[data-dialog-feedback]');
  const text = feedbackText(document);
  if (!feedback || !text) return;
  feedback.classList.add('app-dialog-feedback--pinned');
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'button button-small button-secondary';
  dismiss.textContent = 'Dismiss';
  dismiss.setAttribute('data-release-create-dismiss', '');
  dismiss.addEventListener('click', () => {
    feedback.classList.remove('app-dialog-feedback--pinned');
    feedback.hidden = true;
    feedback.setAttribute('hidden', '');
    text.textContent = '';
    document.querySelector(`[data-dialog-open="${RELEASE_CREATE_DIALOG_ID}"]`)?.focus?.({ preventScroll: true });
  });
  text.append(' ', dismiss);
}

// The selected ids exactly as a native submission of the selection form would
// send them: every checked control it owns, in document order (a pending
// reorder included), whether or not it is currently shown. The server decides
// whether they are valid.
function selectedAssetIds(document, selectionFormId) {
  const selectionForm = document.getElementById(selectionFormId);
  const windowObject = document.defaultView || globalThis;
  if (!selectionForm || typeof windowObject.FormData !== 'function') return [];
  return new windowObject.FormData(selectionForm).getAll('selectedAssetIds').map(String);
}

function clearSelection(form) {
  form.querySelectorAll(SELECTION_INPUT_SELECTOR).forEach((input) => input.remove());
}

function loadSelection(document, form, dialog, selectionFormId) {
  clearSelection(form);
  const ids = selectedAssetIds(document, selectionFormId);
  ids.forEach((id) => {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = 'selectedAssetIds';
    input.value = id;
    form.append(input);
  });
  const summary = form.querySelector(SELECTION_SUMMARY_SELECTOR);
  if (summary) {
    summary.textContent = ids.length === 0
      ? NO_SELECTION_MESSAGE
      : `Creating a release from ${ids.length} selected asset${ids.length === 1 ? '' : 's'}.`;
  }
  // Nothing to send yet; the server still refuses an empty selection.
  dialog.querySelectorAll('[data-dialog-submit]').forEach((control) => {
    control.disabled = ids.length === 0;
  });
}

// A refresh note has its own span so a retry can replace it; an empty
// message removes it. Returns the Retry refresh button when one is offered.
function setRefreshNote(document, dialogState, message, onRetry = null) {
  removeStatusRetry(dialogState, RETRY_KEY);
  const text = feedbackText(document);
  let note = text?.querySelector('[data-release-create-refresh-note]');
  if (!message) {
    note?.remove();
    return null;
  }
  if (!text) return null;
  if (!note) {
    note = document.createElement('span');
    note.setAttribute('data-release-create-refresh-note', '');
    text.append(note);
  }
  note.textContent = ` ${message} `;
  if (!onRetry) return null;
  return showStatusRetry({
    state: dialogState,
    status: text,
    attribute: 'data-release-create-refresh-retry',
    key: RETRY_KEY,
    onRetry,
  });
}

// The empty-state New Release lives in the refreshed region; when it took
// focus with it, the heading's New Release takes over.
function restoreLostFocus(document) {
  const active = document.activeElement;
  if (active && active !== document.body && active.isConnected) return;
  document.querySelector(TOOLBAR_TRIGGER_SELECTOR)?.focus?.({ preventScroll: true });
}

function refreshReleases(document, dialogState, { focusRetry = false } = {}) {
  const fail = () => {
    const retry = setRefreshNote(document, dialogState, RELEASES_REFRESH_FAILURE_MESSAGE, ({ wasFocused }) => {
      setRefreshNote(document, dialogState, RELEASES_REFRESHING_MESSAGE);
      refreshReleases(document, dialogState, { focusRetry: wasFocused });
    });
    if (focusRetry) retry?.focus?.();
  };
  const generation = beginReleasesDefaultsLiveRefresh(document);
  const result = generation === null ? 'unavailable' : refreshReleasesLiveRegion(document, null, generation, {
    // The feedback notice reports the outcome; the region stays quiet.
    failureMessage: '',
    onError: fail,
    onSuccess: () => {
      setRefreshNote(document, dialogState, '');
      restoreLostFocus(document);
    },
  });
  if (result === 'unavailable') setRefreshNote(document, dialogState, RELEASES_UNAVAILABLE_MESSAGE);
}

function refreshHost(document, dialogState, releaseId) {
  if (document.querySelector('[data-dashboard]')) {
    // The Dashboard's scheduling recovery refreshes and, on failure, offers
    // its own Retry refresh; without it, refresh once and report a dashboard
    // left stale.
    const windowObject = document.defaultView || globalThis;
    const handled = !document.dispatchEvent(new windowObject.CustomEvent(DASHBOARD_RELEASE_CREATED_EVENT, {
      cancelable: true,
      detail: { releaseId },
    }));
    if (handled) return;
    refreshDashboard(document).then((outcome) => {
      if (outcome.status !== 'refreshed' && outcome.status !== 'superseded') {
        setRefreshNote(document, dialogState, DASHBOARD_REFRESH_FAILURE_MESSAGE);
      }
    });
    return;
  }
  if (document.querySelector('[data-releases-live-region]')) refreshReleases(document, dialogState);
}

// The Project dropdown keeps its last summary when no project is checked, so
// a reset to "no project" restores the rendered placeholder itself.
function syncProjectSummary(form) {
  const dropdown = form.querySelector('[data-dialog-field="projectId"] [data-cc-dropdown]');
  if (!dropdown) return;
  initializeCreatorCrateDropdown(dropdown);
  if (dropdown.querySelector('input[name="projectId"]:checked')) return;
  const current = dropdown.querySelector('[data-cc-dropdown-summary-current]');
  if (current) current.textContent = PROJECT_PLACEHOLDER;
  const summary = dropdown.querySelector('summary');
  summary?.setAttribute('title', PROJECT_PLACEHOLDER);
  const ariaLabel = summary?.getAttribute('aria-label') || '';
  const separator = ariaLabel.indexOf(':');
  if (separator >= 0) summary.setAttribute('aria-label', `${ariaLabel.slice(0, separator + 1)} ${PROJECT_PLACEHOLDER}`);
}

// Project Assets' dialog defaults its title to the page's project title (see
// buildProjectAssetsReleaseCreateFormModel). A confirmed rename replaces that
// default in the baseline alone, which the binder applies on the next open or
// dismissal, so a draft in the form is never written to. The fixed project's
// option label follows it, as a fresh render would show it.
function adoptSavedProjectTitle(form, dialogState, detail) {
  const projectInput = form.querySelector('input[name="projectId"]');
  const title = detail?.project?.title;
  if (!projectInput || String(detail?.projectId) !== projectInput.value
    || typeof title !== 'string' || !title || !dialogState.savedValues) return;
  dialogState.savedValues = { ...dialogState.savedValues, title };
  const label = projectInput.closest('label')?.querySelector('span');
  const previous = label?.textContent;
  if (label) label.textContent = title;
  form.querySelectorAll('[data-dialog-field="projectId"] .asset-filter-multiselect-summary-width span').forEach((span) => {
    if (span.textContent === previous) span.textContent = title;
  });
  syncProjectSummary(form);
}

export function enhanceReleaseCreateDialog(scope = globalThis.document) {
  const document = scope?.nodeType === 9 ? scope : scope?.ownerDocument;
  const dialog = document?.getElementById?.(RELEASE_CREATE_DIALOG_ID);
  const dialogState = dialog?.__creatorCrateAppDialogState;
  const form = dialogState?.form;
  if (!form || form.getAttribute('data-dialog-async') !== 'true' || dialogState.releaseCreateBound) return null;
  dialogState.releaseCreateBound = true;
  const selectionFormId = form.getAttribute(SELECTION_FORM_ATTRIBUTE);
  if (selectionFormId) {
    bindProjectAssetsReleaseSync(document);
    document.addEventListener(PROJECT_EDIT_SAVED_EVENT, (event) => adoptSavedProjectTitle(form, dialogState, event.detail));
  }

  // A refused create keeps exactly what the user entered (schedule,
  // platforms, link and project included).
  dialogState.preserveValuesOnError = true;
  // The rendered New Release defaults are the confirmed baseline, so a
  // dismissal also clears a refused create's errors and status, and each
  // success replaces it with the server's fresh defaults. The schedule and
  // Description are left out: release-schedule-defaults.js and
  // release-signatures.js reset them on the form's reset, exactly as for a
  // dismissal. A dialog rendered open with a native draft keeps its own reset
  // values instead.
  if (!form.hasAttribute('data-dialog-reset-values') && dialogState.savedValues) {
    setAppDialogBaseline(document, RELEASE_CREATE_DIALOG_ID, Object.fromEntries(
      Object.entries(dialogState.savedValues).filter(([name]) => !BASELINE_EXCLUDED_FIELDS.has(name)),
    ));
  }

  const previousOnOpen = dialogState.onOpen;
  dialogState.onOpen = (...args) => {
    const result = previousOnOpen?.(...args);
    syncProjectSummary(form);
    if (selectionFormId) loadSelection(document, form, dialog, selectionFormId);
    return result;
  };
  const previousOnClose = dialogState.onClose;
  dialogState.onClose = (...args) => {
    syncProjectSummary(form);
    if (selectionFormId) clearSelection(form);
    return previousOnClose?.(...args);
  };

  // A create in flight may already have written the release, so the dialog
  // stays open until its outcome is known rather than resetting the draft.
  const previousBeforeClose = dialogState.beforeClose;
  dialogState.beforeClose = (context) => {
    if (dialogState.submitting) return false;
    return previousBeforeClose ? previousBeforeClose(context) : true;
  };

  const previousSuccess = dialogState.onSuccessfulSubmit;
  dialogState.onSuccessfulSubmit = (payload) => {
    const result = previousSuccess?.(payload);
    if (result === true) return true;
    const url = createdReleaseUrl(payload);
    const releaseId = payload?.release?.id ?? null;
    // After the binder records the fresh defaults, shows the message and
    // closes the dialog.
    Promise.resolve().then(() => {
      removeStatusRetry(dialogState, RETRY_KEY);
      appendViewLink(document, url);
      if (selectionFormId) {
        appendLink(document, createdReleaseManageAssetsUrl(payload), 'Manage Release Assets', 'data-release-create-manage-assets');
        pinFeedback(document);
        syncProjectAssetsReleaseHost(document);
        return;
      }
      refreshHost(document, dialogState, releaseId);
    });
    return result;
  };
  return dialogState;
}
