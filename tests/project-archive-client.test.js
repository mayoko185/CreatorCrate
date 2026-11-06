import { describe, it, expect, vi, beforeEach } from 'vitest';

// WP11A-1: Archive project from the Edit Project dialog, in place
// (project-archive.js). The dialog binder, the Edit Project controller and
// the shared confirmation are stand-ins (the confirmation's replay is a
// dispatched click and submit here; its own gate, the real binder and every
// host refresh are covered in Chromium); the DOM is a purpose-built shim (no
// jsdom in this project).

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
    const feedback = document.querySelector('[data-dialog-feedback]');
    if (feedback) feedback.textContent = message;
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
  enhanceProjectEditDialog: () => editController.current,
}));

const {
  enhanceProjectArchive,
  projectArchiveState,
  unsavedProjectEditLabels,
  PROJECT_ARCHIVE_MESSAGES: M,
} = await import('../src/static/client/project-archive.js');

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
  // Capture from the root to the target, then bubble back; stopPropagation
  // and stopImmediatePropagation as the DOM defines them.
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
  title: 'Moonlit Garden',
  description: 'Saved description',
  notes: '',
  patreonUrl: '',
  status: 'in-progress',
  projectType: 'comic',
  'tagIds[]': ['3'],
});

function setup({ projectId = '7', withFetch = true } = {}) {
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
  const dialog = document.body.appendChild(new FakeNode('dialog', { id: 'project-edit-dialog' }));
  dialog.open = true;
  const editForm = dialog.appendChild(new FakeNode('form', { 'data-dialog-form': '' }));
  editForm.values = JSON.parse(JSON.stringify(SAVED));
  const disclosure = dialog.appendChild(new FakeNode('details', { 'data-project-edit-action': 'archive' }));
  const form = disclosure.appendChild(new FakeNode('form', {
    'data-project-archive-form': '', action: `/projects/${projectId}/archive`,
  }));
  form.csrf = 'token-1';
  const button = form.appendChild(new FakeNode('button', { 'data-confirm': 'Archive this project? This cannot be undone.' }));
  const status = dialog.appendChild(new FakeNode('div', { 'data-dialog-status': '' }));

  const dialogState = {
    dialog, form: editForm, savedValues: JSON.parse(JSON.stringify(SAVED)), submitting: false, beforeClose: null,
  };
  // project-edit-dialog.js's own guard: a pending submit keeps the dialog open.
  dialogState.beforeClose = () => !dialogState.submitting;
  dialog.__creatorCrateAppDialogState = dialogState;
  dialogs.state = dialogState;
  editController.current = { projectId, onLoaded: null };

  const fetch = vi.fn();
  const location = { pathname: `/projects/${projectId}`, assign: vi.fn() };
  const windowObject = {
    fetch: withFetch ? fetch : undefined,
    location,
    FormData: class { constructor(target) { this.entries = [['_csrf', target.csrf]]; } },
    URLSearchParams: class { constructor(data) { this.value = new URLSearchParams(data.entries).toString(); } toString() { return this.value; } },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
  };
  document.defaultView = windowObject;
  const handle = enhanceProjectArchive(document);

  // The confirmation's Archive: its replay clicks the control and submits.
  const confirmAndSubmit = () => {
    const click = button.click();
    if (click.defaultPrevented) return click;
    return form.dispatch('submit');
  };
  return {
    document, dialog, dialogState, editForm, form, button, status, feedback, fetch, location, handle, confirmAndSubmit,
    archivePosts: () => fetch.mock.calls.filter(([, init]) => init?.method === 'POST'),
    gets: () => fetch.mock.calls.filter(([, init]) => init?.method === 'GET'),
    describe: () => confirmations.described.get(button)(),
    trySave: () => editForm.dispatch('submit'),
    // Project Detail's ?edit=1&returnTo= deep link renders this in the form.
    addReturnTo: (value) => editForm.appendChild(new FakeNode('input', {
      name: 'returnTo', 'data-dialog-return-location': '', value,
    })),
    dismiss: () => {
      if (!dialogState.beforeClose({})) return false;
      editForm.values = JSON.parse(JSON.stringify(dialogState.savedValues));
      dialog.open = false;
      dialog.dispatch('close');
      dialogs.followReturn(document, dialogState);
      return true;
    },
    reopen: () => {
      dialog.open = true;
      editController.current.onLoaded?.(projectId);
    },
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

describe('project Archive in place', () => {
  it('C1 / C5 / C6 — names the saved project and warns about each unsaved field, never saving them', () => {
    const t = setup();
    expect(t.describe()).toEqual({
      title: 'Archive project?',
      message: 'Archive “Moonlit Garden”? It keeps its data, assets and releases, but becomes archived and read-only. This cannot be undone.',
      confirmLabel: 'Archive project',
    });
    t.editForm.values.title = 'Draft title';
    t.editForm.values['tagIds[]'] = ['3', '4'];
    t.editForm.values.patreonUrl = 'https://example.test/p';
    const described = t.describe();
    expect(described.title).toBe('Archive project with unsaved changes?');
    // The saved title names the project; the draft does not.
    expect(described.message).toContain('Archive “Moonlit Garden”?');
    expect(described.message).toContain('(title, project link and tags) will not be saved: they are kept if you cancel or the project is not archived, and lost if it is archived.');
    expect(described.cancelLabel).toBe('Keep editing');
    expect(unsavedProjectEditLabels(t.editForm, t.dialogState.savedValues)).toEqual(['title', 'project link', 'tags']);
    // Tag order is not a change.
    t.editForm.values = { ...JSON.parse(JSON.stringify(SAVED)), 'tagIds[]': ['3'] };
    expect(unsavedProjectEditLabels(t.editForm, t.dialogState.savedValues)).toEqual([]);
  });

  it('C2 / C7 — a confirmation that is not confirmed sends nothing and changes nothing', () => {
    const t = setup();
    t.editForm.values.title = 'Draft title';
    // Opening the confirmation is only the click the shared control intercepts.
    t.describe();
    expect(t.fetch).not.toHaveBeenCalled();
    expect(t.editForm.values.title).toBe('Draft title');
    expect(projectArchiveState(t.document, '7')).toBeNull();
    expect(dialogs.freezes).toBe(0);
  });

  it('C4 / C19 — one confirmed Archive sends one POST; replays and repeats while pending are refused', async () => {
    const t = setup();
    const post = deferred();
    t.fetch.mockReturnValueOnce(post.promise);
    t.confirmAndSubmit();
    t.confirmAndSubmit();
    t.form.dispatch('submit');
    await flush();
    expect(t.archivePosts()).toHaveLength(1);
    const [url, init] = t.archivePosts()[0];
    expect(url).toBe('/projects/7/archive');
    expect(init.headers).toEqual({ Accept: 'application/json' });
    expect(String(init.body)).toBe('_csrf=token-1');
    expect(t.dialogState.submitting).toBe(true);
    expect(t.editForm.getAttribute('aria-busy')).toBe('true');
    expect(dialogs.frozen).toBe(1);
    expect(t.status.textContent).toContain('Archiving “Moonlit Garden”…');
    expect(t.status.textContent).toContain(M.pending);
    // Save cannot start, and the dialog cannot be dismissed, while it is pending.
    expect(t.dialogState.beforeClose({})).toBe(false);

    post.resolve(jsonResponse(200, {
      status: 'success', outcome: 'archived', message: 'Project “Moonlit Garden” archived.', projectId: 7,
      project: { id: 7, title: 'Moonlit Garden', archived: true, status: 'archived' },
    }));
    await flush();
    expect(t.archivePosts()).toHaveLength(1);
  });

  it('C11 / C18 — confirmed success closes the dialog, discards the warned drafts and asks the host to re-read', async () => {
    const t = setup();
    t.editForm.values.description = 'Unsaved description';
    t.fetch.mockResolvedValueOnce(jsonResponse(200, {
      status: 'success', outcome: 'archived', message: 'Project “Moonlit Garden” archived.', projectId: 7,
      project: { id: 7, title: 'Moonlit Garden', archived: true, status: 'archived' },
    }));
    t.confirmAndSubmit();
    await flush();
    expect(t.dialog.open).toBe(false);
    expect(dialogs.closes).toBe(1);
    expect(dialogs.frozen).toBe(0);
    expect(t.dialogState.submitting).toBe(false);
    expect(t.editForm.values.description).toBe('Saved description');
    expect(dialogs.feedback.at(-1)).toEqual({ message: 'Project “Moonlit Garden” archived.', error: false });
    expect(t.document.events).toHaveLength(1);
    expect(t.document.events[0].type).toBe('project-archived');
    expect(t.document.events[0].detail).toMatchObject({
      projectId: '7', outcome: 'archived', confirmed: true, message: 'Project “Moonlit Garden” archived.',
    });
    expect(projectArchiveState(t.document, '7')).toMatchObject({ phase: 'archived', drafts: null });
    // No Edit Save was sent by Archive.
    expect(t.fetch).toHaveBeenCalledTimes(1);
    // Archive cannot be sent again for this project from this page.
    t.dialog.open = true;
    t.confirmAndSubmit();
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(t.status.textContent).toContain(M.archived);
  });

  it('C5 — a mismatched form target never posts', () => {
    const t = setup();
    t.form.setAttribute('action', '/projects/8/archive');
    t.confirmAndSubmit();
    expect(t.fetch).not.toHaveBeenCalled();
    expect(t.status.textContent).toContain(M.wrongTarget);
  });

  it('C8 — an authoritative refusal thaws the dialog with every draft and offers Archive again', async () => {
    const t = setup();
    t.editForm.values.notes = 'Unsaved notes';
    t.fetch.mockResolvedValueOnce(jsonResponse(403, { status: 'error', message: 'Invalid or missing CSRF token.' }));
    t.confirmAndSubmit();
    await flush();
    expect(t.dialog.open).toBe(true);
    expect(dialogs.frozen).toBe(0);
    expect(t.dialogState.submitting).toBe(false);
    expect(t.editForm.values.notes).toBe('Unsaved notes');
    expect(t.status.textContent).toBe(`Invalid or missing CSRF token. ${M.nothingArchived} ${M.draftsKept}`);
    expect(t.document.events).toHaveLength(0);
    expect(projectArchiveState(t.document, '7')).toBeNull();
    expect(t.button.hasAttribute('aria-disabled')).toBe(false);

    // A proven failure also leaves Archive available; nothing is resent by itself.
    t.fetch.mockResolvedValueOnce(jsonResponse(500, {
      status: 'error', code: 'PROJECT_ARCHIVE_FAILED', outcome: 'failed',
      message: 'Project archive failed. Nothing was archived. Please try again.',
    }));
    t.confirmAndSubmit();
    await flush();
    expect(t.archivePosts()).toHaveLength(2);
    expect(t.status.textContent).toBe(`Project archive failed. Nothing was archived. Please try again. ${M.draftsKept}`);
    await flush();
    expect(t.archivePosts()).toHaveLength(2);
  });

  it('C8 — already archived elsewhere: nothing changed, drafts stay, Archive and Save are refused', async () => {
    const t = setup();
    t.editForm.values.title = 'Draft title';
    t.fetch.mockResolvedValueOnce(jsonResponse(409, {
      status: 'error', code: 'PROJECT_ALREADY_ARCHIVED', outcome: 'refused', projectId: 7,
      message: 'This project was already archived. Nothing was changed.',
      project: { id: 7, archived: true },
    }));
    t.confirmAndSubmit();
    await flush();
    expect(t.dialog.open).toBe(true);
    expect(t.editForm.values.title).toBe('Draft title');
    expect(t.status.textContent).toBe(`This project was already archived. Nothing was changed. ${M.draftsUnsaveable}`);
    expect(t.document.events[0].detail).toMatchObject({ outcome: 'already-archived', confirmed: false });
    const save = t.trySave();
    expect(save.defaultPrevented).toBe(true);
    expect(t.status.textContent).toContain(M.archived);
  });

  it('C9 / C10 / C17 — a lost answer holds Archive and Save, keeps the drafts, and Check again only reads', async () => {
    const t = setup();
    t.editForm.values.title = 'Draft title';
    t.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const firstCheck = deferred();
    t.fetch.mockReturnValueOnce(firstCheck.promise);
    t.confirmAndSubmit();
    await flush();
    expect(projectArchiveState(t.document, '7').phase).toBe('unresolved');
    expect(t.gets()).toHaveLength(1);
    expect(t.gets()[0][0]).toBe('/projects/7/edit');
    expect(t.status.textContent).toBe(`${M.unconfirmed} ${M.checking}`);
    expect(dialogs.frozen).toBe(0);

    // The project still reads as active: an observation, not proof. Still held.
    firstCheck.resolve(jsonResponse(200, { status: 'success', project: { id: 7 } }));
    await flush();
    expect(projectArchiveState(t.document, '7').phase).toBe('unresolved');
    expect(t.status.textContent).toContain(M.stillActive);
    const dialogCheck = t.status.querySelector('[data-project-archive-check]');
    const feedbackCheck = t.feedback.querySelector('[data-project-archive-feedback-check]');
    expect(dialogCheck?.textContent).toBe('Check again');
    expect(feedbackCheck?.textContent).toBe('Check again');
    expect(t.button.getAttribute('aria-disabled')).toBe('true');
    expect(t.editForm.values.title).toBe('Draft title');

    // No second Archive and no Save while unresolved.
    t.confirmAndSubmit();
    expect(t.archivePosts()).toHaveLength(1);
    expect(t.status.textContent).toContain(M.unresolved);
    expect(t.trySave().defaultPrevented).toBe(true);
    expect(t.status.textContent).toContain(M.saveHeld);

    // Check again is a GET; a read showing it archived settles the hold.
    t.fetch.mockResolvedValueOnce(jsonResponse(409, { status: 'error', code: 'PROJECT_ARCHIVED' }));
    dialogCheck.click();
    await flush();
    expect(t.archivePosts()).toHaveLength(1);
    expect(t.gets()).toHaveLength(2);
    expect(projectArchiveState(t.document, '7').phase).toBe('archived');
    expect(t.status.textContent).toBe(`${M.observedArchived} ${M.draftsUnsaveable}`);
    expect(t.document.events.at(-1).detail).toMatchObject({ outcome: 'observed-archived', confirmed: false });
  });

  it('C9 — an unknown 500 and an unreadable success are unresolved, never refused or archived', async () => {
    for (const response of [
      jsonResponse(500, { status: 'error', code: 'PROJECT_ARCHIVE_UNKNOWN', outcome: 'unknown', message: 'Could not confirm whether the project was archived.' }),
      { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } },
      jsonResponse(200, { status: 'success', outcome: 'archived', projectId: 8, project: { id: 8, archived: true } }),
    ]) {
      const t = setup();
      t.fetch.mockResolvedValueOnce(response);
      t.fetch.mockResolvedValueOnce(jsonResponse(503, { status: 'error' }));
      t.confirmAndSubmit();
      await flush();
      expect(projectArchiveState(t.document, '7').phase).toBe('unresolved');
      expect(t.status.textContent).toBe(`${M.unconfirmed} ${M.checkFailed}Check again`);
      expect(t.document.events).toHaveLength(0);
      expect(t.dialog.open).toBe(true);
    }
  });

  it('C9 — dismissal while unresolved keeps the drafts for the next open of that project', async () => {
    const t = setup();
    t.editForm.values.title = 'Draft title';
    t.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    t.fetch.mockResolvedValueOnce(jsonResponse(200, { status: 'success', project: { id: 7 } }));
    t.confirmAndSubmit();
    await flush();
    t.editForm.values.notes = 'Typed after the lost answer';
    // The binder resets the form to its baseline on close, as always.
    expect(t.dialogState.beforeClose({})).toBe(true);
    t.editForm.values = JSON.parse(JSON.stringify(SAVED));
    t.dialog.open = false;
    t.dialog.dispatch('close');
    // Reopened for the same project: the load hydrates, then the drafts return.
    t.dialog.open = true;
    editController.current.onLoaded('7');
    expect(t.editForm.values.title).toBe('Draft title');
    expect(t.editForm.values.notes).toBe('Typed after the lost answer');
    expect(t.status.textContent).toContain(M.stillActive);
    expect(t.status.querySelector('[data-project-archive-check]')).not.toBeNull();
    expect(t.button.getAttribute('aria-disabled')).toBe('true');
    // Another project starts with Archive available and its own values.
    t.form.setAttribute('action', '/projects/9/archive');
    editController.current.projectId = '9';
    editController.current.onLoaded('9');
    expect(t.button.hasAttribute('aria-disabled')).toBe(false);
    expect(t.status.querySelector('[data-project-archive-check]')).toBeNull();
  });

  it('C14 — a Check again answer that arrives after a newer Check is ignored', async () => {
    const t = setup();
    t.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const stale = deferred();
    t.fetch.mockReturnValueOnce(stale.promise);
    t.confirmAndSubmit();
    await flush();
    // A newer record for the project (a later page state) supersedes the read.
    const record = projectArchiveState(t.document, '7');
    record.attempt += 1;
    stale.resolve(jsonResponse(409, { status: 'error', code: 'PROJECT_ARCHIVED' }));
    await flush();
    expect(record.phase).toBe('unresolved');
    expect(t.document.events).toHaveLength(0);
  });

  it('C17 — an Archive click while the Edit form is busy never opens the confirmation path here', () => {
    const t = setup();
    // The shared secondary-action guard refuses busy forms first; this module
    // also refuses while its own Archive is pending.
    projectArchiveState(t.document, '7');
    t.dialogState.submitting = false;
    const record = { phase: 'pending', attempt: 1, drafts: null, message: '' };
    t.document.__creatorCrateProjectArchive.records.set('7', record);
    const click = t.button.click();
    expect(click.defaultPrevented).toBe(true);
    expect(t.fetch).not.toHaveBeenCalled();
    expect(t.status.textContent).toContain(M.pending);
  });

  it('C20 — without fetch the form stays native: nothing is intercepted', () => {
    const t = setup({ withFetch: false });
    const click = t.button.click();
    expect(click.defaultPrevented).toBe(false);
    const submit = t.form.dispatch('submit');
    expect(submit.defaultPrevented).toBe(false);
    expect(dialogs.freezes).toBe(0);
  });

  it('C19 — enhancing twice binds once', async () => {
    const t = setup();
    expect(enhanceProjectArchive(t.document)).toBe(t.handle);
    t.fetch.mockResolvedValueOnce(jsonResponse(403, { status: 'error', message: 'Refused.' }));
    t.confirmAndSubmit();
    await flush();
    expect(t.archivePosts()).toHaveLength(1);
  });
});

// WP11A-F1: a deep-linked Edit Project (?edit=1&returnTo=) follows returnTo
// when dismissed. While this page holds an Archive, that would replace the
// document and take the hold, the drafts and Check again with it.
describe('project Archive in place — WP11A-F1 deep-link dismissal', () => {
  const RETURN_TO = '/projects/7/assets?view=list';
  const ACTIVE = () => jsonResponse(200, { status: 'success', project: { id: 7 } });

  async function unresolvedDeepLink({ check = ACTIVE() } = {}) {
    const t = setup();
    t.addReturnTo(RETURN_TO);
    t.editForm.values.title = 'Draft title';
    t.editForm.values.patreonUrl = 'https://example.test/draft';
    t.editForm.values.status = 'complete';
    t.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    if (check instanceof Error) t.fetch.mockRejectedValueOnce(check);
    else t.fetch.mockResolvedValueOnce(check);
    t.confirmAndSubmit();
    await flush();
    return t;
  }

  it('C2 / C6 — an unresolved Archive, read as active, is dismissed without following returnTo', async () => {
    const t = await unresolvedDeepLink();
    expect(t.status.textContent).toContain(M.stillActive);
    expect(t.dismiss()).toBe(true);
    expect(t.dialog.open).toBe(false);
    expect(t.location.assign).not.toHaveBeenCalled();
    expect(projectArchiveState(t.document, '7')).toMatchObject({
      phase: 'unresolved',
      drafts: { title: 'Draft title', patreonUrl: 'https://example.test/draft', status: 'complete' },
    });
    expect(t.dialogState.savedValues.title).toBe('Moonlit Garden');
    expect(t.feedback.querySelector('[data-project-archive-feedback-check]')).not.toBeNull();

    t.reopen();
    expect(t.editForm.values).toMatchObject({ title: 'Draft title', status: 'complete' });
    expect(t.trySave().defaultPrevented).toBe(true);
    t.confirmAndSubmit();
    expect(t.archivePosts()).toHaveLength(1);
  });

  it('C3 / C5 — a failed read, repeated dismissal and reopening keep the hold, the drafts and one veto', async () => {
    const t = await unresolvedDeepLink({ check: new TypeError('offline') });
    expect(t.status.textContent).toContain(M.checkFailed);
    expect(enhanceProjectArchive(t.document)).toBe(t.handle);
    for (let round = 0; round < 3; round += 1) {
      t.dismiss();
      t.reopen();
      expect(t.editForm.values.title).toBe('Draft title');
      t.fetch.mockResolvedValueOnce(ACTIVE());
      t.status.querySelector('[data-project-archive-check]').click();
      await flush();
      expect(projectArchiveState(t.document, '7').phase).toBe('unresolved');
    }
    t.dismiss();
    expect(t.location.assign).not.toHaveBeenCalled();
    expect(t.gets()).toHaveLength(4);
    expect(t.archivePosts()).toHaveLength(1);
    expect(t.dialogState.returnVetoes.size).toBe(1);
  });

  it('C7 — with nothing held, a deep-linked dismissal returns as it always has', () => {
    const t = setup();
    t.addReturnTo(RETURN_TO);
    t.dismiss();
    expect(t.location.assign.mock.calls).toEqual([[RETURN_TO]]);
  });

  it('C8 — after a proven refusal the drafts stay, and dismissal returns as before', async () => {
    const t = setup();
    t.addReturnTo(RETURN_TO);
    t.editForm.values.notes = 'Unsaved notes';
    t.fetch.mockResolvedValueOnce(jsonResponse(403, { status: 'error', message: 'Invalid or missing CSRF token.' }));
    t.confirmAndSubmit();
    await flush();
    expect(t.editForm.values.notes).toBe('Unsaved notes');
    t.dismiss();
    expect(t.location.assign.mock.calls).toEqual([[RETURN_TO]]);
  });

  it('C9 — a confirmed Archive closes as before: one return, no hold left behind', async () => {
    const t = setup();
    t.addReturnTo(RETURN_TO);
    t.fetch.mockResolvedValueOnce(jsonResponse(200, {
      status: 'success', outcome: 'archived', message: 'Project “Moonlit Garden” archived.', projectId: 7,
      project: { id: 7, title: 'Moonlit Garden', archived: true, status: 'archived' },
    }));
    t.confirmAndSubmit();
    await flush();
    expect(t.dialog.open).toBe(false);
    expect(t.location.assign.mock.calls).toEqual([[RETURN_TO]]);
    expect(t.document.events.filter((event) => event.type === 'project-archived')).toHaveLength(1);
    expect(t.archivePosts()).toHaveLength(1);
  });

  it('C9 — a read finding it archived settles the hold; dismissal then returns as before', async () => {
    const t = await unresolvedDeepLink({ check: jsonResponse(409, { status: 'error', code: 'PROJECT_ARCHIVED' }) });
    expect(projectArchiveState(t.document, '7').phase).toBe('archived');
    t.dismiss();
    expect(t.location.assign.mock.calls).toEqual([[RETURN_TO]]);
    expect(t.archivePosts()).toHaveLength(1);
  });
});
