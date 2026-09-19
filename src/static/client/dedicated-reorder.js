import { isEnhancementBound, markEnhancementBound } from './dom.js';
import { syncCreatorCrateDropdownFromNative } from './dropdowns.js';
import {
  beginBookDetailDefaultsLiveRefresh,
  beginNotesBooksLiveRefresh,
  installBookDetailLiveRegionSnapshot,
  installNotesBooksLiveRegionSnapshot,
  refreshBookDetailLiveRegion,
  refreshNotesBooksLiveRegion,
} from './live-regions.js';

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

function restoreDedicatedReorderOrder(state, ids, config) {
  const items = new Map(dedicatedReorderItems(state.list, config)
    .map((item) => [dedicatedReorderId(item, config), item]));
  if (ids.length !== items.size || ids.some((id) => !items.has(String(id)))) return false;
  ids.forEach((id) => state.list.appendChild?.(items.get(String(id))));
  updateDedicatedReorderMetadata(state.list, config);
  syncDedicatedReorderInput(state, config);
  return sameDedicatedReorder(
    dedicatedReorderOrder(state.list, config),
    ids.map((id) => String(id)),
  );
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
  queueBookHierarchySave(state);
}

function applyBookHierarchy(state, hierarchy) {
  finishBookHierarchyDrag(state);
  const root = bookHierarchyRoot(state.editor);
  if (!root || !Array.isArray(hierarchy)) return false;
  for (const entry of hierarchy) {
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
  const applied = serializeBookHierarchy(state.editor);
  return applied && JSON.stringify(applied) === JSON.stringify(hierarchy);
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
  state.desiredHierarchy = JSON.parse(JSON.stringify(target));
  state.input.value = JSON.stringify({ version: 1, expected: state.expected, target });
  return true;
}

function sameBookHierarchy(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function bookHierarchyResponseAuthority(payload, state) {
  if (!Array.isArray(payload?.hierarchy)) return null;
  const hierarchy = JSON.parse(JSON.stringify(payload.hierarchy));
  const keys = [];
  for (const entry of hierarchy) {
    if (!entry || !['chapter', 'page'].includes(entry.type)
      || !Number.isSafeInteger(entry.id) || entry.id <= 0) return null;
    keys.push(`${entry.type}:${entry.id}`);
    if (entry.type === 'page') {
      if (Object.hasOwn(entry, 'pages')) return null;
      continue;
    }
    if (!Array.isArray(entry.pages) || !state.containers.has(`chapter:${entry.id}`)) return null;
    for (const pageId of entry.pages) {
      if (!Number.isSafeInteger(pageId) || pageId <= 0) return null;
      keys.push(`page:${pageId}`);
    }
  }
  if (keys.length !== state.items.size || new Set(keys).size !== keys.length
    || keys.some((key) => !state.items.has(key))) return null;
  return hierarchy;
}

function setBookHierarchyStatus(state, message, status) {
  state.form.setAttribute?.('data-book-hierarchy-state', status);
  const dialog = state.form.closest?.(APP_DIALOG_SELECTOR);
  if (status === 'error') dialog?.setAttribute?.('data-dialog-state', 'error');
  else dialog?.removeAttribute?.('data-dialog-state');
  if (!state.status) return;
  state.status.setAttribute?.('role', status === 'error' ? 'alert' : 'status');
  state.status.textContent = message;
}

async function fetchBookHierarchyEditorFromServer(state, payload) {
  const destination = payload?.refreshUrl || state.refreshUrl;
  const Parser = state.editor.ownerDocument?.defaultView?.DOMParser || globalThis.DOMParser;
  if (!destination || typeof globalThis.fetch !== 'function' || typeof Parser !== 'function') return null;
  try {
    const response = await globalThis.fetch(`${destination}/order`, {
      method: 'GET',
      headers: { Accept: 'text/html' },
      credentials: 'same-origin',
      redirect: 'error',
    });
    if (!response?.ok || typeof response.text !== 'function') return null;
    const parsed = new Parser().parseFromString(await response.text(), 'text/html');
    const replacementForm = parsed?.querySelector?.(BOOK_HIERARCHY_FORM_SELECTOR);
    const replacementEditor = replacementForm?.querySelector?.(BOOK_HIERARCHY_EDITOR_SELECTOR);
    const replacementInput = replacementForm?.querySelector?.(BOOK_HIERARCHY_INPUT_SELECTOR);
    const replacementDetail = parsed?.querySelector?.('[data-book-detail-live-region]');
    if (!replacementEditor || !replacementInput) return null;
    const replacementPayload = JSON.parse(replacementInput.value);
    const expectedEmpty = replacementPayload?.version === 1
      && Array.isArray(replacementPayload.expected)
      && replacementPayload.expected.length === 0
      && Array.isArray(replacementPayload.target)
      && replacementPayload.target.length === 0;
    const emptyEditor = replacementEditor.querySelectorAll?.(BOOK_HIERARCHY_ITEM_SELECTOR).length === 0
      && replacementEditor.querySelectorAll?.(BOOK_HIERARCHY_CONTAINER_SELECTOR).length === 0
      && replacementEditor.querySelectorAll?.(BOOK_HIERARCHY_HANDLE_SELECTOR).length === 0
      && replacementEditor.querySelector?.('.help-text')?.textContent?.trim()
        === 'This Book has no Chapters or Pages to order yet.';
    const detailNavigation = replacementDetail?.querySelector?.('.notes-book-nav');
    const detailList = detailNavigation?.querySelector?.('.notes-book-nav-list');
    const emptyDetail = detailList
      && detailList.children.length === 0
      && detailNavigation.querySelector?.('.notes-book-nav-empty')?.textContent?.trim()
        === 'No Pages or Chapters yet'
      && replacementDetail.querySelectorAll?.('.notes-book-nav-page-link, .notes-book-nav-chapter').length === 0
      && replacementDetail.querySelectorAll?.('.notes-page-preview-item').length === 0
      && Boolean(replacementDetail.querySelector?.('.notes-page-previews-empty'));
    if (expectedEmpty && emptyEditor && emptyDetail
      && (!Array.isArray(payload?.hierarchy) || payload.hierarchy.length === 0)) {
      return {
        kind: 'empty',
        destination,
        replacementEditor,
        replacementInput,
        replacementDetail,
        hierarchy: [],
      };
    }
    const renderedHierarchy = serializeBookHierarchy(replacementEditor);
    if (replacementPayload?.version !== 1 || !Array.isArray(replacementPayload.expected)
      || !renderedHierarchy || !sameBookHierarchy(replacementPayload.expected, renderedHierarchy)
      || (Array.isArray(payload?.hierarchy)
        && !sameBookHierarchy(replacementPayload.expected, payload.hierarchy))) return null;
    return {
      kind: 'active',
      destination,
      replacementEditor,
      replacementInput,
      replacementDetail,
      hierarchy: replacementPayload.expected,
    };
  } catch {
    return null;
  }
}

function focusBookHierarchyDialog(state) {
  const dialog = state.form.closest?.(APP_DIALOG_SELECTOR);
  const dialogState = dialog?.__creatorCrateAppDialogState;
  if ((typeof dialogState?.open === 'boolean' && !dialogState.open)
    || (typeof dialog?.open === 'boolean' && !dialog.open)) return;
  const target = dialog?.querySelector?.('[data-dialog-close]')
    || state.form.querySelector?.(BOOK_HIERARCHY_EDITOR_SELECTOR)
      ?.querySelector?.(BOOK_HIERARCHY_HANDLE_SELECTOR);
  target?.focus?.();
}

function publishBookHierarchyEditor(state, replacement) {
  const parent = state.editor.parentNode;
  if (!parent || !replacement?.replacementEditor || !replacement?.replacementInput) return false;
  state.input.value = replacement.replacementInput.value;
  if (typeof state.editor.replaceWith === 'function') state.editor.replaceWith(replacement.replacementEditor);
  else if (typeof parent.replaceChild === 'function') parent.replaceChild(replacement.replacementEditor, state.editor);
  else return false;
  state.retired = true;
  if (replacement.kind === 'empty') {
    state.expected = [];
    state.acknowledgedHierarchy = [];
    state.desiredHierarchy = [];
    state.activeHierarchy = null;
    state.queuedHierarchy = null;
    state.pendingUncertainHierarchy = null;
    focusBookHierarchyDialog(state);
    return { kind: 'empty', state: null };
  }
  enhanceBookHierarchyReorder(state.form, {
    beginDetailRefresh: state.beginDetailRefresh,
    refreshDetail: state.refreshDetail,
    installDetail: state.installDetail,
    fetchAuthority: state.fetchAuthority,
  });
  focusBookHierarchyDialog(state);
  const nextState = replacement.replacementEditor.__creatorCrateBookHierarchyState || null;
  return nextState && sameBookHierarchy(nextState.acknowledgedHierarchy, replacement.hierarchy)
    ? { kind: 'active', state: nextState }
    : null;
}

function bookHierarchyMembership(hierarchy) {
  const keys = [];
  for (const entry of hierarchy || []) {
    keys.push(`${entry.type}:${entry.id}`);
    if (entry.type === 'chapter') {
      for (const pageId of entry.pages || []) keys.push(`page:${pageId}`);
    }
  }
  return keys.sort();
}

function sameBookHierarchyMembership(left, right) {
  return sameBookHierarchy(bookHierarchyMembership(left), bookHierarchyMembership(right));
}

function removeBookHierarchyRetry(state) {
  state.retryButton?.remove?.();
  state.retryButton = null;
}

function showBookHierarchyReconciliationFailure(state, retry, contextMessage = '') {
  state.form.setAttribute?.('aria-busy', 'true');
  setBookHierarchyStatus(
    state,
    `${contextMessage ? `${contextMessage} ` : ''}Could not restore the current Book hierarchy. Reordering remains blocked. Retry reconciliation to continue.`,
    'error',
  );
  const button = state.editor.ownerDocument?.createElement?.('button');
  if (button && state.status) {
    removeBookHierarchyRetry(state);
    button.type = 'button';
    button.className = 'button button-secondary';
    button.setAttribute?.('data-book-hierarchy-reconciliation-retry', '');
    button.textContent = 'Retry reconciliation';
    button.addEventListener?.('click', () => {
      removeBookHierarchyRetry(state);
      void retry();
    });
    state.status.appendChild?.(button);
    state.retryButton = button;
    const dialog = state.form.closest?.(APP_DIALOG_SELECTOR);
    const dialogState = dialog?.__creatorCrateAppDialogState;
    if (!((typeof dialogState?.open === 'boolean' && !dialogState.open)
      || (typeof dialog?.open === 'boolean' && !dialog.open))) button.focus?.();
    return;
  }
  focusBookHierarchyDialog(state);
}

async function reconcileUncertainBookHierarchy(state) {
  state.reconciling = true;
  state.form.setAttribute?.('aria-busy', 'true');
  finishBookHierarchyDrag(state);
  setBookHierarchyStatus(
    state,
    'Could not confirm whether the hierarchy was saved. Restoring current hierarchy authority.',
    'reconciling',
  );
  const generation = state.beginDetailRefresh(state.editor.ownerDocument);
  const replacement = generation === null
    ? null
    : await state.fetchAuthority(state, null);
  const previousDetail = state.editor.ownerDocument
    ?.querySelector?.('[data-book-detail-live-region]') || null;
  if (!replacement?.replacementDetail
    || state.installDetail(
      state.editor.ownerDocument,
      replacement.destination,
      generation,
      replacement.replacementDetail,
    ) !== 'installed') {
    showBookHierarchyReconciliationFailure(state, () => reconcileUncertainBookHierarchy(state));
    return false;
  }

  let queued = state.pendingUncertainHierarchy
    ? JSON.parse(JSON.stringify(state.pendingUncertainHierarchy))
    : null;
  const published = publishBookHierarchyEditor(state, replacement);
  if (!published) {
    const currentDetail = state.editor.ownerDocument
      ?.querySelector?.('[data-book-detail-live-region]');
    if (previousDetail && currentDetail && currentDetail !== previousDetail) {
      currentDetail.replaceWith?.(previousDetail);
    }
    showBookHierarchyReconciliationFailure(state, () => reconcileUncertainBookHierarchy(state));
    return false;
  }

  state.pendingUncertainHierarchy = null;
  removeBookHierarchyRetry(state);
  if (published.kind === 'empty') {
    state.form.removeAttribute?.('aria-busy');
    setBookHierarchyStatus(state, queued
      ? 'Current hierarchy restored. A pending hierarchy change was not applied because the Book contents changed; make the move again if it is still wanted.'
      : 'Current hierarchy restored.', queued ? 'error' : 'saved');
    queued = null;
    focusBookHierarchyDialog(state);
    return true;
  }
  const nextState = published.state;
  if (queued && sameBookHierarchyMembership(queued, replacement.hierarchy)) {
    applyBookHierarchy(nextState, queued);
    syncBookHierarchyInput(nextState);
    setBookHierarchyStatus(nextState, 'Current hierarchy restored. Saving the newer queued move.', 'pending');
    queueBookHierarchySave(nextState);
    return true;
  }

  nextState.form.removeAttribute?.('aria-busy');
  if (queued) {
    setBookHierarchyStatus(
      nextState,
      'Current hierarchy restored. A newer queued move was not applied because Book membership changed; make the move again if it is still wanted.',
      'error',
    );
  } else {
    setBookHierarchyStatus(nextState, 'Current hierarchy restored.', 'saved');
  }
  return true;
}

async function synchronizeAcknowledgedBookHierarchy(state, pendingHierarchy) {
  state.reconciling = true;
  state.saving = false;
  state.activeHierarchy = null;
  state.queuedHierarchy = null;
  state.form.setAttribute?.('aria-busy', 'true');
  finishBookHierarchyDrag(state);
  setBookHierarchyStatus(
    state,
    'Book hierarchy saved. Synchronizing current Book contents.',
    'reconciling',
  );

  const retry = () => synchronizeAcknowledgedBookHierarchy(state, pendingHierarchy);
  const failureMessage = 'Book hierarchy saved, but current Book contents could not be synchronized.';
  const generation = state.beginDetailRefresh(state.editor.ownerDocument);
  const replacement = generation === null
    ? null
    : await state.fetchAuthority(state, null);
  if (!replacement) {
    showBookHierarchyReconciliationFailure(state, retry, failureMessage);
    return false;
  }

  const previousDetail = state.editor.ownerDocument
    ?.querySelector?.('[data-book-detail-live-region]') || null;
  if (!replacement.replacementDetail
    || state.installDetail(
      state.editor.ownerDocument,
      replacement.destination,
      generation,
      replacement.replacementDetail,
    ) !== 'installed') {
    showBookHierarchyReconciliationFailure(state, retry, failureMessage);
    return false;
  }

  if (replacement.kind === 'active'
    && sameBookHierarchyMembership(state.acknowledgedHierarchy, replacement.hierarchy)) {
    state.expected = JSON.parse(JSON.stringify(replacement.hierarchy));
    state.acknowledgedHierarchy = JSON.parse(JSON.stringify(replacement.hierarchy));
    const editorMatchesCanonical = sameBookHierarchy(
      serializeBookHierarchy(state.editor),
      replacement.hierarchy,
    );
    if (editorMatchesCanonical && pendingHierarchy
      && sameBookHierarchyMembership(pendingHierarchy, replacement.hierarchy)
      && applyBookHierarchy(state, pendingHierarchy)) {
      removeBookHierarchyRetry(state);
      state.reconciling = false;
      syncBookHierarchyInput(state);
      setBookHierarchyStatus(
        state,
        'Book hierarchy saved and current Book contents synchronized. Saving the newer queued hierarchy change.',
        'pending',
      );
      startBookHierarchySave(state, pendingHierarchy);
      return true;
    }
    if (editorMatchesCanonical && !pendingHierarchy) {
      removeBookHierarchyRetry(state);
      state.reconciling = false;
      state.desiredHierarchy = JSON.parse(JSON.stringify(replacement.hierarchy));
      syncBookHierarchyInput(state);
      state.form.removeAttribute?.('aria-busy');
      setBookHierarchyStatus(state, 'Book hierarchy saved.', 'saved');
      return true;
    }
  }

  const published = publishBookHierarchyEditor(state, replacement);
  if (!published) {
    const currentDetail = state.editor.ownerDocument
      ?.querySelector?.('[data-book-detail-live-region]');
    if (previousDetail && currentDetail && currentDetail !== previousDetail) {
      currentDetail.replaceWith?.(previousDetail);
    }
    showBookHierarchyReconciliationFailure(state, retry, failureMessage);
    return false;
  }

  removeBookHierarchyRetry(state);
  if (published.kind === 'empty') {
    state.form.removeAttribute?.('aria-busy');
    setBookHierarchyStatus(
      state,
      pendingHierarchy
        ? 'Book hierarchy saved and current Book contents synchronized. A newer queued hierarchy change was not applied because the Book contents changed; make the move again if it is still wanted.'
        : 'Book hierarchy saved.',
      pendingHierarchy ? 'error' : 'saved',
    );
    focusBookHierarchyDialog(state);
    return true;
  }

  const nextState = published.state;
  if (pendingHierarchy && sameBookHierarchyMembership(pendingHierarchy, replacement.hierarchy)
    && applyBookHierarchy(nextState, pendingHierarchy)) {
    syncBookHierarchyInput(nextState);
    setBookHierarchyStatus(
      nextState,
      'Book hierarchy saved and current Book contents synchronized. Saving the newer queued hierarchy change.',
      'pending',
    );
    startBookHierarchySave(nextState, pendingHierarchy);
    return true;
  }

  nextState.form.removeAttribute?.('aria-busy');
  if (pendingHierarchy) {
    setBookHierarchyStatus(
      nextState,
      'Book hierarchy saved and current Book contents synchronized. A newer queued hierarchy change was not applied because the Book contents changed; make the move again if it is still wanted.',
      'error',
    );
  } else {
    setBookHierarchyStatus(nextState, 'Book hierarchy saved.', 'saved');
  }
  return true;
}

function finishBookHierarchyUncertain(state) {
  if (!state.pendingUncertainHierarchy) {
    state.pendingUncertainHierarchy = state.queuedHierarchy
      ? JSON.parse(JSON.stringify(state.queuedHierarchy))
      : null;
  }
  state.saving = false;
  state.activeHierarchy = null;
  state.queuedHierarchy = null;
  void reconcileUncertainBookHierarchy(state);
}

function definiteBookHierarchyRejection(response, payload) {
  return Boolean(
    response && !response.ok && payload?.status === 'error'
      && ['HIERARCHY_STALE', 'HIERARCHY_INVALID'].includes(payload?.code)
      && Array.isArray(payload?.hierarchy),
  );
}

async function reconcileRejectedBookHierarchy(state, pendingHierarchy, message) {
  state.reconciling = true;
  state.saving = false;
  state.activeHierarchy = null;
  state.queuedHierarchy = null;
  state.form.setAttribute?.('aria-busy', 'true');
  finishBookHierarchyDrag(state);
  setBookHierarchyStatus(state, `${message} Synchronizing current Book contents.`, 'reconciling');
  const retry = () => reconcileRejectedBookHierarchy(state, pendingHierarchy, message);
  const failureMessage = `${message} Current hierarchy could not be synchronized.`;
  const generation = state.beginDetailRefresh(state.editor.ownerDocument);
  const replacement = generation === null
    ? null
    : await state.fetchAuthority(state, null);
  if (!replacement) {
    showBookHierarchyReconciliationFailure(state, retry, failureMessage);
    return false;
  }

  const previousDetail = state.editor.ownerDocument
    ?.querySelector?.('[data-book-detail-live-region]') || null;
  if (!replacement.replacementDetail
    || state.installDetail(
      state.editor.ownerDocument,
      replacement.destination,
      generation,
      replacement.replacementDetail,
    ) !== 'installed') {
    showBookHierarchyReconciliationFailure(state, retry, failureMessage);
    return false;
  }

  if (replacement.kind === 'active'
    && sameBookHierarchyMembership(state.acknowledgedHierarchy, replacement.hierarchy)) {
    state.expected = JSON.parse(JSON.stringify(replacement.hierarchy));
    state.acknowledgedHierarchy = JSON.parse(JSON.stringify(replacement.hierarchy));
    removeBookHierarchyRetry(state);
    if (pendingHierarchy && sameBookHierarchyMembership(pendingHierarchy, replacement.hierarchy)
      && applyBookHierarchy(state, pendingHierarchy)) {
      state.reconciling = false;
      syncBookHierarchyInput(state);
      setBookHierarchyStatus(
        state,
        `${message} Current hierarchy synchronized. Saving the newer queued hierarchy change.`,
        'pending',
      );
      startBookHierarchySave(state, pendingHierarchy);
      return true;
    }
    if (!pendingHierarchy
      && (sameBookHierarchy(serializeBookHierarchy(state.editor), replacement.hierarchy)
        || applyBookHierarchy(state, replacement.hierarchy))) {
      state.reconciling = false;
      state.desiredHierarchy = JSON.parse(JSON.stringify(replacement.hierarchy));
      syncBookHierarchyInput(state);
      state.form.removeAttribute?.('aria-busy');
      setBookHierarchyStatus(state, `${message} Current hierarchy synchronized.`, 'error');
      return true;
    }
  }

  const published = publishBookHierarchyEditor(state, replacement);
  if (!published) {
    const currentDetail = state.editor.ownerDocument
      ?.querySelector?.('[data-book-detail-live-region]');
    if (previousDetail && currentDetail && currentDetail !== previousDetail) {
      currentDetail.replaceWith?.(previousDetail);
    }
    showBookHierarchyReconciliationFailure(state, retry, failureMessage);
    return false;
  }

  removeBookHierarchyRetry(state);
  if (published.kind === 'empty') {
    state.form.removeAttribute?.('aria-busy');
    setBookHierarchyStatus(
      state,
      pendingHierarchy
        ? `${message} Current hierarchy synchronized. A newer queued hierarchy change was not applied because the Book contents changed; make the move again if it is still wanted.`
        : `${message} Current hierarchy synchronized.`,
      pendingHierarchy ? 'error' : 'saved',
    );
    focusBookHierarchyDialog(state);
    return true;
  }
  const nextState = published.state;
  if (pendingHierarchy && sameBookHierarchyMembership(pendingHierarchy, replacement.hierarchy)
    && applyBookHierarchy(nextState, pendingHierarchy)) {
    syncBookHierarchyInput(nextState);
    setBookHierarchyStatus(
      nextState,
      `${message} Current hierarchy synchronized. Saving the newer queued hierarchy change.`,
      'pending',
    );
    startBookHierarchySave(nextState, pendingHierarchy);
    return true;
  }

  nextState.form.removeAttribute?.('aria-busy');
  setBookHierarchyStatus(
    nextState,
    pendingHierarchy
      ? `${message} Current hierarchy synchronized. A newer queued hierarchy change was not applied because the Book contents changed; make the move again if it is still wanted.`
      : `${message} Current hierarchy synchronized.`,
    'error',
  );
  return true;
}

function finishBookHierarchyFailure(state, payload) {
  const pendingHierarchy = state.queuedHierarchy
    ? JSON.parse(JSON.stringify(state.queuedHierarchy))
    : null;
  state.reconciling = true;
  state.saving = false;
  state.activeHierarchy = null;
  state.queuedHierarchy = null;
  finishBookHierarchyDrag(state);
  const message = payload?.message
    || 'The Book hierarchy change was rejected.';
  void reconcileRejectedBookHierarchy(state, pendingHierarchy, message);
}

function startBookHierarchySave(state, target) {
  const expected = JSON.parse(JSON.stringify(state.expected));
  const activeTarget = JSON.parse(JSON.stringify(target));
  const submission = { version: 1, expected, target: activeTarget };
  state.saving = true;
  state.activeHierarchy = activeTarget;
  state.input.value = JSON.stringify(submission);
  state.form.setAttribute?.('aria-busy', 'true');
  setBookHierarchyStatus(state, 'Saving Book hierarchy.', 'pending');

  let request;
  try {
    if (typeof globalThis.fetch !== 'function' || typeof globalThis.FormData !== 'function'
      || typeof globalThis.URLSearchParams !== 'function') {
      throw new Error('Immediate Book hierarchy persistence is unavailable.');
    }
    const body = new globalThis.URLSearchParams(new globalThis.FormData(state.form));
    body.set('hierarchy', JSON.stringify(submission));
    request = globalThis.fetch(state.form.action || state.form.getAttribute?.('action'), {
      method: String(state.form.method || state.form.getAttribute?.('method') || 'POST').toUpperCase(),
      body,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      },
      credentials: 'same-origin',
      redirect: 'error',
    });
  } catch (error) {
    request = Promise.reject(error);
  }

  Promise.resolve(request).then(async (response) => {
    const payload = await readBookReorderResponse(response);
    const authority = bookHierarchyResponseAuthority(payload, state);
    if (definiteBookHierarchyRejection(response, payload)) {
      finishBookHierarchyFailure(state, payload);
      return;
    }
    if (!response?.ok || payload?.status !== 'success' || !authority
      || !sameBookHierarchy(authority, activeTarget)) {
      finishBookHierarchyUncertain(state);
      return;
    }

    state.expected = JSON.parse(JSON.stringify(authority));
    state.acknowledgedHierarchy = JSON.parse(JSON.stringify(authority));
    const next = state.queuedHierarchy && !sameBookHierarchy(state.queuedHierarchy, authority)
      ? JSON.parse(JSON.stringify(state.queuedHierarchy))
      : null;
    void synchronizeAcknowledgedBookHierarchy(state, next);
  }).catch(() => finishBookHierarchyUncertain(state));
}

function queueBookHierarchySave(state) {
  if (state.retired || state.reconciling) return;
  const desired = serializeBookHierarchy(state.editor);
  if (!desired) return;
  state.desiredHierarchy = JSON.parse(JSON.stringify(desired));
  syncBookHierarchyInput(state);
  if (state.saving) {
    state.queuedHierarchy = sameBookHierarchy(desired, state.activeHierarchy)
      ? null
      : JSON.parse(JSON.stringify(desired));
    return;
  }
  if (sameBookHierarchy(desired, state.acknowledgedHierarchy)) return;
  startBookHierarchySave(state, desired);
}

export function enhanceBookHierarchyReorder(scope = globalThis.document, options = {}) {
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
    const refreshUrlMatch = String(form.action || form.getAttribute?.('action') || '')
      .match(/^(.*\/notes\/books\/[1-9]\d*)\/hierarchy\/reorder(?:[?#].*)?$/);

    const state = {
      editor,
      form,
      input: inputs[0],
      expected: JSON.parse(JSON.stringify(payload.expected)),
      desiredHierarchy: JSON.parse(JSON.stringify(loadedTarget)),
      acknowledgedHierarchy: JSON.parse(JSON.stringify(payload.expected)),
      activeHierarchy: null,
      queuedHierarchy: null,
      pendingUncertainHierarchy: null,
      saving: false,
      reconciling: false,
      retired: false,
      refreshUrl: refreshUrlMatch?.[1] || '',
      beginDetailRefresh: options.beginDetailRefresh || beginBookDetailDefaultsLiveRefresh,
      refreshDetail: options.refreshDetail || refreshBookDetailLiveRegion,
      installDetail: options.installDetail || installBookDetailLiveRegionSnapshot,
      fetchAuthority: options.fetchAuthority || fetchBookHierarchyEditorFromServer,
      items: new Map(Array.from(editor.querySelectorAll?.(BOOK_HIERARCHY_ITEM_SELECTOR) || [])
        .map((item) => [item.dataset?.contentKey || item.getAttribute?.('data-content-key'), item])),
      containers: new Map(containers.map((container) => [bookHierarchyContainerKey(container), container])),
      live: editor.querySelector?.(BOOK_HIERARCHY_LIVE_SELECTOR),
      status: form.querySelector?.('[data-book-hierarchy-status]'),
      draggedItem: null,
      sourceContainer: null,
      dropContainer: null,
      dropTarget: null,
      dropItem: null,
      dropBefore: null,
    };

    editor.__creatorCrateBookHierarchyState = state;

    markEnhancementBound(editor, 'bookHierarchyReorderBound');
    updateBookHierarchyMetadata(editor);
    syncBookHierarchyInput(state);

    editor.addEventListener?.('dragstart', (event) => {
      if (state.reconciling || state.retired) {
        event.preventDefault?.();
        finishBookHierarchyDrag(state);
        return;
      }
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
      if (state.reconciling || state.retired) {
        finishBookHierarchyDrag(state);
        return;
      }
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
      if (state.reconciling || state.retired) {
        event.preventDefault?.();
        finishBookHierarchyDrag(state);
        return;
      }
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
        queueBookHierarchySave(state);
      }
    });

    editor.addEventListener?.('dragend', () => finishBookHierarchyDrag(state));
    editor.addEventListener?.('keydown', (event) => {
      if (event.key === 'Escape' && state.draggedItem) {
        finishBookHierarchyDrag(state);
        return;
      }
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      if (state.reconciling || state.retired) {
        event.preventDefault?.();
        finishBookHierarchyDrag(state);
        return;
      }
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
    form.addEventListener?.('submit', (event) => {
      event.preventDefault?.();
      if (state.reconciling || state.retired) return;
      syncBookHierarchyInput(state);
      queueBookHierarchySave(state);
    });
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
    config.onInitialize?.(state);

    form.addEventListener?.('submit', (event) => {
      if (config.isBusy?.(state)) {
        event.preventDefault?.();
        return;
      }
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
        if (config.isBusy?.(state) || !canStartDedicatedReorderDrag(item, { target }, config)) {
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
        if (config.isBusy?.(state)) return;
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
          config.onOrderChange?.({ item, keyboard: true, state });
        }
      });
    });

    list.addEventListener?.('dragover', (event) => {
      if (config.isBusy?.(state)) {
        finishDedicatedDrag(state);
        return;
      }
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
      if (config.isBusy?.(state)) {
        event.preventDefault?.();
        finishDedicatedDrag(state);
        return;
      }
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
        config.onOrderChange?.({ item: draggedItem, keyboard: false, state });
      }
    });
  });

  return lists.length;
}

