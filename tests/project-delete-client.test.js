import { describe, it, expect, vi, beforeEach } from 'vitest';

// WP11A-2: Delete project from the Edit Project dialog, in place
// (project-delete.js), together with the real Archive module it shares holds
// with (project-archive.js). The dialog binder, the Edit Project controller
// and the shared confirmation are stand-ins (the confirmation's replay is a
// dispatched click and submit here; its own submit gate, the shared
// secondary-action guard, the real binder and every host refresh are covered
// in Chromium); the DOM is a purpose-built shim (no jsdom in this project).

const dialogs = vi.hoisted(() => ({
  freezes: 0,
  frozen: 0,
  feedback: [],
  drafts: [],
  closes: 0,
  state: null,
  // The real binder's dismissal: once closed, it follows the dialog's return
  // location (a deep link's returnTo) unless a registered veto holds.
  followReturn(document, state) {
    const control = state.dialog.querySelector('[data-dialog-return-location]');
    const target = control?.getAttribute('value');
    if (!target) return;
    const vetoed = [...(state.returnVetoes || [])].some((veto) => {
      try { return veto(); } catch { return true; }
    });
    if (!vetoed) document.defaultView.location.assign(target);
  },
}));
vi.mock('../src/static/client/app-dialogs.js', () => ({
  vetoAppDialogReturn: (document, id, predicate) => {
    const state = document.getElementById(id)?.__creatorCrateAppDialogState;
    if (!state || typeof predicate !== 'function') return false;
    state.returnVetoes ||= new Set();
    state.returnVetoes.add(predicate);
    return true;
  },
  freezeAppDialog: () => {
    dialogs.freezes += 1;
    dialogs.frozen += 1;
    return () => { dialogs.frozen -= 1; };
  },
  appDialogFeedback: (document, message, error = false) => {
    dialogs.feedback.push({ message, error });
    const text = document.querySelector('[data-dialog-feedback-text]');
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
    // The binder's reset-on-close: the form shows the saved baseline again.
    state.form.values = JSON.parse(JSON.stringify(state.savedValues));
    dialog.open = false;
    dialog.dispatch('close');
    dialogs.followReturn(document, state);
    return true;
  },
}));

const confirmations = vi.hoisted(() => ({ described: new Map() }));
vi.mock('../src/static/client/confirm-dialog.js', () => ({
  describeAppConfirmation: (control, resolve) => { confirmations.described.set(control, resolve); },
}));

const editController = vi.hoisted(() => ({ current: null }));
vi.mock('../src/static/client/project-edit-dialog.js', () => ({
  PROJECT_EDIT_DIALOG_ID: 'project-edit-dialog',
  PROJECT_ARCHIVED_EVENT: 'project-archived',
  PROJECT_DELETED_EVENT: 'project-deleted',
  enhanceProjectEditDialog: () => editController.current,
}));

const {
  enhanceProjectDelete,
  projectDeleteState,
  PROJECT_DELETE_MESSAGES: M,
  PROJECT_DELETED_HOST_ATTRIBUTE,
} = await import('../src/static/client/project-delete.js');
const { projectArchiveState } = await import('../src/static/client/project-archive.js');

