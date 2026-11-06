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
import {
  enhanceProjectEditDialog,
  PROJECT_ARCHIVED_EVENT,
  PROJECT_EDIT_DIALOG_ID,
} from './project-edit-dialog.js';
import { removeStatusRetry, showStatusRetry } from './status-retry.js';

// WP11A-1: Archive project, from the Edit Project dialog on any host
// (Dashboard, Projects, Project Detail, Project Assets), in place.
//
//  - The shared confirmation (confirm-dialog.js) opens over the open Edit
//    Project dialog, naming the project by its saved title and any unsaved
//    Edit Project changes. Archive never saves them. Cancel, Escape and the
//    backdrop send nothing.
//  - A save in flight refuses Archive before the confirmation opens
//    (data-dialog-secondary-action), and a pending Archive freezes the dialog,
//    so Save and Archive never overlap. One confirmed Archive sends one POST;
//    nothing is ever sent again by itself.
//  - Refused or failed before archiving: the dialog thaws with every draft.
//  - Archived by this request: the dialog closes (the warned drafts go with
//    it) and the host re-reads its content with a GET (PROJECT_ARCHIVED_EVENT).
//  - A lost or unreadable answer leaves the Archive unresolved: the request
//    may still be on its way and run later, so no read showing the project
//    active ends that. Archive stays refused for the project on this page,
//    the drafts are kept (across dismissal and reopening too) and Save is
//    refused for it, and Check again reads only (GET /projects/:id/edit). A
//    read showing it archived settles it, since a later Archive can then
//    change nothing; the page still says it could not tell which request did.
//  - Without fetch the form stays native (POST, then the server's redirect).
const ARCHIVE_FORM_SELECTOR = 'form[data-project-archive-form]';
const STATE_KEY = '__creatorCrateProjectArchive';
const DIALOG_RETRY_KEY = 'dialogCheckButton';
const FEEDBACK_RETRY_KEY = 'feedbackCheckButton';
const ARCHIVE_HOLD_ATTRIBUTE = 'data-project-archive-hold';

const FIELD_LABELS = Object.freeze([
  ['title', 'title'],
  ['description', 'description'],
  ['notes', 'notes'],
  ['patreonUrl', 'project link'],
  ['status', 'status'],
  ['projectType', 'project type'],
  ['tagIds[]', 'tags'],
]);

export const PROJECT_ARCHIVE_MESSAGES = Object.freeze({
  pending: 'The project is being archived. Wait for the result.',
  notLoaded: 'Wait for the project to load, then try again.',
  wrongTarget: 'This Archive form does not match the project shown. Close the dialog and open it again.',
  unresolved: 'The earlier Archive request has not been confirmed, so this project cannot be archived again from this page.',
  archived: 'This project is archived and read-only, so it cannot be archived or saved again.',
  missing: 'This project no longer exists.',
  saveHeld: 'Changes cannot be saved while the earlier Archive request is unconfirmed. Your unsaved changes are kept.',
  archivedFallback: 'Project archived.',
  refusedFallback: 'The project could not be archived.',
  nothingArchived: 'Nothing was archived.',
  draftsKept: 'Your unsaved changes are kept.',
  draftsUnsaveable: 'Your unsaved changes are kept here, but this project can no longer be edited.',
  unconfirmed: 'Could not confirm whether the project was archived.',
  checking: 'Checking…',
  stillActive: 'The project still shows as active, but the earlier Archive request may still run. Nothing will be sent again by itself. Your unsaved changes are kept; Check again only reads the project.',
  checkFailed: 'The project could not be checked. Nothing will be sent again by itself. Your unsaved changes are kept.',
  observedArchived: 'The project is archived now, but this page could not confirm whether that Archive request archived it.',
  goneUnconfirmed: 'This project no longer exists, so it was not archived by this page.',
});

function quoted(text) {
  return `“${text}”`;
}

function joinList(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function sameValue(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) {
    const a = [...new Set((Array.isArray(left) ? left : [left]).map((v) => String(v ?? '')))].filter(Boolean).sort();
    const b = [...new Set((Array.isArray(right) ? right : [right]).map((v) => String(v ?? '')))].filter(Boolean).sort();
    return a.length === b.length && a.every((value, index) => value === b[index]);
  }
  return String(left ?? '') === String(right ?? '');
}

