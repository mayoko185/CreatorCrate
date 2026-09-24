import { requestAppConfirmation } from './confirm-dialog.js';
import { enhanceDedicatedReorder, NOTES_REORDER_INTERACTIVE_SELECTOR } from './dedicated-reorder.js';
import { isEnhancementBound, markEnhancementBound } from './dom.js';
import { syncCreatorCrateDropdownFromNative } from './dropdowns.js';
import { captureRegionFocus, restoreRegionFocus } from './settings-fetch-save.js';

const MANAGER = '[data-release-signatures-manager]';
const ITEM = '[data-release-signature-item]';
const URL = '/settings/release-signatures';

function validConfiguration(value) {
  return value?.version === 1 && Array.isArray(value.entries)
    && value.entries.every((entry) => typeof entry.id === 'string'
      && typeof entry.name === 'string' && typeof entry.body === 'string')
    && (value.defaultId === null || value.entries.some((entry) => entry.id === value.defaultId));
}

function field(document, labelText, id, name, tag, value) {
  const wrapper = document.createElement('div');
  wrapper.className = 'field category-management-card-field';
  const label = document.createElement('label');
  label.htmlFor = id;
  label.textContent = labelText;
  const control = document.createElement(tag);
  control.id = id;
  control.name = name;
  control.value = value;
  control.defaultValue = value;
  if (tag === 'input') {
    control.type = 'text';
    control.maxLength = 100;
    control.required = true;
  } else {
    control.rows = 2;
    control.maxLength = 4000;
  }
  wrapper.append(label, control);
  return wrapper;
}

function makeCard(document, signature, csrf) {
  const item = document.createElement('li');
  item.className = 'category-management-card';
  item.dataset.releaseSignatureItem = '';
  item.dataset.signatureId = signature.id;
  item.draggable = true;
  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'category-reorder-handle';
  handle.dataset.releaseSignatureHandle = '';
  handle.draggable = true;
  handle.setAttribute('aria-label', `Reorder ${signature.name}`);
  const glyph = document.createElement('span');
  glyph.setAttribute('aria-hidden', 'true');
  glyph.textContent = '⠿';
  handle.append(glyph);
  const body = document.createElement('div');
  body.className = 'category-management-card-body';
  const form = document.createElement('form');
  form.method = 'dialog';
  form.className = 'project-form category-details-form';
  form.dataset.releaseSignatureEditForm = '';
  form.dataset.signatureId = signature.id;
  const token = document.createElement('input');
  token.type = 'hidden'; token.name = '_csrf'; token.value = csrf;
  const id = document.createElement('input');
  id.type = 'hidden'; id.name = 'id'; id.value = signature.id;
  const fields = document.createElement('div');
  fields.className = 'category-management-card-fields';
  fields.append(
    field(document, 'Name', `release-signature-${signature.id}-name`, 'name', 'input', signature.name),
    field(document, 'Signature body', `release-signature-${signature.id}-body`, 'body', 'textarea', signature.body),
  );
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'button button-small button-danger project-filter-control asset-tooltip asset-tooltip--top release-signature-delete';
  remove.dataset.releaseSignatureDelete = '';
  remove.setAttribute('aria-label', 'Delete signature');
  remove.dataset.tooltip = 'Delete signature';
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'aria-hidden': 'true', focusable: 'false' })) icon.setAttribute(name, value);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6');
  icon.append(path);
  remove.append(icon);
  form.append(token, id, fields, remove);
  body.append(form);
  item.append(handle, body);
  return item;
}

function setStatus(manager, message, error = false) {
  const status = manager.closest('dialog')?.querySelector('[data-dialog-status]');
  if (!status) return;
  status.setAttribute('role', error ? 'alert' : 'status');
  status.textContent = message;
}

function syncDefault(manager, configuration) {
  const select = manager.querySelector('[data-release-signature-default-form] select');
  if (!select) return;
  const document = manager.ownerDocument;
  const options = [{ name: 'No default', id: '' }, ...configuration.entries].map((entry) => {
    const option = document.createElement('option');
    option.value = entry.id;
    option.textContent = entry.name;
    option.defaultSelected = entry.id === (configuration.defaultId ?? '');
    return option;
  });
  select.replaceChildren(...options);
  select.value = configuration.defaultId ?? '';
  const dropdown = manager.querySelector('[data-release-signature-default-form] [data-cc-dropdown]');
  dropdown?.querySelectorAll('.asset-filter-multiselect-option').forEach((option) => option.remove());
  syncCreatorCrateDropdownFromNative(select);
}

