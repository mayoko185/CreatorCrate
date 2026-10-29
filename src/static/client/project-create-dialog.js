import { setAppDialogBaseline } from './app-dialogs.js';
import { refreshDashboard } from './dashboard.js';
import { beginProjectsDefaultsLiveRefresh, refreshProjectsLiveRegion } from './live-regions.js';

// The Dashboard and Projects New Project dialog, saved through the shared
// async dialog binder. A created project leaves the user on the host page:
// the binder closes the dialog and shows its message in the page feedback,
// this module adds a View Project link to it, and the host refreshes its own
// project content (filters, tab and scroll stay as they were).
export const PROJECT_CREATE_DIALOG_ID = 'project-create-dialog';

const DASHBOARD_REFRESH_FAILURE_MESSAGE = 'The dashboard could not refresh. Reload the page to see it.';
const PROJECTS_REFRESH_FAILURE_MESSAGE = 'Project created, but Projects could not refresh. Refresh the page to see it.';

function createdProjectUrl(payload) {
  const url = payload?.project?.url;
  return typeof url === 'string' && /^\/projects\/\d+$/.test(url) ? url : null;
}

// Runs after the binder writes the success message, so the link and any
// refresh note sit inside the feedback text and go with it on the next write.
function appendFeedback(document, { url = null, note = '' } = {}) {
  const text = document.querySelector('[data-dialog-feedback] [data-dialog-feedback-text]');
  if (!text) return;
  if (url) {
    const link = document.createElement('a');
    link.href = url;
    link.textContent = 'View Project';
    link.setAttribute('data-project-create-view', '');
    text.append(' ', link);
  }
  if (note) text.append(` ${note}`);
}

function refreshHost(document) {
  if (document.querySelector('[data-dashboard]')) {
    // A failure that lost the refreshed region or was superseded is reported
    // by the dashboard itself or the later refresh; only a dashboard left
    // stale needs telling.
    refreshDashboard(document).then((outcome) => {
      if (outcome.status !== 'refreshed' && outcome.status !== 'superseded') {
        appendFeedback(document, { note: DASHBOARD_REFRESH_FAILURE_MESSAGE });
      }
    });
    return;
  }
  const generation = beginProjectsDefaultsLiveRefresh(document);
  if (generation === null) return;
  const windowObject = document.defaultView || globalThis;
  refreshProjectsLiveRegion(document, windowObject.location.href, generation, {
    failureMessage: PROJECTS_REFRESH_FAILURE_MESSAGE,
  });
}

export function enhanceProjectCreateDialog(scope = globalThis.document) {
  const document = scope?.nodeType === 9 ? scope : scope?.ownerDocument;
  const dialog = document?.getElementById?.(PROJECT_CREATE_DIALOG_ID);
  const dialogState = dialog?.__creatorCrateAppDialogState;
  const form = dialogState?.form;
  if (!form || form.getAttribute('data-dialog-async') !== 'true' || dialogState.projectCreateBound) return null;
  dialogState.projectCreateBound = true;

  // A refused create keeps exactly what the user entered (tags included).
  dialogState.preserveValuesOnError = true;
  // The rendered New Project defaults are the confirmed baseline, so a
  // dismissal also clears a refused create's errors and status, and each
  // success replaces it with the server's fresh defaults. A dialog rendered
  // open with a native draft keeps its own reset values instead.
  if (!form.hasAttribute('data-dialog-reset-values') && dialogState.savedValues) {
    setAppDialogBaseline(document, PROJECT_CREATE_DIALOG_ID, dialogState.savedValues);
  }
  // A create in flight may already have written the project, so the dialog
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
    const url = createdProjectUrl(payload);
    // After the binder records the fresh defaults, shows the message and
    // closes the dialog.
    Promise.resolve().then(() => {
      appendFeedback(document, { url });
      refreshHost(document);
    });
    return result;
  };
  return dialogState;
}
