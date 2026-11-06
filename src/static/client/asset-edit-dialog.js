import { isEnhancementBound, markEnhancementBound } from './dom.js';
import { freezeAppDialog } from './app-dialogs.js';
import {
  initializeCreatorCrateDropdown,
  syncCreatorCrateDropdownFromNative,
  updateAssetViewerFilterDisclosureState,
} from './dropdowns.js';
import {
  ASSET_VIEWER_REFRESH_REGIONS,
  ASSET_VIEWER_REFRESH_STATUS,
  assetViewerFileState,
  assetViewerIdentity,
  assetViewerRefreshOwed,
  refreshAssetViewer,
  retireAssetViewer,
  supersedeAssetViewerRefresh,
} from './asset-viewer-refresh.js';
import { describeAppConfirmation } from './confirm-dialog.js';
import { removeStatusRetry, showStatusRetry } from './status-retry.js';

const TAG_FORM_SELECTOR = '#asset-tags-form';
const TAG_SAVE_FORM_SELECTOR = '[data-asset-tags-form]';
// The dialog's one live region, shared with the dialog's other actions.
const DIALOG_STATUS_SELECTOR = '[data-dialog-status]';
const TAG_INPUT_SELECTOR = 'input[type="checkbox"][name="tagIds[]"]';
const CONFIRMED_TAG_IDS_ATTRIBUTE = 'data-confirmed-tag-ids';
const TAG_SAVE_STATE_KEY = '__creatorCrateAssetTagSave';
const RETRY_KEY = 'retryButton';

const MESSAGES = Object.freeze({
  saving: 'Saving tags…',
  saved: 'Asset tags updated.',
  savedRefreshFailed: 'Asset tags updated, but the tags shown on this page could not refresh and may be out of date.',
  savedMissing: 'Asset tags updated, but this asset can no longer be read. It may have been deleted elsewhere.',
  refused: 'Could not save the asset tags. Your selection was kept and nothing was changed.',
  missing: 'This asset no longer exists in this project. It may have been deleted elsewhere. Nothing was saved.',
  wait: 'Wait for the tag save to finish, then try again.',
  checking: 'The tag save could not be confirmed. Checking the saved tags…',
  // WP10A1-F3: a lost or unreadable answer. The request may still reach the
  // server and replace the tags, so no read settles it (see `unresolved`).
  unconfirmed: 'The tag save could not be confirmed.',
  observedMatches: 'The tags saved now match the selection that was sent.',
  observedDiffers: 'The tags saved now differ from your selection, which is kept but not saved.',
  notProof: 'This is what is saved now; it does not show whether your request ran.',
  readFailed: 'The saved tags could not be read. Your selection is kept.',
  assetGone: 'This asset can no longer be read. It may have been deleted elsewhere.',
  unresolvedHeld: 'That request may still run, so this asset’s tags cannot be saved again, and the asset cannot be renamed, moved, deleted or set as a primary image from this page. Check again only reads the saved tags and sends nothing; reload the page once that request can no longer be running.',
  heldOther: 'This asset cannot be changed from this page while the earlier tag save is unconfirmed. Use Check again, or reload the page once that request can no longer be running.',
  notSaved: 'Your latest tag selection was not saved.',
  // The server refused a save reviewed against a saved set the asset no
  // longer has (TAG_SET_STALE): nothing changed; the selection is a draft.
  staleKept: 'Your selection is kept but not saved.',
  staleShown: 'The saved tags are shown now; review them, then use Save selection to save your selection.',
  staleMatches: 'The saved tags are shown now and already match your selection.',
  staleReadFailed: 'The saved tags could not be read, so the tags shown may be out of date.',
  staleAfterClose: 'The saved tags could not be read. The tags shown may be out of date.',
  waitOther: 'Wait for the primary image change to finish, then change the tags.',
});

// The server's refusal of a save whose reviewed saved set is out of date.
const TAG_SET_STALE_CODE = 'TAG_SET_STALE';
const TAG_REVIEW_SELECTOR = 'input[data-asset-tag-review]';
const TAG_REVIEW_PATTERN = /^t1\.[A-Za-z0-9_-]{43}$/;
const TAG_HOLD_ATTRIBUTE = 'data-asset-tags-hold';

function sameSet(left, right) {
  const a = new Set(left);
  const b = new Set(right);
  return a.size === b.size && [...a].every((value) => b.has(value));
}

function tagInputs(form) {
  return Array.from(form?.querySelectorAll?.(TAG_INPUT_SELECTOR) || []);
}

function currentSelection(form) {
  return tagInputs(form).filter((input) => input.checked).map((input) => String(input.value));
}

function confirmedSelection(form) {
  return String(form?.getAttribute?.(CONFIRMED_TAG_IDS_ATTRIBUTE) || '').split(',').filter(Boolean);
}

function applySelection(form, ids) {
  const selected = new Set(ids.map(String));
  tagInputs(form).forEach((input) => { input.checked = selected.has(String(input.value)); });
  const dropdown = form?.querySelector?.(TAG_FORM_SELECTOR);
  if (dropdown) initializeCreatorCrateDropdown(dropdown);
}

function tagStatusText(dialog) {
  const status = dialog?.querySelector?.(DIALOG_STATUS_SELECTOR);
  if (!status) return { status: null, text: null };
  let text = status.querySelector?.('[data-asset-tags-status-text]');
  if (!text) {
    text = status.ownerDocument.createElement('span');
    text.setAttribute('data-asset-tags-status-text', '');
    status.appendChild(text);
  }
  return { status, text };
}

/**
 * The Edit Asset tag form saves in place: each tag change sends the complete
 * selection once (Accept: application/json) while the Asset detail document,
 * its media host and the dialog stay mounted, and the dialog stays open.
 *
 * Saved values, the draft and requests are kept apart:
 *  - The confirmed baseline is the form's data-confirmed-tag-ids. It advances
 *    only to what a response acknowledged, or to what a GET of the page read.
 *  - The draft is the checked boxes. A response or a read changes them only
 *    when they hold no unsaved choice of the user's.
 *  - Every save carries the reviewed-state witness of the saved set the form
 *    showed (input[data-asset-tag-review], WP10A1-F3); the server refuses it
 *    (TAG_SET_STALE) when the saved set changed meanwhile, from any document.
 *    A refused selection stays as a draft; the saved set is read with a GET
 *    and saving it again is the user's explicit choice.
 *  - While a save is pending the dialog is frozen (the request already holds
 *    the selection captured before freezing); a later change is refused, never
 *    queued, so one submission is one POST.
 *  - A lost or unreadable response is never resubmitted. The saved tags are
 *    read with a GET and reported as what the server stores now, not as proof
 *    of what the lost request did.
 *  - Such a response leaves the save unresolved: the request may still be on
 *    its way to the service and replace the complete set, so no read releases
 *    it (this module's Check again, another action's read, a failed or
 *    superseded read, dismissal). Only that request's own answer could, and it
 *    was lost, so the hold lasts until the page is reloaded. While it holds,
 *    the coordinator refuses every Edit Asset action and dismissal keeps the
 *    drafts.
 */