function reconcile(manager, configuration, savedId = null, deletedId = null, submitted = null, editState = null) {
  const document = manager.ownerDocument;
  const focus = captureRegionFocus(manager);
  const section = manager.querySelector('[data-release-signatures-list]')?.parentElement
    || manager.querySelector('#release-signatures-current-heading')?.parentElement?.querySelector('.project-edit-dialog-section-body');
  if (!section) return;
  let list = section.querySelector('[data-release-signatures-list]');
  const old = new Map([...manager.querySelectorAll(ITEM)].map((card) => [card.dataset.signatureId, card]));
  const csrf = manager.querySelector('[name="_csrf"]')?.value || '';
  if (configuration.entries.length && !list) {
    section.replaceChildren();
  }
  if (configuration.entries.length) {
    const nextList = document.createElement('ol');
    nextList.className = 'category-reorder-list';
    nextList.dataset.releaseSignaturesList = '';
    nextList.setAttribute('aria-label', 'Signatures in saved order');
    for (const [index, signature] of configuration.entries.entries()) {
      const card = old.get(signature.id) || makeCard(document, signature, csrf);
      if (signature.id === savedId) {
        for (const name of ['name', 'body']) {
          const control = card.querySelector(`[name="${name}"]`);
          if (!submitted || control.value === submitted[name] || editState?.resetByClose.has(name)) {
            control.value = signature[name];
          }
          control.defaultValue = signature[name];
        }
      }
      card.querySelector('[data-release-signature-handle]')?.setAttribute('aria-label', `Reorder ${signature.name}`);
      card.setAttribute('aria-posinset', String(index + 1));
      card.setAttribute('aria-setsize', String(configuration.entries.length));
      nextList.append(card);
    }
    for (const [id, card] of old) if (!configuration.entries.some((entry) => entry.id === id)) card.remove();
    if (list) list.replaceWith(nextList);
    else section.append(nextList);
    list = nextList;
  } else if (list) {
    list.remove();
    section.querySelector('[data-release-signature-reorder-live]')?.remove();
    const empty = document.createElement('p');
    empty.className = 'help-text';
    empty.textContent = 'No signatures yet. Add a signature below to make it available for releases.';
    section.append(empty);
  }
  syncDefault(manager, configuration);
  bindReorder(manager);
  if (!restoreRegionFocus(manager, focus) && deletedId) {
    (manager.querySelector('[data-release-signature-handle]')
      || manager.querySelector('[data-release-signature-add-form] [name="name"]'))?.focus({ preventScroll: true });
  }
  manager.dispatchEvent(new document.defaultView.CustomEvent('release-signatures-configuration-updated', {
    bubbles: true, detail: { configuration },
  }));
}

function bindReorder(manager) {
  const list = manager.querySelector('[data-release-signatures-list]');
  if (!list || isEnhancementBound(list, 'releaseSignatureReorderBound')) return;
  let live = manager.querySelector('[data-release-signature-reorder-live]');
  if (!live) {
    live = manager.ownerDocument.createElement('p');
    live.id = 'release-signatures-reorder-help';
    live.className = 'help-text';
    live.dataset.releaseSignatureReorderLive = '';
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    live.textContent = 'Drag cards to reorder, or focus a card and use Up, Down, Home, or End.';
    list.before(live);
  }
  const form = manager.querySelector('[data-release-signature-default-form]');
  const cards = [...list.querySelectorAll(ITEM)];
  cards.forEach((card) => {
    card.tabIndex = 0;
    card.id = `release-signature-${card.dataset.signatureId}-card`;
    card.setAttribute('aria-describedby', live.id);
    card.querySelector('[data-release-signature-handle]').id = `release-signature-${card.dataset.signatureId}-handle`;
    card.querySelector('[data-release-signature-delete]').id = `release-signature-${card.dataset.signatureId}-delete`;
    card.setAttribute('aria-label', `Reorder ${card.querySelector('[name="name"]')?.value || 'signature'}`);
  });
  enhanceDedicatedReorder(manager, {
    listSelector: '[data-release-signatures-list]', itemSelector: ITEM,
    handleSelector: '[data-release-signature-handle]',
    wholeCardKeyboard: true, pointerDragSurfaceSelector: ITEM,
    pointerDragExcludedSelector: NOTES_REORDER_INTERACTIVE_SELECTOR,
    form, liveSelector: '[data-release-signature-reorder-live]',
    idDataset: 'signatureId', idAttribute: 'data-signature-id', label: 'Signature',
    bindingKey: 'releaseSignatureReorderBound',
    isBusy: () => manager.hasAttribute('aria-busy'),
    syncInput: () => true,
    onOrderChange: () => {
      const ids = [...list.querySelectorAll(ITEM)].map((card) => card.dataset.signatureId);
      void mutate(manager, 'PUT', `${URL}/order`, { orderedIds: ids }, 'Signature order saved.',
        null, null, true);
    },
  });
}

