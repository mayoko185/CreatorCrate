const PREVIEW_ROOT_SELECTOR = '[data-preview-enhancement]';
const PREVIEW_IMAGE_SELECTOR = '[data-preview-image]';
const PREVIEW_FALLBACK_SELECTOR = '[data-preview-fallback]';

function setPreviewState(root, state) {
  if (!root) return;
  if (root.dataset) root.dataset.previewState = state;
  if (typeof root.setAttribute === 'function') {
    root.setAttribute('data-preview-state', state);
  }
}

function hideElement(element) {
  if (!element) return;
  element.hidden = true;
  if (typeof element.setAttribute === 'function') {
    element.setAttribute('hidden', '');
  }
}

function showElement(element) {
  if (!element) return;
  element.hidden = false;
  if (typeof element.removeAttribute === 'function') {
    element.removeAttribute('hidden');
  }
}

export function markPreviewLoaded(root) {
  if (!root || root.dataset?.previewState === 'failed') return 'failed';
  const image = root.querySelector?.(PREVIEW_IMAGE_SELECTOR);
  const fallback = root.querySelector?.(PREVIEW_FALLBACK_SELECTOR);

  setPreviewState(root, 'loaded');
  showElement(image);
  hideElement(fallback);
  return 'loaded';
}

export function markPreviewFailed(root) {
  if (!root) return 'skipped';
  if (root.dataset?.previewState === 'failed') return 'failed';

  const image = root.querySelector?.(PREVIEW_IMAGE_SELECTOR);
  const fallback = root.querySelector?.(PREVIEW_FALLBACK_SELECTOR);

  setPreviewState(root, 'failed');
  hideElement(image);
  showElement(fallback);
  return 'failed';
}

export function enhancePreview(root) {
  if (!root || typeof root.querySelector !== 'function') return 'skipped';

  const image = root.querySelector(PREVIEW_IMAGE_SELECTOR);
  if (!image) return 'skipped';

  if (image.complete === true) {
    return image.naturalWidth > 0
      ? markPreviewLoaded(root)
      : markPreviewFailed(root);
  }

  if (typeof image.addEventListener !== 'function') return 'skipped';

  image.addEventListener('load', () => markPreviewLoaded(root), { once: true });
  image.addEventListener('error', () => markPreviewFailed(root), { once: true });
  return 'listening';
}

export function enhancePreviewMedia(scope = globalThis.document) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;

  const roots = scope.querySelectorAll(PREVIEW_ROOT_SELECTOR);
  roots.forEach((root) => enhancePreview(root));
  return roots.length;
}

export function enhanceAutoSubmit(scope = globalThis.document) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;
  const controls = scope.querySelectorAll('[data-autosubmit]');
  controls.forEach((control) => {
    control.addEventListener('change', () => {
      if (control.form && typeof control.form.requestSubmit === 'function') {
        control.form.requestSubmit();
      } else if (control.form) {
        control.form.submit();
      }
    });
  });
  return controls.length;
}

export function enhanceConfirmations(scope = globalThis.document) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;
  const controls = scope.querySelectorAll('[data-confirm]');
  controls.forEach((control) => {
    control.addEventListener('click', (event) => {
      const message = control.getAttribute('data-confirm');
      if (message && !globalThis.confirm(message)) {
        event.preventDefault();
      }
    });
  });
  return controls.length;
}

// ─── Phase 3 chunk 3: page-local asset selection ──────────────────────────
//
// Scoped entirely to [data-asset-selection-form] — the project asset
// browser's bulk-add-to-release form. The unrelated release asset-selection
// page (releases/assets.njk) uses its own checkboxes/markup and carries no
// such attribute, so it is untouched by this module. Selection state lives
// only in the DOM's checked/unchecked state for the lifetime of this page;
// the separate grid-size preference below is presentation-only storage.

const ASSET_SELECTION_FORM_SELECTOR = '[data-asset-selection-form]';
const ASSET_SELECTION_CHECKBOX_SELECTOR = 'input[type="checkbox"][name="selectedAssetIds"]:not(:disabled)';
const ASSET_CARD_SELECTOR = '[data-asset-selectable-card]';
const ASSET_CARD_INTERACTIVE_SELECTOR = 'a, button, input, select, textarea, form, label, summary, details, .asset-tooltip, .asset-icon-control';
const ASSET_RENAME_TRIGGER_SELECTOR = '[data-asset-rename-trigger]';
const ASSET_RENAME_EDITOR_SELECTOR = '[data-asset-rename-editor]';
const ASSET_GRID_SIZE_CONTROL_SELECTOR = '[data-asset-grid-size-controls]';
const ASSET_GRID_SELECTOR = '.asset-grid';
const ASSET_GRID_SIZE_STORAGE_KEY = 'creatorcrate-asset-grid-size';
const ASSET_GRID_SIZES = Object.freeze({
  compact: '12rem',
  default: '15rem',
  large: '20rem',
});

