import { describe, it, expect, vi } from 'vitest';
import {
  enhanceAppDialogs,
  enhanceCategoryReorder,
  enhanceConfirmations,
  enhanceDropdowns,
  enhanceProjectAssetCategoryManagement,
} from '../src/static/creatorcrate.js';

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
    style: {
      values: new Map(),
      setProperty(name, value) { this.values.set(name, String(value)); },
      getPropertyValue(name) { return this.values.get(name) || ''; },
      removeProperty(name) { this.values.delete(name); },
    },
    setAttribute(name, rawValue) {
      const value = String(rawValue);
      attributes.set(name, value);
      if (name === 'id') this.id = value;
      if (name === 'name') this.name = value;
      if (name === 'type') this.type = value;
      if (name === 'value') this.value = value;
      if (name === 'class') value.split(/\s+/).filter(Boolean).forEach((className) => this.classList.add(className));
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
        if (candidate.includes(':checked') && !this.checked) return false;
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
      if (this.tagName === 'LABEL' && child.tagName === 'SPAN') this.textContent = child.textContent;
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
      const adopt = (current) => {
        current.ownerDocument = next.ownerDocument;
        current.children.forEach(adopt);
      };
      next.children.forEach(adopt);
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
    removeEventListener(type, handler) {
      const index = listeners.findIndex((listener) => listener.type === type && listener.handler === handler);
      if (index >= 0) listeners.splice(index, 1);
    },
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
    dispatchEvent(event) {
      return this.dispatch(event.type, { ...event, target: this });
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

function addStandardDropdown(
  field,
  select,
  name,
  options,
  value,
  dispatchNativeChange = false,
  mode = 'single',
  selectedValues = [],
) {
  const fieldset = makeElement('fieldset');
  const details = makeElement('details', {
    id: `${name}-dropdown`,
    'data-cc-dropdown': '',
    'data-cc-dropdown-mode': mode,
    hidden: '',
  });
  if (dispatchNativeChange) details.setAttribute('data-cc-dropdown-dispatch-native-change', '');
  const summary = makeElement('summary', {
    'aria-label': `${name} filter: ${value}`,
  });
  const current = makeElement('span', { 'data-cc-dropdown-summary-current': '' });
  current.textContent = value;
  summary.appendChild(current);
  const panel = makeElement('div', { class: 'asset-filter-multiselect-panel', 'data-cc-dropdown-option-list': '' });
  options.forEach((option) => {
    const wrapper = makeElement('div', { class: 'asset-filter-multiselect-option' });
    const label = makeElement('label');
    const input = makeElement('input', {
      type: mode === 'single' ? 'radio' : 'checkbox',
      value: option,
    });
    input.checked = mode === 'multiple' ? selectedValues.includes(option) : option === value;
    label.appendChild(input);
    const optionText = makeElement('span');
    optionText.textContent = option;
    label.appendChild(optionText);
    wrapper.appendChild(label);
    panel.appendChild(wrapper);
  });
  if (select) {
    select.setAttribute('data-cc-dropdown-native-select', '');
    fieldset.appendChild(select);
  }
  details.appendChild(summary);
  details.appendChild(panel);
  fieldset.appendChild(details);
  field.appendChild(fieldset);
  return { details, summary, panel };
}

function makeDialogPage({
  standardDropdowns = false,
  scrollableDialog = false,
  projectEditDialog = false,
  liveDefault = false,
} = {}) {
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
  if (standardDropdowns) card.classList.add('app-dialog-card');
  if (liveDefault) card.setAttribute('data-asset-browser-default', '');
  const close = makeElement('button', { type: 'button', 'data-dialog-close': '' });
  card.appendChild(close);
  const form = makeElement('form', {
    id: 'projects-defaults-form',
    action: '/projects/defaults',
    method: 'post',
    'data-dialog-form': '',
  });
  if (liveDefault) {
    form.setAttribute('data-dialog-async', 'false');
    form.setAttribute('data-asset-browser-default-live', '');
  }
  const error = makeElement('div', { 'data-dialog-error': '', hidden: '' });
  const errorText = makeElement('p', { 'data-dialog-error-text': '' });
  const errorList = makeElement('ul', { 'data-dialog-error-list': '' });
  error.appendChild(errorText);
  error.appendChild(errorList);
  form.appendChild(error);
  form.appendChild(makeElement('input', { name: '_csrf', value: 'csrf-token', type: 'hidden' }));
  const fields = {};
  const dropdowns = {};
  const dialogBody = standardDropdowns ? makeElement('div') : null;
  if (dialogBody) {
    dialogBody.classList.add('app-dialog-body');
    if (scrollableDialog) dialogBody.classList.add('project-asset-category-management-dialog-body');
    if (projectEditDialog) dialogBody.classList.add('project-edit-dialog-body');
    dialogBody.scrollTop = 0;
    if (projectEditDialog) {
      const toggle = dialogBody.classList.toggle.bind(dialogBody.classList);
      dialogBody.classList.toggle = (name, force) => {
        const result = toggle(name, force);
        if (name === 'cc-dropdown-dialog-open') dialogBody.scrollTop = 0;
        return result;
      };
    }
  }
  for (const [name, value, options] of [
    ['view', 'grid', ['grid', 'list']],
    ['sort', 'created', ['updated', 'created', 'title', 'published']],
    ['order', 'desc', ['asc', 'desc']],
  ]) {
    const field = makeElement('div', { 'data-dialog-field': name });
    const select = makeElement('select', { id: `projects-default-${name}`, name });
    options.forEach((option) => addOption(select, option, option === value));
    select.value = value;
    if (standardDropdowns) dropdowns[name] = addStandardDropdown(field, select, name, options, value);
    else field.appendChild(select);
    (dialogBody || form).appendChild(field);
    fields[name] = select;
  }
  if (liveDefault) {
    const field = makeElement('div', { 'data-dialog-field': 'defaultCategory' });
    const select = makeElement('select', { id: 'project-asset-categories-default-category', name: 'defaultCategory' });
    for (const option of ['inherit', 'all', 'category:1']) addOption(select, option, option === 'inherit');
    select.value = 'inherit';
    if (standardDropdowns) {
      dropdowns.defaultCategory = addStandardDropdown(
        field,
        select,
        'defaultCategory',
        ['inherit', 'all', 'category:1'],
        'inherit',
        true,
      );
    } else {
      field.appendChild(select);
    }
    (dialogBody || form).appendChild(field);
    fields.defaultCategory = select;
  }
  if (projectEditDialog) {
    const field = makeElement('div', { 'data-dialog-field': 'tagIds' });
    const select = makeElement('select', { id: 'project-tags-form', name: 'tagIds[]' });
    for (const option of ['alpha', 'beta', 'gamma']) addOption(select, option, option === 'alpha');
    select.value = 'alpha';
    dropdowns.tags = addStandardDropdown(
      field,
      select,
      'tags',
      ['alpha', 'beta', 'gamma'],
      '',
      false,
      'multiple',
      ['alpha'],
    );
    dialogBody.appendChild(field);
    fields.tags = select;
  }
  if (scrollableDialog || projectEditDialog) {
    Object.values(dropdowns).forEach(({ summary, panel }) => {
      summary.getBoundingClientRect = () => ({
        left: 100,
        top: 120,
        right: 500,
        bottom: 160,
        width: 400,
        height: 40,
      });
      panel.getBoundingClientRect = () => ({ width: 400, height: 180 });
    });
  }
  if (dialogBody) form.appendChild(dialogBody);
  const status = makeElement('div', { 'data-dialog-status': '' });
  if (liveDefault) status.setAttribute('data-asset-browser-default-status', '');
  const save = liveDefault ? null : makeElement('button', { 'data-dialog-submit': '', type: 'submit' });
  form.appendChild(status);
  if (save) form.appendChild(save);
  card.appendChild(form);
  let liveError = null;
  let liveErrorText = null;
  if (liveDefault) {
    liveError = makeElement('div', {
      id: 'project-asset-categories-default-category-error',
      'data-asset-browser-default-error': '',
      hidden: '',
    });
    liveErrorText = makeElement('p', { 'data-asset-browser-default-error-text': '' });
    liveError.appendChild(liveErrorText);
    card.appendChild(liveError);
  }
  dialog.appendChild(card);

  const feedback = makeElement('div', { 'data-dialog-feedback': '', hidden: '' });
  feedback.appendChild(makeElement('p', { 'data-dialog-feedback-text': '' }));
  document.body.appendChild(region);
  document.body.appendChild(feedback);
  document.body.appendChild(dialog);

  const windowObject = {
    fetch: vi.fn(),
    innerWidth: 1024,
    innerHeight: 768,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
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
    dropdowns,
    dialogBody,
    feedback,
    liveError,
    liveErrorText,
  };
}

function makeCategoryManagementBody({ categoryName = 'Original', invalidRename = false } = {}) {
  const body = makeElement('div', { class: 'app-dialog-body project-asset-category-management-dialog-body' });
  const status = makeElement('div', {
    id: 'project-category-management-status',
    'data-category-management-status': '',
  });
  body.appendChild(status);

  const addForm = makeElement('form', {
    id: 'project-category-management-add-form',
    action: '/projects/1/asset-categories',
    method: 'post',
  });
  addForm.appendChild(makeElement('input', { type: 'hidden', name: '_csrf', value: 'csrf-token' }));
  addForm.appendChild(makeElement('input', { name: 'displayName', id: 'add-displayName', value: '' }));
  addForm.appendChild(makeElement('input', { name: 'directorySlug', id: 'add-directorySlug', value: '' }));
  const addSubmit = makeElement('button', { type: 'submit' });
  addForm.appendChild(addSubmit);
  body.appendChild(addForm);

  const list = makeElement('div', { class: 'category-reorder-list', 'data-category-reorder-list': '' });
  const item = makeElement('article', {
    'data-category-reorder-item': '',
    'data-category-id': '1',
    'data-category-label': categoryName,
  });
  item.appendChild(makeElement('button', { type: 'button', 'data-category-reorder-handle': '' }));
  const renameForm = makeElement('form', {
    class: 'category-name-form',
    action: '/projects/1/asset-categories/1/name',
    method: 'post',
  });
  const renameInputAttrs = { name: 'displayName', id: 'name-1', value: categoryName };
  if (invalidRename) renameInputAttrs['aria-invalid'] = 'true';
  renameForm.appendChild(makeElement('input', renameInputAttrs));
  renameForm.appendChild(makeElement('button', { type: 'submit' }));
  item.appendChild(renameForm);
  const deleteForm = makeElement('form', {
    action: '/projects/1/asset-categories/1/delete',
    method: 'post',
    'data-category-management-delete-form': '',
  });
  deleteForm.appendChild(makeElement('button', {
    type: 'submit',
    'data-confirm': 'Delete this category?',
  }));
  item.appendChild(deleteForm);
  list.appendChild(item);
  body.appendChild(list);
  return { body, addSubmit };
}

function makeCategoryDialogPage() {
  const page = makeDialogPage({ standardDropdowns: true });
  const dialogId = 'project-asset-category-management-dialog';
  page.dialog.setAttribute('id', dialogId);
  page.trigger.setAttribute('data-dialog-open', dialogId);
  const card = page.dialog.querySelector('.app-dialog-card');
  const initial = makeCategoryManagementBody();
  card.appendChild(initial.body);

  let replacement = makeCategoryManagementBody({ categoryName: 'Added category' });
  page.windowObject.DOMParser = class DOMParserMock {
    parseFromString() {
      return {
        querySelector: () => replacement.body,
      };
    }
  };

  page.region.appendChild(page.trigger);
  return {
    ...page,
    initial,
    setReplacement(next) { replacement = next; },
  };
}

async function flush() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

describe('Reusable app dialog enhancement', () => {
  it('uses the shared cancellation path for X and Escape, without submitting', () => {
    const page = makeDialogPage();
    page.region.appendChild(page.trigger);
    const submit = vi.fn();
    page.form.addEventListener('submit', submit);

    expect(page.close.getAttribute('type')).toBe('button');
    expect(page.close.getAttribute('form')).toBeNull();

    expect(enhanceAppDialogs(page.document)).toBe(1);
    expect(enhanceAppDialogs(page.document)).toBe(1);
    expect(page.document.listeners.filter(({ type }) => type === 'click')).toHaveLength(1);

    page.document.dispatch('click', { target: page.trigger });
    expect(page.dialog.open).toBe(true);
    expect(page.close.focused).toBe(true);
    const xClick = page.close.dispatch('click');
    expect(xClick.defaultPrevented).toBe(true);
    expect(page.dialog.close).toHaveBeenCalledTimes(1);
    expect(page.dialog.open).toBe(false);
    expect(page.trigger.focused).toBe(true);
    expect(submit).not.toHaveBeenCalled();

    const replacement = makeElement('a', {
      href: '/projects?defaults=1',
      'data-dialog-open': 'projects-defaults-dialog',
    });
    page.trigger.replaceWith(replacement);
    page.document.dispatch('click', { target: replacement });
    expect(page.dialog.open).toBe(true);
    const escape = page.dialog.dispatch('keydown', { key: 'Escape', target: page.dialog });
    expect(escape.defaultPrevented).toBe(true);
    expect(page.dialog.close).toHaveBeenCalledTimes(2);
    expect(page.dialog.open).toBe(false);
    expect(replacement.focused).toBe(true);
    expect(submit).not.toHaveBeenCalled();
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

  it('submits native-backed standard dropdown values and handles Escape inside the dialog', async () => {
    const page = makeDialogPage({ standardDropdowns: true });
    page.region.appendChild(page.trigger);
    page.windowObject.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'success',
        values: { view: 'list', sort: 'title', order: 'asc' },
      }),
    });
    enhanceDropdowns(page.document);
    enhanceAppDialogs(page.document);
    page.document.dispatch('click', { target: page.trigger });

    const viewDropdown = page.dropdowns.view.details;
    viewDropdown.open = true;
    viewDropdown.setAttribute('open', '');
    page.document.dispatch('toggle', { target: viewDropdown });
    expect(page.form.querySelector('.app-dialog-body').classList.contains('cc-dropdown-dialog-open')).toBe(true);

    page.dialog.dispatch('keydown', { key: 'Escape', target: page.dropdowns.view.summary });
    expect(viewDropdown.open).toBe(false);
    expect(page.dialog.open).toBe(true);
    expect(page.dropdowns.view.summary.focused).toBe(true);
    expect(page.form.querySelector('.app-dialog-body').classList.contains('cc-dropdown-dialog-open')).toBe(false);

    const viewRadios = page.dropdowns.view.panel.querySelectorAll('input[type="radio"]');
    const sortRadios = page.dropdowns.sort.panel.querySelectorAll('input[type="radio"]');
    const orderRadios = page.dropdowns.order.panel.querySelectorAll('input[type="radio"]');
    viewRadios[1].checked = true;
    sortRadios[2].checked = true;
    orderRadios[0].checked = true;
    page.document.dispatch('change', { target: viewRadios[1] });
    page.document.dispatch('change', { target: sortRadios[2] });
    page.document.dispatch('change', { target: orderRadios[0] });
    expect(orderRadios.map((radio) => radio.checked)).toEqual([true, false]);
    expect(page.fields.order.value).toBe('asc');

    page.form.dispatch('submit', { submitter: page.save });
    await flush();

    expect([...page.windowObject.fetch.mock.calls[0][1].body.entries()]).toEqual([
      ['_csrf', 'csrf-token'],
      ['view', 'list'],
      ['sort', 'title'],
      ['order', 'asc'],
    ]);
    expect(page.dialog.open).toBe(false);
  });

  it('overlays dropdown panels in the scrollable category dialog without changing its overflow state', () => {
    const page = makeDialogPage({ standardDropdowns: true, scrollableDialog: true });
    page.region.appendChild(page.trigger);
    enhanceDropdowns(page.document);
    enhanceAppDialogs(page.document);
    page.document.dispatch('click', { target: page.trigger });

    const body = page.dialogBody;
    const viewDropdown = page.dropdowns.view.details;
    const panel = page.dropdowns.view.panel;
    viewDropdown.open = true;
    viewDropdown.setAttribute('open', '');
    page.document.dispatch('toggle', { target: viewDropdown });

    expect(body.classList.contains('cc-dropdown-dialog-open')).toBe(false);
    expect(page.dialog.querySelector('.app-dialog-card').classList.contains('cc-dropdown-dialog-open')).toBe(false);
    expect(viewDropdown.open).toBe(true);
    expect(panel.getAttribute('data-cc-dropdown-overlay')).toBe('');
    expect(panel.style.getPropertyValue('position')).toBe('fixed');
    expect(panel.style.getPropertyValue('left')).toBe('100px');
    expect(panel.style.getPropertyValue('top')).toBe('164px');
    expect(body.listeners.filter(({ type }) => type === 'scroll')).toHaveLength(1);

    const [viewGrid, viewList] = panel.querySelectorAll('input[type="radio"]');
    viewGrid.checked = false;
    viewList.checked = true;
    page.document.dispatch('change', { target: viewList });
    expect(page.fields.view.value).toBe('list');
    expect(viewDropdown.open).toBe(false);
    expect(panel.style.getPropertyValue('position')).toBe('');
    expect(page.dropdowns.view.summary.focused).toBe(true);

    viewDropdown.open = true;
    viewDropdown.setAttribute('open', '');
    page.document.dispatch('toggle', { target: viewDropdown });

    page.dropdowns.view.summary.getBoundingClientRect = () => ({
      left: 900,
      top: 700,
      right: 1000,
      bottom: 740,
      width: 100,
      height: 40,
    });
    body.dispatch('scroll');
    expect(panel.style.getPropertyValue('left')).toBe('616px');
    expect(panel.style.getPropertyValue('top')).toBe('516px');

    page.close.dispatch('click');
    expect(page.dialog.open).toBe(false);
    expect(viewDropdown.open).toBe(false);
    expect(panel.getAttribute('data-cc-dropdown-overlay')).toBeNull();
    expect(panel.style.getPropertyValue('position')).toBe('');
    expect(body.listeners.filter(({ type }) => type === 'scroll')).toHaveLength(0);
    expect(page.windowObject.removeEventListener).toHaveBeenCalled();
  });

  it('preserves Edit Project body scroll during Status dropdown interaction', () => {
    const page = makeDialogPage({ standardDropdowns: true, projectEditDialog: true });
    page.region.appendChild(page.trigger);
    enhanceDropdowns(page.document);
    enhanceAppDialogs(page.document);
    page.document.dispatch('click', { target: page.trigger });
    page.dialogBody.scrollTop = 240;

    const statusDropdown = page.dropdowns.view.details;
    statusDropdown.open = true;
    statusDropdown.setAttribute('open', '');
    page.document.dispatch('toggle', { target: statusDropdown });
    expect(page.dialogBody.scrollTop).toBe(240);

    const statusOptions = statusDropdown.querySelectorAll('input[type="radio"]');
    statusOptions[0].checked = false;
    statusOptions[1].checked = true;
    page.document.dispatch('change', { target: statusOptions[1] });
    expect(page.dialogBody.scrollTop).toBe(240);
  });

  it('preserves Edit Project body scroll during Tags dropdown interaction', () => {
    const page = makeDialogPage({ standardDropdowns: true, projectEditDialog: true });
    page.region.appendChild(page.trigger);
    enhanceDropdowns(page.document);
    enhanceAppDialogs(page.document);
    page.document.dispatch('click', { target: page.trigger });
    page.dialogBody.scrollTop = 240;

    const tagsDropdown = page.dropdowns.tags.details;
    tagsDropdown.open = true;
    tagsDropdown.setAttribute('open', '');
    page.document.dispatch('toggle', { target: tagsDropdown });
    expect(page.dialogBody.scrollTop).toBe(240);

    const tagOptions = tagsDropdown.querySelectorAll('input[type="checkbox"]');
    tagOptions[1].checked = true;
    page.document.dispatch('change', { target: tagOptions[1] });
    expect(page.dialogBody.scrollTop).toBe(240);

    const escape = page.dialog.dispatch('keydown', { key: 'Escape', target: tagOptions[1] });
    expect(escape.defaultPrevented).toBe(true);
    expect(page.dialogBody.scrollTop).toBe(240);
  });

  it('persists a project asset browser default immediately, updates visible state, and keeps the dialog open', async () => {
    const page = makeDialogPage({ standardDropdowns: true, liveDefault: true });
    page.region.appendChild(page.trigger);
    page.windowObject.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'success',
        message: 'Project asset default saved.',
        values: { defaultCategory: 'category:1' },
        fallbackExplanation: null,
      }),
    });
    enhanceDropdowns(page.document);
    enhanceAppDialogs(page.document);
    page.document.dispatch('click', { target: page.trigger });

    const categoryRadio = page.dropdowns.defaultCategory.panel.querySelectorAll('input[type="radio"]')[2];
    categoryRadio.checked = true;
    page.document.dispatch('change', { target: categoryRadio });
    await flush();

    expect(page.windowObject.fetch).toHaveBeenCalledTimes(1);
    expect(page.windowObject.fetch.mock.calls[0][0]).toBe('/projects/defaults');
    expect(page.windowObject.fetch.mock.calls[0][1].headers).toEqual({ Accept: 'application/json' });
    expect([...page.windowObject.fetch.mock.calls[0][1].body.entries()]).toContainEqual(['defaultCategory', 'category:1']);
    expect(page.dialog.open).toBe(true);
    expect(page.fields.defaultCategory.value).toBe('category:1');
    expect(page.form.querySelector('[data-asset-browser-default-status]').textContent)
      .toBe('Project asset default saved.');
    expect(page.liveError.hidden).toBe(true);
  });

  it('rolls a failed live project default back to the confirmed value and exposes the error accessibly', async () => {
    const page = makeDialogPage({ standardDropdowns: true, liveDefault: true });
    page.region.appendChild(page.trigger);
    page.windowObject.fetch.mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({
        status: 'error',
        message: 'Project asset browser default could not be saved.',
        errors: { categoryId: 'Disabled categories cannot be selected directly.' },
        values: { defaultCategory: 'category:1' },
      }),
    });
    enhanceDropdowns(page.document);
    enhanceAppDialogs(page.document);
    page.document.dispatch('click', { target: page.trigger });

    const categoryRadio = page.dropdowns.defaultCategory.panel.querySelectorAll('input[type="radio"]')[2];
    categoryRadio.checked = true;
    page.document.dispatch('change', { target: categoryRadio });
    await flush();

    expect(page.dialog.open).toBe(true);
    expect(page.fields.defaultCategory.value).toBe('inherit');
    expect(page.dropdowns.defaultCategory.panel.querySelectorAll('input[type="radio"]')[0].checked).toBe(true);
    expect(page.liveError.hidden).toBe(false);
    expect(page.liveErrorText.textContent).toContain('Disabled categories cannot be selected directly.');
    expect(page.fields.defaultCategory.getAttribute('aria-invalid')).toBe('true');
    expect(page.form.querySelector('[data-asset-browser-default-status]').textContent)
      .toContain('The previous setting was restored.');
  });

  it('keeps the dialog open and preserves submitted values on validation failure', async () => {
    const page = makeDialogPage({ standardDropdowns: true });
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
    const submittedRadio = page.dropdowns.sort.panel.querySelector('input[data-dialog-submitted-value]');
    expect(submittedRadio?.value).toBe('invalid');
    expect(submittedRadio?.checked).toBe(true);
    expect(page.dropdowns.sort.details.querySelector('[data-cc-dropdown-summary-current]').textContent)
      .toBe('Submitted value: invalid');
    expect(page.dropdowns.sort.summary.getAttribute('aria-invalid')).toBe('true');
    expect(page.dropdowns.sort.summary.getAttribute('aria-describedby')).toBe('projects-default-sort-error');
    expect(page.dialog.querySelector('[data-dialog-error]').hidden).toBe(false);
    expect(page.dialog.querySelector('[data-dialog-error-list]').textContent).toContain('Value is not supported.');
  });

  it('cleans temporary submitted options across validation, correction, and reopen', async () => {
    const page = makeDialogPage({ standardDropdowns: true });
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
    expect(page.dropdowns.sort.panel.querySelectorAll('input[data-dialog-submitted-value]')
      .map((input) => input.value)).toEqual(['invalid1']);

    page.form.dispatch('submit', { submitter: page.save });
    await flush();
    expect(page.fields.sort.querySelectorAll('option[data-dialog-submitted-value]')
      .map((option) => option.value)).toEqual(['invalid2']);
    expect(page.dropdowns.sort.panel.querySelectorAll('input[data-dialog-submitted-value]')
      .map((input) => input.value)).toEqual(['invalid2']);

    page.fields.sort.value = 'title';
    page.form.dispatch('submit', { submitter: page.save });
    await flush();
    expect(page.dialog.open).toBe(false);

    page.document.dispatch('click', { target: page.trigger });
    expect(page.fields.sort.value).toBe('title');
    expect(page.fields.sort.querySelectorAll('option[data-dialog-submitted-value]')).toHaveLength(0);
    expect(page.fields.sort.querySelectorAll('option').map((option) => option.value))
      .toEqual(['updated', 'created', 'title', 'published']);
    expect(page.dropdowns.sort.panel.querySelectorAll('input[data-dialog-submitted-value]')).toHaveLength(0);
    expect(page.dropdowns.sort.details.querySelector('[data-cc-dropdown-summary-current]').textContent)
      .toBe('title');
    expect(page.fields.sort.getAttribute('aria-invalid')).toBeNull();
    expect(page.dropdowns.sort.summary.getAttribute('aria-invalid')).toBeNull();
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

describe('Live project category mutations', () => {
  it('replaces server-rendered add state, keeps the dialog open, and remains idempotent', async () => {
    const page = makeCategoryDialogPage();
    page.windowObject.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'success',
        message: 'Category added.',
        focus: 'add-displayName',
        html: '<server-rendered-category-management-body>',
      }),
    });

    enhanceAppDialogs(page.document);
    page.document.dispatch('click', { target: page.trigger });
    enhanceConfirmations(page.document);
    enhanceCategoryReorder(page.document);
    enhanceProjectAssetCategoryManagement(page.document);
    expect(page.dialog.open).toBe(true);
    const addForm = page.initial.body.querySelector('#project-category-management-add-form');
    addForm.dispatch('submit', { submitter: page.initial.addSubmit });
    await flush();

    expect(page.windowObject.fetch).toHaveBeenCalledTimes(1);
    expect(page.windowObject.fetch.mock.calls[0][1].headers).toEqual({ Accept: 'application/json' });
    expect([...page.windowObject.fetch.mock.calls[0][1].body.entries()]).toContainEqual(['_csrf', 'csrf-token']);
    expect(page.dialog.open).toBe(true);
    expect(page.dialog.querySelector('[data-category-label="Added category"]')).toBeTruthy();
    expect(page.dialog.querySelector('[data-category-management-status]').textContent).toBe('Category added.');
    expect(page.document.activeElement?.id).toBe('add-displayName');

    enhanceProjectAssetCategoryManagement(page.document);
    const replacementAddForm = page.dialog.querySelector('#project-category-management-add-form');
    expect(replacementAddForm.listeners.filter(({ type }) => type === 'submit')).toHaveLength(1);
  });

  it('preserves inline rename errors and does not bypass delete confirmation', async () => {
    const page = makeCategoryDialogPage();
    page.setReplacement(makeCategoryManagementBody({ categoryName: 'Submitted name', invalidRename: true }));
    page.windowObject.fetch.mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({
        status: 'error',
        message: 'Could not update the display name. Fix the field below and try again.',
        errors: { displayName: 'Display name is required.' },
        focus: 'name-1',
        html: '<server-rendered-rename-error>',
      }),
    });

    vi.stubGlobal('confirm', vi.fn(() => false));
    enhanceAppDialogs(page.document);
    page.document.dispatch('click', { target: page.trigger });
    enhanceConfirmations(page.document);
    enhanceProjectAssetCategoryManagement(page.document);
    expect(page.dialog.open).toBe(true);
    const renameForm = page.initial.body.querySelector('.category-name-form');
    renameForm.dispatch('submit', { submitter: renameForm.querySelector('button') });
    await flush();

    expect(page.dialog.open).toBe(true);
    expect(page.dialog.querySelector('[data-category-management-status]').getAttribute('role')).toBe('alert');
    expect(page.document.activeElement?.id).toBe('name-1');

    const deleteButton = page.initial.body.querySelector('[data-confirm]');
    const click = deleteButton.dispatch('click');
    expect(click.defaultPrevented).toBe(true);
    expect(page.windowObject.fetch).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
