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

const AUTO_RENAME_SURFACE_SELECTOR = '[data-auto-rename-surface]';
const AUTO_RENAME_ASSET_SELECTOR = '[data-auto-rename-asset]';
const AUTO_RENAME_FORM_SELECTOR = '[data-auto-rename-form]';
const AUTO_RENAME_ORDER_INPUT_SELECTOR = '[data-auto-rename-order-input]';
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
  autoRenameSetDisabled(button, !valid || unchanged);

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
});
const PROJECT_GRID_SIZE_CONFIG = Object.freeze({
  controlSelector: PROJECT_GRID_SIZE_CONTROL_SELECTOR,
  gridSelector: PROJECT_GRID_SELECTOR,
  storageKey: PROJECT_GRID_SIZE_STORAGE_KEY,
  cssVariable: '--project-card-min',
  boundKey: 'projectGridSizeBound',
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
      optionLabel.classList?.toggle?.('is-active', optionLabel.dataset.gridSizeOptionLabel === size);
    });
  });
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
    group.querySelectorAll(ASSET_GRID_SIZE_SLIDER_SELECTOR).forEach((slider) => {
      if (isEnhancementBound(slider, config.boundKey)) return;
      markEnhancementBound(slider, config.boundKey);
      const applySliderSize = () => {
        const size = assetGridSizeFromPosition(slider.value);
        if (!size) return;
        writeGridSize(size, config.storageKey);
        applyGridSize(scope, size, config, controls);
      };
      slider.addEventListener('input', applySliderSize);
      slider.addEventListener('change', applySliderSize);
    });
  });
  return controls.length;
}

export function enhanceAssetGridSize(scope = globalThis.document) {
  return enhanceGridSize(scope, ASSET_GRID_SIZE_CONFIG);
}

export function enhanceProjectGridSize(scope = globalThis.document) {
  return enhanceGridSize(scope, PROJECT_GRID_SIZE_CONFIG);
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
  const selectedOption = options.find((option) => getProjectAssetCategoryFilterInput(option)?.checked);
  const selectedInput = getProjectAssetCategoryFilterInput(selectedOption);
  const selectedLabel = selectedOption?.querySelector?.('label')?.textContent?.trim()
    || 'All categories';
  const missingOption = options.find((option) => {
    const input = getProjectAssetCategoryFilterInput(option);
    return input?.value === 'all'
      && input?.getAttribute?.('data-asset-category-presence') === 'missing';
  });
  const missingLabel = missingOption?.querySelector?.('label')?.textContent?.trim() || 'Missing';
  const selectedPresence = selectedInput?.getAttribute?.('data-asset-category-presence') || 'all';

  if (syncPresence && presenceControl && selectedPresence) {
    presenceControl.value = selectedPresence;
  }

  const effectivePresence = presenceControl?.value || selectedPresence;
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
    const presenceControl = filter.closest?.('form')?.querySelector?.('select[name="presence"]') || null;

    if (!isEnhancementBound(filter, 'projectAssetCategoryFilterBound')) {
      markEnhancementBound(filter, 'projectAssetCategoryFilterBound');
      options.forEach((option) => {
        getProjectAssetCategoryFilterInput(option)?.addEventListener?.('change', () => {
          updateProjectAssetCategoryFilter(filter, options, presenceControl, true);
        });
      });
      presenceControl?.addEventListener?.('change', () => {
        updateProjectAssetCategoryFilter(filter, options, presenceControl);
      });
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

if (typeof document !== 'undefined') {
  const run = () => {
    enhancePreviewMedia(document);
    enhanceProjectCards(document);
    enhanceAutoSubmit(document);
    enhanceCategoryReorder(document);
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
    enhanceAssetViewerInfoCards(document);
    enhanceProjectInfoCards(document);
    enhanceDatePickers(document);
    enhanceTimePickers(document);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }
}
