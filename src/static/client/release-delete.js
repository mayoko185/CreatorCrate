import {
  appDialogFeedback,
  applyAppDialogDraft,
  closeAppDialogById,
  freezeAppDialog,
  readAppDialogValues,
} from './app-dialogs.js';
import { describeAppConfirmation } from './confirm-dialog.js';
import { isEnhancementBound, markEnhancementBound } from './dom.js';
import { enhanceReleaseArchive, releaseArchiveState, unsavedReleaseEditLabels } from './release-archive.js';
import { retireReleaseDetailRefresh } from './release-detail-refresh.js';
import {
  enhanceReleaseEditDialog,
  RELEASE_ARCHIVED_EVENT,
  RELEASE_DELETED_EVENT,
  RELEASE_EDIT_DIALOG_ID,
} from './release-edit-dialog.js';
import { removeStatusRetry, showStatusRetry } from './status-retry.js';

// WP11B-2: Delete release, from the Edit Release dialog on every host that
// renders it (Dashboard, Calendar, Release Detail), in place.
//
//  - The shared confirmation (confirm-dialog.js) opens over the open Edit
//    Release dialog, naming the release by its saved title, what Delete
//    removes, and any unsaved Edit Release changes. Delete never saves them.
//    Cancel, Escape and the backdrop send nothing.
//  - A save in flight (or a load) refuses Delete before the confirmation opens
//    (data-dialog-secondary-action); so does an Archive of the same release
//    that is pending, unconfirmed or settled here (release-archive.js), and a
//    Delete that is pending, unconfirmed or settled here. A pending Delete
//    freezes the dialog and keeps it open. While this page holds a Delete for
//    a release, its Save, Archive, Review & Publish, Posting Helper launch,
//    Dashboard scheduling (and Undo) are refused before they send anything.
//    One confirmed Delete sends one POST; nothing is ever sent again by itself.
//  - Refused or failed with nothing deleted: the dialog thaws with every
//    draft. A refusal because the release (or its project) is archived also
//    tells the hosts to re-read it (RELEASE_ARCHIVED_EVENT, unconfirmed).
//  - Deleted by this request: the dialog closes (the warned drafts go with
//    it) and RELEASE_DELETED_EVENT tells the host. The Dashboard and Calendar
//    re-read their own content with a GET. Release Detail of that release
//    cannot survive it: its refreshes stop, its content is retired (inert)
//    and the page goes once to the server's destination (Releases), with a
//    link there in case it does not.
//  - A lost or unreadable answer leaves the Delete unresolved: the request
//    may still be on its way and run later, so no read showing the release
//    present ends that. The drafts are kept (across dismissal and reopening),
//    the release's other mutations are refused, and Check again reads only
//    (GET /releases/:id/edit). A read finding the release gone settles that
//    it is gone, never that this request deleted it; Release Detail is then
//    retired without navigating by itself.
//  - Without fetch the form stays native (POST, then the server's redirect).
//
// The Edit Release dialog has no return location, so no return veto is
// registered here.
const DELETE_FORM_SELECTOR = 'form[data-release-delete-form]';
const STATE_KEY = '__creatorCrateReleaseDelete';
const DIALOG_RETRY_KEY = 'dialogCheckButton';
const FEEDBACK_RETRY_KEY = 'feedbackCheckButton';
const DELETE_HOLD_ATTRIBUTE = 'data-release-delete-hold';
const GUARD_BOUND_KEY = 'releaseDeleteGuardsBound';
// Set on <main> once Release Detail's own release is gone.
export const RELEASE_DELETED_HOST_ATTRIBUTE = 'data-release-deleted-host';
const DESTINATION_LINK_ATTRIBUTE = 'data-release-delete-destination';
const DEFAULT_DESTINATION = '/releases';
// Release mutations a held Delete refuses, by their form's action: Save
// (/releases/:id), Archive, Review & Publish and quick scheduling.
const RELEASE_MUTATION_ACTION = /^\/releases\/([1-9]\d*)(?:\/(publish|archive|schedule))?$/;
const RELEASE_COMPANION_URL = /^\/releases\/([1-9]\d*)\/social-prep\//;
const SCHEDULE_FORM_SELECTOR = '[data-dashboard-schedule-quick-form], [data-dashboard-schedule-custom-form]';
const SCHEDULE_UNDO_SELECTOR = '[data-dashboard-schedule-undo]';
const COMPANION_ACTION_SELECTOR = '[data-release-social-prep-companion-action]';
const COMPANION_CONTAINER_SELECTOR = '[data-release-social-prep-companion]';

