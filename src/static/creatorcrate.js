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
  const previewLink = image?.closest?.('.asset-preview-link');

  setPreviewState(root, 'failed');
  hideElement(image);
  hideElement(previewLink);
  showElement(fallback);
  return 'failed';
}

export function enhancePreview(root) {
  if (!root || typeof root.querySelector !== 'function') return 'skipped';

  const image = root.querySelector(PREVIEW_IMAGE_SELECTOR);
  if (!image) return 'skipped';
  if (isEnhancementBound(root, 'previewBound')) {
    return root.dataset?.previewState === 'failed'
      ? 'failed'
      : root.dataset?.previewState === 'loaded'
        ? 'loaded'
        : 'listening';
  }
  markEnhancementBound(root, 'previewBound');

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
    if (control.form?.matches?.('.page-size-form')) {
      return;
    }
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

const NOTE_REORDER_LIST_SELECTOR = '[data-note-reorder-list]';
const NOTE_REORDER_ITEM_SELECTOR = '[data-note-reorder-item]';
const NOTE_REORDER_HANDLE_SELECTOR = '[data-note-reorder-handle]';

function noteReorderItems(list) {
  return Array.from(list?.querySelectorAll?.(NOTE_REORDER_ITEM_SELECTOR) || []);
}

function noteReorderId(item) {
  return item?.dataset?.noteId || item?.getAttribute?.('data-note-id') || '';
}

function noteReorderLabel(item) {
  return item?.dataset?.noteLabel
    || item?.getAttribute?.('data-note-label')
    || `Note ${noteReorderId(item)}`;
}

function noteReorderOrder(list) {
  return noteReorderItems(list).map((item) => noteReorderId(item));
}

function sameNoteReorder(left, right) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function updateNoteReorderMetadata(list) {
  const items = noteReorderItems(list);
  items.forEach((item, index) => {
    item.setAttribute?.('aria-posinset', String(index + 1));
    item.setAttribute?.('aria-setsize', String(items.length));
  });
  return items;
}

function findNoteReorderForm(list, scope) {
  const formId = list?.getAttribute?.('data-reorder-form-target') || list?.dataset?.reorderFormTarget;
  const document = list?.ownerDocument;
  if (formId && document?.getElementById) {
    const form = document.getElementById(formId);
    if (form) return form;
  }
  const parent = list?.parentElement || list?.parentNode;
  return parent?.querySelector?.('[data-note-reorder-form]')
    || scope?.querySelector?.('[data-note-reorder-form]')
    || null;
}

function noteReorderLiveRegion(list, scope) {
  const parent = list?.parentElement || list?.parentNode;
  return parent?.querySelector?.('[data-note-reorder-live]')
    || scope?.querySelector?.('[data-note-reorder-live]')
    || null;
}

function noteElementIsInside(item, element) {
  if (!item || !element) return false;
  if (item === element) return true;
  return typeof item.contains !== 'function' || item.contains(element);
}

function clearNoteDropIndicator(state) {
  if (!state.dropItem) return;
  state.dropItem.classList?.remove('is-drop-before', 'is-drop-after');
  state.dropItem.removeAttribute?.('data-drop-position');
  state.dropItem = null;
  state.dropBefore = null;
}

function setNoteDropIndicator(state, item, before) {
  if (state.dropItem !== item) clearNoteDropIndicator(state);
  state.dropItem = item;
  state.dropBefore = before;
  item.classList?.toggle('is-drop-before', before);
  item.classList?.toggle('is-drop-after', !before);
  item.setAttribute?.('data-drop-position', before ? 'before' : 'after');
}

function resolveNoteDropTarget(list, event, draggedItem) {
  const target = event.target?.closest?.(NOTE_REORDER_ITEM_SELECTOR);
  if (target && noteElementIsInside(list, target) && target !== draggedItem) {
    const rect = target.getBoundingClientRect?.();
    const before = rect && Number.isFinite(event.clientY)
      ? event.clientY < rect.top + (rect.height / 2)
      : true;
    return { item: target, before };
  }

  const remaining = noteReorderItems(list).filter((item) => item !== draggedItem);
  return remaining.length > 0 ? { item: remaining[remaining.length - 1], before: false } : null;
}

function moveNoteItemToIndex(list, item, targetIndex) {
  const items = noteReorderItems(list);
  const currentIndex = items.indexOf(item);
  if (currentIndex === -1 || currentIndex === targetIndex) return false;

  const remaining = items.filter((candidate) => candidate !== item);
  const reference = remaining[targetIndex];
  if (reference) list.insertBefore(item, reference);
  else list.appendChild(item);
  return true;
}

function moveNoteItemToDropTarget(list, item, target, before) {
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

function restoreNoteReorder(state) {
  const itemsById = new Map(noteReorderItems(state.list).map((item) => [noteReorderId(item), item]));
  state.confirmedIds.forEach((id) => {
    const item = itemsById.get(id);
    if (item) state.list.appendChild(item);
  });
  updateNoteReorderMetadata(state.list);
}

function announceNoteReorderFailure(state) {
  if (state.live) state.live.textContent = 'Could not update the note order. The previous order was restored.';
}

function persistNoteReorder(state, { item = null, keyboard = false } = {}) {
  const currentIds = noteReorderOrder(state.list);
  if (sameNoteReorder(currentIds, state.confirmedIds)) return false;
  if (state.submitting) return false;

  const input = state.form.querySelector?.('[data-note-order-input]');
  if (!input) {
    restoreNoteReorder(state);
    announceNoteReorderFailure(state);
    return false;
  }

  state.submitting = true;
  state.pendingKeyboard = keyboard;
  state.pendingFocus = keyboard
    ? item?.querySelector?.(NOTE_REORDER_HANDLE_SELECTOR)
    : null;
  input.value = currentIds.join(',');
  state.form.setAttribute?.('aria-busy', 'true');
  state.form.setAttribute?.('data-note-reorder-state', 'pending');

  Promise.resolve().then(() => {
    if (typeof globalThis.fetch !== 'function' || typeof globalThis.FormData !== 'function'
      || typeof globalThis.URLSearchParams !== 'function') {
      throw new Error('In-place note reorder is unavailable.');
    }

    const action = state.form.action || state.form.getAttribute?.('action');
    const method = String(state.form.method || state.form.getAttribute?.('method') || 'POST').toUpperCase();
    return globalThis.fetch(action, {
      method,
      // Send urlencoded, not multipart — the server parses the same form
      // representation as the category reorder flow and CSRF middleware.
      body: new globalThis.URLSearchParams(new globalThis.FormData(state.form)),
      credentials: 'same-origin',
      redirect: 'follow',
    });
  }).then((response) => {
    if (!response?.ok) throw new Error('Note reorder failed.');
    state.confirmedIds = noteReorderOrder(state.list);
    state.submitting = false;
    state.form.removeAttribute?.('aria-busy');
    state.form.removeAttribute?.('data-note-reorder-state');
    state.pendingKeyboard = false;
    state.pendingFocus = null;
  }).catch(() => {
    const focusTarget = state.pendingKeyboard ? state.pendingFocus : null;
    state.submitting = false;
    state.form.removeAttribute?.('aria-busy');
    state.form.setAttribute?.('data-note-reorder-state', 'error');
    restoreNoteReorder(state);
    announceNoteReorderFailure(state);
    focusTarget?.focus?.();
    state.pendingKeyboard = false;
    state.pendingFocus = null;
  });

  return true;
}

function announceNoteMove(state, item) {
  const items = updateNoteReorderMetadata(state.list);
  const index = items.indexOf(item);
  if (index === -1) return;
  if (state.live) state.live.textContent = `${noteReorderLabel(item)} moved to position ${index + 1} of ${items.length}.`;
}

function finishNoteDrag(state) {
  const draggedItem = state.draggedItem;
  if (draggedItem) {
    draggedItem.classList?.remove('is-dragging');
    draggedItem.setAttribute?.('aria-grabbed', 'false');
  }
  state.list.classList?.remove('is-dragging');
  clearNoteDropIndicator(state);
  state.draggedItem = null;
}

export function enhanceNoteReorder(scope = globalThis.document) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;

  const lists = scope.querySelectorAll(NOTE_REORDER_LIST_SELECTOR);
  lists.forEach((list) => {
    if (isEnhancementBound(list, 'noteReorderBound')) return;

    const items = noteReorderItems(list);
    const form = findNoteReorderForm(list, scope);
    const handles = items.map((item) => item.querySelector?.(NOTE_REORDER_HANDLE_SELECTOR));
    if (!form || items.length === 0 || handles.some((handle) => !handle)) return;

    const state = {
      list,
      form,
      live: noteReorderLiveRegion(list, scope),
      confirmedIds: noteReorderOrder(list),
      draggedItem: null,
      dropItem: null,
      dropBefore: null,
      submitting: false,
      pendingKeyboard: false,
      pendingFocus: null,
    };

    markEnhancementBound(list, 'noteReorderBound');
    updateNoteReorderMetadata(list);

    items.forEach((item) => {
      const handle = item.querySelector?.(NOTE_REORDER_HANDLE_SELECTOR);

      item.addEventListener?.('dragstart', (event) => {
        const handleTarget = event.target?.closest?.(NOTE_REORDER_HANDLE_SELECTOR);
        if (state.submitting || !noteElementIsInside(item, handleTarget)) {
          event.preventDefault?.();
          return;
        }

        state.draggedItem = item;
        item.classList?.add('is-dragging');
        item.setAttribute?.('aria-grabbed', 'true');
        list.classList?.add('is-dragging');
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData?.('text/plain', noteReorderId(item));
        }
      });

      item.addEventListener?.('dragend', () => finishNoteDrag(state));

      handle.addEventListener?.('keydown', (event) => {
        const keyTargets = { ArrowUp: -1, ArrowDown: 1, Home: 0, End: items.length - 1 };
        if (!Object.prototype.hasOwnProperty.call(keyTargets, event.key)) return;

        event.preventDefault?.();
        if (state.submitting) return;
        const currentItems = noteReorderItems(list);
        const currentIndex = currentItems.indexOf(item);
        if (currentIndex === -1) return;
        const targetIndex = event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? currentItems.length - 1
            : currentIndex + keyTargets[event.key];
        if (targetIndex < 0 || targetIndex >= currentItems.length || targetIndex === currentIndex) return;

        if (moveNoteItemToIndex(list, item, targetIndex)) {
          announceNoteMove(state, item);
          handle.focus?.();
          persistNoteReorder(state, { item, keyboard: true });
        }
      });
    });

    list.addEventListener?.('dragover', (event) => {
      if (!state.draggedItem) return;
      event.preventDefault?.();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      const target = resolveNoteDropTarget(list, event, state.draggedItem);
      if (target) setNoteDropIndicator(state, target.item, target.before);
      else clearNoteDropIndicator(state);
    });

    list.addEventListener?.('dragleave', (event) => {
      const relatedTarget = event.relatedTarget;
      if (!relatedTarget || !list.contains?.(relatedTarget)) clearNoteDropIndicator(state);
    });

    list.addEventListener?.('drop', (event) => {
      if (!state.draggedItem) return;
      event.preventDefault?.();
      const draggedItem = state.draggedItem;
      const target = state.dropItem
        ? { item: state.dropItem, before: state.dropBefore }
        : resolveNoteDropTarget(list, event, draggedItem);
      const beforeIds = noteReorderOrder(list);
      if (target) moveNoteItemToDropTarget(list, draggedItem, target.item, target.before);
      const moved = !sameNoteReorder(beforeIds, noteReorderOrder(list));
      finishNoteDrag(state);
      if (moved) {
        updateNoteReorderMetadata(list);
        persistNoteReorder(state, { item: draggedItem });
      }
    });
  });

  return lists.length;
}

const BOOK_REORDER_LIST_SELECTOR = '[data-book-reorder-list]';
const BOOK_REORDER_ITEM_SELECTOR = '[data-book-reorder-item]';
const BOOK_REORDER_HANDLE_SELECTOR = '[data-book-reorder-handle]';

const CHAPTER_PAGE_REORDER_LIST_SELECTOR = '[data-chapter-page-reorder-list]';
const CHAPTER_PAGE_REORDER_ITEM_SELECTOR = '[data-chapter-page-reorder-item]';
const CHAPTER_PAGE_REORDER_HANDLE_SELECTOR = '[data-chapter-page-reorder-handle]';

const BOOK_CONTENT_REORDER_LIST_SELECTOR = '[data-book-content-reorder-list]';
const BOOK_CONTENT_REORDER_ITEM_SELECTOR = '[data-book-content-reorder-item]';
const BOOK_CONTENT_REORDER_HANDLE_SELECTOR = '[data-book-content-reorder-handle]';

function dedicatedReorderItems(list, config) {
  return Array.from(list?.querySelectorAll?.(config.itemSelector) || []);
}

function dedicatedReorderId(item, config) {
  return item?.dataset?.[config.idDataset]
    || item?.getAttribute?.(config.idAttribute)
    || '';
}

function dedicatedReorderLabel(item, config) {
  return item?.dataset?.[config.labelDataset]
    || item?.getAttribute?.(config.labelAttribute)
    || `${config.label} ${dedicatedReorderId(item, config)}`;
}

function dedicatedReorderOrder(list, config) {
  return dedicatedReorderItems(list, config).map((item) => dedicatedReorderId(item, config));
}

function sameDedicatedReorder(left, right) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function updateDedicatedReorderMetadata(list, config) {
  const items = dedicatedReorderItems(list, config);
  items.forEach((item, index) => {
    item.setAttribute?.('aria-posinset', String(index + 1));
    item.setAttribute?.('aria-setsize', String(items.length));
    const position = item.querySelector?.(config.positionSelector);
    if (position) position.textContent = `Position ${index + 1} of ${items.length}`;
  });
  return items;
}

function findDedicatedReorderForm(list, scope, config) {
  const formId = list?.getAttribute?.('data-reorder-form-target') || list?.dataset?.reorderFormTarget;
  const document = list?.ownerDocument;
  if (formId && document?.getElementById) {
    const form = document.getElementById(formId);
    if (form) return form;
  }
  const parent = list?.parentElement || list?.parentNode;
  return parent?.querySelector?.(config.formSelector)
    || scope?.querySelector?.(config.formSelector)
    || null;
}

function dedicatedReorderLiveRegion(list, scope, config) {
  const parent = list?.parentElement || list?.parentNode;
  return parent?.querySelector?.(config.liveSelector)
    || scope?.querySelector?.(config.liveSelector)
    || null;
}

function syncDedicatedReorderInput(state, config) {
  const input = state.form.querySelector?.(config.inputSelector);
  if (!input) return false;
  input.value = dedicatedReorderOrder(state.list, config).join(',');
  return true;
}

function dedicatedReorderElementIsInside(item, element) {
  if (!item || !element) return false;
  if (item === element) return true;
  return typeof item.contains !== 'function' || item.contains(element);
}

function clearDedicatedDropIndicator(state) {
  if (!state.dropItem) return;
  state.dropItem.classList?.remove('is-drop-before', 'is-drop-after');
  state.dropItem.removeAttribute?.('data-drop-position');
  state.dropItem = null;
  state.dropBefore = null;
}

function setDedicatedDropIndicator(state, item, before) {
  if (state.dropItem !== item) clearDedicatedDropIndicator(state);
  state.dropItem = item;
  state.dropBefore = before;
  item.classList?.toggle('is-drop-before', before);
  item.classList?.toggle('is-drop-after', !before);
  item.setAttribute?.('data-drop-position', before ? 'before' : 'after');
}

function resolveDedicatedDropTarget(list, event, draggedItem, config) {
  const target = event.target?.closest?.(config.itemSelector);
  if (target === draggedItem) return null;
  if (target && dedicatedReorderElementIsInside(list, target)) {
    const rect = target.getBoundingClientRect?.();
    const before = rect && Number.isFinite(event.clientY)
      ? event.clientY < rect.top + (rect.height / 2)
      : true;
    return { item: target, before };
  }

  const remaining = dedicatedReorderItems(list, config).filter((item) => item !== draggedItem);
  return remaining.length > 0 ? { item: remaining[remaining.length - 1], before: false } : null;
}

function moveDedicatedItemToIndex(list, item, targetIndex, config) {
  const items = dedicatedReorderItems(list, config);
  const currentIndex = items.indexOf(item);
  if (currentIndex === -1 || currentIndex === targetIndex) return false;

  const remaining = items.filter((candidate) => candidate !== item);
  const reference = remaining[targetIndex];
  if (reference) list.insertBefore(item, reference);
  else list.appendChild(item);
  return true;
}

function moveDedicatedItemToDropTarget(list, item, target, before) {
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

function announceDedicatedMove(state, item, config) {
  const items = updateDedicatedReorderMetadata(state.list, config);
  const index = items.indexOf(item);
  if (index === -1) return;
  if (state.live) {
    state.live.textContent = `${dedicatedReorderLabel(item, config)} moved to position ${index + 1} of ${items.length}.`;
  }
}

function finishDedicatedDrag(state) {
  const draggedItem = state.draggedItem;
  if (draggedItem) draggedItem.classList?.remove('is-dragging');
  state.list.classList?.remove('is-dragging');
  clearDedicatedDropIndicator(state);
  state.draggedItem = null;
}

function enhanceDedicatedReorder(scope, config) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;

  const lists = scope.querySelectorAll(config.listSelector);
  lists.forEach((list) => {
    if (isEnhancementBound(list, config.bindingKey)) return;

    const items = dedicatedReorderItems(list, config);
    const form = findDedicatedReorderForm(list, scope, config);
    const handles = items.map((item) => item.querySelector?.(config.handleSelector));
    if (!form || items.length === 0 || handles.some((handle) => !handle)) return;

    const state = {
      list,
      form,
      live: dedicatedReorderLiveRegion(list, scope, config),
      draggedItem: null,
      dropItem: null,
      dropBefore: null,
    };

    markEnhancementBound(list, config.bindingKey);
    updateDedicatedReorderMetadata(list, config);
    syncDedicatedReorderInput(state, config);

    form.addEventListener?.('submit', () => {
      syncDedicatedReorderInput(state, config);
    });

    items.forEach((item) => {
      const handle = item.querySelector?.(config.handleSelector);

      item.addEventListener?.('dragstart', (event) => {
        const handleTarget = event.target?.closest?.(config.handleSelector);
        if (!dedicatedReorderElementIsInside(item, handleTarget)) {
          event.preventDefault?.();
          return;
        }

        state.draggedItem = item;
        item.classList?.add('is-dragging');
        list.classList?.add('is-dragging');
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData?.('text/plain', dedicatedReorderId(item, config));
        }
      });

      item.addEventListener?.('dragend', () => finishDedicatedDrag(state));

      handle.addEventListener?.('keydown', (event) => {
        const keyTargets = { ArrowUp: -1, ArrowDown: 1, Home: 0, End: items.length - 1 };
        if (!Object.prototype.hasOwnProperty.call(keyTargets, event.key)) return;

        event.preventDefault?.();
        const currentItems = dedicatedReorderItems(list, config);
        const currentIndex = currentItems.indexOf(item);
        if (currentIndex === -1) return;
        const targetIndex = event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? currentItems.length - 1
            : currentIndex + keyTargets[event.key];
        if (targetIndex < 0 || targetIndex >= currentItems.length || targetIndex === currentIndex) return;

        if (moveDedicatedItemToIndex(list, item, targetIndex, config)) {
          announceDedicatedMove(state, item, config);
          syncDedicatedReorderInput(state, config);
          handle.focus?.();
        }
      });
    });

    list.addEventListener?.('dragover', (event) => {
      if (!state.draggedItem) return;
      event.preventDefault?.();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      const target = resolveDedicatedDropTarget(list, event, state.draggedItem, config);
      if (target) setDedicatedDropIndicator(state, target.item, target.before);
      else clearDedicatedDropIndicator(state);
    });

    list.addEventListener?.('dragleave', (event) => {
      const relatedTarget = event.relatedTarget;
      if (!relatedTarget || !list.contains?.(relatedTarget)) clearDedicatedDropIndicator(state);
    });

    list.addEventListener?.('drop', (event) => {
      if (!state.draggedItem) return;
      event.preventDefault?.();
      const draggedItem = state.draggedItem;
      const target = state.dropItem
        ? { item: state.dropItem, before: state.dropBefore }
        : resolveDedicatedDropTarget(list, event, draggedItem, config);
      const beforeIds = dedicatedReorderOrder(list, config);
      if (target) moveDedicatedItemToDropTarget(list, draggedItem, target.item, target.before);
      finishDedicatedDrag(state);
      const afterIds = dedicatedReorderOrder(list, config);
      if (!sameDedicatedReorder(beforeIds, afterIds)) {
        updateDedicatedReorderMetadata(list, config);
        syncDedicatedReorderInput(state, config);
      }
    });
  });

  return lists.length;
}

export function enhanceBookReorder(scope = globalThis.document) {
  return enhanceDedicatedReorder(scope, {
    listSelector: BOOK_REORDER_LIST_SELECTOR,
    itemSelector: BOOK_REORDER_ITEM_SELECTOR,
    handleSelector: BOOK_REORDER_HANDLE_SELECTOR,
    formSelector: '[data-book-reorder-form]',
    inputSelector: '[data-book-order-input]',
    liveSelector: '[data-book-reorder-live]',
    positionSelector: '[data-book-order-position]',
    idDataset: 'bookId',
    idAttribute: 'data-book-id',
    labelDataset: 'bookLabel',
    labelAttribute: 'data-book-label',
    label: 'Book',
    bindingKey: 'bookReorderBound',
  });
}

export function enhanceChapterPageReorder(scope = globalThis.document) {
  return enhanceDedicatedReorder(scope, {
    listSelector: CHAPTER_PAGE_REORDER_LIST_SELECTOR,
    itemSelector: CHAPTER_PAGE_REORDER_ITEM_SELECTOR,
    handleSelector: CHAPTER_PAGE_REORDER_HANDLE_SELECTOR,
    formSelector: '[data-chapter-page-reorder-form]',
    inputSelector: '[data-chapter-page-order-input]',
    liveSelector: '[data-chapter-page-reorder-live]',
    positionSelector: '[data-chapter-page-order-position]',
    idDataset: 'noteId',
    idAttribute: 'data-note-id',
    labelDataset: 'noteLabel',
    labelAttribute: 'data-note-label',
    label: 'Page',
    bindingKey: 'chapterPageReorderBound',
  });
}

export function enhanceBookContentReorder(scope = globalThis.document) {
  return enhanceDedicatedReorder(scope, {
    listSelector: BOOK_CONTENT_REORDER_LIST_SELECTOR,
    itemSelector: BOOK_CONTENT_REORDER_ITEM_SELECTOR,
    handleSelector: BOOK_CONTENT_REORDER_HANDLE_SELECTOR,
    formSelector: '[data-book-content-reorder-form]',
    inputSelector: '[data-book-content-order-input]',
    liveSelector: '[data-book-content-reorder-live]',
    positionSelector: '[data-book-content-order-position]',
    idDataset: 'contentKey',
    idAttribute: 'data-content-key',
    labelDataset: 'contentLabel',
    labelAttribute: 'data-content-label',
    label: 'Book content',
    bindingKey: 'bookContentReorderBound',
  });
}

const NOTE_EDITOR_FORM_SELECTOR = '[data-notes-editor-form]';
const NOTE_EDITOR_HOST_SELECTOR = '[data-notes-editor-host]';
const NOTE_EDITOR_SOURCE_SELECTOR = '[data-notes-editor-source]';
const NOTES_CODE_BLOCK_SELECTOR = '.notes-content pre > code';
const NOTES_CODE_COPY_BUTTON_SELECTOR = '.notes-code-copy';
const NOTES_CODE_COPY_FEEDBACK_MS = 1200;
const NOTE_EDITOR_TOOLBAR_ITEMS = [
  ['heading', 'bold', 'italic', 'strike'],
  ['quote'],
  ['ul', 'ol', 'task'],
  ['link', 'table'],
  ['code', 'codeblock'],
];

let toastUiEditorLoad;
const pendingNotesEditorForms = new WeakSet();

function loadToastUiEditor() {
  if (!toastUiEditorLoad) {
    toastUiEditorLoad = Promise.all([
      import('@toast-ui/editor'),
      import('@toast-ui/editor/dist/toastui-editor.css'),
      import('@toast-ui/editor/dist/theme/toastui-editor-dark.css'),
    ]).then(([editorModule]) => {
      const Editor = editorModule.default;
      if (typeof Editor !== 'function') {
        throw new TypeError('The Notes editor module did not expose its default Editor constructor.');
      }
      return Editor;
    });
  }
  return toastUiEditorLoad;
}

function initializeNotesEditor({ form, host, textarea }, Editor) {
  let editor = null;
  try {
    editor = new Editor({
      el: host,
      initialValue: textarea.value,
      initialEditType: 'wysiwyg',
      hideModeSwitch: false,
      usageStatistics: false,
      autofocus: false,
      height: 'auto',
      theme: 'dark',
      toolbarItems: NOTE_EDITOR_TOOLBAR_ITEMS,
    });

    if (typeof editor.getMarkdown !== 'function' || typeof editor.removeHook !== 'function') {
      editor.destroy?.();
      return;
    }

    editor.removeHook('addImageBlobHook');
  } catch {
    editor?.destroy?.();
    return;
  }

  form.addEventListener('submit', () => {
    textarea.value = editor.getMarkdown();
  });
  textarea.hidden = true;
  textarea.setAttribute?.('hidden', '');
  markEnhancementBound(form, 'notesEditorBound');
}

export function enhanceNotesEditor(scope = globalThis.document, { loadEditor = loadToastUiEditor } = {}) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;

  const forms = scope.querySelectorAll(NOTE_EDITOR_FORM_SELECTOR);
  const targets = [];
  forms.forEach((form) => {
    if (isEnhancementBound(form, 'notesEditorBound') || pendingNotesEditorForms.has(form)) return;

    const host = form.querySelector?.(NOTE_EDITOR_HOST_SELECTOR);
    const textarea = form.querySelector?.(NOTE_EDITOR_SOURCE_SELECTOR);
    if (!host || !textarea || typeof form.addEventListener !== 'function') return;

    pendingNotesEditorForms.add(form);
    targets.push({ form, host, textarea });
  });

  if (targets.length === 0) return forms.length;

  let editorLoad;
  try {
    editorLoad = Promise.resolve(loadEditor());
  } catch (error) {
    editorLoad = Promise.reject(error);
  }

  editorLoad.then((Editor) => {
    if (typeof Editor !== 'function') {
      throw new TypeError('The Notes editor loader did not return an Editor constructor.');
    }
    targets.forEach((target) => {
      pendingNotesEditorForms.delete(target.form);
      initializeNotesEditor(target, Editor);
    });
  }).catch((error) => {
    targets.forEach((target) => pendingNotesEditorForms.delete(target.form));
    globalThis.console?.warn?.(
      '[CreatorCrate] Notes editor enhancement failed; the Markdown textarea remains available.',
      error,
    );
  });

  return forms.length;
}

function notesCodeCopyFeedback(button, label, ariaLabel) {
  button.textContent = label;
  button.setAttribute?.('aria-label', ariaLabel);
}

function bindNotesCodeCopyButton(button, code) {
  if (!button || isEnhancementBound(button, 'notesCodeCopyBound')) return;

  button.type = 'button';
  button.className = 'button button-small notes-code-copy';
  notesCodeCopyFeedback(button, 'Copy', 'Copy code');
  button.setAttribute?.('title', 'Copy code');

  const clipboard = globalThis.navigator?.clipboard;
  if (typeof clipboard?.writeText !== 'function') {
    button.disabled = true;
    button.setAttribute?.('aria-disabled', 'true');
    button.setAttribute?.('title', 'Copying is unavailable in this browser.');
    markEnhancementBound(button, 'notesCodeCopyBound');
    return;
  }

  let copying = false;
  let feedbackTimer = null;
  const restoreCopyLabel = () => {
    feedbackTimer = null;
    notesCodeCopyFeedback(button, 'Copy', 'Copy code');
  };

  button.addEventListener('click', async () => {
    if (copying) return;
    copying = true;
    button.disabled = true;
    if (feedbackTimer !== null) globalThis.clearTimeout?.(feedbackTimer);

    try {
      await clipboard.writeText(code.textContent);
      notesCodeCopyFeedback(button, 'Copied', 'Code copied');
    } catch {
      notesCodeCopyFeedback(button, 'Copy failed', 'Copy code failed');
    } finally {
      copying = false;
      button.disabled = false;
      feedbackTimer = globalThis.setTimeout?.(restoreCopyLabel, NOTES_CODE_COPY_FEEDBACK_MS) ?? null;
    }
  });

  markEnhancementBound(button, 'notesCodeCopyBound');
}

