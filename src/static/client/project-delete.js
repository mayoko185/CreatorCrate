import {
  appDialogFeedback,
  applyAppDialogDraft,
  closeAppDialogById,
  freezeAppDialog,
  readAppDialogValues,
  vetoAppDialogReturn,
} from './app-dialogs.js';
import { describeAppConfirmation } from './confirm-dialog.js';
import { isEnhancementBound, markEnhancementBound } from './dom.js';
import { enhanceProjectArchive, projectArchiveState, unsavedProjectEditLabels } from './project-archive.js';
import {
  enhanceProjectEditDialog,
  PROJECT_DELETED_EVENT,
  PROJECT_EDIT_DIALOG_ID,
} from './project-edit-dialog.js';
import { removeStatusRetry, showStatusRetry } from './status-retry.js';

// WP11A-2: Delete project, from the Edit Project dialog on any host
// (Dashboard, Projects, Project Detail, Project Assets), in place.
//
//  - The shared confirmation (confirm-dialog.js) opens over the open Edit
//    Project dialog, naming the project by its saved title, what Delete
//    removes, and any unsaved Edit Project changes. Delete never saves them.
//    Cancel, Escape and the backdrop send nothing.
//  - A save in flight or loading refuses Delete before the confirmation opens
//    (data-dialog-secondary-action); so does an Archive of the same project
//    that is pending or unconfirmed (project-archive.js), and a Delete that is
//    pending, unconfirmed or settled here. A pending Delete freezes the
//    dialog, and while this page holds a Delete for a project, its Save and
//    Archive are refused too. One confirmed Delete sends one POST; nothing is
//    ever sent again by itself.
//  - Refused or failed with nothing deleted: the dialog thaws with every draft.
//  - Deleted by this request: the dialog closes (the warned drafts go with
//    it) and PROJECT_DELETED_EVENT tells the host. The Dashboard and Projects
//    re-read their own content with a GET. The project's own pages (Project
//    Detail, Project Assets) cannot survive it: their content is retired
//    (inert) and, for a clean deletion only, the page goes once to the
//    server's destination (Projects); otherwise it says what is known and
//    links there.
//  - Deleted, but its folder could not be fully removed: as above, never
//    reported as clean, and the page stays to show the recovery warning.
//  - Not deleted, but its folder could not be put back (recovery required):
//    the drafts are kept, and Delete, Save and Archive stay refused for the
//    project on this page; a read cannot settle that, so none is offered.
//  - A lost or unreadable answer leaves the Delete unresolved: the request
//    may still be on its way and run later, so no read showing the project
//    present ends that. The drafts are kept (across dismissal and reopening),
//    Delete, Save and Archive are refused for it, and Check again reads only
//    (GET /projects/:id/edit). A read finding the project gone settles that
//    it is gone, never that this request deleted it or that its folder was
//    fully removed.
//  - Without fetch the form stays native (POST, then the server's redirect).
const DELETE_FORM_SELECTOR = 'form[data-project-delete-form]';
const ARCHIVE_FORM_SELECTOR = 'form[data-project-archive-form]';
const STATE_KEY = '__creatorCrateProjectDelete';
const DIALOG_RETRY_KEY = 'dialogCheckButton';
const FEEDBACK_RETRY_KEY = 'feedbackCheckButton';
const DELETE_HOLD_ATTRIBUTE = 'data-project-delete-hold';
// Set on <main> once the page's own project is gone (see retireProjectPage).
export const PROJECT_DELETED_HOST_ATTRIBUTE = 'data-project-deleted-host';
const DESTINATION_LINK_ATTRIBUTE = 'data-project-delete-destination';
const DEFAULT_DESTINATION = '/projects';

