import { appDialogOpenCount, enhanceAppDialogs, closeAppDialogById, dialogHostIsStale, openAppDialogById } from './app-dialogs.js';
import { liveRegionWindow } from './dom.js';
import { enhanceDropdowns } from './dropdowns.js';
import { enhanceDatePickers } from './pickers.js';
import { removeStatusRetry, showStatusRetry } from './status-retry.js';

// Review & Publish, published through the shared async dialog binder. The user
// stays on the host page: the binder closes the dialog on a confirmed
// publication, and the host updates itself from RELEASE_PUBLISH_SETTLED_EVENT.
// The publish POST is never repeated automatically. When its outcome is unknown
// (the response was lost or unreadable) Publish stays disabled until a GET of
// the publication state settles whether it happened.
export const RELEASE_PUBLISH_DIALOG_ID = 'release-publish-dialog';
// Dispatched on the document. detail.outcome 'published': the server confirmed
// the publication. 'stale': a dismissed dialog held a state the page can no
// longer trust, detail.message (when set) says what the server reported, and
// detail.archived is true when the server reported the release as archived.
export const RELEASE_PUBLISH_SETTLED_EVENT = 'release-publish-settled';

const ARCHIVED_CODES = new Set(['RELEASE_ARCHIVED', 'PROJECT_ARCHIVED']);
const STALE_CODES = new Set(['RELEASE_ALREADY_PUBLISHED', ...ARCHIVED_CODES, 'RELEASE_NOT_FOUND']);
const CHECK_KEY = 'releasePublishCheckButton';
const UNCONFIRMED_MESSAGE = 'Could not confirm whether the release was published. It may already be published, so Publish is paused. Check the publication status before trying again.';
const CHECKING_MESSAGE = 'Checking publication status…';
const CHECK_FAILED_MESSAGE = 'Could not check the publication status. The release may already be published.';
const NOT_PUBLISHED_MESSAGE = 'The release was not published. You can publish it again.';
const SUPERSEDED_MESSAGE = 'The release was not published, but it has changed since. Close this dialog to load its current details.';
const CONFIRMED_MESSAGE = 'Release published.';
const NO_LONGER_AVAILABLE_MESSAGE = 'This release can no longer be published.';
// The publication state does not separate the release from its parent project.
const ARCHIVED_MESSAGE = 'The release or its parent project is archived, so this release cannot be published.';
const LOAD_FAILURE_MESSAGE ='Review & Publish could not be loaded.';
// The newest openReleasePublishDialog call of each document.
const openGenerations = new WeakMap();

function setDialogMessage(dialog, message, error = true) {
  const summary = dialog.querySelector('[data-dialog-error]');
  const text = dialog.querySelector('[data-dialog-error-text]');
  if (text) text.textContent = error ? message : '';
  if (summary) summary.hidden = !error;
  const status = dialog.querySelector('[data-dialog-status]');
  if (status) status.textContent = message;
  if (error) dialog.setAttribute('data-dialog-state', 'error');
  else dialog.removeAttribute('data-dialog-state');
}

function publishUrlOf(form) {
  return form.getAttribute('action');
}

function requestPublishState(document, url) {
  return liveRegionWindow(document).fetch(url, {
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  }).then(async (response) => {
    let payload = {};
    try { payload = await response.json(); } catch {}
    return { response, payload };
  });
}

/**
 * Binds the page's Review & Publish dialog; a dialog replaced by a host refresh
 * is bound again. Returns its dialog state, or null without a dialog.
 */
