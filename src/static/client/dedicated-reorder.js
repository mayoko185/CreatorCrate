import { isEnhancementBound, markEnhancementBound } from './dom.js';
import { syncCreatorCrateDropdownFromNative } from './dropdowns.js';

const BOOK_REORDER_LIST_SELECTOR = '[data-book-reorder-list]';
const BOOK_REORDER_ITEM_SELECTOR = '[data-book-reorder-item]';
const BOOK_REORDER_HANDLE_SELECTOR = '[data-book-reorder-handle]';

const CHAPTER_PAGE_REORDER_LIST_SELECTOR = '[data-chapter-page-reorder-list]';
const CHAPTER_PAGE_REORDER_ITEM_SELECTOR = '[data-chapter-page-reorder-item]';
const CHAPTER_PAGE_REORDER_HANDLE_SELECTOR = '[data-chapter-page-reorder-handle]';

const BOOK_CONTENT_REORDER_LIST_SELECTOR = '[data-book-content-reorder-list]';
const BOOK_CONTENT_REORDER_ITEM_SELECTOR = '[data-book-content-reorder-item]';
const BOOK_CONTENT_REORDER_HANDLE_SELECTOR = '[data-book-content-reorder-handle]';
const BOOK_HIERARCHY_EDITOR_SELECTOR = '[data-book-hierarchy-editor]';
const BOOK_HIERARCHY_FORM_SELECTOR = '[data-book-hierarchy-form]';
const BOOK_HIERARCHY_CONTAINER_SELECTOR = '[data-book-hierarchy-container]';
const BOOK_HIERARCHY_ITEM_SELECTOR = '[data-book-hierarchy-item]';
const BOOK_HIERARCHY_HANDLE_SELECTOR = '[data-book-hierarchy-handle]';
const BOOK_HIERARCHY_INPUT_SELECTOR = '[data-book-hierarchy-input]';
const BOOK_HIERARCHY_LIVE_SELECTOR = '[data-book-hierarchy-live]';
export const NOTES_REORDER_INTERACTIVE_SELECTOR = 'a, button, input, select, textarea, label, summary, details, [contenteditable="true"], [role="button"]';

const APP_DIALOG_SELECTOR = '[data-app-dialog]';
const DASHBOARD_DEFAULTS_DIALOG_ID = 'dashboard-defaults-dialog';
const DASHBOARD_DEFAULTS_REORDER_LIST_SELECTOR = '[data-dashboard-defaults-reorder-list]';
const DASHBOARD_DEFAULTS_REORDER_ITEM_SELECTOR = '[data-dashboard-defaults-reorder-item]';
const DASHBOARD_DEFAULTS_REORDER_HANDLE_SELECTOR = '[data-dashboard-defaults-reorder-handle]';
const DASHBOARD_DEFAULTS_ORDER_INPUT_SELECTOR = '[data-dashboard-defaults-order-input]';
const DASHBOARD_DEFAULTS_SORT_DIALOG_ID = 'dashboard-defaults-sort-dialog';
const DASHBOARD_DEFAULTS_SORT_OPTIONS_TRIGGER_SELECTOR = '[data-dashboard-defaults-sort-options-trigger]';
const DASHBOARD_DEFAULTS_SORT_INPUT_SELECTOR = '[data-dashboard-defaults-sort-input]';
const DASHBOARD_DEFAULTS_SECTION_ORDER_INPUT_SELECTOR = '[data-dashboard-defaults-section-order-input]';
const DASHBOARD_DEFAULTS_SORT_SELECT_SELECTOR = '#dashboard-defaults-sort-select';
const DASHBOARD_DEFAULTS_ORDER_SELECT_SELECTOR = '#dashboard-defaults-order-select';
const DASHBOARD_DEFAULTS_SORT_SECTION_LABEL_SELECTOR = '[data-dashboard-defaults-sort-section-label]';
const DASHBOARD_DEFAULTS_SORT_APPLY_SELECTOR = '[data-dashboard-defaults-sort-apply]';

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
  if (config.syncInput) return config.syncInput(dedicatedReorderOrder(state.list, config));
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
  const target = event.target?.nodeType === 3 ? event.target.parentElement : event.target;
  const handleTarget = config.handleSelector ? target?.closest?.(config.handleSelector) : null;
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

