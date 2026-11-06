import { describe, it, expect, vi, beforeEach } from 'vitest';

// WP10A2: the Edit Asset dialog's Project/Book primary-image forms submit in
// place (asset-edit-dialog.js) and the Asset detail refresh installs the
// primary-image regions (asset-viewer-refresh.js). The shared dialog binder and
// dropdown presentation are stand-ins, so the controller's own decisions are
// observable: which requests it sends, what it installs, and what it reports.
// The DOM is a purpose-built shim (no jsdom in this project), modeled on the
// WP10A1 tag-save suite.

const dialogs = vi.hoisted(() => ({ freezes: 0, restores: 0, frozen: 0 }));
vi.mock('../src/static/client/app-dialogs.js', () => ({
  freezeAppDialog: () => {
    dialogs.freezes += 1;
    dialogs.frozen += 1;
    return () => { dialogs.restores += 1; dialogs.frozen -= 1; };
  },
}));
const dropdowns = vi.hoisted(() => ({ initialized: [] }));
vi.mock('../src/static/client/dropdowns.js', () => ({
  initializeCreatorCrateDropdown: (node) => { dropdowns.initialized.push(node); },
  syncCreatorCrateDropdownFromNative: () => {},
  updateAssetViewerFilterDisclosureState: () => {},
}));

const { enhanceAssetEditDialog } = await import('../src/static/client/asset-edit-dialog.js');
const { refreshAssetViewer, assetViewerPrimaryImageState } = await import('../src/static/client/asset-viewer-refresh.js');

// ---------------------------------------------------------------- DOM shim --