// ---------------------------------------------------------------- DOM shim --

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
  set type(value) { this.attributes.set('type', value); }
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
  matches(selector) {
    const match = selector.match(/^([a-z]+)?(?:\[([\w-]+)\])?$/i);
    if (!match) return false;
    if (match[1] && this.tagName !== match[1].toUpperCase()) return false;
    if (match[2] && !this.hasAttribute(match[2])) return false;
    return Boolean(match[1] || match[2]);
  }
  descendants() { return this.childNodes.flatMap((node) => [node, ...node.descendants()]); }
  querySelectorAll(selector) {
    const parts = selector.split(/\s+/);
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

const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const SAVED = Object.freeze({
  title: 'Moonlit Garden',
  description: 'Saved description',
  notes: '',
  patreonUrl: '',
  status: 'in-progress',
  projectType: 'comic',
  'tagIds[]': ['3'],
});

const DELETED = (overrides = {}) => jsonResponse(200, {
  status: 'success',
  outcome: 'deleted',
  message: 'Project “Moonlit Garden” deleted.',
  cleanup: 'complete',
  projectId: 7,
  project: { id: 7, title: 'Moonlit Garden', deleted: true },
  projectPagesRemain: false,
  redirect: '/projects',
  ...overrides,
});

function setup({ projectId = '7', withFetch = true, pathname = '/projects' } = {}) {
  const root = new FakeNode('html');
  const document = {
    nodeType: 9,
    documentElement: root,
    activeElement: null,
    events: [],
    createElement: (tag) => new FakeNode(tag),
    querySelector: (selector) => root.querySelector(selector),
    getElementById: (id) => root.descendants().find((node) => node.id === id) || null,
    dispatchEvent(event) { this.events.push(event); },
  };
  root.document = document;
  document.body = root.appendChild(new FakeNode('body'));
  const main = document.body.appendChild(new FakeNode('main', { id: 'main-content' }));
  const feedback = main.appendChild(new FakeNode('div', { 'data-dialog-feedback': '' }));
  feedback.appendChild(new FakeNode('p', { 'data-dialog-feedback-text': '' }));
  const content = main.appendChild(new FakeNode('section', { 'data-project-detail': projectId }));
  const editTrigger = content.appendChild(new FakeNode('button', { 'data-project-edit-id': projectId }));
  const dialogHost = main.appendChild(new FakeNode('div'));
  const sibling = dialogHost.appendChild(new FakeNode('div', { 'data-other-dialog': '' }));
  const dialog = dialogHost.appendChild(new FakeNode('dialog', { id: 'project-edit-dialog' }));
  dialog.open = true;
  const editForm = dialog.appendChild(new FakeNode('form', { 'data-dialog-form': '' }));
  editForm.values = JSON.parse(JSON.stringify(SAVED));
  const archiveForm = dialog.appendChild(new FakeNode('form', {
    'data-project-archive-form': '', action: `/projects/${projectId}/archive`,
  }));
  archiveForm.csrf = 'token-1';
  const archiveButton = archiveForm.appendChild(new FakeNode('button', { 'data-confirm': 'Archive this project?' }));
  const form = dialog.appendChild(new FakeNode('form', {
    'data-project-delete-form': '', action: `/projects/${projectId}/delete`,
  }));
  form.csrf = 'token-1';
  const button = form.appendChild(new FakeNode('button', { 'data-confirm': 'Delete this project permanently?' }));
  const status = dialog.appendChild(new FakeNode('div', { 'data-dialog-status': '' }));

  const dialogState = {
    dialog, form: editForm, savedValues: JSON.parse(JSON.stringify(SAVED)), submitting: false, beforeClose: null,
  };
  dialogState.beforeClose = () => !dialogState.submitting;
  dialog.__creatorCrateAppDialogState = dialogState;
  dialogs.state = dialogState;
  editController.current = { projectId, onLoaded: null };

  const fetch = vi.fn();
  const location = { pathname, assign: vi.fn() };
  const windowObject = {
    fetch: withFetch ? fetch : undefined,
    location,
    FormData: class { constructor(target) { this.entries = [['_csrf', target.csrf]]; } },
    URLSearchParams: class { constructor(data) { this.value = new URLSearchParams(data.entries).toString(); } toString() { return this.value; } },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
  };
  document.defaultView = windowObject;
  const handle = enhanceProjectDelete(document);

  const replay = (control, target) => {
    const click = control.click();
    if (click.defaultPrevented) return click;
    return target.dispatch('submit');
  };
  return {
    document, main, content, sibling, editTrigger, dialog, dialogState, editForm, form, button, archiveForm,
    archiveButton, status, feedback, fetch, location, handle,
    confirmAndSubmit: () => replay(button, form),
    confirmArchive: () => replay(archiveButton, archiveForm),
    deletePosts: () => fetch.mock.calls.filter(([url, init]) => init?.method === 'POST' && url.endsWith('/delete')),
    archivePosts: () => fetch.mock.calls.filter(([url, init]) => init?.method === 'POST' && url.endsWith('/archive')),
    posts: () => fetch.mock.calls.filter(([, init]) => init?.method === 'POST'),
    gets: () => fetch.mock.calls.filter(([, init]) => init?.method === 'GET'),
    describe: () => confirmations.described.get(button)(),
    trySave: () => editForm.dispatch('submit'),
    reopen: (id = projectId) => {
      dialog.open = true;
      editController.current.projectId = id;
      editController.current.onLoaded?.(id);
    },
    dismiss: () => {
      if (!dialogState.beforeClose({})) return false;
      editForm.values = JSON.parse(JSON.stringify(dialogState.savedValues));
      dialog.open = false;
      dialog.dispatch('close');
      dialogs.followReturn(document, dialogState);
      return true;
    },
    // Project Detail's ?edit=1&returnTo= deep link renders this in the form.
    addReturnTo: (value) => editForm.appendChild(new FakeNode('input', {
      name: 'returnTo', 'data-dialog-return-location': '', value,
    })),
  };
}

beforeEach(() => {
  dialogs.freezes = 0;
  dialogs.frozen = 0;
  dialogs.feedback = [];
  dialogs.drafts = [];
  dialogs.closes = 0;
  confirmations.described.clear();
});

describe('project Delete in place — confirmation and identity', () => {
  it('C1 / C5 — names the saved project, the scope, and each unsaved field, never saving them', () => {
    const t = setup();
    const plain = t.describe();
    expect(plain.title).toBe('Delete project?');
    expect(plain.confirmLabel).toBe('Delete project');
    expect(plain.cancelLabel).toBe('Cancel');
    expect(plain.message).toMatch(/^Delete “Moonlit Garden” permanently\? This deletes the project, its releases, its assets and its project folder with every file in it/);
    expect(plain.message).toContain('Linked notes are kept but no longer linked to it.');
    expect(plain.message).toContain('This cannot be undone.');
    t.editForm.values.title = 'Draft title';
    t.editForm.values.notes = 'Draft notes';
    t.editForm.values.status = 'ready';
    const dirty = t.describe();
    expect(dirty.title).toBe('Delete project with unsaved changes?');
    // The saved title names the project; the draft does not.
    expect(dirty.message).toContain('Delete “Moonlit Garden” permanently?');
    expect(dirty.message).toContain('(title, notes and status) will not be saved: they are kept if you cancel or the project is not deleted, and lost if it is deleted.');
    expect(dirty.cancelLabel).toBe('Keep editing');
  });

  it('C2 / C3 — an unconfirmed (cancelled, escaped, dismissed) confirmation sends nothing and changes nothing', () => {
    const t = setup();
    t.editForm.values.title = 'Draft title';
    t.describe();
    expect(t.fetch).not.toHaveBeenCalled();
    expect(t.editForm.values.title).toBe('Draft title');
    expect(projectDeleteState(t.document, '7')).toBeNull();
    expect(dialogs.freezes).toBe(0);
  });

  it('C4 / C7 / C8 — one confirmed Delete sends one POST for the captured project; replays while pending are refused', async () => {
    const t = setup();
    const post = deferred();
    t.fetch.mockReturnValueOnce(post.promise);
    t.confirmAndSubmit();
    // The controller moves on (it cannot while frozen; this proves the request kept its target).
    t.confirmAndSubmit();
    t.form.dispatch('submit');
    t.form.dispatch('submit');
    await flush();
    expect(t.deletePosts()).toHaveLength(1);
    const [url, init] = t.deletePosts()[0];
    expect(url).toBe('/projects/7/delete');
    expect(init.headers).toEqual({ Accept: 'application/json' });
    expect(String(init.body)).toBe('_csrf=token-1');
    expect(t.dialogState.submitting).toBe(true);
    expect(t.editForm.getAttribute('aria-busy')).toBe('true');
    expect(t.form.getAttribute('data-project-delete-hold')).toBe('pending');
    expect(dialogs.frozen).toBe(1);
    expect(t.status.textContent).toContain('Deleting “Moonlit Garden”…');
    expect(t.status.textContent).toContain(M.pending);
    expect(t.dialogState.beforeClose({})).toBe(false);
    post.resolve(DELETED());
    await flush();
    expect(t.deletePosts()).toHaveLength(1);
  });

  it('C4 — a mismatched form target or an unloaded dialog never posts', () => {
    const t = setup();
    t.form.setAttribute('action', '/projects/8/delete');
    t.confirmAndSubmit();
    expect(t.fetch).not.toHaveBeenCalled();
    expect(t.status.textContent).toContain(M.wrongTarget);
    t.form.setAttribute('action', '/projects/7/delete');
    editController.current.projectId = null;
    t.confirmAndSubmit();
    expect(t.fetch).not.toHaveBeenCalled();
    expect(t.status.textContent).toContain(M.notLoaded);
  });

  it('C25 — binding twice keeps one set of listeners', async () => {
    const t = setup();
    expect(enhanceProjectDelete(t.document)).toBe(t.handle);
    t.fetch.mockResolvedValueOnce(DELETED());
    t.confirmAndSubmit();
    await flush();
    expect(t.deletePosts()).toHaveLength(1);
    expect(t.document.events.filter((event) => event.type === 'project-deleted')).toHaveLength(1);
  });

  it('C26 — without fetch the native form submits untouched', () => {
    const t = setup({ withFetch: false });
    const event = t.confirmAndSubmit();
    expect(event.defaultPrevented).toBe(false);
    expect(projectDeleteState(t.document, '7')).toBeNull();
  });
});

describe('project Delete in place — coordination with Save and Archive', () => {
  it('C9 — a pending Edit Save refuses Delete before it is sent', () => {
    const t = setup();
    t.dialogState.submitting = true;
    const click = t.button.click();
    expect(click.defaultPrevented).toBe(true);
    t.form.dispatch('submit');
    expect(t.fetch).not.toHaveBeenCalled();
    expect(t.status.textContent).toContain(M.saveBusy);
  });

  it('C10 — a pending, then unconfirmed, Archive refuses Delete', async () => {
    const t = setup();
    const archive = deferred();
    t.fetch.mockReturnValueOnce(archive.promise);
    t.confirmArchive();
    await flush();
    expect(t.archivePosts()).toHaveLength(1);
    expect(t.button.click().defaultPrevented).toBe(true);
    expect(t.status.textContent).toContain(M.archivePending);
    archive.reject(new TypeError('lost'));
    t.fetch.mockResolvedValueOnce(jsonResponse(200, { status: 'success', project: { id: 7 } }));
    await flush();
    expect(projectArchiveState(t.document, '7').phase).toBe('unresolved');
    t.confirmAndSubmit();
    expect(t.deletePosts()).toHaveLength(0);
    expect(t.status.textContent).toContain(M.archiveHeld);
  });

  it('C11 — a pending Delete freezes the dialog; an unconfirmed one refuses Save and Archive', async () => {
    const t = setup();
    t.editForm.values.title = 'Draft title';
    t.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const read = deferred();
    t.fetch.mockReturnValueOnce(read.promise);
    t.confirmAndSubmit();
    expect(dialogs.frozen).toBe(1);
    await flush();
    expect(projectDeleteState(t.document, '7').phase).toBe('unresolved');
    expect(dialogs.frozen).toBe(0);
    const save = t.trySave();
    expect(save.defaultPrevented).toBe(true);
    expect(t.status.textContent).toContain(M.saveHeld);
    const archiveClick = t.archiveButton.click();
    expect(archiveClick.defaultPrevented).toBe(true);
    const archiveSubmit = t.archiveForm.dispatch('submit');
    expect(archiveSubmit.defaultPrevented).toBe(true);
    expect(t.status.textContent).toContain(M.archiveRefused);
    expect(t.archivePosts()).toHaveLength(0);
    expect(projectArchiveState(t.document, '7')).toBeNull();
    expect(t.editForm.values.title).toBe('Draft title');
    expect(t.deletePosts()).toHaveLength(1);
  });
});

describe('project Delete in place — acknowledged outcomes', () => {
  it('C12 / C13 — on a surviving host, success closes the dialog, discards the warned drafts and asks the host to re-read', async () => {
    const t = setup({ pathname: '/projects' });
    t.editForm.values.description = 'Unsaved description';
    t.fetch.mockResolvedValueOnce(DELETED());
    t.confirmAndSubmit();
    await flush();
    expect(t.dialog.open).toBe(false);
    expect(dialogs.closes).toBe(1);
    expect(dialogs.frozen).toBe(0);
    expect(t.editForm.values.description).toBe('Saved description');
    expect(dialogs.feedback.at(-1)).toEqual({ message: 'Project “Moonlit Garden” deleted.', error: false });
    const events = t.document.events.filter((event) => event.type === 'project-deleted');
    expect(events).toHaveLength(1);
    expect(events[0].detail).toMatchObject({
      projectId: '7', outcome: 'deleted', confirmed: true, cleanupComplete: true, hostRetired: false,
    });
    expect(t.location.assign).not.toHaveBeenCalled();
    expect(t.main.hasAttribute(PROJECT_DELETED_HOST_ATTRIBUTE)).toBe(false);
    expect(projectDeleteState(t.document, '7')).toMatchObject({ phase: 'deleted', drafts: null });
    // No Edit Save, no second Delete, no Archive.
    expect(t.fetch).toHaveBeenCalledTimes(1);
    t.reopen();
    t.confirmAndSubmit();
    t.trySave();
    t.confirmArchive();
    expect(t.fetch).toHaveBeenCalledTimes(1);
  });

  it('C14 — on the project\'s own page, a clean delete retires the content and navigates once to Projects', async () => {
    const t = setup({ pathname: '/projects/7/assets' });
    // A deep link's return location would navigate a second time on close.
    const returnTo = t.dialog.appendChild(new FakeNode('input', { 'data-dialog-return-location': '', value: '/projects/7/assets' }));
    t.fetch.mockResolvedValueOnce(DELETED({ redirect: 'https://evil.example/' }));
    t.confirmAndSubmit();
    await flush();
    expect(t.location.assign).toHaveBeenCalledTimes(1);
    // Only a local Projects destination is ever followed.
    expect(t.location.assign).toHaveBeenCalledWith('/projects');
    expect(returnTo.isConnected).toBe(false);
    expect(t.main.getAttribute(PROJECT_DELETED_HOST_ATTRIBUTE)).toBe('7');
    expect(t.content.hasAttribute('inert')).toBe(true);
    expect(t.sibling.hasAttribute('inert')).toBe(true);
    expect(t.feedback.hasAttribute('inert')).toBe(false);
    expect(t.dialog.hasAttribute('inert')).toBe(false);
    expect(t.feedback.textContent).toContain(`Project “Moonlit Garden” deleted. ${M.opening}`);
    expect(t.feedback.querySelector('[data-project-delete-destination]').getAttribute('href')).toBe('/projects');
    expect(t.document.activeElement).toBe(t.main);
    const event = t.document.events.find((entry) => entry.type === 'project-deleted');
    expect(event.detail.hostRetired).toBe(true);
    expect(t.deletePosts()).toHaveLength(1);
  });

  it('C15 — a committed delete with incomplete cleanup is never reported as clean, and the page stays to say so', async () => {
    const t = setup({ pathname: '/projects/7' });
    const message = 'Project “Moonlit Garden” was deleted, but its folder could not be fully removed from the projects folder. It needs recovery.';
    t.fetch.mockResolvedValueOnce(jsonResponse(500, {
      status: 'error',
      code: 'PROJECT_DELETE_CLEANUP_INCOMPLETE',
      outcome: 'deleted-cleanup-incomplete',
      message,
      projectId: 7,
      project: { id: 7, title: 'Moonlit Garden', deleted: true },
      projectPagesRemain: false,
      redirect: '/projects',
      recoveryRequired: true,
      cleanup: 'incomplete',
    }));
    t.confirmAndSubmit();
    await flush();
    expect(t.location.assign).not.toHaveBeenCalled();
    expect(dialogs.feedback.at(-1)).toEqual({ message, error: true });
    expect(t.main.getAttribute(PROJECT_DELETED_HOST_ATTRIBUTE)).toBe('7');
    expect(t.content.hasAttribute('inert')).toBe(true);
    expect(t.feedback.querySelector('[data-project-delete-destination]')).not.toBeNull();
    const event = t.document.events.find((entry) => entry.type === 'project-deleted');
    expect(event.detail).toMatchObject({ outcome: 'deleted-cleanup-incomplete', confirmed: true, cleanupComplete: false });
    expect(projectDeleteState(t.document, '7').phase).toBe('deleted');
    t.reopen();
    t.confirmAndSubmit();
    expect(t.deletePosts()).toHaveLength(1);
  });

  it('C16 — recovery required keeps the page, the dialog and the drafts, and holds every action without reading', async () => {
    const t = setup({ pathname: '/projects/7' });
    t.editForm.values.notes = 'Draft notes';
    t.fetch.mockResolvedValueOnce(jsonResponse(500, {
      status: 'error', code: 'PROJECT_DELETE_RECOVERY_REQUIRED', outcome: 'recovery-required',
      recoveryRequired: true, message: 'The project was not deleted, but its folder could not be put back.', projectId: 7,
    }));
    t.confirmAndSubmit();
    await flush();
    expect(t.dialog.open).toBe(true);
    expect(t.editForm.values.notes).toBe('Draft notes');
    expect(t.status.textContent).toContain('The project was not deleted, but its folder could not be put back.');
    expect(t.status.textContent).toContain(M.draftsKept);
    expect(t.gets()).toHaveLength(0);
    expect(t.main.hasAttribute(PROJECT_DELETED_HOST_ATTRIBUTE)).toBe(false);
    expect(t.document.events.filter((event) => event.type === 'project-deleted')).toHaveLength(0);
    t.confirmAndSubmit();
    expect(t.trySave().defaultPrevented).toBe(true);
    t.confirmArchive();
    expect(t.posts()).toHaveLength(1);
    expect(t.status.textContent).toContain(M.recoveryHeld);
    expect(t.status.textContent).toContain(M.saveRecoveryHeld);
  });

  it('C6 — a proven refusal or failure thaws with every draft and leaves Delete available', async () => {
    for (const response of [
      jsonResponse(409, { status: 'error', code: 'PROJECT_OWNERSHIP', outcome: 'refused', message: 'Project directory ownership marker is missing. Nothing was deleted.' }),
      jsonResponse(500, { status: 'error', code: 'PROJECT_DELETE_FAILED', outcome: 'failed', message: 'The project could not be deleted. Nothing was deleted, and its folder is where it was. Please try again.' }),
      jsonResponse(403, { status: 'error', message: 'Invalid CSRF token.' }),
    ]) {
      const t = setup({ pathname: '/projects/7' });
      t.editForm.values.title = 'Draft title';
      t.fetch.mockResolvedValueOnce(response);
      t.confirmAndSubmit();
      await flush();
      expect(t.dialog.open).toBe(true);
      expect(dialogs.frozen).toBe(0);
      expect(t.dialogState.submitting).toBe(false);
      expect(t.editForm.values.title).toBe('Draft title');
      expect(t.status.textContent).toMatch(/Nothing was deleted[.,]/);
      expect(t.status.textContent).toContain(M.draftsKept);
      expect(projectDeleteState(t.document, '7')).toBeNull();
      expect(t.form.hasAttribute('data-project-delete-hold')).toBe(false);
      expect(t.main.hasAttribute(PROJECT_DELETED_HOST_ATTRIBUTE)).toBe(false);
      expect(t.gets()).toHaveLength(0);
      // A later, explicit Delete is a new confirmed request.
      t.fetch.mockResolvedValueOnce(DELETED());
      t.confirmAndSubmit();
      await flush();
      expect(t.deletePosts()).toHaveLength(2);
    }
  });

  it('C6 — a 404 refusal means the project was already gone: held, drafts kept, not deleted by this page', async () => {
    const t = setup({ pathname: '/projects/7' });
    t.editForm.values.title = 'Draft title';
    t.fetch.mockResolvedValueOnce(jsonResponse(404, {
      status: 'error', code: 'PROJECT_NOT_FOUND', outcome: 'refused', message: 'This project no longer exists. Nothing was deleted by this request.',
    }));
    t.confirmAndSubmit();
    await flush();
    expect(projectDeleteState(t.document, '7').phase).toBe('missing');
    expect(t.editForm.values.title).toBe('Draft title');
    expect(t.location.assign).not.toHaveBeenCalled();
    expect(t.main.getAttribute(PROJECT_DELETED_HOST_ATTRIBUTE)).toBe('7');
    const event = t.document.events.find((entry) => entry.type === 'project-deleted');
    expect(event.detail).toMatchObject({ outcome: 'missing', confirmed: false });
  });
});

describe('project Delete in place — lost answers and GET-only checks', () => {
  it('C17 / C18 / C20 — a lost answer is never re-sent; a read finding the project present keeps the hold', async () => {
    const t = setup({ pathname: '/projects/7' });
    t.editForm.values.title = 'Draft title';
    t.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    t.fetch.mockResolvedValueOnce(jsonResponse(200, { status: 'success', project: { id: 7 } }));
    t.confirmAndSubmit();
    await flush();
    expect(t.deletePosts()).toHaveLength(1);
    expect(t.gets()).toHaveLength(1);
    expect(t.gets()[0][0]).toBe('/projects/7/edit');
    expect(projectDeleteState(t.document, '7').phase).toBe('unresolved');
    expect(t.status.textContent).toContain(`${M.unconfirmed} ${M.stillPresent}`);
    const check = t.status.querySelector('[data-project-delete-check]');
    const feedbackCheck = t.feedback.querySelector('[data-project-delete-feedback-check]');
    expect(check?.textContent).toBe('Check again');
    expect(feedbackCheck?.textContent).toBe('Check again');
    expect(t.editForm.values.title).toBe('Draft title');
    expect(t.main.hasAttribute(PROJECT_DELETED_HOST_ATTRIBUTE)).toBe(false);

    // Dismissal and reopening keep the drafts and the hold.
    t.editForm.values.notes = 'Later draft';
    expect(t.dismiss()).toBe(true);
    expect(t.editForm.values.title).toBe('Moonlit Garden');
    t.reopen();
    expect(t.editForm.values).toMatchObject({ title: 'Draft title', notes: 'Later draft' });
    expect(t.form.getAttribute('data-project-delete-hold')).toBe('unresolved');
    expect(t.status.querySelector('[data-project-delete-check]')).not.toBeNull();

    // Check again reads only, and a present project still keeps the hold.
    t.fetch.mockResolvedValueOnce(jsonResponse(409, { status: 'error', code: 'PROJECT_ARCHIVED' }));
    t.status.querySelector('[data-project-delete-check]').click();
    await flush();
    expect(t.gets()).toHaveLength(2);
    expect(t.deletePosts()).toHaveLength(1);
    expect(projectDeleteState(t.document, '7').phase).toBe('unresolved');
    t.confirmAndSubmit();
    expect(t.deletePosts()).toHaveLength(1);
    expect(t.status.textContent).toContain(M.unresolved);
  });

  it('C19 — a read finding the project gone reports an observation, never a clean deletion', async () => {
    const t = setup({ pathname: '/projects/7' });
    t.fetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new Error('unreadable'); } });
    t.fetch.mockResolvedValueOnce(jsonResponse(404, { status: 'error', code: 'PROJECT_NOT_FOUND' }));
    t.confirmAndSubmit();
    await flush();
    expect(projectDeleteState(t.document, '7').phase).toBe('missing');
    expect(t.status.textContent).toContain(M.observedMissing);
    expect(dialogs.feedback.at(-1).error).toBe(true);
    expect(dialogs.feedback.some((entry) => entry.error === false)).toBe(false);
    expect(t.location.assign).not.toHaveBeenCalled();
    expect(t.main.getAttribute(PROJECT_DELETED_HOST_ATTRIBUTE)).toBe('7');
    const event = t.document.events.find((entry) => entry.type === 'project-deleted');
    expect(event.detail).toMatchObject({ outcome: 'observed-missing', confirmed: false, cleanupComplete: false });
    expect(t.deletePosts()).toHaveLength(1);
  });

  it('C17 — an unknown 500 is unresolved, and a failed read offers Check again', async () => {
    const t = setup();
    t.fetch.mockResolvedValueOnce(jsonResponse(500, { status: 'error', code: 'PROJECT_DELETE_UNKNOWN', outcome: 'unknown' }));
    t.fetch.mockRejectedValueOnce(new TypeError('offline'));
    t.confirmAndSubmit();
    await flush();
    expect(projectDeleteState(t.document, '7').phase).toBe('unresolved');
    expect(t.status.textContent).toBe(`${M.unconfirmed} ${M.checkFailed}Check again`);
  });

  it('C23 — a Check answer that arrives after a newer Check is ignored', async () => {
    const t = setup();
    t.fetch.mockRejectedValueOnce(new TypeError('lost'));
    const first = deferred();
    t.fetch.mockReturnValueOnce(first.promise);
    t.confirmAndSubmit();
    await flush();
    const second = deferred();
    t.fetch.mockReturnValueOnce(second.promise);
    void t.handle.check('7');
    second.resolve(jsonResponse(200, { status: 'success', project: { id: 7 } }));
    await flush();
    expect(t.status.textContent).toContain(M.stillPresent);
    first.resolve(jsonResponse(404, { status: 'error', code: 'PROJECT_NOT_FOUND' }));
    await flush();
    expect(projectDeleteState(t.document, '7').phase).toBe('unresolved');
    expect(t.document.events.filter((event) => event.type === 'project-deleted')).toHaveLength(0);
  });

  it('C24 — another project loads with Delete available and its own saved values', async () => {
    const t = setup();
    t.fetch.mockRejectedValueOnce(new TypeError('lost'));
    t.fetch.mockResolvedValueOnce(jsonResponse(200, { status: 'success', project: { id: 7 } }));
    t.confirmAndSubmit();
    await flush();
    t.dismiss();
    t.form.setAttribute('action', '/projects/8/delete');
    t.archiveForm.setAttribute('action', '/projects/8/archive');
    const draftsBefore = dialogs.drafts.length;
    t.reopen('8');
    expect(dialogs.drafts.length).toBe(draftsBefore);
    expect(t.form.hasAttribute('data-project-delete-hold')).toBe(false);
    expect(t.trySave().defaultPrevented).toBe(false);
    t.fetch.mockResolvedValueOnce(DELETED({ projectId: 8, project: { id: 8, title: 'Other', deleted: true } }));
    t.confirmAndSubmit();
    await flush();
    expect(t.deletePosts().map(([url]) => url)).toEqual(['/projects/7/delete', '/projects/8/delete']);
    expect(projectDeleteState(t.document, '7').phase).toBe('unresolved');
  });
});

