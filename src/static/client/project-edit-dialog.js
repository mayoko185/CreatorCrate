import { isEnhancementBound, markEnhancementBound, setHidden } from './dom.js';
import { openAppDialogById, setAppDialogBaseline } from './app-dialogs.js';
import { initializeCreatorCrateDropdown } from './dropdowns.js';
import { dismissActiveGridInfoCard } from './info-cards.js';

// One Edit Project dialog per page, populated from the JSON edit model
// (GET /projects/:id/edit) and saved through the shared async dialog binder.
// Edit actions name their project with data-project-edit-id and keep their
// canonical /projects/:id/edit href, so a modified click (new tab) lands on
// Project Detail's deep link. A saved project leaves the user on the host
// page: the binder adopts the saved model, closes the dialog and shows its
// message in the page feedback, and the host refreshes its own content from
// PROJECT_EDIT_SAVED_EVENT.
export const PROJECT_EDIT_DIALOG_ID = 'project-edit-dialog';
// Dispatched on the document only after an acknowledged successful save.
// Hosts refresh their own views from it; a refresh failure is the host's to
// report, since the project itself is already saved.
export const PROJECT_EDIT_SAVED_EVENT = 'project-edit-saved';

const EDIT_TRIGGER_SELECTOR = '[data-project-edit-id]';
// The project whose values the dialog was rendered open with.
const LOADED_ID_ATTRIBUTE = 'data-project-edit-loaded-id';
const TAG_FIELD_SELECTOR = '[data-dialog-field="tagIds"]';
const LOADING_MESSAGE = 'Loading project…';
const LOAD_FAILURE_MESSAGE = 'The project could not be loaded.';
const LOAD_NETWORK_FAILURE_MESSAGE = 'Could not load the project. Check your connection and try again.';
const controllers = new WeakMap();

function setStatus(dialog, message, error = false) {
  const status = dialog.querySelector('[data-dialog-status]');
  if (status) status.textContent = message || '';
  if (message) dialog.setAttribute('data-dialog-state', error ? 'error' : 'pending');
  else dialog.removeAttribute('data-dialog-state');
}

function projectIdOf(value) {
  const id = String(value ?? '').trim();
  return /^[1-9]\d*$/.test(id) ? id : null;
}

function localLocation(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : null;
}

