import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  enhanceAssetAutoRenameOrdering,
  enhanceAssetSelection,
} from '../src/static/creatorcrate.js';

function toDatasetKey(name) {
  return name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function makeNode({ tagName = 'div', attrs = {}, textContent = '', rect = null } = {}) {
  const listeners = [];
  const attributes = new Map();
  const children = [];
  const node = {
    tagName: tagName.toUpperCase(),
    dataset: {},
    children,
    parentElement: null,
    parentNode: null,
    ownerDocument: null,
    listeners,
    style: {
      overflowAnchor: '',
      left: '',
      top: '',
      width: '',
      height: '',
    },
    focusCalls: [],
    appendChildCalls: [],
    insertBeforeCalls: [],
    textContent,
    hidden: false,
    disabled: false,
    draggable: false,
    value: '',
    focused: false,
    classList: {
      values: new Set(),
      add(...names) { names.forEach((name) => this.values.add(name)); },
      remove(...names) { names.forEach((name) => this.values.delete(name)); },
      toggle(name, force) {
        const next = force === undefined ? !this.values.has(name) : force;
        if (next) this.values.add(name); else this.values.delete(name);
        return next;
      },
      contains(name) { return this.values.has(name); },
    },
    addEventListener(type, handler, options = {}) {
      listeners.push({ type, handler, capture: options === true || options?.capture === true });
    },
    setAttribute(name, value) {
      const stringValue = String(value);
      attributes.set(name, stringValue);
      if (name === 'hidden') this.hidden = true;
      if (name === 'disabled') this.disabled = true;
      if (name === 'draggable') this.draggable = stringValue === 'true';
      if (name.startsWith('data-')) this.dataset[toDatasetKey(name)] = stringValue;
    },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
    hasAttribute(name) { return attributes.has(name); },
    removeAttribute(name) {
      attributes.delete(name);
      if (name === 'hidden') this.hidden = false;
      if (name === 'disabled') this.disabled = false;
      if (name === 'draggable') this.draggable = false;
      if (name.startsWith('data-')) delete this.dataset[toDatasetKey(name)];
    },
    matches(selector) {
      return selector.split(',').some((part) => {
        const candidate = part.trim();
        const tag = candidate.match(/^[a-z][\w-]*/i)?.[0];
        if (tag && this.tagName !== tag.toUpperCase()) return false;
        const attrsInSelector = [...candidate.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)];
        return attrsInSelector.every(([, name, expected]) => {
          const actual = this.getAttribute(name);
          return actual !== null && (expected === undefined || actual === expected);
        });
      });
    },
    closest(selector) {
      let current = this;
      while (current) {
        if (current.matches(selector)) return current;
        current = current.parentElement;
      }
      return null;
    },
    contains(candidate) {
      let current = candidate;
      while (current) {
        if (current === this) return true;
        current = current.parentElement;
      }
      return false;
    },
    appendChild(child) {
      this.appendChildCalls.push(child);
      if (child.parentElement) {
        const previousIndex = child.parentElement.children.indexOf(child);
        if (previousIndex >= 0) child.parentElement.children.splice(previousIndex, 1);
      }
      children.push(child);
      child.parentElement = this;
      child.parentNode = this;
      const document = this.ownerDocument || (this.tagName === 'DOCUMENT' ? this : null);
      const adopt = (current) => {
        current.ownerDocument = document;
        current.children.forEach(adopt);
      };
      adopt(child);
      return child;
    },
    insertBefore(child, reference) {
      this.insertBeforeCalls.push({ child, reference });
      if (child.parentElement) {
        const previousIndex = child.parentElement.children.indexOf(child);
        if (previousIndex >= 0) child.parentElement.children.splice(previousIndex, 1);
      }
      const referenceIndex = reference ? children.indexOf(reference) : -1;
      children.splice(referenceIndex >= 0 ? referenceIndex : children.length, 0, child);
      child.parentElement = this;
      child.parentNode = this;
      const document = this.ownerDocument || (this.tagName === 'DOCUMENT' ? this : null);
      const adopt = (current) => {
        current.ownerDocument = document;
        current.children.forEach(adopt);
      };
      adopt(child);
      return child;
    },
    querySelectorAll(selector) {
      const descendants = [];
      const visit = (current) => {
        current.children.forEach((child) => {
          if (child.matches(selector)) descendants.push(child);
          visit(child);
        });
      };
      visit(this);
      return descendants;
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    getBoundingClientRect() { return rect || { top: 0, left: 0, width: 120, height: 40 }; },
    focus(options) {
      this.focusCalls.push(options);
      this.focused = true;
      if (this.ownerDocument) this.ownerDocument.activeElement = this;
    },
    dispatch(type, props = {}) {
      const event = {
        type,
        target: props.target || this,
        currentTarget: null,
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this.propagationStopped = true; },
        ...props,
      };
      const path = [];
      let current = this;
      while (current) {
        path.push(current);
        current = current.parentElement;
      }
      for (let index = path.length - 1; index >= 0 && !event.propagationStopped; index -= 1) {
        current = path[index];
        event.currentTarget = current;
        current.listeners
          .filter((listener) => listener.type === type && listener.capture)
          .forEach((listener) => listener.handler(event));
      }
      for (let index = 0; index < path.length && !event.propagationStopped; index += 1) {
        current = path[index];
        event.currentTarget = current;
        current.listeners
          .filter((listener) => listener.type === type && !listener.capture)
          .forEach((listener) => listener.handler(event));
      }
      return event;
    },
  };

  Object.entries(attrs).forEach(([name, value]) => node.setAttribute(name, value));
  return node;
}

