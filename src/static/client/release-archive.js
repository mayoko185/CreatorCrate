import {
  appDialogFeedback,
  applyAppDialogDraft,
  closeAppDialogById,
  freezeAppDialog,
  readAppDialogValues,
} from './app-dialogs.js';
import { describeAppConfirmation } from './confirm-dialog.js';
import { isEnhancementBound, markEnhancementBound } from './dom.js';
import {
  enhanceReleaseEditDialog,
  RELEASE_ARCHIVED_EVENT,
  RELEASE_EDIT_DIALOG_ID,
} from './release-edit-dialog.js';
import { removeStatusRetry, showStatusRetry } from './status-retry.js';

// WP11B-1: Archive release, from the Edit Release dialog on every host that
// renders it (Dashboard, Calendar, Release Detail), in place.
//
//  - The shared confirmation (confirm-dialog.js) opens over the open Edit
//    Release dialog, naming the release by its saved title and any unsaved
//    Edit Release changes. Archive never saves them. Cancel, Escape and the
//    backdrop send nothing.
//  - A save in flight (or a load) refuses Archive before the confirmation
//    opens (data-dialog-secondary-action), and a pending Archive freezes the
//    dialog and keeps it open, so Save and Archive never overlap. One
//    confirmed Archive sends one POST; nothing is ever sent again by itself.
//  - Refused or failed before archiving: the dialog thaws with every draft.
//  - Archived by this request: the dialog closes (the warned drafts go with
//    it) and the host re-reads its content with a GET (RELEASE_ARCHIVED_EVENT).
//  - A lost or unreadable answer leaves the Archive unresolved: the request
//    may still be on its way and run later, so no read showing the release
//    active ends that. Archive, Save, Review & Publish, Dashboard scheduling
//    and Delete stay refused for the release on this page, the drafts are kept
//    (across dismissal and reopening too), and Check again reads only
//    (GET /releases/:id/edit). A read showing it archived (or its project
//    archived) settles it, since a later Archive can then change nothing; the
//    page still says it could not tell which request did.
//  - Without fetch the form stays native (POST, then the server's redirect).
//
// The Edit Release dialog has no return location (Release Detail's ?edit=1
// deep link opens it in place), so a dismissal never leaves the page and no
// return veto is registered here.
const ARCHIVE_FORM_SELECTOR = 'form[data-release-archive-form]';
const STATE_KEY = '__creatorCrateReleaseArchive';
const DIALOG_RETRY_KEY = 'dialogCheckButton';
const FEEDBACK_RETRY_KEY = 'feedbackCheckButton';
const ARCHIVE_HOLD_ATTRIBUTE = 'data-release-archive-hold';
const GUARD_BOUND_KEY = 'releaseArchiveGuardsBound';
// Other release mutations a held Archive refuses, by their form's action.
const RELEASE_MUTATION_ACTION = /^\/releases\/([1-9]\d*)\/(publish|delete|schedule)$/;
const SCHEDULE_FORM_SELECTOR = '[data-dashboard-schedule-quick-form], [data-dashboard-schedule-custom-form]';
const SCHEDULE_UNDO_SELECTOR = '[data-dashboard-schedule-undo]';

const FIELD_LABELS = Object.freeze([
  ['title', 'title'],
  ['description', 'description'],
  ['notes', 'notes'],
  ['plannedDate', 'scheduled date'],
  ['plannedTime', 'scheduled time'],
  ['publishedDate', 'published date'],
  ['patreonUrl', 'release link'],
  ['selectedPlatforms', 'platforms'],
]);

