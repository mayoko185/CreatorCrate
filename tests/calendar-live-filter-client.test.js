import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { enhanceCalendarLiveFiltering, beginCalendarDefaultsLiveRefresh, refreshCalendarLiveRegion } from '../src/static/client/live-regions.js';
import { enhancePageDefaultsFetchSave } from '../src/static/client/projects-defaults-fetch-save.js';

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

function makePage(values = {}) {
  const document = makeNode({ tagName: 'document' });
  document.nodeType = 9;
  document.ownerDocument = document;
  document.activeElement = null;
  const region = makeNode({ attrs: { 'data-calendar-live-region': '' } });
  const status = makeNode({ attrs: { 'data-calendar-live-status': '' } });
  const heading = makeNode({ tagName: 'h2', attrs: { 'data-calendar-month-heading': '' } });
  heading.textContent = values.month || '2026-09';
  region.appendChild(status);
  region.appendChild(heading);
  const calendarEvent = makeNode({ attrs: { 'data-calendar-event': '' } });
  const trigger = makeNode({ tagName: 'button', attrs: { 'data-calendar-info-trigger': '' } });
  const info = makeNode({ attrs: { 'data-calendar-info-card': '' } });
  let popupOpen = false;
  const originalMatches = info.matches.bind(info);
  info.matches = (selector) => selector === ':popover-open' ? popupOpen : originalMatches(selector);
  info.showPopover = () => { popupOpen = true; };
  info.hidePopover = () => { popupOpen = false; };
  const releaseLink = makeNode({ tagName: 'a', attrs: { href: '/releases/1' } });
  info.appendChild(releaseLink);
  if (values.previewMedia) {
    const media = makeNode({ attrs: {
      'data-preview-enhancement': '', 'data-preview-state': 'loading',
    } });
    media.appendChild(makeNode({ tagName: 'img', attrs: { 'data-preview-image': '' } }));
    media.appendChild(makeNode({ tagName: 'span', attrs: { 'data-preview-fallback': '', hidden: '' } }));
    info.appendChild(media);
  }
  calendarEvent.appendChild(trigger);
  calendarEvent.appendChild(info);
  region.appendChild(calendarEvent);
  const links = {};
  for (const [name, month] of Object.entries({ previous: '2026-08', today: null, next: '2026-10' })) {
    const url = new URL('/calendar', 'http://creatorcrate.test');
    if (month) url.searchParams.set('month', month);
    for (const key of ['status', 'project', 'weekStart']) {
      if (values.explicit?.[key]) url.searchParams.set(key, values.explicit[key]);
    }
    links[name] = makeNode({ tagName: 'a', attrs: {
      id: `calendar-${name}`, href: url.pathname + url.search, 'data-calendar-navigation': '',
    } });
    region.appendChild(links[name]);
  }
  const form = makeNode({ tagName: 'form', attrs: { id: 'calendar-filters', action: '/calendar' } });
  const monthField = makeNode({ tagName: 'input', attrs: { name: 'month', type: 'hidden' }, value: values.month || '2026-09' });
  form.appendChild(monthField);
  const options = {};
  for (const [name, choices, selected] of [
    ['status', ['all', 'planned', 'published'], values.status || 'all'],
    ['project', ['', '7'], values.project || ''],
    ['weekStart', ['monday', 'sunday'], values.weekStart || 'monday'],
  ]) {
    options[name] = {};
    for (const value of choices) {
      const input = makeNode({ tagName: 'input', attrs: {
        id: `calendar-${name}-${value || 'all'}`, name, type: 'radio', value,
      }, checked: value === selected });
      options[name][value] = input;
      form.appendChild(input);
    }
  }
  const projectDropdown = makeNode({ tagName: 'details', attrs: {
    'data-cc-dropdown': '', 'data-cc-dropdown-mode': 'single',
    'data-cc-dropdown-searchable': '', 'data-cc-dropdown-type': 'searchable-single',
  } });
  const search = makeNode({ tagName: 'input', attrs: { 'data-cc-dropdown-search': '', type: 'search' } });
  projectDropdown.appendChild(search);
  form.appendChild(projectDropdown);
  const resetForm = makeNode({ tagName: 'form', attrs: {
    action: `/calendar?month=${values.month || '2026-09'}`,
  } });
  const reset = makeNode({ tagName: 'button', attrs: { 'data-calendar-reset': '', type: 'submit' } });
  resetForm.appendChild(reset);
  const dialog = makeNode({ tagName: 'dialog' });
  dialog.appendChild(form);
  dialog.appendChild(resetForm);
  document.appendChild(region);
  document.appendChild(dialog);
  return { document, region, status, heading, links, form, options, monthField, reset, resetForm,
    projectDropdown, search, trigger, isPopupOpen: () => popupOpen };
}

