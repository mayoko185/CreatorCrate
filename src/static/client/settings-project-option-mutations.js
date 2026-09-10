import { enhanceAppConfirmationControls, requestAppConfirmation } from './confirm-dialog.js';
import { isEnhancementBound, markEnhancementBound } from './dom.js';
import { normalizeProjectOptionColor, enhanceProjectOptionColorPickers } from './project-option-color-picker.js';
import { enhanceProjectOptionReorder } from './settings-project-option-reorder.js';
import { enhanceSettingsFetchSave, queueSettingsFetchSave } from './settings-fetch-save.js';

const REGION = '[data-settings-project-option-editor]';
const ADD_FORM = '[data-project-option-add-form]';
const COLOR_FORM = '[data-project-option-color-form]';
const DELETE_FORM = '[data-project-option-delete-form]';
const MUTATION_FORMS = `${ADD_FORM}, ${COLOR_FORM}, ${DELETE_FORM}`;
const regionListenerDocuments = new WeakSet();
const pendingDeleteControls = new WeakSet();

function mutationRegion(form) {
  return form?.closest?.(REGION) || null;
}

function regionRequestPending(region) {
  return Boolean(region?.hasAttribute?.('data-project-option-mutation-pending')
    || region?.querySelector?.('[data-project-option-list][aria-busy="true"]'));
}

function matchingResponseRegion(form, html) {
  if (typeof html !== 'string' || html === '') return null;
  const region = mutationRegion(form);
  const DOMParser = form?.ownerDocument?.defaultView?.DOMParser || globalThis.DOMParser;
  if (!region || typeof DOMParser !== 'function') return null;
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  return [...parsed.querySelectorAll(REGION)]
    .find(node => node.dataset.settingsProjectOptionEditor === region.dataset.settingsProjectOptionEditor) || null;
}

function setClientError(region, message) {
  if (!region) return;
  let feedback = region.querySelector('[data-project-option-feedback]');
  if (!feedback) {
    feedback = region.ownerDocument.createElement('div');
    feedback.dataset.projectOptionFeedback = '';
    const heading = region.querySelector('h3');
    if (heading?.nextSibling) region.insertBefore(feedback, heading.nextSibling);
    else if (heading) heading.after(feedback);
    else region.prepend(feedback);
  }
  feedback.className = 'notice notice--error';
  feedback.setAttribute('role', 'alert');
  feedback.dataset.projectOptionFeedbackCode = 'CLIENT_REQUEST_ERROR';
  feedback.replaceChildren(Object.assign(region.ownerDocument.createElement('p'), { textContent: message }));
}

function enhanceReplacement(region) {
  if (!region) return;
  enhanceProjectOptionMutations(region);
  enhanceProjectOptionReorder(region);
  enhanceProjectOptionColorPickers(region);
}

function replaceMutationRegion(form, html) {
  const current = mutationRegion(form);
  const next = matchingResponseRegion(form, html);
  if (!current || !next || !current.parentNode) return null;
  if (typeof current.replaceWith === 'function') current.replaceWith(next);
  else current.parentNode.replaceChild(next, current);
  enhanceReplacement(next);
  return next;
}

function setFormPending(form, pending) {
  const region = mutationRegion(form);
  form.toggleAttribute?.('aria-busy', pending);
  form.querySelectorAll?.('button, input[type="text"]').forEach((control) => {
    control.disabled = pending;
  });
  if (region) region.toggleAttribute?.('data-project-option-mutation-pending', pending);
}

function restoreColor(form, color) {
  const normalized = normalizeProjectOptionColor(color);
  const control = form?.querySelector?.('[data-project-option-color-control]');
  const value = control?.querySelector?.('[data-project-option-color-value]');
  if (!normalized || !control || !value) return;
  value.value = normalized;
  control.dataset.projectOptionPendingColor = normalized;
  control.querySelector?.('.project-option-color-swatch')?.style
    .setProperty('--project-option-color', normalized);
  const code = control.querySelector?.('.project-option-color-code');
  if (code) code.textContent = normalized;
  const hex = control.querySelector?.('.project-option-color-panel input');
  if (hex) hex.value = normalized;
  control.querySelectorAll?.('[data-color]').forEach((swatch) => {
    swatch.setAttribute('aria-pressed', String(swatch.dataset.color === normalized));
  });
  const preview = control.querySelector?.('[data-color-preview]');
  if (preview) preview.textContent = `Selected color: ${normalized}`;
}

function requestFailureMessage(type) {
  return type === 'network'
    ? 'Could not update this catalogue because the network request failed. No unconfirmed change was kept.'
    : 'Could not update this catalogue because the server response was incomplete. Reload and try again.';
}