function parseSelector(selector) {
  const TOKEN = /#[\w-]+|\.[\w-]+|\[[\w-]+(?:="[^"]*")?\]/g;
  const match = selector.trim().match(/^([a-z][a-z0-9]*)?((?:#[\w-]+|\.[\w-]+|\[[\w-]+(?:="[^"]*")?\])*)$/i);
  if (!match) throw new Error(`Unsupported selector ${selector}`);
  const tokens = (match[2].match(TOKEN) || []).map((token) => {
    if (token.startsWith('#')) return { kind: 'id', value: token.slice(1) };
    if (token.startsWith('.')) return { kind: 'class', value: token.slice(1) };
    const attr = token.slice(1, -1).match(/^([\w-]+)(?:="([^"]*)")?$/);
    return { kind: 'attr', name: attr[1], value: attr[2] };
  });
  return { tag: match[1]?.toUpperCase() || null, tokens };
}

class FakeNode {
  constructor(tagName, attributes = {}) {
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map(Object.entries(attributes).map(([key, value]) => [key, String(value)]));
    this.childNodes = [];
    this.parentNode = null;
    this.listeners = new Map();
    this.ownText = '';
    this.checked = false;
    this.selectedValue = null;
  }

  get ownerDocument() { return this.root()?.document || null; }
  root() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node.isDocumentRoot ? node : null;
  }
  get isConnected() { return Boolean(this.root()?.isLive); }
  get id() { return this.getAttribute('id') || ''; }
  get value() {
    if (this.tagName === 'SELECT') return this.selectedValue ?? this.querySelector('option')?.value ?? '';
    return this.attributes.has('value') ? this.getAttribute('value') : '';
  }
  set value(next) {
    if (this.tagName === 'SELECT') this.selectedValue = String(next);
    else this.attributes.set('value', String(next));
  }
  get selectedOptions() { return this.querySelectorAll('option').filter((option) => option.value === this.value); }
  get type() { return this.getAttribute('type') || (this.tagName === 'BUTTON' ? 'submit' : ''); }
  set type(next) { this.attributes.set('type', String(next)); }
  set className(next) { this.attributes.set('class', String(next)); }
  get name() { return this.getAttribute('name') || ''; }

  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }

  appendChild(child) {
    child.parentNode?.removeChildNode(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  removeChildNode(child) {
    this.childNodes = this.childNodes.filter((node) => node !== child);
    child.parentNode = null;
  }
  remove() { this.parentNode?.removeChildNode(this); }
  replaceChildren(...nodes) {
    [...this.childNodes].forEach((node) => this.removeChildNode(node));
    this.ownText = '';
    nodes.forEach((node) => this.appendChild(node));
  }
  contains(node) {
    for (let current = node; current; current = current.parentNode) if (current === this) return true;
    return false;
  }

  get textContent() { return this.ownText + this.childNodes.map((node) => node.textContent).join(''); }
  set textContent(text) {
    [...this.childNodes].forEach((node) => this.removeChildNode(node));
    this.ownText = String(text);
  }

  matches(selector) {
    const { tag, tokens } = parseSelector(selector);
    if (tag && this.tagName !== tag) return false;
    return tokens.every((token) => {
      if (token.kind === 'id') return this.getAttribute('id') === token.value;
      if (token.kind === 'class') return (this.getAttribute('class') || '').split(/\s+/).includes(token.value);
      if (!this.hasAttribute(token.name)) return false;
      return token.value === undefined || this.getAttribute(token.name) === token.value;
    });
  }
  descendants() { return this.childNodes.flatMap((node) => [node, ...node.descendants()]); }
  querySelectorAll(selector) { return this.descendants().filter((node) => node.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) {
    for (let node = this; node && !node.isDocumentRoot; node = node.parentNode) if (node.matches(selector)) return node;
    return null;
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  dispatch(type, init = {}) {
    const event = {
      type, target: this, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      ...init,
    };
    for (let node = this; node; node = node.parentNode) {
      (node.listeners.get(type) || []).forEach((listener) => listener(event));
    }
    return event;
  }
  listenerCount(type) { return (this.listeners.get(type) || []).length; }
  focus() { const document = this.ownerDocument; if (document) document.activeElement = this; }
  click() { this.dispatch('click'); }
  requestSubmit() {
    const event = this.dispatch('submit');
    if (!event.defaultPrevented) this.ownerDocument.nativeSubmits.push(this);
  }
  reset() {
    this.querySelectorAll('input[type="checkbox"]').forEach((input) => { input.checked = input.hasAttribute('checked'); });
    this.querySelectorAll('select').forEach((select) => { select.selectedValue = null; });
  }
  clone() {
    const copy = new FakeNode(this.tagName, Object.fromEntries(this.attributes));
    copy.ownText = this.ownText;
    copy.checked = this.checked;
    copy.selectedValue = this.selectedValue;
    this.childNodes.forEach((child) => copy.appendChild(child.clone()));
    return copy;
  }
}

function h(tag, attributes = {}, ...children) {
  const node = new FakeNode(tag, attributes);
  children.flat().forEach((child) => {
    if (child === null || child === undefined || child === false) return;
    if (typeof child === 'string') node.ownText += child;
    else node.appendChild(child);
  });
  return node;
}

function createDocument(body, { live = true } = {}) {
  const root = new FakeNode('#document');
  root.isDocumentRoot = true;
  root.isLive = live;
  const document = {
    activeElement: null,
    nativeSubmits: [],
    createElement: (tag) => new FakeNode(tag),
    importNode: (node) => node.clone(),
    querySelector: (selector) => root.querySelector(selector),
    querySelectorAll: (selector) => root.querySelectorAll(selector),
    getElementById: (id) => root.querySelector(`#${id}`),
  };
  root.document = document;
  root.appendChild(body);
  document.body = body;
  return document;
}

// ------------------------------------------------------------ page builder --

const PROJECT_ID = 7;
const ASSET_ID = 42;
const BOOKS = [{ id: '11', title: 'First Book' }, { id: '12', title: 'Second Book' }, { id: '13', title: 'Third Book' }];
const csrf = () => h('input', { type: 'hidden', name: '_csrf', value: 'token-1' });
const action = (suffix) => `/projects/${PROJECT_ID}/assets/${ASSET_ID}/${suffix}`;

function projectRegion({ selected, eligible = true, archived = false }) {
  const children = [];
  if (selected || (eligible && !archived)) {
    const body = [h('p', { class: 'asset-action-description' }, 'Choose the image used to represent this project.')];
    if (selected) {
      body.push(h('p', { class: 'asset-primary-image-status' }, 'Currently set as the primary image.'));
      if (!archived) {
        body.push(h('form', { method: 'post', action: action('primary-image/remove'), class: 'asset-action-form asset-primary-image-remove-form' },
          csrf(), h('div', {}, h('button', { class: 'button button-danger', type: 'submit' }, 'Remove primary image'))));
      }
    } else {
      body.push(h('form', { method: 'post', action: action('primary-image'), class: 'asset-action-form asset-primary-image-set-form' },
        csrf(), h('div', {}, h('button', { class: 'button button-primary', type: 'submit' }, 'Set as primary image'))));
    }
    children.push(h('section', { class: 'settings-section asset-edit-dialog-section asset-primary-image-section' },
      h('h3', {}, 'Primary image'), h('div', { class: 'asset-edit-dialog-section-body' }, body)));
  }
  return h('div', {
    class: 'asset-edit-dialog-region',
    'data-asset-viewer-region': 'project-primary-image',
    'data-primary-image-selected': selected ? 'true' : 'false',
  }, children);
}

function bookRegion({ bookIds = [], eligible = true }) {
  const usages = BOOKS.filter((book) => bookIds.includes(book.id));
  const children = [];
  if (eligible || usages.length > 0) {
    const setForm = eligible ? h('form', { method: 'post', action: action('book-primary-image'), class: 'asset-action-form asset-book-primary-image-set-form' },
      csrf(),
      h('details', { 'data-cc-dropdown': '', id: 'book-primary-image-book' },
        h('select', { name: 'bookId', id: 'book-primary-image-book-native', required: '' },
          h('option', { value: '' }, 'Choose a Book'),
          BOOKS.map((book) => h('option', { value: book.id }, book.title)))),
      h('div', {}, h('button', { class: 'button button-primary', type: 'submit' }, 'Set as book primary image'))) : null;
    const usageRegion = h('div', { class: 'asset-edit-dialog-region', 'data-asset-viewer-region': 'book-primary-image-usages' },
      usages.length ? [
        h('p', { class: 'asset-primary-image-status' }, 'Currently used as the primary image for:'),
        h('ul', { class: 'asset-book-primary-image-usage-list' }, usages.map((book) => h('li', {},
          h('strong', {}, book.title),
          h('form', { method: 'post', action: action('book-primary-image/remove'), class: 'asset-action-form asset-book-primary-image-remove-form' },
            csrf(), h('input', { type: 'hidden', name: 'bookId', value: book.id }),
            h('div', {}, h('button', { class: 'button button-danger', type: 'submit', 'aria-label': `Remove book primary image from ${book.title}` }, 'Remove book primary image')))))),
      ] : []);
    children.push(h('section', { class: 'settings-section asset-edit-dialog-section asset-book-primary-image-section' },
      h('h3', {}, 'Book primary image'),
      h('div', { class: 'asset-edit-dialog-section-body' }, setForm, usageRegion)));
  }
  return h('div', {
    class: 'asset-edit-dialog-region',
    'data-asset-viewer-region': 'book-primary-image',
    'data-book-primary-image-book-ids': usages.map((book) => book.id).join(','),
  }, children);
}

function buildPage({ selected = false, bookIds = [], eligible = true, archived = false, savedTagIds = ['1'] } = {}) {
  const figure = h('figure', { class: 'asset-preview-frame' }, h('video', { class: 'asset-preview-video', src: '/clip.webm' }));
  const host = h('div', {
    class: 'asset-preview-viewer',
    'data-asset-viewer-host': '',
    'data-asset-viewer-project-id': PROJECT_ID,
    'data-asset-viewer-asset-id': ASSET_ID,
  }, figure, h('a', { class: 'asset-preview-nav', rel: 'next', href: '/next' }));
  const checkboxes = ['1', '2', '3'].map((id) => {
    const input = h('input', { type: 'checkbox', name: 'tagIds[]', value: id });
    if (savedTagIds.includes(id)) { input.setAttribute('checked', ''); input.checked = true; }
    return input;
  });
  const tagForm = archived ? null : h('form', {
    id: 'asset-edit-form', method: 'post', action: action('tags'),
    'data-confirmed-tag-ids': savedTagIds.join(','), 'data-dialog-form': '', 'data-asset-tags-form': '',
  }, csrf(), h('input', { type: 'hidden', name: 'origin', value: 'asset-edit' }), h('details', { id: 'asset-tags-form', 'data-cc-dropdown': '' }, checkboxes));
  const renameInput = h('input', { type: 'text', id: 'rename-filename', name: 'filename', value: 'hero.png', 'data-confirmed-value': 'hero.png' });
  const moveSelect = h('select', { id: 'move-destination', name: 'destinationCategory', 'data-confirmed-value': 'uncategorized' },
    h('option', { value: 'uncategorized' }, 'Uncategorized'), h('option', { value: '5' }, 'Renders'));
  const close = h('button', { type: 'button', 'data-dialog-close': '' }, 'Close');
  const dialog = h('dialog', { id: 'asset-edit-dialog' },
    close,
    h('div', { class: 'app-dialog-body' },
      tagForm,
      projectRegion({ selected, eligible, archived }),
      bookRegion({ bookIds, eligible }),
      h('form', { class: 'asset-action-form asset-rename-form', method: 'post', action: action('rename') }, renameInput),
      h('form', { class: 'asset-action-form asset-move-form', method: 'post', action: action('move') }, moveSelect)),
    h('div', { class: 'app-dialog-status', 'data-dialog-status': '', role: 'status', 'aria-live': 'polite' }));
  const body = h('body', {},
    h('section', { class: 'asset-preview-section' }, host),
    h('section', { class: 'asset-tags-section' }, h('div', { 'data-asset-viewer-region': 'tags' }, h('p', {}, `tags:${savedTagIds.join(',')}`))),
    dialog);
  return { body, host, figure, dialog, tagForm, renameInput, moveSelect, close };
}

// --------------------------------------------------------------- harness --

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const jsonResponse = (status, payload) => ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(payload) });
const htmlResponse = (html, status = 200) => ({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(html) });

function committed(actionName, extra = {}) {
  return jsonResponse(200, {
    status: 'success', outcome: 'committed', action: actionName, message: 'ok',
    projectId: PROJECT_ID, assetId: ASSET_ID, refreshRequired: true, ...extra,
  });
}

function setup(pageOptions = {}) {
  const page = buildPage(pageOptions);
  const document = createDocument(page.body);
  const requests = [];
  const queue = [];
  const pages = new Map();
  const windowObject = {
    location: { href: `http://creatorcrate.local/projects/${PROJECT_ID}/assets/${ASSET_ID}?category=all` },
    FormData: class {
      constructor(form) {
        this.entries = form.descendants()
          .filter((node) => (node.tagName === 'INPUT' || node.tagName === 'SELECT') && node.name)
          .filter((node) => node.type !== 'checkbox' || node.checked)
          .map((node) => [node.name, node.value]);
      }
    },
    URLSearchParams: class {
      constructor(formData) { this.entries = formData.entries; }
      getAll(name) { return this.entries.filter(([key]) => key === name).map(([, value]) => value); }
      has(name) { return this.entries.some(([key]) => key === name); }
    },
    DOMParser: class {
      parseFromString(html) {
        const build = pages.get(html);
        if (!build) return createDocument(h('body', {}, h('main', {}, 'Sign in')), { live: false });
        return createDocument(build().body, { live: false });
      }
    },
    fetch: vi.fn((url, init) => {
      requests.push({ url, method: init.method, body: init.body, accept: init.headers?.Accept });
      const next = queue.shift();
      if (!next) throw new Error(`Unexpected ${init.method} ${url}`);
      return typeof next === 'function' ? next() : next;
    }),
  };
  document.defaultView = windowObject;
  page.dialog.__creatorCrateAppDialogState = { document, dialog: page.dialog, onClose: null };
  enhanceAssetEditDialog(document);

  const posts = () => requests.filter((request) => request.method === 'POST');
  const gets = () => requests.filter((request) => request.method === 'GET');
  const form = (cls) => page.dialog.querySelector(`form.${cls}`);
  const submit = (cls, index = 0) => page.dialog.querySelectorAll(`form.${cls}`)[index].requestSubmit();
  const status = () => page.dialog.querySelector('[data-dialog-status]');
  const statusText = () => page.dialog.querySelector('[data-asset-primary-image-status-text]')?.textContent || '';
  const tagStatusText = () => page.dialog.querySelector('[data-asset-tags-status-text]')?.textContent || '';
  const retry = () => page.dialog.querySelector('[data-asset-primary-image-retry]');
  const serverPage = (key, options) => { pages.set(key, () => buildPage(options)); return htmlResponse(key); };
  const bookSelect = () => page.dialog.querySelector('select[name="bookId"]');
  const shown = () => assetViewerPrimaryImageState(document);
  return {
    ...page, document, windowObject, requests, queue, posts, gets, form, submit,
    status, statusText, tagStatusText, retry, serverPage, bookSelect, shown,
  };
}

const flush = async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); };

beforeEach(() => {
  dialogs.freezes = 0;
  dialogs.restores = 0;
  dialogs.frozen = 0;
  dropdowns.initialized = [];
});

// ------------------------------------------------------------------ tests --

describe('primary-image actions — local submission', () => {
  it('sets the Project primary image with one JSON POST and installs the saved state in place', async () => {
    const t = setup();
    t.renameInput.value = 'draft-name.png';
    t.moveSelect.value = '5';
    // A kept (unsaved) tag choice: the checkbox differs from the saved baseline.
    t.tagForm.querySelector('input[value="2"]').checked = true;
    const video = t.figure.querySelector('video');
    t.queue.push(committed('primary-image-set', { primaryImage: { projectId: PROJECT_ID, assetId: ASSET_ID } }),
      t.serverPage('selected', { selected: true }));

    t.submit('asset-primary-image-set-form');
    expect(t.form('asset-primary-image-set-form').getAttribute('aria-busy')).toBe('true');
    expect(t.statusText()).toBe('Setting the primary image…');
    expect(dialogs.frozen).toBe(1);
    await flush();

    expect(t.posts()).toHaveLength(1);
    const [post] = t.posts();
    expect(post.url).toBe(action('primary-image'));
    expect(post.accept).toBe('application/json');
    expect(post.body.getAll('_csrf')).toEqual(['token-1']);
    expect(t.gets()).toHaveLength(1);
    expect(t.gets()[0].url).toBe(t.windowObject.location.href);
    expect(t.document.nativeSubmits).toHaveLength(0);
    expect(dialogs.frozen).toBe(0);
    expect(t.statusText()).toBe('The primary image was set.');
    expect(t.status().getAttribute('data-asset-primary-image-state')).toBe('saved');
    expect(t.shown()).toEqual({ projectSelected: true, bookIds: [] });
    expect(t.form('asset-primary-image-remove-form')).not.toBeNull();
    expect(t.form('asset-primary-image-set-form')).toBeNull();
    // Nothing else moved.
    expect(t.document.querySelector('[data-asset-viewer-host]')).toBe(t.host);
    expect(t.figure.querySelector('video')).toBe(video);
    expect(t.renameInput.value).toBe('draft-name.png');
    expect(t.moveSelect.value).toBe('5');
    expect(t.tagForm.querySelector('input[value="2"]').checked).toBe(true);
    expect(t.tagForm.getAttribute('data-confirmed-tag-ids')).toBe('1');
    expect(t.document.querySelector('[data-asset-viewer-region="tags"]').textContent).toBe('tags:1');
    expect(t.dialog.isConnected).toBe(true);
    expect(t.dialog.querySelectorAll('[aria-live]')).toHaveLength(1);
  });

  it('removes the Project primary image and offers Set again', async () => {
    const t = setup({ selected: true });
    t.queue.push(committed('primary-image-removed', { primaryImage: { projectId: PROJECT_ID, assetId: null } }),
      t.serverPage('cleared', { selected: false }));
    t.submit('asset-primary-image-remove-form');
    await flush();
    expect(t.posts().map((post) => post.url)).toEqual([action('primary-image/remove')]);
    expect(t.statusText()).toBe('The primary image was removed.');
    expect(t.shown().projectSelected).toBe(false);
    expect(t.form('asset-primary-image-set-form')).not.toBeNull();
  });

  it('sets a Book primary image, keeps the Set form and its Book choice, and lists the new usage', async () => {
    const t = setup({ bookIds: ['12'] });
    const setForm = t.form('asset-book-primary-image-set-form');
    t.bookSelect().value = '11';
    t.queue.push(committed('book-primary-image-set', { bookId: 11, primaryImage: { bookId: 11, assetId: ASSET_ID } }),
      t.serverPage('two-books', { bookIds: ['11', '12'] }));
    t.submit('asset-book-primary-image-set-form');
    expect(t.statusText()).toBe('Setting the book primary image for “First Book”…');
    await flush();

    expect(t.posts()[0].body.getAll('bookId')).toEqual(['11']);
    expect(t.statusText()).toBe('The book primary image was set for “First Book”.');
    expect(t.form('asset-book-primary-image-set-form')).toBe(setForm);
    expect(t.bookSelect().value).toBe('11');
    expect(t.shown().bookIds).toEqual(['11', '12']);
    expect(t.dialog.querySelectorAll('form.asset-book-primary-image-remove-form')).toHaveLength(2);
    expect(setForm.querySelector('button').hasAttribute('aria-disabled')).toBe(false);
    expect(dropdowns.initialized).toHaveLength(0);
  });

  it('removes one Book usage, keeps the other, and moves focus to the section heading (not another Remove)', async () => {
    const t = setup({ bookIds: ['11', '12'] });
    const removeFirst = t.dialog.querySelectorAll('form.asset-book-primary-image-remove-form')[0];
    removeFirst.querySelector('button').focus();
    t.queue.push(committed('book-primary-image-removed', { bookId: 11, primaryImage: { bookId: 11, assetId: null } }),
      t.serverPage('one-book', { bookIds: ['12'] }));
    removeFirst.requestSubmit();
    expect(t.statusText()).toBe('Removing the book primary image from “First Book”…');
    await flush();

    expect(t.posts()[0].body.getAll('bookId')).toEqual(['11']);
    expect(t.statusText()).toBe('The book primary image was removed from “First Book”.');
    const remaining = t.dialog.querySelectorAll('form.asset-book-primary-image-remove-form');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].querySelector('input[name="bookId"]').value).toBe('12');
    const heading = t.dialog.querySelector('.asset-book-primary-image-section').querySelector('h3');
    expect(t.document.activeElement).toBe(heading);
    expect(heading.getAttribute('tabindex')).toBe('-1');
    expect(t.shown().bookIds).toEqual(['12']);
  });

  it('rebuilds and re-initializes the Book section when it changes shape', async () => {
    // A missing asset keeps only its usages; removing the last one leaves no section.
    const t = setup({ bookIds: ['11'], eligible: false });
    t.queue.push(committed('book-primary-image-removed', { bookId: 11, primaryImage: { bookId: 11, assetId: null } }),
      t.serverPage('gone-section', { bookIds: [], eligible: false }));
    t.submit('asset-book-primary-image-remove-form');
    await flush();
    expect(t.document.querySelector('.asset-book-primary-image-section')).toBeNull();
    expect(t.document.querySelector('[data-asset-viewer-region="book-primary-image"]')).not.toBeNull();
    expect(t.document.activeElement).toBe(null);
  });

  it('falls back to native submission without fetch', () => {
    const t = setup();
    t.windowObject.fetch = undefined;
    t.submit('asset-primary-image-set-form');
    expect(t.document.nativeSubmits).toEqual([t.form('asset-primary-image-set-form')]);
  });

  it('binds once', async () => {
    const t = setup();
    enhanceAssetEditDialog(t.document);
    enhanceAssetEditDialog(t.document);
    // One dialog-level listener each for the primary-image and (WP10A3-A)
    // Rename/Move actions; neither is bound twice.
    expect(t.dialog.listenerCount('submit')).toBe(2);
    t.queue.push(committed('primary-image-set'), t.serverPage('s', { selected: true }));
    t.submit('asset-primary-image-set-form');
    await flush();
    expect(t.posts()).toHaveLength(1);
  });

  // WP10A3-A moved Rename and Move in place; they never reach a primary-image route.
  it('leaves rename and move to the in-place file actions, never to a primary-image POST', async () => {
    const t = setup();
    t.queue.push(jsonResponse(422, { status: 'error', code: 'INVALID_FILENAME', outcome: 'refused', message: 'Enter a valid filename.' }));
    t.dialog.querySelector('form.asset-rename-form').requestSubmit();
    await flush();
    expect(t.document.nativeSubmits).toHaveLength(0);
    expect(t.posts().map((post) => post.url)).toEqual([action('rename')]);
    expect(t.statusText()).toBe('');
  });
});

