import { isEnhancementBound, markEnhancementBound } from './dom.js';

const BOOK_REORDER_LIST_SELECTOR = '[data-book-reorder-list]';
const BOOK_REORDER_ITEM_SELECTOR = '[data-book-reorder-item]';
const BOOK_REORDER_HANDLE_SELECTOR = '[data-book-reorder-handle]';

const CHAPTER_PAGE_REORDER_LIST_SELECTOR = '[data-chapter-page-reorder-list]';
const CHAPTER_PAGE_REORDER_ITEM_SELECTOR = '[data-chapter-page-reorder-item]';
const CHAPTER_PAGE_REORDER_HANDLE_SELECTOR = '[data-chapter-page-reorder-handle]';

const BOOK_CONTENT_REORDER_LIST_SELECTOR = '[data-book-content-reorder-list]';
const BOOK_CONTENT_REORDER_ITEM_SELECTOR = '[data-book-content-reorder-item]';
const BOOK_CONTENT_REORDER_HANDLE_SELECTOR = '[data-book-content-reorder-handle]';

const APP_DIALOG_SELECTOR = '[data-app-dialog]';
const DASHBOARD_DEFAULTS_DIALOG_ID = 'dashboard-defaults-dialog';
const DASHBOARD_DEFAULTS_REORDER_LIST_SELECTOR = '[data-dashboard-defaults-reorder-list]';
const DASHBOARD_DEFAULTS_REORDER_ITEM_SELECTOR = '[data-dashboard-defaults-reorder-item]';
const DASHBOARD_DEFAULTS_REORDER_HANDLE_SELECTOR = '[data-dashboard-defaults-reorder-handle]';
const DASHBOARD_DEFAULTS_ORDER_INPUT_SELECTOR = '[data-dashboard-defaults-order-input]';

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

function canStartDedicatedReorderDrag(item, event, config) {
  const target = event.target;
  const handleTarget = target?.closest?.(config.handleSelector);
  if (dedicatedReorderElementIsInside(item, handleTarget)) return true;

  if (!config.pointerDragSurfaceSelector) return false;
  const surfaceTarget = target?.closest?.(config.pointerDragSurfaceSelector);
  if (!dedicatedReorderElementIsInside(item, surfaceTarget)) return false;

  const excludedTarget = config.pointerDragExcludedSelector
    ? target?.closest?.(config.pointerDragExcludedSelector)
    : null;
  return !dedicatedReorderElementIsInside(item, excludedTarget);
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
        if (!canStartDedicatedReorderDrag(item, event, config)) {
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

function dashboardDefaultsItemId(item) {
  return item?.dataset?.dashboardSectionId
    || item?.getAttribute?.('data-dashboard-section-id')
    || '';
}

function dashboardDefaultsSnapshot(list) {
  const items = Array.from(list?.querySelectorAll?.(DASHBOARD_DEFAULTS_REORDER_ITEM_SELECTOR) || []);
  return {
    order: items.map((item) => dashboardDefaultsItemId(item)),
    values: new Map(items.map((item) => {
      const visible = item.querySelector?.('input[type="checkbox"]');
      const itemCount = item.querySelector?.('input[type="number"]');
      return [dashboardDefaultsItemId(item), {
        visible: Boolean(visible?.checked),
        itemCount: String(itemCount?.value ?? ''),
      }];
    })),
  };
}

function restoreDashboardDefaultsSnapshot(state) {
  const { list, form, confirmed } = state;
  const itemsById = new Map(
    Array.from(list?.querySelectorAll?.(DASHBOARD_DEFAULTS_REORDER_ITEM_SELECTOR) || [])
      .map((item) => [dashboardDefaultsItemId(item), item]),
  );
  confirmed.order.forEach((id) => {
    const item = itemsById.get(id);
    if (item) list.appendChild?.(item);
  });
  confirmed.values.forEach((values, id) => {
    const item = itemsById.get(id);
    const visible = item?.querySelector?.('input[type="checkbox"]');
    const itemCount = item?.querySelector?.('input[type="number"]');
    if (visible) visible.checked = values.visible;
    if (itemCount) itemCount.value = values.itemCount;
  });
  updateDedicatedReorderMetadata(list, {
    itemSelector: DASHBOARD_DEFAULTS_REORDER_ITEM_SELECTOR,
    positionSelector: '[data-dashboard-defaults-order-position]',
  });
  const input = form?.querySelector?.(DASHBOARD_DEFAULTS_ORDER_INPUT_SELECTOR);
  if (input) input.value = confirmed.order.join(',');
}

function appDialogDocument(scope) {
  if (!scope) return null;
  if (scope.nodeType === 9) return scope;
  return scope.ownerDocument || globalThis.document || null;
}

export function enhanceDashboardDefaultsDialog(scope = globalThis.document) {
  const document = appDialogDocument(scope);
  if (!document || typeof document.querySelectorAll !== 'function') return 0;

  const dialogs = Array.from(document.querySelectorAll(APP_DIALOG_SELECTOR))
    .filter((dialog) => (dialog.id || dialog.getAttribute?.('id')) === DASHBOARD_DEFAULTS_DIALOG_ID);
  dialogs.forEach((dialog) => {
    const form = dialog.querySelector?.('[data-dashboard-defaults-reorder-form]');
    const list = dialog.querySelector?.(DASHBOARD_DEFAULTS_REORDER_LIST_SELECTOR);
    const appDialogState = dialog.__creatorCrateAppDialogState;
    if (!form || !list || !appDialogState || dialog.__creatorCrateDashboardDefaultsState) return;

    const state = { list, form, confirmed: dashboardDefaultsSnapshot(list) };
    dialog.__creatorCrateDashboardDefaultsState = state;
    enhanceDedicatedReorder(dialog, {
      listSelector: DASHBOARD_DEFAULTS_REORDER_LIST_SELECTOR,
      itemSelector: DASHBOARD_DEFAULTS_REORDER_ITEM_SELECTOR,
      handleSelector: DASHBOARD_DEFAULTS_REORDER_HANDLE_SELECTOR,
      formSelector: '[data-dashboard-defaults-reorder-form]',
      inputSelector: DASHBOARD_DEFAULTS_ORDER_INPUT_SELECTOR,
      liveSelector: '[data-dashboard-defaults-reorder-live]',
      positionSelector: '[data-dashboard-defaults-order-position]',
      idDataset: 'dashboardSectionId',
      idAttribute: 'data-dashboard-section-id',
      labelDataset: 'dashboardSectionLabel',
      labelAttribute: 'data-dashboard-section-label',
      label: 'Dashboard section',
      pointerDragSurfaceSelector: DASHBOARD_DEFAULTS_REORDER_ITEM_SELECTOR,
      pointerDragExcludedSelector: 'a, button, input, select, textarea, label, summary, details, [contenteditable="true"], [role="button"]',
      bindingKey: 'dashboardDefaultsReorderBound',
    });

    // The generic form value collector cannot model the hidden 0 + checkbox 1
    // pair, and it cannot restore DOM order. Dashboard owns that confirmed state.
    appDialogState.preserveValuesOnError = true;
    appDialogState.onOpen = () => restoreDashboardDefaultsSnapshot(state);
    appDialogState.onClose = () => restoreDashboardDefaultsSnapshot(state);
    appDialogState.onSuccessfulSubmit = () => {
      state.confirmed = dashboardDefaultsSnapshot(list);
      const windowObject = dialog.ownerDocument?.defaultView || globalThis;
      windowObject.location.assign('/?notice=dashboard_defaults_saved');
      return true;
    };
  });
  return dialogs.length;
}
