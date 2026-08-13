import { describe, it, expect, vi } from 'vitest';
import { enhanceAppDialogs } from '../src/static/creatorcrate.js';

function makeElement(tagName = 'div', attrs = {}) {
  const attributes = new Map();
  const listeners = [];
  const children = [];
  const node = {
    tagName: tagName.toUpperCase(),
    nodeType: 1,
    children,
    listeners,
    parentNode: null,
    parentElement: null,
    ownerDocument: null,
    dataset: {},
    hidden: false,
    disabled: false,
    open: false,
    value: '',
    textContent: '',
    classList: {
      values: new Set(),
      add(...names) { names.forEach((name) => this.values.add(name)); },
      remove(...names) { names.forEach((name) => this.values.delete(name)); },
      toggle(name, force) {
        const next = force === undefined ? !this.values.has(name) : force;
        if (next) this.values.add(name);
        else this.values.delete(name);
        return next;
      },
      contains(name) { return this.values.has(name); },
    },
    setAttribute(name, rawValue) {
      const value = String(rawValue);
      attributes.set(name, value);
      if (name === 'id') this.id = value;
      if (name === 'name') this.name = value;
      if (name === 'type') this.type = value;
      if (name === 'value') this.value = value;
      if (name === 'action') this.action = value;
      if (name === 'method') this.method = value;
      if (name === 'hidden') this.hidden = true;
      if (name.startsWith('data-')) {
        this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
      }
    },
    getAttribute(name) { return attributes.get(name) ?? null; },
    hasAttribute(name) { return attributes.has(name); },
    removeAttribute(name) {
      attributes.delete(name);
      if (name === 'hidden') this.hidden = false;
      if (name === 'open') this.open = false;
      if (name.startsWith('data-')) {
        delete this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())];
      }
    },
    matches(selector) {
      return selector.split(',').some((part) => {
        const candidate = part.trim();
        if (candidate.startsWith('#')) return this.id === candidate.slice(1);
        const tag = candidate.match(/^[a-z][\w-]*/i)?.[0];
        if (tag && this.tagName !== tag.toUpperCase()) return false;
        const classMatch = candidate.match(/\.([\w-]+)/);
        if (classMatch && !this.classList.contains(classMatch[1])) return false;
        return [...candidate.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)].every(([, name, expected]) => {
          const actual = this.getAttribute(name);
          return actual !== null && (expected === undefined || actual === expected);
        });
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
      children.push(child);
      child.parentNode = this;
      child.parentElement = this;
      const document = this.ownerDocument || (this.nodeType === 9 ? this : null);
      const adopt = (current) => {
        current.ownerDocument = document;
        current.children.forEach(adopt);
      };
      adopt(child);
      if (this.tagName === 'SELECT' && child.tagName === 'OPTION') this.options.push(child);
      return child;
    },
    replaceWith(next) {
      const parent = this.parentNode;
      if (!parent) return;
      const index = parent.children.indexOf(this);
      if (index < 0) return;
      parent.children.splice(index, 1, next);
      this.parentNode = null;
      this.parentElement = null;
      next.parentNode = parent;
      next.parentElement = parent;
      next.ownerDocument = parent.ownerDocument || parent;
    },
    remove() {
      const parent = this.parentNode;
      const index = parent?.children?.indexOf(this) ?? -1;
      if (index >= 0) {
        parent.children.splice(index, 1);
        if (parent.tagName === 'SELECT') {
          const optionIndex = parent.options?.indexOf(this) ?? -1;
          if (optionIndex >= 0) parent.options.splice(optionIndex, 1);
        }
      }
      this.parentNode = null;
      this.parentElement = null;
    },
    addEventListener(type, handler) { listeners.push({ type, handler }); },
    dispatch(type, props = {}) {
      const event = {
        type,
        target: props.target || this,
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
        ...props,
      };
      listeners.filter((listener) => listener.type === type)
        .forEach((listener) => listener.handler(event));
      return event;
    },
    focus() {
      this.focused = true;
      if (this.ownerDocument) this.ownerDocument.activeElement = this;
    },
    contains(candidate) {
      let current = candidate;
      while (current) {
        if (current === this) return true;
        current = current.parentNode;
      }
      return false;
    },
    querySelectorAll(selector) {
      const result = [];
      const visit = (current) => {
        current.children.forEach((child) => {
          if (child.matches?.(selector)) result.push(child);
          visit(child);
        });
      };
      visit(this);
      return result;
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
  };

  if (tagName.toUpperCase() === 'SELECT') node.options = [];
  Object.entries(attrs).forEach(([name, value]) => node.setAttribute(name, value));
  return node;
}

function addOption(select, value, selected = false) {
  const option = makeElement('option', { value });
  option.selected = selected;
  select.appendChild(option);
  return option;
}