function makeWindow(document, pages) {
  const location = { href: 'http://creatorcrate.test/calendar?month=2026-09', pathname: '/calendar' };
  const setLocation = (value) => {
    const url = new URL(value, location.href);
    location.href = url.href;
    location.pathname = url.pathname;
  };
  const windowObject = {
    location, setLocation, listeners: [], fetch: vi.fn(), setTimeout, clearTimeout, AbortController,
    URLSearchParams,
    FormData: class FormDataMock {
      constructor(form) {
        this.fields = form.querySelectorAll('input, select, textarea')
          .filter((field) => field.name && !field.disabled && (!['checkbox', 'radio'].includes(field.type) || field.checked))
          .map((field) => [field.name, field.value]);
      }
      *entries() { yield* this.fields; }
      [Symbol.iterator]() { return this.entries(); }
    },
    DOMParser: class DOMParserMock {
      parseFromString(text) { return pages.get(text)?.document || makeNode({ tagName: 'document' }); }
    },
    history: {
      pushes: [], replaces: [],
      pushState(state, title, url) { this.pushes.push(url); setLocation(url); },
      replaceState(state, title, url) { this.replaces.push(url); setLocation(url); },
    },
    addEventListener(type, handler) { this.listeners.push({ type, handler }); },
    dispatch(type) { this.listeners.filter((item) => item.type === type).forEach((item) => item.handler()); },
  };
  document.defaultView = windowObject;
  return windowObject;
}

async function flush() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