function setBookReorderStatus(state, message, status) {
  state.form.setAttribute?.('data-book-reorder-state', status);
  const dialog = state.form.closest?.(APP_DIALOG_SELECTOR);
  if (status === 'error') dialog?.setAttribute?.('data-dialog-state', 'error');
  else dialog?.removeAttribute?.('data-dialog-state');
  if (!state.status) return;
  state.status.setAttribute?.('role', status === 'error' ? 'alert' : 'status');
  state.status.textContent = message;
}

function bookReorderResponseOrder(payload) {
  if (!Array.isArray(payload?.orderedBookIds)) return null;
  const ids = payload.orderedBookIds.map((id) => String(id));
  return ids.every((id) => /^[1-9]\d*$/.test(id)) && new Set(ids).size === ids.length ? ids : null;
}

function renderedBookShelfOrder(document) {
  const region = document?.querySelector?.('[data-notes-books-live-region]');
  if (!region) return null;
  const links = Array.from(region?.querySelectorAll?.('.notes-book-card-title a[href]') || []);
  const ids = links.map((link) => {
    const match = String(link.getAttribute?.('href') || '').match(/^\/notes\/books\/([1-9]\d*)(?:[?#].*)?$/);
    return match?.[1] || null;
  });
  if (ids.some((id) => id === null) || new Set(ids).size !== ids.length) return null;
  return ids;
}

function sameDedicatedReorderMembership(left, right) {
  return left.length === right.length && left.every((id) => right.includes(id));
}

function bookReorderRenderedOrder(list, config) {
  if (!list) return null;
  const ids = dedicatedReorderOrder(list, config);
  return ids.length === dedicatedReorderItems(list, config).length
    && ids.every((id) => /^[1-9]\d*$/.test(id))
    && new Set(ids).size === ids.length
    ? ids
    : null;
}

function isEmptyBookReorderAuthority(replacementShelf, replacementForm, config) {
  const shelfEmptyState = replacementShelf?.querySelector?.('.empty-state');
  const editorRegion = replacementForm?.querySelector?.('[data-notes-book-order-page]');
  const editorEmptyState = editorRegion?.querySelector?.('.empty-state');
  const shelfOrder = renderedBookShelfOrder(replacementShelf?.ownerDocument);
  return Array.isArray(shelfOrder)
    && shelfOrder.length === 0
    && shelfEmptyState?.querySelector?.('.empty-state-heading')?.textContent?.trim() === 'No books yet'
    && replacementShelf.querySelectorAll?.('.notes-book-card-title a[href]').length === 0
    && editorEmptyState?.querySelector?.('.empty-state-heading')?.textContent?.trim() === 'No books yet'
    && replacementForm.querySelectorAll?.(config.listSelector).length === 0
    && replacementForm.querySelectorAll?.(config.itemSelector).length === 0
    && replacementForm.querySelectorAll?.(config.handleSelector).length === 0
    && replacementForm.querySelectorAll?.(config.inputSelector).length === 0;
}

async function fetchBookReorderAuthority(state, config) {
  const document = state.list.ownerDocument;
  const generation = state.beginShelfRefresh(document);
  const Parser = document?.defaultView?.DOMParser || globalThis.DOMParser;
  if (generation === null || typeof globalThis.fetch !== 'function' || typeof Parser !== 'function') return null;

  try {
    const response = await globalThis.fetch('/notes', {
      method: 'GET',
      headers: { Accept: 'text/html' },
      credentials: 'same-origin',
      redirect: 'error',
    });
    if (!response?.ok || typeof response.text !== 'function') return null;
    const parsed = new Parser().parseFromString(await response.text(), 'text/html');
    const replacementShelf = parsed?.querySelector?.('[data-notes-books-live-region]');
    const replacementForm = parsed?.querySelector?.('[data-book-reorder-form]');
    const replacementList = replacementForm?.querySelector?.(config.listSelector);
    const replacementInput = replacementForm?.querySelector?.(config.inputSelector);
    const replacementItems = dedicatedReorderItems(replacementList, config);
    const shelfOrder = renderedBookShelfOrder(parsed);
    const editorOrder = bookReorderRenderedOrder(replacementList, config);
    const serializedOrder = String(replacementInput?.value || '')
      .split(',');
    if (!replacementShelf || !replacementForm) return null;
    if (isEmptyBookReorderAuthority(replacementShelf, replacementForm, config)) {
      return {
        kind: 'empty',
        generation,
        replacementShelf,
        replacementForm,
        authority: [],
      };
    }
    if (!replacementList || !replacementInput
      || replacementItems.some((item) => !item.querySelector?.(config.handleSelector))
      || !shelfOrder || !editorOrder
      || !sameDedicatedReorder(shelfOrder, editorOrder)
      || !sameDedicatedReorder(serializedOrder, editorOrder)) return null;
    return {
      kind: 'active',
      generation,
      replacementShelf,
      replacementForm,
      authority: editorOrder,
    };
  } catch {
    return null;
  }
}

function removeBookReorderRetry(state) {
  state.retryButton?.remove?.();
  state.retryButton = null;
}

function focusBookReorderRecovery(state, form = state.form) {
  const dialog = form?.closest?.(APP_DIALOG_SELECTOR) || state.form.closest?.(APP_DIALOG_SELECTOR);
  const dialogState = dialog?.__creatorCrateAppDialogState;
  if (!dialog || (dialog.open !== true && dialogState?.open !== true)) return;
  const target = form?.querySelector?.(BOOK_REORDER_HANDLE_SELECTOR)
    || dialog?.querySelector?.('[data-dialog-close]');
  target?.focus?.({ preventScroll: true });
}

function showBookReorderRecoveryFailure(state, message, retry) {
  state.form.setAttribute?.('aria-busy', 'true');
  setBookReorderStatus(
    state,
    `${message} Book order could not be refreshed. Reordering remains blocked. Retry reconciliation to continue.`,
    'error',
  );
  removeBookReorderRetry(state);
  const button = state.list.ownerDocument?.createElement?.('button');
  if (!button || !state.status) {
    focusBookReorderRecovery(state);
    return;
  }
  button.type = 'button';
  button.className = 'button button-secondary';
  button.setAttribute?.('data-book-reorder-reconciliation-retry', '');
  button.textContent = 'Retry reconciliation';
  button.addEventListener?.('click', () => {
    if (state.recoveryInFlight) return;
    removeBookReorderRetry(state);
    void retry();
  });
  state.status.appendChild?.(button);
  state.retryButton = button;
  if (isBookReorderDialogActive(state)) button.focus?.({ preventScroll: true });
}

function publishBookReorderAuthority(state, config, replacement) {
  const parent = state.form.parentNode;
  const dialog = state.form.closest?.(APP_DIALOG_SELECTOR);
  if (!parent || !dialog || !replacement?.replacementForm) return null;
  const canReplaceForm = typeof state.form.replaceWith === 'function'
    || typeof parent.replaceChild === 'function';
  if (!canReplaceForm) return null;

  let nextState = null;
  if (replacement.kind !== 'empty') {
    state.enhanceFresh(replacement.replacementForm, state.recoveryOptions);
    const replacementList = replacement.replacementForm.querySelector?.(config.listSelector);
    nextState = replacementList?.__creatorCrateBookReorderState || null;
    if (!nextState || !sameDedicatedReorder(nextState.acknowledgedIds, replacement.authority)) return null;
  }

  if (state.installShelf(
    state.list.ownerDocument,
    replacement.generation,
    replacement.replacementShelf,
  ) !== 'installed') return null;

  if (typeof state.form.replaceWith === 'function') state.form.replaceWith(replacement.replacementForm);
  else if (typeof parent.replaceChild === 'function') parent.replaceChild(replacement.replacementForm, state.form);
  else return null;
  if (dialog.__creatorCrateAppDialogState) {
    dialog.__creatorCrateAppDialogState.form = replacement.replacementForm;
  }
  if (replacement.kind === 'empty') {
    state.acknowledgedIds = [];
    state.activeIds = null;
    state.queuedIds = null;
    state.saving = false;
    state.reconciling = false;
    replacement.replacementForm.removeAttribute?.('aria-busy');
    focusBookReorderRecovery(state, replacement.replacementForm);
    return { kind: 'empty', state: null };
  }
  focusBookReorderRecovery(state, replacement.replacementForm);
  return { kind: 'active', state: nextState };
}

async function reconcileChangedBookMembership(state, config, pendingIds, message) {
  if (state.recoveryInFlight) return false;
  state.retired = true;
  state.reconciling = true;
  state.recoveryInFlight = true;
  state.form.setAttribute?.('aria-busy', 'true');
  finishDedicatedDrag(state);
  removeBookReorderRetry(state);
  const contextMessage = pendingIds
    ? `${message} The pending local reorder was not applied because the Book list changed.`
    : `${message} The Book list changed.`;
  setBookReorderStatus(state, `${contextMessage} Restoring current Book order.`, 'reconciling');

  const replacement = await state.fetchAuthority(state, config);
  state.recoveryInFlight = false;
  const published = replacement && publishBookReorderAuthority(state, config, replacement);
  if (!published) {
    showBookReorderRecoveryFailure(
      state,
      contextMessage,
      () => reconcileChangedBookMembership(state, config, null, 'Retrying reconciliation.'),
    );
    return false;
  }
  if (published.kind === 'empty') {
    const status = replacement.replacementForm.querySelector?.('[data-book-reorder-status]');
    if (status) {
      status.setAttribute?.('role', 'status');
      status.textContent = `${contextMessage} Current Book order restored.`;
    }
    focusBookReorderRecovery(state, replacement.replacementForm);
  }
  return true;
}

async function reconcileUncertainBookReorder(state, config, pendingIds, message) {
  if (state.recoveryInFlight) return false;
  const mountedIds = dedicatedReorderOrder(state.list, config);
  state.retired = true;
  state.reconciling = true;
  state.recoveryInFlight = true;
  state.form.setAttribute?.('aria-busy', 'true');
  finishDedicatedDrag(state);
  removeBookReorderRetry(state);
  setBookReorderStatus(state, `${message} Restoring current Book order.`, 'reconciling');

  const replacement = await state.fetchAuthority(state, config);
  state.recoveryInFlight = false;
  const membershipChanged = replacement
    ? !sameDedicatedReorderMembership(replacement.authority, mountedIds)
    : false;
  const contextMessage = membershipChanged && pendingIds
    ? `${message} The pending local reorder was not applied because the Book list changed.`
    : membershipChanged
      ? `${message} The Book list changed.`
      : message;
  const published = replacement && publishBookReorderAuthority(state, config, replacement);
  if (!published) {
    showBookReorderRecoveryFailure(
      state,
      contextMessage,
      () => reconcileUncertainBookReorder(state, config, pendingIds, 'Retrying reconciliation.'),
    );
    return false;
  }

  if (published.kind === 'empty') {
    const status = replacement.replacementForm.querySelector?.('[data-book-reorder-status]');
    if (status) {
      status.setAttribute?.('role', 'status');
      status.textContent = `${contextMessage} Current Book order restored.`;
    }
    focusBookReorderRecovery(state, replacement.replacementForm);
    return true;
  }

  const nextState = published.state;
  if (membershipChanged) {
    setBookReorderStatus(nextState, `${contextMessage} Current Book order restored.`, 'error');
    return true;
  }
  if (pendingIds && !sameDedicatedReorder(pendingIds, replacement.authority)) {
    if (!sameDedicatedReorderMembership(pendingIds, replacement.authority)
      || !restoreDedicatedReorderOrder(nextState, pendingIds, config)) {
      setBookReorderStatus(
        nextState,
        `${message} The pending local reorder could not be restored.`,
        'error',
      );
      return true;
    }
    startBookReorderSave(
      nextState,
      config,
      state.recoveryOptions.refreshShelf,
      pendingIds,
    );
    return true;
  }
  nextState.form.removeAttribute?.('aria-busy');
  setBookReorderStatus(nextState, message, 'error');
  return true;
}

async function readBookReorderResponse(response) {
  if (typeof response?.json !== 'function') return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function isBookReorderDialogActive(state) {
  const dialog = state.form.closest?.(APP_DIALOG_SELECTOR);
  const dialogState = dialog?.__creatorCrateAppDialogState;
  return Boolean(dialog && (dialog.open === true || dialogState?.open === true));
}

function mountedBookReorderMatchesAuthority(state, config, authority) {
  const mountedOrder = bookReorderRenderedOrder(state.list, config);
  const input = state.form.querySelector?.(config.inputSelector);
  const serializedOrder = String(input?.value || '').split(',');
  return Boolean(input
    && mountedOrder
    && sameDedicatedReorder(mountedOrder, authority)
    && sameDedicatedReorder(serializedOrder, authority));
}

async function synchronizeBookReorderAfterMutation(
  state,
  config,
  refreshShelf,
  {
    message,
    status,
    pendingIds = null,
    retryMessage = 'Retrying synchronization.',
  },
) {
  if (state.recoveryInFlight) return false;

  const mountedIds = dedicatedReorderOrder(state.list, config);
  state.retired = true;
  state.reconciling = true;
  state.recoveryInFlight = true;
  state.form.setAttribute?.('aria-busy', 'true');
  finishDedicatedDrag(state);
  removeBookReorderRetry(state);

  const replacement = await state.fetchAuthority(state, config);
  state.recoveryInFlight = false;
  const membershipChanged = replacement
    ? !sameDedicatedReorderMembership(replacement.authority, mountedIds)
    : false;
  const contextMessage = membershipChanged && pendingIds
    ? `${message} The pending local reorder was not applied because the Book list changed.`
    : message;
  if (replacement?.kind === 'active'
    && mountedBookReorderMatchesAuthority(state, config, replacement.authority)) {
    if (state.installShelf(
      state.list.ownerDocument,
      replacement.generation,
      replacement.replacementShelf,
    ) !== 'installed') {
      showBookReorderRecoveryFailure(
        state,
        message,
        () => synchronizeBookReorderAfterMutation(state, config, refreshShelf, {
          message: retryMessage,
          status,
          pendingIds,
          retryMessage,
        }),
      );
      return false;
    }
    state.acknowledgedIds = [...replacement.authority];
    state.retired = false;
    state.reconciling = false;
    if (pendingIds && !sameDedicatedReorder(pendingIds, replacement.authority)) {
      if (sameDedicatedReorderMembership(pendingIds, replacement.authority)
        && restoreDedicatedReorderOrder(state, pendingIds, config)) {
        startBookReorderSave(state, config, refreshShelf, pendingIds);
        return true;
      }
      setBookReorderStatus(state, `${message} The pending local reorder could not be restored.`, 'error');
      return true;
    }
    state.form.removeAttribute?.('aria-busy');
    setBookReorderStatus(state, contextMessage, status);
    return true;
  }
  const published = replacement && publishBookReorderAuthority(state, config, replacement);
  if (!published) {
    showBookReorderRecoveryFailure(
      state,
      message,
      () => synchronizeBookReorderAfterMutation(state, config, refreshShelf, {
        message: retryMessage,
        status,
        pendingIds,
        retryMessage,
      }),
    );
    return false;
  }

  if (published.kind === 'empty') {
    const nextStatus = replacement.replacementForm.querySelector?.('[data-book-reorder-status]');
    if (nextStatus) {
      nextStatus.setAttribute?.('role', status === 'error' ? 'alert' : 'status');
      nextStatus.textContent = contextMessage;
    }
    return true;
  }

  const nextState = published.state;
  if (pendingIds && !membershipChanged && !sameDedicatedReorder(pendingIds, replacement.authority)) {
    if (sameDedicatedReorderMembership(pendingIds, replacement.authority)
      && restoreDedicatedReorderOrder(nextState, pendingIds, config)) {
      startBookReorderSave(nextState, config, refreshShelf, pendingIds);
      return true;
    }
    setBookReorderStatus(nextState, `${message} The pending local reorder could not be restored.`, 'error');
    return true;
  }

  nextState.form.removeAttribute?.('aria-busy');
  setBookReorderStatus(nextState, contextMessage, status);
  return true;
}

function reconcileBookReorderFailure(
  state,
  config,
  refreshShelf,
  pendingIds,
  message,
  controlledRejection,
) {
  if (!controlledRejection) {
    void reconcileUncertainBookReorder(state, config, pendingIds, message);
    return;
  }
  void synchronizeBookReorderAfterMutation(state, config, refreshShelf, {
    message,
    status: 'error',
    pendingIds,
    retryMessage: 'Retrying reconciliation.',
  });
}

function finishBookReorderFailure(state, config, refreshShelf, payload) {
  const responseAuthority = bookReorderResponseOrder(payload);
  const pendingIds = state.queuedIds ? [...state.queuedIds] : null;
  state.saving = false;
  state.activeIds = null;
  state.queuedIds = null;
  const message = payload?.message
    || (responseAuthority
      ? 'Could not update the book order. The server order was restored.'
      : 'The book order response was lost. The current server order was refreshed.');

  if (responseAuthority) {
    const mountedIds = dedicatedReorderOrder(state.list, config);
    if (!sameDedicatedReorderMembership(responseAuthority, mountedIds)) {
      void reconcileChangedBookMembership(state, config, pendingIds, message);
      return;
    }
    if (!restoreDedicatedReorderOrder(state, responseAuthority, config)) {
      reconcileBookReorderFailure(
        state,
        config,
        refreshShelf,
        pendingIds,
        message,
        true,
      );
      return;
    }

    state.acknowledgedIds = [...responseAuthority];
    void synchronizeBookReorderAfterMutation(state, config, refreshShelf, {
      message,
      status: 'error',
      pendingIds,
      retryMessage: 'Retrying synchronization.',
    });
    return;
  }

  reconcileBookReorderFailure(
    state,
    config,
    refreshShelf,
    pendingIds,
    message,
    false,
  );
}

function startBookReorderSave(state, config, refreshShelf, orderedIds) {
  if (state.retired) return;
  state.saving = true;
  state.activeIds = [...orderedIds];
  const input = state.form.querySelector?.(config.inputSelector);
  if (!input) {
    finishBookReorderFailure(state, config, refreshShelf, null);
    return;
  }

  input.value = orderedIds.join(',');
  state.form.setAttribute?.('aria-busy', 'true');
  setBookReorderStatus(state, 'Saving book order.', 'pending');

  Promise.resolve().then(() => {
    if (typeof globalThis.fetch !== 'function' || typeof globalThis.FormData !== 'function'
      || typeof globalThis.URLSearchParams !== 'function') {
      throw new Error('Immediate book reorder is unavailable.');
    }
    const action = state.form.action || state.form.getAttribute?.('action');
    const method = String(state.form.method || state.form.getAttribute?.('method') || 'POST').toUpperCase();
    return globalThis.fetch(action, {
      method,
      body: new globalThis.URLSearchParams(new globalThis.FormData(state.form)),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      },
      credentials: 'same-origin',
      redirect: 'error',
    });
  }).then(async (response) => {
    const payload = await readBookReorderResponse(response);
    const authority = bookReorderResponseOrder(payload);
    if (!response?.ok || payload?.status !== 'success' || !authority
      || !sameDedicatedReorder(authority, orderedIds)) {
      finishBookReorderFailure(state, config, refreshShelf, payload);
      return;
    }

    state.acknowledgedIds = [...authority];
    state.saving = false;
    state.activeIds = null;
    const next = state.queuedIds;
    state.queuedIds = null;
    if (next && !sameDedicatedReorder(next, state.acknowledgedIds)) {
      startBookReorderSave(state, config, refreshShelf, next);
      return;
    }

    state.form.removeAttribute?.('aria-busy');
    setBookReorderStatus(state, 'Book order saved.', 'saved');
    void synchronizeBookReorderAfterMutation(state, config, refreshShelf, {
      message: 'Book order saved.',
      status: 'saved',
      retryMessage: 'Book order was saved. Retrying synchronization.',
    });
  }).catch(() => finishBookReorderFailure(state, config, refreshShelf, null));
}

function queueBookReorderSave(state, config, refreshShelf) {
  if (state.reconciling || state.retired) return;
  const desiredIds = dedicatedReorderOrder(state.list, config);
  if (state.saving) {
    state.queuedIds = sameDedicatedReorder(desiredIds, state.activeIds) ? null : desiredIds;
    return;
  }
  if (sameDedicatedReorder(desiredIds, state.acknowledgedIds)) return;
  startBookReorderSave(state, config, refreshShelf, desiredIds);
}

export function enhanceBookReorder(scope = globalThis.document, options = {}) {
  const refreshShelf = options.refreshShelf || refreshNotesBooksLiveRegion;
  const config = {
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
    onInitialize(state) {
      state.status = state.form.querySelector?.('[data-book-reorder-status]')
        || scope.querySelector?.('[data-book-reorder-status]')
        || null;
      state.acknowledgedIds = dedicatedReorderOrder(state.list, config);
      state.activeIds = null;
      state.queuedIds = null;
      state.saving = false;
      state.reconciling = false;
      state.retired = false;
      state.recoveryInFlight = false;
      state.retryButton = null;
      state.beginShelfRefresh = options.beginShelfRefresh || beginNotesBooksLiveRefresh;
      state.installShelf = options.installShelf || installNotesBooksLiveRegionSnapshot;
      state.fetchAuthority = options.fetchAuthority || fetchBookReorderAuthority;
      state.enhanceFresh = options.enhanceFresh || enhanceBookReorder;
      state.recoveryOptions = {
        refreshShelf,
        beginShelfRefresh: state.beginShelfRefresh,
        installShelf: state.installShelf,
        fetchAuthority: state.fetchAuthority,
        enhanceFresh: state.enhanceFresh,
      };
      state.list.__creatorCrateBookReorderState = state;
    },
    isBusy(state) {
      return state.reconciling || state.retired;
    },
    onOrderChange({ state }) {
      queueBookReorderSave(state, config, refreshShelf);
    },
  };
  return enhanceDedicatedReorder(scope, config);
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