export function enhanceNotesCodeBlocks(scope = globalThis.document) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;

  const blocks = scope.querySelectorAll(NOTES_CODE_BLOCK_SELECTOR);
  blocks.forEach((code) => {
    const pre = code?.parentElement || code?.parentNode;
    const document = code?.ownerDocument || globalThis.document;
    if (!pre || !document || typeof document.createElement !== 'function') return;

    let button = pre.querySelector?.(NOTES_CODE_COPY_BUTTON_SELECTOR);
    if (!button) {
      button = document.createElement('button');
      pre.insertBefore?.(button, pre.firstChild || null);
    }
    pre.classList?.add('notes-code-block-enhanced');
    bindNotesCodeCopyButton(button, code);
  });

  return blocks.length;
}

const NOTES_ASSET_PICKER_SELECTOR = '[data-notes-asset-picker]';
const NOTES_ASSET_PICKER_PROJECT_SEARCH_SELECTOR = '#note-asset-picker-project-search';
const NOTES_ASSET_PICKER_PROJECT_RESULTS_SELECTOR = '#note-asset-picker-project-results';
const NOTES_ASSET_PICKER_ASSET_SEARCH_SELECTOR = '#note-asset-picker-asset-search';
const NOTES_ASSET_PICKER_ASSET_RESULTS_SELECTOR = '#note-asset-picker-asset-results';
const NOTES_ASSET_PICKER_LOAD_MORE_SELECTOR = '.notes-asset-picker-load-more';
const NOTES_ASSET_PICKER_STATUS_SELECTOR = '#note-asset-picker-status';
const NOTES_ASSET_PICKER_ERROR_SELECTOR = '#note-asset-picker-error';
const NOTES_ASSET_PICKER_SELECTED_PROJECT_SELECTOR = '[data-notes-asset-picker-selected-project]';
const NOTES_ASSET_PICKER_NO_JS_SELECTOR = '.notes-asset-picker-no-js';
const NOTES_SELECTED_ASSETS_SELECTOR = '.notes-selected-assets';
const NOTES_SELECTED_ASSET_SELECTOR = '.notes-selected-asset';
const NOTES_SELECTED_ASSETS_EMPTY_SELECTOR = '.notes-selected-assets-empty';
const NOTES_ASSET_PICKER_REMOVE_SELECTOR = '[data-notes-asset-picker-remove]';
const NOTES_ASSET_PICKER_ADD_SELECTOR = '[data-notes-asset-picker-add]';
const NOTES_ASSET_PICKER_DEBOUNCE_MS = 250;
const NOTES_ASSET_PICKER_MIN_QUERY_LENGTH = 2;
const NOTES_ASSET_PICKER_MAX_QUERY_LENGTH = 100;

function notesAssetPickerDocument(host) {
  return host?.ownerDocument || globalThis.document;
}

function clearNotesAssetPickerElement(element) {
  if (!element) return;
  if (typeof element.replaceChildren === 'function') {
    element.replaceChildren();
    return;
  }
  while (element.firstChild && typeof element.removeChild === 'function') {
    element.removeChild(element.firstChild);
  }
}

function setNotesAssetPickerDisabled(control, disabled) {
  if (!control) return;
  control.disabled = disabled;
  if (disabled) control.setAttribute?.('disabled', '');
  else control.removeAttribute?.('disabled');
}

function notesAssetPickerStatus(state, message) {
  if (state.status && state.status.textContent !== message) state.status.textContent = message;
}

function notesAssetPickerError(state, message) {
  if (state.error && state.error.textContent !== message) state.error.textContent = message;
}

function notesAssetPickerQuery(input) {
  return String(input?.value || '')
    .trim()
    .slice(0, NOTES_ASSET_PICKER_MAX_QUERY_LENGTH);
}

function notesAssetPickerRequestUrl(endpoint, params) {
  const endpointString = String(endpoint || '');
  const hashIndex = endpointString.indexOf('#');
  const base = hashIndex === -1 ? endpointString : endpointString.slice(0, hashIndex);
  const hash = hashIndex === -1 ? '' : endpointString.slice(hashIndex);
  const separator = base.includes('?')
    ? (base.endsWith('?') || base.endsWith('&') ? '' : '&')
    : '?';
  const query = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  return `${base}${separator}${query}${hash}`;
}

function notesAssetPickerSelectedProjectElement(state) {
  const existing = state.host.querySelector?.(NOTES_ASSET_PICKER_SELECTED_PROJECT_SELECTOR);
  if (existing) return existing;

  const document = notesAssetPickerDocument(state.host);
  if (!document || typeof document.createElement !== 'function') return null;

  const selected = document.createElement('p');
  selected.className = 'notes-asset-picker-selected-project';
  selected.setAttribute('data-notes-asset-picker-selected-project', '');
  hideElement(selected);

  const parent = state.projectResults.parentNode;
  if (parent && typeof parent.insertBefore === 'function') parent.insertBefore(selected, state.projectResults);
  else state.host.appendChild?.(selected);
  return selected;
}

function notesAssetPickerProjectTitle(project) {
  const title = project?.title;
  if (typeof title === 'string' && title.length > 0) return title;
  return `Project ${project?.id ?? ''}`.trim();
}

function renderNotesAssetPickerProjects(state, projects) {
  clearNotesAssetPickerElement(state.projectResults);
  const document = notesAssetPickerDocument(state.host);
  if (!document || typeof document.createElement !== 'function') return;

  projects.forEach((project) => {
    if (!project || project.id === undefined || project.id === null) return;

    const item = document.createElement('li');
    item.className = 'notes-asset-picker-result';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button button-secondary notes-asset-picker-result-control';

    const title = document.createElement('span');
    title.className = 'notes-asset-picker-result-title';
    title.textContent = notesAssetPickerProjectTitle(project);
    button.appendChild(title);

    const archived = Boolean(project.archived);
    if (archived) {
      const marker = document.createElement('span');
      marker.className = 'notes-asset-picker-result-state';
      marker.textContent = ' (Archived)';
      button.appendChild(marker);
    }

    button.addEventListener('click', () => selectNotesAssetPickerProject(state, project));
    item.appendChild(button);
    state.projectResults.appendChild(item);
  });
}

function notesAssetPickerAssetId(asset) {
  if (!asset || asset.id === undefined || asset.id === null) return null;
  return String(asset.id);
}

function notesAssetPickerAssetFilename(asset) {
  if (typeof asset?.filename === 'string' && asset.filename.length > 0) return asset.filename;
  return `Asset ${asset?.id ?? ''}`.trim();
}

function notesAssetPickerFormControls(state) {
  const controls = state.form?.elements
    ? Array.from(state.form.elements)
    : (state.form?.querySelectorAll?.('input') || []);
  return controls.filter((control) => control?.name === 'assetIds[]');
}

function notesAssetPickerControlId(control) {
  if (!control || control.name !== 'assetIds[]' || control.value === undefined || control.value === null) {
    return null;
  }
  const value = String(control.value);
  return value.length > 0 ? value : null;
}

function notesAssetPickerSelectedIds(state) {
  return new Set(
    notesAssetPickerFormControls(state)
      .map((control) => (
        control.checked === true && control.disabled !== true
          ? notesAssetPickerControlId(control)
          : null
      ))
      .filter((assetId) => assetId !== null),
  );
}

function notesAssetPickerRowForControl(state, control) {
  const closest = control?.closest?.(NOTES_SELECTED_ASSET_SELECTOR);
  if (closest) return closest;

  let parent = control?.parentNode || null;
  while (parent && parent !== state.form) {
    if (parent.matches?.(NOTES_SELECTED_ASSET_SELECTOR)) return parent;
    parent = parent.parentNode;
  }

  const rows = state.selectedAssets?.querySelectorAll?.(NOTES_SELECTED_ASSET_SELECTOR) || [];
  return Array.from(rows).find((row) => row.querySelector?.('input') === control) || null;
}

function removeNotesAssetPickerNode(node) {
  if (node?.parentNode?.removeChild) node.parentNode.removeChild(node);
}

function deduplicateNotesAssetPickerControls(state) {
  const controlsById = new Map();
  notesAssetPickerFormControls(state).forEach((control) => {
    const assetId = notesAssetPickerControlId(control);
    if (assetId === null) return;
    const controls = controlsById.get(assetId) || [];
    controls.push(control);
    controlsById.set(assetId, controls);
  });

  controlsById.forEach((controls) => {
    const keeper = controls.find((control) => control.checked === true && control.disabled !== true)
      || controls[0];
    controls.forEach((control) => {
      if (control === keeper) return;
      const row = notesAssetPickerRowForControl(state, control);
      if (row) removeNotesAssetPickerNode(row);
      else removeNotesAssetPickerNode(control);
    });
  });
}

function notesAssetPickerSelectedAssetRow(state, assetId) {
  const rows = state.selectedAssets?.querySelectorAll?.(NOTES_SELECTED_ASSET_SELECTOR) || [];
  return Array.from(rows).find((row) => {
    if (row.getAttribute?.('data-notes-selected-asset-id') === assetId) return true;
    return notesAssetPickerControlId(row.querySelector?.('input')) === assetId;
  }) || null;
}

function notesAssetPickerSelectedAssetEmptyElement(state) {
  const existing = state.form?.querySelector?.(NOTES_SELECTED_ASSETS_EMPTY_SELECTOR);
  if (existing) return existing;

  const document = notesAssetPickerDocument(state.host);
  if (!document || typeof document.createElement !== 'function' || !state.selectedAssets) return null;
  const empty = document.createElement('p');
  empty.className = 'notes-selected-assets-empty';
  empty.textContent = 'No assets selected.';
  state.selectedAssets.parentNode?.appendChild?.(empty);
  return empty;
}

function notesAssetPickerRefreshSelectedAssetList(state) {
  const selectedIds = notesAssetPickerSelectedIds(state);
  const empty = notesAssetPickerSelectedAssetEmptyElement(state);
  if (empty) {
    if (selectedIds.size === 0) showElement(empty);
    else hideElement(empty);
  }

  state.selectedAssets?.querySelectorAll?.(NOTES_SELECTED_ASSET_SELECTOR)
    .forEach((row) => bindNotesAssetPickerSelectedAssetRow(state, row));
  state.assetRows?.forEach((_asset, assetId) => {
    setNotesAssetPickerCandidateSelected(state, assetId, selectedIds.has(assetId));
  });
}

function appendNotesSelectedAssetMetadata(details, asset, projectTitle, isProjectArchived, document) {
  const filename = notesAssetPickerAssetFilename(asset);
  const filenameElement = document.createElement('span');
  filenameElement.className = 'notes-selected-asset-filename';
  filenameElement.textContent = filename;
  details.appendChild(filenameElement);

  const projectElement = document.createElement('span');
  projectElement.className = 'notes-selected-asset-project';
  projectElement.textContent = `Project: ${projectTitle}`;
  details.appendChild(projectElement);

  const relativePath = typeof asset?.relativePath === 'string' ? asset.relativePath : '';
  if (relativePath.length > 0 && relativePath !== filename) {
    const pathElement = document.createElement('span');
    pathElement.className = 'notes-selected-asset-path';
    pathElement.textContent = `Path: ${relativePath}`;
    details.appendChild(pathElement);
  }

  if (isProjectArchived) {
    const marker = document.createElement('span');
    marker.className = 'notes-selected-asset-state notes-selected-asset-state--archived';
    marker.textContent = 'Archived project';
    details.appendChild(marker);
  }

  if (asset?.isPresent === false) {
    const marker = document.createElement('span');
    marker.className = 'notes-selected-asset-state notes-selected-asset-state--missing';
    marker.textContent = 'Missing';
    details.appendChild(marker);
  }
}

function addNotesAssetPickerRemoveButton(state, row, input, assetId) {
  if (row.querySelector?.(NOTES_ASSET_PICKER_REMOVE_SELECTOR)) return;
  const document = notesAssetPickerDocument(state.host);
  if (!document || typeof document.createElement !== 'function') return;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'button button-secondary notes-selected-asset-remove';
  button.setAttribute('data-notes-asset-picker-remove', '');
  button.textContent = 'Remove';
  button.addEventListener('click', () => deselectNotesAssetPickerAsset(state, assetId));
  row.appendChild(button);
  if (input) input.notesAssetPickerRemoveButton = button;
}

function bindNotesAssetPickerSelectedAssetRow(state, row) {
  const input = row.querySelector?.('input');
  const assetId = notesAssetPickerControlId(input);
  if (!input || assetId === null) return;

  row.setAttribute?.('data-notes-selected-asset-id', assetId);
  if (!input.notesAssetPickerSelectionBound) {
    input.notesAssetPickerSelectionBound = true;
    input.addEventListener('change', () => {
      if (!input.checked) {
        deselectNotesAssetPickerAsset(state, assetId);
        return;
      }
      deduplicateNotesAssetPickerControls(state);
      notesAssetPickerRefreshSelectedAssetList(state);
    });
  }

  addNotesAssetPickerRemoveButton(state, row, input, assetId);
}

function createNotesAssetPickerSelectedAssetRow(state, asset, existingControl = null) {
  const assetId = notesAssetPickerAssetId(asset);
  const document = notesAssetPickerDocument(state.host);
  if (assetId === null || !document || typeof document.createElement !== 'function') return null;

  const filename = notesAssetPickerAssetFilename(asset);
  const row = document.createElement('li');
  row.className = 'notes-selected-asset';
  row.setAttribute('data-notes-selected-asset-id', assetId);

  const label = document.createElement('label');
  label.className = 'notes-selected-asset-control';

  const input = existingControl || document.createElement('input');
  if (existingControl?.parentNode) existingControl.parentNode.removeChild(existingControl);
  input.type = 'checkbox';
  input.name = 'assetIds[]';
  input.value = assetId;
  input.checked = true;
  input.disabled = false;
  if (!input.id) input.id = `note-asset-option-${assetId}`;
  input.setAttribute?.('name', 'assetIds[]');
  input.setAttribute?.('value', assetId);
  input.setAttribute?.('aria-label', `Deselect ${filename}`);

  const details = document.createElement('span');
  details.className = 'notes-selected-asset-details';
  const descriptionId = `note-asset-option-description-${assetId}`;
  details.id = descriptionId;
  details.setAttribute?.('id', descriptionId);
  input.setAttribute?.('aria-describedby', descriptionId);
  appendNotesSelectedAssetMetadata(
    details,
    asset,
    typeof asset?.projectTitle === 'string' && asset.projectTitle.length > 0
      ? asset.projectTitle
      : (state.selectedProject?.title || 'Selected project'),
    Boolean(asset?.isProjectArchived ?? state.selectedProject?.archived),
    document,
  );

  label.setAttribute?.('for', input.id);
  label.appendChild(input);
  label.appendChild(details);
  row.appendChild(label);
  if (state.selectedAssets) state.selectedAssets.appendChild(row);
  else state.form?.appendChild?.(input);
  bindNotesAssetPickerSelectedAssetRow(state, row);
  return row;
}

function ensureNotesAssetPickerSelectedAssetRow(state, asset, existingControl = null) {
  const assetId = notesAssetPickerAssetId(asset);
  if (assetId === null) return null;
  const existing = notesAssetPickerSelectedAssetRow(state, assetId);
  if (existing) {
    bindNotesAssetPickerSelectedAssetRow(state, existing);
    return existing;
  }
  return createNotesAssetPickerSelectedAssetRow(state, asset, existingControl);
}

function notesAssetPickerCandidateAction(state, assetId) {
  const row = state.assetRows?.get(assetId)
    || state.assetResults?.querySelector?.(`[data-notes-asset-picker-asset-id="${assetId}"]`);
  return row?.querySelector?.(NOTES_ASSET_PICKER_ADD_SELECTOR) || null;
}

function setNotesAssetPickerCandidateSelected(state, assetId, selected) {
  const row = state.assetRows?.get(assetId)
    || state.assetResults?.querySelector?.(`[data-notes-asset-picker-asset-id="${assetId}"]`);
  const action = row?.querySelector?.(NOTES_ASSET_PICKER_ADD_SELECTOR);
  if (!row || !action) return;

  action.textContent = selected ? 'Selected' : 'Add';
  setNotesAssetPickerDisabled(action, selected);
  if (selected) row.setAttribute('data-notes-asset-picker-selected', '');
  else row.removeAttribute?.('data-notes-asset-picker-selected');
}

function deselectNotesAssetPickerAsset(state, assetId) {
  notesAssetPickerFormControls(state)
    .filter((control) => notesAssetPickerControlId(control) === assetId)
    .forEach((control) => {
      const row = notesAssetPickerRowForControl(state, control);
      if (row) removeNotesAssetPickerNode(row);
      else removeNotesAssetPickerNode(control);
    });

  setNotesAssetPickerCandidateSelected(state, assetId, false);
  notesAssetPickerRefreshSelectedAssetList(state);
  const asset = state.assetItems?.get(assetId);
  notesAssetPickerStatus(
    state,
    `Removed ${notesAssetPickerAssetFilename(asset || { id: assetId })} from selected assets.`,
  );
  notesAssetPickerCandidateAction(state, assetId)?.focus?.();
}

function addNotesAssetPickerAsset(state, asset) {
  const assetId = notesAssetPickerAssetId(asset);
  if (assetId === null) return;

  deduplicateNotesAssetPickerControls(state);
  let control = notesAssetPickerFormControls(state)
    .find((candidate) => notesAssetPickerControlId(candidate) === assetId) || null;
  const alreadySelected = control?.checked === true && control.disabled !== true;
  if (!control) {
    const document = notesAssetPickerDocument(state.host);
    if (!document || typeof document.createElement !== 'function') return;
    control = document.createElement('input');
  }
  control.type = 'checkbox';
  control.name = 'assetIds[]';
  control.value = assetId;
  control.checked = true;
  control.disabled = false;
  ensureNotesAssetPickerSelectedAssetRow(state, asset, control);

  setNotesAssetPickerCandidateSelected(state, assetId, true);
  notesAssetPickerRefreshSelectedAssetList(state);
  if (!alreadySelected) {
    notesAssetPickerStatus(state, `Added ${notesAssetPickerAssetFilename(asset)} to selected assets.`);
  }
}

function renderNotesAssetPickerAssets(state) {
  clearNotesAssetPickerElement(state.assetResults);
  state.assetRows = new Map();
  const document = notesAssetPickerDocument(state.host);
  if (!document || typeof document.createElement !== 'function') return;
  const selectedIds = notesAssetPickerSelectedIds(state);

  state.assetItems.forEach((asset, assetId) => {
    const filename = notesAssetPickerAssetFilename(asset);
    const relativePath = typeof asset.relativePath === 'string' ? asset.relativePath : '';
    const hasUsefulPath = relativePath.length > 0 && relativePath !== filename;
    const missing = asset.isPresent === false;
    const selected = selectedIds.has(assetId);
    const item = document.createElement('li');
    item.className = 'notes-asset-picker-asset-result';
    item.tabIndex = 0;
    item.setAttribute('data-notes-asset-picker-asset-id', assetId);
    item.setAttribute('data-asset-id', assetId);
    item.setAttribute('aria-label', [
      filename,
      hasUsefulPath ? `Path: ${relativePath}` : '',
      missing ? 'Missing' : '',
      selected ? 'Selected' : '',
    ].filter(Boolean).join(', '));

    const details = document.createElement('span');
    details.className = 'notes-asset-picker-asset-details';

    const filenameElement = document.createElement('span');
    filenameElement.className = 'notes-asset-picker-asset-filename';
    filenameElement.textContent = filename;
    details.appendChild(filenameElement);

    if (hasUsefulPath) {
      const pathElement = document.createElement('span');
      pathElement.className = 'notes-asset-picker-asset-path';
      pathElement.textContent = `Path: ${relativePath}`;
      details.appendChild(pathElement);
    }

    if (missing) {
      const marker = document.createElement('span');
      marker.className = 'notes-asset-picker-asset-state notes-asset-picker-asset-state--missing';
      marker.textContent = 'Missing';
      details.appendChild(marker);
    }

    item.appendChild(details);
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'button button-secondary notes-asset-picker-asset-action';
    action.setAttribute('data-notes-asset-picker-add', '');
    action.textContent = selected ? 'Selected' : 'Add';
    setNotesAssetPickerDisabled(action, selected);
    action.addEventListener('click', () => addNotesAssetPickerAsset(state, asset));
    item.appendChild(action);
    state.assetResults.appendChild(item);
    state.assetRows.set(assetId, item);
  });
}

function setNotesAssetPickerLoadMoreEnabled(state, enabled) {
  setNotesAssetPickerDisabled(state.loadMoreButton, !enabled);
}

function abortNotesAssetPickerAssetRequest(state) {
  if (state.assetController) {
    state.assetController.abort();
    state.assetController = null;
  }
}

function resetNotesAssetPickerAssetResults(state) {
  state.assetQueryVersion += 1;
  abortNotesAssetPickerAssetRequest(state);
  if (state.assetTimer !== null) {
    clearTimeout(state.assetTimer);
    state.assetTimer = null;
  }
  state.assetItems.clear();
  state.assetNextCursor = null;
  state.assetLoadingMore = false;
  renderNotesAssetPickerAssets(state);
  setNotesAssetPickerLoadMoreEnabled(state, false);
}

function loadNotesAssetPickerAssets(state, { append = false, cursor = null } = {}) {
  const project = state.selectedProject;
  if (!project) return;

  const version = state.assetQueryVersion;
  const requestVersion = state.assetRequestVersion + 1;
  const projectId = project.id;
  const query = state.assetQuery;
  const controller = typeof globalThis.AbortController === 'function'
    ? new globalThis.AbortController()
    : null;
  state.assetRequestVersion = requestVersion;
  state.assetController = controller;
  state.assetLoadingMore = append;
  setNotesAssetPickerLoadMoreEnabled(state, false);
  notesAssetPickerError(state, '');
  notesAssetPickerStatus(
    state,
    append ? 'Loading more assets...' : (query ? 'Searching assets...' : 'Loading project assets...'),
  );

  const options = { method: 'GET', credentials: 'same-origin' };
  if (controller) options.signal = controller.signal;

  Promise.resolve().then(() => {
    if (typeof globalThis.fetch !== 'function') throw new Error('Asset search is unavailable.');
    return globalThis.fetch(notesAssetPickerRequestUrl(state.assetsEndpoint, {
      projectId,
      q: query,
      ...(append ? { cursor } : {}),
    }), options);
  }).then(async (response) => {
    if (!response || response.ok === false) throw new Error('Asset search failed.');
    if (typeof response.json !== 'function') throw new Error('Asset search returned invalid data.');
    return response.json();
  }).then((payload) => {
    if (
      version !== state.assetQueryVersion
      || requestVersion !== state.assetRequestVersion
      || state.selectedProject?.id !== projectId
    ) return;

    state.assetController = null;
    state.assetLoadingMore = false;
    if (!append) state.assetItems.clear();
    const assets = Array.isArray(payload?.items) ? payload.items : [];
    assets.forEach((asset) => {
      const assetId = notesAssetPickerAssetId(asset);
      if (assetId !== null && !state.assetItems.has(assetId)) state.assetItems.set(assetId, asset);
    });
    state.assetNextCursor = typeof payload?.nextCursor === 'string' && payload.nextCursor.length > 0
      ? payload.nextCursor
      : null;
    renderNotesAssetPickerAssets(state);
    setNotesAssetPickerLoadMoreEnabled(state, state.assetNextCursor !== null);
    notesAssetPickerError(state, '');
    notesAssetPickerStatus(
      state,
      state.assetItems.size === 0
        ? 'No assets found.'
        : `${state.assetItems.size} asset result${state.assetItems.size === 1 ? '' : 's'}.`,
    );
  }).catch((error) => {
    if (
      version !== state.assetQueryVersion
      || requestVersion !== state.assetRequestVersion
      || error?.name === 'AbortError'
    ) return;

    state.assetController = null;
    state.assetLoadingMore = false;
    setNotesAssetPickerLoadMoreEnabled(state, state.assetNextCursor !== null);
    notesAssetPickerStatus(
      state,
      append ? 'Loading more assets failed.' : (query ? 'Asset search failed.' : 'Loading project assets failed.'),
    );
    notesAssetPickerError(
      state,
      append ? 'Could not load more assets. Try again.' : 'Could not load project assets. Try again.',
    );
  });
}

function scheduleNotesAssetPickerAssetSearch(state) {
  state.assetQueryVersion += 1;
  const version = state.assetQueryVersion;
  abortNotesAssetPickerAssetRequest(state);
  if (state.assetTimer !== null) clearTimeout(state.assetTimer);

  state.assetTimer = null;
  state.assetQuery = notesAssetPickerQuery(state.assetSearch);
  state.assetItems.clear();
  state.assetNextCursor = null;
  state.assetLoadingMore = false;
  renderNotesAssetPickerAssets(state);
  setNotesAssetPickerLoadMoreEnabled(state, false);
  notesAssetPickerError(state, '');

  if (!state.selectedProject) return;

  notesAssetPickerStatus(state, state.assetQuery ? 'Searching assets...' : 'Loading project assets...');
  state.assetTimer = setTimeout(() => {
    if (version !== state.assetQueryVersion) return;
    state.assetTimer = null;
    loadNotesAssetPickerAssets(state);
  }, NOTES_ASSET_PICKER_DEBOUNCE_MS);
}

function loadMoreNotesAssetPickerAssets(state) {
  if (!state.selectedProject || state.assetLoadingMore || state.assetNextCursor === null) return;
  loadNotesAssetPickerAssets(state, { append: true, cursor: state.assetNextCursor });
}

function selectNotesAssetPickerProject(state, project) {
  state.queryVersion += 1;
  if (state.controller) {
    state.controller.abort();
    state.controller = null;
  }
  if (state.timer !== null) {
    clearTimeout(state.timer);
    state.timer = null;
  }

  const title = notesAssetPickerProjectTitle(project);
  const id = String(project.id);
  state.selectedProject = { id, title, archived: Boolean(project.archived) };
  state.host.dataset.selectedProjectId = id;

  if (state.selectedProjectElement) {
    state.selectedProjectElement.textContent = `Selected project: ${title}${project.archived ? ' (Archived)' : ''}`;
    showElement(state.selectedProjectElement);
  }

  clearNotesAssetPickerElement(state.projectResults);
  state.assetQuery = '';
  state.assetSearch.value = '';
  resetNotesAssetPickerAssetResults(state);
  setNotesAssetPickerDisabled(state.assetSearch, false);
  notesAssetPickerStatus(state, `Loading assets for ${title}...`);
  loadNotesAssetPickerAssets(state);
}

function searchNotesAssetPickerProjects(state, query) {
  if (state.queryVersion !== state.scheduledVersion) return;

  const version = state.queryVersion;
  const controller = typeof globalThis.AbortController === 'function'
    ? new globalThis.AbortController()
    : null;
  state.controller = controller;
  state.timer = null;
  notesAssetPickerStatus(state, 'Searching projects...');

  const options = { method: 'GET', credentials: 'same-origin' };
  if (controller) options.signal = controller.signal;

  Promise.resolve().then(() => {
    if (typeof globalThis.fetch !== 'function') throw new Error('Project search is unavailable.');
    return globalThis.fetch(notesAssetPickerRequestUrl(state.projectsEndpoint, { q: query }), options);
  }).then(async (response) => {
    if (!response || response.ok === false) throw new Error('Project search failed.');
    if (typeof response.json !== 'function') throw new Error('Project search returned invalid data.');
    return response.json();
  }).then((payload) => {
    if (version !== state.queryVersion) return;
    state.controller = null;
    const projects = Array.isArray(payload?.items) ? payload.items : [];
    renderNotesAssetPickerProjects(state, projects);
    notesAssetPickerError(state, '');
    notesAssetPickerStatus(
      state,
      projects.length === 0
        ? 'No projects found.'
        : `${projects.length} project result${projects.length === 1 ? '' : 's'}.`,
    );
  }).catch((error) => {
    if (version !== state.queryVersion || error?.name === 'AbortError') return;
    state.controller = null;
    notesAssetPickerStatus(state, 'Project search failed.');
    notesAssetPickerError(state, 'Could not search projects. Try again.');
  });
}

