import { describe, expect, it, vi } from 'vitest';
import { enhanceBookCoverUploads } from '../src/static/client/book-cover-upload.js';
import {
  enhanceAppConfirmationControls,
  enhanceAppDialogs,
  enhanceConfirmations,
  openAppDialogById,
  requestAppConfirmation,
} from '../src/static/creatorcrate.js';

function element(tagName = 'div', attributes = {}) {
  const attrs = new Map();
  const listeners = [];
  const node = {
    tagName: tagName.toUpperCase(),
    nodeType: 1,
    children: [],
    parentNode: null,
    parentElement: null,
    ownerDocument: null,
    dataset: {},
    open: false,
    disabled: false,
    textContent: '',
    classList: {
      values: new Set(),
      add(...names) { names.forEach((name) => this.values.add(name)); },
      remove(...names) { names.forEach((name) => this.values.delete(name)); },
      contains(name) { return this.values.has(name); },
    },
    setAttribute(name, value = '') {
      attrs.set(name, String(value));
      if (name === 'id') this.id = String(value);
      if (name === 'open') this.open = true;
      if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value);
    },
    getAttribute(name) { return attrs.get(name) ?? null; },
    hasAttribute(name) { return attrs.has(name); },
    removeAttribute(name) {
      attrs.delete(name);
      if (name === 'open') this.open = false;
      if (name.startsWith('data-')) delete this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())];
    },
    matches(selector) {
      return selector.split(',').some((part) => {
        const candidate = part.trim();
        const tag = candidate.match(/^[a-z][\w-]*/i)?.[0];
        if (tag && this.tagName !== tag.toUpperCase()) return false;
        if (candidate.startsWith('#') && this.id !== candidate.slice(1)) return false;
        return [...candidate.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)]
          .every(([, name, expected]) => this.hasAttribute(name)
            && (expected === undefined || this.getAttribute(name) === expected));
      });
    },
    closest(selector) {
      let current = this;
      while (current) {
        if (current.matches?.(selector)) return current;
        current = current.parentNode;
      }
      return null;
    },
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      child.parentElement = this;
      const document = this.nodeType === 9 ? this : this.ownerDocument;
      const adopt = (current) => {
        current.ownerDocument = document;
        current.children.forEach(adopt);
      };
      adopt(child);
      return child;
    },
    contains(candidate) {
      if (candidate === this) return true;
      return this.children.some((child) => child.contains(candidate));
    },
    querySelectorAll(selector) {
      const matches = [];
      const visit = (parent) => parent.children.forEach((child) => {
        if (child.matches(selector)) matches.push(child);
        visit(child);
      });
      visit(this);
      return matches;
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    addEventListener(type, handler) { listeners.push({ type, handler }); },
    removeEventListener(type, handler) {
      const index = listeners.findIndex((listener) => listener.type === type && listener.handler === handler);
      if (index >= 0) listeners.splice(index, 1);
    },
    dispatch(type, properties = {}) {
      const event = {
        type,
        target: properties.target || this,
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
        ...properties,
      };
      listeners.filter((listener) => listener.type === type).forEach((listener) => listener.handler(event));
      return event;
    },
    click() { return this.dispatch('click'); },
    focus() { this.ownerDocument.activeElement = this; },
  };
  Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, value));
  return node;
}

function confirmationPage({ enhance = true } = {}) {
  const document = element('document');
  document.nodeType = 9;
  document.ownerDocument = document;
  document.activeElement = null;
  document.body = element('body');
  document.appendChild(document.body);
  document.getElementById = (id) => document.querySelector(`#${id}`);

  const dialog = element('dialog', { id: 'app-confirmation-dialog', 'data-app-dialog': '' });
  const title = element('h2', { id: 'app-confirmation-dialog-title' });
  title.textContent = 'Confirm action';
  const message = element('p', { 'data-app-dialog-confirmation-message': '' });
  const close = element('button', { type: 'button', 'data-dialog-close': '' });
  const cancel = element('button', { type: 'button', 'data-dialog-close': '', 'data-app-dialog-confirmation-cancel': '' });
  const confirm = element('button', { type: 'button', 'data-app-dialog-confirmation-confirm': '' });
  confirm.textContent = 'Confirm';
  dialog.showModal = vi.fn(() => { dialog.open = true; dialog.setAttribute('open', ''); });
  dialog.close = vi.fn(() => { dialog.open = false; dialog.removeAttribute('open'); dialog.dispatch('close'); });
  dialog.appendChild(title);
  dialog.appendChild(message);
  dialog.appendChild(close);
  dialog.appendChild(cancel);
  dialog.appendChild(confirm);
  document.body.appendChild(dialog);
  if (enhance) enhanceAppDialogs(document);
  return { document, dialog, title, message, close, cancel, confirm };
}

