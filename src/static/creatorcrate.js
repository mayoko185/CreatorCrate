const PREVIEW_ROOT_SELECTOR = '[data-preview-enhancement]';
const PREVIEW_IMAGE_SELECTOR = '[data-preview-image]';
const PREVIEW_FALLBACK_SELECTOR = '[data-preview-fallback]';
const PROJECT_CARD_SELECTOR = '[data-project-card]';
const PROJECT_CARD_LINK_SELECTOR = '[data-project-card-link]';
const PROJECT_CARD_INTERACTIVE_SELECTOR = [
  'a',
  'button',
  'form',
  'input',
  'select',
  'textarea',
  'label',
  'details',
  'summary',
  '[contenteditable]',
  '[role="button"]',
  '[tabindex]',
].join(', ');

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

export function enhanceProjectCards(scope = globalThis.document) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;

  const cards = scope.querySelectorAll(PROJECT_CARD_SELECTOR);
  cards.forEach((card) => {
    if (isEnhancementBound(card, 'projectCardBound')) return;

    const link = card.querySelector?.(PROJECT_CARD_LINK_SELECTOR);
    if (!link || typeof link.click !== 'function') return;

    markEnhancementBound(card, 'projectCardBound');
    card.addEventListener('click', (event) => {
      if (event.defaultPrevented || event.button !== 0
        || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const interactive = event.target?.closest?.(PROJECT_CARD_INTERACTIVE_SELECTOR);
      if (interactive && (typeof card.contains !== 'function' || card.contains(interactive))) return;

      link.click();
    });
  });
  return cards.length;
}

export function enhanceAutoSubmit(scope = globalThis.document) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;
  const controls = scope.querySelectorAll('[data-autosubmit]');
  controls.forEach((control) => {
    if (isEnhancementBound(control, 'autoSubmitBound')) return;
    markEnhancementBound(control, 'autoSubmitBound');

    const state = {
      confirmedChecked: Boolean(control.checked),
      pending: false,
      requestedChecked: Boolean(control.checked),
    };

    control.addEventListener('change', (event) => {
      const form = control.form;
      if (!form) return;

      event.preventDefault?.();

      if (state.pending) {
        control.checked = state.requestedChecked;
        return;
      }

      const previousChecked = state.confirmedChecked;
      const requestedChecked = Boolean(control.checked);
      state.pending = true;
      state.requestedChecked = requestedChecked;
      form.setAttribute?.('aria-busy', 'true');
      form.setAttribute?.('data-category-enabled-state', 'pending');
      const status = form.querySelector?.('[data-category-enabled-status]');
      if (status) status.textContent = 'Saving category status.';

      Promise.resolve().then(() => {
        if (typeof globalThis.fetch !== 'function' || typeof globalThis.FormData !== 'function'
          || typeof globalThis.URLSearchParams !== 'function') {
          throw new Error('In-place category status updates are unavailable.');
        }

        const action = form.action || form.getAttribute?.('action');
        const method = String(form.method || form.getAttribute?.('method') || 'POST').toUpperCase();
        return globalThis.fetch(action, {
          method,
          // Send as application/x-www-form-urlencoded (not multipart/form-data):
          // the server only parses urlencoded/JSON bodies, so a raw FormData
          // request would arrive with an empty req.body and fail CSRF (403).
          body: new globalThis.URLSearchParams(new globalThis.FormData(form)),
          credentials: 'same-origin',
          redirect: 'follow',
        });
      }).then((response) => {
        if (!response?.ok) throw new Error('Category status update failed.');
        state.confirmedChecked = requestedChecked;
        state.pending = false;
        form.removeAttribute?.('aria-busy');
        form.removeAttribute?.('data-category-enabled-state');
        if (status) status.textContent = `${requestedChecked ? 'Enabled' : 'Disabled'} status saved.`;
      }).catch(() => {
        control.checked = previousChecked;
        state.confirmedChecked = previousChecked;
        state.pending = false;
        form.removeAttribute?.('aria-busy');
        form.setAttribute?.('data-category-enabled-state', 'error');
        if (status) status.textContent = 'Could not save category status. The previous status was restored.';
      });
    });
  });
  return controls.length;
}

