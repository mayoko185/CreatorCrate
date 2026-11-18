import { describe, expect, it, vi } from 'vitest';
import {
  beginAssetViewerDefaultsLiveRefresh,
  enhanceAssetLibraryLiveFiltering,
  enhanceAssetLibraryViewer,
  enhancePageDefaultsFetchSave,
  refreshAssetViewerLiveRegion,
} from '../src/static/creatorcrate.js';
import {
  assetLibraryLiveSnapshot,
  navigateAssetLibraryLive,
  subscribeAssetLibraryLive,
} from '../src/static/client/live-regions.js';
import {
  acknowledgeAssetViewerLegacyDefaults,
  prepareAssetViewerLegacyDefaultsBody,
} from '../src/static/client/asset-library-filters-defaults.js';

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
        const selectorWithoutState = candidate
          .replace(':checked', '')
          .replace(':not(:disabled)', '')
          .replace(':disabled', '');
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
      children.forEach((child) => {
        child.parentNode = null;
        child.parentElement = null;
      });
      children.length = 0;
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
    focus() {
      this.focused = true;
      if (this.ownerDocument) this.ownerDocument.activeElement = this;
    },
  };

  Object.entries(attrs).forEach(([name, rawValue]) => node.setAttribute(name, rawValue));
  if (checked) node.checked = true;
  return node;
}

function addProjectOption(optionList, { id, label, value, checked }) {
  const option = makeNode({ attrs: { class: 'asset-filter-multiselect-option asset-project-filter-option' } });
  const labelNode = makeNode({ tagName: 'label' });
  const input = makeNode({
    tagName: 'input',
    attrs: { id, name: 'project', type: 'radio', value },
    value,
    checked,
  });
  input.focus = () => {
    input.focused = true;
    input.ownerDocument.activeElement = input;
  };
  labelNode.textContent = label;
  labelNode.appendChild(input);
  option.appendChild(labelNode);
  optionList.appendChild(option);
  return input;
}

function makePage(projectId = null, { dialogOpen = false } = {}) {
  const document = makeNode({ tagName: 'document' });
  document.nodeType = 9;
  document.ownerDocument = document;
  document.activeElement = null;

  const region = makeNode({ attrs: { 'data-asset-library-live-region': '' } });
  const status = makeNode({ attrs: { 'data-asset-library-live-status': '' } });
  const form = makeNode({
    tagName: 'form',
    attrs: { id: 'asset-filters', action: '/asset-viewer', method: 'get' },
  });
  form.submit = vi.fn();

  const dropdown = makeNode({
    tagName: 'details',
    attrs: {
      id: 'asset-project-filter',
      class: 'asset-filter-multiselect asset-filter-multiselect--sized cc-dropdown asset-project-filter-disclosure',
      'data-cc-dropdown': '',
      'data-cc-dropdown-mode': 'single',
      'data-cc-dropdown-searchable': '',
      'data-cc-dropdown-type': 'searchable-single',
    },
  });
  const summary = makeNode({
    tagName: 'summary',
    attrs: {
      id: 'asset-project-filter-trigger',
      'aria-controls': 'asset-project-filter-options',
      'aria-label': 'Project filter: All projects',
    },
  });
  const currentSummary = makeNode({ attrs: { 'data-cc-dropdown-summary-current': '' } });
  currentSummary.textContent = 'All projects';
  summary.appendChild(currentSummary);
  const panel = makeNode({
    attrs: {
      id: 'asset-project-filter-options',
      class: 'asset-filter-multiselect-panel asset-project-filter-panel',
    },
  });
  const search = makeNode({
    tagName: 'input',
    attrs: {
      id: 'asset-project-filter-search',
      class: 'asset-project-filter-search',
      type: 'search',
      'data-cc-dropdown-search': '',
    },
  });
  const optionList = makeNode({
    attrs: {
      id: 'asset-project-filter-option-list',
      class: 'asset-project-filter-option-list',
      'data-cc-dropdown-option-list': '',
    },
  });
  const all = addProjectOption(optionList, {
    id: 'asset-project-option-all',
    label: 'All projects',
    value: '',
    checked: projectId === null,
  });
  const alpha = addProjectOption(optionList, {
    id: '1',
    label: 'Alpha Project',
    value: '1',
    checked: projectId === '1',
  });
  const beta = addProjectOption(optionList, {
    id: '2',
    label: 'Beta Project',
    value: '2',
    checked: projectId === '2',
  });
  const noResults = makeNode({ attrs: { 'data-cc-dropdown-no-results': '', hidden: '' } });
  panel.appendChild(search);
  panel.appendChild(optionList);
  panel.appendChild(noResults);
  dropdown.appendChild(summary);
  dropdown.appendChild(panel);
  form.appendChild(dropdown);
  const dialog = makeNode({
    tagName: 'dialog',
    attrs: { id: 'asset-viewer-filter-dialog', 'data-app-dialog': '' },
  });
  dialog.open = dialogOpen;
  dialog.appendChild(form);
  region.appendChild(status);
  const preview = makeNode({
    tagName: 'a',
    attrs: { href: '/assets/7', 'data-asset-library-preview-id': '7', 'data-asset-library-preview-project-id': '1' },
  });
  region.appendChild(preview);
  document.appendChild(region);
  document.appendChild(dialog);

  return {
    document,
    region,
    dialog,
    form,
    summary,
    all,
    alpha,
    beta,
    search,
    currentSummary,
    preview,
  };
}

function addCurrentFilterControls(page, values = {}) {
  const defaults = {
    category: ['category-illustration', 'category-reference'],
    tag: ['tag-character', 'tag-environment'],
    extension: ['extension-png', 'extension-webp'],
    presence: 'present',
    usage: 'unused',
    sort: 'project',
    order: 'desc',
    page: '3',
    pageSize: '50',
    view: 'list',
  };
  return Object.fromEntries(Object.entries({ ...defaults, ...values }).map(([name, value]) => {
    const controlValue = Array.isArray(value) ? value.at(-1) : value;
    const control = makeNode({ tagName: 'input', attrs: { name, value: controlValue }, value: controlValue });
    if (Array.isArray(value)) control.values = value;
    control.form = page.form;
    page.form.appendChild(control);
    return [name, control];
  }));
}

function addReplacementEnhancerFixtures(page) {
  const preview = makeNode({
    attrs: {
      'data-asset-viewer-preview': '',
      'data-preview-enhancement': '',
      'data-preview-state': 'loading',
    },
  });
  const previewImage = makeNode({ tagName: 'img', attrs: { 'data-preview-image': '' } });
  const previewFallback = makeNode({ attrs: { 'data-preview-fallback': '', hidden: '' } });
  const infoCard = makeNode({ attrs: { 'data-asset-info-card': '', popover: 'manual' } });
  preview.appendChild(previewImage);
  preview.appendChild(previewFallback);
  preview.appendChild(infoCard);

  const gridControls = makeNode({ attrs: { 'data-asset-grid-size-controls': '' } });
  const gridSlider = makeNode({
    tagName: 'input',
    attrs: { type: 'range', value: '2', 'data-grid-size-slider': '' },
    value: '2',
  });
  const grid = makeNode({ attrs: { class: 'asset-grid' } });
  gridControls.appendChild(gridSlider);

  const dropdown = makeNode({
    tagName: 'details',
    attrs: { 'data-cc-dropdown': '', 'data-cc-dropdown-mode': 'single' },
  });
  const dropdownSummary = makeNode({ tagName: 'summary', attrs: { 'aria-expanded': 'false' } });
  dropdown.appendChild(dropdownSummary);

  page.region.appendChild(preview);
  page.region.appendChild(gridControls);
  page.region.appendChild(grid);
  page.region.appendChild(dropdown);
  return {
    preview,
    previewImage,
    infoCard,
    grid,
    gridSlider,
    dropdown,
    dropdownSummary,
  };
}

function addDialogReset(page, href) {
  const form = makeNode({
    tagName: 'form',
    attrs: { class: 'asset-viewer-filter-reset', method: 'get', action: href },
  });
  const reset = makeNode({ tagName: 'button', attrs: { type: 'submit', 'data-asset-library-reset': '' } });
  reset.form = form;
  form.appendChild(reset);
  page.dialog.appendChild(form);
  return reset;
}

function addFilteredEmptyReset(page, href) {
  const reset = makeNode({ tagName: 'a', attrs: { href, 'data-asset-library-reset': '' } });
  page.region.appendChild(reset);
  return reset;
}

function addViewLink(page, href) {
  const nav = makeNode({ tagName: 'nav', attrs: { class: 'view-switcher' } });
  const link = makeNode({ tagName: 'a', attrs: { href } });
  nav.appendChild(link);
  page.region.appendChild(nav);
  return link;
}

function addPaginationLink(page, href) {
  const nav = makeNode({ tagName: 'nav', attrs: { class: 'pagination' } });
  const link = makeNode({ tagName: 'a', attrs: { href } });
  nav.appendChild(link);
  page.region.appendChild(nav);
  return link;
}

function addPageSizeSelect(page, value = '25') {
  const select = makeNode({
    tagName: 'select',
    attrs: { name: 'pageSize', value },
    value,
  });
  select.form = page.form;
  page.form.appendChild(select);
  return select;
}

function addAssetViewerDefaults(page) {
  const dialog = makeNode({
    tagName: 'dialog',
    attrs: { id: 'asset-viewer-defaults-dialog', 'data-app-dialog': '' },
  });
  const form = makeNode({
    tagName: 'form',
    attrs: {
      id: 'asset-viewer-defaults-form',
      action: '/asset-viewer/defaults',
      method: 'post',
      'data-dialog-async': 'false',
      'data-asset-viewer-defaults-autosave': '',
    },
  });
  const csrf = makeNode({ tagName: 'input', attrs: { name: '_csrf', value: 'csrf-token' } });
  const returnTo = makeNode({ tagName: 'input', attrs: { name: 'returnTo', value: '/asset-viewer' } });
  const view = makeNode({
    tagName: 'select',
    attrs: { name: 'view', value: 'grid', 'data-autosubmit': 'fetch' },
  });
  const sort = makeNode({
    tagName: 'select',
    attrs: { name: 'sort', value: 'filename', 'data-autosubmit': 'fetch' },
  });
  const extension = makeNode({
    tagName: 'select',
    attrs: { name: 'extension', multiple: '', 'data-autosubmit': 'fetch' },
  });
  extension.values = ['png', 'jpg'];
  const tag = makeNode({
    tagName: 'select',
    attrs: { name: 'tag', multiple: '', 'data-autosubmit': 'fetch' },
  });
  tag.values = ['1', '2'];
  const status = makeNode({ attrs: { 'data-settings-fetch-save-status': '' } });
  for (const control of [csrf, returnTo, view, sort, extension, tag]) {
    control.form = form;
    form.appendChild(control);
  }
  form.appendChild(status);
  dialog.appendChild(form);
  page.document.appendChild(dialog);
  return { dialog, form, view, sort, extension, tag, status };
}

function makeWindow(document, pages) {
  const location = {
    href: 'http://creatorcrate.test/asset-viewer',
    pathname: '/asset-viewer',
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
          .flatMap((field) => (Array.isArray(field.values) ? field.values : [field.value])
            .map((value) => [field.name, value]));
      }

      *entries() { yield* this.fields; }
      [Symbol.iterator]() { return this.entries(); }
    },
    DOMParser: class DOMParserMock {
      parseFromString(text) { return pages.get(text); }
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
    listeners: {},
    addEventListener(type, listener) { this.listeners[type] = listener; },
  };
  document.defaultView = windowObject;
  return windowObject;
}

const liveFailureNotice = (document) => document.querySelector('[data-live-filter-failure]');
const liveFailureRetries = (document) => document.querySelectorAll('[data-live-filter-retry]');

async function flush() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

