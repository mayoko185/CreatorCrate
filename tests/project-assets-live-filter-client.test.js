import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  beginProjectAssetsDefaultsLiveRefresh,
  enhanceDropdowns,
  enhanceAssetSelection,
  enhanceAssetGridSize,
  enhanceAssetListSize,
  enhanceProjectAssetsLiveFiltering,
  refreshProjectAssetsDefaultsLiveRegion,
  refreshProjectAssetsLiveRegion,
} from '../src/static/creatorcrate.js';

function makeNode({ tagName = 'div', attrs = {}, value = '', checked = false } = {}) {
  const attributes = new Map();
  const listeners = [];
  const children = [];
  const node = {
    tagName: tagName.toUpperCase(),
    nodeType: 1,
    ownerDocument: null,
    parentNode: null,
    parentElement: null,
    children,
    listeners,
    dataset: {},
    value,
    checked,
    disabled: false,
    hidden: false,
    open: false,
    textContent: '',
    setAttribute(name, rawValue) {
      const stringValue = String(rawValue);
      attributes.set(name, stringValue);
      if (name === 'id') this.id = stringValue;
      if (name === 'name') this.name = stringValue;
      if (name === 'type') this.type = stringValue;
      if (name === 'value') this.value = stringValue;
      if (name === 'action') this.action = stringValue;
      if (name === 'method') this.method = stringValue;
      if (name === 'hidden') this.hidden = true;
      if (name.startsWith('data-')) {
        this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = stringValue;
      }
    },
    getAttribute(name) {
      return attributes.has(name) ? attributes.get(name) : null;
    },
    hasAttribute(name) {
      return attributes.has(name);
    },
    removeAttribute(name) {
      attributes.delete(name);
      if (name === 'hidden') this.hidden = false;
      if (name === 'disabled') this.disabled = false;
      if (name.startsWith('data-')) {
        delete this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())];
      }
    },
      matches(selector) {
        return selector.split(',').some((part) => {
          const candidate = part.trim();
          const checkedOnly = candidate.includes(':checked');
          const excludesDisabled = candidate.includes(':not(:disabled)');
          const disabledOnly = candidate.includes(':disabled') && !excludesDisabled;
          if (candidate.includes(':') && !checkedOnly && !excludesDisabled && !disabledOnly) return false;
          if (checkedOnly && !this.checked) return false;
          if (excludesDisabled && this.disabled) return false;
          if (disabledOnly && !this.disabled) return false;
          const selectorWithoutState = candidate.replace(':checked', '').replace(':not(:disabled)', '').replace(':disabled', '');
          const parts = selectorWithoutState.split(/\s+/);
          const target = parts.pop();
          const idMatch = target.match(/#([\w-]+)/);
          if (idMatch && this.id !== idMatch[1]) return false;
          const tag = target.match(/^[a-z][\w-]*/i)?.[0];
        if (tag && this.tagName !== tag.toUpperCase()) return false;
        const classNames = [...target.matchAll(/\.([\w-]+)/g)].map((match) => match[1]);
        if (classNames.some((name) => !String(this.getAttribute('class') || '').split(/\s+/).includes(name))) return false;
        const attrsInSelector = [...target.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)];
        if (!attrsInSelector.every(([, name, expected]) => {
          const actual = this.getAttribute(name);
          return actual !== null && (expected === undefined || actual === expected);
        })) return false;
        if (parts.length === 0) return true;
        let ancestor = this.parentNode;
        const parentSelector = parts.join(' ');
        while (ancestor) {
          if (ancestor.matches?.(parentSelector)) return true;
          ancestor = ancestor.parentNode;
        }
        return false;
      });
    },
    closest(selector) {
      let current = this;
      while (current) {
        if (current.matches?.(selector)) return current;
        current = current.parentNode;
      }
      return null;
    },
    appendChild(child) {
      children.push(child);
      child.parentNode = this;
      child.parentElement = this;
      const document = this.ownerDocument || (this.nodeType === 9 ? this : null);
      const adopt = (current) => {
        current.ownerDocument = document;
        current.children.forEach(adopt);
      };
      adopt(child);
      return child;
    },
    replaceChildren(...nextChildren) {
      children.splice(0).forEach((child) => {
        child.parentNode = null;
        child.parentElement = null;
      });
      nextChildren.forEach((child) => this.appendChild(child));
    },
    replaceWith(next) {
      const parent = this.parentNode;
      const index = parent?.children?.indexOf(this) ?? -1;
      if (index < 0) return;
      parent.children.splice(index, 1, next);
      this.parentNode = null;
      next.parentNode = parent;
      next.parentElement = parent;
      const adopt = (current) => {
        current.ownerDocument = parent.ownerDocument || parent;
        current.children.forEach(adopt);
      };
      adopt(next);
    },
    contains(candidate) {
      let current = candidate;
      while (current) {
        if (current === this) return true;
        current = current.parentNode;
      }
      return false;
    },
    addEventListener(type, handler) {
      listeners.push({ type, handler });
    },
    dispatch(type, props = {}) {
      const event = {
        type,
        target: props.target || this,
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
        ...props,
      };
      let current = this;
      while (current) {
        current.listeners?.filter((listener) => listener.type === type)
          .forEach((listener) => listener.handler(event));
        current = current.parentNode;
      }
      return event;
    },
    querySelectorAll(selector) {
      const result = [];
      const visit = (current) => {
        current.children.forEach((child) => {
          if (child.matches?.(selector)) result.push(child);
          visit(child);
        });
      };
      visit(this);
      return result;
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    },
  };

  Object.entries(attrs).forEach(([name, rawValue]) => node.setAttribute(name, rawValue));
  if (checked) node.checked = true;
  return node;
}

function addInput(parent, attrs, value = '', checked = false) {
  const input = makeNode({ tagName: 'input', attrs, value, checked });
  parent.appendChild(input);
  return input;
}

