import { describe, it, expect, vi, beforeEach } from 'vitest';

// WP11B-2: Delete release from the Edit Release dialog, in place
// (release-delete.js, bound together with the real release-archive.js whose
// holds it shares). The dialog binder, the Edit Release controller, Release
// Detail's refresh and the shared confirmation are stand-ins (the
// confirmation's replay is a dispatched click and submit here; its own gate,
// the real binder and every host refresh are covered in Chromium); the DOM is
// a purpose-built shim (no jsdom in this project).

const dialogs = vi.hoisted(() => ({
  freezes: 0,
  frozen: 0,
  feedback: [],
  drafts: [],
  closes: 0,
  state: null,
}));
vi.mock('../src/static/client/app-dialogs.js', () => ({
  freezeAppDialog: () => {
    dialogs.freezes += 1;
    dialogs.frozen += 1;
    return () => { dialogs.frozen -= 1; };
  },
  appDialogFeedback: (document, message, error = false) => {
    dialogs.feedback.push({ message, error });
    const feedback = document.querySelector('[data-dialog-feedback]');
    const text = feedback?.querySelector('[data-dialog-feedback-text]');
    if (text) text.textContent = message;
  },
  readAppDialogValues: (form) => JSON.parse(JSON.stringify(form.values)),
  applyAppDialogDraft: (document, id, values) => {
    dialogs.drafts.push(values);
    document.getElementById(id).querySelector('form[data-dialog-form]').values = JSON.parse(JSON.stringify(values));
    return true;
  },
  closeAppDialogById: (document, id) => {
    const dialog = document.getElementById(id);
    const state = dialogs.state;
    if (!dialog.open || state.beforeClose?.({}) !== true) return false;
    dialogs.closes += 1;
    state.form.values = JSON.parse(JSON.stringify(state.savedValues));
    dialog.open = false;
    dialog.dispatch('close');
    return true;
  },
}));

const confirmations = vi.hoisted(() => ({ described: new Map() }));
vi.mock('../src/static/client/confirm-dialog.js', () => ({
  describeAppConfirmation: (control, resolve) => { confirmations.described.set(control, resolve); },
}));

const detailRefresh = vi.hoisted(() => ({ retired: 0 }));
vi.mock('../src/static/client/release-detail-refresh.js', () => ({
  retireReleaseDetailRefresh: () => { detailRefresh.retired += 1; return true; },
}));

const editController = vi.hoisted(() => ({ current: null, enhanced: 0 }));
vi.mock('../src/static/client/release-edit-dialog.js', () => ({
  RELEASE_EDIT_DIALOG_ID: 'release-edit-dialog',
  RELEASE_ARCHIVED_EVENT: 'release-archived',
  RELEASE_DELETED_EVENT: 'release-deleted',
  enhanceReleaseEditDialog: () => {
    editController.enhanced += 1;
    return editController.current;
  },
}));

const {
  enhanceReleaseDelete,
  releaseDeleteState,
  releaseDeleteHoldsRelease,
  RELEASE_DELETE_MESSAGES: M,
  RELEASE_DELETED_HOST_ATTRIBUTE,
} = await import('../src/static/client/release-delete.js');
const { releaseArchiveState, RELEASE_ARCHIVE_MESSAGES: AM } = await import('../src/static/client/release-archive.js');

// ---------------------------------------------------------------- DOM shim --

