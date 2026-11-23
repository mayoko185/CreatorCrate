import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  enhanceCalendarLiveFiltering,
  beginCalendarDefaultsLiveRefresh,
  refreshCalendarLiveRegion,
  calendarLiveSnapshot,
  navigateCalendarLive,
  subscribeCalendarLive,
} from '../src/static/client/live-regions.js';
import { closeAppDialogById } from '../src/static/client/app-dialogs.js';
import {
  CALENDAR_DEFAULTS_MESSAGES,
  createCalendarFiltersDefaults,
} from '../src/static/client/calendar-filters-defaults.js';
import { enhancePageDefaultsFetchSave } from '../src/static/client/projects-defaults-fetch-save.js';
import { enhanceDropdowns } from '../src/static/client/dropdowns.js';

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

function makePage(values = {}) {
  const document = makeNode({ tagName: 'document' });
  document.nodeType = 9;
  document.ownerDocument = document;
  document.activeElement = null;
  document.getElementById = (id) => document.querySelector(`#${id}`);
  const region = makeNode({ attrs: { 'data-calendar-live-region': '', 'data-calendar-month': values.month || '2026-09' } });
  const status = makeNode({ attrs: { 'data-calendar-live-status': '' } });
  const heading = makeNode({ tagName: 'h2', attrs: { 'data-calendar-month-heading': '' } });
  heading.textContent = values.month || '2026-09';
  region.appendChild(status);
  region.appendChild(heading);
  const viewSwitcher = makeNode({ attrs: { class: 'calendar-view-switcher' } });
  const listView = makeNode({ tagName: 'a', attrs: {
    href: `/calendar?month=${values.month || '2026-09'}&view=list`,
  } });
  viewSwitcher.appendChild(listView);
  region.appendChild(viewSwitcher);
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
    for (const key of ['status', 'project', 'weekStart', 'view']) {
      if (values.explicit?.[key]) url.searchParams.set(key, values.explicit[key]);
    }
    links[name] = makeNode({ tagName: 'a', attrs: {
      id: `calendar-${name}`, href: url.pathname + url.search, 'data-calendar-navigation': '',
    } });
    region.appendChild(links[name]);
  }
  const form = makeNode({ tagName: 'form', attrs: { id: 'calendar-filters', action: '/calendar' } });
  form.requestSubmit = () => form.dispatch('submit');
  const monthField = makeNode({ tagName: 'input', attrs: { name: 'month', type: 'hidden' }, value: values.month || '2026-09' });
  form.appendChild(monthField);
  if (values.explicit?.view) form.appendChild(makeNode({
    tagName: 'input', attrs: { name: 'view', type: 'hidden' }, value: values.explicit.view,
  }));
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
  const search = makeNode({ tagName: 'input', attrs: {
    id: 'calendar-project-filter-search', 'data-cc-dropdown-search': '', type: 'search',
  } });
  projectDropdown.appendChild(search);
  form.appendChild(projectDropdown);
  const resetForm = makeNode({ tagName: 'form', attrs: {
    action: `/calendar?month=${values.month || '2026-09'}${values.explicit?.view ? `&view=${values.explicit.view}` : ''}`,
  } });
  const reset = makeNode({ tagName: 'button', attrs: { 'data-calendar-reset': '', type: 'submit' } });
  // WP14b: the combined dialog's footer Reset filters carries the displayed
  // month as a hidden field (a GET form's action query would be replaced).
  const resetMonth = makeNode({ tagName: 'input', attrs: {
    name: 'month', type: 'hidden', value: values.month || '2026-09',
  } });
  resetForm.appendChild(resetMonth);
  resetForm.appendChild(reset);
  const dialog = makeNode({ tagName: 'dialog' });
  dialog.appendChild(form);
  dialog.appendChild(resetForm);
  document.appendChild(region);
  document.appendChild(dialog);
  return { document, region, status, heading, links, listView, form, options, monthField, reset, resetForm,
    resetMonth, projectDropdown, search, trigger, isPopupOpen: () => popupOpen };
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
        const candidates = new Set([
          ...(form.ownerDocument?.querySelectorAll?.('input, select, textarea') || []),
          ...form.querySelectorAll('input, select, textarea'),
        ]);
        this.fields = [...candidates]
          .filter((field) => mockFormOwner(field) === form)
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

function attachMonthPicker(document) {
  const dialog = makeNode({ tagName: 'dialog', attrs: { id: 'calendar-month-dialog' } });
  const form = makeNode({ tagName: 'form', attrs: { id: 'calendar-month-form' } });
  const dropdown = makeNode({ tagName: 'details', attrs: {
    id: 'calendar-month-select', 'data-cc-dropdown': '', 'data-cc-dropdown-mode': 'single',
  } });
  const months = {};
  for (const value of ['08', '09', '10', '11']) {
    months[value] = makeNode({ tagName: 'input', attrs: { type: 'radio', value } });
    dropdown.appendChild(months[value]);
  }
  const year = makeNode({ tagName: 'input', attrs: { id: 'calendar-month-year', type: 'number' } });
  year.validityMessage = '';
  year.setCustomValidity = (message) => { year.validityMessage = message; };
  year.checkValidity = () => !year.validityMessage && Number(year.value) >= 1000 && Number(year.value) <= 9999;
  year.reportValidity = vi.fn();
  form.requestSubmit = () => form.dispatch('submit');
  form.appendChild(dropdown);
  form.appendChild(year);
  dialog.appendChild(form);
  document.appendChild(dialog);
  dialog.__creatorCrateAppDialogState = {
    document, dialog, open: true, opener: null, openerAllowsFallback: true,
  };
  return { dialog, form, dropdown, months, year, open() {
    dialog.__creatorCrateAppDialogState.open = true;
    dialog.__creatorCrateAppDialogState.onOpen();
  } };
}