function projectEditConfirmationPage() {
  const page = confirmationPage();
  const projectEdit = element('dialog', { id: 'project-edit-dialog', 'data-app-dialog': '' });
  const archiveProject = element('button', {
    type: 'submit',
    'data-confirm': 'Archive this project? This cannot be undone.',
  });
  const deleteForm = element('form', { method: 'post', action: '/projects/7/delete' });
  const csrf = element('input', { type: 'hidden', name: '_csrf', value: 'csrf-token' });
  const deleteProject = element('button', {
    type: 'submit',
    'data-confirm': 'Delete this project permanently? This cannot be undone.',
    'data-confirm-dialog-title': 'Delete project',
    'data-confirm-dialog-confirm-label': 'Delete project',
  });
  const nativeSubmit = vi.fn();
  projectEdit.showModal = vi.fn(() => { projectEdit.open = true; projectEdit.setAttribute('open', ''); });
  projectEdit.close = vi.fn(() => { projectEdit.open = false; projectEdit.removeAttribute('open'); projectEdit.dispatch('close'); });
  deleteForm.appendChild(csrf);
  deleteForm.appendChild(deleteProject);
  projectEdit.appendChild(archiveProject);
  projectEdit.appendChild(deleteForm);
  page.document.body.appendChild(projectEdit);
  deleteProject.form = deleteForm;
  deleteProject.click = () => {
    const event = deleteProject.dispatch('click');
    if (!event.defaultPrevented) nativeSubmit(deleteForm, deleteProject);
    return event;
  };

  enhanceAppDialogs(page.document);
  openAppDialogById(page.document, 'project-edit-dialog');
  enhanceConfirmations(page.document);

  return {
    ...page,
    projectEdit,
    archiveProject,
    deleteForm,
    csrf,
    deleteProject,
    nativeSubmit,
  };
}

describe('shared app confirmation dialog', () => {
  it('opens the enhanced shared dialog with text-safe request content and confirms once', async () => {
    const page = confirmationPage();
    const request = requestAppConfirmation(page.document, {
      title: '<b>Delete</b>', message: '<img src=x>', confirmLabel: '<strong>Delete</strong>',
    });

    expect(page.dialog.showModal).toHaveBeenCalledOnce();
    expect(page.title.textContent).toBe('<b>Delete</b>');
    expect(page.message.textContent).toBe('<img src=x>');
    expect(page.confirm.textContent).toBe('<strong>Delete</strong>');
    page.confirm.click();
    page.confirm.click();

    await expect(request).resolves.toBe(true);
    expect(page.dialog.close).toHaveBeenCalledOnce();
    expect(page.title.textContent).toBe('Confirm action');
    expect(page.message.textContent).toBe('');
    expect(page.confirm.textContent).toBe('Confirm');
  });

  it.each(['cancel', 'close'])('settles %s as false through the app-dialog close lifecycle', async (control) => {
    const page = confirmationPage();
    const request = requestAppConfirmation(page.document);
    page[control].click();
    await expect(request).resolves.toBe(false);
  });

  it.each(['keydown', 'ordinary'])('settles %s close as false', async (kind) => {
    const page = confirmationPage();
    const request = requestAppConfirmation(page.document);
    if (kind === 'keydown') page.dialog.dispatch('keydown', { key: 'Escape' });
    else page.dialog.close();
    await expect(request).resolves.toBe(false);
  });

  it('fails safely when the shared dialog is missing or unbound', async () => {
    await expect(requestAppConfirmation(confirmationPage({ enhance: false }).document)).resolves.toBe(false);
    await expect(requestAppConfirmation({ getElementById: () => null })).resolves.toBe(false);
  });

  it('keeps one active request intact when a concurrent request arrives', async () => {
    const page = confirmationPage();
    const active = requestAppConfirmation(page.document, { message: 'first' });
    await expect(requestAppConfirmation(page.document, { message: 'second' })).resolves.toBe(false);
    expect(page.message.textContent).toBe('first');
    page.confirm.click();
    await expect(active).resolves.toBe(true);
  });

  it('restores the prior close hook after settlement', async () => {
    const page = confirmationPage();
    const previousOnClose = vi.fn();
    page.dialog.__creatorCrateAppDialogState.onClose = previousOnClose;
    const request = requestAppConfirmation(page.document);
    page.cancel.click();
    await expect(request).resolves.toBe(false);
    expect(previousOnClose).toHaveBeenCalledOnce();
    expect(page.dialog.__creatorCrateAppDialogState.onClose).toBe(previousOnClose);
  });
});