describe('primary-image actions — exactly one POST', () => {
  it('refuses a repeated submission while the POST is out', async () => {
    const t = setup();
    const post = deferred();
    t.queue.push(() => post.promise);
    t.submit('asset-primary-image-set-form');
    t.submit('asset-primary-image-set-form');
    t.form('asset-primary-image-set-form').requestSubmit();
    t.submit('asset-book-primary-image-set-form');
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.statusText()).toBe('Wait for the current change to finish, then try again.');
    t.queue.push(t.serverPage('s', { selected: true }));
    post.resolve(committed('primary-image-set'));
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.statusText()).toBe('The primary image was set.');
  });

  it('holds only the submitted form while its GET is out; another target proceeds', async () => {
    const t = setup({ bookIds: ['12'] });
    const read = deferred();
    t.queue.push(committed('primary-image-set'), () => read.promise);
    t.submit('asset-primary-image-set-form');
    await flush();
    const setButton = t.form('asset-primary-image-set-form').querySelector('button');
    expect(setButton.getAttribute('aria-disabled')).toBe('true');
    t.submit('asset-primary-image-set-form');
    expect(t.posts()).toHaveLength(1);
    expect(t.statusText()).toBe('The primary image was set. Wait for the primary image details to refresh, then try again.');

    // An independent Book target is not blocked; its POST supersedes the open read.
    t.queue.push(committed('book-primary-image-removed', { bookId: 12, primaryImage: { bookId: 12, assetId: null } }),
      t.serverPage('both', { selected: true, bookIds: [] }));
    t.submit('asset-book-primary-image-remove-form');
    await flush();
    expect(t.posts().map((post) => post.url)).toEqual([action('primary-image'), action('book-primary-image/remove')]);
    // The superseded read arrives late with an old render and installs nothing.
    t.serverPage('old', { selected: false, bookIds: ['12'] });
    read.resolve(htmlResponse('old'));
    await flush();
    expect(t.shown()).toEqual({ projectSelected: true, bookIds: [] });
    expect(t.statusText()).toBe('The primary image was set. The book primary image was removed from “Second Book”.');
    expect(t.form('asset-primary-image-remove-form').querySelector('button').hasAttribute('aria-disabled')).toBe(false);
    expect(t.posts()).toHaveLength(2);
  });

  it('refuses a primary-image change while a tag save is pending, and a tag change while a primary change is', async () => {
    const t = setup();
    const tagPost = deferred();
    t.queue.push(() => tagPost.promise);
    const box = t.tagForm.querySelector('input[value="2"]');
    box.checked = true;
    box.dispatch('change');
    await flush();
    expect(t.posts()).toHaveLength(1);
    t.submit('asset-primary-image-set-form');
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.statusText()).toBe('Wait for the current change to finish, then try again.');
    t.queue.push(t.serverPage('tags12', { savedTagIds: ['1', '2'] }));
    tagPost.resolve(jsonResponse(200, {
      status: 'success', outcome: 'committed', projectId: PROJECT_ID, assetId: ASSET_ID, tagIds: [1, 2], tags: [],
    }));
    await flush();

    const primaryPost = deferred();
    t.queue.push(() => primaryPost.promise);
    t.submit('asset-primary-image-set-form');
    const third = t.tagForm.querySelector('input[value="3"]');
    third.checked = true;
    third.dispatch('change');
    await flush();
    expect(t.posts()).toHaveLength(2);
    expect(third.checked).toBe(false);
    t.queue.push(t.serverPage('sel', { selected: true, savedTagIds: ['1', '2'] }));
    primaryPost.resolve(committed('primary-image-set'));
    await flush();
    expect(t.posts()).toHaveLength(2);
  });
});

