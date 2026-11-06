import { describe, it, expect, vi, beforeEach } from 'vitest';

// WP10A1: the Edit Asset tag form's in-place save (asset-edit-dialog.js) and
// the Asset detail refresh it relies on (asset-viewer-refresh.js). The shared
// dialog binder and dropdown presentation are covered by their own suites (and
// together in Chromium); here they are stand-ins so the controller's own
// decisions are observable: which requests it sends, what it installs, and
// what it reports. The DOM is a purpose-built shim (no jsdom in this project).

const dialogs = vi.hoisted(() => ({ freezes: 0, restores: 0 }));
vi.mock('../src/static/client/app-dialogs.js', () => ({
  freezeAppDialog: () => {
    dialogs.freezes += 1;
    return () => { dialogs.restores += 1; };
  },
}));
vi.mock('../src/static/client/dropdowns.js', () => ({
  initializeCreatorCrateDropdown: () => {},
  syncCreatorCrateDropdownFromNative: () => {},
  updateAssetViewerFilterDisclosureState: () => {},
}));

const { enhanceAssetEditDialog } = await import('../src/static/client/asset-edit-dialog.js');
const {
  refreshAssetViewer,
  supersedeAssetViewerRefresh,
  assetViewerIdentity,
} = await import('../src/static/client/asset-viewer-refresh.js');

// ---------------------------------------------------------------- DOM shim --

function parseSelector(selector) {
  // Attribute values may contain brackets (name="tagIds[]"), so they are quoted tokens.
  const TOKEN = /#[\w-]+|\.[\w-]+|\[[\w-]+(?:="[^"]*")?\]/g;
  const match = selector.trim().match(/^([a-z]+)?((?:#[\w-]+|\.[\w-]+|\[[\w-]+(?:="[^"]*")?\])*)$/i);
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
  constructor(tagName, attributes = {}, children = []) {
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map(Object.entries(attributes).map(([key, value]) => [key, String(value)]));
    this.childNodes = [];
    this.parentNode = null;
    this.listeners = new Map();
    this.ownText = '';
    this.checked = false;
    children.forEach((child) => this.appendChild(child));
  }

  get ownerDocument() { return this.root()?.document || null; }
  root() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node.isDocumentRoot ? node : null;
  }
  get isConnected() { return Boolean(this.root()?.isLive); }
  get id() { return this.getAttribute('id') || ''; }
  get value() { return this.attributes.has('value') ? this.getAttribute('value') : ''; }
  set value(next) { this.attributes.set('value', String(next)); }
  get type() { return this.getAttribute('type') || ''; }
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
      type,
      target: this,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      ...init,
    };
    for (let node = this; node; node = node.parentNode) {
      (node.listeners.get(type) || []).forEach((listener) => listener(event));
    }
    return event;
  }
  focus() { const document = this.ownerDocument; if (document) document.activeElement = this; }
  click() { this.dispatch('click'); }
  requestSubmit() {
    const event = this.dispatch('submit');
    if (!event.defaultPrevented) this.ownerDocument.nativeSubmits.push(this);
  }
  reset() {
    this.querySelectorAll('input[type="checkbox"]').forEach((input) => {
      input.checked = input.hasAttribute('checked');
    });
  }
  clone() {
    const copy = new FakeNode(this.tagName, Object.fromEntries(this.attributes));
    copy.ownText = this.ownText;
    copy.checked = this.checked;
    this.childNodes.forEach((child) => copy.appendChild(child.clone()));
    return copy;
  }
}