// The editable fields whose values differ from the saved baseline the form
// was loaded with (and each confirmed save replaces).
export function unsavedProjectEditLabels(form, savedValues) {
  if (!form || !savedValues) return [];
  const current = readAppDialogValues(form);
  return FIELD_LABELS
    .filter(([name]) => Object.hasOwn(current, name) && Object.hasOwn(savedValues, name)
      && !sameValue(current[name], savedValues[name]))
    .map(([, label]) => label);
}

function documentState(document) {
  document[STATE_KEY] ||= { records: new Map() };
  return document[STATE_KEY];
}

/**
 * Per-project Archive state on this page: { phase, drafts, title, message }
 * where phase is 'pending' | 'unresolved' | 'archived' | 'missing', or null.
 * Exposed for hosts and tests; nothing outside this module writes it.
 */
export function projectArchiveState(document, projectId) {
  return document?.[STATE_KEY]?.records.get(String(projectId)) || null;
}

// The phases whose hold lives only in this document: leaving it would drop
// the hold while the request may still run.
const DOCUMENT_HELD_PHASES = new Set(['pending', 'unresolved']);

/** Whether this page holds an Archive (any project's) that leaving it would lose. */
export function projectArchiveHoldsPage(document) {
  const records = document?.[STATE_KEY]?.records;
  return Boolean(records && [...records.values()].some((record) => DOCUMENT_HELD_PHASES.has(record.phase)));
}

