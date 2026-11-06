import { closeAppDialogById } from './app-dialogs.js';
import { isEnhancementBound, liveRegionWindow, markEnhancementBound } from './dom.js';
import { PROJECT_ASSETS_REGION_LOADED_EVENT, refreshProjectAssetsAfterMutation } from './live-regions.js';

// WP10B: Remove missing assets on the invoking Project Assets page. The
// confirmation is the page's existing app dialog; its form goes through the
// shared async binder, which sends at most one POST per confirmation and keeps
// the dialog open (and undismissable) while that POST is pending. This module
// only decides what each answer means and reports it.
//
// The removal scope is the service's: every eligible record of the project
// that is marked missing when the request runs, whatever the page filters
// show. Counts and ids are only ever taken from the server's answer.
//
// A request whose answer is lost is never re-sent. The page then holds it as
// unresolved for as long as this document lives: no confirmation of this
// project can be submitted here again. GET-only reads of Project Assets (Check
// again, filters, other features' refreshes) update what the page shows, but a
// read is an observation of the current records, never proof that the lost
// request arrived, finished, failed or can no longer run, so no read ends the
// hold or settles the request. There is no operation-specific receipt for this
// request, so nothing on this page can settle it later; only an answer to the
// POST itself could, and that answer was lost. The hold is document-local: a
// reload or another tab does not know about the earlier request.
export const REMOVE_MISSING_ASSETS_DIALOG_ID = 'remove-missing-assets-dialog';

const FORM_SELECTOR = '[data-remove-missing-assets-form]';
const TRIGGER_SELECTOR = `[data-dialog-open="${REMOVE_MISSING_ASSETS_DIALOG_ID}"]`;
const PENDING_SELECTOR = '[data-remove-missing-pending]';
const PENDING_TEXT_SELECTOR = '[data-remove-missing-pending-text]';
const PENDING_CHECK_SELECTOR = '[data-remove-missing-pending-check]';
const FEEDBACK_ACTION_ATTRIBUTE = 'data-remove-missing-feedback-action';
const OUTCOMES = new Set(['removed', 'none-missing', 'protected-only']);
// Answers from before the route ran: authentication and CSRF.
const PRE_ROUTE_REFUSALS = new Set([401, 403]);
// Refusals after which this confirmation can never succeed on this page.
const RETIRING_CODES = new Set(['PROJECT_ARCHIVED', 'PROJECT_NOT_FOUND']);

const NOTHING_REMOVED = 'Nothing was removed.';
// Every unresolved message says the request was submitted, that its result is
// unknown, that it may still run, and that this page will not send another.
const STILL_HELD = 'The earlier request was not sent again and may still be processed, so Remove missing assets stays unavailable on this page.';
const UNCONFIRMED_MESSAGE = `A Remove missing assets request was submitted, but its result could not be confirmed. ${STILL_HELD} Checking Project Assets…`;
const CHECKING_MESSAGE = `Checking Project Assets… The result of the earlier Remove missing assets request is still unknown. ${STILL_HELD}`;
const CHECK_FAILED_MESSAGE = `Could not load Project Assets. The result of the earlier Remove missing assets request is still unknown. ${STILL_HELD} Use Check again to read Project Assets.`;
const CHECK_PENDING_MESSAGE = `Project Assets is still updating. The result of the earlier Remove missing assets request is still unknown. ${STILL_HELD}`;
const CHECK_UNAVAILABLE_MESSAGE = `The result of the earlier Remove missing assets request is still unknown. ${STILL_HELD} Reload Project Assets to see the current records; reloading does not cancel the earlier request.`;
const OBSERVED_NONE = 'Project Assets now shows the records as last read, with no missing asset records. That read does not show which request, scan or other change removed them.';
const OBSERVED_SOME = 'Project Assets now shows the records as last read, and some are still marked missing. That read does not show whether the earlier request arrived, finished or failed.';
const OBSERVED_GUIDANCE = `The result of the earlier Remove missing assets request is still unknown. ${STILL_HELD} Use Check again to read Project Assets again.`;
const BLOCKED_MESSAGE = 'An earlier Remove missing assets request for this project was submitted but its result could not be confirmed. It may still be processed, so another removal cannot be sent from this page. See the page notice about the earlier request.';
const REFRESH_FAILED_SUFFIX = 'Project Assets could not refresh and may be outdated. Use Retry refresh to load the current assets.';
const REFRESH_PENDING_SUFFIX = 'Project Assets is still updating.';
const REFRESH_UNAVAILABLE_SUFFIX = 'Project Assets could not refresh here. Reload the page to see the current assets.';

const controllers = new WeakMap();

