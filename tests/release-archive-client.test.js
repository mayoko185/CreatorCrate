import { describe, it, expect, vi, beforeEach } from 'vitest';

// WP11B-1: Archive release from the Edit Release dialog, in place
// (release-archive.js). The dialog binder, the Edit Release controller and
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
    // The binder's reset-on-close: the form shows the saved baseline again.
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

const editController = vi.hoisted(() => ({ current: null, enhanced: 0 }));
vi.mock('../src/static/client/release-edit-dialog.js', () => ({
  RELEASE_EDIT_DIALOG_ID: 'release-edit-dialog',
  RELEASE_ARCHIVED_EVENT: 'release-archived',
  enhanceReleaseEditDialog: () => {
    editController.enhanced += 1;
    return editController.current;
  },
}));

const {
  enhanceReleaseArchive,
  releaseArchiveState,
  releaseArchiveHoldsPage,
  releaseArchiveHoldsRelease,
  unsavedReleaseEditLabels,
  RELEASE_ARCHIVE_MESSAGES: M,
} = await import('../src/static/client/release-archive.js');

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
  // A control's form: its form= owner, else its ancestor form.
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
  title: 'Spring Batch',
  description: 'Saved description',
  notes: '',
  plannedDate: '2026-12-01',
  plannedTime: '',
  publishedDate: '',
  patreonUrl: '',
  selectedPlatforms: ['patreon'],
});

const ARCHIVED_BODY = Object.freeze({
  status: 'success',
  outcome: 'archived',
  message: 'Release “Spring Batch” archived.',
  releaseId: 12,
  projectId: 4,
  release: { id: 12, projectId: 4, title: 'Spring Batch', archived: true, archivedAt: '2026-11-04 10:00:00' },
  refreshRequired: true,
});

