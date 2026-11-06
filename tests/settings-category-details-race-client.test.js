import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { enhanceCategoryDetails, setCategoryDetailsLifecycle } from '../src/static/client/category-details.js';

// WP11C-F4: an older Category Details Save answer must not save, lose or
// misreport newer typing (category-details.js). The DOM is a purpose-built
// shim (no jsdom in this project) that models what matters here the way
// Chromium behaves: taking a focused, edited input out of the page ends that
// edit (change, blur, focusout), a programmatic value write resets what the
// browser compares on change, and the `value` attribute is the default value
// until the person types. The server's render is a page spec the fake
// DOMParser builds into the same shim. The real browser, routes, service and
// SQLite are covered in tests/browser/settings-category-details-race.spec.js.

const CONTROL_SELECTOR = 'input[name="displayName"], input[name="directorySlug"]';

function matchesSimple(element, selector) {
  const match = /^([a-z]*)((?:\[[^\]]+\])*)$/.exec(selector.trim());
  if (!match) throw new Error(`unsupported selector ${selector}`);
  if (match[1] && element.tagName !== match[1].toUpperCase()) return false;
  for (const [, name, value] of match[2].matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
    if (!element.hasAttribute(name)) return false;
    if (value !== undefined && element.getAttribute(name) !== value) return false;
  }
  return true;
}

class ShimNode {
  constructor(document) {
    this.ownerDocument = document;
    this.parentNode = null;
    this.childNodes = [];
    this.listeners = [];
  }

  get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }

  get isConnected() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node === this.ownerDocument;
  }

  contains(node) {
    for (let current = node; current; current = current.parentNode) if (current === this) return true;
    return false;
  }

  appendChild(child) { return this.insertBefore(child, null); }

  insertBefore(child, reference) {
    child.detach();
    child.adopt(this.ownerDocument);
    const index = reference ? this.childNodes.indexOf(reference) : this.childNodes.length;
    this.childNodes.splice(index, 0, child);
    child.parentNode = this;
    return child;
  }

  replaceChild(next, old) { this.insertBefore(next, old); old.detach(); }

  remove() { this.detach(); }

  replaceWith(next) { this.parentNode.insertBefore(next, this); this.detach(); }

  adopt(document) {
    this.ownerDocument = document;
    this.childNodes.forEach((child) => child.adopt(document));
  }

  detach() {
    const parent = this.parentNode;
    if (!parent) return;
    const document = this.ownerDocument;
    const connected = this.isConnected;
    const active = document.activeElement;
    parent.childNodes.splice(parent.childNodes.indexOf(this), 1);
    this.parentNode = null;
    if (connected && active && this.contains(active)) document.focusedRemoved(active);
  }

  addEventListener(type, handler) { this.listeners.push({ type, handler }); }

  dispatch(type) {
    const event = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    this.ownerDocument.events.push(`${type}:${this.id || this.tagName}`);
    for (let node = this; node; node = node.parentNode) {
      node.listeners.filter((listener) => listener.type === type).forEach((listener) => listener.handler(event));
    }
    return event;
  }

  querySelectorAll(selector) {
    const parts = selector.split(',');
    const found = [];
    const walk = (node) => node.childNodes.forEach((child) => {
      if (child.nodeType === 1 && parts.some((part) => matchesSimple(child, part))) found.push(child);
      walk(child);
    });
    walk(this);
    return found;
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

class ShimElement extends ShimNode {
  constructor(document, tagName, attributes = {}) {
    super(document);
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.attrs = new Map(Object.entries(attributes).map(([name, value]) => [name, String(value)]));
    this.dataset = {};
    this.textContent = '';
    this.dirty = false;
    this.ownValue = null;
    this.changeBase = null;
    this.selectionStart = 0;
    this.selectionEnd = 0;
  }

  get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }

  getAttribute(name) {
    if (name.startsWith('data-') && this.dataset) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      if (key in this.dataset) return this.dataset[key];
    }
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }

  hasAttribute(name) { return this.getAttribute(name) !== null; }

  setAttribute(name, value) { this.attrs.set(name, String(value)); }

  removeAttribute(name) { this.attrs.delete(name); }

  matches(selector) { return selector.split(',').some((part) => matchesSimple(this, part)); }

  get id() { return this.getAttribute('id') || ''; }

  get name() { return this.getAttribute('name') || ''; }

  get defaultValue() { return this.getAttribute('value') ?? ''; }

  // Writes the `value` attribute; an edited value stays as typed.
  set defaultValue(next) { this.setAttribute('value', next); }

  // Before the person types, the value follows the `value` attribute.
  get value() { return this.dirty ? this.ownValue : this.defaultValue; }

  // A script's write: the browser's change comparison restarts from it.
  set value(next) {
    this.dirty = true;
    this.ownValue = String(next);
    this.changeBase = this.ownValue;
    this.selectionStart = this.ownValue.length;
    this.selectionEnd = this.ownValue.length;
  }

  focus() {
    const document = this.ownerDocument;
    if (document.activeElement === this) return;
    document.activeElement?.blurByPerson?.();
    document.activeElement = this;
    this.changeBase = this.value;
  }

  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }

  // The person's typing, at the end of the value.
  type(text) {
    const next = `${this.value}${text}`;
    this.dirty = true;
    this.ownValue = next;
    this.selectionStart = next.length;
    this.selectionEnd = next.length;
  }

  // The person leaving the field (Tab or a click elsewhere).
  blurByPerson() {
    const document = this.ownerDocument;
    if (document.activeElement !== this) return;
    if (this.value !== this.changeBase) {
      this.changeBase = this.value;
      this.dispatch('change');
    }
    document.activeElement = null;
    this.dispatch('blur');
    this.dispatch('focusout');
  }
}

