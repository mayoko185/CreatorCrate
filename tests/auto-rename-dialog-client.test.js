import { describe, it, expect, vi, beforeEach } from 'vitest';

// The shared binder and the WP09A refresh are covered by their own suites (and
// together in Chromium); here they are stand-ins, so the controller's own
// decisions are observable: which requests it sends, what it opens, and what it
// reports.
const appDialogs = vi.hoisted(() => ({ opens: 0, opened: [], closed: [], states: new Map() }));
const refresh = vi.hoisted(() => ({ calls: [], results: [] }));

vi.mock('../src/static/client/app-dialogs.js', () => ({
  appDialogOpenCount: () => appDialogs.opens,
  enhanceAppDialogs: (document) => {
    const dialog = document.getElementById('auto-rename-confirmation-dialog');
    if (dialog && !dialog.__creatorCrateAppDialogState) {
      dialog.__creatorCrateAppDialogState = {
        document, dialog, form: dialog.querySelector('form'), submitting: false,
        beforeClose: null, onClose: null, onSuccessfulSubmit: null, onFailedSubmit: null, onUnconfirmedSubmit: null,
      };
      appDialogs.states.set(dialog, dialog.__creatorCrateAppDialogState);
    }
    return 1;
  },
  openAppDialogById: (document, id, opener) => {
    appDialogs.opens += 1;
    const dialog = document.getElementById(id);
    dialog.open = true;
    appDialogs.opened.push({ id, opener });
    return true;
  },
  closeAppDialogById: (document, id) => {
    const dialog = document.getElementById(id);
    const state = dialog.__creatorCrateAppDialogState;
    if (state.beforeClose && state.beforeClose({}) !== true) return false;
    dialog.open = false;
    appDialogs.closed.push(id);
    state.onClose?.();
    return true;
  },
}));

vi.mock('../src/static/client/live-regions.js', () => ({
  refreshProjectAssetsAfterMutation: (document, options = {}) => {
    refresh.calls.push(options);
    return Promise.resolve(refresh.results.shift() || { status: 'installed' });
  },
}));

const { observeAutoRenamePaths, enhanceAutoRenameDialog, pendingAutoRenameOperation } = await import('../src/static/client/auto-rename-dialog.js');