function scheduleNotesAssetPickerProjectSearch(state) {
  state.queryVersion += 1;
  state.scheduledVersion = state.queryVersion;
  if (state.controller) {
    state.controller.abort();
    state.controller = null;
  }
  if (state.timer !== null) clearTimeout(state.timer);

  const query = notesAssetPickerQuery(state.projectSearch);
  clearNotesAssetPickerElement(state.projectResults);
  notesAssetPickerError(state, '');

  if (query.length < NOTES_ASSET_PICKER_MIN_QUERY_LENGTH) {
    state.timer = null;
    notesAssetPickerStatus(state, 'Type at least 2 characters to search projects.');
    return;
  }

  notesAssetPickerStatus(state, '');
  state.timer = setTimeout(() => searchNotesAssetPickerProjects(state, query), NOTES_ASSET_PICKER_DEBOUNCE_MS);
}

export function enhanceNotesAssetPicker(scope = globalThis.document) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;

  const hosts = scope.querySelectorAll(NOTES_ASSET_PICKER_SELECTOR);
  hosts.forEach((host) => {
    if (isEnhancementBound(host, 'notesAssetPickerBound')) return;

    const projectSearch = host.querySelector?.(NOTES_ASSET_PICKER_PROJECT_SEARCH_SELECTOR);
    const projectResults = host.querySelector?.(NOTES_ASSET_PICKER_PROJECT_RESULTS_SELECTOR);
    const assetSearch = host.querySelector?.(NOTES_ASSET_PICKER_ASSET_SEARCH_SELECTOR);
    const assetResults = host.querySelector?.(NOTES_ASSET_PICKER_ASSET_RESULTS_SELECTOR);
    const loadMoreContainer = host.querySelector?.(NOTES_ASSET_PICKER_LOAD_MORE_SELECTOR);
    const loadMoreButton = loadMoreContainer?.querySelector?.('button');
    const status = host.querySelector?.(NOTES_ASSET_PICKER_STATUS_SELECTOR);
    const error = host.querySelector?.(NOTES_ASSET_PICKER_ERROR_SELECTOR);
    const document = notesAssetPickerDocument(host);
    const formId = host.dataset?.noteFormId || host.getAttribute?.('data-note-form-id') || '';
    const form = host.closest?.('form')
      || (formId ? document?.querySelector?.(`#${formId}`) : null);
    const selectedAssets = form?.querySelector?.(NOTES_SELECTED_ASSETS_SELECTOR) || null;
    const projectsEndpoint = host.dataset?.projectsUrl
      || host.getAttribute?.('data-projects-url')
      || '';
    if (!projectSearch || !projectResults || !assetSearch || !assetResults || !status || !error) return;

    const state = {
      host,
      form,
      selectedAssets,
      projectSearch,
      projectResults,
      assetSearch,
      assetResults,
      loadMoreButton,
      status,
      error,
      projectsEndpoint,
      assetsEndpoint: host.dataset?.assetsUrl
        || host.getAttribute?.('data-assets-url')
        || '',
      selectedProject: null,
      selectedProjectElement: null,
      assetQuery: '',
      controller: null,
      timer: null,
      queryVersion: 0,
      scheduledVersion: 0,
      assetController: null,
      assetTimer: null,
      assetQueryVersion: 0,
      assetRequestVersion: 0,
      assetItems: new Map(),
      assetRows: new Map(),
      assetNextCursor: null,
      assetLoadingMore: false,
    };
    state.selectedProjectElement = notesAssetPickerSelectedProjectElement(state);
    host.notesAssetPickerState = state;
    markEnhancementBound(host, 'notesAssetPickerBound');
    deduplicateNotesAssetPickerControls(state);
    notesAssetPickerRefreshSelectedAssetList(state);
    hideElement(host.querySelector?.(NOTES_ASSET_PICKER_NO_JS_SELECTOR));
    setNotesAssetPickerDisabled(assetSearch, true);
    setNotesAssetPickerLoadMoreEnabled(state, false);
    notesAssetPickerStatus(state, 'Type at least 2 characters to search projects.');

    projectSearch.addEventListener('input', () => scheduleNotesAssetPickerProjectSearch(state));
    assetSearch.addEventListener('input', () => scheduleNotesAssetPickerAssetSearch(state));
    loadMoreButton?.addEventListener('click', () => loadMoreNotesAssetPickerAssets(state));
  });

  return hosts.length;
}

const AUTO_RENAME_SURFACE_SELECTOR = '[data-auto-rename-surface]';
const AUTO_RENAME_ASSET_SELECTOR = '[data-auto-rename-asset]';
const AUTO_RENAME_FORM_SELECTOR = '[data-auto-rename-form]';
const AUTO_RENAME_ORDER_INPUT_SELECTOR = '[data-auto-rename-order-input]';
const AUTO_RENAME_SELECTION_INPUT_SELECTOR = '[data-auto-rename-selection-input]';
const AUTO_RENAME_SUBMIT_SELECTOR = '[data-auto-rename-submit]';
const AUTO_RENAME_INDICATOR_SELECTOR = '[data-auto-rename-order-indicator]';
const AUTO_RENAME_LIVE_SELECTOR = '[data-auto-rename-live]';
const AUTO_RENAME_ROW_TOLERANCE = 4;
const AUTO_RENAME_DRAG_BLOCK_SELECTOR = [
  'button',
  'input',
  'select',
  'textarea',
  'form',
  'label',
  'details',
  'summary',
  '[contenteditable="true"]',
  '[role="button"]',
].join(', ');

function autoRenameSurfaceItems(surface) {
  return Array.from(surface?.querySelectorAll?.(AUTO_RENAME_ASSET_SELECTOR) || []);
}

function autoRenameAssetId(item) {
  const raw = item?.dataset?.autoRenameAssetId
    || item?.getAttribute?.('data-auto-rename-asset-id');
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function autoRenameInitialIndex(item) {
  const raw = item?.dataset?.autoRenameInitialIndex
    || item?.getAttribute?.('data-auto-rename-initial-index');
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const index = Number(raw);
  return Number.isSafeInteger(index) && index >= 0 ? index : null;
}

function autoRenameOrder(surface) {
  return autoRenameSurfaceItems(surface).map(autoRenameAssetId);
}

function autoRenameSelectedAssetIds(surface) {
  const ids = [];
  const seen = new Set();
  const checkboxes = surface?.querySelectorAll?.(ASSET_SELECTION_CHECKBOX_SELECTOR) || [];
  for (const checkbox of checkboxes) {
    if (!checkbox.checked) continue;
    const raw = checkbox.value || checkbox.getAttribute?.('value');
    if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) continue;
    const id = Number(raw);
    if (!Number.isSafeInteger(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function autoRenameSameOrder(left, right) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function autoRenameParseOrderJson(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const seen = new Set();
  for (const id of parsed) {
    if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id)) return null;
    seen.add(id);
  }
  return parsed;
}

function autoRenameSetDisabled(control, disabled) {
  if (!control) return;
  control.disabled = disabled;
  if (disabled) {
    control.setAttribute?.('disabled', '');
    control.setAttribute?.('aria-disabled', 'true');
  } else {
    control.removeAttribute?.('disabled');
    control.removeAttribute?.('aria-disabled');
  }
}

function autoRenameItemLabel(item) {
  const label = item?.getAttribute?.('aria-label');
  if (typeof label === 'string' && label.length > 0) {
    return label.replace(/^Reorder\s+/i, '');
  }
  return `Asset ${autoRenameAssetId(item) || ''}`.trim();
}

function autoRenameLiveMessage(state, message) {
  if (state.live) state.live.textContent = message;
}

function autoRenameMembershipIsValid(state) {
  const items = autoRenameSurfaceItems(state.surface);
  if (items.length !== state.items.length) return false;

  const seenNodes = new Set(items);
  if (seenNodes.size !== state.items.length || state.items.some((item) => !seenNodes.has(item))) return false;

  const ids = items.map(autoRenameAssetId);
  if (ids.some((id) => id === null)) return false;
  const seenIds = new Set(ids);
  return seenIds.size === state.initialOrder.length
    && state.initialOrder.every((id) => seenIds.has(id));
}

function autoRenameSync(state) {
  const input = state.orderInput;
  const button = state.submit;
  const valid = autoRenameMembershipIsValid(state);
  const ids = valid ? autoRenameOrder(state.surface) : [];

  if (input) input.value = valid ? JSON.stringify(ids) : '';
  state.surface.setAttribute?.('data-auto-rename-current-order', valid ? JSON.stringify(ids) : '');
  state.surface.setAttribute?.('data-auto-rename-membership', valid ? 'valid' : 'invalid');

  const unchanged = valid && autoRenameSameOrder(ids, state.initialOrder);
  if (state.selectionInput) {
    state.selectionInput.value = JSON.stringify(autoRenameSelectedAssetIds(state.surface));
  }
  const hasSelectedAssets = Array.from(
    state.surface.querySelectorAll?.(ASSET_SELECTION_CHECKBOX_SELECTOR) || [],
  ).some((checkbox) => checkbox.checked);
  autoRenameSetDisabled(button, !valid || (unchanged && !hasSelectedAssets));

  const items = autoRenameSurfaceItems(state.surface);
  items.forEach((item, index) => {
    item.setAttribute?.('aria-posinset', String(index + 1));
    item.setAttribute?.('aria-setsize', String(items.length));
    const indicator = item.querySelector?.(AUTO_RENAME_INDICATOR_SELECTOR);
    if (indicator) indicator.textContent = `${index + 1} of ${items.length}`;
  });

  return valid;
}

function autoRenameDisableSurface(surface, form = null) {
  surface.setAttribute?.('data-auto-rename-membership', 'invalid');
  const submit = form?.querySelector?.(AUTO_RENAME_SUBMIT_SELECTOR);
  autoRenameSetDisabled(submit, true);
  surface.querySelectorAll?.(AUTO_RENAME_ASSET_SELECTOR).forEach((item) => {
    item.draggable = false;
    item.removeAttribute?.('draggable');
  });
}

function autoRenameReadRect(item) {
  const rect = item?.getBoundingClientRect?.();
  if (!rect) return null;
  const top = Number(rect.top);
  const left = Number(rect.left);
  const width = Number(rect.width);
  const height = Number(rect.height);
  if (![top, left, width, height].every(Number.isFinite) || width < 0 || height < 0) return null;
  return {
    top,
    left,
    width,
    height,
    right: left + width,
    bottom: top + height,
  };
}

function autoRenameReadRows(items) {
  const rows = [];
  for (const item of items) {
    const rect = autoRenameReadRect(item);
    if (!rect) return null;
    const previous = rows[rows.length - 1];
    if (previous && Math.abs(rect.top - previous.top) <= AUTO_RENAME_ROW_TOLERANCE) {
      previous.items.push({ item, rect });
      previous.bottom = Math.max(previous.bottom, rect.bottom);
      previous.top = Math.min(previous.top, rect.top);
      continue;
    }
    rows.push({ items: [{ item, rect }], top: rect.top, bottom: rect.bottom });
  }
  let startIndex = 0;
  rows.forEach((row, index) => {
    row.index = index;
    row.startIndex = startIndex;
    startIndex += row.items.length;
  });
  return rows;
}

function autoRenameGridRowResolution(row, clientX) {
  for (let column = 0; column < row.items.length; column += 1) {
    const { rect } = row.items[column];
    if (clientX < rect.left + (rect.width / 2)) {
      return {
        index: row.startIndex + column,
        marker: { kind: 'row', rowIndex: row.index, column },
      };
    }
  }
  return {
    index: row.startIndex + row.items.length,
    marker: { kind: 'row', rowIndex: row.index, column: row.items.length },
  };
}

function autoRenameResolveGridInsertion(items, event) {
  if (items.length === 0) return { index: 0, rows: [], marker: null };
  const clientX = Number(event?.clientX);
  const clientY = Number(event?.clientY);
  const rows = autoRenameReadRows(items);
  if (!rows || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
  if (clientY < rows[0].top) {
    return { index: 0, rows, marker: { kind: 'start', rowIndex: rows[0].index } };
  }

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (clientY <= row.bottom) {
      const resolution = autoRenameGridRowResolution(row, clientX);
      return { ...resolution, rows };
    }

    const next = rows[index + 1];
    if (next) {
      const gapMidpoint = row.bottom + ((next.top - row.bottom) / 2);
      if (clientY < gapMidpoint) {
        return {
          index: row.startIndex + row.items.length,
          rows,
          marker: { kind: 'end', rowIndex: row.index },
        };
      }
      if (clientY < next.top) {
        return {
          index: next.startIndex,
          rows,
          marker: { kind: 'start', rowIndex: next.index },
        };
      }
    }
  }

  const last = rows[rows.length - 1];
  return {
    index: last.startIndex + last.items.length,
    rows,
    marker: { kind: 'end', rowIndex: last.index },
  };
}

function autoRenameResolveListInsertion(items, event) {
  if (items.length === 0) return { index: 0, rects: [] };
  const clientY = Number(event?.clientY);
  const rects = items.map((item) => autoRenameReadRect(item));
  if (rects.some((rect) => !rect) || !Number.isFinite(clientY)) return null;
  for (let index = 0; index < rects.length; index += 1) {
    const rect = rects[index];
    if (clientY < rect.top + (rect.height / 2)) return { index, rects };
  }
  return { index: rects.length, rects };
}

function autoRenameRemainingItems(state, draggedItem) {
  const items = autoRenameSurfaceItems(state.surface);
  if (!draggedItem || !state.items.includes(draggedItem) || !items.includes(draggedItem)) return null;
  return items.filter((item) => item !== draggedItem);
}

function autoRenameResolveDrop(state, event, draggedItem) {
  const remaining = autoRenameRemainingItems(state, draggedItem);
  if (!remaining) return null;
  return state.view === 'grid'
    ? autoRenameResolveGridInsertion(remaining, event)
    : autoRenameResolveListInsertion(remaining, event);
}

function autoRenameGridMarkerGeometry(rows, index, markerHint) {
  if (!rows.length) return null;
  let row;
  let column;
  let kind = markerHint?.kind;
  if (markerHint?.rowIndex !== undefined) row = rows[markerHint.rowIndex];

  if (!row) {
    for (const candidate of rows) {
      const endIndex = candidate.startIndex + candidate.items.length;
      if (index >= candidate.startIndex && index <= endIndex) {
        row = candidate;
        column = index - candidate.startIndex;
        break;
      }
    }
  } else if (kind === 'row') {
    column = markerHint.column;
  }

  if (!row) return null;
  if (kind === 'start') {
    column = 0;
  } else if (kind === 'end') {
    column = row.items.length;
  } else {
    kind = 'row';
  }

  if (column <= 0) {
    return { left: row.items[0].rect.left, top: row.top, height: row.bottom - row.top };
  }
  if (column >= row.items.length) {
    return {
      left: row.items[row.items.length - 1].rect.right,
      top: row.top,
      height: row.bottom - row.top,
    };
  }
  return {
    left: (row.items[column - 1].rect.right + row.items[column].rect.left) / 2,
    top: row.top,
    height: row.bottom - row.top,
  };
}

function autoRenameListMarkerGeometry(rects, index) {
  if (!rects.length) return null;
  const left = Math.min(...rects.map((rect) => rect.left));
  const right = Math.max(...rects.map((rect) => rect.right));
  let top;
  if (index <= 0) top = rects[0].top;
  else if (index >= rects.length) top = rects[rects.length - 1].bottom;
  else top = (rects[index - 1].bottom + rects[index].top) / 2;
  return { left, top, width: right - left };
}

function autoRenameClamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

function autoRenameSetMarkerGeometry(state, geometry) {
  const marker = state.marker;
  if (!marker || !geometry) return;
  const surfaceRect = autoRenameReadRect(state.surface);
  const surfaceLeft = surfaceRect?.left || 0;
  const surfaceTop = surfaceRect?.top || 0;
  const markerWidth = state.view === 'grid' ? 3 : geometry.width;
  let left = geometry.left - surfaceLeft;
  let top = geometry.top - surfaceTop;
  let width = state.view === 'grid' ? 3 : geometry.width;
  let height = state.view === 'grid' ? Math.max(1, geometry.height) : 3;

  if (surfaceRect) {
    left = autoRenameClamp(left, 0, surfaceRect.width - markerWidth);
    top = autoRenameClamp(top, 0, surfaceRect.height - height);
    if (state.view === 'list') {
      width = autoRenameClamp(width, 0, surfaceRect.width - left);
    }
  }

  if (marker.style) {
    marker.style.left = `${left}px`;
    marker.style.top = `${top}px`;
    marker.style.width = `${width}px`;
    marker.style.height = `${height}px`;
  }
  marker.hidden = false;
  marker.classList?.add('auto-rename-order-marker--visible');
}

function autoRenameClearDropIndicator(state) {
  if (state.marker) {
    state.marker.hidden = true;
    state.marker.classList?.remove('auto-rename-order-marker--visible');
    state.marker.removeAttribute?.('data-auto-rename-insertion-index');
  }
  state.surface.removeAttribute?.('data-auto-rename-drop-index');
  state.dropIndex = null;
}

function autoRenameSetDropIndicator(state, resolution, draggedItem) {
  const remaining = autoRenameRemainingItems(state, draggedItem);
  if (!remaining || !resolution || !Number.isInteger(resolution.index)
    || resolution.index < 0 || resolution.index > remaining.length) return false;
  if (state.dropIndex !== resolution.index) autoRenameClearDropIndicator(state);
  state.dropIndex = resolution.index;
  state.surface.setAttribute?.('data-auto-rename-drop-index', String(resolution.index));
  state.marker?.setAttribute?.('data-auto-rename-insertion-index', String(resolution.index));

  const geometry = state.view === 'grid'
    ? autoRenameGridMarkerGeometry(
      resolution.rows || autoRenameReadRows(remaining) || [],
      resolution.index,
      resolution.marker,
    )
    : autoRenameListMarkerGeometry(
      resolution.rects || remaining.map((item) => autoRenameReadRect(item)).filter(Boolean),
      resolution.index,
    );
  autoRenameSetMarkerGeometry(state, geometry);
  return true;
}

function autoRenameViewportSnapshot() {
  const viewport = globalThis.window && globalThis.window !== globalThis
    ? globalThis.window
    : globalThis;
  return {
    viewport,
    x: Number.isFinite(viewport.scrollX) ? viewport.scrollX : 0,
    y: Number.isFinite(viewport.scrollY) ? viewport.scrollY : 0,
  };
}

function autoRenameRestoreViewport(snapshot) {
  if (!snapshot || typeof snapshot.viewport?.scrollTo !== 'function') return;
  snapshot.viewport.scrollTo(snapshot.x, snapshot.y);
}

function autoRenameFocusedElement(state) {
  const document = state.surface?.ownerDocument || globalThis.document;
  const active = document?.activeElement;
  if (!active || active === document || active === document.body) return null;
  return state.surface.contains?.(active) ? active : null;
}

function autoRenameFocusWithoutScroll(item) {
  if (typeof item?.focus !== 'function') return;
  try {
    item.focus({ preventScroll: true });
  } catch {}
}

function autoRenameReleaseScrollAnchor(state) {
  const release = state.scrollAnchorRelease;
  if (release) release();
}

function autoRenameWithScrollGuard(state, mutate) {
  autoRenameReleaseScrollAnchor(state);
  const snapshot = autoRenameViewportSnapshot();
  const focused = autoRenameFocusedElement(state);
  const style = state.surface.style;
  const previousOverflowAnchor = style?.overflowAnchor;
  if (style) style.overflowAnchor = 'none';

  let changed = false;
  try {
    changed = mutate();
  } finally {
    autoRenameFocusWithoutScroll(focused);
    autoRenameRestoreViewport(snapshot);
    let active = true;
    const release = () => {
      if (!active) return;
      active = false;
      if (state.scrollAnchorRelease === release) state.scrollAnchorRelease = null;
      if (style) style.overflowAnchor = previousOverflowAnchor;
      autoRenameRestoreViewport(snapshot);
    };
    state.scrollAnchorRelease = release;
    if (typeof globalThis.requestAnimationFrame === 'function') {
      globalThis.requestAnimationFrame(release);
    } else {
      release();
    }
  }
  return changed;
}

function autoRenameMoveToInsertionIndex(state, item, insertionIndex) {
  const items = autoRenameSurfaceItems(state.surface);
  if (!item || !items.includes(item) || !Number.isInteger(insertionIndex)) return false;
  const remaining = items.filter((candidate) => candidate !== item);
  if (insertionIndex < 0 || insertionIndex > remaining.length) return false;
  const next = [...remaining];
  next.splice(insertionIndex, 0, item);
  if (items.every((candidate, index) => candidate === next[index])) return false;

  const parent = item.parentElement || item.parentNode;
  if (!parent || typeof parent.insertBefore !== 'function') return false;
  const reference = remaining[insertionIndex] || null;
  return autoRenameWithScrollGuard(state, () => {
    parent.insertBefore(item, reference);
    return true;
  });
}

function autoRenameRestoreOrder(state, order) {
  const item = state.keyboardItem;
  if (!item) return false;
  const index = order.indexOf(autoRenameAssetId(item));
  return index >= 0 ? autoRenameMoveToInsertionIndex(state, item, index) : false;
}

function autoRenameMoveByOffset(state, item, offset) {
  const items = autoRenameSurfaceItems(state.surface);
  const index = items.indexOf(item);
  const targetIndex = index + offset;
  if (index < 0 || targetIndex < 0 || targetIndex >= items.length) return false;
  return autoRenameMoveToInsertionIndex(state, item, targetIndex);
}

function autoRenameDragTargetIsAllowed(item, target) {
  if (!target || !item.contains?.(target)) return false;
  const blocked = target.closest?.(AUTO_RENAME_DRAG_BLOCK_SELECTOR);
  return !blocked || !item.contains?.(blocked);
}

function autoRenameFinishPointerDrag(state) {
  const draggedItem = state.draggedItem;
  if (draggedItem) {
    draggedItem.classList?.remove('auto-rename-asset--dragging');
    draggedItem.setAttribute?.('aria-grabbed', 'false');
    state.suppressClick = true;
  }
  state.surface.classList?.remove('auto-rename-surface--dragging');
  autoRenameClearDropIndicator(state);
  state.draggedItem = null;
  return autoRenameSync(state);
}

function autoRenameAnnounceMove(state, item) {
  const items = autoRenameSurfaceItems(state.surface);
  const index = items.indexOf(item);
  if (index >= 0) {
    autoRenameLiveMessage(
      state,
      `Moved ${autoRenameItemLabel(item)} to position ${index + 1} of ${items.length}.`,
    );
  }
}

function autoRenameFinishKeyboardGrab(state, { cancelled = false } = {}) {
  const item = state.keyboardItem;
  if (!item) return;
  item.classList?.remove('auto-rename-asset--grabbed');
  item.setAttribute?.('aria-grabbed', 'false');
  state.keyboardItem = null;
  state.keyboardOrigin = null;
  autoRenameSync(state);
  if (cancelled) autoRenameLiveMessage(state, 'Reordering cancelled. The previous order was restored.');
  autoRenameFocusWithoutScroll(item);
}

function autoRenameBeginKeyboardGrab(state, item) {
  if (state.draggedItem || state.keyboardItem) return;
  state.keyboardItem = item;
  state.keyboardOrigin = autoRenameOrder(state.surface);
  item.classList?.add('auto-rename-asset--grabbed');
  item.setAttribute?.('aria-grabbed', 'true');
  autoRenameLiveMessage(state, `Grabbed ${autoRenameItemLabel(item)}. Use the arrow keys to move it.`);
}

function autoRenameBindItem(state, item) {
  item.draggable = true;
  item.setAttribute?.('draggable', 'true');
  item.setAttribute?.('tabindex', '0');
  item.setAttribute?.('aria-grabbed', 'false');

  item.addEventListener?.('keydown', (event) => {
    if (event.target !== item) return;
    const key = event.key === 'Spacebar' ? ' ' : event.key;
    if (!state.keyboardItem && (key === ' ' || key === 'Enter')) {
      event.preventDefault?.();
      autoRenameBeginKeyboardGrab(state, item);
      return;
    }
    if (state.keyboardItem !== item) return;

    if (key === 'Escape') {
      event.preventDefault?.();
      autoRenameRestoreOrder(state, state.keyboardOrigin || state.initialOrder);
      autoRenameFinishKeyboardGrab(state, { cancelled: true });
      return;
    }
    if (key === ' ' || key === 'Enter') {
      event.preventDefault?.();
      autoRenameFinishKeyboardGrab(state);
      autoRenameLiveMessage(state, `Committed ${autoRenameItemLabel(item)} at position ${autoRenameSurfaceItems(state.surface).indexOf(item) + 1}.`);
      return;
    }

    const offset = key === 'ArrowUp' || key === 'ArrowLeft'
      ? -1
      : key === 'ArrowDown' || key === 'ArrowRight'
        ? 1
        : null;
    if (offset === null) return;
    event.preventDefault?.();
    if (autoRenameMoveByOffset(state, item, offset)) {
      autoRenameSync(state);
      autoRenameAnnounceMove(state, item);
      autoRenameFocusWithoutScroll(item);
    }
  });
}

function autoRenameCreateOrderMarker(surface) {
  const existing = surface.querySelector?.('[data-auto-rename-order-marker]');
  if (existing) {
    existing.hidden = true;
    return existing;
  }
  const document = surface.ownerDocument || globalThis.document;
  const marker = document?.createElement?.('span');
  if (!marker) return null;
  marker.setAttribute?.('data-auto-rename-order-marker', '');
  marker.setAttribute?.('aria-hidden', 'true');
  marker.classList?.add('auto-rename-order-marker');
  marker.hidden = true;
  surface.appendChild?.(marker);
  return marker;
}

function autoRenameBindSurface(state) {
  state.items.forEach((item) => {
    item.addEventListener?.('dragstart', (event) => {
      if (
        state.keyboardItem
        || state.draggedItem
        || !autoRenameMembershipIsValid(state)
        || !autoRenameDragTargetIsAllowed(item, event.target)
      ) {
        event.preventDefault?.();
        return;
      }

      state.draggedItem = item;
      item.classList?.add('auto-rename-asset--dragging');
      item.setAttribute?.('aria-grabbed', 'true');
      state.surface.classList?.add('auto-rename-surface--dragging');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData?.('text/plain', String(autoRenameAssetId(item)));
      }
    });
    item.addEventListener?.('dragend', () => autoRenameFinishPointerDrag(state));
    autoRenameBindItem(state, item);
  });

  state.surface.addEventListener?.('pointerdown', () => {
    state.suppressClick = false;
  });
  state.surface.addEventListener?.('mousedown', () => {
    state.suppressClick = false;
  });
  state.surface.addEventListener?.('click', (event) => {
    if (!state.suppressClick) return;
    state.suppressClick = false;
    event.preventDefault?.();
    event.stopPropagation?.();
  }, true);

  state.surface.addEventListener?.('dragover', (event) => {
    if (!state.draggedItem) return;
    const resolution = autoRenameResolveDrop(state, event, state.draggedItem);
    if (!resolution || !autoRenameSetDropIndicator(state, resolution, state.draggedItem)) {
      autoRenameClearDropIndicator(state);
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
      return;
    }
    event.preventDefault?.();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  });

  state.surface.addEventListener?.('dragleave', (event) => {
    const relatedTarget = event.relatedTarget;
    if (!relatedTarget || !state.surface.contains?.(relatedTarget)) autoRenameClearDropIndicator(state);
  });

  state.surface.addEventListener?.('drop', (event) => {
    if (!state.draggedItem) return;
    const draggedItem = state.draggedItem;
    let insertionIndex = state.dropIndex;
    if (insertionIndex === null) {
      const resolution = autoRenameResolveDrop(state, event, draggedItem);
      if (resolution && autoRenameSetDropIndicator(state, resolution, draggedItem)) {
        insertionIndex = state.dropIndex;
      }
    }
    let moved = false;
    if (insertionIndex !== null) {
      event.preventDefault?.();
      moved = autoRenameMoveToInsertionIndex(state, draggedItem, insertionIndex);
    }
    const valid = autoRenameFinishPointerDrag(state);
    if (moved && valid) autoRenameAnnounceMove(state, draggedItem);
  });

  state.form.addEventListener?.('submit', (event) => {
    if (!autoRenameSync(state)) {
      event.preventDefault?.();
      autoRenameLiveMessage(state, 'The complete category order is invalid. No preview was submitted.');
    }
  });
}

export function enhanceAssetAutoRenameOrdering(scope = globalThis.document) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;

  const surfaces = scope.querySelectorAll(AUTO_RENAME_SURFACE_SELECTOR);
  let initialized = 0;
  surfaces.forEach((surface) => {
    if (isEnhancementBound(surface, 'assetAutoRenameOrderingBound')) {
      initialized += 1;
      return;
    }

    const form = surface.querySelector?.(AUTO_RENAME_FORM_SELECTOR);
    const orderInput = form?.querySelector?.(AUTO_RENAME_ORDER_INPUT_SELECTOR);
    const submit = form?.querySelector?.(AUTO_RENAME_SUBMIT_SELECTOR);
    const items = autoRenameSurfaceItems(surface);
    const initialOrder = autoRenameOrder(surface);
    const initialIndexes = items.map(autoRenameInitialIndex);
    const initialInputOrder = autoRenameParseOrderJson(orderInput?.value);
    const validInitialMarkup = Boolean(
      form && orderInput && submit && items.length > 0
      && initialOrder.every((id) => id !== null)
      && new Set(initialOrder).size === items.length
      && initialIndexes.every((index, position) => index === position)
      && initialInputOrder !== null
      && autoRenameSameOrder(initialInputOrder, initialOrder)
    );

    if (!validInitialMarkup) {
      autoRenameDisableSurface(surface, form);
      return;
    }

    const state = {
      surface,
      form,
      orderInput,
      selectionInput: form?.querySelector?.(AUTO_RENAME_SELECTION_INPUT_SELECTOR),
      submit,
      items,
      initialOrder,
      view: surface.dataset?.autoRenameView || surface.getAttribute?.('data-auto-rename-view') || 'grid',
      live: surface.querySelector?.(AUTO_RENAME_LIVE_SELECTOR),
      marker: autoRenameCreateOrderMarker(surface),
      draggedItem: null,
      dropIndex: null,
      scrollAnchorRelease: null,
      keyboardItem: null,
      keyboardOrigin: null,
      suppressClick: false,
    };

    markEnhancementBound(surface, 'assetAutoRenameOrderingBound');
    surface.autoRenameOrderingState = state;
    autoRenameBindSurface(state);
    autoRenameSync(state);
    initialized += 1;
  });

  return initialized;
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
    if (isEnhancementBound(control, 'confirmationBound')) return;
    markEnhancementBound(control, 'confirmationBound');
    control.addEventListener('click', (event) => {
      const message = control.getAttribute('data-confirm');
      if (message && !globalThis.confirm(message)) {
        event.preventDefault();
      }
    });
  });
  return controls.length;
}