const CATEGORY_REORDER_LIST_SELECTOR = '[data-category-reorder-list]';
const CATEGORY_REORDER_ITEM_SELECTOR = '[data-category-reorder-item]';
const CATEGORY_REORDER_HANDLE_SELECTOR = '[data-category-reorder-handle]';
const CATEGORY_REORDER_EXCLUDED_SELECTOR = [
  'a',
  'button',
  'input',
  'select',
  'textarea',
  // NB: the whole <form> is intentionally NOT excluded. The Settings card wraps
  // its display-name/slug fields in a single <form> (for "Save details"); if the
  // form were excluded, the bulk of the card would be non-draggable and only the
  // handle could start a drag (unlike the project card, whose fields aren't in a
  // form). Individual controls below (input/button/label/select/textarea/…) stay
  // excluded, so drags still can't start on an actual interactive element.
  'label',
  'summary',
  'details',
  '[contenteditable]',
  '[role="alert"]',
  '[aria-live]',
  '.help-text',
  '.field-error-message',
  'noscript',
].join(', ');

function categoryElementIsInside(item, element) {
  if (!item || !element) return false;
  if (item === element) return true;
  return typeof item.contains !== 'function' || item.contains(element);
}

function categoryTargetIsExcluded(target, item) {
  if (!target || !item) return false;
  const handle = target.closest?.(CATEGORY_REORDER_HANDLE_SELECTOR);
  if (categoryElementIsInside(item, handle)) return false;
  const excluded = target.closest?.(CATEGORY_REORDER_EXCLUDED_SELECTOR);
  return categoryElementIsInside(item, excluded);
}

function categoryHasSelectedText(item) {
  const selection = globalThis.getSelection?.();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return false;
  return categoryElementIsInside(item, selection.anchorNode)
    || categoryElementIsInside(item, selection.focusNode);
}

function categoryReorderItems(list) {
  return Array.from(list?.querySelectorAll?.(CATEGORY_REORDER_ITEM_SELECTOR) || []);
}

function categoryId(item) {
  return item?.dataset?.categoryId || item?.getAttribute?.('data-category-id') || '';
}

function categoryLabel(item) {
  return item?.dataset?.categoryLabel
    || item?.getAttribute?.('data-category-label')
    || `Category ${categoryId(item)}`;
}

function categoryOrder(list) {
  return categoryReorderItems(list).map((item) => categoryId(item));
}

function sameCategoryOrder(left, right) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function updateCategoryOrderMetadata(list) {
  const items = categoryReorderItems(list);
  items.forEach((item, index) => {
    item.setAttribute?.('aria-posinset', String(index + 1));
    item.setAttribute?.('aria-setsize', String(items.length));
  });
  return items;
}

function findCategoryReorderForm(list, scope) {
  const formId = list?.getAttribute?.('data-reorder-form-target') || list?.dataset?.reorderFormTarget;
  const document = list?.ownerDocument;
  if (formId && document?.getElementById) {
    const form = document.getElementById(formId);
    if (form) return form;
  }
  const parent = list?.parentElement || list?.parentNode;
  return parent?.querySelector?.('[data-category-reorder-form]')
    || scope?.querySelector?.('[data-category-reorder-form]')
    || null;
}

function categoryReorderLiveRegion(list, scope) {
  const parent = list?.parentElement || list?.parentNode;
  return parent?.querySelector?.('[data-category-reorder-live]')
    || scope?.querySelector?.('[data-category-reorder-live]')
    || null;
}

function clearCategoryDropIndicator(state) {
  if (!state.dropItem) return;
  state.dropItem.classList?.remove('is-drop-before', 'is-drop-after');
  state.dropItem.removeAttribute?.('data-drop-position');
  state.dropItem = null;
  state.dropBefore = null;
}

function setCategoryDropIndicator(state, item, before) {
  if (state.dropItem !== item) clearCategoryDropIndicator(state);
  state.dropItem = item;
  state.dropBefore = before;
  item.classList?.toggle('is-drop-before', before);
  item.classList?.toggle('is-drop-after', !before);
  item.setAttribute?.('data-drop-position', before ? 'before' : 'after');
}

function resolveCategoryDropTarget(list, event, draggedItem) {
  const target = event.target?.closest?.(CATEGORY_REORDER_ITEM_SELECTOR);
  if (target && categoryElementIsInside(list, target) && target !== draggedItem) {
    const rect = target.getBoundingClientRect?.();
    const before = rect && Number.isFinite(event.clientY)
      ? event.clientY < rect.top + (rect.height / 2)
      : true;
    return { item: target, before };
  }

  const remaining = categoryReorderItems(list).filter((item) => item !== draggedItem);
  return remaining.length > 0 ? { item: remaining[remaining.length - 1], before: false } : null;
}