function makePage({
  presence = 'all',
  tag = '',
  extension = '',
  inheritedFilterDefaults = '',
  nsfwEnabled = false,
  page = '2',
  view = 'list',
  gridSizeDefault = 'default',
  listSizeDefault = 'large',
  withAssetInfoCard = false,
  withAssetSelection = false,
  dialogOpen = true,
  resetUrl = '/projects/1/assets?resetFilters=1&view=list',
  projectsResetUrl = null,
} = {}) {
  const document = makeNode({ tagName: 'document' });
  document.nodeType = 9;
  document.ownerDocument = document;

  const region = makeNode({
    attrs: {
      'data-project-assets-live-region': '',
      'data-project-assets-grid-size-default': gridSizeDefault,
      'data-project-assets-list-size-default': listSizeDefault,
    },
  });
  const status = makeNode({ attrs: { 'data-project-assets-live-status': '' } });
  const form = makeNode({
    tagName: 'form',
    attrs: { id: 'asset-filters', action: '/projects/1/assets', method: 'get' },
  });
  form.submit = vi.fn();
  const dialog = makeNode({
    tagName: 'dialog',
    attrs: { id: 'project-assets-filter-dialog', 'data-app-dialog': '' },
  });
  dialog.open = dialogOpen;
  const resetForm = makeNode({
    tagName: 'form',
    attrs: { action: resetUrl, method: 'get', class: 'projects-filter-reset' },
  });
  const reset = makeNode({ tagName: 'button', attrs: { type: 'submit', 'data-project-assets-reset': '' } });
  reset.form = resetForm;
  const projectsResetForm = projectsResetUrl
    ? makeNode({ tagName: 'form', attrs: { action: projectsResetUrl, method: 'get', class: 'projects-filter-reset' } })
    : null;
  const search = addInput(form, { id: 'search', name: 'search', type: 'search' });
  addInput(form, { name: 'page', type: 'hidden' }, page);
  addInput(form, { name: 'view', type: 'hidden' }, view);
  addInput(form, { name: 'pageSize', type: 'hidden' }, '25');
  const tagInput = addInput(form, { name: 'tag', type: 'hidden' }, tag);
  const extensionInput = addInput(form, { name: 'extension', type: 'hidden' }, extension);
  const inheritedFilterDefaultsInput = inheritedFilterDefaults
    ? addInput(form, {
      name: 'inheritedFilterDefaults',
      type: 'hidden',
      'data-project-assets-inherited-filter-defaults': '',
    }, inheritedFilterDefaults)
    : null;

  const categoryFilter = makeNode({ attrs: { 'data-asset-category-filter': '' } });
  const categoryDetails = makeNode({
    tagName: 'details',
    attrs: {
      id: 'asset-category-filter',
      'data-cc-dropdown': '',
      'data-cc-dropdown-mode': 'single',
    },
  });
  const categorySummary = makeNode({ tagName: 'summary' });
  const categoryCurrentSummary = makeNode({ attrs: { 'data-cc-dropdown-summary-current': '' } });
  categorySummary.appendChild(categoryCurrentSummary);
  categoryDetails.appendChild(categorySummary);
  const categoryOptions = makeNode();
  const makeCategoryOption = (label, value, categoryPresence, selected) => {
    const option = makeNode({ attrs: { class: 'asset-filter-multiselect-option' } });
    const input = addInput(option, {
      name: 'category',
      type: 'radio',
      value,
      'data-asset-category-presence': categoryPresence,
    }, value, selected);
    const labelNode = makeNode({ tagName: 'label' });
    labelNode.textContent = label;
    option.appendChild(labelNode);
    categoryOptions.appendChild(option);
    return { input, option };
  };
  const categoryAll = makeCategoryOption('All categories', 'all', 'all', presence !== 'missing');
  const categoryRenders = makeCategoryOption('Renders', '7', 'all', false);
  const categoryMissing = makeCategoryOption('Missing', 'all', 'missing', presence === 'missing');
  categoryDetails.appendChild(categoryOptions);
  categoryFilter.appendChild(categoryDetails);
  form.appendChild(categoryFilter);

  const presenceField = makeNode();
  const presenceAll = addInput(presenceField, { name: 'presence', type: 'radio', value: 'all' }, 'all', presence === 'all');
  const presencePresent = addInput(presenceField, { name: 'presence', type: 'radio', value: 'present' }, 'present', presence === 'present');
  const presenceMissing = addInput(presenceField, { name: 'presence', type: 'radio', value: 'missing' }, 'missing', presence === 'missing');
  form.appendChild(presenceField);

  const nsfwForm = makeNode({
    tagName: 'form',
    attrs: { action: '/projects/1/assets/nsfw-filter', method: 'post', 'data-project-assets-nsfw-filter': '' },
  });
  addInput(nsfwForm, { name: '_csrf', type: 'hidden' }, 'csrf-token');
  const nsfwValue = addInput(nsfwForm, {
    name: 'enabled', type: 'hidden', 'data-project-assets-nsfw-value': '',
  }, nsfwEnabled ? '0' : '1');
  addInput(nsfwForm, { name: 'returnTo', type: 'hidden' }, `/projects/1/assets?page=${page}`);
  const nsfwToggle = makeNode({
    tagName: 'button',
    attrs: {
      type: 'submit',
      'data-project-assets-nsfw-toggle': '',
      'aria-pressed': String(nsfwEnabled),
    },
  });
  nsfwForm.appendChild(nsfwToggle);

  const gridSizeControls = makeNode({
    attrs: {
      'data-asset-grid-size-controls': '',
      'data-grid-size-labels-interactive': '',
    },
  });
  const gridSlider = makeNode({
    tagName: 'input',
    attrs: { 'data-grid-size-slider': '', type: 'range' },
    value: '2',
  });
  const gridCompactLabel = makeNode({
    tagName: 'button',
    attrs: { 'data-grid-size-option-label': 'compact' },
  });
  const gridDefaultLabel = makeNode({
    tagName: 'button',
    attrs: { 'data-grid-size-option-label': 'default' },
  });
  const gridLargeLabel = makeNode({
    tagName: 'button',
    attrs: { 'data-grid-size-option-label': 'large' },
  });
  gridSizeControls.appendChild(gridSlider);
  gridSizeControls.appendChild(gridCompactLabel);
  gridSizeControls.appendChild(gridDefaultLabel);
  gridSizeControls.appendChild(gridLargeLabel);
  const grid = makeNode({ attrs: { class: 'asset-grid' } });
  const assetInfoPreview = withAssetInfoCard
    ? makeNode({ attrs: { 'data-asset-viewer-preview': '' } })
    : null;
  const assetInfoCard = withAssetInfoCard
    ? makeNode({ attrs: { 'data-asset-info-card': '', popover: 'manual' } })
    : null;
  if (assetInfoPreview && assetInfoCard) {
    assetInfoPreview.appendChild(assetInfoCard);
    grid.appendChild(assetInfoPreview);
  }
  const listSizeControls = makeNode({
    attrs: {
      'data-asset-list-size-controls': '',
      'data-grid-size-labels-interactive': '',
    },
  });
  const listSlider = makeNode({
    tagName: 'input',
    attrs: { 'data-grid-size-slider': '', type: 'range' },
    value: '2',
  });
  const listCompactLabel = makeNode({
    tagName: 'button',
    attrs: { 'data-grid-size-option-label': 'compact' },
  });
  const listLargeLabel = makeNode({
    tagName: 'button',
    attrs: { 'data-grid-size-option-label': 'large' },
  });
  listSizeControls.appendChild(listSlider);
  listSizeControls.appendChild(listCompactLabel);
  listSizeControls.appendChild(listLargeLabel);
  const list = makeNode({
    attrs: {
      class: 'asset-list asset-list--project',
      'data-list-size': 'large',
    },
  });

  const selectedCount = withAssetSelection
    ? makeNode({
      tagName: 'p',
      attrs: { class: 'results-meta', 'data-selected-count': '', 'data-selected-total': '1' },
    })
    : null;
  const selectionForm = withAssetSelection
    ? makeNode({ tagName: 'form', attrs: { id: 'bulk-select-form', 'data-asset-selection-form': '' } })
    : null;
  const selectionCheckbox = withAssetSelection
    ? makeNode({ tagName: 'input', attrs: { type: 'checkbox', name: 'selectedAssetIds', value: '1' } })
    : null;
  if (selectionForm && selectionCheckbox) selectionForm.appendChild(selectionCheckbox);

  region.appendChild(status);
  region.appendChild(nsfwForm);
  region.appendChild(gridSizeControls);
  if (selectedCount) region.appendChild(selectedCount);
  if (selectionForm) region.appendChild(selectionForm);
  region.appendChild(grid);
  region.appendChild(listSizeControls);
  region.appendChild(list);
  if (projectsResetForm) document.appendChild(projectsResetForm);
  document.appendChild(region);
  dialog.appendChild(form);
  resetForm.appendChild(reset);
  dialog.appendChild(resetForm);
  document.appendChild(dialog);

  return {
    document,
    region,
    status,
    form,
    dialog,
    resetForm,
    reset,
    projectsResetForm,
    search,
    tagInput,
    extensionInput,
    inheritedFilterDefaultsInput,
    categoryFilter,
    categoryAll: categoryAll.input,
    categoryRenders: categoryRenders.input,
    categoryMissing: categoryMissing.input,
    presenceAll,
    presencePresent,
    presenceMissing,
    nsfwForm,
    nsfwValue,
    nsfwToggle,
    selectedCount,
    selectionForm,
    selectionCheckbox,
    grid,
    assetInfoPreview,
    assetInfoCard,
    gridSlider,
    gridLabels: [gridCompactLabel, gridDefaultLabel, gridLargeLabel],
    list,
    listSlider,
    listLabels: [listCompactLabel, listLargeLabel],
  };
}

