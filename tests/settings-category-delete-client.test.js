import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// WP11C: Delete a Settings asset category default in place
// (settings-category-delete.js). The shared confirmation, its submit gate,
// the category enhancers and the dropdowns are stand-ins (the confirmation's
// replay is a dispatched submit here; the real gate, binders, Escape,
// backdrop, requestSubmit, focus and every request against the real server
// are covered in Chromium). The DOM is a purpose-built shim (no jsdom in this
// project); the server's list render is a JSON page spec the fake DOMParser
// builds into the same shim.

const feedbackLog = vi.hoisted(() => []);
const enhanced = vi.hoisted(() => ({ reorder: 0, details: 0, autosubmit: 0, confirm: 0, dropdowns: 0, prefs: 0 }));
vi.mock('../src/static/client/app-dialogs.js', () => ({
  appDialogFeedback: (document, message, error = false) => {
    feedbackLog.push({ message, error });
    const feedback = document.querySelector('[data-dialog-feedback]');
    const text = feedback?.querySelector('[data-dialog-feedback-text]');
    if (text) text.textContent = message;
    feedback?.removeAttribute('hidden');
    feedback?.setAttribute('data-error', error ? 'true' : 'false');
  },
  enhanceAutoSubmit: () => { enhanced.autosubmit += 1; },
}));
// WP11C-A: the lifecycle the Delete controller registers for details saves.
const detailsLifecycles = vi.hoisted(() => new Map());
vi.mock('../src/static/client/category-details.js', () => ({
  enhanceCategoryDetails: () => { enhanced.details += 1; },
  setCategoryDetailsLifecycle: (document, lifecycle) => { detailsLifecycles.set(document, lifecycle); },
}));
vi.mock('../src/static/client/category-reorder.js', () => ({ enhanceCategoryReorder: () => { enhanced.reorder += 1; } }));
// WP11C-F2: the dropdown stand-in mirrors its native select the way the real
// sync does: radios for removed options go, option-disabled radios disable.
const dropdownSyncs = vi.hoisted(() => []);
vi.mock('../src/static/client/dropdowns.js', () => ({
  enhanceDropdowns: () => { enhanced.dropdowns += 1; },
  creatorCrateDropdownForNativeSelect: (select) => select.closest('form')?.querySelector('details[data-cc-dropdown]') || null,
  syncCreatorCrateDropdownFromNative: (select) => {
    dropdownSyncs.push(select.name);
    const dropdown = select.closest('form')?.querySelector('details[data-cc-dropdown]');
    const values = new Set(select.options.map((option) => option.value));
    dropdown?.querySelectorAll('input').forEach((radio) => {
      if (!values.has(radio.value)) radio.remove();
      else radio.disabled = radio.getAttribute('data-cc-dropdown-option-disabled') === 'true';
    });
  },
}));
vi.mock('../src/static/client/settings-asset-category-preferences-fetch-save.js', () => ({
  ASSET_CATEGORY_PREFERENCE_ANSWER_EVENT: 'creatorcrate:asset-category-preference-answer',
  ASSET_CATEGORY_PREFERENCE_SETTLED_EVENT: 'creatorcrate:asset-category-preference-settled',
  enhanceAssetCategoryPreferencesFetchSave: () => { enhanced.prefs += 1; },
}));
const confirmations = vi.hoisted(() => ({ described: new Map(), gates: 0 }));
vi.mock('../src/static/client/confirm-dialog.js', () => ({
  describeAppConfirmation: (control, resolve) => { confirmations.described.set(control, resolve); },
  enhanceAppConfirmationControls: () => { enhanced.confirm += 1; },
  installAppConfirmationSubmitGate: () => { confirmations.gates += 1; },
}));

const {
  enhanceSettingsCategoryDelete,
  settingsCategoryDeleteState,
  settingsCategoryDeleteSync,
  classifySettingsCategoryDeleteResponse,
  settingsCategoryDeleteConfirmation,
  SETTINGS_CATEGORY_DELETE_MESSAGES: M,
} = await import('../src/static/client/settings-category-delete.js');

// ---------------------------------------------------------------- DOM shim --