class ShimDocument extends ShimNode {
  constructor() {
    super(null);
    this.ownerDocument = this;
    this.nodeType = 9;
    this.activeElement = null;
    this.events = [];
    this.defaultView = { DOMParser: globalThis.DOMParser };
  }

  createElement(tagName, attributes) { return new ShimElement(this, tagName, attributes); }

  getElementById(id) { return this.querySelectorAll('input').find((element) => element.id === id) || null; }

  // Chromium: a focused, edited field taken out of the page ends its edit.
  focusedRemoved(element) {
    this.activeElement = null;
    if (element.value !== element.changeBase) {
      element.changeBase = element.value;
      element.dispatch('change');
    }
    element.dispatch('blur');
    element.dispatch('focusout');
  }
}

function element(document, tagName, attributes, children = []) {
  const node = document.createElement(tagName, attributes);
  children.forEach((child) => node.appendChild(child));
  return node;
}

// The server's details form for one default, as the template renders it.
// WP11C-F7: `reviewed` is the saved row the server rendered it from (the
// hidden review fields); `conflict` marks a stale refusal.
function detailsForm(document, { id, name, slug, errors = {}, reviewed = null, conflict = null }) {
  const field = (key, label, value, inputId) => element(document, 'div', {
    class: `category-management-card-field${errors[key] ? ' field-error' : ''}`,
  }, [
    element(document, 'label', { for: inputId }),
    element(document, 'input', {
      type: 'text', id: inputId, name: key, value, maxlength: 100, required: '',
      ...(errors[key] ? { 'aria-describedby': `${inputId}-error`, 'aria-invalid': 'true' } : {}),
    }),
    ...(errors[key] ? [element(document, 'span', { class: 'field-error-message', id: `${inputId}-error`, role: 'alert' })] : []),
  ]);
  return element(document, 'form', {
    method: 'post', action: `/settings/asset-categories/${id}`, class: 'category-details-form',
    novalidate: '', 'data-category-details-form': '', 'data-category-details-id': id,
    ...(conflict ? { 'data-category-details-conflict': conflict } : {}),
  }, [
    element(document, 'input', { type: 'hidden', name: '_csrf', value: 'csrf-f4' }),
    element(document, 'input', {
      type: 'hidden', name: 'reviewedDisplayName', value: reviewed ? reviewed.name : name, 'data-category-details-reviewed': 'displayName',
    }),
    element(document, 'input', {
      type: 'hidden', name: 'reviewedDirectorySlug', value: reviewed ? reviewed.slug : slug, 'data-category-details-reviewed': 'directorySlug',
    }),
    ...(Object.keys(errors).length || conflict ? [element(document, 'div', { class: 'error-summary', role: 'alert' })] : []),
    element(document, 'div', { class: 'category-management-card-fields' }, [
      field('displayName', 'Display name', name, `global-category-${id}-display-name`),
      field('directorySlug', 'Directory slug', slug, `global-category-${id}-directory-slug`),
    ]),
    element(document, 'span', { class: 'sr-only', 'data-category-details-status': '' }),
  ]);
}