function dedicatedDirectItems(container, itemSelector) {
  return Array.from(container?.children || []).filter((child) => child.matches?.(itemSelector));
}

function bookHierarchyContentKey(item) {
  const value = item?.dataset?.contentKey || item?.getAttribute?.('data-content-key') || '';
  const match = value.match(/^(chapter|page):(\d+)$/);
  if (!match) return null;
  const id = Number(match[2]);
  return Number.isSafeInteger(id) && id > 0 ? { type: match[1], id } : null;
}

function bookHierarchyContainerKind(container) {
  const value = container?.dataset?.bookHierarchyContainer
    || container?.getAttribute?.('data-book-hierarchy-container')
    || '';
  return value === 'root' ? 'root' : value.startsWith('chapter:') ? 'chapter' : '';
}

function bookHierarchyContainerFor(editor, element) {
  const container = element?.closest?.(BOOK_HIERARCHY_CONTAINER_SELECTOR);
  return container && dedicatedReorderElementIsInside(editor, container) ? container : null;
}

function bookHierarchyAccepts(container, item) {
  const destination = bookHierarchyContainerKind(container);
  const content = bookHierarchyContentKey(item);
  if (!destination || !content) return false;
  if (destination === 'root') return content.type === 'chapter' || content.type === 'page';
  return content.type === 'page';
}

function serializeBookHierarchy(editor) {
  const root = Array.from(editor.querySelectorAll?.(BOOK_HIERARCHY_CONTAINER_SELECTOR) || [])
    .find((container) => bookHierarchyContainerKind(container) === 'root');
  if (!root) return null;

  const seenChapters = new Set();
  const seenPages = new Set();
  const target = [];
  for (const item of dedicatedDirectItems(root, BOOK_HIERARCHY_ITEM_SELECTOR)) {
    const content = bookHierarchyContentKey(item);
    if (!content) return null;
    if (content.type === 'page') {
      if (seenPages.has(content.id)) return null;
      seenPages.add(content.id);
      target.push(content);
      continue;
    }

    if (seenChapters.has(content.id)) return null;
    seenChapters.add(content.id);
    const chapterContainer = Array.from(item.querySelectorAll?.(BOOK_HIERARCHY_CONTAINER_SELECTOR) || [])
      .find((container) => (
        bookHierarchyContainerKind(container) === 'chapter'
        && (container.dataset?.bookHierarchyContainer || container.getAttribute?.('data-book-hierarchy-container')) === `chapter:${content.id}`
      ));
    if (!chapterContainer) return null;
    const pages = [];
    for (const pageItem of dedicatedDirectItems(chapterContainer, BOOK_HIERARCHY_ITEM_SELECTOR)) {
      const page = bookHierarchyContentKey(pageItem);
      if (!page || page.type !== 'page' || seenPages.has(page.id)) return null;
      seenPages.add(page.id);
      pages.push(page.id);
    }
    target.push({ type: 'chapter', id: content.id, pages });
  }
  return target;
}

function updateBookHierarchyMetadata(editor) {
  const containers = Array.from(editor.querySelectorAll?.(BOOK_HIERARCHY_CONTAINER_SELECTOR) || []);
  containers.forEach((container) => {
    const items = dedicatedDirectItems(container, BOOK_HIERARCHY_ITEM_SELECTOR);
    items.forEach((item, index) => {
      item.setAttribute?.('aria-posinset', String(index + 1));
      item.setAttribute?.('aria-setsize', String(items.length));
    });
  });
}

function bookHierarchyRoot(editor) {
  return Array.from(editor.querySelectorAll?.(BOOK_HIERARCHY_CONTAINER_SELECTOR) || [])
    .find((container) => bookHierarchyContainerKind(container) === 'root') || null;
}

function bookHierarchyItemLabel(item) {
  return item?.dataset?.bookHierarchyLabel
    || item?.getAttribute?.('data-book-hierarchy-label')
    || '';
}

function bookHierarchyContainerKey(container) {
  return container?.dataset?.bookHierarchyContainer
    || container?.getAttribute?.('data-book-hierarchy-container')
    || '';
}