function bindMutationForm(form) {
  if (isEnhancementBound(form, 'projectOptionMutationBound')) return false;
  const queueControl = form.matches(COLOR_FORM)
    ? form.querySelector('[data-project-option-color-value]')
    : form.querySelector('[name="_csrf"]');
  if (!queueControl) return false;
  queueControl.setAttribute('data-autosubmit', 'fetch');

  const state = { pending: false, previousColor: null };
  const finishWithoutReplacement = (type) => {
    if (form.matches(COLOR_FORM)) restoreColor(form, state.previousColor);
    state.pending = false;
    setFormPending(form, false);
    setClientError(mutationRegion(form), requestFailureMessage(type));
  };
  const reconcile = (html, type) => {
    const next = replaceMutationRegion(form, html);
    if (!next) finishWithoutReplacement(type);
  };
  const bound = enhanceSettingsFetchSave({ querySelectorAll: () => [queueControl] }, {
    onStart: () => {
      state.pending = true;
      setFormPending(form, true);
    },
    onSuccess: ({ html }) => reconcile(html, 'malformed'),
    onError: ({ html, type }) => {
      if (html && matchingResponseRegion(form, html)) reconcile(html, type);
      else finishWithoutReplacement(type);
    },
  });
  if (!bound) return false;

  if (form.matches(COLOR_FORM)) {
    form.addEventListener('project-option-color-change', (event) => {
      const color = normalizeProjectOptionColor(event.detail?.color);
      const previousColor = normalizeProjectOptionColor(event.detail?.previousColor);
      if (!color || !previousColor || state.pending || regionRequestPending(mutationRegion(form))) {
        if (state.pending) restoreColor(form, state.previousColor);
        else if (previousColor) restoreColor(form, previousColor);
        return;
      }
      state.previousColor = previousColor;
      queueSettingsFetchSave(queueControl);
    });
  } else {
    form.addEventListener('submit', (event) => {
      if (state.pending || regionRequestPending(mutationRegion(form))) {
        event.preventDefault();
        return;
      }
      if (queueSettingsFetchSave(queueControl)) event.preventDefault();
    });
  }

  markEnhancementBound(form, 'projectOptionMutationBound');
  return true;
}

function submitConfirmedDeletion(control, replacement) {
  const form = control.form;
  if (!form?.requestSubmit) return;
  form.querySelector?.('input[data-project-option-delete-replacement]')?.remove?.();
  let input = null;
  if (replacement) {
    input = form.ownerDocument.createElement('input');
    input.type = 'hidden';
    input.name = 'replacement';
    input.value = replacement;
    input.dataset.projectOptionDeleteReplacement = '';
    form.appendChild(input);
  }
  try {
    form.requestSubmit(control);
  } finally {
    input?.remove?.();
  }
}

function bindDeleteControl(control) {
  if (isEnhancementBound(control, 'projectOptionDeleteBound')) return false;
  markEnhancementBound(control, 'projectOptionDeleteBound');
  control.addEventListener?.('click', (event) => {
    event.preventDefault?.();
    if (pendingDeleteControls.has(control)) return;
    pendingDeleteControls.add(control);
    const mode = control.dataset.projectOptionDeleteMode;
    const request = {
      title: control.dataset.projectOptionDeleteTitle || 'Delete Project option?',
      message: control.dataset.projectOptionDeleteMessage || '',
      confirmLabel: control.dataset.projectOptionDeleteConfirmLabel || 'Delete',
      opener: control,
      destructive: mode !== 'blocked',
    };
    if (mode === 'referenced') {
      request.replacementTemplate = control.form?.querySelector?.(
        '[data-project-option-delete-replacement-template]',
      );
    }
    requestAppConfirmation(control.ownerDocument, request).then((result) => {
      if (!result || control.isConnected === false || control.disabled) return;
      if (mode === 'blocked') return;
      const replacement = mode === 'referenced' && typeof result === 'object'
        ? result.value
        : '';
      if (mode === 'referenced' && !replacement) return;
      submitConfirmedDeletion(control, replacement);
    }).finally(() => pendingDeleteControls.delete(control));
  });
  return true;
}

function bindRegionReplacementListener(document) {
  if (!document || regionListenerDocuments.has(document)) return;
  regionListenerDocuments.add(document);
  document.addEventListener('project-option-region-replaced', (event) => {
    enhanceProjectOptionMutations(event.target);
  });
}

export function enhanceProjectOptionMutations(scope = globalThis.document) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;
  bindRegionReplacementListener(scope.ownerDocument || (scope.nodeType === 9 ? scope : globalThis.document));
  enhanceAppConfirmationControls(scope);
  const forms = [...scope.querySelectorAll(MUTATION_FORMS)];
  if (scope.matches?.(MUTATION_FORMS)) forms.unshift(scope);
  let bound = forms.reduce((count, form) => count + Number(bindMutationForm(form)), 0);
  const deleteControls = [...scope.querySelectorAll('[data-project-option-delete]')];
  if (scope.matches?.('[data-project-option-delete]')) deleteControls.unshift(scope);
  bound += deleteControls.reduce((count, control) => count + Number(bindDeleteControl(control)), 0);
  return bound;
}