export const RELEASE_DELETE_MESSAGES = Object.freeze({
  pending: 'The release is being deleted. Wait for the result.',
  notLoaded: 'Wait for the release to load, then try again.',
  saveBusy: 'Wait for the save to finish, then try again.',
  wrongTarget: 'This Delete form does not match the release shown. Close the dialog and open it again.',
  archivePending: 'The release is being archived. Wait for the result.',
  archiveHeld: 'The earlier Archive request for this release has not been confirmed, so it cannot be deleted from this page.',
  archived: 'This release is archived and read-only, so it cannot be deleted.',
  unresolved: 'The earlier Delete request has not been confirmed, so this release cannot be deleted again from this page.',
  deleted: 'This release was deleted.',
  missing: 'This release no longer exists.',
  saveHeld: 'Changes cannot be saved while the earlier Delete request is unconfirmed. Your unsaved changes are kept.',
  mutationHeld: 'This release cannot be changed while its Delete request is unconfirmed. Nothing was sent. Use Check again to read its current state.',
  deletedFallback: 'Release deleted.',
  refusedFallback: 'The release could not be deleted.',
  nothingDeleted: 'Nothing was deleted.',
  draftsKept: 'Your unsaved changes are kept.',
  draftsUnsaveable: 'Your unsaved changes are kept here, but this release can no longer be edited.',
  draftsGone: 'Your unsaved changes could not be saved, because the release no longer exists.',
  unconfirmed: 'Could not confirm whether the release was deleted.',
  checking: 'Checking…',
  stillPresent: 'The release still exists, but the earlier Delete request may still run. Nothing will be sent again by itself. Your unsaved changes are kept; Check again only reads the release.',
  checkFailed: 'The release could not be checked. Nothing will be sent again by itself. Your unsaved changes are kept.',
  observedMissing: 'This release no longer exists, but this page could not confirm whether that Delete request deleted it.',
  goneUnconfirmed: 'This release no longer exists, so it was not deleted by this page.',
  opening: 'Opening Releases…',
  goToReleases: 'Go to Releases',
});

function quoted(text) {
  return `“${text}”`;
}

