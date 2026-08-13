import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  enhanceProjectGridSize,
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

        const tag = candidate.match(/^[a-z][\w-]*/i)?.[0];
        if (tag && this.tagName !== tag.toUpperCase()) return false;
        const attrsInSelector = [...candidate.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)];
        return attrsInSelector.every(([, name, expected]) => {
          const actual = this.getAttribute(name);
          return actual !== null && (expected === undefined || actual === expected);
        });
      });
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
      this.listeners.filter((listener) => listener.type === type)
        .forEach((listener) => listener.handler(event));
      return event;
    },
  };

  Object.entries(attrs).forEach(([name, rawValue]) => node.setAttribute(name, rawValue));
  if (checked) node.checked = true;
  return node;
}

function makeForm(fields) {
  const form = makeNode({ tagName: 'form', attrs: { id: 'project-filters' } });
  form.submit = vi.fn();
  fields.forEach((field) => form.appendChild(field));
  return form;
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

  const search = add({ id: 'project-search', name: 'search', type: 'search', 'data-projects-search': '' }, values.search || '');
  const page = add({ name: 'page', type: 'hidden' }, '4');
  const view = add({ name: 'view', type: 'hidden' }, values.view || 'list');
  const project = add({ name: 'project', type: 'radio' }, String(values.project || ''), values.project !== undefined);
  const ready = add({ name: 'status', type: 'checkbox', value: 'ready' }, 'ready', values.statuses?.includes('ready') ?? true);
  const planned = add({ name: 'status', type: 'checkbox', value: 'planned' }, 'planned', values.statuses?.includes('planned') ?? false);
  const firstTag = add({ name: 'tag', type: 'checkbox', value: '2' }, '2', values.tags?.includes('2') ?? true);
  const secondTag = add({ name: 'tag', type: 'checkbox', value: '3' }, '3', values.tags?.includes('3') ?? true);
  const sort = add({ name: 'sort', type: 'radio', value: 'title' }, 'title', values.sort !== undefined ? values.sort === 'title' : true);
  const order = add({ name: 'order', type: 'radio', value: 'asc' }, 'asc', values.order !== undefined ? values.order === 'asc' : true);
  const form = makeForm(fields);
  const nsfw = makeNsfwForm(values.nsfwEnabled === true);
  const image = makeNode({
    tagName: 'img',
    attrs: { class: values.nsfwEnabled === true ? 'project-image--nsfw-blurred' : '' },
  });
  region.appendChild(status);
  region.appendChild(form);
  region.appendChild(nsfw.form);
  region.appendChild(image);
  document.appendChild(region);

  return {
    document,
    region,
    status,
    form,
    search,
    page,
    view,
    project,
    ready,
    planned,
    firstTag,
    secondTag,
    sort,
    order,
    nsfw,
    image,
  };
}