// A page (or a server render) with an article per default.
function page(document, rows) {
  const list = element(document, 'div', { 'data-settings-category-defaults': '' });
  rows.forEach((row) => list.appendChild(element(document, 'article', { 'data-category-id': row.id }, [
    element(document, 'div', { class: 'category-management-card-body' }, [detailsForm(document, row)]),
  ])));
  document.appendChild(list);
  return list;
}

let renders;
let requests;
let saved;
let executions;
const originals = {};

beforeEach(() => {
  renders = new Map();
  requests = [];
  executions = [];
  // The server's saved rows; a request's answer is rendered when the server
  // answers it (see answer()).
  saved = new Map();
  originals.fetch = globalThis.fetch;
  originals.FormData = globalThis.FormData;
  originals.DOMParser = globalThis.DOMParser;
  globalThis.fetch = (action, options) => new Promise((resolve) => {
    requests.push({ action, body: options.body, resolve });
  });
  globalThis.FormData = class {
    constructor(form) {
      this.entries = form.querySelectorAll('input').filter((input) => input.name).map((input) => [input.name, input.value]);
    }

    [Symbol.iterator]() { return this.entries[Symbol.iterator](); }
  };
  globalThis.DOMParser = class {
    parseFromString(html) {
      const document = new ShimDocument();
      page(document, renders.get(html) || []);
      return document;
    }
  };
});

afterEach(() => {
  globalThis.fetch = originals.fetch;
  globalThis.FormData = originals.FormData;
  globalThis.DOMParser = originals.DOMParser;
});

let renderCount = 0;
// The server runs request `index` now; its answer is the list render of what
// is then saved (or, refused, the edit page with the submitted values).
// WP11C-F7: like the route, it writes only while the row still holds the
// request's reviewed details; otherwise it answers 409 with the stale form
// (the submitted values in the fields, the row as it is now as reviewed).
function answer(index, { refuse = null, fail = false } = {}) {
  const request = requests[index];
  const id = Number(request.action.split('/').pop());
  const values = { name: request.body.get('displayName').trim(), slug: request.body.get('directorySlug') };
  const shown = { name: request.body.get('displayName'), slug: request.body.get('directorySlug') };
  const current = saved.get(id);
  const stale = !refuse && (request.body.get('reviewedDisplayName') !== current.name
    || request.body.get('reviewedDirectorySlug') !== current.slug);
  renderCount += 1;
  const key = `render-${renderCount}`;
  if (stale) {
    executions.push([id, 'stale']);
    renders.set(key, [...saved.values()].map((row) => (row.id === id ? { id, ...shown, reviewed: current, conflict: 'stale' } : row)));
  } else if (refuse) {
    executions.push([id, 'refused']);
    renders.set(key, [...saved.values()].map((row) => (row.id === id ? { id, ...shown, errors: refuse, reviewed: current } : row)));
  } else {
    executions.push([id, 'saved']);
    saved.set(id, { id, ...values });
    renders.set(key, [...saved.values()]);
  }
  const status = stale ? 409 : refuse ? 422 : 200;
  return () => {
    if (fail) { request.resolve(Promise.reject(new TypeError('Failed to fetch'))); return; }
    request.resolve({
      ok: status === 200, redirected: status === 200, status, text: async () => key,
    });
  };
}

const flush = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };

function setup(rows = [
  { id: 1, name: 'Alpha', slug: 'alpha' },
  { id: 2, name: 'Bravo', slug: 'bravo' },
  { id: 3, name: 'Charlie', slug: 'charlie' },
]) {
  const document = new ShimDocument();
  rows.forEach((row) => saved.set(row.id, { ...row }));
  page(document, rows);
  enhanceCategoryDetails(document);
  const form = (id) => document.querySelectorAll('form').find((candidate) => candidate.getAttribute('data-category-details-id') === String(id));
  const field = (id, key) => document.getElementById(`global-category-${id}-${key === 'displayName' ? 'display-name' : 'directory-slug'}`);
  const status = (id) => form(id).querySelector('[data-category-details-status]');
  return { document, form, field, status };
}

// Leaves `control` with `value` by the person's own edit, then Tab.
async function edit(control, value) {
  control.focus();
  control.dirty = true;
  control.ownValue = value;
  control.blurByPerson();
  await flush();
}

const sent = () => requests.map((request) => [Number(request.action.split('/').pop()), request.body.get('displayName'), request.body.get('directorySlug')]);