function controllerFor(document) {
  let controller = controllers.get(document);
  if (!controller) {
    // unresolved: the lost request of this page, if any. report: the newest
    // acknowledged result, so a stale refresh never overwrites a newer one.
    controller = { unresolved: null, report: null };
    controllers.set(document, controller);
  }
  return controller;
}

function isCount(value) {
  return Number.isInteger(value) && value >= 0;
}

function isIdList(value, length) {
  return Array.isArray(value) && value.length === length && value.every((id) => Number.isInteger(id) && id > 0);
}

/**
 * Whether a success answer is this project's acknowledged result: the ids and
 * counts must agree with each other and with the named outcome, or nothing it
 * says is believed.
 */
export function acknowledgedRemoveMissingResult(payload, projectId) {
  if (payload?.status !== 'success' || !OUTCOMES.has(payload.outcome)
    || String(payload.projectId) !== String(projectId)) return null;
  const { removedCount, protectedCount, totalMissingCandidates: candidates } = payload;
  if (![removedCount, protectedCount, candidates].every(isCount)
    || removedCount + protectedCount !== candidates
    || !isIdList(payload.removedAssetIds, removedCount)
    || !isIdList(payload.protectedAssetIds, protectedCount)
    || typeof payload.message !== 'string' || !payload.message) return null;
  const expected = candidates === 0 ? 'none-missing' : (removedCount === 0 ? 'protected-only' : 'removed');
  return payload.outcome === expected ? payload : null;
}

// The page's shared dialog feedback, outside the live region so a refresh
// keeps it. variant: 'success', 'warning' or 'error'.
function showPageFeedback(document, message, variant = 'success', action = null) {
  const feedback = document.querySelector?.('[data-dialog-feedback]');
  const text = feedback?.querySelector?.('[data-dialog-feedback-text]');
  if (!feedback || !text) return;
  feedback.classList?.toggle?.('notice--success', variant === 'success');
  feedback.classList?.toggle?.('notice--warning', variant === 'warning');
  feedback.classList?.toggle?.('notice--error', variant === 'error');
  text.textContent = message;
  // Another action's link would not belong to this message.
  feedback.querySelector?.(`[${FEEDBACK_ACTION_ATTRIBUTE}]`)?.remove?.();
  feedback.querySelector?.('[data-auto-rename-feedback-action]')?.remove?.();
  if (action) {
    const link = document.createElement('a');
    link.className = 'button button-small button-secondary';
    link.setAttribute(FEEDBACK_ACTION_ATTRIBUTE, '');
    link.href = action.href;
    link.textContent = action.label;
    feedback.appendChild(link);
  }
  feedback.hidden = false;
  feedback.removeAttribute?.('hidden');
}

function reloadAction(document) {
  const location = liveRegionWindow(document)?.location;
  return location ? { href: `${location.pathname || ''}${location.search || ''}`, label: 'Reload Project Assets' } : null;
}

function setDialogMessage(dialog, message, error = true) {
  const summary = dialog?.querySelector?.('[data-dialog-error]');
  const text = dialog?.querySelector?.('[data-dialog-error-text]');
  if (text) text.textContent = error ? message : '';
  if (summary) {
    summary.hidden = !error;
    if (error) summary.removeAttribute?.('hidden');
    else summary.setAttribute?.('hidden', '');
  }
  const status = dialog?.querySelector?.('[data-dialog-status]');
  if (status) status.textContent = message;
  if (error) dialog?.setAttribute?.('data-dialog-state', 'error');
  else dialog?.removeAttribute?.('data-dialog-state');
}

function setSubmitDisabled(dialog, disabled) {
  const control = dialog?.querySelector?.('[data-dialog-submit]');
  if (!control) return;
  control.disabled = disabled;
  if (disabled) {
    control.setAttribute?.('disabled', '');
    control.setAttribute?.('aria-disabled', 'true');
  } else {
    control.removeAttribute?.('disabled');
    control.removeAttribute?.('aria-disabled');
  }
}

function currentDialog(document) {
  return document.getElementById?.(REMOVE_MISSING_ASSETS_DIALOG_ID) || null;
}

// The page notice for an unresolved request; it outlives the dialog and every
// Project Assets refresh, and its Check again only reads.
function renderPendingNotice(document, operation) {
  const notice = document.querySelector?.(PENDING_SELECTOR);
  if (!notice) return;
  const text = notice.querySelector?.(PENDING_TEXT_SELECTOR);
  const check = notice.querySelector?.(PENDING_CHECK_SELECTOR);
  if (!operation) {
    const hadFocus = Boolean(notice.contains?.(document.activeElement));
    notice.hidden = true;
    notice.setAttribute?.('hidden', '');
    if (check) {
      check.hidden = true;
      check.setAttribute?.('hidden', '');
    }
    if (hadFocus) document.querySelector?.(TRIGGER_SELECTOR)?.focus?.({ preventScroll: true });
    return;
  }
  if (text) text.textContent = operation.message;
  if (check) {
    check.hidden = !operation.checkOffered;
    if (operation.checkOffered) check.removeAttribute?.('hidden');
    else check.setAttribute?.('hidden', '');
  }
  notice.hidden = false;
  notice.removeAttribute?.('hidden');
}