function parseCompound(text) {
  // WP11C-B: `#id` too (restoreRegionFocus falls back to it for an element
  // no longer in the page; a real browser then finds nothing).
  const match = text.trim().match(/^([a-z0-9]+)?(#[\w-]+)?((?:\.[\w-]+)*)((?:\[[\w-]+(?:="[^"]*")?\])*)$/i);
  if (!match) throw new Error(`Unsupported selector: ${text}`);
  return {
    tag: match[1] ? match[1].toUpperCase() : null,
    id: match[2] ? match[2].slice(1) : null,
    classes: (match[3].match(/\.[\w-]+/g) || []).map((part) => part.slice(1)),
    attributes: [...match[4].matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)].map(([, name, value]) => ({ name, value })),
  };
}

function matchesCompound(node, compound) {
  if (!node?.attributes) return false;
  if (compound.tag && node.tagName !== compound.tag) return false;
  if (compound.id && node.id !== compound.id) return false;
  const classes = (node.getAttribute('class') || '').split(/\s+/);
  if (compound.classes.some((name) => !classes.includes(name))) return false;
  return compound.attributes.every(({ name, value }) => {
    if (name === 'open' && node.tagName === 'DETAILS') return Boolean(node.open);
    if (!node.hasAttribute(name)) return false;
    return value === undefined || node.getAttribute(name) === value;
  });
}

function matchesSelector(node, selector) {
  return selector.split(',').some((alternative) => {
    const parts = alternative.trim().split(/\s+(?![^[]*\])/).map(parseCompound);
    if (!matchesCompound(node, parts[parts.length - 1])) return false;
    let ancestor = node.parentNode;
    for (let index = parts.length - 2; index >= 0; index -= 1) {
      while (ancestor && !matchesCompound(ancestor, parts[index])) ancestor = ancestor.parentNode;
      if (!ancestor) return false;
      ancestor = ancestor.parentNode;
    }
    return true;
  });
}

class FakeNode {
  constructor(tagName, attributes = {}) {
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map(Object.entries(attributes).map(([key, value]) => [key, String(value)]));
    this.childNodes = [];
    this.parentNode = null;
    this.listeners = [];
    this.ownText = '';
    this.dataset = {};
  }

  get root() { let node = this; while (node.parentNode) node = node.parentNode; return node; }
  get ownerDocument() { return this.root.document || null; }
  get isConnected() { return Boolean(this.root.document?.live); }
  get id() { return this.getAttribute('id') || ''; }
  set id(value) { this.setAttribute('id', value); }
  get type() { return this.getAttribute('type') || (this.tagName === 'BUTTON' ? 'submit' : ''); }
  set type(value) { this.attributes.set('type', value); }
  get name() { return this.getAttribute('name') || ''; }
  set className(value) { this.attributes.set('class', value); }
  get form() { return this.parentNode?.closest?.('form') || null; }
  get children() { return this.childNodes; }
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
    const document = this.root.document;
    if (document && child.contains(document.activeElement)) document.activeElement = document.body;
  }
  remove() { this.parentNode?.removeChildNode(this); }
  replaceWith(next) {
    const parent = this.parentNode;
    if (!parent) return;
    next.parentNode?.removeChildNode(next);
    const index = parent.childNodes.indexOf(this);
    parent.childNodes.splice(index, 1, next);
    next.parentNode = parent;
    this.parentNode = null;
    const document = parent.root.document;
    if (document && this.contains(document.activeElement)) document.activeElement = document.body;
  }
  contains(node) { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }
  get textContent() { return this.ownText + this.childNodes.map((node) => node.textContent).join(''); }
  set textContent(text) { [...this.childNodes].forEach((node) => this.removeChildNode(node)); this.ownText = String(text); }
  matches(selector) { return matchesSelector(this, selector); }
  descendants() { return this.childNodes.flatMap((node) => [node, ...node.descendants()]); }
  querySelectorAll(selector) { return this.descendants().filter((node) => node.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { for (let node = this; node; node = node.parentNode) if (node.matches?.(selector)) return node; return null; }
  addEventListener(type, listener, capture = false) {
    this.listeners.push({ type, listener, capture: capture === true || capture?.capture === true });
  }
  focus() { const document = this.ownerDocument; if (document) document.activeElement = this; }
  dispatch(type, init = {}) {
    const path = [];
    for (let node = this; node; node = node.parentNode) path.unshift(node);
    let stopped = false;
    let immediate = false;
    const event = {
      type, target: this, defaultPrevented: false, ...init,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { stopped = true; },
      stopImmediatePropagation() { stopped = true; immediate = true; },
    };
    const run = (node, capture) => {
      for (const entry of [...node.listeners]) {
        if (entry.type !== type || (node !== this && entry.capture !== capture)) continue;
        entry.listener.call(node, event);
        if (immediate) return;
      }
    };
    for (const node of path) { if (stopped) break; run(node, true); }
    for (const node of [...path].reverse().slice(1)) { if (stopped) break; run(node, false); }
    return event;
  }
  click() { return this.dispatch('click', { button: 0 }); }
}

function input(attributes, value) {
  const node = new FakeNode('input', attributes);
  node.value = value;
  node.defaultValue = value;
  return node;
}

function checkbox(attributes, checked) {
  const node = new FakeNode('input', { type: 'checkbox', ...attributes });
  node.checked = checked;
  node.defaultChecked = checked;
  return node;
}

function buildRow(category) {
  const row = new FakeNode('article', {
    class: 'category-management-card', 'data-category-id': category.id, 'data-category-label': category.name,
    'data-category-slug': category.slug, 'data-category-reorder-item': '',
    // WP11C-F9: the enabled state the server rendered for the row.
    'data-category-enabled': category.enabled === false ? 'false' : 'true',
  });
  row.appendChild(new FakeNode('button', { type: 'button', 'data-category-reorder-handle': '' }));
  const body = row.appendChild(new FakeNode('div', { class: 'category-management-card-body' }));
  const details = body.appendChild(new FakeNode('form', {
    'data-category-details-form': '', 'data-category-details-id': category.id, action: `/settings/asset-categories/${category.id}`,
  }));
  details.appendChild(input({ name: 'displayName', id: `global-category-${category.id}-display-name` }, category.name));
  details.appendChild(input({ name: 'directorySlug', id: `global-category-${category.id}-directory-slug` }, category.slug));
  // WP11C-F7/F8: the saved details the form is based on, from the row.
  details.appendChild(input({ type: 'hidden', name: 'reviewedDisplayName', 'data-category-details-reviewed': 'displayName' }, category.name));
  details.appendChild(input({ type: 'hidden', name: 'reviewedDirectorySlug', 'data-category-details-reviewed': 'directorySlug' }, category.slug));
  const controls = body.appendChild(new FakeNode('div', { class: 'category-management-card-controls' }));
  const enabled = controls.appendChild(new FakeNode('form', {
    class: 'category-enabled-form', action: `/settings/asset-categories/${category.id}/enabled`,
  }));
  enabled.appendChild(checkbox({ name: 'enabled', id: `global-category-enabled-${category.id}` }, category.enabled !== false));
  const actions = controls.appendChild(new FakeNode('div', { class: 'category-management-actions' }));
  const form = actions.appendChild(new FakeNode('form', {
    class: 'inline-form', action: `/settings/asset-categories/${category.id}/delete`,
    'data-settings-category-delete-form': '', 'data-category-delete-id': category.id, 'data-confirm-submit-required': '',
  }));
  form.appendChild(input({ type: 'hidden', name: '_csrf' }, 'token-1'));
  form.appendChild(new FakeNode('button', { type: 'submit', 'data-confirm': 'Delete this default category?' }));
  return row;
}

// A Defaults setting: its native select offers the list's defaults (and All /
// Disabled), with the stored value selected; the dropdown has a radio for each.
function buildPreferenceSelect(form, identity, stored, categories) {
  const select = form.appendChild(new FakeNode('select', { name: identity, id: `${identity}-select` }));
  Object.defineProperty(select, 'options', { get() { return this.childNodes.filter((node) => node.tagName === 'OPTION'); } });
  Object.defineProperty(select, 'value', {
    get() { return this.options.find((option) => option.selected)?.value ?? ''; },
    set(next) { this.options.forEach((option) => { option.selected = option.value === next; }); },
  });
  const dropdown = form.appendChild(new FakeNode('details', { 'data-cc-dropdown': '' }));
  const first = identity === 'preview-category' ? '__disabled__' : 'all';
  // As the server renders it: only enabled defaults are offered (WP11C-F9).
  [{ slug: first, name: first }, ...categories.filter((category) => category.enabled !== false)].forEach((category) => {
    const option = select.appendChild(new FakeNode('option', { value: category.slug }));
    option.value = category.slug;
    option.ownText = category.name;
    option.selected = category.slug === stored;
    option.disabled = false;
    const radio = dropdown.appendChild(new FakeNode('input', { type: 'radio', value: category.slug }));
    radio.value = category.slug;
    radio.disabled = false;
  });
  return select;
}

function buildPage(spec, document) {
  const root = new FakeNode('html');
  root.document = document;
  const body = root.appendChild(new FakeNode('body'));
  const main = body.appendChild(new FakeNode('main', { id: 'main-content' }));
  const defaults = main.appendChild(new FakeNode('section', { class: 'settings-asset-category-defaults' }));
  for (const [identity, stored] of Object.entries(spec.preferences || {})) {
    const region = defaults.appendChild(new FakeNode('div', {
      'data-settings-asset-category-preference': identity, 'data-settings-asset-category-preference-stored': stored,
    }));
    const form = region.appendChild(new FakeNode('form', { action: `/settings/asset-categories/${identity}` }));
    buildPreferenceSelect(form, identity, stored, spec.categories);
    form.appendChild(new FakeNode('div', { 'data-settings-fetch-save-status': '' }));
    region.appendChild(new FakeNode('span', { 'data-region-version': spec.version || 'initial' }));
  }
  const addForm = main.appendChild(new FakeNode('form', { method: 'post', action: '/settings/asset-categories' }));
  addForm.appendChild(input({ type: 'hidden', name: '_csrf' }, 'token-1'));
  addForm.appendChild(input({ type: 'text', name: 'displayName', id: 'add-displayName' }, ''));
  addForm.appendChild(input({ type: 'text', name: 'directorySlug', id: 'add-directorySlug' }, ''));
  addForm.appendChild(new FakeNode('button', { type: 'submit' }));
  const feedback = main.appendChild(new FakeNode('div', { 'data-dialog-feedback': '', hidden: '' }));
  feedback.appendChild(new FakeNode('p', { 'data-dialog-feedback-text': '' }));
  const section = main.appendChild(new FakeNode('div', { 'data-settings-category-defaults': '', 'data-version': spec.version || 'initial' }));
  section.appendChild(new FakeNode('h3', { id: 'settings-category-defaults-heading', tabindex: '-1' }));
  if (spec.categories.length > 0) {
    section.appendChild(new FakeNode('form', { id: 'settings-category-reorder-form', 'data-category-reorder-form': '', action: '/settings/asset-categories/reorder' }));
    const list = section.appendChild(new FakeNode('div', { 'data-category-reorder-list': '' }));
    spec.categories.forEach((category) => list.appendChild(buildRow(category)));
  }
  return { root, body, section };
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };
const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const htmlResponse = (spec) => ({ ok: true, status: 200, redirected: false, url: '', text: async () => JSON.stringify(spec) });

const CATEGORIES = [
  { id: '3', name: 'Final', slug: 'final' },
  { id: '7', name: 'Sketches', slug: 'sketches' },
  { id: '9', name: 'Exports', slug: 'exports' },
];
const deletedBody = (category) => ({
  status: 'success', outcome: 'deleted', message: `Asset category default “${category.name}” deleted.`,
  categoryId: Number(category.id),
  category: { id: Number(category.id), displayName: category.name, directorySlug: category.slug, deleted: true },
  affects: { browserDefault: false, previewCategory: false }, refresh: true, redirect: '/settings/asset-categories',
});
const NOT_FOUND = { status: 'error', code: 'ASSET_CATEGORY_DEFAULT_NOT_FOUND', outcome: 'refused', message: 'This asset category default no longer exists. Nothing was deleted.' };

function setup({ categories = CATEGORIES, preferences = { 'browser-default': 'final', 'preview-category': 'disabled' }, withFetch = true } = {}) {
  const posts = [];
  const gets = [];
  const queue = { post: [], get: [] };
  const document = {
    nodeType: 9,
    live: true,
    activeElement: null,
    baseURI: 'http://local/settings/asset-categories',
    createElement: (tag) => new FakeNode(tag),
    adoptNode: (node) => { node.parentNode?.removeChildNode(node); return node; },
  };
  const window = {
    URLSearchParams,
    FormData: class {
      constructor(form) {
        this.entries = form.querySelectorAll('input').filter((node) => node.name).map((node) => [node.name, node.value]);
      }
      [Symbol.iterator]() { return this.entries[Symbol.iterator](); }
    },
    DOMParser: class {
      parseFromString(html) {
        const parsed = { nodeType: 9 };
        const page = buildPage(JSON.parse(html), parsed);
        parsed.querySelector = (selector) => page.root.querySelector(selector);
        parsed.querySelectorAll = (selector) => page.root.querySelectorAll(selector);
        return parsed;
      }
    },
    scrollX: 0,
    scrollY: 120,
    scrollTo: vi.fn(),
    fetch: vi.fn((url, init = {}) => {
      if (init.method === 'POST') {
        posts.push({ url, body: String(init.body), accept: init.headers?.Accept });
        const next = queue.post.shift();
        return next ? next() : new Promise(() => {});
      }
      gets.push({ url, method: init.method, accept: init.headers?.Accept, cache: init.cache });
      const next = queue.get.shift();
      return next ? next() : new Promise(() => {});
    }),
  };
  if (!withFetch) delete window.fetch;
  document.defaultView = window;
  const page = buildPage({ categories, preferences }, document);
  document.documentElement = page.root;
  document.body = page.body;
  document.querySelector = (selector) => page.root.querySelector(selector);
  document.querySelectorAll = (selector) => page.root.querySelectorAll(selector);
  document.getElementById = (id) => page.root.descendants().find((node) => node.id === id) || null;
  document.addEventListener = (...args) => page.root.addEventListener(...args);
  const row = (id) => page.root.querySelector(`[data-settings-category-defaults] article[data-category-id="${id}"]`);
  const deleteButton = (id) => row(id)?.querySelector('form[data-settings-category-delete-form] button');
  const deleteForm = (id) => row(id)?.querySelector('form[data-settings-category-delete-form]');
  const feedbackText = () => page.root.querySelector('[data-dialog-feedback-text]').textContent;
  const feedbackButton = (attribute) => page.root.querySelector(`[data-dialog-feedback] [${attribute}]`);
  // Opens the confirmation (the click) and replays its confirmed submit.
  const confirmDelete = (id) => {
    const click = deleteButton(id).click();
    if (click.defaultPrevented) return { click, submit: null };
    const submit = deleteForm(id).dispatch('submit');
    return { click, submit };
  };
  return { document, window, page, posts, gets, queue, row, deleteButton, deleteForm, feedbackText, feedbackButton, confirmDelete };
}

beforeEach(() => {
  feedbackLog.length = 0;
  dropdownSyncs.length = 0;
  confirmations.described.clear();
  Object.keys(enhanced).forEach((key) => { enhanced[key] = 0; });
});

describe('pure contract', () => {
  it('classifies only a matching acknowledged answer as deleted; anything unproven is uncertain', () => {
    const ok = { ok: true, status: 200 };
    const body = deletedBody(CATEGORIES[1]);
    expect(classifySettingsCategoryDeleteResponse(ok, body, '7')).toBe('deleted');
    expect(classifySettingsCategoryDeleteResponse(ok, body, '9')).toBe('uncertain');
    expect(classifySettingsCategoryDeleteResponse(ok, { ...body, category: { ...body.category, deleted: false } }, '7')).toBe('uncertain');
    expect(classifySettingsCategoryDeleteResponse(ok, null, '7')).toBe('uncertain');
    expect(classifySettingsCategoryDeleteResponse({ ok: false, status: 404 }, NOT_FOUND, '7')).toBe('missing');
    expect(classifySettingsCategoryDeleteResponse({ ok: false, status: 404 }, { status: 'error' }, '7')).toBe('uncertain');
    expect(classifySettingsCategoryDeleteResponse({ ok: false, status: 500 }, { status: 'error', code: 'ASSET_CATEGORY_DEFAULT_DELETE_FAILED', outcome: 'failed' }, '7')).toBe('failed');
    expect(classifySettingsCategoryDeleteResponse({ ok: false, status: 500 }, { status: 'error', code: 'ASSET_CATEGORY_DEFAULT_DELETE_UNKNOWN', outcome: 'unknown' }, '7')).toBe('uncertain');
    expect(classifySettingsCategoryDeleteResponse({ ok: false, status: 500 }, { status: 'error' }, '7')).toBe('uncertain');
    expect(classifySettingsCategoryDeleteResponse({ ok: false, status: 403 }, { status: 'error', message: 'Invalid or missing CSRF token.' }, '7')).toBe('refused');
    expect(classifySettingsCategoryDeleteResponse({ ok: false, status: 503 }, { status: 'error' }, '7')).toBe('refused');
    expect(classifySettingsCategoryDeleteResponse(null, null, '7')).toBe('uncertain');
  });

  it('C6 — the confirmation says what Delete does and does not do, and only the effects that apply', () => {
    const plain = settingsCategoryDeleteConfirmation({ name: 'Sketches', slug: 'sketches' });
    expect(plain.title).toBe('Delete category default?');
    expect(plain.confirmLabel).toBe('Delete default');
    expect(plain.cancelLabel).toBe('Cancel');
    expect(plain.message).toContain('Delete the asset category default “Sketches” (directory slug “sketches”)?');
    expect(plain.message).toContain('projects created from now on will not get this category');
    expect(plain.message).toContain('Categories already copied into existing projects, with their assets, files and release selections, are not changed');
    expect(plain.message).toContain('This cannot be undone.');
    expect(plain.message).not.toMatch(/asset browser default|preview category|unsaved/);
    const all = settingsCategoryDeleteConfirmation({ name: 'Final', slug: 'final', browserDefault: true, previewCategory: true, drafts: true });
    expect(all.message).toContain('It is the saved global asset browser default');
    expect(all.message).toContain('It is the saved preview category');
    expect(all.message).toContain('Your unsaved changes to its name or slug will not be saved');
    expect(all.cancelLabel).toBe('Keep editing');
  });
});

describe('Settings category default Delete in place', () => {
  it('C1 / C2 / C5 / C7 — the confirmation names the saved default and its real effects; opening it sends nothing', () => {
    const t = setup();
    expect(enhanceSettingsCategoryDelete(t.document)).not.toBeNull();
    t.row('3').querySelector('input[name="displayName"]').value = 'Final draft';
    const click = t.deleteButton('3').click();
    expect(click.defaultPrevented).toBe(false);
    const fields = confirmations.described.get(t.deleteButton('3'))();
    expect(fields.message).toContain('“Final” (directory slug “final”)');
    expect(fields.message).toContain('It is the saved global asset browser default');
    expect(fields.message).not.toContain('saved preview category');
    expect(fields.message).toContain('Your unsaved changes to its name or slug will not be saved');
    expect(t.posts).toHaveLength(0);
    expect(t.row('3').querySelector('input[name="displayName"]').value).toBe('Final draft');
  });

  it('C4 / C9 / C20 — one confirmed submit sends one POST; a repeated submit or click is refused while it is pending', async () => {
    const t = setup();
    enhanceSettingsCategoryDelete(t.document);
    const answer = deferred();
    t.queue.post.push(() => answer.promise);
    const { submit } = t.confirmDelete('7');
    expect(submit.defaultPrevented).toBe(true);
    await flush();
    expect(t.posts).toEqual([{ url: '/settings/asset-categories/7/delete', body: '_csrf=token-1', accept: 'application/json' }]);
    expect(settingsCategoryDeleteState(t.document, '7').phase).toBe('pending');
    expect(t.row('7').getAttribute('data-settings-category-delete-hold')).toBe('pending');
    expect(t.deleteButton('7').getAttribute('aria-disabled')).toBe('true');
    expect(t.deleteForm('7').dispatch('submit').defaultPrevented).toBe(true);
    expect(t.deleteButton('7').click().defaultPrevented).toBe(true);
    expect(t.deleteButton('3').click().defaultPrevented).toBe(true);
    expect(t.feedbackText()).toContain(M.otherPending);
    expect(t.posts).toHaveLength(1);
    answer.resolve(jsonResponse(500, { status: 'error', code: 'ASSET_CATEGORY_DEFAULT_DELETE_FAILED', outcome: 'failed', message: 'The asset category default could not be deleted. Nothing was deleted. Please try again.' }));
    await flush();
    expect(settingsCategoryDeleteState(t.document, '7')).toBeNull();
    expect(t.row('7')).not.toBeNull();
    expect(t.deleteButton('7').hasAttribute('aria-disabled')).toBe(false);
    expect(t.feedbackText()).toBe('The asset category default could not be deleted. Nothing was deleted. Please try again.');
    expect(t.gets).toHaveLength(0);
    expect(t.posts).toHaveLength(1);
  });

  it('C8 / C23 — a refusal before the route keeps the row and its draft and says nothing was deleted', async () => {
    const t = setup();
    enhanceSettingsCategoryDelete(t.document);
    t.row('9').querySelector('input[name="directorySlug"]').value = 'exports-draft';
    t.queue.post.push(async () => jsonResponse(403, { status: 'error', message: 'Invalid or missing CSRF token.' }));
    t.confirmDelete('9');
    await flush();
    expect(t.feedbackText()).toBe(`Invalid or missing CSRF token. ${M.nothingDeleted} ${M.draftsKept}`);
    expect(t.row('9').querySelector('input[name="directorySlug"]').value).toBe('exports-draft');
    expect(t.gets).toHaveLength(0);
  });

  it('C24 — a conflicting Settings mutation in flight refuses Delete before the confirmation opens', () => {
    const t = setup();
    enhanceSettingsCategoryDelete(t.document);
    const cases = [
      [() => t.page.root.querySelector('[data-category-reorder-form]'), M.reorderBusy, '7'],
      [() => t.row('7').querySelector('form[data-category-details-form]'), M.detailsBusy, '7'],
      [() => t.row('7').querySelector('form.category-enabled-form'), M.statusBusy, '7'],
      [() => t.page.root.querySelector('[data-settings-asset-category-preference] form'), M.preferenceBusy, '3'],
    ];
    for (const [element, message, id] of cases) {
      element().setAttribute('aria-busy', 'true');
      confirmations.described.clear();
      expect(t.deleteButton(id).click().defaultPrevented).toBe(true);
      expect(confirmations.described.size).toBe(0);
      expect(t.feedbackText()).toContain(message);
      element().removeAttribute('aria-busy');
    }
    // Another row's details saving does not hold this Delete.
    t.row('9').querySelector('form[data-category-details-form]').setAttribute('aria-busy', 'true');
    expect(t.deleteButton('7').click().defaultPrevented).toBe(false);
    expect(t.posts).toHaveLength(0);
  });

  it('C13 / C17 / C18 / C21 — confirmed: the row goes, focus moves to the heading, and only the GET read is installed', async () => {
    const t = setup();
    enhanceSettingsCategoryDelete(t.document);
    t.deleteButton('7').focus();
    t.queue.post.push(async () => jsonResponse(200, deletedBody(CATEGORIES[1])));
    const read = deferred();
    t.queue.get.push(() => read.promise);
    t.confirmDelete('7');
    await flush();
    expect(t.row('7')).toBeNull();
    expect(t.document.activeElement.id).toBe('settings-category-defaults-heading');
    expect(t.row('9').getAttribute('aria-posinset')).toBe('2');
    expect(t.feedbackText()).toBe(`Asset category default “Sketches” deleted. ${M.updating}`);
    expect(settingsCategoryDeleteSync(t.document)).toBe('refreshing');
    expect(t.gets).toEqual([{ url: '/settings/asset-categories', method: 'GET', accept: 'text/html', cache: 'no-store' }]);
    // Meanwhile row 9 gets an unsaved name and the browser default is saving.
    t.row('9').querySelector('input[name="displayName"]').value = 'Exports draft';
    t.page.root.querySelector('[data-settings-asset-category-preference="browser-default"] form').setAttribute('aria-busy', 'true');
    // The order cannot change while the list is updating.
    expect(t.row('3').querySelector('[data-category-reorder-handle]').dispatch('keydown', { key: 'ArrowDown' }).defaultPrevented).toBe(true);
    read.resolve(htmlResponse({
      version: 'fresh',
      categories: [CATEGORIES[2], { id: '3', name: 'Final (renamed elsewhere)', slug: 'final' }, { id: '12', name: 'Added elsewhere', slug: 'added' }],
      preferences: { 'browser-default': 'final', 'preview-category': 'exports' },
    }));
    await flush();
    const section = t.page.root.querySelector('[data-settings-category-defaults]');
    expect(section.getAttribute('data-version')).toBe('fresh');
    expect(section.querySelectorAll('article[data-category-id]').map((node) => node.getAttribute('data-category-id'))).toEqual(['9', '3', '12']);
    expect(t.row('9').querySelector('input[name="displayName"]').value).toBe('Exports draft');
    expect(t.row('3').querySelector('input[name="displayName"]').value).toBe('Final (renamed elsewhere)');
    expect(t.page.root.querySelector('[data-settings-asset-category-preference="browser-default"] [data-region-version]').getAttribute('data-region-version')).toBe('initial');
    expect(t.page.root.querySelector('[data-settings-asset-category-preference="preview-category"]').getAttribute('data-settings-asset-category-preference-stored')).toBe('exports');
    expect(enhanced).toMatchObject({ reorder: 1, details: 1, autosubmit: 1, confirm: 1, prefs: 1, dropdowns: 1 });
    expect(settingsCategoryDeleteSync(t.document)).toBe('idle');
    expect(t.feedbackText()).toBe(`Asset category default “Sketches” deleted. ${M.upToDate}`);
    expect(t.posts).toHaveLength(1);
    // The deleted default cannot be deleted again from here.
    expect(settingsCategoryDeleteState(t.document, '7').phase).toBe('deleted');
  });

  it('C14 / C15 / C16 — confirmed with a failed read: still deleted, Delete unavailable, Retry refresh reads only; a superseded read never installs', async () => {
    const t = setup();
    enhanceSettingsCategoryDelete(t.document);
    t.queue.post.push(async () => jsonResponse(200, deletedBody(CATEGORIES[1])));
    t.queue.get.push(async () => { throw new TypeError('Failed to fetch'); });
    t.confirmDelete('7');
    await flush();
    expect(settingsCategoryDeleteState(t.document, '7').phase).toBe('deleted');
    expect(settingsCategoryDeleteSync(t.document)).toBe('stale');
    expect(t.feedbackText()).toContain('Asset category default “Sketches” deleted.');
    expect(t.feedbackText()).toContain(M.refreshFailed);
    expect(t.feedbackText()).not.toMatch(/could not be deleted/);
    expect(t.deleteButton('3').click().defaultPrevented).toBe(true);
    expect(t.feedbackText()).toContain(M.stale);
    const retry = t.feedbackButton('data-settings-category-delete-refresh-retry');
    expect(retry.textContent).toBe('Retry refresh');
    // Two reads: the first is superseded by the second before answering.
    const first = deferred();
    t.queue.get.push(() => first.promise);
    retry.click();
    t.queue.get.push(async () => htmlResponse({ version: 'second', categories: [CATEGORIES[0], CATEGORIES[2]], preferences: {} }));
    const controller = enhanceSettingsCategoryDelete(t.document);
    await controller.refresh();
    expect(t.page.root.querySelector('[data-settings-category-defaults]').getAttribute('data-version')).toBe('second');
    first.resolve(htmlResponse({ version: 'stale-first', categories: CATEGORIES, preferences: {} }));
    await flush();
    expect(t.page.root.querySelector('[data-settings-category-defaults]').getAttribute('data-version')).toBe('second');
    expect(t.row('7')).toBeNull();
    expect(t.gets.every((get) => get.method === 'GET')).toBe(true);
    expect(t.posts).toHaveLength(1);
    expect(settingsCategoryDeleteSync(t.document)).toBe('idle');
  });

  it('C10 / C11 / C12 — a lost answer stays unresolved: an early read showing it present settles nothing; Check again only reads', async () => {
    const t = setup();
    enhanceSettingsCategoryDelete(t.document);
    t.row('7').querySelector('input[name="displayName"]').value = 'Sketch draft';
    t.queue.post.push(async () => { throw new TypeError('Failed to fetch'); });
    t.queue.get.push(async () => htmlResponse({ categories: CATEGORIES, preferences: {} }));
    t.confirmDelete('7');
    await flush();
    expect(settingsCategoryDeleteState(t.document, '7').phase).toBe('unresolved');
    expect(t.feedbackText()).toContain(`“Sketches”: ${M.unconfirmed} ${M.stillPresent}`);
    expect(t.row('7').getAttribute('data-settings-category-delete-hold')).toBe('unresolved');
    expect(t.row('7').querySelector('input[name="displayName"]').value).toBe('Sketch draft');
    // Held: Delete, details and status of this default; the order.
    confirmations.described.clear();
    expect(t.deleteButton('7').click().defaultPrevented).toBe(true);
    expect(confirmations.described.size).toBe(0);
    expect(t.deleteForm('7').dispatch('submit').defaultPrevented).toBe(true);
    const nameField = t.row('7').querySelector('input[name="displayName"]');
    const ownChange = vi.fn();
    nameField.addEventListener('change', ownChange);
    nameField.dispatch('change');
    expect(ownChange).not.toHaveBeenCalled();
    const toggle = t.row('7').querySelector('input[type="checkbox"]');
    toggle.checked = false;
    toggle.dispatch('change');
    expect(toggle.checked).toBe(true);
    expect(t.row('7').querySelector('form[data-category-details-form]').dispatch('submit').defaultPrevented).toBe(true);
    expect(t.row('3').querySelector('[data-category-reorder-handle]').dispatch('dragstart').defaultPrevented).toBe(true);
    // Another default stays editable and deletable.
    expect(t.deleteButton('9').click().defaultPrevented).toBe(false);
    expect(t.posts).toHaveLength(1);

    const check = t.feedbackButton('data-settings-category-delete-check');
    expect(check.textContent).toBe('Check again');
    t.queue.get.push(async () => htmlResponse({ categories: CATEGORIES, preferences: {} }));
    check.click();
    await flush();
    expect(settingsCategoryDeleteState(t.document, '7').phase).toBe('unresolved');
    expect(t.gets).toHaveLength(2);
    expect(t.posts).toHaveLength(1);

    // A read finding it gone settles that it is gone, never that this page deleted it.
    t.queue.get.push(async () => htmlResponse({ version: 'after', categories: [CATEGORIES[0], CATEGORIES[2]], preferences: {} }));
    t.feedbackButton('data-settings-category-delete-check').click();
    await flush();
    expect(settingsCategoryDeleteState(t.document, '7').phase).toBe('missing');
    expect(t.row('7')).toBeNull();
    expect(t.feedbackText()).toBe(`“Sketches” ${M.observedMissing}`);
    expect(t.feedbackText()).not.toMatch(/deleted\./);
    expect(t.feedbackButton('data-settings-category-delete-check')).toBeNull();
    expect(t.page.root.querySelector('[data-settings-category-defaults]').getAttribute('data-version')).toBe('after');
    expect(t.posts).toHaveLength(1);
  });

  it('C19 — binding again (or after a list install) adds no second listener and keeps the holds', async () => {
    const t = setup();
    const first = enhanceSettingsCategoryDelete(t.document);
    expect(enhanceSettingsCategoryDelete(t.document)).toBe(first);
    expect(confirmations.gates).toBeGreaterThan(0);
    const listeners = t.page.root.listeners.length;
    enhanceSettingsCategoryDelete(t.document);
    expect(t.page.root.listeners.length).toBe(listeners);
    t.queue.post.push(async () => { throw new TypeError('lost'); });
    t.queue.get.push(async () => ({ ok: false, status: 500, text: async () => '' }));
    t.confirmDelete('9');
    await flush();
    expect(t.feedbackText()).toContain(M.checkFailed);
    // A later install (another default's refresh) re-applies the hold.
    t.queue.post.push(async () => jsonResponse(200, deletedBody(CATEGORIES[0])));
    t.queue.get.push(async () => htmlResponse({ version: 'b', categories: [CATEGORIES[1], CATEGORIES[2]], preferences: {} }));
    t.confirmDelete('3');
    await flush();
    expect(t.page.root.querySelector('[data-settings-category-defaults]').getAttribute('data-version')).toBe('b');
    expect(t.row('9').getAttribute('data-settings-category-delete-hold')).toBe('unresolved');
    expect(t.deleteButton('9').getAttribute('aria-disabled')).toBe('true');
    expect(t.feedbackText()).toContain(`“Exports”: ${M.unconfirmed}`);
    expect(t.posts.map((post) => post.url)).toEqual(['/settings/asset-categories/9/delete', '/settings/asset-categories/3/delete']);
  });

  it('a 404 answer removes the row as gone, not as deleted by this page', async () => {
    const t = setup();
    enhanceSettingsCategoryDelete(t.document);
    t.queue.post.push(async () => jsonResponse(404, NOT_FOUND));
    t.queue.get.push(async () => htmlResponse({ categories: [CATEGORIES[0], CATEGORIES[2]], preferences: {} }));
    t.confirmDelete('7');
    await flush();
    expect(settingsCategoryDeleteState(t.document, '7').phase).toBe('missing');
    expect(t.row('7')).toBeNull();
    expect(t.feedbackText()).toBe(`${M.goneUnconfirmed} ${M.upToDate}`);
  });

  it('the native Add form cannot leave the page while a Delete is in flight', () => {
    const t = setup();
    enhanceSettingsCategoryDelete(t.document);
    t.confirmDelete('7');
    const add = t.page.root.querySelector('form[action="/settings/asset-categories"]');
    expect(add.dispatch('submit').defaultPrevented).toBe(true);
    expect(t.feedbackText()).toContain(M.addPending);
  });

  describe('WP11C-F3 — the native Add form cannot discard a held Delete', () => {
    const addForm = (t) => t.page.root.querySelector('form[action="/settings/asset-categories"]');
    const typeAdd = (t, name, slug) => {
      addForm(t).querySelector('input[name="displayName"]').value = name;
      addForm(t).querySelector('input[name="directorySlug"]').value = slug;
    };
    const addValues = (t) => ['displayName', 'directorySlug'].map((name) => addForm(t).querySelector(`input[name="${name}"]`).value);
    // The confirmed Delete of 7 loses its answer; the early read shows it present.
    async function unresolved(t, read = async () => htmlResponse({ categories: CATEGORIES, preferences: {} })) {
      t.queue.post.push(async () => { throw new TypeError('Failed to fetch'); });
      t.queue.get.push(read);
      t.confirmDelete('7');
      await flush();
      expect(settingsCategoryDeleteState(t.document, '7').phase).toBe('unresolved');
    }

    it('F3-C1 — pending Delete: Add is refused before it leaves the page', async () => {
      const t = setup();
      enhanceSettingsCategoryDelete(t.document);
      t.confirmDelete('7');
      await flush();
      typeAdd(t, 'Bonus', 'bonus');
      const ownSubmit = vi.fn();
      addForm(t).addEventListener('submit', ownSubmit);
      expect(addForm(t).dispatch('submit').defaultPrevented).toBe(true);
      expect(ownSubmit).not.toHaveBeenCalled();
      expect(t.feedbackText()).toContain(M.addPending);
      expect(addValues(t)).toEqual(['Bonus', 'bonus']);
      expect(t.posts).toHaveLength(1);
    });

    it('F3-C2 / C4 / C9 / C15 — unresolved after an early read showing it present: Add is refused, drafts and Check again stay', async () => {
      const t = setup();
      enhanceSettingsCategoryDelete(t.document);
      t.row('9').querySelector('input[name="displayName"]').value = 'Exports draft';
      await unresolved(t);
      typeAdd(t, 'Bonus', 'bonus');
      const add = addForm(t);
      add.querySelector('button').focus();
      const event = add.dispatch('submit');
      expect(event.defaultPrevented).toBe(true);
      expect(t.feedbackText()).toContain(M.addHeld);
      expect(t.feedbackText()).not.toContain(M.addPending);
      // The original warning stays, with its only recovery control.
      expect(t.feedbackText()).toContain(`“Sketches”: ${M.unconfirmed} ${M.stillPresent}`);
      expect(t.feedbackButton('data-settings-category-delete-check')?.textContent).toBe('Check again');
      expect(t.feedbackText()).not.toMatch(/category added|default deleted|cancel|failed/i);
      expect(addValues(t)).toEqual(['Bonus', 'bonus']);
      expect(t.row('9').querySelector('input[name="displayName"]').value).toBe('Exports draft');
      expect(t.document.activeElement).toBe(add.querySelector('button'));
      expect(settingsCategoryDeleteState(t.document, '7').phase).toBe('unresolved');
      expect(t.row('7').getAttribute('data-settings-category-delete-hold')).toBe('unresolved');
      expect(t.posts).toHaveLength(1);
      expect(t.gets).toHaveLength(1);
    });

    it('F3-C3 — a failed read does not let Add leave the page', async () => {
      const t = setup();
      enhanceSettingsCategoryDelete(t.document);
      await unresolved(t, async () => ({ ok: false, status: 500, text: async () => '' }));
      expect(t.feedbackText()).toContain(M.checkFailed);
      expect(addForm(t).dispatch('submit').defaultPrevented).toBe(true);
      expect(t.feedbackText()).toContain(M.checkFailed);
      expect(t.feedbackText()).toContain(M.addHeld);
      expect(t.feedbackButton('data-settings-category-delete-check')).not.toBeNull();
      expect(t.posts).toHaveLength(1);
    });

    it('F3-C5 / C7 — repeated Check again showing it present and repeated submits keep Add refused, reading only', async () => {
      const t = setup();
      enhanceSettingsCategoryDelete(t.document);
      await unresolved(t);
      for (let i = 0; i < 3; i += 1) {
        t.queue.get.push(async () => htmlResponse({ categories: CATEGORIES, preferences: {} }));
        t.feedbackButton('data-settings-category-delete-check').click();
        await flush();
        expect(addForm(t).dispatch('submit').defaultPrevented).toBe(true);
        expect(addForm(t).dispatch('submit').defaultPrevented).toBe(true);
      }
      // A superseded read cannot unlock it either.
      const slow = deferred();
      t.queue.get.push(() => slow.promise);
      t.feedbackButton('data-settings-category-delete-check').click();
      t.queue.get.push(async () => htmlResponse({ categories: CATEGORIES, preferences: {} }));
      t.feedbackButton('data-settings-category-delete-check').click();
      await flush();
      slow.resolve(htmlResponse({ categories: [CATEGORIES[0], CATEGORIES[2]], preferences: {} }));
      await flush();
      expect(settingsCategoryDeleteState(t.document, '7').phase).toBe('unresolved');
      expect(addForm(t).dispatch('submit').defaultPrevented).toBe(true);
      expect(t.feedbackText().split(M.addHeld)).toHaveLength(2);
      expect(t.gets.every((get) => get.method === 'GET')).toBe(true);
      expect(t.posts).toHaveLength(1);
    });

    it('F3-C10 / C13 — a list install or binding again keeps one guard, still refusing Add', async () => {
      const t = setup();
      enhanceSettingsCategoryDelete(t.document);
      const listeners = t.page.root.listeners.length;
      await unresolved(t);
      // Another default's confirmed Delete installs a fresh list.
      t.queue.post.push(async () => jsonResponse(200, deletedBody(CATEGORIES[0])));
      t.queue.get.push(async () => htmlResponse({ version: 'b', categories: [CATEGORIES[1], CATEGORIES[2]], preferences: {} }));
      t.confirmDelete('3');
      await flush();
      expect(t.page.root.querySelector('[data-settings-category-defaults]').getAttribute('data-version')).toBe('b');
      enhanceSettingsCategoryDelete(t.document);
      expect(t.page.root.listeners.length).toBe(listeners);
      expect(addForm(t).dispatch('submit').defaultPrevented).toBe(true);
      expect(t.feedbackText()).toContain(M.addHeld);
      expect(t.posts.map((post) => post.url)).toEqual(['/settings/asset-categories/7/delete', '/settings/asset-categories/3/delete']);
    });

    it('F3-C11 / C14 — with nothing held, Add stays native and untouched', () => {
      const t = setup();
      enhanceSettingsCategoryDelete(t.document);
      typeAdd(t, 'Bonus', 'bonus');
      const ownSubmit = vi.fn();
      addForm(t).addEventListener('submit', ownSubmit);
      expect(addForm(t).dispatch('submit').defaultPrevented).toBe(false);
      expect(ownSubmit).toHaveBeenCalledTimes(1);
      expect(t.page.root.querySelector('[data-dialog-feedback]').hasAttribute('hidden')).toBe(true);
      expect(t.posts).toHaveLength(0);
      expect(t.gets).toHaveLength(0);
    });

    it('F3-C12 — a read finding it gone, a confirmed Delete or a refusal ends the hold; Add is native again', async () => {
      const gone = setup();
      enhanceSettingsCategoryDelete(gone.document);
      await unresolved(gone);
      gone.queue.get.push(async () => htmlResponse({ categories: [CATEGORIES[0], CATEGORIES[2]], preferences: {} }));
      gone.feedbackButton('data-settings-category-delete-check').click();
      await flush();
      expect(settingsCategoryDeleteState(gone.document, '7').phase).toBe('missing');
      expect(addForm(gone).dispatch('submit').defaultPrevented).toBe(false);

      const deleted = setup();
      enhanceSettingsCategoryDelete(deleted.document);
      deleted.queue.post.push(async () => jsonResponse(200, deletedBody(CATEGORIES[1])));
      deleted.queue.get.push(async () => htmlResponse({ categories: [CATEGORIES[0], CATEGORIES[2]], preferences: {} }));
      deleted.confirmDelete('7');
      await flush();
      expect(addForm(deleted).dispatch('submit').defaultPrevented).toBe(false);

      const refused = setup();
      enhanceSettingsCategoryDelete(refused.document);
      refused.queue.post.push(async () => jsonResponse(403, { status: 'error', message: 'Invalid or missing CSRF token.' }));
      refused.confirmDelete('7');
      await flush();
      expect(addForm(refused).dispatch('submit').defaultPrevented).toBe(false);
    });
  });

  it('C22 — without fetch the form stays native', () => {
    const t = setup({ withFetch: false });
    enhanceSettingsCategoryDelete(t.document);
    expect(t.deleteButton('7').click().defaultPrevented).toBe(false);
    expect(t.deleteForm('7').dispatch('submit').defaultPrevented).toBe(false);
    expect(settingsCategoryDeleteState(t.document, '7')).toBeNull();
  });

  it('binds nothing on a page without the default list', () => {
    const document = { nodeType: 9, addEventListener: vi.fn(), querySelector: () => null };
    expect(enhanceSettingsCategoryDelete(document)).toBeNull();
    expect(document.addEventListener).not.toHaveBeenCalled();
  });
});

// WP11C-F1: installing a list read never saves a category default. In
// Chromium, taking a focused edited field out of the page fires change (then
// blur) while it is still in the page, and the details form saves on change.
// The shim emulates that ("chromium" below); "atomic" adds moveBefore, which
// keeps a node in the page while moving it, so nothing fires. The details
// form's save is stood in for by a change listener on each name/slug field.
describe('WP11C-F1 — a list install never saves an unrelated edited category', () => {
  const restore = [];
  afterEach(() => { restore.splice(0).reverse().forEach((undo) => undo()); });

  function patch(name, value) {
    const had = Object.prototype.hasOwnProperty.call(FakeNode.prototype, name);
    const previous = FakeNode.prototype[name];
    FakeNode.prototype[name] = value;
    restore.push(() => { if (had) FakeNode.prototype[name] = previous; else delete FakeNode.prototype[name]; });
  }

  // Chromium: a focused field whose value changed since it was focused fires
  // change while still in the page when it is taken out of it.
  function chromium() {
    const endEdit = (node) => {
      const document = node.root.document;
      const active = document?.live ? document.activeElement : null;
      if (!active || !node.contains(active) || active.valueAtFocus === undefined) return;
      if (active.value === active.valueAtFocus) return;
      active.valueAtFocus = active.value;
      active.dispatch('change');
    };
    const removeChildNode = FakeNode.prototype.removeChildNode;
    const replaceWith = FakeNode.prototype.replaceWith;
    patch('removeChildNode', function removeChild(child) { endEdit(child); return removeChildNode.call(this, child); });
    patch('replaceWith', function replace(next) { endEdit(this); return replaceWith.call(this, next); });
  }

  // moveBefore: the node never leaves the page; focus and state stay.
  function atomic() {
    const moves = [];
    patch('before', function before(node) {
      node.parentNode?.removeChildNode(node);
      const parent = this.parentNode;
      parent.childNodes.splice(parent.childNodes.indexOf(this), 0, node);
      node.parentNode = parent;
    });
    patch('moveBefore', function moveBefore(node, reference) {
      if (!this.isConnected || !node.isConnected) throw new Error('HierarchyRequestError');
      moves.push(node);
      node.parentNode.childNodes = node.parentNode.childNodes.filter((child) => child !== node);
      this.childNodes.splice(reference ? this.childNodes.indexOf(reference) : this.childNodes.length, 0, node);
      node.parentNode = this;
    });
    return moves;
  }

  const field = (t, id, name = 'displayName') => t.row(id)?.querySelector(`input[name="${name}"]`);

  // The details forms' change-to-save, standing in for category-details.js.
  function autosave(t) {
    const saves = [];
    t.page.root.querySelectorAll('[data-settings-category-defaults] input[name="displayName"], [data-settings-category-defaults] input[name="directorySlug"]')
      .forEach((node) => node.addEventListener('change', () => saves.push([node.closest('article').getAttribute('data-category-id'), node.name, node.value])));
    return saves;
  }

  function edit(t, node, text, { caret = null } = {}) {
    node.focus();
    node.valueAtFocus = node.value;
    node.value = text;
    node.selectionStart = caret?.[0] ?? text.length;
    node.selectionEnd = caret?.[1] ?? text.length;
    node.selectionDirection = 'none';
    node.setSelectionRange = function setSelectionRange(start, end, direction) {
      this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction;
    };
    node.dispatch('input');
  }

  const fresh = (version = 'fresh', categories = [CATEGORIES[0], CATEGORIES[2]], preferences = { 'browser-default': 'final', 'preview-category': 'disabled' }) =>
    htmlResponse({ version, categories, preferences });

  // Delete 7 is confirmed; its list read is held until resolved.
  async function deletedWithHeldRead(t) {
    t.queue.post.push(async () => jsonResponse(200, deletedBody(CATEGORIES[1])));
    const read = deferred();
    t.queue.get.push(() => read.promise);
    t.confirmDelete('7');
    await flush();
    expect(settingsCategoryDeleteSync(t.document)).toBe('refreshing');
    return read;
  }

  for (const mode of ['atomic', 'chromium-detach']) {
    it(`F1-C1 / C2 / C3 / C4 / C11 / C15 / C16 — ${mode}: a focused draft in a survivor is not saved by the install; draft, saved value, id, focus and caret stay`, async () => {
      if (mode === 'atomic') { chromium(); atomic(); } else chromium();
      const t = setup();
      enhanceSettingsCategoryDelete(t.document);
      const saves = autosave(t);
      const read = await deletedWithHeldRead(t);
      const name = field(t, '9');
      edit(t, name, 'Exports draft', { caret: [2, 6] });
      const reorderSubmits = [];
      t.page.root.addEventListener('submit', (event) => { if (event.target.matches('form[data-category-reorder-form]')) reorderSubmits.push(event); }, true);
      read.resolve(fresh('fresh', [{ id: '9', name: 'Exports', slug: 'exports' }, CATEGORIES[0]]));
      await flush();
      expect(t.page.root.querySelector('[data-settings-category-defaults]').getAttribute('data-version')).toBe('fresh');
      expect(saves).toEqual([]);
      expect(t.posts).toHaveLength(1);
      const after = field(t, '9');
      expect(after.value).toBe('Exports draft');
      expect(after.defaultValue).toBe('Exports');
      expect(after.closest('article').getAttribute('data-category-id')).toBe('9');
      expect(t.document.activeElement).toBe(after);
      expect([after.selectionStart, after.selectionEnd]).toEqual([2, 6]);
      // Same element, wherever the browser can keep it in the page.
      if (mode === 'atomic') expect(after).toBe(name);
      // Order comes from the read; nothing saved it.
      expect(t.page.root.querySelectorAll('[data-settings-category-defaults] article[data-category-id]').map((node) => node.getAttribute('data-category-id'))).toEqual(['9', '3']);
      expect(reorderSubmits).toEqual([]);
      expect(t.row('7')).toBeNull();
      expect(settingsCategoryDeleteState(t.document, '7').phase).toBe('deleted');
      expect(t.feedbackText()).toBe(`Asset category default “Sketches” deleted. ${M.upToDate}`);
      // F1-C5: the person's own change still saves, once.
      after.dispatch('change');
      expect(saves).toEqual([['9', 'displayName', 'Exports draft']]);
    });
  }

  it('F1-C5 / C17 / C19 — after an install, real changes to name, slug and status reach their own save once; no listener is added twice', async () => {
    chromium();
    const t = setup();
    enhanceSettingsCategoryDelete(t.document);
    const documentListeners = t.page.root.listeners.length;
    const read = await deletedWithHeldRead(t);
    edit(t, field(t, '3'), 'Final draft');
    read.resolve(fresh());
    await flush();
    expect(enhanced).toMatchObject({ reorder: 1, details: 1, autosubmit: 1, confirm: 1 });
    enhanceSettingsCategoryDelete(t.document);
    expect(t.page.root.listeners.length).toBe(documentListeners);
    const saves = autosave(t);
    const statusChanges = [];
    const toggle = t.row('9').querySelector('input[type="checkbox"]');
    toggle.addEventListener('change', () => statusChanges.push(toggle.checked));
    field(t, '3').dispatch('change');
    field(t, '9', 'directorySlug').value = 'exports-2';
    field(t, '9', 'directorySlug').dispatch('change');
    toggle.checked = false;
    toggle.dispatch('change');
    expect(saves).toEqual([['3', 'displayName', 'Final draft'], ['9', 'directorySlug', 'exports-2']]);
    expect(statusChanges).toEqual([false]);
    expect(t.posts).toHaveLength(1);
  });

  it('F1-C6 — a refused draft (error state) and a focused draft both survive; neither is saved', async () => {
    chromium();
    const t = setup();
    enhanceSettingsCategoryDelete(t.document);
    const saves = autosave(t);
    t.row('3').querySelector('form[data-category-details-form]').setAttribute('data-category-details-state', 'error');
    field(t, '3', 'directorySlug').value = 'Bad Slug!';
    const read = await deletedWithHeldRead(t);
    edit(t, field(t, '9'), 'Exports draft');
    read.resolve(fresh());
    await flush();
    expect(saves).toEqual([]);
    expect(field(t, '3', 'directorySlug').value).toBe('Bad Slug!');
    expect(t.row('3').querySelector('form[data-category-details-form]').getAttribute('data-category-details-state')).toBe('error');
    expect(field(t, '9').value).toBe('Exports draft');
    expect(t.document.activeElement).toBe(field(t, '9'));
  });

  it('F1-C7 — a save in flight is kept as it is: still pending, its submitted value shown, nothing sent again', async () => {
    chromium();
    const t = setup();
    enhanceSettingsCategoryDelete(t.document);
    const saves = autosave(t);
    const details = t.row('9').querySelector('form[data-category-details-form]');
    field(t, '9').value = 'Exports sent';
    details.setAttribute('aria-busy', 'true');
    const read = await deletedWithHeldRead(t);
    read.resolve(fresh());
    await flush();
    expect(t.row('9').querySelector('form[data-category-details-form]')).toBe(details);
    expect(details.getAttribute('aria-busy')).toBe('true');
    expect(field(t, '9').value).toBe('Exports sent');
    expect(saves).toEqual([]);
    expect(t.posts).toHaveLength(1);
  });

  it('F1-C8 / C9 — an older read cannot overwrite a save or an edit made after it started', async () => {
    chromium();
    const t = setup();
    enhanceSettingsCategoryDelete(t.document);
    const read = await deletedWithHeldRead(t);
    // Saved after the read started: the details form's own render is newer.
    const saved = t.row('3').querySelector('form[data-category-details-form]');
    saved.dispatch('submit');
    field(t, '3').value = 'Final newer';
    field(t, '3').defaultValue = 'Final newer';
    // Edited after the read started, not focused any more.
    field(t, '9').value = 'Exports later';
    field(t, '9').dispatch('input');
    const saves = autosave(t);
    read.resolve(fresh('stale', [{ id: '3', name: 'Final', slug: 'final' }, { id: '9', name: 'Exports', slug: 'exports' }]));
    await flush();
    expect(field(t, '3').value).toBe('Final newer');
    expect(field(t, '3').defaultValue).toBe('Final newer');
    expect(field(t, '9').value).toBe('Exports later');
    expect(field(t, '9').defaultValue).toBe('Exports');
    expect(saves).toEqual([]);
  });

  it('F1-C10 — several dirty survivors stay independent, each on its own id', async () => {
    chromium();
    const t = setup({ categories: [...CATEGORIES, { id: '11', name: 'Raw', slug: 'raw' }] });
    enhanceSettingsCategoryDelete(t.document);
    const saves = autosave(t);
    const read = await deletedWithHeldRead(t);
    field(t, '3', 'directorySlug').value = 'final-draft';
    field(t, '3', 'directorySlug').dispatch('input');
    edit(t, field(t, '11'), 'Raw draft');
    read.resolve(fresh('fresh', [CATEGORIES[0], CATEGORIES[2], { id: '11', name: 'Raw', slug: 'raw' }]));
    await flush();
    expect(saves).toEqual([]);
    expect(['3', '9', '11'].map((id) => [field(t, id).value, field(t, id, 'directorySlug').value])).toEqual([
      ['Final', 'final-draft'], ['Exports', 'exports'], ['Raw draft', 'raw'],
    ]);
    expect(['3', '9', '11'].map((id) => t.row(id).querySelectorAll('form[data-category-details-form]').length)).toEqual([1, 1, 1]);
    expect(t.document.activeElement).toBe(field(t, '11'));
  });

  it('F1-C12 / C13 / C14 — a failed read, Retry refresh and a superseded read install or save nothing they should not', async () => {
    chromium();
    const t = setup();
    enhanceSettingsCategoryDelete(t.document);
    const saves = autosave(t);
    t.queue.post.push(async () => jsonResponse(200, deletedBody(CATEGORIES[1])));
    t.queue.get.push(async () => { throw new TypeError('Failed to fetch'); });
    t.confirmDelete('7');
    await flush();
    expect(settingsCategoryDeleteSync(t.document)).toBe('stale');
    edit(t, field(t, '9'), 'Exports draft');
    expect(saves).toEqual([]);
    // Retry (read held), then a second refresh supersedes it.
    const first = deferred();
    t.queue.get.push(() => first.promise);
    t.feedbackButton('data-settings-category-delete-refresh-retry').click();
    t.document.activeElement = field(t, '9');
    const second = deferred();
    t.queue.get.push(() => second.promise);
    const done = enhanceSettingsCategoryDelete(t.document).refresh();
    second.resolve(fresh('second'));
    await done;
    first.resolve(fresh('first', CATEGORIES));
    await flush();
    expect(t.page.root.querySelector('[data-settings-category-defaults]').getAttribute('data-version')).toBe('second');
    expect(t.row('7')).toBeNull();
    expect(saves).toEqual([]);
    expect(field(t, '9').value).toBe('Exports draft');
    expect(t.document.activeElement).toBe(field(t, '9'));
    expect(t.gets.every((get) => get.method === 'GET')).toBe(true);
    expect(t.posts).toHaveLength(1);
  });

  it('F1-C18 — the F3 Add guard still holds after an install, and a finished install leaves Add native again', async () => {
    chromium();
    const t = setup();
    enhanceSettingsCategoryDelete(t.document);
    const add = t.page.root.querySelector('form[action="/settings/asset-categories"]');
    // Confirmed Delete of 7, installed: nothing held, Add stays native.
    const read = await deletedWithHeldRead(t);
    read.resolve(fresh());
    await flush();
    expect(add.dispatch('submit').defaultPrevented).toBe(false);
    // An unresolved Delete of 3, with an early read showing it present: Add is refused.
    t.queue.post.push(async () => { throw new TypeError('Failed to fetch'); });
    t.queue.get.push(async () => fresh('present'));
    t.confirmDelete('3');
    await flush();
    expect(settingsCategoryDeleteState(t.document, '3').phase).toBe('unresolved');
    expect(add.dispatch('submit').defaultPrevented).toBe(true);
    expect(t.feedbackText()).toContain(M.addHeld);
    expect(t.posts).toHaveLength(2);
  });

  it('F1-C20 — a Defaults setting replaced by the install raises no save of its own', async () => {
    chromium();
    const t = setup();
    enhanceSettingsCategoryDelete(t.document);
    const preferenceSaves = [];
    const select = t.page.root.querySelector('[data-settings-asset-category-preference="browser-default"] select');
    select.addEventListener('change', () => preferenceSaves.push(select.value));
    const read = await deletedWithHeldRead(t);
    // Focused with a value the browser has not reported yet.
    select.focus();
    select.valueAtFocus = 'final';
    select.value = 'exports';
    read.resolve(fresh('fresh', [CATEGORIES[0], CATEGORIES[2]], { 'browser-default': 'exports', 'preview-category': 'disabled' }));
    await flush();
    expect(preferenceSaves).toEqual([]);
    expect(t.posts).toHaveLength(1);
    // Afterwards the installed control's own changes are not blocked.
    const installed = t.page.root.querySelector('[data-settings-asset-category-preference="browser-default"] select');
    const later = [];
    installed.addEventListener('change', () => later.push('saved'));
    installed.dispatch('change');
    expect(later).toEqual(['saved']);
  });

  // WP11C-F5: a browser without moveBefore. The shim's "browser" adds what
  // the fallback depends on: focusing a field sets the value its change is
  // compared with (so focus put back by the install makes the draft that
  // value), leaving an edited field raises change and then focusout (with the
  // page's focus already moved), and taking a focused field out of the page
  // does the same while it is still in the page.
  function browser(t) {
    const leave = (node) => {
      const document = node.root.document;
      if (node.valueAtFocus !== undefined && node.value !== node.valueAtFocus) {
        node.valueAtFocus = node.value;
        node.dispatch('change');
      }
      document.activeElement = document.body;
      node.dispatch('focusout');
    };
    const detach = (node) => {
      const document = node.root.document;
      const active = document?.live ? document.activeElement : null;
      if (active && active !== document.body && node.contains(active)) leave(active);
    };
    const removeChildNode = FakeNode.prototype.removeChildNode;
    const replaceWith = FakeNode.prototype.replaceWith;
    patch('removeChildNode', function removeChild(child) { detach(child); return removeChildNode.call(this, child); });
    patch('replaceWith', function replace(next) { detach(this); return replaceWith.call(this, next); });
    patch('focus', function focus() {
      const document = this.ownerDocument;
      if (!document || document.activeElement === this) return;
      const previous = document.activeElement;
      if (previous && previous !== document.body && previous.isConnected) leave(previous);
      document.activeElement = this;
      this.valueAtFocus = this.value;
      this.dispatch('focusin');
    });
    patch('dispatchEvent', function dispatchEvent(event) { return !this.dispatch(event.type).defaultPrevented; });
    t.window.Event = class Event { constructor(type, init = {}) { this.type = type; this.bubbles = init.bubbles === true; } };
  }

  // The person types into a field they focus (caret at the end unless given).
  function type(node, text, caret) {
    node.focus();
    node.value = text;
    node.selectionStart = caret?.[0] ?? text.length;
    node.selectionEnd = caret?.[1] ?? text.length;
    node.selectionDirection = 'none';
    node.setSelectionRange = function setSelectionRange(start, end, direction) {
      this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction;
    };
    node.dispatch('input');
  }

  const owed = (t) => t.document.__creatorCrateSettingsCategoryDelete.owedChange;

  async function installWhileTyping(t, node, text, caret) {
    const read = await deletedWithHeldRead(t);
    type(node, text, caret);
    read.resolve(fresh());
    await flush();
    return read;
  }

  for (const name of ['displayName', 'directorySlug']) {
    it(`F5-C1 / C2 / C3 / C4 / C5 / C6 / C7 / C8 / C9 / C17 — ${name}: the fallback install keeps the focused draft unsaved; one Tab then saves it once with no more typing`, async () => {
      const t = setup();
      browser(t);
      enhanceSettingsCategoryDelete(t.document);
      const saves = autosave(t);
      const node = field(t, '9', name);
      const saved = node.defaultValue;
      await installWhileTyping(t, node, `${saved}-draft`, [1, 3]);
      // Installed: nothing saved, nothing sent; the draft, saved value, id,
      // focus and caret stay.
      expect(t.page.root.querySelector('[data-settings-category-defaults]').getAttribute('data-version')).toBe('fresh');
      expect(saves).toEqual([]);
      expect(t.posts).toHaveLength(1);
      expect(t.row('7')).toBeNull();
      expect(field(t, '9', name)).toBe(node);
      expect(node.value).toBe(`${saved}-draft`);
      expect(node.defaultValue).toBe(saved);
      expect(node.closest('article').getAttribute('data-category-id')).toBe('9');
      expect(t.document.activeElement).toBe(node);
      expect([node.selectionStart, node.selectionEnd]).toEqual([1, 3]);
      // The browser itself now compares with the draft: its own leave would raise nothing.
      expect(node.valueAtFocus).toBe(`${saved}-draft`);
      expect(owed(t)).toBe(node);
      // One Tab, no more typing: exactly one save of the draft.
      field(t, '9', name === 'displayName' ? 'directorySlug' : 'displayName').focus();
      expect(saves).toEqual([['9', name, `${saved}-draft`]]);
      expect(owed(t)).toBeNull();
      // Coming back and leaving it unchanged sends nothing more.
      node.focus();
      field(t, '3').focus();
      expect(saves).toHaveLength(1);
      expect(t.posts).toHaveLength(1);
    });
  }

  it('F5-C6 / C9 — typing more after the install: the browser\'s own change saves once and nothing is raised again; leaving it back at its focused value sends nothing', async () => {
    const t = setup();
    browser(t);
    enhanceSettingsCategoryDelete(t.document);
    const saves = autosave(t);
    const node = field(t, '9');
    await installWhileTyping(t, node, 'Exports draft');
    node.value = 'Exports drafter';
    node.dispatch('input');
    field(t, '3').focus();
    expect(saves).toEqual([['9', 'displayName', 'Exports drafter']]);
    // A focused field typed back to what it held when focused leaves silently.
    const other = setup();
    browser(other);
    enhanceSettingsCategoryDelete(other.document);
    const otherSaves = autosave(other);
    const otherNode = field(other, '9');
    await installWhileTyping(other, otherNode, 'Exports draft');
    otherNode.value = 'Exports';
    field(other, '3').focus();
    expect(otherSaves).toEqual([]);
  });

  it('F5-C10 — several dirty survivors: only the field the person leaves is saved, under its own id; the other draft saves on its own later', async () => {
    const t = setup({ categories: [...CATEGORIES, { id: '11', name: 'Raw', slug: 'raw' }] });
    browser(t);
    enhanceSettingsCategoryDelete(t.document);
    const saves = autosave(t);
    // 3: a refused draft, not focused.
    t.row('3').querySelector('form[data-category-details-form]').setAttribute('data-category-details-state', 'error');
    field(t, '3', 'directorySlug').value = 'Bad Slug!';
    const read = await deletedWithHeldRead(t);
    type(field(t, '11'), 'Raw draft');
    read.resolve(fresh('fresh', [CATEGORIES[0], CATEGORIES[2], { id: '11', name: 'Raw', slug: 'raw' }]));
    await flush();
    expect(saves).toEqual([]);
    expect(['3', '9', '11'].map((id) => t.row(id).querySelectorAll('form[data-category-details-form]').length)).toEqual([1, 1, 1]);
    field(t, '11', 'directorySlug').focus();
    expect(saves).toEqual([['11', 'displayName', 'Raw draft']]);
    expect(field(t, '3', 'directorySlug').value).toBe('Bad Slug!');
    type(field(t, '3', 'directorySlug'), 'final-fixed');
    field(t, '3').focus();
    expect(saves).toEqual([['11', 'displayName', 'Raw draft'], ['3', 'directorySlug', 'final-fixed']]);
  });

  it('F5-C11 / C12 — a save pending while the read installs, then its older answer keeping the field: still one change, raised only when the person leaves', async () => {
    const t = setup();
    browser(t);
    enhanceSettingsCategoryDelete(t.document);
    const saves = autosave(t);
    const details = t.row('9').querySelector('form[data-category-details-form]');
    const node = field(t, '9');
    const read = await deletedWithHeldRead(t);
    // Save A sent (pending); the person comes back and types B.
    details.setAttribute('aria-busy', 'true');
    node.value = 'Exports A';
    type(node, 'Exports A B');
    read.resolve(fresh());
    await flush();
    expect(t.row('9').querySelector('form[data-category-details-form]')).toBe(details);
    expect(saves).toEqual([]);
    // A's answer arrives and keeps the focused field (F4): saved value is A.
    details.removeAttribute('aria-busy');
    node.defaultValue = 'Exports A';
    expect(t.document.activeElement).toBe(node);
    expect(saves).toEqual([]);
    field(t, '9', 'directorySlug').focus();
    expect(saves).toEqual([['9', 'displayName', 'Exports A B']]);
  });

  it('F5-C13 — the raised change still meets the Delete hold: an unresolved Delete of that default refuses it and nothing is saved', async () => {
    const t = setup();
    browser(t);
    enhanceSettingsCategoryDelete(t.document);
    const saves = autosave(t);
    // An unresolved Delete of 9; its read shows 9 still present.
    t.queue.post.push(async () => { throw new TypeError('Failed to fetch'); });
    const read = deferred();
    t.queue.get.push(() => read.promise);
    t.confirmDelete('9');
    await flush();
    const node = field(t, '9');
    type(node, 'Exports held');
    read.resolve(fresh('present', CATEGORIES));
    await flush();
    expect(settingsCategoryDeleteState(t.document, '9').phase).toBe('unresolved');
    expect(saves).toEqual([]);
    field(t, '3').focus();
    expect(saves).toEqual([]);
    expect(t.feedbackText()).toContain(M.changeHeld);
    expect(field(t, '9').value).toBe('Exports held');
    expect(t.posts).toHaveLength(1);
  });

  it('F5-C14 / C15 / C16 — failed read, GET-only Retry, and a superseded read: nothing saved by any of them; the one Tab after still saves once', async () => {
    const t = setup();
    browser(t);
    enhanceSettingsCategoryDelete(t.document);
    const saves = autosave(t);
    t.queue.post.push(async () => jsonResponse(200, deletedBody(CATEGORIES[1])));
    t.queue.get.push(async () => { throw new TypeError('Failed to fetch'); });
    t.confirmDelete('7');
    await flush();
    expect(settingsCategoryDeleteSync(t.document)).toBe('stale');
    const node = field(t, '9');
    type(node, 'Exports draft');
    expect(owed(t)).toBeNull();
    const first = deferred();
    t.queue.get.push(() => first.promise);
    t.feedbackButton('data-settings-category-delete-refresh-retry').click();
    node.focus();
    const second = deferred();
    t.queue.get.push(() => second.promise);
    const done = enhanceSettingsCategoryDelete(t.document).refresh();
    second.resolve(fresh('second'));
    await done;
    first.resolve(fresh('first', CATEGORIES));
    await flush();
    expect(t.page.root.querySelector('[data-settings-category-defaults]').getAttribute('data-version')).toBe('second');
    expect(saves).toEqual([]);
    expect(t.document.activeElement).toBe(node);
    field(t, '3').focus();
    expect(saves).toEqual([['9', 'displayName', 'Exports draft']]);
    expect(t.gets.every((get) => get.method === 'GET')).toBe(true);
    expect(t.posts).toHaveLength(1);
  });

  it('F5-C18 — with moveBefore nothing is owed: the browser\'s own change on Tab saves once, never twice', async () => {
    const t = setup();
    browser(t);
    atomic();
    enhanceSettingsCategoryDelete(t.document);
    const saves = autosave(t);
    const node = field(t, '9');
    await installWhileTyping(t, node, 'Exports atomic');
    expect(field(t, '9')).toBe(node);
    expect(owed(t)).toBeNull();
    expect(node.valueAtFocus).toBe('Exports');
    field(t, '3').focus();
    expect(saves).toEqual([['9', 'displayName', 'Exports atomic']]);
  });

  it('F5-C19 / C20 — two installs during one edit, a window switch, Enter: one change at most; no listener added twice; the Add guard is unchanged', async () => {
    const t = setup();
    browser(t);
    enhanceSettingsCategoryDelete(t.document);
    const listeners = t.page.root.listeners.length;
    enhanceSettingsCategoryDelete(t.document);
    expect(t.page.root.listeners.length).toBe(listeners);
    const saves = autosave(t);
    const node = field(t, '9');
    await installWhileTyping(t, node, 'Exports twice');
    const again = deferred();
    t.queue.get.push(() => again.promise);
    const refreshing = enhanceSettingsCategoryDelete(t.document).refresh();
    again.resolve(fresh('again'));
    await refreshing;
    expect(saves).toEqual([]);
    expect(owed(t)).toBe(node);
    // The window loses focus and comes back: the field kept the page's focus.
    node.dispatch('focusout');
    node.dispatch('focusin');
    expect(owed(t)).toBe(node);
    expect(saves).toEqual([]);
    field(t, '3').focus();
    expect(saves).toEqual([['9', 'displayName', 'Exports twice']]);

    // Enter is the form's own submit: nothing is raised for it afterwards.
    const read = deferred();
    t.queue.get.push(() => read.promise);
    const third = enhanceSettingsCategoryDelete(t.document).refresh();
    type(field(t, '3'), 'Final entered');
    read.resolve(fresh('third'));
    await third;
    expect(owed(t)).toBe(field(t, '3'));
    const submit = field(t, '3').closest('form').dispatch('submit');
    expect(submit.defaultPrevented).toBe(false);
    expect(owed(t)).toBeNull();
    field(t, '9').focus();
    expect(saves).toEqual([['9', 'displayName', 'Exports twice']]);
    // F3: with nothing held, Add stays native.
    expect(t.page.root.querySelector('form[action="/settings/asset-categories"]').dispatch('submit').defaultPrevented).toBe(false);
  });
});

describe('WP11C-F2 — an older Defaults setting answer cannot restore a deleted default', () => {
  const ANSWER = 'creatorcrate:asset-category-preference-answer';
  const region = (t, identity) => t.page.root.querySelector(`[data-settings-asset-category-preference="${identity}"]`);
  const select = (t, identity) => region(t, identity).querySelector('select');
  // What the setting offers: native options and dropdown radios that can be chosen.
  const offered = (t, identity) => select(t, identity).options.filter((option) => !option.disabled).map((option) => option.value);
  const radios = (t, identity) => region(t, identity).querySelectorAll('details[data-cc-dropdown] input').filter((radio) => !radio.disabled).map((radio) => radio.value);
  const status = (t, identity) => region(t, identity).querySelector('[data-settings-fetch-save-status]');
  const version = (t, identity) => region(t, identity).querySelector('[data-region-version]').getAttribute('data-region-version');
  const SURVIVORS = [CATEGORIES[0], CATEGORIES[2]];

  // The preference module's answer, as it dispatches it before installing:
  // `categories` is the list the answer's render shows.
  function answer(t, identity, { categories = CATEGORIES, stored, value = stored, kind = 'saved' } = {}) {
    const parsed = new t.window.DOMParser().parseFromString(JSON.stringify({ version: 'answer', categories, preferences: { [identity]: stored } }));
    const next = parsed.querySelector(`[data-settings-asset-category-preference="${identity}"]`);
    const current = region(t, identity);
    return current.dispatch(ANSWER, {
      detail: { form: current.querySelector('form'), region: current, parsed, next, kind, payload: new URLSearchParams({ [identity]: value }).toString() },
    });
  }

  // The generic save settling before its answer is handed over.
  function settled(t, identity, text = 'Settings saved.', state = 'saved') {
    const form = region(t, identity).querySelector('form');
    form.removeAttribute('aria-busy');
    form.setAttribute('data-settings-fetch-save-state', state);
    status(t, identity).textContent = text;
  }

  // Delete 7 ("sketches") is confirmed while `saving` settings, set to
  // `choice`, are still saving; its read (the list without 7) installs.
  async function deleteWhileSaving(t, { saving = [], choice = 'sketches', read = 'pass' } = {}) {
    t.queue.post.push(async () => jsonResponse(200, deletedBody(CATEGORIES[1])));
    const held = deferred();
    t.queue.get.push(read === 'fail' ? async () => { throw new TypeError('Failed to fetch'); } : () => held.promise);
    t.confirmDelete('7');
    saving.forEach((identity) => {
      select(t, identity).value = choice;
      region(t, identity).querySelector('form').setAttribute('aria-busy', 'true');
      status(t, identity).textContent = 'Saving settings.';
    });
    await flush();
    if (read === 'pass') {
      held.resolve(htmlResponse({ version: 'fresh', categories: SURVIVORS, preferences: { 'browser-default': 'final', 'preview-category': '__disabled__' } }));
      await flush();
    }
    expect(settingsCategoryDeleteState(t.document, '7').phase).toBe('deleted');
  }

  for (const identity of ['browser-default', 'preview-category']) {
    it(`F2-C1 / C2 / C3 / C6 / C10 / C15 / C16 — ${identity}: a saved answer rendered before the Delete is not installed, offers nothing deleted and is not reported as a usable save`, async () => {
      const t = setup({ preferences: { 'browser-default': 'final', 'preview-category': '__disabled__' } });
      enhanceSettingsCategoryDelete(t.document);
      const other = identity === 'browser-default' ? 'preview-category' : 'browser-default';
      const changes = [];
      t.page.root.addEventListener('change', (event) => changes.push(event.target.name), true);
      await deleteWhileSaving(t, { saving: [identity] });
      // The refresh kept the saving setting and installed the other.
      expect(version(t, identity)).toBe('initial');
      expect(version(t, other)).toBe('fresh');
      // While saving, its own value stays selected (the save reads it); the
      // deleted default is offered once at most, as that value.
      expect(select(t, identity).value).toBe('sketches');
      expect(select(t, identity).options.filter((option) => option.value === 'sketches')).toHaveLength(1);
      expect(offered(t, other)).not.toContain('sketches');
      const gets = t.gets.length;

      settled(t, identity);
      const event = answer(t, identity, { stored: 'sketches' });
      expect(event.defaultPrevented).toBe(true);
      expect(version(t, identity)).toBe('initial');
      expect(region(t, identity).getAttribute('data-settings-asset-category-preference-stored')).toBe('sketches');
      expect(offered(t, identity)).not.toContain('sketches');
      expect(radios(t, identity)).not.toContain('sketches');
      // Shown, but no longer a choice, and the status says what is true.
      expect(select(t, identity).value).toBe('sketches');
      expect(status(t, identity).textContent).toBe(M.preferenceSavedUnavailable);
      // The server's own unavailable display comes from a read; nothing is saved.
      await flush();
      expect(t.gets).toHaveLength(gets + 1);
      expect(t.gets.at(-1)).toMatchObject({ url: '/settings/asset-categories', method: 'GET' });
      expect(t.posts).toHaveLength(1);
      expect(changes).toEqual([]);
    });
  }

  it('F2-C4 / C5 / C14 — an older answer for a surviving choice keeps the newer selection and stored value; it stays a true "saved"', async () => {
    const t = setup();
    enhanceSettingsCategoryDelete(t.document);
    await deleteWhileSaving(t, { saving: ['browser-default'], choice: 'exports' });
    settled(t, 'browser-default');
    const gets = t.gets.length;
    expect(answer(t, 'browser-default', { stored: 'exports' }).defaultPrevented).toBe(true);
    expect(select(t, 'browser-default').value).toBe('exports');
    expect(region(t, 'browser-default').getAttribute('data-settings-asset-category-preference-stored')).toBe('exports');
    expect(offered(t, 'browser-default')).toEqual(['all', 'final', 'exports']);
    expect(radios(t, 'browser-default')).toEqual(['all', 'final', 'exports']);
    expect(status(t, 'browser-default').textContent).toBe('Settings saved.');
    expect(t.gets).toHaveLength(gets);
    expect(t.posts).toHaveLength(1);
  });

  it('F2-C7 — an answer rendered after the Delete installs as usual; with no Delete settled, nothing is held back', async () => {
    const t = setup();
    enhanceSettingsCategoryDelete(t.document);
    expect(answer(t, 'preview-category', { stored: 'sketches' }).defaultPrevented).toBe(false);
    await deleteWhileSaving(t, { saving: ['preview-category'], choice: 'final' });
    settled(t, 'preview-category');
    expect(answer(t, 'preview-category', { categories: SURVIVORS, stored: 'final' }).defaultPrevented).toBe(false);
    expect(status(t, 'preview-category').textContent).toBe('Settings saved.');
    expect(t.posts).toHaveLength(1);
  });

  it('F2-C8 — an older refusal is not installed; the draft and its error stay, the deleted default is not offered, nothing is read or sent', async () => {
    const t = setup();
    enhanceSettingsCategoryDelete(t.document);
    await deleteWhileSaving(t, { saving: ['preview-category'] });
    settled(t, 'preview-category', 'Could not save settings. Your current changes were kept.', 'error');
    const gets = t.gets.length;
    expect(answer(t, 'preview-category', { stored: 'disabled', value: 'sketches', kind: 'refused' }).defaultPrevented).toBe(true);
    expect(status(t, 'preview-category').textContent).toBe('Could not save settings. Your current changes were kept.');
    expect(select(t, 'preview-category').value).toBe('sketches');
    expect(offered(t, 'preview-category')).not.toContain('sketches');
    expect(region(t, 'preview-category').getAttribute('data-settings-asset-category-preference-stored')).toBe('disabled');
    expect(t.gets).toHaveLength(gets);
    expect(t.posts).toHaveLength(1);
  });

  it('F2-C11 — failed Delete refresh: the stale answer restores nothing; Retry refresh only reads and installs the current setting', async () => {
    const t = setup();
    enhanceSettingsCategoryDelete(t.document);
    await deleteWhileSaving(t, { saving: ['browser-default'], read: 'fail' });
    expect(settingsCategoryDeleteSync(t.document)).toBe('stale');
    // The row went at once, and with it the other setting's offer of it.
    expect(offered(t, 'preview-category')).not.toContain('sketches');
    settled(t, 'browser-default');
    t.queue.get.push(async () => { throw new TypeError('Failed to fetch'); });
    expect(answer(t, 'browser-default', { stored: 'sketches' }).defaultPrevented).toBe(true);
    await flush();
    expect(offered(t, 'browser-default')).not.toContain('sketches');
    expect(status(t, 'browser-default').textContent).toBe(M.preferenceSavedUnavailable);
    expect(settingsCategoryDeleteSync(t.document)).toBe('stale');
    t.queue.get.push(async () => htmlResponse({ version: 'retried', categories: SURVIVORS, preferences: { 'browser-default': 'sketches', 'preview-category': 'disabled' } }));
    t.feedbackButton('data-settings-category-delete-refresh-retry').click();
    await flush();
    expect(version(t, 'browser-default')).toBe('retried');
    expect(offered(t, 'browser-default')).toEqual(['all', 'final', 'exports']);
    expect(t.gets.every((get) => get.method === 'GET')).toBe(true);
    expect(t.posts).toHaveLength(1);
  });

  it('F2-C12 — a superseded read cannot restore the deleted default to a kept setting', async () => {
    const t = setup();
    enhanceSettingsCategoryDelete(t.document);
    await deleteWhileSaving(t, { saving: ['preview-category'], choice: 'final', read: 'fail' });
    const first = deferred();
    t.queue.get.push(() => first.promise);
    const controller = enhanceSettingsCategoryDelete(t.document);
    controller.refresh();
    t.queue.get.push(async () => htmlResponse({ version: 'second', categories: SURVIVORS, preferences: {} }));
    await controller.refresh();
    first.resolve(htmlResponse({ version: 'older', categories: CATEGORIES, preferences: { 'preview-category': 'sketches' } }));
    await flush();
    expect(t.page.root.querySelector('[data-settings-category-defaults]').getAttribute('data-version')).toBe('second');
    expect(offered(t, 'preview-category')).not.toContain('sketches');
    expect(t.row('7')).toBeNull();
    expect(t.posts).toHaveLength(1);
  });

  it('F2-C13 — the two settings stay independent: one answer never settles or changes the other', async () => {
    const t = setup();
    enhanceSettingsCategoryDelete(t.document);
    await deleteWhileSaving(t, { saving: ['browser-default', 'preview-category'], choice: 'exports' });
    settled(t, 'preview-category');
    expect(answer(t, 'preview-category', { stored: 'exports' }).defaultPrevented).toBe(true);
    expect(status(t, 'preview-category').textContent).toBe('Settings saved.');
    expect(region(t, 'browser-default').querySelector('form').getAttribute('aria-busy')).toBe('true');
    expect(status(t, 'browser-default').textContent).toBe('Saving settings.');
    expect(select(t, 'browser-default').value).toBe('exports');
    expect(region(t, 'browser-default').getAttribute('data-settings-asset-category-preference-stored')).toBe('final');
  });

  it('F2-C17 / C18 / C19 / C20 — binding again adds no second listener; drafts survive; nothing is saved; Add stays native once settled', async () => {
    const t = setup();
    enhanceSettingsCategoryDelete(t.document);
    enhanceSettingsCategoryDelete(t.document);
    const changes = [];
    t.page.root.addEventListener('change', (event) => changes.push(event.target.name), true);
    await deleteWhileSaving(t, { saving: ['browser-default'] });
    t.row('9').querySelector('input[name="displayName"]').value = 'Exports draft';
    settled(t, 'browser-default');
    const gets = t.gets.length;
    const read = deferred();
    t.queue.get.push(() => read.promise);
    answer(t, 'browser-default', { stored: 'sketches' });
    await flush();
    expect(t.gets).toHaveLength(gets + 1);
    read.resolve(htmlResponse({ version: 'after', categories: SURVIVORS, preferences: { 'browser-default': 'sketches', 'preview-category': 'disabled' } }));
    await flush();
    expect(t.row('9').querySelector('input[name="displayName"]').value).toBe('Exports draft');
    expect(version(t, 'browser-default')).toBe('after');
    expect(changes).toEqual([]);
    expect(t.posts).toHaveLength(1);
    // F3: nothing is held, so the native Add form is not stopped.
    expect(t.page.root.querySelector('form[action="/settings/asset-categories"]').dispatch('submit').defaultPrevented).toBe(false);
  });
});

describe('WP11C-F6 — a default deleted elsewhere, observed by an installed list read', () => {
  const ANSWER = 'creatorcrate:asset-category-preference-answer';
  const region = (t, identity) => t.page.root.querySelector(`[data-settings-asset-category-preference="${identity}"]`);
  const select = (t, identity) => region(t, identity).querySelector('select');
  const option = (t, identity, value) => select(t, identity).options.find((candidate) => candidate.value === value) || null;
  const offered = (t, identity) => select(t, identity).options.filter((candidate) => !candidate.disabled).map((candidate) => candidate.value);
  const radios = (t, identity) => region(t, identity).querySelectorAll('details[data-cc-dropdown] input').filter((radio) => !radio.disabled).map((radio) => radio.value);
  const status = (t, identity) => region(t, identity).querySelector('[data-settings-fetch-save-status]');
  const version = (t, identity) => region(t, identity).querySelector('[data-region-version]').getAttribute('data-region-version');
  const stored = (t, identity) => region(t, identity).getAttribute('data-settings-asset-category-preference-stored');
  const BOTH = ['browser-default', 'preview-category'];
  // Default 7 ("sketches") is deleted elsewhere; this page deletes 9
  // ("exports") itself, which is the read that observes 7 gone.
  const CURRENT = [CATEGORIES[0]];
  const PREFS = { 'browser-default': 'sketches', 'preview-category': 'sketches' };

  // The preference module's answer, as dispatched before it installs.
  function answer(t, identity, { categories = [CATEGORIES[0], CATEGORIES[1]], stored: value, kind = 'saved' } = {}) {
    const parsed = new t.window.DOMParser().parseFromString(JSON.stringify({ version: 'answer', categories, preferences: { [identity]: value } }));
    const next = parsed.querySelector(`[data-settings-asset-category-preference="${identity}"]`);
    const current = region(t, identity);
    return current.dispatch(ANSWER, {
      detail: { form: current.querySelector('form'), region: current, parsed, next, kind, payload: new URLSearchParams({ [identity]: value }).toString() },
    });
  }

  // A save of `value` that finished with "Settings saved." after the read
  // began: the person's change is what the read keeps as shown.
  function savedAfterReadBegan(t, identity, value = 'sketches') {
    select(t, identity).value = value;
    select(t, identity).dispatch('change');
    const form = region(t, identity).querySelector('form');
    form.removeAttribute('aria-busy');
    form.setAttribute('data-settings-fetch-save-state', 'saved');
    region(t, identity).setAttribute('data-settings-asset-category-preference-stored', value);
    status(t, identity).textContent = 'Settings saved.';
  }

  function savingAfterReadBegan(t, identity, value = 'sketches') {
    select(t, identity).value = value;
    select(t, identity).dispatch('change');
    region(t, identity).querySelector('form').setAttribute('aria-busy', 'true');
    region(t, identity).querySelector('form').setAttribute('data-settings-fetch-save-state', 'pending');
    status(t, identity).textContent = 'Saving settings.';
  }

  function settle(t, identity, text = 'Settings saved.', state = 'saved') {
    const form = region(t, identity).querySelector('form');
    form.removeAttribute('aria-busy');
    form.setAttribute('data-settings-fetch-save-state', state);
    status(t, identity).textContent = text;
  }

  // This page's own Delete of 9 is confirmed; its read is returned, held.
  async function readByDelete9(t) {
    t.queue.post.push(async () => jsonResponse(200, deletedBody(CATEGORIES[2])));
    const held = deferred();
    t.queue.get.push(() => held.promise);
    t.confirmDelete('9');
    await flush();
    expect(settingsCategoryDeleteState(t.document, '9').phase).toBe('deleted');
    return held;
  }

  async function install(held, categories = CURRENT, version = 'fresh', preferences = PREFS) {
    held.resolve(htmlResponse({ version, categories, preferences }));
    await flush();
  }

  function track(t) {
    const changes = [];
    const reached = [];
    t.page.root.addEventListener('change', (event) => changes.push(event.target.name), true);
    BOTH.forEach((identity) => region(t, identity).addEventListener('change', (event) => reached.push(event.target.name)));
    return { changes, reached };
  }

  for (const identity of BOTH) {
    it(`F6-C1 / C2 / C3 / C4 / C5 / C6 / C17 — ${identity}: the installed read stops offering the default gone elsewhere, with no Delete record; stored slug kept; "Settings saved." corrected; nothing saved`, async () => {
      const t = setup({ preferences: { 'browser-default': 'final', 'preview-category': '__disabled__' } });
      enhanceSettingsCategoryDelete(t.document);
      const other = identity === 'browser-default' ? 'preview-category' : 'browser-default';
      const held = await readByDelete9(t);
      savedAfterReadBegan(t, identity);
      const { changes } = track(t);
      await install(held);
      // C4: nothing about 7 is a Delete of this page.
      expect(settingsCategoryDeleteState(t.document, '7')).toBeNull();
      expect(t.row('7')).toBeNull();
      // Kept as shown (changed after the read began); the other installed.
      expect(version(t, identity)).toBe('initial');
      expect(version(t, other)).toBe('fresh');
      // C2 / C3: no longer a choice anywhere; shown as the stored value only.
      expect(offered(t, identity)).not.toContain('sketches');
      expect(radios(t, identity)).not.toContain('sketches');
      expect(offered(t, other)).not.toContain('sketches');
      expect(select(t, identity).value).toBe('sketches');
      expect(offered(t, identity)).toContain('final');
      // C5 / C6: the stored slug is what was saved; the status says it is unavailable.
      expect(stored(t, identity)).toBe('sketches');
      expect(status(t, identity).textContent).toBe(M.preferenceSavedUnavailable);
      // Observed, never attributed.
      expect(t.feedbackText()).not.toContain('Sketches');
      expect(t.feedbackText()).toContain(M.upToDate);
      // C17: reads only; no change raised; one Delete POST (9).
      expect(changes).toEqual([]);
      expect(t.posts).toHaveLength(1);
      expect(t.gets.every((get) => get.method === 'GET')).toBe(true);
      expect(t.gets).toHaveLength(1);
    });
  }

  it('F6-C7 / C8 / C10 — a saving setting keeps its in-flight value submittable; its older answer cannot restore the default; GET only', async () => {
    const t = setup({ preferences: { 'browser-default': 'final', 'preview-category': '__disabled__' } });
    enhanceSettingsCategoryDelete(t.document);
    const held = await readByDelete9(t);
    savingAfterReadBegan(t, 'browser-default');
    await install(held);
    // C8: still the save's value, not disabled (a disabled selected option
    // would drop out of the form's payload), offered once at most.
    expect(select(t, 'browser-default').value).toBe('sketches');
    expect(option(t, 'browser-default', 'sketches').disabled).toBe(false);
    expect(select(t, 'browser-default').options.filter((candidate) => candidate.value === 'sketches')).toHaveLength(1);
    expect(status(t, 'browser-default').textContent).toBe('Saving settings.');
    const gets = t.gets.length;
    // C10: its answer, rendered before the other tab's Delete, still lists 7.
    settle(t, 'browser-default');
    const event = answer(t, 'browser-default', { stored: 'sketches' });
    expect(event.defaultPrevented).toBe(true);
    expect(version(t, 'browser-default')).toBe('initial');
    expect(offered(t, 'browser-default')).not.toContain('sketches');
    expect(radios(t, 'browser-default')).not.toContain('sketches');
    expect(stored(t, 'browser-default')).toBe('sketches');
    expect(status(t, 'browser-default').textContent).toBe(M.preferenceSavedUnavailable);
    await flush();
    expect(t.gets).toHaveLength(gets + 1);
    expect(t.gets.at(-1)).toMatchObject({ url: '/settings/asset-categories', method: 'GET' });
    expect(t.posts).toHaveLength(1);
  });

  it('F6-C9 — the two settings stay independent: one saving, one saved; one answer never settles the other', async () => {
    const t = setup({ preferences: { 'browser-default': 'final', 'preview-category': '__disabled__' } });
    enhanceSettingsCategoryDelete(t.document);
    const held = await readByDelete9(t);
    savingAfterReadBegan(t, 'browser-default');
    savedAfterReadBegan(t, 'preview-category');
    await install(held);
    expect(status(t, 'browser-default').textContent).toBe('Saving settings.');
    expect(status(t, 'preview-category').textContent).toBe(M.preferenceSavedUnavailable);
    expect(offered(t, 'preview-category')).not.toContain('sketches');
    settle(t, 'browser-default');
    expect(answer(t, 'browser-default', { stored: 'sketches' }).defaultPrevented).toBe(true);
    expect(status(t, 'preview-category').textContent).toBe(M.preferenceSavedUnavailable);
    expect(stored(t, 'preview-category')).toBe('sketches');
    expect(version(t, 'preview-category')).toBe('initial');
    // A newer answer for preview (rendered after: no 7) installs as usual.
    expect(answer(t, 'preview-category', { categories: CURRENT, stored: 'final' }).defaultPrevented).toBe(false);
    expect(t.posts).toHaveLength(1);
  });

  it('F6-C11 — a refusal rendered after the Delete elsewhere (the save ran later: 422) installs as the server shows it', async () => {
    const t = setup({ preferences: { 'browser-default': 'final', 'preview-category': '__disabled__' } });
    enhanceSettingsCategoryDelete(t.document);
    const held = await readByDelete9(t);
    savingAfterReadBegan(t, 'preview-category');
    await install(held);
    settle(t, 'preview-category', 'Could not save settings. Your current changes were kept.', 'error');
    const gets = t.gets.length;
    expect(answer(t, 'preview-category', { categories: CURRENT, stored: '__disabled__', kind: 'refused' }).defaultPrevented).toBe(false);
    expect(status(t, 'preview-category').textContent).toBe('Could not save settings. Your current changes were kept.');
    expect(t.gets).toHaveLength(gets);
    expect(t.posts).toHaveLength(1);
  });

  it('F6-C12 / C13 — a failed read observes nothing; GET-only Retry refresh installs the current defaults and applies them', async () => {
    const t = setup({ preferences: { 'browser-default': 'final', 'preview-category': '__disabled__' } });
    enhanceSettingsCategoryDelete(t.document);
    t.queue.post.push(async () => jsonResponse(200, deletedBody(CATEGORIES[2])));
    t.queue.get.push(async () => { throw new TypeError('Failed to fetch'); });
    t.confirmDelete('9');
    await flush();
    expect(settingsCategoryDeleteSync(t.document)).toBe('stale');
    // C12: nothing learned about 7: still offered; an answer listing it installs.
    expect(offered(t, 'browser-default')).toContain('sketches');
    expect(answer(t, 'browser-default', { stored: 'final' }).defaultPrevented).toBe(false);
    // C13: Retry refresh, with the setting saved after it began.
    const held = deferred();
    t.queue.get.push(() => held.promise);
    t.feedbackButton('data-settings-category-delete-refresh-retry').click();
    savedAfterReadBegan(t, 'browser-default');
    await install(held);
    expect(settingsCategoryDeleteSync(t.document)).toBe('idle');
    expect(offered(t, 'browser-default')).not.toContain('sketches');
    expect(offered(t, 'preview-category')).not.toContain('sketches');
    expect(status(t, 'browser-default').textContent).toBe(M.preferenceSavedUnavailable);
    expect(t.gets).toHaveLength(2);
    expect(t.gets.every((get) => get.method === 'GET')).toBe(true);
    expect(t.posts).toHaveLength(1);
  });

  it('F6-C14 — a superseded older read listing the default cannot restore it, and does not undo the observation', async () => {
    const t = setup({ preferences: { 'browser-default': 'final', 'preview-category': '__disabled__' } });
    enhanceSettingsCategoryDelete(t.document);
    t.queue.post.push(async () => jsonResponse(200, deletedBody(CATEGORIES[2])));
    t.queue.get.push(async () => { throw new TypeError('Failed to fetch'); });
    t.confirmDelete('9');
    await flush();
    const controller = enhanceSettingsCategoryDelete(t.document);
    const older = deferred();
    t.queue.get.push(() => older.promise);
    controller.refresh();
    const newer = deferred();
    t.queue.get.push(() => newer.promise);
    const done = controller.refresh();
    savedAfterReadBegan(t, 'preview-category');
    await install(newer, CURRENT, 'newer');
    await done;
    older.resolve(htmlResponse({ version: 'older', categories: [CATEGORIES[0], CATEGORIES[1]], preferences: PREFS }));
    await flush();
    expect(t.page.root.querySelector('[data-settings-category-defaults]').getAttribute('data-version')).toBe('newer');
    expect(t.row('7')).toBeNull();
    expect(offered(t, 'preview-category')).not.toContain('sketches');
    expect(radios(t, 'preview-category')).not.toContain('sketches');
    // Still known gone: an answer still listing 7 is older and not installed.
    settle(t, 'preview-category');
    expect(answer(t, 'preview-category', { stored: 'final' }).defaultPrevented).toBe(true);
    expect(t.posts).toHaveLength(1);
  });

  it('F6-C15 — a new default (new id) with the deleted slug: the slug stays a choice under the current name; the old id stays gone', async () => {
    const t = setup({ preferences: { 'browser-default': 'final', 'preview-category': '__disabled__' } });
    enhanceSettingsCategoryDelete(t.document);
    // First the read shows 7 gone: the saved choice is withdrawn.
    const first = await readByDelete9(t);
    savedAfterReadBegan(t, 'browser-default');
    await install(first);
    expect(offered(t, 'browser-default')).not.toContain('sketches');
    expect(status(t, 'browser-default').textContent).toBe(M.preferenceSavedUnavailable);
    // Then a read lists default 12 with the same slug; the setting is still
    // kept as shown (changed again after that read began, back to the slug).
    const controller = enhanceSettingsCategoryDelete(t.document);
    const second = deferred();
    t.queue.get.push(() => second.promise);
    const done = controller.refresh();
    region(t, 'browser-default').querySelector('form').setAttribute('data-settings-fetch-save-state', 'error');
    select(t, 'browser-default').dispatch('change');
    const reborn = { id: '12', name: 'Reborn', slug: 'sketches' };
    await install(second, [CATEGORIES[0], reborn], 'reborn');
    await done;
    expect(t.row('12')).not.toBeNull();
    expect(t.row('7')).toBeNull();
    expect(offered(t, 'browser-default')).toContain('sketches');
    expect(radios(t, 'browser-default')).toContain('sketches');
    expect(option(t, 'browser-default', 'sketches').hasAttribute('data-settings-category-withdrawn')).toBe(false);
    // The other setting was replaced by the read: the server's own options.
    expect(offered(t, 'preview-category')).toContain('sketches');
    // An answer listing old id 7 is still older than the observation, but
    // its saved slug is current again, so the status stays a true save.
    settle(t, 'browser-default');
    const gets = t.gets.length;
    expect(answer(t, 'browser-default', { stored: 'sketches' }).defaultPrevented).toBe(true);
    expect(status(t, 'browser-default').textContent).toBe('Settings saved.');
    expect(offered(t, 'browser-default')).toContain('sketches');
    expect(t.gets).toHaveLength(gets);
    expect(t.posts).toHaveLength(1);
  });

  it('F6-C15b — a kept option still named after the gone default is named after the current default with its slug', async () => {
    const t = setup({ preferences: { 'browser-default': 'final', 'preview-category': '__disabled__' } });
    enhanceSettingsCategoryDelete(t.document);
    const held = await readByDelete9(t);
    savedAfterReadBegan(t, 'browser-default', 'final');
    await install(held, [CATEGORIES[0], { id: '12', name: 'Reborn', slug: 'sketches' }]);
    expect(option(t, 'browser-default', 'sketches').textContent).toBe('Reborn');
    expect(offered(t, 'browser-default')).toEqual(['all', 'final', 'sketches']);
    expect(status(t, 'browser-default').textContent).toBe('Settings saved.');
  });

  it('F6-C16 / C18 — after reconciling, a valid choice reaches its own save once; binding again adds no listener', async () => {
    const t = setup({ preferences: { 'browser-default': 'final', 'preview-category': '__disabled__' } });
    enhanceSettingsCategoryDelete(t.document);
    enhanceSettingsCategoryDelete(t.document);
    const held = await readByDelete9(t);
    savedAfterReadBegan(t, 'browser-default');
    const { changes, reached } = track(t);
    await install(held);
    expect(changes).toEqual([]);
    select(t, 'browser-default').value = 'final';
    select(t, 'browser-default').dispatch('change');
    expect(changes).toEqual(['browser-default']);
    expect(reached).toEqual(['browser-default']);
    settle(t, 'browser-default');
    const gets = t.gets.length;
    // One listener: an older answer veto reads once, not twice.
    expect(answer(t, 'browser-default', { stored: 'sketches' }).defaultPrevented).toBe(true);
    await flush();
    expect(t.gets).toHaveLength(gets + 1);
    expect(t.posts).toHaveLength(1);
  });

  it('F6-C19 — F1/F4: a dirty name on a survivor survives the observing install unsaved', async () => {
    const t = setup({ preferences: { 'browser-default': 'final', 'preview-category': '__disabled__' } });
    enhanceSettingsCategoryDelete(t.document);
    const held = await readByDelete9(t);
    const name = t.row('3').querySelector('input[name="displayName"]');
    name.focus();
    name.value = 'Final draft';
    name.dispatch('input');
    savedAfterReadBegan(t, 'browser-default');
    const { changes } = track(t);
    await install(held);
    const after = t.row('3').querySelector('input[name="displayName"]');
    expect(after.value).toBe('Final draft');
    expect(after.defaultValue).toBe('Final');
    expect(changes).toEqual([]);
    expect(offered(t, 'browser-default')).not.toContain('sketches');
    expect(t.posts).toHaveLength(1);
  });

  it('F6-C20 — F3: an unresolved Delete stays held through the observing install; Add stays refused; nothing is sent', async () => {
    const t = setup({ preferences: { 'browser-default': 'final', 'preview-category': '__disabled__' } });
    enhanceSettingsCategoryDelete(t.document);
    // Delete 3: its answer is lost; the automatic check shows 3 present.
    t.queue.post.push(async () => { throw new TypeError('Failed to fetch'); });
    t.queue.get.push(async () => htmlResponse({ version: 'check', categories: CATEGORIES, preferences: PREFS }));
    t.confirmDelete('3');
    await flush();
    expect(settingsCategoryDeleteState(t.document, '3').phase).toBe('unresolved');
    const held = await readByDelete9(t);
    savedAfterReadBegan(t, 'browser-default');
    await install(held, [CATEGORIES[0]]);
    expect(settingsCategoryDeleteState(t.document, '3').phase).toBe('unresolved');
    expect(t.row('3').getAttribute('data-settings-category-delete-hold')).toBe('unresolved');
    expect(settingsCategoryDeleteState(t.document, '7')).toBeNull();
    expect(offered(t, 'browser-default')).not.toContain('sketches');
    expect(t.page.root.querySelector('form[action="/settings/asset-categories"]').dispatch('submit').defaultPrevented).toBe(true);
    expect(t.feedbackText()).toContain(M.addHeld);
    expect(t.posts).toHaveLength(2);
    expect(t.gets.every((get) => get.method === 'GET')).toBe(true);
  });
});

describe('WP11C-F8 — a default renamed here and deleted elsewhere, observed by an installed list read', () => {
  const ANSWER = 'creatorcrate:asset-category-preference-answer';
  const region = (t, identity) => t.page.root.querySelector(`[data-settings-asset-category-preference="${identity}"]`);
  const select = (t, identity) => region(t, identity).querySelector('select');
  const option = (t, identity, value) => select(t, identity).options.find((candidate) => candidate.value === value) || null;
  const offered = (t, identity) => select(t, identity).options.filter((candidate) => !candidate.disabled).map((candidate) => candidate.value);
  const radios = (t, identity) => region(t, identity).querySelectorAll('details[data-cc-dropdown] input').filter((radio) => !radio.disabled).map((radio) => radio.value);
  const status = (t, identity) => region(t, identity).querySelector('[data-settings-fetch-save-status]');
  const stored = (t, identity) => region(t, identity).getAttribute('data-settings-asset-category-preference-stored');
  const BOTH = ['browser-default', 'preview-category'];
  const PREFS = { 'browser-default': 'final', 'preview-category': '__disabled__' };
  const SKETCHES = CATEGORIES[1];
  const renamedSketches = (slug, name = SKETCHES.name) => ({ ...SKETCHES, slug, name });

  const details = (t, id) => t.row(id).querySelector('form[data-category-details-form]');
  const field = (t, id, name) => details(t, id).querySelector(`input[name="${name}"]`);
  const reviewedField = (t, id, name) => details(t, id).querySelector(`input[data-category-details-reviewed="${name}"]`);

  // What category-details.js leaves after an acknowledged save: the server's
  // render of the form, the saved values as defaults and reviewed fields.
  function confirmedSave(t, id, { name, slug }) {
    if (name !== undefined) {
      field(t, id, 'displayName').value = name;
      field(t, id, 'displayName').defaultValue = name;
      reviewedField(t, id, 'displayName').value = name;
    }
    if (slug !== undefined) {
      field(t, id, 'directorySlug').value = slug;
      field(t, id, 'directorySlug').defaultValue = slug;
      reviewedField(t, id, 'directorySlug').value = slug;
    }
    details(t, id).setAttribute('data-category-details-state', 'saved');
  }

  // A validation refusal (422): the server renders the refused draft as the
  // fields' values (so their defaults too), reviewed fields from the row.
  function refusedSave(t, id, slug) {
    field(t, id, 'directorySlug').value = slug;
    field(t, id, 'directorySlug').defaultValue = slug;
    details(t, id).setAttribute('data-category-details-state', 'error');
  }

  // A stale refusal (409): the draft stays shown; defaults and reviewed
  // fields are what the server says is saved now.
  function staleSave(t, id, { saved, draft }) {
    field(t, id, 'directorySlug').value = draft;
    field(t, id, 'directorySlug').defaultValue = saved;
    reviewedField(t, id, 'directorySlug').value = saved;
    details(t, id).setAttribute('data-category-details-state', 'stale');
  }

  // The setting re-rendered by the server (an answer after the rename): it
  // offers the renamed slug in place of the old one.
  function offer(t, identity, slug, name, replacing = SKETCHES.slug) {
    const current = option(t, identity, replacing);
    const radio = region(t, identity).querySelectorAll('details[data-cc-dropdown] input').find((candidate) => candidate.value === replacing);
    if (current) { current.value = slug; current.setAttribute('value', slug); current.ownText = name; }
    if (radio) { radio.value = slug; radio.setAttribute('value', slug); }
  }

  function answer(t, identity, { categories, stored: value, kind = 'saved' }) {
    const parsed = new t.window.DOMParser().parseFromString(JSON.stringify({ version: 'answer', categories, preferences: { [identity]: value } }));
    const next = parsed.querySelector(`[data-settings-asset-category-preference="${identity}"]`);
    const current = region(t, identity);
    return current.dispatch(ANSWER, {
      detail: { form: current.querySelector('form'), region: current, parsed, next, kind, payload: new URLSearchParams({ [identity]: value }).toString() },
    });
  }

  function savedAfterReadBegan(t, identity, value) {
    select(t, identity).value = value;
    select(t, identity).dispatch('change');
    const form = region(t, identity).querySelector('form');
    form.removeAttribute('aria-busy');
    form.setAttribute('data-settings-fetch-save-state', 'saved');
    region(t, identity).setAttribute('data-settings-asset-category-preference-stored', value);
    status(t, identity).textContent = 'Settings saved.';
  }

  function savingAfterReadBegan(t, identity, value) {
    select(t, identity).value = value;
    select(t, identity).dispatch('change');
    region(t, identity).querySelector('form').setAttribute('aria-busy', 'true');
    region(t, identity).querySelector('form').setAttribute('data-settings-fetch-save-state', 'pending');
    status(t, identity).textContent = 'Saving settings.';
  }

  function settle(t, identity, text = 'Settings saved.', state = 'saved') {
    const form = region(t, identity).querySelector('form');
    form.removeAttribute('aria-busy');
    form.setAttribute('data-settings-fetch-save-state', state);
    status(t, identity).textContent = text;
  }

  async function readByDelete9(t) {
    t.queue.post.push(async () => jsonResponse(200, deletedBody(CATEGORIES[2])));
    const held = deferred();
    t.queue.get.push(() => held.promise);
    t.confirmDelete('9');
    await flush();
    expect(settingsCategoryDeleteState(t.document, '9').phase).toBe('deleted');
    return held;
  }

  async function install(held, categories = [CATEGORIES[0]], version = 'fresh', preferences = PREFS) {
    held.resolve(htmlResponse({ version, categories, preferences }));
    await flush();
  }

  function track(t) {
    const changes = [];
    t.page.root.addEventListener('change', (event) => changes.push(event.target.name), true);
    return changes;
  }

  for (const identity of BOTH) {
    it(`F8-C1 / C4 / C5 / C6 / C7 / C18 — ${identity}: a confirmed rename is the identity; deleted elsewhere, the installed read withdraws the renamed slug; stored kept; "Settings saved." corrected; nothing saved`, async () => {
      const t = setup({ preferences: PREFS });
      enhanceSettingsCategoryDelete(t.document);
      const changes = track(t);
      confirmedSave(t, '7', { slug: 'sketches-v2' });
      BOTH.forEach((each) => offer(t, each, 'sketches-v2', 'Sketches'));
      const held = await readByDelete9(t);
      savedAfterReadBegan(t, identity, 'sketches-v2');
      changes.length = 0;
      await install(held);
      // C4: observed gone, never this page's Delete.
      expect(settingsCategoryDeleteState(t.document, '7')).toBeNull();
      expect(t.row('7')).toBeNull();
      // C5 / C6: neither setting offers it any more, under either slug.
      BOTH.forEach((each) => {
        expect(offered(t, each)).not.toContain('sketches-v2');
        expect(radios(t, each)).not.toContain('sketches-v2');
        expect(offered(t, each)).not.toContain('sketches');
        expect(offered(t, each)).toContain('final');
      });
      expect(select(t, identity).value).toBe('sketches-v2');
      expect(option(t, identity, 'sketches-v2').disabled).toBe(true);
      // C7: truthful status; stored slug kept.
      expect(stored(t, identity)).toBe('sketches-v2');
      expect(status(t, identity).textContent).toBe(M.preferenceSavedUnavailable);
      expect(t.feedbackText()).not.toContain('Sketches');
      // C18: no change raised by the reconciliation; one POST (9's Delete); GET only.
      expect(changes).toEqual([]);
      expect(t.posts).toHaveLength(1);
      expect(t.gets).toHaveLength(1);
      expect(t.gets.every((get) => get.method === 'GET')).toBe(true);
    });
  }

  it('F8-C2 / C11 — a refused draft (422, a case-only or duplicate slug) never becomes the identity; the confirmed slug is withdrawn; a survivor\'s refused draft is kept', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    confirmedSave(t, '7', { slug: 'sketches-v2' });
    // Then a refused case-only slug: the reviewed field keeps the saved slug.
    refusedSave(t, '7', 'SKETCHES-V2');
    expect(reviewedField(t, '7', 'directorySlug').value).toBe('sketches-v2');
    // A survivor's refused duplicate draft.
    refusedSave(t, '3', 'sketches-v2');
    offer(t, 'browser-default', 'sketches-v2', 'Sketches');
    const held = await readByDelete9(t);
    savedAfterReadBegan(t, 'browser-default', 'sketches-v2');
    await install(held);
    expect(offered(t, 'browser-default')).not.toContain('sketches-v2');
    expect(offered(t, 'browser-default')).toContain('final');
    expect(status(t, 'browser-default').textContent).toBe(M.preferenceSavedUnavailable);
    // The survivor (kept: refused) still shows its draft, unsaved.
    expect(field(t, '3', 'directorySlug').value).toBe('sketches-v2');
    expect(details(t, '3').getAttribute('data-category-details-state')).toBe('error');
    expect(t.posts).toHaveLength(1);
  });

  it('F8-C3 — a stale refusal (409): the slug saved elsewhere is the identity, never the proposed draft', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    staleSave(t, '7', { saved: 'sketches-elsewhere', draft: 'sketches-proposed' });
    offer(t, 'preview-category', 'sketches-elsewhere', 'Sketches');
    const held = await readByDelete9(t);
    savedAfterReadBegan(t, 'preview-category', 'sketches-elsewhere');
    await install(held);
    expect(offered(t, 'preview-category')).not.toContain('sketches-elsewhere');
    expect(status(t, 'preview-category').textContent).toBe(M.preferenceSavedUnavailable);
    // An answer offering the proposed slug cannot be about 7: 7 is never
    // listed with it, so a current default that has it stays a choice.
    const controller = enhanceSettingsCategoryDelete(t.document);
    const next = deferred();
    t.queue.get.push(() => next.promise);
    const done = controller.refresh();
    region(t, 'preview-category').querySelector('form').setAttribute('data-settings-fetch-save-state', 'error');
    select(t, 'preview-category').dispatch('change');
    await install(next, [CATEGORIES[0], { id: '14', name: 'Proposed', slug: 'sketches-proposed' }], 'later');
    await done;
    expect(t.row('14')).not.toBeNull();
    expect(offered(t, 'browser-default')).toContain('sketches-proposed');
    expect(t.posts).toHaveLength(1);
  });

  for (const identity of BOTH) {
    it(`F8-C8 — ${identity}: an older answer for the renamed slug, delivered after the observation, cannot restore it or say it is usable`, async () => {
      const t = setup({ preferences: PREFS });
      enhanceSettingsCategoryDelete(t.document);
      confirmedSave(t, '7', { slug: 'sketches-v2' });
      offer(t, identity, 'sketches-v2', 'Sketches');
      const held = await readByDelete9(t);
      savingAfterReadBegan(t, identity, 'sketches-v2');
      await install(held);
      // Saving: its in-flight value stays submittable.
      expect(option(t, identity, 'sketches-v2').disabled).toBe(false);
      settle(t, identity, 'Saving settings.', 'pending');
      const gets = t.gets.length;
      const event = answer(t, identity, { categories: [CATEGORIES[0], renamedSketches('sketches-v2')], stored: 'sketches-v2' });
      expect(event.defaultPrevented).toBe(true);
      await flush();
      expect(offered(t, identity)).not.toContain('sketches-v2');
      expect(status(t, identity).textContent).toBe(M.preferenceSavedUnavailable);
      expect(stored(t, identity)).toBe('sketches-v2');
      // GET only, for the server's own unavailable display; no POST.
      expect(t.gets).toHaveLength(gets + 1);
      expect(t.gets.every((get) => get.method === 'GET')).toBe(true);
      expect(t.posts).toHaveLength(1);
    });
  }

  it('F8-C8b — the rename\'s own answer never reached this page: a preference answer rendered after it teaches the renamed slug', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    // 7 was renamed (its details answer lost: the form still shows sketches);
    // a setting's answer rendered after that lists 7 as sketches-v2.
    expect(answer(t, 'browser-default', { categories: [CATEGORIES[0], renamedSketches('sketches-v2'), CATEGORIES[2]], stored: 'final' }).defaultPrevented).toBe(false);
    offer(t, 'browser-default', 'sketches-v2', 'Sketches');
    const held = await readByDelete9(t);
    savedAfterReadBegan(t, 'browser-default', 'sketches-v2');
    await install(held);
    expect(offered(t, 'browser-default')).not.toContain('sketches-v2');
    expect(status(t, 'browser-default').textContent).toBe(M.preferenceSavedUnavailable);
    expect(t.posts).toHaveLength(1);
  });

  it('F8-C9 — several confirmed renames: the latest slug is withdrawn, and an older answer offering an earlier slug cannot restore it', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    ['alpha', 'beta', 'gamma'].forEach((slug) => confirmedSave(t, '7', { slug }));
    offer(t, 'browser-default', 'gamma', 'Sketches');
    const held = await readByDelete9(t);
    savedAfterReadBegan(t, 'browser-default', 'gamma');
    await install(held);
    expect(offered(t, 'browser-default')).not.toContain('gamma');
    expect(status(t, 'browser-default').textContent).toBe(M.preferenceSavedUnavailable);
    // An answer rendered while 7 was "beta" (held all this time).
    settle(t, 'browser-default', 'Saving settings.', 'pending');
    const event = answer(t, 'browser-default', { categories: [CATEGORIES[0], renamedSketches('beta')], stored: 'final' });
    expect(event.defaultPrevented).toBe(true);
    expect(offered(t, 'browser-default')).not.toContain('beta');
    expect(offered(t, 'browser-default')).not.toContain('gamma');
    expect(offered(t, 'browser-default')).toContain('final');
    expect(t.posts).toHaveLength(1);
  });

  it('F8-C10 — a name-only save keeps the slug identity: the slug is withdrawn, labels follow the saved name', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    confirmedSave(t, '7', { name: 'Sketches renamed' });
    const held = await readByDelete9(t);
    savedAfterReadBegan(t, 'browser-default', 'sketches');
    await install(held, [CATEGORIES[0]]);
    expect(offered(t, 'browser-default')).not.toContain('sketches');
    expect(status(t, 'browser-default').textContent).toBe(M.preferenceSavedUnavailable);
    expect(offered(t, 'browser-default')).toContain('final');
    expect(t.posts).toHaveLength(1);
  });

  it('F8-C12 — an unsent draft or a save in flight is not the identity: the saved slug is withdrawn, the draft is not', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    // 7's slug is being edited (unsent), and 3's rename is in flight.
    field(t, '7', 'directorySlug').value = 'sketches-draft';
    details(t, '3').setAttribute('aria-busy', 'true');
    field(t, '3', 'directorySlug').value = 'final-v2';
    const held = await readByDelete9(t);
    savedAfterReadBegan(t, 'browser-default', 'sketches');
    const changes = track(t);
    await install(held);
    expect(offered(t, 'browser-default')).not.toContain('sketches');
    expect(offered(t, 'browser-default')).toContain('final');
    expect(status(t, 'browser-default').textContent).toBe(M.preferenceSavedUnavailable);
    // 3 kept as it is: in flight, its submitted value shown.
    expect(details(t, '3').getAttribute('aria-busy')).toBe('true');
    expect(field(t, '3', 'directorySlug').value).toBe('final-v2');
    expect(changes).toEqual([]);
    expect(t.posts).toHaveLength(1);
  });

  it('F8-C13 — a failed read observes nothing about the renamed default; GET-only Retry refresh withdraws it', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    confirmedSave(t, '7', { slug: 'sketches-v2' });
    offer(t, 'preview-category', 'sketches-v2', 'Sketches');
    t.queue.post.push(async () => jsonResponse(200, deletedBody(CATEGORIES[2])));
    t.queue.get.push(async () => { throw new TypeError('Failed to fetch'); });
    t.confirmDelete('9');
    await flush();
    expect(settingsCategoryDeleteSync(t.document)).toBe('stale');
    expect(offered(t, 'preview-category')).toContain('sketches-v2');
    expect(settingsCategoryDeleteState(t.document, '7')).toBeNull();
    const held = deferred();
    t.queue.get.push(() => held.promise);
    t.feedbackButton('data-settings-category-delete-refresh-retry').click();
    savedAfterReadBegan(t, 'preview-category', 'sketches-v2');
    await install(held);
    expect(offered(t, 'preview-category')).not.toContain('sketches-v2');
    expect(status(t, 'preview-category').textContent).toBe(M.preferenceSavedUnavailable);
    expect(settingsCategoryDeleteState(t.document, '7')).toBeNull();
    expect(t.gets).toHaveLength(2);
    expect(t.gets.every((get) => get.method === 'GET')).toBe(true);
    expect(t.posts).toHaveLength(1);
  });

  it('F8-C14 — a superseded older read listing the renamed default cannot restore it', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    confirmedSave(t, '7', { slug: 'sketches-v2' });
    offer(t, 'preview-category', 'sketches-v2', 'Sketches');
    t.queue.post.push(async () => jsonResponse(200, deletedBody(CATEGORIES[2])));
    t.queue.get.push(async () => { throw new TypeError('Failed to fetch'); });
    t.confirmDelete('9');
    await flush();
    const controller = enhanceSettingsCategoryDelete(t.document);
    const older = deferred();
    t.queue.get.push(() => older.promise);
    controller.refresh();
    const newer = deferred();
    t.queue.get.push(() => newer.promise);
    const done = controller.refresh();
    savedAfterReadBegan(t, 'preview-category', 'sketches-v2');
    await install(newer, [CATEGORIES[0]], 'newer');
    await done;
    older.resolve(htmlResponse({ version: 'older', categories: [CATEGORIES[0], renamedSketches('sketches-v2')], preferences: PREFS }));
    await flush();
    expect(t.page.root.querySelector('[data-settings-category-defaults]').getAttribute('data-version')).toBe('newer');
    expect(t.row('7')).toBeNull();
    expect(offered(t, 'preview-category')).not.toContain('sketches-v2');
    expect(status(t, 'preview-category').textContent).toBe(M.preferenceSavedUnavailable);
    expect(t.posts).toHaveLength(1);
  });

  it('F8-C15 — an enabled new default (new id) with the renamed slug stays a choice under its own name; the old id stays gone', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    confirmedSave(t, '7', { slug: 'sketches-v2', name: 'Sketches two' });
    offer(t, 'browser-default', 'sketches-v2', 'Sketches two');
    const first = await readByDelete9(t);
    savedAfterReadBegan(t, 'browser-default', 'sketches-v2');
    await install(first);
    expect(offered(t, 'browser-default')).not.toContain('sketches-v2');
    const controller = enhanceSettingsCategoryDelete(t.document);
    const second = deferred();
    t.queue.get.push(() => second.promise);
    const done = controller.refresh();
    region(t, 'browser-default').querySelector('form').setAttribute('data-settings-fetch-save-state', 'error');
    select(t, 'browser-default').dispatch('change');
    await install(second, [CATEGORIES[0], { id: '12', name: 'Reborn', slug: 'sketches-v2' }], 'reborn');
    await done;
    expect(t.row('12')).not.toBeNull();
    expect(t.row('7')).toBeNull();
    expect(offered(t, 'browser-default')).toContain('sketches-v2');
    expect(radios(t, 'browser-default')).toContain('sketches-v2');
    expect(option(t, 'browser-default', 'sketches-v2').textContent).toBe('Reborn');
    // An old answer listing 7 is still older than the observation (vetoed),
    // but the slug is current again: a true save, nothing withdrawn.
    settle(t, 'browser-default');
    const event = answer(t, 'browser-default', { categories: [CATEGORIES[0], renamedSketches('sketches-v2', 'Sketches two')], stored: 'sketches-v2' });
    expect(event.defaultPrevented).toBe(true);
    expect(status(t, 'browser-default').textContent).toBe('Settings saved.');
    expect(offered(t, 'browser-default')).toContain('sketches-v2');
    expect(t.posts).toHaveLength(1);
  });

  it('F8-C16 / C17 / C19 — after reconciling, a valid choice reaches its own save once; the other setting is untouched; binding again adds no listener', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    enhanceSettingsCategoryDelete(t.document);
    confirmedSave(t, '7', { slug: 'sketches-v2' });
    BOTH.forEach((each) => offer(t, each, 'sketches-v2', 'Sketches'));
    const held = await readByDelete9(t);
    savedAfterReadBegan(t, 'browser-default', 'sketches-v2');
    savingAfterReadBegan(t, 'preview-category', 'sketches-v2');
    const changes = track(t);
    const reached = [];
    BOTH.forEach((each) => region(t, each).addEventListener('change', (event) => reached.push(event.target.name)));
    await install(held);
    expect(changes).toEqual([]);
    // C17: one saved (corrected), one saving (its own state).
    expect(status(t, 'browser-default').textContent).toBe(M.preferenceSavedUnavailable);
    expect(status(t, 'preview-category').textContent).toBe('Saving settings.');
    select(t, 'browser-default').value = 'final';
    select(t, 'browser-default').dispatch('change');
    expect(changes).toEqual(['browser-default']);
    expect(reached).toEqual(['browser-default']);
    expect(status(t, 'preview-category').textContent).toBe('Saving settings.');
    // C19: one listener — an older answer veto reads once, not twice.
    settle(t, 'preview-category');
    const gets = t.gets.length;
    expect(answer(t, 'preview-category', { categories: [CATEGORIES[0], renamedSketches('sketches-v2')], stored: 'sketches-v2' }).defaultPrevented).toBe(true);
    await flush();
    expect(t.gets).toHaveLength(gets + 1);
    expect(t.posts).toHaveLength(1);
  });

  it('F8-C20 — F3 / F6: an unresolved Delete of the renamed default stays held through a read that still lists it; its renamed slug stays a choice', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    confirmedSave(t, '7', { slug: 'sketches-v2' });
    offer(t, 'browser-default', 'sketches-v2', 'Sketches');
    t.queue.post.push(async () => { throw new TypeError('Failed to fetch'); });
    t.queue.get.push(async () => htmlResponse({ version: 'check', categories: [CATEGORIES[0], renamedSketches('sketches-v2'), CATEGORIES[2]], preferences: PREFS }));
    t.confirmDelete('7');
    await flush();
    expect(settingsCategoryDeleteState(t.document, '7').phase).toBe('unresolved');
    expect(settingsCategoryDeleteState(t.document, '7').slug).toBe('sketches-v2');
    expect(t.row('7').getAttribute('data-settings-category-delete-hold')).toBe('unresolved');
    expect(offered(t, 'browser-default')).toContain('sketches-v2');
    expect(t.page.root.querySelector('form[action="/settings/asset-categories"]').dispatch('submit').defaultPrevented).toBe(true);
    expect(t.posts).toHaveLength(1);
    expect(t.gets.every((get) => get.method === 'GET')).toBe(true);
  });
});