describe('primary-image actions — refusals', () => {
  it('reports a stale Remove locally, reads the saved state by GET, and never repeats the POST', async () => {
    const t = setup({ selected: true });
    t.renameInput.value = 'kept.png';
    t.queue.push(jsonResponse(409, {
      status: 'error', code: 'STALE_CLEAR', outcome: 'refused', message: 'The primary image changed before it could be removed.',
    }), t.serverPage('other-selected', { selected: false }));
    t.submit('asset-primary-image-remove-form');
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.gets()).toHaveLength(1);
    expect(t.statusText()).toBe('The primary image changed before it could be removed. Nothing was changed. The saved primary image is shown.');
    expect(t.status().getAttribute('data-asset-primary-image-state')).toBe('error');
    expect(t.form('asset-primary-image-remove-form')).toBeNull();
    expect(t.form('asset-primary-image-set-form')).not.toBeNull();
    expect(t.renameInput.value).toBe('kept.png');
  });

  it('treats CSRF/authentication JSON errors as refusals and an archived refusal installs the read-only state', async () => {
    const t = setup();
    t.queue.push(jsonResponse(409, {
      status: 'error', code: 'PROJECT_ARCHIVED', outcome: 'refused', message: 'This project is archived and read-only.',
    }), t.serverPage('archived', { archived: true, savedTagIds: ['1'] }));
    t.submit('asset-primary-image-set-form');
    await flush();
    expect(t.statusText()).toBe('This project is archived and read-only. Nothing was changed. The saved primary image is shown.');
    expect(t.document.querySelector('.asset-primary-image-section')).toBeNull();

    const u = setup();
    u.queue.push(jsonResponse(403, { status: 'error', message: 'Invalid or missing CSRF token.' }), u.serverPage('same', {}));
    u.submit('asset-primary-image-set-form');
    await flush();
    expect(u.statusText()).toBe('Invalid or missing CSRF token. Nothing was changed. The saved primary image is shown.');
    expect(u.posts()).toHaveLength(1);
  });

  it('holds the forms when the asset is gone', async () => {
    const t = setup();
    t.queue.push(jsonResponse(404, {
      status: 'error', code: 'ASSET_NOT_FOUND', outcome: 'refused', message: 'This asset no longer exists in this project.',
    }), htmlResponse('missing', 404));
    t.submit('asset-primary-image-set-form');
    await flush();
    expect(t.statusText()).toBe('This asset no longer exists in this project. Nothing was changed. This asset can no longer be read. It may have been deleted elsewhere.');
    expect(t.retry()).toBeNull();
    t.submit('asset-primary-image-set-form');
    expect(t.posts()).toHaveLength(1);
    expect(t.statusText()).toBe('This asset no longer exists in this project. Nothing was changed. This asset can no longer be read. It may have been deleted elsewhere.');
  });
});

