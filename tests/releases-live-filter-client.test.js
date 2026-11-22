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
    return [...markup.matchAll(/<option value="(\d+|all)"/g)].map(([, value]) => value);
  }
  const macroStart = RELEASE_ASSETS_TEMPLATE.indexOf(`id: "${id}"`);
  const markup = RELEASE_ASSETS_TEMPLATE.slice(
    macroStart,
    RELEASE_ASSETS_TEMPLATE.indexOf('}) }}', macroStart),
  );
  return [...markup.matchAll(/\{ value: "(\d+|all)", label:/g)].map(([, value]) => value);
}

const FILTER_PAGE_SIZE_OPTIONS = templatePageSizeOptions('release-asset-page-size-dropdown');
const PAGE_SIZE_FORM_OPTIONS = templatePageSizeOptions('page-size-dropdown');

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
    getAttributeNames() { return [...attributes.keys()]; },
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
  assetValue = null,
} = {}) {
  const form = makeNode({
    tagName: 'form',
    attrs: { action, method: 'get', 'data-releases-filter': '' },
  });
  form.submit = vi.fn();
  if (assetValue !== null) {
    form.appendChild(makeNode({
      tagName: 'input',
      attrs: { name: 'asset', type: 'hidden' },
      value: String(assetValue),
    }));
  }
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
  const defaultsForm = options.defaultsAction
    ? makeNode({ tagName: 'form', attrs: { id: 'releases-defaults-form', method: 'post', action: options.defaultsAction } })
    : null;
  if (defaultsForm) document.appendChild(defaultsForm);
  return { document, region, status, dialog, resetForm, reset, pagination, next, defaultsForm, ...formParts };
}