function enhance(document, dialog, dialogState, controller) {
  const form = dialog.querySelector(ARCHIVE_FORM_SELECTOR);
  const editForm = dialogState.form;
  if (!form || !editForm || isEnhancementBound(form, 'projectArchiveBound')) return null;
  markEnhancementBound(form, 'projectArchiveBound');
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
    if (held) form.setAttribute(ARCHIVE_HOLD_ATTRIBUTE, held);
    else form.removeAttribute(ARCHIVE_HOLD_ATTRIBUTE);
  }

  // Check again in the dialog (while it is open for this project) and in the
  // page feedback (where the warning stays after the dialog is dismissed).
  function offerCheck(projectId, { focusResult = false } = {}) {
    const onRetry = ({ wasFocused }) => check(projectId, { focusResult: wasFocused });
    let focusTarget = null;
    if (dialog.open && currentId() === projectId) {
      focusTarget = showStatusRetry({
        state: ui,
        status: dialog.querySelector('[data-dialog-status]'),
        attribute: 'data-project-archive-check',
        key: DIALOG_RETRY_KEY,
        label: 'Check again',
        onRetry,
      });
    }
    const feedback = document.querySelector('[data-dialog-feedback]');
    const feedbackRetry = feedback ? showStatusRetry({
      state: ui,
      status: feedback,
      attribute: 'data-project-archive-feedback-check',
      key: FEEDBACK_RETRY_KEY,
      label: 'Check again',
      onRetry,
    }) : null;
    if (focusResult) (focusTarget || feedbackRetry)?.focus?.({ preventScroll: true });
  }

  // Shown wherever the project's standing state is reported.
  function report(projectId, message, tone, { feedback = true, focusResult = false, retry = false } = {}) {
    const record = recordFor(projectId);
    if (record) record.message = message;
    if (dialog.open && currentId() === projectId) setStatus(message, tone);
    // Never a success tone: report() only carries unproven or refused states.
    if (feedback) setFeedback(message, tone !== 'success');
    if (retry) offerCheck(projectId, { focusResult });
  }

  function dispatchArchived(projectId, detail) {
    Promise.resolve().then(() => {
      document.dispatchEvent(new windowObject.CustomEvent(PROJECT_ARCHIVED_EVENT, {
        detail: { projectId, ...detail },
      }));
    });
  }

  function refusal() {
    const projectId = currentId();
    const record = recordFor(projectId);
    if (record?.phase === 'pending') return PROJECT_ARCHIVE_MESSAGES.pending;
    if (!projectId) return PROJECT_ARCHIVE_MESSAGES.notLoaded;
    if (record?.phase === 'unresolved') return PROJECT_ARCHIVE_MESSAGES.unresolved;
    if (record?.phase === 'archived') return PROJECT_ARCHIVE_MESSAGES.archived;
    if (record?.phase === 'missing') return PROJECT_ARCHIVE_MESSAGES.missing;
    if (form.getAttribute('action') !== `/projects/${projectId}/archive`) return PROJECT_ARCHIVE_MESSAGES.wrongTarget;
    return null;
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
    const base = `Archive ${title ? quoted(title) : 'this project'}? It keeps its data, assets and releases, but becomes archived and read-only. This cannot be undone.`;
    if (drafts.length === 0) return { title: 'Archive project?', message: base, confirmLabel: 'Archive project' };
    return {
      title: 'Archive project with unsaved changes?',
      message: `${base} Your unsaved Edit Project changes (${joinList(drafts)}) will not be saved: they are kept if you cancel or the project is not archived, and lost if it is archived.`,
      confirmLabel: 'Archive project',
      cancelLabel: 'Keep editing',
    };
  }

  function classify(response, payload, projectId) {
    const sameProject = String(payload?.projectId ?? payload?.project?.id ?? '') === projectId;
    if (response?.ok && payload?.status === 'success' && payload.outcome === 'archived'
      && sameProject && payload.project?.archived === true) return 'archived';
    if (payload?.status === 'error' && response && !response.ok) {
      if (response.status === 409 && payload.code === 'PROJECT_ALREADY_ARCHIVED'
        && sameProject && payload.project?.archived === true) return 'already-archived';
      if (response.status === 404 && payload.code === 'PROJECT_NOT_FOUND') return 'missing';
      if (response.status === 500 && payload.outcome === 'failed' && payload.code === 'PROJECT_ARCHIVE_FAILED') return 'failed';
      // Refused before the route ran (authentication, CSRF, maintenance) or by
      // the route itself; none names an outcome other than a refusal.
      if (((response.status >= 400 && response.status < 500) || response.status === 503)
        && (payload.outcome === undefined || payload.outcome === 'refused')) return 'refused';
    }
    // A lost answer, an unreadable body, an unknown 500: it may have archived.
    return 'uncertain';
  }

  // GET only: the edit model answers 409 PROJECT_ARCHIVED once archived.
  function check(projectId, { focusResult = false } = {}) {
    const record = recordFor(projectId);
    if (record?.phase !== 'unresolved') return Promise.resolve();
    const attempt = record.attempt;
    report(projectId, `${PROJECT_ARCHIVE_MESSAGES.unconfirmed} ${PROJECT_ARCHIVE_MESSAGES.checking}`, 'pending');
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
        if (current !== record || current.attempt !== attempt || current.phase !== 'unresolved') return;
        if (response?.status === 409 && payload?.code === 'PROJECT_ARCHIVED') {
          current.phase = 'archived';
          if (currentId() === projectId) holdButton('archived');
          const message = `${PROJECT_ARCHIVE_MESSAGES.observedArchived} ${PROJECT_ARCHIVE_MESSAGES.draftsUnsaveable}`;
          report(projectId, message, 'error', { focusResult });
          dispatchArchived(projectId, {
            project: null, message: PROJECT_ARCHIVE_MESSAGES.observedArchived, outcome: 'observed-archived', confirmed: false,
          });
          return;
        }
        if (response?.status === 404 && payload?.code === 'PROJECT_NOT_FOUND') {
          current.phase = 'missing';
          if (currentId() === projectId) holdButton('missing');
          report(projectId, PROJECT_ARCHIVE_MESSAGES.goneUnconfirmed, 'error', { focusResult });
          dispatchArchived(projectId, {
            project: null, message: PROJECT_ARCHIVE_MESSAGES.goneUnconfirmed, outcome: 'missing', confirmed: false,
          });
          return;
        }
        if (response?.ok && payload?.status === 'success' && String(payload.project?.id) === projectId) {
          // An observation only: the lost request may not have run yet.
          report(projectId, `${PROJECT_ARCHIVE_MESSAGES.unconfirmed} ${PROJECT_ARCHIVE_MESSAGES.stillActive}`, 'error', {
            focusResult, retry: true,
          });
          return;
        }
        report(projectId, `${PROJECT_ARCHIVE_MESSAGES.unconfirmed} ${PROJECT_ARCHIVE_MESSAGES.checkFailed}`, 'error', {
          focusResult, retry: true,
        });
      });
  }

  function submit() {
    const projectId = currentId();
    const title = savedTitle();
    // Captured before the dialog freezes: the request holds exactly this form,
    // and the drafts are kept as they are now.
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
    setStatus(`Archiving ${title ? quoted(title) : 'the project'}…`, 'pending');
    // The confirmation that replayed this submit may still hold the focus; the
    // freeze keeps it on this dialog instead.
    if (!dialog.contains(document.activeElement)) button?.focus?.({ preventScroll: true });
    unfreeze = freezeAppDialog(dialogState);

    Promise.resolve()
      .then(() => windowObject.fetch(form.getAttribute('action'), {
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

        if (outcome === 'archived') {
          record.phase = 'archived';
          record.drafts = null;
          holdButton('archived');
          setStatus('');
          // The warned drafts go with the dialog; its baseline is the saved project.
          closeAppDialogById(document, PROJECT_EDIT_DIALOG_ID);
          const text = message || PROJECT_ARCHIVE_MESSAGES.archivedFallback;
          record.message = text;
          setFeedback(text, false);
          dispatchArchived(projectId, {
            project: payload.project, message: text, outcome: 'archived', confirmed: true,
          });
          return;
        }
        if (outcome === 'already-archived' || outcome === 'missing') {
          record.phase = outcome === 'missing' ? 'missing' : 'archived';
          holdButton(record.phase);
          const lead = message || (outcome === 'missing' ? PROJECT_ARCHIVE_MESSAGES.missing : PROJECT_ARCHIVE_MESSAGES.archived);
          report(projectId, `${lead} ${PROJECT_ARCHIVE_MESSAGES.draftsUnsaveable}`, 'error');
          dispatchArchived(projectId, {
            project: payload?.project ?? null, message: lead, outcome, confirmed: false,
          });
          button?.focus?.({ preventScroll: true });
          return;
        }
        if (outcome === 'refused' || outcome === 'failed') {
          records.delete(projectId);
          const nothing = outcome === 'refused' && !/nothing was archived/i.test(message)
            ? ` ${PROJECT_ARCHIVE_MESSAGES.nothingArchived}` : '';
          setStatus(`${message || PROJECT_ARCHIVE_MESSAGES.refusedFallback}${nothing} ${PROJECT_ARCHIVE_MESSAGES.draftsKept}`, 'error');
          button?.focus?.({ preventScroll: true });
          return;
        }
        record.phase = 'unresolved';
        holdButton('unresolved');
        void check(projectId);
      });
  }

  // Captured on the form, ahead of the confirmation control's own listener: an
  // Archive that cannot run now never opens the confirmation.
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

  // Save is refused for a project whose Archive is unresolved or settled
  // here: its outcome would depend on a request that may still run, or the
  // project is already read-only. The drafts stay as they are.
  dialog.addEventListener('submit', (event) => {
    if (event.target !== editForm) return;
    const record = recordFor(currentId());
    if (!record || record.phase === 'pending') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    noteRefusal(record.phase === 'unresolved' ? PROJECT_ARCHIVE_MESSAGES.saveHeld : (
      record.phase === 'missing' ? PROJECT_ARCHIVE_MESSAGES.missing : PROJECT_ARCHIVE_MESSAGES.archived));
  }, true);

  // A dismissal while this project's Archive is unresolved (or settled
  // without this page's proof) keeps its drafts for the next open: the form
  // itself returns to the saved values, as every dismissal does.
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
  // when dismissed. While an Archive is held here that would discard the hold,
  // the drafts and Check again with this document, so the dismissal stays on
  // the page instead. Read from the phase at each dismissal, never toggled.
  vetoAppDialogReturn(document, PROJECT_EDIT_DIALOG_ID, () => projectArchiveHoldsPage(document));

  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    removeStatusRetry(ui, DIALOG_RETRY_KEY);
    // Focus whose control a host removed (an archived project's Edit action)
    // goes to the page's main content, never to the document body.
    Promise.resolve().then(() => {
      const active = document.activeElement;
      if (!active || active === document.body) document.getElementById('main-content')?.focus?.({ preventScroll: true });
    });
  });

  // Each load shows the loaded project's standing Archive state, with the
  // drafts it kept; any other project starts with Archive available.
  controller.onLoaded = (projectIdValue) => {
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
 * Binds Archive in the page's async Edit Project dialog. Returns
 * { check(projectId), refusal() } or null without one (the native form then
 * keeps its own confirmation, POST and redirect).
 */
export function enhanceProjectArchive(scope = globalThis.document) {
  const document = scope?.nodeType === 9 ? scope : scope?.ownerDocument;
  const controller = enhanceProjectEditDialog(document);
  const dialog = document?.getElementById?.(PROJECT_EDIT_DIALOG_ID);
  const dialogState = dialog?.__creatorCrateAppDialogState;
  if (!controller || !dialogState) return null;
  dialog.__creatorCrateProjectArchive ||= enhance(document, dialog, dialogState, controller);
  return dialog.__creatorCrateProjectArchive;
}
