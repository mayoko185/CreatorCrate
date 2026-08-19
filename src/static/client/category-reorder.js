import {
  isEnhancementBound,
  markEnhancementBound,
} from './dom.js';

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