function makeReleaseAssetsPage({
  extension = 'png', category = '3', search = '', view = 'grid', pageSize: selectedPageSize = '50',
  dialogOpen = false, assets = [{ id: '99', selected: true }], offPageSelectedIds = [],
  persistedSelectedIds = [...assets.filter((asset) => asset.selected).map((asset) => String(asset.id)), ...offPageSelectedIds],
  readOnly = false, reEnhancementSurface = false, roleAutosubmit = false, selectionFilter = null,
  roleOrder = null,
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
  const selectionSelected = selectionFilter && add({ name: 'selection', type: 'radio', value: 'selected', 'data-release-assets-live-filter-control': '' }, 'selected', selectionFilter === 'selected');
  const selectionAll = selectionFilter && add({ name: 'selection', type: 'radio', value: 'all', 'data-release-assets-live-filter-control': '' }, 'all', selectionFilter === 'all');
  const selection = makeNode({
    tagName: 'form',
    attrs: {
      action: selectionFilter === 'all' ? '/releases/7/assets?selection=all' : '/releases/7/assets',
      method: 'post', id: 'release-assets-form', 'data-asset-selection-form': '',
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
  // B7-F1: only a recoverable rejected legacy Save renders this carrier.
  const roleOrderInput = roleOrder === null ? null : makeNode({
    tagName: 'input', attrs: { type: 'hidden', name: 'roleOrder' }, value: roleOrder,
  });
  if (roleOrderInput) {
    const carrier = makeNode({ tagName: 'span', attrs: { 'data-release-assets-submitted-role-order': '' } });
    carrier.appendChild(roleOrderInput);
    selection.appendChild(carrier);
  }
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
  const selectionNotice = selectionFilter === 'selected' && !readOnly
    ? makeNode({ attrs: { class: 'notice notice--info', 'data-release-assets-selection-notice': '' } })
    : null;
  if (selectionNotice) region.appendChild(selectionNotice);
  let assetGrid = null;
  let assetList = null;
  let gridSizeSlider = null;
  let listSizeSlider = null;
  let infoCard = null;
  let preview = null;
  if (reEnhancementSurface && view === 'grid') {
    const gridSizeControls = makeNode({
      attrs: { class: 'asset-grid-size-controls asset-viewer-grid-size-controls', 'data-asset-grid-size-controls': '' },
    });
    gridSizeSlider = makeNode({
      tagName: 'input',
      attrs: { class: 'asset-grid-size-slider', type: 'range', 'data-grid-size-slider': '' },
      value: '2',
    });
    gridSizeControls.appendChild(gridSizeSlider);
    assetGrid = makeNode({ tagName: 'ul', attrs: { class: 'asset-grid' } });
    preview = makeNode({ attrs: { 'data-asset-viewer-preview': '' } });
    infoCard = makeNode({ attrs: { 'data-asset-info-card': '' } });
    preview.appendChild(infoCard);
    assetGrid.appendChild(preview);
    region.appendChild(gridSizeControls);
    region.appendChild(assetGrid);
  }
  let roleForm = null;
  if (roleAutosubmit) {
    roleForm = makeNode({
      tagName: 'form',
      attrs: {
        action: '/releases/7/assets/99/role', method: 'post', class: 'inline-form release-asset-role-form',
      },
    });
    roleForm.appendChild(makeNode({ tagName: 'input', attrs: { name: '_csrf', type: 'hidden' }, value: 'csrf' }));
    const role = makeSelect(
      { id: 'role-99', name: 'role', 'data-autosubmit': '' },
      ['attachment', 'primary'],
      'attachment',
    );
    role.form = roleForm;
    roleForm.appendChild(role);
    region.appendChild(roleForm);
  }
  if (reEnhancementSurface && view === 'list') {
    const listSizeControls = makeNode({
      attrs: { class: 'asset-grid-size-controls asset-viewer-grid-size-controls asset-list-size-controls', 'data-asset-list-size-controls': '' },
    });
    listSizeSlider = makeNode({
      tagName: 'input',
      attrs: { class: 'asset-grid-size-slider', type: 'range', 'data-grid-size-slider': '' },
      value: '2',
    });
    listSizeControls.appendChild(listSizeSlider);
    assetList = makeNode({ tagName: 'ul', attrs: { class: 'asset-list' } });
    region.appendChild(listSizeControls);
    region.appendChild(assetList);
  }
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
    assetGrid, assetList, gridSizeSlider, listSizeSlider, infoCard, preview, roleForm,
    selectionSelected, selectionAll, selectionNotice, roleOrderInput,
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

const liveFailureNotice = (document) => document.querySelector('[data-live-filter-failure]');
const liveFailureRetries = (document) => document.querySelectorAll('[data-live-filter-retry]');

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

  it('keeps the asset scope and Defaults action in sync through filtering, Reset, and Back', async () => {
    const scopedOptions = { assetValue: '42', resetUrl: '/releases' };
    const initial = makePage('/releases', { ...scopedOptions, defaultsAction: '/releases/defaults?asset=42&project=7' });
    const filtered = makePage('/releases', {
      ...scopedOptions, scheduleValue: 'today', defaultsAction: '/releases/defaults?asset=42&project=7&schedule=today',
    });
    const reset = makePage('/releases', { projectValue: '', defaultsAction: '/releases/defaults' });
    const unscoped = makePage('/releases', { projectValue: '', scheduleValue: 'upcoming', defaultsAction: '/releases/defaults' });
    const restored = makePage('/releases', { ...scopedOptions, scheduleValue: 'today', defaultsAction: '/releases/defaults?asset=42&project=7&schedule=today' });
    const pages = new Map([
      ['filtered', filtered.document],
      ['reset', reset.document],
      ['unscoped', unscoped.document],
      ['restored', restored.document],
    ]);
    const windowObject = makeWindow(initial.document, pages);
    windowObject.fetch
      .mockResolvedValueOnce(responseFor('filtered', 'http://creatorcrate.test/releases?asset=42&project=7&schedule=today'))
      .mockResolvedValueOnce(responseFor('reset', 'http://creatorcrate.test/releases'))
      .mockResolvedValueOnce(responseFor('unscoped', 'http://creatorcrate.test/releases?schedule=upcoming'));
    enhanceReleasesLiveFiltering(initial.document);

    initial.schedule.value = 'today';
    initial.form.dispatch('change', { target: initial.schedule });
    await flush();
    let requested = new URL(windowObject.fetch.mock.calls[0][0]);
    expect(requested.searchParams.getAll('asset')).toEqual(['42']);
    expect(requested.searchParams.get('schedule')).toBe('today');
    expect(initial.form.querySelector('input[name="asset"]')?.value).toBe('42');
    expect(initial.defaultsForm.getAttribute('action')).toBe('/releases/defaults?asset=42&project=7&schedule=today');

    initial.reset.dispatch('click');
    await flush();
    expect(windowObject.fetch.mock.calls[1][0]).toBe('http://creatorcrate.test/releases');
    expect(initial.form.querySelector('input[name="asset"]')).toBeNull();
    expect(initial.defaultsForm.getAttribute('action')).toBe('/releases/defaults');

    reset.schedule.value = 'upcoming';
    initial.form.dispatch('change', { target: reset.schedule });
    await flush();
    requested = new URL(windowObject.fetch.mock.calls[2][0]);
    expect(requested.searchParams.has('asset')).toBe(false);
    expect(initial.defaultsForm.getAttribute('action')).toBe('/releases/defaults');

    windowObject.location.href = 'http://creatorcrate.test/releases?asset=42&project=7&schedule=today';
    windowObject.location.pathname = '/releases';
    windowObject.fetch.mockResolvedValueOnce(responseFor('restored', windowObject.location.href));
    windowObject.dispatch('popstate');
    await flush();
    expect(windowObject.fetch.mock.calls[3][0]).toBe(windowObject.location.href);
    expect(initial.form.querySelector('input[name="asset"]')?.value).toBe('42');
    expect(initial.defaultsForm.getAttribute('action')).toBe('/releases/defaults?asset=42&project=7&schedule=today');
    expect(initial.form.submit).not.toHaveBeenCalled();
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

  it('keeps pending additions and removals across Selection modes and syncs the Save action', async () => {
    // All assets: 1 is saved, 2 is not.
    const initial = makeReleaseAssetsPage({
      selectionFilter: 'all', extension: '', category: '',
      assets: [{ id: '1', selected: true }, { id: '2', selected: false }],
    });
    // Selected assets lists saved membership only, so the pending addition 2 is hidden.
    const selectedView = makeReleaseAssetsPage({
      selectionFilter: 'selected', extension: '', category: '', assets: [{ id: '1', selected: true }],
    });
    const allView = makeReleaseAssetsPage({
      selectionFilter: 'all', extension: '', category: '',
      assets: [{ id: '1', selected: true }, { id: '2', selected: false }],
    });
    const pages = new Map([['selected-view', selectedView.document], ['all-view', allView.document]]);
    const windowObject = makeWindow(initial.document, pages);
    windowObject.location.href = 'http://creatorcrate.test/releases/7/assets?selection=all';
    windowObject.location.pathname = '/releases/7/assets';
    windowObject.fetch
      .mockResolvedValueOnce(responseFor('selected-view', 'http://creatorcrate.test/releases/7/assets?selection=selected'))
      .mockResolvedValueOnce(responseFor('all-view', 'http://creatorcrate.test/releases/7/assets?selection=all'));
    enhanceReleaseAssetsLiveFiltering(initial.document);
    const selectionForm = initial.selection;

    initial.membershipCheckboxes[1].checked = true;
    initial.membershipCheckboxes[1].dispatch('change');
    initial.selectionAll.checked = false;
    initial.selectionSelected.checked = true;
    initial.filter.dispatch('change', { target: initial.selectionSelected });
    await flush();

    expect(windowObject.fetch.mock.calls[0][0]).toBe('http://creatorcrate.test/releases/7/assets?view=grid&pageSize=50&selection=selected');
    expect(initial.document.querySelector('[data-release-assets-live-region]')).toBe(selectedView.region);
    expect(initial.document.querySelector('[data-release-assets-selection-notice]')).toBe(selectedView.selectionNotice);
    expect(initial.document.querySelector('[data-asset-selection-form][id="release-assets-form"]')).toBe(selectionForm);
    expect(selectionForm.getAttribute('action')).toBe('/releases/7/assets');
    expect(releaseHiddenMembership(selectionForm)).toEqual(['2']);
    expect(releaseMembershipPayload(windowObject, selectionForm).sort()).toEqual(['1', '2']);

    // A saved selection stays visible in Selected assets after a local uncheck.
    selectedView.membershipCheckboxes[0].checked = false;
    selectedView.membershipCheckboxes[0].dispatch('change');
    expect(releaseMembershipPayload(windowObject, selectionForm)).toEqual(['2']);

    selectedView.selectionSelected.checked = false;
    selectedView.selectionAll.checked = true;
    initial.filter.dispatch('change', { target: selectedView.selectionAll });
    await flush();

    expect(initial.document.querySelector('[data-release-assets-live-region]')).toBe(allView.region);
    expect(initial.document.querySelector('[data-release-assets-selection-notice]')).toBeNull();
    expect(allView.membershipCheckboxes.map((checkbox) => checkbox.checked)).toEqual([false, true]);
    expect(selectionForm.getAttribute('action')).toBe('/releases/7/assets?selection=all');
    expect(releaseHiddenMembership(selectionForm)).toEqual([]);
    expect(releaseMembershipPayload(windowObject, selectionForm)).toEqual(['2']);
  });

  it('keeps the Save action and notice from installed results when Selection requests are stale or fail', async () => {
    const initial = makeReleaseAssetsPage({ selectionFilter: 'all', extension: '', category: '', assets: [{ id: '1', selected: true }] });
    const stale = makeReleaseAssetsPage({ selectionFilter: 'selected', extension: '', category: '', assets: [{ id: '1', selected: true }] });
    const latest = makeReleaseAssetsPage({ selectionFilter: 'all', extension: 'jpg', category: '', assets: [{ id: '1', selected: true }] });
    const pages = new Map([['stale', stale.document], ['latest', latest.document]]);
    const windowObject = makeWindow(initial.document, pages);
    windowObject.location.href = 'http://creatorcrate.test/releases/7/assets?selection=all';
    windowObject.location.pathname = '/releases/7/assets';
    windowObject.location.assign = vi.fn();
    const requests = [];
    windowObject.fetch.mockImplementation((url, options) => new Promise((resolve, reject) => requests.push({ resolve, reject })));
    enhanceReleaseAssetsLiveFiltering(initial.document);
    const selectionForm = initial.selection;
    stale.selection.setAttribute('action', '/releases/7/assets');
    latest.selection.setAttribute('action', '/releases/7/assets?extension=jpg&selection=all');

    initial.selectionAll.checked = false;
    initial.selectionSelected.checked = true;
    initial.filter.dispatch('change', { target: initial.selectionSelected });
    initial.selectionSelected.checked = false;
    initial.selectionAll.checked = true;
    initial.extensionJpg.checked = true;
    initial.filter.dispatch('change', { target: initial.extensionJpg });

    requests[1].resolve(responseFor('latest', 'http://creatorcrate.test/releases/7/assets?extension=jpg&selection=all'));
    await flush();
    requests[0].resolve(responseFor('stale', 'http://creatorcrate.test/releases/7/assets?selection=selected'));
    await flush();

    expect(initial.document.querySelector('[data-release-assets-live-region]')).toBe(latest.region);
    expect(initial.document.querySelector('[data-release-assets-selection-notice]')).toBeNull();
    expect(selectionForm.getAttribute('action')).toBe('/releases/7/assets?extension=jpg&selection=all');

    latest.selectionAll.checked = false;
    latest.selectionSelected.checked = true;
    initial.filter.dispatch('change', { target: latest.selectionSelected });
    requests[2].reject(new Error('offline'));
    await flush();

    expect(windowObject.location.assign).not.toHaveBeenCalled();
    expect(initial.document.querySelector('[data-release-assets-live-region]')).toBe(latest.region);
    expect(initial.document.querySelector('[data-release-assets-selection-notice]')).toBeNull();
    expect(selectionForm.getAttribute('action')).toBe('/releases/7/assets?extension=jpg&selection=all');
    expect(releaseMembershipPayload(windowObject, selectionForm)).toEqual(['1']);
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

  it('re-enhances replacement Release Assets cards and size controls', async () => {
    const initial = makeReleaseAssetsPage({ reEnhancementSurface: true });
    const gridReplacement = makeReleaseAssetsPage({ reEnhancementSurface: true, roleAutosubmit: true });
    const listReplacement = makeReleaseAssetsPage({ view: 'list', reEnhancementSurface: true });
    const pages = new Map([
      ['grid-replacement', gridReplacement.document],
      ['list-replacement', listReplacement.document],
    ]);
    const windowObject = makeWindow(initial.document, pages);
    windowObject.location.href = 'http://creatorcrate.test/releases/7/assets';
    windowObject.location.pathname = '/releases/7/assets';
    windowObject.fetch
      .mockResolvedValueOnce(responseFor('grid-replacement', 'http://creatorcrate.test/releases/7/assets?page=2'))
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce(responseFor('list-replacement', 'http://creatorcrate.test/releases/7/assets?view=list'));

    enhanceReleaseAssetsLiveFiltering(initial.document);
    const originalRegion = initial.document.querySelector('[data-release-assets-live-region]');
    const originalInfoCard = originalRegion.querySelector('[data-asset-info-card]');

    initial.next.dispatch('click');
    await flush();

    const replacedGridRegion = initial.document.querySelector('[data-release-assets-live-region]');
    const replacementInfoCard = replacedGridRegion.querySelector('[data-asset-info-card]');
    expect(replacedGridRegion).toBe(gridReplacement.region);
    expect(replacedGridRegion).not.toBe(originalRegion);
    expect(replacementInfoCard).toBe(gridReplacement.infoCard);
    expect(replacementInfoCard).not.toBe(originalInfoCard);
    gridReplacement.preview.dispatch('pointerenter', { clientX: 40, clientY: 40 });
    expect(replacementInfoCard.getAttribute('data-info-card-open')).toBe('true');

    gridReplacement.gridSizeSlider.value = '3';
    gridReplacement.gridSizeSlider.dispatch('input');
    expect(replacedGridRegion.querySelector('.asset-grid').getAttribute('data-grid-size')).toBe('large');

    const replacementRole = replacedGridRegion.querySelector('select[name="role"][data-autosubmit]');
    expect(replacementRole).not.toBeNull();
    expect(originalRegion.querySelector('select[name="role"][data-autosubmit]')).toBeNull();
    replacementRole.value = 'primary';
    const originalFetch = globalThis.fetch;
    const originalFormData = globalThis.FormData;
    vi.stubGlobal('fetch', windowObject.fetch);
    vi.stubGlobal('FormData', windowObject.FormData);
    try {
      replacementRole.dispatch('change');
      await flush();

      expect(windowObject.fetch).toHaveBeenCalledTimes(2);
      expect(windowObject.fetch.mock.calls[1]).toEqual([
        '/releases/7/assets/99/role',
        expect.objectContaining({
          method: 'POST',
          body: expect.any(URLSearchParams),
          credentials: 'same-origin',
          redirect: 'follow',
        }),
      ]);
      expect(Array.from(windowObject.fetch.mock.calls[1][1].body.entries())).toEqual([
        ['_csrf', 'csrf'],
        ['role', 'primary'],
      ]);
      expect(replacementRole.form.hasAttribute('aria-busy')).toBe(false);
    } finally {
      vi.stubGlobal('fetch', originalFetch);
      vi.stubGlobal('FormData', originalFormData);
    }

    gridReplacement.list.dispatch('click');
    await flush();

    const replacedListRegion = initial.document.querySelector('[data-release-assets-live-region]');
    expect(replacedListRegion).toBe(listReplacement.region);
    expect(replacedListRegion).not.toBe(replacedGridRegion);
    listReplacement.listSizeSlider.value = '1';
    listReplacement.listSizeSlider.dispatch('input');
    expect(replacedListRegion.querySelector('.asset-list').getAttribute('data-list-size')).toBe('compact');
  });

  it('filters Release Assets immediately, preserves sibling state, and rebinds once per replacement', async () => {
    vi.useFakeTimers();
    const initial = makeReleaseAssetsPage({ dialogOpen: true });
    const afterExtension = makeReleaseAssetsPage({ extension: 'jpg', category: '3' });
    const afterCategory = makeReleaseAssetsPage({ extension: 'jpg', category: '4' });
    const afterSearch = makeReleaseAssetsPage({ extension: 'jpg', category: '4', search: 'needle' });
    const afterSearchClear = makeReleaseAssetsPage({ extension: 'jpg', category: '4' });
    const pages = new Map([
      ['after-extension', afterExtension.document],
      ['after-category', afterCategory.document],
      ['after-search', afterSearch.document],
      ['after-search-clear', afterSearchClear.document],
    ]);
    const windowObject = makeWindow(initial.document, pages);
    windowObject.location.href = 'http://creatorcrate.test/releases/7/assets?page=4';
    windowObject.location.pathname = '/releases/7/assets';
    windowObject.fetch
      .mockResolvedValueOnce(responseFor('after-extension', 'http://creatorcrate.test/releases/7/assets?view=grid&pageSize=50&extension=jpg&category=3'))
      .mockResolvedValueOnce(responseFor('after-category', 'http://creatorcrate.test/releases/7/assets?view=grid&pageSize=50&extension=jpg&category=4'))
      .mockResolvedValueOnce(responseFor('after-search', 'http://creatorcrate.test/releases/7/assets?view=grid&pageSize=50&search=needle&extension=jpg&category=4'))
      .mockResolvedValueOnce(responseFor('after-search-clear', 'http://creatorcrate.test/releases/7/assets?view=grid&pageSize=50&extension=jpg&category=4'));

    expect(enhanceReleaseAssetsLiveFiltering(initial.document)).toBe(2);
    expect(enhanceReleaseAssetsLiveFiltering(initial.document)).toBe(2);

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
    afterExtension.categoryThree.checked = false;
    afterExtension.categoryFour.checked = true;
    initial.filter.dispatch('change', { target: afterExtension.categoryFour });
    await flush();

    expect(windowObject.fetch).toHaveBeenCalledTimes(2);
    requested = new URL(windowObject.fetch.mock.calls[1][0]);
    expect(requested.searchParams.get('extension')).toBe('jpg');
    expect(requested.searchParams.get('category')).toBe('4');
    expect(requested.searchParams.has('selectedAssetIds')).toBe(false);

    afterCategory.searchInput.value = 'need';
    initial.filter.dispatch('input', { target: afterCategory.searchInput });
    vi.advanceTimersByTime(175);
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

    afterSearch.searchInput.value = '';
    initial.filter.dispatch('input', { target: afterSearch.searchInput });
    vi.advanceTimersByTime(350);
    await flush();
    expect(windowObject.fetch).toHaveBeenCalledTimes(4);
    requested = new URL(windowObject.fetch.mock.calls[3][0]);
    expect(requested.searchParams.has('search')).toBe(false);
    expect(initial.document.querySelector('[data-release-assets-live-region]')).toBe(afterSearchClear.region);
  });

  it('applies the explicit All extension and category options immediately', async () => {
    const initial = makeReleaseAssetsPage({ extension: 'jpg', category: '4', pageSize: 'all' });
    const afterExtensionReset = makeReleaseAssetsPage({ extension: '', category: '4', pageSize: 'all' });
    const afterCategoryReset = makeReleaseAssetsPage({ extension: '', category: '', pageSize: 'all' });
    const pages = new Map([
      ['after-extension-reset', afterExtensionReset.document],
      ['after-category-reset', afterCategoryReset.document],
    ]);
    const windowObject = makeWindow(initial.document, pages);
    windowObject.location.href = 'http://creatorcrate.test/releases/7/assets?extension=jpg&category=4';
    windowObject.location.pathname = '/releases/7/assets';
    windowObject.fetch
      .mockResolvedValueOnce(responseFor('after-extension-reset', 'http://creatorcrate.test/releases/7/assets?category=4&pageSize=all'))
      .mockResolvedValueOnce(responseFor('after-category-reset', 'http://creatorcrate.test/releases/7/assets?pageSize=all'));
    enhanceReleaseAssetsLiveFiltering(initial.document);

    initial.extensionJpg.checked = false;
    initial.extensionAll.checked = true;
    initial.filter.dispatch('change', { target: initial.extensionAll });
    await flush();

    let requested = new URL(windowObject.fetch.mock.calls[0][0]);
    expect(requested.searchParams.has('extension')).toBe(false);
    expect(requested.searchParams.get('category')).toBe('4');
    expect(requested.searchParams.get('pageSize')).toBe('all');

    afterExtensionReset.categoryFour.checked = false;
    afterExtensionReset.categoryAll.checked = true;
    initial.filter.dispatch('change', { target: afterExtensionReset.categoryAll });
    await flush();

    requested = new URL(windowObject.fetch.mock.calls[1][0]);
    expect(requested.searchParams.has('extension')).toBe(false);
    expect(requested.searchParams.has('category')).toBe(false);
    expect(requested.searchParams.get('pageSize')).toBe('all');
  });

  it('switches all to finite and finite to all without changing draft selection', async () => {
    const initial = makeReleaseAssetsPage({
      pageSize: '25', assets: [{ id: '1', selected: false }], persistedSelectedIds: [],
    });
    const all = makeReleaseAssetsPage({
      pageSize: 'all', assets: [{ id: '1', selected: false }, { id: '2', selected: false }], persistedSelectedIds: [],
    });
    const finite = makeReleaseAssetsPage({
      pageSize: '50', assets: [{ id: '1', selected: false }], offPageSelectedIds: [], persistedSelectedIds: [],
    });
    const pages = new Map([['all', all.document], ['finite', finite.document]]);
    const windowObject = makeWindow(initial.document, pages);
    windowObject.location.href = 'http://creatorcrate.test/releases/7/assets?page=4&pageSize=25';
    windowObject.location.pathname = '/releases/7/assets';
    windowObject.fetch
      .mockResolvedValueOnce(responseFor('all', 'http://creatorcrate.test/releases/7/assets?pageSize=all'))
      .mockResolvedValueOnce(responseFor('finite', 'http://creatorcrate.test/releases/7/assets?pageSize=50'));
    enhanceReleaseAssetsLiveFiltering(initial.document);

    initial.membershipCheckboxes[0].checked = true;
    initial.membershipCheckboxes[0].dispatch('change');
    initial.filterPageSize.value = 'all';
    initial.filter.dispatch('change', { target: initial.filterPageSize });
    await flush();

    expect(new URL(windowObject.fetch.mock.calls[0][0]).searchParams.get('pageSize')).toBe('all');
    expect(new URL(windowObject.fetch.mock.calls[0][0]).searchParams.has('page')).toBe(false);
    expect(all.membershipCheckboxes[0].checked).toBe(true);

    all.pageSize.value = '50';
    all.pageSizeForm.dispatch('change', { target: all.pageSize });
    await flush();

    expect(new URL(windowObject.fetch.mock.calls[1][0]).searchParams.get('pageSize')).toBe('50');
    expect(finite.membershipCheckboxes[0].checked).toBe(true);
    expect(releaseMembershipPayload(windowObject, initial.selection)).toEqual(['1']);
  });

  it('keeps pageSize=all when Clear replaces the editable Release Assets region', async () => {
    const initial = makeReleaseAssetsPage({ search: 'needle', pageSize: 'all' });
    const cleared = makeReleaseAssetsPage({ search: '', extension: '', category: '', pageSize: 'all' });
    const pages = new Map([['cleared', cleared.document]]);
    const windowObject = makeWindow(initial.document, pages);
    windowObject.location.href = 'http://creatorcrate.test/releases/7/assets?search=needle&pageSize=all';
    windowObject.location.pathname = '/releases/7/assets';
    windowObject.fetch.mockResolvedValueOnce(responseFor(
      'cleared',
      'http://creatorcrate.test/releases/7/assets?pageSize=all',
    ));
    enhanceReleaseAssetsLiveFiltering(initial.document);

    initial.reset.dispatch('click');
    await flush();

    expect(new URL(windowObject.fetch.mock.calls[0][0]).searchParams.get('pageSize')).toBe('all');
    expect(cleared.filterPageSize.value).toBe('all');
    expect(windowObject.history.pushes.at(-1).url).toBe('http://creatorcrate.test/releases/7/assets?pageSize=all');
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
    windowObject.fetch.mockImplementation((url, options) => new Promise((resolve) => requests.push({ url, options, resolve })));

    enhanceReleaseAssetsLiveFiltering(initial.document);
    initial.extensionPng.checked = false;
    initial.extensionJpg.checked = true;
    initial.filter.dispatch('change', { target: initial.extensionJpg });
    initial.categoryThree.checked = false;
    initial.categoryFour.checked = true;
    initial.filter.dispatch('change', { target: initial.categoryFour });

    expect(requests[0].options.signal.aborted).toBe(true);
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
    const restored = makeReleaseAssetsPage({ extension: 'png', category: '3', search: 'back', pageSize: 'all' });
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
    let rejectFailedRequest;
    const failedRequest = new Promise((_resolve, reject) => { rejectFailedRequest = reject; });
    windowObject.fetch
      .mockResolvedValueOnce(responseFor('canonical', canonicalUrl))
      .mockResolvedValueOnce(responseFor('restored', 'http://creatorcrate.test/releases/7/assets?search=back&pageSize=all'))
      .mockImplementationOnce(() => failedRequest)
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

    const popstateRequestUrl = 'http://creatorcrate.test/releases/7/assets?search=back&pageSize=all&from=history';
    const pushesBeforePopstate = windowObject.history.pushes.length;
    const replacesBeforePopstate = windowObject.history.replaces.length;
    windowObject.location.href = popstateRequestUrl;
    windowObject.location.pathname = '/releases/7/assets';
    windowObject.dispatch('popstate');
    await flush();

    expect(windowObject.fetch.mock.calls[1][0]).toBe(popstateRequestUrl);
    expect(initial.document.querySelector('[data-release-assets-live-region]')).toBe(restored.region);
    expect(initial.filter.contains(restored.searchInput)).toBe(true);
    expect(restored.searchInput.value).toBe('back');
    expect(restored.filterPageSize.value).toBe('all');
    expect(restored.membershipCheckboxes[0].checked).toBe(false);
    expect(releaseMembershipPayload(windowObject, initial.selection)).toEqual([]);
    expect(initial.dialog.open).toBe(true);
    expect(windowObject.history.pushes).toHaveLength(pushesBeforePopstate);
    expect(windowObject.history.replaces).toHaveLength(replacesBeforePopstate + 1);
    expect(windowObject.history.replaces.at(-1)).toEqual(expect.objectContaining({
      url: 'http://creatorcrate.test/releases/7/assets?search=back&pageSize=all',
    }));

    const regionBeforeFailure = initial.document.querySelector('[data-release-assets-live-region]');
    const pushesBeforeFailure = windowObject.history.pushes.length;
    const replacesBeforeFailure = windowObject.history.replaces.length;
    restored.categoryThree.checked = false;
    restored.categoryFour.checked = true;
    initial.filter.dispatch('change', { target: restored.categoryFour });

    const pendingRegion = initial.document.querySelector('[data-release-assets-live-region]');
    expect(pendingRegion).toBe(regionBeforeFailure);
    expect(pendingRegion.getAttribute('aria-busy')).toBe('true');

    rejectFailedRequest(new Error('offline'));
    await flush();

    expect(windowObject.location.assign).not.toHaveBeenCalled();
    expect(initial.document.querySelector('[data-release-assets-live-region]')).toBe(regionBeforeFailure);
    expect(regionBeforeFailure.hasAttribute('aria-busy')).toBe(false);
    expect(restored.status.textContent).toContain('The requested filters were not applied');
    expect(restored.region.getAttribute('data-release-assets-live-state')).toBe('error');
    expect(restored.categoryFour.checked).toBe(true);
    expect(liveFailureRetries(initial.document)).toHaveLength(1);
    expect(initial.dialog.open).toBe(true);
    expect(windowObject.history.pushes).toHaveLength(pushesBeforeFailure);
    expect(windowObject.history.replaces).toHaveLength(replacesBeforeFailure);

    restored.categoryFour.checked = false;
    restored.extensionPng.checked = false;
    restored.extensionJpg.checked = true;
    initial.filter.dispatch('change', { target: restored.extensionJpg });
    await flush();

    expect(initial.document.querySelector('[data-release-assets-live-region]')).toBe(retried.region);
    expect(initial.dialog.open).toBe(true);
    expect(windowObject.fetch).toHaveBeenCalledTimes(4);
  });

  it('retries a failed Release Assets filter with GET only, keeping the dialog and never saving', async () => {
    const initial = makeReleaseAssetsPage({ dialogOpen: true });
    const recovered = makeReleaseAssetsPage({ category: '4' });
    const windowObject = makeWindow(initial.document, new Map([['recovered', recovered.document]]));
    windowObject.location.href = 'http://creatorcrate.test/releases/7/assets';
    windowObject.location.pathname = '/releases/7/assets';
    windowObject.location.assign = vi.fn();
    windowObject.fetch.mockRejectedValueOnce(new Error('offline'));
    enhanceReleaseAssetsLiveFiltering(initial.document);
    initial.categoryThree.checked = false;
    initial.categoryFour.checked = true;
    initial.filter.dispatch('change', { target: initial.categoryFour });
    await flush();

    const requested = windowObject.fetch.mock.calls[0][0];
    windowObject.fetch.mockResolvedValueOnce(responseFor('recovered', requested));
    liveFailureRetries(initial.document)[0].dispatch('click');
    await flush();

    expect(windowObject.fetch).toHaveBeenCalledTimes(2);
    expect(windowObject.fetch.mock.calls[1][0]).toBe(requested);
    expect(windowObject.fetch.mock.calls[1][1].method).toBe('GET');
    expect(windowObject.fetch.mock.calls[1][1].body).toBeUndefined();
    expect(initial.document.querySelector('[data-release-assets-live-region]')).toBe(recovered.region);
    expect(liveFailureNotice(initial.document)).toBeNull();
    expect(initial.dialog.open).toBe(true);
    expect(windowObject.location.assign).not.toHaveBeenCalled();
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
    expect(failed.form.submit).not.toHaveBeenCalled();
    expect(failed.document.querySelector('[data-releases-live-region]')).toBe(failed.region);
    expect(liveFailureRetries(failed.document)).toHaveLength(1);

    const recovered = makePage();
    const retryWindow = makeWindow(failed.document, new Map([['recovered', recovered.document]]));
    const requested = failedWindow.fetch.mock.calls[0][0];
    failed.document.__creatorCrateReleasesLiveFiltering.window.fetch = retryWindow.fetch;
    failed.document.__creatorCrateReleasesLiveFiltering.window.DOMParser = retryWindow.DOMParser;
    retryWindow.fetch.mockResolvedValueOnce(responseFor('recovered', requested));
    liveFailureRetries(failed.document)[0].dispatch('click');
    await flush();
    expect(retryWindow.fetch.mock.calls[0][0]).toBe(requested);
    expect(retryWindow.fetch.mock.calls[0][1].method).toBe('GET');
    expect(failed.document.querySelector('[data-releases-live-region]')).toBe(recovered.region);
    expect(liveFailureNotice(failed.document)).toBeNull();
  });
});

describe('WP16 Release Manage Assets page-size entry points', () => {
  beforeEach(() => { vi.useRealTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function deferredFetch(windowObject) {
    const requests = [];
    windowObject.fetch.mockImplementation((url, options) => new Promise((resolve, reject) => {
      requests.push({ url, options, resolve, reject });
    }));
    return requests;
  }

  function assetsWindow(document, pages = new Map(), href = 'http://creatorcrate.test/releases/7/assets?pageSize=50') {
    const windowObject = makeWindow(document, pages);
    windowObject.location.href = href;
    windowObject.location.pathname = '/releases/7/assets';
    windowObject.location.assign = vi.fn();
    return windowObject;
  }

  it('mirrors a pagination-side size into the dialog and keeps it through failed GETs, a filter change and Clear', async () => {
    const initial = makeReleaseAssetsPage({ pageSize: '50', search: 'needle', dialogOpen: true });
    const cleared = makeReleaseAssetsPage({ pageSize: '100', extension: '', category: '' });
    const windowObject = assetsWindow(initial.document, new Map([['cleared', cleared.document]]));
    windowObject.fetch
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(responseFor('cleared', 'http://creatorcrate.test/releases/7/assets?view=grid&pageSize=100'));
    const regionBefore = initial.region;
    enhanceReleaseAssetsLiveFiltering(initial.document);

    initial.pageSize.value = '100';
    initial.pageSizeForm.dispatch('change', { target: initial.pageSize });
    await flush();

    expect(initial.filterPageSize.value).toBe('100');
    let requested = new URL(windowObject.fetch.mock.calls[0][0]);
    expect(requested.searchParams.get('pageSize')).toBe('100');
    expect(requested.searchParams.get('search')).toBe('needle');
    expect(requested.searchParams.has('page')).toBe(false);
    expect(initial.document.querySelector('[data-release-assets-live-region]')).toBe(regionBefore);
    expect(liveFailureRetries(initial.document)).toHaveLength(1);
    // The failed request's controls stay as chosen: both show the new size.
    expect(initial.pageSize.value).toBe('100');

    initial.categoryThree.checked = false;
    initial.categoryFour.checked = true;
    initial.filter.dispatch('change', { target: initial.categoryFour });
    await flush();

    requested = new URL(windowObject.fetch.mock.calls[1][0]);
    expect(requested.searchParams.get('pageSize')).toBe('100');
    expect(requested.searchParams.get('category')).toBe('4');
    expect(requested.searchParams.has('page')).toBe(false);

    // Clear was rendered for the older size; it follows the newer intent.
    expect(initial.reset.getAttribute('href')).toContain('pageSize=50');
    initial.reset.dispatch('click');
    await flush();

    requested = new URL(windowObject.fetch.mock.calls[2][0]);
    expect(requested.searchParams.get('pageSize')).toBe('100');
    expect(requested.searchParams.has('search')).toBe(false);
    expect(requested.searchParams.has('extension')).toBe(false);
    expect(requested.searchParams.has('category')).toBe(false);
    expect(requested.searchParams.has('page')).toBe(false);
    expect(initial.document.querySelector('[data-release-assets-live-region]')).toBe(cleared.region);
    expect(windowObject.fetch.mock.calls.every(([, options]) => options.method === 'GET' && options.body === undefined))
      .toBe(true);
    expect(windowObject.location.assign).not.toHaveBeenCalled();
  });

  it('mirrors a dialog size into the pagination-side control and returns to page 1', async () => {
    const initial = makeReleaseAssetsPage({ pageSize: '50', dialogOpen: true });
    const windowObject = assetsWindow(initial.document, new Map(), 'http://creatorcrate.test/releases/7/assets?pageSize=50&page=3');
    const requests = deferredFetch(windowObject);
    enhanceReleaseAssetsLiveFiltering(initial.document);

    initial.filterPageSize.value = 'all';
    initial.filter.dispatch('change', { target: initial.filterPageSize });
    await flush();

    expect(initial.pageSize.value).toBe('all');
    expect(requests).toHaveLength(1);
    const requested = new URL(requests[0].url);
    expect(requested.searchParams.get('pageSize')).toBe('all');
    expect(requested.searchParams.has('page')).toBe(false);
    expect(requested.searchParams.has('selectedAssetIds')).toBe(false);
  });

  it('carries a debounced dialog Search into a pagination-side size submission', async () => {
    vi.useFakeTimers();
    const initial = makeReleaseAssetsPage({ pageSize: '50', extension: 'png', category: '3' });
    const windowObject = assetsWindow(initial.document);
    const requests = deferredFetch(windowObject);
    enhanceReleaseAssetsLiveFiltering(initial.document);

    initial.searchInput.value = 'needle';
    initial.filter.dispatch('input', { target: initial.searchInput });
    vi.advanceTimersByTime(100);
    initial.pageSize.value = '10';
    initial.pageSizeForm.dispatch('change', { target: initial.pageSize });
    await flush();
    vi.advanceTimersByTime(1000);
    await flush();

    // One request: the size change superseded the debounce but kept its Search.
    expect(requests).toHaveLength(1);
    const requested = new URL(requests[0].url);
    expect([...requested.searchParams.entries()]).toEqual([
      ['pageSize', '10'], ['search', 'needle'], ['extension', 'png'], ['category', '3'],
    ]);
    expect(initial.filterPageSize.value).toBe('10');
  });

  it('follows pagination with a pending size, ignores the stale response and lets Back own the size again', async () => {
    const initial = makeReleaseAssetsPage({ pageSize: '50' });
    const stale = makeReleaseAssetsPage({ pageSize: '100' });
    const paged = makeReleaseAssetsPage({ pageSize: '100' });
    const back = makeReleaseAssetsPage({ pageSize: '50' });
    const windowObject = assetsWindow(initial.document, new Map([
      ['stale', stale.document], ['paged', paged.document], ['back', back.document],
    ]));
    const requests = deferredFetch(windowObject);
    enhanceReleaseAssetsLiveFiltering(initial.document);

    initial.pageSize.value = '100';
    initial.pageSizeForm.dispatch('change', { target: initial.pageSize });
    await flush();
    expect(new URL(requests[0].url).searchParams.get('pageSize')).toBe('100');

    // Next was rendered for size 50; following it before the size installs
    // keeps the newer size rather than reverting to the rendered one.
    expect(initial.next.getAttribute('href')).toContain('pageSize=50');
    initial.next.dispatch('click');
    await flush();
    const followed = new URL(requests[1].url);
    expect(followed.searchParams.get('pageSize')).toBe('100');
    expect(followed.searchParams.get('page')).toBe('2');
    expect(followed.searchParams.get('extension')).toBe('png');
    expect(followed.searchParams.get('category')).toBe('3');

    requests[1].resolve(responseFor('paged', followed.href));
    await flush();
    requests[0].resolve(responseFor('stale', requests[0].url));
    await flush();
    expect(initial.document.querySelector('[data-release-assets-live-region]')).toBe(paged.region);
    expect(paged.pageSize.value).toBe('100');

    windowObject.location.href = 'http://creatorcrate.test/releases/7/assets?pageSize=50';
    windowObject.dispatch('popstate');
    await flush();
    requests[2].resolve(responseFor('back', requests[2].url));
    await flush();
    expect(initial.document.querySelector('[data-release-assets-live-region]')).toBe(back.region);

    // The installed Back response owns the size: a rendered link is followed as is.
    back.grid.dispatch('click');
    await flush();
    expect(requests[3].url).toBe(new URL(back.grid.getAttribute('href'), windowObject.location.href).href);
    expect(new URL(requests[3].url).searchParams.get('pageSize')).toBe('50');
  });

  it('never changes the membership draft or Save payload when the size changes', async () => {
    const initial = makeReleaseAssetsPage({
      pageSize: '50', assets: [{ id: '1', selected: false }, { id: '2', selected: true }], offPageSelectedIds: ['9'],
    });
    const resized = makeReleaseAssetsPage({
      pageSize: '10', assets: [{ id: '3', selected: false }], offPageSelectedIds: ['2', '9'], persistedSelectedIds: ['2', '9'],
    });
    const windowObject = assetsWindow(initial.document, new Map([['resized', resized.document]]));
    windowObject.fetch.mockResolvedValueOnce(responseFor('resized', 'http://creatorcrate.test/releases/7/assets?pageSize=10'));
    enhanceReleaseAssetsLiveFiltering(initial.document);

    const [assetOne, assetTwo] = initial.membershipCheckboxes;
    assetOne.checked = true;
    initial.document.dispatch('change', { target: assetOne });
    assetTwo.checked = false;
    initial.document.dispatch('change', { target: assetTwo });
    expect(releaseMembershipPayload(windowObject, initial.selection).sort()).toEqual(['1', '9']);

    initial.pageSize.value = '10';
    initial.pageSizeForm.dispatch('change', { target: initial.pageSize });
    await flush();

    expect(initial.document.querySelector('[data-release-assets-live-region]')).toBe(resized.region);
    expect(windowObject.fetch).toHaveBeenCalledTimes(1);
    expect(windowObject.fetch.mock.calls[0][1].method).toBe('GET');
    // Off-page draft addition 1 and removal 2 survive; saved 9 is kept.
    expect(releaseHiddenMembership(initial.selection).sort()).toEqual(['1', '9']);
    expect(releaseMembershipPayload(windowObject, initial.selection).sort()).toEqual(['1', '9']);
  });

  // C4b: in Chromium the engine aborts the older fetch, so its response never
  // reaches the client. This mock ignores the abort signal and delivers the
  // older GET's successful response AFTER the newer one has installed, which
  // isolates the generation check from cancellation.
  it('C4b: an older GET that still succeeds after the newer one installed changes neither region, URL, history nor the off-page draft', async () => {
    const initial = makeReleaseAssetsPage({
      pageSize: '50', assets: [{ id: '1', selected: false }, { id: '2', selected: true }],
      offPageSelectedIds: ['9'], persistedSelectedIds: ['2', '9'],
    });
    // Older (page 2): a different visible page whose server carrier is the
    // saved membership. Newer (jpg filter): asset 3 only; saved 2 and 9 off-page.
    const older = makeReleaseAssetsPage({
      pageSize: '50', assets: [{ id: '4', selected: false }, { id: '5', selected: false }],
      offPageSelectedIds: ['2', '9'], persistedSelectedIds: ['2', '9'],
    });
    const newer = makeReleaseAssetsPage({
      pageSize: '50', extension: 'jpg', assets: [{ id: '3', selected: false }],
      offPageSelectedIds: ['2', '9'], persistedSelectedIds: ['2', '9'],
    });
    const windowObject = assetsWindow(initial.document, new Map([['older', older.document], ['newer', newer.document]]));
    const requests = deferredFetch(windowObject);
    enhanceReleaseAssetsLiveFiltering(initial.document);

    // Unsaved draft: add 1, remove saved 2; saved 9 stays off-page.
    const [assetOne, assetTwo] = initial.membershipCheckboxes;
    assetOne.checked = true;
    initial.document.dispatch('change', { target: assetOne });
    assetTwo.checked = false;
    initial.document.dispatch('change', { target: assetTwo });
    expect(releaseMembershipPayload(windowObject, initial.selection).sort()).toEqual(['1', '9']);

    // GET A: page 2, held. GET B: the jpg filter, started while A is pending.
    initial.next.dispatch('click');
    await flush();
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0].url).searchParams.get('page')).toBe('2');
    initial.extensionPng.checked = false;
    initial.extensionJpg.checked = true;
    initial.filter.dispatch('change', { target: initial.extensionJpg });
    await flush();
    expect(requests).toHaveLength(2);
    expect(requests[0].options.signal.aborted).toBe(true);
    expect(requests[1].options.signal.aborted).toBe(false);
    const newerUrl = new URL(requests[1].url);
    expect(newerUrl.searchParams.get('extension')).toBe('jpg');

    // B completes and installs first.
    const newerHref = `http://creatorcrate.test/releases/7/assets?pageSize=50&extension=jpg&category=3`;
    requests[1].resolve(responseFor('newer', newerHref));
    await flush();
    expect(initial.document.querySelector('[data-release-assets-live-region]')).toBe(newer.region);
    expect(windowObject.location.href).toBe(newerHref);
    expect(windowObject.history.pushes.map(({ url }) => String(url))).toEqual([newerHref]);
    expect(releaseHiddenMembership(initial.selection).sort()).toEqual(['1', '9']);

    // A then completes SUCCESSFULLY (the mock ignored the abort). The client
    // receives it but never reads its body or installs it.
    const olderResponse = responseFor('older', 'http://creatorcrate.test/releases/7/assets?pageSize=50&page=2');
    requests[0].resolve(olderResponse);
    await flush();
    expect(olderResponse.text).not.toHaveBeenCalled();
    expect(initial.document.querySelector('[data-release-assets-live-region]')).toBe(newer.region);
    expect(initial.document.querySelector('[data-release-assets-live-region]')).not.toBe(older.region);
    expect(windowObject.location.href).toBe(newerHref);
    expect(windowObject.history.pushes).toHaveLength(1);
    expect(windowObject.history.replaces).toEqual([]);
    expect(newer.region.getAttribute('aria-busy')).toBeNull();

    // The draft (on-page addition now off-page, removal of saved 2, saved 9)
    // is intact in the hidden carrier and the Save payload, each ID once.
    const hidden = releaseHiddenMembership(initial.selection);
    expect(hidden.sort()).toEqual(['1', '9']);
    expect(new Set(hidden).size).toBe(hidden.length);
    const payload = releaseMembershipPayload(windowObject, initial.selection);
    expect(payload.sort()).toEqual(['1', '9']);
    expect(new Set(payload).size).toBe(payload.length);
    expect(newer.membershipCheckboxes.map((box) => [box.value, box.checked])).toEqual([['3', false]]);

    // Only the two GETs: nothing was saved.
    expect(windowObject.fetch).toHaveBeenCalledTimes(2);
    expect(windowObject.fetch.mock.calls.map(([, options]) => options.method)).toEqual(['GET', 'GET']);
  });
  // C4c: the C4b case above releases the older GET before its body is read.
  // Here the older GET's headers arrive and its body read begins BEFORE the
  // newer GET supersedes it; the body then completes after the newer page has
  // installed. Release Manage Assets has no followResponse continuation, so
  // only the engine's post-body generation check can refuse the late body.
  // The mock body ignores the abort signal (a browser would reject the read).
  it('C4c: an older GET whose body read began before the newer GET installs nothing when that body completes late', async () => {
    const initial = makeReleaseAssetsPage({
      pageSize: '50', assets: [{ id: '1', selected: false }, { id: '2', selected: true }],
      offPageSelectedIds: ['9'], persistedSelectedIds: ['2', '9'],
    });
    const older = makeReleaseAssetsPage({
      pageSize: '50', assets: [{ id: '4', selected: false }, { id: '5', selected: false }],
      offPageSelectedIds: ['2', '9'], persistedSelectedIds: ['2', '9'],
    });
    const newer = makeReleaseAssetsPage({
      pageSize: '50', extension: 'jpg', assets: [{ id: '3', selected: false }],
      offPageSelectedIds: ['2', '9'], persistedSelectedIds: ['2', '9'],
    });
    const windowObject = assetsWindow(initial.document, new Map([['older', older.document], ['newer', newer.document]]));
    const requests = deferredFetch(windowObject);
    enhanceReleaseAssetsLiveFiltering(initial.document);

    // Unsaved draft: add 1, remove saved 2; saved 9 stays off-page.
    const [assetOne, assetTwo] = initial.membershipCheckboxes;
    assetOne.checked = true;
    initial.document.dispatch('change', { target: assetOne });
    assetTwo.checked = false;
    initial.document.dispatch('change', { target: assetTwo });
    expect(releaseMembershipPayload(windowObject, initial.selection).sort()).toEqual(['1', '9']);

    // GET A (page 2): its headers arrive and its body read starts, held open.
    initial.next.dispatch('click');
    await flush();
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0].url).searchParams.get('page')).toBe('2');
    let releaseOlderBody;
    const olderBody = new Promise((resolve) => { releaseOlderBody = resolve; });
    const olderResponse = {
      ok: true, url: 'http://creatorcrate.test/releases/7/assets?pageSize=50&page=2', text: vi.fn(() => olderBody),
    };
    requests[0].resolve(olderResponse);
    await flush();
    expect(olderResponse.text).toHaveBeenCalledTimes(1);
    expect(initial.document.querySelector('[data-release-assets-live-region]')).toBe(initial.region);

    // GET B (the jpg filter) supersedes A while A's body is still pending.
    initial.extensionPng.checked = false;
    initial.extensionJpg.checked = true;
    initial.filter.dispatch('change', { target: initial.extensionJpg });
    await flush();
    expect(requests).toHaveLength(2);
    expect(requests[0].options.signal.aborted).toBe(true);
    expect(new URL(requests[1].url).searchParams.get('extension')).toBe('jpg');

    // B completes and installs.
    const newerHref = 'http://creatorcrate.test/releases/7/assets?pageSize=50&extension=jpg&category=3';
    requests[1].resolve(responseFor('newer', newerHref));
    await flush();
    expect(initial.document.querySelector('[data-release-assets-live-region]')).toBe(newer.region);
    expect(windowObject.location.href).toBe(newerHref);
    expect(windowObject.history.pushes.map(({ url }) => String(url))).toEqual([newerHref]);

    // A's body now completes successfully: nothing it carries is installed.
    releaseOlderBody('older');
    await flush();
    expect(initial.document.querySelector('[data-release-assets-live-region]')).toBe(newer.region);
    expect(initial.document.querySelector('[data-release-assets-live-region]')).not.toBe(older.region);
    expect(windowObject.location.href).toBe(newerHref);
    expect(windowObject.history.pushes).toHaveLength(1);
    expect(windowObject.history.replaces).toEqual([]);
    expect(newer.region.getAttribute('aria-busy')).toBeNull();
    expect(liveFailureNotice(initial.document)).toBeNull();

    // The draft is intact in the hidden carrier and the Save payload, once each.
    const hidden = releaseHiddenMembership(initial.selection);
    expect(hidden.sort()).toEqual(['1', '9']);
    expect(new Set(hidden).size).toBe(hidden.length);
    const payload = releaseMembershipPayload(windowObject, initial.selection);
    expect(payload.sort()).toEqual(['1', '9']);
    expect(new Set(payload).size).toBe(payload.length);
    expect(newer.membershipCheckboxes.map((box) => [box.value, box.checked])).toEqual([['3', false]]);
    expect(windowObject.fetch.mock.calls.map(([, options]) => options.method)).toEqual(['GET', 'GET']);
  });
});

function heldRequests(windowObject) {
  const requests = [];
  windowObject.fetch.mockImplementation((url, init) => new Promise((resolve, reject) => {
    requests.push({ url: new URL(url), init, resolve, reject });
  }));
  return requests;
}

/*
 * R3: Manage Assets Grid/List, pagination and Clear links are rendered for
 * the installed response. A click while a Search / Selection / page-size
 * change is debounced, held or failed must compose the clicked dimension with
 * that latest intent, and never touch the membership draft.
 */
describe('R3 Release Manage Assets View navigation keeps pending filter intent', () => {
  beforeEach(() => { vi.useRealTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const ASSETS = [{ id: '1', selected: true }, { id: '2', selected: false }, { id: '3', selected: false }];

  function r3Window(document, pages = new Map(), href = 'http://creatorcrate.test/releases/7/assets?selection=all') {
    const windowObject = makeWindow(document, pages);
    windowObject.location.href = href;
    windowObject.location.pathname = '/releases/7/assets';
    windowObject.location.assign = vi.fn();
    return windowObject;
  }

  function r3Page(options = {}) {
    return makeReleaseAssetsPage({
      pageSize: '25', extension: '', category: '', selectionFilter: 'all',
      assets: ASSETS, offPageSelectedIds: ['9'], ...options,
    });
  }

  // Unsaved draft: add 2 and 3, remove saved 1; saved 9 is off page.
  function editDraft(page) {
    const [one, two, three] = page.membershipCheckboxes;
    one.checked = false;
    page.document.dispatch('change', { target: one });
    two.checked = true;
    page.document.dispatch('change', { target: two });
    three.checked = true;
    page.document.dispatch('change', { target: three });
  }

  const regionOf = (page) => page.document.querySelector('[data-release-assets-live-region]');
  const query = (request) => request.url.searchParams;
  const onlyGets = (windowObject) => windowObject.fetch.mock.calls
    .every(([, init]) => init.method === 'GET' && init.body === undefined);

  function searchThenPageSizeTen(page, windowObject) {
    page.searchInput.value = 'needle';
    page.filter.dispatch('input', { target: page.searchInput });
    vi.advanceTimersByTime(100);
    page.pageSize.value = '10';
    page.pageSizeForm.dispatch('change', { target: page.pageSize });
  }

  it('reviewer reproduction: Grid -> List during a held Search + page-size GET keeps Search, Selection and size', async () => {
    vi.useFakeTimers();
    const initial = r3Page();
    const listed = r3Page({
      view: 'list', search: 'needle', pageSize: '10',
      assets: [{ id: '1', selected: true }, { id: '2', selected: false }], persistedSelectedIds: ['1', '9'],
    });
    const stale = r3Page({ search: 'needle', pageSize: '10', assets: [{ id: '1', selected: true }] });
    const windowObject = r3Window(initial.document, new Map([['listed', listed.document], ['stale', stale.document]]));
    const requests = heldRequests(windowObject);
    enhanceReleaseAssetsLiveFiltering(initial.document);
    editDraft(initial);
    expect(releaseMembershipPayload(windowObject, initial.selection).sort()).toEqual(['2', '3', '9']);

    searchThenPageSizeTen(initial, windowObject);
    expect(requests).toHaveLength(1);
    expect(query(requests[0]).get('pageSize')).toBe('10');
    expect(query(requests[0]).get('search')).toBe('needle');
    expect(query(requests[0]).get('selection')).toBe('all');
    expect(initial.filterPageSize.value).toBe('10');

    // The List link was rendered without the pending Search.
    expect(initial.list.getAttribute('href')).not.toContain('needle');
    const click = initial.list.dispatch('click');
    expect(click.defaultPrevented).toBe(true);
    expect(requests).toHaveLength(2);
    const composed = requests[1].url;
    expect(composed.pathname).toBe('/releases/7/assets');
    expect(composed.searchParams.get('search')).toBe('needle');
    expect(composed.searchParams.get('pageSize')).toBe('10');
    expect(composed.searchParams.get('selection')).toBe('all');
    expect(composed.searchParams.get('view')).toBe('list');
    expect(composed.searchParams.has('page')).toBe(false);
    expect(requests[0].init.signal.aborted).toBe(true);
    // The dialog's View follows the requested GET at once.
    expect(initial.view.value).toBe('list');

    requests[1].resolve(responseFor('listed', composed.href));
    await flush();
    expect(regionOf(initial)).toBe(listed.region);
    const shown = new URL(windowObject.location.href);
    expect(shown.searchParams.get('search')).toBe('needle');
    expect(shown.searchParams.get('view')).toBe('list');
    expect(windowObject.history.pushes).toHaveLength(1);

    // The older Search/page-size response delivered last installs nothing.
    requests[0].resolve(responseFor('stale', requests[0].url.href));
    await flush();
    expect(regionOf(initial)).toBe(listed.region);
    expect(windowObject.location.href).toBe(shown.href);
    expect(listed.pageSize.value).toBe('10');
    expect(initial.filter.contains(listed.searchInput)).toBe(true);
    expect(listed.searchInput.value).toBe('needle');
    expect(listed.filterPageSize.value).toBe('10');
    expect(listed.selectionAll.checked).toBe(true);

    // Draft membership survives: 1 still removed, 2 still added, 3 added but
    // hidden by the Search, off-page saved 9 kept.
    expect(listed.membershipCheckboxes[0].checked).toBe(false);
    expect(listed.membershipCheckboxes[1].checked).toBe(true);
    expect(releaseHiddenMembership(initial.selection).sort()).toEqual(['3', '9']);
    expect(releaseMembershipPayload(windowObject, initial.selection).sort()).toEqual(['2', '3', '9']);
    expect(onlyGets(windowObject)).toBe(true);
    expect(windowObject.location.assign).not.toHaveBeenCalled();
  });

  it('List -> Grid during a held Search GET keeps the Search and requests Grid', async () => {
    vi.useFakeTimers();
    const initial = r3Page({ view: 'list' });
    const windowObject = r3Window(initial.document, new Map(), 'http://creatorcrate.test/releases/7/assets?selection=all&view=list');
    const requests = heldRequests(windowObject);
    enhanceReleaseAssetsLiveFiltering(initial.document);

    initial.searchInput.value = 'needle';
    initial.filter.dispatch('input', { target: initial.searchInput });
    vi.advanceTimersByTime(1000);
    expect(requests).toHaveLength(1);
    expect(query(requests[0]).get('view')).toBe('list');

    initial.grid.dispatch('click');
    expect(requests).toHaveLength(2);
    expect(query(requests[1]).get('search')).toBe('needle');
    expect(query(requests[1]).get('selection')).toBe('all');
    expect(query(requests[1]).get('view')).toBe('grid');
    expect(initial.view.value).toBe('grid');
  });

  it('composes a Search still in its debounce interval with the clicked View, as one GET', async () => {
    vi.useFakeTimers();
    const initial = r3Page();
    const windowObject = r3Window(initial.document);
    const requests = heldRequests(windowObject);
    enhanceReleaseAssetsLiveFiltering(initial.document);

    initial.searchInput.value = 'needle';
    initial.filter.dispatch('input', { target: initial.searchInput });
    vi.advanceTimersByTime(100);
    expect(requests).toHaveLength(0);
    initial.list.dispatch('click');
    vi.advanceTimersByTime(1000);
    expect(requests).toHaveLength(1);
    expect(query(requests[0]).get('search')).toBe('needle');
    expect(query(requests[0]).get('selection')).toBe('all');
    expect(query(requests[0]).get('view')).toBe('list');
  });

  it('keeps a pending View when the page size or Search changes before it installs', async () => {
    vi.useFakeTimers();
    const initial = r3Page({ search: 'needle' });
    const windowObject = r3Window(initial.document);
    const requests = heldRequests(windowObject);
    enhanceReleaseAssetsLiveFiltering(initial.document);

    initial.list.dispatch('click');
    expect(query(requests[0]).get('view')).toBe('list');

    initial.pageSize.value = '50';
    initial.pageSizeForm.dispatch('change', { target: initial.pageSize });
    expect(requests).toHaveLength(2);
    expect(query(requests[1]).get('view')).toBe('list');
    expect(query(requests[1]).get('pageSize')).toBe('50');
    expect(query(requests[1]).get('search')).toBe('needle');

    initial.searchInput.value = 'needles';
    initial.filter.dispatch('input', { target: initial.searchInput });
    vi.advanceTimersByTime(1000);
    expect(requests).toHaveLength(3);
    expect(query(requests[2]).get('view')).toBe('list');
    expect(query(requests[2]).get('pageSize')).toBe('50');
    expect(query(requests[2]).get('search')).toBe('needles');
    expect(query(requests[2]).get('selection')).toBe('all');
  });

  it('applies pagination to a held combined Search + page-size GET', async () => {
    vi.useFakeTimers();
    const initial = r3Page({ extension: 'png', category: '3' });
    const windowObject = r3Window(initial.document);
    const requests = heldRequests(windowObject);
    enhanceReleaseAssetsLiveFiltering(initial.document);

    searchThenPageSizeTen(initial, windowObject);
    initial.next.dispatch('click');
    expect(requests).toHaveLength(2);
    const paged = query(requests[1]);
    expect(paged.get('page')).toBe('2');
    expect(paged.get('search')).toBe('needle');
    expect(paged.get('pageSize')).toBe('10');
    expect(paged.get('selection')).toBe('all');
    expect(paged.get('extension')).toBe('png');
    expect(paged.get('category')).toBe('3');
    // Grid stays implicit, as in the rendered page-size form.
    expect(paged.has('view')).toBe(false);
  });

  it('keeps View All with a pending Search through a View change', async () => {
    vi.useFakeTimers();
    const initial = r3Page({ dialogOpen: true });
    const windowObject = r3Window(initial.document);
    const requests = heldRequests(windowObject);
    enhanceReleaseAssetsLiveFiltering(initial.document);

    initial.searchInput.value = 'needle';
    initial.filter.dispatch('input', { target: initial.searchInput });
    initial.filterPageSize.value = 'all';
    initial.filter.dispatch('change', { target: initial.filterPageSize });
    expect(initial.pageSize.value).toBe('all');
    expect(query(requests[0]).get('pageSize')).toBe('all');

    initial.list.dispatch('click');
    expect(query(requests[1]).get('pageSize')).toBe('all');
    expect(query(requests[1]).get('search')).toBe('needle');
    expect(query(requests[1]).get('view')).toBe('list');
  });

  it('composes a View change after a failed filter GET and Retry repeats only that GET', async () => {
    vi.useFakeTimers();
    const initial = r3Page();
    const windowObject = r3Window(initial.document);
    windowObject.fetch.mockRejectedValue(new Error('offline'));
    enhanceReleaseAssetsLiveFiltering(initial.document);
    editDraft(initial);

    searchThenPageSizeTen(initial, windowObject);
    await flush();
    expect(liveFailureRetries(initial.document)).toHaveLength(1);
    expect(regionOf(initial)).toBe(initial.region);

    initial.list.dispatch('click');
    await flush();
    expect(windowObject.fetch).toHaveBeenCalledTimes(2);
    const composed = new URL(windowObject.fetch.mock.calls[1][0]);
    expect(composed.searchParams.get('search')).toBe('needle');
    expect(composed.searchParams.get('pageSize')).toBe('10');
    expect(composed.searchParams.get('selection')).toBe('all');
    expect(composed.searchParams.get('view')).toBe('list');

    liveFailureRetries(initial.document)[0].dispatch('click');
    await flush();
    expect(windowObject.fetch).toHaveBeenCalledTimes(3);
    expect(windowObject.fetch.mock.calls[2][0]).toBe(composed.href);
    expect(onlyGets(windowObject)).toBe(true);
    expect(releaseMembershipPayload(windowObject, initial.selection).sort()).toEqual(['2', '3', '9']);
  });

  it('Clear with a pending Search and a held View GET resets filters only, keeping View and size', async () => {
    vi.useFakeTimers();
    const initial = r3Page({ extension: 'png', category: '3', pageSize: '10' });
    const cleared = makeReleaseAssetsPage({
      view: 'list', pageSize: '10', extension: '', category: '', selectionFilter: 'selected',
      assets: [{ id: '1', selected: true }], offPageSelectedIds: ['9'], persistedSelectedIds: ['1', '9'],
    });
    const windowObject = r3Window(initial.document, new Map([['cleared', cleared.document]]));
    const requests = heldRequests(windowObject);
    enhanceReleaseAssetsLiveFiltering(initial.document);
    editDraft(initial);

    initial.list.dispatch('click');
    initial.searchInput.value = 'needle';
    initial.filter.dispatch('input', { target: initial.searchInput });
    initial.reset.dispatch('click');
    vi.advanceTimersByTime(1000);
    expect(requests).toHaveLength(2);
    const clearUrl = query(requests[1]);
    expect(clearUrl.has('search')).toBe(false);
    expect(clearUrl.has('extension')).toBe(false);
    expect(clearUrl.has('category')).toBe(false);
    expect(clearUrl.has('selection')).toBe(false);
    expect(clearUrl.has('page')).toBe(false);
    expect(clearUrl.get('view')).toBe('list');
    expect(clearUrl.get('pageSize')).toBe('10');

    requests[1].resolve(responseFor('cleared', requests[1].url.href));
    await flush();
    expect(regionOf(initial)).toBe(cleared.region);
    expect(releaseMembershipPayload(windowObject, initial.selection).sort()).toEqual(['2', '3', '9']);
    expect(onlyGets(windowObject)).toBe(true);
  });

  it('Back during loading owns the destination; a View click then composes with the history address', async () => {
    vi.useFakeTimers();
    const initial = r3Page({ search: 'needle', pageSize: '10' });
    const windowObject = r3Window(initial.document);
    const requests = heldRequests(windowObject);
    enhanceReleaseAssetsLiveFiltering(initial.document);

    initial.list.dispatch('click');
    expect(initial.view.value).toBe('list');
    const historyHref = 'http://creatorcrate.test/releases/7/assets?search=older&pageSize=50';
    windowObject.location.href = historyHref;
    windowObject.dispatch('popstate');
    expect(requests).toHaveLength(2);
    expect(requests[1].url.href).toBe(historyHref);
    expect(initial.view.value).toBe('grid');

    initial.list.dispatch('click');
    expect(requests).toHaveLength(3);
    expect(query(requests[2]).get('search')).toBe('older');
    expect(query(requests[2]).get('pageSize')).toBe('50');
    expect(query(requests[2]).get('view')).toBe('list');
    expect(query(requests[2]).has('selection')).toBe(false);
    expect(windowObject.history.pushes).toHaveLength(0);
  });

  it('follows an idle View link unchanged', async () => {
    const initial = r3Page();
    const windowObject = r3Window(initial.document);
    const requests = heldRequests(windowObject);
    enhanceReleaseAssetsLiveFiltering(initial.document);

    initial.list.dispatch('click');
    expect(requests[0].url.href).toBe(new URL(initial.list.getAttribute('href'), windowObject.location.href).href);
  });
});

/*
 * R5: a Back/Forward that starts while an earlier page-size (or filter) GET
 * is still pending replaces that abandoned intent the moment it starts. Its
 * own page size (implicit 25 included) and filters then own every following
 * View, Clear or filter action until a newer explicit choice is made.
 */
describe('R5 Release Manage Assets history owns page size and filters', () => {
  beforeEach(() => { vi.useRealTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const ASSETS = [{ id: '1', selected: true }, { id: '2', selected: false }, { id: '3', selected: false }];
  const BASE = 'http://creatorcrate.test/releases/7/assets';

  function r5Window(document, pages = new Map(), href = `${BASE}?selection=all&pageSize=50`) {
    const windowObject = makeWindow(document, pages);
    windowObject.location.href = href;
    windowObject.location.pathname = '/releases/7/assets';
    windowObject.location.assign = vi.fn();
    return windowObject;
  }

  function r5Page(options = {}) {
    return makeReleaseAssetsPage({
      pageSize: '50', extension: '', category: '', selectionFilter: 'all',
      assets: ASSETS, offPageSelectedIds: ['9'], ...options,
    });
  }

  // Unsaved draft: add 2 and 3, remove saved 1; saved 9 is off page.
  function editDraft(page) {
    const [one, two, three] = page.membershipCheckboxes;
    one.checked = false;
    page.document.dispatch('change', { target: one });
    two.checked = true;
    page.document.dispatch('change', { target: two });
    three.checked = true;
    page.document.dispatch('change', { target: three });
  }

  const regionOf = (page) => page.document.querySelector('[data-release-assets-live-region]');
  const query = (request) => request.url.searchParams;
  const onlyGets = (windowObject) => windowObject.fetch.mock.calls
    .every(([, init]) => init.method === 'GET' && init.body === undefined);
  const sizeControls = (page) => page.document
    .querySelectorAll('select[name="pageSize"][data-release-assets-live-page-size]').map((control) => control.value);

  function choosePaginationSize(page, value) {
    page.pageSize.value = value;
    page.pageSizeForm.dispatch('change', { target: page.pageSize });
  }

  function historyTo(windowObject, href) {
    windowObject.location.href = href;
    windowObject.dispatch('popstate');
  }

  it('reviewer reproduction: size 25 held -> Back to size 10 held -> List keeps size 10, Selection=all', async () => {
    const initial = r5Page();
    const listed = r5Page({
      view: 'list', pageSize: '10', assets: [{ id: '1', selected: true }, { id: '2', selected: false }],
      persistedSelectedIds: ['1', '9'],
    });
    const back = r5Page({ pageSize: '10', assets: [{ id: '1', selected: true }] });
    const windowObject = r5Window(initial.document, new Map([['listed', listed.document], ['back', back.document]]));
    const requests = heldRequests(windowObject);
    enhanceReleaseAssetsLiveFiltering(initial.document);
    editDraft(initial);

    choosePaginationSize(initial, '25');
    expect(requests).toHaveLength(1);
    expect(query(requests[0]).get('pageSize')).toBe('25');
    expect(sizeControls(initial)).toEqual(['25', '25']);

    historyTo(windowObject, `${BASE}?selection=all&pageSize=10`);
    expect(requests).toHaveLength(2);
    expect(requests[0].init.signal.aborted).toBe(true);
    expect(requests[1].url.href).toBe(`${BASE}?selection=all&pageSize=10`);
    // Both controls follow the history destination before it installs.
    expect(sizeControls(initial)).toEqual(['10', '10']);

    initial.list.dispatch('click');
    expect(requests).toHaveLength(3);
    expect(requests[1].init.signal.aborted).toBe(true);
    const composed = requests[2].url;
    expect(composed.pathname).toBe('/releases/7/assets');
    expect(composed.searchParams.get('pageSize')).toBe('10');
    expect(composed.searchParams.get('view')).toBe('list');
    expect(composed.searchParams.get('selection')).toBe('all');
    expect(composed.searchParams.has('page')).toBe(false);
    expect(sizeControls(initial)).toEqual(['10', '10']);

    requests[2].resolve(responseFor('listed', composed.href));
    await flush();
    expect(regionOf(initial)).toBe(listed.region);
    const shown = windowObject.location.href;
    expect(new URL(shown).searchParams.get('pageSize')).toBe('10');
    expect(windowObject.history.pushes).toHaveLength(1);
    expect(windowObject.history.pushes[0].url).toBe(composed.href);
    expect(windowObject.history.replaces).toHaveLength(0);

    // The abandoned Back answer and the size-25 failure delivered last change
    // nothing, and the older failure raises no notice.
    requests[1].resolve(responseFor('back', requests[1].url.href));
    await flush();
    requests[0].reject(new Error('offline'));
    await flush();
    expect(regionOf(initial)).toBe(listed.region);
    expect(windowObject.location.href).toBe(shown);
    expect(liveFailureNotice(initial.document)).toBeNull();
    expect(sizeControls(initial)).toEqual(['10', '10']);
    expect(listed.selectionAll.checked).toBe(true);
    expect(listed.view.value).toBe('list');

    // Draft membership: 1 removed, 2 added, hidden 3 added, off-page 9 kept.
    expect(releaseMembershipPayload(windowObject, initial.selection).sort()).toEqual(['2', '3', '9']);
    expect(onlyGets(windowObject)).toBe(true);
    expect(windowObject.location.assign).not.toHaveBeenCalled();
  });

  it('Forward during a held View All composes List -> Grid with the forward entry', async () => {
    const initial = r5Page({ view: 'list', pageSize: '10' });
    const windowObject = r5Window(initial.document, new Map(), `${BASE}?selection=all&pageSize=10&view=list`);
    const requests = heldRequests(windowObject);
    enhanceReleaseAssetsLiveFiltering(initial.document);

    initial.filterPageSize.value = 'all';
    initial.filter.dispatch('change', { target: initial.filterPageSize });
    expect(query(requests[0]).get('pageSize')).toBe('all');
    expect(sizeControls(initial)).toEqual(['all', 'all']);

    historyTo(windowObject, `${BASE}?selection=all&search=fwd&extension=jpg&category=4&pageSize=50&view=list`);
    expect(sizeControls(initial)).toEqual(['50', '50']);
    expect(initial.searchInput.value).toBe('fwd');
    expect(initial.view.value).toBe('list');

    initial.grid.dispatch('click');
    expect(requests).toHaveLength(3);
    const composed = query(requests[2]);
    expect(composed.get('pageSize')).toBe('50');
    expect(composed.get('search')).toBe('fwd');
    expect(composed.get('selection')).toBe('all');
    expect(composed.get('extension')).toBe('jpg');
    expect(composed.get('category')).toBe('4');
    // Only View changes, as the rendered Grid link spells it.
    expect(composed.get('view')).toBe(new URL(initial.grid.getAttribute('href'), BASE).searchParams.get('view'));
    expect(composed.get('view')).not.toBe('list');
    expect(composed.has('page')).toBe(false);
  });

  it('Back -> Clear keeps the history size, clears the filters and keeps the draft', async () => {
    const initial = r5Page({ extension: 'png', category: '3', search: 'needle' });
    const cleared = makeReleaseAssetsPage({
      pageSize: '10', extension: '', category: '', selectionFilter: 'selected',
      assets: [{ id: '1', selected: true }], offPageSelectedIds: ['9'], persistedSelectedIds: ['1', '9'],
    });
    const windowObject = r5Window(initial.document, new Map([['cleared', cleared.document]]),
      `${BASE}?selection=all&search=needle&extension=png&category=3&pageSize=50`);
    const requests = heldRequests(windowObject);
    enhanceReleaseAssetsLiveFiltering(initial.document);
    editDraft(initial);

    choosePaginationSize(initial, '25');
    historyTo(windowObject, `${BASE}?selection=all&extension=png&category=3&pageSize=10`);
    initial.reset.dispatch('click');
    expect(requests).toHaveLength(3);
    const clearUrl = query(requests[2]);
    expect(clearUrl.get('pageSize')).toBe('10');
    expect(clearUrl.has('search')).toBe(false);
    expect(clearUrl.has('extension')).toBe(false);
    expect(clearUrl.has('category')).toBe(false);
    expect(clearUrl.has('selection')).toBe(false);
    expect(clearUrl.has('page')).toBe(false);
    expect(clearUrl.get('view')).not.toBe('list');

    requests[2].resolve(responseFor('cleared', requests[2].url.href));
    await flush();
    requests[0].resolve(responseFor('cleared', requests[0].url.href));
    await flush();
    expect(regionOf(initial)).toBe(cleared.region);
    expect(sizeControls(initial)).toEqual(['10', '10']);
    expect(releaseMembershipPayload(windowObject, initial.selection).sort()).toEqual(['2', '3', '9']);
    expect(onlyGets(windowObject)).toBe(true);
  });

  it('Back -> Category composes the change with the history size and filters, not the abandoned ones', async () => {
    const initial = r5Page({ search: 'needle', extension: 'png', category: '3' });
    const windowObject = r5Window(initial.document, new Map(),
      `${BASE}?selection=all&search=needle&extension=png&category=3&pageSize=50`);
    const requests = heldRequests(windowObject);
    enhanceReleaseAssetsLiveFiltering(initial.document);

    choosePaginationSize(initial, '25');
    historyTo(windowObject, `${BASE}?selection=all&pageSize=10`);
    // The dialog follows the history entry, without a change event or GET.
    expect(requests).toHaveLength(2);
    expect(initial.searchInput.value).toBe('');
    expect(initial.extensionAll.checked).toBe(true);
    expect(initial.categoryAll.checked).toBe(true);
    expect(initial.selectionAll.checked).toBe(true);

    initial.categoryAll.checked = false;
    initial.categoryFour.checked = true;
    initial.filter.dispatch('change', { target: initial.categoryFour });
    expect(requests).toHaveLength(3);
    const changed = query(requests[2]);
    expect(changed.get('pageSize')).toBe('10');
    expect(changed.get('category')).toBe('4');
    expect(changed.get('selection')).toBe('all');
    expect(changed.has('search')).toBe(false);
    expect(changed.has('extension')).toBe(false);
    expect(changed.get('view')).not.toBe('list');
  });

  it('Back -> Search and Back -> Selection compose with the history entry', async () => {
    vi.useFakeTimers();
    const initial = r5Page({ category: '3' });
    const windowObject = r5Window(initial.document, new Map(), `${BASE}?selection=all&category=3&pageSize=50`);
    const requests = heldRequests(windowObject);
    enhanceReleaseAssetsLiveFiltering(initial.document);

    choosePaginationSize(initial, 'all');
    historyTo(windowObject, `${BASE}?category=4&pageSize=10`);
    expect(initial.selectionSelected.checked).toBe(true);
    expect(initial.categoryFour.checked).toBe(true);

    initial.searchInput.value = 'typed';
    initial.filter.dispatch('input', { target: initial.searchInput });
    vi.advanceTimersByTime(1000);
    expect(requests).toHaveLength(3);
    const searched = query(requests[2]);
    expect(searched.get('search')).toBe('typed');
    expect(searched.get('pageSize')).toBe('10');
    expect(searched.get('category')).toBe('4');
    // The history entry's default Selection, not the abandoned 'all'.
    expect(searched.get('selection') || 'selected').toBe('selected');

    historyTo(windowObject, `${BASE}?category=4&pageSize=10`);
    expect(initial.searchInput.value).toBe('');
    initial.selectionSelected.checked = false;
    initial.selectionAll.checked = true;
    initial.filter.dispatch('change', { target: initial.selectionAll });
    expect(requests).toHaveLength(5);
    const selected = query(requests[4]);
    expect(selected.get('selection')).toBe('all');
    expect(selected.get('pageSize')).toBe('10');
    expect(selected.get('category')).toBe('4');
    expect(selected.has('search')).toBe(false);
  });

  it('a new explicit size chosen after Back wins over the history size', async () => {
    const initial = r5Page();
    const windowObject = r5Window(initial.document);
    const requests = heldRequests(windowObject);
    enhanceReleaseAssetsLiveFiltering(initial.document);

    choosePaginationSize(initial, '25');
    historyTo(windowObject, `${BASE}?selection=all&pageSize=10`);
    initial.filterPageSize.value = '200';
    initial.filter.dispatch('change', { target: initial.filterPageSize });
    expect(query(requests[2]).get('pageSize')).toBe('200');
    expect(sizeControls(initial)).toEqual(['200', '200']);

    initial.list.dispatch('click');
    expect(query(requests[3]).get('pageSize')).toBe('200');
    expect(query(requests[3]).get('view')).toBe('list');
    expect(query(requests[3]).get('selection')).toBe('all');
  });

  it('size 50 pending -> Back to the implicit default 25 -> Grid keeps 25 implicit', async () => {
    const initial = r5Page({ view: 'list', pageSize: '10' });
    const windowObject = r5Window(initial.document, new Map(), `${BASE}?selection=all&pageSize=10&view=list`);
    const requests = heldRequests(windowObject);
    enhanceReleaseAssetsLiveFiltering(initial.document);

    choosePaginationSize(initial, '50');
    historyTo(windowObject, `${BASE}?selection=all&view=list`);
    expect(sizeControls(initial)).toEqual(['25', '25']);

    initial.grid.dispatch('click');
    expect(query(requests[2]).has('pageSize')).toBe(false);
    expect(query(requests[2]).get('selection')).toBe('all');
    expect(query(requests[2]).get('view')).not.toBe('list');
  });

  it('View All pending -> Back to size 10 -> List requests size 10', async () => {
    const initial = r5Page();
    const windowObject = r5Window(initial.document);
    const requests = heldRequests(windowObject);
    enhanceReleaseAssetsLiveFiltering(initial.document);

    choosePaginationSize(initial, 'all');
    expect(query(requests[0]).get('pageSize')).toBe('all');
    historyTo(windowObject, `${BASE}?selection=all&pageSize=10`);
    expect(sizeControls(initial)).toEqual(['10', '10']);
    initial.list.dispatch('click');
    expect(query(requests[2]).get('pageSize')).toBe('10');
    expect(query(requests[2]).get('view')).toBe('list');
  });

  it('a failed Back keeps its size for a View change; Retry repeats only the latest GET', async () => {
    const initial = r5Page();
    const windowObject = r5Window(initial.document);
    const requests = heldRequests(windowObject);
    enhanceReleaseAssetsLiveFiltering(initial.document);
    editDraft(initial);

    choosePaginationSize(initial, '25');
    historyTo(windowObject, `${BASE}?selection=all&pageSize=10`);
    requests[1].reject(new Error('offline'));
    await flush();
    expect(liveFailureRetries(initial.document)).toHaveLength(1);
    expect(regionOf(initial)).toBe(initial.region);
    expect(sizeControls(initial)).toEqual(['10', '10']);

    // Retry repeats the failed Back.
    liveFailureRetries(initial.document)[0].dispatch('click');
    expect(requests).toHaveLength(3);
    expect(requests[2].url.href).toBe(`${BASE}?selection=all&pageSize=10`);
    requests[2].reject(new Error('offline'));
    await flush();
    expect(sizeControls(initial)).toEqual(['10', '10']);

    initial.list.dispatch('click');
    expect(requests).toHaveLength(4);
    expect(query(requests[3]).get('pageSize')).toBe('10');
    expect(query(requests[3]).get('view')).toBe('list');
    expect(query(requests[3]).get('selection')).toBe('all');
    requests[3].reject(new Error('offline'));
    await flush();

    liveFailureRetries(initial.document)[0].dispatch('click');
    expect(requests).toHaveLength(5);
    expect(requests[4].url.href).toBe(requests[3].url.href);
    // The abandoned size-25 failure arrives last and restores nothing.
    requests[0].reject(new Error('offline'));
    await flush();
    expect(sizeControls(initial)).toEqual(['10', '10']);
    expect(onlyGets(windowObject)).toBe(true);
    expect(releaseMembershipPayload(windowObject, initial.selection).sort()).toEqual(['2', '3', '9']);
  });

  it('a failed size GET followed by Back lets Back own the size', async () => {
    const initial = r5Page();
    const windowObject = r5Window(initial.document);
    const requests = heldRequests(windowObject);
    enhanceReleaseAssetsLiveFiltering(initial.document);

    choosePaginationSize(initial, '100');
    requests[0].reject(new Error('offline'));
    await flush();
    expect(sizeControls(initial)).toEqual(['100', '100']);

    historyTo(windowObject, `${BASE}?selection=all&pageSize=10`);
    expect(liveFailureRetries(initial.document)).toHaveLength(0);
    expect(sizeControls(initial)).toEqual(['10', '10']);
    initial.reset.dispatch('click');
    expect(query(requests[2]).get('pageSize')).toBe('10');
  });

  it('three overlapping actions: only the newest response installs', async () => {
    const initial = r5Page();
    const newest = r5Page({ view: 'list', pageSize: '10', category: '4', assets: [{ id: '2', selected: false }] });
    const older = r5Page({ pageSize: '25', assets: [{ id: '3', selected: false }] });
    const windowObject = r5Window(initial.document, new Map([['newest', newest.document], ['older', older.document]]));
    const requests = heldRequests(windowObject);
    enhanceReleaseAssetsLiveFiltering(initial.document);

    choosePaginationSize(initial, '25');
    historyTo(windowObject, `${BASE}?selection=all&pageSize=10&view=list`);
    initial.categoryAll.checked = false;
    initial.categoryFour.checked = true;
    initial.filter.dispatch('change', { target: initial.categoryFour });
    expect(requests).toHaveLength(3);
    expect(query(requests[2]).get('pageSize')).toBe('10');
    expect(query(requests[2]).get('view')).toBe('list');
    expect(query(requests[2]).get('category')).toBe('4');
    expect(query(requests[2]).get('selection')).toBe('all');

    requests[2].resolve(responseFor('newest', requests[2].url.href));
    await flush();
    requests[1].resolve(responseFor('older', requests[1].url.href));
    requests[0].resolve(responseFor('older', requests[0].url.href));
    await flush();
    expect(regionOf(initial)).toBe(newest.region);
    expect(windowObject.location.href).toBe(requests[2].url.href);
    expect(sizeControls(initial)).toEqual(['10', '10']);
    expect(newest.categoryFour.checked).toBe(true);
    expect(windowObject.history.pushes).toHaveLength(1);
  });

  it('a read-only release gains no controls from Back', async () => {
    const initial = r5Page({ readOnly: true });
    const windowObject = r5Window(initial.document);
    const requests = heldRequests(windowObject);
    enhanceReleaseAssetsLiveFiltering(initial.document);

    historyTo(windowObject, `${BASE}?selection=all&pageSize=10`);
    expect(requests).toHaveLength(1);
    expect(sizeControls(initial)).toEqual([]);
    expect(initial.document.querySelectorAll('input[type="checkbox"][name="selectedAssetIds"]')).toHaveLength(0);
  });
});

/*
 * R8: Clear filters is authoritative for Search, Selection, Extension and
 * Category from the moment its GET starts. The dialog's controls follow the
 * Clear destination before it installs, so a later filter, View, page-size or
 * pagination action held, debounced or after a failed Clear changes only its
 * own dimension and never reserializes the restrictions Clear removed.
 */
describe('R8 Release Manage Assets Clear owns the filters a later edit composes with', () => {
  beforeEach(() => { vi.useRealTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const BASE = 'http://creatorcrate.test/releases/7/assets';
  const INSTALLED = `${BASE}?view=list&pageSize=10&search=asset&extension=png&category=3&selection=all`;
  const ASSETS = [{ id: '1', selected: true }, { id: '2', selected: false }, { id: '3', selected: false }];

  function r8Window(document, pages = new Map(), href = INSTALLED) {
    const windowObject = makeWindow(document, pages);
    windowObject.location.href = href;
    windowObject.location.pathname = '/releases/7/assets';
    windowObject.location.assign = vi.fn();
    return windowObject;
  }

  // Installed: List, size 10, Search=asset, Extension=png, Category=3, All assets.
  function r8Page(options = {}) {
    return makeReleaseAssetsPage({
      view: 'list', pageSize: '10', search: 'asset', extension: 'png', category: '3', selectionFilter: 'all',
      assets: ASSETS, offPageSelectedIds: ['9'], ...options,
    });
  }

  function clearedPage(options = {}) {
    return makeReleaseAssetsPage({
      view: 'list', pageSize: '10', search: '', extension: '', category: '', selectionFilter: 'selected',
      assets: [{ id: '1', selected: true }], offPageSelectedIds: ['9'], persistedSelectedIds: ['1', '9'], ...options,
    });
  }

  // Unsaved draft: add 2 and 3, remove saved 1; saved 9 is off page.
  function editDraft(page) {
    const [one, two, three] = page.membershipCheckboxes;
    one.checked = false;
    page.document.dispatch('change', { target: one });
    two.checked = true;
    page.document.dispatch('change', { target: two });
    three.checked = true;
    page.document.dispatch('change', { target: three });
  }

  const regionOf = (page) => page.document.querySelector('[data-release-assets-live-region]');
  // The filter form spells the default Selection and Grid explicitly where the
  // rendered links leave them implicit; both spellings mean the same intent.
  const params = (request) => Array.from(request.url.searchParams.entries())
    .filter(([key, value]) => !(key === 'selection' && value === 'selected') && !(key === 'view' && value === 'grid'))
    .sort(([left], [right]) => left.localeCompare(right));
  const onlyGets = (windowObject) => windowObject.fetch.mock.calls
    .every(([, init]) => init.method === 'GET' && init.body === undefined);
  const sizeControls = (page) => page.document
    .querySelectorAll('select[name="pageSize"][data-release-assets-live-page-size]').map((control) => control.value);

  function expectClearedControls(page) {
    expect(page.searchInput.value).toBe('');
    expect(page.selectionSelected.checked).toBe(true);
    expect(page.selectionAll.checked).toBe(false);
    expect(page.extensionAll.checked).toBe(true);
    expect(page.extensionPng.checked).toBe(false);
    expect(page.categoryAll.checked).toBe(true);
    expect(page.categoryThree.checked).toBe(false);
  }

  function choose(page, all, target) {
    all.forEach((radio) => { radio.checked = radio === target; });
    page.filter.dispatch('change', { target });
  }

  // The installed dialog's controls live in the original filter form.
  function typeSearch(page, value, form = page.filter) {
    page.searchInput.value = value;
    form.dispatch('input', { target: page.searchInput });
  }

  function historyTo(windowObject, href) {
    windowObject.location.href = href;
    windowObject.dispatch('popstate');
  }

  it('reviewer reproduction: Clear held -> Search=asset-01 composes with Clear, not the installed filters', async () => {
    vi.useFakeTimers();
    const initial = r8Page();
    const searched = makeReleaseAssetsPage({
      view: 'list', pageSize: '10', search: 'asset-01', extension: '', category: '', selectionFilter: 'selected',
      assets: [], offPageSelectedIds: ['1', '9'],
    });
    const stale = clearedPage();
    const windowObject = r8Window(initial.document, new Map([['searched', searched.document], ['stale', stale.document]]));
    const requests = heldRequests(windowObject);
    enhanceReleaseAssetsLiveFiltering(initial.document);
    editDraft(initial);
    expect(releaseMembershipPayload(windowObject, initial.selection).sort()).toEqual(['2', '3', '9']);

    const click = initial.reset.dispatch('click');
    expect(click.defaultPrevented).toBe(true);
    expect(requests).toHaveLength(1);
    // Clear's destination keeps only View and page size.
    expect(params(requests[0])).toEqual([['pageSize', '10'], ['view', 'list']]);
    // The dialog follows Clear before it installs, without another GET.
    expectClearedControls(initial);
    expect(initial.view.value).toBe('list');
    expect(sizeControls(initial)).toEqual(['10', '10']);
    expect(requests).toHaveLength(1);

    typeSearch(initial, 'asset-01');
    vi.advanceTimersByTime(1000);
    expect(requests).toHaveLength(2);
    expect(requests[0].init.signal.aborted).toBe(true);
    expect(params(requests[1])).toEqual([['pageSize', '10'], ['search', 'asset-01'], ['view', 'list']]);

    requests[1].resolve(responseFor('searched', requests[1].url.href));
    await flush();
    expect(regionOf(initial)).toBe(searched.region);
    const shown = windowObject.location.href;
    expect(shown).toBe(requests[1].url.href);
    expect(windowObject.history.pushes).toHaveLength(1);

    // The original Clear answer delivered last installs nothing.
    requests[0].resolve(responseFor('stale', requests[0].url.href));
    await flush();
    expect(regionOf(initial)).toBe(searched.region);
    expect(windowObject.location.href).toBe(shown);
    expect(windowObject.history.pushes).toHaveLength(1);
    expect(liveFailureNotice(initial.document)).toBeNull();

    // Final dialog matches the URL; zero matching assets are rendered.
    expect(initial.filter.contains(searched.searchInput)).toBe(true);
    expect(searched.searchInput.value).toBe('asset-01');
    expect(searched.selectionSelected.checked).toBe(true);
    expect(searched.extensionAll.checked).toBe(true);
    expect(searched.categoryAll.checked).toBe(true);
    expect(searched.view.value).toBe('list');
    expect(sizeControls(initial)).toEqual(['10', '10']);
    expect(regionOf(initial).querySelectorAll('input[type="checkbox"][name="selectedAssetIds"]')).toHaveLength(0);

    // Draft: 1 removed, 2 and 3 added (now hidden), 9 kept.
    expect(releaseMembershipPayload(windowObject, initial.selection).sort()).toEqual(['2', '3', '9']);
    expect(onlyGets(windowObject)).toBe(true);
    expect(windowObject.location.assign).not.toHaveBeenCalled();
  });

  it('Clear held -> Category, Extension or Selection changes only that dimension', async () => {
    const edits = [
      [(page) => choose(page, [page.categoryAll, page.categoryThree, page.categoryFour], page.categoryFour), ['category', '4']],
      [(page) => choose(page, [page.extensionAll, page.extensionPng, page.extensionJpg], page.extensionJpg), ['extension', 'jpg']],
      [(page) => choose(page, [page.selectionSelected, page.selectionAll], page.selectionAll), ['selection', 'all']],
    ];
    for (const [edit, expected] of edits) {
      const initial = r8Page();
      const windowObject = r8Window(initial.document);
      const requests = heldRequests(windowObject);
      enhanceReleaseAssetsLiveFiltering(initial.document);

      initial.reset.dispatch('click');
      edit(initial);
      expect(requests).toHaveLength(2);
      expect(requests[0].init.signal.aborted).toBe(true);
      expect(params(requests[1])).toEqual([expected, ['pageSize', '10'], ['view', 'list']]
        .sort(([left], [right]) => left.localeCompare(right)));
      expect(initial.searchInput.value).toBe('');
      expect(onlyGets(windowObject)).toBe(true);
    }
  });

  it('Clear held -> View, page size, pagination or another Clear keep the cleared filters', async () => {
    const run = (act) => {
      const initial = r8Page();
      const windowObject = r8Window(initial.document);
      const requests = heldRequests(windowObject);
      enhanceReleaseAssetsLiveFiltering(initial.document);
      initial.reset.dispatch('click');
      act(initial);
      expect(requests).toHaveLength(2);
      expect(onlyGets(windowObject)).toBe(true);
      return { initial, request: requests[1], clear: requests[0] };
    };

    const grid = run((page) => page.grid.dispatch('click'));
    expect(params(grid.request)).toEqual([['pageSize', '10']]);
    expect(grid.request.url.searchParams.get('view')).toBe('grid');
    expect(grid.initial.view.value).toBe('grid');

    const sized = run((page) => {
      page.pageSize.value = '50';
      page.pageSizeForm.dispatch('change', { target: page.pageSize });
    });
    expect(params(sized.request)).toEqual([['pageSize', '50'], ['view', 'list']]);
    expect(sizeControls(sized.initial)).toEqual(['50', '50']);

    const dialogSized = run((page) => {
      page.filterPageSize.value = 'all';
      page.filter.dispatch('change', { target: page.filterPageSize });
    });
    expect(params(dialogSized.request)).toEqual([['pageSize', 'all'], ['view', 'list']]);

    const paged = run((page) => page.next.dispatch('click'));
    expect(params(paged.request)).toEqual([['page', '2'], ['pageSize', '10'], ['view', 'list']]);

    const again = run((page) => page.reset.dispatch('click'));
    expect(again.request.url.href).toBe(again.clear.url.href);
    expectClearedControls(again.initial);
  });

  it('debounced Search: an older timer cannot fire after Clear and only the latest Search is sent', async () => {
    vi.useFakeTimers();
    const initial = r8Page();
    const windowObject = r8Window(initial.document);
    const requests = heldRequests(windowObject);
    enhanceReleaseAssetsLiveFiltering(initial.document);

    // A Search still debouncing when Clear is clicked is cleared with it.
    typeSearch(initial, 'pending');
    vi.advanceTimersByTime(100);
    initial.reset.dispatch('click');
    expect(requests).toHaveLength(1);
    expect(params(requests[0])).toEqual([['pageSize', '10'], ['view', 'list']]);
    expectClearedControls(initial);
    vi.advanceTimersByTime(1000);
    expect(requests).toHaveLength(1);

    // Two rapid edits after Clear: one GET with the latest value.
    typeSearch(initial, 'a');
    vi.advanceTimersByTime(100);
    typeSearch(initial, 'asset-01');
    vi.advanceTimersByTime(1000);
    expect(requests).toHaveLength(2);
    expect(params(requests[1])).toEqual([['pageSize', '10'], ['search', 'asset-01'], ['view', 'list']]);

    // A View change during a later debounce composes as one GET.
    typeSearch(initial, 'x');
    vi.advanceTimersByTime(100);
    initial.grid.dispatch('click');
    vi.advanceTimersByTime(1000);
    expect(requests).toHaveLength(3);
    expect(params(requests[2])).toEqual([['pageSize', '10'], ['search', 'x']]);
    expect(requests[2].url.searchParams.get('view')).toBe('grid');
    expect(onlyGets(windowObject)).toBe(true);
  });

  it('a failed Clear stays the latest intent: Search, Category, View and Retry compose with it', async () => {
    vi.useFakeTimers();
    const initial = r8Page();
    const windowObject = r8Window(initial.document);
    const requests = heldRequests(windowObject);
    enhanceReleaseAssetsLiveFiltering(initial.document);
    editDraft(initial);

    initial.reset.dispatch('click');
    requests[0].reject(new Error('offline'));
    await flush();
    expect(liveFailureRetries(initial.document)).toHaveLength(1);
    expect(regionOf(initial)).toBe(initial.region);
    expectClearedControls(initial);

    // Retry repeats only the failed Clear GET.
    liveFailureRetries(initial.document)[0].dispatch('click');
    expect(requests).toHaveLength(2);
    expect(requests[1].url.href).toBe(requests[0].url.href);
    requests[1].reject(new Error('offline'));
    await flush();
    expectClearedControls(initial);

    typeSearch(initial, 'asset-01');
    vi.advanceTimersByTime(1000);
    expect(requests).toHaveLength(3);
    expect(params(requests[2])).toEqual([['pageSize', '10'], ['search', 'asset-01'], ['view', 'list']]);
    requests[2].reject(new Error('offline'));
    await flush();

    choose(initial, [initial.categoryAll, initial.categoryThree, initial.categoryFour], initial.categoryFour);
    expect(params(requests[3])).toEqual([['category', '4'], ['pageSize', '10'], ['search', 'asset-01'], ['view', 'list']]);
    requests[3].reject(new Error('offline'));
    await flush();

    initial.grid.dispatch('click');
    expect(params(requests[4])).toEqual([['category', '4'], ['pageSize', '10'], ['search', 'asset-01']]);
    expect(requests[4].url.searchParams.get('view')).toBe('grid');
    requests[4].reject(new Error('offline'));
    await flush();

    // Another Clear after the failures clears again.
    initial.reset.dispatch('click');
    expect(params(requests[5])).toEqual([['pageSize', '10']]);
    expectClearedControls(initial);
    expect(onlyGets(windowObject)).toBe(true);
    expect(releaseMembershipPayload(windowObject, initial.selection).sort()).toEqual(['2', '3', '9']);
    expect(windowObject.location.assign).not.toHaveBeenCalled();
  });

  it('stale answers: a pre-Clear Search response or failure arriving last installs nothing', async () => {
    vi.useFakeTimers();
    const initial = r8Page();
    const cleared = clearedPage();
    const older = r8Page({ search: 'needle', assets: [{ id: '3', selected: false }] });
    const windowObject = r8Window(initial.document, new Map([['cleared', cleared.document], ['older', older.document]]));
    const requests = heldRequests(windowObject);
    enhanceReleaseAssetsLiveFiltering(initial.document);

    typeSearch(initial, 'needle');
    vi.advanceTimersByTime(1000);
    initial.grid.dispatch('click');
    initial.reset.dispatch('click');
    expect(requests).toHaveLength(3);
    expect(params(requests[2])).toEqual([['pageSize', '10']]);

    requests[2].resolve(responseFor('cleared', requests[2].url.href));
    await flush();
    requests[0].resolve(responseFor('older', requests[0].url.href));
    requests[1].reject(new Error('offline'));
    await flush();
    expect(regionOf(initial)).toBe(cleared.region);
    expect(windowObject.location.href).toBe(requests[2].url.href);
    expect(liveFailureNotice(initial.document)).toBeNull();
    expect(cleared.searchInput.value).toBe('');
    expect(cleared.selectionSelected.checked).toBe(true);
    expect(windowObject.history.pushes).toHaveLength(1);
  });

  it('a closed and reopened dialog still shows the pending Clear destination', async () => {
    const initial = r8Page({ dialogOpen: true });
    const windowObject = r8Window(initial.document);
    const requests = heldRequests(windowObject);
    enhanceReleaseAssetsLiveFiltering(initial.document);

    initial.reset.dispatch('click');
    initial.dialog.open = false;
    initial.dialog.open = true;
    expectClearedControls(initial);
    choose(initial, [initial.extensionAll, initial.extensionPng, initial.extensionJpg], initial.extensionJpg);
    expect(params(requests[1])).toEqual([['extension', 'jpg'], ['pageSize', '10'], ['view', 'list']]);
  });

  it('history: Clear pending -> Back owns the filters; Back pending -> Clear clears them', async () => {
    const initial = r8Page();
    const windowObject = r8Window(initial.document);
    const requests = heldRequests(windowObject);
    enhanceReleaseAssetsLiveFiltering(initial.document);

    initial.reset.dispatch('click');
    historyTo(windowObject, `${BASE}?selection=all&extension=jpg&pageSize=50`);
    expect(requests).toHaveLength(2);
    expect(initial.selectionAll.checked).toBe(true);
    expect(initial.extensionJpg.checked).toBe(true);
    expect(sizeControls(initial)).toEqual(['50', '50']);
    choose(initial, [initial.categoryAll, initial.categoryThree, initial.categoryFour], initial.categoryFour);
    expect(params(requests[2])).toEqual([
      ['category', '4'], ['extension', 'jpg'], ['pageSize', '50'], ['selection', 'all'],
    ]);

    historyTo(windowObject, `${BASE}?search=older&extension=jpg&pageSize=50`);
    expect(initial.searchInput.value).toBe('older');
    initial.reset.dispatch('click');
    expect(params(requests[4])).toEqual([['pageSize', '50']]);
    expectClearedControls(initial);
    expect(windowObject.history.pushes).toHaveLength(0);
  });

  it('history: Clear installs -> Back -> Forward to the Clear entry -> Search composes with Clear', async () => {
    vi.useFakeTimers();
    const initial = r8Page();
    const cleared = clearedPage();
    const windowObject = r8Window(initial.document, new Map([['cleared', cleared.document]]));
    const requests = heldRequests(windowObject);
    enhanceReleaseAssetsLiveFiltering(initial.document);

    initial.reset.dispatch('click');
    const clearHref = requests[0].url.href;
    requests[0].resolve(responseFor('cleared', clearHref));
    await flush();
    expect(regionOf(initial)).toBe(cleared.region);
    expect(windowObject.history.pushes).toHaveLength(1);

    historyTo(windowObject, INSTALLED);
    expect(cleared.searchInput.value).toBe('asset');
    expect(cleared.selectionAll.checked).toBe(true);
    expect(cleared.extensionPng.checked).toBe(true);
    expect(cleared.categoryThree.checked).toBe(true);

    historyTo(windowObject, clearHref);
    expectClearedControls(cleared);
    typeSearch(cleared, 'asset-01', initial.filter);
    vi.advanceTimersByTime(1000);
    expect(requests).toHaveLength(4);
    expect(params(requests[3])).toEqual([['pageSize', '10'], ['search', 'asset-01'], ['view', 'list']]);
    // One Clear produced one history entry.
    expect(windowObject.history.pushes).toHaveLength(1);
  });

  it('membership draft survives Search -> Extension -> Selection -> held Clear -> Search -> View -> size -> page', async () => {
    vi.useFakeTimers();
    const initial = r8Page({ search: '', extension: '', category: '', selectionFilter: 'selected', view: 'grid' });
    const windowObject = r8Window(initial.document, new Map(), `${BASE}?pageSize=10`);
    const requests = heldRequests(windowObject);
    enhanceReleaseAssetsLiveFiltering(initial.document);
    editDraft(initial);

    typeSearch(initial, 'asset');
    vi.advanceTimersByTime(1000);
    choose(initial, [initial.extensionAll, initial.extensionPng, initial.extensionJpg], initial.extensionPng);
    choose(initial, [initial.selectionSelected, initial.selectionAll], initial.selectionAll);
    expect(params(requests[2])).toEqual([
      ['extension', 'png'], ['pageSize', '10'], ['search', 'asset'], ['selection', 'all'],
    ]);
    initial.reset.dispatch('click');
    typeSearch(initial, 'asset-01');
    vi.advanceTimersByTime(1000);
    initial.list.dispatch('click');
    initial.pageSize.value = '25';
    initial.pageSizeForm.dispatch('change', { target: initial.pageSize });
    initial.next.dispatch('click');
    expect(requests).toHaveLength(8);
    expect(params(requests[7])).toEqual([['page', '2'], ['search', 'asset-01'], ['view', 'list']]);

    expect(releaseMembershipPayload(windowObject, initial.selection).sort()).toEqual(['2', '3', '9']);
    expect(new Set(releaseMembershipPayload(windowObject, initial.selection)).size).toBe(3);
    expect(onlyGets(windowObject)).toBe(true);
    expect(windowObject.location.assign).not.toHaveBeenCalled();
  });
});

/*
 * P3 correction 4: Manage Assets honours only the page sizes its two controls
 * offer. The server renders any other pageSize (7, 15, 201, abc, ALL, a
 * repeated value, ...) at the default 25, so a history entry or request
 * carrying one is effective size 25 on both controls and in every request
 * composed from it - never the unsupported raw value and never an older size.
 */
describe('P3-C4 Release Manage Assets unsupported page size is the effective 25', () => {
  beforeEach(() => { vi.useRealTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const BASE = 'http://creatorcrate.test/releases/7/assets';
  const ASSETS = [{ id: '1', selected: true }, { id: '2', selected: false }, { id: '3', selected: false }];

  function c4Window(document, pages = new Map(), href = `${BASE}?selection=all&pageSize=50`) {
    const windowObject = makeWindow(document, pages);
    windowObject.location.href = href;
    windowObject.location.pathname = '/releases/7/assets';
    windowObject.location.assign = vi.fn();
    return windowObject;
  }

  function c4Page(options = {}) {
    return makeReleaseAssetsPage({
      pageSize: '50', extension: '', category: '', selectionFilter: 'all',
      assets: ASSETS, offPageSelectedIds: ['9'], ...options,
    });
  }

  // Unsaved draft: add 2 and 3, remove saved 1; saved 9 is off page.
  function editDraft(page) {
    const [one, two, three] = page.membershipCheckboxes;
    one.checked = false;
    page.document.dispatch('change', { target: one });
    two.checked = true;
    page.document.dispatch('change', { target: two });
    three.checked = true;
    page.document.dispatch('change', { target: three });
  }

  const regionOf = (page) => page.document.querySelector('[data-release-assets-live-region]');
  // 25 is the service default; a request may spell it or leave it implicit.
  const sizeOf = (url) => url.searchParams.get('pageSize') || '25';
  const onlyGets = (windowObject) => windowObject.fetch.mock.calls
    .every(([, init]) => init.method === 'GET' && init.body === undefined);
  const sizeControls = (page) => page.document
    .querySelectorAll('select[name="pageSize"][data-release-assets-live-page-size]').map((control) => control.value);

  function historyTo(windowObject, href) {
    windowObject.location.href = href;
    windowObject.dispatch('popstate');
  }

  function typeSearch(page, value) {
    page.searchInput.value = value;
    page.filter.dispatch('input', { target: page.searchInput });
  }

  const UNSUPPORTED = ['7', '11', '15', '24', '26', '201', '999999', '0', '-1', 'abc', '1.5', '010', 'ALL', 'All', ''];

  for (const raw of UNSUPPORTED) {
    it(`Back to pageSize=${JSON.stringify(raw)} sets both controls to 25 and a List link composes 25`, () => {
      const initial = c4Page();
      const windowObject = c4Window(initial.document);
      const requests = heldRequests(windowObject);
      enhanceReleaseAssetsLiveFiltering(initial.document);
      expect(sizeControls(initial)).toEqual(['50', '50']);

      historyTo(windowObject, `${BASE}?selection=all&pageSize=${encodeURIComponent(raw)}`);
      expect(requests).toHaveLength(1);
      expect(sizeControls(initial)).toEqual(['25', '25']);

      initial.list.dispatch('click');
      expect(requests).toHaveLength(2);
      expect(sizeOf(requests[1].url)).toBe('25');
      expect(requests[1].url.searchParams.get('view')).toBe('list');
      expect(requests[1].url.searchParams.get('selection')).toBe('all');
      expect(onlyGets(windowObject)).toBe(true);
    });
  }

  it('a repeated or mixed pageSize in history is the effective 25, never its first value', () => {
    for (const repeated of ['pageSize=50&pageSize=10', 'pageSize=100&pageSize=abc', 'pageSize=all&pageSize=all']) {
      const initial = c4Page({ pageSize: '10' });
      const windowObject = c4Window(initial.document, new Map(), `${BASE}?selection=all&pageSize=10`);
      const requests = heldRequests(windowObject);
      enhanceReleaseAssetsLiveFiltering(initial.document);

      historyTo(windowObject, `${BASE}?selection=all&${repeated}`);
      expect(sizeControls(initial)).toEqual(['25', '25']);
      initial.grid.dispatch('click');
      expect(sizeOf(requests[1].url)).toBe('25');
      expect(requests[1].url.searchParams.getAll('pageSize').length).toBeLessThanOrEqual(1);
    }
  });

  it('every supported history size is kept on both controls and composed as is', () => {
    for (const size of ['10', '25', '50', '100', '150', '200', 'all']) {
      const initial = c4Page({ pageSize: size === '50' ? '10' : '50' });
      const windowObject = c4Window(initial.document);
      const requests = heldRequests(windowObject);
      enhanceReleaseAssetsLiveFiltering(initial.document);

      historyTo(windowObject, `${BASE}?selection=all&pageSize=${size}`);
      expect(sizeControls(initial)).toEqual([size, size]);
      initial.list.dispatch('click');
      expect(sizeOf(requests[1].url)).toBe(size);
    }
  });

  for (const raw of ['7', '15']) {
    it(`reviewer reproduction (pageSize=${raw}): direct load rendered at 25 -> Search submits 25; Back never restores ${raw}`, async () => {
      vi.useFakeTimers();
      // The server rendered the unsupported request at its effective size 25.
      const initial = c4Page({ pageSize: '25' });
      const searched = c4Page({ pageSize: '25', search: 'asset', assets: [{ id: '1', selected: true }] });
      const back = c4Page({ pageSize: '25' });
      const windowObject = c4Window(initial.document,
        new Map([['searched', searched.document], ['back', back.document]]), `${BASE}?selection=all&pageSize=${raw}`);
      const requests = heldRequests(windowObject);
      enhanceReleaseAssetsLiveFiltering(initial.document);
      editDraft(initial);
      expect(sizeControls(initial)).toEqual(['25', '25']);

      typeSearch(initial, 'asset');
      vi.advanceTimersByTime(1000);
      expect(requests).toHaveLength(1);
      expect(sizeOf(requests[0].url)).toBe('25');
      expect(requests[0].url.searchParams.get('search')).toBe('asset');
      expect(requests[0].url.searchParams.get('selection')).toBe('all');
      requests[0].resolve(responseFor('searched', requests[0].url.href));
      await flush();
      expect(regionOf(initial)).toBe(searched.region);
      expect(sizeOf(new URL(windowObject.location.href))).toBe('25');

      // Back to the unsupported direct-load entry: effective 25 at once and
      // after it installs; a later List link still composes 25.
      historyTo(windowObject, `${BASE}?selection=all&pageSize=${raw}`);
      expect(requests).toHaveLength(2);
      expect(sizeControls(initial)).toEqual(['25', '25']);
      requests[1].resolve(responseFor('back', requests[1].url.href));
      await flush();
      expect(regionOf(initial)).toBe(back.region);
      expect(sizeControls(initial)).toEqual(['25', '25']);

      initial.list.dispatch('click');
      expect(sizeOf(requests[2].url)).toBe('25');
      expect(requests[2].url.searchParams.getAll('pageSize')).not.toContain(raw);

      expect(releaseMembershipPayload(windowObject, initial.selection).sort()).toEqual(['2', '3', '9']);
      expect(onlyGets(windowObject)).toBe(true);
      expect(windowObject.location.assign).not.toHaveBeenCalled();
    });
  }

  it('pending unsupported Back -> a new supported size wins; the old answer delivered last changes nothing', async () => {
    const initial = c4Page();
    const sized = c4Page({ pageSize: '100', view: 'list' });
    const stale = c4Page({ pageSize: '25' });
    const windowObject = c4Window(initial.document, new Map([['sized', sized.document], ['stale', stale.document]]));
    const requests = heldRequests(windowObject);
    enhanceReleaseAssetsLiveFiltering(initial.document);
    editDraft(initial);

    historyTo(windowObject, `${BASE}?selection=all&pageSize=7`);
    expect(sizeControls(initial)).toEqual(['25', '25']);

    initial.filterPageSize.value = '100';
    initial.filter.dispatch('change', { target: initial.filterPageSize });
    expect(requests).toHaveLength(2);
    expect(requests[0].init.signal.aborted).toBe(true);
    expect(sizeOf(requests[1].url)).toBe('100');
    expect(sizeControls(initial)).toEqual(['100', '100']);

    // A Grid/List link while the new size is held keeps 100, not 25 or 7.
    initial.list.dispatch('click');
    expect(sizeOf(requests[2].url)).toBe('100');

    requests[2].resolve(responseFor('sized', requests[2].url.href));
    await flush();
    requests[0].resolve(responseFor('stale', requests[0].url.href));
    await flush();
    expect(regionOf(initial)).toBe(sized.region);
    expect(sizeControls(initial)).toEqual(['100', '100']);
    expect(new URL(windowObject.location.href).searchParams.get('pageSize')).toBe('100');
    expect(releaseMembershipPayload(windowObject, initial.selection).sort()).toEqual(['2', '3', '9']);
    expect(onlyGets(windowObject)).toBe(true);
  });

  it('failed unsupported Back -> Search composes 25 and Retry repeats only a GET', async () => {
    vi.useFakeTimers();
    const initial = c4Page();
    const windowObject = c4Window(initial.document);
    windowObject.fetch.mockRejectedValue(new Error('offline'));
    enhanceReleaseAssetsLiveFiltering(initial.document);
    editDraft(initial);

    historyTo(windowObject, `${BASE}?selection=all&pageSize=15`);
    await flush();
    expect(liveFailureRetries(initial.document)).toHaveLength(1);
    expect(sizeControls(initial)).toEqual(['25', '25']);

    typeSearch(initial, 'needle');
    vi.advanceTimersByTime(1000);
    await flush();
    expect(windowObject.fetch).toHaveBeenCalledTimes(2);
    const searched = new URL(windowObject.fetch.mock.calls[1][0]);
    expect(sizeOf(searched)).toBe('25');
    expect(searched.searchParams.get('search')).toBe('needle');

    liveFailureRetries(initial.document)[0].dispatch('click');
    await flush();
    expect(windowObject.fetch).toHaveBeenCalledTimes(3);
    expect(windowObject.fetch.mock.calls[2][0]).toBe(searched.href);
    expect(sizeControls(initial)).toEqual(['25', '25']);
    expect(releaseMembershipPayload(windowObject, initial.selection).sort()).toEqual(['2', '3', '9']);
    expect(onlyGets(windowObject)).toBe(true);
  });

  it('unsupported Back -> Clear and pagination keep the effective 25, not the abandoned size', () => {
    for (const link of ['reset', 'next']) {
      const initial = c4Page({ search: 'needle', extension: 'png', category: '3' });
      const windowObject = c4Window(initial.document, new Map(),
        `${BASE}?selection=all&search=needle&extension=png&category=3&pageSize=50`);
      const requests = heldRequests(windowObject);
      enhanceReleaseAssetsLiveFiltering(initial.document);

      historyTo(windowObject, `${BASE}?selection=all&search=needle&pageSize=999999`);
      initial[link].dispatch('click');
      expect(requests).toHaveLength(2);
      const destination = requests[1].url;
      expect(sizeOf(destination)).toBe('25');
      if (link === 'reset') {
        expect(destination.searchParams.has('search')).toBe(false);
        expect(destination.searchParams.has('page')).toBe(false);
      } else {
        expect(destination.searchParams.get('page')).toBe('2');
        expect(destination.searchParams.get('search')).toBe('needle');
      }
      expect(onlyGets(windowObject)).toBe(true);
    }
  });
});

// B7-F1: a recoverable rejected legacy Save (the only page that renders the
// roleOrder carrier) edits draft roles in the carrier; normal pages keep the
// per-asset role autosubmit.
describe('B7-F1 Release Manage Assets recoverable draft roles', () => {
  const CARRIER = [[1, 'primary', 0], [3, 'bogus', 1], [2, 'preview', 2], [20, 'attachment', 3], [22, 'attachment', 4]];

  // The server-rendered recovery Role control (assets.njk): no form, no
  // autosubmit; an invalid carried role selects the correction prompt.
  function appendDraftRole(region, assetId, selected) {
    const wrapper = makeNode({ attrs: { class: 'inline-form release-asset-role-form', 'data-release-asset-draft-role': '' } });
    const options = selected === '' ? ['', 'primary', 'preview', 'attachment'] : ['primary', 'preview', 'attachment'];
    const select = makeSelect({
      id: `role-${assetId}`, name: 'role', 'data-release-asset-draft-role-select': String(assetId),
      ...(selected === '' ? { 'aria-invalid': 'true' } : {}),
    }, options, selected);
    wrapper.appendChild(select);
    region.appendChild(wrapper);
    return select;
  }

  function recoveryPage(options = {}) {
    const page = makeReleaseAssetsPage({
      assets: [{ id: '1', selected: true }, { id: '3', selected: true }, { id: '5' }],
      persistedSelectedIds: ['1', '2', '20', '21'],
      offPageSelectedIds: ['2', '20', '22'],
      selectionFilter: 'all',
      roleOrder: JSON.stringify(CARRIER),
      ...options,
    });
    return page;
  }

  let originalFetch;
  let originalFormData;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalFormData = globalThis.FormData;
  });
  afterEach(() => {
    vi.stubGlobal('fetch', originalFetch);
    vi.stubGlobal('FormData', originalFormData);
  });

  it('shows an invalid carried role as needing correction and writes a chosen valid role into that entry only', async () => {
    const initial = recoveryPage();
    const invalid = appendDraftRole(initial.region, 3, '');
    const primary = appendDraftRole(initial.region, 1, 'primary');
    const windowObject = makeWindow(initial.document);
    vi.stubGlobal('fetch', windowObject.fetch);
    vi.stubGlobal('FormData', windowObject.FormData);
    initial.selection.requestSubmit = vi.fn();
    initial.selection.submit = vi.fn();
    const before = initial.roleOrderInput.value;

    enhanceReleaseAssetsLiveFiltering(initial.document);
    // Rendering never coerces the invalid role or rewrites the carrier.
    expect(invalid.value).toBe('');
    expect(invalid.getAttribute('aria-invalid')).toBe('true');
    expect(primary.value).toBe('primary');
    expect(primary.hasAttribute('aria-invalid')).toBe(false);
    expect(initial.roleOrderInput.value).toBe(before);
    const membership = releaseMembershipPayload(windowObject, initial.selection);

    invalid.value = 'attachment';
    invalid.dispatch('change');
    await flush();

    expect(JSON.parse(initial.roleOrderInput.value)).toEqual([
      [1, 'primary', 0], [3, 'attachment', 1], [2, 'preview', 2], [20, 'attachment', 3], [22, 'attachment', 4],
    ]);
    expect(invalid.value).toBe('attachment');
    expect(invalid.hasAttribute('aria-invalid')).toBe(false);
    // Nothing is persisted or submitted; the membership draft is untouched.
    expect(windowObject.fetch).not.toHaveBeenCalled();
    expect(initial.selection.requestSubmit).not.toHaveBeenCalled();
    expect(initial.selection.submit).not.toHaveBeenCalled();
    expect(releaseMembershipPayload(windowObject, initial.selection)).toEqual(membership);
    expect(releaseHiddenMembership(initial.selection)).toEqual(expect.arrayContaining(['2', '20', '22']));

    // Choosing the correction prompt keeps the carried (corrected) role.
    invalid.value = '';
    invalid.dispatch('change');
    expect(invalid.value).toBe('attachment');
    expect(JSON.parse(initial.roleOrderInput.value)[1]).toEqual([3, 'attachment', 1]);

    // Another asset's change edits only its own entry.
    primary.value = 'preview';
    primary.dispatch('change');
    expect(JSON.parse(initial.roleOrderInput.value)).toEqual([
      [1, 'preview', 0], [3, 'attachment', 1], [2, 'preview', 2], [20, 'attachment', 3], [22, 'attachment', 4],
    ]);
    expect(windowObject.fetch).not.toHaveBeenCalled();
  });

  it('turns an installed saved-member role form into a draft control showing the carried role', async () => {
    const initial = recoveryPage({ roleOrder: JSON.stringify([[99, 'primary', 0], [3, 'bogus', 1]]) });
    const replacement = makeReleaseAssetsPage({ roleAutosubmit: true, selectionFilter: 'all' });
    const windowObject = makeWindow(initial.document, new Map([['next', replacement.document]]));
    windowObject.location.href = 'http://creatorcrate.test/releases/7/assets?selection=all';
    windowObject.location.pathname = '/releases/7/assets';
    windowObject.fetch.mockResolvedValueOnce(responseFor('next', 'http://creatorcrate.test/releases/7/assets?selection=all&page=2'));
    vi.stubGlobal('fetch', windowObject.fetch);
    vi.stubGlobal('FormData', windowObject.FormData);

    enhanceReleaseAssetsLiveFiltering(initial.document);
    initial.next.dispatch('click');
    await flush();

    const installed = initial.document.querySelector('select[name="role"]');
    expect(installed).not.toBeNull();
    expect(installed.hasAttribute('data-autosubmit')).toBe(false);
    expect(installed.getAttribute('data-release-asset-draft-role-select')).toBe('99');
    // The response rendered the saved role (attachment); the draft holds primary.
    expect(installed.value).toBe('primary');

    installed.value = 'attachment';
    installed.dispatch('change');
    await flush();
    expect(JSON.parse(initial.roleOrderInput.value)).toEqual([[99, 'attachment', 0], [3, 'bogus', 1]]);
    // Only the region GET was fetched: no role POST.
    expect(windowObject.fetch).toHaveBeenCalledTimes(1);
    expect(windowObject.fetch.mock.calls[0][1]?.method ?? 'GET').not.toBe('POST');
  });

  it('marks an installed control invalid for an invalid carried role and disables one outside the draft', async () => {
    for (const [carrier, expectation] of [
      [[[99, 'bogus', 0]], 'invalid'],
      [[[3, 'primary', 0]], 'disabled'],
    ]) {
      const initial = recoveryPage({ roleOrder: JSON.stringify(carrier) });
      const replacement = makeReleaseAssetsPage({ roleAutosubmit: true, selectionFilter: 'all' });
      const windowObject = makeWindow(initial.document, new Map([['next', replacement.document]]));
      windowObject.location.href = 'http://creatorcrate.test/releases/7/assets?selection=all';
      windowObject.location.pathname = '/releases/7/assets';
      windowObject.fetch.mockResolvedValueOnce(responseFor('next', 'http://creatorcrate.test/releases/7/assets?selection=all&page=2'));
      vi.stubGlobal('fetch', windowObject.fetch);
      vi.stubGlobal('FormData', windowObject.FormData);
      enhanceReleaseAssetsLiveFiltering(initial.document);
      initial.next.dispatch('click');
      await flush();

      const installed = initial.document.querySelector('select[name="role"]');
      expect(installed.hasAttribute('data-autosubmit')).toBe(false);
      if (expectation === 'invalid') {
        expect(installed.getAttribute('aria-invalid')).toBe('true');
        expect(installed.disabled).toBe(false);
      } else {
        expect(installed.disabled).toBe(true);
        expect(installed.hasAttribute('aria-invalid')).toBe(false);
        installed.dispatch('change');
        await flush();
      }
      expect(JSON.parse(initial.roleOrderInput.value)).toEqual(carrier);
      expect(windowObject.fetch).toHaveBeenCalledTimes(1);
    }
  });

  it('leaves normal Manage Assets role forms autosubmitting', async () => {
    const initial = makeReleaseAssetsPage({ roleAutosubmit: true, selectionFilter: 'all' });
    const windowObject = makeWindow(initial.document);
    windowObject.fetch.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', windowObject.fetch);
    vi.stubGlobal('FormData', windowObject.FormData);

    enhanceReleaseAssetsLiveFiltering(initial.document);
    const role = initial.region.querySelector('select[name="role"]');
    expect(role.hasAttribute('data-autosubmit')).toBe(true);
    expect(role.hasAttribute('data-release-asset-draft-role-select')).toBe(false);
    expect(role.disabled).toBe(false);
  });
});

// B7-F2: a live GET renders Role controls only for saved members. On a
// recoverable rejected Save, a selected draft member that is not saved (so its
// server-rendered editor is gone after navigation) gets a recovery Role control
// cloned from the page's inert template, keyed to its asset ID and showing the
// carried role; it edits only that carrier entry and never posts.
describe('B7-F2 Release Manage Assets draft Role controls after live navigation', () => {
  const ID_TOKEN = 'cc-draft-role-asset-id';
  const NAME_TOKEN = 'cc-draft-role-asset-filename';
  const ROLE_ORDER = [[1, 'primary', 0], [3, 'bogus', 1], [20, 'attachment', 2], [22, 'attachment', 3]];

  // Mirrors assets.njk's draft releaseRoleControl: no form, no autosubmit; the
  // invalid variant carries the correction prompt option.
  function draftRoleControl(assetId, filename, { invalid = false, selected = 'primary' } = {}) {
    const wrapper = makeNode({ attrs: { class: 'inline-form release-asset-role-form', 'data-release-asset-draft-role': '' } });
    const field = makeNode({
      tagName: 'fieldset',
      attrs: { class: `field asset-filter-multiselect-field release-asset-role-field${invalid ? ' field-error' : ''}` },
    });
    const legend = makeNode({ tagName: 'legend', attrs: { class: 'sr-only' } });
    legend.textContent = `Role for ${filename}`;
    const select = makeSelect({
      id: `role-${assetId}`, name: 'role', 'aria-label': `Role for ${filename}`,
      'data-release-asset-draft-role-select': String(assetId),
      ...(invalid ? { 'aria-invalid': 'true' } : {}),
    }, invalid ? ['', 'primary', 'preview', 'attachment'] : ['primary', 'preview', 'attachment'], invalid ? '' : selected);
    field.appendChild(legend);
    field.appendChild(select);
    wrapper.appendChild(field);
    return { wrapper, select };
  }

  // The template is rendered on the correction prompt, never a chosen role.
  function appendDraftRoleTemplates(selection) {
    const clones = [];
    const template = makeNode({ tagName: 'template', attrs: { 'data-release-asset-draft-role-template': '' } });
    template.content = {
      cloneNode() {
        const fragment = makeNode({ tagName: 'fragment' });
        fragment.appendChild(draftRoleControl(ID_TOKEN, NAME_TOKEN, { invalid: true }).wrapper);
        clones.push('template');
        return fragment;
      },
    };
    selection.appendChild(template);
    return clones;
  }

  function selectionCheckbox(id, filename, checked) {
    return makeNode({
      tagName: 'input',
      attrs: {
        type: 'checkbox', name: 'selectedAssetIds', value: String(id), form: 'release-assets-form',
        'data-release-asset-filename': filename,
      },
      value: String(id),
      checked,
    });
  }

  function appendGridCard(region, { id, filename, checked = false, role = null }) {
    const card = makeNode({ tagName: 'article', attrs: { class: 'asset-card asset-card--release', 'data-asset-id': String(id) } });
    const top = makeNode({ attrs: { class: 'asset-card-top' } });
    const checkbox = selectionCheckbox(id, filename, checked);
    top.appendChild(checkbox);
    if (role) top.appendChild(role);
    const details = makeNode({ tagName: 'a', attrs: { class: 'asset-details-link', href: `/assets/${id}` } });
    top.appendChild(details);
    card.appendChild(top);
    region.appendChild(card);
    return { card, top, checkbox, details };
  }

  function appendListCard(region, { id, filename, checked = false, role = null }) {
    const card = makeNode({ tagName: 'article', attrs: { class: 'asset-list-card asset-list-card--release', 'data-asset-id': String(id) } });
    const select = makeNode({ attrs: { class: 'asset-list-cell asset-list-cell--select' } });
    const checkbox = selectionCheckbox(id, filename, checked);
    select.appendChild(checkbox);
    const roleCell = makeNode({ tagName: 'dl', attrs: { class: 'asset-list-cell asset-list-cell--role asset-list-card-meta' } });
    const value = makeNode({ tagName: 'dd' });
    if (role) {
      value.appendChild(role);
    } else {
      const dash = makeNode({ tagName: 'span', attrs: { class: 'dashboard-muted' } });
      dash.textContent = '—';
      value.appendChild(dash);
    }
    roleCell.appendChild(value);
    card.appendChild(select);
    card.appendChild(roleCell);
    region.appendChild(card);
    return { card, checkbox, value };
  }

  // A saved member's normal per-asset role form, as a live GET renders it.
  function savedRoleForm(assetId, role) {
    const form = makeNode({
      tagName: 'form',
      attrs: { action: `/releases/7/assets/${assetId}/role`, method: 'post', class: 'inline-form release-asset-role-form' },
    });
    form.appendChild(makeSelect({ id: `role-${assetId}`, name: 'role', 'data-autosubmit': '' }, ['primary', 'preview', 'attachment'], role));
    return form;
  }

  // The GET response for a page: saved membership 1, 20, 21; 3 and 5 unsaved.
  function getResponse(cards, view = 'grid') {
    const page = makeReleaseAssetsPage({
      assets: [], persistedSelectedIds: ['1', '20', '21'], selectionFilter: 'all', view,
    });
    const append = view === 'list' ? appendListCard : appendGridCard;
    const rendered = cards.map((card) => append(page.region, card));
    return { page, rendered };
  }

  function draftRoleSelects(card) {
    return card.querySelectorAll('.release-asset-role-form select[name="role"]');
  }

  // The rejected Save's page 1: 1 saved Primary, 3 newly selected with bogus,
  // 5 unselected; 20 and 22 are off-page draft members, saved 21 is removed.
  function recoveryPage() {
    const page = makeReleaseAssetsPage({
      assets: [], persistedSelectedIds: ['1', '20', '21'], offPageSelectedIds: ['20', '22'],
      selectionFilter: 'all', roleOrder: JSON.stringify(ROLE_ORDER),
    });
    const clones = appendDraftRoleTemplates(page.selection);
    const cards = {
      1: appendGridCard(page.region, { id: 1, filename: '01-image.txt', checked: true, role: draftRoleControl(1, '01-image.txt').wrapper }),
      3: appendGridCard(page.region, { id: 3, filename: '03-image.txt', checked: true, role: draftRoleControl(3, '03-image.txt', { invalid: true }).wrapper }),
      5: appendGridCard(page.region, { id: 5, filename: '05-image.txt' }),
    };
    return { ...page, cards, clones };
  }

  function navigationWindow(initial, responses) {
    const windowObject = makeWindow(initial.document, new Map(responses.map(([key, response]) => [key, response.page.document])));
    windowObject.location.href = 'http://creatorcrate.test/releases/7/assets?selection=all';
    windowObject.location.pathname = '/releases/7/assets';
    responses.forEach(([key], index) => {
      windowObject.fetch.mockResolvedValueOnce(responseFor(key, `http://creatorcrate.test/releases/7/assets?selection=all&page=${index + 2}`));
    });
    vi.stubGlobal('fetch', windowObject.fetch);
    vi.stubGlobal('FormData', windowObject.FormData);
    initial.selection.requestSubmit = vi.fn();
    initial.selection.submit = vi.fn();
    return windowObject;
  }

  const carrier = (page) => JSON.parse(page.roleOrderInput.value);
  const onlyGets = (windowObject) => windowObject.fetch.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET');

  let originalFetch;
  let originalFormData;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalFormData = globalThis.FormData;
  });
  afterEach(() => {
    vi.stubGlobal('fetch', originalFetch);
    vi.stubGlobal('FormData', originalFormData);
  });

  it('restores an invalid newly selected member\'s Role control after navigation and edits only its carrier entry', async () => {
    const initial = recoveryPage();
    const page2 = getResponse([{ id: 11, filename: '11-image.txt' }]);
    // Back on page 1 the GET knows only saved membership: 3 has no editor.
    const page1 = getResponse([
      { id: 1, filename: '01-image.txt', checked: true, role: savedRoleForm(1, 'primary') },
      { id: 3, filename: '03-image.txt' },
      { id: 5, filename: '05-image.txt' },
    ]);
    const windowObject = navigationWindow(initial, [['page-2', page2], ['page-1', page1]]);

    enhanceReleaseAssetsLiveFiltering(initial.document);
    // The server rendered every submitted visible member's editor: none is cloned.
    expect(initial.clones).toEqual([]);
    expect(draftRoleSelects(initial.cards[3].card)).toHaveLength(1);
    const membership = releaseMembershipPayload(windowObject, initial.selection);

    initial.next.dispatch('click');
    await flush();
    page2.page.next.dispatch('click');
    await flush();

    const card3 = page1.rendered[1];
    expect(card3.checkbox.checked).toBe(true);
    // The original server-rendered editor was replaced with the region.
    expect(initial.document.querySelectorAll('[data-asset-id="3"]')).toEqual([card3.card]);
    const restored = draftRoleSelects(card3.card);
    expect(restored).toHaveLength(1);
    const [role3] = restored;
    expect(role3.id).toBe('role-3');
    expect(role3.getAttribute('data-release-asset-draft-role-select')).toBe('3');
    expect(role3.getAttribute('aria-label')).toBe('Role for 03-image.txt');
    expect(role3.closest('fieldset').querySelector('legend').textContent).toBe('Role for 03-image.txt');
    expect(role3.hasAttribute('data-autosubmit')).toBe(false);
    expect(role3.closest('form')).toBeNull();
    // Grid: in the top action row, before the details link, labelled Role.
    const wrapper = role3.closest('.release-asset-grid-role');
    expect(wrapper.parentNode).toBe(card3.top);
    expect(card3.top.children.indexOf(wrapper)).toBe(card3.top.children.indexOf(card3.details) - 1);
    expect(wrapper.querySelector('.release-asset-grid-role-label').textContent).toBe('Role');
    // Still visibly invalid: never coerced to a valid role.
    expect(role3.value).toBe('');
    expect(role3.getAttribute('aria-invalid')).toBe('true');
    expect(role3.querySelectorAll('option').map((option) => option.getAttribute('value')))
      .toEqual(['', 'primary', 'preview', 'attachment']);
    expect(role3.closest('.release-asset-role-field').getAttribute('class')).toMatch(/\bfield-error\b/);
    // Unselected 5 has no editor; saved 1 keeps one converted control.
    expect(draftRoleSelects(page1.rendered[2].card)).toHaveLength(0);
    expect(draftRoleSelects(page1.rendered[0].card)).toHaveLength(1);
    expect(page1.rendered[0].card.querySelector('select[name="role"]').hasAttribute('data-autosubmit')).toBe(false);
    expect(carrier(initial)).toEqual(ROLE_ORDER);

    role3.value = 'attachment';
    role3.dispatch('change');
    await flush();

    expect(carrier(initial)).toEqual([[1, 'primary', 0], [3, 'attachment', 1], [20, 'attachment', 2], [22, 'attachment', 3]]);
    expect(role3.value).toBe('attachment');
    expect(role3.hasAttribute('aria-invalid')).toBe(false);
    // Only the two region GETs: no role POST, no Save.
    expect(windowObject.fetch).toHaveBeenCalledTimes(2);
    expect(onlyGets(windowObject)).toBe(true);
    expect(initial.selection.requestSubmit).not.toHaveBeenCalled();
    expect(initial.selection.submit).not.toHaveBeenCalled();
    // Membership, including the off-page members, is unchanged.
    expect(releaseMembershipPayload(windowObject, initial.selection).sort()).toEqual(membership.sort());
    expect(releaseHiddenMembership(initial.selection)).toEqual(expect.arrayContaining(['20', '22']));
  });

  it('keeps a role corrected before navigation editable in List and Grid, idempotent across reconciliation and selection', async () => {
    const initial = recoveryPage();
    const listPage1 = getResponse([
      { id: 1, filename: '01-image.txt', checked: true, role: savedRoleForm(1, 'primary') },
      { id: 3, filename: '03-image.txt' },
    ], 'list');
    const gridPage1 = getResponse([
      { id: 3, filename: '03-image.txt' },
      { id: 5, filename: '05-image.txt' },
    ]);
    const windowObject = navigationWindow(initial, [['list-1', listPage1], ['grid-1', gridPage1]]);

    enhanceReleaseAssetsLiveFiltering(initial.document);
    const before = initial.cards[3].card.querySelector('select[name="role"]');
    before.value = 'attachment';
    before.dispatch('change');
    expect(carrier(initial)[1]).toEqual([3, 'attachment', 1]);

    initial.next.dispatch('click');
    await flush();

    // List: the Role column's value, in place of the unselected dash.
    const row3 = listPage1.rendered[1];
    const [listRole] = draftRoleSelects(row3.card);
    expect(draftRoleSelects(row3.card)).toHaveLength(1);
    expect(listRole.closest('dd')).toBe(row3.value);
    expect(row3.value.querySelector('.dashboard-muted')).toBeNull();
    expect(listRole.value).toBe('attachment');
    expect(listRole.hasAttribute('aria-invalid')).toBe(false);
    // A valid carried role drops the correction prompt option.
    expect(listRole.querySelectorAll('option').map((option) => option.getAttribute('value')))
      .toEqual(['primary', 'preview', 'attachment']);
    expect(initial.clones).toEqual(['template']);

    // Revised again: the same entry, order kept.
    listRole.value = 'preview';
    listRole.dispatch('change');
    expect(carrier(initial)).toEqual([[1, 'primary', 0], [3, 'preview', 1], [20, 'attachment', 2], [22, 'attachment', 3]]);

    // A membership change elsewhere reconciles again without a duplicate.
    const row1 = listPage1.rendered[0];
    row1.checkbox.checked = false;
    row1.checkbox.dispatch('change');
    row1.checkbox.checked = true;
    row1.checkbox.dispatch('change');
    expect(draftRoleSelects(row3.card)).toHaveLength(1);
    expect(draftRoleSelects(row3.card)[0]).toBe(listRole);
    expect(initial.clones).toEqual(['template']);

    // Deselected: no editor for an unselected asset; the entry is kept.
    row3.checkbox.checked = false;
    row3.checkbox.dispatch('change');
    expect(draftRoleSelects(row3.card)).toHaveLength(0);
    expect(row3.value.querySelector('.dashboard-muted').textContent).toBe('—');
    expect(releaseMembershipPayload(windowObject, initial.selection)).not.toContain('3');
    expect(carrier(initial)[1]).toEqual([3, 'preview', 1]);
    // Reselected: the carried role is back on a fresh editor.
    row3.checkbox.checked = true;
    row3.checkbox.dispatch('change');
    const [reselected] = draftRoleSelects(row3.card);
    expect(reselected.value).toBe('preview');
    expect(releaseMembershipPayload(windowObject, initial.selection)).toContain('3');

    // Back to Grid: the revised role still shows and stays editable.
    listPage1.page.next.dispatch('click');
    await flush();
    const [gridRole] = draftRoleSelects(gridPage1.rendered[0].card);
    expect(draftRoleSelects(gridPage1.rendered[0].card)).toHaveLength(1);
    expect(gridRole.value).toBe('preview');
    gridRole.value = 'primary';
    gridRole.dispatch('change');
    expect(carrier(initial)).toEqual([[1, 'primary', 0], [3, 'primary', 1], [20, 'attachment', 2], [22, 'attachment', 3]]);
    expect(windowObject.fetch).toHaveBeenCalledTimes(2);
    expect(onlyGets(windowObject)).toBe(true);
    expect(initial.selection.requestSubmit).not.toHaveBeenCalled();
  });

  it('creates no Role control for a selected asset outside the carrier or on a normal page', async () => {
    // Recovery page: 5 is selected in the draft but the rejected Save did not
    // carry it, so there is no role to edit.
    const initial = recoveryPage();
    const page1 = getResponse([{ id: 5, filename: '05-image.txt' }]);
    navigationWindow(initial, [['page-1', page1]]);
    enhanceReleaseAssetsLiveFiltering(initial.document);
    initial.cards[5].checkbox.checked = true;
    initial.cards[5].checkbox.dispatch('change');
    expect(draftRoleSelects(initial.cards[5].card)).toHaveLength(0);
    initial.next.dispatch('click');
    await flush();
    expect(page1.rendered[0].checkbox.checked).toBe(true);
    expect(draftRoleSelects(page1.rendered[0].card)).toHaveLength(0);
    expect(initial.clones).toEqual([]);

    // Normal page: no carrier, so a newly checked asset gets no draft editor
    // and a saved member keeps its autosubmitting role form.
    const normal = getResponse([
      { id: 1, filename: '01-image.txt', checked: true, role: savedRoleForm(1, 'primary') },
      { id: 3, filename: '03-image.txt' },
    ]);
    const normalClones = appendDraftRoleTemplates(normal.page.selection);
    const windowObject = makeWindow(normal.page.document);
    vi.stubGlobal('fetch', windowObject.fetch);
    vi.stubGlobal('FormData', windowObject.FormData);
    enhanceReleaseAssetsLiveFiltering(normal.page.document);
    normal.rendered[1].checkbox.checked = true;
    normal.rendered[1].checkbox.dispatch('change');
    expect(draftRoleSelects(normal.rendered[1].card)).toHaveLength(0);
    expect(normalClones).toEqual([]);
    const saved = normal.rendered[0].card.querySelector('select[name="role"]');
    expect(saved.hasAttribute('data-autosubmit')).toBe(true);
    expect(saved.hasAttribute('data-release-asset-draft-role-select')).toBe(false);
    expect(windowObject.fetch).not.toHaveBeenCalled();
  });
});