export const RELEASE_ARCHIVE_MESSAGES = Object.freeze({
  pending: 'The release is being archived. Wait for the result.',
  notLoaded: 'Wait for the release to load, then try again.',
  wrongTarget: 'This Archive form does not match the release shown. Close the dialog and open it again.',
  unresolved: 'The earlier Archive request has not been confirmed, so this release cannot be archived again from this page.',
  archived: 'This release is archived and read-only, so it cannot be archived, saved, published or deleted.',
  projectArchived: 'The parent project is archived, so this release is read-only.',
  missing: 'This release no longer exists.',
  saveHeld: 'Changes cannot be saved while the earlier Archive request is unconfirmed. Your unsaved changes are kept.',
  mutationHeld: 'This release cannot be changed while its Archive request is unconfirmed. Nothing was sent. Use Check again to read its current state.',
  archivedFallback: 'Release archived.',
  refusedFallback: 'The release could not be archived.',
  nothingArchived: 'Nothing was archived.',
  draftsKept: 'Your unsaved changes are kept.',
  draftsUnsaveable: 'Your unsaved changes are kept here, but this release can no longer be edited.',
  unconfirmed: 'Could not confirm whether the release was archived.',
  checking: 'Checking…',
  stillActive: 'The release still shows as active, but the earlier Archive request may still run. Nothing will be sent again by itself. Your unsaved changes are kept; Check again only reads the release.',
  checkFailed: 'The release could not be checked. Nothing will be sent again by itself. Your unsaved changes are kept.',
  observedArchived: 'The release is archived now, but this page could not confirm whether that Archive request archived it.',
  observedProjectArchived: 'The parent project is archived now, so this release is read-only. This page could not confirm whether that Archive request archived the release.',
  goneUnconfirmed: 'This release no longer exists, so it was not archived by this page.',
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
// was loaded with (and each confirmed save replaces). A field the form does
// not hold (no platform was ever chosen) counts as empty.
export function unsavedReleaseEditLabels(form, savedValues) {
  if (!form || !savedValues) return [];
  const current = readAppDialogValues(form);
  return FIELD_LABELS
    .filter(([name]) => Object.hasOwn(savedValues, name)
      && (Object.hasOwn(current, name) || name === 'selectedPlatforms')
      && !sameValue(current[name] ?? (name === 'selectedPlatforms' ? [] : ''), savedValues[name]))
    .map(([, label]) => label);
}

function documentState(document) {
  document[STATE_KEY] ||= { records: new Map() };
  return document[STATE_KEY];
}

/**
 * Per-release Archive state on this page: { phase, drafts, title, message }
 * where phase is 'pending' | 'unresolved' | 'archived' | 'project-archived'
 * | 'missing', or null. Exposed for hosts and tests; nothing outside this
 * module writes it.
 */
export function releaseArchiveState(document, releaseId) {
  return document?.[STATE_KEY]?.records.get(String(releaseId)) || null;
}

/**
 * Whether this page holds the release back from any further mutation because
 * of an Archive: one in flight, one whose outcome is unknown, or a release
 * known to be read-only now. Release Delete (WP11B-2) reads it too.
 */
export function releaseArchiveHoldsRelease(document, releaseId) {
  return Boolean(releaseArchiveState(document, releaseId));
}

// The phases whose hold lives only in this document.
const DOCUMENT_HELD_PHASES = new Set(['pending', 'unresolved']);

/** Whether this page holds an Archive (any release's) that leaving it would lose. */
export function releaseArchiveHoldsPage(document) {
  const records = document?.[STATE_KEY]?.records;
  return Boolean(records && [...records.values()].some((record) => DOCUMENT_HELD_PHASES.has(record.phase)));
}

function heldMessage(record) {
  if (!record) return null;
  if (record.phase === 'pending') return RELEASE_ARCHIVE_MESSAGES.pending;
  if (record.phase === 'unresolved') return RELEASE_ARCHIVE_MESSAGES.mutationHeld;
  if (record.phase === 'project-archived') return RELEASE_ARCHIVE_MESSAGES.projectArchived;
  if (record.phase === 'missing') return RELEASE_ARCHIVE_MESSAGES.missing;
  return RELEASE_ARCHIVE_MESSAGES.archived;
}

// Appends a refusal to a status once, keeping any retry control last.
function appendRefusal(status, message, retry = null) {
  if (!status) return;
  const text = status.textContent || '';
  if (text.includes(message)) return;
  status.textContent = `${text.replace(retry?.textContent || '\u0000', '')} ${message}`.trim();
  if (retry) status.appendChild(retry);
}

// Review & Publish, Dashboard scheduling (and its Undo) and Delete for a
// release this page holds are refused before they send anything: their
// outcome would otherwise depend on an Archive request that may still run.
// Captured on the document, ahead of every control's own listeners.
function installMutationGuards(document) {
  if (!document?.addEventListener || isEnhancementBound(document.documentElement, GUARD_BOUND_KEY)) return;
  markEnhancementBound(document.documentElement, GUARD_BOUND_KEY);
  const actionRelease = (form) => {
    const action = form?.getAttribute?.('action') || '';
    let path = action;
    try { path = new URL(action, document.baseURI).pathname; } catch {}
    return RELEASE_MUTATION_ACTION.exec(path)?.[1] || null;
  };
  const heldTarget = (element) => {
    // A footer submit names its form with form=, outside the form element.
    const form = element?.form || element?.closest?.('form');
    let releaseId = form ? actionRelease(form) : null;
    if (!releaseId && (element?.closest?.(SCHEDULE_UNDO_SELECTOR) || form?.matches?.(SCHEDULE_FORM_SELECTOR))) {
      releaseId = element.closest('[data-release-id]')?.getAttribute('data-release-id') || null;
    }
    const record = releaseId ? releaseArchiveState(document, releaseId) : null;
    return record ? { record } : null;
  };
  const refuse = (event, element, held) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    const message = heldMessage(held.record);
    const dialogStatus = element.closest?.('dialog')?.querySelector?.('[data-dialog-status]');
    if (dialogStatus) {
      appendRefusal(dialogStatus, message);
      element.closest('dialog').setAttribute('data-dialog-state', 'error');
    } else {
      appDialogFeedback(document, message, true);
    }
  };
  document.addEventListener('click', (event) => {
    const control = event.target?.closest?.('button, input[type="submit"]');
    if (!control) return;
    const isSubmit = control.type === 'submit' && control.form;
    if (!isSubmit && !control.matches(SCHEDULE_UNDO_SELECTOR)) return;
    // The Archive form refuses through its own controller.
    if (control.closest(ARCHIVE_FORM_SELECTOR)) return;
    const held = heldTarget(control);
    if (held) refuse(event, control, held);
  }, true);
  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (!form?.matches?.('form') || form.matches(ARCHIVE_FORM_SELECTOR)) return;
    const held = heldTarget(form);
    if (held) refuse(event, form, held);
  }, true);
}

