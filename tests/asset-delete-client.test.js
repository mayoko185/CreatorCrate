import { describe, it, expect, vi, beforeEach } from 'vitest';

// WP10A3-B: Edit Asset's Delete form deletes in place up to the moment the
// asset is gone (asset-edit-dialog.js). The dialog binder, the dropdowns and
// the shared confirmation are stand-ins (the confirmation's replay is a
// requestSubmit here; its own gate is covered in Chromium); the DOM is the
// purpose-built shim of the WP10A suites (no jsdom in this project).

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

const confirmations = vi.hoisted(() => ({ described: new Map() }));
vi.mock('../src/static/client/confirm-dialog.js', () => ({
  describeAppConfirmation: (control, resolve) => { confirmations.described.set(control, resolve); },
}));

const { enhanceAssetEditDialog } = await import('../src/static/client/asset-edit-dialog.js');
const { assetViewerFileState, assetViewerRetired, refreshAssetViewer } = await import('../src/static/client/asset-viewer-refresh.js');

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


// The shim's nodes gain the one DOM method the file region needs.
FakeNode.prototype.insertBefore = function insertBefore(node, reference) {
  node.parentNode?.removeChildNode(node);
  node.parentNode = this;
  const index = this.childNodes.indexOf(reference);
  if (index < 0) this.childNodes.push(node);
  else this.childNodes.splice(index, 0, node);
  return node;
};

// ------------------------------------------------------------ page builder --

const PROJECT_ID = 7;
const ASSET_ID = 42;
const csrf = () => h('input', { type: 'hidden', name: '_csrf', value: 'token-1' });
const action = (suffix) => `/projects/${PROJECT_ID}/assets/${ASSET_ID}/${suffix}`;
const LABELS = { uncategorized: 'Uncategorized', 5: 'Renders', 6: 'WIP' };

function media(kind, filename, preview) {
  if (kind === 'video') {
    return h('figure', { class: 'asset-preview-frame asset-preview-frame--video', 'data-asset-video-playback': '' },
      h('video', { class: 'asset-preview-video', src: `/projects/${PROJECT_ID}/assets/${ASSET_ID}/original`, 'data-asset-video': '' }));
  }
  if (kind === 'unsupported') {
    return h('div', { class: 'notice notice--warning', role: 'status' }, h('p', {}, 'Unsupported asset preview.'));
  }
  return h('figure', { class: 'asset-preview-frame', 'data-preview-enhancement': '', 'data-preview-state': 'loaded' },
    h('a', { class: 'asset-preview-link', href: `/projects/${PROJECT_ID}/assets/${ASSET_ID}/original`, 'aria-label': `View original ${filename}` },
      h('img', { class: 'asset-preview-image', src: preview, alt: `Preview of ${filename}`, 'data-preview-image': '' })));
}

function buildPage({
  filename = 'hero.png', destination = 'uncategorized', filteredOut = false, preview = '/preview?v=1',
  kind = 'image', prev = true, next = true, savedTagIds = ['1'], primarySelected = false, deleteAction = null,
  review = `v1.review-${filename}-${destination}`,
} = {}) {
  const label = LABELS[destination];
  const host = h('div', {
    class: 'asset-preview-viewer',
    'data-asset-viewer-host': '',
    'data-asset-viewer-project-id': PROJECT_ID,
    'data-asset-viewer-asset-id': ASSET_ID,
  },
  media(kind, filename, preview),
  prev ? h('a', { class: 'asset-preview-nav asset-preview-nav--previous', rel: 'prev', href: `/prev?${destination}` }) : null,
  next ? h('a', { class: 'asset-preview-nav asset-preview-nav--next', rel: 'next', href: `/next?${destination}` }) : null);
  const checkboxes = ['1', '2'].map((id) => {
    const input = h('input', { type: 'checkbox', name: 'tagIds[]', value: id });
    if (savedTagIds.includes(id)) { input.setAttribute('checked', ''); input.checked = true; }
    return input;
  });
  const tagForm = h('form', {
    id: 'asset-edit-form', method: 'post', action: action('tags'),
    'data-confirmed-tag-ids': savedTagIds.join(','), 'data-dialog-form': '', 'data-asset-tags-form': '',
  }, csrf(), h('details', { id: 'asset-tags-form', 'data-cc-dropdown': '' }, checkboxes));
  const primaryForm = primarySelected
    ? h('form', { method: 'post', action: action('primary-image/remove'), class: 'asset-action-form asset-primary-image-remove-form' },
      csrf(), h('button', { type: 'submit' }, 'Remove primary image'))
    : h('form', { method: 'post', action: action('primary-image'), class: 'asset-action-form asset-primary-image-set-form' },
      csrf(), h('button', { type: 'submit' }, 'Set as primary image'));
  const renameInput = h('input', { type: 'text', id: 'rename-filename', name: 'filename', value: filename, 'data-confirmed-value': filename });
  const moveSelect = h('select', { id: 'move-destination', name: 'destinationCategory', 'data-confirmed-value': destination },
    Object.entries(LABELS).map(([value, text]) => h('option', { value }, text)));
  moveSelect.value = destination;
  const bookSelect = h('select', { name: 'bookId', id: 'book-primary-image-book-native' },
    h('option', { value: '' }, 'Choose a Book'), h('option', { value: '3' }, 'Book Three'));
  const deleteButton = h('button', {
    class: 'button button-danger', type: 'submit', 'data-confirm': 'The file will be permanently deleted.',
  }, 'Delete asset');
  const renameButton = h('button', { class: 'button button-primary', type: 'submit' }, 'Rename file');
  const moveButton = h('button', { class: 'button button-primary', type: 'submit' }, 'Move file');
  const dialog = h('dialog', { id: 'asset-edit-dialog' },
    h('button', { type: 'button', 'data-dialog-close': '' }, 'Close'),
    h('div', { class: 'app-dialog-body' },
      tagForm,
      h('div', { 'data-asset-viewer-region': 'project-primary-image', 'data-primary-image-selected': primarySelected ? 'true' : 'false' },
        h('section', {}, h('h3', {}, 'Primary image'), primaryForm)),
      h('div', { 'data-asset-viewer-region': 'book-primary-image', 'data-book-primary-image-book-ids': '' },
        h('div', { 'data-asset-viewer-region': 'book-primary-image-usages' }),
        h('form', { method: 'post', action: action('book-primary-image'), class: 'asset-action-form asset-book-primary-image-set-form' },
          csrf(), bookSelect, h('button', { type: 'submit' }, 'Set as book primary image'))),
      h('section', {}, h('h3', { id: 'asset-actions-heading' }, 'File actions'),
        h('form', { class: 'asset-action-form asset-rename-form', method: 'post', action: action('rename') },
          csrf(), h('input', { type: 'hidden', name: 'origin', value: 'viewer' }),
          h('input', { type: 'hidden', name: 'category', value: 'all' }), renameInput, renameButton),
        h('form', { class: 'asset-action-form asset-move-form', method: 'post', action: action('move') },
          csrf(), h('input', { type: 'hidden', name: 'category', value: 'all' }), moveSelect, moveButton)),
      h('section', {}, h('h3', {}, 'Delete asset'),
        h('form', { class: 'asset-action-form asset-delete-form', method: 'post', action: deleteAction || action('delete'), 'data-confirm-submit-required': '' },
          csrf(), h('input', { type: 'hidden', name: 'deleteReview', value: review, 'data-asset-delete-review': '' }),
          h('input', { type: 'hidden', name: 'category', value: 'all' }), deleteButton))),
    h('div', { class: 'app-dialog-status', 'data-dialog-status': '', role: 'status', 'aria-live': 'polite' }));
  const body = h('body', {},
    h('nav', {}, h('a', { class: 'asset-viewer-back', href: `/projects/${PROJECT_ID}/assets?category=all&page=${filteredOut ? 1 : 2}` }),
      h('a', { class: 'asset-viewer-open-locally', href: `file:///${destination}/${filename}` })),
    h('div', { class: 'asset-viewer-region', 'data-asset-viewer-region': 'filter-notice', 'data-asset-viewer-filtered-out': filteredOut ? 'true' : 'false' },
      filteredOut ? h('div', { class: 'notice notice--warning', role: 'status' }, h('p', {}, 'This asset is outside the current asset-browser filters.')) : null),
    h('section', { class: 'asset-preview-section' }, h('h2', { id: 'asset-preview-heading' }, 'Preview'), host),
    h('dl', {
      'data-asset-viewer-region': 'file-summary',
      'data-asset-filename': filename,
      'data-asset-destination': destination,
      'data-asset-category-label': label,
    }, h('dd', {}, filename), h('dd', {}, `/${destination}/`)),
    h('dl', { 'data-asset-viewer-region': 'file-details' }, h('dd', {}, label)),
    h('div', { 'data-asset-viewer-region': 'tags' }, h('p', {}, `tags:${savedTagIds.join(',')}`)),
    dialog);
  return {
    body, host, dialog, tagForm, renameInput, moveSelect, renameButton, moveButton, bookSelect, deleteButton,
    title: `Assets — ${filename}`,
  };
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

function committed(actionName, { filename = 'hero.png', destination = 'uncategorized' } = {}) {
  return jsonResponse(200, {
    status: 'success', outcome: 'committed', action: actionName, message: 'ok',
    projectId: PROJECT_ID, assetId: ASSET_ID,
    asset: { id: ASSET_ID, filename, destinationCategory: destination, categoryId: destination === 'uncategorized' ? null : Number(destination) },
    refreshRequired: true,
  });
}
const refused = (status, code, message) => jsonResponse(status, { status: 'error', code, outcome: 'refused', message });

function setup(pageOptions = {}, { fetch = true } = {}) {
  const page = buildPage(pageOptions);
  const document = createDocument(page.body);
  document.title = page.title;
  const requests = [];
  const queue = [];
  const pages = new Map();
  const windowObject = {
    location: {
      href: `http://creatorcrate.local/projects/${PROJECT_ID}/assets/${ASSET_ID}?category=all`,
      replace: vi.fn(),
      assign: vi.fn(),
    },
    URL,
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
      get(name) { return this.entries.find(([key]) => key === name)?.[1] ?? null; }
      getAll(name) { return this.entries.filter(([key]) => key === name).map(([, value]) => value); }
    },
    DOMParser: class {
      parseFromString(html) {
        const build = pages.get(html);
        if (!build) return createDocument(h('body', {}, h('main', {}, 'Sign in')), { live: false });
        const built = build();
        const parsed = createDocument(built.body, { live: false });
        parsed.title = built.title;
        return parsed;
      }
    },
    fetch: fetch ? vi.fn((url, init) => {
      requests.push({ url, method: init.method, body: init.body, accept: init.headers?.Accept });
      const nextResponse = queue.shift();
      if (!nextResponse) throw new Error(`Unexpected ${init.method} ${url}`);
      return typeof nextResponse === 'function' ? nextResponse() : nextResponse;
    }) : undefined,
  };
  document.defaultView = windowObject;
  const appDialogState = { document, dialog: page.dialog, onClose: null };
  page.dialog.__creatorCrateAppDialogState = appDialogState;
  enhanceAssetEditDialog(document);

  const posts = () => requests.filter((request) => request.method === 'POST');
  const gets = () => requests.filter((request) => request.method === 'GET');
  const form = (cls) => page.dialog.querySelector(`form.${cls}`);
  const submit = (cls) => form(cls).requestSubmit();
  const status = () => page.dialog.querySelector('[data-dialog-status]');
  const fileText = () => page.dialog.querySelector('[data-asset-file-action-status-text]')?.textContent || '';
  const primaryText = () => page.dialog.querySelector('[data-asset-primary-image-status-text]')?.textContent || '';
  const tagText = () => page.dialog.querySelector('[data-asset-tags-status-text]')?.textContent || '';
  const retry = () => page.dialog.querySelector('[data-asset-file-action-retry]');
  const serverPage = (key, options) => { pages.set(key, () => buildPage(options)); return htmlResponse(key); };
  const shown = () => assetViewerFileState(document);
  const held = () => [form('asset-rename-form'), form('asset-move-form')].map((node) => node.getAttribute('data-asset-file-action-hold'));
  const deleteText = () => page.dialog.querySelector('[data-asset-delete-status-text]')?.textContent || '';
  const deleteRetry = () => page.dialog.querySelector('[data-asset-delete-retry]');
  const deleteLink = () => page.dialog.querySelector('[data-asset-delete-assets-link]');
  const describe = () => confirmations.described.get(page.deleteButton)?.();
  const deleteForm = () => form('asset-delete-form');
  return {
    ...page, document, windowObject, appDialogState, requests, queue, posts, gets, form, submit,
    status, fileText, primaryText, tagText, retry, serverPage, shown, held,
    deleteText, deleteRetry, deleteLink, describe, deleteForm,
  };
}

