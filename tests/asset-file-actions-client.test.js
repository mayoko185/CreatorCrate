import { describe, it, expect, vi, beforeEach } from 'vitest';

// WP10A3-A: Edit Asset's Rename and Move forms submit in place
// (asset-edit-dialog.js) and the Asset detail refresh installs the 'file'
// region (asset-viewer-refresh.js). The dialog binder and dropdowns are
// stand-ins; the DOM is the purpose-built shim of the WP10A1/WP10A2 suites
// (no jsdom in this project).

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
const { assetViewerFileState } = await import('../src/static/client/asset-viewer-refresh.js');

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
  kind = 'image', prev = true, next = true, savedTagIds = ['1'], primarySelected = false,
  // The Book Set and Delete forms too (the WP10A3-A F2 cross-action tests).
  extras = false,
  // F2B: the reviewed-state token both file forms carry (the server renders
  // one per asset state; here it is named after the state it stands for).
  review = `v1.${filename}@${destination}`,
} = {}) {
  const reviewInput = () => h('input', { type: 'hidden', name: 'assetReview', value: review, 'data-asset-review': '' });
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
        extras ? h('form', { method: 'post', action: action('book-primary-image'), class: 'asset-action-form asset-book-primary-image-set-form' },
          csrf(), h('select', { name: 'bookId', id: 'book-primary-image-book-native' },
            h('option', { value: '3' }, 'Book Three')), h('button', { type: 'submit' }, 'Set as book primary image')) : null),
      h('section', {}, h('h3', { id: 'asset-actions-heading' }, 'File actions'),
        h('form', { class: 'asset-action-form asset-rename-form', method: 'post', action: action('rename') },
          csrf(), h('input', { type: 'hidden', name: 'origin', value: 'viewer' }), reviewInput(),
          h('input', { type: 'hidden', name: 'category', value: 'all' }), renameInput, renameButton),
        h('form', { class: 'asset-action-form asset-move-form', method: 'post', action: action('move') },
          csrf(), reviewInput(), h('input', { type: 'hidden', name: 'category', value: 'all' }), moveSelect, moveButton)),
      extras ? h('section', {}, h('h3', {}, 'Delete asset'),
        h('form', { class: 'asset-action-form asset-delete-form', method: 'post', action: action('delete'), 'data-confirm-submit-required': '' },
          csrf(), h('input', { type: 'hidden', name: 'deleteReview', value: 'v1.review', 'data-asset-delete-review': '' }),
          h('button', { class: 'button button-danger', type: 'submit', 'data-confirm': 'The file will be permanently deleted.' }, 'Delete asset'))) : null),
    h('div', { class: 'app-dialog-status', 'data-dialog-status': '', role: 'status', 'aria-live': 'polite' }));
  const body = h('body', {},
    h('nav', {}, h('a', { class: 'asset-viewer-back', href: `/assets?page=${filteredOut ? 1 : 2}` }),
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
  return { body, host, dialog, tagForm, renameInput, moveSelect, renameButton, moveButton, title: `Assets — ${filename}` };
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
  return {
    ...page, document, windowObject, appDialogState, requests, queue, posts, gets, form, submit,
    status, fileText, primaryText, tagText, retry, serverPage, shown, held,
  };
}

// The standing warnings of an unresolved or recovery-held Rename/Move (F2).
const UNRESOLVED_TAIL = 'Your request may still run, or may have only partly completed, so this asset cannot be renamed, moved or otherwise changed from this page. Check again only reads the saved details and sends nothing; reload the page once that request can no longer be running.';
const RECOVERY_TAIL = 'This asset cannot be renamed, moved or otherwise changed from this page until the project folder has been inspected. Reload the page to try again.';

const flush = async () => { for (let i = 0; i < 40; i += 1) await Promise.resolve(); };

beforeEach(() => {
  dialogs.freezes = 0;
  dialogs.restores = 0;
  dialogs.frozen = 0;
  dropdowns.initialized = [];
});

const image = (t) => t.host.querySelector('img');
const nav = (t, name) => t.host.querySelector(`a.asset-preview-nav--${name}`);

// ------------------------------------------------------------------ tests --

describe('Rename — local submission', () => {
  it('renames with one JSON POST of the complete filename and installs the saved file in place', async () => {
    const t = setup();
    const img = image(t);
    t.renameInput.value = 'cover-final.png';
    t.moveSelect.value = '5'; // an unsent Move draft
    t.tagForm.querySelector('input[value="2"]').checked = true; // an unsent tag choice
    t.queue.push(committed('asset-renamed', { filename: 'cover-final.png' }),
      t.serverPage('renamed', { filename: 'cover-final.png', preview: '/preview?v=2' }));

    t.submit('asset-rename-form');
    expect(t.form('asset-rename-form').getAttribute('aria-busy')).toBe('true');
    expect(t.fileText()).toBe('Renaming the file to “cover-final.png”…');
    expect(dialogs.frozen).toBe(1);
    await flush();

    const [post] = t.posts();
    expect(t.posts()).toHaveLength(1);
    expect(post.url).toBe(action('rename'));
    expect(post.accept).toBe('application/json');
    expect(post.body.get('filename')).toBe('cover-final.png');
    expect(post.body.get('origin')).toBe('viewer');
    expect(post.body.get('category')).toBe('all');
    expect(post.body.getAll('_csrf')).toEqual(['token-1']);
    expect(post.body.get('destinationCategory')).toBeNull();
    expect(t.gets().map((get) => get.url)).toEqual([t.windowObject.location.href]);
    expect(t.document.nativeSubmits).toHaveLength(0);
    expect(dialogs.frozen).toBe(0);

    expect(t.fileText()).toBe('The file was renamed to “cover-final.png”.');
    expect(t.status().getAttribute('data-asset-file-action-state')).toBe('saved');
    expect(t.renameInput.getAttribute('data-confirmed-value')).toBe('cover-final.png');
    expect(t.renameInput.value).toBe('cover-final.png');
    expect(t.shown()).toEqual({ filename: 'cover-final.png', destination: 'uncategorized', categoryLabel: 'Uncategorized', filteredOut: false });
    expect(t.document.title).toBe('Assets — cover-final.png');
    // The media host and its image element stay; only stale URLs and labels change.
    expect(t.document.querySelector('[data-asset-viewer-host]')).toBe(t.host);
    expect(image(t)).toBe(img);
    expect(img.getAttribute('src')).toBe('/preview?v=2');
    expect(t.host.querySelector('a.asset-preview-link').getAttribute('aria-label')).toBe('View original cover-final.png');
    expect(t.document.querySelector('a.asset-viewer-open-locally').getAttribute('href')).toBe('file:///uncategorized/cover-final.png');
    // Unrelated drafts and baselines survive.
    expect(t.moveSelect.value).toBe('5');
    expect(t.moveSelect.getAttribute('data-confirmed-value')).toBe('uncategorized');
    expect(t.tagForm.querySelector('input[value="2"]').checked).toBe(true);
    expect(t.tagForm.getAttribute('data-confirmed-tag-ids')).toBe('1');
    expect(t.held()).toEqual([null, null]);
    expect(t.dialog.querySelectorAll('[aria-live]')).toHaveLength(1);
  });

  it('refuses locally, keeps the attempted name and the baseline, and stays usable', async () => {
    const t = setup();
    t.renameInput.value = 'other.png';
    t.queue.push(refused(409, 'DESTINATION_CONFLICT', 'Destination already exists.'));
    t.submit('asset-rename-form');
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.gets()).toHaveLength(0);
    expect(t.fileText()).toBe('Destination already exists. Nothing was changed, and your entry was kept.');
    expect(t.status().getAttribute('data-asset-file-action-state')).toBe('error');
    expect(t.renameInput.value).toBe('other.png');
    expect(t.renameInput.getAttribute('data-confirmed-value')).toBe('hero.png');
    expect(t.shown().filename).toBe('hero.png');
    expect(t.held()).toEqual([null, null]);
    // Corrected and sent again: an explicit second submission is a second POST.
    t.renameInput.value = 'fixed.png';
    t.queue.push(committed('asset-renamed', { filename: 'fixed.png' }), t.serverPage('fixed', { filename: 'fixed.png' }));
    t.submit('asset-rename-form');
    await flush();
    expect(t.posts()).toHaveLength(2);
    expect(t.fileText()).toBe('The file was renamed to “fixed.png”.');
  });

  it('treats an operational failure the server says changed nothing as a refusal', async () => {
    const t = setup();
    t.renameInput.value = 'x.png';
    t.queue.push(jsonResponse(500, { status: 'error', code: 'FILESYSTEM_OPERATION_FAILED', outcome: 'failed', message: 'The operation could not be completed. Please try again.' }));
    t.submit('asset-rename-form');
    await flush();
    expect(t.fileText()).toBe('The operation could not be completed. Please try again. Nothing was changed, and your entry was kept.');
    expect(t.gets()).toHaveLength(0);
  });

  it('sends one POST however often it is submitted while pending', async () => {
    const t = setup();
    const post = deferred();
    t.renameInput.value = 'once.png';
    t.queue.push(() => post.promise);
    t.submit('asset-rename-form');
    t.submit('asset-rename-form');
    t.form('asset-rename-form').dispatch('submit');
    t.submit('asset-move-form');
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.fileText()).toBe('Wait for the current change to finish, then try again.');
    const read = deferred();
    t.queue.push(() => read.promise);
    post.resolve(committed('asset-renamed', { filename: 'once.png' }));
    await flush();
    // Enter again while the page refresh is out: held, not resent.
    expect(t.held()).toEqual(['refresh', 'refresh']);
    expect(t.renameButton.getAttribute('aria-disabled')).toBe('true');
    t.submit('asset-rename-form');
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.fileText()).toBe('The file was renamed to “once.png”. Wait for the file details to refresh, then try again.');
    read.resolve(t.serverPage('once', { filename: 'once.png' }));
    await flush();
    expect(t.held()).toEqual([null, null]);
    expect(t.renameButton.hasAttribute('aria-disabled')).toBe(false);
    expect(t.posts()).toHaveLength(1);
  });

  it('moves focus from the submitted form to the section heading after a confirmed change, never to the body', async () => {
    const t = setup();
    t.renameInput.value = 'focus.png';
    t.renameButton.focus();
    t.queue.push(committed('asset-renamed', { filename: 'focus.png' }), t.serverPage('f', { filename: 'focus.png' }));
    t.submit('asset-rename-form');
    await flush();
    const heading = t.dialog.querySelector('#asset-actions-heading');
    expect(t.document.activeElement).toBe(heading);
    expect(heading.getAttribute('tabindex')).toBe('-1');
  });

  it('leaves focus on the field after a refusal, so the entry can be corrected', async () => {
    const t = setup();
    t.renameInput.value = 'bad/name.png';
    t.renameInput.focus();
    t.queue.push(refused(422, 'INVALID_FILENAME', 'Enter a valid filename.'));
    t.submit('asset-rename-form');
    await flush();
    expect(t.document.activeElement).toBe(t.renameInput);
  });

  it('submits natively when fetch is unavailable', () => {
    const t = setup({}, { fetch: false });
    t.submit('asset-rename-form');
    t.submit('asset-move-form');
    expect(t.document.nativeSubmits).toHaveLength(2);
  });

  it('binds once', async () => {
    const t = setup();
    enhanceAssetEditDialog(t.document);
    expect(t.dialog.listenerCount('submit')).toBe(2);
    t.renameInput.value = 'b.png';
    t.queue.push(refused(422, 'INVALID_FILENAME', 'Enter a valid filename.'));
    t.submit('asset-rename-form');
    await flush();
    expect(t.posts()).toHaveLength(1);
  });
});

