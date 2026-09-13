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
  if (start >= 0) {
    const markup = RELEASE_ASSETS_TEMPLATE.slice(start, RELEASE_ASSETS_TEMPLATE.indexOf('</select>', start));
    return [...markup.matchAll(/<option value="(\d+)"/g)].map(([, value]) => value);
  }
  const macroStart = RELEASE_ASSETS_TEMPLATE.indexOf(`id: "${id}"`);
  const markup = RELEASE_ASSETS_TEMPLATE.slice(
    macroStart,
    RELEASE_ASSETS_TEMPLATE.indexOf('}) }}', macroStart),
  );
  return [...markup.matchAll(/\{ value: "(\d+)", label:/g)].map(([, value]) => value);
}

const FILTER_PAGE_SIZE_OPTIONS = templatePageSizeOptions('release-asset-page-size-dropdown');
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
  dialogOpen = false, assets = [{ id: '99', selected: true }], offPageSelectedIds = [],
  persistedSelectedIds = [...assets.filter((asset) => asset.selected).map((asset) => String(asset.id)), ...offPageSelectedIds],
  readOnly = false,
} = {}) {
  const document = makeNode({ tagName: 'document' });
  document.nodeType = 9;
  document.ownerDocument = document;
  document.activeElement = null;
  document.createElement = (tagName) => makeNode({ tagName });
  const region = makeNode({ attrs: { 'data-release-assets-live-region': '' } });
  const status = makeNode({ attrs: { 'data-release-assets-live-status': '' } });
  const dialog = makeNode({ tagName: 'dialog', attrs: { id: 'release-assets-filter-dialog', 'data-app-dialog': '' } });
  dialog.open = dialogOpen;
  const filterTrigger = makeNode({
    tagName: 'a',
    attrs: { href: '#release-assets-filter-dialog', 'data-dialog-open': 'release-assets-filter-dialog' },
  });
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
  const extensionAll = add({ name: 'extension', type: 'radio', value: '', 'data-release-assets-live-filter-control': '' }, '', extension === '');
  const extensionPng = add({ name: 'extension', type: 'radio', value: 'png', 'data-release-assets-live-filter-control': '' }, 'png', extension === 'png');
  const extensionJpg = add({ name: 'extension', type: 'radio', value: 'jpg', 'data-release-assets-live-filter-control': '' }, 'jpg', extension === 'jpg');
  const categoryAll = add({ name: 'category', type: 'radio', value: '', 'data-release-assets-live-filter-control': '' }, '', category === '');
  const categoryThree = add({ name: 'category', type: 'radio', value: '3', 'data-release-assets-live-filter-control': '' }, '3', category === '3');
  const categoryFour = add({ name: 'category', type: 'radio', value: '4', 'data-release-assets-live-filter-control': '' }, '4', category === '4');
  const selection = makeNode({
    tagName: 'form',
    attrs: {
      action: '/releases/7/assets', method: 'post', id: 'release-assets-form', 'data-asset-selection-form': '',
    },
  });
  const hiddenMembership = makeNode({ tagName: 'span', attrs: { 'data-release-assets-hidden-membership': '' } });
  offPageSelectedIds.forEach((assetId) => hiddenMembership.appendChild(makeNode({
    tagName: 'input', attrs: { name: 'selectedAssetIds', type: 'hidden', value: String(assetId) }, value: String(assetId),
  })));
  selection.appendChild(hiddenMembership);
  const persistedMembership = makeNode({ tagName: 'span', attrs: { 'data-release-assets-persisted-membership': '' } });
  persistedSelectedIds.forEach((assetId) => persistedMembership.appendChild(makeNode({
    tagName: 'input', attrs: { type: 'hidden', 'data-release-assets-persisted-id': '', value: String(assetId) }, value: String(assetId),
  })));
  selection.appendChild(persistedMembership);
  const disclosure = makeNode({
    tagName: 'details',
    attrs: { id: 'release-extension-filter', 'data-asset-viewer-filter-disclosure': '' },
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
  dialog.appendChild(filter);
  filter.appendChild(reset);
  filter.appendChild(disclosure);
  region.appendChild(status);
  const membershipCheckboxes = (readOnly ? [] : assets).map(({ id, selected = false }) => {
    const checkbox = makeNode({
      tagName: 'input',
      attrs: {
        name: 'selectedAssetIds', type: 'checkbox', value: String(id), form: 'release-assets-form',
      },
      value: String(id),
      checked: selected,
    });
    region.appendChild(checkbox);
    return checkbox;
  });
  region.appendChild(viewNav);
  if (!readOnly) {
    region.appendChild(filterTrigger);
    region.appendChild(pagination);
    region.appendChild(pageSizeForm);
    document.appendChild(selection);
  }
  document.appendChild(region);
  if (!readOnly) document.appendChild(dialog);
  return {
    document, region, status, dialog, filterTrigger, filter, disclosure, view: viewField, page, filterPageSize, pageSize,
    searchInput, extensionAll, extensionPng, extensionJpg, categoryAll, categoryThree, categoryFour, selection, viewNav,
    grid, list, pagination, next, pageSizeForm, reset, hiddenMembership, membershipCheckboxes,
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
        const formId = form.id || form.getAttribute?.('id');
        const candidates = form.ownerDocument?.querySelectorAll?.('input, select, textarea')
          || form.querySelectorAll('input, select, textarea');
        this.fields = candidates
          .filter((field) => (
            form.contains?.(field) || field.form === form
              || (Boolean(formId) && field.getAttribute?.('form') === formId)
          ))
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

function releaseMembershipPayload(windowObject, selectionForm) {
  return Array.from(new windowObject.FormData(selectionForm).entries())
    .filter(([name]) => name === 'selectedAssetIds')
    .map(([, assetId]) => assetId);
}

function releaseHiddenMembership(selectionForm) {
  return selectionForm.querySelectorAll(
    '[data-release-assets-hidden-membership] input[type="hidden"][name="selectedAssetIds"]',
  ).map((input) => input.value);
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

  it('initializes an ordinary persisted page without membership overrides', () => {
    const initial = makeReleaseAssetsPage({
      assets: [{ id: '1', selected: true }, { id: '2', selected: false }],
      persistedSelectedIds: ['1'],
    });
    const windowObject = makeWindow(initial.document);
    windowObject.location.href = 'http://creatorcrate.test/releases/7/assets';
    windowObject.location.pathname = '/releases/7/assets';

    enhanceReleaseAssetsLiveFiltering(initial.document);

    const selectionState = initial.document.__creatorCrateReleaseAssetsLiveFiltering.releaseAssetsSelection;
    expect(selectionState.authoritativeSelected).toEqual(new Set(['1']));
    expect(selectionState.overrides).toEqual(new Map());
    expect(releaseMembershipPayload(windowObject, initial.selection)).toEqual(['1']);
  });

  it('preserves an explicit selection while hidden and when the asset returns', async () => {
    const initial = makeReleaseAssetsPage({ assets: [{ id: '1', selected: false }] });
    const hidden = makeReleaseAssetsPage({ assets: [{ id: '2', selected: false }] });
    const returned = makeReleaseAssetsPage({ assets: [{ id: '1', selected: false }] });
    const pages = new Map([['hidden', hidden.document], ['returned', returned.document]]);
    const windowObject = makeWindow(initial.document, pages);
    windowObject.location.href = 'http://creatorcrate.test/releases/7/assets';
    windowObject.location.pathname = '/releases/7/assets';
    windowObject.fetch
      .mockResolvedValueOnce(responseFor('hidden', 'http://creatorcrate.test/releases/7/assets?page=2'))
      .mockResolvedValueOnce(responseFor('returned', 'http://creatorcrate.test/releases/7/assets'));
    enhanceReleaseAssetsLiveFiltering(initial.document);

    initial.membershipCheckboxes[0].checked = true;
    initial.membershipCheckboxes[0].dispatch('change');
    initial.next.dispatch('click');
    await flush();

    expect(releaseHiddenMembership(initial.selection)).toEqual(['1']);
    hidden.next.dispatch('click');
    await flush();

    expect(returned.membershipCheckboxes[0].checked).toBe(true);
    expect(releaseHiddenMembership(initial.selection)).toEqual([]);
    expect(releaseMembershipPayload(windowObject, initial.selection)).toEqual(['1']);
  });

  it('preserves an explicit deselection while hidden and when the asset returns', async () => {
    const initial = makeReleaseAssetsPage({ assets: [{ id: '1', selected: true }] });
    const hidden = makeReleaseAssetsPage({ assets: [{ id: '2', selected: false }], offPageSelectedIds: ['1'] });
    const returned = makeReleaseAssetsPage({ assets: [{ id: '1', selected: true }] });
    const pages = new Map([['hidden-selected', hidden.document], ['returned-selected', returned.document]]);
    const windowObject = makeWindow(initial.document, pages);
    windowObject.location.href = 'http://creatorcrate.test/releases/7/assets';
    windowObject.location.pathname = '/releases/7/assets';
    windowObject.fetch
      .mockResolvedValueOnce(responseFor('hidden-selected', 'http://creatorcrate.test/releases/7/assets?page=2'))
      .mockResolvedValueOnce(responseFor('returned-selected', 'http://creatorcrate.test/releases/7/assets'));
    enhanceReleaseAssetsLiveFiltering(initial.document);

    initial.membershipCheckboxes[0].checked = false;
    initial.membershipCheckboxes[0].dispatch('change');
    initial.next.dispatch('click');
    await flush();

    expect(releaseHiddenMembership(initial.selection)).toEqual([]);
    hidden.next.dispatch('click');
    await flush();

    expect(returned.membershipCheckboxes[0].checked).toBe(false);
    expect(releaseMembershipPayload(windowObject, initial.selection)).toEqual([]);
  });

  it('preserves draft membership across pages and page-size replacements', async () => {
    const initial = makeReleaseAssetsPage({ assets: [{ id: '1', selected: false }] });
    const secondPage = makeReleaseAssetsPage({ assets: [{ id: '2', selected: false }] });
    const resized = makeReleaseAssetsPage({ assets: [{ id: '3', selected: false }], pageSize: '25' });
    const returned = makeReleaseAssetsPage({ assets: [{ id: '1', selected: false }], pageSize: '25' });
    const pages = new Map([
      ['second-page', secondPage.document], ['resized', resized.document], ['page-return', returned.document],
    ]);
    const windowObject = makeWindow(initial.document, pages);
    windowObject.location.href = 'http://creatorcrate.test/releases/7/assets';
    windowObject.location.pathname = '/releases/7/assets';
    windowObject.fetch
      .mockResolvedValueOnce(responseFor('second-page', 'http://creatorcrate.test/releases/7/assets?page=2'))
      .mockResolvedValueOnce(responseFor('resized', 'http://creatorcrate.test/releases/7/assets?pageSize=25'))
      .mockResolvedValueOnce(responseFor('page-return', 'http://creatorcrate.test/releases/7/assets?pageSize=25&page=1'));
    enhanceReleaseAssetsLiveFiltering(initial.document);

    initial.membershipCheckboxes[0].checked = true;
    initial.membershipCheckboxes[0].dispatch('change');
    initial.next.dispatch('click');
    await flush();
    secondPage.pageSize.value = '25';
    secondPage.pageSizeForm.dispatch('change', { target: secondPage.pageSize });
    await flush();
    resized.next.dispatch('click');
    await flush();

    expect(returned.membershipCheckboxes[0].checked).toBe(true);
    expect(releaseMembershipPayload(windowObject, initial.selection)).toEqual(['1']);
  });

  it('preserves draft membership through grid-list-grid replacements', async () => {
    const initial = makeReleaseAssetsPage({ assets: [{ id: '1', selected: false }], view: 'grid' });
    const list = makeReleaseAssetsPage({ assets: [{ id: '1', selected: false }], view: 'list' });
    const grid = makeReleaseAssetsPage({ assets: [{ id: '1', selected: false }], view: 'grid' });
    const pages = new Map([['list-view', list.document], ['grid-view', grid.document]]);
    const windowObject = makeWindow(initial.document, pages);
    windowObject.location.href = 'http://creatorcrate.test/releases/7/assets';
    windowObject.location.pathname = '/releases/7/assets';
    windowObject.fetch
      .mockResolvedValueOnce(responseFor('list-view', 'http://creatorcrate.test/releases/7/assets?view=list'))
      .mockResolvedValueOnce(responseFor('grid-view', 'http://creatorcrate.test/releases/7/assets?view=grid'));
    enhanceReleaseAssetsLiveFiltering(initial.document);

    initial.membershipCheckboxes[0].checked = true;
    initial.membershipCheckboxes[0].dispatch('change');
    initial.list.dispatch('click');
    await flush();
    list.grid.dispatch('click');
    await flush();

    expect(grid.membershipCheckboxes[0].checked).toBe(true);
    expect(releaseMembershipPayload(windowObject, initial.selection)).toEqual(['1']);
  });

  it('keeps a newer membership change authoritative over an in-flight response', async () => {
    const initial = makeReleaseAssetsPage({ assets: [{ id: '1', selected: false }] });
    const returned = makeReleaseAssetsPage({ assets: [{ id: '1', selected: false }] });
    const pages = new Map([['race-result', returned.document]]);
    const windowObject = makeWindow(initial.document, pages);
    windowObject.location.href = 'http://creatorcrate.test/releases/7/assets';
    windowObject.location.pathname = '/releases/7/assets';
    let resolveRequest;
    windowObject.fetch.mockReturnValue(new Promise((resolve) => { resolveRequest = resolve; }));
    enhanceReleaseAssetsLiveFiltering(initial.document);

    initial.next.dispatch('click');
    initial.membershipCheckboxes[0].checked = true;
    initial.membershipCheckboxes[0].dispatch('change');
    resolveRequest(responseFor('race-result', 'http://creatorcrate.test/releases/7/assets?page=2'));
    await flush();

    expect(returned.membershipCheckboxes[0].checked).toBe(true);
    expect(releaseMembershipPayload(windowObject, initial.selection)).toEqual(['1']);
  });

  it('reconciles repeated replacements without duplicate hidden IDs or listeners', async () => {
    const initial = makeReleaseAssetsPage({ assets: [{ id: '1', selected: false }] });
    const hidden = makeReleaseAssetsPage({ assets: [{ id: '2', selected: false }] });
    const hiddenAgain = makeReleaseAssetsPage({ assets: [{ id: '3', selected: false }] });
    const pages = new Map([['hidden-once', hidden.document], ['hidden-twice', hiddenAgain.document]]);
    const windowObject = makeWindow(initial.document, pages);
    windowObject.location.href = 'http://creatorcrate.test/releases/7/assets';
    windowObject.location.pathname = '/releases/7/assets';
    windowObject.fetch
      .mockResolvedValueOnce(responseFor('hidden-once', 'http://creatorcrate.test/releases/7/assets?page=2'))
      .mockResolvedValueOnce(responseFor('hidden-twice', 'http://creatorcrate.test/releases/7/assets?page=3'));
    enhanceReleaseAssetsLiveFiltering(initial.document);
    const initialChangeListenerCount = initial.document.listeners.filter(({ type }) => type === 'change').length;

    initial.membershipCheckboxes[0].checked = true;
    initial.membershipCheckboxes[0].dispatch('change');
    initial.next.dispatch('click');
    await flush();
    hidden.next.dispatch('click');
    await flush();

    expect(releaseHiddenMembership(initial.selection)).toEqual(['1']);
    expect(initial.document.listeners.filter(({ type }) => type === 'change')).toHaveLength(initialChangeListenerCount);
    expect(hiddenAgain.membershipCheckboxes[0].listeners.filter(({ type }) => type === 'change')).toHaveLength(1);
  });

  it('lets untouched assets follow authoritative rendered membership', async () => {
    const initial = makeReleaseAssetsPage({ assets: [{ id: '1', selected: true }] });
    const authoritative = makeReleaseAssetsPage({ assets: [{ id: '1', selected: false }] });
    const pages = new Map([['authoritative', authoritative.document]]);
    const windowObject = makeWindow(initial.document, pages);
    windowObject.location.href = 'http://creatorcrate.test/releases/7/assets';
    windowObject.location.pathname = '/releases/7/assets';
    windowObject.fetch.mockResolvedValue(responseFor(
      'authoritative', 'http://creatorcrate.test/releases/7/assets?page=2',
    ));
    enhanceReleaseAssetsLiveFiltering(initial.document);

    initial.next.dispatch('click');
    await flush();

    expect(authoritative.membershipCheckboxes[0].checked).toBe(false);
    expect(releaseMembershipPayload(windowObject, initial.selection)).toEqual([]);
  });

  it('preserves submitted membership from a 422 document across a persisted live replacement', async () => {
    const validation = makeReleaseAssetsPage({
      assets: [{ id: '1', selected: true }, { id: '2', selected: false }],
      persistedSelectedIds: ['2'],
    });
    const persisted = makeReleaseAssetsPage({
      assets: [{ id: '1', selected: false }, { id: '2', selected: true }],
      persistedSelectedIds: ['2'],
    });
    const pages = new Map([['persisted-live-result', persisted.document]]);
    const windowObject = makeWindow(validation.document, pages);
    windowObject.location.href = 'http://creatorcrate.test/releases/7/assets';
    windowObject.location.pathname = '/releases/7/assets';
    windowObject.fetch.mockResolvedValue(responseFor(
      'persisted-live-result', 'http://creatorcrate.test/releases/7/assets?page=2',
    ));

    enhanceReleaseAssetsLiveFiltering(validation.document);

    const selectionState = validation.document.__creatorCrateReleaseAssetsLiveFiltering.releaseAssetsSelection;
    expect(selectionState.authoritativeSelected).toEqual(new Set(['2']));
    expect(selectionState.overrides).toEqual(new Map([['1', true], ['2', false]]));
    expect(releaseMembershipPayload(windowObject, validation.selection)).toEqual(['1']);

    validation.next.dispatch('click');
    await flush();

    expect(persisted.membershipCheckboxes[0].checked).toBe(true);
    expect(persisted.membershipCheckboxes[1].checked).toBe(false);
    expect(releaseMembershipPayload(windowObject, validation.selection)).toEqual(['1']);
    expect(new Set(releaseMembershipPayload(windowObject, validation.selection)).size).toBe(1);
  });

  it('submits exact membership with no duplicates and explicit deselections absent', () => {
    const initial = makeReleaseAssetsPage({
      assets: [{ id: '1', selected: true }, { id: '3', selected: false }],
      offPageSelectedIds: ['2'],
    });
    const windowObject = makeWindow(initial.document);
    windowObject.location.href = 'http://creatorcrate.test/releases/7/assets';
    windowObject.location.pathname = '/releases/7/assets';
    enhanceReleaseAssetsLiveFiltering(initial.document);

    initial.membershipCheckboxes[0].checked = false;
    initial.membershipCheckboxes[0].dispatch('change');
    initial.membershipCheckboxes[1].checked = true;
    initial.membershipCheckboxes[1].dispatch('change');

    expect(releaseHiddenMembership(initial.selection)).toEqual(['2']);
    expect(releaseMembershipPayload(windowObject, initial.selection)).toEqual(['2', '3']);
    expect(new Set(releaseMembershipPayload(windowObject, initial.selection)).size).toBe(2);
  });

  it('does not introduce editable draft membership on read-only Release Assets', () => {
    const page = makeReleaseAssetsPage({ readOnly: true, assets: [{ id: '1', selected: true }] });
    makeWindow(page.document);

    expect(enhanceReleaseAssetsLiveFiltering(page.document)).toBe(0);
    expect(page.document.querySelector('#release-assets-form')).toBe(null);
    expect(page.membershipCheckboxes).toEqual([]);
    expect(page.document.__creatorCrateReleaseAssetsLiveFiltering.releaseAssetsSelection).toBeUndefined();
    expect(page.document.listeners).toEqual([]);
  });

  it('filters Release Assets immediately, preserves sibling state, and rebinds once per replacement', async () => {
    vi.useFakeTimers();
    const initial = makeReleaseAssetsPage({ dialogOpen: true });
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
    expect(initial.filter.listeners).toHaveLength(3);
    expect(initial.filter.listeners.filter(({ type }) => type === 'input')).toHaveLength(1);
    expect(initial.grid.listeners.filter(({ type }) => type === 'click')).toHaveLength(1);
    expect(enhanceReleaseAssetsLiveFiltering(initial.document)).toBe(2);
    expect(initial.filter.listeners).toHaveLength(3);
    expect(initial.filter.listeners.filter(({ type }) => type === 'input')).toHaveLength(1);

    initial.extensionPng.checked = false;
    initial.extensionJpg.checked = true;
    initial.disclosure.open = true;
    initial.extensionJpg.focus();
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
    expect(initial.document.querySelector('[data-release-assets-live-filter]')).toBe(initial.filter);
    expect(initial.dialog.open).toBe(true);
    expect(initial.filter.contains(afterExtension.extensionJpg)).toBe(true);
    expect(afterExtension.disclosure.open).toBe(true);
    expect(initial.document.activeElement).toBe(afterExtension.extensionJpg);
    expect(initial.filter.listeners).toHaveLength(3);
    expect(initial.filter.listeners.filter(({ type }) => type === 'input')).toHaveLength(1);
    expect(afterExtension.grid.listeners.filter(({ type }) => type === 'click')).toHaveLength(1);

    afterExtension.categoryThree.checked = false;
    afterExtension.categoryFour.checked = true;
    initial.filter.dispatch('change', { target: afterExtension.categoryFour });
    await flush();

    expect(windowObject.fetch).toHaveBeenCalledTimes(2);
    requested = new URL(windowObject.fetch.mock.calls[1][0]);
    expect(requested.searchParams.get('extension')).toBe('jpg');
    expect(requested.searchParams.get('category')).toBe('4');
    expect(requested.searchParams.has('selectedAssetIds')).toBe(false);

    afterCategory.searchInput.value = 'needle';
    initial.filter.dispatch('input', { target: afterCategory.searchInput });
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
    expect(initial.filter.listeners).toHaveLength(3);
    expect(initial.filter.listeners.filter(({ type }) => type === 'input')).toHaveLength(1);

    afterSearch.categoryFour.checked = false;
    afterSearch.categoryThree.checked = true;
    initial.filter.dispatch('change', { target: afterSearch.categoryThree });
    await flush();
    expect(windowObject.fetch).toHaveBeenCalledTimes(4);
  });

  it('applies the explicit All extension and category options immediately', async () => {
    const initial = makeReleaseAssetsPage({ extension: 'jpg', category: '4' });
    const afterExtensionReset = makeReleaseAssetsPage({ extension: '', category: '4' });
    const afterCategoryReset = makeReleaseAssetsPage({ extension: '', category: '' });
    const pages = new Map([
      ['after-extension-reset', afterExtensionReset.document],
      ['after-category-reset', afterCategoryReset.document],
    ]);
    const windowObject = makeWindow(initial.document, pages);
    windowObject.location.href = 'http://creatorcrate.test/releases/7/assets?extension=jpg&category=4';
    windowObject.location.pathname = '/releases/7/assets';
    windowObject.fetch
      .mockResolvedValueOnce(responseFor('after-extension-reset', 'http://creatorcrate.test/releases/7/assets?category=4'))
      .mockResolvedValueOnce(responseFor('after-category-reset', 'http://creatorcrate.test/releases/7/assets'));
    enhanceReleaseAssetsLiveFiltering(initial.document);

    initial.extensionJpg.checked = false;
    initial.extensionAll.checked = true;
    initial.filter.dispatch('change', { target: initial.extensionAll });
    await flush();

    let requested = new URL(windowObject.fetch.mock.calls[0][0]);
    expect(requested.searchParams.has('extension')).toBe(false);
    expect(requested.searchParams.get('category')).toBe('4');

    afterExtensionReset.categoryFour.checked = false;
    afterExtensionReset.categoryAll.checked = true;
    initial.filter.dispatch('change', { target: afterExtensionReset.categoryAll });
    await flush();

    requested = new URL(windowObject.fetch.mock.calls[1][0]);
    expect(requested.searchParams.has('extension')).toBe(false);
    expect(requested.searchParams.has('category')).toBe(false);
    expect(initial.filter.listeners.filter(({ type }) => type === 'change')).toHaveLength(1);
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
    initial.filter.dispatch('change', { target: afterExtension.categoryFour });
    await flush();

    requested = new URL(windowObject.fetch.mock.calls[1][0]);
    expect(requested.searchParams.get('pageSize')).toBe('10');
    expect(requested.searchParams.get('category')).toBe('4');

    afterCategory.searchInput.value = 'needle';
    initial.filter.dispatch('input', { target: afterCategory.searchInput });
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
    expect(afterView.grid.listeners.filter(({ type }) => type === 'click')).toHaveLength(1);
    expect(windowObject.history.pushes).toHaveLength(4);
  });

  it('suppresses stale Release Assets responses while keeping the external dialog authoritative', async () => {
    const initial = makeReleaseAssetsPage({ dialogOpen: true });
    const stale = makeReleaseAssetsPage({ extension: 'jpg', category: '3' });
    const latest = makeReleaseAssetsPage({ extension: 'jpg', category: '4' });
    const pages = new Map([
      ['stale', stale.document],
      ['latest', latest.document],
    ]);
    const windowObject = makeWindow(initial.document, pages);
    windowObject.location.href = 'http://creatorcrate.test/releases/7/assets';
    windowObject.location.pathname = '/releases/7/assets';
    const requests = [];
    windowObject.fetch.mockImplementation((url) => new Promise((resolve) => requests.push({ url, resolve })));

    enhanceReleaseAssetsLiveFiltering(initial.document);
    initial.extensionPng.checked = false;
    initial.extensionJpg.checked = true;
    initial.filter.dispatch('change', { target: initial.extensionJpg });
    initial.categoryThree.checked = false;
    initial.categoryFour.checked = true;
    initial.filter.dispatch('change', { target: initial.categoryFour });

    requests[1].resolve(responseFor('latest', 'http://creatorcrate.test/releases/7/assets?extension=jpg&category=4'));
    await flush();
    requests[0].resolve(responseFor('stale', 'http://creatorcrate.test/releases/7/assets?extension=jpg&category=3'));
    await flush();

    expect(initial.document.querySelector('[data-release-assets-live-region]')).toBe(latest.region);
    expect(initial.filter.contains(latest.categoryFour)).toBe(true);
    expect(initial.filter.contains(stale.categoryThree)).toBe(false);
    expect(initial.dialog.open).toBe(true);
    expect(windowObject.history.pushes).toHaveLength(1);
  });

  it('uses canonical response URLs, reconciles Back/Forward, and keeps the dialog usable after errors', async () => {
    const initial = makeReleaseAssetsPage({ dialogOpen: true });
    const canonical = makeReleaseAssetsPage({ extension: 'jpg', category: '4', pageSize: '25' });
    const restored = makeReleaseAssetsPage({ extension: 'png', category: '3', search: 'back', pageSize: '50' });
    const retried = makeReleaseAssetsPage({ extension: 'jpg', category: '3', pageSize: '50' });
    const pages = new Map([
      ['canonical', canonical.document],
      ['restored', restored.document],
      ['retried', retried.document],
    ]);
    const windowObject = makeWindow(initial.document, pages);
    windowObject.location.href = 'http://creatorcrate.test/releases/7/assets';
    windowObject.location.pathname = '/releases/7/assets';
    windowObject.location.assign = vi.fn();
    const canonicalUrl = 'http://creatorcrate.test/releases/7/assets?view=grid&pageSize=25&extension=jpg&category=4';
    windowObject.fetch
      .mockResolvedValueOnce(responseFor('canonical', canonicalUrl))
      .mockResolvedValueOnce(responseFor('restored', 'http://creatorcrate.test/releases/7/assets?search=back'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(responseFor('retried', 'http://creatorcrate.test/releases/7/assets?extension=jpg'));

    enhanceReleaseAssetsLiveFiltering(initial.document);
    initial.membershipCheckboxes[0].checked = false;
    initial.membershipCheckboxes[0].dispatch('change');
    initial.extensionPng.checked = false;
    initial.extensionJpg.checked = true;
    initial.filter.dispatch('change', { target: initial.extensionJpg });
    await flush();

    expect(windowObject.history.pushes).toEqual([
      expect.objectContaining({ url: canonicalUrl }),
    ]);
    expect(initial.document.querySelector('[data-release-assets-live-filter]')).toBe(initial.filter);
    expect(initial.filter.contains(canonical.categoryFour)).toBe(true);
    expect(canonical.filterPageSize.value).toBe('25');
    expect(canonical.membershipCheckboxes[0].checked).toBe(false);
    expect(initial.dialog.open).toBe(true);

    windowObject.location.href = 'http://creatorcrate.test/releases/7/assets?search=back';
    windowObject.location.pathname = '/releases/7/assets';
    windowObject.dispatch('popstate');
    await flush();

    expect(initial.document.querySelector('[data-release-assets-live-region]')).toBe(restored.region);
    expect(initial.filter.contains(restored.searchInput)).toBe(true);
    expect(restored.searchInput.value).toBe('back');
    expect(restored.membershipCheckboxes[0].checked).toBe(false);
    expect(releaseMembershipPayload(windowObject, initial.selection)).toEqual([]);
    expect(initial.dialog.open).toBe(true);

    restored.categoryThree.checked = false;
    restored.categoryFour.checked = true;
    initial.filter.dispatch('change', { target: restored.categoryFour });
    await flush();

    expect(windowObject.location.assign).not.toHaveBeenCalled();
    expect(restored.status.textContent).toBe('Could not update Release Assets. Change the filters to try again.');
    expect(restored.region.getAttribute('data-release-assets-live-state')).toBe('error');
    expect(initial.dialog.open).toBe(true);
    expect(initial.filter.listeners.filter(({ type }) => type === 'change')).toHaveLength(1);

    restored.categoryFour.checked = false;
    restored.extensionPng.checked = false;
    restored.extensionJpg.checked = true;
    initial.filter.dispatch('change', { target: restored.extensionJpg });
    await flush();

    expect(initial.document.querySelector('[data-release-assets-live-region]')).toBe(retried.region);
    expect(initial.dialog.open).toBe(true);
    expect(windowObject.fetch).toHaveBeenCalledTimes(4);
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