const flush = async () => { for (let i = 0; i < 40; i += 1) await Promise.resolve(); };

beforeEach(() => {
  dialogs.freezes = 0;
  dialogs.restores = 0;
  dialogs.frozen = 0;
  dropdowns.initialized = [];
  confirmations.described = new Map();
});

const image = (t) => t.host.querySelector('img');
const nav = (t, name) => t.host.querySelector(`a.asset-preview-nav--${name}`);

const ASSETS_URL = `/projects/${PROJECT_ID}/assets?category=all&assets_deleted=1`;
const BACK_URL = `/projects/${PROJECT_ID}/assets?category=all&page=2`;

function deleted(overrides = {}) {
  return jsonResponse(200, {
    status: 'success',
    outcome: 'deleted',
    action: 'asset-deleted',
    message: 'The asset was deleted.',
    projectId: PROJECT_ID,
    assetId: ASSET_ID,
    deletedAssetIds: [ASSET_ID],
    cleanup: 'complete',
    assetsUrl: ASSETS_URL,
    ...overrides,
  });
}

// Unsaved drafts in every other Edit Asset control.
function enterDrafts(t) {
  t.tagForm.querySelector('input[value="2"]').checked = true;
  t.bookSelect.value = '3';
  t.renameInput.value = 'draft-name.png';
  t.moveSelect.value = '5';
}

function expectDraftsKept(t) {
  expect(t.tagForm.querySelector('input[value="2"]').checked).toBe(true);
  expect(t.tagForm.getAttribute('data-confirmed-tag-ids')).toBe('1');
  expect(t.bookSelect.value).toBe('3');
  expect(t.renameInput.value).toBe('draft-name.png');
  expect(t.renameInput.getAttribute('data-confirmed-value')).toBe('hero.png');
  expect(t.moveSelect.value).toBe('5');
  expect(t.moveSelect.getAttribute('data-confirmed-value')).toBe('uncategorized');
}

const deletePosts = (t) => t.posts().filter((post) => post.url === action('delete'));
const STILL_LISTED = 'The deletion could not be confirmed. The asset is still listed in this project, but the earlier Delete request may still run or may have left its file needing recovery. Nothing will be sent again by itself. Your unsaved changes were kept.';
const HELD = 'This asset cannot be changed from this page while the earlier deletion is unconfirmed. Use Check again, or reload the page once that request can no longer be running.';

describe('Delete — confirmation wording', () => {
  it('names the asset, and says nothing about drafts when there are none', () => {
    const t = setup();
    expect(t.describe()).toEqual({
      title: 'Delete asset?',
      message: 'Delete “hero.png” from this project? Its file will be permanently deleted from disk and cannot be restored through CreatorCrate.',
      confirmLabel: 'Delete asset',
    });
    expect(t.requests).toHaveLength(0);
  });

  it('lists every unsaved Edit Asset draft that will not be saved and is lost only if the asset is deleted', () => {
    const t = setup();
    enterDrafts(t);
    const described = t.describe();
    expect(described.title).toBe('Delete asset with unsaved changes?');
    expect(described.cancelLabel).toBe('Keep editing');
    expect(described.message).toContain('“hero.png”');
    expect(described.message).toContain('(tag selection, Book choice, new filename and move destination) will not be saved');
    expect(described.message).toContain('kept if you cancel or the asset is not deleted, and lost if it is deleted');
    // Describing sends nothing and changes nothing.
    expect(t.requests).toHaveLength(0);
    expectDraftsKept(t);
  });

  it('reads the saved name the page shows now, not the one it was rendered with', () => {
    const t = setup();
    t.document.querySelector('[data-asset-viewer-region="file-summary"]').setAttribute('data-asset-filename', 'renamed.png');
    expect(t.describe().message).toContain('“renamed.png”');
  });
});