// ─── Phase 3 chunk 3: shared asset selection ──────────────────────────
//
// Shared selectable-card enhancement scoped to [data-asset-selection-form].
// Two pages opt in: the project asset browser's bulk-add-to-release form
// (projects/assets.njk) and the release asset-selection page
// (releases/assets.njk). Both render [data-asset-selectable-card] cards via
// the shared asset-presentation partial and submit selected ids as
// checkboxes/hidden inputs named "selectedAssetIds". Selection state lives
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
const PROJECT_GRID_SELECTOR = '.project-grid';
const PROJECT_GRID_SIZE_STORAGE_KEY = 'creatorcrate-project-grid-size';
const PROJECT_GRID_SIZE_CONTROL_SCOPE_SELECTOR = '[data-project-grid-size-controls]';
const PROJECT_GRID_SIZE_CONTROL_SELECTOR = `${PROJECT_GRID_SIZE_CONTROL_SCOPE_SELECTOR} ${ASSET_GRID_SIZE_CONTROL_SELECTOR}`;
const PROJECTS_LIVE_REGION_SELECTOR = '[data-projects-live-region]';
const PROJECTS_FILTER_SELECTOR = '#project-filters';
const PROJECTS_SEARCH_SELECTOR = '[data-projects-search]';
const PROJECTS_LIVE_STATUS_SELECTOR = '[data-projects-live-status]';
const PROJECTS_LIVE_STATE_ATTRIBUTE = 'data-projects-live-state';
const PROJECTS_NSFW_FORM_SELECTOR = '[data-projects-nsfw-filter]';
const PROJECTS_NSFW_TOGGLE_SELECTOR = '[data-projects-nsfw-toggle]';
const PROJECTS_LIVE_DEBOUNCE_MS = 350;
const RELEASES_LIVE_REGION_SELECTOR = '[data-releases-live-region]';
const RELEASES_FILTER_SELECTOR = '[data-releases-filter]';
const RELEASES_SEARCH_SELECTOR = '[data-releases-search]';
const RELEASES_LIVE_STATUS_SELECTOR = '[data-releases-live-status]';
const RELEASES_LIVE_STATE_ATTRIBUTE = 'data-releases-live-state';
const RELEASES_LIVE_DEBOUNCE_MS = 350;
const APP_DIALOG_SELECTOR = '[data-app-dialog]';
const APP_DIALOG_TRIGGER_SELECTOR = '[data-dialog-open]';
const APP_DIALOG_CLOSE_SELECTOR = '[data-dialog-close]';
const APP_DIALOG_FORM_SELECTOR = '[data-dialog-form]';
const APP_DIALOG_FOCUSABLE_SELECTOR = 'a[href], button, input, select, textarea, [tabindex]';
const ASSET_PROJECT_FILTER_SELECTOR = '[data-asset-project-filter]';
const ASSET_PROJECT_FILTER_OPTION_SELECTOR = '[data-asset-project-filter-option]';
const ASSET_PROJECT_FILTER_SEARCH_SELECTOR = '[data-asset-project-filter-search]';
const ASSET_PROJECT_FILTER_SUMMARY_SELECTOR = '[data-asset-project-filter-summary]';
const ASSET_PROJECT_FILTER_CURRENT_SUMMARY_SELECTOR = '[data-asset-project-filter-current-summary]';
const ASSET_PROJECT_FILTER_EMPTY_SELECTOR = '[data-asset-project-filter-no-results]';
const PROJECT_ASSET_CATEGORY_FILTER_SELECTOR = '[data-asset-category-filter]';
const ASSET_VIEWER_FILTER_DISCLOSURE_SELECTOR = '[data-asset-viewer-filter-disclosure]';
const ASSET_VIEWER_FILTER_SINGLE_SELECT_SELECTOR = '[data-asset-viewer-filter-single-select]';
const ASSET_VIEWER_FILTER_MULTI_SELECT_SELECTOR = '[data-asset-viewer-filter-multi-select]';
const ASSET_VIEWER_FILTER_SINGLE_SELECT_SUMMARY_SELECTOR = '.asset-filter-multiselect-summary-current';
const ASSET_VIEWER_INFO_SELECTOR = '[data-asset-info-card]';
const ASSET_VIEWER_PREVIEW_SELECTOR = '[data-asset-viewer-preview]';
const ASSET_VIEWER_INFO_GUTTER = 8;
const PROJECT_INFO_SELECTOR = '[data-project-info-card]';
const PROJECT_PREVIEW_SELECTOR = '[data-project-grid-preview]';
const ASSET_GRID_SIZE_SLIDER_SELECTOR = '[data-grid-size-slider]';
const ASSET_GRID_SIZE_OPTION_LABEL_SELECTOR = '[data-grid-size-option-label]';
const ASSET_GRID_SIZES = Object.freeze({
  compact: '12rem',
  default: '15rem',
  large: '20rem',
});
const ASSET_GRID_SIZE_ORDER = Object.freeze(['compact', 'default', 'large']);
const ASSET_GRID_SIZE_LABELS = Object.freeze({
  compact: 'Compact',
  default: 'Default',
  large: 'Large',
});
const ASSET_GRID_SIZE_CONFIG = Object.freeze({
  controlSelector: ASSET_GRID_SIZE_CONTROL_SELECTOR,
  excludeControlScopeSelector: PROJECT_GRID_SIZE_CONTROL_SCOPE_SELECTOR,
  gridSelector: ASSET_GRID_SELECTOR,
  storageKey: ASSET_GRID_SIZE_STORAGE_KEY,
  cssVariable: '--asset-card-min',
  boundKey: 'assetGridSizeBound',
  interactiveLabelsSelector: '[data-grid-size-labels-interactive]',
});
const PROJECT_GRID_SIZE_CONFIG = Object.freeze({
  controlSelector: PROJECT_GRID_SIZE_CONTROL_SELECTOR,
  gridSelector: PROJECT_GRID_SELECTOR,
  storageKey: PROJECT_GRID_SIZE_STORAGE_KEY,
  cssVariable: '--project-card-min',
  boundKey: 'projectGridSizeBound',
  interactiveLabelsSelector: '[data-grid-size-labels-interactive]',
});
const ASSET_VIEWER_INFO_CONFIG = Object.freeze({
  infoSelector: ASSET_VIEWER_INFO_SELECTOR,
  previewSelector: ASSET_VIEWER_PREVIEW_SELECTOR,
  gutter: ASSET_VIEWER_INFO_GUTTER,
  leftProperty: '--asset-info-left',
  topProperty: '--asset-info-top',
  boundKey: 'assetViewerInfoBound',
});
const PROJECT_INFO_CONFIG = Object.freeze({
  infoSelector: PROJECT_INFO_SELECTOR,
  previewSelector: PROJECT_PREVIEW_SELECTOR,
  gutter: ASSET_VIEWER_INFO_GUTTER,
  leftProperty: '--project-info-left',
  topProperty: '--project-info-top',
  boundKey: 'projectInfoBound',
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
    const renderedTotal = Number.parseInt(countEl.getAttribute?.('data-selected-total'), 10);
    const totalCount = Number.isSafeInteger(renderedTotal) && renderedTotal >= 0
      ? renderedTotal
      : checkboxes.length;
    countEl.textContent = `${selectedCount} of ${totalCount} selected`;
  }

  const releaseSelect = form.querySelector('[data-release-select]');
  const submitButton = form.querySelector('[data-bulk-submit]');
  if (submitButton) {
    const hasReleaseTarget = Boolean(releaseSelect && releaseSelect.value);
    submitButton.disabled = !(selectedCount > 0 && hasReleaseTarget);
  }

  const autoRenameSurface = form.closest?.(AUTO_RENAME_SURFACE_SELECTOR);
  const autoRenameState = autoRenameSurface?.autoRenameOrderingState;
  if (autoRenameState) autoRenameSync(autoRenameState);
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

function readGridSize(storageKey) {
  try {
    const stored = globalThis.localStorage?.getItem(storageKey);
    return Object.prototype.hasOwnProperty.call(ASSET_GRID_SIZES, stored) ? stored : 'default';
  } catch {
    return 'default';
  }
}

function writeGridSize(size, storageKey) {
  try {
    globalThis.localStorage?.setItem(storageKey, size);
  } catch {
    // Storage can be unavailable or blocked; the current page still works.
  }
}

function assetGridSizeFromPosition(value) {
  const position = Number(value);
  if (!Number.isInteger(position) || position < 1 || position > ASSET_GRID_SIZE_ORDER.length) return null;
  return ASSET_GRID_SIZE_ORDER[position - 1];
}

function assetGridSizePosition(size) {
  const position = ASSET_GRID_SIZE_ORDER.indexOf(size);
  return position < 0 ? null : position + 1;
}

function updateGridSizeControls(controls, size) {
  const label = ASSET_GRID_SIZE_LABELS[size];
  const position = assetGridSizePosition(size);

  controls.forEach((group) => {
    group.querySelectorAll(ASSET_GRID_SIZE_SLIDER_SELECTOR).forEach((slider) => {
      slider.value = String(position);
      slider.setAttribute?.('aria-valuenow', String(position));
      slider.setAttribute?.('aria-valuetext', label);
    });

    group.querySelectorAll(ASSET_GRID_SIZE_OPTION_LABEL_SELECTOR).forEach((optionLabel) => {
      const isActive = optionLabel.dataset.gridSizeOptionLabel === size;
      optionLabel.classList?.toggle?.('is-active', isActive);
      if (optionLabel.matches?.('button') || optionLabel.tagName === 'BUTTON') {
        optionLabel.setAttribute?.('aria-pressed', String(isActive));
      }
    });
  });
}

function gridSizeLabelsAreInteractive(group, config) {
  const selector = config.interactiveLabelsSelector;
  const attribute = selector?.slice(1, -1);
  return Boolean(
    selector
      && (group.matches?.(selector)
        || group.hasAttribute?.(attribute)
        || (typeof group.getAttribute === 'function' && group.getAttribute(attribute) !== null)),
  );
}

function applyGridSize(scope, size, config, controls) {
  const grids = scope.querySelectorAll(config.gridSelector);
  grids.forEach((grid) => {
    if (size === 'default') {
      grid.removeAttribute('data-grid-size');
      grid.style?.removeProperty(config.cssVariable);
    } else {
      grid.setAttribute('data-grid-size', size);
      grid.style?.setProperty(config.cssVariable, ASSET_GRID_SIZES[size]);
    }
  });
  updateGridSizeControls(controls, size);
}

function getGridSizeControls(scope, config) {
  return Array.from(scope.querySelectorAll(config.controlSelector))
    .filter((control) => !config.excludeControlScopeSelector
      || !control.closest?.(config.excludeControlScopeSelector));
}

function enhanceGridSize(scope, config) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;
  const controls = getGridSizeControls(scope, config);
  const grids = scope.querySelectorAll(config.gridSelector);
  if (controls.length === 0 || grids.length === 0) return 0;

  applyGridSize(scope, readGridSize(config.storageKey), config, controls);
  controls.forEach((group) => {
    const applySelectedSize = (size) => {
      if (!Object.prototype.hasOwnProperty.call(ASSET_GRID_SIZES, size)) return;
      writeGridSize(size, config.storageKey);
      applyGridSize(scope, size, config, controls);
    };

    group.querySelectorAll(ASSET_GRID_SIZE_SLIDER_SELECTOR).forEach((slider) => {
      if (isEnhancementBound(slider, config.boundKey)) return;
      markEnhancementBound(slider, config.boundKey);
      const applySliderSize = () => {
        applySelectedSize(assetGridSizeFromPosition(slider.value));
      };
      slider.addEventListener('input', applySliderSize);
      slider.addEventListener('change', applySliderSize);
    });

    if (gridSizeLabelsAreInteractive(group, config)) {
      group.querySelectorAll(ASSET_GRID_SIZE_OPTION_LABEL_SELECTOR).forEach((optionLabel) => {
        if (isEnhancementBound(optionLabel, config.boundKey)) return;
        markEnhancementBound(optionLabel, config.boundKey);
        optionLabel.addEventListener('click', () => {
          applySelectedSize(optionLabel.dataset.gridSizeOptionLabel);
        });
      });
    }
  });
  return controls.length;
}

export function enhanceAssetGridSize(scope = globalThis.document) {
  return enhanceGridSize(scope, ASSET_GRID_SIZE_CONFIG);
}

export function enhanceProjectGridSize(scope = globalThis.document) {
  return enhanceGridSize(scope, PROJECT_GRID_SIZE_CONFIG);
}

function appDialogDocument(scope) {
  if (!scope) return null;
  if (scope.nodeType === 9) return scope;
  return scope.ownerDocument || globalThis.document || null;
}

function appDialogFocusable(dialog) {
  return Array.from(dialog?.querySelectorAll?.(APP_DIALOG_FOCUSABLE_SELECTOR) || [])
    .filter((element) => !element.disabled && element.getAttribute?.('aria-hidden') !== 'true');
}

function appDialogBodyLock(state, locked) {
  const body = state.document?.body;
  if (!body?.classList) return;
  if (locked) body.classList.add('app-dialog-open');
  else if (!state.document.querySelector?.(`${APP_DIALOG_SELECTOR}[open]`)) body.classList.remove('app-dialog-open');
}

function appDialogRestoreFocus(state) {
  const opener = state.opener && state.document.contains?.(state.opener)
    ? state.opener
    : state.document.querySelector?.(`${APP_DIALOG_TRIGGER_SELECTOR}[data-dialog-open="${state.dialog.id}"]`);
  state.opener = null;
  opener?.focus?.({ preventScroll: true });
}

function appDialogFinishClose(state) {
  state.open = false;
  appDialogBodyLock(state, false);
  appDialogRestoreFocus(state);
}

function appDialogClose(state) {
  if (typeof state.dialog.close === 'function' && state.dialog.open) {
    state.dialog.close();
    return;
  }
  state.dialog.removeAttribute?.('open');
  state.dialog.open = false;
  appDialogFinishClose(state);
}

function appDialogValues(form) {
  const values = {};
  Array.from(form?.querySelectorAll?.('select, input, textarea') || []).forEach((control) => {
    if (control.name && !Object.hasOwn(values, control.name)) values[control.name] = control.value;
  });
  return values;
}

function appDialogApplyValues(form, values = {}) {
  form?.querySelectorAll?.('option[data-dialog-submitted-value]')
    .forEach((option) => option.remove?.());
  Object.entries(values).forEach(([name, value]) => {
    if (name === '_csrf') return;
    const control = form?.querySelector?.(`[name="${name}"]`);
    if (!control) return;
    const stringValue = String(value ?? '');
    if (control.tagName === 'SELECT') {
      const options = Array.from(control.options || control.querySelectorAll?.('option') || []);
      if (!options.some((option) => String(option.value) === stringValue)) {
        const option = control.ownerDocument?.createElement?.('option');
        if (option) {
          option.value = stringValue;
          option.textContent = `Submitted value: ${stringValue}`;
          option.setAttribute?.('data-dialog-submitted-value', '');
          control.appendChild?.(option);
        }
      }
    }
    control.value = stringValue;
  });
}

function appDialogClearErrors(state) {
  state.form?.querySelectorAll?.('[data-dialog-field]').forEach((field) => {
    field.classList?.remove('field-error');
    const control = field.querySelector?.('select, input, textarea');
    control?.removeAttribute?.('aria-invalid');
    control?.removeAttribute?.('aria-describedby');
    field.querySelector?.('.field-error-message')?.remove?.();
  });
  const error = state.dialog.querySelector?.('[data-dialog-error]');
  if (error) {
    error.hidden = true;
    error.setAttribute?.('hidden', '');
  }
  const errorText = state.dialog.querySelector?.('[data-dialog-error-text]');
  if (errorText) errorText.textContent = '';
  const errorList = state.dialog.querySelector?.('[data-dialog-error-list]');
  if (errorList) errorList.textContent = '';
}

function appDialogShowErrors(state, errors = {}, message = 'Fix the highlighted fields and try again.') {
  const error = state.dialog.querySelector?.('[data-dialog-error]');
  if (error) {
    error.hidden = false;
    error.removeAttribute?.('hidden');
  }
  const errorText = state.dialog.querySelector?.('[data-dialog-error-text]');
  if (errorText) errorText.textContent = message;
  const errorList = state.dialog.querySelector?.('[data-dialog-error-list]');
  if (errorList) errorList.textContent = Object.values(errors).join(' ');

  Object.entries(errors).forEach(([name, fieldError]) => {
    const field = Array.from(state.form?.querySelectorAll?.('[data-dialog-field]') || [])
      .find((candidate) => candidate.getAttribute?.('data-dialog-field') === name);
    if (!field) return;
    field.classList?.add('field-error');
    const control = field.querySelector?.('select, input, textarea');
    if (!control) return;
    control.setAttribute?.('aria-invalid', 'true');
    const errorId = `${control.id || `dialog-${name}`}-error`;
    control.setAttribute?.('aria-describedby', errorId);
    const messageElement = control.ownerDocument?.createElement?.('span');
    if (!messageElement) return;
    messageElement.className = 'field-error-message';
    messageElement.id = errorId;
    messageElement.textContent = fieldError;
    field.appendChild?.(messageElement);
  });
  state.form?.querySelector?.('[aria-invalid="true"]')?.focus?.({ preventScroll: true });
}

function appDialogStatus(state, message, error = false) {
  const status = state.dialog.querySelector?.('[data-dialog-status]');
  if (status) status.textContent = message || '';
  if (message) state.dialog.setAttribute?.('data-dialog-state', error ? 'error' : 'pending');
  else state.dialog.removeAttribute?.('data-dialog-state');
}

function appDialogSaveErrorMessage(state) {
  return state.form?.getAttribute?.('data-dialog-error-message')
    || state.dialog.getAttribute?.('data-dialog-error-message')
    || 'Projects defaults could not be saved.';
}

function appDialogFeedback(document, message, error = false) {
  const feedback = document?.querySelector?.('[data-dialog-feedback]');
  const text = feedback?.querySelector?.('[data-dialog-feedback-text]');
  if (!feedback || !text) return;
  feedback.classList?.toggle?.('notice--error', error);
  feedback.classList?.toggle?.('notice--success', !error);
  text.textContent = message;
  feedback.hidden = false;
  feedback.removeAttribute?.('hidden');
}

async function appDialogPayload(response) {
  if (typeof response?.json === 'function') {
    try { return await response.json(); } catch {}
  }
  return {};
}

function appDialogBindForm(state) {
  const form = state.form;
  if (!form || form.getAttribute?.('data-dialog-async') === 'false'
    || isEnhancementBound(form, 'appDialogFormBound')) return;
  markEnhancementBound(form, 'appDialogFormBound');
  state.savedValues = appDialogValues(form);

  form.addEventListener?.('submit', (event) => {
    const submitter = event.submitter;
    if (submitter?.matches?.(APP_DIALOG_CLOSE_SELECTOR) || submitter?.getAttribute?.('formmethod') === 'dialog') {
      event.preventDefault?.();
      appDialogClose(state);
      return;
    }

    const windowObject = state.document?.defaultView || globalThis;
    if (typeof windowObject.fetch !== 'function'
      || typeof windowObject.FormData !== 'function'
      || typeof windowObject.URLSearchParams !== 'function') return;

    event.preventDefault?.();
    if (state.submitting) return;
    state.submitting = true;
    appDialogClearErrors(state);
    appDialogStatus(state, 'Saving defaults.');
    form.setAttribute?.('aria-busy', 'true');
    const submitButton = form.querySelector?.('[data-dialog-submit]');
    if (submitButton) submitButton.disabled = true;
    const action = form.action || form.getAttribute?.('action');
    const method = String(form.method || form.getAttribute?.('method') || 'POST').toUpperCase();

    Promise.resolve().then(() => windowObject.fetch(action, {
      method,
      body: new windowObject.URLSearchParams(new windowObject.FormData(form)),
      credentials: 'same-origin',
      redirect: 'follow',
      headers: { Accept: 'application/json' },
    })).then(async (response) => ({ response, payload: await appDialogPayload(response) }))
      .then(({ response, payload }) => {
        state.submitting = false;
        form.removeAttribute?.('aria-busy');
        if (submitButton) submitButton.disabled = false;
        if (response?.ok === false || payload?.status !== 'success') {
          appDialogApplyValues(form, payload?.values || appDialogValues(form));
          appDialogShowErrors(state, payload?.errors || {}, payload?.message || appDialogSaveErrorMessage(state));
          appDialogStatus(state, payload?.message || 'Could not save defaults.', true);
          return;
        }
        state.savedValues = payload?.values || appDialogValues(form);
        appDialogStatus(state, '');
        appDialogFeedback(state.document, payload?.message || 'Projects defaults saved successfully.');
        appDialogClose(state);
      })
      .catch(() => {
        state.submitting = false;
        form.removeAttribute?.('aria-busy');
        if (submitButton) submitButton.disabled = false;
        appDialogShowErrors(state, {}, `${appDialogSaveErrorMessage(state)} Your selections were kept.`);
        appDialogStatus(state, 'Could not save defaults. Check your connection and try again.', true);
      });
  });
}

function appDialogOpen(state, opener = null) {
  state.opener = opener || state.document.querySelector?.(
    `${APP_DIALOG_TRIGGER_SELECTOR}[data-dialog-open="${state.dialog.id}"]`
  );
  appDialogApplyValues(state.form, state.savedValues || {});
  try {
    if (typeof state.dialog.showModal === 'function') {
      if (state.dialog.open) state.dialog.close?.();
      state.dialog.showModal();
    } else {
      state.dialog.setAttribute?.('open', '');
      state.dialog.open = true;
    }
  } catch {
    state.dialog.setAttribute?.('open', '');
    state.dialog.open = true;
  }
  state.open = true;
  appDialogBodyLock(state, true);
  (state.dialog.querySelector?.('[autofocus]')
    || state.dialog.querySelector?.(APP_DIALOG_CLOSE_SELECTOR)
    || appDialogFocusable(state.dialog)[0])?.focus?.({ preventScroll: true });
}

function appDialogBind(state) {
  if (isEnhancementBound(state.dialog, 'appDialogBound')) return;
  markEnhancementBound(state.dialog, 'appDialogBound');
  state.form = state.dialog.querySelector?.(APP_DIALOG_FORM_SELECTOR) || null;
  appDialogBindForm(state);
  state.dialog.addEventListener?.('close', () => appDialogFinishClose(state));
  state.dialog.addEventListener?.('cancel', (event) => {
    event.preventDefault?.();
    appDialogClose(state);
  });
  state.dialog.addEventListener?.('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault?.();
    appDialogClose(state);
  });
  state.dialog.addEventListener?.('click', (event) => {
    if (event.target === state.dialog) {
      event.preventDefault?.();
      appDialogClose(state);
    }
  });
  state.dialog.querySelectorAll?.(APP_DIALOG_CLOSE_SELECTOR).forEach((control) => {
    if (isEnhancementBound(control, 'appDialogCloseBound')) return;
    markEnhancementBound(control, 'appDialogCloseBound');
    control.addEventListener?.('click', (event) => {
      event.preventDefault?.();
      appDialogClose(state);
    });
  });
  state.dialog.addEventListener?.('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const focusable = appDialogFocusable(state.dialog);
    if (focusable.length === 0) return;
    const index = focusable.indexOf(state.document.activeElement);
    if (!event.shiftKey && (index === focusable.length - 1 || index === -1)) {
      event.preventDefault?.();
      focusable[0].focus?.();
    } else if (event.shiftKey && index <= 0) {
      event.preventDefault?.();
      focusable[focusable.length - 1].focus?.();
    }
  });
  if (state.dialog.hasAttribute?.('open')) appDialogOpen(state);
}

export function enhanceAppDialogs(scope = globalThis.document) {
  const document = appDialogDocument(scope);
  if (!document || typeof document.querySelectorAll !== 'function') return 0;
  const dialogs = Array.from(document.querySelectorAll(APP_DIALOG_SELECTOR));
  dialogs.forEach((dialog) => {
    if (dialog.__creatorCrateAppDialogState) return;
    const state = {
      document,
      dialog,
      form: null,
      opener: null,
      savedValues: null,
      open: false,
      submitting: false,
    };
    dialog.__creatorCrateAppDialogState = state;
    appDialogBind(state);
  });
  if (!isEnhancementBound(document, 'appDialogsBound')) {
    markEnhancementBound(document, 'appDialogsBound');
    document.addEventListener?.('click', (event) => {
      const trigger = event.target?.closest?.(APP_DIALOG_TRIGGER_SELECTOR);
      if (!trigger) return;
      const dialog = document.getElementById?.(trigger.getAttribute?.('data-dialog-open'));
      const state = dialog?.__creatorCrateAppDialogState;
      if (!state) return;
      event.preventDefault?.();
      appDialogOpen(state, trigger);
    });
  }
  return dialogs.length;
}

function liveRegionDocument(scope) {
  if (!scope) return null;
  if (scope.nodeType === 9) return scope;
  return scope.ownerDocument || globalThis.document || null;
}

function liveRegionWindow(document) {
  return document?.defaultView || globalThis;
}

function projectLiveNsfwForm(region) {
  return region?.querySelector?.(PROJECTS_NSFW_FORM_SELECTOR) || null;
}

function projectLiveNsfwEnabled(form) {
  const value = form?.querySelector?.('[data-projects-nsfw-value]')?.value
    || form?.querySelector?.('[data-projects-nsfw-value]')?.getAttribute?.('value');
  return value === '1';
}

function projectLiveRenderedNsfwEnabled(region) {
  return region?.querySelector?.(PROJECTS_NSFW_TOGGLE_SELECTOR)?.getAttribute?.('aria-pressed') === 'true';
}