function h(tag, attributes = {}, ...children) {
  const node = new FakeNode(tag, attributes);
  children.flat().forEach((child) => {
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
const CATALOG = [{ id: '1', label: 'Alpha' }, { id: '2', label: 'Beta' }, { id: '3', label: 'Gamma' }];

// A stand-in reviewed-state token (WP10A1-F3) naming a saved set: the client
// only carries it, never derives or checks it.
function reviewFor(ids) {
  return `t1.${`saved_${[...ids].sort().join('_') || 'none'}`.padEnd(43, 'x')}`;
}

function chips(ids) {
  const labels = CATALOG.filter((tag) => ids.includes(tag.id)).map((tag) => tag.label);
  return labels.length
    ? [h('ul', { class: 'tag-chip-list' }, labels.map((label) => h('li', { class: 'tag-chip' }, label)))]
    : [h('p', { class: 'help-text' }, 'No tags assigned to this asset.')];
}

function buildPage({
  savedIds = ['1'],
  assetId = ASSET_ID,
  filteredOut = false,
  nav = ['prev', 'next'],
  backHref = `/projects/${PROJECT_ID}/assets?page=1`,
  withTagForm = true,
  withOtherActions = false,
  review = reviewFor(savedIds),
} = {}) {
  const figure = h('figure', { class: 'asset-preview-frame' }, h('img', { class: 'asset-preview-image', src: '/preview.png' }));
  const host = h('div', {
    class: 'asset-preview-viewer',
    'data-asset-viewer-host': '',
    'data-asset-viewer-project-id': PROJECT_ID,
    'data-asset-viewer-asset-id': assetId,
  }, figure, nav.map((rel) => h('a', { class: 'asset-preview-nav', rel, href: `/projects/${PROJECT_ID}/assets/${rel === 'prev' ? 1 : 99}` })));

  const checkboxes = CATALOG.map((tag) => {
    const input = h('input', { type: 'checkbox', name: 'tagIds[]', value: tag.id, id: `asset-tags-form-option-${tag.id}` });
    if (savedIds.includes(tag.id)) { input.setAttribute('checked', ''); input.checked = true; }
    return input;
  });
  const tagForm = withTagForm ? h('form', {
    id: 'asset-edit-form',
    method: 'post',
    action: `/projects/${PROJECT_ID}/assets/${assetId}/tags`,
    'data-confirmed-tag-ids': savedIds.join(','),
    'data-dialog-form': '',
    'data-asset-tags-form': '',
  },
  h('input', { type: 'hidden', name: '_csrf', value: 'token-1' }),
  h('input', { type: 'hidden', name: 'origin', value: 'asset-edit' }),
  h('input', { type: 'hidden', name: 'tagReview', value: review, 'data-asset-tag-review': '' }),
  h('details', { id: 'asset-tags-form', 'data-cc-dropdown': '' }, checkboxes)) : null;

  const renameInput = h('input', { type: 'text', id: 'rename-filename', name: 'filename', value: 'hero.png', 'data-confirmed-value': 'hero.png' });
  const dialog = h('dialog', { id: 'asset-edit-dialog' },
    tagForm || h('p', {}, 'read only'),
    h('form', { class: 'asset-rename-form', method: 'post', action: `/projects/${PROJECT_ID}/assets/${assetId}/rename` }, renameInput),
    withOtherActions ? [
      h('form', { class: 'asset-move-form', method: 'post', action: `/projects/${PROJECT_ID}/assets/${assetId}/move` },
        h('select', { id: 'move-destination', name: 'destinationCategory', value: 'source', 'data-confirmed-value': 'source' })),
      h('form', { class: 'asset-primary-image-set-form', method: 'post', action: `/projects/${PROJECT_ID}/primary-image` },
        h('button', { type: 'submit' }, 'Set as project image')),
      h('form', { class: 'asset-book-primary-image-set-form', method: 'post', action: `/books/5/primary-image` },
        h('button', { type: 'submit' }, 'Set as book image')),
      h('form', { class: 'asset-delete-form', method: 'post', action: `/projects/${PROJECT_ID}/assets/${assetId}/delete` },
        h('button', { type: 'submit' }, 'Delete asset')),
    ] : [],
    h('div', { class: 'app-dialog-status', 'data-dialog-status': '', role: 'status', 'aria-live': 'polite' }));

  const body = h('body', {},
    h('a', { class: 'asset-viewer-back', href: backHref }),
    h('div', { 'data-asset-viewer-region': 'filter-notice' }, filteredOut ? [h('div', { class: 'notice notice--warning' }, 'outside the current filters')] : []),
    h('section', { class: 'asset-preview-section' }, host),
    h('section', { class: 'asset-tags-section' }, h('div', { 'data-asset-viewer-region': 'tags' }, chips(savedIds))),
    dialog);
  return { body, host, figure, dialog, tagForm, renameInput };
}

// --------------------------------------------------------------- harness --

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function jsonResponse(status, payload) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(payload) };
}

function htmlResponse(html, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: () => Promise.resolve(html) };
}

function success(ids, extra = {}) {
  return jsonResponse(200, {
    status: 'success', outcome: 'committed', message: 'Asset tags updated.',
    projectId: PROJECT_ID, assetId: ASSET_ID, tagIds: ids.map(Number), tags: [], refreshRequired: true,
    tagReview: reviewFor(ids.map(String)), ...extra,
  });
}