describe('Delete — confirmed deletion', () => {
  it('sends one JSON POST of the Delete form only, then retires the page and replaces it once with Project Assets', async () => {
    const t = setup();
    enterDrafts(t);
    const post = deferred();
    t.queue.push(() => post.promise);

    t.deleteForm().requestSubmit();
    expect(t.deleteForm().getAttribute('aria-busy')).toBe('true');
    expect(t.deleteText()).toBe('Deleting “hero.png”…');
    expect(dialogs.frozen).toBe(1);
    expect(t.appDialogState.beforeClose({})).toBe(false);
    await flush();

    expect(t.posts()).toHaveLength(1);
    const [request] = t.posts();
    expect(request.url).toBe(action('delete'));
    expect(request.accept).toBe('application/json');
    expect(request.body.get('category')).toBe('all');
    expect(request.body.getAll('_csrf')).toEqual(['token-1']);
    // No draft is saved by Delete.
    expect(request.body.get('filename')).toBeNull();
    expect(request.body.get('destinationCategory')).toBeNull();
    expect(request.body.getAll('tagIds[]')).toEqual([]);

    post.resolve(deleted());
    await flush();
    expect(t.windowObject.location.replace).toHaveBeenCalledTimes(1);
    expect(t.windowObject.location.replace).toHaveBeenCalledWith(ASSETS_URL);
    expect(t.windowObject.location.assign).not.toHaveBeenCalled();
    expect(t.deleteText()).toBe('The asset was deleted. Opening Project Assets…');
    expect(t.deleteLink().getAttribute('href')).toBe(ASSETS_URL);
    expect(assetViewerRetired(t.document)).toBe(true);
    expect(t.host.hasAttribute('data-asset-viewer-retired')).toBe(true);
    expect(t.deleteForm().getAttribute('data-asset-delete-hold')).toBe('deleted');
    // The dialog stays frozen: nothing acts on the deleted asset again.
    expect(dialogs.frozen).toBe(1);
    expect(t.gets()).toHaveLength(0);
    expect(t.document.nativeSubmits).toHaveLength(0);
    expect(t.dialog.querySelectorAll('[aria-live]')).toHaveLength(1);
  });

  it('refuses every later action on the deleted asset, sends nothing more, and no read can install', async () => {
    const t = setup();
    t.queue.push(deleted());
    t.deleteForm().requestSubmit();
    await flush();

    t.deleteForm().requestSubmit();
    const click = t.deleteButton.dispatch('click');
    expect(click.defaultPrevented).toBe(true);
    t.renameInput.value = 'after.png';
    t.submit('asset-rename-form');
    t.submit('asset-move-form');
    t.form('asset-primary-image-set-form').requestSubmit();
    t.tagForm.querySelector('input[value="2"]').checked = true;
    t.tagForm.querySelector('input[value="2"]').dispatch('change');
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.windowObject.location.replace).toHaveBeenCalledTimes(1);
    expect(t.deleteText()).toContain('This asset no longer exists. Go to Project Assets to continue.');

    const result = await refreshAssetViewer(t.document, { regions: ['file'] });
    expect(result.status).toBe('unavailable');
    expect(t.gets()).toHaveLength(0);
  });

  it('never installs a read that was out when Delete began', async () => {
    const t = setup();
    const read = deferred();
    t.queue.push(() => read.promise);
    const stale = refreshAssetViewer(t.document, { regions: ['file'] });
    const post = deferred();
    t.queue.push(() => post.promise);
    t.deleteForm().requestSubmit();
    await flush();
    read.resolve(t.serverPage('stale', { filename: 'stale.png' }));
    expect((await stale).status).toBe('superseded');
    expect(t.shown().filename).toBe('hero.png');
    post.resolve(deleted());
    await flush();
    expect(t.shown().filename).toBe('hero.png');
    expect(t.windowObject.location.replace).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['another origin', 'https://evil.example/projects/7/assets'],
    ['a protocol-relative URL', '//evil.example/projects/7/assets'],
    ['another project', '/projects/8/assets'],
    ['another route', `/projects/${PROJECT_ID}/assets/${ASSET_ID}`],
    ['a script URL', 'javascript:alert(1)'],
    ['a missing URL', undefined],
  ])('never follows %s: it uses the page’s own Project Assets link instead', async (_label, assetsUrl) => {
    const t = setup();
    t.queue.push(deleted({ assetsUrl }));
    t.deleteForm().requestSubmit();
    await flush();
    expect(t.windowObject.location.replace).toHaveBeenCalledExactlyOnceWith(BACK_URL);
  });

  it('treats a success for another asset as unconfirmed, and checks with a GET', async () => {
    const t = setup();
    t.queue.push(deleted({ assetId: ASSET_ID + 1, deletedAssetIds: [ASSET_ID + 1] }), t.serverPage('same', {}));
    t.deleteForm().requestSubmit();
    await flush();
    expect(t.windowObject.location.replace).not.toHaveBeenCalled();
    expect(t.gets()).toHaveLength(1);
    expect(t.deleteText()).toContain('The deletion could not be confirmed. The asset is still listed in this project');
  });
});