describe('Move — local submission', () => {
  it('moves with the canonical destination, keeps the host and reports a filtered-out asset truthfully', async () => {
    const t = setup();
    const img = image(t);
    t.renameInput.value = 'draft-name.png'; // an unsent Rename draft
    t.moveSelect.value = '5';
    t.queue.push(committed('asset-moved', { destination: '5' }),
      t.serverPage('moved', { destination: '5', filteredOut: true, prev: false, next: false, preview: '/preview?v=3' }));

    t.submit('asset-move-form');
    expect(t.fileText()).toBe('Moving the file to Renders…');
    await flush();

    const [post] = t.posts();
    expect(post.url).toBe(action('move'));
    expect(post.body.get('destinationCategory')).toBe('5');
    expect(post.body.get('filename')).toBeNull();
    expect(t.fileText()).toBe('The file was moved to Renders. This asset no longer matches the current asset-browser filters, so Previous and Next are unavailable.');
    expect(t.moveSelect.getAttribute('data-confirmed-value')).toBe('5');
    expect(t.moveSelect.value).toBe('5');
    expect(t.renameInput.value).toBe('draft-name.png');
    expect(t.renameInput.getAttribute('data-confirmed-value')).toBe('hero.png');
    expect(t.shown()).toEqual({ filename: 'hero.png', destination: '5', categoryLabel: 'Renders', filteredOut: true });
    const notice = t.document.querySelector('[data-asset-viewer-region="filter-notice"]');
    expect(notice.textContent).toContain('outside the current asset-browser filters');
    expect(t.document.querySelector('[data-asset-viewer-region="file-details"]').textContent).toBe('Renders');
    expect(t.document.querySelector('a.asset-viewer-back').getAttribute('href')).toBe('/assets?page=1');
    // Still the same asset, the same host and image: not treated as deleted.
    expect(t.document.querySelector('[data-asset-viewer-host]')).toBe(t.host);
    expect(t.host.getAttribute('data-asset-viewer-asset-id')).toBe(String(ASSET_ID));
    expect(image(t)).toBe(img);
    expect(nav(t, 'previous')).toBeNull();
    expect(nav(t, 'next')).toBeNull();
    expect(t.fileText()).not.toMatch(/deleted/);
  });

  it('restores Previous/Next when a later move brings the asset back into the filter', async () => {
    const t = setup({ filteredOut: true, prev: false, next: false, destination: '5' });
    t.moveSelect.value = 'uncategorized';
    t.queue.push(committed('asset-moved', { destination: 'uncategorized' }), t.serverPage('back', { destination: 'uncategorized' }));
    t.submit('asset-move-form');
    await flush();
    const children = t.host.childNodes.filter((node) => node.tagName === 'A');
    expect(children.map((node) => node.getAttribute('rel'))).toEqual(['prev', 'next']);
    expect(nav(t, 'next').getAttribute('href')).toBe('/next?uncategorized');
    expect(t.shown().filteredOut).toBe(false);
    expect(t.fileText()).toBe('The file was moved to Uncategorized.');
  });

  it('moves the focus from a removed Previous link to the Preview heading', async () => {
    const t = setup();
    t.moveSelect.value = '5';
    t.queue.push(committed('asset-moved', { destination: '5' }), () => {
      nav(t, 'previous').focus();
      return t.serverPage('gone', { destination: '5', filteredOut: true, prev: false, next: false });
    });
    t.submit('asset-move-form');
    await flush();
    expect(t.document.activeElement).toBe(t.document.querySelector('#asset-preview-heading'));
    expect(t.document.activeElement.getAttribute('tabindex')).toBe('-1');
  });
});