describe('WP11C-F9 — a disabled default reusing a gone default\'s slug is present but never choosable', () => {
  const ANSWER = 'creatorcrate:asset-category-preference-answer';
  const region = (t, identity) => t.page.root.querySelector(`[data-settings-asset-category-preference="${identity}"]`);
  const select = (t, identity) => region(t, identity).querySelector('select');
  const option = (t, identity, value) => select(t, identity).options.find((candidate) => candidate.value === value) || null;
  const offered = (t, identity) => select(t, identity).options.filter((candidate) => !candidate.disabled).map((candidate) => candidate.value);
  const offeredLabels = (t, identity) => select(t, identity).options.filter((candidate) => !candidate.disabled).map((candidate) => candidate.textContent);
  const radios = (t, identity) => region(t, identity).querySelectorAll('details[data-cc-dropdown] input').filter((radio) => !radio.disabled).map((radio) => radio.value);
  const status = (t, identity) => region(t, identity).querySelector('[data-settings-fetch-save-status]');
  const stored = (t, identity) => region(t, identity).getAttribute('data-settings-asset-category-preference-stored');
  const BOTH = ['browser-default', 'preview-category'];
  const PREFS = { 'browser-default': 'final', 'preview-category': '__disabled__' };
  const [FINAL, SKETCHES] = CATEGORIES;
  // Default 7 ("sketches") is deleted elsewhere; a NEW default 12 is added
  // elsewhere with the same slug. This page deletes 9 itself: that read is
  // the installed (current) list.
  const reborn = (enabled, slug = 'sketches', name = 'Reborn') => ({ id: '12', name, slug, enabled });

  function answer(t, identity, { categories = [FINAL, SKETCHES], stored: value, kind = 'saved' } = {}) {
    const parsed = new t.window.DOMParser().parseFromString(JSON.stringify({ version: 'answer', categories, preferences: { [identity]: value } }));
    const next = parsed.querySelector(`[data-settings-asset-category-preference="${identity}"]`);
    const current = region(t, identity);
    return current.dispatch(ANSWER, {
      detail: { form: current.querySelector('form'), region: current, parsed, next, kind, payload: new URLSearchParams({ [identity]: value }).toString() },
    });
  }

  function savedAfterReadBegan(t, identity, value = 'sketches') {
    select(t, identity).value = value;
    select(t, identity).dispatch('change');
    const form = region(t, identity).querySelector('form');
    form.removeAttribute('aria-busy');
    form.setAttribute('data-settings-fetch-save-state', 'saved');
    region(t, identity).setAttribute('data-settings-asset-category-preference-stored', value);
    status(t, identity).textContent = 'Settings saved.';
  }

  function savingAfterReadBegan(t, identity, value = 'sketches') {
    select(t, identity).value = value;
    select(t, identity).dispatch('change');
    region(t, identity).querySelector('form').setAttribute('aria-busy', 'true');
    region(t, identity).querySelector('form').setAttribute('data-settings-fetch-save-state', 'pending');
    status(t, identity).textContent = 'Saving settings.';
  }

  function settle(t, identity, text = 'Settings saved.', state = 'saved') {
    const form = region(t, identity).querySelector('form');
    form.removeAttribute('aria-busy');
    form.setAttribute('data-settings-fetch-save-state', state);
    status(t, identity).textContent = text;
  }

  // Keeps a setting as shown through the next install (a refused state).
  function keep(t, identity) {
    region(t, identity).querySelector('form').setAttribute('data-settings-fetch-save-state', 'error');
  }

  async function readByDelete9(t) {
    t.queue.post.push(async () => jsonResponse(200, deletedBody(CATEGORIES[2])));
    const held = deferred();
    t.queue.get.push(() => held.promise);
    t.confirmDelete('9');
    await flush();
    expect(settingsCategoryDeleteState(t.document, '9').phase).toBe('deleted');
    return held;
  }

  async function install(held, categories, version = 'fresh', preferences = PREFS) {
    held.resolve(htmlResponse({ version, categories, preferences }));
    await flush();
  }

  async function refreshWith(t, categories, version) {
    const controller = enhanceSettingsCategoryDelete(t.document);
    const held = deferred();
    t.queue.get.push(() => held.promise);
    const done = controller.refresh();
    await install(held, categories, version);
    await done;
  }

  function track(t) {
    const changes = [];
    t.page.root.addEventListener('change', (event) => changes.push(event.target.name), true);
    return changes;
  }

  const details = (t, id) => t.row(id).querySelector('form[data-category-details-form]');
  const field = (t, id, name) => details(t, id).querySelector(`input[name="${name}"]`);
  const reviewedField = (t, id, name) => details(t, id).querySelector(`input[data-category-details-reviewed="${name}"]`);
  function confirmedSlug(t, id, slug) {
    field(t, id, 'directorySlug').value = slug;
    field(t, id, 'directorySlug').defaultValue = slug;
    reviewedField(t, id, 'directorySlug').value = slug;
    details(t, id).setAttribute('data-category-details-state', 'saved');
  }
  function offer(t, identity, slug, replacing) {
    const current = option(t, identity, replacing);
    const radio = region(t, identity).querySelectorAll('details[data-cc-dropdown] input').find((candidate) => candidate.value === replacing);
    if (current) { current.value = slug; current.setAttribute('value', slug); }
    if (radio) { radio.value = slug; radio.setAttribute('value', slug); }
  }

  it('F9 contract — every row carries the enabled state the server rendered; a disabled default is listed but not offered', () => {
    const t = setup({ categories: [FINAL, { ...SKETCHES, enabled: false }] });
    expect(t.row('3').getAttribute('data-category-enabled')).toBe('true');
    expect(t.row('7').getAttribute('data-category-enabled')).toBe('false');
    expect(offered(t, 'browser-default')).not.toContain('sketches');
  });

  for (const identity of BOTH) {
    it(`F9-C1 / C2 / C3 / C4 / C6 / C10 / C11 / C19 — ${identity}: deleted 7 and disabled 12 share the slug; 12 stays listed, the slug is not offered or named after 12; stored kept; "Settings saved." corrected; nothing saved`, async () => {
      const t = setup({ preferences: PREFS });
      enhanceSettingsCategoryDelete(t.document);
      const changes = track(t);
      const held = await readByDelete9(t);
      savedAfterReadBegan(t, identity, 'sketches');
      changes.length = 0;
      await install(held, [FINAL, reborn(false)]);
      // C1 / C10: distinct ids — 7 gone (observed, never this page's Delete),
      // 12 present, still managed, and disabled.
      expect(t.row('7')).toBeNull();
      expect(settingsCategoryDeleteState(t.document, '7')).toBeNull();
      expect(t.row('12')).not.toBeNull();
      expect(t.row('12').getAttribute('data-category-enabled')).toBe('false');
      expect(settingsCategoryDeleteState(t.document, '12')).toBeNull();
      // C2 / C3: neither setting offers the slug (kept or installed).
      BOTH.forEach((each) => {
        expect(offered(t, each)).not.toContain('sketches');
        expect(radios(t, each)).not.toContain('sketches');
        expect(offered(t, each)).toContain('final');
      });
      // C11: the kept, selected option is not renamed after disabled 12.
      expect(select(t, identity).value).toBe('sketches');
      expect(option(t, identity, 'sketches').disabled).toBe(true);
      expect(option(t, identity, 'sketches').textContent).not.toBe('Reborn');
      expect(offeredLabels(t, identity)).not.toContain('Reborn');
      // C4 / C6: stored slug kept; the status no longer says saved and usable.
      expect(stored(t, identity)).toBe('sketches');
      expect(status(t, identity).textContent).toBe(M.preferenceSavedUnavailable);
      expect(t.feedbackText()).not.toContain('Sketches');
      expect(t.feedbackText()).not.toContain('Reborn');
      // C19: no change raised; the one POST is 9's Delete; reads only.
      expect(changes).toEqual([]);
      expect(t.posts).toHaveLength(1);
      expect(t.gets).toHaveLength(1);
      expect(t.gets.every((get) => get.method === 'GET')).toBe(true);
    });

    it(`F9-C5 / C16 — ${identity}: a save in flight keeps its value submittable through the read; its older answer (listing 7) cannot offer the slug for disabled 12`, async () => {
      const t = setup({ preferences: PREFS });
      enhanceSettingsCategoryDelete(t.document);
      const held = await readByDelete9(t);
      savingAfterReadBegan(t, identity, 'sketches');
      const changes = track(t);
      await install(held, [FINAL, reborn(false)]);
      // C16: the save's own value stays selected and enabled (the save reads
      // the form); its status is its own.
      expect(select(t, identity).value).toBe('sketches');
      expect(option(t, identity, 'sketches').disabled).toBe(false);
      expect(status(t, identity).textContent).toBe('Saving settings.');
      // C5: the older answer is vetoed; the slug is withdrawn and the status
      // says what is true; GET only for the server's own display.
      settle(t, identity);
      const gets = t.gets.length;
      const event = answer(t, identity, { categories: [FINAL, SKETCHES], stored: 'sketches' });
      expect(event.defaultPrevented).toBe(true);
      expect(offered(t, identity)).not.toContain('sketches');
      expect(radios(t, identity)).not.toContain('sketches');
      expect(status(t, identity).textContent).toBe(M.preferenceSavedUnavailable);
      expect(stored(t, identity)).toBe('sketches');
      await flush();
      expect(t.gets).toHaveLength(gets + 1);
      expect(t.gets.every((get) => get.method === 'GET')).toBe(true);
      expect(changes).toEqual([]);
      expect(t.posts).toHaveLength(1);
    });
  }

  it('F9-C5b — an older answer listing 7, delivered after the read showed disabled 12, cannot re-enable an option this page withdrew', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    const held = await readByDelete9(t);
    savedAfterReadBegan(t, 'browser-default');
    await install(held, [FINAL, reborn(false)]);
    expect(option(t, 'browser-default', 'sketches').disabled).toBe(true);
    // Its render lists 7 enabled and offers the slug; it is not installed.
    expect(answer(t, 'browser-default', { stored: 'sketches' }).defaultPrevented).toBe(true);
    expect(option(t, 'browser-default', 'sketches').disabled).toBe(true);
    expect(offered(t, 'browser-default')).not.toContain('sketches');
    expect(status(t, 'browser-default').textContent).toBe(M.preferenceSavedUnavailable);
    expect(t.posts).toHaveLength(1);
  });

  it('F9-C7 — an enabled 12 with the slug stays choosable under its own name (F6 / F8 kept)', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    const held = await readByDelete9(t);
    savedAfterReadBegan(t, 'browser-default');
    await install(held, [FINAL, reborn(true)]);
    expect(t.row('7')).toBeNull();
    expect(t.row('12').getAttribute('data-category-enabled')).toBe('true');
    expect(offered(t, 'browser-default')).toContain('sketches');
    expect(radios(t, 'browser-default')).toContain('sketches');
    expect(option(t, 'browser-default', 'sketches').textContent).toBe('Reborn');
    expect(status(t, 'browser-default').textContent).toBe('Settings saved.');
    expect(offered(t, 'preview-category')).toContain('sketches');
    expect(t.posts).toHaveLength(1);
  });

  it('F9-C8 / C9 — availability follows the latest installed read: disabled → enabled → disabled; nothing saved, no change raised', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    const changes = track(t);
    const held = await readByDelete9(t);
    savedAfterReadBegan(t, 'browser-default');
    changes.length = 0;
    await install(held, [FINAL, reborn(false)], 'disabled');
    expect(offered(t, 'browser-default')).not.toContain('sketches');
    // C8: enabled elsewhere; the setting is kept as shown (refused state).
    keep(t, 'browser-default');
    await refreshWith(t, [FINAL, reborn(true)], 'enabled');
    expect(offered(t, 'browser-default')).toContain('sketches');
    expect(radios(t, 'browser-default')).toContain('sketches');
    expect(option(t, 'browser-default', 'sketches').textContent).toBe('Reborn');
    expect(option(t, 'browser-default', 'sketches').hasAttribute('data-settings-category-withdrawn')).toBe(false);
    // C9: disabled again elsewhere; withdrawn again.
    keep(t, 'browser-default');
    await refreshWith(t, [FINAL, reborn(false)], 'disabled-again');
    expect(offered(t, 'browser-default')).not.toContain('sketches');
    expect(radios(t, 'browser-default')).not.toContain('sketches');
    expect(select(t, 'browser-default').value).toBe('sketches');
    expect(stored(t, 'browser-default')).toBe('sketches');
    expect(t.row('12')).not.toBeNull();
    expect(changes).toEqual([]);
    expect(t.posts).toHaveLength(1);
    expect(t.gets.every((get) => get.method === 'GET')).toBe(true);
  });

  it('F9-C12 — F8 rename: confirmed sketches → sketches-v2, deleted elsewhere, disabled 12 reuses sketches-v2: withdrawn; enabled, choosable', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    confirmedSlug(t, '7', 'sketches-v2');
    offer(t, 'browser-default', 'sketches-v2', 'sketches');
    const held = await readByDelete9(t);
    savedAfterReadBegan(t, 'browser-default', 'sketches-v2');
    await install(held, [FINAL, reborn(false, 'sketches-v2')]);
    expect(t.row('7')).toBeNull();
    expect(offered(t, 'browser-default')).not.toContain('sketches-v2');
    expect(offered(t, 'browser-default')).not.toContain('sketches');
    expect(status(t, 'browser-default').textContent).toBe(M.preferenceSavedUnavailable);
    keep(t, 'browser-default');
    await refreshWith(t, [FINAL, reborn(true, 'sketches-v2')], 'enabled');
    expect(offered(t, 'browser-default')).toContain('sketches-v2');
    expect(option(t, 'browser-default', 'sketches-v2').textContent).toBe('Reborn');
    expect(t.row('7')).toBeNull();
    expect(t.posts).toHaveLength(1);
  });

  it('F9-C13 — several saved slugs (sketches → v2 → v3): disabled 12 reusing an earlier slug keeps it unavailable; an older answer offering it is vetoed', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    confirmedSlug(t, '7', 'sketches-v2');
    // An answer rendered between the renames teaches the v2 slug (F8).
    answer(t, 'preview-category', { categories: [FINAL, { ...SKETCHES, slug: 'sketches-v2' }], stored: '__disabled__' });
    confirmedSlug(t, '7', 'sketches-v3');
    offer(t, 'browser-default', 'sketches-v3', 'sketches');
    const held = await readByDelete9(t);
    savedAfterReadBegan(t, 'browser-default', 'sketches-v3');
    await install(held, [FINAL, reborn(false, 'sketches-v2')]);
    for (const slug of ['sketches', 'sketches-v2', 'sketches-v3']) {
      expect(offered(t, 'browser-default')).not.toContain(slug);
    }
    settle(t, 'browser-default');
    expect(answer(t, 'browser-default', { categories: [FINAL, { ...SKETCHES, slug: 'sketches-v2' }], stored: 'sketches-v3' }).defaultPrevented).toBe(true);
    expect(offered(t, 'browser-default')).not.toContain('sketches-v2');
    expect(t.posts).toHaveLength(1);
  });

  it('F9-C14 — a failed read observes nothing (7 still enabled and offered); GET-only Retry then installs disabled 12 and withdraws the slug', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    t.queue.post.push(async () => jsonResponse(200, deletedBody(CATEGORIES[2])));
    t.queue.get.push(async () => { throw new TypeError('Failed to fetch'); });
    t.confirmDelete('9');
    await flush();
    expect(settingsCategoryDeleteSync(t.document)).toBe('stale');
    expect(t.row('7').getAttribute('data-category-enabled')).toBe('true');
    expect(offered(t, 'browser-default')).toContain('sketches');
    const held = deferred();
    t.queue.get.push(() => held.promise);
    t.feedbackButton('data-settings-category-delete-refresh-retry').click();
    savedAfterReadBegan(t, 'browser-default');
    await install(held, [FINAL, reborn(false)]);
    expect(settingsCategoryDeleteSync(t.document)).toBe('idle');
    expect(offered(t, 'browser-default')).not.toContain('sketches');
    expect(status(t, 'browser-default').textContent).toBe(M.preferenceSavedUnavailable);
    expect(t.gets).toHaveLength(2);
    expect(t.gets.every((get) => get.method === 'GET')).toBe(true);
    expect(t.posts).toHaveLength(1);
  });

  it('F9-C15 — a superseded older read (7 enabled) cannot restore the slug after the newer read installed disabled 12', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    t.queue.post.push(async () => jsonResponse(200, deletedBody(CATEGORIES[2])));
    t.queue.get.push(async () => { throw new TypeError('Failed to fetch'); });
    t.confirmDelete('9');
    await flush();
    const controller = enhanceSettingsCategoryDelete(t.document);
    const older = deferred();
    t.queue.get.push(() => older.promise);
    controller.refresh();
    const newer = deferred();
    t.queue.get.push(() => newer.promise);
    const done = controller.refresh();
    savedAfterReadBegan(t, 'browser-default');
    await install(newer, [FINAL, reborn(false)], 'newer');
    await done;
    older.resolve(htmlResponse({ version: 'older', categories: [FINAL, SKETCHES], preferences: PREFS }));
    await flush();
    expect(t.page.root.querySelector('[data-settings-category-defaults]').getAttribute('data-version')).toBe('newer');
    expect(t.row('7')).toBeNull();
    expect(t.row('12').getAttribute('data-category-enabled')).toBe('false');
    expect(offered(t, 'browser-default')).not.toContain('sketches');
    expect(t.posts).toHaveLength(1);
  });

  it('F9-C17 / C18 — a current 422 refusal rendered after 12 was disabled installs as the server shows it; a valid choice then reaches its own save once', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    const held = await readByDelete9(t);
    savedAfterReadBegan(t, 'preview-category', 'final');
    await install(held, [FINAL, reborn(false)]);
    // Rendered after: lists 12 (disabled), not 7 — not older, so installed.
    settle(t, 'browser-default', 'Could not save settings. Your current changes were kept.', 'error');
    const event = answer(t, 'browser-default', { categories: [FINAL, reborn(false)], stored: 'final', kind: 'refused' });
    expect(event.defaultPrevented).toBe(false);
    expect(event.detail.next.querySelector('select').options.map((candidate) => candidate.value)).not.toContain('sketches');
    // C18: after it, a valid choice reaches its save once.
    const changes = track(t);
    const reached = [];
    region(t, 'browser-default').addEventListener('change', (each) => reached.push(each.target.name));
    select(t, 'browser-default').value = 'final';
    select(t, 'browser-default').dispatch('change');
    expect(changes).toEqual(['browser-default']);
    expect(reached).toEqual(['browser-default']);
    expect(t.posts).toHaveLength(1);
  });

  it('F9-C20 — F3 / F6: an unresolved Delete stays held through a read also listing a disabled default; Add stays refused; nothing is sent', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    t.queue.post.push(async () => { throw new TypeError('Failed to fetch'); });
    t.queue.get.push(async () => htmlResponse({ version: 'check', categories: [FINAL, SKETCHES, CATEGORIES[2], reborn(false, 'reborn')], preferences: PREFS }));
    t.confirmDelete('7');
    await flush();
    expect(settingsCategoryDeleteState(t.document, '7').phase).toBe('unresolved');
    expect(t.row('7').getAttribute('data-settings-category-delete-hold')).toBe('unresolved');
    expect(offered(t, 'browser-default')).toContain('sketches');
    expect(offered(t, 'browser-default')).not.toContain('reborn');
    expect(t.page.root.querySelector('form[action="/settings/asset-categories"]').dispatch('submit').defaultPrevented).toBe(true);
    expect(t.posts).toHaveLength(1);
    expect(t.gets.every((get) => get.method === 'GET')).toBe(true);
  });
});

