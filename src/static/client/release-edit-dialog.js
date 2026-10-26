import { isEnhancementBound, markEnhancementBound, setHidden } from './dom.js';
import { openAppDialogById, setAppDialogBaseline } from './app-dialogs.js';
import { initializeCreatorCrateDropdown } from './dropdowns.js';
import { dismissActiveGridInfoCard } from './info-cards.js';

// One Edit Release dialog per page, populated from the JSON edit model
// (GET /releases/:id/edit) and saved through the shared async dialog binder.
// Edit actions name their release with data-release-edit-id and keep their
// canonical /releases/:id?edit=1 href, so a modified click (new tab) lands on
// Release Detail's deep link. That deep link marks the closed dialog with the
// requested release, which is then opened through the same load as any Edit
// action.
export const RELEASE_EDIT_DIALOG_ID = 'release-edit-dialog';
// Dispatched on the document only after an acknowledged successful save.
// Hosts refresh their own views from it; a refresh failure is the host's to
// report, since the release itself is already saved.
export const RELEASE_EDIT_SAVED_EVENT = 'release-edit-saved';

const EDIT_TRIGGER_SELECTOR = '[data-release-edit-id]';
const DEEP_LINK_ATTRIBUTE = 'data-release-edit-deep-link';
const PLATFORM_FIELD_SELECTOR = '[data-dialog-field="selectedPlatforms"]';
const LOAD_FAILURE_MESSAGE = 'The release could not be loaded.';
const LOAD_NETWORK_FAILURE_MESSAGE = 'Could not load the release. Check your connection and try again.';
const LINK_CHECKING_MESSAGE = 'Checking whether the Release link changed in the Posting Helper…';
const LINK_CONFLICT_SUBMIT_MESSAGE = 'Not saved. The saved Release link changed after this form was loaded. Use the saved Release link, then save again.';
const LINK_CHECK_FAILED_MESSAGE = 'Not saved. Could not check whether the Release link changed in the Posting Helper. Your changes are kept. Check the Release link again, then save.';
const LINK_UNVERIFIED_MESSAGE = 'Could not check whether the saved Release link changed after this form was loaded, for example in the Posting Helper. Saving is paused until it is checked; your unsaved changes are kept.';
const LINK_SIGNED_OUT_MESSAGE = 'Could not check the saved Release link because you are signed out. Sign in again in another tab, then check the Release link again. Your unsaved changes are kept.';
const LINK_RECHECKING_MESSAGE = 'Checking the saved Release link…';
const LINK_RESOLVED_MESSAGE = 'The form now uses the saved Release link. Your other unsaved changes were kept.';
const LINK_CONFLICT_CODE = 'RELEASE_LINK_CONFLICT';
const controllers = new WeakMap();
// Orders form loads against Release link checks: a check only judges a form
// that was loaded before the check began.
let linkSequence = 0;

function setStatus(dialog, message, error = false) {
  const status = dialog.querySelector('[data-dialog-status]');
  if (status) status.textContent = message || '';
  if (message) dialog.setAttribute('data-dialog-state', error ? 'error' : 'pending');
  else dialog.removeAttribute('data-dialog-state');
}

// Platform choices depend on the release (saved platforms that are no longer
// configured stay selectable), so each load replaces the rendered option rows
// with the same markup the dropdown macro produces.
function renderPlatformOptions(form, options) {
  const dropdown = form.querySelector(`${PLATFORM_FIELD_SELECTOR} [data-cc-dropdown]`);
  const panel = dropdown?.querySelector('.asset-filter-multiselect-panel');
  if (!panel) return;
  const document = form.ownerDocument;
  panel.querySelectorAll('.asset-filter-multiselect-option, .asset-filter-multiselect-empty')
    .forEach((row) => row.remove());
  panel.append(...options.map((option, index) => {
    const row = document.createElement('div');
    row.className = 'asset-filter-multiselect-option';
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.id = `${dropdown.id}-option-${index + 1}`;
    input.name = 'selectedPlatforms';
    input.type = 'checkbox';
    input.value = String(option.value);
    if (option.configured === false) input.setAttribute('data-release-platform-unconfigured', '');
    label.htmlFor = input.id;
    const text = document.createElement('span');
    text.textContent = option.label || String(option.value);
    label.append(input, text);
    row.append(label);
    return row;
  }));
  const sizer = dropdown.querySelector('.asset-filter-multiselect-summary-width');
  if (sizer) {
    const countLabel = dropdown.getAttribute('data-cc-dropdown-count-label') || 'items';
    sizer.replaceChildren(...[...options.map((option) => option.label || String(option.value)),
      `${options.length} ${countLabel} selected`].map((text) => {
      const span = document.createElement('span');
      span.textContent = text;
      return span;
    }));
  }
  initializeCreatorCrateDropdown(dropdown);
}