function dataTransfer() {
  return {
    effectAllowed: '',
    dropEffect: '',
    values: new Map(),
    setData(type, value) { this.values.set(type, value); },
  };
}

function makeAssetPage({ view = 'list', ids = [1, 2, 3], initialOrder = ids } = {}) {
  const document = makeNode({ tagName: 'document' });
  document.ownerDocument = document;
  document.activeElement = null;
  document.body = null;
  document.createElement = (tagName) => makeNode({ tagName });
  const surface = makeNode({ attrs: {
    'data-auto-rename-surface': '',
    'data-auto-rename-view': view,
  }, rect: view === 'grid'
    ? { top: 0, left: 0, width: 400, height: 500 }
    : { top: 0, left: 0, width: 500, height: 500 } });
  const form = makeNode({ tagName: 'form', attrs: { 'data-auto-rename-form': '' } });
  const selectionForm = makeNode({ tagName: 'form', attrs: {
    id: 'bulk-select-form',
    'data-asset-selection-form': '',
  } });
  const selectAll = makeNode({ tagName: 'button', attrs: { type: 'button', 'data-select-all': '' } });
  const clearSelection = makeNode({ tagName: 'button', attrs: { type: 'button', 'data-clear-selection': '' } });
  const orderInput = makeNode({ tagName: 'input', attrs: { 'data-auto-rename-order-input': '' } });
  orderInput.value = JSON.stringify(initialOrder);
  const submit = makeNode({ tagName: 'button', attrs: {
    type: 'submit',
    'data-auto-rename-submit': '',
    disabled: '',
  } });
  const live = makeNode({ attrs: { 'data-auto-rename-live': '', 'aria-live': 'polite' } });
  const list = makeNode({ tagName: view === 'grid' ? 'ul' : 'tbody' });
  const assets = [];

  form.appendChild(orderInput);
  form.appendChild(submit);
  form.appendChild(live);
  selectionForm.appendChild(selectAll);
  selectionForm.appendChild(clearSelection);
  surface.appendChild(form);
  surface.appendChild(selectionForm);
  surface.appendChild(list);
  document.appendChild(surface);

  ids.forEach((id, position) => {
     const item = makeNode({
      tagName: view === 'grid' ? 'li' : 'tr',
      attrs: {
        'data-auto-rename-asset': '',
        'data-auto-rename-asset-id': String(id),
        'data-auto-rename-initial-index': String(position),
        draggable: 'true',
        tabindex: '0',
        'aria-grabbed': 'false',
        'aria-label': `Reorder Asset ${id}`,
        'aria-posinset': String(position + 1),
        'aria-setsize': String(ids.length),
      },
       rect: view === 'grid'
         ? { top: Math.floor(position / 3) * 130, left: (position % 3) * 140, width: 120, height: 100 }
         : { top: position * 50, left: 0, width: 500, height: 40 },
     });
     item.getBoundingClientRect = () => {
       const currentIndex = list.children.indexOf(item);
       const index = currentIndex >= 0 ? currentIndex : position;
       return view === 'grid'
         ? {
           top: Math.floor(index / 3) * 130,
           left: (index % 3) * 140,
           width: 120,
           height: 100,
         }
         : { top: index * 50, left: 0, width: 500, height: 40 };
     };
    const indicator = makeNode({ attrs: { 'data-auto-rename-order-indicator': '' } });
     const checkbox = makeNode({ tagName: 'input', attrs: {
       type: 'checkbox',
       form: 'bulk-select-form',
       name: 'selectedAssetIds',
       'aria-label': `Select Asset ${id}`,
     } });
     checkbox.form = selectionForm;
    const filenameLink = makeNode({ tagName: 'a', attrs: { href: `/assets/${id}` } });
    const image = makeNode({ tagName: 'img', attrs: { 'data-preview-image': '' } });
    const fallback = makeNode({ tagName: 'span', attrs: { 'data-preview-fallback': '' } });
    const renameForm = makeNode({ tagName: 'form' });
    const renameInput = makeNode({ tagName: 'input', attrs: { type: 'text', name: 'filename' } });
    const unrelatedButton = makeNode({ tagName: 'button', attrs: { type: 'submit' } });
    renameForm.appendChild(renameInput);
    renameForm.appendChild(unrelatedButton);
    let preview;
    let previewLink;
    let body = null;

    if (view === 'grid') {
      const card = makeNode({ tagName: 'article', attrs: { class: 'asset-card', 'data-asset-selectable-card': '' } });
      const cardTop = makeNode({ tagName: 'div', attrs: { class: 'asset-card-top' } });
      const selection = makeNode({ tagName: 'label', attrs: { class: 'asset-selection-control' } });
      selection.appendChild(checkbox);
      cardTop.appendChild(selection);
      cardTop.appendChild(indicator);
      cardTop.appendChild(makeNode({ tagName: 'a', attrs: { href: `/assets/${id}` } }));

      const media = makeNode({ tagName: 'div', attrs: { class: 'asset-card-media', 'data-preview-enhancement': '' } });
      previewLink = makeNode({ tagName: 'a', attrs: { href: `/assets/${id}` } });
      previewLink.appendChild(image);
      media.appendChild(previewLink);
      media.appendChild(fallback);
      preview = media;

      body = makeNode({ tagName: 'div', attrs: { class: 'asset-card-body' } });
      const titleRow = makeNode({ tagName: 'div', attrs: { class: 'asset-card-title-row' } });
      titleRow.appendChild(filenameLink);
      body.appendChild(titleRow);
      body.appendChild(renameForm);

      card.appendChild(cardTop);
      card.appendChild(media);
      card.appendChild(body);
      item.appendChild(card);
    } else {
      const selectCell = makeNode({ tagName: 'td', attrs: { class: 'asset-select-cell' } });
      selectCell.appendChild(checkbox);
      const orderCell = makeNode({ tagName: 'td', attrs: { class: 'asset-auto-rename-order-cell' } });
      orderCell.appendChild(indicator);
      const thumbCell = makeNode({ tagName: 'td', attrs: { class: 'asset-thumb-cell' } });
      previewLink = makeNode({ tagName: 'a', attrs: { href: `/assets/${id}` } });
      preview = makeNode({ tagName: 'span', attrs: { 'data-preview-enhancement': '' } });
      preview.appendChild(image);
      preview.appendChild(fallback);
      previewLink.appendChild(preview);
      thumbCell.appendChild(previewLink);
      const fileCell = makeNode({ tagName: 'td', attrs: { class: 'asset-file-cell' } });
      fileCell.appendChild(filenameLink);
      const actionCell = makeNode({ tagName: 'td', attrs: { class: 'asset-actions-cell' } });
      actionCell.appendChild(renameForm);

      item.appendChild(selectCell);
      item.appendChild(orderCell);
      item.appendChild(thumbCell);
      item.appendChild(fileCell);
      item.appendChild(actionCell);
    }

    const countNavigation = (event) => {
      if (!event.defaultPrevented) filenameLink.navigationCount = (filenameLink.navigationCount || 0) + 1;
    };
    const countPreviewNavigation = (event) => {
      if (!event.defaultPrevented) previewLink.navigationCount = (previewLink.navigationCount || 0) + 1;
    };
    filenameLink.addEventListener('click', countNavigation);
    previewLink.addEventListener('click', countPreviewNavigation);
    list.appendChild(item);
    assets.push({ item, indicator, checkbox, link: filenameLink, filenameLink, previewLink, unrelatedButton, renameInput, preview, fallback, image, body });
  });

  return {
    document,
    surface,
    form,
    selectionForm,
    selectAll,
    clearSelection,
    orderInput,
    submit,
    live,
    list,
    assets,
     order() { return list.querySelectorAll('[data-auto-rename-asset]').map((item) => item.getAttribute('data-auto-rename-asset-id')); },
     marker() { return surface.querySelector('[data-auto-rename-order-marker]'); },
  };
}