function setup(pageOptions = {}) {
  const page = buildPage(pageOptions);
  const document = createDocument(page.body);
  const requests = [];
  const queue = [];
  const pages = new Map();
  const windowObject = {
    location: { href: `http://creatorcrate.local/projects/${PROJECT_ID}/assets/${ASSET_ID}?tag=1` },
    FormData: class {
      constructor(form) {
        this.entries = form.querySelectorAll('input')
          .filter((input) => input.name && (input.type !== 'checkbox' || input.checked))
          .filter((input) => form.contains(input))
          .map((input) => [input.name, input.value]);
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
  const input = (id) => page.tagForm.querySelector(`input[type="checkbox"][name="tagIds[]"][value="${id}"]`);
  const selection = () => page.tagForm.querySelectorAll('input[type="checkbox"][name="tagIds[]"]')
    .filter((node) => node.checked).map((node) => node.value);
  const toggle = (id) => {
    const node = input(id);
    node.checked = !node.checked;
    node.dispatch('change');
  };
  const status = () => page.dialog.querySelector('[data-dialog-status]');
  const statusText = () => page.dialog.querySelector('[data-asset-tags-status-text]')?.textContent || '';
  const retry = () => page.dialog.querySelector('[data-asset-tags-retry]');
  const confirmed = () => page.tagForm.getAttribute('data-confirmed-tag-ids');
  const chipText = () => document.querySelector('[data-asset-viewer-region="tags"]').textContent;
  // Registers a server render the GET can return.
  const serverPage = (key, options) => { pages.set(key, () => buildPage(options)); return htmlResponse(key); };
  const close = () => page.dialog.__creatorCrateAppDialogState.onClose();
  return {
    ...page, document, windowObject, requests, queue, posts, gets, input, selection, toggle,
    status, statusText, retry, confirmed, chipText, serverPage, close,
  };
}

const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };

beforeEach(() => {
  dialogs.freezes = 0;
  dialogs.restores = 0;
});

// ------------------------------------------------------------------ tests --

describe('Edit Asset tag save — local submission', () => {
  it('sends the complete selection once as JSON, keeps the dialog and document, and advances the baseline', async () => {
    const t = setup({ savedIds: ['1'] });
    t.queue.push(success(['1', '2']), t.serverPage('page-12', { savedIds: ['1', '2'] }));

    t.toggle('2');
    expect(t.tagForm.getAttribute("aria-busy")).toBe("true");
    expect(t.statusText()).toBe('Saving tags…');
    expect(dialogs.freezes).toBe(1);
    await flush();

    expect(t.posts()).toHaveLength(1);
    const [post] = t.posts();
    expect(post.url).toBe(`/projects/${PROJECT_ID}/assets/${ASSET_ID}/tags`);
    expect(post.accept).toBe('application/json');
    expect(post.body.getAll('tagIds[]')).toEqual(['1', '2']);
    expect(post.body.getAll('origin')).toEqual(['asset-edit']);
    expect(t.document.nativeSubmits).toHaveLength(0);
    expect(dialogs.restores).toBe(1);
    expect(t.tagForm.hasAttribute('aria-busy')).toBe(false);
    expect(t.confirmed()).toBe('1,2');
    expect(t.selection()).toEqual(['1', '2']);
    expect(t.gets()).toHaveLength(1);
    expect(t.gets()[0].url).toBe(t.windowObject.location.href);
    expect(t.chipText()).toContain('Beta');
    expect(t.statusText()).toBe('Asset tags updated.');
    expect(t.dialog.isConnected).toBe(true);
  });

  it('sends an intentionally empty selection with no tagIds field and installs the empty baseline', async () => {
    const t = setup({ savedIds: ['1', '3'] });
    t.queue.push(success(['3']), t.serverPage('page-3', { savedIds: ['3'] }));
    t.toggle('1');
    await flush();
    t.queue.push(success([]), t.serverPage('page-empty', { savedIds: [] }));
    t.toggle('3');
    await flush();

    expect(t.posts()).toHaveLength(2);
    expect(t.posts()[1].body.has('tagIds[]')).toBe(false);
    expect(t.posts()[1].body.getAll('_csrf')).toEqual(['token-1']);
    expect(t.confirmed()).toBe('');
    expect(t.selection()).toEqual([]);
    expect(t.chipText()).toContain('No tags assigned to this asset.');
  });

  it('touches only the Tags region: media host, figure, navigation, other regions and an unrelated draft stay', async () => {
    const t = setup({ savedIds: ['1'] });
    t.renameInput.value = 'draft-name.png';
    const navBefore = t.host.querySelectorAll('.asset-preview-nav');
    const noticeBefore = t.document.querySelector('[data-asset-viewer-region="filter-notice"]').childNodes.slice();
    // Even a server render that differs elsewhere installs nothing but the tags.
    t.queue.push(success(['1', '2']), t.serverPage('page-nav', {
      savedIds: ['1', '2'], filteredOut: true, nav: [], backHref: `/projects/${PROJECT_ID}/assets?page=3`,
    }));

    t.toggle('2');
    await flush();

    expect(t.chipText()).toContain('Beta');
    expect(t.document.querySelector('[data-asset-viewer-host]')).toBe(t.host);
    expect(t.host.querySelector('figure')).toBe(t.figure);
    expect(t.figure.querySelector('img').getAttribute('src')).toBe('/preview.png');
    expect(t.host.querySelectorAll('.asset-preview-nav')).toEqual(navBefore);
    expect(navBefore.every((link) => link.isConnected)).toBe(true);
    expect(t.document.querySelector('[data-asset-viewer-region="filter-notice"]').childNodes).toEqual(noticeBefore);
    expect(t.document.querySelector('.asset-viewer-back').getAttribute('href')).toBe(`/projects/${PROJECT_ID}/assets?page=1`);
    expect(t.renameInput.value).toBe('draft-name.png');
    expect(t.dialog.isConnected).toBe(true);
    expect(t.document.nativeSubmits).toHaveLength(0);
  });

  it('binds once: enhancing again adds no second listener or request', async () => {
    const t = setup({ savedIds: [] });
    enhanceAssetEditDialog(t.document);
    enhanceAssetEditDialog(t.document);
    t.queue.push(success(['1']), t.serverPage('page-1', { savedIds: ['1'] }));
    t.toggle('1');
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.gets()).toHaveLength(1);
  });

  it('leaves the form to the native submission when fetch is unavailable', () => {
    const t = setup({ savedIds: [] });
    t.windowObject.fetch = undefined;
    t.tagForm.requestSubmit();
    expect(t.document.nativeSubmits).toEqual([t.tagForm]);
  });
});

describe('Edit Asset tag save — pending save and rapid changes', () => {
  it('refuses a change while a save is pending, restoring the selection the request holds', async () => {
    const t = setup({ savedIds: ['1'] });
    const post = deferred();
    t.queue.push(() => post.promise);

    t.toggle('2');
    t.toggle('3');
    expect(t.selection()).toEqual(['1', '2']);
    expect(t.statusText()).toBe('Wait for the tag save to finish, then try again.');
    t.tagForm.requestSubmit();
    await flush();
    expect(t.posts()).toHaveLength(1);

    t.queue.push(t.serverPage('page-12b', { savedIds: ['1', '2'] }));
    post.resolve(success(['1', '2']));
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.confirmed()).toBe('1,2');
    expect(t.selection()).toEqual(['1', '2']);
  });

  it('treats a change already submitted by the shared autosubmit binding as the same submission', async () => {
    const t = setup({ savedIds: [] });
    const node = t.input('1');
    // The shared data-autosubmit listener runs first on the control itself.
    node.addEventListener('change', () => t.tagForm.requestSubmit());
    t.queue.push(success(['1']), t.serverPage('page-auto', { savedIds: ['1'] }));
    node.checked = true;
    node.dispatch('change');
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.statusText()).toBe('Asset tags updated.');
  });

  it('never lets an older read install over a newer save, and the newer save installs its own', async () => {
    const t = setup({ savedIds: ['1'] });
    const olderRead = deferred();
    t.queue.push(success(['1', '2']), () => olderRead.promise);
    t.toggle('2');
    await flush();
    expect(t.confirmed()).toBe('1,2');

    const newerPost = deferred();
    t.queue.push(() => newerPost.promise);
    t.toggle('3');
    await flush();
    expect(t.posts()).toHaveLength(2);

    // The earlier GET answers late with the state before the newer save.
    t.serverPage('page-old', { savedIds: ['1', '2'] });
    olderRead.resolve(htmlResponse('page-old'));
    await flush();
    expect(t.statusText()).toBe('Saving tags…');

    t.queue.push(t.serverPage('page-new', { savedIds: ['1', '2', '3'] }));
    newerPost.resolve(success(['1', '2', '3']));
    await flush();
    expect(t.confirmed()).toBe('1,2,3');
    expect(t.selection()).toEqual(['1', '2', '3']);
    expect(t.chipText()).toContain('Gamma');
    expect(t.posts()).toHaveLength(2);
  });

  it('does not overwrite a newer draft with a read that arrives after it', async () => {
    const t = setup({ savedIds: ['1'] });
    t.queue.push(jsonResponse(422, {
      status: 'error', code: 'TAG_NOT_FOUND', outcome: 'refused', message: 'One or more selected tags no longer exists.',
    }));
    t.toggle('2');
    await flush();
    // The refusal keeps the draft; a read of the saved state leaves it alone.
    t.queue.push(t.serverPage('page-1', { savedIds: ['1'] }));
    const result = await refreshAssetViewer(t.document, { projectId: PROJECT_ID, assetId: ASSET_ID });
    expect(result.status).toBe('installed');
    expect(t.confirmed()).toBe('1');
    expect(t.selection()).toEqual(['1', '2']);
  });
});