const liveFailureNotice = (document) => document.querySelector('[data-live-filter-failure]');
const liveFailureRetries = (document) => document.querySelectorAll('[data-live-filter-retry]');

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

  it('opens from the displayed month and submits a changed month through the existing filter and history path', async () => {
    const { initial, requests, windowObject } = environment({
      month: '2026-09', status: 'planned', project: '7', weekStart: 'sunday',
      explicit: { view: 'list', status: 'planned', project: '7', weekStart: 'sunday' },
    });
    const picker = attachMonthPicker(initial.document);
    enhanceCalendarLiveFiltering(initial.document);
    picker.open();
    expect(picker.year.value).toBe('2026');
    expect(picker.months['09'].checked).toBe(true);
    picker.months['11'].checked = true;
    picker.months['09'].checked = false;
    picker.months['11'].dispatch('change');
    await flush();
    expect(requests).toHaveLength(1);
    expect(Object.fromEntries(requests[0].searchParams)).toEqual({
      month: '2026-11', view: 'list', status: 'planned', project: '7', weekStart: 'sunday',
    });
    expect(windowObject.history.pushes).toHaveLength(1);
    expect(picker.dialog.__creatorCrateAppDialogState.open).toBe(true);
    picker.open();
    expect(picker.months['11'].checked).toBe(true);
    expect(picker.year.value).toBe('2026');
    picker.year.value = '1000';
    picker.year.dispatch('input');
    picker.year.dispatch('change');
    await flush();
    expect(requests).toHaveLength(2);
    expect(requests[1].searchParams.get('month')).toBe('1000-11');
    picker.open();
    expect(picker.year.value).toBe('1000');
  });

  it('commits Enter once even when year change and implicit submit follow before replacement', async () => {
    const { initial, requests, windowObject } = environment({ month: '2026-09' });
    const picker = attachMonthPicker(initial.document);
    enhanceCalendarLiveFiltering(initial.document);
    picker.open();
    let resolveRequest;
    const fetchPage = windowObject.fetch.getMockImplementation();
    windowObject.fetch.mockImplementationOnce((url) => new Promise((resolve) => {
      resolveRequest = () => resolve(fetchPage(url));
    }));

    picker.year.value = '2027';
    picker.year.dispatch('input');
    const enter = picker.year.dispatch('keydown', { key: 'Enter' });
    picker.year.dispatch('change');
    picker.form.dispatch('submit');

    expect(enter.defaultPrevented).toBe(true);
    expect(requests).toHaveLength(0);
    expect(windowObject.fetch).toHaveBeenCalledTimes(1);
    expect(new URL(windowObject.fetch.mock.calls[0][0]).searchParams.get('month')).toBe('2027-09');
    expect(picker.dialog.__creatorCrateAppDialogState.open).toBe(true);

    resolveRequest();
    await flush();
    expect(requests).toHaveLength(1);
    expect(windowObject.history.pushes).toHaveLength(1);
  });

  it('allows the same Enter selection to retry after a failed request', async () => {
    const { initial, windowObject } = environment({ month: '2026-09' });
    const picker = attachMonthPicker(initial.document);
    enhanceCalendarLiveFiltering(initial.document);
    picker.open();
    windowObject.fetch.mockImplementationOnce(() => Promise.reject(new Error('offline')));

    picker.year.value = '2027';
    picker.year.dispatch('input');
    picker.year.dispatch('keydown', { key: 'Enter' });
    await flush();
    picker.year.dispatch('keydown', { key: 'Enter' });

    expect(windowObject.fetch).toHaveBeenCalledTimes(2);
    expect(new URL(windowObject.fetch.mock.calls[1][0]).searchParams.get('month')).toBe('2027-09');
  });

  it('keeps a failed month pending in the picker and displayed Calendar until Retry loads it', async () => {
    const { initial, windowObject } = environment({ month: '2026-09' });
    const picker = attachMonthPicker(initial.document);
    enhanceCalendarLiveFiltering(initial.document);
    picker.open();
    windowObject.fetch.mockImplementationOnce(() => Promise.reject(new Error('offline')));
    picker.months['09'].checked = false;
    picker.months['10'].checked = true;
    picker.months['10'].dispatch('change');
    await flush();

    const liveRegion = () => initial.document.querySelector('[data-calendar-live-region]');
    expect(liveRegion().getAttribute('data-calendar-month')).toBe('2026-09');
    expect(liveFailureNotice(initial.document).children[0].textContent).toContain("requested month couldn't be loaded");
    expect(windowObject.history.pushes).toHaveLength(0);
    expect(windowObject.location.href).toBe('http://creatorcrate.test/calendar?month=2026-09');
    expect(initial.document.querySelector('#calendar-filters input[name="month"]').value).toBe('2026-10');

    picker.open();
    expect(picker.months['10'].checked).toBe(true);
    expect(picker.months['09'].checked).toBe(false);
    expect(picker.year.value).toBe('2026');

    liveFailureRetries(initial.document)[0].dispatch('click');
    await flush();
    expect(windowObject.fetch).toHaveBeenCalledTimes(2);
    expect(new URL(windowObject.fetch.mock.calls[1][0]).searchParams.get('month')).toBe('2026-10');
    expect(windowObject.fetch.mock.calls[1][1].method).toBe('GET');
    expect(liveFailureNotice(initial.document)).toBeNull();
    expect(windowObject.history.pushes).toHaveLength(1);
  });

  it('lets choosing the displayed month again resolve a failed month', async () => {
    const { initial, windowObject } = environment({ month: '2026-09' });
    const picker = attachMonthPicker(initial.document);
    enhanceCalendarLiveFiltering(initial.document);
    picker.open();
    windowObject.fetch.mockImplementationOnce(() => Promise.reject(new Error('offline')));
    picker.months['09'].checked = false;
    picker.months['10'].checked = true;
    picker.months['10'].dispatch('change');
    await flush();

    picker.months['10'].checked = false;
    picker.months['09'].checked = true;
    picker.months['09'].dispatch('change');
    await flush();
    expect(new URL(windowObject.fetch.mock.calls[1][0]).searchParams.get('month')).toBe('2026-09');
    expect(liveFailureNotice(initial.document)).toBeNull();
  });

  it('does not navigate for the displayed month or an invalid year, and dismissal keeps Calendar state', async () => {
    const { initial, requests } = environment({ month: '2026-09' });
    const picker = attachMonthPicker(initial.document);
    enhanceCalendarLiveFiltering(initial.document);
    picker.open();
    picker.months['09'].dispatch('change');
    expect(requests).toHaveLength(0);
    picker.open();
    picker.year.value = '999';
    picker.year.dispatch('change');
    expect(picker.year.reportValidity).toHaveBeenCalled();
    expect(picker.dialog.__creatorCrateAppDialogState.open).toBe(true);
    expect(requests).toHaveLength(0);
    picker.year.value = '2026';
    picker.year.dispatch('input');
    expect(picker.year.validityMessage).toBe('');
    picker.months['10'].checked = true;
    picker.months['09'].checked = false;
    closeAppDialogById(initial.document, 'calendar-month-dialog');
    expect(picker.dialog.__creatorCrateAppDialogState.open).toBe(false);
    expect(initial.document.querySelector('#calendar-filters input[name="month"]').value).toBe('2026-09');
    picker.open();
    expect(picker.months['09'].checked).toBe(true);
    expect(picker.year.value).toBe('2026');
  });

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

  it('keeps the selected desktop view through filter changes, navigation, and Reset', async () => {
    const { initial, requests } = environment({ month: '2026-09', explicit: { view: 'list' } });
    initial.options.status.planned.checked = true;
    initial.options.status.all.checked = false;
    initial.options.status.planned.dispatch('change');
    await flush();
    expect(requests[0].searchParams.get('view')).toBe('list');
    initial.links.next.dispatch('click', { button: 0 });
    await flush();
    expect(requests[1].searchParams.get('view')).toBe('list');
    initial.reset.dispatch('click', { button: 0 });
    await flush();
    expect(requests[2].searchParams.toString()).toBe('month=2026-10&view=list');
  });

  it('switches views through the Calendar live region', async () => {
    const { initial, requests, windowObject } = environment();
    initial.listView.dispatch('click', { button: 0 });
    await flush();
    expect(requests[0].searchParams.get('view')).toBe('list');
    expect(windowObject.location.href).toBe(requests[0].href);
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

  it('WP14b: keeps the footer Reset filters month and a typed dropdown search in step with the installed month', async () => {
    const { initial, requests } = environment({ month: '2026-09' });
    initial.search.value = 'Bra';
    initial.links.next.dispatch('click', { button: 0 });
    await flush();
    expect(requests[0].searchParams.get('month')).toBe('2026-10');
    // The footer form (outside the live region) is the same element, with the
    // installed month; the reconciled GET form's month follows it too.
    expect(initial.document.querySelector('[data-calendar-reset]')).toBe(initial.reset);
    expect(initial.resetMonth.value).toBe('2026-10');
    expect(initial.form.querySelector('input[name="month"]').value).toBe('2026-10');
    // The typed option search survives the reconciliation of the GET form.
    const search = initial.form.querySelector('[data-cc-dropdown-search]');
    expect(search).not.toBe(initial.search);
    expect(search.value).toBe('Bra');
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

  it.each(['list', 'grid'])('preserves explicit view=%s for unrelated defaults and clears it for Desktop view', async (view) => {
    const { initial, windowObject, requests } = environment({
      month: '2026-09', status: 'planned', project: '7', weekStart: 'monday',
      explicit: { status: 'planned', project: '7', weekStart: 'monday', view },
    });
    windowObject.setLocation(`http://creatorcrate.test/calendar?month=2026-09&status=planned&project=7&weekStart=monday&view=${view}`);
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
    const desktopView = makeNode({ tagName: 'select', attrs: {
      name: 'calendarView', 'data-autosubmit': 'fetch',
    }, value: view === 'list' ? 'grid' : 'list' });
    const acknowledgement = makeNode({ attrs: { 'data-settings-fetch-save-status': '' } });
    status.form = form;
    weekStart.form = form;
    desktopView.form = form;
    form.appendChild(status);
    form.appendChild(weekStart);
    form.appendChild(desktopView);
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
    expect(enhancePageDefaultsFetchSave(initial.document, config)).toBe(3);
    expect(enhancePageDefaultsFetchSave(initial.document, config)).toBe(0);
    expect(form.listeners.filter(({ type }) => type === 'submit')).toHaveLength(0);
    status.dispatch('change');
    await flush();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch.mock.calls[0][1].body.get('calendarStatus')).toBe('published');
    expect(requests).toHaveLength(1);
    expect(requests[0].searchParams.toString()).toBe(`month=2026-09&project=7&view=${view}`);
    expect(windowObject.history.replaces).toEqual([requests[0].href]);
    expect(acknowledgement.textContent).toBe('Settings saved.');
    expect(form.getAttribute('data-settings-fetch-save-state')).toBe('saved');

    weekStart.value = 'sunday';
    weekStart.dispatch('change');
    await flush();
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(globalThis.fetch.mock.calls[1][1].body.get('calendarWeekStart')).toBe('sunday');
    expect(requests).toHaveLength(2);
    expect(requests[1].searchParams.toString()).toBe(`month=2026-09&project=7&view=${view}`);

    desktopView.value = view;
    desktopView.dispatch('change');
    await flush();
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    expect(globalThis.fetch.mock.calls[2][1].body.get('calendarView')).toBe(view);
    expect(requests).toHaveLength(3);
    expect(requests[2].searchParams.toString()).toBe('month=2026-09&project=7');
    expect(windowObject.location.href).toBe(requests[2].href);
  });

  it.each([true, false])('queues rapid default changes (Desktop view changed: %s) behind the active save', async (desktopChanged) => {
    const { initial, windowObject, requests } = environment({
      month: '2026-09', project: '7', explicit: { project: '7', view: 'list' },
    });
    windowObject.setLocation('http://creatorcrate.test/calendar?month=2026-09&project=7&view=list');
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
    const desktopView = makeNode({ tagName: 'select', attrs: {
      name: 'calendarView', 'data-autosubmit': 'fetch',
    }, value: 'list' });
    const acknowledgement = makeNode({ attrs: { 'data-settings-fetch-save-status': '' } });
    status.form = form;
    weekStart.form = form;
    desktopView.form = form;
    form.appendChild(status);
    form.appendChild(weekStart);
    form.appendChild(desktopView);
    form.appendChild(acknowledgement);
    initial.document.appendChild(form);
    let resolveFirst;
    globalThis.fetch = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementation(async () => ({
        ok: true, redirected: true, url: 'http://creatorcrate.test/settings/defaults?notice=defaults_saved',
        text: async () => '<html></html>',
      }));
    const acknowledged = [];
    enhancePageDefaultsFetchSave(initial.document, {
      formSelector: '#calendar-defaults-form', markerAttribute: 'data-calendar-defaults-fetch-save',
      beginRefresh: beginCalendarDefaultsLiveRefresh, refresh: refreshCalendarLiveRegion,
      refreshFailureMessage: 'Refresh failed.',
      onAcknowledged: (detail) => { acknowledged.push(detail); },
    });
    status.dispatch('change');
    await flush();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(acknowledgement.textContent).toBe('Saving settings.');
    if (desktopChanged) {
      desktopView.value = 'grid';
      desktopView.dispatch('change');
    }
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
    expect(globalThis.fetch.mock.calls[1][1].body.get('calendarView')).toBe(desktopChanged ? 'grid' : 'list');
    expect(globalThis.fetch.mock.calls[1][1].body.get('calendarWeekStart')).toBe('sunday');
    expect(acknowledged.map((detail) => [...detail.controlNames])).toEqual([
      ['calendarStatus'], desktopChanged ? ['calendarView', 'calendarWeekStart'] : ['calendarWeekStart'],
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0].searchParams.get('project')).toBe('7');
    expect(requests[0].searchParams.get('view')).toBe(desktopChanged ? null : 'list');
    expect(acknowledgement.textContent).toBe('Settings saved.');

    globalThis.fetch.mockImplementationOnce(async () => ({ ok: false, redirected: false, text: async () => '' }));
    status.value = 'published';
    status.dispatch('change');
    await flush();
    expect(acknowledgement.textContent).toBe('Could not save settings. Your current changes were kept.');
    expect(form.getAttribute('data-settings-fetch-save-state')).toBe('error');
    expect(requests).toHaveLength(1);
  });

  it('clears explicit view when a queued full-form save succeeds after the Desktop-view save fails', async () => {
    const { initial, windowObject, requests } = environment({
      month: '2026-09', project: '7', explicit: { project: '7', view: 'list' },
    });
    windowObject.setLocation('http://creatorcrate.test/calendar?month=2026-09&project=7&view=list');
    const form = makeNode({ tagName: 'form', attrs: {
      id: 'calendar-defaults-form', action: '/settings/defaults', method: 'post',
      'data-calendar-defaults-fetch-save': '',
    } });
    const desktopView = makeNode({ tagName: 'select', attrs: {
      name: 'calendarView', 'data-autosubmit': 'fetch',
    }, value: 'list' });
    const weekStart = makeNode({ tagName: 'select', attrs: {
      name: 'calendarWeekStart', 'data-autosubmit': 'fetch',
    }, value: 'monday' });
    desktopView.form = form;
    weekStart.form = form;
    form.appendChild(desktopView);
    form.appendChild(weekStart);
    initial.document.appendChild(form);
    let resolveFirst;
    globalThis.fetch = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementation(async () => ({
        ok: true, redirected: true, url: 'http://creatorcrate.test/settings/defaults?notice=defaults_saved',
        text: async () => '<html></html>',
      }));
    const acknowledged = [];
    enhancePageDefaultsFetchSave(initial.document, {
      formSelector: '#calendar-defaults-form', markerAttribute: 'data-calendar-defaults-fetch-save',
      beginRefresh: beginCalendarDefaultsLiveRefresh, refresh: refreshCalendarLiveRegion,
      refreshFailureMessage: 'Refresh failed.',
      onAcknowledged: (detail) => { acknowledged.push(detail); },
    });

    desktopView.value = 'grid';
    desktopView.dispatch('change');
    await flush();
    weekStart.value = 'sunday';
    weekStart.dispatch('change');
    resolveFirst({ ok: false, redirected: false, text: async () => '' });
    await flush();
    await flush();

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(globalThis.fetch.mock.calls[1][1].body.get('calendarView')).toBe('grid');
    expect(globalThis.fetch.mock.calls[1][1].body.get('calendarWeekStart')).toBe('sunday');
    expect(acknowledged.map((detail) => [...detail.controlNames])).toEqual([
      ['calendarView', 'calendarWeekStart'],
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0].searchParams.toString()).toBe('month=2026-09&project=7');
    expect(windowObject.location.href).toBe(requests[0].href);
  });

  it.each([false, true])('ends a failed save chain only when queued work is exhausted (continues: %s)', async (continues) => {
    const { initial, windowObject, requests } = environment({
      month: '2026-09', explicit: { view: 'list' },
    });
    windowObject.setLocation('http://creatorcrate.test/calendar?month=2026-09&view=list');
    const form = makeNode({ tagName: 'form', attrs: {
      id: 'calendar-defaults-form', action: '/settings/defaults', method: 'post',
      'data-calendar-defaults-fetch-save': '',
    } });
    const desktopView = makeNode({ tagName: 'select', attrs: {
      name: 'calendarView', 'data-autosubmit': 'fetch',
    }, value: 'list' });
    const weekStart = makeNode({ tagName: 'select', attrs: {
      name: 'calendarWeekStart', 'data-autosubmit': 'fetch',
    }, value: 'monday' });
    const status = makeNode({ tagName: 'select', attrs: {
      name: 'calendarStatus', 'data-autosubmit': 'fetch',
    }, value: 'planned' });
    for (const control of [desktopView, weekStart, status]) {
      control.form = form;
      form.appendChild(control);
    }
    initial.document.appendChild(form);
    const saves = [];
    globalThis.fetch = vi.fn((_url, options) => new Promise((resolve) => {
      saves.push({ body: options.body, resolve });
    }));
    const beginRefresh = vi.fn(beginCalendarDefaultsLiveRefresh);
    const refreshMetadata = [];
    const refresh = (document, url, generation, options) => {
      refreshMetadata.push(new Set(options.acknowledgedControls));
      return refreshCalendarLiveRegion(document, url, generation, options);
    };
    enhancePageDefaultsFetchSave(initial.document, {
      formSelector: '#calendar-defaults-form', markerAttribute: 'data-calendar-defaults-fetch-save',
      beginRefresh, refresh, refreshFailureMessage: 'Refresh failed.',
    });
    const success = { ok: true, redirected: true,
      url: 'http://creatorcrate.test/settings/defaults?notice=defaults_saved',
      text: async () => '<html></html>' };
    const failure = { ok: false, redirected: false, text: async () => '' };

    desktopView.value = 'grid';
    desktopView.dispatch('change');
    await flush();
    weekStart.value = 'sunday';
    weekStart.dispatch('change');
    saves[0].resolve(success);
    await flush();
    expect(saves).toHaveLength(2);
    expect(saves[1].body.get('calendarWeekStart')).toBe('sunday');
    expect(refreshMetadata).toHaveLength(0);

    if (continues) {
      status.value = 'published';
      status.dispatch('change');
    } else {
      weekStart.value = 'monday';
      weekStart.dispatch('change');
    }
    saves[1].resolve(failure);
    await flush();

    if (!continues) {
      expect(saves).toHaveLength(2);
      expect(beginRefresh).toHaveBeenCalledTimes(1);
      status.value = 'published';
      status.dispatch('change');
      await flush();
      expect(beginRefresh).toHaveBeenCalledTimes(2);
    } else {
      expect(beginRefresh).toHaveBeenCalledTimes(1);
    }
    expect(saves).toHaveLength(3);
    expect(saves[2].body.get('calendarStatus')).toBe('published');
    saves[2].resolve(success);
    await flush();

    expect(refreshMetadata).toEqual([continues
      ? new Set(['calendarView', 'calendarWeekStart', 'calendarStatus'])
      : new Set(['calendarStatus'])]);
    expect(requests).toHaveLength(1);
    expect(requests[0].searchParams.get('view')).toBe(continues ? null : 'list');
    expect(windowObject.location.href).toBe(requests[0].href);
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

  it('refreshes the exact active Calendar after a saved release edit and retries only the GET', async () => {
    const activeUrl = 'http://creatorcrate.test/calendar?month=2026-11&status=planned&weekStart=sunday&view=list&project=7';
    const { initial, windowObject, requests } = environment({
      month: '2026-11', status: 'planned', project: '7', weekStart: 'sunday',
      explicit: { month: '2026-11', status: 'planned', weekStart: 'sunday', view: 'list', project: '7' },
    });
    windowObject.setLocation(activeUrl);
    initial.document.documentElement = makeNode({ tagName: 'html' });
    const notice = makeNode({ attrs: { 'data-dialog-feedback': '' } });
    notice.classList = { toggle: vi.fn() };
    const noticeText = makeNode({ tagName: 'p', attrs: { 'data-dialog-feedback-text': '' } });
    notice.appendChild(noticeText);
    initial.document.appendChild(notice);
    initial.document.createElement = (tagName) => makeNode({ tagName });
    enhanceCalendarLiveFiltering(initial.document);
    enhanceCalendarLiveFiltering(initial.document);

    windowObject.fetch.mockImplementationOnce((url) => {
      requests.push(new URL(url));
      return Promise.resolve({ ok: false, status: 500, url, text: async () => '' });
    });
    initial.document.dispatch('release-edit-saved', { detail: { releaseId: '4' } });
    await flush();
    expect(requests).toHaveLength(1);
    expect(requests[0].href).toBe(activeUrl);
    expect(windowObject.location.href).toBe(activeUrl);
    expect(noticeText.textContent).toBe('Release saved, but Calendar could not refresh. The calendar shown may be out of date.');
    const retry = notice.querySelector('[data-calendar-edit-refresh-retry]');
    expect(retry).not.toBeNull();
    expect(windowObject.fetch.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true);

    retry.dispatch('click');
    await flush();
    expect(requests).toHaveLength(2);
    expect(requests[1].href).toBe(activeUrl);
    expect(windowObject.fetch.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true);
    expect(windowObject.location.href).toBe(activeUrl);
    expect(windowObject.history.pushes).toEqual([]);
    expect(windowObject.history.replaces).toEqual([]);
    expect(noticeText.textContent).toBe('Release updated.');
    expect(initial.document.__creatorCrateCalendarLiveFiltering.calendarEditRetryButton).toBeNull();
  });

  // WP14a: read-only request ownership for the explicit Calendar defaults
  // transport, observed through the one Calendar engine (never a second one).
  // C-F2: a monthless (or invalid-month) installed location was resolved by
  // the server when it rendered. Save / Reset defaults refresh from
  // intendedUrl, so it names the DISPLAYED month; a pending or failed
  // monthless request (Today) is newer intent and stays monthless.
  it('names the displayed month in an idle monthless intendedUrl; a pending or failed Today stays monthless (C-F2)', async () => {
    const { initial, windowObject, requests } = environment({ month: '2026-12' });
    windowObject.setLocation('http://creatorcrate.test/calendar?defaults=1&project=7&project=12&view=list');
    const idle = new URL(calendarLiveSnapshot(initial.document).intendedUrl);
    expect(idle.pathname).toBe('/calendar');
    expect(idle.searchParams.getAll('month')).toEqual(['2026-12']);
    expect(idle.searchParams.getAll('project')).toEqual(['7', '12']);
    expect(idle.searchParams.get('view')).toBe('list');
    expect(idle.searchParams.get('defaults')).toBe('1');
    // An invalid or repeated month is replaced by the one displayed.
    windowObject.setLocation('http://creatorcrate.test/calendar?month=bogus&month=2026-01&type=comic');
    const invalid = new URL(calendarLiveSnapshot(initial.document).intendedUrl);
    expect(invalid.searchParams.getAll('month')).toEqual(['2026-12']);
    expect(invalid.searchParams.getAll('type')).toEqual(['comic']);
    // An explicit month equal to the displayed one is the location unchanged.
    windowObject.setLocation('http://creatorcrate.test/calendar?project=7&month=2026-12&view=list');
    expect(calendarLiveSnapshot(initial.document).intendedUrl)
      .toBe('http://creatorcrate.test/calendar?project=7&month=2026-12&view=list');
    // Reading the snapshot never navigates, writes history or requests.
    expect(requests).toEqual([]);
    expect(windowObject.history.pushes).toEqual([]);
    expect(windowObject.history.replaces).toEqual([]);

    // A pending monthless Today keeps the server's resolution.
    let resolveToday;
    windowObject.fetch.mockImplementationOnce((url) => {
      requests.push(new URL(url));
      return new Promise((resolve) => { resolveToday = resolve; });
    });
    expect(navigateCalendarLive(initial.document, '/calendar?project=7').status).toBe('started');
    await flush();
    const pending = calendarLiveSnapshot(initial.document);
    expect(pending.pending).toBe(true);
    expect(new URL(pending.intendedUrl).searchParams.has('month')).toBe(false);

    // So does a failed one: Retry repeats Today, never the old month.
    resolveToday({ ok: false, status: 503, url: requests.at(-1).href, text: async () => '' });
    await flush();
    const failed = calendarLiveSnapshot(initial.document);
    expect(failed.failed).toBe(true);
    expect(new URL(failed.intendedUrl).searchParams.has('month')).toBe(false);
    expect(windowObject.fetch.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true);
  });

  it('reports Calendar request lifecycle to defaults observers and navigates GET-only (WP14a)', async () => {
    const { initial, windowObject, requests } = environment();
    const events = [];
    const unsubscribe = subscribeCalendarLive(initial.document, (detail) => events.push(detail));
    expect(typeof unsubscribe).toBe('function');
    const idle = calendarLiveSnapshot(initial.document);
    expect(idle).toMatchObject({ pending: false, failed: false, intendedUrl: 'http://creatorcrate.test/calendar?month=2026-09' });

    let resolveNavigation;
    windowObject.fetch.mockImplementationOnce((url) => {
      requests.push(new URL(url));
      return new Promise((resolve) => { resolveNavigation = resolve; });
    });
    initial.links.next.dispatch('click', { button: 0 });
    await flush();
    const pending = calendarLiveSnapshot(initial.document);
    expect(pending.pending).toBe(true);
    expect(new URL(pending.intendedUrl).searchParams.get('month')).toBe('2026-10');
    const started = events.filter((event) => event.phase === 'started');
    expect(started).toHaveLength(1);

    // A newer canonical navigation supersedes the pending month GET.
    const outcome = navigateCalendarLive(initial.document,
      '/calendar?month=2026-09&project=7&project=12&type=comic', { historyMode: 'replace' });
    expect(outcome.status).toBe('started');
    expect(outcome.generation).toBeGreaterThan(started[0].generation);
    expect(events.some((event) => event.phase === 'superseded' && event.generation === started[0].generation)).toBe(true);
    await flush();
    expect(requests.at(-1).searchParams.getAll('project')).toEqual(['7', '12']);
    expect(requests.at(-1).searchParams.get('month')).toBe('2026-09');
    expect(events.filter((event) => event.phase === 'installed').map((event) => event.generation))
      .toEqual([outcome.generation]);
    // The superseded response never installs over the newer one.
    resolveNavigation({ ok: true, url: requests[0].href, text: async () => 'stale' });
    await flush();
    expect(initial.document.querySelector('[data-calendar-month-heading]').textContent).toBe('2026-09');
    expect(events.filter((event) => event.phase === 'installed')).toHaveLength(1);

    // Only /calendar destinations; every request is a GET (no defaults POST).
    expect(navigateCalendarLive(initial.document, '/releases').status).toBe('unavailable');
    initial.options.status.planned.checked = true;
    initial.options.status.all.checked = false;
    initial.options.status.planned.dispatch('change');
    await flush();
    expect(windowObject.fetch.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
    expect(windowObject.fetch.mock.calls.every(([url]) => new URL(url).pathname === '/calendar')).toBe(true);

    unsubscribe();
    const count = events.length;
    navigateCalendarLive(initial.document, '/calendar?month=2026-11');
    await flush();
    expect(events).toHaveLength(count);
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

  // C4: Reset filters through the REAL Calendar engine on a page whose
  // defaults authority is missing (this fake page renders none, nor do its
  // responses). The displayed month — never bare /calendar — is kept.
  describe('C4 Reset filters without defaults authority', () => {
    const MONTH = '2031-07';
    const FILTERED = `http://creatorcrate.test/calendar?month=${MONTH}&project=7&status=planned&view=list&weekStart=sunday`;

    function resetEnvironment() {
      const env = environment({
        month: MONTH, status: 'planned', project: '7', weekStart: 'sunday',
        explicit: { month: MONTH, project: '7', status: 'planned', view: 'list', weekStart: 'sunday' },
      });
      env.windowObject.setLocation(FILTERED);
      const defaultsFetch = vi.fn();
      const controller = createCalendarFiltersDefaults(env.initial.document, { fetch: defaultsFetch });
      const region = () => env.initial.document.querySelector('[data-calendar-live-region]');
      return { ...env, controller, defaultsFetch, region };
    }

    it('navigates GET-only to the displayed month alone and installs it', async () => {
      const { controller, requests, windowObject, defaultsFetch, region } = resetEnvironment();
      expect(controller.resetFilters().outcome).toBe('started');
      await flush();
      expect(requests).toHaveLength(1);
      // Projects / Types and the three settings are dropped; the month stays.
      expect([...requests[0].searchParams.entries()]).toEqual([['month', MONTH]]);
      expect(windowObject.fetch.mock.calls[0][1].method).toBe('GET');
      expect(region().getAttribute('data-calendar-month')).toBe(MONTH);
      expect(windowObject.history.pushes).toEqual([`http://creatorcrate.test/calendar?month=${MONTH}`]);
      expect(windowObject.location.href).toBe(`http://creatorcrate.test/calendar?month=${MONTH}`);
      // The installed response still has no authority: Save stays fail-closed.
      expect(controller.filtersReset).toMatchObject({ phase: 'incomplete' });
      expect((await controller.save()).outcome).toBe('blocked');
      expect(defaultsFetch).not.toHaveBeenCalled();
    });

    it('keeps the installed Calendar when the Reset GET fails; the GET-only Retry repeats the month-only address', async () => {
      const { controller, requests, windowObject, defaultsFetch, region, initial } = resetEnvironment();
      windowObject.fetch.mockImplementationOnce((url) => {
        requests.push(new URL(url));
        return Promise.reject(new Error('offline'));
      });
      controller.resetFilters();
      await flush();
      expect(controller.filtersReset).toMatchObject({ phase: 'failed' });
      expect(region().getAttribute('data-calendar-month')).toBe(MONTH);
      expect(windowObject.location.href).toBe(FILTERED);
      expect(windowObject.history.pushes).toEqual([]);

      liveFailureRetries(initial.document)[0].dispatch('click');
      await flush();
      expect(requests).toHaveLength(2);
      expect(requests[1].href).toBe(requests[0].href);
      expect([...requests[1].searchParams.entries()]).toEqual([['month', MONTH]]);
      expect(windowObject.fetch.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true);
      expect(windowObject.location.href).toBe(`http://creatorcrate.test/calendar?month=${MONTH}`);
      expect(liveFailureNotice(initial.document)).toBeNull();
      expect(defaultsFetch).not.toHaveBeenCalled();
    });

    it('lets a newer month navigation supersede a pending Reset; the late Reset response never installs', async () => {
      const { controller, requests, windowObject, defaultsFetch, region, initial } = resetEnvironment();
      let resolveReset;
      windowObject.fetch.mockImplementationOnce((url) => {
        requests.push(new URL(url));
        return new Promise((resolve) => { resolveReset = resolve; });
      });
      controller.resetFilters();
      await flush();
      expect(controller.filtersReset).toMatchObject({ phase: 'pending' });
      initial.links.next.dispatch('click', { button: 0 });
      await flush();
      expect(controller.filtersReset).toBeNull();
      expect(region().getAttribute('data-calendar-month')).toBe('2026-10');
      resolveReset({ ok: true, url: requests[0].href, text: async () => 'stale' });
      await flush();
      expect(region().getAttribute('data-calendar-month')).toBe('2026-10');
      // Back starts a newer GET for the restored location; Reset stays settled.
      windowObject.setLocation(FILTERED);
      windowObject.dispatch('popstate');
      await flush();
      expect(requests.at(-1).searchParams.get('month')).toBe(MONTH);
      expect(requests.at(-1).searchParams.get('project')).toBe('7');
      expect(region().getAttribute('data-calendar-month')).toBe(MONTH);
      expect(controller.filtersReset).toBeNull();
      expect(defaultsFetch).not.toHaveBeenCalled();
    });

    it('refuses without navigating when the displayed month cannot be read', async () => {
      const { controller, requests, windowObject, defaultsFetch, region } = resetEnvironment();
      region().removeAttribute('data-calendar-month');
      const statuses = [];
      const refused = createCalendarFiltersDefaults(region().ownerDocument, {
        fetch: defaultsFetch, onStatus: (message, kind) => statuses.push({ message, kind }),
      });
      expect(refused.resetFilters().outcome).toBe('blocked');
      expect(controller.filtersReset).toBeNull();
      await flush();
      expect(requests).toEqual([]);
      expect(windowObject.location.href).toBe(FILTERED);
      expect(statuses.at(-1)).toEqual({
        message: 'Filters could not be reset because the displayed month could not be read. Reload the page, then reset filters again.',
        kind: 'error',
      });
      expect(defaultsFetch).not.toHaveBeenCalled();
    });
  });
});

// R2: Calendar month and filter navigation compose the latest intent through
// the REAL Calendar engine, regardless of request completion order. Each
// fake response renders the Calendar the route would: its month, its Project
// / Project Type checkboxes, status / View / week start radios, and the
// release events (by ID) matching every filter; its Previous / Today / Next
// and View links are rendered against that installed Calendar only.
describe('R2 Calendar navigation preserves the latest intent', () => {
  const ORIGIN = 'http://creatorcrate.test';
  // R6: the month the fake server resolves a monthless (Today) Calendar to.
  let TODAY_MONTH = '2031-07';
  const PROJECT_TYPES = { 1: 'comic', 2: 'images', 3: 'comic' };
  const RELEASES = [
    { id: 101, project: '1', month: '2031-07', status: 'planned' },
    { id: 102, project: '2', month: '2031-07', status: 'published' },
    { id: 103, project: '3', month: '2031-07', status: 'planned' },
    { id: 201, project: '1', month: '2031-08', status: 'planned' },
    { id: 202, project: '2', month: '2031-08', status: 'planned' },
    { id: 203, project: '3', month: '2031-08', status: 'published' },
    { id: 204, project: '1', month: '2031-08', status: 'published' },
    { id: 301, project: '1', month: '2031-09', status: 'planned' },
    { id: 601, project: '2', month: '2031-06', status: 'published' },
    { id: 602, project: '1', month: '2031-06', status: 'planned' },
    // R6: contrasting years for the effective Today month.
    { id: 701, project: '1', month: '2026-06', status: 'planned' },
    { id: 702, project: '2', month: '2026-06', status: 'published' },
    { id: 703, project: '3', month: '2026-06', status: 'planned' },
    { id: 801, project: '1', month: '2026-11', status: 'planned' },
    { id: 901, project: '2', month: '2026-12', status: 'planned' },
    { id: 902, project: '1', month: '2027-01', status: 'planned' },
    { id: 903, project: '1', month: '2027-12', status: 'planned' },
    { id: 904, project: '2', month: '2026-01', status: 'planned' },
    { id: 905, project: '1', month: '2031-12', status: 'planned' },
    // C-F1: the months a picked month reaches in the server's next year.
    { id: 1101, project: '1', month: '2027-06', status: 'planned' },
    { id: 1102, project: '2', month: '2027-06', status: 'published' },
    { id: 1103, project: '3', month: '2027-06', status: 'planned' },
    { id: 1201, project: '1', month: '2027-08', status: 'planned' },
    { id: 1301, project: '1', month: '2026-10', status: 'planned' },
  ];
  // R4: saved Calendar defaults the fake server resolves for an omitted
  // status / View / week start (null: the application fallbacks).
  let SAVED = null;
  // Cumulative closure P2: when set, the complete installed defaults authority
  // (generation included) each rendered page carries, from its state.
  let RENDER_AUTHORITY = null;
  const shift = (month, delta) => {
    const [year, number] = month.split('-').map(Number);
    const date = new Date(Date.UTC(year, number - 1 + delta, 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  };

  function resolved(params) {
    // As getReleaseCalendar: a missing or invalid month is the current month.
    const requested = params.get('month');
    return {
      month: /^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(requested || '') ? requested : TODAY_MONTH,
      projects: params.getAll('project').filter(Boolean),
      types: params.getAll('type').filter(Boolean),
      status: params.get('status') || SAVED?.status || 'all',
      view: params.get('view') || SAVED?.view || 'grid',
      weekStart: params.get('weekStart') || SAVED?.weekStart || 'monday',
    };
  }

  function matchingIds(state) {
    return RELEASES.filter((release) => release.month === state.month
      && (state.projects.length === 0 || state.projects.includes(release.project))
      && (state.types.length === 0 || state.types.includes(PROJECT_TYPES[release.project]))
      && (state.status === 'all' || state.status === release.status))
      .map((release) => release.id);
  }

  function href(state, overrides) {
    const params = new URLSearchParams();
    const next = { ...state, ...overrides };
    if (next.month) params.set('month', next.month);
    next.projects.forEach((value) => params.append('project', value));
    next.types.forEach((value) => params.append('type', value));
    params.set('status', next.status);
    params.set('view', next.view);
    params.set('weekStart', next.weekStart);
    return `/calendar?${params}`;
  }

  function renderPage(state) {
    const document = makeNode({ tagName: 'document' });
    document.nodeType = 9;
    document.ownerDocument = document;
    document.activeElement = null;
    document.getElementById = (id) => document.querySelector(`#${id}`);
    const region = makeNode({ attrs: {
      'data-calendar-live-region': '', 'data-calendar-month': state.month, 'data-calendar-current-month': TODAY_MONTH,
    } });
    region.appendChild(makeNode({ attrs: { 'data-calendar-live-status': '' } }));
    const renderedAuthority = RENDER_AUTHORITY ? RENDER_AUTHORITY(state) : SAVED && {
      page: 'calendar',
      generation: 0,
      revision: 'saved',
      current: { view: state.view, status: state.status, weekStart: state.weekStart },
      currentUrl: href(state, {}),
      defaults: SAVED,
      fallbacks: { view: 'grid', status: 'all', weekStart: 'monday' },
      saved: Object.fromEntries(Object.keys(SAVED).map((field) => [field, { stored: true, valid: true }])),
      savedKeys: ['view', 'status', 'weekStart'],
    };
    if (renderedAuthority) {
      const authority = makeNode({ tagName: 'script', attrs: { 'data-calendar-defaults-authority': '' } });
      authority.textContent = typeof renderedAuthority === 'string' ? renderedAuthority : JSON.stringify(renderedAuthority);
      region.appendChild(authority);
    }
    region.setAttribute('data-calendar-week-start', state.weekStart);
    region.setAttribute('data-calendar-view', state.view);
    const heading = makeNode({ tagName: 'h2', attrs: { 'data-calendar-month-heading': '' } });
    heading.textContent = state.month;
    region.appendChild(heading);
    const switcher = makeNode({ attrs: { class: 'calendar-view-switcher' } });
    for (const view of ['grid', 'list']) {
      switcher.appendChild(makeNode({ tagName: 'a', attrs: { id: `calendar-view-link-${view}`, href: href(state, { view }) } }));
    }
    region.appendChild(switcher);
    for (const [name, month] of [['previous', shift(state.month, -1)], ['today', null], ['next', shift(state.month, 1)]]) {
      region.appendChild(makeNode({ tagName: 'a', attrs: {
        id: `calendar-${name}`, href: href(state, { month }), 'data-calendar-navigation': '',
      } }));
    }
    const ids = matchingIds(state);
    for (const id of ids) region.appendChild(makeNode({ attrs: { 'data-calendar-event-id': String(id) } }));
    const count = makeNode({ attrs: { 'data-calendar-count': '' } });
    count.textContent = String(ids.length);
    region.appendChild(count);

    const form = makeNode({ tagName: 'form', attrs: { id: 'calendar-filters', action: '/calendar' } });
    form.requestSubmit = () => form.dispatch('submit');
    form.appendChild(makeNode({ tagName: 'input', attrs: { name: 'month', type: 'hidden' }, value: state.month }));
    const choices = [
      ['project', 'checkbox', ['1', '2', '3'], state.projects],
      ['type', 'checkbox', ['comic', 'images'], state.types],
      ['status', 'radio', ['all', 'planned', 'published'], [state.status]],
      ['view', 'radio', ['grid', 'list'], [state.view]],
      ['weekStart', 'radio', ['monday', 'sunday'], [state.weekStart]],
    ];
    for (const [name, type, values, selected] of choices) {
      for (const value of values) {
        form.appendChild(makeNode({ tagName: 'input', attrs: {
          id: `calendar-${name}-${value}`, name, type, value,
        }, checked: selected.includes(value) }));
      }
    }
    const resetForm = makeNode({ tagName: 'form', attrs: { action: '/calendar' } });
    resetForm.appendChild(makeNode({ tagName: 'input', attrs: { name: 'month', type: 'hidden', value: state.month } }));
    resetForm.appendChild(makeNode({ tagName: 'button', attrs: { 'data-calendar-filters-reset': '', type: 'submit' } }));
    const dialog = makeNode({ tagName: 'dialog' });
    dialog.appendChild(form);
    dialog.appendChild(resetForm);
    document.appendChild(region);
    document.appendChild(dialog);
    return { document };
  }

  let oldDocument;
  let oldFormData;
  beforeEach(() => {
    oldDocument = globalThis.document;
    oldFormData = globalThis.FormData;
    SAVED = null;
    RENDER_AUTHORITY = null;
    TODAY_MONTH = '2031-07';
  });
  afterEach(() => {
    globalThis.document = oldDocument;
    globalThis.FormData = oldFormData;
    SAVED = null;
    RENDER_AUTHORITY = null;
    TODAY_MONTH = '2031-07';
  });

  const INITIAL = `${ORIGIN}${href(resolved(new URLSearchParams('month=2031-07')), {})}`;
  const HTML_HEADERS = { get: (name) => (String(name).toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) };

  // Every request is held until the test settles it, in any order.
  function r2Environment(initialUrl = INITIAL) {
    const initialState = resolved(new URL(initialUrl).searchParams);
    const { document } = renderPage(initialState);
    const pages = new Map();
    const windowObject = makeWindow(document, pages);
    windowObject.setLocation(initialUrl);
    globalThis.document = document;
    globalThis.FormData = windowObject.FormData;
    const requests = [];
    let counter = 0;
    windowObject.fetch.mockImplementation((requestedUrl, options) => {
      const url = new URL(requestedUrl);
      let settle;
      const promise = new Promise((resolve, reject) => { settle = { resolve, reject }; });
      requests.push({
        url,
        options,
        respond() {
          const key = `r2-page-${++counter}`;
          pages.set(key, renderPage(resolved(url.searchParams)));
          settle.resolve({ ok: true, url: url.href, headers: HTML_HEADERS, text: async () => key });
        },
        // C-F1: an answer that is not a usable Calendar page.
        respondWith(response) { settle.resolve(response); },
        fail() { settle.reject(new Error('offline')); },
      });
      return promise;
    });
    enhanceCalendarLiveFiltering(document);
    const region = () => document.querySelector('[data-calendar-live-region]');
    const form = () => document.querySelector('#calendar-filters');
    const control = (name, value) => form().querySelector(`#calendar-${name}-${value}`);
    const toggle = (name, value, checked = true) => {
      const input = control(name, value);
      if (input.type === 'radio') {
        form().querySelectorAll(`input[name="${name}"]`).forEach((other) => { other.checked = false; });
      }
      input.checked = checked;
      input.dispatch('change');
    };
    const click = (id) => document.querySelector(`#${id}`).dispatch('click', { button: 0 });
    const installed = () => ({
      month: region().getAttribute('data-calendar-month'),
      heading: region().querySelector('[data-calendar-month-heading]').textContent,
      ids: region().querySelectorAll('[data-calendar-event-id]').map((node) => Number(node.getAttribute('data-calendar-event-id'))),
      count: region().querySelector('[data-calendar-count]').textContent,
      location: windowObject.location.href,
      checked: (name) => form().querySelectorAll(`input[name="${name}"]`).filter((input) => input.checked).map((input) => input.value),
    });
    return { document, windowObject, requests, region, form, control, toggle, click, installed, pages };
  }

  const all = (url, key) => url.searchParams.getAll(key);
  const keys = (url) => [...url.searchParams.keys()];
  const onlyGets = (windowObject) => windowObject.fetch.mock.calls.every(([, options]) => options.method === 'GET');

  it('TEST A: Next month while a Project 1 filter GET is held keeps Project 1; the old response is ignored', async () => {
    const env = r2Environment();
    env.toggle('project', '1');
    await flush();
    expect(env.requests).toHaveLength(1);
    expect(all(env.requests[0].url, 'project')).toEqual(['1']);

    env.click('calendar-next');
    await flush();
    expect(env.requests).toHaveLength(2);
    const second = env.requests[1].url;
    expect(second.searchParams.get('month')).toBe('2031-08');
    expect(all(second, 'project')).toEqual(['1']);
    expect(all(second, 'project')).not.toContain('2');

    env.requests[1].respond();
    await flush();
    const afterSecond = env.installed();
    expect(afterSecond.month).toBe('2031-08');
    expect(afterSecond.heading).toBe('2031-08');
    expect(afterSecond.ids).toEqual([201, 204]);
    expect(afterSecond.count).toBe('2');
    expect(afterSecond.checked('project')).toEqual(['1']);
    expect(new URL(afterSecond.location).searchParams.get('month')).toBe('2031-08');
    expect(all(new URL(afterSecond.location), 'project')).toEqual(['1']);

    env.requests[0].respond();
    await flush();
    const afterStale = env.installed();
    expect(afterStale.month).toBe('2031-08');
    expect(afterStale.ids).toEqual([201, 204]);
    expect(afterStale.location).toBe(afterSecond.location);
    expect(afterStale.checked('project')).toEqual(['1']);
    expect(env.windowObject.history.pushes).toEqual([second.href]);
    expect(onlyGets(env.windowObject)).toBe(true);
  });

  it('TEST B: selecting Project 1 while an August GET is held keeps August; the old response is ignored', async () => {
    const env = r2Environment();
    env.click('calendar-next');
    await flush();
    expect(env.requests[0].url.searchParams.get('month')).toBe('2031-08');

    env.toggle('project', '1');
    await flush();
    expect(env.requests).toHaveLength(2);
    const second = env.requests[1].url;
    expect(second.searchParams.get('month')).toBe('2031-08');
    expect(all(second, 'project')).toEqual(['1']);
    expect(keys(second).filter((key) => key === 'month')).toHaveLength(1);

    env.requests[1].respond();
    await flush();
    const afterSecond = env.installed();
    expect(afterSecond.month).toBe('2031-08');
    expect(afterSecond.ids).toEqual([201, 204]);
    expect(afterSecond.checked('project')).toEqual(['1']);

    env.requests[0].respond();
    await flush();
    const afterStale = env.installed();
    expect(afterStale.month).toBe('2031-08');
    expect(afterStale.ids).toEqual([201, 204]);
    expect(afterStale.checked('project')).toEqual(['1']);
    expect(afterStale.location).toBe(afterSecond.location);
    expect(onlyGets(env.windowObject)).toBe(true);
  });

  it('composes repeated Projects / Types, status, View and week start through month navigation without duplicates', async () => {
    const env = r2Environment();
    env.toggle('project', '1');
    env.toggle('project', '3');
    env.toggle('type', 'comic');
    env.toggle('status', 'planned');
    env.toggle('view', 'list');
    env.toggle('weekStart', 'sunday');
    await flush();
    expect(env.requests).toHaveLength(6);
    env.click('calendar-next');
    await flush();
    const composed = env.requests[6].url;
    expect(composed.searchParams.get('month')).toBe('2031-08');
    expect(all(composed, 'project')).toEqual(['1', '3']);
    expect(all(composed, 'type')).toEqual(['comic']);
    expect(composed.searchParams.get('status')).toBe('planned');
    expect(composed.searchParams.get('view')).toBe('list');
    expect(composed.searchParams.get('weekStart')).toBe('sunday');
    for (const key of ['month', 'status', 'view', 'weekStart']) expect(all(composed, key)).toHaveLength(1);
    expect(composed.search).not.toMatch(/%2C|,/);

    env.requests[6].respond();
    await flush();
    // Older responses settle last, in reverse: none installs.
    for (let index = 5; index >= 0; index -= 1) env.requests[index].respond();
    await flush();
    const result = env.installed();
    expect(result.month).toBe('2031-08');
    expect(result.ids).toEqual([201]);
    expect(result.checked('project')).toEqual(['1', '3']);
    expect(result.checked('type')).toEqual(['comic']);
    expect(result.checked('status')).toEqual(['planned']);
    expect(result.checked('view')).toEqual(['list']);
    expect(result.checked('weekStart')).toEqual(['sunday']);
  });

  it('applies several filter edits, including a deselection, to a held month navigation', async () => {
    const env = r2Environment(`${ORIGIN}/calendar?month=2031-07&project=1&project=2&status=all&view=grid&weekStart=monday`);
    env.click('calendar-next');
    await flush();
    env.toggle('project', '2', false);
    env.toggle('project', '3');
    env.toggle('type', 'comic');
    env.toggle('weekStart', 'sunday');
    await flush();
    const latest = env.requests.at(-1).url;
    expect(latest.searchParams.get('month')).toBe('2031-08');
    expect(all(latest, 'project')).toEqual(['1', '3']);
    expect(all(latest, 'type')).toEqual(['comic']);
    expect(latest.searchParams.get('weekStart')).toBe('sunday');
    env.requests.at(-1).respond();
    await flush();
    env.requests.slice(0, -1).reverse().forEach((request) => request.respond());
    await flush();
    const result = env.installed();
    expect(result.month).toBe('2031-08');
    expect(result.ids).toEqual([201, 203, 204]);
    expect(result.checked('project')).toEqual(['1', '3']);
    expect(result.checked('weekStart')).toEqual(['sunday']);
  });

  it('a third action supersedes both: the latest month and the latest filters compose', async () => {
    const env = r2Environment();
    env.toggle('project', '1');
    await flush();
    env.click('calendar-next');
    await flush();
    env.toggle('status', 'published');
    await flush();
    const third = env.requests[2].url;
    expect(third.searchParams.get('month')).toBe('2031-08');
    expect(all(third, 'project')).toEqual(['1']);
    expect(third.searchParams.get('status')).toBe('published');
    env.requests[1].respond();
    env.requests[0].respond();
    await flush();
    expect(env.installed().month).toBe('2031-07');
    env.requests[2].respond();
    await flush();
    expect(env.installed().ids).toEqual([204]);
    expect(env.installed().month).toBe('2031-08');
  });

  it('Today and the toolbar View keep a held filter; Previous keeps it after Today', async () => {
    const env = r2Environment(`${ORIGIN}/calendar?month=2031-09&status=all&view=grid&weekStart=monday`);
    env.toggle('project', '1');
    await flush();
    env.click('calendar-today');
    await flush();
    const today = env.requests[1].url;
    expect(today.searchParams.has('month')).toBe(false);
    expect(all(today, 'project')).toEqual(['1']);
    // A filter edit while Today is held keeps Today (no month) too.
    env.toggle('type', 'comic');
    await flush();
    expect(env.requests[2].url.searchParams.has('month')).toBe(false);
    expect(all(env.requests[2].url, 'project')).toEqual(['1']);
    env.click('calendar-view-link-list');
    await flush();
    const view = env.requests[3].url;
    expect(view.searchParams.get('view')).toBe('list');
    expect(view.searchParams.has('month')).toBe(false);
    expect(all(view, 'project')).toEqual(['1']);
    expect(all(view, 'type')).toEqual(['comic']);
    // A later filter edit keeps the clicked View.
    env.toggle('status', 'planned');
    await flush();
    expect(env.requests[4].url.searchParams.get('view')).toBe('list');
    env.requests[4].respond();
    await flush();
    expect(env.installed().month).toBe(TODAY_MONTH);
    expect(env.installed().ids).toEqual([101]);
    expect(env.installed().checked('view')).toEqual(['list']);
  });

  it('the month picker composes with a held filter, and the displayed month supersedes a held month', async () => {
    const env = r2Environment();
    const picker = attachMonthPicker(env.document);
    picker.dropdown.appendChild(makeNode({ tagName: 'input', attrs: { type: 'radio', value: '07' } }));
    enhanceCalendarLiveFiltering(env.document);
    env.toggle('project', '1');
    await flush();
    picker.open();
    picker.year.value = '2031';
    picker.dropdown.querySelectorAll('input[type="radio"]').forEach((option) => { option.checked = false; });
    picker.months['09'].checked = true;
    picker.months['09'].dispatch('change');
    await flush();
    const picked = env.requests[1].url;
    expect(picked.searchParams.get('month')).toBe('2031-09');
    expect(all(picked, 'project')).toEqual(['1']);

    // While September is held, the picker opens on it; choosing the displayed
    // July is newer intent and supersedes September.
    picker.open();
    expect(picker.months['09'].checked).toBe(true);
    picker.months['09'].checked = false;
    const july = picker.dropdown.querySelector('input[value="07"]');
    july.checked = true;
    july.dispatch('change');
    await flush();
    expect(env.requests).toHaveLength(3);
    expect(env.requests[2].url.searchParams.get('month')).toBe('2031-07');
    expect(all(env.requests[2].url, 'project')).toEqual(['1']);
    env.requests[1].respond();
    env.requests[2].respond();
    await flush();
    expect(env.installed().month).toBe('2031-07');
    expect(env.installed().ids).toEqual([101]);
  });

  it('a failed month GET keeps the installed Calendar; a filter edit keeps the failed month; Retry is GET-only', async () => {
    const env = r2Environment();
    env.click('calendar-next');
    await flush();
    env.requests[0].fail();
    await flush();
    expect(env.installed().month).toBe('2031-07');
    expect(liveFailureRetries(env.document)).toHaveLength(1);

    env.toggle('project', '1');
    await flush();
    const composed = env.requests[1].url;
    expect(composed.searchParams.get('month')).toBe('2031-08');
    expect(all(composed, 'project')).toEqual(['1']);
    env.requests[1].fail();
    await flush();
    expect(env.installed().month).toBe('2031-07');
    expect(env.installed().ids).toEqual([101, 102, 103]);
    // The installed Calendar is kept, the intended controls are not reverted.
    expect(env.installed().checked('project')).toEqual(['1']);

    liveFailureRetries(env.document)[0].dispatch('click');
    await flush();
    expect(env.requests[2].url.href).toBe(composed.href);
    env.requests[2].respond();
    await flush();
    expect(env.installed().month).toBe('2031-08');
    expect(env.installed().ids).toEqual([201, 204]);
    expect(onlyGets(env.windowObject)).toBe(true);
    expect(liveFailureNotice(env.document)).toBeNull();
  });

  it('a failed filter GET is kept by a later month navigation; an aborted first request never installs', async () => {
    const env = r2Environment();
    env.toggle('type', 'images');
    await flush();
    env.requests[0].fail();
    await flush();
    expect(env.installed().month).toBe('2031-07');
    env.click('calendar-next');
    await flush();
    const composed = env.requests[1].url;
    expect(composed.searchParams.get('month')).toBe('2031-08');
    expect(all(composed, 'type')).toEqual(['images']);
    env.click('calendar-previous');
    await flush();
    // The second request was superseded (aborted); the third keeps the type.
    expect(env.requests[2].url.searchParams.get('month')).toBe('2031-06');
    expect(all(env.requests[2].url, 'type')).toEqual(['images']);
    env.requests[2].respond();
    env.requests[1].respond();
    await flush();
    expect(env.installed().month).toBe('2031-06');
    expect(env.installed().checked('type')).toEqual(['images']);
  });

  it('Back and Forward after a composed navigation reinstall each history entry; Back supersedes a held navigation', async () => {
    const env = r2Environment();
    env.toggle('project', '1');
    await flush();
    env.click('calendar-next');
    await flush();
    env.requests[1].respond();
    await flush();
    const august = env.installed().location;

    env.windowObject.setLocation(INITIAL);
    env.windowObject.dispatch('popstate');
    await flush();
    expect(env.requests[2].url.href).toBe(INITIAL);
    // A filter edit while Back is held composes with the restored entry: its
    // month AND its (unrestricted) Projects. R4: the abandoned August entry's
    // Project 1 is not reinstated; only the newly selected Project 2 applies.
    env.toggle('project', '2');
    await flush();
    expect(env.requests[3].url.searchParams.get('month')).toBe('2031-07');
    expect(all(env.requests[3].url, 'project')).toEqual(['2']);
    env.requests[3].respond();
    env.requests[2].respond();
    await flush();
    expect(env.installed().month).toBe('2031-07');
    expect(env.installed().ids).toEqual([102]);
    expect(env.installed().checked('project')).toEqual(['2']);

    env.windowObject.setLocation(august);
    env.windowObject.dispatch('popstate');
    await flush();
    env.click('calendar-previous');
    await flush();
    // Previous during a held Forward composes on the Forward entry.
    expect(env.requests[5].url.searchParams.get('month')).toBe('2031-06');
    expect(all(env.requests[5].url, 'project')).toEqual(['1']);
    env.windowObject.setLocation(august);
    env.windowObject.dispatch('popstate');
    await flush();
    env.requests[6].respond();
    env.requests[5].respond();
    env.requests[4].respond();
    await flush();
    expect(env.installed().month).toBe('2031-08');
    expect(env.installed().ids).toEqual([201, 204]);
    expect(env.installed().location).toBe(august);
  });

  it('a held Reset filters is not undone by month navigation: Projects / Types stay cleared', async () => {
    const env = r2Environment(`${ORIGIN}/calendar?month=2031-07&project=1&type=comic&status=planned&view=list&weekStart=sunday`);
    expect(navigateCalendarLive(env.document, '/calendar?month=2031-07').status).toBe('started');
    await flush();
    env.click('calendar-next');
    await flush();
    const next = env.requests[1].url;
    expect([...next.searchParams.entries()]).toEqual([['month', '2031-08']]);
    env.requests[1].respond();
    env.requests[0].respond();
    await flush();
    expect(env.installed().month).toBe('2031-08');
    expect(env.installed().checked('project')).toEqual([]);
    expect(env.installed().checked('type')).toEqual([]);
    expect(env.installed().ids).toEqual([201, 202, 203, 204]);
    expect(onlyGets(env.windowObject)).toBe(true);
  });

  it('reports a held month as the intended Calendar for defaults Save context', async () => {
    const env = r2Environment();
    env.toggle('project', '1');
    await flush();
    env.click('calendar-next');
    await flush();
    const snapshot = calendarLiveSnapshot(env.document);
    expect(snapshot.pending).toBe(true);
    const intended = new URL(snapshot.intendedUrl);
    expect(intended.searchParams.get('month')).toBe('2031-08');
    expect(all(intended, 'project')).toEqual(['1']);
  });

  describe('R4 a later action composes with a pending / failed Reset filters or history destination', () => {
    // Current Grid / Planned / Monday with Projects 1+2 and both Types (only
    // 101 matches); saved List / All / Sunday. Reset filters is the
    // month-only GET the defaults adapter sends through navigateCalendarLive.
    const PRE_RESET = `${ORIGIN}/calendar?month=2031-07&project=1&project=2&type=comic&type=images&status=planned&view=grid&weekStart=monday`;
    const RESET = '/calendar?month=2031-07';
    const presentation = (url) => ['status', 'view', 'weekStart'].filter((key) => url.searchParams.has(key));

    function resetEnvironment() {
      SAVED = { view: 'list', status: 'all', weekStart: 'sunday' };
      const env = r2Environment(PRE_RESET);
      expect(env.installed().ids).toEqual([101]);
      expect(navigateCalendarLive(env.document, RESET).status).toBe('started');
      return env;
    }

    function expectResetControls(env) {
      expect(env.installed().checked('project')).toEqual([]);
      expect(env.installed().checked('type')).toEqual([]);
      expect(env.installed().checked('status')).toEqual(['all']);
      expect(env.installed().checked('view')).toEqual(['list']);
      expect(env.installed().checked('weekStart')).toEqual(['sunday']);
    }

    it('A/L/N: Reset pending → Project 3 sends only Project 3; saved presentation applies; the old Reset never reinstalls', async () => {
      const env = resetEnvironment();
      await flush();
      // The pending Reset destination is mirrored into the form at once.
      expectResetControls(env);
      env.toggle('project', '3');
      await flush();
      const composed = env.requests[1].url;
      expect([...composed.searchParams.entries()]).toEqual([['month', '2031-07'], ['project', '3']]);
      expect(presentation(composed)).toEqual([]);
      env.requests[1].respond();
      await flush();
      env.requests[0].respond();
      await flush();
      const result = env.installed();
      expect(result.month).toBe('2031-07');
      expect(result.ids).toEqual([103]);
      expect(result.count).toBe('1');
      expect(result.checked('project')).toEqual(['3']);
      expect(result.checked('type')).toEqual([]);
      expect(result.checked('status')).toEqual(['all']);
      expect(result.checked('view')).toEqual(['list']);
      expect(result.checked('weekStart')).toEqual(['sunday']);
      expect(env.region().getAttribute('data-calendar-week-start')).toBe('sunday');
      expect(env.region().getAttribute('data-calendar-view')).toBe('list');
      expect(new URL(result.location).search).toBe('?month=2031-07&project=3');
      expect(onlyGets(env.windowObject)).toBe(true);
    });

    it('B: Reset pending → Type Images adds only that Type', async () => {
      const env = resetEnvironment();
      await flush();
      env.toggle('type', 'images');
      await flush();
      expect([...env.requests[1].url.searchParams.entries()]).toEqual([['month', '2031-07'], ['type', 'images']]);
      env.requests[1].respond();
      env.requests[0].respond();
      await flush();
      expect(env.installed().ids).toEqual([102]);
      expect(env.installed().checked('type')).toEqual(['images']);
      expect(env.installed().checked('project')).toEqual([]);
    });

    it('C/D/E: Reset pending → status, View or week start changes only that field', async () => {
      for (const [name, value, expectedIds] of [
        ['status', 'published', [102]],
        ['view', 'grid', [101, 102, 103]],
        ['weekStart', 'monday', [101, 102, 103]],
      ]) {
        const env = resetEnvironment();
        await flush();
        env.toggle(name, value);
        await flush();
        const composed = env.requests[1].url;
        expect([...composed.searchParams.entries()]).toEqual([['month', '2031-07'], [name, value]]);
        env.requests[1].respond();
        env.requests[0].respond();
        await flush();
        const result = env.installed();
        expect(result.ids).toEqual(expectedIds);
        expect(result.checked('project')).toEqual([]);
        expect(result.checked('type')).toEqual([]);
        expect(result.checked(name)).toEqual([value]);
        for (const [other, saved] of Object.entries(SAVED)) {
          if (other !== name) expect(result.checked(other)).toEqual([saved]);
        }
        expect(onlyGets(env.windowObject)).toBe(true);
      }
    });

    it('K: Reset pending → repeated Projects and a Type compose without pre-Reset values', async () => {
      const env = resetEnvironment();
      await flush();
      env.toggle('project', '1');
      env.toggle('project', '3');
      env.toggle('type', 'comic');
      await flush();
      const latest = env.requests.at(-1).url;
      expect(all(latest, 'project')).toEqual(['1', '3']);
      expect(all(latest, 'type')).toEqual(['comic']);
      expect(presentation(latest)).toEqual([]);
      env.requests.at(-1).respond();
      env.requests.slice(0, -1).reverse().forEach((request) => request.respond());
      await flush();
      expect(env.installed().ids).toEqual([101, 103]);
      expect(env.installed().checked('project')).toEqual(['1', '3']);
    });

    it('F: Reset pending → month picker June overrides only the month', async () => {
      const env = resetEnvironment();
      const picker = attachMonthPicker(env.document);
      picker.dropdown.appendChild(makeNode({ tagName: 'input', attrs: { type: 'radio', value: '06' } }));
      enhanceCalendarLiveFiltering(env.document);
      await flush();
      picker.open();
      picker.year.value = '2031';
      picker.dropdown.querySelectorAll('input[type="radio"]').forEach((option) => { option.checked = false; });
      const june = picker.dropdown.querySelector('input[value="06"]');
      june.checked = true;
      june.dispatch('change');
      await flush();
      expect([...env.requests[1].url.searchParams.entries()]).toEqual([['month', '2031-06']]);
      env.requests[1].respond();
      env.requests[0].respond();
      await flush();
      expect(env.installed().month).toBe('2031-06');
      expect(env.installed().ids).toEqual([601, 602]);
      expectResetControls(env);
      expect(onlyGets(env.windowObject)).toBe(true);
    });

    it('G/H/O: a failed Reset stays the base for Project, Type and status edits; Retry is GET-only and a new edit supersedes it', async () => {
      const env = resetEnvironment();
      await flush();
      env.requests[0].fail();
      await flush();
      expect(env.installed().ids).toEqual([101]);
      expect(liveFailureRetries(env.document)).toHaveLength(1);

      // GET-only Retry repeats the month-only Reset exactly.
      liveFailureRetries(env.document)[0].dispatch('click');
      await flush();
      expect(env.requests[1].url.href).toBe(`${ORIGIN}${RESET}`);
      env.requests[1].fail();
      await flush();

      env.toggle('project', '3');
      await flush();
      expect([...env.requests[2].url.searchParams.entries()]).toEqual([['month', '2031-07'], ['project', '3']]);
      env.requests[2].fail();
      await flush();
      // A failed composed GET is itself the base for the next edit.
      env.toggle('type', 'comic');
      await flush();
      expect([...env.requests[3].url.searchParams.entries()])
        .toEqual([['month', '2031-07'], ['project', '3'], ['type', 'comic']]);
      // A superseding status edit while that request is held.
      env.toggle('status', 'planned');
      await flush();
      const latest = env.requests[4].url;
      expect([...latest.searchParams.entries()])
        .toEqual([['month', '2031-07'], ['project', '3'], ['type', 'comic'], ['status', 'planned']]);
      env.requests[4].respond();
      await flush();
      // Superseded requests failing afterwards report nothing.
      env.requests[3].fail();
      await flush();
      expect(liveFailureNotice(env.document)).toBeNull();
      expect(env.installed().ids).toEqual([103]);
      expect(env.installed().checked('project')).toEqual(['3']);
      expect(env.installed().checked('view')).toEqual(['list']);
      expect(env.installed().checked('weekStart')).toEqual(['sunday']);
      expect(onlyGets(env.windowObject)).toBe(true);
    });

    it('I/M: Back pending → Type Images drops the abandoned Comic Project; a second edit composes too; old responses arrive last', async () => {
      const env = r2Environment();
      env.toggle('project', '1');
      await flush();
      env.requests[0].respond();
      await flush();
      const comicJuly = env.installed().location;
      env.click('calendar-next');
      await flush();
      // Back to unrestricted July while August is held.
      env.windowObject.setLocation(INITIAL);
      env.windowObject.dispatch('popstate');
      await flush();
      expect(env.requests[2].url.href).toBe(INITIAL);
      expect(env.installed().checked('project')).toEqual([]);
      env.toggle('type', 'images');
      await flush();
      const images = env.requests[3].url;
      expect(images.searchParams.get('month')).toBe('2031-07');
      expect(all(images, 'project')).toEqual([]);
      expect(all(images, 'type')).toEqual(['images']);
      env.toggle('status', 'published');
      await flush();
      const latest = env.requests[4].url;
      expect(all(latest, 'project')).toEqual([]);
      expect(all(latest, 'type')).toEqual(['images']);
      expect(latest.searchParams.get('status')).toBe('published');
      env.requests[4].respond();
      await flush();
      for (const index of [3, 2, 1]) env.requests[index].respond();
      await flush();
      const result = env.installed();
      expect(result.month).toBe('2031-07');
      expect(result.ids).toEqual([102]);
      expect(result.count).toBe('1');
      expect(result.checked('project')).toEqual([]);
      expect(result.checked('type')).toEqual(['images']);
      expect(result.location).not.toBe(comicJuly);
      expect(onlyGets(env.windowObject)).toBe(true);
    });

    it('Back pending → month picker keeps the Back entry\'s unrestricted filters', async () => {
      const env = r2Environment();
      const picker = attachMonthPicker(env.document);
      enhanceCalendarLiveFiltering(env.document);
      env.toggle('project', '1');
      await flush();
      env.requests[0].respond();
      await flush();
      env.windowObject.setLocation(INITIAL);
      env.windowObject.dispatch('popstate');
      await flush();
      picker.open();
      picker.year.value = '2031';
      picker.dropdown.querySelectorAll('input[type="radio"]').forEach((option) => { option.checked = false; });
      picker.months['08'].checked = true;
      picker.months['08'].dispatch('change');
      await flush();
      const picked = env.requests[2].url;
      expect(picked.searchParams.get('month')).toBe('2031-08');
      expect(all(picked, 'project')).toEqual([]);
      env.requests[2].respond();
      env.requests[1].respond();
      await flush();
      expect(env.installed().ids).toEqual([201, 202, 203, 204]);
    });

    it('a failed Back stays the base for a Type edit', async () => {
      const env = r2Environment();
      env.toggle('project', '1');
      await flush();
      env.requests[0].respond();
      await flush();
      env.windowObject.setLocation(INITIAL);
      env.windowObject.dispatch('popstate');
      await flush();
      env.requests[1].fail();
      await flush();
      expect(env.installed().ids).toEqual([101]);
      env.toggle('type', 'images');
      await flush();
      expect(all(env.requests[2].url, 'project')).toEqual([]);
      expect(all(env.requests[2].url, 'type')).toEqual(['images']);
      env.requests[2].respond();
      await flush();
      expect(env.installed().ids).toEqual([102]);
    });

    it('J: Forward pending (or failed) → Project edit composes with the Forward entry, not the installed one', async () => {
      for (const failForward of [false, true]) {
        const env = r2Environment();
        env.toggle('status', 'planned');
        await flush();
        env.requests[0].respond();
        await flush();
        const planned = env.installed().location;
        env.windowObject.setLocation(INITIAL);
        env.windowObject.dispatch('popstate');
        await flush();
        env.requests[1].respond();
        await flush();
        expect(env.installed().ids).toEqual([101, 102, 103]);

        env.windowObject.setLocation(planned);
        env.windowObject.dispatch('popstate');
        await flush();
        expect(env.requests[2].url.href).toBe(planned);
        if (failForward) {
          env.requests[2].fail();
          await flush();
        }
        env.toggle('project', '1');
        env.toggle('project', '2');
        await flush();
        const latest = env.requests.at(-1).url;
        expect(all(latest, 'project')).toEqual(['1', '2']);
        expect(latest.searchParams.get('status')).toBe('planned');
        env.requests.at(-1).respond();
        await flush();
        if (!failForward) env.requests[2].respond();
        await flush();
        expect(env.installed().ids).toEqual([101]);
        expect(env.installed().checked('status')).toEqual(['planned']);
        expect(onlyGets(env.windowObject)).toBe(true);
      }
    });

    it('a history value without a rendered option is carried until that dimension is edited', async () => {
      const env = r2Environment();
      env.windowObject.setLocation(`${ORIGIN}/calendar?month=2031-07&project=9&status=all&view=grid&weekStart=monday`);
      env.windowObject.dispatch('popstate');
      await flush();
      env.toggle('type', 'images');
      await flush();
      expect(all(env.requests[1].url, 'project')).toEqual(['9']);
      expect(all(env.requests[1].url, 'type')).toEqual(['images']);
      env.toggle('project', '2');
      await flush();
      expect(all(env.requests[2].url, 'project')).toEqual(['2']);
    });

    it('a defaults refresh omitting status / week start keeps the just-saved controls and omits them from a later edit', async () => {
      SAVED = { view: 'grid', status: 'all', weekStart: 'monday' };
      const env = r2Environment(`${ORIGIN}/calendar?month=2031-07&status=published&view=grid&weekStart=sunday`);
      const generation = beginCalendarDefaultsLiveRefresh(env.document);
      expect(refreshCalendarLiveRegion(env.document, null, generation)).toBe('started');
      await flush();
      // The stale installed authority never overwrites the controls.
      expect(env.installed().checked('status')).toEqual(['published']);
      expect(env.installed().checked('weekStart')).toEqual(['sunday']);
      env.toggle('project', '2');
      await flush();
      const latest = env.requests.at(-1).url;
      expect(latest.searchParams.has('status')).toBe(false);
      expect(latest.searchParams.has('weekStart')).toBe(false);
      expect(all(latest, 'project')).toEqual(['2']);
    });
  });

  // R6: the month picker opens on the latest intended Calendar month. A
  // monthless destination (Today, an implicit or invalid history month) is
  // the current month the server resolves — the fake server's TODAY_MONTH,
  // rendered as data-calendar-current-month — never the abandoned installed
  // month. Each case checks the request URLs and the installed result.
  describe('R6 the month picker follows a pending or failed monthless Today', () => {
    const FILTERED = `${ORIGIN}/calendar?month=2031-07&project=1&project=2&type=comic&type=images&status=all&view=list&weekStart=sunday`;
    const MONTH_VALUES = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];

    function withPicker(env) {
      const picker = attachMonthPicker(env.document);
      MONTH_VALUES.forEach((value) => {
        if (picker.months[value]) return;
        picker.months[value] = makeNode({ tagName: 'input', attrs: { type: 'radio', value } });
        picker.dropdown.appendChild(picker.months[value]);
      });
      enhanceCalendarLiveFiltering(env.document);
      return picker;
    }
    const shows = (picker) => ({
      year: picker.year.value,
      months: picker.dropdown.querySelectorAll('input[type="radio"]').filter((option) => option.checked)
        .map((option) => option.value),
    });
    function choose(picker, month) {
      picker.dropdown.querySelectorAll('input[type="radio"]').forEach((option) => { option.checked = false; });
      picker.months[month].checked = true;
      picker.months[month].dispatch('change');
    }
    const monthless = (url) => !url.searchParams.has('month');
    // C-F1: a month picked on the implicit (Today) year first reads the
    // server's current month: one read-only GET of the displayed month.
    async function serverYear(env, index) {
      const request = env.requests[index];
      expect(request.url.pathname).toBe('/calendar');
      expect([...request.url.searchParams.entries()]).toEqual([['month', env.installed().month]]);
      expect(request.options).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' });
      request.respond();
      await flush();
    }

    it('A/B/J: held Today → picker opens on the Today year; June requests 2026-06 with every filter; the older Today response is ignored', async () => {
      TODAY_MONTH = '2026-11';
      const env = r2Environment(FILTERED);
      const picker = withPicker(env);
      picker.open();
      expect(shows(picker)).toEqual({ year: '2031', months: ['07'] });

      env.click('calendar-today');
      await flush();
      expect(env.requests).toHaveLength(1);
      const today = env.requests[0].url;
      expect(monthless(today)).toBe(true);
      expect(all(today, 'project')).toEqual(['1', '2']);

      picker.open();
      // Opening the picker neither navigates nor saves.
      expect(env.requests).toHaveLength(1);
      expect(shows(picker)).toEqual({ year: '2026', months: ['11'] });
      choose(picker, '06');
      await flush();
      expect(env.requests).toHaveLength(2);
      await serverYear(env, 1);
      expect(env.requests).toHaveLength(3);
      const june = env.requests[2].url;
      expect(all(june, 'month')).toEqual(['2026-06']);
      expect(all(june, 'project')).toEqual(['1', '2']);
      expect(all(june, 'type')).toEqual(['comic', 'images']);
      expect(all(june, 'status')).toEqual(['all']);
      expect(all(june, 'view')).toEqual(['list']);
      expect(all(june, 'weekStart')).toEqual(['sunday']);
      expect(june.search).not.toContain('%2C');

      env.requests[2].respond();
      await flush();
      env.requests[0].respond();
      await flush();
      const result = env.installed();
      expect(result.month).toBe('2026-06');
      expect(result.heading).toBe('2026-06');
      expect(result.ids).toEqual([701, 702]);
      expect(result.ids).not.toContain(601);
      expect(result.ids).not.toContain(602);
      expect(result.count).toBe('2');
      expect(new URL(result.location).searchParams.get('month')).toBe('2026-06');
      expect(result.checked('project')).toEqual(['1', '2']);
      expect(result.checked('type')).toEqual(['comic', 'images']);
      expect(result.checked('view')).toEqual(['list']);
      expect(result.checked('weekStart')).toEqual(['sunday']);
      // One history entry, for June; the abandoned Today never pushed one.
      expect(env.windowObject.history.pushes).toHaveLength(1);
      expect(new URL(env.windowObject.history.pushes[0], ORIGIN).searchParams.get('month')).toBe('2026-06');
      expect(env.windowObject.fetch).toHaveBeenCalledTimes(3);
      expect(onlyGets(env.windowObject)).toBe(true);
      // D: idle again, the installed month owns the picker.
      picker.open();
      expect(shows(picker)).toEqual({ year: '2026', months: ['06'] });
    });

    it('C/D/K: a failed Today keeps the Today month for the picker; a failed June keeps June; Retry is GET-only', async () => {
      TODAY_MONTH = '2026-11';
      const env = r2Environment(FILTERED);
      const picker = withPicker(env);
      env.click('calendar-today');
      await flush();
      env.requests[0].fail();
      await flush();
      expect(env.installed().month).toBe('2031-07');
      expect(liveFailureRetries(env.document)).toHaveLength(1);

      picker.open();
      expect(shows(picker)).toEqual({ year: '2026', months: ['11'] });
      choose(picker, '06');
      await flush();
      await serverYear(env, 1);
      const june = env.requests[2].url;
      expect(all(june, 'month')).toEqual(['2026-06']);
      expect(all(june, 'project')).toEqual(['1', '2']);
      env.requests[2].fail();
      await flush();
      expect(env.installed().month).toBe('2031-07');
      picker.open();
      expect(shows(picker)).toEqual({ year: '2026', months: ['06'] });

      liveFailureRetries(env.document)[0].dispatch('click');
      await flush();
      expect(env.requests).toHaveLength(4);
      expect(env.requests[3].url.href).toBe(june.href);
      env.requests[3].respond();
      await flush();
      expect(env.installed().month).toBe('2026-06');
      expect(env.installed().ids).toEqual([701, 702]);
      expect(liveFailureNotice(env.document)).toBeNull();
      expect(onlyGets(env.windowObject)).toBe(true);
    });

    it('E: an explicit month navigation supersedes a held Today, and a newer Today supersedes it again', async () => {
      TODAY_MONTH = '2026-11';
      const env = r2Environment();
      const picker = withPicker(env);
      env.click('calendar-today');
      await flush();
      env.click('calendar-next');
      await flush();
      expect(all(env.requests[1].url, 'month')).toEqual(['2031-08']);
      picker.open();
      expect(shows(picker)).toEqual({ year: '2031', months: ['08'] });

      env.click('calendar-today');
      await flush();
      expect(monthless(env.requests[2].url)).toBe(true);
      picker.open();
      expect(shows(picker)).toEqual({ year: '2026', months: ['11'] });
      choose(picker, '12');
      await flush();
      await serverYear(env, 3);
      expect(all(env.requests[4].url, 'month')).toEqual(['2026-12']);
      for (const index of [4, 2, 1, 0]) env.requests[index].respond();
      await flush();
      expect(env.installed().month).toBe('2026-12');
      expect(env.installed().ids).toEqual([901]);
    });

    it('F/G: Today held → Back to an explicit month, then Forward to a monthless entry; each owns the picker', async () => {
      TODAY_MONTH = '2026-11';
      const env = r2Environment();
      const picker = withPicker(env);
      env.click('calendar-today');
      await flush();
      env.windowObject.setLocation(`${ORIGIN}/calendar?month=2031-06&status=all&view=grid&weekStart=monday`);
      env.windowObject.dispatch('popstate');
      await flush();
      picker.open();
      expect(shows(picker)).toEqual({ year: '2031', months: ['06'] });

      const forward = `${ORIGIN}/calendar?status=all&view=grid&weekStart=monday`;
      env.windowObject.setLocation(forward);
      env.windowObject.dispatch('popstate');
      await flush();
      expect(env.requests[2].url.href).toBe(forward);
      picker.open();
      expect(shows(picker)).toEqual({ year: '2026', months: ['11'] });
      choose(picker, '06');
      await flush();
      await serverYear(env, 3);
      expect(all(env.requests[4].url, 'month')).toEqual(['2026-06']);
      for (const index of [4, 2, 1, 0]) env.requests[index].respond();
      await flush();
      expect(env.installed().month).toBe('2026-06');
      expect(env.installed().ids).toEqual([701, 702, 703]);
      expect(env.installed().count).toBe('3');
      expect(onlyGets(env.windowObject)).toBe(true);
    });

    it('H: Today held → Project 3 stays monthless; the picker then composes Project 3 with the Today year', async () => {
      TODAY_MONTH = '2026-11';
      const env = r2Environment();
      const picker = withPicker(env);
      env.click('calendar-today');
      await flush();
      env.toggle('project', '3');
      await flush();
      const composed = env.requests[1].url;
      expect(monthless(composed)).toBe(true);
      expect(all(composed, 'project')).toEqual(['3']);
      picker.open();
      expect(shows(picker)).toEqual({ year: '2026', months: ['11'] });
      choose(picker, '06');
      await flush();
      await serverYear(env, 2);
      const june = env.requests[3].url;
      expect(all(june, 'month')).toEqual(['2026-06']);
      expect(all(june, 'project')).toEqual(['3']);
      for (const index of [3, 1, 0]) env.requests[index].respond();
      await flush();
      expect(env.installed().ids).toEqual([703]);
      expect(env.installed().checked('project')).toEqual(['3']);
    });

    it('I: a pending Reset (explicit or monthless) owns the picker month and its cleared filters', async () => {
      TODAY_MONTH = '2026-11';
      const env = r2Environment(`${ORIGIN}/calendar?project=1&type=comic&status=planned&view=list&weekStart=sunday`);
      expect(env.installed().month).toBe('2026-11');
      const picker = withPicker(env);
      expect(navigateCalendarLive(env.document, '/calendar?month=2026-11').status).toBe('started');
      await flush();
      picker.open();
      expect(shows(picker)).toEqual({ year: '2026', months: ['11'] });
      choose(picker, '06');
      await flush();
      expect([...env.requests[1].url.searchParams.entries()]).toEqual([['month', '2026-06']]);
      env.requests[1].respond();
      env.requests[0].respond();
      await flush();
      expect(env.installed().ids).toEqual([701, 702, 703]);
      expect(env.installed().checked('project')).toEqual([]);
      expect(env.installed().checked('type')).toEqual([]);

      const later = r2Environment(`${ORIGIN}/calendar?month=2031-07&project=1&type=comic`);
      const laterPicker = withPicker(later);
      expect(navigateCalendarLive(later.document, '/calendar').status).toBe('started');
      await flush();
      laterPicker.open();
      expect(shows(laterPicker)).toEqual({ year: '2026', months: ['11'] });
      choose(laterPicker, '06');
      await flush();
      await serverYear(later, 1);
      expect([...later.requests[2].url.searchParams.entries()]).toEqual([['month', '2026-06']]);
      expect(onlyGets(later.windowObject)).toBe(true);
    });

    it('year transitions: the Today year, not the installed year, owns December / January choices', async () => {
      TODAY_MONTH = '2027-01';
      const january = r2Environment();
      const januaryPicker = withPicker(january);
      january.click('calendar-today');
      await flush();
      januaryPicker.open();
      expect(shows(januaryPicker)).toEqual({ year: '2027', months: ['01'] });
      choose(januaryPicker, '12');
      await flush();
      await serverYear(january, 1);
      expect(all(january.requests[2].url, 'month')).toEqual(['2027-12']);
      january.requests[2].respond();
      january.requests[0].respond();
      await flush();
      expect(january.installed().ids).toEqual([903]);
      expect(january.installed().ids).not.toContain(905);

      TODAY_MONTH = '2026-12';
      const december = r2Environment();
      const decemberPicker = withPicker(december);
      december.click('calendar-today');
      await flush();
      decemberPicker.open();
      expect(shows(decemberPicker)).toEqual({ year: '2026', months: ['12'] });
      choose(decemberPicker, '01');
      await flush();
      await serverYear(december, 1);
      expect(all(december.requests[2].url, 'month')).toEqual(['2026-01']);
      december.requests[2].respond();
      await flush();
      expect(december.installed().ids).toEqual([904]);

      // Explicit month navigations across the year boundary.
      const next = r2Environment(`${ORIGIN}/calendar?month=2026-12`);
      const nextPicker = withPicker(next);
      next.click('calendar-next');
      await flush();
      nextPicker.open();
      expect(shows(nextPicker)).toEqual({ year: '2027', months: ['01'] });
      const previous = r2Environment(`${ORIGIN}/calendar?month=2027-01`);
      const previousPicker = withPicker(previous);
      previous.click('calendar-previous');
      await flush();
      previousPicker.open();
      expect(shows(previousPicker)).toEqual({ year: '2026', months: ['12'] });
    });

    it('an invalid history month is the current month; an unreadable current month offers no stale year', async () => {
      TODAY_MONTH = '2026-11';
      const env = r2Environment();
      const picker = withPicker(env);
      env.windowObject.setLocation(`${ORIGIN}/calendar?month=2031-13&status=all&view=grid&weekStart=monday`);
      env.windowObject.dispatch('popstate');
      await flush();
      picker.open();
      expect(shows(picker)).toEqual({ year: '2026', months: ['11'] });

      const unreadable = r2Environment();
      unreadable.region().removeAttribute('data-calendar-current-month');
      const unreadablePicker = withPicker(unreadable);
      unreadable.click('calendar-today');
      await flush();
      unreadablePicker.open();
      expect(shows(unreadablePicker)).toEqual({ year: '', months: [] });
      choose(unreadablePicker, '06');
      await flush();
      // The required Year reports instead of navigating to a guessed year.
      expect(unreadable.requests).toHaveLength(1);
      expect(unreadablePicker.year.reportValidity).toHaveBeenCalled();
      unreadablePicker.year.value = '2026';
      unreadablePicker.year.dispatch('input');
      unreadablePicker.year.dispatch('change');
      await flush();
      expect(all(unreadable.requests[1].url, 'month')).toEqual(['2026-06']);
    });

    // C-F1: the installed data-calendar-current-month is what the server
    // resolved when the INSTALLED page rendered. Once the server's date moves
    // on (December 31, 2026 → January 1, 2027) it is stale, so a month picked
    // on that implicit year first reads the server's current month through
    // one read-only Calendar GET; the picked month then navigates in THAT year.
    describe('C-F1 a picked month takes the server year, never stale installed metadata', () => {
      const NOVEMBER = `${ORIGIN}/calendar?month=2026-11&project=1&project=2&type=comic&type=images&status=all&view=list&weekStart=sunday`;

      // November 2026 rendered on December 31, 2026; the server is then on
      // January 1, 2027 for every later response (lookup included).
      function rollover() {
        TODAY_MONTH = '2026-12';
        const env = r2Environment(NOVEMBER);
        const picker = withPicker(env);
        TODAY_MONTH = '2027-01';
        return { env, picker };
      }
      async function todayThenPick(env, picker, month) {
        env.click('calendar-today');
        await flush();
        picker.open();
        choose(picker, month);
        await flush();
      }
      const filtersOf = (url) => ({
        project: all(url, 'project'), type: all(url, 'type'), status: all(url, 'status'),
        view: all(url, 'view'), weekStart: all(url, 'weekStart'),
      });
      const PENDING_FILTERS = {
        project: ['1', '2'], type: ['comic', 'images'], status: ['all'], view: ['list'], weekStart: ['sunday'],
      };

      it('REPRODUCTION: held Today → June resolves 2027 through one lookup and installs June 2027; the late Today is ignored', async () => {
        const { env, picker } = rollover();
        expect(env.installed().month).toBe('2026-11');
        expect(env.region().getAttribute('data-calendar-current-month')).toBe('2026-12');
        const phases = [];
        subscribeCalendarLive(env.document, ({ phase, generation }) => phases.push([phase, generation]));

        env.click('calendar-today');
        await flush();
        expect(env.requests).toHaveLength(1);
        const today = env.requests[0];
        expect(monthless(today.url)).toBe(true);

        picker.open();
        // The stale installed year is only shown as a hint.
        expect(shows(picker)).toEqual({ year: '2026', months: ['12'] });
        choose(picker, '06');
        // The picked month is the intent AT ONCE: Today is superseded (its
        // request aborted) before any answer, and Calendar stays pending.
        expect(today.options.signal.aborted).toBe(true);
        const snapshot = calendarLiveSnapshot(env.document);
        expect(snapshot.pending).toBe(true);
        expect(snapshot.failed).toBe(false);
        expect(monthless(new URL(snapshot.intendedUrl))).toBe(true);
        expect(filtersOf(new URL(snapshot.intendedUrl))).toEqual(PENDING_FILTERS);
        await flush();
        // The lookup began without waiting for Today; nothing navigated yet.
        expect(env.requests).toHaveLength(2);
        expect(env.windowObject.history.pushes).toEqual([]);
        expect(env.installed().month).toBe('2026-11');

        await serverYear(env, 1);
        expect(env.requests).toHaveLength(3);
        const june = env.requests[2].url;
        expect(all(june, 'month')).toEqual(['2027-06']);
        expect(filtersOf(june)).toEqual(PENDING_FILTERS);
        expect(june.search).not.toContain('%2C');
        // The picker's untouched implicit Year now shows the server's year.
        expect(picker.year.value).toBe('2027');

        env.requests[2].respond();
        await flush();
        expect(env.installed().month).toBe('2027-06');
        expect(env.installed().ids).toEqual([1101, 1102]);
        expect(new URL(env.installed().location).searchParams.getAll('month')).toEqual(['2027-06']);

        today.respond();
        await flush();
        const result = env.installed();
        expect(result.month).toBe('2027-06');
        expect(result.heading).toBe('2027-06');
        expect(result.ids).toEqual([1101, 1102]);
        expect(result.checked('project')).toEqual(['1', '2']);
        expect(result.checked('type')).toEqual(['comic', 'images']);
        expect(result.checked('view')).toEqual(['list']);
        expect(result.checked('weekStart')).toEqual(['sunday']);
        // One user navigation (one push, for June 2027); one lookup GET.
        expect(env.windowObject.history.pushes).toHaveLength(1);
        expect(new URL(env.windowObject.history.pushes[0], ORIGIN).searchParams.get('month')).toBe('2027-06');
        expect(env.windowObject.history.replaces).toEqual([]);
        expect(env.windowObject.fetch).toHaveBeenCalledTimes(3);
        expect(onlyGets(env.windowObject)).toBe(true);
        expect(env.requests.some(({ url }) => url.searchParams.get('month') === '2026-06')).toBe(false);
        // One generation owns the lookup and the final GET it continues.
        const started = phases.filter(([phase]) => phase === 'started');
        expect(started).toHaveLength(3);
        expect(started[1][1]).toBe(started[2][1]);
        expect(started[1][1]).toBeGreaterThan(started[0][1]);
        expect(phases.filter(([phase]) => phase === 'installed')).toEqual([['installed', started[2][1]]]);
        // Idle again: the installed June 2027 owns the picker.
        picker.open();
        expect(shows(picker)).toEqual({ year: '2027', months: ['06'] });
      });

      it('Today answering while the lookup is pending is ignored; the lookup still decides', async () => {
        const { env, picker } = rollover();
        await todayThenPick(env, picker, '06');
        env.requests[0].respond();
        await flush();
        expect(env.installed().month).toBe('2026-11');
        expect(calendarLiveSnapshot(env.document).pending).toBe(true);
        expect(env.windowObject.history.pushes).toEqual([]);
        await serverYear(env, 1);
        env.requests[2].respond();
        await flush();
        expect(env.installed().month).toBe('2027-06');
        expect(env.windowObject.history.pushes).toHaveLength(1);
      });

      it('a second pick supersedes the pending lookup; the older answer is ignored; re-picking the waiting month sends nothing', async () => {
        const { env, picker } = rollover();
        await todayThenPick(env, picker, '06');
        expect(env.requests).toHaveLength(2);
        picker.open();
        // The waiting choice, still on the unconfirmed implicit year.
        expect(shows(picker)).toEqual({ year: '2026', months: ['06'] });
        choose(picker, '08');
        await flush();
        expect(env.requests).toHaveLength(3);
        expect(env.requests[1].options.signal.aborted).toBe(true);
        choose(picker, '08');
        await flush();
        expect(env.requests).toHaveLength(3);

        env.requests[1].respond();
        await flush();
        expect(env.requests).toHaveLength(3);
        await serverYear(env, 2);
        expect(env.requests).toHaveLength(4);
        expect(all(env.requests[3].url, 'month')).toEqual(['2027-08']);
        expect(filtersOf(env.requests[3].url)).toEqual(PENDING_FILTERS);
        env.requests[3].respond();
        env.requests[0].respond();
        await flush();
        expect(env.installed().month).toBe('2027-08');
        expect(env.installed().ids).toEqual([1201]);
        expect(env.windowObject.history.pushes).toHaveLength(1);
        expect(env.requests.some(({ url }) => all(url, 'month').includes('2027-06'))).toBe(false);
      });

      it('Back and Forward supersede a pending lookup; its answer never navigates', async () => {
        const { env, picker } = rollover();
        await todayThenPick(env, picker, '06');
        const lookup = env.requests[1];
        env.windowObject.setLocation(`${ORIGIN}/calendar?month=2026-10&status=all&view=grid&weekStart=monday`);
        env.windowObject.dispatch('popstate');
        await flush();
        expect(lookup.options.signal.aborted).toBe(true);
        expect(all(env.requests[2].url, 'month')).toEqual(['2026-10']);
        lookup.respond();
        await flush();
        expect(env.requests).toHaveLength(3);
        env.requests[2].respond();
        env.requests[0].respond();
        await flush();
        expect(env.installed().month).toBe('2026-10');
        expect(env.installed().ids).toEqual([1301]);
        expect(env.windowObject.history.pushes).toEqual([]);

        // Forward to a monthless entry, picked again: a new lookup owns it.
        env.windowObject.setLocation(`${ORIGIN}/calendar?status=all&view=grid&weekStart=monday`);
        env.windowObject.dispatch('popstate');
        await flush();
        expect(monthless(env.requests[3].url)).toBe(true);
        picker.open();
        choose(picker, '06');
        await flush();
        expect(env.requests[3].options.signal.aborted).toBe(true);
        await serverYear(env, 4);
        expect(all(env.requests[5].url, 'month')).toEqual(['2027-06']);
        env.requests[5].respond();
        env.requests[3].respond();
        await flush();
        expect(env.installed().month).toBe('2027-06');
        expect(env.installed().ids).toEqual([1101, 1102, 1103]);
      });

      it('a later Next link, Today or Reset filters supersedes a pending lookup', async () => {
        let { env, picker } = rollover();
        await todayThenPick(env, picker, '06');
        env.click('calendar-next');
        await flush();
        expect(env.requests[1].options.signal.aborted).toBe(true);
        expect(all(env.requests[2].url, 'month')).toEqual(['2026-12']);
        expect(filtersOf(env.requests[2].url)).toEqual(PENDING_FILTERS);
        env.requests[1].respond();
        await flush();
        expect(env.requests).toHaveLength(3);
        env.requests[2].respond();
        await flush();
        expect(env.installed().month).toBe('2026-12');

        ({ env, picker } = rollover());
        await todayThenPick(env, picker, '06');
        env.click('calendar-today');
        await flush();
        expect(monthless(env.requests[2].url)).toBe(true);
        env.requests[1].respond();
        await flush();
        expect(env.requests).toHaveLength(3);
        env.requests[2].respond();
        await flush();
        expect(env.installed().month).toBe('2027-01');

        ({ env, picker } = rollover());
        await todayThenPick(env, picker, '06');
        expect(navigateCalendarLive(env.document, '/calendar?month=2026-11').status).toBe('started');
        await flush();
        env.requests[1].respond();
        await flush();
        expect(env.requests).toHaveLength(3);
        expect([...env.requests[2].url.searchParams.entries()]).toEqual([['month', '2026-11']]);
        env.requests[2].respond();
        await flush();
        expect(env.installed().month).toBe('2026-11');
        expect(env.installed().checked('project')).toEqual([]);
        expect(env.installed().checked('type')).toEqual([]);
      });

      const BROKEN = {
        network: (request) => request.fail(),
        'error status': (request) => request.respondWith({
          ok: false, status: 503, url: request.url.href, headers: HTML_HEADERS, text: async () => 'unavailable',
        }),
        'login redirect': (request) => request.respondWith({
          ok: true, url: `${ORIGIN}/login?returnTo=%2Fcalendar`, headers: HTML_HEADERS, text: async () => 'login',
        }),
        'non-HTML answer': (request) => request.respondWith({
          ok: true, url: request.url.href, headers: { get: () => 'application/json' }, text: async () => '{}',
        }),
        'not a Calendar page': (request) => request.respondWith({
          ok: true, url: request.url.href, headers: HTML_HEADERS, text: async () => 'no-such-page',
        }),
        'malformed current month': (request, env) => {
          const page = renderPage(resolved(request.url.searchParams));
          page.document.querySelector('[data-calendar-live-region]').setAttribute('data-calendar-current-month', '2027-1');
          env.pages.set('malformed-current-month', page);
          request.respondWith({ ok: true, url: request.url.href, headers: HTML_HEADERS, text: async () => 'malformed-current-month' });
        },
      };

      it.each(Object.keys(BROKEN))('a failed lookup (%s) never navigates to a guessed or stale year; Retry repeats only the lookup', async (kind) => {
        const { env, picker } = rollover();
        await todayThenPick(env, picker, '06');
        BROKEN[kind](env.requests[1], env);
        await flush();
        expect(env.requests).toHaveLength(2);
        expect(env.installed().month).toBe('2026-11');
        expect(env.region().getAttribute('aria-busy')).toBeNull();
        const notice = liveFailureNotice(env.document);
        expect(notice.querySelector('p').textContent).toContain("current year couldn't be confirmed");
        expect(liveFailureRetries(env.document)).toHaveLength(1);
        expect(calendarLiveSnapshot(env.document)).toMatchObject({ pending: false, failed: true });

        // The superseded Today cannot come back.
        env.requests[0].respond();
        await flush();
        expect(env.installed().month).toBe('2026-11');
        expect(env.windowObject.history.pushes).toEqual([]);
        // The choice is kept, on the still-unconfirmed implicit year.
        picker.open();
        expect(shows(picker)).toEqual({ year: '2026', months: ['06'] });

        liveFailureRetries(env.document)[0].dispatch('click');
        await flush();
        expect(env.requests).toHaveLength(3);
        expect(liveFailureNotice(env.document)).toBeNull();
        expect(calendarLiveSnapshot(env.document).pending).toBe(true);
        await serverYear(env, 2);
        expect(all(env.requests[3].url, 'month')).toEqual(['2027-06']);
        expect(filtersOf(env.requests[3].url)).toEqual(PENDING_FILTERS);
        env.requests[3].respond();
        await flush();
        expect(env.installed().month).toBe('2027-06');
        expect(env.windowObject.history.pushes).toHaveLength(1);
        expect(onlyGets(env.windowObject)).toBe(true);
        expect(env.requests.some(({ url }) => url.searchParams.get('month') === '2026-06')).toBe(false);
      });

      it('a failed lookup is superseded by a later picked month or explicit navigation', async () => {
        let { env, picker } = rollover();
        await todayThenPick(env, picker, '06');
        env.requests[1].fail();
        await flush();
        picker.open();
        choose(picker, '08');
        await flush();
        expect(liveFailureNotice(env.document)).toBeNull();
        await serverYear(env, 2);
        expect(all(env.requests[3].url, 'month')).toEqual(['2027-08']);

        ({ env, picker } = rollover());
        await todayThenPick(env, picker, '06');
        env.requests[1].fail();
        await flush();
        env.click('calendar-previous');
        await flush();
        expect(liveFailureNotice(env.document)).toBeNull();
        expect(all(env.requests[2].url, 'month')).toEqual(['2026-10']);
        expect(filtersOf(env.requests[2].url)).toEqual(PENDING_FILTERS);
      });

      it('a failed Today: the picked month still takes the server year', async () => {
        const { env, picker } = rollover();
        env.click('calendar-today');
        await flush();
        env.requests[0].fail();
        await flush();
        expect(liveFailureRetries(env.document)).toHaveLength(1);
        picker.open();
        expect(shows(picker)).toEqual({ year: '2026', months: ['12'] });
        choose(picker, '06');
        await flush();
        // The failed Today's notice is superseded by the picked month.
        expect(liveFailureNotice(env.document)).toBeNull();
        await serverYear(env, 1);
        expect(all(env.requests[2].url, 'month')).toEqual(['2027-06']);
        expect(filtersOf(env.requests[2].url)).toEqual(PENDING_FILTERS);
        env.requests[2].respond();
        await flush();
        expect(env.installed().month).toBe('2027-06');
      });

      it('a typed Year is explicit: it navigates at once, with no lookup', async () => {
        const { env, picker } = rollover();
        env.click('calendar-today');
        await flush();
        picker.open();
        picker.year.value = '2030';
        picker.year.dispatch('input');
        choose(picker, '06');
        await flush();
        expect(env.requests).toHaveLength(2);
        expect(all(env.requests[1].url, 'month')).toEqual(['2030-06']);
        expect(filtersOf(env.requests[1].url)).toEqual(PENDING_FILTERS);
      });

      it('an idle Calendar keeps the ordinary picker: the displayed year, no lookup', async () => {
        const { env, picker } = rollover();
        picker.open();
        expect(shows(picker)).toEqual({ year: '2026', months: ['11'] });
        choose(picker, '06');
        await flush();
        expect(env.requests).toHaveLength(1);
        expect(all(env.requests[0].url, 'month')).toEqual(['2026-06']);
        expect(filtersOf(env.requests[0].url)).toEqual(PENDING_FILTERS);
        // A held explicit month owns the picker year the same way.
        env.click('calendar-next');
        await flush();
        picker.open();
        expect(shows(picker)).toEqual({ year: '2026', months: ['12'] });
        choose(picker, '03');
        await flush();
        expect(env.requests).toHaveLength(3);
        expect(all(env.requests[2].url, 'month')).toEqual(['2026-03']);
      });

      it('a monthless defaults refresh during the lookup keeps the picked month; it owns the same generation', async () => {
        const { env, picker } = rollover();
        await todayThenPick(env, picker, '06');
        const owner = calendarLiveSnapshot(env.document).generation;
        // Reset defaults' refreshUrl for the pending intent: monthless, the
        // temporary Projects / Types only.
        const outcome = navigateCalendarLive(env.document, '/calendar?project=1&project=2&type=comic&type=images', { historyMode: 'push' });
        expect(outcome).toEqual({ status: 'started', generation: owner });
        // Still the one lookup: nothing aborted, nothing extra requested.
        expect(env.requests).toHaveLength(2);
        expect(env.requests[1].options.signal.aborted).toBe(false);
        await serverYear(env, 1);
        expect([...env.requests[2].url.searchParams.entries()]).toEqual([
          ['month', '2027-06'], ['project', '1'], ['project', '2'], ['type', 'comic'], ['type', 'images'],
        ]);
        env.requests[2].respond();
        env.requests[0].respond();
        await flush();
        expect(env.installed().month).toBe('2027-06');
        expect(env.installed().checked('view')).toEqual(['grid']);
        expect(env.windowObject.history.pushes).toHaveLength(1);
        expect(onlyGets(env.windowObject)).toBe(true);
      });

      it('a saved release edit refresh during the lookup keeps the picked month and reports success once installed', async () => {
        const { env, picker } = rollover();
        await todayThenPick(env, picker, '06');
        const onSuccess = vi.fn();
        const generation = beginCalendarDefaultsLiveRefresh(env.document);
        expect(refreshCalendarLiveRegion(env.document, null, generation, { preserveFilters: true, onSuccess })).toBe('started');
        expect(env.requests).toHaveLength(2);
        await serverYear(env, 1);
        expect(all(env.requests[2].url, 'month')).toEqual(['2027-06']);
        expect(filtersOf(env.requests[2].url)).toEqual(PENDING_FILTERS);
        expect(onSuccess).not.toHaveBeenCalled();
        env.requests[2].respond();
        await flush();
        expect(env.installed().month).toBe('2027-06');
        expect(onSuccess).toHaveBeenCalledTimes(1);
        // The refresh kept the picked month's pending push.
        expect(env.windowObject.history.pushes).toHaveLength(1);
      });

      it('an explicit refresh (C-F2 displayed month) during the lookup supersedes it', async () => {
        const { env, picker } = rollover();
        await todayThenPick(env, picker, '06');
        const outcome = navigateCalendarLive(env.document, '/calendar?month=2026-11&project=1', { historyMode: 'replace' });
        expect(outcome.status).toBe('started');
        expect(env.requests[1].options.signal.aborted).toBe(true);
        env.requests[1].respond();
        await flush();
        expect(env.requests).toHaveLength(3);
        expect(all(env.requests[2].url, 'month')).toEqual(['2026-11']);
      });
      // C-F1 P2: a later filter / presentation edit changes only its own
      // dimension; the picked month still waiting for its server year stays.
      const PLANNED_FILTERS = { ...PENDING_FILTERS, status: ['planned'] };

      it('P2-A: a Status edit while the lookup is held keeps June; one lookup under the newer intent, one June 2027 push', async () => {
        const { env, picker } = rollover();
        await todayThenPick(env, picker, '06');
        const oldLookup = env.requests[1];
        const owner = calendarLiveSnapshot(env.document).generation;

        env.toggle('status', 'planned');
        await flush();
        // The edit owns a newer generation at once; the older lookup is aborted.
        expect(oldLookup.options.signal.aborted).toBe(true);
        const snapshot = calendarLiveSnapshot(env.document);
        expect(snapshot.generation).toBeGreaterThan(owner);
        expect(snapshot.pending).toBe(true);
        const intended = new URL(snapshot.intendedUrl);
        expect(monthless(intended)).toBe(true);
        expect(filtersOf(intended)).toEqual(PLANNED_FILTERS);
        // A fresh lookup (never the superseded answer); no monthless GET.
        expect(env.requests).toHaveLength(3);
        expect(env.windowObject.history.pushes).toEqual([]);

        // P2-C: the older lookup's late answer cannot navigate or install.
        oldLookup.respond();
        await flush();
        expect(env.requests).toHaveLength(3);
        expect(env.installed().month).toBe('2026-11');

        await serverYear(env, 2);
        expect(env.requests).toHaveLength(4);
        const june = env.requests[3].url;
        expect(all(june, 'month')).toEqual(['2027-06']);
        expect(filtersOf(june)).toEqual(PLANNED_FILTERS);
        expect(june.search).not.toContain('%2C');
        expect(picker.year.value).toBe('2027');
        env.requests[3].respond();
        env.requests[0].respond();
        await flush();
        const result = env.installed();
        expect(result.month).toBe('2027-06');
        expect(result.ids).toEqual([1101]);
        expect(result.checked('status')).toEqual(['planned']);
        expect(result.checked('project')).toEqual(['1', '2']);
        expect(result.checked('type')).toEqual(['comic', 'images']);
        expect(result.checked('weekStart')).toEqual(['sunday']);
        expect(result.checked('view')).toEqual(['list']);
        expect(env.windowObject.history.pushes).toHaveLength(1);
        expect(new URL(env.windowObject.history.pushes[0], ORIGIN).searchParams.get('month')).toBe('2027-06');
        expect(new URL(env.windowObject.history.pushes[0], ORIGIN).searchParams.get('status')).toBe('planned');
        expect(env.windowObject.history.replaces).toEqual([]);
        expect(env.requests.filter(({ url }) => monthless(url))).toHaveLength(1);
        expect(onlyGets(env.windowObject)).toBe(true);
      });

      it('P2-B: a Status edit after a failed lookup keeps June; a newer lookup resolves it; the stale Retry is inert', async () => {
        const { env, picker } = rollover();
        await todayThenPick(env, picker, '06');
        env.requests[1].fail();
        await flush();
        const staleRetry = liveFailureRetries(env.document)[0];
        expect(staleRetry).toBeDefined();

        env.toggle('status', 'planned');
        await flush();
        // The stale failure notice and its Retry are gone; a newer lookup runs.
        expect(liveFailureNotice(env.document)).toBeNull();
        expect(liveFailureRetries(env.document)).toHaveLength(0);
        expect(env.requests).toHaveLength(3);
        expect(calendarLiveSnapshot(env.document)).toMatchObject({ pending: true, failed: false });
        // The outdated Retry cannot restart the older intent.
        staleRetry.dispatch('click');
        await flush();
        expect(env.requests).toHaveLength(3);

        await serverYear(env, 2);
        const june = env.requests[3].url;
        expect(all(june, 'month')).toEqual(['2027-06']);
        expect(filtersOf(june)).toEqual(PLANNED_FILTERS);
        env.requests[3].respond();
        env.requests[0].respond();
        await flush();
        expect(env.installed().month).toBe('2027-06');
        expect(env.installed().ids).toEqual([1101]);
        expect(env.windowObject.history.pushes).toHaveLength(1);
        expect(liveFailureNotice(env.document)).toBeNull();
        // Never a guessed (installed / browser) year.
        expect(env.requests.some(({ url }) => all(url, 'month').includes('2026-06'))).toBe(false);
        expect(onlyGets(env.windowObject)).toBe(true);
      });

      it('P2-B: a second failed lookup after the Status edit keeps June and Planned for its Retry', async () => {
        const { env, picker } = rollover();
        await todayThenPick(env, picker, '06');
        env.requests[1].fail();
        await flush();
        env.toggle('status', 'planned');
        await flush();
        env.requests[2].fail();
        await flush();
        expect(liveFailureRetries(env.document)).toHaveLength(1);
        picker.open();
        expect(shows(picker)).toEqual({ year: '2026', months: ['06'] });
        liveFailureRetries(env.document)[0].dispatch('click');
        await flush();
        await serverYear(env, 3);
        expect(all(env.requests[4].url, 'month')).toEqual(['2027-06']);
        expect(filtersOf(env.requests[4].url)).toEqual(PLANNED_FILTERS);
      });

      it('P2: the toolbar View is a presentation edit: it keeps June', async () => {
        const { env, picker } = rollover();
        await todayThenPick(env, picker, '06');
        env.click('calendar-view-link-grid');
        await flush();
        expect(env.requests[1].options.signal.aborted).toBe(true);
        expect(env.requests).toHaveLength(3);
        await serverYear(env, 2);
        const june = env.requests[3].url;
        expect(all(june, 'month')).toEqual(['2027-06']);
        expect(filtersOf(june)).toEqual({ ...PENDING_FILTERS, view: ['grid'] });
      });

      it('P2-D: Today → June → Status → August: the second picked month replaces June and keeps Planned', async () => {
        const { env, picker } = rollover();
        await todayThenPick(env, picker, '06');
        env.toggle('status', 'planned');
        await flush();
        picker.open();
        expect(shows(picker)).toEqual({ year: '2026', months: ['06'] });
        choose(picker, '08');
        await flush();
        expect(env.requests[2].options.signal.aborted).toBe(true);
        expect(env.requests).toHaveLength(4);
        await serverYear(env, 3);
        const august = env.requests[4].url;
        expect(all(august, 'month')).toEqual(['2027-08']);
        expect(filtersOf(august)).toEqual(PLANNED_FILTERS);
        env.requests[2].respond();
        await flush();
        expect(env.requests).toHaveLength(5);
        env.requests[4].respond();
        await flush();
        expect(env.installed().month).toBe('2027-08');
        expect(env.installed().ids).toEqual([1201]);
        expect(env.requests.some(({ url }) => all(url, 'month').includes('2027-06'))).toBe(false);

        // An explicit typed year replaces a waiting month the same way.
        const other = rollover();
        await todayThenPick(other.env, other.picker, '06');
        other.env.toggle('status', 'planned');
        await flush();
        other.picker.open();
        other.picker.year.value = '2030';
        other.picker.year.dispatch('input');
        choose(other.picker, '06');
        await flush();
        const explicit = other.env.requests.at(-1).url;
        expect(all(explicit, 'month')).toEqual(['2030-06']);
        expect(filtersOf(explicit)).toEqual(PLANNED_FILTERS);
      });

      it('P2: Today, Reset filters and Back still replace the waiting month (their own month semantics)', async () => {
        let { env, picker } = rollover();
        await todayThenPick(env, picker, '06');
        env.toggle('status', 'planned');
        await flush();
        env.click('calendar-today');
        await flush();
        const today = env.requests.at(-1).url;
        expect(monthless(today)).toBe(true);
        expect(filtersOf(today).status).toEqual(['planned']);
        env.requests.at(-1).respond();
        await flush();
        expect(env.installed().month).toBe('2027-01');

        ({ env, picker } = rollover());
        await todayThenPick(env, picker, '06');
        env.toggle('status', 'planned');
        await flush();
        env.windowObject.setLocation(`${ORIGIN}/calendar?month=2026-10&status=all&view=grid&weekStart=monday`);
        env.windowObject.dispatch('popstate');
        await flush();
        expect(all(env.requests.at(-1).url, 'month')).toEqual(['2026-10']);
        env.requests.at(-1).respond();
        await flush();
        expect(env.installed().month).toBe('2026-10');
      });

      // C-F1 P3: a saved release edit refresh that adopted the lookup reports
      // its failure; its Retry refresh continues the picked month.
      function withEditFeedback(env) {
        env.document.documentElement = makeNode({ tagName: 'html' });
        const notice = makeNode({ attrs: { 'data-dialog-feedback': '' } });
        notice.classList = { toggle: vi.fn() };
        const text = makeNode({ tagName: 'p', attrs: { 'data-dialog-feedback-text': '' } });
        notice.appendChild(text);
        env.document.appendChild(notice);
        enhanceCalendarLiveFiltering(env.document);
        return {
          text: () => text.textContent,
          retry: () => notice.querySelector('[data-calendar-edit-refresh-retry]'),
        };
      }

      it('P3-A/P3-C: a failed adopted lookup keeps June for Retry refresh: a fresh lookup, one June 2027 push, GET only', async () => {
        const { env, picker } = rollover();
        const feedback = withEditFeedback(env);
        await todayThenPick(env, picker, '06');
        // The release POST was acknowledged elsewhere; Calendar is told once.
        env.document.dispatch('release-edit-saved', { detail: { releaseId: '801' } });
        await flush();
        // The refresh joined the held lookup: nothing new was requested.
        expect(env.requests).toHaveLength(2);
        env.requests[1].respondWith({
          ok: false, status: 503, url: env.requests[1].url.href, headers: HTML_HEADERS, text: async () => 'unavailable',
        });
        await flush();
        expect(feedback.text()).toBe('Release saved, but Calendar could not refresh. The calendar shown may be out of date.');
        expect(feedback.retry()).not.toBeNull();
        expect(env.installed().month).toBe('2026-11');
        expect(env.windowObject.history.pushes).toEqual([]);
        // The picked month is still the intent.
        picker.open();
        expect(shows(picker)).toEqual({ year: '2026', months: ['06'] });

        feedback.retry().dispatch('click');
        await flush();
        // Retry refresh repeats only the read-only lookup, never November.
        expect(env.requests).toHaveLength(3);
        expect(env.requests.some(({ url }) => url.searchParams.get('month') === '2026-11' && keys(url).length > 1)).toBe(false);
        await serverYear(env, 2);
        expect(env.requests).toHaveLength(4);
        const june = env.requests[3].url;
        expect(all(june, 'month')).toEqual(['2027-06']);
        expect(filtersOf(june)).toEqual(PENDING_FILTERS);
        env.requests[3].respond();
        env.requests[0].respond();
        await flush();
        expect(env.installed().month).toBe('2027-06');
        expect(env.installed().ids).toEqual([1101, 1102]);
        expect(feedback.text()).toBe('Release updated.');
        expect(feedback.retry()).toBeNull();
        // The picked month's one pending push, and nothing else.
        expect(env.windowObject.history.pushes).toHaveLength(1);
        expect(new URL(env.windowObject.history.pushes[0], ORIGIN).searchParams.get('month')).toBe('2027-06');
        expect(env.windowObject.history.replaces).toEqual([]);
        // P3-C: no write is ever replayed: every Calendar request is a GET.
        expect(onlyGets(env.windowObject)).toBe(true);
        expect(env.windowObject.fetch).toHaveBeenCalledTimes(4);
      });

      it('P3-B: a newer navigation supersedes the failed adopted refresh; the old Retry refresh cannot bring June back', async () => {
        const { env, picker } = rollover();
        const feedback = withEditFeedback(env);
        await todayThenPick(env, picker, '06');
        env.document.dispatch('release-edit-saved', { detail: { releaseId: '801' } });
        await flush();
        env.requests[1].fail();
        await flush();
        const oldRetry = feedback.retry();
        expect(oldRetry).not.toBeNull();

        env.click('calendar-previous');
        await flush();
        const october = env.requests[2].url;
        expect(all(october, 'month')).toEqual(['2026-10']);
        expect(filtersOf(october)).toEqual(PENDING_FILTERS);
        // Calendar P3-A: the old Retry refresh is inert once October owns
        // Calendar: no GET (never June), and October's own GET is not aborted.
        oldRetry.dispatch('click');
        await flush();
        expect(env.requests).toHaveLength(3);
        expect(env.requests[2].options.signal.aborted).toBe(false);
        expect(env.requests.every(({ url }) => !all(url, 'month').includes('2027-06'))).toBe(true);
        expect(all(env.requests.at(-1).url, 'month')).toEqual(['2026-10']);
        env.requests.at(-1).respond();
        await flush();
        expect(env.installed().month).toBe('2026-10');
        expect(env.requests.filter(({ url }) => keys(url).length === 1 && url.searchParams.get('month') === '2026-11')).toHaveLength(1);
        expect(onlyGets(env.windowObject)).toBe(true);
      });

      it('P3: a Status edit after the failed adopted refresh keeps June', async () => {
        const { env, picker } = rollover();
        withEditFeedback(env);
        await todayThenPick(env, picker, '06');
        env.document.dispatch('release-edit-saved', { detail: { releaseId: '801' } });
        await flush();
        env.requests[1].fail();
        await flush();
        env.toggle('status', 'planned');
        await flush();
        expect(env.requests).toHaveLength(3);
        await serverYear(env, 2);
        expect(all(env.requests[3].url, 'month')).toEqual(['2027-06']);
        expect(filtersOf(env.requests[3].url)).toEqual(PLANNED_FILTERS);
      });

      // Calendar P3: release-refresh Retry is owned by the generation whose
      // refresh failed (P3-A); release-action feedback is owned by the latest
      // release action (P3-B). Calendar navigation never silences a release
      // action's legitimate report.
      describe('P3 Retry ownership and release-action feedback', () => {
        const STALE_EDIT = 'Release saved, but Calendar could not refresh. The calendar shown may be out of date.';
        const DECEMBER = ['2026-12'];
        async function editFailedAdoptedLookup(env, picker, feedback) {
          await todayThenPick(env, picker, '06');
          env.document.dispatch('release-edit-saved', { detail: { releaseId: '801' } });
          await flush();
          expect(env.requests).toHaveLength(2);
          env.requests[1].respondWith({
            ok: false, status: 503, url: env.requests[1].url.href, headers: HTML_HEADERS, text: async () => 'unavailable',
          });
          await flush();
          expect(feedback.text()).toBe(STALE_EDIT);
          expect(feedback.retry()).not.toBeNull();
        }
        // As release-archive.js: the confirmed Archive writes its own
        // confirmation, then tells the host.
        function confirmArchive(env, message = 'Release archived.') {
          env.document.querySelector('[data-dialog-feedback-text]').textContent = message;
          env.document.dispatch('release-archived', {
            detail: { releaseId: '1101', message, outcome: 'archived', confirmed: true },
          });
        }

        it('P3-A: a stale Retry refresh after Next sends no GET and never cancels December; December installs with one push', async () => {
          const { env, picker } = rollover();
          const feedback = withEditFeedback(env);
          await editFailedAdoptedLookup(env, picker, feedback);
          const oldRetry = feedback.retry();

          env.click('calendar-next');
          await flush();
          expect(env.requests).toHaveLength(3);
          const december = env.requests[2];
          expect(all(december.url, 'month')).toEqual(DECEMBER);
          expect(filtersOf(december.url)).toEqual(PENDING_FILTERS);
          // Final P3-B: the old control is retired with its generation; a
          // captured reference to it (and its callback) stays inert.
          expect(feedback.retry()).toBeNull();
          oldRetry.dispatch('click');
          oldRetry.dispatch('click');
          await flush();
          expect(env.requests).toHaveLength(3);
          expect(december.options.signal.aborted).toBe(false);
          expect(feedback.text()).toBe(STALE_EDIT);
          expect(env.windowObject.history.pushes).toEqual([]);

          december.respond();
          await flush();
          expect(env.installed().month).toBe('2026-12');
          expect(env.installed().ids).toEqual([901]);
          expect(new URL(env.windowObject.location.href).searchParams.get('month')).toBe('2026-12');
          expect(env.windowObject.history.pushes).toHaveLength(1);
          const pushed = new URL(env.windowObject.history.pushes[0], ORIGIN);
          expect(all(pushed, 'month')).toEqual(DECEMBER);
          expect(filtersOf(pushed)).toEqual(PENDING_FILTERS);
          expect(env.windowObject.history.replaces).toEqual([]);
          // The completed load still ends the Edit's own stale report.
          expect(feedback.text()).toBe('Release updated.');
          expect(feedback.retry()).toBeNull();
          expect(env.requests.some(({ url }) => all(url, 'month').includes('2027-06'))).toBe(false);
          expect(onlyGets(env.windowObject)).toBe(true);
          expect(env.windowObject.fetch).toHaveBeenCalledTimes(3);
        });

        it('P3-A: the current Retry refresh still works once, however often it is activated', async () => {
          const { env, picker } = rollover();
          const feedback = withEditFeedback(env);
          await editFailedAdoptedLookup(env, picker, feedback);
          const retry = feedback.retry();
          retry.dispatch('click');
          retry.dispatch('click');
          await flush();
          retry.dispatch('click');
          await flush();
          // One fresh read-only lookup, nothing else.
          expect(env.requests).toHaveLength(3);
          expect(feedback.text()).toBe('Release saved. Refreshing Calendar…');
          await serverYear(env, 2);
          expect(env.requests).toHaveLength(4);
          expect(all(env.requests[3].url, 'month')).toEqual(['2027-06']);
          expect(filtersOf(env.requests[3].url)).toEqual(PENDING_FILTERS);
          env.requests[3].respond();
          await flush();
          expect(env.installed().month).toBe('2027-06');
          expect(feedback.text()).toBe('Release updated.');
          expect(env.windowObject.history.pushes).toHaveLength(1);
          expect(onlyGets(env.windowObject)).toBe(true);
          expect(env.windowObject.fetch).toHaveBeenCalledTimes(4);
        });

        it('P3-A: Back / Forward and a later filter edit each take Retry authority from the failed refresh', async () => {
          let { env, picker } = rollover();
          let feedback = withEditFeedback(env);
          await editFailedAdoptedLookup(env, picker, feedback);
          let oldRetry = feedback.retry();
          env.windowObject.setLocation(`${ORIGIN}/calendar?month=2026-10&project=1&project=2&type=comic&type=images&status=all&view=list&weekStart=sunday`);
          env.windowObject.dispatch('popstate');
          await flush();
          expect(env.requests).toHaveLength(3);
          const back = env.requests[2];
          expect(all(back.url, 'month')).toEqual(['2026-10']);
          oldRetry.dispatch('click');
          await flush();
          expect(env.requests).toHaveLength(3);
          expect(back.options.signal.aborted).toBe(false);
          back.respond();
          await flush();
          expect(env.installed().month).toBe('2026-10');
          expect(env.windowObject.history.pushes).toEqual([]);

          ({ env, picker } = rollover());
          feedback = withEditFeedback(env);
          await editFailedAdoptedLookup(env, picker, feedback);
          oldRetry = feedback.retry();
          env.toggle('status', 'planned');
          await flush();
          // The filter edit continues June with its own fresh lookup.
          expect(env.requests).toHaveLength(3);
          const lookup = env.requests[2];
          oldRetry.dispatch('click');
          await flush();
          expect(env.requests).toHaveLength(3);
          expect(lookup.options.signal.aborted).toBe(false);
          await serverYear(env, 2);
          expect(all(env.requests[3].url, 'month')).toEqual(['2027-06']);
          expect(all(env.requests[3].url, 'status')).toEqual(['planned']);
          expect(onlyGets(env.windowObject)).toBe(true);
        });

        it('P3-A: a Retry lookup superseded by Next never installs June; December does', async () => {
          const { env, picker } = rollover();
          const feedback = withEditFeedback(env);
          await editFailedAdoptedLookup(env, picker, feedback);
          feedback.retry().dispatch('click');
          await flush();
          expect(env.requests).toHaveLength(3);
          const lookup = env.requests[2];
          env.click('calendar-next');
          await flush();
          expect(lookup.options.signal.aborted).toBe(true);
          const december = env.requests[3];
          expect(all(december.url, 'month')).toEqual(DECEMBER);
          lookup.respond();
          await flush();
          expect(env.requests).toHaveLength(4);
          december.respond();
          await flush();
          expect(env.installed().month).toBe('2026-12');
          expect(env.requests.some(({ url }) => all(url, 'month').includes('2027-06'))).toBe(false);
          expect(env.windowObject.history.pushes).toHaveLength(1);
        });

        it('P3-B: an older Edit refresh never replaces a newer Archive confirmation when June installs', async () => {
          const { env, picker } = rollover();
          const feedback = withEditFeedback(env);
          await editFailedAdoptedLookup(env, picker, feedback);
          const editRetry = feedback.retry();

          confirmArchive(env);
          await flush();
          // The Archive refresh owns the June recovery: one fresh lookup.
          expect(feedback.retry()).toBeNull();
          expect(env.requests).toHaveLength(3);
          // The Edit's captured Retry belongs to an older action.
          editRetry.dispatch('click');
          await flush();
          expect(env.requests).toHaveLength(3);
          expect(feedback.text()).toBe('Release archived.');
          await serverYear(env, 2);
          env.requests[3].respond();
          await flush();
          expect(env.installed().month).toBe('2027-06');
          expect(feedback.text()).toBe('Release archived.');
          // A later completed load cannot bring the Edit report back either.
          env.click('calendar-next');
          await flush();
          env.requests.at(-1).respond();
          await flush();
          expect(env.installed().month).toBe('2027-07');
          expect(feedback.text()).toBe('Release archived.');
          expect(onlyGets(env.windowObject)).toBe(true);
          expect(env.windowObject.fetch).toHaveBeenCalledTimes(5);
        });

        it('P3-B: an Edit with no newer release action still reports Release updated after a later navigation', async () => {
          const { env, picker } = rollover();
          const feedback = withEditFeedback(env);
          await editFailedAdoptedLookup(env, picker, feedback);
          env.click('calendar-previous');
          await flush();
          env.requests[2].respond();
          await flush();
          expect(env.installed().month).toBe('2026-10');
          expect(feedback.text()).toBe('Release updated.');
          expect(feedback.retry()).toBeNull();
        });

        it('P3-B: a newer release failure is never replaced by the older Edit success; a newer failed Archive refresh reports its own outcome', async () => {
          let { env, picker } = rollover();
          let feedback = withEditFeedback(env);
          await editFailedAdoptedLookup(env, picker, feedback);
          // As release-archive.js report(): an unconfirmed Archive writes its
          // own error and dispatches nothing.
          const unconfirmed = 'Could not confirm whether the release was archived. Checking again…';
          env.document.querySelector('[data-dialog-feedback-text]').textContent = unconfirmed;
          env.click('calendar-previous');
          await flush();
          env.requests[2].respond();
          await flush();
          expect(env.installed().month).toBe('2026-10');
          expect(feedback.text()).toBe(unconfirmed);

          ({ env, picker } = rollover());
          feedback = withEditFeedback(env);
          await editFailedAdoptedLookup(env, picker, feedback);
          confirmArchive(env);
          await flush();
          expect(env.requests).toHaveLength(3);
          env.requests[2].fail();
          await flush();
          expect(feedback.text()).toBe('Release archived, but Calendar could not refresh. The calendar shown may be out of date.');
          env.click('calendar-previous');
          await flush();
          env.requests.at(-1).respond();
          await flush();
          expect(env.installed().month).toBe('2026-10');
          expect(feedback.text()).toBe('Release archived.');
          expect(onlyGets(env.windowObject)).toBe(true);
        });

        // Final Calendar M1 P3-A: an Archive (or Delete) whose outcome is
        // unresolved writes its uncertainty and Check again without a Calendar
        // refresh, and tells the host (release-action-unresolved). From then
        // on it is the newer release action and owns the page feedback.
        const UNCERTAIN = 'Could not confirm whether the release was archived. The release still shows as active, but the earlier Archive request may still run. Nothing will be sent again by itself. Your unsaved changes are kept; Check again only reads the release.';
        // As release-archive.js: the unresolved event is sent, then report()
        // writes the uncertainty and offers Check again in the page feedback.
        function reportUnresolvedArchive(env, message = UNCERTAIN) {
          env.document.dispatch('release-action-unresolved', { detail: { releaseId: '1101', action: 'archive' } });
          const notice = env.document.querySelector('[data-dialog-feedback]');
          notice.querySelector('[data-dialog-feedback-text]').textContent = message;
          const check = makeNode({ tagName: 'button', attrs: { 'data-release-archive-feedback-check': '' } });
          check.textContent = 'Check again';
          notice.appendChild(check);
          return check;
        }
        const archiveCheck = (env) => env.document.querySelector('[data-release-archive-feedback-check]');
        const fail503 = (request) => request.respondWith({
          ok: false, status: 503, url: request.url.href, headers: HTML_HEADERS, text: async () => 'unavailable',
        });

        it('Final P3-A: the older Edit lookup failing after a newer unresolved Archive never replaces its uncertainty or Check again', async () => {
          const { env, picker } = rollover();
          const feedback = withEditFeedback(env);
          await todayThenPick(env, picker, '06');
          env.document.querySelector('[data-dialog-feedback-text]').textContent = 'Release updated.';
          env.document.dispatch('release-edit-saved', { detail: { releaseId: '801' } });
          await flush();
          // The Edit refresh adopted the held lookup.
          expect(env.requests).toHaveLength(2);
          const editLookup = env.requests[1];
          const check = reportUnresolvedArchive(env);
          // Claiming the feedback changes no navigation: the lookup is not aborted.
          expect(editLookup.options.signal.aborted).toBe(false);
          fail503(editLookup);
          await flush();
          expect(feedback.text()).toBe(UNCERTAIN);
          expect(archiveCheck(env)).toBe(check);
          expect(feedback.retry()).toBeNull();
          // The failed lookup is still Calendar's own failure, with its own Retry.
          expect(liveFailureRetries(env.document)).toHaveLength(1);
          expect(env.requests).toHaveLength(2);
          expect(env.installed().month).toBe('2026-11');
          expect(env.windowObject.history.pushes).toEqual([]);
          expect(onlyGets(env.windowObject)).toBe(true);
        });

        it('Final P3-A: an unresolved Archive retires an older failed Edit Retry; later completed loads keep the uncertainty', async () => {
          const { env, picker } = rollover();
          const feedback = withEditFeedback(env);
          await editFailedAdoptedLookup(env, picker, feedback);
          const editRetry = feedback.retry();
          const check = reportUnresolvedArchive(env);
          expect(feedback.retry()).toBeNull();
          // A captured reference to the older Retry is inert.
          editRetry.dispatch('click');
          await flush();
          expect(env.requests).toHaveLength(2);
          expect(feedback.text()).toBe(UNCERTAIN);
          // Calendar's own lookup Retry still recovers June; the completed load
          // never writes the older Edit's Release updated over the warning.
          liveFailureRetries(env.document)[0].dispatch('click');
          await flush();
          await serverYear(env, 2);
          env.requests.at(-1).respond();
          await flush();
          expect(env.installed().month).toBe('2027-06');
          expect(feedback.text()).toBe(UNCERTAIN);
          expect(archiveCheck(env)).toBe(check);
          env.click('calendar-next');
          await flush();
          env.requests.at(-1).respond();
          await flush();
          expect(env.installed().month).toBe('2027-07');
          expect(feedback.text()).toBe(UNCERTAIN);
          expect(archiveCheck(env)).toBe(check);
          expect(onlyGets(env.windowObject)).toBe(true);
        });

        it('Final P3-A: a newer Edit after an unresolved Archive still owns its own refresh report; a newer confirmed Archive still wins over an older Edit', async () => {
          let { env, picker } = rollover();
          let feedback = withEditFeedback(env);
          await todayThenPick(env, picker, '06');
          reportUnresolvedArchive(env, 'Could not confirm whether the release was archived. Checking…');
          env.document.dispatch('release-edit-saved', { detail: { releaseId: '801' } });
          await flush();
          fail503(env.requests[1]);
          await flush();
          // No action is newer than this Edit: its failure is reported with Retry.
          expect(feedback.text()).toBe(STALE_EDIT);
          expect(feedback.retry()).not.toBeNull();

          ({ env, picker } = rollover());
          feedback = withEditFeedback(env);
          await todayThenPick(env, picker, '06');
          env.document.dispatch('release-edit-saved', { detail: { releaseId: '801' } });
          await flush();
          const editLookup = env.requests[1];
          confirmArchive(env);
          await flush();
          fail503(editLookup);
          await flush();
          expect(feedback.text()).toBe('Release archived.');
          expect(feedback.retry()).toBeNull();
        });

        it('Final P3-A: an unresolved Delete claims the feedback the same way', async () => {
          const { env, picker } = rollover();
          const feedback = withEditFeedback(env);
          await todayThenPick(env, picker, '06');
          env.document.dispatch('release-edit-saved', { detail: { releaseId: '801' } });
          await flush();
          const unresolvedDelete = 'Could not confirm whether the release was deleted. Checking…';
          env.document.dispatch('release-action-unresolved', { detail: { releaseId: '1101', action: 'delete' } });
          env.document.querySelector('[data-dialog-feedback-text]').textContent = unresolvedDelete;
          fail503(env.requests[1]);
          await flush();
          expect(feedback.text()).toBe(unresolvedDelete);
          expect(feedback.retry()).toBeNull();
        });

        it("Final P3-B: Next fails after the failed adopted refresh: the old Retry refresh is retired (focus to main content) and December's own Retry recovers December", async () => {
          const { env, picker } = rollover();
          const feedback = withEditFeedback(env);
          const main = makeNode({ tagName: 'main', attrs: { id: 'main-content' } });
          env.document.appendChild(main);
          await editFailedAdoptedLookup(env, picker, feedback);
          const oldRetry = feedback.retry();
          oldRetry.focus();
          expect(env.document.activeElement).toBe(oldRetry);

          env.click('calendar-next');
          await flush();
          expect(env.requests).toHaveLength(3);
          const december = env.requests[2];
          expect(all(december.url, 'month')).toEqual(DECEMBER);
          // Retired the moment December owns Calendar, before any answer.
          expect(feedback.retry()).toBeNull();
          expect(oldRetry.parentNode).toBeNull();
          expect(env.document.activeElement).toBe(main);
          fail503(december);
          await flush();
          // December's failure has its one Retry; the old Retry stays retired.
          expect(feedback.retry()).toBeNull();
          expect(liveFailureRetries(env.document)).toHaveLength(1);
          expect(feedback.text()).toBe(STALE_EDIT);
          // A captured old callback is inert: no GET, no history, no feedback.
          oldRetry.dispatch('click');
          oldRetry.dispatch('click');
          await flush();
          expect(env.requests).toHaveLength(3);
          expect(feedback.text()).toBe(STALE_EDIT);
          expect(liveFailureRetries(env.document)).toHaveLength(1);
          expect(env.windowObject.history.pushes).toEqual([]);

          const retry = liveFailureRetries(env.document)[0];
          retry.dispatch('click');
          retry.dispatch('click');
          await flush();
          expect(env.requests).toHaveLength(4);
          const again = env.requests[3];
          expect(all(again.url, 'month')).toEqual(DECEMBER);
          expect(filtersOf(again.url)).toEqual(PENDING_FILTERS);
          again.respond();
          await flush();
          expect(env.installed().month).toBe('2026-12');
          expect(new URL(env.windowObject.location.href).searchParams.get('month')).toBe('2026-12');
          expect(env.windowObject.history.pushes).toHaveLength(1);
          expect(all(new URL(env.windowObject.history.pushes[0], ORIGIN), 'month')).toEqual(DECEMBER);
          expect(env.windowObject.history.replaces).toEqual([]);
          expect(liveFailureRetries(env.document)).toHaveLength(0);
          expect(feedback.text()).toBe('Release updated.');
          expect(env.requests.some(({ url }) => all(url, 'month').includes('2027-06'))).toBe(false);
          expect(onlyGets(env.windowObject)).toBe(true);
          expect(env.windowObject.fetch).toHaveBeenCalledTimes(4);
        });

        it('Final P3-B: the current Retry refresh stays while it owns Calendar; a newer successful navigation retires it', async () => {
          const { env, picker } = rollover();
          const feedback = withEditFeedback(env);
          await editFailedAdoptedLookup(env, picker, feedback);
          const retry = feedback.retry();
          await flush();
          // Nothing newer: still mounted and current.
          expect(feedback.retry()).toBe(retry);
          env.click('calendar-previous');
          await flush();
          expect(feedback.retry()).toBeNull();
          retry.dispatch('click');
          await flush();
          expect(env.requests).toHaveLength(3);
          env.requests[2].respond();
          await flush();
          expect(env.installed().month).toBe('2026-10');
          expect(feedback.text()).toBe('Release updated.');
          expect(feedback.retry()).toBeNull();
          expect(env.windowObject.fetch).toHaveBeenCalledTimes(3);
        });
      });

      // Calendar M1 late verification (P2): an older Archive / Delete Check
      // again answers after a newer release action took the page feedback.
      // Each claim (release-action-unresolved) is answered with an ownership
      // predicate; an observed Archive / Delete whose check lost the feedback
      // (detail feedback: false) still re-reads Calendar, GET only, with the
      // newer action keeping the feedback.
      describe('Late Archive / Delete verification keeps newer release feedback', () => {
        const STALE_EDIT = 'Release saved, but Calendar could not refresh. The calendar shown may be out of date.';
        const claim = (env, action = 'archive') => env.document
          .dispatch('release-action-unresolved', { detail: { releaseId: '1101', action } }).detail.ownsFeedback;
        const ownerOf = (env) => env.document.__creatorCrateCalendarReleaseAction;
        const NOVEMBER_FILTERS = {
          project: ['1', '2'], type: ['comic', 'images'], status: ['all'], view: ['list'], weekStart: ['sunday'],
        };
        const filtersOf = (url) => ({
          project: all(url, 'project'), type: all(url, 'type'), status: all(url, 'status'),
          view: all(url, 'view'), weekStart: all(url, 'weekStart'),
        });
        async function editSaved(env, feedback) {
          env.document.querySelector('[data-dialog-feedback-text]').textContent = 'Release updated.';
          env.document.dispatch('release-edit-saved', { detail: { releaseId: '801' } });
          await flush();
          return env.requests.at(-1);
        }

        it('LV-C1: each claim is answered with a predicate that a newer release action (Edit, Archive, Delete or another claim) retires', async () => {
          const { env } = rollover();
          withEditFeedback(env);
          const first = claim(env);
          expect(first()).toBe(true);
          await editSaved(env);
          expect(first()).toBe(false);
          const second = claim(env, 'delete');
          expect(second()).toBe(true);
          const third = claim(env);
          expect(second()).toBe(false);
          expect(third()).toBe(true);
          env.document.dispatch('release-archived', { detail: { releaseId: '7', message: 'Release archived.', outcome: 'archived', confirmed: true } });
          expect(third()).toBe(false);
          // Claiming changes no navigation and sends nothing.
          expect(onlyGets(env.windowObject)).toBe(true);
        });

        // Calendar Correction M1 (P2): the page feedback's controls belong to
        // its owner. A newer release action retires an older Archive / Delete
        // page-level Check again, so it is never reachable beside the newer
        // report (the release keeps Check again in its own dialog).
        it('Correction M1 P2-A / P2-D: a newer Edit retires older Archive and Delete page Check again; its failed refresh keeps only its own GET-only Retry', async () => {
          const { env } = rollover();
          const feedback = withEditFeedback(env);
          const main = makeNode({ tagName: 'main', attrs: { id: 'main-content' } });
          env.document.appendChild(main);
          const notice = env.document.querySelector('[data-dialog-feedback]');
          claim(env);
          const archiveCheck = makeNode({ tagName: 'button', attrs: { 'data-release-archive-feedback-check': '' } });
          const deleteCheck = makeNode({ tagName: 'button', attrs: { 'data-release-delete-feedback-check': '' } });
          notice.appendChild(archiveCheck);
          notice.appendChild(deleteCheck);
          archiveCheck.focus();
          const edit = await editSaved(env);
          expect(archiveCheck.parentNode).toBeNull();
          expect(deleteCheck.parentNode).toBeNull();
          expect(env.document.activeElement).toBe(main);
          const before = env.requests.length;
          edit.respondWith({
            ok: false, status: 503, url: edit.url.href, headers: HTML_HEADERS, text: async () => 'unavailable',
          });
          await flush();
          expect(feedback.text()).toBe(STALE_EDIT);
          const retry = feedback.retry();
          expect(retry).not.toBeNull();
          expect(notice.querySelectorAll('button')).toEqual([retry]);
          retry.dispatch('click');
          await flush();
          expect(env.requests).toHaveLength(before + 1);
          expect(all(env.requests.at(-1).url, 'month')).toEqual(['2026-11']);
          expect(filtersOf(env.requests.at(-1).url)).toEqual(NOVEMBER_FILTERS);
          env.requests.at(-1).respond();
          await flush();
          expect(feedback.text()).toBe('Release updated.');
          expect(env.installed().month).toBe('2026-11');
          expect(env.windowObject.history.pushes).toEqual([]);
          expect(onlyGets(env.windowObject)).toBe(true);
        });

        it('Correction M1 P2-A: an unresolved Archive claiming the feedback retires an older Delete page Check again', () => {
          const { env } = rollover();
          withEditFeedback(env);
          const notice = env.document.querySelector('[data-dialog-feedback]');
          claim(env, 'delete');
          const deleteCheck = makeNode({ tagName: 'button', attrs: { 'data-release-delete-feedback-check': '' } });
          notice.appendChild(deleteCheck);
          claim(env, 'archive');
          expect(deleteCheck.parentNode).toBeNull();
          expect(onlyGets(env.windowObject)).toBe(true);
        });

        it('LV-I: an observed Archive under a newer Edit re-reads November (filters, view, week start) with one GET; the Edit keeps the feedback and its owner', async () => {
          const { env } = rollover();
          const feedback = withEditFeedback(env);
          const edit = await editSaved(env);
          edit.respond();
          await flush();
          const owner = ownerOf(env);
          const before = env.requests.length;
          env.document.dispatch('release-archived', { detail: {
            releaseId: '1101', projectId: null, release: null, message: 'The release is archived now, but this page could not confirm whether that Archive request archived it.',
            outcome: 'observed-archived', confirmed: false, feedback: false,
          } });
          await flush();
          expect(env.requests).toHaveLength(before + 1);
          const reread = env.requests.at(-1).url;
          expect(all(reread, 'month')).toEqual(['2026-11']);
          expect(filtersOf(reread)).toEqual(NOVEMBER_FILTERS);
          env.requests.at(-1).respond();
          await flush();
          expect(env.installed().month).toBe('2026-11');
          expect(feedback.text()).toBe('Release updated.');
          expect(feedback.retry()).toBeNull();
          expect(ownerOf(env)).toBe(owner);
          expect(env.windowObject.history.pushes).toEqual([]);
          expect(onlyGets(env.windowObject)).toBe(true);
        });

        it('LV-J: an observed Delete (gone) under a newer Edit re-reads Calendar the same way; its failure is Calendar\'s own, never the Edit report', async () => {
          const { env } = rollover();
          const feedback = withEditFeedback(env);
          const edit = await editSaved(env);
          edit.respond();
          await flush();
          const owner = ownerOf(env);
          env.document.dispatch('release-deleted', { detail: {
            releaseId: '1101', projectId: null, title: 'B', message: 'This release no longer exists.',
            outcome: 'observed-missing', confirmed: false, feedback: false, hostRetired: false,
          } });
          await flush();
          const reread = env.requests.at(-1);
          expect(all(reread.url, 'month')).toEqual(['2026-11']);
          reread.respondWith({ ok: false, status: 503, url: reread.url.href, headers: HTML_HEADERS, text: async () => 'unavailable' });
          await flush();
          expect(feedback.text()).toBe('Release updated.');
          expect(feedback.retry()).toBeNull();
          expect(ownerOf(env)).toBe(owner);
          // Calendar's own GET-only Retry recovers November.
          expect(liveFailureRetries(env.document)).toHaveLength(1);
          liveFailureRetries(env.document)[0].dispatch('click');
          await flush();
          expect(all(env.requests.at(-1).url, 'month')).toEqual(['2026-11']);
          env.requests.at(-1).respond();
          await flush();
          expect(feedback.text()).toBe('Release updated.');
          expect(onlyGets(env.windowObject)).toBe(true);
        });

        it('LV-E: an observed Archive under a newer failed Edit refresh refreshes Calendar; the completed load clears the Edit stale notice in the Edit\'s own words', async () => {
          const { env } = rollover();
          const feedback = withEditFeedback(env);
          const edit = await editSaved(env);
          edit.respondWith({ ok: false, status: 503, url: edit.url.href, headers: HTML_HEADERS, text: async () => 'unavailable' });
          await flush();
          expect(feedback.text()).toBe(STALE_EDIT);
          expect(feedback.retry()).not.toBeNull();
          env.document.dispatch('release-archived', { detail: {
            releaseId: '1101', message: 'Observed.', outcome: 'observed-archived', confirmed: false, feedback: false,
          } });
          await flush();
          // The newer refresh moved Calendar on: the Edit's Retry for the
          // older generation is retired (P3-B), never left inert.
          expect(feedback.retry()).toBeNull();
          expect(feedback.text()).toBe(STALE_EDIT);
          env.requests.at(-1).respond();
          await flush();
          expect(feedback.text()).toBe('Release updated.');
          expect(env.installed().month).toBe('2026-11');
          expect(onlyGets(env.windowObject)).toBe(true);
        });

        it('LV-N: an observed Archive during a newer Previous navigation keeps October and its push; no obsolete month is restored', async () => {
          const { env } = rollover();
          const feedback = withEditFeedback(env);
          const edit = await editSaved(env);
          edit.respond();
          await flush();
          env.click('calendar-previous');
          await flush();
          const previous = env.requests.at(-1);
          expect(all(previous.url, 'month')).toEqual(['2026-10']);
          env.document.dispatch('release-archived', { detail: {
            releaseId: '1101', message: 'Observed.', outcome: 'observed-archived', confirmed: false, feedback: false,
          } });
          await flush();
          const takeover = env.requests.at(-1);
          expect(all(takeover.url, 'month')).toEqual(['2026-10']);
          expect(filtersOf(takeover.url)).toEqual(NOVEMBER_FILTERS);
          takeover.respond();
          previous.respond();
          await flush();
          expect(env.installed().month).toBe('2026-10');
          expect(env.windowObject.history.pushes).toHaveLength(1);
          expect(feedback.text()).toBe('Release updated.');
          expect(onlyGets(env.windowObject)).toBe(true);
        });

        it('LV-H: an observed Archive that still owns the feedback keeps the ordinary release refresh report', async () => {
          const { env } = rollover();
          const feedback = withEditFeedback(env);
          const ownsFeedback = claim(env);
          const message = 'The release is archived now, but this page could not confirm whether that Archive request archived it.';
          expect(ownsFeedback()).toBe(true);
          env.document.dispatch('release-archived', { detail: {
            releaseId: '1101', message, outcome: 'observed-archived', confirmed: false,
          } });
          await flush();
          // A new release action (this refresh) owns the feedback now.
          expect(ownsFeedback()).toBe(false);
          const reread = env.requests.at(-1);
          reread.respondWith({ ok: false, status: 503, url: reread.url.href, headers: HTML_HEADERS, text: async () => 'unavailable' });
          await flush();
          expect(feedback.text()).toBe(`${message} Calendar could not refresh, so it may still show this release.`);
          expect(feedback.retry()).not.toBeNull();
        });
      });

      // Calendar second-release-action P2: a confirmed Edit refresh adopted
      // the picked June's held server-year lookup; a newer confirmed Archive
      // takes over the refresh (and the release feedback) before the lookup
      // answers. Archive changes release data, not the month: June stays the
      // navigation intent under a newer generation.
      describe('Second release action keeps the pending picked month', () => {
        const ARCHIVED = 'Release archived.';
        const STALE_ARCHIVE = 'Release archived, but Calendar could not refresh. The calendar shown may be out of date.';
        const STALE_EDIT = 'Release saved, but Calendar could not refresh. The calendar shown may be out of date.';
        const VIEW_GRID = { ...PENDING_FILTERS, view: ['grid'] };
        // As release-archive.js: the confirmed Archive writes its own
        // confirmation, then tells the host.
        function confirmArchive(env) {
          env.document.querySelector('[data-dialog-feedback-text]').textContent = ARCHIVED;
          env.document.dispatch('release-archived', {
            detail: { releaseId: '1101', message: ARCHIVED, outcome: 'archived', confirmed: true },
          });
        }
        // Held Today → June; the acknowledged Edit refresh joins the held
        // lookup; Archive confirms before that lookup answers.
        async function archiveDuringAdoptedLookup(env, picker) {
          await todayThenPick(env, picker, '06');
          expect(env.requests).toHaveLength(2);
          const editLookup = env.requests[1];
          env.document.querySelector('[data-dialog-feedback-text]').textContent = 'Release updated.';
          env.document.dispatch('release-edit-saved', { detail: { releaseId: '801' } });
          await flush();
          // The Edit refresh adopted the held lookup: nothing new requested.
          expect(env.requests).toHaveLength(2);
          expect(editLookup.options.signal.aborted).toBe(false);
          const editGeneration = calendarLiveSnapshot(env.document).generation;
          confirmArchive(env);
          await flush();
          return { editLookup, editGeneration };
        }
        const isNovemberPage = (url) => all(url, 'month').includes('2026-11') && keys(url).length > 1;

        it('REPRODUCTION: Archive during the Edit-adopted June lookup keeps June: newer generation, one June 2027 push, Archive feedback, GET only', async () => {
          const { env, picker } = rollover();
          const feedback = withEditFeedback(env);
          const phases = [];
          subscribeCalendarLive(env.document, ({ phase, generation }) => phases.push([phase, generation]));
          const { editLookup, editGeneration } = await archiveDuringAdoptedLookup(env, picker);

          // The older lookup is aborted; June continues as ONE newer lookup.
          expect(editLookup.options.signal.aborted).toBe(true);
          expect(env.requests).toHaveLength(3);
          const snapshot = calendarLiveSnapshot(env.document);
          expect(snapshot.generation).toBeGreaterThan(editGeneration);
          expect(snapshot.pending).toBe(true);
          expect(snapshot.failed).toBe(false);
          expect(snapshot.requestedHistoryMode).toBe('push');
          const intended = new URL(snapshot.intendedUrl);
          expect(monthless(intended)).toBe(true);
          expect(filtersOf(intended)).toEqual(PENDING_FILTERS);
          expect(env.requests.some(({ url }) => isNovemberPage(url))).toBe(false);
          expect(env.installed().month).toBe('2026-11');
          expect(env.windowObject.history.pushes).toEqual([]);
          expect(env.windowObject.history.replaces).toEqual([]);
          // The picked month is still the picker's intent.
          picker.open();
          expect(shows(picker)).toEqual({ year: '2026', months: ['06'] });

          // The older lookup answering late is ignored (nothing requested).
          editLookup.respond();
          await flush();
          expect(env.requests).toHaveLength(3);
          await serverYear(env, 2);
          expect(env.requests).toHaveLength(4);
          const june = env.requests[3].url;
          expect(all(june, 'month')).toEqual(['2027-06']);
          expect(filtersOf(june)).toEqual(PENDING_FILTERS);
          expect(picker.year.value).toBe('2027');
          env.requests[3].respond();
          await flush();
          // The aborted Today answering last never installs.
          env.requests[0].respond();
          await flush();

          const result = env.installed();
          expect(result.month).toBe('2027-06');
          expect(result.heading).toBe('2027-06');
          expect(result.ids).toEqual([1101, 1102]);
          expect(result.checked('project')).toEqual(['1', '2']);
          expect(result.checked('type')).toEqual(['comic', 'images']);
          expect(result.checked('status')).toEqual(['all']);
          expect(result.checked('view')).toEqual(['list']);
          expect(result.checked('weekStart')).toEqual(['sunday']);
          expect(all(new URL(result.location), 'month')).toEqual(['2027-06']);
          expect(env.windowObject.history.pushes).toHaveLength(1);
          const pushed = new URL(env.windowObject.history.pushes[0], ORIGIN);
          expect(all(pushed, 'month')).toEqual(['2027-06']);
          expect(filtersOf(pushed)).toEqual(PENDING_FILTERS);
          expect(env.windowObject.history.replaces).toEqual([]);
          // Archive owns the feedback; the Edit report never returns.
          expect(feedback.text()).toBe(ARCHIVED);
          expect(feedback.retry()).toBeNull();
          // No release write replayed: Today, two lookups, June — all GETs.
          expect(onlyGets(env.windowObject)).toBe(true);
          expect(env.windowObject.fetch).toHaveBeenCalledTimes(4);
          // Only the newer generation installs, exactly once.
          const installs = phases.filter(([phase]) => phase === 'installed');
          expect(installs).toEqual([['installed', snapshot.generation]]);
        });

        it('the older lookup failing after the handoff reports nothing; Archive feedback stays and June still installs', async () => {
          const { env, picker } = rollover();
          const feedback = withEditFeedback(env);
          const { editLookup } = await archiveDuringAdoptedLookup(env, picker);
          editLookup.respondWith({
            ok: false, status: 503, url: editLookup.url.href, headers: HTML_HEADERS, text: async () => 'unavailable',
          });
          await flush();
          expect(feedback.text()).toBe(ARCHIVED);
          expect(feedback.retry()).toBeNull();
          expect(calendarLiveSnapshot(env.document).failed).toBe(false);
          await serverYear(env, 2);
          env.requests[3].respond();
          await flush();
          expect(env.installed().month).toBe('2027-06');
          expect(feedback.text()).toBe(ARCHIVED);
          expect(feedback.text()).not.toBe(STALE_EDIT);
          expect(env.windowObject.history.pushes).toHaveLength(1);
          expect(onlyGets(env.windowObject)).toBe(true);
        });

        it('Archive after the June lookup answered (June GET held) re-requests June 2027 once; the superseded June GET never installs', async () => {
          const { env, picker } = rollover();
          const feedback = withEditFeedback(env);
          await todayThenPick(env, picker, '06');
          env.document.dispatch('release-edit-saved', { detail: { releaseId: '801' } });
          await flush();
          await serverYear(env, 1);
          expect(env.requests).toHaveLength(3);
          const editJune = env.requests[2];
          expect(all(editJune.url, 'month')).toEqual(['2027-06']);
          const editGeneration = calendarLiveSnapshot(env.document).generation;
          confirmArchive(env);
          await flush();
          expect(editJune.options.signal.aborted).toBe(true);
          expect(env.requests).toHaveLength(4);
          const archiveJune = env.requests[3];
          expect(all(archiveJune.url, 'month')).toEqual(['2027-06']);
          expect(filtersOf(archiveJune.url)).toEqual(PENDING_FILTERS);
          expect(calendarLiveSnapshot(env.document).generation).toBeGreaterThan(editGeneration);
          editJune.respond();
          await flush();
          expect(env.installed().month).toBe('2026-11');
          archiveJune.respond();
          await flush();
          expect(env.installed().month).toBe('2027-06');
          expect(env.windowObject.history.pushes).toHaveLength(1);
          expect(new URL(env.windowObject.history.pushes[0], ORIGIN).searchParams.get('month')).toBe('2027-06');
          expect(env.windowObject.history.replaces).toEqual([]);
          expect(feedback.text()).toBe(ARCHIVED);
          expect(env.requests.some(({ url }) => isNovemberPage(url))).toBe(false);
          expect(onlyGets(env.windowObject)).toBe(true);
          expect(env.windowObject.fetch).toHaveBeenCalledTimes(4);
        });

        it('a failed transferred lookup reports the Archive (never the Edit); its Retry repeats only the lookup and installs June once', async () => {
          const { env, picker } = rollover();
          const feedback = withEditFeedback(env);
          await archiveDuringAdoptedLookup(env, picker);
          env.requests[2].respondWith({
            ok: false, status: 503, url: env.requests[2].url.href, headers: HTML_HEADERS, text: async () => 'unavailable',
          });
          await flush();
          expect(feedback.text()).toBe(STALE_ARCHIVE);
          expect(env.installed().month).toBe('2026-11');
          expect(env.windowObject.history.pushes).toEqual([]);
          const retry = feedback.retry();
          expect(retry).not.toBeNull();
          retry.dispatch('click');
          retry.dispatch('click');
          await flush();
          expect(env.requests).toHaveLength(4);
          await serverYear(env, 3);
          expect(all(env.requests[4].url, 'month')).toEqual(['2027-06']);
          expect(filtersOf(env.requests[4].url)).toEqual(PENDING_FILTERS);
          env.requests[4].respond();
          await flush();
          expect(env.installed().month).toBe('2027-06');
          expect(feedback.text()).toBe(ARCHIVED);
          expect(feedback.retry()).toBeNull();
          expect(env.windowObject.history.pushes).toHaveLength(1);
          expect(onlyGets(env.windowObject)).toBe(true);
          expect(env.windowObject.fetch).toHaveBeenCalledTimes(5);
        });

        it('a newer explicit navigation after the handoff replaces June: Next, Today, Back, another picked month, Reset filters', async () => {
          const neverJune = (env) => env.requests.every(({ url }) => !all(url, 'month').includes('2027-06'));

          // Next: December under the pending filters, one push.
          let { env, picker } = rollover();
          let feedback = withEditFeedback(env);
          await archiveDuringAdoptedLookup(env, picker);
          let lookup = env.requests[2];
          env.click('calendar-next');
          await flush();
          expect(lookup.options.signal.aborted).toBe(true);
          const december = env.requests[3];
          expect(all(december.url, 'month')).toEqual(['2026-12']);
          expect(filtersOf(december.url)).toEqual(PENDING_FILTERS);
          lookup.respond();
          await flush();
          expect(env.requests).toHaveLength(4);
          december.respond();
          await flush();
          expect(env.installed().month).toBe('2026-12');
          expect(env.windowObject.history.pushes).toHaveLength(1);
          expect(new URL(env.windowObject.history.pushes[0], ORIGIN).searchParams.get('month')).toBe('2026-12');
          expect(neverJune(env)).toBe(true);
          expect(feedback.text()).toBe(ARCHIVED);
          expect(onlyGets(env.windowObject)).toBe(true);

          // Today: the monthless destination the server resolves (January).
          ({ env, picker } = rollover());
          withEditFeedback(env);
          await archiveDuringAdoptedLookup(env, picker);
          lookup = env.requests[2];
          env.click('calendar-today');
          await flush();
          expect(lookup.options.signal.aborted).toBe(true);
          expect(monthless(env.requests[3].url)).toBe(true);
          expect(filtersOf(env.requests[3].url)).toEqual(PENDING_FILTERS);
          lookup.respond();
          env.requests[3].respond();
          await flush();
          expect(env.installed().month).toBe('2027-01');
          expect(neverJune(env)).toBe(true);
          expect(env.windowObject.history.pushes).toHaveLength(1);

          // Back / Forward: the history entry, replacing (no push).
          ({ env, picker } = rollover());
          withEditFeedback(env);
          await archiveDuringAdoptedLookup(env, picker);
          lookup = env.requests[2];
          env.windowObject.setLocation(`${ORIGIN}/calendar?month=2026-10&project=1&project=2&type=comic&type=images&status=all&view=list&weekStart=sunday`);
          env.windowObject.dispatch('popstate');
          await flush();
          expect(lookup.options.signal.aborted).toBe(true);
          expect(all(env.requests[3].url, 'month')).toEqual(['2026-10']);
          lookup.respond();
          env.requests[3].respond();
          await flush();
          expect(env.installed().month).toBe('2026-10');
          expect(env.windowObject.history.pushes).toEqual([]);
          expect(neverJune(env)).toBe(true);

          // Another picked month: August, through its own lookup, one push.
          ({ env, picker } = rollover());
          withEditFeedback(env);
          await archiveDuringAdoptedLookup(env, picker);
          lookup = env.requests[2];
          picker.open();
          choose(picker, '08');
          await flush();
          expect(lookup.options.signal.aborted).toBe(true);
          lookup.respond();
          await flush();
          expect(env.requests).toHaveLength(4);
          await serverYear(env, 3);
          expect(all(env.requests[4].url, 'month')).toEqual(['2027-08']);
          expect(filtersOf(env.requests[4].url)).toEqual(PENDING_FILTERS);
          env.requests[4].respond();
          await flush();
          expect(env.installed().month).toBe('2027-08');
          expect(env.windowObject.history.pushes).toHaveLength(1);
          expect(neverJune(env)).toBe(true);

          // Reset filters: the explicit month-only destination.
          ({ env, picker } = rollover());
          feedback = withEditFeedback(env);
          await archiveDuringAdoptedLookup(env, picker);
          lookup = env.requests[2];
          expect(navigateCalendarLive(env.document, '/calendar?month=2026-11').status).toBe('started');
          await flush();
          expect(lookup.options.signal.aborted).toBe(true);
          expect([...env.requests[3].url.searchParams.entries()]).toEqual([['month', '2026-11']]);
          lookup.respond();
          env.requests[3].respond();
          await flush();
          expect(env.installed().month).toBe('2026-11');
          expect(neverJune(env)).toBe(true);
          expect(feedback.text()).toBe(ARCHIVED);
          expect(onlyGets(env.windowObject)).toBe(true);
        });

        it('an applicable Status or View change after the handoff keeps June and composes with it', async () => {
          // Status: June continues under Planned, through one fresh lookup.
          let { env, picker } = rollover();
          let feedback = withEditFeedback(env);
          await archiveDuringAdoptedLookup(env, picker);
          let lookup = env.requests[2];
          env.toggle('status', 'planned');
          await flush();
          expect(lookup.options.signal.aborted).toBe(true);
          expect(env.requests).toHaveLength(4);
          await serverYear(env, 3);
          expect(all(env.requests[4].url, 'month')).toEqual(['2027-06']);
          expect(filtersOf(env.requests[4].url)).toEqual(PLANNED_FILTERS);
          env.requests[4].respond();
          await flush();
          expect(env.installed().month).toBe('2027-06');
          expect(env.installed().checked('status')).toEqual(['planned']);
          expect(env.windowObject.history.pushes).toHaveLength(1);
          expect(feedback.text()).toBe(ARCHIVED);

          // Toolbar View: June continues in Grid.
          ({ env, picker } = rollover());
          feedback = withEditFeedback(env);
          await archiveDuringAdoptedLookup(env, picker);
          lookup = env.requests[2];
          env.click('calendar-view-link-grid');
          await flush();
          expect(lookup.options.signal.aborted).toBe(true);
          expect(env.requests).toHaveLength(4);
          await serverYear(env, 3);
          expect(all(env.requests[4].url, 'month')).toEqual(['2027-06']);
          expect(filtersOf(env.requests[4].url)).toEqual(VIEW_GRID);
          env.requests[4].respond();
          await flush();
          expect(env.installed().month).toBe('2027-06');
          expect(env.region().getAttribute('data-calendar-view')).toBe('grid');
          expect(env.windowObject.history.pushes).toHaveLength(1);
          expect(feedback.text()).toBe(ARCHIVED);
          expect(onlyGets(env.windowObject)).toBe(true);
        });
      });

      // Calendar P2 authority corrections. November 2026 is installed in Grid
      // view; the toolbar List link and a Status edit compose with a picked
      // June still waiting for (or failed to get) its server year.
      describe('P2 authority corrections', () => {
        const NOVEMBER_GRID = NOVEMBER.replace('view=list', 'view=grid');
        const GRID_FILTERS = { ...PENDING_FILTERS, view: ['grid'] };
        const LIST_PLANNED = { ...PENDING_FILTERS, view: ['list'], status: ['planned'] };

        function gridRollover() {
          TODAY_MONTH = '2026-12';
          const env = r2Environment(NOVEMBER_GRID);
          const picker = withPicker(env);
          TODAY_MONTH = '2027-01';
          return { env, picker };
        }
        const failWith503 = (request) => request.respondWith({
          ok: false, status: 503, url: request.url.href, headers: HTML_HEADERS, text: async () => 'unavailable',
        });
        async function adoptedFailure(env, picker, feedback) {
          await todayThenPick(env, picker, '06');
          env.document.dispatch('release-edit-saved', { detail: { releaseId: '801' } });
          await flush();
          expect(env.requests).toHaveLength(2);
          failWith503(env.requests[1]);
          await flush();
          expect(feedback.retry()).not.toBeNull();
        }
        // Final June install under List + Planned, one push, GET only.
        async function expectJuneListPlanned(env, lookupIndex) {
          await serverYear(env, lookupIndex);
          const june = env.requests[lookupIndex + 1].url;
          expect(all(june, 'month')).toEqual(['2027-06']);
          expect(filtersOf(june)).toEqual(LIST_PLANNED);
          env.requests[lookupIndex + 1].respond();
          await flush();
          const result = env.installed();
          expect(result.month).toBe('2027-06');
          expect(result.heading).toBe('2027-06');
          expect(env.region().getAttribute('data-calendar-view')).toBe('list');
          expect(result.checked('view')).toEqual(['list']);
          expect(result.checked('status')).toEqual(['planned']);
          expect(result.checked('project')).toEqual(['1', '2']);
          expect(result.checked('type')).toEqual(['comic', 'images']);
          expect(result.checked('weekStart')).toEqual(['sunday']);
          expect(env.windowObject.history.pushes).toHaveLength(1);
          const pushed = new URL(env.windowObject.history.pushes[0], ORIGIN);
          expect(pushed.searchParams.get('month')).toBe('2027-06');
          expect(pushed.searchParams.get('view')).toBe('list');
          expect(pushed.searchParams.get('status')).toBe('planned');
          expect(env.windowObject.history.replaces).toEqual([]);
          expect(onlyGets(env.windowObject)).toBe(true);
          expect(env.requests.some(({ url }) => all(url, 'month').includes('2026-06'))).toBe(false);
        }

        it('P2-A A: pending lookup → toolbar List → Planned keeps June, List and every filter', async () => {
          const { env, picker } = gridRollover();
          await todayThenPick(env, picker, '06');
          const today = env.requests[0];
          env.click('calendar-view-link-list');
          await flush();
          expect(env.requests[1].options.signal.aborted).toBe(true);
          expect(env.requests).toHaveLength(3);
          // The newer View intent is mirrored into the filter form at once.
          expect(env.installed().checked('view')).toEqual(['list']);
          env.toggle('status', 'planned');
          await flush();
          expect(env.requests[2].options.signal.aborted).toBe(true);
          expect(env.requests).toHaveLength(4);
          const intended = new URL(calendarLiveSnapshot(env.document).intendedUrl);
          expect(monthless(intended)).toBe(true);
          expect(filtersOf(intended)).toEqual(LIST_PLANNED);
          await expectJuneListPlanned(env, 3);
          today.respond();
          await flush();
          expect(env.installed().month).toBe('2027-06');
          expect(env.installed().checked('view')).toEqual(['list']);
        });

        it('P2-A B: failed standalone lookup → toolbar List → Planned keeps June and List', async () => {
          const { env, picker } = gridRollover();
          await todayThenPick(env, picker, '06');
          env.requests[1].fail();
          await flush();
          expect(liveFailureRetries(env.document)).toHaveLength(1);
          env.click('calendar-view-link-list');
          await flush();
          expect(liveFailureNotice(env.document)).toBeNull();
          expect(env.requests).toHaveLength(3);
          expect(env.installed().checked('view')).toEqual(['list']);
          env.toggle('status', 'planned');
          await flush();
          expect(env.requests).toHaveLength(4);
          await expectJuneListPlanned(env, 3);
        });

        it('P2-A C: failed release-adopted lookup → toolbar List → Planned keeps June and List', async () => {
          const { env, picker } = gridRollover();
          const feedback = withEditFeedback(env);
          await adoptedFailure(env, picker, feedback);
          env.click('calendar-view-link-list');
          await flush();
          expect(env.requests).toHaveLength(3);
          expect(env.installed().checked('view')).toEqual(['list']);
          env.toggle('status', 'planned');
          await flush();
          expect(env.requests).toHaveLength(4);
          await expectJuneListPlanned(env, 3);
          expect(feedback.text()).toBe('Release updated.');
        });

        it('P2-A D: the newest View stays authoritative: List → Grid → Planned, and Planned → List', async () => {
          let { env, picker } = gridRollover();
          await todayThenPick(env, picker, '06');
          env.click('calendar-view-link-list');
          await flush();
          env.click('calendar-view-link-grid');
          await flush();
          expect(env.installed().checked('view')).toEqual(['grid']);
          env.toggle('status', 'planned');
          await flush();
          expect(env.requests).toHaveLength(5);
          await serverYear(env, 4);
          expect(filtersOf(env.requests[5].url)).toEqual({ ...GRID_FILTERS, status: ['planned'] });
          expect(all(env.requests[5].url, 'month')).toEqual(['2027-06']);

          ({ env, picker } = gridRollover());
          await todayThenPick(env, picker, '06');
          env.toggle('status', 'planned');
          await flush();
          env.click('calendar-view-link-list');
          await flush();
          expect(env.installed().checked('status')).toEqual(['planned']);
          expect(env.requests).toHaveLength(4);
          await expectJuneListPlanned(env, 3);
        });

        it('P2-A E: superseded lookup answers cannot navigate or reinstall Grid', async () => {
          const { env, picker } = gridRollover();
          await todayThenPick(env, picker, '06');
          env.click('calendar-view-link-list');
          await flush();
          env.toggle('status', 'planned');
          await flush();
          // Both older lookups answer with the server year after the newer edits.
          env.requests[1].respond();
          env.requests[2].respond();
          env.requests[0].respond();
          await flush();
          expect(env.requests).toHaveLength(4);
          expect(env.installed().month).toBe('2026-11');
          expect(env.installed().checked('view')).toEqual(['list']);
          expect(env.installed().checked('status')).toEqual(['planned']);
          expect(env.windowObject.history.pushes).toEqual([]);
          await expectJuneListPlanned(env, 3);
        });

        // P2-B: the real Calendar defaults controller over the real live
        // engine; only the defaults endpoint and the installed authority are
        // injected. Every POST is recorded and answered as the route does.
        function withDefaults(env, { hold = false, authority: overrides = {} } = {}) {
          const posts = [];
          const statuses = [];
          let operations = 0;
          const answer = (url, body) => {
            const expected = Number(body.get('defaultsGeneration'));
            const reset = String(url).endsWith('/reset');
            const operation = {
              id: body.get('defaultsOperation'),
              kind: reset ? 'resetDefaults' : 'save',
              result: 'committed',
              committed: true,
              expectedGeneration: expected,
              generation: expected + 1,
            };
            if (!reset) {
              const values = Object.fromEntries(['view', 'status', 'weekStart'].map((field) => [field, body.get(field)]));
              return { ok: true, status: 200, json: async () => ({ status: 'success', values, operation }) };
            }
            // As the route's refreshUrl: a valid month, Projects and Types of returnTo.
            const from = new URL(body.get('returnTo'), ORIGIN);
            const refresh = new URLSearchParams();
            if (/^\d{4}-(0[1-9]|1[0-2])$/.test(from.searchParams.get('month') || '')) refresh.set('month', from.searchParams.get('month'));
            ['project', 'type'].forEach((key) => from.searchParams.getAll(key).forEach((value) => refresh.append(key, value)));
            const refreshUrl = refresh.toString() ? `/calendar?${refresh}` : '/calendar';
            return { ok: true, status: 200, json: async () => ({ status: 'success', refreshUrl, operation }) };
          };
          const reads = [];
          const fetch = vi.fn((url, options) => new Promise((resolve, reject) => {
            // The best-effort saved-metadata GET after a commit: unanswered
            // here (its failure never changes a confirmed outcome).
            if (options?.method !== 'POST') {
              reads.push(String(url));
              reject(new Error('metadata unavailable'));
              return;
            }
            const post = { url: String(url), body: options.body, method: options.method, respond: () => resolve(answer(url, options.body)) };
            posts.push(post);
            if (!hold) post.respond();
          }));
          const authority = {
            page: 'calendar',
            fields: ['view', 'status', 'weekStart'],
            multiFields: [],
            fallbacks: { view: 'grid', status: 'all', weekStart: 'monday' },
            defaults: { view: 'grid', status: 'all', weekStart: 'monday' },
            saved: Object.fromEntries(['view', 'status', 'weekStart'].map((field) => [field, { stored: false, valid: false }])),
            savedKeys: [],
            hasSavedDefaults: false,
            generation: 0,
            revision: 'r1',
            resetFiltersUrl: '/calendar?month=2026-11',
            month: '2026-11',
            current: { view: 'grid', status: 'all', weekStart: 'sunday' },
            currentUrl: NOVEMBER_GRID.slice(ORIGIN.length),
            ...overrides,
          };
          const controller = createCalendarFiltersDefaults(env.document, {
            fetch,
            // As each installed response renders it: currentUrl is the installed location.
            readAuthority: () => {
              const installed = new URL(env.windowObject.location.href);
              return { ...authority, month: env.installed().month, currentUrl: `${installed.pathname}${installed.search}` };
            },
            csrfToken: () => 'token-1',
            createOperationId: () => `op-${operations += 1}`,
            onStatus: (message, kind) => statuses.push({ message, kind }),
          });
          return { controller, posts, statuses, fetch };
        }

        it('P2-B F: a failed release-adopted lookup is reported as the failed, intended Calendar', async () => {
          const { env, picker } = gridRollover();
          const feedback = withEditFeedback(env);
          await adoptedFailure(env, picker, feedback);
          const snapshot = calendarLiveSnapshot(env.document);
          expect(snapshot).toMatchObject({ pending: false, failed: true });
          const failed = new URL(snapshot.failedUrl);
          expect(monthless(failed)).toBe(true);
          expect(filtersOf(failed)).toEqual(GRID_FILTERS);
          expect(snapshot.intendedUrl).toBe(snapshot.failedUrl);
          // A newer explicit navigation ends that recovery.
          env.click('calendar-previous');
          await flush();
          expect(calendarLiveSnapshot(env.document)).toMatchObject({ pending: true, failed: false });
          expect(all(new URL(calendarLiveSnapshot(env.document).intendedUrl), 'month')).toEqual(['2026-10']);
        });

        it('P2-B G/J: Save is refused while the failed June intent owns Calendar; Retry refresh resolves June, then Save posts once', async () => {
          const { env, picker } = gridRollover();
          const feedback = withEditFeedback(env);
          const defaults = withDefaults(env);
          await adoptedFailure(env, picker, feedback);
          const result = await defaults.controller.save();
          expect(result).toMatchObject({ outcome: 'blocked', reason: CALENDAR_DEFAULTS_MESSAGES.loadFailed });
          expect(defaults.posts).toHaveLength(0);
          await flush();
          // Nothing refreshed November; June is still the recoverable choice.
          expect(env.requests).toHaveLength(2);
          picker.open();
          expect(shows(picker)).toEqual({ year: '2026', months: ['06'] });
          expect(calendarLiveSnapshot(env.document).failed).toBe(true);

          feedback.retry().dispatch('click');
          await flush();
          await serverYear(env, 2);
          expect(all(env.requests[3].url, 'month')).toEqual(['2027-06']);
          env.requests[3].respond();
          await flush();
          expect(env.installed().month).toBe('2027-06');
          expect(calendarLiveSnapshot(env.document).failed).toBe(false);

          const saved = defaults.controller.save();
          await flush();
          expect(defaults.posts).toHaveLength(1);
          expect(defaults.posts[0].url).toBe('/calendar/defaults');
          expect(all(new URL(defaults.posts[0].body.get('returnTo'), ORIGIN), 'month')).toEqual(['2027-06']);
          env.requests.at(-1).respond();
          await flush();
          expect((await saved).outcome).toBe('refreshing');
          expect(all(env.requests.at(-1).url, 'month')).toEqual(['2027-06']);
          expect(env.installed().month).toBe('2027-06');
          expect(defaults.controller.operation).toBeNull();
          expect(defaults.posts).toHaveLength(1);
          expect(onlyGets(env.windowObject)).toBe(true);
        });

        it('P2-B H/J: Reset defaults during the failed June intent posts once and installs June through a fresh lookup', async () => {
          const { env, picker } = gridRollover();
          const feedback = withEditFeedback(env);
          const defaults = withDefaults(env);
          await adoptedFailure(env, picker, feedback);
          const outcome = await defaults.controller.resetDefaults();
          expect(outcome.outcome).toBe('refreshing');
          expect(defaults.posts).toHaveLength(1);
          expect(defaults.posts[0].url).toBe('/calendar/defaults/reset');
          const returnTo = new URL(defaults.posts[0].body.get('returnTo'), ORIGIN);
          expect(monthless(returnTo)).toBe(true);
          expect(filtersOf(returnTo)).toEqual(GRID_FILTERS);
          await flush();
          // A fresh read-only server-year lookup, never November.
          expect(env.requests).toHaveLength(3);
          await serverYear(env, 2);
          const june = env.requests[3].url;
          // Reset defaults semantics: the month and temporary Projects / Types;
          // View, status and week start resolve from the (reset) defaults.
          expect([...june.searchParams.entries()]).toEqual([
            ['month', '2027-06'], ['project', '1'], ['project', '2'], ['type', 'comic'], ['type', 'images'],
          ]);
          env.requests[3].respond();
          await flush();
          expect(env.installed().month).toBe('2027-06');
          expect(env.installed().checked('project')).toEqual(['1', '2']);
          expect(env.installed().checked('type')).toEqual(['comic', 'images']);
          expect(defaults.controller.operation).toBeNull();
          expect(defaults.statuses.at(-1)).toEqual({ message: CALENDAR_DEFAULTS_MESSAGES.defaultsReset, kind: 'saved' });
          // The picked month's one push; no confirmed POST replayed.
          expect(env.windowObject.history.pushes).toHaveLength(1);
          expect(new URL(env.windowObject.history.pushes[0], ORIGIN).searchParams.get('month')).toBe('2027-06');
          expect(env.windowObject.history.replaces).toEqual([]);
          expect(defaults.posts).toHaveLength(1);
          expect(onlyGets(env.windowObject)).toBe(true);
          expect(env.requests.filter(({ url }) => all(url, 'month').includes('2026-11') && keys(url).length > 1)).toHaveLength(0);
        });

        it('P2-B I: a newer explicit month supersedes the failed recovery: Save then uses it', async () => {
          const { env, picker } = gridRollover();
          const feedback = withEditFeedback(env);
          const defaults = withDefaults(env);
          await adoptedFailure(env, picker, feedback);
          env.click('calendar-previous');
          await flush();
          env.requests.at(-1).respond();
          await flush();
          expect(env.installed().month).toBe('2026-10');
          const saved = defaults.controller.save();
          await flush();
          expect(defaults.posts).toHaveLength(1);
          expect(all(new URL(defaults.posts[0].body.get('returnTo'), ORIGIN), 'month')).toEqual(['2026-10']);
          env.requests.at(-1).respond();
          await flush();
          expect((await saved).outcome).toBe('refreshing');
          expect(env.installed().month).toBe('2026-10');
          expect(env.requests.some(({ url }) => all(url, 'month').includes('2027-06'))).toBe(false);
        });

        it('P2-B I: a newer explicit month during a held Reset POST or its June refresh wins', async () => {
          let { env, picker } = gridRollover();
          let feedback = withEditFeedback(env);
          let defaults = withDefaults(env, { hold: true });
          await adoptedFailure(env, picker, feedback);
          const reset = defaults.controller.resetDefaults();
          await flush();
          expect(defaults.posts).toHaveLength(1);
          env.click('calendar-previous');
          await flush();
          const october = env.requests.at(-1);
          expect(all(october.url, 'month')).toEqual(['2026-10']);
          defaults.posts[0].respond();
          expect((await reset).outcome).toBe('refreshing');
          await flush();
          // The confirmed reset refreshes the newer October intent, not June.
          const refresh = env.requests.at(-1);
          expect(all(refresh.url, 'month')).toEqual(['2026-10']);
          october.respond();
          refresh.respond();
          await flush();
          expect(env.installed().month).toBe('2026-10');
          expect(env.requests.some(({ url }) => all(url, 'month').includes('2027-06'))).toBe(false);
          expect(defaults.posts).toHaveLength(1);

          // The Reset's June refresh (its fresh lookup) is superseded too.
          ({ env, picker } = gridRollover());
          feedback = withEditFeedback(env);
          defaults = withDefaults(env);
          await adoptedFailure(env, picker, feedback);
          await defaults.controller.resetDefaults();
          await flush();
          expect(env.requests).toHaveLength(3);
          const lookup = env.requests[2];
          env.click('calendar-previous');
          await flush();
          expect(lookup.options.signal.aborted).toBe(true);
          lookup.respond();
          await flush();
          const previous = env.requests.at(-1);
          expect(all(previous.url, 'month')).toEqual(['2026-10']);
          previous.respond();
          await flush();
          expect(env.installed().month).toBe('2026-10');
          expect(env.requests.some(({ url }) => all(url, 'month').includes('2027-06'))).toBe(false);
          expect(defaults.posts).toHaveLength(1);
          expect(defaults.controller.operation).toBeNull();
        });
        // P2-B post-Reset presentation authority. Saved defaults pick Sunday;
        // the confirmed Reset deletes them (SAVED = null as the route does), so
        // every later Calendar resolves Grid / All / Monday. A filter edit after
        // the Reset changes only its own dimension and never re-serializes the
        // obsolete Sunday (or Grid) the form still showed before the Reset.
        const SUNDAY_SAVED = { view: 'grid', status: 'all', weekStart: 'sunday' };
        const SAVED_AUTHORITY = {
          defaults: SUNDAY_SAVED,
          saved: {
            view: { stored: true, valid: true }, status: { stored: true, valid: true }, weekStart: { stored: true, valid: true },
          },
          savedKeys: ['view', 'status', 'weekStart'],
          hasSavedDefaults: true,
        };
        const POST_RESET_PLANNED = [
          ['project', '1'], ['project', '2'], ['type', 'comic'], ['type', 'images'], ['status', 'planned'],
        ];
        const withoutMonth = (url) => [...url.searchParams.entries()].filter(([key]) => key !== 'month');
        function sundayRollover() {
          SAVED = SUNDAY_SAVED;
          return gridRollover();
        }
        // Confirmed Reset defaults: one POST; the server deletes the saved row.
        async function confirmedReset(env, defaults) {
          SAVED = null;
          env.postResetFrom = env.requests.length;
          const outcome = await defaults.controller.resetDefaults();
          expect(outcome.outcome).toBe('refreshing');
          await flush();
          expect(defaults.posts).toHaveLength(1);
          expect(defaults.posts[0].url).toBe('/calendar/defaults/reset');
        }
        // June 2027 installed with Planned, the Monday / Grid fallbacks and the
        // temporary filters; one push, the Reset POST never replayed.
        function expectJunePlannedFallback(env, defaults, juneRequest) {
          expect(all(juneRequest.url, 'month')).toEqual(['2027-06']);
          expect(withoutMonth(juneRequest.url)).toEqual(POST_RESET_PLANNED);
          juneRequest.respond();
          return flush().then(() => {
            const result = env.installed();
            expect(result.month).toBe('2027-06');
            expect(result.checked('status')).toEqual(['planned']);
            expect(result.checked('weekStart')).toEqual(['monday']);
            expect(env.region().getAttribute('data-calendar-week-start')).toBe('monday');
            expect(result.checked('view')).toEqual(['grid']);
            expect(result.checked('project')).toEqual(['1', '2']);
            expect(result.checked('type')).toEqual(['comic', 'images']);
            expect(env.windowObject.history.pushes).toHaveLength(1);
            const pushed = new URL(env.windowObject.history.pushes[0], ORIGIN);
            expect(pushed.searchParams.get('month')).toBe('2027-06');
            expect(pushed.searchParams.get('status')).toBe('planned');
            expect(pushed.searchParams.has('weekStart')).toBe(false);
            expect(env.windowObject.history.replaces).toEqual([]);
            expect(defaults.posts).toHaveLength(1);
            expect(onlyGets(env.windowObject)).toBe(true);
            // No request after the confirmed Reset carries the removed Sunday.
            expect(env.requests.slice(env.postResetFrom).some(({ url }) => all(url, 'weekStart').length > 0)).toBe(false);
          });
        }

        it('P2-B RESET A–E/J: pending June → confirmed Reset defaults → Planned keeps June and Planned without the removed Sunday', async () => {
          const { env, picker } = sundayRollover();
          const defaults = withDefaults(env, { authority: SAVED_AUTHORITY });
          await todayThenPick(env, picker, '06');
          expect(env.requests).toHaveLength(2);
          const lookup = env.requests[1];
          expect(env.installed().checked('weekStart')).toEqual(['sunday']);
          await confirmedReset(env, defaults);
          // The Reset refresh adopted the held lookup: nothing new requested.
          expect(env.requests).toHaveLength(2);
          expect(lookup.options.signal.aborted).toBe(false);
          const intended = new URL(calendarLiveSnapshot(env.document).intendedUrl);
          expect(monthless(intended)).toBe(true);
          expect([...intended.searchParams.entries()]).toEqual(POST_RESET_PLANNED.slice(0, 4));
          env.toggle('status', 'planned');
          await flush();
          expect(lookup.options.signal.aborted).toBe(true);
          expect(env.requests).toHaveLength(3);
          const after = new URL(calendarLiveSnapshot(env.document).intendedUrl);
          expect(monthless(after)).toBe(true);
          expect([...after.searchParams.entries()]).toEqual(POST_RESET_PLANNED);
          await serverYear(env, 2);
          await expectJunePlannedFallback(env, defaults, env.requests[3]);
        });

        it('P2-B RESET F: failed release-adopted June → confirmed Reset defaults → Planned keeps June without the removed Sunday', async () => {
          const { env, picker } = sundayRollover();
          const feedback = withEditFeedback(env);
          const defaults = withDefaults(env, { authority: SAVED_AUTHORITY });
          await adoptedFailure(env, picker, feedback);
          await confirmedReset(env, defaults);
          // A fresh lookup under the Reset destination, held.
          expect(env.requests).toHaveLength(3);
          const lookup = env.requests[2];
          env.toggle('status', 'planned');
          await flush();
          expect(lookup.options.signal.aborted).toBe(true);
          expect(env.requests).toHaveLength(4);
          expect([...new URL(calendarLiveSnapshot(env.document).intendedUrl).searchParams.entries()]).toEqual(POST_RESET_PLANNED);
          await serverYear(env, 3);
          await expectJunePlannedFallback(env, defaults, env.requests[4]);
        });

        it('P2-B RESET G: a toolbar View edit after Reset, before or after Planned, never restores the removed Sunday', async () => {
          for (const order of [['list', 'planned'], ['planned', 'list']]) {
            const { env, picker } = sundayRollover();
            const defaults = withDefaults(env, { authority: SAVED_AUTHORITY });
            await todayThenPick(env, picker, '06');
            await confirmedReset(env, defaults);
            for (const step of order) {
              if (step === 'list') env.click('calendar-view-link-list');
              else env.toggle('status', 'planned');
              await flush();
            }
            expect(env.requests).toHaveLength(4);
            await serverYear(env, 3);
            const june = env.requests[4].url;
            expect(all(june, 'month')).toEqual(['2027-06']);
            expect(all(june, 'weekStart')).toEqual([]);
            expect(all(june, 'view')).toEqual(['list']);
            expect(all(june, 'status')).toEqual(['planned']);
            expect(all(june, 'project')).toEqual(['1', '2']);
            expect(all(june, 'type')).toEqual(['comic', 'images']);
            env.requests[4].respond();
            await flush();
            expect(env.installed().checked('weekStart')).toEqual(['monday']);
            expect(env.installed().checked('view')).toEqual(['list']);
            expect(env.windowObject.history.pushes).toHaveLength(1);
            expect(defaults.posts).toHaveLength(1);
          }
        });

        it('P2-B RESET H: superseded lookup and Today answers cannot reinstall or re-request the removed Sunday', async () => {
          const { env, picker } = sundayRollover();
          const defaults = withDefaults(env, { authority: SAVED_AUTHORITY });
          await todayThenPick(env, picker, '06');
          await confirmedReset(env, defaults);
          env.toggle('status', 'planned');
          await flush();
          env.requests[1].respond();
          env.requests[0].respond();
          await flush();
          expect(env.requests).toHaveLength(3);
          expect(env.installed().month).toBe('2026-11');
          expect(env.windowObject.history.pushes).toEqual([]);
          await serverYear(env, 2);
          await expectJunePlannedFallback(env, defaults, env.requests[3]);
        });

        it('P2-B RESET B (concurrency): Planned after the post-Reset year resolves, while June GET is held, keeps the Reset authority', async () => {
          const { env, picker } = sundayRollover();
          const defaults = withDefaults(env, { authority: SAVED_AUTHORITY });
          await todayThenPick(env, picker, '06');
          await confirmedReset(env, defaults);
          await serverYear(env, 1);
          expect(env.requests).toHaveLength(3);
          const heldJune = env.requests[2];
          expect(withoutMonth(heldJune.url)).toEqual(POST_RESET_PLANNED.slice(0, 4));
          env.toggle('status', 'planned');
          await flush();
          expect(heldJune.options.signal.aborted).toBe(true);
          expect(env.requests).toHaveLength(4);
          heldJune.respond();
          await flush();
          expect(env.installed().month).toBe('2026-11');
          await expectJunePlannedFallback(env, defaults, env.requests[3]);
        });

        it('P2-B RESET I: a newer explicit month after Reset and Planned wins without the removed Sunday', async () => {
          const { env, picker } = sundayRollover();
          const defaults = withDefaults(env, { authority: SAVED_AUTHORITY });
          await todayThenPick(env, picker, '06');
          await confirmedReset(env, defaults);
          env.toggle('status', 'planned');
          await flush();
          const lookup = env.requests[2];
          env.click('calendar-previous');
          await flush();
          expect(lookup.options.signal.aborted).toBe(true);
          const october = env.requests.at(-1);
          expect(all(october.url, 'month')).toEqual(['2026-10']);
          expect(withoutMonth(october.url)).toEqual(POST_RESET_PLANNED);
          lookup.respond();
          await flush();
          october.respond();
          await flush();
          expect(env.installed().month).toBe('2026-10');
          expect(env.installed().checked('weekStart')).toEqual(['monday']);
          expect(env.installed().checked('status')).toEqual(['planned']);
          expect(env.requests.some(({ url }) => all(url, 'month').includes('2027-06'))).toBe(false);
          expect(defaults.posts).toHaveLength(1);
        });
        // P2-C: the server year resolved, then the explicit June GET the
        // release refresh owned failed. That complete explicit address and
        // its push stay the Calendar's recoverable intent.
        describe('P2-C failed resolved explicit month GET keeps recovery authority', () => {
          const STALE_EDIT = 'Release saved, but Calendar could not refresh. The calendar shown may be out of date.';
          const JUNE_GRID = [
            ['month', '2027-06'], ['project', '1'], ['project', '2'], ['type', 'comic'], ['type', 'images'],
            ['status', 'all'], ['view', 'grid'], ['weekStart', 'sunday'],
          ];
          const sorted = (url) => [...url.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
          const sameEntries = (url, entries) => expect(sorted(url)).toEqual([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

          // Today → June → saved Edit adopts the lookup → year 2027 → the
          // explicit June 2027 GET (requests[2]) answers HTTP 503.
          async function resolvedJuneFailure(env, picker, feedback) {
            await todayThenPick(env, picker, '06');
            env.document.dispatch('release-edit-saved', { detail: { releaseId: '801' } });
            await flush();
            expect(env.requests).toHaveLength(2);
            await serverYear(env, 1);
            expect(env.requests).toHaveLength(3);
            sameEntries(env.requests[2].url, JUNE_GRID);
            failWith503(env.requests[2]);
            await flush();
            expect(feedback.text()).toBe(STALE_EDIT);
            expect(feedback.retry()).not.toBeNull();
          }

          it('A–D: the failed explicit June is the failed, intended Calendar with its push; November stays installed', async () => {
            const { env, picker } = gridRollover();
            const feedback = withEditFeedback(env);
            await resolvedJuneFailure(env, picker, feedback);
            expect(env.installed().month).toBe('2026-11');
            expect(env.windowObject.history.pushes).toEqual([]);
            expect(env.windowObject.history.replaces).toEqual([]);
            const snapshot = calendarLiveSnapshot(env.document);
            expect(snapshot).toMatchObject({ pending: false, failed: true, requestedHistoryMode: 'push' });
            sameEntries(new URL(snapshot.failedUrl), JUNE_GRID);
            expect(snapshot.intendedUrl).toBe(snapshot.failedUrl);
            // The picker shows the failed explicit month, not November.
            picker.open();
            expect(shows(picker)).toEqual({ year: '2027', months: ['06'] });
            // No engine notice duplicates the release-owned Retry.
            expect(liveFailureNotice(env.document)).toBeNull();
          });

          it('E/L: Retry refresh repeats only the explicit June GET (no lookup), once however often clicked; one June push', async () => {
            const { env, picker } = gridRollover();
            const feedback = withEditFeedback(env);
            await resolvedJuneFailure(env, picker, feedback);
            const retry = feedback.retry();
            retry.dispatch('click');
            retry.dispatch('click');
            await flush();
            expect(env.requests).toHaveLength(4);
            sameEntries(env.requests[3].url, JUNE_GRID);
            expect(calendarLiveSnapshot(env.document)).toMatchObject({ pending: true, failed: false });
            env.requests[3].respond();
            await flush();
            const result = env.installed();
            expect(result.month).toBe('2027-06');
            expect(result.checked('project')).toEqual(['1', '2']);
            expect(result.checked('type')).toEqual(['comic', 'images']);
            expect(result.checked('view')).toEqual(['grid']);
            expect(result.checked('weekStart')).toEqual(['sunday']);
            sameEntries(new URL(result.location), JUNE_GRID);
            expect(env.windowObject.history.pushes).toHaveLength(1);
            sameEntries(new URL(env.windowObject.history.pushes[0], ORIGIN), JUNE_GRID);
            expect(env.windowObject.history.replaces).toEqual([]);
            expect(feedback.text()).toBe('Release updated.');
            expect(feedback.retry()).toBeNull();
            expect(calendarLiveSnapshot(env.document)).toMatchObject({ pending: false, failed: false });
            expect(onlyGets(env.windowObject)).toBe(true);
            expect(env.windowObject.fetch).toHaveBeenCalledTimes(4);
            expect(env.requests.some(({ url }) => all(url, 'month').includes('2026-11') && keys(url).length > 1)).toBe(false);
          });

          it('E: a second failure of the Retry keeps June and its push for the next Retry', async () => {
            const { env, picker } = gridRollover();
            const feedback = withEditFeedback(env);
            await resolvedJuneFailure(env, picker, feedback);
            feedback.retry().dispatch('click');
            await flush();
            env.requests[3].fail();
            await flush();
            expect(feedback.text()).toBe(STALE_EDIT);
            const snapshot = calendarLiveSnapshot(env.document);
            expect(snapshot.failed).toBe(true);
            sameEntries(new URL(snapshot.failedUrl), JUNE_GRID);
            feedback.retry().dispatch('click');
            await flush();
            expect(env.requests).toHaveLength(5);
            sameEntries(env.requests[4].url, JUNE_GRID);
            env.requests[4].respond();
            await flush();
            expect(env.installed().month).toBe('2027-06');
            expect(env.windowObject.history.pushes).toHaveLength(1);
            expect(env.windowObject.history.replaces).toEqual([]);
          });

          it('F/G: Save is refused while the failed June owns Calendar; after Retry installs June, Save posts once', async () => {
            const { env, picker } = gridRollover();
            const feedback = withEditFeedback(env);
            const defaults = withDefaults(env);
            await resolvedJuneFailure(env, picker, feedback);
            const result = await defaults.controller.save();
            expect(result).toMatchObject({ outcome: 'blocked', reason: CALENDAR_DEFAULTS_MESSAGES.loadFailed });
            expect(defaults.posts).toHaveLength(0);
            await flush();
            expect(env.requests).toHaveLength(3);
            expect(calendarLiveSnapshot(env.document).failed).toBe(true);
            expect(feedback.retry()).not.toBeNull();

            feedback.retry().dispatch('click');
            await flush();
            sameEntries(env.requests[3].url, JUNE_GRID);
            env.requests[3].respond();
            await flush();
            expect(env.installed().month).toBe('2027-06');

            const saved = defaults.controller.save();
            await flush();
            expect(defaults.posts).toHaveLength(1);
            expect(defaults.posts[0].url).toBe('/calendar/defaults');
            expect(all(new URL(defaults.posts[0].body.get('returnTo'), ORIGIN), 'month')).toEqual(['2027-06']);
            env.requests.at(-1).respond();
            await flush();
            expect((await saved).outcome).toBe('refreshing');
            expect(all(env.requests.at(-1).url, 'month')).toEqual(['2027-06']);
            expect(env.installed().month).toBe('2027-06');
            expect(defaults.posts).toHaveLength(1);
            expect(env.windowObject.history.pushes).toHaveLength(1);
            expect(onlyGets(env.windowObject)).toBe(true);
          });

          it('H: Next after the failure composes December with June\'s filters; the old Retry is inert; Save follows December', async () => {
            const { env, picker } = gridRollover();
            const feedback = withEditFeedback(env);
            const defaults = withDefaults(env);
            await resolvedJuneFailure(env, picker, feedback);
            const oldRetry = feedback.retry();
            env.click('calendar-next');
            await flush();
            expect(env.requests).toHaveLength(4);
            const december = env.requests[3];
            expect(all(december.url, 'month')).toEqual(['2026-12']);
            expect(filtersOf(december.url)).toEqual(GRID_FILTERS);
            expect(calendarLiveSnapshot(env.document)).toMatchObject({ pending: true, failed: false });
            oldRetry.dispatch('click');
            await flush();
            expect(env.requests).toHaveLength(4);
            expect(december.options.signal.aborted).toBe(false);
            december.respond();
            await flush();
            expect(env.installed().month).toBe('2026-12');
            expect(env.windowObject.history.pushes).toHaveLength(1);
            expect(all(new URL(env.windowObject.history.pushes[0], ORIGIN), 'month')).toEqual(['2026-12']);
            expect(calendarLiveSnapshot(env.document).failed).toBe(false);

            const saved = defaults.controller.save();
            await flush();
            expect(defaults.posts).toHaveLength(1);
            expect(all(new URL(defaults.posts[0].body.get('returnTo'), ORIGIN), 'month')).toEqual(['2026-12']);
            env.requests.at(-1).respond();
            await flush();
            expect((await saved).outcome).toBe('refreshing');
            expect(env.requests.filter(({ url }) => all(url, 'month').includes('2027-06'))).toHaveLength(1);
          });

          it('H: another picked month or the displayed month replaces the failed June', async () => {
            let { env, picker } = gridRollover();
            let feedback = withEditFeedback(env);
            await resolvedJuneFailure(env, picker, feedback);
            // The failed explicit June owns the picker; a typed-free August is explicit.
            picker.open();
            choose(picker, '08');
            await flush();
            expect(env.requests).toHaveLength(4);
            expect(all(env.requests[3].url, 'month')).toEqual(['2027-08']);
            expect(filtersOf(env.requests[3].url)).toEqual(GRID_FILTERS);

            ({ env, picker } = gridRollover());
            feedback = withEditFeedback(env);
            await resolvedJuneFailure(env, picker, feedback);
            // R2: the displayed month is a real choice while June is failed.
            picker.open();
            picker.year.value = '2026';
            picker.year.dispatch('input');
            choose(picker, '11');
            await flush();
            expect(env.requests).toHaveLength(4);
            expect(all(env.requests[3].url, 'month')).toEqual(['2026-11']);
            expect(calendarLiveSnapshot(env.document).failed).toBe(false);
          });

          it('I: a Status edit or toolbar List after the failure keeps June and every other dimension', async () => {
            let { env, picker } = gridRollover();
            let feedback = withEditFeedback(env);
            await resolvedJuneFailure(env, picker, feedback);
            env.toggle('status', 'planned');
            await flush();
            expect(env.requests).toHaveLength(4);
            expect(all(env.requests[3].url, 'month')).toEqual(['2027-06']);
            expect(filtersOf(env.requests[3].url)).toEqual({ ...GRID_FILTERS, status: ['planned'] });
            expect(calendarLiveSnapshot(env.document).failed).toBe(false);
            feedback.retry()?.dispatch('click');
            await flush();
            expect(env.requests).toHaveLength(4);
            env.requests[3].respond();
            await flush();
            expect(env.installed().month).toBe('2027-06');
            expect(env.installed().checked('status')).toEqual(['planned']);
            expect(env.windowObject.history.pushes).toHaveLength(1);

            ({ env, picker } = gridRollover());
            feedback = withEditFeedback(env);
            await resolvedJuneFailure(env, picker, feedback);
            env.click('calendar-view-link-list');
            await flush();
            expect(env.requests).toHaveLength(4);
            expect(all(env.requests[3].url, 'month')).toEqual(['2027-06']);
            expect(filtersOf(env.requests[3].url)).toEqual({ ...GRID_FILTERS, view: ['list'] });
          });

          it('J: a newer release refresh while June is current retries June; after supersession it never resurrects June', async () => {
            let { env, picker } = gridRollover();
            let feedback = withEditFeedback(env);
            await resolvedJuneFailure(env, picker, feedback);
            env.document.dispatch('release-edit-saved', { detail: { releaseId: '802' } });
            await flush();
            expect(env.requests).toHaveLength(4);
            sameEntries(env.requests[3].url, JUNE_GRID);
            env.requests[3].respond();
            await flush();
            expect(env.installed().month).toBe('2027-06');
            expect(env.windowObject.history.pushes).toHaveLength(1);
            expect(onlyGets(env.windowObject)).toBe(true);

            ({ env, picker } = gridRollover());
            feedback = withEditFeedback(env);
            await resolvedJuneFailure(env, picker, feedback);
            env.click('calendar-previous');
            await flush();
            env.requests[3].respond();
            await flush();
            expect(env.installed().month).toBe('2026-10');
            env.document.dispatch('release-edit-saved', { detail: { releaseId: '802' } });
            await flush();
            expect(env.requests).toHaveLength(5);
            expect(all(env.requests[4].url, 'month')).toEqual(['2026-10']);
            env.requests[4].respond();
            await flush();
            expect(env.installed().month).toBe('2026-10');
            expect(env.requests.filter(({ url }) => all(url, 'month').includes('2027-06'))).toHaveLength(1);
          });

          it('K: Reset defaults during the failed June posts once and installs June (month, Projects, Types) with the owed push', async () => {
            const { env, picker } = gridRollover();
            const feedback = withEditFeedback(env);
            const defaults = withDefaults(env);
            await resolvedJuneFailure(env, picker, feedback);
            const outcome = await defaults.controller.resetDefaults();
            expect(outcome.outcome).toBe('refreshing');
            expect(defaults.posts).toHaveLength(1);
            expect(defaults.posts[0].url).toBe('/calendar/defaults/reset');
            sameEntries(new URL(defaults.posts[0].body.get('returnTo'), ORIGIN), JUNE_GRID);
            await flush();
            // No lookup: the server year is already known.
            expect(env.requests).toHaveLength(4);
            expect([...env.requests[3].url.searchParams.entries()]).toEqual([
              ['month', '2027-06'], ['project', '1'], ['project', '2'], ['type', 'comic'], ['type', 'images'],
            ]);
            env.requests[3].respond();
            await flush();
            expect(env.installed().month).toBe('2027-06');
            expect(env.installed().checked('project')).toEqual(['1', '2']);
            expect(env.installed().checked('type')).toEqual(['comic', 'images']);
            expect(defaults.controller.operation).toBeNull();
            expect(defaults.statuses.at(-1)).toEqual({ message: CALENDAR_DEFAULTS_MESSAGES.defaultsReset, kind: 'saved' });
            expect(env.windowObject.history.pushes).toHaveLength(1);
            expect(all(new URL(env.windowObject.history.pushes[0], ORIGIN), 'month')).toEqual(['2027-06']);
            expect(env.windowObject.history.replaces).toEqual([]);
            expect(defaults.posts).toHaveLength(1);
            expect(onlyGets(env.windowObject)).toBe(true);
            expect(env.requests.filter(({ url }) => all(url, 'month').includes('2026-11') && keys(url).length > 1)).toHaveLength(0);
          });

          it('C-F2: a failed refresh of the idle installed address is not a newer intent: failed stays false', async () => {
            const { env } = gridRollover();
            const feedback = withEditFeedback(env);
            env.document.dispatch('release-edit-saved', { detail: { releaseId: '801' } });
            await flush();
            expect(env.requests).toHaveLength(1);
            expect(all(env.requests[0].url, 'month')).toEqual(['2026-11']);
            failWith503(env.requests[0]);
            await flush();
            expect(feedback.text()).toBe(STALE_EDIT);
            expect(calendarLiveSnapshot(env.document)).toMatchObject({ pending: false, failed: false });
            feedback.retry().dispatch('click');
            await flush();
            expect(env.requests).toHaveLength(2);
            expect(env.requests[1].url.href).toBe(env.requests[0].url.href);
          });
        });
      });
    });
  });

  /*
   * Cumulative P2-B: a Reset defaults refresh that adopts the destination of a
   * failed (or pending) month navigation commits that navigation's outstanding
   * push exactly once, so Back still reaches the filtered month it left. The
   * REAL Calendar engine and the REAL shared defaults controller run here;
   * only the defaults endpoint and the installed authority are injected.
   */
  describe('Cumulative P2-B Reset defaults keeps a failed navigation\'s history intent', () => {
    const JULY = `${ORIGIN}/calendar?month=2031-07&project=1&project=2&type=comic&type=images&status=planned&view=list&weekStart=sunday`;
    const AUGUST = `${ORIGIN}/calendar?month=2031-08&project=1&project=2&type=comic&type=images&status=planned&view=list&weekStart=sunday`;
    // The route's refreshUrl: month, Projects and Types of returnTo.
    const AUGUST_RESET = `${ORIGIN}/calendar?month=2031-08&project=1&project=2&type=comic&type=images`;
    const fail503 = (request) => request.respondWith({ ok: false, status: 503, url: request.url.href, text: async () => '' });
    const toAugust = (env) => env.requests.filter((request) => request.url.searchParams.get('month') === '2031-08');

    function resetDefaultsHarness(env, { hold = false } = {}) {
      const posts = [];
      let operations = 0;
      const answer = (body) => {
        const expected = Number(body.get('defaultsGeneration'));
        const from = new URL(body.get('returnTo'), ORIGIN);
        const refresh = new URLSearchParams();
        if (/^\d{4}-(0[1-9]|1[0-2])$/.test(from.searchParams.get('month') || '')) refresh.set('month', from.searchParams.get('month'));
        ['project', 'type'].forEach((key) => from.searchParams.getAll(key).forEach((value) => refresh.append(key, value)));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: 'success',
            refreshUrl: refresh.toString() ? `/calendar?${refresh}` : '/calendar',
            operation: {
              id: body.get('defaultsOperation'), kind: 'resetDefaults', result: 'committed', committed: true,
              expectedGeneration: expected, generation: expected + 1,
            },
          }),
        };
      };
      const fetch = vi.fn((url, options) => new Promise((resolve, reject) => {
        if (options?.method !== 'POST') { reject(new Error('metadata unavailable')); return; }
        const post = { url: String(url), body: options.body, respond: () => resolve(answer(options.body)) };
        posts.push(post);
        if (!hold) post.respond();
      }));
      let generation = 3;
      const controller = createCalendarFiltersDefaults(env.document, {
        fetch,
        readAuthority: () => {
          const installed = new URL(env.windowObject.location.href);
          return {
            page: 'calendar',
            fields: ['view', 'status', 'weekStart'],
            multiFields: [],
            fallbacks: { view: 'grid', status: 'all', weekStart: 'monday' },
            defaults: { view: 'list', status: 'planned', weekStart: 'sunday' },
            saved: Object.fromEntries(['view', 'status', 'weekStart'].map((field) => [field, { stored: true, valid: true }])),
            savedKeys: ['view', 'status', 'weekStart'],
            hasSavedDefaults: true,
            generation,
            revision: `r${generation}`,
            resetFiltersUrl: `/calendar?month=${env.installed().month}`,
            month: env.installed().month,
            current: { view: 'list', status: 'planned', weekStart: 'sunday' },
            currentUrl: `${installed.pathname}${installed.search}`,
          };
        },
        csrfToken: () => 'token-1',
        createOperationId: () => `op-${operations += 1}`,
      });
      return { controller, posts, fetch, setGeneration: (value) => { generation = value; } };
    }

    async function failedAugust(initialUrl = JULY) {
      const env = r2Environment(initialUrl);
      env.click('calendar-next');
      await flush();
      expect(env.requests).toHaveLength(1);
      fail503(env.requests[0]);
      await flush();
      return env;
    }

    it('A/D/L/M: a failed Next stays the intent; Reset defaults installs August with its one owed push', async () => {
      const env = await failedAugust();
      expect(env.requests[0].url.href).toBe(AUGUST);
      expect(env.installed().month).toBe('2031-07');
      expect(env.installed().ids).toEqual([101]);
      // D: the failed explicit August is the intent, paired with its push.
      expect(calendarLiveSnapshot(env.document)).toMatchObject({
        pending: false, failed: true, failedUrl: AUGUST, intendedUrl: AUGUST, outstandingHistoryMode: 'push',
      });
      expect(env.windowObject.history.pushes).toEqual([]);

      const defaults = resetDefaultsHarness(env);
      expect((await defaults.controller.resetDefaults()).outcome).toBe('refreshing');
      await flush();
      expect(defaults.posts).toHaveLength(1);
      expect(defaults.posts[0].url).toBe('/calendar/defaults/reset');
      expect(defaults.posts[0].body.get('returnTo')).toBe(AUGUST.slice(ORIGIN.length));
      expect(toAugust(env)).toHaveLength(2);
      expect(env.requests[1].url.href).toBe(AUGUST_RESET);
      env.requests[1].respond();
      await flush();

      // M: the owed push commits once at installation; nothing is replaced.
      expect(env.windowObject.history.pushes).toEqual([AUGUST_RESET]);
      expect(env.windowObject.history.replaces).toEqual([]);
      const result = env.installed();
      expect(result.location).toBe(AUGUST_RESET);
      expect(result.month).toBe('2031-08');
      expect(result.ids).toEqual([201, 202, 204]);
      // L: repeated Projects and Types survive; the fallbacks apply.
      expect(result.checked('project')).toEqual(['1', '2']);
      expect(result.checked('type')).toEqual(['comic', 'images']);
      expect(result.checked('status')).toEqual(['all']);
      expect(result.checked('view')).toEqual(['grid']);
      expect(result.checked('weekStart')).toEqual(['monday']);
      expect(defaults.controller.operation).toBeNull();
      expect(calendarLiveSnapshot(env.document)).toMatchObject({ pending: false, failed: false, outstandingHistoryMode: null });

      // M: consumed. A second Reset defaults of the installed August adds no entry.
      defaults.setGeneration(4);
      expect((await defaults.controller.resetDefaults()).outcome).toBe('refreshing');
      await flush();
      expect(defaults.posts).toHaveLength(2);
      env.requests.at(-1).respond();
      await flush();
      expect(env.windowObject.history.pushes).toEqual([AUGUST_RESET]);
      expect(env.installed().location).toBe(AUGUST_RESET);
      expect(onlyGets(env.windowObject)).toBe(true);
    });

    it('B: Reset defaults acknowledged while the Next GET is held keeps its push; the held response never installs', async () => {
      const env = r2Environment(JULY);
      env.click('calendar-next');
      await flush();
      expect(calendarLiveSnapshot(env.document)).toMatchObject({ pending: true, outstandingHistoryMode: 'push', intendedUrl: AUGUST });
      const defaults = resetDefaultsHarness(env);
      expect((await defaults.controller.resetDefaults()).outcome).toBe('refreshing');
      await flush();
      expect(defaults.posts).toHaveLength(1);
      expect(env.requests).toHaveLength(2);
      expect(env.requests[1].url.href).toBe(AUGUST_RESET);
      env.requests[1].respond();
      await flush();
      env.requests[0].respond();
      await flush();
      expect(env.windowObject.history.pushes).toEqual([AUGUST_RESET]);
      expect(env.windowObject.history.replaces).toEqual([]);
      expect(env.installed().ids).toEqual([201, 202, 204]);
      expect(env.installed().location).toBe(AUGUST_RESET);
      expect(defaults.posts).toHaveLength(1);
    });

    it('C/I: Reset defaults of an installed month (explicit or monthless) only replaces', async () => {
      const env = r2Environment(JULY);
      env.click('calendar-next');
      await flush();
      env.requests[0].respond();
      await flush();
      expect(env.windowObject.history.pushes).toEqual([AUGUST]);
      expect(calendarLiveSnapshot(env.document).outstandingHistoryMode).toBeNull();
      const defaults = resetDefaultsHarness(env);
      await defaults.controller.resetDefaults();
      await flush();
      env.requests[1].respond();
      await flush();
      expect(env.windowObject.history.pushes).toEqual([AUGUST]);
      expect(env.windowObject.history.replaces).toEqual([AUGUST_RESET]);
      expect(env.installed().ids).toEqual([201, 202, 204]);

      // I: a monthless installed Calendar keeps its displayed month, no push.
      const monthless = r2Environment(`${ORIGIN}/calendar?project=1&type=comic&status=planned&view=list&weekStart=sunday`);
      TODAY_MONTH = '2031-08';
      const later = resetDefaultsHarness(monthless);
      await later.controller.resetDefaults();
      await flush();
      expect(monthless.requests).toHaveLength(1);
      expect(monthless.requests[0].url.href).toBe(`${ORIGIN}/calendar?month=2031-07&project=1&type=comic`);
      monthless.requests[0].respond();
      await flush();
      expect(monthless.installed().month).toBe('2031-07');
      expect(monthless.installed().ids).toEqual([101]);
      expect(monthless.windowObject.history.pushes).toEqual([]);
      expect(monthless.windowObject.history.replaces).toEqual([`${ORIGIN}/calendar?month=2031-07&project=1&type=comic`]);
    });

    it('E/K: a failed Reset refresh and its GET-only Retry keep the original push; no POST replay', async () => {
      const env = await failedAugust();
      const defaults = resetDefaultsHarness(env);
      await defaults.controller.resetDefaults();
      await flush();
      fail503(env.requests[1]);
      await flush();
      expect(defaults.controller.operation).toMatchObject({ phase: 'refresh-failed' });
      expect(env.installed().month).toBe('2031-07');
      expect(calendarLiveSnapshot(env.document)).toMatchObject({
        failed: true, intendedUrl: AUGUST_RESET, outstandingHistoryMode: 'push',
      });
      expect(defaults.controller.retryRefresh()).toBe('refreshing');
      await flush();
      expect(toAugust(env)).toHaveLength(3);
      expect(env.requests[2].url.href).toBe(AUGUST_RESET);
      env.requests[2].respond();
      await flush();
      expect(defaults.posts).toHaveLength(1);
      expect(env.windowObject.history.pushes).toEqual([AUGUST_RESET]);
      expect(env.windowObject.history.replaces).toEqual([]);
      expect(env.installed().ids).toEqual([201, 202, 204]);
      expect(defaults.controller.operation).toBeNull();
      expect(liveFailureNotice(env.document)).toBeNull();
      expect(onlyGets(env.windowObject)).toBe(true);
    });

    it('E: the engine\'s own Retry of the failed Reset refresh commits the same single push', async () => {
      const env = await failedAugust();
      const defaults = resetDefaultsHarness(env);
      await defaults.controller.resetDefaults();
      await flush();
      fail503(env.requests[1]);
      await flush();
      liveFailureRetries(env.document)[0].dispatch('click');
      await flush();
      expect(toAugust(env)).toHaveLength(3);
      env.requests[2].respond();
      await flush();
      expect(env.windowObject.history.pushes).toEqual([AUGUST_RESET]);
      expect(defaults.posts).toHaveLength(1);
      expect(defaults.controller.operation).toBeNull();
    });

    it('F: a newer September pick during the held Reset POST wins; the old August push never applies', async () => {
      const env = await failedAugust();
      const picker = attachMonthPicker(env.document);
      enhanceCalendarLiveFiltering(env.document);
      const defaults = resetDefaultsHarness(env, { hold: true });
      const pending = defaults.controller.resetDefaults();
      await flush();
      picker.open();
      picker.year.value = '2031';
      picker.dropdown.querySelectorAll('input[type="radio"]').forEach((option) => { option.checked = false; });
      picker.months['09'].checked = true;
      picker.months['09'].dispatch('change');
      await flush();
      const september = env.requests[1].url;
      expect(september.searchParams.get('month')).toBe('2031-09');
      expect(all(september, 'project')).toEqual(['1', '2']);
      defaults.posts[0].respond();
      await pending;
      await flush();
      // The refresh takes over September (newer intent) with September's push.
      expect(env.requests).toHaveLength(3);
      expect(env.requests[2].url.searchParams.get('month')).toBe('2031-09');
      env.requests[1].respond();
      env.requests[2].respond();
      await flush();
      expect(env.installed().month).toBe('2031-09');
      expect(env.windowObject.history.pushes).toEqual([env.requests[2].url.href]);
      expect(env.windowObject.history.pushes.some((url) => url.includes('2031-08'))).toBe(false);
      expect(defaults.posts).toHaveLength(1);
    });

    it('G: a newer Project filter edit during the held Reset POST owns the August push', async () => {
      const env = await failedAugust();
      const defaults = resetDefaultsHarness(env, { hold: true });
      const pending = defaults.controller.resetDefaults();
      await flush();
      env.toggle('project', '3');
      await flush();
      const edited = env.requests[1].url;
      expect(edited.searchParams.get('month')).toBe('2031-08');
      expect(all(edited, 'project')).toEqual(['1', '2', '3']);
      defaults.posts[0].respond();
      await pending;
      await flush();
      env.requests.at(-1).respond();
      env.requests[1].respond();
      await flush();
      expect(env.windowObject.history.pushes).toHaveLength(1);
      const pushed = new URL(env.windowObject.history.pushes[0]);
      expect(pushed.searchParams.get('month')).toBe('2031-08');
      expect(all(pushed, 'project')).toEqual(['1', '2', '3']);
      expect(env.installed().location).toBe(pushed.href);
      expect(env.windowObject.history.replaces).toEqual([]);
      expect(defaults.posts).toHaveLength(1);
    });

    it('H: Back while the Reset POST is held restores July; the old August push is not reused', async () => {
      const env = await failedAugust();
      const defaults = resetDefaultsHarness(env, { hold: true });
      const pending = defaults.controller.resetDefaults();
      await flush();
      const EARLIER = `${ORIGIN}/calendar?month=2031-06&project=1&project=2&type=comic&type=images&status=planned&view=list&weekStart=sunday`;
      env.windowObject.setLocation(EARLIER);
      env.windowObject.dispatch('popstate');
      await flush();
      expect(calendarLiveSnapshot(env.document)).toMatchObject({ pending: true, outstandingHistoryMode: null });
      defaults.posts[0].respond();
      await pending;
      await flush();
      env.requests.slice(1).reverse().forEach((request) => request.respond());
      await flush();
      expect(env.installed().month).toBe('2031-06');
      expect(env.installed().location).toBe(EARLIER);
      expect(env.windowObject.history.pushes).toEqual([]);
      expect(defaults.posts).toHaveLength(1);
      expect(toAugust(env)).toHaveLength(1);
    });

    it('N: after a failed Reset refresh, a newer September navigation retires the old Retry and its push', async () => {
      const env = await failedAugust();
      const picker = attachMonthPicker(env.document);
      enhanceCalendarLiveFiltering(env.document);
      const defaults = resetDefaultsHarness(env);
      await defaults.controller.resetDefaults();
      await flush();
      fail503(env.requests[1]);
      await flush();
      picker.open();
      picker.year.value = '2031';
      picker.dropdown.querySelectorAll('input[type="radio"]').forEach((option) => { option.checked = false; });
      picker.months['09'].checked = true;
      picker.months['09'].dispatch('change');
      await flush();
      expect(liveFailureNotice(env.document)).toBeNull();
      env.requests[2].respond();
      await flush();
      expect(env.installed().month).toBe('2031-09');
      // The old Retry cannot repeat August or cancel September.
      expect(defaults.controller.retryRefresh()).toBe('unavailable');
      await flush();
      expect(toAugust(env)).toHaveLength(2);
      expect(env.windowObject.history.pushes).toEqual([env.requests[2].url.href]);
      expect(defaults.posts).toHaveLength(1);
    });

    it('J: a valid unknown Project stays restrictive through the adopted Reset refresh', async () => {
      const env = await failedAugust(`${ORIGIN}/calendar?month=2031-07&project=99&status=planned&view=list&weekStart=sunday`);
      expect(all(env.requests[0].url, 'project')).toEqual(['99']);
      const defaults = resetDefaultsHarness(env);
      await defaults.controller.resetDefaults();
      await flush();
      expect(env.requests[1].url.href).toBe(`${ORIGIN}/calendar?month=2031-08&project=99`);
      env.requests[1].respond();
      await flush();
      expect(env.windowObject.history.pushes).toEqual([`${ORIGIN}/calendar?month=2031-08&project=99`]);
      expect(env.installed().ids).toEqual([]);
      expect(defaults.posts).toHaveLength(1);
    });
  });

  /*
   * Cumulative closure P2: after a CONFIRMED Reset defaults, the installed
   * page's authority still names the deleted saved values until the refresh
   * installs. The omitted Status / View / week start of that refresh (pending
   * or failed) and of any later navigation before an install show the
   * confirmed post-Reset authority (the application fallbacks), so choosing
   * the old saved value is a real change. The REAL Calendar engine and the
   * REAL shared defaults controller run here; only the defaults endpoint is
   * injected, and the installed authority is the page's own script.
   */
  describe('Cumulative closure P2 post-Reset presentation authority', () => {
    const FIELDS = ['view', 'status', 'weekStart'];
    const FALLBACKS = Object.freeze({ view: 'grid', status: 'all', weekStart: 'monday' });
    const SAVED_PUBLISHED = Object.freeze({ view: 'list', status: 'published', weekStart: 'sunday' });
    const PLANNED_JULY = `${ORIGIN}/calendar?month=2031-07&status=planned`;
    const JULY_RESET = `${ORIGIN}/calendar?month=2031-07`;
    const FILTERED_JULY = `${ORIGIN}/calendar?month=2031-07&project=1&project=2&type=comic&type=images&status=planned`;
    const AUGUST_RESET = `${ORIGIN}/calendar?month=2031-08&project=1&project=2&type=comic&type=images`;
    const fail503 = (request) => request.respondWith({ ok: false, status: 503, url: request.url.href, text: async () => '' });
    let serverGeneration = 3;

    function authorityAt(generation, saved) {
      return {
        page: 'calendar',
        fields: [...FIELDS],
        multiFields: [],
        fallbacks: { ...FALLBACKS },
        defaults: { ...FALLBACKS, ...(saved || {}) },
        saved: Object.fromEntries(FIELDS.map((field) => [field, { stored: Boolean(saved?.[field]), valid: true }])),
        savedKeys: FIELDS.filter((field) => saved?.[field]),
        hasSavedDefaults: Boolean(saved),
        generation,
        revision: `r${generation}`,
        resetFiltersUrl: '/calendar',
      };
    }

    beforeEach(() => {
      serverGeneration = 3;
      SAVED = { ...SAVED_PUBLISHED };
      RENDER_AUTHORITY = (state) => ({
        ...authorityAt(serverGeneration, SAVED),
        resetFiltersUrl: `/calendar?month=${state.month}`,
        month: state.month,
        current: { view: state.view, status: state.status, weekStart: state.weekStart },
        currentUrl: href(state, {}),
      });
    });

    // One Reset defaults endpoint: the commit deletes the saved Calendar keys
    // and advances the generation once, as the route does.
    function harness(env, { hold = false, withAuthority = true, metadata = null } = {}) {
      const posts = [];
      let operations = 0;
      const commit = (body) => {
        const expected = Number(body.get('defaultsGeneration'));
        expect(expected).toBe(serverGeneration);
        serverGeneration = expected + 1;
        SAVED = null;
        const from = new URL(body.get('returnTo'), ORIGIN);
        const refresh = new URLSearchParams();
        if (/^\d{4}-(0[1-9]|1[0-2])$/.test(from.searchParams.get('month') || '')) refresh.set('month', from.searchParams.get('month'));
        ['project', 'type'].forEach((key) => from.searchParams.getAll(key).forEach((value) => refresh.append(key, value)));
        return {
          ok: withAuthority,
          status: withAuthority ? 200 : 500,
          json: async () => ({
            ...(withAuthority ? { status: 'success' } : { status: 'error', committed: true }),
            refreshUrl: refresh.toString() ? `/calendar?${refresh}` : '/calendar',
            operation: {
              id: body.get('defaultsOperation'), kind: 'resetDefaults', result: 'committed', committed: true,
              expectedGeneration: expected, generation: expected + 1,
            },
            ...(withAuthority ? { authority: authorityAt(expected + 1, null) } : {}),
          }),
        };
      };
      const fetch = vi.fn((url, options) => new Promise((resolve, reject) => {
        if (options?.method !== 'POST') {
          if (metadata) resolve({ ok: true, json: async () => ({ status: 'success', authority: metadata() }) });
          else reject(new Error('metadata unavailable'));
          return;
        }
        const post = { url: String(url), body: options.body, respond: () => resolve(commit(options.body)) };
        posts.push(post);
        if (!hold) post.respond();
      }));
      const controller = createCalendarFiltersDefaults(env.document, {
        fetch,
        csrfToken: () => 'token-1',
        createOperationId: () => `op-${operations += 1}`,
      });
      return { controller, posts, fetch };
    }

    // A real click on a radio: no change event when it is already checked.
    function choose(env, name, value) {
      const input = env.control(name, value);
      if (input.checked) return false;
      env.form().querySelectorAll(`input[name="${name}"]`).forEach((other) => { other.checked = false; });
      input.checked = true;
      input.dispatch('change');
      return true;
    }

    const presentation = (env) => ({
      status: env.installed().checked('status'),
      view: env.installed().checked('view'),
      weekStart: env.installed().checked('weekStart'),
    });
    const FALLBACK_CHECKED = { status: ['all'], view: ['grid'], weekStart: ['monday'] };

    async function confirmedReset(env, options) {
      const defaults = harness(env, options);
      expect((await defaults.controller.resetDefaults()).outcome).toBe('refreshing');
      await flush();
      expect(defaults.posts).toHaveLength(1);
      expect(defaults.posts[0].url).toBe('/calendar/defaults/reset');
      return defaults;
    }

    it('A/B/C/D/H/J/L: a held Reset refresh shows the fallbacks; Published is a real change that installs published only', async () => {
      const env = r2Environment(PLANNED_JULY);
      expect(presentation(env)).toEqual({ status: ['planned'], view: ['list'], weekStart: ['sunday'] });
      expect(env.installed().ids).toEqual([101, 103]);
      const defaults = await confirmedReset(env);
      expect(env.requests).toHaveLength(1);
      expect(env.requests[0].url.href).toBe(JULY_RESET);
      // A/B/H: the deleted saved Published / List / Sunday are not shown.
      expect(presentation(env)).toEqual(FALLBACK_CHECKED);

      // C: choosing Published is a change, sent as an explicit filter GET.
      expect(choose(env, 'status', 'published')).toBe(true);
      await flush();
      expect(env.requests).toHaveLength(2);
      const chosen = env.requests[1].url;
      expect(chosen.searchParams.get('month')).toBe('2031-07');
      expect(chosen.searchParams.get('status')).toBe('published');
      expect(all(chosen, 'project')).toEqual([]);

      // D: the older Reset refresh answers late and never installs.
      env.requests[0].respond();
      await flush();
      expect(env.installed().ids).toEqual([101, 103]);
      expect(presentation(env).status).toEqual(['published']);
      env.requests[1].respond();
      await flush();
      expect(env.installed().ids).toEqual([102]);
      expect(env.installed().location).toBe(chosen.href);
      expect(presentation(env)).toEqual({ status: ['published'], view: ['grid'], weekStart: ['monday'] });
      // J: one entry, for the user's filter edit; nothing replaced or duplicated.
      expect(env.windowObject.history.pushes).toEqual([chosen.href]);
      expect(env.windowObject.history.replaces).toEqual([]);
      // L: one Reset POST; every page request is a GET.
      expect(defaults.posts).toHaveLength(1);
      expect(onlyGets(env.windowObject)).toBe(true);
      expect(defaults.controller.operation).toBeNull();
    });

    it('E/L: a failed Reset refresh keeps the fallbacks; Published supersedes the stale Retry; no POST replay', async () => {
      const env = r2Environment(PLANNED_JULY);
      const defaults = await confirmedReset(env);
      fail503(env.requests[0]);
      await flush();
      expect(defaults.controller.operation).toMatchObject({ kind: 'resetDefaults', phase: 'refresh-failed', confirmed: true });
      expect(liveFailureNotice(env.document)).not.toBeNull();
      expect(env.installed().ids).toEqual([101, 103]);
      expect(presentation(env)).toEqual(FALLBACK_CHECKED);

      expect(choose(env, 'status', 'published')).toBe(true);
      await flush();
      expect(env.requests).toHaveLength(2);
      expect(env.requests[1].url.searchParams.get('status')).toBe('published');
      expect(env.requests[1].url.searchParams.get('month')).toBe('2031-07');
      // The old defaults Retry cannot take over (or undo) the newer choice.
      expect(defaults.controller.retryRefresh()).toBe('unavailable');
      expect(env.requests).toHaveLength(2);
      env.requests[1].respond();
      await flush();
      expect(env.installed().ids).toEqual([102]);
      expect(presentation(env).status).toEqual(['published']);
      expect(liveFailureNotice(env.document)).toBeNull();
      expect(defaults.controller.operation).toBeNull();
      expect(defaults.controller.retryRefresh()).toBe('unavailable');
      expect(env.windowObject.history.pushes).toEqual([env.requests[1].url.href]);
      expect(env.windowObject.history.replaces).toEqual([]);
      expect(defaults.posts).toHaveLength(1);
      expect(onlyGets(env.windowObject)).toBe(true);
    });

    it('E: a confirmed Reset whose answer carried no authority shows the installed fallbacks', async () => {
      const env = r2Environment(PLANNED_JULY);
      const defaults = await confirmedReset(env, { withAuthority: false });
      fail503(env.requests[0]);
      await flush();
      expect(defaults.controller.operation).toMatchObject({ phase: 'refresh-failed', confirmed: true });
      expect(presentation(env)).toEqual(FALLBACK_CHECKED);
      expect(choose(env, 'status', 'published')).toBe(true);
      await flush();
      expect(env.requests[1].url.searchParams.get('status')).toBe('published');
      env.requests[1].respond();
      await flush();
      expect(env.installed().ids).toEqual([102]);
      expect(defaults.posts).toHaveLength(1);
    });

    it.each([
      ['missing script', () => null],
      ['unreadable JSON', () => '{'],
      ['missing generation', (authority) => ({ ...authority, generation: undefined })],
      ['string generation', (authority) => ({ ...authority, generation: '4' })],
      ['partial authority', (authority) => ({ generation: 4, defaults: authority.defaults })],
      ['lower generation', (authority) => ({ ...authority, generation: 3 })],
      ['unsupported status at equal generation', (authority) => ({
        ...authority, fallbacks: { ...authority.fallbacks, status: 'archived' },
      })],
      ['unsupported view at equal generation', (authority) => ({
        ...authority, defaults: { ...authority.defaults, view: 'timeline' },
      })],
      ['unsupported week start at equal generation', (authority) => ({
        ...authority, current: { ...authority.current, weekStart: 'saturday' },
      })],
      ['unsupported status at a newer generation', (authority) => ({
        ...authority, generation: 5, current: { ...authority.current, status: 'archived' },
      })],
    ])('retains confirmed Reset through an install with %s', async (_label, corrupt) => {
      const env = r2Environment(PLANNED_JULY);
      const render = RENDER_AUTHORITY;
      const defaults = await confirmedReset(env);
      expect(choose(env, 'status', 'published')).toBe(true);
      await flush();
      RENDER_AUTHORITY = (state) => corrupt({ ...render(state), defaults: SAVED_PUBLISHED });
      env.requests[1].respond();
      await flush();
      expect(env.installed().ids).toEqual([102]);
      expect(defaults.controller.operation).toBeNull();

      env.windowObject.setLocation(`${ORIGIN}/calendar?month=2031-06`);
      env.windowObject.dispatch('popstate');
      await flush();
      expect(env.requests).toHaveLength(3);
      const beforeChoice = presentation(env);
      choose(env, 'status', 'published');
      await flush();
      expect(env.requests).toHaveLength(4);
      expect(beforeChoice).toEqual(FALLBACK_CHECKED);
      expect(env.requests[3].url.href).toBe(`${ORIGIN}/calendar?month=2031-06&status=published`);
      RENDER_AUTHORITY = render;
      env.requests[3].respond();
      await flush();
      const publishedIds = matchingIds(resolved(env.requests[3].url.searchParams));
      expect(publishedIds.length).toBeGreaterThan(0);
      expect(env.installed().ids).toEqual(publishedIds);
      expect(presentation(env).status).toEqual(['published']);
      env.requests[2].respond();
      env.requests[0].respond();
      await flush();
      expect(env.installed().ids).toEqual(publishedIds);
      expect(defaults.posts).toHaveLength(1);
    });

    it.each([4, 5])('a complete installed generation %i settles confirmed Reset', async (generation) => {
      const env = r2Environment(PLANNED_JULY);
      await confirmedReset(env);
      serverGeneration = generation;
      SAVED = SAVED_PUBLISHED;
      env.requests[0].respond();
      await flush();
      navigateCalendarLive(env.document, '/calendar?month=2031-08');
      await flush();
      expect(presentation(env)).toEqual({ view: ['list'], status: ['published'], weekStart: ['sunday'] });
      expect(choose(env, 'status', 'planned')).toBe(true);
      await flush();
      expect(env.requests[2].url.searchParams.get('status')).toBe('planned');
    });

    it('uses the last validated fallbacks for a correlated committed 500 after metadata disappears', async () => {
      const env = r2Environment(PLANNED_JULY);
      const defaults = harness(env, { withAuthority: false });
      navigateCalendarLive(env.document, JULY_RESET);
      await flush();
      RENDER_AUTHORITY = () => null;
      env.requests[0].respond();
      await flush();
      expect(presentation(env)).toEqual({ view: ['list'], status: ['published'], weekStart: ['sunday'] });
      expect((await defaults.controller.resetDefaults()).outcome).toBe('refreshing');
      await flush();
      expect(presentation(env)).toEqual(FALLBACK_CHECKED);
      fail503(env.requests[1]);
      await flush();
      expect(defaults.controller.retryRefresh()).toBe('refreshing');
      await flush();
      expect(env.requests[2].url.href).toBe(JULY_RESET);
      fail503(env.requests[2]);
      await flush();
      expect(choose(env, 'status', 'published')).toBe(true);
      await flush();
      expect(env.requests[3].url.href).toBe(`${JULY_RESET}&status=published`);
      expect(defaults.controller.retryRefresh()).toBe('unavailable');
      env.requests[3].respond();
      await flush();
      expect(env.installed().ids).toEqual([102]);
      expect(defaults.posts).toHaveLength(1);
    });

    it('uses the validated metadata GET after a cold start, including after failed refresh and Retry', async () => {
      const render = RENDER_AUTHORITY;
      RENDER_AUTHORITY = () => null;
      const env = r2Environment(JULY_RESET);
      let reads = 0;
      const defaults = harness(env, {
        withAuthority: false,
        metadata: () => {
          reads += 1;
          const authority = authorityAt(serverGeneration, SAVED);
          if (reads === 1) return authority;
          return { ...authority, fallbacks: { ...SAVED_PUBLISHED, status: 'archived' } };
        },
      });
      expect(presentation(env)).toEqual({ view: ['list'], status: ['published'], weekStart: ['sunday'] });
      expect(await defaults.controller.refreshSavedMetadata()).toMatchObject({ defaults: SAVED_PUBLISHED, fallbacks: FALLBACKS });
      expect(reads).toBe(1);
      expect((await defaults.controller.resetDefaults()).outcome).toBe('refreshing');
      await flush();
      expect(presentation(env)).toEqual(FALLBACK_CHECKED);
      fail503(env.requests[0]);
      await flush();
      expect(defaults.controller.retryRefresh()).toBe('refreshing');
      await flush();
      fail503(env.requests[1]);
      await flush();
      expect(presentation(env)).toEqual(FALLBACK_CHECKED);
      expect(choose(env, 'status', 'published')).toBe(true);
      await flush();
      expect(env.requests.map(({ url }) => url.href)).toEqual([
        JULY_RESET, JULY_RESET, `${JULY_RESET}&status=published`,
      ]);
      expect(defaults.controller.retryRefresh()).toBe('unavailable');
      RENDER_AUTHORITY = render;
      env.requests[2].respond();
      await flush();
      expect(env.installed().ids).toEqual([102]);
      expect(defaults.controller.savedMetadata()).toMatchObject({ generation: 4, defaults: FALLBACKS });
      expect(defaults.posts).toHaveLength(1);
    });

    for (const mode of ['failed', 'held']) {
      it(`F/N: failed August, ${mode} Reset refresh: Published keeps August, Projects and Types; one August entry; Back / Forward`, async () => {
        const env = r2Environment(FILTERED_JULY);
        expect(env.installed().ids).toEqual([101]);
        env.click('calendar-next');
        await flush();
        expect(env.requests[0].url.searchParams.get('month')).toBe('2031-08');
        fail503(env.requests[0]);
        await flush();
        expect(calendarLiveSnapshot(env.document)).toMatchObject({ failed: true, outstandingHistoryMode: 'push' });

        const defaults = await confirmedReset(env);
        expect(env.requests[1].url.href).toBe(AUGUST_RESET);
        if (mode === 'failed') {
          fail503(env.requests[1]);
          await flush();
          expect(defaults.controller.operation).toMatchObject({ phase: 'refresh-failed' });
          // F: a second failed August refresh still owes August's one push.
          expect(calendarLiveSnapshot(env.document)).toMatchObject({ failed: true, outstandingHistoryMode: 'push' });
        }
        expect(env.installed().month).toBe('2031-07');
        expect(presentation(env)).toEqual(FALLBACK_CHECKED);

        expect(choose(env, 'status', 'published')).toBe(true);
        await flush();
        expect(env.requests).toHaveLength(3);
        const chosen = env.requests[2].url;
        expect(chosen.searchParams.get('month')).toBe('2031-08');
        expect(all(chosen, 'project')).toEqual(['1', '2']);
        expect(all(chosen, 'type')).toEqual(['comic', 'images']);
        expect(chosen.searchParams.get('status')).toBe('published');
        if (mode === 'held') {
          env.requests[1].respond();
          await flush();
          expect(env.installed().month).toBe('2031-07');
        }
        expect(defaults.controller.retryRefresh()).toBe('unavailable');
        env.requests[2].respond();
        await flush();
        expect(env.installed().month).toBe('2031-08');
        expect(env.installed().ids).toEqual([204]);
        expect(env.installed().checked('project')).toEqual(['1', '2']);
        expect(env.installed().checked('type')).toEqual(['comic', 'images']);
        expect(presentation(env).status).toEqual(['published']);
        // Exactly one August entry, the explicit Published August.
        expect(env.windowObject.history.pushes).toEqual([chosen.href]);
        expect(env.windowObject.history.replaces).toEqual([]);

        // Back restores filtered July; Forward the intended August.
        env.windowObject.setLocation(FILTERED_JULY);
        env.windowObject.dispatch('popstate');
        await flush();
        env.requests.at(-1).respond();
        await flush();
        expect(env.installed().month).toBe('2031-07');
        expect(env.installed().ids).toEqual([101]);
        expect(presentation(env).status).toEqual(['planned']);
        env.windowObject.setLocation(chosen.href);
        env.windowObject.dispatch('popstate');
        await flush();
        env.requests.at(-1).respond();
        await flush();
        expect(env.installed().month).toBe('2031-08');
        expect(env.installed().ids).toEqual([204]);
        expect(env.windowObject.history.pushes).toEqual([chosen.href]);
        expect(defaults.posts).toHaveLength(1);
        expect(onlyGets(env.windowObject)).toBe(true);
      });
    }

    it('I: Reset of an installed month with no newer navigation installs the fallbacks with one replace', async () => {
      const env = r2Environment(PLANNED_JULY);
      const defaults = await confirmedReset(env);
      expect(presentation(env)).toEqual(FALLBACK_CHECKED);
      env.requests[0].respond();
      await flush();
      expect(env.installed().ids).toEqual([101, 102, 103]);
      expect(presentation(env)).toEqual(FALLBACK_CHECKED);
      expect(env.windowObject.history.pushes).toEqual([]);
      expect(env.windowObject.history.replaces).toEqual([JULY_RESET]);
      expect(defaults.controller.operation).toBeNull();
      // Synchronization alone requested nothing.
      expect(env.requests).toHaveLength(1);
      expect(choose(env, 'status', 'published')).toBe(true);
      await flush();
      expect(env.requests).toHaveLength(2);
      expect(env.requests[1].url.searchParams.get('status')).toBe('published');
      expect(defaults.posts).toHaveLength(1);
    });

    it('G: newer View, week start and Status edits during the held refresh win over late responses', async () => {
      const env = r2Environment(PLANNED_JULY);
      const defaults = await confirmedReset(env);
      expect(choose(env, 'view', 'list')).toBe(true);
      await flush();
      expect(env.requests[1].url.searchParams.get('view')).toBe('list');
      expect(choose(env, 'weekStart', 'sunday')).toBe(true);
      await flush();
      expect(env.requests[2].url.searchParams.get('view')).toBe('list');
      expect(env.requests[2].url.searchParams.get('weekStart')).toBe('sunday');
      expect(choose(env, 'status', 'planned')).toBe(true);
      await flush();
      expect(choose(env, 'status', 'published')).toBe(true);
      await flush();
      expect(env.requests).toHaveLength(5);
      const latest = env.requests[4].url;
      expect(latest.searchParams.get('status')).toBe('published');
      expect(latest.searchParams.get('view')).toBe('list');
      expect(latest.searchParams.get('weekStart')).toBe('sunday');
      // Newest first, then every older response late: only the newest installs.
      env.requests[4].respond();
      await flush();
      env.requests.slice(0, 4).reverse().forEach((request) => request.respond());
      await flush();
      expect(env.installed().location).toBe(latest.href);
      expect(env.installed().ids).toEqual([102]);
      expect(presentation(env)).toEqual({ status: ['published'], view: ['list'], weekStart: ['sunday'] });
      expect(env.windowObject.history.pushes).toEqual([latest.href]);
      expect(defaults.posts).toHaveLength(1);
    });

    it('F: a newer Published choice while the Reset POST is held stays authoritative through the refresh', async () => {
      const env = r2Environment(PLANNED_JULY);
      const defaults = harness(env, { hold: true });
      const pending = defaults.controller.resetDefaults();
      await flush();
      expect(choose(env, 'status', 'published')).toBe(true);
      await flush();
      expect(env.requests).toHaveLength(1);
      expect(env.requests[0].url.searchParams.get('status')).toBe('published');
      defaults.posts[0].respond();
      await pending;
      await flush();
      expect(env.requests).toHaveLength(2);
      expect(env.requests[1].url.searchParams.get('status')).toBe('published');
      expect(presentation(env).status).toEqual(['published']);
      env.requests[1].respond();
      env.requests[0].respond();
      await flush();
      expect(env.installed().ids).toEqual([102]);
      expect(presentation(env).status).toEqual(['published']);
      expect(env.windowObject.history.pushes).toEqual([env.requests[1].url.href]);
      expect(defaults.posts).toHaveLength(1);
    });

    it('G/H: Next and Back during the held refresh keep the post-Reset fallbacks for omitted fields', async () => {
      const env = r2Environment(PLANNED_JULY);
      const defaults = await confirmedReset(env);
      env.click('calendar-next');
      await flush();
      const august = env.requests[1].url;
      expect(august.searchParams.get('month')).toBe('2031-08');
      expect(august.searchParams.has('status')).toBe(false);
      expect(presentation(env)).toEqual(FALLBACK_CHECKED);
      expect(choose(env, 'status', 'published')).toBe(true);
      await flush();
      expect(env.requests[2].url.searchParams.get('month')).toBe('2031-08');
      expect(env.requests[2].url.searchParams.get('status')).toBe('published');

      // H: Back to a monthless-status entry while those are held.
      env.windowObject.setLocation(`${ORIGIN}/calendar?month=2031-06`);
      env.windowObject.dispatch('popstate');
      await flush();
      expect(presentation(env)).toEqual(FALLBACK_CHECKED);
      env.requests.slice(0, 3).forEach((request) => request.respond());
      await flush();
      expect(env.installed().month).toBe('2031-07');
      env.requests.at(-1).respond();
      await flush();
      expect(env.installed().month).toBe('2031-06');
      expect(env.installed().ids).toEqual([601, 602]);
      expect(presentation(env)).toEqual(FALLBACK_CHECKED);
      expect(defaults.posts).toHaveLength(1);
    });

    it('K: a valid unknown Project stays restrictive through the post-Reset Published choice', async () => {
      const env = r2Environment(`${ORIGIN}/calendar?month=2031-07&project=99&status=planned`);
      await confirmedReset(env);
      expect(env.requests[0].url.href).toBe(`${ORIGIN}/calendar?month=2031-07&project=99`);
      expect(presentation(env).status).toEqual(['all']);
      expect(choose(env, 'status', 'published')).toBe(true);
      await flush();
      const chosen = env.requests[1].url;
      expect(all(chosen, 'project')).toEqual(['99']);
      expect(chosen.searchParams.get('status')).toBe('published');
      env.requests[1].respond();
      await flush();
      expect(env.installed().ids).toEqual([]);
    });

    it('M: an older acknowledgement never reinstates deleted saved values; an install settles the authority', async () => {
      const env = r2Environment(PLANNED_JULY);
      await confirmedReset(env);
      // An older (generation 3) authority offered later is ignored.
      expect(navigateCalendarLive(env.document, '/calendar?month=2031-08', {
        historyMode: 'push', defaultsAuthority: authorityAt(3, SAVED_PUBLISHED),
      }).status).toBe('started');
      await flush();
      expect(presentation(env)).toEqual(FALLBACK_CHECKED);
      env.requests.at(-1).respond();
      await flush();
      expect(env.installed().month).toBe('2031-08');
      expect(presentation(env)).toEqual(FALLBACK_CHECKED);
      // Installed generation 4: an older offer still cannot apply.
      navigateCalendarLive(env.document, '/calendar?month=2031-09', {
        historyMode: 'push', defaultsAuthority: authorityAt(2, SAVED_PUBLISHED),
      });
      await flush();
      expect(presentation(env)).toEqual(FALLBACK_CHECKED);
    });
  });
});

/*
 * R9 (related Calendar P3): a held Back that restores an unknown-only Project
 * and Project Type keeps them in hidden intent carriers while the real
 * multi-selects (driven by the production dropdown module) reconcile Select
 * all back to checked. A later status edit must keep both restrictions until
 * the server normalizes them or the user edits that dimension.
 */
describe('R9 Calendar unknown-only Project / Type restrictions survive serialization', () => {
  const ORIGIN = 'http://creatorcrate.test';
  const INSTALLED = `${ORIGIN}/calendar?month=2031-07&status=all&view=grid&weekStart=monday`;
  const UNKNOWN = `${ORIGIN}/calendar?month=2031-07&project=999999&type=audio&status=all&view=grid&weekStart=monday`;

  function multiDropdown(form, name, options, selected) {
    const dropdown = makeNode({ tagName: 'details', attrs: {
      id: `calendar-${name}-filter`, 'data-cc-dropdown': '', 'data-cc-dropdown-mode': 'multiple',
      'data-cc-dropdown-select-all': '',
      'data-cc-dropdown-empty-summary': name === 'project' ? 'All projects' : 'All types',
      'data-cc-dropdown-count-label': name === 'project' ? 'projects' : 'types',
    } });
    const summary = makeNode({ tagName: 'summary', attrs: { 'aria-label': name === 'project' ? 'Projects: ' : 'Project Types: ' } });
    summary.appendChild(makeNode({ tagName: 'span', attrs: { 'data-cc-dropdown-summary-current': '' } }));
    dropdown.appendChild(summary);
    const selectAll = makeNode({ tagName: 'input', attrs: {
      id: `calendar-${name}-all`, name, type: 'checkbox', value: '', 'data-cc-dropdown-select-all': '',
    }, checked: selected.length === 0 });
    dropdown.appendChild(selectAll);
    options.forEach((value) => dropdown.appendChild(makeNode({ tagName: 'input', attrs: {
      id: `calendar-${name}-${value}`, name, type: 'checkbox', value,
    }, checked: selected.includes(value) })));
    form.appendChild(dropdown);
  }

  function render(params) {
    const document = makeNode({ tagName: 'document' });
    document.nodeType = 9;
    document.ownerDocument = document;
    document.activeElement = null;
    document.getElementById = (id) => document.querySelector(`#${id}`);
    const month = params.get('month') || '2031-07';
    const region = makeNode({ attrs: {
      'data-calendar-live-region': '', 'data-calendar-month': month, 'data-calendar-current-month': '2031-07',
    } });
    region.appendChild(makeNode({ attrs: { 'data-calendar-live-status': '' } }));
    const form = makeNode({ tagName: 'form', attrs: { id: 'calendar-filters', action: '/calendar' } });
    form.requestSubmit = () => form.dispatch('submit');
    form.appendChild(makeNode({ tagName: 'input', attrs: { name: 'month', type: 'hidden' }, value: month }));
    // As the server: unknown Project / Type values are not rendered.
    multiDropdown(form, 'project', ['1', '2'], params.getAll('project').filter((value) => ['1', '2'].includes(value)));
    multiDropdown(form, 'type', ['comic', 'images'], params.getAll('type').filter((value) => ['comic', 'images'].includes(value)));
    for (const [name, values, selected] of [
      ['status', ['all', 'planned', 'published'], params.get('status') || 'all'],
      ['view', ['grid', 'list'], params.get('view') || 'grid'],
      ['weekStart', ['monday', 'sunday'], params.get('weekStart') || 'monday'],
    ]) {
      values.forEach((value) => form.appendChild(makeNode({ tagName: 'input', attrs: {
        id: `calendar-${name}-${value}`, name, type: 'radio', value,
      }, checked: value === selected })));
    }
    const resetForm = makeNode({ tagName: 'form', attrs: { action: '/calendar' } });
    resetForm.appendChild(makeNode({ tagName: 'input', attrs: { name: 'month', type: 'hidden', value: month } }));
    resetForm.appendChild(makeNode({ tagName: 'button', attrs: { id: 'calendar-reset', 'data-calendar-reset': '', type: 'submit' } }));
    const dialog = makeNode({ tagName: 'dialog' });
    dialog.appendChild(form);
    dialog.appendChild(resetForm);
    document.appendChild(region);
    document.appendChild(dialog);
    return { document };
  }

  let oldDocument;
  let oldFormData;
  beforeEach(() => {
    oldDocument = globalThis.document;
    oldFormData = globalThis.FormData;
  });
  afterEach(() => {
    globalThis.document = oldDocument;
    globalThis.FormData = oldFormData;
  });

  function environment() {
    const { document } = render(new URL(INSTALLED).searchParams);
    const pages = new Map();
    const windowObject = makeWindow(document, pages);
    windowObject.setLocation(INSTALLED);
    globalThis.document = document;
    globalThis.FormData = windowObject.FormData;
    const requests = [];
    let counter = 0;
    windowObject.fetch.mockImplementation((requestedUrl, options) => {
      const url = new URL(requestedUrl);
      let settle;
      const promise = new Promise((resolve, reject) => { settle = { resolve, reject }; });
      requests.push({
        url,
        options,
        respond() {
          const key = `r9-calendar-${++counter}`;
          pages.set(key, render(url.searchParams));
          settle.resolve({ ok: true, url: url.href, text: async () => key });
        },
        fail() { settle.reject(new Error('offline')); },
      });
      return promise;
    });
    enhanceCalendarLiveFiltering(document);
    enhanceDropdowns(document);
    const form = () => document.querySelector('#calendar-filters');
    const control = (name, value) => form().querySelector(`#calendar-${name}-${value}`);
    const carriers = (name) => form().querySelectorAll(`input[data-calendar-intended-carrier][name="${name}"]`)
      .map((input) => input.value);
    const chooseRadio = (name, value) => {
      form().querySelectorAll(`input[name="${name}"]`).forEach((other) => { other.checked = false; });
      control(name, value).checked = true;
      control(name, value).dispatch('change');
    };
    // A user click on a real multi-select checkbox (see the Releases R9 helper).
    const userToggle = (input) => {
      input.checked = !input.checked;
      const click = { type: 'click', target: input, button: 0, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      document.listeners.filter((listener) => listener.type === 'click').forEach(({ handler }) => handler(click));
      if (click.defaultPrevented) { input.checked = !input.checked; return false; }
      const change = { type: 'change', target: input, defaultPrevented: false, preventDefault() {} };
      document.listeners.filter((listener) => listener.type === 'change').forEach(({ handler }) => handler(change));
      let current = input;
      while (current && current !== document) {
        current.listeners.filter((listener) => listener.type === 'change').forEach(({ handler }) => handler(change));
        current = current.parentNode;
      }
      return true;
    };
    const back = (href) => {
      windowObject.setLocation(href);
      windowObject.dispatch('popstate');
    };
    return { document, windowObject, requests, form, control, carriers, chooseRadio, userToggle, back };
  }

  const all = (url, key) => url.searchParams.getAll(key);
  const onlyGets = (windowObject) => windowObject.fetch.mock.calls.every(([, options]) => options.method === 'GET');

  it('Back held to unknown-only Project + Type -> status edit keeps both; the late Back never installs', async () => {
    const env = environment();
    env.back(UNKNOWN);
    await flush();
    expect(env.requests).toHaveLength(1);
    expect(env.requests[0].url.href).toBe(UNKNOWN);
    expect(env.carriers('project')).toEqual(['999999']);
    expect(env.carriers('type')).toEqual(['audio']);
    // R10: the real dropdown counts the carriers as selected.
    expect(env.control('project', 'all').checked).toBe(false);
    expect(env.control('type', 'all').checked).toBe(false);

    env.chooseRadio('status', 'published');
    await flush();
    expect(env.requests).toHaveLength(2);
    const edited = env.requests[1].url;
    expect(all(edited, 'project')).toEqual(['999999']);
    expect(all(edited, 'type')).toEqual(['audio']);
    expect(edited.searchParams.get('status')).toBe('published');
    expect(edited.searchParams.get('month')).toBe('2031-07');
    expect(edited.searchParams.get('view')).toBe('grid');
    expect(edited.searchParams.get('weekStart')).toBe('monday');

    env.requests[1].respond();
    await flush();
    const installedHref = env.windowObject.location.href;
    env.requests[0].respond();
    await flush();
    expect(env.windowObject.location.href).toBe(installedHref);
    expect(all(new URL(installedHref), 'project')).toEqual(['999999']);
    expect(onlyGets(env.windowObject)).toBe(true);
  });

  it('a failed Back stays the base: a status edit keeps the unknown-only restrictions', async () => {
    const env = environment();
    env.back(UNKNOWN);
    await flush();
    env.requests[0].fail();
    await flush();
    env.chooseRadio('status', 'planned');
    await flush();
    const edited = env.requests[1].url;
    expect(all(edited, 'project')).toEqual(['999999']);
    expect(all(edited, 'type')).toEqual(['audio']);
    expect(edited.searchParams.get('status')).toBe('planned');
  });

  it('editing Project replaces only the unknown Project; deselecting it returns to All without leaking', async () => {
    const env = environment();
    env.back(UNKNOWN);
    await flush();
    expect(env.userToggle(env.control('project', '1'))).toBe(true);
    await flush();
    expect(env.carriers('project')).toEqual([]);
    expect(env.control('project', 'all').checked).toBe(false);
    let edited = env.requests[1].url;
    expect(all(edited, 'project')).toEqual(['1']);
    expect(all(edited, 'type')).toEqual(['audio']);

    expect(env.userToggle(env.control('project', '1'))).toBe(true);
    await flush();
    expect(env.control('project', 'all').checked).toBe(true);
    edited = env.requests[2].url;
    expect(all(edited, 'project')).toEqual([]);
    expect(all(edited, 'type')).toEqual(['audio']);
  });

  it('explicit Select all over a chosen Type clears that Type and its carrier', async () => {
    const env = environment();
    env.back(`${ORIGIN}/calendar?month=2031-07&type=comic&type=audio&status=all&view=grid&weekStart=monday`);
    await flush();
    expect(env.control('type', 'comic').checked).toBe(true);
    expect(env.carriers('type')).toEqual(['audio']);
    expect(env.userToggle(env.control('type', 'all'))).toBe(true);
    await flush();
    expect(env.carriers('type')).toEqual([]);
    expect(env.control('type', 'comic').checked).toBe(false);
    const edited = env.requests[1].url;
    expect(all(edited, 'type')).toEqual([]);
    expect(onlyGets(env.windowObject)).toBe(true);
  });

  it('Reset filters during the held Back drops the carried restrictions', async () => {
    const env = environment();
    env.back(UNKNOWN);
    await flush();
    env.document.querySelector('#calendar-reset').dispatch('click', { button: 0 });
    await flush();
    expect(env.requests).toHaveLength(2);
    const reset = env.requests[1].url;
    expect(all(reset, 'project')).toEqual([]);
    expect(all(reset, 'type')).toEqual([]);
    expect(env.carriers('project')).toEqual([]);
    expect(env.carriers('type')).toEqual([]);
    env.chooseRadio('status', 'published');
    await flush();
    expect(all(env.requests[2].url, 'project')).toEqual([]);
    expect(all(env.requests[2].url, 'type')).toEqual([]);
  });

  /*
   * R10: the carried Project / Type values count as selected in the real
   * dropdowns (restricted summary, unchecked Select all); one Select all
   * activation clears only its own dimension through the dropdown's event path.
   */
  describe('R10 pending hidden-selection dropdown state and one-click clearing', () => {
    const summary = (env, name) => env.form().querySelector(`#calendar-${name}-filter [data-cc-dropdown-summary-current]`).textContent;
    const ariaLabel = (env, name) => env.form().querySelector(`#calendar-${name}-filter summary`).getAttribute('aria-label');
    const presentation = (url) => ['month', 'status', 'view', 'weekStart'].map((key) => url.searchParams.get(key));

    async function clearBoth(env, base) {
      expect(summary(env, 'project')).toBe('1 project selected');
      expect(summary(env, 'type')).toBe('1 type selected');
      expect(ariaLabel(env, 'project')).toBe('Projects: 1 project selected');
      expect(env.control('project', 'all').checked).toBe(false);
      expect(env.control('type', 'all').checked).toBe(false);

      expect(env.userToggle(env.control('project', 'all'))).toBe(true);
      await flush();
      expect(env.requests).toHaveLength(base + 1);
      let edited = env.requests[base].url;
      expect(all(edited, 'project')).toEqual([]);
      expect(all(edited, 'type')).toEqual(['audio']);
      expect(env.carriers('project')).toEqual([]);
      expect(env.carriers('type')).toEqual(['audio']);
      expect(env.control('project', 'all').checked).toBe(true);
      expect(summary(env, 'project')).toBe('All projects');
      expect(summary(env, 'type')).toBe('1 type selected');
      expect(env.control('type', 'all').checked).toBe(false);

      expect(env.userToggle(env.control('type', 'all'))).toBe(true);
      await flush();
      expect(env.requests).toHaveLength(base + 2);
      edited = env.requests[base + 1].url;
      expect(all(edited, 'project')).toEqual([]);
      expect(all(edited, 'type')).toEqual([]);
      expect(env.carriers('project')).toEqual([]);
      expect(env.carriers('type')).toEqual([]);
      expect(summary(env, 'project')).toBe('All projects');
      expect(summary(env, 'type')).toBe('All types');
      expect(env.control('project', 'all').checked).toBe(true);
      expect(env.control('type', 'all').checked).toBe(true);
      return edited;
    }

    it('held Back: both restricted; clear Projects (Type stays), then Types; the late Back never installs', async () => {
      const env = environment();
      env.back(UNKNOWN);
      await flush();
      const edited = await clearBoth(env, 1);
      expect(presentation(edited)).toEqual(['2031-07', 'all', 'grid', 'monday']);
      env.requests[2].respond();
      await flush();
      const installedHref = env.windowObject.location.href;
      env.requests[1].respond();
      env.requests[0].respond();
      await flush();
      expect(env.windowObject.location.href).toBe(installedHref);
      expect(all(new URL(installedHref), 'project')).toEqual([]);
      expect(all(new URL(installedHref), 'type')).toEqual([]);
      expect(env.document.querySelectorAll('input[data-calendar-intended-carrier]')).toHaveLength(0);
      expect(summary(env, 'project')).toBe('All projects');
      expect(onlyGets(env.windowObject)).toBe(true);
    });

    it('failed Back: summaries stay restricted; one-click clears still work', async () => {
      const env = environment();
      env.back(UNKNOWN);
      await flush();
      env.requests[0].fail();
      await flush();
      await clearBoth(env, 1);
      expect(onlyGets(env.windowObject)).toBe(true);
    });

    it('failed Back -> GET-only Retry held: summaries restricted; Select all supersedes Retry', async () => {
      const env = environment();
      env.back(UNKNOWN);
      await flush();
      env.requests[0].fail();
      await flush();
      liveFailureRetries(env.document)[0].dispatch('click', { button: 0 });
      await flush();
      expect(env.requests).toHaveLength(2);
      expect(all(env.requests[1].url, 'project')).toEqual(['999999']);
      await clearBoth(env, 2);
      expect(env.requests[1].options.signal.aborted).toBe(true);
      expect(onlyGets(env.windowObject)).toBe(true);
    });

    it('after a status edit the restrictions and summaries survive; clearing keeps the edited status', async () => {
      const env = environment();
      env.back(UNKNOWN);
      await flush();
      env.chooseRadio('status', 'published');
      await flush();
      expect(all(env.requests[1].url, 'project')).toEqual(['999999']);
      const edited = await clearBoth(env, 2);
      expect(edited.searchParams.get('status')).toBe('published');
      expect(edited.searchParams.get('month')).toBe('2031-07');
    });

    it('mixed visible + hidden Project: two selected; Select all clears both', async () => {
      const env = environment();
      env.back(`${ORIGIN}/calendar?month=2031-07&project=1&project=999999&status=all&view=grid&weekStart=monday`);
      await flush();
      expect(env.control('project', '1').checked).toBe(true);
      expect(summary(env, 'project')).toBe('2 projects selected');
      expect(summary(env, 'type')).toBe('All types');
      expect(env.userToggle(env.control('project', 'all'))).toBe(true);
      await flush();
      expect(all(env.requests[1].url, 'project')).toEqual([]);
      expect(env.control('project', '1').checked).toBe(false);
      expect(summary(env, 'project')).toBe('All projects');
    });

    /*
     * P3 correction 1: a disabled marked carrier is left out of FormData, so
     * its dropdown shows All with Select all checked; the other dimension's
     * enabled carrier still counts and survives.
     */
    it('P3: disabled Project carrier + enabled Type carrier: only Type counts and is sent', async () => {
      const env = environment();
      env.back(UNKNOWN);
      await flush();
      const projectCarrier = env.form().querySelectorAll('input[data-calendar-intended-carrier][name="project"]');
      expect(projectCarrier).toHaveLength(1);
      projectCarrier[0].disabled = true;
      enhanceDropdowns(env.document);
      const submitted = Array.from(new env.windowObject.FormData(env.form()).entries())
        .filter(([name, value]) => (name === 'project' || name === 'type') && value !== '');
      expect(submitted).toEqual([['type', 'audio']]);
      expect(summary(env, 'project')).toBe('All projects');
      expect(env.control('project', 'all').checked).toBe(true);
      expect(summary(env, 'type')).toBe('1 type selected');
      expect(env.control('type', 'all').checked).toBe(false);
      // Already unrestricted: Select all is a no-op (no request).
      expect(env.userToggle(env.control('project', 'all'))).toBe(false);
      await flush();
      expect(env.requests).toHaveLength(1);
      expect(projectCarrier[0].disabled).toBe(true);
      // Another dimension's edit sends Type but not the disabled Project.
      env.chooseRadio('status', 'published');
      await flush();
      expect(env.requests).toHaveLength(2);
      expect(all(env.requests[1].url, 'project')).toEqual([]);
      expect(all(env.requests[1].url, 'type')).toEqual(['audio']);
      // One Type Select all clears the enabled Type carrier.
      expect(env.userToggle(env.control('type', 'all'))).toBe(true);
      await flush();
      expect(env.requests).toHaveLength(3);
      expect(all(env.requests[2].url, 'type')).toEqual([]);
      expect(env.requests[2].url.searchParams.get('status')).toBe('published');
      expect(summary(env, 'type')).toBe('All types');
      expect(onlyGets(env.windowObject)).toBe(true);
    });

    it('genuinely unrestricted: the checked Select all stays a no-op', async () => {
      const env = environment();
      expect(summary(env, 'project')).toBe('All projects');
      expect(env.userToggle(env.control('project', 'all'))).toBe(false);
      await flush();
      expect(env.requests).toHaveLength(0);
    });
  });

  /*
   * P3-C1 follow-up: a Calendar carrier belongs to its HTML form owner. One
   * outside #calendar-filters naming it with form="" is counted, submitted and
   * cleared by that form's edits; one inside #calendar-filters but owned by
   * another form is never counted, sent or removed by Calendar edits.
   */
  describe('P3-C1 follow-up: Calendar carriers follow their HTML form owner', () => {
    const MARKS = { 'data-calendar-intended-carrier': '', 'data-cc-dropdown-carried-value': '' };
    const summary = (env, name) => env.form().querySelector(`#calendar-${name}-filter [data-cc-dropdown-summary-current]`).textContent;
    const presentation = (url) => ['month', 'status', 'view', 'weekStart'].map((key) => url.searchParams.get(key));

    function ownershipEnvironment() {
      const env = environment();
      const otherForm = makeNode({ tagName: 'form', attrs: { id: 'calendar-other-form', action: '/elsewhere' } });
      const outside = makeNode({ attrs: { 'data-outside-calendar-form': '' } });
      env.document.appendChild(otherForm);
      env.document.appendChild(outside);
      const add = (parent, name, value, form = null, disabled = false) => {
        const carrier = makeNode({ tagName: 'input', attrs: { type: 'hidden', name, value, ...MARKS }, value });
        if (form) carrier.setAttribute('form', form);
        carrier.disabled = disabled;
        parent.appendChild(carrier);
        return carrier;
      };
      const external = (name, value, disabled = false) => add(outside, name, value, 'calendar-filters', disabled);
      const foreignInside = (name, value) => add(env.form(), name, value, 'calendar-other-form');
      const everywhere = (name) => env.document.querySelectorAll(`input[data-cc-dropdown-carried-value][name="${name}"]`)
        .map((input) => input.value).sort();
      const submitted = (form, name) => Array.from(new env.windowObject.FormData(form).entries())
        .filter(([key, value]) => key === name && value !== '').map(([, value]) => value).sort();
      return { ...env, otherForm, outside, external, foreignInside, everywhere, submitted };
    }

    it('external Project counts and is sent; a foreign-owned Type inside the form is neither; Select all clears Projects only', async () => {
      const env = ownershipEnvironment();
      env.external('project', '999999');
      env.external('project', '999999');
      env.external('project', '888888', true);
      const foreign = env.foreignInside('type', 'audio');
      enhanceDropdowns(env.document);
      expect(env.submitted(env.form(), 'project')).toEqual(['999999', '999999']);
      expect(env.submitted(env.form(), 'type')).toEqual([]);
      expect(env.submitted(env.otherForm, 'type')).toEqual(['audio']);
      expect(summary(env, 'project')).toBe('1 project selected');
      expect(env.control('project', 'all').checked).toBe(false);
      expect(summary(env, 'type')).toBe('All types');
      expect(env.control('type', 'all').checked).toBe(true);

      env.chooseRadio('status', 'published');
      await flush();
      expect(env.requests).toHaveLength(1);
      expect(all(env.requests[0].url, 'project')).toEqual(['999999', '999999']);
      expect(all(env.requests[0].url, 'type')).toEqual([]);
      expect(presentation(env.requests[0].url)).toEqual(['2031-07', 'published', 'grid', 'monday']);

      // Type Select all is a no-op (genuinely unrestricted) and keeps the foreign carrier.
      expect(env.userToggle(env.control('type', 'all'))).toBe(false);
      expect(foreign.parentNode).toBe(env.form());

      expect(env.userToggle(env.control('project', 'all'))).toBe(true);
      await flush();
      expect(env.requests).toHaveLength(2);
      expect(all(env.requests[1].url, 'project')).toEqual([]);
      expect(presentation(env.requests[1].url)).toEqual(['2031-07', 'published', 'grid', 'monday']);
      expect(env.everywhere('project')).toEqual([]);
      expect(env.everywhere('type')).toEqual(['audio']);
      expect(foreign.parentNode).toBe(env.form());
      expect(summary(env, 'project')).toBe('All projects');
      expect(env.control('project', 'all').checked).toBe(true);
      expect(onlyGets(env.windowObject)).toBe(true);
    });

    it('editing a Type keeps a foreign-owned Type carrier; choosing a Project keeps the foreign Project carrier', async () => {
      const env = ownershipEnvironment();
      const foreignType = env.foreignInside('type', 'audio');
      const foreignProject = env.foreignInside('project', '555555');
      enhanceDropdowns(env.document);
      expect(env.userToggle(env.control('type', 'comic'))).toBe(true);
      await flush();
      expect(all(env.requests[0].url, 'type')).toEqual(['comic']);
      expect(foreignType.parentNode).toBe(env.form());
      expect(env.userToggle(env.control('project', '1'))).toBe(true);
      await flush();
      expect(all(env.requests[1].url, 'project')).toEqual(['1']);
      expect(all(env.requests[1].url, 'type')).toEqual(['comic']);
      expect(foreignProject.parentNode).toBe(env.form());
      expect(env.submitted(env.otherForm, 'project')).toEqual(['555555']);
      expect(env.submitted(env.otherForm, 'type')).toEqual(['audio']);
    });

    it('held Back + external Type: status edit keeps both; failed GET and Retry keep them; Select all clears Types only', async () => {
      const env = ownershipEnvironment();
      const foreign = env.foreignInside('type', 'video');
      env.back(UNKNOWN);
      await flush();
      expect(env.everywhere('type')).toEqual(['audio', 'video']);
      env.external('type', 'zine');
      enhanceDropdowns(env.document);
      expect(summary(env, 'type')).toBe('2 types selected');
      expect(summary(env, 'project')).toBe('1 project selected');

      env.chooseRadio('status', 'planned');
      await flush();
      expect(env.requests).toHaveLength(2);
      expect(all(env.requests[1].url, 'type').sort()).toEqual(['audio', 'zine']);
      expect(all(env.requests[1].url, 'project')).toEqual(['999999']);
      env.requests[1].fail();
      await flush();
      expect(summary(env, 'type')).toBe('2 types selected');
      liveFailureRetries(env.document)[0].dispatch('click', { button: 0 });
      await flush();
      expect(env.requests).toHaveLength(3);
      expect(all(env.requests[2].url, 'type').sort()).toEqual(['audio', 'zine']);
      expect(env.control('type', 'all').checked).toBe(false);

      expect(env.userToggle(env.control('type', 'all'))).toBe(true);
      await flush();
      expect(env.requests).toHaveLength(4);
      expect(env.requests[2].options.signal.aborted).toBe(true);
      const cleared = env.requests[3].url;
      expect(all(cleared, 'type')).toEqual([]);
      expect(all(cleared, 'project')).toEqual(['999999']);
      expect(presentation(cleared)).toEqual(['2031-07', 'planned', 'grid', 'monday']);
      expect(env.everywhere('type')).toEqual(['video']);
      expect(foreign.parentNode).toBe(env.form());
      expect(summary(env, 'type')).toBe('All types');
      expect(summary(env, 'project')).toBe('1 project selected');
      expect(onlyGets(env.windowObject)).toBe(true);
    });

    it('month navigation (history) and Reset replace owned external carriers and keep the foreign one', async () => {
      const env = ownershipEnvironment();
      env.external('project', '444444');
      const foreign = env.foreignInside('project', '555555');
      enhanceDropdowns(env.document);
      env.back(`${ORIGIN}/calendar?month=2031-08&project=999999&status=published&view=list&weekStart=sunday`);
      await flush();
      expect(env.requests).toHaveLength(1);
      expect(env.everywhere('project')).toEqual(['555555', '999999']);
      expect(summary(env, 'project')).toBe('1 project selected');
      env.external('type', 'zine');
      enhanceDropdowns(env.document);
      expect(summary(env, 'type')).toBe('1 type selected');

      env.document.querySelector('#calendar-reset').dispatch('click', { button: 0 });
      await flush();
      expect(env.requests).toHaveLength(2);
      expect(env.requests[0].options.signal.aborted).toBe(true);
      expect(all(env.requests[1].url, 'project')).toEqual([]);
      expect(all(env.requests[1].url, 'type')).toEqual([]);
      expect(env.everywhere('project')).toEqual(['555555']);
      expect(env.everywhere('type')).toEqual([]);
      expect(foreign.parentNode).toBe(env.form());
      expect(summary(env, 'project')).toBe('All projects');
      expect(summary(env, 'type')).toBe('All types');
      expect(onlyGets(env.windowObject)).toBe(true);
    });
  });
});