// Archive and Delete keep their own HTML forms and confirmations; only their
// target and availability follow the loaded release.
function applyReleaseActions(dialog, payload) {
  for (const kind of ['archive', 'delete']) {
    const disclosure = dialog.querySelector(`[data-release-edit-action="${kind}"]`);
    if (!disclosure) continue;
    const url = payload.actions?.[kind];
    const eligible = kind === 'archive' ? payload.eligibility?.archivable : payload.eligibility?.deletable;
    disclosure.open = false;
    setHidden(disclosure, !(eligible && url));
    const actionForm = disclosure.querySelector('form');
    if (actionForm) actionForm.setAttribute('action', eligible && url ? url : '');
  }
}

function releaseIdOf(value) {
  const id = String(value ?? '').trim();
  return /^[1-9]\d*$/.test(id) ? id : null;
}

function createController(document, dialog) {
  const dialogState = dialog.__creatorCrateAppDialogState;
  const form = dialogState.form;
  const body = dialog.querySelector('.app-dialog-body');
  const submitControls = () => Array.from(dialog.querySelectorAll('[data-dialog-submit]'));
  const controller = {
    generation: 0,
    abort: null,
    // The release the form currently holds and may save; null while loading
    // or after a failed load, so nothing can be written to a stale target.
    releaseId: null,
    // Release link guard. The Posting Helper saves the Release link outside
    // this dialog, and a save sends every field, so a form holding an older
    // link must not save it over a newer one. loadedLink is the link the
    // form loaded (or adopted) and is sent unchanged as expectedPatreonUrl,
    // which the server checks atomically with the save; linkConflict is a
    // newer saved link it has not adopted; linkUnverified means a check
    // failed, so the form cannot be shown to be current.
    loadedLink: null,
    loadSequence: 0,
    linkCheck: null,
    linkConflict: null,
    linkUnverified: false,
    heldSubmit: null,
  };
  const conflictNotice = dialog.querySelector('[data-release-edit-link-conflict]');
  const conflictText = conflictNotice?.querySelector('[data-release-edit-link-conflict-text]');
  const conflictResolve = conflictNotice?.querySelector('[data-release-edit-link-conflict-resolve]');
  const recheck = conflictNotice?.querySelector('[data-release-edit-link-recheck]');
  const linkField = () => form.querySelector('[name="patreonUrl"]');
  const expectedLinkField = () => form.querySelector('[name="expectedPatreonUrl"]');

  const setReady = (ready) => {
    setHidden(body, !ready);
    if (ready) form.removeAttribute('aria-busy');
    else form.setAttribute('aria-busy', 'true');
    submitControls().forEach((control) => { control.disabled = !ready; });
  };

  const clearLinkGuard = () => {
    controller.linkConflict = null;
    controller.linkUnverified = false;
    controller.heldSubmit = null;
    setHidden(conflictNotice, true);
  };

  // The exact stored value (never trimmed) is the save's concurrency token.
  const setExpectedLink = (link) => {
    controller.loadedLink = link;
    const field = expectedLinkField();
    if (field) field.value = link;
  };

  // The saved link becomes this form's baseline without touching any field.
  const adoptLink = (link) => {
    setExpectedLink(link);
    if (dialogState.savedValues) dialogState.savedValues = { ...dialogState.savedValues, patreonUrl: link };
  };

  const showNoticeAction = (action) => {
    setHidden(conflictResolve, action !== 'resolve');
    setHidden(recheck, action !== 'recheck');
  };

  const showLinkConflict = (link) => {
    controller.linkConflict = link;
    controller.linkUnverified = false;
    const entered = (linkField()?.value ?? '') !== controller.loadedLink;
    showNoticeAction('resolve');
    // Revealed before its text is set, so the alert is announced.
    setHidden(conflictNotice, false);
    if (conflictText) {
      conflictText.textContent = [
        link
          ? `The saved Release link changed after this form was loaded, for example in the Posting Helper. It is now ${link}.`
          : 'The saved Release link was removed after this form was loaded, for example in the Posting Helper.',
        'Saving is paused so this form cannot replace it.',
        entered
          ? 'Using the saved Release link replaces the link you entered; your other unsaved changes are kept.'
          : 'Using the saved Release link keeps your other unsaved changes.',
      ].join(' ');
    }
  };

  // A known newer link stays the more specific problem.
  const showLinkUnverified = (message) => {
    if (controller.linkConflict !== null) return;
    controller.linkUnverified = true;
    showNoticeAction('recheck');
    setHidden(conflictNotice, false);
    if (conflictText) conflictText.textContent = message;
  };

  const observeLink = (link) => {
    if (link === controller.loadedLink) {
      clearLinkGuard();
      return;
    }
    // A form already holding the saved link would not replace it.
    if ((linkField()?.value ?? '') === link) {
      adoptLink(link);
      clearLinkGuard();
      return;
    }
    if (link !== controller.linkConflict) showLinkConflict(link);
  };

  // A check started after this form loaded can show whether it is stale.
  const checkJudgesForm = (check) => Boolean(check && dialog.open
    && controller.releaseId === check.releaseId && controller.loadSequence < check.sequence);

  controller.beginLinkCheck = (releaseId) => {
    linkSequence += 1;
    controller.linkCheck = { releaseId: String(releaseId), sequence: linkSequence };
    return controller.linkCheck;
  };

  // result: { releaseLink } from an adopted render, or { failed: true }
  // (with signedOut when the session expired).
  controller.finishLinkCheck = (check, result) => {
    if (!check || controller.linkCheck !== check) return;
    controller.linkCheck = null;
    if (recheck) recheck.disabled = false;
    const held = controller.heldSubmit;
    controller.heldSubmit = null;
    if (!checkJudgesForm(check)) return;
    if (result?.failed || typeof result?.releaseLink !== 'string') {
      // Fails closed: saving stays paused until a check succeeds, and the
      // draft is left exactly as it is.
      showLinkUnverified(result?.signedOut ? LINK_SIGNED_OUT_MESSAGE : LINK_UNVERIFIED_MESSAGE);
      if (held) {
        setStatus(dialog, LINK_CHECK_FAILED_MESSAGE, true);
        if (controller.linkConflict === null) recheck?.focus?.();
        else conflictResolve?.focus?.();
      }
      return;
    }
    observeLink(result.releaseLink);
    if (!held) return;
    if (controller.linkConflict !== null) {
      setStatus(dialog, LINK_CONFLICT_SUBMIT_MESSAGE, true);
      conflictResolve?.focus?.();
      return;
    }
    setStatus(dialog, '');
    const submitter = held.submitter?.isConnected ? held.submitter : undefined;
    form.requestSubmit?.(submitter);
  };

  conflictResolve?.addEventListener('click', () => {
    const link = controller.linkConflict;
    if (link === null) return;
    const field = linkField();
    if (field) field.value = link;
    adoptLink(link);
    clearLinkGuard();
    setStatus(dialog, LINK_RESOLVED_MESSAGE);
    field?.focus?.();
  });

  // Re-reads the authoritative edit model, judged like any other check; only
  // its Release link is compared, so no field is changed.
  recheck?.addEventListener('click', () => {
    const releaseId = controller.releaseId;
    if (!releaseId || !dialog.open || checkJudgesForm(controller.linkCheck)) return;
    const check = controller.beginLinkCheck(releaseId);
    recheck.disabled = true;
    setStatus(dialog, LINK_RECHECKING_MESSAGE);
    const windowObject = document.defaultView || globalThis;
    Promise.resolve().then(() => windowObject.fetch(`/releases/${releaseId}/edit`, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    })).then(async (response) => {
      let payload = {};
      try { payload = await response.json(); } catch {}
      const link = payload?.values?.patreonUrl;
      if (response.ok && payload?.status === 'success' && String(payload.release?.id) === releaseId
        && typeof link === 'string') {
        return { releaseLink: link };
      }
      return { failed: true, signedOut: response.status === 401 || response.status === 403 };
    }).catch(() => ({ failed: true })).then((result) => {
      // A newer check, a dismissal or another release supersedes this one.
      const current = controller.linkCheck === check && checkJudgesForm(check);
      const held = controller.heldSubmit;
      controller.finishLinkCheck(check, result);
      if (!current) return;
      if (result.failed) {
        setStatus(dialog, result.signedOut ? LINK_SIGNED_OUT_MESSAGE : LINK_CHECK_FAILED_MESSAGE, true);
        if (controller.linkConflict === null) recheck.focus?.();
      } else if (!held) {
        // A held save reports its own outcome; otherwise clear "Checking".
        setStatus(dialog, '');
      }
    });
  });

  const cancelLoad = () => {
    controller.generation += 1;
    controller.abort?.abort();
    controller.abort = null;
  };

  const hydrate = (payload) => {
    form.setAttribute('action', payload.actions.update);
    const present = form.querySelector('input[name="selectedPlatformsPresent"]');
    if (present) {
      present.value = '1';
      present.disabled = false;
    }
    renderPlatformOptions(form, Array.isArray(payload.platformOptions) ? payload.platformOptions : []);
    applyReleaseActions(dialog, payload);
    // The complete editable model, so every save sends every field: the
    // server parser treats omitted fields as cleared.
    const values = payload.values || {};
    setAppDialogBaseline(document, RELEASE_EDIT_DIALOG_ID, {
      title: values.title ?? '',
      description: values.description ?? '',
      notes: values.notes ?? '',
      plannedDate: values.plannedDate ?? '',
      plannedTime: values.plannedTime ?? '',
      publishedDate: values.publishedDate ?? '',
      patreonUrl: values.patreonUrl ?? '',
      selectedPlatforms: Array.isArray(values.selectedPlatforms) ? values.selectedPlatforms : [],
    });
    controller.releaseId = String(payload.release.id);
    setExpectedLink(values.patreonUrl ?? '');
    clearLinkGuard();
  };

  controller.open = (releaseIdValue, { opener = null } = {}) => {
    const releaseId = releaseIdOf(releaseIdValue);
    // A pending save owns the form; an open dialog is already editing.
    if (!releaseId || dialogState.submitting || dialog.open) return false;
    cancelLoad();
    const generation = controller.generation;
    const abort = typeof AbortController === 'function' ? new AbortController() : null;
    controller.abort = abort;
    controller.releaseId = null;
    linkSequence += 1;
    controller.loadSequence = linkSequence;
    clearLinkGuard();
    setReady(false);
    openAppDialogById(document, RELEASE_EDIT_DIALOG_ID, opener);
    setStatus(dialog, 'Loading release…');

    const windowObject = document.defaultView || globalThis;
    Promise.resolve().then(() => windowObject.fetch(`/releases/${releaseId}/edit`, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: abort?.signal,
    })).then(async (response) => {
      let payload = {};
      try { payload = await response.json(); } catch {}
      return { response, payload };
    }).then(({ response, payload }) => {
      // A superseded or dismissed load never hydrates or reopens the dialog.
      if (generation !== controller.generation || !dialog.open) return;
      controller.abort = null;
      if (!response.ok || payload?.status !== 'success'
        || String(payload.release?.id) !== releaseId || !payload.actions?.update) {
        setStatus(dialog, payload?.message || LOAD_FAILURE_MESSAGE, true);
        return;
      }
      hydrate(payload);
      setReady(true);
    }).catch(() => {
      if (generation !== controller.generation || !dialog.open) return;
      controller.abort = null;
      setStatus(dialog, LOAD_NETWORK_FAILURE_MESSAGE, true);
    });
    return true;
  };

  // Dismissal cancels a pending load. A close event that arrives after a
  // rapid reopen finds the dialog open again and leaves the new load alone.
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    cancelLoad();
    clearLinkGuard();
  });

  // Only a hydrated form may submit (implicit submission included), and never
  // while its Release link is known to be stale or could not be checked. A
  // save made while a Release link check is running waits for it, then
  // continues only if the link was confirmed unchanged.
  dialog.addEventListener('submit', (event) => {
    if (event.target !== form) return;
    const checking = checkJudgesForm(controller.linkCheck);
    if (controller.releaseId && controller.linkConflict === null && !controller.linkUnverified && !checking) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!controller.releaseId) return;
    if (controller.linkConflict !== null) {
      setStatus(dialog, LINK_CONFLICT_SUBMIT_MESSAGE, true);
      conflictResolve?.focus?.();
      return;
    }
    if (checking) {
      controller.heldSubmit = { submitter: event.submitter ?? null };
      setStatus(dialog, LINK_CHECKING_MESSAGE);
      return;
    }
    setStatus(dialog, LINK_CHECK_FAILED_MESSAGE, true);
    recheck?.focus?.();
  }, true);

  // The server refused a save whose expected Release link was stale (it may
  // have changed after the last check). The draft is kept as the binder left
  // it; the newer link is shown and must be adopted explicitly.
  const previousFailure = dialogState.onFailedSubmit;
  dialogState.onFailedSubmit = (payload, response) => {
    previousFailure?.(payload, response);
    if (payload?.code !== LINK_CONFLICT_CODE || !dialog.open || !controller.releaseId) return;
    const link = typeof payload.currentReleaseLink === 'string' ? payload.currentReleaseLink : '';
    showLinkConflict(link);
    setStatus(dialog, LINK_CONFLICT_SUBMIT_MESSAGE, true);
    conflictResolve?.focus?.();
  };

  const previousSuccess = dialogState.onSuccessfulSubmit;
  dialogState.onSuccessfulSubmit = (payload) => {
    // The saved link is the baseline for any further save from this form.
    if (typeof payload?.values?.patreonUrl === 'string') setExpectedLink(payload.values.patreonUrl);
    const result = previousSuccess?.(payload);
    if (result === true) return true;
    const releaseId = String(payload?.release?.id ?? controller.releaseId);
    if (Array.isArray(payload?.platformOptions)) renderPlatformOptions(form, payload.platformOptions);
    if (payload?.actions) applyReleaseActions(dialog, payload);
    // After the binder records the saved values and closes the dialog.
    Promise.resolve().then(() => {
      document.dispatchEvent(new (document.defaultView || globalThis).CustomEvent(RELEASE_EDIT_SAVED_EVENT, {
        detail: { releaseId, release: payload?.release ?? null, values: payload?.values ?? null, payload },
      }));
    });
    return result;
  };

  return controller;
}