function enhanceAssetTagSave(dialog, appDialogState, coordinator) {
  const form = dialog.querySelector(TAG_SAVE_FORM_SELECTOR);
  if (!form || isEnhancementBound(form, 'assetTagSaveBound')) return null;
  markEnhancementBound(form, 'assetTagSaveBound');

  const document = dialog.ownerDocument;
  const windowObject = document.defaultView || globalThis;
  const save = {
    pending: null,
    attempt: 0,
    // A confirmed save whose page regions have not been installed since.
    refreshOwed: false,
    // What a GET-only retry button would re-read for: 'saved', 'stale' or 'uncertain'.
    openRead: null,
    // The read this save still waits for ({ kind, submitted, message }) until
    // the Tags region is installed, by this module's GET or by another action's.
    owedRead: null,
    // { id, submitted }: a save whose answer was lost or unreadable. It may
    // still run on the server, so nothing but its own answer could release
    // it; no GET does. Ends only with the page.
    unresolved: null,
    tone: null,
    [RETRY_KEY]: null,
  };
  dialog[TAG_SAVE_STATE_KEY] = save;

  const canSaveInPlace = () => typeof windowObject.fetch === 'function'
    && typeof windowObject.FormData === 'function'
    && typeof windowObject.URLSearchParams === 'function';

  function setStatus(message, tone = null) {
    const { status, text } = tagStatusText(dialog);
    if (!status) return;
    text.textContent = message || '';
    save.tone = message ? tone : null;
    if (message && tone) status.setAttribute('data-asset-tags-state', tone);
    else status.removeAttribute('data-asset-tags-state');
  }

  function statusMessage() {
    return tagStatusText(dialog).text?.textContent || '';
  }

  function offerRetry(label, onRetry) {
    const { status } = tagStatusText(dialog);
    return showStatusRetry({
      state: save,
      status,
      attribute: 'data-asset-tags-retry',
      key: RETRY_KEY,
      label,
      onRetry,
    });
  }

  // GET only, for an unresolved save: what is saved now, never a resend.
  // Offered again after every read, so the one way to look stays reachable.
  function offerCheck(focusResult = false) {
    if (!save.unresolved) return null;
    const button = offerRetry('Check again', ({ wasFocused }) => {
      setStatus(MESSAGES.checking, 'pending');
      readAfterSave('uncertain', { submitted: save.unresolved.submitted, focusResult: wasFocused });
    });
    if (focusResult) button?.focus?.();
    return button;
  }

  // The checked boxes are a draft only when they differ from both the
  // selection that was sent and the baseline the user last saw.
  function syncControlsToSaved(savedIds, { submitted = null, previous }) {
    const selection = currentSelection(form);
    if ((submitted && sameSet(selection, submitted)) || sameSet(selection, previous)) {
      applySelection(form, savedIds);
    }
  }

  // A read while the save is unresolved: it reports what is saved now and
  // leaves the hold exactly as it was.
  function noteStanding(confirmedTagIds, { focusResult = false } = {}) {
    const matches = confirmedTagIds && sameSet(confirmedTagIds, save.unresolved.submitted);
    setStatus([
      MESSAGES.unconfirmed,
      matches ? MESSAGES.observedMatches : MESSAGES.observedDiffers,
      MESSAGES.notProof,
      MESSAGES.unresolvedHeld,
    ].join(' '), 'uncertain');
    offerCheck(focusResult);
  }

  function noteStandingFailed(missing, { focusResult = false } = {}) {
    setStatus(missing
      ? `${MESSAGES.unconfirmed} ${MESSAGES.assetGone}`
      : `${MESSAGES.unconfirmed} ${MESSAGES.readFailed} ${MESSAGES.unresolvedHeld}`, missing ? 'error' : 'uncertain');
    if (!missing) offerCheck(focusResult);
  }

  function adoptInstalled(kind, result, { submitted = null, message = '', focusResult = false } = {}) {
    save.refreshOwed = false;
    save.owedRead = null;
    save.openRead = null;
    removeStatusRetry(save, RETRY_KEY);
    if (result.confirmedTagIds) {
      syncControlsToSaved(result.confirmedTagIds, {
        submitted: kind === 'saved' ? submitted : null,
        previous: result.previousConfirmedTagIds,
      });
    }
    if (save.unresolved) {
      // Whatever this read was for, the lost save still holds.
      noteStanding(result.confirmedTagIds, { focusResult });
      return;
    }
    if (kind === 'saved') {
      setStatus(MESSAGES.saved, 'saved');
    } else if (kind === 'stale') {
      // The page and the reviewed state now show the saved set. Saving the kept
      // selection against it is a new, explicit request of the user's.
      if (sameSet(currentSelection(form), confirmedSelection(form))) {
        setStatus(`${message} ${MESSAGES.staleMatches}`.trim(), 'error');
      } else {
        setStatus(`${message} ${MESSAGES.staleShown}`.trim(), 'error');
        const button = offerRetry('Save selection', () => form.requestSubmit?.());
        if (focusResult) button?.focus?.();
      }
    }
    // kind 'quiet': a refused save's message stays as it is.
  }

  function readAfterSave(kind, { submitted = null, message = '', focusResult = false } = {}) {
    removeStatusRetry(save, RETRY_KEY);
    save.openRead = null;
    save.owedRead = { kind, submitted, message };
    const identity = assetViewerIdentity(document);
    return refreshAssetViewer(document, identity || {}).then((result) => {
      // A newer save or read owns the page now and reports for itself.
      if (result.status === ASSET_VIEWER_REFRESH_STATUS.SUPERSEDED || save.pending) return result;
      if (result.status === ASSET_VIEWER_REFRESH_STATUS.INSTALLED) {
        adoptInstalled(kind, result, { submitted, message, focusResult });
        coordinator.installed(result, api);
        return result;
      }
      coordinator.failed(result, api);
      if (result.status === ASSET_VIEWER_REFRESH_STATUS.MISSING) {
        if (save.unresolved) noteStandingFailed(true);
        else setStatus(kind === 'saved' ? MESSAGES.savedMissing : MESSAGES.missing, 'error');
        return result;
      }
      if (result.status === ASSET_VIEWER_REFRESH_STATUS.UNAVAILABLE) return result;
      // Failed: nothing installed. The GET (never the POST) can be repeated.
      save.openRead = kind;
      if (save.unresolved) {
        noteStandingFailed(false, { focusResult });
        return result;
      }
      if (kind === 'saved') {
        setStatus(MESSAGES.savedRefreshFailed, 'error');
      } else if (kind === 'stale') {
        setStatus(`${message} ${MESSAGES.staleReadFailed}`.trim(), 'error');
      } else {
        setStatus(`${statusMessage()} The tags shown on this page may be out of date.`.trim(), 'error');
      }
      const button = offerRetry('Retry refresh', ({ wasFocused }) => {
        setStatus('Refreshing the asset…', 'pending');
        readAfterSave(kind, { submitted, message, focusResult: wasFocused });
      });
      if (focusResult) button?.focus?.();
      return result;
    });
  }

  function classify(response, payload, identity) {
    if (response?.ok && payload?.status === 'success' && payload.outcome === 'committed'
      && Array.isArray(payload.tagIds)
      && identity
      && String(payload.projectId) === identity.projectId
      && String(payload.assetId) === identity.assetId) {
      return 'committed';
    }
    // A refusal is known only from the server's own answer: a JSON error that
    // was decided before the replacement ran (every 4xx the route, its CSRF
    // and its authentication send). Anything else may have committed.
    if (payload?.status === 'error' && response?.status >= 400 && response.status < 500
      && (payload.outcome === undefined || payload.outcome === 'refused')) {
      return response.status === 404 ? 'missing' : 'refused';
    }
    return 'uncertain';
  }

  // A save refused while the earlier one is unresolved: the selection stays
  // as the user left it (a draft, kept across dismissal), the standing
  // warning stays, and the refusal is added to it.
  function noteRefusedWhileHeld() {
    const base = statusMessage();
    setStatus(base.endsWith(MESSAGES.notSaved) ? base : `${base} ${MESSAGES.notSaved}`.trim(), save.tone || 'uncertain');
    if (!save[RETRY_KEY]) offerCheck(false);
  }

  form.addEventListener('submit', (event) => {
    if (!canSaveInPlace()) return;
    event.preventDefault();
    if (save.pending) {
      setStatus(MESSAGES.wait, 'pending');
      return;
    }
    // Refused, never queued: a second complete-set replacement could run
    // before or after the unresolved one.
    if (save.unresolved) {
      noteRefusedWhileHeld();
      return;
    }
    // Another action is in flight or held: this save is refused, never queued.
    if (coordinator.otherPending(api)) {
      const held = coordinator.holdMessage(api);
      // A standing hold elsewhere keeps the Edit Asset drafts (through
      // dismissal too), so this selection stays as an unsaved draft. Only a
      // POST in flight elsewhere (the dialog is frozen) puts it back.
      if (!held) applySelection(form, confirmedSelection(form));
      setStatus(held ? `${held} ${MESSAGES.notSaved}` : MESSAGES.waitOther, 'pending');
      return;
    }
    coordinator.yieldStatus(api);

    // Captured before the dialog freezes: the request holds exactly this,
    // including the reviewed-state witness of the saved set shown now.
    const submitted = currentSelection(form);
    const previous = confirmedSelection(form);
    const body = new windowObject.URLSearchParams(new windowObject.FormData(form));
    const identity = assetViewerIdentity(document);
    save.attempt += 1;
    const attempt = { id: save.attempt, submitted };
    save.pending = attempt;
    // Any read still out predates this save and must not install.
    supersedeAssetViewerRefresh(document);
    removeStatusRetry(save, RETRY_KEY);
    save.openRead = null;
    form.setAttribute('aria-busy', 'true');
    setStatus(MESSAGES.saving, 'pending');
    const unfreeze = freezeAppDialog(appDialogState);
    const settle = () => {
      save.pending = null;
      form.removeAttribute('aria-busy');
      unfreeze();
    };

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
      .then(({ response, payload }) => ({ outcome: classify(response, payload, identity), payload }))
      .catch(() => ({ outcome: 'uncertain', payload: null }))
      .then(({ outcome, payload }) => {
        // Only this request's own answer settles it. A lost or unreadable one
        // leaves it unresolved for the page's lifetime; held before the dialog
        // thaws, so nothing can send another replacement meanwhile.
        if (outcome === 'uncertain') {
          save.unresolved = attempt;
          form.setAttribute(TAG_HOLD_ATTRIBUTE, 'unresolved');
        }
        settle();
        if (outcome === 'committed') {
          const savedIds = payload.tagIds.map(String);
          form.setAttribute(CONFIRMED_TAG_IDS_ATTRIBUTE, savedIds.join(','));
          // The witness of the set this save stored, from its own transaction.
          // Without it the next save carries the old one and is refused as
          // stale (never applied) until the page is read again.
          const review = form.querySelector(TAG_REVIEW_SELECTOR);
          if (review && typeof payload.tagReview === 'string' && TAG_REVIEW_PATTERN.test(payload.tagReview)) {
            review.value = payload.tagReview;
          }
          syncControlsToSaved(savedIds, { submitted, previous });
          save.refreshOwed = true;
          setStatus(MESSAGES.saved, 'saved');
          return readAfterSave('saved', { submitted: savedIds });
        }
        if (outcome === 'missing') {
          setStatus(payload?.message ? `${payload.message} Nothing was saved.` : MESSAGES.missing, 'error');
          return null;
        }
        if (outcome === 'refused') {
          if (payload?.code === TAG_SET_STALE_CODE) {
            // Nothing changed; the selection stays as an unsaved draft. Read
            // the saved set (GET only, never a resend) so the baseline and the
            // reviewed state a new save carries show it as it is.
            const message = `${payload.message || MESSAGES.refused} ${MESSAGES.staleKept}`;
            setStatus(message, 'error');
            return readAfterSave('stale', { submitted, message });
          }
          setStatus(payload?.message ? `${payload.message} Your selection was kept.` : MESSAGES.refused, 'error');
          // An earlier save's page refresh may have been superseded by this one.
          return save.refreshOwed ? readAfterSave('quiet') : null;
        }
        setStatus(MESSAGES.checking, 'pending');
        return readAfterSave('uncertain', { submitted });
      });
  });

  // Each tag change saves the whole selection. The first change of a control
  // may already have been submitted by the shared data-autosubmit binding
  // (kept for the native fallback); a change matching the pending request is
  // that same submission and is not sent again.
  form.addEventListener('change', (event) => {
    if (!event.target?.matches?.(TAG_INPUT_SELECTOR) || !canSaveInPlace()) return;
    if (save.pending) {
      if (sameSet(currentSelection(form), save.pending.submitted)) return;
      applySelection(form, save.pending.submitted);
      setStatus(MESSAGES.wait, 'pending');
      return;
    }
    form.requestSubmit?.();
  });

  // Closing resets the checkboxes to the saved baseline (enhanceAssetEditDialog),
  // so no message about a kept selection survives it. An open GET obligation
  // does, and an unresolved save keeps its warning, its Check again and (through
  // keepsDrafts) the drafts.
  function reset() {
    if (save.pending || save.unresolved) return;
    if (save.openRead) {
      setStatus(MESSAGES.staleAfterClose, 'error');
      return;
    }
    removeStatusRetry(save, RETRY_KEY);
    setStatus('');
  }

  // The coordinator's view of this module (see enhanceAssetEditDialog).
  const api = {
    // In flight and unresolved both refuse the other actions.
    isPending: () => Boolean(save.pending || save.unresolved),
    // The drafts outlast a dismissal while the save is unresolved (nothing is
    // saved or sent; the saved baselines are untouched).
    keepsDrafts: () => Boolean(save.unresolved && !save.pending),
    // Why the other actions are refused, when it is not merely a POST in flight.
    holdMessage: () => (save.unresolved && !save.pending ? MESSAGES.heldOther : null),
    // Another action's GET installed the page (with or without the Tags region).
    adoptInstalled(result) {
      if (save.pending || !Object.hasOwn(result, 'confirmedTagIds')) return;
      if (save.owedRead) {
        adoptInstalled(save.owedRead.kind, result, save.owedRead);
        return;
      }
      if (save.unresolved) {
        removeStatusRetry(save, RETRY_KEY);
        noteStanding(result.confirmedTagIds);
      }
    },
    // Another action's GET, which also carried this save's owed Tags region, failed.
    noteFailed(result) {
      if (save.pending) return;
      if (save.unresolved) {
        const missing = result.status === ASSET_VIEWER_REFRESH_STATUS.MISSING;
        if (missing || result.status === ASSET_VIEWER_REFRESH_STATUS.FAILED) {
          if (save.owedRead) save.openRead = save.owedRead.kind;
          noteStandingFailed(missing);
        }
        return;
      }
      if (!save.owedRead || save.openRead) return;
      save.openRead = save.owedRead.kind;
      if (result.status === ASSET_VIEWER_REFRESH_STATUS.FAILED) {
        setStatus(`${statusMessage()} The tags shown on this page may be out of date.`.trim(), 'error');
      }
    },
    // Another action began: a settled message of this module gives way to it.
    yieldStatus() {
      if (save.pending || save.unresolved || save.owedRead || save.openRead) return;
      removeStatusRetry(save, RETRY_KEY);
      if (save.tone) setStatus('');
    },
    reset,
  };
  return api;
}

// ─── Project and Book primary-image actions (WP10A2) ─────────────────────

const PRIMARY_IMAGE_STATE_KEY = '__creatorCrateAssetPrimaryImage';
const PRIMARY_IMAGE_STATUS_TEXT_ATTRIBUTE = 'data-asset-primary-image-status-text';
const PRIMARY_IMAGE_STATE_ATTRIBUTE = 'data-asset-primary-image-state';
const PRIMARY_IMAGE_RETRY_ATTRIBUTE = 'data-asset-primary-image-retry';
// On a submitted form until the page shows what its change left: 'refresh'
// while the GET is out, 'stale' after it failed. Its buttons are held with
// aria-disabled (never `disabled`, so the focus a user left there stays).
const PRIMARY_IMAGE_HOLD_ATTRIBUTE = 'data-asset-primary-image-hold';
const PRIMARY_IMAGE_HELD_BUTTON_ATTRIBUTE = 'data-asset-primary-image-held';
const BOOK_PRIMARY_REGION_SELECTOR = '[data-asset-viewer-region="book-primary-image"]';