function setup({ releaseId = '12', withFetch = true } = {}) {
  const root = new FakeNode('html');
  const document = {
    nodeType: 9,
    documentElement: root,
    activeElement: null,
    events: [],
    createElement: (tag) => new FakeNode(tag),
    querySelector: (selector) => root.querySelector(selector),
    getElementById: (id) => root.descendants().find((node) => node.id === id) || null,
    // Document listeners sit on the root, which every event path reaches.
    addEventListener: (...args) => root.addEventListener(...args),
    dispatchEvent(event) { this.events.push(event); },
  };
  root.document = document;
  document.body = root.appendChild(new FakeNode('body'));
  const main = document.body.appendChild(new FakeNode('main', { id: 'main-content' }));
  const feedback = main.appendChild(new FakeNode('div', { 'data-dialog-feedback': '' }));
  feedback.appendChild(new FakeNode('p', { 'data-dialog-feedback-text': '' }));
  const dialog = document.body.appendChild(new FakeNode('dialog', { id: 'release-edit-dialog' }));
  dialog.open = true;
  const editForm = dialog.appendChild(new FakeNode('form', {
    id: 'release-edit-form', 'data-dialog-form': '', action: `/releases/${releaseId}`,
  }));
  editForm.values = JSON.parse(JSON.stringify(SAVED));
  const archiveDisclosure = dialog.appendChild(new FakeNode('details', { 'data-release-edit-action': 'archive' }));
  const form = archiveDisclosure.appendChild(new FakeNode('form', {
    'data-release-archive-form': '', 'data-dialog-secondary-action': '', 'data-confirm-submit-required': '',
    action: `/releases/${releaseId}/archive`,
  }));
  form.csrf = 'token-1';
  const button = form.appendChild(new FakeNode('button', {
    type: 'submit', 'data-confirm': 'Archive this release? This cannot be undone.',
  }));
  const deleteDisclosure = dialog.appendChild(new FakeNode('details', { 'data-release-edit-action': 'delete' }));
  const deleteForm = deleteDisclosure.appendChild(new FakeNode('form', { action: `/releases/${releaseId}/delete` }));
  const deleteButton = deleteForm.appendChild(new FakeNode('button', { type: 'submit', 'data-confirm': 'Delete?' }));
  const status = dialog.appendChild(new FakeNode('div', { 'data-dialog-status': '' }));
  const saveButton = dialog.appendChild(new FakeNode('button', {
    type: 'submit', form: 'release-edit-form', 'data-dialog-submit': '',
  }));

  // Release Detail's Review & Publish, and a Dashboard Needs-a-date item.
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
  const location = { pathname: `/releases/${releaseId}`, assign: vi.fn() };
  const windowObject = {
    fetch: withFetch ? fetch : undefined,
    location,
    FormData: class { constructor(target) { this.entries = [['_csrf', target.csrf]]; } },
    URLSearchParams: class { constructor(data) { this.value = new URLSearchParams(data.entries).toString(); } toString() { return this.value; } },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
  };
  document.defaultView = windowObject;
  const handle = enhanceReleaseArchive(document);

  // The confirmation's Archive: its replay clicks the control and submits.
  const confirmAndSubmit = () => {
    const click = button.click();
    if (click.defaultPrevented) return click;
    return form.dispatch('submit');
  };
  return {
    document, dialog, dialogState, editForm, form, button, status, feedback, fetch, location, handle, confirmAndSubmit,
    deleteButton, deleteForm, saveButton, publishForm, publishStatus, publishSubmit, quickForm, quickPick, undo, otherQuickForm,
    archivePosts: () => fetch.mock.calls.filter(([, init]) => init?.method === 'POST'),
    gets: () => fetch.mock.calls.filter(([, init]) => init?.method === 'GET'),
    describe: () => confirmations.described.get(button)(),
    trySave: () => editForm.dispatch('submit'),
    dismiss: () => {
      if (dialogState.beforeClose && dialogState.beforeClose({}) !== true) return false;
      editForm.values = JSON.parse(JSON.stringify(dialogState.savedValues));
      dialog.open = false;
      dialog.dispatch('close');
      return true;
    },
    // The Edit Release controller's open: a fresh load sets the baseline,
    // then reports the loaded release (or the refusal of its load).
    reopen: ({ refused = null } = {}) => {
      dialog.open = true;
      editForm.values = JSON.parse(JSON.stringify(dialogState.savedValues));
      if (refused) editController.current.onLoadRefused?.(releaseId, refused.status, refused.body);
      else editController.current.onLoaded?.(releaseId);
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
  editController.enhanced = 0;
});

describe('Release Archive in place', () => {
  it('C1 / C5 / C6 — names the saved release and warns about each unsaved field, never saving them', () => {
    const t = setup();
    const plain = t.describe();
    expect(plain.title).toBe('Archive release?');
    expect(plain.message).toBe('Archive “Spring Batch”? It keeps its details, selected assets and any publication record, but becomes archived and read-only: it can no longer be edited, published or deleted, and it leaves the Dashboard and Calendar. This cannot be undone.');
    expect(plain.confirmLabel).toBe('Archive release');
    t.editForm.values.title = 'Draft title';
    t.editForm.values.plannedDate = '';
    t.editForm.values.selectedPlatforms = ['patreon', 'bluesky'];
    const described = t.describe();
    expect(described.title).toBe('Archive release with unsaved changes?');
    // The saved title names the release; the draft does not.
    expect(described.message).toContain('Archive “Spring Batch”?');
    expect(described.message).toContain('(title, scheduled date and platforms) will not be saved: they are kept if you cancel or the release is not archived, and lost if it is archived.');
    expect(described.cancelLabel).toBe('Keep editing');
    // Platform order is not a change; clearing every platform is.
    t.editForm.values = { ...JSON.parse(JSON.stringify(SAVED)), selectedPlatforms: ['patreon'] };
    expect(unsavedReleaseEditLabels(t.editForm, t.dialogState.savedValues)).toEqual([]);
    delete t.editForm.values.selectedPlatforms;
    expect(unsavedReleaseEditLabels(t.editForm, t.dialogState.savedValues)).toEqual(['platforms']);
  });

  it('C2 / C7 — a confirmation that is not confirmed sends nothing and changes nothing', () => {
    const t = setup();
    t.editForm.values.title = 'Draft title';
    t.describe();
    expect(t.fetch).not.toHaveBeenCalled();
    expect(t.editForm.values.title).toBe('Draft title');
    expect(releaseArchiveState(t.document, '12')).toBeNull();
    expect(dialogs.freezes).toBe(0);
    // Escape and the backdrop dismiss as usual while nothing is pending.
    expect(t.dismiss()).toBe(true);
  });

  it('C3 / C4 / C21 — one confirmed Archive sends one POST; replays, Enter repeats and dismissal while pending are refused', async () => {
    const t = setup();
    const post = deferred();
    t.fetch.mockReturnValueOnce(post.promise);
    t.confirmAndSubmit();
    t.confirmAndSubmit();
    t.form.dispatch('submit');
    t.form.dispatch('submit');
    await flush();
    expect(t.archivePosts()).toHaveLength(1);
    const [url, init] = t.archivePosts()[0];
    expect(url).toBe('/releases/12/archive');
    expect(init.headers).toEqual({ Accept: 'application/json' });
    expect(String(init.body)).toBe('_csrf=token-1');
    expect(t.dialogState.submitting).toBe(true);
    expect(t.editForm.getAttribute('aria-busy')).toBe('true');
    expect(dialogs.frozen).toBe(1);
    expect(t.status.textContent).toContain('Archiving “Spring Batch”…');
    expect(t.status.textContent).toContain(M.pending);
    // Escape, the backdrop and Close are refused while it is pending.
    expect(t.dialogState.beforeClose({})).toBe(false);
    expect(t.dismiss()).toBe(false);
    expect(t.dialog.open).toBe(true);
    expect(releaseArchiveHoldsPage(t.document)).toBe(true);

    post.resolve(jsonResponse(200, ARCHIVED_BODY));
    await flush();
    expect(t.archivePosts()).toHaveLength(1);
    expect(releaseArchiveHoldsPage(t.document)).toBe(false);
  });

  it('C11 / C18 — confirmed success closes the dialog, discards the warned drafts and asks the host to re-read', async () => {
    const t = setup();
    t.editForm.values.description = 'Unsaved description';
    t.fetch.mockResolvedValueOnce(jsonResponse(200, ARCHIVED_BODY));
    t.confirmAndSubmit();
    await flush();
    expect(t.dialog.open).toBe(false);
    expect(dialogs.closes).toBe(1);
    expect(dialogs.frozen).toBe(0);
    expect(t.dialogState.submitting).toBe(false);
    expect(t.editForm.values.description).toBe('Saved description');
    expect(dialogs.feedback.at(-1)).toEqual({ message: 'Release “Spring Batch” archived.', error: false });
    expect(t.document.events).toHaveLength(1);
    expect(t.document.events[0].type).toBe('release-archived');
    expect(t.document.events[0].detail).toMatchObject({
      releaseId: '12', projectId: 4, outcome: 'archived', confirmed: true, message: 'Release “Spring Batch” archived.',
    });
    expect(releaseArchiveState(t.document, '12')).toMatchObject({ phase: 'archived', drafts: null });
    // No Edit Save was sent by Archive.
    expect(t.fetch).toHaveBeenCalledTimes(1);
    // Archive and Save cannot be sent again for this release from this page.
    t.dialog.open = true;
    t.confirmAndSubmit();
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(t.status.textContent).toContain(M.archived);
    expect(t.trySave().defaultPrevented).toBe(true);
    expect(t.button.getAttribute('aria-disabled')).toBe('true');
  });

  it('C5 — a mismatched form target or an unloaded form never posts', () => {
    const t = setup();
    t.form.setAttribute('action', '/releases/13/archive');
    t.confirmAndSubmit();
    expect(t.fetch).not.toHaveBeenCalled();
    expect(t.status.textContent).toContain(M.wrongTarget);
    t.form.setAttribute('action', '/releases/12/archive');
    editController.current.releaseId = null;
    t.confirmAndSubmit();
    expect(t.fetch).not.toHaveBeenCalled();
    expect(t.status.textContent).toContain(M.notLoaded);
  });

  it('C8 — an authoritative refusal or a proven failure thaws the dialog with every draft and offers Archive again', async () => {
    for (const [status, body] of [
      [403, { status: 'error', message: 'Invalid or missing CSRF token.' }],
      [503, { status: 'error', code: 'MAINTENANCE', message: 'Maintenance is running.' }],
      [500, { status: 'error', code: 'RELEASE_ARCHIVE_FAILED', outcome: 'failed', message: 'Release archive failed. Nothing was archived. Please try again.' }],
    ]) {
      const t = setup();
      t.editForm.values.title = 'Draft title';
      t.fetch.mockResolvedValueOnce(jsonResponse(status, body));
      t.confirmAndSubmit();
      await flush();
      expect(releaseArchiveState(t.document, '12')).toBeNull();
      expect(t.dialog.open).toBe(true);
      expect(dialogs.frozen).toBe(0);
      expect(t.editForm.values.title).toBe('Draft title');
      expect(t.status.textContent).toContain(body.message);
      expect(t.status.textContent).toContain(M.draftsKept);
      expect(t.status.textContent.match(/Nothing was archived/g)).toHaveLength(1);
      expect(t.button.getAttribute('aria-disabled')).toBeNull();
      expect(t.document.events).toHaveLength(0);
      t.fetch.mockResolvedValueOnce(jsonResponse(200, ARCHIVED_BODY));
      t.confirmAndSubmit();
      await flush();
      expect(t.archivePosts()).toHaveLength(2);
      dialogs.feedback = [];
    }
  });

  it('C8 — already archived, project archived or missing: nothing changed, drafts stay, everything for it is refused', async () => {
    for (const [status, body, phase, outcome] of [
      [409, { status: 'error', code: 'RELEASE_ALREADY_ARCHIVED', outcome: 'refused', message: 'This release was already archived. Nothing was changed.', releaseId: 12, release: { id: 12, archived: true } }, 'archived', 'already-archived'],
      [409, { status: 'error', code: 'PROJECT_ARCHIVED', outcome: 'refused', message: 'The parent project is archived, so this release is read-only. Nothing was archived.', releaseId: 12 }, 'project-archived', 'project-archived'],
      [404, { status: 'error', code: 'RELEASE_NOT_FOUND', outcome: 'refused', message: 'Release not found.' }, 'missing', 'missing'],
    ]) {
      const t = setup();
      t.editForm.values.title = 'Draft title';
      t.fetch.mockResolvedValueOnce(jsonResponse(status, body));
      t.confirmAndSubmit();
      await flush();
      expect(releaseArchiveState(t.document, '12').phase).toBe(phase);
      expect(t.editForm.values.title).toBe('Draft title');
      expect(t.status.textContent).toBe(`${body.message} ${M.draftsUnsaveable}`);
      expect(t.document.events.at(-1).detail).toMatchObject({ outcome, confirmed: false });
      t.confirmAndSubmit();
      expect(t.trySave().defaultPrevented).toBe(true);
      expect(t.archivePosts()).toHaveLength(1);
    }
  });

  it('C9 / C10 — a lost answer holds Archive and Save, keeps the drafts, and Check again only reads', async () => {
    const t = setup();
    t.editForm.values.title = 'Draft title';
    t.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const firstCheck = deferred();
    t.fetch.mockReturnValueOnce(firstCheck.promise);
    t.confirmAndSubmit();
    await flush();
    expect(releaseArchiveState(t.document, '12').phase).toBe('unresolved');
    expect(t.gets()).toHaveLength(1);
    expect(t.gets()[0][0]).toBe('/releases/12/edit');
    expect(t.gets()[0][1].headers).toEqual({ Accept: 'application/json' });
    expect(t.status.textContent).toBe(`${M.unconfirmed} ${M.checking}`);
    expect(dialogs.frozen).toBe(0);

    // The release still reads as active: an observation, not proof. Still held.
    firstCheck.resolve(jsonResponse(200, { status: 'success', release: { id: 12 } }));
    await flush();
    expect(releaseArchiveState(t.document, '12').phase).toBe('unresolved');
    expect(t.status.textContent).toContain(M.stillActive);
    const dialogCheck = t.status.querySelector('[data-release-archive-check]');
    const feedbackCheck = t.feedback.querySelector('[data-release-archive-feedback-check]');
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

    // A failed check stays unresolved and offers Check again.
    t.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    feedbackCheck.click();
    await flush();
    expect(t.status.textContent).toContain(M.checkFailed);
    expect(releaseArchiveState(t.document, '12').phase).toBe('unresolved');

    // Check again is a GET; a read showing it archived settles the hold.
    t.fetch.mockResolvedValueOnce(jsonResponse(409, { status: 'error', code: 'RELEASE_ARCHIVED' }));
    t.status.querySelector('[data-release-archive-check]').click();
    await flush();
    expect(t.archivePosts()).toHaveLength(1);
    expect(t.gets()).toHaveLength(3);
    expect(releaseArchiveState(t.document, '12').phase).toBe('archived');
    expect(t.status.textContent).toBe(`${M.observedArchived} ${M.draftsUnsaveable}`);
    expect(t.document.events.at(-1).detail).toMatchObject({ outcome: 'observed-archived', confirmed: false });
    expect(releaseArchiveHoldsPage(t.document)).toBe(false);
    expect(releaseArchiveHoldsRelease(t.document, '12')).toBe(true);
  });

  it('C9 — an unknown 500, an unreadable success and a mismatched success are unresolved, never refused or archived', async () => {
    for (const response of [
      jsonResponse(500, { status: 'error', code: 'RELEASE_ARCHIVE_UNKNOWN', outcome: 'unknown' }),
      { ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } },
      jsonResponse(200, { ...ARCHIVED_BODY, releaseId: 13, release: { ...ARCHIVED_BODY.release, id: 13 } }),
      jsonResponse(500, { status: 'error', message: 'Internal Server Error' }),
    ]) {
      const t = setup();
      t.fetch.mockResolvedValueOnce(response);
      t.fetch.mockResolvedValueOnce(jsonResponse(200, { status: 'success', release: { id: 12 } }));
      t.confirmAndSubmit();
      await flush();
      expect(releaseArchiveState(t.document, '12').phase).toBe('unresolved');
      expect(t.dialog.open).toBe(true);
      expect(t.document.events).toHaveLength(0);
      expect(t.archivePosts()).toHaveLength(1);
    }
  });

  it('C7 / C9 — dismissal while unresolved keeps the drafts for the next open of that release, with Check again', async () => {
    const t = setup();
    t.editForm.values.notes = 'Unsaved notes';
    t.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    t.fetch.mockResolvedValueOnce(jsonResponse(200, { status: 'success', release: { id: 12 } }));
    t.confirmAndSubmit();
    await flush();
    // Dismissal is allowed again and never navigates (no return location).
    expect(t.dismiss()).toBe(true);
    expect(t.location.assign).not.toHaveBeenCalled();
    expect(t.editForm.values.notes).toBe('');
    // The page feedback keeps the warning and its Check again.
    expect(t.feedback.querySelector('[data-release-archive-feedback-check]')).not.toBeNull();
    t.reopen();
    expect(t.editForm.values.notes).toBe('Unsaved notes');
    expect(dialogs.drafts.at(-1).notes).toBe('Unsaved notes');
    expect(t.status.textContent).toContain(M.stillActive);
    expect(t.status.querySelector('[data-release-archive-check]')).not.toBeNull();
    expect(t.button.getAttribute('aria-disabled')).toBe('true');
    // Dismissing and reopening again keeps the latest drafts.
    t.editForm.values.notes = 'Newer notes';
    t.dismiss();
    t.reopen();
    expect(t.editForm.values.notes).toBe('Newer notes');
    expect(t.archivePosts()).toHaveLength(1);
  });

  it('C9 — a reopened dialog whose load is refused because the release was archived settles the hold truthfully', async () => {
    const t = setup();
    t.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    t.fetch.mockResolvedValueOnce(jsonResponse(200, { status: 'success', release: { id: 12 } }));
    t.confirmAndSubmit();
    await flush();
    t.dismiss();
    t.reopen({ refused: { status: 409, body: { status: 'error', code: 'RELEASE_ARCHIVED' } } });
    expect(releaseArchiveState(t.document, '12').phase).toBe('archived');
    await flush();
    expect(t.document.events.at(-1).detail).toMatchObject({ outcome: 'observed-archived', confirmed: false });
    // A refused load for a release with no record changes nothing.
    const other = setup({ releaseId: '30' });
    other.reopen({ refused: { status: 409, body: { status: 'error', code: 'RELEASE_ARCHIVED' } } });
    expect(releaseArchiveState(other.document, '30')).toBeNull();
    expect(other.document.events).toHaveLength(0);
  });

  it('C14 — a Check again answer that arrives after a newer Check is ignored', async () => {
    const t = setup();
    t.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const olderCheck = deferred();
    t.fetch.mockReturnValueOnce(olderCheck.promise);
    t.confirmAndSubmit();
    await flush();
    t.fetch.mockResolvedValueOnce(jsonResponse(409, { status: 'error', code: 'RELEASE_ARCHIVED' }));
    await t.handle.check('12');
    expect(releaseArchiveState(t.document, '12').phase).toBe('archived');
    olderCheck.resolve(jsonResponse(200, { status: 'success', release: { id: 12 } }));
    await flush();
    expect(releaseArchiveState(t.document, '12').phase).toBe('archived');
    expect(t.status.textContent).toBe(`${M.observedArchived} ${M.draftsUnsaveable}`);
  });

  it('C9 — a read showing the project archived or the release gone settles the hold without claiming the Archive', async () => {
    for (const [status, body, phase, outcome, message] of [
      [409, { status: 'error', code: 'PROJECT_ARCHIVED' }, 'project-archived', 'observed-project-archived', `${M.observedProjectArchived} ${M.draftsUnsaveable}`],
      [404, { status: 'error', code: 'RELEASE_NOT_FOUND' }, 'missing', 'missing', M.goneUnconfirmed],
    ]) {
      const t = setup();
      t.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      t.fetch.mockResolvedValueOnce(jsonResponse(status, body));
      t.confirmAndSubmit();
      await flush();
      expect(releaseArchiveState(t.document, '12').phase).toBe(phase);
      expect(t.status.textContent).toBe(message);
      expect(t.document.events.at(-1).detail).toMatchObject({ outcome, confirmed: false });
    }
  });
});