describe('primary-image actions — failed refresh and uncertain outcomes', () => {
  it('keeps the success, holds the stale form and retries the GET only', async () => {
    const t = setup();
    t.queue.push(committed('primary-image-set'), htmlResponse('failed', 500));
    t.submit('asset-primary-image-set-form');
    await flush();
    expect(t.statusText()).toBe('The primary image was set. The primary image details shown may be out of date.');
    expect(t.retry().textContent).toBe('Retry refresh');
    t.submit('asset-primary-image-set-form');
    expect(t.statusText()).toBe('The primary image was set. The primary image details shown may be out of date. Use Retry refresh before trying again.');
    expect(t.posts()).toHaveLength(1);

    t.queue.push(t.serverPage('fixed', { selected: true }));
    t.retry().click();
    expect(t.statusText()).toBe('Refreshing the primary image details…');
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.gets()).toHaveLength(2);
    expect(t.statusText()).toBe('The primary image was set.');
    expect(t.retry()).toBeNull();
    expect(t.shown().projectSelected).toBe(true);
  });

  it('never resends a lost POST; reports the saved state as observed, not as proof', async () => {
    const t = setup();
    t.queue.push(() => Promise.reject(new TypeError('Failed to fetch')), t.serverPage('selected', { selected: true }));
    t.submit('asset-primary-image-set-form');
    expect(t.statusText()).toBe('Setting the primary image…');
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.statusText()).toBe('The primary image change could not be confirmed. This asset is now the project’s primary image. This is what is saved now; it does not show whether your request ran.');
    expect(t.status().getAttribute('data-asset-primary-image-state')).toBe('uncertain');
  });

  it('treats an unreadable answer, a 5xx unknown and a mismatched Book as unconfirmed; Check again is GET only', async () => {
    const t = setup({ bookIds: [] });
    t.bookSelect().value = '13';
    t.queue.push(
      committed('book-primary-image-set', { bookId: 12 }),
      htmlResponse('failed', 503),
    );
    t.submit('asset-book-primary-image-set-form');
    await flush();
    expect(t.statusText()).toBe('The book primary image change for “Third Book” could not be confirmed. The saved primary image could not be read. Check again before trying again.');
    expect(t.retry().textContent).toBe('Check again');
    t.queue.push(t.serverPage('not-set', { bookIds: [] }));
    t.retry().click();
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.statusText()).toBe('The book primary image change for “Third Book” could not be confirmed. This asset is not the primary image for “Third Book”. This is what is saved now; it does not show whether your request ran.');

    const u = setup({ selected: true });
    u.queue.push(jsonResponse(500, { status: 'error', code: 'PRIMARY_IMAGE_FAILED', outcome: 'unknown', message: 'x' }),
      u.serverPage('still', { selected: true }));
    u.submit('asset-primary-image-remove-form');
    await flush();
    expect(u.statusText()).toContain('The primary image removal could not be confirmed. This asset is still the project’s primary image.');

    const v = setup();
    v.queue.push({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError('bad')) }, v.serverPage('no', {}));
    v.submit('asset-primary-image-set-form');
    await flush();
    expect(v.statusText()).toContain('This asset is not the project’s primary image.');
    expect(v.posts()).toHaveLength(1);
  });

  it('settles a tag save whose read a primary change superseded', async () => {
    const t = setup();
    const tagRead = deferred();
    t.queue.push(jsonResponse(200, {
      status: 'success', outcome: 'committed', projectId: PROJECT_ID, assetId: ASSET_ID, tagIds: [1, 2], tags: [],
    }), () => tagRead.promise);
    const box = t.tagForm.querySelector('input[value="2"]');
    box.checked = true;
    box.dispatch('change');
    await flush();
    expect(t.tagStatusText()).toBe('Asset tags updated.');

    t.queue.push(committed('primary-image-set'), t.serverPage('both', { selected: true, savedTagIds: ['1', '2'] }));
    t.submit('asset-primary-image-set-form');
    await flush();
    // The late tag read was superseded and installs nothing over the newer render.
    t.serverPage('stale-tags', { selected: false, savedTagIds: ['1'] });
    tagRead.resolve(htmlResponse('stale-tags'));
    await flush();
    expect(t.document.querySelector('[data-asset-viewer-region="tags"]').textContent).toBe('tags:1,2');
    expect(t.tagForm.getAttribute('data-confirmed-tag-ids')).toBe('1,2');
    expect(t.shown().projectSelected).toBe(true);
    expect(t.tagStatusText()).toBe('Asset tags updated.');
    expect(t.statusText()).toBe('The primary image was set.');
    expect(t.gets()).toHaveLength(2);
  });

  it('keeps an open read obligation through dismissal and clears settled messages', async () => {
    const t = setup();
    t.queue.push(committed('primary-image-set'), htmlResponse('failed', 500));
    t.submit('asset-primary-image-set-form');
    await flush();
    t.dialog.__creatorCrateAppDialogState.onClose();
    expect(t.statusText()).toBe('The primary image details could not be read. They may be out of date.');

    const u = setup();
    u.queue.push(committed('primary-image-set'), u.serverPage('ok', { selected: true }));
    u.submit('asset-primary-image-set-form');
    await flush();
    u.dialog.__creatorCrateAppDialogState.onClose();
    expect(u.statusText()).toBe('');
  });
});