// The four existing native forms, unchanged: each keeps its action, fields and
// CSRF token, and still submits natively when fetch is unavailable.
const PRIMARY_IMAGE_ACTIONS = Object.freeze([
  { selector: 'form.asset-primary-image-set-form', kind: 'project-set', target: 'project' },
  { selector: 'form.asset-primary-image-remove-form', kind: 'project-remove', target: 'project' },
  { selector: 'form.asset-book-primary-image-set-form', kind: 'book-set', target: 'book' },
  { selector: 'form.asset-book-primary-image-remove-form', kind: 'book-remove', target: 'book' },
]);

const PRIMARY_IMAGE_MESSAGES = Object.freeze({
  wait: 'Wait for the current change to finish, then try again.',
  awaitingRefresh: 'Wait for the primary image details to refresh, then try again.',
  stale: 'Use Retry refresh before trying again.',
  refreshing: 'Refreshing the primary image details…',
  outOfDate: 'The primary image details shown may be out of date.',
  assetGone: 'This asset can no longer be read. It may have been deleted elsewhere.',
  nothingChanged: 'Nothing was changed.',
  savedShown: 'The saved primary image is shown.',
  notProof: 'This is what is saved now; it does not show whether your request ran.',
  refusedFallback: 'The primary image change was refused.',
  staleAfterClose: 'The primary image details could not be read. They may be out of date.',
});

function primaryImageTexts(plan) {
  const book = plan.bookTitle ? `“${plan.bookTitle}”` : 'the Book';
  const forBook = (ids) => ids.includes(plan.bookId);
  switch (plan.kind) {
    case 'project-set':
      return {
        pending: 'Setting the primary image…',
        saved: 'The primary image was set.',
        unconfirmed: 'The primary image change could not be confirmed.',
        observed: (s) => (s.projectSelected
          ? 'This asset is now the project’s primary image.'
          : 'This asset is not the project’s primary image.'),
      };
    case 'project-remove':
      return {
        pending: 'Removing the primary image…',
        saved: 'The primary image was removed.',
        unconfirmed: 'The primary image removal could not be confirmed.',
        observed: (s) => (s.projectSelected
          ? 'This asset is still the project’s primary image.'
          : 'This asset is not the project’s primary image.'),
      };
    case 'book-set':
      return {
        pending: `Setting the book primary image for ${book}…`,
        saved: `The book primary image was set for ${book}.`,
        unconfirmed: `The book primary image change for ${book} could not be confirmed.`,
        observed: (s) => (forBook(s.bookIds)
          ? `This asset is now the primary image for ${book}.`
          : `This asset is not the primary image for ${book}.`),
      };
    default:
      return {
        pending: `Removing the book primary image from ${book}…`,
        saved: `The book primary image was removed from ${book}.`,
        unconfirmed: `The book primary image removal from ${book} could not be confirmed.`,
        observed: (s) => (forBook(s.bookIds)
          ? `This asset is still the primary image for ${book}.`
          : `This asset is not the primary image for ${book}.`),
      };
  }
}

function bookTitleFor(form, kind) {
  if (kind === 'book-remove') {
    return form.closest?.('li')?.querySelector?.('strong')?.textContent?.trim() || '';
  }
  const select = form.querySelector?.('select[name="bookId"]');
  const option = select?.selectedOptions?.[0] || select?.options?.[select.selectedIndex];
  return option?.value ? option.textContent?.trim() || '' : '';
}

/**
 * The Edit Asset dialog's four Project/Book primary-image forms change the
 * selection in place: one explicit submission sends one POST (Accept:
 * application/json) while the Asset detail document, its media host and the
 * open dialog stay mounted.
 *
 *  - While the POST is out the dialog is frozen, as for a tag save; any other
 *    submission is refused, never queued. The request holds the form exactly
 *    as it was (including the displayed asset the server compares a removal
 *    against), so a stale Remove is refused by the server, not guessed here.
 *  - Every answer is followed by a GET of the page that installs the primary-
 *    image regions (asset-viewer-refresh.js). Until it does, only the submitted
 *    form is held; the dialog's other forms stay usable.
 *  - A lost or unreadable answer is never resubmitted. The GET reports what is
 *    saved now, which is not proof of what the lost request did.
 */
function enhancePrimaryImageActions(dialog, appDialogState, coordinator) {
  if (isEnhancementBound(dialog, 'assetPrimaryImageActionsBound')) return null;
  markEnhancementBound(dialog, 'assetPrimaryImageActionsBound');

  const document = dialog.ownerDocument;
  const windowObject = document.defaultView || globalThis;
  const state = {
    pending: null,
    attempt: 0,
    // Settled submissions whose result the page does not show yet, oldest first:
    // { id, kind: 'saved'|'refused'|'uncertain', plan, form, refusal }.
    owed: [],
    // A failed GET left the shown details unconfirmed (Retry refresh / Check again).
    openRead: false,
    tone: null,
    settledMessage: '',
    [RETRY_KEY]: null,
  };
  dialog[PRIMARY_IMAGE_STATE_KEY] = state;

  const canSubmitInPlace = () => typeof windowObject.fetch === 'function'
    && typeof windowObject.FormData === 'function'
    && typeof windowObject.URLSearchParams === 'function';

  function statusText(create) {
    const status = dialog.querySelector(DIALOG_STATUS_SELECTOR);
    if (!status) return { status: null, text: null };
    let text = status.querySelector(`[${PRIMARY_IMAGE_STATUS_TEXT_ATTRIBUTE}]`);
    if (!text && create) {
      text = status.ownerDocument.createElement('span');
      text.setAttribute(PRIMARY_IMAGE_STATUS_TEXT_ATTRIBUTE, '');
      status.appendChild(text);
    }
    return { status, text };
  }

  function setStatus(message, tone = null) {
    const { status, text } = statusText(Boolean(message));
    if (!status) return;
    if (text) text.textContent = message || '';
    state.tone = message ? tone : null;
    if (message && tone) status.setAttribute(PRIMARY_IMAGE_STATE_ATTRIBUTE, tone);
    else status.removeAttribute(PRIMARY_IMAGE_STATE_ATTRIBUTE);
  }

  // A result the user should keep seeing (success, refusal, uncertainty).
  function settle(message, tone) {
    state.settledMessage = message;
    setStatus(message, tone);
  }

  function hold(form, value) {
    if (!form) return;
    form.setAttribute(PRIMARY_IMAGE_HOLD_ATTRIBUTE, value);
    Array.from(form.querySelectorAll('button')).forEach((button) => {
      if (button.type !== 'submit' && button.getAttribute('type')) return;
      button.setAttribute('aria-disabled', 'true');
      button.setAttribute(PRIMARY_IMAGE_HELD_BUTTON_ATTRIBUTE, '');
    });
  }

  // Forms kept through an install (the Book Set form) are released here; a
  // replaced form went with its region.
  function releaseHolds() {
    Array.from(dialog.querySelectorAll(`[${PRIMARY_IMAGE_HOLD_ATTRIBUTE}]`)).forEach((form) => {
      form.removeAttribute(PRIMARY_IMAGE_HOLD_ATTRIBUTE);
    });
    Array.from(dialog.querySelectorAll(`[${PRIMARY_IMAGE_HELD_BUTTON_ATTRIBUTE}]`)).forEach((button) => {
      button.removeAttribute(PRIMARY_IMAGE_HELD_BUTTON_ATTRIBUTE);
      button.removeAttribute('aria-disabled');
    });
  }

  function offerRetry(label, onRetry) {
    const { status } = statusText(true);
    return showStatusRetry({
      state, status, attribute: PRIMARY_IMAGE_RETRY_ATTRIBUTE, key: RETRY_KEY, label, onRetry,
    });
  }

  function installedMessage(entry, observed) {
    const texts = primaryImageTexts(entry.plan);
    if (entry.kind === 'saved') return texts.saved;
    if (entry.kind === 'refused') {
      return `${entry.refusal} ${PRIMARY_IMAGE_MESSAGES.nothingChanged} ${PRIMARY_IMAGE_MESSAGES.savedShown}`;
    }
    return `${texts.unconfirmed} ${texts.observed(observed)} ${PRIMARY_IMAGE_MESSAGES.notProof}`;
  }

  function failedMessage(entry, missing) {
    const texts = primaryImageTexts(entry.plan);
    const tail = missing ? PRIMARY_IMAGE_MESSAGES.assetGone : PRIMARY_IMAGE_MESSAGES.outOfDate;
    if (entry.kind === 'saved') return `${texts.saved} ${tail}`;
    if (entry.kind === 'refused') return `${entry.refusal} ${PRIMARY_IMAGE_MESSAGES.nothingChanged} ${tail}`;
    return missing
      ? `${texts.unconfirmed} ${tail}`
      : `${texts.unconfirmed} The saved primary image could not be read. Check again before trying again.`;
  }

  function toneFor(entries, fallback) {
    if (entries.some((entry) => entry.kind === 'uncertain')) return 'uncertain';
    if (entries.some((entry) => entry.kind === 'refused')) return 'error';
    return fallback;
  }

  // The primary-image regions now show the server's saved state: every owed
  // submission is settled against it. Called for this module's GET and for
  // another action's GET that carried the owed regions.
  function adoptInstalled(result) {
    if (state.pending || !result.primaryImage) return;
    releaseHolds();
    if (result.bookSectionReplaced) {
      Array.from(dialog.querySelector(BOOK_PRIMARY_REGION_SELECTOR)?.querySelectorAll('[data-cc-dropdown]') || [])
        .forEach(initializeCreatorCrateDropdown);
    }
    state.openRead = false;
    removeStatusRetry(state, RETRY_KEY);
    if (state.owed.length === 0) return;
    const entries = state.owed;
    state.owed = [];
    settle(entries.map((entry) => installedMessage(entry, result.primaryImage)).join(' '), toneFor(entries, 'saved'));
  }

  function noteFailed(result, { offer = false, focusResult = false } = {}) {
    if (state.pending || state.owed.length === 0) return;
    const missing = result.status === ASSET_VIEWER_REFRESH_STATUS.MISSING;
    if (!missing && result.status !== ASSET_VIEWER_REFRESH_STATUS.FAILED) return;
    state.owed.forEach((entry) => hold(entry.form?.isConnected ? entry.form : null, missing ? 'gone' : 'stale'));
    state.openRead = !missing;
    settle(state.owed.map((entry) => failedMessage(entry, missing)).join(' '), toneFor(state.owed, 'error'));
    if (!offer || missing) return;
    const uncertain = state.owed.some((entry) => entry.kind === 'uncertain');
    // Repeats the GET only: the POST is never sent again by itself.
    const button = offerRetry(uncertain ? 'Check again' : 'Retry refresh', ({ wasFocused }) => {
      setStatus(uncertain ? 'Checking the saved primary image…' : PRIMARY_IMAGE_MESSAGES.refreshing, 'pending');
      readPrimaryImage({ focusResult: wasFocused });
    });
    if (focusResult) button?.focus?.();
  }

  function readPrimaryImage({ focusResult = false } = {}) {
    removeStatusRetry(state, RETRY_KEY);
    const identity = assetViewerIdentity(document);
    return refreshAssetViewer(document, {
      ...(identity || {}),
      regions: [ASSET_VIEWER_REFRESH_REGIONS.PRIMARY_IMAGE],
    }).then((result) => {
      // A newer change or read owns the page now; these submissions stay owed to it.
      if (result.status === ASSET_VIEWER_REFRESH_STATUS.SUPERSEDED || state.pending) return result;
      if (result.status === ASSET_VIEWER_REFRESH_STATUS.INSTALLED) {
        adoptInstalled(result);
        coordinator.installed(result, api);
        return result;
      }
      if (result.status === ASSET_VIEWER_REFRESH_STATUS.UNAVAILABLE) return result;
      noteFailed(result, { offer: true, focusResult });
      coordinator.failed(result, api);
      return result;
    });
  }

  function classify(response, payload, identity, plan) {
    if (response?.ok && payload?.status === 'success' && payload.outcome === 'committed'
      && identity
      && String(payload.projectId) === identity.projectId
      && String(payload.assetId) === identity.assetId
      && (plan.target !== 'book' || String(payload.bookId) === plan.bookId)) {
      return 'committed';
    }
    // A refusal is known only from the server's own answer: a JSON error sent
    // before anything was stored (every 4xx the routes, CSRF and authentication
    // send). Anything else, a 5xx 'unknown' included, may have committed.
    if (payload?.status === 'error' && response?.status >= 400 && response.status < 500
      && (payload.outcome === undefined || payload.outcome === 'refused')) {
      return 'refused';
    }
    return 'uncertain';
  }

  dialog.addEventListener('submit', (event) => {
    const form = event.target;
    const action = PRIMARY_IMAGE_ACTIONS.find((candidate) => form?.matches?.(candidate.selector));
    if (!action || event.defaultPrevented || !canSubmitInPlace()) return;
    event.preventDefault();
    if (state.pending || coordinator.otherPending(api)) {
      setStatus((!state.pending && coordinator.holdMessage(api)) || PRIMARY_IMAGE_MESSAGES.wait, 'pending');
      return;
    }
    const held = form.getAttribute(PRIMARY_IMAGE_HOLD_ATTRIBUTE);
    if (held) {
      // Added to, not replacing, what the last change reported.
      const note = {
        refresh: PRIMARY_IMAGE_MESSAGES.awaitingRefresh,
        gone: PRIMARY_IMAGE_MESSAGES.assetGone,
      }[held] || PRIMARY_IMAGE_MESSAGES.stale;
      const base = state.settledMessage || '';
      setStatus(base.endsWith(note) ? base : `${base} ${note}`.trim(), state.tone || 'pending');
      return;
    }

    // Captured before the dialog freezes: the request holds exactly this form.
    const identity = assetViewerIdentity(document);
    const body = new windowObject.URLSearchParams(new windowObject.FormData(form));
    const plan = {
      kind: action.kind,
      target: action.target,
      bookId: action.target === 'book' ? String(form.querySelector('[name="bookId"]')?.value || '') : null,
      bookTitle: action.target === 'book' ? bookTitleFor(form, action.kind) : '',
    };
    const texts = primaryImageTexts(plan);
    state.attempt += 1;
    const attempt = { id: state.attempt, plan, form };
    state.pending = attempt;
    // Any read still out predates this change and must not install.
    supersedeAssetViewerRefresh(document);
    removeStatusRetry(state, RETRY_KEY);
    coordinator.yieldStatus(api);
    form.setAttribute('aria-busy', 'true');
    settle(texts.pending, 'pending');
    const unfreeze = freezeAppDialog(appDialogState);

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
      .then(({ response, payload }) => ({ outcome: classify(response, payload, identity, plan), payload }))
      .catch(() => ({ outcome: 'uncertain', payload: null }))
      .then(({ outcome, payload }) => {
        state.pending = null;
        form.removeAttribute('aria-busy');
        // Held before the dialog thaws, so the focus it restores lands on a
        // control that cannot repeat this change until the page shows it.
        hold(form, 'refresh');
        unfreeze();
        const kind = outcome === 'committed' ? 'saved' : outcome;
        const refusal = (typeof payload?.message === 'string' && payload.message) || PRIMARY_IMAGE_MESSAGES.refusedFallback;
        state.owed.push({ ...attempt, kind, refusal });
        if (kind === 'saved') settle(texts.saved, 'saved');
        else if (kind === 'refused') settle(`${refusal} ${PRIMARY_IMAGE_MESSAGES.nothingChanged}`, 'error');
        else settle(`${texts.unconfirmed} Checking the saved primary image…`, 'pending');
        return readPrimaryImage();
      });
  });

  function reset() {
    // A GET still out reports for itself, whether or not the dialog is open.
    if (state.pending || (state.owed.length > 0 && !state.openRead)) return;
    if (state.openRead) {
      settle(PRIMARY_IMAGE_MESSAGES.staleAfterClose, 'error');
      return;
    }
    removeStatusRetry(state, RETRY_KEY);
    settle('');
  }

  const api = {
    isPending: () => Boolean(state.pending),
    adoptInstalled,
    noteFailed: (result) => noteFailed(result),
    yieldStatus() {
      if (state.pending || state.owed.length > 0 || state.openRead) return;
      removeStatusRetry(state, RETRY_KEY);
      if (state.tone) settle('');
    },
    reset,
  };
  return api;
}