export function enhanceReleasePublishDialog(scope = globalThis.document) {
  const document = scope?.nodeType === 9 ? scope : scope?.ownerDocument;
  const dialog = document?.getElementById?.(RELEASE_PUBLISH_DIALOG_ID);
  const dialogState = dialog?.__creatorCrateAppDialogState;
  const form = dialogState?.form;
  if (!form || form.getAttribute('data-dialog-async') !== 'true') return null;
  if (dialogState.releasePublishBound) return dialogState;
  dialogState.releasePublishBound = true;

  const releaseId = publishUrlOf(form).match(/^\/releases\/(\d+)\/publish$/)?.[1] ?? null;
  const submit = () => dialog.querySelector('[data-dialog-submit]');
  // Set while Publish is paused: 'unconfirmed' until a check settles the
  // outcome, 'stale' once the server refused the release's rendered state.
  let paused = null;
  let staleMessage = null;
  let staleArchived = false;
  let checking = false;

  const pause = (reason) => {
    paused = reason;
    const control = submit();
    if (control) control.disabled = true;
  };
  // Publish is gone for good, so focus moves from it to the way out.
  const pauseStale = (message, archived) => {
    pause('stale');
    staleMessage = message;
    staleArchived = archived;
    dialog.querySelector('footer [data-dialog-close]')?.focus?.({ preventScroll: true });
  };
  const settle = (outcome, detail = {}) => {
    Promise.resolve().then(() => {
      document.dispatchEvent(new (liveRegionWindow(document).CustomEvent)(RELEASE_PUBLISH_SETTLED_EVENT, {
        detail: { outcome, releaseId, ...detail },
      }));
    });
  };

  dialogState.submitLocked = () => paused !== null;
  // A refused publication keeps exactly what the user entered.
  dialogState.preserveValuesOnError = true;
  // The rendered defaults are the confirmed baseline, so a dismissal also clears
  // a refused publication's errors and status. A dialog rendered open with a
  // native draft keeps showing that draft until then.
  dialogState.savedValues = JSON.parse(form.getAttribute('data-dialog-reset-values'));
  dialogState.authoritativeBaseline = true;

  // A publication in flight may already have committed, so the dialog stays
  // open until its outcome is known. So does a status check.
  const previousBeforeClose = dialogState.beforeClose;
  dialogState.beforeClose = (context) => {
    if (dialogState.submitting || checking) return false;
    return previousBeforeClose ? previousBeforeClose(context) : true;
  };

  const check = () => {
    checking = true;
    setDialogMessage(dialog, CHECKING_MESSAGE, false);
    const url = publishUrlOf(form);
    return requestPublishState(document, url).then(({ response, payload }) => {
      checking = false;
      if (!response.ok || payload?.status !== 'success') {
        if (response.status === 404) return { publishable: false };
        return null;
      }
      return {
        published: payload.release?.published === true,
        publishable: payload.eligibility?.publishable === true,
        archived: payload.release?.archived === true,
      };
    }, () => {
      checking = false;
      return null;
    }).then((state) => {
      if (!state) {
        offerCheck(CHECK_FAILED_MESSAGE);
        return;
      }
      removeStatusRetry(dialogState, CHECK_KEY);
      if (state.published) {
        // The earlier request (or another tab) published it; report it as done.
        paused = null;
        setDialogMessage(dialog, '', false);
        closeAppDialogById(document, RELEASE_PUBLISH_DIALOG_ID);
        settle('published', { message: CONFIRMED_MESSAGE, socialPreparationAvailable: false, payload: null });
        return;
      }
      if (state.publishable) {
        // This answer may predate what the page has since learned, which wins.
        if (paused === 'stale' || dialogHostIsStale(dialog)) {
          setDialogMessage(dialog, SUPERSEDED_MESSAGE);
          dialog.querySelector('footer [data-dialog-close]')?.focus?.({ preventScroll: true });
          return;
        }
        paused = null;
        const control = submit();
        if (control) control.disabled = false;
        setDialogMessage(dialog, NOT_PUBLISHED_MESSAGE);
        control?.focus?.({ preventScroll: true });
        return;
      }
      const message = state.archived ? ARCHIVED_MESSAGE : NO_LONGER_AVAILABLE_MESSAGE;
      setDialogMessage(dialog, message);
      pauseStale(message, state.archived === true);
    });
  };

  const offerCheck = (message) => {
    pause('unconfirmed');
    setDialogMessage(dialog, message);
    const mount = dialog.querySelector('[data-dialog-error]');
    const button = showStatusRetry({
      state: dialogState,
      status: mount,
      attribute: 'data-release-publish-check',
      key: CHECK_KEY,
      label: 'Check publication status',
      onRetry: check,
    });
    button?.focus?.({ preventScroll: true });
  };

  dialogState.onUnconfirmedSubmit = () => offerCheck(UNCONFIRMED_MESSAGE);

  const previousFailure = dialogState.onFailedSubmit;
  dialogState.onFailedSubmit = (payload, response) => {
    previousFailure?.(payload, response);
    if (STALE_CODES.has(payload?.code)) {
      pauseStale(payload.message, ARCHIVED_CODES.has(payload.code));
      return;
    }
    // An error the application wrote says what happened. Anything else (an
    // unreadable answer to the POST) leaves the outcome unknown; the refusals
    // that never reach the route are not publications either way.
    if (!payload?.status && ![401, 403, 404].includes(response?.status)) offerCheck(UNCONFIRMED_MESSAGE);
  };

  const previousSuccess = dialogState.onSuccessfulSubmit;
  dialogState.onSuccessfulSubmit = (payload) => {
    const result = previousSuccess?.(payload);
    if (result === true) return true;
    // After the binder shows the message and closes the dialog.
    settle('published', {
      message: payload?.message || CONFIRMED_MESSAGE,
      socialPreparationAvailable: payload?.socialPreparation?.available === true,
      payload,
    });
    return result;
  };

  const previousOnClose = dialogState.onClose;
  dialogState.onClose = (...args) => {
    const result = previousOnClose?.(...args);
    removeStatusRetry(dialogState, CHECK_KEY);
    // Publish stays disabled: only a host refresh brings a current dialog.
    if (paused) settle('stale', { message: paused === 'stale' ? staleMessage : null, archived: staleArchived });
    return result;
  };
  return dialogState;
}

