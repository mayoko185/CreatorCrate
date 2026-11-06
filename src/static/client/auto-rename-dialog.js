import { appDialogOpenCount, closeAppDialogById, enhanceAppDialogs, openAppDialogById } from './app-dialogs.js';
import { isEnhancementBound, liveRegionWindow, markEnhancementBound } from './dom.js';
import { refreshProjectAssetsAfterMutation } from './live-regions.js';
import { removeStatusRetry, showStatusRetry } from './status-retry.js';

// Auto Rename on the invoking Project Assets page. Preview posts the form the
// ordering controller has already validated and filled (the complete category
// order with hidden positions kept, and only the rendered checked selection),
// then mounts the server-rendered confirmation and opens it locally. Apply goes
// through the shared async dialog binder: at most one POST per review, and any
// answer retires the review, so trying again always needs a fresh Preview.
//
// An Apply whose answer is lost is never re-sent. It stays an unresolved
// operation of the page, not of its dialog: until the server's receipt for
// that exact Apply attempt proves what it did, no review of the same project
// can be applied here, whatever dialog is open or was dismissed. Each Preview
// is its own server-issued attempt, so another review's receipt never settles
// it, even for an identical signed plan. Current paths are shown only as
// observations; matching names never settle an operation.
export const AUTO_RENAME_DIALOG_ID = 'auto-rename-confirmation-dialog';

const PREVIEW_FORM_SELECTOR = '[data-auto-rename-form]';
const PREVIEW_SUBMIT_SELECTOR = '[data-auto-rename-submit]';
const PREVIEW_LIVE_SELECTOR = '[data-auto-rename-live]';
const MOUNT_SELECTOR = '[data-auto-rename-dialog-mount]';
const PENDING_SELECTOR = '[data-auto-rename-pending]';
const FEEDBACK_ACTION_ATTRIBUTE = 'data-auto-rename-feedback-action';
const CHECK_KEY = 'autoRenameCheckButton';
const ATTEMPT_PATTERN = /^[0-9a-f]{32}$/;

const PREVIEW_PENDING_MESSAGE = 'Preparing the Auto Rename review…';
const PREVIEW_FAILED_MESSAGE = 'Auto Rename preview could not be loaded. Nothing was renamed.';
const PREVIEW_STALE_MESSAGE = 'The category, selection or order changed while the review loaded. Choose Auto Rename again to review the current assets.';
const REVIEW_AGAIN = 'Nothing was applied from this review. Close it and choose Auto Rename again to review the current files.';
const CHECKING_MESSAGE = 'Checking what happened to Auto Rename…';
const UNCONFIRMED_MESSAGE = 'Could not confirm whether Auto Rename was applied. It was not sent again. Checking for its result…';
const NOT_RECORDED_MESSAGE = 'The server has no result for this Auto Rename yet, so it may still run or may never have arrived. It was not sent again.';
const UNKNOWN_RECORDED_MESSAGE = 'The server could not report what this Auto Rename did. It was not sent again.';
const CHECK_FAILED_MESSAGE = 'Could not check whether Auto Rename was applied. Auto Rename may have been applied. It was not sent again.';
const UNRESOLVED_GUIDANCE = 'Auto Rename stays unavailable for this project on this page until its result is confirmed. Use Check again, or review the project files before reloading the page.';
const RECOVERY_GUIDANCE = 'Auto Rename stays unavailable for this project on this page. Review the project folder before using Auto Rename again.';
const BLOCKED_REVIEW_MESSAGE = 'An earlier Auto Rename for this project is not settled, so this review cannot be applied. Close it and follow the page notice about the earlier Auto Rename.';
const SETTLED_NOT_APPLIED_SUFFIX = 'It was not sent again. Choose Auto Rename again to review the current files.';
const REFRESH_FAILED_SUFFIX = 'Project Assets could not refresh and may be outdated. Use Retry to load the current files.';
const REFRESH_PENDING_SUFFIX = 'Project Assets is still updating.';
const REFRESH_UNAVAILABLE_SUFFIX = 'Project Assets could not refresh here. Reload the page to see the renamed files.';

// What the current paths look like, never what happened.
const OBSERVATION_MESSAGES = {
  original: 'Project Assets currently lists the reviewed files under their original names; that alone does not show whether files on disk changed.',
  proposed: 'Project Assets currently lists the reviewed files under their new names; that alone does not show this Auto Rename renamed them.',
  mixed: 'Project Assets currently lists some reviewed files under their new names and others under their original names.',
  other: 'Project Assets currently lists the reviewed files under names that match neither this review nor their original names.',
};