describe('WP11C-F9A — an older Defaults answer with a CURRENT id cannot restore what the installed list shows unavailable', () => {
  const ANSWER = 'creatorcrate:asset-category-preference-answer';
  const region = (t, identity) => t.page.root.querySelector(`[data-settings-asset-category-preference="${identity}"]`);
  const select = (t, identity) => region(t, identity).querySelector('select');
  const option = (t, identity, value) => select(t, identity).options.find((candidate) => candidate.value === value) || null;
  const offered = (t, identity) => select(t, identity).options.filter((candidate) => !candidate.disabled).map((candidate) => candidate.value);
  const offeredLabels = (t, identity) => select(t, identity).options.filter((candidate) => !candidate.disabled).map((candidate) => candidate.textContent);
  const radios = (t, identity) => region(t, identity).querySelectorAll('details[data-cc-dropdown] input').filter((radio) => !radio.disabled).map((radio) => radio.value);
  const status = (t, identity) => region(t, identity).querySelector('[data-settings-fetch-save-status]');
  const stored = (t, identity) => region(t, identity).getAttribute('data-settings-asset-category-preference-stored');
  const version = (t, identity) => region(t, identity).querySelector('[data-region-version]')?.getAttribute('data-region-version');
  const BOTH = ['browser-default', 'preview-category'];
  const PREFS = { 'browser-default': 'final', 'preview-category': '__disabled__' };
  const [FINAL, SKETCHES, EXPORTS] = CATEGORIES;
  // Y: a NEW default (id 12) with the slug of 7, which was deleted elsewhere.
  const reborn = (enabled, slug = 'sketches', name = 'Reborn') => ({ id: '12', name, slug, enabled });

  // The save's answer as the real module dispatches it: the redirect render
  // of the whole page as it was when the save ran.
  function answer(t, identity, { categories, value = 'sketches', kind = 'saved', storedValue = kind === 'saved' ? value : PREFS[identity] } = {}) {
    const parsed = new t.window.DOMParser().parseFromString(JSON.stringify({ version: 'answer', categories, preferences: { [identity]: storedValue } }));
    const next = parsed.querySelector(`[data-settings-asset-category-preference="${identity}"]`);
    const current = region(t, identity);
    return current.dispatch(ANSWER, {
      detail: { form: current.querySelector('form'), region: current, parsed, next, kind, payload: new URLSearchParams({ [identity]: value }).toString() },
    });
  }

  // The person chooses `value`; the save is sent and in flight.
  function choose(t, identity, value) {
    select(t, identity).value = value;
    select(t, identity).dispatch('change');
    region(t, identity).querySelector('form').setAttribute('aria-busy', 'true');
    region(t, identity).querySelector('form').setAttribute('data-settings-fetch-save-state', 'pending');
    status(t, identity).textContent = 'Saving settings.';
  }

  // settings-fetch-save settles the form before it dispatches the answer.
  function settle(t, identity, kind = 'saved') {
    const form = region(t, identity).querySelector('form');
    form.removeAttribute('aria-busy');
    form.setAttribute('data-settings-fetch-save-state', kind === 'saved' ? 'saved' : 'error');
    status(t, identity).textContent = kind === 'saved' ? 'Settings saved.' : 'Could not save settings. Your current changes were kept.';
  }

  function track(t) {
    const changes = [];
    t.page.root.addEventListener('change', (event) => changes.push(event.target.name), true);
    return changes;
  }

  // This page deletes 9 with its POST held; the preference is chosen while
  // it is held; the Delete answers and its list read (GET) is held.
  async function deleteHeldThenChoose(t, identity, value = 'sketches') {
    const post = deferred();
    t.queue.post.push(() => post.promise);
    const read = deferred();
    t.queue.get.push(() => read.promise);
    t.confirmDelete('9');
    await flush();
    if (identity) choose(t, identity, value);
    post.resolve(jsonResponse(200, deletedBody(EXPORTS)));
    await flush();
    expect(settingsCategoryDeleteState(t.document, '9').phase).toBe('deleted');
    expect(t.gets).toHaveLength(1);
    return read;
  }

  async function install(read, categories, versionName = 'fresh', preferences = PREFS) {
    read.resolve(htmlResponse({ version: versionName, categories, preferences }));
    await flush();
  }

  // The F9A order: the save ran while Y was ENABLED (its answer is held);
  // Y is disabled elsewhere; this page's read observes that and installs.
  async function f9aOrder(t, identity, { installed = [FINAL, reborn(false)] } = {}) {
    const read = await deleteHeldThenChoose(t, identity);
    await install(read, installed);
    expect(region(t, identity).querySelector('form').getAttribute('aria-busy')).toBe('true');
    settle(t, identity);
  }

  for (const identity of BOTH) {
    it(`F9A-C1 / C2 / C3 / C4 / C5 / C6 / C10 / C12 / C19 — ${identity}: the answer lists Y's CURRENT id as enabled; the installed read shows Y disabled; the answer is not installed, S is not offered, "Settings saved." is not shown; stored kept; T stays choosable; GET only`, async () => {
      const t = setup({ preferences: PREFS });
      enhanceSettingsCategoryDelete(t.document);
      const changes = track(t);
      await f9aOrder(t, identity);
      changes.length = 0;
      const event = answer(t, identity, { categories: [FINAL, reborn(true)] });
      await flush();
      // C1: not installed although every id it lists is current.
      expect(event.defaultPrevented).toBe(true);
      expect(version(t, identity)).not.toBe('answer');
      // C10: X (7) gone, Y (12) present, disabled, managed under its own id.
      expect(t.row('7')).toBeNull();
      expect(t.row('12').getAttribute('data-category-enabled')).toBe('false');
      expect(settingsCategoryDeleteState(t.document, '12')).toBeNull();
      // C2 / C3: S is not choosable in either setting, native or dropdown.
      BOTH.forEach((each) => {
        expect(offered(t, each)).not.toContain('sketches');
        expect(radios(t, each)).not.toContain('sketches');
      });
      expect(option(t, identity, 'sketches').disabled).toBe(true);
      expect(option(t, identity, 'sketches').hasAttribute('data-settings-category-withdrawn')).toBe(true);
      expect(offeredLabels(t, identity)).not.toContain('Reborn');
      // C4 / C5: the save is acknowledged truthfully; the stored slug is kept.
      expect(status(t, identity).textContent).not.toBe('Settings saved.');
      expect(status(t, identity).textContent).toBe(M.preferenceSavedUnavailable);
      expect(stored(t, identity)).toBe('sketches');
      // C6: T stays choosable.
      expect(offered(t, identity)).toContain('final');
      // C19: nothing raised or saved; one GET re-reads the server's display.
      expect(changes).toEqual([]);
      expect(t.posts).toHaveLength(1);
      expect(t.gets).toHaveLength(2);
      expect(t.gets.every((get) => get.method === 'GET')).toBe(true);
      expect(settingsCategoryDeleteSync(t.document)).toBe('refreshing');
    });

    it(`F9A-C8 — ${identity}: no gone history at all — current default 7 enabled when the answer rendered, disabled in the installed read; its slug is withdrawn and the status says disabled`, async () => {
      const t = setup({ preferences: PREFS });
      enhanceSettingsCategoryDelete(t.document);
      const read = await deleteHeldThenChoose(t, identity);
      await install(read, [FINAL, { ...SKETCHES, enabled: false }]);
      settle(t, identity);
      expect(answer(t, identity, { categories: [FINAL, SKETCHES] }).defaultPrevented).toBe(true);
      expect(t.row('7').getAttribute('data-category-enabled')).toBe('false');
      expect(offered(t, identity)).not.toContain('sketches');
      expect(radios(t, identity)).not.toContain('sketches');
      expect(status(t, identity).textContent).toBe(M.preferenceSavedDisabled);
      expect(stored(t, identity)).toBe('sketches');
      expect(offered(t, identity)).toContain('final');
      expect(t.posts).toHaveLength(1);
    });
  }

  it('F9A-C9 / C18 — disabled → enabled: an older answer showing Y disabled is not installed (T saved stays "Settings saved."); its GET installs Y enabled; S is choosable and an intentional save is one change', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    const read = await deleteHeldThenChoose(t, 'browser-default', 'final');
    await install(read, [FINAL, reborn(true)]);
    settle(t, 'browser-default');
    const refreshRead = deferred();
    t.queue.get.push(() => refreshRead.promise);
    expect(answer(t, 'browser-default', { categories: [FINAL, reborn(false)], value: 'final' }).defaultPrevented).toBe(true);
    await flush();
    // The saved choice (T) can still be chosen: its status stays true.
    expect(status(t, 'browser-default').textContent).toBe('Settings saved.');
    expect(stored(t, 'browser-default')).toBe('final');
    expect(t.gets).toHaveLength(2);
    await install(refreshRead, [FINAL, reborn(true)], 'after', { 'browser-default': 'final', 'preview-category': '__disabled__' });
    expect(version(t, 'browser-default')).toBe('after');
    expect(offered(t, 'browser-default')).toContain('sketches');
    expect(offeredLabels(t, 'browser-default')).toContain('Reborn');
    // C18: chosen intentionally, it is the person's own change (one save).
    const changes = track(t);
    select(t, 'browser-default').value = 'sketches';
    select(t, 'browser-default').dispatch('change');
    expect(changes).toEqual(['browser-default']);
    settle(t, 'browser-default');
    // Answered with no newer read installed: a current answer installs.
    expect(answer(t, 'browser-default', { categories: [FINAL, reborn(true)] }).defaultPrevented).toBe(false);
    expect(t.posts).toHaveLength(1);
    expect(t.gets).toHaveLength(2);
  });

  it('F9A-C7 / R8 — a current 422 (chosen after the read installed Y disabled) is installed as the server rendered it', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    const read = await deleteHeldThenChoose(t, null);
    await install(read, [FINAL, reborn(false)]);
    choose(t, 'browser-default', 'sketches');
    settle(t, 'browser-default', 'refused');
    const event = answer(t, 'browser-default', { categories: [FINAL, reborn(false)], kind: 'refused' });
    expect(event.defaultPrevented).toBe(false);
    expect(t.gets).toHaveLength(1);
    expect(t.posts).toHaveLength(1);
  });

  it('F9A-C7b — an older 422 (rendered before a newer installed read) is not installed: the refusal stays a refusal, nothing reads as saved, no GET is needed', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    const read = await deleteHeldThenChoose(t, 'browser-default');
    await install(read, [FINAL, reborn(false)]);
    settle(t, 'browser-default', 'refused');
    expect(answer(t, 'browser-default', { categories: [FINAL, reborn(true)], kind: 'refused' }).defaultPrevented).toBe(true);
    expect(status(t, 'browser-default').textContent).toBe('Could not save settings. Your current changes were kept.');
    expect(stored(t, 'browser-default')).toBe('final');
    expect(offered(t, 'browser-default')).not.toContain('sketches');
    expect(offered(t, 'browser-default')).toContain('final');
    expect(t.gets).toHaveLength(1);
  });

  it('F9A-C1b — an answer whose enabled defaults match the installed read is installed (it is not older for what can be chosen)', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    const read = await deleteHeldThenChoose(t, 'browser-default', 'final');
    await install(read, [FINAL, reborn(false)]);
    settle(t, 'browser-default');
    expect(answer(t, 'browser-default', { categories: [FINAL, reborn(false)], value: 'final' }).defaultPrevented).toBe(false);
    expect(t.gets).toHaveLength(1);
  });

  it('F9A-C11 — rename (CASE C / D): 7 renamed here to "beta", deleted elsewhere; Y takes "beta" DISABLED; the older answer (Y enabled) restores nothing; enabled by the next read, "beta" is offered under Y', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    const details = t.row('7').querySelector('form[data-category-details-form]');
    details.querySelector('input[name="directorySlug"]').value = 'beta';
    details.querySelector('input[name="directorySlug"]').defaultValue = 'beta';
    details.querySelector('input[data-category-details-reviewed="directorySlug"]').value = 'beta';
    details.setAttribute('data-category-details-state', 'saved');
    const option7 = option(t, 'browser-default', 'sketches');
    option7.value = 'beta';
    option7.setAttribute('value', 'beta');
    region(t, 'browser-default').querySelectorAll('details[data-cc-dropdown] input').find((radio) => radio.value === 'sketches').value = 'beta';
    const read = await deleteHeldThenChoose(t, 'browser-default', 'beta');
    await install(read, [FINAL, reborn(false, 'beta')]);
    settle(t, 'browser-default');
    const refreshRead = deferred();
    t.queue.get.push(() => refreshRead.promise);
    expect(answer(t, 'browser-default', { categories: [FINAL, reborn(true, 'beta')], value: 'beta' }).defaultPrevented).toBe(true);
    expect(t.row('7')).toBeNull();
    expect(t.row('12')).not.toBeNull();
    expect(offered(t, 'browser-default')).not.toContain('beta');
    expect(radios(t, 'browser-default')).not.toContain('beta');
    expect(status(t, 'browser-default').textContent).not.toBe('Settings saved.');
    // CASE D: enabled now, the next installed read offers it under Y.
    await install(refreshRead, [FINAL, reborn(true, 'beta')], 'after', { 'browser-default': 'beta', 'preview-category': '__disabled__' });
    expect(offered(t, 'browser-default')).toContain('beta');
    expect(offeredLabels(t, 'browser-default')).toContain('Reborn');
    expect(t.row('7')).toBeNull();
    expect(t.posts).toHaveLength(1);
  });

  it('F9A-C13 / R4 — superseded read: an older read (Y enabled) answering after the newer installed read (Y disabled) restores nothing, and the older answer is still not installed', async () => {
    const t = setup({ preferences: PREFS });
    const controller = enhanceSettingsCategoryDelete(t.document);
    const read = await deleteHeldThenChoose(t, 'browser-default');
    const newer = deferred();
    t.queue.get.push(() => newer.promise);
    const second = controller.refresh();
    await install(newer, [FINAL, reborn(false)], 'newer');
    await second;
    await install(read, [FINAL, reborn(true)], 'older');
    expect(t.page.root.querySelector('[data-settings-category-defaults]').getAttribute('data-version')).toBe('newer');
    expect(t.row('12').getAttribute('data-category-enabled')).toBe('false');
    settle(t, 'browser-default');
    expect(answer(t, 'browser-default', { categories: [FINAL, reborn(true)] }).defaultPrevented).toBe(true);
    expect(offered(t, 'browser-default')).not.toContain('sketches');
    expect(t.posts).toHaveLength(1);
  });

  it('F9A-C14 / R2 / R3 — a failed read observes nothing (the answer installs); GET-only Retry refresh then installs Y disabled and S is not offered', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    const post = deferred();
    t.queue.post.push(() => post.promise);
    t.queue.get.push(async () => ({ ok: false, status: 500, text: async () => '' }));
    t.confirmDelete('9');
    await flush();
    choose(t, 'browser-default', 'sketches');
    post.resolve(jsonResponse(200, deletedBody(EXPORTS)));
    await flush();
    expect(settingsCategoryDeleteSync(t.document)).toBe('stale');
    settle(t, 'browser-default');
    // No read was installed: nothing on this page is newer than the answer.
    expect(answer(t, 'browser-default', { categories: [FINAL, SKETCHES] }).defaultPrevented).toBe(false);
    const retry = deferred();
    t.queue.get.push(() => retry.promise);
    t.feedbackButton('data-settings-category-delete-refresh-retry').click();
    await install(retry, [FINAL, reborn(false)], 'retried', { 'browser-default': 'sketches', 'preview-category': '__disabled__' });
    expect(settingsCategoryDeleteSync(t.document)).toBe('idle');
    expect(offered(t, 'browser-default')).not.toContain('sketches');
    expect(t.posts).toHaveLength(1);
    expect(t.gets).toHaveLength(2);
    expect(t.gets.every((get) => get.method === 'GET')).toBe(true);
  });

  it('F9A-C15 / R7 — a save in flight through the install keeps its payload (the selected S stays enabled while saving); the older answer then restores nothing', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    const read = await deleteHeldThenChoose(t, 'browser-default');
    await install(read, [FINAL, reborn(false)]);
    // Saving: the selected option is the in-flight save's value.
    expect(select(t, 'browser-default').value).toBe('sketches');
    expect(option(t, 'browser-default', 'sketches').disabled).toBe(false);
    settle(t, 'browser-default');
    expect(answer(t, 'browser-default', { categories: [FINAL, reborn(true)] }).defaultPrevented).toBe(true);
    expect(option(t, 'browser-default', 'sketches').disabled).toBe(true);
    expect(select(t, 'browser-default').value).toBe('sketches');
  });

  it('F9A-C16 — a dirty details draft on a survivor is kept through the install and the vetoed answer; nothing is saved', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    const changes = track(t);
    const name = t.row('3').querySelector('input[name="displayName"]');
    name.value = 'Final draft';
    const read = await deleteHeldThenChoose(t, 'browser-default');
    await install(read, [FINAL, reborn(false)]);
    settle(t, 'browser-default');
    changes.length = 0;
    expect(answer(t, 'browser-default', { categories: [FINAL, reborn(true)] }).defaultPrevented).toBe(true);
    expect(t.row('3').querySelector('input[name="displayName"]')).toBe(name);
    expect(name.value).toBe('Final draft');
    expect(name.defaultValue).toBe('Final');
    expect(changes).toEqual([]);
    expect(t.posts).toHaveLength(1);
  });

  it('F9A-C17 — the two settings settle independently: the older browser answer is vetoed; a preview answer for a choice made after the install is current and installs', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    const read = await deleteHeldThenChoose(t, 'browser-default');
    await install(read, [FINAL, reborn(false)]);
    choose(t, 'preview-category', 'final');
    settle(t, 'browser-default');
    expect(answer(t, 'browser-default', { categories: [FINAL, reborn(true)] }).defaultPrevented).toBe(true);
    // The preview setting is still saving its own choice: untouched.
    expect(status(t, 'preview-category').textContent).toBe('Saving settings.');
    expect(select(t, 'preview-category').value).toBe('final');
    settle(t, 'preview-category');
    expect(answer(t, 'preview-category', { categories: [FINAL, reborn(false)], value: 'final' }).defaultPrevented).toBe(false);
    expect(status(t, 'preview-category').textContent).toBe('Settings saved.');
    expect(status(t, 'browser-default').textContent).toBe(M.preferenceSavedUnavailable);
  });

  it('F9A-C20 — binding twice keeps one listener: one vetoed answer starts exactly one GET', async () => {
    const t = setup({ preferences: PREFS });
    const first = enhanceSettingsCategoryDelete(t.document);
    expect(enhanceSettingsCategoryDelete(t.document)).toBe(first);
    await f9aOrder(t, 'browser-default');
    const before = t.gets.length;
    answer(t, 'browser-default', { categories: [FINAL, reborn(true)] });
    await flush();
    expect(t.gets.length).toBe(before + 1);
    // A second older answer while that GET is in flight starts no other.
    answer(t, 'browser-default', { categories: [FINAL, reborn(true)] });
    await flush();
    expect(t.gets.length).toBe(before + 1);
    expect(t.posts).toHaveLength(1);
  });

  for (const identity of BOTH) {
    it(`F9A-C12b — ${identity}: the read was SENT before the setting changed but installed after (rendered after Y was disabled); the older answer is still not installed`, async () => {
      const t = setup({ preferences: PREFS });
      enhanceSettingsCategoryDelete(t.document);
      const read = await deleteHeldThenChoose(t, null);
      // The read is on its way; the person chooses S now.
      choose(t, identity, 'sketches');
      await install(read, [FINAL, reborn(false)]);
      settle(t, identity);
      const refreshRead = deferred();
      t.queue.get.push(() => refreshRead.promise);
      expect(answer(t, identity, { categories: [FINAL, reborn(true)] }).defaultPrevented).toBe(true);
      await flush();
      expect(offered(t, identity)).not.toContain('sketches');
      expect(status(t, identity).textContent).not.toBe('Settings saved.');
      expect(t.gets).toHaveLength(2);
      // The server's own display, by the GET sent after both.
      await install(refreshRead, [FINAL, reborn(false)], 'after', { ...PREFS, [identity]: 'sketches' });
      expect(version(t, identity)).toBe('after');
      expect(offered(t, identity)).not.toContain('sketches');
      expect(t.posts).toHaveLength(1);
    });
  }

  it('F9A regression (F2/F6) — an answer still listing the deleted id stays vetoed under F2, with its own wording', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    await f9aOrder(t, 'browser-default');
    const event = answer(t, 'browser-default', { categories: [FINAL, SKETCHES, reborn(true)] });
    expect(event.defaultPrevented).toBe(true);
    expect(offered(t, 'browser-default')).not.toContain('sketches');
    expect(status(t, 'browser-default').textContent).toBe(M.preferenceSavedUnavailable);
  });
});

