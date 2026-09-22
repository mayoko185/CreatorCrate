import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  enhanceProjectsDefaultsFetchSave,
  enhanceProjectsLiveFiltering,
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

  const page = add({ name: 'page', type: 'hidden' }, '4');
  const view = add({ name: 'view', type: 'hidden' }, values.view || 'list');
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
  };
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

  it('falls back without mutating history after a failed request, then recovers through a replacement', async () => {
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

    expect(failedPage.form.submit).toHaveBeenCalledTimes(1);
    expect(failedPage.document.querySelector('[data-projects-live-region]')).toBe(failedPage.region);
    expect(failedPage.region.getAttribute('aria-busy')).toBeNull();
    expect(failedPage.region.getAttribute('data-projects-live-state')).toBe('error');
    expect(failedPage.status.textContent).toBe('Projects are loading as a full page.');
    expect(failedWindow.history.pushes).toHaveLength(0);
    expect(failedWindow.history.replaces).toHaveLength(0);

    failedPage.planned.checked = true;
    failedPage.form.dispatch('change', { target: failedPage.planned });
    await flush();

    expect(failedWindow.fetch).toHaveBeenCalledTimes(2);
    expect(failedPage.document.querySelector('[data-projects-live-region]')).toBe(recoveredPage.region);
    expect(failedWindow.history.pushes).toEqual([
      expect.objectContaining({
        url: 'http://creatorcrate.test/projects?status=ready&status=planned&tag=2&tag=3&sort=title&order=asc&view=list',
      }),
    ]);
  });

  it('submits the NSFW state asynchronously, replaces the server-rendered region, and keeps history unchanged', async () => {
    const initial = makePage({ nsfwEnabled: false });
    const next = makePage({ nsfwEnabled: true });
    const pages = new Map([['nsfw-enabled', next.document]]);
    const windowObject = makeWindow(initial.document, pages);
    windowObject.fetch
      .mockResolvedValueOnce(jsonResponse({ status: 'success', enabled: true }))
      .mockResolvedValueOnce(responseFor(next, 'nsfw-enabled', 'http://creatorcrate.test/projects?page=4'));

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
    expect(windowObject.fetch.mock.calls[1][0]).toBe('http://creatorcrate.test/projects?page=4&view=list&status=ready&tag=2&tag=3&sort=title&order=asc');
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