function moveCategoryItemToIndex(list, item, targetIndex) {
  const items = categoryReorderItems(list);
  const currentIndex = items.indexOf(item);
  if (currentIndex === -1 || currentIndex === targetIndex) return false;

  const remaining = items.filter((candidate) => candidate !== item);
  const reference = remaining[targetIndex];
  if (reference) list.insertBefore(item, reference);
  else list.appendChild(item);
  return true;
}

function moveCategoryItemToDropTarget(list, item, target, before) {
  if (!target || target === item) return false;
  if (before) {
    list.insertBefore(item, target);
  } else if (target.nextSibling && target.nextSibling !== item) {
    list.insertBefore(item, target.nextSibling);
  } else if (target.nextSibling !== item) {
    list.appendChild(item);
  }
  return true;
}

function restoreCategoryOrder(state) {
  const itemsById = new Map(categoryReorderItems(state.list).map((item) => [categoryId(item), item]));
  state.confirmedIds.forEach((id) => {
    const item = itemsById.get(id);
    if (item) state.list.appendChild(item);
  });
  updateCategoryOrderMetadata(state.list);
}

function announceCategoryReorderFailure(state) {
  if (state.live) state.live.textContent = 'Could not update the category order. The previous order was restored.';
}

function persistCategoryOrder(state, { item = null, keyboard = false } = {}) {
  const currentIds = categoryOrder(state.list);
  if (sameCategoryOrder(currentIds, state.confirmedIds)) return false;
  if (state.submitting) return false;

  const input = state.form.querySelector?.('[data-category-order-input]');
  if (!input) {
    restoreCategoryOrder(state);
    announceCategoryReorderFailure(state);
    return false;
  }

  state.submitting = true;
  state.pendingItem = item;
  state.pendingKeyboard = keyboard;
  state.pendingFocus = keyboard
    ? item?.querySelector?.(CATEGORY_REORDER_HANDLE_SELECTOR)
    : null;
  input.value = currentIds.join(',');
  state.form.setAttribute?.('aria-busy', 'true');
  state.form.setAttribute?.('data-category-reorder-state', 'pending');

  Promise.resolve().then(() => {
    if (typeof globalThis.fetch !== 'function' || typeof globalThis.FormData !== 'function'
      || typeof globalThis.URLSearchParams !== 'function') {
      throw new Error('In-place category reorder is unavailable.');
    }

    const action = state.form.action || state.form.getAttribute?.('action');
    const method = String(state.form.method || state.form.getAttribute?.('method') || 'POST').toUpperCase();
    return globalThis.fetch(action, {
      method,
      // Send urlencoded, not multipart — the server only parses urlencoded/JSON
      // bodies, so a raw FormData request would fail CSRF (403). See enhanceAutoSubmit.
      body: new globalThis.URLSearchParams(new globalThis.FormData(state.form)),
      credentials: 'same-origin',
      redirect: 'follow',
    });
  }).then((response) => {
    if (!response?.ok) throw new Error('Category reorder failed.');
    state.confirmedIds = categoryOrder(state.list);
    state.submitting = false;
    state.form.removeAttribute?.('aria-busy');
    state.form.removeAttribute?.('data-category-reorder-state');
    state.pendingItem = null;
    state.pendingKeyboard = false;
    state.pendingFocus = null;
  }).catch(() => {
    const focusTarget = state.pendingKeyboard ? state.pendingFocus : null;
    state.submitting = false;
    state.form.removeAttribute?.('aria-busy');
    state.form.setAttribute?.('data-category-reorder-state', 'error');
    restoreCategoryOrder(state);
    announceCategoryReorderFailure(state);
    focusTarget?.focus?.();
    state.pendingItem = null;
    state.pendingKeyboard = false;
    state.pendingFocus = null;
  });

  return true;
}

function announceCategoryMove(state, item) {
  const items = updateCategoryOrderMetadata(state.list);
  const index = items.indexOf(item);
  if (index === -1) return;
  const live = state.live;
  if (live) live.textContent = `${categoryLabel(item)} moved to position ${index + 1} of ${items.length}.`;
}