function dragTo(page, sourceIndex, { clientX = 0, clientY = 0 } = {}) {
  const transfer = dataTransfer();
  const source = page.assets[sourceIndex];
  source.preview.dispatch('dragstart', { dataTransfer: transfer });
  const over = page.surface.dispatch('dragover', {
    target: page.surface,
    clientX,
    clientY,
    dataTransfer: transfer,
  });
  const marker = page.marker();
  const markerSlot = Number(marker.getAttribute('data-auto-rename-insertion-index'));
  const markerGeometry = {
    left: Number.parseFloat(marker.style.left),
    top: Number.parseFloat(marker.style.top),
    width: Number.parseFloat(marker.style.width),
    height: Number.parseFloat(marker.style.height),
  };
  page.surface.dispatch('drop', {
    target: page.surface,
    clientX,
    clientY,
    dataTransfer: transfer,
  });
  return { over, markerSlot, markerGeometry };
}

function withViewport(callback) {
  const hadScrollX = Object.prototype.hasOwnProperty.call(globalThis, 'scrollX');
  const hadScrollY = Object.prototype.hasOwnProperty.call(globalThis, 'scrollY');
  const hadScrollTo = Object.prototype.hasOwnProperty.call(globalThis, 'scrollTo');
  const previousScrollX = globalThis.scrollX;
  const previousScrollY = globalThis.scrollY;
  const previousScrollTo = globalThis.scrollTo;
  const scrollCalls = [];
  globalThis.scrollX = 17;
  globalThis.scrollY = 1400;
  globalThis.scrollTo = (x, y) => {
    scrollCalls.push([x, y]);
    globalThis.scrollX = x;
    globalThis.scrollY = y;
  };
  try {
    return callback(scrollCalls);
  } finally {
    if (hadScrollX) globalThis.scrollX = previousScrollX;
    else delete globalThis.scrollX;
    if (hadScrollY) globalThis.scrollY = previousScrollY;
    else delete globalThis.scrollY;
    if (hadScrollTo) globalThis.scrollTo = previousScrollTo;
    else delete globalThis.scrollTo;
  }
}