describe('Asset Viewer Project live filtering enhancement', () => {
  it('preserves View All through live form replacement, view switching, and Back/Forward', async () => {
    const initial = makePage();
    const filtered = makePage();
    const listed = makePage();
    const paged = makePage();
    const restored = makePage();
    const pageSize = addPageSizeSelect(initial);
    const stalePage = makeNode({ tagName: 'input', attrs: { name: 'page', value: '3' }, value: '3' });
    stalePage.form = initial.form;
    initial.form.appendChild(stalePage);
    addPageSizeSelect(filtered, 'all');
    addPageSizeSelect(listed, 'all');
    addPageSizeSelect(paged, 'all');
    addPageSizeSelect(restored, 'all');
    const viewLink = addViewLink(filtered, '/asset-viewer?pageSize=all&view=list');
    const paginationLink = addPaginationLink(listed, '/asset-viewer?page=2&pageSize=all&view=list');
    const pages = new Map([
      ['filtered-all', filtered.document],
      ['listed-all', listed.document],
      ['paged-all', paged.document],
      ['restored-all', restored.document],
    ]);
    const windowObject = makeWindow(initial.document, pages);
    windowObject.fetch
      .mockResolvedValueOnce({
        ok: true,
        url: 'http://creatorcrate.test/asset-viewer?pageSize=all',
        text: async () => 'filtered-all',
      })
      .mockResolvedValueOnce({
        ok: true,
        url: 'http://creatorcrate.test/asset-viewer?pageSize=all&view=list',
        text: async () => 'listed-all',
      })
      .mockResolvedValueOnce({
        ok: true,
        url: 'http://creatorcrate.test/asset-viewer?page=2&pageSize=all&view=list',
        text: async () => 'paged-all',
      })
      .mockResolvedValueOnce({
        ok: true,
        url: 'http://creatorcrate.test/asset-viewer?pageSize=all&view=grid',
        text: async () => 'restored-all',
      });

    enhanceAssetLibraryLiveFiltering(initial.document);
    pageSize.value = 'all';
    pageSize.dispatch('change');
    await flush();

    expect(new URL(windowObject.fetch.mock.calls[0][0]).searchParams.get('pageSize')).toBe('all');
    expect(new URL(windowObject.fetch.mock.calls[0][0]).searchParams.has('page')).toBe(false);
    expect(windowObject.history.pushes[0].url)
      .toBe('http://creatorcrate.test/asset-viewer?pageSize=all');

    viewLink.dispatch('click', { button: 0 });
    await flush();
    expect(windowObject.fetch.mock.calls[1][0])
      .toBe('http://creatorcrate.test/asset-viewer?pageSize=all&view=list');

    paginationLink.dispatch('click', { button: 0 });
    await flush();
    expect(windowObject.fetch.mock.calls[2][0])
      .toBe('http://creatorcrate.test/asset-viewer?page=2&pageSize=all&view=list');

    windowObject.location.href = 'http://creatorcrate.test/asset-viewer?pageSize=all';
    windowObject.listeners.popstate();
    await flush();
    expect(windowObject.fetch.mock.calls[3][0])
      .toBe('http://creatorcrate.test/asset-viewer?pageSize=all');
    expect(windowObject.history.pushes).toHaveLength(3);
    expect(windowObject.history.replaces).toEqual([
      expect.objectContaining({ url: 'http://creatorcrate.test/asset-viewer?pageSize=all&view=grid' }),
    ]);
    expect(windowObject.location.href)
      .toBe('http://creatorcrate.test/asset-viewer?pageSize=all&view=grid');
    expect(initial.form.querySelector('select[name="pageSize"]').value).toBe('all');
  });

  it('serializes every current filter, resets page, replaces the mounted region, and restores focus', async () => {
    const initial = makePage(null, { dialogOpen: true });
    const next = makePage('1');
    addCurrentFilterControls(initial);
    addCurrentFilterControls(next, { page: '', usage: 'used' });
    const reset = addDialogReset(initial, '/asset-viewer?resetFilters=1&view=grid');
    addDialogReset(next, '/asset-viewer?resetFilters=1&view=grid');
    const pages = new Map([['filtered', next.document]]);
    const windowObject = makeWindow(initial.document, pages);
    const responseUrl = 'http://creatorcrate.test/asset-viewer?project=1&view=grid';
    windowObject.fetch.mockResolvedValue({
      ok: true,
      url: responseUrl,
      text: vi.fn(async () => 'filtered'),
    });

    expect(enhanceAssetLibraryLiveFiltering(initial.document)).toBe(1);
    expect(enhanceAssetLibraryLiveFiltering(initial.document)).toBe(1);

    initial.all.checked = false;
    initial.alpha.checked = true;
    initial.document.activeElement = initial.summary;
    initial.alpha.dispatch('change');
    await flush();

    expect(windowObject.fetch).toHaveBeenCalledTimes(1);
    const requested = new URL(windowObject.fetch.mock.calls[0][0]);
    expect(requested.pathname).toBe('/asset-viewer');
    expect(requested.searchParams.get('project')).toBe('1');
    expect(requested.searchParams.getAll('category')).toEqual(['category-illustration', 'category-reference']);
    expect(requested.searchParams.getAll('tag')).toEqual(['tag-character', 'tag-environment']);
    expect(requested.searchParams.getAll('extension')).toEqual(['extension-png', 'extension-webp']);
    expect(Object.fromEntries(requested.searchParams)).toEqual({
      project: '1',
      category: 'category-reference',
      tag: 'tag-environment',
      extension: 'extension-webp',
      presence: 'present',
      usage: 'unused',
      sort: 'project',
      order: 'desc',
      pageSize: '50',
      view: 'list',
    });
    expect(requested.searchParams.has('page')).toBe(false);
    expect(windowObject.history.pushes).toHaveLength(1);
    expect(windowObject.history.pushes[0].url).toBe(responseUrl);
    expect(initial.document.querySelector('[data-asset-library-live-region]')).toBe(next.region);
    expect(initial.document.querySelector('#asset-filters')).toBe(initial.form);
    expect(initial.document.querySelector('#asset-viewer-filter-dialog')).toBe(initial.dialog);
    expect(initial.dialog.open).toBe(true);
    expect(next.currentSummary.textContent).toBe('Alpha Project');
    expect(next.summary.focused).toBe(true);
    expect(reset.form.getAttribute('action')).toBe('/asset-viewer?resetFilters=1&view=grid');

    enhanceAssetLibraryLiveFiltering(next.region);
    enhanceAssetLibraryLiveFiltering(next.region);
    next.alpha.checked = false;
    next.all.checked = true;
    next.all.dispatch('change');
    await flush();
    expect(windowObject.fetch).toHaveBeenCalledTimes(2);
    const allProjectsRequested = new URL(windowObject.fetch.mock.calls[1][0]);
    expect(allProjectsRequested.searchParams.has('project')).toBe(false);
    expect(allProjectsRequested.searchParams.getAll('category'))
      .toEqual(['category-illustration', 'category-reference']);
    expect(allProjectsRequested.searchParams.getAll('tag'))
      .toEqual(['tag-character', 'tag-environment']);
    expect(allProjectsRequested.searchParams.getAll('extension'))
      .toEqual(['extension-png', 'extension-webp']);
    expect(allProjectsRequested.searchParams.get('presence')).toBe('present');
    expect(allProjectsRequested.searchParams.get('usage')).toBe('used');
    expect(allProjectsRequested.searchParams.get('sort')).toBe('project');
    expect(allProjectsRequested.searchParams.get('order')).toBe('desc');
    expect(allProjectsRequested.searchParams.get('pageSize')).toBe('50');
    expect(allProjectsRequested.searchParams.get('view')).toBe('list');
    expect(allProjectsRequested.searchParams.has('page')).toBe(false);
  });

  it('keeps Reset server-authoritative through View navigation, canonical history, and Back/Forward', async () => {
    const initial = makePage('1', { dialogOpen: true });
    const listed = makePage('1');
    const resetResult = makePage();
    const filteredEmptyResult = makePage();
    const revisited = makePage();
    const pages = new Map([
      ['listed', listed.document],
      ['reset', resetResult.document],
      ['filtered-empty-reset', filteredEmptyResult.document],
      ['revisited', revisited.document],
    ]);
    const windowObject = makeWindow(initial.document, pages);
    const reset = addDialogReset(initial, '/asset-viewer?resetFilters=1&view=grid');
    addDialogReset(listed, '/asset-viewer?resetFilters=1&view=list');
    addDialogReset(resetResult, '/asset-viewer?resetFilters=1&view=list');
    const filteredEmptyReset = addFilteredEmptyReset(resetResult, '/asset-viewer?resetFilters=1&view=list');
    const viewLink = addViewLink(initial, '/asset-viewer?view=list');
    windowObject.fetch
      .mockResolvedValueOnce({
        ok: true,
        url: 'http://creatorcrate.test/asset-viewer?view=list',
        text: async () => 'listed',
      })
      .mockResolvedValueOnce({
        ok: true,
        url: 'http://creatorcrate.test/asset-viewer?category=art&sort=project&order=desc&pageSize=50&view=list',
        text: async () => 'reset',
      })
      .mockResolvedValueOnce({
        ok: true,
        url: 'http://creatorcrate.test/asset-viewer?view=list',
        text: async () => 'filtered-empty-reset',
      })
      .mockResolvedValueOnce({
        ok: true,
        url: 'http://creatorcrate.test/asset-viewer?view=grid',
        text: async () => 'revisited',
      });

    enhanceAssetLibraryLiveFiltering(initial.document);
    viewLink.dispatch('click', { button: 0 });
    await flush();
    expect(reset.form.getAttribute('action')).toBe('/asset-viewer?resetFilters=1&view=list');

    const event = reset.dispatch('click', { button: 0 });
    await flush();

    expect(event.defaultPrevented).toBe(true);
    expect(windowObject.fetch).toHaveBeenCalledWith(
      'http://creatorcrate.test/asset-viewer?resetFilters=1&view=list',
      expect.objectContaining({ method: 'GET', headers: { Accept: 'text/html' } }),
    );
    expect(initial.document.querySelector('[data-asset-library-live-region]')).toBe(resetResult.region);
    expect(initial.document.querySelector('#asset-filters')).toBe(initial.form);
    expect(initial.document.querySelector('#asset-viewer-filter-dialog')).toBe(initial.dialog);
    expect(initial.dialog.open).toBe(true);
    expect(initial.form.querySelector('input[name="project"]:checked')?.value).toBe('');
    expect(windowObject.history.pushes).toEqual([
      expect.objectContaining({ url: 'http://creatorcrate.test/asset-viewer?view=list' }),
      expect.objectContaining({ url: 'http://creatorcrate.test/asset-viewer?category=art&sort=project&order=desc&pageSize=50&view=list' }),
    ]);
    expect(initial.form.submit).not.toHaveBeenCalled();

    const filteredEmptyEvent = filteredEmptyReset.dispatch('click', { button: 0 });
    await flush();
    expect(filteredEmptyEvent.defaultPrevented).toBe(true);
    expect(windowObject.fetch).toHaveBeenLastCalledWith(
      'http://creatorcrate.test/asset-viewer?resetFilters=1&view=list',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(initial.document.querySelector('[data-asset-library-live-region]')).toBe(filteredEmptyResult.region);

    windowObject.location.href = 'http://creatorcrate.test/asset-viewer?view=grid';
    windowObject.listeners.popstate();
    await flush();
    expect(windowObject.fetch).toHaveBeenLastCalledWith(
      'http://creatorcrate.test/asset-viewer?view=grid',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(initial.document.querySelector('[data-asset-library-live-region]')).toBe(revisited.region);
    expect(windowObject.history.pushes).toHaveLength(3);
  });

  it('keeps the latest valid response when an aborted request resolves late', async () => {
    const initial = makePage();
    const older = makePage('1');
    const latest = makePage('2');
    const pages = new Map([
      ['older', older.document],
      ['latest', latest.document],
    ]);
    const windowObject = makeWindow(initial.document, pages);
    let resolveOlder;
    let resolveLatest;
    const olderRequest = new Promise((resolve) => { resolveOlder = resolve; });
    const latestRequest = new Promise((resolve) => { resolveLatest = resolve; });
    windowObject.fetch
      .mockReturnValueOnce(olderRequest)
      .mockReturnValueOnce(latestRequest);

    enhanceAssetLibraryLiveFiltering(initial.document);
    initial.all.checked = false;
    initial.alpha.checked = true;
    initial.alpha.dispatch('change');
    initial.alpha.checked = false;
    initial.beta.checked = true;
    initial.beta.dispatch('change');

    expect(windowObject.fetch).toHaveBeenCalledTimes(2);
    expect(windowObject.fetch.mock.calls[0][1].signal.aborted).toBe(true);

    resolveLatest({
      ok: true,
      url: 'http://creatorcrate.test/asset-viewer?project=2',
      text: async () => 'latest',
    });
    await flush();
    expect(initial.document.querySelector('[data-asset-library-live-region]')).toBe(latest.region);

    resolveOlder({
      ok: true,
      url: 'http://creatorcrate.test/asset-viewer?project=1',
      text: async () => 'older',
    });
    await flush();
    expect(initial.document.querySelector('[data-asset-library-live-region]')).toBe(latest.region);
  });

  it('keeps the mounted region during a failed request, clears busy state, and later recovers', async () => {
    const initial = makePage();
    const recovered = makePage();
    const pages = new Map([['recovered', recovered.document]]);
    const windowObject = makeWindow(initial.document, pages);
    windowObject.fetch
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({
        ok: true,
        url: 'http://creatorcrate.test/asset-viewer',
        text: async () => 'recovered',
      });

    enhanceAssetLibraryLiveFiltering(initial.document);
    const beforeFailure = {
      pushes: windowObject.history.pushes.length,
      replaces: windowObject.history.replaces.length,
      href: windowObject.location.href,
    };
    initial.all.checked = false;
    initial.alpha.checked = true;
    initial.alpha.dispatch('change');

    expect(initial.region.getAttribute('aria-busy')).toBe('true');
    expect(initial.region.querySelector('[data-asset-library-live-status]').textContent)
      .toBe('Loading Asset Viewer.');
    await flush();
    expect(initial.document.querySelector('[data-asset-library-live-region]')).toBe(initial.region);
    expect(initial.region.hasAttribute('aria-busy')).toBe(false);
    expect(initial.region.getAttribute('data-asset-library-live-state')).toBe('error');
    expect(initial.region.querySelector('[data-asset-library-live-status]').textContent)
      .toContain('The requested filters were not applied');
    expect(initial.form.submit).not.toHaveBeenCalled();
    expect(initial.alpha.checked).toBe(true);
    expect(liveFailureRetries(initial.document)).toHaveLength(1);
    expect(windowObject.history.pushes).toHaveLength(beforeFailure.pushes);
    expect(windowObject.history.replaces).toHaveLength(beforeFailure.replaces);
    expect(windowObject.location.href).toBe(beforeFailure.href);

    initial.alpha.checked = false;
    initial.all.checked = true;
    initial.all.dispatch('change');
    await flush();
    expect(initial.document.querySelector('[data-asset-library-live-region]')).toBe(recovered.region);
    expect(recovered.region.hasAttribute('aria-busy')).toBe(false);
    expect(recovered.region.getAttribute('data-asset-library-live-state')).toBe(null);
  });

  it('retries a failed filter with GET only and installs the requested results', async () => {
    const initial = makePage();
    const recovered = makePage();
    const windowObject = makeWindow(initial.document, new Map([['recovered', recovered.document]]));
    windowObject.fetch.mockRejectedValueOnce(new Error('offline'));
    enhanceAssetLibraryLiveFiltering(initial.document);
    initial.all.checked = false;
    initial.alpha.checked = true;
    initial.alpha.dispatch('change');
    await flush();

    const requested = windowObject.fetch.mock.calls[0][0];
    windowObject.fetch.mockResolvedValueOnce({ ok: true, url: requested, text: async () => 'recovered' });
    liveFailureRetries(initial.document)[0].dispatch('click');
    await flush();

    expect(windowObject.fetch.mock.calls[1][0]).toBe(requested);
    expect(windowObject.fetch.mock.calls[1][1].method).toBe('GET');
    expect(initial.document.querySelector('[data-asset-library-live-region]')).toBe(recovered.region);
    expect(liveFailureNotice(initial.document)).toBeNull();
    expect(windowObject.history.pushes).toHaveLength(1);
    expect(initial.form.submit).not.toHaveBeenCalled();
  });

  // B5b: preview links and Slideshow open the shared unified viewer through
  // one document-level binding; a replaced region copies the authoritative
  // sequence (outside the region) and reconciles the open viewer with it.
  it('re-enhances replaced Asset Viewer controls and preview links', async () => {
    const initial = makePage();
    const next = makePage('1');
    const fixtures = addReplacementEnhancerFixtures(next);
    const sequenceEntry = (id, projectId, revision = `r${id}`) => ({
      id,
      projectId,
      filename: 'shared.png',
      previewUrl: `/projects/${projectId}/assets/${id}/preview?v=${revision}`,
      viewerUrl: `/projects/${projectId}/assets/${id}`,
      revision,
    });
    const addSequence = (page, entries) => {
      const script = makeNode({
        tagName: 'script',
        attrs: { type: 'application/json', 'data-asset-library-viewer-sequence': '', 'data-viewer-label': 'Asset Viewer' },
      });
      script.textContent = JSON.stringify(entries);
      page.document.appendChild(script);
      return script;
    };
    const currentSequence = addSequence(initial, [sequenceEntry(6, 2), sequenceEntry(7, 1)]);
    addSequence(next, [sequenceEntry(7, 1, 'r7b')]);
    let active = null;
    const viewer = {
      open: vi.fn(() => { active = 1; return 1; }),
      update: vi.fn(() => ({ outcome: 'kept' })),
      getState: () => ({ open: active !== null, session: active }),
    };
    const viewerDialog = makeNode({ tagName: 'dialog', attrs: { id: 'unified-viewer-dialog' } });
    viewerDialog.__creatorCrateUnifiedViewer = viewer;
    initial.document.appendChild(viewerDialog);
    initial.document.getElementById = (id) => initial.document.querySelector(`#${id}`);
    expect(enhanceAssetLibraryViewer(initial.document)).toBe(1);
    initial.preview.dispatch('click', { button: 0 });
    expect(viewer.open).toHaveBeenCalledTimes(1);
    expect(viewer.open.mock.calls[0][0].items.map((item) => item.key)).toEqual(['p:1|a:7']);

    const pages = new Map([['filtered', next.document]]);
    const windowObject = makeWindow(initial.document, pages);
    windowObject.fetch.mockResolvedValue({
      ok: true,
      url: 'http://creatorcrate.test/asset-viewer?project=1',
      text: vi.fn(async () => 'filtered'),
    });

    expect(enhanceAssetLibraryLiveFiltering(initial.document)).toBe(1);
    initial.all.checked = false;
    initial.alpha.checked = true;
    initial.alpha.dispatch('change');
    await flush();

    expect(next.region.contains(fixtures.preview)).toBe(true);
    expect(next.region.contains(fixtures.grid)).toBe(true);
    expect(next.region.contains(fixtures.dropdown)).toBe(true);
    fixtures.previewImage.dispatch('load');
    expect(fixtures.preview.getAttribute('data-preview-state')).toBe('loaded');
    fixtures.gridSlider.value = '3';
    fixtures.gridSlider.dispatch('input');
    expect(fixtures.grid.getAttribute('data-grid-size')).toBe('large');
    fixtures.dropdown.open = true;
    fixtures.dropdown.dispatch('toggle');
    expect(fixtures.dropdownSummary.getAttribute('aria-expanded')).toBe('true');
    fixtures.preview.dispatch('pointerenter', { clientX: 10, clientY: 10 });
    expect(fixtures.infoCard.getAttribute('data-info-card-open')).toBe('true');
    // The newer sequence replaced the page copy and reached the open session.
    expect(JSON.parse(currentSequence.textContent)).toEqual([sequenceEntry(7, 1, 'r7b')]);
    expect(viewer.update).toHaveBeenCalledTimes(1);
    expect(viewer.update.mock.calls[0][1]).toEqual({ session: 1 });
    expect(viewer.update.mock.calls[0][0].items).toEqual([expect.objectContaining({ projectId: 1, assetId: 7, revision: 'r7b' })]);
    // The replaced preview link opens through the same single binding.
    const event = next.preview.dispatch('click', { button: 0 });
    expect(viewer.open).toHaveBeenCalledTimes(2);
    expect(viewer.open.mock.calls[1][1].opener).toBe(next.preview);
    expect(event.defaultPrevented).toBe(true);
    const documentClickListeners = () => initial.document.listeners.filter(({ type }) => type === 'click').length;
    const clickListeners = documentClickListeners();
    expect(enhanceAssetLibraryViewer(initial.document)).toBe(1);
    expect(documentClickListeners()).toBe(clickListeners);
  });
});

describe('Asset Viewer defaults autosave integration', () => {
  function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  }

  function defaultsResponse({
    ok = true,
    redirected = true,
    url = 'http://creatorcrate.test/asset-viewer?tag=1&tag=2&extension=jpg&extension=png&view=grid&notice=asset_viewer_defaults_saved',
  } = {}) {
    return { ok, redirected, url, text: async () => '' };
  }

  function enhanceDefaults(page) {
    return enhancePageDefaultsFetchSave(page.document, {
      formSelector: '#asset-viewer-defaults-form',
      markerAttribute: 'data-asset-viewer-defaults-autosave',
      beginRefresh: beginAssetViewerDefaultsLiveRefresh,
      refresh: refreshAssetViewerLiveRegion,
      refreshFailureMessage: 'Settings saved, but Asset Viewer could not refresh. Refresh the page to see the saved defaults.',
    });
  }

  function installDefaultsGlobals(windowObject, fetch) {
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('FormData', windowObject.FormData);
    vi.stubGlobal('URLSearchParams', URLSearchParams);
  }

  it('serializes complete snapshots, keeps only the latest queued values, and refreshes after persistence', async () => {
    const initial = makePage();
    const defaults = addAssetViewerDefaults(initial);
    const refreshed = makePage();
    const pages = new Map([['refreshed', refreshed.document]]);
    const windowObject = makeWindow(initial.document, pages);
    windowObject.fetch.mockResolvedValue({
      ok: true,
      url: 'http://creatorcrate.test/asset-viewer?view=grid&sort=title&notice=asset_viewer_defaults_saved',
      text: async () => 'refreshed',
    });
    const first = deferred();
    const second = deferred();
    const saveFetch = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    installDefaultsGlobals(windowObject, saveFetch);

    try {
      enhanceAssetLibraryLiveFiltering(initial.document);
      expect(enhanceDefaults(initial)).toBe(4);
      expect(enhanceDefaults(initial)).toBe(0);

      defaults.view.value = 'list';
      defaults.view.dispatch('change');
      await flush();
      expect(saveFetch).toHaveBeenCalledTimes(1);
      expect(Object.fromEntries(saveFetch.mock.calls[0][1].body.entries())).toEqual({
        _csrf: 'csrf-token', returnTo: '/asset-viewer', view: 'list', sort: 'filename', extension: 'jpg', tag: '2',
      });
      expect(saveFetch.mock.calls[0][1].body.getAll('extension')).toEqual(['png', 'jpg']);
      expect(saveFetch.mock.calls[0][1].body.getAll('tag')).toEqual(['1', '2']);

      defaults.sort.value = 'updated';
      defaults.sort.dispatch('change');
      defaults.view.value = 'grid';
      defaults.view.dispatch('change');
      expect(saveFetch).toHaveBeenCalledTimes(1);

      first.resolve(defaultsResponse({ url: 'http://creatorcrate.test/asset-viewer?view=list&sort=filename' }));
      await flush();
      expect(saveFetch).toHaveBeenCalledTimes(2);
      expect(Object.fromEntries(saveFetch.mock.calls[1][1].body.entries())).toEqual({
        _csrf: 'csrf-token', returnTo: '/asset-viewer', view: 'grid', sort: 'updated', extension: 'jpg', tag: '2',
      });
      expect(saveFetch.mock.calls[1][1].body.getAll('extension')).toEqual(['png', 'jpg']);
      expect(saveFetch.mock.calls[1][1].body.getAll('tag')).toEqual(['1', '2']);

      second.resolve(defaultsResponse());
      await flush();
      expect(windowObject.fetch).toHaveBeenCalledTimes(1);
      expect(windowObject.fetch.mock.calls[0][0])
        .toBe('http://creatorcrate.test/asset-viewer?tag=1&tag=2&extension=jpg&extension=png&view=grid&notice=asset_viewer_defaults_saved');
      expect(initial.document.querySelector('[data-asset-library-live-region]')).toBe(refreshed.region);
      expect(defaults.status.textContent).toBe('Settings saved.');
      expect(defaults.view.value).toBe('grid');
      expect(defaults.sort.value).toBe('updated');
      expect(defaults.view.listeners.filter(({ type }) => type === 'change')).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps edited controls on persistence failure and distinguishes a later refresh failure', async () => {
    const initial = makePage();
    const defaults = addAssetViewerDefaults(initial);
    const pages = new Map();
    const windowObject = makeWindow(initial.document, pages);
    const saveFetch = vi.fn()
      .mockResolvedValueOnce(defaultsResponse({ ok: false, redirected: false }))
      .mockResolvedValueOnce(defaultsResponse());
    installDefaultsGlobals(windowObject, saveFetch);

    try {
      enhanceAssetLibraryLiveFiltering(initial.document);
      enhanceDefaults(initial);

      defaults.view.value = 'list';
      defaults.view.dispatch('change');
      await flush();
      expect(defaults.view.value).toBe('list');
      expect(defaults.status.textContent).toBe('Could not save settings. Your current changes were kept.');
      expect(defaults.form.getAttribute('data-settings-fetch-save-state')).toBe('error');
      expect(windowObject.fetch).not.toHaveBeenCalled();

      windowObject.fetch.mockRejectedValueOnce(new Error('refresh failed'));
      defaults.sort.value = 'updated';
      defaults.sort.dispatch('change');
      await flush();
      expect(defaults.view.value).toBe('list');
      expect(defaults.sort.value).toBe('updated');
      expect(defaults.status.textContent)
        .toBe('Settings saved, but Asset Viewer could not refresh. Refresh the page to see the saved defaults.');
      expect(defaults.form.getAttribute('data-settings-fetch-save-state')).toBe('saved-refresh-error');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // WP9a F6: the legacy autosave form takes part in the generation fence.
  // Wired exactly as src/static/creatorcrate.js wires it.
  it('sends the rendered generation, then one past each acknowledged save, at send time', async () => {
    const initial = makePage();
    const defaults = addAssetViewerDefaults(initial);
    const generationInput = makeNode({
      tagName: 'input', attrs: { type: 'hidden', name: 'defaultsGeneration', value: '4' },
    });
    generationInput.form = defaults.form;
    defaults.form.appendChild(generationInput);
    const windowObject = makeWindow(initial.document, new Map());
    windowObject.fetch.mockResolvedValue({ ok: true, url: 'http://creatorcrate.test/asset-viewer', text: async () => '' });
    const first = deferred();
    const saveFetch = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(defaultsResponse())
      // A stale/conflicting save is re-rendered with 409, never redirected.
      .mockResolvedValueOnce(defaultsResponse({ ok: false, redirected: false }))
      .mockResolvedValueOnce(defaultsResponse({ ok: false, redirected: false }));
    installDefaultsGlobals(windowObject, saveFetch);

    try {
      enhanceAssetLibraryLiveFiltering(initial.document);
      enhancePageDefaultsFetchSave(initial.document, {
        formSelector: '#asset-viewer-defaults-form',
        markerAttribute: 'data-asset-viewer-defaults-autosave',
        prepareRequestBody: prepareAssetViewerLegacyDefaultsBody,
        onAcknowledged: acknowledgeAssetViewerLegacyDefaults,
        beginRefresh: beginAssetViewerDefaultsLiveRefresh,
        refresh: refreshAssetViewerLiveRegion,
        refreshFailureMessage: 'Settings saved, but Asset Viewer could not refresh. Refresh the page to see the saved defaults.',
      });

      defaults.view.value = 'list';
      defaults.view.dispatch('change');
      await flush();
      expect(saveFetch.mock.calls[0][1].body.get('defaultsGeneration')).toBe('4');

      // Queued while the first is pending: its body is captured now, but the
      // generation is substituted when it is sent after the acknowledgement.
      defaults.sort.value = 'updated';
      defaults.sort.dispatch('change');
      first.resolve(defaultsResponse());
      await flush();
      expect(saveFetch).toHaveBeenCalledTimes(2);
      expect(saveFetch.mock.calls[1][1].body.get('defaultsGeneration')).toBe('5');
      expect(saveFetch.mock.calls[1][1].body.get('sort')).toBe('updated');
      await flush();
      expect(defaults.status.textContent).toMatch(/^Settings saved/);

      // A refused (conflicting) save does not advance the generation.
      defaults.view.value = 'grid';
      defaults.view.dispatch('change');
      await flush();
      expect(saveFetch.mock.calls[2][1].body.get('defaultsGeneration')).toBe('6');
      expect(defaults.status.textContent).toBe('Could not save settings. Your current changes were kept.');
      defaults.sort.value = 'filename';
      defaults.sort.dispatch('change');
      await flush();
      expect(saveFetch.mock.calls[3][1].body.get('defaultsGeneration')).toBe('6');
      // The form's own field is never rewritten (payload comparisons stay stable).
      expect(generationInput.value).toBe('4');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not let a stale defaults refresh override newer Asset Viewer filter intent', async () => {
    const initial = makePage();
    const defaults = addAssetViewerDefaults(initial);
    const filtered = makePage('1');
    const pages = new Map([['filtered', filtered.document]]);
    const windowObject = makeWindow(initial.document, pages);
    windowObject.fetch.mockResolvedValue({
      ok: true,
      url: 'http://creatorcrate.test/asset-viewer?project=1',
      text: async () => 'filtered',
    });
    const pending = deferred();
    const saveFetch = vi.fn(() => pending.promise);
    installDefaultsGlobals(windowObject, saveFetch);

    try {
      enhanceAssetLibraryLiveFiltering(initial.document);
      enhanceDefaults(initial);
      defaults.view.value = 'list';
      defaults.view.dispatch('change');
      await flush();

      initial.all.checked = false;
      initial.alpha.checked = true;
      initial.alpha.dispatch('change');
      await flush();
      expect(windowObject.fetch).toHaveBeenCalledTimes(1);
      expect(initial.document.querySelector('[data-asset-library-live-region]')).toBe(filtered.region);

      pending.resolve(defaultsResponse());
      await flush();
      expect(windowObject.fetch).toHaveBeenCalledTimes(1);
      expect(windowObject.location.href).toBe('http://creatorcrate.test/asset-viewer?project=1');
      expect(defaults.status.textContent).toBe('Settings saved.');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('WP9a Asset Library live lifecycle hooks', () => {
  function observe(document) {
    const events = [];
    const unsubscribe = subscribeAssetLibraryLive(document, (detail) => events.push(detail));
    return { events, unsubscribe };
  }

  it('supersedes a pending GET, reports started/superseded/installed and ignores the late older response', async () => {
    const initial = makePage();
    const older = makePage();
    const reset = makePage();
    const windowObject = makeWindow(initial.document, new Map([['older', older.document], ['reset', reset.document]]));
    let resolveOlder;
    windowObject.fetch
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOlder = resolve; }))
      .mockResolvedValueOnce({ ok: true, url: 'http://creatorcrate.test/asset-viewer?view=list', text: async () => 'reset' });
    enhanceAssetLibraryLiveFiltering(initial.document);
    const { events } = observe(initial.document);

    initial.all.checked = false;
    initial.alpha.checked = true;
    initial.alpha.dispatch('change');
    const pending = assetLibraryLiveSnapshot(initial.document);
    expect(pending).toMatchObject({ pending: true, failed: false, requestedHistoryMode: 'push' });
    expect(pending.intendedUrl).toBe('http://creatorcrate.test/asset-viewer?project=1');

    const started = navigateAssetLibraryLive(initial.document, '/asset-viewer?resetFilters=1', { historyMode: 'push' });
    expect(started).toEqual({ status: 'started', generation: pending.generation + 1 });
    expect(windowObject.fetch.mock.calls[1][0]).toBe('http://creatorcrate.test/asset-viewer?resetFilters=1');
    expect(windowObject.fetch.mock.calls[1][1].method).toBe('GET');
    await flush();
    resolveOlder({ ok: true, url: 'http://creatorcrate.test/asset-viewer?project=1', text: async () => 'older' });
    await flush();

    expect(initial.document.querySelector('[data-asset-library-live-region]')).toBe(reset.region);
    expect(events.map(({ phase, generation }) => [phase, generation])).toEqual([
      ['superseded', pending.generation - 1],
      ['started', pending.generation],
      ['superseded', pending.generation],
      ['started', started.generation],
      ['installed', started.generation],
    ]);
    expect(events[2].loading).toBe(true);
    expect(windowObject.location.href).toBe('http://creatorcrate.test/asset-viewer?view=list');
    expect(assetLibraryLiveSnapshot(initial.document)).toMatchObject({
      generation: started.generation, pending: false, failed: false,
      intendedUrl: 'http://creatorcrate.test/asset-viewer?view=list',
    });
  });

  it('reports a failed load, keeps the engine GET-only Retry, and reports the recovering install', async () => {
    const initial = makePage();
    const recovered = makePage();
    const windowObject = makeWindow(initial.document, new Map([['recovered', recovered.document]]));
    windowObject.fetch
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ok: true, url: 'http://creatorcrate.test/asset-viewer', text: async () => 'recovered' });
    enhanceAssetLibraryLiveFiltering(initial.document);
    const { events } = observe(initial.document);

    const reset = navigateAssetLibraryLive(initial.document, '/asset-viewer?resetFilters=1');
    await flush();
    expect(events.at(-1)).toMatchObject({ phase: 'failed', generation: reset.generation, aborted: false });
    expect(assetLibraryLiveSnapshot(initial.document)).toMatchObject({
      pending: false, failed: true,
      failedUrl: 'http://creatorcrate.test/asset-viewer?resetFilters=1',
      intendedUrl: 'http://creatorcrate.test/asset-viewer?resetFilters=1',
    });

    liveFailureRetries(initial.document)[0].dispatch('click');
    await flush();
    expect(windowObject.fetch.mock.calls[1]).toEqual([
      'http://creatorcrate.test/asset-viewer?resetFilters=1', expect.objectContaining({ method: 'GET' }),
    ]);
    expect(events.slice(-2).map(({ phase }) => phase)).toEqual(['started', 'installed']);
    expect(events.at(-2).url).toBe('http://creatorcrate.test/asset-viewer?resetFilters=1');
    expect(assetLibraryLiveSnapshot(initial.document)).toMatchObject({ pending: false, failed: false });
  });

  it('never reports a prepared response whose installation failed as installed', async () => {
    const initial = makePage();
    const prepared = makePage();
    const windowObject = makeWindow(initial.document, new Map([['prepared', prepared.document]]));
    windowObject.fetch.mockResolvedValueOnce({
      ok: true, url: 'http://creatorcrate.test/asset-viewer?view=list', text: async () => 'prepared',
    });
    enhanceAssetLibraryLiveFiltering(initial.document);
    const { events, unsubscribe } = observe(initial.document);
    initial.region.replaceWith = () => { throw new Error('install failed'); };

    const reset = navigateAssetLibraryLive(initial.document, '/asset-viewer?resetFilters=1');
    await flush();
    expect(events.map(({ phase }) => phase)).toEqual(['superseded', 'started', 'failed']);
    expect(events.at(-1).generation).toBe(reset.generation);
    expect(assetLibraryLiveSnapshot(initial.document).failed).toBe(true);
    expect(liveFailureRetries(initial.document)).toHaveLength(1);

    unsubscribe();
    navigateAssetLibraryLive(initial.document, '/asset-viewer?sort=size');
    expect(events).toHaveLength(3);
  });

  it('refuses destinations outside the Asset Viewer without touching the pending request', () => {
    const initial = makePage();
    const windowObject = makeWindow(initial.document, new Map());
    windowObject.fetch.mockImplementation(() => new Promise(() => {}));
    enhanceAssetLibraryLiveFiltering(initial.document);
    expect(navigateAssetLibraryLive(initial.document, '/projects/1/assets')).toEqual({ status: 'unavailable' });
    expect(windowObject.fetch).not.toHaveBeenCalled();
    expect(assetLibraryLiveSnapshot(initial.document).pending).toBe(false);
  });
});

/*
 * WP9b — the NSFW visibility refresh keeps the complete canonical filter
 * state (repeated Projects / Project Types and every other filter), and the
 * combined dialog's results Search / dropdown searches behave as drafts.
 */
function addNsfwForm(page, enabled = false) {
  const form = makeNode({
    tagName: 'form',
    attrs: { method: 'post', action: '/asset-viewer/nsfw-filter', 'data-asset-library-nsfw-filter': '' },
  });
  const value = makeNode({
    tagName: 'input',
    attrs: { name: 'enabled', type: 'hidden', value: enabled ? '0' : '1', 'data-asset-library-nsfw-value': '' },
    value: enabled ? '0' : '1',
  });
  const toggle = makeNode({
    tagName: 'button',
    attrs: { type: 'submit', 'data-asset-library-nsfw-toggle': '', 'aria-pressed': String(enabled) },
  });
  form.appendChild(value);
  form.appendChild(toggle);
  page.region.appendChild(form);
  return { form, toggle };
}

function addCheckedChoice(page, name, value, checked = true) {
  const input = makeNode({ tagName: 'input', attrs: { name, type: 'checkbox', value }, value, checked });
  input.form = page.form;
  page.form.appendChild(input);
  return input;
}

function addResultsSearch(page, value = '') {
  const input = makeNode({ tagName: 'input', attrs: { id: 'asset-library-search', name: 'search', type: 'search', value }, value });
  input.form = page.form;
  page.form.appendChild(input);
  return input;
}

const NSFW_OK = { ok: true, json: async () => ({ status: 'success', enabled: true }) };
const CANONICAL = 'http://creatorcrate.test/asset-viewer?project=3&project=7&type=comic&type=images&category=renders&category=sketches&tag=4&tag=9&search=cat&extension=png&extension=webp&usage=unused&sort=project&page=2&view=list';

describe('WP9b NSFW refresh keeps the complete canonical filter state', () => {
  it('refreshes the installed canonical URL with every repeated Project and Project Type', async () => {
    const initial = makePage();
    const refreshed = makePage();
    const { form } = addNsfwForm(initial);
    addNsfwForm(refreshed, true);
    const windowObject = makeWindow(initial.document, new Map([['refreshed', refreshed.document]]));
    windowObject.location.href = CANONICAL;
    windowObject.fetch
      .mockResolvedValueOnce(NSFW_OK)
      .mockResolvedValueOnce({ ok: true, url: CANONICAL, text: async () => 'refreshed' });

    enhanceAssetLibraryLiveFiltering(initial.document);
    const submit = form.dispatch('submit');
    await flush();

    expect(submit.defaultPrevented).toBe(true);
    expect(windowObject.fetch).toHaveBeenCalledTimes(2);
    expect(windowObject.fetch.mock.calls[0][1].method).toBe('POST');
    const refresh = new URL(windowObject.fetch.mock.calls[1][0]);
    expect(windowObject.fetch.mock.calls[1][1].method).toBe('GET');
    // The old form-based rebuild lost these: the fixture form selects no Project.
    expect(refresh.searchParams.getAll('project')).toEqual(['3', '7']);
    expect(refresh.searchParams.getAll('type')).toEqual(['comic', 'images']);
    expect(refresh.searchParams.getAll('category')).toEqual(['renders', 'sketches']);
    expect(refresh.searchParams.getAll('tag')).toEqual(['4', '9']);
    expect(refresh.searchParams.getAll('extension')).toEqual(['png', 'webp']);
    expect(refresh.searchParams.get('search')).toBe('cat');
    expect(refresh.searchParams.get('usage')).toBe('unused');
    expect(refresh.searchParams.get('page')).toBe('2');
    expect(refresh.href).toBe(CANONICAL);
    expect(refresh.search).not.toMatch(/%2C|,/);
    // The refresh adds no history entry and installs the refreshed region.
    expect(windowObject.history.pushes).toHaveLength(0);
    expect(initial.document.querySelector('[data-asset-library-live-region]')).toBe(refreshed.region);
  });

  it('a debounced edit not yet requested is carried with its repeated values, never comma-joined', async () => {
    const initial = makePage();
    const refreshed = makePage();
    const { form } = addNsfwForm(initial);
    addNsfwForm(refreshed, true);
    // A Projects selection leaves the unrestricted choice unchecked.
    initial.all.checked = false;
    for (const value of ['3', '7']) addCheckedChoice(initial, 'project', value);
    for (const value of ['comic', 'images']) addCheckedChoice(initial, 'type', value);
    const search = addResultsSearch(initial, 'cat');
    const windowObject = makeWindow(initial.document, new Map([['refreshed', refreshed.document]]));
    windowObject.location.href = 'http://creatorcrate.test/asset-viewer?project=3&project=7&type=comic&type=images&search=cat';
    windowObject.fetch
      .mockResolvedValueOnce(NSFW_OK)
      .mockResolvedValueOnce({ ok: true, url: 'http://creatorcrate.test/asset-viewer?project=3&project=7&type=comic&type=images&search=dog', text: async () => 'refreshed' });

    enhanceAssetLibraryLiveFiltering(initial.document);
    search.value = 'dog';
    search.dispatch('input');
    // The results Search is debounced: nothing is requested yet.
    expect(windowObject.fetch).not.toHaveBeenCalled();
    form.dispatch('submit');
    await flush();

    const refresh = new URL(windowObject.fetch.mock.calls[1][0]);
    expect(refresh.searchParams.getAll('project')).toEqual(['3', '7']);
    expect(refresh.searchParams.getAll('type')).toEqual(['comic', 'images']);
    expect(refresh.searchParams.get('search')).toBe('dog');
    await new Promise((resolve) => { setTimeout(resolve, 400); });
    // The debounced request was folded into the refresh, not sent again.
    expect(windowObject.fetch).toHaveBeenCalledTimes(2);
  });
});

/*
 * WP9b F1 — an NSFW refresh that adopts a pending or debounced destination
 * also owns that destination's navigation: the browser address follows the
 * installed results, without a duplicate history entry.
 */
describe('WP9b F1 NSFW refresh navigation ownership', () => {
  const PROJECT_ONE = 'http://creatorcrate.test/asset-viewer?project=1';

  it('commits a pending filter push it adopted, and the stale GET installs nothing', async () => {
    const initial = makePage();
    const refreshed = makePage();
    const stale = makePage();
    const { form } = addNsfwForm(initial);
    addNsfwForm(refreshed, true);
    initial.all.checked = false;
    addCheckedChoice(initial, 'project', '1');
    const windowObject = makeWindow(initial.document, new Map([['refreshed', refreshed.document], ['stale', stale.document]]));
    let releaseStale;
    windowObject.fetch
      .mockImplementationOnce((url, options) => new Promise((resolve, reject) => {
        releaseStale = () => resolve({ ok: true, url, text: async () => 'stale' });
        options.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }))
      .mockResolvedValueOnce(NSFW_OK)
      .mockResolvedValueOnce({ ok: true, url: PROJECT_ONE, text: async () => 'refreshed' });

    enhanceAssetLibraryLiveFiltering(initial.document);
    initial.form.dispatch('change', { target: initial.form.querySelectorAll('input').at(-1) });
    expect(windowObject.fetch).toHaveBeenCalledTimes(1);
    expect(windowObject.fetch.mock.calls[0][0]).toBe(PROJECT_ONE);
    form.dispatch('submit');
    await flush();
    releaseStale();
    await flush();

    expect(windowObject.fetch.mock.calls[2][0]).toBe(PROJECT_ONE);
    expect(initial.document.querySelector('[data-asset-library-live-region]')).toBe(refreshed.region);
    expect(windowObject.history.pushes.map((entry) => entry.url)).toEqual([PROJECT_ONE]);
    expect(windowObject.history.replaces).toHaveLength(0);
    expect(windowObject.location.href).toBe(PROJECT_ONE);
  });

  it('commits a debounced Search it adopted with the same Search value', async () => {
    const initial = makePage();
    const refreshed = makePage();
    const { form } = addNsfwForm(initial);
    addNsfwForm(refreshed, true);
    const search = addResultsSearch(initial);
    const searched = 'http://creatorcrate.test/asset-viewer?search=beta';
    const windowObject = makeWindow(initial.document, new Map([['refreshed', refreshed.document]]));
    windowObject.fetch
      .mockResolvedValueOnce(NSFW_OK)
      .mockResolvedValueOnce({ ok: true, url: searched, text: async () => 'refreshed' });

    enhanceAssetLibraryLiveFiltering(initial.document);
    search.value = 'beta';
    search.dispatch('input');
    form.dispatch('submit');
    await flush();

    expect(new URL(windowObject.fetch.mock.calls[1][0]).searchParams.get('search')).toBe('beta');
    expect(windowObject.history.pushes.map((entry) => entry.url)).toEqual([searched]);
    expect(windowObject.location.href).toBe(searched);
  });

  it('a debounced edit that returns to the shown address only reconciles it: no duplicate entry', async () => {
    const initial = makePage();
    const refreshed = makePage();
    const { form } = addNsfwForm(initial);
    addNsfwForm(refreshed, true);
    const search = addResultsSearch(initial, 'cat');
    const shown = 'http://creatorcrate.test/asset-viewer?search=cat';
    const windowObject = makeWindow(initial.document, new Map([['refreshed', refreshed.document]]));
    windowObject.location.href = shown;
    windowObject.fetch
      .mockResolvedValueOnce(NSFW_OK)
      .mockResolvedValueOnce({ ok: true, url: shown, text: async () => 'refreshed' });

    enhanceAssetLibraryLiveFiltering(initial.document);
    search.value = 'cats';
    search.dispatch('input');
    search.value = 'cat';
    search.dispatch('input');
    form.dispatch('submit');
    await flush();

    expect(windowObject.fetch.mock.calls[1][0]).toBe(shown);
    expect(windowObject.history.pushes).toHaveLength(0);
    expect(windowObject.history.replaces).toHaveLength(0);
    expect(initial.document.querySelector('[data-asset-library-live-region]')).toBe(refreshed.region);
  });

  // F4: the serialized request differs from the shown canonical address, but
  // the server's canonical answer is that address: no entry is added.
  it('F4: compares the FINAL canonical response URL with the shown address before pushing', async () => {
    const initial = makePage();
    const refreshed = makePage();
    const { form } = addNsfwForm(initial);
    addNsfwForm(refreshed, true);
    const search = addResultsSearch(initial, 'alpha');
    const shown = 'http://creatorcrate.test/asset-viewer?search=alpha&presence=all&sort=filename';
    const windowObject = makeWindow(initial.document, new Map([['refreshed', refreshed.document]]));
    windowObject.location.href = shown;
    windowObject.fetch
      .mockResolvedValueOnce(NSFW_OK)
      .mockResolvedValueOnce({ ok: true, url: `${shown}#ignored`, text: async () => 'refreshed' });

    enhanceAssetLibraryLiveFiltering(initial.document);
    search.value = 'alphax';
    search.dispatch('input');
    search.value = 'alpha';
    search.dispatch('input');
    form.dispatch('submit');
    await flush();

    // The request is the serialized form, not the shown address.
    expect(windowObject.fetch.mock.calls[1][0]).not.toBe(shown);
    expect(new URL(windowObject.fetch.mock.calls[1][0]).searchParams.get('search')).toBe('alpha');
    expect(windowObject.history.pushes).toHaveLength(0);
    expect(initial.document.querySelector('[data-asset-library-live-region]')).toBe(refreshed.region);
  });

  it('F4: a genuinely different canonical answer is still pushed once; repeated keys stay repeated', async () => {
    const initial = makePage();
    const refreshed = makePage();
    const { form } = addNsfwForm(initial);
    addNsfwForm(refreshed, true);
    const search = addResultsSearch(initial, 'alpha');
    const shown = 'http://creatorcrate.test/asset-viewer?project=1&project=2&search=alpha';
    const answered = 'http://creatorcrate.test/asset-viewer?project=1&project=2&search=beta';
    const windowObject = makeWindow(initial.document, new Map([['refreshed', refreshed.document]]));
    windowObject.location.href = shown;
    windowObject.fetch
      .mockResolvedValueOnce(NSFW_OK)
      .mockResolvedValueOnce({ ok: true, url: answered, text: async () => 'refreshed' });

    enhanceAssetLibraryLiveFiltering(initial.document);
    search.value = 'beta';
    search.dispatch('input');
    form.dispatch('submit');
    await flush();

    expect(windowObject.history.pushes.map((entry) => entry.url)).toEqual([answered]);
    expect(new URL(windowObject.location.href).searchParams.getAll('project')).toEqual(['1', '2']);
  });

  // WP10b F6: the same-address reconciliation is the engine's rule for every
  // push, not only an NSFW refresh; a different final address still pushes.
  it('F6: an ordinary (non-NSFW) push whose final address is the shown one adds no entry; another address still pushes', async () => {
    const initial = makePage();
    const next = makePage();
    const later = makePage();
    const shown = 'http://creatorcrate.test/asset-viewer';
    const windowObject = makeWindow(initial.document, new Map([['next', next.document], ['later', later.document]]));
    windowObject.fetch
      .mockResolvedValueOnce({ ok: true, url: shown, text: async () => 'next' })
      .mockResolvedValueOnce({ ok: true, url: PROJECT_ONE, text: async () => 'later' });

    enhanceAssetLibraryLiveFiltering(initial.document);
    navigateAssetLibraryLive(initial.document, '/asset-viewer?resetFilters=1', { historyMode: 'push' });
    await flush();

    expect(initial.document.querySelector('[data-asset-library-live-region]')).toBe(next.region);
    expect(windowObject.history.pushes).toEqual([]);
    expect(windowObject.history.replaces).toEqual([]);
    expect(windowObject.location.href).toBe(shown);

    navigateAssetLibraryLive(initial.document, '/asset-viewer?project=1', { historyMode: 'push' });
    await flush();
    expect(windowObject.history.pushes.map((entry) => entry.url)).toEqual([PROJECT_ONE]);
  });

  it('F3: the snapshot reports a debounced edit not yet requested as the intended destination', () => {
    const initial = makePage();
    const search = addResultsSearch(initial);
    makeWindow(initial.document, new Map());
    enhanceAssetLibraryLiveFiltering(initial.document);
    search.value = 'cat';
    search.dispatch('input');
    const snapshot = assetLibraryLiveSnapshot(initial.document);
    expect(snapshot.pending).toBe(true);
    expect(new URL(snapshot.intendedUrl).searchParams.get('search')).toBe('cat');
    expect(snapshot.requestedHistoryMode).toBe('push');
  });

  it('keeps an adopted in-flight replace (Back/Forward) as a replace, never a push', async () => {
    const initial = makePage();
    const refreshed = makePage();
    const { form } = addNsfwForm(initial);
    addNsfwForm(refreshed, true);
    const windowObject = makeWindow(initial.document, new Map([['refreshed', refreshed.document]]));
    windowObject.fetch
      .mockImplementationOnce((url, options) => new Promise((resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }))
      .mockResolvedValueOnce(NSFW_OK)
      .mockResolvedValueOnce({ ok: true, url: PROJECT_ONE, text: async () => 'refreshed' });

    enhanceAssetLibraryLiveFiltering(initial.document);
    // Back/Forward already moved the address; its GET is still in flight.
    windowObject.location.href = PROJECT_ONE;
    windowObject.listeners.popstate();
    form.dispatch('submit');
    await flush();

    expect(windowObject.fetch.mock.calls[2][0]).toBe(PROJECT_ONE);
    expect(windowObject.history.pushes).toHaveLength(0);
    expect(windowObject.location.href).toBe(PROJECT_ONE);
  });
});

describe('WP9b results Search and dropdown search drafts', () => {
  it('debounces typing in the results Search and ignores its change event', async () => {
    const initial = makePage();
    const next = makePage();
    const search = addResultsSearch(initial);
    addResultsSearch(next, 'cat');
    const windowObject = makeWindow(initial.document, new Map([['searched', next.document]]));
    windowObject.fetch.mockResolvedValue({ ok: true, url: 'http://creatorcrate.test/asset-viewer?search=cat', text: async () => 'searched' });

    enhanceAssetLibraryLiveFiltering(initial.document);
    search.value = 'cat';
    search.dispatch('input');
    search.dispatch('change');
    expect(windowObject.fetch).not.toHaveBeenCalled();
    await new Promise((resolve) => { setTimeout(resolve, 400); });
    await flush();
    expect(windowObject.fetch).toHaveBeenCalledTimes(1);
    expect(new URL(windowObject.fetch.mock.calls[0][0]).searchParams.get('search')).toBe('cat');
  });

  it('keeps typed dropdown search text and a whitespace-only Search difference across a reconciled form', async () => {
    const initial = makePage();
    const next = makePage();
    const search = addResultsSearch(initial);
    const nextSearch = addResultsSearch(next, 'cat');
    const windowObject = makeWindow(initial.document, new Map([['searched', next.document]]));
    windowObject.fetch.mockResolvedValue({ ok: true, url: 'http://creatorcrate.test/asset-viewer?search=cat', text: async () => 'searched' });

    enhanceAssetLibraryLiveFiltering(initial.document);
    initial.search.value = 'alp';
    search.value = 'cat ';
    initial.document.activeElement = search;
    initial.form.dispatch('submit', { target: initial.form });
    await flush();

    expect(windowObject.fetch).toHaveBeenCalledTimes(1);
    // The reconciled form carries the server's children; the drafts the
    // server only normalized (or never saw) survive.
    expect(initial.form.querySelector('#asset-project-filter-search')).toBe(next.search);
    expect(next.search.value).toBe('alp');
    expect(nextSearch.value).toBe('cat ');
  });
});

/*
 * WP10b follow-up F4 — a toolbar Grid/List link is rendered against the
 * installed page. The clicked View must be applied to the newest intended
 * filter destination (debounced edit, pending GET, failed GET, or a pending
 * NSFW refresh), never discard it; an idle page keeps the link's address.
 */
describe('WP10b F4 toolbar View keeps the latest intended filters', () => {
  const RESTRICTED = 'http://creatorcrate.test/asset-viewer?project=3&project=7&type=comic&type=images&view=grid';

  function addViewControl(page, view = 'grid') {
    const dropdown = makeNode({ tagName: 'details', attrs: { 'data-cc-dropdown': '', 'data-cc-dropdown-mode': 'single' } });
    const grid = makeNode({ tagName: 'input', attrs: { name: 'view', type: 'radio', value: 'grid' }, value: 'grid', checked: view === 'grid' });
    const list = makeNode({ tagName: 'input', attrs: { name: 'view', type: 'radio', value: 'list' }, value: 'list', checked: view === 'list' });
    for (const input of [grid, list]) {
      input.form = page.form;
      dropdown.appendChild(input);
    }
    page.form.appendChild(dropdown);
    return { grid, list };
  }

  function restrict(page, { projects = ['3', '7'], types = ['comic', 'images'] } = {}) {
    page.all.checked = false;
    projects.forEach((value) => addCheckedChoice(page, 'project', value));
    types.forEach((value) => addCheckedChoice(page, 'type', value));
  }

  function heldFetch(windowObject) {
    const requests = [];
    windowObject.fetch.mockImplementation((url, options) => new Promise((resolve, reject) => {
      requests.push({ url, options, resolve, reject });
      options?.signal?.addEventListener?.('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    return requests;
  }

  const html = (key, url) => ({ ok: true, url, text: async () => key });

  it('applies List to a still-pending filter GET with repeated Projects/Types; the stale GET loses', async () => {
    const initial = makePage();
    const stale = makePage();
    const listed = makePage();
    const view = addViewControl(initial, 'grid');
    restrict(initial, { types: ['comic'] });
    const images = addCheckedChoice(initial, 'type', 'images', false);
    // The toolbar link was rendered before the pending Type edit.
    const link = addViewLink(initial, '/asset-viewer?project=3&project=7&type=comic&view=list');
    const windowObject = makeWindow(initial.document, new Map([['stale', stale.document], ['listed', listed.document]]));
    windowObject.location.href = 'http://creatorcrate.test/asset-viewer?project=3&project=7&type=comic&view=grid';
    const requests = heldFetch(windowObject);

    enhanceAssetLibraryLiveFiltering(initial.document);
    images.checked = true;
    initial.form.dispatch('change', { target: images });
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0].url).searchParams.getAll('type')).toEqual(['comic', 'images']);

    const click = link.dispatch('click', { button: 0 });
    expect(click.defaultPrevented).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[0].options.signal.aborted).toBe(true);
    const viewUrl = new URL(requests[1].url);
    expect(requests[1].options.method).toBe('GET');
    expect(viewUrl.pathname).toBe('/asset-viewer');
    expect(viewUrl.searchParams.getAll('project')).toEqual(['3', '7']);
    expect(viewUrl.searchParams.getAll('type')).toEqual(['comic', 'images']);
    expect(viewUrl.searchParams.getAll('view')).toEqual(['list']);
    expect(viewUrl.search).not.toMatch(/%2C|,/);
    // The dialog View control follows the click.
    expect(view.list.checked).toBe(true);
    expect(view.grid.checked).toBe(false);

    requests[1].resolve(html('listed', requests[1].url));
    await flush();
    requests[0].resolve(html('stale', requests[0].url));
    await flush();
    expect(initial.document.querySelector('[data-asset-library-live-region]')).toBe(listed.region);
    expect(windowObject.history.pushes.map((entry) => entry.url)).toEqual([requests[1].url]);
    expect(windowObject.location.href).toBe(requests[1].url);
  });

  it('applies List to a debounced Search with repeated Projects/Types and never sends the Search separately', async () => {
    vi.useFakeTimers();
    try {
      const initial = makePage();
      const listed = makePage();
      addViewControl(initial, 'grid');
      restrict(initial);
      const search = addResultsSearch(initial);
      const link = addViewLink(initial, '/asset-viewer?project=3&project=7&type=comic&type=images&view=list');
      const windowObject = makeWindow(initial.document, new Map([['listed', listed.document]]));
      windowObject.location.href = RESTRICTED;
      const requests = heldFetch(windowObject);

      enhanceAssetLibraryLiveFiltering(initial.document);
      search.value = 'alpha';
      search.dispatch('input');
      expect(requests).toHaveLength(0);
      link.dispatch('click', { button: 0 });
      expect(requests).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(requests).toHaveLength(1);

      const viewUrl = new URL(requests[0].url);
      expect(viewUrl.searchParams.get('search')).toBe('alpha');
      expect(viewUrl.searchParams.getAll('project')).toEqual(['3', '7']);
      expect(viewUrl.searchParams.getAll('type')).toEqual(['comic', 'images']);
      expect(viewUrl.searchParams.getAll('view')).toEqual(['list']);
      requests[0].resolve(html('listed', requests[0].url));
      await flush();
      expect(windowObject.history.pushes.map((entry) => entry.url)).toEqual([requests[0].url]);
      expect(assetLibraryLiveSnapshot(initial.document).pending).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps Category, Presence, Usage, Tag, Extension, Sort, Order and page size with the clicked View', () => {
    const initial = makePage();
    addViewControl(initial, 'grid');
    restrict(initial);
    const controls = addCurrentFilterControls(initial, { page: '' });
    controls.view.disabled = true; // the radios own View in this fixture
    const link = addViewLink(initial, '/asset-viewer?view=list');
    const windowObject = makeWindow(initial.document, new Map());
    const requests = heldFetch(windowObject);

    enhanceAssetLibraryLiveFiltering(initial.document);
    controls.usage.value = 'used';
    initial.form.dispatch('change', { target: controls.usage });
    link.dispatch('click', { button: 0 });

    const viewUrl = new URL(requests[1].url);
    expect(viewUrl.searchParams.getAll('category')).toEqual(['category-illustration', 'category-reference']);
    expect(viewUrl.searchParams.getAll('tag')).toEqual(['tag-character', 'tag-environment']);
    expect(viewUrl.searchParams.getAll('extension')).toEqual(['extension-png', 'extension-webp']);
    expect(viewUrl.searchParams.get('presence')).toBe('present');
    expect(viewUrl.searchParams.get('usage')).toBe('used');
    expect(viewUrl.searchParams.get('sort')).toBe('project');
    expect(viewUrl.searchParams.get('order')).toBe('desc');
    expect(viewUrl.searchParams.get('pageSize')).toBe('50');
    expect(viewUrl.searchParams.getAll('project')).toEqual(['3', '7']);
    expect(viewUrl.searchParams.getAll('type')).toEqual(['comic', 'images']);
    expect(viewUrl.searchParams.getAll('view')).toEqual(['list']);
    expect(viewUrl.searchParams.has('page')).toBe(false);
  });

  it('applies Grid (reverse) to a pending GET started in List', () => {
    const initial = makePage();
    const view = addViewControl(initial, 'list');
    restrict(initial, { types: ['comic'] });
    const images = addCheckedChoice(initial, 'type', 'images', false);
    const link = addViewLink(initial, '/asset-viewer?project=3&project=7&type=comic&view=grid');
    const windowObject = makeWindow(initial.document, new Map());
    const requests = heldFetch(windowObject);

    enhanceAssetLibraryLiveFiltering(initial.document);
    images.checked = true;
    initial.form.dispatch('change', { target: images });
    expect(new URL(requests[0].url).searchParams.get('view')).toBe('list');
    link.dispatch('click', { button: 0 });

    const viewUrl = new URL(requests[1].url);
    expect(viewUrl.searchParams.getAll('type')).toEqual(['comic', 'images']);
    expect(viewUrl.searchParams.getAll('project')).toEqual(['3', '7']);
    expect(viewUrl.searchParams.getAll('view')).toEqual(['grid']);
    expect(view.grid.checked).toBe(true);
    expect(view.list.checked).toBe(false);
  });

  it('applies the View to a failed filter request and keeps Retry GET-only', async () => {
    const initial = makePage();
    const listed = makePage();
    addViewControl(initial, 'grid');
    restrict(initial);
    const search = addResultsSearch(initial);
    const link = addViewLink(initial, '/asset-viewer?view=list');
    const windowObject = makeWindow(initial.document, new Map([['listed', listed.document]]));
    const requests = heldFetch(windowObject);

    enhanceAssetLibraryLiveFiltering(initial.document);
    search.value = 'alpha';
    initial.form.dispatch('submit', { target: initial.form });
    requests[0].resolve({ ok: false, url: requests[0].url, text: async () => '' });
    await flush();
    expect(liveFailureNotice(initial.document)).not.toBeNull();

    link.dispatch('click', { button: 0 });
    expect(requests).toHaveLength(2);
    const viewUrl = new URL(requests[1].url);
    expect(viewUrl.searchParams.get('search')).toBe('alpha');
    expect(viewUrl.searchParams.getAll('project')).toEqual(['3', '7']);
    expect(viewUrl.searchParams.getAll('type')).toEqual(['comic', 'images']);
    expect(viewUrl.searchParams.getAll('view')).toEqual(['list']);

    requests[1].reject(new Error('offline'));
    await flush();
    const [retry] = liveFailureRetries(initial.document);
    retry.dispatch('click', { button: 0 });
    expect(requests).toHaveLength(3);
    expect(requests[2].url).toBe(requests[1].url);
    expect(requests.every((request) => request.options.method === 'GET')).toBe(true);
    requests[2].resolve(html('listed', requests[2].url));
    await flush();
    expect(initial.document.querySelector('[data-asset-library-live-region]')).toBe(listed.region);
    expect(windowObject.history.pushes.map((entry) => entry.url)).toEqual([requests[2].url]);
  });

  it('keeps the rendered View link address on an idle page and syncs the dialog View control', () => {
    const initial = makePage();
    const view = addViewControl(initial, 'grid');
    restrict(initial);
    const link = addViewLink(initial, '/asset-viewer?project=3&project=7&type=comic&type=images&page=2&view=list');
    const windowObject = makeWindow(initial.document, new Map());
    windowObject.location.href = RESTRICTED;
    const requests = heldFetch(windowObject);

    enhanceAssetLibraryLiveFiltering(initial.document);
    link.dispatch('click', { button: 0 });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('http://creatorcrate.test/asset-viewer?project=3&project=7&type=comic&type=images&page=2&view=list');
    expect(view.list.checked).toBe(true);
    expect(view.grid.checked).toBe(false);
  });

  it('leaves pagination links on their own rendered address while a filter GET is pending', () => {
    const initial = makePage();
    restrict(initial, { types: ['comic'] });
    const images = addCheckedChoice(initial, 'type', 'images', false);
    const link = addPaginationLink(initial, '/asset-viewer?project=3&project=7&type=comic&page=2');
    const windowObject = makeWindow(initial.document, new Map());
    const requests = heldFetch(windowObject);

    enhanceAssetLibraryLiveFiltering(initial.document);
    images.checked = true;
    initial.form.dispatch('change', { target: images });
    link.dispatch('click', { button: 0 });
    expect(requests[1].url).toBe('http://creatorcrate.test/asset-viewer?project=3&project=7&type=comic&page=2');
  });

  it('applies a View clicked during the NSFW POST to the debounced Search the toggle adopted', async () => {
    const initial = makePage();
    const listed = makePage();
    const { form } = addNsfwForm(initial);
    addNsfwForm(listed, true);
    addViewControl(initial, 'grid');
    restrict(initial);
    const search = addResultsSearch(initial);
    const link = addViewLink(initial, '/asset-viewer?project=3&project=7&type=comic&type=images&view=list');
    const windowObject = makeWindow(initial.document, new Map([['listed', listed.document]]));
    windowObject.location.href = RESTRICTED;
    const requests = heldFetch(windowObject);

    enhanceAssetLibraryLiveFiltering(initial.document);
    search.value = 'alpha';
    search.dispatch('input');
    form.dispatch('submit');
    expect(requests).toHaveLength(1);
    expect(requests[0].options.method).toBe('POST');

    link.dispatch('click', { button: 0 });
    expect(requests).toHaveLength(2);
    const viewUrl = new URL(requests[1].url);
    expect(requests[1].options.method).toBe('GET');
    expect(viewUrl.searchParams.get('search')).toBe('alpha');
    expect(viewUrl.searchParams.getAll('project')).toEqual(['3', '7']);
    expect(viewUrl.searchParams.getAll('type')).toEqual(['comic', 'images']);
    expect(viewUrl.searchParams.getAll('view')).toEqual(['list']);
    requests[1].resolve(html('listed', requests[1].url));
    await flush();
    expect(initial.document.querySelector('[data-asset-library-live-region]')).toBe(listed.region);
    expect(windowObject.history.pushes.map((entry) => entry.url)).toEqual([requests[1].url]);
    expect(requests.some((request) => String(request.url).includes('/defaults'))).toBe(false);
  });

  it('applies a View clicked during the NSFW refresh GET to that refresh destination', async () => {
    const initial = makePage();
    const listed = makePage();
    const { form } = addNsfwForm(initial);
    addNsfwForm(listed, true);
    restrict(initial);
    const search = addResultsSearch(initial);
    const link = addViewLink(initial, '/asset-viewer?view=list');
    const windowObject = makeWindow(initial.document, new Map([['listed', listed.document]]));
    windowObject.location.href = RESTRICTED;
    const requests = heldFetch(windowObject);

    enhanceAssetLibraryLiveFiltering(initial.document);
    search.value = 'alpha';
    search.dispatch('input');
    form.dispatch('submit');
    requests[0].resolve(NSFW_OK);
    await flush();
    expect(requests).toHaveLength(2);
    expect(new URL(requests[1].url).searchParams.get('search')).toBe('alpha');

    link.dispatch('click', { button: 0 });
    expect(requests[1].options.signal.aborted).toBe(true);
    const viewUrl = new URL(requests[2].url);
    expect(viewUrl.searchParams.get('search')).toBe('alpha');
    expect(viewUrl.searchParams.getAll('project')).toEqual(['3', '7']);
    expect(viewUrl.searchParams.getAll('type')).toEqual(['comic', 'images']);
    expect(viewUrl.searchParams.getAll('view')).toEqual(['list']);
    requests[2].resolve(html('listed', requests[2].url));
    await flush();
    expect(windowObject.history.pushes.map((entry) => entry.url)).toEqual([requests[2].url]);
    expect(listed.region.querySelector('[data-asset-library-nsfw-toggle]').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('Milestone 3 F9 Asset Library Reset filters keeps a newer toolbar View', () => {
  const TEMPORARY = 'http://creatorcrate.test/asset-viewer?project=3&type=comic&search=cat&usage=unused&extension=jpg&view=grid';
  const RESET = '/asset-viewer?resetFilters=1';
  // What the server restored from the saved defaults (canonical: Grid omitted).
  const RESTORED = 'http://creatorcrate.test/asset-viewer?category=final&tag=4&extension=png&presence=present&order=desc&pageSize=50';
  const RESTORED_LIST = `${RESTORED}&view=list`;

  function addViewControl(page, view = 'grid') {
    const dropdown = makeNode({ tagName: 'details', attrs: { 'data-cc-dropdown': '', 'data-cc-dropdown-mode': 'single' } });
    const grid = makeNode({ tagName: 'input', attrs: { name: 'view', type: 'radio', value: 'grid' }, value: 'grid', checked: view === 'grid' });
    const list = makeNode({ tagName: 'input', attrs: { name: 'view', type: 'radio', value: 'list' }, value: 'list', checked: view === 'list' });
    for (const input of [grid, list]) {
      input.form = page.form;
      dropdown.appendChild(input);
    }
    page.form.appendChild(dropdown);
    return { grid, list };
  }

  function heldFetch(windowObject) {
    const requests = [];
    windowObject.fetch.mockImplementation((url, options) => new Promise((resolve, reject) => {
      requests.push({ url, options, resolve, reject });
      options?.signal?.addEventListener?.('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    return requests;
  }

  const html = (key, url) => ({ ok: true, url, text: async () => key });
  const failed = (url) => ({ ok: false, status: 500, url, text: async () => 'failed' });
  const pathOf = (url) => {
    const parsed = new URL(url, 'http://creatorcrate.test');
    return parsed.pathname + parsed.search;
  };
  const region = (page) => page.document.querySelector('[data-asset-library-live-region]');

  function setup({ pages = {}, view = 'grid', before = null } = {}) {
    const initial = makePage();
    const controls = addViewControl(initial, view);
    const list = addViewLink(initial, '/asset-viewer?project=3&type=comic&search=cat&usage=unused&extension=jpg&view=list');
    const grid = addViewLink(initial, '/asset-viewer?project=3&type=comic&search=cat&usage=unused&extension=jpg');
    const extra = before?.(initial) ?? {};
    const rendered = new Map(Object.entries(pages).map(([key, page]) => [key, page.document]));
    const windowObject = makeWindow(initial.document, rendered);
    windowObject.location.href = TEMPORARY;
    const requests = heldFetch(windowObject);
    enhanceAssetLibraryLiveFiltering(initial.document);
    const events = [];
    subscribeAssetLibraryLive(initial.document, (detail) => events.push(detail));
    return { initial, controls, links: { list, grid }, windowObject, requests, events, ...extra };
  }

  it('keeps the held Reset running, then continues it once at the restored address with only View replaced', async () => {
    const restored = makePage();
    const { initial, controls, links, windowObject, requests, events } = setup({ pages: { restored } });
    const reset = navigateAssetLibraryLive(initial.document, RESET);
    expect(reset.status).toBe('started');
    expect(requests).toHaveLength(1);

    const click = links.list.dispatch('click', { button: 0 });
    expect(click.defaultPrevented).toBe(true);
    // Absorbed: the Reset is neither aborted nor replaced.
    expect(requests).toHaveLength(1);
    expect(requests[0].options.signal.aborted).toBe(false);
    expect(controls.list.checked).toBe(true);
    expect(controls.grid.checked).toBe(false);

    // The server redirected the Reset to its canonical restored address.
    requests[0].resolve(html('ignored', RESTORED));
    await flush();
    expect(requests).toHaveLength(2);
    expect(requests[1].url).toBe(RESTORED_LIST);
    expect(requests[1].options.method).toBe('GET');
    requests[1].resolve(html('restored', RESTORED_LIST));
    await flush();

    expect(region(initial)).toBe(restored.region);
    expect(windowObject.history.pushes.map((entry) => entry.url)).toEqual([RESTORED_LIST]);
    expect(windowObject.history.replaces).toEqual([]);
    // One owning generation from start to install; nothing superseded it.
    expect(events.filter((event) => event.generation >= reset.generation)
      .map((event) => [event.phase, event.generation])).toEqual([
      ['started', reset.generation], ['started', reset.generation], ['installed', reset.generation],
    ]);
    expect(requests.every((request) => request.options.method === 'GET')).toBe(true);
    expect(requests.some((request) => String(request.url).includes('/defaults'))).toBe(false);
  });

  it('costs no extra GET when the clicked View is the restored one, and sends an explicit Grid over a saved List', async () => {
    const restored = makePage();
    const restoredGrid = makePage();
    const { initial, links, windowObject, requests } = setup({ pages: { restored, restoredGrid }, view: 'list' });

    navigateAssetLibraryLive(initial.document, RESET);
    links.grid.dispatch('click', { button: 0 });
    requests[0].resolve(html('restored', RESTORED));
    await flush();
    // Canonical omits the fallback Grid: already Grid, nothing more.
    expect(requests).toHaveLength(1);
    expect(region(initial)).toBe(restored.region);
    expect(windowObject.history.pushes.map((entry) => entry.url)).toEqual([RESTORED]);

    // A saved List: the restored address carries view=list; Grid is explicit.
    navigateAssetLibraryLive(initial.document, RESET);
    links.grid.dispatch('click', { button: 0 });
    requests[1].resolve(html('ignored', RESTORED_LIST));
    await flush();
    expect(requests).toHaveLength(3);
    expect(requests[2].url).toBe(`${RESTORED}&view=grid`);
    requests[2].resolve(html('restoredGrid', requests[2].url));
    await flush();
    expect(region(initial)).toBe(restoredGrid.region);
  });

  it('uses only the latest of rapid View clicks, and a click during the continuation returns to the restored address', async () => {
    const restored = makePage();
    const { initial, links, windowObject, requests } = setup({ pages: { restored } });

    navigateAssetLibraryLive(initial.document, RESET);
    links.list.dispatch('click', { button: 0 });
    links.grid.dispatch('click', { button: 0 });
    links.list.dispatch('click', { button: 0 });
    expect(requests).toHaveLength(1);
    requests[0].resolve(html('ignored', RESTORED));
    await flush();
    expect(requests.map((request) => pathOf(request.url))).toEqual([RESET, pathOf(RESTORED_LIST)]);

    // Grid while the List continuation is in flight: absorbed again.
    links.grid.dispatch('click', { button: 0 });
    expect(requests).toHaveLength(2);
    expect(requests[1].options.signal.aborted).toBe(false);
    requests[1].resolve(html('ignored', RESTORED_LIST));
    await flush();
    expect(requests).toHaveLength(3);
    expect(requests[2].url).toBe(RESTORED);
    requests[2].resolve(html('restored', RESTORED));
    await flush();
    expect(requests).toHaveLength(3);
    expect(region(initial)).toBe(restored.region);
    expect(windowObject.history.pushes.map((entry) => entry.url)).toEqual([RESTORED]);
  });

  it('a failed Reset keeps the page; a View click re-requests the Reset and the Retry applies the View', async () => {
    const restored = makePage();
    const { initial, links, windowObject, requests, controls } = setup({ pages: { restored } });

    navigateAssetLibraryLive(initial.document, RESET);
    requests[0].resolve(failed(RESET));
    await flush();
    expect(liveFailureNotice(initial.document)).toBeTruthy();
    expect(region(initial)).toBe(initial.region);
    expect(windowObject.history.pushes).toEqual([]);

    links.list.dispatch('click', { button: 0 });
    expect(controls.list.checked).toBe(true);
    expect(requests).toHaveLength(2);
    expect(pathOf(requests[1].url)).toBe(RESET);
    requests[1].resolve(failed(requests[1].url));
    await flush();
    expect(region(initial)).toBe(initial.region);
    expect(windowObject.location.href).toBe(TEMPORARY);

    liveFailureRetries(initial.document)[0].dispatch('click');
    expect(requests).toHaveLength(3);
    expect(pathOf(requests[2].url)).toBe(RESET);
    requests[2].resolve(html('ignored', RESTORED));
    await flush();
    expect(requests[3].url).toBe(RESTORED_LIST);
    requests[3].resolve(html('restored', RESTORED_LIST));
    await flush();
    expect(region(initial)).toBe(restored.region);
    expect(liveFailureNotice(initial.document)).toBeFalsy();
    expect(windowObject.history.pushes.map((entry) => entry.url)).toEqual([RESTORED_LIST]);
    expect(requests.every((request) => request.options.method === 'GET')).toBe(true);
  });

  it('a failed continuation installs nothing; Retry repeats the Reset first and keeps the View', async () => {
    const restored = makePage();
    const { initial, links, windowObject, requests, events } = setup({ pages: { restored } });

    navigateAssetLibraryLive(initial.document, RESET);
    links.list.dispatch('click', { button: 0 });
    requests[0].resolve(html('ignored', RESTORED));
    await flush();
    requests[1].resolve(failed(RESTORED_LIST));
    await flush();
    expect(region(initial)).toBe(initial.region);
    expect(windowObject.location.href).toBe(TEMPORARY);
    expect(windowObject.history.pushes).toEqual([]);
    expect(events.at(-1).phase).toBe('failed');
    expect(liveFailureNotice(initial.document)).toBeTruthy();

    liveFailureRetries(initial.document)[0].dispatch('click');
    expect(pathOf(requests[2].url)).toBe(RESET);
    requests[2].resolve(html('ignored', RESTORED));
    await flush();
    expect(requests[3].url).toBe(RESTORED_LIST);
    requests[3].resolve(html('restored', RESTORED_LIST));
    await flush();
    expect(region(initial)).toBe(restored.region);
    expect(windowObject.history.pushes.map((entry) => entry.url)).toEqual([RESTORED_LIST]);
  });

  it('a filter edit supersedes Reset → View: the late Reset neither installs nor continues, and pagination is unaffected', async () => {
    const edited = makePage();
    const paged = makePage();
    const { initial, links, windowObject, requests, usage, pagination } = setup({
      pages: { edited, paged },
      before: (page) => ({
        usage: addCheckedChoice(page, 'usage', 'used'),
        pagination: addPaginationLink(page, '/asset-viewer?project=3&page=2'),
      }),
    });

    navigateAssetLibraryLive(initial.document, RESET);
    links.list.dispatch('click', { button: 0 });
    initial.form.dispatch('change', { target: usage });
    expect(requests).toHaveLength(2);
    expect(requests[0].options.signal.aborted).toBe(true);
    // The edit carries the dialog's newer List, not a Reset.
    const editUrl = new URL(requests[1].url);
    expect(editUrl.searchParams.has('resetFilters')).toBe(false);
    expect(editUrl.searchParams.get('view')).toBe('list');
    requests[1].resolve(html('edited', requests[1].url));
    await flush();
    requests[0].resolve(html('ignored', RESTORED));
    await flush();
    expect(requests).toHaveLength(2);
    expect(region(initial)).toBe(edited.region);

    pagination.dispatch('click', { button: 0 });
    expect(requests).toHaveLength(3);
    requests[2].resolve(html('paged', 'http://creatorcrate.test/asset-viewer?project=3&page=2'));
    await flush();
    expect(requests).toHaveLength(3);
    expect(windowObject.history.pushes.map((entry) => entry.url)).toEqual([
      requests[1].url, 'http://creatorcrate.test/asset-viewer?project=3&page=2',
    ]);
  });

  it('Back during Reset → View drops the View; a second Reset starts without it', async () => {
    const back = makePage();
    const restored = makePage();
    const { initial, links, windowObject, requests } = setup({ pages: { back, restored } });

    navigateAssetLibraryLive(initial.document, RESET);
    links.list.dispatch('click', { button: 0 });
    windowObject.location.href = 'http://creatorcrate.test/asset-viewer?project=9';
    windowObject.listeners.popstate();
    expect(requests[0].options.signal.aborted).toBe(true);
    requests[1].resolve(html('back', 'http://creatorcrate.test/asset-viewer?project=9'));
    await flush();
    expect(requests).toHaveLength(2);
    expect(windowObject.history.pushes).toEqual([]);

    // Reset → List, then a second Reset: the restored (Grid) address installs.
    navigateAssetLibraryLive(initial.document, RESET);
    links.list.dispatch('click', { button: 0 });
    navigateAssetLibraryLive(initial.document, RESET);
    expect(requests[2].options.signal.aborted).toBe(true);
    requests[3].resolve(html('restored', RESTORED));
    await flush();
    expect(requests).toHaveLength(4);
    expect(region(initial)).toBe(restored.region);
    expect(windowObject.history.pushes.map((entry) => entry.url)).toEqual([RESTORED]);
  });

  it('the filtered-empty Reset link is a Reset too and composes with a later View', async () => {
    const restored = makePage();
    const { initial, links, requests, emptyReset } = setup({
      pages: { restored },
      before: (page) => ({ emptyReset: addFilteredEmptyReset(page, RESET) }),
    });

    emptyReset.dispatch('click', { button: 0 });
    expect(pathOf(requests[0].url)).toBe(RESET);
    links.list.dispatch('click', { button: 0 });
    expect(requests).toHaveLength(1);
    requests[0].resolve(html('ignored', RESTORED));
    await flush();
    expect(requests[1].url).toBe(RESTORED_LIST);
    requests[1].resolve(html('restored', RESTORED_LIST));
    await flush();
    expect(region(initial)).toBe(restored.region);
  });

  it('a View clicked while the restored response is already installing navigates to the restored address with that View', async () => {
    const restored = makePage();
    const listed = makePage();
    const { initial, links, windowObject, requests, events } = setup({ pages: { restored, listed } });

    navigateAssetLibraryLive(initial.document, RESET);
    let release;
    const body = new Promise((resolve) => { release = resolve; });
    requests[0].resolve({ ok: true, url: RESTORED, text: () => body });
    await flush();
    expect(requests).toHaveLength(1);
    // Grid is the View already installing: nothing to do.
    links.grid.dispatch('click', { button: 0 });
    expect(requests).toHaveLength(1);
    links.list.dispatch('click', { button: 0 });
    expect(requests).toHaveLength(2);
    expect(requests[1].url).toBe(RESTORED_LIST);
    release('restored');
    await flush();
    expect(events.some((event) => event.phase === 'superseded')).toBe(true);
    expect(region(initial)).toBe(initial.region);
    requests[1].resolve(html('listed', RESTORED_LIST));
    await flush();
    expect(region(initial)).toBe(listed.region);
    expect(windowObject.history.pushes.map((entry) => entry.url)).toEqual([RESTORED_LIST]);
  });

  it('an NSFW toggle during Reset → View refreshes the Reset itself and keeps the View', async () => {
    const restored = makePage();
    addNsfwForm(restored, true);
    const { initial, links, windowObject, requests, nsfw } = setup({
      pages: { restored },
      before: (page) => ({ nsfw: addNsfwForm(page) }),
    });

    navigateAssetLibraryLive(initial.document, RESET);
    links.list.dispatch('click', { button: 0 });
    nsfw.form.dispatch('submit');
    expect(requests[0].options.signal.aborted).toBe(true);
    requests[1].resolve(NSFW_OK);
    await flush();
    expect(pathOf(requests[2].url)).toBe(RESET);
    requests[2].resolve(html('ignored', RESTORED));
    await flush();
    expect(requests[3].url).toBe(RESTORED_LIST);
    requests[3].resolve(html('restored', RESTORED_LIST));
    await flush();
    expect(region(initial)).toBe(restored.region);
    expect(windowObject.history.pushes.map((entry) => entry.url)).toEqual([RESTORED_LIST]);
    expect(requests.filter((request) => request.options.method === 'POST').map((request) => pathOf(request.url)))
      .toEqual(['/asset-viewer/nsfw-filter']);
  });

  it('an NSFW toggle after a failed continuation refreshes the Reset with its owed entry and View', async () => {
    const restored = makePage();
    addNsfwForm(restored, true);
    const { initial, links, windowObject, requests, nsfw } = setup({
      pages: { restored },
      before: (page) => ({ nsfw: addNsfwForm(page) }),
    });

    navigateAssetLibraryLive(initial.document, RESET);
    links.list.dispatch('click', { button: 0 });
    requests[0].resolve(html('ignored', RESTORED));
    await flush();
    requests[1].resolve(failed(RESTORED_LIST));
    await flush();
    nsfw.form.dispatch('submit');
    requests[2].resolve(NSFW_OK);
    await flush();
    expect(pathOf(requests[3].url)).toBe(RESET);
    requests[3].resolve(html('ignored', RESTORED));
    await flush();
    expect(requests[4].url).toBe(RESTORED_LIST);
    requests[4].resolve(html('restored', RESTORED_LIST));
    await flush();
    expect(region(initial)).toBe(restored.region);
    expect(windowObject.history.pushes.map((entry) => entry.url)).toEqual([RESTORED_LIST]);
  });

  it('an ordinary pending filter GET still takes the View directly (F4), with no Reset composition', async () => {
    const listed = makePage();
    const { initial, links, requests, usage } = setup({
      pages: { listed },
      before: (page) => ({ usage: addCheckedChoice(page, 'usage', 'used') }),
    });
    initial.form.dispatch('change', { target: usage });
    links.list.dispatch('click', { button: 0 });
    expect(requests).toHaveLength(2);
    expect(requests[0].options.signal.aborted).toBe(true);
    expect(new URL(requests[1].url).searchParams.get('view')).toBe('list');
    expect(new URL(requests[1].url).searchParams.get('usage')).toBe('used');
    requests[1].resolve(html('listed', requests[1].url));
    await flush();
    expect(requests).toHaveLength(2);
    expect(region(initial)).toBe(listed.region);
  });
});

// R2: the combined dialog's radio View and the Grid style field shown only for
// Grid (hidden is presentation only: the field and its value stay).
function addRadioViewAndGridStyle(page, view = 'grid', gridStyle = 'cropped') {
  const viewDropdown = makeNode({ tagName: 'details', attrs: { id: 'asset-view-filter', class: 'cc-dropdown', 'data-cc-dropdown': '' } });
  const viewSummary = makeNode({ tagName: 'summary', attrs: { id: 'asset-view-filter-trigger' } });
  const grid = makeNode({ tagName: 'input', attrs: { name: 'view', type: 'radio', value: 'grid' }, checked: view === 'grid' });
  const list = makeNode({ tagName: 'input', attrs: { name: 'view', type: 'radio', value: 'list' }, checked: view === 'list' });
  viewDropdown.appendChild(viewSummary);
  viewDropdown.appendChild(grid);
  viewDropdown.appendChild(list);
  const field = makeNode({
    tagName: 'fieldset',
    attrs: { 'data-asset-library-grid-style-field': '', 'data-filters-visible-when-view': 'grid', ...(view === 'list' ? { hidden: '' } : {}) },
  });
  const select = makeNode({ tagName: 'select', attrs: { id: 'asset-library-grid-style', 'data-asset-library-grid-style': '' }, value: gridStyle });
  field.appendChild(select);
  const pageSize = makeNode({ tagName: 'fieldset', attrs: { 'data-test-page-size-field': '' } });
  page.form.appendChild(viewDropdown);
  page.form.appendChild(field);
  page.form.appendChild(pageSize);
  return { grid, list, viewSummary, field, select, pageSize };
}

describe('R2 Asset Library Grid style visibility follows the radio View', () => {
  it('starts from the server state, follows dialog and toolbar View changes, and keeps the Grid style value', async () => {
    const initial = makePage();
    const controls = addRadioViewAndGridStyle(initial, 'grid');
    const next = makePage();
    const nextControls = addRadioViewAndGridStyle(next, 'list');
    const windowObject = makeWindow(initial.document, new Map([['listed', next.document]]));
    let resolve;
    windowObject.fetch.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const viewLink = addViewLink(initial, '/asset-viewer?view=list');
    enhanceAssetLibraryLiveFiltering(initial.document);
    expect(controls.field.hidden).toBe(false);

    controls.grid.checked = false;
    controls.list.checked = true;
    initial.form.dispatch('change', { target: controls.list });
    expect(controls.field.hidden).toBe(true);
    expect(controls.pageSize.hidden).toBe(false);
    expect(controls.select.value).toBe('cropped');
    expect(initial.form.contains(controls.select)).toBe(true);

    controls.list.checked = false;
    controls.grid.checked = true;
    initial.form.dispatch('change', { target: controls.grid });
    expect(controls.field.hidden).toBe(false);
    expect(controls.select.value).toBe('cropped');

    // The toolbar synchronizes the radio without a change event.
    viewLink.dispatch('click', { button: 0 });
    expect(controls.list.checked).toBe(true);
    expect(controls.field.hidden).toBe(true);

    resolve({ ok: true, url: 'http://creatorcrate.test/asset-viewer?view=list', text: async () => 'listed' });
    await flush();
    expect(initial.form.contains(nextControls.field)).toBe(true);
    expect(nextControls.field.hidden).toBe(true);
    windowObject.fetch.mock.calls.forEach(([, options]) => expect(options?.method || 'GET').toBe('GET'));
  });
});