describe('WP11C-F9B — a list read older than an acknowledged Defaults save cannot roll it back', () => {
  const ANSWER = 'creatorcrate:asset-category-preference-answer';
  const STORED = 'data-settings-asset-category-preference-stored';
  const region = (t, identity) => t.page.root.querySelector(`[data-settings-asset-category-preference="${identity}"]`);
  const select = (t, identity) => region(t, identity).querySelector('select');
  const offered = (t, identity) => select(t, identity).options.filter((candidate) => !candidate.disabled).map((candidate) => candidate.value);
  const status = (t, identity) => region(t, identity).querySelector('[data-settings-fetch-save-status]');
  const stored = (t, identity) => region(t, identity).getAttribute(STORED);
  const version = (t, identity) => region(t, identity).querySelector('[data-region-version]')?.getAttribute('data-region-version');
  const form = (t, identity) => region(t, identity).querySelector('form');
  const BOTH = ['browser-default', 'preview-category'];
  // T: what is saved first, for both settings.
  const PREFS = { 'browser-default': 'final', 'preview-category': 'final' };
  const [FINAL, SKETCHES, EXPORTS] = CATEGORIES;
  const AFTER_DELETE = [FINAL, SKETCHES];

  function track(t) {
    const changes = [];
    t.page.root.addEventListener('change', (event) => changes.push(event.target.name), true);
    return changes;
  }

  // The person chooses `value`; the save is sent and in flight.
  function choose(t, identity, value) {
    select(t, identity).value = value;
    select(t, identity).dispatch('change');
    form(t, identity).setAttribute('aria-busy', 'true');
    form(t, identity).setAttribute('data-settings-fetch-save-state', 'pending');
    status(t, identity).textContent = 'Saving settings.';
  }

  // settings-fetch-save settles the form, then the answer is dispatched;
  // when it is not cancelled the answer's region is installed (its stored
  // value is the save's), as settings-asset-category-preferences-fetch-save
  // does for real.
  function acknowledge(t, identity, value, { kind = 'saved', categories = AFTER_DELETE } = {}) {
    const current = region(t, identity);
    current.querySelector('form').removeAttribute('aria-busy');
    current.querySelector('form').setAttribute('data-settings-fetch-save-state', kind === 'saved' ? 'saved' : 'error');
    status(t, identity).textContent = kind === 'saved' ? 'Settings saved.' : 'Could not save settings. Your current changes were kept.';
    const storedValue = kind === 'saved' ? value : current.getAttribute(STORED);
    const parsed = new t.window.DOMParser().parseFromString(JSON.stringify({ version: 'answer', categories, preferences: { [identity]: storedValue } }));
    const next = parsed.querySelector(`[data-settings-asset-category-preference="${identity}"]`);
    const event = current.dispatch(ANSWER, {
      detail: { form: current.querySelector('form'), region: current, parsed, next, kind, payload: new URLSearchParams({ [identity]: value }).toString() },
    });
    if (!event.defaultPrevented) {
      current.setAttribute(STORED, storedValue);
      current.querySelector('[data-region-version]').setAttribute('data-region-version', 'answer');
      if (kind !== 'saved') current.appendChild(new FakeNode('div', { role: 'alert' }));
    }
    return event;
  }

  // This page deletes 9; the read after it fails, so the list is stale and
  // Retry refresh (GET only) is offered.
  async function stale(t) {
    t.queue.post.push(async () => jsonResponse(200, deletedBody(EXPORTS)));
    t.queue.get.push(async () => ({ ok: false, status: 500, text: async () => '' }));
    t.confirmDelete('9');
    await flush();
    expect(settingsCategoryDeleteSync(t.document)).toBe('stale');
  }

  async function retry(t) {
    const read = deferred();
    t.queue.get.push(() => read.promise);
    t.feedbackButton('data-settings-category-delete-refresh-retry').click();
    await flush();
    expect(settingsCategoryDeleteSync(t.document)).toBe('refreshing');
    return read;
  }

  async function deliver(read, preferences, { categories = AFTER_DELETE, versionName = 'old' } = {}) {
    read.resolve(htmlResponse({ version: versionName, categories, preferences }));
    await flush();
  }

  for (const identity of BOTH) {
    it(`F9B-C1 / C2 / C3 / C4 / C5 / C6 / C7 / C8 — ${identity}: the read sent while S was saving, rendered with T, delivered after S is acknowledged, is not installed for that setting; S stays selected and stored; a later choice of T is a change`, async () => {
      const t = setup({ preferences: PREFS });
      enhanceSettingsCategoryDelete(t.document);
      await stale(t);
      const changes = track(t);
      choose(t, identity, 'sketches');
      const read = await retry(t);
      // C1: acknowledged while the read is in flight.
      expect(acknowledge(t, identity, 'sketches').defaultPrevented).toBe(false);
      expect(stored(t, identity)).toBe('sketches');
      changes.length = 0;
      await deliver(read, PREFS);
      expect(settingsCategoryDeleteSync(t.document)).toBe('idle');
      // C2 / C3 / C4 / C5: the acknowledged region stays.
      expect(version(t, identity)).toBe('answer');
      expect(select(t, identity).value).toBe('sketches');
      expect(stored(t, identity)).toBe('sketches');
      // C6: its own feedback stays; no other status is made up.
      expect(status(t, identity).textContent).toBe('Settings saved.');
      expect(form(t, identity).getAttribute('data-settings-fetch-save-state')).toBe('saved');
      // C7: nothing raised or saved; GET only.
      expect(changes).toEqual([]);
      expect(t.posts).toHaveLength(1);
      expect(t.gets).toHaveLength(2);
      expect(t.gets.every((get) => get.method === 'GET')).toBe(true);
      // The setting not saving took the read as rendered.
      const otherIdentity = BOTH.find((each) => each !== identity);
      expect(version(t, otherIdentity)).toBe('old');
      // C8: choosing T now is the person's own change.
      select(t, identity).value = 'final';
      select(t, identity).dispatch('change');
      expect(changes).toEqual([identity]);
    });
  }

  it('F9B-C9 — a read sent after the acknowledgement installs as rendered (another tab saved T since); the setting is not protected forever', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    await stale(t);
    choose(t, 'browser-default', 'sketches');
    acknowledge(t, 'browser-default', 'sketches');
    const read = await retry(t);
    await deliver(read, PREFS, { versionName: 'fresh' });
    expect(version(t, 'browser-default')).toBe('fresh');
    expect(stored(t, 'browser-default')).toBe('final');
    expect(select(t, 'browser-default').value).toBe('final');
    expect(t.posts).toHaveLength(1);
  });

  it('F9B-C10 — a read sent while saving but rendered after the save (S) shows S either way; no conflict and nothing sent', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    await stale(t);
    choose(t, 'browser-default', 'sketches');
    const read = await retry(t);
    acknowledge(t, 'browser-default', 'sketches');
    await deliver(read, { ...PREFS, 'browser-default': 'sketches' });
    expect(stored(t, 'browser-default')).toBe('sketches');
    expect(select(t, 'browser-default').value).toBe('sketches');
    // Current either way: the kept acknowledged region or the read's render.
    expect(['Settings saved.', '']).toContain(status(t, 'browser-default').textContent);
    expect(form(t, 'browser-default').getAttribute('aria-busy')).toBeNull();
    expect(t.posts).toHaveLength(1);
    expect(t.gets).toHaveLength(2);
  });

  it('F9B-C11 / C12 — a pending save is not acknowledged: the stored value stays T through the older read; then a current 422 stays a refusal', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    await stale(t);
    choose(t, 'browser-default', 'sketches');
    const read = await retry(t);
    await deliver(read, PREFS);
    // C12: still saving: the payload's value stays selected; stored stays T.
    expect(form(t, 'browser-default').getAttribute('aria-busy')).toBe('true');
    expect(select(t, 'browser-default').value).toBe('sketches');
    expect(stored(t, 'browser-default')).toBe('final');
    expect(status(t, 'browser-default').textContent).toBe('Saving settings.');
    // C11: the save is refused (422): installed as the server rendered it.
    expect(acknowledge(t, 'browser-default', 'sketches', { kind: 'refused' }).defaultPrevented).toBe(false);
    expect(stored(t, 'browser-default')).toBe('final');
    expect(form(t, 'browser-default').getAttribute('data-settings-fetch-save-state')).toBe('error');
    expect(form(t, 'browser-default').getAttribute('aria-busy')).toBeNull();
    expect(t.posts).toHaveLength(1);
  });

  it('F9B-C11b — a refusal acknowledged while the read is in flight stays a refusal through the older read', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    await stale(t);
    choose(t, 'browser-default', 'sketches');
    const read = await retry(t);
    acknowledge(t, 'browser-default', 'sketches', { kind: 'refused' });
    await deliver(read, PREFS);
    expect(version(t, 'browser-default')).toBe('answer');
    expect(form(t, 'browser-default').getAttribute('data-settings-fetch-save-state')).toBe('error');
    expect(status(t, 'browser-default').textContent).not.toBe('Settings saved.');
    expect(stored(t, 'browser-default')).toBe('final');
  });

  it('F9B-C13 — a dirty details draft is kept through the older read; nothing is saved', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    await stale(t);
    const name = t.row('3').querySelector('input[name="displayName"]');
    name.value = 'Final draft';
    choose(t, 'browser-default', 'sketches');
    const read = await retry(t);
    acknowledge(t, 'browser-default', 'sketches');
    const changes = track(t);
    await deliver(read, PREFS);
    expect(t.row('3').querySelector('input[name="displayName"]')).toBe(name);
    expect(name.value).toBe('Final draft');
    expect(stored(t, 'browser-default')).toBe('sketches');
    expect(changes).toEqual([]);
    expect(t.posts).toHaveLength(1);
  });

  it('F9B-C14 / R8 — two settings acknowledged in the other order each keep their own value; a setting saved only after the read was sent is kept by its own touch', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    await stale(t);
    choose(t, 'browser-default', 'sketches');
    const read = await retry(t);
    choose(t, 'preview-category', 'sketches');
    acknowledge(t, 'preview-category', 'sketches');
    // The browser setting is still saving its own choice.
    expect(form(t, 'browser-default').getAttribute('aria-busy')).toBe('true');
    expect(stored(t, 'browser-default')).toBe('final');
    acknowledge(t, 'browser-default', 'sketches');
    await deliver(read, PREFS);
    BOTH.forEach((identity) => {
      expect(version(t, identity)).toBe('answer');
      expect(stored(t, identity)).toBe('sketches');
      expect(select(t, identity).value).toBe('sketches');
      expect(status(t, identity).textContent).toBe('Settings saved.');
    });
  });

  it('F9B-C14b — one setting saving never protects the other: the untouched setting takes the read', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    await stale(t);
    choose(t, 'browser-default', 'sketches');
    const read = await retry(t);
    acknowledge(t, 'browser-default', 'sketches');
    await deliver(read, { ...PREFS, 'preview-category': 'sketches' });
    expect(version(t, 'browser-default')).toBe('answer');
    expect(version(t, 'preview-category')).toBe('old');
    expect(stored(t, 'preview-category')).toBe('sketches');
  });

  it('F9B-C15 / R6 — superseded: an older read delivered after a newer installed read restores nothing', async () => {
    const t = setup({ preferences: PREFS });
    const api = enhanceSettingsCategoryDelete(t.document);
    await stale(t);
    choose(t, 'browser-default', 'sketches');
    const older = await retry(t);
    acknowledge(t, 'browser-default', 'sketches');
    const newer = deferred();
    t.queue.get.push(() => newer.promise);
    void api.refresh();
    await flush();
    await deliver(newer, { ...PREFS, 'browser-default': 'sketches' }, { versionName: 'newer' });
    expect(version(t, 'browser-default')).toBe('newer');
    expect(stored(t, 'browser-default')).toBe('sketches');
    await deliver(older, PREFS);
    expect(version(t, 'browser-default')).toBe('newer');
    expect(stored(t, 'browser-default')).toBe('sketches');
    expect(select(t, 'browser-default').value).toBe('sketches');
    expect(t.gets).toHaveLength(3);
    expect(t.posts).toHaveLength(1);
  });

  it('F9B-C16 / R2 / R3 — a failed read while saving changes nothing; GET-only Retry after the acknowledgement installs as rendered', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    await stale(t);
    choose(t, 'browser-default', 'sketches');
    const failed = await retry(t);
    failed.resolve({ ok: false, status: 500, text: async () => '' });
    await flush();
    expect(settingsCategoryDeleteSync(t.document)).toBe('stale');
    acknowledge(t, 'browser-default', 'sketches');
    expect(stored(t, 'browser-default')).toBe('sketches');
    const read = await retry(t);
    await deliver(read, { ...PREFS, 'browser-default': 'sketches' }, { versionName: 'fresh' });
    expect(version(t, 'browser-default')).toBe('fresh');
    expect(stored(t, 'browser-default')).toBe('sketches');
    expect(t.gets).toHaveLength(3);
    expect(t.gets.every((get) => get.method === 'GET')).toBe(true);
    expect(t.posts).toHaveLength(1);
  });

  it('F9B-C17 / C19 / R9 — the kept region still follows the installed list for what can be chosen; the saved value is not evidence of eligibility', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    await stale(t);
    choose(t, 'browser-default', 'sketches');
    const read = await retry(t);
    acknowledge(t, 'browser-default', 'final');
    // The read shows Sketches disabled (elsewhere, after the save rendered).
    await deliver(read, PREFS, { categories: [FINAL, { ...SKETCHES, enabled: false }] });
    expect(version(t, 'browser-default')).toBe('answer');
    expect(t.row('7').getAttribute('data-category-enabled')).toBe('false');
    expect(offered(t, 'browser-default')).not.toContain('sketches');
    expect(offered(t, 'browser-default')).toContain('final');
    expect(stored(t, 'browser-default')).toBe('final');
    expect(t.posts).toHaveLength(1);
  });

  it('F9B-C17b — F9A kept: an older answer with a CURRENT id is still vetoed after a newer installed read showed it disabled', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    await stale(t);
    choose(t, 'browser-default', 'sketches');
    const read = await retry(t);
    await deliver(read, PREFS, { categories: [FINAL, { ...SKETCHES, enabled: false }] });
    const refreshRead = deferred();
    t.queue.get.push(() => refreshRead.promise);
    expect(acknowledge(t, 'browser-default', 'sketches').defaultPrevented).toBe(true);
    await flush();
    expect(offered(t, 'browser-default')).not.toContain('sketches');
    expect(status(t, 'browser-default').textContent).toBe(M.preferenceSavedDisabled);
    expect(stored(t, 'browser-default')).toBe('sketches');
    // Its GET was sent after the answer: it installs the server's display.
    await deliver(refreshRead, { ...PREFS, 'browser-default': 'sketches' }, { categories: [FINAL, { ...SKETCHES, enabled: false }], versionName: 'after' });
    expect(version(t, 'browser-default')).toBe('after');
    expect(t.posts).toHaveLength(1);
  });

  it('F9B-C18 — binding twice keeps one listener set: one Retry sends one GET and the outcome is the same', async () => {
    const t = setup({ preferences: PREFS });
    const first = enhanceSettingsCategoryDelete(t.document);
    expect(enhanceSettingsCategoryDelete(t.document)).toBe(first);
    await stale(t);
    choose(t, 'browser-default', 'sketches');
    const read = await retry(t);
    expect(t.gets).toHaveLength(2);
    acknowledge(t, 'browser-default', 'sketches');
    await deliver(read, PREFS);
    expect(stored(t, 'browser-default')).toBe('sketches');
    expect(t.gets).toHaveLength(2);
  });

  it('F9B-C20 — F2 kept: an answer still listing the deleted default is vetoed; the read sent while saving keeps the vetoed region', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    await stale(t);
    choose(t, 'browser-default', 'sketches');
    const read = await retry(t);
    expect(acknowledge(t, 'browser-default', 'sketches', { categories: CATEGORIES }).defaultPrevented).toBe(true);
    expect(stored(t, 'browser-default')).toBe('sketches');
    await deliver(read, PREFS);
    expect(stored(t, 'browser-default')).toBe('sketches');
    expect(select(t, 'browser-default').value).toBe('sketches');
    expect(offered(t, 'browser-default')).not.toContain('exports');
    expect(t.posts).toHaveLength(1);
  });
});