describe('Delete — refusals keep the document and every draft', () => {
  it('refuses locally, keeps all drafts and the media, and lets an explicit new Delete send a new POST', async () => {
    const t = setup();
    enterDrafts(t);
    const img = image(t);
    t.queue.push(refused(409, 'PROJECT_ARCHIVED', 'This project is archived and read-only.'));
    t.deleteForm().requestSubmit();
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.gets()).toHaveLength(0);
    expect(t.deleteText()).toBe('This project is archived and read-only. Nothing was deleted. Your unsaved changes were kept.');
    expect(t.status().getAttribute('data-asset-delete-state')).toBe('error');
    expect(t.windowObject.location.replace).not.toHaveBeenCalled();
    expect(dialogs.frozen).toBe(0);
    expect(t.deleteForm().hasAttribute('aria-busy')).toBe(false);
    expect(t.deleteForm().hasAttribute('data-asset-delete-hold')).toBe(false);
    expect(t.appDialogState.beforeClose({})).toBe(true);
    expect(assetViewerRetired(t.document)).toBe(false);
    expect(image(t)).toBe(img);
    expectDraftsKept(t);

    t.queue.push(refused(409, 'PROJECT_BUSY', 'Another project operation is already in progress. Try again.'));
    t.deleteForm().requestSubmit();
    await flush();
    expect(deletePosts(t)).toHaveLength(2);
    expectDraftsKept(t);
  });

  it('reports a failure the service rolled back without repeating that nothing changed', async () => {
    const t = setup();
    t.queue.push(jsonResponse(500, {
      status: 'error', code: 'DELETE_DATABASE_OPERATION_FAILED', outcome: 'failed',
      message: 'The asset could not be deleted. Its file was restored and nothing was removed.',
    }));
    t.deleteForm().requestSubmit();
    await flush();
    expect(t.deleteText()).toBe('The asset could not be deleted. Its file was restored and nothing was removed. Your unsaved changes were kept.');
    expect(t.gets()).toHaveLength(0);
    expect(t.windowObject.location.replace).not.toHaveBeenCalled();
  });

  it('treats a CSRF or sign-in refusal (no outcome) as a refusal', async () => {
    const t = setup();
    t.queue.push(jsonResponse(403, { status: 'error', message: 'Your session expired.' }));
    t.deleteForm().requestSubmit();
    await flush();
    expect(t.deleteText()).toBe('Your session expired. Nothing was deleted. Your unsaved changes were kept.');
  });

  it('re-reads the page after a refusal only when another action is still owed a read', async () => {
    const t = setup();
    // A tag save's read is out when Delete begins; Delete supersedes it.
    t.queue.push(jsonResponse(200, { status: 'success', outcome: 'committed', tagIds: [1, 2], projectId: PROJECT_ID, assetId: ASSET_ID }));
    const tagRead = deferred();
    t.queue.push(() => tagRead.promise);
    t.tagForm.querySelector('input[value="2"]').checked = true;
    t.tagForm.requestSubmit();
    await flush();
    t.queue.push(refused(409, 'PROJECT_BUSY', 'Another project operation is already in progress. Try again.'),
      t.serverPage('after', { savedTagIds: ['1', '2'] }));
    t.deleteForm().requestSubmit();
    await flush();
    tagRead.resolve(t.serverPage('stale', { savedTagIds: ['1'] }));
    await flush();
    expect(deletePosts(t)).toHaveLength(1);
    expect(t.gets()).toHaveLength(2);
    expect(t.tagForm.getAttribute('data-confirmed-tag-ids')).toBe('1,2');
    expect(t.document.querySelector('[data-asset-viewer-region="tags"]').textContent).toBe('tags:1,2');
  });

  it('shows a 404 refusal as a missing asset, without navigating or claiming this request removed it', async () => {
    const t = setup();
    enterDrafts(t);
    t.queue.push(refused(404, 'ASSET_NOT_FOUND', 'This asset no longer exists in this project. It may have been deleted elsewhere.'));
    t.deleteForm().requestSubmit();
    await flush();
    expect(t.deleteText()).toBe('This asset no longer exists in this project. It may have been deleted elsewhere. This Delete request did not remove it.');
    expect(t.windowObject.location.replace).not.toHaveBeenCalled();
    expect(t.deleteLink().getAttribute('href')).toBe(BACK_URL);
    expect(t.document.activeElement).toBe(t.deleteLink());
    expect(assetViewerRetired(t.document)).toBe(true);
    expect(t.deleteForm().getAttribute('data-asset-delete-hold')).toBe('missing');
    expectDraftsKept(t);
  });

  it('refuses a form whose action is not the asset shown, sending nothing', async () => {
    const t = setup({ deleteAction: `/projects/${PROJECT_ID}/assets/99/delete` });
    t.deleteForm().requestSubmit();
    await flush();
    expect(t.posts()).toHaveLength(0);
    expect(t.deleteText()).toBe('This Delete form does not match the asset shown. Reload the page and try again.');
  });
});

describe('Delete — recovery outcomes', () => {
  it('reports a record deleted with its file left staged, without navigating or claiming a clean deletion', async () => {
    const t = setup();
    const message = 'The asset was deleted from CreatorCrate, but its file could not be fully removed: it may remain in a hidden folder whose name starts with “.creatorcrate-delete-” in the project folder. Inspect the project folder before scanning.';
    t.queue.push(jsonResponse(500, {
      status: 'error', code: 'DELETE_RECOVERY_REQUIRED', outcome: 'deleted-cleanup-incomplete', recoveryRequired: true,
      assetDeleted: true, projectId: PROJECT_ID, assetId: ASSET_ID, cleanup: 'incomplete', message,
      assetsUrl: `/projects/${PROJECT_ID}/assets?category=all`,
    }));
    t.deleteForm().requestSubmit();
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.gets()).toHaveLength(0);
    expect(t.deleteText()).toBe(message);
    expect(t.status().getAttribute('data-asset-delete-state')).toBe('error');
    expect(t.windowObject.location.replace).not.toHaveBeenCalled();
    expect(t.deleteLink().getAttribute('href')).toBe(`/projects/${PROJECT_ID}/assets?category=all`);
    expect(t.document.activeElement).toBe(t.deleteLink());
    expect(assetViewerRetired(t.document)).toBe(true);
    expect(t.deleteForm().getAttribute('data-asset-delete-hold')).toBe('cleanup');
    t.deleteForm().requestSubmit();
    await flush();
    expect(t.posts()).toHaveLength(1);
  });

  it('keeps the page when the record remains, holds Delete, and shows what the records hold now', async () => {
    const t = setup();
    enterDrafts(t);
    t.queue.push(jsonResponse(500, {
      status: 'error', code: 'DELETE_RECOVERY_REQUIRED', outcome: 'recovery-required', recoveryRequired: true,
      message: 'The asset was not deleted, but CreatorCrate could not safely put its file back after the deletion failed.',
    }), t.serverPage('kept', {}));
    t.deleteForm().requestSubmit();
    await flush();
    expect(t.gets()).toHaveLength(1);
    expect(t.deleteText()).toBe('The asset was not deleted, but CreatorCrate could not safely put its file back after the deletion failed. Your unsaved changes were kept.');
    expect(t.deleteForm().getAttribute('data-asset-delete-hold')).toBe('recovery');
    expect(t.deleteButton.getAttribute('aria-disabled')).toBe('true');
    expect(assetViewerRetired(t.document)).toBe(false);
    expectDraftsKept(t);
    t.deleteForm().requestSubmit();
    await flush();
    expect(deletePosts(t)).toHaveLength(1);
    expect(t.deleteText()).toContain('Delete is unavailable until the project folder has been inspected.');
  });
});

describe('Delete — lost or unreadable answers (GET only)', () => {
  it('never resends: a GET shows the asset still listed, drafts are kept, and every action stays held', async () => {
    const t = setup();
    enterDrafts(t);
    const read = deferred();
    t.queue.push(() => Promise.reject(new TypeError('network')), () => read.promise);
    t.deleteForm().requestSubmit();
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.gets()).toHaveLength(1);
    expect(t.deleteText()).toBe('The deletion could not be confirmed. Checking whether the asset still exists…');
    // While unresolved, the other actions are refused, not queued.
    t.submit('asset-rename-form');
    t.form('asset-primary-image-set-form').requestSubmit();
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.deleteButton.dispatch('click').defaultPrevented).toBe(true);

    read.resolve(t.serverPage('present', {}));
    await flush();
    expect(t.deleteText()).toBe(STILL_LISTED);
    expect(t.windowObject.location.replace).not.toHaveBeenCalled();
    expect(assetViewerRetired(t.document)).toBe(false);
    expectDraftsKept(t);
    expect(t.posts()).toHaveLength(1);
    // A listed asset is not an answer from the lost request: nothing is unlocked.
    t.deleteForm().requestSubmit();
    expect(t.deleteButton.dispatch('click').defaultPrevented).toBe(true);
    await flush();
    expect(deletePosts(t)).toHaveLength(1);
    expect(t.posts()).toHaveLength(1);
  });

  it('reports an absent asset after a lost answer without navigating or claiming this request removed it', async () => {
    const t = setup();
    t.queue.push(() => Promise.reject(new TypeError('network')), htmlResponse('', 404));
    t.deleteForm().requestSubmit();
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.deleteText()).toBe('The deletion could not be confirmed. This asset no longer exists in this project, but CreatorCrate cannot tell whether your request removed it or whether its file was fully removed from the project folder.');
    expect(t.windowObject.location.replace).not.toHaveBeenCalled();
    expect(t.deleteLink().getAttribute('href')).toBe(BACK_URL);
    expect(assetViewerRetired(t.document)).toBe(true);
  });

  it('keeps the outcome unresolved when the GET fails, and Check again repeats only the GET', async () => {
    const t = setup();
    enterDrafts(t);
    t.queue.push(jsonResponse(500, { status: 'error', code: 'ASSET_DELETE_UNCONFIRMED', outcome: 'unknown', message: 'x' }),
      htmlResponse('', 500));
    t.deleteForm().requestSubmit();
    await flush();
    expect(t.deleteText()).toBe('The deletion could not be confirmed. The asset could not be checked. Your unsaved changes were kept.');
    expect(t.deleteRetry().textContent).toBe('Check again');
    // Still locked: neither Delete nor another action is sent.
    t.deleteForm().requestSubmit();
    t.submit('asset-move-form');
    await flush();
    expect(t.posts()).toHaveLength(1);

    t.queue.push(() => Promise.reject(new TypeError('offline')));
    t.deleteRetry().click();
    await flush();
    expect(t.gets()).toHaveLength(2);
    expect(t.deleteRetry()).not.toBeNull();
    t.queue.push(t.serverPage('back', {}));
    t.deleteRetry().click();
    await flush();
    expect(t.gets()).toHaveLength(3);
    expect(t.posts()).toHaveLength(1);
    expect(t.deleteText()).toBe(STILL_LISTED);
    // Still held, and Check again is still only a GET.
    expect(t.deleteRetry()).not.toBeNull();
    t.deleteForm().requestSubmit();
    t.submit('asset-rename-form');
    await flush();
    expect(t.posts()).toHaveLength(1);
    expectDraftsKept(t);
  });

  it('treats an unreadable success body as unconfirmed', async () => {
    const t = setup();
    t.queue.push({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError('html')) }, t.serverPage('p', {}));
    t.deleteForm().requestSubmit();
    await flush();
    expect(t.windowObject.location.replace).not.toHaveBeenCalled();
    expect(t.posts()).toHaveLength(1);
    expect(t.deleteText()).toContain('The deletion could not be confirmed.');
  });
});