describe('Calendar shared live region', () => {
  let oldDocument;
  let oldFetch;
  let oldFormData;

  beforeEach(() => {
    oldDocument = globalThis.document;
    oldFetch = globalThis.fetch;
    oldFormData = globalThis.FormData;
  });
  afterEach(() => {
    globalThis.document = oldDocument;
    globalThis.fetch = oldFetch;
    globalThis.FormData = oldFormData;
  });

  function environment(initialValues = {}) {
    const initial = makePage(initialValues);
    const pages = new Map();
    const windowObject = makeWindow(initial.document, pages);
    globalThis.document = initial.document;
    globalThis.FormData = windowObject.FormData;
    let counter = 0;
    const requests = [];
    windowObject.fetch.mockImplementation((requestedUrl) => {
      const url = new URL(requestedUrl);
      requests.push(url);
      const explicit = Object.fromEntries(url.searchParams.entries());
      const page = makePage({ month: explicit.month || '2026-09', status: explicit.status || 'all',
        project: explicit.project, weekStart: explicit.weekStart || 'monday', explicit,
        previewMedia: initialValues.previewMedia });
      const key = `page-${++counter}`;
      pages.set(key, page);
      return Promise.resolve({ ok: true, url: url.href, text: async () => key });
    });
    enhanceCalendarLiveFiltering(initial.document);
    return { initial, pages, windowObject, requests };
  }

  it('serializes status, project, and week start immediately while retaining month and explicit All', async () => {
    const { initial, windowObject, requests } = environment();
    initial.document.querySelector('dialog').open = true;
    initial.options.status.planned.checked = true;
    initial.options.status.all.checked = false;
    initial.options.status.planned.dispatch('change');
    await flush();
    expect(initial.document.querySelector('dialog').open).toBe(true);
    expect(requests[0].searchParams.get('month')).toBe('2026-09');
    expect(requests[0].searchParams.get('status')).toBe('planned');

    const listenerCount = initial.document.listeners.length;
    expect(initial.document.querySelector('[data-calendar-info-trigger]').listeners.filter(({ type }) => type === 'click')).toHaveLength(1);

    const form = initial.document.querySelector('#calendar-filters');
    form.querySelector('#calendar-project-7').checked = true;
    form.querySelector('#calendar-project-all').checked = false;
    form.querySelector('#calendar-project-7').dispatch('change');
    await flush();
    expect(requests[1].searchParams.get('project')).toBe('7');
    expect(requests[1].searchParams.get('month')).toBe('2026-09');

    const currentForm = initial.document.querySelector('#calendar-filters');
    currentForm.querySelector('#calendar-weekStart-sunday').checked = true;
    currentForm.querySelector('#calendar-weekStart-monday').checked = false;
    currentForm.querySelector('#calendar-weekStart-sunday').dispatch('change');
    await flush();
    expect(requests[2].searchParams.get('weekStart')).toBe('sunday');
    expect(requests[2].searchParams.get('project')).toBe('7');
    expect(windowObject.history.pushes).toHaveLength(3);
    expect(initial.document.listeners.length).toBe(listenerCount);
    expect(initial.document.querySelector('[data-calendar-info-trigger]').listeners.filter(({ type }) => type === 'click')).toHaveLength(1);
    expect(initial.document.querySelector('[data-cc-dropdown-searchable]')).toBeTruthy();

    const search = initial.document.querySelector('[data-cc-dropdown-search]');
    search.value = 'project';
    search.dispatch('input');
    search.dispatch('change');
    await flush();
    expect(requests).toHaveLength(3);

    const latestForm = initial.document.querySelector('#calendar-filters');
    latestForm.querySelector('#calendar-status-all').checked = true;
    latestForm.querySelector('#calendar-status-planned').checked = false;
    latestForm.querySelector('#calendar-status-all').dispatch('change');
    await flush();
    expect(requests[3].searchParams.get('status')).toBe('all');
  });

  it('retains filters on navigation, restores Back, and Reset clears overrides but keeps month', async () => {
    const { initial, windowObject, requests } = environment({
      month: '2026-09', status: 'all', project: '7', weekStart: 'sunday',
      explicit: { status: 'all', project: '7', weekStart: 'sunday' },
    });
    initial.links.next.dispatch('click', { button: 0 });
    await flush();
    expect(requests[0].searchParams.toString()).toBe('month=2026-10&status=all&project=7&weekStart=sunday');
    expect(windowObject.location.href).toBe(requests[0].href);
    windowObject.setLocation('http://creatorcrate.test/calendar?month=2026-09&status=all&project=7&weekStart=sunday');
    windowObject.dispatch('popstate');
    await flush();
    expect(requests[1].searchParams.get('month')).toBe('2026-09');
    expect(windowObject.history.replaces).toHaveLength(0);
    const reset = initial.document.querySelector('[data-calendar-reset]');
    reset.dispatch('click', { button: 0 });
    await flush();
    expect(requests[2].searchParams.toString()).toBe('month=2026-09');
    expect(windowObject.location.href).toBe('http://creatorcrate.test/calendar?month=2026-09');
  });

  it('retains explicit filters for Previous and Today', async () => {
    const { initial, requests } = environment({
      month: '2026-09', status: 'all', project: '7', weekStart: 'sunday',
      explicit: { status: 'all', project: '7', weekStart: 'sunday' },
    });
    initial.links.previous.dispatch('click', { button: 0 });
    await flush();
    expect(requests[0].searchParams.toString()).toBe('month=2026-08&status=all&project=7&weekStart=sunday');
    initial.document.querySelector('#calendar-today').dispatch('click', { button: 0 });
    await flush();
    expect(requests[1].searchParams.toString()).toBe('status=all&project=7&weekStart=sunday');
  });

  it('dismisses an old popup and binds the new event trigger after replacement', async () => {
    const { initial } = environment();
    initial.trigger.dispatch('click');
    expect(initial.isPopupOpen()).toBe(true);
    initial.links.next.dispatch('click', { button: 0 });
    await flush();
    expect(initial.isPopupOpen()).toBe(false);
    expect(initial.trigger.getAttribute('aria-expanded')).toBe('false');
    const replacement = initial.document.querySelector('[data-calendar-info-trigger]');
    expect(replacement).not.toBe(initial.trigger);
    expect(replacement.listeners.filter(({ type }) => type === 'click')).toHaveLength(1);
    replacement.dispatch('click');
    expect(replacement.getAttribute('aria-expanded')).toBe('true');
  });

  it('rebinds preview failure fallback and information cards after each replacement', async () => {
    const { initial } = environment({ previewMedia: true });
    for (const navigation of ['next', 'previous']) {
      initial.document.querySelector(`#calendar-${navigation}`).dispatch('click', { button: 0 });
      await flush();
      const region = initial.document.querySelector('[data-calendar-live-region]');
      const image = region.querySelector('[data-preview-image]');
      const media = region.querySelector('[data-preview-enhancement]');
      const fallback = region.querySelector('[data-preview-fallback]');
      const trigger = region.querySelector('[data-calendar-info-trigger]');
      expect(image.listeners.filter(({ type }) => type === 'error')).toHaveLength(1);
      expect(trigger.listeners.filter(({ type }) => type === 'click')).toHaveLength(1);
      expect(trigger.listeners.filter(({ type }) => type === 'pointerenter')).toHaveLength(1);
      expect(trigger.listeners.filter(({ type }) => type === 'pointermove')).toHaveLength(1);
      expect(trigger.listeners.filter(({ type }) => type === 'pointerleave')).toHaveLength(1);
      image.dispatch('error');
      expect(media.getAttribute('data-preview-state')).toBe('failed');
      expect(image.hidden).toBe(true);
      expect(fallback.hidden).toBe(false);
      trigger.dispatch('click');
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
    }
  });

  it('restores month-link focus and moves focus off a removed popup control', async () => {
    const { initial } = environment();
    initial.links.next.focus();
    initial.links.next.dispatch('click', { button: 0 });
    await flush();
    expect(initial.document.querySelector('#calendar-next').focused).toBe(true);

    const releaseLink = initial.document.querySelector('[data-calendar-info-card] a');
    releaseLink.focus();
    initial.document.querySelector('#calendar-previous').dispatch('click', { button: 0 });
    await flush();
    expect(initial.document.querySelector('[data-calendar-month-heading]').focused).toBe(true);
    expect(initial.document.activeElement).not.toBe(releaseLink);
  });

  it('prevents an older response and an older defaults refresh from replacing newer navigation', async () => {
    const { initial, windowObject, requests } = environment();
    let resolveOld;
    windowObject.fetch.mockImplementationOnce((url) => {
      requests.push(new URL(url));
      return new Promise((resolve) => { resolveOld = resolve; });
    });
    initial.links.next.dispatch('click', { button: 0 });
    initial.links.previous.dispatch('click', { button: 0 });
    await flush();
    expect(initial.document.querySelector('[data-calendar-month-heading]').textContent).toBe('2026-08');
    const stale = makePage({ month: '2026-10' });
    resolveOld({ ok: true, url: 'http://creatorcrate.test/calendar?month=2026-10', text: async () => 'stale' });
    await flush();
    expect(initial.document.querySelector('[data-calendar-month-heading]').textContent).toBe('2026-08');
    expect(stale.heading.textContent).toBe('2026-10');
    const authority = beginCalendarDefaultsLiveRefresh(initial.document);
    initial.document.querySelector('#calendar-next').dispatch('click', { button: 0 });
    await flush();
    expect(refreshCalendarLiveRegion(initial.document, '/settings/defaults', authority)).toBe('superseded');
  });

  it('autosaves each changed default and refreshes the displayed month and selected project', async () => {
    const { initial, windowObject, requests } = environment({
      month: '2026-09', status: 'planned', project: '7', weekStart: 'monday',
      explicit: { status: 'planned', project: '7', weekStart: 'monday' },
    });
    windowObject.setLocation('http://creatorcrate.test/calendar?month=2026-09&status=planned&project=7&weekStart=monday');
    const form = makeNode({ tagName: 'form', attrs: {
      id: 'calendar-defaults-form', action: '/settings/defaults', method: 'post',
      'data-calendar-defaults-fetch-save': '',
    } });
    const status = makeNode({ tagName: 'select', attrs: {
      name: 'calendarStatus', 'data-autosubmit': 'fetch',
    }, value: 'published' });
    const weekStart = makeNode({ tagName: 'select', attrs: {
      name: 'calendarWeekStart', 'data-autosubmit': 'fetch',
    }, value: 'monday' });
    const acknowledgement = makeNode({ attrs: { 'data-settings-fetch-save-status': '' } });
    status.form = form;
    weekStart.form = form;
    form.appendChild(status);
    form.appendChild(weekStart);
    form.appendChild(acknowledgement);
    initial.document.appendChild(form);
    globalThis.fetch = vi.fn(async () => ({
      ok: true, redirected: true, url: 'http://creatorcrate.test/settings/defaults?notice=defaults_saved',
      text: async () => '<html></html>',
    }));
    const config = {
      formSelector: '#calendar-defaults-form', markerAttribute: 'data-calendar-defaults-fetch-save',
      beginRefresh: beginCalendarDefaultsLiveRefresh, refresh: refreshCalendarLiveRegion,
      refreshFailureMessage: 'Refresh failed.',
    };
    expect(enhancePageDefaultsFetchSave(initial.document, config)).toBe(2);
    expect(enhancePageDefaultsFetchSave(initial.document, config)).toBe(0);
    expect(form.listeners.filter(({ type }) => type === 'submit')).toHaveLength(0);
    status.dispatch('change');
    await flush();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch.mock.calls[0][1].body.get('calendarStatus')).toBe('published');
    expect(requests).toHaveLength(1);
    expect(requests[0].searchParams.toString()).toBe('month=2026-09&project=7');
    expect(windowObject.history.replaces).toEqual([requests[0].href]);
    expect(acknowledgement.textContent).toBe('Settings saved.');
    expect(form.getAttribute('data-settings-fetch-save-state')).toBe('saved');

    weekStart.value = 'sunday';
    weekStart.dispatch('change');
    await flush();
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(globalThis.fetch.mock.calls[1][1].body.get('calendarWeekStart')).toBe('sunday');
    expect(requests).toHaveLength(2);
    expect(requests[1].searchParams.toString()).toBe('month=2026-09&project=7');
  });

  it('queues rapid default changes behind the active shared save and reports errors', async () => {
    const { initial, windowObject, requests } = environment({ month: '2026-09', project: '7', explicit: { project: '7' } });
    windowObject.setLocation('http://creatorcrate.test/calendar?month=2026-09&project=7');
    const form = makeNode({ tagName: 'form', attrs: {
      id: 'calendar-defaults-form', action: '/settings/defaults', method: 'post',
      'data-calendar-defaults-fetch-save': '',
    } });
    const status = makeNode({ tagName: 'select', attrs: {
      name: 'calendarStatus', 'data-autosubmit': 'fetch',
    }, value: 'planned' });
    const weekStart = makeNode({ tagName: 'select', attrs: {
      name: 'calendarWeekStart', 'data-autosubmit': 'fetch',
    }, value: 'monday' });
    const acknowledgement = makeNode({ attrs: { 'data-settings-fetch-save-status': '' } });
    status.form = form;
    weekStart.form = form;
    form.appendChild(status);
    form.appendChild(weekStart);
    form.appendChild(acknowledgement);
    initial.document.appendChild(form);
    let resolveFirst;
    globalThis.fetch = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementation(async () => ({
        ok: true, redirected: true, url: 'http://creatorcrate.test/settings/defaults?notice=defaults_saved',
        text: async () => '<html></html>',
      }));
    enhancePageDefaultsFetchSave(initial.document, {
      formSelector: '#calendar-defaults-form', markerAttribute: 'data-calendar-defaults-fetch-save',
      beginRefresh: beginCalendarDefaultsLiveRefresh, refresh: refreshCalendarLiveRegion,
      refreshFailureMessage: 'Refresh failed.',
    });
    status.dispatch('change');
    await flush();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(acknowledgement.textContent).toBe('Saving settings.');
    weekStart.value = 'sunday';
    weekStart.dispatch('change');
    await flush();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    resolveFirst({
      ok: true, redirected: true, url: 'http://creatorcrate.test/settings/defaults?notice=defaults_saved',
      text: async () => '<html></html>',
    });
    await flush();
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(globalThis.fetch.mock.calls[1][1].body.get('calendarWeekStart')).toBe('sunday');
    expect(requests).toHaveLength(1);
    expect(requests[0].searchParams.get('project')).toBe('7');
    expect(acknowledgement.textContent).toBe('Settings saved.');

    globalThis.fetch.mockImplementationOnce(async () => ({ ok: false, redirected: false, text: async () => '' }));
    status.value = 'published';
    status.dispatch('change');
    await flush();
    expect(acknowledgement.textContent).toBe('Could not save settings. Your current changes were kept.');
    expect(form.getAttribute('data-settings-fetch-save-state')).toBe('error');
    expect(requests).toHaveLength(1);
  });

  it('ignores a save-triggered response after a newer month navigation', async () => {
    const { initial, windowObject, requests } = environment({
      month: '2026-09', project: '7', explicit: { project: '7' },
    });
    windowObject.setLocation('http://creatorcrate.test/calendar?month=2026-09&project=7');
    const authority = beginCalendarDefaultsLiveRefresh(initial.document);
    let resolveRefresh;
    windowObject.fetch.mockImplementationOnce((url) => {
      requests.push(new URL(url));
      return new Promise((resolve) => { resolveRefresh = resolve; });
    });
    expect(refreshCalendarLiveRegion(initial.document, '/settings/defaults', authority)).toBe('started');
    const next = initial.document.querySelector('#calendar-next');
    next.dispatch('click', { button: 0 });
    await flush();
    expect(initial.document.querySelector('[data-calendar-month-heading]').textContent).toBe('2026-10');
    resolveRefresh({ ok: true, url: requests[0].href, text: async () => 'old' });
    await flush();
    expect(initial.document.querySelector('[data-calendar-month-heading]').textContent).toBe('2026-10');
    expect(windowObject.location.href).toBe(requests[1].href);
  });

  it('lets Back supersede a pending navigation response', async () => {
    const { initial, windowObject, requests } = environment();
    let resolveNavigation;
    windowObject.fetch.mockImplementationOnce((url) => {
      requests.push(new URL(url));
      return new Promise((resolve) => { resolveNavigation = resolve; });
    });
    initial.links.next.dispatch('click', { button: 0 });
    windowObject.dispatch('popstate');
    await flush();
    expect(requests[1].searchParams.get('month')).toBe('2026-09');
    expect(initial.document.querySelector('[data-calendar-month-heading]').textContent).toBe('2026-09');
    resolveNavigation({ ok: true, url: requests[0].href, text: async () => 'stale' });
    await flush();
    expect(initial.document.querySelector('[data-calendar-month-heading]').textContent).toBe('2026-09');
  });
});
