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
const controllers = new WeakMap();

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
  };

  const setReady = (ready) => {
    setHidden(body, !ready);
    if (ready) form.removeAttribute('aria-busy');
    else form.setAttribute('aria-busy', 'true');
    submitControls().forEach((control) => { control.disabled = !ready; });
  };

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
  });

  // Only a hydrated form may submit (implicit submission included).
  dialog.addEventListener('submit', (event) => {
    if (event.target !== form || controller.releaseId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  const previousSuccess = dialogState.onSuccessfulSubmit;
  dialogState.onSuccessfulSubmit = (payload) => {
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