// ─── Rename and Move (WP10A3-A) ───────────────────────────────────────────

const FILE_ACTION_STATE_KEY = '__creatorCrateAssetFileActions';
const FILE_ACTION_STATUS_TEXT_ATTRIBUTE = 'data-asset-file-action-status-text';
const FILE_ACTION_STATE_ATTRIBUTE = 'data-asset-file-action-state';
const FILE_ACTION_RETRY_ATTRIBUTE = 'data-asset-file-action-retry';
// On both file forms until the page shows what a Rename or Move left:
// 'refresh' while the GET is out, 'stale' after it failed, 'gone' when the
// asset can no longer be read. Buttons are held with aria-disabled (never
// `disabled`, so the focus a user left there stays).
const FILE_ACTION_HOLD_ATTRIBUTE = 'data-asset-file-action-hold';
const FILE_ACTION_HELD_BUTTON_ATTRIBUTE = 'data-asset-file-action-held';
const RENAME_INPUT_SELECTOR = '#rename-filename';
const MOVE_SELECT_SELECTOR = '#move-destination';
const CONFIRMED_VALUE_ATTRIBUTE = 'data-confirmed-value';
const FILE_ACTIONS_HEADING_SELECTOR = '#asset-actions-heading';

// The two existing native forms, unchanged: each keeps its action, fields
// (Rename's origin=viewer complete-filename contract and Move's canonical
// destinationCategory value) and CSRF token, and still submits natively when
// fetch is unavailable.
const FILE_ACTIONS = Object.freeze([
  { selector: 'form.asset-rename-form', kind: 'rename', control: RENAME_INPUT_SELECTOR },
  { selector: 'form.asset-move-form', kind: 'move', control: MOVE_SELECT_SELECTOR },
]);

const FILE_ACTION_MESSAGES = Object.freeze({
  wait: 'Wait for the current change to finish, then try again.',
  awaitingRefresh: 'Wait for the file details to refresh, then try again.',
  stale: 'Use Retry refresh or Check again before renaming or moving this file.',
  refreshing: 'Refreshing the file details…',
  checking: 'Checking the saved file details…',
  outOfDate: 'The file details shown on this page may be out of date.',
  assetGone: 'This asset can no longer be read. It may have been deleted elsewhere.',
  nothingChanged: 'Nothing was changed, and your entry was kept.',
  savedShown: 'The saved file details are shown.',
  notProof: 'This is what is saved now; it does not show whether your request ran.',
  recoveryShown: 'The details shown are CreatorCrate’s records, which may not match the project folder.',
  refusedFallback: 'The change was refused.',
  filteredOut: 'This asset no longer matches the current asset-browser filters, so Previous and Next are unavailable.',
  staleAfterClose: 'The file details could not be read. They may be out of date.',
  checkFailed: 'The saved file details could not be read.',
  // A lost or unreadable answer: the request may not have run yet.
  unresolvedHeld: 'Your request may still run, or may have only partly completed, so this asset cannot be renamed, moved or otherwise changed from this page. Check again only reads the saved details and sends nothing; reload the page once that request can no longer be running.',
  recoveryHeld: 'This asset cannot be renamed, moved or otherwise changed from this page until the project folder has been inspected. Reload the page to try again.',
  heldRecovery: 'This asset cannot be changed from this page until the project folder has been inspected. Reload the page to try again.',
});

// The server's refusal of a Rename or Move made against an asset state the
// asset no longer has (F2B, asset-delete-review.js).
const FILE_ACTION_STALE_CODE = 'ASSET_REVIEW_STALE';

function heldUnresolvedMessage(plan) {
  return `This asset cannot be changed from this page while the earlier ${plan?.kind === 'move' ? 'move' : 'rename'} is unconfirmed. Use Check again, or reload the page once that request can no longer be running.`;
}

function quoted(value) {
  return `“${value}”`;
}

function fileActionTexts(plan) {
  if (plan.kind === 'rename') {
    return {
      pending: `Renaming the file to ${quoted(plan.filename)}…`,
      saved: (confirmed) => `The file was renamed to ${quoted(confirmed?.filename || plan.filename)}.`,
      unconfirmed: 'The rename could not be confirmed.',
      observed: (file) => `The saved filename is ${quoted(file.filename)}.`,
    };
  }
  return {
    pending: `Moving the file to ${plan.label}…`,
    saved: (confirmed) => `The file was moved to ${confirmed?.label || plan.label}.`,
    unconfirmed: 'The move could not be confirmed.',
    observed: (file) => `The asset is saved in ${file.categoryLabel || 'its current location'}.`,
  };
}

function moveDestinationLabel(select, value) {
  const option = Array.from(select?.querySelectorAll?.('option') || []).find((candidate) => candidate.value === value);
  return option?.textContent?.trim() || '';
}

/**
 * Edit Asset's Rename and Move forms change the file in place: one explicit
 * submission sends one POST (Accept: application/json) while the Asset detail
 * document, its media host and the open dialog stay mounted. Rename and Move
 * keep the asset's ID and project, so the page's URL stays the asset's URL.
 *
 *  - The request holds the form exactly as submitted (Rename's complete
 *    filename with origin=viewer; Move's canonical destinationCategory). The
 *    client neither normalizes nor validates beyond the inputs' own
 *    constraints: the service decides.
 *  - While the POST is out the dialog is frozen; any other submission is
 *    refused, never queued.
 *  - Saved baselines (data-confirmed-value on #rename-filename and
 *    #move-destination) advance only to what a response acknowledged or a GET
 *    read. A control's value changes only when it held no draft.
 *  - A committed, recovery-required or unconfirmed answer is followed by a GET
 *    of the page that installs the 'file' region (asset-viewer-refresh.js).
 *    Until it does, both file forms are held. A clean refusal is shown at once
 *    and leaves the attempted entry in place to correct.
 *  - A lost or unreadable answer is never resubmitted. The GET reports what is
 *    saved now, which is not proof of what the lost request did.
 *  - Such an answer leaves the change unresolved: the request may still be on
 *    its way to the service, so no read releases it (this module's Check
 *    again, another action's read, a failed or superseded read, dismissal).
 *    Only that request's own answer could, and it was lost, so the hold lasts
 *    until the page is reloaded. A recovery-required answer holds the same
 *    way: a read of the records cannot show the project folder was restored.
 *    While either holds, the coordinator refuses every Edit Asset action.
 */