describe('asset-viewer-refresh — primary-image regions', () => {
  it('installs only the requested regions, all or nothing, and reports the saved selection', async () => {
    const t = setup({ selected: false, bookIds: ['11'] });
    t.queue.push(t.serverPage('p', { selected: true, bookIds: ['11', '13'], savedTagIds: ['3'] }));
    const result = await refreshAssetViewer(t.document, { projectId: PROJECT_ID, assetId: ASSET_ID, regions: ['primary-image'] });
    expect(result).toEqual({
      status: 'installed',
      primaryImage: { projectSelected: true, bookIds: ['11', '13'] },
      previousPrimaryImage: { projectSelected: false, bookIds: ['11'] },
      bookSectionReplaced: false,
    });
    // Tags were not requested and are not touched.
    expect(t.document.querySelector('[data-asset-viewer-region="tags"]').textContent).toBe('tags:1');

    const u = setup();
    const broken = buildPage({ selected: true });
    broken.dialog.querySelector('[data-asset-viewer-region="book-primary-image"]').remove();
    u.queue.push(htmlResponse('broken'));
    u.windowObject.DOMParser = class { parseFromString() { return createDocument(broken.body, { live: false }); } };
    const failed = await refreshAssetViewer(u.document, { regions: ['primary-image'] });
    expect(failed.status).toBe('failed');
    expect(u.shown().projectSelected).toBe(false);
  });
});