describe('Delete — one POST and the other actions', () => {
  it('sends one POST however often Delete is submitted or clicked while pending', async () => {
    const t = setup();
    const post = deferred();
    t.queue.push(() => post.promise);
    t.deleteForm().requestSubmit();
    t.deleteForm().requestSubmit();
    t.deleteForm().dispatch('submit');
    expect(t.deleteButton.dispatch('click').defaultPrevented).toBe(true);
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.deleteText()).toContain('The asset is being deleted. Wait for the result.');
    post.resolve(deleted());
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.windowObject.location.replace).toHaveBeenCalledTimes(1);
  });

  it('refuses the other Edit Asset actions while Delete is pending, keeping their drafts', async () => {
    const t = setup();
    enterDrafts(t);
    const post = deferred();
    t.queue.push(() => post.promise);
    t.deleteForm().requestSubmit();
    t.submit('asset-rename-form');
    t.submit('asset-move-form');
    t.form('asset-book-primary-image-set-form').requestSubmit();
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.fileText()).toBe('Wait for the current change to finish, then try again.');
    post.resolve(refused(409, 'PROJECT_BUSY', 'Busy.'));
    await flush();
    expectDraftsKept(t);
  });

  it('refuses Delete before its confirmation while another action is pending, and never sends it', async () => {
    const t = setup();
    enterDrafts(t);
    const rename = deferred();
    t.queue.push(() => rename.promise);
    t.submit('asset-rename-form');
    const click = t.deleteButton.dispatch('click');
    expect(click.defaultPrevented).toBe(true);
    expect(t.deleteText()).toBe('Wait for the current change to finish, then delete the asset.');
    t.deleteForm().requestSubmit();
    await flush();
    expect(deletePosts(t)).toHaveLength(0);
    expect(t.posts()).toHaveLength(1);
    // The pending Rename stays truthful and settles as it would have.
    t.queue.push(t.serverPage('renamed', { filename: 'draft-name.png' }));
    rename.resolve(committed('asset-renamed', { filename: 'draft-name.png' }));
    await flush();
    expect(t.fileText()).toBe('The file was renamed to “draft-name.png”.');
    // Once it has settled, Delete opens normally.
    expect(t.deleteButton.dispatch('click').defaultPrevented).toBe(false);
  });

  it('moves focus into the Edit Asset dialog when the confirmation replays the submit from outside it', async () => {
    const t = setup();
    const outside = h('button', {}, 'Confirm');
    t.document.body.appendChild(outside);
    outside.focus();
    t.queue.push(refused(409, 'PROJECT_BUSY', 'Busy.'));
    t.deleteForm().requestSubmit();
    expect(t.document.activeElement).toBe(t.deleteButton);
    await flush();
    expect(t.document.activeElement).toBe(t.deleteButton);
  });

  it('closing the dialog clears a settled Delete message but never an unresolved one', async () => {
    const t = setup();
    t.queue.push(refused(409, 'PROJECT_BUSY', 'Busy.'));
    t.deleteForm().requestSubmit();
    await flush();
    t.appDialogState.onClose();
    expect(t.deleteText()).toBe('');

    t.queue.push(() => Promise.reject(new TypeError('lost')), htmlResponse('', 500));
    t.deleteForm().requestSubmit();
    await flush();
    t.appDialogState.onClose();
    expect(t.deleteText()).toContain('The deletion could not be confirmed.');
    expect(t.deleteRetry()).not.toBeNull();
  });
});