function makeDialogPage() {
  const document = makeElement('document');
  document.nodeType = 9;
  document.ownerDocument = document;
  document.activeElement = null;
  document.body = makeElement('body');
  document.appendChild(document.body);
  document.getElementById = (id) => document.querySelector(`#${id}`);
  document.createElement = (tagName) => makeElement(tagName);

  const region = makeElement('div', { 'data-projects-live-region': '' });
  const trigger = makeElement('a', {
    href: '/projects?defaults=1',
    'data-dialog-open': 'projects-defaults-dialog',
  });
  const dialog = makeElement('dialog', {
    id: 'projects-defaults-dialog',
    'data-app-dialog': '',
  });
  dialog.showModal = vi.fn(() => {
    dialog.open = true;
    dialog.setAttribute('open', '');
  });
  dialog.close = vi.fn(() => {
    dialog.open = false;
    dialog.removeAttribute('open');
    dialog.dispatch('close');
  });

  const card = makeElement('div');
  const close = makeElement('button', { 'data-dialog-close': '' });
  card.appendChild(close);
  const form = makeElement('form', {
    id: 'projects-defaults-form',
    action: '/projects/defaults',
    method: 'post',
    'data-dialog-form': '',
  });
  const error = makeElement('div', { 'data-dialog-error': '', hidden: '' });
  const errorText = makeElement('p', { 'data-dialog-error-text': '' });
  const errorList = makeElement('ul', { 'data-dialog-error-list': '' });
  error.appendChild(errorText);
  error.appendChild(errorList);
  form.appendChild(error);
  form.appendChild(makeElement('input', { name: '_csrf', value: 'csrf-token', type: 'hidden' }));
  const fields = {};
  for (const [name, value, options] of [
    ['view', 'grid', ['grid', 'list']],
    ['sort', 'created', ['updated', 'created', 'title', 'published']],
    ['order', 'desc', ['asc', 'desc']],
  ]) {
    const field = makeElement('div', { 'data-dialog-field': name });
    const select = makeElement('select', { name });
    options.forEach((option) => addOption(select, option, option === value));
    select.value = value;
    field.appendChild(select);
    form.appendChild(field);
    fields[name] = select;
  }
  const status = makeElement('div', { 'data-dialog-status': '' });
  const save = makeElement('button', { 'data-dialog-submit': '', type: 'submit' });
  form.appendChild(status);
  form.appendChild(save);
  card.appendChild(form);
  dialog.appendChild(card);

  const feedback = makeElement('div', { 'data-dialog-feedback': '', hidden: '' });
  feedback.appendChild(makeElement('p', { 'data-dialog-feedback-text': '' }));
  document.body.appendChild(region);
  document.body.appendChild(feedback);
  document.body.appendChild(dialog);

  const windowObject = {
    fetch: vi.fn(),
    FormData: class FormDataMock {
      constructor(ownerForm) {
        this.fields = ownerForm.querySelectorAll('select, input, textarea')
          .filter((control) => control.name && !control.disabled)
          .map((control) => [control.name, control.value]);
      }
      *entries() { yield* this.fields; }
      [Symbol.iterator]() { return this.entries(); }
    },
    URLSearchParams,
  };
  document.defaultView = windowObject;

  return {
    document,
    windowObject,
    region,
    trigger,
    dialog,
    close,
    form,
    save,
    fields,
    feedback,
  };
}

async function flush() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

