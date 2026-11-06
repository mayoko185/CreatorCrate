import { describe, it, expect, vi, beforeEach } from 'vitest';

// WP10B: the Remove missing assets confirmation's controller
// (remove-missing-assets.js). The shared async binder (one POST per
// confirmation, the pending freeze, Escape/backdrop/Cancel) and the WP09A
// refresh are stand-ins here, so the controller's own decisions are
// observable: what it believes, what it reports, which GETs it starts and when
// it blocks a new submission. The real binder and refresh run together in
// Chromium (tests/browser/project-assets-remove-missing.spec.js).

const dialogs = vi.hoisted(() => ({ closed: [] }));
vi.mock('../src/static/client/app-dialogs.js', () => ({
  closeAppDialogById: (document, id) => {
    const dialog = document.getElementById(id);
    const state = dialog?.__creatorCrateAppDialogState;
    if (!state || !dialog.open) return false;
    if (state.beforeClose && state.beforeClose({}) !== true) return false;
    dialog.open = false;
    dialogs.closed.push(id);
    state.onClose?.();
    return true;
  },
}));

const refresh = vi.hoisted(() => ({ calls: [], pending: [] }));
vi.mock('../src/static/client/live-regions.js', () => ({
  PROJECT_ASSETS_REGION_LOADED_EVENT: 'project-assets-region-loaded',
  // Each call resolves when the test settles it, in any order.
  refreshProjectAssetsAfterMutation: (document, options = {}) => {
    const call = { options };
    refresh.calls.push(call);
    return new Promise((resolve) => { call.resolve = resolve; });
  },
}));

const {
  acknowledgedRemoveMissingResult, enhanceRemoveMissingAssets, pendingRemoveMissingOperation, REMOVE_MISSING_ASSETS_DIALOG_ID,
} = await import('../src/static/client/remove-missing-assets.js');

// ---------------------------------------------------------------- DOM shim --
// Compound selectors and descendant combinators; enough for this controller.