// Refusals the server explains that leave a review unappliable but prove
// nothing was renamed by this request.
const NOTHING_RENAMED_OUTCOMES = new Set(['refused', 'restored']);
// Answers from before the route that never ran the rename.
const PRE_ROUTE_REFUSALS = new Set([401, 403]);

const controllers = new WeakMap();

function controllerFor(document) {
  let controller = controllers.get(document);
  if (!controller) {
    // operations: the unresolved or recovery-required Apply per project id.
    controller = { previewGeneration: 0, previewAbort: null, apply: null, operations: new Map() };
    controllers.set(document, controller);
  }
  return controller;
}

function readJson(response) {
  if (typeof response?.json !== 'function') return Promise.resolve({});
  return response.json().then((payload) => payload || {}, () => ({}));
}

// What the review covers: the authoritative category, complete order and
// selection exactly as the form would submit them.
function previewKey(form, windowObject) {
  if (!form) return null;
  const values = new windowObject.FormData(form);
  return [values.get('categoryId'), values.get('orderedAssetIds'), values.get('selectedAssetIds')]
    .map((value) => String(value ?? ''))
    .join('|');
}

function announce(form, message) {
  const live = form?.querySelector?.(PREVIEW_LIVE_SELECTOR);
  if (live) live.textContent = message;
}