// The tag list is shared by every project but may have changed since the
// host rendered, so each load replaces the rendered option rows with the
// same markup the dropdown macro produces.
function renderTagOptions(form, options) {
  const dropdown = form.querySelector(`${TAG_FIELD_SELECTOR} [data-cc-dropdown]`);
  const panel = dropdown?.querySelector('.asset-filter-multiselect-panel');
  if (!panel) return;
  const document = form.ownerDocument;
  panel.querySelectorAll('.asset-filter-multiselect-option, .asset-filter-multiselect-empty')
    .forEach((row) => row.remove());
  if (options.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'asset-filter-multiselect-empty';
    const link = document.createElement('a');
    link.href = '/settings/tags';
    link.textContent = 'Add tags in Settings';
    empty.append('No tags available. ', link, '.');
    panel.append(empty);
  }
  panel.append(...options.map((option, index) => {
    const row = document.createElement('div');
    row.className = 'asset-filter-multiselect-option';
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.id = `${dropdown.id}-option-${index + 1}`;
    input.name = 'tagIds[]';
    input.type = 'checkbox';
    input.value = String(option.value);
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
// target follows the loaded project.
function applyProjectActions(dialog, actions) {
  for (const kind of ['archive', 'delete']) {
    const disclosure = dialog.querySelector(`[data-project-edit-action="${kind}"]`);
    if (!disclosure) continue;
    const url = actions?.[kind];
    disclosure.open = false;
    setHidden(disclosure, !url);
    disclosure.querySelector('form')?.setAttribute('action', url || '');
  }
}

// The complete editable model, so every save sends every field.
function baselineValues(values = {}) {
  return {
    title: values.title ?? '',
    description: values.description ?? '',
    notes: values.notes ?? '',
    patreonUrl: values.patreonUrl ?? '',
    status: values.status ?? '',
    projectType: values.projectType ?? '',
    'tagIds[]': Array.isArray(values['tagIds[]']) ? values['tagIds[]'].map(String) : [],
  };
}

function createController(document, dialog) {
  const dialogState = dialog.__creatorCrateAppDialogState;
  const form = dialogState.form;
  const body = dialog.querySelector('.app-dialog-body');
  const submitControls = () => Array.from(dialog.querySelectorAll('[data-dialog-submit]'));
  const controller = {
    generation: 0,
    abort: null,
    // The project the form currently holds and may save; null while loading
    // or after a failed load, so nothing can be written to a stale target.
    projectId: null,
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
    if (Array.isArray(payload.tagOptions)) renderTagOptions(form, payload.tagOptions);
    applyProjectActions(dialog, payload.actions);
    setAppDialogBaseline(document, PROJECT_EDIT_DIALOG_ID, baselineValues(payload.values));
    controller.projectId = String(payload.project.id);
  };

  controller.open = (projectIdValue, { opener = null } = {}) => {
    const projectId = projectIdOf(projectIdValue);
    // A pending save owns the form; an open dialog is already editing.
    if (!projectId || dialogState.submitting || dialog.open) return false;
    cancelLoad();
    const generation = controller.generation;
    const abort = typeof AbortController === 'function' ? new AbortController() : null;
    controller.abort = abort;
    controller.projectId = null;
    setReady(false);
    openAppDialogById(document, PROJECT_EDIT_DIALOG_ID, opener);
    setStatus(dialog, LOADING_MESSAGE);

    const windowObject = document.defaultView || globalThis;
    Promise.resolve().then(() => windowObject.fetch(`/projects/${projectId}/edit`, {
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
        || String(payload.project?.id) !== projectId || !payload.actions?.update) {
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

  // A dialog rendered open (Project Detail's ?edit=1 deep link, or a refused
  // HTML save) already holds its project. Freshly rendered values are its
  // confirmed baseline; a refused save's draft keeps its own reset values.
  if (dialog.open || dialogState.open) {
    controller.projectId = projectIdOf(form.getAttribute(LOADED_ID_ATTRIBUTE));
    // Dismissal returns focus to the page's Edit action for this project.
    dialogState.opener ||= controller.projectId
      ? document.querySelector(`${EDIT_TRIGGER_SELECTOR}[data-project-edit-id="${controller.projectId}"]`)
      : null;
    if (!form.hasAttribute('data-dialog-reset-values') && dialogState.savedValues) {
      setAppDialogBaseline(document, PROJECT_EDIT_DIALOG_ID, baselineValues(dialogState.savedValues));
    }
  }

  // Dismissal cancels a pending load. A close event that arrives after a
  // rapid reopen finds the dialog open again and leaves the new load alone.
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    cancelLoad();
  });

  // Only a loaded form may submit (implicit submission included).
  dialog.addEventListener('submit', (event) => {
    if (event.target !== form || controller.projectId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  // A refused save keeps exactly what the user entered (tags included).
  dialogState.preserveValuesOnError = true;
  // A save in flight may already have renamed the project folder, so the
  // dialog stays open until its outcome is known rather than resetting.
  const previousBeforeClose = dialogState.beforeClose;
  dialogState.beforeClose = (context) => {
    if (dialogState.submitting) return false;
    return previousBeforeClose ? previousBeforeClose(context) : true;
  };

  const previousSuccess = dialogState.onSuccessfulSubmit;
  dialogState.onSuccessfulSubmit = (payload) => {
    const result = previousSuccess?.(payload);
    if (result === true) return true;
    // A deep link opened from another page (?returnTo=) goes back there once
    // saved, as its HTML save always has.
    const returnLocation = localLocation(form.querySelector('[data-dialog-return-location]')?.value);
    if (returnLocation) {
      (document.defaultView || globalThis).location.assign(returnLocation);
      return true;
    }
    if (Array.isArray(payload?.tagOptions)) renderTagOptions(form, payload.tagOptions);
    if (payload?.actions) applyProjectActions(dialog, payload.actions);
    const projectId = String(payload?.project?.id ?? controller.projectId);
    // After the binder records the saved values and closes the dialog.
    Promise.resolve().then(() => {
      document.dispatchEvent(new (document.defaultView || globalThis).CustomEvent(PROJECT_EDIT_SAVED_EVENT, {
        detail: { projectId, project: payload?.project ?? null, values: payload?.values ?? null, payload },
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
 * Binds the page's async Edit Project dialog and delegates every
 * data-project-edit-id action to it, including actions rendered later.
 * Returns the controller ({ open(projectId, { opener }) }) or null when the
 * page has no async Edit Project dialog.
 */
export function enhanceProjectEditDialog(scope = globalThis.document) {
  const document = scope?.nodeType === 9 ? scope : scope?.ownerDocument;
  const dialog = document?.getElementById?.(PROJECT_EDIT_DIALOG_ID);
  const form = dialog?.__creatorCrateAppDialogState?.form;
  if (!form || form.getAttribute('data-dialog-async') !== 'true') return null;
  if (controllers.has(dialog)) return controllers.get(dialog);
  const controller = createController(document, dialog);
  controllers.set(dialog, controller);

  if (!isEnhancementBound(document.documentElement, 'projectEditTriggersBound')) {
    markEnhancementBound(document.documentElement, 'projectEditTriggersBound');
    document.addEventListener('click', (event) => {
      if (event.defaultPrevented || event.button !== 0
        || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const trigger = event.target?.closest?.(EDIT_TRIGGER_SELECTOR);
      if (!trigger) return;
      event.preventDefault();
      const opener = editTriggerOpener(document, trigger);
      dismissActiveGridInfoCard();
      controller.open(trigger.getAttribute('data-project-edit-id'), { opener });
    });
  }
  return controller;
}