describe('WP11C-F10 — a kept dirty details form never overrides the installed list\'s current identity', () => {
  const ANSWER = 'creatorcrate:asset-category-preference-answer';
  const region = (t, identity) => t.page.root.querySelector(`[data-settings-asset-category-preference="${identity}"]`);
  const select = (t, identity) => region(t, identity).querySelector('select');
  const option = (t, identity, value) => select(t, identity).options.find((candidate) => candidate.value === value) || null;
  const offered = (t, identity) => select(t, identity).options.filter((candidate) => !candidate.disabled).map((candidate) => candidate.value);
  const radios = (t, identity) => region(t, identity).querySelectorAll('details[data-cc-dropdown] input').filter((radio) => !radio.disabled).map((radio) => radio.value);
  const status = (t, identity) => region(t, identity).querySelector('[data-settings-fetch-save-status]');
  const stored = (t, identity) => region(t, identity).getAttribute('data-settings-asset-category-preference-stored');
  const version = (t, identity) => region(t, identity).querySelector('[data-region-version]')?.getAttribute('data-region-version');
  const reviewed = (t, id) => Object.fromEntries(t.row(id).querySelectorAll('input[data-category-details-reviewed]')
    .map((field) => [field.getAttribute('data-category-details-reviewed'), field.value]));
  const seen = (t, id) => t.document.__creatorCrateSettingsCategoryDelete.seen.get(id);
  const BOTH = ['browser-default', 'preview-category'];
  const PREFS = { 'browser-default': 'final', 'preview-category': '__disabled__' };
  const [FINAL, , EXPORTS] = CATEGORIES;
  // X (7) renamed elsewhere from "sketches" to "beta".
  const RENAMED = { id: '7', name: 'Renamed elsewhere', slug: 'beta' };

  function answer(t, identity, { categories, value = 'sketches', kind = 'saved', storedValue = kind === 'saved' ? value : PREFS[identity] } = {}) {
    const parsed = new t.window.DOMParser().parseFromString(JSON.stringify({ version: 'answer', categories, preferences: { [identity]: storedValue } }));
    const next = parsed.querySelector(`[data-settings-asset-category-preference="${identity}"]`);
    const current = region(t, identity);
    return current.dispatch(ANSWER, {
      detail: { form: current.querySelector('form'), region: current, parsed, next, kind, payload: new URLSearchParams({ [identity]: value }).toString() },
    });
  }

  function choose(t, identity, value) {
    select(t, identity).value = value;
    select(t, identity).dispatch('change');
    region(t, identity).querySelector('form').setAttribute('aria-busy', 'true');
    region(t, identity).querySelector('form').setAttribute('data-settings-fetch-save-state', 'pending');
    status(t, identity).textContent = 'Saving settings.';
  }

  function settle(t, identity, kind = 'saved') {
    const form = region(t, identity).querySelector('form');
    form.removeAttribute('aria-busy');
    form.setAttribute('data-settings-fetch-save-state', kind === 'saved' ? 'saved' : 'error');
    status(t, identity).textContent = kind === 'saved' ? 'Settings saved.' : 'Could not save settings. Your current changes were kept.';
  }

  function track(t) {
    const changes = [];
    t.page.root.addEventListener('change', (event) => changes.push(event.target.name), true);
    return changes;
  }

  // The person types in 7's name and stays there (a dirty, kept form).
  function draft(t, text = 'Sketches private draft') {
    const field = t.row('7').querySelector('input[name="displayName"]');
    field.focus();
    field.value = text;
    field.dispatch('input');
    return field;
  }

  // A details answer this page installs for `id` (category-details.js
  // replaces the form's markup): new reviewed fields, from the database row.
  function detailsAnswer(t, id, { name, slug }) {
    const form = t.row(id).querySelector('form[data-category-details-form]');
    form.querySelectorAll('input[data-category-details-reviewed]').forEach((field) => {
      const kind = field.getAttribute('data-category-details-reviewed');
      field.replaceWith(input({ type: 'hidden', name: field.name, 'data-category-details-reviewed': kind }, kind === 'displayName' ? name : slug));
    });
  }

  async function deleteHeldThenChoose(t, identity, value = 'sketches') {
    const post = deferred();
    t.queue.post.push(() => post.promise);
    const read = deferred();
    t.queue.get.push(() => read.promise);
    t.confirmDelete('9');
    await flush();
    if (identity) choose(t, identity, value);
    return { post, read };
  }

  async function answerDelete(post) {
    post.resolve(jsonResponse(200, deletedBody(EXPORTS)));
    await flush();
  }

  async function install(read, categories, versionName = 'fresh', preferences = PREFS) {
    read.resolve(htmlResponse({ version: versionName, categories, preferences }));
    await flush();
  }

  for (const identity of BOTH) {
    it(`F10-C1..C9 / C19 — ${identity}: the reviewer's order — S saved, 7 kept dirty, renamed to beta elsewhere, the Delete's read installs beta, the older answer arrives: S is not choosable, no "Settings saved.", the draft and its witnesses stay, nothing is saved`, async () => {
      const t = setup({ preferences: PREFS });
      enhanceSettingsCategoryDelete(t.document);
      const changes = track(t);
      const { post, read } = await deleteHeldThenChoose(t, identity);
      const field = draft(t);
      await answerDelete(post);
      await install(read, [FINAL, RENAMED]);
      // C1: the dirty form is kept inside the read's row; the row is current.
      expect(t.row('7').querySelector('input[name="displayName"]')).toBe(field);
      expect(t.row('7').getAttribute('data-category-slug')).toBe('beta');
      expect(seen(t, '7').slug).toBe('beta');
      expect([...seen(t, '7').slugs]).toEqual(expect.arrayContaining(['sketches', 'beta']));
      settle(t, identity);
      changes.length = 0;
      expect(answer(t, identity, { categories: CATEGORIES }).defaultPrevented).toBe(true);
      await flush();
      // C2 / C3 / C4: the old slug is not choosable in either control.
      BOTH.forEach((each) => {
        expect(offered(t, each)).not.toContain('sketches');
        expect(radios(t, each)).not.toContain('sketches');
      });
      expect(option(t, identity, 'sketches').disabled).toBe(true);
      // C5: truthful status; the stored slug is kept (never reassigned).
      expect(status(t, identity).textContent).toBe(M.preferenceSavedUnavailable);
      expect(stored(t, identity)).toBe('sketches');
      expect(offered(t, identity)).toContain('final');
      // C6 / C7: the draft and its review basis are exactly as they were.
      expect(field.value).toBe('Sketches private draft');
      expect(field.defaultValue).toBe('Sketches');
      expect(reviewed(t, '7')).toEqual({ displayName: 'Sketches', directorySlug: 'sketches' });
      // C8 / C9: nothing raised or saved; one GET re-reads the display.
      expect(changes).toEqual([]);
      expect(t.posts).toHaveLength(1);
      expect(t.gets).toHaveLength(2);
      expect(t.gets.every((get) => get.method === 'GET')).toBe(true);
      // C19: the other setting was untouched and took the read as rendered.
      expect(version(t, BOTH.find((each) => each !== identity))).toBe('fresh');
    });

    it(`F10-C13 — ${identity}: a NEW disabled default takes the old slug; the kept form of 7 cannot make it choosable; the status says disabled`, async () => {
      const t = setup({ preferences: PREFS });
      enhanceSettingsCategoryDelete(t.document);
      const { post, read } = await deleteHeldThenChoose(t, identity);
      draft(t);
      await answerDelete(post);
      await install(read, [FINAL, RENAMED, { id: '12', name: 'Reborn', slug: 'sketches', enabled: false }]);
      settle(t, identity);
      expect(answer(t, identity, { categories: CATEGORIES }).defaultPrevented).toBe(true);
      expect(t.row('12').getAttribute('data-category-enabled')).toBe('false');
      expect(offered(t, identity)).not.toContain('sketches');
      expect(status(t, identity).textContent).toBe(M.preferenceSavedDisabled);
      expect(t.posts).toHaveLength(1);
    });
  }

  it('F10-C10 / C14 — no Delete at all: an older answer (7 still "sketches") after a read installed 7 as "beta" is obsolete although the kept form still says "sketches"', async () => {
    const t = setup({ preferences: PREFS });
    const controller = enhanceSettingsCategoryDelete(t.document);
    choose(t, 'browser-default', 'sketches');
    const field = draft(t);
    const read = deferred();
    t.queue.get.push(() => read.promise);
    void controller.refresh();
    await install(read, [FINAL, RENAMED, EXPORTS]);
    settle(t, 'browser-default');
    expect(answer(t, 'browser-default', { categories: CATEGORIES }).defaultPrevented).toBe(true);
    expect(offered(t, 'browser-default')).not.toContain('sketches');
    expect(status(t, 'browser-default').textContent).toBe(M.preferenceSavedUnavailable);
    expect(field.value).toBe('Sketches private draft');
    expect(reviewed(t, '7').directorySlug).toBe('sketches');
    expect(t.posts).toHaveLength(0);
  });

  it('F10-C11 — X deleted elsewhere while its form is kept dirty: it is gone and its slugs stay unavailable', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    const { post, read } = await deleteHeldThenChoose(t, 'browser-default');
    draft(t);
    await answerDelete(post);
    await install(read, [FINAL]);
    settle(t, 'browser-default');
    expect(answer(t, 'browser-default', { categories: CATEGORIES }).defaultPrevented).toBe(true);
    expect(t.row('7')).toBeNull();
    expect(offered(t, 'browser-default')).not.toContain('sketches');
    expect(status(t, 'browser-default').textContent).toBe(M.preferenceSavedUnavailable);
    expect(t.posts).toHaveLength(1);
  });

  it('F10-C12 — a NEW enabled default takes the old slug: it stays choosable under its own id and name, 7 is not resurrected, nothing more is read or saved', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    const { post, read } = await deleteHeldThenChoose(t, 'browser-default');
    const field = draft(t);
    await answerDelete(post);
    await install(read, [FINAL, RENAMED, { id: '12', name: 'Reborn', slug: 'sketches' }]);
    settle(t, 'browser-default');
    expect(answer(t, 'browser-default', { categories: CATEGORIES }).defaultPrevented).toBe(true);
    expect(offered(t, 'browser-default')).toContain('sketches');
    expect(option(t, 'browser-default', 'sketches').textContent).toBe('Reborn');
    expect(status(t, 'browser-default').textContent).toBe('Settings saved.');
    expect(t.row('7').getAttribute('data-category-slug')).toBe('beta');
    expect(field.value).toBe('Sketches private draft');
    expect(t.posts).toHaveLength(1);
    expect(t.gets).toHaveLength(1);
  });

  it('F10-C15 — a stale 409 installed after the read carries the current saved details: the refused draft is not learned, its new witnesses match the read', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    const { post, read } = await deleteHeldThenChoose(t, 'browser-default');
    const field = draft(t, 'Refused draft');
    await answerDelete(post);
    await install(read, [FINAL, RENAMED]);
    // This page's Save was refused stale: the answer's witnesses are the database row.
    detailsAnswer(t, '7', { name: 'Renamed elsewhere', slug: 'beta' });
    settle(t, 'browser-default');
    answer(t, 'browser-default', { categories: CATEGORIES });
    expect(offered(t, 'browser-default')).not.toContain('sketches');
    expect(seen(t, '7').slugs.has('Refused draft')).toBe(false);
    expect(field.value).toBe('Refused draft');
    expect(reviewed(t, '7')).toEqual({ displayName: 'Renamed elsewhere', directorySlug: 'beta' });
    expect(t.posts).toHaveLength(1);
  });

  it('F10-C16 / C17 — a local rename acknowledged after the read was sent beats that older read; a read sent after it wins again', async () => {
    const t = setup({ preferences: PREFS });
    const controller = enhanceSettingsCategoryDelete(t.document);
    choose(t, 'browser-default', 'final');
    const read = deferred();
    t.queue.get.push(() => read.promise);
    void controller.refresh();
    // This page's own Save of 7 as "mine" is acknowledged while the read is out.
    detailsAnswer(t, '7', { name: 'Mine', slug: 'mine' });
    draft(t, 'Mine and more');
    // The read was rendered before that Save: 7 is still "sketches".
    await install(read, CATEGORIES);
    expect(t.row('7').getAttribute('data-category-slug')).toBe('sketches');
    expect(seen(t, '7').slug).toBe('mine');
    // C16: "sketches" is the old slug now, withdrawn from the kept setting.
    expect(option(t, 'browser-default', 'sketches')).toBeNull();
    // C17: a later read (sent after the acknowledgement) shows 7 renamed again elsewhere.
    settle(t, 'browser-default');
    const later = deferred();
    t.queue.get.push(() => later.promise);
    void controller.refresh();
    await install(later, [FINAL, RENAMED, EXPORTS]);
    expect(seen(t, '7').slug).toBe('beta');
    expect([...seen(t, '7').slugs]).toEqual(expect.arrayContaining(['sketches', 'mine', 'beta']));
    expect(reviewed(t, '7')).toEqual({ displayName: 'Mine', directorySlug: 'mine' });
    expect(t.posts).toHaveLength(0);
  });

  it('F10-C17b — a superseded older read delivered after a newer installed read changes nothing', async () => {
    const t = setup({ preferences: PREFS });
    const controller = enhanceSettingsCategoryDelete(t.document);
    choose(t, 'browser-default', 'sketches');
    draft(t);
    const older = deferred();
    t.queue.get.push(() => older.promise);
    void controller.refresh();
    const newer = deferred();
    t.queue.get.push(() => newer.promise);
    void controller.refresh();
    await install(newer, [FINAL, RENAMED, EXPORTS], 'newer');
    await install(older, CATEGORIES, 'older');
    expect(t.row('7').getAttribute('data-category-slug')).toBe('beta');
    expect(seen(t, '7').slug).toBe('beta');
    settle(t, 'browser-default');
    expect(answer(t, 'browser-default', { categories: CATEGORIES }).defaultPrevented).toBe(true);
    expect(offered(t, 'browser-default')).not.toContain('sketches');
  });

  it('F10-C18 — a failed read observes nothing (the kept form is still the newest evidence); GET-only Retry then installs beta', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    const post = deferred();
    t.queue.post.push(() => post.promise);
    t.queue.get.push(async () => ({ ok: false, status: 500, text: async () => '' }));
    t.confirmDelete('9');
    await flush();
    choose(t, 'browser-default', 'sketches');
    draft(t);
    await answerDelete(post);
    expect(settingsCategoryDeleteSync(t.document)).toBe('stale');
    expect(seen(t, '7').slug).toBe('sketches');
    const retry = deferred();
    t.queue.get.push(() => retry.promise);
    t.feedbackButton('data-settings-category-delete-refresh-retry').click();
    await install(retry, [FINAL, RENAMED], 'retried');
    expect(settingsCategoryDeleteSync(t.document)).toBe('idle');
    settle(t, 'browser-default');
    expect(answer(t, 'browser-default', { categories: CATEGORIES }).defaultPrevented).toBe(true);
    expect(offered(t, 'browser-default')).not.toContain('sketches');
    expect(t.posts).toHaveLength(1);
    expect(t.gets.every((get) => get.method === 'GET')).toBe(true);
  });

  // WP11C-A: category-details.js reports when 7's save request is sent and
  // when its answer is installed; the answer's reviewed fields are new nodes.
  const lifecycle = (t) => detailsLifecycles.get(t.document);
  const detailsForm = (t, id) => t.row(id).querySelector('form[data-category-details-form]');
  const startSave = (t, id = '7') => lifecycle(t).requestStarted(detailsForm(t, id));
  function installAnswer(t, started, identity, id = '7') {
    detailsAnswer(t, id, identity);
    lifecycle(t).answerInstalled(detailsForm(t, id), started);
  }
  const GAMMA = { id: '7', name: 'Sketches', slug: 'gamma' };
  const BETA_LIST = [FINAL, { id: '7', name: 'Sketches', slug: 'beta' }, EXPORTS];

  for (const identity of BOTH) {
    it(`A-C1 — ${identity}: original P2 — 7's save (sketches → beta) sent; a read installs gamma; the older beta answer is installed last: gamma stays the identity, one GET re-reads, the setting's beta answer is vetoed`, async () => {
      const t = setup({ preferences: PREFS });
      const controller = enhanceSettingsCategoryDelete(t.document);
      choose(t, identity, 'final');
      const started = startSave(t);
      const read = deferred();
      t.queue.get.push(() => read.promise);
      void controller.refresh();
      await install(read, [FINAL, GAMMA, EXPORTS]);
      expect(t.gets).toHaveLength(1);
      // The answer was rendered with beta; it settles its own form only.
      installAnswer(t, started, { name: 'Sketches', slug: 'beta' });
      await flush();
      expect(reviewed(t, '7')).toEqual({ displayName: 'Sketches', directorySlug: 'beta' });
      expect(t.row('7').getAttribute('data-category-slug')).toBe('gamma');
      expect(seen(t, '7').slug).toBe('gamma');
      // One GET-only refresh, sent after both, resolves which is current.
      expect(t.gets).toHaveLength(2);
      expect(t.gets.every((get) => get.method === 'GET')).toBe(true);
      // The setting's answer (rendered with beta current) is older than the list.
      settle(t, identity);
      expect(answer(t, identity, { categories: BETA_LIST, value: 'beta' }).defaultPrevented).toBe(true);
      BOTH.forEach((each) => {
        expect(offered(t, each)).not.toContain('beta');
        expect(radios(t, each)).not.toContain('beta');
      });
      expect(status(t, identity).textContent).not.toBe('Settings saved.');
      expect(t.posts).toHaveLength(0);
    });
  }

  it('A-C2 / D — inverse order: a save sent after the read installed is newer: its beta answer is the identity, no GET, its answer is not vetoed', async () => {
    const t = setup({ preferences: PREFS });
    const controller = enhanceSettingsCategoryDelete(t.document);
    const read = deferred();
    t.queue.get.push(() => read.promise);
    void controller.refresh();
    await install(read, [FINAL, GAMMA, EXPORTS]);
    choose(t, 'browser-default', 'final');
    const started = startSave(t);
    installAnswer(t, started, { name: 'Sketches', slug: 'beta' });
    await flush();
    expect(t.gets).toHaveLength(1);
    settle(t, 'browser-default');
    expect(answer(t, 'browser-default', { categories: BETA_LIST, value: 'final' }).defaultPrevented).toBe(false);
    expect(t.posts).toHaveLength(0);
  });

  it('A-C3 / E — a genuinely later read after the confirmed save establishes the server\'s latest identity', async () => {
    const t = setup({ preferences: PREFS });
    const controller = enhanceSettingsCategoryDelete(t.document);
    installAnswer(t, startSave(t), { name: 'Sketches', slug: 'beta' });
    await flush();
    expect(t.gets).toHaveLength(0);
    choose(t, 'browser-default', 'final');
    const later = deferred();
    t.queue.get.push(() => later.promise);
    void controller.refresh();
    await install(later, [FINAL, { id: '7', name: 'Delta', slug: 'delta' }, EXPORTS]);
    expect(seen(t, '7').slug).toBe('delta');
    expect([...seen(t, '7').slugs]).toEqual(expect.arrayContaining(['sketches', 'beta', 'delta']));
    settle(t, 'browser-default');
    expect(answer(t, 'browser-default', { categories: BETA_LIST, value: 'final' }).defaultPrevented).toBe(true);
    await flush();
    expect(offered(t, 'browser-default')).not.toContain('beta');
    // The refresh, then the vetoed answer's own GET (F9A): reads only.
    expect(t.gets).toHaveLength(2);
  });

  it('A-C4 / F — refusals: a refused answer installed after the read never promotes the draft; witnesses matching the read need no GET; older witnesses get one', async () => {
    const t = setup({ preferences: PREFS });
    const controller = enhanceSettingsCategoryDelete(t.document);
    const field = draft(t, 'Refused draft');
    const started = startSave(t);
    const read = deferred();
    t.queue.get.push(() => read.promise);
    void controller.refresh();
    await install(read, [FINAL, GAMMA, EXPORTS]);
    // A stale 409 (or 422) renders the database row now: gamma, as the read.
    detailsForm(t, '7').setAttribute('data-category-details-state', 'error');
    installAnswer(t, started, { name: 'Sketches', slug: 'gamma' });
    await flush();
    expect(t.gets).toHaveLength(1);
    expect(field.value).toBe('Refused draft');
    expect(seen(t, '7').slugs.has('Refused draft')).toBe(false);
    // A refusal rendered before the next read (still sketches): one GET, the read stays current.
    const again = startSave(t);
    const second = deferred();
    t.queue.get.push(() => second.promise);
    void controller.refresh();
    await install(second, [FINAL, GAMMA, EXPORTS], 'second');
    installAnswer(t, again, { name: 'Sketches', slug: 'sketches' });
    await flush();
    expect(t.gets).toHaveLength(3);
    expect(t.row('7').getAttribute('data-category-slug')).toBe('gamma');
    expect(field.value).toBe('Refused draft');
    expect(t.posts).toHaveLength(0);
  });

  it('A-C5 / G — a dirty draft and the answer\'s witnesses survive the reconciling GET; the read stays the identity', async () => {
    const t = setup({ preferences: PREFS });
    const controller = enhanceSettingsCategoryDelete(t.document);
    const changes = track(t);
    const started = startSave(t);
    const read = deferred();
    t.queue.get.push(() => read.promise);
    void controller.refresh();
    await install(read, [FINAL, GAMMA, EXPORTS]);
    const field = draft(t, 'Sketches newer draft');
    const reconcile = deferred();
    t.queue.get.push(() => reconcile.promise);
    installAnswer(t, started, { name: 'Sketches', slug: 'beta' });
    await flush();
    expect(t.gets).toHaveLength(2);
    await install(reconcile, [FINAL, GAMMA, EXPORTS], 'reconciled');
    expect(t.row('7').querySelector('input[name="displayName"]')).toBe(field);
    expect(field.value).toBe('Sketches newer draft');
    expect(reviewed(t, '7')).toEqual({ displayName: 'Sketches', directorySlug: 'beta' });
    expect(t.row('7').getAttribute('data-category-slug')).toBe('gamma');
    expect(seen(t, '7').slug).toBe('gamma');
    expect(changes).toEqual([]);
    expect(t.posts).toHaveLength(0);
  });

  it('A-C7 — the reconciling GET confirms the answer (the read before it was older): the answered form stays with its status and becomes the identity again; a changed enabled state is not kept', async () => {
    const t = setup({ preferences: PREFS });
    const controller = enhanceSettingsCategoryDelete(t.document);
    const started = startSave(t);
    const read = deferred();
    t.queue.get.push(() => read.promise);
    void controller.refresh();
    await install(read, CATEGORIES);
    const reconcile = deferred();
    t.queue.get.push(() => reconcile.promise);
    installAnswer(t, started, { name: 'Sketches', slug: 'beta' });
    const answered = detailsForm(t, '7');
    answered.setAttribute('data-category-details-state', 'saved');
    await flush();
    expect(t.gets).toHaveLength(2);
    await install(reconcile, BETA_LIST, 'reconciled');
    expect(detailsForm(t, '7')).toBe(answered);
    expect(answered.getAttribute('data-category-details-state')).toBe('saved');
    expect(t.row('7').getAttribute('data-category-slug')).toBe('beta');
    expect(seen(t, '7').slug).toBe('beta');
    // Another ambiguous answer whose confirming read also shows 7 disabled: the read's body is installed.
    const again = startSave(t);
    const next = deferred();
    t.queue.get.push(() => next.promise);
    void controller.refresh();
    await install(next, [FINAL, GAMMA, EXPORTS], 'gamma');
    const second = deferred();
    t.queue.get.push(() => second.promise);
    installAnswer(t, again, { name: 'Sketches', slug: 'delta' });
    const stale = detailsForm(t, '7');
    await flush();
    await install(second, [FINAL, { id: '7', name: 'Sketches', slug: 'delta', enabled: false }, EXPORTS], 'disabled');
    expect(detailsForm(t, '7')).not.toBe(stale);
    expect(t.row('7').getAttribute('data-category-enabled')).toBe('false');
    expect(t.posts).toHaveLength(0);
  });

  it('A-C6 — no token, or no read installed since the request: nothing is read and the answer stays the identity (F10)', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    installAnswer(t, null, { name: 'Sketches', slug: 'beta' });
    installAnswer(t, startSave(t), { name: 'Sketches', slug: 'beta' });
    await flush();
    expect(t.gets).toHaveLength(0);
    expect(t.posts).toHaveLength(0);
  });

  it('F10-C20 — binding twice keeps one listener set: one vetoed answer starts exactly one GET', async () => {
    const t = setup({ preferences: PREFS });
    const first = enhanceSettingsCategoryDelete(t.document);
    expect(enhanceSettingsCategoryDelete(t.document)).toBe(first);
    const { post, read } = await deleteHeldThenChoose(t, 'browser-default');
    draft(t);
    await answerDelete(post);
    await install(read, [FINAL, RENAMED]);
    settle(t, 'browser-default');
    const before = t.gets.length;
    answer(t, 'browser-default', { categories: CATEGORIES });
    await flush();
    expect(t.gets.length).toBe(before + 1);
    expect(t.posts).toHaveLength(1);
  });
});