function announceBookHierarchyMove(state, item) {
  if (!state.live) return;
  const content = bookHierarchyContentKey(item);
  const container = bookHierarchyContainerFor(state.editor, item);
  if (!content || !container) return;
  const items = dedicatedDirectItems(container, BOOK_HIERARCHY_ITEM_SELECTOR);
  const index = items.indexOf(item);
  if (index === -1) return;
  const label = bookHierarchyItemLabel(item);
  if (content.type === 'chapter') {
    state.live.textContent = `Chapter “${label}” moved to position ${index + 1} of ${items.length}.`;
    return;
  }
  if (bookHierarchyContainerKind(container) === 'root') {
    state.live.textContent = `Page “${label}” moved to Book root, position ${index + 1} of ${items.length}.`;
    return;
  }
  const chapter = container.closest?.(BOOK_HIERARCHY_ITEM_SELECTOR);
  state.live.textContent = `Page “${label}” moved to Chapter “${bookHierarchyItemLabel(chapter)}”, position ${index + 1} of ${items.length}.`;
}

function moveBookHierarchyItemToIndex(container, item, targetIndex) {
  const items = dedicatedDirectItems(container, BOOK_HIERARCHY_ITEM_SELECTOR);
  const currentIndex = items.indexOf(item);
  if (currentIndex === -1 || currentIndex === targetIndex) return false;
  const remaining = items.filter((candidate) => candidate !== item);
  container.insertBefore?.(item, remaining[targetIndex] || null);
  return item.parentElement === container;
}

function completeBookHierarchyKeyboardMove(state, item) {
  updateBookHierarchyMetadata(state.editor);
  syncBookHierarchyInput(state);
  announceBookHierarchyMove(state, item);
  item.querySelector?.(BOOK_HIERARCHY_HANDLE_SELECTOR)?.focus?.();
}

function restoreBookHierarchyBaseline(state) {
  finishBookHierarchyDrag(state);
  const root = bookHierarchyRoot(state.editor);
  if (!root) return false;
  for (const entry of state.loadedTarget) {
    const item = state.items.get(`${entry.type}:${entry.id}`);
    if (!item) return false;
    root.appendChild?.(item);
    if (entry.type !== 'chapter') continue;
    const container = state.containers.get(`chapter:${entry.id}`);
    if (!container) return false;
    for (const pageId of entry.pages) {
      const page = state.items.get(`page:${pageId}`);
      if (!page) return false;
      container.appendChild?.(page);
    }
  }
  updateBookHierarchyMetadata(state.editor);
  return syncBookHierarchyInput(state);
}

function resolveBookHierarchyDropTarget(container, event, draggedItem) {
  const candidate = event.target?.closest?.(BOOK_HIERARCHY_ITEM_SELECTOR);
  if (candidate === draggedItem && candidate?.parentElement === container) return { kind: 'self' };
  if (candidate?.parentElement === container) {
    const rect = candidate?.getBoundingClientRect?.();
    const before = rect && Number.isFinite(event.clientY)
      ? event.clientY < rect.top + (rect.height / 2)
      : true;
    return { kind: before ? 'before' : 'after', item: candidate, before };
  }

  const remaining = dedicatedDirectItems(container, BOOK_HIERARCHY_ITEM_SELECTOR)
    .filter((item) => item !== draggedItem);
  if (remaining.length === 0) return { kind: 'empty' };
  return { kind: 'append', item: remaining[remaining.length - 1], before: false };
}

function moveBookHierarchyItem(container, item, target) {
  if (target?.item) {
    const reference = target.before
      ? target.item
      : dedicatedDirectItems(container, BOOK_HIERARCHY_ITEM_SELECTOR)[
        dedicatedDirectItems(container, BOOK_HIERARCHY_ITEM_SELECTOR).indexOf(target.item) + 1
      ];
    if (reference === item) return false;
    container.insertBefore?.(item, reference || null);
  } else {
    container.appendChild?.(item);
  }
  return item.parentElement === container;
}

function clearBookHierarchyDropIndicator(state) {
  clearDedicatedDropIndicator(state);
  state.dropContainer?.classList?.remove('is-drop-empty');
  if (state.dropContainer?.getAttribute?.('data-drop-position') === 'empty') {
    state.dropContainer.removeAttribute?.('data-drop-position');
  }
  state.dropContainer = null;
  state.dropTarget = null;
}