describe('media host', () => {
  it('leaves a video element and its source alone when the move does not change its URL', async () => {
    const t = setup({ kind: 'video' });
    const video = t.host.querySelector('video');
    const src = video.getAttribute('src');
    t.moveSelect.value = '6';
    t.queue.push(committed('asset-moved', { destination: '6' }), t.serverPage('v', { kind: 'video', destination: '6' }));
    t.submit('asset-move-form');
    await flush();
    expect(t.host.querySelector('video')).toBe(video);
    expect(video.getAttribute('src')).toBe(src);
  });

  it('rebuilds the media inside the same host only when its kind changed', async () => {
    const t = setup();
    t.renameInput.value = 'hero.txt';
    t.queue.push(committed('asset-renamed', { filename: 'hero.txt' }), t.serverPage('u', { filename: 'hero.txt', kind: 'unsupported' }));
    t.submit('asset-rename-form');
    await flush();
    expect(t.document.querySelector('[data-asset-viewer-host]')).toBe(t.host);
    expect(t.host.querySelector('img')).toBeNull();
    expect(t.host.textContent).toContain('Unsupported asset preview.');
    // Media first, then Previous and Next, as rendered.
    expect(t.host.childNodes.map((node) => node.tagName)).toEqual(['DIV', 'A', 'A']);
  });

  it('reads the primary-image regions with a rename (its extension can change eligibility), not with a move', async () => {
    const t = setup();
    t.renameInput.value = 'hero.txt';
    t.queue.push(committed('asset-renamed', { filename: 'hero.txt' }), t.serverPage('p', { filename: 'hero.txt', primarySelected: true }));
    t.submit('asset-rename-form');
    await flush();
    expect(t.document.querySelector('[data-asset-viewer-region="project-primary-image"]').getAttribute('data-primary-image-selected')).toBe('true');
    expect(t.form('asset-primary-image-remove-form')).not.toBeNull();

    const m = setup();
    m.moveSelect.value = '5';
    m.queue.push(committed('asset-moved', { destination: '5' }), m.serverPage('pm', { destination: '5', primarySelected: true }));
    m.submit('asset-move-form');
    await flush();
    expect(m.document.querySelector('[data-asset-viewer-region="project-primary-image"]').getAttribute('data-primary-image-selected')).toBe('false');
  });
});

describe('failed refresh — GET-only Retry refresh', () => {
  it('keeps the acknowledged success, holds the forms and retries the GET only', async () => {
    const t = setup();
    t.renameInput.value = 'cover.png';
    t.queue.push(committed('asset-renamed', { filename: 'cover.png' }), htmlResponse('broken', 500));
    t.submit('asset-rename-form');
    await flush();
    expect(t.fileText()).toBe('The file was renamed to “cover.png”. The file details shown on this page may be out of date.');
    expect(t.renameInput.getAttribute('data-confirmed-value')).toBe('cover.png');
    expect(t.shown().filename).toBe('hero.png');
    expect(t.held()).toEqual(['stale', 'stale']);
    expect(t.retry().textContent).toBe('Retry refresh');
    t.submit('asset-move-form');
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.fileText()).toMatch(/Use Retry refresh or Check again before renaming or moving this file\.$/);

    t.queue.push(t.serverPage('ok', { filename: 'cover.png', preview: '/preview?v=9' }));
    t.retry().click();
    expect(t.fileText()).toBe('Refreshing the file details…');
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.gets()).toHaveLength(2);
    expect(t.fileText()).toBe('The file was renamed to “cover.png”.');
    expect(t.shown().filename).toBe('cover.png');
    expect(image(t).getAttribute('src')).toBe('/preview?v=9');
    expect(t.held()).toEqual([null, null]);
    expect(t.retry()).toBeNull();
  });

  it('a later tag save’s GET installs the owed file region and settles it', async () => {
    const t = setup();
    t.renameInput.value = 'cover.png';
    t.queue.push(committed('asset-renamed', { filename: 'cover.png' }), htmlResponse('broken', 500));
    t.submit('asset-rename-form');
    await flush();
    t.tagForm.querySelector('input[value="2"]').checked = true;
    t.queue.push(jsonResponse(200, { status: 'success', outcome: 'committed', projectId: PROJECT_ID, assetId: ASSET_ID, tagIds: ['1', '2'] }),
      t.serverPage('both', { filename: 'cover.png', savedTagIds: ['1', '2'] }));
    t.tagForm.requestSubmit();
    await flush();
    expect(t.shown().filename).toBe('cover.png');
    expect(t.fileText()).toBe('The file was renamed to “cover.png”.');
    expect(t.held()).toEqual([null, null]);
    expect(t.tagText()).toBe('Asset tags updated.');
  });
});