/**
 * Release link checks for the page's Edit Release dialog. Release Detail
 * begins one when it refreshes after the user returns from the Posting
 * Helper and finishes it with the Release link its refresh adopted
 * ({ releaseLink }) or { failed: true }. Saves made meanwhile wait for it.
 */
export function beginReleaseLinkCheck(document, releaseId) {
  const controller = controllers.get(document?.getElementById?.(RELEASE_EDIT_DIALOG_ID));
  return controller ? controller.beginLinkCheck(releaseId) : null;
}

export function finishReleaseLinkCheck(document, check, result) {
  if (!check) return;
  controllers.get(document?.getElementById?.(RELEASE_EDIT_DIALOG_ID))?.finishLinkCheck(check, result);
}

function editTriggerOpener(document, trigger) {
  // Edit actions inside an information card return focus to the title that
  // opened the card, since the card itself is dismissed.
  const cardId = trigger.closest('[data-calendar-info-card]')?.id;
  const cardTrigger = cardId
    ? document.querySelector(`[data-calendar-info-trigger][aria-controls="${CSS.escape(cardId)}"]`)
    : null;
  return cardTrigger || trigger;
}

/**
 * Binds the page's async Edit Release dialog and delegates every
 * data-release-edit-id action to it, including actions rendered later.
 * Returns the controller ({ open(releaseId, { opener }) }) or null when the
 * page has no async Edit Release dialog.
 */