describe('WP11C-F4 older Category Details Save answers', () => {
  for (const [key, first, more, label] of [
    ['displayName', 'Bravo One', ' Two', 'F4-C1 name'],
    ['directorySlug', 'bravo-one', '-two', 'F4-C2 slug'],
  ]) {
    it(`${label}: the old answer installs without a second POST; B2 stays a draft; B1 is the baseline; Tab saves B2 once (F4-C3..C8, C17)`, async () => {
      const t = setup();
      const control = t.field(2, key);
      await edit(control, first);
      expect(sent()).toHaveLength(1);
      const release = answer(0);
      // The person returns and keeps typing B2 while the answer is on its way.
      control.focus();
      control.type(more);
      control.setSelectionRange(first.length, first.length + more.length);
      t.document.events.length = 0;

      release();
      await flush();
      expect(t.document.events, 'native events raised by installing the answer').toEqual([]);
      expect(sent(), 'POSTs after the old answer').toHaveLength(1);
      expect(t.document.activeElement).toBe(control);
      expect(t.field(2, key)).toBe(control);
      expect(control.value).toBe(`${first}${more}`);
      expect(control.defaultValue).toBe(first);
      expect([control.selectionStart, control.selectionEnd]).toEqual([first.length, first.length + more.length]);
      expect(t.status(2).textContent).toBe('Earlier changes saved. Current changes have not been saved.');
      expect(t.form(2).getAttribute('data-category-details-state')).toBe('saved');
      expect(t.form(2).getAttribute('aria-busy')).toBe(null);
      expect(saved.get(2)[key === 'displayName' ? 'name' : 'slug']).toBe(first);

      control.blurByPerson();
      await flush();
      expect(sent()).toHaveLength(2);
      expect(sent()[1]).toEqual(key === 'displayName' ? [2, `${first}${more}`, 'bravo'] : [2, 'Bravo', `${first}${more}`]);
      answer(1)();
      await flush();
      expect(t.status(2).textContent).toBe('Details saved.');
      expect(t.field(2, key).defaultValue).toBe(`${first}${more}`);
      expect(sent()).toHaveLength(2);
      expect(sent().every(([id]) => id === 2)).toBe(true);
    });
  }

  it('F4-C9/C10: an older refusal stays with the refused value; the newer name or slug is kept, not sent, then saved by Tab', async () => {
    for (const [key, refusedValue, newer, errors] of [
      ['displayName', '', 'Bravo Named', { displayName: 'Display name is required.' }],
      ['directorySlug', 'Bad Slug!', 'bravo-fixed', { directorySlug: 'Invalid slug.' }],
    ]) {
      requests.length = 0;
      const t = setup();
      const control = t.field(2, key);
      await edit(control, refusedValue);
      const release = answer(0, { refuse: errors });
      control.focus();
      control.dirty = true;
      control.ownValue = newer;
      t.document.events.length = 0;
      release();
      await flush();
      expect(t.document.events).toEqual([]);
      expect(sent()).toHaveLength(1);
      expect(t.document.activeElement).toBe(control);
      expect(control.value).toBe(newer);
      expect(control.getAttribute('aria-invalid')).toBe('true');
      expect(t.form(2).querySelector('[class="error-summary"]')).not.toBe(null);
      expect(t.status(2).textContent).toBe('Could not save the earlier category details. Current changes have not been saved.');
      expect(t.form(2).getAttribute('data-category-details-state')).toBe('error');
      expect(saved.get(2)).toEqual({ id: 2, name: 'Bravo', slug: 'bravo' });

      control.blurByPerson();
      await flush();
      expect(sent()).toHaveLength(2);
      answer(1)();
      await flush();
      expect(t.status(2).textContent).toBe('Details saved.');
      expect(t.field(2, key).getAttribute('aria-invalid')).toBe(null);
      expect(t.form(2).querySelector('[class="error-summary"]')).toBe(null);
    }
  });

  it('F4-C11: a failed old answer keeps the newer draft and focus, sends nothing more and does not claim it saved', async () => {
    const t = setup();
    const control = t.field(2, 'displayName');
    await edit(control, 'Bravo One');
    const release = answer(0, { fail: true });
    control.focus();
    control.type(' Two');
    t.document.events.length = 0;
    release();
    await flush();
    expect(t.document.events).toEqual([]);
    expect(sent()).toHaveLength(1);
    expect(control.value).toBe('Bravo One Two');
    expect(t.document.activeElement).toBe(control);
    expect(t.status(2).textContent).toBe('Could not save category details. Your current changes were kept.');
    expect(t.status(2).textContent).not.toContain('Details saved');
    control.blurByPerson();
    await flush();
    expect(sent()).toHaveLength(2);
  });

  it('F4-C12: a newer edit in the other field of the same category survives and is not sent by the answer', async () => {
    const t = setup();
    await edit(t.field(2, 'displayName'), 'Bravo Field');
    const release = answer(0);
    const slug = t.field(2, 'directorySlug');
    slug.focus();
    slug.type('-x');
    release();
    await flush();
    expect(sent()).toHaveLength(1);
    expect(t.field(2, 'directorySlug')).toBe(slug);
    expect(slug.value).toBe('bravo-x');
    expect(slug.defaultValue).toBe('bravo');
    expect(t.field(2, 'displayName').value).toBe('Bravo Field');
    expect(t.field(2, 'displayName').defaultValue).toBe('Bravo Field');
    expect(t.status(2).textContent).toBe('Earlier changes saved. Current changes have not been saved.');
    slug.blurByPerson();
    await flush();
    expect(sent()[1]).toEqual([2, 'Bravo Field', 'bravo-x']);
  });

  it('F4-C13/C15: another category’s draft survives; out-of-order answers settle each row alone, by id', async () => {
    const t = setup();
    await edit(t.field(2, 'displayName'), 'Bravo Two');
    await edit(t.field(3, 'displayName'), 'Charlie Two');
    const releaseB = answer(0);
    const releaseC = answer(1);
    const alpha = t.field(1, 'displayName');
    alpha.focus();
    alpha.type(' wip');
    releaseC();
    await flush();
    expect(t.status(3).textContent).toBe('Details saved.');
    expect(t.form(2).getAttribute('aria-busy')).toBe('true');
    releaseB();
    await flush();
    expect(t.status(2).textContent).toBe('Details saved.');
    expect(sent()).toEqual([[2, 'Bravo Two', 'bravo'], [3, 'Charlie Two', 'charlie']]);
    expect(t.document.activeElement).toBe(alpha);
    expect(alpha.value).toBe('Alpha wip');
    expect(t.status(1).textContent).toBe('');
    expect(t.document.querySelectorAll('article').map((article) => article.getAttribute('data-category-id'))).toEqual(['1', '2', '3']);
  });

  it('F4-C14: a pending save whose form a list read moved still installs its answer around the newer typing', async () => {
    const t = setup();
    const control = t.field(2, 'displayName');
    await edit(control, 'Bravo List');
    const release = answer(0);
    // A list read installs: the row's body (with this busy form) moves into
    // the read's list; the focus is not in it at the time.
    const fresh = new ShimDocument();
    const list = page(fresh, [{ id: 2, name: 'Bravo List', slug: 'bravo' }, { id: 3, name: 'Charlie', slug: 'charlie' }]);
    const body = t.form(2).parentNode;
    const old = t.document.childNodes[0];
    t.document.insertBefore(list, old);
    list.childNodes[0].childNodes[0].replaceWith(body);
    old.remove();
    enhanceCategoryDetails(list);
    control.focus();
    control.type(' Two');
    release();
    await flush();
    expect(sent()).toHaveLength(1);
    expect(control.value).toBe('Bravo List Two');
    expect(control.defaultValue).toBe('Bravo List');
    control.blurByPerson();
    await flush();
    expect(sent()).toHaveLength(2);
    expect(sent()[1]).toEqual([2, 'Bravo List Two', 'bravo']);
  });

  it('F4-C16: answers installed around the focus never bind a control twice', async () => {
    const t = setup();
    const name = t.field(2, 'displayName');
    for (let round = 0; round < 3; round += 1) {
      await edit(name, `Bravo ${round}`);
      const release = answer(requests.length - 1);
      name.focus();
      release();
      await flush();
    }
    const slug = t.field(2, 'directorySlug');
    expect(name.listeners.filter((listener) => listener.type === 'change')).toHaveLength(1);
    expect(slug.listeners.filter((listener) => listener.type === 'change')).toHaveLength(1);
    expect(t.form(2).listeners.filter((listener) => listener.type === 'submit')).toHaveLength(1);
    await edit(slug, 'bravo-once');
    expect(requests).toHaveLength(4);
  });

  it('F4-C18: ordinary saves without newer typing replace the form and say Details saved, once per edit', async () => {
    const t = setup();
    await edit(t.field(2, 'displayName'), 'Bravo Plain');
    answer(0)();
    await flush();
    expect(t.status(2).textContent).toBe('Details saved.');
    expect(t.field(2, 'displayName').defaultValue).toBe('Bravo Plain');
    await edit(t.field(2, 'directorySlug'), 'bravo-plain');
    answer(1)();
    await flush();
    expect(t.status(2).textContent).toBe('Details saved.');
    expect(sent()).toEqual([[2, 'Bravo Plain', 'bravo'], [2, 'Bravo Plain', 'bravo-plain']]);
    // Focused but untouched: the submitted value shows as the server saved it.
    const slug = t.field(2, 'directorySlug');
    await edit(t.field(2, 'displayName'), 'Bravo Focus');
    slug.focus();
    answer(2)();
    await flush();
    expect(t.document.activeElement).toBe(slug);
    expect(t.status(2).textContent).toBe('Details saved.');
    expect(sent()).toHaveLength(3);
  });

  it('F4-C17: control — the same answer installed by the earlier full replacement would end the edit and save B2', async () => {
    // Documents the native event the correction avoids: taking the focused,
    // edited field out of the page raises change.
    const document = new ShimDocument();
    page(document, [{ id: 2, name: 'Bravo', slug: 'bravo' }]);
    const control = document.getElementById('global-category-2-display-name');
    let changes = 0;
    control.addEventListener('change', () => { changes += 1; });
    control.focus();
    control.type(' Two');
    control.parentNode.parentNode.parentNode.parentNode.remove();
    expect(changes).toBe(1);
    expect(document.events).toEqual(['change:global-category-2-display-name', 'blur:global-category-2-display-name', 'focusout:global-category-2-display-name']);
  });
});