describe('uncertain response — GET-only Check again', () => {
  it('never resends a lost POST and reports the saved state as not proof', async () => {
    const t = setup();
    t.renameInput.value = 'cover.png';
    t.queue.push(() => Promise.reject(new TypeError('network')), t.serverPage('same', { filename: 'hero.png' }));
    t.submit('asset-rename-form');
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.gets()).toHaveLength(1);
    expect(t.fileText()).toBe(`The rename could not be confirmed. The saved filename is “hero.png”. This is what is saved now; it does not show whether your request ran. ${UNRESOLVED_TAIL}`);
    expect(t.status().getAttribute('data-asset-file-action-state')).toBe('uncertain');
    // The attempted name is a draft, not reset to a guess.
    expect(t.renameInput.value).toBe('cover.png');
    expect(t.renameInput.getAttribute('data-confirmed-value')).toBe('hero.png');
  });

  it('does not claim success from an observed filename that matches', async () => {
    const t = setup();
    t.renameInput.value = 'cover.png';
    t.queue.push(jsonResponse(500, { status: 'error', code: 'ASSET_ACTION_FAILED', outcome: 'unknown', message: 'The rename could not be confirmed.' }),
      t.serverPage('match', { filename: 'cover.png' }));
    t.submit('asset-rename-form');
    await flush();
    expect(t.fileText()).toBe(`The rename could not be confirmed. The saved filename is “cover.png”. This is what is saved now; it does not show whether your request ran. ${UNRESOLVED_TAIL}`);
    expect(t.fileText()).not.toMatch(/was renamed/);
  });

  it('offers Check again (a GET) when the read fails, and holds both file forms meanwhile', async () => {
    const t = setup();
    t.moveSelect.value = '5';
    t.queue.push(jsonResponse(502, null), htmlResponse('x', 500));
    t.submit('asset-move-form');
    await flush();
    expect(t.fileText()).toBe(`The move could not be confirmed. The saved file details could not be read. ${UNRESOLVED_TAIL}`);
    expect(t.retry().textContent).toBe('Check again');
    expect(t.held()).toEqual(['unresolved', 'unresolved']);
    t.submit('asset-rename-form');
    await flush();
    expect(t.posts()).toHaveLength(1);

    t.queue.push(t.serverPage('later', { destination: '6' }));
    t.retry().click();
    expect(t.fileText()).toBe('The move could not be confirmed. Checking the saved file details…');
    await flush();
    expect(t.posts()).toHaveLength(1);
    // Moved elsewhere by someone else: reported as saved now, never as this request.
    expect(t.fileText()).toBe(`The move could not be confirmed. The asset is saved in WIP. This is what is saved now; it does not show whether your request ran. ${UNRESOLVED_TAIL}`);
    expect(t.moveSelect.value).toBe('5');
    expect(t.moveSelect.getAttribute('data-confirmed-value')).toBe('6');
    // A read is not the lost request's answer: the hold stands (F2).
    expect(t.held()).toEqual(['unresolved', 'unresolved']);
    expect(t.retry().textContent).toBe('Check again');
  });

  it('reports recovery-required as such and reads what the records hold', async () => {
    const t = setup();
    t.renameInput.value = 'cover.png';
    const message = 'The file was moved on disk, but CreatorCrate could not finish updating its records. Inspect the project folder before scanning or trying again.';
    t.queue.push(jsonResponse(500, { status: 'error', code: 'RECOVERY_REQUIRED', outcome: 'recovery-required', recoveryRequired: true, message }),
      t.serverPage('old', { filename: 'hero.png' }));
    t.submit('asset-rename-form');
    await flush();
    expect(t.fileText()).toBe(`${message} The details shown are CreatorCrate’s records, which may not match the project folder. ${RECOVERY_TAIL}`);
    expect(t.status().getAttribute('data-asset-file-action-state')).toBe('error');
    expect(t.fileText()).not.toMatch(/Nothing was changed/);
    expect(t.renameInput.value).toBe('cover.png');
    expect(t.posts()).toHaveLength(1);
  });

  it('reports an asset that can no longer be read without offering a retry', async () => {
    const t = setup();
    t.renameInput.value = 'cover.png';
    t.queue.push(() => Promise.reject(new Error('lost')), htmlResponse('nf', 404));
    t.submit('asset-rename-form');
    await flush();
    expect(t.fileText()).toBe('The rename could not be confirmed. This asset can no longer be read. It may have been deleted elsewhere.');
    expect(t.retry()).toBeNull();
    expect(t.held()).toEqual(['gone', 'gone']);
  });
});

describe('coordination with tag and primary-image actions', () => {
  it('refuses a rename while a primary-image change is out, keeping the draft, and vice versa', async () => {
    const t = setup();
    const post = deferred();
    t.queue.push(() => post.promise);
    t.submit('asset-primary-image-set-form');
    t.renameInput.value = 'waiting.png';
    t.submit('asset-rename-form');
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.fileText()).toBe('Wait for the current change to finish, then try again.');
    expect(t.renameInput.value).toBe('waiting.png');
    t.queue.push(t.serverPage('pi', { primarySelected: true }));
    post.resolve(committed('primary-image-set'));
    await flush();

    const rename = deferred();
    t.queue.push(() => rename.promise);
    t.submit('asset-rename-form');
    t.submit('asset-primary-image-remove-form');
    t.tagForm.querySelector('input[value="2"]').checked = true;
    t.tagForm.requestSubmit();
    await flush();
    expect(t.posts().map((p) => p.url)).toEqual([action('primary-image'), action('rename')]);
    expect(t.primaryText()).toBe('Wait for the current change to finish, then try again.');
    expect(t.tagText()).toBe('Wait for the primary image change to finish, then change the tags.');
    t.queue.push(t.serverPage('done', { filename: 'waiting.png', primarySelected: true }));
    rename.resolve(committed('asset-renamed', { filename: 'waiting.png' }));
    await flush();
    expect(t.fileText()).toBe('The file was renamed to “waiting.png”.');
    expect(t.form('asset-primary-image-remove-form')).not.toBeNull();
    expect(t.tagForm.getAttribute('data-confirmed-tag-ids')).toBe('1');
  });

  it('an older tag GET resolving after the rename never restores the old filename', async () => {
    const t = setup();
    const tagRead = deferred();
    t.tagForm.querySelector('input[value="2"]').checked = true;
    t.queue.push(jsonResponse(200, { status: 'success', outcome: 'committed', projectId: PROJECT_ID, assetId: ASSET_ID, tagIds: ['1', '2'] }),
      () => tagRead.promise);
    t.tagForm.requestSubmit();
    await flush();
    t.renameInput.value = 'new.png';
    t.queue.push(committed('asset-renamed', { filename: 'new.png' }), t.serverPage('new', { filename: 'new.png', savedTagIds: ['1', '2'] }));
    t.submit('asset-rename-form');
    await flush();
    expect(t.shown().filename).toBe('new.png');
    // The superseded read arrives late with the page as it was before.
    tagRead.resolve(t.serverPage('stale', { filename: 'hero.png', savedTagIds: ['1', '2'] }));
    await flush();
    expect(t.shown().filename).toBe('new.png');
    expect(t.renameInput.getAttribute('data-confirmed-value')).toBe('new.png');
    // The owed Tags region was installed by the rename's read.
    expect(t.document.querySelector('[data-asset-viewer-region="tags"]').textContent).toBe('tags:1,2');
    expect(t.tagText()).toBe('Asset tags updated.');
  });
});