function joinList(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function documentState(document) {
  document[STATE_KEY] ||= { records: new Map(), retired: null };
  return document[STATE_KEY];
}

// Only the server's own destination, and only the local Releases page.
function safeDestination(value) {
  return typeof value === 'string' && /^\/releases(?:[?#]|$)/.test(value) ? value : DEFAULT_DESTINATION;
}

/**
 * Per-release Delete state on this page: { phase, drafts, title, message }
 * where phase is 'pending' | 'unresolved' | 'deleted' | 'missing', or null.
 * Exposed for hosts and tests; nothing outside this module writes it.
 */
export function releaseDeleteState(document, releaseId) {
  return document?.[STATE_KEY]?.records.get(String(releaseId)) || null;
}

/** Whether this page holds the release back from any further mutation because of a Delete. */
export function releaseDeleteHoldsRelease(document, releaseId) {
  return Boolean(releaseDeleteState(document, releaseId));
}

/** Whether this page is Release Detail of the release. */
export function pageShowsRelease(document, releaseId) {
  const shown = document?.querySelector?.('[data-release-detail]')?.getAttribute('data-release-detail');
  return Boolean(shown) && shown === String(releaseId);
}

/**
 * Retire Release Detail whose release is gone: its refreshes stop for good,
 * everything in its main content but the page feedback and the Edit Release
 * dialog becomes inert, and the feedback links to the destination. Navigates
 * there once when `navigate`. Returns false when the page was already retired.
 */
export function retireReleaseDetailPage(document, releaseId, { destination, navigate = false } = {}) {
  const state = documentState(document);
  if (state.retired) return false;
  const href = safeDestination(destination);
  state.retired = { releaseId: String(releaseId), href };
  retireReleaseDetailRefresh(document);
  const main = document.getElementById('main-content');
  if (main) {
    main.setAttribute(RELEASE_DELETED_HOST_ATTRIBUTE, String(releaseId));
    const keep = [...main.querySelectorAll('[data-dialog-feedback]'), document.getElementById(RELEASE_EDIT_DIALOG_ID)]
      .filter((element) => element && main.contains(element));
    const childElements = (element) => Array.from(element.children ?? element.childNodes ?? [])
      .filter((child) => typeof child.setAttribute === 'function');
    const targets = (element) => (keep.some((kept) => element.contains(kept))
      ? childElements(element).filter((child) => !keep.includes(child)).flatMap(targets)
      : [element]);
    childElements(main).filter((child) => !keep.includes(child)).flatMap(targets)
      .forEach((element) => element.setAttribute('inert', ''));
  }
  const feedback = document.querySelector('[data-dialog-feedback]');
  if (feedback && !feedback.querySelector(`[${DESTINATION_LINK_ATTRIBUTE}]`)) {
    const link = document.createElement('a');
    link.setAttribute('href', href);
    link.setAttribute(DESTINATION_LINK_ATTRIBUTE, '');
    link.className = 'button button-small button-secondary';
    link.textContent = RELEASE_DELETE_MESSAGES.goToReleases;
    feedback.appendChild(link);
  }
  main?.focus?.({ preventScroll: true });
  if (navigate) (document.defaultView || globalThis).location.assign(href);
  return true;
}

function heldMessage(record) {
  if (!record) return null;
  if (record.phase === 'pending') return RELEASE_DELETE_MESSAGES.pending;
  if (record.phase === 'unresolved') return RELEASE_DELETE_MESSAGES.mutationHeld;
  if (record.phase === 'deleted') return RELEASE_DELETE_MESSAGES.deleted;
  return RELEASE_DELETE_MESSAGES.missing;
}

// Appends a refusal to a status once, keeping any retry control last.
function appendRefusal(status, message, retry = null) {
  if (!status) return;
  const text = status.textContent || '';
  if (text.includes(message)) return;
  status.textContent = `${text.replace(retry?.textContent || '\u0000', '')} ${message}`.trim();
  if (retry) status.appendChild(retry);
}

function pathOf(document, value) {
  if (!value) return '';
  try { return new URL(value, document.baseURI).pathname; } catch { return value; }
}

// Save, Archive, Review & Publish, the Posting Helper launch and Dashboard
// scheduling (and its Undo) for a release this page holds a Delete for are
// refused before they send anything: their outcome would otherwise depend on
// a Delete request that may still run, or the release is gone. Captured on
// the document, ahead of every control's own listeners. The Delete form
// refuses through its own controller.
function installMutationGuards(document) {
  if (!document?.addEventListener || isEnhancementBound(document.documentElement, GUARD_BOUND_KEY)) return;
  markEnhancementBound(document.documentElement, GUARD_BOUND_KEY);
  const heldTarget = (element) => {
    const companion = element?.closest?.(COMPANION_ACTION_SELECTOR)
      ? element.closest(COMPANION_CONTAINER_SELECTOR) : null;
    let releaseId = null;
    if (companion) {
      const url = companion.getAttribute('data-activation-url') || companion.getAttribute('data-reissue-url');
      releaseId = RELEASE_COMPANION_URL.exec(pathOf(document, url))?.[1] || null;
    } else {
      // A footer submit names its form with form=, outside the form element.
      const form = element?.form || element?.closest?.('form');
      // The Delete form refuses through its own controller, and the Edit
      // Release form's Save through the dialog's own guard below (which says
      // the drafts are kept).
      if (form?.matches?.(DELETE_FORM_SELECTOR)) return null;
      if (form?.closest?.('dialog')?.id === RELEASE_EDIT_DIALOG_ID && form.matches?.('[data-dialog-form]')) return null;
      releaseId = form ? RELEASE_MUTATION_ACTION.exec(pathOf(document, form.getAttribute('action')))?.[1] || null : null;
      if (!releaseId && (element?.closest?.(SCHEDULE_UNDO_SELECTOR) || form?.matches?.(SCHEDULE_FORM_SELECTOR))) {
        releaseId = element.closest('[data-release-id]')?.getAttribute('data-release-id') || null;
      }
    }
    const record = releaseId ? releaseDeleteState(document, releaseId) : null;
    // A pending Delete freezes its own dialog; its Save is refused there.
    return record ? { record } : null;
  };
  const refuse = (event, element, held) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    const message = heldMessage(held.record);
    const dialog = element.closest?.('dialog');
    const dialogStatus = dialog?.querySelector?.('[data-dialog-status]');
    if (dialogStatus) {
      // A Check again already in the status stays there, last.
      appendRefusal(dialogStatus, message, dialogStatus.querySelector('button'));
      dialog.setAttribute('data-dialog-state', 'error');
    } else {
      appDialogFeedback(document, message, true);
    }
  };
  document.addEventListener('click', (event) => {
    const control = event.target?.closest?.('button, input[type="submit"]');
    if (!control) return;
    const isSubmit = control.type === 'submit' && control.form;
    if (!isSubmit && !control.matches(SCHEDULE_UNDO_SELECTOR) && !control.matches(COMPANION_ACTION_SELECTOR)) return;
    const held = heldTarget(control);
    if (held) refuse(event, control, held);
  }, true);
  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (!form?.matches?.('form') || form.matches(DELETE_FORM_SELECTOR)) return;
    const held = heldTarget(form);
    if (held) refuse(event, form, held);
  }, true);
}