describe('Edit Asset tag save — refusals', () => {
  it('keeps the draft and baseline on a validation refusal and sends no GET', async () => {
    const t = setup({ savedIds: ['1'] });
    t.queue.push(jsonResponse(422, {
      status: 'error', code: 'TAG_NOT_FOUND', outcome: 'refused',
      message: 'One or more selected tags no longer exists. Refresh and try again.',
    }));
    t.toggle('3');
    await flush();
    expect(t.selection()).toEqual(['1', '3']);
    expect(t.confirmed()).toBe('1');
    expect(t.statusText()).toBe('One or more selected tags no longer exists. Refresh and try again. Your selection was kept.');
    expect(t.status().getAttribute('data-asset-tags-state')).toBe('error');
    expect(t.gets()).toHaveLength(0);
    expect(dialogs.restores).toBe(1);
  });

  it('reports an archived project refusal locally', async () => {
    const t = setup({ savedIds: ['1'] });
    t.queue.push(jsonResponse(409, {
      status: 'error', code: 'PROJECT_ARCHIVED', outcome: 'refused',
      message: 'This project is archived and read-only. Asset tag assignments cannot be changed.',
    }));
    t.toggle('1');
    await flush();
    expect(t.statusText()).toMatch(/archived and read-only/);
    expect(t.selection()).toEqual([]);
    expect(t.confirmed()).toBe('1');
    expect(t.document.nativeSubmits).toHaveLength(0);
  });

  it('treats a CSRF refusal (JSON 403 without an outcome) as refused, not uncertain', async () => {
    const t = setup({ savedIds: [] });
    t.queue.push(jsonResponse(403, { status: 'error', message: 'Invalid or missing CSRF token.' }));
    t.toggle('2');
    await flush();
    expect(t.statusText()).toBe('Invalid or missing CSRF token. Your selection was kept.');
    expect(t.gets()).toHaveLength(0);
  });

  it('reports a missing asset without redirecting or installing anything', async () => {
    const t = setup({ savedIds: ['1'] });
    t.queue.push(jsonResponse(404, {
      status: 'error', code: 'ASSET_NOT_FOUND', outcome: 'refused', message: 'This asset no longer exists in this project.',
    }));
    t.toggle('2');
    await flush();
    expect(t.statusText()).toBe('This asset no longer exists in this project. Nothing was saved.');
    expect(t.chipText()).toContain('Alpha');
    expect(t.gets()).toHaveLength(0);
  });
});