async function loadConfiguration() {
  const response = await fetch(URL, { credentials: 'same-origin' });
  const configuration = await response.json();
  if (!response.ok || !validConfiguration(configuration)) throw new Error('Could not load saved signatures.');
  return configuration;
}

async function mutate(manager, method, url, payload, successMessage, savedId = null, deletedId = null, refreshOnFailure = false, editState = null) {
  if (manager.hasAttribute('aria-busy')) return false;
  manager.setAttribute('aria-busy', 'true');
  manager.querySelector('[data-release-signatures-list]')?.setAttribute('aria-busy', 'true');
  setStatus(manager, 'Saving signatures.');
  try {
    const csrf = manager.querySelector('[name="_csrf"]')?.value || '';
    const response = await fetch(url, {
      method, credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: payload === null ? undefined : JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok || !validConfiguration(result)) {
      const detail = Object.values(result?.errors || {}).join(' ');
      throw new Error(detail || 'Could not save signatures.');
    }
    reconcile(manager, result, savedId, deletedId, savedId ? payload : null, editState);
    setStatus(manager, successMessage);
    return true;
  } catch (error) {
    if (refreshOnFailure) {
      try { reconcile(manager, await loadConfiguration()); }
      catch { setStatus(manager, 'Could not confirm the saved signatures. Reload to check their state.', true); return false; }
    }
    const message = error instanceof TypeError || error instanceof SyntaxError
      ? 'Could not confirm the saved signatures. Your current edits were kept.'
      : error.message || 'Could not save signatures. Your current edits were kept.';
    setStatus(manager, message, true);
    return false;
  } finally {
    manager.removeAttribute('aria-busy');
    manager.querySelector('[data-release-signatures-list]')?.removeAttribute('aria-busy');
    manager.dispatchEvent(new manager.ownerDocument.defaultView.Event('release-signatures-mutation-settled'));
  }
}

export function enhanceReleaseSignatureManagers(scope = globalThis.document) {
  const managers = [...(scope?.querySelectorAll?.(MANAGER) || [])];
  if (scope?.matches?.(MANAGER)) managers.unshift(scope);
  for (const manager of managers) {
    if (isEnhancementBound(manager, 'releaseSignatureManagerBound')) continue;
    markEnhancementBound(manager, 'releaseSignatureManagerBound');
    bindReorder(manager);
    const pendingEdits = new Set();
    let pendingDefault;
    let activeEdit;
    let discardOnSettle = false;
    const dialog = manager.closest('dialog');
    const discardDraft = () => {
      manager.querySelector('[data-release-signature-add-form]')?.reset();
      manager.querySelectorAll('[data-release-signature-edit-form]').forEach((form) => form.reset());
      const defaultForm = manager.querySelector('[data-release-signature-default-form]');
      defaultForm?.reset();
      const select = defaultForm?.querySelector('select');
      if (select) syncCreatorCrateDropdownFromNative(select);
      setStatus(manager, '');
    };
    dialog?.addEventListener('close', () => {
      pendingEdits.clear();
      pendingDefault = undefined;
      discardOnSettle = manager.hasAttribute('aria-busy');
      if (activeEdit) activeEdit.resetByClose = new Set(['name', 'body']);
      discardDraft();
    });
    manager.addEventListener('input', (event) => {
      const edit = event.target.closest?.('[data-release-signature-edit-form]');
      if (edit?.dataset.signatureId === activeEdit?.id) activeEdit.resetByClose.delete(event.target.name);
    });
    const saveEdit = async (id) => {
      const card = [...manager.querySelectorAll(ITEM)].find((item) => item.dataset.signatureId === id);
      if (!card) return;
      if (manager.hasAttribute('aria-busy')) { pendingEdits.add(id); return; }
      const form = card.querySelector('[data-release-signature-edit-form]');
      if (!form.reportValidity()) return;
      const name = form.elements.namedItem('name');
      const body = form.elements.namedItem('body');
      if (name.value === name.defaultValue && body.value === body.defaultValue) return;
      const editState = { id, resetByClose: new Set() };
      activeEdit = editState;
      try {
        await mutate(manager, 'PATCH', `${URL}/${encodeURIComponent(id)}`,
          { name: name.value, body: body.value }, 'Signature saved.', id, null, false, editState);
      } finally {
        if (activeEdit === editState) activeEdit = undefined;
      }
    };
    manager.addEventListener('release-signatures-mutation-settled', () => {
      if (discardOnSettle) {
        discardOnSettle = false;
        if (!dialog?.open) discardDraft();
      }
      if (pendingEdits.size) {
        const next = pendingEdits.values().next().value;
        pendingEdits.delete(next);
        void saveEdit(next);
      } else if (pendingDefault !== undefined) {
        const id = pendingDefault;
        pendingDefault = undefined;
        void mutate(manager, 'PUT', `${URL}/default`, { id }, 'Default signature saved.', null, null, true);
      }
    });
    manager.addEventListener('submit', (event) => {
      const form = event.target;
      if (!form.matches('[data-release-signature-add-form], [data-release-signature-edit-form], [data-release-signature-default-form]')) return;
      event.preventDefault();
      if (form.matches('[data-release-signature-add-form]')) form.querySelector('[data-release-signature-add]')?.click();
      if (form.matches('[data-release-signature-edit-form]')) void saveEdit(form.dataset.signatureId);
    });
    manager.addEventListener('click', async (event) => {
      const add = event.target.closest('[data-release-signature-add]');
      const remove = event.target.closest('[data-release-signature-delete]');
      if (!add && !remove) return;
      event.preventDefault();
      if (manager.hasAttribute('aria-busy')) return;
      const form = (add || remove).closest('form');
      if (add) {
        if (!form.reportValidity()) return;
        const payload = { name: form.elements.namedItem('name').value, body: form.elements.namedItem('body').value };
        const success = await mutate(manager, 'POST', URL, payload, 'Signature added.');
        if (success && add && form.elements.namedItem('name').value === payload.name
          && form.elements.namedItem('body').value === payload.body) {
          form.elements.namedItem('name').value = '';
          form.elements.namedItem('body').value = '';
        }
        return;
      }
      const card = remove.closest(ITEM);
      const id = card?.dataset.signatureId;
      if (!id) return;
      manager.setAttribute('aria-busy', 'true');
      const confirmed = await requestAppConfirmation(manager.ownerDocument, {
        title: 'Delete signature?', message: `Delete “${card.querySelector('[name="name"]')?.value || 'signature'}”? This cannot be undone.`,
        confirmLabel: 'Delete', opener: remove, destructive: true,
      });
      manager.removeAttribute('aria-busy');
      if (confirmed) void mutate(manager, 'DELETE', `${URL}/${encodeURIComponent(id)}`, null,
        'Signature deleted.', null, id, true);
    });
    manager.addEventListener('change', (event) => {
      const edit = event.target.closest('[data-release-signature-edit-form]');
      if (edit && event.target.matches('[name="name"], [name="body"]')) {
        void saveEdit(edit.dataset.signatureId);
        return;
      }
      if (!event.target.matches('[data-release-signature-default-form] input[type="radio"]')) return;
      if (manager.hasAttribute('aria-busy')) {
        pendingDefault = event.target.value || null;
        return;
      }
      void mutate(manager, 'PUT', `${URL}/default`, { id: event.target.value || null },
        'Default signature saved.', null, null, true);
    });
  }
  return managers.length;
}