describe('Project Edit Delete confirmation dialog', () => {
  it.each(['cancel', 'close', 'escape'])('keeps Project Edit open and restores Delete focus after %s', async (path) => {
    const page = projectEditConfirmationPage();
    const initial = page.deleteProject.click();
    expect(initial.defaultPrevented).toBe(true);
    expect(page.dialog.open).toBe(true);
    expect(page.projectEdit.open).toBe(true);
    expect(page.dialog.parentNode).toBe(page.document.body);
    expect(page.projectEdit.parentNode).toBe(page.document.body);
    expect(page.dialog.parentNode).toBe(page.projectEdit.parentNode);
    expect(page.document.body.classList.contains('app-dialog-open')).toBe(true);
    expect(page.nativeSubmit).not.toHaveBeenCalled();

    if (path === 'escape') page.dialog.dispatch('keydown', { key: 'Escape' });
    else page[path].click();
    await Promise.resolve();

    expect(page.dialog.open).toBe(false);
    expect(page.projectEdit.open).toBe(true);
    expect(page.document.body.classList.contains('app-dialog-open')).toBe(true);
    expect(page.document.activeElement).toBe(page.deleteProject);
    expect(page.nativeSubmit).not.toHaveBeenCalled();
  });

  it('replays each control with its original native form semantics', async () => {
    const page = projectEditConfirmationPage();

    const initial = page.deleteProject.click();
    expect(initial.defaultPrevented).toBe(true);
    expect(page.dialog.open).toBe(true);
    expect(page.deleteForm.getAttribute('action')).toBe('/projects/7/delete');
    expect(page.deleteForm.getAttribute('method')).toBe('post');
    expect(page.csrf.getAttribute('value')).toBe('csrf-token');
    page.confirm.click();
    await Promise.resolve();

    expect(page.nativeSubmit).toHaveBeenCalledTimes(1);
    expect(page.nativeSubmit).toHaveBeenCalledWith(page.deleteForm, page.deleteProject);
    expect(page.dialog.showModal).toHaveBeenCalledOnce();
    expect(page.dialog.open).toBe(false);
    expect(page.projectEdit.open).toBe(true);
    const archive = page.archiveProject.click();
    expect(archive.defaultPrevented).toBe(true);
    expect(page.dialog.open).toBe(true);
    expect(page.message.textContent).toBe('Archive this project? This cannot be undone.');
    page.cancel.click();
  });
});

describe('data-confirm controls', () => {
  it('synchronously prevents the initial click, replays exactly once, and never recurses', async () => {
    const page = confirmationPage();
    const control = element('button', { 'data-confirm': 'Delete it?' });
    page.document.body.appendChild(control);
    enhanceAppConfirmationControls(page.document);
    const normalClick = vi.fn();
    control.addEventListener('click', normalClick);

    const initial = control.click();
    expect(initial.defaultPrevented).toBe(true);
    expect(page.dialog.open).toBe(true);
    page.confirm.click();
    await Promise.resolve();

    expect(control.dataset.confirmationDialogBound).toBe('true');
    expect(normalClick).toHaveBeenCalledTimes(2);
    expect(page.dialog.showModal).toHaveBeenCalledOnce();
  });

  it('does not replay when cancelled', async () => {
    const page = confirmationPage();
    const control = element('button', { 'data-confirm': 'Delete it?' });
    const click = vi.fn();
    control.addEventListener('click', click);
    page.document.body.appendChild(control);
    enhanceAppConfirmationControls(page.document);

    control.click();
    page.cancel.click();
    await Promise.resolve();
    expect(click).toHaveBeenCalledOnce();
  });

  it('uses the shared dialog for every data-confirm control without an opt-in attribute', async () => {
    const page = confirmationPage();
    const first = element('button', { 'data-confirm': 'first' });
    const second = element('button', { 'data-confirm': 'second' });
    page.document.body.appendChild(first);
    page.document.body.appendChild(second);

    enhanceConfirmations(page.document);
    expect(first.click().defaultPrevented).toBe(true);
    expect(page.message.textContent).toBe('first');
    page.cancel.click();
    await Promise.resolve();

    expect(second.click().defaultPrevented).toBe(true);
    expect(page.message.textContent).toBe('second');
  });
});