describe('close and reopen', () => {
  it('restores the saved baselines after a rename and keeps an open GET obligation visible', async () => {
    const t = setup();
    t.renameInput.value = 'saved.png';
    t.queue.push(committed('asset-renamed', { filename: 'saved.png' }), htmlResponse('x', 500));
    t.submit('asset-rename-form');
    await flush();
    t.renameInput.value = 'scratch.png';
    t.moveSelect.value = '6';
    t.appDialogState.onClose();
    expect(t.renameInput.value).toBe('saved.png');
    expect(t.moveSelect.value).toBe('uncategorized');
    expect(t.fileText()).toBe('The file details could not be read. They may be out of date.');
  });
});

// ---------------------------------------------------------- WP10A3-A F2 --
// A Rename or Move whose answer was lost may still reach the service after
// any read of the page. No GET (this module's, another action's, failed,
// superseded or late) releases its hold; only its own answer could.

const HELD_RENAME = 'This asset cannot be changed from this page while the earlier rename is unconfirmed. Use Check again, or reload the page once that request can no longer be running.';
const HELD_MOVE = 'This asset cannot be changed from this page while the earlier move is unconfirmed. Use Check again, or reload the page once that request can no longer be running.';
const HELD_RECOVERY = 'This asset cannot be changed from this page until the project folder has been inspected. Reload the page to try again.';
const NOT_PROOF = 'This is what is saved now; it does not show whether your request ran.';
const lost = () => Promise.reject(new TypeError('network'));
const tagCommitted = (tagIds) => jsonResponse(200, { status: 'success', outcome: 'committed', projectId: PROJECT_ID, assetId: ASSET_ID, tagIds });
const deleteText = (t) => t.dialog.querySelector('[data-asset-delete-status-text]')?.textContent || '';

async function lostRename(t, filename = 'earlier.png', observed = { filename: 'hero.png' }) {
  t.renameInput.value = filename;
  t.queue.push(lost, observed ? t.serverPage(`observed-${filename}-${observed.filename}`, observed) : htmlResponse('x', 500));
  t.submit('asset-rename-form');
  await flush();
}