function getAssetSelectionCheckboxes(form, scope = form) {
  const candidates = Array.from(scope.querySelectorAll(ASSET_SELECTION_CHECKBOX_SELECTOR))
    .filter((candidate) => candidate && typeof candidate.addEventListener === 'function');
  if (scope === form) return candidates;
  return candidates.filter((checkbox) => {
    if (checkbox.form) return checkbox.form === form;
    const ownerId = checkbox.getAttribute?.('form');
    if (ownerId) return ownerId === form.id;
    if (typeof form.contains === 'function') return form.contains(checkbox);
    return true;
  });
}

function updateAssetCardState(card, checked) {
  if (!card) return;
  card.classList?.toggle('is-selected', checked);
  card.setAttribute?.('aria-selected', String(checked));
  card.querySelector?.('.asset-selection-control')?.classList?.toggle('is-selected', checked);
}

function isEnhancementBound(element, key) {
  return element?.dataset?.[key] === 'true' || element?.[key] === true;
}

function markEnhancementBound(element, key) {
  if (!element) return;
  if (element.dataset) element.dataset[key] = 'true';
  else element[key] = true;
}

function updateAssetSelectionState(form, scope = form) {
  const checkboxes = getAssetSelectionCheckboxes(form, scope);
  const selectedCount = checkboxes.filter((checkbox) => checkbox.checked).length;

  const countEl = form.querySelector('[data-selected-count]');
  if (countEl) {
    countEl.textContent = `${selectedCount} selected`;
  }

  const releaseSelect = form.querySelector('[data-release-select]');
  const submitButton = form.querySelector('[data-bulk-submit]');
  if (submitButton) {
    const hasReleaseTarget = Boolean(releaseSelect && releaseSelect.value);
    submitButton.disabled = !(selectedCount > 0 && hasReleaseTarget);
  }
}

export function enhanceAssetSelection(scope = globalThis.document) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;

  const forms = scope.querySelectorAll(ASSET_SELECTION_FORM_SELECTOR);
  if (forms.length === 0) return 0;
  forms.forEach((form) => {
    // Missing-asset rows render a disabled checkbox (or none at all) — the
    // selector above already excludes disabled checkboxes, so Select All /
    // Clear / the live count can never touch them.
    const checkboxes = getAssetSelectionCheckboxes(form, scope);
    checkboxes.forEach((checkbox) => {
      updateAssetCardState(checkbox.closest?.(ASSET_CARD_SELECTOR), checkbox.checked);
      if (isEnhancementBound(checkbox, 'assetSelectionBound')) return;
      markEnhancementBound(checkbox, 'assetSelectionBound');
      checkbox.addEventListener('change', () => {
        updateAssetCardState(checkbox.closest?.(ASSET_CARD_SELECTOR), checkbox.checked);
        updateAssetSelectionState(form, scope);
      });
    });

    if (isEnhancementBound(form, 'assetSelectionBound')) {
      updateAssetSelectionState(form, scope);
      return;
    }
    markEnhancementBound(form, 'assetSelectionBound');

    const selectAllButton = form.querySelector('[data-select-all]');
    if (selectAllButton) {
      selectAllButton.addEventListener('click', () => {
        checkboxes.forEach((checkbox) => { checkbox.checked = true; });
        checkboxes.forEach((checkbox) => updateAssetCardState(checkbox.closest?.(ASSET_CARD_SELECTOR), true));
        updateAssetSelectionState(form, scope);
      });
    }

    const clearButton = form.querySelector('[data-clear-selection]');
    if (clearButton) {
      clearButton.addEventListener('click', () => {
        checkboxes.forEach((checkbox) => { checkbox.checked = false; });
        checkboxes.forEach((checkbox) => updateAssetCardState(checkbox.closest?.(ASSET_CARD_SELECTOR), false));
        updateAssetSelectionState(form, scope);
      });
    }

    const releaseSelect = form.querySelector('[data-release-select]');
    if (releaseSelect) {
      releaseSelect.addEventListener('change', () => updateAssetSelectionState(form, scope));
    }

    // Establish correct initial state on load — e.g. after a validation
    // failure re-render where some checkboxes are pre-checked from the
    // submitted selection, the count and submit-enabled state must reflect
    // that immediately, not just after the next change event.
    updateAssetSelectionState(form, scope);
  });

  const cards = scope.querySelectorAll(ASSET_CARD_SELECTOR);
  cards.forEach((card) => {
    const checkbox = card.querySelector(ASSET_SELECTION_CHECKBOX_SELECTOR);
    if (!checkbox || card.dataset.assetSelectionBound === 'true') return;

    card.dataset.assetSelectionBound = 'true';
    const toggle = (event) => {
      const interactive = event.target?.closest?.(ASSET_CARD_INTERACTIVE_SELECTOR);
      if (interactive && card.contains?.(interactive)) return;
      checkbox.checked = !checkbox.checked;
      updateAssetCardState(card, checkbox.checked);
      const form = checkbox.form;
      if (form) updateAssetSelectionState(form, scope);
    };
    card.addEventListener('click', toggle);
    card.addEventListener('keydown', (event) => {
      if (event.target !== card || !['Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      toggle(event);
    });
  });

  return forms.length;
}

function setHidden(element, hidden) {
  if (!element) return;
  if (hidden) element.setAttribute?.('hidden', '');
  else element.removeAttribute?.('hidden');
}

function focusAssetRenameInput(editor) {
  const input = editor.querySelector?.('[data-asset-rename-input]');
  if (!input) return;
  input.focus?.();
  input.select?.();
}

export function enhanceAssetRenames(scope = globalThis.document) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;

  const triggers = scope.querySelectorAll(ASSET_RENAME_TRIGGER_SELECTOR);
  triggers.forEach((trigger) => {
    if (isEnhancementBound(trigger, 'assetRenameBound')) return;

    const region = trigger.closest?.('.asset-card-title-controls');
    const titleRow = region?.querySelector?.('[data-asset-title-row]');
    const editor = region?.querySelector?.(ASSET_RENAME_EDITOR_SELECTOR);
    if (!titleRow || !editor) return;

    markEnhancementBound(trigger, 'assetRenameBound');

    const setEditing = (editing, { focus = false } = {}) => {
      setHidden(titleRow, editing);
      setHidden(editor, !editing);
      if (editing && focus) focusAssetRenameInput(editor);
    };

    const closeEditor = () => {
      setEditing(false);
      trigger.focus?.();
    };

    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      setEditing(true, { focus: true });
    });

    editor.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || editor.hidden === true) return;
      event.preventDefault();
      closeEditor();
    });

    const cancel = editor.querySelector?.('[data-asset-rename-cancel]');
    cancel?.addEventListener('click', (event) => {
      event.preventDefault();
      closeEditor();
    });

    const initiallyEditing = editor.hidden !== true;
    setEditing(initiallyEditing, { focus: initiallyEditing });
  });

  return triggers.length;
}