function updateProjectsNsfwControls(scope, enabled, pending = false) {
  const controls = Array.from(scope?.querySelectorAll?.(PROJECTS_NSFW_TOGGLE_SELECTOR) || []);
  const label = enabled ? 'Disable NSFW filter' : 'Enable NSFW filter';
  controls.forEach((control) => {
    control.disabled = pending;
    if (pending) control.setAttribute?.('disabled', '');
    else control.removeAttribute?.('disabled');
    control.setAttribute?.('aria-pressed', String(enabled));
    control.setAttribute?.('aria-label', label);
    control.setAttribute?.('data-tooltip', label);
  });
  scope?.querySelectorAll?.(PROJECTS_NSFW_FORM_SELECTOR).forEach((form) => {
    const value = form.querySelector?.('[data-projects-nsfw-value]');
    if (value) value.value = enabled ? '0' : '1';
    if (pending) form.setAttribute?.('aria-busy', 'true');
    else form.removeAttribute?.('aria-busy');
  });
}

function liveRegionCaptureState(region, document) {
  const active = document?.activeElement;
  const focus = active && region?.contains?.(active)
    ? {
      id: active.id || active.getAttribute?.('id') || '',
      name: active.name || active.getAttribute?.('name') || '',
      type: active.type || active.getAttribute?.('type') || '',
      value: active.value ?? active.getAttribute?.('value') ?? '',
      selectionStart: Number.isInteger(active.selectionStart) ? active.selectionStart : null,
      selectionEnd: Number.isInteger(active.selectionEnd) ? active.selectionEnd : null,
    }
    : null;
  const openDisclosures = Array.from(region?.querySelectorAll?.('details') || [])
    .filter((details) => details.open === true)
    .map((details) => ({
      id: details.id || details.getAttribute?.('id') || '',
      controls: details.querySelector?.('summary')?.getAttribute?.('aria-controls') || '',
    }));
  return { focus, openDisclosures };
}

function liveRegionFindFocus(region, focus) {
  if (!region || !focus) return null;
  const controls = Array.from(region.querySelectorAll?.('input, select, textarea, button, summary') || []);
  return controls.find((control) => {
    if (focus.id && (control.id || control.getAttribute?.('id')) === focus.id) return true;
    return Boolean(focus.name)
      && (control.name || control.getAttribute?.('name')) === focus.name
      && String(control.type || control.getAttribute?.('type') || '') === focus.type
      && String(control.value ?? control.getAttribute?.('value') ?? '') === String(focus.value);
  }) || null;
}

function liveRegionRestoreState(region, document, captured) {
  captured?.openDisclosures?.forEach(({ id, controls }) => {
    const details = Array.from(region?.querySelectorAll?.('details') || []).find((candidate) => (
      (id && (candidate.id || candidate.getAttribute?.('id')) === id)
        || (controls && candidate.querySelector?.('summary')?.getAttribute?.('aria-controls') === controls)
    ));
    if (details) details.open = true;
  });

  const focus = liveRegionFindFocus(region, captured?.focus);
  if (!focus) return;
  focus.focus?.({ preventScroll: true });
  if (captured.focus.selectionStart !== null && typeof focus.setSelectionRange === 'function') {
    focus.setSelectionRange(captured.focus.selectionStart, captured.focus.selectionEnd);
  }
}

function enhanceProjectsLiveRegion(region) {
  enhancePreviewMedia(region);
  enhanceProjectCards(region);
  enhanceProjectGridSize(region);
  enhanceAssetProjectFilter(region);
  enhanceAssetViewerFilterDisclosures(liveRegionDocument(region));
  enhanceProjectInfoCards(region);
}