function enhanceAssetFileActions(dialog, appDialogState, coordinator) {
  if (!FILE_ACTIONS.some((action) => dialog.querySelector(action.selector))) return null;
  if (isEnhancementBound(dialog, 'assetFileActionsBound')) return null;
  markEnhancementBound(dialog, 'assetFileActionsBound');

  const document = dialog.ownerDocument;
  const windowObject = document.defaultView || globalThis;
  const state = {
    pending: null,
    attempt: 0,
    // Settled submissions whose result the page does not show yet, oldest
    // first: { id, plan, kind: 'saved'|'recovery'|'uncertain'|'quiet', message }.
    owed: [],
    // A failed GET left the shown details unconfirmed (Retry refresh / Check again).
    openRead: false,
    // { id, plan }: a submission whose answer was lost or unreadable. It may
    // still run on the server, so nothing but its own answer could release
    // it; no GET does. Ends only with the page.
    unresolved: null,
    // { id, plan, message }: the server said the file and its record may
    // disagree. A GET of the records cannot show otherwise. Ends with the page.
    recovery: null,
    tone: null,
    settledMessage: '',
    [RETRY_KEY]: null,
  };
  dialog[FILE_ACTION_STATE_KEY] = state;

  // The standing hold, if any: what both file forms show while it lasts.
  const standing = () => (state.recovery ? 'recovery' : (state.unresolved ? 'unresolved' : null));

  const canSubmitInPlace = () => typeof windowObject.fetch === 'function'
    && typeof windowObject.FormData === 'function'
    && typeof windowObject.URLSearchParams === 'function';

  const fileForms = () => FILE_ACTIONS.map((action) => dialog.querySelector(action.selector)).filter(Boolean);

  function statusText(create) {
    const status = dialog.querySelector(DIALOG_STATUS_SELECTOR);
    if (!status) return { status: null, text: null };
    let text = status.querySelector(`[${FILE_ACTION_STATUS_TEXT_ATTRIBUTE}]`);
    if (!text && create) {
      text = status.ownerDocument.createElement('span');
      text.setAttribute(FILE_ACTION_STATUS_TEXT_ATTRIBUTE, '');
      status.appendChild(text);
    }
    return { status, text };
  }

  function setStatus(message, tone = null) {
    const { status, text } = statusText(Boolean(message));
    if (!status) return;
    if (text) text.textContent = message || '';
    state.tone = message ? tone : null;
    if (message && tone) status.setAttribute(FILE_ACTION_STATE_ATTRIBUTE, tone);
    else status.removeAttribute(FILE_ACTION_STATE_ATTRIBUTE);
  }

  function settle(message, tone) {
    state.settledMessage = message;
    setStatus(message, tone);
  }

  function hold(value) {
    fileForms().forEach((form) => {
      form.setAttribute(FILE_ACTION_HOLD_ATTRIBUTE, value);
      Array.from(form.querySelectorAll('button')).forEach((button) => {
        if (button.type !== 'submit' && button.getAttribute('type')) return;
        button.setAttribute('aria-disabled', 'true');
        button.setAttribute(FILE_ACTION_HELD_BUTTON_ATTRIBUTE, '');
      });
    });
  }

  function releaseHolds() {
    fileForms().forEach((form) => form.removeAttribute(FILE_ACTION_HOLD_ATTRIBUTE));
    Array.from(dialog.querySelectorAll(`[${FILE_ACTION_HELD_BUTTON_ATTRIBUTE}]`)).forEach((button) => {
      button.removeAttribute(FILE_ACTION_HELD_BUTTON_ATTRIBUTE);
      button.removeAttribute('aria-disabled');
    });
  }

  function offerRetry(label, onRetry) {
    const { status } = statusText(true);
    return showStatusRetry({
      state, status, attribute: FILE_ACTION_RETRY_ATTRIBUTE, key: RETRY_KEY, label, onRetry,
    });
  }

  // A control shows a new saved value only when it holds no draft: its value
  // is the baseline it showed before, or the value this submission sent.
  function adoptBaseline(selector, saved, { previous, submitted = null }) {
    const control = dialog.querySelector(selector);
    if (!control || saved === null || saved === undefined) return;
    control.setAttribute(CONFIRMED_VALUE_ATTRIBUTE, saved);
    const value = String(control.value ?? '');
    if (value === previous || (submitted !== null && value === submitted)) {
      control.value = saved;
      if (control.tagName === 'SELECT') syncCreatorCrateDropdownFromNative(control);
    }
  }

  function installedMessage(entry, result) {
    const texts = fileActionTexts(entry.plan);
    if (entry.kind === 'saved') return texts.saved(entry.confirmed);
    if (entry.kind === 'recovery') return `${entry.message} ${FILE_ACTION_MESSAGES.recoveryShown}`;
    if (entry.kind === 'quiet') return entry.message;
    return `${texts.unconfirmed} ${texts.observed(result.file)} ${FILE_ACTION_MESSAGES.notProof}`;
  }

  // Why both file forms (and, through the coordinator, every other Edit Asset
  // action) stay refused while a standing hold lasts.
  function standingTail() {
    return state.recovery ? FILE_ACTION_MESSAGES.recoveryHeld : FILE_ACTION_MESSAGES.unresolvedHeld;
  }

  function failedMessage(entry, missing) {
    const texts = fileActionTexts(entry.plan);
    const tail = missing ? FILE_ACTION_MESSAGES.assetGone : FILE_ACTION_MESSAGES.outOfDate;
    if (entry.kind === 'saved') return `${texts.saved(entry.confirmed)} ${tail}`;
    if (entry.kind === 'quiet') return `${entry.message} ${tail}`;
    if (entry.kind === 'recovery') return `${entry.message} ${tail}${missing ? '' : ` ${FILE_ACTION_MESSAGES.recoveryHeld}`}`;
    return missing
      ? `${texts.unconfirmed} ${tail}`
      : `${texts.unconfirmed} ${FILE_ACTION_MESSAGES.checkFailed} ${FILE_ACTION_MESSAGES.unresolvedHeld}`;
  }

  function toneFor(entries, fallback) {
    if (entries.some((entry) => entry.kind === 'recovery')) return 'error';
    if (entries.some((entry) => entry.kind === 'uncertain')) return 'uncertain';
    // A refusal shown with the page it asked to read (F2B stale review).
    if (entries.some((entry) => entry.tone === 'error')) return 'error';
    return fallback;
  }

  // GET only, for an unresolved change: what is saved now, never a resend.
  // Offered again after every read, so the one way to look stays reachable.
  function offerCheck(focusResult = false) {
    if (!state.unresolved || state.recovery) return null;
    const texts = fileActionTexts(state.unresolved.plan);
    const button = offerRetry('Check again', ({ wasFocused }) => {
      setStatus(`${texts.unconfirmed} ${FILE_ACTION_MESSAGES.checking}`, 'pending');
      readFile({ focusResult: wasFocused });
    });
    if (focusResult) button?.focus?.();
    return button;
  }

  // A later read (Check again, or another action's) while a standing hold
  // lasts: it reports what is saved now and leaves the hold as it was.
  function noteStanding(file, { focusResult = false } = {}) {
    if (state.recovery) {
      settle(`${state.recovery.message} ${FILE_ACTION_MESSAGES.recoveryShown} ${FILE_ACTION_MESSAGES.recoveryHeld}`, 'error');
      return;
    }
    const texts = fileActionTexts(state.unresolved.plan);
    settle(`${texts.unconfirmed} ${texts.observed(file)} ${FILE_ACTION_MESSAGES.notProof} ${FILE_ACTION_MESSAGES.unresolvedHeld}`, 'uncertain');
    offerCheck(focusResult);
  }

  // The 'file' region now shows the server's saved state: every owed
  // submission settles against it. Called for this module's GET and for
  // another action's GET that carried the owed region. A read ends the wait
  // for the page; it never ends a standing hold (see `unresolved`).
  function adoptInstalled(result, { focusResult = false } = {}) {
    if (state.pending || !result?.file) return;
    // Controls without a draft follow the saved values read now.
    const previous = result.previousFile;
    if (previous) {
      adoptBaseline(RENAME_INPUT_SELECTOR, result.file.filename, { previous: previous.filename });
      adoptBaseline(MOVE_SELECT_SELECTOR, result.file.destination, { previous: previous.destination });
    }
    if (standing()) hold(standing());
    else releaseHolds();
    state.openRead = false;
    removeStatusRetry(state, RETRY_KEY);
    if (state.owed.length === 0) {
      if (standing()) noteStanding(result.file, { focusResult });
      return;
    }
    const entries = state.owed;
    state.owed = [];
    const parts = entries.map((entry) => installedMessage(entry, result));
    if (result.file.filteredOut && !previous?.filteredOut) parts.push(FILE_ACTION_MESSAGES.filteredOut);
    if (standing()) parts.push(standingTail());
    settle(parts.join(' '), toneFor(entries, 'saved'));
    offerCheck(focusResult);
  }

  function noteFailed(result, { offer = false, focusResult = false } = {}) {
    if (state.pending) return;
    const missing = result.status === ASSET_VIEWER_REFRESH_STATUS.MISSING;
    if (!missing && result.status !== ASSET_VIEWER_REFRESH_STATUS.FAILED) return;
    if (state.owed.length === 0) {
      // Nothing owed: only a standing hold has anything to report.
      if (!standing()) return;
      hold(missing ? 'gone' : standing());
      const intro = state.recovery ? state.recovery.message : fileActionTexts(state.unresolved.plan).unconfirmed;
      settle(missing
        ? `${intro} ${FILE_ACTION_MESSAGES.assetGone}`
        : `${intro} ${FILE_ACTION_MESSAGES.checkFailed} ${standingTail()}`, missing || state.recovery ? 'error' : 'uncertain');
      if (!missing) offerCheck(focusResult);
      return;
    }
    hold(missing ? 'gone' : (standing() || 'stale'));
    state.openRead = !missing;
    settle(state.owed.map((entry) => failedMessage(entry, missing)).join(' '), toneFor(state.owed, 'error'));
    if (!offer || missing || state.recovery) return;
    if (state.unresolved) {
      offerCheck(focusResult);
      return;
    }
    // Repeats the GET only: the POST is never sent again by itself.
    const button = offerRetry('Retry refresh', ({ wasFocused }) => {
      setStatus(FILE_ACTION_MESSAGES.refreshing, 'pending');
      readFile({ focusResult: wasFocused });
    });
    if (focusResult) button?.focus?.();
  }

  function readFile({ focusResult = false, regions = [ASSET_VIEWER_REFRESH_REGIONS.FILE] } = {}) {
    removeStatusRetry(state, RETRY_KEY);
    const identity = assetViewerIdentity(document);
    return refreshAssetViewer(document, { ...(identity || {}), regions }).then((result) => {
      // A newer change or read owns the page now; these submissions stay owed to it.
      if (result.status === ASSET_VIEWER_REFRESH_STATUS.SUPERSEDED || state.pending) return result;
      if (result.status === ASSET_VIEWER_REFRESH_STATUS.INSTALLED) {
        adoptInstalled(result, { focusResult });
        coordinator.installed(result, api);
        return result;
      }
      if (result.status === ASSET_VIEWER_REFRESH_STATUS.UNAVAILABLE) return result;
      noteFailed(result, { offer: true, focusResult });
      coordinator.failed(result, api);
      return result;
    });
  }

  function classify(response, payload, identity) {
    if (response?.ok && payload?.status === 'success' && payload.outcome === 'committed'
      && identity
      && String(payload.projectId) === identity.projectId
      && String(payload.assetId) === identity.assetId
      && typeof payload.asset?.filename === 'string'
      && typeof payload.asset?.destinationCategory === 'string') {
      return 'committed';
    }
    if (payload?.status === 'error' && response && !response.ok) {
      // The server's own statement that the file moved but its record did not.
      if (payload.outcome === 'recovery-required') return 'recovery';
      // Refused before anything was touched: the routes' 4xx answers (and
      // CSRF/authentication, which name no outcome), and the operational
      // failures the service raises before its rename runs.
      if (response.status >= 400 && response.status < 500
        && (payload.outcome === undefined || payload.outcome === 'refused')) return 'refused';
      if (response.status >= 500 && payload.outcome === 'failed') return 'refused';
    }
    // Anything else — a lost answer, an unreadable body, an 'unknown' 500 —
    // may have committed.
    return 'uncertain';
  }

  dialog.addEventListener('submit', (event) => {
    const form = event.target;
    const action = FILE_ACTIONS.find((candidate) => form?.matches?.(candidate.selector));
    if (!action || event.defaultPrevented || !canSubmitInPlace()) return;
    event.preventDefault();
    if (state.pending) {
      setStatus(FILE_ACTION_MESSAGES.wait, 'pending');
      return;
    }
    if (standing()) {
      // Refused, never queued: added to the standing warning, not replacing it.
      const note = api.holdMessage();
      const base = state.settledMessage || '';
      setStatus(base.endsWith(note) ? base : `${base} ${note}`.trim(), state.tone || 'uncertain');
      return;
    }
    if (coordinator.otherPending(api)) {
      setStatus(coordinator.holdMessage(api) || FILE_ACTION_MESSAGES.wait, 'pending');
      return;
    }
    const held = form.getAttribute(FILE_ACTION_HOLD_ATTRIBUTE);
    if (held) {
      // Added to, not replacing, what the last change reported.
      const note = {
        refresh: FILE_ACTION_MESSAGES.awaitingRefresh,
        gone: FILE_ACTION_MESSAGES.assetGone,
      }[held] || FILE_ACTION_MESSAGES.stale;
      const base = state.settledMessage || '';
      setStatus(base.endsWith(note) ? base : `${base} ${note}`.trim(), state.tone || 'pending');
      return;
    }

    // Captured before the dialog freezes: the request holds exactly this form.
    const identity = assetViewerIdentity(document);
    const body = new windowObject.URLSearchParams(new windowObject.FormData(form));
    const control = form.querySelector(action.control);
    const submitted = String(control?.value ?? '');
    const plan = {
      kind: action.kind,
      filename: action.kind === 'rename' ? submitted : null,
      destination: action.kind === 'move' ? submitted : null,
      label: action.kind === 'move' ? moveDestinationLabel(control, submitted) : '',
      previous: control?.getAttribute(CONFIRMED_VALUE_ATTRIBUTE) ?? null,
    };
    const texts = fileActionTexts(plan);
    state.attempt += 1;
    const attempt = { id: state.attempt, plan };
    state.pending = attempt;
    // Any read still out predates this change and must not install.
    supersedeAssetViewerRefresh(document);
    removeStatusRetry(state, RETRY_KEY);
    state.openRead = false;
    coordinator.yieldStatus(api);
    form.setAttribute('aria-busy', 'true');
    settle(texts.pending, 'pending');
    const unfreeze = freezeAppDialog(appDialogState);

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
      .then(({ response, payload }) => ({ outcome: classify(response, payload, identity), payload }))
      .catch(() => ({ outcome: 'uncertain', payload: null }))
      .then(({ outcome, payload }) => {
        state.pending = null;
        form.removeAttribute('aria-busy');
        const message = (typeof payload?.message === 'string' && payload.message) || FILE_ACTION_MESSAGES.refusedFallback;

        if (outcome === 'refused') {
          unfreeze();
          // The attempted entry stays in place to correct; the baseline stays.
          if (payload?.code === FILE_ACTION_STALE_CODE) {
            // F2B: the asset was changed elsewhere (another tab, or before a
            // reload) after this page showed it, and the server refused this
            // request before touching anything. Read what is saved now (GET
            // only, never a resend) so the page, its baselines and the reviewed
            // state a new submission carries show the asset as it is.
            state.owed.push({ ...attempt, kind: 'quiet', tone: 'error', message: `${message} ${FILE_ACTION_MESSAGES.nothingChanged}` });
            hold('refresh');
            return readFile({
              regions: [ASSET_VIEWER_REFRESH_REGIONS.FILE, ASSET_VIEWER_REFRESH_REGIONS.PRIMARY_IMAGE],
            });
          }
          if (state.owed.length > 0) {
            // An earlier change's refresh was superseded by this attempt.
            state.owed.push({ ...attempt, kind: 'quiet', message: `${message} ${FILE_ACTION_MESSAGES.nothingChanged}` });
            hold('refresh');
            return readFile();
          }
          settle(`${message} ${FILE_ACTION_MESSAGES.nothingChanged}`, 'error');
          return null;
        }

        // Only this request's own answer settles it. A lost or unreadable one
        // leaves it unresolved, and a recovery-required one leaves the folder
        // unproven: either way no later read releases the hold.
        if (outcome === 'recovery') state.recovery = { ...attempt, message };
        else if (outcome !== 'committed') state.unresolved = attempt;
        // Held before the dialog thaws, so the focus it restores lands on a
        // control that cannot repeat this change until the page shows it.
        hold(standing() || 'refresh');
        unfreeze();
        if (outcome === 'committed' && form.contains?.(document.activeElement)) {
          // The section heading, not the field or button the user left: once
          // the page shows the change, a repeated Enter there would send the
          // same (now unchanged) filename or destination again.
          const heading = dialog.querySelector(FILE_ACTIONS_HEADING_SELECTOR);
          if (heading && !heading.hasAttribute?.('tabindex')) heading.setAttribute('tabindex', '-1');
          heading?.focus?.({ preventScroll: true });
        }
        if (outcome === 'committed') {
          const confirmed = {
            filename: payload.asset.filename,
            destination: payload.asset.destinationCategory,
            label: moveDestinationLabel(dialog.querySelector(MOVE_SELECT_SELECTOR), payload.asset.destinationCategory) || plan.label,
          };
          adoptBaseline(RENAME_INPUT_SELECTOR, confirmed.filename, {
            previous: action.kind === 'rename' ? plan.previous : dialog.querySelector(RENAME_INPUT_SELECTOR)?.getAttribute(CONFIRMED_VALUE_ATTRIBUTE),
            submitted: action.kind === 'rename' ? submitted : null,
          });
          adoptBaseline(MOVE_SELECT_SELECTOR, confirmed.destination, {
            previous: action.kind === 'move' ? plan.previous : dialog.querySelector(MOVE_SELECT_SELECTOR)?.getAttribute(CONFIRMED_VALUE_ATTRIBUTE),
            submitted: action.kind === 'move' ? submitted : null,
          });
          state.owed.push({ ...attempt, kind: 'saved', confirmed });
          settle(texts.saved(confirmed), 'saved');
        } else if (outcome === 'recovery') {
          state.owed.push({ ...attempt, kind: 'recovery', message });
          settle(`${message} ${FILE_ACTION_MESSAGES.checking}`, 'error');
        } else {
          state.owed.push({ ...attempt, kind: 'uncertain' });
          settle(`${texts.unconfirmed} ${FILE_ACTION_MESSAGES.checking}`, 'pending');
        }
        // A rename can change the file's extension, and with it whether the
        // asset can be a primary image: those regions are read with it.
        return readFile({
          regions: action.kind === 'rename'
            ? [ASSET_VIEWER_REFRESH_REGIONS.FILE, ASSET_VIEWER_REFRESH_REGIONS.PRIMARY_IMAGE]
            : [ASSET_VIEWER_REFRESH_REGIONS.FILE],
        });
      });
  });

  function reset() {
    // A GET still out reports for itself, whether or not the dialog is open,
    // and a standing hold keeps its warning (and Check again) across dismissal.
    if (state.pending || standing() || (state.owed.length > 0 && !state.openRead)) return;
    if (state.openRead) {
      settle(FILE_ACTION_MESSAGES.staleAfterClose, 'error');
      return;
    }
    removeStatusRetry(state, RETRY_KEY);
    settle('');
  }

  const api = {
    // In flight, unresolved and recovery-held all refuse the other actions.
    isPending: () => Boolean(state.pending || standing()),
    // The asset and its drafts outlast a dismissal while the hold stands
    // (nothing is saved or sent; the saved baselines are untouched).
    keepsDrafts: () => Boolean(standing() && !state.pending),
    // Why the other actions are refused, when it is not merely a POST in flight.
    holdMessage() {
      if (state.pending) return null;
      if (state.recovery) return FILE_ACTION_MESSAGES.heldRecovery;
      if (state.unresolved) return heldUnresolvedMessage(state.unresolved.plan);
      return null;
    },
    adoptInstalled: (result) => adoptInstalled(result),
    noteFailed: (result) => noteFailed(result),
    yieldStatus() {
      if (state.pending || standing() || state.owed.length > 0 || state.openRead) return;
      removeStatusRetry(state, RETRY_KEY);
      if (state.tone) settle('');
    },
    reset,
  };
  return api;
}