function finishCategoryDrag(state) {
  const draggedItem = state.draggedItem;
  if (draggedItem) {
    draggedItem.classList?.remove('is-dragging');
    draggedItem.setAttribute?.('aria-grabbed', 'false');
  }
  state.list.classList?.remove('is-dragging');
  clearCategoryDropIndicator(state);
  state.draggedItem = null;
  state.dragAllowed = true;
}

export function enhanceCategoryReorder(scope = globalThis.document) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;

  const lists = scope.querySelectorAll(CATEGORY_REORDER_LIST_SELECTOR);
  lists.forEach((list) => {
    if (isEnhancementBound(list, 'categoryReorderBound')) return;

    const items = categoryReorderItems(list);
    const form = findCategoryReorderForm(list, scope);
    if (!form || items.length === 0) return;

    const state = {
      list,
      form,
      live: categoryReorderLiveRegion(list, scope),
      confirmedIds: categoryOrder(list),
      draggedItem: null,
      dropItem: null,
      dropBefore: null,
      dragAllowed: true,
      submitting: false,
      pendingItem: null,
      pendingKeyboard: false,
      pendingFocus: null,
    };

    markEnhancementBound(list, 'categoryReorderBound');
    updateCategoryOrderMetadata(list);

    items.forEach((item) => {
      const rememberPointerOrigin = (event) => {
        state.dragAllowed = (event.button === undefined || event.button === 0)
          && !categoryTargetIsExcluded(event.target, item)
          && !categoryHasSelectedText(item);
      };
      const resetPointerOrigin = () => { state.dragAllowed = true; };

      item.addEventListener?.('pointerdown', rememberPointerOrigin);
      item.addEventListener?.('mousedown', rememberPointerOrigin);
      item.addEventListener?.('pointerup', resetPointerOrigin);
      item.addEventListener?.('pointercancel', resetPointerOrigin);

      item.addEventListener?.('dragstart', (event) => {
        const targetAllowed = !categoryTargetIsExcluded(event.target, item)
          && !categoryHasSelectedText(item);
        if (state.submitting || !state.dragAllowed || !targetAllowed) {
          event.preventDefault?.();
          return;
        }

        state.draggedItem = item;
        item.classList?.add('is-dragging');
        item.setAttribute?.('aria-grabbed', 'true');
        list.classList?.add('is-dragging');
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData?.('text/plain', categoryId(item));
        }
      });

      item.addEventListener?.('dragend', () => finishCategoryDrag(state));

      const handle = item.querySelector?.(CATEGORY_REORDER_HANDLE_SELECTOR);
      handle?.addEventListener?.('keydown', (event) => {
        const keyTargets = { ArrowUp: -1, ArrowDown: 1, Home: 0, End: items.length - 1 };
        if (!Object.prototype.hasOwnProperty.call(keyTargets, event.key)) return;

        event.preventDefault?.();
        if (state.submitting) return;
        const currentIndex = categoryReorderItems(list).indexOf(item);
        if (currentIndex === -1) return;
        const targetIndex = event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? categoryReorderItems(list).length - 1
            : currentIndex + keyTargets[event.key];
        const currentItems = categoryReorderItems(list);
        if (targetIndex < 0 || targetIndex >= currentItems.length || targetIndex === currentIndex) return;

        if (moveCategoryItemToIndex(list, item, targetIndex)) {
          announceCategoryMove(state, item);
          handle.focus?.();
          persistCategoryOrder(state, { item, keyboard: true });
        }
      });
    });

    list.addEventListener?.('dragover', (event) => {
      if (!state.draggedItem) return;
      event.preventDefault?.();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      const target = resolveCategoryDropTarget(list, event, state.draggedItem);
      if (target) setCategoryDropIndicator(state, target.item, target.before);
      else clearCategoryDropIndicator(state);
    });

    list.addEventListener?.('dragleave', (event) => {
      const relatedTarget = event.relatedTarget;
      if (!relatedTarget || !list.contains?.(relatedTarget)) clearCategoryDropIndicator(state);
    });

    list.addEventListener?.('drop', (event) => {
      if (!state.draggedItem) return;
      event.preventDefault?.();
      const draggedItem = state.draggedItem;
      const target = state.dropItem
        ? { item: state.dropItem, before: state.dropBefore }
        : resolveCategoryDropTarget(list, event, draggedItem);
      const beforeIds = categoryOrder(list);
      if (target) moveCategoryItemToDropTarget(list, draggedItem, target.item, target.before);
      const moved = !sameCategoryOrder(beforeIds, categoryOrder(list));
      finishCategoryDrag(state);
      if (moved) {
        updateCategoryOrderMetadata(list);
        persistCategoryOrder(state, { item: draggedItem });
      }
    });
  });

  return lists.length;
}