describe('Edit Asset tag save — lost or uncertain responses', () => {
  // WP10A1-F3: these four replace WP10A1's originals, which let a read settle
  // a lost save and offered to resubmit while it could still run.
  it('never resubmits a lost response; a GET reports a matching saved state without claiming the request committed', async () => {
    const t = setup({ savedIds: ['1'] });
    t.queue.push(() => Promise.reject(new TypeError('Failed to fetch')), t.serverPage('page-12', { savedIds: ['1', '2'] }));
    t.toggle('2');
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.gets()).toHaveLength(1);
    expect(t.confirmed()).toBe('1,2');
    expect(t.statusText()).toMatch(/^The tag save could not be confirmed\. The tags saved now match the selection that was sent\. This is what is saved now; it does not show whether your request ran\./);
    expect(t.statusText()).not.toMatch(/updated|saved\.$/);
    expect(t.retry().textContent).toBe('Check again');
  });

  it('keeps a differing draft unsaved after an unreadable response and offers only a GET-only Check again', async () => {
    const t = setup({ savedIds: ['1'] });
    t.queue.push({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError('bad json')) },
      t.serverPage('page-1', { savedIds: ['1'] }));
    t.toggle('2');
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.confirmed()).toBe('1');
    expect(t.selection()).toEqual(['1', '2']);
    expect(t.statusText()).toMatch(/differ from your selection, which is kept but not saved/);
    expect(t.retry().textContent).toBe('Check again');

    t.queue.push(t.serverPage('page-1b', { savedIds: ['1'] }));
    t.retry().click();
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.gets()).toHaveLength(2);
    expect(t.selection()).toEqual(['1', '2']);
  });

  it('treats a 500 with an unknown outcome as uncertain and holds every later save', async () => {
    const t = setup({ savedIds: [] });
    t.queue.push(jsonResponse(500, { status: 'error', code: 'TAG_SAVE_FAILED', outcome: 'unknown', message: 'x' }),
      t.serverPage('page-none', { savedIds: [] }));
    t.toggle('1');
    await flush();
    expect(t.statusText()).toMatch(/could not be confirmed/);
    expect(t.posts()).toHaveLength(1);

    t.toggle('2');
    t.tagForm.requestSubmit();
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.confirmed()).toBe('');
    expect(t.statusText()).toMatch(/could not be confirmed.*Your latest tag selection was not saved\.$/);
  });

  it('treats a success for another asset as unproven', async () => {
    const t = setup({ savedIds: [] });
    t.queue.push(success(['1'], { assetId: 999 }), t.serverPage('page-none-2', { savedIds: [] }));
    t.toggle('1');
    await flush();
    expect(t.confirmed()).toBe('');
    expect(t.statusText()).toMatch(/could not be confirmed/);
    expect(t.dialog.__creatorCrateAssetTagSave.unresolved).not.toBeNull();
  });

  it('offers a GET-only Check again when the status read fails, and keeps the draft', async () => {
    const t = setup({ savedIds: ['1'] });
    t.queue.push(() => Promise.reject(new TypeError('lost')), htmlResponse('', 503));
    t.toggle('2');
    await flush();
    expect(t.statusText()).toMatch(/^The tag save could not be confirmed\. The saved tags could not be read\. Your selection is kept\. That request may still run/);
    expect(t.retry().textContent).toBe('Check again');

    t.queue.push(t.serverPage('page-1', { savedIds: ['1'] }));
    t.retry().click();
    expect(t.statusText()).toBe('The tag save could not be confirmed. Checking the saved tags…');
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.gets()).toHaveLength(2);
    expect(t.selection()).toEqual(['1', '2']);
    expect(t.statusText()).toMatch(/differ from your selection/);
  });
});