// WP11C-F7: a details save that the server refuses as stale (another page
// saved newer details first) is never shown as saved, never moves the saved
// baseline to the refused values, keeps every draft, and sends nothing by
// itself; a new intentional save is based on the details saved now.
describe('WP11C-F7 stale Category Details Save answers', () => {
  const reviewedOf = (form) => [
    form.querySelector('input[name="reviewedDisplayName"]').value,
    form.querySelector('input[name="reviewedDirectorySlug"]').value,
  ];
  const sentReviewed = () => requests.map((request) => [request.body.get('reviewedDisplayName'), request.body.get('reviewedDirectorySlug')]);

  for (const [key, mine, theirs, newer, label] of [
    ['displayName', 'Bravo Mine', { name: 'Bravo Theirs', slug: 'bravo' }, ' More', 'name'],
    ['directorySlug', 'bravo-mine', { name: 'Bravo', slug: 'bravo-theirs' }, '-more', 'slug'],
  ]) {
    it(`F7-C1..C4/C8 ${label}: a stale refusal keeps the newer typing, does not advance the baseline and sends nothing`, async () => {
      const t = setup();
      const control = t.field(2, key);
      await edit(control, mine);
      expect(sentReviewed()).toEqual([['Bravo', 'bravo']]);
      // Another page saves newer details before this request runs.
      saved.set(2, { id: 2, ...theirs });
      const release = answer(0);
      expect(executions).toEqual([[2, 'stale']]);
      control.focus();
      control.type(newer);
      t.document.events.length = 0;

      release();
      await flush();
      expect(t.document.events, 'native events raised by installing the refusal').toEqual([]);
      expect(sent(), 'no automatic replay').toHaveLength(1);
      expect(t.document.activeElement).toBe(control);
      expect(t.field(2, key)).toBe(control);
      expect(control.value).toBe(`${mine}${newer}`);
      // The baseline is what is saved now, never the refused value.
      expect(control.defaultValue).toBe(key === 'displayName' ? theirs.name : theirs.slug);
      expect(reviewedOf(t.form(2))).toEqual([theirs.name, theirs.slug]);
      expect(t.form(2).getAttribute('data-category-details-state')).toBe('stale');
      expect(t.status(2).textContent).toBe('This category was changed somewhere else, so the earlier details were not saved. Current changes have not been saved either. Review the saved details, then save again.');
      expect(saved.get(2)).toEqual({ id: 2, ...theirs });
      await flush();
      expect(sent()).toHaveLength(1);

      // F7-C7: the person's own Tab is a new save, based on the details saved now.
      control.blurByPerson();
      await flush();
      expect(sent()).toHaveLength(2);
      expect(sentReviewed()[1]).toEqual([theirs.name, theirs.slug]);
      answer(1)();
      await flush();
      expect(executions[1]).toEqual([2, 'saved']);
      expect(t.status(2).textContent).toBe('Details saved.');
      expect(sent()).toHaveLength(2);
    });
  }

  it('F7-C1/C2: refused while the person is elsewhere, the refused value stays as a draft, not as saved', async () => {
    const t = setup();
    const control = t.field(2, 'displayName');
    await edit(control, 'Bravo Mine');
    saved.set(2, { id: 2, name: 'Bravo Theirs', slug: 'bravo' });
    answer(0)();
    await flush();
    const shown = t.field(2, 'displayName');
    expect(shown.value).toBe('Bravo Mine');
    expect(shown.defaultValue).toBe('Bravo Theirs');
    expect(t.field(2, 'directorySlug').value).toBe('bravo');
    expect(t.status(2).textContent).toBe('This category was changed somewhere else, so these details were not saved. Review the saved details, then save again.');
    expect(t.form(2).getAttribute('data-category-details-state')).toBe('stale');
    expect(sent()).toHaveLength(1);
    // F7-C4/C10: focusing and leaving it unchanged sends nothing; one Tab after a change sends once.
    shown.focus();
    shown.blurByPerson();
    await flush();
    expect(sent()).toHaveLength(1);
    await edit(shown, 'Bravo Final');
    expect(sent()).toHaveLength(2);
    expect(sentReviewed()[1]).toEqual(['Bravo Theirs', 'bravo']);
  });

  it('F7-C9: a save queued behind one the server committed is based on what that one saved', async () => {
    const t = setup();
    const control = t.field(2, 'displayName');
    await edit(control, '  Bravo One  ');
    await edit(control, 'Bravo Two');
    expect(sent()).toHaveLength(1);
    answer(0)();
    await flush();
    expect(sent()).toHaveLength(2);
    expect(sentReviewed()).toEqual([['Bravo', 'bravo'], ['Bravo One', 'bravo']]);
    answer(1)();
    await flush();
    expect(executions).toEqual([[2, 'saved'], [2, 'saved']]);
    expect(saved.get(2).name).toBe('Bravo Two');
    expect(t.status(2).textContent).toBe('Details saved.');
  });

  it('F7-C9: the queued save is still refused when another page saved in between', async () => {
    const t = setup();
    const control = t.field(2, 'displayName');
    await edit(control, 'Bravo One');
    await edit(control, 'Bravo Two');
    answer(0)();
    await flush();
    saved.set(2, { id: 2, name: 'Bravo Theirs', slug: 'bravo' });
    answer(1)();
    await flush();
    expect(executions).toEqual([[2, 'saved'], [2, 'stale']]);
    expect(saved.get(2).name).toBe('Bravo Theirs');
    expect(t.field(2, 'displayName').value).toBe('Bravo Two');
    expect(t.field(2, 'displayName').defaultValue).toBe('Bravo Theirs');
    expect(t.form(2).getAttribute('data-category-details-state')).toBe('stale');
    expect(sent()).toHaveLength(2);
  });

  it('F7-C9: after a stale refusal a queued save keeps its own (stale) basis and is refused too', async () => {
    const t = setup();
    const control = t.field(2, 'displayName');
    await edit(control, 'Bravo One');
    await edit(control, 'Bravo Two');
    saved.set(2, { id: 2, name: 'Bravo Theirs', slug: 'bravo' });
    answer(0)();
    await flush();
    expect(sentReviewed()).toEqual([['Bravo', 'bravo'], ['Bravo', 'bravo']]);
    answer(1)();
    await flush();
    expect(executions).toEqual([[2, 'stale'], [2, 'stale']]);
    expect(saved.get(2).name).toBe('Bravo Theirs');
    expect(sent()).toHaveLength(2);
  });

  it('F7-C6: an ordinary refusal and a saved answer keep the review fields on what is saved', async () => {
    const t = setup();
    const control = t.field(2, 'directorySlug');
    await edit(control, 'Bad Slug!');
    answer(0, { refuse: { directorySlug: 'Invalid slug.' } })();
    await flush();
    expect(reviewedOf(t.form(2))).toEqual(['Bravo', 'bravo']);
    expect(t.form(2).getAttribute('data-category-details-state')).toBe('error');
    await edit(t.field(2, 'directorySlug'), 'bravo-fixed');
    expect(sentReviewed()[1]).toEqual(['Bravo', 'bravo']);
    answer(1)();
    await flush();
    expect(reviewedOf(t.form(2))).toEqual(['Bravo', 'bravo-fixed']);
    // Another category is untouched by all of it.
    expect(reviewedOf(t.form(1))).toEqual(['Alpha', 'alpha']);
    expect(sent().every(([id]) => id === 2)).toBe(true);
  });

  it('F7-C5: a failed request is not taken as stale or saved, and nothing is retried', async () => {
    const t = setup();
    const control = t.field(2, 'displayName');
    await edit(control, 'Bravo Lost');
    answer(0, { fail: true })();
    await flush();
    expect(t.status(2).textContent).toBe('Could not save category details. Your current changes were kept.');
    expect(sent()).toHaveLength(1);
  });
});

