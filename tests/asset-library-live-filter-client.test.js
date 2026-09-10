import { describe, expect, it, vi } from 'vitest';
import {
  beginAssetViewerDefaultsLiveRefresh,
  enhanceAssetLibraryLiveFiltering,
  enhancePageDefaultsFetchSave,
  refreshAssetViewerLiveRegion,
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

function makePage(projectId = null, { dialogOpen = false } = {}) {
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
  const dialog = makeNode({
    tagName: 'dialog',
    attrs: { id: 'asset-viewer-filter-dialog', 'data-app-dialog': '' },
  });
  dialog.open = dialogOpen;
  dialog.appendChild(form);
  region.appendChild(status);
  const preview = makeNode({
    tagName: 'a',
    attrs: { href: '/assets/7', 'data-project-assets-preview-id': '7' },
  });
  region.appendChild(preview);
  document.appendChild(region);
  document.appendChild(dialog);

  return {
    document,
    region,
    dialog,
    form,
    summary,
    all,
    alpha,
    search,
    currentSummary,
    preview,
  };
}

function addDialogReset(page, href) {
  const form = makeNode({
    tagName: 'form',
    attrs: { class: 'asset-viewer-filter-reset', method: 'get', action: href },
  });
  const reset = makeNode({ tagName: 'button', attrs: { type: 'submit', 'data-asset-library-reset': '' } });
  reset.form = form;
  form.appendChild(reset);
  page.dialog.appendChild(form);
  return reset;
}

function addViewLink(page, href) {
  const nav = makeNode({ tagName: 'nav', attrs: { class: 'view-switcher' } });
  const link = makeNode({ tagName: 'a', attrs: { href } });
  nav.appendChild(link);
  page.region.appendChild(nav);
  return link;
}

function addAssetViewerDefaults(page) {
  const dialog = makeNode({
    tagName: 'dialog',
    attrs: { id: 'asset-viewer-defaults-dialog', 'data-app-dialog': '' },
  });
  const form = makeNode({
    tagName: 'form',
    attrs: {
      id: 'asset-viewer-defaults-form',
      action: '/assets/defaults',
      method: 'post',
      'data-dialog-async': 'false',
      'data-asset-viewer-defaults-autosave': '',
    },
  });
  const csrf = makeNode({ tagName: 'input', attrs: { name: '_csrf', value: 'csrf-token' } });
  const returnTo = makeNode({ tagName: 'input', attrs: { name: 'returnTo', value: '/assets' } });
  const view = makeNode({
    tagName: 'select',
    attrs: { name: 'view', value: 'grid', 'data-autosubmit': 'fetch' },
  });
  const sort = makeNode({
    tagName: 'select',
    attrs: { name: 'sort', value: 'filename', 'data-autosubmit': 'fetch' },
  });
  const extension = makeNode({
    tagName: 'select',
    attrs: { name: 'extension', multiple: '', 'data-autosubmit': 'fetch' },
  });
  extension.values = ['png', 'jpg'];
  const tag = makeNode({
    tagName: 'select',
    attrs: { name: 'tag', multiple: '', 'data-autosubmit': 'fetch' },
  });
  tag.values = ['1', '2'];
  const status = makeNode({ attrs: { 'data-settings-fetch-save-status': '' } });
  for (const control of [csrf, returnTo, view, sort, extension, tag]) {
    control.form = form;
    form.appendChild(control);
  }
  form.appendChild(status);
  dialog.appendChild(form);
  page.document.appendChild(dialog);
  return { dialog, form, view, sort, extension, tag, status };
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
          .flatMap((field) => (Array.isArray(field.values) ? field.values : [field.value])
            .map((value) => [field.name, value]));
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
    listeners: {},
    addEventListener(type, listener) { this.listeners[type] = listener; },
  };
  document.defaultView = windowObject;
  return windowObject;
}

async function flush() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