export function createLiveRegionEngine(config) {
  const {
    regionSelector,
    formSelector,
    linkSelector = null,
    searchSelector = null,
    debounceMs = 0,
    defaultAction = '/',
    stateKey = '__creatorCrateLiveRegion',
    historyState = null,
    statusSelector = null,
    statusStateAttribute = null,
    loadingMessage = '',
    fallbackMessage = '',
    responseErrorMessage = 'Live-region response failed.',
    missingRegionMessage = 'Live-region response did not contain the live region.',
    enhanceRegion = () => {},
    onCreate = null,
    onBindRegion = null,
    onInvalidate = null,
    onLoadStart = null,
    onResponseParsed = null,
    onRegionReplaced = null,
    onLoadComplete = null,
    onLoadError = null,
    isCurrentUrl = () => true,
  } = config || {};

  function regionFor(scope) {
    if (scope?.matches?.(regionSelector)) return scope;
    return scope?.querySelector?.(regionSelector) || null;
  }

  function formFor(region) {
    const selectors = Array.isArray(formSelector) ? formSelector : [formSelector];
    for (const selector of selectors) {
      const form = region?.querySelector?.(selector);
      if (form) return form;
    }
    return null;
  }

  function formsFor(region) {
    const selectors = Array.isArray(formSelector) ? formSelector : [formSelector];
    return selectors.flatMap((selector) => Array.from(region?.querySelectorAll?.(selector) || []));
  }

  function capabilities(windowObject) {
    return Boolean(
      typeof windowObject?.fetch === 'function'
        && typeof windowObject?.FormData === 'function'
        && typeof windowObject?.URLSearchParams === 'function'
        && typeof windowObject?.DOMParser === 'function'
        && typeof windowObject?.history?.pushState === 'function'
        && typeof windowObject?.history?.replaceState === 'function',
    );
  }

  function urlFor(form, windowObject, { preservePage = false } = {}) {
    const action = form?.action || form?.getAttribute?.('action') || defaultAction;
    const url = new URL(action, windowObject.location?.href || defaultAction);
    const params = new windowObject.URLSearchParams(new windowObject.FormData(form));
    if (preservePage) {
      const currentUrl = new URL(windowObject.location?.href || url.href, url.href);
      if (!params.has('page') && currentUrl.searchParams.has('page')) {
        params.set('page', currentUrl.searchParams.get('page'));
      }
    } else {
      params.delete('page');
    }

    const emptyKeys = [];
    for (const [key, value] of params.entries()) {
      if (value === '') emptyKeys.push(key);
    }
    emptyKeys.forEach((key) => params.delete(key));

    url.search = params.toString();
    url.hash = '';
    return url;
  }

  function nativeSubmit(form) {
    if (!form) return false;
    const formPrototype = globalThis.HTMLFormElement?.prototype;
    if (typeof formPrototype?.submit === 'function') {
      formPrototype.submit.call(form);
      return true;
    }
    if (typeof form.submit === 'function') {
      form.submit();
      return true;
    }
    return false;
  }

  function navigate(windowObject, url) {
    const location = windowObject?.location;
    if (!location) return false;
    if (typeof location.assign === 'function') {
      location.assign(url.href || String(url));
      return true;
    }
    location.href = url.href || String(url);
    return true;
  }

  function status(region, message, state) {
    if (!region) return;
    if (statusStateAttribute) {
      if (state) region.setAttribute?.(statusStateAttribute, state);
      else region.removeAttribute?.(statusStateAttribute);
    }
    const statusElement = statusSelector ? region.querySelector?.(statusSelector) : null;
    if (statusElement) statusElement.textContent = message || '';
  }

  function controller(windowObject) {
    return typeof windowObject?.AbortController === 'function'
      ? new windowObject.AbortController()
      : null;
  }

  function responseUrl(response, requestedUrl, windowObject) {
    const candidate = response?.url || requestedUrl.href;
    return new URL(candidate, windowObject.location?.href || requestedUrl.href);
  }

  function invalidate(state) {
    onInvalidate?.(state, engine);
    state.generation += 1;
    state.controller?.abort?.();
    state.controller = null;
  }

  function replaceRegion(state, responseText, requestedUrl, historyMode) {
    const document = state.document;
    const windowObject = state.window;
    const parser = new windowObject.DOMParser();
    const parsed = parser.parseFromString(responseText, 'text/html');
    const nextRegion = parsed.querySelector?.(regionSelector);
    const currentRegion = regionFor(document);
    if (!nextRegion || !currentRegion || !currentRegion.parentNode) {
      throw new Error(missingRegionMessage);
    }

    onResponseParsed?.(state, parsed, nextRegion, engine);

    const captured = liveRegionCaptureState(currentRegion, document);
    if (typeof currentRegion.replaceWith === 'function') currentRegion.replaceWith(nextRegion);
    else currentRegion.parentNode.replaceChild(nextRegion, currentRegion);

    const finalUrl = responseUrl(state.response, requestedUrl, windowObject);
    if (historyMode === 'push') {
      windowObject.history.pushState(historyState, '', finalUrl.href);
    } else if (historyMode === 'replace' && finalUrl.href !== windowObject.location?.href) {
      windowObject.history.replaceState(historyState, '', finalUrl.href);
    }

    enhanceRegion(nextRegion, state);
    state.region = nextRegion;
    onRegionReplaced?.(state, nextRegion, engine);
    liveRegionRestoreState(nextRegion, document, captured);
    status(nextRegion, '', null);
  }

  function fallback(state, form, requestedUrl, useRequestedUrl = false) {
    if (useRequestedUrl) {
      navigate(state.window, requestedUrl);
      return;
    }
    const currentForms = formsFor(regionFor(state.document));
    if (form && currentForms.includes(form)) {
      if (nativeSubmit(form)) return;
    }
    navigate(state.window, requestedUrl);
  }

  function loadError(state, generation, error, form, url, historyMode) {
    if (generation !== state.generation) return;
    state.controller = null;
    if (onLoadError?.(state, generation, error, form, url, historyMode, engine) === true) return;
    if (error?.name === 'AbortError') return;
    const region = regionFor(state.document);
    region?.removeAttribute?.('aria-busy');
    status(region, fallbackMessage, 'error');
    fallback(state, form, url, historyMode === 'replace');
  }

  function load(state, url, historyMode, form) {
    const generation = state.generation;
    const currentRegion = regionFor(state.document);
    if (!currentRegion) return;
    state.region = currentRegion;
    state.response = null;
    state.requestedUrl = url;
    onLoadStart?.(state, generation, url, historyMode, engine);
    state.controller = controller(state.window);
    status(currentRegion, loadingMessage, 'loading');
    currentRegion.setAttribute?.('aria-busy', 'true');

    const options = {
      method: 'GET',
      credentials: 'same-origin',
      redirect: 'follow',
      headers: { Accept: 'text/html' },
    };
    if (state.controller) options.signal = state.controller.signal;

    let request;
    try {
      request = state.window.fetch(url.href, options);
    } catch (error) {
      loadError(state, generation, error, form, url, historyMode);
      return;
    }

    Promise.resolve(request)
      .then((response) => {
        if (generation !== state.generation) return null;
        if (!response?.ok || typeof response.text !== 'function') {
          throw new Error(responseErrorMessage);
        }
        state.response = response;
        return response.text();
      })
      .then((responseText) => {
        if (responseText === null || generation !== state.generation) return;
        replaceRegion(state, responseText, url, historyMode);
      })
      .then(() => {
        if (generation !== state.generation) return;
        state.controller = null;
        const region = regionFor(state.document);
        region?.removeAttribute?.('aria-busy');
        if (region) status(region, '', null);
        bindForm(state);
        onLoadComplete?.(state, generation, region, engine);
      })
      .catch((error) => loadError(state, generation, error, form, url, historyMode));
  }

  function schedule(state, form, delay = 0) {
    const windowObject = state.window;
    if (!capabilities(windowObject)) {
      nativeSubmit(form);
      return;
    }

    if (state.timer) windowObject.clearTimeout?.(state.timer);
    state.timer = null;
    invalidate(state);

    const start = () => {
      state.timer = null;
      let url;
      try {
        url = urlFor(form, windowObject);
      } catch {
        nativeSubmit(form);
        return;
      }
      load(state, url, 'push', form);
    };
    if (delay > 0) state.timer = windowObject.setTimeout(start, delay);
    else start();
  }

  function handlePopstate(state) {
    const url = new URL(state.window.location.href);
    if (!isCurrentUrl(url, state)) return;
    const region = regionFor(state.document);
    if (!region) return;
    const form = formFor(region);
    if (!capabilities(state.window)) {
      navigate(state.window, url);
      return;
    }
    if (state.timer) state.window.clearTimeout?.(state.timer);
    state.timer = null;
    invalidate(state);
    load(state, url, 'replace', form);
  }

  function bindForm(state) {
    const region = regionFor(state.document);
    const forms = formsFor(region);
    if (forms.length === 0) return 0;
    state.region = region;
    onBindRegion?.(state, region, engine);
    state.forms ||= new Set();
    forms.forEach((form) => {
      if (state.forms.has(form)) return;
      state.forms.add(form);

      form.addEventListener?.('change', (event) => {
        if (searchSelector && event.target?.matches?.(searchSelector)) return;
        if (!event.target?.name && !event.target?.getAttribute?.('name')) return;
        schedule(state, form);
      });
      if (searchSelector) {
        form.querySelector?.(searchSelector)?.addEventListener?.('input', () => {
          schedule(state, form, debounceMs);
        });
      }
      form.addEventListener?.('submit', (event) => {
        event.preventDefault?.();
        schedule(state, form);
      });
    });

    if (linkSelector) {
      region.querySelectorAll?.(linkSelector).forEach((link) => {
        if (isEnhancementBound(link, 'liveRegionLinkBound')) return;
        markEnhancementBound(link, 'liveRegionLinkBound');
        link.addEventListener?.('click', (event) => {
          if (event.defaultPrevented || event.button !== 0
            || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          if (!capabilities(state.window)) return;
          const href = link.href || link.getAttribute?.('href');
          if (!href) return;
          event.preventDefault?.();
          let url;
          try {
            url = new URL(href, state.window.location?.href || defaultAction);
            url.hash = '';
          } catch {
            return;
          }
          if (state.timer) state.window.clearTimeout?.(state.timer);
          state.timer = null;
          invalidate(state);
          load(state, url, 'push', null);
        });
      });
    }
    state.form = forms[0];
    return forms.length;
  }

  function enhance(scope = globalThis.document) {
    const document = liveRegionDocument(scope);
    const region = regionFor(scope);
    if (!document || !region) return 0;

    let state = document[stateKey];
    if (!state) {
      const windowObject = liveRegionWindow(document);
      state = {
        document,
        window: windowObject,
        region,
        form: null,
        forms: new Set(),
        controller: null,
        timer: null,
        generation: 0,
        response: null,
        requestedUrl: null,
        engine,
      };
      document[stateKey] = state;
      enhanceRegion(region, state);
      onCreate?.(state, region, engine);
      windowObject.addEventListener?.('popstate', () => handlePopstate(state));
    }

    return bindForm(state);
  }

  const engine = {
    enhance,
    getRegion: regionFor,
    getForm: formFor,
    capabilities,
    url: urlFor,
    nativeSubmit,
    navigate,
    status,
    controller,
    invalidate,
    load,
  };

  return engine;
}

function submitProjectsNsfwToggle(state, form, event) {
  if (!projectsLiveEngine.capabilities(state.window)) return false;
  if (state.nsfwSubmitting) {
    event.preventDefault?.();
    return true;
  }

  let refreshUrl;
  try {
    if (state.timer) state.window.clearTimeout?.(state.timer);
    state.timer = null;
    refreshUrl = state.controller && state.requestedUrl
      ? new URL(state.requestedUrl.href, state.window.location?.href || state.requestedUrl.href)
      : projectsLiveEngine.url(
        projectsLiveEngine.getForm(projectsLiveEngine.getRegion(state.document)),
        state.window,
        { preservePage: true },
      );
  } catch {
    return false;
  }

  event.preventDefault?.();
  projectsLiveEngine.invalidate(state);
  state.nsfwGeneration += 1;
  const generation = state.nsfwGeneration;
  const enabled = projectLiveNsfwEnabled(form);
  const previousEnabled = projectLiveRenderedNsfwEnabled(projectsLiveEngine.getRegion(state.document));
  state.nsfwSubmitting = true;
  state.nsfwPostPending = true;
  state.nsfwNeedsRefresh = false;
  state.nsfwRegionReplaced = false;
  state.nsfwPreviousEnabled = previousEnabled;
  state.nsfwEnabled = enabled;

  const controller = projectsLiveEngine.controller(state.window);
  state.nsfwController?.abort?.();
  state.nsfwController = controller;
  let requestBody;
  try {
    requestBody = new state.window.URLSearchParams(new state.window.FormData(form));
    requestBody.set('enabled', enabled ? '1' : '0');
  } catch {
    state.nsfwSubmitting = false;
    state.nsfwPostPending = false;
    updateProjectsNsfwControls(projectsLiveEngine.getRegion(state.document), previousEnabled);
    projectsLiveEngine.nativeSubmit(form);
    return true;
  }
  updateProjectsNsfwControls(projectsLiveEngine.getRegion(state.document), enabled, true);
  const options = {
    method: String(form.method || form.getAttribute?.('method') || 'POST').toUpperCase(),
    body: requestBody,
    credentials: 'same-origin',
    redirect: 'follow',
    headers: { Accept: 'application/json' },
  };
  if (controller) options.signal = controller.signal;

  let request;
  try {
    request = state.window.fetch(form.action || form.getAttribute?.('action'), options);
  } catch (error) {
    request = Promise.reject(error);
  }

  let persistedNsfwEnabled = null;
  Promise.resolve(request)
    .then(async (response) => {
      if (!response?.ok) throw new Error('NSFW filter update failed.');
      const payload = typeof response.json === 'function' ? await response.json() : null;
      if (payload?.status !== 'success' || typeof payload.enabled !== 'boolean') {
        throw new Error('NSFW filter update failed.');
      }
      return payload;
    })
    .then((payload) => {
      if (generation !== state.nsfwGeneration) return;
      state.nsfwController = null;
      state.nsfwPostPending = false;
      state.nsfwEnabled = payload.enabled;
      persistedNsfwEnabled = payload.enabled;
      state.nsfwNeedsRefresh = true;
      projectsLiveEngine.invalidate(state);
      updateProjectsNsfwControls(projectsLiveEngine.getRegion(state.document), payload.enabled, true);
      projectsLiveEngine.load(
        state,
        refreshUrl,
        'none',
        projectsLiveEngine.getForm(projectsLiveEngine.getRegion(state.document)),
      );
    })
    .catch((error) => {
      if (generation !== state.nsfwGeneration) return;
      state.nsfwController = null;
      state.nsfwPostPending = false;
      state.nsfwSubmitting = false;
      state.nsfwNeedsRefresh = false;
      const region = projectsLiveEngine.getRegion(state.document);
      const enabledState = persistedNsfwEnabled === null
        ? (state.nsfwRegionReplaced
          ? projectLiveRenderedNsfwEnabled(region)
          : state.nsfwPreviousEnabled)
        : persistedNsfwEnabled;
      state.nsfwEnabled = enabledState;
      state.nsfwRegionReplaced = false;
      updateProjectsNsfwControls(region, enabledState);
      region?.removeAttribute?.('aria-busy');
      projectsLiveEngine.status(region, 'Could not update the NSFW filter. The previous setting was kept.', 'error');
    });

  return true;
}

function bindProjectsNsfwForm(state, region) {
  const form = projectLiveNsfwForm(region);
  if (!form || isEnhancementBound(form, 'projectsNsfwBound')) return;
  markEnhancementBound(form, 'projectsNsfwBound');
  form.addEventListener?.('submit', (event) => submitProjectsNsfwToggle(state, form, event));
}

const projectsLiveEngine = createLiveRegionEngine({
  regionSelector: PROJECTS_LIVE_REGION_SELECTOR,
  formSelector: PROJECTS_FILTER_SELECTOR,
  searchSelector: PROJECTS_SEARCH_SELECTOR,
  debounceMs: PROJECTS_LIVE_DEBOUNCE_MS,
  defaultAction: '/projects',
  stateKey: '__creatorCrateProjectsLiveFiltering',
  historyState: { projects: true },
  statusSelector: PROJECTS_LIVE_STATUS_SELECTOR,
  statusStateAttribute: PROJECTS_LIVE_STATE_ATTRIBUTE,
  loadingMessage: 'Loading projects.',
  fallbackMessage: 'Projects are loading as a full page.',
  responseErrorMessage: 'Projects response failed.',
  missingRegionMessage: 'Projects response did not contain the live region.',
  enhanceRegion: enhanceProjectsLiveRegion,
  onCreate(state, region) {
    state.nsfwController = null;
    state.nsfwGeneration = 0;
    state.nsfwSubmitting = false;
    state.nsfwPostPending = false;
    state.nsfwNeedsRefresh = false;
    state.nsfwRefreshGeneration = null;
    state.nsfwRegionReplaced = false;
    state.nsfwEnabled = projectLiveRenderedNsfwEnabled(region);
    enhanceAssetViewerFilterDisclosures(state.document);
  },
  onBindRegion(state, region) {
    bindProjectsNsfwForm(state, region);
  },
  onInvalidate(state) {
    if (state.nsfwRefreshGeneration !== null) {
      state.nsfwNeedsRefresh = true;
      state.nsfwRefreshGeneration = null;
    }
  },
  onLoadStart(state, generation) {
    const refreshesNsfw = state.nsfwNeedsRefresh && !state.nsfwPostPending;
    if (refreshesNsfw) state.nsfwNeedsRefresh = false;
    if (refreshesNsfw) state.nsfwRefreshGeneration = generation;
  },
  onRegionReplaced(state, nextRegion) {
    if (!state.nsfwSubmitting) return;
    state.nsfwRegionReplaced = true;
    const renderedEnabled = projectLiveRenderedNsfwEnabled(nextRegion);
    state.nsfwEnabled = renderedEnabled;
    updateProjectsNsfwControls(nextRegion, renderedEnabled, true);
  },
  onLoadComplete(state, generation, region) {
    if (state.nsfwRefreshGeneration !== generation) return;
    state.nsfwRefreshGeneration = null;
    state.nsfwSubmitting = false;
    state.nsfwRegionReplaced = false;
    state.nsfwEnabled = projectLiveRenderedNsfwEnabled(region);
    updateProjectsNsfwControls(region, state.nsfwEnabled);
  },
  onLoadError(state, generation) {
    if (state.nsfwRefreshGeneration !== generation) return false;
    state.nsfwRefreshGeneration = null;
    state.nsfwNeedsRefresh = false;
    state.nsfwSubmitting = false;
    state.nsfwRegionReplaced = false;
    const region = projectsLiveEngine.getRegion(state.document);
    updateProjectsNsfwControls(region, state.nsfwEnabled);
    region?.removeAttribute?.('aria-busy');
    projectsLiveEngine.status(region, 'NSFW filter changed, but Projects could not refresh. Refresh the page to see updated previews.', 'error');
    return true;
  },
  isCurrentUrl(url) {
    return url.pathname === '/projects';
  },
});

const releasesLiveEngine = createLiveRegionEngine({
  regionSelector: RELEASES_LIVE_REGION_SELECTOR,
  formSelector: RELEASES_FILTER_SELECTOR,
  linkSelector: 'nav[aria-label="View"] a[data-releases-view-link], .pagination a, [data-releases-reset]',
  searchSelector: RELEASES_SEARCH_SELECTOR,
  debounceMs: RELEASES_LIVE_DEBOUNCE_MS,
  defaultAction: '/releases',
  stateKey: '__creatorCrateReleasesLiveFiltering',
  historyState: { releases: true },
  statusSelector: RELEASES_LIVE_STATUS_SELECTOR,
  statusStateAttribute: RELEASES_LIVE_STATE_ATTRIBUTE,
  loadingMessage: 'Loading releases.',
  fallbackMessage: 'Releases are loading as a full page.',
  responseErrorMessage: 'Releases response failed.',
  missingRegionMessage: 'Releases response did not contain the live region.',
  enhanceRegion() {},
  isCurrentUrl(url) {
    return url.pathname === '/releases';
  },
});

const PROJECT_ASSETS_LIVE_REGION_SELECTOR = '[data-project-assets-live-region]';
const PROJECT_ASSETS_FILTER_SELECTOR = ['#asset-filters', '.page-size-form'];
const PROJECT_ASSETS_SEARCH_SELECTOR = '#search';
const PROJECT_ASSETS_LIVE_STATUS_SELECTOR = '[data-project-assets-live-status]';
const PROJECT_ASSETS_LIVE_STATE_ATTRIBUTE = 'data-project-assets-live-state';
const PROJECT_ASSETS_NSFW_FORM_SELECTOR = '[data-project-assets-nsfw-filter]';
const PROJECT_ASSETS_NSFW_TOGGLE_SELECTOR = '[data-project-assets-nsfw-toggle]';
const PROJECT_ASSETS_LIVE_DEBOUNCE_MS = 350;

function projectAssetsNsfwForm(region) {
  return region?.querySelector?.(PROJECT_ASSETS_NSFW_FORM_SELECTOR) || null;
}

function projectAssetsNsfwEnabled(form) {
  const value = form?.querySelector?.('[data-project-assets-nsfw-value]')?.value
    || form?.querySelector?.('[data-project-assets-nsfw-value]')?.getAttribute?.('value');
  return value === '1';
}

function projectAssetsRenderedNsfwEnabled(region) {
  return region?.querySelector?.(PROJECT_ASSETS_NSFW_TOGGLE_SELECTOR)?.getAttribute?.('aria-pressed') === 'true';
}

function updateProjectAssetsNsfwControls(scope, enabled, pending = false) {
  const controls = Array.from(scope?.querySelectorAll?.(PROJECT_ASSETS_NSFW_TOGGLE_SELECTOR) || []);
  const label = enabled ? 'Disable NSFW filter' : 'Enable NSFW filter';
  controls.forEach((control) => {
    control.disabled = pending;
    if (pending) control.setAttribute?.('disabled', '');
    else control.removeAttribute?.('disabled');
    control.setAttribute?.('aria-pressed', String(enabled));
    control.setAttribute?.('aria-label', label);
    control.setAttribute?.('data-tooltip', label);
  });
  scope?.querySelectorAll?.(PROJECT_ASSETS_NSFW_FORM_SELECTOR).forEach((form) => {
    const value = form.querySelector?.('[data-project-assets-nsfw-value]');
    if (value) value.value = enabled ? '0' : '1';
    if (pending) form.setAttribute?.('aria-busy', 'true');
    else form.removeAttribute?.('aria-busy');
  });
}

function submitProjectAssetsNsfwToggle(state, form, event) {
  if (!projectAssetsLiveEngine.capabilities(state.window)) return false;
  if (state.assetNsfwSubmitting) {
    event.preventDefault?.();
    return true;
  }

  let refreshUrl;
  try {
    if (state.timer) state.window.clearTimeout?.(state.timer);
    state.timer = null;
    refreshUrl = state.controller && state.requestedUrl
      ? new URL(state.requestedUrl.href, state.window.location?.href || state.requestedUrl.href)
      : projectAssetsLiveEngine.url(
        projectAssetsLiveEngine.getForm(projectAssetsLiveEngine.getRegion(state.document)),
        state.window,
        { preservePage: true },
      );
  } catch {
    return false;
  }

  event.preventDefault?.();
  projectAssetsLiveEngine.invalidate(state);
  state.assetNsfwGeneration += 1;
  const generation = state.assetNsfwGeneration;
  const enabled = projectAssetsNsfwEnabled(form);
  const previousEnabled = projectAssetsRenderedNsfwEnabled(projectAssetsLiveEngine.getRegion(state.document));
  state.assetNsfwSubmitting = true;
  state.assetNsfwPostPending = true;
  state.assetNsfwNeedsRefresh = false;
  state.assetNsfwRegionReplaced = false;
  state.assetNsfwPreviousEnabled = previousEnabled;
  state.assetNsfwEnabled = enabled;

  const controller = projectAssetsLiveEngine.controller(state.window);
  state.assetNsfwController?.abort?.();
  state.assetNsfwController = controller;
  let requestBody;
  try {
    requestBody = new state.window.URLSearchParams(new state.window.FormData(form));
    requestBody.set('enabled', enabled ? '1' : '0');
  } catch {
    state.assetNsfwSubmitting = false;
    state.assetNsfwPostPending = false;
    updateProjectAssetsNsfwControls(projectAssetsLiveEngine.getRegion(state.document), previousEnabled);
    projectAssetsLiveEngine.nativeSubmit(form);
    return true;
  }
  updateProjectAssetsNsfwControls(projectAssetsLiveEngine.getRegion(state.document), enabled, true);
  const options = {
    method: String(form.method || form.getAttribute?.('method') || 'POST').toUpperCase(),
    body: requestBody,
    credentials: 'same-origin',
    redirect: 'follow',
    headers: { Accept: 'application/json' },
  };
  if (controller) options.signal = controller.signal;

  let request;
  try {
    request = state.window.fetch(form.action || form.getAttribute?.('action'), options);
  } catch (error) {
    request = Promise.reject(error);
  }

  Promise.resolve(request)
    .then(async (response) => {
      if (!response?.ok) throw new Error('NSFW filter update failed.');
      const payload = typeof response.json === 'function' ? await response.json() : null;
      if (payload?.status !== 'success' || typeof payload.enabled !== 'boolean') {
        throw new Error('NSFW filter update failed.');
      }
      return payload;
    })
    .then((payload) => {
      if (generation !== state.assetNsfwGeneration) return;
      state.assetNsfwController = null;
      state.assetNsfwPostPending = false;
      state.assetNsfwEnabled = payload.enabled;
      state.assetNsfwNeedsRefresh = true;
      projectAssetsLiveEngine.invalidate(state);
      updateProjectAssetsNsfwControls(projectAssetsLiveEngine.getRegion(state.document), payload.enabled, true);
      projectAssetsLiveEngine.load(
        state,
        refreshUrl,
        'none',
        projectAssetsLiveEngine.getForm(projectAssetsLiveEngine.getRegion(state.document)),
      );
    })
    .catch(() => {
      if (generation !== state.assetNsfwGeneration) return;
      state.assetNsfwController = null;
      state.assetNsfwPostPending = false;
      state.assetNsfwSubmitting = false;
      state.assetNsfwNeedsRefresh = false;
      const region = projectAssetsLiveEngine.getRegion(state.document);
      const enabledState = state.assetNsfwRegionReplaced
        ? projectAssetsRenderedNsfwEnabled(region)
        : state.assetNsfwPreviousEnabled;
      state.assetNsfwEnabled = enabledState;
      state.assetNsfwRegionReplaced = false;
      updateProjectAssetsNsfwControls(region, enabledState);
      region?.removeAttribute?.('aria-busy');
      projectAssetsLiveEngine.status(region, 'Could not update the NSFW filter. The previous setting was kept.', 'error');
    });

  return true;
}

function bindProjectAssetsNsfwForm(state, region) {
  const form = projectAssetsNsfwForm(region);
  if (!form || isEnhancementBound(form, 'projectAssetsNsfwBound')) return;
  markEnhancementBound(form, 'projectAssetsNsfwBound');
  form.addEventListener?.('submit', (event) => submitProjectAssetsNsfwToggle(state, form, event));
}

function enhanceProjectAssetsLiveRegion(region) {
  enhancePreviewMedia(region);
  enhanceAssetSelection(region);
  enhanceAssetRenames(region);
  enhanceAssetGridSize(region);
  enhanceAssetAutoRenameOrdering(region);
  enhanceConfirmations(region);
  enhanceProjectAssetCategoryFilter(region);
  enhanceAssetViewerFilterDisclosures(liveRegionDocument(region));
  enhanceSlideshow(liveRegionDocument(region));
}

const projectAssetsLiveEngine = createLiveRegionEngine({
  regionSelector: PROJECT_ASSETS_LIVE_REGION_SELECTOR,
  formSelector: PROJECT_ASSETS_FILTER_SELECTOR,
  searchSelector: PROJECT_ASSETS_SEARCH_SELECTOR,
  linkSelector: 'nav.view-switcher a, .pagination a, [data-project-assets-reset]',
  debounceMs: PROJECT_ASSETS_LIVE_DEBOUNCE_MS,
  defaultAction: '/projects',
  stateKey: '__creatorCrateProjectAssetsLiveFiltering',
  historyState: { projectAssets: true },
  statusSelector: PROJECT_ASSETS_LIVE_STATUS_SELECTOR,
  statusStateAttribute: PROJECT_ASSETS_LIVE_STATE_ATTRIBUTE,
  loadingMessage: 'Loading Project Assets.',
  fallbackMessage: 'Project Assets are loading as a full page.',
  responseErrorMessage: 'Project Assets response failed.',
  missingRegionMessage: 'Project Assets response did not contain the live region.',
  enhanceRegion: enhanceProjectAssetsLiveRegion,
  onResponseParsed(state, parsed) {
    const nextSequence = parsed.querySelector?.(`${SLIDESHOW_SCAFFOLD_SELECTOR} ${SLIDESHOW_SEQUENCE_SELECTOR}`);
    const currentSequence = state.document.querySelector?.(
      `${SLIDESHOW_SCAFFOLD_SELECTOR} ${SLIDESHOW_SEQUENCE_SELECTOR}`,
    );
    if (nextSequence && currentSequence) currentSequence.textContent = nextSequence.textContent || '[]';

    const nextDefaultsReturn = parsed.querySelector?.('#project-assets-defaults-form input[name="returnTo"]');
    const currentDefaultsReturn = state.document.querySelector?.('#project-assets-defaults-form input[name="returnTo"]');
    if (nextDefaultsReturn && currentDefaultsReturn) {
      currentDefaultsReturn.value = nextDefaultsReturn.value || '';
      const dialog = state.document.getElementById?.('project-assets-defaults-dialog');
      const dialogState = dialog?.__creatorCrateAppDialogState;
      if (dialogState?.savedValues) dialogState.savedValues.returnTo = currentDefaultsReturn.value;
    }
  },
  onCreate(state, region) {
    state.assetNsfwController = null;
    state.assetNsfwGeneration = 0;
    state.assetNsfwSubmitting = false;
    state.assetNsfwPostPending = false;
    state.assetNsfwNeedsRefresh = false;
    state.assetNsfwRefreshGeneration = null;
    state.assetNsfwRegionReplaced = false;
    state.assetNsfwEnabled = projectAssetsRenderedNsfwEnabled(region);
    enhanceAssetViewerFilterDisclosures(state.document);
  },
  onBindRegion(state, region) {
    bindProjectAssetsNsfwForm(state, region);
  },
  onInvalidate(state) {
    if (state.assetNsfwPostPending) {
      state.assetNsfwGeneration += 1;
      state.assetNsfwController?.abort?.();
      state.assetNsfwController = null;
      state.assetNsfwPostPending = false;
      state.assetNsfwSubmitting = false;
      state.assetNsfwNeedsRefresh = false;
      updateProjectAssetsNsfwControls(
        projectAssetsLiveEngine.getRegion(state.document),
        state.assetNsfwPreviousEnabled,
      );
    }
    if (state.assetNsfwRefreshGeneration !== null) {
      state.assetNsfwNeedsRefresh = true;
      state.assetNsfwRefreshGeneration = null;
    }
  },
  onLoadStart(state, generation) {
    const refreshesNsfw = state.assetNsfwNeedsRefresh && !state.assetNsfwPostPending;
    if (refreshesNsfw) state.assetNsfwNeedsRefresh = false;
    if (refreshesNsfw) state.assetNsfwRefreshGeneration = generation;
  },
  onRegionReplaced(state, nextRegion) {
    if (!state.assetNsfwSubmitting) return;
    state.assetNsfwRegionReplaced = true;
    const renderedEnabled = projectAssetsRenderedNsfwEnabled(nextRegion);
    state.assetNsfwEnabled = renderedEnabled;
    updateProjectAssetsNsfwControls(nextRegion, renderedEnabled, true);
  },
  onLoadComplete(state, generation, region) {
    if (state.assetNsfwRefreshGeneration !== generation) return;
    state.assetNsfwRefreshGeneration = null;
    state.assetNsfwSubmitting = false;
    state.assetNsfwRegionReplaced = false;
    state.assetNsfwEnabled = projectAssetsRenderedNsfwEnabled(region);
    updateProjectAssetsNsfwControls(region, state.assetNsfwEnabled);
  },
  onLoadError(state, generation) {
    if (state.assetNsfwRefreshGeneration !== generation) return false;
    state.assetNsfwRefreshGeneration = null;
    state.assetNsfwNeedsRefresh = false;
    state.assetNsfwSubmitting = false;
    state.assetNsfwRegionReplaced = false;
    const region = projectAssetsLiveEngine.getRegion(state.document);
    updateProjectAssetsNsfwControls(region, state.assetNsfwEnabled);
    region?.removeAttribute?.('aria-busy');
    projectAssetsLiveEngine.status(region, 'NSFW filter changed, but Project Assets could not refresh. Refresh the page to see updated previews.', 'error');
    return true;
  },
  isCurrentUrl(url) {
    return /^\/projects\/[1-9]\d*\/assets$/.test(url.pathname);
  },
});

export function enhanceProjectAssetsLiveFiltering(scope = globalThis.document) {
  return projectAssetsLiveEngine.enhance(scope);
}

export function enhanceProjectsLiveFiltering(scope = globalThis.document) {
  return projectsLiveEngine.enhance(scope);
}

export function enhanceReleasesLiveFiltering(scope = globalThis.document) {
  return releasesLiveEngine.enhance(scope);
}

const ASSET_LIBRARY_LIVE_REGION_SELECTOR = '[data-asset-library-live-region]';
const ASSET_LIBRARY_FILTER_SELECTOR = '#asset-filters';
const ASSET_LIBRARY_LIVE_STATUS_SELECTOR = '[data-asset-library-live-status]';
const ASSET_LIBRARY_LIVE_STATE_ATTRIBUTE = 'data-asset-library-live-state';
const ASSET_LIBRARY_NSFW_FORM_SELECTOR = '[data-asset-library-nsfw-filter]';
const ASSET_LIBRARY_NSFW_TOGGLE_SELECTOR = '[data-asset-library-nsfw-toggle]';
const ASSET_LIBRARY_LIVE_DEBOUNCE_MS = 350;

function assetLibraryNsfwForm(region) {
  return region?.querySelector?.(ASSET_LIBRARY_NSFW_FORM_SELECTOR) || null;
}

function assetLibraryNsfwEnabled(form) {
  const value = form?.querySelector?.('[data-asset-library-nsfw-value]')?.value
    || form?.querySelector?.('[data-asset-library-nsfw-value]')?.getAttribute?.('value');
  return value === '1';
}

function assetLibraryRenderedNsfwEnabled(region) {
  return region?.querySelector?.(ASSET_LIBRARY_NSFW_TOGGLE_SELECTOR)?.getAttribute?.('aria-pressed') === 'true';
}

function updateAssetLibraryNsfwControls(scope, enabled, pending = false) {
  const controls = Array.from(scope?.querySelectorAll?.(ASSET_LIBRARY_NSFW_TOGGLE_SELECTOR) || []);
  const label = enabled ? 'Disable NSFW filter' : 'Enable NSFW filter';
  controls.forEach((control) => {
    control.disabled = pending;
    if (pending) control.setAttribute?.('disabled', '');
    else control.removeAttribute?.('disabled');
    control.setAttribute?.('aria-pressed', String(enabled));
    control.setAttribute?.('aria-label', label);
    control.setAttribute?.('data-tooltip', label);
  });
  scope?.querySelectorAll?.(ASSET_LIBRARY_NSFW_FORM_SELECTOR).forEach((form) => {
    const value = form.querySelector?.('[data-asset-library-nsfw-value]');
    if (value) value.value = enabled ? '0' : '1';
    if (pending) form.setAttribute?.('aria-busy', 'true');
    else form.removeAttribute?.('aria-busy');
  });
}

function submitAssetLibraryNsfwToggle(state, form, event) {
  if (!assetLibraryLiveEngine.capabilities(state.window)) return false;
  if (state.libNsfwSubmitting) {
    event.preventDefault?.();
    return true;
  }

  let refreshUrl;
  try {
    if (state.timer) state.window.clearTimeout?.(state.timer);
    state.timer = null;
    refreshUrl = state.controller && state.requestedUrl
      ? new URL(state.requestedUrl.href, state.window.location?.href || state.requestedUrl.href)
      : assetLibraryLiveEngine.url(
        assetLibraryLiveEngine.getForm(assetLibraryLiveEngine.getRegion(state.document)),
        state.window,
        { preservePage: true },
      );
  } catch {
    return false;
  }

  event.preventDefault?.();
  assetLibraryLiveEngine.invalidate(state);
  state.libNsfwGeneration += 1;
  const generation = state.libNsfwGeneration;
  const enabled = assetLibraryNsfwEnabled(form);
  const previousEnabled = assetLibraryRenderedNsfwEnabled(assetLibraryLiveEngine.getRegion(state.document));
  state.libNsfwSubmitting = true;
  state.libNsfwPostPending = true;
  state.libNsfwNeedsRefresh = false;
  state.libNsfwRegionReplaced = false;
  state.libNsfwPreviousEnabled = previousEnabled;
  state.libNsfwEnabled = enabled;

  const controller = assetLibraryLiveEngine.controller(state.window);
  state.libNsfwController?.abort?.();
  state.libNsfwController = controller;
  let requestBody;
  try {
    requestBody = new state.window.URLSearchParams(new state.window.FormData(form));
    requestBody.set('enabled', enabled ? '1' : '0');
  } catch {
    state.libNsfwSubmitting = false;
    state.libNsfwPostPending = false;
    updateAssetLibraryNsfwControls(assetLibraryLiveEngine.getRegion(state.document), previousEnabled);
    assetLibraryLiveEngine.nativeSubmit(form);
    return true;
  }
  updateAssetLibraryNsfwControls(assetLibraryLiveEngine.getRegion(state.document), enabled, true);
  const options = {
    method: String(form.method || form.getAttribute?.('method') || 'POST').toUpperCase(),
    body: requestBody,
    credentials: 'same-origin',
    redirect: 'follow',
    headers: { Accept: 'application/json' },
  };
  if (controller) options.signal = controller.signal;

  let request;
  try {
    request = state.window.fetch(form.action || form.getAttribute?.('action'), options);
  } catch (error) {
    request = Promise.reject(error);
  }

  Promise.resolve(request)
    .then(async (response) => {
      if (!response?.ok) throw new Error('NSFW filter update failed.');
      const payload = typeof response.json === 'function' ? await response.json() : null;
      if (payload?.status !== 'success' || typeof payload.enabled !== 'boolean') {
        throw new Error('NSFW filter update failed.');
      }
      return payload;
    })
    .then((payload) => {
      if (generation !== state.libNsfwGeneration) return;
      state.libNsfwController = null;
      state.libNsfwPostPending = false;
      state.libNsfwEnabled = payload.enabled;
      state.libNsfwNeedsRefresh = true;
      assetLibraryLiveEngine.invalidate(state);
      updateAssetLibraryNsfwControls(assetLibraryLiveEngine.getRegion(state.document), payload.enabled, true);
      assetLibraryLiveEngine.load(
        state,
        refreshUrl,
        'none',
        assetLibraryLiveEngine.getForm(assetLibraryLiveEngine.getRegion(state.document)),
      );
    })
    .catch(() => {
      if (generation !== state.libNsfwGeneration) return;
      state.libNsfwController = null;
      state.libNsfwPostPending = false;
      state.libNsfwSubmitting = false;
      state.libNsfwNeedsRefresh = false;
      const region = assetLibraryLiveEngine.getRegion(state.document);
      const enabledState = state.libNsfwRegionReplaced
        ? assetLibraryRenderedNsfwEnabled(region)
        : state.libNsfwPreviousEnabled;
      state.libNsfwEnabled = enabledState;
      state.libNsfwRegionReplaced = false;
      updateAssetLibraryNsfwControls(region, enabledState);
      region?.removeAttribute?.('aria-busy');
      assetLibraryLiveEngine.status(region, 'Could not update the NSFW filter. The previous setting was kept.', 'error');
    });

  return true;
}

function bindAssetLibraryNsfwForm(state, region) {
  const form = assetLibraryNsfwForm(region);
  if (!form || isEnhancementBound(form, 'assetLibraryNsfwBound')) return;
  markEnhancementBound(form, 'assetLibraryNsfwBound');
  form.addEventListener?.('submit', (event) => submitAssetLibraryNsfwToggle(state, form, event));
}

function enhanceAssetLibraryLiveRegion(region) {
  enhancePreviewMedia(region);
  enhanceAssetGridSize(region);
  enhanceAssetProjectFilter(region);
  enhanceAssetViewerFilterDisclosures(liveRegionDocument(region));
  enhanceAssetViewerInfoCards(region);
  enhanceSlideshow(liveRegionDocument(region));
}

const assetLibraryLiveEngine = createLiveRegionEngine({
  regionSelector: ASSET_LIBRARY_LIVE_REGION_SELECTOR,
  formSelector: ASSET_LIBRARY_FILTER_SELECTOR,
  linkSelector: 'nav.view-switcher a, .pagination a, [data-asset-library-reset]',
  debounceMs: ASSET_LIBRARY_LIVE_DEBOUNCE_MS,
  defaultAction: '/assets',
  stateKey: '__creatorCrateAssetLibraryLiveFiltering',
  historyState: { assetLibrary: true },
  statusSelector: ASSET_LIBRARY_LIVE_STATUS_SELECTOR,
  statusStateAttribute: ASSET_LIBRARY_LIVE_STATE_ATTRIBUTE,
  loadingMessage: 'Loading Asset Viewer.',
  fallbackMessage: 'Asset Viewer is loading as a full page.',
  responseErrorMessage: 'Asset Viewer response failed.',
  missingRegionMessage: 'Asset Viewer response did not contain the live region.',
  enhanceRegion: enhanceAssetLibraryLiveRegion,
  onResponseParsed(state, parsed) {
    const nextSequence = parsed.querySelector?.(`${SLIDESHOW_SCAFFOLD_SELECTOR} ${SLIDESHOW_SEQUENCE_SELECTOR}`);
    const currentSequence = state.document.querySelector?.(
      `${SLIDESHOW_SCAFFOLD_SELECTOR} ${SLIDESHOW_SEQUENCE_SELECTOR}`,
    );
    if (nextSequence && currentSequence) currentSequence.textContent = nextSequence.textContent || '[]';

    const nextDefaultsReturn = parsed.querySelector?.('#asset-viewer-defaults-form input[name="returnTo"]');
    const currentDefaultsReturn = state.document.querySelector?.('#asset-viewer-defaults-form input[name="returnTo"]');
    if (nextDefaultsReturn && currentDefaultsReturn) {
      currentDefaultsReturn.value = nextDefaultsReturn.value || '';
      const dialog = state.document.getElementById?.('asset-viewer-defaults-dialog');
      const dialogState = dialog?.__creatorCrateAppDialogState;
      if (dialogState?.savedValues) dialogState.savedValues.returnTo = currentDefaultsReturn.value;
    }
  },
  onCreate(state, region) {
    state.libNsfwController = null;
    state.libNsfwGeneration = 0;
    state.libNsfwSubmitting = false;
    state.libNsfwPostPending = false;
    state.libNsfwNeedsRefresh = false;
    state.libNsfwRefreshGeneration = null;
    state.libNsfwRegionReplaced = false;
    state.libNsfwEnabled = assetLibraryRenderedNsfwEnabled(region);
    enhanceAssetViewerFilterDisclosures(state.document);
  },
  onBindRegion(state, region) {
    bindAssetLibraryNsfwForm(state, region);
  },
  onInvalidate(state) {
    if (state.libNsfwPostPending) {
      state.libNsfwGeneration += 1;
      state.libNsfwController?.abort?.();
      state.libNsfwController = null;
      state.libNsfwPostPending = false;
      state.libNsfwSubmitting = false;
      state.libNsfwNeedsRefresh = false;
      updateAssetLibraryNsfwControls(
        assetLibraryLiveEngine.getRegion(state.document),
        state.libNsfwPreviousEnabled,
      );
    }
    if (state.libNsfwRefreshGeneration !== null) {
      state.libNsfwNeedsRefresh = true;
      state.libNsfwRefreshGeneration = null;
    }
  },
  onLoadStart(state, generation) {
    const refreshesNsfw = state.libNsfwNeedsRefresh && !state.libNsfwPostPending;
    if (refreshesNsfw) state.libNsfwNeedsRefresh = false;
    if (refreshesNsfw) state.libNsfwRefreshGeneration = generation;
  },
  onRegionReplaced(state, nextRegion) {
    if (!state.libNsfwSubmitting) return;
    state.libNsfwRegionReplaced = true;
    const renderedEnabled = assetLibraryRenderedNsfwEnabled(nextRegion);
    state.libNsfwEnabled = renderedEnabled;
    updateAssetLibraryNsfwControls(nextRegion, renderedEnabled, true);
  },
  onLoadComplete(state, generation, region) {
    if (state.libNsfwRefreshGeneration !== generation) return;
    state.libNsfwRefreshGeneration = null;
    state.libNsfwSubmitting = false;
    state.libNsfwRegionReplaced = false;
    state.libNsfwEnabled = assetLibraryRenderedNsfwEnabled(region);
    updateAssetLibraryNsfwControls(region, state.libNsfwEnabled);
  },
  onLoadError(state, generation) {
    if (state.libNsfwRefreshGeneration !== generation) return false;
    state.libNsfwRefreshGeneration = null;
    state.libNsfwNeedsRefresh = false;
    state.libNsfwSubmitting = false;
    state.libNsfwRegionReplaced = false;
    const region = assetLibraryLiveEngine.getRegion(state.document);
    updateAssetLibraryNsfwControls(region, state.libNsfwEnabled);
    region?.removeAttribute?.('aria-busy');
    assetLibraryLiveEngine.status(region, 'NSFW filter changed, but the Asset Viewer could not refresh. Refresh the page to see updated previews.', 'error');
    return true;
  },
  isCurrentUrl(url) {
    return url.pathname === '/assets';
  },
});

export function enhanceAssetLibraryLiveFiltering(scope = globalThis.document) {
  return assetLibraryLiveEngine.enhance(scope);
}

function assetProjectFilterFieldName(filter) {
  return filter?.dataset?.assetProjectFilterName
    || filter?.getAttribute?.('data-asset-project-filter-name')
    || 'project';
}

function assetProjectFilterEmptyLabel(filter, hasEmptyOption) {
  const configuredLabel = filter?.dataset?.assetProjectFilterEmptyLabel
    || filter?.getAttribute?.('data-asset-project-filter-empty-label');
  if (configuredLabel) return configuredLabel;
  return hasEmptyOption ? 'All projects' : 'Select a project';
}

function assetProjectFilterInput(option, fieldName = 'project') {
  return option?.querySelector?.(`input[name="${fieldName}"]`) || null;
}

function assetProjectFilterValue(input) {
  return String(input?.value ?? input?.getAttribute?.('value') ?? '');
}

function assetProjectFilterTitle(option) {
  const title = option?.getAttribute?.('data-project-title');
  if (typeof title === 'string' && title !== '') return title;
  return String(option?.querySelector?.('label')?.textContent || '').trim();
}

function updateAssetProjectFilterSummary(filter, options) {
  const fieldName = assetProjectFilterFieldName(filter);
  const emptyOption = options.find((option) => assetProjectFilterValue(assetProjectFilterInput(option, fieldName)) === '');
  let selectedOption = options.find((option) => assetProjectFilterInput(option, fieldName)?.checked);
  if (!selectedOption && emptyOption) {
    selectedOption = emptyOption;
    assetProjectFilterInput(selectedOption, fieldName).checked = true;
  }

  const selectedInput = assetProjectFilterInput(selectedOption, fieldName);
  const emptyLabel = assetProjectFilterEmptyLabel(filter, Boolean(emptyOption));
  const selectedTitle = selectedInput && assetProjectFilterValue(selectedInput) !== ''
    ? assetProjectFilterTitle(selectedOption)
    : emptyLabel;
  const summary = filter.querySelector?.(ASSET_PROJECT_FILTER_SUMMARY_SELECTOR);
  const currentSummary = filter.querySelector?.(ASSET_PROJECT_FILTER_CURRENT_SUMMARY_SELECTOR) || summary;
  const trigger = filter.querySelector?.('summary');
  if (currentSummary) currentSummary.textContent = selectedTitle || emptyLabel;
  trigger?.setAttribute?.('aria-label', `Project filter: ${selectedTitle || emptyLabel}`);
  trigger?.setAttribute?.('title', selectedTitle || emptyLabel);
}

function updateAssetProjectFilterOptions(filter, options) {
  const fieldName = assetProjectFilterFieldName(filter);
  const search = filter.querySelector?.(ASSET_PROJECT_FILTER_SEARCH_SELECTOR);
  const empty = filter.querySelector?.(ASSET_PROJECT_FILTER_EMPTY_SELECTOR);
  const query = String(search?.value || '').trim().toLowerCase();
  const projectOptions = options.filter((option) => (
    assetProjectFilterValue(assetProjectFilterInput(option, fieldName)) !== ''
  ));
  let matchingProjectCount = 0;

  projectOptions.forEach((option) => {
    const matches = query === '' || assetProjectFilterTitle(option).toLowerCase().includes(query);
    setHidden(option, !matches);
    if (matches) matchingProjectCount += 1;
  });

  const allProjects = options.find((option) => assetProjectFilterValue(assetProjectFilterInput(option, fieldName)) === '');
  setHidden(allProjects, false);
  setHidden(empty, query === '' || matchingProjectCount > 0);
}

function updateAssetProjectFilterDisclosure(filter) {
  filter.querySelector?.('summary')?.setAttribute?.('aria-expanded', String(filter.open === true));
}

function updateAssetViewerFilterDisclosureState(disclosure) {
  disclosure?.querySelector?.('summary')?.setAttribute?.('aria-expanded', String(disclosure.open === true));
}

function isAssetViewerFilterSingleSelect(disclosure) {
  return Object.hasOwn(disclosure?.dataset || {}, 'assetViewerFilterSingleSelect');
}

function isAssetViewerFilterMultiSelect(disclosure) {
  return Object.hasOwn(disclosure?.dataset || {}, 'assetViewerFilterMultiSelect');
}

function assetViewerFilterSingleSelectLabel(input) {
  const labelText = String(input?.closest?.('label')?.textContent || '').trim().replace(/\s+/g, ' ');
  return labelText || String(input?.value ?? '').trim();
}

function assetViewerFilterMultiSelectLabel(input) {
  return String(input?.closest?.('label')?.textContent || '').trim().replace(/\s+/g, ' ');
}

function updateAssetViewerFilterSingleSelectSummary(disclosure) {
  if (!isAssetViewerFilterSingleSelect(disclosure)) return;

  const selectedInput = disclosure.querySelector?.('input[type="radio"]:checked');
  const selectedLabel = assetViewerFilterSingleSelectLabel(selectedInput);
  if (!selectedInput || selectedLabel === '') return;

  const currentSummary = disclosure.querySelector?.(ASSET_VIEWER_FILTER_SINGLE_SELECT_SUMMARY_SELECTOR);
  if (currentSummary) currentSummary.textContent = selectedLabel;

  const summary = disclosure.querySelector?.('summary');
  const ariaLabel = summary?.getAttribute?.('aria-label');
  if (typeof ariaLabel !== 'string' || ariaLabel === '') return;

  const separator = ariaLabel.indexOf(':');
  summary.setAttribute(
    'aria-label',
    separator >= 0 ? `${ariaLabel.slice(0, separator + 1)} ${selectedLabel}` : selectedLabel,
  );
}

function updateAssetViewerFilterMultiSelectSummary(disclosure) {
  if (!isAssetViewerFilterMultiSelect(disclosure)) return;

  const inputs = Array.from(disclosure.querySelectorAll?.('input[type="checkbox"]') || []);
  const selectedInputs = inputs.filter((input) => input.checked);
  const summary = disclosure.querySelector?.('summary');
  const currentSummary = disclosure.querySelector?.(ASSET_VIEWER_FILTER_SINGLE_SELECT_SUMMARY_SELECTOR);
  if (!summary || !currentSummary) return;

  let summaryText;
  if (selectedInputs.length === 0) {
    summaryText = 'No tags selected';
  } else if (selectedInputs.length === 1) {
    summaryText = assetViewerFilterMultiSelectLabel(selectedInputs[0]) || '1 tag selected';
  } else {
    summaryText = `${selectedInputs.length} tags selected`;
  }

  currentSummary.textContent = summaryText;

  const ariaLabel = summary.getAttribute?.('aria-label');
  if (typeof ariaLabel === 'string' && ariaLabel !== '') {
    const separator = ariaLabel.indexOf(':');
    summary.setAttribute(
      'aria-label',
      separator >= 0 ? `${ariaLabel.slice(0, separator + 1)} ${summaryText}` : summaryText,
    );
  }
}

function getAssetViewerFilterDisclosures(scope) {
  return Array.from(scope?.querySelectorAll?.(ASSET_VIEWER_FILTER_DISCLOSURE_SELECTOR) || []);
}

function findAssetViewerFilterDisclosure(disclosures, target) {
  const disclosure = target?.closest?.(ASSET_VIEWER_FILTER_DISCLOSURE_SELECTOR);
  return disclosures.includes(disclosure) ? disclosure : null;
}

function closeAssetViewerFilterDisclosures(disclosures, except = null) {
  disclosures.forEach((disclosure) => {
    if (disclosure === except || disclosure.open !== true) return;
    disclosure.open = false;
    updateAssetViewerFilterDisclosureState(disclosure);
  });
}

export function enhanceAssetViewerFilterDisclosures(scope = globalThis.document) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;

  const disclosures = getAssetViewerFilterDisclosures(scope);
  disclosures.forEach((disclosure) => {
    updateAssetViewerFilterDisclosureState(disclosure);
    updateAssetViewerFilterSingleSelectSummary(disclosure);
    updateAssetViewerFilterMultiSelectSummary(disclosure);
  });
  if (disclosures.length === 0) return 0;

  if (!isEnhancementBound(scope, 'assetViewerFilterDisclosuresBound')) {
    markEnhancementBound(scope, 'assetViewerFilterDisclosuresBound');

    scope.addEventListener?.('click', (event) => {
      const currentDisclosures = getAssetViewerFilterDisclosures(scope);
      const current = findAssetViewerFilterDisclosure(currentDisclosures, event.target);
      closeAssetViewerFilterDisclosures(currentDisclosures, current);
    });

    scope.addEventListener?.('change', (event) => {
      const currentDisclosures = getAssetViewerFilterDisclosures(scope);
      const disclosure = findAssetViewerFilterDisclosure(currentDisclosures, event.target);
      if (!disclosure) return;

      if (event.target?.type === 'radio') {
        updateAssetViewerFilterSingleSelectSummary(disclosure);
      } else if (event.target?.type === 'checkbox') {
        updateAssetViewerFilterMultiSelectSummary(disclosure);
      }
    });

    scope.addEventListener?.('keydown', (event) => {
      if (event.key !== 'Escape') return;

      const currentDisclosures = getAssetViewerFilterDisclosures(scope);
      const targetDisclosure = findAssetViewerFilterDisclosure(currentDisclosures, event.target);
      const active = targetDisclosure?.open === true
        ? targetDisclosure
        : currentDisclosures.find((disclosure) => disclosure.open === true);
      if (!active) return;

      event.preventDefault?.();
      active.open = false;
      updateAssetViewerFilterDisclosureState(active);
      active.querySelector?.('summary')?.focus?.();
    });

    scope.addEventListener?.('toggle', (event) => {
      const currentDisclosures = getAssetViewerFilterDisclosures(scope);
      const disclosure = currentDisclosures.includes(event.target) ? event.target : null;
      if (!disclosure) return;

      updateAssetViewerFilterDisclosureState(disclosure);
      if (disclosure.open === true) {
        closeAssetViewerFilterDisclosures(currentDisclosures, disclosure);
      }
    }, true);
  }

  return disclosures.length;
}