// WP10A1-F3: a lost or unreadable answer leaves the save unresolved for the
// page's lifetime (it may still reach the server and replace the set); every
// save carries the reviewed-state witness of the saved set it was made against.
describe('F3 — unresolved tag save and reviewed tag-set witness', () => {
  function lose(t, savedPage) {
    t.queue.push(() => Promise.reject(new TypeError('Failed to fetch')), savedPage);
  }
  const held = (t) => t.dialog.__creatorCrateAssetTagSave.unresolved;
  const HELD = 'This asset cannot be changed from this page while the earlier tag save is unconfirmed.';

  it('C1. an early successful GET showing the original set does not unlock a second save', async () => {
    const t = setup({ savedIds: [] });
    lose(t, t.serverPage('c1-original', { savedIds: [] }));
    t.toggle('1');
    await flush();
    expect(t.gets()).toHaveLength(1);
    expect(t.confirmed()).toBe('');
    expect(t.statusText()).toMatch(/differ from your selection.*does not show whether your request ran.*cannot be saved again/);

    // Save B {Alpha, Beta}: refused, never sent or queued.
    t.toggle('2');
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(held(t)).not.toBeNull();
    expect(t.selection()).toEqual(['1', '2']);
    expect(t.confirmed()).toBe('');
    expect(t.statusText()).toMatch(/Your latest tag selection was not saved\.$/);
    expect(t.statusText()).not.toMatch(/Asset tags updated/);
    expect(t.tagForm.getAttribute('data-asset-tags-hold')).toBe('unresolved');
    expect(t.retry().textContent).toBe('Check again');
    expect(t.dialog.isConnected).toBe(true);
    expect(t.document.querySelector('[data-asset-viewer-host]')).toBe(t.host);
  });

  it('C2. a GET showing the requested set does not prove the request committed', async () => {
    const t = setup({ savedIds: [] });
    lose(t, t.serverPage('c2-requested', { savedIds: ['1'] }));
    t.toggle('1');
    await flush();
    expect(t.confirmed()).toBe('1');
    expect(t.statusText()).toMatch(/match the selection that was sent\. This is what is saved now; it does not show whether your request ran\./);
    t.toggle('2');
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(held(t)).not.toBeNull();
  });

  it('C3. a failed GET keeps the hold, the draft and a GET-only Check again, with no GET loop', async () => {
    const t = setup({ savedIds: ['1'] });
    lose(t, htmlResponse('', 503));
    t.toggle('2');
    await flush();
    await flush();
    expect(t.gets()).toHaveLength(1);
    expect(t.retry().textContent).toBe('Check again');
    t.queue.push(htmlResponse('', 503));
    t.retry().click();
    await flush();
    expect(t.gets()).toHaveLength(2);
    expect(t.posts()).toHaveLength(1);
    expect(held(t)).not.toBeNull();
    expect(t.selection()).toEqual(['1', '2']);
    expect(t.retry().textContent).toBe('Check again');
    t.toggle('3');
    await flush();
    expect(t.posts()).toHaveLength(1);
  });

  it('C4. a viewer GET made elsewhere installs the page but leaves the hold', async () => {
    const t = setup({ savedIds: [] });
    lose(t, t.serverPage('c4-first', { savedIds: [] }));
    t.toggle('1');
    await flush();
    t.queue.push(t.serverPage('c4-other', { savedIds: ['1'] }));
    const result = await refreshAssetViewer(t.document, assetViewerIdentity(t.document));
    expect(result.status).toBe('installed');
    expect(t.confirmed()).toBe('1');
    t.toggle('2');
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(held(t)).not.toBeNull();
  });

  it('C5. a superseded GET settles nothing', async () => {
    const t = setup({ savedIds: [] });
    const read = deferred();
    t.queue.push(() => Promise.reject(new TypeError('lost')), () => read.promise);
    t.toggle('1');
    await flush();
    supersedeAssetViewerRefresh(t.document);
    t.serverPage('c5-late', { savedIds: ['1'] });
    read.resolve(htmlResponse('c5-late'));
    await flush();
    expect(t.confirmed()).toBe('');
    expect(t.statusText()).toBe('The tag save could not be confirmed. Checking the saved tags…');
    expect(held(t)).not.toBeNull();
    t.toggle('2');
    await flush();
    expect(t.posts()).toHaveLength(1);
  });

  it('C6/C15. no click, Enter or requestSubmit sends a second replacement while unresolved', async () => {
    const t = setup({ savedIds: [] });
    lose(t, t.serverPage('c6', { savedIds: [] }));
    t.toggle('1');
    await flush();
    t.tagForm.requestSubmit();
    t.tagForm.dispatch('submit');
    t.toggle('2');
    t.toggle('3');
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.document.nativeSubmits).toHaveLength(0);
    // The refusal is added to the standing warning once, not repeated or replacing it.
    expect(t.statusText().match(/Your latest tag selection was not saved\./g)).toHaveLength(1);
    expect(t.statusText()).toMatch(/^The tag save could not be confirmed\./);
  });

  it('C7. Rename, Move and Project/Book primary-image submissions are refused while unresolved', async () => {
    const t = setup({ savedIds: [], withOtherActions: true });
    lose(t, t.serverPage('c7', { savedIds: [], withOtherActions: true }));
    t.toggle('1');
    await flush();
    for (const selector of ['form.asset-rename-form', 'form.asset-move-form', 'form.asset-primary-image-set-form', 'form.asset-book-primary-image-set-form']) {
      const event = t.dialog.querySelector(selector).dispatch('submit');
      expect(event.defaultPrevented).toBe(true);
    }
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.document.nativeSubmits).toHaveLength(0);
    expect(t.dialog.querySelector('[data-dialog-status]').textContent).toContain(HELD);
  });

  it('C8. Delete is refused while unresolved, before its confirmation and on submit', async () => {
    const t = setup({ savedIds: [], withOtherActions: true });
    lose(t, t.serverPage('c8', { savedIds: [], withOtherActions: true }));
    t.toggle('1');
    await flush();
    const form = t.dialog.querySelector('form.asset-delete-form');
    const click = form.querySelector('button').dispatch('click');
    expect(click.defaultPrevented).toBe(true);
    const submit = form.dispatch('submit');
    expect(submit.defaultPrevented).toBe(true);
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.dialog.querySelector('[data-asset-delete-status-text]')?.textContent || '').toContain(HELD);
  });

  it('C9. dismissal and reopening keep the hold, the draft, the baseline and Check again', async () => {
    const t = setup({ savedIds: ['1'] });
    lose(t, t.serverPage('c9', { savedIds: ['1'] }));
    t.toggle('2');
    await flush();
    t.toggle('3');
    await flush();
    const warning = t.statusText();
    t.renameInput.value = 'draft.png';
    t.close();
    expect(t.selection()).toEqual(['1', '2', '3']);
    expect(t.confirmed()).toBe('1');
    expect(t.renameInput.value).toBe('draft.png');
    expect(t.statusText()).toBe(warning);
    expect(t.retry().textContent).toBe('Check again');
    // Reopened: still refused.
    t.toggle('3');
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(held(t)).not.toBeNull();
  });

  it('C10. a refusal from the request itself releases: the next change is sent', async () => {
    const t = setup({ savedIds: ['1'] });
    t.queue.push(jsonResponse(422, { status: 'error', code: 'TAG_NOT_FOUND', outcome: 'refused', message: 'Gone tag.' }));
    t.toggle('2');
    await flush();
    expect(held(t)).toBeNull();
    t.queue.push(success(['1', '2', '3']), t.serverPage('c10', { savedIds: ['1', '2', '3'] }));
    t.toggle('3');
    await flush();
    expect(t.posts()).toHaveLength(2);
    expect(t.confirmed()).toBe('1,2,3');
  });

  it('C11. a committed save advances the baseline and the witness the next save carries', async () => {
    const t = setup({ savedIds: ['1'] });
    expect(t.posts).toBeTypeOf('function');
    t.queue.push(success(['1', '2']), t.serverPage('c11-a', { savedIds: ['1', '2'] }));
    t.toggle('2');
    await flush();
    expect(t.posts()[0].body.getAll('tagReview')).toEqual([reviewFor(['1'])]);
    expect(t.tagForm.querySelector('input[data-asset-tag-review]').value).toBe(reviewFor(['1', '2']));
    t.queue.push(success(['1', '2', '3']), t.serverPage('c11-b', { savedIds: ['1', '2', '3'] }));
    t.toggle('3');
    await flush();
    expect(t.posts()[1].body.getAll('tagReview')).toEqual([reviewFor(['1', '2'])]);
    expect(t.confirmed()).toBe('1,2,3');
  });

  it('C12. a committed save whose refresh fails stays acknowledged; Retry refresh is GET only; the response witness is kept', async () => {
    const t = setup({ savedIds: ['1'] });
    t.queue.push(success(['1', '2']), htmlResponse('', 503));
    t.toggle('2');
    await flush();
    expect(t.statusText()).toBe(MESSAGES_SAVED_REFRESH_FAILED);
    expect(t.retry().textContent).toBe('Retry refresh');
    expect(held(t)).toBeNull();
    t.queue.push(htmlResponse('', 503));
    t.retry().click();
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.gets()).toHaveLength(2);
    // A later save is made against the set the acknowledged save stored.
    t.queue.push(success(['1', '2', '3']), t.serverPage('c12', { savedIds: ['1', '2', '3'] }));
    t.toggle('3');
    await flush();
    expect(t.posts()[1].body.getAll('tagReview')).toEqual([reviewFor(['1', '2'])]);
  });

  it('C13. an explicit empty selection is sent with no tagIds and the witness of the saved set', async () => {
    const t = setup({ savedIds: ['1'] });
    t.queue.push(success([]), t.serverPage('c13', { savedIds: [] }));
    t.toggle('1');
    await flush();
    expect(t.posts()[0].body.has('tagIds[]')).toBe(false);
    expect(t.posts()[0].body.getAll('tagReview')).toEqual([reviewFor(['1'])]);
    expect(t.confirmed()).toBe('');
    expect(t.tagForm.querySelector('input[data-asset-tag-review]').value).toBe(reviewFor([]));
  });

  it('C14. a stale refusal keeps the selection as a draft, reads the saved set, and resubmits only on request', async () => {
    const t = setup({ savedIds: ['1'] });
    t.queue.push(
      jsonResponse(409, {
        status: 'error', code: 'TAG_SET_STALE', outcome: 'refused',
        message: 'The saved tags changed after this selection was reviewed, so it was not saved. Review the saved tags, then save again.',
        submittedTagIds: ['1', '2'],
      }),
      t.serverPage('c14-newer', { savedIds: ['1', '3'] }),
    );
    t.toggle('2');
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.gets()).toHaveLength(1);
    expect(held(t)).toBeNull();
    expect(t.selection()).toEqual(['1', '2']);
    expect(t.confirmed()).toBe('1,3');
    expect(t.chipText()).toContain('Gamma');
    expect(t.tagForm.querySelector('input[data-asset-tag-review]').value).toBe(reviewFor(['1', '3']));
    expect(t.statusText()).toMatch(/not saved\. .*Your selection is kept but not saved\. The saved tags are shown now/);
    expect(t.statusText()).not.toMatch(/Asset tags updated/);
    expect(t.retry().textContent).toBe('Save selection');

    t.queue.push(success(['1', '2']), t.serverPage('c14-saved', { savedIds: ['1', '2'] }));
    t.retry().click();
    await flush();
    expect(t.posts()).toHaveLength(2);
    expect(t.posts()[1].body.getAll('tagIds[]')).toEqual(['1', '2']);
    expect(t.posts()[1].body.getAll('tagReview')).toEqual([reviewFor(['1', '3'])]);
    expect(t.confirmed()).toBe('1,2');
  });

  it('C16. enhancing again binds no second listener', async () => {
    const t = setup({ savedIds: [] });
    enhanceAssetEditDialog(t.document);
    lose(t, t.serverPage('c16', { savedIds: [] }));
    t.toggle('1');
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.gets()).toHaveLength(1);
  });

  it('C17. with nothing unresolved, closing after a stale refusal resets to the saved baseline', async () => {
    const t = setup({ savedIds: ['1'] });
    t.queue.push(
      jsonResponse(409, { status: 'error', code: 'TAG_SET_STALE', outcome: 'refused', message: 'Changed.' }),
      t.serverPage('c17', { savedIds: ['3'] }),
    );
    t.toggle('2');
    await flush();
    t.close();
    expect(t.selection()).toEqual(['3']);
    expect(t.statusText()).toBe('');
  });

  it('C18. a tag change blocked by another standing hold stays as a draft and is not sent', async () => {
    const t = setup({ savedIds: ['1'] });
    // A Rename whose answer is lost holds every Edit Asset action.
    t.renameInput.value = 'renamed.png';
    t.queue.push(() => Promise.reject(new TypeError('lost')), htmlResponse('', 503));
    t.dialog.querySelector('form.asset-rename-form').requestSubmit();
    await flush();
    expect(t.posts()).toHaveLength(1);

    t.toggle('2');
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.selection()).toEqual(['1', '2']);
    expect(t.confirmed()).toBe('1');
    expect(t.statusText()).toMatch(/earlier rename is unconfirmed.*Your latest tag selection was not saved\.$/);
    t.close();
    expect(t.selection()).toEqual(['1', '2']);
  });
});