/**
 * Opens Review & Publish on a page that does not render it. mount is an empty
 * element of the host page; its content is replaced with the current dialog
 * from GET /releases/:id/publish, so nothing here can publish a superseded
 * state. Resolves to { status: 'opened' }, { status: 'unavailable', message }
 * (the release cannot be published, or the page holds a publication in flight),
 * { status: 'failed', message } or { status: 'superseded' } (a newer load, or a
 * dialog opened meanwhile, even one dismissed since, took over, so this response
 * populated nothing).
 */
export async function openReleasePublishDialog(document, releaseId, { mount, opener = null } = {}) {
  const current = document.getElementById(RELEASE_PUBLISH_DIALOG_ID);
  if (current?.open || current?.__creatorCrateAppDialogState?.submitting) {
    return { status: 'unavailable', message: LOAD_FAILURE_MESSAGE };
  }
  const generation = (openGenerations.get(document) ?? 0) + 1;
  openGenerations.set(document, generation);
  const dialogOpens = appDialogOpenCount(document);
  const superseded = () => openGenerations.get(document) !== generation
    || appDialogOpenCount(document) !== dialogOpens
    || Boolean(document.querySelector('dialog[open]'));
  let result;
  try {
    result = await requestPublishState(document, `/releases/${releaseId}/publish`);
  } catch {
    if (superseded()) return { status: 'superseded' };
    return { status: 'failed', message: LOAD_FAILURE_MESSAGE };
  }
  if (superseded()) return { status: 'superseded' };
  const { response, payload } = result;
  if (!response.ok || payload?.status !== 'success' || String(payload.release?.id) !== String(releaseId)) {
    return { status: 'failed', message: payload?.message || LOAD_FAILURE_MESSAGE };
  }
  if (payload.eligibility?.publishable !== true || typeof payload.dialogHtml !== 'string') {
    return { status: 'unavailable', message: NO_LONGER_AVAILABLE_MESSAGE };
  }
  const parsed = new (liveRegionWindow(document).DOMParser)().parseFromString(payload.dialogHtml, 'text/html');
  mount.replaceChildren(...Array.from(parsed.body.children).map((node) => document.importNode(node, true)));
  enhanceAppDialogs(document);
  enhanceDropdowns(document);
  enhanceDatePickers(mount);
  enhanceReleasePublishDialog(document);
  openAppDialogById(document, RELEASE_PUBLISH_DIALOG_ID, opener);
  return { status: 'opened' };
}