describe('Delete — an unconfirmed Delete stays held until its own answer settles it', () => {
  const lost = () => Promise.reject(new TypeError('network'));
  const LOST_RECOVERY_BODY = 'The asset was not deleted, but CreatorCrate could not safely put its file back after the deletion failed.';

  // Every Edit Asset mutation the user can still reach on this page.
  function attemptEverything(t) {
    t.deleteForm().requestSubmit();
    t.deleteForm().dispatch('submit');
    const click = t.deleteButton.dispatch('click');
    t.submit('asset-rename-form');
    t.submit('asset-move-form');
    t.form('asset-primary-image-set-form').requestSubmit();
    t.form('asset-book-primary-image-set-form').requestSubmit();
    t.tagForm.requestSubmit();
    return click;
  }

  it('C1: a GET that finds the asset listed keeps the hold; Rename, Move and a second Delete send nothing', async () => {
    const t = setup();
    enterDrafts(t);
    t.queue.push(lost, t.serverPage('present', {}));
    t.deleteForm().requestSubmit();
    await flush();
    expect(t.gets()).toHaveLength(1);
    expect(t.deleteText()).toBe(STILL_LISTED);
    expect(t.deleteForm().getAttribute('data-asset-delete-hold')).toBe('unresolved');
    expect(t.deleteButton.getAttribute('aria-disabled')).toBe('true');
    expect(t.deleteRetry().textContent).toBe('Check again');

    t.renameInput.value = 'renamed-while-held.png';
    t.submit('asset-rename-form');
    t.moveSelect.value = '6';
    t.submit('asset-move-form');
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.fileText()).toBe(HELD);
    expect(attemptEverything(t).defaultPrevented).toBe(true);
    await flush();
    expect(deletePosts(t)).toHaveLength(1);
    expect(t.posts()).toHaveLength(1);
    // The warning is added to, never replaced.
    expect(t.deleteText().startsWith(STILL_LISTED)).toBe(true);
    expect(assetViewerRetired(t.document)).toBe(false);
  });

  it('C2: another action’s viewer refresh installing the page does not release the hold', async () => {
    const t = setup();
    // A Rename committed, but its refresh failed: it offers its own GET retry.
    t.queue.push(committed('asset-renamed', { filename: 'draft-name.png' }), htmlResponse('', 500));
    t.renameInput.value = 'draft-name.png';
    t.submit('asset-rename-form');
    await flush();
    expect(t.retry()).not.toBeNull();

    // Delete's answer is lost and its own check fails: unresolved.
    t.queue.push(lost, htmlResponse('', 500));
    t.deleteForm().requestSubmit();
    await flush();
    expect(t.deleteRetry()).not.toBeNull();
    const before = t.posts().length;

    // The unrelated GET installs the page through the coordinator.
    t.queue.push(t.serverPage('renamed', { filename: 'draft-name.png' }));
    t.retry().click();
    await flush();
    expect(t.shown().filename).toBe('draft-name.png');
    expect(t.deleteText()).toBe(STILL_LISTED);
    expect(t.deleteForm().getAttribute('data-asset-delete-hold')).toBe('unresolved');

    t.renameInput.value = 'again.png';
    t.submit('asset-rename-form');
    expect(attemptEverything(t).defaultPrevented).toBe(true);
    await flush();
    expect(t.posts()).toHaveLength(before);
  });

  it('C3: a failed check, then dismissing and reopening, still blocks Delete and Rename; Check again is GET only', async () => {
    const t = setup();
    t.queue.push(lost, htmlResponse('', 500));
    t.deleteForm().requestSubmit();
    await flush();
    // The user is never trapped: the dialog can be dismissed.
    expect(dialogs.frozen).toBe(0);
    expect(t.appDialogState.beforeClose({})).toBe(true);
    t.appDialogState.onClose();
    // Reopened: the same document and module state.
    expect(t.deleteText()).toBe('The deletion could not be confirmed. The asset could not be checked. Your unsaved changes were kept.');
    expect(t.deleteForm().getAttribute('data-asset-delete-hold')).toBe('unresolved');
    t.renameInput.value = 'after-close.png';
    t.submit('asset-rename-form');
    expect(attemptEverything(t).defaultPrevented).toBe(true);
    await flush();
    expect(t.posts()).toHaveLength(1);

    t.queue.push(htmlResponse('', 500));
    t.deleteRetry().click();
    await flush();
    t.queue.push(t.serverPage('present', {}));
    t.deleteRetry().click();
    await flush();
    expect(t.gets()).toHaveLength(3);
    expect(t.posts()).toHaveLength(1);
    expect(t.deleteText()).toBe(STILL_LISTED);
    t.submit('asset-rename-form');
    await flush();
    expect(t.posts()).toHaveLength(1);
  });

  it('C4: a lost recovery-required answer read back as a listed asset keeps the warning in place', async () => {
    const t = setup();
    enterDrafts(t);
    // The service staged the file, failed the database delete and could not
    // restore the file; its answer never arrived.
    t.queue.push(lost, t.serverPage('row-remains', {}));
    t.deleteForm().requestSubmit();
    await flush();
    expect(t.deleteText()).toBe(STILL_LISTED);
    expect(t.deleteText()).not.toContain('restored');
    // The read itself keeps every draft (a refused tag save afterwards shows
    // the saved tags again, as it always has: WP10A1).
    expectDraftsKept(t);
    // No refused second request can replace it, because none is sent.
    attemptEverything(t);
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.deleteText().startsWith(STILL_LISTED)).toBe(true);
    expect(t.status().getAttribute('data-asset-delete-state')).toBe('uncertain');
    expect(t.renameInput.value).toBe('draft-name.png');
    expect(t.moveSelect.value).toBe('5');
    expect(t.bookSelect.value).toBe('3');
  });

  it('C5: only the Delete request’s own answer settles it', async () => {
    // A proven refusal releases.
    let t = setup();
    t.queue.push(refused(409, 'PROJECT_BUSY', 'Busy.'));
    t.deleteForm().requestSubmit();
    await flush();
    t.queue.push(committed('asset-renamed', { filename: 'next.png' }), t.serverPage('next', { filename: 'next.png' }));
    t.renameInput.value = 'next.png';
    t.submit('asset-rename-form');
    await flush();
    expect(t.posts().map((post) => post.url)).toEqual([action('delete'), action('rename')]);

    // A failure the service restored releases.
    t = setup();
    t.queue.push(jsonResponse(500, { status: 'error', code: 'DELETE_DATABASE_OPERATION_FAILED', outcome: 'failed', message: 'Restored.' }));
    t.deleteForm().requestSubmit();
    await flush();
    t.queue.push(committed('asset-moved', { destination: '5' }), t.serverPage('moved', { destination: '5' }));
    t.moveSelect.value = '5';
    t.submit('asset-move-form');
    await flush();
    expect(t.posts().map((post) => post.url)).toEqual([action('delete'), action('move')]);
    expect(t.deleteForm().hasAttribute('data-asset-delete-hold')).toBe(false);

    // Recovery-required (answer received) stays protected.
    t = setup();
    t.queue.push(jsonResponse(500, {
      status: 'error', code: 'DELETE_RECOVERY_REQUIRED', outcome: 'recovery-required', recoveryRequired: true, message: LOST_RECOVERY_BODY,
    }), t.serverPage('kept', {}));
    t.deleteForm().requestSubmit();
    await flush();
    t.submit('asset-rename-form');
    await flush();
    expect(t.fileText()).toBe('This asset cannot be changed from this page until the project folder has been inspected. Reload the page to try again.');
    attemptEverything(t);
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.deleteText().startsWith(`${LOST_RECOVERY_BODY} Your unsaved changes were kept.`)).toBe(true);

    // Cleanup-incomplete keeps terminal protection.
    t = setup();
    t.queue.push(jsonResponse(500, {
      status: 'error', code: 'DELETE_RECOVERY_REQUIRED', outcome: 'deleted-cleanup-incomplete', recoveryRequired: true,
      assetDeleted: true, projectId: PROJECT_ID, assetId: ASSET_ID, message: 'Left staged.',
    }));
    t.deleteForm().requestSubmit();
    await flush();
    attemptEverything(t);
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(assetViewerRetired(t.document)).toBe(true);
  });

  it('C6: an older read resolving late never unlocks the unresolved Delete', async () => {
    const t = setup();
    // A tag save's read is out when Delete begins.
    t.queue.push(jsonResponse(200, { status: 'success', outcome: 'committed', tagIds: [1, 2], projectId: PROJECT_ID, assetId: ASSET_ID }));
    const tagRead = deferred();
    t.queue.push(() => tagRead.promise);
    t.tagForm.querySelector('input[value="2"]').checked = true;
    t.tagForm.requestSubmit();
    await flush();
    const check = deferred();
    t.queue.push(lost, () => check.promise);
    t.deleteForm().requestSubmit();
    await flush();
    tagRead.resolve(t.serverPage('old', { savedTagIds: ['1', '2'] }));
    await flush();
    expect(t.deleteForm().getAttribute('data-asset-delete-hold')).toBe('unresolved');
    check.resolve(t.serverPage('present', { savedTagIds: ['1', '2'] }));
    await flush();
    expect(t.deleteText()).toBe(STILL_LISTED);
    attemptEverything(t);
    await flush();
    expect(deletePosts(t)).toHaveLength(1);
    expect(t.posts()).toHaveLength(2);

    // A host retired by an observed absence never comes back.
    t.queue.push(htmlResponse('', 404));
    t.deleteRetry().click();
    await flush();
    expect(assetViewerRetired(t.document)).toBe(true);
    expect((await refreshAssetViewer(t.document, { regions: ['file'] })).status).toBe('unavailable');
    expect(t.windowObject.location.replace).not.toHaveBeenCalled();
  });

  it('C7: unsaved tag, filename, destination and Book choices survive the lost answer and every read-only check', async () => {
    const t = setup();
    enterDrafts(t);
    t.queue.push(lost, htmlResponse('', 500), t.serverPage('present', {}), t.serverPage('again', {}));
    t.deleteForm().requestSubmit();
    await flush();
    expectDraftsKept(t);
    t.deleteRetry().click();
    await flush();
    expectDraftsKept(t);
    t.deleteRetry().click();
    await flush();
    expectDraftsKept(t);
    expect(t.posts()).toHaveLength(1);
    expect(t.gets()).toHaveLength(3);
  });

  it('C8: replayed confirmations and keyboard submits send one Delete POST per approved action', async () => {
    const t = setup();
    const post = deferred();
    t.queue.push(() => post.promise, t.serverPage('present', {}));
    t.deleteForm().requestSubmit();
    t.deleteForm().requestSubmit();
    t.deleteForm().dispatch('submit');
    await flush();
    post.reject(new TypeError('lost'));
    await flush();
    for (let i = 0; i < 3; i += 1) {
      t.deleteForm().requestSubmit();
      t.deleteForm().dispatch('submit');
    }
    await flush();
    expect(deletePosts(t)).toHaveLength(1);
    expect(t.gets()).toHaveLength(1);
  });
});