/** The page's unresolved Remove missing assets request, if any. */
export function pendingRemoveMissingOperation(document) {
  return controllers.get(document)?.unresolved || null;
}

// What the installed page shows, which never settles what the lost request did.
function observedMessage(document) {
  return `${document.querySelector?.(TRIGGER_SELECTOR) ? OBSERVED_SOME : OBSERVED_NONE} ${OBSERVED_GUIDANCE}`;
}

// A read installed. It only updates what the notice reports as observed: the
// hold stays, the dialog stays blocked and Check again stays available. A read
// is never attributed to the earlier request and never yields counts for it.
function recordObservation(document, operation) {
  if (controllerFor(document).unresolved !== operation) return;
  operation.message = observedMessage(document);
  operation.checkOffered = true;
  operation.observed = true;
  renderPendingNotice(document, operation);
}

/**
 * Reads Project Assets for an unresolved request: GET only, never the removal.
 * Only the newest read reports, and no read ends the hold.
 */
function checkOperation(document, operation, { focusCheck = false } = {}) {
  const controller = controllerFor(document);
  if (controller.unresolved !== operation) return Promise.resolve(null);
  operation.checks += 1;
  const generation = operation.checks;
  operation.message = CHECKING_MESSAGE;
  operation.checkOffered = false;
  renderPendingNotice(document, operation);
  // A failed or superseded read recovering later reports only while it is
  // still the newest read; a newer Check again owns the notice otherwise.
  const onRecovered = () => {
    if (generation === operation.checks) recordObservation(document, operation);
  };
  return refreshProjectAssetsAfterMutation(document, { onRecovered }).then((result) => {
    if (controller.unresolved !== operation || generation !== operation.checks) return result;
    if (result?.status === 'installed') {
      recordObservation(document, operation);
    } else if (result?.status === 'failed') {
      operation.message = CHECK_FAILED_MESSAGE;
      operation.checkOffered = true;
    } else if (result?.status === 'superseded') {
      operation.message = CHECK_PENDING_MESSAGE;
      operation.checkOffered = true;
    } else {
      operation.message = CHECK_UNAVAILABLE_MESSAGE;
      operation.checkOffered = false;
    }
    renderPendingNotice(document, operation);
    if (focusCheck && operation.checkOffered && !document.querySelector?.('dialog[open]')) {
      document.querySelector?.(`${PENDING_SELECTOR} ${PENDING_CHECK_SELECTOR}`)?.focus?.({ preventScroll: true });
    }
    return result;
  });
}

function bindPendingCheck(document) {
  const check = document.querySelector?.(`${PENDING_SELECTOR} ${PENDING_CHECK_SELECTOR}`);
  if (!check || isEnhancementBound(check, 'removeMissingPendingCheckBound')) return;
  markEnhancementBound(check, 'removeMissingPendingCheckBound');
  check.addEventListener('click', () => {
    const operation = controllerFor(document).unresolved;
    if (operation) void checkOperation(document, operation, { focusCheck: true });
  });
}

// Reports an acknowledged result and synchronizes Project Assets through GETs
// only. Only 'installed' is reported as current; a later recovery of a failed
// or superseded refresh restores the plain message once.
function reportAcknowledged(document, result) {
  const controller = controllerFor(document);
  const report = { recovered: false };
  controller.report = report;
  const variant = result.outcome === 'removed' ? 'success' : 'warning';
  const message = result.message;
  showPageFeedback(document, `${message} Updating Project Assets…`, variant);
  const onRecovered = () => {
    if (controller.report !== report || report.recovered) return;
    report.recovered = true;
    showPageFeedback(document, message, variant);
  };
  return refreshProjectAssetsAfterMutation(document, { onRecovered }).then((refresh) => {
    if (controller.report !== report || report.recovered) return refresh;
    if (refresh?.status === 'installed') {
      showPageFeedback(document, message, variant);
    } else if (refresh?.status === 'failed') {
      showPageFeedback(document, `${message} ${REFRESH_FAILED_SUFFIX}`, 'warning');
    } else if (refresh?.status === 'superseded') {
      showPageFeedback(document, `${message} ${REFRESH_PENDING_SUFFIX}`, variant);
    } else {
      showPageFeedback(document, `${message} ${REFRESH_UNAVAILABLE_SUFFIX}`, 'warning', reloadAction(document));
    }
    return refresh;
  });
}