function previewSubmitControl(document) {
  return document.querySelector?.(`${PREVIEW_SUBMIT_SELECTOR}:not([disabled])`) || null;
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
  feedback.querySelector?.(`[${FEEDBACK_ACTION_ATTRIBUTE}]`)?.remove?.();
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

/**
 * Describes a category's current database paths against a review: an
 * observation only, since it cannot tell which request produced them or
 * whether files on disk agree. reviewItems are the Preview items; assets are
 * { assetId, relativePath } of the whole category. Returns 'original' (every
 * reviewed rename still at its old path), 'proposed' (every one at its new
 * path), 'mixed' (some of each) or 'other' (any other evidence, including none).
 */
export function observeAutoRenamePaths(reviewItems, assets) {
  const renames = (Array.isArray(reviewItems) ? reviewItems : []).filter((item) => item?.status === 'rename');
  const paths = new Map((Array.isArray(assets) ? assets : []).map((asset) => [asset?.assetId, asset?.relativePath]));
  let proposed = 0;
  let original = 0;
  for (const item of renames) {
    const path = paths.get(item.assetId);
    if (path === item.proposedRelativePath) proposed += 1;
    else if (path === item.currentRelativePath) original += 1;
    else return 'other';
  }
  if (renames.length === 0) return 'other';
  if (proposed === renames.length) return 'proposed';
  if (original === renames.length) return 'original';
  return 'mixed';
}

/** The unsettled Apply held for a project on this page, if any. */
export function pendingAutoRenameOperation(document, projectId) {
  return controllers.get(document)?.operations.get(String(projectId)) || null;
}

// Reports a confirmed rename and synchronizes Project Assets through GETs only.
// Only 'installed' is reported as current; a later recovery of a failed or
// superseded refresh restores the plain success message once.
function reportCommitted(document, message) {
  const controller = controllerFor(document);
  const apply = { recovered: false };
  controller.apply = apply;
  showPageFeedback(document, `${message} Updating Project Assets…`);
  const onRecovered = () => {
    if (controller.apply !== apply || apply.recovered) return;
    apply.recovered = true;
    showPageFeedback(document, message);
  };
  return refreshProjectAssetsAfterMutation(document, { onRecovered }).then((result) => {
    if (controller.apply !== apply || apply.recovered) return result;
    if (result?.status === 'installed') {
      showPageFeedback(document, message);
    } else if (result?.status === 'failed') {
      showPageFeedback(document, `${message} ${REFRESH_FAILED_SUFFIX}`, 'warning');
    } else if (result?.status === 'superseded') {
      showPageFeedback(document, `${message} ${REFRESH_PENDING_SUFFIX}`);
    } else {
      const location = liveRegionWindow(document).location;
      showPageFeedback(document, `${message} ${REFRESH_UNAVAILABLE_SUFFIX}`, 'warning', location
        ? { href: `${location.pathname || ''}${location.search || ''}`, label: 'Reload Project Assets' }
        : null);
    }
    return result;
  });
}

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

function disableApply(dialog) {
  const control = dialog.querySelector('[data-dialog-submit]');
  if (control) {
    control.disabled = true;
    control.setAttribute('aria-disabled', 'true');
  }
}

// The page notice for a project's operation; it outlives every dialog and a
// Project Assets refresh, and its Check again only reads.
function renderPendingNotice(document, operation) {
  const notice = document.querySelector?.(PENDING_SELECTOR);
  if (!notice) return;
  const text = notice.querySelector?.('[data-auto-rename-pending-text]');
  const check = notice.querySelector?.('[data-auto-rename-pending-check]');
  if (!operation) {
    notice.hidden = true;
    notice.setAttribute?.('hidden', '');
    if (check) check.hidden = true;
    return;
  }
  notice.classList?.toggle?.('notice--warning', operation.state !== 'recovery-required');
  notice.classList?.toggle?.('notice--error', operation.state === 'recovery-required');
  if (text) text.textContent = operation.message;
  if (check) {
    const offered = operation.state === 'unresolved';
    check.hidden = !offered;
    if (offered) check.removeAttribute?.('hidden');
    else check.setAttribute?.('hidden', '');
  }
  notice.hidden = false;
  notice.removeAttribute?.('hidden');
}

function bindPendingCheck(document) {
  const check = document.querySelector?.(`${PENDING_SELECTOR} [data-auto-rename-pending-check]`);
  if (!check || isEnhancementBound(check, 'autoRenamePendingCheckBound')) return;
  markEnhancementBound(check, 'autoRenamePendingCheckBound');
  check.addEventListener('click', () => {
    const operation = [...controllerFor(document).operations.values()]
      .find((candidate) => candidate.state === 'unresolved');
    if (operation) void checkOperation(document, operation);
  });
}

// Shows an operation's state in the page notice and, while it is mounted and
// open, in the dialog of the review it came from.
function renderOperation(document, operation, { focusCheck = false } = {}) {
  renderPendingNotice(document, operation);
  const view = operation.view;
  if (!view?.dialog?.isConnected) return;
  setDialogMessage(view.dialog, operation.message);
  removeStatusRetry(view.state, CHECK_KEY);
  if (operation.state !== 'unresolved') return;
  const button = showStatusRetry({
    state: view.state,
    status: view.dialog.querySelector('[data-dialog-error]'),
    attribute: 'data-auto-rename-check',
    key: CHECK_KEY,
    label: 'Check again',
    onRetry: () => checkOperation(document, operation),
  });
  if (focusCheck) button?.focus?.({ preventScroll: true });
}

function refreshOnce(document, operation) {
  if (operation.refreshed) return;
  operation.refreshed = true;
  void refreshProjectAssetsAfterMutation(document);
}

// Records an Apply whose result is unknown or that left the project needing
// recovery. Either keeps every review of the project from being applied here.
function holdOperation(document, review, dialogState, state, message) {
  const controller = controllerFor(document);
  const key = String(review.projectId);
  const operation = {
    projectId: review.projectId,
    categoryId: review.categoryId,
    attemptId: review.attemptId,
    items: review.items,
    state,
    message,
    checks: 0,
    refreshed: false,
    view: { dialog: dialogState.dialog, state: dialogState },
  };
  controller.operations.set(key, operation);
  return operation;
}

// Only the server's receipt for this Apply attempt settles it: committed,
// refused or restored release the project; recovery-required keeps it held.
// Anything less leaves the operation unresolved.
function settleOperation(document, operation, receipt) {
  const controller = controllerFor(document);
  const key = String(operation.projectId);
  if (controller.operations.get(key) !== operation) return;
  const view = operation.view?.dialog?.isConnected ? operation.view : null;
  if (receipt.outcome === 'recovery-required') {
    operation.state = 'recovery-required';
    operation.message = `${receipt.message || 'Auto Rename could not fully restore the project files.'} ${RECOVERY_GUIDANCE}`;
    refreshOnce(document, operation);
    renderOperation(document, operation);
    return;
  }
  controller.operations.delete(key);
  const notice = document.querySelector?.(PENDING_SELECTOR);
  const focusWasInNotice = Boolean(notice?.contains?.(document.activeElement));
  renderPendingNotice(document, null);
  if (focusWasInNotice) previewSubmitControl(document)?.focus?.({ preventScroll: true });
  if (view) removeStatusRetry(view.state, CHECK_KEY);
  if (receipt.outcome === 'committed') {
    const message = typeof receipt.message === 'string' && receipt.message ? receipt.message : 'Auto Rename was applied.';
    if (view) {
      setDialogMessage(view.dialog, '', false);
      closeAppDialogById(document, AUTO_RENAME_DIALOG_ID);
    }
    void reportCommitted(document, `Auto Rename was applied. ${message}`);
    return;
  }
  const message = `${receipt.message || 'Auto Rename was not applied.'} ${SETTLED_NOT_APPLIED_SUFFIX}`;
  if (view) setDialogMessage(view.dialog, message);
  else showPageFeedback(document, message, 'warning');
}

/**
 * Reads what happened to an unresolved Apply: GET only, never Preview or
 * Apply. This attempt's receipt from any read settles it once; without one,
 * only the newest read may describe the current paths, and the operation
 * stays held.
 */
function checkOperation(document, operation, { focusCheck = false } = {}) {
  const controller = controllerFor(document);
  const windowObject = liveRegionWindow(document);
  const current = () => controller.operations.get(String(operation.projectId)) === operation
    && operation.state === 'unresolved';
  if (!current()) return Promise.resolve();
  operation.checks += 1;
  const generation = operation.checks;
  operation.message = CHECKING_MESSAGE;
  renderOperation(document, operation);
  const attempt = ATTEMPT_PATTERN.test(String(operation.attemptId || '')) ? operation.attemptId : null;
  const url = `/projects/${operation.projectId}/assets/auto-rename/state?categoryId=${encodeURIComponent(operation.categoryId)}`
    + (attempt ? `&attempt=${attempt}` : '');
  return windowObject.fetch(url, {
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  }).then(async (response) => ({ response, payload: await readJson(response) }))
    .then(({ response, payload }) => (response.ok && payload.status === 'success'
      && String(payload.projectId) === String(operation.projectId) ? payload : null), () => null)
    .then((payload) => {
      if (!current()) return;
      // A receipt counts only if it is this attempt's and the attempt has run;
      // an issued, applying or unknown attempt may still run or never arrive.
      const recorded = attempt && payload?.operation?.attemptId === attempt
        && payload.operation.state === 'completed' && payload.operation.recorded === true ? payload.operation : null;
      if (recorded && ['committed', 'refused', 'restored', 'recovery-required'].includes(recorded.outcome)) {
        settleOperation(document, operation, recorded);
        return;
      }
      if (generation !== operation.checks) return;
      if (!payload) {
        operation.message = `${CHECK_FAILED_MESSAGE} ${UNRESOLVED_GUIDANCE}`;
      } else {
        const observed = observeAutoRenamePaths(operation.items, payload.assets);
        if (observed === 'mixed' || observed === 'other') refreshOnce(document, operation);
        operation.message = [recorded ? UNKNOWN_RECORDED_MESSAGE : NOT_RECORDED_MESSAGE,
          OBSERVATION_MESSAGES[observed], UNRESOLVED_GUIDANCE].join(' ');
      }
      renderOperation(document, operation, { focusCheck });
    });
}

function bindConfirmation(document, dialogState, review) {
  if (dialogState.autoRenameBound) return;
  dialogState.autoRenameBound = true;
  const { dialog } = dialogState;
  const windowObject = liveRegionWindow(document);
  // 'open' until the one Apply has an answer; then 'refused', 'restored',
  // 'recovery-required', 'committed' or 'unresolved'.
  let outcome = 'open';
  // Captured when the review opens: an unsettled Apply of the same project
  // keeps this review unappliable for its whole life.
  const blocked = Boolean(pendingAutoRenameOperation(document, review.projectId));

  const retire = (next) => {
    outcome = next;
    disableApply(dialog);
  };
  const focusClose = () => dialog.querySelector('footer [data-dialog-close]')?.focus?.({ preventScroll: true });

  dialogState.submitLocked = () => outcome !== 'open' || !review.canApply || blocked
    || Boolean(pendingAutoRenameOperation(document, review.projectId));
  dialogState.preserveValuesOnError = true;
  if (blocked) {
    disableApply(dialog);
    setDialogMessage(dialog, BLOCKED_REVIEW_MESSAGE);
  }
  const previousBeforeClose = dialogState.beforeClose;
  // An Apply in flight may already be renaming files, so the review stays
  // open until its answer arrives. Once answered, an unresolved result lives
  // on in the page notice, so the review may close.
  dialogState.beforeClose = (context) => {
    if (dialogState.submitting) return false;
    return previousBeforeClose ? previousBeforeClose(context) : true;
  };

  const committed = (message) => {
    retire('committed');
    removeStatusRetry(dialogState, CHECK_KEY);
    setDialogMessage(dialog, '', false);
    closeAppDialogById(document, AUTO_RENAME_DIALOG_ID);
    void reportCommitted(document, message);
  };

  const unconfirmed = () => {
    retire('unresolved');
    const operation = holdOperation(document, review, dialogState, 'unresolved', UNCONFIRMED_MESSAGE);
    renderOperation(document, operation);
    void checkOperation(document, operation, { focusCheck: true });
  };

  dialogState.onUnconfirmedSubmit = unconfirmed;

  const previousFailure = dialogState.onFailedSubmit;
  dialogState.onFailedSubmit = (payload, response) => {
    previousFailure?.(payload, response);
    if (payload?.status === 'error' && payload.outcome === 'recovery-required') {
      // The service could not restore the project: files may have moved.
      retire('recovery-required');
      const operation = holdOperation(document, review, dialogState, 'recovery-required',
        `${payload.message || 'Auto Rename could not fully restore the project files.'} ${RECOVERY_GUIDANCE}`);
      refreshOnce(document, operation);
      renderOperation(document, operation);
      focusClose();
      return;
    }
    if ((payload?.status === 'error' && NOTHING_RENAMED_OUTCOMES.has(payload.outcome))
      || (payload?.status === 'error' && PRE_ROUTE_REFUSALS.has(response?.status))) {
      retire(payload.outcome === 'restored' ? 'restored' : 'refused');
      setDialogMessage(dialog, `${payload.message || 'Auto Rename was not applied.'} ${REVIEW_AGAIN}`);
      focusClose();
      return;
    }
    // Anything else (an unreadable answer, an unexpected error) leaves the
    // outcome unknown.
    unconfirmed();
  };

  const previousSuccess = dialogState.onSuccessfulSubmit;
  dialogState.onSuccessfulSubmit = (payload) => {
    previousSuccess?.(payload);
    if (payload?.outcome !== 'committed' || String(payload.projectId) !== String(review.projectId)
      || payload.attemptId !== review.attemptId) {
      unconfirmed();
      return true;
    }
    committed(payload.message || 'Auto Rename was applied.');
    return true;
  };

  const previousOnClose = dialogState.onClose;
  dialogState.onClose = (...args) => {
    const result = previousOnClose?.(...args);
    removeStatusRetry(dialogState, CHECK_KEY);
    // Dismissing the review leaves its operation, and its notice, in place.
    const operation = pendingAutoRenameOperation(document, review.projectId);
    if (operation?.view?.state === dialogState) operation.view = null;
    // The review ends with its dialog: a later Auto Rename always previews again.
    windowObject.setTimeout(() => {
      if (!dialog.open && dialog.parentNode) dialog.remove();
      const focused = document.activeElement;
      if (!focused || focused === document.body) previewSubmitControl(document)?.focus?.({ preventScroll: true });
    }, 0);
    return result;
  };
}

function refusePreview(document, form, message) {
  announce(form, message);
  showPageFeedback(document, message, 'error');
}

function mountReview(document, mount, payload, opener) {
  const windowObject = liveRegionWindow(document);
  const parsed = new windowObject.DOMParser().parseFromString(payload.dialogHtml, 'text/html');
  mount.replaceChildren(...Array.from(parsed.body.children).map((node) => document.importNode(node, true)));
  enhanceAppDialogs(document);
  const dialog = document.getElementById(AUTO_RENAME_DIALOG_ID);
  const state = dialog?.__creatorCrateAppDialogState;
  const form = state?.form;
  // The mounted form must hold exactly the reviewed token and Apply attempt
  // for this project.
  if (!form || form.getAttribute('data-dialog-async') !== 'true'
    || form.getAttribute('action') !== `/projects/${payload.projectId}/assets/auto-rename/apply`
    || form.querySelector('input[name="planToken"]')?.value !== payload.planToken
    || !ATTEMPT_PATTERN.test(String(payload.attemptId || ''))
    || form.querySelectorAll('input[name="attemptId"]').length !== 1
    || form.querySelector('input[name="attemptId"]')?.value !== payload.attemptId) {
    mount.replaceChildren();
    return false;
  }
  bindConfirmation(document, state, {
    projectId: payload.projectId,
    categoryId: payload.categoryId,
    canApply: payload.canApply === true,
    attemptId: payload.attemptId,
    items: Array.isArray(payload.items) ? payload.items : [],
  });
  openAppDialogById(document, AUTO_RENAME_DIALOG_ID, opener?.isConnected ? opener : previewSubmitControl(document));
  return true;
}

function handlePreviewSubmit(event) {
  const form = event.target;
  if (!form?.matches?.(PREVIEW_FORM_SELECTOR) || event.defaultPrevented) return;
  const document = form.ownerDocument;
  const windowObject = liveRegionWindow(document);
  const mount = document.querySelector(MOUNT_SELECTOR);
  if (!mount || typeof windowObject.fetch !== 'function' || typeof windowObject.FormData !== 'function'
    || typeof windowObject.URLSearchParams !== 'function' || typeof windowObject.DOMParser !== 'function') return;
  event.preventDefault();

  const current = document.getElementById(AUTO_RENAME_DIALOG_ID);
  if (current?.open || current?.__creatorCrateAppDialogState?.submitting) return;

  // Only the newest Preview may open; an older request is abandoned.
  const controller = controllerFor(document);
  controller.previewAbort?.abort?.();
  const generation = controller.previewGeneration + 1;
  controller.previewGeneration = generation;
  const abort = typeof windowObject.AbortController === 'function' ? new windowObject.AbortController() : null;
  controller.previewAbort = abort;

  const key = previewKey(form, windowObject);
  const body = new windowObject.URLSearchParams(new windowObject.FormData(form));
  const dialogOpens = appDialogOpenCount(document);
  const opener = event.submitter || null;
  const settle = () => {
    if (controller.previewAbort === abort) controller.previewAbort = null;
    form.removeAttribute('aria-busy');
  };
  // Opening now would show a review of what the page no longer shows: the
  // category, selection or order changed, or another dialog took over.
  const superseded = () => appDialogOpenCount(document) !== dialogOpens
    || Boolean(document.querySelector('dialog[open]'))
    || previewKey(document.querySelector(PREVIEW_FORM_SELECTOR), windowObject) !== key;

  form.setAttribute('aria-busy', 'true');
  announce(form, PREVIEW_PENDING_MESSAGE);
  windowObject.fetch(form.getAttribute('action'), {
    method: 'POST',
    body,
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    ...(abort ? { signal: abort.signal } : {}),
  }).then(async (response) => ({ response, payload: await readJson(response) }))
    .then(({ response, payload }) => {
      if (controller.previewGeneration !== generation) return;
      settle();
      if (superseded()) {
        announce(document.querySelector(PREVIEW_FORM_SELECTOR) || form, PREVIEW_STALE_MESSAGE);
        return;
      }
      if (!response.ok || payload.status !== 'success' || typeof payload.dialogHtml !== 'string'
        || `${payload.categoryId}` !== key.split('|')[0]
        || !mountReview(document, mount, payload, opener)) {
        refusePreview(document, form, payload.message || PREVIEW_FAILED_MESSAGE);
        return;
      }
      announce(form, '');
    }, () => {
      if (controller.previewGeneration !== generation) return;
      settle();
      refusePreview(document, form, PREVIEW_FAILED_MESSAGE);
    });
}

/**
 * Makes the page's Auto Rename Preview and Apply local. Bound once per
 * document, so a Project Assets refresh that replaces the Preview form needs
 * no rebinding. Returns whether the page can host the review.
 */
export function enhanceAutoRenameDialog(scope = globalThis.document) {
  const document = scope?.nodeType === 9 ? scope : scope?.ownerDocument;
  if (!document?.querySelector?.(MOUNT_SELECTOR)) return false;
  if (!isEnhancementBound(document, 'autoRenameDialogBound')) {
    markEnhancementBound(document, 'autoRenameDialogBound');
    // Bubbling, so the ordering controller's own submit validation has run.
    document.addEventListener('submit', handlePreviewSubmit);
    bindPendingCheck(document);
  }
  return true;
}
