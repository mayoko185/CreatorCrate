import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  enhanceProjectsDefaultsFetchSave,
  enhanceProjectsLiveFiltering,
} from '../src/static/creatorcrate.js';
import {
  navigateProjectsLive,
  projectsLiveSnapshot,
  subscribeProjectsLive,
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
    open: false,
    hidden: false,
    focused: false,
    selectionStart: null,
    selectionEnd: null,
    textContent: '',
    setAttribute(name, rawValue) {
      const stringValue = String(rawValue);
      attributes.set(name, stringValue);
      if (name === 'id') this.id = stringValue;
      if (name === 'name') this.name = stringValue;
      if (name === 'type') this.type = stringValue;
      if (name === 'value') this.value = stringValue;
      if (name === 'checked') this.checked = true;
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
      if (name === 'checked') this.checked = false;
      if (name === 'hidden') this.hidden = false;
      if (name.startsWith('data-')) {
        delete this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())];
      }
    },
    matches(selector) {
      return selector.split(',').some((part) => {
        const candidate = part.trim();
        if (candidate.includes(':checked') && !this.checked) return false;
        if (candidate.includes(' ')) {
          const parts = candidate.split(/\s+/);
          const target = parts.pop();
          if (!this.matches(target)) return false;
          let ancestor = this.parentNode;
          while (ancestor) {
            if (ancestor.matches?.(parts.join(' '))) return true;
            ancestor = ancestor.parentNode;
          }
          return false;
        }
        if (candidate.startsWith('#')) return this.id === candidate.slice(1);

        if (candidate.startsWith('.')) {
          return String(this.getAttribute('class') || '').split(/\s+/).includes(candidate.slice(1));
        }

        const selectorWithoutState = candidate.replace(':checked', '');
        const tag = selectorWithoutState.match(/^[a-z][\w-]*/i)?.[0];
        if (tag && this.tagName !== tag.toUpperCase()) return false;
        const attrsInSelector = [...selectorWithoutState.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)];
        return attrsInSelector.every(([, name, expected]) => {
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
      if (!parent) return;
      const index = parent.children.indexOf(this);
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
    addEventListener(type, handler) {
      listeners.push({ type, handler });
    },
    focus() {
      this.focused = true;
      if (this.ownerDocument) this.ownerDocument.activeElement = this;
    },
    setSelectionRange(start, end) {
      this.selectionStart = start;
      this.selectionEnd = end;
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
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
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
  };

  Object.entries(attrs).forEach(([name, rawValue]) => node.setAttribute(name, rawValue));
  if (checked) node.checked = true;
  return node;
}

function makeNsfwForm(enabled = false) {
  const form = makeNode({
    tagName: 'form',
    attrs: {
      action: '/projects/nsfw-filter',
      method: 'post',
      'data-projects-nsfw-filter': '',
    },
  });
  const csrf = makeNode({ tagName: 'input', attrs: { name: '_csrf', type: 'hidden' }, value: 'csrf-token' });
  const value = makeNode({
    tagName: 'input',
    attrs: { name: 'enabled', type: 'hidden', 'data-projects-nsfw-value': '' },
    value: enabled ? '0' : '1',
  });
  const returnTo = makeNode({ tagName: 'input', attrs: { name: 'returnTo', type: 'hidden' }, value: '/projects?page=4' });
  const toggle = makeNode({
    tagName: 'button',
    attrs: {
      id: 'projects-nsfw-toggle',
      type: 'submit',
      'data-projects-nsfw-toggle': '',
      'aria-pressed': String(enabled),
      'aria-label': enabled ? 'Disable NSFW filter' : 'Enable NSFW filter',
      'data-tooltip': enabled ? 'Disable NSFW filter' : 'Enable NSFW filter',
    },
  });
  form.appendChild(csrf);
  form.appendChild(value);
  form.appendChild(returnTo);
  form.appendChild(toggle);
  return { form, csrf, value, returnTo, toggle };
}

function makePage(values = {}) {
  const document = makeNode({ tagName: 'document' });
  document.nodeType = 9;
  document.ownerDocument = document;
  document.activeElement = null;

  const region = makeNode({ attrs: { 'data-projects-live-region': '' } });
  const status = makeNode({ attrs: { 'data-projects-live-status': '' } });
  const fields = [];
  const add = (attrs, value = '', checked = false) => {
    const field = makeNode({ tagName: 'input', attrs, value, checked });
    fields.push(field);
    return field;
  };

  // WP10b: the results Search of the combined dialog (opt-in per test).
  const search = values.search === undefined
    ? null
    : add({ id: 'projects-search', name: 'search', type: 'search', 'data-projects-search': '' }, values.search);
  const page = add({ name: 'page', type: 'hidden' }, '4');
  // R2: opt-in radio-backed View (the combined dialog's real control) and the
  // Grid style field that is shown only for Grid.
  const view = values.viewRadios
    ? null
    : add({ name: 'view', type: 'hidden' }, values.view || 'list');
  const allProjects = makeNode({
    tagName: 'input',
    attrs: { id: 'project-project-option-all', name: 'project', type: 'radio', value: '' },
    checked: values.project === undefined,
  });
  const project = makeNode({
    tagName: 'input',
    attrs: {
      id: values.project === undefined ? 'project-project-option-project' : String(values.project),
      name: 'project',
      type: 'radio',
      value: String(values.project || '7'),
    },
    checked: values.project !== undefined,
  });
  fields.push(allProjects, project);
  const ready = add({ name: 'status', type: 'checkbox', value: 'ready' }, 'ready', values.statuses?.includes('ready') ?? true);
  const planned = add({ name: 'status', type: 'checkbox', value: 'planned' }, 'planned', values.statuses?.includes('planned') ?? false);
  const images = add({ name: 'type', type: 'checkbox', value: 'images' }, 'images', values.types?.includes('images') ?? false);
  const comic = add({ name: 'type', type: 'checkbox', value: 'comic' }, 'comic', values.types?.includes('comic') ?? false);
  const firstTag = add({ name: 'tag', type: 'checkbox', value: '2' }, '2', values.tags?.includes('2') ?? true);
  const secondTag = add({ name: 'tag', type: 'checkbox', value: '3' }, '3', values.tags?.includes('3') ?? true);
  const updated = add({ name: 'sort', type: 'radio', value: 'updated' }, 'updated', values.sort === 'updated');
  const sort = add({ name: 'sort', type: 'radio', value: 'title' }, 'title', values.sort !== undefined ? values.sort === 'title' : true);
  const descending = add({ name: 'order', type: 'radio', value: 'desc' }, 'desc', values.order === 'desc');
  const order = add({ name: 'order', type: 'radio', value: 'asc' }, 'asc', values.order !== undefined ? values.order === 'asc' : true);
  const gridControls = values.gridControls === true ? makeNode({
    attrs: { 'data-project-grid-size-controls': '' },
  }) : null;
  const gridSizeControls = gridControls ? makeNode({
    attrs: { 'data-asset-grid-size-controls': '' },
  }) : null;
  const gridSizeSlider = gridSizeControls ? makeNode({
    tagName: 'input',
    attrs: { type: 'range', 'data-grid-size-slider': '' },
    value: '2',
  }) : null;
  const grid = gridControls ? makeNode({ attrs: { class: 'project-grid' } }) : null;
  if (gridSizeControls) gridSizeControls.appendChild(gridSizeSlider);
  if (gridControls) gridControls.appendChild(gridSizeControls);
  const projectDropdown = makeNode({
    tagName: 'details',
    attrs: {
      id: 'project-project-filter',
      class: 'asset-filter-multiselect asset-filter-multiselect--sized cc-dropdown',
      'data-cc-dropdown': '',
      'data-cc-dropdown-mode': 'single',
      'data-cc-dropdown-searchable': '',
      'data-cc-dropdown-type': 'searchable-single',
    },
  });
  const projectSummary = makeNode({
    tagName: 'summary',
    attrs: {
      id: 'project-project-filter-trigger',
      'aria-controls': 'project-project-filter-options',
    },
  });
  const projectCurrentSummary = makeNode({ attrs: { 'data-cc-dropdown-summary-current': '' } });
  projectSummary.appendChild(projectCurrentSummary);
  const projectPanel = makeNode({
    attrs: {
      id: 'project-project-filter-options',
      class: 'asset-filter-multiselect-panel asset-project-filter-panel',
    },
  });
  const projectSearch = makeNode({
    tagName: 'input',
    attrs: {
      id: 'project-project-filter-search',
      class: 'asset-project-filter-search',
      type: 'search',
      'data-cc-dropdown-search': '',
    },
  });
  const projectOptionList = makeNode({
    attrs: { id: 'project-project-filter-option-list', class: 'asset-project-filter-option-list', 'data-cc-dropdown-option-list': '' },
  });
  const addProjectOption = (input, labelText) => {
    const option = makeNode({ attrs: { class: 'asset-filter-multiselect-option asset-project-filter-option' } });
    const label = makeNode({ tagName: 'label' });
    label.textContent = labelText;
    label.appendChild(input);
    option.appendChild(label);
    projectOptionList.appendChild(option);
  };
  addProjectOption(allProjects, 'All projects');
  addProjectOption(project, values.project === undefined ? 'Project' : `Project ${values.project}`);
  const projectNoResults = makeNode({ attrs: { 'data-cc-dropdown-no-results': '', hidden: '' } });
  projectPanel.appendChild(projectSearch);
  projectPanel.appendChild(projectOptionList);
  projectPanel.appendChild(projectNoResults);
  projectDropdown.appendChild(projectSummary);
  projectDropdown.appendChild(projectPanel);
  const form = makeNode({ tagName: 'form', attrs: { id: 'project-filters', action: '/projects', method: 'get' } });
  form.submit = vi.fn();
  fields.forEach((field) => {
    if (field === allProjects) form.appendChild(projectDropdown);
    else if (field !== project) form.appendChild(field);
  });
  let viewGrid = null;
  let viewList = null;
  let viewSummary = null;
  let gridStyleField = null;
  let gridStyleDropdown = null;
  let gridStyleSummary = null;
  let gridStyleSelect = null;
  if (values.viewRadios) {
    const initialView = values.viewRadios === 'list' ? 'list' : 'grid';
    const viewDropdown = makeNode({
      tagName: 'details',
      attrs: { id: 'project-view-filter', class: 'cc-dropdown', 'data-cc-dropdown': '', 'data-cc-dropdown-mode': 'single' },
    });
    viewSummary = makeNode({ tagName: 'summary', attrs: { id: 'project-view-filter-trigger' } });
    viewDropdown.appendChild(viewSummary);
    viewGrid = makeNode({ tagName: 'input', attrs: { id: 'project-view-option-grid', name: 'view', type: 'radio', value: 'grid' }, checked: initialView === 'grid' });
    viewList = makeNode({ tagName: 'input', attrs: { id: 'project-view-option-list', name: 'view', type: 'radio', value: 'list' }, checked: initialView === 'list' });
    viewDropdown.appendChild(viewGrid);
    viewDropdown.appendChild(viewList);
    form.appendChild(viewDropdown);
    gridStyleField = makeNode({
      tagName: 'fieldset',
      attrs: {
        'data-projects-grid-style-field': '',
        'data-filters-visible-when-view': 'grid',
        ...(initialView === 'list' ? { hidden: '' } : {}),
      },
    });
    gridStyleDropdown = makeNode({ tagName: 'details', attrs: { id: 'project-grid-style-filter', class: 'cc-dropdown', 'data-cc-dropdown': '' } });
    gridStyleSummary = makeNode({ tagName: 'summary', attrs: { id: 'project-grid-style-filter-trigger' } });
    gridStyleDropdown.appendChild(gridStyleSummary);
    gridStyleSelect = makeNode({ tagName: 'select', attrs: { id: 'projects-grid-style', 'data-projects-grid-style': '' }, value: values.gridStyle || 'cropped' });
    gridStyleField.appendChild(gridStyleDropdown);
    gridStyleField.appendChild(gridStyleSelect);
    form.appendChild(gridStyleField);
  }
  const nsfw = makeNsfwForm(values.nsfwEnabled === true);
  const image = makeNode({
    tagName: 'img',
    attrs: { class: values.nsfwEnabled === true ? 'project-image--nsfw-blurred' : '' },
  });
  const dialog = makeNode({
    tagName: 'dialog',
    attrs: { id: 'projects-filter-dialog', 'data-app-dialog': '' },
  });
  dialog.open = values.dialogOpen === true;
  dialog.appendChild(form);
  region.appendChild(status);
  if (gridControls) region.appendChild(gridControls);
  if (grid) region.appendChild(grid);
  region.appendChild(nsfw.form);
  region.appendChild(image);
  document.appendChild(region);
  document.appendChild(dialog);

  return {
    document,
    region,
    status,
    dialog,
    form,
    projectDropdown,
    projectSearch,
    projectCurrentSummary,
    allProjects,
    page,
    view,
    project,
    ready,
    planned,
    images,
    comic,
    firstTag,
    secondTag,
    updated,
    sort,
    descending,
    order,
    grid,
    gridSizeSlider,
    nsfw,
    image,
    search,
    viewGrid,
    viewList,
    viewSummary,
    gridStyleField,
    gridStyleDropdown,
    gridStyleSummary,
    gridStyleSelect,
  };
}

// WP10b: select several Projects in the multi-select (repeated values).
function selectProjects(page, ids) {
  page.allProjects.checked = false;
  page.project.checked = false;
  ids.forEach((id) => {
    const input = makeNode({
      tagName: 'input',
      attrs: { name: 'project', type: 'checkbox', value: String(id) },
      checked: true,
    });
    page.form.appendChild(input);
  });
}

function addProjectsDefaultsAutosave(page) {
  const dialog = makeNode({ tagName: 'dialog', attrs: { id: 'projects-defaults-dialog' } });
  const form = makeNode({
    tagName: 'form',
    attrs: {
      id: 'projects-defaults-form',
      action: '/projects/defaults',
      method: 'post',
      'data-projects-defaults-autosave': '',
    },
  });
  const view = makeNode({
    tagName: 'select',
    attrs: { name: 'view', 'data-autosubmit': 'fetch' },
    value: 'grid',
  });
  view.form = form;
  form.appendChild(view);
  dialog.appendChild(form);
  page.document.appendChild(dialog);
  return { dialog, form, view };
}

function selectedValues(form, name) {
  return form.querySelectorAll(`input[name="${name}"]:checked`).map((field) => field.value);
}

function addLiveLink(page, kind, href) {
  const link = makeNode({
    tagName: kind === 'dialog-reset' ? 'button' : 'a',
    attrs: {
      ...(kind === 'dialog-reset' ? { type: 'submit' } : { href }),
      ...(kind === 'reset' || kind === 'dialog-reset' ? { 'data-projects-reset': '' } : {}),
    },
  });
  const container = kind === 'view'
    ? makeNode({ tagName: 'nav', attrs: { class: 'view-switcher' } })
    : kind === 'pagination'
      ? makeNode({ attrs: { class: 'pagination' } })
      : kind === 'reset'
        ? makeNode({ attrs: { class: 'empty-state-actions' } })
        : kind === 'dialog-reset'
          ? makeNode({ tagName: 'form', attrs: { class: 'projects-filter-reset', method: 'get', action: href } })
      : page.region;
  container.appendChild(link);
  if (kind === 'dialog-reset') {
    link.form = container;
    link.formAction = page.document.defaultView?.location?.href
      || 'http://creatorcrate.test/projects?page=4';
  }
  if (kind === 'dialog-reset') page.dialog.appendChild(container);
  else if (container !== page.region) page.region.appendChild(container);
  return link;
}

function makeWindow(document, pages = new Map()) {
  const location = {
    href: 'http://creatorcrate.test/projects?page=4',
    pathname: '/projects',
  };
  const setLocation = (value) => {
    const parsed = new URL(value, location.href);
    location.href = parsed.href;
    location.pathname = parsed.pathname;
  };
  const windowObject = {
    location,
    setLocation,
    listeners: [],
    fetch: vi.fn(),
    setTimeout,
    clearTimeout,
    AbortController,
    URLSearchParams,
    FormData: class FormDataMock {
      constructor(form) {
        this.fields = form.querySelectorAll('input, select, textarea')
          .filter((field) => field.name && !field.disabled && (field.type !== 'checkbox' && field.type !== 'radio' || field.checked))
          .map((field) => [field.name, field.value]);
      }

      *entries() {
        yield* this.fields;
      }

      [Symbol.iterator]() {
        return this.entries();
      }
    },
    DOMParser: class DOMParserMock {
      parseFromString(text) {
        return pages.get(text) || makeNode({ tagName: 'document' });
      }
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
      this.listeners.push({ type, handler });
    },
    dispatch(type, props = {}) {
      const event = { type, ...props };
      this.listeners.filter((listener) => listener.type === type)
        .forEach((listener) => listener.handler(event));
    },
  };
  document.defaultView = windowObject;
  return windowObject;
}

function responseFor(page, text, url = 'http://creatorcrate.test/projects') {
  return {
    ok: true,
    url,
    text: vi.fn(async () => text),
    page,
  };
}

function jsonResponse(payload, ok = true) {
  return {
    ok,
    json: vi.fn(async () => payload),
  };
}

const liveFailureNotice = (document) => document.querySelector('[data-live-filter-failure]');
const liveFailureRetries = (document) => document.querySelectorAll('[data-live-filter-retry]');

async function flush() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

describe('Projects live filtering enhancement', () => {
  let originalGlobalDocument;

  beforeEach(() => {
    originalGlobalDocument = globalThis.document;
  });

  afterEach(() => {
    globalThis.document = originalGlobalDocument;
    vi.useRealTimers();
  });

  it('serializes the GET form, preserves selected options, resets page, and pushes the server URL without navigating', async () => {
    const initial = makePage({ project: 7, types: ['images', 'comic'], dialogOpen: true });
    const next = makePage({ project: 7, statuses: ['ready', 'planned'], types: ['images', 'comic'], tags: ['2', '3'] });
    const pages = new Map([['next', next.document]]);
    const windowObject = makeWindow(initial.document, pages);
    const responseUrl = 'http://creatorcrate.test/projects?status=ready&status=planned&type=images&type=comic&tag=2&tag=3&project=7&sort=title&order=asc&view=list';
    windowObject.fetch.mockResolvedValue(responseFor(next, 'next', responseUrl));

    expect(enhanceProjectsLiveFiltering(initial.document)).toBe(1);
    expect(enhanceProjectsLiveFiltering(initial.document)).toBe(1);
    initial.planned.checked = true;
    initial.document.activeElement = initial.planned;
    initial.form.dispatch('change', { target: initial.planned });
    await flush();

    expect(windowObject.fetch).toHaveBeenCalledTimes(1);
    const requested = new URL(windowObject.fetch.mock.calls[0][0]);
    expect(requested.pathname).toBe('/projects');
    expect(requested.searchParams.getAll('status')).toEqual(['ready', 'planned']);
    expect(requested.searchParams.getAll('type')).toEqual(['images', 'comic']);
    expect(requested.searchParams.getAll('tag')).toEqual(['2', '3']);
    expect(requested.searchParams.get('project')).toBe('7');
    expect(requested.searchParams.get('sort')).toBe('title');
    expect(requested.searchParams.get('order')).toBe('asc');
    expect(requested.searchParams.get('view')).toBe('list');
    expect(requested.searchParams.has('page')).toBe(false);
    expect(windowObject.history.pushes).toHaveLength(1);
    expect(windowObject.history.pushes[0].url).toBe(responseUrl);
    expect(windowObject.location.href).toBe(responseUrl);
    expect(initial.form.submit).not.toHaveBeenCalled();
    expect(initial.document.activeElement).toBe(next.planned);
    expect(next.projectCurrentSummary.textContent).toBe('Project 7');
    expect(initial.document.querySelector('#project-filters')).toBe(initial.form);
    expect(initial.document.querySelector('#projects-filter-dialog')).toBe(initial.dialog);
    expect(initial.dialog.open).toBe(true);
  });

  it('refreshes Projects through the real live engine after a confirmed Defaults save', async () => {
    const initial = makePage({ project: 7, statuses: ['ready'], types: ['images'], tags: ['2'] });
    const next = makePage({ project: 9, statuses: ['planned'], types: ['comic'], tags: ['3'] });
    const pages = new Map([['defaults-refresh', next.document]]);
    const windowObject = makeWindow(initial.document, pages);
    const defaults = addProjectsDefaultsAutosave(initial);
    const confirmedUrl = 'http://creatorcrate.test/projects?status=planned&type=comic&tag=3&project=9&sort=title&order=asc&view=list';
    windowObject.fetch
      .mockResolvedValueOnce({ ok: true, redirected: true, url: confirmedUrl, text: vi.fn(async () => '') })
      .mockResolvedValueOnce(responseFor(next, 'defaults-refresh', confirmedUrl));
    vi.stubGlobal('fetch', windowObject.fetch);
    vi.stubGlobal('FormData', windowObject.FormData);
    vi.stubGlobal('URLSearchParams', URLSearchParams);

    try {
      expect(enhanceProjectsLiveFiltering(initial.document)).toBe(1);
      expect(enhanceProjectsDefaultsFetchSave(initial.document)).toBe(1);
      defaults.view.value = 'list';
      defaults.view.dispatch('change');
      await flush();

      expect(windowObject.fetch).toHaveBeenCalledTimes(2);
      expect(windowObject.fetch.mock.calls[0]).toEqual([
        '/projects/defaults',
        expect.objectContaining({ method: 'POST' }),
      ]);
      expect(windowObject.fetch).toHaveBeenLastCalledWith(
        confirmedUrl,
        expect.objectContaining({ method: 'GET', headers: { Accept: 'text/html' } }),
      );
      expect(initial.document.querySelector('[data-projects-live-region]')).toBe(next.region);
      expect(initial.document.querySelector('[data-projects-live-region]')).not.toBe(initial.region);
      const reconciledForm = initial.document.querySelector('#project-filters');
      expect(reconciledForm).toBe(initial.form);
      expect(selectedValues(reconciledForm, 'project')).toEqual(['9']);
      expect(selectedValues(reconciledForm, 'status')).toEqual(['planned']);
      expect(selectedValues(reconciledForm, 'type')).toEqual(['comic']);
      expect(selectedValues(reconciledForm, 'tag')).toEqual(['3']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ['pagination', 'pagination', 'list', 'list', '/projects?page=5&view=list', 'http://creatorcrate.test/projects?page=5&view=list'],
    ['Grid view switcher', 'view', 'list', 'grid', '/projects?view=grid', 'http://creatorcrate.test/projects?view=grid'],
  ])('uses the live region for %s links', async (_label, kind, initialView, nextView, href, responseUrl) => {
    const initial = makePage({ view: initialView, dialogOpen: true });
    const next = makePage({ view: nextView });
    const pages = new Map([['next', next.document]]);
    const windowObject = makeWindow(initial.document, pages);
    windowObject.fetch.mockResolvedValue(responseFor(next, 'next', responseUrl));
    const link = addLiveLink(initial, kind, href);
    enhanceProjectsLiveFiltering(initial.document);

    const event = link.dispatch('click', { button: 0 });
    await flush();

    expect(event.defaultPrevented).toBe(true);
    expect(windowObject.fetch).toHaveBeenCalledWith(
      new URL(href, 'http://creatorcrate.test/projects?page=4').href,
      expect.objectContaining({ method: 'GET', headers: { Accept: 'text/html' } }),
    );
    expect(initial.document.querySelector('[data-projects-live-region]')).toBe(next.region);
    expect(initial.document.querySelector('#project-filters')).toBe(initial.form);
    expect(initial.document.querySelector('#projects-filter-dialog')).toBe(initial.dialog);
    expect(initial.dialog.open).toBe(true);
    expect(windowObject.history.pushes).toEqual([
      expect.objectContaining({ url: responseUrl }),
    ]);
    expect(initial.form.submit).not.toHaveBeenCalled();
  });

  it('enhances the Grid-size control only when a Projects replacement installs Grid markup', async () => {
    const initial = makePage({ view: 'list' });
    const next = makePage({ view: 'grid', gridControls: true });
    const pages = new Map([['grid', next.document]]);
    const windowObject = makeWindow(initial.document, pages);
    windowObject.fetch.mockResolvedValue(responseFor(next, 'grid', 'http://creatorcrate.test/projects?view=grid'));
    const link = addLiveLink(initial, 'view', '/projects?view=grid');
    enhanceProjectsLiveFiltering(initial.document);

    link.dispatch('click', { button: 0 });
    await flush();

    const slider = initial.document.querySelector('[data-grid-size-slider]');
    expect(slider).toBe(next.gridSizeSlider);
    expect(initial.region.querySelector('[data-grid-size-slider]')).toBeNull();
    slider.value = '1';
    slider.dispatch('input');
    expect(next.grid.getAttribute('data-grid-size')).toBe('compact');
  });

  it('binds List title information cards after replacement without letting card clicks navigate the row', async () => {
    const initial = makePage({ view: 'grid' });
    const next = makePage({ view: 'list' });
    const row = makeNode({ tagName: 'tr', attrs: { class: 'projects-list-row', 'data-project-card': '', 'data-project-id': '9' } });
    const projectCell = makeNode({ tagName: 'td' });
    const titleInfo = makeNode({ attrs: { class: 'dashboard-title-info', 'data-dashboard-title-info': '' } });
    const trigger = makeNode({
      tagName: 'button',
      attrs: { type: 'button', 'data-calendar-info-trigger': '', 'aria-controls': 'projects-list-info-9', 'aria-expanded': 'false' },
    });
    const card = makeNode({ attrs: { id: 'projects-list-info-9', 'data-calendar-info-card': '', popover: 'manual' } });
    const cardDetails = makeNode({ tagName: 'dl' });
    const actionsCell = makeNode({ tagName: 'td' });
    const openLink = makeNode({ tagName: 'a', attrs: { 'data-project-card-link': '', href: '/projects/9' } });
    openLink.click = vi.fn();
    card.appendChild(cardDetails);
    titleInfo.appendChild(trigger);
    titleInfo.appendChild(card);
    projectCell.appendChild(titleInfo);
    actionsCell.appendChild(openLink);
    row.appendChild(projectCell);
    row.appendChild(actionsCell);
    next.region.appendChild(row);

    const windowObject = makeWindow(initial.document, new Map([['list', next.document]]));
    windowObject.fetch.mockResolvedValue(responseFor(next, 'list', 'http://creatorcrate.test/projects?view=list'));
    const link = addLiveLink(initial, 'view', '/projects?view=list');
    enhanceProjectsLiveFiltering(initial.document);

    link.dispatch('click', { button: 0 });
    await flush();

    expect(initial.document.querySelector('[data-calendar-info-trigger]')).toBe(trigger);
    trigger.dispatch('click', { button: 0 });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(card.getAttribute('data-info-card-open')).toBe('true');

    cardDetails.dispatch('click', { button: 0 });
    expect(openLink.click).not.toHaveBeenCalled();
    expect(card.getAttribute('data-info-card-open')).toBe('true');

    trigger.dispatch('click', { button: 0 });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(card.getAttribute('data-info-card-open')).toBeNull();
    expect(openLink.click).not.toHaveBeenCalled();

    projectCell.dispatch('click', { button: 0 });
    expect(openLink.click).toHaveBeenCalledTimes(1);
  });

  it('uses the existing live Reset path for the Filter dialog button without navigation and keeps the dialog open', async () => {
    const initial = makePage({
      project: 7,
      statuses: ['planned'],
      types: ['images'],
      tags: ['2'],
      sort: 'updated',
      order: 'desc',
      view: 'grid',
      gridControls: true,
      dialogOpen: true,
    });
    const next = makePage({
      statuses: ['ready'],
      types: ['comic'],
      tags: ['3'],
      sort: 'title',
      order: 'asc',
      view: 'list',
    });
    const afterReplacement = makePage({
      statuses: ['planned'],
      types: [],
      tags: ['2', '3'],
      sort: 'title',
      order: 'asc',
      view: 'list',
    });
    const pages = new Map([
      ['reset-result', next.document],
      ['reset-after-replacement', afterReplacement.document],
    ]);
    const windowObject = makeWindow(initial.document, pages);
    windowObject.location.assign = vi.fn();
    windowObject.fetch
      .mockResolvedValueOnce(responseFor(
        next,
        'reset-result',
        'http://creatorcrate.test/projects?status=ready&type=comic&tag=3&sort=title&order=asc&view=list',
      ))
      .mockResolvedValueOnce(responseFor(
        afterReplacement,
        'reset-after-replacement',
        'http://creatorcrate.test/projects?status=planned&tag=2&tag=3&sort=title&order=asc&view=list',
      ));
    const reset = addLiveLink(initial, 'dialog-reset', '/projects');

    expect(initial.form.querySelector('input[name="project"]:checked')?.value).toBe('7');
    expect(selectedValues(initial.form, 'status')).toEqual(['planned']);
    expect(selectedValues(initial.form, 'type')).toEqual(['images']);
    expect(selectedValues(initial.form, 'tag')).toEqual(['2']);
    expect(initial.form.querySelector('input[name="sort"]:checked')?.value).toBe('updated');
    expect(initial.form.querySelector('input[name="order"]:checked')?.value).toBe('desc');
    expect(initial.form.querySelector('input[name="view"]')?.value).toBe('grid');
    expect(initial.region.querySelector('[data-project-grid-size-controls]')).not.toBeNull();
    enhanceProjectsLiveFiltering(initial.document);

    const event = reset.dispatch('click', { button: 0 });
    await flush();

    expect(event.defaultPrevented).toBe(true);
    expect(windowObject.fetch).toHaveBeenCalledWith(
      'http://creatorcrate.test/projects',
      expect.objectContaining({ method: 'GET', headers: { Accept: 'text/html' } }),
    );
    expect(windowObject.location.assign).not.toHaveBeenCalled();
    expect(initial.document.querySelector('[data-projects-live-region]')).toBe(next.region);
    expect(next.region.querySelector('[data-project-grid-size-controls]')).toBeNull();
    expect(initial.document.querySelector('#projects-filter-dialog')).toBe(initial.dialog);
    expect(initial.dialog.open).toBe(true);
    const reconciledForm = initial.document.querySelector('#project-filters');
    expect(reconciledForm).toBe(initial.form);
    expect(reconciledForm.getAttribute('action')).toBe('/projects');
    expect(reconciledForm.getAttribute('method')).toBe('get');
    expect(reconciledForm.querySelector('input[name="project"]:checked')?.value).toBe('');
    expect(selectedValues(reconciledForm, 'status')).toEqual(['ready']);
    expect(selectedValues(reconciledForm, 'type')).toEqual(['comic']);
    expect(selectedValues(reconciledForm, 'tag')).toEqual(['3']);
    expect(reconciledForm.querySelector('input[name="sort"]:checked')?.value).toBe('title');
    expect(reconciledForm.querySelector('input[name="order"]:checked')?.value).toBe('asc');
    expect(reconciledForm.querySelector('input[name="view"]')?.value).toBe('list');
    expect(windowObject.history.pushes).toEqual([
      expect.objectContaining({ url: 'http://creatorcrate.test/projects?status=ready&type=comic&tag=3&sort=title&order=asc&view=list' }),
    ]);
    expect(initial.form.submit).not.toHaveBeenCalled();

    const repeatedEvent = reset.dispatch('click', { button: 0 });
    await flush();

    expect(repeatedEvent.defaultPrevented).toBe(true);
    expect(windowObject.fetch).toHaveBeenCalledTimes(2);
    expect(windowObject.fetch.mock.calls[1][0]).toBe('http://creatorcrate.test/projects');
    expect(initial.document.querySelector('[data-projects-live-region]')).toBe(afterReplacement.region);
    expect(initial.form.querySelector('input[name="status"]:checked')?.value).toBe('planned');
    expect(initial.form.submit).not.toHaveBeenCalled();
  });

  it('clears only Project when the shared selector returns to All projects', async () => {
    const initial = makePage({
      project: 7,
      statuses: ['ready', 'planned'],
      types: ['images', 'comic'],
      tags: ['2', '3'],
    });
    const next = makePage({
      statuses: ['ready', 'planned'],
      types: ['images', 'comic'],
      tags: ['2', '3'],
    });
    const pages = new Map([['all-projects', next.document]]);
    const windowObject = makeWindow(initial.document, pages);
    windowObject.fetch.mockResolvedValue(responseFor(
      next,
      'all-projects',
      'http://creatorcrate.test/projects?status=ready&status=planned&type=images&type=comic&tag=2&tag=3&sort=title&order=asc&view=list',
    ));
    enhanceProjectsLiveFiltering(initial.document);

    initial.project.checked = false;
    initial.allProjects.checked = true;
    initial.document.activeElement = initial.allProjects;
    initial.form.dispatch('change', { target: initial.allProjects });
    await flush();

    expect(windowObject.fetch).toHaveBeenCalledTimes(1);
    const requested = new URL(windowObject.fetch.mock.calls[0][0]);
    expect(requested.searchParams.has('project')).toBe(false);
    expect(requested.searchParams.getAll('status')).toEqual(['ready', 'planned']);
    expect(requested.searchParams.getAll('type')).toEqual(['images', 'comic']);
    expect(requested.searchParams.getAll('tag')).toEqual(['2', '3']);
    expect(requested.searchParams.get('sort')).toBe('title');
    expect(requested.searchParams.get('order')).toBe('asc');
    expect(requested.searchParams.get('view')).toBe('list');
    expect(requested.searchParams.has('page')).toBe(false);
    expect(initial.form.submit).not.toHaveBeenCalled();
    expect(next.projectCurrentSummary.textContent).toBe('All projects');
  });

  it('ignores stale out-of-order responses and keeps the newest replacement interactive', async () => {
    const initial = makePage();
    const first = makePage({ project: 8 });
    const second = makePage({ project: 7 });
    const third = makePage();
    const pages = new Map([
      ['first', first.document],
      ['second', second.document],
      ['third', third.document],
    ]);
    const windowObject = makeWindow(initial.document, pages);
    const requests = [];
    windowObject.fetch.mockImplementation((url, options) => new Promise((resolve) => requests.push({ url, options, resolve })));
    enhanceProjectsLiveFiltering(initial.document);

    initial.ready.checked = false;
    initial.form.dispatch('change', { target: initial.ready });
    initial.planned.checked = true;
    initial.form.dispatch('change', { target: initial.planned });
    expect(windowObject.fetch).toHaveBeenCalledTimes(2);
    expect(requests[0].options.signal.aborted).toBe(true);

    requests[1].resolve(responseFor(second, 'second', 'http://creatorcrate.test/projects?status=planned'));
    await flush();
    expect(windowObject.history.pushes).toHaveLength(1);
    expect(windowObject.history.pushes[0].url).toContain('status=planned');
    expect(initial.document.querySelector('[data-projects-live-region]')).toBe(second.region);
    expect(initial.form.contains(second.project)).toBe(true);

    requests[0].resolve(responseFor(first, 'first', 'http://creatorcrate.test/projects?tag=2&tag=3'));
    await flush();
    expect(initial.document.querySelector('[data-projects-live-region]')).toBe(second.region);
    expect(initial.form.contains(second.project)).toBe(true);
    expect(initial.form.contains(first.project)).toBe(false);

    second.ready.checked = false;
    initial.form.dispatch('change', { target: second.ready });
    await flush();
    expect(windowObject.fetch).toHaveBeenCalledTimes(3);
    requests[2].resolve(responseFor(third, 'third', 'http://creatorcrate.test/projects?tag=2&tag=3'));
    await flush();
    expect(initial.document.querySelector('[data-projects-live-region]')).toBe(third.region);
  });

  it('uses the current URL for Back/Forward, replaces with the canonical response URL, and replaces only the Projects region', async () => {
    const initial = makePage();
    const restored = makePage({ statuses: ['planned'] });
    const pages = new Map([['restored', restored.document]]);
    const windowObject = makeWindow(initial.document, pages);
    windowObject.location.set = undefined;
    const canonicalUrl = 'http://creatorcrate.test/projects?status=planned&view=list';
    windowObject.fetch.mockResolvedValue(responseFor(restored, 'restored', canonicalUrl));
    enhanceProjectsLiveFiltering(initial.document);

    windowObject.setLocation('http://creatorcrate.test/projects?status=planned');
    windowObject.dispatch('popstate');
    await flush();

    expect(windowObject.fetch).toHaveBeenCalledWith(
      'http://creatorcrate.test/projects?status=planned',
      expect.objectContaining({ method: 'GET', headers: { Accept: 'text/html' } }),
    );
    expect(windowObject.history.pushes).toHaveLength(0);
    expect(windowObject.history.replaces).toEqual([expect.objectContaining({ url: canonicalUrl })]);
    expect(initial.document.querySelector('[data-projects-live-region]')).toBe(restored.region);
    expect(initial.form.contains(restored.planned)).toBe(true);
    expect(restored.planned.checked).toBe(true);
    expect(restored.ready.checked).toBe(false);
  });

  it('stays local without mutating history after a failed request, then recovers through a replacement', async () => {
    const noFetchPage = makePage();
    const noFetchWindow = makeWindow(noFetchPage.document);
    noFetchWindow.fetch = undefined;
    enhanceProjectsLiveFiltering(noFetchPage.document);
    noFetchPage.form.dispatch('change', { target: noFetchPage.ready });
    expect(noFetchPage.form.submit).toHaveBeenCalledTimes(1);

    const failedPage = makePage();
    const recoveredPage = makePage({ statuses: ['ready', 'planned'] });
    const pages = new Map([['recovered', recoveredPage.document]]);
    const failedWindow = makeWindow(failedPage.document, pages);
    let rejectRequest;
    const failedRequest = new Promise((_, reject) => { rejectRequest = reject; });
    failedWindow.fetch
      .mockImplementationOnce(() => failedRequest)
      .mockResolvedValueOnce(responseFor(
        recoveredPage,
        'recovered',
        'http://creatorcrate.test/projects?status=ready&status=planned&tag=2&tag=3&sort=title&order=asc&view=list',
      ));
    enhanceProjectsLiveFiltering(failedPage.document);
    failedPage.form.dispatch('change', { target: failedPage.ready });

    expect(failedPage.region.getAttribute('aria-busy')).toBe('true');
    expect(failedPage.region.getAttribute('data-projects-live-state')).toBe('loading');
    expect(failedPage.status.textContent).toBe('Loading projects.');
    rejectRequest(new Error('network down'));
    await flush();

    expect(failedPage.form.submit).not.toHaveBeenCalled();
    expect(failedPage.document.querySelector('[data-projects-live-region]')).toBe(failedPage.region);
    expect(failedPage.region.getAttribute('aria-busy')).toBeNull();
    expect(failedPage.region.getAttribute('data-projects-live-state')).toBe('error');
    expect(failedPage.status.textContent).toContain('The requested filters were not applied');
    expect(liveFailureNotice(failedPage.document)).not.toBeNull();
    expect(failedWindow.history.pushes).toHaveLength(0);
    expect(failedWindow.history.replaces).toHaveLength(0);

    failedPage.planned.checked = true;
    failedPage.form.dispatch('change', { target: failedPage.planned });
    await flush();

    expect(failedWindow.fetch).toHaveBeenCalledTimes(2);
    expect(liveFailureNotice(failedPage.document)).toBeNull();
    expect(failedPage.document.querySelector('[data-projects-live-region]')).toBe(recoveredPage.region);
    expect(failedWindow.history.pushes).toEqual([
      expect.objectContaining({
        url: 'http://creatorcrate.test/projects?status=ready&status=planned&tag=2&tag=3&sort=title&order=asc&view=list',
      }),
    ]);
  });

  describe('failed filter recovery', () => {
    const FILTERED = 'http://creatorcrate.test/projects?status=ready';

    function failedFilter({ pages = new Map() } = {}) {
      const page = makePage();
      const windowObject = makeWindow(page.document, pages);
      windowObject.location.assign = vi.fn();
      windowObject.location.reload = vi.fn();
      enhanceProjectsLiveFiltering(page.document);
      return { page, windowObject };
    }

    function expectNoNavigation({ page, windowObject }) {
      expect(page.form.submit).not.toHaveBeenCalled();
      expect(windowObject.location.assign).not.toHaveBeenCalled();
      expect(windowObject.location.reload).not.toHaveBeenCalled();
    }

    it('keeps results and inputs after a failed GET, then Retry repeats only that GET', async () => {
      const recovered = makePage();
      const context = failedFilter({ pages: new Map([['recovered', recovered.document]]) });
      const { page, windowObject } = context;
      const startHref = windowObject.location.href;
      windowObject.fetch.mockRejectedValueOnce(new Error('offline'));
      page.ready.checked = true;
      page.form.dispatch('change', { target: page.ready });
      await flush();

      expectNoNavigation(context);
      expect(page.document.querySelector('[data-projects-live-region]')).toBe(page.region);
      expect(page.ready.checked).toBe(true);
      expect(windowObject.location.href).toBe(startHref);
      expect(windowObject.history.pushes).toHaveLength(0);
      expect(liveFailureRetries(page.document)).toHaveLength(1);

      const requested = windowObject.fetch.mock.calls[0][0];
      windowObject.fetch.mockResolvedValueOnce(responseFor(recovered, 'recovered', requested));
      liveFailureRetries(page.document)[0].dispatch('click');
      expect(liveFailureNotice(page.document)).toBeNull();
      await flush();

      expect(windowObject.fetch).toHaveBeenCalledTimes(2);
      expect(windowObject.fetch.mock.calls[1][0]).toBe(requested);
      expect(windowObject.fetch.mock.calls[1][1].method).toBe('GET');
      expect(windowObject.fetch.mock.calls[1][1].body).toBeUndefined();
      expect(page.document.querySelector('[data-projects-live-region]')).toBe(recovered.region);
      expect(liveFailureNotice(page.document)).toBeNull();
      expect(windowObject.history.pushes.map((entry) => entry.url)).toEqual([requested]);
      expectNoNavigation(context);
    });

    it('lets neither a stale Retry nor an older response overwrite a newer filter', async () => {
      const newest = makePage();
      const older = makePage();
      const context = failedFilter({ pages: new Map([['newest', newest.document], ['older', older.document]]) });
      const { page, windowObject } = context;
      windowObject.fetch.mockRejectedValueOnce(new Error('offline'));
      page.form.dispatch('change', { target: page.ready });
      await flush();
      const staleRetry = liveFailureRetries(page.document)[0];

      let releaseB;
      windowObject.fetch.mockImplementationOnce(() => new Promise((resolve) => { releaseB = resolve; }));
      page.planned.checked = true;
      page.form.dispatch('change', { target: page.planned });
      expect(liveFailureNotice(page.document)).toBeNull();
      staleRetry.dispatch('click');
      expect(windowObject.fetch).toHaveBeenCalledTimes(2);

      releaseB(responseFor(newest, 'newest', FILTERED));
      await flush();
      expect(page.document.querySelector('[data-projects-live-region]')).toBe(newest.region);
      staleRetry.dispatch('click');
      await flush();
      expect(windowObject.fetch).toHaveBeenCalledTimes(2);
      expect(page.document.querySelector('[data-projects-live-region]')).toBe(newest.region);
      expect(windowObject.history.pushes).toHaveLength(1);
    });

    it('treats HTTP errors, malformed fragments and foreign redirects as local failures with one Retry', async () => {
      const foreign = makePage();
      const context = failedFilter({ pages: new Map([['foreign', foreign.document]]) });
      const { page, windowObject } = context;
      windowObject.fetch
        .mockResolvedValueOnce({ ok: false, status: 500, url: FILTERED })
        .mockResolvedValueOnce(responseFor(null, 'no region here', FILTERED))
        .mockResolvedValueOnce(responseFor(foreign, 'foreign', 'http://creatorcrate.test/login'));
      for (const expectedCalls of [1, 2, 3]) {
        page.form.dispatch('change', { target: page.ready });
        await flush();
        expect(windowObject.fetch).toHaveBeenCalledTimes(expectedCalls);
        expect(page.document.querySelector('[data-projects-live-region]')).toBe(page.region);
        expect(liveFailureRetries(page.document)).toHaveLength(1);
      }
      expect(page.document.querySelectorAll('[data-live-filter-failure]')).toHaveLength(1);
      expect(windowObject.history.pushes).toHaveLength(0);
      expectNoNavigation(context);
    });

    it('does not report a cancelled request as a failure', async () => {
      const context = failedFilter();
      const { page, windowObject } = context;
      windowObject.fetch.mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      page.form.dispatch('change', { target: page.ready });
      await flush();
      expect(liveFailureNotice(page.document)).toBeNull();
      expect(page.region.getAttribute('data-projects-live-state')).toBeNull();
      expect(page.region.getAttribute('aria-busy')).toBeNull();
      expectNoNavigation(context);
    });

    it('keeps a failed Back local and retries the current history entry without new entries', async () => {
      const recovered = makePage();
      const context = failedFilter({ pages: new Map([['recovered', recovered.document]]) });
      const { page, windowObject } = context;
      windowObject.fetch.mockRejectedValueOnce(new Error('offline'));
      windowObject.setLocation(FILTERED);
      windowObject.dispatch('popstate');
      await flush();

      expect(page.document.querySelector('[data-projects-live-region]')).toBe(page.region);
      expect(liveFailureNotice(page.document).children[0].textContent).toContain('may not match');
      expect(windowObject.location.href).toBe(FILTERED);
      expectNoNavigation(context);

      windowObject.fetch.mockResolvedValueOnce(responseFor(recovered, 'recovered', FILTERED));
      liveFailureRetries(page.document)[0].dispatch('click');
      await flush();
      expect(windowObject.fetch.mock.calls[1][0]).toBe(FILTERED);
      expect(page.document.querySelector('[data-projects-live-region]')).toBe(recovered.region);
      expect(windowObject.history.pushes).toHaveLength(0);
      expect(windowObject.history.replaces).toHaveLength(0);
    });
  });

  it('submits the NSFW state asynchronously, replaces the server-rendered region, and keeps history unchanged', async () => {
    const initial = makePage({ nsfwEnabled: false });
    const next = makePage({ nsfwEnabled: true });
    const pages = new Map([['nsfw-enabled', next.document]]);
    const windowObject = makeWindow(initial.document, pages);
    // WP10a F1: the installed address carries repeated Projects the legacy
    // single-Project Filter form cannot express; the refresh re-requests it.
    const installed = 'http://creatorcrate.test/projects?project=7&project=12&page=4&view=list&status=ready&tag=2&tag=3&sort=title&order=asc';
    windowObject.setLocation(installed);
    windowObject.fetch
      .mockResolvedValueOnce(jsonResponse({ status: 'success', enabled: true }))
      .mockResolvedValueOnce(responseFor(next, 'nsfw-enabled', installed));

    expect(enhanceProjectsLiveFiltering(initial.document)).toBe(1);
    initial.nsfw.form.dispatch('submit', { target: initial.nsfw.toggle, submitter: initial.nsfw.toggle });
    await flush();

    expect(windowObject.fetch).toHaveBeenCalledTimes(2);
    expect(windowObject.fetch.mock.calls[0][0]).toBe('/projects/nsfw-filter');
    expect(windowObject.fetch.mock.calls[0][1]).toEqual(expect.objectContaining({
      method: 'POST',
      headers: { Accept: 'application/json' },
    }));
    expect([...windowObject.fetch.mock.calls[0][1].body.entries()]).toEqual([
      ['_csrf', 'csrf-token'],
      ['enabled', '1'],
      ['returnTo', '/projects?page=4'],
    ]);
    expect(windowObject.fetch.mock.calls[1][0]).toBe(installed);
    expect(new URL(windowObject.fetch.mock.calls[1][0]).searchParams.getAll('project')).toEqual(['7', '12']);
    expect(windowObject.history.pushes).toHaveLength(0);
    expect(windowObject.history.replaces).toHaveLength(0);
    expect(initial.document.querySelector('[data-projects-live-region]')).toBe(next.region);
    expect(next.nsfw.toggle.getAttribute('aria-pressed')).toBe('true');
    expect(next.nsfw.toggle.getAttribute('aria-label')).toBe('Disable NSFW filter');
    expect(next.nsfw.toggle.getAttribute('title')).toBeNull();
    expect(next.nsfw.toggle.getAttribute('data-tooltip')).toBe('Disable NSFW filter');
    expect(next.nsfw.value.value).toBe('0');
    expect(next.image.getAttribute('class')).toContain('project-image--nsfw-blurred');
  });

  it('rebinds the NSFW toggle after replacement and rejects stale rapid submissions', async () => {
    const initial = makePage({ nsfwEnabled: false });
    const enabled = makePage({ nsfwEnabled: true });
    const disabled = makePage({ nsfwEnabled: false });
    const pages = new Map([
      ['enabled', enabled.document],
      ['disabled', disabled.document],
    ]);
    const windowObject = makeWindow(initial.document, pages);
    windowObject.fetch
      .mockResolvedValueOnce(jsonResponse({ status: 'success', enabled: true }))
      .mockResolvedValueOnce(responseFor(enabled, 'enabled'))
      .mockResolvedValueOnce(jsonResponse({ status: 'success', enabled: false }))
      .mockResolvedValueOnce(responseFor(disabled, 'disabled'));
    enhanceProjectsLiveFiltering(initial.document);

    initial.nsfw.form.dispatch('submit', { target: initial.nsfw.toggle });
    initial.nsfw.form.dispatch('submit', { target: initial.nsfw.toggle });
    await flush();
    expect(windowObject.fetch).toHaveBeenCalledTimes(2);

    enabled.nsfw.form.dispatch('submit', { target: enabled.nsfw.toggle });
    await flush();
    expect(windowObject.fetch).toHaveBeenCalledTimes(4);
    expect(initial.document.querySelector('[data-projects-live-region]')).toBe(disabled.region);
    expect(disabled.nsfw.toggle.getAttribute('aria-pressed')).toBe('false');
  });

  it('re-requests a pending filter navigation with the history entry it still owes (WP10a F1)', async () => {
    const page = makePage({ nsfwEnabled: false });
    const next = makePage({ nsfwEnabled: true });
    const windowObject = makeWindow(page.document, new Map([['pending', next.document]]));
    const requests = [];
    windowObject.fetch.mockImplementation((url, options) => new Promise((resolve) => requests.push({ url, options, resolve })));
    enhanceProjectsLiveFiltering(page.document);

    page.form.dispatch('change', { target: page.planned });
    expect(requests).toHaveLength(1);
    const pendingUrl = requests[0].url;
    page.nsfw.form.dispatch('submit', { target: page.nsfw.toggle });
    expect(requests).toHaveLength(2);
    expect(requests[0].options.signal.aborted).toBe(true);

    requests[1].resolve(jsonResponse({ status: 'success', enabled: true }));
    await flush();
    expect(requests).toHaveLength(3);
    expect(requests[2].url).toBe(pendingUrl);
    requests[2].resolve(responseFor(next, 'pending', pendingUrl));
    await flush();

    expect(page.document.querySelector('[data-projects-live-region]')).toBe(next.region);
    expect(windowObject.history.pushes.map((entry) => entry.url)).toEqual([pendingUrl]);
    expect(windowObject.history.replaces).toHaveLength(0);
    expect(next.nsfw.toggle.disabled).toBe(false);
  });

  it('refreshes a navigation started during the NSFW POST, not the older destination (WP10a F1)', async () => {
    const page = makePage({ nsfwEnabled: false });
    const newer = makePage({ nsfwEnabled: false });
    const refreshed = makePage({ nsfwEnabled: true });
    const windowObject = makeWindow(page.document, new Map([
      ['newer', newer.document],
      ['refreshed', refreshed.document],
    ]));
    const installed = 'http://creatorcrate.test/projects?project=7&project=12&view=list';
    windowObject.setLocation(installed);
    const requests = [];
    windowObject.fetch.mockImplementation((url, options) => new Promise((resolve) => requests.push({ url, options, resolve })));
    enhanceProjectsLiveFiltering(page.document);

    page.nsfw.form.dispatch('submit', { target: page.nsfw.toggle });
    expect(requests).toHaveLength(1);
    page.form.dispatch('change', { target: page.planned });
    expect(requests).toHaveLength(2);
    const newerUrl = requests[1].url;
    expect(newerUrl).not.toBe(installed);

    requests[0].resolve(jsonResponse({ status: 'success', enabled: true }));
    await flush();
    // The stale installed destination never replaces the newer intent.
    expect(requests).toHaveLength(3);
    expect(requests[1].options.signal.aborted).toBe(true);
    expect(requests[2].url).toBe(newerUrl);
    requests[2].resolve(responseFor(refreshed, 'refreshed', newerUrl));
    await flush();

    expect(page.document.querySelector('[data-projects-live-region]')).toBe(refreshed.region);
    expect(windowObject.history.pushes.map((entry) => entry.url)).toEqual([newerUrl]);
    expect(refreshed.nsfw.toggle.getAttribute('aria-pressed')).toBe('true');
    expect(refreshed.nsfw.toggle.disabled).toBe(false);
  });

  describe('WP10b combined dialog Search and request state', () => {
    it('debounces results Search, keeps repeated Projects, and lets the newest typing win', async () => {
      vi.useFakeTimers();
      const page = makePage({ search: '' });
      selectProjects(page, [7, 12]);
      const next = makePage({ search: 'beta' });
      const windowObject = makeWindow(page.document, new Map([['beta', next.document]]));
      windowObject.setTimeout = setTimeout;
      windowObject.clearTimeout = clearTimeout;
      const requests = [];
      windowObject.fetch.mockImplementation((url, options) => new Promise((resolve) => requests.push({ url, options, resolve })));
      enhanceProjectsLiveFiltering(page.document);

      page.search.value = 'al';
      page.form.dispatch('input', { target: page.search });
      // A Search change event never navigates on its own.
      page.form.dispatch('change', { target: page.search });
      await vi.advanceTimersByTimeAsync(200);
      page.search.value = 'beta';
      page.form.dispatch('input', { target: page.search });
      expect(requests).toHaveLength(0);
      expect(projectsLiveSnapshot(page.document)).toMatchObject({ pending: true, requestedHistoryMode: 'push' });
      const intended = new URL(projectsLiveSnapshot(page.document).intendedUrl);
      expect(intended.searchParams.get('search')).toBe('beta');
      expect(intended.searchParams.getAll('project')).toEqual(['7', '12']);

      await vi.advanceTimersByTimeAsync(350);
      expect(requests).toHaveLength(1);
      const url = new URL(requests[0].url);
      expect(url.searchParams.get('search')).toBe('beta');
      expect(url.searchParams.getAll('project')).toEqual(['7', '12']);
      expect(url.search).not.toContain('7%2C12');
      expect(url.searchParams.has('page')).toBe(false);
      requests[0].resolve(responseFor(next, 'beta', requests[0].url));
      await flush();
      expect(windowObject.history.pushes.map((entry) => entry.url)).toEqual([requests[0].url]);
    });

    it('reports lifecycle phases to subscribers and navigates GET-only through the one engine', async () => {
      const page = makePage();
      selectProjects(page, [7, 12]);
      const next = makePage();
      const windowObject = makeWindow(page.document, new Map([['reset', next.document]]));
      const requests = [];
      windowObject.fetch.mockImplementation((url, options) => new Promise((resolve) => requests.push({ url, options, resolve })));
      enhanceProjectsLiveFiltering(page.document);
      const phases = [];
      const unsubscribe = subscribeProjectsLive(page.document, (detail) => phases.push(detail.phase));

      page.form.dispatch('change', { target: page.planned });
      const first = navigateProjectsLive(page.document, '/projects', { historyMode: 'push' });
      expect(first.status).toBe('started');
      expect(requests).toHaveLength(2);
      expect(requests[0].options.signal.aborted).toBe(true);
      expect(requests[1].options.method).toBe('GET');
      expect(requests[1].url).toBe('http://creatorcrate.test/projects');
      expect(navigateProjectsLive(page.document, '/asset-viewer').status).toBe('unavailable');

      requests[1].resolve(responseFor(next, 'reset', 'http://creatorcrate.test/projects?sort=title'));
      await flush();
      expect(phases).toEqual(['superseded', 'started', 'superseded', 'started', 'installed']);
      expect(projectsLiveSnapshot(page.document)).toMatchObject({
        pending: false,
        failed: false,
        intendedUrl: 'http://creatorcrate.test/projects?sort=title',
      });
      unsubscribe();
    });

    it('refreshes NSFW to a still-debounced Search with repeated Projects and the push it is owed', async () => {
      vi.useFakeTimers();
      const page = makePage({ search: '', nsfwEnabled: false });
      selectProjects(page, [7, 12]);
      const next = makePage({ search: 'needle', nsfwEnabled: true });
      const windowObject = makeWindow(page.document, new Map([['refreshed', next.document]]));
      windowObject.setTimeout = setTimeout;
      windowObject.clearTimeout = clearTimeout;
      const requests = [];
      windowObject.fetch.mockImplementation((url, options) => new Promise((resolve) => requests.push({ url, options, resolve })));
      enhanceProjectsLiveFiltering(page.document);

      page.search.value = 'needle';
      page.form.dispatch('input', { target: page.search });
      page.nsfw.form.dispatch('submit', { target: page.nsfw.toggle });
      expect(requests).toHaveLength(1);
      // The debounced Search is taken over by the refresh, never fired twice.
      await vi.advanceTimersByTimeAsync(1000);
      expect(requests).toHaveLength(1);

      requests[0].resolve(jsonResponse({ status: 'success', enabled: true }));
      await flush();
      expect(requests).toHaveLength(2);
      const refreshUrl = new URL(requests[1].url);
      expect(refreshUrl.searchParams.get('search')).toBe('needle');
      expect(refreshUrl.searchParams.getAll('project')).toEqual(['7', '12']);
      requests[1].resolve(responseFor(next, 'refreshed', requests[1].url));
      await flush();
      expect(windowObject.history.pushes.map((entry) => entry.url)).toEqual([requests[1].url]);
      expect(next.nsfw.toggle.getAttribute('aria-pressed')).toBe('true');
    });

    // F1: a toolbar Grid/List link rendered against the installed page must
    // apply its View to the newest intended filter state, not discard it.
    it('applies a toolbar View to a still-pending filter GET, keeps repeated Projects, and lets it win', async () => {
      const page = makePage({ view: 'grid' });
      selectProjects(page, [7, 12]);
      const stale = makePage({ view: 'grid' });
      const listed = makePage({ view: 'list' });
      const windowObject = makeWindow(page.document, new Map([
        ['stale', stale.document],
        ['listed', listed.document],
      ]));
      const shown = 'http://creatorcrate.test/projects';
      windowObject.setLocation(shown);
      const requests = [];
      windowObject.fetch.mockImplementation((url, options) => new Promise((resolve) => requests.push({ url, options, resolve })));
      const link = addLiveLink(page, 'view', '/projects?view=list');
      enhanceProjectsLiveFiltering(page.document);

      page.planned.checked = true;
      page.form.dispatch('change', { target: page.planned });
      expect(requests).toHaveLength(1);
      const pendingUrl = new URL(requests[0].url);
      expect(pendingUrl.searchParams.getAll('project')).toEqual(['7', '12']);
      expect(pendingUrl.searchParams.get('view')).toBe('grid');

      const event = link.dispatch('click', { button: 0 });
      expect(event.defaultPrevented).toBe(true);
      expect(requests).toHaveLength(2);
      expect(requests[0].options.signal.aborted).toBe(true);
      const viewUrl = new URL(requests[1].url);
      expect(viewUrl.searchParams.get('view')).toBe('list');
      expect(viewUrl.searchParams.getAll('project')).toEqual(['7', '12']);
      expect(viewUrl.searchParams.getAll('status')).toEqual(['ready', 'planned']);
      expect(viewUrl.searchParams.getAll('tag')).toEqual(['2', '3']);
      expect(viewUrl.searchParams.get('sort')).toBe('title');
      expect(viewUrl.searchParams.get('order')).toBe('asc');
      expect(viewUrl.search).not.toContain('%2C');
      expect(viewUrl.searchParams.has('page')).toBe(false);

      requests[1].resolve(responseFor(listed, 'listed', requests[1].url));
      await flush();
      // The superseded GET answers last and cannot steal the page.
      requests[0].resolve(responseFor(stale, 'stale', requests[0].url));
      await flush();
      expect(page.document.querySelector('[data-projects-live-region]')).toBe(listed.region);
      expect(windowObject.history.pushes.map((entry) => entry.url)).toEqual([requests[1].url]);
      expect(windowObject.location.href).toBe(requests[1].url);
    });

    it('applies a toolbar View to a debounced Search with repeated Projects and never fires the Search separately', async () => {
      vi.useFakeTimers();
      const page = makePage({ search: '', view: 'grid' });
      selectProjects(page, [7, 12]);
      const listed = makePage({ search: 'Alpha', view: 'list' });
      const windowObject = makeWindow(page.document, new Map([['listed', listed.document]]));
      windowObject.setTimeout = setTimeout;
      windowObject.clearTimeout = clearTimeout;
      windowObject.setLocation('http://creatorcrate.test/projects?project=7&project=12');
      const requests = [];
      windowObject.fetch.mockImplementation((url, options) => new Promise((resolve) => requests.push({ url, options, resolve })));
      const link = addLiveLink(page, 'view', '/projects?project=7&project=12&view=list');
      enhanceProjectsLiveFiltering(page.document);

      page.search.value = 'Alpha';
      page.form.dispatch('input', { target: page.search });
      expect(requests).toHaveLength(0);
      link.dispatch('click', { button: 0 });
      expect(requests).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(requests).toHaveLength(1);

      const viewUrl = new URL(requests[0].url);
      expect(viewUrl.searchParams.get('search')).toBe('Alpha');
      expect(viewUrl.searchParams.getAll('project')).toEqual(['7', '12']);
      expect(viewUrl.searchParams.get('view')).toBe('list');
      requests[0].resolve(responseFor(listed, 'listed', requests[0].url));
      await flush();
      expect(windowObject.history.pushes.map((entry) => entry.url)).toEqual([requests[0].url]);
    });

    it('applies a toolbar View to a failed filter request and keeps Retry GET-only', async () => {
      const page = makePage({ view: 'list' });
      selectProjects(page, [7]);
      const gridPage = makePage({ view: 'grid' });
      const windowObject = makeWindow(page.document, new Map([['grid', gridPage.document]]));
      windowObject.setLocation('http://creatorcrate.test/projects?view=list');
      const requests = [];
      windowObject.fetch.mockImplementation((url, options) => new Promise((resolve, reject) => requests.push({
        url, options, resolve, reject,
      })));
      const link = addLiveLink(page, 'view', '/projects');
      enhanceProjectsLiveFiltering(page.document);

      page.form.dispatch('change', { target: page.planned });
      requests[0].resolve({ ok: false, url: requests[0].url, text: vi.fn(async () => '') });
      await flush();
      expect(liveFailureNotice(page.document)).not.toBeNull();

      // The omitted-view Grid link keeps the server's implicit default View.
      link.dispatch('click', { button: 0 });
      expect(requests).toHaveLength(2);
      const viewUrl = new URL(requests[1].url);
      expect(viewUrl.searchParams.getAll('project')).toEqual(['7']);
      expect(viewUrl.searchParams.has('view')).toBe(false);
      expect(requests[1].options.method).toBe('GET');

      requests[1].reject(new Error('offline'));
      await flush();
      const [retry] = liveFailureRetries(page.document);
      retry.dispatch('click', { button: 0 });
      expect(requests).toHaveLength(3);
      expect(requests[2].url).toBe(requests[1].url);
      expect(requests.every((request) => request.options.method === 'GET')).toBe(true);
      requests[2].resolve(responseFor(gridPage, 'grid', requests[2].url));
      await flush();
      expect(page.document.querySelector('[data-projects-live-region]')).toBe(gridPage.region);
      expect(windowObject.history.pushes.map((entry) => entry.url)).toEqual([requests[2].url]);
    });

    it('keeps the rendered View link address on an idle page and syncs the dialog View control', async () => {
      const page = makePage({ view: 'grid' });
      const dropdown = makeNode({ tagName: 'details', attrs: { 'data-cc-dropdown': '' } });
      const gridRadio = makeNode({ tagName: 'input', attrs: { name: 'view', type: 'radio', value: 'grid' }, checked: true });
      const listRadio = makeNode({ tagName: 'input', attrs: { name: 'view', type: 'radio', value: 'list' } });
      dropdown.appendChild(gridRadio);
      dropdown.appendChild(listRadio);
      page.form.appendChild(dropdown);
      const windowObject = makeWindow(page.document);
      windowObject.setLocation('http://creatorcrate.test/projects?page=2');
      const requests = [];
      windowObject.fetch.mockImplementation((url, options) => new Promise((resolve) => requests.push({ url, options, resolve })));
      const link = addLiveLink(page, 'view', '/projects?page=2&view=list');
      enhanceProjectsLiveFiltering(page.document);

      link.dispatch('click', { button: 0 });
      expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe('http://creatorcrate.test/projects?page=2&view=list');
      expect(listRadio.checked).toBe(true);
      expect(gridRadio.checked).toBe(false);
    });

    it('collapses an owed push when the NSFW refresh returns the address already shown', async () => {
      const page = makePage({ search: '', nsfwEnabled: false });
      const next = makePage({ search: '', nsfwEnabled: true });
      const windowObject = makeWindow(page.document, new Map([['same', next.document]]));
      const shown = 'http://creatorcrate.test/projects?project=7&project=12';
      windowObject.setLocation(shown);
      const requests = [];
      windowObject.fetch.mockImplementation((url, options) => new Promise((resolve) => requests.push({ url, options, resolve })));
      enhanceProjectsLiveFiltering(page.document);

      // A pending push whose canonical answer is the shown address.
      page.form.dispatch('change', { target: page.planned });
      page.nsfw.form.dispatch('submit', { target: page.nsfw.toggle });
      requests[1].resolve(jsonResponse({ status: 'success', enabled: true }));
      await flush();
      requests[2].resolve(responseFor(next, 'same', shown));
      await flush();
      expect(windowObject.history.pushes).toHaveLength(0);
      expect(page.document.querySelector('[data-projects-live-region]')).toBe(next.region);
    });
  });

  // WP10b F6: a push whose FINAL canonical address is the one shown at
  // installation adds no history entry; any other final address still does.
  describe('WP10b F6 same-address history', () => {
    const SHOWN = 'http://creatorcrate.test/projects';

    function f6Page(extraPages = {}) {
      const page = makePage({ view: 'grid' });
      const pages = new Map(Object.entries(extraPages).map(([key, value]) => [key, value.document]));
      const windowObject = makeWindow(page.document, pages);
      windowObject.setLocation(SHOWN);
      windowObject.location.assign = vi.fn();
      const requests = [];
      windowObject.fetch.mockImplementation((url, options) => new Promise((resolve) => requests.push({ url, options, resolve })));
      return { page, windowObject, requests };
    }

    it('List held, then Grid back to the shown address: no entry, and the late List never installs', async () => {
      const gridded = makePage({ view: 'grid' });
      const listed = makePage({ view: 'list' });
      const { page, windowObject, requests } = f6Page({ gridded, listed });
      const list = addLiveLink(page, 'view', '/projects?view=list');
      const grid = addLiveLink(page, 'view', '/projects');
      enhanceProjectsLiveFiltering(page.document);

      list.dispatch('click', { button: 0 });
      grid.dispatch('click', { button: 0 });
      expect(requests).toHaveLength(2);
      expect(requests[0].options.signal.aborted).toBe(true);
      expect(requests[1].url).toBe(SHOWN);
      requests[1].resolve(responseFor(gridded, 'gridded', SHOWN));
      await flush();
      requests[0].resolve(responseFor(listed, 'listed', 'http://creatorcrate.test/projects?view=list'));
      await flush();

      expect(page.document.querySelector('[data-projects-live-region]')).toBe(gridded.region);
      expect(windowObject.history.pushes).toEqual([]);
      expect(windowObject.history.replaces).toEqual([]);
      expect(windowObject.location.href).toBe(SHOWN);
      expect(windowObject.location.assign).not.toHaveBeenCalled();
    });

    it('a genuinely different View is still one push', async () => {
      const listed = makePage({ view: 'list' });
      const { page, windowObject, requests } = f6Page({ listed });
      const list = addLiveLink(page, 'view', '/projects?view=list');
      enhanceProjectsLiveFiltering(page.document);

      list.dispatch('click', { button: 0 });
      requests[0].resolve(responseFor(listed, 'listed', requests[0].url));
      await flush();
      expect(windowObject.history.pushes.map((entry) => entry.url)).toEqual(['http://creatorcrate.test/projects?view=list']);
      expect(windowObject.history.replaces).toEqual([]);
    });

    it('compares the final (redirected) address, not the request, in both directions', async () => {
      const same = makePage();
      const sorted = makePage();
      const { page, windowObject, requests } = f6Page({ same, sorted });
      enhanceProjectsLiveFiltering(page.document);

      // A different request redirected to the shown address: reconciled.
      navigateProjectsLive(page.document, '/projects?resetFilters=1');
      requests[0].resolve(responseFor(same, 'same', SHOWN));
      await flush();
      expect(page.document.querySelector('[data-projects-live-region]')).toBe(same.region);
      expect(windowObject.history.pushes).toEqual([]);

      // The shown address requested, canonicalized elsewhere: a real entry.
      const canonical = 'http://creatorcrate.test/projects?sort=title&order=asc';
      navigateProjectsLive(page.document, SHOWN);
      requests[1].resolve(responseFor(sorted, 'sorted', canonical));
      await flush();
      expect(page.document.querySelector('[data-projects-live-region]')).toBe(sorted.region);
      expect(windowObject.history.pushes.map((entry) => entry.url)).toEqual([canonical]);
      expect(windowObject.location.href).toBe(canonical);
    });

    it('keeps exact query semantics: explicit neutral values, order and repeated Projects are distinct', async () => {
      const explicit = makePage();
      const repeated = makePage();
      const reordered = makePage();
      const { page, windowObject, requests } = f6Page({ explicit, repeated, reordered });
      enhanceProjectsLiveFiltering(page.document);

      const explicitGrid = 'http://creatorcrate.test/projects?view=grid';
      const sevenTwelve = 'http://creatorcrate.test/projects?project=7&project=12';
      const twelveSeven = 'http://creatorcrate.test/projects?project=12&project=7';
      navigateProjectsLive(page.document, explicitGrid);
      requests[0].resolve(responseFor(explicit, 'explicit', explicitGrid));
      await flush();
      navigateProjectsLive(page.document, sevenTwelve);
      requests[1].resolve(responseFor(repeated, 'repeated', sevenTwelve));
      await flush();
      navigateProjectsLive(page.document, twelveSeven);
      requests[2].resolve(responseFor(reordered, 'reordered', twelveSeven));
      await flush();

      expect(windowObject.history.pushes.map((entry) => entry.url)).toEqual([explicitGrid, sevenTwelve, twelveSeven]);
      expect(new URL(windowObject.location.href).searchParams.getAll('project')).toEqual(['12', '7']);
    });

    it('keeps replace (Back/Forward) ownership and never turns it into a push', async () => {
      const restored = makePage();
      const { page, windowObject, requests } = f6Page({ restored });
      enhanceProjectsLiveFiltering(page.document);
      windowObject.setLocation('http://creatorcrate.test/projects?view=list');
      windowObject.dispatch('popstate');
      requests[0].resolve(responseFor(restored, 'restored', 'http://creatorcrate.test/projects?view=list'));
      await flush();
      expect(windowObject.history.pushes).toEqual([]);
      expect(windowObject.history.replaces).toEqual([]);
      expect(page.document.querySelector('[data-projects-live-region]')).toBe(restored.region);
    });

    it('a failed push retried GET-only to the shown address adds no entry; a different one adds one', async () => {
      const recovered = makePage();
      const listed = makePage({ view: 'list' });
      const { page, windowObject, requests } = f6Page({ recovered, listed });
      enhanceProjectsLiveFiltering(page.document);

      navigateProjectsLive(page.document, '/projects?resetFilters=1');
      requests[0].resolve({ ok: false, status: 500, url: SHOWN, text: async () => '' });
      await flush();
      expect(liveFailureNotice(page.document)).toBeTruthy();
      expect(windowObject.history.pushes).toEqual([]);
      liveFailureRetries(page.document)[0].dispatch('click');
      expect(requests).toHaveLength(2);
      expect(requests[1].url).toBe('http://creatorcrate.test/projects?resetFilters=1');
      requests[1].resolve(responseFor(recovered, 'recovered', SHOWN));
      await flush();
      expect(page.document.querySelector('[data-projects-live-region]')).toBe(recovered.region);
      expect(liveFailureNotice(page.document)).toBeFalsy();
      expect(windowObject.history.pushes).toEqual([]);

      navigateProjectsLive(page.document, '/projects?view=list');
      requests[2].resolve({ ok: false, status: 500, url: requests[2].url, text: async () => '' });
      await flush();
      liveFailureRetries(page.document)[0].dispatch('click');
      requests[3].resolve(responseFor(listed, 'listed', 'http://creatorcrate.test/projects?view=list'));
      await flush();
      expect(windowObject.history.pushes.map((entry) => entry.url)).toEqual(['http://creatorcrate.test/projects?view=list']);
      expect(windowObject.location.assign).not.toHaveBeenCalled();
    });
  });

  it('restores the existing state and announces an error when the NSFW POST fails', async () => {
    const page = makePage({ nsfwEnabled: false });
    const windowObject = makeWindow(page.document);
    windowObject.fetch.mockResolvedValue(jsonResponse({ status: 'error' }, false));
    enhanceProjectsLiveFiltering(page.document);

    page.nsfw.form.dispatch('submit', { target: page.nsfw.toggle });
    await flush();

    expect(windowObject.fetch).toHaveBeenCalledTimes(1);
    expect(page.nsfw.toggle.getAttribute('aria-pressed')).toBe('false');
    expect(page.nsfw.toggle.disabled).toBe(false);
    expect(page.status.textContent).toContain('Could not update the NSFW filter');
    expect(page.form.submit).not.toHaveBeenCalled();
  });
});

// F8: a toolbar Grid/List click while Projects Reset filters (a default
// navigation: bare GET /projects, resolved by the server from the saved
// defaults) is in flight is that Reset's View, never a reason to abandon it.
describe('Projects F8 pending Reset filters + toolbar View', () => {
  const BASE = 'http://creatorcrate.test';
  const TEMPORARY = `${BASE}/projects?search=F8&status=ready&project=7&project=12`;
  const RESTORED = `${BASE}/projects?status=planned&status=ready&tag=2&tag=3&sort=title`;

  function f8Page(extraPages = {}) {
    const page = makePage({ view: 'grid' });
    const pages = new Map(Object.entries(extraPages).map(([key, value]) => [key, value.document]));
    const windowObject = makeWindow(page.document, pages);
    windowObject.setLocation(TEMPORARY);
    windowObject.location.assign = vi.fn();
    const requests = [];
    windowObject.fetch.mockImplementation((url, options) => new Promise((resolve, reject) => requests.push({
      url, options, resolve, reject,
    })));
    const list = addLiveLink(page, 'view', '/projects?search=F8&status=ready&project=7&project=12&view=list');
    const grid = addLiveLink(page, 'view', '/projects?search=F8&status=ready&project=7&project=12');
    enhanceProjectsLiveFiltering(page.document);
    const phases = [];
    subscribeProjectsLive(page.document, (detail) => phases.push(`${detail.phase}:${detail.generation}`));
    return { page, windowObject, requests, list, grid, phases };
  }

  function startReset(page) {
    const outcome = navigateProjectsLive(page.document, '/projects', { historyMode: 'push' });
    expect(outcome.status).toBe('started');
    return outcome.generation;
  }

  const region = (page) => page.document.querySelector('[data-projects-live-region]');

  it('absorbs List into the pending Reset, then continues at the restored address with only view replaced', async () => {
    const listed = makePage({ view: 'list' });
    const { page, windowObject, requests, list, phases } = f8Page({ listed });
    const generation = startReset(page);
    expect(requests.map((request) => request.url)).toEqual([`${BASE}/projects`]);

    const event = list.dispatch('click', { button: 0 });
    expect(event.defaultPrevented).toBe(true);
    // Nothing superseded, nothing sent: the Reset still owns the results.
    expect(requests).toHaveLength(1);
    expect(requests[0].options.signal.aborted).toBe(false);

    const reset = responseFor(listed, 'unused', RESTORED);
    requests[0].resolve(reset);
    await flush();
    expect(reset.text).not.toHaveBeenCalled();
    expect(requests).toHaveLength(2);
    const continuation = new URL(requests[1].url);
    // Repeated values stay repeated; only `view` is added.
    expect(continuation.searchParams.getAll('status')).toEqual(['planned', 'ready']);
    expect(continuation.searchParams.getAll('tag')).toEqual(['2', '3']);
    expect(continuation.searchParams.get('sort')).toBe('title');
    expect(continuation.searchParams.get('view')).toBe('list');
    expect(continuation.searchParams.has('project')).toBe(false);
    expect(continuation.searchParams.has('search')).toBe(false);
    expect(requests[1].url).not.toContain('%2C');
    expect(requests[1].options.method).toBe('GET');

    requests[1].resolve(responseFor(listed, 'listed', requests[1].url));
    await flush();
    expect(region(page)).toBe(listed.region);
    expect(windowObject.history.pushes.map((entry) => entry.url)).toEqual([requests[1].url]);
    expect(windowObject.history.replaces).toEqual([]);
    expect(windowObject.location.assign).not.toHaveBeenCalled();
    // One Reset lifecycle: same generation throughout, never superseded.
    expect(phases.filter((phase) => phase.endsWith(`:${generation}`)))
      .toEqual([`started:${generation}`, `started:${generation}`, `installed:${generation}`]);
  });

  it('latest of rapid choices wins; Grid on an address that omits view needs no follow-up GET', async () => {
    const gridded = makePage({ view: 'grid' });
    const { page, windowObject, requests, list, grid } = f8Page({ gridded });
    startReset(page);
    list.dispatch('click', { button: 0 });
    grid.dispatch('click', { button: 0 });
    list.dispatch('click', { button: 0 });
    grid.dispatch('click', { button: 0 });
    expect(requests).toHaveLength(1);
    requests[0].resolve(responseFor(gridded, 'gridded', RESTORED));
    await flush();
    expect(requests).toHaveLength(1);
    expect(region(page)).toBe(gridded.region);
    expect(windowObject.history.pushes.map((entry) => entry.url)).toEqual([RESTORED]);
  });

  it('replaces a restored saved View: saved List + Grid click continues with view=grid', async () => {
    const gridded = makePage({ view: 'grid' });
    const { page, requests, grid } = f8Page({ gridded });
    startReset(page);
    grid.dispatch('click', { button: 0 });
    requests[0].resolve(responseFor(gridded, 'unused', `${BASE}/projects?status=planned&view=list`));
    await flush();
    expect(requests.map((request) => request.url))
      .toEqual([`${BASE}/projects`, `${BASE}/projects?status=planned&view=grid`]);
  });

  it('no saved defaults: the bare address continues to ?view=list', async () => {
    const listed = makePage({ view: 'list' });
    const { page, requests, list } = f8Page({ listed });
    startReset(page);
    list.dispatch('click', { button: 0 });
    requests[0].resolve(responseFor(listed, 'unused', `${BASE}/projects`));
    await flush();
    expect(requests.map((request) => request.url)).toEqual([`${BASE}/projects`, `${BASE}/projects?view=list`]);
  });

  it('a View click during the follow-up GET supersedes it at the restored address; the late follow-up never installs', async () => {
    const listed = makePage({ view: 'list' });
    const gridded = makePage({ view: 'grid' });
    const { page, windowObject, requests, list, grid } = f8Page({ listed, gridded });
    startReset(page);
    list.dispatch('click', { button: 0 });
    requests[0].resolve(responseFor(listed, 'unused', RESTORED));
    await flush();
    expect(requests).toHaveLength(2);
    grid.dispatch('click', { button: 0 });
    expect(requests).toHaveLength(3);
    expect(requests[1].options.signal.aborted).toBe(true);
    // The Grid link omits view: the restored address as the server gave it.
    expect(requests[2].url).toBe(RESTORED);
    requests[2].resolve(responseFor(gridded, 'gridded', RESTORED));
    await flush();
    requests[1].resolve(responseFor(listed, 'listed', requests[1].url));
    await flush();
    expect(region(page)).toBe(gridded.region);
    expect(windowObject.history.pushes.map((entry) => entry.url)).toEqual([RESTORED]);
    expect(requests).toHaveLength(3);
  });

  it('failed Reset GET: no install; a View click or Retry repeats the Reset GET-only with the latest View', async () => {
    const listed = makePage({ view: 'list' });
    const { page, windowObject, requests, list } = f8Page({ listed });
    const before = region(page);
    startReset(page);
    list.dispatch('click', { button: 0 });
    requests[0].resolve({ ok: false, url: `${BASE}/projects`, text: vi.fn(async () => '') });
    await flush();
    expect(liveFailureNotice(page.document)).not.toBeNull();
    expect(region(page)).toBe(before);
    expect(windowObject.location.href).toBe(TEMPORARY);

    const [retry] = liveFailureRetries(page.document);
    retry.dispatch('click', { button: 0 });
    expect(requests.map((request) => request.url)).toEqual([`${BASE}/projects`, `${BASE}/projects`]);
    requests[1].reject(new Error('offline'));
    await flush();

    // A View click on the failed Reset re-requests the Reset itself.
    list.dispatch('click', { button: 0 });
    expect(requests.map((request) => request.url)).toEqual([`${BASE}/projects`, `${BASE}/projects`, `${BASE}/projects`]);
    requests[2].resolve(responseFor(listed, 'unused', RESTORED));
    await flush();
    expect(new URL(requests[3].url).searchParams.get('view')).toBe('list');
    requests[3].resolve(responseFor(listed, 'listed', requests[3].url));
    await flush();
    expect(region(page)).toBe(listed.region);
    expect(windowObject.history.pushes.map((entry) => entry.url)).toEqual([requests[3].url]);
    expect(requests.every((request) => request.options.method === 'GET')).toBe(true);
  });

  it('failed follow-up GET: no install; Retry resolves the Reset again and re-applies the View', async () => {
    const listed = makePage({ view: 'list' });
    const { page, windowObject, requests, list } = f8Page({ listed });
    const before = region(page);
    startReset(page);
    list.dispatch('click', { button: 0 });
    requests[0].resolve(responseFor(listed, 'unused', RESTORED));
    await flush();
    requests[1].resolve({ ok: false, url: requests[1].url, text: vi.fn(async () => '') });
    await flush();
    expect(liveFailureNotice(page.document)).not.toBeNull();
    expect(region(page)).toBe(before);
    expect(windowObject.history.pushes).toEqual([]);
    expect(projectsLiveSnapshot(page.document).failedUrl).toBe(`${BASE}/projects`);

    const [retry] = liveFailureRetries(page.document);
    retry.dispatch('click', { button: 0 });
    expect(requests[2].url).toBe(`${BASE}/projects`);
    requests[2].resolve(responseFor(listed, 'unused', RESTORED));
    await flush();
    expect(new URL(requests[3].url).searchParams.get('view')).toBe('list');
    requests[3].resolve(responseFor(listed, 'listed', requests[3].url));
    await flush();
    expect(region(page)).toBe(listed.region);
    expect(windowObject.history.pushes.map((entry) => entry.url)).toEqual([requests[3].url]);
    expect(requests.every((request) => request.options.method === 'GET')).toBe(true);
  });

  it('a newer filter edit owns the page: the late Reset installs nothing and its View is dropped', async () => {
    const edited = makePage({ view: 'grid' });
    const reset = makePage({ view: 'grid' });
    const { page, windowObject, requests, list } = f8Page({ edited, reset });
    startReset(page);
    list.dispatch('click', { button: 0 });
    page.form.dispatch('change', { target: page.planned });
    expect(requests).toHaveLength(2);
    expect(requests[0].options.signal.aborted).toBe(true);
    const editUrl = requests[1].url;
    requests[1].resolve(responseFor(edited, 'edited', editUrl));
    await flush();
    requests[0].resolve(responseFor(reset, 'reset', RESTORED));
    await flush();
    expect(requests).toHaveLength(2);
    expect(region(page)).toBe(edited.region);
    expect(windowObject.location.href).toBe(editUrl);

    // A later Reset carries no stale View.
    startReset(page);
    requests[2].resolve(responseFor(reset, 'reset', RESTORED));
    await flush();
    expect(requests).toHaveLength(3);
    expect(region(page)).toBe(reset.region);
  });

  it('a new Reset drops the earlier Reset View; Back/Forward to a default navigation does too', async () => {
    const reset = makePage({ view: 'grid' });
    const popped = makePage({ view: 'grid' });
    const { page, windowObject, requests, list } = f8Page({ reset, popped });
    startReset(page);
    list.dispatch('click', { button: 0 });
    startReset(page);
    expect(requests[0].options.signal.aborted).toBe(true);
    requests[1].resolve(responseFor(reset, 'reset', RESTORED));
    await flush();
    expect(requests).toHaveLength(2);
    expect(region(page)).toBe(reset.region);

    startReset(page);
    list.dispatch('click', { button: 0 });
    windowObject.setLocation(`${BASE}/projects`);
    windowObject.dispatch('popstate');
    expect(requests).toHaveLength(4);
    expect(requests[2].options.signal.aborted).toBe(true);
    requests[3].resolve(responseFor(popped, 'popped', RESTORED));
    await flush();
    expect(requests).toHaveLength(4);
    expect(region(page)).toBe(popped.region);
    expect(windowObject.history.replaces.map((entry) => entry.url)).toEqual([RESTORED]);
  });

  it('pagination during a pending Reset is newer intent and is not absorbed', async () => {
    const paged = makePage({ view: 'grid' });
    const { page, requests, list } = f8Page({ paged });
    const next = addLiveLink(page, 'pagination', '/projects?status=ready&page=2');
    enhanceProjectsLiveFiltering(page.document);
    startReset(page);
    list.dispatch('click', { button: 0 });
    next.dispatch('click', { button: 0 });
    expect(requests).toHaveLength(2);
    expect(requests[0].options.signal.aborted).toBe(true);
    expect(requests[1].url).toBe(`${BASE}/projects?status=ready&page=2`);
    requests[1].resolve(responseFor(paged, 'paged', requests[1].url));
    await flush();
    expect(requests).toHaveLength(2);
  });

  it('an NSFW refresh during a pending Reset + View re-requests the Reset and still applies the View', async () => {
    const listed = makePage({ view: 'list', nsfwEnabled: true });
    const { page, windowObject, requests, list } = f8Page({ listed });
    startReset(page);
    list.dispatch('click', { button: 0 });
    page.nsfw.form.dispatch('submit', { target: page.nsfw.toggle });
    expect(requests).toHaveLength(2);
    expect(requests[0].options.signal.aborted).toBe(true);
    requests[1].resolve(jsonResponse({ status: 'success', enabled: true }));
    await flush();
    expect(requests[2].url).toBe(`${BASE}/projects`);
    requests[2].resolve(responseFor(listed, 'unused', RESTORED));
    await flush();
    expect(new URL(requests[3].url).searchParams.get('view')).toBe('list');
    requests[3].resolve(responseFor(listed, 'listed', requests[3].url));
    await flush();
    expect(region(page)).toBe(listed.region);
    expect(windowObject.history.pushes.map((entry) => entry.url)).toEqual([requests[3].url]);
    expect(listed.nsfw.toggle.disabled).toBe(false);
  });

  it('an NSFW refresh after a failed follow-up retries the Reset with the push it still owes', async () => {
    const listed = makePage({ view: 'list', nsfwEnabled: true });
    const { page, windowObject, requests, list } = f8Page({ listed });
    startReset(page);
    list.dispatch('click', { button: 0 });
    requests[0].resolve(responseFor(listed, 'unused', RESTORED));
    await flush();
    requests[1].reject(new Error('offline'));
    await flush();
    page.nsfw.form.dispatch('submit', { target: page.nsfw.toggle });
    requests[2].resolve(jsonResponse({ status: 'success', enabled: true }));
    await flush();
    expect(requests[3].url).toBe(`${BASE}/projects`);
    requests[3].resolve(responseFor(listed, 'unused', RESTORED));
    await flush();
    expect(new URL(requests[4].url).searchParams.get('view')).toBe('list');
    requests[4].resolve(responseFor(listed, 'listed', requests[4].url));
    await flush();
    expect(windowObject.history.pushes.map((entry) => entry.url)).toEqual([requests[4].url]);
  });
});

describe('R2 Projects Grid style visibility follows the radio View', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const gridUrl = 'http://creatorcrate.test/projects?view=grid';
  const listUrl = 'http://creatorcrate.test/projects?view=list';

  it('keeps the server-rendered initial state for Grid and List', () => {
    const grid = makePage({ viewRadios: 'grid' });
    makeWindow(grid.document);
    enhanceProjectsLiveFiltering(grid.document);
    expect(grid.gridStyleField.hidden).toBe(false);

    const list = makePage({ viewRadios: 'list' });
    makeWindow(list.document);
    enhanceProjectsLiveFiltering(list.document);
    expect(list.gridStyleField.hidden).toBe(true);
  });

  it('hides on a dialog List choice before the GET answers, restores on Grid, and keeps the Grid style value', async () => {
    const initial = makePage({ viewRadios: 'grid', gridStyle: 'cropped' });
    const windowObject = makeWindow(initial.document);
    windowObject.fetch.mockImplementation(() => new Promise(() => {}));
    enhanceProjectsLiveFiltering(initial.document);
    const select = initial.gridStyleSelect;

    initial.viewGrid.checked = false;
    initial.viewList.checked = true;
    initial.form.dispatch('change', { target: initial.viewList });
    expect(initial.gridStyleField.hidden).toBe(true);
    expect(initial.form.contains(select)).toBe(true);
    expect(select.disabled).toBe(false);
    expect(select.value).toBe('cropped');

    initial.viewList.checked = false;
    initial.viewGrid.checked = true;
    initial.form.dispatch('change', { target: initial.viewGrid });
    expect(initial.gridStyleField.hidden).toBe(false);
    expect(select.value).toBe('cropped');
    await flush();
    // Only the ordinary GETs were requested; visibility schedules nothing.
    windowObject.fetch.mock.calls.forEach(([url, options]) => {
      expect(options?.method || 'GET').toBe('GET');
      expect(new URL(url).pathname).toBe('/projects');
    });
  });

  it('closes an open Grid style disclosure and moves focus to the View summary when List hides it', () => {
    const initial = makePage({ viewRadios: 'grid' });
    const windowObject = makeWindow(initial.document);
    windowObject.fetch.mockImplementation(() => new Promise(() => {}));
    enhanceProjectsLiveFiltering(initial.document);
    initial.gridStyleDropdown.open = true;
    initial.gridStyleDropdown.setAttribute('open', '');
    initial.gridStyleSummary.focus();

    initial.viewGrid.checked = false;
    initial.viewList.checked = true;
    initial.form.dispatch('change', { target: initial.viewList });

    expect(initial.gridStyleField.hidden).toBe(true);
    expect(initial.gridStyleDropdown.open).toBe(false);
    expect(initial.gridStyleDropdown.hasAttribute('open')).toBe(false);
    expect(initial.document.activeElement).toBe(initial.viewSummary);

    initial.viewList.checked = false;
    initial.viewGrid.checked = true;
    initial.form.dispatch('change', { target: initial.viewGrid });
    expect(initial.gridStyleField.hidden).toBe(false);
    expect(initial.gridStyleDropdown.open).toBe(false);
  });

  it('follows a toolbar View link that synchronizes the radio without a change event', async () => {
    const initial = makePage({ viewRadios: 'grid' });
    const next = makePage({ viewRadios: 'list' });
    const windowObject = makeWindow(initial.document, new Map([['next', next.document]]));
    let resolve;
    windowObject.fetch.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const link = addLiveLink(initial, 'view', '/projects?view=list');
    enhanceProjectsLiveFiltering(initial.document);

    link.dispatch('click', { button: 0 });
    expect(initial.viewList.checked).toBe(true);
    expect(initial.gridStyleField.hidden).toBe(true);

    resolve(responseFor(next, 'next', listUrl));
    await flush();
    expect(initial.form.contains(next.gridStyleField)).toBe(true);
    expect(next.gridStyleField.hidden).toBe(true);
  });

  it('reconciled form children follow the installed View, and a stale older response never installs', async () => {
    const initial = makePage({ viewRadios: 'grid' });
    const listPage = makePage({ viewRadios: 'list' });
    const gridPage = makePage({ viewRadios: 'grid' });
    const pages = new Map([['list', listPage.document], ['grid', gridPage.document]]);
    const windowObject = makeWindow(initial.document, pages);
    const requests = [];
    windowObject.fetch.mockImplementation((url, options) => new Promise((resolve) => requests.push({ url, options, resolve })));
    enhanceProjectsLiveFiltering(initial.document);

    initial.viewGrid.checked = false;
    initial.viewList.checked = true;
    initial.form.dispatch('change', { target: initial.viewList });
    expect(initial.gridStyleField.hidden).toBe(true);
    initial.viewList.checked = false;
    initial.viewGrid.checked = true;
    initial.form.dispatch('change', { target: initial.viewGrid });
    expect(initial.gridStyleField.hidden).toBe(false);
    expect(requests).toHaveLength(2);
    expect(requests[0].options.signal.aborted).toBe(true);

    requests[1].resolve(responseFor(gridPage, 'grid', gridUrl));
    await flush();
    expect(initial.form.contains(gridPage.gridStyleField)).toBe(true);
    expect(gridPage.gridStyleField.hidden).toBe(false);

    // The older List response arrives last and is ignored.
    requests[0].resolve(responseFor(listPage, 'list', listUrl));
    await flush();
    expect(initial.form.contains(listPage.gridStyleField)).toBe(false);
    expect(gridPage.gridStyleField.hidden).toBe(false);
    expect(windowObject.location.href).toBe(gridUrl);
  });

  it('a failed GET keeps the intended View and its visibility', async () => {
    const initial = makePage({ viewRadios: 'grid' });
    const windowObject = makeWindow(initial.document);
    windowObject.fetch.mockRejectedValue(new Error('offline'));
    enhanceProjectsLiveFiltering(initial.document);

    initial.viewGrid.checked = false;
    initial.viewList.checked = true;
    initial.form.dispatch('change', { target: initial.viewList });
    await flush();

    expect(liveFailureNotice(initial.document)).not.toBeNull();
    expect(initial.viewList.checked).toBe(true);
    expect(initial.gridStyleField.hidden).toBe(true);
    expect(windowObject.history.pushes).toHaveLength(0);
  });
});