// ─── Delete (WP10A3-B) ────────────────────────────────────────────────────

const DELETE_FORM_SELECTOR = 'form.asset-delete-form';
const DELETE_STATE_KEY = '__creatorCrateAssetDelete';
const DELETE_STATUS_TEXT_ATTRIBUTE = 'data-asset-delete-status-text';
const DELETE_STATE_ATTRIBUTE = 'data-asset-delete-state';
const DELETE_RETRY_ATTRIBUTE = 'data-asset-delete-retry';
const DELETE_LINK_ATTRIBUTE = 'data-asset-delete-assets-link';
// On the Delete form while Delete cannot be used again: 'unresolved' (a lost
// answer: the request may still run), 'recovery' (the record remains but its
// file may not be in place), or the terminal 'deleted', 'cleanup' and
// 'missing'. Its button is held with aria-disabled.
const DELETE_HOLD_ATTRIBUTE = 'data-asset-delete-hold';
const DELETE_LINK_KEY = 'assetsLink';
const BOOK_SET_FORM_SELECTOR = 'form.asset-book-primary-image-set-form';
const BACK_LINK_SELECTOR = 'a.asset-viewer-back';

const DELETE_MESSAGES = Object.freeze({
  pending: 'The asset is being deleted. Wait for the result.',
  waitOther: 'Wait for the current change to finish, then delete the asset.',
  unresolved: 'The earlier deletion has not been confirmed, so this asset cannot be deleted again from this page.',
  recovery: 'Delete is unavailable until the project folder has been inspected. Reload the page to try again.',
  gone: 'This asset no longer exists. Go to Project Assets to continue.',
  wrongTarget: 'This Delete form does not match the asset shown. Reload the page and try again.',
  unconfirmed: 'The deletion could not be confirmed.',
  checking: 'Checking whether the asset still exists…',
  stillListed: 'The asset is still listed in this project, but the earlier Delete request may still run or may have left its file needing recovery. Nothing will be sent again by itself.',
  heldUnresolved: 'This asset cannot be changed from this page while the earlier deletion is unconfirmed. Use Check again, or reload the page once that request can no longer be running.',
  heldRecovery: 'This asset cannot be changed from this page until the project folder has been inspected. Reload the page to try again.',
  checkFailed: 'The asset could not be checked.',
  goneUnconfirmed: 'This asset no longer exists in this project, but CreatorCrate cannot tell whether your request removed it or whether its file was fully removed from the project folder.',
  missingNotByThis: 'This Delete request did not remove it.',
  draftsKept: 'Your unsaved changes were kept.',
  nothingDeleted: 'Nothing was deleted.',
  deletedFallback: 'The asset was deleted.',
  opening: 'Opening Project Assets…',
  cleanupFallback: 'The asset was deleted from CreatorCrate, but its file could not be fully removed. Inspect the project folder before scanning.',
  refusedFallback: 'The asset could not be deleted.',
  goToAssets: 'Go to Project Assets',
});