function enhance(document, dialog, dialogState, controller) {
  const form = dialog.querySelector(DELETE_FORM_SELECTOR);
  const editForm = dialogState.form;
  if (!form || !editForm || isEnhancementBound(form, 'releaseDeleteBound')) return null;
  markEnhancementBound(form, 'releaseDeleteBound');
  const windowObject = document.defaultView || globalThis;
  const button = Array.from(form.querySelectorAll('button')).find((control) => control.hasAttribute('data-confirm'))
    || form.querySelector('button');
  const { records } = documentState(document);
  // focusMain: a confirmed Delete closed the dialog; its opener acts on a
  // release every host withdraws, so focus goes to the main content instead.
  const ui = { [DIALOG_RETRY_KEY]: null, [FEEDBACK_RETRY_KEY]: null, attempt: 0, focusMain: false };
  let unfreeze = null;

  const canSubmitInPlace = () => typeof windowObject.fetch === 'function'
    && typeof windowObject.FormData === 'function'
    && typeof windowObject.URLSearchParams === 'function';
  const currentId = () => (controller.releaseId ? String(controller.releaseId) : null);
  const recordFor = (releaseId) => (releaseId ? records.get(releaseId) || null : null);
  const savedTitle = () => String(dialogState.savedValues?.title ?? '').trim();

  function setStatus(message, tone = null) {
    removeStatusRetry(ui, DIALOG_RETRY_KEY);
    const status = dialog.querySelector('[data-dialog-status]');
    if (status) status.textContent = message || '';
    if (message && tone) dialog.setAttribute('data-dialog-state', tone);
    else dialog.removeAttribute('data-dialog-state');
  }

  function setFeedback(message, error) {
    removeStatusRetry(ui, FEEDBACK_RETRY_KEY);
    appDialogFeedback(document, message, error);
  }

  function holdButton(held) {
    if (!button) return;
    if (held) button.setAttribute('aria-disabled', 'true');
    else button.removeAttribute('aria-disabled');
    if (held) form.setAttribute(DELETE_HOLD_ATTRIBUTE, held);
    else form.removeAttribute(DELETE_HOLD_ATTRIBUTE);
  }

  // Check again in the dialog (while it is open for this release) and in the
  // page feedback (where the warning stays after the dialog is dismissed, and
  // which no sticky dialog footer can cover).
  function offerCheck(releaseId, { focusResult = false } = {}) {
    const onRetry = ({ wasFocused }) => check(releaseId, { focusResult: wasFocused });
    let focusTarget = null;
    if (dialog.open && currentId() === releaseId) {
      focusTarget = showStatusRetry({
        state: ui,
        status: dialog.querySelector('[data-dialog-status]'),
        attribute: 'data-release-delete-check',
        key: DIALOG_RETRY_KEY,
        label: 'Check again',
        onRetry,
      });
    }
    const feedback = document.querySelector('[data-dialog-feedback]');
    const feedbackRetry = feedback ? showStatusRetry({
      state: ui,
      status: feedback,
      attribute: 'data-release-delete-feedback-check',
      key: FEEDBACK_RETRY_KEY,
      label: 'Check again',
      onRetry,
    }) : null;
    if (focusResult) (focusTarget || feedbackRetry)?.focus?.({ preventScroll: true });
  }

  // Shown wherever the release's standing state is reported; never a success.
  function report(releaseId, message, tone, { feedback = true, focusResult = false, retry = false } = {}) {
    const record = recordFor(releaseId);
    if (record) record.message = message;
    if (dialog.open && currentId() === releaseId) setStatus(message, tone);
    if (feedback) setFeedback(message, true);
    if (retry) offerCheck(releaseId, { focusResult });
  }

  // The release is gone. Surviving hosts refresh from the event; Release
  // Detail of this release is retired here, and goes to Releases by itself
  // only after a deletion this request confirmed.
  function settleGone(releaseId, detail) {
    const showsRelease = pageShowsRelease(document, releaseId);
    if (showsRelease) {
      retireReleaseDetailPage(document, releaseId, {
        destination: detail.redirect,
        navigate: detail.outcome === 'deleted' && detail.confirmed === true,
      });
    }
    Promise.resolve().then(() => {
      document.dispatchEvent(new windowObject.CustomEvent(RELEASE_DELETED_EVENT, {
        detail: { releaseId, ...detail, hostRetired: showsRelease },
      }));
    });
  }

  // A refusal because the release (or its project) is archived now: the
  // hosts re-read it as an Archive this page did not make.
  function reportArchivedElsewhere(releaseId, message, projectArchived) {
    Promise.resolve().then(() => {
      document.dispatchEvent(new windowObject.CustomEvent(RELEASE_ARCHIVED_EVENT, {
        detail: {
          releaseId,
          projectId: null,
          release: null,
          message,
          outcome: projectArchived ? 'observed-project-archived' : 'observed-archived',
          confirmed: false,
        },
      }));
    });
  }

  function refusal() {
    const releaseId = currentId();
    const record = recordFor(releaseId);
    if (record?.phase === 'pending') return RELEASE_DELETE_MESSAGES.pending;
    if (!releaseId) return RELEASE_DELETE_MESSAGES.notLoaded;
    // The shared secondary-action guard and Archive's own guard refuse these
    // too; Delete never relies on them alone.
    const archive = releaseArchiveState(document, releaseId);
    if (archive?.phase === 'pending') return RELEASE_DELETE_MESSAGES.archivePending;
    if (dialogState.submitting) return RELEASE_DELETE_MESSAGES.saveBusy;
    if (archive?.phase === 'unresolved') return RELEASE_DELETE_MESSAGES.archiveHeld;
    if (archive?.phase === 'missing') return RELEASE_DELETE_MESSAGES.missing;
    if (archive) return RELEASE_DELETE_MESSAGES.archived;
    if (record?.phase === 'unresolved') return RELEASE_DELETE_MESSAGES.unresolved;
    if (record) return heldMessage(record);
    if (form.getAttribute('action') !== `/releases/${releaseId}/delete`) return RELEASE_DELETE_MESSAGES.wrongTarget;
    return null;
  }

  function noteRefusal(message) {
    appendRefusal(dialog.querySelector('[data-dialog-status]'), message, ui[DIALOG_RETRY_KEY]);
    dialog.setAttribute('data-dialog-state', 'error');
  }

  function thaw() {
    dialogState.submitting = false;
    editForm.removeAttribute('aria-busy');
    form.removeAttribute('aria-busy');
    const restore = unfreeze;
    unfreeze = null;
    restore?.();
  }

  function confirmation() {
    const title = savedTitle();
    const drafts = unsavedReleaseEditLabels(editForm, dialogState.savedValues);
    const base = `Delete ${title ? quoted(title) : 'this release'} permanently? This deletes the release record `
      + 'with its selected assets and their order, its platform choices, and its Posting Helper preparation, '
      + 'posting records and scheduled notifications in CreatorCrate, as they are when the deletion runs '
      + '(including changes made elsewhere since this page loaded). The project’s assets and files are not '
      + 'affected, and anything already posted on other sites is not removed. This cannot be undone.';
    if (drafts.length === 0) {
      return { title: 'Delete release?', message: base, confirmLabel: 'Delete release', cancelLabel: 'Cancel' };
    }
    return {
      title: 'Delete release with unsaved changes?',
      message: `${base} Your unsaved Edit Release changes (${joinList(drafts)}) will not be saved: they are kept if you cancel or the release is not deleted, and lost if it is deleted.`,
      confirmLabel: 'Delete release',
      cancelLabel: 'Keep editing',
    };
  }

  function classify(response, payload, releaseId) {
    const sameRelease = String(payload?.releaseId ?? payload?.release?.id ?? '') === releaseId;
    if (response?.ok && response.status === 200 && payload?.status === 'success' && payload.outcome === 'deleted'
      && sameRelease && payload.release?.deleted === true) return 'deleted';
    if (payload?.status === 'error' && response && !response.ok) {
      if (response.status === 404 && payload.code === 'RELEASE_NOT_FOUND' && payload.outcome === 'refused') return 'missing';
      if (response.status === 409 && payload.outcome === 'refused' && sameRelease
        && (payload.code === 'RELEASE_ARCHIVED' || payload.code === 'PROJECT_ARCHIVED')) return 'archived-refused';
      if (response.status === 500 && payload.outcome === 'failed' && payload.code === 'RELEASE_DELETE_FAILED') return 'failed';
      // Refused before the route ran (authentication, CSRF, maintenance) or by
      // the route itself; none names an outcome other than a refusal.
      if (((response.status >= 400 && response.status < 500) || response.status === 503)
        && response.status !== 404
        && (payload.outcome === undefined || payload.outcome === 'refused')) return 'refused';
    }
    // A lost answer, an unreadable body, an unknown 500: it may have deleted.
    return 'uncertain';
  }

  // An unresolved Delete settled by an authoritative read (Check again, or a
  // reopened dialog's load) that shows the release gone.
  function settleObservedMissing(releaseId, { focusResult = false } = {}) {
    const record = recordFor(releaseId);
    if (record?.phase !== 'unresolved') return false;
    record.phase = 'missing';
    if (currentId() === releaseId) holdButton('missing');
    report(releaseId, `${RELEASE_DELETE_MESSAGES.observedMissing} ${RELEASE_DELETE_MESSAGES.draftsGone}`, 'error', { focusResult });
    settleGone(releaseId, {
      projectId: null,
      title: record.title,
      message: RELEASE_DELETE_MESSAGES.observedMissing,
      outcome: 'observed-missing',
      confirmed: false,
    });
    return true;
  }

  // GET only: the edit model answers 404 RELEASE_NOT_FOUND once it is gone.
  function check(releaseId, { focusResult = false } = {}) {
    const record = recordFor(releaseId);
    if (record?.phase !== 'unresolved') return Promise.resolve();
    const attempt = record.attempt;
    record.checks = (record.checks || 0) + 1;
    const checkNumber = record.checks;
    report(releaseId, `${RELEASE_DELETE_MESSAGES.unconfirmed} ${RELEASE_DELETE_MESSAGES.checking}`, 'pending');
    return Promise.resolve()
      .then(() => windowObject.fetch(`/releases/${releaseId}/edit`, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'follow',
        headers: { Accept: 'application/json' },
      }))
      .then((response) => Promise.resolve()
        .then(() => (typeof response?.json === 'function' ? response.json() : null))
        .catch(() => null)
        .then((payload) => ({ response, payload })))
      .catch(() => ({ response: null, payload: null }))
      .then(({ response, payload }) => {
        const current = recordFor(releaseId);
        // A newer check, or the Delete's own answer, owns the record now.
        if (current !== record || current.attempt !== attempt || current.phase !== 'unresolved'
          || current.checks !== checkNumber) return;
        if (response?.status === 404 && payload?.code === 'RELEASE_NOT_FOUND') {
          settleObservedMissing(releaseId, { focusResult });
          return;
        }
        const present = (response?.ok && payload?.status === 'success' && String(payload.release?.id) === releaseId)
          || (response?.status === 409 && (payload?.code === 'RELEASE_ARCHIVED' || payload?.code === 'PROJECT_ARCHIVED'));
        if (present) {
          // An observation only: the lost request may not have run yet.
          report(releaseId, `${RELEASE_DELETE_MESSAGES.unconfirmed} ${RELEASE_DELETE_MESSAGES.stillPresent}`, 'error', {
            focusResult, retry: true,
          });
          return;
        }
        report(releaseId, `${RELEASE_DELETE_MESSAGES.unconfirmed} ${RELEASE_DELETE_MESSAGES.checkFailed}`, 'error', {
          focusResult, retry: true,
        });
      });
  }

  function submit() {
    const releaseId = currentId();
    const title = savedTitle();
    // Captured before the dialog freezes: the request holds exactly this form
    // (its release and token), and the drafts are kept as they are now.
    const action = form.getAttribute('action');
    const body = new windowObject.URLSearchParams(new windowObject.FormData(form));
    const record = {
      phase: 'pending',
      attempt: (ui.attempt += 1),
      title,
      drafts: readAppDialogValues(editForm),
      message: '',
    };
    records.set(releaseId, record);
    removeStatusRetry(ui, FEEDBACK_RETRY_KEY);
    dialogState.submitting = true;
    editForm.setAttribute('aria-busy', 'true');
    form.setAttribute('aria-busy', 'true');
    holdButton('pending');
    setStatus(`Deleting ${title ? quoted(title) : 'the release'}…`, 'pending');
    // The confirmation that replayed this submit may still hold the focus; the
    // freeze keeps it on this dialog instead.
    if (!dialog.contains(document.activeElement)) button?.focus?.({ preventScroll: true });
    unfreeze = freezeAppDialog(dialogState);

    Promise.resolve()
      .then(() => windowObject.fetch(action, {
        method: 'POST',
        body,
        credentials: 'same-origin',
        redirect: 'follow',
        headers: { Accept: 'application/json' },
      }))
      .then((response) => Promise.resolve()
        .then(() => (typeof response?.json === 'function' ? response.json() : null))
        .catch(() => null)
        .then((payload) => ({ response, payload })))
      .then(({ response, payload }) => ({ outcome: classify(response, payload, releaseId), payload }))
      .catch(() => ({ outcome: 'uncertain', payload: null }))
      .then(({ outcome, payload }) => {
        if (records.get(releaseId) !== record || record.phase !== 'pending') return;
        const message = typeof payload?.message === 'string' && payload.message ? payload.message : '';
        thaw();

        if (outcome === 'deleted') {
          record.phase = 'deleted';
          record.drafts = null;
          holdButton('deleted');
          setStatus('');
          // The warned drafts go with the dialog: the release is gone.
          ui.focusMain = true;
          closeAppDialogById(document, RELEASE_EDIT_DIALOG_ID);
          // Closing a modal dialog puts focus back on its opener at once,
          // before its close event; a repeated Enter there would reopen it.
          document.getElementById('main-content')?.focus?.({ preventScroll: true });
          const text = message || RELEASE_DELETE_MESSAGES.deletedFallback;
          record.message = text;
          const willNavigate = pageShowsRelease(document, releaseId);
          setFeedback(willNavigate ? `${text} ${RELEASE_DELETE_MESSAGES.opening}` : text, false);
          settleGone(releaseId, {
            projectId: payload.projectId ?? payload.release?.projectId ?? null,
            title,
            message: text,
            outcome: 'deleted',
            confirmed: true,
            redirect: payload.redirect,
          });
          return;
        }
        if (outcome === 'missing') {
          record.phase = 'missing';
          holdButton('missing');
          const lead = message || RELEASE_DELETE_MESSAGES.goneUnconfirmed;
          report(releaseId, `${lead} ${RELEASE_DELETE_MESSAGES.draftsGone}`, 'error');
          settleGone(releaseId, {
            projectId: null, title, message: lead, outcome: 'missing', confirmed: false,
          });
          button?.focus?.({ preventScroll: true });
          return;
        }
        if (outcome === 'archived-refused') {
          records.delete(releaseId);
          holdButton(null);
          const lead = message || RELEASE_DELETE_MESSAGES.archived;
          setStatus(`${lead} ${RELEASE_DELETE_MESSAGES.draftsUnsaveable}`, 'error');
          reportArchivedElsewhere(releaseId, lead, payload.code === 'PROJECT_ARCHIVED');
          button?.focus?.({ preventScroll: true });
          return;
        }
        if (outcome === 'refused' || outcome === 'failed') {
          records.delete(releaseId);
          holdButton(null);
          const nothing = !/nothing was deleted/i.test(message) ? ` ${RELEASE_DELETE_MESSAGES.nothingDeleted}` : '';
          setStatus(`${message || RELEASE_DELETE_MESSAGES.refusedFallback}${nothing} ${RELEASE_DELETE_MESSAGES.draftsKept}`, 'error');
          button?.focus?.({ preventScroll: true });
          return;
        }
        record.phase = 'unresolved';
        holdButton('unresolved');
        void check(releaseId);
      });
  }

  // Captured on the form, ahead of the confirmation control's own listener: a
  // Delete that cannot run now never opens the confirmation.
  form.addEventListener('click', (event) => {
    if (!canSubmitInPlace()) return;
    const control = event.target?.closest?.('button');
    if (!control || !form.contains(control)) return;
    const message = refusal();
    if (!message) return;
    event.preventDefault();
    event.stopImmediatePropagation?.();
    event.stopPropagation?.();
    noteRefusal(message);
  }, true);

  if (button) describeAppConfirmation(button, confirmation);

  // Only the confirmed replay reaches here (the confirmation submit gate
  // stops any other submit of this form first).
  form.addEventListener('submit', (event) => {
    if (event.defaultPrevented || !canSubmitInPlace()) return;
    event.preventDefault();
    const refused = refusal();
    if (refused) {
      noteRefusal(refused);
      return;
    }
    submit();
  });

  // Save is refused for a release whose Delete is unresolved or settled here.
  // The drafts stay as they are.
  dialog.addEventListener('submit', (event) => {
    if (event.target !== editForm) return;
    const record = recordFor(currentId());
    if (!record || record.phase === 'pending') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    noteRefusal(record.phase === 'unresolved' ? RELEASE_DELETE_MESSAGES.saveHeld : heldMessage(record));
  }, true);

  // A pending Delete keeps the dialog open: its outcome decides what happens
  // to the drafts. A dismissal while it is unresolved keeps its drafts for the
  // next open: the form itself returns to the saved values, as every
  // dismissal does. Archive's own hook runs too.
  const previousBeforeClose = dialogState.beforeClose;
  dialogState.beforeClose = (context) => {
    const record = recordFor(currentId());
    if (record?.phase === 'pending') return false;
    const allowed = typeof previousBeforeClose === 'function' ? previousBeforeClose(context) : true;
    if (allowed === true && record?.drafts) record.drafts = readAppDialogValues(editForm);
    return allowed;
  };

  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    removeStatusRetry(ui, DIALOG_RETRY_KEY);
    // After a confirmed Delete focus goes to the main content at once, so a
    // repeated Enter cannot reopen the dialog for the deleted release before
    // the host refreshes.
    const focusMain = ui.focusMain;
    ui.focusMain = false;
    if (!focusMain) return;
    Promise.resolve().then(() => {
      document.getElementById('main-content')?.focus?.({ preventScroll: true });
    });
  });

  // Each load shows the loaded release's standing Delete state, with the
  // drafts it kept; any other release starts with Delete available. Archive's
  // own load hooks run first.
  const previousOnLoaded = controller.onLoaded;
  controller.onLoaded = (releaseIdValue) => {
    previousOnLoaded?.(releaseIdValue);
    const releaseId = String(releaseIdValue);
    const record = recordFor(releaseId);
    removeStatusRetry(ui, DIALOG_RETRY_KEY);
    if (!record) {
      holdButton(null);
      return;
    }
    holdButton(record.phase);
    if (record.drafts && record.phase !== 'pending') applyAppDialogDraft(document, RELEASE_EDIT_DIALOG_ID, record.drafts);
    if (record.message) setStatus(record.message, 'error');
    if (record.phase === 'unresolved') offerCheck(releaseId);
  };

  // A reopened dialog whose load finds the release gone is an authoritative
  // read like Check again.
  const previousOnLoadRefused = controller.onLoadRefused;
  controller.onLoadRefused = (releaseIdValue, status, payload) => {
    previousOnLoadRefused?.(releaseIdValue, status, payload);
    const releaseId = String(releaseIdValue);
    const record = recordFor(releaseId);
    if (!record) {
      holdButton(null);
      return;
    }
    holdButton(record.phase);
    if (status === 404 && payload?.code === 'RELEASE_NOT_FOUND') settleObservedMissing(releaseId);
  };

  return { check, refusal };
}

/**
 * Binds Delete in the page's async Edit Release dialog (after Archive, whose
 * holds it shares) and the page's guard against other mutations of a release
 * it holds. Returns { check(releaseId), refusal() } or null without one (the
 * native form then keeps its own confirmation, POST and redirect).
 */
export function enhanceReleaseDelete(scope = globalThis.document) {
  const document = scope?.nodeType === 9 ? scope : scope?.ownerDocument;
  const controller = enhanceReleaseEditDialog(document);
  const dialog = document?.getElementById?.(RELEASE_EDIT_DIALOG_ID);
  const dialogState = dialog?.__creatorCrateAppDialogState;
  if (!controller || !dialogState) return null;
  enhanceReleaseArchive(document);
  installMutationGuards(document);
  dialog.__creatorCrateReleaseDelete ||= enhance(document, dialog, dialogState, controller);
  return dialog.__creatorCrateReleaseDelete;
}