export const PROJECT_DELETE_MESSAGES = Object.freeze({
  pending: 'The project is being deleted. Wait for the result.',
  notLoaded: 'Wait for the project to load, then try again.',
  saveBusy: 'Wait for the save to finish, then try again.',
  wrongTarget: 'This Delete form does not match the project shown. Close the dialog and open it again.',
  archivePending: 'The project is being archived. Wait for the result.',
  archiveHeld: 'The earlier Archive request for this project has not been confirmed, so it cannot be deleted from this page.',
  unresolved: 'The earlier Delete request has not been confirmed, so this project cannot be deleted again from this page.',
  recoveryHeld: 'This project’s folder needs recovery, so it cannot be deleted again from this page.',
  deleted: 'This project was deleted.',
  missing: 'This project no longer exists.',
  saveHeld: 'Changes cannot be saved while the earlier Delete request is unconfirmed. Your unsaved changes are kept.',
  saveRecoveryHeld: 'Changes cannot be saved while this project’s folder needs recovery. Your unsaved changes are kept.',
  archiveRefused: 'This project cannot be archived while its Delete request is unconfirmed or needs recovery.',
  deletedFallback: 'Project deleted.',
  refusedFallback: 'The project could not be deleted.',
  nothingDeleted: 'Nothing was deleted.',
  draftsKept: 'Your unsaved changes are kept.',
  draftsUnsaveable: 'Your unsaved changes are kept here, but this project can no longer be saved.',
  unconfirmed: 'Could not confirm whether the project was deleted.',
  checking: 'Checking…',
  stillPresent: 'The project still exists, but the earlier Delete request may still run. Nothing will be sent again by itself. Your unsaved changes are kept; Check again only reads the project.',
  checkFailed: 'The project could not be checked. Nothing will be sent again by itself. Your unsaved changes are kept.',
  observedMissing: 'This project no longer exists, but this page could not confirm whether its Delete request removed it, or whether its folder was fully removed.',
  goneUnconfirmed: 'This project no longer exists, so it was not deleted by this page.',
  recoveryFallback: 'The project was not deleted, but its folder needs recovery. Nothing will be retried automatically.',
  cleanupFallback: 'The project was deleted, but its folder could not be fully removed and needs recovery. Nothing will be retried automatically.',
  opening: 'Opening Projects…',
  goToProjects: 'Go to Projects',
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

// Only the server's own destination, and only a local Projects path.
function safeDestination(value) {
  return typeof value === 'string' && /^\/projects(?:[?#]|$)/.test(value) ? value : DEFAULT_DESTINATION;
}

/**
 * Per-project Delete state on this page: { phase, drafts, title, message }
 * where phase is 'pending' | 'unresolved' | 'recovery' | 'deleted' |
 * 'missing', or null. Exposed for hosts and tests; nothing outside this
 * module writes it.
 */
export function projectDeleteState(document, projectId) {
  return document?.[STATE_KEY]?.records.get(String(projectId)) || null;
}

// The phases whose hold lives only in this document: an unconfirmed Delete
// may still run, and a folder needing recovery must not be edited over.
const DOCUMENT_HELD_PHASES = new Set(['pending', 'unresolved', 'recovery']);

/** Whether this page holds a Delete (any project's) that leaving it would lose. */
export function projectDeleteHoldsPage(document) {
  const records = document?.[STATE_KEY]?.records;
  return Boolean(records && [...records.values()].some((record) => DOCUMENT_HELD_PHASES.has(record.phase)));
}

/** Whether this page shows the project itself (Project Detail or one of its subpages). */
export function pageShowsProject(document, projectId) {
  const pathname = String((document?.defaultView || globalThis).location?.pathname || '');
  return new RegExp(`^/projects/${String(projectId).replace(/\D/g, '')}(?:/|$)`).test(pathname);
}

/**
 * Retire a page whose own project is gone: everything in its main content but
 * the page feedback and the Edit Project dialog becomes inert (and stays so:
 * a later answer to an earlier read only replaces regions inside it), and the
 * feedback links to the destination. Navigates there once when `navigate`.
 * Returns false when the page was already retired.
 */
export function retireProjectPage(document, projectId, { destination, navigate = false } = {}) {
  const state = documentState(document);
  const main = document.getElementById('main-content');
  const href = safeDestination(destination);
  if (state.retired) return false;
  state.retired = { projectId: String(projectId), href };
  if (main) {
    main.setAttribute(PROJECT_DELETED_HOST_ATTRIBUTE, String(projectId));
    const keep = [...main.querySelectorAll('[data-dialog-feedback]'), document.getElementById(PROJECT_EDIT_DIALOG_ID)]
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
    link.textContent = PROJECT_DELETE_MESSAGES.goToProjects;
    feedback.appendChild(link);
  }
  main?.focus?.({ preventScroll: true });
  if (navigate) (document.defaultView || globalThis).location.assign(href);
  return true;
}

function enhance(document, dialog, dialogState, controller) {
  const form = dialog.querySelector(DELETE_FORM_SELECTOR);
  const editForm = dialogState.form;
  if (!form || !editForm || isEnhancementBound(form, 'projectDeleteBound')) return null;
  markEnhancementBound(form, 'projectDeleteBound');
  const windowObject = document.defaultView || globalThis;
  const button = Array.from(form.querySelectorAll('button')).find((control) => control.hasAttribute('data-confirm'))
    || form.querySelector('button');
  const { records } = documentState(document);
  const ui = { [DIALOG_RETRY_KEY]: null, [FEEDBACK_RETRY_KEY]: null, attempt: 0 };
  let unfreeze = null;

  const canSubmitInPlace = () => typeof windowObject.fetch === 'function'
    && typeof windowObject.FormData === 'function'
    && typeof windowObject.URLSearchParams === 'function';
  const currentId = () => (controller.projectId ? String(controller.projectId) : null);
  const recordFor = (projectId) => (projectId ? records.get(projectId) || null : null);
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

  function offerCheck(projectId, { focusResult = false } = {}) {
    const onRetry = ({ wasFocused }) => check(projectId, { focusResult: wasFocused });
    let focusTarget = null;
    if (dialog.open && currentId() === projectId) {
      focusTarget = showStatusRetry({
        state: ui,
        status: dialog.querySelector('[data-dialog-status]'),
        attribute: 'data-project-delete-check',
        key: DIALOG_RETRY_KEY,
        label: 'Check again',
        onRetry,
      });
    }
    const feedback = document.querySelector('[data-dialog-feedback]');
    const feedbackRetry = feedback ? showStatusRetry({
      state: ui,
      status: feedback,
      attribute: 'data-project-delete-feedback-check',
      key: FEEDBACK_RETRY_KEY,
      label: 'Check again',
      onRetry,
    }) : null;
    if (focusResult) (focusTarget || feedbackRetry)?.focus?.({ preventScroll: true });
  }

  // Shown wherever the project's standing state is reported; never a success.
  function report(projectId, message, tone, { feedback = true, focusResult = false, retry = false } = {}) {
    const record = recordFor(projectId);
    if (record) record.message = message;
    if (dialog.open && currentId() === projectId) setStatus(message, tone);
    if (feedback) setFeedback(message, true);
    if (retry) offerCheck(projectId, { focusResult });
  }

  // A deep-linked dialog (Project Detail's ?edit=1&returnTo=) goes back to its
  // invoking page whenever it closes. Once the project is gone that page may be
  // its own Project Assets, and the retired page has one destination of its
  // own, so the return location is dropped there.
  function dropReturnLocation(projectId) {
    if (!pageShowsProject(document, projectId)) return;
    dialog.querySelectorAll('[data-dialog-return-location]').forEach((control) => control.remove());
  }

  // The project is gone. Surviving hosts refresh from the event; the
  // project's own page is retired here, and goes to Projects by itself only
  // after a clean deletion this request confirmed.
  function settleGone(projectId, detail) {
    const showsProject = pageShowsProject(document, projectId);
    if (showsProject) {
      dropReturnLocation(projectId);
      retireProjectPage(document, projectId, {
        destination: detail.redirect,
        navigate: detail.outcome === 'deleted' && detail.confirmed === true && detail.cleanupComplete === true,
      });
    }
    Promise.resolve().then(() => {
      document.dispatchEvent(new windowObject.CustomEvent(PROJECT_DELETED_EVENT, {
        detail: { projectId, ...detail, hostRetired: showsProject },
      }));
    });
  }

  function refusal() {
    const projectId = currentId();
    const record = recordFor(projectId);
    if (record?.phase === 'pending') return PROJECT_DELETE_MESSAGES.pending;
    if (!projectId) return PROJECT_DELETE_MESSAGES.notLoaded;
    // The shared secondary-action guard refuses this too; Delete never
    // relies on it alone.
    const archive = projectArchiveState(document, projectId);
    if (archive?.phase === 'pending') return PROJECT_DELETE_MESSAGES.archivePending;
    if (dialogState.submitting) return PROJECT_DELETE_MESSAGES.saveBusy;
    if (archive) return PROJECT_DELETE_MESSAGES.archiveHeld;
    if (record?.phase === 'unresolved') return PROJECT_DELETE_MESSAGES.unresolved;
    if (record?.phase === 'recovery') return PROJECT_DELETE_MESSAGES.recoveryHeld;
    if (record?.phase === 'deleted') return PROJECT_DELETE_MESSAGES.deleted;
    if (record?.phase === 'missing') return PROJECT_DELETE_MESSAGES.missing;
    if (form.getAttribute('action') !== `/projects/${projectId}/delete`) return PROJECT_DELETE_MESSAGES.wrongTarget;
    return null;
  }

  // What this page's Delete hold refuses for Save and Archive, or null.
  function heldFor(kind) {
    const record = recordFor(currentId());
    if (!record || record.phase === 'pending') return null;
    if (kind === 'archive') {
      return record.phase === 'unresolved' || record.phase === 'recovery'
        ? PROJECT_DELETE_MESSAGES.archiveRefused
        : (record.phase === 'deleted' ? PROJECT_DELETE_MESSAGES.deleted : PROJECT_DELETE_MESSAGES.missing);
    }
    if (record.phase === 'unresolved') return PROJECT_DELETE_MESSAGES.saveHeld;
    if (record.phase === 'recovery') return PROJECT_DELETE_MESSAGES.saveRecoveryHeld;
    return record.phase === 'deleted' ? PROJECT_DELETE_MESSAGES.deleted : PROJECT_DELETE_MESSAGES.missing;
  }

  function noteRefusal(message) {
    const status = dialog.querySelector('[data-dialog-status]');
    const text = status?.textContent || '';
    if (text.includes(message)) return;
    const retry = ui[DIALOG_RETRY_KEY];
    if (status) status.textContent = `${text.replace(retry?.textContent || '\u0000', '')} ${message}`.trim();
    if (retry && status) status.appendChild(retry);
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
    const drafts = unsavedProjectEditLabels(editForm, dialogState.savedValues);
    const base = `Delete ${title ? quoted(title) : 'this project'} permanently? This deletes the project, `
      + 'its releases, its assets and its project folder with every file in it, as they are when the deletion runs '
      + '(including anything added elsewhere since this page loaded). Linked notes are kept but no longer linked to it. '
      + 'This cannot be undone.';
    if (drafts.length === 0) {
      return { title: 'Delete project?', message: base, confirmLabel: 'Delete project', cancelLabel: 'Cancel' };
    }
    return {
      title: 'Delete project with unsaved changes?',
      message: `${base} Your unsaved Edit Project changes (${joinList(drafts)}) will not be saved: they are kept if you cancel or the project is not deleted, and lost if it is deleted.`,
      confirmLabel: 'Delete project',
      cancelLabel: 'Keep editing',
    };
  }

  function classify(response, payload, projectId) {
    const sameProject = String(payload?.projectId ?? payload?.project?.id ?? '') === projectId;
    if (response?.ok && response.status === 200 && payload?.status === 'success' && payload.outcome === 'deleted'
      && payload.cleanup === 'complete' && sameProject && payload.project?.deleted === true) return 'deleted';
    if (payload?.status === 'error' && response && !response.ok) {
      if (response.status === 500 && payload.outcome === 'deleted-cleanup-incomplete'
        && payload.code === 'PROJECT_DELETE_CLEANUP_INCOMPLETE' && sameProject
        && payload.project?.deleted === true) return 'cleanup-incomplete';
      if (response.status === 500 && payload.outcome === 'recovery-required'
        && payload.code === 'PROJECT_DELETE_RECOVERY_REQUIRED' && sameProject) return 'recovery';
      if (response.status === 404 && payload.code === 'PROJECT_NOT_FOUND' && payload.outcome === 'refused') return 'missing';
      if (response.status === 500 && payload.outcome === 'failed' && payload.code === 'PROJECT_DELETE_FAILED') return 'failed';
      // Refused before the route ran (authentication, CSRF, maintenance) or by
      // the route itself (ownership); none names an outcome other than a refusal.
      if (((response.status >= 400 && response.status < 500) || response.status === 503)
        && response.status !== 404
        && (payload.outcome === undefined || payload.outcome === 'refused')) return 'refused';
    }
    // A lost answer, an unreadable body, an unknown 500: it may have deleted.
    return 'uncertain';
  }

  // GET only: the edit model answers 404 PROJECT_NOT_FOUND once it is gone.
  function check(projectId, { focusResult = false } = {}) {
    const record = recordFor(projectId);
    if (record?.phase !== 'unresolved') return Promise.resolve();
    const attempt = record.attempt;
    record.checks = (record.checks || 0) + 1;
    const checkNumber = record.checks;
    report(projectId, `${PROJECT_DELETE_MESSAGES.unconfirmed} ${PROJECT_DELETE_MESSAGES.checking}`, 'pending');
    return Promise.resolve()
      .then(() => windowObject.fetch(`/projects/${projectId}/edit`, {
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
        const current = recordFor(projectId);
        // A newer check, or the Delete's own answer, owns the record now.
        if (current !== record || current.attempt !== attempt || current.phase !== 'unresolved'
          || current.checks !== checkNumber) return;
        if (response?.status === 404 && payload?.code === 'PROJECT_NOT_FOUND') {
          current.phase = 'missing';
          if (currentId() === projectId) holdButton('missing');
          report(projectId, `${PROJECT_DELETE_MESSAGES.observedMissing} ${PROJECT_DELETE_MESSAGES.draftsUnsaveable}`, 'error', { focusResult });
          settleGone(projectId, {
            title: current.title,
            message: PROJECT_DELETE_MESSAGES.observedMissing,
            outcome: 'observed-missing',
            confirmed: false,
            cleanupComplete: false,
          });
          return;
        }
        const present = (response?.ok && payload?.status === 'success' && String(payload.project?.id) === projectId)
          || (response?.status === 409 && payload?.code === 'PROJECT_ARCHIVED');
        if (present) {
          // An observation only: the lost request may not have run yet.
          report(projectId, `${PROJECT_DELETE_MESSAGES.unconfirmed} ${PROJECT_DELETE_MESSAGES.stillPresent}`, 'error', {
            focusResult, retry: true,
          });
          return;
        }
        report(projectId, `${PROJECT_DELETE_MESSAGES.unconfirmed} ${PROJECT_DELETE_MESSAGES.checkFailed}`, 'error', {
          focusResult, retry: true,
        });
      });
  }

  function submit() {
    const projectId = currentId();
    const title = savedTitle();
    // Captured before the dialog freezes: the request holds exactly this form
    // (its project and token), and the drafts are kept as they are now.
    const action = form.getAttribute('action');
    const body = new windowObject.URLSearchParams(new windowObject.FormData(form));
    const record = {
      phase: 'pending',
      attempt: (ui.attempt += 1),
      title,
      drafts: readAppDialogValues(editForm),
      message: '',
    };
    records.set(projectId, record);
    removeStatusRetry(ui, FEEDBACK_RETRY_KEY);
    dialogState.submitting = true;
    editForm.setAttribute('aria-busy', 'true');
    form.setAttribute('aria-busy', 'true');
    holdButton('pending');
    setStatus(`Deleting ${title ? quoted(title) : 'the project'}…`, 'pending');
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
      .then(({ response, payload }) => ({ outcome: classify(response, payload, projectId), payload }))
      .catch(() => ({ outcome: 'uncertain', payload: null }))
      .then(({ outcome, payload }) => {
        if (records.get(projectId) !== record || record.phase !== 'pending') return;
        const message = typeof payload?.message === 'string' && payload.message ? payload.message : '';
        thaw();

        if (outcome === 'deleted' || outcome === 'cleanup-incomplete') {
          const clean = outcome === 'deleted';
          record.phase = 'deleted';
          record.cleanupComplete = clean;
          record.drafts = null;
          holdButton('deleted');
          setStatus('');
          dropReturnLocation(projectId);
          // The warned drafts go with the dialog: the project is gone.
          closeAppDialogById(document, PROJECT_EDIT_DIALOG_ID);
          const text = message || (clean ? PROJECT_DELETE_MESSAGES.deletedFallback : PROJECT_DELETE_MESSAGES.cleanupFallback);
          record.message = text;
          const willNavigate = clean && pageShowsProject(document, projectId);
          setFeedback(willNavigate ? `${text} ${PROJECT_DELETE_MESSAGES.opening}` : text, !clean);
          settleGone(projectId, {
            title,
            message: text,
            outcome: clean ? 'deleted' : 'deleted-cleanup-incomplete',
            confirmed: true,
            cleanupComplete: clean,
            redirect: payload.redirect,
          });
          return;
        }
        if (outcome === 'missing') {
          record.phase = 'missing';
          holdButton('missing');
          const lead = message || PROJECT_DELETE_MESSAGES.goneUnconfirmed;
          report(projectId, `${lead} ${PROJECT_DELETE_MESSAGES.draftsUnsaveable}`, 'error');
          settleGone(projectId, {
            title, message: lead, outcome: 'missing', confirmed: false, cleanupComplete: false,
          });
          button?.focus?.({ preventScroll: true });
          return;
        }
        if (outcome === 'recovery') {
          record.phase = 'recovery';
          holdButton('recovery');
          report(projectId, `${message || PROJECT_DELETE_MESSAGES.recoveryFallback} ${PROJECT_DELETE_MESSAGES.draftsKept}`, 'error');
          button?.focus?.({ preventScroll: true });
          return;
        }
        if (outcome === 'refused' || outcome === 'failed') {
          records.delete(projectId);
          holdButton(null);
          const nothing = !/nothing was deleted/i.test(message) ? ` ${PROJECT_DELETE_MESSAGES.nothingDeleted}` : '';
          setStatus(`${message || PROJECT_DELETE_MESSAGES.refusedFallback}${nothing} ${PROJECT_DELETE_MESSAGES.draftsKept}`, 'error');
          button?.focus?.({ preventScroll: true });
          return;
        }
        record.phase = 'unresolved';
        holdButton('unresolved');
        void check(projectId);
      });
  }

  // Captured on the dialog, ahead of the Archive form's and the confirmation
  // controls' own listeners: a Save or Archive this page's Delete hold
  // refuses never opens a confirmation, and an Archive confirmed just before
  // the hold began is not sent. Delete's own refusal is checked here too.
  dialog.addEventListener('click', (event) => {
    if (!canSubmitInPlace()) return;
    const control = event.target?.closest?.('button');
    if (!control) return;
    let message = null;
    if (form.contains(control)) message = refusal();
    else if (control.closest(ARCHIVE_FORM_SELECTOR) && dialog.contains(control)) message = heldFor('archive');
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

  // Save and Archive are refused for a project whose Delete is unresolved,
  // needs recovery or settled here. The drafts stay as they are.
  dialog.addEventListener('submit', (event) => {
    const archive = event.target?.matches?.(ARCHIVE_FORM_SELECTOR);
    if (event.target !== editForm && !archive) return;
    const message = heldFor(archive ? 'archive' : 'save');
    if (!message) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    noteRefusal(message);
  }, true);

  // A dismissal while this project's Delete is held keeps its drafts for the
  // next open: the form itself returns to the saved values, as every
  // dismissal does.
  const previousBeforeClose = dialogState.beforeClose;
  dialogState.beforeClose = (context) => {
    const allowed = typeof previousBeforeClose === 'function' ? previousBeforeClose(context) : true;
    const record = recordFor(currentId());
    if (allowed === true && record && record.phase !== 'pending' && record.drafts) {
      record.drafts = readAppDialogValues(editForm);
    }
    return allowed;
  };

  // A deep-linked dialog (?edit=1&returnTo=) goes back to its invoking page
  // when dismissed. While a Delete is held here that would discard the hold,
  // the drafts and the recovery notice with this document (and returnTo may
  // name the project's own, possibly deleted, pages), so the dismissal stays
  // on the page instead. Read from the phase at each dismissal, never toggled;
  // Archive registers its own, and neither can lift the other's.
  vetoAppDialogReturn(document, PROJECT_EDIT_DIALOG_ID, () => projectDeleteHoldsPage(document));

  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    removeStatusRetry(ui, DIALOG_RETRY_KEY);
  });

  // Each load shows the loaded project's standing Delete state, with the
  // drafts it kept; any other project starts with Delete available. Archive's
  // own load hook runs first.
  const previousOnLoaded = controller.onLoaded;
  controller.onLoaded = (projectIdValue) => {
    previousOnLoaded?.(projectIdValue);
    const projectId = String(projectIdValue);
    const record = recordFor(projectId);
    removeStatusRetry(ui, DIALOG_RETRY_KEY);
    if (!record) {
      holdButton(null);
      return;
    }
    holdButton(record.phase);
    if (record.drafts && record.phase !== 'pending') applyAppDialogDraft(document, PROJECT_EDIT_DIALOG_ID, record.drafts);
    if (record.message) setStatus(record.message, 'error');
    if (record.phase === 'unresolved') offerCheck(projectId);
  };

  return { check, refusal };
}

/**
 * Binds Delete in the page's async Edit Project dialog (after Archive, whose
 * holds it shares). Returns { check(projectId), refusal() } or null without
 * one (the native form then keeps its own confirmation, POST and redirect).
 */
export function enhanceProjectDelete(scope = globalThis.document) {
  const document = scope?.nodeType === 9 ? scope : scope?.ownerDocument;
  const controller = enhanceProjectEditDialog(document);
  const dialog = document?.getElementById?.(PROJECT_EDIT_DIALOG_ID);
  const dialogState = dialog?.__creatorCrateAppDialogState;
  if (!controller || !dialogState) return null;
  enhanceProjectArchive(document);
  dialog.__creatorCrateProjectDelete ||= enhance(document, dialog, dialogState, controller);
  return dialog.__creatorCrateProjectDelete;
}