describe('Delete — reviewed state (F2)', () => {
  const STALE_MESSAGE = 'This asset was renamed, moved or replaced after the deletion was reviewed, so it was not deleted. Review the asset as it is now and delete it again if you still want to.';
  const review = (t) => t.deleteForm().querySelector('input[data-asset-delete-review]');
  const sentReview = (post) => post.body.get('deleteReview');

  it('a Rename’s viewer refresh installs the new reviewed state; the next Delete sends it', async () => {
    const t = setup();
    expect(review(t).value).toBe('v1.review-hero.png-uncategorized');
    t.queue.push(committed('asset-renamed', { filename: 'after.png' }), t.serverPage('renamed', { filename: 'after.png' }));
    t.renameInput.value = 'after.png';
    t.submit('asset-rename-form');
    await flush();
    expect(t.shown().filename).toBe('after.png');
    expect(review(t).value).toBe('v1.review-after.png-uncategorized');

    t.queue.push(deleted());
    t.deleteForm().requestSubmit();
    await flush();
    expect(deletePosts(t)).toHaveLength(1);
    expect(sentReview(deletePosts(t)[0])).toBe('v1.review-after.png-uncategorized');
  });

  it('a Move’s refresh installs it too; a refresh that fails leaves the old state (refused later, never deleted)', async () => {
    const t = setup();
    t.queue.push(committed('asset-moved', { destination: '5' }), t.serverPage('moved', { destination: '5' }));
    t.moveSelect.value = '5';
    t.submit('asset-move-form');
    await flush();
    expect(review(t).value).toBe('v1.review-hero.png-5');

    t.queue.push(committed('asset-moved', { destination: '6' }), htmlResponse('', 500));
    t.moveSelect.value = '6';
    t.submit('asset-move-form');
    await flush();
    expect(review(t).value).toBe('v1.review-hero.png-5');
  });

  it('the submitted Delete keeps the state captured at its confirmation', async () => {
    const t = setup();
    const answer = deferred();
    t.queue.push(() => answer.promise);
    t.deleteForm().requestSubmit();
    await flush();
    review(t).setAttribute('value', 'v1.changed-later');
    answer.resolve(deleted());
    await flush();
    expect(sentReview(deletePosts(t)[0])).toBe('v1.review-hero.png-uncategorized');
  });

  it('a stale refusal keeps the page and drafts, reads the asset as it is now (GET only), and never resends', async () => {
    const t = setup();
    enterDrafts(t);
    const img = image(t);
    t.queue.push(refused(409, 'DELETE_STALE_ASSET', STALE_MESSAGE),
      t.serverPage('current', { filename: 'subject.png', destination: '5' }));
    t.deleteForm().requestSubmit();
    await flush();

    expect(deletePosts(t)).toHaveLength(1);
    expect(t.gets()).toHaveLength(1);
    expect(t.deleteText()).toBe(`${STALE_MESSAGE} Nothing was deleted. Your unsaved changes were kept.`);
    expect(t.windowObject.location.replace).not.toHaveBeenCalled();
    expect(t.windowObject.location.assign).not.toHaveBeenCalled();
    expect(assetViewerRetired(t.document)).toBe(false);
    expect(t.deleteForm().hasAttribute('data-asset-delete-hold')).toBe(false);
    expect(dialogs.frozen).toBe(0);
    // The page shows the asset as it is now, with its reviewed state.
    expect(t.shown()).toMatchObject({ filename: 'subject.png', destination: '5' });
    expect(review(t).value).toBe('v1.review-subject.png-5');
    expect(t.renameInput.getAttribute('data-confirmed-value')).toBe('subject.png');
    expect(image(t)).toBe(img);
    // Unsaved drafts stay as entered.
    expect(t.tagForm.querySelector('input[value="2"]').checked).toBe(true);
    expect(t.bookSelect.value).toBe('3');
    expect(t.renameInput.value).toBe('draft-name.png');
    expect(t.moveSelect.value).toBe('5');

    // Only a new, explicit Delete sends again, with the state now shown.
    t.queue.push(deleted());
    t.deleteForm().requestSubmit();
    await flush();
    expect(deletePosts(t)).toHaveLength(2);
    expect(sentReview(deletePosts(t)[1])).toBe('v1.review-subject.png-5');
  });

  it('a stale refusal whose read finds the asset gone ends on the missing state without navigating', async () => {
    const t = setup();
    t.queue.push(refused(409, 'DELETE_STALE_ASSET', STALE_MESSAGE), htmlResponse('', 404));
    t.deleteForm().requestSubmit();
    await flush();
    expect(deletePosts(t)).toHaveLength(1);
    expect(t.deleteForm().getAttribute('data-asset-delete-hold')).toBe('missing');
    expect(t.windowObject.location.replace).not.toHaveBeenCalled();
  });
});