function matchesSimple(node, selector) {
  const match = selector.trim().match(/^([a-z]+)?((?:\[[\w-]+(?:="[^"]*")?\])*)$/i);
  if (!match || (!match[1] && !match[2])) return false;
  if (match[1] && node.tagName !== match[1].toUpperCase()) return false;
  for (const [, name, value] of match[2].matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
    if (!node.hasAttribute(name)) return false;
    if (value !== undefined && node.getAttribute(name) !== value) return false;
  }
  return true;
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

  get ownerDocument() { let node = this; while (node.parentNode) node = node.parentNode; return node.document || null; }
  get isConnected() { let node = this; while (node.parentNode) node = node.parentNode; return Boolean(node.document); }
  get id() { return this.getAttribute('id') || ''; }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }
  set className(value) { this.attributes.set('class', value); }
  get type() { return this.getAttribute('type') || (this.tagName === 'BUTTON' ? 'submit' : ''); }
  set type(value) { this.attributes.set('type', value); }
  get form() {
    const owner = this.getAttribute('form');
    if (owner) return this.ownerDocument?.getElementById(owner) || null;
    return ['BUTTON', 'INPUT'].includes(this.tagName) ? this.parentNode?.closest?.('form') || null : undefined;
  }
  appendChild(child) {
    child.parentNode?.removeChildNode(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  append(...children) { children.forEach((child) => this.appendChild(child)); }
  removeChildNode(child) { this.childNodes = this.childNodes.filter((node) => node !== child); child.parentNode = null; }
  remove() { this.parentNode?.removeChildNode(this); }
  contains(node) { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }
  get textContent() { return this.ownText + this.childNodes.map((node) => node.textContent).join(''); }
  set textContent(text) { [...this.childNodes].forEach((node) => this.removeChildNode(node)); this.ownText = String(text); }
  matches(selector) { return selector.split(',').some((part) => matchesSimple(this, part)); }
  descendants() { return this.childNodes.flatMap((node) => [node, ...node.descendants()]); }
  querySelectorAll(selector) {
    const parts = selector.split(/\s+(?![^[]*\])/);
    return this.descendants().filter((node) => node.matches(parts[parts.length - 1]));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { for (let node = this; node; node = node.parentNode) if (node.matches?.(selector)) return node; return null; }
  addEventListener(type, listener, capture = false) {
    this.listeners.push({ type, listener, capture: capture === true || capture?.capture === true });
  }
  focus() { this.ownerDocument.activeElement = this; }
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = async () => { for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const SAVED = Object.freeze({
  title: 'Spring Batch',
  description: 'Saved description',
  notes: '',
  plannedDate: '2026-12-01',
  plannedTime: '',
  publishedDate: '',
  patreonUrl: '',
  selectedPlatforms: ['patreon'],
});

const DELETED_BODY = Object.freeze({
  status: 'success',
  outcome: 'deleted',
  message: 'Release “Spring Batch” deleted.',
  releaseId: 12,
  projectId: 4,
  release: { id: 12, projectId: 4, title: 'Spring Batch', deleted: true },
  redirect: '/releases',
  refreshRequired: true,
});
const EDIT_MODEL = Object.freeze({ status: 'success', release: { id: 12 } });
const NOT_FOUND = Object.freeze({ status: 'error', code: 'RELEASE_NOT_FOUND', message: 'Release not found.' });

function setup({ releaseId = '12', withFetch = true, detail = false } = {}) {
  const root = new FakeNode('html');
  const document = {
    nodeType: 9,
    documentElement: root,
    activeElement: null,
    events: [],
    createElement: (tag) => new FakeNode(tag),
    querySelector: (selector) => root.querySelector(selector),
    getElementById: (id) => root.descendants().find((node) => node.id === id) || null,
    addEventListener: (...args) => root.addEventListener(...args),
    dispatchEvent(event) { this.events.push(event); },
  };
  root.document = document;
  document.body = root.appendChild(new FakeNode('body'));
  const main = document.body.appendChild(new FakeNode('main', { id: 'main-content' }));
  const feedback = main.appendChild(new FakeNode('div', { 'data-dialog-feedback': '' }));
  feedback.appendChild(new FakeNode('p', { 'data-dialog-feedback-text': '' }));
  const page = main.appendChild(new FakeNode('section', detail ? { 'data-release-detail': releaseId } : {}));
  const editTrigger = page.appendChild(new FakeNode('button', { type: 'button', 'data-release-edit-id': releaseId }));
  const dialog = document.body.appendChild(new FakeNode('dialog', { id: 'release-edit-dialog' }));
  dialog.open = true;
  const editForm = dialog.appendChild(new FakeNode('form', {
    id: 'release-edit-form', 'data-dialog-form': '', action: `/releases/${releaseId}`,
  }));
  editForm.values = JSON.parse(JSON.stringify(SAVED));
  const archiveDisclosure = dialog.appendChild(new FakeNode('details', { 'data-release-edit-action': 'archive' }));
  const archiveForm = archiveDisclosure.appendChild(new FakeNode('form', {
    'data-release-archive-form': '', 'data-dialog-secondary-action': '', 'data-confirm-submit-required': '',
    action: `/releases/${releaseId}/archive`,
  }));
  archiveForm.csrf = 'token-1';
  const archiveButton = archiveForm.appendChild(new FakeNode('button', { type: 'submit', 'data-confirm': 'Archive?' }));
  const deleteDisclosure = dialog.appendChild(new FakeNode('details', { 'data-release-edit-action': 'delete' }));
  const form = deleteDisclosure.appendChild(new FakeNode('form', {
    'data-release-delete-form': '', 'data-dialog-secondary-action': '', 'data-confirm-submit-required': '',
    action: `/releases/${releaseId}/delete`,
  }));
  form.csrf = 'token-1';
  const button = form.appendChild(new FakeNode('button', { type: 'submit', 'data-confirm': 'Delete this release permanently?' }));
  const status = dialog.appendChild(new FakeNode('div', { 'data-dialog-status': '' }));
  const saveButton = dialog.appendChild(new FakeNode('button', {
    type: 'submit', form: 'release-edit-form', 'data-dialog-submit': '',
  }));

  const publishDialog = document.body.appendChild(new FakeNode('dialog', { id: 'release-publish-dialog' }));
  const publishForm = publishDialog.appendChild(new FakeNode('form', {
    id: 'release-publish-form', action: `/releases/${releaseId}/publish`,
  }));
  const publishStatus = publishDialog.appendChild(new FakeNode('div', { 'data-dialog-status': '' }));
  const publishSubmit = publishDialog.appendChild(new FakeNode('button', {
    type: 'submit', form: 'release-publish-form', 'data-dialog-submit': '',
  }));
  const item = main.appendChild(new FakeNode('li', { 'data-dashboard-needs-date-item': '', 'data-release-id': releaseId }));
  const quickForm = item.appendChild(new FakeNode('form', {
    'data-dashboard-schedule-quick-form': '', action: `/releases/${releaseId}/schedule`,
  }));
  const quickPick = quickForm.appendChild(new FakeNode('button', { type: 'submit', 'data-dashboard-schedule-pick': '' }));
  const undo = item.appendChild(new FakeNode('button', { type: 'button', 'data-dashboard-schedule-undo': '' }));
  const companion = main.appendChild(new FakeNode('span', {
    'data-release-social-prep-companion': '',
    'data-activation-url': `/releases/${releaseId}/social-prep/activate`,
  }));
  const companionAction = companion.appendChild(new FakeNode('button', {
    type: 'button', 'data-release-social-prep-companion-action': '',
  }));
  const companionClicks = vi.fn();
  companionAction.addEventListener('click', companionClicks);
  const otherItem = main.appendChild(new FakeNode('li', { 'data-dashboard-needs-date-item': '', 'data-release-id': '99' }));
  const otherQuickForm = otherItem.appendChild(new FakeNode('form', {
    'data-dashboard-schedule-quick-form': '', action: '/releases/99/schedule',
  }));

  const dialogState = {
    dialog, form: editForm, savedValues: JSON.parse(JSON.stringify(SAVED)), submitting: false, beforeClose: null,
  };
  dialog.__creatorCrateAppDialogState = dialogState;
  dialogs.state = dialogState;
  editController.current = { releaseId, onLoaded: null, onLoadRefused: null };

  const fetch = vi.fn();
  const location = { pathname: detail ? `/releases/${releaseId}` : '/', assign: vi.fn() };
  const windowObject = {
    fetch: withFetch ? fetch : undefined,
    location,
    FormData: class { constructor(target) { this.entries = [['_csrf', target.csrf]]; } },
    URLSearchParams: class { constructor(data) { this.value = new URLSearchParams(data.entries).toString(); } toString() { return this.value; } },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
  };
  document.defaultView = windowObject;
  const handle = enhanceReleaseDelete(document);

  const confirmAndSubmit = () => {
    const click = button.click();
    if (click.defaultPrevented) return click;
    return form.dispatch('submit');
  };
  const archiveConfirmAndSubmit = () => {
    const click = archiveButton.click();
    if (click.defaultPrevented) return click;
    return archiveForm.dispatch('submit');
  };
  const posts = () => fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
  return {
    document, main, page, editTrigger, dialog, dialogState, editForm, form, button, status, feedback, fetch, location,
    handle, confirmAndSubmit, archiveConfirmAndSubmit, archiveForm, archiveButton, saveButton, publishForm,
    publishStatus, publishSubmit, quickForm, quickPick, undo, otherQuickForm, companionAction, companionClicks,
    posts,
    deletePosts: () => posts().filter(([url]) => url.endsWith('/delete')),
    gets: () => fetch.mock.calls.filter(([, init]) => init?.method === 'GET'),
    describe: () => confirmations.described.get(button)(),
    trySave: () => editForm.dispatch('submit'),
    deletedEvents: () => document.events.filter((event) => event.type === 'release-deleted'),
    dismiss: () => {
      if (dialogState.beforeClose && dialogState.beforeClose({}) !== true) return false;
      editForm.values = JSON.parse(JSON.stringify(dialogState.savedValues));
      dialog.open = false;
      dialog.dispatch('close');
      return true;
    },
    reopen: ({ refused = null } = {}) => {
      dialog.open = true;
      editForm.values = JSON.parse(JSON.stringify(dialogState.savedValues));
      if (refused) editController.current.onLoadRefused?.(releaseId, refused.status, refused.body);
      else editController.current.onLoaded?.(releaseId);
    },
  };
}

async function unresolved(options) {
  const t = setup(options);
  t.editForm.values.title = 'Draft title';
  t.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
  t.fetch.mockResolvedValueOnce(jsonResponse(200, EDIT_MODEL));
  t.confirmAndSubmit();
  await flush();
  expect(releaseDeleteState(t.document, '12').phase).toBe('unresolved');
  return t;
}

beforeEach(() => {
  dialogs.freezes = 0;
  dialogs.frozen = 0;
  dialogs.feedback = [];
  dialogs.drafts = [];
  dialogs.closes = 0;
  confirmations.described.clear();
  editController.enhanced = 0;
  detailRefresh.retired = 0;
});

describe('Release Delete in place', () => {
  it('C1 / C5 / C6 — names the saved release, says what Delete removes and warns about each unsaved field', () => {
    const t = setup();
    const plain = t.describe();
    expect(plain.title).toBe('Delete release?');
    expect(plain.message).toMatch(/^Delete “Spring Batch” permanently\? /);
    expect(plain.message).toContain('selected assets and their order');
    expect(plain.message).toContain('The project’s assets and files are not affected');
    expect(plain.message).toContain('anything already posted on other sites is not removed');
    expect(plain.message).toContain('including changes made elsewhere since this page loaded');
    expect(plain.message).toContain('This cannot be undone.');
    expect(plain.confirmLabel).toBe('Delete release');
    expect(plain.cancelLabel).toBe('Cancel');
    t.editForm.values.title = 'Draft title';
    t.editForm.values.notes = 'Draft notes';
    t.editForm.values.selectedPlatforms = [];
    const described = t.describe();
    expect(described.title).toBe('Delete release with unsaved changes?');
    expect(described.message).toMatch(/^Delete “Spring Batch” permanently\?/);
    expect(described.message).toContain('Your unsaved Edit Release changes (title, notes and platforms) will not be saved: they are kept if you cancel or the release is not deleted, and lost if it is deleted.');
    expect(described.cancelLabel).toBe('Keep editing');
  });

  it('C2 / C3 / C7 — a confirmation that is not confirmed sends nothing and keeps the drafts', () => {
    const t = setup();
    t.editForm.values.title = 'Draft title';
    t.describe();
    expect(t.fetch).not.toHaveBeenCalled();
    expect(t.editForm.values.title).toBe('Draft title');
    expect(releaseDeleteState(t.document, '12')).toBeNull();
    expect(dialogs.freezes).toBe(0);
    expect(t.dismiss()).toBe(true);
  });

  it('C4 / C25 — one confirmed Delete sends one POST; replays, repeated Enter and dismissal while pending are refused', async () => {
    const t = setup();
    const post = deferred();
    t.fetch.mockReturnValueOnce(post.promise);
    t.confirmAndSubmit();
    t.confirmAndSubmit();
    t.form.dispatch('submit');
    t.form.dispatch('submit');
    await flush();
    expect(t.deletePosts()).toHaveLength(1);
    const [url, init] = t.deletePosts()[0];
    expect(url).toBe('/releases/12/delete');
    expect(init.headers).toEqual({ Accept: 'application/json' });
    expect(String(init.body)).toBe('_csrf=token-1');
    expect(t.dialogState.submitting).toBe(true);
    expect(dialogs.frozen).toBe(1);
    expect(t.status.textContent).toContain('Deleting “Spring Batch”…');
    expect(t.status.textContent).toContain(M.pending);
    expect(t.dialogState.beforeClose({})).toBe(false);
    expect(t.dismiss()).toBe(false);
    expect(t.dialog.open).toBe(true);
    post.resolve(jsonResponse(200, DELETED_BODY));
    await flush();
    expect(t.deletePosts()).toHaveLength(1);
  });

  it('C5 — a mismatched target or an unloaded form never posts', () => {
    const t = setup();
    t.form.setAttribute('action', '/releases/13/delete');
    t.confirmAndSubmit();
    expect(t.fetch).not.toHaveBeenCalled();
    expect(t.status.textContent).toContain(M.wrongTarget);
    t.form.setAttribute('action', '/releases/12/delete');
    editController.current.releaseId = null;
    t.confirmAndSubmit();
    expect(t.fetch).not.toHaveBeenCalled();
    expect(t.status.textContent).toContain(M.notLoaded);
  });

  it('C12 / C13 / C14 — confirmed success closes the dialog, discards the warned drafts and tells the surviving host', async () => {
    const t = setup();
    t.editForm.values.description = 'Unsaved description';
    t.fetch.mockResolvedValueOnce(jsonResponse(200, DELETED_BODY));
    t.confirmAndSubmit();
    await flush();
    expect(t.dialog.open).toBe(false);
    expect(dialogs.closes).toBe(1);
    expect(dialogs.frozen).toBe(0);
    expect(t.editForm.values.description).toBe('Saved description');
    expect(dialogs.feedback.at(-1)).toEqual({ message: 'Release “Spring Batch” deleted.', error: false });
    expect(t.deletedEvents()).toHaveLength(1);
    expect(t.deletedEvents()[0].detail).toMatchObject({
      releaseId: '12', projectId: 4, outcome: 'deleted', confirmed: true, hostRetired: false,
    });
    expect(releaseDeleteState(t.document, '12')).toMatchObject({ phase: 'deleted', drafts: null });
    // A surviving host is not retired and never navigates.
    expect(t.location.assign).not.toHaveBeenCalled();
    expect(detailRefresh.retired).toBe(0);
    expect(t.main.hasAttribute(RELEASE_DELETED_HOST_ATTRIBUTE)).toBe(false);
    // C24: focus goes to the main content, not the withdrawn opener.
    expect(t.document.activeElement).toBe(t.main);
    // No Edit Save was sent by Delete.
    expect(t.fetch).toHaveBeenCalledTimes(1);
  });

  it('C12 / C22 — a deleted release refuses every further mutation from stale controls', async () => {
    const t = setup();
    t.fetch.mockResolvedValueOnce(jsonResponse(200, DELETED_BODY));
    t.confirmAndSubmit();
    await flush();
    t.dialog.open = true;
    t.confirmAndSubmit();
    expect(t.status.textContent).toContain(M.deleted);
    expect(t.archiveConfirmAndSubmit().defaultPrevented).toBe(true);
    expect(t.trySave().defaultPrevented).toBe(true);
    expect(t.publishForm.dispatch('submit').defaultPrevented).toBe(true);
    expect(t.quickPick.click().defaultPrevented).toBe(true);
    expect(t.undo.click().defaultPrevented).toBe(true);
    t.companionAction.click();
    expect(t.companionClicks).not.toHaveBeenCalled();
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(t.button.getAttribute('aria-disabled')).toBe('true');
    // Another release on the same page is unaffected.
    expect(t.otherQuickForm.dispatch('submit').defaultPrevented).toBe(false);
  });

  it('C15 — on Release Detail a confirmed Delete retires the page and navigates once to Releases', async () => {
    const t = setup({ detail: true });
    t.fetch.mockResolvedValueOnce(jsonResponse(200, { ...DELETED_BODY, redirect: 'https://evil.example/' }));
    t.confirmAndSubmit();
    await flush();
    expect(detailRefresh.retired).toBe(1);
    expect(t.main.getAttribute(RELEASE_DELETED_HOST_ATTRIBUTE)).toBe('12');
    expect(t.page.hasAttribute('inert')).toBe(true);
    expect(t.feedback.hasAttribute('inert')).toBe(false);
    // Only the local Releases page, never the answer's foreign URL.
    expect(t.location.assign).toHaveBeenCalledTimes(1);
    expect(t.location.assign).toHaveBeenCalledWith('/releases');
    const link = t.feedback.querySelector('[data-release-delete-destination]');
    expect(link.getAttribute('href')).toBe('/releases');
    expect(link.textContent).toBe(M.goToReleases);
    expect(dialogs.feedback.at(-1).message).toContain(M.opening);
    expect(t.deletedEvents()[0].detail.hostRetired).toBe(true);
    // A later observation cannot navigate again.
    t.confirmAndSubmit();
    expect(t.location.assign).toHaveBeenCalledTimes(1);
  });

  it('C7 / C19 — refusals and proven failures thaw the dialog with every draft and offer Delete again', async () => {
    for (const [status, body] of [
      [403, { status: 'error', message: 'Invalid or missing CSRF token.' }],
      [503, { status: 'error', message: 'Service temporarily unavailable for maintenance.' }],
      [500, { status: 'error', code: 'RELEASE_DELETE_FAILED', outcome: 'failed', message: 'Release delete failed. Nothing was deleted. Please try again.' }],
    ]) {
      const t = setup();
      t.editForm.values.title = 'Draft title';
      t.fetch.mockResolvedValueOnce(jsonResponse(status, body));
      t.confirmAndSubmit();
      await flush();
      expect(releaseDeleteState(t.document, '12')).toBeNull();
      expect(t.dialog.open).toBe(true);
      expect(dialogs.frozen).toBe(0);
      expect(t.editForm.values.title).toBe('Draft title');
      expect(t.status.textContent).toContain(body.message);
      expect(t.status.textContent).toContain(M.draftsKept);
      expect(t.status.textContent.match(/Nothing was deleted/g)).toHaveLength(1);
      expect(t.button.getAttribute('aria-disabled')).toBeNull();
      expect(t.document.events).toHaveLength(0);
      t.fetch.mockResolvedValueOnce(jsonResponse(200, DELETED_BODY));
      t.confirmAndSubmit();
      await flush();
      expect(t.deletePosts()).toHaveLength(2);
      dialogs.feedback = [];
    }
  });

  it('C28 — an archived release or project refusal keeps the drafts and asks the host to re-read it', async () => {
    for (const code of ['RELEASE_ARCHIVED', 'PROJECT_ARCHIVED']) {
      const t = setup();
      t.editForm.values.title = 'Draft title';
      t.fetch.mockResolvedValueOnce(jsonResponse(409, {
        status: 'error', code, outcome: 'refused', message: 'Archived releases cannot be deleted. Nothing was deleted.', releaseId: 12,
      }));
      t.confirmAndSubmit();
      await flush();
      expect(releaseDeleteState(t.document, '12')).toBeNull();
      expect(t.dialog.open).toBe(true);
      expect(t.editForm.values.title).toBe('Draft title');
      expect(t.status.textContent).toContain(M.draftsUnsaveable);
      expect(t.deletedEvents()).toHaveLength(0);
      const archived = t.document.events.filter((event) => event.type === 'release-archived');
      expect(archived).toHaveLength(1);
      expect(archived[0].detail).toMatchObject({
        releaseId: '12', confirmed: false, outcome: code === 'RELEASE_ARCHIVED' ? 'observed-archived' : 'observed-project-archived',
      });
    }
  });

  it('C20 — a 404 answer says the release is gone without claiming this Delete removed it', async () => {
    const t = setup({ detail: true });
    t.editForm.values.title = 'Draft title';
    t.fetch.mockResolvedValueOnce(jsonResponse(404, { ...NOT_FOUND, outcome: 'refused', message: 'Release not found. Nothing was deleted.' }));
    t.confirmAndSubmit();
    await flush();
    expect(releaseDeleteState(t.document, '12').phase).toBe('missing');
    expect(t.deletedEvents()[0].detail).toMatchObject({ outcome: 'missing', confirmed: false });
    expect(dialogs.feedback.at(-1).error).toBe(true);
    // The page is retired but does not navigate by itself.
    expect(detailRefresh.retired).toBe(1);
    expect(t.location.assign).not.toHaveBeenCalled();
    expect(t.feedback.querySelector('[data-release-delete-destination]')).not.toBeNull();
  });

  it('C18 / C19 / C21 — a lost answer holds every mutation, keeps the drafts, and Check again only reads', async () => {
    const t = await unresolved();
    // The automatic check read the release as still present: still held.
    expect(t.gets()).toHaveLength(1);
    expect(t.gets()[0][0]).toBe('/releases/12/edit');
    expect(releaseDeleteState(t.document, '12').phase).toBe('unresolved');
    expect(t.status.textContent).toContain(M.stillPresent);
    expect(t.editForm.values.title).toBe('Draft title');
    expect(t.dialog.querySelector('[data-release-delete-check]')).not.toBeNull();
    expect(t.feedback.querySelector('[data-release-delete-feedback-check]')).not.toBeNull();
    expect(dialogs.frozen).toBe(0);

    t.confirmAndSubmit();
    expect(t.status.textContent).toContain(M.unresolved);
    expect(t.trySave().defaultPrevented).toBe(true);
    expect(t.status.textContent).toContain(M.saveHeld);
    expect(t.archiveConfirmAndSubmit().defaultPrevented).toBe(true);
    expect(t.publishForm.dispatch('submit').defaultPrevented).toBe(true);
    expect(t.publishStatus.textContent).toContain(M.mutationHeld);
    expect(t.quickPick.click().defaultPrevented).toBe(true);
    t.companionAction.click();
    expect(t.companionClicks).not.toHaveBeenCalled();
    expect(t.posts()).toHaveLength(1);
    expect(releaseArchiveState(t.document, '12')).toBeNull();

    // A failed check stays unresolved.
    t.fetch.mockResolvedValueOnce(jsonResponse(500, { status: 'error' }));
    t.dialog.querySelector('[data-release-delete-check]').click();
    await flush();
    expect(releaseDeleteState(t.document, '12').phase).toBe('unresolved');
    expect(t.status.textContent).toContain(M.checkFailed);
    // An archived read is still an observation only.
    t.fetch.mockResolvedValueOnce(jsonResponse(409, { status: 'error', code: 'RELEASE_ARCHIVED' }));
    t.dialog.querySelector('[data-release-delete-check]').click();
    await flush();
    expect(releaseDeleteState(t.document, '12').phase).toBe('unresolved');
    expect(t.posts()).toHaveLength(1);
    expect(t.gets()).toHaveLength(3);
  });

  it('C18 — an unknown 500, an unreadable success and a mismatched success are unresolved, never refused or deleted', async () => {
    for (const response of [
      jsonResponse(500, { status: 'error', code: 'RELEASE_DELETE_UNKNOWN', outcome: 'unknown', message: 'Could not confirm whether the release was deleted.' }),
      { ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } },
      jsonResponse(200, { ...DELETED_BODY, releaseId: 13, release: { ...DELETED_BODY.release, id: 13 } }),
      jsonResponse(404, { status: 'error', message: 'Not Found' }),
    ]) {
      const t = setup();
      t.fetch.mockResolvedValueOnce(response);
      t.fetch.mockResolvedValueOnce(jsonResponse(200, EDIT_MODEL));
      t.confirmAndSubmit();
      await flush();
      expect(releaseDeleteState(t.document, '12').phase).toBe('unresolved');
      expect(t.deletedEvents()).toHaveLength(0);
      expect(t.dialog.open).toBe(true);
    }
  });

  it('C20 / C21 — a read finding the release gone settles it as observed, never as this Delete', async () => {
    const t = await unresolved({ detail: true });
    t.fetch.mockResolvedValueOnce(jsonResponse(404, NOT_FOUND));
    t.dialog.querySelector('[data-release-delete-check]').click();
    await flush();
    expect(releaseDeleteState(t.document, '12').phase).toBe('missing');
    expect(t.status.textContent).toContain(M.observedMissing);
    expect(t.deletedEvents()[0].detail).toMatchObject({ outcome: 'observed-missing', confirmed: false });
    expect(detailRefresh.retired).toBe(1);
    expect(t.location.assign).not.toHaveBeenCalled();
    expect(t.posts()).toHaveLength(1);
  });

  it('C22 — a Check again answer that arrives after a newer Check is ignored', async () => {
    const t = await unresolved();
    const older = deferred();
    t.fetch.mockReturnValueOnce(older.promise);
    t.dialog.querySelector('[data-release-delete-check]').click();
    t.fetch.mockResolvedValueOnce(jsonResponse(200, EDIT_MODEL));
    t.handle.check('12');
    await flush();
    older.resolve(jsonResponse(404, NOT_FOUND));
    await flush();
    expect(releaseDeleteState(t.document, '12').phase).toBe('unresolved');
    expect(t.deletedEvents()).toHaveLength(0);
  });

  it('C23 — dismissal while unresolved keeps the drafts for the next open, with Check again; a 404 load settles it', async () => {
    const t = await unresolved();
    t.editForm.values.notes = 'More draft';
    expect(t.dismiss()).toBe(true);
    expect(t.editForm.values.title).toBe('Spring Batch');
    t.reopen();
    expect(t.editForm.values).toMatchObject({ title: 'Draft title', notes: 'More draft' });
    expect(t.button.getAttribute('aria-disabled')).toBe('true');
    expect(t.dialog.querySelector('[data-release-delete-check]')).not.toBeNull();
    t.dismiss();
    t.reopen({ refused: { status: 404, body: NOT_FOUND } });
    await flush();
    expect(releaseDeleteState(t.document, '12').phase).toBe('missing');
    expect(t.deletedEvents()[0].detail.outcome).toBe('observed-missing');
  });

  it('C8 — a pending Edit Save refuses Delete before the confirmation opens', () => {
    const t = setup();
    t.dialogState.submitting = true;
    const click = t.button.click();
    expect(click.defaultPrevented).toBe(true);
    expect(t.status.textContent).toContain(M.saveBusy);
    expect(t.fetch).not.toHaveBeenCalled();
  });

  it('C9 — a pending or unresolved Archive refuses Delete', async () => {
    const t = setup();
    const archive = deferred();
    t.fetch.mockReturnValueOnce(archive.promise);
    t.archiveConfirmAndSubmit();
    await flush();
    expect(releaseArchiveState(t.document, '12').phase).toBe('pending');
    expect(t.confirmAndSubmit().defaultPrevented).toBe(true);
    expect(t.deletePosts()).toHaveLength(0);
    archive.reject(new TypeError('Failed to fetch'));
    t.fetch.mockResolvedValueOnce(jsonResponse(200, EDIT_MODEL));
    await flush();
    expect(releaseArchiveState(t.document, '12').phase).toBe('unresolved');
    t.form.dispatch('submit');
    expect(t.confirmAndSubmit().defaultPrevented).toBe(true);
    expect(t.deletePosts()).toHaveLength(0);
    expect(t.status.textContent).toMatch(new RegExp(`${AM.mutationHeld.slice(0, 30)}|${M.archiveHeld.slice(0, 30)}`));
  });

  it('C10 / C11 — a pending Delete refuses Archive, Publish, scheduling and the Posting Helper', async () => {
    const t = setup();
    const post = deferred();
    t.fetch.mockReturnValueOnce(post.promise);
    t.confirmAndSubmit();
    await flush();
    expect(t.archiveConfirmAndSubmit().defaultPrevented).toBe(true);
    expect(t.publishSubmit.click().defaultPrevented).toBe(true);
    expect(t.publishStatus.textContent).toContain(M.pending);
    expect(t.quickForm.dispatch('submit').defaultPrevented).toBe(true);
    t.companionAction.click();
    expect(t.companionClicks).not.toHaveBeenCalled();
    expect(t.posts()).toHaveLength(1);
    expect(releaseArchiveState(t.document, '12')).toBeNull();
    post.resolve(jsonResponse(500, { status: 'error', code: 'RELEASE_DELETE_FAILED', outcome: 'failed', message: 'Release delete failed. Nothing was deleted. Please try again.' }));
    await flush();
    // Proven failure releases the hold.
    expect(t.quickForm.dispatch('submit').defaultPrevented).toBe(false);
    expect(releaseDeleteHoldsRelease(t.document, '12')).toBe(false);
  });

  it('C27 — without fetch the form stays native: nothing is intercepted', () => {
    const t = setup({ withFetch: false });
    const click = t.button.click();
    expect(click.defaultPrevented).toBe(false);
    const submit = t.form.dispatch('submit');
    expect(submit.defaultPrevented).toBe(false);
    expect(releaseDeleteState(t.document, '12')).toBeNull();
  });

  it('C26 — enhancing twice binds once', async () => {
    const t = setup();
    expect(enhanceReleaseDelete(t.document)).toBe(t.handle);
    t.fetch.mockResolvedValueOnce(jsonResponse(200, DELETED_BODY));
    t.confirmAndSubmit();
    await flush();
    expect(t.deletePosts()).toHaveLength(1);
    expect(t.deletedEvents()).toHaveLength(1);
  });

  it('returns null without an async Edit Release dialog', () => {
    editController.current = null;
    const document = { nodeType: 9, getElementById: () => null };
    expect(enhanceReleaseDelete(document)).toBeNull();
  });
});