describe('Release Archive — other release mutations while held (C15 / C16)', () => {
  async function unresolved() {
    const t = setup();
    t.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    t.fetch.mockResolvedValueOnce(jsonResponse(200, { status: 'success', release: { id: 12 } }));
    t.confirmAndSubmit();
    await flush();
    return t;
  }

  it('nothing is refused for a release this page holds nothing for', () => {
    const t = setup();
    expect(t.publishForm.dispatch('submit').defaultPrevented).toBe(false);
    expect(t.publishSubmit.click().defaultPrevented).toBe(false);
    expect(t.quickForm.dispatch('submit').defaultPrevented).toBe(false);
    expect(t.undo.click().defaultPrevented).toBe(false);
    expect(t.deleteButton.click().defaultPrevented).toBe(false);
    expect(t.saveButton.click().defaultPrevented).toBe(false);
  });

  it('Review & Publish, scheduling, Undo and Delete are refused while Archive is unresolved, with nothing sent', async () => {
    const t = await unresolved();
    const before = t.fetch.mock.calls.length;
    expect(t.publishSubmit.click().defaultPrevented).toBe(true);
    expect(t.publishForm.dispatch('submit').defaultPrevented).toBe(true);
    expect(t.publishStatus.textContent).toBe(M.mutationHeld);
    expect(t.quickPick.click().defaultPrevented).toBe(true);
    expect(t.quickForm.dispatch('submit').defaultPrevented).toBe(true);
    expect(t.undo.click().defaultPrevented).toBe(true);
    expect(t.deleteButton.click().defaultPrevented).toBe(true);
    expect(t.status.textContent).toContain(M.mutationHeld);
    expect(dialogs.feedback.at(-1)).toEqual({ message: M.mutationHeld, error: true });
    // Another release is not held.
    expect(t.otherQuickForm.dispatch('submit').defaultPrevented).toBe(false);
    expect(t.fetch.mock.calls.length).toBe(before);
  });

  it('while Archive is pending the dialog is frozen and the page refuses Publish for the release too', async () => {
    const t = setup();
    t.fetch.mockReturnValueOnce(deferred().promise);
    t.confirmAndSubmit();
    await flush();
    expect(t.publishForm.dispatch('submit').defaultPrevented).toBe(true);
    expect(t.publishStatus.textContent).toBe(M.pending);
    expect(t.archivePosts()).toHaveLength(1);
  });

  it('a confirmed archived release refuses them as read-only', async () => {
    const t = setup();
    t.fetch.mockResolvedValueOnce(jsonResponse(200, ARCHIVED_BODY));
    t.confirmAndSubmit();
    await flush();
    expect(t.publishForm.dispatch('submit').defaultPrevented).toBe(true);
    expect(t.publishStatus.textContent).toBe(M.archived);
  });
});