// F3: while a Delete is unconfirmed or needs recovery, dismissing Edit Asset
// keeps every unsaved draft (they stay unsaved and refused); otherwise it
// still resets to the saved values. In this shim Escape, Close and the
// backdrop are one call of the dialog binder's beforeClose/onClose hooks (the
// binder is a stand-in); Chromium covers the real key, button and backdrop.
describe('Delete — F3: dismissal keeps drafts while Delete is unresolved', () => {
  const lost = () => Promise.reject(new TypeError('network'));
  const RECOVERY_BODY = 'The asset was not deleted, but CreatorCrate could not safely put its file back after the deletion failed.';

  // The dialog binder's close sequence: the guard, then the close hook.
  function dismiss(t, via) {
    const allowed = t.appDialogState.beforeClose({ lifecycle: 1, opener: via });
    if (allowed === true) t.appDialogState.onClose();
    return allowed;
  }

  function attemptEverything(t) {
    t.deleteForm().requestSubmit();
    t.deleteButton.dispatch('click');
    t.submit('asset-rename-form');
    t.submit('asset-move-form');
    t.form('asset-primary-image-set-form').requestSubmit();
    t.form('asset-book-primary-image-set-form').requestSubmit();
  }

  function expectReset(t) {
    expect(t.tagForm.querySelector('input[value="1"]').checked).toBe(true);
    expect(t.tagForm.querySelector('input[value="2"]').checked).toBe(false);
    expect(t.bookSelect.value).toBe('');
    expect(t.renameInput.value).toBe('hero.png');
    expect(t.moveSelect.value).toBe('uncategorized');
  }

  it.each(['escape', 'close-button', 'backdrop'])('C1–C3 (%s): a held Delete keeps all four drafts and their baselines through dismissal and reopening', async (via) => {
    const t = setup();
    enterDrafts(t);
    t.queue.push(lost, t.serverPage('present', {}));
    t.deleteForm().requestSubmit();
    await flush();
    expect(t.deleteText()).toBe(STILL_LISTED);

    expect(dismiss(t, via)).toBe(true);
    // Reopened: the same mounted controls.
    expectDraftsKept(t);
    expect(t.deleteForm().getAttribute('data-asset-delete-hold')).toBe('unresolved');
    expect(t.deleteText()).toBe(STILL_LISTED);
    expect(t.deleteRetry()).not.toBeNull();
    attemptEverything(t);
    await flush();
    expect(t.posts()).toHaveLength(1);
    expectDraftsKept(t);
  });

  it('C4: after a lost answer and a GET that finds the asset listed, drafts survive repeated dismissals, a late GET and a status change while closed', async () => {
    const t = setup();
    enterDrafts(t);
    t.queue.push(lost, t.serverPage('present', {}));
    t.deleteForm().requestSubmit();
    await flush();
    dismiss(t, 'escape');
    expectDraftsKept(t);

    // Check again goes out, the dialog is dismissed while it is out, and the
    // GET returns (and rewrites the status) while the dialog is closed.
    const check = deferred();
    t.queue.push(() => check.promise);
    t.deleteRetry().click();
    expect(t.deleteText()).toBe('The deletion could not be confirmed. Checking whether the asset still exists…');
    dismiss(t, 'escape');
    check.resolve(t.serverPage('still', {}));
    await flush();
    expect(t.deleteText()).toBe(STILL_LISTED);
    dismiss(t, 'close-button');
    expectDraftsKept(t);
    expect(t.gets()).toHaveLength(2);
    expect(t.posts()).toHaveLength(1);
    expect(t.deleteForm().getAttribute('data-asset-delete-hold')).toBe('unresolved');
    expect(assetViewerRetired(t.document)).toBe(false);
  });

  it('C5: after a lost answer and a failed GET, drafts survive dismissal; Check again stays GET only', async () => {
    const t = setup();
    enterDrafts(t);
    t.queue.push(lost, htmlResponse('', 500));
    t.deleteForm().requestSubmit();
    await flush();
    expect(t.deleteText()).toBe('The deletion could not be confirmed. The asset could not be checked. Your unsaved changes were kept.');
    dismiss(t, 'backdrop');
    expectDraftsKept(t);
    t.queue.push(htmlResponse('', 500));
    t.deleteRetry().click();
    await flush();
    dismiss(t, 'escape');
    expectDraftsKept(t);
    attemptEverything(t);
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.gets()).toHaveLength(2);
    expect(t.deleteRetry().textContent).toBe('Check again');
  });

  it('C6: an acknowledged recovery-required answer keeps drafts and the hold through dismissal', async () => {
    const t = setup();
    enterDrafts(t);
    t.queue.push(jsonResponse(500, {
      status: 'error', code: 'DELETE_RECOVERY_REQUIRED', outcome: 'recovery-required', recoveryRequired: true, message: RECOVERY_BODY,
    }), t.serverPage('kept', {}));
    t.deleteForm().requestSubmit();
    await flush();
    expect(t.deleteForm().getAttribute('data-asset-delete-hold')).toBe('recovery');
    dismiss(t, 'escape');
    expectDraftsKept(t);
    expect(t.deleteText()).toBe(`${RECOVERY_BODY} Your unsaved changes were kept.`);
    expect(t.deleteText()).not.toContain('restored');
    attemptEverything(t);
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.deleteForm().getAttribute('data-asset-delete-hold')).toBe('recovery');
    expectDraftsKept(t);
  });

  it('C7: an empty tag draft stays empty, and the saved tags stay the baseline', async () => {
    const t = setup({ savedTagIds: ['1', '2'] });
    t.tagForm.querySelectorAll('input[type="checkbox"]').forEach((input) => { input.checked = false; });
    t.queue.push(lost, t.serverPage('present', { savedTagIds: ['1', '2'] }));
    t.deleteForm().requestSubmit();
    await flush();
    dismiss(t, 'escape');
    expect(t.tagForm.querySelectorAll('input[type="checkbox"]').map((input) => input.checked)).toEqual([false, false]);
    expect(t.tagForm.getAttribute('data-confirmed-tag-ids')).toBe('1,2');
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.posts().some((post) => post.url === action('tags'))).toBe(false);
  });

  it('C8: an unrelated read installing newer saved values while closed moves the baselines only, not the drafts or the hold', async () => {
    const t = setup();
    enterDrafts(t);
    t.queue.push(lost, t.serverPage('present', {}));
    t.deleteForm().requestSubmit();
    await flush();
    dismiss(t, 'escape');
    // Another read of the page (not this Delete's) installs what is saved now.
    t.queue.push(t.serverPage('elsewhere', { filename: 'elsewhere.png', destination: '6', savedTagIds: ['2'] }));
    const result = await refreshAssetViewer(t.document, { regions: ['file', 'tags'] });
    expect(result.status).toBe('installed');
    dismiss(t, 'escape');
    expect(t.renameInput.getAttribute('data-confirmed-value')).toBe('elsewhere.png');
    expect(t.moveSelect.getAttribute('data-confirmed-value')).toBe('6');
    expect(t.tagForm.getAttribute('data-confirmed-tag-ids')).toBe('2');
    expect(t.renameInput.value).toBe('draft-name.png');
    expect(t.moveSelect.value).toBe('5');
    expect(t.bookSelect.value).toBe('3');
    expect(t.tagForm.querySelectorAll('input[type="checkbox"]').map((input) => input.checked)).toEqual([true, true]);
    expect(t.deleteForm().getAttribute('data-asset-delete-hold')).toBe('unresolved');
    attemptEverything(t);
    await flush();
    expect(t.posts()).toHaveLength(1);
  });

  it('C9: with no held Delete, dismissal still resets every control to its saved value', () => {
    const t = setup();
    enterDrafts(t);
    expect(dismiss(t, 'escape')).toBe(true);
    expectReset(t);
    expect(t.tagForm.getAttribute('data-confirmed-tag-ids')).toBe('1');
    expect(t.requests).toHaveLength(0);
  });

  it('C10: a refused or rolled-back Delete keeps drafts while open, releases the hold, and dismissal resets as before', async () => {
    for (const answer of [
      refused(409, 'PROJECT_BUSY', 'Busy.'),
      jsonResponse(500, { status: 'error', code: 'DELETE_FAILED', outcome: 'failed', message: 'Restored.' }),
    ]) {
      const t = setup();
      enterDrafts(t);
      t.queue.push(answer);
      t.deleteForm().requestSubmit();
      await flush();
      expectDraftsKept(t);
      expect(t.deleteForm().hasAttribute('data-asset-delete-hold')).toBe(false);
      // Safe actions are usable again: an explicit Rename sends its POST.
      t.queue.push(committed('rename', { filename: 'draft-name.png' }), t.serverPage('renamed', { filename: 'draft-name.png' }));
      t.submit('asset-rename-form');
      await flush();
      expect(t.posts().map((post) => post.url)).toEqual([action('delete'), action('rename')]);
      dismiss(t, 'escape');
      expect(t.renameInput.value).toBe('draft-name.png');
      expect(t.moveSelect.value).toBe('uncategorized');
      expect(t.bookSelect.value).toBe('');
      expect(t.tagForm.querySelector('input[value="2"]').checked).toBe(false);
    }
  });

  it('C11: a confirmed deletion retires the host, keeps no drafts and sends nothing more', async () => {
    const t = setup();
    enterDrafts(t);
    t.queue.push(deleted());
    t.deleteForm().requestSubmit();
    await flush();
    expect(t.windowObject.location.replace).toHaveBeenCalledTimes(1);
    dismiss(t, 'escape');
    expectReset(t);
    expect(assetViewerRetired(t.document)).toBe(true);
    expect(t.deleteForm().getAttribute('data-asset-delete-hold')).toBe('deleted');
    attemptEverything(t);
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.windowObject.location.replace).toHaveBeenCalledTimes(1);

    // An unresolved Delete later observed missing is terminal too: no drafts kept.
    const u = setup();
    enterDrafts(u);
    u.queue.push(lost, u.serverPage('present', {}), htmlResponse('', 404));
    u.deleteForm().requestSubmit();
    await flush();
    u.deleteRetry().click();
    await flush();
    expect(u.deleteForm().getAttribute('data-asset-delete-hold')).toBe('missing');
    dismiss(u, 'escape');
    expectReset(u);
    expect(u.posts()).toHaveLength(1);
    expect(u.windowObject.location.replace).not.toHaveBeenCalled();
  });

  it('C12: one asset’s held drafts never reach another asset’s Edit Asset dialog', async () => {
    const held = setup();
    enterDrafts(held);
    held.queue.push(lost, held.serverPage('present', {}));
    held.deleteForm().requestSubmit();
    await flush();
    const other = setup({ filename: 'other.png' });
    enterDrafts(other);
    dismiss(other, 'escape');
    expect(other.renameInput.value).toBe('other.png');
    expect(other.moveSelect.value).toBe('uncategorized');
    expect(other.bookSelect.value).toBe('');
    expect(other.tagForm.querySelector('input[value="2"]').checked).toBe(false);
    dismiss(held, 'escape');
    expectDraftsKept(held);
    expect(other.requests).toHaveLength(0);
  });
});

describe('Delete — native fallback', () => {
  it('leaves the native form submission alone without fetch', () => {
    const t = setup({}, { fetch: false });
    t.deleteForm().requestSubmit();
    expect(t.document.nativeSubmits).toEqual([t.deleteForm()]);
    expect(t.deleteButton.dispatch('click').defaultPrevented).toBe(false);
  });
});
