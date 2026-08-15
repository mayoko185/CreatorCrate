import { describe, expect, it, vi } from 'vitest';
import { enhanceAssetLibraryLiveFiltering } from '../src/static/creatorcrate.js';

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
    hidden: false,
    open: false,
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
    getAttribute(name) {
      return attributes.has(name) ? attributes.get(name) : null;
    },
    hasAttribute(name) {
      return attributes.has(name);
    },
    removeAttribute(name) {
      attributes.delete(name);
      if (name === 'hidden') this.hidden = false;
      if (name === 'disabled') this.disabled = false;
      if (name.startsWith('data-')) {
        delete this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())];
      }
    },
    matches(selector) {
      return selector.split(',').some((part) => {
        const candidate = part.trim();
        const checkedOnly = candidate.includes(':checked');
        const excludesDisabled = candidate.includes(':not(:disabled)');
        const disabledOnly = candidate.includes(':disabled') && !excludesDisabled;
        if (candidate.includes(':') && !checkedOnly && !excludesDisabled && !disabledOnly) return false;
        if (checkedOnly && !this.checked) return false;
        if (excludesDisabled && this.disabled) return false;
        if (disabledOnly && !this.disabled) return false;
        const selectorWithoutState = candidate
          .replace(':checked', '')
          .replace(':not(:disabled)', '')
          .replace(':disabled', '');
        const parts = selectorWithoutState.split(/\s+/);
        const target = parts.pop();
        const idMatch = target.match(/#([\w-]+)/);
        if (idMatch && this.id !== idMatch[1]) return false;
        const tag = target.match(/^[a-z][\w-]*/i)?.[0];
        if (tag && this.tagName !== tag.toUpperCase()) return false;
        const classNames = [...target.matchAll(/\.([\w-]+)/g)].map((match) => match[1]);
        if (classNames.some((name) => !String(this.getAttribute('class') || '').split(/\s+/).includes(name))) return false;
        const attrsInSelector = [...target.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)];
        if (!attrsInSelector.every(([, name, expected]) => {
          const actual = this.getAttribute(name);
          return actual !== null && (expected === undefined || actual === expected);
        })) return false;
        if (parts.length === 0) return true;
        let ancestor = this.parentNode;
        const parentSelector = parts.join(' ');
        while (ancestor) {
          if (ancestor.matches?.(parentSelector)) return true;
          ancestor = ancestor.parentNode;
        }
        return false;
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
    replaceWith(next) {
      const parent = this.parentNode;
      const index = parent?.children?.indexOf(this) ?? -1;
      if (index < 0) return;
      parent.children.splice(index, 1, next);
      this.parentNode = null;
      next.parentNode = parent;
      next.parentElement = parent;
      const adopt = (current) => {
        current.ownerDocument = parent.ownerDocument || parent;
        current.children.forEach(adopt);
      };
      adopt(next);
    },
    contains(candidate) {
      let current = candidate;
      while (current) {
        if (current === this) return true;
        current = current.parentNode;
      }
      return false;
    },
    addEventListener(type, handler) {
      listeners.push({ type, handler });
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
    focus() {
      this.focused = true;
      if (this.ownerDocument) this.ownerDocument.activeElement = this;
    },
  };

  Object.entries(attrs).forEach(([name, rawValue]) => node.setAttribute(name, rawValue));
  if (checked) node.checked = true;
  return node;
}

function addProjectOption(optionList, { id, label, value, checked }) {
  const option = makeNode({ attrs: { class: 'asset-filter-multiselect-option asset-project-filter-option' } });
  const labelNode = makeNode({ tagName: 'label' });
  const input = makeNode({
    tagName: 'input',
    attrs: { id, name: 'project', type: 'radio', value },
    value,
    checked,
  });
  input.focus = () => {
    input.focused = true;
    input.ownerDocument.activeElement = input;
  };
  labelNode.textContent = label;
  labelNode.appendChild(input);
  option.appendChild(labelNode);
  optionList.appendChild(option);
  return input;
}

function makePage(projectId = null) {
  const document = makeNode({ tagName: 'document' });
  document.nodeType = 9;
  document.ownerDocument = document;
  document.activeElement = null;

  const region = makeNode({ attrs: { 'data-asset-library-live-region': '' } });
  const status = makeNode({ attrs: { 'data-asset-library-live-status': '' } });
  const form = makeNode({
    tagName: 'form',
    attrs: { id: 'asset-filters', action: '/assets', method: 'get' },
  });
  form.submit = vi.fn();

  const dropdown = makeNode({
    tagName: 'details',
    attrs: {
      id: 'asset-project-filter',
      class: 'asset-filter-multiselect asset-filter-multiselect--sized cc-dropdown asset-project-filter-disclosure',
      'data-cc-dropdown': '',
      'data-cc-dropdown-mode': 'single',
      'data-cc-dropdown-searchable': '',
      'data-cc-dropdown-type': 'searchable-single',
    },
  });
  const summary = makeNode({
    tagName: 'summary',
    attrs: {
      id: 'asset-project-filter-trigger',
      'aria-controls': 'asset-project-filter-options',
      'aria-label': 'Project filter: All projects',
    },
  });
  const currentSummary = makeNode({ attrs: { 'data-cc-dropdown-summary-current': '' } });
  currentSummary.textContent = 'All projects';
  summary.appendChild(currentSummary);
  const panel = makeNode({
    attrs: {
      id: 'asset-project-filter-options',
      class: 'asset-filter-multiselect-panel asset-project-filter-panel',
    },
  });
  const search = makeNode({
    tagName: 'input',
    attrs: {
      id: 'asset-project-filter-search',
      class: 'asset-project-filter-search',
      type: 'search',
      'data-cc-dropdown-search': '',
    },
  });
  const optionList = makeNode({
    attrs: {
      id: 'asset-project-filter-option-list',
      class: 'asset-project-filter-option-list',
      'data-cc-dropdown-option-list': '',
    },
  });
  const all = addProjectOption(optionList, {
    id: 'asset-project-option-all',
    label: 'All projects',
    value: '',
    checked: projectId === null,
  });
  const alpha = addProjectOption(optionList, {
    id: '1',
    label: 'Alpha Project',
    value: '1',
    checked: projectId === '1',
  });
  addProjectOption(optionList, {
    id: '2',
    label: 'Beta Project',
    value: '2',
    checked: projectId === '2',
  });
  const noResults = makeNode({ attrs: { 'data-cc-dropdown-no-results': '', hidden: '' } });
  panel.appendChild(search);
  panel.appendChild(optionList);
  panel.appendChild(noResults);
  dropdown.appendChild(summary);
  dropdown.appendChild(panel);
  form.appendChild(dropdown);
  region.appendChild(status);
  region.appendChild(form);
  document.appendChild(region);

  return { document, region, form, summary, all, alpha, search, currentSummary };
}

function makeWindow(document, pages) {
  const location = {
    href: 'http://creatorcrate.test/assets',
    pathname: '/assets',
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
      parseFromString(text) { return pages.get(text); }
    },
    history: {
      pushes: [],
      pushState(state, title, url) {
        this.pushes.push({ state, title, url });
        setLocation(url);
      },
      replaceState() {},
    },
    addEventListener() {},
  };
  document.defaultView = windowObject;
  return windowObject;
}

async function flush() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

describe('Asset Viewer Project live filtering enhancement', () => {
  it('submits one request, replaces and re-enhances the selector, resets search, and restores focus', async () => {
    const initial = makePage();
    const next = makePage('1');
    const pages = new Map([['filtered', next.document]]);
    const windowObject = makeWindow(initial.document, pages);
    const responseUrl = 'http://creatorcrate.test/assets?project=1';
    windowObject.fetch.mockResolvedValue({
      ok: true,
      url: responseUrl,
      text: vi.fn(async () => 'filtered'),
    });

    expect(enhanceAssetLibraryLiveFiltering(initial.document)).toBe(1);
    expect(enhanceAssetLibraryLiveFiltering(initial.document)).toBe(1);

    initial.all.checked = false;
    initial.alpha.checked = true;
    initial.search.value = 'stale search';
    initial.document.activeElement = initial.summary;
    initial.alpha.dispatch('change');
    await flush();

    expect(windowObject.fetch).toHaveBeenCalledTimes(1);
    const requested = new URL(windowObject.fetch.mock.calls[0][0]);
    expect(requested.pathname).toBe('/assets');
    expect(requested.searchParams.get('project')).toBe('1');
    expect(requested.searchParams.has('page')).toBe(false);
    expect(windowObject.history.pushes).toHaveLength(1);
    expect(windowObject.history.pushes[0].url).toBe(responseUrl);
    expect(initial.document.querySelector('[data-asset-library-live-region]')).toBe(next.region);
    expect(next.currentSummary.textContent).toBe('Alpha Project');
    expect(next.search.value).toBe('');
    expect(next.summary.focused).toBe(true);

    enhanceAssetLibraryLiveFiltering(next.region);
    enhanceAssetLibraryLiveFiltering(next.region);
    expect(next.form.listeners.filter(({ type }) => type === 'change')).toHaveLength(1);
  });
});