function setBookHierarchyDropIndicator(state, container, target) {
  clearBookHierarchyDropIndicator(state);
  state.dropContainer = container;
  state.dropTarget = target;
  if (target.kind === 'self') return;
  if (target.kind === 'empty') {
    container.classList?.add('is-drop-empty');
    container.setAttribute?.('data-drop-position', 'empty');
    return;
  }
  setDedicatedDropIndicator(state, target.item, target.before);
  if (target.kind === 'append') target.item.setAttribute?.('data-drop-position', 'append');
}

function finishBookHierarchyDrag(state) {
  state.draggedItem?.classList?.remove('is-dragging');
  state.sourceContainer?.classList?.remove('is-dragging');
  state.editor.classList?.remove('is-dragging');
  clearBookHierarchyDropIndicator(state);
  state.draggedItem = null;
  state.sourceContainer = null;
}

function syncBookHierarchyInput(state) {
  const target = serializeBookHierarchy(state.editor);
  if (!target) return false;
  state.input.value = JSON.stringify({ version: 1, expected: state.expected, target });
  return true;
}

export function enhanceBookHierarchyReorder(scope = globalThis.document) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;
  const editors = Array.from(scope.querySelectorAll(BOOK_HIERARCHY_EDITOR_SELECTOR));
  editors.forEach((editor) => {
    if (isEnhancementBound(editor, 'bookHierarchyReorderBound')) return;
    const form = editor.closest?.(BOOK_HIERARCHY_FORM_SELECTOR);
    const inputs = Array.from(form?.querySelectorAll?.(BOOK_HIERARCHY_INPUT_SELECTOR) || []);
    const containers = Array.from(editor.querySelectorAll?.(BOOK_HIERARCHY_CONTAINER_SELECTOR) || []);
    const handles = Array.from(editor.querySelectorAll?.(BOOK_HIERARCHY_HANDLE_SELECTOR) || []);
    if (!form || inputs.length !== 1 || containers.length === 0 || handles.length === 0) return;

    let payload;
    try {
      payload = JSON.parse(inputs[0].value);
    } catch {
      return;
    }
    const loadedTarget = serializeBookHierarchy(editor);
    if (payload?.version !== 1 || !Array.isArray(payload.expected) || !loadedTarget) return;

    const state = {
      editor,
      form,
      input: inputs[0],
      expected: payload.expected,
      loadedTarget: JSON.parse(JSON.stringify(loadedTarget)),
      items: new Map(Array.from(editor.querySelectorAll?.(BOOK_HIERARCHY_ITEM_SELECTOR) || [])
        .map((item) => [item.dataset?.contentKey || item.getAttribute?.('data-content-key'), item])),
      containers: new Map(containers.map((container) => [bookHierarchyContainerKey(container), container])),
      live: editor.querySelector?.(BOOK_HIERARCHY_LIVE_SELECTOR),
      submitting: false,
      draggedItem: null,
      sourceContainer: null,
      dropContainer: null,
      dropTarget: null,
      dropItem: null,
      dropBefore: null,
    };

    markEnhancementBound(editor, 'bookHierarchyReorderBound');
    updateBookHierarchyMetadata(editor);
    syncBookHierarchyInput(state);

    editor.addEventListener?.('dragstart', (event) => {
      const target = event.target?.nodeType === 3 ? event.target.parentElement : event.target;
      const item = target?.closest?.(BOOK_HIERARCHY_ITEM_SELECTOR);
      const container = bookHierarchyContainerFor(editor, item);
      const canStart = item && canStartDedicatedReorderDrag(item, { target }, {
        handleSelector: BOOK_HIERARCHY_HANDLE_SELECTOR,
        pointerDragSurfaceSelector: BOOK_HIERARCHY_ITEM_SELECTOR,
        pointerDragExcludedSelector: NOTES_REORDER_INTERACTIVE_SELECTOR,
      });
      if (!canStart || !container || item.parentElement !== container) {
        event.preventDefault?.();
        finishBookHierarchyDrag(state);
        return;
      }
      finishBookHierarchyDrag(state);
      state.draggedItem = item;
      state.sourceContainer = container;
      item.classList?.add('is-dragging');
      container.classList?.add('is-dragging');
      editor.classList?.add('is-dragging');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData?.('application/x-creatorcrate-book-hierarchy', item.dataset?.contentKey || '');
      }
    });

    editor.addEventListener?.('dragover', (event) => {
      if (!state.draggedItem) return;
      const container = bookHierarchyContainerFor(editor, event.target);
      if (!container || !bookHierarchyAccepts(container, state.draggedItem)) {
        clearBookHierarchyDropIndicator(state);
        return;
      }
      event.preventDefault?.();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      const target = resolveBookHierarchyDropTarget(container, event, state.draggedItem);
      setBookHierarchyDropIndicator(state, container, target);
    });

    editor.addEventListener?.('dragleave', (event) => {
      if (!state.dropContainer) return;
      const relatedTarget = event.relatedTarget;
      if (!relatedTarget || !state.dropContainer.contains?.(relatedTarget)) clearBookHierarchyDropIndicator(state);
    });

    editor.addEventListener?.('drop', (event) => {
      if (!state.draggedItem) return;
      const container = bookHierarchyContainerFor(editor, event.target);
      if (!container || !bookHierarchyAccepts(container, state.draggedItem)) {
        finishBookHierarchyDrag(state);
        return;
      }
      event.preventDefault?.();
      const before = JSON.stringify(serializeBookHierarchy(editor));
      const target = state.dropContainer === container && state.dropTarget
        ? state.dropTarget
        : resolveBookHierarchyDropTarget(container, event, state.draggedItem);
      if (target.kind !== 'self') moveBookHierarchyItem(container, state.draggedItem, target);
      const after = JSON.stringify(serializeBookHierarchy(editor));
      finishBookHierarchyDrag(state);
      if (before !== after) {
        updateBookHierarchyMetadata(editor);
        syncBookHierarchyInput(state);
      }
    });

    editor.addEventListener?.('dragend', () => finishBookHierarchyDrag(state));
    editor.addEventListener?.('keydown', (event) => {
      if (event.key === 'Escape' && state.draggedItem) {
        finishBookHierarchyDrag(state);
        return;
      }
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      const handle = event.target?.closest?.(BOOK_HIERARCHY_HANDLE_SELECTOR);
      const item = handle?.closest?.(BOOK_HIERARCHY_ITEM_SELECTOR);
      const container = bookHierarchyContainerFor(editor, item);
      if (!handle || !item || !container || item.parentElement !== container) return;
      if (bookHierarchyContentKey(item)?.type === 'chapter'
        && bookHierarchyContainerKind(container) !== 'root') return;

      event.preventDefault?.();
      const items = dedicatedDirectItems(container, BOOK_HIERARCHY_ITEM_SELECTOR);
      const currentIndex = items.indexOf(item);
      const targetIndex = event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : currentIndex + (event.key === 'ArrowUp' ? -1 : 1);
      if (targetIndex < 0 || targetIndex >= items.length || targetIndex === currentIndex) return;
      if (moveBookHierarchyItemToIndex(container, item, targetIndex)) {
        completeBookHierarchyKeyboardMove(state, item);
      }
    });
    form.addEventListener?.('submit', () => {
      syncBookHierarchyInput(state);
      state.submitting = true;
    });

    const dialog = form.closest?.(APP_DIALOG_SELECTOR);
    const appDialogState = dialog?.__creatorCrateAppDialogState;
    if (appDialogState) {
      const previousOnOpen = appDialogState.onOpen;
      const previousOnClose = appDialogState.onClose;
      appDialogState.onOpen = () => {
        try {
          previousOnOpen?.();
        } finally {
          state.submitting = false;
        }
      };
      appDialogState.onClose = () => {
        try {
          previousOnClose?.();
        } finally {
          if (!state.submitting) restoreBookHierarchyBaseline(state);
        }
      };
    }
  });
  return editors.length;
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
  state.clearPointerTarget?.();
  const draggedItem = state.draggedItem;
  if (draggedItem) draggedItem.classList?.remove('is-dragging');
  state.list.classList?.remove('is-dragging');
  clearDedicatedDropIndicator(state);
  state.draggedItem = null;
}