function addProjectGridSizeControls(page) {
  const displayControls = makeNode({ attrs: { 'data-project-grid-size-controls': '' } });
  const group = makeNode({
    attrs: {
      'data-asset-grid-size-controls': '',
      'data-grid-size-labels-interactive': '',
    },
  });
  const slider = makeNode({ tagName: 'input', attrs: { 'data-grid-size-slider': '', type: 'range' }, value: '2' });
  const labels = ['compact', 'default', 'large'].map((size) => {
    const label = makeNode({ tagName: 'button', attrs: { 'data-grid-size-option-label': size } });
    label.classList = {
      values: new Set(),
      toggle(name, force) {
        if (force) this.values.add(name);
        else this.values.delete(name);
      },
    };
    return label;
  });
  const grid = makeNode({ tagName: 'ul', attrs: { class: 'project-grid' } });
  grid.style = {
    values: {},
    setProperty(name, value) { this.values[name] = value; },
    removeProperty(name) { delete this.values[name]; },
  };

  group.appendChild(slider);
  labels.forEach((label) => group.appendChild(label));
  displayControls.appendChild(group);
  page.region.appendChild(displayControls);
  page.region.appendChild(grid);
  return { displayControls, group, slider, labels, grid };
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
    const initial = makePage({ project: 7 });
    const next = makePage({ project: 7, statuses: ['ready', 'planned'], tags: ['2', '3'] });
    const pages = new Map([['next', next.document]]);
    const windowObject = makeWindow(initial.document, pages);
    const responseUrl = 'http://creatorcrate.test/projects?status=ready&status=planned&tag=2&tag=3&project=7&sort=title&order=asc&view=list';
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
    expect(requested.searchParams.getAll('tag')).toEqual(['2', '3']);
    expect(requested.searchParams.get('project')).toBe('7');
    expect(requested.searchParams.get('view')).toBe('list');
    expect(requested.searchParams.has('page')).toBe(false);
    expect(windowObject.history.pushes).toHaveLength(1);
    expect(windowObject.history.pushes[0].url).toBe(responseUrl);
    expect(windowObject.location.href).toBe(responseUrl);
    expect(initial.form.submit).not.toHaveBeenCalled();
    expect(initial.document.activeElement?.name).toBe('status');
    expect(initial.document.activeElement?.value).toBe('planned');
  });

  it('debounces search and restores focus after replacing the server-rendered region', async () => {
    vi.useFakeTimers();
    const initial = makePage();
    const next = makePage({ search: 'needle' });
    const pages = new Map([['search-result', next.document]]);
    const windowObject = makeWindow(initial.document, pages);
    windowObject.fetch.mockResolvedValue(responseFor(next, 'search-result', 'http://creatorcrate.test/projects?search=needle'));
    enhanceProjectsLiveFiltering(initial.document);

    initial.search.value = 'needle';
    initial.document.activeElement = initial.search;
    initial.search.dispatch('input');
    expect(windowObject.fetch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(349);
    expect(windowObject.fetch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await flush();

    expect(windowObject.fetch).toHaveBeenCalledTimes(1);
    expect(new URL(windowObject.fetch.mock.calls[0][0]).searchParams.get('search')).toBe('needle');
    expect(initial.document.activeElement?.id).toBe('project-search');
    expect(initial.document.activeElement?.focused).toBe(true);
  });

  it('ignores stale out-of-order responses and keeps the newest replacement interactive', async () => {
    const initial = makePage();
    const first = makePage({ search: 'first' });
    const second = makePage({ search: 'second' });
    const third = makePage({ search: 'third' });
    const pages = new Map([
      ['first', first.document],
      ['second', second.document],
      ['third', third.document],
    ]);
    const windowObject = makeWindow(initial.document, pages);
    const requests = [];
    windowObject.fetch.mockImplementation((url) => new Promise((resolve) => requests.push({ url, resolve })));
    enhanceProjectsLiveFiltering(initial.document);

    initial.ready.checked = false;
    initial.form.dispatch('change', { target: initial.ready });
    initial.planned.checked = true;
    initial.form.dispatch('change', { target: initial.planned });
    expect(windowObject.fetch).toHaveBeenCalledTimes(2);

    requests[1].resolve(responseFor(second, 'second', 'http://creatorcrate.test/projects?search=second'));
    await flush();
    expect(windowObject.history.pushes).toHaveLength(1);
    expect(windowObject.history.pushes[0].url).toContain('search=second');
    expect(initial.document.querySelector('[data-projects-live-region]')).toBe(second.region);

    requests[0].resolve(responseFor(first, 'first', 'http://creatorcrate.test/projects?search=first'));
    await flush();
    expect(initial.document.querySelector('[data-projects-live-region]')).toBe(second.region);

    second.ready.checked = false;
    second.form.dispatch('change', { target: second.ready });
    await flush();
    expect(windowObject.fetch).toHaveBeenCalledTimes(3);
    requests[2].resolve(responseFor(third, 'third', 'http://creatorcrate.test/projects?search=third'));
    await flush();
    expect(initial.document.querySelector('[data-projects-live-region]')).toBe(third.region);
  });

  it('reinitializes Projects grid-size labels after repeated live-region replacement without duplicate handlers', async () => {
    const initial = makePage({ view: 'grid' });
    const second = makePage({ view: 'grid' });
    const third = makePage({ view: 'grid' });
    const initialControls = addProjectGridSizeControls(initial);
    const secondControls = addProjectGridSizeControls(second);
    const thirdControls = addProjectGridSizeControls(third);
    const pages = new Map([
      ['second', second.document],
      ['third', third.document],
    ]);
    const windowObject = makeWindow(initial.document, pages);
    windowObject.fetch
      .mockResolvedValueOnce(responseFor(second, 'second', 'http://creatorcrate.test/projects?search=second'))
      .mockResolvedValueOnce(responseFor(third, 'third', 'http://creatorcrate.test/projects?search=third'));
    const storage = new Map();
    const previousStorage = globalThis.localStorage;
    globalThis.localStorage = {
      getItem: (key) => storage.get(key) ?? null,
      setItem: vi.fn((key, value) => storage.set(key, value)),
    };

    try {
      enhanceProjectGridSize(initial.document);
      enhanceProjectsLiveFiltering(initial.document);
      initial.form.dispatch('change', { target: initial.ready });
      await flush();

      expect(initial.document.querySelector('[data-projects-live-region]')).toBe(second.region);
      secondControls.labels[2].dispatch('click');
      expect(storage.get('creatorcrate-project-grid-size')).toBe('large');

      enhanceProjectGridSize(second.region);
      enhanceProjectGridSize(second.region);
      storage.set('creatorcrate-project-grid-size', 'default');
      secondControls.labels[0].dispatch('click');
      expect(globalThis.localStorage.setItem).toHaveBeenCalledTimes(2);
      expect(storage.get('creatorcrate-project-grid-size')).toBe('compact');

      windowObject.setLocation('http://creatorcrate.test/projects?search=third');
      windowObject.dispatch('popstate');
      await flush();
      expect(initial.document.querySelector('[data-projects-live-region]')).toBe(third.region);
      thirdControls.labels[1].dispatch('click');
      expect(storage.get('creatorcrate-project-grid-size')).toBe('default');
      expect(initialControls.labels.every((label) => label.listeners?.length === 1)).toBe(true);
      expect(secondControls.labels.every((label) => label.listeners?.length === 1)).toBe(true);
      expect(thirdControls.labels.every((label) => label.listeners?.length === 1)).toBe(true);
    } finally {
      if (previousStorage === undefined) delete globalThis.localStorage;
      else globalThis.localStorage = previousStorage;
    }
  });

  it('uses the current URL for Back/Forward and replaces only the Projects region', async () => {
    const initial = makePage({ search: 'new' });
    const restored = makePage({ search: 'old' });
    const pages = new Map([['restored', restored.document]]);
    const windowObject = makeWindow(initial.document, pages);
    windowObject.location.set = undefined;
    windowObject.fetch.mockResolvedValue(responseFor(restored, 'restored', 'http://creatorcrate.test/projects?search=old'));
    enhanceProjectsLiveFiltering(initial.document);

    windowObject.setLocation('http://creatorcrate.test/projects?search=old');
    windowObject.dispatch('popstate');
    await flush();

    expect(windowObject.fetch).toHaveBeenCalledWith(
      'http://creatorcrate.test/projects?search=old',
      expect.objectContaining({ method: 'GET', headers: { Accept: 'text/html' } }),
    );
    expect(windowObject.history.pushes).toHaveLength(0);
    expect(windowObject.history.replaces).toHaveLength(0);
    expect(initial.document.querySelector('[data-projects-live-region]')).toBe(restored.region);
    expect(initial.document.querySelector('#project-search').value).toBe('old');
  });

  it('falls back to native GET navigation when enhancement capabilities or the fetch fail', async () => {
    const noFetchPage = makePage();
    const noFetchWindow = makeWindow(noFetchPage.document);
    noFetchWindow.fetch = undefined;
    enhanceProjectsLiveFiltering(noFetchPage.document);
    noFetchPage.form.dispatch('change', { target: noFetchPage.ready });
    expect(noFetchPage.form.submit).toHaveBeenCalledTimes(1);

    const failedPage = makePage();
    const failedWindow = makeWindow(failedPage.document);
    failedWindow.fetch.mockRejectedValue(new Error('network down'));
    enhanceProjectsLiveFiltering(failedPage.document);
    failedPage.form.dispatch('change', { target: failedPage.ready });
    await flush();
    expect(failedPage.form.submit).toHaveBeenCalledTimes(1);
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
    expect(next.nsfw.form.listeners.filter(({ type }) => type === 'submit')).toHaveLength(1);
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
    expect(disabled.nsfw.form.listeners.filter(({ type }) => type === 'submit')).toHaveLength(1);
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
