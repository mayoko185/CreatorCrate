import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  beginReleasesDefaultsLiveRefresh,
  enhanceReleaseAssetsLiveFiltering,
  enhanceReleasesLiveFiltering,
  refreshReleasesLiveRegion,
} from '../src/static/creatorcrate.js';

// The live engine serializes the whole filter form, so preserving the active page
// size depends on the template's own option set. Read it instead of restating it.
const RELEASE_ASSETS_TEMPLATE = fs.readFileSync(
  fileURLToPath(new URL('../src/views/releases/assets.njk', import.meta.url)),
  'utf8',
);

function templatePageSizeOptions(id) {
  const start = RELEASE_ASSETS_TEMPLATE.indexOf(`<select id="${id}"`);
  const markup = RELEASE_ASSETS_TEMPLATE.slice(start, RELEASE_ASSETS_TEMPLATE.indexOf('</select>', start));
  return [...markup.matchAll(/<option value="(\d+)"/g)].map(([, value]) => value);
}

const FILTER_PAGE_SIZE_OPTIONS = templatePageSizeOptions('asset-page-size');
const PAGE_SIZE_FORM_OPTIONS = templatePageSizeOptions('pageSize');

function makeNode({ tagName = 'div', attrs = {}, value = '', checked = false } = {}) {
  const attributes = new Map();
  const children = [];
  const listeners = [];
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
    focused: false,
    selectionStart: null,
    selectionEnd: null,
    textContent: '',
    open: false,
    hidden: false,
    setAttribute(name, rawValue) {
      const stringValue = String(rawValue);
      attributes.set(name, stringValue);
      if (name === 'id') this.id = stringValue;
      if (name === 'name') this.name = stringValue;
      if (name === 'type') this.type = stringValue;
      if (name === 'value') this.value = stringValue;
      if (name === 'action') this.action = stringValue;
      if (name === 'method') this.method = stringValue;
      if (name === 'checked') this.checked = true;
      if (name === 'hidden') this.hidden = true;
      if (name.startsWith('data-')) {
        this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = stringValue;
      }
    },
    getAttribute(name) { return attributes.get(name) ?? null; },
    hasAttribute(name) { return attributes.has(name); },
    removeAttribute(name) {
      attributes.delete(name);
      if (name === 'hidden') this.hidden = false;
      if (name === 'checked') this.checked = false;
      if (name.startsWith('data-')) {
        delete this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())];
      }
    },
    matches(selector) {
      return selector.split(',').some((part) => {
        const candidate = part.trim();
        if (candidate.includes(' ')) {
          const pieces = candidate.split(/\s+/);
          const target = pieces.pop();
          if (!this.matches(target)) return false;
          let ancestor = this.parentNode;
          while (ancestor) {
            if (ancestor.matches?.(pieces.join(' '))) return true;
            ancestor = ancestor.parentNode;
          }
          return false;
        }
        if (candidate.startsWith('#')) return this.id === candidate.slice(1);
        const classes = [...candidate.matchAll(/\.([\w-]+)/g)].map(([, name]) => name);
        if (!classes.every((name) => String(this.getAttribute('class') || '').split(/\s+/).includes(name))) {
          return false;
        }
        const tag = candidate.match(/^[a-z][\w-]*/i)?.[0];
        if (tag && this.tagName !== tag.toUpperCase()) return false;
        return [...candidate.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)].every(([, name, expected]) => {
          const actual = this.getAttribute(name);
          return actual !== null && (expected === undefined || actual === expected);
        });
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
      next.parentNode = parent;
      next.parentElement = parent;
      const document = parent.ownerDocument || parent;
      const adopt = (current) => {
        current.ownerDocument = document;
        current.children.forEach(adopt);
      };
      adopt(next);
    },
    addEventListener(type, handler) { listeners.push({ type, handler }); },
    dispatch(type, props = {}) {
      const event = {
        type,
        target: props.target || this,
        button: 0,
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
    focus() {
      this.focused = true;
      if (this.ownerDocument) this.ownerDocument.activeElement = this;
    },
    contains(candidate) {
      let current = candidate;
      while (current) {
        if (current === this) return true;
        current = current.parentNode;
      }
      return false;
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
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
  };
  Object.entries(attrs).forEach(([name, rawValue]) => node.setAttribute(name, rawValue));
  if (checked) node.checked = true;
  return node;
}

// Mirrors browser selectedness: a single select whose value matches no option
// exposes its first option instead, which is how an unrepresentable page size is lost.
function makeSelect(attrs, options, selectedValue) {
  const select = makeNode({ tagName: 'select', attrs });
  const optionNodes = options.map((optionValue) => {
    const option = makeNode({ tagName: 'option', attrs: { value: optionValue } });
    option.selected = optionValue === String(selectedValue);
    return option;
  });
  optionNodes.forEach((option) => select.appendChild(option));
  Object.defineProperty(select, 'value', {
    configurable: true,
    get() {
      const active = optionNodes.find((option) => option.selected) || optionNodes[0];
      return active ? active.getAttribute('value') : '';
    },
    set(next) {
      optionNodes.forEach((option) => { option.selected = option.getAttribute('value') === String(next); });
    },
  });
  return select;
}

function makeReleaseDropdown(form, name, value, { searchable = false } = {}) {
  const dropdown = makeNode({
    tagName: 'details',
    attrs: { id: `release-${name}-filter`, 'data-cc-dropdown': '', 'data-cc-dropdown-mode': 'single' },
  });
  const summary = makeNode({ tagName: 'summary', attrs: { 'aria-controls': `release-${name}-options` } });
  const option = makeNode({
    tagName: 'input',
    attrs: { name, type: 'radio', value },
    value,
    checked: true,
  });
  dropdown.appendChild(summary);
  dropdown.appendChild(option);

  let search = null;
  if (searchable) {
    search = makeNode({
      tagName: 'input',
      attrs: { id: `release-${name}-filter-search`, type: 'search', 'data-cc-dropdown-search': '' },
    });
    dropdown.setAttribute('data-cc-dropdown-searchable', '');
    dropdown.appendChild(search);
  }

  form.appendChild(dropdown);
  return { dropdown, summary, option, search };
}

function makeForm(action = '/releases', {
  projectValue = '7',
  scheduleValue = '',
  sortValue = 'planned',
  orderValue = 'asc',
  includeArchived = false,
  pageSize = '25',
} = {}) {
  const form = makeNode({
    tagName: 'form',
    attrs: { action, method: 'get', 'data-releases-filter': '' },
  });
  form.submit = vi.fn();
  const project = makeReleaseDropdown(form, 'project', projectValue, { searchable: true });
  const schedule = makeReleaseDropdown(form, 'schedule', scheduleValue);
  const sort = makeReleaseDropdown(form, 'sort', sortValue);
  const order = makeReleaseDropdown(form, 'order', orderValue);
  const page = makeNode({
    tagName: 'input',
    attrs: { name: 'page', type: 'hidden' },
    value: '4',
  });
  if (String(pageSize) !== '25') {
    form.appendChild(makeNode({
      tagName: 'input',
      attrs: { name: 'pageSize', type: 'hidden' },
      value: String(pageSize),
    }));
  }
  const archived = makeNode({
    tagName: 'input',
    attrs: { name: 'includeArchived', type: 'checkbox', value: '1' },
    value: '1',
    checked: includeArchived,
  });
  form.appendChild(page);
  form.appendChild(archived);
  return {
    form,
    project: project.option,
    projectDropdown: project.dropdown,
    projectSummary: project.summary,
    projectSearch: project.search,
    page,
    schedule: schedule.option,
    scheduleDropdown: schedule.dropdown,
    sort: sort.option,
    sortDropdown: sort.dropdown,
    order: order.option,
    orderDropdown: order.dropdown,
    archived,
  };
}

function makePage(action = '/releases', options = {}) {
  const document = makeNode({ tagName: 'document' });
  document.nodeType = 9;
  document.ownerDocument = document;
  document.activeElement = null;
  const region = makeNode({ attrs: { 'data-releases-live-region': '' } });
  const status = makeNode({ attrs: { 'data-releases-live-status': '' } });
  const formParts = makeForm(action, options);
  const dialog = makeNode({ tagName: 'dialog', attrs: { id: 'releases-filter-dialog', 'data-app-dialog': '' } });
  dialog.open = options.dialogOpen === true;
  const resetForm = makeNode({
    tagName: 'form',
    attrs: { action: options.resetUrl || action, method: 'get', class: 'releases-filter-reset' },
  });
  const reset = makeNode({ tagName: 'button', attrs: { type: 'submit', 'data-releases-reset': '' } });
  reset.form = resetForm;
  const pagination = makeNode({ tagName: 'nav', attrs: { class: 'pagination' } });
  const next = makeNode({ tagName: 'a', attrs: { href: action + '?page=2' } });
  pagination.appendChild(next);
  region.appendChild(status);
  region.appendChild(pagination);
  document.appendChild(region);
  dialog.appendChild(formParts.form);
  resetForm.appendChild(reset);
  dialog.appendChild(resetForm);
  document.appendChild(dialog);
  return { document, region, status, dialog, resetForm, reset, pagination, next, ...formParts };
}

function makeReleaseAssetsPage({
  extension = 'png', category = '3', search = '', view = 'grid', pageSize: selectedPageSize = '50',
} = {}) {
  const document = makeNode({ tagName: 'document' });
  document.nodeType = 9;
  document.ownerDocument = document;
  document.activeElement = null;
  const region = makeNode({ attrs: { 'data-release-assets-live-region': '' } });
  const status = makeNode({ attrs: { 'data-release-assets-live-status': '' } });
  const filter = makeNode({
    tagName: 'form',
    attrs: {
      action: '/releases/7/assets',
      method: 'get',
      class: 'release-asset-filters',
      'data-release-assets-live-filter': '',
    },
  });
  const add = (attrs, fieldValue = '', fieldChecked = false) => {
    const field = makeNode({ tagName: attrs.tagName || 'input', attrs, value: fieldValue, checked: fieldChecked });
    filter.appendChild(field);
    return field;
  };
  const viewField = add({ name: 'view', type: 'hidden' }, view);
  const page = add({ name: 'page', type: 'hidden' }, '4');
  const filterPageSize = makeSelect(
    { name: 'pageSize', 'data-release-assets-live-page-size': '' },
    FILTER_PAGE_SIZE_OPTIONS,
    selectedPageSize,
  );
  filter.appendChild(filterPageSize);
  const searchInput = add({ name: 'search', type: 'search', 'data-release-assets-live-search': '' }, search);
  const extensionPng = add({ name: 'extension', type: 'radio', value: 'png', 'data-release-assets-live-filter-control': '' }, 'png', extension === 'png');
  const extensionJpg = add({ name: 'extension', type: 'radio', value: 'jpg', 'data-release-assets-live-filter-control': '' }, 'jpg', extension === 'jpg');
  const categoryThree = add({ name: 'category', type: 'radio', value: '3', 'data-release-assets-live-filter-control': '' }, '3', category === '3');
  const categoryFour = add({ name: 'category', type: 'radio', value: '4', 'data-release-assets-live-filter-control': '' }, '4', category === '4');
  const selection = makeNode({
    tagName: 'form',
    attrs: { action: '/releases/7/assets', method: 'post', id: 'release-assets-form' },
  });
  selection.appendChild(makeNode({
    tagName: 'input',
    attrs: { name: 'selectedAssetIds', type: 'checkbox', value: '99' },
    value: '99',
    checked: true,
  }));
  const disclosure = makeNode({
    tagName: 'details',
    attrs: { 'data-asset-viewer-filter-disclosure': '' },
  });
  disclosure.appendChild(makeNode({ tagName: 'summary' }));
  const viewNav = makeNode({ tagName: 'nav', attrs: { class: 'view-switcher', 'aria-label': 'Asset display' } });
  const grid = makeNode({
    tagName: 'a',
    attrs: { href: `/releases/7/assets?view=grid&pageSize=${selectedPageSize}`, 'data-release-assets-view-link': '' },
  });
  const list = makeNode({
    tagName: 'a',
    attrs: { href: `/releases/7/assets?view=list&pageSize=${selectedPageSize}`, 'data-release-assets-view-link': '' },
  });
  viewNav.appendChild(grid);
  viewNav.appendChild(list);
  const pagination = makeNode({ tagName: 'nav', attrs: { class: 'pagination', 'aria-label': 'Release asset pages' } });
  const next = makeNode({
    tagName: 'a',
    attrs: { href: `/releases/7/assets?view=${view}&pageSize=${selectedPageSize}&search=${search}&extension=${extension}&category=${category}&page=2` },
  });
  pagination.appendChild(next);
  const pageSizeForm = makeNode({
    tagName: 'form',
    attrs: {
      action: '/releases/7/assets', method: 'get', class: 'page-size-form',
      'data-release-assets-live-page-size-form': '',
    },
  });
  const pageSize = makeSelect(
    { name: 'pageSize', 'data-release-assets-live-page-size': '', 'data-autosubmit': '' },
    PAGE_SIZE_FORM_OPTIONS,
    selectedPageSize,
  );
  pageSizeForm.appendChild(pageSize);
  if (search) pageSizeForm.appendChild(makeNode({ tagName: 'input', attrs: { name: 'search', type: 'hidden' }, value: search }));
  if (extension) pageSizeForm.appendChild(makeNode({ tagName: 'input', attrs: { name: 'extension', type: 'hidden' }, value: extension }));
  if (category) pageSizeForm.appendChild(makeNode({ tagName: 'input', attrs: { name: 'category', type: 'hidden' }, value: category }));
  if (view === 'list') pageSizeForm.appendChild(makeNode({ tagName: 'input', attrs: { name: 'view', type: 'hidden' }, value: view }));
  const reset = makeNode({
    tagName: 'a',
    attrs: { href: `/releases/7/assets?view=${view}&pageSize=${selectedPageSize}`, 'data-release-assets-reset': '' },
  });
  region.appendChild(status);
  region.appendChild(selection);
  region.appendChild(viewNav);
  region.appendChild(filter);
  region.appendChild(pagination);
  region.appendChild(pageSizeForm);
  region.appendChild(reset);
  region.appendChild(disclosure);
  document.appendChild(region);
  return {
    document, region, status, filter, disclosure, view: viewField, page, filterPageSize, pageSize,
    searchInput, extensionPng, extensionJpg, categoryThree, categoryFour, selection, viewNav,
    grid, list, pagination, next, pageSizeForm, reset,
  };
}

function makeWindow(document, pages = new Map()) {
  const location = {
    href: 'http://creatorcrate.test/releases?page=4',
    pathname: '/releases',
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
      pushState(state, title, url) { this.pushes.push({ state, title, url }); setLocation(url); },
      replaceState(state, title, url) { this.replaces.push({ state, title, url }); setLocation(url); },
    },
    listeners: [],
    addEventListener(type, handler) { this.listeners.push({ type, handler }); },
    dispatch(type) { this.listeners.filter((listener) => listener.type === type).forEach(({ handler }) => handler()); },
  };
  document.defaultView = windowObject;
  return windowObject;
}

function responseFor(text, url) {
  return { ok: true, url, text: vi.fn(async () => text) };
}

async function flush() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

describe('Releases live filtering enhancement', () => {
  beforeEach(() => { vi.useRealTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('refreshes Releases from the defaults redirect through the live engine and reconciles the external filter', async () => {
    const initial = makePage('/releases', { dialogOpen: true, sortValue: 'planned', orderValue: 'asc' });
    const next = makePage('/releases', { sortValue: 'title', orderValue: 'desc' });
    const pages = new Map([['defaults-result', next.document]]);
    const windowObject = makeWindow(initial.document, pages);
    windowObject.location.assign = vi.fn();
    const successUrl = 'http://creatorcrate.test/releases?sort=title&order=desc&notice=releases_defaults_saved';
    const canonicalUrl = 'http://creatorcrate.test/releases?sort=title&order=desc';
    windowObject.fetch.mockResolvedValue(responseFor('defaults-result', canonicalUrl));
    enhanceReleasesLiveFiltering(initial.document);

    const authority = beginReleasesDefaultsLiveRefresh(initial.document);
    expect(refreshReleasesLiveRegion(initial.document, successUrl, authority)).toBe('started');
    await flush();

    expect(windowObject.fetch).toHaveBeenCalledWith(
      successUrl,
      expect.objectContaining({ method: 'GET', headers: { Accept: 'text/html' } }),
    );
    expect(windowObject.location.assign).not.toHaveBeenCalled();
    expect(windowObject.history.pushes).toHaveLength(0);
    expect(windowObject.history.replaces).toEqual([expect.objectContaining({ url: canonicalUrl })]);
    expect(initial.document.querySelector('[data-releases-live-region]')).toBe(next.region);
    expect(initial.document.querySelector('[data-releases-filter]')).toBe(initial.form);
    expect(initial.form.contains(next.sort)).toBe(true);
    expect(initial.form.contains(next.order)).toBe(true);
    expect(next.sort.value).toBe('title');
    expect(next.order.value).toBe('desc');
    expect(initial.dialog.open).toBe(true);
  });

  it('keeps newer Releases filter intent authoritative over an older defaults completion', () => {
    const initial = makePage();
    const windowObject = makeWindow(initial.document);
    windowObject.fetch.mockImplementation(() => new Promise(() => {}));
    enhanceReleasesLiveFiltering(initial.document);
    const authority = beginReleasesDefaultsLiveRefresh(initial.document);

    initial.schedule.value = 'today';
    initial.form.dispatch('change', { target: initial.schedule });

    expect(refreshReleasesLiveRegion(
      initial.document,
      'http://creatorcrate.test/releases?sort=title&order=desc&notice=releases_defaults_saved',
      authority,
    )).toBe('superseded');
    expect(windowObject.fetch).toHaveBeenCalledOnce();
  });

  it('announces a defaults refresh failure without falling back to navigation', async () => {
    const initial = makePage();
    const windowObject = makeWindow(initial.document);
    windowObject.location.assign = vi.fn();
    windowObject.fetch.mockRejectedValue(new Error('offline'));
    const onError = vi.fn();
    enhanceReleasesLiveFiltering(initial.document);
    const authority = beginReleasesDefaultsLiveRefresh(initial.document);

    expect(refreshReleasesLiveRegion(
      initial.document,
      'http://creatorcrate.test/releases?sort=title&order=desc&notice=releases_defaults_saved',
      authority,
      { onError },
    )).toBe('started');
    await flush();

    expect(onError).toHaveBeenCalledOnce();
    expect(windowObject.location.assign).not.toHaveBeenCalled();
    expect(initial.status.textContent).toBe(
      'Defaults were saved, but Releases could not refresh. Refresh the page to see the saved defaults.',
    );
    expect(initial.region.getAttribute('data-releases-live-state')).toBe('error');
  });

  it('filters Release Assets immediately, preserves sibling state, and rebinds once per replacement', async () => {
    vi.useFakeTimers();
    const initial = makeReleaseAssetsPage();
    const afterExtension = makeReleaseAssetsPage({ extension: 'jpg', category: '3' });
    const afterCategory = makeReleaseAssetsPage({ extension: 'jpg', category: '4' });
    const afterSearch = makeReleaseAssetsPage({ extension: 'jpg', category: '4', search: 'needle' });
    const pages = new Map([
      ['after-extension', afterExtension.document],
      ['after-category', afterCategory.document],
      ['after-search', afterSearch.document],
    ]);
    const windowObject = makeWindow(initial.document, pages);
    windowObject.location.href = 'http://creatorcrate.test/releases/7/assets?page=4';
    windowObject.location.pathname = '/releases/7/assets';
    windowObject.fetch
      .mockResolvedValueOnce(responseFor('after-extension', 'http://creatorcrate.test/releases/7/assets?view=grid&pageSize=50&extension=jpg&category=3'))
      .mockResolvedValueOnce(responseFor('after-category', 'http://creatorcrate.test/releases/7/assets?view=grid&pageSize=50&extension=jpg&category=4'))
      .mockResolvedValueOnce(responseFor('after-search', 'http://creatorcrate.test/releases/7/assets?view=grid&pageSize=50&search=needle&extension=jpg&category=4'))
      .mockResolvedValue(responseFor('after-search', 'http://creatorcrate.test/releases/7/assets?view=grid&pageSize=50&search=needle&extension=jpg&category=3'));

    expect(enhanceReleaseAssetsLiveFiltering(initial.document)).toBe(2);
    expect(initial.filter.listeners).toHaveLength(2);
    expect(initial.region.listeners.filter(({ type }) => type === 'click')).toHaveLength(1);
    expect(enhanceReleaseAssetsLiveFiltering(initial.document)).toBe(2);
    expect(initial.filter.listeners).toHaveLength(2);

    initial.extensionPng.checked = false;
    initial.extensionJpg.checked = true;
    initial.filter.dispatch('change', { target: initial.extensionJpg });
    await flush();

    expect(windowObject.fetch).toHaveBeenCalledTimes(1);
    let requested = new URL(windowObject.fetch.mock.calls[0][0]);
    expect(requested.pathname).toBe('/releases/7/assets');
    expect(requested.searchParams.get('extension')).toBe('jpg');
    expect(requested.searchParams.get('category')).toBe('3');
    expect(requested.searchParams.get('pageSize')).toBe('50');
    expect(requested.searchParams.has('page')).toBe(false);
    expect(requested.searchParams.has('selectedAssetIds')).toBe(false);
    expect(initial.document.querySelector('[data-release-assets-live-region]')).toBe(afterExtension.region);
    expect(afterExtension.filter.listeners).toHaveLength(2);
    expect(afterExtension.region.listeners.filter(({ type }) => type === 'click')).toHaveLength(1);

    afterExtension.categoryThree.checked = false;
    afterExtension.categoryFour.checked = true;
    afterExtension.filter.dispatch('change', { target: afterExtension.categoryFour });
    await flush();

    expect(windowObject.fetch).toHaveBeenCalledTimes(2);
    requested = new URL(windowObject.fetch.mock.calls[1][0]);
    expect(requested.searchParams.get('extension')).toBe('jpg');
    expect(requested.searchParams.get('category')).toBe('4');
    expect(requested.searchParams.has('selectedAssetIds')).toBe(false);

    afterCategory.searchInput.value = 'needle';
    afterCategory.searchInput.dispatch('input');
    vi.advanceTimersByTime(349);
    expect(windowObject.fetch).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    await flush();

    expect(windowObject.fetch).toHaveBeenCalledTimes(3);
    requested = new URL(windowObject.fetch.mock.calls[2][0]);
    expect(requested.searchParams.get('search')).toBe('needle');
    expect(requested.searchParams.get('extension')).toBe('jpg');
    expect(requested.searchParams.get('category')).toBe('4');
    expect(initial.document.querySelector('[data-release-assets-live-region]')).toBe(afterSearch.region);
    expect(enhanceReleaseAssetsLiveFiltering(initial.document)).toBe(2);
    expect(afterSearch.filter.listeners).toHaveLength(2);

    afterSearch.categoryFour.checked = false;
    afterSearch.categoryThree.checked = true;
    afterSearch.filter.dispatch('change', { target: afterSearch.categoryThree });
    await flush();
    expect(windowObject.fetch).toHaveBeenCalledTimes(4);
  });

  it('preserves an active pageSize=10 across Extension, Category, and Search changes', async () => {
    vi.useFakeTimers();
    const initial = makeReleaseAssetsPage({ pageSize: '10' });
    const afterExtension = makeReleaseAssetsPage({ extension: 'jpg', category: '3', pageSize: '10' });
    const afterCategory = makeReleaseAssetsPage({ extension: 'jpg', category: '4', pageSize: '10' });
    const afterSearch = makeReleaseAssetsPage({
      extension: 'jpg', category: '4', search: 'needle', pageSize: '10',
    });
    const pages = new Map([
      ['after-extension', afterExtension.document],
      ['after-category', afterCategory.document],
      ['after-search', afterSearch.document],
    ]);
    const windowObject = makeWindow(initial.document, pages);
    windowObject.location.href = 'http://creatorcrate.test/releases/7/assets?pageSize=10';
    windowObject.location.pathname = '/releases/7/assets';
    windowObject.fetch
      .mockResolvedValueOnce(responseFor('after-extension', 'http://creatorcrate.test/releases/7/assets?view=grid&pageSize=10&extension=jpg&category=3'))
      .mockResolvedValueOnce(responseFor('after-category', 'http://creatorcrate.test/releases/7/assets?view=grid&pageSize=10&extension=jpg&category=4'))
      .mockResolvedValueOnce(responseFor('after-search', 'http://creatorcrate.test/releases/7/assets?view=grid&pageSize=10&search=needle&extension=jpg&category=4'));

    expect(enhanceReleaseAssetsLiveFiltering(initial.document)).toBe(2);
    expect(initial.filterPageSize.value).toBe('10');

    initial.extensionPng.checked = false;
    initial.extensionJpg.checked = true;
    initial.filter.dispatch('change', { target: initial.extensionJpg });
    await flush();

    let requested = new URL(windowObject.fetch.mock.calls[0][0]);
    expect(requested.searchParams.get('pageSize')).toBe('10');
    expect(requested.searchParams.get('extension')).toBe('jpg');
    expect(requested.searchParams.has('page')).toBe(false);
    expect(requested.searchParams.has('selectedAssetIds')).toBe(false);

    afterExtension.categoryThree.checked = false;
    afterExtension.categoryFour.checked = true;
    afterExtension.filter.dispatch('change', { target: afterExtension.categoryFour });
    await flush();

    requested = new URL(windowObject.fetch.mock.calls[1][0]);
    expect(requested.searchParams.get('pageSize')).toBe('10');
    expect(requested.searchParams.get('category')).toBe('4');

    afterCategory.searchInput.value = 'needle';
    afterCategory.searchInput.dispatch('input');
    vi.advanceTimersByTime(350);
    await flush();

    expect(windowObject.fetch).toHaveBeenCalledTimes(3);
    requested = new URL(windowObject.fetch.mock.calls[2][0]);
    expect(requested.searchParams.get('pageSize')).toBe('10');
    expect(requested.searchParams.get('search')).toBe('needle');
  });

  it('handles Release Assets page size, pagination, reset, and views as live anchor/form navigation', async () => {
    const initial = makeReleaseAssetsPage({ extension: 'jpg', category: '4', search: 'needle', view: 'list' });
    const afterPageSize = makeReleaseAssetsPage({ extension: 'jpg', category: '4', search: 'needle', view: 'list', pageSize: '100' });
    const afterPagination = makeReleaseAssetsPage({ extension: 'jpg', category: '4', search: 'needle', view: 'list', pageSize: '100' });
    const afterReset = makeReleaseAssetsPage({ view: 'list', pageSize: '100' });
    const afterView = makeReleaseAssetsPage({ pageSize: '100' });
    const pages = new Map([
      ['after-page-size', afterPageSize.document],
      ['after-pagination', afterPagination.document],
      ['after-reset', afterReset.document],
      ['after-view', afterView.document],
    ]);
    const windowObject = makeWindow(initial.document);
    windowObject.location.href = 'http://creatorcrate.test/releases/7/assets?page=4';
    windowObject.location.pathname = '/releases/7/assets';
    windowObject.fetch
      .mockResolvedValueOnce(responseFor('after-page-size', 'http://creatorcrate.test/releases/7/assets?pageSize=100&search=needle&extension=jpg&category=4&view=list'))
      .mockResolvedValueOnce(responseFor('after-pagination', 'http://creatorcrate.test/releases/7/assets?view=list&pageSize=100&search=needle&extension=jpg&category=4&page=2'))
      .mockResolvedValueOnce(responseFor('after-reset', 'http://creatorcrate.test/releases/7/assets?view=list&pageSize=100'))
      .mockResolvedValueOnce(responseFor('after-view', 'http://creatorcrate.test/releases/7/assets?view=grid&pageSize=100'));
    windowObject.DOMParser = class DOMParserMock {
      parseFromString(text) { return pages.get(text) || makeNode({ tagName: 'document' }); }
    };

    expect(enhanceReleaseAssetsLiveFiltering(initial.document)).toBe(2);
    expect(initial.pageSizeForm.listeners).toHaveLength(2);
    initial.pageSize.value = '100';
    initial.pageSizeForm.dispatch('change', { target: initial.pageSize });
    await flush();

    let requested = new URL(windowObject.fetch.mock.calls[0][0]);
    expect(requested.searchParams.get('pageSize')).toBe('100');
    expect([...requested.searchParams.entries()]).toEqual([
      ['pageSize', '100'], ['search', 'needle'], ['extension', 'jpg'], ['category', '4'], ['view', 'list'],
    ]);
    expect(requested.searchParams.has('page')).toBe(false);
    expect(requested.searchParams.has('selectedAssetIds')).toBe(false);
    expect(initial.document.querySelector('[data-release-assets-live-region]')).toBe(afterPageSize.region);

    const paginationEvent = afterPageSize.next.dispatch('click');
    await flush();
    expect(paginationEvent.defaultPrevented).toBe(true);
    expect(windowObject.fetch.mock.calls[1][0]).toBe(new URL(afterPageSize.next.getAttribute('href'), windowObject.location.href).href);
    expect(initial.document.querySelector('[data-release-assets-live-region]')).toBe(afterPagination.region);

    const resetEvent = afterPagination.reset.dispatch('click');
    await flush();
    expect(resetEvent.defaultPrevented).toBe(true);
    expect(windowObject.fetch.mock.calls[2][0]).toBe(new URL(afterPagination.reset.getAttribute('href'), windowObject.location.href).href);
    expect(initial.document.querySelector('[data-release-assets-live-region]')).toBe(afterReset.region);

    const viewEvent = afterReset.grid.dispatch('click');
    await flush();
    expect(viewEvent.defaultPrevented).toBe(true);
    expect(windowObject.fetch.mock.calls[3][0]).toBe(new URL(afterReset.grid.getAttribute('href'), windowObject.location.href).href);
    expect(initial.document.querySelector('[data-release-assets-live-region]')).toBe(afterView.region);
    expect(afterView.pageSizeForm.listeners).toHaveLength(2);
    expect(afterView.region.listeners.filter(({ type }) => type === 'click')).toHaveLength(1);
    expect(windowObject.history.pushes).toHaveLength(4);
  });

  it('serializes Schedule All by removing an active Schedule parameter', async () => {
    const initial = makePage('/releases', { scheduleValue: 'today' });
    const cleared = makePage();
    const pages = new Map([['cleared', cleared.document]]);
    const windowObject = makeWindow(initial.document, pages);
    windowObject.fetch.mockResolvedValue(responseFor('cleared', 'http://creatorcrate.test/releases?project=7&sort=planned&order=asc'));

    enhanceReleasesLiveFiltering(initial.document);
    initial.schedule.value = '';
    initial.form.dispatch('change', { target: initial.schedule });
    await flush();

    const requested = new URL(windowObject.fetch.mock.calls[0][0]);
    expect(requested.searchParams.has('schedule')).toBe(false);
    expect(initial.document.querySelector('[data-releases-live-region]')).toBe(cleared.region);
  });

  it.each([
    ['Project', 'project'],
    ['Schedule', 'schedule'],
    ['Sort', 'sort'],
    ['Order', 'order'],
    ['Archived', 'archived'],
  ])('keeps immediate live filtering for the external %s control', async (_label, controlKey) => {
    const initial = makePage();
    const next = makePage();
    const pages = new Map([['next', next.document]]);
    const windowObject = makeWindow(initial.document, pages);
    windowObject.fetch.mockResolvedValue(responseFor('next', 'http://creatorcrate.test/releases'));
    enhanceReleasesLiveFiltering(initial.document);

    if (controlKey === 'archived') initial.archived.checked = true;
    initial.form.dispatch('change', { target: initial[controlKey] });
    await flush();

    expect(windowObject.fetch).toHaveBeenCalledTimes(1);
    expect(initial.document.querySelector('[data-releases-live-region]')).toBe(next.region);
  });

  it('serializes direct Archived toggles and preserves the checked state across replacement', async () => {
    const initial = makePage();
    const checked = makePage('/releases', { includeArchived: true });
    const unchecked = makePage();
    const pages = new Map([
      ['checked', checked.document],
      ['unchecked', unchecked.document],
    ]);
    const windowObject = makeWindow(initial.document, pages);
    windowObject.fetch
      .mockResolvedValueOnce(responseFor('checked', 'http://creatorcrate.test/releases?project=7&sort=planned&order=asc&includeArchived=1'))
      .mockResolvedValueOnce(responseFor('unchecked', 'http://creatorcrate.test/releases?project=7&sort=planned&order=asc'));

    expect(enhanceReleasesLiveFiltering(initial.document)).toBe(1);

    initial.archived.checked = true;
    initial.form.dispatch('change', { target: initial.archived });
    await flush();

    let requested = new URL(windowObject.fetch.mock.calls[0][0]);
    expect(requested.searchParams.get('includeArchived')).toBe('1');
    expect(initial.document.querySelector('[data-releases-live-region]')).toBe(checked.region);
    expect(checked.archived.checked).toBe(true);

    checked.archived.checked = false;
    initial.form.dispatch('change', { target: checked.archived });
    await flush();

    requested = new URL(windowObject.fetch.mock.calls[1][0]);
    expect(requested.searchParams.has('includeArchived')).toBe(false);
    expect(initial.document.querySelector('[data-releases-live-region]')).toBe(unchecked.region);
    expect(unchecked.archived.checked).toBe(false);
  });

  it('preserves an already-selected Project while another release filter changes and ignores Project search input events', async () => {
    const initial = makePage();
    const next = makePage();
    const pages = new Map([['next', next.document]]);
    const windowObject = makeWindow(initial.document, pages);
    windowObject.fetch.mockResolvedValue(responseFor('next', 'http://creatorcrate.test/releases?project=7&schedule=today&includeArchived=1'));

    expect(enhanceReleasesLiveFiltering(initial.document)).toBe(1);
    [initial.projectSummary, initial.scheduleDropdown, initial.sortDropdown, initial.orderDropdown]
      .forEach((control) => {
        const summary = control === initial.projectSummary ? control : control.querySelector('summary');
        expect(summary.getAttribute('aria-expanded')).toBe('false');
      });

    initial.projectSearch.value = 'alpha';
    initial.projectSearch.dispatch('input');
    initial.form.dispatch('change', { target: initial.projectSearch });
    await flush();
    expect(windowObject.fetch).not.toHaveBeenCalled();

    initial.archived.checked = true;
    initial.schedule.value = 'today';
    initial.form.dispatch('change', { target: initial.schedule });
    await flush();

    expect(windowObject.fetch).toHaveBeenCalledTimes(1);
    const requested = new URL(windowObject.fetch.mock.calls[0][0]);
    expect(requested.pathname).toBe('/releases');
    expect(requested.searchParams.get('project')).toBe('7');
    expect(requested.searchParams.get('schedule')).toBe('today');
    expect(requested.searchParams.get('includeArchived')).toBe('1');
    expect(requested.searchParams.has('page')).toBe(false);
    expect(windowObject.history.pushes).toHaveLength(1);
    expect(initial.form.submit).not.toHaveBeenCalled();
    expect(initial.document.querySelector('[data-releases-live-region]')).toBe(next.region);
    [next.projectSummary, next.scheduleDropdown, next.sortDropdown, next.orderDropdown]
      .forEach((control) => {
        const summary = control === next.projectSummary ? control : control.querySelector('summary');
        expect(summary.getAttribute('aria-expanded')).toBe('false');
      });
  });

  it('binds the external Release Management dialog once and reconciles filters, pagination, and URL Reset', async () => {
    const initial = makePage('/release-management', {
      dialogOpen: true,
      pageSize: '100',
      resetUrl: '/release-management?pageSize=100',
    });
    const filtered = makePage('/release-management', {
      dialogOpen: false,
      projectValue: '8',
      scheduleValue: 'today',
      sortValue: 'title',
      orderValue: 'desc',
      includeArchived: true,
      pageSize: '100',
    });
    const paged = makePage('/release-management', {
      projectValue: '8',
      scheduleValue: 'today',
      sortValue: 'title',
      orderValue: 'desc',
      includeArchived: true,
      pageSize: '100',
    });
    const reset = makePage('/release-management', {
      projectValue: '',
      scheduleValue: '',
      sortValue: 'updated',
      orderValue: 'asc',
      pageSize: '100',
    });
    const pages = new Map([
      ['filtered', filtered.document],
      ['paged', paged.document],
      ['reset', reset.document],
    ]);
    const windowObject = makeWindow(initial.document, pages);
    windowObject.location.href = 'http://creatorcrate.test/release-management?page=4';
    windowObject.location.pathname = '/release-management';
    windowObject.fetch
      .mockResolvedValueOnce(responseFor('filtered', 'http://creatorcrate.test/release-management?project=8&schedule=today&includeArchived=1&sort=title&order=desc&pageSize=100'))
      .mockResolvedValueOnce(responseFor('paged', 'http://creatorcrate.test/release-management?page=2'))
      .mockResolvedValueOnce(responseFor('reset', 'http://creatorcrate.test/release-management?sort=updated&order=asc&pageSize=100'));

    expect(enhanceReleasesLiveFiltering(initial.document)).toBe(1);
    expect(enhanceReleasesLiveFiltering(initial.document)).toBe(1);
    expect(initial.form.parentNode).toBe(initial.dialog);
    expect(initial.region.contains(initial.form)).toBe(false);
    expect(initial.form.listeners.filter(({ type }) => type === 'change')).toHaveLength(1);
    expect(initial.reset.listeners.filter(({ type }) => type === 'click')).toHaveLength(1);
    initial.archived.checked = true;
    initial.schedule.value = 'today';
    initial.sort.value = 'title';
    initial.order.value = 'desc';
    initial.projectDropdown.open = true;
    initial.projectSearch.selectionStart = 0;
    initial.projectSearch.selectionEnd = 0;
    initial.document.activeElement = initial.projectSearch;
    initial.form.dispatch('change', { target: initial.archived });
    await flush();

    let requested = new URL(windowObject.fetch.mock.calls[0][0]);
    expect(requested.pathname).toBe('/release-management');
    expect(requested.searchParams.get('project')).toBe('7');
    expect(requested.searchParams.get('schedule')).toBe('today');
    expect(requested.searchParams.get('includeArchived')).toBe('1');
    expect(requested.searchParams.get('sort')).toBe('title');
    expect(requested.searchParams.get('order')).toBe('desc');
    expect(requested.searchParams.get('pageSize')).toBe('100');
    expect(requested.searchParams.has('page')).toBe(false);
    expect(initial.document.querySelector('[data-releases-live-region]')).toBe(filtered.region);
    expect(initial.document.querySelector('[data-releases-filter]')).toBe(initial.form);
    expect(initial.dialog.open).toBe(true);
    expect(initial.form.contains(filtered.project)).toBe(true);
    expect(initial.form.contains(filtered.schedule)).toBe(true);
    expect(filtered.projectDropdown.open).toBe(true);
    expect(initial.document.activeElement).toBe(filtered.projectSearch);
    expect(initial.form.listeners.filter(({ type }) => type === 'change')).toHaveLength(1);

    const pageEvent = filtered.next.dispatch('click');
    await flush();
    expect(pageEvent.defaultPrevented).toBe(true);
    expect(windowObject.fetch.mock.calls[1][0]).toBe(new URL(filtered.next.getAttribute('href'), windowObject.location.href).href);
    expect(initial.document.querySelector('[data-releases-live-region]')).toBe(paged.region);

    const resetEvent = initial.reset.dispatch('click');
    await flush();
    expect(resetEvent.defaultPrevented).toBe(true);
    expect(windowObject.fetch.mock.calls[2][0]).toBe('http://creatorcrate.test/release-management?pageSize=100');
    expect(initial.document.querySelector('[data-releases-live-region]')).toBe(reset.region);
    expect(initial.form.contains(reset.sort)).toBe(true);
    expect(reset.sort.value).toBe('updated');
    expect(reset.order.value).toBe('asc');
    expect(initial.form.querySelector('input[name="pageSize"]')?.value).toBe('100');
    expect(initial.dialog.open).toBe(true);
    expect(initial.form.listeners).toHaveLength(2);
    expect(reset.next.listeners.filter(({ type }) => type === 'click')).toHaveLength(1);
    expect(initial.reset.listeners.filter(({ type }) => type === 'click')).toHaveLength(1);
    expect(initial.form.submit).not.toHaveBeenCalled();
    expect(initial.resetForm.submit).toBeUndefined();
    expect(windowObject.history.pushes).toHaveLength(3);
  });

  it('suppresses stale responses, reconciles Back/Forward dialog state, and falls back on failure', async () => {
    const initial = makePage('/releases', { dialogOpen: true });
    const first = makePage('/releases', { scheduleValue: 'today' });
    const second = makePage('/releases', { scheduleValue: 'upcoming', sortValue: 'title' });
    const restoredBack = makePage('/releases', { scheduleValue: 'today', sortValue: 'planned' });
    const restoredForward = makePage('/releases', { scheduleValue: 'upcoming', sortValue: 'title' });
    const pages = new Map([
      ['first', first.document],
      ['second', second.document],
      ['restored-back', restoredBack.document],
      ['restored-forward', restoredForward.document],
    ]);
    const windowObject = makeWindow(initial.document, pages);
    const requests = [];
    windowObject.fetch.mockImplementation((url) => new Promise((resolve) => requests.push({ url, resolve })));
    enhanceReleasesLiveFiltering(initial.document);

    initial.schedule.value = 'today';
    initial.form.dispatch('change', { target: initial.schedule });
    initial.schedule.value = 'upcoming';
    initial.form.dispatch('change', { target: initial.schedule });
    requests[1].resolve(responseFor('second', 'http://creatorcrate.test/releases?schedule=upcoming'));
    await flush();
    requests[0].resolve(responseFor('first', 'http://creatorcrate.test/releases?schedule=today'));
    await flush();
    expect(initial.document.querySelector('[data-releases-live-region]')).toBe(second.region);
    expect(initial.form.contains(second.schedule)).toBe(true);
    expect(second.schedule.value).toBe('upcoming');
    expect(initial.dialog.open).toBe(true);

    windowObject.location.href = 'http://creatorcrate.test/releases?schedule=today';
    windowObject.location.pathname = '/releases';
    windowObject.fetch.mockResolvedValueOnce(responseFor('restored-back', windowObject.location.href));
    windowObject.dispatch('popstate');
    await flush();
    expect(initial.document.querySelector('[data-releases-live-region]')).toBe(restoredBack.region);
    expect(initial.form.contains(restoredBack.schedule)).toBe(true);
    expect(restoredBack.schedule.value).toBe('today');
    expect(restoredBack.sort.value).toBe('planned');
    expect(initial.dialog.open).toBe(true);

    windowObject.location.href = 'http://creatorcrate.test/releases?schedule=upcoming&sort=title';
    windowObject.location.pathname = '/releases';
    windowObject.fetch.mockResolvedValueOnce(responseFor('restored-forward', windowObject.location.href));
    windowObject.dispatch('popstate');
    await flush();
    expect(initial.document.querySelector('[data-releases-live-region]')).toBe(restoredForward.region);
    expect(initial.form.contains(restoredForward.schedule)).toBe(true);
    expect(restoredForward.schedule.value).toBe('upcoming');
    expect(restoredForward.sort.value).toBe('title');
    expect(initial.dialog.open).toBe(true);
    expect(windowObject.history.pushes).toHaveLength(1);

    const failed = makePage();
    const failedWindow = makeWindow(failed.document);
    failedWindow.fetch.mockRejectedValue(new Error('offline'));
    enhanceReleasesLiveFiltering(failed.document);
    failed.form.dispatch('change', { target: failed.schedule });
    await flush();
    expect(failed.form.submit).toHaveBeenCalledTimes(1);
  });
});