const MESSAGES_SAVED_REFRESH_FAILED = 'Asset tags updated, but the tags shown on this page could not refresh and may be out of date.';

describe('Edit Asset tag save — viewer refresh after a confirmed save', () => {
  it('keeps the save acknowledged when the GET fails and retries with GET only', async () => {
    const t = setup({ savedIds: ['1'] });
    t.queue.push(success(['1', '2']), htmlResponse('', 500));
    t.toggle('2');
    await flush();
    expect(t.confirmed()).toBe('1,2');
    expect(t.statusText()).toBe('Asset tags updated, but the tags shown on this page could not refresh and may be out of date.');
    expect(t.chipText()).not.toContain('Beta');
    expect(t.retry().textContent).toBe('Retry refresh');

    t.queue.push(t.serverPage('page-12', { savedIds: ['1', '2'] }));
    t.retry().click();
    await flush();
    expect(t.posts()).toHaveLength(1);
    expect(t.gets()).toHaveLength(2);
    expect(t.chipText()).toContain('Beta');
    expect(t.statusText()).toBe('Asset tags updated.');
    expect(t.retry()).toBeNull();
  });

  it('never installs a page for another asset or a sign-in page', async () => {
    const t = setup({ savedIds: ['1'] });
    t.queue.push(success(['1', '2']), t.serverPage('other-asset', { savedIds: ['3'], assetId: 43 }));
    t.toggle('2');
    await flush();
    expect(t.chipText()).not.toContain('Gamma');
    expect(t.retry().textContent).toBe('Retry refresh');

    t.queue.push(htmlResponse('<html>login</html>'));
    t.retry().click();
    await flush();
    expect(t.chipText()).not.toContain('Gamma');
    expect(t.posts()).toHaveLength(1);
  });

  it('reports an asset deleted after its save as missing, without installing', async () => {
    const t = setup({ savedIds: ['1'] });
    t.queue.push(success(['1', '2']), htmlResponse('Not found', 404));
    t.toggle('2');
    await flush();
    expect(t.statusText()).toBe('Asset tags updated, but this asset can no longer be read. It may have been deleted elsewhere.');
    expect(t.chipText()).toContain('Alpha');
    expect(t.retry()).toBeNull();
  });

  it('refreshes after a refusal when an earlier confirmed save still owes its page refresh', async () => {
    const t = setup({ savedIds: ['1'] });
    const firstRead = deferred();
    t.queue.push(success(['1', '2']), () => firstRead.promise);
    t.toggle('2');
    await flush();
    t.queue.push(jsonResponse(422, { status: 'error', code: 'TAG_NOT_FOUND', outcome: 'refused', message: 'Gone.' }),
      t.serverPage('page-12', { savedIds: ['1', '2'] }));
    t.toggle('3');
    firstRead.resolve(htmlResponse('ignored'));
    await flush();
    expect(t.gets()).toHaveLength(2);
    expect(t.chipText()).toContain('Beta');
    expect(t.statusText()).toBe('Gone. Your selection was kept.');
    expect(t.selection()).toEqual(['1', '2', '3']);
  });
});

