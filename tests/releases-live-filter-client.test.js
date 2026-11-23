import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  beginReleasesDefaultsLiveRefresh,
  enhanceReleaseAssetsLiveFiltering,
  enhanceReleasesLiveFiltering,
  refreshReleasesLiveRegion,
} from '../src/static/creatorcrate.js';
import {
  navigateReleasesLive,
  releasesLiveSnapshot,
  subscribeReleasesLive,
} from '../src/static/client/live-regions.js';
import {
  RELEASES_DEFAULTS_MESSAGES,
  createReleasesFiltersDefaults,
} from '../src/static/client/releases-filters-defaults.js';
import { enhanceDropdowns } from '../src/static/client/dropdowns.js';

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
        // A trailing :checked is honoured as a browser would (a radio group
        // with nothing checked has no `input[type="radio"]:checked`).
        if (candidate.endsWith(':checked')) {
          return this.checked === true && this.matches(candidate.slice(0, -':checked'.length));
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

// P3-C1 follow-up: FormData collects a control by its HTML form owner
// (form="" by id, else the nearest ancestor form), never by containment alone.
function mockFormOwner(field) {
  if (field.form !== undefined) return field.form;
  const formId = field.getAttribute?.('form');
  if (formId !== null && formId !== undefined) {
    const target = field.ownerDocument?.querySelector?.(`#${formId}`) ?? null;
    return target?.tagName === 'FORM' ? target : null;
  }
  let node = field.parentNode;
  while (node && node.tagName !== 'FORM') node = node.parentNode;
  return node || null;
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
        const candidates = new Set([
          ...(form.ownerDocument?.querySelectorAll?.('input, select, textarea') || []),
          ...form.querySelectorAll('input, select, textarea'),
        ]);
        this.fields = [...candidates]
          .filter((field) => mockFormOwner(field) === form)
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

  // WP12: the combined dialog's defaults form has no native action (its
  // explicit Save is JSON-only and never carries the scope), so only the GET
  // filter form's hidden asset scope is reconciled with each installed page.
  it('keeps the asset scope in sync through filtering, Reset, and Back', async () => {
    const scopedOptions = { assetValue: '42', resetUrl: '/releases' };
    const initial = makePage('/releases', { ...scopedOptions });
    const filtered = makePage('/releases', { ...scopedOptions, scheduleValue: 'today' });
    const reset = makePage('/releases', { projectValue: '' });
    const unscoped = makePage('/releases', { projectValue: '', scheduleValue: 'upcoming' });
    const restored = makePage('/releases', { ...scopedOptions, scheduleValue: 'today' });
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

    initial.reset.dispatch('click');
    await flush();
    expect(windowObject.fetch.mock.calls[1][0]).toBe('http://creatorcrate.test/releases');
    expect(initial.form.querySelector('input[name="asset"]')).toBeNull();

    reset.schedule.value = 'upcoming';
    initial.form.dispatch('change', { target: reset.schedule });
    await flush();
    requested = new URL(windowObject.fetch.mock.calls[2][0]);
    expect(requested.searchParams.has('asset')).toBe(false);

    windowObject.location.href = 'http://creatorcrate.test/releases?asset=42&project=7&schedule=today';
    windowObject.location.pathname = '/releases';
    windowObject.fetch.mockResolvedValueOnce(responseFor('restored', windowObject.location.href));
    windowObject.dispatch('popstate');
    await flush();
    expect(windowObject.fetch.mock.calls[3][0]).toBe(windowObject.location.href);
    expect(initial.form.querySelector('input[name="asset"]')?.value).toBe('42');
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

/*
 * WP12: the Releases engine behind the combined Filters & Defaults dialog —
 * the results Search (debounced), repeated Projects / Project Types as the
 * visible authority, and the read-only snapshot / observer / GET navigation
 * API the explicit defaults transport uses.
 */
function makeCombinedPage({ projects = [], types = [], search = '', ...options } = {}) {
  const page = makePage('/releases', { projectValue: '', ...options });
  const searchInput = makeNode({
    tagName: 'input',
    attrs: { id: 'releases-search', name: 'search', type: 'search', 'data-releases-search': '' },
    value: search,
  });
  page.form.appendChild(searchInput);
  const checkbox = (name, value) => {
    const input = makeNode({ tagName: 'input', attrs: { name, type: 'checkbox', value }, value, checked: true });
    page.form.appendChild(input);
    return input;
  };
  // As in the real multi-select, the unrestricted Select all ('') is
  // unchecked whenever an individual Project is checked.
  if (projects.length > 0) page.project.checked = false;
  const projectInputs = projects.map((value) => checkbox('project', value));
  const typeInputs = types.map((value) => checkbox('type', value));
  return { ...page, searchInput, projectInputs, typeInputs };
}

describe('WP12 Releases combined dialog live engine', () => {
  beforeEach(() => { vi.useRealTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('keeps repeated Projects and Project Types through a second filter change, never comma-joined', async () => {
    const initial = makeCombinedPage({ projects: ['7', '12'], types: ['comic', 'animation'] });
    const next = makeCombinedPage({ projects: ['7', '12'], types: ['animation', 'comic'], scheduleValue: 'today' });
    const windowObject = makeWindow(initial.document, new Map([['next', next.document]]));
    windowObject.fetch.mockResolvedValue(responseFor(
      'next', 'http://creatorcrate.test/releases?project=7&project=12&type=animation&type=comic&schedule=today',
    ));
    enhanceReleasesLiveFiltering(initial.document);

    initial.schedule.value = 'today';
    initial.form.dispatch('change', { target: initial.schedule });
    await flush();

    const requested = new URL(windowObject.fetch.mock.calls[0][0]);
    expect(requested.searchParams.getAll('project')).toEqual(['7', '12']);
    expect(requested.searchParams.getAll('type')).toEqual(['comic', 'animation']);
    expect(requested.searchParams.get('schedule')).toBe('today');
    expect(requested.search).not.toContain('%2C');
    expect(requested.searchParams.has('page')).toBe(false);
    // The installed response's form (repeated selections) is reconciled into
    // the dialog's form, so the next change still carries every selection.
    expect(initial.form.querySelectorAll('input[name="project"]').filter((input) => input.checked)
      .map((input) => input.value)).toEqual(['7', '12']);

    next.sort.value = 'title';
    initial.form.dispatch('change', { target: next.sort });
    await flush();
    const second = new URL(windowObject.fetch.mock.calls[1][0]);
    expect(second.searchParams.getAll('project')).toEqual(['7', '12']);
    expect(second.searchParams.getAll('type')).toEqual(['animation', 'comic']);
    expect(second.searchParams.get('sort')).toBe('title');
  });

  it('debounces the results Search, reports it as pending intent, and a Sort change supersedes it', async () => {
    vi.useFakeTimers();
    const initial = makeCombinedPage({ projects: ['7'] });
    const windowObject = makeWindow(initial.document);
    windowObject.fetch.mockImplementation(() => new Promise(() => {}));
    enhanceReleasesLiveFiltering(initial.document);

    initial.searchInput.value = 'needle';
    initial.form.dispatch('input', { target: initial.searchInput });
    // A results Search change never schedules through the change path.
    initial.form.dispatch('change', { target: initial.searchInput });
    expect(windowObject.fetch).not.toHaveBeenCalled();
    const snapshot = releasesLiveSnapshot(initial.document);
    expect(snapshot.pending).toBe(true);
    expect(snapshot.requestedHistoryMode).toBe('push');
    expect(new URL(snapshot.intendedUrl).searchParams.get('search')).toBe('needle');

    // A Sort edit while the Search is still debounced supersedes it with one
    // GET carrying both.
    initial.sort.value = 'title';
    initial.form.dispatch('change', { target: initial.sort });
    expect(windowObject.fetch).toHaveBeenCalledOnce();
    const requested = new URL(windowObject.fetch.mock.calls[0][0]);
    expect(requested.searchParams.get('search')).toBe('needle');
    expect(requested.searchParams.get('sort')).toBe('title');
    expect(requested.searchParams.getAll('project')).toEqual(['7']);
    vi.advanceTimersByTime(1000);
    expect(windowObject.fetch).toHaveBeenCalledOnce();
  });

  it('sends the debounced Search after the delay as one push navigation', async () => {
    vi.useFakeTimers();
    const initial = makeCombinedPage();
    const windowObject = makeWindow(initial.document);
    windowObject.fetch.mockImplementation(() => new Promise(() => {}));
    enhanceReleasesLiveFiltering(initial.document);

    initial.searchInput.value = 'ne';
    initial.form.dispatch('input', { target: initial.searchInput });
    vi.advanceTimersByTime(200);
    initial.searchInput.value = 'needle';
    initial.form.dispatch('input', { target: initial.searchInput });
    vi.advanceTimersByTime(349);
    expect(windowObject.fetch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(windowObject.fetch).toHaveBeenCalledOnce();
    expect(new URL(windowObject.fetch.mock.calls[0][0]).searchParams.get('search')).toBe('needle');
  });

  it('notifies observers of started, superseded, installed and failed loads and exposes the request state', async () => {
    const initial = makeCombinedPage();
    const next = makeCombinedPage({ scheduleValue: 'today' });
    const windowObject = makeWindow(initial.document, new Map([['next', next.document]]));
    let resolveFirst;
    windowObject.fetch
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(responseFor('next', 'http://creatorcrate.test/releases?schedule=today'))
      .mockRejectedValueOnce(new Error('offline'));
    enhanceReleasesLiveFiltering(initial.document);
    const events = [];
    const unsubscribe = subscribeReleasesLive(initial.document, (detail) => events.push(detail));

    initial.schedule.value = 'overdue';
    initial.form.dispatch('change', { target: initial.schedule });
    const first = releasesLiveSnapshot(initial.document);
    expect(first).toMatchObject({ pending: true, failed: false, requestedHistoryMode: 'push' });
    expect(new URL(first.intendedUrl).searchParams.get('schedule')).toBe('overdue');

    // A newer GET navigation supersedes the pending one.
    const navigated = navigateReleasesLive(initial.document, '/releases?schedule=today', { historyMode: 'push' });
    expect(navigated).toEqual({ status: 'started', generation: first.generation + 1 });
    await flush();
    // The older response delivered last is never installed.
    resolveFirst(responseFor('stale', 'http://creatorcrate.test/releases?schedule=overdue'));
    await flush();
    expect(initial.document.querySelector('[data-releases-live-region]')).toBe(next.region);
    expect(windowObject.location.href).toBe('http://creatorcrate.test/releases?schedule=today');
    expect(releasesLiveSnapshot(initial.document)).toMatchObject({ pending: false, failed: false });

    const failedNavigation = navigateReleasesLive(initial.document, '/releases?schedule=upcoming');
    await flush();
    const failedSnapshot = releasesLiveSnapshot(initial.document);
    expect(failedSnapshot).toMatchObject({ pending: false, failed: true });
    expect(new URL(failedSnapshot.failedUrl).searchParams.get('schedule')).toBe('upcoming');
    expect(liveFailureRetries(initial.document)).toHaveLength(1);

    expect(events.map(({ phase }) => phase)).toEqual([
      'superseded', 'started', 'superseded', 'started', 'installed', 'superseded', 'started', 'failed',
    ]);
    expect(events.find(({ phase }) => phase === 'installed').generation).toBe(navigated.generation);
    expect(events.at(-1)).toMatchObject({ phase: 'failed', generation: failedNavigation.generation });

    // Only /releases is a Releases navigation.
    expect(navigateReleasesLive(initial.document, '/projects')).toEqual({ status: 'unavailable' });
    unsubscribe();
    initial.form.dispatch('change', { target: initial.schedule });
    expect(events.at(-1).phase).toBe('failed');
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

/*
 * R1: a Releases pagination link is rendered against the installed page, so a
 * pagination click while a filter edit is debounced, in flight or failed must
 * apply the clicked page to the latest intended filters, never to the stale
 * rendered address.
 */
const R1_INSTALLED_QUERY = 'asset=42&project=7&project=12&type=comic&type=images'
  + '&schedule=upcoming&includeArchived=1&sort=title&order=desc&pageSize=1';

function makePaginationPage({ projects = ['7', '12'], types = ['comic', 'images'], search = '', page = '1' } = {}) {
  const combined = makeCombinedPage({
    projects,
    types,
    search,
    assetValue: '42',
    pageSize: '1',
    scheduleValue: 'upcoming',
    sortValue: 'title',
    orderValue: 'desc',
    includeArchived: true,
  });
  // Rendered against the installed page: it knows nothing of a pending edit.
  combined.next.setAttribute('href', `/releases?${R1_INSTALLED_QUERY}&page=${Number(page) + 1}`);
  return combined;
}

function makePaginationWindow(document, pages) {
  const windowObject = makeWindow(document, pages);
  windowObject.location.href = `http://creatorcrate.test/releases?${R1_INSTALLED_QUERY}`;
  return windowObject;
}

function heldRequests(windowObject) {
  const requests = [];
  windowObject.fetch.mockImplementation((url, init) => new Promise((resolve, reject) => {
    requests.push({ url: new URL(url), init, resolve, reject });
  }));
  return requests;
}

function expectInstalledFilters(url) {
  expect(url.pathname).toBe('/releases');
  expect(url.searchParams.get('asset')).toBe('42');
  expect(url.searchParams.getAll('project')).toEqual(['7', '12']);
  expect(url.searchParams.getAll('type')).toEqual(['comic', 'images']);
  expect(url.searchParams.get('schedule')).toBe('upcoming');
  expect(url.searchParams.get('includeArchived')).toBe('1');
  expect(url.searchParams.get('sort')).toBe('title');
  expect(url.searchParams.get('order')).toBe('desc');
  expect(url.searchParams.get('pageSize')).toBe('1');
  expect(url.search).not.toContain('%2C');
}

describe('R1 Releases pagination keeps the latest filter intent', () => {
  beforeEach(() => { vi.useRealTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('composes page 2 with a held Search GET and never reinstalls the older Search response', async () => {
    vi.useFakeTimers();
    const initial = makePaginationPage();
    const pageTwo = makePaginationPage({ search: 'Needle', page: '2' });
    const stale = makePaginationPage({ search: 'Needle' });
    const windowObject = makePaginationWindow(initial.document, new Map([
      ['page-two', pageTwo.document], ['stale-search', stale.document],
    ]));
    const requests = heldRequests(windowObject);
    enhanceReleasesLiveFiltering(initial.document);

    initial.dialog.open = true;
    initial.searchInput.value = 'Needle';
    initial.form.dispatch('input', { target: initial.searchInput });
    vi.advanceTimersByTime(1000);
    expect(requests).toHaveLength(1);
    expect(requests[0].url.searchParams.get('search')).toBe('Needle');
    expect(requests[0].url.searchParams.has('page')).toBe(false);

    // The dialog closes while the Search GET is held, then page 2 is clicked.
    initial.dialog.open = false;
    const click = initial.next.dispatch('click');
    expect(click.defaultPrevented).toBe(true);
    expect(requests).toHaveLength(2);
    const paged = requests[1].url;
    expect(paged.searchParams.get('search')).toBe('Needle');
    expect(paged.searchParams.get('page')).toBe('2');
    expectInstalledFilters(paged);
    // The superseded Search GET was aborted.
    expect(requests[0].init.signal.aborted).toBe(true);

    requests[1].resolve(responseFor('page-two', paged.href));
    await flush();
    expect(initial.document.querySelector('[data-releases-live-region]')).toBe(pageTwo.region);
    const shown = new URL(windowObject.location.href);
    expect(shown.searchParams.get('search')).toBe('Needle');
    expect(shown.searchParams.get('page')).toBe('2');
    expect(windowObject.history.pushes).toHaveLength(1);
    expect(new URL(windowObject.history.pushes[0].url, shown.href).href).toBe(paged.href);

    // The older Search response delivered last installs nothing.
    requests[0].resolve(responseFor('stale-search', requests[0].url.href));
    await flush();
    expect(initial.document.querySelector('[data-releases-live-region]')).toBe(pageTwo.region);
    expect(windowObject.location.href).toBe(shown.href);
    expect(windowObject.history.pushes).toHaveLength(1);
    expect(initial.form.contains(pageTwo.searchInput)).toBe(true);
    expect(pageTwo.searchInput.value).toBe('Needle');
    // Ordinary pagination never posts defaults.
    expect(windowObject.fetch.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
  });

  it('composes page 2 with a Search still in its debounce interval, as one GET', async () => {
    vi.useFakeTimers();
    const initial = makePaginationPage();
    const windowObject = makePaginationWindow(initial.document, new Map());
    const requests = heldRequests(windowObject);
    enhanceReleasesLiveFiltering(initial.document);

    initial.searchInput.value = 'Needle';
    initial.form.dispatch('input', { target: initial.searchInput });
    expect(requests).toHaveLength(0);
    initial.next.dispatch('click');
    expect(requests).toHaveLength(1);
    expect(requests[0].url.searchParams.get('search')).toBe('Needle');
    expect(requests[0].url.searchParams.get('page')).toBe('2');
    expectInstalledFilters(requests[0].url);

    // The debounced Search was coalesced into the pagination GET.
    vi.advanceTimersByTime(1000);
    expect(requests).toHaveLength(1);
    expect(releasesLiveSnapshot(initial.document).intendedUrl).toBe(requests[0].url.href);
  });

  it('keeps the latest of two rapid Search edits', async () => {
    vi.useFakeTimers();
    const initial = makePaginationPage();
    const windowObject = makePaginationWindow(initial.document, new Map());
    const requests = heldRequests(windowObject);
    enhanceReleasesLiveFiltering(initial.document);

    initial.searchInput.value = 'Nee';
    initial.form.dispatch('input', { target: initial.searchInput });
    vi.advanceTimersByTime(1000);
    initial.searchInput.value = 'Needle';
    initial.form.dispatch('input', { target: initial.searchInput });
    expect(requests).toHaveLength(1);
    initial.next.dispatch('click');
    expect(requests).toHaveLength(2);
    expect(requests[1].url.searchParams.get('search')).toBe('Needle');
    expect(requests[1].url.searchParams.get('page')).toBe('2');
    expectInstalledFilters(requests[1].url);
    vi.advanceTimersByTime(1000);
    expect(requests).toHaveLength(2);
  });

  it('keeps a pending Project change, every repeated value and no cleared choice', async () => {
    const initial = makePaginationPage();
    const windowObject = makePaginationWindow(initial.document, new Map());
    const requests = heldRequests(windowObject);
    enhanceReleasesLiveFiltering(initial.document);

    // Clear Project 12 and add Project 15.
    initial.projectInputs[1].checked = false;
    const added = makeNode({ tagName: 'input', attrs: { name: 'project', type: 'checkbox', value: '15' }, value: '15', checked: true });
    initial.form.appendChild(added);
    initial.form.dispatch('change', { target: added });
    expect(requests).toHaveLength(1);
    initial.next.dispatch('click');
    expect(requests).toHaveLength(2);
    const paged = requests[1].url;
    expect(paged.searchParams.getAll('project')).toEqual(['7', '15']);
    expect(paged.searchParams.getAll('type')).toEqual(['comic', 'images']);
    expect(paged.searchParams.get('page')).toBe('2');
    expect(paged.searchParams.get('asset')).toBe('42');
    expect(paged.searchParams.get('pageSize')).toBe('1');
  });

  it('keeps a pending Project Type change with repeated values', async () => {
    const initial = makePaginationPage();
    const windowObject = makePaginationWindow(initial.document, new Map());
    const requests = heldRequests(windowObject);
    enhanceReleasesLiveFiltering(initial.document);

    initial.typeInputs[0].checked = false;
    const added = makeNode({ tagName: 'input', attrs: { name: 'type', type: 'checkbox', value: 'animation' }, value: 'animation', checked: true });
    initial.form.appendChild(added);
    initial.form.dispatch('change', { target: added });
    initial.next.dispatch('click');
    expect(requests).toHaveLength(2);
    const paged = requests[1].url;
    expect(paged.searchParams.getAll('type')).toEqual(['images', 'animation']);
    expect(paged.searchParams.getAll('project')).toEqual(['7', '12']);
    expect(paged.searchParams.get('page')).toBe('2');
  });

  it('never installs an older pagination response delivered after a newer Search', async () => {
    vi.useFakeTimers();
    const initial = makePaginationPage();
    const searched = makePaginationPage({ search: 'Needle' });
    const stalePage = makePaginationPage({ page: '2' });
    const windowObject = makePaginationWindow(initial.document, new Map([
      ['searched', searched.document], ['stale-page', stalePage.document],
    ]));
    const requests = heldRequests(windowObject);
    enhanceReleasesLiveFiltering(initial.document);

    initial.next.dispatch('click');
    expect(requests).toHaveLength(1);
    // Idle: the link's own canonical address.
    expect(requests[0].url.href).toBe(`http://creatorcrate.test/releases?${R1_INSTALLED_QUERY}&page=2`);
    initial.searchInput.value = 'Needle';
    initial.form.dispatch('input', { target: initial.searchInput });
    vi.advanceTimersByTime(1000);
    expect(requests).toHaveLength(2);
    // A genuine filter change keeps its page-one reset.
    expect(requests[1].url.searchParams.has('page')).toBe(false);

    requests[1].resolve(responseFor('searched', requests[1].url.href));
    await flush();
    requests[0].resolve(responseFor('stale-page', requests[0].url.href));
    await flush();
    expect(initial.document.querySelector('[data-releases-live-region]')).toBe(searched.region);
    expect(new URL(windowObject.location.href).searchParams.get('search')).toBe('Needle');
    expect(new URL(windowObject.location.href).searchParams.has('page')).toBe(false);
  });

  it('composes pagination after a failed Search GET and Retry repeats the composed GET', async () => {
    vi.useFakeTimers();
    const initial = makePaginationPage();
    const windowObject = makePaginationWindow(initial.document, new Map());
    windowObject.fetch.mockRejectedValue(new Error('offline'));
    enhanceReleasesLiveFiltering(initial.document);

    initial.searchInput.value = 'Needle';
    initial.form.dispatch('input', { target: initial.searchInput });
    vi.advanceTimersByTime(1000);
    await flush();
    expect(liveFailureRetries(initial.document)).toHaveLength(1);
    // The installed results are kept and the typed Search is not restored.
    expect(initial.document.querySelector('[data-releases-live-region]')).toBe(initial.region);
    expect(initial.searchInput.value).toBe('Needle');

    initial.next.dispatch('click');
    await flush();
    expect(windowObject.fetch).toHaveBeenCalledTimes(2);
    const paged = new URL(windowObject.fetch.mock.calls[1][0]);
    expect(paged.searchParams.get('search')).toBe('Needle');
    expect(paged.searchParams.get('page')).toBe('2');
    expectInstalledFilters(paged);

    expect(liveFailureRetries(initial.document)).toHaveLength(1);
    liveFailureRetries(initial.document)[0].dispatch('click');
    await flush();
    expect(windowObject.fetch).toHaveBeenCalledTimes(3);
    expect(windowObject.fetch.mock.calls[2][0]).toBe(paged.href);
    expect(windowObject.fetch.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
  });

  it('leaves the Reset filters link and an idle pagination click unchanged', async () => {
    vi.useFakeTimers();
    const initial = makePaginationPage();
    const windowObject = makePaginationWindow(initial.document, new Map());
    const requests = heldRequests(windowObject);
    enhanceReleasesLiveFiltering(initial.document);

    initial.searchInput.value = 'Needle';
    initial.form.dispatch('input', { target: initial.searchInput });
    initial.reset.dispatch('click');
    expect(requests).toHaveLength(1);
    expect(requests[0].url.searchParams.has('search')).toBe(false);
    expect(requests[0].url.searchParams.has('page')).toBe(false);
  });

  it('follows Back and Forward to the composed address through the engine', async () => {
    vi.useFakeTimers();
    const initial = makePaginationPage();
    const pageTwo = makePaginationPage({ search: 'Needle', page: '2' });
    const back = makePaginationPage();
    const windowObject = makePaginationWindow(initial.document, new Map([
      ['page-two', pageTwo.document], ['back', back.document],
    ]));
    enhanceReleasesLiveFiltering(initial.document);
    const installedHref = windowObject.location.href;

    initial.searchInput.value = 'Needle';
    initial.form.dispatch('input', { target: initial.searchInput });
    windowObject.fetch.mockImplementationOnce(async (url) => responseFor('page-two', url));
    initial.next.dispatch('click');
    await flush();
    const composed = windowObject.location.href;
    expect(new URL(composed).searchParams.get('search')).toBe('Needle');
    expect(new URL(composed).searchParams.get('page')).toBe('2');

    windowObject.location.href = installedHref;
    windowObject.fetch.mockImplementationOnce(async (url) => responseFor('back', url));
    windowObject.dispatch('popstate');
    await flush();
    expect(windowObject.fetch.mock.calls[1][0]).toBe(installedHref);
    expect(initial.document.querySelector('[data-releases-live-region]')).toBe(back.region);

    windowObject.location.href = composed;
    windowObject.fetch.mockImplementationOnce(async (url) => responseFor('page-two', url));
    windowObject.dispatch('popstate');
    await flush();
    expect(windowObject.fetch.mock.calls[2][0]).toBe(composed);
    expect(windowObject.history.pushes).toHaveLength(1);
  });
});

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
 * R7: Reset filters (and any newer request) is authoritative for every
 * Releases dimension a later action does not change. A Search, Project,
 * Project Type, Schedule, Include archived, Sort or Order edit made while the
 * Reset GET is held or failed composes with the Reset destination, so the
 * installed restrictions Reset cleared are never re-serialized.
 */
const R7_RESET_URL = '/releases?pageSize=1';

function makeR7Page({ search = '', dialogOpen = true } = {}) {
  const page = makePaginationPage({ search });
  page.dialog.open = dialogOpen;
  page.resetForm.setAttribute('action', R7_RESET_URL);
  // The installed authority's effective (saved) Sort/Order: what the server
  // resolves for a Reset that omits them.
  const authority = makeNode({ tagName: 'script', attrs: { type: 'application/json', 'data-releases-defaults-authority': '' } });
  authority.textContent = JSON.stringify({ defaults: { sort: 'planned', order: 'asc' } });
  page.region.appendChild(authority);
  const sortPlanned = makeNode({ tagName: 'input', attrs: { name: 'sort', type: 'radio', value: 'planned' }, value: 'planned' });
  page.sortDropdown.appendChild(sortPlanned);
  const orderAsc = makeNode({ tagName: 'input', attrs: { name: 'order', type: 'radio', value: 'asc' }, value: 'asc' });
  page.orderDropdown.appendChild(orderAsc);
  const scheduleAll = makeNode({ tagName: 'input', attrs: { name: 'schedule', type: 'radio', value: '' }, value: '' });
  page.scheduleDropdown.appendChild(scheduleAll);
  const assetScope = makeNode({ tagName: 'p', attrs: { 'data-releases-asset-scope': '' } });
  page.form.appendChild(assetScope);
  const assetField = page.form.querySelector('input[name="asset"]');
  const pageSizeField = page.form.querySelector('input[name="pageSize"]');
  return { ...page, sortPlanned, orderAsc, scheduleAll, assetScope, assetField, pageSizeField };
}

function r7Params(url) {
  return Array.from(new URL(url).searchParams.entries());
}

function expectOnlyReleasesParams(url, expected) {
  const actual = r7Params(url).slice().sort(([a, x], [b, y]) => (a + x).localeCompare(b + y));
  const wanted = expected.slice().sort(([a, x], [b, y]) => (a + x).localeCompare(b + y));
  expect(actual).toEqual(wanted);
}

function expectResetControls(page) {
  expect(page.searchInput.value).toBe('');
  // Select all checked, every individual Project / Type unchecked.
  expect(page.project.checked).toBe(true);
  expect(page.projectInputs.some((input) => input.checked)).toBe(false);
  expect(page.typeInputs.some((input) => input.checked)).toBe(false);
  expect(page.schedule.checked).toBe(false);
  expect(page.scheduleAll.checked).toBe(true);
  expect(page.archived.checked).toBe(false);
  expect(page.assetField.disabled).toBe(true);
  expect(page.assetScope.hidden).toBe(true);
  expect(page.pageSizeField.disabled).toBe(false);
  // Sort/Order show the installed effective defaults Reset restores.
  expect(page.sortPlanned.checked).toBe(true);
  expect(page.sort.checked).toBe(false);
  expect(page.orderAsc.checked).toBe(true);
  expect(page.order.checked).toBe(false);
}

function expectGetOnly(windowObject) {
  expect(windowObject.fetch.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
}

describe('R7 Releases Reset filters composes with later filter edits', () => {
  beforeEach(() => { vi.useRealTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('reviewer reproduction: Reset held -> Search Needle keeps Reset semantics and the Reset response never installs', async () => {
    vi.useFakeTimers();
    const initial = makeR7Page();
    const searched = makeCombinedPage({ search: 'Needle', pageSize: '1' });
    const reset = makeCombinedPage({ pageSize: '1' });
    const windowObject = makePaginationWindow(initial.document, new Map([
      ['searched', searched.document], ['reset', reset.document],
    ]));
    const requests = heldRequests(windowObject);
    enhanceReleasesLiveFiltering(initial.document);

    expect(navigateReleasesLive(initial.document, R7_RESET_URL).status).toBe('started');
    expect(requests).toHaveLength(1);
    expectOnlyReleasesParams(requests[0].url.href, [['pageSize', '1']]);
    expectResetControls(initial);

    // Debounce pending: the intended destination is already composed.
    initial.searchInput.value = 'Needle';
    initial.form.dispatch('input', { target: initial.searchInput });
    expect(requests).toHaveLength(1);
    expectOnlyReleasesParams(releasesLiveSnapshot(initial.document).intendedUrl, [
      ['pageSize', '1'], ['search', 'Needle'],
    ]);

    vi.advanceTimersByTime(1000);
    expect(requests).toHaveLength(2);
    expect(requests[0].init.signal.aborted).toBe(true);
    // No Project / Type / Schedule / archive / asset; Sort/Order left to the
    // server's saved defaults; page one.
    expectOnlyReleasesParams(requests[1].url.href, [['pageSize', '1'], ['search', 'Needle']]);

    requests[1].resolve(responseFor('searched', requests[1].url.href));
    await flush();
    requests[0].resolve(responseFor('reset', requests[0].url.href));
    await flush();
    expect(initial.document.querySelector('[data-releases-live-region]')).toBe(searched.region);
    expectOnlyReleasesParams(windowObject.location.href, [['pageSize', '1'], ['search', 'Needle']]);
    expect(windowObject.history.pushes).toHaveLength(1);
    expect(searched.searchInput.value).toBe('Needle');
    expectGetOnly(windowObject);
  });

  it('Reset through the rendered Reset filters control composes the same way', async () => {
    vi.useFakeTimers();
    const initial = makeR7Page();
    const windowObject = makePaginationWindow(initial.document, new Map());
    const requests = heldRequests(windowObject);
    enhanceReleasesLiveFiltering(initial.document);

    initial.reset.dispatch('click');
    expect(requests).toHaveLength(1);
    expectOnlyReleasesParams(requests[0].url.href, [['pageSize', '1']]);
    initial.searchInput.value = 'Needle';
    initial.form.dispatch('input', { target: initial.searchInput });
    vi.advanceTimersByTime(1000);
    expectOnlyReleasesParams(requests[1].url.href, [['pageSize', '1'], ['search', 'Needle']]);
  });

  it('keeps only the latest of two rapid Search edits over a held Reset', async () => {
    vi.useFakeTimers();
    const initial = makeR7Page();
    const windowObject = makePaginationWindow(initial.document, new Map());
    const requests = heldRequests(windowObject);
    enhanceReleasesLiveFiltering(initial.document);

    navigateReleasesLive(initial.document, R7_RESET_URL);
    initial.searchInput.value = 'Need';
    initial.form.dispatch('input', { target: initial.searchInput });
    vi.advanceTimersByTime(200);
    initial.searchInput.value = 'Needle';
    initial.form.dispatch('input', { target: initial.searchInput });
    vi.advanceTimersByTime(1000);
    expect(requests).toHaveLength(2);
    expectOnlyReleasesParams(requests[1].url.href, [['pageSize', '1'], ['search', 'Needle']]);

    // A third edit after the Search GET started still composes with Reset.
    initial.searchInput.value = 'Needles';
    initial.form.dispatch('input', { target: initial.searchInput });
    vi.advanceTimersByTime(1000);
    expect(requests).toHaveLength(3);
    expect(requests[1].init.signal.aborted).toBe(true);
    expectOnlyReleasesParams(requests[2].url.href, [['pageSize', '1'], ['search', 'Needles']]);
  });

  it('failed Reset -> Search -> failed -> GET-only Retry -> a newer Project edit supersedes Retry', async () => {
    vi.useFakeTimers();
    const initial = makeR7Page();
    const windowObject = makePaginationWindow(initial.document, new Map());
    const requests = heldRequests(windowObject);
    enhanceReleasesLiveFiltering(initial.document);

    navigateReleasesLive(initial.document, R7_RESET_URL);
    requests[0].reject(new Error('offline'));
    await flush();
    expect(liveFailureRetries(initial.document)).toHaveLength(1);
    expect(initial.document.querySelector('[data-releases-live-region]')).toBe(initial.region);
    // The installed page stays, but the form keeps the Reset intent.
    expectResetControls(initial);

    initial.searchInput.value = 'Needle';
    initial.form.dispatch('input', { target: initial.searchInput });
    vi.advanceTimersByTime(1000);
    expect(requests).toHaveLength(2);
    expectOnlyReleasesParams(requests[1].url.href, [['pageSize', '1'], ['search', 'Needle']]);
    requests[1].reject(new Error('offline'));
    await flush();

    liveFailureRetries(initial.document)[0].dispatch('click');
    expect(requests).toHaveLength(3);
    expect(requests[2].url.href).toBe(requests[1].url.href);

    // As the real multi-select does, choosing a Project clears Select all.

    initial.project.checked = false;

    initial.projectInputs[1].checked = true;
    initial.form.dispatch('change', { target: initial.projectInputs[1] });
    expect(requests).toHaveLength(4);
    expect(requests[2].init.signal.aborted).toBe(true);
    expectOnlyReleasesParams(requests[3].url.href, [
      ['pageSize', '1'], ['project', '12'], ['search', 'Needle'],
    ]);
    expectGetOnly(windowObject);
  });

  it.each([
    ['Project', (page) => { page.project.checked = false; page.projectInputs[0].checked = true; return page.projectInputs[0]; }, [['project', '7']]],
    ['Project Type', (page) => { page.typeInputs[1].checked = true; return page.typeInputs[1]; }, [['type', 'images']]],
    ['Schedule', (page) => {
      page.scheduleAll.checked = false;
      page.schedule.value = 'today';
      page.schedule.checked = true;
      return page.schedule;
    }, [['schedule', 'today']]],
    ['Include archived', (page) => { page.archived.checked = true; return page.archived; }, [['includeArchived', '1']]],
  ])('Reset held -> %s edit changes only that dimension', (_label, edit, expected) => {
    const initial = makeR7Page();
    const windowObject = makePaginationWindow(initial.document, new Map());
    const requests = heldRequests(windowObject);
    enhanceReleasesLiveFiltering(initial.document);

    navigateReleasesLive(initial.document, R7_RESET_URL);
    const target = edit(initial);
    initial.form.dispatch('change', { target });
    expect(requests).toHaveLength(2);
    expectOnlyReleasesParams(requests[1].url.href, [['pageSize', '1'], ...expected]);
  });

  it.each([
    ['Project', (page) => { page.project.checked = false; page.projectInputs[1].checked = true; return page.projectInputs[1]; }, [['project', '12']]],
    ['Project Type', (page) => { page.typeInputs[0].checked = true; return page.typeInputs[0]; }, [['type', 'comic']]],
  ])('failed Reset -> %s edit composes with the failed Reset destination', async (_label, edit, expected) => {
    const initial = makeR7Page();
    const windowObject = makePaginationWindow(initial.document, new Map());
    const requests = heldRequests(windowObject);
    enhanceReleasesLiveFiltering(initial.document);

    navigateReleasesLive(initial.document, R7_RESET_URL);
    requests[0].reject(new Error('offline'));
    await flush();
    const target = edit(initial);
    initial.form.dispatch('change', { target });
    expect(requests).toHaveLength(2);
    expectOnlyReleasesParams(requests[1].url.href, [['pageSize', '1'], ...expected]);
    expect(liveFailureNotice(initial.document)).toBe(null);
  });

  it('Reset held -> Sort edit sends only Sort; Order stays with the saved default', () => {
    const initial = makeR7Page();
    const windowObject = makePaginationWindow(initial.document, new Map());
    const requests = heldRequests(windowObject);
    enhanceReleasesLiveFiltering(initial.document);

    navigateReleasesLive(initial.document, R7_RESET_URL);
    initial.sortPlanned.checked = false;
    initial.sort.value = 'created';
    initial.sort.checked = true;
    initial.form.dispatch('change', { target: initial.sort });
    expectOnlyReleasesParams(requests[1].url.href, [['pageSize', '1'], ['sort', 'created']]);

    // The explicit Sort is now part of the latest destination; an Order edit
    // keeps it and still adds nothing Reset cleared.
    initial.orderAsc.checked = false;
    initial.order.value = 'desc';
    initial.order.checked = true;
    initial.form.dispatch('change', { target: initial.order });
    expectOnlyReleasesParams(requests[2].url.href, [['order', 'desc'], ['pageSize', '1'], ['sort', 'created']]);
  });

  it('Reset held -> Order edit sends only Order', () => {
    const initial = makeR7Page();
    const windowObject = makePaginationWindow(initial.document, new Map());
    const requests = heldRequests(windowObject);
    enhanceReleasesLiveFiltering(initial.document);

    navigateReleasesLive(initial.document, R7_RESET_URL);
    initial.orderAsc.checked = false;
    initial.order.value = 'desc';
    initial.order.checked = true;
    initial.form.dispatch('change', { target: initial.order });
    expectOnlyReleasesParams(requests[1].url.href, [['order', 'desc'], ['pageSize', '1']]);
  });

  it('an ordinary Search without Reset keeps every installed restriction', async () => {
    vi.useFakeTimers();
    const initial = makeR7Page();
    const windowObject = makePaginationWindow(initial.document, new Map());
    const requests = heldRequests(windowObject);
    enhanceReleasesLiveFiltering(initial.document);

    // No Reset: an ordinary Search keeps every installed restriction.
    initial.searchInput.value = 'Needle';
    initial.form.dispatch('input', { target: initial.searchInput });
    vi.advanceTimersByTime(1000);
    expect(requests[0].url.searchParams.get('search')).toBe('Needle');
    expectInstalledFilters(requests[0].url);
  });

  it('exact-asset Reset -> Search never restores the asset scope; Back restores it and composes', async () => {
    vi.useFakeTimers();
    const initial = makeR7Page();
    const back = makePaginationPage();
    const windowObject = makePaginationWindow(initial.document, new Map([['back', back.document]]));
    const installedHref = windowObject.location.href;
    const requests = heldRequests(windowObject);
    enhanceReleasesLiveFiltering(initial.document);

    navigateReleasesLive(initial.document, R7_RESET_URL);
    expect(initial.assetField.disabled).toBe(true);
    expect(initial.assetScope.hidden).toBe(true);
    initial.searchInput.value = 'Needle';
    initial.form.dispatch('input', { target: initial.searchInput });
    vi.advanceTimersByTime(1000);
    expect(requests[1].url.searchParams.has('asset')).toBe(false);

    // Back while the Search is held: history owns every dimension again.
    windowObject.location.href = installedHref;
    windowObject.dispatch('popstate');
    expect(requests).toHaveLength(3);
    expect(requests[2].url.href).toBe(installedHref);
    expect(initial.assetField.disabled).toBe(false);
    expect(initial.assetScope.hidden).toBe(false);
    expect(initial.searchInput.value).toBe('');
    expect(initial.projectInputs.map((input) => input.checked)).toEqual([true, true]);
    expect(initial.typeInputs.map((input) => input.checked)).toEqual([true, true]);
    expect(initial.sort.checked).toBe(true);

    initial.searchInput.value = 'Other';
    initial.form.dispatch('input', { target: initial.searchInput });
    vi.advanceTimersByTime(1000);
    expect(requests).toHaveLength(4);
    expect(requests[3].url.searchParams.get('search')).toBe('Other');
    expectInstalledFilters(requests[3].url);

    // Forward to the Reset-composed address: the asset scope is dropped again.
    windowObject.location.href = `http://creatorcrate.test/releases?pageSize=1&search=Needle`;
    windowObject.dispatch('popstate');
    expect(requests).toHaveLength(5);
    expect(initial.assetField.disabled).toBe(true);
    expect(initial.searchInput.value).toBe('Needle');
    expectGetOnly(windowObject);
  });

  it('R1 interaction: Reset -> Search (held) -> page 2 composes the Reset + Search intent', async () => {
    vi.useFakeTimers();
    const initial = makeR7Page();
    const pageTwo = makeCombinedPage({ search: 'Needle', pageSize: '1' });
    const windowObject = makePaginationWindow(initial.document, new Map([['page-two', pageTwo.document]]));
    const requests = heldRequests(windowObject);
    enhanceReleasesLiveFiltering(initial.document);

    navigateReleasesLive(initial.document, R7_RESET_URL);
    initial.searchInput.value = 'Needle';
    initial.form.dispatch('input', { target: initial.searchInput });
    vi.advanceTimersByTime(1000);
    initial.next.dispatch('click');
    expect(requests).toHaveLength(3);
    expectOnlyReleasesParams(requests[2].url.href, [['page', '2'], ['pageSize', '1'], ['search', 'Needle']]);
    requests[2].resolve(responseFor('page-two', requests[2].url.href));
    await flush();
    expect(initial.document.querySelector('[data-releases-live-region]')).toBe(pageTwo.region);
    requests[1].resolve(responseFor('page-two', requests[1].url.href));
    requests[0].resolve(responseFor('page-two', requests[0].url.href));
    await flush();
    expectOnlyReleasesParams(windowObject.location.href, [['page', '2'], ['pageSize', '1'], ['search', 'Needle']]);
    expect(windowObject.history.pushes).toHaveLength(1);
  });

  it('R1 interaction: Reset -> Search still debounced -> page 2 is one composed GET', () => {
    vi.useFakeTimers();
    const initial = makeR7Page();
    const windowObject = makePaginationWindow(initial.document, new Map());
    const requests = heldRequests(windowObject);
    enhanceReleasesLiveFiltering(initial.document);

    navigateReleasesLive(initial.document, R7_RESET_URL);
    initial.searchInput.value = 'Needle';
    initial.form.dispatch('input', { target: initial.searchInput });
    initial.next.dispatch('click');
    expect(requests).toHaveLength(2);
    expectOnlyReleasesParams(requests[1].url.href, [['page', '2'], ['pageSize', '1'], ['search', 'Needle']]);
    vi.advanceTimersByTime(1000);
    expect(requests).toHaveLength(2);
  });

  it('three overlapping actions: only the newest installs; late older responses and failures are ignored', async () => {
    vi.useFakeTimers();
    const initial = makeR7Page();
    const newest = makeCombinedPage({ projects: ['7'], search: 'Needle', pageSize: '1' });
    const older = makeCombinedPage({ search: 'Needle', pageSize: '1' });
    const windowObject = makePaginationWindow(initial.document, new Map([
      ['newest', newest.document], ['older', older.document],
    ]));
    const requests = heldRequests(windowObject);
    enhanceReleasesLiveFiltering(initial.document);

    navigateReleasesLive(initial.document, R7_RESET_URL);
    initial.searchInput.value = 'Needle';
    initial.form.dispatch('input', { target: initial.searchInput });
    vi.advanceTimersByTime(1000);
    // As the real multi-select does, choosing a Project clears Select all.
    initial.project.checked = false;
    initial.projectInputs[0].checked = true;
    initial.form.dispatch('change', { target: initial.projectInputs[0] });
    expect(requests).toHaveLength(3);
    expectOnlyReleasesParams(requests[2].url.href, [['pageSize', '1'], ['project', '7'], ['search', 'Needle']]);

    requests[2].resolve(responseFor('newest', requests[2].url.href));
    await flush();
    requests[1].reject(new Error('offline'));
    requests[0].resolve(responseFor('older', requests[0].url.href));
    await flush();
    expect(initial.document.querySelector('[data-releases-live-region]')).toBe(newest.region);
    expect(liveFailureNotice(initial.document)).toBe(null);
    expectOnlyReleasesParams(windowObject.location.href, [['pageSize', '1'], ['project', '7'], ['search', 'Needle']]);
    expect(windowObject.history.pushes).toHaveLength(1);
    expectGetOnly(windowObject);
  });

  it('a defaults refresh that omits Sort/Order does not overwrite the controls with the installed defaults', () => {
    const initial = makeR7Page();
    const windowObject = makePaginationWindow(initial.document, new Map());
    const requests = heldRequests(windowObject);
    enhanceReleasesLiveFiltering(initial.document);

    const generation = beginReleasesDefaultsLiveRefresh(initial.document);
    expect(refreshReleasesLiveRegion(initial.document, R7_RESET_URL, generation)).toBe('started');
    expect(requests).toHaveLength(1);
    // The controls keep what was just saved/shown; nothing guessed.
    expect(initial.sort.checked).toBe(true);
    expect(initial.sortPlanned.checked).toBe(false);
  });

  it('installation clears the deferred Sort/Order so the installed controls serialize again', async () => {
    vi.useFakeTimers();
    const initial = makeR7Page();
    const reset = makeCombinedPage({ pageSize: '1', sortValue: 'planned', orderValue: 'asc' });
    const windowObject = makePaginationWindow(initial.document, new Map([['reset', reset.document]]));
    const requests = heldRequests(windowObject);
    enhanceReleasesLiveFiltering(initial.document);

    navigateReleasesLive(initial.document, R7_RESET_URL);
    requests[0].resolve(responseFor('reset', 'http://creatorcrate.test/releases?pageSize=1'));
    await flush();
    expect(initial.document.querySelector('[data-releases-live-region]')).toBe(reset.region);
    reset.searchInput.value = 'Needle';
    initial.form.dispatch('input', { target: reset.searchInput });
    vi.advanceTimersByTime(1000);
    expectOnlyReleasesParams(requests[1].url.href, [
      ['order', 'asc'], ['pageSize', '1'], ['search', 'Needle'], ['sort', 'planned'],
    ]);
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
 * P3-B: Reset filters through the real WP12 controller and the real Releases
 * engine when the installed defaults authority is missing, malformed or
 * incomplete. The Reset GET keeps the INTENDED page size (the filter form's
 * hidden pageSize: installed, or a newer pending / failed request's) and
 * clears the asset scope, Search, Projects, Project Types, Schedule, Include
 * archived and the page; Sort/Order are left to the saved defaults. GET only.
 */
const P3B_INSTALLED = 'http://creatorcrate.test/releases?asset=42&search=Needle&project=7&project=12'
  + '&type=comic&type=images&schedule=upcoming&includeArchived=1&sort=title&order=desc&pageSize=10';

function p3bAuthority({ omitReset = false, resetFiltersUrl = '/releases?pageSize=10' } = {}) {
  return {
    page: 'releases',
    fields: ['sort', 'order'],
    multiFields: [],
    fallbacks: { sort: 'updated', order: 'desc' },
    defaults: { sort: 'planned', order: 'asc' },
    saved: { sort: { stored: true, valid: true }, order: { stored: true, valid: true } },
    savedKeys: ['sort', 'order'],
    hasSavedDefaults: true,
    generation: 3,
    revision: 'r3',
    current: { sort: 'planned', order: 'asc' },
    currentUrl: '/releases?pageSize=10',
    ...(omitReset ? {} : { resetFiltersUrl }),
  };
}

function appendAuthority(page, authority) {
  const script = makeNode({ tagName: 'script', attrs: { type: 'application/json', 'data-releases-defaults-authority': '' } });
  script.textContent = typeof authority === 'string' ? authority : JSON.stringify(authority);
  page.region.appendChild(script);
  return script;
}

// Installed: asset 42, Search Needle, Projects 7+12, Types comic+images,
// Schedule upcoming, Include archived, Sort title/desc, page size 10.
function makeP3BPage({ pageSize = '10', authority = null } = {}) {
  const page = makeCombinedPage({
    projects: ['7', '12'],
    types: ['comic', 'images'],
    search: 'Needle',
    assetValue: '42',
    pageSize,
    scheduleValue: 'upcoming',
    sortValue: 'title',
    orderValue: 'desc',
    includeArchived: true,
  });
  page.dialog.open = true;
  const scheduleAll = makeNode({ tagName: 'input', attrs: { name: 'schedule', type: 'radio', value: '' }, value: '' });
  page.scheduleDropdown.appendChild(scheduleAll);
  const assetScope = makeNode({ tagName: 'p', attrs: { 'data-releases-asset-scope': '' } });
  page.form.appendChild(assetScope);
  page.next.setAttribute('href', `${P3B_INSTALLED.replace('http://creatorcrate.test', '')}&page=2`);
  if (authority !== null) appendAuthority(page, authority);
  return {
    ...page,
    scheduleAll,
    assetScope,
    assetField: page.form.querySelector('input[name="asset"]'),
    pageSizeField: page.form.querySelector('input[name="pageSize"]'),
  };
}

// A server Reset response: no restrictions, saved Sort/Order, valid authority.
function makeP3BResetResponse(pageSize = '10') {
  const page = makeCombinedPage({ pageSize, sortValue: 'planned', orderValue: 'asc' });
  appendAuthority(page, p3bAuthority({ resetFiltersUrl: pageSize === '25' ? '/releases' : `/releases?pageSize=${pageSize}` }));
  return page;
}

function p3bSetup({ pageSize = '10', authority = null, pages = new Map(), href = P3B_INSTALLED } = {}) {
  const initial = makeP3BPage({ pageSize, authority });
  const windowObject = makeWindow(initial.document, pages);
  windowObject.location.href = href;
  const requests = heldRequests(windowObject);
  enhanceReleasesLiveFiltering(initial.document);
  const statuses = [];
  const controller = createReleasesFiltersDefaults(initial.document, {
    onStatus: (message, kind) => statuses.push({ message, kind }),
  });
  return { initial, windowObject, requests, controller, statuses };
}

function expectP3BClearedControls(page, pageSize = '10') {
  expect(page.searchInput.value).toBe('');
  expect(page.project.checked).toBe(true);
  expect(page.projectInputs.some((input) => input.checked)).toBe(false);
  expect(page.typeInputs.some((input) => input.checked)).toBe(false);
  expect(page.schedule.checked).toBe(false);
  expect(page.scheduleAll.checked).toBe(true);
  expect(page.archived.checked).toBe(false);
  expect(page.assetField.disabled).toBe(true);
  expect(page.assetScope.hidden).toBe(true);
  if (pageSize === '25') {
    expect(page.pageSizeField?.disabled ?? true).toBe(true);
  } else {
    expect(page.pageSizeField.disabled).toBe(false);
    expect(page.pageSizeField.value).toBe(pageSize);
  }
}

const p3bPosts = (windowObject) => windowObject.fetch.mock.calls.filter(([, init]) => init?.method !== 'GET');

describe('P3-B Releases Reset filters keeps the intended page size without a usable authority', () => {
  beforeEach(() => { vi.useRealTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('reviewer reproduction: no authority script -> Reset GET keeps pageSize=10 and clears every restriction', async () => {
    const response = makeP3BResetResponse('10');
    const { initial, windowObject, requests, controller } = p3bSetup({ pages: new Map([['reset', response.document]]) });
    expect(initial.document.querySelector('script[data-releases-defaults-authority]')).toBeNull();

    expect(controller.resetFilters()).toMatchObject({ outcome: 'started' });
    expect(requests).toHaveLength(1);
    expect(requests[0].init.method).toBe('GET');
    // Only the page size: no asset, Search, Projects, Types, Schedule,
    // Include archived, Sort/Order (saved defaults) or page.
    expectOnlyReleasesParams(requests[0].url.href, [['pageSize', '10']]);
    expect(controller.filtersReset).toMatchObject({ phase: 'pending', destination: '/releases?pageSize=10' });
    expectP3BClearedControls(initial);

    requests[0].resolve(responseFor('reset', requests[0].url.href));
    await flush();
    expect(initial.document.querySelector('[data-releases-live-region]')).toBe(response.region);
    expect(windowObject.location.href).toBe('http://creatorcrate.test/releases?pageSize=10');
    expect(windowObject.history.pushes).toHaveLength(1);
    // The installed form is the server's: Sort/Order from the saved defaults,
    // page size 10 kept, no restriction.
    expect(initial.form.querySelector('input[name="pageSize"]').value).toBe('10');
    expect(initial.form.querySelector('input[name="asset"]')).toBeNull();
    expect(initial.form.querySelector('input[name="sort"]').value).toBe('planned');
    expect(initial.form.querySelector('input[name="order"]').value).toBe('asc');
    expect(controller.filtersReset).toBeNull();
    expect(controller.saveBlockedReason()).toBeNull();
    expect(p3bPosts(windowObject)).toHaveLength(0);
  });

  it.each([
    ['malformed authority JSON', '{"page":"releases",'],
    ['incomplete authority (defaults only)', { defaults: { sort: 'planned', order: 'asc' } }],
    ['authority without resetFiltersUrl', p3bAuthority({ omitReset: true })],
    ['authority with an empty resetFiltersUrl', p3bAuthority({ resetFiltersUrl: '' })],
    ['authority with an off-page resetFiltersUrl', p3bAuthority({ resetFiltersUrl: '/calendar?month=2026-11' })],
    ['authority with a cross-origin resetFiltersUrl', p3bAuthority({ resetFiltersUrl: 'https://elsewhere.test/releases?asset=42' })],
  ])('%s -> the fallback Reset keeps pageSize=10', (_label, authority) => {
    const { initial, windowObject, requests, controller } = p3bSetup({ authority });
    expect(controller.resetFilters().outcome).toBe('started');
    expect(requests).toHaveLength(1);
    expect(requests[0].url.origin).toBe('http://creatorcrate.test');
    expectOnlyReleasesParams(requests[0].url.href, [['pageSize', '10']]);
    expectP3BClearedControls(initial);
    expect(p3bPosts(windowObject)).toHaveLength(0);
  });

  it('valid authority: Reset uses the authority destination unchanged', () => {
    const { requests, controller } = p3bSetup({ authority: p3bAuthority() });
    expect(controller.resetFilters().outcome).toBe('started');
    expectOnlyReleasesParams(requests[0].url.href, [['pageSize', '10']]);
  });

  it.each([
    ['25', []],
    ['50', [['pageSize', '50']]],
    ['100', [['pageSize', '100']]],
  ])('page size %s: the fallback keeps exactly the canonical size', (pageSize, expected) => {
    const href = pageSize === '25'
      ? P3B_INSTALLED.replace('&pageSize=10', '')
      : P3B_INSTALLED.replace('pageSize=10', `pageSize=${pageSize}`);
    const { initial, requests, controller } = p3bSetup({ pageSize, href });
    expect(controller.resetFilters().outcome).toBe('started');
    expectOnlyReleasesParams(requests[0].url.href, expected);
    expectP3BClearedControls(initial, pageSize);
  });

  it('held page-size GET -> Reset keeps the newer size (50, not the installed 10) and supersedes it', async () => {
    const { initial, requests, controller } = p3bSetup();
    navigateReleasesLive(initial.document, '/releases?asset=42&search=Needle&pageSize=50');
    expect(requests).toHaveLength(1);
    expect(controller.resetFilters().outcome).toBe('started');
    expect(requests).toHaveLength(2);
    expect(requests[0].init.signal.aborted).toBe(true);
    expectOnlyReleasesParams(requests[1].url.href, [['pageSize', '50']]);
    // The installed size-10 field stays disabled; 50 travels in the R7 carrier.
    expect(initial.pageSizeField.disabled).toBe(true);
    expect(initial.form.querySelectorAll('input[name="pageSize"]')
      .filter((input) => !input.disabled).map((input) => input.value)).toEqual(['50']);
    expect(initial.searchInput.value).toBe('');
    expect(initial.assetField.disabled).toBe(true);
  });

  it('held default-size GET -> Reset keeps the default (bare /releases)', () => {
    const { initial, requests, controller } = p3bSetup();
    navigateReleasesLive(initial.document, '/releases?asset=42&search=Needle');
    expect(controller.resetFilters().outcome).toBe('started');
    expectOnlyReleasesParams(requests[1].url.href, []);
  });

  it('failed page-size GET -> Reset keeps the failed request\'s size', async () => {
    const { initial, requests, controller } = p3bSetup();
    navigateReleasesLive(initial.document, '/releases?asset=42&search=Needle&pageSize=50');
    requests[0].reject(new Error('offline'));
    await flush();
    expect(liveFailureRetries(initial.document)).toHaveLength(1);
    expect(controller.resetFilters().outcome).toBe('started');
    expectOnlyReleasesParams(requests[1].url.href, [['pageSize', '50']]);
  });

  it('an unsupported size in a held request is normalized by the list GET rule, never adopted', () => {
    const { initial, requests, controller } = p3bSetup();
    navigateReleasesLive(initial.document, '/releases?pageSize=500');
    expect(controller.resetFilters().outcome).toBe('started');
    expectOnlyReleasesParams(requests[1].url.href, [['pageSize', '100']]);
    navigateReleasesLive(initial.document, '/releases?pageSize=abc');
    expect(controller.resetFilters().outcome).toBe('started');
    expectOnlyReleasesParams(requests[3].url.href, []);
  });

  it('Reset held -> a newer page-size navigation wins; the older Reset never installs', async () => {
    const reset = makeP3BResetResponse('10');
    const sized = makeP3BResetResponse('50');
    const { initial, windowObject, requests, controller } = p3bSetup({
      pages: new Map([['reset', reset.document], ['sized', sized.document]]),
    });
    controller.resetFilters();
    navigateReleasesLive(initial.document, '/releases?pageSize=50');
    expect(requests[0].init.signal.aborted).toBe(true);
    expect(controller.filtersReset).toBeNull();
    expectOnlyReleasesParams(requests[1].url.href, [['pageSize', '50']]);
    requests[1].resolve(responseFor('sized', requests[1].url.href));
    await flush();
    requests[0].resolve(responseFor('reset', requests[0].url.href));
    await flush();
    expect(initial.document.querySelector('[data-releases-live-region]')).toBe(sized.region);
    expect(windowObject.location.href).toBe('http://creatorcrate.test/releases?pageSize=50');
  });

  it('R7: missing-authority Reset held -> Search keeps size 10 and the cleared restrictions', async () => {
    vi.useFakeTimers();
    const { initial, windowObject, requests, controller } = p3bSetup();
    controller.resetFilters();
    initial.searchInput.value = 'Other';
    initial.form.dispatch('input', { target: initial.searchInput });
    vi.advanceTimersByTime(1000);
    expect(requests).toHaveLength(2);
    expect(requests[0].init.signal.aborted).toBe(true);
    expectOnlyReleasesParams(requests[1].url.href, [['pageSize', '10'], ['search', 'Other']]);
    expectGetOnly(windowObject);
  });

  it.each([
    ['Project', (page) => { page.project.checked = false; page.projectInputs[1].checked = true; return page.projectInputs[1]; }, [['project', '12']]],
    ['Project Type', (page) => { page.typeInputs[1].checked = true; return page.typeInputs[1]; }, [['type', 'images']]],
  ])('R7: missing-authority Reset held -> %s edit keeps size 10 and only that restriction', (_label, edit, expected) => {
    const { initial, windowObject, requests, controller } = p3bSetup();
    controller.resetFilters();
    const target = edit(initial);
    initial.form.dispatch('change', { target });
    expect(requests).toHaveLength(2);
    expectOnlyReleasesParams(requests[1].url.href, [['pageSize', '10'], ...expected]);
    expect(requests[1].url.searchParams.has('asset')).toBe(false);
    expectGetOnly(windowObject);
  });

  it('R7: repeated Projects deliberately added after Reset stay repeated', () => {
    const { initial, requests, controller } = p3bSetup();
    controller.resetFilters();
    initial.project.checked = false;
    initial.projectInputs[0].checked = true;
    initial.projectInputs[1].checked = true;
    initial.form.dispatch('change', { target: initial.projectInputs[1] });
    expectOnlyReleasesParams(requests[1].url.href, [['pageSize', '10'], ['project', '7'], ['project', '12']]);
  });

  it('R1: missing-authority Reset -> Search (held) -> page 2 composes Reset + Search + size 10', async () => {
    vi.useFakeTimers();
    const { initial, requests, controller } = p3bSetup();
    controller.resetFilters();
    initial.searchInput.value = 'Other';
    initial.form.dispatch('input', { target: initial.searchInput });
    vi.advanceTimersByTime(1000);
    initial.next.dispatch('click');
    expect(requests).toHaveLength(3);
    // Not the stale installed pagination href.
    expectOnlyReleasesParams(requests[2].url.href, [['page', '2'], ['pageSize', '10'], ['search', 'Other']]);
  });

  it('failed fallback Reset: installed results stay, GET-only Retry repeats it, a newer Search supersedes Retry', async () => {
    vi.useFakeTimers();
    const reset = makeP3BResetResponse('10');
    const { initial, windowObject, requests, controller } = p3bSetup({ pages: new Map([['reset', reset.document]]) });
    controller.resetFilters();
    requests[0].reject(new Error('offline'));
    await flush();
    expect(initial.document.querySelector('[data-releases-live-region]')).toBe(initial.region);
    expect(controller.filtersReset).toMatchObject({ phase: 'failed', destination: '/releases?pageSize=10' });
    expectP3BClearedControls(initial);

    liveFailureRetries(initial.document)[0].dispatch('click');
    expect(requests).toHaveLength(2);
    expect(requests[1].url.href).toBe(requests[0].url.href);
    expectOnlyReleasesParams(requests[1].url.href, [['pageSize', '10']]);
    expect(controller.filtersReset).toMatchObject({ phase: 'pending', generation: expect.any(Number) });

    initial.searchInput.value = 'Other';
    initial.form.dispatch('input', { target: initial.searchInput });
    vi.advanceTimersByTime(1000);
    expect(requests).toHaveLength(3);
    expect(requests[1].init.signal.aborted).toBe(true);
    expectOnlyReleasesParams(requests[2].url.href, [['pageSize', '10'], ['search', 'Other']]);
    // Older answers arriving last never install.
    requests[1].resolve(responseFor('reset', requests[1].url.href));
    await flush();
    requests[0].reject(new Error('late'));
    await flush();
    expect(initial.document.querySelector('[data-releases-live-region]')).toBe(initial.region);
    expect(p3bPosts(windowObject)).toHaveLength(0);
  });

  it('Back returns to the previous filters and size; Forward restores the Reset state', async () => {
    const reset = makeP3BResetResponse('10');
    const back = makeP3BPage({ authority: p3bAuthority() });
    const forward = makeP3BResetResponse('10');
    const { initial, windowObject, requests, controller } = p3bSetup({
      pages: new Map([['reset', reset.document], ['back', back.document], ['forward', forward.document]]),
    });
    controller.resetFilters();
    requests[0].resolve(responseFor('reset', requests[0].url.href));
    await flush();
    const resetHref = windowObject.location.href;
    expect(resetHref).toBe('http://creatorcrate.test/releases?pageSize=10');
    expect(windowObject.history.pushes).toHaveLength(1);

    windowObject.location.href = P3B_INSTALLED;
    windowObject.dispatch('popstate');
    expect(requests[1].url.href).toBe(P3B_INSTALLED);
    requests[1].resolve(responseFor('back', requests[1].url.href));
    await flush();
    expect(initial.document.querySelector('[data-releases-live-region]')).toBe(back.region);

    windowObject.location.href = resetHref;
    windowObject.dispatch('popstate');
    expectOnlyReleasesParams(requests[2].url.href, [['pageSize', '10']]);
    requests[2].resolve(responseFor('forward', requests[2].url.href));
    await flush();
    expect(initial.document.querySelector('[data-releases-live-region]')).toBe(forward.region);
    expect(windowObject.history.pushes).toHaveLength(1);
    expect(p3bPosts(windowObject)).toHaveLength(0);
  });

  it('fails closed with an accessible message when the size cannot be read safely', () => {
    const { initial, windowObject, requests, controller, statuses } = p3bSetup();
    const conflicting = makeNode({ tagName: 'input', attrs: { name: 'pageSize', type: 'hidden', value: '50' }, value: '50' });
    initial.form.appendChild(conflicting);
    expect(controller.resetFilters()).toEqual({ outcome: 'blocked' });
    expect(requests).toHaveLength(0);
    expect(statuses.at(-1)).toEqual({ message: RELEASES_DEFAULTS_MESSAGES.resetFiltersUnavailable, kind: 'error' });
    expect(windowObject.location.href).toBe(P3B_INSTALLED);
  });
});

/*
 * R9: a requested Project / Project Type without a rendered option travels in
 * a hidden intent carrier while the real multi-select (no individual value
 * checked) reconciles its empty Select all back to checked. The serializer
 * must not let that empty placeholder erase the carrier's restriction.
 * A deliberate Select all still clears: the dropdown unchecks every value and
 * the change event removes the carriers before the GET is composed.
 *
 * These fixtures use the REAL dropdown module (enhanceDropdowns) for the
 * Project and Project Type multi-selects, so Select all reconciliation is the
 * production code path rather than a hand-toggled checkbox.
 */
const R9_INSTALLED_URL = 'http://creatorcrate.test/releases?pageSize=10';
const R9_UNKNOWN_URL = 'http://creatorcrate.test/releases?project=999999&pageSize=10';

function makeR9MultiDropdown(form, name, options, selected) {
  const dropdown = makeNode({
    tagName: 'details',
    attrs: {
      id: `release-${name}-filter`,
      'data-cc-dropdown': '',
      'data-cc-dropdown-mode': 'multiple',
      'data-cc-dropdown-select-all': '',
      'data-cc-dropdown-empty-summary': name === 'project' ? 'All projects' : 'All types',
      'data-cc-dropdown-count-label': name === 'project' ? 'projects' : 'types',
    },
  });
  const label = name === 'project' ? 'Projects' : 'Project Types';
  const summary = makeNode({ tagName: 'summary', attrs: { 'aria-label': `${label}: ` } });
  const current = makeNode({ tagName: 'span', attrs: { 'data-cc-dropdown-summary-current': '' } });
  summary.appendChild(current);
  dropdown.appendChild(summary);
  const selectAll = makeNode({
    tagName: 'input',
    attrs: { name, type: 'checkbox', value: '', 'data-cc-dropdown-select-all': '' },
    value: '',
    checked: selected.length === 0,
  });
  dropdown.appendChild(selectAll);
  const inputs = options.map((value) => {
    const input = makeNode({
      tagName: 'input',
      attrs: { name, type: 'checkbox', value },
      value,
      checked: selected.includes(value),
    });
    dropdown.appendChild(input);
    return input;
  });
  form.appendChild(dropdown);
  return {
    dropdown, summary, current, selectAll, inputs, option: (value) => inputs.find((input) => input.value === value),
  };
}

function makeR9Page({
  projects = ['7', '12'], types = ['comic', 'images'], selectedProjects = [], selectedTypes = [],
  unavailableProjects = [], search = '', marker = 'installed',
} = {}) {
  const page = makePage('/releases', { pageSize: '10', resetUrl: '/releases?pageSize=10', dialogOpen: true });
  // The single-select stand-in is replaced by the real multi-select shape.
  page.projectDropdown.remove();
  const searchInput = makeNode({
    tagName: 'input',
    attrs: { id: 'releases-search', name: 'search', type: 'search', 'data-releases-search': '' },
    value: search,
  });
  page.form.appendChild(searchInput);
  // The server renders an "Unavailable project" option for a selected ID it
  // does not list (buildReleasesProjectFilterModel), so an installed page
  // never needs a carrier.
  const project = makeR9MultiDropdown(
    page.form, 'project', [...unavailableProjects, ...projects], [...unavailableProjects, ...selectedProjects],
  );
  const type = makeR9MultiDropdown(page.form, 'type', types, selectedTypes);
  const results = makeNode({ attrs: { 'data-r9-results': marker } });
  page.region.appendChild(results);
  return { ...page, searchInput, project, type, results };
}

function makeR9Window(document, pages, href = R9_INSTALLED_URL) {
  const windowObject = makeWindow(document, pages);
  windowObject.location.href = href;
  return windowObject;
}

function r9Setup({ page = makeR9Page(), pages = new Map(), href } = {}) {
  const windowObject = makeR9Window(page.document, pages, href);
  const requests = heldRequests(windowObject);
  enhanceReleasesLiveFiltering(page.document);
  enhanceDropdowns(page.document);
  return { page, windowObject, requests };
}

// A user click on a real multi-select checkbox: the browser toggles it, the
// dropdown's click handler may cancel (Select all cannot be unchecked into
// nothing), then `change` runs the dropdown's capture listener on the
// document before the form's own (live engine) listener.
function r9UserToggle(page, input) {
  const { document } = page;
  input.checked = !input.checked;
  const click = {
    type: 'click', target: input, button: 0, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  };
  document.listeners.filter((listener) => listener.type === 'click').forEach(({ handler }) => handler(click));
  if (click.defaultPrevented) {
    input.checked = !input.checked;
    return false;
  }
  const change = { type: 'change', target: input, button: 0, defaultPrevented: false, preventDefault() {} };
  document.listeners.filter((listener) => listener.type === 'change').forEach(({ handler }) => handler(change));
  let current = input;
  while (current && current !== document) {
    current.listeners.filter((listener) => listener.type === 'change').forEach(({ handler }) => handler(change));
    current = current.parentNode;
  }
  return true;
}

function r9Type(page, value) {
  page.searchInput.value = value;
  page.form.dispatch('input', { target: page.searchInput });
}

function r9Carriers(page, name) {
  return page.form.querySelectorAll(`input[data-releases-intended-carrier][name="${name}"]`)
    .map((input) => input.value);
}

function r9Region(page) {
  return page.document.querySelector('[data-releases-live-region]');
}

describe('R9 hidden multi-select restrictions survive form serialization', () => {
  beforeEach(() => { vi.useRealTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  describe('focused serializer: an empty value never erases nonempty values of its name', () => {
    it.each([
      ['project="" + project="999999"', ['999999'], [['project', '999999']]],
      ['project="" + project="7" + project="15"', ['7', '15'], [['project', '7'], ['project', '15']]],
    ])('%s', (_label, hiddenValues, expected) => {
      vi.useFakeTimers();
      const page = makeR9Page();
      hiddenValues.forEach((value) => {
        page.form.appendChild(makeNode({ tagName: 'input', attrs: { name: 'project', type: 'hidden', value }, value }));
      });
      const { requests } = r9Setup({ page });
      expect(page.project.selectAll.checked).toBe(true);
      r9Type(page, 'Needle');
      expectOnlyReleasesParams(releasesLiveSnapshot(page.document).intendedUrl, [
        ['order', 'asc'], ['pageSize', '10'], ['search', 'Needle'], ['sort', 'planned'], ...expected,
      ]);
      vi.advanceTimersByTime(1000);
      expect(requests).toHaveLength(1);
      expect(requests[0].url.searchParams.getAll('project')).toEqual(hiddenValues);
      // Repeated parameters, never comma-joined.
      expect(requests[0].url.search).not.toContain('%2C');
    });

    it('only empty entries are dropped: an empty Search and Select all alone stay unrestricted', () => {
      vi.useFakeTimers();
      const { page, requests } = r9Setup();
      r9Type(page, '');
      vi.advanceTimersByTime(1000);
      // The installed Sort / Order are rendered as checked radios.
      expectOnlyReleasesParams(requests[0].url.href, [['order', 'asc'], ['pageSize', '10'], ['sort', 'planned']]);
    });
  });

  it('reviewer reproduction: Back to an unavailable Project held -> Search Needle keeps project=999999; the late Back never installs', async () => {
    vi.useFakeTimers();
    const page = makeR9Page();
    const searched = makeR9Page({ unavailableProjects: ['999999'], search: 'Needle', marker: 'needle-restricted' });
    const back = makeR9Page({ unavailableProjects: ['999999'], marker: 'back' });
    const { windowObject, requests } = r9Setup({
      page, pages: new Map([['searched', searched.document], ['back', back.document]]),
    });

    windowObject.location.href = R9_UNKNOWN_URL;
    windowObject.dispatch('popstate');
    expect(requests).toHaveLength(1);
    expect(requests[0].url.href).toBe(R9_UNKNOWN_URL);
    // R10: the real dropdown counts the hidden carrier as selected, so Select
    // all is unchecked and the summary is restricted, not All projects.
    expect(r9Carriers(page, 'project')).toEqual(['999999']);
    expect(page.project.selectAll.checked).toBe(false);
    expect(page.project.current.textContent).toBe('1 project selected');
    expect(page.project.inputs.some((input) => input.checked)).toBe(false);
    expect(Array.from(new windowObject.FormData(page.form).entries())
      .filter(([name]) => name === 'project')
      .map(([, value]) => value)).toEqual(['999999']);

    r9Type(page, 'Needle');
    expectOnlyReleasesParams(releasesLiveSnapshot(page.document).intendedUrl, [
      ['pageSize', '10'], ['project', '999999'], ['search', 'Needle'],
    ]);
    vi.advanceTimersByTime(1000);
    expect(requests).toHaveLength(2);
    expect(requests[0].init.signal.aborted).toBe(true);
    expectOnlyReleasesParams(requests[1].url.href, [
      ['pageSize', '10'], ['project', '999999'], ['search', 'Needle'],
    ]);

    requests[1].resolve(responseFor('searched', requests[1].url.href));
    await flush();
    requests[0].resolve(responseFor('back', requests[0].url.href));
    await flush();
    expect(r9Region(page)).toBe(searched.region);
    expect(r9Region(page).querySelector('[data-r9-results]').getAttribute('data-r9-results')).toBe('needle-restricted');
    expectOnlyReleasesParams(windowObject.location.href, [
      ['pageSize', '10'], ['project', '999999'], ['search', 'Needle'],
    ]);
    expect(windowObject.history.pushes).toHaveLength(1);
    expectGetOnly(windowObject);
  });

  it.each([
    ['an archived Project not among the rendered options', 'project=15&pageSize=10', [['project', '15']], { project: ['15'] }],
    ['valid + unavailable Projects', 'project=7&project=999999&pageSize=10', [['project', '7'], ['project', '999999']], { project: ['999999'] }],
    ['repeated valid Projects', 'project=7&project=12&pageSize=10', [['project', '7'], ['project', '12']], {}],
    ['a Project Type not rendered', 'type=audio&pageSize=10', [['type', 'audio']], { type: ['audio'] }],
    ['repeated Types, one not rendered', 'type=comic&type=audio&pageSize=10', [['type', 'comic'], ['type', 'audio']], { type: ['audio'] }],
    ['unknown Project and Type together', 'project=999999&type=audio&pageSize=10', [['project', '999999'], ['type', 'audio']], { project: ['999999'], type: ['audio'] }],
  ])('Back held to %s -> Search keeps every requested value', (_label, query, expected, carriers) => {
    vi.useFakeTimers();
    const { page, windowObject, requests } = r9Setup();
    windowObject.location.href = `http://creatorcrate.test/releases?${query}`;
    windowObject.dispatch('popstate');
    expect(r9Carriers(page, 'project')).toEqual(carriers.project || []);
    expect(r9Carriers(page, 'type')).toEqual(carriers.type || []);
    r9Type(page, 'Needle');
    vi.advanceTimersByTime(1000);
    expect(requests).toHaveLength(2);
    expectOnlyReleasesParams(requests[1].url.href, [['pageSize', '10'], ['search', 'Needle'], ...expected]);
    // No duplicate IDs.
    ['project', 'type'].forEach((name) => {
      const values = requests[1].url.searchParams.getAll(name);
      expect(new Set(values).size).toBe(values.length);
    });
    expectGetOnly(windowObject);
  });

  it('Forward held -> Search keeps the Forward entry\'s unavailable Project', () => {
    vi.useFakeTimers();
    const { page, windowObject, requests } = r9Setup({ href: R9_UNKNOWN_URL, page: makeR9Page({ unavailableProjects: ['999999'] }) });
    windowObject.location.href = R9_INSTALLED_URL;
    windowObject.dispatch('popstate');
    expectOnlyReleasesParams(requests[0].url.href, [['pageSize', '10']]);
    windowObject.location.href = R9_UNKNOWN_URL;
    windowObject.dispatch('popstate');
    expect(requests).toHaveLength(2);
    // The installed page rendered 999999 as an option: no carrier is needed.
    expect(page.project.option('999999').checked).toBe(true);
    expect(page.project.selectAll.checked).toBe(false);
    r9Type(page, 'Needle');
    vi.advanceTimersByTime(1000);
    expectOnlyReleasesParams(requests[2].url.href, [['pageSize', '10'], ['project', '999999'], ['search', 'Needle']]);
  });

  it('failed Back -> Search keeps the failed destination\'s unavailable Project; GET-only Retry repeats it', async () => {
    vi.useFakeTimers();
    const { page, windowObject, requests } = r9Setup();
    windowObject.location.href = R9_UNKNOWN_URL;
    windowObject.dispatch('popstate');
    requests[0].reject(new Error('offline'));
    await flush();
    expect(liveFailureRetries(page.document)).toHaveLength(1);
    expect(r9Carriers(page, 'project')).toEqual(['999999']);
    r9Type(page, 'Needle');
    vi.advanceTimersByTime(1000);
    expectOnlyReleasesParams(requests[1].url.href, [['pageSize', '10'], ['project', '999999'], ['search', 'Needle']]);
    requests[1].reject(new Error('offline'));
    await flush();
    liveFailureRetries(page.document)[0].dispatch('click');
    expect(requests).toHaveLength(3);
    expect(requests[2].url.href).toBe(requests[1].url.href);
    expectGetOnly(windowObject);
  });

  it('Search debounce while Back is held: rapid edits all keep the restriction', () => {
    vi.useFakeTimers();
    const { page, windowObject, requests } = r9Setup();
    windowObject.location.href = R9_UNKNOWN_URL;
    windowObject.dispatch('popstate');
    r9Type(page, 'Nee');
    vi.advanceTimersByTime(200);
    r9Type(page, 'Needle');
    vi.advanceTimersByTime(1000);
    expect(requests).toHaveLength(2);
    expectOnlyReleasesParams(requests[1].url.href, [['pageSize', '10'], ['project', '999999'], ['search', 'Needle']]);
  });

  it('Back held -> choosing a rendered Project replaces the unavailable one (the dimension was edited)', () => {
    vi.useFakeTimers();
    const { page, windowObject, requests } = r9Setup();
    windowObject.location.href = R9_UNKNOWN_URL;
    windowObject.dispatch('popstate');
    expect(r9UserToggle(page, page.project.option('7'))).toBe(true);
    expect(page.project.selectAll.checked).toBe(false);
    expect(r9Carriers(page, 'project')).toEqual([]);
    expect(requests).toHaveLength(2);
    expectOnlyReleasesParams(requests[1].url.href, [['pageSize', '10'], ['project', '7']]);

    // Deselecting the last value returns to All: unrestricted, no leak.
    expect(r9UserToggle(page, page.project.option('7'))).toBe(true);
    expect(page.project.selectAll.checked).toBe(true);
    expect(requests).toHaveLength(3);
    expectOnlyReleasesParams(requests[2].url.href, [['pageSize', '10']]);
    expectGetOnly(windowObject);
  });

  it('Back held -> a Type edit keeps the unavailable Project and adds only the Type', () => {
    vi.useFakeTimers();
    const { page, windowObject, requests } = r9Setup();
    windowObject.location.href = R9_UNKNOWN_URL;
    windowObject.dispatch('popstate');
    r9UserToggle(page, page.type.option('images'));
    expect(requests).toHaveLength(2);
    expectOnlyReleasesParams(requests[1].url.href, [['pageSize', '10'], ['project', '999999'], ['type', 'images']]);
    // Deselecting the last Type clears only Type.
    r9UserToggle(page, page.type.option('images'));
    expectOnlyReleasesParams(requests[2].url.href, [['pageSize', '10'], ['project', '999999']]);
  });

  it('explicit Select all over chosen Projects clears every value, carriers included', () => {
    vi.useFakeTimers();
    const { page, windowObject, requests } = r9Setup({
      href: 'http://creatorcrate.test/releases?project=7&pageSize=10',
      page: makeR9Page({ selectedProjects: ['7'] }),
    });
    // Back to 7 + unavailable 999999: 7 checked, 999999 carried.
    windowObject.location.href = 'http://creatorcrate.test/releases?project=7&project=999999&pageSize=10';
    windowObject.dispatch('popstate');
    expect(page.project.option('7').checked).toBe(true);
    expect(page.project.selectAll.checked).toBe(false);
    expect(r9Carriers(page, 'project')).toEqual(['999999']);

    expect(r9UserToggle(page, page.project.selectAll)).toBe(true);
    expect(page.project.selectAll.checked).toBe(true);
    expect(page.project.inputs.some((input) => input.checked)).toBe(false);
    expect(r9Carriers(page, 'project')).toEqual([]);
    expect(requests).toHaveLength(2);
    expectOnlyReleasesParams(requests[1].url.href, [['pageSize', '10']]);

    // A later Search composes with the deliberate unrestricted choice.
    r9Type(page, 'Needle');
    vi.advanceTimersByTime(1000);
    expectOnlyReleasesParams(requests[2].url.href, [['pageSize', '10'], ['search', 'Needle']]);
    expectGetOnly(windowObject);
  });

  it('genuinely unrestricted -> clicking the checked Select all is still cancelled: no GET', () => {
    vi.useFakeTimers();
    const { page, requests } = r9Setup();
    expect(page.project.selectAll.checked).toBe(true);
    expect(r9UserToggle(page, page.project.selectAll)).toBe(false);
    expect(page.project.selectAll.checked).toBe(true);
    expect(page.project.current.textContent).toBe('All projects');
    vi.advanceTimersByTime(1000);
    expect(requests).toHaveLength(0);
  });

  it('Reset filters during a held Back drops the carried restriction; a later Search stays unrestricted', () => {
    vi.useFakeTimers();
    const { page, windowObject, requests } = r9Setup();
    windowObject.location.href = 'http://creatorcrate.test/releases?project=999999&type=audio&pageSize=10';
    windowObject.dispatch('popstate');
    expect(r9Carriers(page, 'project')).toEqual(['999999']);
    page.reset.dispatch('click');
    expect(requests).toHaveLength(2);
    expect(requests[0].init.signal.aborted).toBe(true);
    expectOnlyReleasesParams(requests[1].url.href, [['pageSize', '10']]);
    expect(r9Carriers(page, 'project')).toEqual([]);
    expect(r9Carriers(page, 'type')).toEqual([]);
    expect(page.project.selectAll.checked).toBe(true);
    r9Type(page, 'Needle');
    vi.advanceTimersByTime(1000);
    expectOnlyReleasesParams(requests[2].url.href, [['pageSize', '10'], ['search', 'Needle']]);
    expectGetOnly(windowObject);
  });

  it('Back to the unrestricted entry while a restricted Search is held clears the carrier', () => {
    vi.useFakeTimers();
    const { page, windowObject, requests } = r9Setup();
    windowObject.location.href = R9_UNKNOWN_URL;
    windowObject.dispatch('popstate');
    r9Type(page, 'Needle');
    vi.advanceTimersByTime(1000);
    windowObject.location.href = R9_INSTALLED_URL;
    windowObject.dispatch('popstate');
    expect(requests).toHaveLength(3);
    expect(r9Carriers(page, 'project')).toEqual([]);
    r9Type(page, 'Other');
    vi.advanceTimersByTime(1000);
    expectOnlyReleasesParams(requests[3].url.href, [['pageSize', '10'], ['search', 'Other']]);
  });
});

/*
 * R10: a pending / failed history destination whose Project / Project Type has
 * no rendered option keeps it in a hidden carrier (R9). The real dropdown
 * counts that carrier as selected: Select all is unchecked and the summary is
 * restricted (never "All projects" / "All types"). One ordinary Select all
 * activation clears the whole dimension (visible values and carriers), sends
 * one GET without that parameter and keeps every other dimension. No test
 * here removes a carrier directly: the dropdown's own click / change path does.
 */
describe('R10 pending hidden-selection dropdown state and one-click clearing', () => {
  beforeEach(() => { vi.useRealTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  // The live engine swaps in the installed form: read the current controls.
  const current = (page, name) => {
    const dropdown = page.document.querySelector(`#release-${name}-filter`);
    return {
      dropdown,
      summary: dropdown.querySelector('[data-cc-dropdown-summary-current]').textContent,
      aria: dropdown.querySelector('summary').getAttribute('aria-label'),
      selectAll: dropdown.querySelector('input[data-cc-dropdown-select-all]').checked,
      checked: dropdown.querySelectorAll('input[type="checkbox"]')
        .filter((input) => input.checked && !input.hasAttribute('data-cc-dropdown-select-all'))
        .map((input) => input.value),
    };
  };
  const allCarriers = (page) => page.document.querySelectorAll('input[data-releases-intended-carrier]').length;
  const results = (page) => r9Region(page).querySelector('[data-r9-results]').getAttribute('data-r9-results');

  it('reviewer sequence: Reset installed -> Back held to project=999999 -> one Select all clears it; the late Back never reinstalls it', async () => {
    vi.useFakeTimers();
    // The installed (Reset) page renders no option for 999999.
    const page = makeR9Page();
    const unrestricted = makeR9Page({ marker: 'ids:1,2,3|count:3' });
    const back = makeR9Page({ unavailableProjects: ['999999'], marker: 'ids:|count:0' });
    const { windowObject, requests } = r9Setup({
      page, pages: new Map([['unrestricted', unrestricted.document], ['back', back.document]]),
    });

    windowObject.location.href = R9_UNKNOWN_URL;
    windowObject.dispatch('popstate');
    expect(requests).toHaveLength(1);
    expect(r9Carriers(page, 'project')).toEqual(['999999']);
    expect(page.project.current.textContent).not.toBe('All projects');
    expect(page.project.current.textContent).toBe('1 project selected');
    expect(page.project.summary.getAttribute('aria-label')).toBe('Projects: 1 project selected');
    expect(page.project.selectAll.checked).toBe(false);
    // Type is untouched and genuinely unrestricted.
    expect(page.type.current.textContent).toBe('All types');
    expect(page.type.selectAll.checked).toBe(true);

    expect(r9UserToggle(page, page.project.selectAll)).toBe(true);
    expect(r9Carriers(page, 'project')).toEqual([]);
    expect(page.project.selectAll.checked).toBe(true);
    expect(page.project.current.textContent).toBe('All projects');
    expect(requests).toHaveLength(2);
    expect(requests[0].init.signal.aborted).toBe(true);
    // Page size retained; project omitted.
    expectOnlyReleasesParams(requests[1].url.href, [['pageSize', '10']]);
    vi.advanceTimersByTime(1000);
    expect(requests).toHaveLength(2);

    requests[1].resolve(responseFor('unrestricted', requests[1].url.href));
    await flush();
    requests[0].resolve(responseFor('back', requests[0].url.href));
    await flush();
    expect(r9Region(page)).toBe(unrestricted.region);
    expect(results(page)).toBe('ids:1,2,3|count:3');
    expectOnlyReleasesParams(windowObject.location.href, [['pageSize', '10']]);
    expect(current(page, 'project')).toMatchObject({ summary: 'All projects', selectAll: true, checked: [] });
    expect(allCarriers(page)).toBe(0);
    expectGetOnly(windowObject);
  });

  it('Back held -> Search keeps 999999 -> Select all clears it while keeping Search', () => {
    vi.useFakeTimers();
    const { page, windowObject, requests } = r9Setup();
    windowObject.location.href = R9_UNKNOWN_URL;
    windowObject.dispatch('popstate');
    r9Type(page, 'Needle');
    vi.advanceTimersByTime(1000);
    expectOnlyReleasesParams(requests[1].url.href, [['pageSize', '10'], ['project', '999999'], ['search', 'Needle']]);
    expect(page.project.current.textContent).toBe('1 project selected');

    expect(r9UserToggle(page, page.project.selectAll)).toBe(true);
    expect(requests).toHaveLength(3);
    expect(requests[1].init.signal.aborted).toBe(true);
    expectOnlyReleasesParams(requests[2].url.href, [['pageSize', '10'], ['search', 'Needle']]);
    // A later Search stays unrestricted by the cleared Project.
    r9Type(page, 'Needles');
    vi.advanceTimersByTime(1000);
    expectOnlyReleasesParams(requests[3].url.href, [['pageSize', '10'], ['search', 'Needles']]);
    expectGetOnly(windowObject);
  });

  it('Back held -> Select all -> Search composes with the deliberate unrestricted choice', () => {
    vi.useFakeTimers();
    const { page, windowObject, requests } = r9Setup();
    windowObject.location.href = R9_UNKNOWN_URL;
    windowObject.dispatch('popstate');
    r9UserToggle(page, page.project.selectAll);
    r9Type(page, 'Needle');
    vi.advanceTimersByTime(1000);
    expect(requests).toHaveLength(3);
    expectOnlyReleasesParams(requests[2].url.href, [['pageSize', '10'], ['search', 'Needle']]);
  });

  it('failed Back -> restricted summary stays; Select all clears without Retry', async () => {
    vi.useFakeTimers();
    const unrestricted = makeR9Page({ marker: 'ids:1,2,3|count:3' });
    const { page, windowObject, requests } = r9Setup({ pages: new Map([['unrestricted', unrestricted.document]]) });
    windowObject.location.href = R9_UNKNOWN_URL;
    windowObject.dispatch('popstate');
    requests[0].reject(new Error('offline'));
    await flush();
    expect(liveFailureRetries(page.document)).toHaveLength(1);
    expect(page.project.current.textContent).toBe('1 project selected');
    expect(page.project.selectAll.checked).toBe(false);

    expect(r9UserToggle(page, page.project.selectAll)).toBe(true);
    expect(requests).toHaveLength(2);
    expectOnlyReleasesParams(requests[1].url.href, [['pageSize', '10']]);
    requests[1].resolve(responseFor('unrestricted', requests[1].url.href));
    await flush();
    expect(results(page)).toBe('ids:1,2,3|count:3');
    expectOnlyReleasesParams(windowObject.location.href, [['pageSize', '10']]);
    expect(allCarriers(page)).toBe(0);
    expectGetOnly(windowObject);
  });

  it('failed Back -> GET-only Retry held -> Select all supersedes Retry; the late Retry never installs', async () => {
    vi.useFakeTimers();
    const unrestricted = makeR9Page({ marker: 'ids:1,2,3|count:3' });
    const retried = makeR9Page({ unavailableProjects: ['999999'], marker: 'ids:|count:0' });
    const { page, windowObject, requests } = r9Setup({
      pages: new Map([['unrestricted', unrestricted.document], ['retried', retried.document]]),
    });
    windowObject.location.href = R9_UNKNOWN_URL;
    windowObject.dispatch('popstate');
    requests[0].reject(new Error('offline'));
    await flush();
    liveFailureRetries(page.document)[0].dispatch('click');
    expect(requests).toHaveLength(2);
    expect(requests[1].url.href).toBe(R9_UNKNOWN_URL);
    // Retry keeps the restriction truthful.
    expect(page.project.current.textContent).toBe('1 project selected');
    expect(page.project.selectAll.checked).toBe(false);

    expect(r9UserToggle(page, page.project.selectAll)).toBe(true);
    expect(requests).toHaveLength(3);
    expect(requests[1].init.signal.aborted).toBe(true);
    expectOnlyReleasesParams(requests[2].url.href, [['pageSize', '10']]);
    requests[2].resolve(responseFor('unrestricted', requests[2].url.href));
    await flush();
    requests[1].resolve(responseFor('retried', requests[1].url.href));
    await flush();
    expect(results(page)).toBe('ids:1,2,3|count:3');
    expectOnlyReleasesParams(windowObject.location.href, [['pageSize', '10']]);
    expect(current(page, 'project').selectAll).toBe(true);
    expectGetOnly(windowObject);
  });

  it('Forward held to an unavailable Project -> one Select all clears it', () => {
    vi.useFakeTimers();
    const { page, windowObject, requests } = r9Setup({ href: R9_UNKNOWN_URL });
    windowObject.location.href = R9_INSTALLED_URL;
    windowObject.dispatch('popstate');
    windowObject.location.href = R9_UNKNOWN_URL;
    windowObject.dispatch('popstate');
    expect(page.project.current.textContent).toBe('1 project selected');
    expect(r9UserToggle(page, page.project.selectAll)).toBe(true);
    expect(requests).toHaveLength(3);
    expectOnlyReleasesParams(requests[2].url.href, [['pageSize', '10']]);
  });

  it.each([
    ['A. one hidden Project', 'project=999999', 'project', [], '1 project selected'],
    ['B. two hidden Projects', 'project=999999&project=888888', 'project', [], '2 projects selected'],
    ['C. one visible + one hidden Project', 'project=7&project=999999', 'project', ['7'], '2 projects selected'],
    ['D. several visible + hidden Projects', 'project=7&project=12&project=999999&project=888888', 'project', ['7', '12'], '4 projects selected'],
    ['E. one unknown Project Type', 'type=audio', 'type', [], '1 type selected'],
    ['F. visible + unknown Types', 'type=comic&type=audio', 'type', ['comic'], '2 types selected'],
    ['G. archived Project + visible Project', 'project=15&project=7', 'project', ['7'], '2 projects selected'],
  ])('%s: restricted summary, unchecked Select all, one Select all clears only that dimension', (_label, query, name, visible, summary) => {
    vi.useFakeTimers();
    const { page, windowObject, requests } = r9Setup();
    const other = name === 'project' ? 'type' : 'project';
    windowObject.location.href = `http://creatorcrate.test/releases?${query}&schedule=upcoming&pageSize=10`;
    windowObject.dispatch('popstate');
    expect(page[name].current.textContent).toBe(summary);
    expect(page[name].selectAll.checked).toBe(false);
    expect(page[name].inputs.filter((input) => input.checked).map((input) => input.value)).toEqual(visible);
    expect(page[other].current.textContent).toBe(other === 'project' ? 'All projects' : 'All types');

    // R9: an unrelated Search keeps every requested value, never comma-joined, no duplicates.
    r9Type(page, 'Needle');
    vi.advanceTimersByTime(1000);
    const requested = new URLSearchParams(query).getAll(name);
    expect(requests[1].url.searchParams.getAll(name).slice().sort()).toEqual(requested.slice().sort());
    expect(requests[1].url.search).not.toContain('%2C');
    expect(page[name].current.textContent).toBe(summary);

    expect(r9UserToggle(page, page[name].selectAll)).toBe(true);
    expect(page[name].selectAll.checked).toBe(true);
    expect(page[name].inputs.some((input) => input.checked)).toBe(false);
    expect(r9Carriers(page, name)).toEqual([]);
    expect(page[name].current.textContent).toBe(name === 'project' ? 'All projects' : 'All types');
    expect(requests).toHaveLength(3);
    expectOnlyReleasesParams(requests[2].url.href, [['pageSize', '10'], ['schedule', 'upcoming'], ['search', 'Needle']]);
    expectGetOnly(windowObject);
  });

  it('H. valid repeated Projects (all rendered): restricted summary; Select all clears both', () => {
    vi.useFakeTimers();
    const { page, windowObject, requests } = r9Setup();
    windowObject.location.href = 'http://creatorcrate.test/releases?project=7&project=12&pageSize=10';
    windowObject.dispatch('popstate');
    expect(r9Carriers(page, 'project')).toEqual([]);
    expect(page.project.current.textContent).toBe('2 projects selected');
    expect(r9UserToggle(page, page.project.selectAll)).toBe(true);
    expectOnlyReleasesParams(requests[1].url.href, [['pageSize', '10']]);
  });

  it('hidden Project -> a Type edit keeps the carrier and its restricted summary (R9 serializer)', () => {
    vi.useFakeTimers();
    const { page, windowObject, requests } = r9Setup();
    windowObject.location.href = R9_UNKNOWN_URL;
    windowObject.dispatch('popstate');
    r9UserToggle(page, page.type.option('images'));
    expectOnlyReleasesParams(requests[1].url.href, [['pageSize', '10'], ['project', '999999'], ['type', 'images']]);
    expect(r9Carriers(page, 'project')).toEqual(['999999']);
    expect(page.project.current.textContent).toBe('1 project selected');
    expect(page.project.selectAll.checked).toBe(false);
    expect(page.type.current.textContent).toBe('1 type selected');
    // Clearing Project afterwards keeps the Type.
    r9UserToggle(page, page.project.selectAll);
    expectOnlyReleasesParams(requests[2].url.href, [['pageSize', '10'], ['type', 'images']]);
  });

  it('hidden Project -> a Sort edit keeps the restriction', () => {
    vi.useFakeTimers();
    const { page, windowObject, requests } = r9Setup();
    const title = makeNode({ tagName: 'input', attrs: { name: 'sort', type: 'radio', value: 'title' }, value: 'title' });
    page.sortDropdown.appendChild(title);
    windowObject.location.href = R9_UNKNOWN_URL;
    windowObject.dispatch('popstate');
    r9UserToggle(page, title);
    expect(requests).toHaveLength(2);
    expect(requests[1].url.searchParams.getAll('project')).toEqual(['999999']);
    expect(requests[1].url.searchParams.get('sort')).toBe('title');
    expect(page.project.current.textContent).toBe('1 project selected');
  });

  it('hidden Project -> another Project replaces it (one rendered value, no carrier)', () => {
    vi.useFakeTimers();
    const { page, windowObject, requests } = r9Setup();
    windowObject.location.href = R9_UNKNOWN_URL;
    windowObject.dispatch('popstate');
    r9UserToggle(page, page.project.option('12'));
    expect(r9Carriers(page, 'project')).toEqual([]);
    expect(page.project.current.textContent).toBe('1 project selected');
    expect(page.project.option('12').checked).toBe(true);
    expectOnlyReleasesParams(requests[1].url.href, [['pageSize', '10'], ['project', '12']]);
  });

  it('Select all superseded by a new Project: three overlapping actions, oldest responses last', async () => {
    vi.useFakeTimers();
    const chosen = makeR9Page({ selectedProjects: ['7'], marker: 'ids:7|count:1' });
    const unrestricted = makeR9Page({ marker: 'ids:1,2,3|count:3' });
    const back = makeR9Page({ unavailableProjects: ['999999'], marker: 'ids:|count:0' });
    const { page, windowObject, requests } = r9Setup({
      pages: new Map([['chosen', chosen.document], ['unrestricted', unrestricted.document], ['back', back.document]]),
    });
    windowObject.location.href = R9_UNKNOWN_URL;
    windowObject.dispatch('popstate');
    r9UserToggle(page, page.project.selectAll);
    r9UserToggle(page, page.project.option('7'));
    expect(requests).toHaveLength(3);
    expectOnlyReleasesParams(requests[2].url.href, [['pageSize', '10'], ['project', '7']]);
    expect(page.project.current.textContent).toBe('1 project selected');
    expect(page.project.selectAll.checked).toBe(false);
    requests[2].resolve(responseFor('chosen', requests[2].url.href));
    await flush();
    requests[1].resolve(responseFor('unrestricted', requests[1].url.href));
    requests[0].resolve(responseFor('back', requests[0].url.href));
    await flush();
    expect(results(page)).toBe('ids:7|count:1');
    expectOnlyReleasesParams(windowObject.location.href, [['pageSize', '10'], ['project', '7']]);
    expect(current(page, 'project')).toMatchObject({ selectAll: false, checked: ['7'] });
    expect(allCarriers(page)).toBe(0);
  });

  it('Reset filters during the held Back, then a Project edit supersedes the Reset', () => {
    vi.useFakeTimers();
    const { page, windowObject, requests } = r9Setup();
    windowObject.location.href = R9_UNKNOWN_URL;
    windowObject.dispatch('popstate');
    page.reset.dispatch('click');
    expect(page.project.current.textContent).toBe('All projects');
    expect(page.project.selectAll.checked).toBe(true);
    r9UserToggle(page, page.project.option('7'));
    expect(requests).toHaveLength(3);
    expect(requests[1].init.signal.aborted).toBe(true);
    expectOnlyReleasesParams(requests[2].url.href, [['pageSize', '10'], ['project', '7']]);
  });

  /*
   * P3 correction 1: a marked carrier that is disabled is not submitted by
   * FormData, so the dropdown must not count it either (All, Select all
   * checked); an enabled carrier still counts and one Select all clears it.
   */
  describe('P3: disabled carriers are not active selections', () => {
    const projectCarrierInputs = (page) => page.form
      .querySelectorAll('input[data-releases-intended-carrier][name="project"]');
    const submittedProjects = (windowObject, page) => Array.from(new windowObject.FormData(page.form).entries())
      .filter(([name, value]) => name === 'project' && value !== '').map(([, value]) => value);

    it('disabled-only carrier: All, Select all checked and a no-op; Search sends no Project', () => {
      vi.useFakeTimers();
      const { page, windowObject, requests } = r9Setup();
      windowObject.location.href = R9_UNKNOWN_URL;
      windowObject.dispatch('popstate');
      expect(page.project.current.textContent).toBe('1 project selected');
      projectCarrierInputs(page).forEach((input) => { input.disabled = true; });
      enhanceDropdowns(page.document);
      expect(submittedProjects(windowObject, page)).toEqual([]);
      expect(page.project.current.textContent).toBe('All projects');
      expect(page.project.selectAll.checked).toBe(true);
      expect(r9UserToggle(page, page.project.selectAll)).toBe(false);
      expect(requests).toHaveLength(1);
      // Still disabled (never re-enabled), still present.
      expect(projectCarrierInputs(page).map((input) => [input.value, input.disabled])).toEqual([['999999', true]]);
      r9Type(page, 'Needle');
      vi.advanceTimersByTime(1000);
      expect(requests).toHaveLength(2);
      expectOnlyReleasesParams(requests[1].url.href, [['pageSize', '10'], ['search', 'Needle']]);
      expectGetOnly(windowObject);
    });

    it('enabled-only carrier: restricted; the intended Project is sent; one Select all clears it', () => {
      vi.useFakeTimers();
      const { page, windowObject, requests } = r9Setup();
      windowObject.location.href = R9_UNKNOWN_URL;
      windowObject.dispatch('popstate');
      enhanceDropdowns(page.document);
      expect(submittedProjects(windowObject, page)).toEqual(['999999']);
      expect(page.project.current.textContent).toBe('1 project selected');
      expect(page.project.selectAll.checked).toBe(false);
      expect(r9UserToggle(page, page.project.selectAll)).toBe(true);
      expect(requests).toHaveLength(2);
      expectOnlyReleasesParams(requests[1].url.href, [['pageSize', '10']]);
      expect(page.project.current.textContent).toBe('All projects');
      expectGetOnly(windowObject);
    });

    it('mixed carriers: only enabled values count; Select all clears them and leaves the disabled one', () => {
      vi.useFakeTimers();
      const { page, windowObject, requests } = r9Setup();
      windowObject.location.href = 'http://creatorcrate.test/releases?project=999999&project=888888&project=777777&pageSize=10';
      windowObject.dispatch('popstate');
      expect(page.project.current.textContent).toBe('3 projects selected');
      projectCarrierInputs(page).find((input) => input.value === '888888').disabled = true;
      enhanceDropdowns(page.document);
      expect(submittedProjects(windowObject, page)).toEqual(['999999', '777777']);
      expect(page.project.current.textContent).toBe('2 projects selected');
      expect(page.project.selectAll.checked).toBe(false);
      r9Type(page, 'Needle');
      vi.advanceTimersByTime(1000);
      expectOnlyReleasesParams(requests[1].url.href,
        [['pageSize', '10'], ['project', '999999'], ['project', '777777'], ['search', 'Needle']]);
      expect(r9UserToggle(page, page.project.selectAll)).toBe(true);
      expect(requests).toHaveLength(3);
      expectOnlyReleasesParams(requests[2].url.href, [['pageSize', '10'], ['search', 'Needle']]);
      // The owner's R9 sync may retire the disabled carrier; none is ever re-enabled.
      expect(projectCarrierInputs(page).filter((input) => !input.disabled)).toEqual([]);
      expect(submittedProjects(windowObject, page)).toEqual([]);
      expect(page.project.current.textContent).toBe('All projects');
      expect(page.project.selectAll.checked).toBe(true);
      expectGetOnly(windowObject);
    });
  });

  it('starting navigation dispatches no change event and no GET beyond the navigation itself', () => {
    vi.useFakeTimers();
    const { page, windowObject, requests } = r9Setup();
    const changes = [];
    page.form.addEventListener('change', (event) => changes.push(event));
    windowObject.location.href = R9_UNKNOWN_URL;
    windowObject.dispatch('popstate');
    vi.advanceTimersByTime(1000);
    expect(changes).toHaveLength(0);
    expect(requests).toHaveLength(1);
  });
});

/*
 * P3-C1 follow-up: a hidden carrier belongs to its HTML form owner. A carrier
 * outside the Releases filter form that names it with form="" is submitted
 * by that form, so the dropdown counts it and editing the dimension removes
 * it; a carrier physically inside the filter form but owned by another form
 * is never counted and never removed by Releases edits. GET URLs come from
 * the (ownership-aware) FormData mock, i.e. the R9 serializer's own input.
 */
describe('P3-C1 follow-up: Releases carriers follow their HTML form owner', () => {
  beforeEach(() => { vi.useRealTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const MARKS = { 'data-releases-intended-carrier': '', 'data-cc-dropdown-carried-value': '' };

  function ownershipPage(options = {}) {
    const page = makeR9Page(options);
    page.form.setAttribute('id', 'list-releases-filter');
    page.document.getElementById = (id) => page.document.querySelector(`#${id}`);
    const otherForm = makeNode({ tagName: 'form', attrs: { id: 'releases-other-form', action: '/elsewhere', method: 'get' } });
    page.document.appendChild(otherForm);
    const outside = makeNode({ attrs: { 'data-outside-filter-form': '' } });
    page.document.appendChild(outside);
    return { ...page, otherForm, outside };
  }

  function addCarrier(parent, name, value, { form = null, disabled = false } = {}) {
    const carrier = makeNode({ tagName: 'input', attrs: { type: 'hidden', name, value, ...MARKS }, value });
    if (form) carrier.setAttribute('form', form);
    carrier.disabled = disabled;
    parent.appendChild(carrier);
    return carrier;
  }

  const external = (page, name, value, extra = {}) => addCarrier(page.outside, name, value, { form: 'list-releases-filter', ...extra });
  const foreignInside = (page, name, value) => addCarrier(page.form, name, value, { form: 'releases-other-form' });
  const carriersIn = (page, name) => page.document.querySelectorAll(`input[data-cc-dropdown-carried-value][name="${name}"]`)
    .map((input) => input.value);
  const submitted = (windowObject, form, name) => Array.from(new windowObject.FormData(form).entries())
    .filter(([key, value]) => key === name && value !== '').map(([, value]) => value);
  const results = (page) => r9Region(page).querySelector('[data-r9-results]').getAttribute('data-r9-results');
  // Before any navigation the form still sends its rendered Sort / Order; only
  // the filter dimensions under test are compared.
  const filters = (url) => {
    const params = new URL(url).searchParams;
    return {
      project: params.getAll('project').slice().sort(),
      type: params.getAll('type').slice().sort(),
      search: params.get('search'),
      pageSize: params.get('pageSize'),
    };
  };

  function setup(build, pageOptions) {
    const page = ownershipPage(pageOptions);
    const placed = build(page);
    const ready = r9Setup({ page, pages: placed?.pages || new Map() });
    return { ...ready, placed };
  }

  it('external owned Project carrier: FormData includes it, the dropdown is restricted, one Select all clears it', () => {
    vi.useFakeTimers();
    const { page, windowObject, requests } = setup((built) => { external(built, 'project', '999999'); });
    expect(submitted(windowObject, page.form, 'project')).toEqual(['999999']);
    expect(page.project.current.textContent).toBe('1 project selected');
    expect(page.project.summary.getAttribute('aria-label')).toBe('Projects: 1 project selected');
    expect(page.project.selectAll.checked).toBe(false);

    // R9: an unrelated Search keeps the restriction.
    r9Type(page, 'Needle');
    vi.advanceTimersByTime(1000);
    expect(requests).toHaveLength(1);
    expect(filters(requests[0].url.href)).toEqual({ project: ['999999'], type: [], search: 'Needle', pageSize: '10' });
    expect(page.project.current.textContent).toBe('1 project selected');

    expect(r9UserToggle(page, page.project.selectAll)).toBe(true);
    expect(carriersIn(page, 'project')).toEqual([]);
    expect(page.project.selectAll.checked).toBe(true);
    expect(page.project.current.textContent).toBe('All projects');
    expect(requests).toHaveLength(2);
    expect(filters(requests[1].url.href)).toEqual({ project: [], type: [], search: 'Needle', pageSize: '10' });
    vi.advanceTimersByTime(1000);
    expect(requests).toHaveLength(2);
    expectGetOnly(windowObject);
  });

  it('foreign-owned carrier inside the filter form: not counted, not submitted here, kept by a Project edit', () => {
    vi.useFakeTimers();
    const { page, windowObject, requests, placed } = setup((built) => ({ foreign: foreignInside(built, 'project', '555555') }));
    expect(submitted(windowObject, page.form, 'project')).toEqual([]);
    expect(submitted(windowObject, page.otherForm, 'project')).toEqual(['555555']);
    expect(page.project.current.textContent).toBe('All projects');
    expect(page.project.selectAll.checked).toBe(true);
    // Genuinely unrestricted: the checked Select all is a no-op (no GET).
    expect(r9UserToggle(page, page.project.selectAll)).toBe(false);
    expect(requests).toHaveLength(0);

    expect(r9UserToggle(page, page.project.option('7'))).toBe(true);
    expect(requests).toHaveLength(1);
    expect(filters(requests[0].url.href)).toEqual({ project: ['7'], type: [], search: null, pageSize: '10' });
    expect(placed.foreign.parentNode).toBe(page.form);
    expect(carriersIn(page, 'project')).toEqual(['555555']);
    expect(submitted(windowObject, page.otherForm, 'project')).toEqual(['555555']);
    expect(page.project.current.textContent).not.toBe('All projects');

    // Select all clears the visible choice and still leaves the foreign carrier.
    expect(r9UserToggle(page, page.project.selectAll)).toBe(true);
    expect(filters(requests[1].url.href)).toEqual({ project: [], type: [], search: null, pageSize: '10' });
    expect(carriersIn(page, 'project')).toEqual(['555555']);
    expectGetOnly(windowObject);
  });

  it('visible + external + foreign Projects with a hidden Type: counts, repeats, per-dimension clearing', () => {
    vi.useFakeTimers();
    const { page, windowObject, requests, placed } = setup((built) => {
      external(built, 'project', '999999');
      external(built, 'project', '999999');
      external(built, 'project', '7');
      external(built, 'project', '888888', { disabled: true });
      const typeCarrier = external(built, 'type', 'audio');
      return { foreign: foreignInside(built, 'project', '555555'), typeCarrier };
    }, { selectedProjects: ['7'] });
    // Visible 7 + external 999999 (duplicates once; 7 already counted; disabled ignored).
    expect(page.project.current.textContent).toBe('2 projects selected');
    expect(page.project.selectAll.checked).toBe(false);
    expect(page.type.current.textContent).toBe('1 type selected');
    expect(page.type.selectAll.checked).toBe(false);
    expect(new Set(submitted(windowObject, page.form, 'project'))).toEqual(new Set(['7', '999999']));

    r9Type(page, 'Needle');
    vi.advanceTimersByTime(1000);
    const sent = requests[0].url.searchParams;
    expect(sent.getAll('project').slice().sort()).toEqual(['7', '7', '999999', '999999']);
    expect(sent.getAll('type')).toEqual(['audio']);
    expect(requests[0].url.search).not.toContain('%2C');

    // Select all clears Projects only: the form-owned Project carriers go (the
    // owner's sync also retires the disabled one, never re-enabling it), while the
    // foreign and Type carriers stay; Type stays restricted.
    expect(r9UserToggle(page, page.project.selectAll)).toBe(true);
    expect(carriersIn(page, 'project')).toEqual(['555555']);
    expect(placed.foreign.parentNode).toBe(page.form);
    expect(carriersIn(page, 'type')).toEqual(['audio']);
    expect(page.project.current.textContent).toBe('All projects');
    expect(page.type.current.textContent).toBe('1 type selected');
    expect(filters(requests[1].url.href)).toEqual({ project: [], type: ['audio'], search: 'Needle', pageSize: '10' });

    // Then Select all on Types clears only Types.
    expect(r9UserToggle(page, page.type.selectAll)).toBe(true);
    expect(carriersIn(page, 'type')).toEqual([]);
    expect(page.type.current.textContent).toBe('All types');
    expect(filters(requests[2].url.href)).toEqual({ project: [], type: [], search: 'Needle', pageSize: '10' });
    expect(requests).toHaveLength(3);
    expectGetOnly(windowObject);
  });

  it('held Back + external carrier: Search keeps both; failed GET and Retry keep them; Select all clears both', async () => {
    vi.useFakeTimers();
    const unrestricted = makeR9Page({ marker: 'ids:1,2,3|count:3' });
    const stale = makeR9Page({ unavailableProjects: ['999999'], marker: 'ids:|count:0' });
    const { page, windowObject, requests, placed } = setup((built) => ({
      pages: new Map([['unrestricted', unrestricted.document], ['stale', stale.document]]),
      foreign: foreignInside(built, 'project', '555555'),
      ext: external(built, 'project', '444444'),
    }));
    expect(page.project.current.textContent).toBe('1 project selected');
    windowObject.location.href = R9_UNKNOWN_URL;
    windowObject.dispatch('popstate');
    expect(requests).toHaveLength(1);
    // The Back intent replaced the owned carriers of its dimension (form-owned,
    // external included); the foreign carrier is untouched.
    expect(carriersIn(page, 'project').slice().sort()).toEqual(['555555', '999999']);
    expect(placed.foreign.parentNode).toBe(page.form);
    expect(page.project.current.textContent).toBe('1 project selected');

    external(page, 'project', '444444');
    enhanceDropdowns(page.document);
    expect(page.project.current.textContent).toBe('2 projects selected');
    r9Type(page, 'Needle');
    vi.advanceTimersByTime(1000);
    expect(requests).toHaveLength(2);
    expect(requests[0].init.signal.aborted).toBe(true);
    expect(requests[1].url.searchParams.getAll('project').slice().sort()).toEqual(['444444', '999999']);

    requests[1].reject(new Error('offline'));
    await flush();
    expect(liveFailureRetries(page.document)).toHaveLength(1);
    expect(page.project.current.textContent).toBe('2 projects selected');
    liveFailureRetries(page.document)[0].dispatch('click');
    expect(requests).toHaveLength(3);
    expect(requests[2].url.searchParams.getAll('project').slice().sort()).toEqual(['444444', '999999']);
    expect(page.project.selectAll.checked).toBe(false);

    expect(r9UserToggle(page, page.project.selectAll)).toBe(true);
    expect(requests).toHaveLength(4);
    expect(requests[2].init.signal.aborted).toBe(true);
    expectOnlyReleasesParams(requests[3].url.href, [['pageSize', '10'], ['search', 'Needle']]);
    expect(carriersIn(page, 'project')).toEqual(['555555']);
    expect(placed.foreign.parentNode).toBe(page.form);

    requests[3].resolve(responseFor('unrestricted', requests[3].url.href));
    await flush();
    requests[2].resolve(responseFor('stale', requests[2].url.href));
    await flush();
    expect(results(page)).toBe('ids:1,2,3|count:3');
    expect(page.document.querySelector('#release-project-filter')
      .querySelector('input[data-cc-dropdown-select-all]').checked).toBe(true);
    // The installed response replaces the whole filter form subtree (engine
    // behaviour, unchanged here); the obsolete held response reinstalled nothing.
    expect(carriersIn(page, 'project')).toEqual([]);
    expectGetOnly(windowObject);
  });

  it('Reset filters clears owned external carriers and leaves the foreign one', () => {
    vi.useFakeTimers();
    const { page, windowObject, requests, placed } = setup((built) => ({
      foreign: foreignInside(built, 'project', '555555'),
      ext: external(built, 'type', 'audio'),
    }));
    windowObject.location.href = 'http://creatorcrate.test/releases?project=999999&pageSize=10';
    windowObject.dispatch('popstate');
    page.reset.dispatch('click');
    expect(requests).toHaveLength(2);
    expect(requests[0].init.signal.aborted).toBe(true);
    expectOnlyReleasesParams(requests[1].url.href, [['pageSize', '10']]);
    expect(carriersIn(page, 'project')).toEqual(['555555']);
    expect(carriersIn(page, 'type')).toEqual([]);
    expect(placed.foreign.parentNode).toBe(page.form);
    expect(page.project.selectAll.checked).toBe(true);
    expect(page.type.selectAll.checked).toBe(true);
    r9Type(page, 'Needle');
    vi.advanceTimersByTime(1000);
    expectOnlyReleasesParams(requests[2].url.href, [['pageSize', '10'], ['search', 'Needle']]);
    expectGetOnly(windowObject);
  });
});

/*
 * P3 correction 2: an unsupported Schedule value restored by history (or
 * failed / retried) is served unrestricted by the server (the release list
 * normalization accepts exactly overdue, today, upcoming and unscheduled).
 * While that destination is intended, the pending Schedule control must show
 * the effective All (All radio checked, All summary, no stale label) and no
 * carrier may re-send the raw value with a later filter GET. A supported
 * value is still mirrored as is.
 *
 * The Schedule control here is the real single-select shape (All + four
 * labelled radios) reconciled by the REAL dropdown module.
 */
const P3S_SCHEDULES = [
  ['overdue', 'Overdue'], ['today', 'Today'], ['upcoming', 'Upcoming'], ['unscheduled', 'Unscheduled'],
];
const P3S_OVERDUE_URL = 'http://creatorcrate.test/releases?schedule=overdue&pageSize=10';
const P3S_INVALID_URL = 'http://creatorcrate.test/releases?schedule=invalid-schedule&pageSize=10';

function makeP3ScheduleDropdown(form, selected) {
  const dropdown = makeNode({
    tagName: 'details',
    attrs: { id: 'list-schedule', 'data-cc-dropdown': '', 'data-cc-dropdown-mode': 'single' },
  });
  const summary = makeNode({ tagName: 'summary', attrs: { 'aria-label': 'Schedule filter: ' } });
  const current = makeNode({ tagName: 'span', attrs: { 'data-cc-dropdown-summary-current': '' } });
  summary.appendChild(current);
  dropdown.appendChild(summary);
  const radios = [['', 'All'], ...P3S_SCHEDULES].map(([value, text]) => {
    const label = makeNode({ tagName: 'label' });
    label.textContent = text;
    const input = makeNode({
      tagName: 'input', attrs: { name: 'schedule', type: 'radio', value }, value, checked: value === selected,
    });
    label.appendChild(input);
    dropdown.appendChild(label);
    return input;
  });
  current.textContent = P3S_SCHEDULES.find(([value]) => value === selected)?.[1] || 'All';
  form.appendChild(dropdown);
  return { dropdown, summary, current, radios, option: (value) => radios.find((input) => input.value === value) };
}

function makeP3SPage({ schedule = 'overdue', marker = 'installed', ...options } = {}) {
  const page = makeR9Page({ marker, ...options });
  page.scheduleDropdown.remove();
  const scheduleControl = makeP3ScheduleDropdown(page.form, schedule);
  return { ...page, scheduleControl };
}

function p3sSetup({ page = makeP3SPage(), pages = new Map(), href = P3S_OVERDUE_URL } = {}) {
  return r9Setup({ page, pages, href });
}

// The live engine may swap in an installed form: read the current Schedule.
function p3sSchedule(page) {
  const dropdown = page.document.querySelector('#list-schedule');
  const radios = dropdown.querySelectorAll('input[type="radio"]');
  return {
    summary: dropdown.querySelector('[data-cc-dropdown-summary-current]').textContent,
    aria: dropdown.querySelector('summary').getAttribute('aria-label'),
    checked: radios.filter((input) => input.checked).map((input) => input.value),
    carriers: r9Carriers(page, 'schedule'),
  };
}

function p3sSubmittedSchedule(windowObject, page) {
  return Array.from(new windowObject.FormData(page.form).entries())
    .filter(([name]) => name === 'schedule').map(([, value]) => value);
}

// A user click on a Schedule radio: the browser checks it and unchecks its group.
function p3sPick(page, value) {
  const radios = page.form.querySelectorAll('input[name="schedule"]').filter((input) => input.type === 'radio');
  radios.forEach((input) => { input.checked = false; });
  return r9UserToggle(page, radios.find((input) => input.value === value));
}

const P3S_ALL = { summary: 'All', aria: 'Schedule filter: All', checked: [''], carriers: [] };
const p3sResults = (page) => r9Region(page).querySelector('[data-r9-results]').getAttribute('data-r9-results');

describe('P3 Releases unsupported Schedule shows the effective All and is never re-sent', () => {
  beforeEach(() => { vi.useRealTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('reviewer sequence: Overdue installed -> Back held to invalid -> All shown -> Search omits Schedule; the late Back never installs', async () => {
    vi.useFakeTimers();
    const page = makeP3SPage();
    const searched = makeP3SPage({ schedule: '', search: 'Needle', marker: 'ids:3,4|count:2' });
    const back = makeP3SPage({ schedule: '', marker: 'ids:1,2,3,4|count:4' });
    const { windowObject, requests } = p3sSetup({
      page, pages: new Map([['searched', searched.document], ['back', back.document]]),
    });
    const changes = [];
    page.form.addEventListener('change', (event) => changes.push(event));
    expect(p3sSchedule(page)).toMatchObject({ summary: 'Overdue', checked: ['overdue'] });

    windowObject.location.href = P3S_INVALID_URL;
    windowObject.dispatch('popstate');
    expect(requests).toHaveLength(1);
    // The history GET keeps its own raw URL (history owns it).
    expect(requests[0].url.href).toBe(P3S_INVALID_URL);
    // Immediately, before the Back GET installs:
    expect(p3sSchedule(page)).toEqual(P3S_ALL);
    expect(page.scheduleControl.option('overdue').checked).toBe(false);
    expect(page.scheduleControl.option('').checked).toBe(true);
    expect(p3sSubmittedSchedule(windowObject, page)).toEqual(['']);
    expect(releasesLiveSnapshot(page.document).intendedUrl).toBe(P3S_INVALID_URL);
    expect(page.searchInput.value).toBe('');
    expect(page.project.current.textContent).toBe('All projects');
    expect(page.type.current.textContent).toBe('All types');

    r9Type(page, 'Needle');
    vi.advanceTimersByTime(1000);
    expect(requests).toHaveLength(2);
    expect(requests[0].init.signal.aborted).toBe(true);
    expectOnlyReleasesParams(requests[1].url.href, [['pageSize', '10'], ['search', 'Needle']]);
    expect(p3sSchedule(page)).toEqual(P3S_ALL);

    requests[1].resolve(responseFor('searched', requests[1].url.href));
    await flush();
    requests[0].resolve(responseFor('back', requests[0].url.href));
    await flush();
    expect(r9Region(page)).toBe(searched.region);
    expect(p3sResults(page)).toBe('ids:3,4|count:2');
    expectOnlyReleasesParams(windowObject.location.href, [['pageSize', '10'], ['search', 'Needle']]);
    expect(p3sSchedule(page)).toMatchObject({ summary: 'All', checked: [''], carriers: [] });
    expect(windowObject.history.pushes).toHaveLength(1);
    expect(changes).toHaveLength(0);
    expectGetOnly(windowObject);
  });

  it.each([
    ['an unknown word', 'schedule=invalid-schedule'],
    ['a case variant', 'schedule=OVERDUE'],
    ['a padded value', 'schedule=overdue%20'],
    ['an empty value', 'schedule='],
    ['repeated supported values (served as an array, unrestricted)', 'schedule=overdue&schedule=today'],
    ['a dashboard group id, not a filter value', 'schedule=next7'],
  ])('Back held to %s: All, no carrier, Search omits Schedule', (_label, query) => {
    vi.useFakeTimers();
    const { page, windowObject, requests } = p3sSetup();
    windowObject.location.href = `http://creatorcrate.test/releases?${query}&pageSize=10`;
    windowObject.dispatch('popstate');
    expect(p3sSchedule(page)).toEqual(P3S_ALL);
    r9Type(page, 'Needle');
    vi.advanceTimersByTime(1000);
    expectOnlyReleasesParams(requests[1].url.href, [['pageSize', '10'], ['search', 'Needle']]);
    expectGetOnly(windowObject);
  });

  it.each(P3S_SCHEDULES)('Back held to the supported %s: its radio, summary and parameter are kept', (value, text) => {
    vi.useFakeTimers();
    const installed = value === 'overdue' ? 'today' : 'overdue';
    const { page, windowObject, requests } = p3sSetup({
      page: makeP3SPage({ schedule: installed }),
      href: `http://creatorcrate.test/releases?schedule=${installed}&pageSize=10`,
    });
    windowObject.location.href = `http://creatorcrate.test/releases?schedule=${value}&pageSize=10`;
    windowObject.dispatch('popstate');
    expect(p3sSchedule(page)).toEqual({ summary: text, aria: `Schedule filter: ${text}`, checked: [value], carriers: [] });
    r9Type(page, 'Needle');
    vi.advanceTimersByTime(1000);
    expectOnlyReleasesParams(requests[1].url.href, [['pageSize', '10'], ['schedule', value], ['search', 'Needle']]);
    expectGetOnly(windowObject);
  });

  it('Forward held to invalid: All; Search omits Schedule', () => {
    vi.useFakeTimers();
    const { page, windowObject, requests } = p3sSetup({ href: P3S_INVALID_URL, page: makeP3SPage({ schedule: '' }) });
    windowObject.location.href = P3S_OVERDUE_URL;
    windowObject.dispatch('popstate');
    expect(p3sSchedule(page)).toMatchObject({ summary: 'Overdue', checked: ['overdue'] });
    windowObject.location.href = P3S_INVALID_URL;
    windowObject.dispatch('popstate');
    expect(requests).toHaveLength(2);
    expect(requests[1].url.href).toBe(P3S_INVALID_URL);
    expect(p3sSchedule(page)).toEqual(P3S_ALL);
    r9Type(page, 'Needle');
    vi.advanceTimersByTime(1000);
    expectOnlyReleasesParams(requests[2].url.href, [['pageSize', '10'], ['search', 'Needle']]);
  });

  it('Forward held to a valid Schedule from invalid: that radio and summary', () => {
    vi.useFakeTimers();
    const { page, windowObject, requests } = p3sSetup({ href: P3S_INVALID_URL, page: makeP3SPage({ schedule: '' }) });
    windowObject.location.href = 'http://creatorcrate.test/releases?schedule=upcoming&pageSize=10';
    windowObject.dispatch('popstate');
    expect(p3sSchedule(page)).toEqual({
      summary: 'Upcoming', aria: 'Schedule filter: Upcoming', checked: ['upcoming'], carriers: [],
    });
    r9Type(page, 'Needle');
    vi.advanceTimersByTime(1000);
    expectOnlyReleasesParams(requests[1].url.href, [['pageSize', '10'], ['schedule', 'upcoming'], ['search', 'Needle']]);
  });

  it('failed Back -> All stays; GET-only Retry repeats the history URL; Retry pending -> Search omits', async () => {
    vi.useFakeTimers();
    const searched = makeP3SPage({ schedule: '', search: 'Needle', marker: 'ids:3,4|count:2' });
    const { page, windowObject, requests } = p3sSetup({ pages: new Map([['searched', searched.document]]) });
    windowObject.location.href = P3S_INVALID_URL;
    windowObject.dispatch('popstate');
    requests[0].reject(new Error('offline'));
    await flush();
    expect(liveFailureRetries(page.document)).toHaveLength(1);
    expect(p3sSchedule(page)).toEqual(P3S_ALL);

    liveFailureRetries(page.document)[0].dispatch('click');
    expect(requests).toHaveLength(2);
    expect(requests[1].url.href).toBe(P3S_INVALID_URL);
    expect(requests[1].init.method).toBe('GET');
    expect(p3sSchedule(page)).toEqual(P3S_ALL);

    r9Type(page, 'Needle');
    vi.advanceTimersByTime(1000);
    expect(requests).toHaveLength(3);
    expect(requests[1].init.signal.aborted).toBe(true);
    expectOnlyReleasesParams(requests[2].url.href, [['pageSize', '10'], ['search', 'Needle']]);
    requests[2].resolve(responseFor('searched', requests[2].url.href));
    await flush();
    expect(p3sResults(page)).toBe('ids:3,4|count:2');
    expectOnlyReleasesParams(windowObject.location.href, [['pageSize', '10'], ['search', 'Needle']]);
    expectGetOnly(windowObject);
  });

  it('failed Back -> Search directly omits the unsupported Schedule', async () => {
    vi.useFakeTimers();
    const { page, windowObject, requests } = p3sSetup();
    windowObject.location.href = P3S_INVALID_URL;
    windowObject.dispatch('popstate');
    requests[0].reject(new Error('offline'));
    await flush();
    r9Type(page, 'Needle');
    vi.advanceTimersByTime(1000);
    expectOnlyReleasesParams(requests[1].url.href, [['pageSize', '10'], ['search', 'Needle']]);
  });

  it('invalid held -> a valid explicit Schedule choice is sent; the old Back response arrives last and never installs', async () => {
    vi.useFakeTimers();
    const today = makeP3SPage({ schedule: 'today', marker: 'ids:2|count:1' });
    const back = makeP3SPage({ schedule: '', marker: 'ids:1,2,3,4|count:4' });
    const { page, windowObject, requests } = p3sSetup({
      pages: new Map([['today', today.document], ['back', back.document]]),
    });
    windowObject.location.href = P3S_INVALID_URL;
    windowObject.dispatch('popstate');
    expect(p3sPick(page, 'today')).toBe(true);
    expect(requests).toHaveLength(2);
    expectOnlyReleasesParams(requests[1].url.href, [['pageSize', '10'], ['schedule', 'today']]);
    expect(p3sSchedule(page)).toMatchObject({ summary: 'Today', checked: ['today'], carriers: [] });
    requests[1].resolve(responseFor('today', requests[1].url.href));
    await flush();
    requests[0].resolve(responseFor('back', requests[0].url.href));
    await flush();
    expect(p3sResults(page)).toBe('ids:2|count:1');
    expectOnlyReleasesParams(windowObject.location.href, [['pageSize', '10'], ['schedule', 'today']]);
    expect(p3sSchedule(page)).toMatchObject({ summary: 'Today', checked: ['today'] });
    expectGetOnly(windowObject);
  });

  it('valid -> valid: choosing Upcoming over the installed Overdue', () => {
    vi.useFakeTimers();
    const { page, requests } = p3sSetup();
    expect(p3sPick(page, 'upcoming')).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0].url.searchParams.getAll('schedule')).toEqual(['upcoming']);
    expect(p3sSchedule(page)).toMatchObject({ summary: 'Upcoming', checked: ['upcoming'] });
  });

  it('invalid held -> choosing All explicitly sends no Schedule', () => {
    vi.useFakeTimers();
    const { page, windowObject, requests } = p3sSetup();
    windowObject.location.href = P3S_INVALID_URL;
    windowObject.dispatch('popstate');
    expect(p3sPick(page, '')).toBe(true);
    expect(requests).toHaveLength(2);
    expectOnlyReleasesParams(requests[1].url.href, [['pageSize', '10']]);
  });

  it('hidden Project + invalid Schedule: the Project restriction travels, Schedule never does (Search, Type, Select all)', () => {
    vi.useFakeTimers();
    const { page, windowObject, requests } = p3sSetup();
    windowObject.location.href = 'http://creatorcrate.test/releases?project=999999&schedule=bogus&pageSize=10';
    windowObject.dispatch('popstate');
    expect(p3sSchedule(page)).toEqual(P3S_ALL);
    expect(r9Carriers(page, 'project')).toEqual(['999999']);
    expect(page.project.current.textContent).toBe('1 project selected');

    r9Type(page, 'Needle');
    vi.advanceTimersByTime(1000);
    expectOnlyReleasesParams(requests[1].url.href, [['pageSize', '10'], ['project', '999999'], ['search', 'Needle']]);
    r9UserToggle(page, page.type.option('images'));
    expectOnlyReleasesParams(requests[2].url.href,
      [['pageSize', '10'], ['project', '999999'], ['search', 'Needle'], ['type', 'images']]);
    r9UserToggle(page, page.project.selectAll);
    expectOnlyReleasesParams(requests[3].url.href, [['pageSize', '10'], ['search', 'Needle'], ['type', 'images']]);
    expect(p3sSchedule(page)).toEqual(P3S_ALL);
    expectGetOnly(windowObject);
  });

  it('hidden Type + mixed visible/hidden Projects + invalid Schedule: restrictions kept, no Schedule', () => {
    vi.useFakeTimers();
    const { page, windowObject, requests } = p3sSetup();
    windowObject.location.href = 'http://creatorcrate.test/releases?project=7&project=999999&type=audio&schedule=nope&pageSize=10';
    windowObject.dispatch('popstate');
    expect(p3sSchedule(page)).toEqual(P3S_ALL);
    expect(page.project.current.textContent).toBe('2 projects selected');
    expect(page.type.current.textContent).toBe('1 type selected');
    r9Type(page, 'Needle');
    vi.advanceTimersByTime(1000);
    expectOnlyReleasesParams(requests[1].url.href, [
      ['pageSize', '10'], ['project', '7'], ['project', '999999'], ['search', 'Needle'], ['type', 'audio'],
    ]);
    // R9/R10 unchanged: editing Projects retires that dimension's carrier; the
    // hidden Type still travels; Schedule never does.
    r9UserToggle(page, page.project.option('12'));
    expectOnlyReleasesParams(requests[2].url.href, [
      ['pageSize', '10'], ['project', '7'], ['project', '12'], ['search', 'Needle'], ['type', 'audio'],
    ]);
  });

  it('Reset filters during the held invalid Back: All, GET only, no Schedule', () => {
    vi.useFakeTimers();
    const { page, windowObject, requests } = p3sSetup();
    windowObject.location.href = P3S_INVALID_URL;
    windowObject.dispatch('popstate');
    page.reset.dispatch('click');
    expect(requests).toHaveLength(2);
    expect(requests[0].init.signal.aborted).toBe(true);
    expectOnlyReleasesParams(requests[1].url.href, [['pageSize', '10']]);
    expect(p3sSchedule(page)).toEqual(P3S_ALL);
    r9Type(page, 'Needle');
    vi.advanceTimersByTime(1000);
    expectOnlyReleasesParams(requests[2].url.href, [['pageSize', '10'], ['search', 'Needle']]);
    expectGetOnly(windowObject);
  });

  it('a supported value without a rendered option still travels (carrier kept for supported values only)', () => {
    vi.useFakeTimers();
    const { page, windowObject, requests } = p3sSetup();
    page.scheduleControl.option('unscheduled').closest('label').remove();
    windowObject.location.href = 'http://creatorcrate.test/releases?schedule=unscheduled&pageSize=10';
    windowObject.dispatch('popstate');
    expect(r9Carriers(page, 'schedule')).toEqual(['unscheduled']);
    r9Type(page, 'Needle');
    vi.advanceTimersByTime(1000);
    expectOnlyReleasesParams(requests[1].url.href, [['pageSize', '10'], ['schedule', 'unscheduled'], ['search', 'Needle']]);
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

/*
 * P3 correction 5: the native Reset filters form (dialog footer, outside the
 * live region) follows the most recently INSTALLED Releases page size. A held,
 * superseded, stale or failed GET never updates it; a successful install
 * (filter edit, Reset, Back/Forward, GET-only Retry) does. Once live
 * enhancement is unavailable, the native GET submits exactly that size.
 */
function p5Href(pageSize) {
  return pageSize === '25'
    ? P3B_INSTALLED.replace('&pageSize=10', '')
    : P3B_INSTALLED.replace('pageSize=10', `pageSize=${pageSize}`);
}

// As the template renders it: one hidden pageSize before the submit control,
// none for the default 25.
function withNativeResetSize(page, pageSize) {
  if (String(pageSize) !== '25') {
    page.resetForm.insertBefore(makeNode({
      tagName: 'input',
      attrs: { type: 'hidden', name: 'pageSize' },
      value: String(pageSize),
    }), page.reset);
  }
  return page;
}

function p5Response(pageSize) {
  return withNativeResetSize(makeP3BResetResponse(pageSize), pageSize);
}

function nativeResetFields(page) {
  return page.resetForm.querySelectorAll('input[name="pageSize"]')
    .map((input) => [input.type, input.value, input.disabled]);
}

function nativeResetSubmission(windowObject, page) {
  return Array.from(new windowObject.FormData(page.resetForm).entries());
}

function expectNativeResetSize(windowObject, page, pageSize) {
  if (pageSize === '25') {
    expect(nativeResetFields(page)).toEqual([]);
    expect(nativeResetSubmission(windowObject, page)).toEqual([]);
  } else {
    expect(nativeResetFields(page)).toEqual([['hidden', pageSize, false]]);
    expect(nativeResetSubmission(windowObject, page)).toEqual([['pageSize', pageSize]]);
  }
  // The submit control stays last and the form keeps its GET action.
  expect(page.resetForm.children.at(-1)).toBe(page.reset);
  expect(page.resetForm.getAttribute('method')).toBe('get');
}

function p5Setup({ pageSize = '50', pages = new Map() } = {}) {
  const initial = withNativeResetSize(makeP3BPage({ pageSize }), pageSize);
  const windowObject = makeWindow(initial.document, pages);
  windowObject.location.href = p5Href(pageSize);
  const requests = heldRequests(windowObject);
  enhanceReleasesLiveFiltering(initial.document);
  return { initial, windowObject, requests };
}

function p5HistoryTo(windowObject, href) {
  windowObject.location.href = href;
  windowObject.location.pathname = new URL(href).pathname;
  windowObject.dispatch('popstate');
}

describe('P3 correction 5: the native Releases Reset form follows the installed page size', () => {
  beforeEach(() => { vi.useRealTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('reviewer reproduction: 50 -> installed 10; a stale 50 and a later failure leave 10; native Reset submits 10', async () => {
    const ten = p5Response('10');
    const staleFifty = p5Response('50');
    const { initial, windowObject, requests } = p5Setup({
      pageSize: '50', pages: new Map([['ten', ten.document], ['stale-fifty', staleFifty.document]]),
    });
    const resetForm = initial.resetForm;
    expectNativeResetSize(windowObject, initial, '50');

    // Held size-10 GET: started, not installed. The filter form carries the
    // intent (R7); the native form still describes the installed 50.
    navigateReleasesLive(initial.document, '/releases?pageSize=10');
    expect(requests).toHaveLength(1);
    expect(initial.form.querySelectorAll('input[name="pageSize"]')
      .filter((input) => !input.disabled).map((input) => input.value)).toEqual(['10']);
    expectNativeResetSize(windowObject, initial, '50');

    requests[0].resolve(responseFor('ten', requests[0].url.href));
    await flush();
    expect(initial.document.querySelector('[data-releases-live-region]')).toBe(ten.region);
    expect(windowObject.location.href).toBe('http://creatorcrate.test/releases?pageSize=10');
    // The same form element, now carrying the installed 10.
    expect(initial.document.querySelector('form.releases-filter-reset')).toBe(resetForm);
    expectNativeResetSize(windowObject, initial, '10');

    // An older size-50 GET is superseded by a newer one; its response arrives
    // last and the newer one fails: neither touches the native form.
    navigateReleasesLive(initial.document, '/releases?pageSize=50');
    navigateReleasesLive(initial.document, '/releases?pageSize=100');
    expect(requests[1].init.signal.aborted).toBe(true);
    requests[2].reject(new Error('offline'));
    await flush();
    requests[1].resolve(responseFor('stale-fifty', requests[1].url.href));
    await flush();
    expect(initial.document.querySelector('[data-releases-live-region]')).toBe(ten.region);
    expect(liveFailureRetries(initial.document)).toHaveLength(1);
    expectNativeResetSize(windowObject, initial, '10');

    // Enhancement lost: the defaults controller hands Reset to the native GET
    // form, which submits only the installed 10.
    windowObject.DOMParser = undefined;
    const controller = createReleasesFiltersDefaults(initial.document, { onStatus: () => {} });
    expect(controller.resetFilters().outcome).toBe('unavailable');
    expect(requests).toHaveLength(3);
    expect(nativeResetSubmission(windowObject, initial)).toEqual([['pageSize', '10']]);
    expect(windowObject.fetch.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });

  it.each([
    ['50', '10'],
    ['10', '50'],
    ['50', '25'],
    ['25', '100'],
  ])('installed %s -> %s: the native form carries exactly the new size', async (from, to) => {
    const next = p5Response(to);
    const { initial, windowObject, requests } = p5Setup({ pageSize: from, pages: new Map([['next', next.document]]) });
    expectNativeResetSize(windowObject, initial, from);
    navigateReleasesLive(initial.document, to === '25' ? '/releases' : `/releases?pageSize=${to}`);
    expectNativeResetSize(windowObject, initial, from);
    requests[0].resolve(responseFor('next', requests[0].url.href));
    await flush();
    expect(initial.document.querySelector('[data-releases-live-region]')).toBe(next.region);
    expectNativeResetSize(windowObject, initial, to);
    expect(windowObject.history.pushes).toHaveLength(1);
    expectGetOnly(windowObject);
  });

  it('size change then Search and a Project edit keep the installed size; Reset install keeps it too', async () => {
    vi.useFakeTimers();
    const sized = p5Response('10');
    const searched = p5Response('10');
    const projected = p5Response('10');
    const reset = p5Response('10');
    const { initial, windowObject, requests } = p5Setup({
      pageSize: '50',
      pages: new Map([
        ['sized', sized.document], ['searched', searched.document],
        ['projected', projected.document], ['reset', reset.document],
      ]),
    });
    navigateReleasesLive(initial.document, '/releases?asset=42&pageSize=10');
    requests[0].resolve(responseFor('sized', requests[0].url.href));
    await vi.runAllTimersAsync();
    expectNativeResetSize(windowObject, initial, '10');

    sized.searchInput.value = 'Needle';
    initial.form.dispatch('input', { target: sized.searchInput });
    await vi.advanceTimersByTimeAsync(1000);
    expect(requests).toHaveLength(2);
    expect(requests[1].url.searchParams.getAll('pageSize')).toEqual(['10']);
    requests[1].resolve(responseFor('searched', requests[1].url.href));
    await vi.runAllTimersAsync();
    expectNativeResetSize(windowObject, initial, '10');

    navigateReleasesLive(initial.document, '/releases?project=7&pageSize=10');
    requests[2].resolve(responseFor('projected', requests[2].url.href));
    await vi.runAllTimersAsync();
    expectNativeResetSize(windowObject, initial, '10');

    navigateReleasesLive(initial.document, '/releases?pageSize=10');
    requests[3].resolve(responseFor('reset', requests[3].url.href));
    await vi.runAllTimersAsync();
    expectNativeResetSize(windowObject, initial, '10');
    // The native Reset never carries the asset scope or any filter.
    expect(nativeResetSubmission(windowObject, initial).map(([name]) => name)).toEqual(['pageSize']);
    expectGetOnly(windowObject);
  });

  it('successful Back/Forward install their sizes; a pending or failed Back does not', async () => {
    const back = p5Response('10');
    const forward = p5Response('50');
    const { initial, windowObject, requests } = p5Setup({
      pageSize: '100', pages: new Map([['back', back.document], ['forward', forward.document]]),
    });

    p5HistoryTo(windowObject, 'http://creatorcrate.test/releases?pageSize=10');
    expect(requests).toHaveLength(1);
    expectNativeResetSize(windowObject, initial, '100');
    requests[0].resolve(responseFor('back', requests[0].url.href));
    await flush();
    expectNativeResetSize(windowObject, initial, '10');

    p5HistoryTo(windowObject, 'http://creatorcrate.test/releases?pageSize=50');
    requests[1].resolve(responseFor('forward', requests[1].url.href));
    await flush();
    expectNativeResetSize(windowObject, initial, '50');

    // Back pending, then failed: the installed 50 stays.
    p5HistoryTo(windowObject, 'http://creatorcrate.test/releases?pageSize=10');
    expectNativeResetSize(windowObject, initial, '50');
    requests[2].reject(new Error('offline'));
    await flush();
    expect(liveFailureRetries(initial.document)).toHaveLength(1);
    expectNativeResetSize(windowObject, initial, '50');
    // History synchronization adds no entry.
    expect(windowObject.history.pushes).toHaveLength(0);
    expectGetOnly(windowObject);
  });

  it('failed page-size GET leaves the installed size; GET-only Retry installs and updates; a superseded Retry does not', async () => {
    const retried = p5Response('10');
    const lateRetry = p5Response('100');
    const { initial, windowObject, requests } = p5Setup({
      pageSize: '50', pages: new Map([['retried', retried.document], ['late-retry', lateRetry.document]]),
    });
    navigateReleasesLive(initial.document, '/releases?pageSize=10');
    requests[0].reject(new Error('offline'));
    await flush();
    expectNativeResetSize(windowObject, initial, '50');

    liveFailureRetries(initial.document)[0].dispatch('click');
    expect(requests).toHaveLength(2);
    expect(requests[1].url.href).toBe(requests[0].url.href);
    expect(requests[1].init.method).toBe('GET');
    expectNativeResetSize(windowObject, initial, '50');
    requests[1].resolve(responseFor('retried', requests[1].url.href));
    await flush();
    expect(liveFailureNotice(initial.document)).toBeNull();
    expectNativeResetSize(windowObject, initial, '10');

    // A failed GET whose Retry is superseded by another GET: the late Retry
    // response never installs or updates the native form.
    navigateReleasesLive(initial.document, '/releases?pageSize=100');
    requests[2].reject(new Error('offline'));
    await flush();
    liveFailureRetries(initial.document)[0].dispatch('click');
    navigateReleasesLive(initial.document, '/releases?pageSize=50');
    expect(requests[3].init.signal.aborted).toBe(true);
    requests[3].resolve(responseFor('late-retry', requests[3].url.href));
    await flush();
    expectNativeResetSize(windowObject, initial, '10');
    expectGetOnly(windowObject);
  });

  it('failed Reset GET leaves the native form at the installed size', async () => {
    const { initial, windowObject, requests } = p5Setup({ pageSize: '50' });
    const controller = createReleasesFiltersDefaults(initial.document, { onStatus: () => {} });
    expect(controller.resetFilters().outcome).toBe('started');
    expectOnlyReleasesParams(requests[0].url.href, [['pageSize', '50']]);
    requests[0].reject(new Error('offline'));
    await flush();
    expectNativeResetSize(windowObject, initial, '50');
    expectGetOnly(windowObject);
  });

  it('collapses duplicate native pageSize fields to the one installed value', async () => {
    const next = p5Response('10');
    const { initial, windowObject, requests } = p5Setup({ pageSize: '50', pages: new Map([['next', next.document]]) });
    initial.resetForm.insertBefore(makeNode({
      tagName: 'input', attrs: { type: 'hidden', name: 'pageSize' }, value: '100',
    }), initial.reset);
    navigateReleasesLive(initial.document, '/releases?pageSize=10');
    requests[0].resolve(responseFor('next', requests[0].url.href));
    await flush();
    expectNativeResetSize(windowObject, initial, '10');
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


describe('Releases defaults refresh history ownership', () => {
  afterEach(() => vi.useRealTimers());

  describe.each(['save', 'resetDefaults'])('%s', (kind) => {
    const scenarios = [
      'failed', 'pending', 'installed', 'retry', 'superseded', 'stale retry',
      'newer edit', 'pagination', 'sort edit', 'rejected', 'unmatched',
    ];
    if (kind === 'resetDefaults') scenarios.push('Reset after pending Search', 'Reset after failed Search');

    it.each(scenarios)(
      'preserves the current history authority with %s navigation',
      async (scenario) => {
        vi.useFakeTimers();
        const installed = p3bAuthority();
        const alpha = makeCombinedPage({ projects: ['7'], search: 'Alpha' });
        const beta = makeCombinedPage({ projects: ['7'], search: 'Beta' });
        const gamma = makeCombinedPage({ projects: ['7'], search: 'Gamma' });
        const pages = new Map([['beta', beta.document], ['gamma', gamma.document]]);
        const windowObject = makeWindow(alpha.document, pages);
        const alphaUrl = 'http://creatorcrate.test/releases?project=7&search=Alpha';
        windowObject.location.href = alphaUrl;
        const requests = heldRequests(windowObject);
        const post = Promise.withResolvers();
        const fetch = vi.fn((_url, options) => options.method === 'POST' ? post.promise
          : Promise.resolve({ ok: true, json: async () => ({ status: 'success', authority: installed }) }));
        const navigate = vi.fn(navigateReleasesLive);
        const controller = createReleasesFiltersDefaults(alpha.document, {
          fetch,
          live: { snapshot: releasesLiveSnapshot, navigate, subscribe: subscribeReleasesLive },
          readAuthority: () => installed,
          csrfToken: () => 'csrf',
          createOperationId: () => 'current-operation',
        });
        const resetUsesReturnTo = scenario.startsWith('Reset after');
        let operation = resetUsesReturnTo ? null : controller[kind]();
        await flush();
        const values = installed.current;
        const reset = kind === 'resetDefaults';
        const nextAuthority = reset ? {
          ...installed,
          defaults: installed.fallbacks,
          saved: Object.fromEntries(installed.fields.map((field) => [field, { stored: false, valid: false }])),
          savedKeys: [],
          hasSavedDefaults: false,
          generation: 4,
        } : { ...installed, generation: 4 };

        function search(title, delay = 350) {
          const input = alpha.document.querySelector('#releases-search');
          input.value = title;
          input.dispatch('input');
          vi.advanceTimersByTime(delay);
        }

        search('Beta');
        const first = releasesLiveSnapshot(alpha.document);
        expect(first).toMatchObject({ pending: true, outstandingHistoryMode: 'push' });
        expect(new URL(first.intendedUrl).searchParams.get('project')).toBe('7');
        expect(new URL(first.intendedUrl).searchParams.get('search')).toBe('Beta');
        if (scenario === 'installed') {
          const afterInstall = Promise.withResolvers();
          const { pushState } = windowObject.history;
          windowObject.history.pushState = function (...args) {
            pushState.apply(this, args);
            // This runs after History and the region swap, before load completion.
            Promise.resolve().then(() => afterInstall.resolve(releasesLiveSnapshot(alpha.document)));
          };
          requests[0].resolve(responseFor('beta', first.intendedUrl));
          await flush();
          expect(await afterInstall.promise).toMatchObject({ pending: false, outstandingHistoryMode: null });
          expect(releasesLiveSnapshot(alpha.document).outstandingHistoryMode).toBeNull();
          expect(windowObject.history.pushes.map(({ url }) => url)).toEqual([first.intendedUrl]);
        } else if (scenario !== 'pending' && scenario !== 'Reset after pending Search') {
          requests[0].reject(new Error('offline'));
          await flush();
          expect(releasesLiveSnapshot(alpha.document)).toMatchObject({
            generation: first.generation, pending: false, failed: true,
            intendedUrl: first.intendedUrl, outstandingHistoryMode: 'push',
          });
          expect(windowObject.location.href).toBe(alphaUrl);
        }

        if (resetUsesReturnTo) {
          operation = controller.resetDefaults();
          await flush();
        }
        const body = fetch.mock.calls[0][1].body;
        expect(body.get('defaultsGeneration')).toBe('3');
        if (resetUsesReturnTo) {
          expect(new URL(body.get('returnTo'), alphaUrl).searchParams.get('search')).toBe('Beta');
        }
        if (scenario === 'newer edit') search('Gamma', 0);
        if (scenario === 'pagination') {
          alpha.next.setAttribute('href', '/releases?project=7&page=2');
          alpha.next.dispatch('click');
          expect(requests[1].url.searchParams.get('page')).toBe('2');
        }
        if (scenario === 'sort edit') {
          alpha.sort.value = 'title';
          alpha.form.dispatch('change', { target: alpha.sort });
          expect(requests[1].url.searchParams.get('sort')).toBe('title');
        }
        if (scenario === 'pagination' || scenario === 'sort edit') {
          expect(requests[1].url.searchParams.get('search')).toBe('Beta');
          expect(requests[1].url.searchParams.get('project')).toBe('7');
        }
        const countBeforeAck = requests.length;
        const current = releasesLiveSnapshot(alpha.document);
        const rejected = scenario === 'rejected';
        const payload = {
          status: rejected ? 'error' : 'success',
          values,
          authority: nextAuthority,
          refreshUrl: resetUsesReturnTo ? '/releases?project=7&search=Beta' : '/releases?search=Alpha',
          operation: {
            id: scenario === 'unmatched' ? 'older-operation' : body.get('defaultsOperation'),
            kind, result: rejected ? 'invalid' : 'committed', committed: !rejected,
            expectedGeneration: 3, generation: rejected ? null : 4,
          },
        };
        post.resolve({ ok: !rejected, status: rejected ? 422 : 200, json: async () => payload });
        const result = await operation;
        if (rejected || scenario === 'unmatched') {
          expect(result.outcome).toBe(rejected ? 'rejected' : 'uncertain');
          expect(requests).toHaveLength(1);
          expect(navigate).not.toHaveBeenCalled();
          expect(windowObject.history.pushes).toEqual([]);
          expect(windowObject.history.replaces).toEqual([]);
          expect(releasesLiveSnapshot(alpha.document).generation).toBe(first.generation);
          return;
        }

        expect(result.outcome).toBe('refreshing');
        expect(requests).toHaveLength(countBeforeAck + 1);
        const refresh = requests.at(-1);
        const mode = scenario === 'installed' ? 'replace' : 'push';
        const target = resetUsesReturnTo ? payload.refreshUrl : current.intendedUrl;
        expect(navigate).toHaveBeenCalledExactlyOnceWith(alpha.document, target, { historyMode: mode });
        expect(refresh.url.href).toBe(new URL(target, alphaUrl).href);
        expect(refresh.init.method).toBe('GET');
        const adopted = releasesLiveSnapshot(alpha.document);
        expect(adopted).toMatchObject({
          generation: current.generation + 1, pending: true, requestedHistoryMode: mode,
        });
        if (scenario === 'pending' || scenario === 'Reset after pending Search') {
          expect(requests[0].init.signal.aborted).toBe(true);
        }

        let destination = adopted.intendedUrl;
        if (['retry', 'superseded', 'stale retry'].includes(scenario)) {
          requests[1].reject(new Error('refresh unavailable'));
          await flush();
          expect(controller.operation).toMatchObject({ phase: 'refresh-failed', confirmed: true });
          const retryButton = liveFailureRetries(alpha.document)[0];
          if (scenario === 'stale retry') {
            search('Gamma', 0);
            retryButton.dispatch('click');
            expect(controller.retryRefresh()).toBe('superseded');
            expect(requests).toHaveLength(2);
            vi.advanceTimersByTime(350);
            destination = releasesLiveSnapshot(alpha.document).intendedUrl;
            expect(new URL(destination).searchParams.get('search')).toBe('Gamma');
            requests[2].resolve(responseFor('gamma', destination));
          } else {
            retryButton.dispatch('click');
            expect(requests[2].url.href).toBe(first.intendedUrl);
            expect(requests[2].init.method).toBe('GET');
            const retry = releasesLiveSnapshot(alpha.document);
            expect(retry).toMatchObject({ generation: adopted.generation + 1, requestedHistoryMode: 'push' });
            if (scenario === 'superseded') {
              search('Gamma');
              const newest = releasesLiveSnapshot(alpha.document);
              expect(newest.generation).toBe(retry.generation + 1);
              expect(requests[2].init.signal.aborted).toBe(true);
              destination = newest.intendedUrl;
              expect(new URL(destination).searchParams.get('project')).toBe('7');
              requests[3].resolve(responseFor('gamma', destination));
              await flush();
              requests[2].resolve(responseFor('beta', first.intendedUrl));
            } else {
              requests[2].resolve(responseFor('beta', destination));
            }
          }
        } else {
          refresh.resolve(responseFor(scenario === 'newer edit' ? 'gamma' : 'beta', destination));
        }
        await flush();
        expect(windowObject.location.href).toBe(destination);
        expect(windowObject.history.pushes.map(({ url }) => url)).toEqual([destination]);
        expect(windowObject.history.replaces).toEqual([]);
        expect(controller.operation).toBeNull();
        if (scenario === 'failed') {
          for (const [url, title] of [[alphaUrl, 'Alpha'], [destination, 'Beta']]) {
            const popped = makeCombinedPage({ projects: ['7'], search: title });
            const key = title === 'Alpha' ? 'back' : 'forward';
            pages.set(key, popped.document);
            windowObject.location.href = url;
            windowObject.dispatch('popstate');
            expect(releasesLiveSnapshot(alpha.document).outstandingHistoryMode).toBe('replace');
            expect(requests.at(-1).url.href).toBe(url);
            requests.at(-1).resolve(responseFor(key, url));
            await flush();
            expect(alpha.document.querySelector('[data-releases-live-region]')).toBe(popped.region);
          }
          expect(windowObject.history.pushes.map(({ url }) => url)).toEqual([destination]);
          expect(windowObject.history.replaces).toEqual([]);
        }
        expect(fetch.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1);
      },
    );
  });
});