function readAssetGridSize() {
  try {
    const stored = globalThis.localStorage?.getItem(ASSET_GRID_SIZE_STORAGE_KEY);
    return Object.prototype.hasOwnProperty.call(ASSET_GRID_SIZES, stored) ? stored : 'default';
  } catch {
    return 'default';
  }
}

function writeAssetGridSize(size) {
  try {
    globalThis.localStorage?.setItem(ASSET_GRID_SIZE_STORAGE_KEY, size);
  } catch {
    // Storage can be unavailable or blocked; the current page still works.
  }
}

function applyAssetGridSize(scope, size) {
  const grids = scope.querySelectorAll(ASSET_GRID_SELECTOR);
  grids.forEach((grid) => {
    if (size === 'default') {
      grid.removeAttribute('data-grid-size');
      grid.style?.removeProperty('--asset-card-min');
    } else {
      grid.setAttribute('data-grid-size', size);
      grid.style?.setProperty('--asset-card-min', ASSET_GRID_SIZES[size]);
    }
  });

  scope.querySelectorAll(`${ASSET_GRID_SIZE_CONTROL_SELECTOR} [data-grid-size]`).forEach((control) => {
    control.setAttribute('aria-pressed', String(control.dataset.gridSize === size));
  });
}

export function enhanceAssetGridSize(scope = globalThis.document) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;
  const controls = scope.querySelectorAll(ASSET_GRID_SIZE_CONTROL_SELECTOR);
  const grids = scope.querySelectorAll(ASSET_GRID_SELECTOR);
  if (controls.length === 0 || grids.length === 0) return 0;

  applyAssetGridSize(scope, readAssetGridSize());
  controls.forEach((group) => {
    group.querySelectorAll('[data-grid-size]').forEach((control) => {
      if (isEnhancementBound(control, 'assetGridSizeBound')) return;
      markEnhancementBound(control, 'assetGridSizeBound');
      control.addEventListener('click', () => {
        const size = control.dataset.gridSize;
        if (!Object.prototype.hasOwnProperty.call(ASSET_GRID_SIZES, size)) return;
        writeAssetGridSize(size);
        applyAssetGridSize(scope, size);
      });
    });
  });
  return controls.length;
}

if (typeof document !== 'undefined') {
  const run = () => {
    enhancePreviewMedia(document);
    enhanceAutoSubmit(document);
    enhanceConfirmations(document);
    enhanceAssetSelection(document);
    enhanceAssetRenames(document);
    enhanceAssetGridSize(document);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }
}