describe('Reusable app dialog enhancement', () => {
  it('opens through delegation, closes on cancel, restores focus, and survives trigger replacement', () => {
    const page = makeDialogPage();
    page.region.appendChild(page.trigger);

    expect(enhanceAppDialogs(page.document)).toBe(1);
    expect(enhanceAppDialogs(page.document)).toBe(1);
    expect(page.document.listeners.filter(({ type }) => type === 'click')).toHaveLength(1);

    page.document.dispatch('click', { target: page.trigger });
    expect(page.dialog.open).toBe(true);
    expect(page.close.focused).toBe(true);

    const replacement = makeElement('a', {
      href: '/projects?defaults=1',
      'data-dialog-open': 'projects-defaults-dialog',
    });
    page.trigger.replaceWith(replacement);
    page.dialog.dispatch('cancel');
    expect(page.dialog.open).toBe(false);
    expect(replacement.focused).toBe(true);

    page.document.dispatch('click', { target: replacement });
    expect(page.dialog.open).toBe(true);
    page.dialog.dispatch('cancel');
    expect(replacement.focused).toBe(true);
  });

  it('saves asynchronously without navigation and closes on success', async () => {
    const page = makeDialogPage();
    page.region.appendChild(page.trigger);
    page.windowObject.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'success',
        message: 'Projects defaults saved successfully.',
        values: { view: 'list', sort: 'title', order: 'asc' },
      }),
    });
    enhanceAppDialogs(page.document);
    page.document.dispatch('click', { target: page.trigger });
    page.fields.view.value = 'list';
    page.fields.sort.value = 'title';
    page.fields.order.value = 'asc';
    page.form.dispatch('submit', { submitter: page.save });
    await flush();

    expect(page.windowObject.fetch).toHaveBeenCalledTimes(1);
    expect(page.windowObject.fetch.mock.calls[0][0]).toBe('/projects/defaults');
    expect(page.windowObject.fetch.mock.calls[0][1].headers).toEqual({ Accept: 'application/json' });
    expect([...page.windowObject.fetch.mock.calls[0][1].body.entries()]).toEqual([
      ['_csrf', 'csrf-token'],
      ['view', 'list'],
      ['sort', 'title'],
      ['order', 'asc'],
    ]);
    expect(page.dialog.open).toBe(false);
    expect(page.trigger.focused).toBe(true);
    expect(page.feedback.hidden).toBe(false);
  });

  it('keeps the dialog open and preserves submitted values on validation failure', async () => {
    const page = makeDialogPage();
    page.region.appendChild(page.trigger);
    page.windowObject.fetch.mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({
        status: 'error',
        message: 'Fix the highlighted fields and try again.',
        errors: { sort: 'Value is not supported.' },
        values: { view: 'list', sort: 'invalid', order: 'asc' },
      }),
    });
    enhanceAppDialogs(page.document);
    page.document.dispatch('click', { target: page.trigger });
    page.form.dispatch('submit', { submitter: page.save });
    await flush();

    expect(page.dialog.open).toBe(true);
    expect(page.fields.view.value).toBe('list');
    expect(page.fields.sort.value).toBe('invalid');
    expect(page.fields.sort.querySelectorAll('option[data-dialog-submitted-value]')).toHaveLength(1);
    expect(page.fields.sort.querySelector('option[data-dialog-submitted-value]').textContent)
      .toBe('Submitted value: invalid');
    expect(page.fields.order.value).toBe('asc');
    expect(page.fields.sort.getAttribute('aria-invalid')).toBe('true');
    expect(page.dialog.querySelector('[data-dialog-error]').hidden).toBe(false);
    expect(page.dialog.querySelector('[data-dialog-error-list]').textContent).toContain('Value is not supported.');
  });

  it('cleans temporary submitted options across validation, correction, and reopen', async () => {
    const page = makeDialogPage();
    page.region.appendChild(page.trigger);
    page.windowObject.fetch
      .mockResolvedValueOnce({
        ok: false,
        status: 422,
        json: async () => ({
          status: 'error',
          errors: { sort: 'Value is not supported.' },
          values: { view: 'list', sort: 'invalid1', order: 'asc' },
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 422,
        json: async () => ({
          status: 'error',
          errors: { sort: 'Value is not supported.' },
          values: { view: 'list', sort: 'invalid2', order: 'asc' },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'success',
          values: { view: 'list', sort: 'title', order: 'asc' },
        }),
      });
    enhanceAppDialogs(page.document);
    page.document.dispatch('click', { target: page.trigger });

    page.form.dispatch('submit', { submitter: page.save });
    await flush();
    expect(page.fields.sort.querySelectorAll('option[data-dialog-submitted-value]')
      .map((option) => option.value)).toEqual(['invalid1']);

    page.form.dispatch('submit', { submitter: page.save });
    await flush();
    expect(page.fields.sort.querySelectorAll('option[data-dialog-submitted-value]')
      .map((option) => option.value)).toEqual(['invalid2']);

    page.fields.sort.value = 'title';
    page.form.dispatch('submit', { submitter: page.save });
    await flush();
    expect(page.dialog.open).toBe(false);

    page.document.dispatch('click', { target: page.trigger });
    expect(page.fields.sort.value).toBe('title');
    expect(page.fields.sort.querySelectorAll('option[data-dialog-submitted-value]')).toHaveLength(0);
    expect(page.fields.sort.querySelectorAll('option').map((option) => option.value))
      .toEqual(['updated', 'created', 'title', 'published']);
  });

  it('keeps the dialog open and reports genuine network failures', async () => {
    const page = makeDialogPage();
    page.region.appendChild(page.trigger);
    page.windowObject.fetch.mockRejectedValue(new Error('network down'));
    enhanceAppDialogs(page.document);
    page.document.dispatch('click', { target: page.trigger });
    page.form.dispatch('submit', { submitter: page.save });
    await flush();

    expect(page.dialog.open).toBe(true);
    expect(page.dialog.querySelector('[data-dialog-status]').textContent).toContain('Could not save defaults');
    expect(page.dialog.querySelector('[data-dialog-error-text]').textContent).toContain('Your selections were kept');
  });
});
