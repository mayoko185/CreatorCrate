import { describe, expect, it, vi } from 'vitest';
import {
  beginAssetViewerDefaultsLiveRefresh,
  enhanceAssetLibraryLiveFiltering,
  enhancePageDefaultsFetchSave,
  refreshAssetViewerLiveRegion,
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
    attrs: { href: '/assets/7', 'data-project-assets-preview-id': '7' },
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
      .toBe('Asset Viewer is loading as a full page.');
    expect(initial.form.submit).toHaveBeenCalledTimes(1);
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

  it('re-enhances replaced Asset Viewer controls and preview links', async () => {
    const initial = makePage();
    const next = makePage('1');
    const fixtures = addReplacementEnhancerFixtures(next);
    const openSingleById = vi.fn(() => true);
    const scaffold = makeNode({ attrs: { 'data-slideshow-scaffold': '' } });
    scaffold.__creatorCrateSlideshowState = { openSingleById };
    initial.document.appendChild(scaffold);

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
    const event = next.preview.dispatch('click', { button: 0 });
    expect(openSingleById).toHaveBeenCalledWith('7', next.preview);
    expect(event.defaultPrevented).toBe(true);
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
