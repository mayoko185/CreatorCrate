import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { enhanceReleasesLiveFiltering } from '../src/static/creatorcrate.js';

function makeNode({ tagName = 'div', attrs = {}, value = '', checked = false } = {}) {
  const attributes = new Map();
  const children = [];
  const listeners = [];
  const node = {
    tagName: tagName.toUpperCase(),
    nodeType: 1,
    ownerDocument: null,
    parentNode: null,
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
    getAttribute(name) { return attributes.get(name) ?? null; },
    hasAttribute(name) { return attributes.has(name); },
    removeAttribute(name) {
      attributes.delete(name);
      if (name === 'hidden') this.hidden = false;
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
        const tag = candidate.match(/^[a-z][\w-]*/i)?.[0];
        if (tag && this.tagName !== tag.toUpperCase()) return false;
        return [...candidate.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)].every(([, name, expected]) => {
          const actual = this.getAttribute(name);
          return actual !== null && (expected === undefined || actual === expected);
        });
      });
    },
    appendChild(child) {
      children.push(child);
      child.parentNode = this;
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
      const index = parent?.children?.indexOf(this) ?? -1;
      if (index < 0) return;
      parent.children.splice(index, 1, next);
      next.parentNode = parent;
      next.ownerDocument = parent.ownerDocument || parent;
      next.children.forEach((child) => { child.ownerDocument = next.ownerDocument; });
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
      listeners.filter((listener) => listener.type === type)
        .forEach((listener) => listener.handler(event));
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

function makeForm(view = 'list') {
  const form = makeNode({
    tagName: 'form',
    attrs: { action: '/releases', method: 'get', 'data-releases-filter': '' },
  });
  form.submit = vi.fn();
  const add = (attrs, fieldValue = '', fieldChecked = false) => {
    const field = makeNode({ tagName: 'input', attrs, value: fieldValue, checked: fieldChecked });
    form.appendChild(field);
    return field;
  };
  const search = add({ name: 'search', type: 'search', 'data-releases-search': '' });
  const project = add({ name: 'project', type: 'text' }, '7');
  const page = add({ name: 'page', type: 'hidden' }, '4');
  add({ name: 'view', type: 'hidden' }, view);
  const schedule = add({ name: 'schedule', type: 'select-one' }, '');
  const archived = add({ name: 'includeArchived', type: 'checkbox', value: '1' }, '1', false);
  const sort = add({ name: 'sort', type: 'hidden' }, 'planned');
  const order = add({ name: 'order', type: 'hidden' }, 'asc');
  return { form, search, project, page, schedule, archived, sort, order };
}

function makePage(view = 'list') {
  const document = makeNode({ tagName: 'document' });
  document.nodeType = 9;
  document.ownerDocument = document;
  document.activeElement = null;
  const region = makeNode({ attrs: { 'data-releases-live-region': '' } });
  const status = makeNode({ attrs: { 'data-releases-live-status': '' } });
  const formParts = makeForm(view);
  const nav = makeNode({ tagName: 'nav', attrs: { 'aria-label': 'View' } });
  const list = makeNode({ tagName: 'a', attrs: { href: '/releases?view=list', 'data-releases-view-link': '' } });
  const board = makeNode({ tagName: 'a', attrs: { href: '/releases?view=board', 'data-releases-view-link': '' } });
  nav.appendChild(list);
  nav.appendChild(board);
  const reset = makeNode({ tagName: 'a', attrs: { href: '/releases', 'data-releases-reset': '' } });
  region.appendChild(status);
  region.appendChild(nav);
  region.appendChild(formParts.form);
  region.appendChild(reset);
  document.appendChild(region);
  return { document, region, status, nav, list, board, reset, ...formParts };
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

  it('updates filters without navigation, resets pagination, and serializes archived state', async () => {
    const initial = makePage();
    const next = makePage();
    const pages = new Map([['next', next.document]]);
    const windowObject = makeWindow(initial.document, pages);
    windowObject.fetch.mockResolvedValue(responseFor('next', 'http://creatorcrate.test/releases?project=7&schedule=today&includeArchived=1'));
    enhanceReleasesLiveFiltering(initial.document);

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
  });

  it('debounces Search and rebinds the Board form after a view switch', async () => {
    vi.useFakeTimers();
    const initial = makePage('list');
    const board = makePage('board');
    const filtered = makePage('board');
    const pages = new Map([['board', board.document], ['filtered', filtered.document]]);
    const windowObject = makeWindow(initial.document, pages);
    windowObject.fetch
      .mockResolvedValueOnce(responseFor('board', 'http://creatorcrate.test/releases?view=board&project=7'))
      .mockResolvedValueOnce(responseFor('filtered', 'http://creatorcrate.test/releases?view=board&search=needle'));
    enhanceReleasesLiveFiltering(initial.document);

    const switchEvent = initial.board.dispatch('click');
    expect(switchEvent.defaultPrevented).toBe(true);
    await flush();
    expect(initial.document.querySelector('[data-releases-live-region]')).toBe(board.region);
    expect(windowObject.history.pushes).toHaveLength(1);

    board.search.value = 'needle';
    board.document?.activeElement;
    board.search.dispatch('input');
    vi.advanceTimersByTime(349);
    expect(windowObject.fetch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await flush();
    expect(windowObject.fetch).toHaveBeenCalledTimes(2);
    expect(new URL(windowObject.fetch.mock.calls[1][0]).searchParams.get('search')).toBe('needle');
    expect(initial.form.submit).not.toHaveBeenCalled();
  });

  it('suppresses stale responses, handles Back/Forward, and falls back on failure', async () => {
    const initial = makePage();
    const first = makePage();
    const second = makePage();
    const restored = makePage();
    const pages = new Map([['first', first.document], ['second', second.document], ['restored', restored.document]]);
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

    windowObject.location.href = 'http://creatorcrate.test/releases?schedule=today';
    windowObject.location.pathname = '/releases';
    windowObject.fetch.mockResolvedValueOnce(responseFor('restored', windowObject.location.href));
    windowObject.dispatch('popstate');
    await flush();
    expect(initial.document.querySelector('[data-releases-live-region]')).toBe(restored.region);
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