function bindDialog(document) {
  const dialog = currentDialog(document);
  const state = dialog?.__creatorCrateAppDialogState;
  const form = state?.form;
  if (!state || state.removeMissingBound || !form?.matches?.(FORM_SELECTOR)
    || form.getAttribute?.('data-dialog-async') !== 'true') return false;
  state.removeMissingBound = true;
  state.removeMissingRetired = false;
  const controller = controllerFor(document);
  const projectId = form.getAttribute('data-project-id');

  // Nothing in this form is a draft: an answer never rewrites its fields.
  state.preserveValuesOnError = true;
  const previousLocked = state.submitLocked;
  state.submitLocked = () => state.removeMissingRetired || Boolean(controller.unresolved)
    || previousLocked?.() === true;
  // A confirmation a refresh inserts while a request is unresolved starts blocked.
  if (controller.unresolved) {
    setSubmitDisabled(dialog, true);
    setDialogMessage(dialog, BLOCKED_MESSAGE);
  }

  // While the POST is pending its result is unknown, so the confirmation stays.
  const previousBeforeClose = state.beforeClose;
  state.beforeClose = (context) => {
    if (state.submitting) return false;
    return previousBeforeClose ? previousBeforeClose(context) : true;
  };

  // Every open is a fresh confirmation, unless this page cannot send one.
  const previousOnOpen = state.onOpen;
  state.onOpen = (...args) => {
    previousOnOpen?.(...args);
    if (state.removeMissingRetired) return;
    if (controller.unresolved) {
      setSubmitDisabled(dialog, true);
      setDialogMessage(dialog, BLOCKED_MESSAGE);
    } else {
      setSubmitDisabled(dialog, false);
      setDialogMessage(dialog, '', false);
    }
  };

  const unconfirmed = () => {
    setSubmitDisabled(dialog, true);
    const operation = { projectId, checks: 0, message: UNCONFIRMED_MESSAGE, checkOffered: false };
    controller.unresolved = operation;
    // The page notice carries the operation from here, so the confirmation
    // closes and Check again is reachable; a reopened one stays blocked.
    setDialogMessage(dialog, '', false);
    renderPendingNotice(document, operation);
    closeAppDialogById(document, REMOVE_MISSING_ASSETS_DIALOG_ID);
    void checkOperation(document, operation, { focusCheck: true });
  };
  state.onUnconfirmedSubmit = unconfirmed;

  const previousFailure = state.onFailedSubmit;
  state.onFailedSubmit = (payload, response) => {
    previousFailure?.(payload, response);
    const refused = payload?.status === 'error'
      && (payload.outcome === 'refused' || payload.outcome === 'failed'
        || (PRE_ROUTE_REFUSALS.has(response?.status) && payload.outcome === undefined));
    if (!refused) {
      // An unreadable answer or an unexpected error leaves the outcome unknown.
      unconfirmed();
      return;
    }
    const base = typeof payload.message === 'string' && payload.message ? payload.message : 'Missing asset records could not be removed.';
    setDialogMessage(dialog, base.includes(NOTHING_REMOVED) ? base : `${base} ${NOTHING_REMOVED}`);
    if (RETIRING_CODES.has(payload.code)) {
      state.removeMissingRetired = true;
      setSubmitDisabled(dialog, true);
      // GET only: the page then shows the project as it now is.
      void refreshProjectAssetsAfterMutation(document);
    }
    dialog.querySelector?.('footer [data-dialog-close]')?.focus?.({ preventScroll: true });
  };

  const previousSuccess = state.onSuccessfulSubmit;
  state.onSuccessfulSubmit = (payload) => {
    previousSuccess?.(payload);
    const result = acknowledgedRemoveMissingResult(payload, projectId);
    if (!result) {
      unconfirmed();
      return true;
    }
    renderPendingNotice(document, null);
    setDialogMessage(dialog, '', false);
    closeAppDialogById(document, REMOVE_MISSING_ASSETS_DIALOG_ID);
    void reportAcknowledged(document, result);
    return true;
  };
  return true;
}

/**
 * Makes the page's Remove missing assets confirmation submit in place. Bound
 * once per document; a dialog that a Project Assets refresh adopts later is
 * bound when that refresh installs. Returns whether the page has the action.
 */
export function enhanceRemoveMissingAssets(scope = globalThis.document) {
  const document = scope?.nodeType === 9 ? scope : scope?.ownerDocument;
  if (!document?.querySelector?.(PENDING_SELECTOR)) return false;
  if (!isEnhancementBound(document, 'removeMissingAssetsBound')) {
    markEnhancementBound(document, 'removeMissingAssetsBound');
    document.addEventListener?.(PROJECT_ASSETS_REGION_LOADED_EVENT, () => bindDialog(document));
    bindPendingCheck(document);
  }
  bindDialog(document);
  return true;
}