function makeWindow(document, pages = new Map()) {
  const location = {
    href: 'http://creatorcrate.test/projects/1/assets?page=2',
    pathname: '/projects/1/assets',
  };
  const setLocation = (value) => {
    const parsed = new URL(value, location.href);
    location.href = parsed.href;
    location.pathname = parsed.pathname;
  };
  const windowObject = {
    location,
    fetch: vi.fn(),
    setTimeout,
    clearTimeout,
    AbortController,
    URLSearchParams,
    FormData: class FormDataMock {
      constructor(form) {
        this.fields = form.querySelectorAll('input, select, textarea')
          .filter((field) => field.name && !field.disabled
            && (field.type !== 'checkbox' && field.type !== 'radio' || field.checked))
          .map((field) => [field.name, field.value]);
      }

      *entries() { yield* this.fields; }
      [Symbol.iterator]() { return this.entries(); }
    },
    DOMParser: class DOMParserMock {
      parseFromString(text) { return pages.get(text) || makeNode({ tagName: 'document' }); }
    },
    history: {
      pushes: [],
      replaces: [],
      pushState(state, title, url) {
        this.pushes.push({ state, title, url });
        setLocation(url);
      },
      replaceState(state, title, url) {
        this.replaces.push({ state, title, url });
        setLocation(url);
      },
    },
    addEventListener(type, handler) {
      this.listeners ||= [];
      this.listeners.push({ type, handler });
    },
    dispatch(type) {
      this.listeners?.filter((listener) => listener.type === type)
        .forEach((listener) => listener.handler({ type }));
    },
  };
  document.defaultView = windowObject;
  return { windowObject, setLocation };
}

function makeActionSelectFixture() {
  const document = makeNode({ tagName: 'document' });
  document.nodeType = 9;
  document.ownerDocument = document;

  const form = makeNode({
    tagName: 'form',
    attrs: { id: 'bulk-select-form', 'data-asset-selection-form': '' },
  });
  const checkbox = makeNode({
    tagName: 'input',
    attrs: { type: 'checkbox', name: 'selectedAssetIds', value: '1' },
  });
  const count = makeNode({
    tagName: 'span',
    attrs: { 'data-selected-count': '', 'data-selected-total': '1' },
  });
  const submit = makeNode({ tagName: 'button', attrs: { 'data-bulk-submit': '' } });
  submit.disabled = true;
  form.appendChild(checkbox);
  form.appendChild(count);
  form.appendChild(submit);

  const originalQuerySelectorAll = form.querySelectorAll.bind(form);
  form.querySelectorAll = (selector) => selector.includes('selectedAssetIds')
    ? [checkbox]
    : originalQuerySelectorAll(selector);

  function addActionSelect({ name, selectedValue, options }) {
    const field = makeNode({ attrs: { class: 'field' } });
    const control = makeNode();
    const native = makeNode({
      tagName: 'select',
      attrs: {
        id: `${name}-action-native`,
        class: 'cc-dropdown-native-select',
        name,
        'data-cc-dropdown-native-select': '',
        ...(name === 'releaseId' ? { 'data-release-select': '' } : {}),
      },
      value: selectedValue,
    });
    options.forEach(({ value, label }) => {
      const option = makeNode({ tagName: 'option', attrs: { value } });
      option.selected = value === selectedValue;
      option.textContent = label;
      native.appendChild(option);
    });
    const details = makeNode({
      tagName: 'details',
      attrs: {
        id: `${name}-action`,
        class: 'asset-filter-multiselect asset-filter-multiselect--sized cc-dropdown',
        'data-cc-dropdown': '',
        'data-cc-dropdown-mode': 'single',
        hidden: '',
      },
    });
    const summary = makeNode({ tagName: 'summary', attrs: { 'aria-label': `${name}: placeholder` } });
    summary.focus = () => { summary.focused = true; };
    const currentSummary = makeNode({ attrs: { 'data-cc-dropdown-summary-current': '' } });
    summary.appendChild(currentSummary);
    details.appendChild(summary);
    const panel = makeNode({ tagName: 'div', attrs: { role: 'radiogroup' } });
    const customOptions = options.map(({ value, label }, index) => {
      const row = makeNode({ attrs: { class: 'asset-filter-multiselect-option' } });
      const labelNode = makeNode({ tagName: 'label' });
      const input = makeNode({
        tagName: 'input',
        attrs: { type: 'radio', value },
        checked: value === selectedValue,
      });
      input.id = `${name}-action-option-${index}`;
      const text = makeNode({ tagName: 'span' });
      text.textContent = label;
      labelNode.appendChild(input);
      labelNode.appendChild(text);
      labelNode.textContent = label;
      row.appendChild(labelNode);
      panel.appendChild(row);
      return { input, label };
    });
    details.appendChild(panel);
    control.appendChild(native);
    control.appendChild(details);
    field.appendChild(control);
    form.appendChild(field);
    return { native, details, currentSummary, customOptions };
  }

  const release = addActionSelect({
    name: 'releaseId',
    selectedValue: '',
    options: [
      { value: '', label: 'Select a release…' },
      { value: '5', label: 'Launch release' },
    ],
  });
  const category = addActionSelect({
    name: 'destinationCategory',
    selectedValue: 'uncategorized',
    options: [
      { value: 'uncategorized', label: 'Uncategorized' },
      { value: '7', label: 'Renders' },
    ],
  });
  document.appendChild(form);
  const originalDocumentQuerySelectorAll = document.querySelectorAll.bind(document);
  document.querySelectorAll = (selector) => selector.includes('selectedAssetIds')
    ? [checkbox]
    : originalDocumentQuerySelectorAll(selector);
  return { document, form, checkbox, count, submit, release, category };
}

function htmlResponse(text, url) {
  return { ok: true, url, text: vi.fn(async () => text) };
}

function jsonResponse(payload, ok = true) {
  return { ok, json: vi.fn(async () => payload) };
}

async function flush() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function withLocalStorage(entries, callback) {
  const previousStorage = globalThis.localStorage;
  const storage = new Map(Object.entries(entries));
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  };
  try {
    return await callback(storage);
  } finally {
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  }
}

