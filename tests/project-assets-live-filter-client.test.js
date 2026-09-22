import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  enhanceAssetGridSize,
  enhanceAssetListSize,
  enhanceProjectAssetsLiveFiltering,
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
    focus() {
      if (this.ownerDocument) this.ownerDocument.activeElement = this;
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
  searchValue = '',
  presence = 'all',
  usage = 'all',
  tag = '',
  tags = tag ? [tag] : [],
  extension = '',
  extensions = extension ? [extension] : [],
  sort = 'filename',
  order = 'asc',
  inheritedFilterDefaults = '',
  nsfwEnabled = false,
  page = '2',
  pageSize = '25',
  view = 'list',
  gridSizeDefault = 'default',
  listSizeDefault = 'large',
  withAssetInfoCard = false,
  withAssetSelection = false,
  withSlideshow = false,
  projectPreviewAssetId = null,
  dialogOpen = true,
  withPageSizeForm = false,
  paginationUrl = null,
  viewUrl = null,
  resetUrl = '/projects/1/assets?resetFilters=1&view=list',
  projectsResetUrl = null,
  filteredEmptyResetUrl = null,
} = {}) {
  const document = makeNode({ tagName: 'document' });
  document.nodeType = 9;
  document.ownerDocument = document;

  const region = makeNode({
    attrs: {
      'data-project-assets-live-region': '',
      'data-project-assets-test-view': view,
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
  const filteredEmptyReset = filteredEmptyResetUrl
    ? makeNode({ tagName: 'a', attrs: {
      href: filteredEmptyResetUrl,
      'data-project-assets-reset': '',
    } })
    : null;
  const search = addInput(form, { id: 'search', name: 'search', type: 'search' }, searchValue);
  addInput(form, { name: 'page', type: 'hidden' }, page);
  addInput(form, { name: 'view', type: 'hidden' }, view);
  addInput(form, { name: 'pageSize', type: 'hidden' }, pageSize);
  const tagInputs = tags.map((value) => addInput(form, { name: 'tag', type: 'hidden' }, value));
  const extensionInputs = extensions.map((value) => addInput(form, { name: 'extension', type: 'hidden' }, value));
  const tagInput = tagInputs[0] || addInput(form, { name: 'tag', type: 'hidden' }, '');
  const extensionInput = extensionInputs[0] || addInput(form, { name: 'extension', type: 'hidden' }, '');
  addInput(form, { name: 'sort', type: 'hidden' }, sort);
  addInput(form, { name: 'order', type: 'hidden' }, order);
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

  const usageField = makeNode();
  const usageAll = addInput(usageField, { name: 'usage', type: 'radio', value: 'all' }, 'all', usage === 'all');
  const usageUsed = addInput(usageField, { name: 'usage', type: 'radio', value: 'used' }, 'used', usage === 'used');
  const usageUnused = addInput(usageField, { name: 'usage', type: 'radio', value: 'unused' }, 'unused', usage === 'unused');
  form.appendChild(usageField);

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

  const pageSizeForm = withPageSizeForm
    ? makeNode({ tagName: 'form', attrs: { action: '/projects/1/assets', method: 'get', class: 'page-size-form' } })
    : null;
  const pageSizeControl = pageSizeForm
    ? addInput(pageSizeForm, { name: 'pageSize', type: 'hidden' }, pageSize)
    : null;
  if (pageSizeForm) {
    addInput(pageSizeForm, { name: 'category', type: 'hidden' }, '7');
    addInput(pageSizeForm, { name: 'search', type: 'hidden' }, 'needle');
    tags.forEach((value) => addInput(pageSizeForm, { name: 'tag', type: 'hidden' }, value));
    extensions.forEach((value) => addInput(pageSizeForm, { name: 'extension', type: 'hidden' }, value));
    addInput(pageSizeForm, { name: 'presence', type: 'hidden' }, presence);
    addInput(pageSizeForm, { name: 'usage', type: 'hidden' }, usage);
    addInput(pageSizeForm, { name: 'sort', type: 'hidden' }, sort);
    addInput(pageSizeForm, { name: 'order', type: 'hidden' }, order);
    addInput(pageSizeForm, { name: 'view', type: 'hidden' }, view);
  }
  const paginationLink = paginationUrl
    ? makeNode({ tagName: 'a', attrs: { href: paginationUrl, class: 'pagination-next' } })
    : null;
  const viewLink = viewUrl
    ? makeNode({ tagName: 'a', attrs: { href: viewUrl, class: 'view-switcher-option' } })
    : null;
  const pagination = paginationLink ? makeNode({ tagName: 'nav', attrs: { class: 'pagination' } }) : null;
  const viewSwitcher = viewLink ? makeNode({ tagName: 'nav', attrs: { class: 'view-switcher' } }) : null;
  if (paginationLink) pagination.appendChild(paginationLink);
  if (viewLink) viewSwitcher.appendChild(viewLink);
  const slideshowTrigger = withSlideshow
    ? makeNode({ tagName: 'button', attrs: { type: 'button', 'data-slideshow-trigger': '' } })
    : null;
  const slideshowScaffold = withSlideshow
    ? makeNode({ attrs: { 'data-slideshow-scaffold': '' } })
    : null;
  if (slideshowTrigger) region.appendChild(slideshowTrigger);
  if (slideshowScaffold) {
    const sequence = makeNode({ tagName: 'script', attrs: { 'data-slideshow-sequence': '' } });
    sequence.textContent = JSON.stringify([{ id: projectPreviewAssetId || 'initial-asset', filename: 'replacement.png', previewUrl: `/preview/${projectPreviewAssetId || 'initial-asset'}` }]);
    const preview = makeNode({ attrs: { 'data-slideshow-preview': '' } });
    const previous = makeNode({ tagName: 'button', attrs: { 'data-slideshow-prev': '' } });
    const slideshowStatus = makeNode({ tagName: 'span', attrs: { 'data-slideshow-status': '' } });
    const next = makeNode({ tagName: 'button', attrs: { 'data-slideshow-next': '' } });
    const close = makeNode({ tagName: 'button', attrs: { 'data-slideshow-close': '' } });
    slideshowScaffold.appendChild(sequence);
    slideshowScaffold.appendChild(preview);
    slideshowScaffold.appendChild(previous);
    slideshowScaffold.appendChild(slideshowStatus);
    slideshowScaffold.appendChild(next);
    slideshowScaffold.appendChild(close);
  }
  const projectPreviewLink = projectPreviewAssetId
    ? makeNode({ tagName: 'a', attrs: {
      href: `/assets/${projectPreviewAssetId}`,
      'data-project-assets-preview-id': projectPreviewAssetId,
    } })
    : null;
  if (projectPreviewLink) region.appendChild(projectPreviewLink);

  region.appendChild(status);
  region.appendChild(nsfwForm);
  region.appendChild(gridSizeControls);
  if (selectedCount) region.appendChild(selectedCount);
  if (selectionForm) region.appendChild(selectionForm);
  region.appendChild(grid);
  region.appendChild(listSizeControls);
  region.appendChild(list);
  if (filteredEmptyReset) region.appendChild(filteredEmptyReset);
  if (pageSizeForm) region.appendChild(pageSizeForm);
  if (projectsResetForm) document.appendChild(projectsResetForm);
  document.appendChild(region);
  if (pagination) document.appendChild(pagination);
  if (viewSwitcher) document.appendChild(viewSwitcher);
  if (slideshowScaffold) document.appendChild(slideshowScaffold);
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
    filteredEmptyReset,
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
    usageAll,
    usageUsed,
    usageUnused,
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
    pageSizeForm,
    pageSizeControl,
    paginationLink,
    viewLink,
    slideshowTrigger,
    projectPreviewLink,
    slideshowScaffold,
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

  it('rebinds general and Project preview slideshows on live replacement exactly once', async () => {
    vi.useFakeTimers();
    const initial = makePage({ withSlideshow: true });
    const replacement = makePage({ withSlideshow: true, projectPreviewAssetId: 'replacement-42' });
    const { windowObject } = makeWindow(initial.document, new Map([['slideshow', replacement.document]]));
    windowObject.fetch.mockResolvedValue(htmlResponse(
      'slideshow',
      'http://creatorcrate.test/projects/1/assets?search=replaced',
    ));
    enhanceProjectAssetsLiveFiltering(initial.document);

    expect(initial.slideshowTrigger.listeners.filter(({ type }) => type === 'click')).toHaveLength(1);
    expect(initial.projectPreviewLink).toBeNull();
    initial.search.value = 'replaced';
    initial.search.dispatch('input');
    vi.advanceTimersByTime(350);
    await flush();
    enhanceProjectAssetsLiveFiltering(initial.document);

    expect(replacement.slideshowTrigger.listeners.filter(({ type }) => type === 'click')).toHaveLength(1);
    const replacementRegion = initial.document.querySelector('[data-project-assets-live-region]');
    const replacementPreviewLink = replacementRegion.querySelector('[data-project-assets-preview-id]');
    expect(replacementRegion).toBe(replacement.region);
    expect(replacementPreviewLink).toBe(replacement.projectPreviewLink);
    expect(replacementPreviewLink).not.toBe(initial.projectPreviewLink);
    const previewEvent = replacementPreviewLink.dispatch('click', { button: 0 });
    expect(previewEvent.defaultPrevented).toBe(true);
    expect(initial.document.querySelector('[data-slideshow-status]').textContent).toBe('1 of 1');
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

  it('keeps delegated Search and category controls interactive through repeated external-form reconciliation', async () => {
    vi.useFakeTimers();
    const initial = makePage({ resetUrl: '/projects/1/assets?resetFilters=1&view=list' });
    const afterSearch = makePage({ resetUrl: '/projects/1/assets?resetFilters=1&view=grid' });
    const afterCategory = makePage({ resetUrl: '/projects/1/assets?resetFilters=1&view=grid' });
    afterSearch.search.value = 'first';
    const pages = new Map([['after-search', afterSearch.document], ['after-category', afterCategory.document]]);
    const { windowObject } = makeWindow(initial.document, pages);
    windowObject.fetch
      .mockResolvedValueOnce(htmlResponse('after-search', 'http://creatorcrate.test/projects/1/assets?search=first&view=grid'))
      .mockResolvedValueOnce(htmlResponse('after-category', 'http://creatorcrate.test/projects/1/assets?category=7&search=first&view=grid'));

    expect(enhanceProjectAssetsLiveFiltering(initial.document)).toBe(1);
    expect(enhanceProjectAssetsLiveFiltering(initial.document)).toBe(1);
    expect(initial.form.listeners.filter(({ type }) => type === 'input')).toHaveLength(1);
    initial.search.value = 'first';
    initial.search.dispatch('input');
    vi.advanceTimersByTime(350);
    await flush();

    expect(windowObject.fetch).toHaveBeenCalledTimes(1);
    expect(initial.document.querySelector('#asset-filters')).toBe(initial.form);
    expect(initial.document.querySelector('#project-assets-filter-dialog')).toBe(initial.dialog);
    expect(initial.dialog.open).toBe(true);
    expect(initial.resetForm.getAttribute('action')).toBe('/projects/1/assets?resetFilters=1&view=grid');
    expect(initial.document.querySelector('#search')).toBe(afterSearch.search);
    afterSearch.categoryAll.checked = false;
    afterSearch.categoryRenders.checked = true;
    afterSearch.categoryRenders.dispatch('change');
    await flush();

    const categoryRequest = new URL(windowObject.fetch.mock.calls[1][0]);
    expect(categoryRequest.searchParams.get('category')).toBe('7');
    expect(categoryRequest.searchParams.get('search')).toBe('first');
    expect(initial.document.querySelector('[data-project-assets-live-region]')).toBe(afterCategory.region);
    enhanceProjectAssetsLiveFiltering(initial.document);
    enhanceProjectAssetsLiveFiltering(initial.document);
    expect(initial.form.listeners.filter(({ type }) => type === 'input')).toHaveLength(1);
    expect(initial.form.listeners.filter(({ type }) => type === 'change')).toHaveLength(1);
    expect(initial.form.listeners.filter(({ type }) => type === 'submit')).toHaveLength(1);
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

  it('Reset fetches its action, restores canonical filters and view, and keeps the persistent dialog open', async () => {
    const href = '/projects/1/assets?resetFilters=1&view=list';
    const initial = makePage({
      searchValue: 'needle',
      presence: 'missing',
      extensions: ['png', 'webp'],
      view: 'list',
      resetUrl: href,
    });
    const next = makePage({ view: 'list', page: '1', resetUrl: href });
    const resetRequest = deferred();
    const { windowObject } = makeWindow(initial.document, new Map([['reset', next.document]]));
    const responseUrl = 'http://creatorcrate.test/projects/1/assets?view=list';
    windowObject.fetch.mockImplementationOnce(() => resetRequest.promise);
    expect(enhanceProjectAssetsLiveFiltering(initial.document)).toBe(1);

    expect(initial.form.querySelector('#search').value).toBe('needle');
    expect(initial.form.querySelector('input[name="presence"]:checked').value).toBe('missing');
    expect(initial.form.querySelectorAll('input[name="extension"]')
      .map((input) => input.value).filter(Boolean)).toEqual(['png', 'webp']);

    initial.reset.dispatch('click', { target: initial.reset, button: 0 });
    expect(new URL(windowObject.fetch.mock.calls[0][0]).pathname + new URL(windowObject.fetch.mock.calls[0][0]).search).toBe(href);
    expect(initial.region.getAttribute('aria-busy')).toBe('true');
    expect(initial.document.querySelector('#asset-filters')).toBe(initial.form);
    initial.form.querySelector('input[name="view"]').value = 'grid';
    expect(windowObject.fetch).toHaveBeenCalledTimes(1);

    resetRequest.resolve(htmlResponse('reset', responseUrl));
    await flush();

    expect(windowObject.history.pushes.at(-1).url).toBe(responseUrl);
    expect(windowObject.history.pushes.at(-1).url).not.toContain('resetFilters');
    const currentRegion = initial.document.querySelector('[data-project-assets-live-region]');
    const currentForm = initial.document.querySelector('#asset-filters');
    expect(currentRegion).toBe(next.region);
    expect(currentRegion.getAttribute('data-project-assets-test-view')).toBe('list');
    expect(currentForm).toBe(initial.form);
    expect(currentForm.querySelector('input[name="view"]').value).toBe('list');
    expect(currentForm.querySelector('#search').value).toBe('');
    expect(currentForm.querySelector('input[name="presence"]:checked').value).toBe('all');
    expect(currentForm.querySelectorAll('input[name="extension"]')
      .map((input) => input.value).filter(Boolean)).toEqual([]);
    expect(new URL(windowObject.location.href).searchParams.get('view')).toBe('list');
    expect(new URL(windowObject.location.href).searchParams.has('search')).toBe(false);
    expect(new URL(windowObject.location.href).searchParams.has('presence')).toBe(false);
    expect(new URL(windowObject.location.href).searchParams.has('extension')).toBe(false);
    expect(initial.document.querySelector('#project-assets-filter-dialog')).toBe(initial.dialog);
    expect(initial.dialog.open).toBe(true);
    expect(initial.resetForm.getAttribute('action')).toBe(href);
    enhanceProjectAssetsLiveFiltering(initial.document);
    expect(initial.reset.listeners.filter(({ type }) => type === 'click')).toHaveLength(1);
  });

  it('loads filtered-empty Reset through the delegated live path and replaces it with canonical results', async () => {
    vi.useFakeTimers();
    const resetHref = '/projects/1/assets?resetFilters=1&view=list';
    const initial = makePage({ searchValue: 'initial', presence: 'missing', view: 'list' });
    const filteredEmpty = makePage({
      searchValue: 'no-match',
      presence: 'missing',
      view: 'list',
      filteredEmptyResetUrl: resetHref,
    });
    const canonical = makePage({ view: 'list', page: '1' });
    const { windowObject } = makeWindow(initial.document, new Map([
      ['filtered-empty', filteredEmpty.document],
      ['canonical', canonical.document],
    ]));
    windowObject.fetch
      .mockResolvedValueOnce(htmlResponse(
        'filtered-empty',
        'http://creatorcrate.test/projects/1/assets?search=no-match&presence=missing&view=list',
      ))
      .mockResolvedValueOnce(htmlResponse(
        'canonical',
        'http://creatorcrate.test/projects/1/assets?view=list',
      ));

    expect(enhanceProjectAssetsLiveFiltering(initial.document)).toBe(1);
    initial.search.value = 'no-match';
    initial.search.dispatch('input');
    vi.advanceTimersByTime(350);
    await flush();

    const filteredEmptyRegion = initial.document.querySelector('[data-project-assets-live-region]');
    const filteredEmptyReset = filteredEmptyRegion.querySelector('[data-project-assets-reset]');
    expect(filteredEmptyRegion).toBe(filteredEmpty.region);
    expect(filteredEmptyReset).toBe(filteredEmpty.filteredEmptyReset);
    expect(filteredEmptyReset).not.toBe(initial.reset);
    expect(filteredEmptyReset.getAttribute('href')).toBe(resetHref);

    const resetEvent = filteredEmptyReset.dispatch('click', { button: 0 });
    await flush();

    expect(resetEvent.defaultPrevented).toBe(true);
    expect(windowObject.fetch).toHaveBeenCalledTimes(2);
    expect(new URL(windowObject.fetch.mock.calls[1][0]).pathname + new URL(windowObject.fetch.mock.calls[1][0]).search)
      .toBe(resetHref);
    const currentRegion = initial.document.querySelector('[data-project-assets-live-region]');
    const currentForm = initial.document.querySelector('#asset-filters');
    expect(currentRegion).toBe(canonical.region);
    expect(currentRegion.querySelector('[data-project-assets-reset]')).toBeNull();
    expect(currentForm.querySelector('#search').value).toBe('');
    expect(currentForm.querySelector('input[name="presence"]:checked').value).toBe('all');
    expect(currentForm.querySelector('input[name="view"]').value).toBe('list');
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

  it('serializes the complete active Project Assets filter state without retaining the prior page', async () => {
    const initial = makePage({
      searchValue: 'retain-search',
      presence: 'missing',
      usage: 'used',
      tags: ['8', '9'],
      extensions: ['png', 'webp'],
      sort: 'size',
      order: 'desc',
      page: '4',
      pageSize: '50',
      view: 'list',
    });
    const next = makePage({ usage: 'unused', page: '1', pageSize: '50', view: 'list' });
    const { windowObject } = makeWindow(initial.document, new Map([['complete-state', next.document]]));
    windowObject.fetch.mockResolvedValue(htmlResponse(
      'complete-state',
      'http://creatorcrate.test/projects/1/assets?category=all&tag=8&tag=9&extension=png&extension=webp&presence=missing&usage=unused&sort=size&order=desc&pageSize=50&view=list',
    ));
    enhanceProjectAssetsLiveFiltering(initial.document);

    initial.usageUsed.checked = false;
    initial.usageUnused.checked = true;
    initial.usageUnused.dispatch('change');
    await flush();

    const requested = new URL(windowObject.fetch.mock.calls[0][0]);
    expect(requested.searchParams.get('category')).toBe('all');
    expect(requested.searchParams.get('search')).toBe('retain-search');
    expect(requested.searchParams.getAll('tag')).toEqual(['8', '9']);
    expect(requested.searchParams.getAll('extension')).toEqual(['png', 'webp']);
    expect(requested.searchParams.get('presence')).toBe('missing');
    expect(requested.searchParams.get('usage')).toBe('unused');
    expect(requested.searchParams.get('sort')).toBe('size');
    expect(requested.searchParams.get('order')).toBe('desc');
    expect(requested.searchParams.get('pageSize')).toBe('50');
    expect(requested.searchParams.get('view')).toBe('list');
    expect(requested.searchParams.has('page')).toBe(false);
    expect(initial.document.querySelector('[data-project-assets-live-region]')).toBe(next.region);
  });

  it('loads Project Assets page-size, pagination, and view URLs through the authoritative live request path', async () => {
    const initial = makePage({
      presence: 'missing',
      usage: 'used',
      tags: ['8'],
      extensions: ['png'],
      sort: 'size',
      order: 'desc',
      page: '4',
      pageSize: '25',
      view: 'grid',
      withPageSizeForm: true,
      paginationUrl: '/projects/1/assets?category=7&search=needle&tag=8&extension=png&presence=missing&usage=used&sort=size&order=desc&page=3&pageSize=50&view=grid',
      viewUrl: '/projects/1/assets?category=7&search=needle&tag=8&extension=png&presence=missing&usage=used&sort=size&order=desc&pageSize=50&view=list',
    });
    const afterPageSize = makePage({ page: '1', pageSize: '50', view: 'grid', paginationUrl: initial.paginationLink.getAttribute('href'), viewUrl: initial.viewLink.getAttribute('href') });
    const afterPagination = makePage({ page: '3', pageSize: '50', view: 'grid', viewUrl: initial.viewLink.getAttribute('href') });
    const afterView = makePage({ page: '1', pageSize: '50', view: 'list' });
    const { windowObject } = makeWindow(initial.document, new Map([
      ['page-size', afterPageSize.document],
      ['pagination', afterPagination.document],
      ['view', afterView.document],
    ]));
    windowObject.fetch
      .mockResolvedValueOnce(htmlResponse('page-size', 'http://creatorcrate.test/projects/1/assets?category=7&search=needle&pageSize=50&view=grid'))
      .mockResolvedValueOnce(htmlResponse('pagination', initial.paginationLink.getAttribute('href')))
      .mockResolvedValueOnce(htmlResponse('view', initial.viewLink.getAttribute('href')));

    expect(enhanceProjectAssetsLiveFiltering(initial.document)).toBe(2);
    initial.pageSizeControl.value = '50';
    initial.pageSizeControl.dispatch('change');
    await flush();
    const pageSizeRequest = new URL(windowObject.fetch.mock.calls[0][0]);
    expect(pageSizeRequest.searchParams.get('category')).toBe('7');
    expect(pageSizeRequest.searchParams.get('search')).toBe('needle');
    expect(pageSizeRequest.searchParams.getAll('tag')).toEqual(['8']);
    expect(pageSizeRequest.searchParams.getAll('extension')).toEqual(['png']);
    expect(pageSizeRequest.searchParams.get('presence')).toBe('missing');
    expect(pageSizeRequest.searchParams.get('usage')).toBe('used');
    expect(pageSizeRequest.searchParams.get('sort')).toBe('size');
    expect(pageSizeRequest.searchParams.get('order')).toBe('desc');
    expect(pageSizeRequest.searchParams.get('pageSize')).toBe('50');
    expect(pageSizeRequest.searchParams.get('view')).toBe('grid');
    expect(pageSizeRequest.searchParams.has('page')).toBe(false);
    expect(initial.document.querySelector('[data-project-assets-live-region]')).toBe(afterPageSize.region);

    initial.paginationLink.dispatch('click', { button: 0 });
    await flush();
    expect(new URL(windowObject.fetch.mock.calls[1][0]).pathname + new URL(windowObject.fetch.mock.calls[1][0]).search)
      .toBe(initial.paginationLink.getAttribute('href'));
    expect(initial.document.querySelector('[data-project-assets-live-region]')).toBe(afterPagination.region);

    initial.viewLink.dispatch('click', { button: 0 });
    await flush();
    expect(new URL(windowObject.fetch.mock.calls[2][0]).pathname + new URL(windowObject.fetch.mock.calls[2][0]).search)
      .toBe(initial.viewLink.getAttribute('href'));
    expect(initial.document.querySelector('[data-project-assets-live-region]')).toBe(afterView.region);
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
    const setItem = vi.fn((key, value) => storage.set(key, value));
    const previousStorage = globalThis.localStorage;
    globalThis.localStorage = {
      getItem: (key) => storage.get(key) ?? null,
      setItem,
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

      const replacementRegion = initial.document.querySelector('[data-project-assets-live-region]');
      expect(replacementRegion).toBe(next.region);
      const replacementGridSlider = replacementRegion.querySelector(
        '[data-asset-grid-size-controls] [data-grid-size-slider]',
      );
      const replacementListSlider = replacementRegion.querySelector(
        '[data-asset-list-size-controls] [data-grid-size-slider]',
      );
      expect(replacementGridSlider).toBe(next.gridSlider);
      expect(replacementGridSlider).not.toBe(initial.gridSlider);
      expect(replacementListSlider).toBe(next.listSlider);
      expect(replacementListSlider).not.toBe(initial.listSlider);

      replacementGridSlider.value = '1';
      replacementGridSlider.dispatch('input');
      expect(next.grid.getAttribute('data-grid-size')).toBe('compact');
      expect(storage.get('creatorcrate-asset-grid-size')).toBe('compact');
      expect(storage.get('creatorcrate-asset-list-size')).toBe('compact');
      expect(setItem).toHaveBeenCalledTimes(1);
      expect(setItem).toHaveBeenLastCalledWith('creatorcrate-asset-grid-size', 'compact');

      replacementListSlider.value = '2';
      replacementListSlider.dispatch('input');
      expect(next.list.getAttribute('data-list-size')).toBe('large');
      expect(storage.get('creatorcrate-asset-grid-size')).toBe('compact');
      expect(storage.get('creatorcrate-asset-list-size')).toBe('large');
      expect(setItem).toHaveBeenCalledTimes(2);
      expect(setItem).toHaveBeenLastCalledWith('creatorcrate-asset-list-size', 'large');

      enhanceAssetGridSize(replacementRegion);
      enhanceAssetListSize(replacementRegion);

      replacementGridSlider.value = '3';
      replacementGridSlider.dispatch('input');
      expect(next.grid.getAttribute('data-grid-size')).toBe('large');
      expect(storage.get('creatorcrate-asset-grid-size')).toBe('large');
      expect(storage.get('creatorcrate-asset-list-size')).toBe('large');
      expect(setItem).toHaveBeenCalledTimes(3);
      expect(setItem).toHaveBeenLastCalledWith('creatorcrate-asset-grid-size', 'large');

      replacementListSlider.value = '1';
      replacementListSlider.dispatch('input');
      expect(next.list.getAttribute('data-list-size')).toBe('compact');
      expect(storage.get('creatorcrate-asset-grid-size')).toBe('large');
      expect(storage.get('creatorcrate-asset-list-size')).toBe('compact');
      expect(setItem).toHaveBeenCalledTimes(4);
      expect(setItem).toHaveBeenLastCalledWith('creatorcrate-asset-list-size', 'compact');
    } finally {
      if (previousStorage === undefined) delete globalThis.localStorage;
      else globalThis.localStorage = previousStorage;
    }
  });

  it('keeps the newer live response authoritative when an older request resolves late', async () => {
    const initial = makePage();
    const stale = makePage({ searchValue: 'obsolete-alpha', presence: 'missing', view: 'grid' });
    const latest = makePage({ searchValue: 'current-bravo', presence: 'present', view: 'list' });
    const firstRequest = deferred();
    let firstSignal;
    const { windowObject } = makeWindow(initial.document, new Map([
      ['stale', stale.document],
      ['latest', latest.document],
    ]));
    windowObject.fetch
      .mockImplementationOnce((_url, options) => {
        firstSignal = options.signal;
        return firstRequest.promise;
      })
      .mockResolvedValueOnce(htmlResponse(
        'latest',
        'http://creatorcrate.test/projects/1/assets?search=current-bravo&presence=present&view=list',
      ));
    enhanceProjectAssetsLiveFiltering(initial.document);

    initial.presenceAll.checked = false;
    initial.presenceMissing.checked = true;
    initial.presenceMissing.dispatch('change');
    initial.presenceMissing.checked = false;
    initial.presencePresent.checked = true;
    initial.presencePresent.dispatch('change');
    expect(firstSignal.aborted).toBe(true);
    await flush();
    firstRequest.resolve(htmlResponse('stale', 'http://creatorcrate.test/projects/1/assets?presence=missing'));
    await flush();

    expect(initial.document.querySelector('[data-project-assets-live-region]')).toBe(latest.region);
    expect(latest.region.getAttribute('data-project-assets-test-view')).toBe('list');
    expect(initial.form.querySelector('#search')).toBe(latest.search);
    expect(initial.form.querySelector('#search').value).toBe('current-bravo');
    expect(initial.form.querySelector('input[name="presence"]:checked').value).toBe('present');
    expect(windowObject.location.href).toBe('http://creatorcrate.test/projects/1/assets?search=current-bravo&presence=present&view=list');
  });

  it('keeps the current region and returns the filter form to a usable error state when fetch fails', async () => {
    const initial = makePage();
    const { windowObject } = makeWindow(initial.document);
    windowObject.fetch.mockRejectedValue(new Error('offline'));
    enhanceProjectAssetsLiveFiltering(initial.document);

    initial.presenceAll.checked = false;
    initial.presenceMissing.checked = true;
    initial.presenceMissing.dispatch('change');
    await flush();

    expect(initial.document.querySelector('[data-project-assets-live-region]')).toBe(initial.region);
    expect(initial.region.hasAttribute('aria-busy')).toBe(false);
    expect(initial.region.getAttribute('data-project-assets-live-state')).toBe('error');
    expect(initial.status.textContent).toBe('Project Assets are loading as a full page.');
    expect(initial.form.submit).toHaveBeenCalledOnce();
  });

  it('debounces search, restores the current URL through popstate, and falls back to native submit without fetch', async () => {
    vi.useFakeTimers();
    const initial = makePage();
    const searched = makePage({ page: '1' });
    const restored = makePage({ page: '1' });
    const pages = new Map([['search', searched.document], ['restored', restored.document]]);
    const { windowObject, setLocation } = makeWindow(initial.document, pages);
    windowObject.fetch
      .mockResolvedValueOnce(htmlResponse('search', 'http://creatorcrate.test/projects/1/assets?search=needle'))
      .mockResolvedValueOnce(htmlResponse('restored', 'http://creatorcrate.test/projects/1/assets?page=1'));
    enhanceProjectAssetsLiveFiltering(initial.document);

    initial.search.focus();
    initial.search.value = 'stale';
    initial.search.dispatch('input');
    expect(windowObject.fetch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    initial.search.value = 'needle';
    initial.search.dispatch('input');
    vi.advanceTimersByTime(349);
    expect(windowObject.fetch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await flush();
    expect(windowObject.fetch).toHaveBeenCalledTimes(1);
    expect(new URL(windowObject.fetch.mock.calls[0][0]).searchParams.get('search')).toBe('needle');
    expect(initial.document.activeElement).toBe(searched.search);

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

  it('preserves View All through live replacement and Back/Forward restoration', async () => {
    const initial = makePage({ page: '1', pageSize: 'all' });
    const replacement = makePage({ page: '1', pageSize: 'all', presence: 'missing' });
    const restored = makePage({ page: '1', pageSize: 'all' });
    const pages = new Map([
      ['replacement-all', replacement.document],
      ['restored-all', restored.document],
    ]);
    const { windowObject, setLocation } = makeWindow(initial.document, pages);
    windowObject.fetch
      .mockResolvedValueOnce(htmlResponse(
        'replacement-all',
        'http://creatorcrate.test/projects/1/assets?presence=missing&pageSize=all',
      ))
      .mockResolvedValueOnce(htmlResponse(
        'restored-all',
        'http://creatorcrate.test/projects/1/assets?pageSize=all',
      ));
    enhanceProjectAssetsLiveFiltering(initial.document);

    initial.presenceMissing.checked = true;
    initial.presenceMissing.dispatch('change');
    await flush();

    expect(new URL(windowObject.fetch.mock.calls[0][0]).searchParams.get('pageSize')).toBe('all');
    expect(windowObject.history.pushes.at(-1).url).toContain('pageSize=all');
    expect(initial.document.querySelector('[data-project-assets-live-region]')).toBe(replacement.region);

    setLocation('http://creatorcrate.test/projects/1/assets?pageSize=all');
    windowObject.dispatch('popstate');
    await flush();

    expect(windowObject.fetch.mock.calls[1][0]).toBe('http://creatorcrate.test/projects/1/assets?pageSize=all');
    expect(initial.document.querySelector('[data-project-assets-live-region]')).toBe(restored.region);
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