// WP11C-A: a host registered for the document is told when each save's
// request is sent (its token) and when that request's answer is installed
// (the form now shown, with the same token). Nothing else changes.
describe('WP11C-A Category Details answer lifecycle', () => {
  function register(t) {
    const calls = [];
    let next = 0;
    setCategoryDetailsLifecycle(t.document, {
      requestStarted: (form) => {
        next += 1;
        calls.push(['started', form.getAttribute('data-category-details-id'), next, requests.length]);
        return { token: next };
      },
      answerInstalled: (form, started) => {
        calls.push(['installed', form.getAttribute('data-category-details-id'), started?.token,
          form.getAttribute('data-category-details-state'), form.isConnected]);
      },
    });
    return calls;
  }

  it('A-L1: saved, refused (422) and stale (409) answers each report the installed form with their own request token', async () => {
    const t = setup();
    const calls = register(t);
    await edit(t.field(2, 'directorySlug'), 'bravo-beta');
    expect(calls).toEqual([['started', '2', 1, 0]]);
    answer(0)();
    await flush();
    await edit(t.field(2, 'directorySlug'), 'Bad Slug!');
    answer(1, { refuse: { directorySlug: 'Invalid slug.' } })();
    await flush();
    await edit(t.field(2, 'directorySlug'), 'bravo-gamma');
    saved.set(2, { id: 2, name: 'Bravo', slug: 'bravo-elsewhere' });
    answer(2)();
    await flush();
    expect(calls).toEqual([
      ['started', '2', 1, 0], ['installed', '2', 1, 'saved', true],
      ['started', '2', 2, 1], ['installed', '2', 2, 'error', true],
      ['started', '2', 3, 2], ['installed', '2', 3, 'stale', true],
    ]);
    expect(sent()).toHaveLength(3);
  });

  it('A-L2: an answer installed around newer focused typing reports the same kept form; nothing more is sent', async () => {
    const t = setup();
    const calls = register(t);
    const control = t.field(2, 'displayName');
    await edit(control, 'Bravo A');
    const release = answer(0);
    control.focus();
    control.type(' B');
    release();
    await flush();
    expect(calls).toEqual([['started', '2', 1, 0], ['installed', '2', 1, 'saved', true]]);
    expect(control.value).toBe('Bravo A B');
    expect(sent()).toHaveLength(1);
  });

  it('A-L3: a failed request installs nothing and reports nothing; a queued save reports only its own answer under its own token', async () => {
    const t = setup();
    const calls = register(t);
    await edit(t.field(2, 'displayName'), 'Bravo Lost');
    answer(0, { fail: true })();
    await flush();
    expect(calls).toEqual([['started', '2', 1, 0]]);
    await edit(t.field(2, 'displayName'), 'Bravo One');
    await edit(t.field(2, 'displayName'), 'Bravo Two');
    answer(1)();
    await flush();
    answer(2)();
    await flush();
    // The lost request ran on the server, so the queued one is refused stale (F7).
    expect(calls.slice(1)).toEqual([['started', '2', 2, 1], ['started', '2', 3, 2], ['installed', '2', 3, 'stale', true]]);
  });

  it('A-L4: without a registered host, saves behave as before', async () => {
    const t = setup();
    await edit(t.field(2, 'displayName'), 'Bravo Plain');
    answer(0)();
    await flush();
    expect(t.status(2).textContent).toBe('Details saved.');
    expect(sent()).toHaveLength(1);
  });
});