describe('Asset Viewer Project live filtering enhancement', () => {
  it('submits one request, replaces and re-enhances the selector, resets search, and restores focus', async () => {
    const initial = makePage(null, { dialogOpen: true });
    const next = makePage('1');
    const reset = addDialogReset(initial, '/assets?resetFilters=1&view=grid');
    addDialogReset(next, '/assets?resetFilters=1&view=grid');
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
    expect(initial.document.querySelector('#asset-filters')).toBe(initial.form);
    expect(initial.document.querySelector('#asset-viewer-filter-dialog')).toBe(initial.dialog);
    expect(initial.dialog.open).toBe(true);
    expect(next.currentSummary.textContent).toBe('Alpha Project');
    expect(next.search.value).toBe('');
    expect(next.summary.focused).toBe(true);
    expect(reset.form.getAttribute('action')).toBe('/assets?resetFilters=1&view=grid');

    enhanceAssetLibraryLiveFiltering(next.region);
    enhanceAssetLibraryLiveFiltering(next.region);
    expect(initial.form.listeners.filter(({ type }) => type === 'change')).toHaveLength(1);
  });

  it.each([
    ['Grid', 'List', 'grid', 'list'],
    ['List', 'Grid', 'list', 'grid'],
  ])('reconciles the dialog Reset action after live %s to %s navigation', async (
    _initialLabel,
    _nextLabel,
    initialView,
    nextView,
  ) => {
    const initial = makePage('1', { dialogOpen: true });
    const next = makePage('1');
    const resetResult = makePage();
    const reset = addDialogReset(initial, `/assets?resetFilters=1&view=${initialView}`);
    addDialogReset(next, `/assets?resetFilters=1&view=${nextView}`);
    addDialogReset(resetResult, `/assets?resetFilters=1&view=${nextView}`);
    const viewLink = addViewLink(initial, `/assets?view=${nextView}`);
    const pages = new Map([
      ['view-result', next.document],
      ['reset-result', resetResult.document],
    ]);
    const windowObject = makeWindow(initial.document, pages);
    windowObject.fetch
      .mockResolvedValueOnce({
        ok: true,
        url: `http://creatorcrate.test/assets?view=${nextView}`,
        text: vi.fn(async () => 'view-result'),
      })
      .mockResolvedValueOnce({
        ok: true,
        url: `http://creatorcrate.test/assets?view=${nextView}`,
        text: vi.fn(async () => 'reset-result'),
      });

    enhanceAssetLibraryLiveFiltering(initial.document);
    viewLink.dispatch('click', { button: 0 });
    await flush();

    expect(reset.form.getAttribute('action')).toBe(`/assets?resetFilters=1&view=${nextView}`);
    expect(initial.document.querySelector('#asset-viewer-filter-dialog')).toBe(initial.dialog);
    expect(initial.dialog.open).toBe(true);

    reset.dispatch('click', { button: 0 });
    await flush();

    expect(windowObject.fetch.mock.calls[1][0])
      .toBe(`http://creatorcrate.test/assets?resetFilters=1&view=${nextView}`);
    expect(initial.document.querySelector('#asset-viewer-filter-dialog')).toBe(initial.dialog);
    expect(reset.listeners.filter(({ type }) => type === 'click')).toHaveLength(1);
  });

  it('keeps Reset server-authoritative across repeated live replacements and Back/Forward', async () => {
    const initial = makePage('1', { dialogOpen: true });
    const listPage = makePage('1');
    const filteredListPage = makePage('1');
    const restoredGridPage = makePage('1');
    const resetResult = makePage();
    const reset = addDialogReset(initial, '/assets?resetFilters=1&view=grid');
    addDialogReset(listPage, '/assets?resetFilters=1&view=list');
    addDialogReset(filteredListPage, '/assets?resetFilters=1&view=list');
    addDialogReset(restoredGridPage, '/assets?resetFilters=1&view=grid');
    addDialogReset(resetResult, '/assets?resetFilters=1&view=grid');
    const viewLink = addViewLink(initial, '/assets?view=list');
    const pages = new Map([
      ['list', listPage.document],
      ['filtered-list', filteredListPage.document],
      ['restored-grid', restoredGridPage.document],
      ['reset-grid', resetResult.document],
    ]);
    const windowObject = makeWindow(initial.document, pages);
    windowObject.fetch
      .mockResolvedValueOnce({ ok: true, url: 'http://creatorcrate.test/assets?view=list', text: async () => 'list' })
      .mockResolvedValueOnce({ ok: true, url: 'http://creatorcrate.test/assets?project=1&view=list', text: async () => 'filtered-list' })
      .mockResolvedValueOnce({ ok: true, url: 'http://creatorcrate.test/assets?view=grid', text: async () => 'restored-grid' })
      .mockResolvedValueOnce({ ok: true, url: 'http://creatorcrate.test/assets?view=grid', text: async () => 'reset-grid' });

    enhanceAssetLibraryLiveFiltering(initial.document);
    viewLink.dispatch('click', { button: 0 });
    await flush();
    expect(reset.form.getAttribute('action')).toBe('/assets?resetFilters=1&view=list');

    initial.form.querySelector('input[name="project"][value="1"]').dispatch('change');
    await flush();
    expect(reset.form.getAttribute('action')).toBe('/assets?resetFilters=1&view=list');
    expect(initial.document.querySelector('#asset-filters')).toBe(initial.form);

    windowObject.location.href = 'http://creatorcrate.test/assets?view=grid';
    windowObject.listeners.popstate();
    await flush();
    expect(reset.form.getAttribute('action')).toBe('/assets?resetFilters=1&view=grid');

    reset.dispatch('click', { button: 0 });
    await flush();
    expect(windowObject.fetch.mock.calls[3][0])
      .toBe('http://creatorcrate.test/assets?resetFilters=1&view=grid');
    expect(initial.document.querySelector('#asset-viewer-filter-dialog')).toBe(initial.dialog);
    expect(initial.dialog.open).toBe(true);
    expect(reset.listeners.filter(({ type }) => type === 'click')).toHaveLength(1);
  });

  it.each(['grid', 'list'])('WP3 live Reset records final canonical URL for %s', async (view) => {
    const initial = makePage('1', { dialogOpen: true });
    const next = makePage();
    const pages = new Map([['reset', next.document]]);
    const windowObject = makeWindow(initial.document, pages);
    windowObject.fetch.mockResolvedValue({
      ok: true,
      url: 'http://creatorcrate.test/assets?category=art&sort=project&order=desc&pageSize=50&view=' + view,
      text: vi.fn(async () => 'reset'),
    });
    const reset = addDialogReset(initial, '/assets?resetFilters=1&view=' + view);

    enhanceAssetLibraryLiveFiltering(initial.document);
    const event = reset.dispatch('click', { button: 0 });
    await flush();

    expect(event.defaultPrevented).toBe(true);
    expect(windowObject.fetch).toHaveBeenCalledWith(
      'http://creatorcrate.test/assets?resetFilters=1&view=' + view,
      expect.objectContaining({ method: 'GET', headers: { Accept: 'text/html' } }),
    );
    expect(initial.document.querySelector('[data-asset-library-live-region]')).toBe(next.region);
    expect(initial.document.querySelector('#asset-filters')).toBe(initial.form);
    expect(initial.document.querySelector('#asset-viewer-filter-dialog')).toBe(initial.dialog);
    expect(initial.dialog.open).toBe(true);
    expect(initial.form.querySelector('input[name="project"]:checked')?.value).toBe('');
    expect(reset.listeners.filter(({ type }) => type === 'click')).toHaveLength(1);
    expect(windowObject.history.pushes).toEqual([
      expect.objectContaining({ url: 'http://creatorcrate.test/assets?category=art&sort=project&order=desc&pageSize=50&view=' + view }),
    ]);
    expect(initial.form.submit).not.toHaveBeenCalled();
    const finalUrl = windowObject.location.href;
    for (const url of ['http://creatorcrate.test/assets?project=1', finalUrl]) {
      const revisited = makePage(url.includes('project=1') ? '1' : '');
      pages.set('revisited', revisited.document);
      windowObject.location.href = url;
      windowObject.fetch.mockResolvedValue({ ok: true, url, text: vi.fn(async () => 'revisited') });
      windowObject.listeners.popstate();
      await flush();
      expect(windowObject.fetch).toHaveBeenLastCalledWith(url, expect.objectContaining({ method: 'GET' }));
      expect(initial.document.querySelector('[data-asset-library-live-region]')).toBe(revisited.region);
      expect(initial.document.querySelector('#asset-filters')).toBe(initial.form);
      expect(initial.dialog.open).toBe(true);
      expect(windowObject.history.pushes).toHaveLength(1);
    }
  });

  it('re-binds replaced preview links to the existing slideshow', async () => {
    const initial = makePage();
    const next = makePage('1');
    const openSingleById = vi.fn(() => true);
    const scaffold = makeNode({ attrs: { 'data-slideshow-scaffold': '' } });
    scaffold.__creatorCrateSlideshowState = { openSingleById };
    initial.document.appendChild(scaffold);

    const pages = new Map([['filtered', next.document]]);
    const windowObject = makeWindow(initial.document, pages);
    windowObject.fetch.mockResolvedValue({
      ok: true,
      url: 'http://creatorcrate.test/assets?project=1',
      text: vi.fn(async () => 'filtered'),
    });

    expect(enhanceAssetLibraryLiveFiltering(initial.document)).toBe(1);
    initial.all.checked = false;
    initial.alpha.checked = true;
    initial.alpha.dispatch('change');
    await flush();

    const event = next.preview.dispatch('click', { button: 0 });
    expect(openSingleById).toHaveBeenCalledWith('7', next.preview);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe('Asset Viewer defaults autosave integration', () => {
  function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  }

  function defaultsResponse({
    ok = true,
    redirected = true,
    url = 'http://creatorcrate.test/assets?tag=1&tag=2&extension=jpg&extension=png&view=grid&notice=asset_viewer_defaults_saved',
  } = {}) {
    return { ok, redirected, url, text: async () => '' };
  }

  function enhanceDefaults(page) {
    return enhancePageDefaultsFetchSave(page.document, {
      formSelector: '#asset-viewer-defaults-form',
      markerAttribute: 'data-asset-viewer-defaults-autosave',
      beginRefresh: beginAssetViewerDefaultsLiveRefresh,
      refresh: refreshAssetViewerLiveRegion,
      refreshFailureMessage: 'Settings saved, but Asset Viewer could not refresh. Refresh the page to see the saved defaults.',
    });
  }

  function installDefaultsGlobals(windowObject, fetch) {
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('FormData', windowObject.FormData);
    vi.stubGlobal('URLSearchParams', URLSearchParams);
  }

  it('serializes complete snapshots, keeps only the latest queued values, and refreshes after persistence', async () => {
    const initial = makePage();
    const defaults = addAssetViewerDefaults(initial);
    const refreshed = makePage();
    const pages = new Map([['refreshed', refreshed.document]]);
    const windowObject = makeWindow(initial.document, pages);
    windowObject.fetch.mockResolvedValue({
      ok: true,
      url: 'http://creatorcrate.test/assets?view=grid&sort=title&notice=asset_viewer_defaults_saved',
      text: async () => 'refreshed',
    });
    const first = deferred();
    const second = deferred();
    const saveFetch = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    installDefaultsGlobals(windowObject, saveFetch);

    try {
      enhanceAssetLibraryLiveFiltering(initial.document);
      expect(enhanceDefaults(initial)).toBe(4);
      expect(enhanceDefaults(initial)).toBe(0);

      defaults.view.value = 'list';
      defaults.view.dispatch('change');
      await flush();
      expect(saveFetch).toHaveBeenCalledTimes(1);
      expect(Object.fromEntries(saveFetch.mock.calls[0][1].body.entries())).toEqual({
        _csrf: 'csrf-token', returnTo: '/assets', view: 'list', sort: 'filename', extension: 'jpg', tag: '2',
      });
      expect(saveFetch.mock.calls[0][1].body.getAll('extension')).toEqual(['png', 'jpg']);
      expect(saveFetch.mock.calls[0][1].body.getAll('tag')).toEqual(['1', '2']);

      defaults.sort.value = 'updated';
      defaults.sort.dispatch('change');
      defaults.view.value = 'grid';
      defaults.view.dispatch('change');
      expect(saveFetch).toHaveBeenCalledTimes(1);

      first.resolve(defaultsResponse({ url: 'http://creatorcrate.test/assets?view=list&sort=filename' }));
      await flush();
      expect(saveFetch).toHaveBeenCalledTimes(2);
      expect(Object.fromEntries(saveFetch.mock.calls[1][1].body.entries())).toEqual({
        _csrf: 'csrf-token', returnTo: '/assets', view: 'grid', sort: 'updated', extension: 'jpg', tag: '2',
      });
      expect(saveFetch.mock.calls[1][1].body.getAll('extension')).toEqual(['png', 'jpg']);
      expect(saveFetch.mock.calls[1][1].body.getAll('tag')).toEqual(['1', '2']);

      second.resolve(defaultsResponse());
      await flush();
      expect(windowObject.fetch).toHaveBeenCalledTimes(1);
      expect(windowObject.fetch.mock.calls[0][0])
        .toBe('http://creatorcrate.test/assets?tag=1&tag=2&extension=jpg&extension=png&view=grid&notice=asset_viewer_defaults_saved');
      expect(initial.document.querySelector('[data-asset-library-live-region]')).toBe(refreshed.region);
      expect(defaults.status.textContent).toBe('Settings saved.');
      expect(defaults.view.value).toBe('grid');
      expect(defaults.sort.value).toBe('updated');
      expect(defaults.view.listeners.filter(({ type }) => type === 'change')).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps edited controls on persistence failure and distinguishes a later refresh failure', async () => {
    const initial = makePage();
    const defaults = addAssetViewerDefaults(initial);
    const pages = new Map();
    const windowObject = makeWindow(initial.document, pages);
    const saveFetch = vi.fn()
      .mockResolvedValueOnce(defaultsResponse({ ok: false, redirected: false }))
      .mockResolvedValueOnce(defaultsResponse());
    installDefaultsGlobals(windowObject, saveFetch);

    try {
      enhanceAssetLibraryLiveFiltering(initial.document);
      enhanceDefaults(initial);

      defaults.view.value = 'list';
      defaults.view.dispatch('change');
      await flush();
      expect(defaults.view.value).toBe('list');
      expect(defaults.status.textContent).toBe('Could not save settings. Your current changes were kept.');
      expect(defaults.form.getAttribute('data-settings-fetch-save-state')).toBe('error');
      expect(windowObject.fetch).not.toHaveBeenCalled();

      windowObject.fetch.mockRejectedValueOnce(new Error('refresh failed'));
      defaults.sort.value = 'updated';
      defaults.sort.dispatch('change');
      await flush();
      expect(defaults.view.value).toBe('list');
      expect(defaults.sort.value).toBe('updated');
      expect(defaults.status.textContent)
        .toBe('Settings saved, but Asset Viewer could not refresh. Refresh the page to see the saved defaults.');
      expect(defaults.form.getAttribute('data-settings-fetch-save-state')).toBe('saved-refresh-error');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not let a stale defaults refresh override newer Asset Viewer filter intent', async () => {
    const initial = makePage();
    const defaults = addAssetViewerDefaults(initial);
    const filtered = makePage('1');
    const pages = new Map([['filtered', filtered.document]]);
    const windowObject = makeWindow(initial.document, pages);
    windowObject.fetch.mockResolvedValue({
      ok: true,
      url: 'http://creatorcrate.test/assets?project=1',
      text: async () => 'filtered',
    });
    const pending = deferred();
    const saveFetch = vi.fn(() => pending.promise);
    installDefaultsGlobals(windowObject, saveFetch);

    try {
      enhanceAssetLibraryLiveFiltering(initial.document);
      enhanceDefaults(initial);
      defaults.view.value = 'list';
      defaults.view.dispatch('change');
      await flush();

      initial.all.checked = false;
      initial.alpha.checked = true;
      initial.alpha.dispatch('change');
      await flush();
      expect(windowObject.fetch).toHaveBeenCalledTimes(1);
      expect(initial.document.querySelector('[data-asset-library-live-region]')).toBe(filtered.region);

      pending.resolve(defaultsResponse());
      await flush();
      expect(windowObject.fetch).toHaveBeenCalledTimes(1);
      expect(windowObject.location.href).toBe('http://creatorcrate.test/assets?project=1');
      expect(defaults.status.textContent).toBe('Settings saved.');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
