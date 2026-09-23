import { syncCreatorCrateDropdownFromNative } from './dropdowns.js';

const ownership = new WeakMap();
const DESCRIPTION_LIMIT = 4000;

function setStatus(form, message, error = false) {
  const status = form.querySelector('[data-release-signature-status]');
  if (!status) return;
  status.setAttribute('role', error ? 'alert' : 'status');
  status.textContent = message;
}

function selectSignature(select, id) {
  select.value = id;
  syncCreatorCrateDropdownFromNative(select);
}

function initialConfiguration(document) {
  const manager = document.querySelector('[data-release-signatures-manager]');
  const entries = [...(manager?.querySelectorAll('[data-release-signature-item]') || [])].map((card) => ({
    id: card.dataset.signatureId,
    name: card.querySelector('[name="name"]').value,
    body: card.querySelector('[name="body"]').value,
  }));
  return {
    entries,
    defaultId: manager?.querySelector('[data-release-signature-default-form] select')?.value || null,
  };
}

function relinquish(form, textarea, select, state) {
  state.managed = null;
  state.lastValue = textarea.value;
  state.pendingEdit = null;
  selectSignature(select, '');
  setStatus(form, '');
}

function reconcileDescription(form, textarea, select, state, inputEvent = null) {
  const managed = state.managed;
  if (!managed) {
    state.lastValue = textarea.value;
    state.pendingEdit = null;
    return;
  }
  const previous = state.lastValue;
  const next = textarea.value;
  const edit = state.pendingEdit;
  state.pendingEdit = null;
  const capturedEdit = inputEvent?.isTrusted && edit;
  const beforeInsertion = capturedEdit && edit.type === inputEvent.inputType
    && edit.end <= managed.start
    && (edit.start < managed.start || edit.type.endsWith('Backward'));
  if (next === previous) {
    if (capturedEdit && !beforeInsertion) relinquish(form, textarea, select, state);
    return;
  }
  const newStart = next.length - managed.text.length;
  const prefixOnly = newStart >= 0 && next.slice(newStart) === managed.text
    && previous.slice(managed.start) === managed.text;
  const knownBeforeInsertion = beforeInsertion
    && next.slice(0, edit.start) === previous.slice(0, edit.start)
    && next.slice(newStart - (managed.start - edit.end), newStart)
      === previous.slice(edit.end, managed.start);
  if (prefixOnly && knownBeforeInsertion) {
    managed.start = newStart;
    state.lastValue = next;
    return;
  }
  relinquish(form, textarea, select, state);
}

function applySelection(form, textarea, select, state, signature) {
  reconcileDescription(form, textarea, select, state);
  const managed = state.managed;
  if (!signature && !managed) {
    selectSignature(select, '');
    setStatus(form, '');
    return true;
  }
  if (managed && signature?.id === managed.id) {
    selectSignature(select, managed.id);
    return true;
  }
  const original = textarea.value;
  if (managed && original.slice(managed.start) !== managed.text) {
    relinquish(form, textarea, select, state);
  }
  const current = state.managed;
  const prefix = current ? original.slice(0, current.start) : original;
  const inserted = signature ? `${prefix ? '\n\n' : ''}${signature.body}` : '';
  const proposed = prefix + inserted;
  if (proposed.length > DESCRIPTION_LIMIT) {
    selectSignature(select, current?.id || '');
    setStatus(form, 'Signature could not be inserted because Description exceeds 4,000 characters.', true);
    return false;
  }
  textarea.value = proposed;
  state.managed = signature ? { id: signature.id, text: inserted, start: prefix.length } : null;
  state.lastValue = proposed;
  state.pendingEdit = null;
  selectSignature(select, signature?.id || '');
  if (signature) textarea.setSelectionRange(proposed.length, proposed.length);
  setStatus(form, '');
  return true;
}

function syncConfiguration(form, textarea, select, state, configuration) {
  if (!configuration || !Array.isArray(configuration.entries)) return;
  state.configuration = configuration;
  reconcileDescription(form, textarea, select, state);
  const deleted = state.managed && !configuration.entries.some((entry) => entry.id === state.managed.id);
  if (deleted) {
    state.managed = null;
    state.lastValue = textarea.value;
  }
  const document = select.ownerDocument;
  select.replaceChildren(...[
    { id: '', name: 'No signature' }, ...configuration.entries,
  ].map((entry) => {
    const option = document.createElement('option');
    option.value = entry.id;
    option.textContent = entry.name;
    return option;
  }));
  const dropdown = form.querySelector('[data-release-signature-field] [data-cc-dropdown]');
  dropdown?.querySelectorAll('.asset-filter-multiselect-option').forEach((option) => option.remove());
  selectSignature(select, state.managed?.id || '');
  if (deleted) setStatus(form, 'The selected signature was deleted. Its Description text was kept.');
}

export function enhanceReleaseSignatures(scope = globalThis.document) {
  const forms = [...(scope?.querySelectorAll?.('form:has([data-release-signature-field])') || [])];
  if (scope?.matches?.('form:has([data-release-signature-field])')) forms.unshift(scope);
  for (const form of forms) {
    const textarea = form.querySelector('textarea[name="description"]');
    const select = form.querySelector('[data-release-signature-field] select');
    if (!textarea || !select || ownership.has(textarea)) continue;
    const state = {
      configuration: initialConfiguration(form.ownerDocument),
      managed: null,
      lastValue: textarea.value,
      pendingEdit: null,
      automaticConsidered: false,
    };
    ownership.set(textarea, state);
    selectSignature(select, '');
    textarea.addEventListener('beforeinput', (event) => {
      if (!event.isTrusted || textarea.value !== state.lastValue) {
        if (state.managed && textarea.value !== state.lastValue) {
          relinquish(form, textarea, select, state);
        }
        state.pendingEdit = null;
        return;
      }
      state.pendingEdit = {
        start: textarea.selectionStart,
        end: textarea.selectionEnd,
        type: event.inputType,
      };
    });
    textarea.addEventListener('input', (event) => reconcileDescription(form, textarea, select, state, event));
    form.addEventListener('click', (event) => {
      if (event.target.matches('[data-release-signature-field] input[type="radio"][value=""]')
        && !state.managed) {
        setStatus(form, '');
      }
    });
    form.addEventListener('change', (event) => {
      if (!event.target.matches('[data-release-signature-field] input[type="radio"]')) return;
      const id = event.target.value;
      const signature = state.configuration.entries.find((entry) => entry.id === id);
      if (id && !signature) return;
      applySelection(form, textarea, select, state, signature);
    });
    form.addEventListener('reset', () => {
      state.managed = null;
      state.pendingEdit = null;
      form.ownerDocument.defaultView.setTimeout(() => {
        state.lastValue = textarea.value;
        selectSignature(select, '');
        setStatus(form, '');
      }, 0);
    });
    form.ownerDocument.addEventListener('release-signatures-configuration-updated', (event) => {
      syncConfiguration(form, textarea, select, state, event.detail?.configuration);
    });
    if (!state.automaticConsidered) {
      state.automaticConsidered = true;
      if (form.dataset.releaseCreateFresh === 'true' && !textarea.value) {
        const signature = state.configuration.entries.find((entry) => entry.id === state.configuration.defaultId);
        if (signature) applySelection(form, textarea, select, state, signature);
      }
    }
  }
  return forms.length;
}