function enhance(document, dialog, dialogState, controller) {
  const form = dialog.querySelector(ARCHIVE_FORM_SELECTOR);
  const editForm = dialogState.form;
  if (!form || !editForm || isEnhancementBound(form, 'releaseArchiveBound')) return null;
  markEnhancementBound(form, 'releaseArchiveBound');
  const windowObject = document.defaultView || globalThis;
  const button = Array.from(form.querySelectorAll('button')).find((control) => control.hasAttribute('data-confirm'))
    || form.querySelector('button');
  const { records } = documentState(document);
  // focusMain: a confirmed Archive closed the dialog; its opener acts on a
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
    if (held) form.setAttribute(ARCHIVE_HOLD_ATTRIBUTE, held);
    else form.removeAttribute(ARCHIVE_HOLD_ATTRIBUTE);
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
        attribute: 'data-release-archive-check',
        key: DIALOG_RETRY_KEY,
        label: 'Check again',
        onRetry,
      });
    }
    const feedback = document.querySelector('[data-dialog-feedback]');
    const feedbackRetry = feedback ? showStatusRetry({
      state: ui,
      status: feedback,
      attribute: 'data-release-archive-feedback-check',
      key: FEEDBACK_RETRY_KEY,
      label: 'Check again',
      onRetry,
    }) : null;
    if (focusResult) (focusTarget || feedbackRetry)?.focus?.({ preventScroll: true });
  }

  // Shown wherever the release's standing state is reported.
  function report(releaseId, message, tone, { feedback = true, focusResult = false, retry = false } = {}) {
    const record = recordFor(releaseId);
    if (record) record.message = message;
    if (dialog.open && currentId() === releaseId) setStatus(message, tone);
    // Never a success tone: report() only carries unproven or refused states.
    if (feedback) setFeedback(message, tone !== 'success');
    if (retry) offerCheck(releaseId, { focusResult });
  }

  function dispatchArchived(releaseId, detail) {
    Promise.resolve().then(() => {
      document.dispatchEvent(new windowObject.CustomEvent(RELEASE_ARCHIVED_EVENT, {
        detail: { releaseId, ...detail },
      }));
    });
  }

  function refusal() {
    const releaseId = currentId();
    const record = recordFor(releaseId);
    if (record?.phase === 'pending') return RELEASE_ARCHIVE_MESSAGES.pending;
    if (!releaseId) return RELEASE_ARCHIVE_MESSAGES.notLoaded;
    if (record?.phase === 'unresolved') return RELEASE_ARCHIVE_MESSAGES.unresolved;
    if (record) return heldMessage(record);
    if (form.getAttribute('action') !== `/releases/${releaseId}/archive`) return RELEASE_ARCHIVE_MESSAGES.wrongTarget;
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
    const base = `Archive ${title ? quoted(title) : 'this release'}? It keeps its details, selected assets and any publication record, but becomes archived and read-only: it can no longer be edited, published or deleted, and it leaves the Dashboard and Calendar. This cannot be undone.`;
    if (drafts.length === 0) return { title: 'Archive release?', message: base, confirmLabel: 'Archive release' };
    return {
      title: 'Archive release with unsaved changes?',
      message: `${base} Your unsaved Edit Release changes (${joinList(drafts)}) will not be saved: they are kept if you cancel or the release is not archived, and lost if it is archived.`,
      confirmLabel: 'Archive release',
      cancelLabel: 'Keep editing',
    };
  }

  function classify(response, payload, releaseId) {
    const sameRelease = String(payload?.releaseId ?? payload?.release?.id ?? '') === releaseId;
    if (response?.ok && payload?.status === 'success' && payload.outcome === 'archived'
      && sameRelease && payload.release?.archived === true) return 'archived';
    if (payload?.status === 'error' && response && !response.ok) {
      if (response.status === 409 && payload.code === 'RELEASE_ALREADY_ARCHIVED'
        && sameRelease && payload.release?.archived === true) return 'already-archived';
      if (response.status === 409 && payload.code === 'PROJECT_ARCHIVED' && sameRelease) return 'project-archived';
      if (response.status === 404 && payload.code === 'RELEASE_NOT_FOUND') return 'missing';
      if (response.status === 500 && payload.outcome === 'failed' && payload.code === 'RELEASE_ARCHIVE_FAILED') return 'failed';
      // Refused before the route ran (authentication, CSRF, maintenance) or by
      // the route itself; none names an outcome other than a refusal.
      if (((response.status >= 400 && response.status < 500) || response.status === 503)
        && (payload.outcome === undefined || payload.outcome === 'refused')) return 'refused';
    }
    // A lost answer, an unreadable body, an unknown 500: it may have archived.
    return 'uncertain';
  }

  // An unresolved Archive settled by an authoritative read (Check again, or a
  // reopened dialog's load) that shows nothing it could still change.
  function settleObserved(releaseId, kind, { focusResult = false } = {}) {
    const record = recordFor(releaseId);
    if (record?.phase !== 'unresolved') return false;
    if (kind === 'archived' || kind === 'project-archived') {
      record.phase = kind;
      if (currentId() === releaseId) holdButton(kind);
      const lead = kind === 'archived'
        ? RELEASE_ARCHIVE_MESSAGES.observedArchived : RELEASE_ARCHIVE_MESSAGES.observedProjectArchived;
      report(releaseId, `${lead} ${RELEASE_ARCHIVE_MESSAGES.draftsUnsaveable}`, 'error', { focusResult });
      dispatchArchived(releaseId, {
        projectId: null, release: null, message: lead, outcome: `observed-${kind}`, confirmed: false,
      });
      return true;
    }
    if (kind === 'missing') {
      record.phase = 'missing';
      if (currentId() === releaseId) holdButton('missing');
      report(releaseId, RELEASE_ARCHIVE_MESSAGES.goneUnconfirmed, 'error', { focusResult });
      dispatchArchived(releaseId, {
        projectId: null, release: null, message: RELEASE_ARCHIVE_MESSAGES.goneUnconfirmed, outcome: 'missing', confirmed: false,
      });
      return true;
    }
    return false;
  }

  function observedKind(response, payload) {
    if (response?.status === 409 && payload?.code === 'RELEASE_ARCHIVED') return 'archived';
    if (response?.status === 409 && payload?.code === 'PROJECT_ARCHIVED') return 'project-archived';
    if (response?.status === 404 && payload?.code === 'RELEASE_NOT_FOUND') return 'missing';
    return null;
  }

  // GET only: the edit model answers 409 RELEASE_ARCHIVED once archived.
  function check(releaseId, { focusResult = false } = {}) {
    const record = recordFor(releaseId);
    if (record?.phase !== 'unresolved') return Promise.resolve();
    const attempt = record.attempt;
    report(releaseId, `${RELEASE_ARCHIVE_MESSAGES.unconfirmed} ${RELEASE_ARCHIVE_MESSAGES.checking}`, 'pending');
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
        if (current !== record || current.attempt !== attempt || current.phase !== 'unresolved') return;
        if (settleObserved(releaseId, observedKind(response, payload), { focusResult })) return;
        if (response?.ok && payload?.status === 'success' && String(payload.release?.id) === releaseId) {
          // An observation only: the lost request may not have run yet.
          report(releaseId, `${RELEASE_ARCHIVE_MESSAGES.unconfirmed} ${RELEASE_ARCHIVE_MESSAGES.stillActive}`, 'error', {
            focusResult, retry: true,
          });
          return;
        }
        report(releaseId, `${RELEASE_ARCHIVE_MESSAGES.unconfirmed} ${RELEASE_ARCHIVE_MESSAGES.checkFailed}`, 'error', {
          focusResult, retry: true,
        });
      });
  }

  function submit() {
    const releaseId = currentId();
    const title = savedTitle();
    // Captured before the dialog freezes: the request holds exactly this form,
    // and the drafts are kept as they are now.
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
    holdButton('pending');
    dialogState.submitting = true;
    editForm.setAttribute('aria-busy', 'true');
    form.setAttribute('aria-busy', 'true');
    setStatus(`Archiving ${title ? quoted(title) : 'the release'}…`, 'pending');
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

        if (outcome === 'archived') {
          record.phase = 'archived';
          record.drafts = null;
          holdButton('archived');
          setStatus('');
          // The warned drafts go with the dialog; its baseline is the saved release.
          ui.focusMain = true;
          closeAppDialogById(document, RELEASE_EDIT_DIALOG_ID);
          // Closing a modal dialog puts focus back on its opener at once,
          // before its close event; a repeated Enter there would reopen it.
          document.getElementById('main-content')?.focus?.({ preventScroll: true });
          const text = message || RELEASE_ARCHIVE_MESSAGES.archivedFallback;
          record.message = text;
          setFeedback(text, false);
          dispatchArchived(releaseId, {
            projectId: payload.projectId ?? payload.release?.projectId ?? null,
            release: payload.release,
            message: text,
            outcome: 'archived',
            confirmed: true,
          });
          return;
        }
        if (outcome === 'already-archived' || outcome === 'project-archived' || outcome === 'missing') {
          record.phase = outcome === 'already-archived' ? 'archived' : outcome;
          holdButton(record.phase);
          const lead = message || heldMessage(record);
          report(releaseId, `${lead} ${RELEASE_ARCHIVE_MESSAGES.draftsUnsaveable}`, 'error');
          dispatchArchived(releaseId, {
            projectId: payload?.projectId ?? null,
            release: payload?.release ?? null,
            message: lead,
            outcome: record.phase === 'archived' ? 'already-archived' : outcome,
            confirmed: false,
          });
          button?.focus?.({ preventScroll: true });
          return;
        }
        if (outcome === 'refused' || outcome === 'failed') {
          records.delete(releaseId);
          holdButton(null);
          const nothing = !/nothing was archived/i.test(message) ? ` ${RELEASE_ARCHIVE_MESSAGES.nothingArchived}` : '';
          setStatus(`${message || RELEASE_ARCHIVE_MESSAGES.refusedFallback}${nothing} ${RELEASE_ARCHIVE_MESSAGES.draftsKept}`, 'error');
          button?.focus?.({ preventScroll: true });
          return;
        }
        record.phase = 'unresolved';
        holdButton('unresolved');
        void check(releaseId);
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

  // Save is refused for a release whose Archive is unresolved or settled
  // here: its outcome would depend on a request that may still run, or the
  // release is already read-only. The drafts stay as they are.
  dialog.addEventListener('submit', (event) => {
    if (event.target !== editForm) return;
    const record = recordFor(currentId());
    if (!record || record.phase === 'pending') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    noteRefusal(record.phase === 'unresolved' ? RELEASE_ARCHIVE_MESSAGES.saveHeld : heldMessage(record));
  }, true);

  // A pending Archive keeps the dialog open: its outcome decides what happens
  // to the drafts. A dismissal while it is unresolved (or settled without
  // this page's proof) keeps its drafts for the next open: the form itself
  // returns to the saved values, as every dismissal does.
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
    // Focus whose control a host removed (an archived release's Edit action)
    // goes to the page's main content, never to the document body; after a
    // confirmed Archive it goes there at once, so a repeated Enter cannot
    // reopen the dialog for the archived release before the host refreshes.
    const focusMain = ui.focusMain;
    ui.focusMain = false;
    Promise.resolve().then(() => {
      const active = document.activeElement;
      if (focusMain || !active || active === document.body) {
        document.getElementById('main-content')?.focus?.({ preventScroll: true });
      }
    });
  });

  // Each load shows the loaded release's standing Archive state, with the
  // drafts it kept; any other release starts with Archive available.
  controller.onLoaded = (releaseIdValue) => {
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

  // A reopened dialog whose load is refused because the release is archived
  // (or its project, or it is gone) is an authoritative read like Check again.
  controller.onLoadRefused = (releaseIdValue, status, payload) => {
    const releaseId = String(releaseIdValue);
    const record = recordFor(releaseId);
    if (!record) {
      holdButton(null);
      return;
    }
    holdButton(record.phase);
    settleObserved(releaseId, observedKind({ status }, payload));
  };

  return { check, refusal };
}

/**
 * Binds Archive in the page's async Edit Release dialog and the page's guard
 * against other mutations of a held release. Returns { check(releaseId),
 * refusal() } or null without one (the native form then keeps its own
 * confirmation, POST and redirect).
 */
export function enhanceReleaseArchive(scope = globalThis.document) {
  const document = scope?.nodeType === 9 ? scope : scope?.ownerDocument;
  const controller = enhanceReleaseEditDialog(document);
  const dialog = document?.getElementById?.(RELEASE_EDIT_DIALOG_ID);
  const dialogState = dialog?.__creatorCrateAppDialogState;
  if (!controller || !dialogState) return null;
  installMutationGuards(document);
  dialog.__creatorCrateReleaseArchive ||= enhance(document, dialog, dialogState, controller);
  return dialog.__creatorCrateReleaseArchive;
}