describe('F2 — an unresolved Rename or Move survives every read', () => {
  it('C1: unknown Rename, then a GET of the unchanged row: still held, a second Rename sends nothing', async () => {
    const t = setup();
    await lostRename(t);
    expect(t.posts()).toHaveLength(1);
    expect(t.gets()).toHaveLength(1);
    expect(t.shown().filename).toBe('hero.png');
    expect(t.held()).toEqual(['unresolved', 'unresolved']);
    expect(t.renameButton.getAttribute('aria-disabled')).toBe('true');
    expect(t.moveButton.getAttribute('aria-disabled')).toBe('true');
    const warning = `The rename could not be confirmed. The saved filename is “hero.png”. ${NOT_PROOF} ${UNRESOLVED_TAIL}`;
    expect(t.fileText()).toBe(warning);
    expect(t.status().getAttribute('data-asset-file-action-state')).toBe('uncertain');
    expect(t.retry().textContent).toBe('Check again');
    // Nothing about the lost request is attributed to the baseline.
    expect(t.renameInput.getAttribute('data-confirmed-value')).toBe('hero.png');

    t.renameInput.value = 'latest.png';
    t.submit('asset-rename-form');
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.gets()).toHaveLength(1);
    // The warning stays, with the refusal added to it.
    expect(t.fileText()).toBe(`${warning} ${HELD_RENAME}`);
    expect(t.renameInput.value).toBe('latest.png');
    expect(t.renameInput.getAttribute('data-confirmed-value')).toBe('hero.png');
    expect(t.dialog.querySelectorAll('[aria-live]')).toHaveLength(1);
  });

  it('C2: unknown Move, then a GET of the original category: Rename and Move both refused', async () => {
    const t = setup();
    t.moveSelect.value = '5';
    t.queue.push(lost, t.serverPage('orig', { destination: 'uncategorized' }));
    t.submit('asset-move-form');
    await flush();
    expect(t.held()).toEqual(['unresolved', 'unresolved']);
    expect(t.fileText()).toBe(`The move could not be confirmed. The asset is saved in Uncategorized. ${NOT_PROOF} ${UNRESOLVED_TAIL}`);
    t.moveSelect.value = '6';
    t.submit('asset-move-form');
    t.renameInput.value = 'other.png';
    t.submit('asset-rename-form');
    await flush();
    expect(t.posts().map((post) => post.url)).toEqual([action('move')]);
    expect(t.fileText().endsWith(HELD_MOVE)).toBe(true);
    expect(t.moveSelect.getAttribute('data-confirmed-value')).toBe('uncategorized');
    expect(t.moveSelect.value).toBe('6');
  });

  it('C3: a GET already showing the requested name proves nothing and releases nothing', async () => {
    const t = setup();
    await lostRename(t, 'earlier.png', { filename: 'earlier.png' });
    expect(t.shown().filename).toBe('earlier.png');
    expect(t.fileText()).toBe(`The rename could not be confirmed. The saved filename is “earlier.png”. ${NOT_PROOF} ${UNRESOLVED_TAIL}`);
    expect(t.fileText()).not.toMatch(/was renamed/);
    expect(t.held()).toEqual(['unresolved', 'unresolved']);
    t.renameInput.value = 'latest.png';
    t.submit('asset-rename-form');
    await flush();
    expect(t.posts()).toHaveLength(1);
  });

  it('C4: a failed GET keeps the hold and warning; Check again sends GETs only, however often', async () => {
    const t = setup();
    await lostRename(t, 'earlier.png', null);
    expect(t.held()).toEqual(['unresolved', 'unresolved']);
    expect(t.fileText()).toBe(`The rename could not be confirmed. The saved file details could not be read. ${UNRESOLVED_TAIL}`);
    expect(t.status().getAttribute('data-asset-file-action-state')).toBe('uncertain');

    // Check again fails again: still held, still offered.
    t.queue.push(htmlResponse('y', 503));
    t.retry().focus();
    t.retry().click();
    expect(t.fileText()).toBe('The rename could not be confirmed. Checking the saved file details…');
    await flush();
    expect(t.fileText()).toBe(`The rename could not be confirmed. The saved file details could not be read. ${UNRESOLVED_TAIL}`);
    expect(t.held()).toEqual(['unresolved', 'unresolved']);
    expect(t.document.activeElement).toBe(t.retry());

    // Check again reads the page: still held, still offered, focus kept on it.
    t.queue.push(t.serverPage('read', { filename: 'hero.png' }));
    t.retry().click();
    await flush();
    expect(t.held()).toEqual(['unresolved', 'unresolved']);
    expect(t.retry().textContent).toBe('Check again');
    expect(t.document.activeElement).toBe(t.retry());
    t.queue.push(t.serverPage('read2', { filename: 'hero.png' }));
    t.retry().click();
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.gets()).toHaveLength(4);
    expect(t.held()).toEqual(['unresolved', 'unresolved']);
  });

  it('C5: another action’s GET that installs the file region cannot release the hold', async () => {
    const t = setup();
    // A confirmed tag save whose page read failed: its Retry refresh stays offered.
    t.tagForm.querySelector('input[value="2"]').checked = true;
    t.queue.push(tagCommitted(['1', '2']), htmlResponse('t', 500));
    t.tagForm.requestSubmit();
    await flush();
    await lostRename(t, 'earlier.png', null);
    expect(t.held()).toEqual(['unresolved', 'unresolved']);

    // The tag module's GET installs every owed region, the file region included.
    t.queue.push(t.serverPage('both', { filename: 'hero.png', savedTagIds: ['1', '2'] }));
    t.dialog.querySelector('[data-asset-tags-retry]').click();
    await flush();
    expect(t.gets()).toHaveLength(3);
    expect(t.shown().filename).toBe('hero.png');
    expect(t.tagText()).toBe('Asset tags updated.');
    expect(t.held()).toEqual(['unresolved', 'unresolved']);
    expect(t.fileText()).toBe(`The rename could not be confirmed. The saved filename is “hero.png”. ${NOT_PROOF} ${UNRESOLVED_TAIL}`);
    expect(t.retry().textContent).toBe('Check again');
    t.submit('asset-rename-form');
    await flush();
    expect(t.posts()).toHaveLength(2);
  });

  it('C6: dismissal keeps the hold, the warning, Check again and every unsaved draft', async () => {
    const t = setup();
    await lostRename(t);
    expect(dialogs.frozen).toBe(0); // settled: the dialog can be dismissed
    const warning = t.fileText();
    t.renameInput.value = 'latest.png';
    t.moveSelect.value = '6';
    t.tagForm.querySelector('input[value="2"]').checked = true;
    t.appDialogState.onClose();
    expect(t.renameInput.value).toBe('latest.png');
    expect(t.moveSelect.value).toBe('6');
    expect(t.tagForm.querySelector('input[value="2"]').checked).toBe(true);
    expect(t.renameInput.getAttribute('data-confirmed-value')).toBe('hero.png');
    expect(t.moveSelect.getAttribute('data-confirmed-value')).toBe('uncategorized');
    expect(t.tagForm.getAttribute('data-confirmed-tag-ids')).toBe('1');
    expect(t.fileText()).toBe(warning);
    expect(t.retry().textContent).toBe('Check again');
    expect(t.held()).toEqual(['unresolved', 'unresolved']);
    // Reopened (the controls stay mounted) and closed again: unchanged.
    t.appDialogState.onClose();
    t.submit('asset-rename-form');
    t.submit('asset-move-form');
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.renameInput.value).toBe('latest.png');
  });

  it('C7: Tag Save, both primary-image Sets, Delete, Rename and Move are all refused', async () => {
    const t = setup({ extras: true });
    await lostRename(t, 'earlier.png', { filename: 'hero.png', extras: true });
    const warning = t.fileText();
    t.tagForm.querySelector('input[value="2"]').checked = true;
    t.tagForm.requestSubmit();
    t.submit('asset-primary-image-set-form');
    t.submit('asset-book-primary-image-set-form');
    t.form('asset-delete-form').querySelector('button').click();
    t.submit('asset-delete-form');
    t.submit('asset-rename-form');
    t.form('asset-move-form').dispatch('submit');
    await flush();
    expect(t.posts().map((post) => post.url)).toEqual([action('rename')]);
    expect(t.document.nativeSubmits).toHaveLength(0);
    expect(t.tagText()).toBe(`${HELD_RENAME} Your latest tag selection was not saved.`); // WP10A1-F3: the draft is kept, not reset
    expect(t.primaryText()).toBe(HELD_RENAME);
    expect(deleteText(t)).toBe(HELD_RENAME);
    expect(t.fileText()).toBe(`${warning} ${HELD_RENAME}`);
  });

  it('C8: a known refusal before any change releases at once; a later action is sent', async () => {
    const t = setup({ extras: true });
    t.renameInput.value = 'taken.png';
    t.queue.push(refused(409, 'DESTINATION_CONFLICT', 'Destination already exists.'));
    t.submit('asset-rename-form');
    await flush();
    expect(t.held()).toEqual([null, null]);
    t.moveSelect.value = '5';
    t.queue.push(jsonResponse(500, { status: 'error', code: 'FILESYSTEM_OPERATION_FAILED', outcome: 'failed', message: 'The operation could not be completed. Please try again.' }));
    t.submit('asset-move-form');
    await flush();
    expect(t.held()).toEqual([null, null]);
    t.queue.push(jsonResponse(200, { status: 'success', outcome: 'committed', projectId: PROJECT_ID, assetId: ASSET_ID }),
      t.serverPage('pi', { primarySelected: true, extras: true }));
    t.submit('asset-primary-image-set-form');
    await flush();
    expect(t.posts().map((post) => post.url)).toEqual([action('rename'), action('move'), action('primary-image')]);
  });

  it('C9: an acknowledged Rename and Move still advance their baselines and settle on the read', async () => {
    const t = setup();
    t.renameInput.value = 'a.png';
    t.queue.push(committed('asset-renamed', { filename: 'a.png' }), t.serverPage('a', { filename: 'a.png' }));
    t.submit('asset-rename-form');
    await flush();
    t.moveSelect.value = '6';
    t.queue.push(committed('asset-moved', { filename: 'a.png', destination: '6' }), t.serverPage('b', { filename: 'a.png', destination: '6' }));
    t.submit('asset-move-form');
    await flush();
    expect(t.posts()).toHaveLength(2);
    expect(t.renameInput.getAttribute('data-confirmed-value')).toBe('a.png');
    expect(t.moveSelect.getAttribute('data-confirmed-value')).toBe('6');
    expect(t.fileText()).toBe('The file was moved to WIP.');
    expect(t.held()).toEqual([null, null]);
    expect(t.retry()).toBeNull();
  });

  it('C10: a confirmed change with a failed read stays acknowledged, is not a standing hold, and retries the GET only', async () => {
    const t = setup({ extras: true });
    t.moveSelect.value = '5';
    t.queue.push(committed('asset-moved', { destination: '5' }), htmlResponse('x', 500));
    t.submit('asset-move-form');
    await flush();
    expect(t.fileText()).toBe('The file was moved to Renders. The file details shown on this page may be out of date.');
    expect(t.retry().textContent).toBe('Retry refresh');
    expect(t.held()).toEqual(['stale', 'stale']);
    // Not a standing hold: a dismissal resets the drafts as usual.
    t.renameInput.value = 'draft.png';
    t.appDialogState.onClose();
    expect(t.renameInput.value).toBe('hero.png');
    expect(t.moveSelect.value).toBe('5');
    t.queue.push(t.serverPage('ok', { destination: '5' }));
    t.retry().click();
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.held()).toEqual([null, null]);
    expect(t.fileText()).toBe('The file was moved to Renders.');
  });

  it('C11: recovery-required holds through the read of the original record and through dismissal', async () => {
    const t = setup({ extras: true });
    const message = 'The file was moved on disk, but CreatorCrate could not finish updating its records. Inspect the project folder before scanning or trying again.';
    t.renameInput.value = 'cover.png';
    t.queue.push(jsonResponse(500, { status: 'error', code: 'RECOVERY_REQUIRED', outcome: 'recovery-required', recoveryRequired: true, message }),
      t.serverPage('old', { filename: 'hero.png', extras: true }));
    t.submit('asset-rename-form');
    await flush();
    expect(t.held()).toEqual(['recovery', 'recovery']);
    expect(t.retry()).toBeNull();
    t.appDialogState.onClose();
    expect(t.renameInput.value).toBe('cover.png');
    expect(t.fileText()).toBe(`${message} The details shown are CreatorCrate’s records, which may not match the project folder. ${RECOVERY_TAIL}`);
    t.submit('asset-rename-form');
    t.submit('asset-move-form');
    t.tagForm.requestSubmit();
    t.submit('asset-delete-form');
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.tagText()).toBe(`${HELD_RECOVERY} Your latest tag selection was not saved.`); // WP10A1-F3: the draft is kept, not reset
    expect(deleteText(t)).toBe(HELD_RECOVERY);
    expect(t.held()).toEqual(['recovery', 'recovery']);
  });

  it('C12: a late, superseded read cannot replace or release the unresolved state', async () => {
    const t = setup();
    const tagRead = deferred();
    t.tagForm.querySelector('input[value="2"]').checked = true;
    t.queue.push(tagCommitted(['1', '2']), () => tagRead.promise);
    t.tagForm.requestSubmit();
    await flush();
    await lostRename(t, 'earlier.png', { filename: 'hero.png', savedTagIds: ['1', '2'] });
    const warning = t.fileText();
    tagRead.resolve(t.serverPage('late', { filename: 'stale.png', savedTagIds: ['1', '2'] }));
    await flush();
    expect(t.shown().filename).toBe('hero.png');
    expect(t.fileText()).toBe(warning);
    expect(t.held()).toEqual(['unresolved', 'unresolved']);
    // A Check again whose answer arrives after a dismissal still changes nothing.
    const check = deferred();
    t.queue.push(() => check.promise);
    t.retry().click();
    t.appDialogState.onClose();
    check.resolve(t.serverPage('check', { filename: 'earlier.png' }));
    await flush();
    expect(t.held()).toEqual(['unresolved', 'unresolved']);
    expect(t.retry().textContent).toBe('Check again');
    expect(t.posts()).toHaveLength(2);
  });

  it('C13: with nothing held, closing still resets the drafts to the saved values', async () => {
    const t = setup();
    t.renameInput.value = 'taken.png';
    t.queue.push(refused(409, 'DESTINATION_CONFLICT', 'Destination already exists.'));
    t.submit('asset-rename-form');
    await flush();
    t.moveSelect.value = '6';
    t.tagForm.querySelector('input[value="2"]').checked = true;
    t.appDialogState.onClose();
    expect(t.renameInput.value).toBe('hero.png');
    expect(t.moveSelect.value).toBe('uncategorized');
    expect(t.tagForm.querySelector('input[value="2"]').checked).toBe(false);
    expect(t.fileText()).toBe('');
  });

  it('C14: repeated submissions while in flight and after the loss never add a POST', async () => {
    const t = setup();
    const post = deferred();
    t.renameInput.value = 'earlier.png';
    t.queue.push(() => post.promise);
    t.submit('asset-rename-form');
    t.form('asset-rename-form').dispatch('submit');
    t.submit('asset-rename-form');
    t.submit('asset-move-form');
    await flush();
    expect(t.posts()).toHaveLength(1);
    t.queue.push(t.serverPage('o', { filename: 'hero.png' }));
    post.reject(new TypeError('lost'));
    await flush();
    for (let i = 0; i < 5; i += 1) {
      t.submit('asset-rename-form');
      t.form('asset-move-form').dispatch('submit');
    }
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.gets()).toHaveLength(1);
    expect(t.document.nativeSubmits).toHaveLength(0);
  });
});