// WP11A-F1: a deep-linked Edit Project (?edit=1&returnTo=) follows returnTo
// when dismissed. While this page holds a Delete, that would replace the
// document and take the hold, the drafts and Check again with it.
describe('project Delete in place — WP11A-F1 deep-link dismissal', () => {
  const RETURN_TO = '/projects/7/assets?view=list';
  const PRESENT = () => jsonResponse(200, { status: 'success', project: { id: 7 } });

  async function unresolvedDeepLink({ check = PRESENT() } = {}) {
    const t = setup({ pathname: '/projects/7' });
    t.addReturnTo(RETURN_TO);
    t.editForm.values.title = 'Draft title';
    t.editForm.values.description = 'Draft description';
    t.editForm.values['tagIds[]'] = ['3', '5'];
    t.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    if (check instanceof Error) t.fetch.mockRejectedValueOnce(check);
    else t.fetch.mockResolvedValueOnce(check);
    t.confirmAndSubmit();
    await flush();
    return t;
  }

  it('C1 / C6 — an unresolved Delete, read as present, is dismissed without following returnTo', async () => {
    const t = await unresolvedDeepLink();
    expect(projectDeleteState(t.document, '7').phase).toBe('unresolved');
    expect(t.gets()).toHaveLength(1);

    expect(t.dismiss()).toBe(true);
    expect(t.dialog.open).toBe(false);
    expect(t.location.assign).not.toHaveBeenCalled();
    // The return location itself is untouched; only this dismissal stays.
    expect(t.editForm.querySelector('[data-dialog-return-location]')?.getAttribute('value')).toBe(RETURN_TO);
    expect(projectDeleteState(t.document, '7')).toMatchObject({
      phase: 'unresolved',
      drafts: { title: 'Draft title', description: 'Draft description', 'tagIds[]': ['3', '5'] },
    });
    // The saved baseline is not the draft.
    expect(t.dialogState.savedValues.title).toBe('Moonlit Garden');
    expect(t.feedback.querySelector('[data-project-delete-feedback-check]')).not.toBeNull();

    t.reopen();
    expect(t.editForm.values).toMatchObject({ title: 'Draft title', description: 'Draft description' });
    expect(t.trySave().defaultPrevented).toBe(true);
    t.confirmAndSubmit();
    t.confirmArchive();
    expect(t.posts()).toHaveLength(1);
    expect(t.deletePosts()).toHaveLength(1);
  });

  it('C3 — a lost Delete answer and a failed read: dismissal stays, Check again reads only', async () => {
    const t = await unresolvedDeepLink({ check: new TypeError('offline') });
    expect(t.status.textContent).toContain(M.checkFailed);
    t.dismiss();
    expect(t.location.assign).not.toHaveBeenCalled();
    const feedbackCheck = t.feedback.querySelector('[data-project-delete-feedback-check]');
    expect(feedbackCheck?.textContent).toBe('Check again');

    t.fetch.mockRejectedValueOnce(new TypeError('still offline'));
    feedbackCheck.click();
    await flush();
    expect(t.gets()).toHaveLength(2);
    expect(t.posts()).toHaveLength(1);
    t.reopen();
    t.dismiss();
    expect(t.location.assign).not.toHaveBeenCalled();
    expect(projectDeleteState(t.document, '7').drafts.title).toBe('Draft title');
  });

  it('C4 — recovery required: dismissal keeps the page, the drafts and the hold', async () => {
    const t = setup({ pathname: '/projects/7' });
    t.addReturnTo(RETURN_TO);
    t.editForm.values.notes = 'Draft notes';
    t.fetch.mockResolvedValueOnce(jsonResponse(500, {
      status: 'error', code: 'PROJECT_DELETE_RECOVERY_REQUIRED', outcome: 'recovery-required',
      recoveryRequired: true, message: 'The project was not deleted, but its folder could not be put back.', projectId: 7,
    }));
    t.confirmAndSubmit();
    await flush();
    t.dismiss();
    expect(t.location.assign).not.toHaveBeenCalled();
    expect(dialogs.feedback.at(-1).message).toContain('could not be put back');
    t.reopen();
    expect(t.editForm.values.notes).toBe('Draft notes');
    expect(t.trySave().defaultPrevented).toBe(true);
    t.confirmAndSubmit();
    expect(t.posts()).toHaveLength(1);
  });

  it('C5 / C12 — repeated dismissal, reopening, checks and rebinding keep the hold, the drafts and one veto', async () => {
    const t = await unresolvedDeepLink();
    expect(enhanceProjectDelete(t.document)).toBe(t.handle);
    for (let round = 0; round < 3; round += 1) {
      t.dismiss();
      t.reopen();
      expect(t.editForm.values.title).toBe('Draft title');
      t.fetch.mockResolvedValueOnce(PRESENT());
      t.status.querySelector('[data-project-delete-check]').click();
      await flush();
      expect(projectDeleteState(t.document, '7').phase).toBe('unresolved');
    }
    t.dismiss();
    expect(t.location.assign).not.toHaveBeenCalled();
    expect(t.gets()).toHaveLength(4);
    expect(t.posts()).toHaveLength(1);
    // Archive's and Delete's, once each.
    expect(t.dialogState.returnVetoes.size).toBe(2);
  });

  it('C2 — an unresolved Archive holds the page by itself; Delete having nothing held cannot lift it', async () => {
    const t = setup({ pathname: '/projects/7' });
    t.addReturnTo(RETURN_TO);
    t.editForm.values.title = 'Draft title';
    t.fetch.mockRejectedValueOnce(new TypeError('lost'));
    t.fetch.mockResolvedValueOnce(PRESENT());
    t.confirmArchive();
    await flush();
    expect(projectArchiveState(t.document, '7').phase).toBe('unresolved');
    expect(projectDeleteState(t.document, '7')).toBeNull();
    t.dismiss();
    expect(t.location.assign).not.toHaveBeenCalled();
    t.reopen();
    expect(t.editForm.values.title).toBe('Draft title');
    t.confirmAndSubmit();
    expect(t.trySave().defaultPrevented).toBe(true);
    expect(t.posts()).toHaveLength(1);
    expect(t.archivePosts()).toHaveLength(1);
  });

  it('C7 — with nothing held, a deep-linked dismissal returns as it always has', () => {
    const t = setup({ pathname: '/projects/7' });
    t.addReturnTo(RETURN_TO);
    t.dismiss();
    expect(t.location.assign).toHaveBeenCalledTimes(1);
    expect(t.location.assign).toHaveBeenCalledWith(RETURN_TO);
  });

  it('C8 — after a proven refusal the drafts stay, and dismissal returns as before', async () => {
    const t = setup({ pathname: '/projects/7' });
    t.addReturnTo(RETURN_TO);
    t.editForm.values.title = 'Draft title';
    t.fetch.mockResolvedValueOnce(jsonResponse(409, {
      status: 'error', code: 'PROJECT_OWNERSHIP', outcome: 'refused', message: 'Project directory ownership marker is missing. Nothing was deleted.',
    }));
    t.confirmAndSubmit();
    await flush();
    expect(t.editForm.values.title).toBe('Draft title');
    expect(projectDeleteState(t.document, '7')).toBeNull();
    t.dismiss();
    expect(t.location.assign).toHaveBeenCalledTimes(1);
    expect(t.location.assign).toHaveBeenCalledWith(RETURN_TO);
  });

  it('C10 — a confirmed clean Delete on its own deep-linked page navigates once, to Projects only', async () => {
    const t = setup({ pathname: '/projects/7' });
    t.addReturnTo(RETURN_TO);
    t.fetch.mockResolvedValueOnce(DELETED());
    t.confirmAndSubmit();
    await flush();
    expect(t.location.assign.mock.calls).toEqual([['/projects']]);
    t.reopen();
    t.dismiss();
    expect(t.location.assign).toHaveBeenCalledTimes(1);
    expect(t.deletePosts()).toHaveLength(1);
  });

  it('C11 — cleanup incomplete: no navigation at all, the recovery notice and Projects link stay', async () => {
    const t = setup({ pathname: '/projects/7' });
    t.addReturnTo(RETURN_TO);
    t.fetch.mockResolvedValueOnce(jsonResponse(500, {
      status: 'error', code: 'PROJECT_DELETE_CLEANUP_INCOMPLETE', outcome: 'deleted-cleanup-incomplete',
      message: 'Deleted, but its folder needs recovery.', projectId: 7,
      project: { id: 7, deleted: true }, redirect: '/projects', cleanup: 'incomplete',
    }));
    t.confirmAndSubmit();
    await flush();
    t.reopen();
    t.dismiss();
    expect(t.location.assign).not.toHaveBeenCalled();
    expect(t.feedback.textContent).toContain('Deleted, but its folder needs recovery.');
    expect(t.feedback.querySelector('[data-project-delete-destination]').getAttribute('href')).toBe('/projects');
    expect(t.deletePosts()).toHaveLength(1);
  });

  it('C13 — a hosted dialog (no returnTo) keeps its unresolved hold across dismissal, without navigating', async () => {
    for (const pathname of ['/', '/projects', '/projects/7', '/projects/7/assets']) {
      const t = setup({ pathname });
      t.editForm.values.title = 'Draft title';
      t.fetch.mockRejectedValueOnce(new TypeError('lost'));
      t.fetch.mockResolvedValueOnce(PRESENT());
      t.confirmAndSubmit();
      await flush();
      t.dismiss();
      t.reopen();
      expect(t.location.assign).not.toHaveBeenCalled();
      expect(t.editForm.values.title).toBe('Draft title');
      expect(t.trySave().defaultPrevented).toBe(true);
    }
  });
});