describe('Assets-page Auto Rename ordering enhancement', () => {
  it('enables from selection, clears when deselected, and also enables for reorder', () => {
    const page = makeAssetPage();

    expect(page.submit.disabled).toBe(true);
    expect(enhanceAssetAutoRenameOrdering(page.document)).toBe(1);
    expect(enhanceAssetSelection(page.document)).toBe(1);
    expect(page.submit.disabled).toBe(true);
    expect(page.assets[0].item.draggable).toBe(true);
    expect(page.assets[0].item.getAttribute('tabindex')).toBe('0');
    expect(page.assets[0].item.querySelector('[data-auto-rename-drag-handle]')).toBe(null);

    const checkbox = page.assets[0].checkbox;
    checkbox.checked = true;
    checkbox.dispatch('change');
    expect(page.submit.disabled).toBe(false);

    checkbox.checked = false;
    checkbox.dispatch('change');
    expect(page.submit.disabled).toBe(true);

    page.selectAll.dispatch('click');
    expect(page.submit.disabled).toBe(false);
    page.clearSelection.dispatch('click');
    expect(page.submit.disabled).toBe(true);

    dragTo(page, 0, { clientY: 140 });
    expect(page.submit.disabled).toBe(false);

    expect(enhanceAssetAutoRenameOrdering(page.document)).toBe(1);
    expect(page.assets[0].item.listeners.filter((entry) => entry.type === 'dragstart')).toHaveLength(1);
  });

  it('reorders the existing list row from its preview, serializes strict JSON, updates indicators, and never fetches', () => {
    const page = makeAssetPage({ view: 'list' });
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = () => { fetchCalls += 1; };

    try {
      enhanceAssetAutoRenameOrdering(page.document);
      const originalPreview = page.assets[0].preview;
      const transfer = dataTransfer();
      const dragStart = page.assets[0].preview.dispatch('dragstart', { dataTransfer: transfer });
      expect(dragStart.defaultPrevented).toBe(false);
      expect(page.assets[0].item.draggable).toBe(true);
      const over = page.surface.dispatch('dragover', {
        target: page.assets[2].item,
        clientY: 140,
        dataTransfer: transfer,
      });
      expect(over.defaultPrevented).toBe(true);
      expect(page.marker().getAttribute('data-auto-rename-insertion-index')).toBe('2');
      page.surface.dispatch('drop', { target: page.assets[2].item, dataTransfer: transfer });

      expect(page.order()).toEqual(['2', '3', '1']);
      expect(page.orderInput.value).toBe('[2,3,1]');
      expect(page.submit.disabled).toBe(false);
      expect(page.assets[0].item.querySelector('[data-preview-enhancement]')).toBe(originalPreview);
      expect(page.assets[0].item.querySelector('[data-preview-image]')).toBe(page.assets[0].image);
      expect(page.assets[0].indicator.textContent).toBe('3 of 3');
      expect(page.live.textContent).toContain('Asset 1');
      expect(fetchCalls).toBe(0);
      expect(page.assets[0].item.classList.contains('auto-rename-asset--dragging')).toBe(false);
      expect(page.marker().hidden).toBe(true);
      expect(page.assets[0].item.draggable).toBe(true);
      expect(new Set(page.order()).size).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reorders the existing grid card from its body using grid geometry', () => {
    const page = makeAssetPage({ view: 'grid' });
    enhanceAssetAutoRenameOrdering(page.document);

    const transfer = dataTransfer();
    const dragStart = page.assets[0].body.dispatch('dragstart', { dataTransfer: transfer });
    expect(dragStart.defaultPrevented).toBe(false);
    const over = page.surface.dispatch('dragover', {
      target: page.surface,
      clientX: 390,
      clientY: 50,
      dataTransfer: transfer,
    });
    expect(over.defaultPrevented).toBe(true);
    expect(page.marker().getAttribute('data-auto-rename-insertion-index')).toBe('2');
    page.surface.dispatch('drop', { target: page.surface, clientX: 390, clientY: 50, dataTransfer: transfer });
    expect(page.order()).toEqual(['2', '3', '1']);
    expect(page.assets[0].item.draggable).toBe(true);
    expect(page.assets[0].item.parentElement).toBe(page.list);
  });

  it('resolves before-first, wrapped-row, column-gap, interior, and after-last grid slots', () => {
    const cases = [
      {
        sourceIndex: 3,
        point: { clientX: 0, clientY: 50 },
        order: ['4', '1', '2', '3', '5', '6'],
        slot: 0,
      },
      {
        sourceIndex: 5,
        point: { clientX: 130, clientY: 50 },
        order: ['1', '6', '2', '3', '4', '5'],
        slot: 1,
      },
      {
        sourceIndex: 5,
        point: { clientX: 130, clientY: 170 },
        order: ['1', '2', '3', '4', '6', '5'],
        slot: 4,
      },
      {
        sourceIndex: 0,
        point: { clientX: 390, clientY: 250 },
        order: ['2', '3', '4', '5', '6', '1'],
        slot: 5,
      },
    ];

    for (const testCase of cases) {
      const page = makeAssetPage({ view: 'grid', ids: [1, 2, 3, 4, 5, 6] });
      enhanceAssetAutoRenameOrdering(page.document);
      const result = dragTo(page, testCase.sourceIndex, testCase.point);

      expect(result.over.defaultPrevented).toBe(true);
      expect(result.markerSlot).toBe(testCase.slot);
      expect(page.order()).toEqual(testCase.order);
      expect(page.order().indexOf(String(testCase.sourceIndex + 1))).toBe(result.markerSlot);
      expect(page.marker().hidden).toBe(true);
      expect(page.surface.autoRenameOrderingState.dropIndex).toBe(null);
    }
  });

  it('maps wrapped-row gaps to the preceding or following row without changing the insertion slot', () => {
    const preceding = makeAssetPage({ view: 'grid', ids: [1, 2, 3, 4, 5, 6] });
    enhanceAssetAutoRenameOrdering(preceding.document);
    const beforeRowEnd = dragTo(preceding, 5, { clientX: 390, clientY: 105 });
    expect(beforeRowEnd.markerSlot).toBe(3);
    expect(beforeRowEnd.markerGeometry.top).toBe(0);
    expect(preceding.order()).toEqual(['1', '2', '3', '6', '4', '5']);
    expect(preceding.order().indexOf('6')).toBe(beforeRowEnd.markerSlot);

    const following = makeAssetPage({ view: 'grid', ids: [1, 2, 3, 4, 5, 6] });
    enhanceAssetAutoRenameOrdering(following.document);
    const afterRowStart = dragTo(following, 5, { clientX: 0, clientY: 125 });
    expect(afterRowStart.markerSlot).toBe(3);
    expect(afterRowStart.markerGeometry.top).toBe(130);
    expect(following.order()).toEqual(['1', '2', '3', '6', '4', '5']);
    expect(following.order().indexOf('6')).toBe(afterRowStart.markerSlot);
  });

  it('keeps the displayed slot equal to the final slot for forward and backward moves', () => {
    const page = makeAssetPage({ view: 'grid', ids: [1, 2, 3, 4, 5, 6] });
    enhanceAssetAutoRenameOrdering(page.document);

    const forward = dragTo(page, 0, { clientX: 130, clientY: 170 });
    expect(forward.markerSlot).toBe(3);
    expect(page.order()).toEqual(['2', '3', '4', '1', '5', '6']);
    expect(page.order().indexOf('1')).toBe(forward.markerSlot);

    const backward = dragTo(page, 0, { clientX: 0, clientY: 50 });
    expect(backward.markerSlot).toBe(0);
    expect(page.order()).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(page.order().indexOf('1')).toBe(backward.markerSlot);
    expect(page.orderInput.value).toBe('[1,2,3,4,5,6]');
    expect(page.submit.disabled).toBe(true);
  });

  it('keeps list placement before the first row, between rows, and after the last row', () => {
    const cases = [
      { sourceIndex: 2, point: { clientY: 0 }, order: ['3', '1', '2'], slot: 0 },
      { sourceIndex: 0, point: { clientY: 80 }, order: ['2', '1', '3'], slot: 1 },
      { sourceIndex: 0, point: { clientY: 200 }, order: ['2', '3', '1'], slot: 2 },
    ];

    for (const testCase of cases) {
      const page = makeAssetPage({ view: 'list' });
      enhanceAssetAutoRenameOrdering(page.document);
      const result = dragTo(page, testCase.sourceIndex, testCase.point);

      expect(result.over.defaultPrevented).toBe(true);
      expect(result.markerSlot).toBe(testCase.slot);
      expect(page.order()).toEqual(testCase.order);
      expect(page.order().indexOf(String(testCase.sourceIndex + 1))).toBe(result.markerSlot);
      expect(result.markerGeometry.left).toBe(0);
      expect(result.markerGeometry.width).toBe(500);
      expect(page.marker().hidden).toBe(true);
    }
  });

  it('re-inserts only the dragged node, preserves preview identity, focus, and scroll in grid and list views', () => {
    withViewport((scrollCalls) => {
      const page = makeAssetPage({ view: 'grid', ids: [1, 2, 3, 4, 5, 6] });
      enhanceAssetAutoRenameOrdering(page.document);
      const source = page.assets[5];
      const previewImage = source.image;
      const initialInsertCalls = page.list.insertBeforeCalls.length;
      const initialAppendCalls = page.list.appendChildCalls.length;
      source.item.focus();

      const result = dragTo(page, 5, { clientX: 130, clientY: 50 });

      expect(result.markerSlot).toBe(1);
      expect(page.order()).toEqual(['1', '6', '2', '3', '4', '5']);
      expect(page.order().indexOf('6')).toBe(result.markerSlot);
      expect(page.list.insertBeforeCalls.slice(initialInsertCalls)).toHaveLength(1);
      expect(page.list.insertBeforeCalls.at(-1).child).toBe(source.item);
      expect(page.list.appendChildCalls).toHaveLength(initialAppendCalls);
      expect(source.item.querySelector('[data-preview-image]')).toBe(previewImage);
      expect(globalThis.scrollX).toBe(17);
      expect(globalThis.scrollY).toBe(1400);
      expect(scrollCalls.length).toBeGreaterThan(0);
      expect(source.item.focusCalls.at(-1)).toEqual({ preventScroll: true });
      expect(page.surface.style.overflowAnchor).toBe('');
      expect(page.marker().hidden).toBe(true);
      expect(page.assets.every(({ item }) => item.parentElement === page.list)).toBe(true);
    });

    withViewport((scrollCalls) => {
      const page = makeAssetPage({ view: 'list' });
      enhanceAssetAutoRenameOrdering(page.document);
      const source = page.assets[0];
      const previewImage = source.image;
      source.item.focus();
      const result = dragTo(page, 0, { clientY: 80 });

      expect(result.markerSlot).toBe(1);
      expect(page.order()).toEqual(['2', '1', '3']);
      expect(page.list.insertBeforeCalls).toHaveLength(1);
      expect(page.list.insertBeforeCalls[0].child).toBe(source.item);
      expect(source.item.querySelector('[data-preview-image]')).toBe(previewImage);
      expect(globalThis.scrollX).toBe(17);
      expect(globalThis.scrollY).toBe(1400);
      expect(scrollCalls.length).toBeGreaterThan(0);
      expect(source.item.focusCalls.at(-1)).toEqual({ preventScroll: true });
      expect(page.surface.style.overflowAnchor).toBe('');
    });
  });

  it('preserves scroll and clears marker/state for cancelled and outside drops', () => {
    withViewport(() => {
      const page = makeAssetPage({ view: 'grid', ids: [1, 2, 3, 4, 5, 6] });
      enhanceAssetAutoRenameOrdering(page.document);
      const transfer = dataTransfer();
      page.assets[5].preview.dispatch('dragstart', { dataTransfer: transfer });
      page.surface.dispatch('dragover', {
        target: page.surface,
        clientX: 130,
        clientY: 50,
        dataTransfer: transfer,
      });
      expect(page.marker().hidden).toBe(false);
      page.surface.dispatch('dragleave', { relatedTarget: page.document });
      expect(page.marker().hidden).toBe(true);
      page.document.dispatch('drop', { target: page.document, dataTransfer: transfer });
      page.assets[5].item.dispatch('dragend');

      expect(page.order()).toEqual(['1', '2', '3', '4', '5', '6']);
      expect(globalThis.scrollX).toBe(17);
      expect(globalThis.scrollY).toBe(1400);
      expect(page.surface.autoRenameOrderingState.draggedItem).toBe(null);
      expect(page.surface.autoRenameOrderingState.dropIndex).toBe(null);
      expect(page.assets[5].item.getAttribute('aria-grabbed')).toBe('false');
      expect(page.surface.classList.contains('auto-rename-surface--dragging')).toBe(false);
      expect(page.marker().hidden).toBe(true);
      expect(page.surface.style.overflowAnchor).toBe('');
    });
  });

  it('disables Auto Rename again when pointer dragging restores the initial order', () => {
    const page = makeAssetPage({ view: 'list' });
    enhanceAssetAutoRenameOrdering(page.document);

    const move = (source, target, clientY) => {
      const transfer = dataTransfer();
      source.preview.dispatch('dragstart', { dataTransfer: transfer });
       page.surface.dispatch('dragover', { target: page.surface, clientY, dataTransfer: transfer });
       page.surface.dispatch('drop', { target: page.surface, clientY, dataTransfer: transfer });
    };

    move(page.assets[0], page.assets[1], 80);
    expect(page.order()).toEqual(['2', '1', '3']);
    expect(page.submit.disabled).toBe(false);

    move(page.assets[0], page.assets[1], 1);
    expect(page.order()).toEqual(['1', '2', '3']);
    expect(page.orderInput.value).toBe('[1,2,3]');
    expect(page.submit.disabled).toBe(true);
  });

  it('keeps links usable for clicks and drag while blocking form controls', () => {
    const page = makeAssetPage({ view: 'grid' });
    enhanceAssetAutoRenameOrdering(page.document);

    const filenameClick = page.assets[0].filenameLink.dispatch('click');
    const previewClick = page.assets[0].previewLink.dispatch('click');
    expect(filenameClick.defaultPrevented).toBe(false);
    expect(previewClick.defaultPrevented).toBe(false);
    expect(page.assets[0].filenameLink.navigationCount).toBe(1);
    expect(page.assets[0].previewLink.navigationCount).toBe(1);

    for (const child of [page.assets[0].checkbox, page.assets[0].renameInput, page.assets[0].unrelatedButton]) {
      const dragStart = child.dispatch('dragstart', { dataTransfer: dataTransfer() });

      expect(dragStart.defaultPrevented).toBe(true);
      expect(page.assets[0].item.draggable).toBe(true);
      expect(page.surface.autoRenameOrderingState.draggedItem).toBe(null);
    }

    const transfer = dataTransfer();
    page.assets[0].image.dispatch('dragstart', { dataTransfer: transfer });
    page.surface.dispatch('dragover', { target: page.surface, clientX: 280, clientY: 50, dataTransfer: transfer });
    page.surface.dispatch('drop', { target: page.surface, clientX: 280, clientY: 50, dataTransfer: transfer });
    const completedClick = page.assets[0].previewLink.dispatch('click');
    expect(completedClick.defaultPrevented).toBe(true);
    expect(page.assets[0].previewLink.navigationCount).toBe(1);
  });

  it('leaves cancelled or outside drops unchanged and clears transient state', () => {
    const page = makeAssetPage();
    enhanceAssetAutoRenameOrdering(page.document);

    const transfer = dataTransfer();
    page.assets[0].preview.dispatch('dragstart', { dataTransfer: transfer });
    page.surface.dispatch('drop', { target: page.live, dataTransfer: transfer });
    expect(page.order()).toEqual(['1', '2', '3']);
    expect(page.submit.disabled).toBe(true);
    expect(page.assets[0].item.classList.contains('auto-rename-asset--dragging')).toBe(false);

    page.assets[1].preview.dispatch('dragstart', { dataTransfer: dataTransfer() });
    page.document.dispatch('drop', { target: page.document });
    page.assets[1].item.dispatch('dragend');
    expect(page.order()).toEqual(['1', '2', '3']);
    expect(page.surface.classList.contains('auto-rename-surface--dragging')).toBe(false);
    expect(page.assets[1].item.draggable).toBe(true);

    page.assets[2].preview.dispatch('dragstart', { dataTransfer: dataTransfer() });
    page.assets[2].item.dispatch('dragend');
    expect(page.assets[2].item.draggable).toBe(true);
    expect(page.surface.autoRenameOrderingState.draggedItem).toBe(null);
  });

  it('supports keyboard grab, arrow movement, boundary safety, commit, and Escape restore', () => {
    const page = makeAssetPage();
    enhanceAssetAutoRenameOrdering(page.document);
    const item = page.assets[1].item;
    item.focus();

    item.dispatch('keydown', { key: ' ' });
    expect(page.assets[1].item.getAttribute('aria-grabbed')).toBe('true');
    item.dispatch('keydown', { key: 'ArrowDown' });
    expect(page.order()).toEqual(['1', '3', '2']);
    expect(page.orderInput.value).toBe('[1,3,2]');
    expect(page.assets[1].indicator.textContent).toBe('3 of 3');
    expect(page.submit.disabled).toBe(false);
    expect(item.focused).toBe(true);
    expect(page.live.textContent).toContain('position 3 of 3');

    item.dispatch('keydown', { key: 'ArrowDown' });
    expect(page.order()).toEqual(['1', '3', '2']);
    item.dispatch('keydown', { key: 'Enter' });
    expect(page.assets[1].item.getAttribute('aria-grabbed')).toBe('false');
    expect(page.order()).toEqual(['1', '3', '2']);

    const escapeItem = page.assets[2].item;
    escapeItem.focus();
    escapeItem.dispatch('keydown', { key: 'Enter' });
    escapeItem.dispatch('keydown', { key: 'ArrowUp' });
    expect(page.order()).toEqual(['3', '1', '2']);
    escapeItem.dispatch('keydown', { key: 'Escape' });
    expect(page.order()).toEqual(['1', '3', '2']);
    expect(page.submit.disabled).toBe(false);
    expect(escapeItem.focused).toBe(true);
  });

  it('blocks malformed, duplicate, missing, and unrelated membership from submission', () => {
    const duplicate = makeAssetPage({ ids: [1, 1, 2] });
    expect(enhanceAssetAutoRenameOrdering(duplicate.document)).toBe(0);
    expect(duplicate.submit.disabled).toBe(true);

    const missing = makeAssetPage({ ids: [1, 2], initialOrder: [1, 2] });
    missing.orderInput.value = '[1]';
    expect(enhanceAssetAutoRenameOrdering(missing.document)).toBe(0);
    expect(missing.submit.disabled).toBe(true);

    const added = makeAssetPage();
    enhanceAssetAutoRenameOrdering(added.document);
    const extra = makeNode({ tagName: 'li', attrs: {
      'data-auto-rename-asset': '',
      'data-auto-rename-asset-id': '99',
      'data-auto-rename-initial-index': '3',
    } });
    added.list.appendChild(extra);
    const submit = added.form.dispatch('submit');
    expect(submit.defaultPrevented).toBe(true);
    expect(added.submit.disabled).toBe(true);
    expect(added.orderInput.value).toBe('');
  });

  it('keeps confirmation markup read-only and leaves preview fallback hooks intact', () => {
    const template = fs.readFileSync(
      fileURLToPath(new URL('../src/views/projects/auto-rename-confirm.njk', import.meta.url)),
      'utf8',
    );
    expect(template).toContain('data-preview-enhancement');
    expect(template).toContain('data-preview-fallback');
    expect(template).not.toContain('data-auto-rename-drag-handle');
    expect(template).not.toContain('Move Up');
    expect(template).not.toContain('Move Down');
    expect(template).not.toContain('draggable');
    expect(template).not.toContain('orderedAssetIds');
    expect(template).not.toContain('data-auto-rename-proposed-name');
    expect(template).not.toContain('data-auto-rename-live');
  });

  it('keeps ordering CSS scoped to Assets, uses view-specific indicators, and omits obsolete controls', () => {
    const stylesheet = fs.readFileSync(
      fileURLToPath(new URL('../src/static/creatorcrate.css', import.meta.url)),
      'utf8',
     );
     expect(stylesheet).toContain('.asset-auto-rename-surface');
    expect(stylesheet).toContain('.asset-actions-panel');
     expect(stylesheet).toContain('.asset-selection-controls');
     expect(stylesheet).toContain('.auto-rename-asset--dragging');
     expect(stylesheet).toContain('.auto-rename-order-marker');
     expect(stylesheet).toContain('position: absolute');
     expect(stylesheet).toContain('pointer-events: none');
     expect(stylesheet).toContain('width: 3px');
     expect(stylesheet).toContain('height: 3px');
     const orderingCss = stylesheet.slice(
       stylesheet.indexOf('.asset-auto-rename-surface {'),
       stylesheet.indexOf('.asset-auto-rename-surface .table-scroll'),
     );
     expect(orderingCss).toContain('overflow: visible');
     expect(orderingCss).not.toContain('::before');
     expect(orderingCss).not.toContain('::after');
     expect(orderingCss).not.toContain('auto-rename-drop-before');
     expect(orderingCss).not.toContain('auto-rename-drop-after');
    expect(stylesheet).toMatch(/@media \(max-width: 767px\)[\s\S]*\.asset-actions-category-row/);
    expect(stylesheet).not.toContain('.auto-rename-drag-handle');
    expect(stylesheet).not.toContain('.auto-rename-assets-toolbar');
    const actionDisabledCss = stylesheet.slice(
      stylesheet.indexOf('.asset-actions-panel .button:disabled'),
      stylesheet.indexOf('.asset-actions-category-row'),
    );
    expect(actionDisabledCss).toContain('text-decoration: none');
    expect(actionDisabledCss).not.toContain('text-decoration: line-through');
    expect(stylesheet).not.toContain('.auto-rename-reorder-controls');
    expect(stylesheet).not.toContain('data-auto-rename-move-up');
    expect(stylesheet).not.toContain('data-auto-rename-move-down');
  });
});