function joinList(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

// What the open Edit Asset dialog holds that is not saved: each control is
// compared with the saved value the page shows, never with what was rendered.
function unsavedDraftLabels(dialog) {
  const labels = [];
  const tagForm = dialog.querySelector(TAG_SAVE_FORM_SELECTOR);
  if (tagForm && !sameSet(currentSelection(tagForm), confirmedSelection(tagForm))) labels.push('tag selection');
  const book = dialog.querySelector(BOOK_SET_FORM_SELECTOR)?.querySelector('select[name="bookId"]');
  if (book && String(book.value ?? '') !== '') labels.push('Book choice');
  const rename = dialog.querySelector(RENAME_INPUT_SELECTOR);
  if (rename && rename.hasAttribute(CONFIRMED_VALUE_ATTRIBUTE)
    && String(rename.value ?? '') !== rename.getAttribute(CONFIRMED_VALUE_ATTRIBUTE)) labels.push('new filename');
  const move = dialog.querySelector(MOVE_SELECT_SELECTOR);
  if (move && move.hasAttribute(CONFIRMED_VALUE_ATTRIBUTE)
    && String(move.value ?? '') !== move.getAttribute(CONFIRMED_VALUE_ATTRIBUTE)) labels.push('move destination');
  return labels;
}

function deletedAssetName(dialog) {
  const document = dialog.ownerDocument;
  return assetViewerFileState(document)?.filename
    || dialog.querySelector(RENAME_INPUT_SELECTOR)?.getAttribute(CONFIRMED_VALUE_ATTRIBUTE)
    || '';
}

// The shared confirmation's wording, asked for at the moment Delete is used.
function deleteConfirmation(dialog) {
  const name = deletedAssetName(dialog);
  const drafts = unsavedDraftLabels(dialog);
  const base = `Delete ${name ? quoted(name) : 'this asset'} from this project? Its file will be permanently deleted from disk and cannot be restored through CreatorCrate.`;
  if (drafts.length === 0) return { title: 'Delete asset?', message: base, confirmLabel: 'Delete asset' };
  return {
    title: 'Delete asset with unsaved changes?',
    message: `${base} Your unsaved Edit Asset changes (${joinList(drafts)}) will not be saved: they are kept if you cancel or the asset is not deleted, and lost if it is deleted.`,
    confirmLabel: 'Delete asset',
    cancelLabel: 'Keep editing',
  };
}

// A Project Assets URL of this project on this origin, as a path and query.
function validAssetsUrl(windowObject, candidate, projectId) {
  if (typeof candidate !== 'string' || !candidate.startsWith('/') || candidate.startsWith('//')
    || /[\\\s]/.test(candidate)) return null;
  try {
    const URLConstructor = windowObject.URL || globalThis.URL;
    const base = new URLConstructor(windowObject.location.href);
    const url = new URLConstructor(candidate, base);
    if (url.origin !== base.origin || url.pathname !== `/projects/${projectId}/assets` || url.hash) return null;
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

/**
 * Edit Asset's Delete form deletes in place up to the moment the asset is gone.
 *
 *  - The shared confirmation (confirm-dialog.js) opens over the open Edit
 *    Asset dialog, naming the asset and any unsaved Edit Asset changes, which
 *    are never saved by Delete. Cancel, Escape and the backdrop send nothing.
 *    The form carries data-confirm-submit-required, so requestSubmit and Enter
 *    go through the same confirmation; only its replay reaches this handler,
 *    which sends one POST (Accept: application/json) per confirmation.
 *  - While another Edit Asset action is pending, Delete is refused here before
 *    the confirmation opens, never queued. While Delete is pending, unresolved,
 *    in recovery or terminal, the other actions are refused by the coordinator.
 *  - A refusal, or a failure the service rolled back, keeps the document, the
 *    media and every draft. Only a server-confirmed deletion leaves the page:
 *    the viewer is retired (no read can install details of the deleted asset)
 *    and the page is replaced once by the server's Project Assets URL.
 *  - A record deleted with its file left in the deletion staging folder is
 *    reported as such, with a link to Project Assets; nothing is sent again.
 *  - A lost or unreadable answer is never resubmitted, and only the answer of
 *    the Delete request itself releases its hold. A GET of the page (Check
 *    again, or any other action's read) reports whether the asset is listed
 *    now, which is not proof of what the lost request did or will still do: a
 *    listed asset keeps every Edit Asset action refused on this page, and a 404
 *    retires the page without an automatic navigation.
 */
function enhanceAssetDelete(dialog, appDialogState, coordinator) {
  const form = dialog.querySelector(DELETE_FORM_SELECTOR);
  if (!form || isEnhancementBound(form, 'assetDeleteBound')) return null;
  markEnhancementBound(form, 'assetDeleteBound');

  const document = dialog.ownerDocument;
  const windowObject = document.defaultView || globalThis;
  const button = Array.from(form.querySelectorAll('button')).find((control) => control.hasAttribute('data-confirm'))
    || form.querySelector('button');
  const state = {
    pending: null,
    attempt: 0,
    // The POST's answer was lost or unreadable. The request may still run on
    // the server, so no read releases this: it ends only when the page is
    // retired (the asset was observed missing) or reloaded.
    unresolved: false,
    // The record remains, but the service could not restore the file it staged.
    recovery: false,
    // 'deleted' | 'cleanup' | 'missing': the asset is gone; the page is retired.
    terminal: null,
    navigated: false,
    tone: null,
    settledMessage: '',
    [RETRY_KEY]: null,
    [DELETE_LINK_KEY]: null,
  };
  dialog[DELETE_STATE_KEY] = state;
  let unfreeze = null;

  const canSubmitInPlace = () => typeof windowObject.fetch === 'function'
    && typeof windowObject.FormData === 'function'
    && typeof windowObject.URLSearchParams === 'function';

  function statusText(create) {
    const status = dialog.querySelector(DIALOG_STATUS_SELECTOR);
    if (!status) return { status: null, text: null };
    let text = status.querySelector(`[${DELETE_STATUS_TEXT_ATTRIBUTE}]`);
    if (!text && create) {
      text = status.ownerDocument.createElement('span');
      text.setAttribute(DELETE_STATUS_TEXT_ATTRIBUTE, '');
      status.appendChild(text);
    }
    return { status, text };
  }

  function setStatus(message, tone = null) {
    const { status, text } = statusText(Boolean(message));
    if (!status) return;
    if (text) text.textContent = message || '';
    state.tone = message ? tone : null;
    if (message && tone) status.setAttribute(DELETE_STATE_ATTRIBUTE, tone);
    else status.removeAttribute(DELETE_STATE_ATTRIBUTE);
  }

  function settle(message, tone) {
    state.settledMessage = message;
    setStatus(message, tone);
  }

  function removeLink() {
    state[DELETE_LINK_KEY]?.remove?.();
    state[DELETE_LINK_KEY] = null;
  }

  // A link the user follows: never followed by itself, except after a
  // server-confirmed deletion (terminate with navigate).
  function showLink(href) {
    removeLink();
    const { status } = statusText(true);
    if (!status || !href) return null;
    const link = document.createElement('a');
    link.setAttribute('href', href);
    link.setAttribute(DELETE_LINK_ATTRIBUTE, '');
    link.className = 'button button-secondary';
    link.textContent = DELETE_MESSAGES.goToAssets;
    status.appendChild(link);
    state[DELETE_LINK_KEY] = link;
    return link;
  }

  function offerCheck(focusResult) {
    const { status } = statusText(true);
    const retry = showStatusRetry({
      state,
      status,
      attribute: DELETE_RETRY_ATTRIBUTE,
      key: RETRY_KEY,
      label: 'Check again',
      onRetry: ({ wasFocused }) => {
        setStatus(`${DELETE_MESSAGES.unconfirmed} ${DELETE_MESSAGES.checking}`, 'pending');
        return readAfterDelete('check', { focusResult: wasFocused });
      },
    });
    if (focusResult) retry?.focus?.();
    return retry;
  }

  function hold(value) {
    form.setAttribute(DELETE_HOLD_ATTRIBUTE, value);
    button?.setAttribute('aria-disabled', 'true');
  }

  // The server-rendered way back to this project's assets, with its context.
  function fallbackAssetsUrl(projectId) {
    return validAssetsUrl(windowObject, document.querySelector(BACK_LINK_SELECTOR)?.getAttribute('href'), projectId)
      || `/projects/${projectId}/assets`;
  }

  function refusal() {
    if (state.pending) return DELETE_MESSAGES.pending;
    if (state.terminal) return DELETE_MESSAGES.gone;
    if (state.unresolved) return DELETE_MESSAGES.unresolved;
    if (state.recovery) return DELETE_MESSAGES.recovery;
    // Another action's standing hold (an unconfirmed Rename or Move) says why.
    if (coordinator.otherPending(api)) return coordinator.holdMessage(api) || DELETE_MESSAGES.waitOther;
    return null;
  }

  function noteRefusal(message) {
    const base = state.settledMessage || '';
    setStatus(base.endsWith(message) ? base : `${base} ${message}`.trim(), state.tone || 'pending');
  }

  // The POST has settled without removing the asset: the dialog thaws, and the
  // focus it held returns to the control the user left.
  function release() {
    state.pending = null;
    form.removeAttribute('aria-busy');
    const thaw = unfreeze;
    unfreeze = null;
    thaw?.();
  }

  // The asset is gone. The dialog stays frozen, every Edit Asset action is
  // refused, and the viewer can never install a read again.
  function terminate(kind, message, href, { navigate = false } = {}) {
    state.pending = null;
    state.unresolved = false;
    state.terminal = kind;
    form.removeAttribute('aria-busy');
    retireAssetViewer(document);
    removeStatusRetry(state, RETRY_KEY);
    hold(kind);
    if (!unfreeze) unfreeze = freezeAppDialog(appDialogState);
    settle(message, kind === 'deleted' ? 'saved' : 'error');
    const link = showLink(href);
    if (navigate && href && !state.navigated) {
      state.navigated = true;
      const { location } = windowObject;
      if (typeof location?.replace === 'function') location.replace(href);
      else location?.assign?.(href);
      return;
    }
    link?.focus?.({ preventScroll: true });
  }

  // A read found the asset listed: an observation only. The lost request may
  // not have run yet, so the hold stays and Check again stays offered.
  function noteStillListed(focusResult = false) {
    settle(`${DELETE_MESSAGES.unconfirmed} ${DELETE_MESSAGES.stillListed} ${DELETE_MESSAGES.draftsKept}`, 'uncertain');
    offerCheck(focusResult);
  }

  function resolveGone(projectId) {
    terminate('missing', `${DELETE_MESSAGES.unconfirmed} ${DELETE_MESSAGES.goneUnconfirmed}`, fallbackAssetsUrl(projectId));
  }

  // GET only. kind: 'check' reports on an unresolved Delete; 'recovery' shows
  // what the records hold now; 'settle' installs regions another action is
  // still owed after this Delete superseded its read.
  function readAfterDelete(kind, { focusResult = false } = {}) {
    removeStatusRetry(state, RETRY_KEY);
    const identity = assetViewerIdentity(document);
    return refreshAssetViewer(document, {
      ...(identity || {}),
      regions: [ASSET_VIEWER_REFRESH_REGIONS.FILE],
    }).then((result) => {
      if (state.pending || state.terminal) return result;
      if (result.status === ASSET_VIEWER_REFRESH_STATUS.SUPERSEDED) {
        // Another read owns the page now and settles this one through the coordinator.
        return result;
      }
      if (result.status === ASSET_VIEWER_REFRESH_STATUS.INSTALLED) {
        coordinator.installed(result, api);
        if (kind === 'check' && state.unresolved) noteStillListed(focusResult);
        return result;
      }
      if (result.status === ASSET_VIEWER_REFRESH_STATUS.MISSING) {
        coordinator.failed(result, api);
        if (kind === 'check' && state.unresolved) resolveGone(identity?.projectId);
        else terminate('missing', `${state.settledMessage} ${DELETE_MESSAGES.gone}`.trim(), fallbackAssetsUrl(identity?.projectId));
        return result;
      }
      if (result.status === ASSET_VIEWER_REFRESH_STATUS.FAILED) coordinator.failed(result, api);
      if (kind === 'check' && state.unresolved) {
        settle(`${DELETE_MESSAGES.unconfirmed} ${DELETE_MESSAGES.checkFailed} ${DELETE_MESSAGES.draftsKept}`, 'error');
        offerCheck(focusResult);
      }
      return result;
    });
  }

  function classify(response, payload, identity) {
    const sameAsset = Boolean(payload)
      && String(payload.projectId) === identity.projectId
      && String(payload.assetId) === identity.assetId;
    if (response?.ok && payload?.status === 'success' && payload.outcome === 'deleted' && sameAsset
      && Array.isArray(payload.deletedAssetIds) && payload.deletedAssetIds.map(String).includes(identity.assetId)) {
      return 'deleted';
    }
    if (payload?.status === 'error' && response && !response.ok) {
      // The server's statement that the record is gone but its file is not.
      if (payload.outcome === 'deleted-cleanup-incomplete' && payload.assetDeleted === true && sameAsset) return 'cleanup';
      // The record remains; its file may not be where the record says.
      if (payload.outcome === 'recovery-required') return 'recovery';
      // Refused before anything was touched: the route's 4xx answers (and
      // CSRF/authentication, which name no outcome).
      if (response.status >= 400 && response.status < 500
        && (payload.outcome === undefined || payload.outcome === 'refused')) {
        return response.status === 404 && (payload.code === 'ASSET_NOT_FOUND' || payload.code === 'PROJECT_NOT_FOUND')
          ? 'missing'
          : 'refused';
      }
      // Failed before anything was removed, or restored and rolled back.
      if (response.status >= 500 && payload.outcome === 'failed') return 'failed';
    }
    // Anything else — a lost answer, an unreadable body, an 'unknown' 500 — may
    // have deleted the asset.
    return 'uncertain';
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

  if (button) describeAppConfirmation(button, () => deleteConfirmation(dialog));

  dialog.addEventListener('submit', (event) => {
    if (event.target !== form || event.defaultPrevented || !canSubmitInPlace()) return;
    const identity = assetViewerIdentity(document);
    if (!identity) return;
    event.preventDefault();
    const refused = refusal();
    if (refused) {
      noteRefusal(refused);
      return;
    }
    // The form must delete the asset this page shows, and nothing else.
    if (form.getAttribute('action') !== `/projects/${identity.projectId}/assets/${identity.assetId}/delete`) {
      settle(DELETE_MESSAGES.wrongTarget, 'error');
      return;
    }

    // Captured before the dialog freezes: the request holds exactly this form.
    const body = new windowObject.URLSearchParams(new windowObject.FormData(form));
    const name = deletedAssetName(dialog);
    state.attempt += 1;
    const attempt = { id: state.attempt, identity };
    state.pending = attempt;
    // Any read still out predates this Delete and must not install.
    supersedeAssetViewerRefresh(document);
    removeStatusRetry(state, RETRY_KEY);
    removeLink();
    coordinator.yieldStatus(api);
    form.setAttribute('aria-busy', 'true');
    settle(`Deleting ${name ? quoted(name) : 'the asset'}…`, 'pending');
    // The confirmation that replayed this submit may still hold the focus; the
    // freeze keeps it on this dialog instead.
    if (!dialog.contains(document.activeElement)) button?.focus?.({ preventScroll: true });
    unfreeze = freezeAppDialog(appDialogState);

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
      .then(({ response, payload }) => ({ outcome: classify(response, payload, identity), payload }))
      .catch(() => ({ outcome: 'uncertain', payload: null }))
      .then(({ outcome, payload }) => {
        if (state.pending !== attempt) return;
        const { projectId } = identity;
        const message = typeof payload?.message === 'string' && payload.message ? payload.message : '';

        if (outcome === 'deleted') {
          const href = validAssetsUrl(windowObject, payload.assetsUrl, projectId) || fallbackAssetsUrl(projectId);
          terminate('deleted', `${message || DELETE_MESSAGES.deletedFallback} ${DELETE_MESSAGES.opening}`, href, { navigate: true });
          return;
        }
        if (outcome === 'cleanup') {
          const href = validAssetsUrl(windowObject, payload.assetsUrl, projectId) || fallbackAssetsUrl(projectId);
          terminate('cleanup', message || DELETE_MESSAGES.cleanupFallback, href);
          return;
        }
        if (outcome === 'missing') {
          terminate('missing', `${message || DELETE_MESSAGES.gone} ${DELETE_MESSAGES.missingNotByThis}`, fallbackAssetsUrl(projectId));
          return;
        }

        release();
        if (outcome === 'refused' || outcome === 'failed') {
          const nothing = outcome === 'refused' ? ` ${DELETE_MESSAGES.nothingDeleted}` : '';
          settle(`${message || DELETE_MESSAGES.refusedFallback}${nothing} ${DELETE_MESSAGES.draftsKept}`, 'error');
          // A read this Delete superseded is still owed to another action; a
          // stale refusal (the asset changed after this page showed it) reads
          // the asset as it is now, so the page and its reviewed state match
          // what a new, separately confirmed Delete would remove. Nothing is
          // sent again by itself.
          if (assetViewerRefreshOwed(document) || payload?.code === 'DELETE_STALE_ASSET') readAfterDelete('settle');
          return;
        }
        if (outcome === 'recovery') {
          state.recovery = true;
          hold('recovery');
          settle(`${message} ${DELETE_MESSAGES.draftsKept}`.trim(), 'error');
          readAfterDelete('recovery');
          return;
        }
        state.unresolved = true;
        hold('unresolved');
        settle(`${DELETE_MESSAGES.unconfirmed} ${DELETE_MESSAGES.checking}`, 'pending');
        readAfterDelete('check');
      });
  });

  // A Delete in flight may already have removed the asset: the dialog waits
  // for its answer, so no draft is reset before the outcome is known.
  const previousBeforeClose = appDialogState.beforeClose;
  appDialogState.beforeClose = (context) => {
    if (state.pending) return false;
    return typeof previousBeforeClose === 'function' ? previousBeforeClose(context) : true;
  };

  function reset() {
    if (state.pending || state.unresolved || state.recovery || state.terminal) return;
    removeStatusRetry(state, RETRY_KEY);
    removeLink();
    settle('');
  }

  const api = {
    // Pending, unresolved, recovery and terminal all refuse the other actions.
    isPending: () => Boolean(state.pending || state.unresolved || state.recovery || state.terminal),
    // An unconfirmed or recovery-held Delete keeps the asset, and with it the
    // Edit Asset drafts the user was told are kept: dismissing the dialog then
    // leaves them in place (they are still not saved, and still refused).
    keepsDrafts: () => Boolean((state.unresolved || state.recovery) && !state.terminal && !state.pending),
    // Why the other actions are refused, when it is not merely a POST in flight.
    holdMessage() {
      if (state.pending) return null;
      if (state.terminal) return DELETE_MESSAGES.gone;
      if (state.unresolved) return DELETE_MESSAGES.heldUnresolved;
      if (state.recovery) return DELETE_MESSAGES.heldRecovery;
      return null;
    },
    // Another action's GET installed the page: the asset is listed now, which
    // says nothing about whether the lost Delete request has run. Still held.
    adoptInstalled(result) {
      if (state.pending || state.terminal || !state.unresolved || !result?.file) return;
      noteStillListed(false);
    },
    noteFailed(result) {
      if (state.pending || state.terminal || !state.unresolved) return;
      if (result.status === ASSET_VIEWER_REFRESH_STATUS.MISSING) {
        resolveGone(assetViewerIdentity(document)?.projectId);
        return;
      }
      if (result.status === ASSET_VIEWER_REFRESH_STATUS.FAILED && !state[RETRY_KEY]) {
        settle(`${DELETE_MESSAGES.unconfirmed} ${DELETE_MESSAGES.checkFailed} ${DELETE_MESSAGES.draftsKept}`, 'error');
        offerCheck(false);
      }
    },
    yieldStatus() {
      if (state.pending || state.unresolved || state.recovery || state.terminal) return;
      removeStatusRetry(state, RETRY_KEY);
      removeLink();
      if (state.tone) settle('');
    },
    reset,
  };
  return api;
}

// The Edit Asset actions share one live status region and the page's refresh.
// Only one of their POSTs is out at a time (the dialog is frozen meanwhile), and
// whichever action's GET installs the page settles the others' owed regions.
function createAssetEditCoordinator() {
  const modules = [];
  return {
    add(module) { if (module) modules.push(module); },
    otherPending: (self) => modules.some((module) => module !== self && module.isPending()),
    // A standing hold of another module (an unconfirmed Delete, Rename or Move), worded for the user.
    holdMessage: (self) => modules
      .map((module) => (module !== self && typeof module.holdMessage === 'function' ? module.holdMessage() : null))
      .find(Boolean) || null,
    installed: (result, self) => modules.forEach((module) => module !== self && module.adoptInstalled(result)),
    failed: (result, self) => modules.forEach((module) => module !== self && module.noteFailed(result)),
    yieldStatus: (self) => modules.forEach((module) => module !== self && module.yieldStatus()),
    reset: () => modules.forEach((module) => module.reset()),
    keepsDrafts: () => modules.some((module) => typeof module.keepsDrafts === 'function' && module.keepsDrafts()),
  };
}

export function enhanceAssetEditDialog(scope = globalThis.document) {
  const dialog = scope?.getElementById?.('asset-edit-dialog');
  const state = dialog?.__creatorCrateAppDialogState;
  if (!state || isEnhancementBound(dialog, 'assetEditResetBound')) return;
  markEnhancementBound(dialog, 'assetEditResetBound');
  const coordinator = createAssetEditCoordinator();
  coordinator.add(enhanceAssetTagSave(dialog, state, coordinator));
  coordinator.add(enhancePrimaryImageActions(dialog, state, coordinator));
  coordinator.add(enhanceAssetFileActions(dialog, state, coordinator));
  coordinator.add(enhanceAssetDelete(dialog, state, coordinator));
  const resetTagSaveStatus = coordinator.reset;

  // Every dismissal (Escape, Close, backdrop) ends here. Ordinarily it discards
  // the drafts and shows the saved values again. While a Tag Save, Delete, Rename or Move
  // is unconfirmed or needs recovery, the drafts stay exactly as they are (nothing is saved or
  // sent, and the saved baselines are untouched): the dialog still belongs to
  // this asset, and its warning says they were kept.
  function resetDrafts() {
    dialog.querySelectorAll('form').forEach((form) => form.reset());

    const filename = dialog.querySelector('#rename-filename');
    if (filename) filename.value = filename.getAttribute('data-confirmed-value') ?? filename.defaultValue;

    const destination = dialog.querySelector('#move-destination');
    if (destination) destination.value = destination.getAttribute('data-confirmed-value') ?? destination.value;

    const tags = dialog.querySelector('#asset-tags-form');
    if (tags) {
      const confirmed = new Set((dialog.querySelector('#asset-edit-form')?.getAttribute('data-confirmed-tag-ids') || '')
        .split(',').filter(Boolean));
      tags.querySelectorAll('input[type="checkbox"]').forEach((option) => {
        option.checked = confirmed.has(option.value);
      });
      initializeCreatorCrateDropdown(tags);
    }
  }

  const previousOnClose = state.onClose;
  state.onClose = (...args) => {
    if (!coordinator.keepsDrafts()) resetDrafts();
    resetTagSaveStatus?.();

    dialog.querySelectorAll('select').forEach(syncCreatorCrateDropdownFromNative);
    dialog.querySelectorAll('details').forEach((details) => {
      details.open = false;
      updateAssetViewerFilterDisclosureState(details);
    });
    previousOnClose?.(...args);
  };
}
