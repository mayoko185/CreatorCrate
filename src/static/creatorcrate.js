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
// such attribute, so it is untouched by this module. No local storage, no
// network requests: selection state lives only in the DOM's checked/
// unchecked state for the lifetime of this page.

const ASSET_SELECTION_FORM_SELECTOR = '[data-asset-selection-form]';
const ASSET_SELECTION_CHECKBOX_SELECTOR = 'input[type="checkbox"][name="selectedAssetIds"]:not(:disabled)';

function getAssetSelectionCheckboxes(form) {
  return Array.from(form.querySelectorAll(ASSET_SELECTION_CHECKBOX_SELECTOR));
}

function updateAssetSelectionState(form) {
  const checkboxes = getAssetSelectionCheckboxes(form);
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
  forms.forEach((form) => {
    // Missing-asset rows render a disabled checkbox (or none at all) — the
    // selector above already excludes disabled checkboxes, so Select All /
    // Clear / the live count can never touch them.
    const checkboxes = getAssetSelectionCheckboxes(form);
    checkboxes.forEach((checkbox) => {
      checkbox.addEventListener('change', () => updateAssetSelectionState(form));
    });

    const selectAllButton = form.querySelector('[data-select-all]');
    if (selectAllButton) {
      selectAllButton.addEventListener('click', () => {
        checkboxes.forEach((checkbox) => { checkbox.checked = true; });
        updateAssetSelectionState(form);
      });
    }

    const clearButton = form.querySelector('[data-clear-selection]');
    if (clearButton) {
      clearButton.addEventListener('click', () => {
        checkboxes.forEach((checkbox) => { checkbox.checked = false; });
        updateAssetSelectionState(form);
      });
    }

    const releaseSelect = form.querySelector('[data-release-select]');
    if (releaseSelect) {
      releaseSelect.addEventListener('change', () => updateAssetSelectionState(form));
    }

    // Establish correct initial state on load — e.g. after a validation
    // failure re-render where some checkboxes are pre-checked from the
    // submitted selection, the count and submit-enabled state must reflect
    // that immediately, not just after the next change event.
    updateAssetSelectionState(form);
  });

  return forms.length;
}

if (typeof document !== 'undefined') {
  const run = () => {
    enhancePreviewMedia(document);
    enhanceAutoSubmit(document);
    enhanceConfirmations(document);
    enhanceAssetSelection(document);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }
}