describe('Project Assets live filtering enhancement', () => {
  afterEach(() => vi.useRealTimers());

  it('enhances Asset Information on initial load and replacement without duplicate listeners', async () => {
    vi.useFakeTimers();
    const initial = makePage({ view: 'grid', withAssetInfoCard: true });
    const replacement = makePage({ view: 'grid', withAssetInfoCard: true });
    const { windowObject } = makeWindow(initial.document, new Map([
      ['replacement', replacement.document],
    ]));
    windowObject.fetch.mockResolvedValue(htmlResponse(
      'replacement',
      'http://creatorcrate.test/projects/1/assets?search=replaced&view=grid',
    ));

    expect(enhanceProjectAssetsLiveFiltering(initial.document)).toBe(1);
    expect(initial.assetInfoPreview.listeners.map(({ type }) => type)).toEqual([
      'pointerenter', 'pointermove', 'pointerleave', 'focusin', 'focusout',
    ]);
    enhanceProjectAssetsLiveFiltering(initial.document);
    expect(initial.assetInfoPreview.listeners).toHaveLength(5);

    initial.search.value = 'replaced';
    initial.search.dispatch('input');
    vi.advanceTimersByTime(350);
    await flush();

    expect(initial.document.querySelector('[data-project-assets-live-region]')).toBe(replacement.region);
    expect(replacement.assetInfoPreview.listeners.map(({ type }) => type)).toEqual([
      'pointerenter', 'pointermove', 'pointerleave', 'focusin', 'focusout',
    ]);
    enhanceProjectAssetsLiveFiltering(initial.document);
    expect(replacement.assetInfoPreview.listeners).toHaveLength(5);
  });

  it('loads the server-authoritative Defaults destination without preserving the active query and re-enhances the replacement', async () => {
    const initial = makePage({ tag: '8', page: '4', withAssetInfoCard: true, withAssetSelection: true });
    initial.search.value = 'obsolete';
    const replacement = makePage({
      presence: 'missing',
      page: '1',
      view: 'grid',
      withAssetInfoCard: true,
      withAssetSelection: true,
    });
    const pages = new Map([['defaults-result', replacement.document]]);
    const { windowObject } = makeWindow(initial.document, pages);
    const destination = 'http://creatorcrate.test/projects/1/assets?presence=missing&view=grid&notice=project_assets_defaults_saved';
    const canonicalUrl = 'http://creatorcrate.test/projects/1/assets?presence=missing&view=grid';
    windowObject.fetch.mockResolvedValue(htmlResponse('defaults-result', canonicalUrl));
    enhanceProjectAssetsLiveFiltering(initial.document);

    const authority = beginProjectAssetsDefaultsLiveRefresh(initial.document);
    expect(refreshProjectAssetsDefaultsLiveRegion(initial.document, destination, authority)).toBe('started');
    await flush();

    expect(windowObject.fetch).toHaveBeenCalledWith(
      destination,
      expect.objectContaining({ method: 'GET', redirect: 'follow', headers: { Accept: 'text/html' } }),
    );
    expect(windowObject.fetch.mock.calls[0][0]).not.toContain('obsolete');
    expect(windowObject.fetch.mock.calls[0][0]).not.toContain('tag=8');
    expect(windowObject.fetch.mock.calls[0][0]).not.toContain('page=4');
    expect(windowObject.history.pushes).toHaveLength(0);
    expect(windowObject.history.replaces).toEqual([expect.objectContaining({ url: canonicalUrl })]);
    expect(initial.document.querySelector('[data-project-assets-live-region]')).toBe(replacement.region);
    expect(initial.document.querySelector('#asset-filters')).toBe(initial.form);
    expect(initial.document.querySelector('#search')).toBe(replacement.search);
    expect(initial.dialog.open).toBe(true);
    expect(replacement.assetInfoPreview.listeners.map(({ type }) => type)).toEqual([
      'pointerenter', 'pointermove', 'pointerleave', 'focusin', 'focusout',
    ]);
    expect(replacement.selectedCount.textContent).toBe('0 of 1 selected');
    replacement.selectionCheckbox.checked = true;
    replacement.selectionCheckbox.dispatch('change');
    expect(replacement.selectedCount.textContent).toBe('1 of 1 selected');
  });

  it('keeps mutation refresh query preservation separate from Defaults authority', async () => {
    const initial = makePage({ tag: '8', page: '4', view: 'grid' });
    initial.search.value = 'active';
    const replacement = makePage({ tag: '8', page: '4', view: 'grid' });
    const { windowObject } = makeWindow(initial.document, new Map([['mutation-result', replacement.document]]));
    windowObject.fetch.mockResolvedValue(htmlResponse(
      'mutation-result',
      'http://creatorcrate.test/projects/1/assets?search=active&tag=8&page=4&view=grid',
    ));
    enhanceProjectAssetsLiveFiltering(initial.document);

    expect(refreshProjectAssetsLiveRegion(initial.document)).toBe(true);
    await flush();

    const requested = new URL(windowObject.fetch.mock.calls[0][0]);
    expect(requested.searchParams.get('search')).toBe('active');
    expect(requested.searchParams.get('tag')).toBe('8');
    expect(requested.searchParams.get('page')).toBe('4');
    expect(requested.searchParams.get('view')).toBe('grid');
    expect(windowObject.history.pushes).toHaveLength(0);
    expect(windowObject.history.replaces).toHaveLength(0);
  });

  it('does not let a stale Defaults GET replace newer Project Assets navigation', async () => {
    const initial = makePage();
    const defaultsResult = makePage({ presence: 'present' });
    const navigationResult = makePage({ presence: 'missing' });
    const pages = new Map([
      ['defaults-result', defaultsResult.document],
      ['navigation-result', navigationResult.document],
    ]);
    const { windowObject } = makeWindow(initial.document, pages);
    const defaultsRequest = deferred();
    windowObject.fetch
      .mockImplementationOnce(() => defaultsRequest.promise)
      .mockResolvedValueOnce(htmlResponse(
        'navigation-result',
        'http://creatorcrate.test/projects/1/assets?presence=missing',
      ));
    enhanceProjectAssetsLiveFiltering(initial.document);
    const authority = beginProjectAssetsDefaultsLiveRefresh(initial.document);
    refreshProjectAssetsDefaultsLiveRegion(
      initial.document,
      'http://creatorcrate.test/projects/1/assets?presence=present&notice=project_assets_defaults_saved',
      authority,
    );

    initial.presenceAll.checked = false;
    initial.presenceMissing.checked = true;
    initial.presenceMissing.dispatch('change');
    await flush();
    defaultsRequest.resolve(htmlResponse(
      'defaults-result',
      'http://creatorcrate.test/projects/1/assets?presence=present',
    ));
    await flush();

    expect(initial.document.querySelector('[data-project-assets-live-region]')).toBe(navigationResult.region);
    expect(windowObject.location.href).toBe('http://creatorcrate.test/projects/1/assets?presence=missing');
  });

  it('reports a superseded Defaults authority before starting another request', () => {
    const initial = makePage();
    const { windowObject } = makeWindow(initial.document);
    windowObject.fetch.mockImplementation(() => new Promise(() => {}));
    enhanceProjectAssetsLiveFiltering(initial.document);
    const authority = beginProjectAssetsDefaultsLiveRefresh(initial.document);

    initial.presenceAll.checked = false;
    initial.presenceMissing.checked = true;
    initial.presenceMissing.dispatch('change');

    expect(refreshProjectAssetsDefaultsLiveRegion(
      initial.document,
      'http://creatorcrate.test/projects/1/assets?presence=present',
      authority,
    )).toBe('superseded');
    expect(windowObject.fetch).toHaveBeenCalledTimes(1);
  });

  it('surfaces Defaults refresh failure without forcing document navigation', async () => {
    const initial = makePage();
    const { windowObject } = makeWindow(initial.document);
    windowObject.location.assign = vi.fn();
    windowObject.fetch.mockRejectedValue(new Error('offline'));
    const onError = vi.fn();
    enhanceProjectAssetsLiveFiltering(initial.document);
    const authority = beginProjectAssetsDefaultsLiveRefresh(initial.document);

    expect(refreshProjectAssetsDefaultsLiveRegion(
      initial.document,
      'http://creatorcrate.test/projects/1/assets?presence=missing&notice=project_assets_defaults_saved',
      authority,
      { onError },
    )).toBe('started');
    await flush();

    expect(onError).toHaveBeenCalledOnce();
    expect(windowObject.location.assign).not.toHaveBeenCalled();
    expect(windowObject.location.href).toBe('http://creatorcrate.test/projects/1/assets?page=2');
    expect(initial.status.textContent).toBe('Defaults were saved, but Project Assets could not refresh. Refresh the page to see the saved defaults.');
    expect(initial.region.getAttribute('data-project-assets-live-state')).toBe('error');
  });

  it('updates the replacement external selected count instead of stale live-region markup', async () => {
    vi.useFakeTimers();
    const initial = makePage({ withAssetSelection: true });
    const replacement = makePage({ withAssetSelection: true });
    const { windowObject } = makeWindow(initial.document, new Map([
      ['replacement-selection', replacement.document],
    ]));
    windowObject.fetch.mockResolvedValue(htmlResponse(
      'replacement-selection',
      'http://creatorcrate.test/projects/1/assets?search=replaced',
    ));

    expect(enhanceProjectAssetsLiveFiltering(initial.document)).toBe(1);
    expect(initial.selectedCount.textContent).toBe('0 of 1 selected');

    initial.search.value = 'replaced';
    initial.search.dispatch('input');
    vi.advanceTimersByTime(350);
    await flush();

    expect(initial.document.querySelector('[data-selected-count]')).toBe(replacement.selectedCount);
    replacement.selectionCheckbox.checked = true;
    replacement.selectionCheckbox.dispatch('change');
    expect(replacement.selectedCount.textContent).toBe('1 of 1 selected');
    expect(initial.selectedCount.textContent).toBe('0 of 1 selected');
  });

  it('applies saved grid and list defaults when no valid localStorage choice exists', async () => {
    await withLocalStorage({}, async () => {
      const page = makePage({ gridSizeDefault: 'large', listSizeDefault: 'compact' });

      expect(enhanceProjectAssetsLiveFiltering(page.document)).toBe(1);
      expect(page.grid.getAttribute('data-grid-size')).toBe('large');
      expect(page.list.getAttribute('data-list-size')).toBe('compact');
    });
  });

  it('gives valid localStorage choices precedence and falls back through invalid values', async () => {
    await withLocalStorage({
      'creatorcrate-asset-grid-size': 'compact',
      'creatorcrate-asset-list-size': 'invalid',
    }, async () => {
      const page = makePage({ gridSizeDefault: 'large', listSizeDefault: 'compact' });

      enhanceProjectAssetsLiveFiltering(page.document);
      expect(page.grid.getAttribute('data-grid-size')).toBe('compact');
      expect(page.list.getAttribute('data-list-size')).toBe('compact');
    });

    await withLocalStorage({
      'creatorcrate-asset-grid-size': 'invalid',
      'creatorcrate-asset-list-size': 'invalid',
    }, async () => {
      const page = makePage({ gridSizeDefault: 'invalid', listSizeDefault: 'invalid' });

      enhanceProjectAssetsLiveFiltering(page.document);
      expect(page.grid.getAttribute('data-grid-size')).toBeNull();
      expect(page.list.getAttribute('data-list-size')).toBe('large');
    });
  });

  it('keeps delegated Search and category controls interactive through repeated external-form reconciliation', async () => {
    vi.useFakeTimers();
    const initial = makePage({
      resetUrl: '/projects/1/assets?resetFilters=1&view=list',
      projectsResetUrl: '/projects?sort=title',
    });
    const afterFirst = makePage({
      resetUrl: '/projects/1/assets?resetFilters=1&view=grid',
      projectsResetUrl: '/projects?sort=updated',
    });
    const afterSecond = makePage({
      resetUrl: '/projects/1/assets?resetFilters=1&view=list&pageSize=50',
      projectsResetUrl: '/projects?sort=created',
    });
    const afterThird = makePage({
      resetUrl: '/projects/1/assets?resetFilters=1&view=grid&pageSize=10',
      projectsResetUrl: '/projects?sort=title&order=desc',
    });
    const pages = new Map([
      ['after-first', afterFirst.document],
      ['after-second', afterSecond.document],
      ['after-third', afterThird.document],
    ]);
    const { windowObject } = makeWindow(initial.document, pages);
    windowObject.fetch
      .mockResolvedValueOnce(htmlResponse('after-first', 'http://creatorcrate.test/projects/1/assets?search=first&view=grid'))
      .mockResolvedValueOnce(htmlResponse('after-second', 'http://creatorcrate.test/projects/1/assets?search=second&view=list&pageSize=50'))
      .mockResolvedValueOnce(htmlResponse('after-third', 'http://creatorcrate.test/projects/1/assets?search=third&view=grid&pageSize=10'));

    expect(enhanceProjectAssetsLiveFiltering(initial.document)).toBe(1);
    expect(enhanceProjectAssetsLiveFiltering(initial.document)).toBe(1);
    expect(initial.form.listeners.filter(({ type }) => type === 'input')).toHaveLength(1);
    expect(initial.form.listeners.filter(({ type }) => type === 'change')).toHaveLength(1);
    expect(initial.form.listeners.filter(({ type }) => type === 'submit')).toHaveLength(1);

    initial.search.value = 'first';
    initial.search.dispatch('input');
    vi.advanceTimersByTime(349);
    expect(windowObject.fetch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await flush();

    expect(windowObject.fetch).toHaveBeenCalledTimes(1);
    expect(new URL(windowObject.fetch.mock.calls[0][0]).searchParams.get('search')).toBe('first');
    expect(initial.document.querySelector('#asset-filters')).toBe(initial.form);
    expect(initial.document.querySelector('#project-assets-filter-dialog')).toBe(initial.dialog);
    expect(initial.dialog.open).toBe(true);
    expect(initial.resetForm.getAttribute('action')).toBe('/projects/1/assets?resetFilters=1&view=grid');
    expect(initial.projectsResetForm.getAttribute('action')).toBe('/projects?sort=title');
    expect(initial.document.querySelector('#search')).toBe(afterFirst.search);
    expect(afterFirst.categoryRenders.listeners.filter(({ type }) => type === 'change')).toHaveLength(1);
    expect(afterFirst.presenceMissing.listeners.filter(({ type }) => type === 'change')).toHaveLength(1);

    const firstReplacementSearch = initial.document.querySelector('#search');
    firstReplacementSearch.value = 'second';
    firstReplacementSearch.dispatch('input');
    vi.advanceTimersByTime(350);
    await flush();

    expect(windowObject.fetch).toHaveBeenCalledTimes(2);
    expect(new URL(windowObject.fetch.mock.calls[1][0]).searchParams.get('search')).toBe('second');
    expect(initial.document.querySelector('#asset-filters')).toBe(initial.form);
    expect(initial.dialog.open).toBe(true);
    expect(initial.resetForm.getAttribute('action')).toBe('/projects/1/assets?resetFilters=1&view=list&pageSize=50');
    expect(initial.projectsResetForm.getAttribute('action')).toBe('/projects?sort=title');
    expect(initial.document.querySelector('#search')).toBe(afterSecond.search);
    expect(afterSecond.categoryRenders.listeners.filter(({ type }) => type === 'change')).toHaveLength(1);
    expect(afterSecond.presenceMissing.listeners.filter(({ type }) => type === 'change')).toHaveLength(1);

    const secondReplacementSearch = initial.document.querySelector('#search');
    secondReplacementSearch.value = 'third-a';
    secondReplacementSearch.dispatch('input');
    vi.advanceTimersByTime(100);
    secondReplacementSearch.value = 'third-b';
    secondReplacementSearch.dispatch('input');
    vi.advanceTimersByTime(100);
    secondReplacementSearch.value = 'third';
    secondReplacementSearch.dispatch('input');
    vi.advanceTimersByTime(349);
    expect(windowObject.fetch).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    await flush();

    expect(windowObject.fetch).toHaveBeenCalledTimes(3);
    expect(new URL(windowObject.fetch.mock.calls[2][0]).searchParams.get('search')).toBe('third');
    expect(initial.document.querySelector('#search')).toBe(afterThird.search);
    expect(initial.dialog.open).toBe(true);
    expect(initial.resetForm.getAttribute('action')).toBe('/projects/1/assets?resetFilters=1&view=grid&pageSize=10');
    expect(initial.projectsResetForm.getAttribute('action')).toBe('/projects?sort=title');
    expect(afterThird.categoryRenders.listeners.filter(({ type }) => type === 'change')).toHaveLength(1);
    expect(afterThird.presenceMissing.listeners.filter(({ type }) => type === 'change')).toHaveLength(1);

    enhanceProjectAssetsLiveFiltering(initial.document);
    enhanceProjectAssetsLiveFiltering(initial.document);
    expect(initial.form.listeners.filter(({ type }) => type === 'input')).toHaveLength(1);
    expect(initial.form.listeners.filter(({ type }) => type === 'change')).toHaveLength(1);
    expect(initial.form.listeners.filter(({ type }) => type === 'submit')).toHaveLength(1);
    expect(afterThird.categoryRenders.listeners.filter(({ type }) => type === 'change')).toHaveLength(1);
    expect(afterThird.presenceMissing.listeners.filter(({ type }) => type === 'change')).toHaveLength(1);
  });

  it('suspends inherited defaults through live category navigation and preserves provenance for All Categories', async () => {
    const initial = makePage({ tag: '8', extension: 'png', inheritedFilterDefaults: 'tag,extension' });
    const category = makePage({ inheritedFilterDefaults: 'tag,extension' });
    const restored = makePage({ tag: '8', extension: 'png', inheritedFilterDefaults: 'tag,extension' });
    const pages = new Map([
      ['category', category.document],
      ['restored', restored.document],
    ]);
    const { windowObject } = makeWindow(initial.document, pages);
    windowObject.fetch
      .mockResolvedValueOnce(htmlResponse(
        'category',
        'http://creatorcrate.test/projects/1/assets?category=7&inheritedFilterDefaults=tag%2Cextension&view=list&pageSize=25',
      ))
      .mockResolvedValueOnce(htmlResponse(
        'restored',
        'http://creatorcrate.test/projects/1/assets?category=all&tag=8&extension=png&inheritedFilterDefaults=tag%2Cextension&view=list&pageSize=25',
      ));

    expect(enhanceProjectAssetsLiveFiltering(initial.document)).toBe(1);
    initial.categoryAll.checked = false;
    initial.categoryRenders.checked = true;
    initial.categoryRenders.dispatch('change');
    await flush();

    const categoryRequest = new URL(windowObject.fetch.mock.calls[0][0]);
    expect(categoryRequest.searchParams.get('category')).toBe('7');
    expect(categoryRequest.searchParams.has('tag')).toBe(false);
    expect(categoryRequest.searchParams.has('extension')).toBe(false);
    expect(categoryRequest.searchParams.get('inheritedFilterDefaults')).toBe('tag,extension');

    category.categoryRenders.checked = false;
    category.categoryAll.checked = true;
    category.categoryAll.dispatch('change');
    await flush();

    const restoredRequest = new URL(windowObject.fetch.mock.calls[1][0]);
    expect(restoredRequest.searchParams.get('category')).toBe('all');
    expect(restoredRequest.searchParams.has('tag')).toBe(false);
    expect(restoredRequest.searchParams.has('extension')).toBe(false);
    expect(restoredRequest.searchParams.get('inheritedFilterDefaults')).toBe('tag,extension');
  });


  it('does not restore an explicitly changed extension after category navigation', async () => {
    const initial = makePage({ extension: 'png', inheritedFilterDefaults: 'extension' });
    const afterExtension = makePage({ extension: 'jpg' });
    const afterCategory = makePage();
    const afterAll = makePage();
    const pages = new Map([
      ['extension', afterExtension.document],
      ['category', afterCategory.document],
      ['all', afterAll.document],
    ]);
    const { windowObject } = makeWindow(initial.document, pages);
    windowObject.fetch
      .mockResolvedValueOnce(htmlResponse(
        'extension',
        'http://creatorcrate.test/projects/1/assets?extension=jpg&view=list&pageSize=25',
      ))
      .mockResolvedValueOnce(htmlResponse(
        'category',
        'http://creatorcrate.test/projects/1/assets?category=7&extension=jpg&view=list&pageSize=25',
      ))
      .mockResolvedValueOnce(htmlResponse(
        'all',
        'http://creatorcrate.test/projects/1/assets?category=all&view=list&pageSize=25',
      ));

    enhanceProjectAssetsLiveFiltering(initial.document);
    initial.extensionInput.value = 'jpg';
    initial.extensionInput.dispatch('change');
    await flush();
    afterExtension.categoryAll.checked = false;
    afterExtension.categoryRenders.checked = true;
    afterExtension.categoryRenders.dispatch('change');
    await flush();
    afterCategory.categoryRenders.checked = false;
    afterCategory.categoryAll.checked = true;
    afterCategory.categoryAll.dispatch('change');
    await flush();

    const categoryRequest = new URL(windowObject.fetch.mock.calls[1][0]);
    expect(categoryRequest.searchParams.get('extension')).toBe('jpg');
    expect(categoryRequest.searchParams.has('inheritedFilterDefaults')).toBe(false);

    const allRequest = new URL(windowObject.fetch.mock.calls[2][0]);
    expect(allRequest.searchParams.get('category')).toBe('all');
    expect(allRequest.searchParams.has('extension')).toBe(false);
    expect(allRequest.searchParams.has('inheritedFilterDefaults')).toBe(false);
  });

  it('does not restore an explicitly changed tag after category navigation', async () => {
    const initial = makePage({ tag: '8', inheritedFilterDefaults: 'tag' });
    const afterTag = makePage({ tag: '9' });
    const afterCategory = makePage();
    const afterAll = makePage();
    const pages = new Map([
      ['tag', afterTag.document],
      ['category', afterCategory.document],
      ['all', afterAll.document],
    ]);
    const { windowObject } = makeWindow(initial.document, pages);
    windowObject.fetch
      .mockResolvedValueOnce(htmlResponse(
        'tag',
        'http://creatorcrate.test/projects/1/assets?tag=9&view=list&pageSize=25',
      ))
      .mockResolvedValueOnce(htmlResponse(
        'category',
        'http://creatorcrate.test/projects/1/assets?category=7&tag=9&view=list&pageSize=25',
      ))
      .mockResolvedValueOnce(htmlResponse(
        'all',
        'http://creatorcrate.test/projects/1/assets?category=all&view=list&pageSize=25',
      ));

    enhanceProjectAssetsLiveFiltering(initial.document);
    initial.tagInput.value = '9';
    initial.tagInput.dispatch('change');
    await flush();
    afterTag.categoryAll.checked = false;
    afterTag.categoryRenders.checked = true;
    afterTag.categoryRenders.dispatch('change');
    await flush();
    afterCategory.categoryRenders.checked = false;
    afterCategory.categoryAll.checked = true;
    afterCategory.categoryAll.dispatch('change');
    await flush();

    const categoryRequest = new URL(windowObject.fetch.mock.calls[1][0]);
    expect(categoryRequest.searchParams.get('tag')).toBe('9');
    expect(categoryRequest.searchParams.has('inheritedFilterDefaults')).toBe(false);

    const allRequest = new URL(windowObject.fetch.mock.calls[2][0]);
    expect(allRequest.searchParams.get('category')).toBe('all');
    expect(allRequest.searchParams.has('tag')).toBe(false);
    expect(allRequest.searchParams.has('inheritedFilterDefaults')).toBe(false);
  });

  it.each(['grid', 'list'])('Reset fetches its %s form action and keeps the persistent dialog open', async (view) => {
    const href = `/projects/1/assets?resetFilters=1&view=${view}`;
    const initial = makePage({ view, resetUrl: href });
    const next = makePage({ view, page: '1', resetUrl: href });
    const { windowObject } = makeWindow(initial.document, new Map([['reset', next.document]]));
    const responseUrl = `http://creatorcrate.test/projects/1/assets?sort=size&order=desc&pageSize=50&view=${view}`;
    windowObject.fetch.mockResolvedValue(htmlResponse('reset', responseUrl));
    expect(enhanceProjectAssetsLiveFiltering(initial.document)).toBe(1);
    initial.reset.dispatch('click', { target: initial.reset, button: 0 });
    await flush();
    expect(new URL(windowObject.fetch.mock.calls[0][0]).pathname + new URL(windowObject.fetch.mock.calls[0][0]).search).toBe(href);
    expect(windowObject.history.pushes.at(-1).url).toBe(responseUrl);
    expect(windowObject.history.pushes.at(-1).url).not.toContain('resetFilters');
    expect(initial.document.querySelector('[data-project-assets-live-region]')).toBe(next.region);
    expect(initial.document.querySelector('#asset-filters')).toBe(initial.form);
    expect(initial.document.querySelector('#project-assets-filter-dialog')).toBe(initial.dialog);
    expect(initial.dialog.open).toBe(true);
    expect(initial.resetForm.getAttribute('action')).toBe(href);
    enhanceProjectAssetsLiveFiltering(initial.document);
    expect(initial.reset.listeners.filter(({ type }) => type === 'click')).toHaveLength(1);
  });

  it('serializes category and presence changes, resets page, pushes the server URL, and rebinds the replacement', async () => {
    const initial = makePage();
    const next = makePage({ presence: 'missing' });
    const pages = new Map([['filtered', next.document]]);
    const { windowObject } = makeWindow(initial.document, pages);
    const responseUrl = 'http://creatorcrate.test/projects/1/assets?category=all&presence=missing&view=list&pageSize=25';
    windowObject.fetch.mockResolvedValue(htmlResponse('filtered', responseUrl));

    expect(enhanceProjectAssetsLiveFiltering(initial.document)).toBe(1);
    initial.categoryAll.checked = false;
    initial.categoryMissing.checked = true;
    initial.categoryMissing.dispatch('change');
    await flush();

    expect(initial.presenceMissing.checked).toBe(true);
    expect(windowObject.fetch).toHaveBeenCalledTimes(1);
    const requested = new URL(windowObject.fetch.mock.calls[0][0]);
    expect(requested.pathname).toBe('/projects/1/assets');
    expect(requested.searchParams.get('category')).toBe('all');
    expect(requested.searchParams.get('presence')).toBe('missing');
    expect(requested.searchParams.get('view')).toBe('list');
    expect(requested.searchParams.has('page')).toBe(false);
    expect(windowObject.history.pushes).toHaveLength(1);
    expect(windowObject.history.pushes[0].url).toBe(responseUrl);
    expect(initial.document.querySelector('[data-project-assets-live-region]')).toBe(next.region);

    enhanceProjectAssetsLiveFiltering(next.region);
    enhanceProjectAssetsLiveFiltering(next.region);
    expect(initial.document.querySelector('#asset-filters')).toBe(initial.form);
    expect(initial.form.listeners.filter(({ type }) => type === 'input')).toHaveLength(1);
    expect(initial.form.listeners.filter(({ type }) => type === 'change')).toHaveLength(1);
    expect(initial.form.listeners.filter(({ type }) => type === 'submit')).toHaveLength(1);
  });

  it('restores the saved list size when a live-filter replacement re-enhances the region', async () => {
    const initial = makePage();
    const next = makePage();
    const pages = new Map([['filtered-list-size', next.document]]);
    const { windowObject } = makeWindow(initial.document, pages);
    const storage = new Map([
      ['creatorcrate-asset-grid-size', 'large'],
      ['creatorcrate-asset-list-size', 'compact'],
    ]);
    const previousStorage = globalThis.localStorage;
    globalThis.localStorage = {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    };
    windowObject.fetch.mockResolvedValue(
      htmlResponse('filtered-list-size', 'http://creatorcrate.test/projects/1/assets?view=list&presence=missing'),
    );

    try {
      expect(enhanceProjectAssetsLiveFiltering(initial.document)).toBe(1);
      expect(initial.grid.getAttribute('data-grid-size')).toBe('large');
      expect(initial.list.getAttribute('data-list-size')).toBe('compact');
      initial.presenceMissing.checked = true;
      initial.presenceMissing.dispatch('change');
      await flush();

      expect(next.grid.getAttribute('data-grid-size')).toBe('large');
      expect(next.list.getAttribute('data-list-size')).toBe('compact');
      expect(next.listSlider.value).toBe('1');
      expect(next.listLabels.map((label) => label.getAttribute('aria-pressed')))
        .toEqual(['true', 'false']);
    } finally {
      if (previousStorage === undefined) delete globalThis.localStorage;
      else globalThis.localStorage = previousStorage;
    }
  });

  it('keeps category selection and Auto Rename hooks while switching grid and list sizes', () => {
    const page = makePage();
    const listItem = makeNode({
      tagName: 'li',
      attrs: {
        'data-auto-rename-asset': '',
        'data-auto-rename-asset-id': '7',
      },
    });
    const card = makeNode({
      attrs: {
        'data-asset-selectable-card': '',
        'data-asset-id': '7',
      },
    });
    const checkbox = makeNode({
      tagName: 'input',
      attrs: { type: 'checkbox', name: 'selectedAssetIds' },
    });
    const orderIndicator = makeNode({
      tagName: 'span',
      attrs: { 'data-auto-rename-order-indicator': '' },
    });
    card.appendChild(checkbox);
    listItem.appendChild(card);
    listItem.appendChild(orderIndicator);
    page.list.appendChild(listItem);

    const previousStorage = globalThis.localStorage;
    const storage = new Map();
    globalThis.localStorage = {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    };

    try {
      expect(enhanceAssetGridSize(page.document)).toBe(1);
      expect(enhanceAssetListSize(page.document)).toBe(1);
      for (const [sliderValue, expectedSize] of [['1', 'compact'], ['2', 'large']]) {
        page.listSlider.value = sliderValue;
        page.listSlider.dispatch('input');
        expect(page.list.getAttribute('data-list-size')).toBe(expectedSize);
        expect(storage.get('creatorcrate-asset-list-size')).toBe(expectedSize);
        expect(listItem.getAttribute('data-auto-rename-asset')).toBe('');
        expect(card.getAttribute('data-asset-selectable-card')).toBe('');
        expect(checkbox.getAttribute('name')).toBe('selectedAssetIds');
        expect(orderIndicator.getAttribute('data-auto-rename-order-indicator')).toBe('');
      }
      for (const [sliderValue, expectedSize] of [['1', 'compact'], ['2', 'default'], ['3', 'large']]) {
        page.gridSlider.value = sliderValue;
        page.gridSlider.dispatch('input');
        expect(page.grid.getAttribute('data-grid-size'))
          .toBe(expectedSize === 'default' ? null : expectedSize);
        expect(storage.get('creatorcrate-asset-grid-size')).toBe(expectedSize);
      }
      page.listLabels[0].dispatch('click');
      expect(page.list.getAttribute('data-list-size')).toBe('compact');
      page.gridLabels[2].dispatch('click');
      expect(page.grid.getAttribute('data-grid-size')).toBe('large');
    } finally {
      if (previousStorage === undefined) delete globalThis.localStorage;
      else globalThis.localStorage = previousStorage;
    }
  });

  it('debounces search, restores the current URL through popstate, and falls back to native submit without fetch', async () => {
    vi.useFakeTimers();
    const initial = makePage();
    const restored = makePage({ page: '1' });
    const pages = new Map([['search', initial.document], ['restored', restored.document]]);
    const { windowObject, setLocation } = makeWindow(initial.document, pages);
    windowObject.fetch
      .mockResolvedValueOnce(htmlResponse('search', 'http://creatorcrate.test/projects/1/assets?search=needle'))
      .mockResolvedValueOnce(htmlResponse('restored', 'http://creatorcrate.test/projects/1/assets?page=1'));
    enhanceProjectAssetsLiveFiltering(initial.document);

    initial.search.value = 'needle';
    initial.search.dispatch('input');
    expect(windowObject.fetch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(349);
    expect(windowObject.fetch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await flush();
    expect(windowObject.fetch).toHaveBeenCalledTimes(1);
    expect(new URL(windowObject.fetch.mock.calls[0][0]).searchParams.get('search')).toBe('needle');

    setLocation('http://creatorcrate.test/projects/1/assets?page=1');
    windowObject.dispatch('popstate');
    await flush();
    expect(windowObject.fetch).toHaveBeenCalledTimes(2);
    expect(windowObject.fetch.mock.calls[1][0]).toBe('http://creatorcrate.test/projects/1/assets?page=1');
    expect(initial.document.querySelector('[data-project-assets-live-region]')).toBe(restored.region);

    const fallback = makePage();
    const { windowObject: fallbackWindow } = makeWindow(fallback.document);
    fallbackWindow.fetch = undefined;
    enhanceProjectAssetsLiveFiltering(fallback.document);
    fallback.form.dispatch('change', { target: fallback.categoryRenders });
    expect(fallback.form.submit).toHaveBeenCalledTimes(1);
  });

  it('posts the NSFW state asynchronously, refreshes the region, and keeps history unchanged', async () => {
    const initial = makePage({ nsfwEnabled: false });
    const next = makePage({ nsfwEnabled: true });
    const pages = new Map([['nsfw', next.document]]);
    const { windowObject } = makeWindow(initial.document, pages);
    windowObject.fetch
      .mockResolvedValueOnce(jsonResponse({ status: 'success', enabled: true }))
      .mockResolvedValueOnce(htmlResponse('nsfw', 'http://creatorcrate.test/projects/1/assets?page=2'));
    enhanceProjectAssetsLiveFiltering(initial.document);

    initial.nsfwForm.dispatch('submit', { target: initial.nsfwToggle });
    await flush();

    expect(windowObject.fetch).toHaveBeenCalledTimes(2);
    expect(windowObject.fetch.mock.calls[0][0]).toBe('/projects/1/assets/nsfw-filter');
    expect(windowObject.fetch.mock.calls[0][1]).toEqual(expect.objectContaining({
      method: 'POST',
      headers: { Accept: 'application/json' },
    }));
    expect([...windowObject.fetch.mock.calls[0][1].body.entries()]).toEqual([
      ['_csrf', 'csrf-token'],
      ['enabled', '1'],
      ['returnTo', '/projects/1/assets?page=2'],
    ]);
    expect(windowObject.history.pushes).toHaveLength(0);
    expect(windowObject.history.replaces).toHaveLength(0);
    expect(initial.document.querySelector('[data-project-assets-live-region]')).toBe(next.region);
    expect(next.nsfwToggle.getAttribute('aria-pressed')).toBe('true');
    expect(next.nsfwValue.value).toBe('0');
    expect(next.nsfwForm.listeners.filter(({ type }) => type === 'submit')).toHaveLength(1);
  });
});

describe('Project Assets action select enhancement', () => {
  it('enhances both action selects with the shared disclosure contract and preserves canonical form values', () => {
    const fixture = makeActionSelectFixture();

    expect(fixture.release.native.hidden).toBe(false);
    expect(fixture.release.details.hidden).toBe(true);
    enhanceDropdowns(fixture.document);
    enhanceAssetSelection(fixture.document);

    expect(fixture.release.native.hidden).toBe(true);
    expect(fixture.release.details.hidden).toBe(false);
    expect(fixture.category.native.hidden).toBe(true);
    expect(fixture.category.details.hidden).toBe(false);
    expect(fixture.release.details.getAttribute('data-cc-dropdown')).toBe('');
    expect(fixture.release.details.getAttribute('data-cc-dropdown-mode')).toBe('single');
    expect(fixture.release.currentSummary.textContent).toBe('Select a release…');
    expect(fixture.category.currentSummary.textContent).toBe('Uncategorized');
    expect(fixture.form.querySelectorAll('input[name="releaseId"]').length).toBe(0);

    fixture.checkbox.checked = true;
    fixture.checkbox.dispatch('change');
    expect(fixture.submit.disabled).toBe(true);

    fixture.release.customOptions[0].input.checked = false;
    fixture.release.customOptions[1].input.checked = true;
    fixture.release.customOptions[1].input.dispatch('change');
    expect(fixture.release.native.value).toBe('5');
    expect(fixture.release.currentSummary.textContent).toBe('Launch release');
    expect(fixture.release.customOptions.filter(({ input }) => input.checked)).toHaveLength(1);
    expect(fixture.release.details.open).toBe(false);
    expect(fixture.submit.disabled).toBe(false);

    fixture.category.customOptions[0].input.checked = false;
    fixture.category.customOptions[1].input.checked = true;
    fixture.category.customOptions[1].input.dispatch('change');
    expect(fixture.category.native.value).toBe('7');
    expect(fixture.category.currentSummary.textContent).toBe('Renders');
    expect(fixture.category.customOptions.filter(({ input }) => input.checked)).toHaveLength(1);
    expect(fixture.category.details.open).toBe(false);
  });

  it('dismisses action menus on outside click or Escape and binds each disclosure once', () => {
    const fixture = makeActionSelectFixture();

    enhanceDropdowns(fixture.document);
    enhanceDropdowns(fixture.document);

    expect(fixture.document.listeners.filter(({ type }) => type === 'change')).toHaveLength(1);
    expect(fixture.document.listeners.filter(({ type }) => type === 'click')).toHaveLength(1);
    expect(fixture.document.listeners.filter(({ type }) => type === 'keydown')).toHaveLength(1);
    expect(fixture.document.listeners.filter(({ type }) => type === 'toggle')).toHaveLength(1);

    fixture.release.details.open = true;
    fixture.document.dispatch('click', makeNode());
    expect(fixture.release.details.open).toBe(false);

    fixture.release.details.open = true;
    const escape = fixture.document.dispatch('keydown', {
      target: fixture.release.customOptions[0].input,
      key: 'Escape',
    });
    expect(escape.defaultPrevented).toBe(true);
    expect(fixture.release.details.open).toBe(false);
    expect(fixture.release.details.querySelector('summary').focused).toBe(true);
  });

  it('re-enhances action selects after live-region replacement without duplicate listeners', async () => {
    const oldFixture = makeActionSelectFixture();
    enhanceDropdowns(oldFixture.document);

    // Same scope is idempotent: a second enhancement adds no duplicate listeners.
    expect(enhanceDropdowns(oldFixture.document)).toBe(2);
    expect(oldFixture.document.listeners.filter(({ type }) => type === 'change')).toHaveLength(1);

    // Simulate a live-region replacement: the new document's dropdowns are enhanced
    // exactly once and respond to input changes.
    const newFixture = makeActionSelectFixture();
    expect(enhanceDropdowns(newFixture.document)).toBe(2);
    expect(newFixture.document.listeners.filter(({ type }) => type === 'change')).toHaveLength(1);

    newFixture.release.customOptions[1].input.checked = true;
    newFixture.release.customOptions[0].input.checked = false;
    newFixture.document.dispatch('change', { target: newFixture.release.customOptions[1].input });
    expect(newFixture.release.native.value).toBe('5');

    // The old scope is unaffected and still has exactly one listener.
    expect(oldFixture.document.listeners.filter(({ type }) => type === 'change')).toHaveLength(1);
  });
});