export function enhanceReleaseEditDialog(scope = globalThis.document) {
  const document = scope?.nodeType === 9 ? scope : scope?.ownerDocument;
  const dialog = document?.getElementById?.(RELEASE_EDIT_DIALOG_ID);
  const form = dialog?.__creatorCrateAppDialogState?.form;
  if (!form || form.getAttribute('data-dialog-async') !== 'true') return null;
  if (controllers.has(dialog)) return controllers.get(dialog);
  const controller = createController(document, dialog);
  controllers.set(dialog, controller);

  if (!isEnhancementBound(document.documentElement, 'releaseEditTriggersBound')) {
    markEnhancementBound(document.documentElement, 'releaseEditTriggersBound');
    document.addEventListener('click', (event) => {
      if (event.defaultPrevented || event.button !== 0
        || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const trigger = event.target?.closest?.(EDIT_TRIGGER_SELECTOR);
      if (!trigger) return;
      event.preventDefault();
      const opener = editTriggerOpener(document, trigger);
      dismissActiveGridInfoCard();
      controller.open(trigger.getAttribute('data-release-edit-id'), { opener });
    });
  }

  // Release Detail's ?edit=1 deep link: the dialog was rendered closed, so it
  // loads, hydrates and opens exactly like a clicked Edit action.
  const deepLinkId = releaseIdOf(form.getAttribute(DEEP_LINK_ATTRIBUTE));
  form.removeAttribute(DEEP_LINK_ATTRIBUTE);
  if (deepLinkId) {
    controller.open(deepLinkId, {
      opener: document.querySelector(`${EDIT_TRIGGER_SELECTOR}[data-release-edit-id="${deepLinkId}"]`),
    });
  }
  return controller;
}