function matchesCompound(node, compound) {
  const match = compound.match(/^([a-z][a-z0-9]*)?((?:#[\w-]+|\.[\w-]+|\[[\w-]+(?:="[^"]*")?\])*)$/i);
  if (!match) throw new Error(`Unsupported selector ${compound}`);
  if (match[1] && node.tagName !== match[1].toUpperCase()) return false;
  return (match[2].match(/#[\w-]+|\.[\w-]+|\[[\w-]+(?:="[^"]*")?\]/g) || []).every((token) => {
    if (token.startsWith('#')) return node.getAttribute('id') === token.slice(1);
    if (token.startsWith('.')) return (node.getAttribute('class') || '').split(/\s+/).includes(token.slice(1));
    const [, name, value] = token.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
    if (name === 'open' && node.tagName === 'DIALOG') return node.open === true;
    if (!node.hasAttribute(name)) return false;
    return value === undefined || node.getAttribute(name) === value;
  });
}

function matchesSelector(node, selector) {
  return selector.split(',').some((alternative) => {
    const parts = alternative.trim().split(/\s+/);
    if (!matchesCompound(node, parts.at(-1))) return false;
    let ancestor = node.parentNode;
    for (let index = parts.length - 2; index >= 0; index -= 1) {
      while (ancestor?.tagName && !matchesCompound(ancestor, parts[index])) ancestor = ancestor.parentNode;
      if (!ancestor?.tagName) return false;
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
    this.listeners = new Map();
    this.ownText = '';
    this.open = false;
    this.disabled = false;
    this.classList = {
      toggle: (name, on) => {
        const classes = new Set((this.getAttribute('class') || '').split(/\s+/).filter(Boolean));
        if (on) classes.add(name); else classes.delete(name);
        this.setAttribute('class', [...classes].join(' '));
      },
      contains: (name) => (this.getAttribute('class') || '').split(/\s+/).includes(name),
    };
  }

  get ownerDocument() { let node = this; while (node.parentNode) node = node.parentNode; return node.document || null; }
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(value) { if (value) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
  set className(value) { this.setAttribute('class', value); }
  set href(value) { this.setAttribute('href', value); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }
  appendChild(child) { child.parentNode?.removeChildNode(child); child.parentNode = this; this.childNodes.push(child); return child; }
  removeChildNode(child) { this.childNodes = this.childNodes.filter((node) => node !== child); child.parentNode = null; }
  remove() { this.parentNode?.removeChildNode(this); }
  contains(node) { for (let current = node; current; current = current.parentNode) if (current === this) return true; return false; }
  get textContent() { return this.ownText + this.childNodes.map((node) => node.textContent).join(''); }
  set textContent(text) { this.childNodes.forEach((node) => { node.parentNode = null; }); this.childNodes = []; this.ownText = String(text); }
  matches(selector) { return matchesSelector(this, selector); }
  descendants() { return this.childNodes.flatMap((child) => [child, ...child.descendants()]); }
  querySelectorAll(selector) { return this.descendants().filter((node) => node.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(listener); }
  dispatch(type) { (this.listeners.get(type) || []).forEach((listener) => listener({ type, target: this })); }
  focus() { this.ownerDocument.activeElement = this; }
  click() { this.dispatch('click'); }
}

function el(tag, attributes = {}, children = [], text = '') {
  const node = new FakeNode(tag, attributes);
  children.forEach((child) => node.appendChild(child));
  node.ownText = text;
  return node;
}

const PROJECT_ID = 42;

function trigger() {
  return el('a', { 'data-dialog-open': REMOVE_MISSING_ASSETS_DIALOG_ID, 'aria-label': 'Remove missing assets' });
}

function buildDialog(projectId = PROJECT_ID) {
  return el('dialog', { id: REMOVE_MISSING_ASSETS_DIALOG_ID, 'data-app-dialog': '' }, [
    el('form', {
      id: 'remove-missing-assets-form', 'data-dialog-form': '', 'data-dialog-async': 'true',
      'data-remove-missing-assets-form': '', 'data-project-id': String(projectId),
    }, [
      el('div', { class: 'error-summary', 'data-dialog-error': '', hidden: '' }, [el('p', { 'data-dialog-error-text': '' })]),
      el('footer', {}, [
        el('button', { type: 'submit', 'data-dialog-close': '' }, [], 'Cancel'),
        el('button', { type: 'submit', 'data-dialog-submit': '' }, [], 'Remove missing assets'),
      ]),
      el('div', { 'data-dialog-status': '' }),
    ]),
  ]);
}

function buildDocument({ withTrigger = true } = {}) {
  const root = el('html');
  const heading = el('div', { class: 'page-heading' }, withTrigger ? [trigger()] : []);
  const feedback = el('div', { class: 'notice notice--success', 'data-dialog-feedback': '', hidden: '' }, [el('p', { 'data-dialog-feedback-text': '' })]);
  const pending = el('div', { class: 'notice notice--warning', 'data-remove-missing-pending': '', hidden: '' }, [
    el('p', { 'data-remove-missing-pending-text': '' }),
    el('button', { type: 'button', 'data-remove-missing-pending-check': '', hidden: '' }, [], 'Check again'),
  ]);
  const dialog = buildDialog();
  [heading, feedback, pending, dialog].forEach((node) => root.appendChild(node));
  const listeners = new Map();
  const document = {
    nodeType: 9,
    activeElement: null,
    defaultView: { location: { pathname: `/projects/${PROJECT_ID}/assets`, search: '?category=7&search=x' } },
    querySelector: (selector) => root.querySelector(selector),
    querySelectorAll: (selector) => root.querySelectorAll(selector),
    getElementById: (id) => root.querySelectorAll(`#${id}`)[0] || null,
    createElement: (tag) => new FakeNode(tag),
    addEventListener: (type, listener) => { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(listener); },
    dispatchEvent: (event) => (listeners.get(event.type) || []).forEach((listener) => listener(event)),
    listenerCount: (type) => (listeners.get(type) || []).length,
    root,
  };
  root.document = document;
  return { document, root, heading, feedback, pending, dialog };
}

// The binder's state as enhanceAppDialogs creates it.
function attachBinderState(document, dialog) {
  const state = {
    document, dialog, form: dialog.querySelector('form'), submitting: false,
    beforeClose: null, submitLocked: null, preserveValuesOnError: false,
    onOpen: null, onClose: null, onSuccessfulSubmit: null, onFailedSubmit: null, onUnconfirmedSubmit: null,
  };
  dialog.__creatorCrateAppDialogState = state;
  return state;
}

function setup(options) {
  const page = buildDocument(options);
  const state = attachBinderState(page.document, page.dialog);
  expect(enhanceRemoveMissingAssets(page.document)).toBe(true);
  // The user opened the confirmation.
  page.dialog.open = true;
  state.onOpen?.();
  return { ...page, state };
}

function success(overrides = {}) {
  return {
    status: 'success', outcome: 'removed', projectId: PROJECT_ID,
    removedCount: 2, protectedCount: 1, totalMissingCandidates: 3,
    removedAssetIds: [11, 12], protectedAssetIds: [13],
    message: 'Removed 2 of 3 missing asset records. No files were deleted. Kept 1 missing asset record protected by published-release rules.',
    refresh: true,
    ...overrides,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const text = (node, selector) => node.querySelector(selector)?.textContent ?? '';
const submitDisabled = (dialog) => dialog.querySelector('[data-dialog-submit]').disabled;

beforeEach(() => {
  dialogs.closed = [];
  refresh.calls = [];
});

describe('acknowledgedRemoveMissingResult', () => {
  it('accepts only a self-consistent answer for this project', () => {
    expect(acknowledgedRemoveMissingResult(success(), PROJECT_ID)).toBeTruthy();
    expect(acknowledgedRemoveMissingResult(success(), String(PROJECT_ID))).toBeTruthy();
    expect(acknowledgedRemoveMissingResult(success({
      outcome: 'none-missing', removedCount: 0, protectedCount: 0, totalMissingCandidates: 0, removedAssetIds: [], protectedAssetIds: [],
    }), PROJECT_ID)).toBeTruthy();
    expect(acknowledgedRemoveMissingResult(success({
      outcome: 'protected-only', removedCount: 0, protectedCount: 1, totalMissingCandidates: 1, removedAssetIds: [], protectedAssetIds: [13],
    }), PROJECT_ID)).toBeTruthy();
  });

  it.each([
    ['another project', { projectId: 7 }],
    ['an unknown outcome', { outcome: 'deleted' }],
    ['counts that do not add up', { totalMissingCandidates: 4 }],
    ['ids that do not match the count', { removedAssetIds: [11] }],
    ['a non-integer id', { removedAssetIds: [11, '12'] }],
    ['a negative count', { protectedCount: -1 }],
    ['an outcome that contradicts the counts', { outcome: 'none-missing' }],
    ['a zero-removal "removed"', { removedCount: 0, removedAssetIds: [], totalMissingCandidates: 1 }],
    ['no message', { message: '' }],
    ['a non-success status', { status: 'error' }],
  ])('rejects %s', (_label, overrides) => {
    expect(acknowledgedRemoveMissingResult(success(overrides), PROJECT_ID)).toBeNull();
  });
});

describe('binding', () => {
  it('binds the page dialog once, on the page, and returns false without the action', () => {
    const { document, state } = setup();
    expect(state.preserveValuesOnError).toBe(true);
    const hooks = [state.submitLocked, state.beforeClose, state.onSuccessfulSubmit, state.onFailedSubmit];
    enhanceRemoveMissingAssets(document);
    document.dispatchEvent({ type: 'project-assets-region-loaded' });
    expect([state.submitLocked, state.beforeClose, state.onSuccessfulSubmit, state.onFailedSubmit]).toEqual(hooks);
    expect(document.listenerCount('project-assets-region-loaded')).toBe(1);
    expect(enhanceRemoveMissingAssets({ nodeType: 9, querySelector: () => null })).toBe(false);
  });

  it('leaves a native (non-async) form alone', () => {
    const page = buildDocument();
    page.dialog.querySelector('form').setAttribute('data-dialog-async', 'false');
    const state = attachBinderState(page.document, page.dialog);
    enhanceRemoveMissingAssets(page.document);
    expect(state.onSuccessfulSubmit).toBeNull();
  });

  it('binds a dialog a Project Assets refresh adopts later, once', () => {
    const page = buildDocument();
    page.dialog.remove();
    enhanceRemoveMissingAssets(page.document);
    const adopted = buildDialog();
    page.root.appendChild(adopted);
    const state = attachBinderState(page.document, adopted);
    page.document.dispatchEvent({ type: 'project-assets-region-loaded' });
    expect(typeof state.onSuccessfulSubmit).toBe('function');
    const hook = state.onSuccessfulSubmit;
    page.document.dispatchEvent({ type: 'project-assets-region-loaded' });
    expect(state.onSuccessfulSubmit).toBe(hook);
  });
});

describe('confirmation lifecycle', () => {
  it('Cancel/Escape/backdrop are allowed when idle and refused while the POST is pending', () => {
    const { state } = setup();
    expect(state.beforeClose({})).toBe(true);
    state.submitting = true;
    expect(state.beforeClose({})).toBe(false);
    state.submitting = false;
    expect(state.beforeClose({})).toBe(true);
    expect(refresh.calls).toHaveLength(0);
  });

  it('keeps an earlier beforeClose decision', () => {
    const page = buildDocument();
    const state = attachBinderState(page.document, page.dialog);
    state.beforeClose = () => false;
    enhanceRemoveMissingAssets(page.document);
    expect(state.beforeClose({})).toBe(false);
  });

  it('a reopened confirmation starts clean after a refusal', () => {
    const { dialog, state } = setup();
    state.onFailedSubmit({ status: 'error', outcome: 'refused', code: 'PROJECT_BUSY', message: 'Another project operation is already in progress. Try again. Nothing was removed.' }, { status: 409 });
    expect(text(dialog, '[data-dialog-error-text]')).toContain('Nothing was removed.');
    state.onOpen();
    expect(text(dialog, '[data-dialog-error-text]')).toBe('');
    expect(dialog.querySelector('[data-dialog-error]').hidden).toBe(true);
    expect(submitDisabled(dialog)).toBe(false);
    expect(state.submitLocked()).toBe(false);
  });
});

describe('acknowledged results', () => {
  it('closes the confirmation, reports the service result and refreshes through one GET-only refresh', async () => {
    const { feedback, state } = setup();
    expect(state.onSuccessfulSubmit(success())).toBe(true);
    expect(dialogs.closed).toEqual([REMOVE_MISSING_ASSETS_DIALOG_ID]);
    expect(feedback.hidden).toBe(false);
    expect(text(feedback, '[data-dialog-feedback-text]')).toBe(`${success().message} Updating Project Assets…`);
    expect(refresh.calls).toHaveLength(1);
    refresh.calls[0].resolve({ status: 'installed', reconciliation: {} });
    await flush();
    expect(text(feedback, '[data-dialog-feedback-text]')).toBe(success().message);
    expect(feedback.classList.contains('notice--success')).toBe(true);
  });

  it.each([
    ['none-missing', { outcome: 'none-missing', removedCount: 0, protectedCount: 0, totalMissingCandidates: 0, removedAssetIds: [], protectedAssetIds: [], message: 'No asset records were marked missing, so nothing was removed.' }],
    ['protected-only', { outcome: 'protected-only', removedCount: 0, protectedCount: 1, totalMissingCandidates: 1, removedAssetIds: [], protectedAssetIds: [13], message: 'Nothing was removed: 1 missing asset record is protected by published-release rules and was kept.' }],
  ])('reports %s as its own non-removal result, never as a removal', async (_label, overrides) => {
    const { feedback, state } = setup();
    state.onSuccessfulSubmit(success(overrides));
    refresh.calls[0].resolve({ status: 'installed' });
    await flush();
    expect(text(feedback, '[data-dialog-feedback-text]')).toBe(overrides.message);
    expect(text(feedback, '[data-dialog-feedback-text]')).not.toMatch(/^Removed/);
    expect(feedback.classList.contains('notice--warning')).toBe(true);
  });

  it('a failed refresh keeps the confirmed removal and points to the GET-only Retry; its recovery restores the plain message', async () => {
    const { feedback, state } = setup();
    state.onSuccessfulSubmit(success());
    refresh.calls[0].resolve({ status: 'failed', error: 'x' });
    await flush();
    expect(text(feedback, '[data-dialog-feedback-text]')).toBe(`${success().message} Project Assets could not refresh and may be outdated. Use Retry refresh to load the current assets.`);
    expect(feedback.classList.contains('notice--warning')).toBe(true);
    // A later Retry (or any newer load) installs and satisfies the refresh.
    refresh.calls[0].options.onRecovered({});
    expect(text(feedback, '[data-dialog-feedback-text]')).toBe(success().message);
    refresh.calls[0].options.onRecovered({});
    expect(refresh.calls).toHaveLength(1);
  });

  it('a superseded refresh says it is still updating; unavailable offers a reload of the current view', async () => {
    const first = setup();
    first.state.onSuccessfulSubmit(success());
    refresh.calls[0].resolve({ status: 'superseded' });
    await flush();
    expect(text(first.feedback, '[data-dialog-feedback-text]')).toBe(`${success().message} Project Assets is still updating.`);

    const second = setup();
    second.state.onSuccessfulSubmit(success());
    refresh.calls[1].resolve({ status: 'unavailable', url: null });
    await flush();
    expect(text(second.feedback, '[data-dialog-feedback-text]')).toContain('Project Assets could not refresh here.');
    expect(second.feedback.querySelector('[data-remove-missing-feedback-action]').getAttribute('href'))
      .toBe(`/projects/${PROJECT_ID}/assets?category=7&search=x`);
  });

  it('a stale refresh of an older result never overwrites a newer one', async () => {
    const { feedback, state } = setup();
    state.onSuccessfulSubmit(success());
    state.onSuccessfulSubmit(success({ removedCount: 1, protectedCount: 0, totalMissingCandidates: 1, removedAssetIds: [14], protectedAssetIds: [], message: 'Removed 1 of 1 missing asset record. No files were deleted.' }));
    refresh.calls[1].resolve({ status: 'installed' });
    await flush();
    refresh.calls[0].resolve({ status: 'failed' });
    refresh.calls[0].options.onRecovered({});
    await flush();
    expect(text(feedback, '[data-dialog-feedback-text]')).toBe('Removed 1 of 1 missing asset record. No files were deleted.');
  });
});

describe('refusals stay local', () => {
  it.each([
    ['busy', 409, { status: 'error', outcome: 'refused', code: 'PROJECT_BUSY', message: 'Another project operation is already in progress. Try again. Nothing was removed.' }, false],
    ['rolled back', 500, { status: 'error', outcome: 'failed', code: 'REMOVE_MISSING_DATABASE_OPERATION_FAILED', message: 'Missing asset records could not be removed. The change was rolled back, so nothing was removed.' }, false],
    ['CSRF', 403, { status: 'error', message: 'Invalid or missing CSRF token.' }, false],
    ['signed out', 401, { status: 'error', message: 'Authentication required.' }, false],
    ['archived', 409, { status: 'error', outcome: 'refused', code: 'PROJECT_ARCHIVED', message: 'This project is archived and read-only. Nothing was removed.' }, true],
    ['not found', 404, { status: 'error', outcome: 'refused', code: 'PROJECT_NOT_FOUND', message: 'Project not found. Nothing was removed.' }, true],
  ])('%s: the dialog says nothing was removed, nothing is held', (_label, status, payload, retires) => {
    const { dialog, feedback, pending, state } = setup();
    state.onFailedSubmit(payload, { status, ok: false });
    expect(text(dialog, '[data-dialog-error-text]')).toContain(payload.message);
    expect(text(dialog, '[data-dialog-error-text]')).toContain('Nothing was removed.');
    expect(dialog.open).toBe(true);
    expect(dialogs.closed).toEqual([]);
    expect(pendingRemoveMissingOperation(dialog.ownerDocument)).toBeNull();
    expect(pending.hidden).toBe(true);
    expect(feedback.hidden).toBe(true);
    expect(state.submitLocked()).toBe(retires);
    expect(submitDisabled(dialog)).toBe(retires);
    // Only an archived/unknown project re-reads the page (GET only).
    expect(refresh.calls).toHaveLength(retires ? 1 : 0);
    expect(dialog.ownerDocument.activeElement?.textContent).toBe('Cancel');
  });
});

// The shared binder's own submission gate (app-dialogs.js appDialogBindForm):
// a submit while a POST is pending or while the host locks submission sends
// nothing. Every way of submitting (click, Enter, requestSubmit, a replayed
// submit event) reaches that one gate; the real binder runs in Chromium.
function attemptSubmit(state, posts) {
  if (state.submitting || state.submitLocked?.() === true) return false;
  state.submitting = true;
  posts.push(state.form.getAttribute('data-project-id'));
  return true;
}

// A Project Assets refresh that replaces the confirmation with a freshly
// rendered one, as adoptProjectAssetsRemoveMissingDialog + enhanceAppDialogs do.
function replaceDialog(page) {
  page.document.getElementById(REMOVE_MISSING_ASSETS_DIALOG_ID)?.remove();
  const adopted = buildDialog();
  page.root.appendChild(adopted);
  const state = attachBinderState(page.document, adopted);
  page.document.dispatchEvent({ type: 'project-assets-region-loaded' });
  return { dialog: adopted, state };
}

const pendingText = (pending) => text(pending, '[data-remove-missing-pending-text]');

function expectHeld(page, state = page.state, dialog = page.dialog) {
  expect(pendingRemoveMissingOperation(page.document)).not.toBeNull();
  expect(page.pending.hidden).toBe(false);
  expect(pendingText(page.pending)).toContain('may still be processed');
  expect(pendingText(page.pending)).toContain('stays unavailable on this page');
  expect(state.submitLocked()).toBe(true);
  dialog.open = true;
  state.onOpen();
  expect(submitDisabled(dialog)).toBe(true);
  expect(text(dialog, '[data-dialog-error-text]')).toContain('another removal cannot be sent from this page');
}

// No removed or protected count is ever attributed to the lost request.
function expectNoAttribution(page) {
  expect(page.feedback.hidden).toBe(true);
  expect(pendingText(page.pending)).not.toMatch(/\bRemoved \d|\d+ (?:missing )?asset records? (?:were|was) removed|Kept \d/);
}

describe('lost or unreadable answers', () => {
  it.each([
    ['a network failure', (state) => state.onUnconfirmedSubmit()],
    ['an unexpected 500', (state) => state.onFailedSubmit({ status: 'error', outcome: 'unknown', code: 'REMOVE_MISSING_UNCONFIRMED', message: 'x' }, { status: 500 })],
    ['an unreadable error answer', (state) => state.onFailedSubmit({}, { status: 502 })],
    ['an unverifiable success', (state) => state.onSuccessfulSubmit(success({ projectId: 7 }))],
  ])('%s is held unresolved: never re-sent, never reported as removed, read only by GET', async (_label, answer) => {
    const page = setup();
    answer(page.state);
    expect(pendingRemoveMissingOperation(page.document)).toMatchObject({ projectId: String(PROJECT_ID) });
    expect(dialogs.closed).toEqual([REMOVE_MISSING_ASSETS_DIALOG_ID]);
    expect(pendingText(page.pending)).toMatch(/^Checking Project Assets…/);
    expect(submitDisabled(page.dialog)).toBe(true);
    // The only request is the read.
    expect(refresh.calls).toHaveLength(1);
    expectNoAttribution(page);
    expectHeld(page);
  });
});

describe('WP10B-F1: a read never settles the lost removal', () => {
  it('C1: an early read still showing the missing rows keeps the hold; another removal sends nothing', async () => {
    const page = setup();
    const posts = [];
    expect(attemptSubmit(page.state, posts)).toBe(true);
    page.state.submitting = false;
    page.state.onUnconfirmedSubmit();
    // The read installs and the page still lists missing records (trigger rendered).
    refresh.calls[0].resolve({ status: 'installed' });
    await flush();
    expect(pendingText(page.pending)).toContain('some are still marked missing');
    expect(pendingText(page.pending)).toContain('does not show whether the earlier request arrived, finished or failed');
    expectHeld(page);
    expect(attemptSubmit(page.state, posts)).toBe(false);
    expect(posts).toEqual([String(PROJECT_ID)]);
    expect(refresh.calls).toHaveLength(1);
    expectNoAttribution(page);
  });

  it('C2: a read showing no missing rows attributes nothing and keeps the hold', async () => {
    const page = setup({ withTrigger: false });
    page.state.onUnconfirmedSubmit();
    refresh.calls[0].resolve({ status: 'installed' });
    await flush();
    expect(pendingText(page.pending)).toContain('with no missing asset records');
    expect(pendingText(page.pending)).toContain('does not show which request, scan or other change removed them');
    expect(pendingText(page.pending)).toContain('still unknown');
    expectNoAttribution(page);
    expectHeld(page);
    // Check again stays available, GET only.
    expect(page.pending.querySelector('[data-remove-missing-pending-check]').hidden).toBe(false);
  });

  it('C3: a failed read, dismissal and reopening keep the hold; Check again sends only GETs', async () => {
    const page = setup();
    const posts = [];
    page.state.onUnconfirmedSubmit();
    refresh.calls[0].resolve({ status: 'failed' });
    await flush();
    const check = page.pending.querySelector('[data-remove-missing-pending-check]');
    expect(check.hidden).toBe(false);
    expect(pendingText(page.pending)).toContain('Could not load Project Assets.');
    expect(page.document.activeElement).toBe(check);
    // Dismiss and reopen twice.
    for (let round = 0; round < 2; round += 1) {
      page.dialog.open = true;
      page.state.onOpen();
      expect(page.state.beforeClose({})).toBe(true);
      page.dialog.open = false;
      page.state.onClose?.();
      expect(attemptSubmit(page.state, posts)).toBe(false);
    }
    check.click();
    check.click();
    expect(refresh.calls).toHaveLength(3);
    refresh.calls[2].resolve({ status: 'installed' });
    await flush();
    // Repeated Check again reads keep it held.
    check.click();
    refresh.calls[3].resolve({ status: 'installed' });
    await flush();
    expect(page.document.activeElement).toBe(check);
    expectHeld(page);
    expect(posts).toEqual([]);
  });

  it('C4: superseded and stale reads never release the hold nor clear the warning', async () => {
    const page = setup();
    page.state.onUnconfirmedSubmit();
    refresh.calls[0].resolve({ status: 'superseded' });
    await flush();
    expect(pendingText(page.pending)).toContain('Project Assets is still updating.');
    // The newer load installs (onRecovered): an observation only.
    refresh.calls[0].options.onRecovered({});
    expectHeld(page);
    const check = page.pending.querySelector('[data-remove-missing-pending-check]');
    check.click();
    // An old read recovering while a newer Check again is reading changes nothing.
    refresh.calls[0].options.onRecovered({});
    expect(pendingText(page.pending)).toMatch(/^Checking Project Assets…/);
    check.click();
    refresh.calls[2].resolve({ status: 'installed' });
    await flush();
    refresh.calls[1].resolve({ status: 'failed' });
    await flush();
    expect(pendingText(page.pending)).toContain('some are still marked missing');
    expectHeld(page);
  });

  it('C5: category, text filter, Grid/List and crop-style reads keep the hold and send no removal', async () => {
    const page = setup();
    const posts = [];
    page.state.onUnconfirmedSubmit();
    refresh.calls[0].resolve({ status: 'installed' });
    await flush();
    // Each filter or view navigation is a Project Assets GET that installs and
    // announces the region; a zero-match one also removes the trigger.
    for (const zeroMatch of [false, true, false, false]) {
      if (zeroMatch) page.heading.querySelector(`[data-dialog-open="${REMOVE_MISSING_ASSETS_DIALOG_ID}"]`)?.remove();
      page.document.dispatchEvent({ type: 'project-assets-region-loaded' });
      expect(attemptSubmit(page.state, posts)).toBe(false);
      expectHeld(page);
    }
    expect(posts).toEqual([]);
    expect(refresh.calls).toHaveLength(1);
  });

  it('C6: a confirmation the live region replaces is bound blocked, before and after opening', async () => {
    const page = setup();
    const posts = [];
    page.state.onUnconfirmedSubmit();
    refresh.calls[0].resolve({ status: 'installed' });
    await flush();
    const replaced = replaceDialog(page);
    expect(replaced.state.submitLocked()).toBe(true);
    expect(submitDisabled(replaced.dialog)).toBe(true);
    expect(text(replaced.dialog, '[data-dialog-error-text]')).toContain('another removal cannot be sent from this page');
    expect(attemptSubmit(replaced.state, posts)).toBe(false);
    expectHeld(page, replaced.state, replaced.dialog);
    // A second replacement too.
    const again = replaceDialog(page);
    expect(attemptSubmit(again.state, posts)).toBe(false);
    expect(posts).toEqual([]);
  });

  it('C8: double click, Enter, requestSubmit and a replayed confirmation reach the one gate and send one POST', () => {
    const page = setup();
    const posts = [];
    // Double click / Enter while the first POST is pending.
    expect(attemptSubmit(page.state, posts)).toBe(true);
    expect(attemptSubmit(page.state, posts)).toBe(false);
    expect(attemptSubmit(page.state, posts)).toBe(false);
    expect(page.state.beforeClose({})).toBe(false);
    page.state.submitting = false;
    page.state.onUnconfirmedSubmit();
    // requestSubmit, Enter and a replayed submit after the answer was lost.
    for (let attempt = 0; attempt < 3; attempt += 1) expect(attemptSubmit(page.state, posts)).toBe(false);
    // Replaying the confirmation (reopen, then submit).
    page.dialog.open = true;
    page.state.onOpen();
    expect(attemptSubmit(page.state, posts)).toBe(false);
    expect(posts).toHaveLength(1);
  });

  it('C9: other Project Assets feedback and refreshes never discard the unresolved warning', async () => {
    const page = setup();
    page.state.onUnconfirmedSubmit();
    refresh.calls[0].resolve({ status: 'installed' });
    await flush();
    const warning = pendingText(page.pending);
    // Another feature reports in the shared feedback notice, then hides it.
    page.feedback.querySelector('[data-dialog-feedback-text]').textContent = 'Asset order saved.';
    page.feedback.hidden = false;
    page.feedback.hidden = true;
    // Another feature's mutation refresh installs.
    page.document.dispatchEvent({ type: 'project-assets-region-loaded' });
    expect(pendingText(page.pending)).toBe(warning);
    expectHeld(page);
    // A stray success answer cannot reach an unresolved page: its submit is locked.
    expect(attemptSubmit(page.state, [])).toBe(false);
  });
});

describe('WP10B-F1: authoritative settlement (C7)', () => {
  it.each([
    ['removed', success(), 'success'],
    ['none missing', success({ outcome: 'none-missing', removedCount: 0, protectedCount: 0, totalMissingCandidates: 0, removedAssetIds: [], protectedAssetIds: [], message: 'No asset records were marked missing, so nothing was removed.' }), 'warning'],
    ['protected only', success({ outcome: 'protected-only', removedCount: 0, protectedCount: 1, totalMissingCandidates: 1, removedAssetIds: [], protectedAssetIds: [13], message: 'Nothing was removed: 1 missing asset record is protected by published-release rules and was kept.' }), 'warning'],
  ])('an acknowledged %s answer settles with no hold', async (_label, payload, variant) => {
    const page = setup();
    const posts = [];
    expect(attemptSubmit(page.state, posts)).toBe(true);
    page.state.submitting = false;
    page.state.onSuccessfulSubmit(payload);
    refresh.calls[0].resolve({ status: 'installed' });
    await flush();
    expect(pendingRemoveMissingOperation(page.document)).toBeNull();
    expect(page.pending.hidden).toBe(true);
    expect(text(page.feedback, '[data-dialog-feedback-text]')).toBe(payload.message);
    expect(page.feedback.classList.contains(`notice--${variant}`)).toBe(true);
    page.dialog.open = true;
    page.state.onOpen();
    expect(page.state.submitLocked()).toBe(false);
    expect(attemptSubmit(page.state, posts)).toBe(true);
    expect(posts).toHaveLength(2);
  });

  it('an acknowledged answer whose refresh fails still settles the mutation; display sync is reported separately', async () => {
    const page = setup();
    page.state.onSuccessfulSubmit(success());
    refresh.calls[0].resolve({ status: 'failed' });
    await flush();
    expect(pendingRemoveMissingOperation(page.document)).toBeNull();
    expect(page.state.submitLocked()).toBe(false);
    expect(text(page.feedback, '[data-dialog-feedback-text]')).toContain('Use Retry refresh');
  });

  it.each([
    ['refused before mutation', 409, { status: 'error', outcome: 'refused', code: 'PROJECT_BUSY', message: 'Another project operation is already in progress. Try again. Nothing was removed.' }],
    ['proven rollback', 500, { status: 'error', outcome: 'failed', code: 'REMOVE_MISSING_DATABASE_OPERATION_FAILED', message: 'Missing asset records could not be removed. The change was rolled back, so nothing was removed.' }],
  ])('%s releases the confirmation with no hold', (_label, status, payload) => {
    const page = setup();
    const posts = [];
    expect(attemptSubmit(page.state, posts)).toBe(true);
    page.state.submitting = false;
    page.state.onFailedSubmit(payload, { status, ok: false });
    expect(pendingRemoveMissingOperation(page.document)).toBeNull();
    expect(page.pending.hidden).toBe(true);
    expect(text(page.dialog, '[data-dialog-error-text]')).toContain('Nothing was removed.');
    expect(attemptSubmit(page.state, posts)).toBe(true);
    expect(posts).toHaveLength(2);
  });
});

describe('WP10B-F1: confirmation scope wording (C10)', async () => {
  const { readFileSync } = await import('node:fs');
  const template = readFileSync(new URL('../src/views/projects/assets.njk', import.meta.url), 'utf8');
  const start = template.indexOf("dialog.render('remove-missing-assets-dialog'");
  const markup = template.slice(start, template.indexOf('{% endcall %}', start)).replace(/\s+/g, ' ');

  it('describes execution-time, project-wide scope, hidden and protected assets, and no file deletion', () => {
    expect(start).toBeGreaterThan(0);
    expect(markup).not.toContain('when you confirm');
    expect(markup).toContain('marked missing when the removal is processed');
    expect(markup).toContain('every asset record in {{ project.title }}');
    expect(markup).toContain('including any hidden by the current filters or category');
    expect(markup).toContain('A scan or another change may mark more records missing, or fewer, between now and then.');
    expect(markup).toContain('protected by published-release rules will remain');
    expect(markup).toContain('removes eligible missing database records');
    expect(markup).toContain('No files are deleted.');
  });
});