describe('Edit Asset tag save — dismissal', () => {
  it('resets the checkboxes to the saved baseline on close and clears the tag status', async () => {
    const t = setup({ savedIds: ['1'] });
    t.queue.push(jsonResponse(422, { status: 'error', outcome: 'refused', message: 'No.' }));
    t.toggle('2');
    await flush();
    t.close();
    expect(t.selection()).toEqual(['1']);
    expect(t.statusText()).toBe('');
  });

  it('a save acknowledged after the dialog closed updates the reset checkboxes to the saved tags', async () => {
    const t = setup({ savedIds: ['1'] });
    const post = deferred();
    t.queue.push(() => post.promise);
    t.toggle('2');
    t.close();
    expect(t.selection()).toEqual(['1']);
    t.queue.push(t.serverPage('page-12', { savedIds: ['1', '2'] }));
    post.resolve(success(['1', '2']));
    await flush();
    expect(t.selection()).toEqual(['1', '2']);
    expect(t.confirmed()).toBe('1,2');
  });

  it('keeps an open GET obligation and its Retry refresh across close', async () => {
    const t = setup({ savedIds: ['1'] });
    t.queue.push(success(['1', '2']), htmlResponse('', 500));
    t.toggle('2');
    await flush();
    t.close();
    expect(t.statusText()).toBe('The saved tags could not be read. The tags shown may be out of date.');
    expect(t.retry()).not.toBeNull();
  });
});

describe('asset-viewer-refresh contract', () => {
  it('reads identity from the media host and refuses another asset or page', async () => {
    const t = setup();
    expect(assetViewerIdentity(t.document)).toEqual({ projectId: String(PROJECT_ID), assetId: String(ASSET_ID) });
    expect(await refreshAssetViewer(t.document, { assetId: 99 })).toEqual({ status: 'unavailable' });
    const other = createDocument(h('body', {}, h('main')));
    expect(await refreshAssetViewer(other)).toEqual({ status: 'unavailable' });
    expect(t.requests).toHaveLength(0);
  });

  it('reports superseded (not success or failure) when a mutation begins during the read', async () => {
    const t = setup({ savedIds: ['1'] });
    const read = deferred();
    t.queue.push(() => read.promise);
    const pending = refreshAssetViewer(t.document, { projectId: PROJECT_ID, assetId: ASSET_ID });
    await flush();
    supersedeAssetViewerRefresh(t.document);
    t.serverPage('changed', { savedIds: ['3'] });
    read.resolve(htmlResponse('changed'));
    expect(await pending).toEqual({ status: 'superseded' });
    expect(t.chipText()).toContain('Alpha');
    expect(t.confirmed()).toBe('1');
  });

  it('reports installed only after the regions are in place, with the old and new baselines', async () => {
    const t = setup({ savedIds: ['1'] });
    t.queue.push(t.serverPage('p', { savedIds: ['2', '3'] }));
    const result = await refreshAssetViewer(t.document, { projectId: PROJECT_ID, assetId: ASSET_ID });
    expect(result).toEqual({ status: 'installed', confirmedTagIds: ['2', '3'], previousConfirmedTagIds: ['1'] });
    expect(t.chipText()).toContain('Gamma');
    expect(t.confirmed()).toBe('2,3');
    expect(t.requests).toEqual([expect.objectContaining({ method: 'GET', accept: 'text/html' })]);
  });

  it('leaves the baseline alone when the server renders no tag form (archived)', async () => {
    const t = setup({ savedIds: ['1'] });
    t.queue.push(t.serverPage('archived', { savedIds: ['1', '2'], withTagForm: false }));
    const result = await refreshAssetViewer(t.document);
    expect(result.status).toBe('installed');
    expect(result.confirmedTagIds).toBeNull();
    expect(t.confirmed()).toBe('1');
    expect(t.chipText()).toContain('Beta');
  });

  it('leaves focus where it was', async () => {
    const t = setup({ savedIds: ['1'] });
    const previous = t.host.querySelector('.asset-preview-nav');
    previous.focus();
    t.queue.push(t.serverPage('p2', { savedIds: ['2'] }));
    await refreshAssetViewer(t.document);
    expect(t.document.activeElement).toBe(previous);
    expect(previous.isConnected).toBe(true);
  });
});
