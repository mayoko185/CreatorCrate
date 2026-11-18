import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  beginProjectAssetsDefaultsLiveRefresh,
  enhanceAssetGridSize,
  enhanceAssetListSize,
  enhanceProjectAssetsLiveFiltering,
  enhanceProjectAssetsViewer,
  refreshProjectAssetsAfterMutation,
  refreshProjectAssetsDefaultsLiveRegion,
  refreshProjectAssetsLiveRegion,
} from '../src/static/creatorcrate.js';
import { retainedAssetSelectionIds } from '../src/static/client/asset-ordering.js';
import {
  PROJECT_ASSETS_FILTERS_RESET_EVENT,
  projectAssetsFiltersResetPending,
  refreshProjectAssetsWithLoadedDefaults,
  retainProjectAssetsDisplayedSizes,
} from '../src/static/client/live-regions.js';

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
    insertBefore(child, reference) {
      const previous = child.parentNode?.children;
      if (previous) previous.splice(previous.indexOf(child), 1);
      children.splice(children.indexOf(reference), 0, child);
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
    remove() {
      const siblings = this.parentNode?.children;
      if (siblings) siblings.splice(siblings.indexOf(this), 1);
      this.parentNode = null;
      this.parentElement = null;
    },
    createElement(tagName) {
      return makeNode({ tagName });
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
    dispatchEvent(event) {
      this.dispatch(event.type, event.detail === undefined ? {} : { detail: event.detail });
      return true;
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
  slideshowEntries = null,
  dialogOpen = true,
  withPageSizeForm = false,
  paginationUrl = null,
  viewUrl = null,
  resetUrl = '/projects/1/assets?resetFilters=1',
  projectsResetUrl = null,
  filteredEmptyResetUrl = null,
  withInlineCategory = false,
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

  // The results-header Category dropdown: same values and presence markers,
  // its own ids and radio group, outside #asset-filters.
  const inlineCategory = withInlineCategory
    ? (() => {
      const field = makeNode({ tagName: 'fieldset', attrs: { 'data-project-assets-inline-category': '' } });
      const details = makeNode({
        tagName: 'details',
        attrs: { id: 'project-assets-inline-category', 'data-cc-dropdown': '', 'data-cc-dropdown-mode': 'single' },
      });
      const summary = makeNode({ tagName: 'summary', attrs: { 'aria-label': 'Category filter: All categories' } });
      const current = makeNode({ attrs: { 'data-cc-dropdown-summary-current': '' } });
      summary.appendChild(current);
      details.appendChild(summary);
      const panel = makeNode();
      const makeInlineOption = (label, suffix, value, categoryPresence, selected) => {
        const option = makeNode({ attrs: { class: 'asset-filter-multiselect-option' } });
        const labelNode = makeNode({ tagName: 'label' });
        labelNode.textContent = label;
        const input = addInput(labelNode, {
          id: `project-assets-inline-category-option-${suffix}`,
          name: 'projectAssetsInlineCategory',
          type: 'radio',
          value,
          'data-asset-category-presence': categoryPresence,
        }, value, selected);
        option.appendChild(labelNode);
        panel.appendChild(option);
        return input;
      };
      const all = makeInlineOption('All categories', 'all', 'all', 'all', presence !== 'missing');
      const renders = makeInlineOption('Renders', '7', '7', 'all', false);
      const missing = makeInlineOption('Missing', 'missing', 'all', 'missing', presence === 'missing');
      details.appendChild(panel);
      field.appendChild(details);
      current.textContent = presence === 'missing' ? 'Missing' : 'All categories';
      return { field, details, summary, current, all, renders, missing };
    })()
    : null;

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
  // B5a: Project Assets drives the unified viewer. The Slideshow button is
  // part of the live region; the authoritative image sequence is page data
  // outside it.
  const slideshowTrigger = withSlideshow
    ? makeNode({ tagName: 'button', attrs: { type: 'button', 'data-project-assets-slideshow-trigger': '' } })
    : null;
  const slideshowSequence = withSlideshow
    ? makeNode({ tagName: 'script', attrs: {
      type: 'application/json',
      'data-project-assets-viewer-sequence': '',
      'data-project-id': '1',
      'data-viewer-label': 'Test Project',
    } })
    : null;
  if (slideshowTrigger) region.appendChild(slideshowTrigger);
  if (slideshowSequence) {
    slideshowSequence.textContent = JSON.stringify(slideshowEntries ?? [{
      id: Number(projectPreviewAssetId || 41),
      projectId: 1,
      filename: 'replacement.png',
      previewUrl: `/preview/${projectPreviewAssetId || 41}`,
    }]);
  }
  const projectPreviewLink = projectPreviewAssetId
    ? makeNode({ tagName: 'a', attrs: {
      href: `/assets/${projectPreviewAssetId}`,
      'data-project-assets-preview-id': projectPreviewAssetId,
    } })
    : null;
  if (projectPreviewLink) region.appendChild(projectPreviewLink);

  region.appendChild(status);
  if (inlineCategory) region.appendChild(inlineCategory.field);
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
  if (slideshowSequence) document.appendChild(slideshowSequence);
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
    inlineCategory,
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
    slideshowSequence,
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

const liveFailureNotice = (document) => document.querySelector('[data-live-filter-failure]');
const liveFailureRetries = (document) => document.querySelectorAll('[data-live-filter-retry]');

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

  it('reconciles the external category Filter and results after a confirmed category change', async () => {
    const initial = makePage();
    const refreshed = makePage();
    initial.categoryAll.checked = false;
    initial.categoryRenders.checked = true;
    refreshed.categoryAll.checked = false;
    refreshed.categoryRenders.checked = true;
    const renamed = refreshed.categoryRenders.closest('.asset-filter-multiselect-option');
    renamed.querySelector('label').textContent = 'Renamed (3) (disabled)';
    const options = refreshed.categoryFilter.querySelector('#asset-category-filter').children[1];
    options.children.splice(options.children.indexOf(renamed), 1);
    options.children.unshift(renamed);
    const added = makeNode({ attrs: { class: 'asset-filter-multiselect-option' } });
    addInput(added, { name: 'category', type: 'radio', value: '9', 'data-asset-category-presence': 'all' }, '9');
    const addedLabel = makeNode({ tagName: 'label' });
    addedLabel.textContent = 'New category (0)';
    added.appendChild(addedLabel);
    options.appendChild(added);
    const { windowObject } = makeWindow(initial.document, new Map([['categories', refreshed.document]]));
    windowObject.fetch.mockResolvedValue(htmlResponse(
      'categories',
      'http://creatorcrate.test/projects/1/assets?page=2',
    ));
    const manager = makeNode({ tagName: 'dialog', attrs: { id: 'project-asset-category-management-dialog' } });
    manager.open = true;
    initial.document.appendChild(manager);

    enhanceProjectAssetsLiveFiltering(initial.document);
    enhanceProjectAssetsLiveFiltering(initial.document);
    initial.document.dispatchEvent(new Event('project-asset-categories-changed'));
    await flush();

    expect(windowObject.fetch).toHaveBeenCalledTimes(1);
    expect(initial.document.querySelector('[data-project-assets-live-region]')).toBe(refreshed.region);
    expect(initial.document.querySelector('#asset-filters')).toBe(initial.form);
    expect(initial.form.querySelector('#asset-category-filter').children[1].children[0]).toBe(renamed);
    expect(renamed.querySelector('label').textContent).toBe('Renamed (3) (disabled)');
    expect(initial.form.querySelector('input[name="category"][value="9"]')).toBeTruthy();
    expect(refreshed.categoryRenders.checked).toBe(true);
    expect(manager.open).toBe(true);
    expect(initial.document.querySelector('#project-asset-category-management-dialog')).toBe(manager);
  });

  it('drops a deleted category selection from the server-rendered Filter', async () => {
    const initial = makePage();
    const refreshed = makePage();
    initial.categoryAll.checked = false;
    initial.categoryRenders.checked = true;
    const options = refreshed.categoryFilter.querySelector('#asset-category-filter').children[1];
    options.children.splice(options.children.indexOf(refreshed.categoryRenders.parentNode), 1);
    const { windowObject } = makeWindow(initial.document, new Map([['deleted-category', refreshed.document]]));
    windowObject.fetch.mockResolvedValue(htmlResponse(
      'deleted-category',
      'http://creatorcrate.test/projects/1/assets?category=all',
    ));
    enhanceProjectAssetsLiveFiltering(initial.document);

    initial.document.dispatchEvent(new Event('project-asset-categories-changed'));
    await flush();

    expect(initial.form.querySelector('input[name="category"][value="7"]')).toBeNull();
    expect(refreshed.categoryAll.checked).toBe(true);
    expect(initial.document.querySelector('[data-project-assets-live-region]')).toBe(refreshed.region);
  });

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

  // A stand-in for the unified viewer controller (its real lifecycle is
  // covered by unified-viewer-client.test.js and the Chromium specs).
  function attachFakeViewer(document) {
    let session = 0;
    let open = false;
    const viewer = {
      open: vi.fn(() => {
        session += 1;
        open = true;
        return session;
      }),
      update: vi.fn(() => ({ outcome: 'kept' })),
      getState: () => ({ open, session: open ? session : null }),
    };
    const dialog = makeNode({ tagName: 'dialog', attrs: { id: 'unified-viewer-dialog' } });
    dialog.__creatorCrateUnifiedViewer = viewer;
    document.getElementById = (id) => (id === 'unified-viewer-dialog' ? dialog : null);
    return viewer;
  }

  it('opens Project Assets images and Slideshow in the unified viewer across live replacement without rebinding', async () => {
    vi.useFakeTimers();
    const initial = makePage({ withSlideshow: true });
    const replacement = makePage({
      withSlideshow: true,
      projectPreviewAssetId: '42',
      slideshowEntries: [
        { id: 42, projectId: 1, filename: 'b.png', previewUrl: '/preview/42', viewerUrl: '/projects/1/assets/42', revision: 'r2' },
        { id: 41, projectId: 1, filename: 'a.png', previewUrl: '/preview/41', viewerUrl: '/projects/1/assets/41', revision: 'r1' },
      ],
    });
    const viewer = attachFakeViewer(initial.document);
    const { windowObject } = makeWindow(initial.document, new Map([['slideshow', replacement.document]]));
    windowObject.fetch.mockResolvedValue(htmlResponse(
      'slideshow',
      'http://creatorcrate.test/projects/1/assets?search=replaced',
    ));
    expect(enhanceProjectAssetsViewer(initial.document)).toBe(1);
    enhanceProjectAssetsLiveFiltering(initial.document);
    const documentClicks = () => initial.document.listeners.filter(({ type }) => type === 'click').length;
    const clicksAfterBinding = documentClicks();

    // The toolbar button opens the whole sequence as a slideshow.
    expect(initial.slideshowTrigger.disabled).toBe(false);
    expect(initial.slideshowTrigger.listeners.filter(({ type }) => type === 'click')).toHaveLength(0);
    const slideshowEvent = initial.slideshowTrigger.dispatch('click', { button: 0 });
    expect(slideshowEvent.defaultPrevented).toBe(true);
    expect(viewer.open).toHaveBeenCalledTimes(1);
    const [slideshowSource, slideshowOptions] = viewer.open.mock.calls[0];
    expect(slideshowSource).toMatchObject({ key: 'project-assets:1', label: 'Test Project', mode: 'sequence', slideshow: true, wrap: true });
    expect(slideshowSource.items.map((item) => item.assetId)).toEqual(['41']);
    expect(slideshowOptions.opener).toBe(initial.slideshowTrigger);

    initial.search.value = 'replaced';
    initial.search.dispatch('input');
    vi.advanceTimersByTime(350);
    await flush();

    // The replacement sequence (copied in outside the region) reaches the
    // open session once, in server order.
    expect(initial.slideshowSequence.textContent).toBe(replacement.slideshowSequence.textContent);
    expect(viewer.update).toHaveBeenCalledTimes(1);
    const [replacementData, updateOptions] = viewer.update.mock.calls[0];
    expect(replacementData.key).toBe('project-assets:1');
    expect(replacementData.items.map((item) => item.assetId)).toEqual([42, 41]);
    expect(replacementData.items[0]).toMatchObject({ mediaUrl: '/preview/42', detailsUrl: '/projects/1/assets/42', revision: 'r2' });
    expect(updateOptions).toEqual({ session: 1 });

    // Re-enhancing never adds listeners; replaced controls work through the
    // one delegated binding.
    enhanceProjectAssetsLiveFiltering(initial.document);
    expect(enhanceProjectAssetsViewer(initial.document)).toBe(1);
    expect(documentClicks()).toBe(clicksAfterBinding);
    expect(viewer.update).toHaveBeenCalledTimes(1);
    const replacementRegion = initial.document.querySelector('[data-project-assets-live-region]');
    const replacementPreviewLink = replacementRegion.querySelector('[data-project-assets-preview-id]');
    expect(replacementRegion).toBe(replacement.region);
    expect(replacementPreviewLink).toBe(replacement.projectPreviewLink);
    expect(replacementPreviewLink.listeners).toHaveLength(0);
    const previewEvent = replacementPreviewLink.dispatch('click', { button: 0 });
    expect(previewEvent.defaultPrevented).toBe(true);
    expect(viewer.open).toHaveBeenCalledTimes(2);
    const [singleSource, singleOptions] = viewer.open.mock.calls[1];
    expect(singleSource).toMatchObject({ mode: 'single', slideshow: false, wrap: false });
    expect(singleSource.items.map((item) => item.assetId)).toEqual(['42']);
    expect(singleOptions.opener).toBe(replacementPreviewLink);

    // Modified clicks keep the link's own navigation.
    const modified = replacementPreviewLink.dispatch('click', { button: 0, ctrlKey: true });
    expect(modified.defaultPrevented).toBe(false);
    expect(viewer.open).toHaveBeenCalledTimes(2);
  });

  it('disables the Project Assets Slideshow button while the filtered sequence has no image', async () => {
    vi.useFakeTimers();
    const initial = makePage({ withSlideshow: true });
    const replacement = makePage({ withSlideshow: true, slideshowEntries: [] });
    const viewer = attachFakeViewer(initial.document);
    const { windowObject } = makeWindow(initial.document, new Map([['empty', replacement.document]]));
    windowObject.fetch.mockResolvedValue(htmlResponse('empty', 'http://creatorcrate.test/projects/1/assets?search=none'));
    enhanceProjectAssetsViewer(initial.document);
    enhanceProjectAssetsLiveFiltering(initial.document);
    expect(initial.slideshowTrigger.disabled).toBe(false);

    initial.search.value = 'none';
    initial.search.dispatch('input');
    vi.advanceTimersByTime(350);
    await flush();

    expect(replacement.slideshowTrigger.disabled).toBe(true);
    expect(replacement.slideshowTrigger.dispatch('click', { button: 0 }).defaultPrevented).toBe(false);
    expect(viewer.open).not.toHaveBeenCalled();
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
    const href = '/projects/1/assets?resetFilters=1';
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

  describe('Package B Reset filters lifecycle', () => {
    const RESET_PATH = '/projects/1/assets?resetFilters=1';
    const requestPath = (call) => {
      const url = new URL(call[0]);
      return url.pathname + url.search;
    };
    function recordResetPhases(document) {
      const phases = [];
      document.addEventListener(PROJECT_ASSETS_FILTERS_RESET_EVENT, (event) => {
        phases.push(event.detail.phase);
      });
      return phases;
    }
    function changeView(page, value) {
      const input = page.form.querySelector('input[name="view"]');
      input.value = value;
      input.dispatch('change');
    }

    it.each([
      ['grid', 'list', 'grid'],
      ['list', 'grid', 'list'],
      ['grid', 'list', 'list'],
      ['list', 'grid', 'grid'],
    ])('rendered %s, pending %s: Reset requests no View and installs the saved/default %s', async (rendered, pendingView, savedView) => {
      const initial = makePage({ view: rendered, searchValue: 'needle', presence: 'missing', sort: 'size', order: 'desc' });
      const pendingPage = makePage({ view: pendingView, searchValue: 'needle', presence: 'missing' });
      const resetPage = makePage({ view: savedView, page: '1', sort: 'modified', order: 'desc', pageSize: '50' });
      const pendingRequest = deferred();
      const resetRequest = deferred();
      let pendingSignal;
      const { windowObject } = makeWindow(initial.document, new Map([
        ['pending', pendingPage.document],
        ['reset', resetPage.document],
      ]));
      windowObject.fetch
        .mockImplementationOnce((_url, options) => {
          pendingSignal = options.signal;
          return pendingRequest.promise;
        })
        .mockImplementationOnce(() => resetRequest.promise);
      enhanceProjectAssetsLiveFiltering(initial.document);
      const phases = recordResetPhases(initial.document);

      changeView(initial, pendingView);
      expect(new URL(windowObject.fetch.mock.calls[0][0]).searchParams.get('view')).toBe(pendingView);
      initial.reset.dispatch('click', { target: initial.reset, button: 0 });

      // The Reset carries no request-time View and owns the newest generation.
      expect(requestPath(windowObject.fetch.mock.calls[1])).toBe(RESET_PATH);
      expect(windowObject.fetch.mock.calls[1][1].method).toBe('GET');
      expect(pendingSignal.aborted).toBe(true);
      expect(phases).toEqual(['started']);
      expect(projectAssetsFiltersResetPending(initial.document)).toMatchObject({ phase: 'pending' });

      const canonical = `http://creatorcrate.test/projects/1/assets?view=${savedView}&sort=modified&order=desc&pageSize=50`;
      resetRequest.resolve(htmlResponse('reset', canonical));
      await flush();
      // The earlier View load resolves late and cannot undo the Reset.
      pendingRequest.resolve(htmlResponse('pending', `http://creatorcrate.test/projects/1/assets?view=${pendingView}`));
      await flush();

      expect(phases).toEqual(['started', 'prepared', 'installed']);
      expect(projectAssetsFiltersResetPending(initial.document)).toBeNull();
      expect(initial.document.querySelector('[data-project-assets-live-region]')).toBe(resetPage.region);
      expect(resetPage.region.getAttribute('data-project-assets-test-view')).toBe(savedView);
      const form = initial.document.querySelector('#asset-filters');
      expect(form.querySelector('input[name="view"]').value).toBe(savedView);
      expect(form.querySelector('input[name="sort"]').value).toBe('modified');
      expect(form.querySelector('input[name="pageSize"]').value).toBe('50');
      expect(form.querySelector('input[name="page"]').value).toBe('1');
      expect(form.querySelector('#search').value).toBe('');
      expect(form.querySelector('input[name="presence"]:checked').value).toBe('all');
      expect(windowObject.history.pushes.map(({ url }) => url)).toEqual([canonical]);
      expect(windowObject.location.href).toBe(canonical);
      expect(windowObject.fetch).toHaveBeenCalledTimes(2);
    });

    it('cancels a pending Search debounce and an in-flight Sort load so neither restores stale values', async () => {
      vi.useFakeTimers();
      try {
        const initial = makePage({ sort: 'size' });
        const resetPage = makePage({ page: '1', sort: 'filename', order: 'asc' });
        const sortRequest = deferred();
        let sortSignal;
        const { windowObject } = makeWindow(initial.document, new Map([['reset', resetPage.document]]));
        windowObject.fetch
          .mockImplementationOnce((_url, options) => {
            sortSignal = options.signal;
            return sortRequest.promise;
          })
          .mockResolvedValueOnce(htmlResponse('reset', 'http://creatorcrate.test/projects/1/assets?view=list'));
        enhanceProjectAssetsLiveFiltering(initial.document);

        const sort = initial.form.querySelector('input[name="sort"]');
        sort.value = 'modified';
        sort.dispatch('change');
        initial.search.value = 'stale';
        initial.search.dispatch('input');
        initial.reset.dispatch('click', { target: initial.reset, button: 0 });
        await flush();
        vi.advanceTimersByTime(1000);
        sortRequest.resolve(htmlResponse('reset', 'http://creatorcrate.test/projects/1/assets?sort=modified'));
        await flush();

        expect(sortSignal.aborted).toBe(true);
        expect(windowObject.fetch).toHaveBeenCalledTimes(2);
        expect(requestPath(windowObject.fetch.mock.calls[1])).toBe(RESET_PATH);
        expect(initial.document.querySelector('[data-project-assets-live-region]')).toBe(resetPage.region);
        expect(initial.form.querySelector('#search').value).toBe('');
        expect(initial.form.querySelector('input[name="sort"]').value).toBe('filename');
        expect(windowObject.history.pushes).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('a newer filter change supersedes a pending Reset whose late response never installs', async () => {
      const initial = makePage({ searchValue: 'needle' });
      const resetPage = makePage({ page: '1' });
      const newer = makePage({ searchValue: 'needle', presence: 'missing' });
      const resetRequest = deferred();
      let resetSignal;
      const { windowObject } = makeWindow(initial.document, new Map([
        ['reset', resetPage.document],
        ['newer', newer.document],
      ]));
      windowObject.fetch
        .mockImplementationOnce((_url, options) => {
          resetSignal = options.signal;
          return resetRequest.promise;
        })
        .mockResolvedValueOnce(htmlResponse('newer', 'http://creatorcrate.test/projects/1/assets?search=needle&presence=missing'));
      enhanceProjectAssetsLiveFiltering(initial.document);
      const phases = recordResetPhases(initial.document);

      initial.reset.dispatch('click', { target: initial.reset, button: 0 });
      initial.presenceAll.checked = false;
      initial.presenceMissing.checked = true;
      initial.presenceMissing.dispatch('change');
      await flush();
      resetRequest.resolve(htmlResponse('reset', 'http://creatorcrate.test/projects/1/assets'));
      await flush();

      expect(resetSignal.aborted).toBe(true);
      expect(phases).toEqual(['started', 'superseded']);
      expect(projectAssetsFiltersResetPending(initial.document)).toBeNull();
      expect(initial.document.querySelector('[data-project-assets-live-region]')).toBe(newer.region);
      expect(initial.form.querySelector('#search').value).toBe('needle');
      expect(windowObject.location.href).toBe('http://creatorcrate.test/projects/1/assets?search=needle&presence=missing');
    });

    it('a failed Reset keeps the installed state, never claims success, and retries the same GET', async () => {
      const initial = makePage({ searchValue: 'needle', presence: 'missing' });
      const resetPage = makePage({ page: '1' });
      const { windowObject } = makeWindow(initial.document, new Map([['reset', resetPage.document]]));
      windowObject.fetch
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValueOnce(htmlResponse('reset', 'http://creatorcrate.test/projects/1/assets'));
      enhanceProjectAssetsLiveFiltering(initial.document);
      const phases = recordResetPhases(initial.document);

      initial.reset.dispatch('click', { target: initial.reset, button: 0 });
      await flush();
      expect(phases).toEqual(['started', 'failed']);
      expect(projectAssetsFiltersResetPending(initial.document)).toBeNull();
      expect(initial.document.querySelector('[data-project-assets-live-region]')).toBe(initial.region);
      expect(initial.form.querySelector('#search').value).toBe('needle');
      expect(initial.presenceMissing.checked).toBe(true);
      expect(windowObject.history.pushes).toHaveLength(0);
      expect(liveFailureRetries(initial.document)).toHaveLength(1);

      liveFailureRetries(initial.document)[0].dispatch('click');
      await flush();
      expect(phases).toEqual(['started', 'failed', 'started', 'prepared', 'installed']);
      expect(windowObject.fetch.mock.calls.map(([, init]) => init.method)).toEqual(['GET', 'GET']);
      expect(requestPath(windowObject.fetch.mock.calls[1])).toBe(RESET_PATH);
      expect(initial.document.querySelector('[data-project-assets-live-region]')).toBe(resetPage.region);
      expect(windowObject.history.pushes.map(({ url }) => url)).toEqual(['http://creatorcrate.test/projects/1/assets']);
    });

    it('ordinary filter loads never start the Reset lifecycle', async () => {
      const initial = makePage();
      const next = makePage({ presence: 'missing' });
      const { windowObject } = makeWindow(initial.document, new Map([['next', next.document]]));
      windowObject.fetch.mockResolvedValueOnce(htmlResponse('next', 'http://creatorcrate.test/projects/1/assets?presence=missing'));
      enhanceProjectAssetsLiveFiltering(initial.document);
      const phases = recordResetPhases(initial.document);
      initial.presenceAll.checked = false;
      initial.presenceMissing.checked = true;
      initial.presenceMissing.dispatch('change');
      await flush();
      expect(phases).toEqual([]);
      expect(projectAssetsFiltersResetPending(initial.document)).toBeNull();
    });
  });

  it('loads filtered-empty Reset through the delegated live path and replaces it with canonical results', async () => {
    vi.useFakeTimers();
    const resetHref = '/projects/1/assets?resetFilters=1';
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
    expect(initial.status.textContent).toContain('The requested filters were not applied');
    expect(initial.form.submit).not.toHaveBeenCalled();
    expect(initial.presenceMissing.checked).toBe(true);
    expect(liveFailureRetries(initial.document)).toHaveLength(1);
  });

  it('retries a failed filter with GET only, then commits the history it still owes', async () => {
    const initial = makePage();
    const recovered = makePage();
    const { windowObject } = makeWindow(initial.document, new Map([['recovered', recovered.document]]));
    windowObject.fetch.mockRejectedValueOnce(new Error('offline'));
    enhanceProjectAssetsLiveFiltering(initial.document);
    initial.presenceAll.checked = false;
    initial.presenceMissing.checked = true;
    initial.presenceMissing.dispatch('change');
    await flush();
    const requested = windowObject.fetch.mock.calls[0][0];
    expect(windowObject.history.pushes).toHaveLength(0);

    windowObject.fetch.mockResolvedValueOnce(htmlResponse('recovered', requested));
    liveFailureRetries(initial.document)[0].dispatch('click');
    await flush();

    expect(windowObject.fetch.mock.calls[1][0]).toBe(requested);
    expect(windowObject.fetch.mock.calls[1][1].method).toBe('GET');
    expect(initial.document.querySelector('[data-project-assets-live-region]')).toBe(recovered.region);
    expect(liveFailureNotice(initial.document)).toBeNull();
    expect(windowObject.history.pushes).toHaveLength(1);
  });

  it('rejects a response redirected to another project without replacing the region', async () => {
    const initial = makePage();
    const other = makePage();
    const { windowObject } = makeWindow(initial.document, new Map([['other', other.document]]));
    windowObject.fetch.mockResolvedValueOnce(htmlResponse('other', 'http://creatorcrate.test/projects/2/assets'));
    enhanceProjectAssetsLiveFiltering(initial.document);
    initial.presenceAll.checked = false;
    initial.presenceMissing.checked = true;
    initial.presenceMissing.dispatch('change');
    await flush();

    expect(initial.document.querySelector('[data-project-assets-live-region]')).toBe(initial.region);
    expect(liveFailureRetries(initial.document)).toHaveLength(1);
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
  describe('in-place Grid style recovery after a failed Defaults refresh', () => {
    const DEFAULTS_ERROR = 'Defaults were saved, but Project Assets could not refresh. Refresh the page to see the saved defaults.';
    const NSFW_ERROR = 'NSFW filter changed, but Project Assets could not refresh. Refresh the page to see updated previews.';
    const restyle = (document) => refreshProjectAssetsDefaultsLiveRegion(
      document,
      '/projects/1/assets?view=grid',
      beginProjectAssetsDefaultsLiveRefresh(document),
      { gridStyle: 'cropped' },
    );
    const failDefaultsRefresh = async (document) => {
      const onError = vi.fn();
      expect(refreshProjectAssetsDefaultsLiveRegion(
        document,
        '/projects/1/assets?view=grid',
        beginProjectAssetsDefaultsLiveRefresh(document),
        { onError },
      )).toBe('started');
      await flush();
      expect(onError).toHaveBeenCalledOnce();
    };

    it('clears the obsolete Defaults-refresh error once the style is applied in place', async () => {
      const initial = makePage({ view: 'grid' });
      const { windowObject } = makeWindow(initial.document);
      windowObject.fetch.mockRejectedValue(new Error('offline'));
      enhanceProjectAssetsLiveFiltering(initial.document);

      await failDefaultsRefresh(initial.document);
      expect(initial.status.textContent).toBe(DEFAULTS_ERROR);
      expect(initial.region.getAttribute('data-project-assets-live-state')).toBe('error');

      expect(restyle(initial.document)).toBe('applied');
      expect(windowObject.fetch).toHaveBeenCalledOnce();
      expect(initial.document.querySelector('[data-project-assets-live-region]')).toBe(initial.region);
      expect(initial.grid.getAttribute('data-grid-style')).toBe('cropped');
      expect(initial.status.textContent).toBe('');
      expect(initial.region.hasAttribute('data-project-assets-live-state')).toBe(false);
    });

    it('keeps NSFW and unrelated live-region errors', async () => {
      const nsfw = makePage({ view: 'grid', nsfwEnabled: false });
      const { windowObject: nsfwWindow } = makeWindow(nsfw.document);
      nsfwWindow.fetch
        .mockResolvedValueOnce(jsonResponse({ status: 'success', enabled: true }))
        .mockRejectedValueOnce(new Error('offline'));
      enhanceProjectAssetsLiveFiltering(nsfw.document);
      nsfw.nsfwForm.dispatch('submit', { target: nsfw.nsfwToggle });
      await flush();
      expect(nsfw.status.textContent).toBe(NSFW_ERROR);

      expect(restyle(nsfw.document)).toBe('applied');
      expect(nsfw.grid.getAttribute('data-grid-style')).toBe('cropped');
      expect(nsfw.status.textContent).toBe(NSFW_ERROR);
      expect(nsfw.region.getAttribute('data-project-assets-live-state')).toBe('error');

      const unrelated = makePage({ view: 'grid' });
      const { windowObject } = makeWindow(unrelated.document);
      windowObject.fetch.mockRejectedValue(new Error('offline'));
      enhanceProjectAssetsLiveFiltering(unrelated.document);
      unrelated.presenceAll.checked = false;
      unrelated.presenceMissing.checked = true;
      unrelated.presenceMissing.dispatch('change');
      await flush();
      const unrelatedMessage = unrelated.status.textContent;
      expect(unrelatedMessage).not.toBe('');

      restyle(unrelated.document);
      expect(unrelated.status.textContent).toBe(unrelatedMessage);
      expect(unrelated.region.getAttribute('data-project-assets-live-state')).toBe('error');
    });

    it('keeps the Defaults-refresh error when the failed load also owed an NSFW refresh', async () => {
      const initial = makePage({ view: 'grid', nsfwEnabled: false });
      const nsfwRefresh = deferred();
      const { windowObject } = makeWindow(initial.document);
      windowObject.fetch
        .mockResolvedValueOnce(jsonResponse({ status: 'success', enabled: true }))
        .mockImplementationOnce(() => nsfwRefresh.promise)
        .mockRejectedValueOnce(new Error('offline'));
      enhanceProjectAssetsLiveFiltering(initial.document);
      initial.nsfwForm.dispatch('submit', { target: initial.nsfwToggle });
      await flush();
      expect(windowObject.fetch).toHaveBeenCalledTimes(2);

      // The Defaults refresh supersedes the NSFW refresh and carries it.
      await failDefaultsRefresh(initial.document);
      expect(initial.status.textContent).toBe(DEFAULTS_ERROR);

      // The previews still predate the NSFW change, so the prompt stays.
      expect(restyle(initial.document)).toBe('applied');
      expect(initial.status.textContent).toBe(DEFAULTS_ERROR);
      expect(initial.region.getAttribute('data-project-assets-live-state')).toBe('error');
    });
  });
});

describe('Project Assets post-mutation refresh contract', () => {
  const PATH = 'http://creatorcrate.test/projects/1/assets';

  // Adds selectable assets and, optionally, the server's complete membership.
  function withAssets(page, ids, { selected = [], membership = null, gridStyle = null } = {}) {
    page.selectionCheckbox.remove();
    const boxes = new Map();
    ids.forEach((id) => {
      const card = makeNode({ tagName: 'article', attrs: { 'data-asset-id': String(id), 'data-asset-selectable-card': '' } });
      const box = makeNode({ tagName: 'input', attrs: { type: 'checkbox', name: 'selectedAssetIds', value: String(id) } });
      box.checked = selected.includes(id);
      box.form = page.selectionForm;
      card.appendChild(box);
      page.grid.appendChild(card);
      boxes.set(id, box);
    });
    if (membership) {
      const marker = makeNode({ tagName: 'script', attrs: { 'data-project-assets-membership': '' } });
      marker.textContent = JSON.stringify(membership);
      page.region.appendChild(marker);
    }
    if (gridStyle) page.grid.setAttribute('data-grid-style', gridStyle);
    return boxes;
  }

  function scenario(initialOptions, nextOptions) {
    const initial = makePage({ withAssetSelection: true });
    const initialBoxes = withAssets(initial, initialOptions.ids, initialOptions);
    const next = makePage({ withAssetSelection: true });
    const nextBoxes = withAssets(next, nextOptions.ids, nextOptions);
    const { windowObject } = makeWindow(initial.document, new Map([['next', next.document]]));
    windowObject.fetch = vi.fn();
    enhanceProjectAssetsLiveFiltering(initial.document);
    return { initial, initialBoxes, next, nextBoxes, windowObject };
  }

  it('settles only after the authoritative region is installed, without a history entry', async () => {
    const { initial, next, windowObject } = scenario({ ids: [1] }, { ids: [1] });
    const pending = deferred();
    windowObject.fetch.mockReturnValueOnce(pending.promise);
    const settled = vi.fn();
    const completion = refreshProjectAssetsAfterMutation(initial.document).then(settled);
    await flush();
    expect(windowObject.fetch.mock.calls[0][1].method).toBe('GET');
    expect(settled).not.toHaveBeenCalled();

    pending.resolve(htmlResponse('next', PATH));
    await completion;
    expect(settled.mock.calls[0][0].status).toBe('installed');
    expect(initial.document.querySelector('[data-project-assets-live-region]')).toBe(next.region);
    expect(windowObject.history.pushes).toHaveLength(0);
    expect(windowObject.history.replaces).toHaveLength(0);
    expect(next.region.hasAttribute('aria-busy')).toBe(false);
  });

  it('reports failure, keeps the page and selection, and recovers through a GET-only Retry', async () => {
    const { initial, initialBoxes, next, nextBoxes, windowObject } = scenario(
      { ids: [1, 2], selected: [2] },
      { ids: [1, 2], membership: [1, 2] },
    );
    windowObject.fetch.mockRejectedValueOnce(new Error('offline'));
    const onRecovered = vi.fn();
    const result = await refreshProjectAssetsAfterMutation(initial.document, { onRecovered });
    expect(result.status).toBe('failed');
    expect(initial.document.querySelector('[data-project-assets-live-region]')).toBe(initial.region);
    expect(initialBoxes.get(2).checked).toBe(true);
    expect(liveFailureRetries(initial.document)).toHaveLength(1);
    expect(onRecovered).not.toHaveBeenCalled();

    windowObject.fetch.mockResolvedValueOnce(htmlResponse('next', PATH));
    liveFailureRetries(initial.document)[0].dispatch('click');
    await flush();
    expect(windowObject.fetch.mock.calls.map(([, options]) => options.method)).toEqual(['GET', 'GET']);
    expect(initial.document.querySelector('[data-project-assets-live-region]')).toBe(next.region);
    expect(nextBoxes.get(2).checked).toBe(true);
    expect(onRecovered).toHaveBeenCalledOnce();
  });

  it('treats a response without a region as failed, not installed', async () => {
    const { initial, windowObject } = scenario({ ids: [1] }, { ids: [1] });
    windowObject.fetch.mockResolvedValueOnce(htmlResponse('unknown', PATH));
    const result = await refreshProjectAssetsAfterMutation(initial.document);
    expect(result.status).toBe('failed');
    expect(initial.document.querySelector('[data-project-assets-live-region]')).toBe(initial.region);
    expect(liveFailureRetries(initial.document)).toHaveLength(1);
  });

  it('reports supersession truthfully and lets the newer load satisfy the refresh', async () => {
    const { initial, next, nextBoxes, initialBoxes, windowObject } = scenario(
      { ids: [1], selected: [1] },
      { ids: [1], membership: [1] },
    );
    const stale = deferred();
    const newer = deferred();
    windowObject.fetch.mockReturnValueOnce(stale.promise).mockReturnValueOnce(newer.promise);
    const onRecovered = vi.fn();
    const completion = refreshProjectAssetsAfterMutation(initial.document, { onRecovered });
    await flush();

    initial.presenceAll.checked = false;
    initial.presenceMissing.checked = true;
    initial.presenceMissing.dispatch('change');
    expect((await completion).status).toBe('superseded');
    expect(onRecovered).not.toHaveBeenCalled();

    // The late, older response cannot install.
    stale.resolve(htmlResponse('next', PATH));
    await flush();
    expect(initial.document.querySelector('[data-project-assets-live-region]')).toBe(initial.region);
    expect(initialBoxes.get(1).checked).toBe(true);

    newer.resolve(htmlResponse('next', windowObject.fetch.mock.calls[1][0]));
    await flush();
    expect(initial.document.querySelector('[data-project-assets-live-region]')).toBe(next.region);
    expect(onRecovered).toHaveBeenCalledOnce();
    // F7-R2a: the newer filter keeps its own selection boundary; the
    // satisfied refresh reports the identities that boundary cleared.
    expect(nextBoxes.get(1).checked).toBe(false);
    expect(retainedAssetSelectionIds(initial.document)).toEqual([]);
    expect(onRecovered.mock.calls[0][0]).toMatchObject({ selection: { restored: [], retained: [], removed: ['1'] } });
  });

  it('keeps the owed refresh when the newer load fails, with Retry for the newer request', async () => {
    const { initial, next, nextBoxes, windowObject } = scenario(
      { ids: [1], selected: [1] },
      { ids: [1], membership: [1] },
    );
    const stale = deferred();
    windowObject.fetch.mockReturnValueOnce(stale.promise).mockRejectedValueOnce(new Error('offline'));
    const completion = refreshProjectAssetsAfterMutation(initial.document);
    await flush();
    initial.presenceAll.checked = false;
    initial.presenceMissing.checked = true;
    initial.presenceMissing.dispatch('change');
    expect((await completion).status).toBe('superseded');
    await flush();
    const requested = windowObject.fetch.mock.calls[1][0];
    expect(liveFailureRetries(initial.document)).toHaveLength(1);

    windowObject.fetch.mockResolvedValueOnce(htmlResponse('next', requested));
    liveFailureRetries(initial.document)[0].dispatch('click');
    await flush();
    expect(windowObject.fetch.mock.calls[2][0]).toBe(requested);
    expect(initial.document.querySelector('[data-project-assets-live-region]')).toBe(next.region);
    // F7-R2a: Retry repeats the newer filter, not the refresh's re-read.
    expect(nextBoxes.get(1).checked).toBe(false);
    expect(retainedAssetSelectionIds(initial.document)).toEqual([]);
  });

  describe('retained category order', () => {
    const KEPT = 'Your unsaved category order was kept, but it cannot be shown in this view.';

    // A rendered ordering surface; no surface at all when categoryId is omitted.
    function orderPage({ categoryId = null, ids = [1, 3], baseOrder = [1, 2, 3, 4] } = {}) {
      const page = makePage({ withAssetSelection: true });
      page.status = page.region.querySelector('[data-project-assets-live-status]');
      if (categoryId === null) return page;
      const surface = makeNode({
        tagName: 'section',
        attrs: {
          'data-auto-rename-surface': '',
          'data-category-reorder-enabled': 'true',
          'data-auto-rename-category-id': categoryId,
          'data-auto-rename-base-order': JSON.stringify(baseOrder),
          'data-auto-rename-view': 'grid',
        },
      });
      const form = makeNode({ tagName: 'form', attrs: { 'data-auto-rename-form': '' } });
      form.appendChild(makeNode({ tagName: 'input', attrs: { 'data-auto-rename-order-input': '' } }));
      form.appendChild(makeNode({ tagName: 'button', attrs: { 'data-auto-rename-submit': '' } }));
      surface.appendChild(form);
      const list = makeNode({ tagName: 'ul' });
      const append = list.appendChild;
      list.appendChild = function appendMoved(child) {
        child.remove();
        return append.call(this, child);
      };
      ids.forEach((id, index) => list.appendChild(makeNode({
        tagName: 'li',
        attrs: {
          'data-auto-rename-asset': '',
          'data-auto-rename-asset-id': String(id),
          'data-auto-rename-initial-index': String(index),
        },
      })));
      surface.appendChild(list);
      page.region.appendChild(surface);
      Object.assign(page, {
        surface,
        list,
        orderValue: () => JSON.parse(form.querySelector('[data-auto-rename-order-input]').value),
      });
      return page;
    }

    function orderScenario(pages) {
      const initial = orderPage({ categoryId: '7' });
      const { windowObject } = makeWindow(
        initial.document,
        new Map(Object.entries(pages).map(([name, page]) => [name, page.document])),
      );
      windowObject.fetch = vi.fn();
      enhanceProjectAssetsLiveFiltering(initial.document);
      // The user's unsaved move: 3 before 1, so the complete order is 3, 2, 1, 4.
      initial.list.insertBefore(initial.list.children[1], initial.list.children[0]);
      // An install moves the rendered filter inputs into the mounted form.
      let current = initial;
      const changeFilter = () => current.presenceMissing.dispatch('change');
      const navigate = async (name) => {
        windowObject.fetch.mockResolvedValueOnce(htmlResponse(name, PATH));
        changeFilter();
        await flush();
        current = pages[name];
      };
      const methods = () => windowObject.fetch.mock.calls.map(([, options]) => options.method);
      return { initial, windowObject, navigate, changeFilter, methods };
    }

    const installed = (initial) => initial.document.querySelector('[data-project-assets-live-region]');

    it('holds the order through a zero-match install and restores it unsaved on the matching view', async () => {
      const empty = orderPage();
      const match = orderPage({ categoryId: '7' });
      const { initial, navigate, methods } = orderScenario({ empty, match });

      await navigate('empty');
      expect(installed(initial)).toBe(empty.region);
      expect(empty.status.textContent).toBe(KEPT);

      await navigate('match');
      expect(installed(initial)).toBe(match.region);
      expect(match.orderValue()).toEqual([3, 2, 1, 4]);
      expect(match.surface.getAttribute('data-auto-rename-base-order')).toBe('[1,2,3,4]');
      expect(match.surface.getAttribute('data-auto-rename-draft')).toBe('true');
      expect(match.status.textContent).toBe('');
      expect(methods().every((method) => method === 'GET')).toBe(true);
    });

    it('never applies the order to another category, and each category keeps its own', async () => {
      const other = orderPage({ categoryId: '8', ids: [5, 6], baseOrder: [5, 6] });
      const back = orderPage({ categoryId: '7' });
      const otherAgain = orderPage({ categoryId: '8', ids: [5, 6], baseOrder: [5, 6] });
      const { navigate } = orderScenario({ other, back, otherAgain });

      await navigate('other');
      expect(other.orderValue()).toEqual([5, 6]);
      expect(other.surface.hasAttribute('data-auto-rename-draft')).toBe(false);
      expect(other.status.textContent).toBe(KEPT);
      other.list.insertBefore(other.list.children[1], other.list.children[0]);

      await navigate('back');
      expect(back.orderValue()).toEqual([3, 2, 1, 4]);
      expect(back.status.textContent).toBe(KEPT);

      await navigate('otherAgain');
      expect(otherAgain.orderValue()).toEqual([6, 5]);
    });

    it('is not cleared by a stale or failed response, and Retry restores it with GET only', async () => {
      const empty = orderPage();
      const match = orderPage({ categoryId: '7' });
      const { initial, windowObject, navigate, changeFilter, methods } = orderScenario({ empty, match });
      await navigate('empty');

      const stale = deferred();
      windowObject.fetch.mockReturnValueOnce(stale.promise);
      const completion = refreshProjectAssetsAfterMutation(initial.document);
      await flush();
      windowObject.fetch.mockRejectedValueOnce(new Error('offline'));
      changeFilter();
      expect((await completion).status).toBe('superseded');
      await flush();
      stale.resolve(htmlResponse('match', PATH));
      await flush();
      expect(installed(initial)).toBe(empty.region);
      expect(liveFailureRetries(initial.document)).toHaveLength(1);

      windowObject.fetch.mockResolvedValueOnce(htmlResponse('match', PATH));
      liveFailureRetries(initial.document)[0].dispatch('click');
      await flush();
      expect(installed(initial)).toBe(match.region);
      expect(match.orderValue()).toEqual([3, 2, 1, 4]);
      expect(methods().every((method) => method === 'GET')).toBe(true);
    });

    it('reconciles membership on return: deleted identities leave, additions require review', async () => {
      const empty = orderPage();
      const grown = orderPage({ categoryId: '7', baseOrder: [1, 2, 3, 5] });
      const { initial, navigate, methods } = orderScenario({ empty, grown });
      await navigate('empty');
      await navigate('grown');
      expect(installed(initial)).toBe(grown.region);
      // 4 is gone; new 5 follows 3, its predecessor in the server order.
      expect(grown.orderValue()).toEqual([3, 5, 2, 1]);
      expect(grown.surface.autoRenameOrderingState.reviewRequired).toBe(true);
      expect(methods().every((method) => method === 'GET')).toBe(true);
    });

    it('ends when the user moves back to the saved order', async () => {
      const empty = orderPage();
      const match = orderPage({ categoryId: '7' });
      const { initial, navigate } = orderScenario({ empty, match });
      initial.list.insertBefore(initial.list.children[1], initial.list.children[0]);

      await navigate('empty');
      expect(empty.status.textContent).toBe('');
      await navigate('match');
      expect(match.orderValue()).toEqual([1, 2, 3, 4]);
      expect(match.surface.hasAttribute('data-auto-rename-draft')).toBe(false);
    });
  });

  it('restores selection by identity: hidden retained, deleted removed, new assets unselected', async () => {
    const { initial, next, nextBoxes, windowObject } = scenario(
      { ids: [1, 2, 3], selected: [1, 2, 3] },
      { ids: [1, 9], membership: [1, 2, 9] },
    );
    windowObject.fetch.mockResolvedValueOnce(htmlResponse('next', PATH));
    const result = await refreshProjectAssetsAfterMutation(initial.document);
    expect(result.reconciliation.selection).toEqual({ restored: ['1'], retained: ['2'], removed: ['3'] });
    expect(nextBoxes.get(1).checked).toBe(true);
    expect(nextBoxes.get(9).checked).toBe(false);
    expect(next.selectedCount.textContent).toContain('(1 more not shown)');
    expect(retainedAssetSelectionIds(initial.document)).toEqual(['2']);
  });

  it('never infers deletion when the server sent no complete membership', async () => {
    const { initial, windowObject } = scenario({ ids: [1, 2], selected: [2] }, { ids: [1] });
    windowObject.fetch.mockResolvedValueOnce(htmlResponse('next', PATH));
    const result = await refreshProjectAssetsAfterMutation(initial.document);
    expect(result.reconciliation.selection.retained).toEqual(['2']);
    expect(result.reconciliation.selection.removed).toEqual([]);
  });

  it('a retained hidden selection reappears on a later refresh and a user filter still resets it', async () => {
    const { initial, next, windowObject } = scenario({ ids: [1, 2], selected: [2] }, { ids: [1], membership: [1, 2] });
    const again = makePage({ withAssetSelection: true });
    const againBoxes = withAssets(again, [1, 2], { membership: [1, 2] });
    const filtered = makePage({ withAssetSelection: true });
    withAssets(filtered, [1], { membership: [1, 2] });
    windowObject.DOMParser = class { parseFromString(text) { return { next: next.document, again: again.document, filtered: filtered.document }[text]; } };
    windowObject.fetch.mockResolvedValueOnce(htmlResponse('next', PATH));
    await refreshProjectAssetsAfterMutation(initial.document);

    windowObject.fetch.mockResolvedValueOnce(htmlResponse('again', PATH));
    await refreshProjectAssetsAfterMutation(initial.document);
    expect(againBoxes.get(2).checked).toBe(true);
    expect(retainedAssetSelectionIds(initial.document)).toEqual([]);

    windowObject.fetch.mockResolvedValueOnce(htmlResponse('filtered', `${PATH}?presence=missing`));
    again.presenceAll.checked = false;
    again.presenceMissing.checked = true;
    initial.presenceMissing.dispatch('change');
    await flush();
    expect(retainedAssetSelectionIds(initial.document)).toEqual([]);
  });

  it('preserves the requested grid style instead of resetting to the rendered default', async () => {
    const { initial, next, windowObject } = scenario(
      { ids: [1], gridStyle: 'cropped' },
      { ids: [1], gridStyle: 'uncropped' },
    );
    windowObject.fetch.mockResolvedValueOnce(htmlResponse('next', PATH));
    await refreshProjectAssetsAfterMutation(initial.document);
    expect(next.grid.getAttribute('data-grid-style')).toBe('cropped');
  });

  it('after a failed filter refreshes that request and commits its history, not the old view', async () => {
    const { initial, next, windowObject } = scenario({ ids: [1] }, { ids: [1] });
    windowObject.fetch.mockRejectedValueOnce(new Error('offline'));
    initial.presenceAll.checked = false;
    initial.presenceMissing.checked = true;
    initial.presenceMissing.dispatch('change');
    await flush();
    const requested = windowObject.fetch.mock.calls[0][0];
    expect(requested).toContain('presence=missing');

    windowObject.fetch.mockResolvedValueOnce(htmlResponse('next', requested));
    const result = await refreshProjectAssetsAfterMutation(initial.document);
    expect(result.status).toBe('installed');
    expect(windowObject.fetch.mock.calls[1][0]).toBe(requested);
    expect(windowObject.history.pushes).toHaveLength(1);
    expect(liveFailureNotice(initial.document)).toBeNull();
    expect(next.region).toBe(initial.document.querySelector('[data-project-assets-live-region]'));
  });

  it('takes over an in-flight filter so its older response cannot install and its history survives', async () => {
    const { initial, next, windowObject } = scenario({ ids: [1] }, { ids: [1] });
    const old = deferred();
    windowObject.fetch.mockReturnValueOnce(old.promise);
    initial.presenceAll.checked = false;
    initial.presenceMissing.checked = true;
    initial.presenceMissing.dispatch('change');
    await flush();
    const requested = windowObject.fetch.mock.calls[0][0];

    windowObject.fetch.mockResolvedValueOnce(htmlResponse('next', requested));
    const result = await refreshProjectAssetsAfterMutation(initial.document);
    expect(result.status).toBe('installed');
    expect(windowObject.fetch.mock.calls[1][0]).toBe(requested);
    expect(windowObject.history.pushes).toHaveLength(1);

    const other = makePage({ withAssetSelection: true });
    windowObject.DOMParser = class { parseFromString() { return other.document; } };
    old.resolve(htmlResponse('other', requested));
    await flush();
    expect(initial.document.querySelector('[data-project-assets-live-region]')).toBe(next.region);
  });

  it('does not stack listeners over repeated refreshes', async () => {
    const { initial, next, windowObject } = scenario({ ids: [1] }, { ids: [1] });
    const changeListeners = () => initial.form.listeners.filter((listener) => listener.type === 'change').length;
    const before = changeListeners();
    const documentBefore = initial.document.listeners.length;
    windowObject.fetch.mockImplementation(async () => htmlResponse('next', PATH));
    await refreshProjectAssetsAfterMutation(initial.document);
    await refreshProjectAssetsAfterMutation(initial.document);
    await refreshProjectAssetsAfterMutation(initial.document);
    expect(changeListeners()).toBe(before);
    expect(initial.document.listeners.length).toBe(documentBefore);
    expect(next.region.listeners.length).toBeLessThanOrEqual(1);
  });

  it('reports unavailable where no refresh can start, and the legacy call reports only that it started', async () => {
    const empty = makeNode({ tagName: 'document' });
    empty.nodeType = 9;
    expect((await refreshProjectAssetsAfterMutation(empty)).status).toBe('unavailable');

    const { initial, windowObject } = scenario({ ids: [1] }, { ids: [1] });
    windowObject.fetch.mockReturnValueOnce(deferred().promise);
    expect(refreshProjectAssetsLiveRegion(initial.document)).toBe(true);
  });

  // Milestone 2 Correction D.
  describe('after a defaults reset', () => {
    const NEXT_URL = '/projects/1/assets?page=3';
    const VIEW_URL = '/projects/1/assets?view=list';

    // The real template renders the page and view links inside the region.
    function linkedPage(options = {}) {
      const page = makePage({ paginationUrl: NEXT_URL, viewUrl: VIEW_URL, ...options });
      page.region.appendChild(page.paginationLink.parentNode);
      page.region.appendChild(page.viewLink.parentNode);
      return page;
    }

    function withStorage(entries = []) {
      const storage = new Map(entries);
      const setItem = vi.fn((key, value) => storage.set(key, value));
      const previous = globalThis.localStorage;
      globalThis.localStorage = { getItem: (key) => storage.get(key) ?? null, setItem };
      return {
        storage,
        setItem,
        restore() {
          if (previous === undefined) delete globalThis.localStorage;
          else globalThis.localStorage = previous;
        },
      };
    }

    // F7: links rendered against the deleted defaults cannot be followed
    // while the reconciliation is pending or after it fails.
    it('makes the stale page and view links unavailable until a newer region installs', async () => {
      const initial = linkedPage();
      const next = linkedPage();
      const { windowObject } = makeWindow(initial.document, new Map([['next', next.document]]));
      windowObject.fetch = vi.fn().mockRejectedValueOnce(new Error('offline'));
      const storage = withStorage();
      try {
        enhanceProjectAssetsLiveFiltering(initial.document);
        const result = await refreshProjectAssetsAfterMutation(initial.document, { staleNavigation: true });
        expect(result.status).toBe('failed');
        [initial.paginationLink, initial.viewLink].forEach((link) => {
          expect(link.getAttribute('href')).toBeNull();
          expect(link.getAttribute('aria-disabled')).toBe('true');
          expect(link.getAttribute('role')).toBe('link');
          expect(link.getAttribute('data-project-assets-stale-link')).toBe('');
        });
        // Activation goes nowhere: no load, no native navigation.
        const click = { button: 0, defaultPrevented: false, preventDefault: vi.fn() };
        initial.paginationLink.dispatch('click', click);
        initial.viewLink.dispatch('click', click);
        await flush();
        expect(windowObject.fetch).toHaveBeenCalledOnce();
        expect(windowObject.location.href).toBe('http://creatorcrate.test/projects/1/assets?page=2');
        expect(liveFailureRetries(initial.document)).toHaveLength(1);

        // The GET-only Retry installs links rendered after the reset.
        windowObject.fetch.mockResolvedValueOnce(htmlResponse('next', 'http://creatorcrate.test/projects/1/assets?page=2'));
        liveFailureRetries(initial.document)[0].dispatch('click');
        await flush();
        expect(windowObject.fetch.mock.calls.map(([, options]) => options.method)).toEqual(['GET', 'GET']);
        expect(initial.document.querySelector('[data-project-assets-live-region]')).toBe(next.region);
        expect(next.paginationLink.getAttribute('href')).toBe(NEXT_URL);
        expect(next.paginationLink.hasAttribute('aria-disabled')).toBe(false);
        expect(next.viewLink.getAttribute('href')).toBe(VIEW_URL);
        expect(storage.setItem).not.toHaveBeenCalled();
      } finally {
        storage.restore();
      }
    });

    it('leaves the links of an ordinary mutation refresh usable', async () => {
      const initial = linkedPage();
      const { windowObject } = makeWindow(initial.document);
      windowObject.fetch = vi.fn().mockRejectedValueOnce(new Error('offline'));
      enhanceProjectAssetsLiveFiltering(initial.document);
      expect((await refreshProjectAssetsAfterMutation(initial.document)).status).toBe('failed');
      expect(initial.paginationLink.getAttribute('href')).toBe(NEXT_URL);
      expect(initial.paginationLink.hasAttribute('aria-disabled')).toBe(false);
      expect(initial.viewLink.getAttribute('href')).toBe(VIEW_URL);
    });

    // F6: with no stored browser size, the region's size defaults are what
    // the page displays; a reset must not change them or write storage.
    it('keeps the displayed Grid and List sizes on later installs without writing storage', async () => {
      const initial = linkedPage({ gridSizeDefault: 'large', listSizeDefault: 'compact' });
      // Rendered after the reset: the newly inherited defaults.
      const next = linkedPage({ gridSizeDefault: 'default', listSizeDefault: 'large' });
      const later = linkedPage({ gridSizeDefault: 'default', listSizeDefault: 'large' });
      // Rendered after a newer Save changed the Grid size default.
      const saved = linkedPage({ gridSizeDefault: 'compact', listSizeDefault: 'large' });
      const { windowObject } = makeWindow(initial.document, new Map([
        ['next', next.document], ['later', later.document], ['saved', saved.document],
      ]));
      const storage = withStorage();
      try {
        enhanceProjectAssetsLiveFiltering(initial.document);
        expect(initial.grid.getAttribute('data-grid-size')).toBe('large');
        expect(initial.list.getAttribute('data-list-size')).toBe('compact');

        expect(retainProjectAssetsDisplayedSizes(initial.document, { gridSize: 'default', listSize: 'large' })).toBe(true);
        windowObject.fetch = vi.fn()
          .mockResolvedValueOnce(htmlResponse('next', 'http://creatorcrate.test/projects/1/assets?page=2'))
          .mockResolvedValueOnce(htmlResponse('later', 'http://creatorcrate.test/projects/1/assets?view=list'))
          .mockResolvedValueOnce(htmlResponse('saved', 'http://creatorcrate.test/projects/1/assets?view=grid'));
        expect((await refreshProjectAssetsAfterMutation(initial.document, { staleNavigation: true })).status)
          .toBe('installed');
        expect(next.grid.getAttribute('data-grid-size')).toBe('large');
        expect(next.list.getAttribute('data-list-size')).toBe('compact');
        expect(next.region.getAttribute('data-project-assets-grid-size-default')).toBe('large');
        expect(next.region.getAttribute('data-project-assets-list-size-default')).toBe('compact');

        // A later mode switch keeps both sizes.
        next.viewLink.dispatch('click', { button: 0, defaultPrevented: false, preventDefault: vi.fn() });
        await flush();
        expect(initial.document.querySelector('[data-project-assets-live-region]')).toBe(later.region);
        expect(later.grid.getAttribute('data-grid-size')).toBe('large');
        expect(later.list.getAttribute('data-list-size')).toBe('compact');

        // A region rendered with a different default (a newer Save or scope
        // change) retires the carried Grid size; List is still carried.
        later.viewLink.dispatch('click', { button: 0, defaultPrevented: false, preventDefault: vi.fn() });
        await flush();
        expect(initial.document.querySelector('[data-project-assets-live-region]')).toBe(saved.region);
        expect(saved.grid.getAttribute('data-grid-size')).toBe('compact');
        expect(saved.list.getAttribute('data-list-size')).toBe('compact');
        expect(storage.setItem).not.toHaveBeenCalled();
        expect(storage.storage.size).toBe(0);
      } finally {
        storage.restore();
      }
    });

    it('lets a stored browser size win over the retained fallback and never rewrites it', async () => {
      const initial = linkedPage({ gridSizeDefault: 'large', listSizeDefault: 'compact' });
      const next = linkedPage({ gridSizeDefault: 'default', listSizeDefault: 'large' });
      const { windowObject } = makeWindow(initial.document, new Map([['next', next.document]]));
      const storage = withStorage([
        ['creatorcrate-asset-grid-size', 'compact'],
        ['creatorcrate-asset-list-size', 'large'],
      ]);
      try {
        enhanceProjectAssetsLiveFiltering(initial.document);
        retainProjectAssetsDisplayedSizes(initial.document, { gridSize: 'default', listSize: 'large' });
        windowObject.fetch = vi.fn().mockResolvedValueOnce(htmlResponse('next', 'http://creatorcrate.test/projects/1/assets?page=2'));
        expect((await refreshProjectAssetsAfterMutation(initial.document)).status).toBe('installed');
        expect(next.grid.getAttribute('data-grid-size')).toBe('compact');
        expect(next.list.getAttribute('data-list-size')).toBe('large');
        expect(storage.setItem).not.toHaveBeenCalled();
        expect([...storage.storage.values()]).toEqual(['compact', 'large']);
      } finally {
        storage.restore();
      }
    });
  });
});

describe('Project Assets results Category dropdown', () => {
  const choose = (input, siblings) => {
    siblings.forEach((candidate) => { candidate.checked = candidate === input; });
    input.dispatch('change');
  };
  const inlineInputs = (page) => [page.inlineCategory.all, page.inlineCategory.renders, page.inlineCategory.missing];
  const checkedInline = (page) => inlineInputs(page).filter((input) => input.checked);

  it('checks the matching Filter radio and runs one canonical request that keeps other filters and resets page', async () => {
    const initial = makePage({
      withInlineCategory: true, searchValue: 'keep', usage: 'used', tags: ['8'], extensions: ['png'], page: '3',
    });
    const next = makePage({ withInlineCategory: true, searchValue: 'keep', usage: 'used', tags: ['8'], extensions: ['png'] });
    next.categoryAll.checked = false;
    next.categoryRenders.checked = true;
    next.inlineCategory.all.checked = false;
    next.inlineCategory.renders.checked = true;
    const { windowObject } = makeWindow(initial.document, new Map([['renders', next.document]]));
    const responseUrl = 'http://creatorcrate.test/projects/1/assets?category=7&presence=all&view=list';
    windowObject.fetch.mockResolvedValue(htmlResponse('renders', responseUrl));

    expect(enhanceProjectAssetsLiveFiltering(initial.document)).toBe(1);
    choose(initial.inlineCategory.renders, inlineInputs(initial));
    expect(initial.categoryRenders.checked).toBe(true);
    expect(initial.presenceAll.checked).toBe(true);
    await flush();

    expect(windowObject.fetch).toHaveBeenCalledTimes(1);
    const requested = new URL(windowObject.fetch.mock.calls[0][0]);
    expect(requested.searchParams.get('category')).toBe('7');
    expect(requested.searchParams.get('presence')).toBe('all');
    expect(requested.searchParams.get('search')).toBe('keep');
    expect(requested.searchParams.get('usage')).toBe('used');
    expect(requested.searchParams.getAll('tag')).toEqual(['8']);
    expect(requested.searchParams.getAll('extension')).toEqual(['png']);
    expect(requested.searchParams.has('page')).toBe(false);
    expect(requested.searchParams.has('projectAssetsInlineCategory')).toBe(false);
    expect(windowObject.history.pushes.map(({ url }) => url)).toEqual([responseUrl]);
    expect(initial.document.querySelector('[data-project-assets-live-region]')).toBe(next.region);
    expect(checkedInline(next)).toEqual([next.inlineCategory.renders]);

    // The replacement binds once, however often enhancement runs again.
    enhanceProjectAssetsLiveFiltering(next.region);
    enhanceProjectAssetsLiveFiltering(initial.document);
    expect(next.inlineCategory.field.listeners.filter(({ type }) => type === 'change')).toHaveLength(1);
    expect(initial.form.listeners.filter(({ type }) => type === 'change')).toHaveLength(1);
    choose(next.inlineCategory.all, inlineInputs(next));
    await flush();
    expect(windowObject.fetch).toHaveBeenCalledTimes(2);
    expect(new URL(windowObject.fetch.mock.calls[1][0]).searchParams.get('category')).toBe('all');
  });

  it('tells Missing from All by presence', () => {
    const initial = makePage({ withInlineCategory: true });
    const { windowObject } = makeWindow(initial.document);
    windowObject.fetch.mockReturnValue(deferred().promise);
    enhanceProjectAssetsLiveFiltering(initial.document);

    choose(initial.inlineCategory.missing, inlineInputs(initial));
    expect(initial.categoryMissing.checked).toBe(true);
    expect(initial.presenceMissing.checked).toBe(true);
    const missing = new URL(windowObject.fetch.mock.calls[0][0]);
    expect(missing.searchParams.get('category')).toBe('all');
    expect(missing.searchParams.get('presence')).toBe('missing');

    const missingPage = makePage({ withInlineCategory: true, presence: 'missing' });
    const { windowObject: missingWindow } = makeWindow(missingPage.document);
    missingWindow.fetch.mockReturnValue(deferred().promise);
    enhanceProjectAssetsLiveFiltering(missingPage.document);
    expect(checkedInline(missingPage)).toEqual([missingPage.inlineCategory.missing]);

    choose(missingPage.inlineCategory.all, inlineInputs(missingPage));
    expect(missingPage.categoryAll.checked).toBe(true);
    expect(missingPage.presenceAll.checked).toBe(true);
    const all = new URL(missingWindow.fetch.mock.calls[0][0]);
    expect(all.searchParams.get('category')).toBe('all');
    expect(all.searchParams.get('presence')).toBe('all');
  });

  it('follows Filter dialog Category and Show changes without a request of its own', () => {
    const initial = makePage({ withInlineCategory: true, presence: 'missing' });
    const { windowObject } = makeWindow(initial.document);
    windowObject.fetch.mockReturnValue(deferred().promise);
    enhanceProjectAssetsLiveFiltering(initial.document);

    initial.presenceMissing.checked = false;
    initial.presenceAll.checked = true;
    initial.presenceAll.dispatch('change');
    expect(initial.categoryAll.checked).toBe(true);
    expect(checkedInline(initial)).toEqual([initial.inlineCategory.all]);
    expect(windowObject.fetch).toHaveBeenCalledTimes(1);

    initial.categoryAll.checked = false;
    initial.categoryMissing.checked = false;
    initial.categoryRenders.checked = true;
    initial.categoryRenders.dispatch('change');
    expect(checkedInline(initial)).toEqual([initial.inlineCategory.renders]);
    expect(initial.inlineCategory.current.textContent).toBe('Renders');
    expect(initial.inlineCategory.summary.getAttribute('aria-label')).toBe('Category filter: Renders');
    expect(windowObject.fetch).toHaveBeenCalledTimes(2);
  });

  it('shows the reconciled Filter form category after Back/Forward replaces the region', async () => {
    const initial = makePage({ withInlineCategory: true });
    initial.categoryAll.checked = false;
    initial.categoryRenders.checked = true;
    initial.inlineCategory.all.checked = false;
    initial.inlineCategory.renders.checked = true;
    const previous = makePage({ withInlineCategory: true, presence: 'missing' });
    // A stale inline choice in the response still yields to the Filter form.
    previous.inlineCategory.missing.checked = false;
    previous.inlineCategory.renders.checked = true;
    const { windowObject, setLocation } = makeWindow(initial.document, new Map([['previous', previous.document]]));
    const previousUrl = 'http://creatorcrate.test/projects/1/assets?category=all&presence=missing';
    windowObject.fetch.mockResolvedValue(htmlResponse('previous', previousUrl));
    enhanceProjectAssetsLiveFiltering(initial.document);

    setLocation(previousUrl);
    windowObject.dispatch('popstate');
    await flush();

    expect(windowObject.fetch).toHaveBeenCalledTimes(1);
    expect(initial.document.querySelector('[data-project-assets-live-region]')).toBe(previous.region);
    expect(initial.form.querySelector('input[name="category"]:checked')).toBe(previous.categoryMissing);
    expect(checkedInline(previous)).toEqual([previous.inlineCategory.missing]);
    expect(previous.inlineCategory.current.textContent).toBe('Missing');
  });

  it('keeps the attempted category through a failed request and retries it with the existing Retry', async () => {
    const initial = makePage({ withInlineCategory: true });
    const next = makePage({ withInlineCategory: true });
    const { windowObject } = makeWindow(initial.document, new Map([['next', next.document]]));
    windowObject.fetch.mockRejectedValueOnce(new Error('offline'));
    enhanceProjectAssetsLiveFiltering(initial.document);

    choose(initial.inlineCategory.renders, inlineInputs(initial));
    await flush();
    expect(initial.document.querySelector('[data-project-assets-live-region]')).toBe(initial.region);
    expect(liveFailureNotice(initial.document)).toBeTruthy();
    expect(liveFailureRetries(initial.document)).toHaveLength(1);
    expect(initial.categoryRenders.checked).toBe(true);
    expect(checkedInline(initial)).toEqual([initial.inlineCategory.renders]);

    windowObject.fetch.mockResolvedValueOnce(htmlResponse('next', windowObject.fetch.mock.calls[0][0]));
    liveFailureRetries(initial.document)[0].dispatch('click');
    await flush();
    expect(windowObject.fetch).toHaveBeenCalledTimes(2);
    expect(windowObject.fetch.mock.calls[1][0]).toBe(windowObject.fetch.mock.calls[0][0]);
    expect(initial.document.querySelector('[data-project-assets-live-region]')).toBe(next.region);
  });
});

describe('WP6 Project Assets refresh with loaded defaults', () => {
  const LOADED = {
    view: 'grid', gridStyle: 'cropped', gridSize: 'large', listSize: 'compact',
    sort: 'size', order: 'desc', pageSize: '50', extension: ['jpg'], tag: 'all',
  };

  function setup(options = {}, { concreteCategory = false } = {}) {
    const page = makePage(options);
    if (concreteCategory) {
      page.categoryAll.checked = false;
      page.categoryMissing.checked = false;
      page.categoryRenders.checked = true;
    }
    const next = makePage();
    const { windowObject } = makeWindow(page.document, new Map([['loaded', next.document]]));
    windowObject.fetch.mockResolvedValue(htmlResponse('loaded', 'http://creatorcrate.test/projects/1/assets'));
    enhanceProjectAssetsLiveFiltering(page.document);
    return { page, next, windowObject };
  }

  it('keeps Category, Search, Show, Usage and page, loads presentation, and suspends a restricting default under a concrete Category', async () => {
    const { page, windowObject } = setup({
      searchValue: 'needle', presence: 'present', usage: 'used', page: '3',
      tag: '8', extension: 'png', inheritedFilterDefaults: 'tag,extension',
    }, { concreteCategory: true });
    const generation = beginProjectAssetsDefaultsLiveRefresh(page.document);

    expect(refreshProjectAssetsWithLoadedDefaults(page.document, generation, LOADED)).toBe('started');
    await flush();

    const requested = new URL(windowObject.fetch.mock.calls[0][0]);
    expect(requested.searchParams.get('category')).toBe('7');
    expect(requested.searchParams.get('search')).toBe('needle');
    expect(requested.searchParams.get('presence')).toBe('present');
    expect(requested.searchParams.get('usage')).toBe('used');
    expect(requested.searchParams.get('page')).toBe('3');
    expect(requested.searchParams.get('view')).toBe('grid');
    expect(requested.searchParams.get('sort')).toBe('size');
    expect(requested.searchParams.get('order')).toBe('desc');
    expect(requested.searchParams.get('pageSize')).toBe('50');
    // The saved Extension restriction is suspended (marked, not applied); the
    // saved Tag default is unrestricted, so it carries no marker at all.
    expect(requested.searchParams.getAll('extension')).toEqual([]);
    expect(requested.searchParams.getAll('tag')).toEqual([]);
    expect(requested.searchParams.get('inheritedFilterDefaults')).toBe('extension');
  });

  it('applies restricting defaults as inherited under All Categories and replaces an explicit filter', async () => {
    const { page, windowObject } = setup({ tag: '9', extension: 'webp' });
    const generation = beginProjectAssetsDefaultsLiveRefresh(page.document);

    refreshProjectAssetsWithLoadedDefaults(page.document, generation, { ...LOADED, tag: ['8', '3'] });
    await flush();

    const requested = new URL(windowObject.fetch.mock.calls[0][0]);
    expect(requested.searchParams.get('category')).toBe('all');
    expect(requested.searchParams.getAll('tag')).toEqual(['8', '3']);
    expect(requested.searchParams.getAll('extension')).toEqual(['jpg']);
    expect(requested.searchParams.get('inheritedFilterDefaults')).toBe('tag,extension');
  });

  it('lets a newer filter load win, and fetches nothing when the view would not change', async () => {
    const { page, windowObject } = setup({ searchValue: 'needle' });
    const stale = beginProjectAssetsDefaultsLiveRefresh(page.document);
    page.usageUsed.checked = true;
    page.usageAll.checked = false;
    page.usageUsed.dispatch('change');
    await flush();
    expect(windowObject.fetch).toHaveBeenCalledOnce();

    expect(refreshProjectAssetsWithLoadedDefaults(page.document, stale, LOADED)).toBe('superseded');
    expect(windowObject.fetch).toHaveBeenCalledOnce();

    const current = makePage({ view: 'grid', sort: 'size', order: 'desc', pageSize: '50', extension: 'jpg', inheritedFilterDefaults: 'extension' });
    const idle = makeWindow(current.document, new Map());
    enhanceProjectAssetsLiveFiltering(current.document);
    const generation = beginProjectAssetsDefaultsLiveRefresh(current.document);
    expect(refreshProjectAssetsWithLoadedDefaults(current.document, generation, LOADED, { presentationUnchanged: true }))
      .toBe('applied');
    expect(idle.windowObject.fetch).not.toHaveBeenCalled();
  });

  it('reports a failed load with the activation wording, handled like a Defaults save refresh failure', async () => {
    const { page, windowObject } = setup();
    windowObject.fetch.mockReset();
    windowObject.fetch.mockRejectedValueOnce(new Error('offline'));
    const onError = vi.fn();
    const generation = beginProjectAssetsDefaultsLiveRefresh(page.document);

    expect(refreshProjectAssetsWithLoadedDefaults(page.document, generation, LOADED, { onError })).toBe('started');
    await flush();

    expect(onError).toHaveBeenCalledOnce();
    expect(page.status.textContent).toBe(
      'Defaults scope changed, but Project Assets could not refresh. Refresh the page to see the loaded defaults.',
    );
    expect(page.region.getAttribute('data-project-assets-live-state')).toBe('error');
    // As for a failed Defaults save refresh, no owed mutation means no GET Retry.
    expect(liveFailureRetries(page.document)).toHaveLength(0);
  });
});

describe('WP10b F5 toolbar View keeps the latest intended Project Assets filters', () => {
  function heldFetch(windowObject) {
    const requests = [];
    windowObject.fetch.mockImplementation((url, options) => new Promise((resolve, reject) => {
      requests.push({ url, options, resolve, reject });
      options?.signal?.addEventListener?.('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    return requests;
  }

  const viewControl = (page) => page.form.querySelector('[name="view"]');
  const methodOf = (request) => String(request.options?.method || 'GET').toUpperCase();

  it('applies List to a still-pending Extension GET; the stale GET loses and history records only the View', async () => {
    const initial = makePage({ view: 'grid', page: '1', viewUrl: '/projects/1/assets?view=list' });
    const stale = makePage({ view: 'grid', extension: 'png' });
    const listed = makePage({ view: 'list', extension: 'png' });
    const { windowObject } = makeWindow(initial.document, new Map([['stale', stale.document], ['listed', listed.document]]));
    windowObject.location.href = 'http://creatorcrate.test/projects/1/assets?view=grid';
    const requests = heldFetch(windowObject);

    enhanceProjectAssetsLiveFiltering(initial.document);
    initial.extensionInput.value = 'png';
    initial.form.dispatch('change', { target: initial.extensionInput });
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0].url).searchParams.getAll('extension')).toEqual(['png']);

    const click = initial.viewLink.dispatch('click', { button: 0 });
    expect(click.defaultPrevented).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[0].options.signal.aborted).toBe(true);
    const viewUrl = new URL(requests[1].url);
    expect(methodOf(requests[1])).toBe('GET');
    expect(viewUrl.pathname).toBe('/projects/1/assets');
    expect(viewUrl.searchParams.getAll('extension')).toEqual(['png']);
    expect(viewUrl.searchParams.getAll('view')).toEqual(['list']);
    expect(viewControl(initial).value).toBe('list');

    requests[1].resolve(htmlResponse('listed', requests[1].url));
    await flush();
    requests[0].resolve(htmlResponse('stale', requests[0].url));
    await flush();
    expect(initial.document.querySelector('[data-project-assets-live-region]')).toBe(listed.region);
    expect(windowObject.history.pushes.map((entry) => entry.url)).toEqual([requests[1].url]);
    expect(windowObject.location.href).toBe(requests[1].url);
    expect(requests.every((request) => methodOf(request) === 'GET')).toBe(true);
  });

  it('applies List to a debounced Search, sending only the latest Search once with the clicked View', async () => {
    vi.useFakeTimers();
    try {
      const initial = makePage({ view: 'grid', page: '1', extension: 'png', viewUrl: '/projects/1/assets?extension=png&view=list' });
      const listed = makePage({ view: 'list' });
      const { windowObject } = makeWindow(initial.document, new Map([['listed', listed.document]]));
      windowObject.location.href = 'http://creatorcrate.test/projects/1/assets?extension=png&view=grid';
      const requests = heldFetch(windowObject);

      enhanceProjectAssetsLiveFiltering(initial.document);
      initial.search.value = 'alpha';
      initial.search.dispatch('input');
      initial.search.value = 'beta';
      initial.search.dispatch('input');
      expect(requests).toHaveLength(0);
      initial.viewLink.dispatch('click', { button: 0 });
      expect(requests).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(requests).toHaveLength(1);

      const viewUrl = new URL(requests[0].url);
      expect(viewUrl.searchParams.get('search')).toBe('beta');
      expect(viewUrl.searchParams.getAll('extension')).toEqual(['png']);
      expect(viewUrl.searchParams.getAll('view')).toEqual(['list']);
      requests[0].resolve(htmlResponse('listed', requests[0].url));
      await flush();
      expect(windowObject.history.pushes.map((entry) => entry.url)).toEqual([requests[0].url]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps Category, Tag, Extension, Presence, Usage, Sort, Order and page size with the clicked View, without comma-joining', () => {
    const initial = makePage({
      view: 'grid',
      tags: ['8', '9'],
      extensions: ['png'],
      sort: 'size',
      order: 'desc',
      pageSize: '50',
      viewUrl: '/projects/1/assets?view=list',
    });
    addInput(initial.form, { name: 'extension', type: 'hidden' }, 'jpg');
    const { windowObject } = makeWindow(initial.document, new Map());
    const requests = heldFetch(windowObject);

    enhanceProjectAssetsLiveFiltering(initial.document);
    initial.categoryAll.checked = false;
    initial.categoryRenders.checked = true;
    initial.presenceAll.checked = false;
    initial.presencePresent.checked = true;
    initial.usageAll.checked = false;
    initial.usageUnused.checked = true;
    initial.form.dispatch('change', { target: initial.usageUnused });
    expect(requests).toHaveLength(1);

    initial.viewLink.dispatch('click', { button: 0 });
    expect(requests).toHaveLength(2);
    const viewUrl = new URL(requests[1].url);
    expect(viewUrl.searchParams.get('category')).toBe('7');
    expect(viewUrl.searchParams.getAll('tag')).toEqual(['8', '9']);
    expect(viewUrl.searchParams.getAll('extension')).toEqual(['png', 'jpg']);
    expect(viewUrl.searchParams.get('presence')).toBe('present');
    expect(viewUrl.searchParams.get('usage')).toBe('unused');
    expect(viewUrl.searchParams.get('sort')).toBe('size');
    expect(viewUrl.searchParams.get('order')).toBe('desc');
    expect(viewUrl.searchParams.get('pageSize')).toBe('50');
    expect(viewUrl.searchParams.getAll('view')).toEqual(['list']);
    expect(viewUrl.searchParams.has('page')).toBe(false);
    expect(viewUrl.search).not.toMatch(/%2C|,/);
  });

  it('switches List to Grid over a pending Tag GET and keeps Grid after the stale List response', async () => {
    const initial = makePage({ view: 'list', page: '1', viewUrl: '/projects/1/assets?view=grid' });
    const stale = makePage({ view: 'list' });
    const gridded = makePage({ view: 'grid' });
    const { windowObject } = makeWindow(initial.document, new Map([['stale', stale.document], ['grid', gridded.document]]));
    windowObject.location.href = 'http://creatorcrate.test/projects/1/assets?view=list';
    const requests = heldFetch(windowObject);

    enhanceProjectAssetsLiveFiltering(initial.document);
    initial.tagInput.value = '8';
    initial.form.dispatch('change', { target: initial.tagInput });
    initial.viewLink.dispatch('click', { button: 0 });
    const viewUrl = new URL(requests[1].url);
    expect(viewUrl.searchParams.getAll('tag')).toEqual(['8']);
    expect(viewUrl.searchParams.getAll('view')).toEqual(['grid']);
    expect(viewControl(initial).value).toBe('grid');

    requests[1].resolve(htmlResponse('grid', requests[1].url));
    await flush();
    requests[0].resolve(htmlResponse('stale', requests[0].url));
    await flush();
    expect(initial.document.querySelector('[data-project-assets-live-region]')).toBe(gridded.region);
    expect(windowObject.location.href).toBe(requests[1].url);
  });

  it('keeps the intended filters of a failed GET and retries the View with GET only', async () => {
    const initial = makePage({ view: 'grid', page: '1', viewUrl: '/projects/1/assets?view=list' });
    const listed = makePage({ view: 'list' });
    const { windowObject } = makeWindow(initial.document, new Map([['listed', listed.document]]));
    windowObject.location.href = 'http://creatorcrate.test/projects/1/assets?view=grid';
    const requests = heldFetch(windowObject);

    enhanceProjectAssetsLiveFiltering(initial.document);
    initial.extensionInput.value = 'png';
    initial.form.dispatch('change', { target: initial.extensionInput });
    requests[0].reject(new Error('network'));
    await flush();
    expect(liveFailureNotice(initial.document)).not.toBeNull();

    initial.viewLink.dispatch('click', { button: 0 });
    let viewUrl = new URL(requests[1].url);
    expect(viewUrl.searchParams.getAll('extension')).toEqual(['png']);
    expect(viewUrl.searchParams.getAll('view')).toEqual(['list']);
    requests[1].reject(new Error('network'));
    await flush();
    expect(initial.document.querySelector('[data-project-assets-live-region]')).toBe(initial.region);
    expect(windowObject.location.href).toBe('http://creatorcrate.test/projects/1/assets?view=grid');
    expect(windowObject.history.pushes).toHaveLength(0);

    liveFailureRetries(initial.document)[0].dispatch('click', { button: 0 });
    expect(requests).toHaveLength(3);
    viewUrl = new URL(requests[2].url);
    expect(methodOf(requests[2])).toBe('GET');
    expect(viewUrl.searchParams.getAll('extension')).toEqual(['png']);
    expect(viewUrl.searchParams.getAll('view')).toEqual(['list']);
    requests[2].resolve(htmlResponse('listed', requests[2].url));
    await flush();
    expect(initial.document.querySelector('[data-project-assets-live-region]')).toBe(listed.region);
    expect(windowObject.history.pushes.map((entry) => entry.url)).toEqual([requests[2].url]);
  });

  it('follows the canonical link on an idle page and a filter edit made meanwhile keeps the clicked View', () => {
    const initial = makePage({ view: 'grid', page: '1', extension: 'png', viewUrl: '/projects/1/assets?extension=png&view=list' });
    const { windowObject } = makeWindow(initial.document, new Map());
    windowObject.location.href = 'http://creatorcrate.test/projects/1/assets?extension=png&view=grid';
    const requests = heldFetch(windowObject);

    enhanceProjectAssetsLiveFiltering(initial.document);
    initial.viewLink.dispatch('click', { button: 0 });
    expect(new URL(requests[0].url).pathname + new URL(requests[0].url).search)
      .toBe('/projects/1/assets?extension=png&view=list');
    expect(viewControl(initial).value).toBe('list');
    initial.presenceAll.checked = false;
    initial.presenceMissing.checked = true;
    initial.form.dispatch('change', { target: initial.presenceMissing });
    const next = new URL(requests[1].url);
    expect(next.searchParams.get('presence')).toBe('missing');
    expect(next.searchParams.getAll('view')).toEqual(['list']);
  });

  it('leaves pagination and Reset on their own address during a pending filter GET', () => {
    const initial = makePage({
      view: 'grid',
      paginationUrl: '/projects/1/assets?page=3&view=grid',
      viewUrl: '/projects/1/assets?view=list',
    });
    const { windowObject } = makeWindow(initial.document, new Map());
    const requests = heldFetch(windowObject);

    enhanceProjectAssetsLiveFiltering(initial.document);
    initial.extensionInput.value = 'png';
    initial.form.dispatch('change', { target: initial.extensionInput });
    initial.paginationLink.dispatch('click', { button: 0 });
    expect(new URL(requests[1].url).pathname + new URL(requests[1].url).search).toBe('/projects/1/assets?page=3&view=grid');

    initial.extensionInput.value = 'jpg';
    initial.form.dispatch('change', { target: initial.extensionInput });
    initial.reset.dispatch('click', { button: 0 });
    expect(new URL(requests[3].url).pathname + new URL(requests[3].url).search).toBe('/projects/1/assets?resetFilters=1');
    expect(viewControl(initial).value).toBe('grid');
  });

  it('keeps the filter destination an NSFW POST was carrying when View is clicked before it answers', () => {
    const initial = makePage({ view: 'grid', page: '1', viewUrl: '/projects/1/assets?view=list' });
    const { windowObject } = makeWindow(initial.document, new Map());
    windowObject.location.href = 'http://creatorcrate.test/projects/1/assets?view=grid';
    const requests = heldFetch(windowObject);

    enhanceProjectAssetsLiveFiltering(initial.document);
    initial.extensionInput.value = 'png';
    initial.form.dispatch('change', { target: initial.extensionInput });
    initial.nsfwForm.dispatch('submit');
    expect(methodOf(requests[1])).toBe('POST');

    initial.viewLink.dispatch('click', { button: 0 });
    expect(requests[1].options.signal.aborted).toBe(true);
    const viewUrl = new URL(requests[2].url);
    expect(methodOf(requests[2])).toBe('GET');
    expect(viewUrl.searchParams.getAll('extension')).toEqual(['png']);
    expect(viewUrl.searchParams.getAll('view')).toEqual(['list']);
  });
});

describe('F7 toolbar View during a pending Project Assets Reset filters', () => {
  const ORIGIN = 'http://creatorcrate.test';
  const RESET = '/projects/1/assets?resetFilters=1';
  const TEMPORARY = '/projects/1/assets?extension=png&search=alpha&sort=filename&order=asc&pageSize=25';
  // The address the server's Reset redirect restores from the saved defaults.
  const RESTORED = `${ORIGIN}/projects/1/assets?extension=jpg&sort=size&order=desc&pageSize=10&inheritedFilterDefaults=extension`;

  function heldFetch(windowObject) {
    const requests = [];
    windowObject.fetch.mockImplementation((url, options) => new Promise((resolve, reject) => {
      requests.push({ url, options, resolve, reject });
      options?.signal?.addEventListener?.('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    return requests;
  }

  const pathOf = (request) => {
    const url = new URL(request.url);
    return url.pathname + url.search;
  };
  const methodOf = (request) => String(request.options?.method || 'GET').toUpperCase();
  const viewControl = (page) => page.form.querySelector('[name="view"]');
  const installed = (page) => page.document.querySelector('[data-project-assets-live-region]');
  const withView = (url, view) => {
    const next = new URL(url);
    next.searchParams.set('view', view);
    return next.href;
  };

  function setup({ view = 'grid', viewUrl = `${TEMPORARY}&view=list`, pages = [] } = {}) {
    const initial = makePage({
      view, page: '1', extension: 'png', searchValue: 'alpha', viewUrl,
    });
    const { windowObject } = makeWindow(initial.document, new Map(pages.map((page) => [page.key, page.document])));
    windowObject.location.href = `${ORIGIN}${TEMPORARY}&view=${view}`;
    const requests = heldFetch(windowObject);
    enhanceProjectAssetsLiveFiltering(initial.document);
    const phases = [];
    initial.document.addEventListener(PROJECT_ASSETS_FILTERS_RESET_EVENT, (event) => phases.push(event.detail.phase));
    return { initial, windowObject, requests, phases };
  }

  function restoredPage(key, view) {
    const page = makePage({ view, page: '1', extension: 'jpg', sort: 'size', order: 'desc', pageSize: '10' });
    page.key = key;
    return page;
  }

  it('keeps the pending Reset, then continues at its restored address with only the clicked View', async () => {
    const listed = restoredPage('listed', 'list');
    const { initial, windowObject, requests, phases } = setup({ pages: [listed] });

    initial.reset.dispatch('click', { target: initial.reset, button: 0 });
    expect(requests.map(pathOf)).toEqual([RESET]);
    const click = initial.viewLink.dispatch('click', { button: 0 });
    expect(click.defaultPrevented).toBe(true);
    // The click is the Reset's View: nothing is superseded or sent.
    expect(requests).toHaveLength(1);
    expect(requests[0].options.signal.aborted).toBe(false);
    expect(viewControl(initial).value).toBe('list');
    expect(phases).toEqual(['started']);
    expect(projectAssetsFiltersResetPending(initial.document)).toMatchObject({ phase: 'pending' });

    const resetResponse = htmlResponse('not-installed', RESTORED);
    requests[0].resolve(resetResponse);
    await flush();
    expect(resetResponse.text).not.toHaveBeenCalled();
    expect(requests).toHaveLength(2);
    expect(methodOf(requests[1])).toBe('GET');
    expect(requests[1].url).toBe(withView(RESTORED, 'list'));
    // Still the same Reset: nothing installed in between, no history yet.
    expect(phases).toEqual(['started']);
    expect(installed(initial)).toBe(initial.region);
    expect(windowObject.history.pushes).toHaveLength(0);

    requests[1].resolve(htmlResponse('listed', requests[1].url));
    await flush();
    expect(phases).toEqual(['started', 'prepared', 'installed']);
    expect(installed(initial)).toBe(listed.region);
    expect(viewControl(initial).value).toBe('list');
    expect(initial.form.querySelector('#search').value).toBe('');
    expect(initial.form.querySelector('input[name="sort"]').value).toBe('size');
    expect(initial.form.querySelector('input[name="pageSize"]').value).toBe('10');
    expect(windowObject.history.pushes.map(({ url }) => url)).toEqual([withView(RESTORED, 'list')]);
    expect(windowObject.location.href).toBe(withView(RESTORED, 'list'));
    expect(requests.every((request) => methodOf(request) === 'GET')).toBe(true);
  });

  it('lets the latest of several View clicks win, including one made while the continuation is in flight', async () => {
    const gridded = restoredPage('gridded', 'grid');
    const listed = restoredPage('listed', 'list');
    const { initial, windowObject, requests, phases } = setup({ view: 'list', pages: [gridded, listed] });

    initial.reset.dispatch('click', { target: initial.reset, button: 0 });
    initial.viewLink.dispatch('click', { button: 0 });
    // The Grid link leaves the default View implicit.
    initial.viewLink.setAttribute('href', TEMPORARY);
    initial.viewLink.dispatch('click', { button: 0 });
    expect(viewControl(initial).value).toBe('grid');
    expect(requests).toHaveLength(1);

    requests[0].resolve(htmlResponse('not-installed', RESTORED));
    await flush();
    expect(requests[1].url).toBe(withView(RESTORED, 'grid'));
    // List again while the continuation is in flight: it continues once more.
    initial.viewLink.setAttribute('href', `${TEMPORARY}&view=list`);
    initial.viewLink.dispatch('click', { button: 0 });
    expect(requests).toHaveLength(2);
    expect(requests[1].options.signal.aborted).toBe(false);
    requests[1].resolve(htmlResponse('gridded', withView(RESTORED, 'grid')));
    await flush();
    expect(requests).toHaveLength(3);
    expect(requests[2].url).toBe(withView(RESTORED, 'list'));

    requests[2].resolve(htmlResponse('listed', requests[2].url));
    await flush();
    expect(installed(initial)).toBe(listed.region);
    expect(phases).toEqual(['started', 'prepared', 'installed']);
    expect(windowObject.history.pushes.map(({ url }) => url)).toEqual([withView(RESTORED, 'list')]);
    expect(requests).toHaveLength(3);
  });

  it('installs the Reset response directly when it already shows the clicked View', async () => {
    const listed = restoredPage('listed', 'list');
    const { initial, windowObject, requests, phases } = setup({ pages: [listed] });

    initial.reset.dispatch('click', { target: initial.reset, button: 0 });
    initial.viewLink.dispatch('click', { button: 0 });
    requests[0].resolve(htmlResponse('listed', withView(RESTORED, 'list')));
    await flush();
    expect(requests).toHaveLength(1);
    expect(installed(initial)).toBe(listed.region);
    expect(phases).toEqual(['started', 'prepared', 'installed']);
    expect(windowObject.history.pushes.map(({ url }) => url)).toEqual([withView(RESTORED, 'list')]);
  });

  it('a failed Reset never claims success; its GET-only Retry restores the defaults with the chosen View', async () => {
    const listed = restoredPage('listed', 'list');
    const { initial, windowObject, requests, phases } = setup({ pages: [listed] });

    initial.reset.dispatch('click', { target: initial.reset, button: 0 });
    initial.viewLink.dispatch('click', { button: 0 });
    requests[0].reject(new Error('offline'));
    await flush();
    expect(phases).toEqual(['started', 'failed']);
    expect(installed(initial)).toBe(initial.region);
    expect(initial.form.querySelector('#search').value).toBe('alpha');
    expect(windowObject.history.pushes).toHaveLength(0);
    expect(liveFailureNotice(initial.document)).not.toBeNull();
    expect(requests).toHaveLength(1);

    liveFailureRetries(initial.document)[0].dispatch('click', { button: 0 });
    expect(requests.map(pathOf)).toEqual([RESET, RESET]);
    requests[1].resolve(htmlResponse('not-installed', RESTORED));
    await flush();
    expect(requests[2].url).toBe(withView(RESTORED, 'list'));
    requests[2].resolve(htmlResponse('listed', requests[2].url));
    await flush();
    expect(phases).toEqual(['started', 'failed', 'started', 'prepared', 'installed']);
    expect(installed(initial)).toBe(listed.region);
    expect(liveFailureNotice(initial.document)).toBeNull();
    expect(windowObject.history.pushes.map(({ url }) => url)).toEqual([withView(RESTORED, 'list')]);
    expect(requests.every((request) => methodOf(request) === 'GET')).toBe(true);
  });

  it('a View click on a failed Reset re-requests that Reset (GET) with the View', async () => {
    const listed = restoredPage('listed', 'list');
    const { initial, requests, phases } = setup({ pages: [listed] });

    initial.reset.dispatch('click', { target: initial.reset, button: 0 });
    requests[0].reject(new Error('offline'));
    await flush();
    initial.viewLink.dispatch('click', { button: 0 });
    expect(requests.map(pathOf)).toEqual([RESET, RESET]);
    requests[1].resolve(htmlResponse('not-installed', RESTORED));
    await flush();
    expect(requests[2].url).toBe(withView(RESTORED, 'list'));
    requests[2].resolve(htmlResponse('listed', requests[2].url));
    await flush();
    expect(installed(initial)).toBe(listed.region);
    expect(phases).toEqual(['started', 'failed', 'started', 'prepared', 'installed']);
  });

  it('a failed follow-up View GET keeps the installed page; Retry repeats the Reset and the View', async () => {
    const listed = restoredPage('listed', 'list');
    const { initial, windowObject, requests, phases } = setup({ pages: [listed] });

    initial.reset.dispatch('click', { target: initial.reset, button: 0 });
    initial.viewLink.dispatch('click', { button: 0 });
    requests[0].resolve(htmlResponse('not-installed', RESTORED));
    await flush();
    requests[1].reject(new Error('offline'));
    await flush();
    expect(phases).toEqual(['started', 'failed']);
    expect(installed(initial)).toBe(initial.region);
    expect(windowObject.location.href).toBe(`${ORIGIN}${TEMPORARY}&view=grid`);
    expect(windowObject.history.pushes).toHaveLength(0);

    liveFailureRetries(initial.document)[0].dispatch('click', { button: 0 });
    expect(pathOf(requests[2])).toBe(RESET);
    requests[2].resolve(htmlResponse('not-installed', RESTORED));
    await flush();
    expect(requests[3].url).toBe(withView(RESTORED, 'list'));
    requests[3].resolve(htmlResponse('listed', requests[3].url));
    await flush();
    expect(installed(initial)).toBe(listed.region);
    expect(phases).toEqual(['started', 'failed', 'started', 'prepared', 'installed']);
    expect(windowObject.history.pushes.map(({ url }) => url)).toEqual([withView(RESTORED, 'list')]);
    expect(requests.every((request) => methodOf(request) === 'GET')).toBe(true);
  });

  it('a newer filter edit supersedes the Reset and its View; the late Reset response never installs or continues', async () => {
    const newer = makePage({ view: 'list', presence: 'missing' });
    newer.key = 'newer';
    const { initial, windowObject, requests, phases } = setup({ pages: [newer] });

    initial.reset.dispatch('click', { target: initial.reset, button: 0 });
    initial.viewLink.dispatch('click', { button: 0 });
    initial.presenceAll.checked = false;
    initial.presenceMissing.checked = true;
    initial.form.dispatch('change', { target: initial.presenceMissing });
    expect(requests[0].options.signal.aborted).toBe(true);
    expect(phases).toEqual(['started', 'superseded']);
    const edit = new URL(requests[1].url);
    expect(edit.searchParams.get('presence')).toBe('missing');
    // The edit keeps the View the user chose.
    expect(edit.searchParams.get('view')).toBe('list');

    requests[1].resolve(htmlResponse('newer', requests[1].url));
    await flush();
    requests[0].resolve(htmlResponse('not-installed', RESTORED));
    await flush();
    expect(requests).toHaveLength(2);
    expect(installed(initial)).toBe(newer.region);
    expect(windowObject.location.href).toBe(requests[1].url);
  });

  it('Back during a pending Reset + View abandons both', async () => {
    const previous = makePage({ view: 'grid' });
    previous.key = 'previous';
    const { initial, windowObject, requests, phases } = setup({ pages: [previous] });

    initial.reset.dispatch('click', { target: initial.reset, button: 0 });
    initial.viewLink.dispatch('click', { button: 0 });
    windowObject.location.href = `${ORIGIN}/projects/1/assets?view=grid`;
    windowObject.dispatch('popstate');
    expect(phases).toEqual(['started', 'superseded']);
    requests[0].resolve(htmlResponse('not-installed', RESTORED));
    requests[1].resolve(htmlResponse('previous', requests[1].url));
    await flush();
    expect(requests).toHaveLength(2);
    expect(installed(initial)).toBe(previous.region);
    expect(windowObject.history.pushes).toHaveLength(0);
  });

  it('a new Reset click starts a new Reset without the earlier View', async () => {
    const restored = restoredPage('restored', 'grid');
    const { initial, requests, phases } = setup({ pages: [restored] });

    initial.reset.dispatch('click', { target: initial.reset, button: 0 });
    initial.viewLink.dispatch('click', { button: 0 });
    initial.reset.dispatch('click', { target: initial.reset, button: 0 });
    expect(requests.map(pathOf)).toEqual([RESET, RESET]);
    requests[1].resolve(htmlResponse('restored', RESTORED));
    await flush();
    expect(requests).toHaveLength(2);
    expect(installed(initial)).toBe(restored.region);
    expect(phases).toEqual(['started', 'superseded', 'started', 'prepared', 'installed']);
  });
});

describe('F10 pure Grid/List View keeps the Project Assets selection', () => {
  const ORIGIN = 'http://creatorcrate.test';

  function heldFetch(windowObject) {
    const requests = [];
    windowObject.fetch.mockImplementation((url, options) => new Promise((resolve, reject) => {
      requests.push({ url, options, resolve, reject });
      options?.signal?.addEventListener?.('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    return requests;
  }

  const installed = (page) => page.document.querySelector('[data-project-assets-live-region]');
  const methodOf = (request) => String(request.options?.method || 'GET').toUpperCase();
  const checkedIds = (page) => page.region.querySelectorAll('input[type="checkbox"][name="selectedAssetIds"]')
    .filter((box) => box.checked)
    .map((box) => box.value);

  // A server-rendered page: its toolbar View links are the canonical address of
  // the effective filter context it was rendered for, as in projects/assets.njk.
  function viewPage({ key = null, view = 'grid', query = '', ids = [1, 2, 3], selected = [], membership = null } = {}) {
    const page = makePage({ withAssetSelection: true, view, page: '1' });
    page.key = key;
    page.selectionCheckbox.remove();
    const base = `/projects/1/assets${query ? `?${query}` : ''}`;
    const nav = makeNode({ tagName: 'nav', attrs: { class: 'view-switcher' } });
    page.gridLink = makeNode({ tagName: 'a', attrs: { class: 'view-switcher-option', href: base } });
    page.listLink = makeNode({ tagName: 'a', attrs: { class: 'view-switcher-option', href: `${base}${query ? '&' : '?'}view=list` } });
    nav.appendChild(page.gridLink);
    nav.appendChild(page.listLink);
    page.region.appendChild(nav);
    page.boxes = new Map();
    ids.forEach((id) => {
      const card = makeNode({ tagName: 'article', attrs: { 'data-asset-id': String(id), 'data-asset-selectable-card': '' } });
      const box = makeNode({ tagName: 'input', attrs: { type: 'checkbox', name: 'selectedAssetIds', value: String(id) } });
      box.checked = selected.includes(id);
      box.form = page.selectionForm;
      card.appendChild(box);
      (view === 'list' ? page.list : page.grid).appendChild(card);
      page.boxes.set(id, box);
    });
    if (membership) {
      const marker = makeNode({ tagName: 'script', attrs: { 'data-project-assets-membership': '' } });
      marker.textContent = JSON.stringify(membership);
      page.region.appendChild(marker);
    }
    return page;
  }

  function setup(initial, pages, location = `${ORIGIN}/projects/1/assets`) {
    const { windowObject, setLocation } = makeWindow(initial.document, new Map(pages.map((page) => [page.key, page.document])));
    windowObject.location.href = location;
    const requests = heldFetch(windowObject);
    enhanceProjectAssetsLiveFiltering(initial.document);
    return { windowObject, setLocation, requests };
  }

  it('Grid -> List keeps the same selected identities, count and history, with GET only', async () => {
    const initial = viewPage({ selected: [1, 3] });
    const listed = viewPage({ key: 'listed', view: 'list' });
    const { windowObject, requests } = setup(initial, [listed]);

    initial.listLink.dispatch('click', { button: 0 });
    expect(requests).toHaveLength(1);
    requests[0].resolve(htmlResponse('listed', requests[0].url));
    await flush();

    expect(installed(initial)).toBe(listed.region);
    expect(checkedIds(listed)).toEqual(['1', '3']);
    expect(listed.selectedCount.textContent).toBe('2 of 1 selected');
    expect(retainedAssetSelectionIds(initial.document)).toEqual([]);
    expect(windowObject.history.pushes.map((entry) => entry.url)).toEqual([`${ORIGIN}/projects/1/assets?view=list`]);
    expect(requests.every((request) => methodOf(request) === 'GET')).toBe(true);
  });

  it('List -> Grid keeps the same identities under a filtered context', async () => {
    const query = 'extension=png&sort=size';
    const initial = viewPage({ view: 'list', query, selected: [2] });
    const gridded = viewPage({ key: 'gridded', view: 'grid', query });
    const { requests } = setup(initial, [gridded], `${ORIGIN}/projects/1/assets?${query}&view=list`);

    initial.gridLink.dispatch('click', { button: 0 });
    requests[0].resolve(htmlResponse('gridded', requests[0].url));
    await flush();

    expect(installed(initial)).toBe(gridded.region);
    expect(checkedIds(gridded)).toEqual(['2']);
    expect(gridded.boxes.get(1).checked).toBe(false);
  });

  it('keeps a hidden retained selection hidden and unsubmitted across a pure View change', async () => {
    const initial = viewPage({ ids: [1, 2], selected: [1, 2], membership: [1, 2] });
    const refreshed = viewPage({ key: 'refreshed', ids: [1], membership: [1, 2] });
    const listed = viewPage({ key: 'listed', view: 'list', ids: [1], membership: [1, 2] });
    const { requests } = setup(initial, [refreshed, listed]);

    const completion = refreshProjectAssetsAfterMutation(initial.document);
    await flush();
    requests[0].resolve(htmlResponse('refreshed', requests[0].url));
    await completion;
    expect(retainedAssetSelectionIds(initial.document)).toEqual(['2']);
    expect(refreshed.selectedCount.textContent).toBe('1 of 1 selected (1 more not shown)');

    refreshed.listLink.dispatch('click', { button: 0 });
    requests[1].resolve(htmlResponse('listed', requests[1].url));
    await flush();

    expect(installed(initial)).toBe(listed.region);
    // Only rendered checkboxes are submitted: 1 is, retained 2 is not rendered.
    expect(checkedIds(listed)).toEqual(['1']);
    expect(retainedAssetSelectionIds(initial.document)).toEqual(['2']);
    expect(listed.selectedCount.textContent).toBe('1 of 1 selected (1 more not shown)');
  });

  it('a genuine Extension change still starts a new selection, retained ids included', async () => {
    const initial = viewPage({ ids: [1, 2], selected: [1, 2], membership: [1, 2] });
    const refreshed = viewPage({ key: 'refreshed', ids: [1], membership: [1, 2] });
    const filtered = viewPage({ key: 'filtered', query: 'extension=png', ids: [1], membership: [1, 2] });
    const { requests } = setup(initial, [refreshed, filtered]);

    const completion = refreshProjectAssetsAfterMutation(initial.document);
    await flush();
    requests[0].resolve(htmlResponse('refreshed', requests[0].url));
    await completion;
    expect(retainedAssetSelectionIds(initial.document)).toEqual(['2']);

    // The filter form is outside the region: it stays, with reconciled controls.
    const extension = initial.form.querySelector('[name="extension"]');
    extension.value = 'png';
    initial.form.dispatch('change', { target: extension });
    expect(new URL(requests[1].url).searchParams.getAll('extension')).toEqual(['png']);
    requests[1].resolve(htmlResponse('filtered', requests[1].url));
    await flush();

    expect(installed(initial)).toBe(filtered.region);
    expect(checkedIds(filtered)).toEqual([]);
    expect(retainedAssetSelectionIds(initial.document)).toEqual([]);
  });

  it('a View click joined to a debounced Search is a filter change and clears', async () => {
    vi.useFakeTimers();
    try {
      const initial = viewPage({ selected: [1] });
      const searched = viewPage({ key: 'searched', view: 'list', query: 'search=beta' });
      const { requests } = setup(initial, [searched]);

      initial.search.value = 'beta';
      initial.search.dispatch('input');
      initial.listLink.dispatch('click', { button: 0 });
      expect(requests).toHaveLength(1);
      expect(new URL(requests[0].url).searchParams.get('search')).toBe('beta');
      requests[0].resolve(htmlResponse('searched', requests[0].url));
      await flush();

      expect(installed(initial)).toBe(searched.region);
      expect(checkedIds(searched)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failed View GET keeps the installed selection; GET-only Retry then keeps it', async () => {
    const initial = viewPage({ selected: [2, 3] });
    const listed = viewPage({ key: 'listed', view: 'list' });
    const { requests } = setup(initial, [listed]);

    initial.listLink.dispatch('click', { button: 0 });
    requests[0].reject(new Error('offline'));
    await flush();
    expect(installed(initial)).toBe(initial.region);
    expect(checkedIds(initial)).toEqual(['2', '3']);
    expect(liveFailureRetries(initial.document)).toHaveLength(1);

    liveFailureRetries(initial.document)[0].dispatch('click');
    expect(requests).toHaveLength(2);
    requests[1].resolve(htmlResponse('listed', requests[1].url));
    await flush();
    expect(installed(initial)).toBe(listed.region);
    expect(checkedIds(listed)).toEqual(['2', '3']);
    expect(requests.every((request) => methodOf(request) === 'GET')).toBe(true);
  });

  it('rapid Grid -> List -> Grid: the stale List response loses and the selection survives once', async () => {
    const initial = viewPage({ selected: [1, 2] });
    const listed = viewPage({ key: 'listed', view: 'list' });
    const gridded = viewPage({ key: 'gridded', view: 'grid' });
    const { requests } = setup(initial, [listed, gridded]);

    initial.listLink.dispatch('click', { button: 0 });
    initial.gridLink.dispatch('click', { button: 0 });
    expect(requests).toHaveLength(2);
    expect(requests[0].options.signal.aborted).toBe(true);
    requests[1].resolve(htmlResponse('gridded', requests[1].url));
    await flush();
    requests[0].resolve(htmlResponse('listed', requests[0].url));
    await flush();

    expect(installed(initial)).toBe(gridded.region);
    expect(checkedIds(gridded)).toEqual(['1', '2']);
    expect(checkedIds(listed)).toEqual([]);
    expect(retainedAssetSelectionIds(initial.document)).toEqual([]);
  });

  it('Back to the same filters in the other View keeps the selection; Back to other filters clears', async () => {
    const initial = viewPage({ view: 'list', selected: [3] });
    const gridded = viewPage({ key: 'gridded', view: 'grid' });
    const other = viewPage({ key: 'other', view: 'grid', query: 'extension=png' });
    const { requests, setLocation, windowObject } = setup(initial, [gridded, other], `${ORIGIN}/projects/1/assets?view=list`);

    setLocation(`${ORIGIN}/projects/1/assets`);
    windowObject.dispatch('popstate');
    expect(requests).toHaveLength(1);
    requests[0].resolve(htmlResponse('gridded', requests[0].url));
    await flush();
    expect(installed(initial)).toBe(gridded.region);
    expect(checkedIds(gridded)).toEqual(['3']);

    setLocation(`${ORIGIN}/projects/1/assets?extension=png`);
    windowObject.dispatch('popstate');
    requests[1].resolve(htmlResponse('other', requests[1].url));
    await flush();
    expect(installed(initial)).toBe(other.region);
    expect(checkedIds(other)).toEqual([]);
  });

  it('a pagination change is not a pure View change and clears', async () => {
    const initial = viewPage({ selected: [1] });
    const paged = viewPage({ key: 'paged', query: 'page=2' });
    const pagination = makeNode({ tagName: 'nav', attrs: { class: 'pagination' } });
    const next = makeNode({ tagName: 'a', attrs: { href: '/projects/1/assets?page=2' } });
    pagination.appendChild(next);
    initial.region.appendChild(pagination);
    const { requests } = setup(initial, [paged]);

    next.dispatch('click', { button: 0 });
    expect(requests).toHaveLength(1);
    requests[0].resolve(htmlResponse('paged', requests[0].url));
    await flush();
    expect(installed(initial)).toBe(paged.region);
    expect(checkedIds(paged)).toEqual([]);
  });

  it('Reset filters keeps its selection-clearing contract even when only the View differs', async () => {
    const initial = viewPage({ selected: [1, 2] });
    const restored = viewPage({ key: 'restored', view: 'list' });
    const { requests } = setup(initial, [restored]);

    initial.reset.dispatch('click', { target: initial.reset, button: 0 });
    expect(new URL(requests[0].url).searchParams.get('resetFilters')).toBe('1');
    requests[0].resolve(htmlResponse('restored', `${ORIGIN}/projects/1/assets?view=list`));
    await flush();
    expect(installed(initial)).toBe(restored.region);
    expect(checkedIds(restored)).toEqual([]);
  });

  it('without a rendered View context (an older region) the established clearing stands', async () => {
    const initial = viewPage({ selected: [1] });
    const bare = makePage({ withAssetSelection: true, view: 'list', page: '1' });
    bare.key = 'bare';
    bare.selectionCheckbox.value = '1';
    const { requests } = setup(initial, [bare]);

    initial.listLink.dispatch('click', { button: 0 });
    requests[0].resolve(htmlResponse('bare', requests[0].url));
    await flush();
    expect(installed(initial)).toBe(bare.region);
    expect(bare.selectionCheckbox.checked).toBe(false);
  });
});

describe('F7-R1 a mutation refresh during a pending Project Assets Reset filters', () => {
  const ORIGIN = 'http://creatorcrate.test';
  const RESET = '/projects/1/assets?resetFilters=1';
  const RESTORED_QUERY = 'extension=jpg&sort=size&order=desc&pageSize=10';
  const RESTORED = `${ORIGIN}/projects/1/assets?${RESTORED_QUERY}`;
  const TEMPORARY = 'extension=png&search=alpha&sort=filename&order=asc&pageSize=25';

  function heldFetch(windowObject) {
    const requests = [];
    windowObject.fetch.mockImplementation((url, options) => new Promise((resolve, reject) => {
      requests.push({ url, options, resolve, reject });
      options?.signal?.addEventListener?.('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    return requests;
  }

  const installed = (page) => page.document.querySelector('[data-project-assets-live-region]');
  const methodOf = (request) => String(request.options?.method || 'GET').toUpperCase();
  const pathOf = (request) => {
    const url = new URL(request.url);
    return url.pathname + url.search;
  };
  const withView = (url, view) => {
    const next = new URL(url);
    next.searchParams.set('view', view);
    return next.href;
  };
  const checkedIds = (page) => page.region.querySelectorAll('input[type="checkbox"][name="selectedAssetIds"]')
    .filter((box) => box.checked)
    .map((box) => box.value);
  const phases = (events) => events.map((event) => event.phase);

  // A server-rendered page whose toolbar View links name its filter context.
  function viewPage({ key = null, view = 'grid', query = '', ids = [1, 2, 3], selected = [], membership = null, gridStyle = null } = {}) {
    const page = makePage({ withAssetSelection: true, view, page: '1' });
    page.key = key;
    page.selectionCheckbox.remove();
    if (gridStyle) page.grid.setAttribute('data-grid-style', gridStyle);
    const base = `/projects/1/assets${query ? `?${query}` : ''}`;
    const nav = makeNode({ tagName: 'nav', attrs: { class: 'view-switcher' } });
    page.gridLink = makeNode({ tagName: 'a', attrs: { class: 'view-switcher-option', href: base } });
    page.listLink = makeNode({ tagName: 'a', attrs: { class: 'view-switcher-option', href: `${base}${query ? '&' : '?'}view=list` } });
    nav.appendChild(page.gridLink);
    nav.appendChild(page.listLink);
    page.region.appendChild(nav);
    page.boxes = new Map();
    ids.forEach((id) => {
      const card = makeNode({ tagName: 'article', attrs: { 'data-asset-id': String(id), 'data-asset-selectable-card': '' } });
      const box = makeNode({ tagName: 'input', attrs: { type: 'checkbox', name: 'selectedAssetIds', value: String(id) } });
      box.checked = selected.includes(id);
      box.form = page.selectionForm;
      card.appendChild(box);
      (view === 'list' ? page.list : page.grid).appendChild(card);
      page.boxes.set(id, box);
    });
    if (membership) {
      const marker = makeNode({ tagName: 'script', attrs: { 'data-project-assets-membership': '' } });
      marker.textContent = JSON.stringify(membership);
      page.region.appendChild(marker);
    }
    return page;
  }

  // The restored (saved-defaults) page: JPG identities 5 and 6 only.
  const restoredPage = (key, view) => viewPage({
    key, view, query: RESTORED_QUERY, ids: [5, 6], membership: [1, 2, 5, 6], gridStyle: 'cropped',
  });

  // Temporary PNG page with visible 1 selected and 2 retained hidden by an
  // ordinary acknowledged-mutation refresh (which preserves both identities).
  async function setup(pages = []) {
    const initial = viewPage({ query: TEMPORARY, ids: [1, 2], selected: [1, 2], membership: [1, 2, 5, 6], gridStyle: 'uncropped' });
    const refreshed = viewPage({ key: 'refreshed', query: TEMPORARY, ids: [1], membership: [1, 2, 5, 6], gridStyle: 'cropped' });
    const { windowObject, setLocation } = makeWindow(initial.document, new Map([refreshed, ...pages].map((page) => [page.key, page.document])));
    windowObject.location.href = `${ORIGIN}/projects/1/assets?${TEMPORARY}`;
    const requests = heldFetch(windowObject);
    enhanceProjectAssetsLiveFiltering(initial.document);
    const events = [];
    initial.document.addEventListener(PROJECT_ASSETS_FILTERS_RESET_EVENT, (event) => events.push({ id: event.detail.id, phase: event.detail.phase }));

    const ordinary = refreshProjectAssetsAfterMutation(initial.document);
    await flush();
    requests[0].resolve(htmlResponse('refreshed', requests[0].url));
    expect(await ordinary).toMatchObject({ status: 'installed' });
    // Control: an ordinary mutation refresh keeps the selection and Grid style.
    expect(checkedIds(refreshed)).toEqual(['1']);
    expect(retainedAssetSelectionIds(initial.document)).toEqual(['2']);
    expect(refreshed.selectedCount.textContent).toBe('1 of 1 selected (1 more not shown)');
    expect(refreshed.grid.getAttribute('data-grid-style')).toBe('uncropped');
    requests.length = 0;
    windowObject.history.pushes.length = 0;
    return { initial, refreshed, windowObject, setLocation, requests, events };
  }

  function expectResetInstalled(page, initial) {
    expect(installed(initial)).toBe(page.region);
    expect(checkedIds(page)).toEqual([]);
    expect(retainedAssetSelectionIds(initial.document)).toEqual([]);
    // The server's restored Grid style stands; the pre-Reset one is not carried.
    expect(page.grid.getAttribute('data-grid-style')).toBe('cropped');
    expect(projectAssetsFiltersResetPending(initial.document)).toBeNull();
  }

  it('A: refresh during the held View continuation carries the Reset: one lifecycle, latest View, selection cleared', async () => {
    const listed = restoredPage('listed', 'list');
    const { initial, refreshed, windowObject, requests, events } = await setup([listed]);

    initial.reset.dispatch('click', { target: initial.reset, button: 0 });
    refreshed.listLink.dispatch('click', { button: 0 });
    requests[0].resolve(htmlResponse('not-installed', RESTORED));
    await flush();
    expect(requests[1].url).toBe(withView(RESTORED, 'list'));
    const resetId = events[0].id;

    const refresh = refreshProjectAssetsAfterMutation(initial.document);
    // The obsolete continuation is aborted; the refresh re-reads the Reset.
    expect(requests[1].options.signal.aborted).toBe(true);
    expect(pathOf(requests[2])).toBe(RESET);
    expect(projectAssetsFiltersResetPending(initial.document)).toMatchObject({ id: resetId, phase: 'pending' });
    requests[2].resolve(htmlResponse('not-installed', RESTORED));
    await flush();
    expect(requests[3].url).toBe(withView(RESTORED, 'list'));
    requests[3].resolve(htmlResponse('listed', requests[3].url));
    expect(await refresh).toMatchObject({ status: 'installed' });
    // The obsolete continuation released last installs nothing.
    requests[1].resolve(htmlResponse('refreshed', requests[1].url));
    await flush();

    expect(events).toEqual([
      { id: resetId, phase: 'started' },
      { id: resetId, phase: 'prepared' },
      { id: resetId, phase: 'installed' },
    ]);
    expectResetInstalled(listed, initial);
    expect(windowObject.history.pushes.map(({ url }) => url)).toEqual([withView(RESTORED, 'list')]);
    expect(requests).toHaveLength(4);
    expect(requests.every((request) => methodOf(request) === 'GET')).toBe(true);
  });

  it('B: the continuation answering before the refresh starts installs the Reset normally', async () => {
    const listed = restoredPage('listed', 'list');
    const relisted = restoredPage('relisted', 'list');
    const { initial, refreshed, requests, events } = await setup([listed, relisted]);

    initial.reset.dispatch('click', { target: initial.reset, button: 0 });
    refreshed.listLink.dispatch('click', { button: 0 });
    requests[0].resolve(htmlResponse('not-installed', RESTORED));
    await flush();
    requests[1].resolve(htmlResponse('listed', requests[1].url));
    await flush();
    expect(phases(events)).toEqual(['started', 'prepared', 'installed']);
    expectResetInstalled(listed, initial);

    // A later mutation refresh is ordinary: it re-reads the installed address.
    const refresh = refreshProjectAssetsAfterMutation(initial.document);
    expect(new URL(requests[2].url).searchParams.has('resetFilters')).toBe(false);
    requests[2].resolve(htmlResponse('relisted', requests[2].url));
    expect(await refresh).toMatchObject({ status: 'installed' });
    expect(phases(events)).toEqual(['started', 'prepared', 'installed']);
    expect(installed(initial)).toBe(relisted.region);
  });

  it('C: refresh during the Reset resolution stage keeps the Reset and its View', async () => {
    const listed = restoredPage('listed', 'list');
    const { initial, refreshed, requests, events } = await setup([listed]);

    initial.reset.dispatch('click', { target: initial.reset, button: 0 });
    refreshed.listLink.dispatch('click', { button: 0 });
    const refresh = refreshProjectAssetsAfterMutation(initial.document);
    expect(requests[0].options.signal.aborted).toBe(true);
    expect(pathOf(requests[1])).toBe(RESET);
    requests[1].resolve(htmlResponse('not-installed', RESTORED));
    await flush();
    expect(requests[2].url).toBe(withView(RESTORED, 'list'));
    requests[2].resolve(htmlResponse('listed', requests[2].url));
    expect(await refresh).toMatchObject({ status: 'installed' });
    requests[0].resolve(htmlResponse('refreshed', RESTORED));
    await flush();

    expect(phases(events)).toEqual(['started', 'prepared', 'installed']);
    expectResetInstalled(listed, initial);
  });

  it('D/E: overlapping refreshes and a View change while one is pending still install one Reset with the latest View', async () => {
    const gridded = restoredPage('gridded', 'grid');
    const { initial, refreshed, requests, events } = await setup([gridded]);
    const recovered = vi.fn();

    initial.reset.dispatch('click', { target: initial.reset, button: 0 });
    refreshed.listLink.dispatch('click', { button: 0 });
    requests[0].resolve(htmlResponse('not-installed', RESTORED));
    await flush();
    const first = refreshProjectAssetsAfterMutation(initial.document, { onRecovered: recovered });
    const second = refreshProjectAssetsAfterMutation(initial.document);
    expect(await first).toMatchObject({ status: 'superseded' });
    expect(requests.slice(2).map(pathOf)).toEqual([RESET, RESET]);
    // Grid while the second refresh's Reset is in flight is the newest View.
    refreshed.gridLink.dispatch('click', { button: 0 });
    expect(requests).toHaveLength(4);
    requests[3].resolve(htmlResponse('not-installed', withView(RESTORED, 'list')));
    await flush();
    expect(requests[4].url).toBe(withView(RESTORED, 'grid'));
    requests[4].resolve(htmlResponse('gridded', requests[4].url));
    expect(await second).toMatchObject({ status: 'installed' });
    requests[2].resolve(htmlResponse('refreshed', RESTORED));
    await flush();

    expect(phases(events)).toEqual(['started', 'prepared', 'installed']);
    expect(recovered).toHaveBeenCalledTimes(1);
    expectResetInstalled(gridded, initial);
  });

  it('F: a newer filter edit supersedes the carried Reset; the refresh is satisfied but the edit clears the selection', async () => {
    const newer = viewPage({ key: 'newer', query: 'presence=missing', ids: [1], membership: [1, 2, 5, 6] });
    const { initial, refreshed, requests, events } = await setup([newer]);

    initial.reset.dispatch('click', { target: initial.reset, button: 0 });
    refreshed.listLink.dispatch('click', { button: 0 });
    requests[0].resolve(htmlResponse('not-installed', RESTORED));
    await flush();
    const refresh = refreshProjectAssetsAfterMutation(initial.document);
    initial.presenceAll.checked = false;
    initial.presenceMissing.checked = true;
    initial.form.dispatch('change', { target: initial.presenceMissing });
    expect(await refresh).toMatchObject({ status: 'superseded' });
    expect(phases(events)).toEqual(['started', 'superseded']);
    expect(new URL(requests[3].url).searchParams.has('resetFilters')).toBe(false);
    requests[3].resolve(htmlResponse('newer', requests[3].url));
    await flush();
    requests[2].resolve(htmlResponse('not-installed', RESTORED));
    await flush();

    expect(requests).toHaveLength(4);
    expect(installed(initial)).toBe(newer.region);
    // F7-R2a: the owed refresh is satisfied by the newer install, but the
    // newer filter edit keeps its own boundary: visible and hidden cleared.
    expect(await refresh).toMatchObject({ status: 'superseded' });
    expect(checkedIds(newer)).toEqual([]);
    expect(retainedAssetSelectionIds(initial.document)).toEqual([]);
    expect(phases(events)).toEqual(['started', 'superseded']);
  });

  it('G: Back during the carried Reset abandons it; no obsolete Reset is revived', async () => {
    const previous = viewPage({ key: 'previous', query: TEMPORARY, ids: [1], membership: [1, 2, 5, 6] });
    const { initial, refreshed, windowObject, setLocation, requests, events } = await setup([previous]);

    initial.reset.dispatch('click', { target: initial.reset, button: 0 });
    refreshed.listLink.dispatch('click', { button: 0 });
    requests[0].resolve(htmlResponse('not-installed', RESTORED));
    await flush();
    void refreshProjectAssetsAfterMutation(initial.document);
    setLocation(`${ORIGIN}/projects/1/assets?${TEMPORARY}`);
    windowObject.dispatch('popstate');
    expect(phases(events)).toEqual(['started', 'superseded']);
    requests[3].resolve(htmlResponse('previous', requests[3].url));
    await flush();
    requests[2].resolve(htmlResponse('not-installed', RESTORED));
    await flush();
    expect(requests).toHaveLength(4);
    expect(installed(initial)).toBe(previous.region);
    expect(projectAssetsFiltersResetPending(initial.document)).toBeNull();
    expect(windowObject.history.pushes).toHaveLength(0);
  });

  it('H: a new Reset click replaces the carried Reset', async () => {
    const restored = restoredPage('restored', 'grid');
    const { initial, refreshed, requests, events } = await setup([restored]);

    initial.reset.dispatch('click', { target: initial.reset, button: 0 });
    refreshed.listLink.dispatch('click', { button: 0 });
    requests[0].resolve(htmlResponse('not-installed', RESTORED));
    await flush();
    void refreshProjectAssetsAfterMutation(initial.document);
    initial.reset.dispatch('click', { target: initial.reset, button: 0 });
    expect(pathOf(requests[3])).toBe(RESET);
    requests[3].resolve(htmlResponse('restored', RESTORED));
    await flush();
    expect(requests).toHaveLength(4);
    expect(phases(events)).toEqual(['started', 'superseded', 'started', 'prepared', 'installed']);
    expect(events[2].id).toBeGreaterThan(events[0].id);
    expectResetInstalled(restored, initial);
  });

  it('a failed refresh GET claims no Reset; GET-only Retry completes the Reset with its View and clears the selection', async () => {
    const listed = restoredPage('listed', 'list');
    const { initial, refreshed, windowObject, requests, events } = await setup([listed]);

    initial.reset.dispatch('click', { target: initial.reset, button: 0 });
    refreshed.listLink.dispatch('click', { button: 0 });
    requests[0].resolve(htmlResponse('not-installed', RESTORED));
    await flush();
    const refresh = refreshProjectAssetsAfterMutation(initial.document);
    requests[2].reject(new Error('offline'));
    expect(await refresh).toMatchObject({ status: 'failed' });
    expect(phases(events)).toEqual(['started', 'failed']);
    expect(installed(initial)).toBe(refreshed.region);
    // Nothing completed: the pre-Reset selection is still the page's.
    expect(checkedIds(refreshed)).toEqual(['1']);
    expect(retainedAssetSelectionIds(initial.document)).toEqual(['2']);
    expect(windowObject.history.pushes).toHaveLength(0);

    liveFailureRetries(initial.document)[0].dispatch('click', { button: 0 });
    expect(pathOf(requests[3])).toBe(RESET);
    requests[3].resolve(htmlResponse('not-installed', RESTORED));
    await flush();
    expect(requests[4].url).toBe(withView(RESTORED, 'list'));
    requests[4].resolve(htmlResponse('listed', requests[4].url));
    await flush();
    // A late obsolete response loses.
    requests[1].resolve(htmlResponse('refreshed', requests[1].url));
    await flush();

    expect(phases(events)).toEqual(['started', 'failed', 'started', 'prepared', 'installed']);
    expectResetInstalled(listed, initial);
    expect(liveFailureNotice(initial.document)).toBeNull();
    expect(windowObject.history.pushes.map(({ url }) => url)).toEqual([withView(RESTORED, 'list')]);
    expect(requests.every((request) => methodOf(request) === 'GET')).toBe(true);
  });

  it('a refresh after a failed View continuation re-reads the Reset, not the continuation address', async () => {
    const listed = restoredPage('listed', 'list');
    const { initial, refreshed, requests, events } = await setup([listed]);

    initial.reset.dispatch('click', { target: initial.reset, button: 0 });
    refreshed.listLink.dispatch('click', { button: 0 });
    requests[0].resolve(htmlResponse('not-installed', RESTORED));
    await flush();
    requests[1].reject(new Error('offline'));
    await flush();
    expect(phases(events)).toEqual(['started', 'failed']);

    const refresh = refreshProjectAssetsAfterMutation(initial.document);
    expect(pathOf(requests[2])).toBe(RESET);
    requests[2].resolve(htmlResponse('not-installed', RESTORED));
    await flush();
    expect(requests[3].url).toBe(withView(RESTORED, 'list'));
    requests[3].resolve(htmlResponse('listed', requests[3].url));
    expect(await refresh).toMatchObject({ status: 'installed' });
    expect(phases(events)).toEqual(['started', 'failed', 'started', 'prepared', 'installed']);
    expectResetInstalled(listed, initial);
  });

  describe('F7-R2 request ownership', () => {
    const currentSearch = (page) => page.document.querySelector('[data-project-assets-live-region]')
      && page.form.querySelector('[name="search"]');
    const bulkPayload = (page) => page.region.querySelectorAll('input[type="checkbox"][name="selectedAssetIds"]')
      .filter((box) => box.checked && box.form === page.selectionForm)
      .map((box) => box.value);
    // A response whose headers have arrived while its body is still pending.
    function bodyHeld(url) {
      const body = deferred();
      return { response: { ok: true, url, text: vi.fn(() => body.promise) }, release: body.resolve };
    }

    async function searchDuringHeldRefresh(value) {
      // Search cleared shows every PNG again, including hidden 2.
      const searched = viewPage({ key: 'searched', query: value ? `extension=png&search=${value}` : 'extension=png', ids: [1, 2, 3], membership: [1, 2, 3, 5, 6] });
      const ctx = await setup([searched]);
      currentSearch(ctx.initial).value = 'alpha';
      const recovered = vi.fn();
      const refresh = refreshProjectAssetsAfterMutation(ctx.initial.document, { onRecovered: recovered });
      expect(pathOf(ctx.requests[0])).toContain('search=alpha');
      currentSearch(ctx.initial).value = value;
      ctx.initial.form.dispatch('submit', { target: ctx.initial.form });
      expect(await refresh).toMatchObject({ status: 'superseded' });
      expect(ctx.requests[0].options.signal.aborted).toBe(true);
      expect(new URL(ctx.requests[1].url).searchParams.get('search') ?? '').toBe(value);
      ctx.requests[1].resolve(htmlResponse('searched', ctx.requests[1].url));
      await flush();
      // The obsolete refresh released last installs nothing.
      ctx.requests[0].resolve(htmlResponse('refreshed', ctx.requests[0].url));
      await flush();
      expect(installed(ctx.initial)).toBe(searched.region);
      expect(checkedIds(searched)).toEqual([]);
      expect(retainedAssetSelectionIds(ctx.initial.document)).toEqual([]);
      expect(bulkPayload(searched)).toEqual([]);
      expect(recovered).toHaveBeenCalledTimes(1);
      expect(recovered.mock.calls[0][0].selection.removed.sort()).toEqual(['1', '2']);
      expect(ctx.requests).toHaveLength(2);
      expect(ctx.requests.every((request) => methodOf(request) === 'GET')).toBe(true);
    }

    it('R2a-A: Search cleared during a held mutation refresh clears visible and hidden selections', async () => {
      await searchDuringHeldRefresh('');
    });

    it('R2a-B: Search changed to another value during a held mutation refresh clears the selection', async () => {
      await searchDuringHeldRefresh('alp');
    });

    // The established refresh contract (mutation-refresh spec E) is unchanged:
    // a Search typed BEFORE the mutation is adopted by the refresh's own load.
    it('R2a: a refresh adopting a still-debounced Search keeps its own selection contract', async () => {
      const searched = viewPage({ key: 'searched', query: 'extension=png', ids: [1, 2, 3], membership: [1, 2, 3, 5, 6] });
      const { initial, requests } = await setup([searched]);
      const search = currentSearch(initial);
      search.value = '';
      search.dispatch('input', { target: search });
      const refresh = refreshProjectAssetsAfterMutation(initial.document);
      expect(requests).toHaveLength(1);
      expect(new URL(requests[0].url).searchParams.has('search')).toBe(false);
      requests[0].resolve(htmlResponse('searched', requests[0].url));
      expect(await refresh).toMatchObject({ status: 'installed' });
      expect(checkedIds(searched).sort()).toEqual(['1', '2']);
      expect(retainedAssetSelectionIds(initial.document)).toEqual([]);
    });

    it('R2a-E/F: a pure View during a held refresh, and the refresh\'s own Retry, keep the selection', async () => {
      const listed = viewPage({ key: 'listed', view: 'list', query: TEMPORARY, ids: [1], membership: [1, 2, 5, 6] });
      const again = viewPage({ key: 'again', view: 'list', query: TEMPORARY, ids: [1], membership: [1, 2, 5, 6] });
      const { initial, refreshed, requests } = await setup([listed, again]);
      void refreshProjectAssetsAfterMutation(initial.document);
      refreshed.listLink.dispatch('click', { button: 0 });
      requests[1].resolve(htmlResponse('listed', requests[1].url));
      await flush();
      expect(installed(initial)).toBe(listed.region);
      expect(checkedIds(listed)).toEqual(['1']);
      expect(retainedAssetSelectionIds(initial.document)).toEqual(['2']);

      const refresh = refreshProjectAssetsAfterMutation(initial.document);
      requests[2].reject(new Error('offline'));
      expect(await refresh).toMatchObject({ status: 'failed' });
      liveFailureRetries(initial.document)[0].dispatch('click', { button: 0 });
      requests[3].resolve(htmlResponse('again', requests[3].url));
      await flush();
      expect(installed(initial)).toBe(again.region);
      expect(checkedIds(again)).toEqual(['1']);
      expect(retainedAssetSelectionIds(initial.document)).toEqual(['2']);
    });

    it('R2b-G/H/I: Grid chosen while the List body is pending installs Grid in the same load', async () => {
      const listed = restoredPage('listed', 'list');
      const gridded = restoredPage('gridded', 'grid');
      const { initial, refreshed, windowObject, requests, events } = await setup([listed, gridded]);

      initial.reset.dispatch('click', { target: initial.reset, button: 0 });
      refreshed.listLink.dispatch('click', { button: 0 });
      requests[0].resolve(htmlResponse('not-installed', RESTORED));
      await flush();
      const held = bodyHeld(requests[1].url);
      requests[1].resolve(held.response);
      await flush();
      expect(held.response.text).toHaveBeenCalled();
      refreshed.gridLink.dispatch('click', { button: 0 });
      expect(requests).toHaveLength(2);
      held.release('listed');
      await flush();
      expect(installed(initial)).toBe(refreshed.region);
      expect(requests[2].url).toBe(withView(RESTORED, 'grid'));
      requests[2].resolve(htmlResponse('gridded', requests[2].url));
      await flush();

      expectResetInstalled(gridded, initial);
      expect(phases(events)).toEqual(['started', 'prepared', 'installed']);
      expect(windowObject.history.pushes.map(({ url }) => url)).toEqual([withView(RESTORED, 'grid')]);
      expect(requests).toHaveLength(3);
    });

    it('R2b-K: a rapid Grid then List while the List body is pending installs List with no extra GET', async () => {
      const listed = restoredPage('listed', 'list');
      const { initial, refreshed, windowObject, requests, events } = await setup([listed]);

      initial.reset.dispatch('click', { target: initial.reset, button: 0 });
      refreshed.listLink.dispatch('click', { button: 0 });
      requests[0].resolve(htmlResponse('not-installed', RESTORED));
      await flush();
      const held = bodyHeld(requests[1].url);
      requests[1].resolve(held.response);
      await flush();
      refreshed.gridLink.dispatch('click', { button: 0 });
      refreshed.listLink.dispatch('click', { button: 0 });
      held.release('listed');
      await flush();
      expectResetInstalled(listed, initial);
      expect(requests).toHaveLength(2);
      expect(phases(events)).toEqual(['started', 'prepared', 'installed']);
      expect(windowObject.history.pushes.map(({ url }) => url)).toEqual([withView(RESTORED, 'list')]);
    });

    it('R2b: Grid while the carried refresh\'s List body is pending wins; the refresh installs once', async () => {
      const listed = restoredPage('listed', 'list');
      const gridded = restoredPage('gridded', 'grid');
      const { initial, refreshed, windowObject, requests, events } = await setup([listed, gridded]);

      initial.reset.dispatch('click', { target: initial.reset, button: 0 });
      refreshed.listLink.dispatch('click', { button: 0 });
      requests[0].resolve(htmlResponse('not-installed', RESTORED));
      await flush();
      const refresh = refreshProjectAssetsAfterMutation(initial.document);
      expect(pathOf(requests[2])).toBe(RESET);
      requests[2].resolve(htmlResponse('not-installed', RESTORED));
      await flush();
      expect(requests[3].url).toBe(withView(RESTORED, 'list'));
      const held = bodyHeld(requests[3].url);
      requests[3].resolve(held.response);
      await flush();
      refreshed.gridLink.dispatch('click', { button: 0 });
      held.release('listed');
      await flush();
      expect(requests[4].url).toBe(withView(RESTORED, 'grid'));
      requests[4].resolve(htmlResponse('gridded', requests[4].url));
      expect(await refresh).toMatchObject({ status: 'installed' });
      // The obsolete original continuation released last installs nothing.
      requests[1].resolve(htmlResponse('listed', requests[1].url));
      await flush();

      expectResetInstalled(gridded, initial);
      expect(phases(events)).toEqual(['started', 'prepared', 'installed']);
      expect(windowObject.history.pushes.map(({ url }) => url)).toEqual([withView(RESTORED, 'grid')]);
      expect(requests).toHaveLength(5);
      expect(requests.every((request) => methodOf(request) === 'GET')).toBe(true);
    });

    it('R2b: a failed late-View continuation keeps the latest View for a GET-only Retry', async () => {
      const gridded = restoredPage('gridded', 'grid');
      const { initial, refreshed, requests, events } = await setup([gridded]);

      initial.reset.dispatch('click', { target: initial.reset, button: 0 });
      refreshed.listLink.dispatch('click', { button: 0 });
      requests[0].resolve(htmlResponse('not-installed', RESTORED));
      await flush();
      const held = bodyHeld(requests[1].url);
      requests[1].resolve(held.response);
      await flush();
      refreshed.gridLink.dispatch('click', { button: 0 });
      held.release('listed');
      await flush();
      requests[2].reject(new Error('offline'));
      await flush();
      expect(phases(events)).toEqual(['started', 'failed']);
      expect(installed(initial)).toBe(refreshed.region);

      liveFailureRetries(initial.document)[0].dispatch('click', { button: 0 });
      expect(pathOf(requests[3])).toBe(RESET);
      requests[3].resolve(htmlResponse('not-installed', RESTORED));
      await flush();
      expect(requests[4].url).toBe(withView(RESTORED, 'grid'));
      requests[4].resolve(htmlResponse('gridded', requests[4].url));
      await flush();
      expectResetInstalled(gridded, initial);
      expect(phases(events)).toEqual(['started', 'failed', 'started', 'prepared', 'installed']);
    });
  });

  // F7-R3: data-refresh ownership (which GET installs the mutated results) is
  // distinct from selection ownership (whether that install keeps or clears
  // the selection). A newer Search that took over an owed refresh decided
  // "clear"; later refreshes re-reading its destination keep that decision.
  describe('F7-R3 selection authority across several mutation refreshes', () => {
    const searchInput = (page) => page.form.querySelector('[name="search"]');
    const bulkPayload = (page) => page.region.querySelectorAll('input[type="checkbox"][name="selectedAssetIds"]')
      .filter((box) => box.checked && box.form === page.selectionForm)
      .map((box) => box.value);
    // Search cleared: every PNG (1, 2 and 3), including hidden 2.
    const pngPage = (key, view = 'grid') => viewPage({ key, view, query: 'extension=png', ids: [1, 2, 3], membership: [1, 2, 3, 5, 6] });
    const searchParam = (request) => new URL(request.url).searchParams.get('search');

    function expectCleared(page, initial) {
      expect(installed(initial)).toBe(page.region);
      expect(checkedIds(page)).toEqual([]);
      expect(retainedAssetSelectionIds(initial.document)).toEqual([]);
      expect(bulkPayload(page)).toEqual([]);
    }

    // M1 held, then Search cleared (a newer genuine filter) held.
    async function mutationThenSearch(pages) {
      const ctx = await setup(pages);
      searchInput(ctx.initial).value = 'alpha';
      ctx.m1Recovered = vi.fn();
      ctx.m1 = refreshProjectAssetsAfterMutation(ctx.initial.document, { onRecovered: ctx.m1Recovered });
      expect(searchParam(ctx.requests[0])).toBe('alpha');
      searchInput(ctx.initial).value = '';
      ctx.initial.form.dispatch('submit', { target: ctx.initial.form });
      expect(await ctx.m1).toMatchObject({ status: 'superseded' });
      expect(ctx.requests).toHaveLength(2);
      expect(searchParam(ctx.requests[1])).toBeNull();
      return ctx;
    }

    it('A/D/E: M1 -> newer Search -> M2 re-reading it installs first; old ids stay cleared', async () => {
      const searched = pngPage('searched');
      const ctx = await mutationThenSearch([searched]);
      const { initial, windowObject, requests } = ctx;
      const m2 = refreshProjectAssetsAfterMutation(initial.document);
      expect(requests[1].options.signal.aborted).toBe(true);
      expect(requests[2].url).toBe(requests[1].url);
      requests[2].resolve(htmlResponse('searched', requests[2].url));
      const result = await m2;
      expect(result).toMatchObject({ status: 'installed' });
      // Older responses released last install nothing.
      requests[1].resolve(htmlResponse('refreshed', requests[1].url));
      requests[0].resolve(htmlResponse('refreshed', requests[0].url));
      await flush();

      expectCleared(searched, initial);
      expect(result.reconciliation.selection.removed.sort()).toEqual(['1', '2']);
      expect(ctx.m1Recovered).toHaveBeenCalledTimes(1);
      expect(windowObject.history.pushes.map(({ url }) => url)).toEqual([requests[1].url]);
      expect(requests).toHaveLength(3);
      expect(requests.every((request) => methodOf(request) === 'GET')).toBe(true);
    });

    it('B: M1 -> newer Search -> M2 -> M3 keeps the clearing decision through every re-read', async () => {
      const searched = pngPage('searched');
      const { initial, windowObject, requests } = await mutationThenSearch([searched]);
      const m2 = refreshProjectAssetsAfterMutation(initial.document);
      const m3 = refreshProjectAssetsAfterMutation(initial.document);
      expect(await m2).toMatchObject({ status: 'superseded' });
      expect(requests.slice(2).map((request) => request.url)).toEqual([requests[1].url, requests[1].url]);
      requests[3].resolve(htmlResponse('searched', requests[3].url));
      expect(await m3).toMatchObject({ status: 'installed' });
      [2, 1, 0].forEach((index) => requests[index].resolve(htmlResponse('refreshed', requests[index].url)));
      await flush();

      expectCleared(searched, initial);
      expect(windowObject.history.pushes.map(({ url }) => url)).toEqual([requests[1].url]);
      expect(requests).toHaveLength(4);
    });

    it('C: the newer Search installing first clears; a later M2 is ordinary and keeps the new selection', async () => {
      const searched = pngPage('searched');
      const again = pngPage('again');
      const { initial, windowObject, requests } = await mutationThenSearch([searched, again]);
      requests[1].resolve(htmlResponse('searched', requests[1].url));
      await flush();
      expectCleared(searched, initial);
      // A selection made in the new Search context is the user's to keep.
      searched.boxes.get(3).checked = true;

      const m2 = refreshProjectAssetsAfterMutation(initial.document);
      expect(searchParam(requests[2])).toBeNull();
      requests[2].resolve(htmlResponse('again', requests[2].url));
      expect(await m2).toMatchObject({ status: 'installed' });
      requests[0].resolve(htmlResponse('refreshed', requests[0].url));
      await flush();
      expect(installed(initial)).toBe(again.region);
      expect(checkedIds(again)).toEqual(['3']);
      expect(bulkPayload(again)).toEqual(['3']);
      expect(windowObject.history.pushes.map(({ url }) => url)).toEqual([requests[1].url]);
    });

    it('F: a failed M2 re-read keeps the decision for its GET-only Retry; a later M3 keeps it too', async () => {
      const searched = pngPage('searched');
      const { initial, refreshed, windowObject, requests } = await mutationThenSearch([searched]);
      const m2 = refreshProjectAssetsAfterMutation(initial.document);
      requests[2].reject(new Error('offline'));
      expect(await m2).toMatchObject({ status: 'failed' });
      // Nothing installed: the page keeps its own selection meanwhile.
      expect(installed(initial)).toBe(refreshed.region);
      expect(checkedIds(refreshed)).toEqual(['1']);

      liveFailureRetries(initial.document)[0].dispatch('click', { button: 0 });
      expect(requests[3].url).toBe(requests[1].url);
      requests[3].reject(new Error('offline again'));
      await flush();
      const m3 = refreshProjectAssetsAfterMutation(initial.document);
      expect(requests[4].url).toBe(requests[1].url);
      requests[4].resolve(htmlResponse('searched', requests[4].url));
      expect(await m3).toMatchObject({ status: 'installed' });
      requests[1].resolve(htmlResponse('refreshed', requests[1].url));
      requests[0].resolve(htmlResponse('refreshed', requests[0].url));
      await flush();

      expectCleared(searched, initial);
      expect(liveFailureNotice(initial.document)).toBeNull();
      expect(windowObject.history.pushes.map(({ url }) => url)).toEqual([requests[1].url]);
      expect(requests.every((request) => methodOf(request) === 'GET')).toBe(true);
    });

    it('F: Retry of a failed M2 installs with the selection cleared', async () => {
      const searched = pngPage('searched');
      const { initial, requests } = await mutationThenSearch([searched]);
      void refreshProjectAssetsAfterMutation(initial.document);
      requests[2].reject(new Error('offline'));
      await flush();
      liveFailureRetries(initial.document)[0].dispatch('click', { button: 0 });
      requests[3].resolve(htmlResponse('searched', requests[3].url));
      await flush();
      expectCleared(searched, initial);
    });

    it('G: Search changed again while M2 is pending clears, as the newest navigation', async () => {
      const narrowed = viewPage({ key: 'narrowed', query: 'extension=png&search=be', ids: [2, 3], membership: [1, 2, 3, 5, 6] });
      const { initial, requests } = await mutationThenSearch([narrowed]);
      void refreshProjectAssetsAfterMutation(initial.document);
      searchInput(initial).value = 'be';
      initial.form.dispatch('submit', { target: initial.form });
      expect(searchParam(requests[3])).toBe('be');
      requests[3].resolve(htmlResponse('narrowed', requests[3].url));
      [2, 1, 0].forEach((index) => requests[index].resolve(htmlResponse('refreshed', requests[index].url)));
      await flush();
      expectCleared(narrowed, initial);
    });

    it('H: Back to another context while M2 is pending clears and adds no history entry', async () => {
      const jpg = viewPage({ key: 'jpg', query: 'extension=jpg', ids: [5, 6], membership: [1, 2, 5, 6] });
      const { initial, windowObject, setLocation, requests } = await mutationThenSearch([jpg]);
      void refreshProjectAssetsAfterMutation(initial.document);
      setLocation(`${ORIGIN}/projects/1/assets?extension=jpg`);
      windowObject.dispatch('popstate');
      requests[3].resolve(htmlResponse('jpg', requests[3].url));
      [2, 1, 0].forEach((index) => requests[index].resolve(htmlResponse('refreshed', requests[index].url)));
      await flush();
      expectCleared(jpg, initial);
      expect(windowObject.history.pushes).toHaveLength(0);
    });

    it('H: Back to the installed context abandons the Search and keeps the selection it belongs to (F10)', async () => {
      const previous = viewPage({ key: 'previous', query: TEMPORARY, ids: [1, 2], membership: [1, 2, 5, 6] });
      const { initial, windowObject, setLocation, requests } = await mutationThenSearch([previous]);
      void refreshProjectAssetsAfterMutation(initial.document);
      setLocation(`${ORIGIN}/projects/1/assets?${TEMPORARY}`);
      windowObject.dispatch('popstate');
      requests[3].resolve(htmlResponse('previous', requests[3].url));
      [2, 1, 0].forEach((index) => requests[index].resolve(htmlResponse('refreshed', requests[index].url)));
      await flush();
      expect(installed(initial)).toBe(previous.region);
      expect(checkedIds(previous).sort()).toEqual(['1', '2']);
      expect(retainedAssetSelectionIds(initial.document)).toEqual([]);
      expect(windowObject.history.pushes).toHaveLength(0);
    });

    it('I: a new Reset during M2 supersedes the sequence with Reset semantics', async () => {
      const restored = restoredPage('restored', 'grid');
      const { initial, requests, events } = await mutationThenSearch([restored]);
      void refreshProjectAssetsAfterMutation(initial.document);
      initial.reset.dispatch('click', { target: initial.reset, button: 0 });
      expect(pathOf(requests[3])).toBe(RESET);
      requests[3].resolve(htmlResponse('restored', RESTORED));
      [2, 1, 0].forEach((index) => requests[index].resolve(htmlResponse('refreshed', requests[index].url)));
      await flush();
      expectResetInstalled(restored, initial);
      expect(phases(events)).toEqual(['started', 'prepared', 'installed']);
    });

    it('J: a View click after M2 adopted the newer Search is still not a pure View change: cleared', async () => {
      const listed = pngPage('listed', 'list');
      const { initial, refreshed, requests } = await mutationThenSearch([listed]);
      void refreshProjectAssetsAfterMutation(initial.document);
      refreshed.listLink.dispatch('click', { button: 0 });
      const listedRequest = requests[requests.length - 1];
      expect(new URL(listedRequest.url).searchParams.get('view')).toBe('list');
      listedRequest.resolve(htmlResponse('listed', listedRequest.url));
      await flush();
      expectCleared(listed, initial);
    });

    it('J: a pure View change during M1, adopted by M2, keeps the selection (F10)', async () => {
      const listed = viewPage({ key: 'listed', view: 'list', query: TEMPORARY, ids: [1], membership: [1, 2, 5, 6] });
      const { initial, refreshed, requests } = await setup([listed]);
      void refreshProjectAssetsAfterMutation(initial.document);
      refreshed.listLink.dispatch('click', { button: 0 });
      const m2 = refreshProjectAssetsAfterMutation(initial.document);
      expect(requests[2].url).toBe(requests[1].url);
      requests[2].resolve(htmlResponse('listed', requests[2].url));
      expect(await m2).toMatchObject({ status: 'installed' });
      expect(installed(initial)).toBe(listed.region);
      expect(checkedIds(listed)).toEqual(['1']);
      expect(retainedAssetSelectionIds(initial.document)).toEqual(['2']);
    });

    it('K: M1 -> M2 with no newer filter keeps visible and hidden selections', async () => {
      const again = viewPage({ key: 'again', query: TEMPORARY, ids: [1], membership: [1, 2, 5, 6] });
      const { initial, requests } = await setup([again]);
      void refreshProjectAssetsAfterMutation(initial.document);
      const m2 = refreshProjectAssetsAfterMutation(initial.document);
      requests[1].resolve(htmlResponse('again', requests[1].url));
      expect(await m2).toMatchObject({ status: 'installed' });
      expect(checkedIds(again)).toEqual(['1']);
      expect(retainedAssetSelectionIds(initial.document)).toEqual(['2']);
      expect(bulkPayload(again)).toEqual(['1']);
    });

    it('L: a mutation adopting a Search already in flight before it keeps membership (WP09A)', async () => {
      const searched = pngPage('searched');
      const { initial, requests } = await setup([searched]);
      searchInput(initial).value = '';
      initial.form.dispatch('submit', { target: initial.form });
      expect(searchParam(requests[0])).toBeNull();
      const refresh = refreshProjectAssetsAfterMutation(initial.document);
      expect(requests[1].url).toBe(requests[0].url);
      requests[1].resolve(htmlResponse('searched', requests[1].url));
      expect(await refresh).toMatchObject({ status: 'installed' });
      expect(checkedIds(searched).sort()).toEqual(['1', '2']);
      expect(retainedAssetSelectionIds(initial.document)).toEqual([]);
      // The next mutation after that install is ordinary again.
    });

    it('L: once the cleared install lands, the next Search adopted by a mutation follows WP09A again', async () => {
      const searched = pngPage('searched');
      const narrowed = viewPage({ key: 'narrowed', query: 'extension=png&search=be', ids: [2, 3], membership: [1, 2, 3, 5, 6] });
      const { initial, requests } = await mutationThenSearch([searched, narrowed]);
      void refreshProjectAssetsAfterMutation(initial.document);
      requests[2].resolve(htmlResponse('searched', requests[2].url));
      await flush();
      expectCleared(searched, initial);
      searched.boxes.get(2).checked = true;
      searched.boxes.get(3).checked = true;

      searchInput(initial).value = 'be';
      initial.form.dispatch('submit', { target: initial.form });
      const refresh = refreshProjectAssetsAfterMutation(initial.document);
      requests[4].resolve(htmlResponse('narrowed', requests[4].url));
      expect(await refresh).toMatchObject({ status: 'installed' });
      expect(checkedIds(narrowed).sort()).toEqual(['2', '3']);
    });
  });
});

describe('R3 Project Assets presentation fields follow the native View select', () => {
  function heldFetch(windowObject) {
    const requests = [];
    windowObject.fetch.mockImplementation((url, options) => new Promise((resolve, reject) => {
      requests.push({ url, options, resolve, reject });
      options?.signal?.addEventListener?.('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    return requests;
  }
  const methodOf = (request) => String(request.options?.method || 'GET').toUpperCase();

  function nativeDropdown(parent, { id, name, value, options, form }) {
    const fieldset = makeNode({ tagName: 'fieldset' });
    const select = makeNode({
      tagName: 'select',
      attrs: { id, name, form, 'data-cc-dropdown-native-select': '' },
      value,
    });
    select.options = options.map((optionValue) => ({ value: optionValue, disabled: false }));
    const details = makeNode({
      tagName: 'details',
      attrs: { id: `${id}-dropdown`, 'data-cc-dropdown': '', 'data-cc-dropdown-mode': 'single' },
    });
    const summary = makeNode({ tagName: 'summary', attrs: { id: `${id}-trigger` } });
    details.appendChild(summary);
    fieldset.appendChild(select);
    fieldset.appendChild(details);
    parent.appendChild(fieldset);
    return { select, details, summary };
  }

  // The Miscellaneous section as assets.njk renders it: the live View select
  // (form="asset-filters") and the three presentation fields, each hidden by
  // the server for the inactive `renderedView`.
  function addPresentation(page, {
    renderedView = 'grid',
    selectValue = renderedView,
    gridStyle = 'cropped',
    gridSize = 'large',
    listSize = 'compact',
  } = {}) {
    const misc = makeNode({ tagName: 'section' });
    const viewWrapper = makeNode({ attrs: { 'data-project-assets-live-misc': 'view' } });
    // reconcileProjectAssetsAssociatedFilterControls moves childNodes.
    viewWrapper.childNodes = viewWrapper.children;
    const view = nativeDropdown(viewWrapper, {
      id: 'asset-view-filter', name: 'view', value: selectValue, options: ['grid', 'list'], form: 'asset-filters',
    });
    view.select.form = page.form;
    misc.appendChild(viewWrapper);
    const fields = {};
    [['gridStyle', 'grid', gridStyle], ['gridSize', 'grid', gridSize], ['listSize', 'list', listSize]]
      .forEach(([key, fieldView, value]) => {
        const wrapper = makeNode({
          attrs: {
            class: 'field app-dialog-field',
            'data-dialog-field': key,
            'data-filters-visible-when-view': fieldView,
            ...(fieldView !== renderedView ? { hidden: '' } : {}),
          },
        });
        const dropdown = nativeDropdown(wrapper, {
          id: `project-assets-defaults-${key}`,
          name: key,
          value,
          options: ['compact', 'default', 'large', 'cropped', 'uncropped'],
          form: 'project-assets-defaults-form',
        });
        misc.appendChild(wrapper);
        fields[key] = { wrapper, ...dropdown };
      });
    page.dialog.appendChild(misc);
    return { viewWrapper, view, fields };
  }

  const shown = (presentation) => Object.fromEntries(
    Object.entries(presentation.fields).map(([key, field]) => [key, !field.wrapper.hidden]),
  );
  const values = (presentation) => Object.fromEntries(
    Object.entries(presentation.fields).map(([key, field]) => [key, field.select.value]),
  );
  const GRID = { gridStyle: true, gridSize: true, listSize: false };
  const LIST = { gridStyle: false, gridSize: false, listSize: true };
  const KEPT = { gridStyle: 'cropped', gridSize: 'large', listSize: 'compact' };

  it('keeps the server-rendered visibility on enhance and reconciles a browser-restored View select', () => {
    const grid = makePage({ view: 'grid' });
    const gridFields = addPresentation(grid, { renderedView: 'grid' });
    makeWindow(grid.document);
    enhanceProjectAssetsLiveFiltering(grid.document);
    expect(shown(gridFields)).toEqual(GRID);

    const restored = makePage({ view: 'grid' });
    const restoredFields = addPresentation(restored, { renderedView: 'grid', selectValue: 'list' });
    makeWindow(restored.document);
    enhanceProjectAssetsLiveFiltering(restored.document);
    expect(shown(restoredFields)).toEqual(LIST);
    expect(values(restoredFields)).toEqual(KEPT);
  });

  it('a dialog View choice hides the inactive fields at once, keeps every value, and sends one GET and no POST', () => {
    const initial = makePage({ view: 'grid' });
    const presentation = addPresentation(initial, { renderedView: 'grid' });
    const { windowObject } = makeWindow(initial.document);
    const requests = heldFetch(windowObject);
    enhanceProjectAssetsLiveFiltering(initial.document);

    presentation.view.select.value = 'list';
    presentation.view.select.dispatch('change');
    expect(shown(presentation)).toEqual(LIST);
    expect(values(presentation)).toEqual(KEPT);
    // Hidden is presentation only: still enabled, named and form-associated.
    ['gridStyle', 'gridSize'].forEach((key) => {
      const { select } = presentation.fields[key];
      expect(select.disabled).toBe(false);
      expect(select.getAttribute('name')).toBe(key);
      expect(select.getAttribute('form')).toBe('project-assets-defaults-form');
    });
    expect(requests).toHaveLength(1);

    presentation.view.select.value = 'grid';
    presentation.view.select.dispatch('change');
    expect(shown(presentation)).toEqual(GRID);
    expect(values(presentation)).toEqual(KEPT);
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => methodOf(request) === 'GET')).toBe(true);
  });

  it('follows a toolbar View click, which sends no change event', () => {
    const initial = makePage({ view: 'grid', viewUrl: '/projects/1/assets?view=list' });
    const presentation = addPresentation(initial, { renderedView: 'grid' });
    const { windowObject } = makeWindow(initial.document);
    const requests = heldFetch(windowObject);
    enhanceProjectAssetsLiveFiltering(initial.document);

    initial.viewLink.dispatch('click', { button: 0 });
    expect(presentation.view.select.value).toBe('list');
    expect(shown(presentation)).toEqual(LIST);
    expect(values(presentation)).toEqual(KEPT);
    expect(requests).toHaveLength(1);
    expect(methodOf(requests[0])).toBe('GET');
  });

  it('a replaced View control decides the fields; an older response released last changes nothing', async () => {
    const initial = makePage({ view: 'grid', viewUrl: '/projects/1/assets?view=list' });
    const presentation = addPresentation(initial, { renderedView: 'grid' });
    const stale = makePage({ view: 'grid', extension: 'png' });
    addPresentation(stale, { renderedView: 'grid' });
    const listed = makePage({ view: 'list', extension: 'png' });
    addPresentation(listed, { renderedView: 'list' });
    const { windowObject } = makeWindow(initial.document, new Map([['stale', stale.document], ['listed', listed.document]]));
    windowObject.location.href = 'http://creatorcrate.test/projects/1/assets?view=grid';
    const requests = heldFetch(windowObject);
    enhanceProjectAssetsLiveFiltering(initial.document);

    initial.extensionInput.value = 'png';
    initial.form.dispatch('change', { target: initial.extensionInput });
    initial.viewLink.dispatch('click', { button: 0 });
    expect(requests).toHaveLength(2);
    expect(shown(presentation)).toEqual(LIST);

    requests[1].resolve(htmlResponse('listed', requests[1].url));
    await flush();
    // The response's View control replaced the dialog's own.
    const control = initial.document.querySelector('#asset-view-filter');
    expect(control).not.toBe(presentation.view.select);
    expect(control.value).toBe('list');
    expect(shown(presentation)).toEqual(LIST);

    requests[0].resolve(htmlResponse('stale', requests[0].url));
    await flush();
    expect(initial.document.querySelector('#asset-view-filter').value).toBe('list');
    expect(shown(presentation)).toEqual(LIST);
    expect(values(presentation)).toEqual(KEPT);
    expect(requests.every((request) => methodOf(request) === 'GET')).toBe(true);
  });

  it('a Reset filters response restores the saved View and its fields without a POST', async () => {
    const initial = makePage({ view: 'list' });
    const presentation = addPresentation(initial, { renderedView: 'list' });
    const restored = makePage({ view: 'grid' });
    addPresentation(restored, { renderedView: 'grid' });
    const { windowObject } = makeWindow(initial.document, new Map([['restored', restored.document]]));
    const requests = heldFetch(windowObject);
    enhanceProjectAssetsLiveFiltering(initial.document);
    expect(shown(presentation)).toEqual(LIST);

    initial.reset.dispatch('click', { button: 0 });
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0].url).searchParams.get('resetFilters')).toBe('1');
    requests[0].resolve(htmlResponse('restored', 'http://creatorcrate.test/projects/1/assets?view=grid'));
    await flush();
    expect(initial.document.querySelector('#asset-view-filter').value).toBe('grid');
    expect(shown(presentation)).toEqual(GRID);
    expect(requests.every((request) => methodOf(request) === 'GET')).toBe(true);
  });

  it('a failed GET keeps the chosen View fields, and its Retry is GET only', async () => {
    const initial = makePage({ view: 'grid', viewUrl: '/projects/1/assets?view=list' });
    const presentation = addPresentation(initial, { renderedView: 'grid' });
    const listed = makePage({ view: 'list' });
    addPresentation(listed, { renderedView: 'list' });
    const { windowObject } = makeWindow(initial.document, new Map([['listed', listed.document]]));
    const requests = heldFetch(windowObject);
    enhanceProjectAssetsLiveFiltering(initial.document);

    initial.viewLink.dispatch('click', { button: 0 });
    requests[0].reject(new Error('network'));
    await flush();
    expect(liveFailureNotice(initial.document)).not.toBeNull();
    expect(shown(presentation)).toEqual(LIST);

    liveFailureRetries(initial.document)[0].dispatch('click', { button: 0 });
    expect(requests).toHaveLength(2);
    expect(methodOf(requests[1])).toBe('GET');
    requests[1].resolve(htmlResponse('listed', requests[1].url));
    await flush();
    expect(shown(presentation)).toEqual(LIST);
    expect(values(presentation)).toEqual(KEPT);
  });

  it('closes an open dropdown in a field being hidden and moves its focus to the View control', () => {
    const initial = makePage({ view: 'grid', viewUrl: '/projects/1/assets?view=list' });
    const presentation = addPresentation(initial, { renderedView: 'grid' });
    const { windowObject } = makeWindow(initial.document);
    heldFetch(windowObject);
    enhanceProjectAssetsLiveFiltering(initial.document);

    const gridSize = presentation.fields.gridSize;
    gridSize.details.open = true;
    gridSize.details.setAttribute('open', '');
    gridSize.summary.focus();
    initial.viewLink.dispatch('click', { button: 0 });
    expect(gridSize.wrapper.hidden).toBe(true);
    expect(gridSize.details.open).toBe(false);
    expect(gridSize.details.hasAttribute('open')).toBe(false);
    expect(initial.document.activeElement).toBe(presentation.view.summary);

    // Showing it again does not reopen it; focus in List size (now hidden)
    // moves to the View control too.
    presentation.fields.listSize.summary.focus();
    presentation.view.select.value = 'grid';
    presentation.view.select.dispatch('change');
    expect(gridSize.wrapper.hidden).toBe(false);
    expect(gridSize.details.open).toBe(false);
    expect(gridSize.select.value).toBe('large');
    expect(initial.document.activeElement).toBe(presentation.view.summary);
  });
});