function bookUploadPage(kind = 'project_asset', files = [{ name: 'cover.png' }]) {
  const page = confirmationPage();
  const host = element('dialog', { id: 'book-edit-dialog', 'data-app-dialog': '' });
  const form = element('form', { enctype: 'multipart/form-data', 'data-dialog-form': '', 'data-dialog-async': 'false' });
  const field = (name, value, type = 'hidden') => {
    const input = element('input', { name, type });
    input.value = value;
    form.appendChild(input);
    return input;
  };
  const cover = field('cover', '', 'file');
  cover.files = files;
  const source = field('expectedCoverKind', kind);
  const id = field('expectedCoverId', kind === 'none' ? '' : '42');
  const confirmed = field('coverReplacementConfirmed', 'false');
  const button = element('button', { type: 'submit' });
  button.form = form;
  form.appendChild(button);
  host.appendChild(form);
  page.document.body.appendChild(host);
  enhanceAppDialogs(page.document);
  openAppDialogById(page.document, host.id);
  const nativeSubmit = vi.fn();
  let valid = true;
  const submit = (submitter = button) => {
    if (!valid) return;
    const event = form.dispatch('submit', { submitter });
    if (!event.defaultPrevented) nativeSubmit({ confirmed: confirmed.value, files: cover.files, kind: source.value, id: id.value, submitter });
    return event;
  };
  form.requestSubmit = vi.fn(submit);
  enhanceBookCoverUploads(page.document);
  return { ...page, host, form, cover, source, id, confirmed, button, nativeSubmit, submit, invalidate: () => { valid = false; }, validate: () => { valid = true; } };
}

const settleBookConfirmation = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