describe('WP11C-F11 — a Defaults save settled without a readable answer follows the installed list', () => {
  const ANSWER = 'creatorcrate:asset-category-preference-answer';
  const SETTLED = 'creatorcrate:asset-category-preference-settled';
  const region = (t, identity) => t.page.root.querySelector(`[data-settings-asset-category-preference="${identity}"]`);
  const form = (t, identity) => region(t, identity).querySelector('form');
  const select = (t, identity) => region(t, identity).querySelector('select');
  const option = (t, identity, value) => select(t, identity).options.find((candidate) => candidate.value === value) || null;
  const offered = (t, identity) => select(t, identity).options.filter((candidate) => !candidate.disabled).map((candidate) => candidate.value);
  const offeredLabels = (t, identity) => select(t, identity).options.filter((candidate) => !candidate.disabled).map((candidate) => candidate.textContent);
  const radios = (t, identity) => region(t, identity).querySelectorAll('details[data-cc-dropdown] input').filter((radio) => !radio.disabled).map((radio) => radio.value);
  const status = (t, identity) => region(t, identity).querySelector('[data-settings-fetch-save-status]');
  const stored = (t, identity) => region(t, identity).getAttribute('data-settings-asset-category-preference-stored');
  const BOTH = ['browser-default', 'preview-category'];
  const PREFS = { 'browser-default': 'final', 'preview-category': '__disabled__' };
  const [FINAL, SKETCHES] = CATEGORIES;
  const reborn = (enabled, slug = 'sketches', name = 'Reborn') => ({ id: '12', name, slug, enabled });
  const NOT_SAVED = 'Could not save settings. Your current changes were kept.';

  function choose(t, identity, value) {
    select(t, identity).value = value;
    select(t, identity).dispatch('change');
    form(t, identity).setAttribute('aria-busy', 'true');
    form(t, identity).setAttribute('data-settings-fetch-save-state', 'pending');
    status(t, identity).textContent = 'Saving settings.';
  }

  // As settings-fetch-save settles a save with no answer installed (lost or
  // unreadable: uncertain; a refusal not installed: not uncertain): the form
  // leaves aria-busy with fetch-save's error, then the module announces it.
  function settleWithoutAnswer(t, identity, { uncertain = true, busy = false } = {}) {
    const current = form(t, identity);
    if (!busy) current.removeAttribute('aria-busy');
    current.setAttribute('data-settings-fetch-save-state', busy ? 'pending' : 'error');
    if (!busy) status(t, identity).textContent = NOT_SAVED;
    return region(t, identity).dispatch(SETTLED, { detail: { form: current, region: region(t, identity), uncertain } });
  }

  function answer(t, identity, { categories, value = 'sketches', kind = 'saved' } = {}) {
    const parsed = new t.window.DOMParser().parseFromString(JSON.stringify({ version: 'answer', categories, preferences: { [identity]: kind === 'saved' ? value : PREFS[identity] } }));
    const next = parsed.querySelector(`[data-settings-asset-category-preference="${identity}"]`);
    const current = region(t, identity);
    return current.dispatch(ANSWER, {
      detail: { form: current.querySelector('form'), region: current, parsed, next, kind, payload: new URLSearchParams({ [identity]: value }).toString() },
    });
  }

  function track(t) {
    const changes = [];
    t.page.root.addEventListener('change', (event) => changes.push(event.target.name), true);
    return changes;
  }

  // This page deletes 9 with its POST held; the preference is chosen (its
  // save in flight); the Delete answers and its list read (GET) is held.
  async function deleteHeldThenChoose(t, identities, value = 'sketches') {
    const post = deferred();
    t.queue.post.push(() => post.promise);
    const read = deferred();
    t.queue.get.push(() => read.promise);
    t.confirmDelete('9');
    await flush();
    [identities].flat().filter(Boolean).forEach((identity) => choose(t, identity, value));
    post.resolve(jsonResponse(200, deletedBody(CATEGORIES[2])));
    await flush();
    expect(settingsCategoryDeleteState(t.document, '9').phase).toBe('deleted');
    return read;
  }

  async function install(read, categories, versionName = 'fresh', preferences = PREFS) {
    read.resolve(htmlResponse({ version: versionName, categories, preferences }));
    await flush();
  }

  for (const identity of BOTH) {
    for (const [change, installed, message] of [
      ['deleted', [FINAL], 'preferenceUnconfirmedUnavailable'],
      ['disabled', [FINAL, { ...SKETCHES, enabled: false }], 'preferenceUnconfirmedDisabled'],
    ]) {
      it(`F11-C${change === 'deleted' ? 1 : 2} / C3 / C4 / C5 / C6 / C7 / C${identity === 'browser-default' ? 8 : 9} / C10 / C11 / C12 / C13 — ${identity}: S ${change} by the installed read while its save is pending; the answer is lost: S is withdrawn once it settles, the status is uncertain, the stored value is kept, nothing is sent`, async () => {
        const t = setup({ preferences: PREFS });
        enhanceSettingsCategoryDelete(t.document);
        const changes = track(t);
        const read = await deleteHeldThenChoose(t, identity);
        await install(read, installed);
        // C3 / C6: pending through the install: the save's selected option is
        // its payload and stays enabled, not withdrawn.
        expect(form(t, identity).getAttribute('aria-busy')).toBe('true');
        expect(select(t, identity).value).toBe('sketches');
        expect(option(t, identity, 'sketches').disabled).toBe(false);
        expect(option(t, identity, 'sketches').hasAttribute('data-settings-category-withdrawn')).toBe(false);
        changes.length = 0;
        const gets = t.gets.length;

        settleWithoutAnswer(t, identity);
        // C7 / C8 / C9: withdrawn natively and in the dropdown, still selected.
        expect(offered(t, identity)).not.toContain('sketches');
        expect(radios(t, identity)).not.toContain('sketches');
        expect(option(t, identity, 'sketches').selected).toBe(true);
        expect(option(t, identity, 'sketches').hasAttribute('data-settings-category-withdrawn')).toBe(true);
        expect(offered(t, identity)).toContain('final');
        expect(radios(t, identity)).toContain('final');
        // C10 / C11 / C13: no saved or refused claim; the baseline is the last acknowledged one.
        expect(status(t, identity).textContent).toBe(M[message]);
        expect(status(t, identity).textContent).not.toBe('Settings saved.');
        expect(stored(t, identity)).toBe(PREFS[identity]);
        expect(form(t, identity).getAttribute('data-settings-fetch-save-state')).toBe('error');
        // C12: nothing raised, saved, read or retried.
        expect(changes).toEqual([]);
        expect(t.posts).toHaveLength(1);
        expect(t.gets).toHaveLength(gets);
        // The other setting (installed as rendered) does not offer S either.
        const other = BOTH.find((each) => each !== identity);
        expect(offered(t, other)).not.toContain('sketches');
      });
    }
  }

  it('F11-C6 — a settlement while a queued save already owns the form (still busy) changes nothing; its own settlement then reconciles', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    const read = await deleteHeldThenChoose(t, 'browser-default');
    await install(read, [FINAL, { ...SKETCHES, enabled: false }]);
    settleWithoutAnswer(t, 'browser-default', { busy: true });
    expect(option(t, 'browser-default', 'sketches').disabled).toBe(false);
    expect(status(t, 'browser-default').textContent).toBe('Saving settings.');
    settleWithoutAnswer(t, 'browser-default');
    expect(option(t, 'browser-default', 'sketches').disabled).toBe(true);
  });

  it('F11-C14 — a refusal that was not installed (vetoed or superseded) is not uncertain: S is withdrawn and fetch-save\'s refusal wording stays', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    const read = await deleteHeldThenChoose(t, 'preview-category');
    await install(read, [FINAL, { ...SKETCHES, enabled: false }]);
    settleWithoutAnswer(t, 'preview-category', { uncertain: false });
    expect(offered(t, 'preview-category')).not.toContain('sketches');
    expect(status(t, 'preview-category').textContent).toBe(NOT_SAVED);
    expect(stored(t, 'preview-category')).toBe('__disabled__');
  });

  it('F11-C15 — both settings: only the browser answer lost, the preview still saving keeps its payload; then the preview is lost too; each settles on its own', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    const read = await deleteHeldThenChoose(t, BOTH);
    await install(read, [FINAL, { ...SKETCHES, enabled: false }]);
    settleWithoutAnswer(t, 'browser-default');
    expect(offered(t, 'browser-default')).not.toContain('sketches');
    expect(status(t, 'browser-default').textContent).toBe(M.preferenceUnconfirmedDisabled);
    expect(form(t, 'preview-category').getAttribute('aria-busy')).toBe('true');
    expect(option(t, 'preview-category', 'sketches').disabled).toBe(false);
    expect(status(t, 'preview-category').textContent).toBe('Saving settings.');
    settleWithoutAnswer(t, 'preview-category');
    expect(offered(t, 'preview-category')).not.toContain('sketches');
    expect(status(t, 'preview-category').textContent).toBe(M.preferenceUnconfirmedDisabled);
    expect(stored(t, 'browser-default')).toBe('final');
    expect(stored(t, 'preview-category')).toBe('__disabled__');
    expect(t.posts).toHaveLength(1);
  });

  it('F11-C15b — one lost, the other answered and vetoed (F9A): each keeps its own truthful status and stored value', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    const read = await deleteHeldThenChoose(t, BOTH);
    await install(read, [FINAL, { ...SKETCHES, enabled: false }]);
    settleWithoutAnswer(t, 'browser-default');
    const previewForm = form(t, 'preview-category');
    previewForm.removeAttribute('aria-busy');
    previewForm.setAttribute('data-settings-fetch-save-state', 'saved');
    status(t, 'preview-category').textContent = 'Settings saved.';
    expect(answer(t, 'preview-category', { categories: [FINAL, SKETCHES] }).defaultPrevented).toBe(true);
    expect(stored(t, 'preview-category')).toBe('sketches');
    expect(status(t, 'preview-category').textContent).toBe(M.preferenceSavedDisabled);
    expect(stored(t, 'browser-default')).toBe('final');
    expect(status(t, 'browser-default').textContent).toBe(M.preferenceUnconfirmedDisabled);
    BOTH.forEach((identity) => expect(offered(t, identity)).not.toContain('sketches'));
  });

  for (const enabled of [true, false]) {
    it(`F11-C${enabled ? 16 : 17} — 7 deleted elsewhere, a NEW ${enabled ? 'enabled' : 'disabled'} default 12 takes "sketches": after the lost answer ${enabled ? 'it stays a choice under its own name' : 'it is not offered'}; 7 never returns`, async () => {
      const t = setup({ preferences: PREFS });
      enhanceSettingsCategoryDelete(t.document);
      const changes = track(t);
      const read = await deleteHeldThenChoose(t, 'browser-default');
      await install(read, [FINAL, reborn(enabled)]);
      changes.length = 0;
      settleWithoutAnswer(t, 'browser-default');
      expect(t.row('7')).toBeNull();
      expect(t.row('12').getAttribute('data-category-enabled')).toBe(enabled ? 'true' : 'false');
      if (enabled) {
        expect(offered(t, 'browser-default')).toContain('sketches');
        expect(radios(t, 'browser-default')).toContain('sketches');
        expect(offeredLabels(t, 'browser-default')).toContain('Reborn');
        expect(offeredLabels(t, 'browser-default')).not.toContain('Sketches');
        expect(status(t, 'browser-default').textContent).toBe(NOT_SAVED);
      } else {
        expect(offered(t, 'browser-default')).not.toContain('sketches');
        expect(radios(t, 'browser-default')).not.toContain('sketches');
        expect(offeredLabels(t, 'browser-default')).not.toContain('Reborn');
        expect(status(t, 'browser-default').textContent).toBe(M.preferenceUnconfirmedUnavailable);
      }
      expect(stored(t, 'browser-default')).toBe('final');
      expect(changes).toEqual([]);
      expect(t.posts).toHaveLength(1);
    });
  }

  it('F11-C18 — a failed read observes nothing (S stays offered after the lost answer); GET-only Retry installs S disabled and withdraws it; a later read with S enabled offers it again; nothing saved', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    const changes = track(t);
    const post = deferred();
    t.queue.post.push(() => post.promise);
    t.queue.get.push(async () => { throw new TypeError('Failed to fetch'); });
    t.confirmDelete('9');
    await flush();
    choose(t, 'browser-default', 'sketches');
    post.resolve(jsonResponse(200, deletedBody(CATEGORIES[2])));
    await flush();
    expect(settingsCategoryDeleteSync(t.document)).toBe('stale');
    changes.length = 0;
    // R5: lost before any read showing S unavailable was installed.
    settleWithoutAnswer(t, 'browser-default');
    expect(offered(t, 'browser-default')).toContain('sketches');
    expect(status(t, 'browser-default').textContent).toBe(NOT_SAVED);
    // R3: GET-only Retry installs S disabled.
    const retry = deferred();
    t.queue.get.push(() => retry.promise);
    t.feedbackButton('data-settings-category-delete-refresh-retry').click();
    await install(retry, [FINAL, { ...SKETCHES, enabled: false }], 'retried');
    expect(offered(t, 'browser-default')).not.toContain('sketches');
    expect(status(t, 'browser-default').textContent).toBe(M.preferenceUnconfirmedDisabled);
    expect(stored(t, 'browser-default')).toBe('final');
    // R4: a superseded older read (S enabled) never installs.
    const older = deferred();
    t.queue.get.push(() => older.promise);
    const controller = enhanceSettingsCategoryDelete(t.document);
    const olderDone = controller.refresh();
    const newer = deferred();
    t.queue.get.push(() => newer.promise);
    const newerDone = controller.refresh();
    newer.resolve(htmlResponse({ version: 'newer', categories: [FINAL, { ...SKETCHES, enabled: false }], preferences: PREFS }));
    await newerDone;
    older.resolve(htmlResponse({ version: 'older', categories: [FINAL, SKETCHES], preferences: PREFS }));
    await olderDone;
    await flush();
    expect(offered(t, 'browser-default')).not.toContain('sketches');
    expect(status(t, 'browser-default').textContent).toBe(M.preferenceUnconfirmedDisabled);
    // R8: a later read shows S enabled: it is a choice again, and the status
    // no longer says it is unavailable.
    const later = deferred();
    t.queue.get.push(() => later.promise);
    const laterDone = controller.refresh();
    later.resolve(htmlResponse({ version: 'later', categories: [FINAL, SKETCHES], preferences: PREFS }));
    await laterDone;
    await flush();
    expect(offered(t, 'browser-default')).toContain('sketches');
    expect(radios(t, 'browser-default')).toContain('sketches');
    expect(status(t, 'browser-default').textContent).toBe(NOT_SAVED);
    expect(stored(t, 'browser-default')).toBe('final');
    expect(changes).toEqual([]);
    expect(t.posts).toHaveLength(1);
    expect(t.gets.every((get) => get.method === 'GET')).toBe(true);
  });

  it('F11-C19 — F9B kept: a read sent while the save was pending, installed after the lost answer, keeps the region (the stored value is not rolled back) and still withdraws S', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    const read = await deleteHeldThenChoose(t, 'browser-default');
    // R6 reversed: the answer is lost BEFORE the read (sent while saving) installs.
    settleWithoutAnswer(t, 'browser-default');
    expect(offered(t, 'browser-default')).toContain('sketches');
    await install(read, [FINAL, { ...SKETCHES, enabled: false }], 'fresh', { 'browser-default': 'exports', 'preview-category': '__disabled__' });
    expect(region(t, 'browser-default').querySelector('[data-region-version]').getAttribute('data-region-version')).toBe('initial');
    expect(stored(t, 'browser-default')).toBe('final');
    expect(offered(t, 'browser-default')).not.toContain('sketches');
    expect(status(t, 'browser-default').textContent).toBe(M.preferenceUnconfirmedDisabled);
  });

  it('F11-C20 — F10 / F1: a dirty details draft on a survivor is kept through the install and the settlement; nothing is saved', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    const changes = track(t);
    const name = t.row('3').querySelector('input[name="displayName"]');
    name.value = 'Final draft';
    const read = await deleteHeldThenChoose(t, 'browser-default');
    await install(read, [FINAL, { ...SKETCHES, enabled: false }]);
    changes.length = 0;
    settleWithoutAnswer(t, 'browser-default');
    expect(t.row('3').querySelector('input[name="displayName"]')).toBe(name);
    expect(name.value).toBe('Final draft');
    expect(name.defaultValue).toBe('Final');
    expect(changes).toEqual([]);
    expect(t.posts).toHaveLength(1);
    expect(offered(t, 'browser-default')).not.toContain('sketches');
  });

  it('F11 follow-up — after reconciling, choosing a valid default is the person\'s own change, raised once; binding again adds no second listener', async () => {
    const t = setup({ preferences: PREFS });
    enhanceSettingsCategoryDelete(t.document);
    enhanceSettingsCategoryDelete(t.document);
    const changes = track(t);
    const read = await deleteHeldThenChoose(t, 'browser-default');
    await install(read, [FINAL, { ...SKETCHES, enabled: false }]);
    const syncs = dropdownSyncs.length;
    settleWithoutAnswer(t, 'browser-default');
    expect(dropdownSyncs.length - syncs).toBe(1);
    changes.length = 0;
    select(t, 'browser-default').value = 'final';
    select(t, 'browser-default').dispatch('change');
    expect(changes).toEqual(['browser-default']);
    expect(t.posts).toHaveLength(1);
  });
});