export function enhanceAssetProjectFilter(scope = globalThis.document) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;

  const filters = scope.querySelectorAll(ASSET_PROJECT_FILTER_SELECTOR);
  filters.forEach((filter) => {
    const options = Array.from(filter.querySelectorAll?.(ASSET_PROJECT_FILTER_OPTION_SELECTOR) || []);
    const search = filter.querySelector?.(ASSET_PROJECT_FILTER_SEARCH_SELECTOR);
    const fieldName = assetProjectFilterFieldName(filter);

    if (!isEnhancementBound(filter, 'assetProjectFilterBound')) {
      markEnhancementBound(filter, 'assetProjectFilterBound');
      search?.addEventListener?.('input', () => updateAssetProjectFilterOptions(filter, options));
      options.forEach((option) => {
        assetProjectFilterInput(option, fieldName)?.addEventListener?.('change', () => {
          updateAssetProjectFilterSummary(filter, options);
        });
      });
      filter.addEventListener?.('toggle', () => updateAssetProjectFilterDisclosure(filter));
    }

    updateAssetProjectFilterSummary(filter, options);
    updateAssetProjectFilterOptions(filter, options);
    updateAssetProjectFilterDisclosure(filter);
  });

  return filters.length;
}

function getProjectAssetCategoryFilterInput(option) {
  return option?.querySelector?.('input[name="category"]') || null;
}

function updateProjectAssetCategoryFilter(filter, options, presenceControl, syncPresence = false) {
  let selectedOption = options.find((option) => getProjectAssetCategoryFilterInput(option)?.checked);
  let selectedInput = getProjectAssetCategoryFilterInput(selectedOption);
  const missingOption = options.find((option) => {
    const input = getProjectAssetCategoryFilterInput(option);
    return input?.value === 'all'
      && input?.getAttribute?.('data-asset-category-presence') === 'missing';
  });
  const missingLabel = missingOption?.querySelector?.('label')?.textContent?.trim() || 'Missing';
  const selectedPresence = selectedInput?.getAttribute?.('data-asset-category-presence') || 'all';

  const presenceControls = Array.isArray(presenceControl) ? presenceControl : [presenceControl];
  const selectedPresenceControl = presenceControls.find((control) => (
    control?.type === 'radio' ? control.checked : control?.value
  ));
  let effectivePresence = selectedPresenceControl?.type === 'radio'
    ? selectedPresenceControl.getAttribute?.('value') || selectedPresenceControl.value
    : selectedPresenceControl?.value;

  if (syncPresence && selectedPresence) {
    presenceControls.forEach((control) => {
      if (control?.type === 'radio') {
        control.checked = String(control.value || control.getAttribute?.('value') || '') === selectedPresence;
      } else {
        control.value = selectedPresence;
      }
    });
    effectivePresence = selectedPresence;
  } else if (effectivePresence === 'missing' && selectedPresence !== 'missing') {
    const missingInput = options
      .map(getProjectAssetCategoryFilterInput)
      .find((input) => input?.value === 'all'
        && input?.getAttribute?.('data-asset-category-presence') === 'missing');
    if (missingInput) missingInput.checked = true;
  } else if (effectivePresence !== 'missing' && selectedPresence === 'missing') {
    const allInput = options
      .map(getProjectAssetCategoryFilterInput)
      .find((input) => input?.value === 'all'
        && input?.getAttribute?.('data-asset-category-presence') === 'all');
    if (allInput) allInput.checked = true;
  }

  selectedOption = options.find((option) => getProjectAssetCategoryFilterInput(option)?.checked);
  selectedInput = getProjectAssetCategoryFilterInput(selectedOption);
  const selectedLabel = selectedOption?.querySelector?.('label')?.textContent?.trim()
    || 'All categories';
  effectivePresence = effectivePresence || selectedPresence;
  const summaryText = selectedInput?.value === 'all' && effectivePresence === 'missing'
    ? missingLabel
    : selectedLabel;
  const summary = filter.querySelector?.('[data-asset-category-filter-summary]');
  const trigger = filter.querySelector?.('summary');
  const currentSummary = filter.querySelector?.('[data-asset-category-filter-current-summary]') || summary;
  if (currentSummary) currentSummary.textContent = summaryText;
  trigger?.setAttribute?.('aria-label', `Category filter: ${summaryText}`);
  trigger?.setAttribute?.('title', summaryText);
}

export function enhanceProjectAssetCategoryFilter(scope = globalThis.document) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;

  const filters = scope.querySelectorAll(PROJECT_ASSET_CATEGORY_FILTER_SELECTOR);
  filters.forEach((filter) => {
    const options = Array.from(filter.querySelectorAll?.('.asset-filter-multiselect-option') || [])
      .filter((option) => getProjectAssetCategoryFilterInput(option));
    const form = filter.closest?.('form');
    const presenceControl = typeof form?.querySelectorAll === 'function'
      ? [
        ...Array.from(form.querySelectorAll('select[name="presence"]')),
        ...Array.from(form.querySelectorAll('input[name="presence"]')),
      ]
      : [form?.querySelector?.('select[name="presence"]') || form?.querySelector?.('input[name="presence"]')]
        .filter(Boolean);

    if (!isEnhancementBound(filter, 'projectAssetCategoryFilterBound')) {
      markEnhancementBound(filter, 'projectAssetCategoryFilterBound');
      options.forEach((option) => {
        getProjectAssetCategoryFilterInput(option)?.addEventListener?.('change', () => {
          updateProjectAssetCategoryFilter(filter, options, presenceControl, true);
        });
      });
      presenceControl.forEach((control) => control.addEventListener?.('change', () => {
        updateProjectAssetCategoryFilter(filter, options, presenceControl);
      }));
    }

    updateProjectAssetCategoryFilter(filter, options, presenceControl);
  });

  return filters.length;
}

let activeGridInfoPlacement = null;
let gridInfoViewportListenersBound = false;

function positionGridInfo(preview, info, config) {
  if (!preview || !info || typeof preview.getBoundingClientRect !== 'function') return;

  const viewportWidth = Number(globalThis.document?.documentElement?.clientWidth)
    || Number(globalThis.innerWidth);
  const viewportHeight = Number(globalThis.document?.documentElement?.clientHeight)
    || Number(globalThis.innerHeight);
  if (!(viewportWidth > 0) || !(viewportHeight > 0)) return;

  const previewRect = preview.getBoundingClientRect();
  const infoRect = typeof info.getBoundingClientRect === 'function'
    ? info.getBoundingClientRect()
    : { width: 0, height: 0 };
  const infoWidth = Math.min(
    Math.max(Number(info.offsetWidth) || Number(infoRect.width) || 0, 0),
    viewportWidth - (config.gutter * 2),
  );
  const infoHeight = Math.max(Number(info.offsetHeight) || Number(infoRect.height) || 0, 0);
  if (!(infoWidth > 0) || !(infoHeight > 0)) return;

  const unclampedLeft = previewRect.left + ((previewRect.width - infoWidth) / 2);
  const left = Math.max(
    config.gutter,
    Math.min(unclampedLeft, viewportWidth - config.gutter - infoWidth),
  );

  const belowTop = previewRect.bottom + config.gutter;
  const aboveTop = previewRect.top - config.gutter - infoHeight;
  let top = belowTop;
  if (belowTop + infoHeight > viewportHeight - config.gutter && aboveTop >= config.gutter) {
    top = aboveTop;
  } else if (belowTop + infoHeight > viewportHeight - config.gutter) {
    top = Math.max(config.gutter, viewportHeight - config.gutter - infoHeight);
  }

  info.style?.setProperty?.(config.leftProperty, `${left - previewRect.left}px`);
  info.style?.setProperty?.(config.topProperty, `${top - previewRect.top}px`);
  info.setAttribute?.('data-positioned', 'true');
}

function repositionActiveGridInfo() {
  if (!activeGridInfoPlacement) return;
  positionGridInfo(
    activeGridInfoPlacement.preview,
    activeGridInfoPlacement.info,
    activeGridInfoPlacement.config,
  );
}

function bindGridInfoViewportListeners() {
  if (gridInfoViewportListenersBound || typeof globalThis.addEventListener !== 'function') return;
  gridInfoViewportListenersBound = true;
  globalThis.addEventListener('resize', repositionActiveGridInfo);
  globalThis.addEventListener('scroll', repositionActiveGridInfo, true);
}

function enhanceGridInfoCards(scope, config) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;

  const previews = scope.querySelectorAll(config.previewSelector);
  let boundCount = 0;
  previews.forEach((preview) => {
    const info = preview.querySelector?.(config.infoSelector);
    if (!info || isEnhancementBound(preview, config.boundKey)) return;

    markEnhancementBound(preview, config.boundKey);
    boundCount += 1;
    const activate = () => {
      activeGridInfoPlacement = { preview, info, config };
      positionGridInfo(preview, info, config);
    };
    const deactivate = () => {
      if (activeGridInfoPlacement?.preview === preview) {
        activeGridInfoPlacement = null;
      }
    };

    preview.addEventListener?.('pointerenter', activate);
    preview.addEventListener?.('focusin', activate);
    preview.addEventListener?.('pointerleave', deactivate);
    preview.addEventListener?.('focusout', (event) => {
      if (!preview.contains?.(event.relatedTarget)) deactivate();
    });
  });

  if (boundCount > 0) bindGridInfoViewportListeners();
  return boundCount;
}

export function enhanceAssetViewerInfoCards(scope = globalThis.document) {
  return enhanceGridInfoCards(scope, ASSET_VIEWER_INFO_CONFIG);
}

export function enhanceProjectInfoCards(scope = globalThis.document) {
  return enhanceGridInfoCards(scope, PROJECT_INFO_CONFIG);
}

const DATE_PICKER_FIELD_SELECTOR = '[data-date-picker-field]';
const DATE_PICKER_INPUT_SELECTOR = '[data-date-picker-input]';
const DATE_PICKER_TRIGGER_SELECTOR = '.date-picker-trigger';
const DATE_PICKER_PANEL_SELECTOR = '[data-date-picker-panel]';
const DATE_PICKER_BOUND_KEY = 'datePickerBound';
const TIME_PICKER_FIELD_SELECTOR = '[data-time-picker-field]';
const TIME_PICKER_INPUT_SELECTOR = '[data-time-picker-input]';
const TIME_PICKER_TRIGGER_SELECTOR = '[data-time-picker-trigger]';
const TIME_PICKER_PANEL_SELECTOR = '[data-time-picker-panel]';
const TIME_PICKER_BOUND_KEY = 'timePickerBound';

const WEEKDAY_SHORT_NAMES = Object.freeze(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
const MONTH_NAMES = Object.freeze([
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]);

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year, month) {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function padTwo(value) {
  return String(value).padStart(2, '0');
}

function formatIsoDate(year, month, day) {
  return `${year}-${padTwo(month)}-${padTwo(day)}`;
}

function parseIsoDate(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(-?\d{4,})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

function parseTimeValue(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function formatTimeValue(hour, minute) {
  return `${padTwo(hour)}:${padTwo(minute)}`;
}

function localToday() {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}

function firstWeekdayOffset(year, month) {
  // Monday-start (0 = Monday, 6 = Sunday) to align with WEEKDAY_SHORT_NAMES.
  return (new Date(year, month - 1, 1).getDay() + 6) % 7;
}

function previousMonth(year, month) {
  if (month === 1) {
    if (year - 1 < 1000) return null;
    return { year: year - 1, month: 12 };
  }
  return { year, month: month - 1 };
}

function nextMonth(year, month) {
  if (month === 12) {
    if (year + 1 > 9999) return null;
    return { year: year + 1, month: 1 };
  }
  return { year, month: month + 1 };
}

function findDatePickerParts(field) {
  const input = field.querySelector(DATE_PICKER_INPUT_SELECTOR);
  const panel = field.querySelector(DATE_PICKER_PANEL_SELECTOR);
  const trigger = field.querySelector(DATE_PICKER_TRIGGER_SELECTOR)
    || (panel && field.querySelector(`button[aria-controls="${panel.id}"]`));
  return { input, trigger, panel };
}

function datePickerState(field) {
  return {
    field,
    ...findDatePickerParts(field),
    open: false,
    viewYear: null,
    viewMonth: null,
  };
}

function renderDatePickerHeader(state) {
  const { viewYear, viewMonth } = state;
  const header = document.createElement('div');
  header.className = 'date-picker-header';

  const prev = previousMonth(viewYear, viewMonth);
  const next = nextMonth(viewYear, viewMonth);

  const prevButton = document.createElement('button');
  prevButton.type = 'button';
  prevButton.className = 'date-picker-nav date-picker-prev';
  prevButton.setAttribute('aria-label', 'Previous month');
  prevButton.textContent = '←';
  prevButton.disabled = prev === null;
  prevButton.addEventListener('click', () => {
    if (prev) {
      state.viewYear = prev.year;
      state.viewMonth = prev.month;
      renderDatePicker(state);
    }
  });

  const title = document.createElement('span');
  title.className = 'date-picker-month-title';
  title.setAttribute('aria-live', 'polite');
  title.textContent = `${MONTH_NAMES[viewMonth - 1]} ${viewYear}`;

  const nextButton = document.createElement('button');
  nextButton.type = 'button';
  nextButton.className = 'date-picker-nav date-picker-next';
  nextButton.setAttribute('aria-label', 'Next month');
  nextButton.textContent = '→';
  nextButton.disabled = next === null;
  nextButton.addEventListener('click', () => {
    if (next) {
      state.viewYear = next.year;
      state.viewMonth = next.month;
      renderDatePicker(state);
    }
  });

  header.appendChild(prevButton);
  header.appendChild(title);
  header.appendChild(nextButton);
  return header;
}

function renderDatePickerGrid(state) {
  const { input, viewYear, viewMonth } = state;
  const selected = parseIsoDate(input?.value || '');
  const today = localToday();
  const firstDay = firstWeekdayOffset(viewYear, viewMonth);
  const days = daysInMonth(viewYear, viewMonth);
  const prev = previousMonth(viewYear, viewMonth);
  const prevDays = prev ? daysInMonth(prev.year, prev.month) : 31;
  const totalCells = Math.ceil((firstDay + days) / 7) * 7;

  const grid = document.createElement('div');
  grid.className = 'date-picker-grid';
  grid.setAttribute('aria-label', `${MONTH_NAMES[viewMonth - 1]} ${viewYear}`);

  const headerRow = document.createElement('div');
  headerRow.className = 'date-picker-weekdays';
  for (const name of WEEKDAY_SHORT_NAMES) {
    const cell = document.createElement('div');
    cell.className = 'date-picker-weekday';
    cell.textContent = name;
    headerRow.appendChild(cell);
  }
  grid.appendChild(headerRow);

  const cellsRow = document.createElement('div');
  cellsRow.className = 'date-picker-days';

  for (let i = 0; i < totalCells; i++) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'date-picker-day picker-option';

    if (i < firstDay) {
      const day = prevDays - firstDay + 1 + i;
      cell.classList.add('is-out-of-month');
      cell.textContent = String(day);
      cell.disabled = true;
      cell.setAttribute(
        'aria-label',
        prev
          ? `${day} ${MONTH_NAMES[prev.month - 1]} ${prev.year}`
          : `${day} from previous month (unavailable)`,
      );
      cell.setAttribute('aria-disabled', 'true');
    } else if (i < firstDay + days) {
      const day = i - firstDay + 1;
      const iso = formatIsoDate(viewYear, viewMonth, day);
      cell.textContent = String(day);
      cell.setAttribute('aria-label', iso);
      cell.setAttribute('data-date', iso);

      const isToday = today.year === viewYear && today.month === viewMonth && today.day === day;
      const isSelected = selected && selected.year === viewYear && selected.month === viewMonth && selected.day === day;
      cell.classList.toggle('is-today', isToday);
      cell.classList.toggle('is-selected', isSelected);
      if (isToday) cell.setAttribute('aria-current', 'date');
      if (isSelected) cell.setAttribute('aria-selected', 'true');

      cell.addEventListener('click', () => {
        if (input) {
          input.value = iso;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        closeDatePicker(state, true);
      });
    } else {
      const day = i - firstDay - days + 1;
      const next = nextMonth(viewYear, viewMonth);
      cell.classList.add('is-out-of-month');
      cell.textContent = String(day);
      cell.disabled = true;
      cell.setAttribute('aria-label', `${day} ${MONTH_NAMES[(next?.month ?? 1) - 1]} ${next?.year ?? viewYear}`);
      cell.setAttribute('aria-disabled', 'true');
    }

    cellsRow.appendChild(cell);
  }
  grid.appendChild(cellsRow);
  return grid;
}

function renderDatePickerFooter(state) {
  const { input, trigger } = state;
  const footer = document.createElement('div');
  footer.className = 'date-picker-footer';

  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'date-picker-clear';
  clear.textContent = 'Clear';
  clear.setAttribute('aria-label', 'Clear selected date');
  clear.addEventListener('click', () => {
    if (input) {
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    closeDatePicker(state, true);
  });

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'date-picker-close';
  close.textContent = 'Close';
  close.setAttribute('aria-label', 'Close calendar');
  close.addEventListener('click', () => closeDatePicker(state, true));

  footer.appendChild(clear);
  footer.appendChild(close);
  return footer;
}

function renderDatePicker(state) {
  if (!state.panel) return;
  while (state.panel.firstChild) {
    state.panel.removeChild(state.panel.firstChild);
  }
  state.panel.appendChild(renderDatePickerHeader(state));
  state.panel.appendChild(renderDatePickerGrid(state));
  state.panel.appendChild(renderDatePickerFooter(state));
}

function findTimePickerParts(field) {
  const input = field.querySelector(TIME_PICKER_INPUT_SELECTOR);
  const panel = field.querySelector(TIME_PICKER_PANEL_SELECTOR);
  const trigger = field.querySelector(TIME_PICKER_TRIGGER_SELECTOR)
    || (panel && field.querySelector(`button[aria-controls="${panel.id}"]`));
  return { input, trigger, panel };
}

function timePickerState(field) {
  return {
    field,
    ...findTimePickerParts(field),
    open: false,
  };
}

function setTimePickerValue(state, hour, minute) {
  if (!state.input) return;
  state.input.value = formatTimeValue(hour, minute);
  state.input.dispatchEvent(new Event('input', { bubbles: true }));
  state.input.dispatchEvent(new Event('change', { bubbles: true }));
}

function renderTimePickerColumn(state, type, values, selectedValue) {
  const column = document.createElement('div');
  column.className = 'time-picker-column';
  column.setAttribute('aria-label', type === 'hour' ? 'Hours' : 'Minutes');

  const label = document.createElement('span');
  label.className = 'time-picker-column-label';
  label.textContent = type === 'hour' ? 'Hour' : 'Minute';
  column.appendChild(label);

  const options = document.createElement('div');
  options.className = 'time-picker-options';

  for (const value of values) {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'time-picker-option picker-option';
    option.textContent = padTwo(value);
    option.setAttribute(`data-time-${type}`, String(value));
    option.setAttribute('aria-label', `${type === 'hour' ? 'Hour' : 'Minute'} ${padTwo(value)}`);
    option.setAttribute('aria-pressed', String(value === selectedValue));
    option.classList.toggle('is-selected', value === selectedValue);
    option.addEventListener('click', () => {
      const current = parseTimeValue(state.input?.value || '') || { hour: 0, minute: 0 };
      const next = type === 'hour'
        ? { hour: value, minute: current.minute }
        : { hour: current.hour, minute: value };
      setTimePickerValue(state, next.hour, next.minute);
      renderTimePicker(state);
      const selected = Array.from(state.panel?.querySelectorAll('.time-picker-option') || [])
        .find((candidate) => candidate.getAttribute(`data-time-${type}`) === String(value)
          && candidate.getAttribute('aria-pressed') === 'true');
      selected?.focus?.();
    });
    options.appendChild(option);
  }

  column.appendChild(options);

  return column;
}

function renderTimePickerFooter(state) {
  const footer = document.createElement('div');
  footer.className = 'date-picker-footer';

  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'date-picker-clear';
  clear.textContent = 'Clear';
  clear.setAttribute('aria-label', 'Clear selected time');
  clear.addEventListener('click', () => {
    if (state.input) {
      state.input.value = '';
      state.input.dispatchEvent(new Event('input', { bubbles: true }));
      state.input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    closeTimePicker(state, true);
  });

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'date-picker-close';
  close.textContent = 'Close';
  close.setAttribute('aria-label', 'Close time picker');
  close.addEventListener('click', () => closeTimePicker(state, true));

  footer.appendChild(clear);
  footer.appendChild(close);
  return footer;
}

function renderTimePicker(state) {
  if (!state.panel) return;
  while (state.panel.firstChild) {
    state.panel.removeChild(state.panel.firstChild);
  }

  const current = parseTimeValue(state.input?.value || '') || { hour: 0, minute: 0 };
  const header = document.createElement('div');
  header.className = 'date-picker-header';
  const title = document.createElement('span');
  title.className = 'date-picker-month-title';
  title.setAttribute('aria-live', 'polite');
  title.textContent = 'Select time';
  header.appendChild(title);

  const grid = document.createElement('div');
  grid.className = 'time-picker-grid';
  grid.appendChild(renderTimePickerColumn(state, 'hour', Array.from({ length: 24 }, (_, hour) => hour), current.hour));
  grid.appendChild(renderTimePickerColumn(state, 'minute', Array.from({ length: 60 }, (_, minute) => minute), current.minute));

  state.panel.appendChild(header);
  state.panel.appendChild(grid);
  state.panel.appendChild(renderTimePickerFooter(state));
}

function setViewFromValue(state) {
  const parsed = parseIsoDate(state.input?.value || '');
  if (parsed) {
    state.viewYear = parsed.year;
    state.viewMonth = parsed.month;
  } else {
    const today = localToday();
    state.viewYear = today.year;
    state.viewMonth = today.month;
  }
}

function closeDatePicker(state, restoreFocus = false) {
  if (!state.open) return;
  state.open = false;
  if (state.panel) {
    state.panel.hidden = true;
    state.panel.removeAttribute('open');
  }
  if (state.trigger) {
    state.trigger.setAttribute('aria-expanded', 'false');
  }
  if (restoreFocus) state.trigger?.focus?.();
}

function openDatePicker(state, allStates) {
  if (state.open) return;
  for (const other of allStates) {
    if (other !== state) closeDatePicker(other);
  }
  setViewFromValue(state);
  renderDatePicker(state);
  state.open = true;
  if (state.panel) {
    state.panel.hidden = false;
    state.panel.setAttribute('open', '');
  }
  if (state.trigger) {
    state.trigger.setAttribute('aria-expanded', 'true');
  }
  // Focus the selected day if present, otherwise the first focusable day.
  const selected = state.panel?.querySelector('.date-picker-day.is-selected');
  const firstDay = state.panel?.querySelector('.date-picker-day:not([disabled])');
  (selected || firstDay)?.focus?.();
}

function bindDatePickerState(state, allStates) {
  if (!state.trigger || !state.panel || !state.input) return;

  state.trigger.addEventListener('click', (event) => {
    event.preventDefault?.();
    if (state.open) {
      closeDatePicker(state, true);
    } else {
      openDatePicker(state, allStates);
    }
  });

  state.panel.addEventListener('click', (event) => event.stopPropagation());

  state.panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault?.();
      event.stopPropagation?.();
      closeDatePicker(state, true);
    }
  });
}

function getDatePickerFields(scope) {
  return Array.from(scope?.querySelectorAll?.(DATE_PICKER_FIELD_SELECTOR) || []);
}

export function enhanceDatePickers(scope = globalThis.document) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;

  const fields = getDatePickerFields(scope);
  if (fields.length === 0) return 0;

  const states = fields.map(datePickerState);

  // Bind per-field interactions once.
  states.forEach((state) => {
    if (isEnhancementBound(state.field, DATE_PICKER_BOUND_KEY)) return;
    markEnhancementBound(state.field, DATE_PICKER_BOUND_KEY);
    bindDatePickerState(state, states);
  });

  // Bind singleton document-level dismissal only once per scope.
  if (!isEnhancementBound(scope, 'datePickerDocumentBound')) {
    markEnhancementBound(scope, 'datePickerDocumentBound');

    document.addEventListener?.('click', (event) => {
      const target = event.target;
      const active = states.find((state) => state.open);
      if (!active) return;
      if (target && (active.field.contains(target) || active.panel.contains(target))) return;
      closeDatePicker(active);
    });

    document.addEventListener?.('keydown', (event) => {
      if (event.key !== 'Escape') return;
      const active = states.find((state) => state.open);
      if (!active) return;
      // If focus is inside the active panel, the panel handler will close and
      // refocus the trigger. Only handle Escape when focus is outside the panel
      // to avoid double-preventDefault and inconsistent focus behavior.
      if (active.panel.contains(document.activeElement)) return;
      event.preventDefault?.();
      closeDatePicker(active, true);
    });
  }

  return fields.length;
}

function closeTimePicker(state, restoreFocus = false) {
  if (!state.open) return;
  state.open = false;
  if (state.panel) {
    state.panel.hidden = true;
    state.panel.removeAttribute('open');
  }
  if (state.trigger) {
    state.trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) state.trigger.focus?.();
  }
}