const CATEGORY_DETAILS_FORM_SELECTOR = '[data-category-details-form]';

// In-place submit for the Settings "Save details" form. A native submit does a
// POST→redirect→GET, which reloads the whole page and jumps the scroll position
// back to the top. Instead we POST via fetch: on success the server issues its
// redirect (response.redirected === true) and the edited values are already in
// the inputs, so we just show a saved status without navigating. On a validation
// error the server re-renders the page directly (no redirect), so we fall back to
// a native submit to surface the server-rendered error state. The <noscript>-free
// native submit remains the behavior when fetch/FormData/URLSearchParams are
// unavailable.
export function enhanceCategoryDetails(scope = globalThis.document) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;
  const forms = scope.querySelectorAll(CATEGORY_DETAILS_FORM_SELECTOR);
  forms.forEach((form) => {
    if (isEnhancementBound(form, 'categoryDetailsBound')) return;
    markEnhancementBound(form, 'categoryDetailsBound');

    let pending = false;
    form.addEventListener('submit', (event) => {
      if (pending) {
        event.preventDefault?.();
        return;
      }
      if (typeof globalThis.fetch !== 'function' || typeof globalThis.FormData !== 'function'
        || typeof globalThis.URLSearchParams !== 'function') {
        return; // No enhancement available — let the native submit proceed.
      }

      event.preventDefault?.();
      pending = true;
      const status = form.querySelector?.('[data-category-details-status]');
      form.setAttribute?.('aria-busy', 'true');
      form.setAttribute?.('data-category-details-state', 'pending');
      if (status) status.textContent = 'Saving category details.';

      const action = form.action || form.getAttribute?.('action');
      const method = String(form.method || form.getAttribute?.('method') || 'POST').toUpperCase();
      globalThis.fetch(action, {
        method,
        body: new globalThis.URLSearchParams(new globalThis.FormData(form)),
        credentials: 'same-origin',
        redirect: 'follow',
      }).then((response) => {
        if (response?.ok && response.redirected) {
          pending = false;
          form.removeAttribute?.('aria-busy');
          form.removeAttribute?.('data-category-details-state');
          if (status) status.textContent = 'Details saved.';
          return;
        }
        // Validation or other non-redirect response: submit natively so the
        // server-rendered error state is shown.
        form.submit?.();
      }).catch(() => {
        form.submit?.();
      });
    });
  });
  return forms.length;
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

function setAssetRenameControlsDisabled(editor, disabled) {
  const controls = editor.querySelectorAll?.('input, button, select, textarea') || [];
  controls.forEach((control) => {
    control.disabled = disabled;
    if (disabled) control.setAttribute?.('disabled', '');
    else control.removeAttribute?.('disabled');
  });
}

function setAssetRenameInert(editor, inert) {
  if (inert) editor.setAttribute?.('inert', '');
  else editor.removeAttribute?.('inert');
}

function syncAssetRenameState(editor, editing) {
  setAssetRenameControlsDisabled(editor, !editing);
  setAssetRenameInert(editor, !editing);
  setHidden(editor, !editing);
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
    const region = trigger.closest?.('.asset-card-title-controls');
    const titleRow = region?.querySelector?.('[data-asset-title-row]');
    const editor = region?.querySelector?.(ASSET_RENAME_EDITOR_SELECTOR);
    if (!titleRow || !editor) return;

    const setEditing = (editing, { focus = false } = {}) => {
      setHidden(titleRow, editing);
      syncAssetRenameState(editor, editing);
      if (editing && focus) focusAssetRenameInput(editor);
    };

    const initiallyEditing = editor.hidden !== true;
    if (isEnhancementBound(trigger, 'assetRenameBound')) {
      setEditing(initiallyEditing);
      return;
    }

    markEnhancementBound(trigger, 'assetRenameBound');

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
    enhanceProjectCards(document);
    enhanceAutoSubmit(document);
    enhanceCategoryReorder(document);
    enhanceCategoryDetails(document);
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
