import { isEnhancementBound, markEnhancementBound, setHidden } from './dom.js';

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

export const ASSET_SELECTION_FORM_SELECTOR = '[data-asset-selection-form]';
const ASSET_SELECTION_CHECKBOX_SELECTOR = 'input[type="checkbox"][name="selectedAssetIds"]:not(:disabled)';
const ASSET_CARD_SELECTOR = '[data-asset-selectable-card]';
const ASSET_CARD_INTERACTIVE_SELECTOR = [
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
  '.asset-tooltip',
  '.asset-icon-control',
].join(', ');
const ASSET_RENAME_TRIGGER_SELECTOR = '[data-asset-rename-trigger]';
const ASSET_RENAME_EDITOR_SELECTOR = '[data-asset-rename-editor]';

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

function getAssetSelectionControl(form, scope, selector) {
  const control = form.querySelector(selector);
  if (control) return control;

  const formId = form.id || form.getAttribute?.('id');
  if (!formId || typeof scope?.querySelectorAll !== 'function') return null;
  return Array.from(scope.querySelectorAll(selector)).find((candidate) => (
    candidate.form === form || candidate.getAttribute?.('form') === formId
  )) || null;
}

function updateAssetCardState(card, checked) {
  if (!card) return;
  card.classList?.toggle('is-selected', checked);
  card.setAttribute?.('aria-selected', String(checked));
  card.querySelector?.('.asset-selection-control')?.classList?.toggle('is-selected', checked);
}

export function updateAssetSelectionState(form, scope = form) {
  const checkboxes = getAssetSelectionCheckboxes(form, scope);
  const selectedCount = checkboxes.filter((checkbox) => checkbox.checked).length;

  const countEl = form.querySelector('[data-selected-count]')
    || form.closest?.('[data-asset-actions-panel]')?.querySelector?.('[data-selected-count]')
    || scope.querySelector?.('[data-selected-count]');
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

    const selectAllButton = getAssetSelectionControl(form, scope, '[data-select-all]');
    if (selectAllButton) {
      selectAllButton.addEventListener('click', () => {
        checkboxes.forEach((checkbox) => { checkbox.checked = true; });
        checkboxes.forEach((checkbox) => updateAssetCardState(checkbox.closest?.(ASSET_CARD_SELECTOR), true));
        updateAssetSelectionState(form, scope);
      });
    }

    const clearButton = getAssetSelectionControl(form, scope, '[data-clear-selection]');
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

    if (!isEnhancementBound(form, 'assetSelectionFormChangeBound')) {
      markEnhancementBound(form, 'assetSelectionFormChangeBound');
      form.addEventListener?.('change', () => updateAssetSelectionState(form, scope));
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
      if (interactive && interactive !== card && card.contains?.(interactive)) return;
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