function openTimePicker(state, allStates) {
  if (state.open) return;
  for (const other of allStates) {
    if (other !== state) closeTimePicker(other);
  }
  renderTimePicker(state);
  state.open = true;
  if (state.panel) {
    state.panel.hidden = false;
    state.panel.setAttribute('open', '');
  }
  if (state.trigger) {
    state.trigger.setAttribute('aria-expanded', 'true');
  }
  const selectedOptions = Array.from(state.panel?.querySelectorAll('.time-picker-option.is-selected') || []);
  selectedOptions.forEach((option) => option.scrollIntoView?.({ block: 'center' }));
  selectedOptions[0]?.focus?.();
}

function bindTimePickerState(state, allStates) {
  if (!state.trigger || !state.panel || !state.input) return;

  const open = (event) => {
    event?.preventDefault?.();
    if (!state.open) openTimePicker(state, allStates);
  };

  state.trigger.addEventListener('click', (event) => {
    event.preventDefault?.();
    if (state.open) closeTimePicker(state, true);
    else openTimePicker(state, allStates);
  });
  state.input.addEventListener('click', open);
  state.panel.addEventListener('click', (event) => event.stopPropagation());
  state.panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault?.();
      event.stopPropagation?.();
      closeTimePicker(state, true);
    }
  });
}

export function enhanceTimePickers(scope = globalThis.document) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;

  const fields = Array.from(scope.querySelectorAll(TIME_PICKER_FIELD_SELECTOR) || []);
  if (fields.length === 0) return 0;

  const states = fields.map(timePickerState);
  states.forEach((state) => {
    if (isEnhancementBound(state.field, TIME_PICKER_BOUND_KEY)) return;
    markEnhancementBound(state.field, TIME_PICKER_BOUND_KEY);
    bindTimePickerState(state, states);
  });

  if (!isEnhancementBound(scope, 'timePickerDocumentBound')) {
    markEnhancementBound(scope, 'timePickerDocumentBound');

    document.addEventListener?.('click', (event) => {
      const target = event.target;
      const active = states.find((state) => state.open);
      if (!active) return;
      if (target && (active.field.contains(target) || active.panel.contains(target))) return;
      closeTimePicker(active);
    });

    document.addEventListener?.('keydown', (event) => {
      if (event.key !== 'Escape') return;
      const active = states.find((state) => state.open);
      if (!active) return;
      if (active.panel.contains(document.activeElement)) return;
      event.preventDefault?.();
      closeTimePicker(active, true);
    });
  }

  return fields.length;
}

// ─── Slideshow enhancer ───────────────────────────────────────────────────────

const SLIDESHOW_TRIGGER_SELECTOR = '[data-slideshow-trigger]';
const SLIDESHOW_SCAFFOLD_SELECTOR = '[data-slideshow-scaffold]';
const SLIDESHOW_SEQUENCE_SELECTOR = '[data-slideshow-sequence]';
const SLIDESHOW_PREVIEW_SELECTOR = '[data-slideshow-preview]';
const SLIDESHOW_PREV_SELECTOR = '[data-slideshow-prev]';
const SLIDESHOW_NEXT_SELECTOR = '[data-slideshow-next]';
const SLIDESHOW_STATUS_SELECTOR = '[data-slideshow-status]';
const SLIDESHOW_PLAY_PAUSE_SELECTOR = '[data-slideshow-play-pause]';
const SLIDESHOW_SPEED_SELECTOR = '[data-slideshow-speed]';
const SLIDESHOW_FULLSCREEN_SELECTOR = '[data-slideshow-fullscreen]';
const SLIDESHOW_CLOSE_SELECTOR = '[data-slideshow-close]';
const SLIDESHOW_ORIGINAL_SIZE_SELECTOR = '[data-slideshow-original-size]';
const SLIDESHOW_MEDIA_STATUS_SELECTOR = '[data-slideshow-media-status]';
const SLIDESHOW_CHROME_HIDE_DELAY = 2500;

function parseSlideshowSequence(scaffold) {
  try {
    const el = scaffold?.querySelector?.(SLIDESHOW_SEQUENCE_SELECTOR);
    if (!el) return [];
    const parsed = JSON.parse(el.textContent || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function enhanceSlideshow(scope = globalThis.document) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;

  let trigger = scope.querySelector?.(SLIDESHOW_TRIGGER_SELECTOR);
  const scaffold = scope.querySelector?.(SLIDESHOW_SCAFFOLD_SELECTOR);
  if (!trigger || !scaffold) return 0;

  const existingState = scaffold.__creatorCrateSlideshowState;
  if (existingState) {
    existingState.bindTrigger?.(trigger);
    return existingState.refreshSequence?.(parseSlideshowSequence(scaffold)) ?? 1;
  }

  if (isEnhancementBound(trigger, 'slideshowBound')) return 1;
  markEnhancementBound(trigger, 'slideshowBound');

  const playPauseBtn = scaffold.querySelector?.(SLIDESHOW_PLAY_PAUSE_SELECTOR);
  const speedSelect = scaffold.querySelector?.(SLIDESHOW_SPEED_SELECTOR);
  const fullscreenBtn = scaffold.querySelector?.(SLIDESHOW_FULLSCREEN_SELECTOR);
  const originalSizeBtn = scaffold.querySelector?.(SLIDESHOW_ORIGINAL_SIZE_SELECTOR);
  const fullscreenDocument = scaffold.ownerDocument || scope;
  const fullscreenApiAvailable = Boolean(
    fullscreenBtn
    && typeof scaffold.requestFullscreen === 'function'
    && fullscreenDocument
    && typeof fullscreenDocument.exitFullscreen === 'function'
    && 'fullscreenElement' in fullscreenDocument
    && typeof fullscreenDocument.addEventListener === 'function'
  );

  let sequence = parseSlideshowSequence(scaffold);

  let currentIndex = 0;
  let isOpen = false;
  let timerId = null;
  let chromeHideTimerId = null;
  let isPlaying = false;
  let isOriginalMode = false;
  let originalImage = null;
  let originalRequestToken = 0;
  let pendingOriginalLoadHandler = null;
  let pendingOriginalErrorHandler = null;
  let panX = 0;
  let panY = 0;
  let maxPanX = 0;
  let maxPanY = 0;
  let dragPointerId = null;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragStartPanX = 0;
  let dragStartPanY = 0;
  let recomputeOriginalPanBounds = null;

  function isFullscreenActive() {
    return fullscreenApiAvailable && fullscreenDocument.fullscreenElement === scaffold;
  }

  function clearChromeHideTimer() {
    if (chromeHideTimerId !== null) {
      clearTimeout(chromeHideTimerId);
      chromeHideTimerId = null;
    }
  }

  function setChromeHidden(hidden) {
    if (hidden) {
      scaffold.setAttribute?.('data-slideshow-ui-hidden', '');
    } else {
      scaffold.removeAttribute?.('data-slideshow-ui-hidden');
    }
  }

  function hideSlideshowChrome() {
    chromeHideTimerId = null;
    setChromeHidden(isOpen && isFullscreenActive());
  }

  function scheduleChromeHide() {
    clearChromeHideTimer();
    if (!isOpen || !isFullscreenActive()) return;
    chromeHideTimerId = setTimeout(hideSlideshowChrome, SLIDESHOW_CHROME_HIDE_DELAY);
  }

  function showSlideshowChrome() {
    setChromeHidden(false);
    scheduleChromeHide();
  }

  function setFullscreenState(active) {
    if (!fullscreenBtn) return;
    const label = active ? 'Exit fullscreen' : 'Enter fullscreen';
    fullscreenBtn.setAttribute?.('aria-label', label);
    fullscreenBtn.setAttribute?.('aria-pressed', active ? 'true' : 'false');
    fullscreenBtn.setAttribute?.('title', label);
    if (active) {
      fullscreenBtn.setAttribute?.('data-slideshow-fullscreen-active', '');
    } else {
      fullscreenBtn.removeAttribute?.('data-slideshow-fullscreen-active');
    }
  }

  function syncFullscreenState() {
    const active = isFullscreenActive();
    setFullscreenState(active && isOpen);
    if (active && isOpen) {
      showSlideshowChrome();
      recomputeOriginalPanBounds?.();
    } else {
      clearChromeHideTimer();
      setChromeHidden(false);
    }
  }

  function requestSlideshowFullscreen() {
    try {
      const pending = scaffold.requestFullscreen();
      if (pending && typeof pending.catch === 'function') {
        pending.catch(() => {
          syncFullscreenState();
        });
      }
    } catch {
      syncFullscreenState();
    }
    syncFullscreenState();
  }

  function exitSlideshowFullscreen() {
    try {
      const pending = fullscreenDocument.exitFullscreen();
      if (pending && typeof pending.catch === 'function') {
        pending.catch(() => {
          syncFullscreenState();
        });
      }
    } catch {
      syncFullscreenState();
    }
    syncFullscreenState();
  }

  function toggleFullscreen() {
    if (!fullscreenApiAvailable || !isOpen) return;
    if (isFullscreenActive()) exitSlideshowFullscreen();
    else requestSlideshowFullscreen();
  }

  if (fullscreenBtn) {
    if (!fullscreenApiAvailable) {
      fullscreenBtn.disabled = true;
      fullscreenBtn.setAttribute?.('hidden', '');
    } else {
      fullscreenBtn.removeAttribute?.('hidden');
      fullscreenBtn.disabled = sequence.length === 0;
      fullscreenDocument.addEventListener('fullscreenchange', syncFullscreenState);
      syncFullscreenState();
    }
  }

  trigger.disabled = sequence.length === 0;
  if (playPauseBtn) playPauseBtn.disabled = sequence.length === 0;
  if (speedSelect) speedSelect.disabled = sequence.length === 0;
  if (fullscreenBtn && fullscreenApiAvailable) fullscreenBtn.disabled = sequence.length === 0;

  const preview = scaffold.querySelector?.(SLIDESHOW_PREVIEW_SELECTOR);
  const status = scaffold.querySelector?.(SLIDESHOW_STATUS_SELECTOR);
  const mediaStatus = scaffold.querySelector?.(SLIDESHOW_MEDIA_STATUS_SELECTOR);
  const prevBtn = scaffold.querySelector?.(SLIDESHOW_PREV_SELECTOR);
  const nextBtn = scaffold.querySelector?.(SLIDESHOW_NEXT_SELECTOR);
  const closeBtn = scaffold.querySelector?.(SLIDESHOW_CLOSE_SELECTOR);

  const img = scope.createElement?.('img');
  const captionEl = scope.createElement?.('p');
  if (img) {
    img.setAttribute?.('class', 'slideshow-img slideshow-preview-img');
    img.draggable = false;
    preview?.appendChild?.(img);
  }
  if (captionEl) {
    captionEl.setAttribute?.('class', 'slideshow-caption');
    preview?.appendChild?.(captionEl);
  }

  function getSpeed() {
    return parseInt(speedSelect?.value || '', 10) || 4000;
  }

  function setMediaStatus(message) {
    if (!mediaStatus) return;
    if (message) {
      mediaStatus.textContent = message;
      mediaStatus.removeAttribute?.('hidden');
      mediaStatus.hidden = false;
    } else {
      mediaStatus.textContent = '';
      mediaStatus.setAttribute?.('hidden', '');
      mediaStatus.hidden = true;
    }
  }

  function setOriginalSizeControl(active) {
    if (!originalSizeBtn) return;
    const available = Boolean(sequence[currentIndex]?.originalUrl);
    const label = active
      ? 'Fit to screen'
      : available
        ? 'View original size'
        : 'Original size unavailable';
    originalSizeBtn.disabled = !available && !active;
    originalSizeBtn.setAttribute?.('aria-label', label);
    originalSizeBtn.setAttribute?.('title', label);
    originalSizeBtn.setAttribute?.('aria-pressed', active ? 'true' : 'false');
    if (active) {
      originalSizeBtn.setAttribute?.('data-slideshow-original-size-active', '');
    } else {
      originalSizeBtn.removeAttribute?.('data-slideshow-original-size-active');
    }
  }

  function renderItem(index) {
    const item = sequence[index];
    if (!item) return;
    currentIndex = index;
    if (img) {
      img.src = item.previewUrl;
      img.setAttribute?.('alt', item.filename);
    }
    if (captionEl) captionEl.textContent = item.filename;
    if (status) status.textContent = `${index + 1} of ${sequence.length}`;
    setOriginalSizeControl(false);
    setMediaStatus('');
  }

  function clearAutoplay() {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
  }

  function setPlayPauseState(playing) {
    isPlaying = playing;
    if (playPauseBtn) {
      playPauseBtn.setAttribute?.('aria-label', playing ? 'Pause' : 'Play');
      if (playing) {
        playPauseBtn.setAttribute?.('data-slideshow-playing', '');
      } else {
        playPauseBtn.removeAttribute?.('data-slideshow-playing');
      }
    }
  }

  function scheduleNext() {
    clearAutoplay();
    timerId = setTimeout(() => {
      timerId = null;
      renderItem(currentIndex === sequence.length - 1 ? 0 : currentIndex + 1);
      if (isPlaying) scheduleNext();
    }, getSpeed());
  }

  function startAutoplay() {
    if (isOriginalMode) return;
    setPlayPauseState(true);
    if (sequence.length > 1) scheduleNext();
  }

  function stopAutoplay() {
    clearAutoplay();
    setPlayPauseState(false);
  }

  function clearOriginalLoadListeners() {
    if (!originalImage) return;
    if (pendingOriginalLoadHandler) {
      originalImage.removeEventListener?.('load', pendingOriginalLoadHandler);
      pendingOriginalLoadHandler = null;
    }
    if (pendingOriginalErrorHandler) {
      originalImage.removeEventListener?.('error', pendingOriginalErrorHandler);
      pendingOriginalErrorHandler = null;
    }
  }

  function releasePanPointer() {
    if (dragPointerId !== null && typeof preview?.releasePointerCapture === 'function') {
      try {
        preview.releasePointerCapture(dragPointerId);
      } catch {
        // Pointer capture may already have been released by the browser.
      }
    }
    dragPointerId = null;
    preview?.removeAttribute?.('data-slideshow-dragging');
  }

  function updateOriginalImageTransform() {
    if (!originalImage?.style) return;
    originalImage.style.transform = `translate(calc(-50% + ${panX}px), calc(-50% + ${panY}px))`;
  }

  function setPanEnabled(enabled) {
    if (!preview) return;
    if (enabled) preview.setAttribute?.('data-slideshow-pan-enabled', '');
    else preview.removeAttribute?.('data-slideshow-pan-enabled');
  }

  function getViewportSize() {
    const rect = preview?.getBoundingClientRect?.();
    const documentElement = fullscreenDocument?.documentElement;
    const view = fullscreenDocument?.defaultView;
    const firstPositive = (...values) => {
      for (const value of values) {
        const number = Number(value);
        if (Number.isFinite(number) && number > 0) return number;
      }
      return 0;
    };
    return {
      width: firstPositive(
        preview?.clientWidth,
        rect?.width,
        scaffold?.clientWidth,
        documentElement?.clientWidth,
        view?.innerWidth,
      ),
      height: firstPositive(
        preview?.clientHeight,
        rect?.height,
        scaffold?.clientHeight,
        documentElement?.clientHeight,
        view?.innerHeight,
      ),
    };
  }

  function clampPan(value, limit) {
    return Math.max(-limit, Math.min(limit, value));
  }

  function resetPan() {
    releasePanPointer();
    panX = 0;
    panY = 0;
    maxPanX = 0;
    maxPanY = 0;
    updateOriginalImageTransform();
    setPanEnabled(false);
  }

  recomputeOriginalPanBounds = () => {
    const naturalWidth = Number(originalImage?.naturalWidth);
    const naturalHeight = Number(originalImage?.naturalHeight);
    if (!isOriginalMode || !originalImage || naturalWidth <= 0 || naturalHeight <= 0) {
      maxPanX = 0;
      maxPanY = 0;
      panX = 0;
      panY = 0;
      setPanEnabled(false);
      updateOriginalImageTransform();
      return;
    }

    const viewport = getViewportSize();
    maxPanX = viewport.width > 0 ? Math.max(0, (naturalWidth - viewport.width) / 2) : 0;
    maxPanY = viewport.height > 0 ? Math.max(0, (naturalHeight - viewport.height) / 2) : 0;
    panX = clampPan(panX, maxPanX);
    panY = clampPan(panY, maxPanY);
    setPanEnabled(maxPanX > 0 || maxPanY > 0);
    updateOriginalImageTransform();
  };

  setOriginalSizeControl(false);

  function createOriginalImage() {
    if (originalImage || !scope.createElement || !preview) return originalImage;
    originalImage = scope.createElement('img');
    originalImage.setAttribute?.('class', 'slideshow-img slideshow-original-img');
    originalImage.setAttribute?.('alt', '');
    originalImage.draggable = false;
    preview.appendChild?.(originalImage);
    return originalImage;
  }

  function clearOriginalImage() {
    originalRequestToken += 1;
    clearOriginalLoadListeners();
    preview?.removeAttribute?.('data-slideshow-original-loaded');
    if (!originalImage) return;
    originalImage.removeAttribute?.('src');
    originalImage.removeAttribute?.('data-slideshow-original-request');
    if (originalImage.style) {
      originalImage.style.width = '';
      originalImage.style.height = '';
      originalImage.style.transform = '';
    }
  }

  function leaveOriginalSize(message = '') {
    isOriginalMode = false;
    resetPan();
    clearOriginalImage();
    preview?.removeAttribute?.('data-slideshow-mode');
    preview?.removeAttribute?.('data-slideshow-pan-enabled');
    setOriginalSizeControl(false);
    setMediaStatus(message);
  }

  function setOriginalImageDimensions() {
    const width = Number(originalImage?.naturalWidth);
    const height = Number(originalImage?.naturalHeight);
    if (!originalImage || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return false;
    }
    if (originalImage.style) {
      originalImage.style.width = `${width}px`;
      originalImage.style.height = `${height}px`;
    }
    return true;
  }

  function handleOriginalLoad(requestToken) {
    if (!isOriginalMode || requestToken !== originalRequestToken) return;
    clearOriginalLoadListeners();
    if (!setOriginalImageDimensions()) {
      leaveOriginalSize('Original size unavailable; showing fit to screen.');
      return;
    }
    preview?.setAttribute?.('data-slideshow-original-loaded', '');
    recomputeOriginalPanBounds?.();
    setMediaStatus('');
  }

  function handleOriginalError(requestToken) {
    if (!isOriginalMode || requestToken !== originalRequestToken) return;
    leaveOriginalSize('Original size unavailable; showing fit to screen.');
  }

  function enterOriginalSize() {
    const item = sequence[currentIndex];
    if (!item?.originalUrl || !originalSizeBtn || originalSizeBtn.disabled) return;

    stopAutoplay();
    isOriginalMode = true;
    resetPan();
    preview?.setAttribute?.('data-slideshow-mode', 'original');
    preview?.removeAttribute?.('data-slideshow-original-loaded');
    setOriginalSizeControl(true);
    setMediaStatus('Loading original...');

    const image = createOriginalImage();
    if (!image) {
      leaveOriginalSize('Original size unavailable; showing fit to screen.');
      return;
    }

    clearOriginalLoadListeners();
    const requestToken = ++originalRequestToken;
    pendingOriginalLoadHandler = () => handleOriginalLoad(requestToken);
    pendingOriginalErrorHandler = () => handleOriginalError(requestToken);
    image.addEventListener?.('load', pendingOriginalLoadHandler);
    image.addEventListener?.('error', pendingOriginalErrorHandler);
    image.setAttribute?.('data-slideshow-original-request', String(requestToken));
    image.setAttribute?.('alt', item.filename);
    image.src = item.originalUrl;

    if (image.complete && Number(image.naturalWidth) > 0) {
      handleOriginalLoad(requestToken);
    }
  }

  function pointerCoordinate(event, key) {
    const value = Number(event?.[key]);
    return Number.isFinite(value) ? value : 0;
  }

  function beginPan(event) {
    if (!isOriginalMode || !preview?.hasAttribute?.('data-slideshow-original-loaded')) return;
    if (maxPanX <= 0 && maxPanY <= 0) return;
    if (event?.button !== undefined && event.button !== 0) return;

    dragPointerId = event?.pointerId ?? 0;
    dragStartX = pointerCoordinate(event, 'clientX');
    dragStartY = pointerCoordinate(event, 'clientY');
    dragStartPanX = panX;
    dragStartPanY = panY;
    preview.setAttribute?.('data-slideshow-dragging', '');
    if (typeof preview.setPointerCapture === 'function') {
      try {
        preview.setPointerCapture(dragPointerId);
      } catch {
        // Pointer capture is an enhancement; dragging still works while over the preview.
      }
    }
    event?.preventDefault?.();
  }

  function updatePan(event) {
    if (dragPointerId === null) return;
    if (event?.pointerId !== undefined && event.pointerId !== dragPointerId) return;
    panX = clampPan(dragStartPanX + pointerCoordinate(event, 'clientX') - dragStartX, maxPanX);
    panY = clampPan(dragStartPanY + pointerCoordinate(event, 'clientY') - dragStartY, maxPanY);
    updateOriginalImageTransform();
    event?.preventDefault?.();
  }

  function endPan(event) {
    if (dragPointerId === null) return;
    if (event?.pointerId !== undefined && event.pointerId !== dragPointerId) return;
    releasePanPointer();
  }

  function openSlideshow() {
    isOpen = true;
    leaveOriginalSize();
    showSlideshowChrome();
    scaffold.removeAttribute?.('hidden');
    scaffold.removeAttribute?.('inert');
    scaffold.hidden = false;
    trigger.setAttribute?.('aria-expanded', 'true');
    renderItem(0);
    closeBtn?.focus?.();
    const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
    if (!reducedMotion) startAutoplay();
    else setPlayPauseState(false);
  }

  function closeSlideshow() {
    stopAutoplay();
    leaveOriginalSize();
    const wasFullscreen = isFullscreenActive();
    isOpen = false;
    clearChromeHideTimer();
    setChromeHidden(false);
    if (wasFullscreen) exitSlideshowFullscreen();
    setFullscreenState(false);
    scaffold.setAttribute?.('hidden', '');
    scaffold.setAttribute?.('inert', '');
    scaffold.hidden = true;
    trigger.setAttribute?.('aria-expanded', 'false');
    trigger.focus?.();
  }

  function navigatePrev() {
    stopAutoplay();
    leaveOriginalSize();
    renderItem(currentIndex === 0 ? sequence.length - 1 : currentIndex - 1);
  }

  function navigateNext() {
    stopAutoplay();
    leaveOriginalSize();
    renderItem(currentIndex === sequence.length - 1 ? 0 : currentIndex + 1);
  }

  function getFocusableControls() {
    return [fullscreenBtn, closeBtn, prevBtn, playPauseBtn, speedSelect, nextBtn, originalSizeBtn].filter(
      (el) => el && !el.disabled
    );
  }

  function handleSlideshowActivity() {
    if (!isOpen) return;
    showSlideshowChrome();
  }

  let boundTrigger = null;
  const bindTrigger = (nextTrigger) => {
    if (!nextTrigger || nextTrigger === boundTrigger) return;
    boundTrigger?.removeEventListener?.('click', openSlideshow);
    boundTrigger = nextTrigger;
    trigger = nextTrigger;
    markEnhancementBound(boundTrigger, 'slideshowBound');
    boundTrigger.addEventListener?.('click', openSlideshow);
  };

  const refreshSequence = (nextSequence) => {
    sequence = Array.isArray(nextSequence) ? nextSequence : [];
    const available = sequence.length > 0;
    if (boundTrigger) boundTrigger.disabled = !available;
    if (playPauseBtn) playPauseBtn.disabled = !available;
    if (speedSelect) speedSelect.disabled = !available;
    if (fullscreenBtn && fullscreenApiAvailable) fullscreenBtn.disabled = !available;
    if (!available) {
      stopAutoplay();
      if (isOpen) closeSlideshow();
      if (originalSizeBtn) originalSizeBtn.disabled = true;
      return 0;
    }
    currentIndex = Math.min(currentIndex, sequence.length - 1);
    if (isOpen) renderItem(currentIndex);
    else setOriginalSizeControl(false);
    return 1;
  };

  bindTrigger(trigger);
  closeBtn?.addEventListener?.('click', closeSlideshow);
  prevBtn?.addEventListener?.('click', navigatePrev);
  nextBtn?.addEventListener?.('click', navigateNext);
  originalSizeBtn?.addEventListener?.('click', () => {
    if (isOriginalMode) leaveOriginalSize();
    else enterOriginalSize();
  });
  if (fullscreenApiAvailable) fullscreenBtn?.addEventListener?.('click', toggleFullscreen);

  scaffold.addEventListener?.('pointermove', handleSlideshowActivity);
  scaffold.addEventListener?.('pointerdown', handleSlideshowActivity);
  scaffold.addEventListener?.('pointerup', endPan);
  scaffold.addEventListener?.('pointercancel', endPan);
  scaffold.addEventListener?.('click', handleSlideshowActivity);
  scaffold.addEventListener?.('focusin', handleSlideshowActivity);
  preview?.addEventListener?.('pointerdown', beginPan);
  preview?.addEventListener?.('pointermove', updatePan);
  preview?.addEventListener?.('pointerup', endPan);
  preview?.addEventListener?.('pointercancel', endPan);

  const slideshowWindow = fullscreenDocument?.defaultView;
  slideshowWindow?.addEventListener?.('resize', () => {
    recomputeOriginalPanBounds?.();
  });

  playPauseBtn?.addEventListener?.('click', () => {
    if (isPlaying) stopAutoplay();
    else startAutoplay();
  });

  speedSelect?.addEventListener?.('change', () => {
    handleSlideshowActivity();
    if (isPlaying) {
      clearAutoplay();
      scheduleNext();
    }
  });

  scope.addEventListener?.('keydown', (event) => {
    if (!isOpen) return;
    handleSlideshowActivity();
    if (event.key === 'Escape') {
      event.preventDefault?.();
      closeSlideshow();
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault?.();
      navigatePrev();
    } else if (event.key === 'ArrowRight') {
      event.preventDefault?.();
      navigateNext();
    } else if (event.key === 'Tab') {
      const focusables = getFocusableControls();
      if (focusables.length === 0) return;
      const active = scope.activeElement;
      const idx = focusables.indexOf(active);
      if (event.shiftKey) {
        const prevIdx = idx <= 0 ? focusables.length - 1 : idx - 1;
        event.preventDefault?.();
        focusables[prevIdx].focus?.();
      } else {
        const nextIdx = idx >= focusables.length - 1 ? 0 : idx + 1;
        event.preventDefault?.();
        focusables[nextIdx].focus?.();
      }
    }
  });

  scaffold.__creatorCrateSlideshowState = { bindTrigger, refreshSequence };
  return sequence.length > 0 ? 1 : 0;
}

if (typeof document !== 'undefined') {
  const run = () => {
    enhancePreviewMedia(document);
    enhanceNotesCodeBlocks(document);
    enhanceProjectCards(document);
    enhanceAutoSubmit(document);
    enhanceCategoryReorder(document);
    enhanceNoteReorder(document);
    enhanceBookReorder(document);
    enhanceChapterPageReorder(document);
    enhanceBookContentReorder(document);
    enhanceNotesEditor(document);
    enhanceNotesAssetPicker(document);
    enhanceAssetAutoRenameOrdering(document);
    enhanceCategoryDetails(document);
    enhanceConfirmations(document);
    enhanceAssetSelection(document);
    enhanceAssetRenames(document);
    enhanceAssetGridSize(document);
    enhanceProjectGridSize(document);
    enhanceAssetProjectFilter(document);
    enhanceProjectAssetCategoryFilter(document);
    enhanceAssetViewerFilterDisclosures(document);
    enhanceAppDialogs(document);
    enhanceProjectsLiveFiltering(document);
    enhanceReleasesLiveFiltering(document);
    enhanceProjectAssetsLiveFiltering(document);
    enhanceAssetLibraryLiveFiltering(document);
    enhanceAssetViewerInfoCards(document);
    enhanceProjectInfoCards(document);
    enhanceDatePickers(document);
    enhanceTimePickers(document);
    enhanceSlideshow(document);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }
}