// F2B: both file forms carry the reviewed state of the asset the page shows
// (assetReview). The request sends the one captured at submission; a confirmed
// refresh installs the next one; a stale refusal reads the page again (GET
// only) and never resends.
describe('F2B — the reviewed state a Rename or Move is sent with', () => {
  const STALE = 'This asset was renamed, moved or replaced after this change was reviewed, so it was not renamed. Review the asset as it is now and submit the change again if you still want to.';
  const reviews = (t) => [t.form('asset-rename-form'), t.form('asset-move-form')]
    .map((form) => form.querySelector('input[data-asset-review]').value);
  const sentReview = (post) => post.body.get('assetReview');

  it('F2B-C1. sends the review captured at submission; a refresh during the request cannot change it', async () => {
    const t = setup();
    const answer = deferred();
    t.renameInput.value = 'earlier.png';
    t.queue.push(() => answer.promise);
    t.submit('asset-rename-form');
    // Something else rewrites the shown review once the request is captured.
    [t.form('asset-rename-form'), t.form('asset-move-form')]
      .forEach((form) => form.querySelector('input[data-asset-review]').setAttribute('value', 'v1.later'));
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(sentReview(t.posts()[0])).toBe('v1.hero.png@uncategorized');
    expect(t.posts()[0].body.get('filename')).toBe('earlier.png');
    answer.resolve(committed('asset-renamed', { filename: 'earlier.png' }));
    t.queue.push(t.serverPage('earlier', { filename: 'earlier.png' }));
    await flush();
    expect(sentReview(t.posts()[0])).toBe('v1.hero.png@uncategorized');
  });

  it('F2B-C2. a confirmed refresh installs the new review in both forms; the next change sends it', async () => {
    const t = setup();
    t.renameInput.value = 'renamed.png';
    t.queue.push(committed('asset-renamed', { filename: 'renamed.png' }), t.serverPage('r', { filename: 'renamed.png' }));
    t.submit('asset-rename-form');
    await flush();
    expect(reviews(t)).toEqual(['v1.renamed.png@uncategorized', 'v1.renamed.png@uncategorized']);

    // Rename → Move, then Move → Rename, each with what the page now shows.
    t.moveSelect.value = '5';
    t.queue.push(committed('asset-moved', { filename: 'renamed.png', destination: '5' }), t.serverPage('m', { filename: 'renamed.png', destination: '5' }));
    t.submit('asset-move-form');
    await flush();
    expect(sentReview(t.posts()[1])).toBe('v1.renamed.png@uncategorized');
    expect(reviews(t)).toEqual(['v1.renamed.png@5', 'v1.renamed.png@5']);

    t.renameInput.value = 'final.png';
    t.queue.push(committed('asset-renamed', { filename: 'final.png', destination: '5' }), t.serverPage('f', { filename: 'final.png', destination: '5' }));
    t.submit('asset-rename-form');
    await flush();
    expect(sentReview(t.posts()[2])).toBe('v1.renamed.png@5');
    expect(reviews(t)).toEqual(['v1.final.png@5', 'v1.final.png@5']);
    expect(t.posts()).toHaveLength(3);
    expect(t.held()).toEqual([null, null]);
  });

  it('F2B-C3. a stale refusal reads the page once (GET only), keeps the entry and installs the current review', async () => {
    const t = setup();
    t.renameInput.value = 'earlier.png';
    t.moveSelect.value = '6'; // an unsent Move draft
    t.queue.push(refused(409, 'ASSET_REVIEW_STALE', STALE), t.serverPage('latest', { filename: 'latest.png' }));
    t.submit('asset-rename-form');
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.gets()).toHaveLength(1);
    expect(dialogs.frozen).toBe(0);
    expect(t.fileText()).toBe(`${STALE} Nothing was changed, and your entry was kept.`);
    expect(t.status().getAttribute('data-asset-file-action-state')).toBe('error');
    // The page shows the asset as it is; the drafts stay; the new review is installed.
    expect(t.shown().filename).toBe('latest.png');
    expect(t.renameInput.getAttribute('data-confirmed-value')).toBe('latest.png');
    expect(t.renameInput.value).toBe('earlier.png');
    expect(t.moveSelect.value).toBe('6');
    expect(reviews(t)).toEqual(['v1.latest.png@uncategorized', 'v1.latest.png@uncategorized']);
    expect(t.held()).toEqual([null, null]);
    expect(t.retry()).toBeNull();

    // Submitting again is a new, intentional change against what is shown.
    t.queue.push(committed('asset-renamed', { filename: 'earlier.png' }), t.serverPage('again', { filename: 'earlier.png' }));
    t.submit('asset-rename-form');
    await flush();
    expect(t.posts()).toHaveLength(2);
    expect(sentReview(t.posts()[1])).toBe('v1.latest.png@uncategorized');
  });

  it('F2B-C4. a stale Move refused while its GET fails keeps the old review held, and Retry refresh is GET only', async () => {
    const t = setup();
    t.moveSelect.value = '5';
    t.queue.push(refused(409, 'ASSET_REVIEW_STALE', STALE.replace('not renamed', 'not moved')), htmlResponse('broken', 500));
    t.submit('asset-move-form');
    await flush();
    expect(t.held()).toEqual(['stale', 'stale']);
    expect(reviews(t)).toEqual(['v1.hero.png@uncategorized', 'v1.hero.png@uncategorized']);
    expect(t.retry().textContent).toBe('Retry refresh');
    // The old review is never sent again from this page while it is unconfirmed.
    t.submit('asset-move-form');
    t.submit('asset-rename-form');
    await flush();
    expect(t.posts()).toHaveLength(1);

    t.queue.push(t.serverPage('now', { filename: 'hero.png', destination: '6' }));
    t.retry().click();
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.gets()).toHaveLength(2);
    expect(reviews(t)).toEqual(['v1.hero.png@6', 'v1.hero.png@6']);
    expect(t.held()).toEqual([null, null]);
    expect(t.moveSelect.value).toBe('5');
  });

  it('F2B-C5. a committed change whose refresh fails sends nothing more with the old review', async () => {
    const t = setup();
    t.renameInput.value = 'cover.png';
    t.queue.push(committed('asset-renamed', { filename: 'cover.png' }), htmlResponse('broken', 500));
    t.submit('asset-rename-form');
    await flush();
    expect(reviews(t)).toEqual(['v1.hero.png@uncategorized', 'v1.hero.png@uncategorized']);
    t.moveSelect.value = '5';
    t.submit('asset-move-form');
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.held()).toEqual(['stale', 'stale']);
  });

  it('F2B-C6. an unresolved Rename stays held even when a read installs a newer review', async () => {
    const t = setup();
    t.renameInput.value = 'earlier.png';
    t.queue.push(() => Promise.reject(new TypeError('network')), t.serverPage('other-tab', { filename: 'latest.png' }));
    t.submit('asset-rename-form');
    await flush();
    expect(t.gets()).toHaveLength(1);
    expect(reviews(t)).toEqual(['v1.latest.png@uncategorized', 'v1.latest.png@uncategorized']);
    expect(t.held()).toEqual(['unresolved', 'unresolved']);
    t.submit('asset-move-form');
    t.submit('asset-rename-form');
    await flush();
    expect(t.posts()).toHaveLength(1);
  });
});