export function enhanceDedicatedReorder(scope, config) {
  if (!scope || typeof scope.querySelectorAll !== 'function') return 0;

  const lists = scope.querySelectorAll(config.listSelector);
  lists.forEach((list) => {
    if (isEnhancementBound(list, config.bindingKey)) return;

    const items = dedicatedReorderItems(list, config);
    const form = config.form || findDedicatedReorderForm(list, scope, config);
    const handles = items.map((item) => config.wholeCardKeyboard ? item : item.querySelector?.(config.handleSelector));
    if (!form || items.length === 0 || handles.some((handle) => !handle)) return;

    const state = {
      list,
      form,
      live: dedicatedReorderLiveRegion(list, scope, config),
      draggedItem: null,
      dropItem: null,
      dropBefore: null,
    };

    // Chromium can retarget dragstart to the draggable ancestor. Remember the
    // pressed descendant only until this gesture is consumed or terminated.
    let pointerGesture = null;
    const document = list.ownerDocument;
    const windowObject = document?.defaultView;
    const clearPointerTarget = () => {
      pointerGesture = null;
      document?.removeEventListener?.('pointerdown', clearPointerTarget, true);
      document?.removeEventListener?.('pointerup', clearPointerTarget, true);
      document?.removeEventListener?.('pointercancel', clearPointerTarget, true);
      windowObject?.removeEventListener?.('blur', clearPointerTarget);
    };
    state.clearPointerTarget = clearPointerTarget;

    markEnhancementBound(list, config.bindingKey);
    updateDedicatedReorderMetadata(list, config);
    syncDedicatedReorderInput(state, config);

    form.addEventListener?.('submit', () => {
      syncDedicatedReorderInput(state, config);
    });

    items.forEach((item) => {
      const handle = config.wholeCardKeyboard ? item : item.querySelector?.(config.handleSelector);

      item.addEventListener?.('pointerdown', (event) => {
        clearPointerTarget();
        if (event.button !== 0 || event.isPrimary === false) return;
        pointerGesture = { item, target: event.target };
        document?.addEventListener?.('pointerdown', clearPointerTarget, true);
        document?.addEventListener?.('pointerup', clearPointerTarget, true);
        document?.addEventListener?.('pointercancel', clearPointerTarget, true);
        windowObject?.addEventListener?.('blur', clearPointerTarget);
      }, true);

      item.addEventListener?.('dragstart', (event) => {
        const target = pointerGesture?.item === item ? pointerGesture.target : event.target;
        clearPointerTarget();
        if (config.isBusy?.() || !canStartDedicatedReorderDrag(item, { target }, config)) {
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
        if (config.wholeCardKeyboard && event.target !== item) return;
        const keyTargets = { ArrowUp: -1, ArrowDown: 1, Home: 0, End: items.length - 1 };
        if (!Object.prototype.hasOwnProperty.call(keyTargets, event.key)) return;

        event.preventDefault?.();
        if (config.isBusy?.()) return;
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
          config.onOrderChange?.({ item, keyboard: true });
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
        if (config.onOrderChange) announceDedicatedMove(state, draggedItem, config);
        config.onOrderChange?.({ item: draggedItem, keyboard: false });
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
    pointerDragSurfaceSelector: BOOK_REORDER_ITEM_SELECTOR,
    pointerDragExcludedSelector: NOTES_REORDER_INTERACTIVE_SELECTOR,
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
    pointerDragSurfaceSelector: CHAPTER_PAGE_REORDER_ITEM_SELECTOR,
    pointerDragExcludedSelector: NOTES_REORDER_INTERACTIVE_SELECTOR,
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
    pointerDragSurfaceSelector: BOOK_CONTENT_REORDER_ITEM_SELECTOR,
    pointerDragExcludedSelector: NOTES_REORDER_INTERACTIVE_SELECTOR,
    bindingKey: 'bookContentReorderBound',
  });
}

function dashboardDefaultsItemId(item) {
  return item?.dataset?.dashboardSectionId
    || item?.getAttribute?.('data-dashboard-section-id')
    || '';
}

function dashboardDefaultsItemLabel(item) {
  return item?.dataset?.dashboardSectionLabel
    || item?.getAttribute?.('data-dashboard-section-label')
    || dashboardDefaultsItemId(item);
}

function dashboardDefaultsSnapshot(list) {
  const items = Array.from(list?.querySelectorAll?.(DASHBOARD_DEFAULTS_REORDER_ITEM_SELECTOR) || []);
  return {
    order: items.map((item) => dashboardDefaultsItemId(item)),
    values: new Map(items.map((item) => {
      const visible = item.querySelector?.('input[type="checkbox"]');
      const itemCount = item.querySelector?.('input[type="number"]');
      const sort = item.querySelector?.(DASHBOARD_DEFAULTS_SORT_INPUT_SELECTOR);
      const order = item.querySelector?.(DASHBOARD_DEFAULTS_SECTION_ORDER_INPUT_SELECTOR);
      return [dashboardDefaultsItemId(item), {
        visible: Boolean(visible?.checked),
        itemCount: String(itemCount?.value ?? ''),
        sort: String(sort?.value ?? ''),
        order: String(order?.value ?? ''),
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
    const sort = item?.querySelector?.(DASHBOARD_DEFAULTS_SORT_INPUT_SELECTOR);
    const order = item?.querySelector?.(DASHBOARD_DEFAULTS_SECTION_ORDER_INPUT_SELECTOR);
    if (visible) visible.checked = values.visible;
    if (itemCount) itemCount.value = values.itemCount;
    if (sort) sort.value = values.sort;
    if (order) order.value = values.order;
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
  const sortDialog = document.getElementById?.(DASHBOARD_DEFAULTS_SORT_DIALOG_ID);
  dialogs.forEach((dialog) => {
    const form = dialog.querySelector?.('[data-dashboard-defaults-reorder-form]');
    const list = dialog.querySelector?.(DASHBOARD_DEFAULTS_REORDER_LIST_SELECTOR);
    const appDialogState = dialog.__creatorCrateAppDialogState;
    if (!form || !list || !appDialogState || dialog.__creatorCrateDashboardDefaultsState) return;

    const state = { list, form, confirmed: dashboardDefaultsSnapshot(list), activeSortTrigger: null };
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

    const sortSelect = sortDialog?.querySelector?.(DASHBOARD_DEFAULTS_SORT_SELECT_SELECTOR);
    const orderSelect = sortDialog?.querySelector?.(DASHBOARD_DEFAULTS_ORDER_SELECT_SELECTOR);
    const sectionLabel = sortDialog?.querySelector?.(DASHBOARD_DEFAULTS_SORT_SECTION_LABEL_SELECTOR);
    const apply = sortDialog?.querySelector?.(DASHBOARD_DEFAULTS_SORT_APPLY_SELECTOR);
    if (!sortSelect || !orderSelect || !apply || sortDialog.__creatorCrateDashboardDefaultsSortState) return;

    sortDialog.__creatorCrateDashboardDefaultsSortState = state;
    Array.from(list.querySelectorAll?.(DASHBOARD_DEFAULTS_SORT_OPTIONS_TRIGGER_SELECTOR) || []).forEach((trigger) => {
      if (isEnhancementBound(trigger, 'dashboardDefaultsSortOptionsBound')) return;
      markEnhancementBound(trigger, 'dashboardDefaultsSortOptionsBound');
      trigger.addEventListener?.('click', () => {
        const item = trigger.closest?.(DASHBOARD_DEFAULTS_REORDER_ITEM_SELECTOR);
        const sort = item?.querySelector?.(DASHBOARD_DEFAULTS_SORT_INPUT_SELECTOR);
        const order = item?.querySelector?.(DASHBOARD_DEFAULTS_SECTION_ORDER_INPUT_SELECTOR);
        if (!item || !sort || !order) return;
        state.activeSortTrigger = trigger;
        sortSelect.value = sort.value;
        orderSelect.value = order.value;
        if (sectionLabel) sectionLabel.textContent = dashboardDefaultsItemLabel(item);
        syncCreatorCrateDropdownFromNative(sortSelect);
        syncCreatorCrateDropdownFromNative(orderSelect);
      });
    });

    markEnhancementBound(apply, 'dashboardDefaultsSortApplyBound');
    apply.addEventListener?.('click', (event) => {
      event.preventDefault?.();
      const item = state.activeSortTrigger?.closest?.(DASHBOARD_DEFAULTS_REORDER_ITEM_SELECTOR);
      const sort = item?.querySelector?.(DASHBOARD_DEFAULTS_SORT_INPUT_SELECTOR);
      const order = item?.querySelector?.(DASHBOARD_DEFAULTS_SECTION_ORDER_INPUT_SELECTOR);
      if (!sort || !order) return;
      sort.value = sortSelect.value;
      order.value = orderSelect.value;
      sortDialog.close?.();
    });
  });
  return dialogs.length;
}