describe('Book cover upload shared confirmation', () => {
  it.each([
    ['New Book', 'none', [{}]], ['Edit Book without cover', 'none', [{}]],
    ['Project cover text edit', 'project_asset', []], ['Managed cover text edit', 'managed_asset', []],
    ['New Book without cover', 'none', []],
  ])('%s submits directly without confirmation', (_label, kind, files) => {
    const page = bookUploadPage(kind, files);
    page.submit();
    page.submit();
    page.cover.dispatch('change');
    page.submit();
    expect(page.nativeSubmit).toHaveBeenCalledOnce();
    expect(page.confirmed.value).toBe('false');
    expect(page.dialog.open).toBe(false);
  });

  it('a later submit listener cancellation releases the direct guard', async () => {
    const page = bookUploadPage('none');
    const cancel = (event) => event.preventDefault();
    page.form.addEventListener('submit', cancel);
    page.submit();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(page.nativeSubmit).not.toHaveBeenCalled();
    page.form.removeEventListener('submit', cancel);
    page.submit();
    expect(page.nativeSubmit).toHaveBeenCalledOnce();
  });

  it('a synchronous confirmation failure releases the guard and preserves the error', () => {
    const page = bookUploadPage();
    const lookup = page.document.getElementById;
    const failure = new Error('confirmation lookup failed');
    page.document.getElementById = () => { throw failure; };
    expect(() => page.submit()).toThrow(failure);
    expect(page.confirmed.value).toBe('false');
    expect(page.nativeSubmit).not.toHaveBeenCalled();
    page.document.getElementById = lookup;
    page.cover.files = [];
    page.cover.dispatch('change');
    page.submit();
    expect(page.nativeSubmit).toHaveBeenCalledOnce();
  });

  describe.each(['project_asset', 'managed_asset'])('%s replacement', (kind) => {
    it.each(['cancel', 'close', 'Escape', 'native cancel'])('%s cancels without closing Book or clearing the file and permits retry', async (action) => {
      const page = bookUploadPage(kind);
      page.submit();
      expect(page.dialog.open).toBe(true);
      expect(page.document.activeElement).toBe(page.close);
      if (action === 'Escape') page.dialog.dispatch('keydown', { key: 'Escape' });
      else if (action === 'native cancel') page.dialog.dispatch('cancel');
      else page[action].click();
      await settleBookConfirmation();
      expect(page.nativeSubmit).not.toHaveBeenCalled();
      expect(page.confirmed.value).toBe('false');
      expect(page.cover.files).toHaveLength(1);
      expect(page.host.open).toBe(true);
      expect(page.document.activeElement).toBe(page.button);
      page.submit();
      expect(page.dialog.open).toBe(true);
      page.cancel.click();
      await settleBookConfirmation();
    });

    it('approves exactly one native submission with the unchanged source and submitter', async () => {
      const page = bookUploadPage(kind);
      expect(enhanceBookCoverUploads(page.document)).toBe(0);
      page.submit(); page.submit(); page.submit();
      expect(page.dialog.showModal).toHaveBeenCalledOnce();
      expect(page.message.textContent).toContain('previous image or Asset will not be deleted');
      expect(page.message.textContent).not.toMatch(/managed_asset|project_asset|42/);
      page.confirm.click(); page.confirm.click();
      await settleBookConfirmation();
      page.submit();
      expect(page.form.requestSubmit).toHaveBeenCalledExactlyOnceWith(page.button);
      expect(page.nativeSubmit).toHaveBeenCalledExactlyOnceWith({ confirmed: 'true', files: page.cover.files, kind, id: '42', submitter: page.button });
      expect(page.confirmed.value).toBe('false');
    });
  });

  it('keyboard submit without a submitter uses the same rule', async () => {
    const page = bookUploadPage();
    page.cover.focus();
    page.submit(null);
    expect(page.dialog.open).toBe(true);
    page.confirm.click();
    await settleBookConfirmation();
    expect(page.form.requestSubmit).toHaveBeenCalledExactlyOnceWith();
    expect(page.nativeSubmit).toHaveBeenCalledOnce();
  });

  it('clearing the selection resets stale authorization and submits without a warning', () => {
    const page = bookUploadPage();
    page.confirmed.value = 'true';
    page.cover.files = [];
    page.cover.dispatch('change');
    page.submit();
    expect(page.confirmed.value).toBe('false');
    expect(page.dialog.open).toBe(false);
    expect(page.nativeSubmit).toHaveBeenCalledOnce();
  });

  it('approval uses the current file after selection changes while pending', async () => {
    const page = bookUploadPage();
    page.submit();
    page.cover.files = [{ name: 'another.png' }];
    page.cover.dispatch('change');
    page.submit();
    expect(page.dialog.showModal).toHaveBeenCalledOnce();
    page.confirm.click();
    await settleBookConfirmation();
    expect(page.nativeSubmit.mock.calls[0][0].files[0].name).toBe('another.png');
  });

  it.each(['clear file', 'no cover'])('pending approval after %s does not retain replacement authorization', async (change) => {
    const page = bookUploadPage();
    page.submit();
    if (change === 'clear file') page.cover.files = [];
    else page.source.value = 'none';
    page.confirm.click();
    await settleBookConfirmation();
    expect(page.nativeSubmit.mock.calls[0][0].confirmed).toBe('false');
    expect(page.confirmed.value).toBe('false');
  });

  it('validation-blocked approval cannot authorize a later file selection', async () => {
    const page = bookUploadPage();
    page.submit();
    page.invalidate();
    page.confirm.click();
    await settleBookConfirmation();
    expect(page.nativeSubmit).not.toHaveBeenCalled();
    expect(page.confirmed.value).toBe('false');
    page.cover.files = [{ name: 'later.png' }];
    page.cover.dispatch('change');
    page.validate();
    page.submit();
    expect(page.dialog.showModal).toHaveBeenCalledTimes(2);
    page.cancel.click();
    await settleBookConfirmation();
  });
});
