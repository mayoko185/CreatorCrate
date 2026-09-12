import { describe, it, expect, vi } from 'vitest';
import {
  closeAppDialogById,
  enhanceAppDialogs,
  directorySlugFromDisplayName,
  enhanceCategoryReorder,
  enhanceCategorySlugAutofill,
  enhanceConfirmations,
  enhanceDashboardDefaultsDialog,
  enhanceDropdowns,
  enhanceProjectAssetCategoryManagement,
  enhanceProjectAssetsDefaultsFetchSave,
  enhanceProjectAssetsDefaultsScope,
  enhanceProjectsDefaultsFetchSave,
  enhanceReleasesDefaultsFetchSave,
  openAppDialogById,
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
        if (candidate.includes(':not([type="hidden"])') && this.type === 'hidden') return false;
        const tag = candidate.match(/^[a-z][\w-]*/i)?.[0];
        if (tag && this.tagName !== tag.toUpperCase()) return false;
        const classMatch = candidate.match(/\.([\w-]+)/);
        if (classMatch && !this.classList.contains(classMatch[1])) return false;
        const attributeCandidate = candidate.replace(':not([type="hidden"])', '');
        return [...attributeCandidate.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)].every(([, name, expected]) => {
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

function addOption(select, value, selected = false, label = value) {
  const option = makeElement('option', { value });
  option.textContent = label;
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
    const optionValue = typeof option === 'string' ? option : option.value;
    const optionLabel = typeof option === 'string'
      ? ({ compact: 'Compact', default: 'Default', large: 'Large' }[option] || option)
      : option.label;
    const wrapper = makeElement('div', { class: 'asset-filter-multiselect-option' });
    const label = makeElement('label');
    const input = makeElement('input', {
      type: mode === 'single' ? 'radio' : 'checkbox',
      value: optionValue,
    });
    input.checked = mode === 'multiple' ? selectedValues.includes(optionValue) : optionValue === value;
    label.appendChild(input);
    const optionText = makeElement('span');
    optionText.textContent = optionLabel;
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

function appendStyledOption(panel, value, label) {
  const wrapper = makeElement('div', { class: 'asset-filter-multiselect-option' });
  const labelNode = makeElement('label');
  const input = makeElement('input', { type: 'radio', value });
  const text = makeElement('span');
  text.textContent = label;
  labelNode.appendChild(input);
  labelNode.appendChild(text);
  wrapper.appendChild(labelNode);
  panel.appendChild(wrapper);
  return input;
}

function styledDropdownValues(dropdown) {
  return dropdown.panel.querySelectorAll('input[type="radio"]')
    .map((input) => String(input.value));
}

function styledDropdownLabels(dropdown) {
  return dropdown.panel.querySelectorAll('input[type="radio"]')
    .map((input) => String(input.closest('label')?.textContent || '').trim());
}

const PROJECT_ASSETS_DEFAULT_KEYS = [
  'view', 'gridSize', 'listSize', 'sort', 'order', 'pageSize', 'extension', 'tag',
];

function projectAssetsDefaultValues(fields) {
  return Object.fromEntries(PROJECT_ASSETS_DEFAULT_KEYS.map((key) => [key, fields[key].value]));
}

function setProjectAssetsDefaultValues(fields, values) {
  PROJECT_ASSETS_DEFAULT_KEYS.forEach((key) => {
    fields[key].value = values[key];
  });
}

function changeProjectAssetsScope(page, scope) {
  page.scopeControls.global.checked = scope === 'global';
  page.scopeControls.project.checked = scope === 'project';
  page.scopeControls[scope].dispatch('change');
}

function projectAssetsDefaultsHtml(values, activeScope = 'global') {
  return `<form id="project-assets-defaults-form"><input name="loadedScope" value="${activeScope}"><script type="application/json" data-project-assets-default-values>${JSON.stringify(values)}</script></form>`;
}

function installProjectAssetsResponseParser(page) {
  page.windowObject.DOMParser = class DOMParserMock {
    parseFromString(html) {
      const match = String(html).match(
        /<script type="application\/json" data-project-assets-default-values>([\s\S]*?)<\/script>/,
      );
      const script = match
        ? Object.assign(makeElement('script', {
          type: 'application/json',
          'data-project-assets-default-values': '',
        }), { textContent: match[1] })
        : null;
      const scope = String(html).match(/<input name="loadedScope" value="([^"]*)">/);
      const form = {
        querySelector: (selector) => {
          if (selector === 'input[name="loadedScope"]') return scope ? { value: scope[1] } : null;
          if (selector === 'script[type="application/json"][data-project-assets-default-values]') return script;
          return null;
        },
      };
      return {
        querySelector: (selector) => (
          selector === '#project-assets-defaults-form'
            ? form
            : null
        ),
      };
    }
  };
}

function makeDialogPage({
  standardDropdowns = false,
  scrollableDialog = false,
  projectEditDialog = false,
  liveDefault = false,
  projectAssetsDefaults = false,
  projectAssetsScope = false,
  projectAssetsScopeValues = null,
  loadedScope = 'global',
  dialogMessages = null,
  projectsDefaultsAutosave = false,
  projectAssetsDefaultsAutosave = false,
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
  const dialogId = projectAssetsDefaults ? 'project-assets-defaults-dialog' : 'projects-defaults-dialog';
  const formId = projectAssetsDefaults ? 'project-assets-defaults-form' : 'projects-defaults-form';
  const formAction = projectAssetsDefaults ? '/projects/1/assets/defaults' : '/projects/defaults';
  const trigger = makeElement('a', {
    href: '/projects?defaults=1',
    'data-dialog-open': dialogId,
  });
  const dialog = makeElement('dialog', {
    id: dialogId,
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
    id: formId,
    action: formAction,
    method: 'post',
    'data-dialog-form': '',
  });
  if (projectsDefaultsAutosave) {
    form.setAttribute('data-dialog-async', 'false');
    form.setAttribute('data-projects-defaults-autosave', '');
  }
  if (projectAssetsDefaultsAutosave) {
    form.setAttribute('data-dialog-async', 'false');
    form.setAttribute('data-project-assets-defaults-autosave', '');
  }
  if (dialogMessages) {
    Object.entries(dialogMessages).forEach(([name, value]) => {
      form.setAttribute(name, value);
    });
  }
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
  let scopeControls = null;
  if (projectAssetsScope) {
    const scope = makeElement('fieldset', { 'data-project-assets-defaults-scope': '' });
    const global = makeElement('input', { type: 'radio', name: 'scope', value: 'global' });
    const project = makeElement('input', { type: 'radio', name: 'scope', value: 'project' });
    global.checked = loadedScope !== 'project';
    project.checked = loadedScope === 'project';
    scope.appendChild(global);
    scope.appendChild(project);
    form.appendChild(makeElement('input', { type: 'hidden', name: 'loadedScope', value: loadedScope }));
    form.appendChild(scope);
    scopeControls = { scope, global, project };
  }
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
  const defaultFields = projectAssetsDefaults
    ? (projectAssetsScope ? [
      ['view', 'grid', ['grid', 'list']],
      ['gridSize', 'default', ['compact', 'default', 'large']],
      ['listSize', 'large', ['compact', 'large']],
      ['sort', 'filename', ['filename', 'modified', 'size', 'category']],
      ['order', 'asc', ['asc', 'desc']],
      ['pageSize', '25', ['10', '25', '50', '100']],
      ['extension', 'jpg', [{ value: 'jpg', label: '.JPG' }, { value: 'png', label: '.PNG' }]],
      ['tag', '1', [{ value: '1', label: 'Landscape' }, { value: '2', label: 'Portrait' }]],
    ] : [
      ['view', 'grid', ['grid', 'list']],
      ['gridSize', 'default', ['compact', 'default', 'large']],
      ['listSize', 'large', ['compact', 'large']],
      ['sort', 'filename', ['filename', 'modified', 'size', 'category']],
      ['order', 'asc', ['asc', 'desc']],
    ])
    : (projectsDefaultsAutosave ? [
      ['view', 'grid', ['grid', 'list']],
      ['sort', 'created', ['updated', 'created', 'title']],
      ['order', 'desc', ['asc', 'desc']],
      ['status', 'all', ['all', 'planned', 'ready']],
      ['projectType', 'all', ['all', 'images', 'comic']],
      ['tag', 'all', ['all', '1', '2']],
    ] : [
      ['view', 'grid', ['grid', 'list']],
      ['sort', 'created', ['updated', 'created', 'title', 'published']],
      ['order', 'desc', ['asc', 'desc']],
    ]);
  for (const [name, value, options] of defaultFields) {
    const field = makeElement('div', { 'data-dialog-field': name });
    const select = makeElement('select', { id: `projects-default-${name}`, name });
    options.forEach((option) => {
      const optionValue = typeof option === 'string' ? option : option.value;
      addOption(select, optionValue, optionValue === value, typeof option === 'string' ? option : option.label);
    });
    select.value = value;
    if (projectsDefaultsAutosave || projectAssetsDefaultsAutosave) {
      select.setAttribute('data-autosubmit', 'fetch');
      select.form = form;
    }
    if (standardDropdowns) {
      dropdowns[name] = addStandardDropdown(
        field,
        select,
        name,
        options,
        value,
        projectsDefaultsAutosave || projectAssetsDefaultsAutosave,
      );
    }
    else field.appendChild(select);
    (dialogBody || form).appendChild(field);
    fields[name] = select;
  }
  if (projectAssetsScope) {
    const values = projectAssetsScopeValues || {
      global: { view: 'grid', gridSize: 'default', listSize: 'large', sort: 'filename', order: 'asc', pageSize: '25', extension: 'jpg', tag: '1' },
      project: { view: 'list', gridSize: 'large', listSize: 'compact', sort: 'category', order: 'desc', pageSize: '50', extension: 'png', tag: '2' },
    };
    const serializedValues = makeElement('script', { type: 'application/json', 'data-project-assets-default-values': '' });
    serializedValues.textContent = JSON.stringify(values);
    form.appendChild(serializedValues);
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
  if (projectsDefaultsAutosave || projectAssetsDefaultsAutosave) {
    status.setAttribute('data-settings-fetch-save-status', '');
  }
  if (liveDefault) status.setAttribute('data-asset-browser-default-status', '');
  const save = liveDefault || projectsDefaultsAutosave || projectAssetsDefaultsAutosave
    ? null
    : makeElement('button', { 'data-dialog-submit': '', type: 'submit' });
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
          .filter((control) => control.name && !control.disabled
            && (!['radio', 'checkbox'].includes(control.type) || control.checked))
          .map((control) => [control.name, control.value]);
      }
      *entries() { yield* this.fields; }
      [Symbol.iterator]() { return this.entries(); }
    },
    URLSearchParams,
    Event: class EventMock {
      constructor(type, properties = {}) { Object.assign(this, properties, { type }); }
    },
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
    status,
    save,
    fields,
    dropdowns,
    scopeControls,
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
    'data-category-slug-autofill-form': '',
  });
  addForm.appendChild(makeElement('input', { type: 'hidden', name: '_csrf', value: 'csrf-token' }));
  addForm.appendChild(makeElement('input', {
    name: 'displayName',
    id: 'add-displayName',
    value: '',
    'data-category-slug-autofill-display-name': '',
  }));
  addForm.appendChild(makeElement('input', {
    name: 'directorySlug',
    id: 'add-directorySlug',
    value: '',
    'data-category-slug-autofill-directory-slug': '',
  }));
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

function attachSharedConfirmationDialog(page) {
  const dialog = makeElement('dialog', { id: 'app-confirmation-dialog', 'data-app-dialog': '' });
  const title = makeElement('h2', { id: 'app-confirmation-dialog-title' });
  const message = makeElement('p', { 'data-app-dialog-confirmation-message': '' });
  const cancel = makeElement('button', { type: 'button', 'data-dialog-close': '', 'data-app-dialog-confirmation-cancel': '' });
  const confirm = makeElement('button', { type: 'button', 'data-app-dialog-confirmation-confirm': '' });
  dialog.showModal = vi.fn(() => { dialog.open = true; dialog.setAttribute('open', ''); });
  dialog.close = vi.fn(() => { dialog.open = false; dialog.removeAttribute('open'); dialog.dispatch('close'); });
  dialog.appendChild(title);
  dialog.appendChild(message);
  dialog.appendChild(cancel);
  dialog.appendChild(confirm);
  page.document.body.appendChild(dialog);
  return { dialog, message, cancel, confirm };
}

function makeDashboardDefaultsDialogPage({ includeStatusSection = false } = {}) {
  const page = makeDialogPage();
  page.dialog.setAttribute('id', 'dashboard-defaults-dialog');
  page.trigger.setAttribute('data-dialog-open', 'dashboard-defaults-dialog');
  page.form.setAttribute('id', 'dashboard-defaults-form');
  page.form.setAttribute('action', '/dashboard/defaults');
  page.form.setAttribute('data-dashboard-defaults-reorder-form', '');

  const orderInput = makeElement('input', {
    type: 'hidden',
    name: 'orderedSectionIds',
    value: 'overdue,upcoming,recently-updated',
    'data-dashboard-defaults-order-input': '',
  });
  const list = makeElement('ol', {
    'data-dashboard-defaults-reorder-list': '',
    'data-reorder-form-target': 'dashboard-defaults-form',
  });
  const detachListItem = (child) => {
    const currentParent = child.parentNode;
    const currentIndex = currentParent?.children?.indexOf(child) ?? -1;
    if (currentIndex >= 0) currentParent.children.splice(currentIndex, 1);
    child.parentNode = list;
    child.parentElement = list;
    child.ownerDocument = list.ownerDocument;
  };
  list.appendChild = (child) => {
    detachListItem(child);
    list.children.push(child);
    return child;
  };
  list.insertBefore = (child, reference) => {
    detachListItem(child);
    const index = list.children.indexOf(reference);
    list.children.splice(index < 0 ? list.children.length : index, 0, child);
    return child;
  };
  const sections = {};
  const dashboardSections = [
    ['overdue', 'Overdue', true, '8'],
    ['upcoming', 'Upcoming releases', true, '10'],
    ['recently-updated', 'Recently updated', false, '12'],
  ];
  if (includeStatusSection) dashboardSections.push(['status:ready', 'Ready', true, '6']);
  dashboardSections.forEach(([id, label, visible, count]) => {
    const row = makeElement('li', {
      'data-dashboard-defaults-reorder-item': '',
      'data-dashboard-section-id': id,
      'data-dashboard-section-label': label,
    });
    Object.defineProperty(row, 'nextSibling', {
      get() {
        return list.children[list.children.indexOf(row) + 1] || null;
      },
    });
    row.getBoundingClientRect = () => ({ top: 0, height: 20 });
    const handle = makeElement('button', {
      type: 'button',
      'data-dashboard-defaults-reorder-handle': '',
    });
    const body = makeElement('div');
    const title = makeElement('span', { textContent: label });
    const sortOptions = makeElement('div');
    const sortControl = makeElement('button', {
      type: 'button',
      'data-dashboard-defaults-sort-options-trigger': '',
      'data-dialog-open': 'dashboard-defaults-sort-dialog',
      'aria-label': `Sort options for ${label}`,
    });
    const sortInput = makeElement('input', {
      type: 'hidden', name: `sections[${id}][sort]`, value: id === 'overdue' ? 'planned' : 'updated',
      'data-dashboard-defaults-sort-input': '',
    });
    const orderInput = makeElement('input', {
      type: 'hidden', name: `sections[${id}][order]`, value: id === 'overdue' ? 'asc' : 'desc',
      'data-dashboard-defaults-section-order-input': '',
    });
    const visibleField = makeElement('div', { 'data-dialog-field': `sections[${id}][visible]` });
    const hiddenVisible = makeElement('input', {
      type: 'hidden', name: `sections[${id}][visible]`, value: '0',
    });
    const visibleControl = makeElement('input', {
      id: `dashboard-defaults-section-${id}-visible`,
      type: 'checkbox', name: `sections[${id}][visible]`, value: '1',
    });
    visibleControl.checked = visible;
    visibleField.appendChild(hiddenVisible);
    visibleField.appendChild(visibleControl);
    const countField = makeElement('div', { 'data-dialog-field': `sections[${id}][itemCount]` });
    const countControl = makeElement('input', {
      type: 'number', name: `sections[${id}][itemCount]`, value: count,
    });
    countField.appendChild(countControl);
    sortOptions.appendChild(sortInput);
    sortOptions.appendChild(orderInput);
    sortOptions.appendChild(sortControl);
    body.appendChild(title);
    body.appendChild(sortOptions);
    body.appendChild(visibleField);
    body.appendChild(countField);
    row.appendChild(handle);
    row.appendChild(body);
    list.appendChild(row);
    sections[id] = {
      row, handle, body, title, sortOptions, sortControl, sortInput, orderInput,
      visibleField, visibleControl, countField, countControl,
    };
  });
  orderInput.value = dashboardSections.map(([id]) => id).join(',');
  const live = makeElement('div', { 'data-dashboard-defaults-reorder-live': '' });
  page.form.appendChild(orderInput);
  page.form.appendChild(list);
  page.form.appendChild(live);

  const sortDialog = makeElement('dialog', {
    id: 'dashboard-defaults-sort-dialog',
    'data-app-dialog': '',
  });
  sortDialog.showModal = vi.fn(() => {
    sortDialog.open = true;
    sortDialog.setAttribute('open', '');
  });
  sortDialog.close = vi.fn(() => {
    sortDialog.open = false;
    sortDialog.removeAttribute('open');
    sortDialog.dispatch('close');
  });
  const sortCard = makeElement('div');
  const sortClose = makeElement('button', { type: 'button', 'data-dialog-close': '' });
  const sectionLabel = makeElement('strong', { 'data-dashboard-defaults-sort-section-label': '' });
  const sortSelect = makeElement('select', { id: 'dashboard-defaults-sort-select' });
  ['updated', 'created', 'title', 'published', 'planned'].forEach((value) => addOption(sortSelect, value, value === 'updated'));
  sortSelect.value = 'updated';
  const orderSelect = makeElement('select', { id: 'dashboard-defaults-order-select' });
  ['asc', 'desc'].forEach((value) => addOption(orderSelect, value, value === 'asc'));
  orderSelect.value = 'asc';
  const apply = makeElement('button', { type: 'button', 'data-dashboard-defaults-sort-apply': '' });
  sortCard.appendChild(sortClose);
  sortCard.appendChild(sectionLabel);
  sortCard.appendChild(sortSelect);
  sortCard.appendChild(orderSelect);
  sortCard.appendChild(apply);
  sortDialog.appendChild(sortCard);
  page.document.body.appendChild(sortDialog);

  return {
    ...page, list, orderInput, live, sections,
    sortDialog, sortClose, sectionLabel, sortSelect, orderSelect, apply,
  };
}

function dashboardSectionOrder(page) {
  return page.list.querySelectorAll('[data-dashboard-defaults-reorder-item]')
    .map((item) => item.getAttribute('data-dashboard-section-id'));
}

function enhanceDashboardDefaults(page) {
  enhanceAppDialogs(page.document);
  enhanceDashboardDefaultsDialog(page.document);
}

function dragDashboardSection(page, source, target) {
  const transfer = { setData: vi.fn() };
  source.row.dispatch('dragstart', { target: source.title, dataTransfer: transfer });
  page.list.dispatch('dragover', { target: target.row, clientY: 0, dataTransfer: {} });
  page.list.dispatch('drop', { target: target.row });
}

async function flush() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

describe('Reusable app dialog enhancement', () => {
  it.each([
    ['Projects', 'project-create-dialog', '/projects/new', '/projects?search=needle&sort=title&order=asc&page=3#projects-list'],
    ['Releases', 'release-create-dialog', '/releases/new', '/releases?project=7&sort=created&order=desc&page=2#releases-list'],
  ])('captures the exact live %s list URL in its hosted create form', (_label, dialogId, href, invocationLocation) => {
    const page = makeDialogPage();
    page.dialog.setAttribute('id', dialogId);
    const invocation = makeElement('a', {
      href,
      'data-dialog-open': dialogId,
      'data-dialog-invocation': '',
    });
    const returnTo = makeElement('input', { type: 'hidden', name: 'returnTo', value: invocationLocation.split('?')[0] });
    page.form.appendChild(returnTo);
    page.region.appendChild(invocation);
    const currentUrl = new URL(invocationLocation, 'http://creatorcrate.local');
    page.windowObject.location = {
      href: currentUrl.href,
      origin: currentUrl.origin,
      pathname: currentUrl.pathname,
      search: currentUrl.search,
      hash: currentUrl.hash,
      assign: vi.fn(),
    };

    enhanceAppDialogs(page.document);
    page.document.dispatch('click', { target: invocation });

    expect(returnTo.value).toBe(invocationLocation);
    expect(invocation.getAttribute('href')).toBe(href);
  });

  it('captures the exact live Project Assets URL in the selected-assets release POST form', () => {
    const page = makeDialogPage();
    const selectionForm = makeElement('form', {
      method: 'post',
      action: '/projects/7/assets/add-to-release',
    });
    const returnTo = makeElement('input', { type: 'hidden', name: 'returnTo', value: '' });
    const invocation = makeElement('button', {
      type: 'submit',
      formaction: '/projects/7/assets/create-release',
      'data-dialog-invocation': '',
    });
    selectionForm.appendChild(returnTo);
    selectionForm.appendChild(invocation);
    page.region.appendChild(selectionForm);
    page.windowObject.location = {
      href: 'http://creatorcrate.local/projects/7/assets?view=list&page=3&filter=present#asset-42',
      origin: 'http://creatorcrate.local',
      pathname: '/projects/7/assets',
      search: '?view=list&page=3&filter=present',
      hash: '#asset-42',
      assign: vi.fn(),
    };

    enhanceAppDialogs(page.document);
    page.document.dispatch('click', { target: invocation });

    expect(returnTo.value).toBe('/projects/7/assets?view=list&page=3&filter=present#asset-42');
    expect(invocation.getAttribute('formaction')).toBe('/projects/7/assets/create-release');
  });

  it('captures the exact live Books-list URL for a Book edit invocation', () => {
    const page = makeDialogPage();
    const invocation = makeElement('a', {
      href: '/notes/books/17/edit',
      'data-dialog-invocation': '',
    });
    page.region.appendChild(invocation);
    page.windowObject.location = {
      href: 'http://creatorcrate.local/notes?sort=title&page=3&filter=active#book-17',
      origin: 'http://creatorcrate.local',
      pathname: '/notes',
      search: '?sort=title&page=3&filter=active',
      hash: '#book-17',
      assign: vi.fn(),
    };

    enhanceAppDialogs(page.document);
    page.document.dispatch('click', { target: invocation });

    const target = new URL(invocation.getAttribute('href'), page.windowObject.location.origin);
    expect(target.pathname).toBe('/notes/books/17/edit');
    expect(target.searchParams.get('returnTo')).toBe('/notes?sort=title&page=3&filter=active#book-17');
  });

  it('captures the exact live Calendar URL for a Release edit invocation', () => {
    const page = makeDialogPage();
    const invocation = makeElement('a', {
      href: '/releases/19/edit',
      'data-dialog-invocation': '',
    });
    page.region.appendChild(invocation);
    page.windowObject.location = {
      href: 'http://creatorcrate.local/calendar?month=2026-07&filter=planned#release-19',
      origin: 'http://creatorcrate.local',
      pathname: '/calendar',
      search: '?month=2026-07&filter=planned',
      hash: '#release-19',
      assign: vi.fn(),
    };

    enhanceAppDialogs(page.document);
    page.document.dispatch('click', { target: invocation });

    const target = new URL(invocation.getAttribute('href'), page.windowObject.location.origin);
    expect(target.pathname).toBe('/releases/19/edit');
    expect(target.searchParams.get('returnTo')).toBe('/calendar?month=2026-07&filter=planned#release-19');
  });

  it('captures the live invoking path, query, and fragment without duplicating return metadata', () => {
    const page = makeDialogPage();
    const invocation = makeElement('a', {
      href: '/projects/7/edit',
      'data-dialog-invocation': '',
    });
    page.region.appendChild(invocation);
    page.windowObject.location = {
      href: 'http://creatorcrate.local/projects/7/assets?view=list&page=3#asset-42',
      origin: 'http://creatorcrate.local',
      pathname: '/projects/7/assets',
      search: '?view=list&page=3',
      hash: '#asset-42',
      assign: vi.fn(),
    };

    enhanceAppDialogs(page.document);
    enhanceAppDialogs(page.document);
    page.document.dispatch('click', { target: invocation });
    const replacement = makeElement('a', {
      href: invocation.getAttribute('href'),
      'data-dialog-invocation': '',
    });
    invocation.replaceWith(replacement);
    enhanceAppDialogs(page.document);
    page.document.dispatch('click', { target: replacement });
    page.document.dispatch('click', { target: replacement });

    const target = new URL(replacement.getAttribute('href'), page.windowObject.location.origin);
    expect(target.pathname).toBe('/projects/7/edit');
    expect(target.searchParams.getAll('returnTo')).toEqual([
      '/projects/7/assets?view=list&page=3#asset-42',
    ]);
    expect(page.document.listeners.filter(({ type }) => type === 'click')).toHaveLength(1);
  });

  it.each(['X', 'Escape', 'native cancel', 'backdrop', 'programmatic'])('%s returns a hosted dialog to its validated invocation location', (path) => {
    const page = makeDialogPage();
    const returnTo = makeElement('input', {
      type: 'hidden',
      name: 'returnTo',
      value: '/projects/7/assets?view=list&page=3#asset-42',
      'data-dialog-return-location': '',
    });
    page.form.appendChild(returnTo);
    const assign = vi.fn();
    page.windowObject.location = {
      href: 'http://creatorcrate.local/projects/7?edit=1',
      origin: 'http://creatorcrate.local',
      pathname: '/projects/7',
      search: '?edit=1',
      hash: '',
      assign,
    };

    enhanceAppDialogs(page.document);
    openAppDialogById(page.document, page.dialog.id, page.trigger);
    if (path === 'X') page.close.dispatch('click');
    else if (path === 'Escape') page.dialog.dispatch('keydown', { key: 'Escape', target: page.dialog });
    else if (path === 'native cancel') page.dialog.dispatch('cancel', { target: page.dialog });
    else if (path === 'backdrop') page.dialog.dispatch('click', { target: page.dialog });
    else closeAppDialogById(page.document, page.dialog.id);

    expect(page.dialog.open).toBe(false);
    expect(assign).toHaveBeenCalledOnce();
    expect(assign).toHaveBeenCalledWith('/projects/7/assets?view=list&page=3#asset-42');
  });

  it.each([
    ['Projects', '/projects?search=needle&sort=title&order=asc&page=3#projects-list'],
    ['Releases', '/releases?project=7&sort=created&order=desc&page=2#releases-list'],
  ])('returns a rerendered %s create dialog to its exact invoking list URL on accepted cancel', (_label, returnLocation) => {
    const page = makeDialogPage();
    page.form.appendChild(makeElement('input', {
      type: 'hidden',
      name: 'returnTo',
      value: returnLocation,
      'data-dialog-return-location': '',
    }));
    const assign = vi.fn();
    page.windowObject.location = {
      href: 'http://creatorcrate.local/projects',
      origin: 'http://creatorcrate.local',
      pathname: '/projects',
      search: '',
      hash: '',
      assign,
    };

    enhanceAppDialogs(page.document);
    openAppDialogById(page.document, page.dialog.id, page.trigger);
    page.close.dispatch('click');

    expect(assign).toHaveBeenCalledOnce();
    expect(assign).toHaveBeenCalledWith(returnLocation);
  });

  it('does not navigate when a hosted dialog close guard rejects cancellation', () => {
    const page = makeDialogPage();
    page.form.appendChild(makeElement('input', {
      type: 'hidden',
      name: 'returnTo',
      value: '/projects/7/assets?view=list',
      'data-dialog-return-location': '',
    }));
    const assign = vi.fn();
    page.windowObject.location = {
      href: 'http://creatorcrate.local/projects/7?edit=1',
      origin: 'http://creatorcrate.local',
      pathname: '/projects/7',
      search: '?edit=1',
      hash: '',
      assign,
    };

    enhanceAppDialogs(page.document);
    openAppDialogById(page.document, page.dialog.id, page.trigger);
    page.dialog.__creatorCrateAppDialogState.beforeClose = vi.fn(() => false);
    page.close.dispatch('click');

    expect(page.dialog.open).toBe(true);
    expect(assign).not.toHaveBeenCalled();
  });

  it('does not turn an unrelated native close lifecycle into return navigation', () => {
    const page = makeDialogPage();
    page.form.appendChild(makeElement('input', {
      type: 'hidden',
      name: 'returnTo',
      value: '/projects/7/assets?view=list',
      'data-dialog-return-location': '',
    }));
    const assign = vi.fn();
    page.windowObject.location = {
      href: 'http://creatorcrate.local/projects/7?edit=1',
      origin: 'http://creatorcrate.local',
      pathname: '/projects/7',
      search: '?edit=1',
      hash: '',
      assign,
    };

    enhanceAppDialogs(page.document);
    openAppDialogById(page.document, page.dialog.id, page.trigger);
    page.dialog.close();

    expect(page.dialog.open).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });

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

  it.each(['X', 'Escape', 'native cancel', 'backdrop', 'programmatic'])('%s uses one async pre-close guard and ignores repeated dismissal', async (path) => {
    const page = makeDialogPage();
    page.region.appendChild(page.trigger);
    enhanceAppDialogs(page.document);
    openAppDialogById(page.document, page.dialog.id, page.trigger);
    let resolveGuard;
    const beforeClose = vi.fn(() => new Promise(resolve => { resolveGuard = resolve; }));
    page.dialog.__creatorCrateAppDialogState.beforeClose = beforeClose;

    const dismiss = () => {
      if (path === 'X') page.close.dispatch('click');
      else if (path === 'Escape') page.dialog.dispatch('keydown', { key: 'Escape', target: page.dialog });
      else if (path === 'native cancel') page.dialog.dispatch('cancel', { target: page.dialog });
      else if (path === 'backdrop') page.dialog.dispatch('click', { target: page.dialog });
      else closeAppDialogById(page.document, page.dialog.id);
    };
    dismiss();
    dismiss();

    expect(beforeClose).toHaveBeenCalledOnce();
    expect(page.dialog.open).toBe(true);
    resolveGuard(true);
    await flush();
    expect(page.dialog.close).toHaveBeenCalledOnce();
    expect(page.dialog.open).toBe(false);
  });

  it('does not let an earlier pre-close result close a reopened dialog lifecycle', async () => {
    const page = makeDialogPage();
    page.region.appendChild(page.trigger);
    enhanceAppDialogs(page.document);
    openAppDialogById(page.document, page.dialog.id, page.trigger);
    let resolveGuard;
    page.dialog.__creatorCrateAppDialogState.beforeClose = () => new Promise(resolve => { resolveGuard = resolve; });

    page.close.dispatch('click');
    openAppDialogById(page.document, page.dialog.id, page.trigger);
    const closesBeforeResolution = page.dialog.close.mock.calls.length;
    resolveGuard(true);
    await flush();

    expect(page.dialog.close).toHaveBeenCalledTimes(closesBeforeResolution);
    expect(page.dialog.open).toBe(true);
  });

  it('opens an enhanced dialog by ID and restores its explicit opener', () => {
    const page = makeDialogPage();
    const explicitOpener = makeElement('button', { type: 'button' });
    page.region.appendChild(page.trigger);
    page.region.appendChild(explicitOpener);

    enhanceAppDialogs(page.document);

    expect(openAppDialogById(page.document, page.dialog.id, explicitOpener)).toBe(true);
    expect(page.dialog.open).toBe(true);
    expect(page.dialog.__creatorCrateAppDialogState.opener).toBe(explicitOpener);
    expect(page.dialog.__creatorCrateAppDialogState.openerAllowsFallback).toBe(false);

    expect(closeAppDialogById(page.document, page.dialog.id)).toBe(true);
    expect(explicitOpener.focused).toBe(true);
  });

  it('does not use a declarative opener fallback for programmatic opening', () => {
    const page = makeDialogPage();
    page.region.appendChild(page.trigger);

    enhanceAppDialogs(page.document);

    expect(openAppDialogById(page.document, page.dialog.id)).toBe(true);
    expect(closeAppDialogById(page.document, page.dialog.id)).toBe(true);
    expect(page.trigger.focused).not.toBe(true);
  });

  it('fails safely for missing or unenhanced dialogs', () => {
    const page = makeDialogPage();
    const unenhancedDialog = makeElement('dialog', {
      id: 'unenhanced-dialog',
      'data-app-dialog': '',
    });
    page.document.body.appendChild(unenhancedDialog);

    expect(openAppDialogById(page.document, 'missing-dialog')).toBe(false);
    expect(closeAppDialogById(page.document, 'missing-dialog')).toBe(false);
    expect(openAppDialogById(page.document, 'unenhanced-dialog')).toBe(false);
    expect(closeAppDialogById(page.document, 'unenhanced-dialog')).toBe(false);
  });

  it('keeps a static-backdrop dialog open until X or Escape is used', () => {
    const page = makeDialogPage();
    page.dialog.setAttribute('data-dialog-backdrop-static', '');
    page.region.appendChild(page.trigger);

    enhanceAppDialogs(page.document);
    page.document.dispatch('click', { target: page.trigger });
    const backdropClick = page.dialog.dispatch('click', { target: page.dialog });

    expect(backdropClick.defaultPrevented).toBe(true);
    expect(page.dialog.open).toBe(true);
    expect(page.dialog.close).not.toHaveBeenCalled();

    page.close.dispatch('click');
    expect(page.dialog.open).toBe(false);
  });

  it('binds scope switching only for Project Assets defaults and preserves initial rendered values', () => {
    const otherDialog = makeDialogPage({ standardDropdowns: true });
    expect(enhanceProjectAssetsDefaultsScope(otherDialog.document)).toBe(0);

    const page = makeDialogPage({ standardDropdowns: true, projectAssetsDefaults: true, projectAssetsScope: true });
    enhanceDropdowns(page.document);
    const initial = projectAssetsDefaultValues(page.fields);

    expect(enhanceProjectAssetsDefaultsScope(page.document)).toBe(1);
    expect(enhanceProjectAssetsDefaultsScope(page.document)).toBe(0);
    expect(projectAssetsDefaultValues(page.fields)).toEqual(initial);
    expect(page.form.querySelector('input[name="loadedScope"]').value).toBe('global');
    expect(page.scopeControls.global.checked).toBe(true);
    expect(page.scopeControls.project.checked).toBe(false);
  });

  it('atomically synchronizes all Project Assets defaults through native selects and dropdowns', () => {
    const page = makeDialogPage({
      standardDropdowns: true,
      projectAssetsDefaults: true,
      projectAssetsScope: true,
      projectAssetsScopeValues: {
        global: { view: 'grid', gridSize: 'default', listSize: 'large', gridDetails: 'shown', sort: 'filename', order: 'asc', pageSize: '25', extension: 'jpg', tag: '1' },
        project: { view: 'list', gridSize: 'large', listSize: 'compact', gridDetails: 'hidden', sort: 'category', order: 'desc', pageSize: '50', extension: 'png', tag: '2' },
      },
    });
    enhanceDropdowns(page.document);
    enhanceProjectAssetsDefaultsScope(page.document);

    const scopeError = makeElement('span', { class: 'field-error-message' });
    page.scopeControls.scope.appendChild(scopeError);
    page.scopeControls.global.setAttribute('aria-invalid', 'true');
    page.form.querySelector('[data-dialog-error]').hidden = false;
    page.form.querySelector('[data-dialog-error-text]').textContent = 'The selected scope does not match the loaded scope.';

    changeProjectAssetsScope(page, 'project');

    expect(projectAssetsDefaultValues(page.fields)).toEqual({
      view: 'list', gridSize: 'large', listSize: 'compact', sort: 'category', order: 'desc',
      pageSize: '50', extension: 'png', tag: '2',
    });
    expect(page.form.querySelector('input[name="loadedScope"]').value).toBe('project');
    expect(page.scopeControls.project.checked).toBe(true);
    expect(page.scopeControls.global.checked).toBe(false);
    expect(page.dropdowns.extension.panel.querySelector('input[type="radio"]:checked').value).toBe('png');
    expect(page.dropdowns.tag.panel.querySelector('input[type="radio"]:checked').value).toBe('2');
    expect(page.dropdowns.extension.summary.querySelector('[data-cc-dropdown-summary-current]').textContent).toBe('.PNG');
    expect(page.dropdowns.tag.summary.querySelector('[data-cc-dropdown-summary-current]').textContent).toBe('Portrait');
    expect(page.scopeControls.scope.querySelector('.field-error-message')).toBe(null);
    expect(page.scopeControls.global.getAttribute('aria-invalid')).toBe(null);
    expect(page.form.querySelector('[data-dialog-error]').hidden).toBe(true);
    expect(page.windowObject.fetch).not.toHaveBeenCalled();
  });

  it('keeps separate unsaved drafts for Global and Project only, including HTTP 422 rendered values', () => {
    const page = makeDialogPage({ standardDropdowns: true, projectAssetsDefaults: true, projectAssetsScope: true });
    enhanceDropdowns(page.document);
    enhanceProjectAssetsDefaultsScope(page.document);

    page.fields.view.value = 'list';
    page.fields.view.dispatch('change');
    page.fields.extension.value = 'png';
    page.fields.extension.dispatch('change');
    changeProjectAssetsScope(page, 'project');

    page.fields.sort.value = 'modified';
    page.fields.sort.dispatch('change');
    page.fields.tag.value = '1';
    page.fields.tag.dispatch('change');
    changeProjectAssetsScope(page, 'global');
    expect(projectAssetsDefaultValues(page.fields)).toMatchObject({ view: 'list', extension: 'png' });

    changeProjectAssetsScope(page, 'project');
    expect(projectAssetsDefaultValues(page.fields)).toMatchObject({ sort: 'modified', tag: '1' });

    const failedPage = makeDialogPage({ standardDropdowns: true, projectAssetsDefaults: true, projectAssetsScope: true });
    failedPage.fields.view.value = 'list';
    failedPage.fields.extension.value = 'png';
    enhanceDropdowns(failedPage.document);
    enhanceProjectAssetsDefaultsScope(failedPage.document);
    changeProjectAssetsScope(failedPage, 'project');
    changeProjectAssetsScope(failedPage, 'global');
    expect(projectAssetsDefaultValues(failedPage.fields)).toMatchObject({ view: 'list', extension: 'png' });
    expect(failedPage.windowObject.fetch).not.toHaveBeenCalled();
  });

  it('commits a successful Project-only JSON save without promoting an unsaved Global draft', async () => {
    const page = makeDialogPage({ standardDropdowns: true, projectAssetsDefaults: true, projectAssetsScope: true });
    const initial = JSON.parse(page.form.querySelector('[data-project-assets-default-values]').textContent);
    const submitted = {
      view: 'grid', gridSize: 'compact', listSize: 'large', sort: 'modified', order: 'asc',
      pageSize: '100', extension: 'jpg', tag: '1',
    };
    page.region.appendChild(page.trigger);
    page.windowObject.fetch.mockImplementation(() => {
      setProjectAssetsDefaultValues(page.fields, initial.project);
      return Promise.resolve({
        ok: true,
        json: async () => ({ status: 'success', values: submitted }),
      });
    });
    enhanceDropdowns(page.document);
    enhanceProjectAssetsDefaultsScope(page.document);
    enhanceAppDialogs(page.document);
    page.document.dispatch('click', { target: page.trigger });

    setProjectAssetsDefaultValues(page.fields, {
      ...initial.global, view: 'list', extension: 'png',
    });
    changeProjectAssetsScope(page, 'project');
    setProjectAssetsDefaultValues(page.fields, submitted);
    const scopeError = makeElement('span', { class: 'field-error-message' });
    page.scopeControls.scope.appendChild(scopeError);
    page.scopeControls.project.setAttribute('aria-invalid', 'true');
    page.form.querySelector('[data-dialog-error]').hidden = false;
    page.form.querySelector('[data-dialog-error-text]').textContent = 'The selected scope does not match the loaded scope.';
    page.form.dispatch('submit', { submitter: page.save });
    await flush();

    expect(page.dialog.open).toBe(false);
    expect(Object.fromEntries(
      [...page.windowObject.fetch.mock.calls[0][1].body.entries()]
        .filter(([key]) => PROJECT_ASSETS_DEFAULT_KEYS.includes(key)),
    )).toEqual(submitted);
    expect(page.form.querySelector('input[name="loadedScope"]').value).toBe('project');
    expect(page.scopeControls.project.checked).toBe(true);
    expect(page.form.querySelector('[data-dialog-error]').hidden).toBe(true);
    expect(JSON.parse(page.form.querySelector('[data-project-assets-default-values]').textContent)).toEqual({
      global: initial.global,
      project: submitted,
    });
    expect(enhanceProjectAssetsDefaultsScope(page.document)).toBe(0);

    page.document.dispatch('click', { target: page.trigger });
    expect(projectAssetsDefaultValues(page.fields)).toEqual(submitted);
    changeProjectAssetsScope(page, 'global');
    expect(projectAssetsDefaultValues(page.fields)).toEqual(initial.global);

    closeAppDialogById(page.document, page.dialog.id);
    page.document.dispatch('click', { target: page.trigger });
    expect(page.scopeControls.project.checked).toBe(true);
    expect(page.form.querySelector('input[name="loadedScope"]').value).toBe('project');
    expect(projectAssetsDefaultValues(page.fields)).toEqual(submitted);
  });

  it('commits a successful Global JSON save without replacing Project-only committed values', async () => {
    const initialValues = {
      global: { view: 'grid', gridSize: 'default', listSize: 'large', sort: 'filename', order: 'asc', pageSize: '25', extension: 'jpg', tag: '1' },
      project: { view: 'list', gridSize: 'large', listSize: 'compact', sort: 'category', order: 'desc', pageSize: '50', extension: 'png', tag: '2' },
    };
    const page = makeDialogPage({
      standardDropdowns: true,
      projectAssetsDefaults: true,
      projectAssetsScope: true,
      projectAssetsScopeValues: initialValues,
    });
    const submitted = {
      view: 'list', gridSize: 'compact', listSize: 'large', sort: 'modified', order: 'asc',
      pageSize: '100', extension: 'jpg', tag: '1',
    };
    expect(submitted).not.toEqual(initialValues.global);
    expect(submitted).not.toEqual(initialValues.project);
    page.region.appendChild(page.trigger);
    page.windowObject.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'success', values: submitted }),
    });
    enhanceDropdowns(page.document);
    enhanceProjectAssetsDefaultsScope(page.document);
    enhanceAppDialogs(page.document);
    page.document.dispatch('click', { target: page.trigger });

    changeProjectAssetsScope(page, 'project');
    page.fields.sort.value = 'modified';
    page.fields.sort.dispatch('change');
    changeProjectAssetsScope(page, 'global');
    setProjectAssetsDefaultValues(page.fields, submitted);
    page.form.dispatch('submit', { submitter: page.save });
    await flush();

    expect(page.form.querySelector('input[name="loadedScope"]').value).toBe('global');
    expect(page.scopeControls.global.checked).toBe(true);
    expect(JSON.parse(page.form.querySelector('[data-project-assets-default-values]').textContent)).toEqual({
      global: submitted,
      project: initialValues.project,
    });

    page.document.dispatch('click', { target: page.trigger });
    expect(projectAssetsDefaultValues(page.fields)).toEqual(submitted);
    changeProjectAssetsScope(page, 'project');
    expect(projectAssetsDefaultValues(page.fields)).toEqual(initialValues.project);

    page.fields.sort.value = 'filename';
    page.fields.sort.dispatch('change');
    closeAppDialogById(page.document, page.dialog.id);
    page.document.dispatch('click', { target: page.trigger });
    expect(page.scopeControls.global.checked).toBe(true);
    expect(page.form.querySelector('input[name="loadedScope"]').value).toBe('global');
    expect(projectAssetsDefaultValues(page.fields)).toEqual(submitted);
  });

  it('restores Global committed values, radio state, and both drafts after cancel/reopen', () => {
    const page = makeDialogPage({ standardDropdowns: true, projectAssetsDefaults: true, projectAssetsScope: true });
    const initial = JSON.parse(page.form.querySelector('[data-project-assets-default-values]').textContent);
    page.region.appendChild(page.trigger);
    enhanceDropdowns(page.document);
    enhanceProjectAssetsDefaultsScope(page.document);
    enhanceAppDialogs(page.document);
    page.document.dispatch('click', { target: page.trigger });

    setProjectAssetsDefaultValues(page.fields, { ...initial.global, view: 'list', sort: 'size' });
    page.fields.view.dispatch('change');
    page.fields.sort.dispatch('change');
    changeProjectAssetsScope(page, 'project');
    setProjectAssetsDefaultValues(page.fields, { ...initial.project, sort: 'modified', tag: '1' });
    page.fields.sort.dispatch('change');
    page.fields.tag.dispatch('change');

    closeAppDialogById(page.document, page.dialog.id);
    page.document.dispatch('click', { target: page.trigger });

    expect(page.scopeControls.global.checked).toBe(true);
    expect(page.scopeControls.project.checked).toBe(false);
    expect(page.form.querySelector('input[name="loadedScope"]').value).toBe('global');
    expect(projectAssetsDefaultValues(page.fields)).toEqual(initial.global);
    changeProjectAssetsScope(page, 'project');
    expect(projectAssetsDefaultValues(page.fields)).toEqual(initial.project);
  });

  it('restores Project-only committed values after cancel/reopen and immediately saves with matching scope', async () => {
    const initialValues = {
      global: { view: 'grid', gridSize: 'default', listSize: 'large', sort: 'filename', order: 'asc', pageSize: '25', extension: 'jpg', tag: '1' },
      project: { view: 'list', gridSize: 'large', listSize: 'compact', sort: 'category', order: 'desc', pageSize: '50', extension: 'png', tag: '2' },
    };
    const page = makeDialogPage({
      standardDropdowns: true,
      projectAssetsDefaults: true,
      projectAssetsScope: true,
      projectAssetsScopeValues: initialValues,
      loadedScope: 'project',
    });
    setProjectAssetsDefaultValues(page.fields, initialValues.project);
    page.region.appendChild(page.trigger);
    page.windowObject.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'success', values: initialValues.project }),
    });
    enhanceDropdowns(page.document);
    enhanceProjectAssetsDefaultsScope(page.document);
    enhanceAppDialogs(page.document);
    page.document.dispatch('click', { target: page.trigger });

    setProjectAssetsDefaultValues(page.fields, { ...initialValues.project, sort: 'modified', tag: '1' });
    page.fields.sort.dispatch('change');
    page.fields.tag.dispatch('change');
    changeProjectAssetsScope(page, 'global');
    page.fields.view.value = 'list';
    page.fields.view.dispatch('change');

    closeAppDialogById(page.document, page.dialog.id);
    page.document.dispatch('click', { target: page.trigger });

    expect(page.scopeControls.project.checked).toBe(true);
    expect(page.scopeControls.global.checked).toBe(false);
    expect(page.form.querySelector('input[name="loadedScope"]').value).toBe('project');
    expect(projectAssetsDefaultValues(page.fields)).toEqual(initialValues.project);

    page.form.dispatch('submit', { submitter: page.save });
    await flush();

    expect(page.windowObject.fetch).toHaveBeenCalledTimes(1);
    expect(page.dialog.open).toBe(false);
    expect(page.form.querySelector('input[name="loadedScope"]').value).toBe('project');
    expect(page.scopeControls.project.checked).toBe(true);
  });

  it('keeps Project Assets committed snapshots and drafts after failed or malformed enhanced saves', async () => {
    const initialValues = {
      global: { view: 'grid', gridSize: 'default', listSize: 'large', sort: 'filename', order: 'asc', pageSize: '25', extension: 'jpg', tag: '1' },
      project: { view: 'list', gridSize: 'large', listSize: 'compact', sort: 'category', order: 'desc', pageSize: '50', extension: 'png', tag: '2' },
    };
    const responses = [
      {
        ok: false,
        json: async () => ({
          status: 'error',
          values: { ...initialValues.project, sort: 'modified' },
        }),
      },
      new Error('network unavailable'),
      { ok: true, json: async () => ({ status: 'success', values: { view: 'grid' } }) },
    ];

    for (const response of responses) {
      const page = makeDialogPage({
        standardDropdowns: true,
        projectAssetsDefaults: true,
        projectAssetsScope: true,
        projectAssetsScopeValues: initialValues,
      });
      page.region.appendChild(page.trigger);
      page.windowObject.fetch.mockImplementationOnce(() => (
        response instanceof Error ? Promise.reject(response) : Promise.resolve(response)
      ));
      enhanceDropdowns(page.document);
      enhanceProjectAssetsDefaultsScope(page.document);
      enhanceAppDialogs(page.document);
      page.document.dispatch('click', { target: page.trigger });
      changeProjectAssetsScope(page, 'project');
      page.fields.sort.value = 'modified';
      page.fields.sort.dispatch('change');
      page.form.dispatch('submit', { submitter: page.save });
      await flush();

      expect(JSON.parse(page.form.querySelector('[data-project-assets-default-values]').textContent))
        .toEqual(initialValues);
      changeProjectAssetsScope(page, 'global');
      expect(projectAssetsDefaultValues(page.fields)).toEqual(initialValues.global);
      changeProjectAssetsScope(page, 'project');
      expect(projectAssetsDefaultValues(page.fields)).toMatchObject({ sort: 'modified' });
    }
  });

  it('fails closed for malformed or unrepresentable Project Assets scope values', () => {
    const malformed = makeDialogPage({ standardDropdowns: true, projectAssetsDefaults: true, projectAssetsScope: true });
    malformed.form.querySelector('script[type="application/json"][data-project-assets-default-values]').textContent = '{';
    const malformedInitial = projectAssetsDefaultValues(malformed.fields);
    expect(enhanceProjectAssetsDefaultsScope(malformed.document)).toBe(0);
    changeProjectAssetsScope(malformed, 'project');
    expect(projectAssetsDefaultValues(malformed.fields)).toEqual(malformedInitial);
    expect(malformed.form.querySelector('input[name="loadedScope"]').value).toBe('global');

    const values = {
      global: { view: 'grid', gridSize: 'default', listSize: 'large', sort: 'filename', order: 'asc', pageSize: '25', extension: 'jpg', tag: '1' },
      project: { view: 'list', gridSize: 'large', listSize: 'compact', sort: 'category', order: 'desc', pageSize: '50', extension: 'gif', tag: '2' },
    };
    const invalidTarget = makeDialogPage({
      standardDropdowns: true,
      projectAssetsDefaults: true,
      projectAssetsScope: true,
      projectAssetsScopeValues: values,
    });
    enhanceDropdowns(invalidTarget.document);
    enhanceProjectAssetsDefaultsScope(invalidTarget.document);
    const initial = projectAssetsDefaultValues(invalidTarget.fields);
    changeProjectAssetsScope(invalidTarget, 'project');

    expect(projectAssetsDefaultValues(invalidTarget.fields)).toEqual(initial);
    expect(invalidTarget.form.querySelector('input[name="loadedScope"]').value).toBe('global');
    expect(invalidTarget.scopeControls.global.checked).toBe(true);
    expect(invalidTarget.scopeControls.project.checked).toBe(false);
    expect(invalidTarget.form.querySelector('[data-dialog-error]').hidden).toBe(false);
  });

  it('cancels Project Assets defaults without submitting or changing size storage', () => {
    const page = makeDialogPage({ standardDropdowns: true, projectAssetsDefaults: true });
    const storage = new Map([
      ['creatorcrate-asset-grid-size', 'compact'],
      ['creatorcrate-asset-list-size', 'large'],
    ]);
    const previousStorage = globalThis.localStorage;
    globalThis.localStorage = {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    };

    try {
      page.region.appendChild(page.trigger);
      enhanceDropdowns(page.document);
      enhanceAppDialogs(page.document);
      page.document.dispatch('click', { target: page.trigger });

      page.fields.gridSize.value = 'large';
      page.fields.listSize.value = 'compact';
      page.close.dispatch('click');
      expect(page.windowObject.fetch).not.toHaveBeenCalled();
      expect(storage.get('creatorcrate-asset-grid-size')).toBe('compact');
      expect(storage.get('creatorcrate-asset-list-size')).toBe('large');

      page.document.dispatch('click', { target: page.trigger });
      expect(page.fields.gridSize.value).toBe('default');
      expect(page.fields.listSize.value).toBe('large');

      page.fields.gridSize.value = 'large';
      page.fields.listSize.value = 'compact';
      page.dropdowns.gridSize.details.open = true;
      page.dropdowns.gridSize.details.setAttribute('open', '');
      page.dialog.dispatch('keydown', { key: 'Escape', target: page.dropdowns.gridSize.summary });
      expect(page.dropdowns.gridSize.details.open).toBe(false);
      expect(page.dialog.open).toBe(true);

      page.dialog.dispatch('keydown', { key: 'Escape', target: page.dialog });
      expect(page.dialog.open).toBe(false);
      expect(page.windowObject.fetch).not.toHaveBeenCalled();
      expect(storage.get('creatorcrate-asset-grid-size')).toBe('compact');
      expect(storage.get('creatorcrate-asset-list-size')).toBe('large');

      page.document.dispatch('click', { target: page.trigger });
      expect(page.fields.gridSize.value).toBe('default');
      expect(page.fields.listSize.value).toBe('large');
    } finally {
      if (previousStorage === undefined) delete globalThis.localStorage;
      else globalThis.localStorage = previousStorage;
    }
  });

  it('keeps enhanced Project Assets Grid and List size options isolated across View switches and reopen', async () => {
    const page = makeDialogPage({ standardDropdowns: true, projectAssetsDefaults: true });
    appendStyledOption(page.dropdowns.listSize.panel, 'default', 'Default');
    page.region.appendChild(page.trigger);
    page.windowObject.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'success',
        values: {
          view: 'list',
          gridSize: 'large',
          listSize: 'compact',
          sort: 'category',
          order: 'desc',
        },
      }),
    });

    enhanceDropdowns(page.document);
    expect(styledDropdownValues(page.dropdowns.gridSize)).toEqual(['compact', 'default', 'large']);
    expect(styledDropdownValues(page.dropdowns.listSize)).toEqual(['compact', 'large']);
    expect(styledDropdownLabels(page.dropdowns.gridSize)).toEqual(['Compact', 'Default', 'Large']);
    expect(styledDropdownLabels(page.dropdowns.listSize)).toEqual(['Compact', 'Large']);

    enhanceAppDialogs(page.document);
    page.document.dispatch('click', { target: page.trigger });
    const viewRadios = page.dropdowns.view.panel.querySelectorAll('input[type="radio"]');
    viewRadios[1].checked = true;
    page.document.dispatch('change', { target: viewRadios[1] });
    expect(styledDropdownValues(page.dropdowns.listSize)).toEqual(['compact', 'large']);
    expect(styledDropdownLabels(page.dropdowns.listSize)).toEqual(['Compact', 'Large']);
    expect(styledDropdownValues(page.dropdowns.listSize)).not.toContain('default');

    viewRadios[0].checked = true;
    page.document.dispatch('change', { target: viewRadios[0] });
    expect(styledDropdownValues(page.dropdowns.gridSize)).toEqual(['compact', 'default', 'large']);
    expect(styledDropdownLabels(page.dropdowns.gridSize)).toEqual(['Compact', 'Default', 'Large']);
    viewRadios[1].checked = true;
    page.document.dispatch('change', { target: viewRadios[1] });
    expect(styledDropdownValues(page.dropdowns.listSize)).toEqual(['compact', 'large']);
    expect(styledDropdownLabels(page.dropdowns.listSize)).toEqual(['Compact', 'Large']);

    page.close.dispatch('click');
    appendStyledOption(page.dropdowns.listSize.panel, 'default', 'Default');
    page.document.dispatch('click', { target: page.trigger });
    expect(styledDropdownValues(page.dropdowns.gridSize)).toEqual(['compact', 'default', 'large']);
    expect(styledDropdownValues(page.dropdowns.listSize)).toEqual(['compact', 'large']);
    expect(styledDropdownLabels(page.dropdowns.gridSize)).toEqual(['Compact', 'Default', 'Large']);
    expect(styledDropdownLabels(page.dropdowns.listSize)).toEqual(['Compact', 'Large']);
    viewRadios[1].checked = true;
    page.document.dispatch('change', { target: viewRadios[1] });

    page.fields.gridSize.value = 'large';
    page.fields.listSize.value = 'compact';
    page.form.dispatch('submit', { submitter: page.save });
    await flush();

    expect([...page.windowObject.fetch.mock.calls[0][1].body.entries()]).toEqual([
      ['_csrf', 'csrf-token'],
      ['view', 'list'],
      ['gridSize', 'large'],
      ['listSize', 'compact'],
      ['sort', 'filename'],
      ['order', 'asc'],
    ]);
    expect(page.windowObject.fetch.mock.calls[0][1].body.toString()).not.toContain('listSize=default');
  });

  it('does not expose an invalid List Default option during enhanced validation recovery', async () => {
    const page = makeDialogPage({ standardDropdowns: true, projectAssetsDefaults: true });
    page.region.appendChild(page.trigger);
    page.windowObject.fetch.mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({
        status: 'error',
        errors: { listSize: 'Value is not supported.' },
        values: {
          view: 'list',
          gridSize: 'large',
          listSize: 'default',
          sort: 'filename',
          order: 'asc',
        },
      }),
    });

    enhanceDropdowns(page.document);
    enhanceAppDialogs(page.document);
    page.document.dispatch('click', { target: page.trigger });
    page.form.dispatch('submit', { submitter: page.save });
    await flush();

    expect(page.dialog.open).toBe(true);
    expect(styledDropdownValues(page.dropdowns.gridSize)).toEqual(['compact', 'default', 'large']);
    expect(styledDropdownValues(page.dropdowns.listSize)).toEqual(['compact', 'large']);
    expect(styledDropdownLabels(page.dropdowns.gridSize)).toEqual(['Compact', 'Default', 'Large']);
    expect(styledDropdownLabels(page.dropdowns.listSize)).toEqual(['Compact', 'Large']);
    expect(styledDropdownValues(page.dropdowns.listSize)).not.toContain('default');
    expect(page.fields.listSize.querySelectorAll('option').map((option) => option.value))
      .toEqual(['compact', 'large']);
  });

  it('synchronizes Project Assets size storage only after a successful defaults save', async () => {
    const page = makeDialogPage({ standardDropdowns: true, projectAssetsDefaults: true });
    const storage = new Map([
      ['creatorcrate-asset-grid-size', 'compact'],
      ['creatorcrate-asset-list-size', 'large'],
    ]);
    const previousStorage = globalThis.localStorage;
    globalThis.localStorage = {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    };
    page.region.appendChild(page.trigger);
    page.windowObject.fetch
      .mockResolvedValueOnce({
        ok: false,
        status: 422,
        json: async () => ({
          status: 'error',
          errors: { sort: 'Value is not supported.' },
          values: {
            view: 'grid',
            gridSize: 'large',
            listSize: 'compact',
            sort: 'invalid',
            order: 'asc',
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'success',
          values: {
            view: 'list',
            gridSize: 'large',
            listSize: 'compact',
            sort: 'category',
            order: 'desc',
            pageSize: '50',
          },
        }),
      });

    try {
      enhanceDropdowns(page.document);
      enhanceAppDialogs(page.document);
      page.document.dispatch('click', { target: page.trigger });
      page.fields.gridSize.value = 'large';
      page.fields.listSize.value = 'compact';
      page.form.dispatch('submit', { submitter: page.save });
      await flush();

      expect(storage.get('creatorcrate-asset-grid-size')).toBe('compact');
      expect(storage.get('creatorcrate-asset-list-size')).toBe('large');
      expect(page.dialog.open).toBe(true);

      page.form.dispatch('submit', { submitter: page.save });
      await flush();

      expect(storage.get('creatorcrate-asset-grid-size')).toBe('large');
      expect(storage.get('creatorcrate-asset-list-size')).toBe('compact');
      expect(page.dialog.open).toBe(false);

      page.document.dispatch('click', { target: page.trigger });
      expect(page.fields.gridSize.value).toBe('large');
      expect(page.fields.listSize.value).toBe('compact');
      page.fields.gridSize.value = 'compact';
      page.fields.listSize.value = 'large';
      page.close.dispatch('click');
      page.document.dispatch('click', { target: page.trigger });
      expect(page.fields.gridSize.value).toBe('large');
      expect(page.fields.listSize.value).toBe('compact');
    } finally {
      if (previousStorage === undefined) delete globalThis.localStorage;
      else globalThis.localStorage = previousStorage;
    }
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
    const beforeClose = vi.fn(() => false);
    page.dialog.__creatorCrateAppDialogState.beforeClose = beforeClose;
    viewDropdown.open = true;
    viewDropdown.setAttribute('open', '');
    page.document.dispatch('toggle', { target: viewDropdown });
    expect(page.form.querySelector('.app-dialog-body').classList.contains('cc-dropdown-dialog-open')).toBe(true);

    page.dialog.dispatch('keydown', { key: 'Escape', target: page.dropdowns.view.summary });
    expect(viewDropdown.open).toBe(false);
    expect(page.dialog.open).toBe(true);
    expect(beforeClose).not.toHaveBeenCalled();
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
    let rejectRequest;
    page.windowObject.fetch.mockImplementation(() => new Promise((resolve, reject) => {
      rejectRequest = reject;
    }));
    enhanceAppDialogs(page.document);
    page.document.dispatch('click', { target: page.trigger });
    page.form.dispatch('submit', { submitter: page.save });
    await flush();

    expect(page.dialog.querySelector('[data-dialog-status]').textContent).toBe('Saving defaults.');
    rejectRequest(new Error('network down'));
    await flush();

    expect(page.dialog.open).toBe(true);
    expect(page.dialog.querySelector('[data-dialog-status]').textContent).toContain('Could not save defaults');
    expect(page.dialog.querySelector('[data-dialog-error-text]').textContent).toContain('Your selections were kept');
  });

  it('uses configured operation messages without invoking a failed dialog success hook', async () => {
    const page = makeDialogPage({
      dialogMessages: {
        'data-dialog-pending-message': 'Clearing logs…',
        'data-dialog-error-message': 'Logs could not be cleared.',
        'data-dialog-network-error-message': 'Could not clear logs.',
      },
    });
    page.region.appendChild(page.trigger);
    let resolveRequest;
    page.windowObject.fetch.mockImplementation(() => new Promise((resolve) => {
      resolveRequest = resolve;
    }));
    enhanceAppDialogs(page.document);
    const successHook = vi.fn();
    page.dialog.__creatorCrateAppDialogState.onSuccessfulSubmit = successHook;
    page.document.dispatch('click', { target: page.trigger });
    page.form.dispatch('submit', { submitter: page.save });
    await flush();

    expect(page.dialog.querySelector('[data-dialog-status]').textContent).toBe('Clearing logs…');

    resolveRequest({
      ok: false,
      status: 500,
      json: async () => ({ status: 'error' }),
    });
    await flush();

    expect(page.dialog.open).toBe(true);
    expect(page.dialog.querySelector('[data-dialog-status]').textContent).toBe('Logs could not be cleared.');
    expect(page.dialog.querySelector('[data-dialog-error-text]').textContent).toBe('Logs could not be cleared.');
    expect(successHook).not.toHaveBeenCalled();
  });

  it('uses the configured network failure message without invoking a failed dialog success hook', async () => {
    const page = makeDialogPage({
      dialogMessages: {
        'data-dialog-pending-message': 'Clearing logs…',
        'data-dialog-error-message': 'Logs could not be cleared.',
        'data-dialog-network-error-message': 'Could not clear logs.',
      },
    });
    page.region.appendChild(page.trigger);
    page.windowObject.fetch.mockRejectedValue(new Error('network down'));
    enhanceAppDialogs(page.document);
    const successHook = vi.fn();
    page.dialog.__creatorCrateAppDialogState.onSuccessfulSubmit = successHook;
    page.document.dispatch('click', { target: page.trigger });
    page.form.dispatch('submit', { submitter: page.save });
    await flush();

    expect(page.dialog.open).toBe(true);
    expect(page.dialog.querySelector('[data-dialog-status]').textContent).toBe('Could not clear logs.');
    expect(page.dialog.querySelector('[data-dialog-error-text]').textContent).toContain('Logs could not be cleared.');
    expect(successHook).not.toHaveBeenCalled();
  });

  it('uses the configured success feedback without changing the generic lifecycle', async () => {
    const page = makeDialogPage({
      dialogMessages: {
        'data-dialog-success-message': 'Logs cleared.',
      },
    });
    page.region.appendChild(page.trigger);
    page.windowObject.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'success' }),
    });
    enhanceAppDialogs(page.document);
    const successHook = vi.fn();
    page.dialog.__creatorCrateAppDialogState.onSuccessfulSubmit = successHook;
    page.document.dispatch('click', { target: page.trigger });
    page.form.dispatch('submit', { submitter: page.save });
    await flush();

    expect(successHook).toHaveBeenCalledOnce();
    expect(page.dialog.open).toBe(false);
    expect(page.document.querySelector('[data-dialog-feedback-text]').textContent).toBe('Logs cleared.');
  });
});