// A minimal element tree with the selectors the controller uses.
function matchesSimple(node, part) {
  const re = /^([a-z]+)?((?:\[[^\]]+\]|#[\w-]+|:not\(\[[^\]]+\]\))*)$/i;
  const match = part.match(re);
  if (!match) throw new Error(`Unsupported selector ${part}`);
  if (match[1] && node.tagName !== match[1].toUpperCase()) return false;
  for (const token of match[2].match(/\[[^\]]+\]|#[\w-]+|:not\(\[[^\]]+\]\)/g) || []) {
    if (token.startsWith('#')) {
      if (node.getAttribute('id') !== token.slice(1)) return false;
    } else if (token.startsWith(':not')) {
      if (matchesSimple(node, token.slice(5, -1))) return false;
    } else {
      const [, name, value] = token.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
      if (name === 'open' && node.tagName === 'DIALOG') {
        if (!node.open) return false;
      } else if (name === 'disabled' && 'disabled' in node) {
        if (!node.disabled) return false;
      } else if (!node.hasAttribute(name) || (value !== undefined && node.getAttribute(name) !== value)) return false;
    }
  }
  return true;
}

function matches(node, selector) {
  return selector.split(',').some((alternative) => {
    const parts = alternative.trim().split(/\s+/);
    if (!matchesSimple(node, parts.at(-1))) return false;
    let ancestor = node.parentNode;
    for (let index = parts.length - 2; index >= 0; index -= 1) {
      while (ancestor && !(ancestor.tagName && matchesSimple(ancestor, parts[index]))) ancestor = ancestor.parentNode;
      if (!ancestor) return false;
      ancestor = ancestor.parentNode;
    }
    return true;
  });
}

function makeDocument() {
  const document = {
    nodeType: 9,
    listeners: [],
    activeElement: null,
    defaultView: null,
    createElement: (tag) => makeElement(document, tag),
    importNode: (node) => node,
    addEventListener(type, handler) { this.listeners.push({ type, handler }); },
    querySelector(selector) { return this.body.querySelector(selector); },
    querySelectorAll(selector) { return this.body.querySelectorAll(selector); },
    getElementById(id) { return this.body.querySelector(`#${id}`); },
  };
  document.body = makeElement(document, 'body');
  return document;
}

function makeElement(document, tag, attrs = {}, children = []) {
  const attributes = new Map(Object.entries(attrs));
  const node = {
    tagName: tag.toUpperCase(),
    ownerDocument: document,
    parentNode: null,
    children: [],
    textContent: '',
    hidden: false,
    disabled: Object.hasOwn(attrs, 'disabled'),
    open: false,
    focused: 0,
    classList: {
      values: new Set(),
      toggle(name, force) { if (force) this.values.add(name); else this.values.delete(name); },
      contains(name) { return this.values.has(name); },
    },
    listeners: [],
    getAttribute: (name) => (attributes.has(name) ? attributes.get(name) : null),
    hasAttribute: (name) => attributes.has(name),
    setAttribute(name, value) { attributes.set(name, String(value)); if (name === 'disabled') this.disabled = true; },
    removeAttribute(name) { attributes.delete(name); if (name === 'disabled') this.disabled = false; },
    addEventListener(type, handler) { this.listeners.push({ type, handler }); },
    click() { this.listeners.filter((entry) => entry.type === 'click').forEach((entry) => entry.handler({})); },
    focus() { this.focused += 1; document.activeElement = this; },
    matches(selector) { return matches(this, selector); },
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    replaceChildren(...nodes) {
      this.children.forEach((child) => { child.parentNode = null; });
      this.children = [];
      nodes.forEach((child) => this.appendChild(child));
    },
    remove() {
      if (!this.parentNode) return;
      this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
      this.parentNode = null;
    },
    get isConnected() {
      let current = this;
      while (current.parentNode) current = current.parentNode;
      return current === document.body;
    },
    querySelectorAll(selector) {
      const found = [];
      const walk = (parent) => parent.children.forEach((child) => {
        if (matches(child, selector)) found.push(child);
        walk(child);
      });
      walk(this);
      return found;
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
  };
  if (Object.hasOwn(attrs, 'value')) node.value = attrs.value;
  children.forEach((child) => node.appendChild(child));
  return node;
}

class FakeFormData {
  constructor(form) {
    this.entries = form.querySelectorAll('input[name]').map((input) => [input.getAttribute('name'), input.value]);
  }
  get(name) { return this.entries.find(([key]) => key === name)?.[1] ?? null; }
  [Symbol.iterator]() { return this.entries[Symbol.iterator](); }
}

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  return { ok, status, json: () => Promise.resolve(payload) };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup() {
  const document = makeDocument();
  const el = (tag, attrs, children) => makeElement(document, tag, attrs, children);
  const order = el('input', { name: 'orderedAssetIds', value: '[3,2,1,4]' });
  const selection = el('input', { name: 'selectedAssetIds', value: '[3,1]' });
  const live = el('div', { 'data-auto-rename-live': '' });
  const form = el('form', { 'data-auto-rename-form': '', action: '/projects/7/assets/auto-rename/preview' }, [
    el('input', { name: '_csrf', value: 'csrf' }),
    el('input', { name: 'categoryId', value: '5' }),
    order, selection, live,
  ]);
  const submit = el('button', { 'data-auto-rename-submit': '' });
  const mount = el('div', { 'data-auto-rename-dialog-mount': '' });
  const feedbackText = el('p', { 'data-dialog-feedback-text': '' });
  const feedback = el('div', { 'data-dialog-feedback': '', hidden: '' }, [feedbackText]);
  const pendingText = el('p', { 'data-auto-rename-pending-text': '' });
  const pendingCheck = el('button', { 'data-auto-rename-pending-check': '', hidden: '' });
  const pending = el('div', { 'data-auto-rename-pending': '', hidden: '' }, [pendingText, pendingCheck]);
  pending.hidden = true;
  pendingCheck.hidden = true;
  [feedback, pending, form, submit, mount].forEach((node) => document.body.appendChild(node));

  const requests = [];
  const fetchQueue = [];
  const window = {
    fetch: vi.fn((url, options = {}) => {
      requests.push({ url, method: options.method || 'GET', body: options.body ? String(options.body) : null, headers: options.headers });
      const next = fetchQueue.shift();
      return typeof next === 'function' ? next() : Promise.resolve(next);
    }),
    FormData: FakeFormData,
    URLSearchParams,
    AbortController,
    DOMParser: class {
      parseFromString(html) {
        return { body: { children: [buildDialog(document, JSON.parse(html))] } };
      }
    },
    setTimeout: (callback) => setTimeout(callback, 0),
    location: { pathname: '/projects/7/assets', search: '?category=5&extension=png' },
  };
  document.defaultView = window;

  const submitPreview = ({ prevented = false } = {}) => {
    const event = {
      target: form,
      submitter: submit,
      defaultPrevented: prevented,
      preventDefault: vi.fn(() => { event.defaultPrevented = true; }),
    };
    document.listeners.filter((entry) => entry.type === 'submit').forEach((entry) => entry.handler(event));
    return event;
  };
  return {
    document, form, order, selection, live, submit, mount, feedback, feedbackText,
    pending, pendingText, pendingCheck, requests, fetchQueue, window, submitPreview,
  };
}

// The fake parser reads its "fragment" as a description of the dialog to build.
function buildDialog(document, { projectId, token, attemptIds = [], canApply = true }) {
  const el = (tag, attrs, children) => makeElement(document, tag, attrs, children);
  return el('dialog', { id: 'auto-rename-confirmation-dialog' }, [
    el('form', {
      action: `/projects/${projectId}/assets/auto-rename/apply`,
      'data-dialog-async': 'true',
    }, [
      el('div', { 'data-dialog-error': '' }, [el('p', { 'data-dialog-error-text': '' })]),
      el('input', { name: 'planToken', value: token }),
      ...attemptIds.map((value) => el('input', { name: 'attemptId', value })),
      el('div', { 'data-dialog-status': '' }),
      el('footer', {}, [
        el('button', { 'data-dialog-close': '' }),
        el('button', canApply ? { 'data-dialog-submit': '' } : { 'data-dialog-submit': '', disabled: '' }),
      ]),
    ]),
  ]);
}

const ATTEMPT = '0123456789abcdef0123456789abcdef';
const STATE_URL = `/projects/7/assets/auto-rename/state?categoryId=5&attempt=${ATTEMPT}`;
// Each Preview is its own server-issued attempt; the first review of a test is ATTEMPT.
const attemptFor = (token) => Buffer.from(token).toString('hex').padEnd(32, '0').slice(0, 32);

// What the server recorded for one completed attempt (ATTEMPT unless named).
function receipt(fields, attemptId = ATTEMPT) {
  return { attemptId, state: 'completed', recorded: true, ...fields };
}

// A state read: current database paths, plus the attempt's receipt when one is recorded.
function stateResponse(paths, operation = { attemptId: ATTEMPT, state: 'issued', recorded: false }) {
  return jsonResponse({
    status: 'success', projectId: 7, categoryId: 5, operation,
    assets: paths.map(([assetId, relativePath]) => ({ assetId, relativePath })),
  });
}
const ORIGINAL_PATHS = [[3, 'wip/c.png'], [2, 'wip/b.jpg'], [1, 'wip/a.png'], [4, 'wip/d.jpg']];
const PROPOSED_PATHS = [[3, 'wip/p-wip-01.png'], [2, 'wip/b.jpg'], [1, 'wip/p-wip-02.png'], [4, 'wip/d.jpg']];

const ITEMS = [
  { assetId: 3, status: 'rename', currentRelativePath: 'wip/c.png', proposedRelativePath: 'wip/p-wip-01.png' },
  { assetId: 1, status: 'rename', currentRelativePath: 'wip/a.png', proposedRelativePath: 'wip/p-wip-02.png' },
];

function previewPayload(overrides = {}) {
  const payload = {
    status: 'success', projectId: 7, categoryId: 5, canApply: true, planToken: 'signed-token',
    attemptId: overrides.planToken ? attemptFor(overrides.planToken) : ATTEMPT,
    orderedAssetIds: [3, 2, 1, 4], selectedAssetIds: [1, 3], items: ITEMS, ...overrides,
  };
  payload.dialogHtml = JSON.stringify({
    projectId: payload.projectId, token: payload.planToken, attemptIds: [payload.attemptId], canApply: payload.canApply,
  });
  return payload;
}

async function openReview(env, overrides = {}) {
  env.fetchQueue.push(jsonResponse(previewPayload(overrides)));
  env.submitPreview();
  await flush();
  const dialog = env.document.getElementById('auto-rename-confirmation-dialog');
  return { dialog, state: dialog.__creatorCrateAppDialogState };
}

// Dismisses the open review the way the binder does.
function closeReview(env) {
  const dialog = env.document.getElementById('auto-rename-confirmation-dialog');
  const state = dialog.__creatorCrateAppDialogState;
  if (state.beforeClose && state.beforeClose({}) !== true) return false;
  dialog.open = false;
  state.onClose?.();
  return true;
}

beforeEach(() => {
  appDialogs.opens = 0;
  appDialogs.opened.length = 0;
  appDialogs.closed.length = 0;
  refresh.calls.length = 0;
  refresh.results.length = 0;
});

describe('observeAutoRenamePaths', () => {
  const at = (...paths) => paths.map(([assetId, relativePath]) => ({ assetId, relativePath }));

  it('describes current paths against the review, hidden members included, without any outcome', () => {
    expect(observeAutoRenamePaths(ITEMS, at(...PROPOSED_PATHS))).toBe('proposed');
    expect(observeAutoRenamePaths(ITEMS, at([3, 'wip/c.png'], [1, 'wip/a.png']))).toBe('original');
    expect(observeAutoRenamePaths(ITEMS, at([3, 'wip/p-wip-01.png'], [1, 'wip/a.png']))).toBe('mixed');
  });

  it('is other for a missing asset, an unexpected path, or a review without renames', () => {
    expect(observeAutoRenamePaths(ITEMS, at([3, 'wip/p-wip-01.png']))).toBe('other');
    expect(observeAutoRenamePaths(ITEMS, at([3, 'wip/.tmp-1'], [1, 'wip/a.png']))).toBe('other');
    expect(observeAutoRenamePaths([{ assetId: 1, status: 'unchanged' }], at([1, 'wip/a.png']))).toBe('other');
    expect(observeAutoRenamePaths(ITEMS, null)).toBe('other');
  });
});

describe('Auto Rename local Preview', () => {
  it('binds one document listener and leaves pages without a mount native', () => {
    const env = setup();
    expect(enhanceAutoRenameDialog(env.document)).toBe(true);
    expect(enhanceAutoRenameDialog(env.document)).toBe(true);
    expect(enhanceAutoRenameDialog(env.form)).toBe(true);
    expect(env.document.listeners.filter((entry) => entry.type === 'submit')).toHaveLength(1);

    const native = makeDocument();
    expect(enhanceAutoRenameDialog(native)).toBe(false);
    expect(native.listeners).toHaveLength(0);
  });

  it('posts the validated form once, mounts the server fragment and opens it from the invoking control', async () => {
    const env = setup();
    enhanceAutoRenameDialog(env.document);
    const { dialog, state } = await openReview(env);

    expect(env.requests).toHaveLength(1);
    expect(env.requests[0]).toMatchObject({ url: '/projects/7/assets/auto-rename/preview', method: 'POST', headers: { Accept: 'application/json' } });
    const sent = new URLSearchParams(env.requests[0].body);
    expect(sent.get('orderedAssetIds')).toBe('[3,2,1,4]');
    expect(sent.get('selectedAssetIds')).toBe('[3,1]');
    expect(sent.get('categoryId')).toBe('5');
    expect(env.mount.children).toEqual([dialog]);
    expect(appDialogs.opened).toEqual([{ id: 'auto-rename-confirmation-dialog', opener: env.submit }]);
    expect(state.submitLocked()).toBe(false);
    expect(env.form.hasAttribute('aria-busy')).toBe(false);
    expect(env.live.textContent).toBe('');
  });

  it('leaves a submission the ordering controller refused alone', () => {
    const env = setup();
    enhanceAutoRenameDialog(env.document);
    const event = env.submitPreview({ prevented: true });
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(env.requests).toHaveLength(0);
  });

  it('never opens a Preview whose selection or order changed while it loaded', async () => {
    const env = setup();
    enhanceAutoRenameDialog(env.document);
    const pending = deferred();
    env.fetchQueue.push(() => pending.promise);
    env.submitPreview();
    env.selection.value = '[3]';
    pending.resolve(jsonResponse(previewPayload()));
    await flush();
    expect(appDialogs.opened).toHaveLength(0);
    expect(env.mount.children).toHaveLength(0);
    expect(env.live.textContent).toContain('changed while the review loaded');

    const reordered = deferred();
    env.fetchQueue.push(() => reordered.promise);
    env.submitPreview();
    env.order.value = '[1,2,3,4]';
    reordered.resolve(jsonResponse(previewPayload()));
    await flush();
    expect(appDialogs.opened).toHaveLength(0);
  });

  it('opens only the newest of two Previews and none after another dialog opened', async () => {
    const env = setup();
    enhanceAutoRenameDialog(env.document);
    const older = deferred();
    const newer = deferred();
    env.fetchQueue.push(() => older.promise, () => newer.promise);
    env.submitPreview();
    env.submitPreview();
    newer.resolve(jsonResponse(previewPayload({ planToken: 'newer' })));
    await flush();
    older.resolve(jsonResponse(previewPayload({ planToken: 'older' })));
    await flush();
    expect(appDialogs.opened).toHaveLength(1);
    expect(env.document.querySelector('input[name="planToken"]').value).toBe('newer');

    const next = setup();
    enhanceAutoRenameDialog(next.document);
    const late = deferred();
    next.fetchQueue.push(() => late.promise);
    next.submitPreview();
    appDialogs.opens += 1; // Another dialog was opened (and maybe dismissed) meanwhile.
    late.resolve(jsonResponse(previewPayload()));
    await flush();
    expect(next.mount.children).toHaveLength(0);
  });

  it('reports a refused or failed Preview locally without mounting anything', async () => {
    const env = setup();
    enhanceAutoRenameDialog(env.document);
    env.fetchQueue.push(jsonResponse({ status: 'error', code: 'ORDER_INVALID', message: 'Order invalid.' }, { ok: false, status: 422 }));
    env.submitPreview();
    await flush();
    expect(env.feedbackText.textContent).toBe('Order invalid.');
    expect(env.feedback.classList.contains('notice--error')).toBe(true);
    expect(env.mount.children).toHaveLength(0);

    env.fetchQueue.push(() => Promise.reject(new TypeError('offline')));
    env.submitPreview();
    await flush();
    expect(env.feedbackText.textContent).toBe('Auto Rename preview could not be loaded. Nothing was renamed.');

    // A fragment whose token does not match the reviewed one is not mounted.
    const mismatched = previewPayload();
    mismatched.dialogHtml = JSON.stringify({ projectId: 7, token: 'other' });
    env.fetchQueue.push(jsonResponse(mismatched));
    env.submitPreview();
    await flush();
    expect(env.mount.children).toHaveLength(0);
    expect(appDialogs.opened).toHaveLength(0);
  });
});

describe('Auto Rename local Apply outcomes', () => {
  it('retires a refused review: Apply stays locked and only Cancel remains', async () => {
    const env = setup();
    enhanceAutoRenameDialog(env.document);
    const { dialog, state } = await openReview(env);
    state.onFailedSubmit({ status: 'error', code: 'STALE_PLAN', outcome: 'refused', message: 'The rename preview is no longer current.' }, { status: 409 });
    expect(state.submitLocked()).toBe(true);
    expect(dialog.querySelector('[data-dialog-submit]').disabled).toBe(true);
    expect(dialog.querySelector('[data-dialog-error-text]').textContent).toContain('choose Auto Rename again');
    expect(dialog.querySelector('footer [data-dialog-close]').focused).toBe(1);
    expect(env.requests.filter((request) => request.method !== 'GET')).toHaveLength(1);
    expect(refresh.calls).toHaveLength(0);

    // A CSRF refusal never reached the route.
    const second = setup();
    enhanceAutoRenameDialog(second.document);
    const review = await openReview(second);
    review.state.onFailedSubmit({ status: 'error', message: 'Invalid or missing CSRF token.' }, { status: 403 });
    expect(review.state.submitLocked()).toBe(true);
    expect(second.requests).toHaveLength(1);
  });

  it('reports a confirmed rename, closes, refreshes once and treats only installed as current', async () => {
    const env = setup();
    enhanceAutoRenameDialog(env.document);
    const { state } = await openReview(env);
    expect(state.onSuccessfulSubmit({ status: 'success', outcome: 'committed', projectId: 7, attemptId: ATTEMPT, renamed: 2, message: 'Renamed 2 assets. Skipped 0 unchanged assets.' })).toBe(true);
    expect(state.submitLocked()).toBe(true);
    expect(appDialogs.closed).toEqual(['auto-rename-confirmation-dialog']);
    expect(refresh.calls).toHaveLength(1);
    expect(env.feedbackText.textContent).toContain('Updating Project Assets');
    await flush();
    expect(env.feedbackText.textContent).toBe('Renamed 2 assets. Skipped 0 unchanged assets.');
    await flush();
    expect(env.mount.children).toHaveLength(0);
    expect(env.requests).toHaveLength(1);
  });

  it('keeps the confirmed success through a failed refresh and restores it once on recovery', async () => {
    const env = setup();
    enhanceAutoRenameDialog(env.document);
    const { state } = await openReview(env);
    refresh.results.push({ status: 'failed' });
    state.onSuccessfulSubmit({ status: 'success', outcome: 'committed', projectId: 7, attemptId: ATTEMPT, renamed: 2, message: 'Renamed 2 assets.' });
    await flush();
    expect(env.feedbackText.textContent).toBe('Renamed 2 assets. Project Assets could not refresh and may be outdated. Use Retry to load the current files.');
    expect(env.feedback.classList.contains('notice--warning')).toBe(true);
    const { onRecovered } = refresh.calls[0];
    onRecovered({});
    onRecovered({});
    expect(env.feedbackText.textContent).toBe('Renamed 2 assets.');
    expect(env.feedback.classList.contains('notice--success')).toBe(true);
    expect(refresh.calls).toHaveLength(1);
    expect(env.requests).toHaveLength(1);
  });

  it('never claims a superseded or unavailable refresh synchronized the page', async () => {
    for (const [status, text, action] of [
      ['superseded', 'Renamed 1 asset. Project Assets is still updating.', null],
      ['unavailable', 'Renamed 1 asset. Project Assets could not refresh here. Reload the page to see the renamed files.', '/projects/7/assets?category=5&extension=png'],
    ]) {
      const env = setup();
      enhanceAutoRenameDialog(env.document);
      const { state } = await openReview(env);
      refresh.results.push({ status });
      state.onSuccessfulSubmit({ status: 'success', outcome: 'committed', projectId: 7, attemptId: ATTEMPT, renamed: 1, message: 'Renamed 1 asset.' });
      await flush();
      expect(env.feedbackText.textContent).toBe(text);
      expect(env.feedback.querySelector('[data-auto-rename-feedback-action]')?.href ?? null).toBe(action);
    }
  });

  it('holds an unknown outcome as a page operation and settles it only from the recorded receipt', async () => {
    const env = setup();
    enhanceAutoRenameDialog(env.document);
    const { dialog, state } = await openReview(env);
    env.fetchQueue.push(() => Promise.reject(new TypeError('offline')));
    state.onUnconfirmedSubmit();
    expect(state.submitLocked()).toBe(true);
    expect(pendingAutoRenameOperation(env.document, 7)).toMatchObject({ state: 'unresolved', attemptId: ATTEMPT });
    expect(env.pending.hidden).toBe(false);
    await flush();
    // Answered: the review may close, since the page notice keeps the operation.
    expect(state.beforeClose({})).toBe(true);
    expect(dialog.querySelector('[data-dialog-error-text]').textContent).toContain('Auto Rename may have been applied. It was not sent again.');
    expect(env.pendingText.textContent).toContain('stays unavailable for this project');
    expect(env.pendingCheck.hidden).toBe(false);
    const check = dialog.querySelector('[data-auto-rename-check]');
    expect(check).not.toBeNull();

    env.fetchQueue.push(stateResponse(PROPOSED_PATHS, receipt({ outcome: 'committed', message: 'Renamed 2 assets. Skipped 0 unchanged assets.', renamed: 2, unchanged: 0, })));
    check.click();
    await flush();
    await flush();
    expect(env.requests.slice(1).map((request) => [request.method, request.url])).toEqual([
      ['GET', STATE_URL],
      ['GET', STATE_URL],
    ]);
    expect(appDialogs.closed).toEqual(['auto-rename-confirmation-dialog']);
    expect(env.feedbackText.textContent).toBe('Auto Rename was applied. Renamed 2 assets. Skipped 0 unchanged assets.');
    expect(pendingAutoRenameOperation(env.document, 7)).toBeNull();
    expect(env.pending.hidden).toBe(true);
    expect(refresh.calls).toHaveLength(1);
  });

  it('never settles from database names alone: original or new names leave it unresolved', async () => {
    const env = setup();
    enhanceAutoRenameDialog(env.document);
    const { dialog, state } = await openReview(env);
    // An unreadable answer, then a read that finds the original names and no receipt.
    env.fetchQueue.push(stateResponse(ORIGINAL_PATHS));
    state.onFailedSubmit({}, { ok: true, status: 200 });
    await flush();
    await flush();
    const text = dialog.querySelector('[data-dialog-error-text]').textContent;
    expect(text).toContain('The server has no result for this Auto Rename yet');
    expect(text).toContain('original names; that alone does not show whether files on disk changed');
    expect(text).not.toMatch(/had not been applied|was not applied|restored/);
    expect(pendingAutoRenameOperation(env.document, 7)?.state).toBe('unresolved');
    expect(state.submitLocked()).toBe(true);
    expect(refresh.calls).toHaveLength(0);

    // Every reviewed file at its new name is still no proof this Apply did it.
    env.fetchQueue.push(stateResponse(PROPOSED_PATHS));
    dialog.querySelector('[data-auto-rename-check]').click();
    await flush();
    await flush();
    expect(dialog.querySelector('[data-dialog-error-text]').textContent).toContain('new names; that alone does not show this Auto Rename renamed them');
    expect(pendingAutoRenameOperation(env.document, 7)?.state).toBe('unresolved');
    expect(appDialogs.closed).toEqual([]);
    expect(env.feedbackText.textContent).toBe('');
    expect(env.requests.filter((request) => request.method === 'POST')).toHaveLength(1);

    // A receipt recorded as unknown proves nothing either.
    env.fetchQueue.push(stateResponse(ORIGINAL_PATHS, receipt({ outcome: 'unknown', message: 'x' })));
    dialog.querySelector('[data-auto-rename-check]').click();
    await flush();
    await flush();
    expect(dialog.querySelector('[data-dialog-error-text]').textContent).toContain('could not report what this Auto Rename did');
    expect(pendingAutoRenameOperation(env.document, 7)?.state).toBe('unresolved');
  });

  it('reports a recorded recovery-required result over original names and keeps the project held', async () => {
    const env = setup();
    enhanceAutoRenameDialog(env.document);
    const { dialog, state } = await openReview(env);
    const message = 'Auto Rename could not fully restore the project files. Review the project directory before trying again.';
    env.fetchQueue.push(stateResponse(ORIGINAL_PATHS, receipt({ outcome: 'recovery-required', message })));
    state.onUnconfirmedSubmit();
    await flush();
    await flush();
    expect(dialog.querySelector('[data-dialog-error-text]').textContent).toBe(`${message} Auto Rename stays unavailable for this project on this page. Review the project folder before using Auto Rename again.`);
    expect(dialog.querySelector('[data-auto-rename-check]')).toBeNull();
    expect(pendingAutoRenameOperation(env.document, 7)?.state).toBe('recovery-required');
    expect(env.pending.classList.contains('notice--error')).toBe(true);
    expect(env.pendingCheck.hidden).toBe(true);
    expect(refresh.calls).toHaveLength(1);

    closeReview(env);
    await flush();
    const next = await openReview(env, { planToken: 'second-token' });
    expect(next.state.submitLocked()).toBe(true);
    expect(next.dialog.querySelector('[data-dialog-submit]').disabled).toBe(true);
    expect(env.requests.filter((request) => request.method === 'POST' && request.url.endsWith('/apply'))).toHaveLength(0);
  });

  it('keeps a direct recovery-required answer visible and held after the review closes', async () => {
    const env = setup();
    enhanceAutoRenameDialog(env.document);
    const { dialog, state } = await openReview(env);
    const message = 'Auto Rename could not fully restore the project files. Review the project directory before trying again.';
    state.onFailedSubmit({ status: 'error', code: 'AUTO_RENAME_RECOVERY_REQUIRED', outcome: 'recovery-required', recoveryRequired: true, message }, { status: 500 });
    expect(dialog.querySelector('[data-dialog-error-text]').textContent).toContain(message);
    expect(dialog.querySelector('[data-dialog-error-text]').textContent).not.toContain('restored the');
    expect(state.submitLocked()).toBe(true);
    expect(refresh.calls).toHaveLength(1);
    state.onClose();
    expect(env.pendingText.textContent).toContain(message);
    expect(env.pending.classList.contains('notice--error')).toBe(true);
    expect(pendingAutoRenameOperation(env.document, 7)?.state).toBe('recovery-required');
    expect(env.requests).toHaveLength(1);
  });

  it('keeps conflicting Apply unavailable after dismissal until a receipt settles it, and only for a fresh review', async () => {
    const env = setup();
    enhanceAutoRenameDialog(env.document);
    const first = await openReview(env);
    // The original POST has not run yet: an early read sees original names.
    env.fetchQueue.push(stateResponse(ORIGINAL_PATHS));
    first.state.onUnconfirmedSubmit();
    await flush();
    await flush();
    closeReview(env);
    await flush();
    expect(env.pending.hidden).toBe(false);
    expect(env.pendingText.textContent).toContain('The server has no result for this Auto Rename yet');

    const second = await openReview(env, { planToken: 'second-token' });
    expect(second.state.submitLocked()).toBe(true);
    expect(second.dialog.querySelector('[data-dialog-submit]').disabled).toBe(true);
    expect(second.dialog.querySelector('[data-dialog-error-text]').textContent).toContain('An earlier Auto Rename for this project is not settled');
    // A stale callback of the dismissed review cannot release it.
    first.state.onFailedSubmit({ status: 'error', outcome: 'refused', message: 'late' }, { status: 409 });
    expect(pendingAutoRenameOperation(env.document, 7)).not.toBeNull();
    expect(second.state.submitLocked()).toBe(true);

    // The delayed original POST runs; Check again reads its receipt.
    env.fetchQueue.push(stateResponse(PROPOSED_PATHS, receipt({ outcome: 'committed', message: 'Renamed 2 assets. Skipped 0 unchanged assets.', renamed: 2, unchanged: 0, })));
    env.pendingCheck.click();
    await flush();
    await flush();
    expect(pendingAutoRenameOperation(env.document, 7)).toBeNull();
    expect(env.feedbackText.textContent).toBe('Auto Rename was applied. Renamed 2 assets. Skipped 0 unchanged assets.');
    // The review opened while it was held stays unappliable; a fresh one is not.
    expect(second.state.submitLocked()).toBe(true);
    closeReview(env);
    await flush();
    const third = await openReview(env, { planToken: 'third-token' });
    expect(third.state.submitLocked()).toBe(false);
    expect(env.requests.filter((request) => request.method !== 'GET').map((request) => request.url)).toEqual([
      '/projects/7/assets/auto-rename/preview',
      '/projects/7/assets/auto-rename/preview',
      '/projects/7/assets/auto-rename/preview',
    ]);
  });

  it('keeps the operation through a failed read, and Check again from the page only reads', async () => {
    const env = setup();
    enhanceAutoRenameDialog(env.document);
    const first = await openReview(env);
    env.fetchQueue.push(jsonResponse({ status: 'error' }, { ok: false, status: 500 }));
    first.state.onUnconfirmedSubmit();
    await flush();
    await flush();
    closeReview(env);
    await flush();
    const second = await openReview(env, { planToken: 'second-token' });
    expect(second.state.submitLocked()).toBe(true);
    closeReview(env);
    await flush();
    env.fetchQueue.push(() => Promise.reject(new TypeError('offline')));
    env.pendingCheck.click();
    await flush();
    await flush();
    expect(env.pendingText.textContent).toContain('Could not check whether Auto Rename was applied.');
    expect(pendingAutoRenameOperation(env.document, 7)?.state).toBe('unresolved');
    expect(env.requests.filter((request) => request.method === 'GET').map((request) => request.url)).toEqual([STATE_URL, STATE_URL]);
    expect(env.requests.filter((request) => request.url.endsWith('/apply'))).toHaveLength(0);
  });

  it('lets a receipt from any read settle once, and no older read override it', async () => {
    const env = setup();
    enhanceAutoRenameDialog(env.document);
    const { state } = await openReview(env);
    const early = deferred();
    const late = deferred();
    env.fetchQueue.push(() => early.promise, () => late.promise);
    state.onUnconfirmedSubmit();
    env.pendingCheck.click();
    late.resolve(stateResponse(ORIGINAL_PATHS, receipt({ outcome: 'restored', message: 'Auto Rename failed. No files were renamed.' })));
    await flush();
    await flush();
    expect(pendingAutoRenameOperation(env.document, 7)).toBeNull();
    const settled = env.document.getElementById('auto-rename-confirmation-dialog').querySelector('[data-dialog-error-text]').textContent;
    expect(settled).toBe('Auto Rename failed. No files were renamed. It was not sent again. Choose Auto Rename again to review the current files.');
    early.resolve(stateResponse(PROPOSED_PATHS));
    await flush();
    await flush();
    expect(env.document.getElementById('auto-rename-confirmation-dialog').querySelector('[data-dialog-error-text]').textContent).toBe(settled);
    expect(pendingAutoRenameOperation(env.document, 7)).toBeNull();

    // A newer read without a receipt never replaces what an older one recorded.
    const other = setup();
    enhanceAutoRenameDialog(other.document);
    const review = await openReview(other);
    const slow = deferred();
    other.fetchQueue.push(() => slow.promise, stateResponse(ORIGINAL_PATHS));
    review.state.onUnconfirmedSubmit();
    other.pendingCheck.click();
    await flush();
    await flush();
    expect(pendingAutoRenameOperation(other.document, 7)?.state).toBe('unresolved');
    slow.resolve(stateResponse(ORIGINAL_PATHS, receipt({ outcome: 'recovery-required', message: 'Recovery is required.' })));
    await flush();
    await flush();
    expect(pendingAutoRenameOperation(other.document, 7)?.state).toBe('recovery-required');
  });

  it('releases a project only for a recorded refusal, and holds no other project', async () => {
    const env = setup();
    enhanceAutoRenameDialog(env.document);
    const { state } = await openReview(env);
    env.fetchQueue.push(stateResponse(ORIGINAL_PATHS));
    state.onUnconfirmedSubmit();
    await flush();
    await flush();
    closeReview(env);
    await flush();
    expect(pendingAutoRenameOperation(env.document, 8)).toBeNull();
    const elsewhere = await openReview(env, { projectId: 8, planToken: 'other-project' });
    expect(elsewhere.state.submitLocked()).toBe(false);
    closeReview(env);
    await flush();

    env.fetchQueue.push(stateResponse(ORIGINAL_PATHS, receipt({ outcome: 'refused', message: 'The rename preview is no longer current. Review the selected files again.' })));
    env.pendingCheck.click();
    await flush();
    await flush();
    expect(pendingAutoRenameOperation(env.document, 7)).toBeNull();
    expect(env.pending.hidden).toBe(true);
    expect(env.feedbackText.textContent).toBe('The rename preview is no longer current. Review the selected files again. It was not sent again. Choose Auto Rename again to review the current files.');
    expect(env.feedback.classList.contains('notice--warning')).toBe(true);
    expect(refresh.calls).toHaveLength(0);
  });

  it('settles an operation only from its own attempt, even when an earlier review signed the same plan', async () => {
    const env = setup();
    enhanceAutoRenameDialog(env.document);
    // Attempt A: same signed token, settled as restored before B was reviewed.
    const first = await openReview(env, { attemptId: 'a'.repeat(32) });
    first.state.onFailedSubmit({ status: 'error', code: 'AUTO_RENAME_FAILED', outcome: 'restored', message: 'Auto Rename failed. No files were renamed.' }, { status: 500 });
    closeReview(env);
    await flush();
    expect(pendingAutoRenameOperation(env.document, 7)).toBeNull();

    // Attempt B: an identical plan, a new attempt. Its answer is lost.
    const second = await openReview(env);
    expect(second.dialog.querySelector('input[name="attemptId"]').value).toBe(ATTEMPT);
    const restoredA = receipt({ outcome: 'restored', message: 'Auto Rename failed. No files were renamed.' }, 'a'.repeat(32));
    env.fetchQueue.push(stateResponse(ORIGINAL_PATHS, restoredA));
    second.state.onUnconfirmedSubmit();
    await flush();
    await flush();
    expect(env.requests.at(-1)).toMatchObject({ method: 'GET', url: STATE_URL });
    expect(pendingAutoRenameOperation(env.document, 7)).toMatchObject({ state: 'unresolved', attemptId: ATTEMPT });
    expect(second.dialog.querySelector('[data-dialog-error-text]').textContent).toContain('The server has no result for this Auto Rename yet');
    expect(second.dialog.querySelector('[data-dialog-error-text]').textContent).not.toContain('No files were renamed');

    // B issued but not yet run, or B under another project's lookup: still held.
    for (const operation of [
      { attemptId: ATTEMPT, state: 'issued', recorded: false },
      { attemptId: ATTEMPT, state: 'applying', recorded: false },
      { attemptId: ATTEMPT, state: 'unknown', recorded: false },
      { ...receipt({ outcome: 'refused', message: 'stale' }), state: 'issued' },
    ]) {
      env.fetchQueue.push(stateResponse(ORIGINAL_PATHS, operation));
      env.pendingCheck.click();
      await flush();
      await flush();
      expect(pendingAutoRenameOperation(env.document, 7)?.state).toBe('unresolved');
    }
    closeReview(env);
    await flush();
    const third = await openReview(env, { planToken: 'signed-token', attemptId: 'c'.repeat(32) });
    expect(third.state.submitLocked()).toBe(true);
    closeReview(env);
    await flush();

    // Only B's own receipt settles B.
    env.fetchQueue.push(stateResponse(ORIGINAL_PATHS, receipt({
      outcome: 'recovery-required', message: 'Auto Rename could not fully restore the project files.',
    })));
    env.pendingCheck.click();
    await flush();
    await flush();
    expect(pendingAutoRenameOperation(env.document, 7)).toMatchObject({ state: 'recovery-required', attemptId: ATTEMPT });
    expect(env.requests.filter((request) => request.method === 'GET').every((request) => request.url === STATE_URL)).toBe(true);
    expect(env.requests.filter((request) => request.url.endsWith('/apply'))).toHaveLength(0);
  });

  it('treats a committed answer for another attempt as unconfirmed', async () => {
    const env = setup();
    enhanceAutoRenameDialog(env.document);
    const { state } = await openReview(env);
    env.fetchQueue.push(stateResponse(PROPOSED_PATHS));
    expect(state.onSuccessfulSubmit({ status: 'success', outcome: 'committed', projectId: 7, attemptId: 'b'.repeat(32), renamed: 2, message: 'Renamed 2 assets.' })).toBe(true);
    expect(appDialogs.closed).toEqual([]);
    expect(pendingAutoRenameOperation(env.document, 7)).toMatchObject({ state: 'unresolved', attemptId: ATTEMPT });
    expect(refresh.calls).toHaveLength(0);
  });

  it('mounts a review only when its form carries exactly the issued attempt', async () => {
    for (const [payloadAttempt, formAttempts] of [
      [undefined, []],
      ['not-an-attempt', ['not-an-attempt']],
      [ATTEMPT, []],
      [ATTEMPT, ['f'.repeat(32)]],
      [ATTEMPT, [ATTEMPT, ATTEMPT]],
    ]) {
      const env = setup();
      enhanceAutoRenameDialog(env.document);
      const payload = previewPayload({ attemptId: payloadAttempt });
      payload.dialogHtml = JSON.stringify({ projectId: 7, token: payload.planToken, attemptIds: formAttempts });
      env.fetchQueue.push(jsonResponse(payload));
      env.submitPreview();
      await flush();
      expect(env.mount.children).toHaveLength(0);
      expect(env.feedbackText.textContent).toBe('Auto Rename preview could not be loaded. Nothing was renamed.');
    }
    expect(appDialogs.opened).toHaveLength(0);
  });

  it('binds the page Check again once however often the page is enhanced', () => {
    const env = setup();
    enhanceAutoRenameDialog(env.document);
    enhanceAutoRenameDialog(env.document);
    expect(env.pendingCheck.listeners).toHaveLength(1);
    expect(env.document.listeners.filter((entry) => entry.type === 'submit')).toHaveLength(1);
  });

  it('cannot apply a review the server marked unappliable', async () => {
    const env = setup();
    enhanceAutoRenameDialog(env.document);
    const { state } = await openReview(env, { canApply: false });
    expect(state.submitLocked()).toBe(true);
  });
});