describe('Release Archive — native and binding (C21 / C22 / C23)', () => {
  it('C23 — without fetch the form stays native: nothing is intercepted', () => {
    const t = setup({ withFetch: false });
    const click = t.button.click();
    expect(click.defaultPrevented).toBe(false);
    const submit = t.form.dispatch('submit');
    expect(submit.defaultPrevented).toBe(false);
    expect(releaseArchiveState(t.document, '12')).toBeNull();
  });

  it('C21 — enhancing twice binds once', async () => {
    const t = setup();
    expect(enhanceReleaseArchive(t.document)).toBe(t.handle);
    t.fetch.mockResolvedValueOnce(jsonResponse(200, ARCHIVED_BODY));
    t.confirmAndSubmit();
    await flush();
    expect(t.archivePosts()).toHaveLength(1);
    expect(t.document.events).toHaveLength(1);
  });

  it('C22 — the Edit Release dialog has no return location: dismissal after an unresolved Archive stays on the page', async () => {
    const t = setup();
    t.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    t.fetch.mockResolvedValueOnce(jsonResponse(200, { status: 'success', release: { id: 12 } }));
    t.confirmAndSubmit();
    await flush();
    expect(t.dialogState.returnVetoes).toBeUndefined();
    t.dismiss();
    expect(t.location.assign).not.toHaveBeenCalled();
    expect(releaseArchiveHoldsPage(t.document)).toBe(true);
  });

  it('returns null without an async Edit Release dialog', () => {
    editController.current = null;
    const document = { nodeType: 9, getElementById: () => null };
    expect(enhanceReleaseArchive(document)).toBeNull();
  });
});