describe('Projects defaults autosave enhancement', () => {
  function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  }

  function response({
    ok = true,
    redirected = true,
    html = '',
    url = 'http://creatorcrate.test/projects?sort=created&order=desc&view=grid&notice=projects_defaults_saved',
  } = {}) {
    return { ok, redirected, url, text: async () => html };
  }

  function installFetchGlobals(page, fetch) {
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('FormData', page.windowObject.FormData);
    vi.stubGlobal('URLSearchParams', URLSearchParams);
  }

  function enhanceAutosavePage(page, options = {}) {
    page.region.appendChild(page.trigger);
    enhanceDropdowns(page.document);
    enhanceAppDialogs(page.document);
    page.projectsDefaultsRefreshOptions = {
      beginRefresh: vi.fn(() => 0),
      refresh: vi.fn(() => 'started'),
      ...options,
    };
    return enhanceProjectsDefaultsFetchSave(page.document, page.projectsDefaultsRefreshOptions);
  }

  function enhanceProjectAssetsAutosavePage(page, options = {}) {
    page.region.appendChild(page.trigger);
    installProjectAssetsResponseParser(page);
    enhanceDropdowns(page.document);
    enhanceProjectAssetsDefaultsScope(page.document);
    enhanceAppDialogs(page.document);
    page.projectAssetsDefaultsRefreshOptions = {
      beginRefresh: vi.fn(() => 17),
      refresh: vi.fn(() => 'started'),
      ...options,
    };
    return enhanceProjectAssetsDefaultsFetchSave(
      page.document,
      page.projectAssetsDefaultsRefreshOptions,
    );
  }

  it('saves a Project-only scope switch once after hydrating its complete paired snapshot', async () => {
    const page = makeDialogPage({
      standardDropdowns: true,
      projectAssetsDefaults: true,
      projectAssetsScope: true,
      projectAssetsDefaultsAutosave: true,
    });
    const destination = 'http://creatorcrate.test/projects/1/assets?view=list&notice=project_assets_defaults_saved';
    const snapshots = JSON.parse(page.form.querySelector('[data-project-assets-default-values]').textContent);
    const fetch = vi.fn().mockResolvedValue(response({
      url: destination,
      html: projectAssetsDefaultsHtml(snapshots, 'project'),
    }));
    installFetchGlobals(page, fetch);

    try {
      expect(enhanceProjectAssetsAutosavePage(page)).toBe(8);
      expect(enhanceProjectAssetsDefaultsFetchSave(
        page.document,
        page.projectAssetsDefaultsRefreshOptions,
      )).toBe(0);
      page.document.dispatch('click', { target: page.trigger });
      await flush();

      changeProjectAssetsScope(page, 'project');
      await flush();

      expect(fetch).toHaveBeenCalledOnce();
      expect(Object.fromEntries(fetch.mock.calls[0][1].body.entries())).toEqual({
        _csrf: 'csrf-token',
        scope: 'project',
        loadedScope: 'project',
        view: 'list',
        gridSize: 'large',
        listSize: 'compact',
        sort: 'category',
        order: 'desc',
        pageSize: '50',
        extension: 'png',
        tag: '2',
      });
      expect(page.projectAssetsDefaultsRefreshOptions.beginRefresh).toHaveBeenCalledOnce();
      expect(page.projectAssetsDefaultsRefreshOptions.refresh).toHaveBeenCalledWith(
        page.document,
        destination,
        17,
        { onError: expect.any(Function) },
      );
      expect(page.dialog.open).toBe(true);
      expect(page.form.getAttribute('data-settings-fetch-save-state')).toBe('saved');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('saves a Global scope switch once after hydrating its complete paired snapshot', async () => {
    const values = {
      global: { view: 'grid', gridSize: 'default', listSize: 'large', sort: 'filename', order: 'asc', pageSize: '25', extension: 'jpg', tag: '1' },
      project: { view: 'list', gridSize: 'large', listSize: 'compact', sort: 'category', order: 'desc', pageSize: '50', extension: 'png', tag: '2' },
    };
    const page = makeDialogPage({
      standardDropdowns: true,
      projectAssetsDefaults: true,
      projectAssetsScope: true,
      projectAssetsScopeValues: values,
      loadedScope: 'project',
      projectAssetsDefaultsAutosave: true,
    });
    setProjectAssetsDefaultValues(page.fields, values.project);
    const authoritative = {
      global: { ...values.global, sort: 'modified' },
      project: { ...values.project, sort: 'modified' },
    };
    const destination = 'http://creatorcrate.test/projects/1/assets?view=grid&sort=modified&notice=project_assets_defaults_saved';
    const fetch = vi.fn().mockImplementation((_url, { body }) => Promise.resolve(response({
      url: destination,
      html: projectAssetsDefaultsHtml(authoritative, body.get('scope')),
    })));
    installFetchGlobals(page, fetch);

    try {
      enhanceProjectAssetsAutosavePage(page);
      page.document.dispatch('click', { target: page.trigger });
      await flush();

      changeProjectAssetsScope(page, 'global');
      page.fields.sort.value = 'modified';
      page.fields.sort.dispatch('change');
      await flush();
      await flush();

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(Object.fromEntries(fetch.mock.calls[1][1].body.entries())).toEqual({
        _csrf: 'csrf-token',
        scope: 'global',
        loadedScope: 'global',
        view: 'grid',
        gridSize: 'default',
        listSize: 'large',
        sort: 'modified',
        order: 'asc',
        pageSize: '25',
        extension: 'jpg',
        tag: '1',
      });
      expect(page.projectAssetsDefaultsRefreshOptions.refresh).toHaveBeenCalledWith(
        page.document,
        destination,
        17,
        { onError: expect.any(Function) },
      );
      closeAppDialogById(page.document, page.dialog.id);
      page.document.dispatch('click', { target: page.trigger });
      expect(page.scopeControls.global.checked).toBe(true);
      expect(page.form.querySelector('input[name="loadedScope"]').value).toBe('global');
      expect(projectAssetsDefaultValues(page.fields)).toEqual(authoritative.global);
      changeProjectAssetsScope(page, 'project');
      expect(projectAssetsDefaultValues(page.fields)).toEqual(authoritative.project);
      changeProjectAssetsScope(page, 'global');
      expect(projectAssetsDefaultValues(page.fields)).toEqual(authoritative.global);
      changeProjectAssetsScope(page, 'project');
      expect(projectAssetsDefaultValues(page.fields)).toEqual(authoritative.project);
      await flush();
      closeAppDialogById(page.document, page.dialog.id);
      page.document.dispatch('click', { target: page.trigger });
      expect(page.scopeControls.project.checked).toBe(true);
      expect(projectAssetsDefaultValues(page.fields)).toEqual(authoritative.project);
      expect(page.dialog.open).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([false, true])('reconciles a pending save after reopen without replacing newer input (%s)', async (newerInput) => {
    const page = makeDialogPage({
      standardDropdowns: true, projectAssetsDefaults: true, projectAssetsScope: true,
      loadedScope: 'project', projectAssetsDefaultsAutosave: true,
    });
    const values = JSON.parse(page.form.querySelector('[data-project-assets-default-values]').textContent);
    setProjectAssetsDefaultValues(page.fields, values.project);
    const pending = deferred();
    const fetch = vi.fn(() => pending.promise);
    const destination = 'http://creatorcrate.test/projects/1/assets?view=grid';
    installFetchGlobals(page, fetch);
    try {
      enhanceProjectAssetsAutosavePage(page);
      page.document.dispatch('click', { target: page.trigger });
      changeProjectAssetsScope(page, 'global');
      await flush();
      closeAppDialogById(page.document, page.dialog.id);
      page.document.dispatch('click', { target: page.trigger });
      expect(page.scopeControls.project.checked).toBe(true);
      expect(projectAssetsDefaultValues(page.fields)).toEqual(values.project);
      if (newerInput) {
        page.fields.sort.value = 'size';
        // Input-only changes are newer intent even before a change queues a save.
        page.fields.sort.dispatch('input');
      }
      pending.resolve(response({ url: destination, html: projectAssetsDefaultsHtml(values, 'global') }));
      await flush();
      const visibleScope = newerInput ? 'project' : 'global';
      expect(page.dialog.open).toBe(true);
      expect(page.scopeControls[visibleScope].checked).toBe(true);
      expect(page.form.querySelector('input[name="loadedScope"]').value).toBe(visibleScope);
      expect(projectAssetsDefaultValues(page.fields)).toEqual(newerInput
        ? { ...values.project, sort: 'size' } : values.global);
      expect(page.projectAssetsDefaultsRefreshOptions.refresh).toHaveBeenCalledWith(
        page.document, destination, 17, { onError: expect.any(Function) },
      );
      expect(page.status.textContent).toBe('Settings saved.');
      expect(fetch).toHaveBeenCalledOnce();
      closeAppDialogById(page.document, page.dialog.id);
      page.document.dispatch('click', { target: page.trigger });
      expect(page.scopeControls.global.checked).toBe(true);
      expect(projectAssetsDefaultValues(page.fields)).toEqual(values.global);
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses response-active Project scope and sizing when Global was submitted', async () => {
    const page = makeDialogPage({
      standardDropdowns: true, projectAssetsDefaults: true, projectAssetsScope: true,
      loadedScope: 'project', projectAssetsDefaultsAutosave: true,
    });
    const initial = JSON.parse(page.form.querySelector('[data-project-assets-default-values]').textContent);
    setProjectAssetsDefaultValues(page.fields, initial.project);
    const values = {
      global: { ...initial.global, gridSize: 'compact' },
      project: { ...initial.project, sort: 'modified' },
    };
    const pending = deferred();
    const fetch = vi.fn(() => pending.promise);
    const storage = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
    });
    installFetchGlobals(page, fetch);
    try {
      enhanceProjectAssetsAutosavePage(page);
      page.document.dispatch('click', { target: page.trigger });
      changeProjectAssetsScope(page, 'global');
      await flush();
      expect(fetch.mock.calls[0][1].body.get('loadedScope')).toBe('global');
      pending.resolve(response({ html: projectAssetsDefaultsHtml(values, 'project') }));
      await flush();
      expect(page.scopeControls.project.checked).toBe(true);
      expect(page.form.querySelector('input[name="loadedScope"]').value).toBe('project');
      expect(projectAssetsDefaultValues(page.fields)).toEqual(values.project);
      expect(JSON.parse(page.form.querySelector('[data-project-assets-default-values]').textContent)).toEqual(values);
      expect(storage.get('creatorcrate-asset-grid-size')).toBe(values.project.gridSize);
      expect(storage.get('creatorcrate-asset-list-size')).toBe(values.project.listSize);
      expect(storage.get('creatorcrate-asset-grid-size')).not.toBe(values.global.gridSize);
      closeAppDialogById(page.document, page.dialog.id);
      page.document.dispatch('click', { target: page.trigger });
      expect(page.scopeControls.project.checked).toBe(true);
      expect(projectAssetsDefaultValues(page.fields)).toEqual(values.project);
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('commits differing response authority while protecting a reopened newer draft and queued payload', async () => {
    const page = makeDialogPage({
      standardDropdowns: true, projectAssetsDefaults: true, projectAssetsScope: true,
      loadedScope: 'project', projectAssetsDefaultsAutosave: true,
    });
    const values = JSON.parse(page.form.querySelector('[data-project-assets-default-values]').textContent);
    setProjectAssetsDefaultValues(page.fields, values.project);
    const first = deferred();
    const second = deferred();
    const fetch = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    installFetchGlobals(page, fetch);
    try {
      enhanceProjectAssetsAutosavePage(page);
      page.document.dispatch('click', { target: page.trigger });
      changeProjectAssetsScope(page, 'global');
      await flush();
      closeAppDialogById(page.document, page.dialog.id);
      page.document.dispatch('click', { target: page.trigger });
      changeProjectAssetsScope(page, 'global');
      page.fields.sort.value = 'modified';
      page.fields.sort.dispatch('change');
      const queued = { ...values.global, sort: 'modified' };
      page.fields.sort.value = 'size';
      page.fields.sort.dispatch('input');
      first.resolve(response({ html: projectAssetsDefaultsHtml(values, 'project') }));
      await flush();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(Object.fromEntries(fetch.mock.calls[1][1].body.entries())).toMatchObject({
        scope: 'global', loadedScope: 'global', ...queued,
      });
      expect(page.scopeControls.global.checked).toBe(true);
      expect(page.fields.sort.value).toBe('size');
      expect(page.projectAssetsDefaultsRefreshOptions.refresh).not.toHaveBeenCalled();
      // The queued request must not adopt the revision of a later input-only draft.
      second.resolve(response({ html: projectAssetsDefaultsHtml({ ...values, global: queued }, 'project') }));
      await flush();
      expect(page.scopeControls.global.checked).toBe(true);
      expect(page.fields.sort.value).toBe('size');
      closeAppDialogById(page.document, page.dialog.id);
      page.document.dispatch('click', { target: page.trigger });
      expect(page.scopeControls.project.checked).toBe(true);
      expect(projectAssetsDefaultValues(page.fields)).toEqual(values.project);
      expect(JSON.parse(page.form.querySelector('[data-project-assets-default-values]').textContent))
        .toEqual({ ...values, global: queued });
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('persists a scope-only change even when both scopes have identical values', async () => {
    const shared = { view: 'grid', gridSize: 'default', listSize: 'large', sort: 'filename', order: 'asc', pageSize: '25', extension: 'jpg', tag: '1' };
    const page = makeDialogPage({
      standardDropdowns: true,
      projectAssetsDefaults: true,
      projectAssetsScope: true,
      projectAssetsScopeValues: { global: shared, project: shared },
      projectAssetsDefaultsAutosave: true,
    });
    const fetch = vi.fn().mockResolvedValue(response({
      html: projectAssetsDefaultsHtml({ global: shared, project: shared }, 'project'),
    }));
    installFetchGlobals(page, fetch);

    try {
      enhanceProjectAssetsAutosavePage(page);
      changeProjectAssetsScope(page, 'project');
      await flush();

      expect(fetch).toHaveBeenCalledOnce();
      expect(Object.fromEntries(fetch.mock.calls[0][1].body.entries())).toMatchObject({
        scope: 'project',
        loadedScope: 'project',
        ...shared,
      });
      closeAppDialogById(page.document, page.dialog.id);
      page.document.dispatch('click', { target: page.trigger });
      expect(page.scopeControls.project.checked).toBe(true);
      expect(page.form.querySelector('input[name="loadedScope"]').value).toBe('project');
      expect(projectAssetsDefaultValues(page.fields)).toEqual(shared);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('passes followed response HTML through the Project Assets acknowledgement detail', async () => {
    const page = makeDialogPage({
      standardDropdowns: true,
      projectAssetsDefaults: true,
      projectAssetsScope: true,
      projectAssetsDefaultsAutosave: true,
    });
    const values = JSON.parse(page.form.querySelector('[data-project-assets-default-values]').textContent);
    const html = projectAssetsDefaultsHtml(values);
    const onAcknowledged = vi.fn(() => true);
    const fetch = vi.fn().mockResolvedValue(response({ html }));
    installFetchGlobals(page, fetch);

    try {
      enhanceProjectAssetsAutosavePage(page, { onAcknowledged });
      page.fields.sort.value = 'modified';
      page.fields.sort.dispatch('change');
      await flush();

      expect(onAcknowledged).toHaveBeenCalledWith(expect.objectContaining({
        form: page.form,
        html,
        superseded: false,
      }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reconciles a Project-only acknowledgement from both authoritative server snapshots', async () => {
    const values = {
      global: { view: 'grid', gridSize: 'compact', listSize: 'large', sort: 'filename', order: 'desc', pageSize: '25', extension: 'jpg', tag: '1' },
      project: { view: 'list', gridSize: 'large', listSize: 'compact', sort: 'modified', order: 'asc', pageSize: '50', extension: 'png', tag: '2' },
    };
    const page = makeDialogPage({
      standardDropdowns: true,
      projectAssetsDefaults: true,
      projectAssetsScope: true,
      loadedScope: 'project',
      projectAssetsDefaultsAutosave: true,
    });
    const initial = JSON.parse(page.form.querySelector('[data-project-assets-default-values]').textContent);
    setProjectAssetsDefaultValues(page.fields, initial.project);
    const storage = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
    });
    const fetch = vi.fn().mockResolvedValue(response({
      html: projectAssetsDefaultsHtml(values, 'project'),
    }));
    installFetchGlobals(page, fetch);

    try {
      enhanceProjectAssetsAutosavePage(page);
      page.fields.sort.value = 'modified';
      page.fields.sort.dispatch('change');
      await flush();

      expect(JSON.parse(page.form.querySelector('[data-project-assets-default-values]').textContent)).toEqual(values);
      expect(projectAssetsDefaultValues(page.fields)).toEqual(values.project);
      expect(storage.get('creatorcrate-asset-grid-size')).toBe('large');
      expect(storage.get('creatorcrate-asset-list-size')).toBe('compact');
      changeProjectAssetsScope(page, 'global');
      expect(projectAssetsDefaultValues(page.fields)).toEqual(values.global);
      changeProjectAssetsScope(page, 'project');
      expect(projectAssetsDefaultValues(page.fields)).toEqual(values.project);
      await flush();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('serializes rapid Project Assets edits, commits only acknowledged snapshots, and syncs the latest saved sizes', async () => {
    const page = makeDialogPage({
      standardDropdowns: true,
      projectAssetsDefaults: true,
      projectAssetsScope: true,
      projectAssetsDefaultsAutosave: true,
    });
    const first = deferred();
    const second = deferred();
    const initial = JSON.parse(page.form.querySelector('[data-project-assets-default-values]').textContent);
    const firstAuthoritative = {
      global: { ...initial.global, gridSize: 'compact' },
      project: { ...initial.project },
    };
    const finalAuthoritative = {
      global: { ...initial.global, gridSize: 'large' },
      project: { ...initial.project },
    };
    const fetch = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const storage = new Map([
      ['creatorcrate-asset-grid-size', 'default'],
      ['creatorcrate-asset-list-size', 'large'],
    ]);
    vi.stubGlobal('localStorage', {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
    });
    installFetchGlobals(page, fetch);

    try {
      enhanceProjectAssetsAutosavePage(page);
      page.document.dispatch('click', { target: page.trigger });
      await flush();

      page.fields.gridSize.value = 'compact';
      page.fields.gridSize.dispatch('change');
      await flush();
      page.fields.gridSize.value = 'large';
      page.fields.gridSize.dispatch('change');

      expect(fetch).toHaveBeenCalledOnce();
      first.resolve(response({
        url: 'http://creatorcrate.test/projects/1/assets?gridSize=compact',
        html: projectAssetsDefaultsHtml(firstAuthoritative),
      }));
      await flush();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(Object.fromEntries(fetch.mock.calls[1][1].body.entries())).toMatchObject({ gridSize: 'large' });
      expect(page.projectAssetsDefaultsRefreshOptions.refresh).not.toHaveBeenCalled();

      const finalUrl = 'http://creatorcrate.test/projects/1/assets?gridSize=large&notice=project_assets_defaults_saved';
      second.resolve(response({
        url: finalUrl,
        html: projectAssetsDefaultsHtml(finalAuthoritative),
      }));
      await flush();

      expect(page.projectAssetsDefaultsRefreshOptions.beginRefresh).toHaveBeenCalledOnce();
      expect(page.projectAssetsDefaultsRefreshOptions.refresh).toHaveBeenCalledWith(
        page.document,
        finalUrl,
        17,
        { onError: expect.any(Function) },
      );
      expect(storage.get('creatorcrate-asset-grid-size')).toBe('large');
      expect(storage.get('creatorcrate-asset-list-size')).toBe(finalAuthoritative.global.listSize);
      closeAppDialogById(page.document, page.dialog.id);
      page.document.dispatch('click', { target: page.trigger });
      expect(page.fields.gridSize.value).toBe('large');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('queues an immutable scope snapshot behind an in-flight Defaults save', async () => {
    const page = makeDialogPage({
      standardDropdowns: true,
      projectAssetsDefaults: true,
      projectAssetsScope: true,
      projectAssetsDefaultsAutosave: true,
    });
    const initial = JSON.parse(page.form.querySelector('[data-project-assets-default-values]').textContent);
    const globalAcknowledgement = {
      global: { ...initial.global, sort: 'modified' },
      project: { ...initial.project },
    };
    const pending = deferred();
    const fetch = vi.fn()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce(response({
        url: 'http://creatorcrate.test/projects/1/assets?pageSize=50&notice=project_assets_defaults_saved',
        html: projectAssetsDefaultsHtml(globalAcknowledgement, 'project'),
      }));
    installFetchGlobals(page, fetch);

    try {
      enhanceProjectAssetsAutosavePage(page);
      page.fields.sort.value = 'modified';
      page.fields.sort.dispatch('change');
      await flush();
      expect(Object.fromEntries(fetch.mock.calls[0][1].body.entries())).toMatchObject({
        scope: 'global',
        loadedScope: 'global',
        sort: 'modified',
      });
      changeProjectAssetsScope(page, 'project');
      await flush();

      expect(fetch).toHaveBeenCalledOnce();
      expect(Object.fromEntries(fetch.mock.calls[0][1].body.entries())).toMatchObject({
        scope: 'global',
        loadedScope: 'global',
        sort: 'modified',
      });
      pending.resolve(response({
        url: 'http://creatorcrate.test/projects/1/assets?sort=modified&notice=project_assets_defaults_saved',
        html: projectAssetsDefaultsHtml(globalAcknowledgement),
      }));
      await flush();
      await flush();

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(Object.fromEntries(fetch.mock.calls[1][1].body.entries())).toMatchObject({
        scope: 'project',
        loadedScope: 'project',
        sort: 'category',
        view: 'list',
        gridSize: 'large',
        listSize: 'compact',
        pageSize: '50',
        extension: 'png',
        tag: '2',
      });
      expect(JSON.parse(page.form.querySelector('[data-project-assets-default-values]').textContent)).toMatchObject({
        global: { sort: 'modified' },
        project: { sort: 'category' },
      });
      expect(page.scopeControls.project.checked).toBe(true);
      expect(page.form.querySelector('input[name="loadedScope"]').value).toBe('project');
      expect(projectAssetsDefaultValues(page.fields)).toMatchObject({
        sort: 'category',
        view: 'list',
        gridSize: 'large',
      });
      expect(page.projectAssetsDefaultsRefreshOptions.refresh).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('coalesces rapid scope changes through the existing queue so the latest scope wins', async () => {
    const pending = deferred();
    const page = makeDialogPage({
      standardDropdowns: true,
      projectAssetsDefaults: true,
      projectAssetsScope: true,
      projectAssetsDefaultsAutosave: true,
    });
    const initial = JSON.parse(page.form.querySelector('[data-project-assets-default-values]').textContent);
    const html = projectAssetsDefaultsHtml(initial);
    const fetch = vi.fn()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce(response({ html }));
    installFetchGlobals(page, fetch);

    try {
      enhanceProjectAssetsAutosavePage(page);
      changeProjectAssetsScope(page, 'project');
      await flush();
      changeProjectAssetsScope(page, 'global');

      expect(fetch).toHaveBeenCalledOnce();
      expect(Object.fromEntries(fetch.mock.calls[0][1].body.entries())).toMatchObject({
        scope: 'project',
        loadedScope: 'project',
        view: 'list',
        sort: 'category',
      });

      pending.resolve(response({ html }));
      await flush();
      await flush();

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(Object.fromEntries(fetch.mock.calls[1][1].body.entries())).toMatchObject({
        scope: 'global',
        loadedScope: 'global',
        view: 'grid',
        sort: 'filename',
      });
      expect(page.scopeControls.global.checked).toBe(true);
      expect(page.form.querySelector('input[name="loadedScope"]').value).toBe('global');
      expect(projectAssetsDefaultValues(page.fields)).toMatchObject({
        view: 'grid',
        sort: 'filename',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not queue a scope save when the target draft cannot be hydrated', async () => {
    const values = {
      global: { view: 'grid', gridSize: 'default', listSize: 'large', sort: 'filename', order: 'asc', pageSize: '25', extension: 'jpg', tag: '1' },
      project: { view: 'list', gridSize: 'large', listSize: 'compact', sort: 'category', order: 'desc', pageSize: '50', extension: 'gif', tag: '2' },
    };
    const page = makeDialogPage({
      standardDropdowns: true,
      projectAssetsDefaults: true,
      projectAssetsScope: true,
      projectAssetsScopeValues: values,
      projectAssetsDefaultsAutosave: true,
    });
    const fetch = vi.fn();
    installFetchGlobals(page, fetch);

    try {
      enhanceProjectAssetsAutosavePage(page);
      changeProjectAssetsScope(page, 'project');
      await flush();

      expect(fetch).not.toHaveBeenCalled();
      expect(page.scopeControls.global.checked).toBe(true);
      expect(page.form.querySelector('input[name="loadedScope"]').value).toBe('global');
      expect(projectAssetsDefaultValues(page.fields)).toEqual(values.global);
      expect(page.form.querySelector('[data-dialog-error-text]').textContent).toMatch(/could not be changed safely/i);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps a failed scope choice usable without marking it committed', async () => {
    const page = makeDialogPage({
      standardDropdowns: true,
      projectAssetsDefaults: true,
      projectAssetsScope: true,
      projectAssetsDefaultsAutosave: true,
    });
    const initial = JSON.parse(page.form.querySelector('[data-project-assets-default-values]').textContent);
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ ok: false, redirected: false }))
      .mockResolvedValueOnce(response({ html: projectAssetsDefaultsHtml(initial, 'project') }));
    installFetchGlobals(page, fetch);

    try {
      enhanceProjectAssetsAutosavePage(page);
      changeProjectAssetsScope(page, 'project');
      await flush();

      expect(page.scopeControls.project.checked).toBe(true);
      expect(page.form.querySelector('input[name="loadedScope"]').value).toBe('project');
      expect(page.status.textContent).toBe('Could not save settings. Your current changes were kept.');

      closeAppDialogById(page.document, page.dialog.id);
      page.document.dispatch('click', { target: page.trigger });
      expect(page.scopeControls.global.checked).toBe(true);
      expect(page.form.querySelector('input[name="loadedScope"]').value).toBe('global');

      changeProjectAssetsScope(page, 'project');
      await flush();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(page.scopeControls.project.checked).toBe(true);
      expect(page.form.querySelector('input[name="loadedScope"]').value).toBe('project');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps Project Assets edits on save failure and treats superseded refresh as a successful save', async () => {
    const page = makeDialogPage({
      standardDropdowns: true,
      projectAssetsDefaults: true,
      projectAssetsScope: true,
      projectAssetsDefaultsAutosave: true,
    });
    const initial = JSON.parse(page.form.querySelector('[data-project-assets-default-values]').textContent);
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ ok: false, redirected: false }))
      .mockResolvedValueOnce(response({
        url: 'http://creatorcrate.test/projects/1/assets?sort=modified&notice=project_assets_defaults_saved',
        html: projectAssetsDefaultsHtml({
          global: { ...initial.global, sort: 'modified' },
          project: { ...initial.project },
        }),
      }));
    const refresh = vi.fn(() => 'superseded');
    installFetchGlobals(page, fetch);

    try {
      enhanceProjectAssetsAutosavePage(page, { refresh });
      page.document.dispatch('click', { target: page.trigger });
      await flush();
      page.fields.sort.value = 'size';
      page.fields.sort.dispatch('change');
      await flush();

      expect(page.fields.sort.value).toBe('size');
      expect(refresh).not.toHaveBeenCalled();
      expect(page.status.textContent).toBe('Could not save settings. Your current changes were kept.');

      page.fields.sort.value = 'modified';
      page.fields.sort.dispatch('change');
      await flush();

      expect(refresh).toHaveBeenCalledOnce();
      expect(page.status.textContent).toBe('Settings saved.');
      expect(page.form.getAttribute('data-settings-fetch-save-state')).toBe('saved');
      expect(page.dialog.open).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports saved-but-refresh-failed for Project Assets without reverting the acknowledged edit', async () => {
    const page = makeDialogPage({
      standardDropdowns: true,
      projectAssetsDefaults: true,
      projectAssetsScope: true,
      projectAssetsDefaultsAutosave: true,
    });
    const initial = JSON.parse(page.form.querySelector('[data-project-assets-default-values]').textContent);
    const fetch = vi.fn().mockResolvedValue(response({
      url: 'http://creatorcrate.test/projects/1/assets?sort=size&notice=project_assets_defaults_saved',
      html: projectAssetsDefaultsHtml({
        global: { ...initial.global, sort: 'size' },
        project: { ...initial.project },
      }),
    }));
    const refresh = vi.fn((_document, _url, _authority, { onError }) => {
      onError();
      return 'started';
    });
    installFetchGlobals(page, fetch);

    try {
      enhanceProjectAssetsAutosavePage(page, { refresh });
      page.document.dispatch('click', { target: page.trigger });
      await flush();
      page.fields.sort.value = 'size';
      page.fields.sort.dispatch('change');
      await flush();

      expect(page.fields.sort.value).toBe('size');
      expect(page.status.textContent).toBe('Settings saved, but Project Assets could not refresh. Refresh the page to see the saved defaults.');
      expect(page.form.getAttribute('data-settings-fetch-save-state')).toBe('saved-refresh-error');
      expect(page.dialog.open).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(['malformed', 'missing scope', 'invalid scope', 'missing snapshot'])('keeps committed scopes intact for %s response authority', async (failure) => {
    const page = makeDialogPage({
      standardDropdowns: true,
      projectAssetsDefaults: true,
      projectAssetsScope: true,
      projectAssetsDefaultsAutosave: true,
    });
    const initial = JSON.parse(page.form.querySelector('[data-project-assets-default-values]').textContent);
    const html = {
      malformed: '<main>Saved</main>',
      'missing scope': projectAssetsDefaultsHtml(initial).replace(/<input[^>]*>/, ''),
      'invalid scope': projectAssetsDefaultsHtml(initial, 'other'),
      'missing snapshot': projectAssetsDefaultsHtml({ global: initial.global }, 'project'),
    }[failure];
    const fetch = vi.fn().mockResolvedValue(response({ html }));
    installFetchGlobals(page, fetch);

    try {
      enhanceProjectAssetsAutosavePage(page);
      page.fields.sort.value = 'modified';
      page.fields.sort.dispatch('change');
      await flush();

      expect(JSON.parse(page.form.querySelector('[data-project-assets-default-values]').textContent)).toEqual(initial);
      expect(page.status.textContent).toMatch(/settings saved, but the returned Project Assets defaults could not be read/i);
      expect(page.form.getAttribute('data-settings-fetch-save-state')).toBe('saved-refresh-error');
      closeAppDialogById(page.document, page.dialog.id);
      page.document.dispatch('click', { target: page.trigger });
      expect(projectAssetsDefaultValues(page.fields)).toEqual(initial.global);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('sends complete snapshots serially and keeps the dialog open with the latest values', async () => {
    const page = makeDialogPage({ standardDropdowns: true, projectsDefaultsAutosave: true });
    const first = deferred();
    const second = deferred();
    const fetch = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    installFetchGlobals(page, fetch);

    try {
      expect(enhanceAutosavePage(page)).toBe(6);
      expect(enhanceProjectsDefaultsFetchSave(page.document, page.projectsDefaultsRefreshOptions)).toBe(0);
      page.document.dispatch('click', { target: page.trigger });

      const listRadio = page.dropdowns.view.panel.querySelectorAll('input[type="radio"]')
        .find((input) => input.value === 'list');
      listRadio.checked = true;
      page.document.dispatch('change', { target: listRadio });
      await flush();

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(page.fields.view.value).toBe('list');
      expect(Object.fromEntries(fetch.mock.calls[0][1].body.entries())).toMatchObject({
        view: 'list', sort: 'created', order: 'desc', status: 'all', projectType: 'all', tag: 'all',
      });

      page.fields.sort.value = 'title';
      page.fields.sort.dispatch('change');
      page.fields.order.value = 'asc';
      page.fields.order.dispatch('change');
      expect(fetch).toHaveBeenCalledTimes(1);

      first.resolve(response());
      await flush();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(Object.fromEntries(fetch.mock.calls[1][1].body.entries())).toMatchObject({
        view: 'list', sort: 'title', order: 'asc', status: 'all', projectType: 'all', tag: 'all',
      });

      second.resolve(response());
      await flush();
      expect(page.dialog.open).toBe(true);
      expect(page.status.textContent).toBe('Settings saved.');
      expect(page.form.getAttribute('aria-busy')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(['X', 'Escape', 'backdrop'])('%s dismissal does not cancel a pending save or restore stale values on reopen', async (path) => {
    const page = makeDialogPage({ standardDropdowns: true, projectsDefaultsAutosave: true });
    const pending = deferred();
    const fetch = vi.fn(() => pending.promise);
    installFetchGlobals(page, fetch);

    try {
      enhanceAutosavePage(page);
      page.document.dispatch('click', { target: page.trigger });
      page.fields.view.value = 'list';
      page.fields.view.dispatch('change');
      await flush();

      if (path === 'X') page.close.dispatch('click');
      else if (path === 'Escape') page.dialog.dispatch('keydown', { key: 'Escape', target: page.dialog });
      else page.dialog.dispatch('click', { target: page.dialog });

      expect(page.dialog.open).toBe(false);
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch.mock.calls[0][1]).not.toHaveProperty('signal');
      page.document.dispatch('click', { target: page.trigger });
      expect(page.dialog.open).toBe(true);
      expect(page.fields.view.value).toBe('list');

      pending.resolve(response());
      await flush();
      expect(page.status.textContent).toBe('Settings saved.');
      expect(page.fields.view.value).toBe('list');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps current edits through validation failure and saves a correction', async () => {
    const page = makeDialogPage({ standardDropdowns: true, projectsDefaultsAutosave: true });
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ ok: false, redirected: false, html: '<p>Invalid sort.</p>' }))
      .mockResolvedValueOnce(response());
    installFetchGlobals(page, fetch);

    try {
      enhanceAutosavePage(page);
      const renderedError = page.form.querySelector('[data-dialog-error]');
      const sortField = page.fields.sort.closest('[data-dialog-field]');
      const fieldError = makeElement('span', { class: 'field-error-message' });
      renderedError.hidden = false;
      renderedError.querySelector('[data-dialog-error-text]').textContent = 'Previously invalid.';
      sortField.classList.add('field-error');
      sortField.appendChild(fieldError);
      page.fields.sort.setAttribute('aria-invalid', 'true');
      page.fields.sort.setAttribute('aria-describedby', 'projects-default-sort-error');

      page.fields.sort.value = 'invalid';
      page.fields.sort.dispatch('change');
      await flush();

      expect(renderedError.hidden).toBe(true);
      expect(sortField.classList.contains('field-error')).toBe(false);
      expect(sortField.querySelector('.field-error-message')).toBeNull();
      expect(page.fields.sort.getAttribute('aria-invalid')).toBeNull();
      expect(page.fields.sort.value).toBe('invalid');
      expect(page.status.textContent).toBe('Could not save settings. Your current changes were kept.');
      expect(page.form.getAttribute('data-settings-fetch-save-state')).toBe('error');

      page.fields.sort.value = 'title';
      page.fields.sort.dispatch('change');
      await flush();
      expect(page.fields.sort.value).toBe('title');
      expect(page.status.textContent).toBe('Settings saved.');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps current edits through network failure and ignores a superseded validation result', async () => {
    const page = makeDialogPage({ standardDropdowns: true, projectsDefaultsAutosave: true });
    const stale = deferred();
    const latest = deferred();
    const fetch = vi.fn()
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => latest.promise)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(response());
    installFetchGlobals(page, fetch);

    try {
      enhanceAutosavePage(page);
      page.fields.view.value = 'list';
      page.fields.view.dispatch('change');
      await flush();
      page.fields.sort.value = 'title';
      page.fields.sort.dispatch('change');

      stale.resolve(response({ ok: false, redirected: false, html: '<p>Stale error.</p>' }));
      await flush();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(page.status.textContent).toBe('Saving settings.');
      expect(page.form.getAttribute('data-settings-fetch-save-state')).toBe('pending');

      latest.resolve(response());
      await flush();
      expect(page.status.textContent).toBe('Settings saved.');
      expect(page.fields.sort.value).toBe('title');

      page.fields.order.value = 'asc';
      page.fields.order.dispatch('change');
      await flush();
      expect(page.fields.order.value).toBe('asc');
      expect(page.status.textContent).toBe('Could not save settings. Your current changes were kept.');

      page.fields.order.value = 'desc';
      page.fields.order.dispatch('change');
      await flush();
      expect(page.status.textContent).toBe('Settings saved.');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refreshes once from the latest confirmed success URL and reports refresh failure separately', async () => {
    const page = makeDialogPage({ standardDropdowns: true, projectsDefaultsAutosave: true });
    const first = deferred();
    const second = deferred();
    const fetch = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const beginRefresh = vi.fn(() => 7);
    const refresh = vi.fn((_document, _url, _authority, { onError }) => {
      onError();
      return 'started';
    });
    installFetchGlobals(page, fetch);

    try {
      enhanceAutosavePage(page, { beginRefresh, refresh });
      page.document.dispatch('click', { target: page.trigger });
      page.fields.view.value = 'list';
      page.fields.view.dispatch('change');
      await flush();
      page.fields.sort.value = 'title';
      page.fields.sort.dispatch('change');

      first.resolve(response({ url: 'http://creatorcrate.test/projects?view=list&notice=projects_defaults_saved' }));
      await flush();
      expect(beginRefresh).toHaveBeenCalledOnce();
      expect(refresh).not.toHaveBeenCalled();

      const successUrl = 'http://creatorcrate.test/projects?sort=title&order=desc&view=list&notice=projects_defaults_saved';
      second.resolve(response({ url: successUrl }));
      await flush();

      expect(beginRefresh).toHaveBeenCalledOnce();
      expect(refresh).toHaveBeenCalledOnce();
      expect(refresh).toHaveBeenCalledWith(page.document, successUrl, 7, { onError: expect.any(Function) });
      expect(page.dialog.open).toBe(true);
      expect(page.fields.view.value).toBe('list');
      expect(page.fields.sort.value).toBe('title');
      expect(page.status.textContent).toBe('Settings saved, but Projects could not refresh. Refresh the page to see the saved defaults.');
      expect(page.form.getAttribute('data-settings-fetch-save-state')).toBe('saved-refresh-error');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('configures the shared autosave path for Releases without binding it twice', async () => {
    const page = makeDialogPage({ standardDropdowns: true, projectsDefaultsAutosave: true });
    page.form.setAttribute('id', 'releases-defaults-form');
    page.form.setAttribute('action', '/releases/defaults');
    page.form.removeAttribute('data-projects-defaults-autosave');
    page.form.setAttribute('data-releases-defaults-autosave', '');
    Object.entries(page.fields).forEach(([name, field]) => {
      if (name !== 'sort' && name !== 'order') field.removeAttribute('data-autosubmit');
    });
    const beginRefresh = vi.fn(() => 11);
    const refresh = vi.fn(() => 'started');
    const fetch = vi.fn().mockResolvedValue(response({
      url: 'http://creatorcrate.test/releases?sort=title&order=asc&notice=releases_defaults_saved',
    }));
    installFetchGlobals(page, fetch);

    try {
      expect(enhanceReleasesDefaultsFetchSave(page.document, { beginRefresh, refresh })).toBe(2);
      expect(enhanceReleasesDefaultsFetchSave(page.document, { beginRefresh, refresh })).toBe(0);

      page.fields.sort.value = 'title';
      page.fields.sort.dispatch('change');
      await flush();

      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledWith('/releases/defaults', expect.objectContaining({
        method: 'POST',
        redirect: 'follow',
      }));
      expect(beginRefresh).toHaveBeenCalledOnce();
      expect(refresh).toHaveBeenCalledWith(
        page.document,
        'http://creatorcrate.test/releases?sort=title&order=asc&notice=releases_defaults_saved',
        11,
        { onError: expect.any(Function) },
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps Releases edits and uses its configured accessible failure message', async () => {
    const page = makeDialogPage({ standardDropdowns: true, projectsDefaultsAutosave: true });
    page.form.setAttribute('id', 'releases-defaults-form');
    page.form.removeAttribute('data-projects-defaults-autosave');
    page.form.setAttribute('data-releases-defaults-autosave', '');
    Object.entries(page.fields).forEach(([name, field]) => {
      if (name !== 'sort' && name !== 'order') field.removeAttribute('data-autosubmit');
    });
    const fetch = vi.fn().mockResolvedValue(response({ ok: false, redirected: false }));
    installFetchGlobals(page, fetch);

    try {
      enhanceReleasesDefaultsFetchSave(page.document, {
        beginRefresh: vi.fn(() => 0),
        refresh: vi.fn(() => 'started'),
      });
      page.fields.order.value = 'asc';
      page.fields.order.dispatch('change');
      await flush();

      expect(page.fields.order.value).toBe('asc');
      expect(page.status.textContent).toBe('Could not save settings. Your current changes were kept.');
      expect(page.status.getAttribute('role')).toBe('status');
      expect(page.status.getAttribute('aria-live')).toBe('polite');
      expect(page.form.getAttribute('data-settings-fetch-save-state')).toBe('error');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('Dashboard defaults dialog client behavior', () => {
  it('wires the shared dedicated reorder engine for keyboard and full-row pointer drag movement', () => {
    const page = makeDashboardDefaultsDialogPage();
    Object.defineProperty(page.windowObject, 'localStorage', {
      get() { throw new Error('Dashboard defaults must not use localStorage.'); },
    });
    enhanceDashboardDefaults(page);

    expect(dashboardSectionOrder(page)).toEqual(['overdue', 'upcoming', 'recently-updated']);
    expect(page.orderInput.value).toBe('overdue,upcoming,recently-updated');
    expect(page.sections.overdue.row.getAttribute('aria-posinset')).toBe('1');
    expect(page.sections.overdue.row.getAttribute('aria-setsize')).toBe('3');

    page.sections.overdue.handle.dispatch('keydown', { key: 'ArrowDown' });
    expect(dashboardSectionOrder(page)).toEqual(['upcoming', 'overdue', 'recently-updated']);
    expect(page.orderInput.value).toBe('upcoming,overdue,recently-updated');
    expect(page.document.activeElement).toBe(page.sections.overdue.handle);
    expect(page.sections.overdue.row.getAttribute('aria-posinset')).toBe('2');
    expect(page.live.textContent).toContain('Overdue moved to position 2 of 3');

    page.sections.overdue.handle.dispatch('keydown', { key: 'ArrowUp' });
    expect(dashboardSectionOrder(page)).toEqual(['overdue', 'upcoming', 'recently-updated']);
    page.sections['recently-updated'].handle.dispatch('keydown', { key: 'Home' });
    expect(dashboardSectionOrder(page)).toEqual(['recently-updated', 'overdue', 'upcoming']);
    page.sections['recently-updated'].handle.dispatch('keydown', { key: 'End' });
    expect(dashboardSectionOrder(page)).toEqual(['overdue', 'upcoming', 'recently-updated']);
    expect(page.orderInput.value).toBe('overdue,upcoming,recently-updated');

    dragDashboardSection(page, page.sections['recently-updated'], page.sections.overdue);
    expect(dashboardSectionOrder(page)).toEqual(['recently-updated', 'overdue', 'upcoming']);
    expect(page.orderInput.value).toBe('recently-updated,overdue,upcoming');
  });

  it('does not start a Dashboard row drag from interactive controls', () => {
    const page = makeDashboardDefaultsDialogPage();
    enhanceDashboardDefaults(page);

    const visibilityDrag = page.sections.overdue.row.dispatch('dragstart', {
      target: page.sections.overdue.visibleControl,
      dataTransfer: { setData: vi.fn() },
    });
    expect(visibilityDrag.defaultPrevented).toBe(true);
    expect(page.sections.overdue.row.classList.contains('is-dragging')).toBe(false);
    expect(page.sections.overdue.visibleControl.dispatch('click').defaultPrevented).toBe(false);

    const countDrag = page.sections.overdue.row.dispatch('dragstart', {
      target: page.sections.overdue.countControl,
      dataTransfer: { setData: vi.fn() },
    });
    expect(countDrag.defaultPrevented).toBe(true);
    expect(page.sections.overdue.row.classList.contains('is-dragging')).toBe(false);
    expect(page.sections.overdue.countControl.dispatch('click').defaultPrevented).toBe(false);

    const sortDrag = page.sections.overdue.row.dispatch('dragstart', {
      target: page.sections.overdue.sortControl,
      dataTransfer: { setData: vi.fn() },
    });
    expect(sortDrag.defaultPrevented).toBe(true);
    expect(page.sections.overdue.row.classList.contains('is-dragging')).toBe(false);
    expect(page.sections.overdue.sortControl.dispatch('click').defaultPrevented).toBe(false);

    dragDashboardSection(page, page.sections['recently-updated'], page.sections.overdue);
    expect(dashboardSectionOrder(page)).toEqual(['recently-updated', 'overdue', 'upcoming']);
    expect(page.orderInput.value).toBe('recently-updated,overdue,upcoming');
  });

  it('stages sort options per section in one secondary dialog and restores focus after Apply', () => {
    const page = makeDashboardDefaultsDialogPage();
    enhanceDashboardDefaults(page);
    page.document.dispatch('click', { target: page.trigger });

    page.sections.overdue.sortControl.dispatch('click');
    page.document.dispatch('click', { target: page.sections.overdue.sortControl });
    expect(page.sortDialog.open).toBe(true);
    expect(page.dialog.open).toBe(true);
    expect(page.sectionLabel.textContent).toBe('Overdue');
    expect(page.sortSelect.value).toBe('planned');
    expect(page.orderSelect.value).toBe('asc');

    page.sortSelect.value = 'published';
    page.orderSelect.value = 'desc';
    page.apply.dispatch('click');
    expect(page.sortDialog.open).toBe(false);
    expect(page.sections.overdue.sortInput.value).toBe('published');
    expect(page.sections.overdue.orderInput.value).toBe('desc');
    expect(page.sections.upcoming.sortInput.value).toBe('updated');
    expect(page.sections.upcoming.orderInput.value).toBe('desc');
    expect(page.document.activeElement).toBe(page.sections.overdue.sortControl);

    page.sections.upcoming.sortControl.dispatch('click');
    page.document.dispatch('click', { target: page.sections.upcoming.sortControl });
    expect(page.sectionLabel.textContent).toBe('Upcoming releases');
    expect(page.sortSelect.value).toBe('updated');
    expect(page.orderSelect.value).toBe('desc');
    page.sortDialog.dispatch('keydown', { key: 'Escape', target: page.sortDialog });
    expect(page.sortDialog.open).toBe(false);
    expect(page.dialog.open).toBe(true);
    expect(page.document.activeElement).toBe(page.sections.upcoming.sortControl);
    expect(page.document.body.classList.contains('app-dialog-open')).toBe(true);
  });

  it('restores confirmed order and values after Escape and X cancellation', () => {
    const page = makeDashboardDefaultsDialogPage();
    enhanceDashboardDefaults(page);
    page.document.dispatch('click', { target: page.trigger });
    dragDashboardSection(page, page.sections.overdue, page.sections['recently-updated']);
    page.sections.overdue.visibleControl.checked = false;
    page.sections.upcoming.countControl.value = '25';
    page.sections.overdue.sortControl.dispatch('click');
    page.document.dispatch('click', { target: page.sections.overdue.sortControl });
    page.sortSelect.value = 'published';
    page.orderSelect.value = 'desc';
    page.apply.dispatch('click');
    page.dialog.dispatch('keydown', { key: 'Escape' });

    expect(dashboardSectionOrder(page)).toEqual(['overdue', 'upcoming', 'recently-updated']);
    expect(page.orderInput.value).toBe('overdue,upcoming,recently-updated');
    expect(page.sections.overdue.visibleControl.checked).toBe(true);
    expect(page.sections.upcoming.countControl.value).toBe('10');
    expect(page.sections.overdue.sortInput.value).toBe('planned');
    expect(page.sections.overdue.orderInput.value).toBe('asc');

    page.document.dispatch('click', { target: page.trigger });
    dragDashboardSection(page, page.sections['recently-updated'], page.sections.overdue);
    page.sections['recently-updated'].visibleControl.checked = true;
    page.sections.overdue.countControl.value = '1';
    page.sections.upcoming.sortInput.value = 'published';
    page.sections.upcoming.orderInput.value = 'asc';
    page.close.dispatch('click');

    expect(dashboardSectionOrder(page)).toEqual(['overdue', 'upcoming', 'recently-updated']);
    expect(page.sections['recently-updated'].visibleControl.checked).toBe(false);
    expect(page.sections.overdue.countControl.value).toBe('8');
    expect(page.sections.upcoming.sortInput.value).toBe('updated');
    expect(page.sections.upcoming.orderInput.value).toBe('desc');
  });

  it('navigates once to the server-rendered Dashboard after a successful enhanced save', async () => {
    const page = makeDashboardDefaultsDialogPage();
    const assign = vi.fn();
    page.windowObject.location = { assign };
    page.windowObject.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'success', message: 'Dashboard defaults saved successfully.', values: {} }),
    });
    enhanceDashboardDefaults(page);
    page.document.dispatch('click', { target: page.trigger });
    page.sections.overdue.handle.dispatch('keydown', { key: 'End' });
    page.sections.overdue.visibleControl.checked = false;
    page.sections.upcoming.countControl.value = '22';
    page.sections.overdue.sortInput.value = 'published';
    page.sections.overdue.orderInput.value = 'desc';
    page.form.dispatch('submit', { submitter: page.save });
    await flush();

    expect(page.windowObject.fetch).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith('/?notice=dashboard_defaults_saved');
    expect(page.dialog.close).not.toHaveBeenCalled();
    expect([...page.windowObject.fetch.mock.calls[0][1].body.entries()])
      .toContainEqual(['sections[overdue][sort]', 'published']);
    expect([...page.windowObject.fetch.mock.calls[0][1].body.entries()])
      .toContainEqual(['sections[overdue][order]', 'desc']);
  });

  it('marks a status visibility switch invalid on 422, retains attempted state, then restores the confirmed baseline on Escape', async () => {
    const page = makeDashboardDefaultsDialogPage({ includeStatusSection: true });
    const assign = vi.fn();
    page.windowObject.location = { assign };
    page.windowObject.fetch.mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({
        status: 'error',
        message: 'Dashboard defaults could not be saved. Fix the invalid fields and try again.',
        errors: {
          'sections[status:ready][visible]': 'Show section must be explicitly enabled or disabled.',
        },
        values: {
          orderedSectionIds: 'status:ready,overdue,upcoming,recently-updated',
          sections: {
            overdue: { visible: false, itemCount: '8' },
            upcoming: { visible: true, itemCount: '10' },
            'recently-updated': { visible: false, itemCount: '12' },
            'status:ready': { visible: false, itemCount: '6' },
          },
        },
      }),
    });
    enhanceDashboardDefaults(page);
    page.document.dispatch('click', { target: page.trigger });
    page.sections['status:ready'].handle.dispatch('keydown', { key: 'Home' });
    page.sections.overdue.visibleControl.checked = false;
    page.sections['status:ready'].visibleControl.checked = false;
    page.sections.upcoming.countControl.value = '10';
    page.form.dispatch('submit', { submitter: page.save });
    await flush();

    expect(page.dialog.open).toBe(true);
    expect(dashboardSectionOrder(page)).toEqual(['status:ready', 'overdue', 'upcoming', 'recently-updated']);
    expect(page.orderInput.value).toBe('status:ready,overdue,upcoming,recently-updated');
    expect(page.sections.overdue.visibleControl.checked).toBe(false);
    expect(page.sections['status:ready'].visibleControl.checked).toBe(false);
    expect(page.sections.upcoming.countControl.value).toBe('10');
    expect(page.sections['status:ready'].visibleField.classList.contains('field-error')).toBe(true);
    expect(page.sections['status:ready'].visibleControl.getAttribute('aria-invalid')).toBe('true');
    expect(page.sections['status:ready'].visibleControl.getAttribute('aria-describedby')).toBe('dashboard-defaults-section-status:ready-visible-error');
    expect(page.sections['status:ready'].visibleField.children.find((child) => child.className === 'field-error-message')?.textContent)
      .toBe('Show section must be explicitly enabled or disabled.');
    expect(page.dialog.querySelector('[data-dialog-error-list]').textContent)
      .not.toContain('[object Object]');
    expect(assign).not.toHaveBeenCalled();

    page.dialog.dispatch('keydown', { key: 'Escape', target: page.dialog });
    expect(dashboardSectionOrder(page)).toEqual(['overdue', 'upcoming', 'recently-updated', 'status:ready']);
    expect(page.sections.overdue.visibleControl.checked).toBe(true);
    expect(page.sections['status:ready'].visibleControl.checked).toBe(true);
    expect(page.sections.upcoming.countControl.value).toBe('10');
  });
});

describe('Category slug autofill', () => {
  it('normalizes display names into valid directory slugs', () => {
    expect(directorySlugFromDisplayName('My Cool Category')).toBe('my-cool-category');
    expect(directorySlugFromDisplayName('  Café & WIP!  ')).toBe('cafe-wip');
    expect(directorySlugFromDisplayName('---')).toBe('');
    expect(directorySlugFromDisplayName('CON')).toBe('');
  });

  it('fills an empty slug on Tab without preventing normal navigation and preserves explicit values', () => {
    const page = makeCategoryDialogPage();
    const form = page.initial.body.querySelector('#project-category-management-add-form');
    const displayName = form.querySelector('#add-displayName');
    const directorySlug = form.querySelector('#add-directorySlug');

    expect(enhanceCategorySlugAutofill(page.document)).toBe(1);
    displayName.value = '  My Cool Category!  ';
    const firstTab = displayName.dispatch('keydown', { key: 'Tab' });
    expect(firstTab.defaultPrevented).toBe(false);
    expect(directorySlug.value).toBe('my-cool-category');

    directorySlug.value = 'cool-cat';
    displayName.value = 'A different name';
    const secondTab = displayName.dispatch('keydown', { key: 'Tab' });
    expect(secondTab.defaultPrevented).toBe(false);
    expect(directorySlug.value).toBe('cool-cat');

    directorySlug.value = '';
    const reverseTab = displayName.dispatch('keydown', { key: 'Tab', shiftKey: true });
    expect(reverseTab.defaultPrevented).toBe(false);
    expect(directorySlug.value).toBe('');
  });

  it('binds the shared behavior through the project category dialog enhancement', () => {
    const page = makeCategoryDialogPage();
    const form = page.initial.body.querySelector('#project-category-management-add-form');
    const displayName = form.querySelector('#add-displayName');
    const directorySlug = form.querySelector('#add-directorySlug');

    enhanceAppDialogs(page.document);
    enhanceProjectAssetCategoryManagement(page.document);
    displayName.value = 'Project category';
    const event = displayName.dispatch('keydown', { key: 'Tab' });

    expect(event.defaultPrevented).toBe(false);
    expect(directorySlug.value).toBe('project-category');
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


  it('replays category deletion through its native submitter after shared-dialog confirmation', async () => {
    const page = makeCategoryDialogPage();
    const confirmation = attachSharedConfirmationDialog(page);
    page.windowObject.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'success',
        message: 'Category deleted.',
        focus: 'add-displayName',
        html: '<server-rendered-category-management-body>',
      }),
    });

    enhanceAppDialogs(page.document);
    page.document.dispatch('click', { target: page.trigger });
    enhanceConfirmations(page.document);
    enhanceProjectAssetCategoryManagement(page.document);

    const deleteForm = page.initial.body.querySelector('[data-category-management-delete-form]');
    const deleteButton = deleteForm.querySelector('[data-confirm]');
    deleteButton.click = () => {
      const event = deleteButton.dispatch('click');
      if (!event.defaultPrevented) deleteForm.dispatch('submit', { submitter: deleteButton });
      return event;
    };

    expect(deleteButton.click().defaultPrevented).toBe(true);
    expect(confirmation.dialog.open).toBe(true);
    confirmation.cancel.dispatch('click');
    await flush();
    expect(page.windowObject.fetch).not.toHaveBeenCalled();

    expect(deleteButton.click().defaultPrevented).toBe(true);
    confirmation.confirm.dispatch('click');
    await flush();

    expect(page.windowObject.fetch).toHaveBeenCalledTimes(1);
    expect(page.windowObject.fetch.mock.calls[0][0]).toBe('/projects/1/asset-categories/1/delete');
    expect(page.dialog.open).toBe(true);
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
describe('Project Assets multi-select defaults scope', () => {
  function selectedValues(select) {
    return Array.from(select.options || [])
      .filter((option) => option.selected)
      .map((option) => option.value);
  }

  function selectValues(select, values) {
    const selected = new Set(values);
    Array.from(select.options || []).forEach((option) => {
      option.selected = selected.has(option.value);
    });
    select.dispatch('change');
  }

  it('preserves complete Extension and Tag drafts independently for each scope', () => {
    const values = {
      global: { view: 'grid', gridSize: 'default', listSize: 'large', sort: 'filename', order: 'asc', pageSize: '25', extension: ['jpg', 'png'], tag: ['1', '2'] },
      project: { view: 'list', gridSize: 'large', listSize: 'compact', sort: 'category', order: 'desc', pageSize: '50', extension: ['png'], tag: ['2'] },
    };
    const page = makeDialogPage({ projectAssetsDefaults: true, projectAssetsScope: true, projectAssetsScopeValues: values });
    page.fields.extension.multiple = true;
    page.fields.tag.multiple = true;
    enhanceAppDialogs(page.document);
    enhanceProjectAssetsDefaultsScope(page.document);

    page.document.dispatch('click', { target: page.trigger });
    expect(selectedValues(page.fields.extension)).toEqual(['jpg', 'png']);
    expect(selectedValues(page.fields.tag)).toEqual(['1', '2']);

    selectValues(page.fields.extension, ['jpg']);
    selectValues(page.fields.tag, ['1']);
    changeProjectAssetsScope(page, 'project');
    expect(selectedValues(page.fields.extension)).toEqual(['png']);
    expect(selectedValues(page.fields.tag)).toEqual(['2']);

    selectValues(page.fields.extension, ['jpg', 'png']);
    selectValues(page.fields.tag, ['1', '2']);
    changeProjectAssetsScope(page, 'global');
    expect(selectedValues(page.fields.extension)).toEqual(['jpg']);
    expect(selectedValues(page.fields.tag)).toEqual(['1']);
    changeProjectAssetsScope(page, 'project');
    expect(selectedValues(page.fields.extension)).toEqual(['jpg', 'png']);
    expect(selectedValues(page.fields.tag)).toEqual(['1', '2']);
  });

  it('fails closed when a committed multi-select member is unavailable', () => {
    const values = {
      global: { view: 'grid', gridSize: 'default', listSize: 'large', sort: 'filename', order: 'asc', pageSize: '25', extension: ['jpg'], tag: 'all' },
      project: { view: 'list', gridSize: 'large', listSize: 'compact', sort: 'category', order: 'desc', pageSize: '50', extension: ['gif', 'png'], tag: ['2'] },
    };
    const page = makeDialogPage({ projectAssetsDefaults: true, projectAssetsScope: true, projectAssetsScopeValues: values });
    page.fields.extension.multiple = true;
    page.fields.tag.multiple = true;
    enhanceAppDialogs(page.document);
    enhanceProjectAssetsDefaultsScope(page.document);

    page.document.dispatch('click', { target: page.trigger });
    changeProjectAssetsScope(page, 'project');

    expect(selectedValues(page.fields.extension)).toEqual(['jpg']);
    expect(page.form.querySelector('[data-dialog-error-text]').textContent).toMatch(/could not be changed safely/i);
  });

  it('clears concrete Extension and Tag selections when restoring neutral all values', () => {
    const values = {
      global: { view: 'grid', gridSize: 'default', listSize: 'large', sort: 'filename', order: 'asc', pageSize: '25', extension: ['jpg', 'png'], tag: ['1', '2'] },
      project: { view: 'list', gridSize: 'large', listSize: 'compact', sort: 'category', order: 'desc', pageSize: '50', extension: 'all', tag: 'all' },
    };
    const page = makeDialogPage({ projectAssetsDefaults: true, projectAssetsScope: true, projectAssetsScopeValues: values });
    page.fields.extension.multiple = true;
    page.fields.tag.multiple = true;
    enhanceAppDialogs(page.document);
    enhanceProjectAssetsDefaultsScope(page.document);

    page.document.dispatch('click', { target: page.trigger });
    expect(selectedValues(page.fields.extension)).toEqual(['jpg', 'png']);
    expect(selectedValues(page.fields.tag)).toEqual(['1', '2']);

    changeProjectAssetsScope(page, 'project');
    expect(selectedValues(page.fields.extension)).toEqual([]);
    expect(selectedValues(page.fields.tag)).toEqual([]);
  });
});
